// mod-v2-write-service：v2 写入核心（纯模型）行为测试 + 写入服务静态契约测试。
//
// 前置构建：node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
// 纯模型 import ../.build/model/timelineWrite.js；服务层 import @kit.*，只能在 Node 里做源码形状断言。
//
// 覆盖：§3 字节形状（与契约两条示例逐字符比对）、一条一行 + 尾逗号、排序、open 谓词、
//       upsert 替换重排、remove 无墓碑、两本账本行形状、非法输入 fail-closed、确定性/无副作用、
//       无墙钟；服务侧：未启用先抛错、tmp+rename 原子写、账本只追加、无 v1 目录写入、
//       无 AppStorage 写、读到门禁/路径/纯函数复用、summary newer-wins；
//       N1 物理清行 canPurge 守卫（raw allRecords + 账本前置 + 幂等）、N2 写侧 ts 形状门禁。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { stripComments } from './helpers/etsSource.mjs';
import { requireOverlayRestored } from './guard.mjs';

requireOverlayRestored('timelineWrite.test.mjs');

// 编译产物里的 `import ... from './timeline'` 不带 .js（ArkTS 要求），Node ESM 不推断扩展名；
// 与 b4SaveTs.test.mjs 同口径，只为测试进程补后缀解析。
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

const { parseTimelineDay, canonicalRecordLine } = await import('../.build/model/timeline.js');
const { NOT_MIGRATED_REASON } = await import('../.build/model/migrationState.js');
const {
  buildRecordsText, planUpsert, planRemove, openIdsOf, ledgerDeleteLine, ledgerRestoreLine,
  isNewerSummaryText, tsMillis, isValidTsShape, canPurge
} = await import('../.build/model/timelineWrite.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..');
const SERVICE_PATH = join(APP, 'entry', 'src', 'main', 'ets', 'services', 'timelineWriteStore.ets');
const MODEL_PATH = join(APP, 'entry', 'src', 'main', 'ets', 'model', 'timelineWrite.ts');
const SERVICE = readFileSync(SERVICE_PATH, 'utf8');
const MODEL = readFileSync(MODEL_PATH, 'utf8');
const SERVICE_CODE = stripComments(SERVICE);

const DAY = '2026-11-19';
const T0930 = `${DAY}T09:30:00+08:00`;
const T1400 = `${DAY}T14:00:00+08:00`;
const T1600 = `${DAY}T16:00:00+08:00`;
const SHA = 'ab12cd34ef567890abcdef0123456789abcdef0123456789abcdef0123456789';

function rec(overrides = {}) {
  return {
    id: 'a1', ts: T0930, title: '标题', body: '', author: '我', done: false,
    media: [], ai_processed: false, opened_at: T0930, ...overrides
  };
}

// 契约 §3 的两条示例记录（字节从 docs/DATA-CONTRACT-v2.md §3 原文复制）。
const EXAMPLE_A = {
  id: 'm9x2k1-3fk', ts: '2026-11-19T09:30:00+08:00', title: '周会', body: '讨论同步方案',
  author: '我', done: false, media: [], ai_processed: false, opened_at: '2026-11-19T09:30:00+08:00'
};
const EXAMPLE_B = {
  id: 'n0y3l2-8ab', ts: '2026-11-19T14:00:00+08:00', title: '体检', body: '', author: '我',
  done: true, media: [{ file: 'ab12cd34ef567890.jpg', sha256: SHA, pageIndex: 0 }],
  ocr_text: '体检单', ai_processed: true, opened_at: '2026-11-19T14:00:00+08:00',
  closed_at: '2026-11-19T15:20:00+08:00'
};
const LINE_A = '{"id":"m9x2k1-3fk","ts":"2026-11-19T09:30:00+08:00","title":"周会","body":"讨论同步方案","author":"我","done":false,"media":[],"ai_processed":false,"opened_at":"2026-11-19T09:30:00+08:00"}';
const LINE_B = `{"id":"n0y3l2-8ab","ts":"2026-11-19T14:00:00+08:00","title":"体检","body":"","author":"我","done":true,"media":[{"file":"ab12cd34ef567890.jpg","sha256":"${SHA}","pageIndex":0}],"ocr_text":"体检单","ai_processed":true,"opened_at":"2026-11-19T14:00:00+08:00","closed_at":"2026-11-19T15:20:00+08:00"}`;
const EXAMPLE_TEXT = [
  '{',
  '  "date": "2026-11-19",',
  '  "open": ["m9x2k1-3fk"],',
  '  "records": [',
  `  ${LINE_A},`,
  `  ${LINE_B}`,
  '  ]',
  '}',
  ''
].join('\n');

