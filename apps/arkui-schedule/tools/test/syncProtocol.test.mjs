// mod-v2-sync-protocol：§9/§11 协议核心（纯模型）行为测试 + 同步服务静态契约测试。
//
// 前置构建：node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
// 纯模型 import ../.build/model/syncProtocol.js；服务层 import @kit.*，只能在 Node 里做源码形状断言。
//
// 覆盖：assertWritable 四结果与消息、makeIntentId 稳定性、markAttempt 3/4/5、replayable 过滤与 FIFO、
//       SHA-256 对拍 Node crypto、unionDay 远端/本地/较晚 ts/同 ts 字节胜者/相同行/删除胜/恢复/清行/
//       顺序无关/open 派生/conflicts 去重/确定性、isApplied 四 op、outboxAfterReplay 出队与失败留存、
//       模型无墙钟；服务侧：未启用先抛错、无 force-push / merge / pull --rebase、reset --hard 仅在拒推路径、
//       outbox 在 git-repo 外 + tmp/rename、无 devices/ 写、无 AppStorage 写、门禁先于写、7 步命令序列。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { matchBrace, stripComments } from './helpers/etsSource.mjs';
import { requireOverlayRestored } from './guard.mjs';

requireOverlayRestored('syncProtocol.test.mjs');

// 编译产物里的 `import ... from './timeline'` 不带 .js（ArkTS 要求），Node ESM 不推断扩展名；
// 与 timelineWrite.test.mjs 同口径，只为测试进程补后缀解析。
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error !== null && typeof error === 'object' &&
          error.code === 'ERR_MODULE_NOT_FOUND' &&
          specifier.startsWith('.') && !specifier.endsWith('.js')) {
        return nextResolve(`${specifier}.js`, context);
      }
      throw error;
    }
  }
});

const { canonicalRecordLine, parseTimelineDay, parseLedger } = await import('../.build/model/timeline.js');
const { buildRecordsText, ledgerDeleteLine, ledgerRestoreLine, planUpsert } = await import('../.build/model/timelineWrite.js');
const {
  assertWritable, headRelation, isFastForwardable, WRITE_GATE_MESSAGES,
  MAX_ATTEMPTS, SYNC_RETRY_ERROR, E_TS_SHAPE,
  sha256Hex, makeIntentId, markAttempt, replayable, conflictsLine,
  normalizeForWrite, unionDay, isApplied, outboxAfterReplay, openIdsForDay
} = await import('../.build/model/syncProtocol.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..');
const SERVICE_PATH = join(APP, 'entry', 'src', 'main', 'ets', 'services', 'syncProtocolStore.ets');
const MODEL_PATH = join(APP, 'entry', 'src', 'main', 'ets', 'model', 'syncProtocol.ts');
const SERVICE = readFileSync(SERVICE_PATH, 'utf8');
const MODEL = readFileSync(MODEL_PATH, 'utf8');
const SERVICE_CODE = stripComments(SERVICE);
const MODEL_CODE = stripComments(MODEL);

const DAY = '2026-11-19';
const T0930 = `${DAY}T09:30:00+08:00`;
const T1000 = `${DAY}T10:00:00+08:00`;
const T1100 = `${DAY}T11:00:00+08:00`;
const T1400 = `${DAY}T14:00:00+08:00`;
const NOW = new Date('2026-11-19T10:02:11.000Z');
const SHORT = { head: 'a'.repeat(40), other: 'b'.repeat(40) };

function rec(overrides = {}) {
  return {
    id: 'a1', ts: T0930, title: '标题', body: '', author: '我', done: false,
    media: [], ai_processed: false, opened_at: T0930, ...overrides
  };
}

function dayText(records) {
  return buildRecordsText(DAY, records);
}

/** unionDay 的 DayTexts 入参（records + 两本账本）。 */
function dt(records = '', deleted = '', restore = '') {
  return { records, deleted, restore };
}

function entry(op, overrides = {}) {
  return {
    intentId: `${op}-intent`, op, date: DAY, id: 'a1', ts: T0930, line: '',
    enqueuedAt: T1000, attempts: 0, state: 'pending', lastError: '', ...overrides
  };
}

/** 从服务源码取一个方法的大括号区间（注释已剥离，brace 配平）。 */
function methodBody(code, name) {
  const matched = new RegExp(`(?:private |async |public )*${name}\\s*\\([^)]*\\)[^;{]*\\{`).exec(code);
  assert.ok(matched, `找不到方法 ${name}`);
  const start = matched.index + matched[0].length - 1;
  const [from, to] = matchBrace(code, start);
  return code.slice(from, to);
}

// ---------------------------------------------------------------- §11 门禁（4 结果 + 优先级）

test('1 assertWritable ok: schema=2 + branch main + HEAD==origin/main', () => {
  const r = assertWritable({ schemaVersion: 2, branch: 'main', headSha: SHORT.head, originMainSha: SHORT.head });
  assert.deepEqual(r, { ok: true, code: 'ok', message: '可写' });
});

test('2 assertWritable E_SCHEMA_UNKNOWN for null schema', () => {
  const r = assertWritable({ schemaVersion: null, branch: 'main', headSha: SHORT.head, originMainSha: SHORT.head });
  assert.deepEqual(r, { ok: false, code: 'E_SCHEMA_UNKNOWN', message: '只读（仓库结构版本不认识，见 §11）' });
});

test('3 assertWritable E_SCHEMA_UNKNOWN for version 99', () => {
  const r = assertWritable({ schemaVersion: 99, branch: 'main', headSha: SHORT.head, originMainSha: SHORT.head });
  assert.equal(r.code, 'E_SCHEMA_UNKNOWN');
  assert.equal(r.message, WRITE_GATE_MESSAGES.E_SCHEMA_UNKNOWN);
});

test('4 assertWritable E_BRANCH_MISMATCH', () => {
  const r = assertWritable({ schemaVersion: 2, branch: 'dev', headSha: SHORT.head, originMainSha: SHORT.head });
  assert.deepEqual(r, { ok: false, code: 'E_BRANCH_MISMATCH', message: '分支不是 main，拒绝写入' });
});

