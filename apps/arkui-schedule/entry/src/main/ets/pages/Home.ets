/**
 * 外壳主页（mod-shell-rail / S2 + mod-shell-schedule-pane / S3）：左侧导航条 + 右侧内容区。
 *
 * ## 布局（唯一一层 flex 分割）
 * `Row { ShellRail(...), Stack (panes).layoutWeight(1) }` —— 整页只有这一处
 * 用 `layoutWeight` 做横向切分；内容区是一个 **Stack**（不是固定高度 Column），
 * 四个分段面板叠放其中，各自内部用自己的 `Scroll` 承载滚动。没有嵌套的
 * 固定高度 Column 去包住内容区，也没有 PageLayout 那种「固定页头 + 内容」
 * 的外壳（那会多出一层 flex）。内容区自身 `.height('100%')` 撑满，滚动归面板。
 *
 * ## 分段保活（keep-alive）
 * 四个**外部组件**在 Stack 里全部实例化，从不写 `if/else` 条件渲染；
 * 非当前分段通过 `active` prop → 面板自己的
 * `.visibility(active ? Visibility.Visible : Visibility.Hidden)` 隐藏
 * （Hidden 仍留在组件树上，不卸载）。因此每个面板自己的 @State、滚动位置、选中态
 * 在切换分段后仍然存在。S3 已把四个 @Builder 抽成 pages/panes/*.ets，接线原样保留。
 *
 * ## 断点 / 抽屉
 * 与 `Index.ets` / `PageLayout.ets` 同一套机制：根容器 `onAreaChange` 拿宽高，
 * `resolveBreakpoint(width, isLandscapeSize(width, height))` 算断点并存入 @State；
 * 页面只按 `breakpoint === 'compact'` 分支（横屏按全局规则至少 medium）。
 * compact 下导航条从 Row 里撤出，改为 root Stack 上的抽屉；分段页头（S3 抽壳后由
 * 各面板自己拥有）不再负责开抽屉，compact 时由 root Stack 的 ☰ 悬浮入口打开，
 * 点分段或点蒙层关闭；抽屉里的 ShellRail 用 `Visibility.None` 挂起（不占布局）。
 *
 * ## 返回
 * `onBackPress()`：当前不在 dots 时先回 dots 并吃掉本次返回（true）；
 * 已在 dots 则放行（false），由系统退出。
 *
 * ## 深链
 * `aboutToAppear()` 读 `router.getParams()` 的可选 `section` / `id`。
 * `section` 只认 S1 的四个合法 id（`dots / schedule / instances / cloudChat`），
 * 其余回落 dots；`id` 原样传给每个面板组件（日程面板保留，三个占位预留）。
 */
import { promptAction, router } from '@kit.ArkUI';
import { common } from '@kit.AbilityKit';
import { webview } from '@kit.ArkWeb';
import { BusinessError } from '@kit.BasicServicesKit';
import { connection } from '@kit.NetworkKit';
import { globalRefreshCoordinator, isRepoBlockedStatus } from '../model/homeGlobalRefresh';
import type { RefreshCycleResult } from '../model/homeGlobalRefresh';
// mod-sync-silence-phase-b：前台 5 分钟冷却 / 网络变化合并的纯决策（零 SDK，Node 可测）。
import {
  NETWORK_DEBOUNCE_MS,
  shouldArmNetworkDebounce,
  shouldRunForegroundTrigger
} from '../model/syncTriggerPolicy';
import { isRepoConfigured } from '../model/repoConfigured';
import type { RepoConfigInput } from '../model/repoConfigured';
import { homeStartupSync, BRIDGE_NOT_READY_REASON } from '../model/homeStartupSync';
import { GitBridgeHost } from '../components/GitBridgeHost';
import { syncController } from '../services/syncController';
import { settingsStore } from '../services/settingsStore';
import type { ScheduleSettings } from '../services/settingsStore';
import { bindBridgeRunner } from '../services/gitRunner';
import { syncProtocolStore } from '../services/syncProtocolStore';
import type { CycleResult } from '../services/syncProtocolStore';
import { syncStatusStore } from '../services/syncStatusStore';
import {
  DIVIDER,
  FONT,
  SPACING,
  TOUCH_MIN,
  isLandscapeSize,
  resolveBreakpoint
} from '../common/uiTokens';
import { ShellRail } from '../components/shell/ShellRail';
import type { ShellSection } from '../components/shell/ShellRail';
import {
  SHELL_SECTION_CLOUD_CHAT,
  SHELL_SECTION_DOTS,
  SHELL_SECTION_INSTANCES,
  SHELL_SECTION_SCHEDULE
} from '../components/shell/ShellRail';
import { DotsPane } from './panes/DotsPane';
import { SchedulePane } from './panes/SchedulePane';
import { InstancesPane } from './panes/InstancesPane';
import { CloudChatPane } from './panes/CloudChatPane';

