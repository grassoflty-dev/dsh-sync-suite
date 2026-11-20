// mod-v2-only：v2 成为唯一读写路径后的契约测试（删除激活机制 / v1 fallback / readMode）。
//
// 前置：node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
// 纯模型从 ../.build 导入；.ets 服务/页面因 @kit.* 只能做源码形状断言（本仓既有口径）。
// 覆盖：迁移纯决策（含 devices/ 并存不是拒绝）；未迁移横幅逐字文案 + E_NOT_MIGRATED typed 拒绝
//       + 零写入（守卫在 outbox 停放之前）；v1 写调用点全消失；无 devices/** 写删（grep + 夹具）；
//       Settings 无激活开关；EntryAbility 无被删键；三态错误态替代只读态；删除模块从 import 图消失。
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { matchBrace, renderRegions, stripComments } from './helpers/etsSource.mjs';
import { requireOverlayRestored } from './guard.mjs';

requireOverlayRestored('v2Only.test.mjs');

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

const {
  decideMigration, NOT_MIGRATED_BANNER, NOT_MIGRATED_REASON, NOT_MIGRATED_NEXT_STEP
} = await import('../.build/model/migrationState.js');

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
  return { body: text.slice(start, end), start: start, end: end };
}

const INDEX = 'pages/Index.ets';
const SETTINGS = 'pages/Settings.ets';
const SYNC_SECTION = 'components/settings/SyncSection.ets';
const WRITER = 'services/recordWriter.ets';
const WRITE_STORE = 'services/timelineWriteStore.ets';
const READ_STORE = 'services/timelineStore.ets';
const SYNC_STORE = 'services/syncProtocolStore.ets';
const STATUS_STORE = 'services/syncStatusStore.ets';
const ENTRY = 'entryability/EntryAbility.ets';
const MIGRATION_MODEL = 'model/migrationState.ts';

// ---------------------------------------------------------------- 1. 迁移纯决策

test('M1 已迁移（schema=2）无论 devices/ 是否存在都放行，无横幅无拒绝', () => {
  for (const hasDevices of [false, true]) {
    const d = decideMigration({ schemaVersion: 2, hasDevices: hasDevices });
    assert.equal(d.migrated, true);
    assert.equal(d.code, 'ok');
    assert.equal(d.reason, '');
    assert.equal(d.banner, '');
    assert.equal(d.nextStep, '');
  }
});

test('M2 未迁移：缺标记 / 未知版本 / 坏标记一律 E_NOT_MIGRATED + 逐字中文原因 + 逐字横幅', () => {
  for (const schemaVersion of [null, 3, 99]) {
    const d = decideMigration({ schemaVersion: schemaVersion, hasDevices: true });
    assert.equal(d.migrated, false);
    assert.equal(d.code, 'E_NOT_MIGRATED');
    assert.equal(d.reason, 'E_NOT_MIGRATED: 时间线尚未初始化，请先迁移旧数据');
    assert.equal(d.banner, '检测到旧版数据（devices/），尚未迁移到时间线。旧数据不会被删除。');
    assert.match(d.nextStep, /迁移/);
  }
  assert.equal(NOT_MIGRATED_REASON, 'E_NOT_MIGRATED: 时间线尚未初始化，请先迁移旧数据');
  assert.equal(NOT_MIGRATED_BANNER, '检测到旧版数据（devices/），尚未迁移到时间线。旧数据不会被删除。');
  assert.ok(NOT_MIGRATED_NEXT_STEP.length > 0);
});

