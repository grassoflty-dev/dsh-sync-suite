/**
 * 同步状态「上次已完成结果」持久化的纯逻辑（mod-sync-status-persist）。
 *
 * 为什么抽出来：`syncStatusStore.ets` 的三态原本只在 AppStorage（内存）里，重启后会
 * 回退成「失败：未知错误」。这里把「存什么 / 读回来怎么渲染」收敛成**零 SDK import**的
 * 纯函数，由 `tools/tsconfig.json` 编译到 `.build` 让 Node 单测直接跑；
 * `syncStatusStore.ets` 只保留薄壳：preferences 访问器 + AppStorage 镜像。
 *
 * 存储契约：专用 preferences `git_sync_status`，单键 `v:1.status`，
 * 值是一段只有三个标量字段的 JSON：`{"v":1,"kind":"synced|failed","at":"HH:MM","reason":"typed"}`。
 * - `syncing` **永不写盘**：进程被杀不能留下永久「同步中…」；
 * - 键名带 `v:1`、信封里再带 `v:1`：未来换格式能一眼检测，不做静默猜测；
 * - 读失败 / 坏 JSON / 坏版本 / 非 HH:MM 一律回落「没有已知结果」，绝不编造失败文案。
 *
 * **刻意临时方案**：mod-config-persistence（build 1000006）会把版本化配置的单一访问器
 * 收口；届时这里的 store 名 / 键名 / 信封要并进中央 accessor，别因为写了 v:1 就误以为
 * 本模块已被集中化豁免。
 */

/** 专用 preferences 名（只此一处定义，`.ets` 从这里导入）。 */
export const SYNC_STATUS_PREFS_NAME: string = 'git_sync_status';

/** 版本化键：换格式直接换键，老键留在盘上不读、不删。 */
export const SYNC_STATUS_KEY: string = 'v:1.status';

/** 信封版本（与键名里的 v:1 双写，便于检测篡改 / 未来迁移）。 */
export const SYNC_STATUS_VERSION: number = 1;

/** 实时三态文案（逐字固定，见 docs/STATE-UI.md；与 `.ets` 的同名常量保持一致）。 */
export const TEXT_SYNCED_PREFIX: string = '已同步 · ';
export const TEXT_SYNCING: string = '同步中…';
export const TEXT_FAILED_PREFIX: string = '失败：';
export const UNKNOWN_REASON: string = '未知错误';

/** 启动-only：上次失败是过去事件，不是当前失败态。 */
export const TEXT_PAST_FAILED_PREFIX: string = '上次失败 · ';

/** 启动-only：从未同步时的中性面（不编造失败、不冒充成功）。 */
export const TEXT_NEVER: string = '尚未同步';

/**
 * 三态 + 两个启动-only 中性标记。
 * `past_failed` / `never` **只由 `bootSurface()` 产出**，实时周期路径永远不产生它们。
 */
export type SyncStatusState = 'synced' | 'syncing' | 'failed' | 'past_failed' | 'never';

/** 落盘的唯一结果：成功 / 失败 + HH:MM 时刻 + typed 原因。 */
export interface PersistedOutcome {
  kind: 'synced' | 'failed';
  /** HH:MM（原样保留，重启后不重算成相对时间）。 */
  at: string;
  /** typed 失败原因；成功恒为空串。 */
  reason: string;
}

/** 交给页面 @State 的只读视图（与 `.ets` 的 SyncStatusView 同形）。 */
export interface StatusSurface {
  state: SyncStatusState;
  label: string;
  text: string;
  pending: number;
  reason: string;
  lastAt: string;
}

/** 存储适配器：`.ets` 里唯一的 preferences 访问器实现这个接口；测试用内存假件。 */
export interface StatusStorage {
  read(): string;
  write(value: string): void;
}

/** 一次读的结果：原始串（供去重）+ 解码后的结果（坏值 = null）。 */
export interface StatusRead {
  raw: string;
  outcome: PersistedOutcome | null;
}

/** 一次提交的结果：规范化后的 JSON + 是否真的写了盘。 */
export interface StatusCommit {
  json: string;
  wrote: boolean;
}

/** HH:MM 严格校验（24 小时制）。不合法就当没值，不猜、不补相对时间。 */
const HHMM_PATTERN: RegExp = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 只接受字符串，其它一律空串（脏数据不抛）。 */
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 规范化时刻：合法 HH:MM 原样返回，其余返回空串。 */
export function normalizeAt(value: unknown): string {
  const at: string = text(value);
  return HHMM_PATTERN.test(at) ? at : '';
}

