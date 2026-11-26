/**
 * 设置根页「一行摘要」（模块 `mod-app-settings-summary-resolve`）：标题 + 摘要 + 行尾提示。
 *
 * **为什么必须是真 `@Component` 而不是 `@Builder`**（真机缺陷的根因，别再改回去）：
 * 原实现是 `pages/Settings.ets` 里的
 * ```
 * @Builder MenuRow(title: string, summary: string, route: string) { … Text(summary) … }
 * …
 * this.MenuRow('同步仓库', this.repoSummary, ROUTE_SYNC)
 * ```
 * `@Builder` 的**按值**参数只在调用那一刻求值：参数是 `this.repoSummary` 的**当时快照**，
 * Text 节点的更新闭包里没有任何状态读取，所以 `@State` 改变不会重建那个 Text。
 * 于是 `applyRows()` 明明写了终态、屏幕却永远是初始的「读取中…」，连 typed 失败行都上不了屏
 * （同一类缺陷在 `docs/VERIFICATION.md` §15.6.1 已被真机抓过一次，修法是让状态读取发生在节点闭包里）。
 *
 * 现形状：真子组件 + `@Prop`（单向 props，首参用 `@Prop` 的既有先例见
 * `components/settings/SyncSection.ets`、`components/RecordRow.ets`）。`build()` 里
 * `Text(this.summary)` / `Text(rowHintOf(this.retryable))` 是**节点自己的闭包在读状态**，
 * 父组件 → `@Prop` → 子组件 Text 这条链才是 ArkUI 会跟踪的那条。
 *
 * 纯展示：不 import services、不读盘、不持有状态；点击只把事件交回页面（`onTap`）。
 */
import { FONT, LINE_HEIGHT, SPACING, TOUCH_MIN } from '../../common/uiTokens';
import { rowHintOf } from '../../model/summaryResolve';

@Component
export struct MenuSummaryRow {
  /** 行标题（静态文案：同步仓库 / 远程实例 / 数据导入导出 / API 配置）。 */
  @Prop title: string = '';
  /** 行摘要（`@State`，三态模型的唯一出口文案；成功、失败、附注都在这一行里）。 */
  @Prop summary: string = '';
  /** 本行是否处于「读不到」态：是 → 行尾显示「重试」，点击语义由页面决定（重试而非跳转）。 */
  @Prop retryable: boolean = false;
  /** 点击回调：页面负责「失败态先重试、正常态才推子页」的语义。 */
  onTap: () => void = () => {};

  build() {
    Row({ space: SPACING.sm }) {
      Column({ space: SPACING.xs }) {
        Text(this.title)
          .fontSize(FONT.body)
          .lineHeight(LINE_HEIGHT.body)
          .fontColor($r('app.color.text_primary'))
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
          .textAlign(TextAlign.Start)
        Text(this.summary)
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
          .textAlign(TextAlign.Start)
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)

      Text(rowHintOf(this.retryable))
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontColor($r('app.color.text_secondary'))
        .flexShrink(0)
        .textAlign(TextAlign.Center)
    }
    .width('100%')
    .constraintSize({ minHeight: TOUCH_MIN + SPACING.md })
    .alignItems(VerticalAlign.Center)
    .onClick(() => {
      this.onTap();
    })
  }
}
