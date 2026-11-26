// mod-app-remote-glyph-rail-polish：浮动图标轨「不压页面」的纯布局模型单测 + 源码级守卫。
//
// 前置：node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
// `model/glyphRailLayout.ts` 零 SDK / 零 UI import，编译产物可直接被 Node 加载。
//
// 覆盖两类事实：
//   A–E：几何表 —— 每一行（真机 / 窄屏 / 宽屏 / 横屏 / 零-小-大安全区 / 退化输入）都必须
//        满足同一组不变量；任何一行做不到就必须是 typed 退化结论，**绝不允许静默重叠**；
//   F  ：源码守卫 —— `pages/RemoteControl.ets` 的图标轨与 WebView 几何必须来自模型，
//        不许写死数字（这条守卫在改页面**之前**是红的，改完才绿）。
//
// 术语：rail = 浮动图标轨盒子，content = WebView 盒子（DSH 页面），gutter = 保留槽。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { matchBrace, stripComments } from './helpers/etsSource.mjs';
import { requireOverlayRestored } from './guard.mjs';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !specifier.endsWith('.js') && !specifier.endsWith('.json')) {
      return nextResolve(`${specifier}.js`, context);
    }
    return nextResolve(specifier, context);
  },
});

requireOverlayRestored('glyphRailLayout.test.mjs');

const HERE = dirname(fileURLToPath(import.meta.url));
const ETS = resolve(HERE, '../../entry/src/main/ets');
const PAGE_ETS = resolve(ETS, 'pages/RemoteControl.ets');
const MODEL_TS = resolve(ETS, 'model/glyphRailLayout.ts');

const layout = await import('../.build/model/glyphRailLayout.js');
const {
  glyphRailLayout,
  rectsIntersect,
  GLYPH_TOUCH_MIN_VP,
  GLYPH_DEFAULT_VP,
  GLYPH_MAX_VP,
  GAP_MIN_VP,
  GAP_DEFAULT_VP,
  GAP_MAX_VP,
  NARROW_VIEWPORT_VP,
  MIN_CONTENT_WIDTH_VP,
  MIN_CONTENT_HEIGHT_VP,
  MAX_GLYPH_COUNT
} = layout;

const PAGE = readFileSync(PAGE_ETS, 'utf8');
const CODE = stripComments(PAGE);
const MODEL = readFileSync(MODEL_TS, 'utf8');

/** 取某个 `@Builder` / 方法 / `build()` 之后的花括号块（只用于源码形状断言）。 */
const blockAfter = (src, marker) => {
  const at = src.indexOf(marker);
  assert.notEqual(at, -1, `找不到 ${marker}`);
  const brace = src.indexOf('{', at + marker.length - 1);
  assert.notEqual(brace, -1, `${marker} 之后没有花括号`);
  const [start, end] = matchBrace(src, brace);
  return src.slice(start + 1, end - 1);
};

/** 一行测试输入 + 期望。 */
const NO_INSET = { top: 0, bottom: 0, left: 0, right: 0 };

const inputOf = (row) => ({
  viewportW: row.w,
  viewportH: row.h,
  safeAreaTop: row.inset === undefined ? NO_INSET.top : row.inset.top,
  safeAreaBottom: row.inset === undefined ? NO_INSET.bottom : row.inset.bottom,
  safeAreaLeft: row.inset === undefined ? NO_INSET.left : row.inset.left,
  safeAreaRight: row.inset === undefined ? NO_INSET.right : row.inset.right,
  glyphSize: row.glyphSize === undefined ? GLYPH_DEFAULT_VP : row.glyphSize,
  gap: row.gap === undefined ? GAP_DEFAULT_VP : row.gap,
  glyphCount: row.glyphCount === undefined ? MAX_GLYPH_COUNT : row.glyphCount
});

/**
 * 设备 / 输入表。真机取值来自 `docs/UI-DESIGN.md`：平板 MLR-AL00 物理 1600×2560、
 * 按 2.375 折算 ≈ 673.7×1077.9vp（竖屏）与 1077.9×673.7vp（横屏）。
 */
