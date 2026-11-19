// mod-v2-read-timeline：v2 单时间线读取核心（纯模型）测试。
// node:test + node:assert/strict，import ../.build/model/timeline.js。
//
// 前置构建：node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
//
// 覆盖：一条一行 / pretty JSON 双形态、坏行与标量元素跳过计数、date 目录权威、未知字段往返、
//       §3 示例字节、closed_at 谓词（含纯空白）、账本删除/撤销优先级（含同 ts）、同 id 重复裁决
//       与 resolutions/duplicates 审计、媒体裸名与 sha256 校验、schema 门槛、路径、写排序、确定性、
//       同刻不同字节 ts 的 §4 裁决超集、allRecords 与统一读入口的复活防护。
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseTimelineDay, parseLedger, parseSchemaMarker, deletionState,
  visibleRecords, openRecords, canonicalRecordLine, sortRecordsForWrite, timelineDayPath
} from '../.build/model/timeline.js';

const DAY = '2026-11-19';
const T0930 = `${DAY}T09:30:00+08:00`;
const T1000 = `${DAY}T10:00:00+08:00`;
const T1400 = `${DAY}T14:00:00+08:00`;
const T1600 = `${DAY}T16:00:00+08:00`;
const T1700 = `${DAY}T17:00:00+08:00`;

/** 造一条合法 v2 记录。 */
function rec(overrides = {}) {
  return {
    id: 'a1', ts: T0930, title: '标题', body: '', author: '我', done: false,
    media: [], ai_processed: false, opened_at: T0930, ...overrides
  };
}

/** 按契约 §3 的「一条一行」布局拼出 records.json 文本。 */
function dayFile(records, { date = DAY, open = [] } = {}) {
  const lines = [
    '{',
    `  "date": ${JSON.stringify(date)},`,
    `  "open": ${JSON.stringify(open)},`,
    '  "records": ['
  ];
  records.forEach((record, i) => {
    lines.push(`    ${canonicalRecordLine(record)}${i < records.length - 1 ? ',' : ''}`);
  });
  lines.push('  ]', '}');
  return `${lines.join('\n')}\n`;
}

/** 把一条记录字符串直接塞进「一条一行」文件（用于注入坏行）。 */
function dayFileRaw(recordLines, { date = DAY, open = [] } = {}) {
  return [
    '{',
    `  "date": ${JSON.stringify(date)},`,
    `  "open": ${JSON.stringify(open)},`,
    '  "records": [',
    ...recordLines,
    '  ]',
    '}'
  ].join('\n') + '\n';
}

// 契约 §3 两条示例的字节（从 docs/DATA-CONTRACT-v2.md §3 原文复制）。
const EXAMPLE_A = '{"id":"m9x2k1-3fk","ts":"2026-11-19T09:30:00+08:00","title":"周会","body":"讨论同步方案","author":"我","done":false,"media":[],"ai_processed":false,"opened_at":"2026-11-19T09:30:00+08:00"}';
const EXAMPLE_B = '{"id":"n0y3l2-8ab","ts":"2026-11-19T14:00:00+08:00","title":"体检","body":"","author":"我","done":true,"media":[{"file":"ab12cd34ef567890.jpg","sha256":"ab12cd34ef567890abcdef0123456789abcdef0123456789abcdef0123456789","pageIndex":0}],"ocr_text":"体检单","ai_processed":true,"opened_at":"2026-11-19T14:00:00+08:00","closed_at":"2026-11-19T15:20:00+08:00"}';

// ---------------------------------------------------------------- parse: 双形态 / 坏行

test('01 one-record-per-line file parses (both records, no errors)', () => {
  const a = rec({ id: 'a1', title: '周会' });
  const b = rec({ id: 'b2', ts: T1400, title: '体检' });
  const parsed = parseTimelineDay(dayFile([a, b]), DAY);
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.day.date, DAY);
  assert.deepEqual(parsed.day.allRecords.map((r) => r.id), ['a1', 'b2']);
  assert.equal(parsed.day.allRecords[0].title, '周会');
});

