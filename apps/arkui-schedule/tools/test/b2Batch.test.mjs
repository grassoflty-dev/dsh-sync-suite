// B2 批测试补齐：「导出区间快捷 chip（面板）」+「紧凑屏组锚点真跳转（设置页）」的源码级契约守卫。
//
// 为什么是静态断言：`ExportImportPanel.ets` / `pages/Settings.ets` 都是 ArkTS（依赖 @kit.ArkUI
// 等运行时），Node 里跑不起来。但「chip 是否始终可点」「跳转是否真用 pageScroller.scrollTo」
// 「锚点行是否只出现在紧凑屏」「五个 group 的埋点是否各一次」这些都是纯文本可判定的事实，
// 用测试固化能挡住「加了 chip 却静默禁用」「锚点只 toast 不滚」「宽屏被误改骨架」这类回归。
//
// 本文件只断言契约，不迁就半成品：断言按 B2 契约写，实现偏离就红（不把测试改宽去迁就）。
// 前置：无需构建（不 import .build），直接读源码。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { readSettingsPage } from './settingsSources.mjs';

const PANEL = readFileSync(
  new URL('../../entry/src/main/ets/components/ExportImportPanel.ets', import.meta.url),
  'utf8'
);
const DATA = readFileSync(
  new URL('../../entry/src/main/ets/components/settings/DataSection.ets', import.meta.url),
  'utf8'
);
const PAGE = readSettingsPage();

/**
 * 剥掉块注释与行注释，但**保留字符串字面量里的 `//`**（避免把 URL / 文案误当注释）。
 * 用途：注释里可能写过 `new Date()` 这几个字（陈述纪律），那不是真的在组件里构造时间；
 * 只有可执行代码里的 `new Date(` 才算破坏「纯展示组件」约束。
 */
function stripComments(source) {
  let out = '';
  let i = 0;
  let quote = '';
  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];
    if (quote !== '') {
      out += char;
      if (char === '\\') {
        out += next ?? '';
        i += 2;
        continue;
      }
      if (char === quote) {
        quote = '';
      }
      i += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      out += char;
      i += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : '';
        i += 1;
      }
      i += 2;
      continue;
    }
    if (char === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') {
        i += 1;
      }
      continue;
    }
    out += char;
    i += 1;
  }
  return out;
}

/** 从 `signature` 起按大括号配平截取方法 / Builder 体（含签名自身，避免相邻方法互相污染）。 */
function bodyFrom(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `找不到方法/Builder：${signature}`);
  const brace = source.indexOf('{', start);
  assert.ok(brace >= 0, `${signature} 找不到起始大括号`);
  let depth = 0;
  for (let i = brace; i < source.length; i += 1) {
    if (source[i] === '{') {
      depth += 1;
    } else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }
  assert.fail(`${signature} 的大括号不配平`);
}

/** 断言若干锚点在文本里按给定顺序各出现一次（先检查 >=0，避免出现 -1 时比较「假通过」）。 */
function assertOrdered(text, tokens, label) {
  let previous = -1;
  for (const token of tokens) {
    const index = text.indexOf(token);
    assert.ok(index >= 0, `${label}：找不到 ${token}`);
    assert.ok(index > previous, `${label}：${token} 的顺序不对（应排在 ${tokens[tokens.indexOf(token) - 1] ?? '开头'} 之后）`);
    previous = index;
  }
}

const QUICK_ROW = bodyFrom(PANEL, 'QuickRangeRow() {');
const BUILD = bodyFrom(PANEL, 'build() {');
const JUMP = bodyFrom(PAGE, 'private jumpToGroup(');
const ANCHOR_CHIP = bodyFrom(PAGE, 'GroupAnchorChip(label: string, index: number)');
const ANCHOR_BAR = bodyFrom(PAGE, 'GroupAnchorBar() {');
const COMPACT = bodyFrom(PAGE, 'CompactBody() {');
const WIDE = bodyFrom(PAGE, 'WideBody() {');

