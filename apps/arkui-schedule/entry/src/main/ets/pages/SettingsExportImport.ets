/**
 * 设置子页：数据导入导出（mod-settings-root）。
 *
 * 只做路由壳：页面正文是 `components/settings/SettingsHost.ets` 的数据段（DataSection +
 * ExportImportPanel 原样复用），底部主操作「导出」按今天日期导出完整包。
 * 返回键走 `router.back()` 回设置根页。
 */
import { SettingsHost } from '../components/settings/SettingsHost';

@Entry
@Component
struct SettingsExportImport {
  build() {
    Stack({ alignContent: Alignment.TopStart }) {
      SettingsHost({ section: 'data', pageTitle: '数据导入导出' })
    }
    .width('100%')
    .height('100%')
    .backgroundColor($r('app.color.page_background'))
  }
}
