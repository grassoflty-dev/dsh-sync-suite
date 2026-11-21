// mod-home-entries：首页「对话」双格条 + 共享会话列表 `kind` 分段的源码级契约。
//
// ArkTS（.ets）依赖 @kit.ArkUI，Node 里跑不起来；沿用 homeFilters / b3Batch 的
// stripComments + bodyFrom 风格，只钉「能在源码里逐字复核」的事实：两个格子的文案 /
// 落位 / 次样式、两个断点各渲染一次、`kind` 的读侧默认与分段过滤、两段空态文案、
// 路由预选分段与返回首页。纯逻辑行为（默认 / 过滤结果）在 chatList.test.mjs 里跑。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const INDEX_PATH = new URL('../../entry/src/main/ets/pages/Index.ets', import.meta.url);
const CHATS_PATH = new URL('../../entry/src/main/ets/pages/Chats.ets', import.meta.url);
const MODEL_PATH = new URL('../../entry/src/main/ets/model/chatList.ts', import.meta.url);

const INDEX_RAW = readFileSync(INDEX_PATH, 'utf8');
const CHATS_RAW = readFileSync(CHATS_PATH, 'utf8');
const MODEL_RAW = readFileSync(MODEL_PATH, 'utf8');

/** 去注释（保留字符串字面量里的括号），结构守卫只对代码生效。 */
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

/** 从 `needle` 起按大括号配平截取成员 / Builder 体（含签名）。 */
function bodyFrom(source, needle) {
  const start = source.indexOf(needle);
  assert.ok(start >= 0, `找不到成员/Builder：${needle}`);
  const brace = source.indexOf('{', start);
  assert.ok(brace >= 0, `${needle} 找不到起始大括号`);
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
  assert.fail(`${needle} 的大括号不配平`);
}

const INDEX = stripComments(INDEX_RAW);
const CHATS = stripComments(CHATS_RAW);
const MODEL = stripComments(MODEL_RAW);

const CHAT_ENTRIES = bodyFrom(INDEX, '\n  ChatEntries() {');
const OPEN_CHATS = bodyFrom(INDEX, 'private openChats(');
const COMPACT = bodyFrom(INDEX, '\n  CompactBody() {');
const WIDE = bodyFrom(INDEX, '\n  WideBody() {');
const KIND_SEGMENT = bodyFrom(CHATS, '\n  KindSegment() {');
const READ_KIND = bodyFrom(CHATS, 'private readKindParam(');
const APPLY_QUERY = bodyFrom(CHATS, 'private applyQuery(');
const EMPTY_CLOUD = bodyFrom(CHATS, '\n  EmptyCloudChats() {');
const EMPTY_DOTS = bodyFrom(CHATS, '\n  EmptyDotsChats() {');
const EMPTY_CHATS = bodyFrom(CHATS, '\n  EmptyChats() {');
const CHATS_BODY = bodyFrom(CHATS, '\n  Body() {');
const CHAT_LIST = bodyFrom(CHATS, '\n  ChatList() {');

