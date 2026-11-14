// AI 载荷 / 提示词 / 结果回写 与 提醒计划 测试。
//
// 说明：`model/reminder.ts` 同样属于纯逻辑模型层，本文件一并覆盖（保持 tools/test 文件
// 集合与契约 §3.5 一致）。
//
// 前置：先构建纯逻辑层
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
import assert from 'node:assert/strict';
import test from 'node:test';

import { applyAiResult, buildAiPayload, buildAiPrompt } from '../.build/model/aiPayload.js';
import { MAX_REMINDER_COUNT, buildReminderPlan } from '../.build/model/reminder.js';

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

// ---------------------------------------------------------------- buildReminderPlan

test('buildReminderPlan：只取未来且未完成的记录，按时间升序', () => {
  const now = '2026-11-14T12:00:00+08:00';
  const records = [
    makeRecord({ id: 'past', ts: '2026-11-14T09:00:00+08:00', done: false }),
    makeRecord({ id: 'later', ts: '2026-11-14T18:00:00+08:00', done: false }),
    makeRecord({ id: 'soon', ts: '2026-11-14T13:00:00+08:00', done: false }),
    makeRecord({ id: 'done', ts: '2026-11-14T20:00:00+08:00', done: true }),
    makeRecord({ id: 'now', ts: '2026-11-14T12:00:00+08:00', done: false })
  ];
  const plan = buildReminderPlan(records, now);
  assert.deepEqual(
    plan.map((item) => item.id),
    ['soon', 'later']
  );
  assert.equal(plan[0].dateTime, '2026-11-14T13:00:00+08:00');
  assert.equal(plan[0].title, '周会');
});

test('buildReminderPlan：默认与硬上限都是 30 条', () => {
  assert.equal(MAX_REMINDER_COUNT, 30);
  const now = '2026-11-14T00:00:00+08:00';
  const records = [];
  for (let i = 0; i < 50; i++) {
    records.push(makeRecord({ id: `r-${i}`, ts: `2026-11-14T${String(1 + (i % 22)).padStart(2, '0')}:00:00+08:00` }));
  }
  assert.equal(buildReminderPlan(records, now).length, 30);
  assert.equal(buildReminderPlan(records, now, 5).length, 5);
  assert.equal(buildReminderPlan(records, now, 100).length, 30, '超过 30 的请求必须被截断');
  assert.equal(buildReminderPlan(records, now, 0).length, 0);
});

test('buildReminderPlan：同 id 只提醒一次；非法 nowIso 抛错；无标题给默认名', () => {
  const now = '2026-11-14T12:00:00+08:00';
  const records = [
    makeRecord({ id: 'dup', ts: '2026-11-14T15:00:00+08:00' }),
    makeRecord({ id: 'dup', ts: '2026-11-14T16:00:00+08:00' }),
    makeRecord({ id: 'blank', title: '  ', ts: '2026-11-14T17:00:00+08:00' })
  ];
  const plan = buildReminderPlan(records, now);
  assert.deepEqual(
    plan.map((item) => item.id),
    ['dup', 'blank']
  );
  assert.equal(plan[1].title, '(未命名日程)');
  assert.throws(() => buildReminderPlan(records, 'not-a-date'), /nowIso/);
  assert.deepEqual(buildReminderPlan([makeRecord({ ts: '不是时间' })], now), []);
});
