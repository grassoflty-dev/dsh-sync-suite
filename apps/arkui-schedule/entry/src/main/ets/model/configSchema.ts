/**
 * 配置 schema 版本 / 旧名读取 / 一次性重写 —— 纯逻辑（`mod-config-persistence`）。
 *
 * 零 SDK import、零 IO、零墙钟：Node 可直接单测；服务层 `services/configStore.ets` 只做偏好
 * IO 适配，所有判定与字节都在这里产生。
 *
 * 背景：`docs/PERSISTENCE.md` 风险 2（两个偏好 store 无配置 schema 版本）与风险 3
 * （store 改名后 `get(key, 默认)` 全量回落、静默丢配置）。参照 `docs/DATA-CONTRACT-v2.md` §11
 * 的「版本标记 + 未知版本只读门槛」先例与 `model/freshStart.ts` 的纯决策 + typed 结果写法：
 * 未知版本**绝不覆盖**、绝不抛到 UI。
 *
 * 信封约定：沿用仓库既有的 `{v:1,items}` / `{v:1,applied}` 数据信封（instanceStore /
 * remoteAnnounceStore）的键名 `v` 与起始版本 1，配置信封为 `{v:1,values:{...}}`。
 * 版本只住在信封里；旧的无版本 store 是一张扁平 `Record<string, ConfigValue>`。
 */

/** 配置信封版本：与既有数据信封 `{v:1}` 同键名、同起始号，未来新版本必须显式迁移。 */
export const CONFIG_SCHEMA_VERSION: number = 1;

/** store 内承载整表信封的保留键（旧扁平键不叫这个名字，便于一次判定）。 */
export const CONFIG_ENVELOPE_KEY: string = 'config.schema';

/** 偏好值类型：与 preferences 的标量值对齐；非标量在读取时 fail-closed。 */
export type ConfigValue = string | number | boolean;

/** 版本化配置信封：`{v:1,values:{...}}`，整串写入 = 一次原子替换。 */
export interface ConfigEnvelope {
  v: number;
  values: Record<string, ConfigValue>;
}

/** 一个候选源：名字可以是 store 名，也可以是 store 内的 key 名（当前名必须排第一）。 */
export interface ConfigCandidate {
  name: string;
  raw: string | null | undefined;
}

/** decode 的 typed 状态：ok=现行信封 / legacy=无版本旧表 / empty=空 / corrupt=坏字节 / version-unknown=未知版本。 */
export type ConfigState = 'ok' | 'legacy' | 'empty' | 'corrupt' | 'version-unknown';

/** decode 结果：失败时 values 恒为空表、version 仅在版本类状态给出、reason 为中文、绝不抛。 */
export interface ConfigDecode {
  state: ConfigState;
  version: number | null;
  values: Record<string, ConfigValue>;
  reason: string;
}

/** 解析用的宽松形状：运行时仍逐字段 typeof 校对，坏字节一律 typed 拒绝。 */
interface ParsedConfig {
  v?: number | null;
  values?: Record<string, ConfigValue> | null;
  [key: string]: ConfigValue | Record<string, ConfigValue> | undefined | null;
}

/** 旧名链结果：找到 / 全空 / 未知版本 / 坏字节 / 存储不可用，五种 typed 分支。 */
export type ConfigResolution =
  | { kind: 'found'; name: string; decode: ConfigDecode; tried: string[] }
  | { kind: 'missing'; tried: string[] }
  | { kind: 'version-unknown'; name: string; version: number; tried: string[] }
  | { kind: 'corrupt'; name: string; tried: string[] }
  | { kind: 'storage-unavailable'; name: string; tried: string[] };

/** 一次性重写决策：write=需要写 / no-write=无需写（幂等）/ refuse=已知字节不可覆盖。 */
export type RewriteDecision =
  | { kind: 'write'; target: string; bytes: string }
  | { kind: 'no-write'; reason: 'already-versioned' | 'missing' | 'legacy-empty'; name: string }
  | { kind: 'refuse'; reason: 'version-unknown' | 'corrupt' | 'storage-unavailable'; name: string; message: string };

/** 注入的存储缝：只读字节 + 只写一次；计数由调用方包一层即可观测。 */
export interface ConfigStorageSeam {
  read(name: string): string | null | undefined;
  write(name: string, bytes: string): void;
}

/** 一次运行的完整结果：解析、决策、是否真的写了（写入次数由 seam 的包裹者统计）。 */
export interface MigrationOutcome {
  resolution: ConfigResolution;
  decision: RewriteDecision;
  wrote: boolean;
}

/** 异步提交结果：wrote 只在 put / flush 都成功后才为真。 */
export interface AsyncCommitResult {
  decision: RewriteDecision;
  wrote: boolean;
}

/** 统一的失败构造：values 永远是空对象，不返回 null、不抛异常。 */
function decodeFail(state: ConfigState, version: number | null, reason: string): ConfigDecode {
  const result: ConfigDecode = { state: state, version: version, values: {}, reason: reason };
  return result;
}

