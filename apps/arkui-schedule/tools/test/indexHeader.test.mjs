// 页头守卫（源码级，防回归）：**页头不再有「✨ AI 汇总」图标入口**。
//
// 【mod-shell-rail / S4 重定位 + mod-shell-schedule-pane / S3 落盘】外壳 `pages/Home.ets`
// 成为首页后，本文件分两块：
//   1. 原四条用例（Index.ets 的页头 / 汇总块 / AiPanel）**一条未删**，只是改标为
//      「日程面板契约」——S3 已把 Index 的 body 迁进 `pages/panes/SchedulePane.ets`，
//      本批只换文件锚点、断言逐字不动；Index.ets 保留为 fallback 路由；
//   2. 新增外壳页头用例：真实首页外壳的「页头」= `Home.PaneHeader(分段标签, 动作, 原因)`
//      + `ShellRail` 的 ⚙ 齿轮行。旧断言钉的属性（一个设置出口、无假按钮、页头标题是
//      当前视图语义而非相对日期）逐条映射到新外壳，见每个新用例的 `H-*` 编号。
//
// 用户反馈（历史）：首页右上角那个 AI 汇总图标点了没反应，但图标一直占着位置。
// 定版口径：
//   - 日程面板页头**没有**设置动作（mod-settings-entry-dedupe）：唯一出口 = rail 页脚齿轮 →
//     `Home.openSettings()`；`PageLayout` 只传标题/副标题，中间不放任何空按钮；
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
// S3：日程契约锚点已从 fallback 路由 pages/Index.ets 移到真 body 所在的日程面板。
const pagePath = join(etsDir, 'pages', 'panes', 'SchedulePane.ets');
const source = readFileSync(pagePath, 'utf8');
// mod-ai-summarize-label：本模块唯一可写的日程源码是 fallback 路由 pages/Index.ets，
// 有汇总态标签的新真值钉在它上面。上面的真 body 锚点与其全部断言一字未动；这里是**新增**覆盖。
const INDEX_ETS = readFileSync(join(etsDir, 'pages', 'Index.ets'), 'utf8');
const INDEX_ETS_CODE = INDEX_ETS
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
// S4：外壳真值来源（新首页 = Home + ShellRail）。
const HOME = readFileSync(join(etsDir, 'pages', 'Home.ets'), 'utf8');
const PANE_DIR = join(etsDir, 'pages', 'panes');
// mod-shell-instances-pane / mod-shell-cloud-chat-pane / mod-shell-dots-pane：四个面板都已落真只读正文。
// SCAFFOLD_PANES 是历史数组名，保留只为固定 PANE_CODES 的下标：[0]=DotsPane、[1]=CloudChatPane；
// 云端面板断言一字未动，dots 的 scaffold 断言逐条 retarget 为「真列表 + typed 禁用原因」。
const SCAFFOLD_PANES = ['DotsPane.ets', 'CloudChatPane.ets']
  .map((name) => readFileSync(join(PANE_DIR, name), 'utf8'));
const INSTANCES_SOURCE = readFileSync(join(PANE_DIR, 'InstancesPane.ets'), 'utf8');
const RAIL = readFileSync(join(etsDir, 'components', 'shell', 'ShellRail.ets'), 'utf8');
const stripNotes = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const HOME_CODE = stripNotes(HOME);
const RAIL_CODE = stripNotes(RAIL);
const PANE_CODES = SCAFFOLD_PANES.map((text) => stripNotes(text));
const INSTANCES_CODE = stripNotes(INSTANCES_SOURCE);

/** 去掉注释后的「代码」视图（注释里可以解释为什么删，不算违规）。 */
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/**
 * 正向契约（mod-settings-entry-dedupe）：外壳 + 四个面板里恰好一处 Settings push，
 * 且它只能在 `Home.openSettings()`（rail 页脚齿轮 → Home 的唯一跳转）。
 */