test('02 pretty JSON (JSON.stringify with indentation) parses identically', () => {
  const a = rec({ id: 'a1', title: '周会' });
  const b = rec({ id: 'b2', ts: T1400, title: '体检', media: [
    { file: 'ab12cd34ef567890.jpg', sha256: 'ab12cd34ef567890abcdef0123456789abcdef0123456789abcdef0123456789', pageIndex: 0 }
  ] });
  const text = `${JSON.stringify({ date: DAY, open: ['a1'], records: [a, b] }, null, 2)}\n`;
  const parsed = parseTimelineDay(text, DAY);
  assert.equal(parsed.errors.length, 0, JSON.stringify(parsed.errors));
  assert.equal(parsed.day.allRecords.length, 2);
  assert.equal(parsed.day.allRecords[1].media.length, 1);
  assert.deepEqual(parsed.day.open, ['a1']);
});

test('03 malformed record line skipped + counted, valid lines kept', () => {
  const good = rec({ id: 'a1' });
  const text = dayFileRaw([
    `    ${canonicalRecordLine(good)},`,
    '    {this is not json},',
    `    ${canonicalRecordLine(rec({ id: 'b2', ts: T1400 }))}`
  ]);
  const parsed = parseTimelineDay(text, DAY);
  assert.equal(parsed.day.allRecords.length, 2);
  assert.deepEqual(parsed.day.allRecords.map((r) => r.id), ['a1', 'b2']);
  assert.equal(parsed.errors.length, 1);
  assert.ok(parsed.errors[0].line > 0);
  assert.match(parsed.errors[0].message, /JSON/);
});

test('04 invalid record element (bad field types) skipped + counted, never throws', () => {
  const text = dayFileRaw([
    `    ${canonicalRecordLine(rec({ id: 'a1' }))},`,
    '    {"id":"bad","ts":"x","title":1},',
    '    {"id":"","ts":"x","title":"t","body":"","author":"我","done":false,"media":[],"ai_processed":false,"opened_at":"x"}'
  ]);
  const parsed = parseTimelineDay(text, DAY);
  assert.equal(parsed.day.allRecords.length, 1);
  assert.equal(parsed.errors.length, 2);
  assert.ok(parsed.errors.every((e) => e.line >= 1));
});

test('05 empty text yields empty day, no errors', () => {
  const parsed = parseTimelineDay('', DAY);
  assert.equal(parsed.errors.length, 0);
  assert.deepEqual(parsed.day, { date: DAY, open: [], allRecords: [] });
});

test('06 unparsable garbage returns day=null with a typed error', () => {
  const parsed = parseTimelineDay('not json at all', DAY);
  assert.equal(parsed.day, null);
  assert.equal(parsed.errors.length, 1);
});

// ---------------------------------------------------------------- parse: date / 未知字段

test('07 date mismatch → error entry, day.date authoritative, records kept', () => {
  const parsed = parseTimelineDay(dayFile([rec({ id: 'a1' })], { date: '2026-11-20' }), DAY);
  assert.equal(parsed.day.date, DAY);
  assert.equal(parsed.day.allRecords.length, 1);
  assert.equal(parsed.errors.length, 1);
  assert.match(parsed.errors[0].message, /2026-11-20/);
  assert.match(parsed.errors[0].message, /2026-11-19/);
});

test('08 unknown fields preserved through parse and canonicalRecordLine (x:1 last)', () => {
  const record = { ...rec({ id: 'a1' }), x: 1 };
  const parsed = parseTimelineDay(dayFile([record]), DAY);
  assert.equal(parsed.day.allRecords[0].x, 1);
  const line = canonicalRecordLine(parsed.day.allRecords[0]);
  assert.ok(line.endsWith(',"x":1}'), line);
  assert.equal(JSON.parse(line).x, 1);
  assert.deepEqual(canonicalRecordLine(parsed.day.allRecords[0]), line);
});

