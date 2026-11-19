// B4（评审 P2-1）回归断言：`containsRecordVersion` 的判据从「精确 ts 相等」放宽为
// 「同 id 且 ts 不早于标记 ts」。放宽只发生在该纯函数内部；`Index.ets` 的
// `reconcileSavedRow()` 与 `b3Batch.test.mjs` 一字未改。
//
// 前置：先构建纯逻辑层
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

// homeRefresh.ts 零 SDK import，编译产物可直接 import（无运行时相对依赖）。
const { containsRecordVersion } = await import('../.build/model/homeRefresh.js');

/** 只构造判定真正读取的两个字段（id / ts），其余字段与本判定无关。 */
function rec(id, ts) {
  return { id, ts };
}

const ID = 'r1';
const ISO = '2026-11-19T09:00:00+08:00';
const ISO_LATER = '2026-11-19T10:00:00+08:00';
const ISO_EARLIER = '2026-11-19T08:00:00+08:00';

describe('B4 containsRecordVersion：同 id 且 ts 不早于标记才命中', () => {
  test('B4-01 精确相同的 ts → true', () => {
    assert.equal(containsRecordVersion([rec(ID, ISO)], ID, ISO), true, '同 id 同 ts → true');
  });

  test('B4-02 更晚的 ts（可解析 ISO，带时区偏移）→ true', () => {
    assert.equal(containsRecordVersion([rec(ID, ISO_LATER)], ID, ISO), true, '同 id 更晚 ts → true');
  });

  test('B4-03 更早的 ts → false（列表是旧版，必须走兜底 reconcile）', () => {
    assert.equal(containsRecordVersion([rec(ID, ISO_EARLIER)], ID, ISO), false, '同 id 更早 ts → false');
  });

  test('B4-04 跨偏移按时刻比较：10:00+08 的记录 vs 03:00+08 的标记 → true', () => {
    const recordTs = '2026-11-19T10:00:00+08:00';
    const markerTs = '2026-11-19T03:00:00+08:00';
    assert.equal(containsRecordVersion([rec(ID, recordTs)], ID, markerTs), true, '记录时刻更晚 → true');
  });

  test('B4-05 跨偏移反向：03:00+08 的记录 vs 10:00+08 的标记 → false', () => {
    const recordTs = '2026-11-19T03:00:00+08:00';
    const markerTs = '2026-11-19T10:00:00+08:00';
    assert.equal(containsRecordVersion([rec(ID, recordTs)], ID, markerTs), false, '记录时刻更早 → false');
  });

  test('B4-06 占位串不可解析：同串 t1 vs t1 → true（精确相等兜底）', () => {
    assert.equal(containsRecordVersion([rec(ID, 't1')], ID, 't1'), true, "占位串相等 → true");
  });

  test('B4-07 占位串不可解析：t2 vs t1 → false', () => {
    assert.equal(containsRecordVersion([rec(ID, 't2')], ID, 't1'), false, '占位串不等 → false');
  });

  test('B4-08 占位串不可解析：t1 vs t2 → false（不可按字典序放宽）', () => {
    assert.equal(containsRecordVersion([rec(ID, 't1')], ID, 't2'), false, '标记更晚的占位串也不得命中 → false');
  });

  test('B4-09 混合可解析性：记录 ISO / 标记 t1 → false（兜底仅精确相等）', () => {
    assert.equal(containsRecordVersion([rec(ID, ISO)], ID, 't1'), false, 'ISO ≠ 占位串 → false');
  });

  test('B4-10 混合可解析性：记录 t1 / 标记 ISO → false（兜底仅精确相等）', () => {
    assert.equal(containsRecordVersion([rec(ID, 't1')], ID, ISO), false, '占位串 ≠ ISO → false');
  });

  test('B4-11 同 id 才算：不同 id 即便 ts 更晚也 → false', () => {
    assert.equal(containsRecordVersion([rec('other', ISO_LATER)], ID, ISO), false, '不同 id → false');
  });

  test('B4-12 空数组 / null / undefined → false', () => {
    assert.equal(containsRecordVersion([], ID, ISO), false, '空数组 → false');
    assert.equal(containsRecordVersion(null, ID, ISO), false, 'null → false');
    assert.equal(containsRecordVersion(undefined, ID, ISO), false, 'undefined → false');
  });

  test('B4-13 数组含 null/undefined 坏项不抛，且仍能命中后面的好记录', () => {
    assert.doesNotThrow(
      () => assert.equal(containsRecordVersion([null, undefined, rec(ID, ISO_LATER)], ID, ISO), true),
      '跳过坏项后应命中更晚的好记录，且全程不抛'
    );
  });

  test('B4-14 序数声明：记录 ts 日期部分差一天但更晚，仍命中', () => {
    // docstring 的核心论据：ts 是版本序，日期分片不同不妨碍「更晚即最新」。
    const recordTs = '2026-11-20T10:00:00+08:00';
    const markerTs = '2026-11-19T09:00:00+08:00';
    assert.equal(containsRecordVersion([rec(ID, recordTs)], ID, markerTs), true, '跨天但更晚 → true');
  });
});
