// mod-settings-root：设置根页四行摘要的纯函数契约。
// 前置：node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
import assert from 'node:assert/strict';
import test from 'node:test';
import { readExportPage, readSettingsFile, readSettingsPage, readSyncPage, readSyncSection } from './settingsSources.mjs';

const {
  LAST_EXPORT_AT_KEY,
  LAST_IMPORT_AT_KEY,
  repoHostOf,
  clockOf,
  syncRowSummary,
  dataRowSummary,
  apiRowSummary
} = await import('../.build/model/settingsMenu.js');

test('M-01 摘要键稳定且四行摘要函数齐备', () => {
  assert.equal(LAST_EXPORT_AT_KEY, 'settings.lastExportAt');
  assert.equal(LAST_IMPORT_AT_KEY, 'settings.lastImportAt');
  for (const fn of [repoHostOf, clockOf, syncRowSummary, dataRowSummary, apiRowSummary]) {
    assert.equal(typeof fn, 'function');
  }
});

test('M-02 repoHostOf：去协议 / 账号 / 端口 / 路径，空值给未配置', () => {
  assert.equal(repoHostOf('https://github.com/me/repo.git'), 'github.com');
  assert.equal(repoHostOf('http://gitee.com:8080/a/b'), 'gitee.com');
  assert.equal(repoHostOf('https://user@gitlab.example.com/a'), 'gitlab.example.com');
  assert.equal(repoHostOf('   '), '未配置');
  assert.equal(repoHostOf('not a url'), 'not a url');
});

test('M-03 clockOf：本机时区 HH:MM，非法 / 空值返回空串', () => {
  const at = new Date(2026, 10, 16, 9, 5, 0).toISOString();
  assert.equal(clockOf(at), '09:05');
  assert.equal(clockOf(''), '');
  assert.equal(clockOf('garbage'), '');
});

test('M-04 syncRowSummary：失败优先、成功 HH:MM、从未同步', () => {
  const at = new Date(2026, 10, 16, 9, 5, 0).toISOString();
  assert.equal(syncRowSummary(at, ''), '已同步·09:05');
  assert.equal(syncRowSummary('', '认证失败（401）\n第二行'), '失败：认证失败（401）');
  assert.equal(syncRowSummary('', ''), '未同步');
  assert.equal(syncRowSummary('garbage', ''), '未同步');
});

test('M-05 dataRowSummary：未导出 / 上次导出 / 上次导入，取更近的一次', () => {
  const a = new Date(2026, 10, 16, 9, 5, 0).toISOString();
  const b = new Date(2026, 10, 16, 14, 32, 0).toISOString();
  assert.equal(dataRowSummary('', ''), '未导出');
  assert.equal(dataRowSummary(a, ''), '上次导出 09:05');
  assert.equal(dataRowSummary('', b), '上次导入 14:32');
  assert.equal(dataRowSummary(a, b), '上次导入 14:32');
  assert.equal(dataRowSummary(b, a), '上次导出 14:32');
});

test('M-06 apiRowSummary：服务 · 模型，缺失段用未配置占位', () => {
  assert.equal(apiRowSummary('DeepSeek', 'deepseek-chat'), 'DeepSeek · deepseek-chat');
  assert.equal(apiRowSummary('', 'deepseek-chat'), '未配置 · deepseek-chat');
  assert.equal(apiRowSummary('DeepSeek', ''), 'DeepSeek · 未配置');
  assert.equal(apiRowSummary('', ''), '未配置 · 未配置');
});

