// 页头守卫（源码级，防回归）：**页头不再有「✨ AI 汇总」图标入口**。
//
// 【mod-shell-rail / S4 重定位】外壳 `pages/Home.ets` 成为首页后，本文件分两块：
//   1. 原四条用例（Index.ets 的页头 / 汇总块 / AiPanel）**一条未删**，只是改标为
//      「日程面板契约」——S3 把 Index 的 body 迁进 shell 的 日程 pane 时，只改文件锚点，
//      断言本身不动；在那之前 Index.ets 仍是这些行为的真值来源；
//   2. 新增外壳页头用例：真实首页外壳的「页头」= `Home.PaneHeader(分段标签, 动作, 原因)`
//      + `ShellRail` 的 ⚙ 齿轮行。旧断言钉的属性（一个设置出口、无假按钮、页头标题是
//      当前视图语义而非相对日期）逐条映射到新外壳，见每个新用例的 `H-*` 编号。
//
// 用户反馈（历史）：首页右上角那个 AI 汇总图标点了没反应，但图标一直占着位置。
// 定版口径：
//   - 旧首页页头只留 `今天`（左）+ `⚙ 设置`（右），中间不放任何空按钮 → `PageLayout`
//     只传 `headerActionTwo: '⚙ 设置'`；
//   - AI 汇总本来是**列表第一项**（`SummaryCard`，数据源 `summaryStore.read` / `generate`），
//     现在只能从汇总块进入：生成 / 重试 / 重新生成 / 查看全部 / 点标题与要点；
//   - `AiPanel()`（逐条勾选候选面板）**保留**：它承载列表项的逐条 AI 操作，由结果面板里的
//     「重选」触发（`AiResultPanel` → `openAiPanel()`），与页头无关。
//
// 只读源码、不依赖 ArkTS 编译器，`node --test` 毫秒级跑完。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const etsDir = join(here, '..', '..', 'entry', 'src', 'main', 'ets');
const pagePath = join(etsDir, 'pages', 'Index.ets');
const source = readFileSync(pagePath, 'utf8');
// S4：外壳真值来源（新首页 = Home + ShellRail）。
const HOME = readFileSync(join(etsDir, 'pages', 'Home.ets'), 'utf8');
const RAIL = readFileSync(join(etsDir, 'components', 'shell', 'ShellRail.ets'), 'utf8');
const stripNotes = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const HOME_CODE = stripNotes(HOME);
const RAIL_CODE = stripNotes(RAIL);

/** 去掉注释后的「代码」视图（注释里可以解释为什么删，不算违规）。 */
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/** 取某个成员（`@Builder` / 普通方法）的定义体：两空格缩进的 `name(` 到下一个两空格收尾。 */
function memberBody(name) {
  const match = new RegExp(`\\n  (?:private |static |async |protected )*${name}\\(`).exec(code);
  assert.ok(match !== null, `找不到 ${name} 的定义`);
  const start = match.index;
  const end = code.indexOf('\n  }\n', start);
  return end > 0 ? code.slice(start, end + 5) : code.slice(start);
}

/** `build()` 里 `PageLayout({ ... })` 的属性区（不含尾随闭包内容）。 */
function pageLayoutProps() {
  const start = code.indexOf('PageLayout({');
  assert.notEqual(start, -1, 'build() 必须渲染 PageLayout');
  const end = code.indexOf('}) {', start);
  assert.ok(end > start, '找不到 PageLayout 的尾随闭包起点');
  return code.slice(start, end);
}

