/**
 * 设置子页：同步仓库（mod-settings-root）。
 *
 * 只做路由壳：页面正文是 `components/settings/SettingsHost.ets` 的同步段（原 SyncSection
 * 逐字复用，含隐藏 Git Web 与「保存」主操作）。返回键走 `router.back()` 回设置根页。
 * 本模块不改动 section 本体；各子页的独立打磨留给后续模块。
 */
import { SettingsHost } from '../components/settings/SettingsHost';

@Entry
@Component
struct SettingsSync {
  build() {
    Stack({ alignContent: Alignment.TopStart }) {
      SettingsHost({ section: 'sync', pageTitle: '同步仓库' })
    }
    .width('100%')
    .height('100%')
    .backgroundColor($r('app.color.page_background'))
  }
}