const ROWS = [
  // ---- 可用行（ok:true）：不变量必须全部成立 ----
  { name: '真机平板竖屏 673.7×1077.9vp', w: 673.7, h: 1077.9, reason: 'ok' },
  { name: '真机平板横屏 1077.9×673.7vp', w: 1077.9, h: 673.7, reason: 'ok' },
  { name: '平板竖屏 + 大安全区（24 / 12 / 8 / 8）', w: 673.7, h: 1077.9,
    inset: { top: 24, bottom: 12, left: 8, right: 8 }, reason: 'ok' },
  { name: '平板横屏 + 大安全区（28 / 20 / 12 / 12）', w: 1077.9, h: 673.7,
    inset: { top: 28, bottom: 20, left: 12, right: 12 }, reason: 'ok' },
  { name: '平板竖屏 + 小安全区（1 / 1 / 1 / 1）', w: 673.7, h: 1077.9,
    inset: { top: 1, bottom: 1, left: 1, right: 1 }, reason: 'ok' },
  { name: '手机竖屏 360×780（窄屏规则）', w: 360, h: 780, reason: 'narrow' },
  { name: '手机横屏 780×360（矮窗但页面仍够高）', w: 780, h: 360, reason: 'ok' },
  { name: '窄屏手机 320×640 + 状态栏 24 / 导航 12', w: 320, h: 640,
    inset: { top: 24, bottom: 12, left: 0, right: 0 }, reason: 'narrow' },
  { name: '窄屏边界 479×800（阈值下方）', w: 479, h: 800, reason: 'narrow' },
  { name: '窄屏边界 480×800（阈值本身 = 宽屏）', w: 480, h: 800, reason: 'ok' },
  { name: '宽屏平板 1280×800', w: 1280, h: 800, reason: 'ok' },
  { name: '宽屏平板 2560×1600 + 零安全区', w: 2560, h: 1600, reason: 'ok' },
  { name: '非常窄但恰好放得下 296×640（第 1 个字形数）', w: 296, h: 640,
    glyphCount: 1, reason: 'narrow' },
  { name: '竖屏平板 + 只有两个字形的表面（loading 之后 error）', w: 673.7, h: 1077.9,
    glyphCount: 2, reason: 'ok' },
  { name: '竖屏平板 + 只有一个字形的表面', w: 673.7, h: 1077.9, glyphCount: 1, reason: 'ok' },
  // ---- 退化行（ok:false）：必须 typed，且不允许出现重叠 / 负宽度 ----
  { name: '视口 0×0（onAreaChange 还没来）', w: 0, h: 0, degenerate: 'E_VIEWPORT_INVALID' },
  { name: '视口 NaN', w: Number.NaN, h: 800, degenerate: 'E_VIEWPORT_INVALID' },
  { name: '视口 Infinity', w: Infinity, h: 800, degenerate: 'E_VIEWPORT_INVALID' },
  { name: '负视口 320×-10', w: 320, h: -10, degenerate: 'E_VIEWPORT_INVALID' },
  { name: '负安全区（坏输入，不静默夹紧）', w: 673.7, h: 1077.9,
    inset: { top: -1, bottom: 0, left: 0, right: 0 }, degenerate: 'E_SAFE_AREA_INVALID' },
  { name: '安全区吃满宽度（左 400 + 右 300）', w: 673.7, h: 1077.9,
    inset: { top: 0, bottom: 0, left: 400, right: 300 }, degenerate: 'E_SAFE_AREA_INVALID' },
  { name: '极窄视口 200×640（放不下 44vp 轨 + 240vp 页面）', w: 200, h: 640,
    degenerate: 'E_CONTENT_TOO_NARROW' },
  { name: '极矮视口 800×150 + 单个字形（页面高 < 160vp）', w: 800, h: 150,
    glyphCount: 1, degenerate: 'E_CONTENT_TOO_SHORT' },
  { name: '安全区高度塞不下 3 个字形（800×140，rail 152vp）', w: 800, h: 140,
    degenerate: 'E_RAIL_TOO_TALL' }
];

