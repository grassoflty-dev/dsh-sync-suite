// 面板级布局 / 行为守卫（mod-shell-schedule-pane / S3+，源码级静态断言）。
//
// 与 shellLayout.test.mjs 的分工：那份钉「外壳几何 + 导航轨」；这份钉「面板本体契约」——
// 单 flex 层、列表高度纪律（横屏零高度 bug 类）、保活、双断点装配、默认 / 返回、
// 入口与 fallback 路由、占位诚实性、以及「面板不拥有全局导航」。
//
// 迁移韧性：每个面板 body 通过 pane(name) 解析，只认两处真值之一：
//   ① 旧形态：pages/Home.ets 里的内联 @Builder Name(...)；
//   ② 新形态：pages/panes/<Name>.ets 的 build()。
// 两者必须**恰好一处**拥有 body（XOR）；同时出现或同时缺失都直接失败。
// 因此 S3 抽壳前后这份测试都成立，不需要跟着搬锚点。
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { matchBrace, stripComments } from './helpers/etsSource.mjs';

const ETS = new URL('../../entry/src/main/ets/', import.meta.url);
const HOME = stripComments(readFileSync(new URL('pages/Home.ets', ETS), 'utf8'));
const RAIL = stripComments(readFileSync(new URL('components/shell/ShellRail.ets', ETS), 'utf8'));
const ENTRY = stripComments(readFileSync(new URL('entryability/EntryAbility.ets', ETS), 'utf8'));
const PANE_DIR = new URL('pages/panes/', ETS);
const MAIN_PAGES = JSON.parse(
  readFileSync(new URL('../../entry/src/main/resources/base/profile/main_pages.json', import.meta.url), 'utf8'));
const HARMONY_PAGES = JSON.parse(
  readFileSync(new URL('../../entry/src/harmony/resources/base/profile/main_pages.json', import.meta.url), 'utf8'));

const PANE_NAMES = ['DotsPane', 'SchedulePane', 'InstancesPane', 'CloudChatPane'];
/** 原始源码：模式分叉守卫用；`stripComments()` 会把 URL 字面量 `http://` 后面的 `}` 截掉。 */
const PANE_RAW = new Map(
  PANE_NAMES.map((name) => [name, readFileSync(new URL(`${name}.ets`, PANE_DIR), 'utf8')])
);
/**
 * 剩余占位：日程（S3）与远程 DSH（mod-shell-instances-pane）都已是真 body；
 * 只有 dots / 云端对话仍是「即将迁入」占位。
 */
const SCAFFOLDS = [
  { name: 'DotsPane', action: '新建对话', reason: 'REASON_DOTS', empty: '还没有 dots 对话' },
  { name: 'CloudChatPane', action: '新建对话', reason: 'REASON_CLOUD', empty: '本页暂不展示任何记录。' }
];

/** 取 marker 之后那对花括号的内部文本。 */
function blockAfter(source, marker) {
  const at = source.indexOf(marker);
  assert.notEqual(at, -1, `找不到 ${marker}`);
  const brace = source.indexOf('{', at);
  assert.notEqual(brace, -1, `${marker} 后面没有花括号`);
  const [start, end] = matchBrace(source, brace);
  return source.slice(start + 1, end - 1);
}

// mod-instances-pane-readonly：同一个 InstancesPane 两种模式，按门控块切只读 / 配置可见源码。
const CONFIG_GATE = 'if (this.configurable) {';
const CONFIG_BUILDER = '\n  FormPanel() {';

function configRegions(source) {
  const out = [];
  let at = source.indexOf(CONFIG_GATE);
  while (at >= 0) {
    const [start, end] = matchBrace(source, source.indexOf('{', at));
    out.push(source.slice(start + 1, end - 1));
    at = source.indexOf(CONFIG_GATE, end);
  }
  const builderAt = source.indexOf(CONFIG_BUILDER);
  if (builderAt >= 0) {
    const [start, end] = matchBrace(source, source.indexOf('{', builderAt));
    out.push(source.slice(start + 1, end - 1));
  }
  return out;
}

