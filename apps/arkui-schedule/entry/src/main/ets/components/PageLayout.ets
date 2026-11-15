/**
 * 页面骨架：统一标题栏（标题 + 可选副标题 + 可选「更多」）+ 内容区。
 *
 * 设计约束（`docs/UI-DESIGN.md`）：
 * - 白底、无卡片、无阴影；标题栏下一条 1vp 细线；
 * - 标题 20fp / 副标题 14fp / 主操作 1 个（页面自己放，其余收进「更多」）；
 * - 触控目标 ≥ 40vp（返回、「更多」都是 40×40 起的点击区）；
 * - 断点在这里统一算：`onAreaChange` 拿宽度与方向，`resolveBreakpoint(width, landscape)`
 *   → `compact | medium | expanded`。页面**只**按 `breakpoint === 'compact'` 做粗粒度分支，
 *   不要在页面里再各写一套阈值。
 *
 * 为什么 `breakpoint` 既是对外 `@State` 又通过回调通知页面：
 * ArkUI 的父组件读不到子组件的 `@State`，而「单列 vs 双栏」的骨架属于页面。
 * 所以本组件持有权威断点（`@State breakpoint`），变化时通过 `onBreakpointChange`
 * 同步给页面；页面把它存进自己的 `@State`，状态只有一个来源，不会出现两套判断。
 */
import { FONT, LINE_HEIGHT, SPACING, DIVIDER, TOUCH_MIN, RADIUS, resolveBreakpoint, isLandscapeSize } from '../common/uiTokens';

@Component
export struct PageLayout {
  /** 页面标题（一级字号）。 */
  @Prop title: string = '';
  /** 副标题：一句统计 / 一句说明（辅助字号，可空）。 */
  @Prop subtitle: string = '';
  /** 返回回调；为 null 时不显示返回按钮（首页）。 */
  onBack: (() => void) | null = null;
  /** 「更多」回调；为 null 时不显示「更多」入口（详情页用）。 */
  onMore: (() => void) | null = null;
  /** 标题栏右侧动作 1（标签 + 回调；标签为空则不渲染，如 `✨ AI 汇总`）。 */
  headerActionOne: string = '';
  onHeaderActionOne: (() => void) | null = null;
  /** 标题栏右侧动作 2（标签 + 回调；标签为空则不渲染，如 `⚙ 设置`）。 */
  headerActionTwo: string = '';
  onHeaderActionTwo: (() => void) | null = null;
  /** 断点变化回调（页面据此做单列/双栏分支）。参数：断点名 + 内容区宽度(vp)。 */
  onBreakpointChange: ((breakpoint: string, widthVp: number) => void) | null = null;

  /** 默认内容（调用方不传尾随闭包时使用；ArkTS 要求 `@BuilderParam` 有默认值）。 */
  @Builder
  emptyContent() {
  }

  /** 页面内容（尾随闭包传入）。 */
  @BuilderParam content: () => void = this.emptyContent;
  /** 当前断点（权威值，对外只读语义：页面通过回调取同一份）。 */
  @State breakpoint: string = 'compact';
  /** 内容区宽度（vp），双栏页面用它算侧栏宽度。 */
  @State contentWidth: number = 0;

  /** 内容区左右内边距：紧凑 16、宽屏 24（两档都来自令牌）。 */
  private horizontalPadding(): number {
    return this.breakpoint === 'compact' ? SPACING.lg : SPACING.xl;
  }

  /**
   * `Area.width/height` 的静态类型是 `Length`（number 或字符串），直接 `as number` 遇到字符串会得到 0
   * → 断点永远停在 `compact`，横屏就不会出两栏。这里显式转换，非数字一律 0（fail-closed 到单列）。
   */
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

  /**
   * 面积变化 → 重算断点。
   *
   * `breakpoint` 只在真的变了时才 setState（避免布局回路），但回调**每次都会带最新宽度**：
   * 页面除了断点档，还要按内容宽判断「能不能走主从布局」（840vp 门槛），宽度必须实时。
   */
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
    }
    if (this.onBreakpointChange !== null) {
      this.onBreakpointChange(this.breakpoint, width);
    }
  }

  /** 标题栏：可选返回 + 标题/副标题 + 可选「更多」。 */
  @Builder
  TitleBar() {
    Row({ space: SPACING.sm }) {
      if (this.onBack !== null) {
        Text('‹')
          .fontSize(FONT.title)
          .lineHeight(LINE_HEIGHT.title)
          .fontColor($r('app.color.text_primary'))
          .width(TOUCH_MIN)
          .height(TOUCH_MIN)
          .textAlign(TextAlign.Center)
          .borderRadius(RADIUS.none)
          .onClick(() => {
            const handler: (() => void) | null = this.onBack;
            if (handler !== null) {
              handler();
            }
          })
      }
      Column({ space: SPACING.xs }) {
        Text(this.title)
          .fontSize(FONT.title)
          .lineHeight(LINE_HEIGHT.title)
          .fontWeight(FontWeight.Medium)
          .fontColor($r('app.color.text_primary'))
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
          .textAlign(TextAlign.Start)
        if (this.subtitle.length > 0) {
          Text(this.subtitle)
            .fontSize(FONT.caption)
            .lineHeight(LINE_HEIGHT.caption)
            .fontColor($r('app.color.text_secondary'))
            .maxLines(2)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .width('100%')
            .textAlign(TextAlign.Start)
        }
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)

      // 明确的图标动作（替代语义含糊的「更多」）：标签为空则不渲染
      if (this.headerActionOne.length > 0 && this.onHeaderActionOne !== null) {
        Text(this.headerActionOne)
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.brand'))
          .height(TOUCH_MIN)
          .padding({ left: SPACING.sm, right: SPACING.sm })
          .textAlign(TextAlign.Center)
          .onClick(() => {
            const handler: (() => void) | null = this.onHeaderActionOne;
            if (handler !== null) {
              handler();
            }
          })
      }
      if (this.headerActionTwo.length > 0 && this.onHeaderActionTwo !== null) {
        Text(this.headerActionTwo)
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.brand'))
          .height(TOUCH_MIN)
          .padding({ left: SPACING.sm, right: SPACING.sm })
          .textAlign(TextAlign.Center)
          .onClick(() => {
            const handler: (() => void) | null = this.onHeaderActionTwo;
            if (handler !== null) {
              handler();
            }
          })
      }

      if (this.onMore !== null) {
        Text('更多')
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
          .height(TOUCH_MIN)
          .padding({ left: SPACING.md, right: SPACING.md })
          .textAlign(TextAlign.Center)
          .borderRadius(RADIUS.none)
          .onClick(() => {
            const handler: (() => void) | null = this.onMore;
            if (handler !== null) {
              handler();
            }
          })
      }
    }
    .width('100%')
    .alignItems(VerticalAlign.Center)
    .padding({ left: SPACING.sm, right: SPACING.sm, top: SPACING.md, bottom: SPACING.md })
  }

  build() {
    Column() {
      this.TitleBar()
      Divider()
        .strokeWidth(DIVIDER)
        .color($r('app.color.divider'))
      Column() {
        this.content()
      }
      .width('100%')
      .layoutWeight(1)
      .padding({ left: this.horizontalPadding(), right: this.horizontalPadding(), top: SPACING.md })
    }
    .width('100%')
    .height('100%')
    .backgroundColor($r('app.color.page_background'))
    .onAreaChange((_oldValue: Area, newValue: Area) => {
      this.applyArea(newValue);
    })
  }
}