// S4：原「首页页头」四例保留，重标为「日程面板契约」。S3 落盘后把 pagePath 指向
// 日程 pane 的 body 源文件即可；断言逐字不变，覆盖不降级。
describe('日程面板契约（S3 迁入前的 Index.ets 真值）：AI 汇总图标入口已删除', () => {
  test('源码里不再出现「✨ AI 汇总」文案与页头 handler 标识', () => {
    // 全文（含注释）断言：连解释性注释里也不要留着这个入口的名字，防止被误恢复
    for (const banned of ['✨ AI 汇总', '✨ 生成中…', 'headerActionOne', 'onHeaderActionOne', 'onHeaderSummaryAction']) {
      assert.equal(source.includes(banned), false, `Index.ets 不得再出现「${banned}」`);
    }
    // 也没有改名后残留的页头 AI 入口（例如 aiPanelOpen / openAiPanelFromHeader 之类）
    assert.equal(/openAiPanel(?:FromHeader|OnHeader)/.test(code), false, '不得有页头专用的 AI 面板 opener');
  });

  test('页头只剩「今天」（左）+「⚙ 设置」（右），属性区不含任何 AI/面板标识', () => {
    const head = pageLayoutProps();
    assert.match(head, /title: this\.pageTitle\(\)/, '页头标题仍走 pageTitle()');
    assert.match(head, /subtitle: this\.subtitleText\(\)/, '页头副标题仍走 subtitleText()');
    assert.match(head, /headerActionTwo: '⚙ 设置'/, '页头右侧必须是「⚙ 设置」');
    assert.match(head, /onHeaderActionTwo: \(\) => \{\s*\n\s*this\.openSettings\(\);/, '「⚙ 设置」必须跳设置页');
    // 中间不留空按钮：属性区里不能有任何 AI / 面板 / 第一个动作的痕迹
    for (const leaked of ['✨', 'AI', 'aiBusy', 'AiPanel', 'openAiPanel', 'headerActionOne']) {
      assert.equal(head.includes(leaked), false, `PageLayout 属性区不得包含「${leaked}」`);
    }
    // 「今天」由标题函数给出（左侧语义不变）
    assert.match(code, /return this\.selectedDate === localDateKey\(new Date\(\)\) \? '今天' : '日程';/);
  });

  test('列表第一项仍是 AI 汇总块：summaryStore 读取/生成调用都在，且排在列表之前', () => {
    for (const builder of ['CompactBody', 'WideBody']) {
      const body = memberBody(builder);
      const cardAt = body.indexOf('this.SummaryCard()');
      const listAt = body.indexOf('this.RecordList()');
      assert.ok(cardAt >= 0, `${builder} 必须渲染汇总块`);
      assert.ok(listAt > cardAt, `${builder} 的汇总块必须在列表之前（列表第一项）`);
    }
    assert.equal((code.match(/this\.SummaryCard\(\)/g) ?? []).length, 2, '单列与双栏各渲染一次汇总块');
    // 数据源仍在：读 = summaryStore.read，生成 = summaryStore.generate
    assert.match(code, /summaryStore\.read\(this\.selectedDate\)/, '汇总必须从 summaryStore 读取');
    assert.match(code, /summaryStore\.generate\(/, '生成必须走 summaryStore（失败不覆盖旧文件）');
    assert.match(code, /✨ 今日汇总/, '块标题文案仍在');
    // A 批（`docs/STATE-UI.md` §5）把「生成今日汇总」那一行改成空态：
    // 标题 + 说明 + 「生成汇总」动作（空态必须带下一步，不能再是一行可点文字）。
    assert.match(code, /actionLabel: '生成汇总'/, '块内「生成汇总」入口仍在（页头入口删除后这是唯一 AI 汇总入口）');
    // 生成入口不止一个：生成行 / 重试 / 重新生成
    const card = memberBody('SummaryCard');
    const generateCalls = (card.match(/this\.generateSummary\(\)/g) ?? []).length;
    assert.ok(generateCalls >= 3, `汇总块内应有生成/重试/重新生成三个入口，实际 ${generateCalls} 处`);
  });

  test('AiPanel 仍保留（列表项逐条 AI 操作），但只能由结果面板的「重选」触发', () => {
    assert.match(code, /AiPanel\(\) \{/, '逐条勾选的候选面板 builder 必须还在');
    const calls = code.match(/this\.openAiPanel\(\)/g) ?? [];
    assert.equal(calls.length, 1, 'openAiPanel 只能有 1 个调用点（结果面板的「重选」）');
    assert.ok(memberBody('AiResultPanel').includes('this.openAiPanel()'), '「重选」必须来自 AiResultPanel');
    // 汇总块能打开结果面板（查看全部 / 点标题与要点），链路上不经过页头
    assert.match(memberBody('SummaryCard'), /this\.aiResultVisible = true;/, '汇总块必须能打开结果面板');
    assert.equal(pageLayoutProps().includes('aiResultVisible'), false, '页头不得再直接开结果面板');
  });
});

// ---------------------------------------------------------------- 外壳页头（S4 新增）
//
// 旧断言 → 新断言（都不是削弱）：
//   · 「页头 title/subtitle = 当前视图语义」→ H-1：PaneHeader 标题 = 分段标签（dots/日程/远程 DSH/云端对话）；
//   · 「页头只留 ⚙ 设置，无空按钮」→ H-2：齿轮是 ShellRail 的唯一出口，四个面板动作槽全部禁用并写原因；
//   · 「✨ AI 汇总 / headerActionOne / onHeaderSummaryAction 绝迹」→ H-3：同样这些标识在外壳里绝迹；
//   · 「首页无 tab / 汇总 / 列表重逻辑」→ H-4：Home 不复制 今日/未完成、summaryStore、RecordList —— 它们留在日程面板契约里。
describe('外壳页头（Home + ShellRail）：唯一设置出口 + 无假动作', () => {
  test('H-1 外壳页头标题 = 分段标签，四个面板各一处 PaneHeader', () => {
    const paneHeaders = HOME.match(/this\.PaneHeader\('[^']+', '[^']+', REASON_[A-Z]+\)/g) ?? [];
    assert.equal(paneHeaders.length, 4, '四个面板都要有带分段标签的页头');
    for (const label of ['dots', '日程', '远程 DSH', '云端对话']) {
      assert.ok(paneHeaders.some((call) => call.includes(`'${label}'`)), `缺少「${label}」分段页头`);
    }
    assert.match(HOME, /PaneHeader\(title: string, actionLabel: string, reason: string\)/);
    assert.match(HOME, /Text\(title\)/, '页头标题显示分段名（对应旧 pageTitle() 的语义）');
    assert.match(RAIL, /label: 'dots'/);
    assert.match(RAIL, /label: '日程'/);
    assert.match(RAIL, /label: '远程 DSH'/);
    assert.match(RAIL, /label: '云端对话'/);
  });

  test('H-2 设置出口唯一：齿轮行在 rail，面板动作槽禁用且不重复 pushUrl', () => {
    // 旧 headerActionTwo: '⚙ 设置' 的唯一出口属性 → 现在由 rail 齿轮 + 父页 openSettings 承担。
    assert.match(RAIL, /const SETTINGS_GLYPH: string = '⚙';/);
    assert.match(RAIL, /SettingsRow\(\) \{/, '齿轮行 builder 必须在 rail 里');
    assert.match(RAIL, /this\.SettingsRow\(\)/, '齿轮行必须渲染');
    assert.match(RAIL, /onOpenSettings: \(\) => void/, 'rail 只发事件，不自己跳转');
    assert.equal(/from '@kit\.ArkUI'|router/.test(RAIL_CODE), false, 'ShellRail 不得自己 import router（注释里的说明不算）');
    const pushes = HOME.match(/pushUrl\(\{ url: 'pages\/Settings' \}\)/g) ?? [];
    assert.equal(pushes.length, 1, '外壳里只能有一处进设置页的跳转');
    assert.match(HOME, /private openSettings\(\): void/, '跳转集中在 openSettings()');
    // 面板动作槽：PaneHeader 的动作 Text 与 dots 输入框都 .enabled(false)，不是可点的假按钮；
    // 四个面板共用同一个 PaneHeader builder，所以源码里是 2 处禁用而非 5 处。
    const disabled = HOME_CODE.match(/\.enabled\(false\)/g) ?? [];
    assert.equal(disabled.length, 2, 'PaneHeader 动作槽 + dots 输入框各一处禁用');
    assert.match(HOME_CODE, /PaneHeader\(title: string[\s\S]{0,1800}\.enabled\(false\)/, 'PaneHeader 的动作槽必须禁用');
    assert.match(HOME_CODE, /TextInput\(\{ placeholder: '输入给 dots 的指令…' \}\)[\s\S]{0,300}\.enabled\(false\)/,
      'dots 输入框必须禁用（无假入口）');
  });

  test('H-3 旧页头 AI 图标标识在外壳里绝迹（负向断言不删，换锚点）', () => {
    for (const banned of ['✨ AI 汇总', '✨ 生成中…', 'headerActionOne', 'onHeaderActionOne',
      'onHeaderSummaryAction', 'AiPanel', 'openAiPanel', 'pageTitle()', 'subtitleText()', 'MoreSheet']) {
      assert.equal(HOME.includes(banned), false, `Home.ets 不得出现「${banned}」`);
      assert.equal(RAIL.includes(banned), false, `ShellRail.ets 不得出现「${banned}」`);
    }
    assert.equal(/✨/.test(HOME + RAIL), false, '外壳不应残留 ✨ 图标');
  });

  test('H-4 外壳不复制日程面板的 tab / 汇总 / 列表逻辑（旧断言保留在日程契约里）', () => {
    for (const scheduleOnly of ['今日', '未完成', 'summaryStore', 'RecordList(', 'ModeTabs(', '✨ 今日汇总']) {
      assert.equal(HOME.includes(scheduleOnly), false, `「${scheduleOnly}」属于日程面板，不得出现在外壳`);
    }
    // 反向证明旧断言没有被 drop：日程契约四例仍钉在原锚点上。
    assert.match(source, /headerActionTwo: '⚙ 设置'/);
    assert.match(source, /this\.SummaryCard\(\)/);
    assert.match(source, /AiPanel\(\) \{/);
  });
});
