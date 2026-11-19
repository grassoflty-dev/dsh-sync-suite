// 首页快捷记录（model/quickRecord.ts）纯逻辑层测试。
//
// 前置：先构建纯逻辑层
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
//
// 契约：快捷记录不进编辑页、没有 originalTs，日期就是创建时的唯一选择；ts 直接走
//       recordSaveTs.ts 里唯一的日期落点 tsForDate，形状 / 分片键 / 版本序与编辑器同源。
//       覆盖：trim、空标题拒绝、非法日期拒绝、过去/今天/未来日期落片、闰日、确定性、
//       入参 Date 不变、模块源码不出现 Date.now()。全部为严格断言。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';

// 编译产物里的 `import { tsForDate } from './recordSaveTs'` 不带 .js（ArkTS 要求），
// Node 的 ESM 不做扩展名推断，这里只为测试进程补后缀解析。
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

const { nowIso } = await import('../.build/common/date.js');
const { recordDateKey } = await import('../.build/model/jsonl.js');
const { planQuickRecord } = await import('../.build/model/quickRecord.js');

function localDate(y, m, d, hh = 0, mm = 0, ss = 0, ms = 0) {
  return new Date(y, m - 1, d, hh, mm, ss, ms);
}

// ---------------------------------------------------------------------------
// A. 标题
// ---------------------------------------------------------------------------

test('planQuickRecord: 首尾空白被 trim，成功计划的 title 是规整后的标题', () => {
  const now = localDate(2026, 11, 20, 9, 0, 0);
  const plan = planQuickRecord('  写周报  ', '2026-11-20', now);
  assert.equal(plan.ok, true);
  assert.equal(plan.title, '写周报');
  assert.equal(plan.reason, '');
  assert.equal(plan.ts.length > 0, true);
});

test('planQuickRecord: 空标题 → ok=false，ts/title 空串，中文原因固定', () => {
  const now = localDate(2026, 11, 20, 9, 0, 0);
  const plan = planQuickRecord('', '2026-11-20', now);
  assert.equal(plan.ok, false);
  assert.equal(plan.title, '');
  assert.equal(plan.ts, '');
  assert.equal(plan.reason, '请输入标题');
});

test('planQuickRecord: 纯空白标题（含制表/换行）同样被拒绝', () => {
  const now = localDate(2026, 11, 20, 9, 0, 0);
  for (const raw of [' ', '   ', '\t', '\n', '\t \n']) {
    const plan = planQuickRecord(raw, '2026-11-20', now);
    assert.equal(plan.ok, false, `空白标题应拒绝：${JSON.stringify(raw)}`);
    assert.equal(plan.ts, '');
    assert.equal(plan.reason, '请输入标题');
  }
});

test('planQuickRecord: 计划对象字段固定为 ok/title/ts/reason 四个', () => {
  const now = localDate(2026, 11, 20, 9, 0, 0);
  const ok = planQuickRecord('标题', '2026-11-20', now);
  const bad = planQuickRecord('', '2026-11-20', now);
  assert.deepEqual(Object.keys(ok).sort(), ['ok', 'reason', 'title', 'ts']);
  assert.deepEqual(Object.keys(bad).sort(), ['ok', 'reason', 'title', 'ts']);
});

// ---------------------------------------------------------------------------
// B. 日期拒绝
// ---------------------------------------------------------------------------

test('planQuickRecord: 空日期键被拒绝，中文原因固定', () => {
  const now = localDate(2026, 11, 20, 9, 0, 0);
  const plan = planQuickRecord('标题', '', now);
  assert.equal(plan.ok, false);
  assert.equal(plan.ts, '');
  assert.equal(plan.reason, '日期不合法：请重新选择日期');
});

test('planQuickRecord: 不存在的日历日 2026-02-30 被拒绝', () => {
  const now = localDate(2026, 11, 20, 9, 0, 0);
  const plan = planQuickRecord('标题', '2026-02-30', now);
  assert.equal(plan.ok, false);
  assert.equal(plan.ts, '');
  assert.equal(plan.reason, '日期不合法：请重新选择日期');
});

test('planQuickRecord: 非 YYYY-MM-DD 的 2026-1-1 被拒绝', () => {
  const now = localDate(2026, 11, 20, 9, 0, 0);
  const plan = planQuickRecord('标题', '2026-1-1', now);
  assert.equal(plan.ok, false);
  assert.equal(plan.ts, '');
  assert.equal(plan.reason, '日期不合法：请重新选择日期');
});