describe('A. 几何表：每一行都满足同一组不变量（或 typed 退化）', () => {
  test('A1 表覆盖：真机 / 窄屏 / 宽屏 / 横屏 / 零-小-大安全区 / 退化输入都在', () => {
    const names = ROWS.map((row) => row.name).join('\n');
    for (const need of ['真机平板竖屏', '真机平板横屏', '360×780', '320×640', '1280×800',
      '零安全区', '小安全区', '大安全区', 'E_VIEWPORT_INVALID', 'E_CONTENT_TOO_NARROW']) {
      assert.ok(names.includes(need) || ROWS.some((row) => row.degenerate === need),
        `测试表缺行：${need}`);
    }
    assert.ok(ROWS.length >= 20, `表至少 20 行，实际 ${ROWS.length}`);
    assert.ok(ROWS.some((row) => row.glyphCount === 1) && ROWS.some((row) => row.glyphCount === 2),
      '1 / 2 / 3 个字形三种表面都要覆盖');
  });

  for (const row of ROWS) {
    test(`A2 ${row.name}`, () => {
      const result = glyphRailLayout(inputOf(row));

      if (row.degenerate !== undefined) {
        // ---- 退化行：明确 typed，图标轨不画，页面不出现负尺寸 ----
        assert.equal(result.ok, false, `${row.name} 必须是退化结论`);
        assert.equal(result.reason, row.degenerate, `${row.name} 的 typed 原因`);
        assert.equal(result.railVisible, false, '退化时不许渲染图标轨');
        assert.deepEqual(result.railRect, { x: 0, y: 0, width: 0, height: 0 },
          '退化时 railRect 必须是零盒（不许悄悄压在页面上）');
        assert.ok(result.contentRect.width >= 0 && result.contentRect.height >= 0,
          '退化时页面尺寸不得为负');
        assert.equal(rectsIntersect(result.railRect, result.contentRect), false);
        assert.equal(result.gutter, 0, '退化时没有保留槽');
        return;
      }

      // ---- 可用行：六条不变量逐条断言 ----
      const { railRect: rail, contentRect: content, glyphSize, gap, glyphCount } = result;
      const top = row.inset === undefined ? 0 : row.inset.top;
      const bottom = row.inset === undefined ? 0 : row.inset.bottom;
      const left = row.inset === undefined ? 0 : row.inset.left;
      const right = row.inset === undefined ? 0 : row.inset.right;
      const safeRight = row.w - right;
      const safeBottom = row.h - bottom;
      // 0.1vp 取整容差（远小于一个物理像素）：只用于「落在安全区内」的边界比较
      const EPS = 0.11;

      assert.equal(result.ok, true, `${row.name} 应当可用，实际 ${result.reason}`);
      assert.equal(result.reason, row.reason, `${row.name} 的模式`);
      assert.equal(result.railVisible, true);

      // 不变量 1：图标轨与页面**不相交**（这是本次缺陷的核心）
      assert.equal(rectsIntersect(rail, content), false,
        `${row.name}: rail=${JSON.stringify(rail)} 与 content=${JSON.stringify(content)} 相交`);

      // 不变量 5：两者之间恰好一个 gap（不是贴边、不是重叠）
      assert.equal(content.x, rail.x + rail.width + gap,
        `${row.name}: content 左边缘必须等于 rail 右边缘 + gap`);
      assert.ok(gap > 0);
      assert.ok(content.x - (rail.x + rail.width) > 0, `${row.name}: 必须有正的间隙`);

      // 不变量 2：rail 完全在安全区内
      assert.ok(rail.x >= left - EPS, `${row.name}: rail.x=${rail.x} < safeLeft=${left}`);
      assert.ok(rail.x + rail.width <= safeRight + EPS, `${row.name}: rail 右边越出安全区`);
      assert.ok(rail.y >= top - EPS, `${row.name}: rail.y=${rail.y} < safeTop=${top}`);
      assert.ok(rail.y + rail.height <= safeBottom + EPS, `${row.name}: rail 底部越出安全区`);

      // 不变量 3：触控目标 ≥ 44vp，且 rail 宽度就是字形宽度
      assert.ok(glyphSize >= GLYPH_TOUCH_MIN_VP,
        `${row.name}: 字形 ${glyphSize}vp < 44vp 触控硬下限`);
      assert.ok(glyphSize <= GLYPH_MAX_VP, `${row.name}: 字形 ${glyphSize}vp 超过上限`);
      assert.equal(rail.width, glyphSize, `${row.name}: rail 宽必须等于字形边长`);
      assert.ok(gap >= GAP_MIN_VP && gap <= GAP_MAX_VP, `${row.name}: gap 越界`);
      assert.equal(glyphCount, row.glyphCount === undefined ? MAX_GLYPH_COUNT : row.glyphCount);

      // rail 高度 = n 个字形 + (n−1) 个 gap
      assert.equal(rail.height, glyphCount * glyphSize + (glyphCount - 1) * gap,
        `${row.name}: rail 高度必须由字形数与 gap 派生`);

      // 不变量 4：页面有正面积，并且也在安全区内
      assert.ok(content.width > 0, `${row.name}: 页面宽必须为正，实际 ${content.width}`);
      assert.ok(content.height > 0, `${row.name}: 页面高必须为正，实际 ${content.height}`);
      assert.ok(content.width >= MIN_CONTENT_WIDTH_VP, `${row.name}: 页面宽低于下限却未退化`);
      assert.ok(content.height >= MIN_CONTENT_HEIGHT_VP, `${row.name}: 页面高低于下限却未退化`);
      assert.ok(content.x >= left - EPS, `${row.name}: 页面左边缘越出安全区`);
      assert.ok(content.x + content.width <= safeRight + EPS, `${row.name}: 页面右边缘越出安全区`);
      assert.ok(content.y >= top - EPS, `${row.name}: 页面顶边越出安全区`);
      assert.ok(content.y + content.height <= safeBottom + EPS, `${row.name}: 页面底边越出安全区`);

      // 不变量 6：保留槽自洽（= 字形宽 + 两个 gap）
      assert.equal(result.gutter, content.x - left, `${row.name}: gutter 定义`);
      assert.equal(result.gutter, glyphSize + 2 * gap, `${row.name}: gutter = glyph + 2×gap`);
      assert.ok(result.gutter > glyphSize, `${row.name}: 保留槽必须比字形本身更宽（含两侧间隙）`);

      // 竖直居中（±0.11vp：1 位小数取整）
      const safeH = row.h - top - bottom;
      assert.ok(Math.abs(rail.y - (top + (safeH - rail.height) / 2)) <= EPS,
        `${row.name}: rail 必须在安全区内竖直居中`);
    });
  }
});

