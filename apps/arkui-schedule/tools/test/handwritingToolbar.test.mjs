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

/**
 * 取出某个 `@Builder`/方法**定义**体（两空格缩进的 `name(` 开头，到下一个 `@Builder` 或 `build()`）。
 *
 * 注意必须匹配「定义」而不是调用点：同一个 builder 可能先被 `this.xxx()` 调用、后定义
 * （例如 `pageStepperVertical` 先被 railBar 调用），用 `indexOf('xxx(')` 会命中调用处。
 */
function builderBody(name) {
  // 允许修饰符（`private` / `static` / `async`，如 `private async finish`）
  const match = new RegExp(`\\n  (?:private |static |async |protected )*${name}\\(`).exec(code);
  assert.ok(match !== null, `找不到 ${name} 的定义`);
  const start = match.index;
  // 成员结束 = 第一个「正好两空格缩进的收尾大括号」；嵌套块都是 4 空格以上，不会误判
  const end = code.indexOf('\n  }\n', start);
  return end > 0 ? code.slice(start, end + 5) : code.slice(start);
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
  test('尺寸常量：控件 ≥44 / 高 40 / 分页单元格 72（两半 ≥32）/ 完成 ≥64 / 菜单项 ≥140 / 行高 44', () => {
    const read = (name) => Number(new RegExp(`const ${name}: number = (\\d+(?:\\.\\d+)?);`).exec(code)?.[1]);
    assert.ok(read('TOOL_MIN_WIDTH') >= 44, 'TOOL_MIN_WIDTH 必须 ≥44');
    assert.equal(read('TOOL_HEIGHT'), 40);
    assert.equal(read('CELL_WIDTH'), 72, '分页单元格宽必须是 72vp（= rail 宽）');
    // 两半等分后每半宽 = (72 − 1vp 分割线) / 2 ≈ 35.5vp ≥ 32vp 点击区
    assert.ok((read('CELL_WIDTH') - 1) / 2 >= 32, '单元格两半必须各 ≥32vp 宽');
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
    assert.ok(/constraintSize\(\{ minWidth: FINISH_MIN_WIDTH \}\)/.test(body), '完成最小宽必须 ≥64');
    assert.ok(/\.width\(FINISH_MIN_WIDTH\)/.test(body), '竖屏完成宽 = 64vp');
    assert.ok(/\.padding\(\{ left: SPACING\.xs, right: SPACING\.xs \}\)/.test(body), '完成必须收窄内部 padding，否则 2 字会被挤成 ...');
  });

  test('工具条顺序 = 退出/笔形/粗细/颜色/橡皮/手动框/撤销/重做/步进器/完成', () => {
    const bar = builderBody('topBar');
    const order = [
      'this.exitButton()',
      'this.brushMenuButton()',
      'this.sizeMenuButton()',
      'this.colorMenuButton()',
      "this.toolButton('橡皮'",
      "this.toolButton('手动框'",
      "this.historyButton('undo'",
      "this.historyButton('redo'",
      'this.pageStepper()',
      'this.finishButton()'
    ];
    let cursor = -1;
    for (const token of order) {
      const at = bar.indexOf(token);
      assert.ok(at >= 0, `工具条缺少 ${token}`);
      assert.ok(at > cursor, `${token} 顺序不对`);
      cursor = at;
    }
    // 退出按钮在 Scroll 之外（永远可见，不会被横向滚动藏起来）
    const exitAt = bar.indexOf('this.exitButton()');
    const scrollAt = bar.indexOf('Scroll()');
    assert.ok(exitAt >= 0 && scrollAt > exitAt, '退出按钮必须在 Scroll 之前（不参与横向滚动）');
  });

  test('菜单开合有 hilog 自证标记 `[hw] menu=<name> open=<0|1>`', () => {
    assert.ok(/\[hw\] menu=\$\{name\} open=/.test(source), '缺少 [hw] menu=<name> open=<0|1> 日志');
    for (const marker of ['[hw] menu=none open=0', '[hw] tool=', '[hw] delete confirm stage=', '[hw] page insert', '[hw] page deleted']) {
      assert.ok(source.includes(marker), `缺少日志标记 ${marker}`);
    }
  });
});

// ---------------------------------------------------------------------------
// 横屏 rail（真机 2560×1600 实测）：56vp 太窄 → 「手动框」截成「手动」、「完成」变「...」、
// 步进器 `−`/`+` 被挤出 rail。定版：rail 72vp、步进器纵向三行、颜色加色名、完成 ≥64。
// ---------------------------------------------------------------------------

