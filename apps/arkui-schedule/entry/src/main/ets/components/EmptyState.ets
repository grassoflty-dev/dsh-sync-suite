/**
 * 空态提示组件（列表空、AI 无可整理内容等场景共用）。
 *
 * 契约：`docs/CONTRACT.md` §3.4（页面/组件统一风格）。共享层组件 —— 不含任何
 * 手写/OCR/PixelMap 代码，Android 与 HarmonyOS 都能编译。
 */

@Component
@crossplatform
export struct EmptyState {
  /** 主提示语。 */
  @Prop title: string = '暂无内容';
  /** 次要说明（可为空）。 */
  @Prop hint: string = '';
  /** 顶部图标（emoji，避免额外图片资源）。 */
  @Prop icon: string = '🗒';

  build() {
    Column({ space: 8 }) {
      Text(this.icon)
        .fontSize(48)
        .margin({ bottom: 4 })
      Text(this.title)
        .fontSize(16)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('app.color.text_primary'))
        .textAlign(TextAlign.Center)
      if (this.hint.length > 0) {
        Text(this.hint)
          .fontSize(13)
          .fontColor($r('app.color.text_secondary'))
          .textAlign(TextAlign.Center)
          .padding({ left: 24, right: 24 })
      }
    }
    .width('100%')
    .padding({ top: 48, bottom: 48 })
    .justifyContent(FlexAlign.Center)
  }
}