// ---------------------------------------------------------------------------
// 面板：导出区间快捷 chip（D4）—— chip 只写本地输入态，没有静默禁用，也不散落 new Date()。
// ---------------------------------------------------------------------------
describe('B2 面板 ExportImportPanel.ets：快捷 chip 的源码级契约', () => {
  test('B2-13 三个新方法齐备：@Builder QuickRangeRow + applyQuickRange + isQuickActive', () => {
    assert.match(PANEL, /@Builder\s*\n\s*QuickRangeRow\(\)/, '契约丢了：缺 @Builder QuickRangeRow()');
    assert.match(PANEL, /private applyQuickRange\(kind: string\): void/, '契约丢了：缺 applyQuickRange(kind: string)');
    assert.match(PANEL, /private isQuickActive\(kind: string\): boolean/, '契约丢了：缺 isQuickActive(kind: string)');
    // 评审 P2-3：只钉「方法存在」挡不住「面板自造一套日期格式化」的回归，
    // 必须钉住它们真的复用 model 的纯函数（quickRange / isQuickRangeActive）。
    const APPLY = bodyFrom(PANEL, 'private applyQuickRange(');
    assert.match(APPLY, /quickRange\(kind\)/, '契约丢了：applyQuickRange 必须调 model 的 quickRange(kind)，不得自造格式化');
    const ACTIVE = bodyFrom(PANEL, 'private isQuickActive(');
    assert.match(
      ACTIVE,
      /isQuickRangeActive\(kind,\s*this\.fromText,\s*this\.toText\)/,
      '契约丢了：isQuickActive 必须调 model 的 isQuickRangeActive(kind, fromText, toText)'
    );
  });

  test('B2-14 QuickRangeRow 用 ForEach(QUICK_RANGE_OPTIONS) 渲染 ActionButton，且 chip 始终 actionEnabled: true', () => {
    assert.match(QUICK_ROW, /ForEach\(\s*QUICK_RANGE_OPTIONS/, '契约丢了：QuickRangeRow 没有遍历 QUICK_RANGE_OPTIONS');
    assert.match(QUICK_ROW, /ActionButton\(\{/, '契约丢了：chip 必须用 ActionButton 而不是裸 Text 点击');
    assert.match(QUICK_ROW, /=>\s*option\.kind/, '契约丢了：ForEach 缺少按 option.kind 的 key 生成函数');
    const enabledTokens = QUICK_ROW.match(/actionEnabled:\s*[^,\n]+/g) ?? [];
    assert.ok(enabledTokens.length > 0, '契约丢了：chip 没有 actionEnabled 字段');
    for (const token of enabledTokens) {
      // 评审 P2-2：按整个 token 锚定，`actionEnabled: true && !this.state.busy` 这种「看着是 true 其实可禁用」也要红。
      assert.match(token.trim(), /^actionEnabled:\s*true\s*$/, `契约丢了：chip 必须恒为 actionEnabled: true（实际 ${token}）`);
    }
    assert.doesNotMatch(
      QUICK_ROW,
      /actionEnabled:\s*!this\.state\.busy/,
      '契约丢了：chip 不应随导出忙碌静默禁用（要能在忙碌中改区间）'
    );
  });

  test('B2-15 build() 顺序：GroupTitle(导出) → HintLine → QuickRangeRow → 两个日期输入', () => {
    assertOrdered(
      BUILD,
      [
        "this.GroupTitle('导出')",
        "this.HintLine('按日期区间导出完整包",
        'this.QuickRangeRow()',
        'this.FromInput()',
        'this.ToInput()'
      ],
      'ExportImportPanel.build()'
    );
  });

  test('B2-16 纯展示纪律：剥注释后无 new Date(，且 @State 行数仍是 2（mod-export-json 删除格式状态）', () => {
    const code = stripComments(PANEL);
    assert.equal(code.includes('new Date('), false, '契约丢了：面板代码里不得自己构造 Date（今天走 model.todayText()）');
    const stateCount = (PANEL.match(/^\s*@State\b/gm) ?? []).length;
    // 原 5 = fromText/toText/format/includeAttachments/includeMeta；后 3 个随 Markdown 删除，
    // 不是覆盖削弱——格式与两个 Markdown 开关已经不存在（chip 高亮仍现算、选择只写本地输入态）。
    assert.equal(stateCount, 2, '面板只应保留 fromText / toText 两个 @State（纯展示纪律不变）');
  });

  test('B2-17 QuickRangeRow 内每个 ActionButton 调用点都带 label / actionEnabled / disabledReason / onTap', () => {
    const buttons = QUICK_ROW.split('ActionButton({').slice(1);
    assert.equal(buttons.length, 1, 'QuickRangeRow 里应恰好有一个 ActionButton 调用点（ForEach 模板）');
    for (const body of buttons) {
      assert.match(body, /label:/, '契约丢了：chip 缺 label');
      assert.match(body, /actionEnabled:/, '契约丢了：chip 缺 actionEnabled');
      assert.match(body, /disabledReason:/, '契约丢了：chip 缺 disabledReason');
      assert.match(body, /onTap:/, '契约丢了：chip 缺 onTap');
    }
  });

  test('B2-26 区间入口只剩 chip + 两个日期输入：重复「填今天」空态已删，非法区间错误提示仍在', () => {
    // 「今天 / 本周 / 近 7 天」chip 已能一键填今天，面板里不再有第二套「填今天」提示/动作。
    assert.equal(PANEL.includes('填今天'), false, '契约丢了：面板不应再出现「填今天」提示文案');
    assert.equal(PANEL.includes('EMPTY_EXPORT_ACTION'), false, '契约丢了：「填今天」动作常量必须删除');
    assert.equal(PANEL.includes('showEmptyExport()'), false, '契约丢了：空态渲染判据必须删除');
    assert.equal(PANEL.includes('fillToday()'), false, '契约丢了：「填今天」动作方法必须删除');
    // chip 与两个日期输入都保留：它们是区间选择的唯一入口。
    assert.ok(BUILD.includes('this.QuickRangeRow()'), '契约丢了：快捷区间 chip 必须保留');
    assert.ok(BUILD.includes('this.FromInput()'), '契约丢了：开始日期输入必须保留');
    assert.ok(BUILD.includes('this.ToInput()'), '契约丢了：结束日期输入必须保留');
    // 非法区间（from > to / 空串 / 非法日期）的错误提示仍由导出按钮的 disabledReason 给出。
    const BLOCK = bodyFrom(PANEL, 'private exportBlockedReason(');
    assert.match(BLOCK, /parseDateRange\(this\.fromText, this\.toText\)/, '契约丢了：错误提示必须继续走 parseDateRange');
    assert.match(BLOCK, /return range\.reason/, '契约丢了：非法区间原因必须原样回显');
    assert.match(BUILD, /disabledReason: this\.exportBlockedReason\(\)/, '契约丢了：导出按钮必须继续显示非法区间原因');
  });

  test('B2-27 一个入口：备份节整段删除，主导出产出含媒体完整包，DataSection 只装配一个面板', () => {
    // 注释允许写「已删备份节」的说明，只检查可执行源码。
    const panelCode = stripComments(PANEL);
    const dataCode = stripComments(DATA);
    for (const token of ['V2Section', '日程备份', '导出备份', 'v2PlanReady', 'v2Busy', 'onV2Export', 'onV2Pick', 'onV2Apply', 'onV2Cancel']) {
      assert.equal(panelCode.includes(token), false, `契约丢了：面板残留已删备份节点 ${token}`);
      assert.equal(dataCode.includes(token), false, `契约丢了：DataSection 残留已删备份 props ${token}`);
    }
    assert.equal((DATA.match(/ExportImportPanel\(\{/g) ?? []).length, 1, 'DataSection 必须只装配一个面板');
    assert.equal((BUILD.match(/label: '导出完整包'/g) ?? []).length, 1, '只能有一个主导出按钮');
    assert.equal((BUILD.match(/this\.GroupTitle\('导出'\)/g) ?? []).length, 1, '只能有一个导出组');
    assert.equal((BUILD.match(/this\.GroupTitle\('导入'\)/g) ?? []).length, 1, '只能有一个导入组');
    assert.match(BUILD, /按日期区间导出完整包/, '主导出必须说明包含媒体');
  });
});

// ---------------------------------------------------------------------------
// 设置页：仅紧凑屏的组锚点——真滚到目标组（pageScroller.scrollTo），未测量时 toast 说明原因。
// ---------------------------------------------------------------------------
describe('B2 设置页 Settings.ets（紧凑屏）：组锚点真跳转的源码级契约', () => {
  test('B2-18 常量 ANCHOR_NOT_READY + 非 @State 的 groupOffsets + 三个新方法齐备', () => {
    assert.match(
      PAGE,
      /const ANCHOR_NOT_READY: string = '页面还在排版，稍后再点一次';/,
      '契约丢了：缺 ANCHOR_NOT_READY 常量或文案不符'
    );
    assert.match(
      PAGE,
      /private groupOffsets: number\[\] = \[-1, -1, -1, -1, -1\];/,
      '契约丢了：groupOffsets 必须是 5 个 -1 的普通私有字段'
    );
    assert.equal(/@State\s+groupOffsets/.test(PAGE), false, '契约丢了：groupOffsets 不得是 @State（测量缓存无需触发重绘）');
    assert.match(PAGE, /private lengthToVp\(value: Length \| undefined\): number/, '契约丢了：缺 lengthToVp');
    assert.match(PAGE, /private measureGroup\(index: number, area: Area\): void/, '契约丢了：缺 measureGroup');
    assert.match(PAGE, /private jumpToGroup\(index: number\): void/, '契约丢了：缺 jumpToGroup');
  });

  test('B2-19 jumpToGroup 用 pageScroller.scrollTo({ yOffset: offset, animation })，未测量则 toast，绝不只有 scrollEdge', () => {
    assert.match(JUMP, /this\.pageScroller\.scrollTo\(\{/, '契约丢了：jumpToGroup 没调用 pageScroller.scrollTo');
    assert.match(JUMP, /yOffset: offset/, '契约丢了：scrollTo 的 yOffset 必须取测到的 offset');
    // 评审 P1-1：只钉「yOffset: offset」挡不住「把 offset 硬编码/按比例算」的假跳转，
    // 必须钉住 offset 真的来自 onAreaChange 写入的测量缓存。
    assert.match(
      JUMP,
      /const offset:\s*number\s*=\s*this\.groupOffsets\[index\];/,
      '契约丢了：yOffset 必须来自测量缓存 this.groupOffsets[index]，不得硬编码/按比例算'
    );
    assert.equal(/yOffset:\s*\d/.test(JUMP), false, '契约丢了：不得把 offset 硬编码成数字字面量');
    assert.match(JUMP, /animation:\s*\{\s*duration:\s*250\s*\}/, '契约丢了：滚动动画时长应为 250ms');
    assert.match(JUMP, /offset < 0/, '契约丢了：未测量分支缺 offset < 0 判定');
    assert.match(JUMP, /promptAction\.showToast\(\{ message: ANCHOR_NOT_READY \}\)/, '契约丢了：未测量分支缺 toast 原因');
    assert.match(JUMP, /ANCHOR_NOT_READY/, '契约丢了：jumpToGroup 没引用 ANCHOR_NOT_READY');
    assert.equal(JUMP.includes('scrollEdge'), false, '契约丢了：不能用 scrollEdge 冒充真跳转');
  });

  test('B2-20 GroupAnchorBar 五个标签按 同步/AI/远程/数据/关于 顺序，且恰好 5 次 GroupAnchorChip', () => {
    assertOrdered(ANCHOR_BAR, ["'同步'", "'AI'", "'远程'", "'数据'", "'关于'"], 'GroupAnchorBar');
    const chips = ANCHOR_BAR.match(/this\.GroupAnchorChip\(/g) ?? [];
    assert.equal(chips.length, 5, '契约丢了：锚点行必须恰好五个 chip');
  });

  test('B2-21 锚点是原生 Button(label) + jumpToGroup(index)，不是 Text 点击，且无 .enabled(false)', () => {
    assert.match(ANCHOR_CHIP, /Button\(label\)/, '契约丢了：锚点必须用原生 Button(label)');
    assert.match(ANCHOR_CHIP, /this\.jumpToGroup\(index\)/, '契约丢了：锚点点击必须调 jumpToGroup(index)');
    assert.match(ANCHOR_CHIP, /\.layoutWeight\(1\)/, '契约丢了：锚点必须等宽（layoutWeight(1)）');
    assert.match(ANCHOR_CHIP, /\.height\(TOUCH_MIN\)/, '契约丢了：锚点命中区高度必须是 TOUCH_MIN');
    for (const [name, slice] of [
      ['GroupAnchorChip', ANCHOR_CHIP],
      ['GroupAnchorBar', ANCHOR_BAR]
    ]) {
      assert.equal(/\bText\(/.test(slice), false, `契约丢了：${name} 不得用 Text( 当按钮`);
      assert.equal(slice.includes('.enabled(false)'), false, `契约丢了：${name} 不得静默禁用`);
    }
  });

  test('B2-22 CompactBody 顺序：Scroll → GroupAnchorBar → IssuesBanner → SyncGroup，五组埋点各一次(0..4)', () => {
    assertOrdered(
      COMPACT,
      ['Scroll(this.pageScroller)', 'this.GroupAnchorBar()', 'this.IssuesBanner()', 'this.SyncGroup()'],
      'CompactBody'
    );
    const calls = COMPACT.match(/this\.measureGroup\(\d+,/g) ?? [];
    assert.equal(calls.length, 5, `契约丢了：measureGroup 调用应恰好 5 次，实际 ${calls.length}`);
    for (let index = 0; index < 5; index += 1) {
      assert.equal(
        calls.filter((call) => call === `this.measureGroup(${index},`).length,
        1,
        `契约丢了：measureGroup(${index}, ...) 必须恰好一次`
      );
    }
    assert.ok(COMPACT.includes('this.ChatEntryRow()'), '契约丢了：ChatEntryRow 应保持裸调用、仍在紧凑屏里');
  });

  test('B2-23 WideBody 完全没被锚点污染，五个组的调用仍在', () => {
    for (const token of ['GroupAnchorBar', 'measureGroup', 'onAreaChange']) {
      assert.equal(WIDE.includes(token), false, `契约丢了：宽屏骨架不得出现 ${token}（只改紧凑屏）`);
    }
    for (const group of ['SyncGroup', 'AiGroup', 'RemoteGroup', 'DataGroup', 'AboutGroup']) {
      assert.ok(WIDE.includes(`this.${group}()`), `契约丢了：宽屏仍须调用 this.${group}()`);
    }
  });

  test('B2-24 宽窄两套骨架都以 this.SaveButton() 收尾（Scroll 在前、保存按钮在后）', () => {
    for (const [name, slice] of [
      ['CompactBody', COMPACT],
      ['WideBody', WIDE]
    ]) {
      const scrollIndex = slice.indexOf('Scroll(this.pageScroller)');
      const saveIndex = slice.lastIndexOf('this.SaveButton()');
      assert.ok(scrollIndex >= 0, `${name}：缺 Scroll(this.pageScroller)`);
      assert.ok(saveIndex > scrollIndex, `${name}：SaveButton 必须排在 Scroll 之后`);
      assert.equal(
        /(?:Sync|Ai|Remote|Data|About)Group\(\)/.test(slice.slice(saveIndex)),
        false,
        `${name}：SaveButton 之后不得再有组调用（必须收尾）`
      );
    }
  });

  test('B2-25 交互一致性（STATE-UI）：锚点无 .enabled(，未测量分支给中文 toast，不是静默吞点击', () => {
    assert.equal(ANCHOR_CHIP.includes('.enabled('), false, '契约丢了：锚点不得出现任何 .enabled( 静默禁用');
    assert.match(
      JUMP,
      /if \(offset < 0\) \{[\s\S]*?promptAction\.showToast\(\{ message: ANCHOR_NOT_READY \}\)/,
      '契约丢了：未测量（offset < 0）分支必须给中文 toast 说明原因'
    );
  });
});
