// 手写板竖屏工具条「布局断言」（源码级，防真机回归）。
//
// 背景（真机 1600×2560 竖屏实测）：菜单栏「只显示钢和向下箭头，没有显示钢笔」、
// 粗细微菜单 5 个选项空白、删除页的「−」看不见、最右「完成」被省略号截断。
// 根因：按钮给了**固定窄宽**（38/44vp）+ 单字文案，内容放不下就被截断。
//
// 用户定版（本文件即验收口径）：
//   - 按钮**宽度按内容自适应**：只给 `constraintSize({ minWidth: 44 })` + `padding 8/8` +
//     `flexShrink(0)`，**不得再给固定 `width`**；
//   - 笔形按钮显示**当前笔刷名**（钢笔/圆珠笔/铅笔/马克笔/荧光笔）+ ▾；
//     粗细按钮显示「当前档位圆点 + 数值 + ▾」；颜色按钮显示「20×20 色块 + ▾」；
//   - 整行横向 `Scroll`（`BarState.Off`），溢出滚动、不换行、不压缩、不省略；
//   - 二级菜单每项 `minWidth ≥ 140`；粗细行显示「圆点 + `N vp`」；笔形行「图标 + 名称 + ✓」；
//     颜色行「28×28 色块 + 名称 + ✓」；
//   - 页面禁止 `TextOverflow.Ellipsis`；工具条/面板 `Text` 必须 `maxLines(1)`。
//
// 只读源码、不依赖 ArkTS 编译器，`node --test` 毫秒级跑完。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const pagePath = join(here, '..', '..', 'entry', 'src', 'harmony', 'ets', 'pages', 'Handwriting.ets');
const source = readFileSync(pagePath, 'utf8');

/** 去掉注释，避免文档里的示例文字干扰断言。 */
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

