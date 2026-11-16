// 页面对象模型（框 / 图片 / 表格）纯逻辑测试。
//
// 锁死用户明确要求的行为：
//   - 归一化/夹取/最小尺寸（40vp 对应 0.04）、序列化往返；
//   - 旧 boxes → kind:'box' 迁移；
//   - 混合对象（1 框 + 1 图 + 1 表）→ 遮罩 3 个、占位符 3 个且按 y 排序；
//   - zip 条目数 = 页数 + 图片数；
//   - 表格行列夹紧到 1..10（0 / -1 / 99）。
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const {
  OBJECT_MIN_SIZE,
  TABLE_DEFAULT_LINES,
  TABLE_MAX_LINES,
  TABLE_MIN_LINES,
  IMAGE_DEFAULT_WIDTH_RATIO,
  clampTableLines,
  normalizeRect,
  makePageObject,
  centerRect,
  imageRectFor,
  tableRect,
  imageEntryName,
  objectsToMaskRects,
  objectPlaceholder,
  sortObjectsByPosition,
  pagePlaceholders,
  serializePageObjects,
  parsePageObjects,
  migrateLegacyBoxes,
  archiveEntryNames,
  imageEntriesOf,
  needsImageCompression,
  IMAGE_MAX_BYTES,
  IMAGE_MAX_SIDE,
  HANDLE_HIT_RADIUS,
  CLOSE_HIT_RADIUS,
  hitTest,
  findObject,
  moveObject,
  resizeObject,
  replaceObject,
  deleteObject,
  bringToFront,
  planRender
} = await import('../.build/model/pageObjects.js');

const SHA = 'a'.repeat(64);
const SHA2 = 'b'.repeat(64);

describe('normalizeRect：归一化 / 夹取 / 最小尺寸', () => {
  test('越界坐标被夹回画布内（右下角推出 → 整个矩形回推）', () => {
    const rect = normalizeRect({ x: 0.9, y: 0.95, w: 0.3, h: 0.2 });
    assert.ok(rect.x + rect.w <= 1 + 1e-9, '右边界不得越界');
    assert.ok(rect.y + rect.h <= 1 + 1e-9, '下边界不得越界');
    assert.equal(rect.x, 0.7);
    assert.equal(rect.y, 0.8);
  });

  test('负数坐标夹到 0；宽高被压到最小尺寸', () => {
    const rect = normalizeRect({ x: -0.5, y: -0.2, w: 0.001, h: 0 });
    assert.equal(rect.x, 0);
    assert.equal(rect.y, 0);
    assert.equal(rect.w, OBJECT_MIN_SIZE);
    assert.equal(rect.h, OBJECT_MIN_SIZE);
  });

  test('NaN 输入不产生 NaN 输出（用默认值兜底）', () => {
    const rect = normalizeRect({ x: Number.NaN, y: Number.NaN, w: Number.NaN, h: Number.NaN });
    for (const value of [rect.x, rect.y, rect.w, rect.h]) {
      assert.equal(Number.isFinite(value), true);
    }
  });

  test('宽高上限 1（不能超过整页）', () => {
    const rect = normalizeRect({ x: 0, y: 0, w: 3, h: 2 });
    assert.equal(rect.w, 1);
    assert.equal(rect.h, 1);
  });
});

