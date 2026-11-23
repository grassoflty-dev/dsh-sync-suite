/**
 * 远程打开的一次性结果标记（mod-pairing-badge-truth，纯 TypeScript，零 SDK import）。
 *
 * 由 `tools/tsconfig.json` 编译成 `.build/model/remoteOutcome.js`，可在 Node 直接测
 * （与 `model/homeRefresh.ts` 同一约定）。本文件只做数据形状与判定，不碰任何 UI / 存储 API。
 *
 * 为什么要有它（修 review m2）：配对成功时「地址可达」徽章会落进实例表；但监听器随后停了、
 * 或远程页因任何原因没建立起来时，行上的徽章会一直挂着这个乐观结论。根因是原先只有
 * `router.pushUrl()` 成功才写 `ok`，而真正的连接结论只在 `RemoteControl` 的错误卡里，
 * 没有任何路径回写实例表。现在把「远程页的终局」做成一次性 AppStorage 标记：
 * `RemoteControl` 在每次打开尝试的终局写一次；保活的 `InstancesPane` 用
 * `@StorageLink + @Watch` 消费它（保活组件拿不到自己的 `onPageShow`），
 * 解码 → 判定 → `markReachable(id, status)` → 刷新行 → 恰好清一次标记。
 *
 * 语义边界：
 * - 被拒绝 / 未建立起来的通道**不是可达性**。没有 pin、不是 https、永久拒绝、
 *   TLS 指纹不匹配、证书链无法校验、Web 加载失败——这些都是「没能连上」，一律 `'fail'`。
 * - `'ok'` 只在页面**真正加载完成**（`onPageEnd`）时产生；导航成功、按钮点到了、
 *   字符串拼好了都不算。今天的常规构建里 Web 不挂载，`onPageEnd` 实际上不可达，
 *   所以 `'ok'` 的映射只为未来的原生客户端保留并接受测试，不作为现状证据。
 * - 任何坏信封 / 异 id / 过期标记都 fail-closed 成 no-op（decode → `null`）。
 */

/** 一次性远程结果标记的 AppStorage 键（与 `home.lastSaved` 同一模式）。 */
export const REMOTE_OUTCOME_KEY: string = 'remote.lastOutcome';

/** 单次标记文本的长度上限，超过按脏数据拒绝。 */
const MAX_RAW_LENGTH: number = 2048;

/** 标记版本：未知版本一律拒绝（fail-closed）。 */
const OUTCOME_VERSION: number = 1;

/** 默认新鲜窗口 ≤ 120 s；更旧的标记视为陈旧，不再改动徽章。 */
const DEFAULT_MAX_AGE_MS: number = 120_000;

/** 合法实例 id，口径与 `model/instances.ts` 的 `INSTANCE_ID_PATTERN` 完全一致。 */
const INSTANCE_ID_PATTERN: RegExp = /^inst-[0-9a-f]{16}$/;

/** 可达结论：只有 `ok` / `fail` 两种；`unknown` 由「没标记」表达。 */
export type RemoteOutcomeStatus = 'ok' | 'fail';

/** 远程打开终局的种类：全部映射为 `'fail'`（详见文件头语义边界）。 */
export type RemoteRefusalKind =
  | 'no-pin'
  | 'not-https'
  | 'permanent-refusal'
  | 'tls-mismatch'
  | 'chain-unverifiable'
  | 'web-load-error';

/** 一次性标记的数据形状（固定四字段，便于 diff / 排障）。 */
export interface RemoteOutcome {
  v: number;
  instanceId: string;
  status: RemoteOutcomeStatus;
  at: number;
}

/** 反序列化中间形态：所有字段都可能缺失 / 类型不对（外部数据不可信）。 */
interface RawRemoteOutcome {
  v?: number;
  instanceId?: string;
  status?: string;
  at?: number;
}

/** 序列化：固定键顺序；版本恒定，非法值就地兜底，绝不产出 decode 不回来的信封。 */
export function encodeRemoteOutcome(outcome: RemoteOutcome): string {
  const safe: RemoteOutcome = {
    v: OUTCOME_VERSION,
    instanceId: typeof outcome.instanceId === 'string' ? outcome.instanceId : '',
    status: outcome.status === 'ok' ? 'ok' : 'fail',
    at: typeof outcome.at === 'number' && Number.isFinite(outcome.at) ? outcome.at : 0
  };
  return JSON.stringify(safe);
}

/**
 * 严格解析。返回 `null` 的情况（一律不抛，调用方按 no-op 处理）：
 * - `null` / `undefined` / 空串 / 纯空白 / 超过 `MAX_RAW_LENGTH`；
 * - 坏 JSON、非对象、数组；
 * - `v` 非 `OUTCOME_VERSION`、`instanceId` 不匹配 `inst-<16hex>`、
 *   `status` 非 `ok|fail`、`at` 非有限数或负数。
 */