describe('B. 窄屏规则与阈值', () => {
  test('B1 阈值 480vp：更窄取硬下限（44vp / gap 4），阈值本身走宽屏', () => {
    assert.equal(NARROW_VIEWPORT_VP, 480);
    const narrow = glyphRailLayout(inputOf({ w: NARROW_VIEWPORT_VP - 1, h: 800, glyphSize: 56, gap: 12 }));
    assert.equal(narrow.reason, 'narrow');
    assert.equal(narrow.glyphSize, GLYPH_TOUCH_MIN_VP);
    assert.equal(narrow.gap, GAP_MIN_VP);
    assert.equal(narrow.gutter, GLYPH_TOUCH_MIN_VP + 2 * GAP_MIN_VP, '窄屏保留槽必须压到最小');

    const wide = glyphRailLayout(inputOf({ w: NARROW_VIEWPORT_VP, h: 800, glyphSize: 56, gap: 12 }));
    assert.equal(wide.reason, 'ok');
    assert.equal(wide.glyphSize, 56, '宽屏尊重调用方的期望值');
    assert.equal(wide.gap, 12);
    assert.ok(wide.gutter > narrow.gutter, '宽屏槽必须比窄屏槽宽');
  });

  test('B2 期望值越界一律夹紧：0 / 负数 / NaN / 超大都不许落到 44vp 以下或 56vp 以上', () => {
    for (const glyphSize of [0, -10, Number.NaN, Infinity, 1, 1000]) {
      for (const gap of [0, -1, Number.NaN, 1, 1000]) {
        const result = glyphRailLayout({ ...inputOf({ w: 673.7, h: 1077.9 }), glyphSize, gap });
        assert.equal(result.ok, true, `glyphSize=${glyphSize} gap=${gap} 不该退化`);
        assert.ok(result.glyphSize >= GLYPH_TOUCH_MIN_VP, `glyphSize=${glyphSize} → ${result.glyphSize}`);
        assert.ok(result.glyphSize <= GLYPH_MAX_VP);
        assert.ok(result.gap >= GAP_MIN_VP && result.gap <= GAP_MAX_VP);
        assert.equal(rectsIntersect(result.railRect, result.contentRect), false);
      }
    }
    assert.equal(GLYPH_TOUCH_MIN_VP, 44, '44vp 是产品硬约束');
    assert.equal(GLYPH_DEFAULT_VP, 48);
    assert.equal(GAP_DEFAULT_VP, 4);
  });

  test('B3 字形个数规范化：非有限 → 1，越界夹到 [1, 3]', () => {
    for (const [raw, want] of [[Number.NaN, 1], [0, 1], [-3, 1], [1, 1], [2, 2], [3, 3], [9, 3],
      [2.4, 2]]) {
      const result = glyphRailLayout({ ...inputOf({ w: 673.7, h: 1077.9 }), glyphCount: raw });
      assert.equal(result.glyphCount, want, `glyphCount=${raw}`);
      assert.equal(MAX_GLYPH_COUNT, 3);
    }
  });
});