// ---------------------------------------------------------------- 外壳页面

/** 隐藏桥宿主的 1vp 尺寸：具名常量，避免把布局高度写死在源码里（U-S9 纪律）。 */
const BRIDGE_HOST_SIZE: number = 1;

/** 路由 `section` 参数的严格归一：未知值一律回落 dots（id 真值来自 S1）。 */
function parseSection(value: string | undefined): ShellSection {
  if (
    value === SHELL_SECTION_DOTS ||
    value === SHELL_SECTION_SCHEDULE ||
    value === SHELL_SECTION_INSTANCES ||
    value === SHELL_SECTION_CLOUD_CHAT
  ) {
    return value as ShellSection;
  }
  return SHELL_SECTION_DOTS;
}

@Entry
@Component
struct Home {
  /** 当前分段（默认 dots；真值来自 S1 的 ShellSection）。 */
  @State section: ShellSection = SHELL_SECTION_DOTS;
  /** 深链携带的 id，原样传给每个面板组件。 */
  @State deepLinkId: string = '';
  /** 断点（与 Index 一致：onAreaChange + resolveBreakpoint）。 */
  @State breakpoint: string = 'compact';
  /** 内容区宽度（vp），预留给 S3 的双栏 body。 */
  @State contentWidth: number = 0;
  /** compact 抽屉是否展开。 */
  @State drawerOpen: boolean = false;
  /**
   * 日程面板的「页面重新显示」信号（单调递增；每次 onPageShow +1）。
   *
   * Home 是 @Entry 页，只有它拿得到 onPageShow 生命周期；日程面板是保活的外部 @Component，
   * 自己的 onPageShow 永远不会被框架调用。新建记录后从编辑页返回时，必须由这里把 show 信号
   * 转给面板，面板在 @Watch 里消费一次性保存标记并重读列表——否则列表要等用户切一下 tab 才刷新。
   */
  @State scheduleShowTick: number = 0;

  /**
   * 远程实例面板的「页面重新显示」信号（单调递增；每次 onPageShow +1）。
   * InstancesPane 保活拿不到自己的 onPageShow；在设置子页删掉实例后返回首页，必须由这里
   * 把 show 信号转给面板，面板在 @Watch 里重读 instanceStore——否则会留着旧行与旧令牌。
   */
  @State instancesShowTick: number = 0;

  /**
   * 首页全局下拉刷新（mod-home-global-refresh / P1-D）：一次手势 = 一个周期 + 四个读回。
   *
   * `globalRefreshing` 只驱动外壳 Refresh 的转圈；真正的单飞闸 + 在飞 Promise 共享在
   * `globalRefreshCoordinator`（纯模型，Node 可测）。三个 tick 是外壳通知保活面板「重读磁盘」
   * 的唯一通道（与 `scheduleShowTick` 同款：面板是外部 @Component，拿不到自己的 onPageShow）。
   * 状态行仍由 `SchedulePane.SyncStatusRow()` 唯一渲染——`statusRefreshTick` 只让它在周期结果
   * 落进 syncStatusStore **之后**再读一次，保证状态与三个列表看到的是同一次周期。
   */
  @State globalRefreshing: boolean = false;
  @State scheduleRefreshTick: number = 0;
  @State dotsRefreshTick: number = 0;
  @State cloudChatRefreshTick: number = 0;
  @State statusRefreshTick: number = 0;

