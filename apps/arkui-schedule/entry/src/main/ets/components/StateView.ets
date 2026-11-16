/**
 * 三态视图：loading / empty / error(+重试)，替代原来的 `EmptyState`（后者保留导出、内部转调本组件）。
 *
 * 设计（`docs/UI-DESIGN.md` + `docs/CONTRACT.md` §3.4）：
 * - **白底、无卡片、无阴影、无 emoji 大图标**；字号只用 `FONT` 三级，间距只用 `SPACING` 五档；
 * - 颜色一律走 `$r('app.color.*')` 资源（`resources/dark` 已覆盖，因此自动跟随深色模式）；
 * - 触控目标：动作按钮高度取 `TOUCH_MIN`（40vp），小于它就必须补 padding；
 * - 文案由 `common/copy.ts` 统一产出（`loadingText` / `emptyText` / `errorText`），
 *   组件**不自己拼错误码**，避免各页面文案再次漂移。
 *
 * 三种形态：
 * | kind | 视觉 | 交互 |
 * |---|---|---|
 * | `loading` | `LoadingProgress` + 灰字说明，居中（`compact` 时行内） | 无（加载中不给按钮） |
 * | `empty` | 正文标题 + 辅助说明 | 可选主操作（`retryLabel` 作按钮文字） |
 * | `error` | **`danger` 色**标题 + 说明 | 有 `onRetry` 时给「重试」按钮 |
 *
 * `compact` 的语义：`false` = 整页/整块居中（带上下 `SPACING.xl` 留白，供页面空态用）；
 * `true` = 行内小条（左对齐、上下 `SPACING.xs`，供表单里「正在准备存储…」「读取失败 + 重试」这类局部状态用）。
 *
 * 契约：共享层组件 —— 不含任何手写/OCR/PixelMap 代码，Android 与 HarmonyOS 都能编译
 * （validate 规则 4/5：不得引用鸿蒙专属模块，也不得带 `@crossplatform`）。
 */
import { loadingText, retryText } from '../common/copy';
import { FONT, LINE_HEIGHT, RADIUS, SPACING, TOUCH_MIN } from '../common/uiTokens';

/**
 * 加载指示圈直径（vp）。
 *
 * 借用标题字号（20vp）而不是再引入一个尺寸令牌：既保证与标题同高、视觉对齐，
 * 又不违反「尺寸只有令牌里那些档」的约定。
 */
const SPINNER_SIZE: number = FONT.title;

@Component
export struct StateView {
  /** 形态：`'loading' | 'empty' | 'error'`（未知值按 `empty` 处理，fail-safe）。 */
  @Prop kind: string = 'empty';
  /** 主文案（标题级）；空则按形态给默认文案（见 `displayTitle()`）。 */
  @Prop title: string = '';
  /** 次要说明（辅助级）；空则不渲染该行。 */
  @Prop detail: string = '';
  /**
   * 动作按钮标签；空则无按钮。
   *
   * 例外：`error` 形态下若给了 `onRetry` 但标签为空，回落「重试」——错误态必须有出路，
   * 不允许出现「报错了但点不了」的死界面。
   */
  @Prop retryLabel: string = '';
  /** 动作回调；为 null 时即使有标签也不渲染按钮（调用方明确表示「不给出口」）。 */
  onRetry: (() => void) | null = null;
  /** `true` = 行内小块（左对齐、紧凑留白）；`false` = 整页居中。 */
  @Prop compact: boolean = false;

  private isLoading(): boolean {
    return this.kind === 'loading';
  }

  private isError(): boolean {
    return this.kind === 'error';
  }

  /** 主文案：调用方没给就按形态兜底（绝不显示空标题）。 */
  private displayTitle(): string {
    if (this.title.length > 0) {
      return this.title;
    }
    if (this.isLoading()) {
      return loadingText('');
    }
    if (this.isError()) {
      return '操作失败';
    }
    return '暂无内容';
  }

  /** 标题颜色：错误 `danger`、加载 `text_secondary`、空态 `text_primary`。 */
  private titleColor(): Resource {
    if (this.isError()) {
      return $r('app.color.danger');
    }
    if (this.isLoading()) {
      return $r('app.color.text_secondary');
    }
    return $r('app.color.text_primary');
  }

  /** 标题字号：紧凑行内用辅助级，整块用正文级（模板里没有第四级字号）。 */
  private titleFontSize(): number {
    return this.compact ? FONT.caption : FONT.body;
  }

  /** 标题行高：与 `titleFontSize()` 一一对应。 */
  private titleLineHeight(): number {
    return this.compact ? LINE_HEIGHT.caption : LINE_HEIGHT.body;
  }

  /** 标题字重：错误态加粗一档，让「出事了」在扫读时先被看到。 */
  private titleWeight(): FontWeight {
    return this.isError() ? FontWeight.Medium : FontWeight.Normal;
  }

