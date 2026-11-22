/**
 * 静默同步触发的纯决策逻辑（mod-sync-silence-phase-b）。
 *
 * 只回答「这次事件要不要发起一次周期」，不 import SDK、不写盘、不实现第二份同步：
 * - 前台恢复：已配置 + 无在途周期 + 最近一次尝试距今 ≥ 5 分钟；
 * - 网络恢复：已配置 + 无在途周期 + transport 真的变了（同类型忽略）+ 非断开事件；
 *   debounce ~2 s 由 ETS 侧的定时器持有，本文件只做「要不要重新武装」的判定。
 *
 * 之所以抽成零 SDK 的纯函数：触发矩阵（五个名字各一次 / 突发合并 / 5 分钟内为零 /
 * 未配置为零）必须能用 spy 在 Node 里断言，而不是靠真机手感。
 */

/** 前台触发的最小尝试间隔（5 分钟）。 */
export const FOREGROUND_MIN_AGE_MS: number = 5 * 60 * 1000;

/** 网络恢复的 debounce 窗口（约 2 秒；由 ETS 侧定时器执行）。 */
export const NETWORK_DEBOUNCE_MS: number = 2000;

/** 未联网 / 未知的 transport 值不算「网络恢复」。 */
const NO_TRANSPORT: string[] = ['', 'none', 'unknown', 'unavailable'];

/** 前台恢复的输入（全部只读事实；`lastAttemptMs=null` 表示本进程还没跑过周期）。 */
export interface ForegroundTriggerInput {
  configured: boolean;
  inFlight: boolean;
  nowMs: number;
  lastAttemptMs: number | null;
}

/**
 * 前台恢复是否该跑一个周期。
 * 未配置 / 在途 / 时钟不可信一律零周期；距离上次尝试不足 5 分钟也是零周期——
 * 这一条同时保证「冷启动刚同步完就回到前台」不会立刻同步第二次。
 */
export function shouldRunForegroundTrigger(input: ForegroundTriggerInput): boolean {
  if (!input.configured || input.inFlight) {
    return false;
  }
  if (!Number.isFinite(input.nowMs)) {
    return false;
  }
  // 本进程还没跑过任何周期：冷启动那一次并没有真的同步，前台恢复应当补上。
  if (input.lastAttemptMs === null) {
    return true;
  }
  if (!Number.isFinite(input.lastAttemptMs)) {
    return false;
  }
  const age: number = input.nowMs - input.lastAttemptMs;
  return age >= FOREGROUND_MIN_AGE_MS;
}

/** 网络变化事件输入（只取 transport 字面量，不取地址 / 凭据）。 */
export interface NetworkTriggerInput {
  configured: boolean;
  inFlight: boolean;
  /** 本次事件的 transport（如 wifi / cellular / ethernet）；断开事件由调用方过滤。 */
  transport: string;
  /** 上一次已受理（或已发起周期）的 transport。 */
  lastTransport: string;
}

/**
 * 这次网络事件是否要（重新）武装 debounce 定时器。
 * 同类型事件、断开事件、未配置、在途周期都不武装；真正变化才武装，2 s 内的多次变化
 * 由 ETS 侧 clearTimeout + setTimeout 合并成一次周期。
 */
export function shouldArmNetworkDebounce(input: NetworkTriggerInput): boolean {
  if (!input.configured || input.inFlight) {
    return false;
  }
  const kind: string = input.transport.trim().toLowerCase();
  if (NO_TRANSPORT.indexOf(kind) >= 0) {
    return false;
  }
  return kind !== input.lastTransport.trim().toLowerCase();
}
