/**
 * 空态（`docs/STATE-UI.md` §4.2）：**一句说明 + 一个下一步按钮**。
 *
 * 空态最坏的形态是「暂无数据」四个字——用户既不知道发生了什么，也没有出路。
 * 因此本组件硬约束：**永远渲染按钮**。`actionLabel` 为空时回落「刷新」（`onAction` 仍然是页面给的
 * 真回调，不给假动作）；标题为空时回落 `copy.emptyText('')`，绝不出现空标题。
 *
 * 视觉与旧 `components/StateView.ets` 的 empty 形态一致：白底、无卡片、居中（`compact` 时行内左对齐）。
 */
import { emptyText } from '../../common/copy';
import { FONT, LINE_HEIGHT, SPACING } from '../../common/uiTokens';
import { ActionButton } from '../ActionButton';

/** `actionLabel` 为空时的兜底按钮文字（空态必须有出路）。 */
const FALLBACK_ACTION_LABEL: string = '刷新';

@Component
export struct EmptyState {
  /** 主文案（「暂无日程」这类）；空则回落 `emptyText('')`。 */
  @Prop title: string = '';
  /** 次要说明（「点右上角新建」这类）；空则不渲染该行。 */
  @Prop detail: string = '';
  /** 动作按钮文字（「换个区间」/「去填地址」）；空则回落「刷新」。 */
  @Prop actionLabel: string = '';
  /** `true` = 行内小条（表单里），`false` = 整块居中。 */
  @Prop compact: boolean = false;

  /** 动作回调（按钮永远存在，所以这里要有真动作；默认空实现只用于挂载过渡）。 */
  onAction: () => void = () => {};

  /** 主文案：调用方没给就用 `copy.emptyText('')`（「暂无内容」），绝不空标题。 */
  private titleText(): string {
    const given: string = this.title.trim();
    return given.length > 0 ? given : emptyText('');
  }

  /** 按钮文字：调用方没给就回落「刷新」——空态不允许没有按钮。 */
  private actionText(): string {
    const given: string = this.actionLabel.trim();
    return given.length > 0 ? given : FALLBACK_ACTION_LABEL;
  }

  /** 触发动作（按钮永远可点，回调取值期间固定一次）。 */
  private invokeAction(): void {
    this.onAction();
  }

  @Builder
  TitleLine() {
    Text(this.titleText())
      .fontSize(this.compact ? FONT.caption : FONT.body)
      .lineHeight(this.compact ? LINE_HEIGHT.caption : LINE_HEIGHT.body)
      .fontColor($r('app.color.text_primary'))
      .width('100%')
      .textAlign(this.compact ? TextAlign.Start : TextAlign.Center)
  }

  @Builder
  DetailLine() {
    if (this.detail.length > 0) {
      Text(this.detail)
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontColor($r('app.color.text_secondary'))
        .width('100%')
        .textAlign(this.compact ? TextAlign.Start : TextAlign.Center)
    }
  }

  build() {
    Column({ space: this.compact ? SPACING.xs : SPACING.sm }) {
      this.TitleLine()
      this.DetailLine()
      ActionButton({
        label: this.actionText(),
        actionEnabled: true,
        disabledReason: '',
        busy: false,
        variant: 'primary',
        block: !this.compact,
        onTap: (): void => {
          this.invokeAction();
        },
        onBlockedTap: null
      })
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
