/**
 * 首页全局下拉刷新的纯编排（mod-home-global-refresh / P1-D）。
 *
 * 为什么要有这一层：ArkUI 不能进 Node 单测，而「一次下拉 ⇒ 一个周期 ⇒ 四个读回」这条
 * 不变量必须能用 spy 断言调用次数与顺序。这里把副作用全部注入（`GlobalRefreshHooks`），
 * 只保留两件纯逻辑：
 *   ① **单飞 + 共享 Promise**：两个手势（首页外壳的下拉 / 日程面板自己的下拉）同时到达时，
 *      第二个直接 `await` 第一个的在飞 Promise——周期只跑一次、四个读回只跑一次，
 *      但第二个调用方**不会**被静默跳过，它拿到同一份已完成结果；
 *   ② **固定顺序**：周期 settle 之后依次 日程 → dots → 云端对话 → 状态存储（最后），
 *      且这份读回清单住在 `execute()` 的 `finally` 里——抛错也照样按序读回四个面，
 *      因此状态行与三个列表看到的是同一次周期的结果（即使周期只写了一半）。
 *
 * 复用 `model/syncGuard.ts` 的 `beginExclusive` / `endExclusive` 作为单飞闸原语
 * （与启动 pull 的 `PullGate` 同一套语义），**不另造状态机、不实现第二份同步**：
 * 真正的周期由调用方注入（ETS 侧就是 `syncProtocolStore.runConfiguredCycle()`）。
 *
 * 失败只有一个落点：周期返回失败结果走 `commitStatus`，抛错走 `reportFailure`，
 * 二者互斥且都只写唯一的状态存储（ETS 侧 `syncStatusStore`），本层不 toast、不生成第二份错误文案。
 */
import { beginExclusive, endExclusive, idleRunState } from './syncGuard';
import type { SyncRunState } from './syncGuard';

/** 全局刷新的闸动作名：与 `pull` / `push` / `register` 互斥命名空间，独占一个状态对象。 */
export const GLOBAL_REFRESH_ACTION: string = 'globalRefresh';

/**
 * 五个静默触发源（mod-sync-silence-phase-b）：冷启动 / 保存后 / 下拉 / 前台恢复 / 网络恢复。
 * 名字即整条日志的内容——表里存的是**字面量**，日志调用无插值、无 token、无 URL。
 */
export type SyncTriggerName = 'cold-launch' | 'save' | 'pull' | 'foreground' | 'network';

/** 名字 → 完整日志行（字面量；artifact 里按名字可直接命中）。 */
const TRIGGER_LOG: Record<SyncTriggerName, string> = {
  'cold-launch': '[sync-trigger] cold-launch',
  'save': '[sync-trigger] save',
  'pull': '[sync-trigger] pull',
  'foreground': '[sync-trigger] foreground',
  'network': '[sync-trigger] network'
};

/**
 * 日志落点：ETS 侧注入 `console.info`（本纯模型不 import / 不引用 console，保证 Node 可编译），
 * Node 测试注入 spy 以证明「一次尝试恰好一行」。默认 no-op：没有 ETS 宿主时不伪造日志。
 */
export type TriggerLogger = (line: string) => void;

/**
 * 周期结果与 ETS 侧 `services/syncProtocolStore.CycleResult` 逐字段同形（不 import 服务，
 * 保持本文件可在 Node 直接编译）：这样 `syncStatusStore.fromCycle(result)` 无需任何断言。
 */
export interface RefreshCycleResult {
  ok: boolean;
  code: string;
  message: string;
  days: number;
  conflicts: number;
  added: number;
  dropped: string[];
  pending: number;
  failed: number;
  attempts: number;
}

/**
 * 一次全局刷新要注入的全部副作用。ETS 侧接真实 store / 面板 tick；Node 测试传 spy。
 *
 * `reloadSchedule` / `reloadDots` / `reloadCloudChat` 是三个面板「从磁盘/store 重读」的钩子，
 * `commitStatus` 是第四个（状态存储最后写）——顺序由本层固定，注入方不能改。
 */
