// 「删除 + 5 秒撤销」纯逻辑测试：状态机边界 + 软删除标记的落盘/折叠/恢复。
//
// 前置：先构建纯逻辑层
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
//
// 软删除方案（`entry/src/main/ets/model/undoDelete.ts` 文件头）：
// - 删除 = 追加同 id、ts 更新的 `deleted:true` 版本（墓碑）；`foldById` 天然取到最新版本；
// - 撤销 = 再追加 `deleted:false` 版本；读取侧用 `isDeletedRecord` / `withoutDeleted` 过滤；
// - 5 秒窗口只是撤销机会，墓碑在 schedule 时已落盘（超时 confirm 不写任何东西）。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// undoDelete.ts 运行时依赖 ./types（tsc 输出的 import 不带 `.js`），这里补后缀解析。
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (
        error !== null &&
        typeof error === 'object' &&
        error.code === 'ERR_MODULE_NOT_FOUND' &&
        specifier.startsWith('.') &&
        !specifier.endsWith('.js')
      ) {
        return nextResolve(`${specifier}.js`, context);
      }
      throw error;
    }
  }
});

const { appendRecord, encodeRecord, foldById, parseJsonl } = await import('../.build/model/jsonl.js');
const { nextTsSameDate } = await import('../.build/common/date.js');
const {
  UNDO_TTL_MS,
  UndoDelete,
  isDeletedRecord,
  restoreRecord,
  softDeleteRecord,
  withoutDeleted
} = await import('../.build/model/undoDelete.js');

const here = dirname(fileURLToPath(import.meta.url));
const APP = join(here, '..', '..', 'entry', 'src', 'main', 'ets');
const INDEX_SOURCE = readFileSync(join(APP, 'pages', 'Index.ets'), 'utf8');
const ROW_SOURCE = readFileSync(join(APP, 'components', 'RecordRow.ets'), 'utf8');
const STORE_SOURCE = readFileSync(join(APP, 'services', 'scheduleStore.ets'), 'utf8');
const MODEL_SOURCE = readFileSync(join(APP, 'model', 'undoDelete.ts'), 'utf8');

const T0 = 1_700_000_000_000;

/** 造一条合法记录。 */
function makeRecord(overrides = {}) {
  return {
    id: 'rec-1',
    ts: '2026-11-16T09:30:00+08:00',
    title: '周会',
    body: '讨论排期',
    author: '我',
    done: false,
    ai_processed: false,
    ...overrides
  };
}

// ---------------------------------------------------------------- 状态机：schedule / isPending

test('schedule：登记后 isPending 为真，remaining 从 ttl 开始倒数', () => {
  const undo = new UndoDelete();
  assert.equal(undo.isPending(), false, '初始没有待撤销项');
  assert.equal(undo.remainingMs(T0), 0);
  assert.equal(undo.pendingId(), '');

  const result = undo.schedule('rec-1', UNDO_TTL_MS, T0);
  assert.deepEqual(result, { created: true, replacedRecordId: '' });
  assert.equal(undo.isPending(), true);
  assert.equal(undo.isPending('rec-1'), true);
  assert.equal(undo.isPending('rec-2'), false);
  assert.equal(undo.pendingId(), 'rec-1');
  assert.equal(undo.remainingMs(T0), 5000);
  assert.equal(undo.remainingSeconds(T0), 5);
  assert.equal(undo.ttlMs(), 5000);
  assert.equal(undo.dueAtMs(), T0 + 5000);
});

test('remainingMs 边界：只剩 1ms / 正好到期 / 已超时（不返回负数）', () => {
  const undo = new UndoDelete();
  undo.schedule('rec-1', 5000, T0);
  assert.equal(undo.remainingMs(T0 + 4999), 1);
  assert.equal(undo.remainingSeconds(T0 + 4999), 1, '向上取整：剩 1ms 显示 1s');
  assert.equal(undo.remainingMs(T0 + 5000), 0, '正好到期 = 0');
  assert.equal(undo.remainingMs(T0 + 5001), 0, '超时后钳到 0，不返回负数');
  assert.equal(undo.remainingMs(T0 + 60_000), 0);
  assert.equal(undo.remainingSeconds(T0 + 60_000), 0);
  assert.equal(undo.isExpired(T0 + 4999), false);
  assert.equal(undo.isExpired(T0 + 5000), true);
});