export function decodeRemoteOutcome(raw: string | null | undefined): RemoteOutcome | null {
  const text: string = typeof raw === 'string' ? raw.trim() : '';
  if (text.length === 0 || text.length > MAX_RAW_LENGTH) {
    return null;
  }
  let parsed: RawRemoteOutcome | null = null;
  try {
    parsed = JSON.parse(text) as RawRemoteOutcome;
  } catch {
    return null;
  }
  if (parsed === null || parsed === undefined || typeof parsed !== 'object') {
    return null;
  }
  if (Array.isArray(parsed)) {
    return null;
  }
  const rawV: number | undefined = parsed.v;
  const rawId: string | undefined = parsed.instanceId;
  const rawStatus: string | undefined = parsed.status;
  const rawAt: number | undefined = parsed.at;
  if (rawV !== OUTCOME_VERSION) {
    return null;
  }
  if (typeof rawId !== 'string' || !INSTANCE_ID_PATTERN.test(rawId)) {
    return null;
  }
  if (rawStatus !== 'ok' && rawStatus !== 'fail') {
    return null;
  }
  if (typeof rawAt !== 'number' || !Number.isFinite(rawAt) || rawAt < 0) {
    return null;
  }
  const outcome: RemoteOutcome = {
    v: OUTCOME_VERSION,
    instanceId: rawId,
    status: rawStatus,
    at: rawAt
  };
  return outcome;
}

/**
 * 拒绝种类 → 可达结论。被拒绝 / 未建立起来的通道不是可达性：
 * 六种终局（含 Web 加载失败）全部落到 `'fail'`，未知种类也 fail-closed 到 `'fail'`。
 * `'ok'` **不在这里产生**——只有页面真正加载完成的 `onPageEnd` 才能给 `ok`。
 */
export function refusalStatusOf(kind: RemoteRefusalKind): RemoteOutcomeStatus {
  switch (kind) {
    case 'no-pin':
    case 'not-https':
    case 'permanent-refusal':
    case 'tls-mismatch':
    case 'chain-unverifiable':
    case 'web-load-error':
      return 'fail';
    default:
      return 'fail';
  }
}

/** 拒绝终局的一次性标记（六种 kind 都是 `'fail'`）。 */
export function outcomeForRefusal(
  kind: RemoteRefusalKind,
  instanceId: string,
  nowMs: number
): RemoteOutcome {
  const outcome: RemoteOutcome = {
    v: OUTCOME_VERSION,
    instanceId: instanceId,
    status: refusalStatusOf(kind),
    at: nowMs
  };
  return outcome;
}

/** 真正加载成功的一次性标记（只有 `onPageEnd` 才能调用）。 */
export function outcomeForLoadSuccess(instanceId: string, nowMs: number): RemoteOutcome {
  const outcome: RemoteOutcome = {
    v: OUTCOME_VERSION,
    instanceId: instanceId,
    status: 'ok',
    at: nowMs
  };
  return outcome;
}

/**
 * 消费者是否应当应用这条标记（纯函数，可重复调用 = 幂等）。
 *
 * - `null` / 坏形状 / 异 id / 非有限时间 ⇒ `false`；
 * - 标记时间晚于 `nowMs`（时钟回拨）或早于 `nowMs - maxAgeMs`（陈旧）⇒ `false`；
 * - `maxAgeMs` 省略 / 非法 / 大于 120 s 时都夹到 `DEFAULT_MAX_AGE_MS`；
 * - 真正的一次性由消费者「应用后恰好清一次标记」保证，本函数只负责判定。
 */
export function shouldApplyOutcome(
  outcome: RemoteOutcome | null,
  expectedInstanceId: string,
  nowMs: number,
  maxAgeMs?: number
): boolean {
  if (outcome === null || outcome === undefined) {
    return false;
  }
  if (outcome.v !== OUTCOME_VERSION) {
    return false;
  }
  if (typeof outcome.instanceId !== 'string' || !INSTANCE_ID_PATTERN.test(outcome.instanceId)) {
    return false;
  }
  if (outcome.instanceId !== expectedInstanceId) {
    return false;
  }
  if (outcome.status !== 'ok' && outcome.status !== 'fail') {
    return false;
  }
  if (typeof outcome.at !== 'number' || !Number.isFinite(outcome.at) || outcome.at < 0) {
    return false;
  }
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
    return false;
  }
  const windowMs: number =
    typeof maxAgeMs === 'number' && Number.isFinite(maxAgeMs) && maxAgeMs >= 0
      ? Math.min(maxAgeMs, DEFAULT_MAX_AGE_MS)
      : DEFAULT_MAX_AGE_MS;
  const ageMs: number = nowMs - outcome.at;
  if (ageMs < 0 || ageMs > windowMs) {
    return false;
  }
  return true;
}
