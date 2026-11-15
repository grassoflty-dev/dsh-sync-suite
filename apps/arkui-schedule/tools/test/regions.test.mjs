// 区域框（`model/regions.ts`）测试：清洗/排序/占位符/归一化 → 像素矩形。
//
// 前置：先构建纯逻辑层
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
//
// 重点：用户拖出来的框是**不可信输入**（越界、零面积、NaN、重叠、反方向拖拽），
// 模型层必须夹紧或丢弃，而不是把脏数据塞给填白/OCR。
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

// regions.ts 只 `import type`，编译产物没有运行时 import，因此不需要 registerHooks。
const {
  MIN_REGION_SIDE,
  regionPlaceholder,
  regionsToMaskRects,
  regionsToPlaceholders,
  sanitizeRegion,
  sanitizeRegions,
  sortRegionsByY
} = await import('../.build/model/regions.js');

/** 合法框的简写。 */
function box(x, y, w = 0.3, h = 0.2) {
  return { x, y, w, h };
}

/** 断言矩形落在画布内且宽高至少 1。 */
function assertRectInside(rect, width, height) {
  assert.ok(Number.isInteger(rect.x) && Number.isInteger(rect.y), '像素坐标应为整数');
  assert.ok(Number.isInteger(rect.w) && Number.isInteger(rect.h), '像素宽高应为整数');
  assert.ok(rect.x >= 0 && rect.y >= 0, `不得为负：${JSON.stringify(rect)}`);
  assert.ok(rect.w >= 1 && rect.h >= 1, `宽高至少 1：${JSON.stringify(rect)}`);
  assert.ok(rect.x + rect.w <= width, `右边界越界：${JSON.stringify(rect)} / ${width}`);
  assert.ok(rect.y + rect.h <= height, `下边界越界：${JSON.stringify(rect)} / ${height}`);
}

