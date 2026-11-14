// JSONL 编解码 / 追加 / 折叠测试。
//
// 前置：先构建纯逻辑层
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendRecord,
  byDate,
  decodeLine,
  encodeRecord,
  foldById,
  parseJsonl,
  recordDateKey,
  sortRecords
} from '../.build/model/jsonl.js';

/** 造一条合法记录。 */
function makeRecord(overrides = {}) {
  return {
    id: 'rec-1',
    ts: '2026-11-14T09:30:00+08:00',
    title: '周会',
    body: '讨论排期',
    author: '我',
    done: false,
    ai_processed: false,
    ...overrides
  };
}

test('encodeRecord：单行 JSON + 恰好一个换行，且可被 decodeLine 还原', () => {
  const record = makeRecord({
    ocr_text: '手写原文',
    attachments: [{ sha256: 'a'.repeat(64), name: `${'a'.repeat(64)}.png`, pageIndex: 0 }],
    ai_structured: '- 待办',
    ocr_time: '2026-11-14T09:31:12+08:00'
  });
  const line = encodeRecord(record);
  assert.equal(line.endsWith('\n'), true);
  assert.equal(line.slice(0, -1).includes('\n'), false, '编码结果必须只有一行');
  assert.deepEqual(JSON.parse(line), record);
  assert.deepEqual(decodeLine(line), record);
});

test('encodeRecord：字段顺序固定（diff 友好），未提供的可选字段不出现', () => {
  const line = encodeRecord(makeRecord());
  const ordered = Object.keys(JSON.parse(line));
  assert.deepEqual(ordered, ['id', 'ts', 'title', 'body', 'author', 'done', 'ai_processed']);
});

test('encodeRecord：非法记录抛错（不写垃圾数据）', () => {
  assert.throws(() => encodeRecord({ ...makeRecord(), id: '' }), /id/);
  assert.throws(() => encodeRecord({ ...makeRecord(), done: 'yes' }), /done/);
  assert.throws(() => encodeRecord({ ...makeRecord(), attachments: [{ sha256: 'x' }] }), /attachments/);
});

test('decodeLine：空行/坏 JSON/字段缺失都返回 null', () => {
  assert.equal(decodeLine(''), null);
  assert.equal(decodeLine('   '), null);
  assert.equal(decodeLine('not-json'), null);
  assert.equal(decodeLine('{"id":"x"}'), null);
  assert.equal(decodeLine('[]'), null);
  const ok = decodeLine(encodeRecord(makeRecord()).trim());
  assert.equal(ok.id, 'rec-1');
});

test('parseJsonl：多行解析、空行跳过、坏行不中断且行号正确', () => {
  const text = [
    encodeRecord(makeRecord({ id: 'a' })).trim(),
    '',
    encodeRecord(makeRecord({ id: 'b' })).trim(),
    '{"id": "broken"', // 第 4 行：坏 JSON
    '{"id": "bad-fields", "ts": "2026-11-14T10:00:00+08:00"}', // 第 5 行：缺 title/body 等必填字段
    encodeRecord(makeRecord({ id: 'c' })).trim()
  ].join('\n');

  const parsed = parseJsonl(text);
  assert.deepEqual(
    parsed.records.map((record) => record.id),
    ['a', 'b', 'c']
  );
  assert.equal(parsed.errors.length, 2);
  assert.equal(parsed.errors[0].line, 4);
  assert.match(parsed.errors[0].message, /不是合法 JSON/);
  assert.equal(parsed.errors[1].line, 5);
  assert.match(parsed.errors[1].message, /字段校验失败/);
});

test('parseJsonl：空文本 / 全空行返回空结果', () => {
  assert.deepEqual(parseJsonl(''), { records: [], errors: [] });
  assert.deepEqual(parseJsonl('\n\n  \n'), { records: [], errors: [] });
});

test('parseJsonl：CRLF 换行也能解析', () => {
  const text = `${encodeRecord(makeRecord({ id: 'crlf' })).trim()}\r\n`;
  const parsed = parseJsonl(text);
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.records[0].id, 'crlf');
});

