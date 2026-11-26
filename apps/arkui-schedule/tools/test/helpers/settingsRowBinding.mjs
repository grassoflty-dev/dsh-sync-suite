// 设置根页「四行菜单」的**渲染绑定形状**唯一来源（模块 `mod-app-settings-summary-resolve`）。
//
// 为什么要有这个 helper：2026-11-26 21:36 新构建的真机缺陷不是数据、不是超时，而是**绑定**。
// 四行摘要原先经 `@Builder MenuRow(title: string, summary: string, route: string)` 按值传参：
// ArkUI 的 @Builder 按值参数不会因为 @State 变化重建那个 Text 节点（同一缺陷在本仓库
// `docs/VERIFICATION.md` §15.6.1 已被真机抓过一次，修法是让状态读取发生在节点闭包里）。
// 于是 `applyRows()` 写了 @State、屏幕却永远停在初始的「读取中…」，连 typed 失败行都上不了屏。
//
// 现在行是**真组件** `MenuSummaryRow`（`@Prop` + 子组件自己的节点）。十来个既有断言原先各自
// 抄了一份 `this.MenuRow('标题', this.xxxSummary, ROUTE_X)` 的字面量正则；形状变了以后它们必须
// 逐处跟着换锚点——所以把新形状收敛到这里一份，免得十处正则各写一遍再各自漂移。

/** 行组件的名字（真 `@Component`；不是 @Builder）。 */
export const ROW_COMPONENT = 'MenuSummaryRow';

/** 行组件实例化的开头字面量（计数用）。 */
export const ROW_OPEN = 'MenuSummaryRow({';

/**
 * 一行的绑定正则：标题 + 摘要 `@State` + 可重试 `@State` + 点击落到唯一的 `push(ROUTE_X)`。
 *
 * 三项都在同一个正则里，缺一项就红：只钉「标题在」等于没钉摘要接线；
 * 只钉摘要不钉 `push(route)` 等于允许行变成只读文案。
 */
export function rowBindingRe(title, summary, route) {
  return new RegExp(
    `MenuSummaryRow\\(\\{\\s*title: '${title}',\\s*summary: this\\.${summary},`
    + `\\s*retryable: (?:this\\.\\w+|false|true),\\s*onTap: \\(\\) => \\{\\s*this\\.push\\(${route}\\);\\s*\\}\\s*\\}\\)`
  );
}

/** 该源码里四行组件的出现次数（`MenuSummaryRow({`）。 */
export function countRows(source) {
  return (source.match(/MenuSummaryRow\(\{/g) ?? []).length;
}