export interface GlobalRefreshHooks {
  /** 唯一同步周期入口（ETS 注入 `syncProtocolStore.runConfiguredCycle`）。 */
  runCycle: () => Promise<RefreshCycleResult | null>;
  /** 周期在途（ETS 注入 `syncStatusStore.setSyncing`）。 */
  markSyncing?: () => void;
  /** ① 日程面板重读 timelineStore。 */
  reloadSchedule?: () => void;
  /** ② dots 面板重读 chatStore（kind=dots）。 */
  reloadDots?: () => void;
  /** ③ 云端对话面板重读 chatStore（kind=cloud）。 */
  reloadCloudChat?: () => void;
  /** ④ 状态存储最后写（ETS 注入 `syncStatusStore.fromCycle` + 状态行重读 tick）。 */
  commitStatus?: (result: RefreshCycleResult | null) => void;
  /** 周期抛错时的 typed 失败唯一落点（与 commitStatus 互斥，恰好走一条）。 */
  reportFailure?: (reason: string) => void;
  /** 只读：当前状态行是否已是「仓库可见性阻塞」（ETS 注入 snapshot() 判定，不写盘）。 */
  isRepoBlocked?: () => boolean;
  /** 隐私码失败的唯一落点（ETS 注入 `syncStatusStore.setRepoBlocked`），优先于通用 reportFailure。 */
  reportRepoBlocked?: (code: string) => void;
}

/**
 * 只读的仓库阻塞判据：只认 `syncStatusStore.snapshot()` 公开视图里的两个 state。
 * 这里不 import 隐私 lane 的文件（它们在并行修改），也不写任何状态——纯判定。
 */
export interface RepoBlockSnapshotLike {
  state: string;
}

export function isRepoBlockedStatus(snapshot: RepoBlockSnapshotLike | null | undefined): boolean {
  if (snapshot === null || snapshot === undefined) {
    return false;
  }
  return snapshot.state === 'repo_public' || snapshot.state === 'repo_unknown';
}

/** 隐私 typed 码（与 `model/repoVisibility.ts` 导出的常量同字面量；本文件不依赖另一 lane）。 */
export const REPO_PUBLIC_CODE: string = 'E_REPO_PUBLIC';
export const REPO_VISIBILITY_UNKNOWN_CODE: string = 'E_REPO_VISIBILITY_UNKNOWN';

/** 抛错文案里带隐私码就归隐私路径；普通错误返回空串走通用 typed 失败。 */
function repoBlockCodeOf(reason: string): string {
  if (reason.indexOf(REPO_PUBLIC_CODE) >= 0) {
    return REPO_PUBLIC_CODE;
  }
  if (reason.indexOf(REPO_VISIBILITY_UNKNOWN_CODE) >= 0) {
    return REPO_VISIBILITY_UNKNOWN_CODE;
  }
  return '';
}

/** 调用方拿到的结果：`leader=false` 表示复用了别人的在飞 Promise（没有二次周期 / 二次读回）。 */
export interface GlobalRefreshOutcome {
  /** 本次调用是否发起者。 */
  leader: boolean;
  /** 本次调用是否真的调用了周期（全局只有 leader 为 true）。 */
  cycleInvoked: boolean;
  ok: boolean;
  /** typed 失败原因（成功为空串）。 */
  reason: string;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 只读地查当前状态行是否已是仓库阻塞（钩子缺席 = 没有阻塞事实可依据）。 */
function repoBlocked(hooks: GlobalRefreshHooks): boolean {
  return hooks.isRepoBlocked !== undefined && hooks.isRepoBlocked();
}

/**
 * 单飞协调器：一个实例全 App 共用（ETS 侧导出单例）。
 *
 * `configure()` 由 Home 在 `aboutToAppear()` 调一次，登记「四个读回 + 状态提交」的完整钩子；
 * 日程面板自己的下拉只传**覆盖项**（它自己的 reload / 状态 @State），其余两个面板的读回
 * 仍来自 Home 登记的那份——于是无论哪个手势先到，四个面都会被重读一次。
 */
export class GlobalRefreshCoordinator {
  private run: SyncRunState = idleRunState();
  /** 在飞的唯一 Promise：`null` = 空闲。第二个下拉直接 await 它，不另起周期。 */
  private inFlight: Promise<GlobalRefreshOutcome> | null = null;
  /** Home 登记的完整钩子（含 dots / cloud 读回），面板下拉传覆盖项时继承它。 */
  private configured: GlobalRefreshHooks | null = null;
  /** 最近一次**真正发起**周期的进程内时刻（epoch ms；`null` = 本进程还没跑过）。 */
  private lastAttemptMs: number | null = null;
  /** 注入时钟与日志落点（生产时钟 Date.now；日志由 ETS 侧安装，测试可直接注入假件）。 */
  private now: () => number;
  private logger: TriggerLogger;