describe('手写板横屏 rail：宽度、纵向步进器与完整文案', () => {
  test('rail 宽度 ≥72vp，「手动框」「橡皮」等 3 字控件才放得下', () => {
    const rail = Number(/const RAIL_WIDTH: number = (\d+);/.exec(code)?.[1]);
    assert.ok(rail >= 72, `RAIL_WIDTH 必须 ≥72，实际 ${rail}`);
  });

  test('rail 只放工具 + 三个分页单元格，「完成」压底固定（不再有独立的 rail 页码行）', () => {
    const bar = builderBody('railBar');
    assert.equal(/this\.railStepper\(\)/.test(bar), false, 'railBar 不得再用旧的整组步进器');
    assert.equal(/this\.pageStepper\(\)/.test(bar), false, 'railBar 不得直接用竖屏三单元格行（要纵向堆叠）');
    // 退出按钮在 rail 最上方
    const exitAt = bar.indexOf('this.railExitButton()');
    const brushAt = bar.indexOf('this.railBrushButton()');
    assert.ok(exitAt >= 0 && exitAt < brushAt, '`‹` 退出按钮必须在 rail 最上方（笔形之前）');
    // 三个单元格纵向堆叠在工具之后、「完成」之前（都按 CELL_WIDTH 传参）
    const stepperAt = bar.indexOf('this.insertDeleteCell(CELL_WIDTH)');
    const finishAt = bar.indexOf('this.railFinishButton()');
    assert.ok(stepperAt > brushAt, '分页单元格必须在工具按钮之后');
    assert.ok(finishAt > stepperAt, '「完成」在最后（压底）');
    assert.ok(/Blank\(\)/.test(bar), 'rail 用 Blank() 把「完成」压到底部');
  });

  test('竖屏：分页三单元格在横向 Scroll 之外（固定可见，不被裁切）', () => {
    const bar = builderBody('topBar');
    const scrollAt = bar.indexOf('Scroll()');
    const stepperAt = bar.indexOf('this.pageStepper()');
    const finishAt = bar.indexOf('this.finishButton()');
    const exitAt = bar.indexOf('this.exitButton()');
    assert.ok(exitAt >= 0 && exitAt < scrollAt, '退出按钮在 Scroll 之前');
    assert.ok(stepperAt > scrollAt, '分页组在 Scroll 之后（即 Scroll 之外）');
    assert.ok(finishAt > stepperAt, '分页组固定在「完成」左侧');
    // Scroll 内只放 7 个工具按钮，不再塞分页组
    const scrollBody = bar.slice(scrollAt, bar.indexOf('.align(Alignment.Start)'));
    assert.equal(/this\.pageStepper\(\)/.test(scrollBody), false, '分页组不得在 Scroll 内（真机曾被裁成 20px）');
    for (const tool of ['this.brushMenuButton()', 'this.sizeMenuButton()', 'this.colorMenuButton()']) {
      assert.ok(scrollBody.includes(tool), `Scroll 内必须保留工具按钮 ${tool}`);
    }
  });

  test('竖屏单元格用紧凑宽度（36vp ≈84px），两半各 ≥34px 宽', () => {
    const compact = Number(/const CELL_W_COMPACT: number = (\d+);/.exec(code)?.[1]);
    assert.ok(compact >= 34 && compact <= 36, `CELL_W_COMPACT 必须落在 34~36vp（≈81~85px），实际 ${compact}`);
    const portrait = builderBody('pageStepper');
    for (const token of ['this.insertDeleteCell(CELL_W_COMPACT)', 'this.pageLabelCell(CELL_W_COMPACT)', 'this.prevNextCell(CELL_W_COMPACT)']) {
      assert.ok(portrait.includes(token), `竖屏分页区必须用紧凑宽度：${token}`);
    }
    // 整格 ≈84px（验收口径）
    const cellPx = compact * 2.375;
    assert.ok(cellPx >= 81 && cellPx <= 86, `单元格 ${cellPx.toFixed(1)}px 应 ≈84px`);
    // 两半每半宽 = (compact − 1vp 分割线) / 2，换算成 px 必须 ≥34px（验收线）
    const halfPx = ((compact - 1) / 2) * 2.375;
    assert.ok(halfPx >= 34, `两半每半 ${halfPx.toFixed(1)}px 必须 ≥34px`);
    // 竖屏宽度预算：退出 + 分页组 + 完成 + 间距 后，Scroll 仍有 ≥400vp（7 个工具放得下）
    const exitW = Number(/const EXIT_SIZE: number = (\d+);/.exec(code)?.[1]);
    const finishW = Number(/const FINISH_MIN_WIDTH: number = (\d+);/.exec(code)?.[1]);
    const gap = 4;
    const fixed = 16 /* 左右 padding */ + exitW + 3 * compact + 2 * gap + finishW + 4 * gap;
    // 竖屏屏宽 1600px / 2.375 = 673.7vp
    assert.ok(673.7 - fixed >= 400, `Scroll 剩余宽度只有 ${(673.7 - fixed).toFixed(1)}vp，放不下 7 个工具`);
    // 横屏仍用 72vp
    const rail = builderBody('railBar');
    assert.ok(rail.includes('this.insertDeleteCell(CELL_WIDTH)'), '横屏必须用 CELL_WIDTH(72)');
  });

  test('rail 内控件尺寸统一：72vp 宽 / 高 44（退出 40）/ 同圆角 / 同底色', () => {
    const railControls = ['railBrushButton', 'railSizeButton', 'railColorButton', 'railToolButton', 'railHistoryButton'];
    for (const name of railControls) {
      const body = builderBody(name);
      assert.ok(/\.width\('100%'\)/.test(body), `${name} 必须宽 100%（rail 内容宽统一 72vp）`);
      assert.ok(/\.height\(RAIL_ITEM_HEIGHT\)/.test(body), `${name} 必须统一 44vp 高`);
      assert.ok(/\.borderRadius\(RADIUS\.sm\)/.test(body), `${name} 必须统一圆角`);
    }
    // 三个分页单元格与完成：宽度由调用方传（横屏 CELL_WIDTH=72）/ 完成固定 72vp，高都是 44vp
    for (const name of ['insertDeleteCell', 'pageLabelCell', 'prevNextCell']) {
      const body = builderBody(name);
      assert.ok(/\.width\(width\)/.test(body), `${name} 必须由调用方传宽度（竖屏紧凑/横屏 72）`);
      assert.ok(/\.height\(RAIL_ITEM_HEIGHT\)/.test(body), `${name} 必须 44vp 高`);
      assert.ok(/\.borderRadius\(RADIUS\.sm\)/.test(body), `${name} 必须统一圆角`);
    }
    {
      const body = builderBody('railFinishButton');
      assert.ok(/\.width\(CELL_WIDTH\)/.test(body), 'railFinishButton 必须 72vp 宽');
      assert.ok(/\.height\(RAIL_ITEM_HEIGHT\)/.test(body), 'railFinishButton 必须 44vp 高');
      assert.ok(/\.borderRadius\(RADIUS\.sm\)/.test(body), 'railFinishButton 必须统一圆角');
    }
    // 橡皮/手动框 + 三个单元格：同底色 #F1F3F5 / #F7F8FA 系（railToolButton 是三元）
    for (const name of ['insertDeleteCell', 'pageLabelCell', 'prevNextCell', 'railToolButton']) {
      assert.ok(
        /\.backgroundColor\([\s\S]{0,120}?'#F/.test(builderBody(name)),
        `${name} 必须有底色`
      );
    }
    // 内容水平居中
    for (const name of ['railToolButton', 'railHistoryButton']) {
      assert.ok(/\.textAlign\(TextAlign\.Center\)/.test(builderBody(name)), `${name} 内容必须水平居中`);
    }
    for (const name of ['railBrushButton', 'railSizeButton', 'railColorButton']) {
      assert.ok(/\.justifyContent\(FlexAlign\.Center\)/.test(builderBody(name)), `${name} 内容必须水平居中`);
    }
  });

  test('分页区 = 三个单元格（[−|+] / [n/m] / [‹|›]），竖屏与 rail 共用同一套', () => {
    // `[−|+]`：两半 + 中间 1vp 分割线，各自独立禁用
    const insertDelete = builderBody('insertDeleteCell');
    assert.ok(/Text\('−'\)/.test(insertDelete) && /Text\('\+'\)/.test(insertDelete), '`[−|+]` 必须有 − 与 + 两半');
    assert.ok(/Divider\(\)\s*\n\s*\.vertical\(true\)/.test(insertDelete), '两半之间必须有竖向 Divider');
    assert.ok(/\.strokeWidth\(DIVIDER\)/.test(insertDelete), '分割线必须是 1vp');
    assert.ok(/\.color\(\$r\('app\.color\.divider'\)\)/.test(insertDelete), '分割线颜色必须是 app.color.divider');
    assert.equal((insertDelete.match(/\.layoutWeight\(1\)/g) ?? []).length, 2, '两半必须等分（layoutWeight(1) ×2）');
    assert.ok(/\.enabled\(this\.pageTotal\(\) > 1\)/.test(insertDelete), '`−` 必须 pageTotal()>1 才可点');
    assert.ok(/\.enabled\(this\.pageTotal\(\) < MAX_HANDWRITING_PAGES\)/.test(insertDelete), '`+` 必须未满 10 页才可点');
    assert.equal(/\.opacity\(/.test(insertDelete), false, '`[−|+]` 禁用不得用 opacity');
    assert.ok(/\.startDeletePage\(\)/.test(insertDelete), '`−` 必须走 startDeletePage()（两次确认）');
    assert.ok(/\.insertPage\(\)/.test(insertDelete), '`+` 必须走 insertPage()');

    // `[‹|›]`：两半 + 分割线，首末页禁用
    const prevNext = builderBody('prevNextCell');
    assert.ok(/Text\('‹'\)/.test(prevNext) && /Text\('›'\)/.test(prevNext), '`[‹|›]` 必须有 ‹ 与 › 两半');
    assert.ok(/Divider\(\)\s*\n\s*\.vertical\(true\)/.test(prevNext), '两半之间必须有竖向 Divider');
    assert.equal((prevNext.match(/\.layoutWeight\(1\)/g) ?? []).length, 2, '两半必须等分');
    assert.ok(/\.enabled\(this\.canPrevPage\(\)\)/.test(prevNext), '`‹` 必须 canPrevPage() 才可点');
    assert.ok(/\.enabled\(this\.canNextPage\(\)\)/.test(prevNext), '`›` 必须 canNextPage() 才可点');
    assert.ok(/fontColor\(this\.canPrevPage\(\) \?/.test(prevNext), '`‹` 禁用只改字色');
    assert.ok(/fontColor\(this\.canNextPage\(\) \?/.test(prevNext), '`›` 禁用只改字色');
    assert.equal(/\.opacity\(/.test(prevNext), false, '`[‹|›]` 禁用不得用 opacity');
    assert.ok(/\.goPrevPage\(\)/.test(prevNext) && /\.goNextPage\(\)/.test(prevNext), '`‹`/`›` 必须走 goPrevPage/goNextPage');

    // `[n/m]`：只读
    const label = builderBody('pageLabelCell');
    assert.ok(label.includes('this.pageIndex() + 1'), '页码单元格必须显示「当前/总数」');
    assert.equal(/\.onClick\(/.test(label), false, '页码单元格不可点');
    assert.equal(/\.enabled\(/.test(label), false, '页码单元格不需要 enabled');

    // 三个单元格：宽度由调用方传（竖屏紧凑 / 横屏 72），高 44、圆角统一
    for (const name of ['insertDeleteCell', 'pageLabelCell', 'prevNextCell']) {
      const body = builderBody(name);
      assert.ok(/\.width\(width\)/.test(body), `${name} 必须由调用方传宽度`);
      assert.ok(/\.height\(RAIL_ITEM_HEIGHT\)/.test(body), `${name} 必须 44vp 高`);
      assert.ok(/\.borderRadius\(RADIUS\.sm\)/.test(body), `${name} 必须统一圆角`);
    }
    assert.ok(/const CELL_WIDTH: number = 72;/.test(code), 'CELL_WIDTH（横屏）必须是 72（与 rail 宽一致）');
    assert.ok(/const CELL_W_COMPACT: number = 36;/.test(code), 'CELL_W_COMPACT（竖屏）必须是 36vp ≈ 84px');

    // 竖屏：一个 Row 里三个单元格（同一行），且用紧凑宽度
    const portrait = builderBody('pageStepper');
    assert.ok(/Row\(\{ space: SPACING\.xs \}\)/.test(portrait), '竖屏分页区必须是横向 Row');
    let cursor = -1;
    for (const token of [
      'this.insertDeleteCell(CELL_W_COMPACT)',
      'this.pageLabelCell(CELL_W_COMPACT)',
      'this.prevNextCell(CELL_W_COMPACT)'
    ]) {
      const at = portrait.indexOf(token);
      assert.ok(at >= 0, `竖屏分页区缺少 ${token}`);
      assert.ok(at > cursor, `${token} 顺序不对（应为 [−|+] [n/m] [‹|›]）`);
      cursor = at;
    }
    assert.ok(/this\.pageStepper\(\)/.test(builderBody('topBar')), '竖屏顶部条必须用 pageStepper()');

    // 横屏：rail 里纵向堆叠同样三个单元格（72vp），且在「完成」之前
    const rail = builderBody('railBar');
    for (const token of [
      'this.insertDeleteCell(CELL_WIDTH)',
      'this.pageLabelCell(CELL_WIDTH)',
      'this.prevNextCell(CELL_WIDTH)'
    ]) {
      assert.ok(rail.includes(token), `rail 缺少 ${token}`);
    }
    assert.ok(
      rail.indexOf('this.prevNextCell(CELL_WIDTH)') < rail.indexOf('this.railFinishButton()'),
      '三个单元格必须在「完成」之前'
    );
  });

  test('竖屏按钮仍是「内容自适应 + minWidth 44」（两套布局分开写，rail 的固定宽不要污染竖屏）', () => {
    const controls = ['brushMenuButton', 'sizeMenuButton', 'colorMenuButton', 'toolButton', 'historyButton'];
    for (const name of controls) {
      const body = builderBody(name);
      assert.ok(/\.flexShrink\(0\)/.test(body), `${name} 缺少 flexShrink(0)`);
      assert.ok(/constraintSize\(\{ minWidth: TOOL_MIN_WIDTH \}\)/.test(body), `${name} 缺少 minWidth 44`);
      assert.equal(/\.width\('100%'\)/.test(body), false, `${name} 属于竖屏，不得固定 100% 宽`);
    }
    // rail 专用按钮反过来：必须 100%，且不参与竖屏
    assert.ok(/\.width\('100%'\)/.test(builderBody('railBrushButton')), 'rail 按钮必须 100% 宽');
    assert.equal(/railBrushButton/.test(builderBody('topBar')), false, '竖屏 topBar 不得使用 rail 按钮');
  });

  test('关键文案是完整字符串（布局里必须能读到）', () => {
    assert.ok(source.includes("'手动框'"), '源码必须含完整「手动框」');
    assert.ok(source.includes("'橡皮'"), '源码必须含「橡皮」');
    assert.ok(source.includes("'完成'"), '源码必须含「完成」');
    assert.ok(source.includes("Text('−')"), '源码必须含步进器「−」');
    assert.ok(source.includes("Text('+')"), '源码必须含步进器「+」');
    assert.ok(source.includes("Text('‹')"), '源码必须含翻页「‹」');
    assert.ok(source.includes("Text('›')"), '源码必须含翻页「›」');
    assert.ok(
      /Text\(`\$\{this\.pageIndex\(\) \+ 1\}\/\$\{this\.pageTotal\(\)\}`\)/.test(code),
      '源码必须含 `n/m` 页码文案（读唯一真相源 pageIndex()/pageTotal()）'
    );
  });

  test('rail 11 项 + 完成 ≤ 真机可用高度（≈601vp），不再需要 Scroll，「完成」不会被挤出屏幕', () => {
    const bar = builderBody('railBar');
    // 结构：三个分页单元格已合并（不再有 5 行散件），所以无需 Scroll
    assert.equal(/Scroll\(\)/.test(bar), false, 'rail 不再需要 Scroll（分页已合并成 3 个单元格）');
    assert.ok(/Blank\(\)/.test(bar), 'rail 用 Blank() 把「完成」压到底部');

    const item = Number(/const RAIL_ITEM_HEIGHT: number = (\d+);/.exec(code)?.[1]);
    const gap = Number(/const RAIL_GAP: number = (\d+);/.exec(code)?.[1]);
    const padding = 8; // SPACING.sm，rail 上下 padding
    const soloButtons = (bar.match(/this\.rail(Exit|Brush|Size|Color|Tool|History)Button\(/g) ?? []).length;
    assert.equal(soloButtons, 8, 'rail 独立按钮应为 8 个（退出/笔形/粗细/颜色/橡皮/手动框/撤销/重做）');
    const exitIsShorter = /\.height\(TOOL_HEIGHT\)/.test(builderBody('railExitButton'));
    const items = soloButtons + 3 /* [−|+] [n/m] [‹|›] */ + 1 /* 完成 */;
    const content =
      item * (items - 1) + (exitIsShorter ? Number(/const TOOL_HEIGHT: number = (\d+);/.exec(code)?.[1]) : item) +
      gap * items +
      padding * 2;
    // 真机实测 rail 竖向可用高度 ≈601vp（状态栏 105px 起、底边 1534px，@2.375）
    assert.ok(content <= 601, `rail 内容 ${content}vp 必须 ≤ 真机可用 601vp（否则「完成」会被挤出屏幕）`);
    assert.ok(content >= 500 && content <= 601, `rail 内容 ${content}vp 应落在合理区间（Blank 吸收余量）`);
  });

  test('竖屏「完成」也在针向 Scroll 之外（不会被横向滚走）', () => {
    const bar = builderBody('topBar');
    const scrollAt = bar.indexOf('Scroll()');
    const finishAt = bar.indexOf('this.finishButton()');
    assert.ok(scrollAt >= 0 && finishAt > scrollAt, '竖屏「完成」必须在 Scroll 之外');
    // 退出按钮也在 Scroll 之外，且最靠左
    const exitAt = bar.indexOf('this.exitButton()');
    assert.ok(exitAt >= 0 && exitAt < scrollAt, '竖屏「‹」退出必须在 Scroll 之外（固定可见）');
  });

  test('颜色按钮带当前色名短标签（黑/红/蓝/绿/橙）', () => {
    const body = builderBody('colorMenuButton');
    assert.ok(/Text\(this\.currentColorLabel\(\)\)/.test(body), '颜色按钮必须显示当前色名');
    assert.ok(/COLOR_LABELS: string\[\] = \['黑', '红', '蓝', '绿', '橙'\]/.test(code), '色名表必须是 黑/红/蓝/绿/橙');
    assert.ok(/\.width\(20\)/.test(body) && /\.height\(20\)/.test(body), '色块必须 20×20');
  });
});

// ---------------------------------------------------------------------------
// 真机 P0（2026-11-15 横屏）：点 `+` 后内部状态已是 2/2、`ui layout` 里也出现了 hw-page-p2，
// 但父页面页码仍显示 1/1，`−` 因此一直禁用（删除功能完全不可用）。
// 根因：父页面自己维护了一份 @State pageCount/currentPage 副本，只在 onStateChange 里同步，
// 而插页/删页走的是 state.insertPageAfterCurrent()/removePage()（不触发回调）。
// 定版：**唯一真相源** = pagerState；父页面 build 里直接读，不再留副本。
// ---------------------------------------------------------------------------

describe('手写板页码状态：单一真相源（P0 回归）', () => {
  test('父页面不再持有 pageCount / currentPage / undoSteps / redoAvailable 的 @State 副本', () => {
    for (const field of ['pageCount', 'currentPage', 'undoSteps', 'redoAvailable']) {
      assert.equal(
        new RegExp(`@State ${field}:`).test(code),
        false,
        `不得再声明 @State ${field} 副本（真相源在 pagerState）`
      );
      assert.equal(
        new RegExp(`this\\.${field}\\b`).test(code),
        false,
        `不得再读写 this.${field}（会变成两份真相）`
      );
    }
  });

  test('页码/可用性都通过 pageTotal()/pageIndex() 读 pagerState', () => {
    const total = builderBody('pageTotal');
    assert.ok(/return this\.pagerState\.pages;/.test(total), 'pageTotal() 必须读 pagerState.pages');
    const index = builderBody('pageIndex');
    assert.ok(/return this\.pagerState\.current;/.test(index), 'pageIndex() 必须读 pagerState.current');
    // 三处页面文本 + 两处 enabled 都必须走这两个读取器
    assert.ok(/Text\(`\$\{this\.pageIndex\(\) \+ 1\}\/\$\{this\.pageTotal\(\)\}`\)/.test(code), '页码文本必须读读取器');
    assert.ok(/\.enabled\(this\.pageTotal\(\) > 1\)/.test(code), '`−` 的 enabled 必须读 pageTotal()');
    assert.ok(/\.enabled\(this\.pageTotal\(\) < MAX_HANDWRITING_PAGES\)/.test(code), '`+` 的 enabled 必须读 pageTotal()');
  });

  test('插页/删页/翻页后都会 bump uiTick 强制重绘（不依赖隐式观察）', () => {
    assert.ok(/@State uiTick: number = 0;/.test(code), '必须有 uiTick 重绘信号');
    assert.ok(/private touchUi\(\): void/.test(code), '必须有 touchUi()');
    for (const fn of ['insertPage', 'confirmDelete', 'goPrevPage', 'goNextPage']) {
      assert.ok(/this\.touchUi\(\);/.test(builderBody(fn)), `${fn} 变更状态后必须 touchUi()`);
    }
    // build 里必须读取 uiTick 建立依赖
    assert.ok(/if \(this\.uiTick < 0\)/.test(builderBody('build')), 'build() 必须读取 uiTick 建立重绘依赖');
  });

  test('pager 的 onStateChange 只用于触发重绘，不再写回副本', () => {
    assert.ok(/onStateChange: \(\) => \{\s*this\.touchUi\(\);\s*\}/.test(code), 'onStateChange 必须只调 touchUi()');
  });

  test('插页/删页有 hilog 取证（页码文本可对照）', () => {
    assert.ok(/\[hw\] page insert after, now=/.test(source), '插页日志');
    assert.ok(/\[hw\] pages \$\{action\} total=\$\{this\.pageTotal\(\)\} current=\$\{this\.pageIndex\(\) \+ 1\}/.test(source), '页状态日志必须打印 total/current');
    assert.ok(/canDelete=\$\{this\.pageTotal\(\) > 1\}/.test(source), '页状态日志必须打印 canDelete');
  });
});

// ---------------------------------------------------------------------------
// 视觉要求（用户）：工具条/rail 与画布之间要有分界线，否则「糊在一起」。
// 横屏：rail 右侧 1vp 竖分割线 + rail 底色略浅、不投影；
// 竖屏：工具条下方 1vp 横分割线。
// ---------------------------------------------------------------------------

describe('手写板工具条与画布的分界线', () => {
  test("横屏 rail 右侧有 1vp 竖分割线（$r('app.color.divider')）", () => {
    const bar = builderBody('railBar');
    assert.ok(/Divider\(\)\s*\n\s*\.vertical\(true\)/.test(bar), 'railBar 必须有竖向 Divider');
    assert.ok(/\.strokeWidth\(DIVIDER\)/.test(bar), '分割线宽度必须是 DIVIDER(=1)');
    assert.ok(/\.color\(\$r\('app\.color\.divider'\)\)/.test(bar), '分割线颜色必须是 app.color.divider');
    assert.ok(/\.height\('100%'\)/.test(bar), '竖分割线必须撑满高度');
    // rail 容器宽度 = 72 + 1
    assert.ok(/\.width\(RAIL_WIDTH \+ DIVIDER\)/.test(bar), 'rail 容器宽 = RAIL_WIDTH + DIVIDER');
  });

  test('横屏 rail 底色略浅且不投影', () => {
    const bar = builderBody('railBar');
    assert.ok(/\.backgroundColor\(RAIL_BG\)/.test(bar), 'rail 必须用 RAIL_BG（#F7F9FB）');
    assert.ok(/const RAIL_BG: string = '#F7F9FB';/.test(code), 'RAIL_BG 必须是 #F7F9FB');
    assert.equal(/\.shadow\(/.test(bar), false, 'rail 不得有投影');
  });

  test('竖屏工具条下方有 1vp 横分割线', () => {
    const divider = builderBody('topBarDivider');
    assert.ok(/Divider\(\)/.test(divider), 'topBarDivider 必须是 Divider');
    assert.ok(/\.strokeWidth\(DIVIDER\)/.test(divider), '横分割线宽度必须是 DIVIDER(=1)');
    assert.ok(/\.color\(\$r\('app\.color\.divider'\)\)/.test(divider), '横分割线颜色必须是 app.color.divider');
    assert.equal(/\.vertical\(true\)/.test(divider), false, '竖屏的是横线');
    // build 里工具条高度要把分割线算进去，且只在竖屏出现
    const build = builderBody('build');
    assert.ok(/this\.topBarDivider\(\)/.test(build), 'build 必须渲染顶部横分割线');
    assert.ok(/TOP_BAR_HEIGHT \+ DIVIDER/.test(build), '顶部条高度必须含分割线（48+1）');
  });
});

// ---------------------------------------------------------------------------
// 退出暂存 + 再进恢复（用户原话：「手写板没有退出按钮，退出后应该要暂存当前手写页的所有内容，
// 可以后续进入再修改，完成才是按照要求做 OCR。」）
// ---------------------------------------------------------------------------

describe('手写板退出：按钮 / 系统返回 / 草稿落盘', () => {
  test('竖屏工具条最左侧有「‹」退出按钮（40×40，在 Scroll 之外）', () => {
    const exit = builderBody('exitButton');
    assert.ok(/Text\('‹'\)/.test(exit), '必须是「‹」');
    assert.ok(/\.width\(EXIT_SIZE\)/.test(exit) && /\.height\(TOOL_HEIGHT\)/.test(exit), '必须 40×40');
    assert.ok(/\.onClick\(\(\) => \{\s*this\.exitWritingBoard\(\);/.test(exit), '点击必须走 exitWritingBoard()');
    assert.equal(/\.opacity\(/.test(exit), false, '退出按钮不得透明');
  });

  test('横屏 rail 顶部有「‹」退出按钮（72×40，与 rail 等宽）', () => {
    const exit = builderBody('railExitButton');
    assert.ok(/Text\('‹'\)/.test(exit), '必须是「‹」');
    assert.ok(/\.width\('100%'\)/.test(exit), '必须与 rail 其它控件等宽（72vp）');
    assert.ok(/\.height\(TOOL_HEIGHT\)/.test(exit), '顶部固定区高度 40vp');
    assert.ok(/\.flexShrink\(0\)/.test(exit), '退出按钮不得被压缩');
    assert.ok(/this\.railExitButton\(\)/.test(builderBody('railBar')), 'railBar 必须渲染退出按钮');
  });

  test('退出 = 存草稿 → router.back()，不二次确认', () => {
    const body = builderBody('exitWritingBoard');
    assert.ok(/this\.clearDraftTimer\(\);/.test(body), '退出前先取消防抖定时器');
    assert.ok(/this\.saveDraftNow\(false\);/.test(body), '退出必须先存草稿');
    assert.ok(/router\.back\(\)/.test(body), '退出必须返回上一页');
    assert.equal(/confirmStage/.test(body), false, '退出不得弹二次确认');
    // 保存失败也不能挡住退出（router.back 在 try 之外/之后）
    assert.ok(body.indexOf('router.back()') > body.indexOf('saveDraftNow'), '必须先存再返回');
  });

  test('系统返回/侧滑返回走同一条路径（onBackPress 存草稿）', () => {
    const body = builderBody('onBackPress');
    assert.ok(/this\.saveDraftNow\(false\);/.test(body), 'onBackPress 必须存草稿');
    assert.ok(/return false;/.test(body), 'onBackPress 返回 false（放行系统默认返回）');
    assert.ok(/this\.clearDraftTimer\(\);/.test(body), 'onBackPress 先取消防抖');
  });

  test('抬笔/页切换/插页/删页/建框删框都会触发防抖保存', () => {
    // 抬笔/建框/删框/拖框：画布组件调用 state.notifyDirty()（父页面据此防抖存盘）
    const pagerPath = pagePath.replace(/pages[\\/]Handwriting\.ets$/, 'handwriting/HandwritingPager.ets');
    const pager = readFileSync(pagerPath, 'utf8');
    const strokeUp = pager.slice(pager.indexOf('this.state.pushStroke('), pager.indexOf('this.state.pushStroke(') + 200);
    assert.ok(/notifyDirty\(\)/.test(strokeUp), '抬笔（pushStroke 之后）必须 notifyDirty()');
    for (const fn of ['handleGestureEnd', 'removeRegionAt']) {
      assert.ok(/notifyDirty\(\)/.test(pager.slice(pager.indexOf(fn), pager.indexOf(fn) + 900)), `${fn} 必须 notifyDirty()`);
    }
    assert.ok(pager.includes('.onAreaChange('), '画布必须有 onAreaChange');
    assert.ok(/this\.state\.notifyCanvasReady\(\)/.test(pager), '画布尺寸就绪必须通知父页面（恢复草稿要用）');
    // 页切换 / 插页 / 删页
    for (const fn of ['goPrevPage', 'goNextPage', 'insertPage', 'confirmDelete']) {
      assert.ok(/this\.scheduleDraftSave\(\);/.test(builderBody(fn)), `${fn} 必须触发 scheduleDraftSave()`);
    }
    // 防抖 2s
    assert.ok(/const DRAFT_SAVE_DEBOUNCE_MS: number = 2000;/.test(code), '防抖必须是 2s');
    assert.ok(/setTimeout\(\(\) => \{/.test(builderBody('scheduleDraftSave')), '必须用 setTimeout 防抖');
  });

  test('「完成」且 OCR 成功才作废草稿（失败保留）', () => {
    const finish = builderBody('finish');
    assert.ok(/this\.discardDraft\(\);/.test(finish), 'OCR 成功后必须删草稿');
    // 删草稿必须同时「关掉后续保存」，否则 aboutToDisappear 会把草稿写回来（真 bug）
    assert.ok(/this\.draftClosed = true;/.test(builderBody('discardDraft')), 'discardDraft 必须置 draftClosed');
    assert.ok(/if \(this\.draftClosed\) \{/.test(builderBody('saveDraftNow')), 'saveDraftNow 必须尊重 draftClosed');
    // 顺序：先 toast/写回结果，再 discard，最后 back
    assert.ok(finish.indexOf('this.discardDraft()') < finish.indexOf('router.back()'), '作废草稿必须在返回之前');
    // 最后的 catch 是 OCR 失败分支（前面还有一个「附件存储初始化失败」的 catch）
    const catchPart = finish.slice(finish.lastIndexOf('catch (error)'));
    assert.equal(/discardDraft/.test(catchPart), false, 'OCR 失败不得删草稿');
  });

  test('进入页面读草稿并恢复；坏文件删除、不崩', () => {
    const restore = builderBody('restoreDraft');
    assert.ok(/draftStore\.readDraftSync\(this\.draftKey\)/.test(restore), '必须按 draftKey 读草稿');
    assert.ok(/parseDraft\(text, this\.draftKey\)/.test(restore), '必须用 model/draft 的 parseDraft 解析');
    assert.ok(/parsed\.reason === 'empty'/.test(restore), '没有草稿直接返回');
    assert.ok(/draftStore\.deleteDraftSync\(this\.draftKey\)/.test(restore), '损坏草稿必须删除');
    assert.ok(/this\.pendingDraft = parsed\.doc;/.test(restore), '解析成功后挂到 pendingDraft');

    const apply = builderBody('applyPendingDraft');
    assert.ok(/isUsableCanvas\(w, h\)/.test(apply), '必须等画布量出尺寸再投影');
    assert.ok(/fromDraftStrokes\(page\.strokes, w, h\)/.test(apply), '笔迹必须按当前画布尺寸重投影');
    assert.ok(/fromDraftBoxes\(page\.boxes\)/.test(apply), '框必须恢复');
    assert.ok(/jumpTo\(doc\.current\)/.test(apply), '必须恢复到上次所在页');
    assert.ok(/DRAFT_TOAST_RESTORED/.test(apply), '恢复后必须 toast');
  });

  test('draftKey：路由参数优先，其次 AppStorage，最后默认键', () => {
    const body = builderBody('resolveDraftKey');
    assert.ok(/params\['draftKey'\]/.test(body), '优先读路由参数 draftKey');
    assert.ok(/AppStorage\.get<string>\('handwriting\.draftKey'\)/.test(body), '其次读 AppStorage');
    assert.ok(/DRAFT_KEY_DEFAULT/.test(body), '兜底默认键');
    assert.ok(/sanitizeDraftKey/.test(body), '必须清洗 key（防目录穿越）');
  });

  test('草稿上限：≤10 页 / ≤2MB，超限提示固定文案', () => {
    assert.ok(/const DRAFT_TOAST_TOO_LARGE: string = '草稿过大，已只保留前 10 页';/.test(code), '超限文案必须是定版的');
    assert.ok(/fitDraftToLimits\(doc, DRAFT_MAX_PAGES, DRAFT_MAX_BYTES\)/.test(builderBody('saveDraftNow')), '必须走 fitDraftToLimits');
    // 空内容不写盘（避免下次进来恢复出空白）
    assert.ok(/!hasContent\(doc\)/.test(builderBody('saveDraftNow')), '空草稿不得写盘');
  });
});