// ---------------------------------------------------------------- 规范行字节

test('09 canonicalRecordLine matches §3 example A byte-for-byte (and shuffled keys)', () => {
  const r1 = {
    id: 'm9x2k1-3fk', ts: '2026-11-19T09:30:00+08:00', title: '周会', body: '讨论同步方案',
    author: '我', done: false, media: [], ai_processed: false, opened_at: '2026-11-19T09:30:00+08:00'
  };
  assert.equal(canonicalRecordLine(r1), EXAMPLE_A);
  const shuffled = {};
  for (const key of ['opened_at', 'ai_processed', 'media', 'done', 'author', 'body', 'title', 'ts', 'id']) {
    shuffled[key] = r1[key];
  }
  assert.equal(canonicalRecordLine(shuffled), EXAMPLE_A);
  assert.equal(canonicalRecordLine(shuffled), canonicalRecordLine(shuffled));
});

test('10 canonicalRecordLine matches §3 example B byte-for-byte (media + optional slots)', () => {
  const r2 = {
    id: 'n0y3l2-8ab', ts: '2026-11-19T14:00:00+08:00', title: '体检', body: '', author: '我', done: true,
    media: [{ file: 'ab12cd34ef567890.jpg', sha256: 'ab12cd34ef567890abcdef0123456789abcdef0123456789abcdef0123456789', pageIndex: 0 }],
    ocr_text: '体检单', ai_processed: true, opened_at: '2026-11-19T14:00:00+08:00', closed_at: '2026-11-19T15:20:00+08:00'
  };
  assert.equal(canonicalRecordLine(r2), EXAMPLE_B);
});

test('11 canonicalRecordLine orders optional slots and multiple unknown keys by insertion', () => {
  const record = rec({
    closed_at: T1400, ocr_time: T1000, ai_structured: '{}', ocr_text: 'ocr',
    zz: 2, aa: 1
  });
  const line = canonicalRecordLine(record);
  const keys = Object.keys(JSON.parse(line));
  assert.deepEqual(keys, [
    'id', 'ts', 'title', 'body', 'author', 'done', 'media',
    'ocr_text', 'ai_structured', 'ai_processed', 'ocr_time', 'opened_at', 'closed_at',
    'zz', 'aa'
  ]);
  assert.ok(!/\s/.test(line.replace(/我|标题|ocr/g, '')), 'JSON internal must have no spaces');
});

test('12 canonicalRecordLine omits absent optional fields', () => {
  const line = canonicalRecordLine(rec({ id: 'a1' }));
  for (const key of ['ocr_text', 'ai_structured', 'ocr_time', 'closed_at']) {
    assert.ok(!line.includes(`"${key}"`));
  }
});

// ---------------------------------------------------------------- open 谓词

test('13 openRecords: closed_at missing / empty / null are open; set is not (done ignored)', () => {
  const day = {
    date: DAY, open: [], allRecords: [
      rec({ id: 'missing' }),
      rec({ id: 'empty', closed_at: '' }),
      rec({ id: 'null', closed_at: null }),
      rec({ id: 'set', closed_at: T1600 })
    ]
  };
  const open = openRecords(day, [], []);
  assert.deepEqual(open.map((r) => r.id), ['missing', 'empty', 'null']);
});

test('14 openRecords never uses done flag', () => {
  const day = {
    date: DAY, open: [], allRecords: [
      rec({ id: 'done-no-closed', done: true }),
      rec({ id: 'not-done-with-closed', done: false, closed_at: T1600 })
    ]
  };
  assert.deepEqual(openRecords(day, [], []).map((r) => r.id), ['done-no-closed']);
});

test('15 openRecords ignores stale stored day.open array', () => {
  const day = { date: DAY, open: ['ghost'], allRecords: [rec({ id: 'a1' })] };
  assert.deepEqual(openRecords(day, [], []).map((r) => r.id), ['a1']);
});