/** 抽方法体（有返回类型 + 花括号），用于服务静态断言。 */
function methodBody(code, name) {
  const signature = new RegExp(`\\b${name}\\s*\\([^)]*\\)\\s*:\\s*[^;{}]+\\{`);
  const matched = signature.exec(code);
  assert.ok(matched, `${name}() 声明未找到`);
  const open = code.indexOf('{', matched.index + matched[0].length - 1);
  assert.ok(open > 0, `${name}() 方法体起始花括号未找到`);
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}') {
      depth -= 1;
      if (depth === 0) return code.slice(open, i + 1);
    }
  }
  throw new Error(`${name}() 花括号不配对`);
}

// ---------------------------------------------------------------- 纯模型：§3 字节形状

test('01 buildRecordsText byte-exact equals the §3 two-record example', () => {
  const text = buildRecordsText(DAY, [EXAMPLE_A, EXAMPLE_B]);
  assert.equal(text, EXAMPLE_TEXT);
});

test('02 §3 example lines equal canonicalRecordLine output (key order fixed)', () => {
  assert.equal(canonicalRecordLine(EXAMPLE_A), LINE_A);
  assert.equal(canonicalRecordLine(EXAMPLE_B), LINE_B);
});

test('03 produced text parses back with zero errors and both records', () => {
  const parsed = parseTimelineDay(buildRecordsText(DAY, [EXAMPLE_A, EXAMPLE_B]), DAY);
  assert.equal(parsed.day.date, DAY);
  assert.equal(parsed.errors.length, 0, JSON.stringify(parsed.errors));
  assert.deepEqual(parsed.day.allRecords.map((r) => r.id), ['m9x2k1-3fk', 'n0y3l2-8ab']);
  assert.deepEqual(parsed.day.open, ['m9x2k1-3fk']);
});

test('04 one record per line with a comma on every line except the last', () => {
  const text = buildRecordsText(DAY, [EXAMPLE_A, EXAMPLE_B]);
  const lines = text.split('\n');
  const recordLines = lines.filter((line) => line.trimStart().startsWith('{"id"'));
  assert.equal(recordLines.length, 2);
  assert.match(recordLines[0], /,$/);
  assert.doesNotMatch(recordLines[1], /,$/);
  assert.ok(recordLines.every((line) => line.startsWith('  {"id"'))); // 2 空格缩进
});

test('05 exactly one trailing newline, no blank lines', () => {
  const text = buildRecordsText(DAY, [rec()]);
  assert.ok(text.endsWith('}\n'));
  assert.doesNotMatch(text, /\n\n/);
  assert.equal(text[text.length - 2], '}');
});

test('06 empty records produce a parseable empty day text', () => {
  const text = buildRecordsText(DAY, []);
  assert.equal(text, '{\n  "date": "2026-11-19",\n  "open": [],\n  "records": [\n  ]\n}\n');
  const parsed = parseTimelineDay(text, DAY);
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.day.allRecords.length, 0);
});

test('07 records sorted by ts instant then id (input order irrelevant)', () => {
  const a = rec({ id: 'b', ts: T1400 });
  const b = rec({ id: 'a', ts: T1400 });
  const c = rec({ id: 'z', ts: T0930 });
  const text = buildRecordsText(DAY, [a, b, c]);
  const ids = text.split('\n').filter((line) => line.trimStart().startsWith('{"id"'))
    .map((line) => JSON.parse(line.trim().replace(/,$/, '')).id);
  assert.deepEqual(ids, ['z', 'a', 'b']);
});

test('08 ts compare uses instant, not bytes (+08:00 vs Z at same moment)', () => {
  const a = rec({ id: 'a', ts: '2026-11-19T01:30:00Z' });   // == 09:30 +08:00
  const b = rec({ id: 'b', ts: T0930 });
  const text = buildRecordsText(DAY, [b, a]);
  const ids = text.split('\n').filter((line) => line.trimStart().startsWith('{"id"'))
    .map((line) => JSON.parse(line.trim().replace(/,$/, '')).id);
  assert.deepEqual(ids, ['a', 'b']); // 并列时按 id 升序
});

// ---------------------------------------------------------------- 纯模型：open 谓词

test('09 open derived from closed_at only: done=true without closed_at is still open', () => {
  assert.deepEqual(openIdsOf([
    rec({ id: 'closed', done: false, closed_at: T1600 }),
    rec({ id: 'open', done: true, closed_at: null })
  ]), ['open']);
});

test('10 openIdsOf treats empty / whitespace closed_at as missing and preserves order', () => {
  assert.deepEqual(openIdsOf([
    rec({ id: 'a', closed_at: '' }),
    rec({ id: 'b', closed_at: '   ' }),
    rec({ id: 'c', closed_at: T1600 }),
    rec({ id: 'd' })
  ]), ['a', 'b', 'd']);
});

