/**
 * 同步前置守卫（纯逻辑，可在 Node 里单测）。
 *
 * 背景：真机出现过「设置页点『立即同步』直接闪退」。闪退的根因是**同步入口没有统一守卫**：
 * 桥未就绪 / 仓库地址为空时仍然往下走，最终在 bridge（WebView）调用处抛出未捕获异常，
 * 抛到 UI 线程把进程带走。这里把所有「能不能开始同步」的判断收敛成一个纯函数，
 * 让 `GitSyncService` / `syncController` / 页面三处用同一套结论，并且**永不抛异常**。
 *
 * 约定：
 * - 返回 `{ ok: false, code, message }`，`message` 是可直接展示的中文；
 * - `code` 与 `model/syncError.ts` 的分类码保持一致（`E_CONFIG` / `E_BRIDGE` / `E_BUSY`）；
 * - 只有全部通过才 `ok: true`。
 */

/** 守卫需要的输入（全部显式，避免读全局状态）。 */
export interface SyncPreconditionInput {
  /** 仓库地址（用户填的原始值）。 */
  repoUrl: string;
  /** HTTPS token（空 token 也能拉公共仓库，但私有仓库会认证失败；这里只拦「地址为空」）。 */
  token: string;
  /** 同步桥（WebView 里的 isomorphic-git + jszip）是否就绪。 */
  bridgeReady: boolean;
  /** 当前是否已有同步动作在跑（防连点）。 */
  busy?: boolean;
}

/** 守卫结论。 */
export interface SyncPreconditionResult {
  ok: boolean;
  /** 错误码（`E_CONFIG` / `E_BRIDGE` / `E_BUSY`）；`ok: true` 时为空串。 */
  code: string;
  /** 可直接展示的中文说明；`ok: true` 时为空串。 */
  message: string;
}

/** 桥未就绪时统一文案（设置页与首页共用）。 */
export const BRIDGE_NOT_READY_MESSAGE: string = '请先保存仓库地址并等待同步内核就绪';

/** 仓库地址为空时统一文案。 */
export const REPO_EMPTY_MESSAGE: string = '请先填写并保存仓库地址（只在本机记录日程可以留空）';

/** 同步进行中时统一文案。 */
export const SYNC_BUSY_MESSAGE: string = '同步正在进行中，请稍候';

/** 忙拒绝的错误码（与 `model/syncError.ts` 的分类口径一致；页面据此区分「等一等」与「配置问题」）。 */
export const SYNC_BUSY_CODE: string = 'E_BUSY';

function normalize(value: string): string {
  const text: string = typeof value === 'string' ? value.trim() : '';
  return text;
}

/**
 * 判断能否开始一次同步。
 *
 * 顺序刻意如此：**先看忙不忙**（连点），再看桥就绪（最容易被忽略、也是闪退根因），
 * 最后看仓库地址（用户可读、可修）。这样「桥没好」时不会先报「地址为空」误导用户。
 */
export function checkSyncPrecondition(input: SyncPreconditionInput): SyncPreconditionResult {
  if (input !== undefined && input !== null && input.busy === true) {
    return { ok: false, code: SYNC_BUSY_CODE, message: SYNC_BUSY_MESSAGE };
  }
  if (input === undefined || input === null || input.bridgeReady !== true) {
    return { ok: false, code: 'E_BRIDGE', message: BRIDGE_NOT_READY_MESSAGE };
  }
  if (normalize(input.repoUrl).length === 0) {
    return { ok: false, code: 'E_CONFIG', message: REPO_EMPTY_MESSAGE };
  }
  return { ok: true, code: '', message: '' };
}

/**
 * 把「桥调用抛出来的东西」归一成一段中文说明（**不抛**）。
 *
 * WebView 侧异常可能来自：页面未加载完（`E_BRIDGE`）、控制器未绑定、超时、
 * isomorphic-git 内部错误。这里只做展示层归一，具体分级交给 `model/syncError.ts`。
 */
export function describeBridgeFailure(error: Object | undefined | null): string {
  if (error === undefined || error === null) {
    return '同步内核无响应';
  }
  const message: string = (error as Error).message === undefined ? '' : String((error as Error).message);
  const trimmed: string = message.trim();
  return trimmed.length === 0 ? '同步内核无响应' : trimmed;
}

// ---------------------------------------------------------------- 重入闸（C 批稳定性加固）

