/**
 * 桥就绪 + 行状态 + 「读不到 ≠ 空」的唯一决策层（模块 `mod-app-git-bridge-ready`）。
 *
 * 为什么要有这一层：2026-11-26 19:18 的真机冷启动里同时出现两个症状——设置页「同步仓库」
 * 永久停在「读取中…」，同一次启动把两个已存在的远程实例显示成「0 个实例」。两者的根因形状
 * 是同一个：**读取没有有界结论**。`.ets` 的 catch 里什么都不写，行就永远停在初始占位；
 * 而桥就绪此前只靠「定时器轮询 + `onPageEnd` 置位」，`onPageEnd` 早于代理可调用
 * （真机日志里的 `FindObject Unknown object: objectId = 10737418` 正是「页面已在调一个还没
 * 注册的代理对象」），于是第一次调用打在未注册的代理上：要么超时、要么石沉大海。
 *
 * 本文件全是纯函数：不碰 SDK、不联网、不打日志、不持有状态。`.ets` 只做薄适配
 * （读 → 调 → 上屏），所有判定都在这里，Node 单测逐条钉住。
 */

/** 就绪等待超时的 typed 码（10 秒没收到就绪信号）。 */
export const E_BRIDGE_NOT_READY: string = 'E_BRIDGE_NOT_READY';

/** 单次桥调用超时的 typed 码（调用本身有界，绝不无限挂着）。 */
export const E_BRIDGE_CALL_TIMEOUT: string = 'E_BRIDGE_CALL_TIMEOUT';

/** 设置页摘要读取失败的 typed 码（读盘 / 读取预算超时）。 */
export const E_SETTINGS_READ_FAILED: string = 'E_SETTINGS_READ_FAILED';

/** 实例表读取失败的 typed 码（「读不到」专用，绝不与「0 个实例」混为一谈）。 */
export const E_INSTANCES_READ_FAILED: string = 'E_INSTANCES_READ_FAILED';

/** 唯一「正在读」文案：只在真的在飞时出现，任何失败 / 成功都必须离开它。 */
export const LOADING_TEXT: string = '读取中…';

/** 失败行统一的下一步（可点本行重试，不需要重启应用）。 */
export const RETRY_HINT: string = '轻点本行重试';

/** 实例表**确实读成功且确实为空**时才允许出现的文案。 */
export const EMPTY_INSTANCES_TEXT: string = '0 个实例';

/** 毫秒 → 「N 秒」（预算文案专用；非整数向上取整到秒，避免出现 0.3 秒这种说法）。 */
export function secondsOf(budgetMs: number): string {
  const value: number = typeof budgetMs === 'number' && budgetMs > 0 ? budgetMs : 0;
  const seconds: number = Math.ceil(value / 1000);
  return seconds > 0 ? `${seconds}` : '0';
}

/** 就绪信号超时的中文一句话（含下一步）。 */
export function bridgeNotReadyText(budgetMs: number): string {
  return `同步内核在 ${secondsOf(budgetMs)} 秒内没有发出就绪信号（Web 页面可能还没加载完）；`
    + `轻点「重试」再试一次，不需要重启应用`;
}

/** 单次桥调用超时的中文一句话（含下一步）。 */
export function bridgeCallTimeoutText(budgetMs: number): string {
  return `同步内核在 ${secondsOf(budgetMs)} 秒内没有回应（Web 页面可能卡住）；`
    + `轻点「重试」，仍失败请离开本页再进来`;
}

/** 摘要读取失败的中文一句话（含下一步）。 */
export function readFailedText(): string {
  return `这次没读到本机设置（读取超时或存储暂时不可用）；${RETRY_HINT}`;
}

// ---------------------------------------------------------------------------
// A. 桥就绪状态机：信号（不是 onPageEnd、不是定时器）是唯一权威
// ---------------------------------------------------------------------------

