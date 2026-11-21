/**
 * 远程 DSH 分段占位（mod-shell-schedule-pane / S3 抽壳）。
 *
 * 对外契约（供后续 mod-instance-list 迁入续写）：
 *   - `id: string`：深链携带的实例 id，预留给「按 id 打开指定实例」，当前不消费；
 *   - `active: boolean`：由 Home 按当前分段传入，根 Scroll 据此在 Visible / Hidden 间切换。
 *
 * 本片只做 scaffold：分段标签页头 + 禁用主操作 + 逐字原因 + 「即将迁入」说明，不渲染任何假行。
 * 下一步执行者请把真实实例列表 / 连接操作填进本文件，保留两个 prop 与 Visibility.Hidden 保活接线。
 * TODO(mod-shell-instances-pane): 替换占位为真实远程实例列表与连接入口。
 */
import {
  DIVIDER,
  FONT,
  LINE_HEIGHT,
  SPACING,
  TOUCH_MIN
} from '../../common/uiTokens';

/** 禁用原因（无假入口）。 */
const REASON_REMOTE: string = '远程面板即将迁入';

@Component
export struct InstancesPane {
  /** 深链 id：预留给后续按 id 打开指定实例。 */
  @Prop deepLinkId: string = '';
  /** 保活可见性：Home 当前分段为 instances 时传 true。 */
  @Prop active: boolean = true;

  build() {
    Scroll() {
      Column({ space: SPACING.md }) {
        Row() {
          Text('远程 DSH')
            .fontSize(FONT.title)
            .lineHeight(LINE_HEIGHT.title)
            .fontWeight(FontWeight.Medium)
            .fontColor($r('app.color.text_primary'))
            .layoutWeight(1)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
          Text(`添加实例（${REASON_REMOTE}）`)
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
        Text(REASON_REMOTE)
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
