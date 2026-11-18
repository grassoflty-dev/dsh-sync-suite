// 手写板工具条尺寸（按屏比例自适应）的测试。
//
// 两个来源：
// 1) `model/toolbarMetrics` 纯函数（Node 直接跑编译产物 `.build/model/toolbarMetrics.js`）；
// 2) `Handwriting.ets` 源码断言：工具条区段**不许再写死 44/40**，分页区必须用 `metrics.gap`
//    且不小于 8vp（`Math.max(SPACING.sm, metrics.gap)`，SPACING.sm === 8）。
//
// 2026-11-16 定版：工具条尺寸由「视口宽高 + 横竖屏」算出来（竖屏=顶部条高度 / 横屏=rail 宽度），
// 不再是一组写死的 48/72/44/40；分页区同时放宽（每半 ≥44vp、页码格 ≥64vp）。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import {
  FALLBACK_VIEWPORT_H,
  FALLBACK_VIEWPORT_W,
  toolbarMetrics
} from '../.build/model/toolbarMetrics.js';
import { SPACING } from '../.build/common/uiTokens.js';

const here = dirname(fileURLToPath(import.meta.url));
const pagePath = join(here, '..', '..', 'entry', 'src', 'harmony', 'ets', 'pages', 'Handwriting.ets');
const source = readFileSync(pagePath, 'utf8');

/** 去掉注释，只对「代码」做断言（注释里解释旧数值不算违规）。 */
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

/** 取出某个成员（`@Builder` 或普通方法）的定义体。 */
function builderBody(name) {
  const match = new RegExp(`\\n  (?:private |static |async |protected )*${name}\\(`).exec(code);
  assert.ok(match !== null, `找不到 ${name} 的定义`);
  const start = match.index;
  const end = code.indexOf('\n  }\n', start);
  return end > 0 ? code.slice(start, end + 5) : code.slice(start);
}

/** 保留 1 位小数的断言辅助（与实现同一取整规则）。 */
function round1(value) {
  return Math.round(value * 10) / 10;
}

/** 五组验收视口（竖屏手机 / 平板竖屏 / 方屏竖屏 / 平板横屏 / 大屏竖屏）。 */
const VIEWPORTS = [
  { name: '360×780 竖屏手机', w: 360, h: 780, landscape: false },
  { name: '673×1024 平板竖屏', w: 673, h: 1024, landscape: false },
  { name: '840×1024 近平板竖屏', w: 840, h: 1024, landscape: false },
  { name: '1024×673 平板横屏', w: 1024, h: 673, landscape: true },
  { name: '1600×2560 大屏竖屏', w: 1600, h: 2560, landscape: false }
];

