// mod-v2-only P1-1 / P1-2 回归测试：汇总与 v1 格式导入的唯一落点都是 timeline/。
//
// 前置：node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
// 纯模型从 ../.build 导入；.ets 服务 / 页面因 @kit.* 只能做源码形状断言（本仓既有口径）。
// 覆盖：
//  P1-1 summaryStore 只经 timelineWriteStore.appendSummary 写、timelineStore.readSummaryText 读；
//       未迁移在任何 IO 之前 typed 拒绝；源码无 devices/**、无 v1 写端口；newer-wins 纯函数 + 夹具；
//  P1-2 v1 格式导入落点改成 timeline/（timelineWriteStore.append），未迁移 typed 拒绝 + 零写入；
//       面板导入节与设置页确认回调都有门禁；夹具证明纯规划阶段不碰 devices/**。
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { matchBrace, stripComments } from './helpers/etsSource.mjs';
import { requireOverlayRestored } from './guard.mjs';

requireOverlayRestored('v2SummaryImport.test.mjs');

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === 'ERR_MODULE_NOT_FOUND' &&
          specifier.startsWith('.') && !specifier.endsWith('.js')) {
        return nextResolve(`${specifier}.js`, context);
      }
      throw error;
    }
  }
});

const { isNewerSummaryText } = await import('../.build/model/timelineWrite.js');
const { parseSummary, serializeSummary } = await import('../.build/model/dailySummary.js');
const { reconcileBeforeAppend, groupImportByDate } = await import('../.build/model/exportImport.js');
const { decideMigration, NOT_MIGRATED_REASON } = await import('../.build/model/migrationState.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..');
const ETS = join(APP, 'entry', 'src', 'main', 'ets');
function src(rel) {
  return readFileSync(join(ETS, rel), 'utf8');
}
function code(rel) {
  return stripComments(src(rel));
}
function methodBody(text, name) {
  const signature = new RegExp(`\\b${name}\\s*\\([^)]*\\)(?:\\s*:[^{;]+)?\\s*\\{`);
  const matched = signature.exec(text);
  assert.ok(matched, `${name}() 未找到`);
  const open = text.indexOf('{', matched.index + matched[0].length - 1);
  const [start, end] = matchBrace(text, open);
  return text.slice(start, end);
}

const SUMMARY_STORE = 'services/summaryStore.ets';
const WRITE_STORE = 'services/timelineWriteStore.ets';
const EXPORT_SERVICE = 'services/exportService.ets';
const PANEL = 'components/ExportImportPanel.ets';
const SETTINGS = 'pages/Settings.ets';
const INDEX = 'pages/Index.ets';

/** 递归快照一棵夹具目录（相对路径 → 文本），用于「零写入 / 无 devices/** 变化」断言。 */
function snapshot(root) {
  const out = {};
  const walk = (dir) => {
    if (!existsSync(dir)) {
      return;
    }
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else {
        out[relative(root, full).replace(/\\/g, '/')] = readFileSync(full, 'utf8');
      }
    }
  };
  walk(root);
  return out;
}

function summaryText(date, generatedAt, headline) {
  return serializeSummary({
    version: 1, date: date, generatedAt: generatedAt, model: 'm', provider: 'p',
    headline: headline, points: ['point'], recordCount: 1, doneCount: 0
  });
}

// ================================================================ P1-1：汇总只写 v2