/**
 * 为什么需要这一节：`precondition(busy)` 的四个调用点历史上全传 `false`，忙判定根本走不到；
 * 于是「App 启动 pull」「回前台 pull」「设置页点立即同步」三条路径可以同时在**同一个工作副本**
 * 上跑，两个结果互相覆盖（后完成的那个把先完成的 message / deviceId 覆盖掉）。
 *
 * 这里把「能不能开始」收敛成纯函数，`GitSyncService` 只做两件事：入口抢闸、`finally` 放闸。
 * 纯函数的好处：不依赖 `@kit.*`，可以在 Node 里直接跑并发行为测试（`tools/test/syncReentry.test.mjs`）。
 */

/** 动作名：拉取（写本机工作副本 + 可能 clone）。 */
export const SYNC_ACTION_PULL: string = 'pull';
/** 动作名：推送（写远端分支 + 本机工作副本；附件 zip 还会被临时挪走/放回）。 */
export const SYNC_ACTION_PUSH: string = 'push';
/** 动作名：设备编号登记（写 `devices/registry.jsonl` + 本机指纹文件，内部会真拉/真提交）。 */
export const SYNC_ACTION_REGISTER: string = 'register';
/** 动作名：查看状态（**只读**，不参与忙判定）。 */
export const SYNC_ACTION_STATUS: string = 'status';

/**
 * 「当前正在跑的动作」——**可变**状态（由 `GitSyncService` 实例持有一份）。
 *
 * 为什么是可变的：抢闸要在**第一个 `await` 之前同步完成**，纯函数做不到（返回新对象也能做到，
 * 但调用方得自己赋值，容易忘）。所以这里只把「判定」做成纯函数，把「持有」交给状态对象。
 */
export interface SyncRunState {
  /** 正在跑的动作名（空串 = 空闲）。 */
  action: string;
  /** 动作开始时间（毫秒时间戳；`0` = 空闲/未知，文案里按「不到 1 秒」处理）。 */
  startedAt: number;
}

/** 抢闸结论（`beginExclusive` 的返回类型；对象字面量必须有显式 interface）。 */
export interface SyncRunBegin {
  /** 是否允许开始（`false` = 被闸拒绝）。 */
  ok: boolean;
  /** 拒绝原因（可直接展示的中文；`ok: true` 时为空串）。 */
  message: string;
  /** 本次对应的动作名（`ok: true` 时非空）。 */
  action: string;
  /**
   * 是否**真的持有**了闸。
   *
   * `ok: true` 但 `acquired: false` 只出现在只读动作（`status`）上：它不占闸，
   * 因此它的 `finally` **不能**调 `endExclusive`——否则会把别人（正在跑的 pull/push）的闸清掉。
   */
  acquired: boolean;
}

/** 空闲状态（每次 `new` 一份，避免两个 service 实例共享同一个对象）。 */
export function idleRunState(): SyncRunState {
  return { action: '', startedAt: 0 };
}

/** 归一化动作名（小写 + 去空格；未知动作保留原文，交给下面按「写动作」保守处理）。 */
function normalizeActionName(value: string): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** 动作的中文名（只用于拼可读文案，所以不认识的动词一律叫「同步」）。 */
function actionLabelOf(action: string): string {
  if (action === SYNC_ACTION_PULL) {
    return '拉取';
  }
  if (action === SYNC_ACTION_PUSH) {
    return '推送';
  }
  if (action === SYNC_ACTION_REGISTER) {
    return '设备登记';
  }
  if (action === SYNC_ACTION_STATUS) {
    return '查看状态';
  }
  return '同步';
}

/**
 * 把「已跑了多久」写成一句中文（`busyRejection` 用）。
 *
 * 故意不出现裸数字：< 1s 说「不到 1 秒」，< 1min 说「3.2 秒」，再长说「1 分 5 秒」。
 * 边界：负数 / NaN → 0（时钟回拨、`startedAt` 被写成未来时间都按「刚开始」处理）。
 */
export function describeElapsed(elapsedMs: number): string {
  const raw: number = typeof elapsedMs === 'number' && Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
  if (raw < 1000) {
    return '不到 1 秒';
  }
  const totalSeconds: number = Math.round(raw / 1000);
  if (totalSeconds < 60) {
    return (Math.round(raw / 100) / 10).toFixed(1) + ' 秒';
  }
  const minutes: number = Math.floor(totalSeconds / 60);
  const seconds: number = totalSeconds % 60;
  return minutes.toString() + ' 分 ' + seconds.toString() + ' 秒';
}