describe('toolbarMetrics：按视口比例自适应', () => {
  test('五组视口：每个字段都落在 clamp 区间内', () => {
    for (const viewport of VIEWPORTS) {
      const metrics = toolbarMetrics(viewport.w, viewport.h, viewport.landscape);
      if (viewport.landscape) {
        assert.ok(
          metrics.barThickness >= 56 && metrics.barThickness <= 84,
          `${viewport.name} barThickness=${metrics.barThickness} 必须落在 56~84`
        );
        assert.ok(
          metrics.itemSize >= 40 && metrics.itemSize <= 72,
          `${viewport.name} itemSize=${metrics.itemSize} 必须落在 40~72`
        );
      } else {
        assert.ok(
          metrics.barThickness >= 48 && metrics.barThickness <= 64,
          `${viewport.name} barThickness=${metrics.barThickness} 必须落在 48~64`
        );
        assert.ok(
          metrics.itemSize >= 40 && metrics.itemSize <= 64,
          `${viewport.name} itemSize=${metrics.itemSize} 必须落在 40~64`
        );
        // 竖屏：控件不能比顶部条还高（否则会被裁）
        assert.ok(
          metrics.itemSize <= metrics.barThickness,
          `${viewport.name} itemSize 不得大于 barThickness（控件会被顶部条裁掉）`
        );
      }
      assert.ok(metrics.fontSize >= 12 && metrics.fontSize <= 18, `${viewport.name} fontSize 必须落在 12~18`);
      assert.ok(metrics.iconSize > 0 && metrics.iconSize < metrics.itemSize, `${viewport.name} iconSize 必须小于 itemSize`);
      assert.ok(metrics.gap > 0 && metrics.gap < metrics.itemSize, `${viewport.name} gap 必须小于 itemSize`);
    }
  });

  test('派生关系：gap = itemSize×0.15、iconSize = itemSize×0.5、fontSize = clamp(12, itemSize×0.32, 18)', () => {
    for (const viewport of VIEWPORTS) {
      const metrics = toolbarMetrics(viewport.w, viewport.h, viewport.landscape);
      assert.equal(metrics.gap, round1(metrics.itemSize * 0.15), `${viewport.name} gap 派生不对`);
      assert.equal(metrics.iconSize, round1(metrics.itemSize * 0.5), `${viewport.name} iconSize 派生不对`);
      const expectedFont = round1(Math.min(18, Math.max(12, metrics.itemSize * 0.32)));
      assert.equal(metrics.fontSize, expectedFont, `${viewport.name} fontSize 派生不对`);
    }
  });

  test('单调性：屏更大时 itemSize / barThickness 不更小（竖屏按宽，横屏按高）', () => {
    const portraitSeries = [
      [320, 568],
      [360, 780],
      [600, 960],
      [673, 1024],
      [840, 1024],
      [1024, 1366],
      [1600, 2560]
    ];
    for (let index = 1; index < portraitSeries.length; index++) {
      const prev = toolbarMetrics(portraitSeries[index - 1][0], portraitSeries[index - 1][1], false);
      const next = toolbarMetrics(portraitSeries[index][0], portraitSeries[index][1], false);
      assert.ok(
        next.itemSize >= prev.itemSize,
        `竖屏 ${portraitSeries[index].join('×')} 的 itemSize=${next.itemSize} 不得小于前一档的 ${prev.itemSize}`
      );
      assert.ok(
        next.barThickness >= prev.barThickness,
        `竖屏 ${portraitSeries[index].join('×')} 的 barThickness=${next.barThickness} 不得小于前一档的 ${prev.barThickness}`
      );
    }

    const landscapeSeries = [
      [1024, 600],
      [1024, 673],
      [1280, 800],
      [1600, 900],
      [2400, 1200]
    ];
    for (let index = 1; index < landscapeSeries.length; index++) {
      const prev = toolbarMetrics(landscapeSeries[index - 1][0], landscapeSeries[index - 1][1], true);
      const next = toolbarMetrics(landscapeSeries[index][0], landscapeSeries[index][1], true);
      assert.ok(
        next.itemSize >= prev.itemSize,
        `横屏 ${landscapeSeries[index].join('×')} 的 itemSize=${next.itemSize} 不得小于前一档的 ${prev.itemSize}`
      );
      assert.ok(
        next.barThickness >= prev.barThickness,
        `横屏 ${landscapeSeries[index].join('×')} 的 barThickness=${next.barThickness} 不得小于前一档的 ${prev.barThickness}`
      );
    }
  });

  test('横竖屏用各自的基准边：横屏按宽算 rail 宽度、按高算控件边长', () => {
    // 同一块屏（1024×673）旋转后两组数值不同，且都落在自己方向的区间
    const portrait = toolbarMetrics(673, 1024, false);
    const landscape = toolbarMetrics(1024, 673, true);
    assert.notDeepEqual(portrait, landscape, '横竖屏必须给出不同的一组尺寸');
    assert.ok(portrait.barThickness <= 64 && landscape.barThickness >= 56);
    assert.ok(landscape.itemSize >= 40);
    // 横屏 rail 宽度由**宽**决定：同样高度下更宽的屏 → rail 更宽（直到上限 84）
    const narrow = toolbarMetrics(900, 700, true);
    const wide = toolbarMetrics(1900, 700, true);
    assert.ok(wide.barThickness >= narrow.barThickness, '横屏 rail 宽度必须随屏宽变大而不变小');
    assert.equal(wide.barThickness, 84, '超大屏 rail 宽度封顶 84');
  });

  test('非法输入不抛：0 / 负数 / NaN / Infinity 一律退化成竖屏 360×780 的默认值', () => {
    const fallback = toolbarMetrics(FALLBACK_VIEWPORT_W, FALLBACK_VIEWPORT_H, false);
    assert.equal(FALLBACK_VIEWPORT_W, 360);
    assert.equal(FALLBACK_VIEWPORT_H, 780);
    assert.ok(fallback.itemSize >= 40 && fallback.barThickness >= 48, '默认值本身必须合法');

    const bad = [
      [0, 780, false],
      [360, 0, false],
      [0, 0, true],
      [-1, 780, false],
      [360, -780, true],
      [Number.NaN, 780, false],
      [360, Number.NaN, true],
      [Number.POSITIVE_INFINITY, 780, false],
      [360, Number.NEGATIVE_INFINITY, true],
      [Number.NaN, Number.POSITIVE_INFINITY, true]
    ];
    for (const [w, h, landscape] of bad) {
      const metrics = toolbarMetrics(w, h, landscape);
      assert.deepEqual(metrics, fallback, `非法视口 ${String(w)}×${String(h)} 必须退化成 360×780 竖屏默认值`);
    }
  });

  test('所有返回值保留 1 位小数（避免亚像素抖动导致控件宽度来回跳）', () => {
    const samples = VIEWPORTS.concat([{ name: '零头视口', w: 411.7, h: 813.3, landscape: false }]);
    for (const sample of samples) {
      const metrics = toolbarMetrics(sample.w, sample.h, sample.landscape);
      for (const field of ['barThickness', 'itemSize', 'gap', 'iconSize', 'fontSize']) {
        const value = metrics[field];
        assert.equal(
          Math.abs(value * 10 - Math.round(value * 10)) < 1e-9,
          true,
          `${sample.name} ${field}=${value} 必须只有 1 位小数`
        );
        assert.notEqual(Object.is(value, -0), true, `${sample.name} ${field} 不得是 -0`);
      }
    }
  });
});