test('schedule 幂等：同 id 重复登记不刷新截止时间', () => {
  const undo = new UndoDelete();
  assert.equal(undo.schedule('rec-1', 5000, T0).created, true);
  const dueAt = undo.dueAtMs();

  // 2 秒后再点一次「删除」（同一行）：必须被忽略，且不续命
  const again = undo.schedule('rec-1', 5000, T0 + 2000);
  assert.equal(again.created, false, '同 id 重复登记必须返回 created=false');
  assert.equal(again.replacedRecordId, '');
  assert.equal(undo.dueAtMs(), dueAt, '截止时刻不得被刷新（否则一直撤不掉）');
  assert.equal(undo.remainingMs(T0 + 2000), 3000, '剩余时间按原截止时刻走');
});

test('schedule：空 id 忽略；ttlMs 非法回落默认；now 非法回落当前时间', () => {
  const undo = new UndoDelete();
  assert.deepEqual(undo.schedule('', 5000, T0), { created: false, replacedRecordId: '' });
  assert.deepEqual(undo.schedule('   ', 5000, T0), { created: false, replacedRecordId: '' });
  assert.equal(undo.isPending(), false);

  undo.schedule('rec-1', 0, T0);
  assert.equal(undo.ttlMs(), 5000, 'ttl<=0 回落默认 5s');
  undo.schedule('rec-2', Number.NaN, T0);
  assert.equal(undo.ttlMs(), 5000, 'ttl=NaN 回落默认 5s');

  const before = Date.now();
  undo.schedule('rec-3', 5000, Number.NaN);
  const dueAt = undo.dueAtMs();
  assert.ok(dueAt >= before + 5000 && dueAt <= Date.now() + 5000, '非法 now 必须回落 Date.now()');
});

test('schedule：登记新删除会顶替旧项，并报出被顶替的 id', () => {
  const undo = new UndoDelete();
  undo.schedule('rec-1', 5000, T0);
  const result = undo.schedule('rec-2', 5000, T0 + 1000);
  assert.equal(result.created, true);
  assert.equal(result.replacedRecordId, 'rec-1', '被顶替的删除视为已确认');
  assert.equal(undo.pendingId(), 'rec-2');
  assert.equal(undo.remainingMs(T0 + 1000), 5000, '新窗口从这次登记重新计时');
});

// ---------------------------------------------------------------- 状态机：cancel / confirm

test('cancel：窗口内撤销返回 id 并清空待撤销项', () => {
  const undo = new UndoDelete();
  undo.schedule('rec-1', 5000, T0);
  const canceled = undo.cancel();
  assert.equal(canceled, 'rec-1');
  assert.equal(undo.isPending(), false);
  assert.equal(undo.pendingId(), '');
  assert.equal(undo.remainingMs(T0 + 100), 0);
  assert.equal(undo.cancel(), '', '没有待撤销项时 cancel 返回空串');
});

test('confirm：超时后提交返回 id；没有待撤销项时返回空串', () => {
  const undo = new UndoDelete();
  undo.schedule('rec-1', 5000, T0);
  assert.equal(undo.isExpired(T0 + 5000), true);
  const committed = undo.confirm();
  assert.equal(committed, 'rec-1');
  assert.equal(undo.isPending(), false);
  assert.equal(undo.isExpired(T0 + 5000), false, '没有待撤销项时 isExpired 恒为 false');
  assert.equal(undo.confirm(), '');
});

test('reset：清空状态机（页面销毁路径）', () => {
  const undo = new UndoDelete();
  undo.schedule('rec-1', 5000, T0);
  undo.reset();
  assert.equal(undo.isPending(), false);
  assert.equal(undo.pendingId(), '');
});

// ---------------------------------------------------------------- 软删除标记与折叠