// ---------------------------------------------------------------- 账本

test('16 parseLedger parses valid entries with deletedAt / restoredAt', () => {
  const text = [
    JSON.stringify({ id: 'a1', ts: T1600, deletedAt: T1600, intentId: 'i1' }),
    JSON.stringify({ id: 'a1', ts: T1700, restoredAt: T1700 })
  ].join('\n') + '\n';
  const parsed = parseLedger(text);
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.entries.length, 2);
  assert.equal(parsed.entries[0].deletedAt, T1600);
  assert.equal(parsed.entries[1].restoredAt, T1700);
});

test('17 parseLedger skips bad lines + blank lines, counts errors', () => {
  const text = [
    JSON.stringify({ id: 'a1', ts: T1600 }),
    '',
    'broken',
    JSON.stringify({ id: '', ts: T1600 }),
    JSON.stringify({ id: 'b2' })
  ].join('\n') + '\n';
  const parsed = parseLedger(text);
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.errors.length, 3);
  assert.deepEqual(parsed.errors.map((e) => e.line), [3, 4, 5]);
});

test('18 deletionState: no deletion → visible', () => {
  assert.equal(deletionState('a1', [], [{ id: 'a1', ts: T1700 }]), 'visible');
});

test('19 deletionState precedence D<R visible, D>R deleted, D=R deleted', () => {
  const del = [{ id: 'a1', ts: T1600 }];
  assert.equal(deletionState('a1', del, [{ id: 'a1', ts: T1700 }]), 'visible');
  assert.equal(deletionState('a1', [{ id: 'a1', ts: T1700 }], [{ id: 'a1', ts: T1600 }]), 'deleted');
  assert.equal(deletionState('a1', del, [{ id: 'a1', ts: T1600 }]), 'deleted');
});

test('20 deletionState: later ts among multiple deletes / restores wins', () => {
  const deletions = [{ id: 'a1', ts: T0930 }, { id: 'a1', ts: T1700 }];
  const restores = [{ id: 'a1', ts: T1600 }]; // later restore than earliest delete, but not the max delete
  assert.equal(deletionState('a1', deletions, restores), 'deleted');
  const restores2 = [...restores, { id: 'a1', ts: T1700 }]; // equal to max delete → still deleted
  assert.equal(deletionState('a1', deletions, restores2), 'deleted');
  const restores3 = [...restores, { id: 'a1', ts: '2026-11-19T17:00:01+08:00' }];
  assert.equal(deletionState('a1', deletions, restores3), 'visible');
});

test('21 deletionState is id-scoped', () => {
  assert.equal(deletionState('a1', [{ id: 'b2', ts: T1600 }], []), 'visible');
  assert.equal(deletionState('a1', [{ id: 'b2', ts: T1600 }], [{ id: 'b2', ts: T1700 }]), 'visible');
});

test('22 visibleRecords filters deleted ids and keeps visible ones', () => {
  const day = { date: DAY, open: [], allRecords: [rec({ id: 'a1' }), rec({ id: 'b2', ts: T1400 })] };
  const result = visibleRecords(day, [{ id: 'a1', ts: T1600 }], []);
  assert.deepEqual(result.map((r) => r.id), ['b2']);
});

test('23 visibleRecords + openRecords apply ledger before open predicate', () => {
  const day = { date: DAY, open: [], allRecords: [rec({ id: 'a1' }), rec({ id: 'b2', ts: T1400, closed_at: T1600 })] };
  const restores = [{ id: 'a1', ts: T1700 }];
  assert.deepEqual(openRecords(day, [{ id: 'a1', ts: T1600 }], restores).map((r) => r.id), ['a1']);
});

// ---------------------------------------------------------------- 同 id 重复折叠