function readonlyRegions(source) {
  let result = source;
  for (const marker of [CONFIG_GATE, CONFIG_BUILDER]) {
    let at = result.indexOf(marker);
    while (at >= 0) {
      const [start, end] = matchBrace(result, result.indexOf('{', at));
      result = result.slice(0, start) + ' '.repeat(end - start) + result.slice(end);
      at = result.indexOf(marker, end);
    }
  }
  return result;
}

/** 取 `X({...}) { ... }` 这类「配置对象 + builder 体」构造器的 builder 体（跳过第一对花括号）。 */
function configuredBlockAfter(source, marker) {
  const at = source.indexOf(marker);
  assert.notEqual(at, -1, `找不到 ${marker}`);
  const configBrace = source.indexOf('{', at);
  const [, configEnd] = matchBrace(source, configBrace);
  const bodyBrace = source.indexOf('{', configEnd);
  const [start, end] = matchBrace(source, bodyBrace);
  return source.slice(start + 1, end - 1);
}

/** 取 index 之前最近的 `Column() { ... }` 连同紧随其后的属性链（layoutWeight 挂在闭合括号之后）。 */
function columnWithAttributesBefore(body, index) {
  const at = body.lastIndexOf('Column() {', index);
  assert.ok(at >= 0, '目标调用之前必须有一个 Column() 包裹层');
  const [start, end] = matchBrace(body, body.indexOf('{', at));
  let tailEnd = end;
  let cursor = end;
  while (cursor < body.length) {
    const nl = body.indexOf('\n', cursor);
    if (nl === -1) {
      break;
    }
    const lineStart = nl + 1;
    const nextNl = body.indexOf('\n', lineStart);
    const line = body.slice(lineStart, nextNl === -1 ? body.length : nextNl).trimStart();
    if (!line.startsWith('.')) {
      break;
    }
    tailEnd = nextNl === -1 ? body.length : nextNl;
    cursor = tailEnd;
  }
  return body.slice(start, tailEnd);
}

// ---------------------------------------------------------------- 迁移鲁棒的面板解析

const paneCache = new Map();
/**
 * 解析一个面板：`Home.ets` 内联 @Builder 与 `pages/panes/<Name>.ets` 必须恰好一处拥有 body。
 * 这是本次迁移的核心断言——两处并存会双份渲染，两处皆无则面板消失。
 */
function pane(name) {
  if (paneCache.has(name)) {
    return paneCache.get(name);
  }
  const inlineAt = HOME.indexOf(`\n  ${name}(`);
  const file = new URL(`${name}.ets`, PANE_DIR);
  const external = existsSync(file);
  assert.ok(
    (inlineAt >= 0) !== external,
    `${name}: body 必须恰好一处拥有（Home 内联=${inlineAt >= 0}, pages/panes/${name}.ets=${external}）`
  );
  const resolved = external
    ? {
      name,
      where: `pages/panes/${name}.ets`,
      source: stripComments(readFileSync(file, 'utf8')),
      body: blockAfter(stripComments(readFileSync(file, 'utf8')), '\n  build() ')
    }
    : { name, where: 'pages/Home.ets (inline @Builder)', source: HOME, body: blockAfter(HOME, `\n  ${name}(`) };
  paneCache.set(name, resolved);
  return resolved;
}

const BUILD = blockAfter(HOME, '\n  build() ');
const STACK_MARKER = 'Stack({ alignContent: Alignment.TopStart })';

/** 内容面板 Stack = build() 里的第二处 Stack（第一处是只放覆盖层的 root Stack）。 */
function contentStackBody() {
  const first = BUILD.indexOf(STACK_MARKER);
  const second = BUILD.indexOf(STACK_MARKER, first + STACK_MARKER.length);
  assert.ok(first >= 0 && second > first, 'Home.build() 必须有两层 Stack：root 覆盖层 + 内容面板层');
  return configuredBlockAfter(BUILD.slice(second), STACK_MARKER);
}