/** 逐键校对标量：未知额外键**原样保留**；出现非标量（未来嵌套结构）则 fail-closed。 */
function readValues(src: Record<string, ConfigValue> | null): Record<string, ConfigValue> | null {
  if (src === null || typeof src !== 'object' || Array.isArray(src)) {
    return null;
  }
  const values: Record<string, ConfigValue> = {};
  const keys: string[] = Object.keys(src).sort();
  for (const key of keys) {
    const value: ConfigValue = src[key];
    if (typeof value === 'string' || typeof value === 'boolean') {
      values[key] = value;
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        return null;
      }
      values[key] = value;
    } else {
      return null;
    }
  }
  return values;
}

/**
 * 宽容读：现行信封只认 v === CONFIG_SCHEMA_VERSION；无数值 v 的扁平对象按 legacy 读；
 * 空 / 坏 JSON / 坏形状 / 未知版本各自 typed，**任何输入都不抛**。
 */
export function decodeEnvelope(raw: string | null | undefined): ConfigDecode {
  const text: string = typeof raw === 'string' ? raw.trim() : '';
  if (text.length === 0) {
    return decodeFail('empty', null, '空值：没有可读配置');
  }
  let parsed: ParsedConfig;
  try {
    parsed = JSON.parse(text) as ParsedConfig;
  } catch {
    return decodeFail('corrupt', null, '坏 JSON：配置字节不可解析');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return decodeFail('corrupt', null, '信封形状错误：顶层不是对象');
  }
  const hasVersion: boolean = Object.prototype.hasOwnProperty.call(parsed, 'v');
  const version: number | null | undefined = parsed.v;
  if (hasVersion && typeof version === 'number' && Number.isFinite(version)) {
    if (version !== CONFIG_SCHEMA_VERSION) {
      return decodeFail('version-unknown', version, `未知配置版本 ${version}：只读、不覆盖`);
    }
    const values: Record<string, ConfigValue> | null = readValues(parsed.values === undefined ? null : parsed.values);
    if (values === null) {
      return decodeFail('corrupt', version, '信封 values 非法：只接受标量键值');
    }
    const ok: ConfigDecode = { state: 'ok', version: version, values: values, reason: '' };
    return ok;
  }
  // 没有数值 v：整张扁平表视为旧格式；未知额外键在这里被完整保留。
  const legacy: Record<string, ConfigValue> | null = readValues(parsed as Record<string, ConfigValue>);
  if (legacy === null) {
    return decodeFail('corrupt', null, '旧配置含非标量值：只读、不覆盖');
  }
  const decoded: ConfigDecode = { state: 'legacy', version: null, values: legacy, reason: '' };
  return decoded;
}

/**
 * 显式写：固定键序 v → values（values 内按键排序），不写入任何额外顶层字段。
 * 调用方传入的 values 会被复制，不修改入参。
 */
export function encodeEnvelope(values: Record<string, ConfigValue>): string {
  const ordered: Record<string, ConfigValue> = {};
  const keys: string[] = Object.keys(values).sort();
  for (const key of keys) {
    ordered[key] = values[key];
  }
  const envelope: ConfigEnvelope = { v: CONFIG_SCHEMA_VERSION, values: ordered };
  return JSON.stringify(envelope);
}

/** 便捷版本查询：只有现行信封才返回版本号；legacy / 坏字节 / 未知版本返回 null。 */
export function schemaVersionOf(raw: string | null | undefined): number | null {
  const decoded: ConfigDecode = decodeEnvelope(raw);
  return decoded.state === 'ok' ? decoded.version : null;
}

/**
 * 旧名链解析：按候选顺序取**第一个有值**的源；空值继续向后找，
 * 但未知版本 / 坏字节立即 typed 拒绝（fail-closed：不跨过未知字节去覆盖）。
 */
export function resolveLegacyChain(candidates: ConfigCandidate[]): ConfigResolution {
  const tried: string[] = [];
  for (const candidate of candidates) {
    tried.push(candidate.name);
    const decoded: ConfigDecode = decodeEnvelope(candidate.raw);
    if (decoded.state === 'empty') {
      continue;
    }
    if (decoded.state === 'version-unknown') {
      const result: ConfigResolution = {
        kind: 'version-unknown',
        name: candidate.name,
        version: decoded.version === null ? -1 : decoded.version,
        tried: tried
      };
      return result;
    }
    if (decoded.state === 'corrupt') {
      const result: ConfigResolution = { kind: 'corrupt', name: candidate.name, tried: tried };
      return result;
    }
    // legacy 与 ok 都是「有值」：交给 migrateOnce 决定是否需要一次性重写。
    const found: ConfigResolution = { kind: 'found', name: candidate.name, decode: decoded, tried: tried };
    return found;
  }
  const missing: ConfigResolution = { kind: 'missing', tried: tried };
  return missing;
}

/** 旧名链的中文原因（供 UI 直接展示，不抛、不打印凭据）。 */
export function resolutionText(resolution: ConfigResolution): string {
  switch (resolution.kind) {
    case 'found':
      return resolution.decode.state === 'legacy' ? `旧配置命中：${resolution.name}` : `现行配置：${resolution.name}`;
    case 'missing':
      return '没有找到任何配置源';
    case 'version-unknown':
      return `未知配置版本 ${resolution.version}（${resolution.name}）：已保留原字节`;
    case 'corrupt':
      return `配置字节损坏（${resolution.name}）：已保留原字节`;
    case 'storage-unavailable':
      return `配置存储不可用（${resolution.name}）：未写入`;
  }
}