describe('C. 稠密扫描：宽度连续变化时不允许出现「静默重叠」', () => {
  test('C1 296..1400vp 逐 1vp：全部可用且不重叠（含窄屏规则的内外两侧）', () => {
    let usable = 0;
    for (let w = 296; w <= 1400; w += 1) {
      for (const glyphCount of [1, 2, 3]) {
        const result = glyphRailLayout({
          viewportW: w, viewportH: 800,
          safeAreaTop: 0, safeAreaBottom: 0, safeAreaLeft: 0, safeAreaRight: 0,
          glyphSize: GLYPH_DEFAULT_VP, gap: GAP_DEFAULT_VP, glyphCount
        });
        assert.equal(rectsIntersect(result.railRect, result.contentRect), false,
          `w=${w} n=${glyphCount} 出现重叠`);
        assert.equal(result.ok, true, `w=${w} n=${glyphCount} 不该退化（${result.reason}）`);
        usable++;
        assert.ok(result.contentRect.width > 0 && result.railRect.width >= GLYPH_TOUCH_MIN_VP);
        assert.equal(result.contentRect.x, result.railRect.x + result.railRect.width + result.gap);
      }
    }
    assert.equal(usable, (1400 - 296 + 1) * 3, `扫描行数对不上：${usable}`);
  });

  test('C2 高度 100..1400vp 逐 10vp：横屏矮窗不许把 rail 顶出安全区', () => {
    for (let h = 100; h <= 1400; h += 10) {
      const result = glyphRailLayout({
        viewportW: 800, viewportH: h,
        safeAreaTop: 24, safeAreaBottom: 12, safeAreaLeft: 8, safeAreaRight: 8,
        glyphSize: GLYPH_DEFAULT_VP, gap: GAP_DEFAULT_VP, glyphCount: 3
      });
      assert.equal(rectsIntersect(result.railRect, result.contentRect), false, `h=${h}`);
      if (!result.ok) {
        assert.equal(result.railVisible, false, `h=${h} 退化却不报 railVisible=false`);
        continue;
      }
      assert.ok(result.railRect.y >= 24 - 0.11, `h=${h}: rail 顶出安全区`);
      assert.ok(result.railRect.y + result.railRect.height <= h - 12 + 0.11,
        `h=${h}: rail 底部越出安全区`);
    }
  });
});