test('11 buildRecordsText open array matches openIdsOf after sorting', () => {
  const records = [rec({ id: 'x', ts: T1400, closed_at: T1600 }), rec({ id: 'y', ts: T0930 })];
  const text = buildRecordsText(DAY, records);
  assert.match(text, /"open": \["y"\]/);
  assert.deepEqual(openIdsOf(records), ['y']);
});

// ---------------------------------------------------------------- 纯模型：upsert / remove

test('12 planUpsert replaces all versions of the same id (any ts) and re-sorts', () => {
  const old1 = rec({ id: 'a', ts: T0930, title: 'old1' });
  const old2 = rec({ id: 'a', ts: T1400, title: 'old2' });
  const other = rec({ id: 'b', ts: T1600, title: 'other' });
  const plan = planUpsert(DAY, [old2, other, old1], rec({ id: 'a', ts: T1600, title: 'new' }));
  assert.equal(plan.ok, true);
  const parsed = parseTimelineDay(plan.text, DAY);
  assert.deepEqual(parsed.day.allRecords.map((r) => r.id), ['a', 'b']);
  assert.equal(parsed.day.allRecords[0].title, 'new');
  assert.equal(parsed.day.allRecords[0].ts, T1600);
});

test('13 planUpsert recomputes open from the incoming record', () => {
  const plan = planUpsert(DAY, [rec({ id: 'a' })], rec({ id: 'a', ts: T1400, closed_at: T1600 }));
  assert.deepEqual(plan.open, []);
  assert.match(plan.text, /"open": \[\]/);
});

test('14 planUpsert leaves unrelated records byte-identical', () => {
  const other = rec({ id: 'keep', ts: T1400, title: 'untouched' });
  const plan = planUpsert(DAY, [other], rec({ id: 'new', ts: T0930 }));
  assert.ok(plan.text.includes(canonicalRecordLine(other)));
});

test('15 planRemove drops every version of the id and writes no tombstone', () => {
  const base = [rec({ id: 'a', ts: T0930 }), rec({ id: 'a', ts: T1400 }), rec({ id: 'b', ts: T1600 })];
  const plan = planRemove(DAY, base, 'a');
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.open, ['b']); // 剩下未关闭的 b 仍为未完成
  assert.doesNotMatch(plan.text, /"a"/);
  assert.doesNotMatch(plan.text, /deleted|tombstone/);
  assert.deepEqual(parseTimelineDay(plan.text, DAY).day.allRecords.map((r) => r.id), ['b']);
});

test('16 planRemove is idempotent when the id is absent', () => {
  const base = [rec({ id: 'b' })];
  const plan = planRemove(DAY, base, 'missing');
  assert.equal(plan.ok, true);
  assert.equal(plan.text, buildRecordsText(DAY, base));
});

test('17 planRemove recomputes open from the remaining rows', () => {
  const plan = planRemove(DAY, [rec({ id: 'a' }), rec({ id: 'b', closed_at: T1600 })], 'a');
  assert.deepEqual(plan.open, []);
});

// ---------------------------------------------------------------- 纯模型：fail-closed

test('18 invalid dates fail closed for upsert and remove (shape + nonexistent day)', () => {
  for (const bad of ['', '2026-13-99', '2026-02-30', '2026/11/19', '26-11-19']) {
    const up = planUpsert(bad, [], rec());
    const rm = planRemove(bad, [], 'a');
    assert.equal(up.ok, false, bad);
    assert.equal(up.text, '', bad);
    assert.ok(up.reason.length > 0, bad);
    assert.equal(rm.ok, false, bad);
    assert.equal(rm.text, '', bad);
    assert.equal(buildRecordsText(bad, []), '', bad);
  }
});

test('19 invalid record fields fail closed with no text', () => {
  const badRecords = [
    { id: '', ts: T0930, title: 'x', body: '', author: '我', done: false, media: [], ai_processed: false, opened_at: T0930 },
    { id: 'x', title: 'x', body: '', author: '我', done: false, media: [], ai_processed: false, opened_at: T0930 },
    { ...rec(), done: 'false' },
    { ...rec(), media: [{ file: 'media/x.jpg', sha256: SHA, pageIndex: 0 }] }
  ];
  for (const bad of badRecords) {
    const plan = planUpsert(DAY, [], bad);
    assert.equal(plan.ok, false);
    assert.equal(plan.text, '');
    assert.ok(plan.reason.length > 0);
  }
});

