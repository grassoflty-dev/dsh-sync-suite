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
import { globalRefreshCoordinator, isRepoBlockedStatus } from '../model/homeGlobalRefresh';
import type { RefreshCycleResult } from '../model/homeGlobalRefresh';
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

  aboutToAppear(): void {
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
  }

  /**
   * 首页外壳唯一的下拉处理：把整次刷新交给单飞协调器。
   *
   * 不在这里直接调周期、不弹 toast：周期入口、四读回顺序、失败单一落点全在纯层
   * `globalRefreshCoordinator`。与日程面板自己的下拉共享同一把闸与同一份在飞 Promise，
   * 两个手势同时到达时只跑一个周期、四个读回只发生一次；跟随者也 await 到完成结果。
   */
  private async onGlobalPull(): Promise<void> {
    await globalRefreshCoordinator.runOnce();
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
            active: this.section === SHELL_SECTION_INSTANCES
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
