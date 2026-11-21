// 外壳布局守卫（mod-shell-rail / S4，源码级静态断言）。
//
// 真值：`pages/Home.ets`（外壳页）+ `components/shell/ShellRail.ets`（左轨）。
// 这里钉的是「外壳几何契约」：唯一一层 flex 切分、单 Stack 里的四面板保活、
// 默认 dots、返回键语义、compact 抽屉、各面板占位不得有假行。
// 不依赖 ArkTS 编译器，`node --test` 毫秒级跑完；真机 ArkTS 编译/观感不在本文件范围。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { matchBrace, stripComments } from './helpers/etsSource.mjs';

const HOME = stripComments(
  readFileSync(new URL('../../entry/src/main/ets/pages/Home.ets', import.meta.url), 'utf8')
);
const RAIL = stripComments(
  readFileSync(new URL('../../entry/src/main/ets/components/shell/ShellRail.ets', import.meta.url), 'utf8')
);
const MAIN_PAGES = JSON.parse(
  readFileSync(new URL('../../entry/src/main/resources/base/profile/main_pages.json', import.meta.url), 'utf8')
);
const HARMONY_PAGES = JSON.parse(
  readFileSync(new URL('../../entry/src/harmony/resources/base/profile/main_pages.json', import.meta.url), 'utf8')
);
const ENTRY_ABILITY = stripComments(
  readFileSync(new URL('../../entry/src/main/ets/entryability/EntryAbility.ets', import.meta.url), 'utf8')
);
const PANE_DIR = new URL('../../entry/src/main/ets/pages/panes/', import.meta.url);

/** 取 marker 之后那对花括号的内部文本（marker 形如 `build() ` / `onBackPress() `）。 */
function blockAfter(source, marker) {
  const at = source.indexOf(marker);
  assert.notEqual(at, -1, `找不到 ${marker}`);
  const brace = source.indexOf('{', at);
  assert.notEqual(brace, -1, `${marker} 后面没有花括号`);
  const [start, end] = matchBrace(source, brace);
  return source.slice(start + 1, end - 1);
}

/** 取 `Stack({...}) { ... }` 这类「配置对象 + builder 体」构造器的 builder 体（跳过第一对花括号）。 */
function configuredBlockAfter(source, marker) {
  const at = source.indexOf(marker);
  assert.notEqual(at, -1, `找不到 ${marker}`);
  const configBrace = source.indexOf('{', at);
  const [, configEnd] = matchBrace(source, configBrace);
  const bodyBrace = source.indexOf('{', configEnd);
  const [start, end] = matchBrace(source, bodyBrace);
  return source.slice(start + 1, end - 1);
}

// S3：四个 @Builder 已变成四个外部组件文件；PANES 保留顺序，新增各自的文件与占位元数据。
const PANES = [
  { name: 'DotsPane', file: 'DotsPane.ets', constant: 'SHELL_SECTION_DOTS' },
  { name: 'SchedulePane', file: 'SchedulePane.ets', constant: 'SHELL_SECTION_SCHEDULE' },
  { name: 'InstancesPane', file: 'InstancesPane.ets', constant: 'SHELL_SECTION_INSTANCES' },
  { name: 'CloudChatPane', file: 'CloudChatPane.ets', constant: 'SHELL_SECTION_CLOUD_CHAT' }
];
/** 三个「即将迁入」占位（日程已是真 body，不属于占位）。 */
const SCAFFOLDS = [
  { name: 'DotsPane', file: 'DotsPane.ets', label: 'dots', action: '新建对话', reason: 'REASON_DOTS', empty: '还没有 dots 对话' },
  { name: 'InstancesPane', file: 'InstancesPane.ets', label: '远程 DSH', action: '添加实例', reason: 'REASON_REMOTE', empty: '远程 DSH' },
  { name: 'CloudChatPane', file: 'CloudChatPane.ets', label: '云端对话', action: '新建对话', reason: 'REASON_CLOUD', empty: '云端对话' }
];
const PANE_SOURCE = new Map(
  PANES.map((pane) => [pane.name, stripComments(readFileSync(new URL(pane.file, PANE_DIR), 'utf8'))])
);

