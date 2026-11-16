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
  planRender,
  parsePageObjectsDoc,
  objectsOfPage,
  setObjectsOfPage,
  removePageObjects,
  addEmptyPage,
  countObjects,
  FIRST_PAGE_ID,
  PAGE_OBJECTS_VERSION,
  extensionOfUri,
  normalizeImageExt,
  imageObjectFromSelection
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
  test('v2 序列化 → 解析往返一致（按页、含 image/table 额外字段）', () => {
    const original = {
      p1: [
        makePageObject('i1', 'image', { x: 0.2, y: 0.1, w: 0.3, h: 0.2 }, { sha256: SHA, name: imageEntryName(SHA, 'jpg') }),
        makePageObject('b1', 'box', { x: 0.05, y: 0.05, w: 0.1, h: 0.1 })
      ],
      p2: [makePageObject('t1', 'table', { x: 0.1, y: 0.5, w: 0.5, h: 0.3 }, { rows: 2, cols: 5 })]
    };
    const encoded = serializePageObjects(original);
    const doc = JSON.parse(encoded);
    assert.equal(doc.version, 2, 'v2 文档必须带 version:2');
    const result = parsePageObjectsDoc(encoded);
    assert.equal(result.migrated, false, 'v2 不需要迁移');
    assert.deepEqual(objectsOfPage(result.pages, 'p1'), original.p1);
    assert.deepEqual(objectsOfPage(result.pages, 'p2'), original.p2);
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

// ---------------------------------------------------------------------------
// B2 批 1：按页存储（v2）+ v1 迁移 + 插页/删页联动
// ---------------------------------------------------------------------------

describe('按页存储：翻页/插页/删页 与 v1 迁移', () => {
  const page1 = [makePageObject('a', 'box', { x: 0.1, y: 0.1, w: 0.2, h: 0.2 })];
  const page2 = [makePageObject('b', 'table', { x: 0.3, y: 0.3, w: 0.2, h: 0.2 }, { rows: 2, cols: 2 })];

  test('① 翻页后对象不串页：p1/p2 各自只看到自己的对象', () => {
    const pages = { p1: page1, p2: page2 };
    assert.deepEqual(
      objectsOfPage(pages, 'p1').map((item) => item.id),
      ['a']
    );
    assert.deepEqual(
      objectsOfPage(pages, 'p2').map((item) => item.id),
      ['b']
    );
    assert.deepEqual(objectsOfPage(pages, 'p3'), [], '没有对象的页返回空数组而不是 undefined');
  });

  test('② 插页后原页对象仍在，新页为空', () => {
    const before = { p1: page1, p2: page2 };
    // 在第 2 页后面插一页 → PageBook 给它一个新 id（这里用 p3 表示）
    const after = addEmptyPage(before, 'p3');
    assert.deepEqual(
      objectsOfPage(after, 'p1').map((item) => item.id),
      ['a'],
      '插页不得影响原页对象'
    );
    assert.deepEqual(
      objectsOfPage(after, 'p2').map((item) => item.id),
      ['b']
    );
    assert.deepEqual(objectsOfPage(after, 'p3'), [], '新页为空');
    assert.equal(countObjects(after), 2);
  });

  test('③ 删页后该页对象一起删，其它页不受影响', () => {
    const before = { p1: page1, p2: page2 };
    const after = removePageObjects(before, 'p2');
    assert.equal(countObjects(after), 1);
    assert.deepEqual(objectsOfPage(after, 'p2'), []);
    assert.deepEqual(
      objectsOfPage(after, 'p1').map((item) => item.id),
      ['a']
    );
    // 原对象（入参）不被就地修改
    assert.equal(countObjects(before), 2, '操作必须返回新 map，不得改入参');
  });

  test('④ v1（单列表）迁移到 p1，数量不变且不抛', () => {
    const v1 = JSON.stringify([
      { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
      { x: 0.4, y: 0.4, w: 0.2, h: 0.2 }
    ]);
    const result = parsePageObjectsDoc(v1);
    assert.equal(result.migrated, true, '必须标记为迁移');
    assert.equal(countObjects(result.pages), 2, '对象数量不得变');
    assert.equal(objectsOfPage(result.pages, FIRST_PAGE_ID).length, 2, '整份挂到 p1');
    assert.equal(objectsOfPage(result.pages, 'p2').length, 0);
    // 单页兼容入口仍能拿到同一批
    assert.equal(parsePageObjects(v1).length, 2);
  });

  test('v2 文档里坏页值（非数组）被跳过，不影响其它页', () => {
    const json = JSON.stringify({ version: 2, pages: { p1: page1, p2: 'oops', p3: page2 } });
    const result = parsePageObjectsDoc(json);
    assert.equal(objectsOfPage(result.pages, 'p1').length, 1);
    assert.equal(objectsOfPage(result.pages, 'p3').length, 1);
    assert.equal(objectsOfPage(result.pages, 'p2').length, 0);
  });

  test('setObjectsOfPage：写空即删键（序列化不会留空页）', () => {
    const pages = setObjectsOfPage({ p1: page1 }, 'p1', []);
    assert.equal(Object.keys(pages).length, 0);
    assert.equal(serializePageObjects(pages), JSON.stringify({ version: PAGE_OBJECTS_VERSION, pages: {} }));
  });
});

// ---------------------------------------------------------------------------
// P0：「插入图片失败」配套纯函数（扩展名解析 + 插入计划）
// ---------------------------------------------------------------------------

describe('选图扩展名解析（media URI / 中文路径 / 大写 / 无后缀）', () => {
  test('.jpg / .jpeg / .png / .heic 都能识别', () => {
    assert.equal(extensionOfUri('file://media/Photo/12/IMG_001.jpg'), 'jpg');
    assert.equal(extensionOfUri('file://media/Photo/12/IMG_001.jpeg'), 'jpeg');
    assert.equal(extensionOfUri('file://media/Photo/12/IMG_001.png'), 'png');
    assert.equal(extensionOfUri('file://media/Photo/12/IMG_001.heic'), 'heic');
  });

  test('大写后缀归一化为小写', () => {
    assert.equal(extensionOfUri('file://media/Photo/12/IMG_001.JPG'), 'jpg');
    assert.equal(extensionOfUri('file://media/Photo/12/IMG_001.JPEG'), 'jpeg');
  });

  test('无后缀 / 空串 / 只有点 → 空串（调用方回落 jpg）', () => {
    for (const uri of ['file://media/Photo/12/IMG_001', '', 'file://media/Photo/12/IMG_001.', 'file://media/x/.jpg']) {
      const ext = extensionOfUri(uri);
      assert.equal(typeof ext, 'string');
      if (uri === 'file://media/x/.jpg') {
        assert.equal(ext, 'jpg', '.jpg 这种隐藏文件名仍应取到 jpg');
      } else {
        assert.equal(ext, '');
      }
    }
  });

  test('路径含中文 / 带 query 参数不影响解析', () => {
    assert.equal(extensionOfUri('file://media/Photo/12/截图 2026-11-16 上午.png'), 'png');
    assert.equal(extensionOfUri('file://media/Photo/12/IMG.jpg?width=100'), 'jpg');
    assert.equal(extensionOfUri('file://media/Photo/12/IMG.jpg#frag'), 'jpg');
  });

  test('normalizeImageExt：jpeg → jpg，未知 → jpg', () => {
    assert.equal(normalizeImageExt('jpeg'), 'jpg');
    assert.equal(normalizeImageExt('.JPEG'), 'jpg');
    assert.equal(normalizeImageExt('png'), 'png');
    assert.equal(normalizeImageExt(''), 'jpg');
    assert.equal(normalizeImageExt('weird/../x'), 'jpg');
  });
});

describe('imageObjectFromSelection：插入计划（矩形 + zip 条目名）', () => {
  test('正常图：条目名 image-<sha8>.<ext>，矩形 40% 页宽居中', () => {
    const plan = imageObjectFromSelection('file://media/Photo/1/a.PNG', 1000, 500, SHA);
    assert.equal(plan.ext, 'png');
    assert.equal(plan.entry, `image-${SHA.slice(0, 8)}.png`);
    assert.equal(plan.width, 1000);
    assert.equal(plan.height, 500);
    assert.equal(plan.rect.w, IMAGE_DEFAULT_WIDTH_RATIO);
    assert.ok(Math.abs(plan.rect.h - IMAGE_DEFAULT_WIDTH_RATIO * 0.5) < 1e-9);
    assert.ok(Math.abs(plan.rect.x - (1 - plan.rect.w) / 2) < 1e-9);
  });

  test('无后缀 uri → 条目名用 jpg', () => {
    const plan = imageObjectFromSelection('file://media/Photo/1/noext', 800, 600, SHA2);
    assert.equal(plan.ext, 'jpg');
    assert.equal(plan.entry, `image-${SHA2.slice(0, 8)}.jpg`);
  });

  test('尺寸非法（0 / NaN）→ 按 1×1 兜底，不产生 NaN/除零', () => {
    for (const [w, h] of [[0, 0], [Number.NaN, 100], [-5, 10]]) {
      const plan = imageObjectFromSelection('file://media/1/a.jpg', w, h, SHA);
      assert.equal(plan.width >= 1, true);
      assert.equal(plan.height >= 1, true);
      for (const value of [plan.rect.x, plan.rect.y, plan.rect.w, plan.rect.h]) {
        assert.equal(Number.isFinite(value), true);
      }
    }
  });

  test('sha256 缺失/非法 → 条目名带 pending（页面会先算摘要再落盘）', () => {
    assert.match(imageObjectFromSelection('file://media/1/a.jpg', 10, 10, '').entry, /^image-pending\.jpg$/);
    assert.match(imageObjectFromSelection('file://media/1/a.jpg', 10, 10, 'not-a-sha').entry, /^image-pending\.jpg$/);
  });
});