  // ---------------------------------------------------------------- 静默触发（mod-sync-silence-phase-b）
  /** 前台触发 / 配置冷读共用的 Ability context（aboutToAppear 里取一次）。 */
  private abilityContext: common.UIAbilityContext | null = null;
  /** 网络恢复监听：页面销毁时 unregister，避免泄漏。 */
  private netConnection: connection.NetConnection | null = null;
  /** 网络变化 debounce 定时器（-1 = 未武装）。 */
  private netDebounceTimer: number = -1;
  /** 上一次已受理的 transport（同类型事件忽略）。 */
  private lastTransport: string = '';

  aboutToAppear(): void {
    // mod-sync-silence-phase-b：给纯层协调器安装唯一的日志落点。纯模型里不能引用 console
    // （Node tsc 无 DOM lib），所以由 ETS 宿主注入；日志无插值 / 无 token / 无 URL。
    globalRefreshCoordinator.setLogger((line: string): void => {
      console.info(line);
    });

    // 只登记一次完整的四读回钩子：日程 / dots / 云端 / 状态存储（最后写）。
    // 日程面板自己的下拉只传覆盖项（它自己的 reload + 状态 @State），dots / cloud 读回继承这里。
    globalRefreshCoordinator.configure({
      runCycle: async (): Promise<RefreshCycleResult | null> => {
        bindBridgeRunner(getContext(this) as common.UIAbilityContext);
        return await syncProtocolStore.runConfiguredCycle();
      },
      markSyncing: (): void => {
        syncStatusStore.setSyncing();
      },
      reloadSchedule: (): void => {
        this.scheduleRefreshTick = this.scheduleRefreshTick + 1;
      },
      reloadDots: (): void => {
        this.dotsRefreshTick = this.dotsRefreshTick + 1;
      },
      reloadCloudChat: (): void => {
        this.cloudChatRefreshTick = this.cloudChatRefreshTick + 1;
      },
      commitStatus: (cycle: RefreshCycleResult | null): void => {
        // 状态存储最后写；typed 失败原因原样落进 syncStatusStore，只有一个渲染点。
        // ArkTS 不允许两个 interface 之间结构化赋值：把纯层结果按字段构成服务层 CycleResult。
        if (cycle !== null) {
          const result: CycleResult = {
            ok: cycle.ok, code: cycle.code, message: cycle.message, days: cycle.days,
            conflicts: cycle.conflicts, added: cycle.added, dropped: cycle.dropped,
            pending: cycle.pending, failed: cycle.failed, attempts: cycle.attempts
          };
          syncStatusStore.fromCycle(result, new Date());
        }
        this.statusRefreshTick = this.statusRefreshTick + 1;
      },
      reportFailure: (reason: string): void => {
        syncStatusStore.setFailed(reason);
        this.statusRefreshTick = this.statusRefreshTick + 1;
      },
      // 隐私门禁的「已停止上传」更可执行：只读判定 + 独立落点，通用失败不得覆盖它。
      isRepoBlocked: (): boolean => isRepoBlockedStatus(syncStatusStore.snapshot()),
      reportRepoBlocked: (code: string): void => {
        syncStatusStore.setRepoBlocked(code, new Date());
        this.statusRefreshTick = this.statusRefreshTick + 1;
      }
    });

    // mod-home-startup-sync：真入口页冷启动自动同步（Legacy fallback pages/Index 的老接线
    // 在 Home 上补齐）。这里只登记钩子并提出一次请求；桥未就绪时由 GitBridgeHost.onReady
    // 兑现，绝不静默丢弃。重复 onPageShow / 重渲染不会再来第二个周期。
    const abilityContext: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
    this.abilityContext = abilityContext;
    homeStartupSync.configure({
      isBridgeReady: (): boolean => syncController.isReady(),
      // 与前台 / 网络触发共用同一个「已配置」判据（冷读失败按未配置处理）。
      isConfigured: async (): Promise<boolean> => this.isSyncConfigured(),
      // 唯一周期入口就是单飞协调器；Home 里没有第二处 runConfiguredCycle 调用。
      // mod-sync-silence-phase-b：触发名交给协调器，leader 每次尝试恰好打一行日志。
      runOnce: async (): Promise<void> => {
        await globalRefreshCoordinator.runOnce(undefined, 'cold-launch');
      },
      reportFailure: (reason: string): void => {
        // 唯一失败面：既有状态行（SyncStatusRow）；不弹 toast、不写第二份错误文案。
        syncStatusStore.setFailed(reason);
        this.statusRefreshTick = this.statusRefreshTick + 1;
      }
    });
    homeStartupSync.request();

    // 网络恢复静默触发：订阅默认网络的 transport 变化，2 s debounce 合并突发；
    // 权限 / 后台限制导致订阅不可用时只降级到前台触发，绝不假装已经监听成功。
    this.subscribeNetworkRegain();

    try {
      const params = router.getParams() as Record<string, string>;
      if (params !== undefined && params !== null) {
        this.section = parseSection(params['section']);
        const id: string | undefined = params['id'];
        if (id !== undefined) {
          this.deepLinkId = id;
        }
      }
    } catch (error) {
      // 没有参数 / 参数类型不对都走默认值，不让外壳初始化失败
      this.section = SHELL_SECTION_DOTS;
      this.deepLinkId = '';
    }
  }