describe('对象构造：图片 / 表格 默认值', () => {
  test('centerRect 以画布中心插入', () => {
    const rect = centerRect(0.4, 0.2);
    assert.equal(rect.x, 0.3);
    assert.equal(rect.y, 0.4);
  });

  test('imageRectFor：默认占页宽 40%，高度按原图比例', () => {
    const rect = imageRectFor(1000, 500);
    assert.equal(rect.w, IMAGE_DEFAULT_WIDTH_RATIO);
    assert.ok(Math.abs(rect.h - IMAGE_DEFAULT_WIDTH_RATIO * 0.5) < 1e-9, '高度按原图宽高比折算');
    assert.ok(Math.abs(rect.x - (1 - rect.w) / 2) < 1e-9, '水平居中');
  });

  test('imageRectFor：竖图不会被撑出画布（高度夹回 1 以内）', () => {
    const rect = imageRectFor(100, 4000);
    assert.ok(rect.h <= 1);
    assert.ok(rect.y >= 0);
  });

  test('tableRect：默认 60% × 40% 居中', () => {
    const rect = tableRect();
    assert.equal(rect.w, 0.6);
    assert.equal(rect.h, 0.4);
  });

  test('表格行/列夹紧到 1..10（0 / -1 / 99 / 3.6）', () => {
    assert.equal(clampTableLines(0), TABLE_MIN_LINES);
    assert.equal(clampTableLines(-1), TABLE_MIN_LINES);
    assert.equal(clampTableLines(99), TABLE_MAX_LINES);
    assert.equal(clampTableLines(3.6), 4);
    assert.equal(clampTableLines(Number.NaN), TABLE_DEFAULT_LINES);
  });

  test('makePageObject(table)：rows/cols 一定在 1..10 内', () => {
    const object = makePageObject('t1', 'table', tableRect(), { rows: 0, cols: 99 });
    assert.equal(object.rows, 1);
    assert.equal(object.cols, 10);
    assert.equal(object.kind, 'table');
  });

  test('makePageObject(image)：sha256 归一化为小写，name 保留', () => {
    const object = makePageObject('i1', 'image', imageRectFor(10, 10), {
      sha256: SHA.toUpperCase(),
      name: imageEntryName(SHA, 'PNG')
    });
    assert.equal(object.sha256, SHA);
    assert.equal(object.name, `image-${SHA.slice(0, 8)}.png`);
  });
});

describe('imageEntryName：zip 条目命名', () => {
  test('`image-<sha前8位>.<ext>`，扩展名小写化并去掉点', () => {
    assert.equal(imageEntryName(SHA, 'jpg'), 'image-aaaaaaaa.jpg');
    assert.equal(imageEntryName(SHA, '.PNG'), 'image-aaaaaaaa.png');
  });

  test('非法扩展名回落 jpg；非法 sha256 抛错（防路径注入）', () => {
    assert.equal(imageEntryName(SHA, 'weird/../x'), 'image-aaaaaaaa.jpg');
    assert.throws(() => imageEntryName('not-a-sha', 'jpg'), /sha256 不合法/);
  });
});

describe('遮罩与占位符：混合对象', () => {
  const mixed = [
    makePageObject('b1', 'box', { x: 0.1, y: 0.7, w: 0.2, h: 0.1 }),
    makePageObject('i1', 'image', { x: 0.5, y: 0.1, w: 0.3, h: 0.2 }, { sha256: SHA, name: imageEntryName(SHA, 'jpg') }),
    makePageObject('t1', 'table', { x: 0.1, y: 0.3, w: 0.6, h: 0.3 }, { rows: 3, cols: 4 })
  ];

  test('混合对象 → 遮罩矩形 3 个', () => {
    assert.equal(objectsToMaskRects(mixed).length, 3);
  });

  test('混合对象 → 占位符 3 个，且按 y 升序（图 0.1 → 表 0.3 → 框 0.7）', () => {
    const texts = pagePlaceholders(mixed, 2);
    assert.equal(texts.length, 3);
    assert.deepEqual(texts, [
      '[图片: 见附件 · 第2页]',
      '[表格 3×4: 见附件 · 第2页]',
      '[图表/公式: 查看手迹 · 第2页]'
    ]);
  });

  test('同 y 时按 x 升序', () => {
    const left = makePageObject('a', 'table', { x: 0.1, y: 0.5, w: 0.2, h: 0.2 });
    const right = makePageObject('b', 'image', { x: 0.6, y: 0.5, w: 0.2, h: 0.2 });
    const sorted = sortObjectsByPosition([right, left]);
    assert.deepEqual(
      sorted.map((item) => item.id),
      ['a', 'b']
    );
  });

  test('占位符文案：图片/表格带页号与行列，框沿用旧文案', () => {
    const page = 3;
    assert.equal(objectPlaceholder(mixed[1], page), '[图片: 见附件 · 第3页]');
    assert.equal(objectPlaceholder(mixed[2], page), '[表格 3×4: 见附件 · 第3页]');
    assert.equal(objectPlaceholder(mixed[0], page), '[图表/公式: 查看手迹 · 第3页]');
  });

  test('includeBox=false 时只输出图片/表格占位符（框交给 regions.ts）', () => {
    assert.equal(pagePlaceholders(mixed, 1, false).length, 2);
  });
});