test('appendRecord：原文逐字节保留，只追加新行', () => {
  const first = encodeRecord(makeRecord({ id: 'a' }));
  const afterTwo = appendRecord(first, makeRecord({ id: 'b', ts: '2026-11-14T10:00:00+08:00' }));
  assert.equal(afterTwo.startsWith(first), true, '历史内容必须原样保留');
  assert.equal(afterTwo.length > first.length, true);

  const parsed = parseJsonl(afterTwo);
  assert.deepEqual(
    parsed.records.map((record) => record.id),
    ['a', 'b']
  );

  // 末尾缺换行时补一个，不会把两行粘在一起
  const withoutNewline = first.slice(0, -1);
  const patched = appendRecord(withoutNewline, makeRecord({ id: 'c' }));
  assert.equal(patched, `${withoutNewline}\n${encodeRecord(makeRecord({ id: 'c' }))}`);

  // 空文本直接写入一条
  const single = appendRecord('', makeRecord({ id: 'd' }));
  assert.equal(single, encodeRecord(makeRecord({ id: 'd' })));
});

test('appendRecord：连续追加 200 条后历史行数不变（只追加，绝不重写）', () => {
  let text = '';
  for (let i = 0; i < 200; i++) {
    text = appendRecord(text, makeRecord({ id: `rec-${i}`, ts: `2026-11-14T09:${String(i % 60).padStart(2, '0')}:00+08:00` }));
  }
  const lines = text.split('\n').filter((line) => line.length > 0);
  assert.equal(lines.length, 200);
  assert.equal(parseJsonl(text).errors.length, 0);
});

test('foldById：同 id 后者覆盖前者，跨设备折叠后只剩一条', () => {
  const records = [
    makeRecord({ id: 'x', done: false, ts: '2026-11-14T09:00:00+08:00' }),
    makeRecord({ id: 'x', done: true, ts: '2026-11-14T11:00:00+08:00' }),
    makeRecord({ id: 'y', ts: '2026-11-14T10:00:00+08:00' })
  ];
  const folded = foldById(records);
  assert.equal(folded.length, 2);
  const x = folded.find((record) => record.id === 'x');
  assert.equal(x.done, true, '后写（ts 更晚）的记录应覆盖先写');
  assert.equal(x.ts, '2026-11-14T11:00:00+08:00');
});

test('foldById：先按 ts 稳定升序再折叠（输入乱序也取较晚者）', () => {
  const records = [
    makeRecord({ id: 'x', title: '后写', ts: '2026-11-14T12:00:00+08:00' }),
    makeRecord({ id: 'y', ts: '2026-11-14T08:00:00+08:00' }),
    makeRecord({ id: 'x', title: '先写', ts: '2026-11-14T09:00:00+08:00' })
  ];
  const folded = foldById(records);
  // 折叠后按「各 id 首次出现（ts 升序）」排列：y(08:00) 先于 x(09:00 首次)
  assert.deepEqual(
    folded.map((record) => record.id),
    ['y', 'x']
  );
  assert.equal(folded[1].title, '后写', '同 id 取 ts 最晚的一条');
});

test('sortRecords：ts 升序、等值稳定、不改动入参', () => {
  const input = [
    makeRecord({ id: 'b', ts: '2026-11-14T10:00:00+08:00' }),
    makeRecord({ id: 'a', ts: '2026-11-14T09:00:00+08:00' }),
    makeRecord({ id: 'b2', ts: '2026-11-14T10:00:00+08:00' })
  ];
  const sorted = sortRecords(input);
  assert.deepEqual(
    sorted.map((record) => record.id),
    ['a', 'b', 'b2']
  );
  assert.deepEqual(
    input.map((record) => record.id),
    ['b', 'a', 'b2'],
    'sortRecords 必须返回新数组'
  );
});

test('byDate：按 ts 的日期前缀归属（跨时区阅读不会漂移）', () => {
  const records = [
    makeRecord({ id: 'early', ts: '2026-11-14T00:10:00+08:00' }),
    makeRecord({ id: 'late', ts: '2026-11-14T23:50:00+08:00' }),
    makeRecord({ id: 'next', ts: '2026-11-15T00:05:00+08:00' })
  ];
  assert.deepEqual(
    byDate(records, '2026-11-14').map((record) => record.id),
    ['early', 'late']
  );
  assert.deepEqual(byDate(records, '2026-11-15').map((record) => record.id), ['next']);
  assert.deepEqual(byDate(records, '2026-11-13'), []);
});

test('recordDateKey：ISO 前缀优先，无法识别返回空串', () => {
  assert.equal(recordDateKey('2026-11-14T23:30:00+08:00'), '2026-11-14');
  assert.equal(recordDateKey('2026-11-14T23:30:00Z'), '2026-11-14');
  assert.equal(recordDateKey('not-a-date'), '');
  assert.equal(recordDateKey(''), '');
});