test('planQuickRecord: 其他坏日期（月 13 / 日 00 / 非字符串）也被拒绝且不抛错', () => {
  const now = localDate(2026, 11, 20, 9, 0, 0);
  for (const bad of ['2026-13-01', '2026-00-10', '0000-01-01', '20261120', 'not-a-date']) {
    const plan = planQuickRecord('标题', bad, now);
    assert.equal(plan.ok, false, `坏日期应拒绝：${bad}`);
    assert.equal(plan.ts, '');
    assert.match(plan.reason, /日期不合法/);
  }
});

test('planQuickRecord: 闰日 2028-02-29 接受，平年 2026-02-29 拒绝', () => {
  const now = localDate(2026, 11, 20, 9, 0, 0);
  const leap = planQuickRecord('标题', '2028-02-29', now);
  assert.equal(leap.ok, true);
  assert.equal(recordDateKey(leap.ts), '2028-02-29');
  assert.equal(planQuickRecord('标题', '2026-02-29', now).ok, false);
});

// ---------------------------------------------------------------------------
// C. ts 落片（与编辑器同源）
// ---------------------------------------------------------------------------

test('planQuickRecord: 过去日期 → ts 落在那一天（分片键 = dateKey）', () => {
  const now = localDate(2026, 11, 20, 19, 32, 44, 123);
  const plan = planQuickRecord('补记', '2020-01-02', now);
  assert.equal(plan.ok, true);
  assert.equal(plan.ts.slice(0, 10), '2020-01-02');
  assert.equal(recordDateKey(plan.ts), '2020-01-02');
  assert.equal(plan.ts.slice(10), nowIso(now).slice(10));
});

test('planQuickRecord: 今天 → ts 与 nowIso(now) 逐字节相同', () => {
  const now = localDate(2026, 11, 20, 19, 32, 44, 123);
  const plan = planQuickRecord('今天的', '2026-11-20', now);
  assert.equal(plan.ok, true);
  assert.equal(plan.ts, nowIso(now));
  assert.equal(recordDateKey(plan.ts), '2026-11-20');
});

test('planQuickRecord: 未来日期 → ts 落在那一天且保留 now 的时钟', () => {
  const now = localDate(2026, 11, 20, 7, 8, 9, 456);
  const plan = planQuickRecord('未来的', '2030-06-07', now);
  assert.equal(plan.ok, true);
  assert.equal(recordDateKey(plan.ts), '2030-06-07');
  assert.equal(plan.ts.slice(10), nowIso(now).slice(10));
  assert.match(plan.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
});

// ---------------------------------------------------------------------------
// D. 纯度
// ---------------------------------------------------------------------------

test('planQuickRecord: 同输入两次深相等（确定性）', () => {
  const now = localDate(2026, 11, 20, 19, 32, 44, 500);
  const first = planQuickRecord('  同一条  ', '2026-11-20', now);
  const second = planQuickRecord('  同一条  ', '2026-11-20', now);
  assert.deepEqual(first, second);
  assert.equal(first.ts, nowIso(now));
});

test('planQuickRecord: 传入的 Date 不被修改', () => {
  const now = localDate(2026, 11, 20, 19, 32, 44, 500);
  const before = now.getTime();
  planQuickRecord('标题', '2026-11-20', now);
  assert.equal(now.getTime(), before);
  planQuickRecord('标题', 'bad-date', now);
  assert.equal(now.getTime(), before);
});

test('planQuickRecord: 运行时脏入参（非字符串标题）不抛错', () => {
  const now = localDate(2026, 11, 20, 9, 0, 0);
  for (const bad of [null, undefined, 42]) {
    assert.doesNotThrow(() => planQuickRecord(bad, '2026-11-20', now));
    assert.equal(planQuickRecord(bad, '2026-11-20', now).ok, false);
  }
});

test('quickRecord.ts 源码不出现 Date.now()（时钟只能由入参注入）', () => {
  const source = readFileSync(new URL('../../entry/src/main/ets/model/quickRecord.ts', import.meta.url), 'utf8');
  assert.equal(source.includes('Date.now()'), false, '纯逻辑模块不得自己读时钟');
  assert.match(source, /import \{ tsForDate \} from '\.\/recordSaveTs';/, '必须复用唯一的日期落点 tsForDate');
});
