/**
 * 外壳主页（mod-shell-rail / S2）：左侧导航条 + 右侧内容区。
 *
 * ## 布局（唯一一层 flex 分割）
 * `Row { ShellRail(...), Stack (panes).layoutWeight(1) }` —— 整页只有这一处
 * 用 `layoutWeight` 做横向切分；内容区是一个 **Stack**（不是固定高度 Column），
 * 四个分段面板叠放其中，各自内部用自己的 `Scroll` 承载滚动。没有嵌套的
 * 固定高度 Column 去包住内容区，也没有 PageLayout 那种「固定页头 + 内容」
 * 的外壳（那会多出一层 flex）。内容区自身 `.height('100%')` 撑满，滚动归面板。
 *
 * ## 分段保活（keep-alive）
 * 四个 `@Builder` 面板在 Stack 里**全部实例化**，从不写 `if/else` 条件渲染；
 * 非当前分段通过 `.visibility(active ? Visibility.Visible : Visibility.Hidden)`
 * 隐藏（Hidden 仍留在组件树上，不卸载）。因此每个面板自己的 `@State`、
 * 滚动位置、选中态在切换分段后仍然存在。S3 把占位换成真实 body 时必须保留这个
 * `active -> Visibility` 的接线。
 *
 * ## 断点 / 抽屉
 * 与 `Index.ets` / `PageLayout.ets` 同一套机制：根容器 `onAreaChange` 拿宽高，
 * `resolveBreakpoint(width, isLandscapeSize(width, height))` 算断点并存入 `@State`；
 * 页面只按 `breakpoint === 'compact'` 分支（横屏按全局规则至少 medium）。
 * compact 下导航条从 Row 里撤出，改为 root Stack 上的抽屉：面板页头左侧 ☰ 打开，
 * 点分段或点蒙层关闭；抽屉里的 ShellRail 用 `Visibility.None` 挂起（不占布局）。
 *
 * ## 返回
 * `onBackPress()`：当前不在 dots 时先回 dots 并吃掉本次返回（true）；
 * 已在 dots 则放行（false），由系统退出。
 *
 * ## 深链
 * `aboutToAppear()` 读 `router.getParams()` 的可选 `section` / `id`。
 * `section` 只认 S1 的四个合法 id（`dots / schedule / instances / cloudChat`），
 * 其余回落 dots；`id` 原样传给每个面板 builder（当前占位不用，留给 S3/S4）。
 *
 * ## S1 接线
 * 直接使用 S1 的 `components/shell/ShellRail.ets`：`ShellSection` 的四个 id
 * 与 S1 常量共用同一份真值，不在页面里复制字符串。抽屉容器由本页拥有，
 * ShellRail 只通过 section/onSelect/onOpenSettings/compact 四个 props 交互。
 */