/**
 * 编码成单键 JSON（固定键序，便于比较相等、避免无意义重写）。
 * 非法 outcome（未知 kind / 非法时刻）返回空串，由 `commitStatus()` 跳过写入。
 */
export function encodeStatus(outcome: PersistedOutcome | null | undefined): string {
  if (outcome === null || outcome === undefined) {
    return '';
  }
  const kind: string = text(outcome.kind);
  if (kind !== 'synced' && kind !== 'failed') {
    return '';
  }
  const at: string = normalizeAt(outcome.at);
  if (at.length === 0) {
    return '';
  }
  return JSON.stringify({
    v: SYNC_STATUS_VERSION,
    kind: kind,
    at: at,
    reason: kind === 'failed' ? text(outcome.reason) : ''
  });
}

/**
 * 解码永不抛：坏 JSON / 非对象 / 版本不符 / 未知 kind / 非 HH:MM → null。
 * 版本不符返回 null 而不是「尽力解析」，这样未来换格式不会被旧数据误解。
 */
export function decodeStatus(raw: string | null | undefined): PersistedOutcome | null {
  if (typeof raw !== 'string' || raw.length === 0) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const item: Record<string, unknown> = parsed as Record<string, unknown>;
    if (item['v'] !== SYNC_STATUS_VERSION) {
      return null;
    }
    const kind: string = text(item['kind']);
    if (kind !== 'synced' && kind !== 'failed') {
      return null;
    }
    const at: string = normalizeAt(item['at']);
    if (at.length === 0) {
      return null;
    }
    return { kind: kind, at: at, reason: kind === 'failed' ? text(item['reason']) : '' };
  } catch {
    return null;
  }
}

/** 读一次（**不写盘**）：存储抛异常也按「没有已知结果」处理。 */
export function readStatus(storage: StatusStorage | null | undefined): StatusRead {
  let raw: string = '';
  try {
    raw = storage === null || storage === undefined ? '' : storage.read();
  } catch {
    raw = '';
  }
  const safe: string = typeof raw === 'string' ? raw : '';
  return { raw: safe, outcome: decodeStatus(safe) };
}

/**
 * 仅真实变化才写：编码结果与 `lastWritten` 相同就跳过。
 * 存储抛异常吞掉（降级为内存行为），不把偏好设置的失败带进 UI。
 */
export function commitStatus(storage: StatusStorage | null | undefined,
                             outcome: PersistedOutcome,
                             lastWritten: string): StatusCommit {
  const json: string = encodeStatus(outcome);
  if (json.length === 0 || json === lastWritten) {
    return { json: json, wrote: false };
  }
  if (storage === null || storage === undefined) {
    return { json: json, wrote: false };
  }
  try {
    storage.write(json);
    return { json: json, wrote: true };
  } catch {
    return { json: json, wrote: false };
  }
}

/**
 * 启动渲染决策表（纯函数、零副作用）：
 * - 在途（同进程）→ `同步中…`（在途永远优先）；
 * - 上次成功 → `已同步 · <原 HH:MM>`，绝不重算成相对时间；
 * - 上次失败 → `上次失败 · <HH:MM>`（过去事件），typed reason 仍在 `reason` 字段里；
 * - 什么都没有 → `尚未同步` 中性面，state 用启动-only 的 `never`，不进三条实时路径。
 */
export function bootSurface(persisted: PersistedOutcome | null | undefined, syncing: boolean): StatusSurface {
  if (syncing) {
    return {
      state: 'syncing', label: '同步中', text: TEXT_SYNCING,
      pending: 0, reason: '', lastAt: ''
    };
  }
  const at: string = persisted === null || persisted === undefined ? '' : normalizeAt(persisted.at);
  if (persisted === null || persisted === undefined || at.length === 0) {
    return {
      state: 'never', label: '尚未同步', text: TEXT_NEVER,
      pending: 0, reason: '', lastAt: ''
    };
  }
  if (persisted.kind === 'synced') {
    return {
      state: 'synced', label: '已同步', text: `${TEXT_SYNCED_PREFIX}${at}`,
      pending: 0, reason: '', lastAt: at
    };
  }
  return {
    state: 'past_failed', label: '上次失败', text: `${TEXT_PAST_FAILED_PREFIX}${at}`,
    pending: 0, reason: text(persisted.reason), lastAt: at
  };
}