  /**
   * 页面重新显示：把一次性 show 信号转给日程面板（由它的 @Watch 消费保存标记 → 重读列表）。
   *
   * 只推进 tick、不在外壳里替面板读盘 / 改筛选：单一事实来源仍是面板自己的 reload()。
   * 不跑定时器、不轮询；show 是页面生命周期的自然一次事件。
   */
  onPageShow(): void {
    this.scheduleShowTick = this.scheduleShowTick + 1;
    // 删实例后返回首页：保活的实例面板靠这个 tick 重读，不显示已删行。
    this.instancesShowTick = this.instancesShowTick + 1;
    // 冷启动请求只在进程第一次生效；这里再调也不会多跑一个周期（无定时器 / 无轮询）。
    homeStartupSync.request();
    // 前台恢复（mod-sync-silence-phase-b）：选 Home.onPageShow 而不是 EntryAbility.onForeground——
    // 这里才有已登记的协调器钩子和配置判据。冷启动刚同步完 / 5 分钟内 / 在途 / 未配置均零周期。
    void this.maybeForegroundSync();
  }

  /** 与冷启动 / 网络恢复共用的唯一「已配置」判据；读盘失败按未配置处理（零周期、零状态写入）。 */
  private async isSyncConfigured(): Promise<boolean> {
    const ctx: common.UIAbilityContext | null = this.abilityContext;
    if (ctx === null) {
      return false;
    }
    try {
      const settings: ScheduleSettings = await settingsStore.load(ctx);
      const input: RepoConfigInput = {
        repoUrl: settings.repoUrl,
        token: settings.token,
        authMode: settings.authMode
      };
      // 隐私阻断不等于未配置：照样进周期，由既有门禁决定能不能推。
      return isRepoConfigured(input);
    } catch {
      return false;
    }
  }

  /** 前台恢复的一次静默周期（冷却 / 配置 / 启动幂等全部在这里收敛）。 */
  private async maybeForegroundSync(): Promise<void> {
    const startup = homeStartupSync.snapshot();
    // 冷启动请求还挂着（桥未就绪）：绝不在前台插一脚，等它自己发一次，避免冷启动双同步。
    if (startup.requested && !startup.attempted) {
      return;
    }
    if (!(await this.isSyncConfigured())) {
      return;
    }
    if (globalRefreshCoordinator.isRefreshing()) {
      return;
    }
    const due: boolean = shouldRunForegroundTrigger({
      configured: true,
      inFlight: false,
      nowMs: Date.now(),
      lastAttemptMs: globalRefreshCoordinator.lastAttemptAt()
    });
    if (!due) {
      return;
    }
    // 唯一周期入口：单飞协调器，不由本方法直接调 runConfiguredCycle。
    await globalRefreshCoordinator.runOnce(undefined, 'foreground');
  }

