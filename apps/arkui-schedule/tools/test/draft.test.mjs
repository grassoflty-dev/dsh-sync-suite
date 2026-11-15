// 手写板草稿（退出暂存 / 再进恢复）纯逻辑测试。
//
// 规格来自用户反馈：「手写板没有退出按钮，退出后应该要暂存当前手写页的所有内容，
// 可以后续进入再修改，完成才是按照要求做 OCR。」
//
// 这里只测 `model/draft.ts`（不碰 SDK），保证：
//   - 序列化/反序列化**往返一致**（笔迹点、框、页序、当前页）；
//   - 笔迹点归一化：换画布尺寸（含旋转 2389×1429 ↔ 1429×2389）后位置正确；
//   - 损坏 JSON → 空草稿 + `corrupt`，**不抛异常**；
//   - 超过 10 页 → 裁到 10 页且保留前 10 页顺序；
//   - 超过 2MB → 明确返回超限/裁剪标记。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';

// draft.ts 运行时依赖 regions.ts（同样无 SDK import），这里补 `.js` 后缀解析，
// 让测试跑的是 tsc 编译产物而不是另写一份实现。
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

const {
  DRAFT_KEY_DEFAULT,
  DRAFT_MAX_BYTES,
  DRAFT_MAX_PAGES,
  DRAFT_VERSION,
  draftFileName,
  emptyDraft,
  fitDraftToLimits,
  fromDraftStrokes,
  fromNormalizedPoints,
  hasContent,
  isUsableCanvas,
  newDraftKey,
  parseDraft,
  sanitizeDraftKey,
  serializeDraft,
  sizeOfDraft,
  toBrushKind,
  toDraftBoxes,
  toDraftStrokes,
  toNormalizedPoints,
  trimToMaxPages
} = await import('../.build/model/draft.js');

const here = dirname(fileURLToPath(import.meta.url));

/** 归一化往返带来的浮点误差容忍度（vp 级）。 */
const EPS = 1e-9;

/** 断言两组点坐标在 `EPS` 内一致（归一化往返不可能逐位相等）。 */
function assertPointsClose(actual, expected) {
  assert.equal(actual.length, expected.length, `点数不一致（${actual.length} vs ${expected.length}）`);
  for (let index = 0; index < expected.length; index++) {
    assert.ok(
      Math.abs(actual[index].x - expected[index].x) < EPS,
      `第 ${index} 个点 x 不符：${actual[index].x} vs ${expected[index].x}`
    );
    assert.ok(
      Math.abs(actual[index].y - expected[index].y) < EPS,
      `第 ${index} 个点 y 不符：${actual[index].y} vs ${expected[index].y}`
    );
  }
}

/**
 * 造一笔**草稿**笔迹。
 *
 * 注意：草稿里的点是**归一化**坐标（0..1），不是 vp 像素——落盘前由
 * `toDraftStrokes(strokes, w, h)` 换算。这里直接给归一化值，测的是「存取不变形」。
 */
function stroke(points, extra = {}) {
  return {
    points: points.map(([x, y]) => ({ x, y })),
    width: 3.5,
    color: '#1A1A1A',
    erase: false,
    brush: 'pen',
    ...extra
  };
}

/** 造一份 N 页草稿（第 i 页有 i+1 笔 + 1 个框）。 */
function draftWithPages(count, canvas = { w: 1000, h: 500 }) {
  const pages = [];
  for (let index = 0; index < count; index++) {
    pages.push({
      id: `p${index + 1}`,
      strokes: [0, 1].slice(0, index + 1).map((step) =>
        stroke([
          [0.01 + step * 0.001, 0.02 + step * 0.001],
          [0.03 + step * 0.001, 0.04 + step * 0.001]
        ])
      ),
      boxes: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.25 }]
    });
  }
  return { version: DRAFT_VERSION, draftKey: 'demo', canvas, current: 0, pages, updatedAt: 123 };
}

describe('草稿：draftKey 与文件名', () => {
  test('newDraftKey 生成 new-<时间戳>，且同一时间戳稳定', () => {
    assert.equal(newDraftKey(1763200000000), 'new-1763200000000');
    assert.equal(newDraftKey(1763200000000), newDraftKey(1763200000000));
  });

  test('sanitizeDraftKey 阻断目录穿越与非 ASCII，空值给默认键', () => {
    assert.equal(sanitizeDraftKey('../etc/passwd'), '.._etc_passwd');
    assert.equal(sanitizeDraftKey('a b/c'), 'a_b_c');
    assert.equal(sanitizeDraftKey(''), DRAFT_KEY_DEFAULT);
    assert.equal(sanitizeDraftKey('..'), DRAFT_KEY_DEFAULT);
    assert.equal(sanitizeDraftKey('1757900000000-ab12cd'), '1757900000000-ab12cd');
  });

  test('draftFileName 只产出 <key>.json（无路径分隔符）', () => {
    assert.equal(draftFileName('1757900000000-ab12cd'), '1757900000000-ab12cd.json');
    assert.equal(draftFileName('a/b'), 'a_b.json');
    assert.equal(draftFileName('a/b').includes('/'), false);
    assert.equal(draftFileName('a\\b').includes('\\'), false);
  });
});

