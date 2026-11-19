// D5 核心：改日期时的 ts 决策（recordDateMove）纯逻辑层测试。
//
// 前置：先构建纯逻辑层
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
//
// 覆盖：tsForDate 与 nowIso 同形 / 非法日期拒绝 / 闰日；planDateMove 的新建、同日、往后、
//       往早、坏输入、fail-closed 顺序与确定性。全部断言为严格断言。
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

// 编译产物里的 `import ... from '../common/date'` / `'./jsonl'` 不带 `.js`（ArkTS 要求），
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

const { localDateKey, nextTsSameDate, nowIso } = await import('../.build/common/date.js');
const { recordDateKey } = await import('../.build/model/jsonl.js');
const { tsForDate, planDateMove } = await import('../.build/model/recordDateMove.js');

function localDate(y, m, d, hh = 0, mm = 0, ss = 0, ms = 0) {
  return new Date(y, m - 1, d, hh, mm, ss, ms);
}

test('tsForDate: 目标日等于今天时与 nowIso 字节相同（硬不变式）', () => {
  const now = localDate(2026, 11, 19, 19, 32, 44, 123);
  assert.equal(tsForDate(localDateKey(now), now), nowIso(now));
});

test('tsForDate: 过去日期保留 now 的时钟', () => {
  const now = localDate(2026, 11, 19, 9, 5, 3, 456);
  assert.equal(tsForDate('2020-01-02', now), `2020-01-02${nowIso(now).slice(10)}`);
});

test('tsForDate: 未来日期保留 now 的时钟', () => {
  const now = localDate(2026, 11, 19, 22, 15, 20, 789);
  assert.equal(tsForDate('2030-06-07', now), `2030-06-07${nowIso(now).slice(10)}`);
});