test('softDeleteRecord：只改 ts 与 deleted，其它字段原样保留，且不改入参', () => {
  const original = makeRecord({ ocr_text: '手写原文', ai_processed: true });
  const tombstone = softDeleteRecord(original, '2026-11-16T10:00:00+08:00');
  assert.equal(isDeletedRecord(tombstone), true);
  assert.equal(tombstone.ts, '2026-11-16T10:00:00+08:00');
  assert.equal(tombstone.id, original.id);
  assert.equal(tombstone.title, original.title);
  assert.equal(tombstone.body, original.body);
  assert.equal(tombstone.author, original.author);
  assert.equal(tombstone.ocr_text, '手写原文', 'ocr_text 必须原样保留');
  assert.equal(tombstone.ai_processed, true);
  assert.equal(isDeletedRecord(original), false, '原记录不得被改动');
  assert.equal(original.ts, '2026-11-16T09:30:00+08:00');
});

test('isDeletedRecord：缺省 / false / true / null 四种输入', () => {
  assert.equal(isDeletedRecord(makeRecord()), false, '没有 deleted 字段 = 可见');
  assert.equal(isDeletedRecord({ ...makeRecord(), deleted: false }), false);
  assert.equal(isDeletedRecord({ ...makeRecord(), deleted: true }), true);
  assert.equal(isDeletedRecord(null), false, 'null 安全（不抛错）');
  assert.equal(isDeletedRecord({ ...makeRecord(), deleted: 'yes' }), false, '非布尔值不算墓碑');
});

test('withoutDeleted：过滤墓碑、保持顺序、不改入参', () => {
  const alive = makeRecord({ id: 'a' });
  const dead = makeRecord({ id: 'b', deleted: true });
  const alsoAlive = makeRecord({ id: 'c' });
  const input = [alive, dead, alsoAlive];
  const visible = withoutDeleted(input);
  assert.deepEqual(
    visible.map((item) => item.id),
    ['a', 'c']
  );
  assert.equal(input.length, 3, '入参不得被修改');
});

test('encodeRecord 透传 deleted 字段（墓碑真的会写进 JSONL）', () => {
  const tombstone = softDeleteRecord(makeRecord(), '2026-11-16T10:00:00+08:00');
  const line = encodeRecord(tombstone).trim();
  const parsed = JSON.parse(line);
  assert.equal(parsed.deleted, true, 'deleted 必须出现在落盘行里');
  assert.equal(parsed.id, 'rec-1');
  // 解析回来仍然是合法记录（字段校验不拦扩展字段）
  const parsedBack = parseJsonl(line).records[0];
  assert.equal(isDeletedRecord(parsedBack), true);
});

test('5 秒内撤销：追加 deleted:false 后折叠结果恢复可见原字段（数据级回归）', () => {
  const original = makeRecord({ title: '周会', body: '讨论排期', ocr_text: '手写原文' });
  const tombstone = softDeleteRecord(original, nextTsSameDate(original.ts, new Date('2026-11-16T10:00:00+08:00')));

  let log = '';
  log = appendRecord(log, original);
  log = appendRecord(log, tombstone);

  // 删除后：折叠只有一条，且是墓碑
  let folded = foldById(parseJsonl(log).records);
  assert.equal(folded.length, 1);
  assert.equal(isDeletedRecord(folded[0]), true, '折叠必须取到墓碑（ts 更晚）');
  assert.deepEqual(withoutDeleted(folded), [], '读取侧过滤后这条记录消失');

  // 撤销：再追加 deleted:false 版本（ts 继续变大）
  const restored = restoreRecord(tombstone, nextTsSameDate(tombstone.ts, new Date('2026-11-16T10:00:02+08:00')));
  assert.equal(isDeletedRecord(restored), false);
  log = appendRecord(log, restored);

  folded = foldById(parseJsonl(log).records);
  assert.equal(folded.length, 1, '同 id 永远只有一条折叠结果');
  assert.equal(isDeletedRecord(folded[0]), false, '撤销后最新版本必须可见');
  assert.equal(folded[0].title, '周会', '撤销后字段原样恢复');
  assert.equal(folded[0].body, '讨论排期');
  assert.equal(folded[0].ocr_text, '手写原文');
  assert.equal(withoutDeleted(folded).length, 1);
  // 历史行一行没少：原记录 + 墓碑 + 恢复 = 3 行（只追加，绝不重写）
  assert.equal(log.split('\n').filter((line) => line.length > 0).length, 3);
});