test('5 assertWritable E_NOT_SYNCED when HEAD differs from origin/main', () => {
  const r = assertWritable({ schemaVersion: 2, branch: 'main', headSha: SHORT.head, originMainSha: SHORT.other });
  assert.deepEqual(r, { ok: false, code: 'E_NOT_SYNCED', message: '本地 HEAD 与 origin/main 不一致，请先同步' });
});

test('6 gate priority: schema before branch before sha', () => {
  assert.equal(assertWritable({ schemaVersion: 3, branch: 'dev', headSha: 'x', originMainSha: 'y' }).code, 'E_SCHEMA_UNKNOWN');
  assert.equal(assertWritable({ schemaVersion: 2, branch: 'dev', headSha: 'x', originMainSha: 'y' }).code, 'E_BRANCH_MISMATCH');
  assert.equal(assertWritable({ schemaVersion: 2, branch: 'main', headSha: 'x', originMainSha: 'y' }).code, 'E_NOT_SYNCED');
});

test('7 four gate messages are distinct verbatim Chinese strings', () => {
  const values = Object.values(WRITE_GATE_MESSAGES);
  assert.equal(values.length, 4);
  assert.equal(new Set(values).size, 4);
  for (const value of values) {
    assert.match(value, /[\u4e00-\u9fa5]/);
  }
});

// ---------------------------------------------------------------- outbox / 意图（P1-1 / P1-2）

test('8 MAX_ATTEMPTS is exactly 4', () => {
  assert.equal(MAX_ATTEMPTS, 4);
});

test('9 makeIntentId is stable for the same payload', () => {
  const a = makeIntentId(DAY, 'a1', T0930, 'upsert');
  const b = makeIntentId(DAY, 'a1', T0930, 'upsert');
  assert.equal(a, b);
  assert.match(a, /^upsert:2026-11-19:a1:/);
});

test('10 makeIntentId differs for any changed payload component', () => {
  const base = makeIntentId(DAY, 'a1', T0930, 'upsert');
  assert.notEqual(base, makeIntentId('2026-11-20', 'a1', T0930, 'upsert'));
  assert.notEqual(base, makeIntentId(DAY, 'b2', T0930, 'upsert'));
  assert.notEqual(base, makeIntentId(DAY, 'a1', T1000, 'upsert'));
  assert.notEqual(base, makeIntentId(DAY, 'a1', T0930, 'delete'));
});

test('11 sha256Hex matches Node crypto on ASCII, UTF-8 and multi-block input', () => {
  for (const text of ['', 'abc', 'hello world', '中文测试', 'x'.repeat(200), JSON.stringify(rec())]) {
    const expected = createHash('sha256').update(text, 'utf8').digest('hex');
    assert.equal(sha256Hex(text), expected, text.slice(0, 24));
  }
});

test('12 markAttempt 3 -> 4 enters failed terminal state', () => {
  const r = markAttempt(entry('upsert', { attempts: 3 }), 'boom');
  assert.equal(r.attempts, 4);
  assert.equal(r.state, 'failed');
  assert.equal(r.lastError, 'boom');
});

test('13 markAttempt 4 -> 5 / 5 -> 6 stay failed (cross-session counter keeps growing)', () => {
  assert.deepEqual(
    { a: markAttempt(entry('upsert', { attempts: 4 }), 'e').attempts, s: markAttempt(entry('upsert', { attempts: 4 }), 'e').state },
    { a: 5, s: 'failed' }
  );
  const six = markAttempt(entry('upsert', { attempts: 5, state: 'failed' }), 'e');
  assert.equal(six.attempts, 6);
  assert.equal(six.state, 'failed');
});

test('14 markAttempt 1 -> 2 / 2 -> 3 stay pending', () => {
  assert.equal(markAttempt(entry('upsert', { attempts: 1 }), '').state, 'pending');
  const r = markAttempt(entry('upsert', { attempts: 2 }), '');
  assert.equal(r.attempts, 3);
  assert.equal(r.state, 'pending');
});

test('15 markAttempt preserves payload fields (immutable intent payload)', () => {
  const original = entry('upsert', { line: '{"payload":1}', enqueuedAt: T0930, intentId: 'keep-me' });
  const r = markAttempt(original, 'e');
  assert.equal(r.intentId, 'keep-me');
  assert.equal(r.line, '{"payload":1}');
  assert.equal(r.date, DAY);
  assert.equal(r.id, 'a1');
  assert.equal(r.ts, T0930);
  assert.equal(r.enqueuedAt, T0930);
  assert.equal(original.attempts, 0); // 入参不改
});

test('16 replayable filters failed and exhausted attempts, keeps FIFO order', () => {
  const list = [
    entry('upsert', { intentId: 'a' }),
    entry('delete', { intentId: 'b', state: 'syncing' }),
    entry('restore', { intentId: 'c', state: 'failed', attempts: 1 }),
    entry('purge', { intentId: 'd', attempts: 4, state: 'failed' }),
    entry('upsert', { intentId: 'e', attempts: 3, state: 'pending' })
  ];
  assert.deepEqual(replayable(list).map((e) => e.intentId), ['a', 'b', 'e']);
});

test('17 replayable returns a new array and does not mutate input', () => {
  const list = [entry('upsert', { intentId: 'a' })];
  const out = replayable(list);
  assert.notEqual(out, list);
  assert.equal(out[0], list[0]);
  assert.equal(list.length, 1);
});

// ---------------------------------------------------------------- conflicts.jsonl（§4）

test('18 conflictsLine shape matches the migration tool and dedupeKey=sha256(losingLine)', () => {
  const losing = canonicalRecordLine(rec());
  const row = conflictsLine('a1', T0930, losing, '2026-11-19T01:30:00.000Z');
  const parsed = JSON.parse(row);
  assert.deepEqual(Object.keys(parsed), ['id', 'ts', 'losingLine', 'decidedAt', 'dedupeKey']);
  assert.equal(parsed.id, 'a1');
  assert.equal(parsed.ts, T0930);
  assert.equal(parsed.losingLine, losing);
  assert.equal(parsed.decidedAt, '2026-11-19T01:30:00.000Z');
  assert.equal(parsed.dedupeKey, createHash('sha256').update(losing, 'utf8').digest('hex'));
});