/**
 * 就绪阶段。
 *
 * - `idle`：还没武装过握手（没有令牌）；
 * - `waiting`：已武装，正在等页面把「代理真的调得通」这句话回传；
 * - `ready`：收到**当前令牌 + 刷新时代之后加载的页面**发来的信号；
 * - `failed`：有界等待超时（typed 码 + 中文一句话，可重试）。
 */
export type BridgePhase = 'idle' | 'waiting' | 'ready' | 'failed';

/**
 * 页面回传的就绪信号。
 *
 * `pageAtMs` 是**页面脚本加载的时刻**（不是回传时刻）：刷新会把旧页面换掉，只有「在本次
 * 握手之后才加载的页面」才有资格把桥标成就绪。
 */
export interface BridgeSignal {
  /** 宿主当前握手令牌；页面还不知道时回传空串（宿主据此把令牌递回去）。 */
  token: string;
  /** 页面身份（每次加载随机生成，只用于幂等判定）。 */
  pageId: string;
  /** 页面脚本加载时刻（毫秒）。 */
  pageAtMs: number;
}

/** 就绪快照（不可变；每次事件返回新对象，`.ets` 直接整体替换）。 */
export interface BridgeReadiness {
  phase: BridgePhase;
  /** 当前握手令牌；空串 = 从未武装。 */
  token: string;
  /** 本次武装时刻。 */
  armedAtMs: number;
  /**
   * 页面加载时刻的门槛：`pageAtMs < barrierMs` 的页面一律视为「刷新前的旧页面」，信号不算数。
   *
   * 这就是「刷新后不可能残留 stale ready」的实现：`registerProxy()` 一定会 `refresh()`，
   * 所以它会用**当次武装时刻**当门槛；旧页面即便抢在销毁前把信号发出来也会被拒。
   * 不刷新的重复武装（同一页面的幂等调用）沿用它，否则同一页面的信号会被自己误判成旧的。
   */
  barrierMs: number;
  /** 已接受信号所属页面（幂等：同一页面重复回传仍然算就绪）。 */
  pageId: string;
  /** 失败时的 typed 码（`phase === 'failed'` 才有意义）。 */
  code: string;
}

/** 初始（未武装）快照。 */
export function readinessIdle(): BridgeReadiness {
  return { phase: 'idle', token: '', armedAtMs: 0, barrierMs: 0, pageId: '', code: '' };
}

/**
 * 武装一次握手。
 *
 * @param previous  上一份快照
 * @param token     新令牌（空串 = 拒绝武装：空令牌区分不了新旧页面，宁可不武装）
 * @param nowMs     武装时刻
 * @param freshPage 本次武装之后是否一定会 `refresh()`（= 换新页面）。true 时把门槛抬到
 *                  `nowMs`，刷新前加载的旧页面就再也无法把桥标成就绪。
 */
export function readinessArm(previous: BridgeReadiness,
                             token: string,
                             nowMs: number,
                             freshPage: boolean): BridgeReadiness {
  const next: string = typeof token === 'string' ? token.trim() : '';
  if (next.length === 0) {
    return previous;
  }
  const barrier: number = freshPage ? nowMs : previous.barrierMs;
  return {
    phase: 'waiting',
    token: next,
    armedAtMs: nowMs,
    barrierMs: barrier,
    pageId: '',
    code: ''
  };
}

/** 信号是否属于「刷新前的旧页面 / 上一代令牌」（是则应拒绝，且把当前令牌递回给页面）。 */
export function readinessIsStale(previous: BridgeReadiness, signal: BridgeSignal): boolean {
  const token: string = signal.token;
  if (token.length === 0) {
    return false;
  }
  if (token !== previous.token) {
    return true;
  }
  return signal.pageAtMs < previous.barrierMs;
}

/**
 * 接受一次就绪信号。
 *
 * 三个条件缺一不可：令牌一致、页面在门槛之后加载、页面身份不是更早的另一页。
 * 已经是 `ready` 且同一页面重复回传 → 原样返回（幂等，不产生第二次「就绪」事件）。
 */