describe('序列化往返与旧数据迁移', () => {
  test('序列化 → 解析往返一致（含 image/table 额外字段）', () => {
    const original = [
      makePageObject('i1', 'image', { x: 0.2, y: 0.1, w: 0.3, h: 0.2 }, { sha256: SHA, name: imageEntryName(SHA, 'jpg') }),
      makePageObject('t1', 'table', { x: 0.1, y: 0.5, w: 0.5, h: 0.3 }, { rows: 2, cols: 5 }),
      makePageObject('b1', 'box', { x: 0.05, y: 0.05, w: 0.1, h: 0.1 })
    ];
    const parsed = parsePageObjects(serializePageObjects(original));
    assert.equal(parsed.length, 3);
    assert.deepEqual(parsed[0], original[0]);
    assert.deepEqual(parsed[1], original[1]);
    assert.deepEqual(parsed[2], original[2]);
  });

  test('旧 boxes（只有坐标、没有 kind/id）→ 迁移成 kind:box', () => {
    const legacy = JSON.stringify([
      { x: 0.1, y: 0.2, w: 0.3, h: 0.1 },
      { x: 0.4, y: 0.5, w: 0.2, h: 0.2 }
    ]);
    const parsed = parsePageObjects(legacy);
    assert.equal(parsed.length, 2);
    for (const object of parsed) {
      assert.equal(object.kind, 'box');
      assert.ok(object.id.length > 0, '必须补出稳定 id');
    }
    assert.deepEqual(
      parsed.map((item) => item.id),
      ['box-0', 'box-1']
    );
  });

  test('migrateLegacyBoxes 与 parsePageObjects 的旧数据结果等价', () => {
    const boxes = [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }];
    assert.deepEqual(migrateLegacyBoxes(boxes), parsePageObjects(JSON.stringify(boxes)));
  });

  test('损坏 JSON / 空串 / 非数组 → 空列表（不抛）', () => {
    for (const bad of ['', 'not json', '{"a":1}', 'null', '[null, null]']) {
      const parsed = parsePageObjects(bad);
      assert.equal(Array.isArray(parsed), true);
      assert.equal(parsed.length, 0);
    }
  });

  test('未知 kind 回落 box（未来版本向后兼容）', () => {
    const parsed = parsePageObjects(JSON.stringify([{ id: 'x', kind: 'video', x: 0.1, y: 0.1, w: 0.2, h: 0.2 }]));
    assert.equal(parsed[0].kind, 'box');
  });
});