  /**
   * 网络恢复订阅（mod-sync-silence-phase-b）：只关心默认网络的 transport 真正变化。
   * `register()` 需要 ohos.permission.GET_NETWORK_INFO（已声明在 module.json5）；权限被拒 /
   * 系统服务不可用 / 后台被限制时静默降级——前台触发仍在，不留「假装已监听」的假象。
   */
  private subscribeNetworkRegain(): void {
    try {
      const net: connection.NetConnection = connection.createNetConnection();
      net.on('netCapabilitiesChange', (info: connection.NetCapabilityInfo): void => {
        this.onNetTransportChanged(this.transportOf(info));
      });
      net.on('netLost', (_handle: connection.NetHandle): void => {
        // 断网后回到同一种 transport 也算一次真实变化，允许再次触发。
        this.lastTransport = '';
      });
      net.register((error: BusinessError): void => {
        if (error !== undefined && error !== null) {
          // 订阅失败只降级到前台触发，不写状态行、不弹 toast（这不是同步结果）。
          this.netConnection = null;
        }
      });
      this.netConnection = net;
    } catch {
      this.netConnection = null;
    }
  }

  /** transport 标识只取 bearer 类型号，不含地址 / 凭据；空串表示「没有可用网络」。 */
  private transportOf(info: connection.NetCapabilityInfo): string {
    const bearers: connection.NetBearType[] = info.netCap.bearerTypes;
    if (bearers.length === 0) {
      return '';
    }
    return `bearer-${String(bearers[0])}`;
  }

  /** 事件侧：同类型 / 断开 / 在途一律忽略，真正变化才（重新）武装 2 s debounce。 */
  private onNetTransportChanged(transport: string): void {
    const armed: boolean = shouldArmNetworkDebounce({
      // 配置在定时器触发时再冷读一次；这里无法 await，避免把异步读盘塞进网络回调。
      configured: true,
      inFlight: globalRefreshCoordinator.isRefreshing(),
      transport: transport,
      lastTransport: this.lastTransport
    });
    if (!armed) {
      return;
    }
    if (this.netDebounceTimer !== -1) {
      clearTimeout(this.netDebounceTimer);
      this.netDebounceTimer = -1;
    }
    this.netDebounceTimer = setTimeout((): void => {
      this.netDebounceTimer = -1;
      void this.runNetworkCycle(transport);
    }, NETWORK_DEBOUNCE_MS);
  }

  /** 定时器到期：再查一次配置 / 在途 / 同类型，然后经协调器跑唯一一次周期。 */
  private async runNetworkCycle(transport: string): Promise<void> {
    if (transport === this.lastTransport || globalRefreshCoordinator.isRefreshing()) {
      return;
    }
    if (!(await this.isSyncConfigured())) {
      return;
    }
    if (globalRefreshCoordinator.isRefreshing() || transport === this.lastTransport) {
      return;
    }
    this.lastTransport = transport;
    await globalRefreshCoordinator.runOnce(undefined, 'network');
  }

  /** 页面消失：撤定时器 + unregister，避免页面重建后重复订阅造成泄漏。 */
  aboutToDisappear(): void {
    if (this.netDebounceTimer !== -1) {
      clearTimeout(this.netDebounceTimer);
      this.netDebounceTimer = -1;
    }
    if (this.netConnection !== null) {
      try {
        this.netConnection.unregister((_error: BusinessError): void => {});
      } catch {
        // 已注销 / 订阅本就失败：忽略，不留悬挂引用。
      }
      this.netConnection = null;
    }
  }

  /**
   * 隐藏桥就绪：沿用 `pages/Index.ets` 的 proven 顺序——GitBridgeHost 先交出控制器，
   * `syncController.ensureStarted()` 把内核建好，再消费一次性启动请求。
   *
   * 未就绪不是静默跳过：ensureStarted 抛错 / 完成后 isReady() 仍为 false 都写一条 typed
   * 原因到唯一状态行；不弹 toast、不重试、不建第二把闸。
   */
  private async onBridgeReady(controller: webview.WebviewController): Promise<void> {
    try {
      await syncController.ensureStarted(controller);
    } catch {
      homeStartupSync.onBridgeFail(BRIDGE_NOT_READY_REASON);
      return;
    }
    if (syncController.isReady()) {
      homeStartupSync.onBridgeReady();
    } else {
      homeStartupSync.onBridgeFail(BRIDGE_NOT_READY_REASON);
    }
  }