test('24 duplicate id: later ts wins', () => {
  const text = dayFile([
    rec({ id: 'a1', ts: T0930, body: 'old' }),
    rec({ id: 'a1', ts: T1400, body: 'new' })
  ]);
  const parsed = parseTimelineDay(text, DAY);
  assert.equal(parsed.day.allRecords.length, 1);
  assert.equal(parsed.day.allRecords[0].ts, T1400);
  assert.equal(parsed.day.allRecords[0].body, 'new');
  // 不同 ts 的静默折叠不产生 §4 裁决明细
  assert.deepEqual(parsed.resolutions, []);
  assert.equal(parsed.duplicates, 0);
});

test('25 duplicate id same ts: UTF-8 byte-larger canonical line wins (body B > A)', () => {
  const text = dayFile([
    rec({ id: 'a1', ts: T0930, body: 'A' }),
    rec({ id: 'a1', ts: T0930, body: 'B' })
  ]);
  const parsed = parseTimelineDay(text, DAY);
  assert.equal(parsed.day.allRecords.length, 1);
  assert.equal(parsed.day.allRecords[0].body, 'B');
  assert.equal(parsed.resolutions.length, 1);
  assert.deepEqual(parsed.resolutions[0], {
    id: 'a1', ts: T0930,
    winner: canonicalRecordLine(rec({ id: 'a1', ts: T0930, body: 'B' })),
    losers: [canonicalRecordLine(rec({ id: 'a1', ts: T0930, body: 'A' }))],
    reason: 'equal-ts-byte-order'
  });
  assert.equal(parsed.duplicates, 0);
});

test('26 duplicate id same ts: byte-larger wins even when it appears first', () => {
  const text = dayFile([
    rec({ id: 'a1', ts: T0930, body: 'B' }),
    rec({ id: 'a1', ts: T0930, body: 'A' })
  ]);
  const parsed = parseTimelineDay(text, DAY);
  assert.equal(parsed.day.allRecords[0].body, 'B');
  assert.equal(parsed.resolutions.length, 1);
  assert.equal(parsed.resolutions[0].losers[0], canonicalRecordLine(rec({ id: 'a1', ts: T0930, body: 'A' })));
  assert.equal(parsed.resolutions[0].winner, canonicalRecordLine(rec({ id: 'a1', ts: T0930, body: 'B' })));
  assert.equal(parsed.resolutions[0].reason, 'equal-ts-byte-order');
});

test('27 identical duplicate canonical lines collapse to one record', () => {
  const row = rec({ id: 'a1', ts: T0930, body: 'same' });
  const parsed = parseTimelineDay(dayFile([row, { ...row }]), DAY);
  assert.equal(parsed.day.allRecords.length, 1);
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.resolutions.length, 1);
  assert.equal(parsed.resolutions[0].reason, 'identical');
  assert.equal(parsed.resolutions[0].winner, canonicalRecordLine(row));
  assert.deepEqual(parsed.resolutions[0].losers, [canonicalRecordLine(row)]);
  assert.equal(parsed.duplicates, 1);
});

// ---------------------------------------------------------------- P1-1 / P2 行为用例（替换实现琐事元测试）

