// 核心：保存时的 ts 决策（recordSaveTs）纯逻辑层测试。
//
// 前置：先构建纯逻辑层
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
//
// 收窄后的契约：新建时所选日期决定日片；已有记录永不改日期，只按原 ts 同日升级。
// 覆盖：tsForDate 与 nowIso 同形 / 非法日期拒绝 / 闰日；resolveSaveTs 的新建、同日、
//       选择日期被忽略（更早与更晚两向）、坏输入、确定性与入参不变。全部为严格断言。
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
const { tsForDate, resolveSaveTs } = await import('../.build/model/recordSaveTs.js');

function localDate(y, m, d, hh = 0, mm = 0, ss = 0, ms = 0) {
  return new Date(y, m - 1, d, hh, mm, ss, ms);
}

// ---------------------------------------------------------------------------
// A. tsForDate（唯一的日期前缀落点）
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// B. resolveSaveTs（新建选日 / 已有记录同日升级）
// ---------------------------------------------------------------------------

test('resolveSaveTs: 新记录 + 有效日期 → ts 落在该日片且原因为空', () => {
  const now = localDate(2026, 11, 19, 19, 0, 0);
  const chosen = '2026-11-20';
  const plan = resolveSaveTs('', chosen, now);
  assert.equal(plan.ok, true);
  assert.equal(plan.ts, tsForDate(chosen, now));
  assert.equal(plan.ts.slice(0, 10), chosen);
  assert.equal(recordDateKey(plan.ts), chosen);
  assert.equal(plan.reason, '');
  assert.deepEqual(Object.keys(plan).sort(), ['ok', 'reason', 'ts']);
});

test('resolveSaveTs: 纯空白 originalTs 也按新记录处理', () => {
  const now = localDate(2026, 11, 19, 19, 0, 0);
  const plan = resolveSaveTs('   ', '2026-11-20', now);
  assert.equal(plan.ok, true);
  assert.equal(plan.ts, tsForDate('2026-11-20', now));
  assert.equal(recordDateKey(plan.ts), '2026-11-20');
});

test('resolveSaveTs: 新记录 + 非法日期 → ok=false，ts 空串，中文原因固定', () => {
  const now = localDate(2026, 11, 19, 12, 0, 0);
  for (const bad of ['', '2026-1-1', '20261110', '2026-02-30', '2026-13-01']) {
    const plan = resolveSaveTs('', bad, now);
    assert.equal(plan.ok, false, `非法日期应拒绝：${bad}`);
    assert.equal(plan.ts, '');
    assert.equal(plan.reason, '日期不合法：请为新建记录选择有效日期（YYYY-MM-DD）');
  }
});

test('resolveSaveTs: 空白 originalTs 配非法日期仍按新记录拒绝', () => {
  const now = localDate(2026, 11, 19, 12, 0, 0);
  const plan = resolveSaveTs('   ', '2026-02-30', now);
  assert.equal(plan.ok, false);
  assert.equal(plan.ts, '');
  assert.match(plan.reason, /日期不合法/);
});

test('resolveSaveTs: 已有记录同日 → 精确等于 nextTsSameDate，日期不变且更晚', () => {
  const original = '2026-11-10T09:30:00+08:00';
  const now = localDate(2026, 11, 19, 22, 15, 0);
  const plan = resolveSaveTs(original, '2026-11-10', now);
  assert.equal(plan.ok, true);
  assert.equal(plan.ts, nextTsSameDate(original, now));
  assert.equal(recordDateKey(plan.ts), '2026-11-10');
  assert.ok(Date.parse(plan.ts) > Date.parse(original));
  assert.equal(plan.reason, '');
});

test('resolveSaveTs: 已有记录 + 更早 chosenDate → ts 日期仍为原日（收窄契约）', () => {
  const original = '2026-11-18T09:00:00+08:00';
  const now = localDate(2026, 11, 19, 12, 0, 0);
  const plan = resolveSaveTs(original, '2026-11-17', now);
  assert.equal(plan.ok, true);
  assert.equal(plan.ts.slice(0, 10), '2026-11-18', '更早日期不得把记录搬走');
  assert.equal(recordDateKey(plan.ts), '2026-11-18');
  assert.equal(plan.ts, nextTsSameDate(original, now));
});

