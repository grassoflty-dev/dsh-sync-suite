// AI 载荷 / 提示词 / 结果回写测试。
//
// 前置：先构建纯逻辑层
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
import assert from 'node:assert/strict';
import test from 'node:test';

import { applyAiResult, buildAiPayload, buildAiPrompt } from '../.build/model/aiPayload.js';

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

// ---------------------------------------------------------------- buildAiPayload

test('buildAiPayload：只取当天且 ai_processed=false 的记录', () => {
  const records = [
    makeRecord({ id: 'today-open', ts: '2026-11-14T09:30:00+08:00' }),
    makeRecord({ id: 'today-done', ts: '2026-11-14T10:00:00+08:00', ai_processed: true }),
    makeRecord({ id: 'other-day', ts: '2026-11-13T23:59:00+08:00' }),
    makeRecord({ id: 'today-late', ts: '2026-11-14T23:59:00+08:00', ai_processed: false })
  ];
  const payload = buildAiPayload('2026-11-14', records);
  assert.equal(payload.date, '2026-11-14');
  assert.deepEqual(
    payload.records.map((item) => item.id),
    ['today-open', 'today-late']
  );
});

test('buildAiPayload：text 优先正文，正文为空时退回 ocr_text；ocr_time 缺省用 ts', () => {
  const payload = buildAiPayload('2026-11-14', [
    makeRecord({ id: 'with-body', body: '最终正文', ocr_text: '原始 OCR' }),
    makeRecord({ id: 'ocr-only', body: '   ', ocr_text: '只有 OCR 原文' }),
    makeRecord({ id: 'with-time', ocr_time: '2026-11-14T09:31:12+08:00' })
  ]);
  assert.equal(payload.records[0].text, '最终正文');
  assert.equal(payload.records[1].text, '只有 OCR 原文');
  assert.equal(payload.records[2].ocr_time, '2026-11-14T09:31:12+08:00');
  assert.equal(payload.records[2].text, '讨论排期');
  assert.equal(payload.records[0].ocr_time, '2026-11-14T09:30:00+08:00');
});

test('buildAiPayload：日期非法抛错；无记录返回空数组', () => {
  assert.throws(() => buildAiPayload('2026/11/14', []), /YYYY-MM-DD/);
  assert.deepEqual(buildAiPayload('2026-11-14', []), { date: '2026-11-14', records: [] });
  assert.deepEqual(buildAiPayload('2026-11-14', [makeRecord({ ai_processed: true })]).records, []);
});

// ---------------------------------------------------------------- buildAiPrompt

test('buildAiPrompt：必须注入当前时间与时区，并带上每条记录', () => {
  const payload = buildAiPayload('2026-11-14', [
    makeRecord({ id: 'rec-a' }),
    makeRecord({ id: 'rec-b', title: '买菜' })
  ]);
  const prompt = buildAiPrompt(payload, '2026-11-14T22:30:00+08:00', 'Asia/Shanghai');
  assert.equal(prompt.includes('2026-11-14T22:30:00+08:00'), true, '必须注入当前时间');
  assert.equal(prompt.includes('Asia/Shanghai'), true, '必须注入时区');
  assert.equal(prompt.includes('2026-11-14'), true, '必须带上记录日期');
  assert.equal(prompt.includes('记录条数：2'), true);
  assert.equal(prompt.includes('rec-a'), true);
  assert.equal(prompt.includes('rec-b'), true);
  assert.equal(prompt.includes('当前时间：'), true);
  assert.equal(prompt.includes('时区：'), true);
});

test('buildAiPrompt：无记录时给出明确提示而不是空白', () => {
  const prompt = buildAiPrompt({ date: '2026-11-14', records: [] }, '2026-11-14T08:00:00+08:00', 'UTC');
  assert.equal(prompt.includes('没有需要整理的记录'), true);
  assert.equal(prompt.includes('2026-11-14T08:00:00+08:00'), true);
  assert.equal(prompt.includes('UTC'), true);
});

// ---------------------------------------------------------------- applyAiResult

test('applyAiResult：只写 ai_structured + ai_processed，绝不改 ocr_text', () => {
  const records = [
    makeRecord({ id: 'r1', ocr_text: '手写原文一', ai_processed: false }),
    makeRecord({ id: 'r2', ocr_text: '手写原文二', ai_processed: false }),
    makeRecord({ id: 'r3', ocr_text: '手写原文三', ai_processed: true })
  ];
  const before = JSON.parse(JSON.stringify(records));
  const result = applyAiResult(records, { r1: '- 结构化结果' }, ['r1', 'r2']);

  assert.equal(result[0].ai_structured, '- 结构化结果');
  assert.equal(result[0].ai_processed, true);
  assert.equal(result[0].ocr_text, '手写原文一', 'ocr_text 必须保持不变');

  assert.equal(result[1].ai_structured, undefined);
  assert.equal(result[1].ai_processed, true);
  assert.equal(result[1].ocr_text, '手写原文二');

  assert.deepEqual(result[2], before[2], '未命中的记录必须原样保留');

  assert.deepEqual(JSON.parse(JSON.stringify(records)), before, '入参记录不得被修改');
  assert.notEqual(result, records);
  assert.notEqual(result[0], records[0]);
});

test('applyAiResult：有结构化结果即视为已处理；只给 processedIds 时不写 ai_structured', () => {
  const records = [makeRecord({ id: 'only-structured' }), makeRecord({ id: 'only-processed' })];
  const result = applyAiResult(records, { 'only-structured': 'X' }, ['only-processed']);
  assert.equal(result[0].ai_structured, 'X');
  assert.equal(result[0].ai_processed, true);
  assert.equal(result[1].ai_processed, true);
  assert.equal('ai_structured' in result[1], false);
});

test('applyAiResult：不继承原型链上的 id（防原型污染）', () => {
  const records = [makeRecord({ id: 'inherited' })];
  const structured = Object.create({ inherited: '原型上的值' });
  const result = applyAiResult(records, structured, []);
  assert.equal(result[0].ai_structured, undefined);
  assert.equal(result[0].ai_processed, false);
});
