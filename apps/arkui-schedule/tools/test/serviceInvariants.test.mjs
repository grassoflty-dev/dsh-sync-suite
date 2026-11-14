// 服务层三条不变量的可执行验证（Node，纯逻辑层）。
//
// 前置：先构建纯逻辑层
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
//
// 覆盖 Lead 的 P0-3：
// 1. JSONL 只追加、不重写历史行（`appendRecord` 的属性断言）；
// 2. AI 汇总只处理 `ai_processed:false` 且**永不改** `ocr_text`（`buildAiPayload` / `applyAiResult`）。
// （第 1 条「提交路径只写 devices/<deviceId>/」在 syncScope.test.mjs。）
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { applyAiResult, buildAiPayload } from '../.build/model/aiPayload.js';
import { appendRecord, encodeRecord, foldById, parseJsonl, recordDateKey } from '../.build/model/jsonl.js';

const DAY = '2026-11-14';

function makeRecord(overrides = {}) {
  return {
    id: 'r1',
    ts: `${DAY}T09:00:00+08:00`,
    title: '周会',
    body: '正文',
    author: '我',
    done: false,
    ai_processed: false,
    ...overrides
  };
}

describe('JSONL：只追加、不重写历史行', () => {
  test('任意已有文本 t 与记录 r：appendRecord(t,r) 以 t 为前缀，且只在末尾新增一行', () => {
    const existingTexts = [
      '',
      'x',
      'x\n',
      'a\nb',
      'a\nb\n',
      '\n',
      '  spaces  \n',
      '{"broken":',
      '一行\r\n二行\n',
      '中文 📎\n{"看起来像记录":true}',
      '\n\n\n'
    ];
    const record = makeRecord();

    for (const text of existingTexts) {
      const next = appendRecord(text, record);
      assert.ok(next.startsWith(text), `追加后必须以原文本为前缀：${JSON.stringify(text)}`);
      const suffix = next.slice(text.length);
      const separator = text === '' || text.endsWith('\n') ? '' : '\n';
      const encoded = encodeRecord(record);
      assert.equal(suffix, separator + encoded, '新增内容 = 可选的分隔换行 + 编码后的一行');
      assert.equal(encoded.slice(0, -1).indexOf('\n'), -1, '记录部分本身必须是单行');
      assert.equal(suffix.slice(separator.length), encoded, '历史内容之后只跟一条记录');

      // 解析层面：只多出一条合法记录
      assert.equal(
        parseJsonl(next).records.length,
        parseJsonl(text).records.length + 1,
        `记录数必须 +1：${JSON.stringify(text)}`
      );

      // 字节层面：历史字节一个都不改
      const before = Buffer.from(text, 'utf8');
      const after = Buffer.from(next, 'utf8');
      assert.equal(after.subarray(0, before.length).compare(before), 0, '历史字节必须逐字节保留');
    }
  });

  test('追加两次：两次前缀都成立，历史行顺序不变', () => {
    const host = '{"手工行":1}\n第二行历史\n';
    const first = makeRecord({ id: 'r1', ts: `${DAY}T09:00:00+08:00` });
    const second = makeRecord({ id: 'r2', ts: `${DAY}T10:00:00+08:00` });

    const once = appendRecord(host, first);
    const twice = appendRecord(once, second);

    assert.ok(once.startsWith(host));
    assert.ok(twice.startsWith(once));
    assert.ok(twice.startsWith(host));
    assert.deepEqual(twice.trimEnd().split('\n').slice(0, 2), ['{"手工行":1}', '第二行历史']);
    assert.deepEqual(
      parseJsonl(twice).records.map((record) => record.id),
      ['r1', 'r2']
    );
  });

  test('同日文件不重排历史：后写的更早 ts 记录排在末尾，不发生插入/排序', () => {
    const later = makeRecord({ id: 'later', ts: `${DAY}T18:00:00+08:00` });
    const earlier = makeRecord({ id: 'earlier', ts: `${DAY}T08:00:00+08:00` });

    let text = appendRecord('', later);
    text = appendRecord(text, earlier);

    const lines = text.trimEnd().split('\n');
    assert.equal(JSON.parse(lines[0]).id, 'later', '先写入的记录必须仍在第一行');
    assert.equal(JSON.parse(lines[1]).id, 'earlier');
    // 两条都属于同一天 → 写同一个 YYYY-MM-DD.jsonl，不存在迁移/重排
    assert.equal(recordDateKey(JSON.parse(lines[0]).ts), DAY);
    assert.equal(recordDateKey(JSON.parse(lines[1]).ts), DAY);
  });

  test('同 id 的更新也是追加：历史两行都保留，读时 foldById 折叠为最新', () => {
    const older = makeRecord({ id: 'same', ts: `${DAY}T09:00:00+08:00`, title: '旧标题' });
    const newer = makeRecord({ id: 'same', ts: `${DAY}T09:00:00.001+08:00`, title: '新标题' });

    const text = appendRecord(appendRecord('', older), newer);
    assert.equal(parseJsonl(text).records.length, 2, '历史行不得被重写或删除');
    const folded = foldById(parseJsonl(text).records);
    assert.equal(folded.length, 1);
    assert.equal(folded[0].title, '新标题', '折叠取 ts 较晚的一条');
    assert.ok(text.indexOf('旧标题') < text.indexOf('新标题'), '旧行在前，新行追加在后');
  });
});

