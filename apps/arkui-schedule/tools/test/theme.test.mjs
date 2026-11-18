// 深色模式（三态）+ 大字号 + 色值收编的静态与纯函数测试。
//
// 前置（必须先编译纯逻辑层，本文件 import 编译产物）：
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
//   node --test apps/arkui-schedule/tools/test/theme.test.mjs
//
// 四类断言：
// 1. **目录级预算 + 语义约束**（`tools/test/helpers/colorGate.mjs`）：字面色值按**目录**给额度，
//    并按**上下文形态**放行（`isDarkTheme() ? 深色令牌 : '浅色'` 的假分支、常量对象字面量、
//    `backgroundColor(...)` 的参数位……），另加 `fontSize(` 不许吃裸数字（字号令牌化）；
// 2. **资源一致性**：`base` 与 `dark` 的 `color.json` 键集必须完全一致，且 `COLOR_TOKENS`
//    里的每个语义名两边都有；
// 3. **纯函数边界**：三态归一、主题解析、字号夹取、令牌回落；
// 4. **对比度与布局**：错误红字 ≥4.5:1、网格线/选中框 ≥3:1、二维码白底恒定、
//    「×1.5 不截断」在两条代表性页面上用 `assertNoOverflow` 断言。
//
// 为什么不再是「文件:行号锚点」白名单：A1（手写页去重）与 A2（设置页拆 section）两次重构里，
// 颜色一个都没变，但豁免表里的 `{ file, anchor }` 全部对不上，门闸整片打红。位置是重构的产物，
// 不该当契约——现在只看「目录内总计数」与「上下文形态」，文件怎么拆/怎么挪都不红。
//
// 关于注释：静态扫描前会**剥掉注释**——注释里写「旧值 #F1F3F5」属于文档，不参与渲染；
// 剥注释也让「把字面色写进注释绕过检查」失去意义。
//
// 关于工作区状态：覆盖层（`tools/overlay.mjs apply`）会把 harmony 树复制进 main 树，
// 那时 main 里会凭空多出 5 处 hex、透明色被数两遍——门闸先断言「覆盖层已还原」，
// 免得把「工作区没 restore」误读成「代码写死了色值」（2026-11-18 的 4 条红就是这么来的）。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { before, describe, test } from 'node:test';
import { readAboutSection, readSettingsSources } from './settingsSources.mjs';
import {
  COLOR_BUDGET,
  PINNED_HEX_VALUES,
  bucketFiles,
  budgetViolations,
  collectColorHits,
  countsOf,
  detectColorLiterals,
  formatHit,
  shapeViolations
} from './helpers/colorGate.mjs';
import {
  OVERLAY_RESIDUE_MESSAGE,
  listFiles,
  platformOverlayApplied,
  stripComments
} from './helpers/etsSource.mjs';

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
import { requireOverlayRestored } from './guard.mjs';

// 构建期 overlay 生效时，本文件的源码扫描结论无意义 → 硬失败（不跳过、不自动 restore）。
requireOverlayRestored("theme.test.mjs");

const APP_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ETS_ROOT = join(APP_ROOT, 'entry', 'src');
const BASE_COLORS = join(APP_ROOT, 'entry', 'src', 'main', 'resources', 'base', 'element', 'color.json');
const DARK_COLORS = join(APP_ROOT, 'entry', 'src', 'main', 'resources', 'dark', 'element', 'color.json');

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

const MAIN_ETS = listFiles(join(ETS_ROOT, 'main', 'ets'), ['.ets']);
const HARMONY_ETS = listFiles(join(ETS_ROOT, 'harmony', 'ets'), ['.ets', '.ts']);
const ALL_ETS = [...MAIN_ETS, ...HARMONY_ETS];

