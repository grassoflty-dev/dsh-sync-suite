/**
 * 首页冷启动自动同步的一次性编排（mod-home-startup-sync）。
 *
 * 背景（真机 1000007 复现）：`EntryAbility.ets:108` 加载的是 `pages/Home`，而只有 legacy
 * fallback `pages/Index` 拥有 `GitBridgeHost` + `syncController.ensureStarted()`。于是冷启动
 * 即使配置完好，也没有任何入口发起首轮同步——这是「像华为云一样无感同步」在真入口路径上的硬缺口。
 *
 * 本模块只做**四件可单测的事**，绝不实现第二份同步：
 * ① **进程内一次**：`request()` 由 aboutToAppear / onPageShow 调用，第一个请求消费掉唯一的配额，
 *    重复 show、重渲染、重复的桥就绪回调都进不来；没有定时器、轮询、重试循环。
 * ② **就绪顺序**：桥未就绪时只登记 `deferred`，等 `onBridgeReady()`（GitBridgeHost.onReady +
 *    ensureStarted 之后）再发起；因此周期永远不会跑在内核之前。桥失败 / ensureStarted 后仍
 *    未就绪 ⇒ `onBridgeFail()` 写一条 typed 原因，绝不静默丢掉这次启动尝试。
 * ③ **已配置判据单一来源**：`isConfigured` 钩子由页面用 `model/repoConfigured.ts` 的
 *    `isRepoConfigured` 实现（只读 settingsStore 冷读）；未配置 ⇒ 零周期、零状态写入、零 toast，
 *    中性行原样保留。被隐私阻断的仓库依旧是「已配置」，周期照跑，推送许可仍由既有门禁决定。
 * ④ **单闸入口**：`runOnce` 钩子由页面接到 `globalRefreshCoordinator.runOnce()`；本模块从不
 *    直接触碰 `runConfiguredCycle()` / push。周期失败由协调器既有的 typed 落点呈现；只有
 *    协调器自己抛错（未接线等）才在这里写一次 `reportFailure`，零 toast、零第二错误面。
 */

/** 桥未就绪时唯一状态行的 typed 原因（中文，可直接显示为失败原因）。 */
export const BRIDGE_NOT_READY_REASON: string = '同步内核未就绪，稍后重试';

/** 本模块不造新错误码：沿用周期服务既有的 typed 码。 */
export const E_STARTUP_SYNC_UNAVAILABLE: string = 'E_SYNC_UNAVAILABLE';

/** 页面注入的全部副作用（ArkUI 侧接真 store / 协调器，Node 测试传 spy）。 */
export interface HomeStartupHooks {
  /** 只读：同步内核（隐藏 Web + 服务）是否已就绪。 */
  isBridgeReady: () => boolean;
  /** 冷读配置并复用单一已配置判据；读盘失败按未配置处理。 */
  isConfigured: () => Promise<boolean>;
  /** 唯一周期入口：ETS 侧必须是 `globalRefreshCoordinator.runOnce()`。 */
  runOnce: () => Promise<void>;
  /** 唯一失败落点：ETS 侧 `syncStatusStore.setFailed`（状态行单点渲染）。 */
  reportFailure: (reason: string) => void;
}

/** 只读快照（诊断 / 测试用；不提供任何写接口）。 */
export interface HomeStartupSnapshot {
  requested: boolean;
  attempted: boolean;
  cycleLaunched: boolean;
  deferred: boolean;
  failed: boolean;
}

export class HomeStartupSync {
  private hooks: HomeStartupHooks | null = null;
  /** 进程级一次性配额：第一个 request 消费，之后的 show / 重渲染一律吞掉。 */
  private requested: boolean = false;
  /** 已抢占唯一尝试（在第一个 await 之前同步置位，防止就绪回调二次进入）。 */
  private attempted: boolean = false;
  /** 真的调用了 runOnce（供测试点名「恰好一个周期」）。 */
  private cycleLaunched: boolean = false;
  /** 桥未就绪、请求挂在就绪回调上。 */
  private deferred: boolean = false;
  /** 已写 typed 失败（后续就绪回调不得再发起周期）。 */
  private failed: boolean = false;
  /** 最近一次分发（测试用 `settled()` 等它；生产不轮询、不定时）。 */
  private pending: Promise<void> | null = null;

  configure(hooks: HomeStartupHooks): void {
    this.hooks = hooks;
  }

  snapshot(): HomeStartupSnapshot {
    const view: HomeStartupSnapshot = {
      requested: this.requested,
      attempted: this.attempted,
      cycleLaunched: this.cycleLaunched,
      deferred: this.deferred,
      failed: this.failed
    };
    return view;
  }

  /**
   * 页面出现时调用（aboutToAppear 与每次 onPageShow 都可以调）。
   * 只有第一次生效；桥还没好就等 `onBridgeReady()`，绝不在这里静默丢弃。
   */
  request(): void {
    if (this.requested) {
      return;
    }
    this.requested = true;
    this.pending = this.dispatchIfReady();
  }

  /** GitBridgeHost.onReady → ensureStarted 之后调用：消费挂起的启动请求。 */
  onBridgeReady(): void {
    if (this.failed || this.attempted) {
      return;
    }
    this.pending = this.dispatchIfReady();
  }

  /** 测试 / 诊断用：等当前分发 settle（生产不调用；不是定时器也不是轮询）。 */
  async settled(): Promise<void> {
    if (this.pending !== null) {
      await this.pending;
    }
  }

  /**
   * 桥加载失败 / ensureStarted 完成但仍未就绪：把原因写进唯一状态行。
   * 已经发起周期（或已经写过失败）后不再重复，避免第二处错误面。
   */
  onBridgeFail(reason?: string): void {
    if (this.failed || this.attempted || !this.requested) {
      return;
    }
    this.failed = true;
    this.deferred = false;
    const hooks: HomeStartupHooks | null = this.hooks;
    if (hooks === null) {
      return;
    }
    const text: string = reason === undefined || reason.length === 0
      ? BRIDGE_NOT_READY_REASON
      : reason;
    hooks.reportFailure(text);
  }

  /** 就绪才发一次；抢占 attempt 在第一个 await 之前，重复入口必然看到已占用。 */
  private async dispatchIfReady(): Promise<void> {
    if (this.attempted || this.failed) {
      return;
    }
    const hooks: HomeStartupHooks | null = this.hooks;
    if (hooks === null) {
      return;
    }
    if (!hooks.isBridgeReady()) {
      this.deferred = true;
      return;
    }
    this.attempted = true;
    this.deferred = false;
    let configured: boolean = false;
    try {
      configured = await hooks.isConfigured();
    } catch {
      // 冷读失败 ⇒ 没有可证明的配置 ⇒ 未配置路径：零周期、零状态写入、零 toast。
      configured = false;
    }
    if (!configured) {
      return;
    }
    this.cycleLaunched = true;
    try {
      await hooks.runOnce();
    } catch (error) {
      // 协调器内部的周期失败已由它自己的 reportFailure/commitStatus 落点呈现；这里只接
      // 协调器自身抛错（未接线等），因此一次启动最多只有一条 typed 失败。
      const reason: string = error instanceof Error ? error.message : String(error);
      this.failed = true;
      hooks.reportFailure(reason.length > 0 ? reason : E_STARTUP_SYNC_UNAVAILABLE);
    }
  }
}

/** 全 App 单例：进程内唯一一份「一次启动」状态；页面不得自行 new。 */
export const homeStartupSync: HomeStartupSync = new HomeStartupSync();