test('19 conflictsLine is one JSON line (no embedded newline)', () => {
  const row = conflictsLine('a1', T0930, canonicalRecordLine(rec()), 'x');
  assert.equal(row.split('\n').length, 1);
});

// ---------------------------------------------------------------- unionDay（§9 阶段一 + 二）

test('20 unionDay remote-only reproduces buildRecordsText byte-for-byte', () => {
  const records = [rec()];
  const u = unionDay(DAY, dt(dayText(records)), dt(), [], NOW);
  assert.equal(u.text, dayText(records));
  assert.equal(u.added, 0);
  assert.deepEqual(u.conflicts, []);
  assert.equal(parseTimelineDay(u.text, DAY).day.allRecords.length, 1);
});

test('21 unionDay local-only reproduces buildRecordsText byte-for-byte', () => {
  const records = [rec({ title: '本地' })];
  const u = unionDay(DAY, dt(), dt(dayText(records)), [], NOW);
  assert.equal(u.text, dayText(records));
  assert.equal(u.added, 0);
});

test('22 unionDay different ts: later ts silently wins, no conflict', () => {
  const early = rec({ ts: T0930, body: '早' });
  const late = rec({ ts: T1400, body: '晚' });
  const u = unionDay(DAY, dt(dayText([early])), dt(dayText([late])), [], NOW);
  assert.equal(u.text, dayText([late]));
  assert.deepEqual(u.conflicts, []);
  assert.equal(parseTimelineDay(u.text, DAY).day.allRecords[0].body, '晚');
});

test('23 unionDay equal ts: UTF-8 byte-larger canonical line wins, loser -> conflicts.jsonl', () => {
  const smaller = rec({ body: 'a' });
  const larger = rec({ body: 'z' });
  const u = unionDay(DAY, dt(dayText([smaller])), dt(dayText([larger])), [], NOW);
  assert.equal(u.text, dayText([larger]));
  assert.equal(u.conflicts.length, 1);
  const row = JSON.parse(u.conflicts[0]);
  assert.equal(row.losingLine, canonicalRecordLine(smaller));
  assert.equal(row.decidedAt, '2026-11-19T01:30:00.000Z'); // 由输入 ts 派生
});

test('24 unionDay identical canonical lines: single row, no conflict', () => {
  const same = rec();
  const u = unionDay(DAY, dt(dayText([same])), dt(dayText([same])), [], NOW);
  assert.equal(u.text, dayText([same]));
  assert.deepEqual(u.conflicts, []);
  assert.equal(parseTimelineDay(u.text, DAY).day.allRecords.length, 1);
});

test('25 unionDay ORDER-INDEPENDENCE: swapping remote/local yields identical text and conflicts', () => {
  const a = rec({ body: 'a' });
  const z = rec({ body: 'z' });
  const b = rec({ id: 'b2', ts: T1400, title: '乙' });
  const forward = unionDay(DAY, dt(dayText([a, b])), dt(dayText([z])), [], NOW);
  const swapped = unionDay(DAY, dt(dayText([z])), dt(dayText([a, b])), [], NOW);
  assert.equal(swapped.text, forward.text, 'text must be order-independent');
  assert.deepEqual(swapped.conflicts, forward.conflicts, 'conflicts must be order-independent');
  assert.equal(swapped.added, forward.added);
});

test('26 unionDay recomputes open from closed_at (not done, not cached open)', () => {
  const doneClosed = rec({ id: 'x1', done: true, closed_at: T1400 });
  const notDoneOpen = rec({ id: 'x2', done: false, closed_at: undefined });
  const u = unionDay(DAY, dt(dayText([doneClosed, notDoneOpen])), dt(), [], NOW);
  const parsed = parseTimelineDay(u.text, DAY);
  assert.deepEqual(parsed.day.open, ['x2']);
  assert.deepEqual(openIdsForDay(DAY, u.text, '', ''), ['x2']);
});

test('27 unionDay replay upsert: added=1, applied contains intentId', () => {
  const r = rec({ title: '新' });
  const intent = entry('upsert', { line: canonicalRecordLine(r), id: r.id, ts: r.ts });
  const u = unionDay(DAY, dt(), dt(), [intent], NOW);
  assert.equal(u.added, 1);
  assert.deepEqual(u.applied, ['upsert-intent']);
  assert.equal(u.text, dayText([r]));
});

test('28 unionDay replay upsert is idempotent: second identical replay adds 0 rows', () => {
  const r = rec();
  const first = entry('upsert', { intentId: 'one', line: canonicalRecordLine(r) });
  const u1 = unionDay(DAY, dt(), dt(), [first], NOW);
  const second = entry('upsert', { intentId: 'two', line: canonicalRecordLine(r) });
  const u2 = unionDay(DAY, dt(u1.text), dt(), [second], NOW);
  assert.equal(u2.added, 0);
  assert.deepEqual(u2.applied, ['two']);
  assert.equal(u2.text, u1.text);
});

test('29 unionDay delete wins over upsert: upsert dropped, row invisible via ledger', () => {
  const r = rec();
  const del = entry('delete', {
    intentId: 'del', id: r.id, ts: T1100,
    line: ledgerDeleteLine(r.id, T1100, T1100)
  });
  const up = entry('upsert', {
    intentId: 'up', id: r.id, ts: T1400, line: canonicalRecordLine(r)
  });
  const u = unionDay(DAY, dt(dayText([r])), dt(), [del, up], NOW);
  assert.ok(u.dropped.includes('up'));
  assert.ok(!u.applied.includes('up'));
  assert.deepEqual(openIdsForDay(DAY, u.text, del.line, ''), []);
});

