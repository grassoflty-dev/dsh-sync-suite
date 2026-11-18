// 深色模式（三态）+ 大字号 + 色值收编的静态与纯函数测试。
//
// 前置（必须先编译纯逻辑层，本文件 import 编译产物）：
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
//   node --test apps/arkui-schedule/tools/test/theme.test.mjs
//
// 四类断言：
// 1. **静态扫描**：`entry/src/**/*.ets` 里不许再出现字面色值 / `rgb(` / `Color.Red|White…`，
//    `fontSize(` 不许吃裸数字（这两条是「色值收编」与「字号令牌化」的硬门闸，改回字面量立刻红）；
// 2. **资源一致性**：`base` 与 `dark` 的 `color.json` 键集必须完全一致，且 `COLOR_TOKENS`
//    里的每个语义名两边都有；
// 3. **纯函数边界**：三态归一、主题解析、字号夹取、令牌回落；
// 4. **对比度与布局**：错误红字 ≥4.5:1、网格线/选中框 ≥3:1、二维码白底恒定、
//    「×1.5 不截断」在两条代表性页面上用 `assertNoOverflow` 断言。
//
// 关于注释：静态扫描前会**剥掉注释**——注释里写「旧值 #F1F3F5」属于文档，不参与渲染；
// 剥注释也让「把字面色写进注释绕过检查」失去意义。
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import {
  CANVAS_PAINTS,
  COLOR_TOKENS,
  DARK_FALLBACK,
  FONT_SCALE_LARGE,
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  THEME_MODE_ORDER,
  assertNoOverflow,
  clampFontScale,
  colorToken,
  colorTokenNames,
  contrastRatio,
  estimatedTextWidth,
  hasColorToken,
  layoutFits,
  normalizeThemeMode,
  parseHexColor,
  relativeLuminance,
  resolveTheme,
  scaledFontSize,
  themeModeHint,
  themeModeLabel
} from '../.build/model/theme.js';
import { DEFAULT_PEN_COLOR, PEN_COLORS } from '../.build/model/strokeHistory.js';
import { FONT, FONT_SCALE, LINE_HEIGHT, SPACING, TOUCH_MIN } from '../.build/common/uiTokens.js';

const APP_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ETS_ROOT = join(APP_ROOT, 'entry', 'src');
const BASE_COLORS = join(APP_ROOT, 'entry', 'src', 'main', 'resources', 'base', 'element', 'color.json');
const DARK_COLORS = join(APP_ROOT, 'entry', 'src', 'main', 'resources', 'dark', 'element', 'color.json');

/** 递归收集某目录下全部 `.ets`（路径统一成正斜杠，报错信息跨平台一致）。 */
function listEts(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listEts(full));
    } else if (entry.name.endsWith('.ets')) {
      out.push(full.replace(/\\/g, '/'));
    }
  }
  return out;
}

/** 剥注释（块注释 + 整行行注释）；保留换行数，因此行号与源文件一致。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, '');
}

/** 把匹配结果整理成「文件:行号: 片段」，失败信息直接可定位。 */
function hitsOf(files, pattern) {
  const hits = [];
  for (const file of files) {
    const code = stripComments(readFileSync(file, 'utf8'));
    const lines = code.split('\n');
    for (let index = 0; index < lines.length; index++) {
      const matched = lines[index].match(pattern);
      if (matched !== null) {
        hits.push(`${file.slice(ETS_ROOT.length + 1)}:${index + 1}: ${matched.join(' ')}`);
      }
    }
  }
  return hits;
}

const MAIN_ETS = listEts(join(ETS_ROOT, 'main', 'ets'));
const HARMONY_ETS = listEts(join(ETS_ROOT, 'harmony', 'ets'));
const ALL_ETS = [...MAIN_ETS, ...HARMONY_ETS];

/**
 * 被 `tools/test/handwritingToolbar.test.mjs` **钉住**的字面色（该测试不在本轮可改范围）。
 *
 * :418 要求 insertDeleteCell / pageLabelCell / prevNextCell / railToolButton 里必须出现
 * `'#F…'` 字面量；:653 要求 `const RAIL_BG: string = '#F7F9FB';` 原样存在。
 * 处理办法：浅色档保留字面量、深色档走 `theme.ts` 的 `DARK_FALLBACK`，
 * 于是这里只允许这 6 处，且每一处都必须出现在 `isDarkTheme()` 三元里（RAIL_BG 声明除外）。
 */