test('39 resolutions/duplicates: multi-id fold report is correct and auditable', () => {
  const text = dayFile([
    rec({ id: 'x', ts: T0930, body: 'A' }),
    rec({ id: 'x', ts: T0930, body: 'B' }),   // x: 同 ts 字节裁决
    rec({ id: 'y', ts: T1400, body: 'same' }),
    rec({ id: 'y', ts: T1400, body: 'same' }), // y: 完全相同 → identical + duplicates
    rec({ id: 'z', ts: T0930, body: 'old' }),
    rec({ id: 'z', ts: T1600, body: 'new' })  // z: 不同 ts 静默折叠，不记 resolution
  ]);
  const parsed = parseTimelineDay(text, DAY);
  assert.equal(parsed.day.allRecords.length, 3);
  assert.deepEqual(parsed.day.allRecords.map((r) => r.id), ['x', 'y', 'z']);
  assert.equal(parsed.resolutions.length, 2);
  const byId = new Map(parsed.resolutions.map((r) => [r.id, r]));
  assert.equal(byId.get('x').reason, 'equal-ts-byte-order');
  assert.equal(byId.get('x').ts, T0930);
  assert.equal(byId.get('x').winner, canonicalRecordLine(rec({ id: 'x', ts: T0930, body: 'B' })));
  assert.deepEqual(byId.get('x').losers, [canonicalRecordLine(rec({ id: 'x', ts: T0930, body: 'A' }))]);
  assert.equal(byId.get('y').reason, 'identical');
  assert.equal(byId.get('y').winner, canonicalRecordLine(rec({ id: 'y', ts: T1400, body: 'same' })));
  assert.equal(parsed.duplicates, 1);
  assert.equal(byId.has('z'), false);
  // 确定性：同输入两次得到同样的裁决明细
  assert.deepEqual(parseTimelineDay(text, DAY).resolutions, parsed.resolutions);
});

test('40 allRecords keeps deleted rows; visibleRecords/openRecords are the only display path', () => {
  const parsed = parseTimelineDay(dayFile([
    rec({ id: 'a1' }),
    rec({ id: 'b2', ts: T1400, closed_at: T1600 })
  ]), DAY);
  assert.deepEqual(parsed.day.allRecords.map((r) => r.id), ['a1', 'b2']);
  const deleted = [{ id: 'a1', ts: T1600 }];
  // 裸读 allRecords 会「复活」已删记录，只有统一入口会过滤
  assert.equal(parsed.day.allRecords.some((r) => r.id === 'a1'), true);
  assert.deepEqual(visibleRecords(parsed.day, deleted, []).map((r) => r.id), ['b2']);
  assert.deepEqual(openRecords(parsed.day, deleted, []).map((r) => r.id), []);
  // 漏传 restore 账本 = 关闭过滤；同时传两本、R>D 才恢复可见
  assert.deepEqual(visibleRecords(parsed.day, deleted, [{ id: 'a1', ts: T1700 }]).map((r) => r.id), ['a1', 'b2']);
  assert.deepEqual(openRecords(parsed.day, deleted, [{ id: 'a1', ts: T1700 }]).map((r) => r.id), ['a1']);
});

test('41 scalar elements inside records[] are skipped and counted as errors', () => {
  const text = dayFileRaw([
    `    ${canonicalRecordLine(rec({ id: 'a1' }))},`,
    '    42,',
    '    "oops",',
    '    null,',
    '    true,',
    '    [1,2]'
  ]);
  const parsed = parseTimelineDay(text, DAY);
  assert.deepEqual(parsed.day.allRecords.map((r) => r.id), ['a1']);
  assert.equal(parsed.errors.length, 5);
  assert.ok(parsed.errors.every((e) => /非对象元素/.test(e.message)));
  assert.ok(parsed.errors.every((e) => e.line >= 1));
});

test('42 media.sha256 must be 64 lowercase hex (bad ones dropped + counted)', () => {
  const sha = 'ab12cd34ef567890abcdef0123456789abcdef0123456789abcdef0123456789';
  const invalids = [
    'not-hex-!!',
    'AB12CD34EF567890ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789',
    'ab12cd34ef567890',
    sha.slice(1),
    `${sha}0`
  ];
  for (const bad of invalids) {
    const parsed = parseTimelineDay(dayFile([
      rec({ id: 'a1', media: [{ file: 'ab12cd34ef567890.jpg', sha256: bad, pageIndex: 0 }] })
    ]), DAY);
    assert.equal(parsed.day.allRecords.length, 1, `record must survive bad sha256: ${bad}`);
    assert.equal(parsed.day.allRecords[0].media.length, 0, `bad sha256 must drop media: ${bad}`);
    assert.equal(parsed.errors.length, 1, `one error for bad sha256: ${bad}`);
    assert.match(parsed.errors[0].message, /64 位小写十六进制/);
  }
  const good = parseTimelineDay(dayFile([
    rec({ id: 'a1', media: [{ file: 'ab12cd34ef567890.jpg', sha256: sha, pageIndex: 0 }] })
  ]), DAY);
  assert.equal(good.errors.length, 0);
  assert.equal(good.day.allRecords[0].media.length, 1);
});