describe('面板布局：单 flex 层 + 列表高度纪律 + 保活', () => {
  test('P-01 四个面板 body 恰好一处拥有（内联 @Builder XOR pages/panes/*.ets）', () => {
    for (const name of PANE_NAMES) {
      const p = pane(name);
      assert.ok(p.body.length > 0, `${name} 的 body 不得为空（${p.where}）`);
      assert.ok(p.source.length > 0, `${name} 的源文件不得为空`);
    }
    // 四个名字互不重复，且装配点都在 Home 的 build() 里（下面 P-07 再验顺序/无 if）。
    assert.equal(new Set(PANE_NAMES).size, 4);
  });

  test('P-02 唯一 flex 层：build() 仅一处 layoutWeight(1)，挂在内容 Stack 上', () => {
    const splits = BUILD.match(/layoutWeight\(1\)/g) ?? [];
    assert.equal(splits.length, 1, `build() 只允许一处结构性 layoutWeight(1)，实际 ${splits.length} 处`);
    assert.match(
      BUILD,
      /\}\s*\n\s*\.width\('100%'\)\s*\n\s*\.height\('100%'\)\s*\n\s*\.layoutWeight\(1\)/,
      '唯一的 flex 切分必须是包住四个面板的内容 Stack 的属性'
    );
    const rowAt = BUILD.indexOf('Row() {');
    assert.notEqual(rowAt, -1, '根容器里必须有一个横向 flex Row');
    const stackAt = BUILD.indexOf(STACK_MARKER, rowAt);
    assert.ok(stackAt > rowAt, '内容区必须是 Row 里的 Stack');
    assert.match(BUILD.slice(rowAt, stackAt), /ShellRail\(\{/, 'Row 的第一个 flex 子项必须是导航轨');
    assert.equal(/Column\(/.test(BUILD.slice(rowAt, stackAt)), false, 'Row 与内容 Stack 之间不得插入 Column 包裹层');
  });

  test('P-03 内容区是 Stack 且 height(100%)，没有嵌套固定高度 Column 包住面板', () => {
    const content = contentStackBody();
    assert.equal(/Column\(/.test(content), false, '内容 Stack 只能是面板叠放层，不得有布局 Column');
    assert.equal(/Scroll\(/.test(content), false, '内容 Stack 不得再包一层 Scroll');
    const tail = BUILD.slice(BUILD.indexOf(STACK_MARKER, BUILD.indexOf(STACK_MARKER) + STACK_MARKER.length));
    assert.match(tail, /\.height\('100%'\)/, '内容区必须 height(100%) 撑满');
    assert.equal(/\.height\(\s*\d+(\.\d+)?\s*\)/.test(tail.slice(0, 400)), false, '内容区不得写死 vp 高度');
  });

  test('P-04 日程记录 List 自带 layoutWeight(1)（横屏零高度修复不回退）', () => {
    const schedule = pane('SchedulePane');
    const rows = blockAfter(schedule.source, '\n  ListRows() ');
    assert.match(rows, /List\(\)\s*\{/, '列表行必须由 List 承载');
    assert.match(rows, /\.layoutWeight\(1\)/, '记录 List 必须持有 layoutWeight(1)，拿到余量');
    assert.equal(/\.height\(\s*\d+(\.\d+)?\s*\)/.test(rows), false, '记录 List 不得写死 vp 高度');
    assert.match(rows, /ForEach\(\s*this\.visibleRecords/, '列表源必须是真实记录');
    assert.match(rows, /RecordRow\(\{/, '列表行装配 RecordRow');
  });

  test('P-05 SummaryCard 是有界固定高度兄弟（wide 下 maxHeight），不与列表争高度', () => {
    const schedule = pane('SchedulePane');
    const card = blockAfter(schedule.source, '\n  SummaryCard() ');
    assert.match(card, /Scroll\(\)\s*\{/, '汇总块自身可滚动');
    assert.match(card, /\.constraintSize\(\{\s*maxHeight:/, '汇总块必须封顶，不再是列表区的竞争者');
    assert.match(schedule.source, /SUMMARY_BOX_MAX_HEIGHT/, '封顶高度必须走命名常量');
    // 封顶是根 Scroll 的属性链，不是另一个 layoutWeight 兄弟（块内标题的省略号不算切分）。
    assert.match(card, /\.constraintSize\(\{\s*maxHeight:\s*this\.masterDetail \? SUMMARY_BOX_MAX_HEIGHT/,
      '仅宽屏/横屏封顶；竖屏保持自然高');
  });

  test('P-06 两个断点的列表包在加权 Column 里，SummaryCard 永远是其兄弟', () => {
    const schedule = pane('SchedulePane');
    for (const builder of ['CompactBody', 'WideBody']) {
      const body = blockAfter(schedule.source, `\n  ${builder}() `);
      const listAt = body.indexOf('this.RecordList()');
      assert.ok(listAt >= 0, `${builder} 必须渲染 RecordList`);
      const wrapper = columnWithAttributesBefore(body, listAt);
      assert.match(wrapper, /this\.RecordList\(\)/, `${builder} 的列表包裹层必须直接包含 RecordList`);
      assert.match(wrapper, /\.layoutWeight\(1\)/, `${builder} 的列表包裹层必须吃余量`);
      assert.equal(/\.height\(\s*\d+(\.\d+)?\s*\)/.test(wrapper), false,
        `${builder} 的列表包裹层不得固定高度（否则列表被饿死）`);
      const wrapperAt = body.lastIndexOf('Column() {', listAt);
      const summaryAt = body.lastIndexOf('this.SummaryCard()', listAt);
      assert.ok(summaryAt >= 0 && summaryAt < wrapperAt, `${builder} 必须先渲染 SummaryCard 兄弟`);
    }
  });

  test('P-07 四面板在同一个 Stack 里无条件实例化，顺序固定、无 if/else 切换', () => {
    const content = contentStackBody();
    assert.equal((content.match(/Stack\(\{ alignContent/g) ?? []).length, 0, '四面板之间不得再嵌套 Stack');
    let previous = -1;
    for (const name of PANE_NAMES) {
      const at = content.search(new RegExp(`\\b(?:this\\.)?${name}\\(`));
      assert.ok(at >= 0, `内容 Stack 必须实例化 ${name}`);
      assert.ok(at > previous, `${name} 的顺序错乱`);
      previous = at;
    }
    const calls = content.match(/(?:this\.)?(?:Dots|Schedule|Instances|CloudChat)Pane\(/g) ?? [];
    assert.equal(calls.length, 4, '必须恰好四个面板装配');
    assert.equal(/\bif\s*\(/.test(content), false, '面板不得用 if/else 条件渲染（会卸载、丢 @State）');
    // active 判定必须在装配调用内（外部组件用 active: 命名 prop，可能跨行；旧内联形态用位置参数）。
    const nextPane = /\b(?:this\.)?(?:Dots|Schedule|Instances|CloudChat)Pane\(/g;
    for (const name of PANE_NAMES) {
      const at = content.search(new RegExp(`\\b(?:this\\.)?${name}\\(`));
      nextPane.lastIndex = at + 1;
      const following = nextPane.exec(content);
      const call = content.slice(at, following === null ? content.length : following.index);
      assert.match(call, /this\.section === SHELL_SECTION_[A-Z_]+/, `${name} 必须收到 active 分段判定`);
    }
  });

  test('P-08 保活：四面板都用 Visible/Hidden（非 None），抽屉轨才允许 None', () => {
    for (const name of PANE_NAMES) {
      const p = pane(name);
      assert.match(p.body, /\.visibility\(this\.active \? Visibility\.Visible : Visibility\.Hidden\)/,
        `${name}（${p.where}）必须保持 active→Visible/Hidden 保活接线`);
      assert.equal(/Visibility\.None/.test(p.body), false, `${name} 不得用 None 卸载`);
    }
    assert.match(HOME, /\.visibility\(this\.drawerOpen \? Visibility\.Visible : Visibility\.None\)/,
      'Visibility.None 只允许出现在抽屉轨的挂起上');
  });

  test('P-09 双布局：wide 走常驻轨、compact 走抽屉，断点复用 resolveBreakpoint/isLandscapeSize', () => {
    assert.match(HOME, /resolveBreakpoint\(width, isLandscapeSize\(width, height\)\)/,
      '断点必须复用 uiTokens 同一判据');
    assert.match(HOME, /@State breakpoint: string = 'compact';/, '初始断点为 compact');
    assert.match(HOME, /return this\.breakpoint === 'compact';/, 'compact 分支只看一个档位');
    assert.equal(/600|840/.test(HOME), false, '断点阈值只允许写在 uiTokens.ts，不得在本页写死');
    assert.match(HOME, /if \(!this\.isCompact\(\)\) \{[\s\S]{0,1200}ShellRail\(\{/, 'wide 常驻轨分支必须存在');
    assert.match(HOME, /if \(this\.isCompact\(\)\) \{[\s\S]{0,1200}ShellRail\(\{/, 'compact 抽屉轨分支必须存在');
    assert.match(HOME, /compact: false/, '常驻轨 compact=false');
    assert.match(HOME, /compact: true/, '抽屉轨 compact=true');
    assert.match(HOME, /if \(this\.isCompact\(\) && this\.drawerOpen\)/, 'compact 蒙层分支必须存在');
  });
});

describe('外壳行为：默认 / 返回 / 入口 / fallback 路由', () => {
  test('P-10 默认分段是 dots，且 id 常量取自 ShellRail', () => {
    assert.match(HOME, /@State section: ShellSection = SHELL_SECTION_DOTS;/, '默认 section 必须是 dots');
    assert.match(RAIL, /export const SHELL_SECTION_DOTS: ShellSection = 'dots';/);
    assert.match(HOME, /import \{[\s\S]*?SHELL_SECTION_DOTS[\s\S]*?\} from '\.\.\/components\/shell\/ShellRail';/);
  });

  test('P-11 onBackPress：抽屉开→true、非 dots→回 dots 且 true、dots→false', () => {
    const body = blockAfter(HOME, '\n  onBackPress(');
    assert.match(body, /if \(this\.drawerOpen\) \{[\s\S]*?this\.drawerOpen = false;[\s\S]*?return true;[\s\S]*?\}/,
      '抽屉开着先收抽屉并吃掉返回');
    assert.match(body, /if \(this\.section !== SHELL_SECTION_DOTS\) \{[\s\S]*?this\.section = SHELL_SECTION_DOTS;[\s\S]*?return true;[\s\S]*?\}/,
      '非 dots 先回 dots 并吃掉返回');
    const tail = body.slice(body.lastIndexOf('return true;') + 'return true;'.length);
    assert.match(tail, /\}\s*return false;\s*$/, '已在 dots 且无抽屉时放行（返回 false）');
    assert.equal((body.match(/return false;/g) ?? []).length, 1, '只有一条放行分支');
  });

  test('P-12 入口翻转：EntryAbility.loadContent 指向 pages/Home', () => {
    assert.match(ENTRY, /\.loadContent\('pages\/Home'/, '启动页必须是外壳 Home');
    assert.equal(/\.loadContent\('pages\/Index'/.test(ENTRY), false, '不得回退到旧首页作为启动页');
  });

  test('P-13 pages/Index 仍是两份清单里的 fallback 路由，main N / harmony 为超集', () => {
    for (const [label, manifest] of [['main', MAIN_PAGES], ['harmony', HARMONY_PAGES]]) {
      assert.ok(manifest.src.includes('pages/Index'), `${label} main_pages.json 必须保留 pages/Index（fallback 路由）`);
      assert.ok(manifest.src.includes('pages/Home'), `${label} main_pages.json 必须登记 pages/Home`);
      assert.equal(new Set(manifest.src).size, manifest.src.length, `${label} 清单不得重复登记`);
    }
    // 计数一致：main N 页（当前 9），harmony 是它的超集且至少多一个鸿蒙专属页。
    // 不写死 N：S3 抽壳后若迁出的组件被登记进清单，N 会增长，契约只看「超集 + 无缺口」。
    const n = MAIN_PAGES.src.length;
    assert.ok(n >= 8, `main 页面清单页数异常：${n}`);
    assert.ok(HARMONY_PAGES.src.length > n, 'harmony 清单必须是 main 的真超集');
    for (const entry of MAIN_PAGES.src) {
      assert.ok(HARMONY_PAGES.src.includes(entry), `harmony 清单必须是 main 的超集，缺少 ${entry}`);
    }
    assert.ok(HARMONY_PAGES.src.includes('pages/Handwriting'), 'harmony 专属手写页必须登记');
    assert.equal(MAIN_PAGES.src.includes('pages/Handwriting'), false, '手写页不得登记进 main 清单');
  });

  test('P-14 四个分段平级：SHELL_SECTION_ORDER 表驱动，齿轮是出口不是第五个 section', () => {
    const order = /SHELL_SECTION_ORDER: ShellSectionInfo\[\] = \[([\s\S]*?)\];/.exec(RAIL);
    assert.ok(order, '必须存在 SHELL_SECTION_ORDER 顺序表');
    const ids = [...order[1].matchAll(/SHELL_INFO_([A-Z_]+)/g)].map((match) => match[1]);
    assert.deepEqual(ids, ['DOTS', 'SCHEDULE', 'INSTANCES', 'CLOUD_CHAT']);
    assert.match(RAIL, /export type ShellSection = 'dots' \| 'schedule' \| 'instances' \| 'cloudChat';/);
    const build = blockAfter(RAIL, '\n  build() ');
    assert.match(build, /ForEach\(SHELL_SECTION_ORDER,[\s\S]{0,140}this\.SectionRow\(info\)/, '四节走同一份顺序表');
    assert.equal((build.match(/this\.SectionRow\(/g) ?? []).length, 1, '节行只经 ForEach，不手写第五行');
    assert.ok(build.indexOf('Divider()') > build.indexOf('ForEach(SHELL_SECTION_ORDER'), '齿轮行前必须有分隔线');
    assert.match(build, /this\.SettingsRow\(\)/, '页脚齿轮行必须渲染');
  });
});

describe('面板诚实性：占位无假行 + 无全局导航', () => {
  test('P-15 两个占位无假记录行，且各有一句「暂不展示」说明', () => {
    for (const scaffold of SCAFFOLDS) {
      const p = pane(scaffold.name);
      for (const fake of ['ForEach(', 'RecordRow(', 'Checkbox(', '示例', 'Lorem', '假数据']) {
        assert.equal(p.body.includes(fake), false, `${scaffold.name} 不得出现假行标记「${fake}」`);
      }
      assert.ok(p.source.includes(scaffold.empty), `${scaffold.name} 必须有空态说明「${scaffold.empty}」`);
    }
    assert.equal(/ForEach\(/.test(HOME), false, '外壳页本体不渲染任何列表行');
  });

  test('P-16 两个占位都有禁用主操作 + 逐字原因（无假入口）', () => {
    for (const scaffold of SCAFFOLDS) {
      const p = pane(scaffold.name);
      assert.match(p.source, new RegExp(`const ${scaffold.reason}: string = '[^']+';`),
        `${scaffold.name} 必须有命名禁用原因`);
      const actionSlot = 'Text(`' + scaffold.action + '（${' + scaffold.reason + '}）`)';
      assert.ok(p.body.includes(actionSlot), `${scaffold.name} 动作槽必须显示「${scaffold.action}（原因）」`);
      assert.match(p.body, /\.enabled\(false\)/, `${scaffold.name} 占位动作必须禁用`);
    }
  });

  test('P-17 dots 占位保留禁用输入框 + 字面原因「dots 尚未接线」', () => {
    const dots = pane('DotsPane');
    assert.match(dots.source, /const REASON_DOTS: string = 'dots 尚未接线';/, '逐字保留字面原因');
    assert.match(dots.body, /TextInput\(\{ placeholder: '输入给 dots 的指令…' \}\)/, '必须有输入框');
    assert.match(dots.body, /TextInput\(\{[\s\S]*?\.enabled\(false\)/, '该输入框必须禁用');
    assert.match(dots.body, /Text\(REASON_DOTS\)/, '禁用原因必须可见');
  });

  // mod-instances-pane-readonly（old→new，不比原来弱）：旧断言只说「渲染树里无 pushUrl」；
  // 现在首页实例面板的空态/问题行确实要跳「设置 → 远程实例」，故把它挪进统一出口方法，
  // 渲染树仍无 pushUrl；并正向钉住唯一新增目标 = pages/Instances，绝不 push 设置根页 / 外壳。
  test('P-18 面板不拥有全局导航：渲染树无 pushUrl；实例面板只跳设置实例路由', () => {
    assert.equal(/router|pushUrl/.test(RAIL), false, 'ShellRail 不得引用 router 或 pushUrl');
    for (const name of PANE_NAMES) {
      const p = pane(name);
      assert.equal(/pushUrl/.test(p.body), false, `${name} 的渲染树不得自行跳转（换段由 shell 负责）`);
      assert.equal(/pushUrl\(\{\s*url:\s*'pages\/Home'/.test(p.source), false,
        `${name} 不得 pushUrl 到外壳页切段`);
      assert.equal(/pushUrl\(\{\s*url:\s*'pages\/Settings'/.test(p.source), false,
        `${name} 不得新增第二处 Settings push`);
      assert.equal(/SHELL_SECTION_[A-Z_]+|ShellSection/.test(p.body), false,
        `${name} 不得在渲染树里判定分段 id`);
    }
    const instancesRaw = PANE_RAW.get('InstancesPane');
    assert.match(instancesRaw, /const ROUTE_INSTANCES: string = 'pages\/Instances'/);
    assert.match(instancesRaw, /pushUrl\(\{ url: ROUTE_INSTANCES \}\)/,
      '只读配置出口必须跳设置根页的「远程实例」路由');
    assert.match(readonlyRegions(instancesRaw), /this\.openInstanceConfig\(\)/,
      '只读空态 / 问题行走统一出口');
    // 日程面板确有 router.pushUrl，但只能是详情 / 编辑；设置出口唯一在 rail 齿轮 → Home。
    // 旧断言允许 pages/Settings → 新断言明确禁止（收紧，不是放宽）。
    const schedule = pane('SchedulePane');
    const targets = [...schedule.source.matchAll(/pushUrl\(\{\s*url:\s*'([^']+)'/g)].map((m) => m[1]);
    for (const url of targets) {
      assert.ok(['pages/Edit', 'pages/Detail'].includes(url),
        `日程面板的 pushUrl 目标只能是记录页，实际 ${url}`);
    }
    assert.equal(targets.includes('pages/Settings'), false,
      '日程面板不得 push 设置页（唯一 Settings push 在 Home.openSettings）');
    // 全局分段切换的唯一入口在 shell：section 状态 + onSelect 回调装配。
    assert.match(HOME, /@State section: ShellSection/, 'shell 持有 section 状态');
    assert.match(HOME, /private selectSection\(section: ShellSection\)/, 'shell 拥有统一选段入口');
    assert.equal((HOME.match(/onSelect: \(next: ShellSection\)/g) ?? []).length, 2,
      '常驻轨与抽屉轨都通过 onSelect 回传给 shell');
  });

  // mod-instances-pane-readonly（old→new，收紧）：「三动作」改成使用动作常在 / 配置动作分叉；
  // 新增空态路由与「只读模式无配置输入」的正向断言，而不是只删旧断言。
  test('P-19 远程 DSH 是真 body：自带 Scroll / 页头 / 实例行 / 打开 / 空态 / 播种；配置分模式', () => {
    const p = pane('InstancesPane');
    const raw = PANE_RAW.get('InstancesPane');
    const readonly = readonlyRegions(raw);
    const config = configRegions(raw).join('\n');
    assert.match(p.body, /^\s*Scroll\(\) \{/, '面板自带 Scroll（根即滚动容器）');
    assert.equal(/PageLayout\(/.test(p.source), false, '不得再套固定页头 + 内容的双层壳');
    const header = blockAfter(raw, '\n  Header() ');
    assert.match(readonlyRegions(header), /Text\('云端对话'\)/, '只读页头保留桥接出口');
    assert.equal(/Text\('添加实例'\)/.test(readonlyRegions(header)), false, '只读页头不得有添加实例');
    assert.match(configRegions(header).join('\n'), /Text\('添加实例'\)/, '配置模式页头有添加实例');
    const rows = blockAfter(raw, '\n  InstanceRow(');
    assert.match(readonlyRegions(rows), /label: '打开'/, '两种模式都能打开实例');
    assert.match(configRegions(rows).join('\n'), /label: '编辑'/, '配置模式有编辑');
    assert.match(configRegions(rows).join('\n'), /label: '删除'/, '配置模式有删除');
    assert.match(configRegions(rows).join('\n'), /view\.id !== LOCAL_INSTANCE_ID/, '本机行不得渲染删除');
    assert.equal(/label: '编辑'|label: '删除'/.test(readonlyRegions(rows)), false, '首页行内无配置动作');
    // 只读模式没有地址 / 令牌 / 方式输入，也没有内联表单调用。
    for (const forbidden of ['TextInput(', 'Select(', 'this.showAdd()', 'this.FormPanel()']) {
      assert.equal(readonly.includes(forbidden), false, `只读面板不得出现 ${forbidden}`);
    }
    assert.match(config, /TextInput\(/, '设置模式保留地址输入');
    assert.match(p.body, /ForEach\(\s*this\.views/, '列表来自真实实例视图');
    assert.match(p.source, /instanceStore\.ensureSeeded\(/, '首次进入播种本机 + 旧配置迁移');
    assert.match(p.source, /还没有可管理的 DSH 实例/, '空态逐字文案仍在');
    const empty = blockAfter(raw, '\n  EmptyView() ');
    assert.match(readonlyRegions(empty), /actionLabel: EMPTY_ACTION_READONLY/, '只读空态主操作去设置');
    assert.match(configRegions(empty).join('\n'), /actionLabel: EMPTY_ACTION\b/, '配置空态主操作仍是添加实例');
    assert.equal(/远程面板即将迁入|本页暂不展示任何记录。|REASON_REMOTE/.test(p.source), false,
      '占位说明 / 禁用原因必须绝迹');
  });

  test('P-20 单一事实来源：pages/Instances 顶层页只装配 InstancesPane，不复制正文', () => {
    const route = stripComments(readFileSync(new URL('pages/Instances.ets', ETS), 'utf8'));
    assert.match(route, /import \{ InstancesPane \}/, '路由页必须导入面板组件');
    assert.match(route, /InstancesPane\(\{/, '路由页必须装配面板');
    assert.equal(/instanceStore\.|settingsStore\.|ForEach\(|EMPTY_TITLE/.test(route), false,
      '路由页不得复制实例正文（双份播种 / 双份渲染）');
  });

  test('P-21 设置出口唯一（mod-settings-entry-dedupe）：外壳 + 四面板恰好一处 Settings push、位于 Home', () => {
    const sources = [['Home.ets', HOME], ['ShellRail.ets', RAIL], ...PANE_NAMES.map((name) => [name, pane(name).source])];
    const hits = sources
      .filter(([, code]) => /pushUrl\(\{\s*url:\s*'pages\/Settings'\s*\}\)/.test(code))
      .map(([name]) => name);
    assert.deepEqual(hits, ['Home.ets'],
      '正向断言：Settings push 恰好一处、位于 Home.ets（rail 齿轮 → Home.openSettings）');
    for (const name of PANE_NAMES) {
      assert.equal(/headerActionTwo|onHeaderActionTwo|⚙ 设置|private openSettings/.test(pane(name).source), false,
        `${name} 不得含有设置动作（唯一出口 = rail 齿轮）`);
    }
    // 齿轮是唯一 UI 入口且 Home 两处装配都接住事件；面板主操作保持 pane 专属。
    assert.match(RAIL, /this\.SettingsRow\(\)/, '齿轮行必须渲染');
    assert.equal((HOME.match(/onOpenSettings: \(\): void => \{\s*\n\s*this\.openSettings\(\);/g) ?? []).length, 2,
      '宽屏常驻轨与 compact 抽屉轨都把齿轮事件接到 openSettings');
    assert.match(pane('SchedulePane').source, /Button\('新建'\)/, '日程：新建');
    // mod-instances-pane-readonly（old→new，不比原来弱）：面板主操作仍 pane 专属；
    // 「添加实例」只在配置模式，首页只读面板用「云端对话」桥接 + 空态跳设置实例路由。
    const instancesRaw = PANE_RAW.get('InstancesPane');
    assert.match(readonlyRegions(instancesRaw), /Text\('云端对话'\)/, '远程 DSH（只读）：桥接');
    assert.match(configRegions(instancesRaw).join('\n'), /Text\('添加实例'\)/, '远程 DSH（设置）：添加实例');
    assert.match(pane('DotsPane').source, /新建对话/, 'dots：新建对话');
    assert.match(pane('CloudChatPane').source, /新建对话/, '云端对话：新建对话');
  });
});