describe('草稿：归一化换算', () => {
  test('vp → 0..1 → vp 往返一致（同一尺寸）', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 500, y: 250 },
      { x: 1000, y: 500 }
    ];
    const normalized = toNormalizedPoints(points, 1000, 500);
    assert.deepEqual(normalized, [
      { x: 0, y: 0 },
      { x: 0.5, y: 0.5 },
      { x: 1, y: 1 }
    ]);
    assert.deepEqual(fromNormalizedPoints(normalized, 1000, 500), points);
  });

  test('换尺寸后重投影：等比缩放（1000×500 → 500×250 位置减半）', () => {
    const normalized = toNormalizedPoints([{ x: 400, y: 200 }], 1000, 500);
    assert.deepEqual(fromNormalizedPoints(normalized, 500, 250), [{ x: 200, y: 100 }]);
  });

  test('旋转 2389×1429 ↔ 1429×2389：归一化值不变，坐标按新宽高换算', () => {
    // 横屏画布上 (1200, 700) 的点
    const landscape = toNormalizedPoints([{ x: 1200, y: 700 }], 2389, 1429);
    assert.ok(Math.abs(landscape[0].x - 1200 / 2389) < 1e-9);
    assert.ok(Math.abs(landscape[0].y - 700 / 1429) < 1e-9);
    // 竖屏画布（宽高互换）上还原：同一相对位置
    const portrait = fromNormalizedPoints(landscape, 1429, 2389);
    assert.ok(Math.abs(portrait[0].x - (1200 / 2389) * 1429) < 1e-6);
    assert.ok(Math.abs(portrait[0].y - (700 / 1429) * 2389) < 1e-6);
    // 再转回去仍是同一归一化值
    const again = toNormalizedPoints(portrait, 1429, 2389);
    assert.ok(Math.abs(again[0].x - landscape[0].x) < 1e-9);
    assert.ok(Math.abs(again[0].y - landscape[0].y) < 1e-9);
  });

  test('尺寸非法（0/负数/NaN）时不产出乱坐标', () => {
    assert.equal(isUsableCanvas(0, 500), false);
    assert.equal(isUsableCanvas(1000, -1), false);
    assert.equal(isUsableCanvas(NaN, 500), false);
    assert.deepEqual(toNormalizedPoints([{ x: 10, y: 10 }], 0, 500), []);
    assert.deepEqual(fromNormalizedPoints([{ x: 0.5, y: 0.5 }], 0, 0), []);
  });

  test('越界归一化点在还原时被夹到 0..1（不会画到画布外）', () => {
    const out = fromNormalizedPoints([{ x: -0.5, y: 2 }], 100, 200);
    assert.deepEqual(out, [{ x: 0, y: 200 }]);
  });
});

describe('草稿：序列化 / 反序列化往返一致', () => {
  test('笔迹点、框、页序、当前页、画布尺寸全部往返一致', () => {
    const doc = draftWithPages(3, { w: 2389, h: 1429 });
    doc.current = 2;
    const json = serializeDraft(doc);
    const parsed = parseDraft(json, doc.draftKey);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.reason, 'ok');
    assert.deepEqual(parsed.doc, doc);
  });

  test('笔迹的 width/color/brush/erase 原样保留（橡皮也是一笔）', () => {
    const doc = draftWithPages(1);
    doc.pages[0].strokes = [
      stroke([[0.01, 0.02], [0.03, 0.04]], { width: 7, color: '#D93025', brush: 'marker' }),
      stroke([[0.05, 0.06], [0.07, 0.08]], { erase: true, width: 20, brush: 'ballpoint' })
    ];
    const parsed = parseDraft(serializeDraft(doc), doc.draftKey);
    assert.deepEqual(parsed.doc.pages[0].strokes, doc.pages[0].strokes);
  });

  test('序列化后再解析两次结果稳定（幂等）', () => {
    const doc = draftWithPages(2);
    const once = parseDraft(serializeDraft(doc), doc.draftKey).doc;
    const twice = parseDraft(serializeDraft(once), doc.draftKey).doc;
    assert.deepEqual(twice, once);
  });

  test('空草稿：无内容、1 页', () => {
    const doc = emptyDraft('k1', { w: 100, h: 200 });
    assert.equal(doc.pages.length, 1);
    assert.equal(doc.current, 0);
    assert.equal(hasContent(doc), false);
    assert.equal(hasContent(draftWithPages(1)), true);
  });

  test('toDraftStrokes / fromDraftStrokes 往返（vp ↔ 归一化）', () => {
    const strokes = [stroke([[10, 20], [110, 220]], { width: 5, color: '#1A73E8', brush: 'pencil' })];
    const draftStrokes = toDraftStrokes(strokes, 400, 400);
    assertPointsClose(draftStrokes[0].points, [
      { x: 0.025, y: 0.05 },
      { x: 0.275, y: 0.55 }
    ]);
    // vp → 归一化 → vp 会有 1e-15 级浮点误差（0.025 不是二进制精确值），用容差比较
    const back = fromDraftStrokes(draftStrokes, 400, 400);
    assert.equal(back.length, 1);
    assertPointsClose(back[0].points, strokes[0].points);
    assert.equal(back[0].width, strokes[0].width);
    assert.equal(back[0].color, strokes[0].color);
    assert.equal(back[0].brush, strokes[0].brush);
    // 换尺寸（800×200）后同一相对位置
    const bigger = fromDraftStrokes(draftStrokes, 800, 200);
    assertPointsClose(bigger[0].points, [
      { x: 20, y: 10 },
      { x: 220, y: 110 }
    ]);
  });

  test('坏笔刷名回退到钢笔；坏框（零面积/NaN）被丢掉', () => {
    assert.equal(toBrushKind('brush-that-does-not-exist'), 'pen');
    assert.equal(toBrushKind('highlighter'), 'highlighter');
    assert.deepEqual(
      toDraftBoxes([
        { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
        { x: 0.1, y: 0.1, w: 0, h: 0 },
        { x: NaN, y: 0, w: 0.2, h: 0.2 }
      ]),
      [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }]
    );
  });
});