describe('D. rectsIntersect：只贴边不算相交（用严格的内部交集）', () => {
  const r = (x, y, width, height) => ({ x, y, width, height });

  test('D1 真重叠 / 贴边 / 分离 / 零面积四类', () => {
    assert.equal(rectsIntersect(r(0, 0, 10, 10), r(5, 5, 10, 10)), true);
    assert.equal(rectsIntersect(r(0, 0, 10, 10), r(10, 0, 10, 10)), false, '贴右边不算相交');
    assert.equal(rectsIntersect(r(0, 0, 10, 10), r(0, 10, 10, 10)), false, '贴底边不算相交');
    assert.equal(rectsIntersect(r(0, 0, 10, 10), r(11, 0, 10, 10)), false);
    assert.equal(rectsIntersect(r(0, 0, 0, 0), r(0, 0, 10, 10)), false, '零面积永远不相交');
    assert.equal(rectsIntersect(r(0, 0, 10, 10), r(9.9, 0, 1, 1)), true);
  });
});

describe('E. 模型文件自身的诚实性', () => {
  test('E1 零 SDK / 零 UI import（只做纯换算，Node 可直接跑）', () => {
    assert.equal(/from\s+'@/.test(MODEL), false, '模型不得 import SDK / kit');
    assert.equal(/\$r\(/.test(MODEL), false, '模型不得出现资源引用');
  });

  test('E2 阈值与下限都具名导出（组件不得再写第二份数字）', () => {
    for (const name of ['GLYPH_TOUCH_MIN_VP', 'GLYPH_DEFAULT_VP', 'GLYPH_MAX_VP', 'GAP_MIN_VP',
      'GAP_DEFAULT_VP', 'GAP_MAX_VP', 'NARROW_VIEWPORT_VP', 'MIN_CONTENT_WIDTH_VP',
      'MIN_CONTENT_HEIGHT_VP', 'MAX_GLYPH_COUNT']) {
      assert.equal(MODEL.includes(`export const ${name}`), true, `模型必须导出 ${name}`);
    }
    assert.ok(MIN_CONTENT_WIDTH_VP > 0 && MIN_CONTENT_HEIGHT_VP > 0);
  });
});

describe('F. 源码守卫：页面几何来自模型，不写死数字（改页面前这条是红的）', () => {
  test('F1 页面 import 纯模型（唯一几何来源）', () => {
    assert.match(CODE,
      /import \{[^}]*glyphRailLayout[^}]*\} from '\.\.\/model\/glyphRailLayout';/,
      'RemoteControl.ets 必须从 model/glyphRailLayout 取几何');
    assert.match(CODE, /import type \{[^}]*GlyphRailLayout[^}]*\} from '\.\.\/model\/glyphRailLayout';/,
      '几何结果的类型也必须来自模型');
  });

  test('F2 图标轨的位置 / 尺寸 / 字形尺寸 / 间距全部来自模型结果', () => {
    const rail = blockAfter(CODE, 'Rail() {');
    assert.ok(rail.length > 0, '缺 Rail() builder');
    assert.match(rail, /this\.railLayout\(\)\.railRect\.x/, 'rail 的 x 必须来自模型 railRect');
    assert.match(rail, /this\.railLayout\(\)\.railRect\.y/, 'rail 的 y 必须来自模型 railRect');
    assert.match(rail, /\.position\(\{\s*x: this\.railLayout\(\)\.railRect\.x,\s*y: this\.railLayout\(\)\.railRect\.y\s*\}\)/,
      'rail 必须用模型 rect 做绝对定位');
    assert.match(rail, /\.width\(this\.railLayout\(\)\.glyphSize\)/, '字形宽必须来自模型 glyphSize');
    assert.match(rail, /\.height\(this\.railLayout\(\)\.glyphSize\)/, '字形高必须来自模型 glyphSize');
    assert.match(rail, /space: this\.railLayout\(\)\.gap/, '字形间距必须来自模型 gap');
    assert.equal((rail.match(/\.width\(this\.railLayout\(\)\.glyphSize\)/g) ?? []).length, 3,
      '三个字形都必须用模型的 glyphSize');
    assert.equal(/[0-9]/.test(rail), false, '图标轨里不许出现任何写死的数字（几何 / 尺寸都不许）');
    assert.equal(rail.includes('TOUCH_MIN'), false, '字形尺寸不许再用令牌常量顶替模型结果');
  });

  test('F3 WebView 的盒子来自模型 contentRect（页面右移，永远不在轨道下面）', () => {
    const body = blockAfter(CODE, 'RemoteBody() {');
    assert.ok(body.length > 0, '缺 RemoteBody() builder');
    assert.match(body, /\.width\(this\.railLayout\(\)\.contentRect\.width\)/, 'Web 宽必须来自 contentRect');
    assert.match(body, /\.height\(this\.railLayout\(\)\.contentRect\.height\)/, 'Web 高必须来自 contentRect');
    assert.match(body, /\.position\(\{\s*x: this\.railLayout\(\)\.contentRect\.x,\s*y: this\.railLayout\(\)\.contentRect\.y\s*\}\)/,
      'Web 必须整体右移到 contentRect（保留槽）');
    // Web 自己不许再铺满整屏：铺满就等于又跑到图标轨下面
    const web = body.slice(body.indexOf('Web({ src: this.url'));
    assert.equal(/\.width\('100%'\)/.test(web.slice(0, 400)), false,
      'Web 不得再用 100% 宽度（那会重新压到图标轨下）');
    assert.equal(/\.height\('100%'\)/.test(web.slice(0, 400)), false, 'Web 不得再用 100% 高度');
  });

  test('F4 视口由 onAreaChange 送进模型；图标轨按模型的 railVisible 门控', () => {
    assert.match(CODE, /onAreaChange\(\(_oldValue: Area, newValue: Area\) => \{\s*this\.applyArea\(newValue\);/,
      '根容器必须用 onAreaChange 把真实视口交给页面');
    const applyArea = blockAfter(CODE, 'private applyArea(area: Area): void');
    assert.match(applyArea, /this\.viewportW = width;/, '视口宽必须落到状态');
    assert.match(applyArea, /this\.viewportH = height;/, '视口高必须落到状态');
    const input = blockAfter(CODE, 'private railLayout(): GlyphRailLayout');
    assert.match(input, /glyphRailLayout\(input\)/, '页面必须调用纯模型');
    assert.match(input, /viewportW: this\.viewportW/, '视口宽必须传进模型');
    assert.match(input, /viewportH: this\.viewportH/, '视口高必须传进模型');
    assert.match(input, /glyphCount: this\.railGlyphCount\(\)/, '字形数必须由页面现有的表面状态派生');
    assert.match(CODE, /if \(this\.railLayout\(\)\.railVisible\) \{\s*this\.Rail\(\)\s*\}/,
      '退化（railVisible=false）时不许画图标轨');
  });

  test('F5 页面仍不允许出现我们自己的 chrome（没有为新布局加任何可见东西）', () => {
    for (const banned of ['远程控制', 'Header() {', '标题栏']) {
      assert.equal(CODE.includes(banned), false, `页面不得出现 ${banned}`);
    }
    assert.equal((CODE.match(/this\.Rail\(\)/g) ?? []).length, 1, '图标轨仍只有一处渲染');
    assert.equal((CODE.match(/\.bindSheet\(/g) ?? []).length, 1, '诊断浮层入口不变');
    assert.equal(/[\u4e00-\u9fff]/.test(blockAfter(CODE, 'Rail() {')), false,
      '图标轨仍然零文案（纯字形）');
  });
});