/**
 * 忙拒绝判定：**已有写动作在跑时返回可直接展示的中文原因，否则返回空串**。
 *
 * 规则（顺序即优先级）：
 * 1. 空闲 → 空串（放行）；
 * 2. 想跑 `status` → 空串：`status` 只读本地仓库 + 一次 `info/refs` 探测，不写工作副本、
 *    不写远端，**不会覆盖任何同步结果**；设置页每次同步完都要刷新状态，拦它只会把
 *    「同步中」变成一堆「正在同步，不能查状态」的噪音；
 * 3. 同一动作重复（连点「立即同步」→ pull + pull）→ 拒绝；
 * 4. **任意两个写动作互斥**（pull ↔ push ↔ register）：它们都改同一个 repository 的工作副本
 *    与远端引用，并行跑必然互相覆盖（pull 快进时另一条正在 commit，或 push 时另一条刚改了
 *    HEAD）。注意 `registerDevice` 内部会真拉 + 真提交 registry，所以它也是写动作、也要参与互斥。
 *
 * 文案一律含「还没结束」+ 已跑时长，且**不带裸错误码**（错误码在结果对象的 `code` 里）。
 *
 * @param state 当前在跑状态（`GitSyncService.runState`）
 * @param action 本次想开始的动作名（`SYNC_ACTION_*`）
 * @param nowMs 判定用的「现在」（毫秒时间戳；`0` = 读系统时钟。测试传固定值 → 文案可断言）
 * @returns 中文拒绝原因；空串表示可以开始
 */
export function busyRejection(state: SyncRunState, action: string, nowMs: number = 0): string {
  const next: string = normalizeActionName(action);
  const running: string = state === undefined || state === null ? '' : normalizeActionName(state.action);
  if (running.length === 0) {
    return '';
  }
  if (next === SYNC_ACTION_STATUS) {
    // 只读动作：允许与写动作并发（见上面规则 2）
    return '';
  }
  if (running === SYNC_ACTION_STATUS) {
    // 理论上不会发生（status 从不抢闸）；真出现也不该挡住写操作，按空闲处理
    return '';
  }
  const now: number = typeof nowMs === 'number' && nowMs > 0 ? nowMs : Date.now();
  const startedAt: number = state.startedAt;
  const elapsed: number = startedAt > 0 && now > startedAt ? now - startedAt : 0;
  const runningLabel: string = actionLabelOf(running);
  // 连点（毫秒级间隔）说「刚刚开始」比「已 不到 1 秒」自然，但「还没结束」这个词必须留着：
  // 它才是用户能看懂的那半句。
  const elapsedClause: string = elapsed < 1000 ? '刚刚开始' : '已 ' + describeElapsed(elapsed);
  const sameAction: boolean = next.length === 0 || next === running;
  if (sameAction) {
    return '上一次' + runningLabel + '还没结束（' + elapsedClause + '），请等它完成再点';
  }
  return (
    '上一次' +
    runningLabel +
    '还没结束（' +
    elapsedClause +
    '），请等' +
    runningLabel +
    '完成后再' +
    actionLabelOf(next)
  );
}

/**
 * 抢闸：判定通过就把状态置成「某动作在跑（现在开始）」。
 *
 * **必须在调用方的第一个 `await` 之前调用**：JS 单线程下只有 `await` 才会让出执行权，
 * 判定 + 置位同步完成，第二个异步入口才必然看得到「已在跑」。放到任何 `await` 之后，
 * 两次调用会在这段异步窗口里同时通过判定（这正是历史 bug 的形态）。
 *
 * 只读动作（`status`）**不占闸**：返回 `ok: true, acquired: false`，调用方不要放闸。
 */
export function beginExclusive(state: SyncRunState, action: string, nowMs: number = 0): SyncRunBegin {
  const next: string = normalizeActionName(action);
  const reason: string = busyRejection(state, next, nowMs);
  if (reason.length > 0) {
    return { ok: false, message: reason, action: '', acquired: false };
  }
  if (next === SYNC_ACTION_STATUS) {
    // 只读：不占闸、不改状态（否则它自己的 finally 会把写动作的闸清掉）
    return { ok: true, message: '', action: SYNC_ACTION_STATUS, acquired: false };
  }
  state.action = next.length > 0 ? next : 'sync';
  state.startedAt = typeof nowMs === 'number' && nowMs > 0 ? nowMs : Date.now();
  return { ok: true, message: '', action: state.action, acquired: true };
}

/**
 * 放闸：把状态清回空闲。**只由抢到闸的那个入口的 `finally` 调用一次**。
 *
 * 幂等：重复调用、空状态都不抛（`finally` 里可能被异常路径再走一遍）。
 *
 * @param owner 调用方抢到闸时的动作名（如 `SYNC_ACTION_PULL`）。**传了就校验**：当前持有者
 *              不是它（例如已经超时被清、或被别人的闸占着）就什么都不做——防御「被拒的调用/
 *              嵌套链路把别人的闸清掉」。空串 = 不校验（兼容旧调用方式）。
 */