test('超时后 confirm：墓碑版本仍在，记录保持删除状态', () => {
  const original = makeRecord();
  const tombstone = softDeleteRecord(original, nextTsSameDate(original.ts, new Date('2026-11-16T10:00:00+08:00')));
  const log = appendRecord(appendRecord('', original), tombstone);

  const undo = new UndoDelete();
  undo.schedule(original.id, 5000, T0);
  const committed = undo.confirm(); // 界面层在 isExpired() 为真时调用
  assert.equal(committed, original.id);

  const folded = foldById(parseJsonl(log).records);
  assert.equal(isDeletedRecord(folded[0]), true, '超时提交后记录仍是墓碑（无需补写）');
  assert.deepEqual(withoutDeleted(folded), []);
});

// ---------------------------------------------------------------- 源码级断言

test('源码级：Index 的删除走 undoDelete（软删除 + 撤销），不是物理删除', () => {
  assert.match(INDEX_SOURCE, /import \{[^}]*UndoDelete[^}]*\} from '\.\.\/model\/undoDelete'/);
  assert.match(INDEX_SOURCE, /import \{[^}]*softDeleteRecord[^}]*\} from '\.\.\/model\/undoDelete'/);
  assert.match(INDEX_SOURCE, /const tombstone: ScheduleRecord = softDeleteRecord\(target, nextTsSameDate\(target\.ts\)\)/);
  assert.match(INDEX_SOURCE, /const restored: ScheduleRecord = restoreRecord\(tombstone, nextTsSameDate\(tombstone\.ts\)\)/);
  assert.match(INDEX_SOURCE, /this\.undoState\.schedule\(id, UNDO_TTL_MS\)/);
  assert.match(INDEX_SOURCE, /this\.undoState\.cancel\(\)/, '撤销必须走状态机 cancel()');
  assert.match(INDEX_SOURCE, /this\.undoState\.confirm\(\)/, '超时必须走状态机 confirm()');
  assert.match(INDEX_SOURCE, /撤销（\$\{this\.undoSeconds\(\)\}s）/, '倒计时条要显示剩余秒数');
  assert.equal(
    /delete\s+this\.recordFile|unlinkSync/.test(INDEX_SOURCE),
    false,
    '首页不得物理删除文件（删除 = 追加墓碑）'
  );
});

test('源码级：删除入口在行尾按钮，读取侧统一过滤墓碑', () => {
  assert.match(ROW_SOURCE, /onDelete: \(\(id: string\) => void\) \| null = null/, 'RecordRow 要暴露 onDelete');
  assert.match(ROW_SOURCE, /Text\('删除'\)/, '行尾要有「删除」按钮');
  assert.match(INDEX_SOURCE, /onDelete: \(id: string\) => \{\s*this\.requestDelete\(id\);\s*\}/, '列表行必须接上 requestDelete');
  assert.match(STORE_SOURCE, /import \{ withoutDeleted \} from '\.\.\/model\/undoDelete'/, '存储层要引用过滤函数');
  const readDay = STORE_SOURCE.slice(STORE_SOURCE.indexOf('readDay(date: string)'), STORE_SOURCE.indexOf('listDates()'));
  assert.match(readDay, /withoutDeleted\(sortRecords\(foldById\(parsed\.records\)\)\)/, 'readDay 必须过滤墓碑');
  assert.equal(
    /appendRecord\(record: ScheduleRecord\): void[\s\S]{0,400}withoutDeleted/.test(STORE_SOURCE),
    false,
    'appendRecord 语义不得被过滤逻辑改动'
  );
});

test('源码级：undoDelete.ts 零 SDK 依赖（模型层可在 Node 里跑）', () => {
  assert.equal(/@kit\.|@ohos\./.test(MODEL_SOURCE), false, 'undoDelete.ts 不得 import 鸿蒙 SDK');
  assert.equal(/from '\.\.\/services\//.test(MODEL_SOURCE), false, 'undoDelete.ts 不得依赖 services 层');
  assert.match(MODEL_SOURCE, /export const UNDO_TTL_MS: number = 5000;/);
  for (const name of ['isDeletedRecord', 'withoutDeleted', 'softDeleteRecord', 'restoreRecord']) {
    assert.match(MODEL_SOURCE, new RegExp(`export function ${name}\\(`), `缺少导出 ${name}`);
  }
  assert.match(MODEL_SOURCE, /export class UndoDelete/, '缺少状态机类');
});