/** 取出某个 `@Builder`/方法体（从 `name(` 到下一个 `@Builder` 或 `build()`）。 */
function builderBody(name) {
  const start = code.indexOf(`${name}(`);
  assert.ok(start >= 0, `找不到 ${name}`);
  const rest = code.slice(start);
  const next = rest.search(/\n\s*@Builder|\n\s*build\(\) \{/);
  return next > 0 ? rest.slice(0, next) : rest;
}

/** 取某段源码里某类控件的属性块。 */
function blocksOf(body, component) {
  return body.split(new RegExp(`\\n\\s*${component}\\(`)).slice(1);
}

/** 工具条/面板里「带文字」的 Text 块（排除 Text('') 图标占位）。 */
function labelledTexts(chrome) {
  return blocksOf(chrome, 'Text').filter((block) => {
    const head = block.slice(0, 60);
    return /^'(?!')[^']+'/.test(head) || /^`[^`]+`/.test(head) || /^this\./.test(head);
  });
}

describe('手写板工具条：宽度自适应与不截断', () => {
  test('尺寸常量：控件 ≥44 / 高 40 / 步进器数字 ≥56 / 完成 ≥64 / 菜单项 ≥140 / 行高 44', () => {
    const read = (name) => Number(new RegExp(`const ${name}: number = (\\d+(?:\\.\\d+)?);`).exec(code)?.[1]);
    assert.ok(read('TOOL_MIN_WIDTH') >= 44, 'TOOL_MIN_WIDTH 必须 ≥44');
    assert.equal(read('TOOL_HEIGHT'), 40);
    assert.ok(read('STEPPER_LABEL_W') >= 56, '步进器数字宽必须 ≥56');
    assert.ok(read('FINISH_MIN_WIDTH') >= 64, '完成最小宽必须 ≥64');
    assert.ok(read('MENU_MIN_WIDTH') >= 140, '菜单项最小宽必须 ≥140');
    assert.equal(read('MENU_ROW_HEIGHT'), 44);
  });

  test('固定宽度清零：按钮容器不得给固定 width（图标内部允许），改用 minWidth + padding 自适应', () => {
    // 图标本身可以有宽高（圆点/色块），这里把「图标宽」排除后再断言容器没有固定宽
    const iconWidths = {
      brushMenuButton: [],
      sizeMenuButton: ['.width(this.currentDotSize())'],
      colorMenuButton: ['.width(20)'],
      toolButton: [],
      historyButton: []
    };
    for (const builder of Object.keys(iconWidths)) {
      const body = builderBody(builder);
      let stripped = body;
      for (const fragment of iconWidths[builder]) {
        stripped = stripped.split(fragment).join('');
      }
      assert.equal(/\.width\(/.test(stripped), false, `${builder} 的按钮容器不得给固定 width（会被截断）`);
      assert.ok(/\.constraintSize\(\{ minWidth: TOOL_MIN_WIDTH \}\)/.test(body), `${builder} 缺少 minWidth(44)`);
      assert.ok(/\.padding\(\{ left: SPACING\.sm, right: SPACING\.sm \}\)/.test(body), `${builder} 缺少左右 8vp padding`);
      assert.ok(/\.flexShrink\(0\)/.test(body), `${builder} 缺少 flexShrink(0)`);
    }
  });

  test('笔形按钮显示「当前笔刷名 + ▾」（动态文案，不是单字/固定标签）', () => {
    const body = builderBody('brushMenuButton');
    assert.ok(/Text\(this\.currentBrushLabel\(\)\)/.test(body), '笔形按钮必须显示动态笔刷名');
    assert.ok(/Text\('▾'\)/.test(body), '笔形按钮必须有 ▾');
    assert.equal(/substring\(0,\s*1\)/.test(code), false, '不得再截断成单字');
    const label = builderBody('currentBrushLabel');
    assert.ok(/brushSpec\(this\.pagerState\.brush\)\.label/.test(label), '文案必须来自 brushSpec(...).label');
  });

  test('粗细按钮显示「当前档位圆点 + 数值 + ▾」', () => {
    const body = builderBody('sizeMenuButton');
    assert.ok(/this\.currentDotSize\(\)/.test(body), '粗细按钮必须画当前档位圆点');
    assert.ok(/Text\(`\$\{this\.pagerState\.penWidth\}`\)/.test(body), '粗细按钮必须显示当前数值（layout 可断言）');
    assert.ok(/Text\('▾'\)/.test(body), '粗细按钮必须有 ▾');
  });

  test('颜色按钮显示「20×20 当前色块 + ▾」', () => {
    const body = builderBody('colorMenuButton');
    assert.ok(/\.width\(20\)/.test(body) && /\.height\(20\)/.test(body), '颜色按钮必须 20×20 色块');
    assert.ok(/backgroundColor\(this\.pagerState\.penColor\)/.test(body), '色块必须是当前颜色');
    assert.ok(/Text\('▾'\)/.test(body), '颜色按钮必须有 ▾');
  });

  test('溢出时该行横向滚动：Scroll + 横向 + 无滚动条 + 高度 48（不换行不加高）', () => {
    const bar = builderBody('topBar');
    assert.ok(/Scroll\(\)/.test(bar), '工具条必须包在 Scroll 里');
    assert.ok(/\.scrollable\(ScrollDirection\.Horizontal\)/.test(bar), '必须横向滚动');
    assert.ok(/\.scrollBar\(BarState\.Off\)/.test(bar), '不显示滚动条');
    assert.ok(/\.height\(TOP_BAR_HEIGHT\)/.test(bar), '工具条高度固定 48（≤48vp）');
  });

  test('二级菜单每项 minWidth ≥140，且三套面板结构正确', () => {
    const panel = builderBody('overlayPanel');
    assert.ok(
      /\.constraintSize\(\{ minWidth: MENU_MIN_WIDTH \}\)/.test(panel),
      '面板必须 constraintSize({ minWidth: MENU_MIN_WIDTH })'
    );
    // 笔形：图标 + 名称 + ✓
    assert.ok(/this\.brushIcon\(spec\.kind\)/.test(panel), '笔形行必须画图标');
    assert.ok(/Text\(spec\.label\)/.test(panel), '笔形行必须显示名称');
    // 粗细：圆点 + 「N vp」+ ✓
    assert.ok(/\.width\(SIZE_DOTS\[index\]\)/.test(panel), '粗细行圆点必须显式 width');
    assert.ok(/\.height\(SIZE_DOTS\[index\]\)/.test(panel), '粗细行圆点必须显式 height');
    assert.ok(/\.borderRadius\(SIZE_DOTS\[index\] \/ 2\)/.test(panel), '粗细行圆点必须显式 borderRadius');
    assert.ok(/\.backgroundColor\(\$r\('app\.color\.text_primary'\)\)/.test(panel), '粗细行圆点必须显式颜色');
    assert.ok(/Text\(`\$\{width\} vp`\)/.test(panel), '粗细行必须显示「N vp」');
    // 颜色：28×28 + 名称 + 选中描边
    assert.ok(/const SWATCH: number = 28;/.test(code), 'SWATCH 必须是 28');
    assert.ok(/\.width\(SWATCH\)/.test(panel) && /\.height\(SWATCH\)/.test(panel), '色块必须 28×28');
    assert.ok(/Text\(COLOR_LABELS\[index\]\)/.test(panel), '颜色行必须显示名称');
    assert.ok(/\.border\(\{/.test(panel), '选中色块必须有描边');
    // 选中 ✓
    assert.ok(/Text\('✓'\)/.test(panel), '选中行必须有 ✓');
  });

  test('面板行高 44、行宽 100%（点得中、不截断）', () => {
    const panel = builderBody('overlayPanel');
    const rows = panel.split('.height(MENU_ROW_HEIGHT)').length - 1;
    assert.ok(rows >= 3, `三个面板共应有 ≥3 处行高 44，实际 ${rows}`);
    assert.ok(/\.width\('100%'\)/.test(panel), '面板行必须 width 100%');
  });

  test('禁止省略号：页面无 TextOverflow.Ellipsis，工具条/面板文字都有 maxLines(1)', () => {
    assert.equal(/TextOverflow\.Ellipsis/.test(code), false, '页面不得出现 TextOverflow.Ellipsis');
    const chrome = [
      'brushMenuButton',
      'sizeMenuButton',
      'colorMenuButton',
      'toolButton',
      'historyButton',
      'pageStepper',
      'finishButton',
      'topBar',
      'railBar',
      'overlayPanel'
    ]
      .map((name) => builderBody(name))
      .join('\n');
    const texts = labelledTexts(chrome);
    assert.ok(texts.length >= 10, `工具条/面板里的文字 Text 太少：${texts.length}`);
    for (const block of texts) {
      const head = block.slice(0, 40).trim().split('\n')[0];
      assert.ok(/\.maxLines\(1\)/.test(block), `${head} 缺少 maxLines(1)`);
      assert.ok(
        /\.textOverflow\(\{ overflow: TextOverflow\.None \}\)/.test(block),
        `${head} 缺少 textOverflow(TextOverflow.None)`
      );
    }
  });

  test('禁用态不用整体 opacity 变透明（真机「−」消失的回归）', () => {
    const chrome = ['historyButton', 'pageStepper'].map((name) => builderBody(name)).join('\n');
    assert.equal(/\.opacity\(0?\.\d+\)/.test(chrome), false, '不得用 opacity 表达禁用态');
    assert.ok(/\.enabled\(/.test(chrome), '禁用必须用 enabled');
  });

  test('完成按钮：实底品牌蓝 + 白字 + 不收缩 + 竖屏 ≥64', () => {
    const body = builderBody('finishButton');
    assert.ok(/\.backgroundColor\(\$r\('app\.color\.brand'\)\)/.test(body), '完成必须品牌蓝实底');
    assert.ok(/\.fontColor\(Color\.White\)/.test(body), '完成必须白字');
    assert.ok(/\.flexShrink\(0\)/.test(body), '完成不得被压缩');
    assert.ok(/constraintSize\(\{ minWidth: .*FINISH_MIN_WIDTH.* \}\)/.test(body), '完成竖屏最小宽 ≥64');
  });

  test('工具条顺序 = 笔形/粗细/颜色/橡皮/手动框/撤销/重做/步进器/完成', () => {
    const bar = builderBody('topBar');
    const order = [
      'this.brushMenuButton()',
      'this.sizeMenuButton()',
      'this.colorMenuButton()',
      "this.toolButton('橡皮'",
      "this.toolButton('手动框'",
      "this.historyButton('undo'",
      "this.historyButton('redo'",
      'this.pageStepper()',
      'this.finishButton(false)'
    ];
    let cursor = -1;
    for (const token of order) {
      const at = bar.indexOf(token);
      assert.ok(at >= 0, `工具条缺少 ${token}`);
      assert.ok(at > cursor, `${token} 顺序不对`);
      cursor = at;
    }
  });

  test('菜单开合有 hilog 自证标记 `[hw] menu=<name> open=<0|1>`', () => {
    assert.ok(/\[hw\] menu=\$\{name\} open=/.test(source), '缺少 [hw] menu=<name> open=<0|1> 日志');
    for (const marker of ['[hw] menu=none open=0', '[hw] tool=', '[hw] delete confirm stage=', '[hw] page insert', '[hw] page deleted']) {
      assert.ok(source.includes(marker), `缺少日志标记 ${marker}`);
    }
  });
});
