// A2 拆分（纯重构）后的源码读取助手：`pages/Settings.ets` 只做装配，五个功能组搬到了
// `entry/src/main/ets/components/settings/*.ets`。
//
// 这一批静态守卫测试原本的锚点是**单文件** `pages/Settings.ets`（`readFileSync` 后按
// builder 名切片、按正则找调用点）。拆分后：
// - 只关心「这段文案/调用是否存在」的断言 → 用 `readSettingsSources()`（根页 + 三个真子页 +
//   bits + 五个 section，按界面顺序拼接）当锚点，断言本身一个字都不改；
// - 需要「按 builder 切片 / 比较相对顺序」的断言 → 用 `readSettingsFile()` 指向**搬过去之后
//   的那个文件**（锚点跟着代码走），断言内容同样不改。
//
// 因此这里只做「读哪个文件」，不提供任何断言逻辑；测试失败时先看是不是锚点该换文件了。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `entry/src/main/ets` 的绝对路径（从本文件位置推，任意工作目录都成立）。 */
export const ETS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'entry', 'src', 'main', 'ets');

/** 读 `entry/src/main/ets` 下的某个源码文件（传相对该目录的路径）。 */
export function readSettingsFile(relative) {
  return readFileSync(join(ETS_ROOT, relative), 'utf8');
}

/**
 * 设置业务本体的锚点（mod-settings-root 旧 → 新）：
 * 旧 `pages/Settings.ets` 是长滚动实现；现在该文件是四行菜单根页，
 * 全部 @State / 业务方法 / 五个弹层 / 旧 builder 原样搬到 `components/settings/SettingsHost.ets`。
 * 这里跟着代码换锚点，断言本身不变、也不放宽：文件里仍是同一份实现文本。
 */
export function readSettingsPage() {
  return readSettingsFile('components/settings/SettingsHost.ets');
}

/** 四行菜单根页（新文件；只放菜单与页脚，不渲染任何 section body）。 */
export function readSettingsRoot() {
  return readSettingsFile('pages/Settings.ets');
}

/**
 * mod-settings-sync-page：同步子页现在自带真 body（状态 / 保存 / 诚实状态行 / 失败出口），
 * 不再经 SettingsHost 的 section='sync' 分支。同步相关断言锚点须跟到这里；
 * SyncSection 仍是 presentational body，它的断言保持原文件锚点、不搬走。
 */
export function readSyncPage() {
  return readSettingsFile('pages/SettingsSync.ets');
}

/**
 * mod-settings-export-page：数据 / 导入导出子页现在也自带真 body（区间 / 两个字段 /
 * 导出完整包 / 选文件 / 试算 / 确认导入），不再经 SettingsHost 的 section='data' 分支。
 * 数据与导出相关断言的锚点须跟到这里；DataSection / ExportImportPanel 仍是
 * presentational body，它们的断言保持原文件锚点、不搬走。
 */
export function readExportPage() {
  return readSettingsFile('pages/SettingsExportImport.ets');
}

/**
 * mod-settings-api-page：API 子页现在也自带真 body（AI 源 / 模型 / Key / 测试 / fallback
 * + 自定义源接口地址 + 唯一「保存」），不再经 SettingsHost 的 section='api' 分支。
 * AI 相关断言的锚点须跟到这里；AiSection 仍是 presentational body，它的断言保持原文件锚点。
 */
export function readApiPage() {
  return readSettingsFile('pages/SettingsApi.ets');
}

/** 同步组 section（含组头「更多」、主表单、`高级` 折叠区）。 */
export function readSyncSection() {
  return readSettingsFile('components/settings/SyncSection.ets');
}

/**
 * 远程控制 section 已随 mod-settings-remote-dedupe 删除：配置统一在 pages/Instances。
 * 旧 readRemoteSection() 调用点须 retarget 到实例页守卫，不再提供这个读取口。
 */

/** 关于 section（含深色模式 `ThemeRow`）。 */
export function readAboutSection() {
  return readSettingsFile('components/settings/AboutSection.ets');
}

/** 共享字段构件（`FieldLabel` / `ErrorText` / `HintLine` / `FieldNote`）。 */
export function readSettingsBits() {
  return readSettingsFile('components/settings/SettingsBits.ets');
}

/**
 * 设置页「全部界面源码」：页面 + 共享构件 + 五个 section（顺序 = 界面自上而下）。
 *
 * 用于「某段文案 / 某个渲染调用必须存在」的断言：拆分只改了文件位置，语义没变，
 * 所以整段拼起来查与拆分前查单文件是**等价**的。
 */
export function readSettingsSources() {
  const files = [
    'pages/Settings.ets',
    'pages/SettingsSync.ets',
    'pages/SettingsExportImport.ets',
    'pages/SettingsApi.ets',
    'components/settings/SettingsHost.ets',
    'components/settings/SettingsBits.ets',
    'components/settings/SyncSection.ets',
    'components/settings/AiSection.ets',
    'components/settings/DataSection.ets',
    'components/settings/AboutSection.ets'
  ];
  return files.map((file) => readSettingsFile(file)).join('\n');
}