  constructor(now?: () => number, logger?: TriggerLogger) {
    this.now = now === undefined ? (): number => Date.now() : now;
    this.logger = logger === undefined ? (_line: string): void => {} : logger;
  }

  /** ETS 侧安装 `console.info` 落点；单飞单例只装一次，重复安装以最后一次为准。 */
  setLogger(logger: TriggerLogger): void {
    this.logger = logger;
  }

  /** 只读：最近一次周期发起时刻，供前台触发的 5 分钟冷却判定（不写盘、不触发同步）。 */
  lastAttemptAt(): number | null {
    return this.lastAttemptMs;
  }

  /** 当前是否有刷新在途（诊断 / 测试用；判定请用 `runOnce`）。 */
  isRefreshing(): boolean {
    return this.inFlight !== null;
  }

  /** 登记完整的四读回钩子（幂等：重复调用只更新）。 */
  configure(hooks: GlobalRefreshHooks): void {
    this.configured = hooks;
  }

  /**
   * Home 是否已登记完整钩子。
   *
   * 写后自动同步（recordWriter）可能在 Home 的 `aboutToAppear()` 之前就发生：它据此决定
   * 是否补齐一份与 Home 同形的状态落点，避免早期周期把三态行卡在「同步中…」。
   * 这只是在**填充钩子**，不新增第二把闸——闸门仍只有下面的 `inFlight`。
   */
  isConfigured(): boolean {
    return this.configured !== null;
  }

  /** 合并「Home 完整钩子」与「面板覆盖项」；`runCycle` 必须最终存在。 */
  private hooksOf(overrides?: Partial<GlobalRefreshHooks>): GlobalRefreshHooks {
    const base: GlobalRefreshHooks | null = this.configured;
    const runCycle: (() => Promise<RefreshCycleResult | null>) | undefined =
      overrides !== undefined && overrides.runCycle !== undefined
        ? overrides.runCycle
        : base === null ? undefined : base.runCycle;
    if (runCycle === undefined) {
      throw new Error('E_GLOBAL_REFRESH_UNWIRED: 全局刷新未注入唯一周期入口');
    }
    const merged: GlobalRefreshHooks = {
      runCycle: runCycle,
      markSyncing: overrides?.markSyncing ?? base?.markSyncing,
      reloadSchedule: overrides?.reloadSchedule ?? base?.reloadSchedule,
      reloadDots: overrides?.reloadDots ?? base?.reloadDots,
      reloadCloudChat: overrides?.reloadCloudChat ?? base?.reloadCloudChat,
      commitStatus: overrides?.commitStatus ?? base?.commitStatus,
      reportFailure: overrides?.reportFailure ?? base?.reportFailure,
      isRepoBlocked: overrides?.isRepoBlocked ?? base?.isRepoBlocked,
      reportRepoBlocked: overrides?.reportRepoBlocked ?? base?.reportRepoBlocked
    };
    return merged;
  }

  /**
   * 发起或跟随一次全局刷新。
   *
   * 在飞时**共享同一个 Promise**（不是静默返回 skipped）：第二个手势 await 到同一结果，
   * 周期与四个读回都只发生一次；调用方据此复位自己的转圈即可。
   */
  async runOnce(
    overrides?: Partial<GlobalRefreshHooks>,
    trigger: SyncTriggerName | '' = ''
  ): Promise<GlobalRefreshOutcome> {
    if (this.inFlight !== null) {
      const shared: GlobalRefreshOutcome = await this.inFlight;
      return { leader: false, cycleInvoked: false, ok: shared.ok, reason: shared.reason };
    }
    // 抢闸在第一个 await 之前（与 syncGuard 的约定一致）；单线程下第二个入口必然看到在飞 Promise。
    const begun = beginExclusive(this.run, GLOBAL_REFRESH_ACTION);
    if (!begun.ok) {
      // 闸被同命名空间占用只可能是本协调器的重入（理论上已被 inFlight 拦截）；
      // 不静默吞：返回 typed「进行中」结果，调用方仍会复位转圈并读回状态。
      return { leader: false, cycleInvoked: false, ok: false, reason: begun.message };
    }
    let hooks: GlobalRefreshHooks;
    try {
      hooks = this.hooksOf(overrides);
    } catch (error) {
      endExclusive(this.run, GLOBAL_REFRESH_ACTION);
      throw error;
    }
    const task: Promise<GlobalRefreshOutcome> = this.execute(hooks, trigger);
    this.inFlight = task;
    try {
      return await task;
    } finally {
      this.inFlight = null;
      endExclusive(this.run, GLOBAL_REFRESH_ACTION);
    }
  }