test('tsForDate: 输出形如 YYYY-MM-DDTHH:MM:SS±HH:MM（无毫秒）', () => {
  const now = localDate(2026, 11, 19, 7, 8, 9, 999);
  assert.match(tsForDate('2026-12-01', now), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
});

test('tsForDate: 保留 nowIso(now) 的本地偏移子串', () => {
  const now = localDate(2026, 11, 19, 13, 45, 0);
  const offset = nowIso(now).slice(-6);
  assert.equal(tsForDate('2026-10-01', now).slice(-6), offset);
  assert.equal(offset, nowIso(now).slice(-6));
});

test('tsForDate: 非法日期一律返回空串', () => {
  const now = localDate(2026, 11, 19, 10, 0, 0);
  for (const bad of ['', '2026-1-1', '20261110', '2026-02-30', '2026-13-01', '2026-00-10', '0000-01-01']) {
    assert.equal(tsForDate(bad, now), '', `非法输入应返回空串：${bad}`);
  }
});

test('tsForDate: 闰日 2028-02-29 被接受，平年 2026-02-29 被拒绝', () => {
  const now = localDate(2026, 11, 19, 10, 0, 0);
  const leap = tsForDate('2028-02-29', now);
  assert.equal(leap.slice(0, 10), '2028-02-29');
  assert.notEqual(leap, '');
  assert.equal(tsForDate('2026-02-29', now), '');
});

test('planDateMove: 新记录（originalTs 为空）→ same / 无墓碑 / 分片落在目标日', () => {
  const now = localDate(2026, 11, 19, 19, 0, 0);
  const target = '2026-11-20';
  const plan = planDateMove('', target, now);
  assert.equal(plan.ok, true);
  assert.equal(plan.kind, 'same');
  assert.equal(plan.date, target);
  assert.equal(plan.ts, tsForDate(target, now));
  assert.equal(recordDateKey(plan.ts), target);
  assert.equal(plan.tombstoneTs, '');
  assert.equal(plan.needsTombstone, false);
  assert.equal(plan.reason, '');
});

test('planDateMove: 纯空白 originalTs 也按新记录处理', () => {
  const now = localDate(2026, 11, 19, 19, 0, 0);
  const target = '2026-11-20';
  const plan = planDateMove('   ', target, now);
  assert.equal(plan.ok, true);
  assert.equal(plan.kind, 'same');
  assert.equal(plan.date, target);
  assert.equal(plan.ts, tsForDate(target, now));
  assert.equal(plan.tombstoneTs, '');
  assert.equal(plan.needsTombstone, false);
});

test('planDateMove: 同日期 → ts 精确等于 nextTsSameDate，无墓碑', () => {
  const original = '2026-11-10T09:30:00+08:00';
  const now = localDate(2026, 11, 19, 22, 15, 0);
  const plan = planDateMove(original, '2026-11-10', now);
  assert.equal(plan.ok, true);
  assert.equal(plan.kind, 'same');
  assert.equal(plan.date, '2026-11-10');
  assert.equal(plan.ts, nextTsSameDate(original, now));
  assert.equal(recordDateKey(plan.ts), '2026-11-10');
  assert.equal(plan.tombstoneTs, '');
  assert.equal(plan.needsTombstone, false);
});

test('planDateMove: 往后一天 → later / 需墓碑 / 严格 ts 顺序且分片正确', () => {
  const original = '2026-11-18T09:00:00+08:00';
  const now = localDate(2026, 11, 19, 12, 0, 0);
  const plan = planDateMove(original, '2026-11-19', now);
  assert.equal(plan.ok, true);
  assert.equal(plan.kind, 'later');
  assert.equal(plan.date, '2026-11-19');
  assert.equal(recordDateKey(plan.ts), '2026-11-19');
  assert.equal(recordDateKey(plan.tombstoneTs), '2026-11-18');
  assert.equal(plan.needsTombstone, true);
  assert.equal(plan.reason, '');
  assert.ok(Date.parse(original) < Date.parse(plan.tombstoneTs));
  assert.ok(Date.parse(plan.tombstoneTs) < Date.parse(plan.ts));
});

test('planDateMove: 跨月 2026-01-31 → 2026-02-01 仍严格有序', () => {
  const original = '2026-01-31T09:00:00+08:00';
  const now = localDate(2026, 1, 31, 12, 0, 0);
  const plan = planDateMove(original, '2026-02-01', now);
  assert.equal(plan.ok, true);
  assert.equal(plan.kind, 'later');
  assert.equal(recordDateKey(plan.ts), '2026-02-01');
  assert.equal(recordDateKey(plan.tombstoneTs), '2026-01-31');
  assert.ok(Date.parse(original) < Date.parse(plan.tombstoneTs));
  assert.ok(Date.parse(plan.tombstoneTs) < Date.parse(plan.ts));
});

test('planDateMove: 跨年 2026-12-31 → 2027-01-01 仍严格有序', () => {
  const original = '2026-12-31T09:00:00+08:00';
  const now = localDate(2026, 12, 31, 12, 0, 0);
  const plan = planDateMove(original, '2027-01-01', now);
  assert.equal(plan.ok, true);
  assert.equal(plan.kind, 'later');
  assert.equal(recordDateKey(plan.ts), '2027-01-01');
  assert.equal(recordDateKey(plan.tombstoneTs), '2026-12-31');
  assert.ok(Date.parse(original) < Date.parse(plan.tombstoneTs));
  assert.ok(Date.parse(plan.tombstoneTs) < Date.parse(plan.ts));
});

test('planDateMove: 往更早的日期 → 拒绝且给出可展示原因', () => {
  const now = localDate(2026, 11, 19, 12, 0, 0);
  const plan = planDateMove('2026-11-18T09:00:00+08:00', '2026-11-17', now);
  assert.equal(plan.ok, false);
  assert.equal(plan.kind, 'earlier');
  assert.equal(plan.date, '2026-11-17');
  assert.equal(plan.ts, '');
  assert.equal(plan.tombstoneTs, '');
  assert.equal(plan.needsTombstone, false);
  assert.ok(plan.reason.length > 0);
  assert.match(plan.reason, /更早/);
});

test('planDateMove: 原 ts 无法解析 → invalid', () => {
  const now = localDate(2026, 11, 19, 12, 0, 0);
  const plan = planDateMove('not-a-timestamp', '2026-11-20', now);
  assert.equal(plan.ok, false);
  assert.equal(plan.kind, 'invalid');
  assert.equal(plan.date, '2026-11-20');
  assert.equal(plan.ts, '');
  assert.equal(plan.tombstoneTs, '');
  assert.equal(plan.needsTombstone, false);
  assert.match(plan.reason, /无法解析/);
});

test('planDateMove: 目标日期非法 → invalid，date 为空串并带原因', () => {
  const now = localDate(2026, 11, 19, 12, 0, 0);
  for (const bad of ['', '2026-1-1', '2026-02-30', '0000-01-01']) {
    const plan = planDateMove('2026-11-10T09:00:00+08:00', bad, now);
    assert.equal(plan.ok, false, `非法目标日应拒绝：${bad}`);
    assert.equal(plan.kind, 'invalid');
    assert.equal(plan.date, '');
    assert.equal(plan.ts, '');
    assert.equal(plan.tombstoneTs, '');
    assert.equal(plan.needsTombstone, false);
    assert.match(plan.reason, /日期不合法/);
  }
});

test('planDateMove: 原记录 23:59:59.999 往后改仍严格有序（墓碑钳到当天上限）', () => {
  const original = '2026-11-09T23:59:59.999+08:00';
  const now = localDate(2026, 11, 19, 8, 0, 0);
  const plan = planDateMove(original, '2026-11-10', now);
  assert.equal(plan.ok, true);
  assert.equal(plan.kind, 'later');
  assert.equal(recordDateKey(plan.ts), '2026-11-10');
  assert.equal(recordDateKey(plan.tombstoneTs), '2026-11-09');
  assert.ok(Date.parse(original) < Date.parse(plan.ts));
  assert.ok(Date.parse(plan.tombstoneTs) < Date.parse(plan.ts));
});

test('planDateMove: 原记录 00:00:00 同日改保持原日期且严格更晚', () => {
  const original = '2026-11-10T00:00:00+08:00';
  const now = localDate(2026, 11, 19, 7, 0, 0);
  const plan = planDateMove(original, '2026-11-10', now);
  assert.equal(plan.ok, true);
  assert.equal(plan.kind, 'same');
  assert.equal(plan.date, '2026-11-10');
  assert.equal(recordDateKey(plan.ts), '2026-11-10');
  assert.ok(Date.parse(original) < Date.parse(plan.ts));
  assert.equal(plan.tombstoneTs, '');
});

test('planDateMove: 两次相同调用深相等，传入的 Date 对象不被修改', () => {
  const now = localDate(2026, 11, 19, 19, 32, 44, 500);
  const before = now.getTime();
  const first = planDateMove('2026-11-10T09:00:00+08:00', '2026-11-20', now);
  const second = planDateMove('2026-11-10T09:00:00+08:00', '2026-11-20', now);
  assert.deepEqual(first, second);
  assert.equal(now.getTime(), before);
  assert.equal(tsForDate('2026-11-20', now), first.ts);
  assert.equal(now.getTime(), before);
});