const PINNED_HEX = new Map([
  ['#F7F9FB', 1],
  ['#F1F3F5', 2],
  ['#F7F8FA', 3]
]);

// ---------------------------------------------------------------- 1. 静态扫描

describe('色值收编：main 树里不许再写字面色', () => {
  test('没有 #RRGGBB / #AARRGGBB 字面量', () => {
    const hits = hitsOf(MAIN_ETS, /#[0-9A-Fa-f]{6,8}\b/g);
    assert.deepEqual(hits, [], `字面色必须走 $r('app.color.*') 或 theme.ts 的 CANVAS_PAINTS：\n${hits.join('\n')}`);
  });

  test('没有 rgb() / rgba() 字面量', () => {
    const hits = hitsOf(MAIN_ETS, /\brgba?\s*\(/g);
    assert.deepEqual(hits, [], `半透明色也必须给资源令牌（如 scrim / shadow / region_fill）：\n${hits.join('\n')}`);
  });

  test('没有 Color.Red|Blue|Green|Black|White 之类命名色', () => {
    const hits = hitsOf(MAIN_ETS, /Color\.(Red|Blue|Green|Black|White|Gray|Orange|Yellow|Pink|Brown)\b/g);
    assert.deepEqual(hits, [], `命名色不跟主题走，必须换 $r('app.color.*')：\n${hits.join('\n')}`);
  });

  test('harmony 树只剩被 handwritingToolbar.test.mjs 钉住的 6 处字面色', () => {
    const hits = hitsOf(HARMONY_ETS, /#[0-9A-Fa-f]{6,8}\b/g);
    assert.equal(hits.length, 6, `harmony 树字面色数量变了（应为 6 处钉住值）：\n${hits.join('\n')}`);
    const counts = new Map();
    for (const hit of hits) {
      const literal = hit.slice(hit.lastIndexOf(': ') + 2);
      counts.set(literal, (counts.get(literal) ?? 0) + 1);
    }
    assert.deepEqual(counts, PINNED_HEX, `钉住值的集合变了：${JSON.stringify([...counts])}`);
    // 除 RAIL_BG 声明外，每一处都必须在「深色档三元」里（否则深色下会用到浅色字面量）
    const code = stripComments(readFileSync(join(ETS_ROOT, 'harmony', 'ets', 'pages', 'Handwriting.ets'), 'utf8'));
    const lines = code.split('\n');
    for (let index = 0; index < lines.length; index++) {
      if (!/#[0-9A-Fa-f]{6,8}\b/.test(lines[index])) {
        continue;
      }
      const isDeclaration = /const\s+RAIL_BG/.test(lines[index]);
      assert.ok(
        isDeclaration || /isDarkTheme\(\)/.test(lines[index]),
        `Handwriting.ets:${index + 1} 的字面色不在深色三元的浅色档里：${lines[index].trim()}`
      );
    }
  });

  test('harmony 树没有 rgb()/rgba()/命名色残留', () => {
    assert.deepEqual(hitsOf(HARMONY_ETS, /\brgba?\s*\(/g), [], 'harmony 树的 rgba() 必须换成 region_fill / shadow / scrim 令牌');
    // 唯一例外：两个「完成」按钮（品牌蓝实底）的反白字，`handwritingToolbar.test.mjs:240`
    // 要求逐字 `.fontColor(Color.White)`。白色在两套主题下同值，且与 text_inverse 等价，
    // 不会造成深色下不可读，因此保留（如该测试放宽，应改成 $r('app.color.text_inverse')）。
    const named = hitsOf(HARMONY_ETS, /Color\.(Red|Blue|Green|Black|White|Gray|Orange|Yellow)\b/g);
    assert.equal(named.length, 2, `harmony 树命名色只允许 2 处（完成按钮白字）：\n${named.join('\n')}`);
    for (const hit of named) {
      assert.equal(hit.slice(hit.lastIndexOf(': ') + 2), 'Color.White', `只允许 Color.White：${hit}`);
    }
  });

  test('字号：fontSize( 后面不许是裸数字（全 entry/src）', () => {
    const hits = hitsOf(ALL_ETS, /fontSize\s*\(\s*\d/g);
    assert.deepEqual(hits, [], `字号必须走 FONT.* / 派生函数（fp 单位由 fp 本身保证）：\n${hits.join('\n')}`);
  });

  test('主题模型是纯逻辑：model/theme.ts 零 import', () => {
    const source = readFileSync(join(ETS_ROOT, 'main', 'ets', 'model', 'theme.ts'), 'utf8');
    assert.equal(/^\s*import\s/m.test(source), false, 'model/theme.ts 必须零 SDK import（否则 Node 单测跑不了）');
    assert.ok(source.includes('CANVAS_PAINTS'), 'theme.ts 必须是画布绘制色的唯一来源');
  });
});

// ---------------------------------------------------------------- 2. 资源一致性

const pickColors = (file) => {
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  const map = new Map();
  for (const item of doc.color) {
    map.set(item.name, item.value);
  }
  return map;
};

const BASE = pickColors(BASE_COLORS);
const DARK = pickColors(DARK_COLORS);

describe('深色资源：base 与 dark 键集一一对应', () => {
  test('base 与 dark 的键集完全一致（缺哪个就报哪个）', () => {
    const baseOnly = [...BASE.keys()].filter((name) => !DARK.has(name)).sort();
    const darkOnly = [...DARK.keys()].filter((name) => !BASE.has(name)).sort();
    assert.deepEqual(baseOnly, [], `dark/color.json 缺少：${baseOnly.join(', ')}`);
    assert.deepEqual(darkOnly, [], `base/color.json 缺少：${darkOnly.join(', ')}`);
    assert.equal(BASE.size, DARK.size);
  });

  test('语义令牌齐全（canvas / surface_raised / border / grid_line / selection_* / qr_* …）', () => {
    const required = [
      'canvas',
      'surface',
      'surface_raised',
      'text_primary',
      'text_secondary',
      'text_inverse',
      'divider',
      'border',
      'brand',
      'danger',
      'warning',
      'success',
      'selection_fill',
      'selection_stroke',
      'grid_line',
      'qr_light',
      'qr_dark',
      'ink_paper',
      'shadow',
      'region_fill'
    ];
    for (const name of required) {
      assert.ok(BASE.has(name), `base/color.json 缺少令牌 ${name}`);
      assert.ok(DARK.has(name), `dark/color.json 缺少令牌 ${name}`);
    }
  });

  test('COLOR_TOKENS 的每个语义名在 base 与 dark 里都有对应资源', () => {
    for (const name of colorTokenNames()) {
      const resource = COLOR_TOKENS[name];
      const short = resource.slice('app.color.'.length);
      assert.equal(resource, `app.color.${short}`, `令牌 ${name} 的资源名必须是 app.color.*：${resource}`);
      assert.ok(BASE.has(short), `令牌 ${name} 在 base/color.json 里没有 ${short}`);
      assert.ok(DARK.has(short), `令牌 ${name} 在 dark/color.json 里没有 ${short}`);
    }
  });

  test('canvas 与 page_background 是同值别名（两套主题都相等）', () => {
    assert.equal(BASE.get('canvas'), BASE.get('page_background'));
    assert.equal(DARK.get('canvas'), DARK.get('page_background'));
    assert.notEqual(BASE.get('canvas'), DARK.get('canvas'), '深色画布必须与浅色不同');
  });

  test('selection_fill 与 brand_soft 同值（选中底 = 品牌淡底），两套主题都成立', () => {
    assert.equal(BASE.get('selection_fill'), BASE.get('brand_soft'));
    assert.equal(DARK.get('selection_fill'), DARK.get('brand_soft'));
  });

  test('二维码恒为白底黑码（两套主题都不许变）', () => {
    assert.equal(BASE.get('qr_light'), '#FFFFFF');
    assert.equal(DARK.get('qr_light'), '#FFFFFF');
    assert.equal(BASE.get('qr_dark'), '#000000');
    assert.equal(DARK.get('qr_dark'), '#000000');
  });

  test('手写纸面 ink_paper 两套主题恒为白（笔迹颜色是持久化数据）', () => {
    assert.equal(BASE.get('ink_paper'), '#FFFFFF');
    assert.equal(DARK.get('ink_paper'), '#FFFFFF');
    assert.equal(CANVAS_PAINTS.paper, '#FFFFFF');
    assert.equal(CANVAS_PAINTS.mask, CANVAS_PAINTS.paper, '遮白必须与纸面同色，否则框选遮罩会留下灰块');
  });

  test('DARK_FALLBACK 与 dark/color.json 同名令牌一致（钉住的字面量不许和资源漂移）', () => {
    assert.equal(DARK_FALLBACK.chipFill, DARK.get('control_fill_alt'));
    assert.equal(DARK_FALLBACK.railFill, DARK.get('control_fill'));
  });
});

// ---------------------------------------------------------------- 3. 纯函数边界

describe('主题三态：归一 / 解析 / 标签', () => {
  test('THEME_MODE_ORDER 顺序固定为 system, light, dark', () => {
    assert.deepEqual(THEME_MODE_ORDER, ['system', 'light', 'dark']);
  });

  test('normalizeThemeMode 已知值精确匹配', () => {
    assert.equal(normalizeThemeMode('system'), 'system');
    assert.equal(normalizeThemeMode('light'), 'light');
    assert.equal(normalizeThemeMode('dark'), 'dark');
  });

  test('normalizeThemeMode 容忍大小写与空白', () => {
    assert.equal(normalizeThemeMode('  Dark  '), 'dark');
    assert.equal(normalizeThemeMode('LIGHT'), 'light');
    assert.equal(normalizeThemeMode('\tsystem\n'), 'system');
  });

  test('normalizeThemeMode 未知/空/非字符串一律 fail-safe 到 system', () => {
    assert.equal(normalizeThemeMode(''), 'system');
    assert.equal(normalizeThemeMode('   '), 'system');
    assert.equal(normalizeThemeMode('blue'), 'system');
    assert.equal(normalizeThemeMode('dark '), 'dark');
    assert.equal(normalizeThemeMode(undefined), 'system');
    assert.equal(normalizeThemeMode(null), 'system');
    assert.equal(normalizeThemeMode(42), 'system');
  });

  test('resolveTheme：system 跟随系统，light/dark 忽略系统', () => {
    assert.equal(resolveTheme('system', true), 'dark');
    assert.equal(resolveTheme('system', false), 'light');
    assert.equal(resolveTheme('light', true), 'light');
    assert.equal(resolveTheme('light', false), 'light');
    assert.equal(resolveTheme('dark', true), 'dark');
    assert.equal(resolveTheme('dark', false), 'dark');
  });

  test('resolveTheme 对脏入参也返回确定值', () => {
    assert.equal(resolveTheme('nope', true), 'dark');
    assert.equal(resolveTheme('', false), 'light');
  });

  test('每态都有中文标签与一行说明', () => {
    for (const mode of THEME_MODE_ORDER) {
      assert.ok(themeModeLabel(mode).length > 0, `${mode} 缺标签`);
      assert.ok(themeModeHint(mode).length > 0, `${mode} 缺说明`);
    }
    assert.equal(themeModeLabel('system'), '跟随系统');
    assert.equal(themeModeLabel('unknown'), '跟随系统', '未知态按跟随系统展示');
  });
});

describe('字号缩放：夹取与缩放', () => {
  test('常数符合文档（1.0 / 1.6 / 1.5）', () => {
    assert.equal(FONT_SCALE_MIN, 1.0);
    assert.equal(FONT_SCALE_MAX, 1.6);
    assert.equal(FONT_SCALE_LARGE, 1.5);
    assert.deepEqual(FONT_SCALE, { min: 1.0, max: 1.6, large: 1.5 }, 'uiTokens 的 FONT_SCALE 必须与 theme.ts 常数一致');
  });

  test('clampFontScale 夹到 [1.0, 1.6]', () => {
    assert.equal(clampFontScale(1.0), 1.0);
    assert.equal(clampFontScale(1.25), 1.25);
    assert.equal(clampFontScale(1.5), 1.5);
    assert.equal(clampFontScale(1.6), 1.6);
    assert.equal(clampFontScale(0.8), 1.0);
    assert.equal(clampFontScale(2.0), 1.6);
    assert.equal(clampFontScale(9.9), 1.6);
  });

  test('clampFontScale 对 NaN / Infinity / 负数回 1.0', () => {
    assert.equal(clampFontScale(Number.NaN), 1.0);
    assert.equal(clampFontScale(Number.POSITIVE_INFINITY), 1.6);
    assert.equal(clampFontScale(Number.NEGATIVE_INFINITY), 1.0);
    assert.equal(clampFontScale(-2), 1.0);
    assert.equal(clampFontScale(0), 1.0);
  });

  test('scaledFontSize 按夹取后的倍率放大', () => {
    assert.equal(scaledFontSize(16, 1.0, 14, 40), 16);
    assert.equal(scaledFontSize(16, 1.5, 14, 40), 24);
    assert.equal(scaledFontSize(14, 1.6, 14, 40), 22.400000000000002);
  });

  test('scaledFontSize 上下限夹取（min/max 反了也自动交换）', () => {
    assert.equal(scaledFontSize(20, 1.6, 14, 28), 28, '32 应夹到上限 28');
    assert.equal(scaledFontSize(10, 1.0, 14, 28), 14, '10 应抬到下限 14');
    assert.equal(scaledFontSize(20, 1.6, 28, 14), 28, 'min>max 时交换后结果仍合法');
  });

  test('scaledFontSize 对非法入参退化为下限而不是 NaN', () => {
    assert.equal(scaledFontSize(Number.NaN, 1.0, 14, 28), 14);
    assert.equal(scaledFontSize(-5, 1.0, 14, 28), 14);
    assert.equal(Number.isNaN(scaledFontSize(16, Number.NaN, 14, 28)), false);
  });
});

describe('资源令牌：colorToken 与 COLOR_TOKENS', () => {
  test('已知语义名返回完整资源名', () => {
    assert.equal(colorToken('canvas'), 'app.color.canvas');
    assert.equal(colorToken('text_primary'), 'app.color.text_primary');
    assert.equal(colorToken('danger'), 'app.color.danger');
  });

  test('驼峰 / 连字符 / 大写都能归一', () => {
    assert.equal(colorToken('surfaceRaised'), 'app.color.surface_raised');
    assert.equal(colorToken('surface-raised'), 'app.color.surface_raised');
    assert.equal(colorToken('  SURFACE_RAISED '), 'app.color.surface_raised');
  });

  test('未知 / 空 / 非字符串 fail-safe 回落到 canvas', () => {
    assert.equal(colorToken('no_such_token'), 'app.color.canvas');
    assert.equal(colorToken(''), 'app.color.canvas');
    assert.equal(colorToken('   '), 'app.color.canvas');
    assert.equal(colorToken(undefined), 'app.color.canvas');
    assert.equal(hasColorToken('no_such_token'), false);
    assert.equal(hasColorToken('canvas'), true);
  });
});

// ---------------------------------------------------------------- 4. 对比度

const contrastOf = (palette, foreground, background) =>
  contrastRatio(palette.get(foreground), palette.get(background));

describe('对比度：错误红字 / 网格线 / 选中框 / 二维码 / 纸面', () => {
  test('danger 在浅色与深色下对 canvas 都 ≥ 4.5:1', () => {
    const light = contrastOf(BASE, 'danger', 'canvas');
    const dark = contrastOf(DARK, 'danger', 'canvas');
    assert.ok(light >= 4.5, `浅色 danger/canvas = ${light.toFixed(2)}，需 ≥ 4.5`);
    assert.ok(dark >= 4.5, `深色 danger/canvas = ${dark.toFixed(2)}，需 ≥ 4.5`);
  });

  test('danger 对 surface（卡片底）也 ≥ 4.5:1', () => {
    assert.ok(contrastOf(BASE, 'danger', 'surface') >= 4.5, '浅色 danger/surface 不足 4.5');
    assert.ok(contrastOf(DARK, 'danger', 'surface') >= 4.5, '深色 danger/surface 不足 4.5');
  });

  test('正文与主文字在两套主题下都 ≥ 4.5:1（可读性底线）', () => {
    assert.ok(contrastOf(BASE, 'text_primary', 'canvas') >= 4.5);
    assert.ok(contrastOf(DARK, 'text_primary', 'canvas') >= 4.5);
    assert.ok(contrastOf(BASE, 'text_primary', 'surface') >= 4.5);
    assert.ok(contrastOf(DARK, 'text_primary', 'surface') >= 4.5);
  });

  test('表格网格线 grid_line 在两套主题下都 ≥ 3:1（非文本对比底线）', () => {
    const light = contrastOf(BASE, 'grid_line', 'canvas');
    const dark = contrastOf(DARK, 'grid_line', 'canvas');
    assert.ok(light >= 3.0, `浅色 grid_line/canvas = ${light.toFixed(2)}，需 ≥ 3.0`);
    assert.ok(dark >= 3.0, `深色 grid_line/canvas = ${dark.toFixed(2)}，需 ≥ 3.0`);
  });

  test('选中态蓝框 selection_stroke 对 selection_fill 在浅/深下都可辨', () => {
    assert.ok(contrastOf(BASE, 'selection_stroke', 'selection_fill') >= 3.0, '浅色选中框对比不足');
    assert.ok(contrastOf(DARK, 'selection_stroke', 'selection_fill') >= 3.0, '深色选中框对比不足');
    assert.ok(contrastOf(BASE, 'selection_stroke', 'canvas') >= 3.0);
    assert.ok(contrastOf(DARK, 'selection_stroke', 'canvas') >= 3.0);
  });

  test('二维码：qr_dark/qr_light ≥ 7:1（扫得出来）', () => {
    assert.ok(contrastOf(BASE, 'qr_dark', 'qr_light') >= 7);
    assert.ok(contrastOf(DARK, 'qr_dark', 'qr_light') >= 7);
  });

  test('手写纸面：默认墨色与纸面 ≥ 4.5:1，纸面网格 ≥ 4.5:1（两套主题同值）', () => {
    const ink = contrastRatio(DEFAULT_PEN_COLOR, CANVAS_PAINTS.paper);
    assert.ok(ink >= 4.5, `默认墨色 / 纸面 = ${ink.toFixed(2)}，需 ≥ 4.5`);
    const grid = contrastRatio(CANVAS_PAINTS.grid, CANVAS_PAINTS.paper);
    assert.ok(grid >= 4.5, `纸面网格 / 纸面 = ${grid.toFixed(2)}，需 ≥ 4.5（深色下仍画在白纸上）`);
    for (const color of PEN_COLORS) {
      assert.ok(contrastRatio(color, CANVAS_PAINTS.paper) >= 3.0, `墨色 ${color} 在白纸上对比不足`);
    }
  });

  test('品牌按钮上的反白字 ≥ 3:1（大字号按钮的可读底线）', () => {
    assert.ok(contrastOf(BASE, 'text_inverse', 'brand') >= 3.0);
    assert.ok(contrastOf(DARK, 'text_inverse', 'brand') >= 3.0);
  });

  test('relativeLuminance / parseHexColor 的边界', () => {
    assert.equal(parseHexColor('#FFF').length, 3);
    assert.deepEqual(parseHexColor('#FFFFFF'), [255, 255, 255]);
    assert.deepEqual(parseHexColor('#80182431'), [24, 36, 49], '#AARRGGBB 忽略 alpha');
    assert.equal(parseHexColor('FFFFFF'), null);
    assert.equal(parseHexColor('#GGGGGG'), null);
    assert.equal(parseHexColor('#12345'), null);
    assert.equal(relativeLuminance('#FFFFFF'), 1);
    assert.equal(relativeLuminance('#000000'), 0);
    assert.equal(relativeLuminance('not-a-color'), 0, '非法色按最暗处理，不让对比度变成 NaN');
    assert.ok(contrastRatio('#FFFFFF', '#FFFFFF') === 1);
  });
});

// ---------------------------------------------------------------- 5. 大字号布局

/**
 * 文本宽度估算（`estimatedTextWidth` 的口径）：**字宽 ≈ 字号 × 0.6 × 字符数**。
 * 这是估算不是排版引擎，但 ×1.5 的增量是 +50%，远大于 ±15% 的估算误差，足够判定「会不会挤爆」。
 */
const rowWidth = (text, fontSp, scale) => estimatedTextWidth(text, fontSp, scale);

/** Index 列表行：勾选 40 + 标题（弹性，最小 120）+ 删除（固定）= 窄屏平板内容宽 343vp。 */
const INDEX_ROW_WIDTH = 343;
const INDEX_ROW_ITEMS = (scale) => [
  { width: TOUCH_MIN },
  {
    width: rowWidth('把今天的三份会议纪要整理成周报并发给王工和张工确认后归档', FONT.body, scale),
    flexible: true,
    minWidth: 120
  },
  { width: rowWidth('删除', FONT.caption, scale) + 2 * SPACING.sm }
];

/** Settings 表单行：标签（弹性，最小 96）+ 三态片（固定 3×56 + 2×4）。 */
const SETTINGS_ROW_WIDTH = 343;
const SETTINGS_ROW_ITEMS = (scale) => [
  { width: rowWidth('深色模式', FONT.body, scale), flexible: true, minWidth: 96 },
  { width: 3 * 56 + 2 * SPACING.xs }
];

describe('大字号：×1.0 与 ×1.5 下两条代表性页面行都不溢出', () => {
  test('Index 列表行在 scale=1.0 放得下（固定项 + 最小宽 + 间距 ≤ 343vp）', () => {
    const report = assertNoOverflow({ availableWidth: INDEX_ROW_WIDTH, items: INDEX_ROW_ITEMS(1.0), gap: SPACING.sm });
    assert.equal(report.fits, true, `scale=1.0 溢出 ${report.overflowBy.toFixed(1)}vp`);
    assert.ok(report.flexibleWidth >= 120, `标题列只剩 ${report.flexibleWidth.toFixed(1)}vp，低于 120vp 下限`);
  });

  test('Index 列表行在 scale=1.5 仍放得下（标题靠 maxLines+省略号让位）', () => {
    const report = assertNoOverflow({ availableWidth: INDEX_ROW_WIDTH, items: INDEX_ROW_ITEMS(1.5), gap: SPACING.sm });
    assert.equal(report.fits, true, `scale=1.5 溢出 ${report.overflowBy.toFixed(1)}vp`);
    assert.ok(report.flexibleWidth >= 120);
  });

  test('Index 列表行：不省略时 ×1.5 会超宽（证明省略号是必需的，不是装饰）', () => {
    const items = INDEX_ROW_ITEMS(1.5);
    const gaps = SPACING.sm * (items.length - 1);
    const required = items.reduce((sum, item) => sum + item.width, 0) + gaps;
    assert.ok(required > INDEX_ROW_WIDTH, `理想宽度 ${required.toFixed(1)}vp 应超过 ${INDEX_ROW_WIDTH}vp`);
  });

  test('Settings 表单行在 scale=1.0 与 1.5 都放得下', () => {
    for (const scale of [1.0, FONT_SCALE_LARGE]) {
      const report = assertNoOverflow({
        availableWidth: SETTINGS_ROW_WIDTH,
        items: SETTINGS_ROW_ITEMS(scale),
        gap: SPACING.sm
      });
      assert.equal(report.fits, true, `scale=${scale} 溢出 ${report.overflowBy.toFixed(1)}vp`);
      assert.ok(report.flexibleWidth >= 96, `标签列只剩 ${report.flexibleWidth.toFixed(1)}vp`);
    }
  });

  test('Settings 表单行：三态片固定宽在 ×1.5 下仍守住（不被压缩）', () => {
    const chips = SETTINGS_ROW_ITEMS(FONT_SCALE_LARGE)[1].width;
    assert.ok(chips > 0);
    assert.ok(3 * 56 + 2 * SPACING.xs === chips, '三态片总宽 = 3×56 + 2×4');
  });

  test('layoutFits 朴素版：文本 + 间距 ≤ 可用宽', () => {
    assert.equal(layoutFits(100, [40, 40], [8]), true);
    assert.equal(layoutFits(100, [40, 40], [8, 8]), true);
    assert.equal(layoutFits(80, [40, 40], [8]), false);
    assert.equal(layoutFits(96, [40, 40], [8, 8]), true, '恰好 96 不应判溢出');
    assert.equal(layoutFits(0, [], []), true);
    assert.equal(layoutFits(Number.NaN, [10], []), false);
    assert.equal(layoutFits(100, [Number.NaN, 10], []), true, 'NaN 宽度按 0 计');
  });

  test('assertNoOverflow 的溢出量与容差', () => {
    const tight = assertNoOverflow({ availableWidth: 100, items: [{ width: 60 }, { width: 50 }], gap: 0 });
    assert.equal(tight.fits, false);
    assert.equal(tight.overflowBy, 10);
    const edge = assertNoOverflow({ availableWidth: 100, items: [{ width: 50 }, { width: 50 }], gap: 0 });
    assert.equal(edge.fits, true, '100/100 正好放下');
    const flexible = assertNoOverflow({
      availableWidth: 100,
      items: [{ width: 500, flexible: true, minWidth: 40 }],
      gap: 0
    });
    assert.equal(flexible.fits, true, '弹性项只按最小宽算');
    assert.equal(flexible.flexibleWidth, 100);
  });

  test('两条代表性页面的源码里确实写了 maxLines + 省略号', () => {
    const row = readFileSync(join(ETS_ROOT, 'main', 'ets', 'components', 'RecordRow.ets'), 'utf8');
    assert.match(row, /\.maxLines\(2\)/, 'Index 列表行标题必须 maxLines(2)');
    assert.match(row, /TextOverflow\.Ellipsis/, 'Index 列表行标题必须省略号收尾');

    const settings = readFileSync(join(ETS_ROOT, 'main', 'ets', 'pages', 'Settings.ets'), 'utf8');
    const themeRow = settings.slice(settings.indexOf('ThemeRow() {'), settings.indexOf('AboutGroup() {'));
    assert.ok(themeRow.length > 0, 'Settings 必须渲染 ThemeRow（深色模式行）');
    assert.match(themeRow, /\.maxLines\(1\)/, '表单行标签必须 maxLines(1)');
    assert.match(themeRow, /TextOverflow\.Ellipsis/, '表单行标签必须省略号收尾');
    assert.match(themeRow, /constraintSize\(\{ minWidth: THEME_CHIP_MIN_WIDTH \}\)/, '三态片只守下限宽，不写死宽');
  });

  test('字形与行高同档放大（避免大字号压字）', () => {
    for (const level of ['title', 'body', 'caption']) {
      assert.ok(LINE_HEIGHT[level] > FONT[level], `${level} 行高必须大于字号`);
    }
  });
});

// ---------------------------------------------------------------- 6. 接线（防止「模型有了但没接上」）

describe('接线：三态设置真的落到存储与 ColorMode', () => {
  const ENTRY = readFileSync(join(ETS_ROOT, 'main', 'ets', 'entryability', 'EntryAbility.ets'), 'utf8');
  const STORE = readFileSync(join(ETS_ROOT, 'main', 'ets', 'services', 'settingsStore.ets'), 'utf8');
  const SETTINGS = readFileSync(join(ETS_ROOT, 'main', 'ets', 'pages', 'Settings.ets'), 'utf8');
  const APPLY = readFileSync(join(ETS_ROOT, 'main', 'ets', 'common', 'themeApply.ets'), 'utf8');

  test('EntryAbility 启动时按持久化值设置 ColorMode', () => {
    assert.match(ENTRY, /applyThemeMode\(this\.context, settings\.themeMode\)/, '启动时必须应用已保存的三态');
    assert.match(ENTRY, /settingsStore\.load\(\)/);
  });

  test('system 档必须用 COLOR_MODE_NOT_SET（否则系统切深色不再跟随）', () => {
    assert.match(APPLY, /COLOR_MODE_NOT_SET/, 'system 必须传 COLOR_MODE_NOT_SET');
    assert.match(APPLY, /COLOR_MODE_LIGHT/);
    assert.match(APPLY, /COLOR_MODE_DARK/);
    assert.match(APPLY, /normalizeThemeMode\(mode\)/, '三态必须先归一再用');
  });

  test('settingsStore 只加 themeMode 一个键，且读写成对', () => {
    const keys = [...STORE.matchAll(/const\s+(KEY_THEME_MODE)\s*:\s*string\s*=\s*'([^']+)'\s*;/g)];
    assert.equal(keys.length, 1, 'themeMode 只能有一个存储键');
    assert.equal(keys[0][2], 'themeMode');
    assert.match(STORE, /prefs\.get\(KEY_THEME_MODE/, 'load() 必须读取 themeMode');
    assert.match(STORE, /prefs\.put\(KEY_THEME_MODE/, 'save() 必须写入 themeMode');
    assert.match(STORE, /themeMode: normalizeThemeMode\(themeMode\)/, '读到的值必须归一后再返回');
  });

  test('设置页：三态片点击即生效（setColorMode + 落盘），失败回退', () => {
    assert.match(SETTINGS, /applyThemeMode\(context, next\);/, '切换必须立刻调用 setColorMode');
    assert.match(SETTINGS, /const patch: SettingsPatch = \{ themeMode: next \};/, '切换必须落盘');
    assert.match(SETTINGS, /this\.themeMode = previous;/, '落盘失败要回退界面');
    assert.match(SETTINGS, /THEME_MODE_ORDER/, '三态顺序必须来自 theme.ts，不许页面另写数组');
  });

  test('页面不许把资源名当普通字符串传（必须写在 $r() 里）', () => {
    // 正常写法是 $r('app.color.x')；这里抓「没被 $r( 包起来的 'app.color.x'」。
    const files = [...MAIN_ETS, ...HARMONY_ETS];
    const hits = [];
    for (const file of files) {
      const code = stripComments(readFileSync(file, 'utf8'));
      const lines = code.split('\n');
      for (let index = 0; index < lines.length; index++) {
        const pattern = /(^|[^$r(])['"]app\.color\.[a-z_]+['"]/g;
        if (pattern.test(lines[index]) && !/\$r\('app\.color\./.test(lines[index])) {
          hits.push(`${file.slice(ETS_ROOT.length + 1)}:${index + 1}: ${lines[index].trim()}`);
        }
      }
    }
    assert.deepEqual(hits, [], `资源名必须写在 $r() 里：\n${hits.join('\n')}`);
  });
});