export function readinessAccept(previous: BridgeReadiness, signal: BridgeSignal): BridgeReadiness {
  if (previous.token.length === 0) {
    return previous;
  }
  if (signal.token !== previous.token) {
    return previous;
  }
  if (signal.pageAtMs < previous.barrierMs) {
    return previous;
  }
  if (previous.phase === 'ready' && previous.pageId === signal.pageId) {
    return previous;
  }
  return {
    phase: 'ready',
    token: previous.token,
    armedAtMs: previous.armedAtMs,
    barrierMs: previous.barrierMs,
    pageId: signal.pageId,
    code: ''
  };
}

/** 有界等待到期：`waiting` 且已超预算 → `failed` + typed 码；否则原样返回。 */
export function readinessExpired(previous: BridgeReadiness,
                                 nowMs: number,
                                 budgetMs: number): BridgeReadiness {
  if (previous.phase !== 'waiting') {
    return previous;
  }
  const budget: number = typeof budgetMs === 'number' && budgetMs > 0 ? budgetMs : 0;
  if (nowMs - previous.armedAtMs < budget) {
    return previous;
  }
  return {
    phase: 'failed',
    token: previous.token,
    armedAtMs: previous.armedAtMs,
    barrierMs: previous.barrierMs,
    pageId: previous.pageId,
    code: E_BRIDGE_NOT_READY
  };
}

/** 直接置失败（页面加载失败 / 注册代理抛错：这不是超时，但同样必须可重试）。 */
export function readinessFail(previous: BridgeReadiness, code: string): BridgeReadiness {
  return {
    phase: 'failed',
    token: previous.token,
    armedAtMs: previous.armedAtMs,
    barrierMs: previous.barrierMs,
    pageId: previous.pageId,
    code: code.length > 0 ? code : E_BRIDGE_NOT_READY
  };
}

/** 是否已收到就绪信号（`ready` 之外一律 false；`waiting` 不算就绪）。 */
export function readinessReady(previous: BridgeReadiness): boolean {
  return previous.phase === 'ready';
}

/** 失败时的上屏文案（`ready` / `waiting` 返回空串：由调用方决定显示值还是「读取中…」）。 */
export function readinessText(previous: BridgeReadiness, budgetMs: number): string {
  if (previous.phase !== 'failed') {
    return '';
  }
  const code: string = previous.code.length > 0 ? previous.code : E_BRIDGE_NOT_READY;
  const sentence: string = code === E_BRIDGE_CALL_TIMEOUT
    ? bridgeCallTimeoutText(budgetMs)
    : bridgeNotReadyText(budgetMs);
  return `${code}：${sentence}`;
}

// ---------------------------------------------------------------------------
// B. 摘要行状态：loading 只在真的在飞时出现，结束只有「值」或「失败」两种
// ---------------------------------------------------------------------------

/** 行阶段：`loading` 必须有出口。 */
export type RowPhase = 'loading' | 'value' | 'failed';

/** 一行摘要的渲染态（`.ets` 只读 `text` / `canRetry`）。 */
export interface RowView {
  phase: RowPhase;
  /** 直接上屏的一整行文案。 */
  text: string;
  /** 本行是否可点（失败态 = 轻点重试）。 */
  canRetry: boolean;
  /** 失败时的 typed 码（值态 / 加载态为空串）。 */
  code: string;
}

/** 在飞态（唯一允许出现「读取中…」的态）。 */
export function rowLoading(): RowView {
  return { phase: 'loading', text: LOADING_TEXT, canRetry: false, code: '' };
}

/** 值态：`note` 非空时以 ` · ` 追加（用于「内核未就绪」这类附注，不改主文案）。 */
export function rowValue(text: string, note: string): RowView {
  const main: string = typeof text === 'string' ? text.trim() : '';
  return { phase: 'value', text: appendNote(main.length > 0 ? main : '—', note), canRetry: false, code: '' };
}

