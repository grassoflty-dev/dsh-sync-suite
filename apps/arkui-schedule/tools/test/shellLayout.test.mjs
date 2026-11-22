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
const ETS_ROOT_URL = new URL('../../entry/src/main/ets/', import.meta.url);
const PANE_DIR = new URL('pages/panes/', ETS_ROOT_URL);

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
/**
 * 历史命名：SCAFFOLDS 现在只含 dots 面板，且只用它仍保留的两项契约——
 * 「禁用主操作 + typed 原因」与「空态标题」。mod-shell-dots-pane 已把正文换成真只读列表，
 * 因此这里不再表示「即将迁入」占位（另三面早已是真 body）。
 */
const SCAFFOLDS = [
  { name: 'DotsPane', file: 'DotsPane.ets', label: 'dots', action: '新建对话', reason: 'REASON_DOTS', empty: '还没有 dots 对话' }
];
const CLOUD_FILE = 'CloudChatPane.ets';
const PANE_SOURCE = new Map(
  PANES.map((pane) => [pane.name, stripComments(readFileSync(new URL(pane.file, PANE_DIR), 'utf8'))])
);
/**
 * 原始源码（不剥注释）：模式分叉守卫必须用它——`stripComments()` 会把 URL 字面量里的
 * `http://` 当成行注释起点，截掉同一行的 `}`，破坏花括号配对（InstancesPane 的表单里有
 * `placeholder: 'http://192...`）。注释本身不含守卫用的代码形状字符串，留着无害。
 */
const PANE_RAW = new Map(
  PANES.map((pane) => [pane.name, readFileSync(new URL(pane.file, PANE_DIR), 'utf8')])
);

/** 外部组件的 build() 区间（替代旧 Home 里的同名 @Builder 区间）。 */
function paneBody(name) {
  return blockAfter(PANE_SOURCE.get(name), '\n  build() ');
}

// mod-instances-pane-readonly：Instan 面板同一个组件两种模式，守卫按模式切源码。
const CONFIG_GATE = 'if (this.configurable) {';
const CONFIG_BUILDER = '\n  FormPanel() {';

/** 配置专属区域（门控块 + 只由配置模式调用的 FormPanel builder）。 */
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

