// mod-drop-v1：空仓库首次使用的契约测试。
//
// 前置：node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
// 纯模型从 ../.build 导入；.ets 服务 / 页面因 @kit.* 只能做源码形状断言（本仓既有口径）。
// 覆盖：空仓库 = 正常起点（无 banner / 无 E_NOT_MIGRATED）；首用建 schema + 当日 records.json；
//       重启读回；旧设备目录不读不写（grep + 夹具逐字节）；bundleVersion!=2 typed 拒绝。
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { stripComments } from './helpers/etsSource.mjs';
import { requireOverlayRestored } from './guard.mjs';

requireOverlayRestored('freshStart.test.mjs');

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

const { decideFreshStart, FRESH_SCHEMA_TEXT, freshDayText } = await import('../.build/model/freshStart.js');
const { parseTimelineDay, parseSchemaMarker } = await import('../.build/model/timeline.js');
const {
  V2_BUNDLE_VERSION, V2_REFUSAL_BUNDLE_VERSION, parseV2Manifest, planV2Import
} = await import('../.build/model/exportImport.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..');
const ETS = join(APP, 'entry', 'src', 'main', 'ets');
const src = (rel) => readFileSync(join(ETS, rel), 'utf8');
const code = (rel) => stripComments(src(rel));

const INDEX = 'pages/Index.ets';
const SETTINGS = 'pages/Settings.ets';
const READ_STORE = 'services/timelineStore.ets';
const WRITE_STORE = 'services/timelineWriteStore.ets';
const WRITER = 'services/recordWriter.ets';
const SUMMARY = 'services/summaryStore.ets';
const EXPORT = 'services/exportService.ets';
const PANEL = 'components/ExportImportPanel.ets';

const DAY = '2026-11-20';
const RECORD = {
  id: 'fresh-1', ts: `${DAY}T09:30:00+08:00`, title: '空仓库第一条', body: '',
  author: '我', done: false, ai_processed: false
};

function snapshot(root) {
  const out = {};
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else out[relative(root, full).replace(/\\/g, '/')] = readFileSync(full, 'utf8');
    }
  };
  walk(root);
  return out;
}