describe('mod-home-entries · 首页对话双格条', () => {
  test('恰好两格：文案「纯云端对话」/「与 dots 对话」，没有第三个格子', () => {
    const labels = [...CHAT_ENTRIES.matchAll(/label: '([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(labels, ['纯云端对话', '与 dots 对话'], `双格条文案不对：${JSON.stringify(labels)}`);
  });

  test('两个断点各渲染一次，且都在唯一主操作之上（横屏右栏不重复）', () => {
    for (const [builder, body, action] of [
      ['CompactBody', COMPACT, 'this.PrimaryAction()'],
      ['WideBody', WIDE, 'this.SidebarAction()']
    ]) {
      const entriesAt = body.indexOf('this.ChatEntries()');
      const actionAt = body.indexOf(action);
      assert.ok(entriesAt >= 0, `${builder} 必须渲染双格条`);
      assert.ok(actionAt > entriesAt, `${builder} 的双格条必须在 ${action} 之上`);
    }
    assert.equal((INDEX.match(/this\.ChatEntries\(\)/g) ?? []).length, 2, '两个断点各一次，右栏不重复');
    assert.equal((INDEX.match(/Button\('新建'\)/g) ?? []).length, 2, '没有新增第三个主操作');
  });

  test('两个格子都是次要样式（secondary + block），不是实底主按钮', () => {
    assert.equal((CHAT_ENTRIES.match(/variant: 'secondary'/g) ?? []).length, 2, '两格都必须是 secondary');
    assert.equal((CHAT_ENTRIES.match(/block: true/g) ?? []).length, 2, '两格各占一半');
    assert.equal((CHAT_ENTRIES.match(/\.layoutWeight\(1\)/g) ?? []).length, 2, '两格等宽');
    assert.equal(CHAT_ENTRIES.includes("variant: 'primary'"), false, '不得新增主操作样式');
    assert.equal(/\bButton\(/.test(CHAT_ENTRIES), false, '格子走 ActionButton，不裸写 Button');
  });

  test('点击分别预选 cloud / dots 段，路由携带 kind 参数', () => {
    assert.ok(CHAT_ENTRIES.includes("this.openChats('cloud')"), '左格进 cloud 段');
    assert.ok(CHAT_ENTRIES.includes("this.openChats('dots')"), '右格进 dots 段');
    assert.match(OPEN_CHATS, /private openChats\(kind: ChatKind\): void/, '参数用 ChatKind 类型');
    assert.ok(OPEN_CHATS.includes("const params: Record<string, string> = { 'kind': kind };"));
    assert.ok(OPEN_CHATS.includes("router.pushUrl({ url: 'pages/Chats', params: params })"));
    assert.ok(OPEN_CHATS.includes('打开会话列表失败：'), '路由失败给中文原因，不静默');
    assert.match(INDEX, /import type \{ ChatKind \} from '\.\.\/model\/chatList';/, '类型来自纯模型');
  });

  test('返回首页：Chats 页头返回按钮仍走 router.back()', () => {
    assert.match(CHATS, /onBack: \(\) => \{\s*router\.back\(\);\s*\}/, '返回由 router.back 回到来源页（首页）');
  });
});

describe('mod-home-entries · kind 投影与分段过滤', () => {
  test('模型只加 additive 字段：type ChatKind + entry.kind + 读侧默认 + filterByKind 导出', () => {
    assert.match(MODEL, /export type ChatKind = 'cloud' \| 'dots';/);
    assert.match(MODEL, /  kind: ChatKind;/, 'ChatIndexEntry 带 kind 字段');
    assert.match(MODEL, /  kind\?: string;/, 'RawIndexLine 只声明读的键');
    assert.match(MODEL, /kind: normalizeChatKind\(raw\.kind\)/, '解析时走读侧归一');
    assert.match(MODEL, /export function filterByKind\(entries: ChatIndexEntry\[\], kind: ChatKind\): ChatIndexEntry\[\]/);
    // 读侧默认只归一返回值；没有任何把 kind 写回文件的调用（写盘属 services，本片不碰）。
    assert.equal(/write|append|save/i.test(MODEL), false, '纯模型不得出现写盘动作');
  });

  test('normalizeChatKind 只把 dots 识别为 dots，其它一律 cloud（纯函数行为在 chatList.test.mjs 里跑）', () => {
    const norm = bodyFrom(MODEL, 'function normalizeChatKind(');
    assert.ok(norm.includes("value.trim().toLowerCase() === 'dots'"), '唯一进入 dots 的分支');
    assert.ok(norm.includes("return 'cloud';"), '兜底为 cloud');
  });

  test('分段：默认 cloud，只认路由参数 dots；两段共用搜索/三态/刷新', () => {
    assert.match(CHATS, /@State kind: ChatKind = 'cloud';/, '默认左侧 cloud 段');
    assert.ok(READ_KIND.includes("return params['kind'] === 'dots' ? 'dots' : 'cloud';"), '只有 dots 切段');
    assert.ok(CHATS.includes('this.kind = this.readKindParam();'), 'aboutToAppear 预选分段');
    assert.ok(APPLY_QUERY.includes('filterChats(filterByKind(this.chats, this.kind), this.queryText)'),
      '分段过滤后再搜索，共用 chats 不丢数据');
  });

  test('分段常驻顶部：在错误分支与搜索框之前，两个格子文案与选中态绑定正确', () => {
    const segmentAt = CHATS_BODY.indexOf('this.KindSegment()');
    const errorAt = CHATS_BODY.indexOf('this.ErrorBlock()');
    const searchAt = CHATS_BODY.indexOf('this.SearchBar()');
    assert.ok(segmentAt >= 0 && segmentAt < errorAt && segmentAt < searchAt, '分段必须在错误态 / 搜索框之前');
    const labels = [...KIND_SEGMENT.matchAll(/label: '([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(labels, ['纯云端对话', 'dots 对话'], '顶部分段文案');
    assert.ok(KIND_SEGMENT.includes("this.kind === 'cloud' ? 'secondary' : 'ghost'"));
    assert.ok(KIND_SEGMENT.includes("this.kind === 'dots' ? 'secondary' : 'ghost'"));
    assert.equal((KIND_SEGMENT.match(/this\.applyQuery\(\)/g) ?? []).length, 2, '切段只重算内存过滤');
  });

  test('行徽章随 kind 变化，替代固定「只读」', () => {
    assert.match(CHATS, /ChatRow\(id: string, title: string, summary: string, badge: string\)/, '行 builder 带徽章参数');
    assert.ok(CHAT_LIST.includes("item.kind === 'dots' ? 'dots' : 'chat'"), '按 kind 渲染 chat/dots 徽章');
    assert.equal(CHATS.includes("Text('只读')"), false, '固定「只读」徽章已移除');
  });
});

/**
 * 找包含 `call` 且自身以 `.layoutWeight(1)` 收尾的最内层 Column 块。
 * 用来钉「列表被加权兄弟包裹、且双格条不在同一加权区」这一布局契约。
 */
function weightedColumnAround(body, call) {
  const at = body.indexOf(call);
  assert.ok(at >= 0, `${call} 未渲染`);
  const re = /Column\(\) \{/g;
  let match = null;
  while ((match = re.exec(body)) !== null) {
    if (match.index >= at) break;
    const brace = body.indexOf('{', match.index);
    let depth = 0;
    let end = -1;
    for (let i = brace; i < body.length; i += 1) {
      if (body[i] === '{') depth += 1;
      else if (body[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end > at && /\.layoutWeight\(1\)/.test(body.slice(end, end + 80))) {
      return { block: body.slice(match.index, end + 1), end };
    }
  }
  assert.fail(`${call} 不在任何以 layoutWeight(1) 收尾的 Column 加权区里`);
}

describe('mod-home-entries · 布局回归：列表必须拿到余量（§15.12 FAILED）', () => {
  for (const [name, body] of [['CompactBody', COMPACT], ['WideBody', WIDE]]) {
    test(`${name}：RecordList 在以 layoutWeight(1) 收尾的加权区内`, () => {
      const { block } = weightedColumnAround(body, 'this.RecordList()');
      assert.ok(block.includes('this.RecordList()'), '加权区里必须有列表');
      assert.match(block, /\.layoutWeight\(1\)/, '列表区本身必须 layoutWeight(1)，不能被汇总块挤成 0 高');
    });

    test(`${name}：ChatEntries 不在列表的加权区内`, () => {
      const { block } = weightedColumnAround(body, 'this.RecordList()');
      assert.equal(block.includes('this.ChatEntries()'), false,
        '双格条必须留在加权列表区之外，不与列表争余量');
    });
  }

  test('断点共用的 List 本身也带 layoutWeight(1)', () => {
    assert.match(bodyFrom(INDEX, '\n  ListRows() {'), /\.layoutWeight\(1\)/,
      'List 继续 layoutWeight(1)：加权区给多少就吃多少，保留滚动');
  });

  test('WideBody 同时渲染计数与列表，且 tab 条件块不能跳过列表', () => {
    assert.ok(WIDE.includes('this.RecordList()'), '列表必须无条件渲染，不许隐藏');
    const cardIfAt = WIDE.indexOf("if (this.tab === 'today')");
    const listAt = WIDE.indexOf('this.RecordList()');
    assert.ok(cardIfAt >= 0 && listAt > cardIfAt, 'WideBody 仍渲染今日汇总块');
    // 从 if 的 '{' 出发做括号配平：它的 '}' 必须出现在 this.RecordList() 之前，
    // 才能证明列表不受 tab 条件约束（否则 pending 有记录时今日 tab 仍可能跳过列表）。
    const ifBrace = WIDE.indexOf('{', cardIfAt);
    let depth = 0;
    let ifClose = -1;
    for (let i = ifBrace; i < WIDE.length; i += 1) {
      if (WIDE[i] === '{') depth += 1;
      else if (WIDE[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          ifClose = i;
          break;
        }
      }
    }
    assert.ok(ifClose > ifBrace && ifClose < listAt,
      '汇总块的 tab 条件必须在列表之前闭合，不能把列表一起包进条件里');
    assert.match(INDEX, /return `当日全部日程 \$\{this\.records\.length\} 条（v2 时间线，自动同步）`;/,
      '页头计数文案仍在（与列表同时可见）');
  });
});

describe('mod-home-entries · 两段空态文案', () => {
  test('两段各有独立标题 + 下一步指引，且都带真按钮', () => {
    assert.match(CHATS, /const EMPTY_CLOUD_TITLE: string = '还没有云端对话';/);
    assert.match(CHATS, /const EMPTY_DOTS_TITLE: string = '还没有 dots 对话';/);
    assert.ok(EMPTY_CLOUD.includes('EMPTY_CLOUD_TITLE') && EMPTY_CLOUD.includes('EMPTY_CLOUD_DETAIL'));
    assert.ok(EMPTY_DOTS.includes('EMPTY_DOTS_TITLE') && EMPTY_DOTS.includes('EMPTY_DOTS_DETAIL'));
    assert.ok(EMPTY_CLOUD.includes('actionLabel: EMPTY_ACTION'), '云端空态有下一步按钮');
    assert.ok(EMPTY_DOTS.includes('actionLabel: EMPTY_ACTION'), 'dots 空态有下一步按钮');
    assert.ok(EMPTY_CLOUD.includes('this.pullAndReload()') && EMPTY_DOTS.includes('this.pullAndReload()'));
  });

  test('文案给出首页入口与可操作指引，不渲染假行', () => {
    assert.match(CHATS, /从首页「纯云端对话」/, '云端空态指向首页入口');
    assert.match(CHATS, /从首页「与 dots 对话」/, 'dots 空态指向首页入口');
    assert.match(CHATS, /所有操作需你确认/, 'dots 空态说明确认纪律');
    assert.match(CHATS, /插件「云端对话 → 导出全部」/, '云端空态保留导出/同步指引');
    for (const builder of [EMPTY_CLOUD, EMPTY_DOTS, EMPTY_CHATS]) {
      assert.equal(builder.includes('ForEach('), false, '空态不得渲染假行');
    }
    assert.ok(EMPTY_CHATS.includes("this.kind === 'dots'"), '按分段派空态');
    assert.ok(EMPTY_CHATS.includes('this.EmptyDotsChats()') && EMPTY_CHATS.includes('this.EmptyCloudChats()'));
  });
});
