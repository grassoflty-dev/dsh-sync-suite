/**
 * dots 分段占位（mod-shell-schedule-pane / S3 抽壳）。
 *
 * 对外契约（供后续 mod-dots-readonly / mod-dots-commands 续写）：
 *   - `id: string`：深链携带的会话 id，预留给「按 id 打开指定 dots 会话」，当前不消费；
 *   - `active: boolean`：由 Home 按当前分段传入，根 Scroll 据此在 Visible / Hidden 间切换。
 *
 * 本片只做 scaffold：标题 + 空聊天气态 + 禁用输入框 + 逐字原因，不渲染任何假行。
 * 下一步执行者请把真实 body 填进本文件，保留两个 prop 与 Visibility.Hidden 保活接线。
 * TODO(mod-shell-dots-pane): 替换占位为真实 dots 会话列表与指令入口。
 */
import {
  DIVIDER,
  FONT,
  LINE_HEIGHT,
  SPACING,
  TOUCH_MIN
} from '../../common/uiTokens';

/** 禁用原因（无假入口：输入框与动作都禁用并写出原因）。 */
const REASON_DOTS: string = 'dots 尚未接线';

@Component
export struct DotsPane {
  /** 深链 id：预留给后续按 id 打开指定 dots 会话。 */
  @Prop id: string = '';
  /** 保活可见性：Home 当前分段为 dots 时传 true。 */
  @Prop active: boolean = true;

  build() {
    Scroll() {
      Column({ space: SPACING.md }) {
        Row() {
          Text('dots')
            .fontSize(FONT.title)
            .lineHeight(LINE_HEIGHT.title)
            .fontWeight(FontWeight.Medium)
            .fontColor($r('app.color.text_primary'))
            .layoutWeight(1)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
          Text(`新建对话（${REASON_DOTS}）`)
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
    .visibility(this.active ? Visibility.Visible : Visibility.Hidden)
  }
}
