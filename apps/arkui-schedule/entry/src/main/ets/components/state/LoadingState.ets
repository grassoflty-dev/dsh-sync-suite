/**
 * 加载态（`docs/STATE-UI.md` §4.1）：进度 + 文案 + **可取消**。
 *
 * 为什么不是旧的「转圈 + 一句话」：外部调用（Git / AI / 远程探测）一旦卡住，用户只能杀 App。
 * 这里自己用 `setInterval` 累计 `elapsedMs`，**到 `CANCEL_AFTER_MS`（model 提供，组件不写字面量 3000）
 * 才渲染「取消」**——太早给取消，用户会把「等一下」当成「坏了」。
 *
 * 两条硬约束：
 * 1. `aboutToDisappear` 必须 `clearInterval`（组件离场后还改 `@State` 就是泄漏/告警）；
 * 2. 点了取消**只切文案「正在取消…」**，不自行把页面置回空闲、不假装成功——是否结束由页面在
 *    `onCancel` 里决定（外部动作可能还在收尾，提前复位会造成「界面说好了、实际没停」）。
 */
import { loadingText } from '../../common/copy';
import { FONT, LINE_HEIGHT, RADIUS, SPACING, TOUCH_MIN } from '../../common/uiTokens';
import { CANCEL_AFTER_MS, canCancelLoading, progressText } from '../../model/stateView';

/** 计时器步长（毫秒）：500ms 足够让「取消」在阈值附近出现，又不至于频繁重绘。 */
const TICK_MS: number = 500;

/** 转圈直径（vp）：借用标题字号，不额外引入尺寸令牌。 */
const SPINNER_SIZE: number = FONT.title;

/** 取消按钮文字。 */
const CANCEL_LABEL: string = '取消';

/** 已点取消后的文案（止于「正在取消」，不预设结果）。 */
const CANCELLING_TEXT: string = '正在取消…';

@Component
export struct LoadingState {
  /** 主文案；空则回落 `loadingText('')`（「正在加载…」）。 */
  @Prop title: string = '';
  /** 次要说明（例如「正在读取 Git 状态」）；空则不渲染该行。 */
  @Prop detail: string = '';
  /** 进度百分比 `0..100`；`-1`（或任意负数）= 不确定进度，不显示百分比。 */
  @Prop progress: number = -1;
  /** `true` = 行内小条（表单里），`false` = 整块居中。 */
  @Prop compact: boolean = false;

  /** 取消回调；`null` = 这个动作不允许取消（不渲染取消按钮、也不起计时器）。 */
  onCancel: (() => void) | null = null;

  /** 已累计的加载时长（毫秒），由计时器累加。 */
  @State elapsedMs: number = 0;
  /** 是否已点过取消（文案切「正在取消…」且不再重复触发回调）。 */
  @State cancelling: boolean = false;

  /** `setInterval` 句柄；`-1` = 没有在跑的计时器。 */
  private timerId: number = -1;

  aboutToAppear(): void {
    this.startTimer();
  }

  aboutToDisappear(): void {
    this.stopTimer();
  }

  /** 起计时器（只在允许取消、且当前没有计时器时起）。 */
  private startTimer(): void {
    if (this.onCancel === null || this.timerId !== -1) {
      return;
    }
    this.timerId = setInterval(() => {
      this.elapsedMs = this.elapsedMs + TICK_MS;
      if (this.elapsedMs >= CANCEL_AFTER_MS) {
        // 到达阈值后停止累计：取消按钮已经出现，再跳动只是白耗电。
        this.stopTimer();
      }
    }, TICK_MS);
  }

  /** 停计时器（幂等：没有计时器时什么也不做）。 */
  private stopTimer(): void {
    if (this.timerId === -1) {
      return;
    }
    clearInterval(this.timerId);
    this.timerId = -1;
  }

  /** 是否显示取消按钮：有回调 + 已过阈值 + 还没点过。 */
  private canCancel(): boolean {
    return this.onCancel !== null && this.cancelling !== true && canCancelLoading(this.elapsedMs);
  }

  /** 主文案：调用方没给就用 `copy.loadingText('')`，绝不空标题。 */
  private titleText(): string {
    const given: string = this.title.trim();
    return given.length > 0 ? given : loadingText('');
  }

  /** 状态行文案：已点取消 → 「正在取消…」；有进度 → 进度文案；否则空（不渲染）。 */
  private statusText(): string {
    if (this.cancelling) {
      return CANCELLING_TEXT;
    }
    if (this.progress >= 0) {
      return progressText(this.progress);
    }
    return '';
  }

  /** 点取消：先切文案并停表，再通知页面（不自行复位）。 */
  private handleCancel(): void {
    if (this.cancelling) {
      return;
    }
    this.cancelling = true;
    this.stopTimer();
    const handler: (() => void) | null = this.onCancel;
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

  /** 主文案（整块用正文级，行内用辅助级）。 */
  @Builder
  TitleLine() {
    Text(this.titleText())
      .fontSize(this.compact ? FONT.caption : FONT.body)
      .lineHeight(this.compact ? LINE_HEIGHT.caption : LINE_HEIGHT.body)
      .fontColor($r('app.color.text_secondary'))
      .width('100%')
      .textAlign(this.compact ? TextAlign.Start : TextAlign.Center)
  }

  /** 状态行：进度百分比 / 「正在取消…」；两者都没有则不渲染。 */
  @Builder
  StatusLine() {
    if (this.statusText().length > 0) {
      Text(this.statusText())
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontColor($r('app.color.text_primary'))
        .width('100%')
        .textAlign(this.compact ? TextAlign.Start : TextAlign.Center)
    }
  }

  /** 说明行：`detail` 为空、或已在取消中，则不渲染（不叠加两套说法）。 */
  @Builder
  DetailLine() {
    if (this.detail.length > 0 && this.cancelling !== true) {
      Text(this.detail)
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontColor($r('app.color.text_secondary'))
        .width('100%')
        .textAlign(this.compact ? TextAlign.Start : TextAlign.Center)
    }
  }

  /** 取消按钮：只有过了 `CANCEL_AFTER_MS` 才出现。 */
  @Builder
  CancelButton() {
    if (this.canCancel()) {
      Button(CANCEL_LABEL)
        .height(TOUCH_MIN)
        .fontSize(FONT.body)
        .fontColor($r('app.color.brand'))
        .backgroundColor($r('app.color.brand_soft'))
        .borderRadius(RADIUS.sm)
        .padding({ left: SPACING.lg, right: SPACING.lg })
        .onClick(() => this.handleCancel())
    }
  }

  build() {
    Column({ space: this.compact ? SPACING.xs : SPACING.sm }) {
      if (this.compact) {
        Row({ space: SPACING.sm }) {
          this.Spinner()
          this.TitleLine()
        }
        .width('100%')
        .alignItems(VerticalAlign.Center)
      } else {
        this.Spinner()
        this.TitleLine()
      }
      this.StatusLine()
      this.DetailLine()
      this.CancelButton()
    }
    .width('100%')
    .alignItems(this.compact ? HorizontalAlign.Start : HorizontalAlign.Center)
    .justifyContent(FlexAlign.Center)
    .padding({
      top: this.compact ? SPACING.xs : SPACING.xl,
      bottom: this.compact ? SPACING.xs : SPACING.xl,
      left: this.compact ? 0 : SPACING.lg,
      right: this.compact ? 0 : SPACING.lg
    })
  }
}