describe('sanitizeRegion', () => {
  test('合法框原样保留；整页框 {0,0,1,1} 不变', () => {
    assert.deepEqual(sanitizeRegion(box(0.1, 0.2, 0.3, 0.4)), { x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
    assert.deepEqual(sanitizeRegion({ x: 0, y: 0, w: 1, h: 1 }), { x: 0, y: 0, w: 1, h: 1 });
  });

  test('越界部分被裁掉（左上/右下/四边全越界）', () => {
    assert.deepEqual(sanitizeRegion(box(-0.2, -0.2, 0.4, 0.4)), { x: 0, y: 0, w: 0.2, h: 0.2 });
    const right = sanitizeRegion(box(0.9, 0.5, 0.3, 0.4));
    assert.equal(right.x, 0.9);
    assert.equal(right.y, 0.5);
    assert.ok(Math.abs(right.w - 0.1) < 1e-9, `右侧应裁到 0.1，实际 ${right.w}`);
    assert.ok(Math.abs(right.h - 0.4) < 1e-9);
    assert.deepEqual(sanitizeRegion({ x: -1, y: -1, w: 3, h: 3 }), { x: 0, y: 0, w: 1, h: 1 });
  });

  test('零面积 / 小于 MIN_REGION_SIDE / 非有限数 → null', () => {
    assert.equal(MIN_REGION_SIDE, 0.02);
    assert.equal(sanitizeRegion({ x: 0.1, y: 0.1, w: 0, h: 0.2 }), null);
    assert.equal(sanitizeRegion({ x: 0.1, y: 0.1, w: 0.2, h: 0 }), null);
    assert.equal(sanitizeRegion({ x: 0.1, y: 0.1, w: 0.001, h: 0.2 }), null);
    assert.equal(sanitizeRegion({ x: 0.1, y: 0.1, w: 0.2, h: 0.019 }), null);
    for (const bad of [
      { x: Number.NaN, y: 0.1, w: 0.2, h: 0.2 },
      { x: 0.1, y: Number.POSITIVE_INFINITY, w: 0.2, h: 0.2 },
      { x: 0.1, y: 0.1, w: Number.NaN, h: 0.2 },
      { x: 0.1, y: 0.1, w: 0.2, h: Number.NEGATIVE_INFINITY }
    ]) {
      assert.equal(sanitizeRegion(bad), null, `应丢弃：${JSON.stringify(bad)}`);
    }
    // 裁掉越界后过小 → 也丢弃
    assert.equal(sanitizeRegion({ x: 0.995, y: 0.5, w: 0.01, h: 0.2 }), null);
  });

  test('反方向拖拽（负宽高）换算成正矩形', () => {
    // 从 (0.75,0.75) 拖到 (0.25,0.25)：w/h 为负
    assert.deepEqual(sanitizeRegion({ x: 0.75, y: 0.75, w: -0.5, h: -0.5 }), {
      x: 0.25,
      y: 0.25,
      w: 0.5,
      h: 0.5
    });
  });

  test('null / undefined / 非对象不抛异常，返回 null', () => {
    assert.equal(sanitizeRegion(null), null);
    assert.equal(sanitizeRegion(undefined), null);
    assert.equal(sanitizeRegion(42), null);
    assert.equal(sanitizeRegion('X'), null);
  });
});

describe('sanitizeRegions', () => {
  test('丢弃 null、保持输入顺序（不排序）', () => {
    const clean = sanitizeRegions([
      box(0.1, 0.7),
      { x: Number.NaN, y: 0, w: 0.2, h: 0.2 },
      box(0.2, 0.2),
      { x: 0, y: 0, w: 0, h: 0 }
    ]);
    assert.deepEqual(
      clean.map((item) => item.y),
      [0.7, 0.2],
      'sanitize 只清洗，不改变顺序'
    );
    assert.equal(clean.length, 2);
  });

  test('非数组输入返回空数组；全部非法 → 空数组', () => {
    assert.deepEqual(sanitizeRegions(undefined), []);
    assert.deepEqual(sanitizeRegions(null), []);
    assert.deepEqual(sanitizeRegions([{ x: 0, y: 0, w: 0, h: 0 }]), []);
  });
});

describe('sortRegionsByY', () => {
  test('按 y 升序；y 相同按 x 升序；完全同位置保持原序', () => {
    const a = box(0.5, 0.1, 0.3, 0.1);
    const b = box(0.1, 0.5, 0.2, 0.1);
    const c = box(0.7, 0.1, 0.1, 0.1);
    const d = box(0.2, 0.1, 0.25, 0.1); // 与 a、c 同 y，x 最小
    const sorted = sortRegionsByY([a, b, c, d]);
    assert.equal(sorted[0], d, 'y 相同按 x 升序：x=0.1 在前');
    assert.equal(sorted[1], a);
    assert.equal(sorted[2], c);
    assert.equal(sorted[3], b, 'y 最大的排最后');
  });

  test('不修改入参，返回新数组', () => {
    const input = [box(0.1, 0.8), box(0.1, 0.2)];
    const sorted = sortRegionsByY(input);
    assert.deepEqual(
      input.map((item) => item.y),
      [0.8, 0.2],
      '入参顺序不变'
    );
    assert.deepEqual(
      sorted.map((item) => item.y),
      [0.2, 0.8]
    );
    assert.notEqual(sorted, input);
  });

  test('非数组/空数组 → 空数组', () => {
    assert.deepEqual(sortRegionsByY(undefined), []);
    assert.deepEqual(sortRegionsByY([]), []);
  });
});

describe('regionPlaceholder / regionsToPlaceholders', () => {
  test('regionPlaceholder：页码与区域序号都从 1 起', () => {
    assert.equal(regionPlaceholder(0, 0), '[图表/公式: 查看手迹 · 第1页·区域1]');
    assert.equal(regionPlaceholder(0, 1), '[图表/公式: 查看手迹 · 第1页·区域2]');
    assert.equal(regionPlaceholder(2, 4), '[图表/公式: 查看手迹 · 第3页·区域5]');
    // 非法输入不产生 NaN/负数页码
    assert.equal(regionPlaceholder(-1, -1), '[图表/公式: 查看手迹 · 第1页·区域1]');
    assert.equal(regionPlaceholder(Number.NaN, Number.NaN), '[图表/公式: 查看手迹 · 第1页·区域1]');
  });

  test('regionsToPlaceholders：先按 y 排序再编号（区域 1 = y 最小的框）', () => {
    const boxes = [box(0.1, 0.8), box(0.1, 0.3), box(0.6, 0.1)];
    const placeholders = regionsToPlaceholders(0, boxes);
    assert.deepEqual(placeholders, [
      '[图表/公式: 查看手迹 · 第1页·区域1]',
      '[图表/公式: 查看手迹 · 第1页·区域2]',
      '[图表/公式: 查看手迹 · 第1页·区域3]'
    ]);
    // 排序后 y 递增：0.1（x=0.6）→ 0.3 → 0.8
    const sorted = sortRegionsByY(boxes);
    assert.deepEqual(
      sorted.map((item) => item.y),
      [0.1, 0.3, 0.8]
    );
    assert.deepEqual(
      sorted.map((item) => item.x),
      [0.6, 0.1, 0.1]
    );
  });

  test('regionsToPlaceholders：脏框被丢弃；空/缺省 → 空数组', () => {
    assert.equal(regionsToPlaceholders(1, [box(0.1, 0.1), { x: Number.NaN, y: 0, w: 0.2, h: 0.2 }]).length, 1);
    assert.deepEqual(regionsToPlaceholders(0, []), []);
    assert.deepEqual(regionsToPlaceholders(0, undefined), []);
  });
});

describe('regionsToMaskRects', () => {
  test('归一化 → 像素：向下取整、宽高至少 1', () => {
    assert.deepEqual(regionsToMaskRects([box(0.1, 0.2, 0.3, 0.4)], 100, 200), [
      { x: 10, y: 40, w: 30, h: 80 }
    ]);
    // 0.02 * 10 = 0.2 → floor 0 → 至少 1
    assert.deepEqual(regionsToMaskRects([box(0.5, 0.5, 0.02, 0.02)], 10, 10), [
      { x: 5, y: 5, w: 1, h: 1 }
    ]);
  });

  test('越界/重叠/NaN 均不抛异常，矩形始终在画布内', () => {
    const dirty = [
      { x: -0.5, y: -0.5, w: 0.7, h: 0.7 },
      { x: 0.9, y: 0.9, w: 0.5, h: 0.5 },
      { x: Number.NaN, y: 0.1, w: 0.2, h: 0.2 },
      box(0.1, 0.1, 0.4, 0.4),
      box(0.12, 0.12, 0.4, 0.4)
    ];
    const rects = regionsToMaskRects(dirty, 100, 50);
    assert.equal(rects.length, 4, 'NaN 被丢弃，其余保留（重叠不去重）');
    for (const rect of rects) {
      assertRectInside(rect, 100, 50);
    }
  });

  test('画布尺寸非正/非有限 → 空数组；空框 → 空数组', () => {
    assert.deepEqual(regionsToMaskRects([box(0.1, 0.1)], 0, 100), []);
    assert.deepEqual(regionsToMaskRects([box(0.1, 0.1)], 100, 0), []);
    assert.deepEqual(regionsToMaskRects([box(0.1, 0.1)], Number.NaN, 100), []);
    assert.deepEqual(regionsToMaskRects([], 100, 100), []);
    assert.deepEqual(regionsToMaskRects(undefined, 100, 100), []);
  });

  test('整页框 → 整块像素矩形（100×50 画布）', () => {
    assert.deepEqual(regionsToMaskRects([{ x: 0, y: 0, w: 1, h: 1 }], 100, 50), [
      { x: 0, y: 0, w: 100, h: 50 }
    ]);
  });
});