export function endExclusive(state: SyncRunState, owner: string = ''): void {
  if (state === undefined || state === null) {
    return;
  }
  const holder: string = normalizeActionName(state.action);
  const expected: string = normalizeActionName(owner);
  if (expected.length > 0 && holder.length > 0 && holder !== expected) {
    return;
  }
  state.action = '';
  state.startedAt = 0;
}

// ---------------------------------------------------------------- pull 在飞闸（C 批：启动 pull 双发）

/**
 * 为什么需要这一节：`syncController.pullNow()` 的节流只看 `lastPullAt`，而 `lastPullAt` 要等 pull
 * **跑完**才写 → 「启动 pull」还在飞的时候，「回前台 pull」（`pullOnStartup`）能通过节流再发一次：
 * 双倍流量 + 两条结果互相覆盖（后完成的把先完成的 message 盖掉）。
 *
 * 修法**不新造状态机**：把上面的 `beginExclusive` / `endExclusive` 复用到 pull 上，并把
 * 「什么时候允许推进 `lastPullAt`」收进同一个对象——只有**真正发出** pull 并拿到结果（成功或失败）
 * 才推进；忙跳过 / 桥未就绪都不推进（老代码里「忙跳过」会把 60s 节流续上，是副作用）。
 *
 * 为什么不用 `syncController` 已有的 `starting` 字段：那个字段守的是 `ensureStarted`（建服务 +
 * 读设置），它的 `finally` 会无条件清零；若 pull 复用它，`ensureStarted` 的一次收尾就能把正在飞的
 * pull 标志清掉，反而制造双发。所以 pull 用自己的一份 `SyncRunState`（仍是同一套闸语义）。
 *
 * 纯对象（不 import `@kit.*`），测试见 `tools/test/syncPullInflight.test.mjs`。
 */

/** 抢闸结论（对象字面量必须有显式 interface）。 */
export interface PullGateDecision {
  /** 是否真的去拉（`false` = 已有 pull 在飞，本次**跳过**，不是失败）。 */
  proceed: boolean;
  /** 跳过原因（可直接展示的中文；`proceed: true` 时为空串）。 */
  message: string;
}

/** pull 的在飞闸 + 上次完成时间（`syncController` 持有一份，跨调用存活）。 */
export class PullGate {
  /** 在飞状态（复用 `SyncRunState` 语义：`action` 为空 = 空闲）。 */
  private run: SyncRunState = idleRunState();
  /** 上次**真正跑完**的 pull 的完成时间（毫秒；`0` = 从未跑过；忙跳过不算）。 */
  private lastPullAtMs: number = 0;

  /** 上次真正跑完的 pull 的完成时间（`0` = 从未跑过）。 */
  lastPullAt(): number {
    return this.lastPullAtMs;
  }

  /** 当前是否已有 pull 在飞（诊断/测试用；判定请用 `enter`）。 */
  inFlight(): boolean {
    return this.run.action.length > 0;
  }

  /**
   * 60s 节流判定（只读，不改状态）：距上次**完成**不足 `windowMs` → true。
   *
   * 时间倒退/异常（`nowMs` 非有限数）一律按「不节流」处理：宁可多拉一次，也不要永远跳过节流。
   */
  throttled(windowMs: number, nowMs: number): boolean {
    if (this.lastPullAtMs <= 0) {
      return false;
    }
    if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
      return false;
    }
    return nowMs - this.lastPullAtMs < windowMs;
  }

  /**
   * 抢闸。**必须在调用方的第一个 `await` 之前调**（JS 单线程：只有 `await` 会让出执行权，
   * 同步抢闸后第二个入口必然看得到「已在飞」）。
   *
   * 在飞 → `proceed: false` + 可读中文原因；**不碰** `lastPullAt`（跳过不是「刚刚拉过」）。
   */
  enter(nowMs: number): PullGateDecision {
    const begin: SyncRunBegin = beginExclusive(this.run, SYNC_ACTION_PULL, nowMs);
    if (!begin.ok) {
      return { proceed: false, message: begin.message };
    }
    return { proceed: true, message: '' };
  }

  /**
   * 记账：只有**真正发出**的 pull 拿到结果（成功或失败）才调；异常抛出、忙跳过、桥未就绪都不调。
   *
   * `nowMs` 非法（0/NaN/负数）回落到系统时钟：宁可记一个近似时间，也不要让节流永久失效。
   */
  markCompleted(nowMs: number): void {
    this.lastPullAtMs = typeof nowMs === 'number' && Number.isFinite(nowMs) && nowMs > 0 ? nowMs : Date.now();
  }

  /** 放闸：只在**抢到闸那一次**的 `finally` 里调（幂等；异常/超时路径也必须走到）。 */
  leave(): void {
    endExclusive(this.run, SYNC_ACTION_PULL);
  }
}