/** 外部组件的 build() 区间（替代旧 Home 里的同名 @Builder 区间）。 */
function paneBody(name) {
  return blockAfter(PANE_SOURCE.get(name), '\n  build() ');
}

const BUILD = blockAfter(HOME, '\n  build() ');
const STACK_MARKER = 'Stack({ alignContent: Alignment.TopStart })';

/** 内容面板 Stack 是 build() 里的第二处 Stack（第一处是只放覆盖层的 root Stack）。 */
function contentStackBody() {
  const first = BUILD.indexOf(STACK_MARKER);
  const second = BUILD.indexOf(STACK_MARKER, first + STACK_MARKER.length);
  assert.ok(first >= 0 && second > first, '必须有两层 Stack：root 覆盖层 + 内容面板层');
  return configuredBlockAfter(BUILD.slice(second), STACK_MARKER);
}

describe('外壳布局：单 flex 层 + 四面板保活 + 抽屉', () => {
  test('L-01 外壳页存在且登记进两份页面清单（main 9 页，harmony 为超集）', () => {
    assert.ok(HOME.length > 0, 'pages/Home.ets 必须有内容');
    assert.ok(MAIN_PAGES.src.includes('pages/Home'), 'main main_pages.json 缺少 pages/Home');
    assert.ok(HARMONY_PAGES.src.includes('pages/Home'), 'harmony main_pages.json 缺少 pages/Home');
    assert.equal(MAIN_PAGES.src.length, 9, 'main 页面清单应为 9 页（validate-app 的 pages 计数）');
    assert.equal(new Set(MAIN_PAGES.src).size, MAIN_PAGES.src.length, 'main 清单不得重复登记');
    for (const entry of MAIN_PAGES.src) {
      assert.ok(HARMONY_PAGES.src.includes(entry), `harmony 清单必须是 main 的超集，缺少 ${entry}`);
    }
  });

  test('L-02 唯一的 flex 切分在内容 Stack；三个占位页头各一处标题省略号', () => {
    const buildSplits = BUILD.match(/layoutWeight\(1\)/g) ?? [];
    assert.equal(buildSplits.length, 1, `build() 里只允许一处 layoutWeight(1) flex 切分，实际 ${buildSplits.length} 处`);
    // 唯一的那一处紧跟在四面板 Stack 的闭合之后（width/height 100% → layoutWeight）。
    assert.match(
      BUILD,
      /CloudChatPane\(\{[\s\S]*?\}\)\s*\n\s*\}\s*\n\s*\.width\('100%'\)\s*\n\s*\.height\('100%'\)\s*\n\s*\.layoutWeight\(1\)/,
      'flex 切分必须是包住四个面板的内容 Stack 的属性'
    );
    // 旧「PaneHeader 标题省略号」那一处随页头一起搬进三个占位组件；Home 自身只剩内容 Stack。
    const all = HOME.match(/layoutWeight\(1\)/g) ?? [];
    assert.equal(all.length, 1, `外壳页只允许已登记的一处 layoutWeight(1)，实际 ${all.length} 处`);
    for (const scaffold of SCAFFOLDS) {
      const inHeader = (paneBody(scaffold.name).match(/layoutWeight\(1\)/g) ?? []).length;
      assert.equal(inHeader, 1, `${scaffold.name} 的标题省略号只能占一处，不是新的 flex 切分`);
    }
  });

  test('L-03 没有嵌套的固定高度 Column 包住内容区（只有一层 Row → Stack）', () => {
    const build = BUILD;
    const rowAt = build.indexOf('Row() {');
    assert.notEqual(rowAt, -1, '根容器里必须有一个横向 flex Row');
    const stackAt = build.indexOf('Stack({ alignContent: Alignment.TopStart })', rowAt);
    assert.ok(stackAt > rowAt, '内容区必须是 Row 里的 Stack，不能被 Column 包住');
    const between = build.slice(rowAt, stackAt);
    assert.equal(/Column\(/.test(between), false, 'Row 与内容 Stack 之间不得插入 Column 包裹层');
    // 内容 Stack 自身 height('100%')，不是固定 vp 高度。
    const tail = build.slice(stackAt, stackAt + 900);
    assert.match(tail, /\.height\('100%'\)/, '内容区必须 height(100%) 撑满');
    assert.equal(/\.height\(\s*\d+(\.\d+)?\s*\)/.test(tail), false, '内容区不得写死 vp 高度');
  });

  test('L-04 四个面板各自承载滚动，内容 Stack 本身不滚动', () => {
    const content = contentStackBody();
    assert.equal(/Scroll\(/.test(content), false, '内容 Stack 不得再包一层 Scroll');
    assert.equal(/Column\(/.test(content), false, '内容 Stack 只能是面板叠放层，不得有布局 Column');
    for (const scaffold of SCAFFOLDS) {
      assert.match(paneBody(scaffold.name), /^\s*Scroll\(\) \{/, `${scaffold.name} 必须以自己的 Scroll 开头`);
    }
    // 日程真 body 的滚动纪律：汇总块自带 Scroll、列表区是唯一的加权兄弟（横屏修复不回退）。
    const schedule = PANE_SOURCE.get('SchedulePane');
    assert.match(schedule, /Scroll\(\) \{/, '日程面板必须自己承载汇总块的滚动');
    assert.match(blockAfter(schedule, '\n  ListRows() {'), /\.layoutWeight\(1\)/, '列表必须持有 layoutWeight(1)');
  });

  test('L-05 四面板在**同一个** Stack 里无条件实例化，顺序固定', () => {
    const content = contentStackBody();
    assert.equal((content.match(/Stack\(\{ alignContent/g) ?? []).length, 0, '四面板之间不得再嵌套 Stack');
    let previous = -1;
    for (const { name } of PANES) {
      const at = content.indexOf(`${name}({`);
      assert.ok(at >= 0, `内容 Stack 必须实例化 ${name}`);
      assert.ok(at > previous, `${name} 的顺序错乱`);
      previous = at;
    }
    assert.equal((content.match(/\b(?:Dots|Schedule|Instances|CloudChat)Pane\(\{/g) ?? []).length, 4,
      '必须恰好四个面板装配');
    assert.equal(/\bif\s*\(/.test(content), false, '面板不得用 if/else 条件渲染（会卸载、丢 @State）');
  });

  test('L-06 保活：四个面板都用 Visibility.Hidden 隐藏，不用 None/卸载', () => {
    const hidden = [...PANE_SOURCE.values()].flatMap((source) =>
      source.match(/\.visibility\(this\.active \? Visibility\.Visible : Visibility\.Hidden\)/g) ?? []);
    assert.equal(hidden.length, 4, `四个面板都要 active→Visible/Hidden，实际 ${hidden.length} 处`);
    for (const { name } of PANES) {
      assert.match(PANE_SOURCE.get(name), /\.visibility\(this\.active \? Visibility\.Visible : Visibility\.Hidden\)/,
        `${name} 必须保持 Hidden 保活接线`);
      assert.match(BUILD, new RegExp(`${name}\\(\\{[\\s\\S]{0,200}active: this\\.section === SHELL_SECTION_[A-Z_]+`),
        `${name} 必须收到 active 分段判定`);
    }
    // Visibility.None 只允许出现在抽屉轨的挂起上，不允许出现在任何面板里。
    for (const { name } of PANES) {
      assert.equal(/Visibility\.None/.test(PANE_SOURCE.get(name)), false, `${name} 不得用 None 卸载`);
    }
    assert.match(HOME, /\.visibility\(this\.drawerOpen \? Visibility\.Visible : Visibility\.None\)/,
      '抽屉轨用 None 挂起（不占布局但保持组件在树上）');
  });

  test('L-07 默认分段是 dots，id 常量取自 ShellRail', () => {
    assert.match(HOME, /@State section: ShellSection = SHELL_SECTION_DOTS;/, '默认 section 必须是 dots');
    assert.match(RAIL, /export const SHELL_SECTION_DOTS: ShellSection = 'dots';/);
    assert.match(HOME, /import \{[\s\S]*?SHELL_SECTION_DOTS[\s\S]*?\} from '\.\.\/components\/shell\/ShellRail';/);
  });

  test('L-08 深链 section 严格归一：四个合法 id 之外一律回落 dots', () => {
    const fn = blockAfter(HOME, 'function parseSection(');
    for (const { constant } of PANES) {
      assert.ok(fn.includes(constant), `parseSection 必须认识 ${constant}`);
    }
    const returns = fn.match(/return\s+[^;]+;/g) ?? [];
    assert.deepEqual(returns, ['return value as ShellSection;', 'return SHELL_SECTION_DOTS;'],
      '只允许「合法值原样返回」与「未知值回落 dots」两条出口');
    assert.match(blockAfter(HOME, '\n  aboutToAppear('), /this\.section = SHELL_SECTION_DOTS;/,
      '路由参数异常时也要回落 dots');
  });

  test('L-09 onBackPress：抽屉开→true、非 dots→true、dots→false', () => {
    const body = blockAfter(HOME, '\n  onBackPress(');
    assert.match(body, /if \(this\.drawerOpen\) \{[\s\S]*?this\.drawerOpen = false;[\s\S]*?return true;[\s\S]*?\}/,
      '抽屉开着先收抽屉并吃掉返回');
    assert.match(body, /if \(this\.section !== SHELL_SECTION_DOTS\) \{[\s\S]*?this\.section = SHELL_SECTION_DOTS;[\s\S]*?return true;[\s\S]*?\}/,
      '非 dots 先回 dots 并吃掉返回');
    const tail = body.slice(body.lastIndexOf('return true;') + 'return true;'.length);
    assert.match(tail, /\}\s*return false;\s*$/, '已在 dots 且无抽屉时放行（返回 false）');
    assert.equal((body.match(/return false;/g) ?? []).length, 1, '只有一条放行分支');
  });

  test('L-10 compact 断点（<600）走抽屉：同源 resolveBreakpoint + 蒙层 + 窄轨', () => {
    assert.match(HOME, /resolveBreakpoint\(width, isLandscapeSize\(width, height\)\)/, '断点必须复用 uiTokens 同一判据');
    assert.match(HOME, /@State breakpoint: string = 'compact';/, '初始断点为 compact');
    assert.match(HOME, /return this\.breakpoint === 'compact';/, 'compact 分支只看一个档位');
    assert.equal(/600|840/.test(HOME), false, '断点阈值只允许写在 uiTokens.ts，不得在本页写死');
    assert.match(HOME, /if \(this\.isCompact\(\) && this\.drawerOpen\)/, 'compact 抽屉蒙层分支必须存在');
    assert.match(HOME, /\.backgroundColor\(\$r\('app\.color\.scrim'\)\)/, '蒙层走 scrim 令牌');
    assert.match(HOME, /compact: true/, '抽屉里的 ShellRail 必须 compact=true');
    assert.match(HOME, /compact: false/, '常驻轨必须 compact=false');
    assert.match(RAIL, /const RAIL_COMPACT_WIDTH: number = 72;/, '抽屉窄轨 72vp');
  });

  test('L-11 三个占位各有带分段标签的页头，动作槽禁用并写出原因；日程用真页头', () => {
    for (const { name, label, action, reason } of SCAFFOLDS) {
      const body = paneBody(name);
      assert.match(body, new RegExp(`Text\\('${label}'\\)`), `${name} 必须有「${label}」分段标签`);
      const actionSlot = 'Text(`' + action + '（${' + reason + '}）`)';
      assert.ok(body.includes(actionSlot), `${name} 的动作槽必须显示「${action}（原因）」`);
      assert.match(body, /\.enabled\(false\)/, `${name} 的占位动作必须禁用（无假入口）`);
    }
    // 日程不再是占位：它保留 Index 的真页头（PageLayout 的唯一设置出口），没有禁用原因。
    const schedule = PANE_SOURCE.get('SchedulePane');
    assert.match(schedule, /headerActionTwo: '⚙ 设置'/, '日程面板沿用真页头的唯一设置出口');
    assert.equal(/即将迁入/.test(schedule), false, '日程面板不得残留占位文案');
  });

  test('L-12 dots 占位：禁用输入框 + 字面原因「dots 尚未接线」', () => {
    const source = PANE_SOURCE.get('DotsPane');
    assert.match(source, /const REASON_DOTS: string = 'dots 尚未接线';/, '必须逐字保留禁用原因');
    const body = paneBody('DotsPane');
    assert.match(body, /TextInput\(\{ placeholder: '输入给 dots 的指令…' \}\)/, 'dots 占位要有输入框');
    assert.match(body, /\.enabled\(false\)/, '该输入框必须禁用');
    assert.match(body, /Text\(REASON_DOTS\)/, '原因必须可见');
    assert.match(body, /还没有 dots 对话/, 'dots 空聊天气态文案');
  });

  test('L-13 三个占位都不渲染假记录行；日程面板反而必须渲染真行', () => {
    for (const { name } of SCAFFOLDS) {
      const body = paneBody(name);
      for (const fake of ['ForEach(', 'RecordRow(', 'Checkbox(', '示例', 'Lorem', '假数据']) {
        assert.equal(body.includes(fake), false, `${name} 不得出现假行标记「${fake}」`);
      }
    }
    const explanatory = [...SCAFFOLDS].flatMap(({ name }) =>
      PANE_SOURCE.get(name).match(/本页暂不展示任何记录。/g) ?? []).length;
    assert.equal(explanatory, 2, '日程占位已换成真 body：只剩远程 / 云端两句「本页暂不展示任何记录。」');
    assert.equal(/ForEach\(/.test(HOME), false, '外壳页整体不渲染任何列表行');
    const schedule = PANE_SOURCE.get('SchedulePane');
    assert.match(schedule, /ForEach\(\s*this\.visibleRecords/, '日程面板必须渲染真实记录行');
    assert.match(schedule, /RecordRow\(\{/, '日程面板必须装配 RecordRow');
  });

  test('L-14 齿轮是出口不是第五个 section：四节顺序 + 分隔线 + SettingsRow', () => {
    const order = /SHELL_SECTION_ORDER: ShellSectionInfo\[\] = \[([\s\S]*?)\];/.exec(RAIL);
    assert.ok(order, '必须存在 SHELL_SECTION_ORDER 顺序表');
    const ids = [...order[1].matchAll(/SHELL_INFO_([A-Z_]+)/g)].map((match) => match[1]);
    assert.deepEqual(ids, ['DOTS', 'SCHEDULE', 'INSTANCES', 'CLOUD_CHAT'], '四节必须平级且顺序固定');
    assert.match(RAIL, /export type ShellSection = 'dots' \| 'schedule' \| 'instances' \| 'cloudChat';/);
    const build = blockAfter(RAIL, '\n  build() ');
    assert.match(build, /ForEach\(SHELL_SECTION_ORDER,[\s\S]{0,140}this\.SectionRow\(info\)/, '四节走同一份顺序表');
    assert.equal((build.match(/this\.SectionRow\(/g) ?? []).length, 1, '节行只经 ForEach，不手写第五行');
    assert.ok(build.indexOf('Divider()') > build.indexOf('ForEach(SHELL_SECTION_ORDER'), '齿轮行前必须有分隔线');
    assert.match(build, /this\.SettingsRow\(\)/, '页脚齿轮行必须渲染');
    assert.match(RAIL, /const SETTINGS_GLYPH: string = '⚙';/, '齿轮 glyph 与首页页头一致');
  });

  test('L-15 轨道尺寸令牌化：240 / 72 / 48，行高 ≥ TOUCH_MIN', () => {
    assert.match(RAIL, /const RAIL_WIDTH: number = 240;/);
    assert.match(RAIL, /const RAIL_COMPACT_WIDTH: number = 72;/);
    assert.match(RAIL, /const RAIL_ROW_HEIGHT: number = 48;/);
    assert.ok(48 >= 40, '行高 48 ≥ TOUCH_MIN 40');
    assert.match(RAIL, /TOUCH_MIN/, '轨道必须引用触控令牌');
    assert.match(RAIL, /\.height\(RAIL_ROW_HEIGHT\)/, '节行与齿轮行同高');
    assert.match(RAIL, /\.width\(this\.railWidth\(\)\)/, '轨宽由形态决定');
    assert.equal(/(?:#[0-9A-Fa-f]{3,8}|Color\.[A-Z]|rgba?\()/.test(RAIL), false, '轨道不得写裸色值');
  });

  test('L-16 覆盖层只在 root Stack：蒙层点按关闭 + 抽屉轨保持挂载', () => {
    const root = configuredBlockAfter(BUILD, STACK_MARKER);
    assert.match(root, /\.onClick\(\(\) => \{\s*\n\s*this\.drawerOpen = false;/, '点蒙层必须关抽屉');
    assert.match(root, /if \(this\.isCompact\(\)\) \{[\s\S]*?ShellRail\(\{[\s\S]*?\.visibility\(this\.drawerOpen \? Visibility\.Visible : Visibility\.None\)/,
      '抽屉轨以 Visibility.None 挂起，不 unmount');
    // 宽屏轨只在非 compact 渲染一次，抽屉轨只在 compact 渲染一次，二者互斥。
    assert.match(root, /if \(!this\.isCompact\(\)\) \{[\s\S]*?ShellRail\(\{/, '宽屏常驻轨分支');
    assert.equal((root.match(/ShellRail\(\{/g) ?? []).length, 2, '常驻轨 + 抽屉轨各一处装配');
  });

  test('L-17 入口翻转：EntryAbility 加载 pages/Home，pages/Index 仍是 fallback 路由', () => {
    assert.match(ENTRY_ABILITY, /loadContent\('pages\/Home'/, '启动页必须是外壳 Home');
    assert.equal(ENTRY_ABILITY.includes("loadContent('pages/Index'"), false, '入口不得再指向旧首页');
    assert.ok(MAIN_PAGES.src.includes('pages/Index'), 'main 清单必须保留 fallback 路由 pages/Index');
    assert.ok(HARMONY_PAGES.src.includes('pages/Index'), 'harmony 清单必须保留 fallback 路由 pages/Index');
    assert.equal(MAIN_PAGES.src.length, 9, 'main 页面数仍为 9（不新增/删除页面）');
    assert.equal(HARMONY_PAGES.src.length, 10, 'harmony 页面数仍为 10（main 的超集）');
  });

  test('L-18 日程真 body：SchedulePane 拥有两 tab / 搜索 / 汇总 / 撤销 / 加权列表', () => {
    const schedule = PANE_SOURCE.get('SchedulePane');
    for (const token of ['ModeTabs()', 'SearchFilterBar()', 'SummaryCard()', 'UndoBar()',
      'RecordList()', '当日全部日程', '未完成', "Button('新建')"]) {
      assert.ok(schedule.includes(token), `日程面板必须拥有 ${token}`);
    }
    const list = blockAfter(schedule, '\n  ListRows() {');
    assert.match(list, /List\(\) \{/, '列表区仍是 List');
    assert.match(list, /\.layoutWeight\(1\)/, '列表必须持有唯一吃余量的 layoutWeight(1)');
    assert.equal(/ChatEntries|openChats|ChatKind/.test(schedule.replace(/^\s*\*.*$/gm, '')), false,
      '日程面板不得保留被导航轨取代的两格入口（注释里的迁移说明不算）');
  });
});