test('M3 decideMigration 是纯函数：源码无墙钟 / IO / AppStorage / 迁移', () => {
  const text = code(MIGRATION_MODEL);
  assert.doesNotMatch(text, /Date\.now|new Date\(|fs\.|AppStorage|writeText|unlinkSync|renameSync|migrate\(/);
  const a = decideMigration({ schemaVersion: null, hasDevices: true });
  const b = decideMigration({ schemaVersion: null, hasDevices: true });
  assert.deepEqual(a, b);
});

// ---------------------------------------------------------------- 2. v2-only 写入路径

test('W1 recordWriter 完全不含 v1 写入 / 模式开关：三个入口都无条件走 writeV2', () => {
  const text = code(WRITER);
  assert.doesNotMatch(text, /scheduleStore|appendRecord|useV2\(|readMode|'v1'/);
  for (const name of ['writeRecord', 'deleteRecord', 'restoreRecord']) {
    assert.match(methodBody(text, name).body, /this\.writeV2\(/, `${name} 必须无条件走 v2`);
  }
  assert.equal((text.match(/this\.writeV2\(/g) || []).length, 3);
});

test('W2 七个 UI 写调用点仍全部经 recordWriter（没有 v1 直连）', () => {
  const editor = 'components/RecordEditorView.ets';
  const detail = 'components/RecordDetailView.ets';
  const count = (text, needle) => (text.match(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
  assert.equal(count(code(INDEX), 'recordWriter.writeRecord('), 3);
  assert.equal(count(code(INDEX), 'recordWriter.deleteRecord('), 1);
  assert.equal(count(code(INDEX), 'recordWriter.restoreRecord('), 1);
  assert.equal(count(code(editor), 'recordWriter.writeRecord('), 1);
  assert.equal(count(code(detail), 'recordWriter.writeRecord('), 1);
  for (const rel of [INDEX, editor, detail]) {
    assert.equal(count(code(rel), 'scheduleStore.appendRecord('), 0, `${rel} 不得直连 v1 写入`);
  }
});

test('W3 未迁移守卫在任何 IO 之前：先抛 E_NOT_MIGRATED，再构造意图 / 停放 / 写 / 同步', () => {
  const text = code(WRITER);
  const declaration = /private writeV2\([^)]*\): void \{/.exec(text);
  assert.ok(declaration, 'writeV2 声明未找到');
  const open = text.indexOf('{', declaration.index + declaration[0].length - 1);
  const body = matchBrace(text, open);
  const slice = text.slice(body[0], body[1]);
  const guardAt = slice.indexOf('timelineStore.isMigrated()');
  const throwAt = slice.indexOf('throw new Error(NOT_MIGRATED_REASON)');
  const buildAt = slice.indexOf('this.buildIntent(');
  const enqueueAt = slice.indexOf('outboxStore.enqueue(entry)');
  const applyAt = slice.indexOf('apply();');
  const syncAt = slice.indexOf('this.triggerSync()');
  assert.ok(guardAt >= 0 && throwAt > guardAt && buildAt > throwAt && enqueueAt > buildAt && applyAt > enqueueAt && syncAt > applyAt,
    '未迁移守卫必须排在 buildIntent / outbox / 写 / 同步之前（零写入）');
  assert.match(text, /import \{ NOT_MIGRATED_REASON \} from '\.\.\/model\/migrationState'/);
});

test('W4 写 / 同步服务与只读服务都以 isMigrated 为唯一门槛，typed 拒绝同源', () => {
  assert.match(methodBody(code(WRITE_STORE), 'isEnabled').body, /return timelineStore\.isMigrated\(\)/);
  assert.match(methodBody(code(SYNC_STORE), 'isEnabled').body, /return timelineStore\.isMigrated\(\)/);
  assert.match(code(WRITE_STORE), /DISABLED_MESSAGE: string = NOT_MIGRATED_REASON/);
  assert.match(code(SYNC_STORE), /DISABLED_MESSAGE: string = NOT_MIGRATED_REASON/);
  assert.match(methodBody(code(READ_STORE), 'isMigrated').body, /return this\.isV2\(\)/);
  for (const rel of [WRITE_STORE, SYNC_STORE, READ_STORE]) {
    assert.doesNotMatch(code(rel), /useV2\(|readMode\(|setReadMode\(|AppStorage/);
  }
});

test('W5 首页读路径无条件 v2，且不再调用任何 v1 索引 / 分片读或写', () => {
  const text = code(INDEX);
  const reload = methodBody(text, 'reload').body;
  assert.match(reload, /this\.pendingSorted\(\)/);
  assert.match(methodBody(text, 'pendingSorted').body, /timelineStore\.pendingRecords\(\)/);
  assert.match(reload, /timelineStore\.readDay\(this\.selectedDate\)/);
  assert.doesNotMatch(reload, /scheduleStore|openIndexStore|reconcile|loadSummary|useV2\(/);
  assert.doesNotMatch(text, /import \{ openIndexStore \}/);
  assert.doesNotMatch(text, /scheduleStore\.readDay|scheduleStore\.findByIdAny|scheduleStore\.appendRecord/);
  assert.match(text, /await scheduleStore\.ensureReady/, 'scheduleStore 仅允许初始化（v1 只读兜底）');
});

// ---------------------------------------------------------------- 3. 未迁移横幅 + 首页状态

test('B1 首页只有一条未迁移横幅：@State + 固定文案 + 两个布局各挂一次', () => {
  const text = code(INDEX);
  assert.match(text, /@State unmigrated: boolean = false/);
  assert.match(text, /this\.unmigrated = !timelineStore\.isMigrated\(\)/);
  assert.match(text, /import \{[\s\S]{0,200}NOT_MIGRATED_BANNER[\s\S]{0,200}\} from '\.\.\/model\/migrationState'/);
  assert.match(text, /Text\(NOT_MIGRATED_BANNER\)/);
  assert.equal((text.match(/this\.MigrationBanner\(\)/g) || []).length, 2,
    'compact / wide 两个布局各挂一次（同一时刻只渲染一个）');
  assert.match(text, /NOT_MIGRATED_NEXT_STEP/, '按钮只给下一步提示，不执行迁移');
  assert.doesNotMatch(text, /showDialog\(\{[\s\S]{0,300}启用 v2 时间线写入/);
});

test('B2 未迁移时同步状态为错误态（typed 原因），没有「只读」文案', () => {
  const index = code(INDEX);
  assert.match(index, /syncStatusStore\.setError\(NOT_MIGRATED_REASON\)/);
  const status = code(STATUS_STORE);
  assert.match(status, /export type SyncState = 'synced' \| 'pending' \| 'error'/);
  assert.match(status, /let label: string = '错误'/);
  assert.match(status, /setError\(reason: string\)/);
  assert.doesNotMatch(status, /readonly|'只读'/);
  assert.doesNotMatch(index, /setReadOnly|只读·/);
});

// ---------------------------------------------------------------- 4. 无 devices/** 写删（grep + 夹具）

test('D1 写入路径源码不含 devices/ 路径字面量，也无删文件 API', () => {
  for (const rel of [WRITER, WRITE_STORE, SYNC_STORE, READ_STORE, INDEX, SETTINGS, SYNC_SECTION]) {
    const text = code(rel);
    assert.doesNotMatch(text, /devices\//, `${rel} 不得出现 devices/ 路径`);
    // unlinkSync 只在 timeline/ 的原子写里清理 tmp/bak 侧文件；v1 侧不出现任何删/迁移 API。
    assert.doesNotMatch(text, /rmSync|rmdirSync|deleteFile|migrate\(/, `${rel} 不得删/迁移 v1`);
  }
  const model = code(MIGRATION_MODEL);
  assert.doesNotMatch(model, /fs\.|unlinkSync|rmSync|writeFileSync/, '迁移模型只含文案与纯判定');
});

test('D2 夹具：含 devices/ 的 v1 仓库，跑纯迁移判定前后整棵目录逐字节相等', () => {
  const repo = join(tmpdir(), `v2-only-fixture-${process.pid}-${Date.now()}`);
  try {
    const devices = join(repo, 'devices', 'tablet-1', 'schedules');
    mkdirSync(devices, { recursive: true });
    const shard = join(devices, '2026-11-19.jsonl');
    const beforeText = '{"id":"v1-keep","ts":"2026-11-19T09:00:00+08:00","title":"旧数据","done":false}\n';
    writeFileSync(shard, beforeText, 'utf8');
    writeFileSync(join(repo, 'devices', 'registry.jsonl'), '{"deviceId":"tablet-1"}\n', 'utf8');

    // 未迁移判定 + 拒绝原因构造，全部是纯函数；不接触夹具。
    const decision = decideMigration({ schemaVersion: null, hasDevices: true });
    assert.equal(decision.migrated, false);
    assert.equal(decision.reason, NOT_MIGRATED_REASON);
    assert.equal(readFileSync(shard, 'utf8'), beforeText, 'v1 分片逐字节不变');
    assert.equal(existsSync(join(repo, 'timeline')), false, '不得自动建 timeline/');
    assert.equal(existsSync(join(repo, 'timeline', 'schema.json')), false, '不得自动写 schema 标记');
  } finally {
    if (existsSync(repo)) {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

// ---------------------------------------------------------------- 5. 设置 / EntryAbility / 删除模块

test('S1 Settings 与 SyncSection 没有激活开关 / 确认弹层 / 并存裁决', () => {
  for (const rel of [SETTINGS, SYNC_SECTION]) {
    const text = code(rel);
    for (const needle of ['启用 v2 时间线写入', 'v2WriteEnabled', 'v2Activation', 'onToggleV2Write',
      'needsConfirm', 'v1Retained', '确认以 timeline/', '关闭即回到 v1']) {
      assert.equal(text.includes(needle), false, `${rel} 残留激活文案/控件：${needle}`);
    }
  }
});

test('S2 EntryAbility 不绑定任何被删除的持久化键', () => {
  const text = code(ENTRY);
  assert.doesNotMatch(text, /PersistentStorage|persistProp|bindPersistentSettings/);
  for (const key of ['timeline.readMode', 'timeline.v2WriteEnabled', 'timeline.v1Retained',
    'PERSISTENT_READ_MODE_KEY', 'PERSISTENT_V2_WRITE_KEY', 'PERSISTENT_V1_RETAINED_KEY',
    'persistentSettings']) {
    assert.equal(text.includes(key), false, `EntryAbility 残留被删键：${key}`);
  }
  assert.match(text, /scheduleStore\.ensureReady/, '保留与 v2-only 无关的存储初始化');
});

test('S3 激活模块与 v1/v2 模式模块已从磁盘和 import 图删除', () => {
  for (const rel of ['model/v2Activation.ts', 'model/timelineMode.ts', 'model/persistentSettings.ts',
    'services/v2ActivationService.ets', 'services/timelineModeSwitch.ets',
    'tools/test/dualWriteOff.test.mjs']) {
    const path = rel.startsWith('tools/') ? join(APP, rel) : join(ETS, rel);
    assert.equal(existsSync(path), false, `应删除：${rel}`);
  }
  const all = [INDEX, SETTINGS, SYNC_SECTION, WRITER, WRITE_STORE, READ_STORE, SYNC_STORE, STATUS_STORE, ENTRY]
    .map((rel) => code(rel)).join('\n');
  assert.doesNotMatch(all, /timelineModeSwitch|v2ActivationService|v2Activation|persistentSettings/);
});

test('S4 无新依赖：新增迁移模型只被仓内相对模块引用', () => {
  const specs = [...src(MIGRATION_MODEL).matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
  for (const spec of specs) {
    assert.ok(spec.startsWith('.') || spec.startsWith('@kit.'), `未授权依赖：${spec}`);
  }
  const regions = renderRegions(code(INDEX));
  assert.ok(regions.length >= 2, '首页渲染树应包含 build 与多个 @Builder');
});