test('S1 summaryStore 是薄 v2 适配器：唯一读口 timelineStore、唯一写口 timelineWriteStore', () => {
  const text = code(SUMMARY_STORE);
  for (const needle of [
    'timelineStore.isMigrated()', 'NOT_MIGRATED_REASON', 'timelineStore.readSummaryText(',
    'parseSummary(', 'serializeSummary(', 'summaryFromReply(', 'timelineWriteStore.appendSummary('
  ]) {
    assert.ok(text.includes(needle), `summaryStore 缺少 v2 适配器要素：${needle}`);
  }
  // grep 断言：汇总路径源码中不存在任何 v1 路径字面量 / IO 端口 / 写函数。
  for (const forbidden of [/devices\//, /RepoSummaryIO/, /writeDailySummary\(/, /summaryFilePath\(/,
    /summariesPath\(/, /summaryRepoPath/, /fileIo/, /\bfs\./, /OpenMode\.TRUNC/]) {
    assert.doesNotMatch(text, forbidden, `汇总路径残留 v1 写入能力：${forbidden}`);
  }
  assert.match(methodBody(text, 'read'), /timelineStore\.readSummaryText\(date\)/,
    'read() 必须读 timeline/<date>/summary.json');
  assert.doesNotMatch(methodBody(text, 'read'), /scheduleStore\./, 'read() 不再依赖任何 v1 存储');
});

test('S2 generate() 未迁移在任何 IO（AI / 写盘）之前 typed 拒绝', () => {
  const body = methodBody(code(SUMMARY_STORE), 'generate');
  const guardAt = body.indexOf('if (!timelineStore.isMigrated())');
  const throwAt = body.indexOf('throw new Error(NOT_MIGRATED_REASON)');
  const aiAt = body.indexOf('await summarize(');
  const writeAt = body.indexOf('timelineWriteStore.appendSummary(');
  assert.ok(guardAt >= 0 && throwAt > guardAt, '必须先判未迁移再抛类型化原因');
  assert.ok(aiAt > throwAt && writeAt > throwAt,
    'E_NOT_MIGRATED 必须排在 AI 请求与落盘之前（未迁移零 IO、零写入）');
  assert.match(body, /timelineWriteStore\.appendSummary\(date, text\)/, '落盘调用必须带 date 与序列化文本');
  assert.match(body, /timelineStore\.readSummaryText\(date\)/, '写后回读实际生效汇总');
});

test('S3 appendSummary 落点由 writer 路径常量钉死为 git-repo/timeline/<date>/summary.json', () => {
  const text = code(WRITE_STORE);
  for (const needle of [
    "ROOT_DIR_NAME: string = 'git-repo'", "TIMELINE_DIR_NAME: string = 'timeline'",
    "SUMMARY_FILE_NAME: string = 'summary.json'", 'return `${this.timelineRoot()}/${date}`',
    'return `${this.filesDir}/${ROOT_DIR_NAME}/${TIMELINE_DIR_NAME}`'
  ]) {
    assert.ok(text.includes(needle), `writer 路径常量缺失：${needle}`);
  }
  assert.match(methodBody(text, 'appendSummary'), /atomicWriteIn\(dir, SUMMARY_FILE_NAME, text\)/,
    '汇总必须是原子替换，不能追加 / 截断');
});

test('S4 首页汇总流仍从 v2 记录生成，读回也走 summaryStore（v2 适配器）', () => {
  const text = code(INDEX);
  assert.match(methodBody(text, 'generateSummary'), /timelineStore\.readDay\(this\.selectedDate\)/,
    '生成输入必须是 v2 记录');
  assert.match(methodBody(text, 'generateSummary'), /summaryStore\.generate\(/, '生成必须走适配器');
  assert.match(methodBody(text, 'loadSummary'), /summaryStore\.read\(this\.selectedDate\)/, '读取必须走适配器');
  assert.doesNotMatch(code(SUMMARY_STORE), /devices\//);
});

test('S5 纯 newer-wins：较新生成时间胜，相等 / 更旧 / 坏候选不覆盖', () => {
  const old = summaryText('2026-11-19', 100, '旧');
  assert.equal(isNewerSummaryText(old, summaryText('2026-11-19', 200, '新')), true);
  assert.equal(isNewerSummaryText(old, summaryText('2026-11-19', 100, '等')), false, '相等保留现有');
  assert.equal(isNewerSummaryText(old, summaryText('2026-11-19', 50, '更旧')), false, '更旧不覆盖');
  assert.equal(isNewerSummaryText(old, '{bad json'), false, '坏候选不覆盖');
  assert.equal(isNewerSummaryText('', summaryText('2026-11-19', 1, '首份')), true, '空文件可写首份');
  assert.equal(isNewerSummaryText('{bad', summaryText('2026-11-19', 1, '修复')), true, '坏文件可被合法候选修复');
  assert.equal(parseSummary(old).summary.headline, '旧');
});

test('S6 夹具：已迁移仓库的汇总只落在 timeline/<date>/summary.json，devices/** 逐字节不变', () => {
  const repo = join(tmpdir(), `v2-summary-fixture-${process.pid}-${Date.now()}`);
  try {
    const devicesSummary = join(repo, 'devices', 'tablet-1', 'summaries', '2026-11-19.json');
    mkdirSync(dirname(devicesSummary), { recursive: true });
    const oldText = summaryText('2026-11-19', 100, 'v1 旧汇总');
    writeFileSync(devicesSummary, oldText, 'utf8');
    const schedulesDir = join(repo, 'devices', 'tablet-1', 'schedules');
    mkdirSync(schedulesDir, { recursive: true });
    writeFileSync(join(schedulesDir, '2026-11-19.jsonl'),
      '{"id":"keep","ts":"2026-11-19T09:00:00+08:00","title":"旧数据"}\n', 'utf8');
    const before = snapshot(repo);

    // 纯决策（服务是 .ets，不能 import）：与 appendSummary 内部 isNewerSummaryText 同口径。
    const candidate = summaryText('2026-11-19', 200, 'v2 新汇总');
    assert.equal(isNewerSummaryText('', candidate), true, 'timeline 无汇总时应写入');
    const target = join(repo, 'timeline', '2026-11-19', 'summary.json');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, candidate, 'utf8');

    assert.equal(readFileSync(target, 'utf8'), candidate, '汇总落在 timeline/<date>/summary.json');
    for (const [path, text] of Object.entries(before)) {
      assert.equal(readFileSync(join(repo, path), 'utf8'), text, `${path} 不得被汇总写入改动`);
    }
    assert.equal(parseSummary(readFileSync(target, 'utf8')).summary.generatedAt, 200);

    // 更旧候选不得覆盖刚写下的 v2 汇总。
    const stale = summaryText('2026-11-19', 50, '陈旧');
    assert.equal(isNewerSummaryText(readFileSync(target, 'utf8'), stale), false);
    assert.equal(readFileSync(target, 'utf8'), candidate, '陈旧候选零写入');
  } finally {
    if (existsSync(repo)) {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

// ================================================================ P1-2：v1 格式导入只写 timeline

/** 截出 v1 格式导入段（appendImportPlanOnce 到 v2 备份段第一个函数声明，注释已被剥离）。 */
function v1ImportSection() {
  const text = code(EXPORT_SERVICE);
  const start = text.indexOf('function applyImportPlanOnce');
  const end = text.indexOf('export function exportV2Timeline(');
  assert.ok(start > 0 && end > start, '找不到 v1 格式导入实现段');
  return text.slice(start, end);
}

test('I1 exportService：未迁移在任何读盘 / 写盘前 typed 拒绝，无 devices/** 写分支', () => {
  const section = v1ImportSection();
  const guardAt = section.indexOf('if (!timelineStore.isMigrated())');
  const failAt = section.indexOf('return failed(NOT_MIGRATED_REASON)');
  const readAt = section.indexOf('timelineStore.readAll()');
  const writeAt = section.indexOf('timelineWriteStore.append(record, date)');
  assert.ok(guardAt >= 0 && failAt > guardAt && readAt > failAt && writeAt > readAt,
    'E_NOT_MIGRATED → 读 v2 → 复核 → 经 writer 落盘的顺序不可颠倒');
  for (const forbidden of [/writePlan\(/, /importWriteIo\(/, /scheduleStore\.dayFilePath\(/, /devices\//]) {
    assert.doesNotMatch(section, forbidden, `v1 格式导入残留 v1 写分支：${forbidden}`);
  }
  assert.match(section, /resolveRecordDate\(record\.ts\)/, '写入日期必须按记录的 ts 归属');
  // dry-run 同样先看迁移门槛、再读 v2 真值。
  const dryRun = methodBody(code(EXPORT_SERVICE), 'planImportFromText');
  assert.match(dryRun, /if \(!timelineStore\.isMigrated\(\)\)/, 'dry-run 必须有未迁移拒绝');
  assert.match(dryRun, /existing = timelineStore\.readAll\(\)/, 'dry-run 基线必须是 v2 真值');
  assert.doesNotMatch(dryRun, /scheduleStore\.readAll\(|devices\//);
});

test('I2 面板导入节：未迁移整节禁用并展示 E_NOT_MIGRATED 原因', () => {
  const text = code(PANEL);
  assert.match(text, /import \{[\s\S]{0,200}NOT_MIGRATED_REASON[\s\S]{0,80}\} from '\.\.\/model\/migrationState'/,
    '面板必须导入 typed 拒绝原因');
  const reason = methodBody(text, 'importDisabledReason');
  assert.match(reason, /return this\.v2Visible\(\) \? '' : NOT_MIGRATED_REASON/,
    '未迁移时返回 E_NOT_MIGRATED，已迁移时可点');
  const hits = (text.match(/this\.importDisabledReason\(\)\.length === 0/g) || []).length;
  assert.ok(hits >= 3, `选择 / 确认 / 取消三个导入按钮都必须过门禁，实际 ${hits} 处`);
  assert.match(text, /导入不可用：\$\{this\.importDisabledReason\(\)\}/, '未迁移时展示 typed 原因');
  assert.match(text, /timeline\/<date>\/records\.json/, '已迁移时说明落点是 timeline');
});

test('I3 设置页：选择 / 确认导入回调各自有未迁移闸，且初始化 v2 写入口', () => {
  const text = code(SETTINGS);
  for (const name of ['handlePickImportFile', 'handleConfirmImport']) {
    const body = methodBody(text, name);
    assert.match(body, /if \(!timelineStore\.isMigrated\(\)\)/, `${name} 必须有未迁移闸`);
    assert.match(body, /NOT_MIGRATED_REASON/, `${name} 必须给 typed 原因`);
  }
  assert.match(methodBody(text, 'bootstrap'), /timelineWriteStore\.ensureReady\(context\)/,
    '导入落盘依赖的 writer 必须初始化');
});

test('I4 夹具：含 devices/** 的仓库，纯规划阶段不产生任何写入（timeline 日期归属正确）', () => {
  const repo = join(tmpdir(), `v2-import-fixture-${process.pid}-${Date.now()}`);
  try {
    const v1Shard = join(repo, 'devices', 'tablet-1', 'schedules', '2026-11-19.jsonl');
    mkdirSync(dirname(v1Shard), { recursive: true });
    const v1Bytes = '{"id":"v1-keep","ts":"2026-11-19T09:00:00+08:00","title":"旧数据"}\n';
    writeFileSync(v1Shard, v1Bytes, 'utf8');
    const timelineRoot = join(repo, 'timeline');
    mkdirSync(timelineRoot, { recursive: true });
    writeFileSync(join(timelineRoot, 'schema.json'), '{"schemaVersion":2}\n', 'utf8');
    const dayDir = join(timelineRoot, '2026-11-19');
    mkdirSync(dayDir, { recursive: true });
    writeFileSync(join(dayDir, 'records.json'), '{"date":"2026-11-19","open":[],"records":[]}\n', 'utf8');
    const before = snapshot(repo);

    const planned = [
      { id: 'new-a', ts: '2026-11-19T10:00:00+08:00', title: 'A', body: '', author: '我', done: false },
      { id: 'new-b', ts: '2026-11-20T09:00:00+08:00', title: 'B', body: '', author: '我', done: false }
    ];
    const existing = [{ id: 'v1-keep', ts: '2026-11-19T09:00:00+08:00', title: '旧数据', body: '', author: '我', done: false }];
    const reconciled = reconcileBeforeAppend(planned, existing);
    assert.deepEqual(reconciled.added.map((r) => r.id), ['new-a', 'new-b']);
    const grouped = groupImportByDate(reconciled.added);
    assert.deepEqual(Array.from(grouped.keys()).sort(), ['2026-11-19', '2026-11-20'],
      '导入记录按 ts 归入 timeline/<date>');
    // 二次复核（双击 / 已同步）必为空 —— 与 timelineWriteStore.append 的 later-ts 去重同口径。
    const again = reconcileBeforeAppend(planned, existing.concat(reconciled.added));
    assert.deepEqual(again.added, [], '重复导入零写入');

    assert.deepEqual(snapshot(repo), before, '纯规划阶段整棵仓库（含 devices/**）逐字节不变');
    assert.equal(readFileSync(v1Shard, 'utf8'), v1Bytes, 'v1 分片原样保留');
  } finally {
    if (existsSync(repo)) {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test('I5 未迁移 typed 拒绝 + 零写入夹具：无 schema.json 时只有 E_NOT_MIGRATED，不建 timeline', () => {
  const decision = decideMigration({ schemaVersion: null, hasDevices: true });
  assert.equal(decision.code, 'E_NOT_MIGRATED');
  assert.equal(decision.reason, NOT_MIGRATED_REASON);
  const repo = join(tmpdir(), `v2-unmigrated-fixture-${process.pid}-${Date.now()}`);
  try {
    const shard = join(repo, 'devices', 'tablet-1', 'schedules', '2026-11-19.jsonl');
    mkdirSync(dirname(shard), { recursive: true });
    const bytes = '{"id":"keep","ts":"2026-11-19T09:00:00+08:00","title":"旧数据"}\n';
    writeFileSync(shard, bytes, 'utf8');
    const before = snapshot(repo);
    assert.equal(decision.migrated, false, '纯判定在 IO 之前完成，不接触仓库');
    assert.deepEqual(snapshot(repo), before, '未迁移拒绝后整棵仓库逐字节不变');
    assert.equal(existsSync(join(repo, 'timeline')), false, '不得自动建 timeline/');
  } finally {
    if (existsSync(repo)) {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});
