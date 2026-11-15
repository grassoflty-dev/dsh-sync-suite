/**
 * 空状态提示组件（列表空、AI 无内容等场景共用）。
 *
 * 设计（`docs/UI-DESIGN.md`）：白底 + 无卡片 + 无 emoji 大图标 + 只有两级文字（正文 / 辅助）。
 * 过去用 48fp emoji + 48vp 上下留白，占掉半屏且字号层级多一级，已删除。
 *
 * 契约：`docs/CONTRACT.md` §3.4（页面/组件统一风格）。共享层组件 —— 不含任何手写/OCR/PixelMap 代码，
 * Android 与 HarmonyOS 都能编译。
 */
import { FONT, LINE_HEIGHT, SPACING } from '../common/uiTokens';

@Component
export struct EmptyState {
  /** 主提示语（正文级字号）。 */
  @Prop title: string = '暂无内容';
  /** 次要说明（辅助级字号，可为空）。 */
  @Prop hint: string = '';
  /**
   * 旧版 emoji 图标位。
   *
   * 保留该参数只为兼容既有调用方（`Edit.ets` / `Detail.ets` 仍会传），**不再渲染**：
   * 48fp 的装饰性 emoji 与「字号层级只有 3 级」冲突，且深色模式下颜色不可控。
   */
  @Prop icon: string = '';

  build() {
    Column({ space: SPACING.sm }) {
      Text(this.title)
        .fontSize(FONT.body)
        .lineHeight(LINE_HEIGHT.body)
        .fontColor($r('app.color.text_primary'))
        .textAlign(TextAlign.Center)
        .width('100%')
      if (this.hint.length > 0) {
        Text(this.hint)
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
          .textAlign(TextAlign.Center)
          .width('100%')
      }
    }
    .width('100%')
    .padding({ top: SPACING.xl, bottom: SPACING.xl })
    .justifyContent(FlexAlign.Center)
  }
}