/** 失败态：`读不到：<原因>（<typed 码>）· 轻点本行重试`，绝不退化成空值。 */
export function rowFailed(code: string, reason: string, note: string): RowView {
  const typed: string = typeof code === 'string' && code.length > 0 ? code : E_SETTINGS_READ_FAILED;
  const detail: string = typeof reason === 'string' ? reason.trim() : '';
  const body: string = detail.length > 0 ? detail : readFailedText();
  return {
    phase: 'failed',
    text: appendNote(`读不到：${body}（${typed}）· ${RETRY_HINT}`, note),
    canRetry: true,
    code: typed
  };
}

/** 附注拼接（空附注不加尾巴；两处都用同一个拼法，避免同一行出现两种分隔符）。 */
function appendNote(text: string, note: string): string {
  const tail: string = typeof note === 'string' ? note.trim() : '';
  return tail.length > 0 ? `${text} · ${tail}` : text;
}

// ---------------------------------------------------------------------------
// C. 实例表：「读不到」与「空」是两件事
// ---------------------------------------------------------------------------

/**
 * 一次实例表读取的结论。
 *
 * `problem` 是 `model/instances.ts` 的 `InstanceProblem`；其中 `E_ENVELOPE_EMPTY`
 * 表示「确实还没有保存过实例」——那是**读成功且为空**，不是读失败。
 */
export interface InstancesRead {
  /** 是否读到了一份可信的实例表（坏信封 / 存储不可用 = false）。 */
  ok: boolean;
  /** 条数（`ok === false` 时无意义）。 */
  count: number;
  /** 原始 typed 问题码（`ok` 问题码或坏值码）。 */
  problem: string;
  /** 中文原因（来自 `problemText()`；空串时由本层给兜底句）。 */
  reason: string;
}

/** 只有这两个问题码代表「读成功」：`ok`，以及「确实还没有实例」。 */
const READ_OK: string = 'ok';
const READ_EMPTY: string = 'E_ENVELOPE_EMPTY';

/** 把 store 的（条数, 问题码, 中文原因）判成「读到了」还是「读不到」。 */
export function instancesReadOf(count: number, problem: string, reason: string): InstancesRead {
  const code: string = typeof problem === 'string' ? problem.trim() : '';
  const ok: boolean = code === READ_OK || code === READ_EMPTY;
  const size: number = typeof count === 'number' && count > 0 ? Math.floor(count) : 0;
  return {
    ok: ok,
    count: size,
    problem: code.length > 0 ? code : 'E_STORAGE_UNAVAILABLE',
    reason: typeof reason === 'string' ? reason.trim() : ''
  };
}

/** 设置页「远程实例」行：读不到就说读不到（带原因 + 重试），读到才报条数。 */
export function instancesRow(read: InstancesRead, note: string): RowView {
  if (read.ok) {
    return rowValue(read.count === 0 ? EMPTY_INSTANCES_TEXT : `${read.count} 个实例`, note);
  }
  const reason: string = read.reason.length > 0 ? read.reason : '本地实例表读不出来';
  return rowFailed(E_INSTANCES_READ_FAILED, reason, note);
}

/** 实例面板顶部的计数行：读失败时给「读不到」，绝不写「共 0 个实例」。 */
export function instancesCountLine(read: InstancesRead): string {
  if (read.ok) {
    return `共 ${read.count} 个实例`;
  }
  const reason: string = read.reason.length > 0 ? read.reason : '本地实例表读不出来';
  return `读不到实例表：${reason}（${E_INSTANCES_READ_FAILED}）`;
}

/** 空态（「还没有实例」）只在**读成功且确实为 0** 时才允许渲染。 */
export function instancesMayShowEmpty(read: InstancesRead): boolean {
  return read.ok && read.count === 0;
}