describe('草稿：损坏数据不崩', () => {
  const corruptCases = [
    ['不是 JSON', 'not-json-at-all{{{'],
    ['空对象', '{}'],
    ['版本不认识', '{"version":99,"pages":[{"id":"p1","strokes":[],"boxes":[]}]}'],
    ['pages 不是数组', '{"version":1,"pages":"oops"}'],
    ['pages 为空数组', '{"version":1,"pages":[]}'],
    ['页对象为 null', '{"version":1,"pages":[null]}'],
    ['笔迹点全是坏值', '{"version":1,"pages":[{"id":"p1","strokes":[{"points":[{"x":"a","y":"b"}]}]}]}'],
    ['顶层是数组', '[]'],
    ['顶层是数字', '42']
  ];
  for (const [name, json] of corruptCases) {
    test(`损坏 JSON → corrupt + 空草稿（不抛）：${name}`, () => {
      const parsed = parseDraft(json, 'k1');
      assert.equal(parsed.ok, false);
      assert.equal(parsed.reason, 'corrupt');
      assert.equal(parsed.doc.pages.length, 1);
      assert.equal(hasContent(parsed.doc), false);
    });
  }

  test('null / 空串 / 空白串 → empty（不是 corrupt）', () => {
    for (const value of [null, undefined, '', '   \n']) {
      const parsed = parseDraft(value, 'k1');
      assert.equal(parsed.ok, false);
      assert.equal(parsed.reason, 'empty');
    }
  });

  test('单个坏页/坏笔迹被跳过，其余照常恢复', () => {
    const json = JSON.stringify({
      version: 1,
      draftKey: 'k1',
      canvas: { w: 100, h: 100 },
      current: 0,
      pages: [
        { id: 'p1', strokes: [{ points: [{ x: 0.1, y: 0.1 }], width: 2, color: '#000000', brush: 'pen' }], boxes: [] },
        null,
        { id: 'p3', strokes: [{ points: [] }], boxes: [{ x: 0.2, y: 0.2, w: 0.3, h: 0.3 }] }
      ],
      updatedAt: 1
    });
    const parsed = parseDraft(json, 'k1');
    assert.equal(parsed.ok, true);
    assert.equal(parsed.doc.pages.length, 2);
    assert.equal(parsed.doc.pages[0].strokes.length, 1);
    assert.equal(parsed.doc.pages[1].strokes.length, 0);
    assert.equal(parsed.doc.pages[1].boxes.length, 1);
  });

  test('current 越界被夹回合法范围', () => {
    const doc = draftWithPages(2);
    doc.current = 99;
    const parsed = parseDraft(serializeDraft(doc), doc.draftKey);
    assert.equal(parsed.doc.current, 1);
    doc.current = -5;
    const parsed2 = parseDraft(serializeDraft(doc), doc.draftKey);
    assert.equal(parsed2.doc.current, 0);
  });
});

