/**
 * 设置 → 远程实例 · 顶层页路由（mod-shell-instances-pane / mod-instances-pane-readonly）。
 *
 * 真实正文已迁入 `pages/panes/InstancesPane.ets`（单一事实来源）：远程行 /
 * typed 问题行 / 空态 / 播种迁移全在那一个组件里（没有本机实例行）。本文件只保留 `@Entry` 路由壳，
 * 让设置根页「远程实例 ›」的 `router.pushUrl('pages/Instances')` 继续可达；
 * 不复制任何正文，也不给面板加第二层固定高度包裹（滚动由面板自己的 Scroll 承担）。
 *
 * 外壳（pages/Home.ets）的「远程 DSH」分段装配的是同一个 InstancesPane，但**不传**
 * `configurable`，走默认 false：首页只「用」（列表 / 状态 / 打码 URL / 打开）；
 * 本路由是设置里的配置落点，显式传 `configurable: true`，保留添加 / 编辑 /
 * 地址·令牌·方式表单与空态「添加实例」。删除入口已迁到 `pages/SettingsInstances`。
 * 配置与使用的分界只有一个 prop。
 */
import { InstancesPane } from './panes/InstancesPane';

@Entry
@Component
struct Instances {
  build() {
    Stack({ alignContent: Alignment.TopStart }) {
      InstancesPane({ deepLinkId: '', active: true, configurable: true })
    }
    .width('100%')
    .height('100%')
    .backgroundColor($r('app.color.page_background'))
  }
}