import { promptAction, router } from '@kit.ArkUI';
import {
  DIVIDER,
  FONT,
  LINE_HEIGHT,
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

// ---------------------------------------------------------------- 外壳页面

/** 四个面板的禁用原因（无假入口：按钮与输入框都禁用并写出原因）。 */
const REASON_DOTS: string = 'dots 尚未接线';
const REASON_SCHEDULE: string = '日程正文即将迁入';
const REASON_REMOTE: string = '远程面板即将迁入';
const REASON_CLOUD: string = '云端对话即将迁入';

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
  /** 深链携带的 id，原样传给面板 builder（S3/S4 再消费）。 */
  @State deepLinkId: string = '';
  /** 断点（与 Index 一致：onAreaChange + resolveBreakpoint）。 */
  @State breakpoint: string = 'compact';
  /** 内容区宽度（vp），预留给 S3 的双栏 body。 */
  @State contentWidth: number = 0;
  /** compact 抽屉是否展开。 */
  @State drawerOpen: boolean = false;

  aboutToAppear(): void {
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

  /** 面板页头：左侧分段名（compact 时前面加 ☰），右侧禁用的主操作槽 + 原因。 */
  @Builder
  PaneHeader(title: string, actionLabel: string, reason: string) {
    Row() {
      if (this.isCompact()) {
        Text('☰')
          .fontSize(FONT.title)
          .fontColor($r('app.color.text_primary'))
          .width(TOUCH_MIN)
          .height(TOUCH_MIN)
          .textAlign(TextAlign.Center)
          .onClick(() => {
            this.drawerOpen = true;
          })
      }
      Text(title)
        .fontSize(FONT.title)
        .lineHeight(LINE_HEIGHT.title)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('app.color.text_primary'))
        .layoutWeight(1)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
      Text(`${actionLabel}（${reason}）`)
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontColor($r('app.color.text_secondary'))
        .height(TOUCH_MIN)
        .padding({ left: SPACING.sm, right: SPACING.sm })
        .enabled(false)
    }
    .width('100%')
    .alignItems(VerticalAlign.Center)
    .border({ width: { bottom: DIVIDER }, color: $r('app.color.divider') })
  }

  /** dots：空聊天气态 —— 标题 + 一行 dots 能做什么 + 禁用的输入 + 明确原因。 */
  @Builder
  DotsPane(id: string, active: boolean) {
    // id 预留给 S3/S4（深链打开指定 dots 会话）；当前占位不消费。
    Scroll() {
      Column({ space: SPACING.md }) {
        this.PaneHeader('dots', '新建对话', REASON_DOTS)
        Text('还没有 dots 对话')
          .fontSize(FONT.title)
          .lineHeight(LINE_HEIGHT.title)
          .fontWeight(FontWeight.Medium)
          .fontColor($r('app.color.text_primary'))
          .width('100%')
        Text('dots 可查看实例并对会话发指令，所有操作需你确认。')
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
          .width('100%')
        TextInput({ placeholder: '输入给 dots 的指令…' })
          .width('100%')
          .height(TOUCH_MIN)
          .fontSize(FONT.body)
          .enabled(false)
        Text(REASON_DOTS)
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
          .width('100%')
      }
      .width('100%')
      .padding({ left: SPACING.lg, right: SPACING.lg, top: SPACING.md, bottom: SPACING.xl })
    }
    .width('100%')
    .height('100%')
    .visibility(active ? Visibility.Visible : Visibility.Hidden)
  }

  /** 日程（SHELL_SECTION_SCHEDULE）：占位，无假行。 */
  @Builder
  SchedulePane(id: string, active: boolean) {
    // id 预留给 S3/S4；当前占位不消费。
    Scroll() {
      Column({ space: SPACING.md }) {
        this.PaneHeader('日程', '新建日程', REASON_SCHEDULE)
        Text('日程')
          .fontSize(FONT.title)
          .lineHeight(LINE_HEIGHT.title)
          .fontWeight(FontWeight.Medium)
          .fontColor($r('app.color.text_primary'))
          .width('100%')
        Text('日程列表与操作即将迁入，本页暂不展示任何记录。')
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
          .width('100%')
      }
      .width('100%')
      .padding({ left: SPACING.lg, right: SPACING.lg, top: SPACING.md, bottom: SPACING.xl })
    }
    .width('100%')
    .height('100%')
    .visibility(active ? Visibility.Visible : Visibility.Hidden)
  }

  /** 远程 DSH（SHELL_SECTION_INSTANCES）：占位，无假行。 */
  @Builder
  RemotePane(id: string, active: boolean) {
    // id 预留给 S3/S4；当前占位不消费。
    Scroll() {
      Column({ space: SPACING.md }) {
        this.PaneHeader('远程 DSH', '添加实例', REASON_REMOTE)
        Text('远程 DSH')
          .fontSize(FONT.title)
          .lineHeight(LINE_HEIGHT.title)
          .fontWeight(FontWeight.Medium)
          .fontColor($r('app.color.text_primary'))
          .width('100%')
        Text('实例列表与连接操作即将迁入，本页暂不展示任何记录。')
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
          .width('100%')
      }
      .width('100%')
      .padding({ left: SPACING.lg, right: SPACING.lg, top: SPACING.md, bottom: SPACING.xl })
    }
    .width('100%')
    .height('100%')
    .visibility(active ? Visibility.Visible : Visibility.Hidden)
  }

  /** 云端对话（SHELL_SECTION_CLOUD_CHAT）：占位，无假行。 */
  @Builder
  ChatPane(id: string, active: boolean) {
    // id 预留给 S3/S4；当前占位不消费。
    Scroll() {
      Column({ space: SPACING.md }) {
        this.PaneHeader('云端对话', '新建对话', REASON_CLOUD)
        Text('云端对话')
          .fontSize(FONT.title)
          .lineHeight(LINE_HEIGHT.title)
          .fontWeight(FontWeight.Medium)
          .fontColor($r('app.color.text_primary'))
          .width('100%')
        Text('会话列表与只读详情即将迁入，本页暂不展示任何记录。')
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
          .width('100%')
      }
      .width('100%')
      .padding({ left: SPACING.lg, right: SPACING.lg, top: SPACING.md, bottom: SPACING.xl })
    }
    .width('100%')
    .height('100%')
    .visibility(active ? Visibility.Visible : Visibility.Hidden)
  }

  build() {
    // root Stack 只放覆盖层（抽屉蒙层 / 抽屉条）；flex 切分只有下面这一个 Row。
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
          this.DotsPane(this.deepLinkId, this.section === SHELL_SECTION_DOTS)
          this.SchedulePane(this.deepLinkId, this.section === SHELL_SECTION_SCHEDULE)
          this.RemotePane(this.deepLinkId, this.section === SHELL_SECTION_INSTANCES)
          this.ChatPane(this.deepLinkId, this.section === SHELL_SECTION_CLOUD_CHAT)
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
}