describe('草稿：页数上限 10 页', () => {
  test('超过 10 页裁到 10 页，且保留前 10 页顺序（id 连续）', () => {
    const doc = draftWithPages(14);
    const trimmed = trimToMaxPages(doc, DRAFT_MAX_PAGES);
    assert.equal(trimmed.trimmed, true);
    assert.equal(trimmed.doc.pages.length, 10);
    assert.deepEqual(
      trimmed.doc.pages.map((page) => page.id),
      ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9', 'p10']
    );
  });

  test('裁剪后 current 越界会被拉回最后一页', () => {
    const doc = draftWithPages(14);
    doc.current = 13;
    const trimmed = trimToMaxPages(doc, 10);
    assert.equal(trimmed.doc.current, 9);
  });

  test('未超限时不裁（trimmed=false，内容引用不变）', () => {
    const doc = draftWithPages(10);
    const trimmed = trimToMaxPages(doc, 10);
    assert.equal(trimmed.trimmed, false);
    assert.deepEqual(trimmed.doc.pages, doc.pages);
  });

  test('解析 14 页草稿时也裁到 10 页（读侧同样有上限）', () => {
    const parsed = parseDraft(serializeDraft(draftWithPages(14)), 'k1');
    assert.equal(parsed.ok, true);
    assert.equal(parsed.doc.pages.length, DRAFT_MAX_PAGES);
  });
});

describe('草稿：2MB 上限', () => {
  test('体积算的是 UTF-8 字节（中文 3 字节）', () => {
    assert.equal(sizeOfDraft('abc'), 3);
    assert.equal(sizeOfDraft('中文'), 6);
    assert.equal(sizeOfDraft('😀'), 4);
  });

  test('未超限：bytes < 2MB 且 trimmed=false、页数不变', () => {
    const doc = draftWithPages(3);
    const encoded = fitDraftToLimits(doc, DRAFT_MAX_PAGES, DRAFT_MAX_BYTES);
    assert.equal(encoded.trimmed, false);
    assert.equal(encoded.pages, 3);
    assert.equal(encoded.dropped, 0);
    assert.ok(encoded.bytes > 0 && encoded.bytes < DRAFT_MAX_BYTES);
    assert.equal(encoded.bytes, sizeOfDraft(encoded.json));
  });

  test('超限：从尾部丢页直到 ≤2MB，并明确标记 trimmed/dropped', () => {
    // 每页都塞满点，把体积顶到 2MB 以上
    const doc = draftWithPages(10);
    const fatPoints = [];
    for (let index = 0; index < 12000; index++) {
      fatPoints.push([index / 12000, (index % 100) / 100]);
    }
    for (const page of doc.pages) {
      page.strokes = [
        {
          points: fatPoints.map(([x, y]) => ({ x, y })),
          width: 3.5,
          color: '#1A1A1A',
          brush: 'pen',
          erase: false
        }
      ];
    }
    assert.ok(sizeOfDraft(serializeDraft(doc)) > DRAFT_MAX_BYTES, '构造的草稿必须先超过 2MB');
    const encoded = fitDraftToLimits(doc, DRAFT_MAX_PAGES, DRAFT_MAX_BYTES);
    assert.ok(encoded.bytes <= DRAFT_MAX_BYTES, `裁剪后必须 ≤2MB，实际 ${encoded.bytes}`);
    assert.equal(encoded.trimmed, true);
    assert.ok(encoded.dropped > 0);
    assert.ok(encoded.pages >= 1 && encoded.pages < 10);
    // 保留下来的仍是**前**几页（页 id 从 p1 开始连续）
    const parsed = parseDraft(encoded.json, 'k1');
    assert.equal(parsed.ok, true);
    assert.equal(parsed.doc.pages.length, encoded.pages);
    assert.equal(parsed.doc.pages[0].id, 'p1');
  });

  test('单页就超限时至少保留 1 页（不会写出空草稿）', () => {
    const doc = draftWithPages(1);
    const encoded = fitDraftToLimits(doc, DRAFT_MAX_PAGES, 64);
    assert.equal(encoded.pages, 1);
    assert.ok(encoded.bytes > 0);
  });
});

describe('草稿：落盘（真实文件往返，验证文件名安全）', () => {
  let dir = '';
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-draft-'));
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('写到 <dir>/<key>.json 后读回一致（模拟 filesDir/drafts）', () => {
    const doc = draftWithPages(2, { w: 2389, h: 1429 });
    const file = join(dir, draftFileName(doc.draftKey));
    writeFileSync(file, serializeDraft(doc), 'utf8');
    const parsed = parseDraft(readFileSync(file, 'utf8'), doc.draftKey);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.doc, doc);
  });

  test('损坏文件读出来是 corrupt，调用方可据此删文件', () => {
    const file = join(dir, draftFileName('broken'));
    writeFileSync(file, '{"version":1,"pages":[', 'utf8');
    const parsed = parseDraft(readFileSync(file, 'utf8'), 'broken');
    assert.equal(parsed.ok, false);
    assert.equal(parsed.reason, 'corrupt');
  });
});