  /**
   * 真正的编排：一个周期 →（无论成败）按序四个读回 → 单一失败落点。
   *
   * 四个读回**只写在 `finally`**：周期抛错时旧实现会在 catch 里提前 return，
   * 把三个列表留在周期之前的旧快照；现在 catch 只记录 typed 原因，
   * 真正的状态面写入（失败走 reportFailure / 成功走 commitStatus）也在 finally 的最后一步。
   * 因此成功与抛错两条路径都恰好按 日程 → dots → 云端 → 状态 各读回一次。
   */
  private async execute(
    hooks: GlobalRefreshHooks,
    trigger: SyncTriggerName | ''
  ): Promise<GlobalRefreshOutcome> {
    // 只有 leader 进到这里：一次尝试一次戳、一条触发日志（跟随者共享 Promise，不重复记）。
    this.lastAttemptMs = this.now();
    if (trigger !== '') {
      this.logger(TRIGGER_LOG[trigger]);
    }
    // 仓库可见性阻塞是更可执行的既有状态：连「同步中…」都不写，避免一个周期出现两条状态文案。
    const blockedAtStart: boolean = repoBlocked(hooks);
    if (hooks.markSyncing !== undefined && !blockedAtStart) {
      hooks.markSyncing();
    }
    let result: RefreshCycleResult | null = null;
    let thrown: boolean = false;
    let thrownReason: string = '';
    try {
      result = await hooks.runCycle();
    } catch (error) {
      // 只记 typed 原因，**不 return**：return 会跳过 finally 的四个读回（P1-D 的 Minor 1）。
      thrown = true;
      thrownReason = reasonOf(error);
    } finally {
      // 固定顺序（注入方不能改）：日程 → dots → 云端 → 状态存储最后。
      // 状态这一步互斥：抛错只走 reportFailure，不再写 commitStatus（失败仍只有一个落点）。
      if (hooks.reloadSchedule !== undefined) {
        hooks.reloadSchedule();
      }
      if (hooks.reloadDots !== undefined) {
        hooks.reloadDots();
      }
      if (hooks.reloadCloudChat !== undefined) {
        hooks.reloadCloudChat();
      }
      if (thrown) {
        const repoCode: string = repoBlockCodeOf(thrownReason);
        if (repoCode.length > 0) {
          // 抛错本身就是隐私码：只走隐私落点；无该钩子时才退回 reportFailure，且只传隐私码。
          if (hooks.reportRepoBlocked !== undefined) {
            hooks.reportRepoBlocked(repoCode);
          } else if (hooks.reportFailure !== undefined) {
            hooks.reportFailure(repoCode);
          }
        } else if (blockedAtStart || repoBlocked(hooks)) {
          // 已存在（或周期中刚写入）「已停止上传（最近尝试 HH:MM）」：更可执行，通用失败不得覆盖。
          // 本分支刻意不写任何状态面——一个失败周期只保留隐私那一条文案。
        } else if (hooks.reportFailure !== undefined) {
          hooks.reportFailure(thrownReason);
        }
      } else if (hooks.commitStatus !== undefined) {
        hooks.commitStatus(result);
      }
    }
    if (thrown) {
      return { leader: true, cycleInvoked: true, ok: false, reason: thrownReason };
    }
    const ok: boolean = result !== null && result.ok && result.pending === 0 && result.failed === 0;
    const reason: string = result === null ? '' : result.message;
    return { leader: true, cycleInvoked: true, ok: ok, reason: reason };
  }
}

/** 全 App 单例：Home 与 SchedulePane 共用同一把闸、同一份在飞 Promise。 */
export const globalRefreshCoordinator: GlobalRefreshCoordinator = new GlobalRefreshCoordinator();