  /** 桥加载失败：记住原因供下拉周期给出可读文案，并把启动失败落到状态行。 */
  private onBridgeFail(message: string): void {
    syncController.markBridgeFailed(message);
    homeStartupSync.onBridgeFail(BRIDGE_NOT_READY_REASON);
  }

  /**
   * 首页外壳唯一的下拉处理：把整次刷新交给单飞协调器。
   *
   * 不在这里直接调周期、不弹 toast：周期入口、四读回顺序、失败单一落点全在纯层
   * `globalRefreshCoordinator`。与日程面板自己的下拉共享同一把闸与同一份在飞 Promise，
   * 两个手势同时到达时只跑一个周期、四个读回只发生一次；跟随者也 await 到完成结果。
   */
  private async onGlobalPull(): Promise<void> {
    // 外壳下拉的触发名交给协调器；日程面板自己的下拉仍用 Phase A 的 runCycle 内日志，
    // 两条路径各自恰好一行，不重复定义（S5 守卫钉住面板那一行）。
    await globalRefreshCoordinator.runOnce(undefined, 'pull');
  }

  /**
   * 返回键：不在 dots 时先回 dots 并吃掉本次返回；已在 dots 则放行退出。
   * 抽屉开着时先收抽屉，同样吃掉本次返回。
   */
  onBackPress(): boolean {
    if (this.drawerOpen) {
      this.drawerOpen = false;
      return true;
    }
    if (this.section !== SHELL_SECTION_DOTS) {
      this.section = SHELL_SECTION_DOTS;
      return true;
    }
    return false;
  }

  /** Area 的 width/height 静态类型是 Length，显式换算（与 PageLayout.toVp 同口径）。 */
  private toVp(value: Length): number {
    if (typeof value === 'number') {
      return Number.isFinite(value) && value > 0 ? value : 0;
    }
    if (typeof value === 'string') {
      const parsed: number = Number(value);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    }
    return 0;
  }

  /** 面积变化 → 断点；横屏按 uiTokens 规则至少 medium。 */
  private applyArea(area: Area): void {
    const width: number = this.toVp(area.width);
    const height: number = this.toVp(area.height);
    if (width <= 0 || height <= 0) {
      return;
    }
    if (this.contentWidth !== width) {
      this.contentWidth = width;
    }
    const next: string = resolveBreakpoint(width, isLandscapeSize(width, height));
    if (next !== this.breakpoint) {
      this.breakpoint = next;
      // 切到宽屏时抽屉必须收起，否则会留下一个遮住内容的幽灵抽屉
      if (next !== 'compact') {
        this.drawerOpen = false;
      }
    }
  }

  private isCompact(): boolean {
    return this.breakpoint === 'compact';
  }

  /** 选段：统一入口——切分段并关闭抽屉（抽屉里点项 / 面板页头点项都走这里）。 */
  private selectSection(section: ShellSection): void {
    this.section = section;
    this.drawerOpen = false;
  }

  /** 导航条底部齿轮 → 设置页。 */
  private openSettings(): void {
    router
      .pushUrl({ url: 'pages/Settings' })
      .catch(() => {
        promptAction.showToast({ message: '暂时无法打开设置' });
      });
  }