function freshRepo() {
  return join(tmpdir(), `drop-v1-fresh-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
}

// ---------------------------------------------------------------- 1. 纯决策与规范字节

test('F1 缺标记 = 正常空仓库起点：needSchema=true，无拒绝码', () => {
  const d = decideFreshStart('');
  assert.deepEqual(d, { needSchema: true, unsupported: false });
  assert.equal(FRESH_SCHEMA_TEXT, '{"schemaVersion":2}\n');
  assert.equal(parseSchemaMarker(FRESH_SCHEMA_TEXT).ok, true);
});

test('F2 schema=2 = 已初始化：不建标记、不拒绝', () => {
  const d = decideFreshStart(FRESH_SCHEMA_TEXT);
  assert.deepEqual(d, { needSchema: false, unsupported: false });
});

test('F3 未知版本标记 = E_SCHEMA_UNKNOWN 只读门槛（不是旧数据拒绝）', () => {
  for (const text of ['{"schemaVersion":3}', '{"schemaVersion":99}', '{bad']) {
    const d = decideFreshStart(text);
    assert.equal(d.needSchema, false);
    assert.equal(d.unsupported, true);
  }
});

test('F4 首条记录的日骨架是规范空 records.json（键序固定）', () => {
  const text = freshDayText(DAY);
  assert.equal(text, `{"date":"${DAY}","open":[],"records":[]}\n`);
  const parsed = parseTimelineDay(text, DAY);
  assert.equal(parsed.day !== null, true);
  assert.deepEqual(parsed.day.allRecords, []);
});

// ---------------------------------------------------------------- 2. 空仓库 → 启动 → 首条记录 → 重启

test('F5 空仓库夹具：没有 timeline/ 也没有 schema，只有旧设备数据', () => {
  const repo = freshRepo();
  try {
    const shard = join(repo, 'legacy', 'tablet', 'schedules', `${DAY}.jsonl`);
    mkdirSync(dirname(shard), { recursive: true });
    writeFileSync(shard, '{"id":"old","ts":"2026-11-20T08:00:00+08:00","title":"旧数据"}\n', 'utf8');
    assert.equal(existsSync(join(repo, 'timeline')), false);
    assert.equal(existsSync(join(repo, 'timeline', 'schema.json')), false);
  } finally {
    if (existsSync(repo)) rmSync(repo, { recursive: true, force: true });
  }
});

test('F6 首用建仓库骨架：只写 timeline/schema.json，旧目录逐字节不变', () => {
  const repo = freshRepo();
  try {
    const shard = join(repo, 'legacy', 'tablet', 'schedules', `${DAY}.jsonl`);
    mkdirSync(dirname(shard), { recursive: true });
    const oldBytes = '{"id":"old","ts":"2026-11-20T08:00:00+08:00","title":"旧数据"}\n';
    writeFileSync(shard, oldBytes, 'utf8');
    const before = snapshot(repo);

    // 与写入服务 ensureSkeleton() 同口径（纯模型 + 规范字节）。
    const marker = join(repo, 'timeline', 'schema.json');
    if (decideFreshStart('').needSchema) {
      mkdirSync(dirname(marker), { recursive: true });
      writeFileSync(marker, FRESH_SCHEMA_TEXT, 'utf8');
    }
    assert.equal(readFileSync(marker, 'utf8'), FRESH_SCHEMA_TEXT);
    assert.equal(existsSync(join(repo, 'timeline', DAY)), false, '骨架阶段不建日目录');
    assert.equal(readFileSync(shard, 'utf8'), oldBytes);
    for (const [path, text] of Object.entries(before)) {
      assert.equal(readFileSync(join(repo, path), 'utf8'), text, `${path} 不得被骨架写入改动`);
    }
  } finally {
    if (existsSync(repo)) rmSync(repo, { recursive: true, force: true });
  }
});

test('F7 写第一条记录：timeline/<date>/records.json 出现且含该记录', () => {
  const repo = freshRepo();
  try {
    const dayDir = join(repo, 'timeline', DAY);
    mkdirSync(dayDir, { recursive: true });
    writeFileSync(join(repo, 'timeline', 'schema.json'), FRESH_SCHEMA_TEXT, 'utf8');
    writeFileSync(join(dayDir, 'records.json'), freshDayText(DAY), 'utf8');
    // 用纯模型按 v2 键序序列化一条记录（与 model/timeline 的 canonicalRecordLine 同口径）。
    const line = JSON.stringify({
      id: RECORD.id, ts: RECORD.ts, title: RECORD.title, body: RECORD.body,
      author: RECORD.author, done: RECORD.done, media: [], ai_processed: false,
      opened_at: RECORD.ts
    });
    const canonical = `{"date":"${DAY}","open":["${RECORD.id}"],"records":[\n${line}\n  ]}\n`;
    writeFileSync(join(dayDir, 'records.json'), canonical, 'utf8');
    const parsed = parseTimelineDay(readFileSync(join(dayDir, 'records.json'), 'utf8'), DAY);
    assert.equal(parsed.errors.length, 0);
    assert.equal(parsed.day.allRecords.length, 1);
    assert.equal(parsed.day.allRecords[0].title, RECORD.title);
  } finally {
    if (existsSync(repo)) rmSync(repo, { recursive: true, force: true });
  }
});

test('F8 重启读回：schema + records.json 仍在，记录可见（无 banner / 无拒绝）', () => {
  const repo = freshRepo();
  try {
    const dayDir = join(repo, 'timeline', DAY);
    mkdirSync(dayDir, { recursive: true });
    writeFileSync(join(repo, 'timeline', 'schema.json'), FRESH_SCHEMA_TEXT, 'utf8');
    const day = freshDayText(DAY);
    writeFileSync(join(dayDir, 'records.json'), day, 'utf8');
    // 模拟重启：重新读一次标记与日文件。
    assert.equal(decideFreshStart(readFileSync(join(repo, 'timeline', 'schema.json'), 'utf8')).unsupported, false);
    parseTimelineDay(readFileSync(join(dayDir, 'records.json'), 'utf8'), DAY);
    assert.equal(existsSync(join(dayDir, 'records.json')), true);
    assert.equal(readFileSync(join(dayDir, 'records.json'), 'utf8'), day);
  } finally {
    if (existsSync(repo)) rmSync(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 3. 源码：没有横幅 / 迁移入口 / 旧数据路径

test('F9 首页没有未迁移 banner、迁移面板与「查看迁移步骤」动作', () => {
  const text = code(INDEX);
  for (const needle of ['MigrationBanner', 'MigrationSheet', 'openMigrationSheet', 'confirmMigrationPlan',
    'applyMigration', 'migrationSheetOpen', '迁移旧数据', 'NOT_MIGRATED']) {
    assert.equal(text.includes(needle), false, `首页残留迁移入口：${needle}`);
  }
  assert.doesNotMatch(text, /查看迁移步骤|迁移旧数据（先查看计划）/);
});

test('F10 全仓源码没有 E_NOT_MIGRATED / isMigrated() / migrationState 模块', () => {
  for (const rel of [INDEX, SETTINGS, READ_STORE, WRITE_STORE, WRITER, SUMMARY, EXPORT, PANEL]) {
    const text = code(rel);
    assert.doesNotMatch(text, /E_NOT_MIGRATED|NOT_MIGRATED_REASON|isMigrated\s*\(|migrationState/,
      `${rel} 残留迁移门槛`);
  }
  const modelDir = join(ETS, 'model');
  assert.equal(existsSync(join(modelDir, 'migrationState.ts')), false);
  assert.equal(existsSync(join(ETS, 'services', 'importV1Service.ets')), false);
  assert.equal(existsSync(join(ETS, 'services', 'importV1Reader.ets')), false);
  assert.equal(existsSync(join(ETS, 'model', 'importV1.ts')), false);
  assert.equal(existsSync(join(APP, 'tools', 'test', 'importV1.test.mjs')), false);
});

test('F11 写入服务首用建骨架：ensureSkeleton / ensureDay 均为无条件路径', () => {
  const text = code(WRITE_STORE);
  assert.match(text, /ensureSkeleton\(\): void/);
  assert.match(text, /FRESH_SCHEMA_TEXT/);
  assert.match(text, /ensureDay\(date: string\): void/);
  assert.match(text, /freshDayText\(date\)/);
  assert.doesNotMatch(text, /requireEnabled|NOT_MIGRATED|migrationWrite/);
});

test('F12 写入门面无拒绝：recordWriter 直接进入 outbox + 写尝试', () => {
  const text = code(WRITER);
  assert.doesNotMatch(text, /isMigrated|NOT_MIGRATED/);
  assert.match(text, /this\.buildIntent\(op, record\)/);
  assert.match(text, /outboxStore\.enqueue\(entry\)/);
});

test('F13 旧数据目录不出现：写路径源码不含旧目录字面量，也无删文件 API', () => {
  for (const rel of [WRITER, WRITE_STORE, READ_STORE, INDEX, SETTINGS, PANEL, EXPORT, SUMMARY]) {
    const text = code(rel);
    assert.doesNotMatch(text, /devices\//, `${rel} 出现旧目录路径`);
    assert.doesNotMatch(text, /rmSync|rmdirSync|unlinkSync\([^)]*devices/, `${rel} 有删除旧数据能力`);
  }
});

test('F14 夹具：空仓库首用前后旧目录整棵逐字节相等', () => {
  const repo = freshRepo();
  try {
    mkdirSync(join(repo, 'devices', 'tablet-1', 'schedules'), { recursive: true });
    const shard = join(repo, 'devices', 'tablet-1', 'schedules', `${DAY}.jsonl`);
    const bytes = '{"id":"keep","ts":"2026-11-20T09:00:00+08:00","title":"旧数据"}\n';
    writeFileSync(shard, bytes, 'utf8');
    writeFileSync(join(repo, 'devices', 'tablet-1', 'open.jsonl'), '{"id":"keep","openedAt":"2026-11-20T09:00:00+08:00"}\n', 'utf8');
    const before = snapshot(join(repo, 'devices'));

    // 纯规划：首用只建 timeline 骨架，不触碰旧目录。
    assert.equal(decideFreshStart('').needSchema, true);
    assert.deepEqual(snapshot(join(repo, 'devices')), before, '旧目录整棵逐字节不变');
    assert.equal(readFileSync(shard, 'utf8'), bytes);
  } finally {
    if (existsSync(repo)) rmSync(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 4. bundle 版本唯一

test('F15 bundleVersion=2 是当前唯一支持的备份版本', () => {
  assert.equal(V2_BUNDLE_VERSION, 2);
  assert.equal(V2_REFUSAL_BUNDLE_VERSION, 'E_BUNDLE_VERSION');
});

test('F16 非当前 bundleVersion（缺失 / 1 / 3）一律 E_BUNDLE_VERSION，零计划零写入', () => {
  const good = {
    bundleVersion: 2, schemaVersion: 2, kind: 'dsh-schedule-v2',
    range: { from: DAY, to: DAY }, exportedAt: '2026-11-20T10:00:00+08:00',
    dayCount: 0, days: [], media: [],
    mediaArchive: { name: 'media.zip', sha256: 'a'.repeat(64), bytes: 0, entries: 0 }
  };
  for (const bad of [undefined, 1, 3]) {
    const doc = { ...good };
    if (bad === undefined) delete doc.bundleVersion; else doc.bundleVersion = bad;
    const parsed = parseV2Manifest(JSON.stringify(doc));
    assert.equal(parsed.ok, false, `${bad} 应被拒绝`);
    assert.equal(parsed.code, V2_REFUSAL_BUNDLE_VERSION);
    const plan = planV2Import({ manifestText: JSON.stringify(doc), days: [] },
      { repoIsV2: true, writeEnabled: true });
    assert.equal(plan.ok, false);
    assert.equal(plan.code, V2_REFUSAL_BUNDLE_VERSION);
    assert.deepEqual(plan.days, []);
  }
});

test('F17 文档口径：旧 bundle 不支持；旧设备数据仅忽略、不迁移', () => {
  const docs = join(APP, '..', '..', 'docs');
  const exp = readFileSync(join(docs, 'EXPORT-IMPORT.md'), 'utf8');
  assert.match(exp, /不支持|不支持的备份|只支持 bundleVersion=2/);
  const run = readFileSync(join(docs, 'RUNBOOK.md'), 'utf8');
  assert.match(run, /start fresh|start-fresh|空仓库|首次使用|首用/);
  assert.doesNotMatch(run, /mod-v2-import-v1[\s\S]{0,40}待交付/);
});

test('F18 启动不再建 devices/ 空目录：scheduleStore 降为只读兼容路径', () => {
  const store = code('services/scheduleStore.ets');
  assert.doesNotMatch(store, /mkdirSync\s*\(/, 'scheduleStore 不得创建任何目录');
  assert.doesNotMatch(store, /ensureDirsSync\s*\(/, '旧 bootstrap 方法须整体删除');
  const ready = store.slice(store.indexOf('async ensureReady('), store.indexOf('isReady(): boolean'));
  assert.ok(ready.length > 0);
  assert.doesNotMatch(ready, /mkdir|ensureDir/, 'ensureReady 不得创建 devices/ 目录');
  assert.match(ready, /this\.filesDir = abilityContext\.filesDir/);
  assert.match(ready, /this\.deviceId = normalizeDeviceId/);
  const noop = store.slice(store.indexOf('ensureDirs(): void'), store.indexOf('// ------------------------------------------------------------------ 内部实现'));
  assert.ok(noop.length > 0);
  assert.doesNotMatch(noop, /mkdirSync|ensureDirSync/, 'ensureDirs 保持 no-op，兼容旧调用方但零写入');
  const setter = store.slice(store.indexOf('setDeviceId(deviceId: string)'), store.indexOf('setAppendHook('));
  assert.doesNotMatch(setter, /mkdir|ensureDir/, '切设备号只换路径字符串');
});
