/**
 * 设置子页：API 配置（mod-settings-root）。
 *
 * 只做路由壳：页面正文是 `components/settings/SettingsHost.ets` 的 AI 段（AiSection
 * 原样复用，含服务 / 模型选择弹层与「保存」主操作）。返回键走 `router.back()` 回设置根页。
 * 本页没有「高级」与手输模型名；模型只走两个预设下拉。
 */
import { SettingsHost } from '../components/settings/SettingsHost';

@Entry
@Component
struct SettingsApi {
  build() {
    Stack({ alignContent: Alignment.TopStart }) {
      SettingsHost({ section: 'api', pageTitle: 'API 配置' })
    }
    .width('100%')
    .height('100%')
    .backgroundColor($r('app.color.page_background'))
  }
}
