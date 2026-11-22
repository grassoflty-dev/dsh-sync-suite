// mod-settings-root：设置根页四行摘要的纯函数契约。
// 前置：node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { readApiPage, readExportPage, readSettingsFile, readSettingsPage, readSyncPage, readSyncSection } from './settingsSources.mjs';

// tsc 产物里的相对 import 不带扩展名（settingsMenu → syncStatusLine / syncStatusPersist）。
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error && error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.js')) {
        return nextResolve(`${specifier}.js`, context);
      }
      throw error;
    }
  }
});

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

test('M-04 syncRowSummary：文案只由权威最新尝试决定，旧 lastSyncAt 永不冒充当前成功', () => {
  const staleSuccess = '2026-11-21T19:47:20+08:00';
  // 旧行为（今天会失败）：syncRowSummary(staleSuccess, '') === '已同步·19:47'。
  assert.equal(
    syncRowSummary(staleSuccess, '', { kind: 'failed', at: '16:26', reason: 'E_NO_MAIN' }),
    '上次失败 · 16:26 · E_NO_MAIN'
  );
  assert.equal(
    syncRowSummary(staleSuccess, '', { kind: 'synced', at: '09:05', reason: '' }),
    '已同步 · 09:05'
  );
  assert.equal(syncRowSummary('', '', { kind: 'synced', at: '09:05', reason: '' }), '已同步 · 09:05');
  assert.equal(syncRowSummary(staleSuccess, '旧错误', null), '已配置 · 尚未同步');
  assert.equal(syncRowSummary('', '', null), '已配置 · 尚未同步');
  assert.equal(syncRowSummary('garbage', '', null), '已配置 · 尚未同步');
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
  // mod-sync-silent-autoinit：状态行只有 honestStatus() 一个来源；syncRowSummary 只属根页摘要。
  assert.match(page, /syncMessage: this\.honestStatus\(\)/, '状态行唯一来源是 honestStatus()');
  assert.doesNotMatch(page, /syncRowSummary\(/, '同步页不得调用根页摘要函数');
  // mod-status-honesty-regression：忙碌文案已收敛到纯模型常量，页面只委托唯一渲染器。
  const constants = readSettingsFile('model/syncStatusPersist.ts');
  assert.match(constants, /TEXT_SYNCING: string = '同步中…'/, '忙碌态文案由唯一模型定义');
  assert.match(page, /syncStatusLineOf\(\{/, '页面委托唯一渲染器');
  // mod-sync-silence-phase-b：手动同步出口全部移除（同步由五个事件静默触发）。
  for (const action of ['查看状态', '测试连接', '重试', '立即同步', '推送']) {
    assert.doesNotMatch(page, new RegExp(`Text\\('${action}'\\)`), `不得有「${action}」按钮`);
    assert.doesNotMatch(page, new RegExp(`label:\\s*'${action}'`), `不得有「${action}」控件`);
  }
  assert.match(page, /private async runAction\(action: string\)/, '能力方法保留给支持排障');
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
// 两个独立键，SettingsPatch / ScheduleSettings 都不含它们，所以任何设置子页保存时
// 都不可能清空导出相关设置（API 子页现已是 pages/SettingsApi 真页面）。
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

// mod-settings-api-page：AI 配置落到真页面后，剩余页面的保存必须仍是 patch —— 不能把已存的
// AI 源 / 模型 / Key / 接口地址清空。store 层（缺省键沿用 current）+ 页面层（两页 patch 无 AI 键）
// 双向钉住，唯一写 AI 键的地方是 pages/SettingsApi。
test('M-10 patch 安全：剩余页面保存不触碰 AI 字段（store 缺省保留 + 两页 patch 无 AI 键）', () => {
  const store = readSettingsFile('services/settingsStore.ets');
  const host = readSettingsPage();
  const sync = readSyncPage();
  const api = readApiPage();
  const patchBody = store.slice(store.indexOf('async save(patch: SettingsPatch'), store.indexOf('async saveSyncState('));
  assert.ok(patchBody.length > 0, '必须能定位到 store 的 save() 实现');

  // store 层：未提供 AI 键时沿用磁盘当前值（provider / model 经派生变量，缺省分支必须指向 current）。
  for (const pattern of [
    /aiKey:\s*patch\.aiKey === undefined \? current\.aiKey/,
    /patch\.aiProviderId === undefined \? current\.aiProviderId/,
    /patch\.aiModel === undefined \? '' : patch\.aiModel/,
    /patch\.aiBaseURL === undefined \? current\.aiBaseURL/
  ]) {
    assert.match(patchBody, pattern, `save() 必须保留缺省的 AI 键：${pattern}`);
  }
  assert.match(
    patchBody,
    /nextProviderId === current\.aiProviderId\s*\n\s*\? resolveAiModel\(nextProviderId, current\.aiModel\)/,
    '同源且未提供 aiModel 时必须保留已存模型名'
  );

  // 页面层：同步真页面与历史宿主的 patch 里都不能出现 AI 键；API 真页面才是唯一 AI 写入者。
  const patchOf = (src) => src.slice(src.indexOf('const patch: SettingsPatch = {'), src.indexOf('settingsStore.save(patch'));
  for (const [name, src] of [['SettingsHost', host], ['SettingsSync', sync]]) {
    const patch = patchOf(src);
    assert.ok(patch.length > 0, `${name} 必须能定位到 SettingsPatch 对象`);
    for (const key of ['aiKey', 'aiProviderId', 'aiModel', 'aiBaseURL']) {
      assert.equal(new RegExp(`\\b${key}\\s*:`).test(patch), false, `${name} 的保存 patch 不得写 ${key}`);
    }
  }
  const apiPatch = patchOf(api);
  assert.ok(apiPatch.length > 0, 'API 真页面必须能定位到 SettingsPatch 对象');
  for (const key of ['aiKey', 'aiProviderId', 'aiModel', 'aiBaseURL']) {
    assert.match(apiPatch, new RegExp(`\\b${key}\\s*:`), `API 真页面必须写 ${key}（唯一 AI 写入者）`);
  }
});

// mod-settings-api-page：API 路由也必须落到真页面（provider / model 下拉 + 唯一「保存」），
// 同时钉住 presentational body（AiSection）不搬走、旧「高级」与手输模型名不复活。
test('M-11 API 子页渲染真实正文：服务 / 模型 + 保存，无高级 / 手输模型名 / 薄壳', () => {
  const page = readApiPage();
  const section = readSettingsFile('components/settings/AiSection.ets');

  assert.match(page, /title: 'API 配置'/, '页头标题');
  assert.match(page, /Button\('保存'\)/, '唯一主操作「保存」');
  assert.match(page, /Scroll\(this\.pageScroller\)/, '自带唯一 Scroll');
  assert.match(page, /PageLayout\(\{/, '自带 PageLayout，不是薄壳');
  assert.match(page, /AiSection\(\{/, '页面必须装配 AI 正文');
  assert.match(page, /router\.back\(\)/, '返回走 router.back() 回设置根页');
  assert.match(page, /checkSettingsFields\(/, '保存复用同一整表校验');
  assert.equal(/SettingsHost\(\{/.test(page), false, 'API 子页不得再是复用宿主的薄壳');
  assert.equal(/section: 'api'/.test(page), false, 'API 子页不得残留 section 分支标识');

  // 正文（presentational body 保持在 AiSection，锚点不搬走）。
  assert.match(section, /Text\('服务'\)/, '服务下拉行仍在 AiSection');
  assert.match(section, /Text\('模型'\)/, '模型下拉行仍在 AiSection');
  assert.match(section, /TextInput\(\{ text: this\.aiKey, placeholder:/, 'Key 输入框仍在');
  assert.match(section, /\.type\(InputType\.Password\)/, 'Key 字段必须掩码');
  assert.match(section, /if \(this\.customProvider\) \{/, '接口地址只在自定义源显示');
  assert.match(section, /this\.FieldLabel\('接口地址 baseURL'\)/, '接口地址字段名仍在');

  // 只扫可执行源码：注释里的「没有高级 / 没有手输」说明不算控件。
  const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  for (const src of [code(page), code(section)]) {
    assert.equal(/高级/.test(src), false, 'API 子页 / 正文不得出现「高级」控件');
    assert.equal(/模型名（可手输|模型名（必填）|TextInput\(\{ text: this\.aiModel/.test(src), false,
      'API 子页 / 正文不得有手输模型名入口');
  }
});

// mod-sync-silent-autoinit：三态词汇与诊断区的正向守卫（旧 M-07 的三态/失败出口断言一条未删）。
test('M-12 同步子页三态词汇 + 诊断区标注，仓库事实不再当提示', () => {
  const page = readSyncPage();
  const section = readSyncSection();
  for (const token of ['同步中…', '已同步 · ', '失败：', '（可重试）']) {
    assert.ok(page.includes(token), `同步子页缺三态词汇：${token}`);
  }
  assert.ok(section.includes('诊断（仅排查用）'), 'SyncSection 必须有诊断区标注');
  // 诊断区里仍能看到真实仓库事实（分支 / HEAD / 领先落后），只是位置与标注变了。
  assert.ok(section.includes('Text(this.statusLine)'), '诊断区展示真实状态事实');
  assert.equal(section.includes('this.statusReadiness'), false, '可执行文案不得留在诊断区');
  assert.equal(section.includes('describePushReadiness'), false, '「先做什么」文案不进诊断区');
  // mod-sync-silence-phase-b：状态行只读，不再有点一下重试的接线。
  assert.equal(page.includes('onRetryStatus: (): void => {'), false, '状态行不得挂重试 handler');
  assert.doesNotMatch(section, /Text\(this\.syncMessage\)[\s\S]{0,320}\.onClick\(/,
    '状态行仍渲染但不得可点');
  for (const banned of [/尚未初始化/, /首次克隆/, /先执行「拉取」/]) {
    assert.equal(banned.test(page + '\n' + section), false, `同步面残留死结文案：${banned}`);
  }
});