/** 首页只读模式可见源码（挖掉配置专属区域）。 */
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
  test('L-01 外壳页存在且登记进两份页面清单（mod-settings-root 后 main 12 页，harmony 13 页为超集）', () => {
    assert.ok(HOME.length > 0, 'pages/Home.ets 必须有内容');
    assert.ok(MAIN_PAGES.src.includes('pages/Home'), 'main main_pages.json 缺少 pages/Home');
    assert.ok(HARMONY_PAGES.src.includes('pages/Home'), 'harmony main_pages.json 缺少 pages/Home');
    // 旧断言 9 → 新 12（+ 三个设置子页）；页数与 validate-app 的 pages 计数保持一致。
    assert.equal(MAIN_PAGES.src.length, 12, 'main 页面清单应为 12 页（validate-app 的 pages 计数）');
    assert.equal(new Set(MAIN_PAGES.src).size, MAIN_PAGES.src.length, 'main 清单不得重复登记');
    for (const entry of MAIN_PAGES.src) {
      assert.ok(HARMONY_PAGES.src.includes(entry), `harmony 清单必须是 main 的超集，缺少 ${entry}`);
    }
  });

  test('L-02 唯一的 flex 切分在内容 Stack；占位页头与云端真页头各一处标题省略号', () => {
    const buildSplits = BUILD.match(/layoutWeight\(1\)/g) ?? [];
    assert.equal(buildSplits.length, 1, `build() 里只允许一处 layoutWeight(1) flex 切分，实际 ${buildSplits.length} 处`);
    // 唯一的那一处紧跟在四面板 Stack 的闭合之后（width/height 100% → layoutWeight）。
    assert.match(
      BUILD,
      /CloudChatPane\(\{[\s\S]*?\}\)\s*\n\s*\}\s*\n\s*\.width\('100%'\)\s*\n\s*\.height\('100%'\)\s*\n\s*\.layoutWeight\(1\)/,
      'flex 切分必须是包住四个面板的内容 Stack 的属性'
    );
    // 旧「PaneHeader 标题省略号」随页头搬进占位组件；Home 自身只剩内容 Stack。
    const all = HOME.match(/layoutWeight\(1\)/g) ?? [];
    assert.equal(all.length, 1, `外壳页只允许已登记的一处 layoutWeight(1)，实际 ${all.length} 处`);
    for (const scaffold of SCAFFOLDS) {
      const inHeader = (paneBody(scaffold.name).match(/layoutWeight\(1\)/g) ?? []).length;
      assert.equal(inHeader, 1, `${scaffold.name} 的标题省略号只能占一处，不是新的 flex 切分`);
    }
    // mod-shell-cloud-chat-pane：云端面板落真后仍只有页头一处省略号（列表行不加权，滚动交给根 Scroll）。
    assert.equal((paneBody('CloudChatPane').match(/layoutWeight\(1\)/g) ?? []).length, 1,
      'CloudChatPane 的标题省略号只能占一处，列表不得新增 flex 切分');
    // 远程 DSH 现在是真 body：页头标题与行内名称各一处省略号，build() 根层不新增切分。
    const instances = PANE_SOURCE.get('InstancesPane');
    assert.equal((paneBody('InstancesPane').match(/layoutWeight\(1\)/g) ?? []).length, 0,
      'InstancesPane.build() 不得自己新增 flex 切分');
    assert.equal((blockAfter(instances, '\n  Header() ').match(/layoutWeight\(1\)/g) ?? []).length, 1);
    assert.equal((blockAfter(instances, '\n  InstanceRow(').match(/layoutWeight\(1\)/g) ?? []).length, 1);
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
    // 日程面板根是 Stack（内部汇总块自带 Scroll），其余三个面板根即 Scroll（云端落真后不变）。
    for (const name of [...SCAFFOLDS.map((s) => s.name), 'InstancesPane', 'CloudChatPane']) {
      assert.match(paneBody(name), /^\s*Scroll\(\) \{/, `${name} 必须以自己的 Scroll 开头`);
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

  // mod-shell-dots-pane（old→new，收紧）：旧断言只要求 dots 有一个禁用动作 + 任意原因；
  // 现在逐字钉住今天成立的 typed 原因，且禁止禁用输入框复活（正文已是真列表）。
  test('L-11 dots 面板有带标签的页头 + typed 禁用动作；日程 / 远程 / 云端用真页头', () => {
    for (const { name, label, action, reason } of SCAFFOLDS) {
      const body = paneBody(name);
      const source = PANE_SOURCE.get(name);
      assert.match(body, new RegExp(`Text\\('${label}'\\)`), `${name} 必须有「${label}」分段标签`);
      const actionSlot = 'Text(`' + action + '（${' + reason + '}）`)';
      assert.ok(body.includes(actionSlot), `${name} 的动作槽必须显示「${action}（原因）」`);
      assert.match(body, /\.enabled\(false\)/, `${name} 的「新建对话」动作必须禁用（无假入口）`);
      assert.match(source, /const REASON_DOTS: string = 'dots 指令尚未接线';/,
        `${name} 的禁用原因必须是今天成立的 typed 原因`);
      assert.equal(/TextInput\(|输入给 dots 的指令…/.test(source), false,
        `${name} 不得保留禁用输入框 / 假发送入口`);
    }
    // mod-shell-cloud-chat-pane（old→new，收紧）：云端页头只留标题，禁用动作 /「即将迁入」绝迹。
    const cloud = PANE_SOURCE.get('CloudChatPane');
    const cloudBody = paneBody('CloudChatPane');
    assert.match(cloudBody, /Text\('云端对话'\)/, '云端面板页头保留分段标题');
    assert.equal(/新建对话|REASON_CLOUD|\.enabled\(false\)|即将迁入|本页暂不展示任何记录。/.test(cloud), false,
      '云端面板不得残留占位说明 / 禁用假入口');
    assert.match(cloud, /const CLOUD_REPO_SETUP: string = '先在设置里配置仓库';/, '空态短下一步仍在');
    assert.match(cloud, /Text\(CLOUD_REPO_SETUP\)/, '短下一步仍渲染在面板里');
    // 日程不再是占位：真页头只留标题/副标题 + pane 专属「新建」；设置出口唯一在 rail 齿轮。
    const schedule = PANE_SOURCE.get('SchedulePane');
    assert.equal(/headerActionTwo|onHeaderActionTwo|⚙ 设置|private openSettings/.test(schedule), false,
      '日程面板页头不得有设置动作（唯一出口 = rail 齿轮 → Home.openSettings）');
    assert.match(schedule, /Button\('新建'\)/, '日程面板的主操作是「新建」');
    assert.equal(/即将迁入/.test(schedule), false, '日程面板不得残留占位文案');
    // mod-pane-header-nav-dedupe（old→new，收紧）：远程 DSH 不再是占位；首页只读页头只有标题
    // （无「添加实例」，也无「云端对话」跨节导航）；禁用原因已绝迹。
    const instances = PANE_SOURCE.get('InstancesPane');
    const instancesRaw = PANE_RAW.get('InstancesPane');
    const header = blockAfter(instancesRaw, '\n  Header() ');
    const readonlyHeader = readonlyRegions(header);
    assert.equal(/Text\('云端对话'\)|openChats|pages\/Chats/.test(header), false,
      '页头不得有跨节导航「云端对话」');
    assert.equal((readonlyHeader.match(/Text\(/g) ?? []).length, 1, '只读页头只有标题');
    assert.equal(/onClick\(/.test(readonlyHeader), false, '只读页头没有点击动作');
    assert.equal(/Text\('添加实例'\)/.test(readonlyHeader), false, '首页面板不得展示添加实例');
    assert.match(configRegions(instancesRaw).join('\n'), /Text\('添加实例'\)/, '配置模式保留添加实例');
    assert.equal(/REASON_REMOTE|远程面板即将迁入|本页暂不展示任何记录/.test(instances), false,
      '远程面板不得残留占位原因 / 说明');
  });

  // mod-shell-dots-pane（old→new，收紧，id L-12 不变）：旧断言钉禁用输入框 + 旧字面原因，
  // 两者都已随真列表移除。新真值 = typed 原因 + 空态短下一步 + 真实 ForEach 行 + 无假入口。
  test('L-12 dots 面板落真：typed 禁用原因 + 空态短下一步 + 真实列表 + 无禁用输入框', () => {
    const source = PANE_SOURCE.get('DotsPane');
    const raw = PANE_RAW.get('DotsPane');
    const body = paneBody('DotsPane');
    assert.equal(/dots 尚未接线|输入给 dots 的指令…/.test(source), false,
      '旧 scaffold 原因与输入框文案必须绝迹');
    assert.match(source, /const REASON_DOTS: string = 'dots 指令尚未接线';/, '逐字保留新的 typed 禁用原因');
    assert.match(body, /Text\(`新建对话（\$\{REASON_DOTS\}）`\)/, '禁用原因必须可见');
    assert.match(body, /\.enabled\(false\)/, '「新建对话」动作必须禁用');
    assert.equal(/TextInput\(|placeholder: '输入给 dots 的指令…'/.test(body), false,
      '发指令尚未接线，不得有输入框假入口');
    assert.match(source, /还没有 dots 对话/, 'dots 空态标题保留');
    assert.match(source, /const DOTS_NEXT_STEP: string = '先在设置里同步一次仓库';/, '空态下一步逐字保留');
    assert.match(source, /Text\(DOTS_NEXT_STEP\)/, '空态下一步必须渲染');
    assert.match(source, /ForEach\(\s*this\.chats/, '真实会话列表通过 ForEach 渲染');
    assert.match(source, /chatSummaryLine\(item\)/, '行摘要走纯模型');
    assert.equal((source.match(/\.enabled\(false\)/g) ?? []).length, 1, '只有一处禁用动作');
    assert.equal(/pushUrl\(\{\s*url:\s*'pages\/(Chats|Home|Settings)'/.test(raw), false,
      '不得 push 跨节页 / 设置根页');
  });

  // mod-shell-dots-pane（old→new，收紧）：旧断言把 `ForEach(` 当假行一刀切禁掉；
  // dots 落真后必须有 ForEach(this.chats)，故改成「禁假行构造器 + 正向钉真实数据源」。
  test('L-13 dots 与云端不渲染假记录行；四个面板都必须渲染真行', () => {
    for (const { name } of SCAFFOLDS) {
      const body = paneBody(name);
      for (const fake of ['RecordRow(', 'Checkbox(', '示例', 'Lorem', '假数据', 'ForEach([', 'ForEach({']) {
        assert.equal(body.includes(fake), false, `${name} 不得出现假行标记「${fake}」`);
      }
      assert.match(PANE_SOURCE.get(name), /ForEach\(\s*this\.chats/, `${name} 必须 ForEach 真实会话数组`);
      assert.match(PANE_SOURCE.get(name), /chatSummaryLine\(item\)/, `${name} 行摘要必须走纯模型`);
    }
    // mod-shell-cloud-chat-pane（old→new，收紧）：旧「只剩云端一句说明」改为「四面板全绝迹 + 真行在」。
    const explanatory = [...PANE_SOURCE.values()].flatMap((source) =>
      source.match(/本页暂不展示任何记录。/g) ?? []).length;
    assert.equal(explanatory, 0, '四个面板的旧占位说明全部绝迹（云端本批落真）');
    assert.equal(/本页暂不展示任何记录。/.test(PANE_SOURCE.get('CloudChatPane')), false,
      '云端占位说明必须绝迹');
    assert.match(PANE_SOURCE.get('CloudChatPane'), /ForEach\(\s*this\.chats/,
      '云端面板必须渲染真实会话行');
    assert.equal(/ForEach\(/.test(HOME), false, '外壳页整体不渲染任何列表行');
    const schedule = PANE_SOURCE.get('SchedulePane');
    assert.match(schedule, /ForEach\(\s*this\.visibleRecords/, '日程面板必须渲染真实记录行');
    assert.match(schedule, /RecordRow\(\{/, '日程面板必须装配 RecordRow');
    const instances = PANE_SOURCE.get('InstancesPane');
    assert.match(instances, /ForEach\(\s*this\.views/, '远程面板必须渲染真实实例行');
    assert.match(instances, /this\.InstanceRow\(view\)/, '远程面板必须装配 InstanceRow');
  });

  // mod-instances-pane-readonly（old→new，收紧）：旧断言把三动作都算「面板真 body」；
  // 现在「打开」是两种模式的共用能力，「编辑 / 删除」只在设置配置模式，分别钉住。
  test('L-19 远程 DSH 真 body：远程行 + 打开 + 空态 + 播种；配置动作只在设置模式', () => {
    const instances = PANE_RAW.get('InstancesPane');
    const readonly = readonlyRegions(instances);
    const config = configRegions(instances).join('\n');
    for (const token of [
      'instanceStore.ensureSeeded(', 'instanceStore.redacted()', 'instanceStore.lastProblem()',
      'ForEach(this.views', "label: '打开'", '还没有可管理的 DSH 实例'
    ]) {
      assert.ok(readonly.includes(token), `首页面板必须拥有 ${token}`);
    }
    for (const token of ["label: '编辑'", "label: '删除'"]) {
      assert.ok(config.includes(token), `配置模式必须拥有 ${token}`);
      assert.equal(readonly.includes(token), false, `首页面板不得渲染配置动作 ${token}`);
    }
    // mod-instances-drop-local（old→new，收紧）：旧断言钉「删除分支排除本机、打开时按本机
    // 走参数缺省」；现在没有本机行——面板不得有 local 分支，所有远程行一律可删、可拼 token 打开。
    assert.equal(/LOCAL_INSTANCE_ID|localInstance\(/.test(instances), false, '面板不得有本机行分支');
    assert.ok(config.includes("label: '删除'"), '配置块的每行远程实例都有删除动作');
    for (const stale of ['远程面板即将迁入', '实例列表与连接操作即将迁入', '本页暂不展示任何记录。']) {
      assert.equal(instances.includes(stale), false, `远程面板不得残留占位串「${stale}」`);
    }
    // 单一事实来源：路由页只装配面板，不复制正文；它是配置落点，必须显式打开模式。
    const route = stripComments(readFileSync(new URL('pages/Instances.ets', ETS_ROOT_URL), 'utf8'));
    assert.match(route, /InstancesPane\(\{/, 'pages/Instances 路由必须装配 InstancesPane');
    assert.match(route, /configurable: true/, '设置路由必须打开配置模式');
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
    // mod-settings-root（old→new）：仍钉「入口是 Home、Index 是 fallback」，页数按新增三个设置子页上调。
    assert.equal(MAIN_PAGES.src.length, 12, 'main 页面数应为 12（原 9 + 三个设置子页）');
    assert.equal(HARMONY_PAGES.src.length, 13, 'harmony 页面数应为 13（main 的超集）');
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

  test('L-20 设置出口唯一（mod-settings-entry-dedupe）：恰好一处 Settings push 在 Home，rail 齿轮是唯一 UI 入口', () => {
    const sources = [['Home.ets', HOME], ['ShellRail.ets', RAIL], ...PANES.map((p) => [p.file, PANE_SOURCE.get(p.name)])];
    const hits = sources
      .filter(([, code]) => /pushUrl\(\{ url: 'pages\/Settings' \}\)/.test(code))
      .map(([name]) => name);
    assert.deepEqual(hits, ['Home.ets'],
      '正向断言：外壳 + 四面板中 Settings push 恰好一处、位于 Home.ets（rail 齿轮 → Home.openSettings）');
    for (const { name } of PANES) {
      assert.equal(/headerActionTwo|onHeaderActionTwo|⚙ 设置|private openSettings/.test(PANE_SOURCE.get(name)), false,
        `${name} 不得含有设置动作（唯一出口 = rail 齿轮）`);
    }
    // 齿轮是唯一 UI 入口：rail 声明 + 渲染 SettingsRow，Home 两处装配都接 openSettings。
    assert.match(RAIL, /const SETTINGS_GLYPH: string = '⚙';/);
    assert.match(RAIL, /this\.SettingsRow\(\)/, '齿轮行必须渲染');
    assert.equal((HOME.match(/onOpenSettings: \(\): void => \{\s*\n\s*this\.openSettings\(\);/g) ?? []).length, 2,
      '常驻轨与抽屉轨都把齿轮事件接到 openSettings');
    // 面板主操作必须 pane 专属，不能有设置动作。
    assert.match(PANE_SOURCE.get('SchedulePane'), /Button\('新建'\)/, '日程：新建');
    // mod-pane-header-nav-dedupe（old→new，收紧）：面板主操作仍 pane 专属，「添加实例」只在配置模式；
    // 只读页头没有跨节导航，云端对话分段只从 rail 进入。
    const instancesRaw = PANE_RAW.get('InstancesPane');
    assert.equal(/Text\('云端对话'\)|openChats|pages\/Chats/.test(instancesRaw), false,
      '远程 DSH（只读）：页头不得有跨节导航到云端对话');
    assert.match(configRegions(instancesRaw).join('\n'), /Text\('添加实例'\)/,
      '远程 DSH（设置模式）：添加实例');
    assert.match(PANE_SOURCE.get('DotsPane'), /新建对话/, 'dots：新建对话（禁用并携带 typed 原因）');
    // mod-shell-cloud-chat-pane（old→new，收紧）：云端面板已落真列表，禁用「新建对话」绝迹。
    assert.equal(/新建对话/.test(PANE_SOURCE.get('CloudChatPane')), false,
      '云端对话：禁用主操作绝迹');
  });

  // mod-pane-header-nav-dedupe（新增正向守卫）：跨节导航只在 rail；面板页头只放 pane 专属动作。
  test('L-21 四面板页头无跨节导航，换段只走 ShellRail.onSelect → Home.selectSection', () => {
    for (const { name } of PANES) {
      const code = PANE_SOURCE.get(name);
      assert.equal(/selectSection|SHELL_SECTION_[A-Z_]+|onSelect: \(next: ShellSection\)/.test(code), false,
        `${name} 不得在页头 / 面板里切段`);
      assert.equal(/pushUrl\(\{\s*url:\s*'pages\/(Chats|Home)'/.test(code), false,
        `${name} 不得 push 跨节目标页 pages/Chats / pages/Home`);
    }
    const header = blockAfter(PANE_RAW.get('InstancesPane'), '\n  Header() ');
    const readonlyHeader = readonlyRegions(header);
    assert.equal(/Text\('云端对话'\)|openChats|pages\/Chats/.test(header), false,
      '实例面板页头不得有云端对话跨节桥接');
    assert.equal((readonlyHeader.match(/Text\(/g) ?? []).length, 1, '只读页头只有标题');
    assert.equal(/onClick\(/.test(readonlyHeader), false, '只读页头无点击动作');
    assert.match(configRegions(PANE_RAW.get('InstancesPane')).join('\n'), /Text\('添加实例'\)/,
      '配置页头只有 pane 专属「添加实例」');
    assert.match(HOME, /private selectSection\(section: ShellSection\)/, '外壳拥有唯一选段入口');
    assert.equal((HOME.match(/onSelect: \(next: ShellSection\)/g) ?? []).length, 2,
      '常驻轨与抽屉轨都把选段回传给外壳');
    assert.match(RAIL, /onSelect: \(section: ShellSection\) => void/, 'rail 只发 onSelect');
  });

  // mod-shell-cloud-chat-pane（新增正向守卫）：云端面板的四态 / 数据链 / 只读路由 / 保活。
  test('L-22 云端对话面板落真：复用 chatStore/chatList、四态、只读详情、零 RPC / 零配置', () => {
    const cloud = PANE_SOURCE.get('CloudChatPane');
    const raw = PANE_RAW.get('CloudChatPane');
    const body = paneBody('CloudChatPane');
    for (const token of [
      'chatStore.prepare(', 'chatStore.listChats()', 'ChatListResult', 'filterByKind(', 'sortChats(',
      'chatSummaryLine(item)', 'ForEach(', 'LoadingState(', 'ErrorState(', 'Text(CLOUD_REPO_SETUP)'
    ]) {
      assert.ok(raw.includes(token), `云端面板必须拥有 ${token}`);
    }
    assert.equal(/JSON\.parse|readTextSync|syncController|pullNow|TextInput\(|pages\/Settings/.test(cloud), false,
      '云端面板不得自建解析 / RPC / 配置入口');
    assert.match(cloud, /@Prop deepLinkId: string = '';/, '深链 prop 不变');
    assert.match(cloud, /@Prop active: boolean = true;/, 'active prop 不变');
    assert.match(cloud, /\.visibility\(this\.active \? Visibility\.Visible : Visibility\.Hidden\)/,
      'Visible/Hidden 保活不变');
    assert.match(raw, /router\.pushUrl\(\{ url: 'pages\/ChatDetail', params: params \}\)/, '只 push 只读详情');
    assert.equal(/pushUrl/.test(body), false, '渲染树无跨节跳转');
  });

  // mod-shell-dots-pane（新增正向守卫）：dots 面板与云端同款四态 / 数据链 / props / 保活 / 只读路由。
  test('L-23 dots 面板落真：复用 chatStore/chatList、四态、只读详情、单一 aboutToAppear', () => {
    const dots = PANE_SOURCE.get('DotsPane');
    const raw = PANE_RAW.get('DotsPane');
    const body = paneBody('DotsPane');
    for (const token of [
      'chatStore.prepare(', 'chatStore.listChats()', 'ChatListResult', 'filterByKind(', 'sortChats(',
      'chatSummaryLine(item)', 'ForEach(', 'LoadingState(', 'ErrorState(', 'Text(DOTS_NEXT_STEP)'
    ]) {
      assert.ok(raw.includes(token), `dots 面板必须拥有 ${token}`);
    }
    assert.equal(/JSON\.parse\(|readTextSync\(|syncController|pullNow|TextInput\(|pages\/Settings/.test(dots), false,
      'dots 面板不得自建解析 / RPC / 配置 / 输入框');
    assert.match(dots, /@Prop deepLinkId: string = '';/, '深链 prop 不变');
    assert.match(dots, /@Prop active: boolean = true;/, 'active prop 不变');
    assert.match(dots, /\.visibility\(this\.active \? Visibility\.Visible : Visibility\.Hidden\)/, 'Hidden 保活不变');
    assert.match(body, /^\s*Scroll\(\) \{/, 'dots 面板自带唯一 Scroll（竖屏 / 横屏共用）');
    assert.equal((dots.match(/aboutToAppear\(/g) ?? []).length, 1, '只读一次：只有一个 aboutToAppear');
    assert.equal(/onPageShow\(/.test(dots), false, '无 onPageShow');
    for (const token of ['this.LoadingHint()', 'this.EmptyChats()', 'this.ErrorBlock()', 'this.ChatList()']) {
      assert.ok(body.includes(token), `必须渲染 ${token}`);
    }
    assert.match(raw, /router\.pushUrl\(\{ url: 'pages\/ChatDetail', params: params \}\)/, '只 push 只读详情');
    assert.equal(/pushUrl/.test(body), false, '渲染树无跨节跳转');
  });
});