// ---------------------------------------------------------------- 1. 目录预算 + 语义约束
//
// 旧形态是 `WHITELIST = [{ file, anchor, kind }]`：豁免精确到「这个文件的这一行里出现这段文本」。
// 它挡住了「随手塞色值」，但也把**位置**当成了契约——A1 / A2 两次拆分里颜色一个都没变，
// 只因为代码搬了家（行号变了、文件变了），四条断言同时红，排查成本远大于它挡住的收益。
//
// 新形态分两层，都不看位置：
//   1. 目录级预算：`COLOR_BUDGET` 里每个目录允许几处，只看**总计数**；
//   2. 语义形态：允许留存的每一处，必须长在明确允许的上下文里（三元假分支 / 常量字面量 /
//      调用参数位），落在形态之外的新字面色直接失败。
// 计数常量是实测值（见 `colorGate.mjs` 每行的「实测」注释）。

describe('色值收编：目录级预算 + 语义形态（硬门闸）', () => {
  // 覆盖层残留时 main 树是 harmony 的副本，下面每条预算都会假红——先把这条红讲清楚，
  // 而不是让人以为「代码里又写死了色值」。
  before(() => {
    assert.equal(platformOverlayApplied(), false, OVERLAY_RESIDUE_MESSAGE);
  });

  test('预算表自身可用：每个目录都能扫到文件、互不重叠、限额是非负整数', () => {
    assert.ok(COLOR_BUDGET.length >= 4, '预算表至少覆盖 main UI / main model / main common / harmony 四棵树');
    const owned = new Map();
    for (const bucket of COLOR_BUDGET) {
      const files = bucketFiles(bucket);
      assert.ok(files.length > 0, `${bucket.label} 一个文件都没扫到（目录写错了？预算会变成空过）`);
      for (const [kind, limit] of Object.entries(bucket.limits)) {
        assert.equal(Number.isInteger(limit) && limit >= 0, true, `${bucket.label} 的 ${kind} 限额必须是非负整数`);
      }
      for (const file of files) {
        assert.equal(owned.has(file), false, `${file} 同时落在 ${owned.get(file)} 与 ${bucket.label} 两个桶里（会重复计数）`);
        owned.set(file, bucket.label);
      }
    }
  });

  test('目录预算：没有预算外的色值字面量（hex 3/4/6/8、rgb/hsl、Color.<Name>、Color(0x…)、拼接）', (t) => {
    const hits = collectColorHits();
    assert.ok(hits.length > 0, '扫描一个都没扫到，说明目录集合或正则坏了');
    const measured = COLOR_BUDGET.map((bucket) => `${bucket.label} → ${JSON.stringify(countsOf(hits, bucket.key))}`);
    t.diagnostic(`实测计数\n${measured.join('\n')}`);
    const over = budgetViolations(hits);
    assert.deepEqual(over, [], `色值超预算（预算 = 实测值，只留「变少」的方向）：\n${over.join('\n')}`);
  });

  test('语义形态：预算内的每一处都长在允许的上下文里（不是「有额度就能随便塞」）', (t) => {
    const shape = shapeViolations(collectColorHits());
    const shown = shape.map((item) => `${formatHit(item.hit)}\n     ← ${item.reason}`);
    t.diagnostic(shown.length === 0 ? '全部命中都在允许的形态里' : `形态违约 ${shown.length} 处`);
    assert.deepEqual(shown, [], `以下字面色不在允许的上下文形态里：\n${shown.join('\n')}`);
  });

  test('main 树：hex / rgb / hsl / Color(0x…) / 拼接 一处都不许有（命名色只剩预算内的 Transparent）', () => {
    const hits = collectColorHits().filter((hit) => hit.bucket === 'main-ui');
    const literals = hits
      .filter((hit) => hit.kind !== 'named')
      .map((hit) => `${hit.file}:${hit.line}: [${hit.kind}] ${hit.literal} → ${hit.text.trim()}`);
    assert.deepEqual(
      literals,
      [],
      `main 共享 UI 层的字面色必须换成 $r('app.color.*') / CANVAS_PAINTS：\n${literals.join('\n')}`
    );
    const named = hits.filter((hit) => hit.kind === 'named');
    assert.deepEqual(
      named.map((hit) => hit.literal),
      ['Color.Transparent'],
      `main 树只允许「透明」这一种命名色（${named.map((hit) => `${hit.file}:${hit.line}`).join(', ')}）`
    );
  });

  test('负向自测：这 16 种写法必须被同一套正则抓住（改正则先跑它）', () => {
    const samples = [
      ["const c: string = '#FFF';", 'hex 3 位'],
      ["const c: string = '#ABCD';", 'hex 4 位'],
      ["const c: string = '#aBcDeF';", 'hex 6 位（大小写混合）'],
      ["const c: string = '#80ABCDEF';", 'hex 8 位（AARRGGBB）'],
      ['const c: string = \'rgb(255, 0, 0)\';', 'rgb('],
      ['const c: string = \'rgba(0, 0, 0, 0.5)\';', 'rgba('],
      ['const c: string = \'hsl(0 100% 50%)\';', 'hsl('],
      ['const c: string = \'hsla(0, 100%, 50%, .5)\';', 'hsla('],
      ['const c: ResourceColor = Color.Cyan;', '非常见命名色'],
      ['const c: ResourceColor = Color.LightGray;', '非常见命名色 2'],
      ['const c: ResourceColor = Color(0xFF0000);', '数值构造器 0x'],
      ['const c: ResourceColor = Color(0x80FFFFFF);', '带 alpha 的数值构造器'],
      ['const c: ResourceColor = Color(16711680);', '十进制数值构造器'],
      ["const c: string = '#' + 'F1F3F5';", "'#' + '…' 拼接"],
      ["const c: string = 'F1F' + '3F5';", "'…' + 'F1F3F5' 拼接"],
      ['const c: string = `#${token}`;', '模板拼接'],
      ['const c: ResourceColor = Color.Transparent;', '命名色（透明也要走预算）']
    ];
    for (const [sample, label] of samples) {
      assert.ok(
        detectColorLiterals(sample).length > 0,
        `${label} 必须被色值扫描抓住，实际漏了：${sample}`
      );
    }
    // 反向：正常写法不能被误伤（否则门闸会逼人加无意义预算）
    const clean = [
      ".backgroundColor($r('app.color.canvas'))",
      "const c: ResourceColor = colorToken('text_primary');",
      'const paint: string = CANVAS_PAINTS.paper;'
    ];
    for (const sample of clean) {
      assert.deepEqual(detectColorLiterals(sample), [], `正常写法被误判：${sample}`);
    }
  });

  test('negative 自测（语义层）：形态之外的写法必须被拒，形态之内的必须放行', () => {
    const shapeOf = (bucket, code) =>
      detectColorLiterals(code).map((hit) => ({ ...hit, bucket, file: 'sample.ets', code }));
    const rejected = [
      ['harmony', "    .backgroundColor('#FFFFFF')", '裸 hex（不在三元/常量声明里）'],
      ['harmony', "    const other: string = '#123456';", '钉住值集合之外的新 hex'],
      ['harmony', '    .fontColor(Color.Black)', '完成按钮之外的命名色'],
      ['main-ui', '    const c: ResourceColor = Color.Transparent;', 'main 树透明色不在调用参数位'],
      ['main-model', '    const paint: string = someFn() + \'#FFF\';', 'model 层裸 hex 不在常量形态里'],
      ['main-common', "    const c: string = '#FFF';", 'common 层一个色值都不许有']
    ];
    for (const [bucket, code, label] of rejected) {
      const hits = shapeOf(bucket, code);
      assert.ok(
        shapeViolations(hits).length > 0,
        `${label} 必须被语义层拒绝：${code.trim()}`
      );
    }
    const accepted = [
      ['harmony', "    .backgroundColor(this.isDarkTheme() ? DARK_FALLBACK.chipFill : '#F7F8FA')", '三元假分支'],
      ['harmony', "  const RAIL_BG: string = '#F7F9FB';", '常量声明'],
      ['harmony', '    .fontColor(Color.White)', '完成按钮反白字'],
      ['harmony', "    .backgroundColor(this.on ? $r('app.color.selection_fill') : Color.Transparent)", '三元里的透明'],
      ['main-ui', '    .backgroundColor(Color.Transparent)', '调用参数位的透明'],
      ['main-model', "  paper: '#FFFFFF',", '常量对象字面量']
    ];
    for (const [bucket, code, label] of accepted) {
      const hits = shapeOf(bucket, code);
      assert.deepEqual(
        shapeViolations(hits).map((item) => item.reason),
        [],
        `${label} 必须被语义层放行：${code.trim()}`
      );
    }
  });

  test('harmony 树 hex ≤5，且值只能是被钉住的浅色档、位置只能是三元假分支/常量声明', () => {
    const hits = collectColorHits().filter((hit) => hit.bucket === 'harmony' && hit.kind === 'hex');
    assert.ok(hits.length <= 5, `harmony 树 hex 数量超预算（≤5，实测 ${hits.length}）：\n${hits.map((hit) => `${hit.file}:${hit.line} ${hit.literal}`).join('\n')}`);
    for (const hit of hits) {
      assert.ok(
        PINNED_HEX_VALUES.has(hit.literal.toUpperCase()),
        `${hit.file}:${hit.line} 的 ${hit.literal} 不在被 handwritingToolbar.test.mjs 钉住的值集合里`
      );
    }
    const values = [...new Set(hits.map((hit) => hit.literal))].sort();
    assert.deepEqual(values, ['#F1F3F5', '#F7F8FA', '#F7F9FB'], `钉住值的集合变了：${values.join(', ')}`);
    assert.deepEqual(shapeViolations(hits).map((item) => formatHit(item.hit)), [], 'harmony 树的 hex 必须都在三元假分支或常量声明里');
  });

  test('命名色只剩预算内：完成按钮的 Color.White ×1 + 透明 ×4', () => {
    const named = collectColorHits().filter((hit) => hit.kind === 'named');
    const white = named.filter((hit) => hit.literal === 'Color.White');
    const transparent = named.filter((hit) => hit.literal === 'Color.Transparent');
    assert.equal(white.length, 1, `Color.White 只允许 1 处（完成按钮反白字）：\n${white.map((hit) => `${hit.file}:${hit.line}`).join('\n')}`);
    assert.equal(transparent.length, 4, `Color.Transparent 只允许 4 处（main 1 + harmony 3，语义恒定：让底色透出来）：\n${transparent.map((hit) => `${hit.file}:${hit.line}`).join('\n')}`);
    assert.equal(named.length, white.length + transparent.length, '除 White / Transparent 之外不允许任何命名色');
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

    // 因 A2 拆分移动：`ThemeRow()` 随「关于」组搬到 components/settings/AboutSection.ets，
    // 锚点从「Settings.ets 里 ThemeRow 到 AboutGroup 之间」改成「AboutSection.ets 里的 ThemeRow」；
    // 断言（maxLines(1) + 省略号 + 只守 minWidth）不变。
    const settings = readAboutSection();
    const themeRow = settings.slice(settings.indexOf('ThemeRow() {'), settings.indexOf('build() {'));
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
  // 因 A2 拆分移动：`themeMode` 仍是页面的 @State（切换逻辑在页面 saveThemeMode），
  // 而三态片（THEME_MODE_ORDER 的顺序）渲染在 components/settings/AboutSection.ets；
  // 锚点改成页面 + 五个 section 的合并源码，断言（setColorMode/落盘/回退/顺序来自 theme.ts）不变。
  const SETTINGS = readSettingsSources();
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
