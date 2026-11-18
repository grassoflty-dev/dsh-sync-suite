// 手写板竖屏工具条「布局断言」（源码级，防真机回归）。
//
// 背景（真机 1600×2560 竖屏实测）：菜单栏「只显示钢和向下箭头，没有显示钢笔」、
// 粗细微菜单 5 个选项空白、删除页的「−」看不见、最右「完成」被省略号截断。
// 根因：按钮给了**固定窄宽**（38/44vp）+ 单字文案，内容放不下就被截断。
//
// 用户定版（本文件即验收口径）：
//   - 按钮**宽度按内容自适应**：只给 `constraintSize({ minWidth })` + `padding 8/8` +
//     `flexShrink(0)`，**不得再给固定 `width`**；
//   - 笔形按钮显示**当前笔刷名**（钢笔/圆珠笔/铅笔/马克笔/荧光笔）+ ▾；
//     粗细按钮显示「当前档位圆点 + 数值 + ▾」；颜色按钮显示「20×20 色块 + ▾」；
//   - 整行横向 `Scroll`（`BarState.Off`），溢出滚动、不换行、不压缩、不省略；
//   - 二级菜单每项 `minWidth ≥ 140`；粗细行显示「圆点 + `N vp`」；笔形行「图标 + 名称 + ✓」；
//     颜色行「28×28 色块 + 名称 + ✓」；
//   - 页面禁止 `TextOverflow.Ellipsis`；工具条/面板 `Text` 必须 `maxLines(1)`。
//
// **2026-11-16 定版变更**：工具条尺寸不再写死（原来是 48 / 72 / 44 / 40），改为
// `model/toolbarMetrics` 按「视口宽高 + 横竖屏」算出来；本文件里所有尺寸断言都改成
// 「引用 metrics 派生方法」，纯函数的数值断言在 `toolbarMetrics.test.mjs`。
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

/**
 * `topBar` 两行分支的行分配定版（2026-11-18）：第一行 7 个工具、第二行「分页组 + 完成」。
 *
 * 高频项（笔迹 / 橡皮 / 撤销）**必须在第一行**：它们是写字时每几秒就要按一次的键，
 * 落到第二行等于多一次眼手定位；第二行只放低频的翻页与「完成」。
 */
const TWO_ROW_ORDER = {
  first: ['CELL_EXIT', 'CELL_INK', 'CELL_ERASER', 'CELL_SELECT', 'CELL_INSERT', 'CELL_UNDO', 'CELL_REDO'],
  second: ['CELL_FINISH']
};

/** 只取 `topBar` 的**两行分支**（`} else {` 之前），按 `Row({ space: this.controlGap() })` 切成行区间。 */
function twoRowSegments(body) {
  const twoRows = body.split('} else {')[0];
  return twoRows.split('Row({ space: this.controlGap() })').slice(1);
}

