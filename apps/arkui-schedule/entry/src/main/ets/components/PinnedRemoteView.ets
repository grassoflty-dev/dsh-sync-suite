/**
 * mod-remote-pinned-client：带凭证响应的**原生渲染**视图。
 *
 * 为什么不用 WebView：pinned client 已经把数据取回来了，响应是结构化的 JSON。
 * 用 ArkUI 直接渲染即可，Web 组件一挂上就会自己发子资源请求、可能带 cookie/JS，
 * 那些请求都不经过我们的 leaf pin，等于把 bearer 的保护绕开。若确实必须渲染 HTML，
 * 只能是「inert」：loadData 已取回的内容 + 禁远程导航/子资源，且绝不注入凭证。
 * 本组件走原生路径，完全没有 Web / loadUrl / handleConfirm。
 *
 * 文案中性：真机门禁未通过前不宣称「安全/已验证」，只陈述数据来源与结果。
 */
import { FONT, LINE_HEIGHT, SPACING } from '../common/uiTokens';

/** 空数据提示（不宣称任何保护结论）。 */
const EMPTY_TEXT: string = '暂时没有可显示的远程数据';
const TITLE_HINT: string = '远程数据';

@Component
export struct PinnedRemoteView {
  /** 已由纯模型解析出的卡片（不含凭证/证书原文）。 */
  @Prop cards: Array<{ title: string, detail: string }> = [];

  build() {
    Column() {
      Text(TITLE_HINT)
        .fontSize(FONT.title)
        .lineHeight(LINE_HEIGHT.title)
        .fontColor($r('app.color.text_primary'))
      if (this.cards.length === 0) {
        Text(EMPTY_TEXT)
          .fontSize(FONT.body)
          .lineHeight(LINE_HEIGHT.body)
          .fontColor($r('app.color.text_secondary'))
      } else {
        List() {
          ForEach(this.cards, (card: { title: string, detail: string }, index: number) => {
            ListItem() {
              Column({ space: SPACING.xs }) {
                Text(card.title)
                  .fontSize(FONT.body)
                  .fontColor($r('app.color.text_primary'))
                if (card.detail.length > 0) {
                  Text(card.detail)
                    .fontSize(FONT.caption)
                    .fontColor($r('app.color.text_secondary'))
                }
              }
              .alignItems(HorizontalAlign.Start)
            }
            .key(`${index}`)
          }, (card: { title: string, detail: string }, index: number) => `${index}-${card.title}`)
        }
        .width('100%')
        .layoutWeight(1)
      }
    }
    .width('100%')
    .height('100%')
    .padding(SPACING.md)
  }
}
