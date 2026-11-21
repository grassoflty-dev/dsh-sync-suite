// mod-settings-root：设置根页四行摘要的纯函数契约。
// 前置：node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
import assert from 'node:assert/strict';
import test from 'node:test';

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
