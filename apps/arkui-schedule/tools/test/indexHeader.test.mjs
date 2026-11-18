// 首页页头守卫（源码级，防回归）：**页头不再有「✨ AI 汇总」图标入口**。
//
// 用户反馈：首页右上角那个 AI 汇总图标点了没反应，但图标一直占着位置。
// 定版口径：
//   - 页头只留 `今天`（左）+ `⚙ 设置`（右），中间不放任何空按钮 → `PageLayout` 只传
//     `headerActionTwo: '⚙ 设置'`，`headerActionOne` / `onHeaderActionOne` /
//     `onHeaderSummaryAction` 全部删除（`PageLayout` 在标签为空时不渲染，不会留空位）；
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
const pagePath = join(here, '..', '..', 'entry', 'src', 'main', 'ets', 'pages', 'Index.ets');
const source = readFileSync(pagePath, 'utf8');

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

describe('首页页头：AI 汇总图标入口已删除', () => {
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