test('43 whitespace-only closed_at counts as missing → open', () => {
  const day = {
    date: DAY, open: [], allRecords: [
      rec({ id: 'ws', closed_at: '   ' }),
      rec({ id: 'tabs', closed_at: '\t\n ' }),
      rec({ id: 'empty', closed_at: '' }),
      rec({ id: 'missing' }),
      rec({ id: 'set', closed_at: T1600 })
    ]
  };
  assert.deepEqual(openRecords(day, [], []).map((r) => r.id), ['ws', 'tabs', 'empty', 'missing']);
});

test('44 tie-break superset: two byte-different ts of the same instant still use §4 byte order', () => {
  // 01:30Z === 09:30+08:00：compareTs()===0（有意超集，见头文件注释），进入规范行字节序裁决。
  // ts 字段在 body 之前，'9'(0x39) > '1'(0x31)，故 +08:00 行胜；这不是「较晚 ts 静默胜」。
  const plus08 = rec({ id: 'a1', ts: T0930, body: 'A' });
  const zulu = rec({ id: 'a1', ts: `${DAY}T01:30:00Z`, body: 'B' });
  const parsed = parseTimelineDay(dayFile([plus08, zulu]), DAY);
  assert.equal(parsed.day.allRecords.length, 1);
  assert.equal(parsed.day.allRecords[0].body, 'A');
  assert.equal(parsed.day.allRecords[0].ts, T0930);
  assert.equal(parsed.resolutions.length, 1);
  assert.equal(parsed.resolutions[0].reason, 'equal-ts-byte-order');
  assert.equal(parsed.resolutions[0].winner, canonicalRecordLine(plus08));
  assert.deepEqual(parsed.resolutions[0].losers, [canonicalRecordLine(zulu)]);
});

// ---------------------------------------------------------------- 媒体裸名

test('28 valid bare <hex16>.jpg media kept', () => {
  const media = [{ file: 'ab12cd34ef567890.jpg', sha256: 'ab12cd34ef567890abcdef0123456789abcdef0123456789abcdef0123456789', pageIndex: 2 }];
  const parsed = parseTimelineDay(dayFile([rec({ id: 'a1', media })]), DAY);
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.day.allRecords[0].media.length, 1);
  assert.equal(parsed.day.allRecords[0].media[0].pageIndex, 2);
});

test('29 media bare-name rejection: media/x.jpg, ../x.jpg, C:/x.jpg, ab.jpg', () => {
  const badFiles = ['media/x.jpg', '../x.jpg', 'C:/x.jpg', 'ab.jpg'];
  const sha = 'ab12cd34ef567890abcdef0123456789abcdef0123456789abcdef0123456789';
  for (const file of badFiles) {
    const parsed = parseTimelineDay(dayFile([rec({ id: 'a1', media: [{ file, sha256: sha, pageIndex: 0 }] })]), DAY);
    assert.equal(parsed.day.allRecords.length, 1, `record must survive bad file ${file}`);
    assert.equal(parsed.day.allRecords[0].media.length, 0, `bad media dropped for ${file}`);
    assert.equal(parsed.errors.length, 1, `one error for ${file}`);
    assert.match(parsed.errors[0].message, /裸文件名/);
  }
});