test('30 unionDay restore after delete lets the upsert apply again', () => {
  const r = rec({ ts: T1400 });
  const del = entry('delete', { intentId: 'del', id: r.id, ts: T1000, line: ledgerDeleteLine(r.id, T1000, T1000) });
  const restore = entry('restore', { intentId: 'res', id: r.id, ts: T1100, line: ledgerRestoreLine(r.id, T1100, T1100) });
  const up = entry('upsert', { intentId: 'up', id: r.id, ts: T1400, line: canonicalRecordLine(r) });
  // 远端不预置该记录，才能观察到「恢复后 upsert 真正落地」；预置同规范行属幂等 no-op。
  const u = unionDay(DAY, dt(), dt(), [del, restore, up], NOW);
  assert.ok(!u.dropped.includes('up'));
  assert.equal(u.added, 1);
});

test('31 unionDay purge intent physically removes the row (ledger present)', () => {
  const r = rec();
  const del = entry('delete', { intentId: 'del', id: r.id, ts: T1000, line: ledgerDeleteLine(r.id, T1000, T1000) });
  const purge = entry('purge', { intentId: 'purge', id: r.id, ts: T1100, line: ledgerDeleteLine(r.id, T1100, T1100) });
  const u = unionDay(DAY, dt(dayText([r])), dt(), [del, purge], NOW);
  assert.ok(u.applied.includes('purge'));
  assert.deepEqual(parseTimelineDay(u.text, DAY).day.allRecords, []);
});

test('32 unionDay conflict rows dedupe by (id,ts,dedupeKey)', () => {
  const smaller = rec({ body: 'a' });
  const larger = rec({ body: 'z' });
  const first = unionDay(DAY, dt(dayText([smaller])), dt(dayText([larger])), [], NOW);
  const again = unionDay(DAY, dt(dayText([smaller])), dt(dayText([larger])), [], NOW);
  assert.deepEqual(again.conflicts, first.conflicts);
  const keys = first.conflicts.map((line) => {
    const o = JSON.parse(line);
    return `${o.id}\u0000${o.ts}\u0000${o.dedupeKey}`;
  });
  assert.equal(new Set(keys).size, keys.length);
});