test('20 an invalid pre-existing row also fails the upsert closed', () => {
  const base = [rec({ id: 'bad', media: [{ file: '../x.jpg', sha256: SHA, pageIndex: 0 }] })];
  assert.equal(buildRecordsText(DAY, base), '');
  const plan = planUpsert(DAY, base, rec({ id: 'new' }));
  assert.equal(plan.ok, false);
  assert.equal(plan.text, '');
});

test('21 invalid ids fail closed for remove', () => {
  for (const bad of ['', '   ', null, 42]) {
    const plan = planRemove(DAY, [], bad);
    assert.equal(plan.ok, false);
    assert.equal(plan.text, '');
  }
});

// ---------------------------------------------------------------- 纯模型：账本 / 确定性

test('22 ledgerDeleteLine is one JSON line in §7 key order', () => {
  assert.equal(
    ledgerDeleteLine('m9x2k1-3fk', '2026-11-19T16:00:00+08:00', '2026-11-19T16:00:00+08:00'),
    '{"id":"m9x2k1-3fk","ts":"2026-11-19T16:00:00+08:00","deletedAt":"2026-11-19T16:00:00+08:00"}'
  );
});

test('23 ledgerRestoreLine is one JSON line in §7 key order', () => {
  assert.equal(
    ledgerRestoreLine('m9x2k1-3fk', '2026-11-19T16:01:00+08:00', '2026-11-19T16:01:00+08:00'),
    '{"id":"m9x2k1-3fk","ts":"2026-11-19T16:01:00+08:00","restoredAt":"2026-11-19T16:01:00+08:00"}'
  );
});

test('24 ledger lines carry no trailing newline and fail closed on empty inputs', () => {
  const line = ledgerDeleteLine('id', 'ts', 'at');
  assert.doesNotMatch(line, /\n/);
  assert.equal(ledgerDeleteLine('', 'ts', 'at'), '');
  assert.equal(ledgerDeleteLine('id', '', 'at'), '');
  assert.equal(ledgerRestoreLine('id', 'ts', ''), '');
});

test('25 deterministic: same input twice gives identical bytes, no input mutation', () => {
  const base = [rec({ id: 'b', ts: T1400 }), rec({ id: 'a' })];
  const snapshot = JSON.stringify(base);
  const first = buildRecordsText(DAY, base);
  const second = buildRecordsText(DAY, base);
  assert.equal(first, second);
  assert.equal(JSON.stringify(base), snapshot);
  const plan1 = planUpsert(DAY, base, rec({ id: 'c', ts: T1600 }));
  const plan2 = planUpsert(DAY, base, rec({ id: 'c', ts: T1600 }));
  assert.equal(plan1.text, plan2.text);
  assert.deepEqual(plan1.open, plan2.open);
  assert.equal(JSON.stringify(base), snapshot);
});