describe('zip 条目：页数 + 图片数', () => {
  test('archiveEntryNames：3 页 + 2 张图 → 5 条，页在前', () => {
    const names = archiveEntryNames(3, ['image-aaaaaaaa.jpg', 'image-bbbbbbbb.png']);
    assert.deepEqual(names, [
      'page-0.jpg',
      'page-1.jpg',
      'page-2.jpg',
      'image-aaaaaaaa.jpg',
      'image-bbbbbbbb.png'
    ]);
  });

  test('重复图片（同一张插入两次）只保留一条', () => {
    const names = archiveEntryNames(1, ['image-aaaaaaaa.jpg', 'image-aaaaaaaa.jpg']);
    assert.deepEqual(names, ['page-0.jpg', 'image-aaaaaaaa.jpg']);
  });

  test('imageEntriesOf：只取 image 对象，按对象顺序去重', () => {
    const objects = [
      makePageObject('i1', 'image', { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, { sha256: SHA, name: 'image-aaaaaaaa.jpg' }),
      makePageObject('b1', 'box', { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }),
      makePageObject('i2', 'image', { x: 0.3, y: 0.3, w: 0.2, h: 0.2 }, { sha256: SHA, name: 'image-aaaaaaaa.jpg' }),
      makePageObject('i3', 'image', { x: 0.5, y: 0.5, w: 0.2, h: 0.2 }, { sha256: SHA2, name: 'image-bbbbbbbb.png' })
    ];
    assert.deepEqual(imageEntriesOf(objects), ['image-aaaaaaaa.jpg', 'image-bbbbbbbb.png']);
  });
});

describe('图片压缩阈值（>5MB 或长边 >2048 才缩）', () => {
  test('阈值常量符合需求', () => {
    assert.equal(IMAGE_MAX_BYTES, 5 * 1024 * 1024);
    assert.equal(IMAGE_MAX_SIDE, 2048);
  });

  test('体积/边长任一超标都需要压缩', () => {
    assert.equal(needsImageCompression(IMAGE_MAX_BYTES + 1, 1000), true);
    assert.equal(needsImageCompression(1000, IMAGE_MAX_SIDE + 1), true);
    assert.equal(needsImageCompression(IMAGE_MAX_BYTES, IMAGE_MAX_SIDE), false);
  });
});

// ---------------------------------------------------------------------------
// B1：命中判定 + 拖拽/缩放/删除/层级（纯函数）
// ---------------------------------------------------------------------------

describe('hitTest：命中判定（本体 / 右下角手柄 / 左上角 ×）', () => {
  const obj = makePageObject('o1', 'box', { x: 0.2, y: 0.2, w: 0.4, h: 0.3 });

  test('点本体内部 → body', () => {
    assert.deepEqual(hitTest([obj], 0.4, 0.35), { id: 'o1', part: 'body' });
  });

  test('点右下角（手柄半径内）→ handle', () => {
    const hit = hitTest([obj], 0.6 - HANDLE_HIT_RADIUS / 2, 0.5 - HANDLE_HIT_RADIUS / 2);
    assert.deepEqual(hit, { id: 'o1', part: 'handle' });
  });

  test('点左上角（× 半径内）→ close', () => {
    const hit = hitTest([obj], 0.2 + CLOSE_HIT_RADIUS / 2, 0.2 + CLOSE_HIT_RADIUS / 2);
    assert.deepEqual(hit, { id: 'o1', part: 'close' });
  });

  test('点空白 → 空 id（取消选中）', () => {
    assert.equal(hitTest([obj], 0.9, 0.95).id, '');
  });

  test('多对象层级：后插入的在上面，重叠处命中后者', () => {
    const bottom = makePageObject('bottom', 'box', { x: 0.1, y: 0.1, w: 0.5, h: 0.5 });
    const top = makePageObject('top', 'table', { x: 0.2, y: 0.2, w: 0.3, h: 0.3 }, { rows: 2, cols: 2 });
    assert.equal(hitTest([bottom, top], 0.3, 0.3).id, 'top');
    assert.equal(hitTest([top, bottom], 0.3, 0.3).id, 'bottom', '数组顺序变了，命中结果也要跟着变');
  });

  test('NaN 坐标 → 不命中也不抛', () => {
    assert.equal(hitTest([obj], Number.NaN, Number.NaN).id, '');
  });
});

describe('moveObject / resizeObject：夹取与最小尺寸', () => {
  test('移动：位置变、尺寸不变', () => {
    const obj = makePageObject('o1', 'image', { x: 0.2, y: 0.2, w: 0.3, h: 0.2 }, { sha256: SHA, name: 'image-aaaaaaaa.jpg' });
    const moved = moveObject(obj, 0.5, 0.6);
    assert.equal(moved.x, 0.5);
    assert.equal(moved.y, 0.6);
    assert.equal(moved.w, obj.w);
    assert.equal(moved.h, obj.h);
    assert.equal(moved.sha256, SHA, '图片附加字段必须保留');
    assert.equal(moved.name, 'image-aaaaaaaa.jpg');
  });

  test('移动：拖出右/下边界会被夹回（整个矩形不越界）', () => {
    const obj = makePageObject('o1', 'box', { x: 0.2, y: 0.2, w: 0.4, h: 0.4 });
    const moved = moveObject(obj, 0.95, 0.95);
    assert.ok(moved.x + moved.w <= 1 + 1e-9);
    assert.ok(moved.y + moved.h <= 1 + 1e-9);
  });

  test('缩放：右下角跟手，左上角不动', () => {
    const obj = makePageObject('o1', 'box', { x: 0.2, y: 0.2, w: 0.2, h: 0.2 });
    const resized = resizeObject(obj, 0.7, 0.8);
    assert.equal(resized.x, 0.2);
    assert.equal(resized.y, 0.2);
    assert.ok(Math.abs(resized.w - 0.5) < 1e-9);
    assert.ok(Math.abs(resized.h - 0.6) < 1e-9);
  });

  test('缩放：拖到左上方向（小于最小尺寸）→ 夹到最小 40vp 当量', () => {
    const obj = makePageObject('o1', 'box', { x: 0.5, y: 0.5, w: 0.3, h: 0.3 });
    const resized = resizeObject(obj, 0.5, 0.5);
    assert.equal(resized.w, 0.04);
    assert.equal(resized.h, 0.04);
  });

  test('缩放：右下角拖出画布 → 尺寸夹到画布边界内', () => {
    const obj = makePageObject('o1', 'table', { x: 0.5, y: 0.5, w: 0.2, h: 0.2 }, { rows: 3, cols: 4 });
    const resized = resizeObject(obj, 1.5, 1.5);
    assert.ok(resized.x + resized.w <= 1 + 1e-9);
    assert.ok(resized.y + resized.h <= 1 + 1e-9);
    assert.equal(resized.rows, 3, '表格行列不因缩放变化');
    assert.equal(resized.cols, 4);
  });

  test('NaN 缩放输入 → 不产生 NaN', () => {
    const obj = makePageObject('o1', 'box', { x: 0.2, y: 0.2, w: 0.2, h: 0.2 });
    const resized = resizeObject(obj, Number.NaN, Number.NaN);
    for (const value of [resized.x, resized.y, resized.w, resized.h]) {
      assert.equal(Number.isFinite(value), true);
    }
  });
});

describe('replaceObject / deleteObject / bringToFront / planRender', () => {
  const a = makePageObject('a', 'box', { x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
  const b = makePageObject('b', 'image', { x: 0.3, y: 0.3, w: 0.2, h: 0.2 }, { sha256: SHA, name: 'image-aaaaaaaa.jpg' });
  const c = makePageObject('c', 'table', { x: 0.5, y: 0.5, w: 0.2, h: 0.2 }, { rows: 2, cols: 3 });

  test('replaceObject：只替换同 id，z 序不变', () => {
    const moved = moveObject(b, 0.6, 0.6);
    const list = replaceObject([a, b, c], moved);
    assert.deepEqual(
      list.map((item) => item.id),
      ['a', 'b', 'c']
    );
    assert.equal(list[1].x, 0.6);
    assert.equal(findObject(list, 'b').x, 0.6);
  });

  test('deleteObject：删掉目标，其它保持顺序', () => {
    assert.deepEqual(
      deleteObject([a, b, c], 'b').map((item) => item.id),
      ['a', 'c']
    );
    assert.equal(deleteObject([a], 'missing').length, 1, '删不存在的 id 不应少东西');
  });

  test('bringToFront：选中项移到数组末尾（最上层）', () => {
    assert.deepEqual(
      bringToFront([a, b, c], 'a').map((item) => item.id),
      ['b', 'c', 'a']
    );
    assert.deepEqual(
      bringToFront([a, b, c], 'missing').map((item) => item.id),
      ['a', 'b', 'c']
    );
  });

  test('planRender：按 kind 分组且保持 z 序（先画下面再画上面）', () => {
    const plan = planRender([a, b, c]);
    assert.deepEqual(plan.boxes.map((item) => item.id), ['a']);
    assert.deepEqual(plan.images.map((item) => item.id), ['b']);
    assert.deepEqual(plan.tables.map((item) => item.id), ['c']);
    // 混合层级：后插入的 table 在最上，分组后仍在 tables 组内保持相对顺序
    const t2 = makePageObject('t2', 'table', { x: 0.1, y: 0.6, w: 0.2, h: 0.2 });
    assert.deepEqual(
      planRender([c, a, t2]).tables.map((item) => item.id),
      ['c', 't2']
    );
  });
});