describe('Handwriting.ets 源码接线：工具条尺寸只从 metrics 取', () => {
  /**
   * 工具条/分页区相关的成员（写死 44/40 在这段里必须 0 命中）。
   *
   * A1 去重后竖屏的 brushMenuButton / toolButton / insertMenuButton / historyButton /
   * finishButton / exitButton 与横屏的 rail* 全部合并成一个 `buttonCell`（语义走 id、
   * 几何走 layout 参数），控件内容拆到 `cellContent` / `cellText` / `cellArrow`。
   * 名单按**合并后的实际成员**重钉：断言强度不变，只是锚点跟着重构走。
   */
  const TOOLBAR_MEMBERS = [
    'topBar',
    'railBar',
    'pageStepper',
    'insertDeleteCell',
    'pageLabelCell',
    'prevNextCell',
    'buttonCell',
    'cellContent',
    'cellText',
    'cellArrow',
    'brushIcon',
    'sizeIcon',
    'colorIcon'
  ];

  test('工具条区段没有写死的 44 / 40：尺寸全部来自 metrics 派生方法', () => {
    for (const member of TOOLBAR_MEMBERS) {
      const body = builderBody(member);
      assert.equal(
        /\.(width|height)\((44|40)\)/.test(body),
        false,
        `${member} 仍有写死的 .width(44|40) / .height(44|40)`
      );
      assert.equal(
        /\.(width|height)\([^)]*\b(44|40)\b[^)]*\)/.test(body.replace(/\$\{[^}]*\}/g, '')),
        false,
        `${member} 仍有把 44/40 写进尺寸调用`
      );
    }
    // 旧的写死常量必须彻底消失（否则总有人会再引用它们）
    for (const gone of [
      'TOP_BAR_HEIGHT',
      'RAIL_WIDTH',
      'RAIL_ITEM_HEIGHT',
      'RAIL_GAP',
      'CELL_WIDTH',
      'CELL_W_COMPACT',
      'TOOL_HEIGHT',
      'TOOL_MIN_WIDTH',
      'EXIT_SIZE'
    ]) {
      assert.equal(new RegExp(`\\b${gone}\\b`).test(code), false, `不得再出现写死常量 ${gone}`);
    }
    // 尺寸来源：metrics 派生方法都在，且工具条控件确实在用
    const metrics = builderBody('metrics');
    assert.ok(/toolbarMetrics\(this\.pageW, this\.pageH, this\.landscape\)/.test(metrics), 'metrics() 必须把视口与方向传给 toolbarMetrics');
    for (const name of ['barThickness', 'itemSize', 'controlGap', 'iconSize', 'toolbarFontSize', 'railWidth']) {
      assert.ok(new RegExp(`\\n  private ${name}\\(`).test(code), `缺少尺寸派生方法 ${name}()`);
    }
    // A1 之后：按钮高度只在 `buttonCell` 里（竖屏/横屏共用同一份几何），字号只在
    // `cellText` / `cellArrow` 里——都必须取 metrics 派生方法，别处不许再各写一套。
    for (const member of ['buttonCell', 'insertDeleteCell', 'pageLabelCell', 'prevNextCell']) {
      assert.ok(/\.height\(this\.itemSize\(\)\)/.test(builderBody(member)), `${member} 的高度必须取 metrics.itemSize`);
    }
    for (const member of ['cellText', 'cellArrow']) {
      assert.ok(
        /\.fontSize\(this\.toolbarFontSize\(\)\)/.test(builderBody(member)),
        `${member} 的字号必须取 metrics.fontSize`
      );
    }
    // 顶部条高度 / rail 宽度都来自 metrics
    assert.ok(/\.height\(this\.barThickness\(\)\)/.test(builderBody('topBar')), '顶部条高度必须取 metrics.barThickness');
    assert.ok(/\.width\(this\.railWidth\(\)/.test(builderBody('railBar')), 'rail 宽度必须取 metrics.barThickness（railWidth 的基准值）');
    assert.ok(/metrics\.barThickness/.test(builderBody('railWidth')), 'railWidth() 必须以 metrics.barThickness 为基准');
    // 图标尺寸也来自 metrics
    assert.ok(/this\.iconSize\(\)/.test(builderBody('brushIcon')), '笔形图标尺寸必须取 metrics.iconSize');
    assert.ok(/this\.iconSize\(\)/.test(builderBody('colorIcon')), '颜色图标尺寸必须取 metrics.iconSize');
  });

  test('分页区放宽：每半 ≥44vp、页码格 ≥64vp、间距 = max(8, metrics.gap)', () => {
    // 硬下限常量
    assert.ok(/const PAGER_HALF_MIN: number = 44;/.test(code), '分页区每半硬下限必须是 44vp');
    assert.ok(/const PAGER_LABEL_MIN: number = 64;/.test(code), '页码格硬下限必须是 64vp');
    // 间距：metrics.gap 且不小于 8vp（SPACING.sm === 8）
    assert.equal(SPACING.sm, 8, 'SPACING.sm 必须是 8vp（间距下限）');
    assert.ok(/metrics\.gap/.test(code), '分页区间距必须读 metrics.gap');
    assert.ok(
      /Math\.max\(SPACING\.sm, metrics\.gap\)/.test(builderBody('controlGap')),
      '间距必须是 max(8, metrics.gap)（不小于 8vp）'
    );
    const stepper = builderBody('pageStepper');
    assert.ok(/Row\(\{ space: this\.controlGap\(\) \}\)/.test(stepper), '分页区三格之间必须用 controlGap()');
    assert.ok(
      /this\.insertDeleteCell\(this\.pagerCellWidth\(\)\)/.test(stepper) &&
        /this\.pageLabelCell\(this\.pagerLabelWidth\(\)\)/.test(stepper) &&
        /this\.prevNextCell\(this\.pagerCellWidth\(\)\)/.test(stepper),
      '分页区必须用 pagerCellWidth()/pagerLabelWidth() 给宽度（不再传写死数字）'
    );
    // 两半单元格宽度 = 2 × 每半 + 1vp 分割线 ⇒ 每半必然 ≥44
    const cell = builderBody('pagerCellWidth');
    assert.ok(/2 \* this\.pagerHalfWidth\(\) \+ DIVIDER/.test(cell), '两半单元格宽度必须是「两半 + 1vp 分割线」');
    assert.ok(/Math\.max\(PAGER_HALF_MIN,/.test(builderBody('pagerHalfWidth')), '每半宽度必须兜住 PAGER_HALF_MIN(44)');
    assert.ok(/Math\.max\(PAGER_LABEL_MIN,/.test(builderBody('pagerLabelWidth')), '页码格宽度必须兜住 PAGER_LABEL_MIN(64)');
    // 两半仍然等分（layoutWeight(1) ×2）+ 中间 1vp 分割线
    for (const member of ['insertDeleteCell', 'prevNextCell']) {
      const body = builderBody(member);
      assert.equal((body.match(/\.layoutWeight\(1\)/g) ?? []).length, 2, `${member} 两半必须等分`);
      assert.ok(/\.vertical\(true\)/.test(body), `${member} 两半之间必须有竖向分割线`);
    }
    // 横屏 rail 也放得下分页区：rail 宽度必须 ≥ 两半单元格宽度
    assert.ok(
      /Math\.max\(width, this\.pagerCellWidth\(\)\)/.test(builderBody('railWidth')),
      'rail 宽度必须兜住分页区单元格宽度（否则横屏两半 <44vp）'
    );
  });
});