  build() {
    // 首页全局下拉刷新（mod-home-global-refresh）：唯一一层 Refresh 包住整个外壳，
    // 竖屏 Row+rail / 横屏 Row+rail / compact 抽屉三种形态共用同一个手势入口；
    // 面板自己的 Scroll / List 不受影响（Refresh 包的是外壳，不是再包一层内容 Column）。
    Refresh({ refreshing: $$this.globalRefreshing }) {
    // root Stack 只放覆盖层（抽屉蒙层 / 抽屉条 / compact 的 ☰）；flex 切分只有下面这一个 Row。
    Stack({ alignContent: Alignment.TopStart }) {
      Row() {
        // 宽屏：导航条是 Row 的第一个 flex 子项；compact 时不渲染（改走抽屉）。
        if (!this.isCompact()) {
          ShellRail({
            section: this.section,
            onSelect: (next: ShellSection): void => {
              this.selectSection(next);
            },
            onOpenSettings: (): void => {
              this.openSettings();
            },
            compact: false
          })
        }
        // 内容区：唯一的 layoutWeight(1)；四个面板叠放，全部常驻，
        // 只有 active 的那个可见，滚动由各面板自己的 Scroll 承担。
        Stack({ alignContent: Alignment.TopStart }) {
          DotsPane({
            deepLinkId: this.deepLinkId,
            active: this.section === SHELL_SECTION_DOTS,
            globalRefreshTick: this.dotsRefreshTick
          })
          SchedulePane({
            deepLinkId: this.deepLinkId,
            active: this.section === SHELL_SECTION_SCHEDULE,
            showTick: this.scheduleShowTick,
            globalRefreshTick: this.scheduleRefreshTick,
            statusRefreshTick: this.statusRefreshTick
          })
          InstancesPane({
            deepLinkId: this.deepLinkId,
            active: this.section === SHELL_SECTION_INSTANCES,
            showTick: this.instancesShowTick
          })
          CloudChatPane({
            deepLinkId: this.deepLinkId,
            active: this.section === SHELL_SECTION_CLOUD_CHAT,
            globalRefreshTick: this.cloudChatRefreshTick
          })
        }
        .width('100%')
        .height('100%')
        .layoutWeight(1)
      }
      .width('100%')
      .height('100%')

      // compact 抽屉蒙层：点蒙层关闭（不是 Column，是无固定高度的覆盖 Stack）。
      if (this.isCompact() && this.drawerOpen) {
        Stack()
          .width('100%')
          .height('100%')
          .backgroundColor($r('app.color.scrim'))
          .onClick(() => {
            this.drawerOpen = false;
          })
      }
      // compact 分段入口：页头抽成面板自己的组件后，开抽屉的 ☰ 上提到 root Stack，
      // 四个分段都能用它；抽屉展开时隐藏，避免与蒙层重叠。
      if (this.isCompact() && !this.drawerOpen) {
        Text('☰')
          .fontSize(FONT.title)
          .fontColor($r('app.color.text_primary'))
          .width(TOUCH_MIN)
          .height(TOUCH_MIN)
          .textAlign(TextAlign.Center)
          .padding({ left: SPACING.sm, right: SPACING.sm })
          .border({ width: { bottom: DIVIDER }, color: $r('app.color.divider') })
          .onClick(() => {
            this.drawerOpen = true;
          })
      }
      // compact 抽屉本体：挂在 root Stack 上与蒙层同级；Visibility.None 不占布局，
      // 组件保持在树上（选中态不会因开合抽屉丢失）。
      if (this.isCompact()) {
        ShellRail({
          section: this.section,
          onSelect: (next: ShellSection): void => {
            this.selectSection(next);
          },
          onOpenSettings: (): void => {
            this.openSettings();
          },
          compact: true
        })
          .visibility(this.drawerOpen ? Visibility.Visible : Visibility.None)
      }
      // 同步/附件 zip 的隐藏桥（与 proven `pages/Index.ets` 同一份 GitBridgeHost + ensureStarted）：
      // 1×1、全透明、不参与交互；就绪回调先建内核，再放行上面登记的冷启动请求。
      GitBridgeHost({
        onReady: (controller: webview.WebviewController) => {
          this.onBridgeReady(controller);
        },
        onFail: (message: string) => {
          this.onBridgeFail(message);
        }
      })
        .width(BRIDGE_HOST_SIZE)
        .height(BRIDGE_HOST_SIZE)
        .opacity(0)
        .position({ x: 0, y: 0 })
        .hitTestBehavior(HitTestMode.None)
    }
    .width('100%')
    .height('100%')
    .onAreaChange((_oldValue: Area, newValue: Area) => {
      this.applyArea(newValue);
    })
    }
    .onRefreshing(() => {
      this.globalRefreshing = true;
      // 成功 / 失败 / 下游意外 reject 都复位转圈；typed 失败只由状态行渲染，这里不弹 toast。
      this.onGlobalPull()
        .then(() => {
          this.globalRefreshing = false;
        })
        .catch(() => {
          this.globalRefreshing = false;
        });
    })
  }
}