test('resolveSaveTs: 已有记录 + 更晚 chosenDate → ts 日期仍为原日（收窄契约）', () => {
  const original = '2026-11-18T09:00:00+08:00';
  const now = localDate(2026, 11, 19, 12, 0, 0);
  const plan = resolveSaveTs(original, '2026-11-25', now);
  assert.equal(plan.ok, true);
  assert.equal(plan.ts.slice(0, 10), '2026-11-18', '更晚日期也不得把记录搬走');
  assert.equal(recordDateKey(plan.ts), '2026-11-18');
  assert.equal(plan.ts, nextTsSameDate(original, now));
});

test('resolveSaveTs: 已有记录的非法 chosenDate 被忽略，只做同日升级', () => {
  const original = '2026-11-18T09:00:00+08:00';
  const now = localDate(2026, 11, 19, 12, 0, 0);
  const plan = resolveSaveTs(original, 'not-a-date', now);
  assert.equal(plan.ok, true);
  assert.equal(plan.ts, nextTsSameDate(original, now));
  assert.equal(plan.reason, '');
});

test('resolveSaveTs: 原 ts 无法解析 → ok=false，ts 空串，中文原因固定', () => {
  const now = localDate(2026, 11, 19, 12, 0, 0);
  for (const bad of ['not-a-timestamp', '2026-13-40T99:99:99+08:00']) {
    const plan = resolveSaveTs(bad, '2026-11-20', now);
    assert.equal(plan.ok, false, `不可解析原 ts 应拒绝：${bad}`);
    assert.equal(plan.ts, '');
    assert.equal(plan.reason, '原记录时间戳无法解析，无法安全保存：请返回列表重试');
  }
});

test('resolveSaveTs: 运行时脏入参不抛错（原 ts 非字符串 / now 非法）', () => {
  const now = localDate(2026, 11, 19, 12, 0, 0);
  for (const bad of [null, undefined, 42]) {
    assert.doesNotThrow(() => resolveSaveTs(bad, '2026-11-20', now));
  }
  const dirtyNow = new Date(Number.NaN);
  assert.doesNotThrow(() => resolveSaveTs('', '2026-11-20', dirtyNow));
  assert.equal(resolveSaveTs('', '2026-11-20', dirtyNow).ok, true);
});

test('resolveSaveTs: 同输入两次深相等，传入的 Date 不被修改', () => {
  const now = localDate(2026, 11, 19, 19, 32, 44, 500);
  const before = now.getTime();
  const first = resolveSaveTs('2026-11-10T09:00:00+08:00', '2026-11-20', now);
  const second = resolveSaveTs('2026-11-10T09:00:00+08:00', '2026-11-20', now);
  assert.deepEqual(first, second);
  assert.equal(now.getTime(), before);
  assert.equal(first.ts, nextTsSameDate('2026-11-10T09:00:00+08:00', now));
  assert.equal(now.getTime(), before);
});

test('resolveSaveTs: 原记录 23:59:59.999 同日升级钳到当天上限，日片不变', () => {
  const original = '2026-11-09T23:59:59.999+08:00';
  const now = localDate(2026, 11, 19, 8, 0, 0);
  const plan = resolveSaveTs(original, '2026-11-09', now);
  assert.equal(plan.ok, true);
  assert.equal(plan.ts, nextTsSameDate(original, now));
  assert.equal(recordDateKey(plan.ts), '2026-11-09');
  assert.ok(Date.parse(plan.ts) >= Date.parse(original));
});

test('resolveSaveTs: 跨月 / 跨年的原 ts 同日升级不换日片', () => {
  const now = localDate(2026, 11, 19, 12, 0, 0);
  for (const original of ['2026-01-31T09:00:00+08:00', '2026-12-31T09:00:00+08:00']) {
    const day = original.slice(0, 10);
    const plan = resolveSaveTs(original, '2026-11-19', now);
    assert.equal(plan.ok, true);
    assert.equal(recordDateKey(plan.ts), day, `原日片 ${day} 不得被选中日期覆盖`);
    assert.equal(plan.ts, nextTsSameDate(original, now));
  }
});
