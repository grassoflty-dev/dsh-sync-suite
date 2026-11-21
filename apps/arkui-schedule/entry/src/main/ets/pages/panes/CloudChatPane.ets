/**
 * 云端对话分段占位（mod-shell-schedule-pane / S3 抽壳）。
 *
 * 对外契约（供后续 mod-cloud-chat-sync 迁入续写）：
 *   - `id: string`：深链携带的会话 id，预留给「按 id 打开指定云端会话」，当前不消费；
 *   - `active: boolean`：由 Home 按当前分段传入，根 Scroll 据此在 Visible / Hidden 间切换。
 *
 * 本片只做 scaffold：分段标签页头 + 禁用主操作 + 逐字原因 + 「即将迁入」说明，不渲染任何假行。
 * 下一步执行者请把真实只读会话列表 / 详情填进本文件，保留两个 prop 与 Visibility.Hidden 保活接线。
 * TODO(mod-shell-cloud-chat-pane): 替换占位为真实云端会话列表与只读详情。
 */
import {
  DIVIDER,
  FONT,
  LINE_HEIGHT,
  SPACING,
  TOUCH_MIN
} from '../../common/uiTokens';

/** 禁用原因（无假入口）。 */
const REASON_CLOUD: string = '云端对话即将迁入';

@Component
export struct CloudChatPane {
  /** 深链 id：预留给后续按 id 打开指定云端会话。 */
  @Prop id: string = '';
  /** 保活可见性：Home 当前分段为 cloudChat 时传 true。 */
  @Prop active: boolean = true;

  build() {
    Scroll() {
      Column({ space: SPACING.md }) {
        Row() {
          Text('云端对话')
            .fontSize(FONT.title)
            .lineHeight(LINE_HEIGHT.title)
            .fontWeight(FontWeight.Medium)
            .fontColor($r('app.color.text_primary'))
            .layoutWeight(1)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
          Text(`新建对话（${REASON_CLOUD}）`)
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
        Text(REASON_CLOUD)
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