// mod-settings-sync-page：同步行摘要的「已同步·HH:MM / 失败：原因」口径必须落到真页面。
// 守卫同时读 pages/SettingsSync（真装配 / 状态 / 保存）与 SyncSection（presentational body），
// 两者都钉住，避免页面换成薄壳或正文被掏空时能漏检。
test('M-07 同步子页渲染真实正文：两个字段 + 诚实状态行 + 失败出口，无高级 / 手动同步', () => {
  const page = readSyncPage();
  const section = readSyncSection();

  // 页面自身：唯一主操作、同一校验入口、三态状态行、失败出口。
  assert.match(page, /title: '同步仓库'/, '页头标题');
  assert.match(page, /Button\('保存'\)/, '唯一主操作「保存」');
  assert.match(page, /checkSettingsFields\(/, '保存复用同一整表校验');
  assert.match(page, /syncRowSummary\(/, '状态行来自同一份已持久化状态');
  assert.match(page, /'同步中…'/, '忙碌态文案');
  for (const action of ['查看状态', '测试连接', '重试']) {
    assert.match(page, new RegExp(`Text\\('${action}'\\)`), `失败出口「${action}」`);
  }
  assert.equal(/SettingsHost\(\{/.test(page), false, '同步子页不得再是复用宿主的薄壳');

  // 正文（presentational body 保持在 SyncSection，锚点不搬走）。
  assert.match(page, /SyncSection\(\{/, '页面必须装配同步正文');
  assert.match(section, /Text\('仓库地址'\)/, '字段一：仓库地址');
  assert.match(section, /this\.FieldLabel\('访问令牌（仅存本机）'\)/, '字段二：访问令牌');
  assert.match(section, /Text\(this\.syncMessage\)/, '诚实状态行');

  // 旧能力绝迹：高级折叠区与手动同步按钮。只扫可执行源码，注释里的「没有高级」不算控件。
  const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  for (const src of [code(page), code(section)]) {
    assert.equal(/高级/.test(src), false, '同步子页 / 正文不得出现「高级」控件');
    assert.equal(
      /label: '推送'|label: '立即同步'|Text\('推送'\)|Text\('立即同步'\)/.test(src),
      false,
      '同步子页 / 正文不得有手动推送 / 立即同步'
    );
  }
});

// mod-settings-export-page：数据导入导出路由同样必须落到真页面，而不是复用宿主的薄壳。
// 页面钉「唯一主操作 + 一层 flex + 装配真正文」，正文继续钉在 DataSection / ExportImportPanel
// 原文件（presentational body 不搬走），避免页面真了却把控件掏空。
test('M-08 数据子页渲染真实正文：三个 chip + 两个日期字段 + 导出/选文件/确认导入，无重复提示与备份节', () => {
  const page = readExportPage();
  const data = readSettingsFile('components/settings/DataSection.ets');
  const panel = readSettingsFile('components/ExportImportPanel.ets');
  const model = readSettingsFile('model/exportImport.ts');

  // 页面自身：页头 / 唯一主操作 / 自带 Scroller / 一层 flex / 装配 DataSection，不再是薄壳。
  assert.match(page, /title: '数据导入导出'/, '页头标题');
  assert.match(page, /Button\('导出'\)/, '唯一主操作「导出」');
  assert.match(page, /Scroll\(this\.pageScroller\)/, '自带唯一 Scroll');
  assert.match(page, /DataSection\(\{/, '页面必须装配数据正文');
  assert.equal(/SettingsHost\(\{/.test(page), false, '数据子页不得再是复用宿主的薄壳');
  assert.equal(/SECTION_DATA|section: 'data'/.test(page), false, '数据子页不得残留 section 分支标识');

  // 正文（presentational body 保持在 DataSection / ExportImportPanel，锚点不搬走）。
  assert.match(data, /Text\('数据'\)/, '数据组标题仍在 DataSection');
  assert.equal((data.match(/ExportImportPanel\(\{/g) ?? []).length, 1, '数据组只能装配一个面板');
  const labels = ["label: '今天'", "label: '本周'", "label: '近 7 天'"];
  let last = -1;
  for (const label of labels) {
    const at = model.indexOf(label);
    assert.ok(at > last, `三个快捷 chip 的逐字标签缺失或乱序：${label}`);
    last = at;
  }
  assert.match(panel, /ForEach\(\s*QUICK_RANGE_OPTIONS/, '面板必须渲染快捷 chip');
  assert.match(panel, /this\.QuickRangeRow\(\)/, 'chip 行必须保留');
  assert.match(panel, /this\.FromInput\(\)/, '开始日期字段必须保留');
  assert.match(panel, /this\.ToInput\(\)/, '结束日期字段必须保留');
  assert.match(panel, /label: '导出完整包'/, '完整包导出仍在面板');
  assert.match(panel, /this\.pickLabel\(\)/, '选文件动作仍在面板');
  assert.match(panel, /this\.confirmLabel\(\)/, '确认导入动作仍在面板');
  assert.match(panel, /this\.GroupTitle\('导入'\)/, '导入组仍在面板');

  const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  for (const src of [code(page), code(data), code(panel)]) {
    assert.equal(/填今天/.test(src), false, 'chip 已能填今天，不得再有第二套提示');
    assert.equal(/日程备份|V2Section|onV2Export|handleV2Export/.test(src), false, '备份节不得复活');
  }
});

// mod-settings-export-page：risk guard —— 从本页剥离出去的数据状态不能靠「保存整表」波及。
// settingsStore.save 是 patch（未提供键保留磁盘当前值），而导出/导入时刻只写 AppStorage 的
// 两个独立键，SettingsPatch / ScheduleSettings 都不含它们，所以 API 子页复用宿主保存时
// 不可能清空导出相关设置。
test('M-09 patch 安全：剩余页面保存不触碰导出/导入状态（store patch + 双键只在导出页写）', () => {
  const store = readSettingsFile('services/settingsStore.ets');
  const host = readSettingsPage();
  const page = readExportPage();
  const patchBody = store.slice(store.indexOf('async save(patch: SettingsPatch'), store.indexOf('async saveSyncState('));
  const settingsShape = store.slice(store.indexOf('export interface ScheduleSettings'), store.indexOf('export interface SyncStatePatch'));
  const patchShape = store.slice(store.indexOf('export interface SettingsPatch'), store.indexOf('export interface AiFallbackSettings'));

  assert.ok(patchBody.length > 0 && settingsShape.length > 0 && patchShape.length > 0, '必须能定位到 store 的三段源码');
  assert.match(patchBody, /const current = await this\.load\(\);/, 'patch 必须基于磁盘当前值合并');
  assert.match(patchBody, /repoUrl:\s*patch\.repoUrl === undefined \? current\.repoUrl/, 'repoUrl 未提供键保留原值');
  assert.match(patchBody, /token:\s*patch\.token === undefined \? current\.token/, 'token 未提供键保留原值');
  for (const [name, shape] of [['ScheduleSettings', settingsShape], ['SettingsPatch', patchShape]]) {
    assert.equal(/lastExportAt|lastImportAt|exportImport/.test(shape), false, `${name} 不得含导出/导入状态键`);
  }
  assert.match(host, /const settings = await settingsStore\.load\(\);/, '宿主保存前仍读全量设置对象');
  assert.match(host, /const patch: SettingsPatch = \{/, '宿主走 patch，不是整表替换');
  assert.equal(/LAST_EXPORT_AT_KEY|LAST_IMPORT_AT_KEY/.test(host), false, '宿主保存不写导出时刻');
  assert.equal(/settingsStore\.save\(/.test(page), false, '导出页不写配置对象，只写 AppStorage 时刻');
  assert.match(page, /AppStorage\.setOrCreate<string>\(LAST_EXPORT_AT_KEY, nowIso\(\)\)/, '导出成功才记导出时刻');
  assert.match(page, /AppStorage\.setOrCreate<string>\(LAST_IMPORT_AT_KEY, nowIso\(\)\)/, '导入成功才记导入时刻');
});