const SETTINGS_SHELL_SOURCES = [
  ['Home.ets', HOME_CODE],
  ['ShellRail.ets', RAIL_CODE],
  ['SchedulePane.ets', code],
  ['DotsPane.ets', PANE_CODES[0]],
  ['CloudChatPane.ets', PANE_CODES[1]],
  ['InstancesPane.ets', INSTANCES_CODE]
];
/** 返回所有发出 `pushUrl({ url: 'pages/Settings' })` 的源文件（去重前的文件名列表）。 */
function settingsPushFiles() {
  return SETTINGS_SHELL_SOURCES
    .filter(([, text]) => /pushUrl\(\{ url: 'pages\/Settings' \}\)/.test(text))
    .map(([file]) => file);
}

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
describe('日程面板契约（S3 已迁入 SchedulePane.ets）：AI 汇总图标入口已删除', () => {
  test('源码里不再出现「✨ AI 汇总」文案与页头 handler 标识', () => {
    // 全文（含注释）断言：连解释性注释里也不要留着这个入口的名字，防止被误恢复
    for (const banned of ['✨ AI 汇总', '✨ 生成中…', 'headerActionOne', 'onHeaderActionOne', 'onHeaderSummaryAction']) {
      assert.equal(source.includes(banned), false, `SchedulePane.ets 不得再出现「${banned}」`);
    }
    // 也没有改名后残留的页头 AI 入口（例如 aiPanelOpen / openAiPanelFromHeader 之类）
    assert.equal(/openAiPanel(?:FromHeader|OnHeader)/.test(code), false, '不得有页头专用的 AI 面板 opener');
  });

  test('页头只有标题/副标题，无设置动作与 AI 面板标识（唯一出口在 rail 齿轮）', () => {
    const head = pageLayoutProps();
    assert.match(head, /title: this\.pageTitle\(\)/, '页头标题仍走 pageTitle()');
    assert.match(head, /subtitle: this\.subtitleText\(\)/, '页头副标题仍走 subtitleText()');
    // 旧断言「页头右侧必须是 ⚙ 设置 / 必须跳设置页」→ 新断言：页头不再有设置动作。
    assert.equal(/headerActionTwo|onHeaderActionTwo|⚙ 设置|openSettings/.test(head), false,
      '日程面板页头不得再有任何设置动作（唯一出口 = rail 齿轮 → Home.openSettings）');
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
      const listAt = body.indexOf('this.RefreshableList()');
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
    // 生成入口不止一个：空态生成 / 失败态重试 / 有汇总态「AI 汇总」（幂等再生成），三处仍都调 generate。
    const card = memberBody('SummaryCard');
    const generateCalls = (card.match(/this\.generateSummary\(\)/g) ?? []).length;
    assert.ok(generateCalls >= 3, `汇总块内应有生成/重试/有汇总态三个入口，实际 ${generateCalls} 处`);
    // mod-ai-summarize-label（old→new，收紧）：旧文案把有汇总态钉成「重新生成」，现在钉成「AI 汇总」。
    // 真 body（SchedulePane.ets）与 fallback（Index.ets）两个日程源码都做全文禁用词绝迹 + 块内正向钉标签，
    // 避免只改 fallback 而用户实际看到的面板仍显示旧标签。上面的三入口与 actionLabel 断言原样保留。
    assert.match(card, /label: 'AI 汇总'/, '真 body 有汇总态动作标签必须是「AI 汇总」');
    assert.equal(/重新生成/.test(source), false, 'SchedulePane.ets 全文（含注释与停止等待文案）不得出现「重新生成」');
    assert.equal(/重新生成/.test(code), false, 'SchedulePane.ets 代码视图不得出现「重新生成」');
    const idxCardAt = INDEX_ETS_CODE.indexOf('SummaryCard() {');
    assert.ok(idxCardAt >= 0, 'Index.ets 必须保留 SummaryCard 汇总块');
    const idxCardEnd = INDEX_ETS_CODE.indexOf('\n  }\n', idxCardAt);
    assert.ok(idxCardEnd > idxCardAt, 'Index.ets 的 SummaryCard 必须能定位到定义末尾');
    const idxCard = INDEX_ETS_CODE.slice(idxCardAt, idxCardEnd + 5);
    assert.match(idxCard, /label: 'AI 汇总'/, '有汇总态动作标签必须是「AI 汇总」（幂等，不再显示「重新生成」）');
    assert.equal(/重新生成/.test(idxCard), false, '有汇总态渲染出的 action label 不得出现「重新生成」');
    assert.equal(/重新生成/.test(INDEX_ETS), false, 'Index.ets 全文（含注释与停止等待文案）不得出现「重新生成」');
    const idxGenerateCalls = (idxCard.match(/this\.generateSummary\(\)/g) ?? []).length;
    assert.ok(idxGenerateCalls >= 3, `Index.ets 汇总块内应有生成/重试/有汇总态三个入口，实际 ${idxGenerateCalls} 处`);
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
  test('H-1 外壳页头标题 = 分段标签，dots 面板有带标签页头 + typed 禁用原因，另三面用真页头', () => {
    // 旧 PaneHeader builder 随 S3 抽壳落到占位文件里；instances / cloud-chat / dots 三模块后四个面板都落真。
    // old→new（收紧，非删除）：旧断言钉手写 REASON_DOTS 常量；D2 后原因改为 `placeholderRefusalReason`
    // 从冻结闸 COMMAND_WORDING 派生并渲染在 Text 上，旧句「指令确认闸尚未接线」必须绝迹。
    // 正文仍是 chatStore+chatList 真列表（见新增 H-5）。
    const labels = ['dots'];
    labels.forEach((label, index) => {
      assert.match(PANE_CODES[index], new RegExp(`Text\\('${label}'\\)`), `缺少「${label}」分段标签`);
      assert.equal(PANE_CODES[index].includes('指令确认闸尚未接线'), false,
        `${label} 不得再手写「指令确认闸尚未接线」（闸门已接线，文案必须是假的）`);
      assert.match(PANE_CODES[index], /placeholderRefusalReason\(\{/,
        `${label} 禁用原因必须由纯函数从 COMMAND_WORDING 派生`);
      assert.match(PANE_CODES[index], /发指令（\$\{this\.refusalReason\}）/,
        `${label} 禁用动作必须显示「发指令（原因）」`);
    });
    // mod-shell-cloud-chat-pane（old→new，收紧）：云端标题仍在，禁用原因 / 占位文案绝迹。
    assert.match(PANE_CODES[1], /Text\('云端对话'\)/, '云端面板页头仍有分段标题');
    assert.equal(/REASON_[A-Z]+|新建对话|即将迁入/.test(PANE_CODES[1]), false,
      '云端面板禁用原因 / 占位文案绝迹');
    assert.match(INSTANCES_CODE, /Text\('远程 DSH'\)/, '远程 DSH 仍有分段标题');
    assert.match(INSTANCES_CODE, /Text\('添加实例'\)/, '远程 DSH 主操作是真动作，不是禁用占位');
    assert.equal(/REASON_REMOTE|远程面板即将迁入/.test(INSTANCES_SOURCE), false, '远程占位原因绝迹');
    assert.match(source, /title: this\.pageTitle\(\)/, '日程面板的真页头标题仍走 pageTitle()');
    // 旧断言「日程面板沿用唯一设置出口」→ 新断言：面板页头无设置动作，主操作是「新建」。
    assert.equal(/headerActionTwo|onHeaderActionTwo|⚙ 设置|openSettings/.test(code), false,
      '日程面板页头无设置动作（唯一出口在 rail 齿轮）');
    assert.match(code, /Button\('新建'\)/, '日程面板主操作必须是「新建」');
    assert.match(RAIL, /label: 'dots'/);
    assert.match(RAIL, /label: '日程'/);
    assert.match(RAIL, /label: '远程 DSH'/);
    assert.match(RAIL, /label: '云端对话'/);
  });

  test('H-2 设置出口唯一 + 四面板 pushUrl 正向清单：dots 1 / 日程 2 / 远程 2 / 云端 1（只到只读详情），且无跨节页', () => {
    // 旧 headerActionTwo: '⚙ 设置' 的唯一出口属性 → 现在由 rail 齿轮 + 父页 openSettings 承担。
    assert.match(RAIL, /const SETTINGS_GLYPH: string = '⚙';/);
    assert.match(RAIL, /SettingsRow\(\) \{/, '齿轮行 builder 必须在 rail 里');
    assert.match(RAIL, /this\.SettingsRow\(\)/, '齿轮行必须渲染');
    assert.match(RAIL, /onOpenSettings: \(\) => void/, 'rail 只发事件，不自己跳转');
    assert.equal(/from '@kit\.ArkUI'|router/.test(RAIL_CODE), false, 'ShellRail 不得自己 import router（注释里的说明不算）');
    const pushes = HOME.match(/pushUrl\(\{ url: 'pages\/Settings' \}\)/g) ?? [];
    assert.equal(pushes.length, 1, '外壳里只能有一处进设置页的跳转');
    assert.match(HOME, /private openSettings\(\): void/, '跳转集中在 openSettings()');
    // 旧断言只数 Home 里的一处；新断言正向钉「外壳 + 四面板里恰好一处，且位于 Home」。
    assert.deepEqual(settingsPushFiles(), ['Home.ets'],
      '正向断言：Settings push 恰好一处、位于 Home.ets（rail 齿轮 → Home.openSettings）');
    // 齿轮可达性：Home 两处 ShellRail 装配都把 onOpenSettings 接到 openSettings。
    assert.equal((HOME_CODE.match(/onOpenSettings: \(\): void => \{\s*\n\s*this\.openSettings\(\);/g) ?? []).length, 2,
      '宽屏常驻轨与 compact 抽屉轨都必须把齿轮事件接到 openSettings');
    for (const [file, text] of SETTINGS_SHELL_SOURCES.filter(([name]) => name.endsWith('Pane.ets'))) {
      assert.equal(/headerActionTwo|onHeaderActionTwo|⚙ 设置|private openSettings/.test(text), false,
        `${file} 不得含有设置动作（唯一出口 = rail 齿轮）`);
    }
    // 面板动作槽随 S3 抽壳搬进占位文件；远程 DSH 迁真后 4 → 3，mod-shell-cloud-chat-pane 后 3 → 2。
    // mod-shell-dots-pane（old→new，收紧）：dots 正文落真只读列表后，禁用输入框随 scaffold 删除，
    // 只剩「新建对话」一处禁用动作（2 → 1），且逐字禁止任何输入框 / 发送假入口复活。
    const disabled = PANE_CODES.flatMap((code) => code.match(/\.enabled\(false\)/g) ?? []);
    assert.equal(disabled.length, 1, '只剩 dots「新建对话」动作一处禁用；云端无禁用假入口');
    assert.equal(/TextInput\(|输入给 dots 的指令…|发送按钮/.test(PANE_CODES[0]), false,
      'dots 面板已落真只读列表，不得保留禁用输入框 / 发送假入口（发指令属 mod-dots-readonly）');
    for (const [index, code] of PANE_CODES.entries()) {
      if (index === 0) {
        assert.match(code, /Text\(`发指令（\$\{this\.refusalReason\}）`\)[\s\S]{0,400}\.enabled\(false\)/,
          'dots 的「发指令」动作必须禁用并把 typed 原因渲染在 Text 上（无假入口）');
      } else {
        assert.equal(/\.enabled\(false\)/.test(code), false, '云端面板已落真，不得有禁用假入口');
      }
      // 旧断言禁掉一切 pushUrl；云端点行进只读详情是真路径，故禁令继续精确锁定跨节页 / 设置根页。
      assert.equal(/pushUrl\(\{\s*url:\s*'pages\/(Chats|Home|Settings)'/.test(code), false,
        `面板 ${index} 不得自行跳跨节页 / 设置根页`);
    }
    // mod-shell-cloud-chat-pane（评审 M2 修复，old→new 收紧）：旧 H-2 是「四面板零 pushUrl」的
    // blanket ban，云端落真后必须放行 pages/ChatDetail。这里不用「只禁三个目标」的宽松版收尾，
    // 而是补一张**逐面板正向清单**：次数 + 字面目标 + 非字面目标三项同时逐字钉住当前真值，
    // 任何面板多出第二处 pushUrl 或改了目标都会红；上面的跨节页 / 设置根页禁令原样保留。
    // 真值来自当前源码：dots 1（只读详情，old→new：scaffold 0 → 真实列表 1）；
    // 日程 2（pages/Edit、pages/Detail）；远程 2（动态 routeToRemote() 与 ROUTE_INSTANCES）；
    // 云端 1（pages/ChatDetail）。其余三面板的清单逐字不动。
    const pushInventory = [
      { name: 'DotsPane.ets', source: PANE_CODES[0], count: 1, literal: ['pages/ChatDetail'], dynamic: [] },
      { name: 'SchedulePane.ets', source: code, count: 2, literal: ['pages/Edit', 'pages/Detail'], dynamic: [] },
      { name: 'InstancesPane.ets', source: INSTANCES_CODE, count: 2, literal: [],
        dynamic: ['routeToRemote()', 'ROUTE_INSTANCES'] },
      { name: 'CloudChatPane.ets', source: PANE_CODES[1], count: 1, literal: ['pages/ChatDetail'], dynamic: [] }
    ];
    for (const entry of pushInventory) {
      const calls = entry.source.match(/pushUrl\s*\(/g) ?? [];
      assert.equal(calls.length, entry.count,
        `${entry.name}: pushUrl 次数必须是 ${entry.count}（多一处即红，云端必须是恰好一处）`);
      const literal = [...entry.source.matchAll(/pushUrl\(\{\s*url:\s*'([^']+)'/g)].map((m) => m[1]);
      assert.deepEqual(literal, entry.literal, `${entry.name}: pushUrl 字面目标清单必须逐字一致`);
      const dynamic = [...entry.source.matchAll(/pushUrl\(\{\s*url:\s*([A-Za-z_]\w*(?:\(\))?)/g)].map((m) => m[1]);
      assert.deepEqual(dynamic, entry.dynamic, `${entry.name}: pushUrl 非字面目标清单必须逐字一致`);
    }
    assert.match(INSTANCES_CODE, /const ROUTE_INSTANCES: string = 'pages\/Instances';/,
      'InstancesPane 的 ROUTE_INSTANCES 必须仍是设置实例路由（不是跨节页）');
    assert.equal(/\.enabled\(false\)/.test(INSTANCES_CODE), false, '远程 DSH 主操作不再禁用');
    assert.equal(/pushUrl\(\{\s*url: 'pages\/Home'/.test(INSTANCES_CODE), false,
      '远程面板不得 pushUrl 到外壳页切段');
    // old→new（收紧）：旧断言钉「禁用输入框」；新真值是无输入框 —— 发指令尚未接线，
    // 面板只保留一个带 typed 原因的禁用「新建对话」动作，绝不渲染假的输入 / 发送入口。
    assert.equal(/TextInput\(|placeholder: '输入给 dots 的指令…'|pages\/Chats|pages\/Home/.test(PANE_CODES[0]), false,
      'dots 面板不得有禁用输入框、假发送入口或跨节页跳转');
    assert.match(PANE_CODES[0], /Text\(`发指令（\$\{this\.refusalReason\}）`\)/,
      'dots 的禁用动作必须仍在并把 typed 原因渲染在 Text 上');
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
    // 反向证明旧断言没有被 drop：日程契约四例仍钉在原锚点上（设置动作那条已正向改为「无」）。
    assert.equal(/headerActionTwo|onHeaderActionTwo/.test(code), false, '日程面板页头不得有设置动作');
    assert.match(source, /this\.SummaryCard\(\)/);
    assert.match(source, /AiPanel\(\) \{/);
  });

  // mod-shell-dots-pane（新增正向守卫）：dots 页头所在面板已是真列表，且没有假行 / 跨节导航。
  test('H-5 dots 面板是真只读列表：ForEach(this.chats) + chatStore/chatList + 无假行', () => {
    const dots = PANE_CODES[0];
    assert.match(dots, /ForEach\(\s*this\.chats/, 'dots 面板必须 ForEach 真实会话数组');
    assert.match(dots, /chatSummaryLine\(item\)/, '行摘要必须走纯模型，不是手写假文案');
    for (const token of ['chatStore.prepare(', 'chatStore.listChats()', 'filterBySegment(', 'sortChats(',
      "PANE_KIND: ChatKind = 'dots'", 'ChatListResult']) {
      assert.ok(dots.includes(token), `dots 面板必须复用 ${token}`);
    }
    for (const fake of ['RecordRow(', 'Checkbox(', '示例', 'Lorem', '假数据']) {
      assert.equal(dots.includes(fake), false, `dots 面板不得出现假行标记「${fake}」`);
    }
    assert.equal(/JSON\.parse\(|readTextSync\(/.test(dots), false, '不得自行解析 JSON / 读文件');
  });

  // mod-dots-readonly（新增正向守卫）：只读授权行 + 渲染原因 + 新副标题 + 零 mutation，四条同钉。
  test('H-6 dots 只读授权行来自 instanceGrantStore；禁用原因渲染在 Text；旧副标题绝迹；无 grant/revoke/prompt', () => {
    const raw = SCAFFOLD_PANES[0];
    const dots = PANE_CODES[0];
    assert.match(raw, /import \{ instanceGrantStore \} from '\.\.\/\.\.\/services\/instanceGrantStore';/);
    assert.match(dots, /instanceGrantStore\.lastProblem\(\)/, 'typed problem 读取（坏信封 fail-closed）');
    assert.match(dots, /instanceGrantStore\.redacted\(nowMs\)/, '只读 redacted 视图');
    assert.match(dots, /Text\(this\.grantLine\)/, '授权行必须是渲染文案，不是注释 / 日志');
    assert.ok(dots.includes('未授权 / 未知'), '坏信封 / 空表必须给「未授权 / 未知」');
    assert.match(dots, /Text\(`发指令（\$\{this\.refusalReason\}）`\)/, '禁用原因必须在渲染的 Text 上');
    assert.equal(/console\./.test(dots), false, '原因不得只写日志');
    assert.equal(raw.includes('dots 可查看实例并对会话发指令，所有操作需你确认。'), false,
      '旧过度承诺副标题全文绝迹');
    assert.ok(dots.includes("const DOTS_SUBTITLE: string = 'dots 只读查看会话，暂不能发指令。';"));
    assert.match(dots, /Text\(DOTS_SUBTITLE\)/, '新副标题必须渲染');
    for (const api of ['instanceGrantStore.upsert(', 'instanceGrantStore.revoke(', 'upsertGrant(',
      'revokeGrant(', 'session.prompt(', 'sessionPrompt(']) {
      assert.equal(dots.includes(api), false, `只读面板不得调用 ${api}`);
    }
  });

  // mod-home-global-refresh（新增正向守卫，旧 H-1..H-6 一条未删）：
  // 全局下拉失败只由既有的 SyncStatusRow 渲染；外壳不新增第二行、面板不弹第二处 toast。
  test('H-7 全局下拉只有一处 typed 失败渲染面（SyncStatusRow），外壳不复制状态行', () => {
    const row = memberBody('SyncStatusRow');
    assert.match(row, /Text\(this\.syncStatus\.text\)/, '状态行是唯一 typed 失败渲染点');
    assert.match(row, /this\.syncStatus\.state === 'failed'/);
    // 外壳只有全局 Refresh 容器与转圈状态，没有第二处状态行 / 失败文案
    assert.equal(/SyncStatusRow|失败：\$\{|失败：$/.test(HOME_CODE), false,
      'Home 不得复制状态行或拼第二处 typed 失败文案');
    assert.equal(/promptAction|showToast/.test(source.slice(
      source.indexOf('private async onPullRefresh(): Promise<void> {'),
      source.indexOf('private async retrySync(): Promise<void> {'))), false,
      '面板下拉路径零 toast');
    // 状态行仍在竖屏与横屏两栏各一处（p0a syncWiring 62b 的同一契约）
    for (const builder of ['CompactBody', 'WideBody']) {
      assert.match(memberBody(builder), /this\.SyncStatusRow\(\)/, `${builder} 仍渲染同一状态行`);
    }
  });
});
