/**
 * 远程实例与云端对话 · 顶层页路由（mod-shell-instances-pane）。
 *
 * 真实正文已迁入 `pages/panes/InstancesPane.ets`（单一事实来源）：本机首行 / 远程行 /
 * 三动作 / typed 问题行 / 空态 / 播种迁移全在那一个组件里。本文件只保留 `@Entry` 路由壳，
 * 让设置页「远程实例与云端对话 ›」的 `router.pushUrl('pages/Instances')` 继续可达；
 * 不复制任何正文，也不给面板加第二层固定高度包裹（滚动由面板自己的 Scroll 承担）。
 *
 * 外壳（pages/Home.ets）的「远程 DSH」分段装配的是同一个 InstancesPane，
 * 所以从轨里进和从设置入口进看到的是完全相同的列表与行为。
 */
import { InstancesPane } from './panes/InstancesPane';

@Entry
@Component
struct Instances {
  build() {
    Stack({ alignContent: Alignment.TopStart }) {
      InstancesPane({ deepLinkId: '', active: true })
    }
    .width('100%')
    .height('100%')
    .backgroundColor($r('app.color.page_background'))
  }
}