test('30 partially invalid media keeps valid entries and counts only invalid ones', () => {
  const sha = 'ab12cd34ef567890abcdef0123456789abcdef0123456789abcdef0123456789';
  const media = [
    { file: 'ab12cd34ef567890.jpg', sha256: sha, pageIndex: 0 },
    { file: '/bad.jpg', sha256: sha, pageIndex: 1 }
  ];
  const parsed = parseTimelineDay(dayFile([rec({ id: 'a1', media })]), DAY);
  assert.equal(parsed.day.allRecords[0].media.length, 1);
  assert.equal(parsed.day.allRecords[0].media[0].pageIndex, 0);
  assert.equal(parsed.errors.length, 1);
});

// ---------------------------------------------------------------- schema / 路径 / 排序 / 确定性

test('31 parseSchemaMarker: 2 ok, extra keys allowed', () => {
  const ok = parseSchemaMarker('{"schemaVersion":2}');
  assert.deepEqual(ok, { ok: true, version: 2, reason: '' });
  assert.equal(parseSchemaMarker('{"schemaVersion":2,"migratedAt":"x","source":"v1"}').ok, true);
});

test('32 parseSchemaMarker: version 3 → reason names the version', () => {
  const r = parseSchemaMarker('{"schemaVersion":3}');
  assert.equal(r.ok, false);
  assert.equal(r.version, 3);
  assert.match(r.reason, /3/);
});

test('33 parseSchemaMarker: missing / garbage / wrong type → typed reason, version null', () => {
  const missing = parseSchemaMarker('{}');
  assert.equal(missing.ok, false);
  assert.equal(missing.version, null);
  assert.match(missing.reason, /缺少/);
  const garbage = parseSchemaMarker('{not json');
  assert.equal(garbage.ok, false);
  assert.equal(garbage.version, null);
  assert.match(garbage.reason, /JSON/);
  const wrong = parseSchemaMarker('{"schemaVersion":"2"}');
  assert.equal(wrong.ok, false);
  assert.equal(wrong.version, null);
  assert.match(wrong.reason, /数字/);
});

test('34 timelineDayPath uses the contract layout', () => {
  assert.equal(timelineDayPath('2026-11-19'), 'timeline/2026-11-19/records.json');
  assert.equal(timelineDayPath('2026-01-02'), 'timeline/2026-01-02/records.json');
});

test('35 sortRecordsForWrite: ts then id, non-mutating', () => {
  const input = [
    rec({ id: 'b', ts: T1000 }),
    rec({ id: 'a', ts: T1400 }),
    rec({ id: 'a2', ts: T1000 }),
    rec({ id: 'c', ts: T0930 })
  ];
  const snapshot = input.slice();
  const sorted = sortRecordsForWrite(input);
  assert.deepEqual(sorted.map((r) => r.id), ['c', 'a2', 'b', 'a']);
  assert.deepEqual(input, snapshot, 'input must not be mutated');
});

test('36 determinism: same input twice → deep-equal objects and byte-equal canonical lines', () => {
  const text = dayFile([
    rec({ id: 'a1', ts: T0930, x: 1 }),
    rec({ id: 'b2', ts: T1400, media: [{ file: 'ab12cd34ef567890.jpg', sha256: 'ab12cd34ef567890abcdef0123456789abcdef0123456789abcdef0123456789', pageIndex: 0 }] })
  ]);
  const first = parseTimelineDay(text, DAY);
  const second = parseTimelineDay(text, DAY);
  assert.deepEqual(first, second);
  const lines = first.day.allRecords.map((r) => canonicalRecordLine(r));
  assert.deepEqual(lines, second.day.allRecords.map((r) => canonicalRecordLine(r)));
  assert.equal(lines.join('\n'), second.day.allRecords.map((r) => canonicalRecordLine(r)).join('\n'));
});

// 注：原「恰好 9 个导出」与「源码正则查 Date.now」两条实现琐事元测试已移除，
// 替换为上面的 39–44 条契约行为用例（resolutions/duplicates、allRecords 与账本过滤、
// 标量元素计数、sha256 校验、空白 closed_at、同刻不同字节 ts 的裁决）。
