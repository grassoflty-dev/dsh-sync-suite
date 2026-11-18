/**
 * 设置页各 section 共用的「字段行」构件（A2 拆分时从 `pages/Settings.ets` 逐字搬出）。
 *
 * 为什么放在这里：`FieldLabel` / `ErrorText` / `HintLine` / `FieldNote` 被 4 个 section 同时使用，
 * 复制 5 份必然漂移（字号/颜色/是否省略号是验收项，见 `docs/UI-DESIGN.md` §8）。
 *
 * 纯展示：只读入参，不碰任何状态、不 import services。样式与拆分前完全一致：
 * - `FieldLabel`：caption + text_secondary，字段标题；
 * - `ErrorText`：caption + **danger**（`settingsFormValidation` 守卫：逐字段红字不许退回灰字）；
 * - `HintLine`：caption + text_secondary + `maxLines(1)` + 省略号（状态/提示一行就够）；
 * - `FieldNote`：caption + text_secondary，**可换行、不省略**（字段语义说明要能读完）。
 *
 * 各 section 里保留同名的一行 `@Builder` 转发，是为了让调用点（`this.FieldLabel(...)`）与
 * 拆分前逐字一致 —— 纯重构，不改可观察行为，也不给静态守卫测试制造假阴性。
 */
import { FONT, LINE_HEIGHT } from '../../common/uiTokens';

/** 字段标题（caption 灰字，占满一行、左对齐）。 */
@Builder
export function FieldLabel(text: string) {
  Text(text)
    .fontSize(FONT.caption)
    .lineHeight(LINE_HEIGHT.caption)
    .fontColor($r('app.color.text_secondary'))
    .width('100%')
    .textAlign(TextAlign.Start)
}

/** 字段内联错误：danger 令牌（深色模式同样可见），与灰色说明文字区分开。 */
@Builder
export function ErrorText(text: string) {
  Text(text)
    .fontSize(FONT.caption)
    .lineHeight(LINE_HEIGHT.caption)
    .fontColor($r('app.color.danger'))
    .width('100%')
    .textAlign(TextAlign.Start)
}

/** 一行说明（超长省略，完整内容进 `?`）。 */
@Builder
export function HintLine(text: string) {
  Text(text)
    .fontSize(FONT.caption)
    .lineHeight(LINE_HEIGHT.caption)
    .fontColor($r('app.color.text_secondary'))
    .maxLines(1)
    .textOverflow({ overflow: TextOverflow.Ellipsis })
    .width('100%')
    .textAlign(TextAlign.Start)
}

/**
 * 字段语义说明（标题下一行小字，**可换行、不省略**）。
 *
 * 与 `HintLine` 的分工：`HintLine` 是「状态/提示」一行就够；
 * 字段「到底影响什么」必须能完整读下去（设备标识这一条换行是必要的）。
 */
@Builder
export function FieldNote(text: string) {
  Text(text)
    .fontSize(FONT.caption)
    .lineHeight(LINE_HEIGHT.caption)
    .fontColor($r('app.color.text_secondary'))
    .width('100%')
    .textAlign(TextAlign.Start)
}