/** 某段源码里按出现顺序取出的单元格 id（`this.buttonCell(CELL_XXX, …)`）。 */
function cellIdsOf(segment) {
  return [...(segment ?? '').matchAll(/this\.buttonCell\((CELL_[A-Z]+)/g)].map((m) => m[1]);
}

/**
 * 「两行分支第一行含高频三项 + 9 项不重复」的判定函数。
 *
 * 纯函数（不碰源码文件），因此可以被**反向自测**喂进坏样本，证明断言不是空转。
 * 返回 problems 数组：空数组 = 通过。
 */
function highFrequencyProblems(body) {
  const rows = twoRowSegments(body);
  const first = rows[0] ?? '';
  const second = rows[1] ?? '';
  const problems = [];
  const count = (hay, token) => hay.split(token).length - 1;
  const cell = (id) => `this.buttonCell(${id},`;

  // 1) 行结构：两行分支必须正好两个 Row（一个 Row 装不下 9 项，三个 Row 说明又有人拆散）
  if (rows.length !== 2) problems.push(`两行分支必须正好两个 Row，实际 ${rows.length}`);

  // 2) 第一行 = 7 个工具单元格，顺序与定版逐项一致（含三项高频）
  const gotFirst = cellIdsOf(first);
  if (gotFirst.join('/') !== TWO_ROW_ORDER.first.join('/')) {
    problems.push(`第一行应为 ${TWO_ROW_ORDER.first.join('/')}，实际 ${gotFirst.join('/') || '(空)'}`);
  }

  // 3) 第二行 = 只有「完成」一个单元格，且排在分页组之后（分页组是 @Builder，不计入 buttonCell）
  const gotSecond = cellIdsOf(second);
  if (gotSecond.join('/') !== TWO_ROW_ORDER.second.join('/')) {
    problems.push(`第二行只允许 ${TWO_ROW_ORDER.second.join('/')}，实际 ${gotSecond.join('/') || '(空)'}`);
  }
  const stepAt = second.indexOf('this.pageStepper()');
  const finishAt = second.indexOf(cell('CELL_FINISH'));
  if (stepAt < 0) problems.push('第二行必须有分页组 this.pageStepper()');
  if (finishAt < 0) problems.push('第二行必须有「完成」');
  if (stepAt >= 0 && finishAt >= 0 && finishAt < stepAt) problems.push('「完成」必须在分页组之后');

  // 4) 高频三项：第一行各恰好 1 次，第二行 0 次（不许挪下去，也不许两行各放一份）
  for (const [label, id] of [['笔迹', 'CELL_INK'], ['橡皮', 'CELL_ERASER'], ['撤销', 'CELL_UNDO']]) {
    const inFirst = count(first, cell(id));
    const inSecond = count(second, cell(id));
    if (inFirst !== 1) problems.push(`第一行「${label}」必须恰好 1 次，实际 ${inFirst}`);
    if (inSecond !== 0) problems.push(`第二行不得有「${label}」（高频项必须在第一行），实际 ${inSecond}`);
  }

  // 5) 两行分支里 9 项总出现次数不变：每个标识恰好 1 次、合计 9（防有人在两行里多塞/漏放一份）
  const all = first + second;
  const nine = [...TWO_ROW_ORDER.first, ...TWO_ROW_ORDER.second, 'pageStepper'];
  let total = 0;
  for (const token of nine) {
    const n = count(all, token === 'pageStepper' ? 'this.pageStepper()' : cell(token));
    if (n !== 1) problems.push(`两行分支里 ${token} 必须恰好 1 次（9 项各一份），实际 ${n}`);
    total += n;
  }
  if (total !== 9) problems.push(`两行分支里 9 个控件的总出现次数必须是 9，实际 ${total}`);

  return problems;
}

describe('手写板工具条：宽度自适应与不截断', () => {
  test('尺寸下限：完成 ≥64 / 分页每半 ≥44 / 页码格 ≥64 / 菜单项 ≥140 / 行高 44 / chip 40', () => {
    const read = (name) => Number(new RegExp(`const ${name}: number = (\\d+(?:\\.\\d+)?);`).exec(code)?.[1]);
    assert.ok(read('FINISH_MIN_WIDTH') >= 64, '「完成」最小宽必须 ≥64');
    assert.equal(read('PAGER_HALF_MIN'), 44, '分页区每半硬下限必须是 44vp');
    assert.equal(read('PAGER_LABEL_MIN'), 64, '页码格硬下限必须是 64vp');
    assert.ok(read('MENU_MIN_WIDTH') >= 140, '菜单项最小宽必须 ≥140');
    assert.equal(read('MENU_ROW_HEIGHT'), 44);
    assert.equal(read('CHIP_HEIGHT'), 40);
    // 旧的写死尺寸常量必须消失（尺寸只来自 model/toolbarMetrics）
    for (const gone of ['TOOL_HEIGHT', 'RAIL_ITEM_HEIGHT', 'CELL_WIDTH', 'CELL_W_COMPACT', 'TOOL_MIN_WIDTH', 'EXIT_SIZE', 'TOP_BAR_HEIGHT', 'RAIL_WIDTH']) {
      assert.equal(new RegExp(`const ${gone}:`).test(code), false, `不得再有写死常量 ${gone}`);
    }
  });

  test('固定宽度清零：按钮容器不得给固定 width（图标内部允许），改用 minWidth(itemSize) + padding 自适应', () => {
    const body = builderBody('buttonCell');
    // 「完成」是唯一带固定宽的单元格（宽度由调用方给：finishWidth() / railWidth()）
    const finishBranch = body.slice(0, body.indexOf('} else {'));
    assert.ok(/\.width\(width\)/.test(finishBranch), '「完成」的宽度必须由调用方传（finishWidth()/railWidth()）');
    // 其余单元格：**内容自适应**——只给 minWidth + padding，不得给固定 width（给了就会被截断）
    const fluidBranch = body.slice(body.indexOf('} else {'));
    assert.equal(/\.width\(/.test(fluidBranch), false, '单元格容器不得给固定 width（会被截断）');
    assert.ok(
      /\.constraintSize\(\{ minWidth: layout === LAYOUT_RAIL \? this\.railWidth\(\) : this\.itemSize\(\) \}\)/.test(fluidBranch),
      '缺少 minWidth：竖屏 itemSize / 横屏 railWidth'
    );
    assert.ok(
      /\.padding\(\{\s*left: layout === LAYOUT_RAIL \? 0 : SPACING\.sm,\s*right: layout === LAYOUT_RAIL \? 0 : SPACING\.sm\s*\}\)/.test(
        fluidBranch
      ),
      '竖屏必须保留左右 8vp padding（内容自适应），横屏不额外加内边距'
    );
    assert.ok(/\.flexShrink\(0\)/.test(fluidBranch), '缺少 flexShrink(0)');
    // 图标（当前色块）内部仍允许显式宽高
    assert.ok(
      /\.width\(this\.iconSize\(\) \* 0\.6\)/.test(builderBody('cellContent')),
      '「笔迹」单元格的当前色块必须跟随 metrics.iconSize'
    );
  });

  test('「笔迹」按钮文案固定（不再拼接当前值，因此不会被裁）', () => {
    const label = builderBody('cellLabel');
    assert.ok(/return '笔迹';/.test(label), '文案表里「笔迹」必须固定（不拼接当前值）');
    assert.ok(/return '插入';/.test(label), '文案表里「插入」必须固定');
    const content = builderBody('cellContent');
    assert.ok(/this\.cellText\(id\)/.test(content), '笔迹单元格必须用统一文字');
    assert.ok(/this\.cellArrow\(id\)/.test(content), '笔迹单元格必须有 ▾');
    assert.equal(/inkSummary\(\)/.test(content), false, '按钮不得再显示 inkSummary（会被裁）');
    assert.equal(/·/.test(content), false, '按钮文案里不得出现「·」拼接');
    // 状态摘要仍保留（hilog / 草稿提示用），但不再进按钮
    const summary = builderBody('inkSummary');
    assert.ok(/currentBrushLabel\(\)/.test(summary), 'inkSummary 仍应包含笔刷名');
    assert.ok(/pagerState\.penWidth/.test(summary), 'inkSummary 仍应包含档位');
    // 笔形/粗细/颜色 三段全部并入「笔迹」：独立按钮一个都不能留
    for (const gone of ['sizeMenuButton', 'railSizeButton', 'colorMenuButton', 'railColorButton']) {
      assert.equal(new RegExp(gone).test(code), false, `不得再有 ${gone}（已并入笔迹）`);
    }
    // 成对 builder 全部删除：同一套语义只剩 buttonCell 一份
    for (const gone of [
      'brushMenuButton',
      'railBrushButton',
      'toolButton',
      'railToolButton',
      'insertMenuButton',
      'railInsertButton',
      'exitButton',
      'railExitButton',
      'historyButton',
      'railHistoryButton',
      'finishButton',
      'railFinishButton'
    ]) {
      assert.equal(new RegExp(gone).test(code), false, `不得再有 ${gone}（已并入 buttonCell）`);
    }
    // 文案字面量在源码里只出现一次 = 不再成对维护
    for (const literal of ["'笔迹'", "'橡皮'", "'手动框'", "'↶'", "'↷'", "'完成'"]) {
      const hits = code.split(literal).length - 1;
      assert.equal(hits, 1, `${literal} 只能出现一次（实际 ${hits} 次：说明又被复制了一份）`);
    }
    // 「插入」= 单元格文案 + 插入面板菜单项；「‹」= 退出单元格 + 上一页
    assert.equal(code.split("'插入'").length - 1, 2, '「插入」只允许「单元格文案 + 插入面板菜单项」各一处');
    assert.equal(code.split("'‹'").length - 1, 2, '「‹」只允许「退出单元格 + 上一页」各一处');
    for (const bar of ['topBar', 'railBar']) {
      const barBody = builderBody(bar);
      assert.ok(/this\.buttonCell\(CELL_INK, /.test(barBody), `${bar} 必须有「笔迹」单元格`);
      assert.equal(/sizeMenuButton|railSizeButton/.test(barBody), false, `${bar} 不得再渲染独立粗细按钮`);
      assert.equal(/colorMenuButton|railColorButton/.test(barBody), false, `${bar} 不得再渲染独立颜色按钮`);
    }
  });

  test('「笔迹设置」按钮带当前色块（角度随 metrics.iconSize，颜色永远可见）', () => {
    const content = builderBody('cellContent');
    assert.ok(
      /\.width\(this\.iconSize\(\) \* 0\.6\)/.test(content) && /\.height\(this\.iconSize\(\) \* 0\.6\)/.test(content),
      '笔迹单元格必须有跟随 metrics.iconSize 的当前色块'
    );
    assert.ok(/backgroundColor\(this\.pagerState\.penColor\)/.test(content), '色块必须是当前颜色');
    const summary = builderBody('inkSummary');
    assert.ok(/currentColorLabel\(\)/.test(summary), '文案必须含当前色名（钢笔 · 3.5 · 黑）');
  });

  test('竖屏顶部条**没有横向 Scroll**：工具项一屏排完，放不下就折行（缺陷 3 定版）', () => {
    const bar = builderBody('topBar');
    assert.equal(/Scroll\(/.test(bar), false, 'topBar 不得再包 Scroll（真机上工具项被滚走 = 按钮「消失」）');
    assert.equal(/\.scrollable\(/.test(bar), false, 'topBar 不得再设 scrollable');
    assert.equal(/ScrollDirection\.Horizontal/.test(bar), false, 'topBar 不得有横向滚动方向');
    // 一屏一行：9 项按顺序排在一个 Row 里，高度 = metrics.barThickness
    assert.ok(/Row\(\{ space: this\.controlGap\(\) \}\)/.test(bar), '顶部条必须是普通 Row（不是 Scroll）');
    assert.ok(/\.height\(this\.barThickness\(\)\)/.test(bar), '工具条一行高度必须取 metrics.barThickness（48~64vp）');
    // 折行分支：两行都用 barThickness 高，整体高度 = topBarHeight()
    assert.ok(/this\.topBarHeight\(\)/.test(bar), '折行分支的整体高度必须用 topBarHeight()');
  });

  test('「笔迹设置」面板 = 笔形 + 粗细 + 颜色 三段：标题、chip、档位格、色块、两条 1vp 分割线', () => {
    const panel = builderBody('overlayPanel');
    // 面板宽度 ≥260vp（三段后用户定版），且只在「笔迹设置」时用宽面板
    assert.ok(/const INK_PANEL_MIN_WIDTH: number = 260;/.test(code), 'INK_PANEL_MIN_WIDTH 必须是 260');
    assert.ok(/INK_PANEL_MIN_WIDTH \+ 2 \* SPACING\.sm/.test(builderBody('panelWidth')), '笔迹设置面板宽 = 260 + 两侧 padding');
    assert.ok(/\.constraintSize\(\{ minWidth: MENU_MIN_WIDTH \}\)/.test(panel), '面板仍要 ≥140 的下限兜底');

    // 三段小标题 + 总标题
    assert.ok(/Text\('笔迹设置'\)/.test(panel), '面板必须有「笔迹设置」标题');
    assert.ok(/Text\('笔形'\)/.test(panel), '面板必须有「笔形」小标题');
    assert.ok(/Text\('粗细'\)/.test(panel), '面板必须有「粗细」小标题');
    assert.ok(/Text\('颜色'\)/.test(panel), '面板必须有「颜色」小标题');

    // 段 1：5 个笔刷 chip（名称来自 BRUSHES，选中显示 ✓）
    assert.ok(/ForEach\(\s*BRUSHES/.test(panel), '笔形段必须遍历 5 种笔刷');
    assert.ok(/Text\(spec\.label\)/.test(panel), 'chip 必须显示笔刷名');
    assert.ok(/Text\('✓'\)/.test(panel), '选中 chip 必须显示 ✓');
    assert.ok(/Flex\(\{ direction: FlexDirection\.Row, wrap: FlexWrap\.Wrap/.test(panel), 'chip 必须可换行（窄屏两行）');
    assert.ok(/CHIP_HEIGHT/.test(panel), 'chip 触控高度必须用 CHIP_HEIGHT');
    assert.ok(/const CHIP_HEIGHT: number = 40;/.test(code), 'CHIP_HEIGHT 必须是 40（≥40 触控）');

    // 三条段之间各有 1vp 分割线（笔形→粗细、粗细→颜色）→ 至少 2 处
    const dividers = (panel.match(/Divider\(\)\s*\n\s*\.strokeWidth\(DIVIDER\)/g) ?? []).length;
    assert.ok(dividers >= 2, `段间应有 ≥2 条 1vp 分割线，实际 ${dividers}`);
    assert.ok(/\.color\(\$r\('app\.color\.divider'\)\)/.test(panel), '分割线颜色必须是 app.color.divider');

    // 段 2：5 个档位格（圆点 + 数值，等分，选中加粗描边 + 高亮）
    assert.ok(/ForEach\(\s*PEN_WIDTHS/.test(panel), '粗细段必须遍历 5 档');
    assert.ok(/\.width\(SIZE_DOTS\[index\]\)/.test(panel), '档位圆点必须显式 width');
    assert.ok(/\.height\(SIZE_DOTS\[index\]\)/.test(panel), '档位圆点必须显式 height');
    assert.ok(/\.borderRadius\(SIZE_DOTS\[index\] \/ 2\)/.test(panel), '档位圆点必须显式 borderRadius');
    assert.ok(/Text\(`\$\{width\}`\)/.test(panel), '档位格必须显示数值');
    assert.ok(/FontWeight\.Bold/.test(panel), '选中的档位数值必须加粗');

    // 段 3：5 个颜色（20×20 色块 + 色名，选中加 2vp 描边）
    assert.ok(/ForEach\(\s*PEN_COLORS/.test(panel), '颜色段必须遍历 5 种颜色');
    assert.ok(/Text\(COLOR_LABELS\[index\]\)/.test(panel), '颜色格必须显示色名');
    assert.ok(/width: this\.pagerState\.penColor === color \? 2 : 1/.test(panel), '选中色块必须加粗描边');
    assert.ok(/\.layoutWeight\(1\)/.test(panel), '档位格/颜色格必须等分');
  });

  test('点选项只生效、不关面板（方便连续调）；点面板外由 scrim 关', () => {
    for (const fn of ['pickBrush', 'pickWidth', 'pickColor']) {
      const body = builderBody(fn);
      assert.equal(/this\.panel = ''/.test(body), false, `${fn} 不得再关面板（用户要求连续调）`);
      assert.ok(/panel=open/.test(body), `${fn} 日志必须标明 panel=open`);
    }
    // 三个 pick 都被面板直接调用
    const panel = builderBody('overlayPanel');
    assert.ok(/this\.pickBrush\(spec\.kind\)/.test(panel), 'chip 点击必须直接 pickBrush');
    assert.ok(/this\.pickWidth\(width\)/.test(panel), '档位格点击必须直接 pickWidth');
    assert.ok(/this\.pickColor\(color\)/.test(panel), '颜色格点击必须直接 pickColor');
    // 点面板外仍能关（scrim 走 closeOverlays）
    assert.ok(/this\.closeOverlays\(\)/.test(builderBody('overlayScrim')), '点面板外必须走 closeOverlays 关闭');
  });

  test('禁止省略号：页面无 TextOverflow.Ellipsis，工具条/面板文字都有 maxLines(1)', () => {
    assert.equal(/TextOverflow\.Ellipsis/.test(code), false, '页面不得出现 TextOverflow.Ellipsis');
    const chrome = [
      'cellText',
      'cellArrow',
      'cellContent',
      'pageStepper',
      'buttonCell',
      'topBar',
      'railBar',
      'overlayPanel'
    ]
      .map((name) => builderBody(name))
      .join('\n');
    const texts = labelledTexts(chrome);
    assert.ok(texts.length >= 9, `工具条/面板里的文字 Text 太少：${texts.length}`);
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
    const chrome = ['pageStepper', 'insertDeleteCell', 'prevNextCell'].map((name) => builderBody(name)).join('\n');
    assert.equal(/\.opacity\(0?\.\d+\)/.test(chrome), false, '不得用 opacity 表达禁用态');
    assert.ok(/\.enabled\(/.test(chrome), '分页区的禁用必须用 enabled（只对 `−`/`+`/`‹`/`›` 这类页面动作）');
    // 回调类单元格相反：**不许**用 enabled（缺陷 4b：enabled=false 会变成「看着能点、点了没反应」）
    const cell = builderBody('buttonCell');
    const fluid = cell.slice(cell.indexOf('} else {'));
    assert.equal(/\.enabled\(/.test(fluid), false, '回调类单元格不得用 enabled 表达禁用');
    assert.equal(/\.opacity\(/.test(cell), false, '单元格禁用态不得用 opacity（只改字色）');
  });

  test('完成按钮：实底品牌蓝 + 白字 + 不收缩 + 竖屏 ≥64', () => {
    const body = builderBody('buttonCell');
    const finish = body.slice(0, body.indexOf('} else {'));
    assert.ok(/Button\(this\.busy \? '识别中' : '完成'\)/.test(finish), '完成必须是 Button（识别中文案变「识别中」）');
    assert.ok(/\.backgroundColor\(\$r\('app\.color\.brand'\)\)/.test(finish), '完成必须品牌蓝实底');
    assert.ok(/\.fontColor\(Color\.White\)/.test(finish), '完成必须白字');
    assert.ok(/\.flexShrink\(0\)/.test(finish), '完成不得被压缩');
    assert.ok(/constraintSize\(\{ minWidth: FINISH_MIN_WIDTH \}\)/.test(finish), '完成最小宽必须 ≥64');
    assert.ok(/\.width\(width\)/.test(finish), '完成宽度必须由调用方给（竖屏 finishWidth() / 横屏 railWidth()）');
    assert.ok(/\.height\(this\.itemSize\(\)\)/.test(finish), '完成高度 = metrics.itemSize');
    assert.ok(/\.padding\(\{ left: SPACING\.xs, right: SPACING\.xs \}\)/.test(finish), '完成必须收窄内部 padding，否则 2 字会被挤成 ...');
    assert.ok(/\.enabled\(!this\.busy\)/.test(finish), '识别中必须禁用');
    // 点击必须落到 onCellTap 的 CELL_FINISH 分支（分派表漏一项 = 按钮变成死的）
    assert.ok(
      /case CELL_FINISH:\s*\n\s*this\.finish\(\);/.test(builderBody('onCellTap')),
      '「完成」的点击必须在 onCellTap 里分派到 finish()'
    );
    assert.ok(
      /layout === LAYOUT_RAIL \? RADIUS\.sm : this\.itemSize\(\) \/ 2/.test(finish),
      '圆角必须按布局壳分档：横屏 RADIUS.sm（与 rail 其它控件一致）/ 竖屏 Button 默认胶囊（= 高度一半）'
    );
    // 宽度来源：两个壳各自给指标宽度
    assert.ok(
      /this\.buttonCell\(CELL_FINISH, LAYOUT_PORTRAIT, this\.finishWidth\(\)\)/.test(builderBody('topBar')),
      '竖屏完成宽 = finishWidth()'
    );
    assert.ok(
      /this\.buttonCell\(CELL_FINISH, LAYOUT_RAIL, this\.railWidth\(\)\)/.test(builderBody('railBar')),
      '横屏完成宽 = railWidth()'
    );
    // finishWidth 必须兜住 64 下限
    assert.ok(/Math\.max\(FINISH_MIN_WIDTH, this\.itemSize\(\)\)/.test(builderBody('finishWidth')), 'finishWidth() 必须 ≥64');
  });

  test('工具条顺序 = 退出/笔迹/橡皮/手动框/插入/撤销/重做/步进器/完成（9 项，无 Scroll）', () => {
    const bar = builderBody('topBar');
    const order = [
      'this.buttonCell(CELL_EXIT, LAYOUT_PORTRAIT',
      'this.buttonCell(CELL_INK, LAYOUT_PORTRAIT',
      'this.buttonCell(CELL_ERASER, LAYOUT_PORTRAIT',
      'this.buttonCell(CELL_SELECT, LAYOUT_PORTRAIT',
      'this.buttonCell(CELL_INSERT, LAYOUT_PORTRAIT',
      'this.buttonCell(CELL_UNDO, LAYOUT_PORTRAIT',
      'this.buttonCell(CELL_REDO, LAYOUT_PORTRAIT',
      'this.pageStepper()',
      'this.buttonCell(CELL_FINISH, LAYOUT_PORTRAIT'
    ];
    let cursor = -1;
    for (const token of order) {
      const at = bar.indexOf(token);
      assert.ok(at >= 0, `工具条缺少 ${token}`);
      assert.ok(at > cursor, `${token} 顺序不对`);
      cursor = at;
    }
    // 9 项一屏排完：没有任何一项被 Scroll 包住
    assert.equal(/Scroll\(/.test(bar), false, '工具条内不得出现 Scroll（否则工具项会被滚出屏幕）');
    // 计数：9 项在「一行 / 两行」两个分支里各一套 ⇒ 每项 2 次
    for (const token of order) {
      assert.equal(bar.split(token).length - 1, 2, `${token} 应在两个分支里各出现一次`);
    }
    // 9 项之外不许再冒出别的控件
    assert.equal((bar.match(/this\.buttonCell\(/g) ?? []).length, 16, '顶部条单元格调用数必须是 8 项 × 2 分支 = 16');
  });

  test('菜单开合有 hilog 自证标记 `[hw] menu=<name> open=<0|1>` / `[hw] ink …`', () => {
    assert.ok(/\[hw\] menu=\$\{name\} open=/.test(source), '缺少 [hw] menu=<name> open=<0|1> 日志');
    for (const marker of [
      '[hw] menu=none open=0',
      '[hw] tool=',
      '[hw] delete confirm stage=',
      '[hw] page insert',
      '[hw] page deleted',
      '[hw] ink brush='
    ]) {
      assert.ok(source.includes(marker), `缺少日志标记 ${marker}`);
    }
    // 选笔形 / 选档位都要打「组合 + 已关闭」，真机可对照按钮文案
    for (const fn of ['pickBrush', 'pickWidth']) {
      const body = builderBody(fn);
      assert.ok(/panel=open/.test(body), `${fn} 日志必须标明 panel=open（选完不关面板）`);
      assert.ok(/\[hw\] ink brush=/.test(body), `${fn} 必须打 [hw] ink 日志`);
    }
  });

  test('「笔迹设置」面板方位：竖屏向下展开、横屏向右展开，且不遮画布中心', () => {
    const left = builderBody('panelLeft');
    assert.ok(/this\.railTotalWidth\(\) \+ SPACING\.sm/.test(left), '横屏面板贴 rail 右侧展开、竖屏贴左边 8vp');
    const top = builderBody('panelTop');
    assert.ok(/this\.topBarTotalHeight\(\) \+ SPACING\.xs/.test(top), '竖屏面板在工具条下方（向下展开）');
    assert.ok(
      /this\.panel === PANEL_INK \? 0 : \(this\.panel === PANEL_INSERT \? 3 : 1\)/.test(top),
      '横屏：笔迹=rail 第 1 个（index 0）、插入=第 4 个（index 3）'
    );
    assert.ok(/this\.itemSize\(\) \+ this\.controlGap\(\)/.test(top), '横屏面板 Y 必须按当前控件高/间距算（跟着 metrics 走）');
    const width = builderBody('panelWidth');
    assert.ok(/INK_PANEL_MIN_WIDTH \+ 2 \* SPACING\.sm/.test(width), '笔迹设置面板宽 240+16');
  });
});

// ---------------------------------------------------------------------------
// 横屏 rail（真机 2560×1600 实测）：56vp 太窄 → 「手动框」截成「手动」、「完成」变「...」、
// 步进器 `−`/`+` 被挤出 rail。
//
// 2026-11-16 定版：rail 宽度改为 `metrics.barThickness`（56~84）驱动，并且**必须兜住**
// 分页区下限（每半 ≥44vp ⇒ 单元格 ≥89vp）与 3 字标签宽度，因此实际宽度 ≥89vp。
// ---------------------------------------------------------------------------

describe('手写板横屏 rail：宽度、纵向步进器与完整文案', () => {
  test('rail 宽度由 metrics.barThickness 驱动，并兜住「3 字标签 / 分页区下限」', () => {
    const body = builderBody('railWidth');
    assert.ok(/metrics\.barThickness/.test(body), 'railWidth() 必须以 metrics.barThickness 为主值');
    assert.ok(/metrics\.fontSize \* 3/.test(body), 'railWidth() 必须兜住 3 字标签的排版宽度');
    assert.ok(/this\.pagerCellWidth\(\)/.test(body), 'railWidth() 必须兜住分页区两半单元格（每半 ≥44vp）');
    // 表格化校验：三字标签在 18fp 下需要 54vp，加 4vp 余量 ⇒ 58；分页下限 89 ⇒ 取 89
    const labelNeed = 18 * 3 + 4;
    const pagerNeed = 2 * 44 + 1;
    const railWidth = Math.max(56, labelNeed, pagerNeed, Math.max(64, 72 * 1.1));
    assert.ok(railWidth >= 72, `横屏 rail 实际宽度 ${railWidth}vp 必须 ≥72（旧真机验收线）`);
  });

  test('rail 只放工具 + 三个分页单元格，「完成」压底固定（不再有独立的 rail 页码行）', () => {
    const bar = builderBody('railBar');
    assert.equal(/this\.railStepper\(\)/.test(bar), false, 'railBar 不得再用旧的整组步进器');
    assert.equal(/this\.pageStepper\(\)/.test(bar), false, 'railBar 不得直接用竖屏三单元格行（要纵向堆叠）');
    // 退出单元格在 rail 最上方（与竖屏同一个 buttonCell，只是换成 RAIL 壳）
    const exitAt = bar.indexOf('this.buttonCell(CELL_EXIT, LAYOUT_RAIL');
    const brushAt = bar.indexOf('this.buttonCell(CELL_INK, LAYOUT_RAIL');
    assert.ok(exitAt >= 0 && exitAt < brushAt, '`‹` 退出单元格必须在 rail 最上方（笔迹之前）');
    // 三个单元格纵向堆叠在工具之后、「完成」之前（宽度都取 railWidth()）
    const stepperAt = bar.indexOf('this.insertDeleteCell(this.railWidth())');
    const finishAt = bar.indexOf('this.buttonCell(CELL_FINISH, LAYOUT_RAIL');
    assert.ok(stepperAt > brushAt, '分页单元格必须在工具按钮之后');
    assert.ok(finishAt > stepperAt, '「完成」在最后（压底）');
    // 「完成」放在 Scroll 之外、用 layoutWeight 让滚动区吃掉余量
    assert.ok(/\.layoutWeight\(1\)/.test(bar), 'rail 滚动区必须 layoutWeight(1)，把「完成」压到底部');
    const scrollEnd = bar.indexOf('.align(Alignment.Top)');
    assert.ok(finishAt > scrollEnd, '「完成」必须在竖向 Scroll 之外（不随滚动跑掉）');
  });

  test('竖屏：分页三单元格与「完成」都在可视区内（两个分支各一套，无 Scroll 遮挡）', () => {
    const bar = builderBody('topBar');
    // 旧实现的两个 bug 都不许回来：横向 Scroll 包裹工具项 + pagerPinned 两分支
    assert.equal(/Scroll\(/.test(bar), false, '顶部条不得含 Scroll');
    assert.equal(/pagerPinned/.test(bar), false, 'pagerPinned 分支已作废（没有 Scroll 就没有「滚不滚得走」）');
    // 一行分支：顺序必须是 … 分页组 → 完成（分页组在完成左侧）
    const rowStart = bar.indexOf('} else {');
    assert.ok(rowStart > 0, '顶部条必须保留「两行 / 一行」两个分支');
    const row = bar.slice(rowStart);
    assert.ok(row.indexOf('this.pageStepper()') >= 0, '一行分支必须有分页组');
    assert.ok(
      row.indexOf('this.pageStepper()') < row.indexOf('this.buttonCell(CELL_FINISH'),
      '分页组必须在「完成」左侧（一行分支）'
    );
    // 两行分支：分页组 + 完成在**第二行**同一个 Row 里
    const twoRow = bar.slice(0, rowStart);
    assert.ok(/this\.topBarTwoRows\(\)/.test(twoRow), '两行分支必须以 topBarTwoRows() 为判据');
    const secondRowAt = twoRow.indexOf('this.pageStepper()');
    assert.ok(secondRowAt > 0, '两行分支第二行必须有分页组');
    assert.ok(
      twoRow.indexOf('this.buttonCell(CELL_FINISH') > secondRowAt,
      '两行分支里「完成」必须跟在分页组后面（同一个 Row）'
    );
    // 9 项在两个分支里都在（一行分支 7+1+1，两行分支 7 / 1+1）
    for (const tool of ['this.buttonCell(CELL_ERASER, LAYOUT_PORTRAIT', 'this.buttonCell(CELL_SELECT, LAYOUT_PORTRAIT']) {
      assert.ok(bar.indexOf(tool) >= 0, `工具单元格丢了：${tool}`);
    }
  });

  test('竖屏分页区放宽：每半 ≥44vp、页码格 ≥64vp、两半仍等分（不再压成 36vp 小格）', () => {
    const stepper = builderBody('pageStepper');
    for (const token of [
      'this.insertDeleteCell(this.pagerCellWidth())',
      'this.pageLabelCell(this.pagerLabelWidth())',
      'this.prevNextCell(this.pagerCellWidth())'
    ]) {
      assert.ok(stepper.includes(token), `竖屏分页区必须用指标宽度：${token}`);
    }
    // 竖屏 673.7×1077.9（真机 1600×2560 @2.375）下的实际数值：itemSize=64 → 每半 48、页码格 70.4
    const itemSize = 64;
    const half = Math.max(44, itemSize * 0.75);
    const cell = 2 * half + 1;
    const label = Math.max(64, itemSize * 1.1);
    assert.ok(half >= 44, `每半 ${half}vp 必须 ≥44vp`);
    assert.ok(label >= 64, `页码格 ${label}vp 必须 ≥64vp`);
    assert.ok(cell >= 2 * 44 + 1, `两半单元格 ${cell}vp 必须 ≥89vp`);
    // 两半换算成 px（@2.375）必须远超 44px 触控线
    assert.ok(half * 2.375 >= 44, `每半 ${(half * 2.375).toFixed(1)}px 必须 ≥44px`);
    // 横屏也用同一套单元格（宽度取 rail 宽度）
    const rail = builderBody('railBar');
    assert.ok(rail.includes('this.insertDeleteCell(this.railWidth())'), '横屏必须用 railWidth() 给分页单元格宽度');
  });

  test('rail 内控件尺寸统一：满 rail 宽 / 高 = metrics.itemSize / 同圆角 / 同底色', () => {
    // 横屏单元格 = buttonCell(..., LAYOUT_RAIL)：铺满 rail（minWidth = railWidth()），
    // 高 / 圆角 / 居中与竖屏是**同一份代码**（这正是本轮重构要去掉的成对重复）。
    const cell = builderBody('buttonCell');
    const fluid = cell.slice(cell.indexOf('} else {'));
    assert.ok(
      /minWidth: layout === LAYOUT_RAIL \? this\.railWidth\(\)/.test(fluid),
      'LAYOUT_RAIL 必须铺满 rail 宽（minWidth = railWidth()，等价于旧实现的 width 100%）'
    );
    assert.ok(/\.height\(this\.itemSize\(\)\)/.test(fluid), '单元格必须统一 metrics.itemSize 高');
    assert.ok(/\.borderRadius\(RADIUS\.sm\)/.test(fluid), '单元格必须统一圆角');
    assert.ok(/\.justifyContent\(FlexAlign\.Center\)/.test(fluid), '单元格内容必须水平居中');
    assert.equal(/\.width\('100%'\)/.test(cell), false, '单元格不得再固定 100% 宽（宽度只有 railWidth / 内容自适应两种）');
    // rail 里 7 个工具单元格全部走 RAIL 壳
    const rail = builderBody('railBar');
    for (const id of ['CELL_EXIT', 'CELL_INK', 'CELL_ERASER', 'CELL_SELECT', 'CELL_INSERT', 'CELL_UNDO', 'CELL_REDO']) {
      assert.ok(rail.includes(`this.buttonCell(${id}, LAYOUT_RAIL`), `rail 必须用 LAYOUT_RAIL 渲染 ${id}`);
    }
    // 三个分页单元格：宽度由调用方传（竖屏 pagerCellWidth / 横屏 railWidth），高与圆角统一
    for (const id of ['insertDeleteCell', 'pageLabelCell', 'prevNextCell']) {
      const body = builderBody(id);
      assert.ok(/\.width\(width\)/.test(body), `${id} 必须由调用方传宽度`);
      assert.ok(/\.height\(this\.itemSize\(\)\)/.test(body), `${id} 必须统一 metrics.itemSize 高`);
      assert.ok(/\.borderRadius\(RADIUS\.sm\)/.test(body), `${id} 必须统一圆角`);
      assert.ok(/\.backgroundColor\([\s\S]{0,120}?'#F/.test(body), `${id} 必须有底色`);
    }
    // 橡皮 / 手动框的底色（浅色档 #F1F3F5 系 + 深色档主题令牌）在单元格底色表里
    const background = builderBody('cellBackground');
    assert.ok(/'#F1F3F5'/.test(background), '橡皮/手动框的浅色底色必须在 cellBackground 里');
    assert.ok(/DARK_FALLBACK\.railFill/.test(background), '深色档必须走 theme 令牌');
    // 内容水平居中：文字单元格有 textAlign，笔迹/插入的内层 Row 由外层 justifyContent 居中
    assert.ok(/\.textAlign\(TextAlign\.Center\)/.test(builderBody('cellText')), '单元格文字必须水平居中');
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

    // 三个单元格：宽度由调用方传（竖屏 pagerCellWidth/pagerLabelWidth / 横屏 railWidth），高 itemSize、圆角统一
    for (const name of ['insertDeleteCell', 'pageLabelCell', 'prevNextCell']) {
      const body = builderBody(name);
      assert.ok(/\.width\(width\)/.test(body), `${name} 必须由调用方传宽度`);
      assert.ok(/\.height\(this\.itemSize\(\)\)/.test(body), `${name} 必须 metrics.itemSize 高`);
      assert.ok(/\.borderRadius\(RADIUS\.sm\)/.test(body), `${name} 必须统一圆角`);
    }
    assert.ok(/const PAGER_HALF_MIN: number = 44;/.test(code), '分页区每半下限必须是 44vp');
    assert.ok(/const PAGER_LABEL_MIN: number = 64;/.test(code), '页码格下限必须是 64vp');

    // 竖屏：一个 Row 里三个单元格（同一行），且用指标宽度
    const portrait = builderBody('pageStepper');
    assert.ok(/Row\(\{ space: this\.controlGap\(\) \}\)/.test(portrait), '竖屏分页区必须是横向 Row（间距 = metrics.gap）');
    let cursor = -1;
    for (const token of [
      'this.insertDeleteCell(this.pagerCellWidth())',
      'this.pageLabelCell(this.pagerLabelWidth())',
      'this.prevNextCell(this.pagerCellWidth())'
    ]) {
      const at = portrait.indexOf(token);
      assert.ok(at >= 0, `竖屏分页区缺少 ${token}`);
      assert.ok(at > cursor, `${token} 顺序不对（应为 [−|+] [n/m] [‹|›]）`);
      cursor = at;
    }
    assert.ok(/this\.pageStepper\(\)/.test(builderBody('topBar')), '竖屏顶部条必须用 pageStepper()');

    // 横屏：rail 里纵向堆叠同样三个单元格（railWidth()），且在「完成」之前
    const rail = builderBody('railBar');
    for (const token of [
      'this.insertDeleteCell(this.railWidth())',
      'this.pageLabelCell(this.railWidth())',
      'this.prevNextCell(this.railWidth())'
    ]) {
      assert.ok(rail.includes(token), `rail 缺少 ${token}`);
    }
    assert.ok(
      rail.indexOf('this.prevNextCell(this.railWidth())') < rail.indexOf('this.buttonCell(CELL_FINISH, LAYOUT_RAIL'),
      '三个单元格必须在「完成」之前'
    );
  });

  test('竖屏按钮仍是「内容自适应 + minWidth(itemSize)」（rail 的固定宽不要污染竖屏）', () => {
    const cell = builderBody('buttonCell');
    const fluid = cell.slice(cell.indexOf('} else {'));
    assert.ok(/\.flexShrink\(0\)/.test(fluid), '单元格缺少 flexShrink(0)');
    assert.ok(
      /minWidth: layout === LAYOUT_RAIL \? this\.railWidth\(\) : this\.itemSize\(\)/.test(fluid),
      '竖屏分支必须 minWidth(metrics.itemSize)'
    );
    assert.equal(/\.width\('100%'\)/.test(fluid), false, '竖屏分支不得固定 100% 宽');
    // 两个壳各用各的布局标识：竖屏只用 PORTRAIT，横屏只用 RAIL
    const portrait = builderBody('topBar');
    assert.equal(/LAYOUT_RAIL/.test(portrait), false, '竖屏 topBar 不得使用 rail 布局壳');
    assert.equal((portrait.match(/LAYOUT_PORTRAIT/g) ?? []).length, 16, '竖屏顶部条 = 8 项 × 2 分支');
    const rail = builderBody('railBar');
    assert.equal(/LAYOUT_PORTRAIT/.test(rail), false, '横屏 rail 不得使用竖屏布局壳');
    assert.equal((rail.match(/LAYOUT_RAIL/g) ?? []).length, 8, '横屏 rail = 7 个工具单元格 + 完成');
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

  test('rail 12 项在 itemSize=72 时超出真机可用高度（≈601vp），因此必须给竖向 Scroll，「完成」固定在 Scroll 之外', () => {
    const bar = builderBody('railBar');
    // 尺寸改成自适应后（最大 72vp），12 项放不下 ⇒ 中段必须可滚动
    assert.ok(/Scroll\(\)/.test(bar), 'rail 必须有竖向 Scroll（否则「完成」会被挤出屏幕）');
    assert.ok(/\.scrollable\(ScrollDirection\.Vertical\)/.test(bar), 'rail 的 Scroll 必须是竖向');
    assert.ok(!/Blank\(\)/.test(bar), '不再用 Blank() 压底（改由 layoutWeight(1) 的滚动区吃掉余量）');
    // 滚动区里 7 个工具单元格 + 3 个分页单元格，滚动区外 1 个「完成」
    const toolCells = (bar.match(/this\.buttonCell\(CELL_(?:EXIT|INK|ERASER|SELECT|INSERT|UNDO|REDO), LAYOUT_RAIL/g) ?? []).length;
    assert.equal(toolCells, 7, 'rail 工具单元格应为 7 个（退出/笔迹设置/橡皮/手动框/插入/撤销/重做）');
    // 真机横屏（1600×2560 @2.375 = 673.7vp 高）下的实际值：itemSize = 72、gap = 10.8
    const item = 72;
    const gap = Math.max(8, item * 0.15);
    const padding = 8; // SPACING.sm，rail 上下 padding
    const items = toolCells + 3 /* [−|+] [n/m] [‹|›] */ + 1 /* 完成 */;
    const content = item * items + gap * (items - 1) + padding * 2;
    assert.ok(content > 601, `rail 内容 ${content.toFixed(1)}vp 已超真机可用 601vp，必须靠 Scroll 才不裁切`);
    // 「完成」在 Scroll 之外（固定底部）
    const finishAt = bar.indexOf('this.buttonCell(CELL_FINISH, LAYOUT_RAIL');
    assert.ok(finishAt > bar.indexOf('.align(Alignment.Top)'), '「完成」必须在竖向 Scroll 之后（不随滚动跑掉）');
  });

  test('竖屏「完成」永远在同一屏内（一行在右端、两行在第二行末，不被滚走也不被裁掉）', () => {
    const bar = builderBody('topBar');
    assert.equal(/Scroll\(/.test(bar), false, '顶部条不得含 Scroll（「完成」靠布局而不是靠滚动保证可见）');
    const token = 'this.buttonCell(CELL_FINISH, LAYOUT_PORTRAIT, this.finishWidth())';
    assert.ok(bar.indexOf(token) > 0, '顶部条必须有「完成」');
    // 两个分支都要有「完成」，且排在分页组之后
    assert.equal(bar.split(token).length - 1, 2, '「完成」必须在一行 / 两行两个分支里各出现一次');
    assert.ok(
      /this\.pageStepper\(\)\s*\n\s*this\.buttonCell\(CELL_FINISH/.test(bar),
      '两个分支里「完成」都必须紧跟分页组（布局固定，不依赖滚动）'
    );
  });

  test('颜色并入面板：色名表 + 面板内 5 个色块（工具条不再有颜色按钮）', () => {
    assert.ok(/COLOR_LABELS: string\[\] = \['黑', '红', '蓝', '绿', '橙'\]/.test(code), '色名表必须是 黑/红/蓝/绿/橙');
    const panel = builderBody('overlayPanel');
    assert.ok(/Text\(COLOR_LABELS\[index\]\)/.test(panel), '颜色段必须显示色名');
    assert.ok(/ForEach\(\s*PEN_COLORS/.test(panel), '颜色段必须遍历 5 种颜色');
    assert.ok(/\.width\(20\)/.test(panel) && /\.height\(20\)/.test(panel), '颜色色块必须 20×20');
    for (const bar of ['topBar', 'railBar']) {
      assert.equal(/colorMenuButton|railColorButton/.test(builderBody(bar)), false, `${bar} 不得再有颜色按钮`);
    }
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
    // rail 容器宽度 = railWidth + 1
    assert.ok(/\.width\(this\.railWidth\(\) \+ DIVIDER\)/.test(bar), 'rail 容器宽 = railWidth() + DIVIDER');
  });

  test('横屏 rail 底色略浅且不投影（浅色档 RAIL_BG / 深色档 theme 令牌）', () => {
    const bar = builderBody('railBar');
    // 第 4 轮起 rail 底色走 `railBackground()`：浅色档仍是 RAIL_BG，深色档取 theme.ts 的深色回退，
    // 否则深色主题下会出现「浅灰条 + 浅灰字」看不见。
    assert.ok(/\.backgroundColor\(this\.railBackground\(\)\)/.test(bar), 'rail 必须用 railBackground()（深浅两档）');
    assert.ok(/const RAIL_BG: string = '#F7F9FB';/.test(code), 'RAIL_BG 仍是浅色档 #F7F9FB');
    assert.ok(/railBackground\(\): ResourceColor \{\s*return this\.isDarkTheme\(\) \? DARK_FALLBACK\.railFill : RAIL_BG;/.test(code), 'railBackground 必须按深浅返回不同值');
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
    const total = builderBody('topBarTotalHeight');
    assert.ok(/this\.topBarHeight\(\) \+ DIVIDER/.test(total), '顶部条高度必须 = topBarHeight()（一行/两行各自的高度）+ DIVIDER');
    assert.ok(/this\.landscape \? 0 :/.test(total), '顶部条高度只在竖屏非 0');
    // 折行后高度必须翻倍，否则第二行会被 build() 的 clip(true) 裁掉
    const height = builderBody('topBarHeight');
    assert.ok(/2 \* this\.barThickness\(\)/.test(height), '两行时顶部条高度必须 = 2 × metrics.barThickness');
    assert.ok(/this\.topBarTwoRows\(\)/.test(height), '高度必须由 topBarTwoRows() 决定');
    assert.ok(/\.height\(this\.topBarTotalHeight\(\)\)/.test(build), 'build 必须用 topBarTotalHeight()');
  });
});

// ---------------------------------------------------------------------------
// 退出暂存 + 再进恢复（用户原话：「手写板没有退出按钮，退出后应该要暂存当前手写页的所有内容，
// 可以后续进入再修改，完成才是按照要求做 OCR。」）
// ---------------------------------------------------------------------------

describe('手写板退出：按钮 / 系统返回 / 草稿落盘', () => {
  test('竖屏工具条最左侧有「‹」退出按钮（itemSize 见方，在 Scroll 之外）', () => {
    assert.ok(/case CELL_EXIT:\s*\n\s*return '‹';/.test(builderBody('cellLabel')), '退出单元格必须是「‹」');
    const bar = builderBody('topBar');
    assert.equal(
      bar.indexOf('this.buttonCell(CELL_EXIT, LAYOUT_PORTRAIT'),
      bar.search(/this\.buttonCell\(/),
      '退出必须是顶部条的第一个单元格'
    );
    // 点击 = 存草稿 → 返回（不二次确认），走 switch 分派
    const tap = builderBody('onCellTap');
    assert.ok(/case CELL_EXIT:\s*\n\s*this\.exitWritingBoard\(\);/.test(tap), '点击必须走 exitWritingBoard()');
    assert.equal(/confirmStage/.test(tap), false, '退出不得弹二次确认');
    // 尺寸：内容自适应 + minWidth(itemSize)，不给固定宽；
    // 数值自证：单字「‹」（≤ fontSize 上限 18vp）+ 左右 8vp = 34vp < itemSize 下限 40vp
    // ⇒ 实际宽 = max(内容, minWidth) = itemSize，仍是「itemSize 见方」，与改成 minWidth 之前一致。
    assert.ok(
      /minWidth: layout === LAYOUT_RAIL \? this\.railWidth\(\) : this\.itemSize\(\)/.test(builderBody('buttonCell')),
      '竖屏单元格 minWidth = metrics.itemSize'
    );
    const oneGlyphWidth = 18 + 2 * 8; // fontSize 上限 + 左右 SPACING.sm
    assert.ok(oneGlyphWidth < 40, `单字单元格内容 ${oneGlyphWidth}vp < itemSize 下限 40vp ⇒ 实际宽 = minWidth = itemSize 见方`);
    assert.equal(/\.opacity\(/.test(builderBody('buttonCell')), false, '退出单元格不得透明');
  });

  test('横屏 rail 顶部有「‹」退出按钮（满 rail 宽 × itemSize 高）', () => {
    assert.ok(/case CELL_EXIT:\s*\n\s*return '‹';/.test(builderBody('cellLabel')), '退出单元格必须是「‹」');
    const cell = builderBody('buttonCell');
    assert.ok(/minWidth: layout === LAYOUT_RAIL \? this\.railWidth\(\)/.test(cell), '横屏必须铺满 rail 宽');
    assert.ok(/\.height\(this\.itemSize\(\)\)/.test(cell), '高度 = metrics.itemSize');
    assert.ok(/\.flexShrink\(0\)/.test(cell), '退出单元格不得被压缩');
    const bar = builderBody('railBar');
    assert.ok(/this\.buttonCell\(CELL_EXIT, LAYOUT_RAIL/.test(bar), 'railBar 必须渲染退出单元格');
    assert.ok(
      bar.indexOf('this.buttonCell(CELL_EXIT, LAYOUT_RAIL') < bar.indexOf('this.buttonCell(CELL_INK, LAYOUT_RAIL'),
      '退出在 rail 最上方'
    );
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

// ---------------------------------------------------------------------------
// B3 步 1：完成流程（遮罩 + 占位符 + 反馈）的源码级集成断言
// ---------------------------------------------------------------------------

describe('完成流程：对象遮罩、占位符与完成反馈', () => {
  test('finish() 合并了 objectsToMask 的矩形（插入对象区域不送 OCR）', () => {
    const finish = builderBody('finish');
    assert.match(finish, /mergeObjectMasks\(/, 'finish 必须把插入对象合并进遮罩');
    assert.match(finish, /pageRegions: maskRegions/, '传给 OCR 的必须是合并后的遮罩');
    const merge = builderBody('mergeObjectMasks');
    assert.match(merge, /objectsToMask\(/, '合并逻辑必须调用 objectsToMask（唯一开关点）');
    assert.match(merge, /objectsOfPage\(this\.objectsByPage/, '遮罩必须按页取对象（不串页）');
  });

  test('正文占位符按 y 升序拼装，且图片/表格各用自己的文案', () => {
    const compose = builderBody('composeBodyWithObjects');
    assert.match(compose, /sortObjectsByPosition\(/, '占位符必须按 y 升序（同 y 按 x）');
    assert.match(compose, /placeholderOf\(object, index \+ 1\)/, '每页占位符要带页号');
    const one = builderBody('placeholderOf');
    assert.match(one, /tablePlaceholder\(rows, cols, pageNumber\)/, '表格用 tablePlaceholder');
    assert.match(one, /objectPlaceholder\(object, pageNumber\)/, '图片/框用 objectPlaceholder');
  });

  test('完成 toast 改成「已保存 N 页手迹」', () => {
    const finish = builderBody('finish');
    assert.match(finish, /已保存 \$\{result\.attachments\.length\} 页手迹/, 'toast 必须是「已保存 N 页手迹」');
    assert.equal(/识别完成：/.test(finish), false, '旧的「识别完成：…」文案必须去掉');
  });

  test('编辑页同时显示「手迹 N 页」（正文行 + 附件区）', () => {
    const editorPath = join(here, '..', '..', 'entry', 'src', 'main', 'ets', 'components', 'RecordEditorView.ets');
    const editor = readFileSync(editorPath, 'utf8');
    const hits = [...editor.matchAll(/手迹 \$\{this\.attachments\.length\} 页/g)];
    assert.ok(hits.length >= 2, `正文行与附件区都应有「手迹 N 页」，实际 ${hits.length} 处`);
  });
});

describe('表格逐格 OCR（B3 步 2）的源码级接线', () => {
  test('finish() 把 ocrEnabled 的表格收集成任务并传给 OCR（含 cellRegions 使用点）', () => {
    const finish = builderBody('finish');
    assert.match(finish, /tableTasks: this\.collectTableTasks\(ids\)/, 'finish 必须收集表格任务');
    const collect = builderBody('collectTableTasks');
    assert.match(collect, /tableOcrEnabled\(object\)/, '只收开启识别的表格');
    // cellRegions 在管理器里用（整页截图坐标系）
    const manager = readFileSync(join(here, '..', '..', 'entry', 'src', 'harmony', 'ets', 'ocr', 'OcrBatchManager.ets'), 'utf8');
    assert.match(manager, /cellRegions\(task\.rect, pageW, pageH, task\.rows, task\.cols\)/, '必须用 cellRegions 换算格子');
  });

  test('成功路径用 tableToMarkdown，失败路径回退 tablePlaceholder', () => {
    const manager = readFileSync(join(here, '..', '..', 'entry', 'src', 'harmony', 'ets', 'ocr', 'OcrBatchManager.ets'), 'utf8');
    assert.match(manager, /markdown: tableToMarkdown\(matrix\)/, '成功必须产出 Markdown');
    const compose = builderBody('composeBodyWithObjects');
    assert.match(compose, /markdowns\.get\(object\.id\)/, '正文优先用识别出的 Markdown');
    const one = builderBody('placeholderOf');
    assert.match(one, /tablePlaceholder\(rows, cols, pageNumber\)/, '失败/关闭回退占位符');
  });

  test('超时与失败格策略：每格 5s、总 60s、失败过半放弃', () => {
    const manager = readFileSync(join(here, '..', '..', 'entry', 'src', 'harmony', 'ets', 'ocr', 'OcrBatchManager.ets'), 'utf8');
    assert.match(manager, /TABLE_CELL_TIMEOUT_MS/, '每格超时用常量');
    assert.match(manager, /TABLE_OCR_TIMEOUT_MS/, '总超时用常量');
    assert.match(manager, /failed > Math\.floor\(cells\.length \/ 2\)/, '失败格数过半必须放弃该表');
    assert.match(manager, /表格识别超时，已保留原图/, '失败要有可读原因');
  });

  test('ocrEnabled 开关写回对象（赋值存在 + 重绘）', () => {
    const toggle = builderBody('toggleTableOcr');
    assert.match(toggle, /ocrEnabled: !tableOcrEnabled\(table\)/, '开关必须写回 ocrEnabled');
    assert.match(toggle, /this\.writeObjects\(/, '写回当前页');
    assert.match(toggle, /this\.redrawObjects\(\)/, '必须重绘（关闭后整块填白）');
    const insert = builderBody('insertTable');
    assert.match(insert, /canOcrTable\(rows, cols\)/, '插入时按 canOcrTable 决定是否识别');
    assert.match(insert, /表格超过 6×6，已关闭文字识别/, '超限必须提示');
  });
});

describe('reviewer 阻塞缺陷 D2 / D4 的源码级回归', () => {
  const managerPath = join(here, '..', '..', 'entry', 'src', 'harmony', 'ets', 'ocr', 'OcrBatchManager.ets');

  test('D2：cellRegions 数量 != rows*cols 时直接 failed（不产出空壳 Markdown）', () => {
    const manager = readFileSync(managerPath, 'utf8');
    assert.match(
      manager,
      /if \(cells\.length !== task\.rows \* task\.cols\) \{/,
      '必须有「格子数 !== rows*cols」的守卫'
    );
    assert.match(manager, /表格格子数异常：已保留原图/, '守卫要给可读原因');
    // 守卫必须在 tableToMarkdown 之前（否则空壳会先被拼出来）
    const guard = manager.indexOf('cells.length !== task.rows * task.cols');
    const markdown = manager.indexOf('markdown: tableToMarkdown(matrix)');
    assert.ok(guard > 0 && markdown > 0 && guard < markdown, '守卫必须早于 tableToMarkdown');
  });

  test('D4：超时/失败分支不直接 release（改由 deferredReleases 收尾释放）', () => {
    const manager = readFileSync(managerPath, 'utf8');
    const cellBodyStart = manager.indexOf('private async recognizeCell');
    assert.ok(cellBodyStart > 0, '找不到 recognizeCell 的定义');
    const cell = manager.slice(cellBodyStart, manager.indexOf('private async decodePixel'));
    assert.match(cell, /this\.deferredReleases\.push\(pixel\)/, '超时路径必须把 PixelMap 交给延迟释放');
    // 超时分支内不得出现 immediate release 调用
    const timeoutBranch = cell.slice(cell.indexOf('timedOut'), cell.indexOf('finally'));
    assert.equal(/this\.releasePixelMap\(/.test(timeoutBranch), false, '超时分支不得直接释放（use-after-release）');
    assert.match(manager, /private drainDeferred\(\): void/, '必须有整批收尾释放');
    assert.match(manager, /this\.drainDeferred\(\)/, 'run() 收尾必须调用 drainDeferred()');
  });
});

// ---------------------------------------------------------------------------
// 2026-11-18 用户报的 P0（本轮修复的静态回归）：
//   缺陷 3：竖屏顶部工具条被塞进横向 Scroll —— 工具项被滚出屏幕，用户以为「按钮没了」。
//           定版：删掉 Scroll，9 项一屏排完；极窄屏（<640vp 或实算放不下）**折成两行**。
//   缺陷 4：撤销 / 重做点不动 —— ①手势被 Scrollable 抢走 ②enabled=false 且状态不刷新。
//           定版：历史按钮 = `Row` + `.onClick`（不是裸 `Text`），禁用时仍可点并 toast。
//   缺陷 2：penOnly 开关搬到笔迹面板「更多」二级菜单（设置页那条由别人删）。
// ---------------------------------------------------------------------------

describe('缺陷 3：竖屏工具条 9 项一屏排完 / 极窄屏两行折行（绝不横向滚动）', () => {
  test('topBar 内不含 Scroll / scrollable / 横向滚动（一行 + 两行两个分支都是静态布局）', () => {
    const bar = builderBody('topBar');
    assert.equal(/Scroll\(/.test(bar), false, 'topBar 内不得出现 Scroll(');
    assert.equal(/\.scrollable\(/.test(bar), false, 'topBar 内不得出现 scrollable(');
    assert.equal(/ScrollDirection\.Horizontal/.test(bar), false, 'topBar 内不得出现横向滚动方向');
    assert.equal(/scrollBar\(/.test(bar), false, 'topBar 内不得设置滚动条');
    // 两个分支：if (this.topBarTwoRows()) { Column(两行) } else { Row(一行) }
    assert.ok(/if \(this\.topBarTwoRows\(\)\) \{/.test(bar), 'topBar 必须按 topBarTwoRows() 分两行 / 一行');
    assert.ok(/\} else \{/.test(bar), 'topBar 必须保留「一行」分支');
    const branches = bar.split('} else {');
    assert.equal(branches.length, 2, '顶部条只允许「两行 / 一行」两个分支');
    // 两行分支 = 两个 Row（第一行 7 个工具按钮、第二行分页组 + 完成）
    const twoRows = branches[0];
    assert.equal((twoRows.match(/Row\(\{ space: this\.controlGap\(\) \}\)/g) ?? []).length, 2, '两行分支必须是两个 Row');
    assert.ok(/Column\(\) {/.test(twoRows), '两行分支外层必须是 Column');
    // 一行分支 = 一个 Row
    assert.equal((branches[1].match(/Row\(\{ space: this\.controlGap\(\) \}\)/g) ?? []).length, 1, '一行分支必须是一个 Row');
  });

  test('折行判据：640vp 下限 + 按真实控件宽度实算（不是写死 / 不猜机型）', () => {
    assert.ok(/const TOP_BAR_SINGLE_ROW_MIN: number = 640;/.test(code), '必须有 640vp 的极窄屏下限常量');
    const rows = builderBody('topBarTwoRows');
    assert.ok(/this\.pageW < TOP_BAR_SINGLE_ROW_MIN/.test(rows), '低于 640vp 必须直接折行');
    assert.ok(/this\.topBarRequiredWidth\(\) > this\.pageW/.test(rows), '否则必须按实算宽度比较');
    assert.ok(/this\.landscape/.test(rows), '横屏 rail 不参与折行判断');
    // 宽度实算 = 7 个单控件 + 完成 + 笔迹额外 + 分页组 + 8 个间距 + 两侧 padding
    const required = builderBody('topBarRequiredWidth');
    assert.ok(/7 \* this\.itemSize\(\) \+ this\.finishWidth\(\)/.test(required), '9 项里的 8 个单控件必须逐个算进来');
    assert.ok(/this\.pagerTotalWidth\(\)/.test(required), '分页组宽度必须算进来');
    assert.ok(/8 \* this\.controlGap\(\)/.test(required), '8 个间距必须算进来');
    // 数值自证（真机 1600×2560 @2.375 ⇒ 673.7vp 宽、itemSize=64、gap=9.6）：
    const item = 64;
    const gap = Math.max(8, item * 0.15);
    const half = Math.max(44, item * 0.75);
    const pager = 2 * (2 * half + 1) + Math.max(64, item * 1.1) + 2 * gap;
    const requiredW = 7 * item + Math.max(64, item) + 2 * 8 + pager + 8 * gap + 2 * 8;
    assert.ok(requiredW > 673.7, `真机竖屏 ${requiredW.toFixed(1)}vp > 673.7vp：9 项一行物理上放不下 → 必须折两行`);
    // 每行都放得下（否则「折行」等于换一种裁切）
    const row1 = 7 * item + 2 * 8 + 6 * gap + 2 * 8;
    const row2 = pager + Math.max(64, item) + gap + 2 * 8;
    assert.ok(row1 <= 673.7, `第一行 ${row1.toFixed(1)}vp 必须放得下`);
    assert.ok(row2 <= 673.7, `第二行 ${row2.toFixed(1)}vp 必须放得下`);
    // 宽屏（≥1024vp）仍然一屏一行
    assert.ok(requiredW <= 1024, `${requiredW.toFixed(1)}vp ≤ 1024vp：宽屏必须是一行`);
  });

  test('9 个控件都在 topBar 里（退出/笔迹/橡皮/手动框/插入/↶/↷/分页组/完成，关键标识逐个点名）', () => {
    const bar = builderBody('topBar');
    const items = [
      ['退出', 'this.buttonCell(CELL_EXIT, LAYOUT_PORTRAIT'],
      ['笔迹', 'this.buttonCell(CELL_INK, LAYOUT_PORTRAIT'],
      ['橡皮', 'this.buttonCell(CELL_ERASER, LAYOUT_PORTRAIT'],
      ['手动框', 'this.buttonCell(CELL_SELECT, LAYOUT_PORTRAIT'],
      ['插入', 'this.buttonCell(CELL_INSERT, LAYOUT_PORTRAIT'],
      ['撤销', 'this.buttonCell(CELL_UNDO, LAYOUT_PORTRAIT'],
      ['重做', 'this.buttonCell(CELL_REDO, LAYOUT_PORTRAIT'],
      ['分页组', 'this.pageStepper()'],
      ['完成', 'this.buttonCell(CELL_FINISH, LAYOUT_PORTRAIT']
    ];
    assert.equal(items.length, 9, '定版就是 9 项');
    for (const [label, token] of items) {
      assert.ok(bar.includes(token), `topBar 缺少「${label}」（${token}）`);
      // 每个控件在一行 / 两行两个分支里各出现一次 = 2 次（分页组与完成也是 2 次）
      const times = bar.split(token).length - 1;
      assert.equal(times, 2, `「${label}」必须在一行/两行两个分支里各出现一次，实际 ${times} 次`);
    }
    // 9 项之外不许再冒出别的控件（防止有人又塞进一个「更多」把工具条挤爆）
    assert.equal((bar.match(/this\.buttonCell\(/g) ?? []).length, 16, '顶部条单元格调用数必须是 8 个 × 2 分支 = 16');
    assert.equal((bar.match(/this\.pageStepper\(\)/g) ?? []).length, 2, '分页组也必须两个分支各一次');
    // —— 本轮重构的核心不变量：每个单元格的语义只定义一次，不再「竖屏一套 / 横屏一套」——
    const labelBody = builderBody('cellLabel');
    const tapBody = builderBody('onCellTap');
    for (const id of ['CELL_EXIT', 'CELL_INK', 'CELL_ERASER', 'CELL_SELECT', 'CELL_INSERT', 'CELL_UNDO', 'CELL_REDO']) {
      assert.equal(labelBody.split(`case ${id}:`).length - 1, 1, `${id} 的文案只能定义一次`);
      assert.equal(tapBody.split(`case ${id}:`).length - 1, 1, `${id} 的点击只能定义一次`);
    }
    assert.equal((code.match(/private cellLabel\(/g) ?? []).length, 1, 'cellLabel 只能有一份');
    assert.equal((code.match(/private onCellTap\(/g) ?? []).length, 1, 'onCellTap 只能有一份');
    assert.equal((code.match(/  buttonCell\(/g) ?? []).length, 1, 'buttonCell 只能有一份定义');
    assert.equal((code.match(/  cellContent\(/g) ?? []).length, 1, 'cellContent 只能有一份定义');
    // 8 对旧 builder 一个都不能复活
    for (const gone of ['railExitButton', 'railBrushButton', 'railToolButton', 'railHistoryButton', 'railFinishButton']) {
      assert.equal(new RegExp(gone).test(code), false, `不得再有 ${gone}`);
    }
  });

  test('两行分支第一行必须含高频三项（笔迹/橡皮/撤销），第二行只放分页组 + 完成', () => {
    const bar = builderBody('topBar');
    const problems = highFrequencyProblems(bar);
    assert.deepEqual(problems, [], `两行分支行分配不对：${problems.join('；')}`);

    // 第一行控件原样清单（源码顺序，带 `CELL_*` id）：钉住 7 项 + 三项高频在第一行
    const rows = twoRowSegments(bar);
    assert.equal(rows.length, 2, '两行分支必须恰好两个 Row');
    assert.deepEqual(
      cellIdsOf(rows[0]),
      ['CELL_EXIT', 'CELL_INK', 'CELL_ERASER', 'CELL_SELECT', 'CELL_INSERT', 'CELL_UNDO', 'CELL_REDO'],
      '两行分支第一行 = 退出/笔迹/橡皮/手动框/插入/撤销/重做（高频三项必须在这一行）'
    );
    // 第二行只有「完成」（分页组是 @Builder，不在 buttonCell 计数里）
    assert.deepEqual(cellIdsOf(rows[1]), ['CELL_FINISH'], '两行分支第二行只允许「完成」');
    assert.equal(cellIdsOf(rows[0]).length + cellIdsOf(rows[1]).length, 8, '两行分支 buttonCell 总数 = 7 + 1 = 8');

    // —— 反向自测：判定函数不是空转（用 `.replace()` 造坏样本）——
    const [twoRows, oneRow] = bar.split('} else {');
    const undoLine = 'this.buttonCell(CELL_UNDO, LAYOUT_PORTRAIT, 0)';
    assert.equal(twoRows.split(undoLine).length - 1, 1, '前置条件：两行分支里撤销只出现一处');

    // (a) 把第一行的撤销整行删掉 → 必须判红
    const deleted = twoRows.replace(undoLine, '') + '} else {' + oneRow;
    const deletedProblems = highFrequencyProblems(deleted);
    assert.notDeepEqual(deletedProblems, [], '反向自测失败：删掉第一行的撤销后仍判绿（断言在空转）');
    assert.ok(
      deletedProblems.some((p) => p.includes('「撤销」')) && deletedProblems.some((p) => p.includes('第一行应为')),
      `反向自测必须点名撤销：${deletedProblems.join('；')}`
    );

    // (b) 把撤销从第一行挪到第二行（最可能发生的退化：不是消失，而是被「优化」下去）→ 也必须判红
    const moved = twoRows
      .replace(undoLine, '')
      .replace('this.pageStepper()', `this.pageStepper()\n          ${undoLine}`);
    const movedProblems = highFrequencyProblems(moved);
    assert.ok(
      movedProblems.some((p) => p.includes('第二行不得有「撤销」')),
      `反向自测失败：撤销被挪到第二行后没被抓到（${movedProblems.join('；')}）`
    );
    // 挪动不改变 9 项总数 ⇒ 只能靠「行分配」抓住它，正是这条断言存在的理由
    assert.equal(movedProblems.some((p) => p.includes('总出现次数')), false, '挪动不应改变 9 项总数（否则测的是计数不是行分配）');
  });
});

describe('缺陷 4：撤销 / 重做点不动（真按钮 + 响应式可用性 + 禁用仍可点）', () => {
  test('历史按钮是 Row + onClick，**不是** Text(...) + .enabled(...)', () => {
    const cell = builderBody('buttonCell');
    const fluid = cell.slice(cell.indexOf('} else {'));
    assert.ok(/Row\(\) \{/.test(fluid), '回调类单元格必须是 Row 容器（真正的可点组件）');
    assert.ok(/\.onClick\(\(\) => \{/.test(fluid), '单元格必须有 onClick');
    assert.equal(/\.enabled\(/.test(fluid), false, '历史单元格不得再用 .enabled（会变成「看着能点、点了没反应」）');
    // 反例：不允许「Text(...) 一直挂到 .enabled(」
    assert.equal(/Text\([^)]*\)[\s\S]*\.enabled\(/.test(fluid), false, '不得是 Text + enabled 的组合');
    // 点击 = onCellTap 的 switch 分支（不把闭包传进 @Builder）
    const tap = builderBody('onCellTap');
    assert.ok(
      /this\.onHistoryTap\('undo', this\.pagerState\.undoSteps > 0\)/.test(tap),
      '撤销必须走 onHistoryTap(kind, available)，且现读 undoSteps'
    );
    assert.ok(
      /this\.onHistoryTap\('redo', this\.pagerState\.redoAvailable\)/.test(tap),
      '重做必须走 onHistoryTap(kind, available)，且现读 redoAvailable'
    );
    assert.ok(/case CELL_UNDO:/.test(tap) && /case CELL_REDO:/.test(tap), '撤销/重做必须有分派分支');
    // 禁用只改字色：可用性在 cellTextColor 里按 id 现读
    assert.ok(/this\.historyAvailable\(id\)/.test(builderBody('cellTextColor')), '历史单元格字色必须读实时可用性');
    assert.equal(/\.opacity\(/.test(cell), false, '不得用 opacity 表达禁用');
    // 历史按钮不能在 Scrollable 容器里：顶部条没有 Scroll；rail 的 Scroll 是竖向
    assert.equal(/Scroll\(/.test(builderBody('topBar')), false, '顶部条不得含 Scroll（否则点按会被滚动手势吃掉）');
    assert.ok(
      /\.scrollable\(ScrollDirection\.Vertical\)/.test(builderBody('railBar')),
      'rail 保留竖向 Scroll（用户没投诉，别动）'
    );
    assert.equal(/ScrollDirection\.Horizontal/.test(code), false, '全页不得再有横向 ScrollDirection');
  });

  test('禁用态是响应式判断 + 点了有反馈：applyUndo/applyRedo 真被调用，没有可撤销时 toast', () => {
    const tap = builderBody('onHistoryTap');
    assert.ok(/this\.pagerState\.applyUndo\(\)/.test(tap), '撤销必须调用现有的 applyUndo()');
    assert.ok(/this\.pagerState\.applyRedo\(\)/.test(tap), '重做必须调用现有的 applyRedo()');
    assert.ok(/this\.touchUi\(\)/.test(tap), '撤销/重做之后必须 touchUi()（可用性会变）');
    assert.ok(/没有可撤销的笔画/.test(tap), '没有可撤销笔画时必须 toast 说明');
    assert.ok(/没有可重做的笔画/.test(tap), '没有可重做笔画时必须 toast 说明');
    assert.ok(/promptAction\.showToast/.test(tap), '必须用 toast 给反馈');
    // 可用性必须**渲染时现读** pagerState（不是构造时的一次性快照）：
    // 字色走 historyAvailable()，点击分派也在点下的那一刻现读
    const available = builderBody('historyAvailable');
    assert.ok(/this\.pagerState\.undoSteps > 0/.test(available), 'historyAvailable 必须读 pagerState.undoSteps');
    assert.ok(/this\.pagerState\.redoAvailable/.test(available), 'historyAvailable 必须读 pagerState.redoAvailable');
    const dispatch = builderBody('onCellTap');
    assert.ok(/this\.pagerState\.undoSteps > 0/.test(dispatch), '点击分派必须在点下时读 pagerState.undoSteps');
    assert.ok(/this\.pagerState\.redoAvailable/.test(dispatch), '点击分派必须在点下时读 pagerState.redoAvailable');
    // 布局壳不再自己快照可用性（唯一真相源在 pagerState / 单元格语义层）
    assert.equal(/undoSteps/.test(builderBody('topBar')), false, '顶部条只调单元格，不自己快照可用性');
    assert.equal(/redoAvailable/.test(builderBody('railBar')), false, 'rail 只调单元格，不自己快照可用性');
  });

  test('撤销栈变化会重建工具条：onStatsChange → onHistoryStats → touchUi（不靠 @Observed 碰运气）', () => {
    const build = builderBody('build');
    assert.ok(/onStatsChange: \(undoSteps: number, redoAvailable: boolean\) => \{/.test(build), 'build 必须接 onStatsChange');
    assert.ok(/this\.onHistoryStats\(undoSteps, redoAvailable\)/.test(build), 'onStatsChange 必须转给 onHistoryStats');
    const stats = builderBody('onHistoryStats');
    assert.ok(/this\.lastHistoryKey/.test(stats), '只在可用性变化时才重建（避免每笔都重绘）');
    assert.ok(/this\.touchUi\(\)/.test(stats), '可用性变化必须 touchUi() 触发工具条重建');
    // 抬笔（dirty）也要重建：画完第一笔撤销按钮必须立刻可用
    assert.ok(/this\.touchUi\(\);/.test(source.slice(source.indexOf('dirtyImpl'), source.indexOf('canvasReadyImpl'))), '抬笔存草稿时也要 touchUi()');
  });
});

describe('缺陷 1 / 2：仅手写笔输入（penOnly）接进画布与笔迹面板', () => {
  test('笔迹面板有「更多 ▸」二级入口 + 开关 + 说明文案', () => {
    const panel = builderBody('overlayPanel');
    assert.ok(/Text\('更多'\)/.test(panel), '笔迹面板底部必须有「更多」二级入口');
    assert.ok(/this\.toggleInkMore\(\)/.test(panel), '点「更多」必须走 toggleInkMore()');
    assert.ok(/if \(this\.inkMoreOpen\)/.test(panel), '「更多」必须是可展开的二级菜单');
    assert.ok(
      /Toggle\(\{ type: ToggleType\.Switch, isOn: this\.penOnlyInput \}\)/.test(panel),
      '开关必须绑定 this.penOnlyInput'
    );
    assert.ok(/this\.savePenOnlyInput\(isOn\)/.test(panel), '切换必须调 savePenOnlyInput(isOn)');
    assert.ok(/Text\('仅手写笔输入'\)/.test(panel), '开关标题必须是「仅手写笔输入」');
    assert.ok(/Text\('开启后手指不能写，只能用手写笔'\)/.test(panel), '必须有一行说明「开启后手指不能写，只能用手写笔」');
  });

  test('切换即落盘、并立刻传给画布（不需要退出重进）', () => {
    const save = builderBody('savePenOnlyInput');
    assert.ok(/settingsStore\.save\(\{ penOnlyInput: next \}/.test(save), '必须 settingsStore.save({ penOnlyInput }) 落盘');
    assert.ok(/this\.pagerState\.setPenOnlyInput\(next\)/.test(save), '必须先写画布状态（立刻生效）');
    assert.ok(
      save.indexOf('this.pagerState.setPenOnlyInput(next)') < save.indexOf('await settingsStore.save('),
      '顺序：先作用于画布，再落盘（落盘失败不该让开关变成假开关）'
    );
    assert.ok(/this\.penOnlyInput = !next;/.test(save), '落盘失败必须回退界面状态');
    // 进页面读设置并铺给画布
    const load = builderBody('loadPenOnlyInput');
    assert.ok(/settingsStore\.load\(/.test(load), '进页面必须从 settingsStore 读 penOnlyInput');
    assert.ok(/settings\.penOnlyInput === true/.test(load), '读出来的值必须按 === true 归一');
    assert.ok(/this\.pagerState\.setPenOnlyInput\(this\.penOnlyInput\)/.test(load), '读到的值必须传给画布');
    assert.ok(/this\.loadPenOnlyInput\(\)/.test(builderBody('aboutToAppear')), 'aboutToAppear 必须发起读取');
  });
});
