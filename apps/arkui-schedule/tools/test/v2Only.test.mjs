// mod-v2-only：v2 成为唯一读写路径后的契约测试（删除激活机制 / v1 fallback / readMode）。
//
// 前置：node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
// 纯模型从 ../.build 导入；.ets 服务/页面因 @kit.* 只能做源码形状断言（本仓既有口径）。
// 覆盖：v2-only 写入路径、无 banner / 迁移入口、devices/** 零读写（fresh-start 详见 freshStart.test.mjs）
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
const FRESH_MODEL = 'model/freshStart.ts';

// ---------------------------------------------------------------- 1. 迁移纯决策

// ---------------------------------------------------------------- 2. v2-only 写入路径

test('W1 recordWriter 完全不含 v1 写入 / 模式开关：三个入口都无条件走 writeV2', () => {
  const text = code(WRITER);
  assert.doesNotMatch(text, /scheduleStore|appendRecord|useV2\(|readMode|'v1'/);
  for (const name of ['writeRecord', 'deleteRecord', 'restoreRecord']) {
    assert.match(methodBody(text, name).body, /this\.writeV2\(/, `${name} 必须无条件走 v2`);
  }
  assert.equal((text.match(/this\.writeV2\(/g) || []).length, 3);
});

test('W2 六个 UI 写调用点仍全部经 recordWriter（没有 v1 直连）', () => {
  const editor = 'components/RecordEditorView.ets';
  const detail = 'components/RecordDetailView.ets';
  const count = (text, needle) => (text.match(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
  // mod-home-drop-quick: 快捷记录写路径已删除；剩余 toggle / AI write-back + delete + restore 仍全经 recordWriter。
  assert.doesNotMatch(code(INDEX), /submitQuickRecord|QuickRecordBar/,
    '快捷记录写路径已删除，不得再出现第二个创建入口');
  assert.equal(count(code(INDEX), 'recordWriter.writeRecord('), 2);
  assert.equal(count(code(INDEX), 'recordWriter.deleteRecord('), 1);
  assert.equal(count(code(INDEX), 'recordWriter.restoreRecord('), 1);
  assert.equal(count(code(editor), 'recordWriter.writeRecord('), 1);
  assert.equal(count(code(detail), 'recordWriter.writeRecord('), 1);
  for (const rel of [INDEX, editor, detail]) {
    assert.equal(count(code(rel), 'scheduleStore.appendRecord('), 0, `${rel} 不得直连 v1 写入`);
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
// ---------------------------------------------------------------- 4. 无 devices/** 写删（grep + 夹具）

test('D1 写入路径源码不含 devices/ 路径字面量，也无删文件 API', () => {
  for (const rel of [WRITER, WRITE_STORE, SYNC_STORE, READ_STORE, INDEX, SETTINGS, SYNC_SECTION]) {
    const text = code(rel);
    assert.doesNotMatch(text, /devices\//, `${rel} 不得出现 devices/ 路径`);
    // unlinkSync 只在 timeline/ 的原子写里清理 tmp/bak 侧文件；v1 侧不出现任何删/迁移 API。
    assert.doesNotMatch(text, /rmSync|rmdirSync|deleteFile|migrate\(/, `${rel} 不得删/迁移 v1`);
  }
  const fresh = code(FRESH_MODEL);
  assert.doesNotMatch(fresh, /fs\.|unlinkSync|rmSync|writeFileSync/, 'freshStart 只含纯决策与规范字节');
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