test('26 pure model reads no wall clock; service clock use is confined to uniqueSuffix naming', () => {
  assert.doesNotMatch(MODEL, /Date\.now\s*\(/);
  assert.doesNotMatch(MODEL, /new\s+Date\s*\(\s*\)/);
  assert.doesNotMatch(SERVICE, /new\s+Date\s*\(\s*\)/);
  const naming = methodBody(SERVICE_CODE, 'uniqueSuffix');
  assert.match(naming, /Date\.now\s*\(/);
  const withoutNaming = SERVICE_CODE.replace(naming, '');
  assert.doesNotMatch(withoutNaming, /Date\.now\s*\(/); // 时钟只用于侧文件命名，不参与任何数据字节
});

// ---------------------------------------------------------------- 服务：静态契约

test('27 disabled guard: every write method starts with requireEnabled before any IO', () => {
  for (const name of ['append', 'scheduleDelete', 'restore', 'purgeRows', 'remove', 'appendSummary']) {
    const body = methodBody(SERVICE_CODE, name).replace(/^\{\s*/, '');
    assert.match(body, /^\s*this\.requireEnabled\(\);/, `${name} 未先过门禁`);
  }
  const guard = methodBody(SERVICE_CODE, 'requireEnabled');
  assert.match(guard, /!this\.isEnabled\(\)/);
  assert.match(guard, /throw new Error\(DISABLED_MESSAGE\)/);
  assert.match(SERVICE, /DISABLED_MESSAGE: string = NOT_MIGRATED_REASON/);
});

test('28 v2-only: isEnabled is gated solely by migration state, refusal is typed', () => {
  assert.match(methodBody(SERVICE_CODE, 'isEnabled'), /return timelineStore\.isMigrated\(\)/);
  assert.equal(NOT_MIGRATED_REASON, 'E_NOT_MIGRATED: 时间线尚未初始化，请先迁移旧数据');
  assert.doesNotMatch(SERVICE, /AppStorage\s*\.\s*(set|setOrCreate|create)/);
  assert.doesNotMatch(SERVICE, /setReadMode|useV2|scheduleStore\.appendRecord/);
});

test('29 records.json is atomically replaced with a same-directory tmp + rename', () => {
  assert.match(SERVICE, /TMP_INFIX: string = '\.tmp-'/);
  assert.match(SERVICE, /BAK_INFIX: string = '\.bak-'/);
  assert.match(SERVICE_CODE, /const path: string = `\$\{dir\}\/\$\{fileName\}`/);
  assert.match(SERVICE_CODE, /const tmpPath: string = `\$\{path\}\$\{TMP_INFIX\}\$\{suffix\}`/);
  assert.match(SERVICE_CODE, /const backupPath: string = `\$\{path\}\$\{BAK_INFIX\}\$\{suffix\}`/);
  assert.match(SERVICE_CODE, /fs\.renameSync\(tmpPath, path\)/);
  assert.match(SERVICE_CODE, /fs\.mkdirSync\(dir, true\)/);
});

test('30 ledgers are append-only: read old bytes, keep them as prefix, atomic write', () => {
  const body = methodBody(SERVICE_CODE, 'appendLedgerLine');
  assert.match(body, /this\.readText\(path\)/);
  assert.match(body, /const key: string \| null = this\.ledgerKey\(line\)/); // (id, ts) 去重键
  assert.match(body, /this\.ledgerKey\(old\) === key/);
  assert.match(body, /old === line/); // 坏行退化为整行比较兜底
  assert.match(body, /existing\.endsWith\(NEW_LINE\)/);
  assert.match(body, /atomicWriteIn\(dir, fileName/);
});

test('31 service reuses the pure read/write model and never touches v1 paths', () => {
  assert.match(SERVICE_CODE, /from '\.\.\/model\/timeline'/);
  assert.match(SERVICE_CODE, /from '\.\.\/model\/timelineWrite'/);
  for (const fn of ['parseTimelineDay', 'parseLedger', 'visibleRecords', 'timelineDayPath',
    'planUpsert', 'planRemove', 'ledgerDeleteLine', 'ledgerRestoreLine',
    'tsMillis', 'isValidTsShape', 'isNewerSummaryText']) {
    assert.match(SERVICE_CODE, new RegExp(`\\b${fn}\\b`), `${fn} 未被复用`);
  }
  assert.doesNotMatch(SERVICE, /devices/);
  assert.doesNotMatch(SERVICE, /schedules\//);
});

test('32 summary.json delegates newer-wins to the pure model; bad candidate never overwrites', () => {
  const summary = methodBody(SERVICE_CODE, 'appendSummary');
  assert.match(summary, /if \(!isNewerSummaryText\(existing, text\)\) \{\s*return;\s*\}/);
  assert.match(summary, /atomicWriteIn\(dir, SUMMARY_FILE_NAME, text\)/);
  assert.doesNotMatch(SERVICE_CODE, /private isNewerSummary\(/);
  assert.doesNotMatch(SERVICE_CODE, /private summaryMillis\(/);
});

// ---------------------------------------------------------------- 纯模型：summary newer-wins（F3）

function summaryText(generatedAt) {
  return JSON.stringify({
    version: 1, date: DAY, generatedAt: generatedAt, model: 'm', provider: 'p',
    headline: '', points: [], recordCount: 0, doneCount: 0
  });
}

test('33 isNewerSummaryText: strictly newer generatedAt wins, equal keeps existing bytes', () => {
  assert.equal(isNewerSummaryText(summaryText(100), summaryText(200)), true);
  assert.equal(isNewerSummaryText(summaryText(200), summaryText(100)), false);
  assert.equal(isNewerSummaryText(summaryText(100), summaryText(100)), false);
});

test('34 isNewerSummaryText: malformed candidate never replaces a good summary', () => {
  const good = summaryText(100);
  for (const bad of ['', 'not json', '{}', '{"generatedAt":"200"}', '{"generatedAt":NaN}', 'null', '[]']) {
    assert.equal(isNewerSummaryText(good, bad), false, bad);
  }
});

test('35 isNewerSummaryText: a valid candidate replaces a corrupt/empty old file; two corrupt stay false', () => {
  const fresh = summaryText(200);
  assert.equal(isNewerSummaryText('', fresh), true);
  assert.equal(isNewerSummaryText('{broken', fresh), true);
  assert.equal(isNewerSummaryText('{"generatedAt":"x"}', fresh), true);
  assert.equal(isNewerSummaryText('', ''), false);
  assert.equal(isNewerSummaryText('{broken', '{also broken'), false);
});

// ---------------------------------------------------------------- 纯模型：ts 形状 / 重开会话（F6 / F8）

test('36 ts shape validation: ISO-to-second shape plus parseable, no wall clock', () => {
  assert.equal(tsMillis(T0930), Date.parse(T0930));
  assert.equal(tsMillis('garbage'), null);
  assert.equal(tsMillis(''), null);
  assert.equal(isValidTsShape(T0930), true);
  assert.equal(isValidTsShape(`${DAY}T09:30:00Z`), true);
  for (const bad of ['', 'garbage', '2026-11-19', '2026-11-19 09:30:00', `${DAY}T99:99:99+08:00`]) {
    assert.equal(isValidTsShape(bad), false, bad);
  }
});

test('37 planUpsert refreshes opened_at on reopen (closed_at cleared) per §6 P2-2', () => {
  const closed = rec({ id: 'a', ts: T0930, opened_at: T0930, closed_at: T1400 });
  const reopened = rec({ id: 'a', ts: T1600, opened_at: T0930 }); // 服务层未带 closed_at = 取消完成
  const plan = planUpsert(DAY, [closed], reopened);
  assert.equal(plan.ok, true);
  const row = parseTimelineDay(plan.text, DAY).day.allRecords[0];
  assert.equal(row.opened_at, T1600);
  assert.equal(row.closed_at, undefined);
  assert.equal(reopened.opened_at, T0930); // 入参不被改写（确定性 / 无副作用）
});

test('38 planUpsert keeps opened_at when it is not a reopen', () => {
  const open = rec({ id: 'a', ts: T0930, opened_at: T0930 });
  const stillOpen = planUpsert(DAY, [open], rec({ id: 'a', ts: T1400, opened_at: T0930 }));
  assert.equal(parseTimelineDay(stillOpen.text, DAY).day.allRecords[0].opened_at, T0930);

  const closed = rec({ id: 'a', ts: T0930, opened_at: T0930, closed_at: T1400 });
  const stillClosed = planUpsert(DAY, [closed], rec({ id: 'a', ts: T1600, opened_at: T0930, closed_at: T1600 }));
  assert.equal(parseTimelineDay(stillClosed.text, DAY).day.allRecords[0].opened_at, T0930);

  // 历史关闭行 + 当前已打开的最新行 → 不是重新打开，不能刷新 opened_at
  const history = rec({ id: 'a', ts: T0930, opened_at: T0930, closed_at: T1400 });
  const current = rec({ id: 'a', ts: T1400, opened_at: T1400 });
  const plan = planUpsert(DAY, [history, current], rec({ id: 'a', ts: T1600, opened_at: T1400 }));
  assert.equal(parseTimelineDay(plan.text, DAY).day.allRecords[0].opened_at, T1400);
});

// ---------------------------------------------------------------- 服务：P0 / P1a / P2 静态契约

test('39 atomic write never deletes the target before a verified copy exists (P0 regression)', () => {
  const body = methodBody(SERVICE_CODE, 'atomicWriteIn');
  assert.doesNotMatch(body, /unlinkSync\(path\)/); // 绝不对正式文件 unlink
  assert.match(body, /this\.verifyTmp\(tmpPath, text\)/);
  assert.match(body, /fs\.renameSync\(tmpPath, path\)/);          // ② 覆盖式 rename
  assert.match(body, /fs\.renameSync\(path, backupPath\)/);       // ③ 先备份原文件
  assert.match(body, /fs\.renameSync\(backupPath, path\)/);       // 失败恢复
  assert.match(body, /this\.cleanupTemp\(backupPath\)/);          // ④ 成功后才删备份
  assert.match(body, /this\.writeError\(/);                       // 类型化错误
  const verify = methodBody(SERVICE_CODE, 'verifyTmp');
  assert.match(verify, /actual\.length !== text\.length \|\| actual !== text/);
});

test('40 tmp/backup names use instance tag + timestamp + counter (no cross-instance collision)', () => {
  assert.match(SERVICE, /private instanceTag: string = Math\.random\(\)/);
  assert.match(SERVICE, /private writeSeq: number = 0/);
  const naming = methodBody(SERVICE_CODE, 'uniqueSuffix');
  assert.match(naming, /this\.writeSeq \+= 1/);
  assert.match(naming, /this\.instanceTag/);
  assert.match(naming, /Date\.now\(\)/);
  assert.match(naming, /this\.writeSeq/);
});

test('41 recoverTemps restores missing targets and reports, removes only equal stale tmp', () => {
  const body = methodBody(SERVICE_CODE, 'recoverTemps');
  assert.match(body, /fs\.listFileSync\(dir\)/);
  assert.match(body, /name\.includes\(TMP_INFIX\)/);
  assert.match(body, /name\.includes\(BAK_INFIX\)/);
  assert.match(body, /if \(!this\.fileExists\(targetPath\)\)/);
  assert.match(body, /fs\.renameSync\(sidePath, targetPath\)/); // 目标缺失 → 恢复
  assert.match(body, /console\.warn/);                          // 报告而非静默
  assert.match(body, /current === staged/);                     // 内容相同才删陈旧 tmp
  assert.match(body, /fs\.unlinkSync\(sidePath\)/);
  assert.doesNotMatch(body, /fs\.unlinkSync\(targetPath\)/);
  assert.match(methodBody(SERVICE_CODE, 'recoverOnce'), /this\.recoverTemps\(date\)/);
  assert.match(methodBody(SERVICE_CODE, 'atomicWriteIn'), /this\.recoverOnce\(dir\)/);
});

test('42 delete/undo API split: schedule ledger-only, restore precedence, purge physical', () => {
  const schedule = methodBody(SERVICE_CODE, 'scheduleDelete');
  assert.match(schedule, /ledgerDeleteLine\(id, ts, ts\)/);
  assert.match(schedule, /appendLedgerLine\(this\.dayDir\(date\), DELETED_FILE_NAME, line\)/);
  assert.doesNotMatch(schedule, /planRemove|RECORDS_FILE_NAME/); // schedule 不动记录行

  const undo = methodBody(SERVICE_CODE, 'restore');
  assert.match(undo, /parseLedger\(this\.readText/);
  assert.match(undo, /throw new Error\('restore 时间必须晚于删除'\)/);
  assert.match(undo, /appendLedgerLine\(dir, RESTORE_FILE_NAME, line\)/);
  assert.doesNotMatch(undo, /atomicWriteIn/); // 撤销也只写账本

  const purge = methodBody(SERVICE_CODE, 'purgeRows');
  assert.match(purge, /planRemove\(date, base, id\)/);
  assert.match(purge, /RECORDS_FILE_NAME/);
  assert.match(purge, /if \(!present\) \{\s*return;\s*\}/); // 幂等
});

test('43 remove() is a deprecated ledger-only wrapper, not a physical purge', () => {
  const body = methodBody(SERVICE_CODE, 'remove');
  assert.match(body, /this\.scheduleDelete\(id, date, ts\)/);
  assert.doesNotMatch(body, /planRemove|atomicWriteIn/);
  assert.match(SERVICE, /@deprecated 只等价于 `scheduleDelete`/);
});

test('44 all delete-phase entry points validate ts shape with a typed error', () => {
  for (const name of ['scheduleDelete', 'restore', 'purgeRows', 'remove']) {
    assert.match(methodBody(SERVICE_CODE, name), /this\.requireTs\(ts\)/, `${name} 未校验 ts`);
  }
  const guard = methodBody(SERVICE_CODE, 'requireTs');
  assert.match(guard, /isValidTsShape\(ts\)/);
  assert.match(guard, /throw new Error\(TS_SHAPE_ERROR\)/);
  assert.match(SERVICE, /TS_SHAPE_ERROR: string = 'E_TS_SHAPE: /); // 类型化错误码
});

test('45 header assigns assertWritable and the sync cycle to mod-v2-sync-protocol', () => {
  for (const source of [MODEL, SERVICE]) {
    assert.match(source, /mod-v2-sync-protocol/);
    assert.match(source, /assertWritable\(\)/);
  }
  assert.match(SERVICE, /单进程原子写/);
});

// ---------------------------------------------------------------- N1 / N2 修复（复审 2026-11-20）

test('46 canPurge: true only when the raw row exists and the delete ledger has the id', () => {
  const rows = [rec({ id: 'a' }), rec({ id: 'b', ts: T1400 })];
  const ledger = [{ id: 'a', ts: T1600, deletedAt: T1600 }];
  const rowsSnapshot = JSON.stringify(rows);
  const ledgerSnapshot = JSON.stringify(ledger);
  assert.equal(canPurge(rows, ledger, 'a'), true);
  assert.equal(canPurge(rows, [], 'a'), false);            // 账本缺失 → 拒绝
  assert.equal(canPurge(rows, ledger, 'missing'), false);  // 行缺失 → false
  assert.equal(canPurge([], ledger, 'a'), false);          // 空行集即使有账本也 false
  assert.equal(canPurge(rows, ledger, ''), false);         // 非法 id
  assert.equal(JSON.stringify(rows), rowsSnapshot);       // 纯函数：不改写入参
  assert.equal(JSON.stringify(ledger), ledgerSnapshot);
});

test('47 N1 purgeRows: raw allRecords baseline, canPurge guard before write, no visibleOf', () => {
  const purge = methodBody(SERVICE_CODE, 'purgeRows');
  assert.match(purge, /parseTimelineDay\(this\.readText\(this\.recordsPath\(date\)\), date\)/);
  assert.match(purge, /const base: TimelineRecord\[\] = parsed\.day\.allRecords/);
  assert.doesNotMatch(purge, /visibleOf/);                 // 不再走账本过滤视图
  assert.doesNotMatch(purge, /visibleRecords/);
  const guardAt = purge.indexOf('canPurge(');
  const removeAt = purge.indexOf('planRemove(');
  const writeAt = purge.indexOf('atomicWriteIn(');
  assert.ok(guardAt >= 0, 'purgeRows 未调用纯模型 canPurge');
  assert.ok(removeAt > 0 && writeAt > 0);
  assert.ok(guardAt < removeAt && guardAt < writeAt, 'canPurge 守卫必须先于写盘');
  const twImport = /import \{([^}]*)\} from '\.\.\/model\/timelineWrite'/.exec(SERVICE);
  assert.ok(twImport, 'timelineWrite 纯模型 import 未找到');
  assert.match(twImport[1], /\bcanPurge\b/);
});

test('48 N1 purgeRows: ledger precondition precedes idempotent no-op; typed E_PURGE_WITHOUT_LEDGER', () => {
  const purge = methodBody(SERVICE_CODE, 'purgeRows');
  const ledgerAt = purge.indexOf('PURGE_WITHOUT_LEDGER_ERROR');
  const noopAt = purge.indexOf('if (!present)');
  const planAt = purge.indexOf('planRemove(');
  assert.ok(ledgerAt >= 0, '缺少账本前置校验');
  assert.ok(noopAt > 0, '幂等短路丢失');
  assert.ok(ledgerAt < noopAt, '账本前置校验必须先于幂等 no-op');
  assert.ok(noopAt < planAt);
  assert.match(purge, /throw new Error\(PURGE_WITHOUT_LEDGER_ERROR\)/);
  assert.match(SERVICE, /PURGE_WITHOUT_LEDGER_ERROR: string = 'E_PURGE_WITHOUT_LEDGER/);
  assert.match(purge, /this\.requireTs\(ts\)/);
});

test('49 N2 planUpsert rejects malformed ts shape with ok:false and a reason', () => {
  for (const bad of ['', 'garbage', '2026-11-19', '2026-11-19 09:30:00', `${DAY}T99:99:99+08:00`]) {
    const plan = planUpsert(DAY, [], rec({ ts: bad }));
    assert.equal(plan.ok, false, bad);
    assert.equal(plan.text, '', bad);
    assert.match(plan.reason, /ts/, bad);
  }
  assert.equal(planUpsert(DAY, [], rec({ ts: T0930 })).ok, true);
  assert.equal(isValidTsShape(T1400), true);
});

test('50 N2 append validates record.ts shape before any IO (E_TS_SHAPE)', () => {
  const body = methodBody(SERVICE_CODE, 'append');
  const guardAt = body.indexOf('this.requireTs(record.ts)');
  const ioAt = body.indexOf('this.visibleOf(');
  const planAt = body.indexOf('planUpsert(');
  assert.ok(guardAt >= 0, 'append 未校验 record.ts 形状');
  assert.ok(ioAt > 0 && guardAt < ioAt, 'append 的 ts 校验必须在任何 IO 之前');
  assert.ok(planAt > guardAt, 'planUpsert 必须在 ts 校验之后');
  const guard = methodBody(SERVICE_CODE, 'requireTs');
  assert.match(guard, /isValidTsShape\(ts\)/);
  assert.match(guard, /throw new Error\(TS_SHAPE_ERROR\)/);
  assert.match(SERVICE, /TS_SHAPE_ERROR: string = 'E_TS_SHAPE: /);
});

test('51 N1 three-step delete flow intact: schedule ledger-only, restore ledger-only, purge physical', () => {
  const schedule = methodBody(SERVICE_CODE, 'scheduleDelete');
  assert.match(schedule, /this\.requireTs\(ts\)/);
  assert.match(schedule, /appendLedgerLine\(this\.dayDir\(date\), DELETED_FILE_NAME, line\)/);
  assert.doesNotMatch(schedule, /planRemove|atomicWriteIn/);
  const undo = methodBody(SERVICE_CODE, 'restore');
  assert.match(undo, /this\.requireTs\(ts\)/);
  assert.doesNotMatch(undo, /atomicWriteIn/);
  const purge = methodBody(SERVICE_CODE, 'purgeRows');
  assert.match(purge, /this\.requireTs\(ts\)/);
  assert.match(purge, /planRemove\(date, base, id\)/);
  assert.match(purge, /atomicWriteIn\(dir, RECORDS_FILE_NAME, plan\.text\)/);
});