describe('AI 汇总：只处理 ai_processed:false，且不改 ocr_text', () => {
  test('buildAiPayload 只含当天且未处理的记录', () => {
    const records = [
      makeRecord({ id: 'today-pending', ts: `${DAY}T09:00:00+08:00` }),
      makeRecord({ id: 'today-done', ts: `${DAY}T10:00:00+08:00`, ai_processed: true }),
      makeRecord({ id: 'yesterday', ts: '2026-11-13T23:58:00+08:00' }),
      makeRecord({ id: 'tomorrow', ts: '2026-11-15T00:10:00+08:00' })
    ];
    const payload = buildAiPayload(DAY, records);
    assert.equal(payload.date, DAY);
    assert.deepEqual(
      payload.records.map((item) => item.id),
      ['today-pending']
    );
    assert.equal(payload.records[0].ocr_time, `${DAY}T09:00:00+08:00`, '缺 ocr_time 时回退 ts');
    assert.equal(payload.records[0].text, '正文');
  });

  test('buildAiPayload 的 text 优先 body，body 为空回退 ocr_text；ocr_time 优先记录值', () => {
    const records = [
      makeRecord({ id: 'a', body: '人工整理后的正文', ocr_text: '原始 OCR A' }),
      makeRecord({ id: 'b', body: '   ', ocr_text: '原始 OCR B', ocr_time: `${DAY}T11:11:11+08:00` })
    ];
    const payload = buildAiPayload(DAY, records);
    assert.equal(payload.records[0].text, '人工整理后的正文');
    assert.equal(payload.records[0].ocr_time, `${DAY}T09:00:00+08:00`);
    assert.equal(payload.records[1].text, '原始 OCR B');
    assert.equal(payload.records[1].ocr_time, `${DAY}T11:11:11+08:00`);
  });

  test('buildAiPayload 非法日期抛错；当天无可处理记录时为空载荷', () => {
    assert.throws(() => buildAiPayload('2026-11-14T00:00:00', []), /日期格式/);
    assert.throws(() => buildAiPayload('20261114', []), /日期格式/);
    assert.deepEqual(buildAiPayload(DAY, []).records, []);
    assert.deepEqual(buildAiPayload(DAY, [makeRecord({ ai_processed: true })]).records, []);
  });

  test('applyAiResult 只写 ai_structured 与 ai_processed:true，ocr_text 逐条不变', () => {
    const records = [
      makeRecord({
        id: 'a',
        ocr_text: '原始识别 A',
        attachments: [{ sha256: 'a'.repeat(64), name: `${'a'.repeat(64)}.png`, pageIndex: 0 }]
      }),
      makeRecord({ id: 'b', ocr_text: '原始识别 B' }),
      makeRecord({ id: 'c', ocr_text: '原始识别 C', ai_processed: true })
    ];
    const snapshot = structuredClone(records);

    const updated = applyAiResult(records, { a: 'AI 结构化 A' }, ['a']);

    assert.equal(updated.length, 3);
    assert.equal(updated[0].ai_structured, 'AI 结构化 A');
    assert.equal(updated[0].ai_processed, true);
    // 回归点：ocr_text / attachments 等字段一律不动
    assert.deepEqual(
      updated.map((record) => record.ocr_text),
      ['原始识别 A', '原始识别 B', '原始识别 C']
    );
    assert.deepEqual(updated[0].attachments, snapshot[0].attachments);
    // 入参不被原地修改（返回新对象/新数组）
    assert.deepEqual(records, snapshot, 'applyAiResult 不得修改入参');
    assert.notStrictEqual(updated[0], records[0], '被处理记录应返回新对象');
  });

  test('未选中记录不被修改（深比较 + 引用未替换）', () => {
    const records = [
      makeRecord({ id: 'selected', ocr_text: 'OCR selected' }),
      makeRecord({ id: 'untouched', ocr_text: 'OCR untouched', body: '保持原样' }),
      makeRecord({ id: 'already-done', ocr_text: 'OCR done', ai_processed: true, ai_structured: '旧结构化' })
    ];
    const snapshot = structuredClone(records);

    const updated = applyAiResult(records, { selected: '新结构化' }, ['selected']);

    assert.deepEqual(updated[1], snapshot[1], '未选中记录必须逐字段不变');
    assert.deepEqual(updated[2], snapshot[2], '已处理记录必须逐字段不变');
    assert.equal(updated[1].ai_processed, false);
    assert.equal(updated[2].ai_processed, true);
    assert.equal(updated[2].ai_structured, '旧结构化');
  });

  test('processedIds 命中但不给结构化文本：只翻 ai_processed，不凭空写 ai_structured', () => {
    const records = [makeRecord({ id: 'a', ocr_text: '原始 OCR' })];
    const updated = applyAiResult(records, {}, ['a']);
    assert.equal(updated[0].ai_processed, true);
    assert.equal('ai_structured' in updated[0], false);
    assert.equal(updated[0].ocr_text, '原始 OCR');
  });

  test('applyAiResult 之后再 buildAiPayload：已处理记录不再提交，未选中记录仍可提交', () => {
    const records = [
      makeRecord({ id: 'a', ocr_text: 'OCR A' }),
      makeRecord({ id: 'b', ocr_text: 'OCR B' })
    ];
    const updated = applyAiResult(records, { a: '结构化 A' }, ['a']);

    const payload = buildAiPayload(DAY, updated);
    assert.deepEqual(
      payload.records.map((item) => item.id),
      ['b'],
      '只处理 ai_processed:false 的记录'
    );
    assert.equal(payload.records[0].text, '正文');
    assert.deepEqual(
      updated.map((record) => record.ocr_text),
      ['OCR A', 'OCR B'],
      'AI 汇总不得改 ocr_text'
    );
  });
});