  /** 对齐方式：整块居中、行内左对齐。 */
  private contentAlign(): HorizontalAlign {
    return this.compact ? HorizontalAlign.Start : HorizontalAlign.Center;
  }

  /** 文字对齐：与 `contentAlign()` 保持一致（Text 需要单独设 TextAlign）。 */
  private textAlignValue(): TextAlign {
    return this.compact ? TextAlign.Start : TextAlign.Center;
  }

  /** 按钮标签：空标签在错误态回落「重试」，其它形态为空（= 不渲染按钮）。 */
  private actionLabel(): string {
    if (this.retryLabel.length > 0) {
      return this.retryLabel;
    }
    return this.isError() ? retryText('') : '';
  }

  /** 是否渲染动作按钮：既要有出口（onRetry 非空），也要有文案。 */
  private hasAction(): boolean {
    return this.onRetry !== null && this.actionLabel().length > 0;
  }

  /** 按钮背景：错误态用 `brand_soft`（次要动作），空态主操作直接用 `brand`。 */
  private actionBackground(): Resource {
    return this.isError() ? $r('app.color.brand_soft') : $r('app.color.brand');
  }

  /** 按钮文字色：与背景配对（`brand` 底用 `text_inverse`）。 */
  private actionFontColor(): Resource {
    return this.isError() ? $r('app.color.brand') : $r('app.color.text_inverse');
  }

  /** 触发动作（回调可能被容器换掉，取值期间固定住一次）。 */
  private invokeRetry(): void {
    const handler: (() => void) | null = this.onRetry;
    if (handler !== null) {
      handler();
    }
  }

  // ------------------------------------------------------------------ UI

  /** 加载指示圈。 */
  @Builder
  Spinner() {
    LoadingProgress()
      .width(SPINNER_SIZE)
      .height(SPINNER_SIZE)
      .color($r('app.color.brand'))
  }

  /** 标题行（三种形态共用，颜色/字号/对齐由私有方法决定）。 */
  @Builder
  TitleLine() {
    Text(this.displayTitle())
      .fontSize(this.titleFontSize())
      .lineHeight(this.titleLineHeight())
      .fontWeight(this.titleWeight())
      .fontColor(this.titleColor())
      .width('100%')
      .textAlign(this.textAlignValue())
  }

  /** 说明行：detail 为空时整行不渲染（不留空白）。 */
  @Builder
  DetailLine() {
    if (this.detail.length > 0) {
      Text(this.detail)
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontColor($r('app.color.text_secondary'))
        .width('100%')
        .textAlign(this.textAlignValue())
    }
  }

  /** 动作按钮：高度 `TOUCH_MIN`，圆角 `RADIUS.sm`（与全站按钮一致）。 */
  @Builder
  ActionButton() {
    if (this.hasAction()) {
      Button(this.actionLabel())
        .height(TOUCH_MIN)
        .fontSize(FONT.body)
        .backgroundColor(this.actionBackground())
        .fontColor(this.actionFontColor())
        .borderRadius(RADIUS.sm)
        .padding({ left: SPACING.lg, right: SPACING.lg })
        .onClick(() => this.invokeRetry())
    }
  }

  /** 行内加载态：圈 + 文案横向排列（紧凑，供表单/列表行内用）。 */
  @Builder
  InlineLoading() {
    Row({ space: SPACING.sm }) {
      this.Spinner()
      Text(this.displayTitle())
        .fontSize(this.titleFontSize())
        .lineHeight(this.titleLineHeight())
        .fontColor(this.titleColor())
        .layoutWeight(1)
        .textAlign(this.textAlignValue())
    }
    .width('100%')
    .alignItems(VerticalAlign.Center)
  }

  /** 整块加载态：圈在上、文案在下（居中）。 */
  @Builder
  BlockLoading() {
    Column({ space: SPACING.sm }) {
      this.Spinner()
      this.TitleLine()
    }
    .width('100%')
    .alignItems(HorizontalAlign.Center)
  }

  build() {
    Column({ space: this.compact ? SPACING.xs : SPACING.sm }) {
      if (this.isLoading()) {
        if (this.compact) {
          this.InlineLoading()
        } else {
          this.BlockLoading()
        }
      } else {
        this.TitleLine()
        this.DetailLine()
        this.ActionButton()
      }
    }
    .width('100%')
    .alignItems(this.contentAlign())
    .justifyContent(FlexAlign.Center)
    .padding({
      top: this.compact ? SPACING.xs : SPACING.xl,
      bottom: this.compact ? SPACING.xs : SPACING.xl,
      left: this.compact ? 0 : SPACING.lg,
      right: this.compact ? 0 : SPACING.lg
    })
  }
}