/**
 * 一次性重写决策（幂等）：第二次读到 `{v:1,values}` 时必为 no-write。
 * legacy 有值 → write（额外键随 values 逐字保留）；空 / 未知 / 坏字节 → 不写。
 */
export function migrateOnce(resolution: ConfigResolution, target: string): RewriteDecision {
  if (resolution.kind === 'missing') {
    const decision: RewriteDecision = { kind: 'no-write', reason: 'missing', name: '' };
    return decision;
  }
  if (resolution.kind === 'version-unknown') {
    const decision: RewriteDecision = {
      kind: 'refuse',
      reason: 'version-unknown',
      name: resolution.name,
      message: resolutionText(resolution)
    };
    return decision;
  }
  if (resolution.kind === 'corrupt') {
    const decision: RewriteDecision = {
      kind: 'refuse',
      reason: 'corrupt',
      name: resolution.name,
      message: resolutionText(resolution)
    };
    return decision;
  }
  if (resolution.kind === 'storage-unavailable') {
    const decision: RewriteDecision = {
      kind: 'refuse',
      reason: 'storage-unavailable',
      name: resolution.name,
      message: resolutionText(resolution)
    };
    return decision;
  }
  if (resolution.decode.state === 'ok') {
    const decision: RewriteDecision = { kind: 'no-write', reason: 'already-versioned', name: resolution.name };
    return decision;
  }
  if (Object.keys(resolution.decode.values).length === 0) {
    const decision: RewriteDecision = { kind: 'no-write', reason: 'legacy-empty', name: resolution.name };
    return decision;
  }
  const write: RewriteDecision = { kind: 'write', target: target, bytes: encodeEnvelope(resolution.decode.values) };
  return write;
}

/** `needsRewrite()` 的纯判定：与 migrateOnce 同一决策，绝不产生 IO。 */
export function needsRewrite(resolution: ConfigResolution, target: string): RewriteDecision {
  return migrateOnce(resolution, target);
}

/**
 * 通过注入的存储缝跑一次：读候选 → 解析 → 决策 → 至多一次写。
 * 读或写抛错都只落到 typed refuse（不写半截、不向 UI 抛异常）。
 */
export function runWithSeam(seam: ConfigStorageSeam, names: string[], target: string): MigrationOutcome {
  const tried: string[] = [];
  const candidates: ConfigCandidate[] = [];
  for (const name of names) {
    let raw: string | null | undefined;
    try {
      raw = seam.read(name);
    } catch {
      const resolution: ConfigResolution = { kind: 'storage-unavailable', name: name, tried: tried };
      return { resolution: resolution, decision: migrateOnce(resolution, target), wrote: false };
    }
    tried.push(name);
    candidates.push({ name: name, raw: raw });
  }
  const resolution: ConfigResolution = resolveLegacyChain(candidates);
  const decision: RewriteDecision = migrateOnce(resolution, target);
  if (decision.kind !== 'write') {
    return { resolution: resolution, decision: decision, wrote: false };
  }
  try {
    seam.write(target, decision.bytes);
  } catch {
    const refused: RewriteDecision = {
      kind: 'refuse',
      reason: 'storage-unavailable',
      name: target,
      message: '配置写入失败：已保留原字节'
    };
    return { resolution: resolution, decision: refused, wrote: false };
  }
  return { resolution: resolution, decision: decision, wrote: true };
}

/**
 * 异步提交守卫（适配层 put / flush 的 rejection 在这里闭环）。
 *
 * `write()` 只在 envelope put 成功之后才 flush，因此 put 拒绝时不会把半截状态刷盘；
 * 任一步拒绝都尽力调 `restore()` 把保留键恢复成重写前的空值（旧扁平键从未被触碰），
 * 再返回 typed `storage-unavailable` + `wrote=false`，绝不把 Promise rejection 抛给 UI。
 * 回滚本身也失败时同样吞掉：结果仍是 typed refuse，异常不扩散。
 */
export async function commitConfigWrite(
  decision: RewriteDecision,
  write: () => Promise<void>,
  restore: () => Promise<void>
): Promise<AsyncCommitResult> {
  if (decision.kind !== 'write') {
    const noop: AsyncCommitResult = { decision: decision, wrote: false };
    return noop;
  }
  try {
    await write();
  } catch {
    try {
      await restore();
    } catch {
      // 回滚也失败：不放大异常，仍按 typed refuse 返回；偏好自身的失败语义兜底原字节。
    }
    const refused: RewriteDecision = {
      kind: 'refuse',
      reason: 'storage-unavailable',
      name: decision.target,
      message: '配置写入失败：已保留原字节'
    };
    const failed: AsyncCommitResult = { decision: refused, wrote: false };
    return failed;
  }
  const committed: AsyncCommitResult = { decision: decision, wrote: true };
  return committed;
}