test('33 unionDay determinism: identical inputs (including injected now) yield byte-identical result', () => {
  const a = rec({ body: '甲' });
  const z = rec({ body: 'z' });
  const entries = [entry('upsert', { intentId: 'i', line: canonicalRecordLine(a) })];
  const first = unionDay(DAY, dt(dayText([a])), dt(dayText([z])), entries, NOW);
  const second = unionDay(DAY, dt(dayText([a])), dt(dayText([z])), entries, NOW);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test('34 unionDay output always passes the §3 parser self-check', () => {
  const u = unionDay(DAY, dt(dayText([rec()])), dt(dayText([rec({ id: 'b2', ts: T1400 })])), [], NOW);
  const parsed = parseTimelineDay(u.text, DAY);
  assert.notEqual(parsed.day, null);
  assert.deepEqual(parsed.errors, []);
  assert.equal(u.text.endsWith('\n'), true);
});

// ---------------------------------------------------------------- isApplied（P1-2 四 op）

test('35 isApplied upsert: exact canonical line present', () => {
  const r = rec();
  assert.equal(isApplied(entry('upsert', { line: canonicalRecordLine(r) }), dayText([r]), '', ''), true);
});

test('36 isApplied upsert: same (id,ts) with different content counts as applied (§4 resolved)', () => {
  const stored = rec({ body: 'stored' });
  const incoming = rec({ body: 'incoming' });
  assert.equal(isApplied(entry('upsert', { line: canonicalRecordLine(incoming) }), dayText([stored]), '', ''), true);
});

test('37 isApplied upsert: false when id absent', () => {
  assert.equal(isApplied(entry('upsert', { line: canonicalRecordLine(rec()) }), dayText([]), '', ''), false);
});

test('38 isApplied delete: matched by (id,ts) in deleted.jsonl', () => {
  const line = ledgerDeleteLine('a1', T1000, T1000);
  assert.equal(isApplied(entry('delete', { id: 'a1', ts: T1000, line }), '', `${line}\n`, ''), true);
  assert.equal(isApplied(entry('delete', { id: 'a1', ts: T1100, line }), '', `${line}\n`, ''), false);
});

test('39 isApplied delete: matched by intentId in deleted.jsonl', () => {
  const line = JSON.stringify({ id: 'a1', ts: T1000, deletedAt: T1000, intentId: 'my-id' });
  assert.equal(isApplied(entry('delete', { intentId: 'my-id', id: 'a1', ts: T1400 }), '', `${line}\n`, ''), true);
});

test('40 isApplied restore: matched by (id,ts) in restore.jsonl', () => {
  const line = ledgerRestoreLine('a1', T1100, T1100);
  assert.equal(isApplied(entry('restore', { id: 'a1', ts: T1100, line }), '', '', `${line}\n`), true);
  assert.equal(isApplied(entry('restore', { id: 'a1', ts: T1000, line }), '', '', `${line}\n`), false);
});

test('41 isApplied purge: true only when row absent and ledger present', () => {
  const line = ledgerDeleteLine('a1', T1000, T1000);
  assert.equal(isApplied(entry('purge', { id: 'a1' }), '', `${line}\n`, ''), true);
  assert.equal(isApplied(entry('purge', { id: 'a1' }), dayText([rec()]), `${line}\n`, ''), false);
  assert.equal(isApplied(entry('purge', { id: 'a1' }), '', '', ''), false);
});

// ---------------------------------------------------------------- outboxAfterReplay

test('42 outboxAfterReplay removes applied ids from the queue', () => {
  const out = outboxAfterReplay(
    [entry('upsert', { intentId: 'a' }), entry('delete', { intentId: 'b' })], ['a'], [], [], NOW);
  assert.deepEqual(out.map((e) => e.intentId), ['b']);
});

test('43 outboxAfterReplay retains failed ids with attempts+1 and typed lastError', () => {
  const out = outboxAfterReplay(
    [entry('upsert', { intentId: 'a', attempts: 1 })], [], ['a'], [], NOW);
  assert.equal(out.length, 1);
  assert.equal(out[0].attempts, 2);
  assert.equal(out[0].lastError, SYNC_RETRY_ERROR);
  assert.equal(out[0].state, 'pending');
});

test('44 outboxAfterReplay keeps FIFO order and fills empty enqueuedAt from injected now', () => {
  const list = [
    entry('upsert', { intentId: 'a', enqueuedAt: '' }),
    entry('delete', { intentId: 'b', enqueuedAt: T0930 })
  ];
  const out = outboxAfterReplay(list, [], [], [], NOW);
  assert.deepEqual(out.map((e) => e.intentId), ['a', 'b']);
  assert.equal(out[0].enqueuedAt, NOW.toISOString());
  assert.equal(out[1].enqueuedAt, T0930);
});

test('45 outboxAfterReplay does not mutate its input', () => {
  const list = [entry('upsert', { intentId: 'a', attempts: 1 })];
  outboxAfterReplay(list, ['a'], ['a'], [], NOW);
  assert.equal(list.length, 1);
  assert.equal(list[0].attempts, 1);
});

// ---------------------------------------------------------------- 静态：模型无墙钟

test('46 model contains no Date.now() and no SDK import', () => {
  assert.doesNotMatch(MODEL_CODE, /Date\.now\s*\(/);
  assert.doesNotMatch(MODEL_CODE, /@kit\./);
  assert.doesNotMatch(MODEL_CODE, /node:crypto|createHash/);
  // 正常路径的 decidedAt 由输入 ts 派生（isoFromTs 同口径），不读墙钟。
  assert.match(MODEL_CODE, /Date\.parse\(ts\)/);
});

// ---------------------------------------------------------------- 静态：服务契约（≥6）

test('47 service disabled: requireEnabled is first statement and throws before any IO', () => {
  const body = methodBody(SERVICE_CODE, 'runCycle');
  const first = body.indexOf('this.requireEnabled();');
  assert.ok(first >= 0, 'runCycle 未先调用 requireEnabled');
  assert.match(SERVICE, /DISABLED_MESSAGE: string = 'timeline v2 同步未启用'/);
  const guard = methodBody(SERVICE_CODE, 'requireEnabled');
  assert.match(guard, /if \(!this\.isEnabled\(\)\)/);
  assert.match(guard, /throw new Error\(DISABLED_MESSAGE\)/);
  const ioAt = body.indexOf('await this.ensureReady');
  assert.ok(ioAt > first, 'requireEnabled 必须早于任何 IO');
  assert.match(methodBody(SERVICE_CODE, 'isEnabled'), /timelineStore\.useV2\(\)/);
  assert.doesNotMatch(body, /AppStorage/);
});

test('48 service never force-pushes and never rewrites remote history', () => {
  const body = methodBody(SERVICE_CODE, 'runCycle');
  assert.match(body, /git\(\['push', 'origin', 'main'\]\)/);
  assert.doesNotMatch(SERVICE_CODE, /push[^\n]*--force/);
  assert.doesNotMatch(SERVICE_CODE, /push[^\n]*\+-/); // 无 +refspec 强制推送
  assert.doesNotMatch(SERVICE_CODE, /'--force'/);
  assert.doesNotMatch(SERVICE_CODE, /git\s+push\s+--force/);
  assert.match(SERVICE, /绝不 force-push/);
  assert.match(SERVICE, /绝不重写远端历史/);
  assert.match(SERVICE, /绝不删除远端文件/);
});

test('49 merge --ff-only is the only merge form and it precedes the first write', () => {
  assert.doesNotMatch(SERVICE_CODE, /pull\s+--rebase/);
  assert.doesNotMatch(SERVICE_CODE, /\brebase\b/);
  assert.doesNotMatch(SERVICE_CODE, /\bamend\b/);
  assert.doesNotMatch(SERVICE_CODE, /'clean'/);
  assert.match(SERVICE_CODE, /git\(\['fetch', 'origin', 'main'\]\)/);
  // 代码里只有一个 'merge' 字面量，且唯一形式是 --ff-only；无其它 git merge 调用。
  assert.deepEqual(SERVICE_CODE.match(/'merge'/g) ?? [], ["'merge'"]);
  assert.deepEqual(SERVICE_CODE.match(/git\(\['merge'[^\]]*\]\)/g) ?? [],
    ["git(['merge', '--ff-only', 'origin/main'])"]);
  assert.match(SERVICE, /唯一的 merge 形式是 `git merge --ff-only origin\/main`/);
  const prepare = methodBody(SERVICE_CODE, 'prepare');
  const gateAt = prepare.indexOf('assertWritable(');
  const ffAt = prepare.indexOf("'--ff-only'");
  const unionAt = prepare.indexOf('unionDay(');
  const atomicAt = prepare.indexOf('atomicReplaceText(');
  assert.ok(gateAt > 0 && ffAt > gateAt, '门禁必须先于 ff');
  assert.ok(ffAt < unionAt, 'ff 必须先于读远端文本 / union');
  assert.ok(ffAt < atomicAt, 'ff 必须先于首次写盘');
});

test('50 reset --hard appears only in the push-rejection path', () => {
  const occurrences = SERVICE_CODE.match(/reset', '--hard'/g) ?? [];
  assert.equal(occurrences.length, 1, 'reset --hard 必须仅出现一次');
  const body = methodBody(SERVICE_CODE, 'runCycle');
  const resetAt = body.indexOf("reset', '--hard'");
  const catchAt = body.indexOf('catch (error)');
  assert.ok(resetAt > catchAt, 'reset --hard 必须在 catch（拒推）分支内');
  assert.doesNotMatch(body.slice(0, catchAt), /reset/);
  const pushAt = body.indexOf("git\(\['push', 'origin', 'main'\]\)");
  assert.ok(pushAt > 0 && pushAt < resetAt, '先 push 被拒才 reset');
});

test('51 outbox path is <filesDir>/sync-outbox.json, outside git-repo/', () => {
  assert.match(SERVICE, /OUTBOX_FILE_NAME: string = 'sync-outbox\.json'/);
  const pathBody = methodBody(SERVICE_CODE, 'outboxPath');
  assert.match(pathBody, /this\.filesDir\}\/\$\{OUTBOX_FILE_NAME\}/);
  assert.doesNotMatch(pathBody, /git-repo|timeline|ROOT_DIR_NAME/);
  assert.match(SERVICE, /在 `git-repo\/` 之外/);
});

test('52 outbox writes use atomic tmp + readback + rename', () => {
  const body = methodBody(SERVICE_CODE, 'writeOutbox');
  assert.match(body, /TMP_INFIX/);
  assert.match(body, /this\.writeTextToFile\(tmp, text\)/);
  assert.match(body, /fs\.readTextSync\(tmp\) !== text/);
  assert.match(body, /fs\.renameSync\(tmp, path\)/);
  assert.doesNotMatch(body, /unlinkSync\(path\)/);
});

test('53 service writes no devices/ paths and no AppStorage keys', () => {
  assert.doesNotMatch(SERVICE_CODE, /devices\//);
  assert.doesNotMatch(SERVICE_CODE, /AppStorage/);
  assert.doesNotMatch(SERVICE_CODE, /openIndex/);
});

test('54 assertWritable runs before any write; commit uses [v2] sync <n> days', () => {
  const body = methodBody(SERVICE_CODE, 'prepare');
  const gateAt = body.indexOf('assertWritable(');
  const fetchAt = body.indexOf('remoteText(git');
  const atomicAt = body.indexOf('atomicReplaceText(');
  const commitAt = body.indexOf("`${COMMIT_PREFIX}${empty.days} days`");
  assert.ok(fetchAt >= 0 && gateAt > 0, '门禁调用缺失');
  assert.ok(atomicAt > gateAt, 'assertWritable 必须先于任何写盘');
  assert.ok(commitAt > atomicAt);
  assert.match(SERVICE, /COMMIT_PREFIX: string = '\[v2\] sync '/);
  assert.match(body, /unionDay\(date, remoteTexts, localTexts, dayEntries, now\)/);
  // 复检门禁（步骤 4）同样在任何写之前。
  const gateCount = (body.match(/assertWritable\(/g) ?? []).length;
  assert.equal(gateCount, 2, '门禁 + ff 后复检各一次');
  assert.match(SERVICE, /FF_DIVERGED_MESSAGE: string = '本地与 origin\/main 已分叉，请先手工处理'/);
});

test('55 cycle documents all 7 numbered steps in runCycle/prepare', () => {
  // 步骤编号在注释里（SERVICE_CODE 已剥注释），这里读原文。
  const run = methodBody(SERVICE, 'runCycle');
  const prepare = methodBody(SERVICE, 'prepare');
  for (const marker of ['步骤 1', '步骤 2–6', '步骤 7']) {
    assert.ok(run.includes(marker), `runCycle 缺少 ${marker}`);
  }
  for (const marker of ['步骤 2', '步骤 3', '步骤 4', '步骤 5', '步骤 6']) {
    assert.ok(prepare.includes(marker), `prepare 缺少 ${marker}`);
  }
  assert.match(run, /for \(;;\)/); // 显式重试循环
  assert.match(run, /attempts >= MAX_ATTEMPTS/);
  assert.match(run, /outboxAfterReplay\(outbox, \[\], failedIds, droppedReported, now\)/);
  assert.match(run, /dequeueDropped\(prepared\)/);
});

test('56 service reuses pure model and the write service instead of reimplementing it', () => {
  for (const name of ['assertWritable', 'unionDay', 'replayable', 'markAttempt', 'outboxAfterReplay', 'isApplied', 'MAX_ATTEMPTS']) {
    assert.match(SERVICE, new RegExp(`\\b${name}\\b`), `未复用 ${name}`);
  }
  assert.match(SERVICE, /timelineWriteStore\.append\(record, date\)/);
  assert.match(SERVICE, /timelineWriteStore\.scheduleDelete\(/);
  assert.match(SERVICE, /timelineWriteStore\.restore\(/);
  assert.match(SERVICE, /timelineWriteStore\.purgeRows\(/);
});

// ---------------------------------------------------------------- F1：门禁 / head 关系（新）

test('57 headRelation equal/behind/ahead/diverged from injected merge-base facts', () => {
  const base = { headSha: SHORT.head, originMainSha: SHORT.other };
  assert.equal(headRelation({ ...base, headSha: SHORT.other }), 'equal');
  assert.equal(headRelation({ ...base, headIsAncestorOfOrigin: true }), 'behind');
  assert.equal(headRelation({ ...base, originIsAncestorOfHead: true }), 'ahead');
  assert.equal(headRelation(base), 'diverged');
});

test('58 gate behind (HEAD ancestor of origin/main) => ok; only behind is fast-forwardable', () => {
  const behind = {
    schemaVersion: 2, branch: 'main', headSha: SHORT.head, originMainSha: SHORT.other,
    headIsAncestorOfOrigin: true, originIsAncestorOfHead: false
  };
  assert.deepEqual(assertWritable(behind), { ok: true, code: 'ok', message: '可写' });
  assert.equal(isFastForwardable(behind), true);
  assert.equal(isFastForwardable({ ...behind, headSha: SHORT.other }), false); // equal
  assert.equal(isFastForwardable({ ...behind, headIsAncestorOfOrigin: false, originIsAncestorOfHead: true }), false); // ahead
});

test('59 gate ahead => E_NOT_SYNCED (local commits must be pushed, never silently discarded)', () => {
  const ahead = {
    schemaVersion: 2, branch: 'main', headSha: SHORT.head, originMainSha: SHORT.other,
    headIsAncestorOfOrigin: false, originIsAncestorOfHead: true
  };
  assert.equal(assertWritable(ahead).code, 'E_NOT_SYNCED');
  assert.equal(assertWritable(ahead).message, '本地 HEAD 与 origin/main 不一致，请先同步');
});

test('60 gate diverged => E_NOT_SYNCED (service answers with the ff-failure message)', () => {
  const diverged = {
    schemaVersion: 2, branch: 'main', headSha: SHORT.head, originMainSha: SHORT.other,
    headIsAncestorOfOrigin: false, originIsAncestorOfHead: false
  };
  assert.equal(assertWritable(diverged).code, 'E_NOT_SYNCED');
  assert.match(SERVICE, /FF_DIVERGED_MESSAGE: string = '本地与 origin\/main 已分叉，请先手工处理'/);
});

// ---------------------------------------------------------------- F2：账本并集（新）

test('61 PROOF remote delete + stale local upsert => dropped, record absent, isApplied false', () => {
  const delLine = JSON.stringify({ id: 'gone', ts: T1100, deletedAt: T1100, intentId: 'remote-del' });
  const up = entry('upsert', {
    intentId: 'up', id: 'gone', ts: T0930,
    line: canonicalRecordLine(rec({ id: 'gone' }))
  });
  // 远端账本已落盘删除；远端 records.json 行已被物理移除（confirm 之后）。
  const u = unionDay(DAY, dt('', `${delLine}\n`), dt('', ''), [up], NOW);
  assert.ok(u.dropped.includes('up'), '陈旧 upsert 必须计入 dropped');
  assert.ok(!u.applied.includes('up'));
  assert.equal(u.added, 0);
  assert.deepEqual(parseTimelineDay(u.text, DAY).day.allRecords, [], '记录不得被写回');
  assert.deepEqual(openIdsForDay(DAY, u.text, u.deleted, u.restored), []);
  assert.equal(isApplied(up, u.text, u.deleted, u.restored), false);
  assert.match(u.deleted, /"intentId":"remote-del"/);
});

test('62 PROOF remote restore after delete (R.ts > D.ts) => visible, upsert applies again', () => {
  const d = ledgerDeleteLine('gone', T1000, T1000);
  const r = ledgerRestoreLine('gone', T1100, T1100);
  const up = entry('upsert', {
    intentId: 'up', id: 'gone', ts: T1400,
    line: canonicalRecordLine(rec({ id: 'gone', ts: T1400 }))
  });
  const u = unionDay(DAY, dt('', `${d}\n`, `${r}\n`), dt('', ''), [up], NOW);
  assert.ok(!u.dropped.includes('up'));
  assert.equal(u.added, 1);
  assert.deepEqual(openIdsForDay(DAY, u.text, u.deleted, u.restored), ['gone']);
});

test('63 both-sides deleted/restore ledgers union, deduped by (id,ts[,intentId])', () => {
  const d1 = ledgerDeleteLine('a1', T1000, T1000);
  const d2 = ledgerDeleteLine('b2', T1100, T1100);
  const r1 = ledgerRestoreLine('a1', T1100, T1100);
  const r2 = ledgerRestoreLine('b2', T1400, T1400);
  const localDeleted = `${d1}\n`;
  const remoteDeleted = `${d2}\n${d1}\n`; // d1 重复，必须只出现一次
  const localRestore = `${r1}\n`;
  const remoteRestore = `${r2}\n`;
  const u = unionDay(DAY,
    dt(dayText([]), remoteDeleted, remoteRestore),
    dt(dayText([]), localDeleted, localRestore), [], NOW);
  assert.equal(u.deleted.startsWith(localDeleted), true, '旧字节必须是新字节严格前缀');
  assert.equal(u.restored.startsWith(localRestore), true);
  assert.equal(u.deleted.split(d1).length - 1, 1, 'd1 只出现一次');
  assert.equal(parseLedger(u.deleted).entries.length, 2);
  assert.equal(parseLedger(u.restored).entries.length, 2);
});

test('64 order-independence still holds with nonempty ledgers on both sides', () => {
  const d1 = ledgerDeleteLine('a1', T1100, T1100);
  const d2 = ledgerDeleteLine('b2', T1400, T1400);
  const a = rec({ id: 'a1' });
  const z = rec({ id: 'b2', ts: T1400 });
  const forward = unionDay(DAY, dt(dayText([a]), `${d1}\n`), dt(dayText([z]), `${d2}\n`), [], NOW);
  const swapped = unionDay(DAY, dt(dayText([z]), `${d2}\n`), dt(dayText([a]), `${d1}\n`), [], NOW);
  assert.equal(swapped.text, forward.text);
  assert.deepEqual(swapped.conflicts, forward.conflicts);
  assert.equal(swapped.added, forward.added);
  // 账本文本有意 local-prefix（追加语义），故不要求两侧互换后字节相同。
});

// ---------------------------------------------------------------- F4 / F5 / F9（新）

test('65 F4 upsert normalized via planUpsert: reopened_at refreshed, byte-identical to write path', () => {
  const existing = rec({ id: 'x1', ts: T0930, done: true, closed_at: T1000 });
  const incoming = rec({ id: 'x1', ts: T1400 }); // 无 closed_at = 重新打开；opened_at 仍是旧值
  const up = entry('upsert', {
    intentId: 'up', id: 'x1', ts: T1400, line: canonicalRecordLine(incoming)
  });
  const u = unionDay(DAY, dt(dayText([existing])), dt(), [up], NOW);
  // 与 timelineWriteStore.append 内的 planUpsert 走同一套规范化。
  const plan = planUpsert(DAY, [existing], incoming);
  assert.equal(plan.ok, true);
  const normalized = parseTimelineDay(plan.text, DAY).day.allRecords.find((r) => r.id === 'x1');
  const expectedLine = canonicalRecordLine(normalized);
  assert.equal(u.text.includes(expectedLine), true, '正常路径必须与 planUpsert 产出逐字节一致');
  assert.equal(u.text.includes(canonicalRecordLine(incoming)), false, '未规范化的原始行不得出现');
  assert.equal(normalized.opened_at, T1400, '重新打开必须刷新 opened_at');
  assert.equal(normalizeForWrite(DAY, incoming, [existing]).opened_at, T1400);
});

test('66 F5 unparseable ts intent is dropped with E_TS_SHAPE, never falls back to wall clock', () => {
  const bad = entry('upsert', {
    intentId: 'bad-ts', id: 'x1', ts: 'not-a-ts',
    line: canonicalRecordLine(rec({ id: 'x1', ts: 'not-a-ts' }))
  });
  const u = unionDay(DAY, dt(), dt(), [bad], NOW);
  assert.equal(E_TS_SHAPE, 'E_TS_SHAPE');
  assert.ok(u.dropped.includes('bad-ts'));
  assert.ok(u.tsShapeDropped.includes('bad-ts'));
  assert.equal(u.added, 0);
  assert.deepEqual(parseTimelineDay(u.text, DAY).day.allRecords, []);
  // 正常路径 decidedAt 只来自输入 ts，换注入 now 也不改变冲突行。
  const smaller = rec({ body: 'a' });
  const larger = rec({ body: 'z' });
  const nowA = new Date('2020-01-01T00:00:00.000Z');
  const nowB = new Date('2099-12-31T23:59:59.000Z');
  const c1 = unionDay(DAY, dt(dayText([smaller])), dt(dayText([larger])), [], nowA);
  const c2 = unionDay(DAY, dt(dayText([smaller])), dt(dayText([larger])), [], nowB);
  assert.deepEqual(c1.conflicts, c2.conflicts);
  assert.equal(JSON.parse(c1.conflicts[0]).decidedAt, '2026-11-19T01:30:00.000Z');
});

test('67 F9 delete ledger line carries intentId (contract §7 optional key, additive)', () => {
  const del = entry('delete', { intentId: 'del-9', id: 'gone', ts: T1100, line: '' });
  const u = unionDay(DAY, dt(), dt(), [del], NOW);
  assert.match(u.deleted, /"intentId":"del-9"/);
  assert.equal(parseLedger(u.deleted).entries[0].id, 'gone');
  // 生产侧 timelineWrite.ledgerDeleteLine 仍不含 intentId；这里在 union 写阶段补齐。
  assert.doesNotMatch(ledgerDeleteLine('gone', T1100, T1100), /intentId/);
});

// ---------------------------------------------------------------- F3：dropped 出队（新）

test('68 outboxAfterReplay dequeues dropped ids without bumping their attempts', () => {
  const list = [
    entry('upsert', { intentId: 'applied' }),
    entry('upsert', { intentId: 'failed', attempts: 1 }),
    entry('upsert', { intentId: 'dropped', attempts: 2 }),
    entry('upsert', { intentId: 'keep' })
  ];
  const out = outboxAfterReplay(list, ['applied'], ['failed'], ['dropped'], NOW);
  assert.deepEqual(out.map((e) => e.intentId), ['failed', 'keep']);
  assert.equal(out[0].attempts, 2, '只有 failed 才 attempts+1');
  assert.equal(out[0].lastError, SYNC_RETRY_ERROR);
  assert.equal(list[2].attempts, 2, 'dropped 入参不被改写，出队不靠 bump');
  assert.ok(!out.some((e) => e.intentId === 'dropped'));
});

test('69 F3 service: CycleResult.dropped, ff message, and dequeue-before-bump static contract', () => {
  assert.match(SERVICE, /dropped: string\[\];/);
  assert.match(SERVICE, /dropped: droppedReported/);
  const cycle = methodBody(SERVICE_CODE, 'runCycle');
  const dequeueAt = cycle.indexOf('dequeueDropped(prepared)');
  const bumpAt = cycle.indexOf('bumpAttempts(outbox)');
  assert.ok(dequeueAt > 0 && bumpAt > 0 && dequeueAt < bumpAt,
    'dropped 必须在 bumpAttempts 之前出队，永不被误判 failed');
  assert.match(cycle, /outbox\.filter\(\(entry: OutboxEntry\): boolean => !droppedSet\.has\(entry\.intentId\)\)/);
  const replay = methodBody(SERVICE_CODE, 'reapplyIntents');
  assert.match(replay, /this\.timelineWriteStoreAppend\(/, '拒推重放走类型隔离入口');
  const appendBody = methodBody(SERVICE_CODE, 'timelineWriteStoreAppend');
  assert.match(appendBody, /timelineWriteStore\.append\(record, date\)/, '拒推重放仍走 planUpsert 同一入口（F4）');
});

test('70 F2 service: reads remote ledgers, passes DayTexts to unionDay, guards append prefix', () => {
  const prepare = methodBody(SERVICE_CODE, 'prepare');
  assert.match(prepare, /deleted: await this\.remoteText\(git, date, DELETED_FILE_NAME\)/);
  assert.match(prepare, /restore: await this\.remoteText\(git, date, RESTORE_FILE_NAME\)/);
  assert.match(prepare, /remoteText\(git, date, CONFLICTS_FILE_NAME\)/);
  assert.match(prepare, /unionDay\(date, remoteTexts, localTexts, dayEntries, now\)/);
  assert.match(prepare, /union\.deleted\.startsWith\(localTexts\.deleted\)/);
  assert.match(prepare, /union\.restored\.startsWith\(localTexts\.restore\)/);
  assert.match(prepare, /E_LEDGER_APPEND/);
  assert.doesNotMatch(prepare, /entry\.line\.length > 0 \? \[entry\.line\]/,
    '旧的按意图 payload 追加账本路径必须被并集写回取代');
});

test('71 model decidedAtOf has no wall-clock fallback (F5)', () => {
  const decided = methodBody(MODEL_CODE, 'decidedAtOf');
  assert.match(decided, /return ts;/);
  assert.match(MODEL_CODE, /function decidedAtOf\(ts: string, _now: Date\)/);
  assert.doesNotMatch(decided, /now\.toISOString\(\)/);
  assert.match(MODEL, /export const E_TS_SHAPE: string = 'E_TS_SHAPE'/);
});
