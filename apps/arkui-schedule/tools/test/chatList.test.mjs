// 「云端对话」纯逻辑层（`model/chatList.ts`）的单测。
//
// 前置（与其它纯逻辑单测同一口径：先编译 `model/**` + `common/**` 到 `tools/.build/`）：
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
//   node --test apps/arkui-schedule/tools/test/chatList.test.mjs
//
// 契约来源：`docs/CHAT-SYNC.md` §2.4（`index.jsonl` 只追加、同 id 取最后一行）、
// §2.3（`session.jsonl` 明文事件流）、`docs/RESEARCH-session-import.md` §3.2（事件行字段）。
// 断言里的文案逐字对应页面展示（「42 条消息」「未命名会话」），改文案就是改契约。
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  chatSummaryLine,
  filterChats,
  formatChatTime,
  parseChatIndex,
  sortChats,
  toMessages
} from '../.build/model/chatList.js';

// ---------------------------------------------------------------- 测试数据

/** 一行合法的 index 投影（字段顺序无关，这里按文档顺序写）。 */
function indexLine(id, title, updatedAt, messageCount, sha256 = 'a'.repeat(64)) {
  return JSON.stringify({ id, title, updatedAt, messageCount, sha256 });
}

/** 事件行（`{type, seq, time, data}`，与 DSH session v4 同形）。 */
function eventLine(type, data, time = 1794126226642, seq = 1) {
  return JSON.stringify({ type, seq, time, data });
}

// ---------------------------------------------------------------- parseChatIndex

describe('parseChatIndex', () => {
  test('空串：没有条目、没有错误', () => {
    const result = parseChatIndex('');
    assert.equal(result.entries.length, 0);
    assert.equal(result.errors, 0);
  });

  test('空行 / 尾部换行不算坏行', () => {
    const text = [indexLine('s1', 'A', '2026-11-18T14:03:00+08:00', 2), '', '   ', ''].join('\n');
    const result = parseChatIndex(text);
    assert.equal(result.entries.length, 1);
    assert.equal(result.errors, 0);
  });

  test('单行：字段原样读出', () => {
    const result = parseChatIndex(indexLine('s1', '会话一', '2026-11-18T14:03:00+08:00', 42, 'f'.repeat(64)));
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].id, 's1');
    assert.equal(result.entries[0].title, '会话一');
    assert.equal(result.entries[0].updatedAt, '2026-11-18T14:03:00+08:00');
    assert.equal(result.entries[0].messageCount, 42);
    assert.equal(result.entries[0].sha256, 'f'.repeat(64));
  });

  test('只追加：同 id 多行取最后一行（标题 / 条数 / sha 都取最后一行）', () => {
    const text = [
      indexLine('s1', '旧标题', '2026-11-18T10:00:00+08:00', 5, 'a'.repeat(64)),
      indexLine('s1', '新标题', '2026-11-18T14:03:00+08:00', 42, 'b'.repeat(64))
    ].join('\n');
    const result = parseChatIndex(text);
    assert.equal(result.entries.length, 1, '同一个 id 只产出一条');
    assert.equal(result.entries[0].title, '新标题');
    assert.equal(result.entries[0].messageCount, 42);
    assert.equal(result.entries[0].sha256, 'b'.repeat(64));
  });

  test('只追加：取最后一行而不是「updatedAt 最大」，行序即追加序', () => {
    const text = [
      indexLine('s1', '较新时间但先写', '2026-11-18T23:00:00+08:00', 9),
      indexLine('s1', '较旧时间但后写', '2026-11-18T01:00:00+08:00', 3)
    ].join('\n');
    const entries = parseChatIndex(text).entries;
    assert.equal(entries[0].title, '较旧时间但后写');
    assert.equal(entries[0].messageCount, 3);
  });

  test('坏行计数：JSON 解析失败', () => {
    const text = [indexLine('s1', 'A', '2026-11-18T14:03:00+08:00', 1), '{不是 JSON'].join('\n');
    const result = parseChatIndex(text);
    assert.equal(result.errors, 1);
    assert.equal(result.entries.length, 1, '坏行不影响合法行');
  });

  test('坏行计数：合法 JSON 但不是对象（数字 / null）', () => {
    const result = parseChatIndex(['123', 'null', '[]'].join('\n'));
    assert.equal(result.errors, 3);
    assert.equal(result.entries.length, 0);
  });

  test('坏行计数：缺 id 的行算坏行', () => {
    const result = parseChatIndex([JSON.stringify({ title: '没有 id' }), indexLine('s2', 'B', '', 0)].join('\n'));
    assert.equal(result.errors, 1);
    assert.equal(result.entries.length, 1);
  });

  test('标题缺失回落「未命名会话」；messageCount 非法回落 0', () => {
    const result = parseChatIndex(
      [JSON.stringify({ id: 's1', updatedAt: '2026-11-18T14:03:00+08:00' }),
        JSON.stringify({ id: 's2', title: 'B', messageCount: -5 }),
        JSON.stringify({ id: 's3', title: 'C', messageCount: 'x' })].join('\n')
    );
    assert.equal(result.entries.length, 3);
    assert.equal(result.entries[0].title, '未命名会话');
    assert.equal(result.entries[0].messageCount, 0);
    assert.equal(result.entries[1].messageCount, 0);
    assert.equal(result.entries[2].messageCount, 0);
  });

  test('多个 id：保持首次出现顺序（排序交给 sortChats）', () => {
    const text = [
      indexLine('s2', 'B', '2026-11-18T09:00:00+08:00', 1),
      indexLine('s1', 'A', '2026-11-18T10:00:00+08:00', 1),
      indexLine('s2', 'B2', '2026-11-18T11:00:00+08:00', 2)
    ].join('\n');
    const ids = parseChatIndex(text).entries.map((entry) => entry.id);
    assert.deepEqual(ids, ['s2', 's1']);
  });

  test('CRLF 换行同样可解析', () => {
    const text = `${indexLine('s1', 'A', '2026-11-18T14:03:00+08:00', 1)}\r\n${indexLine('s2', 'B', '', 0)}\r\n`;
    const result = parseChatIndex(text);
    assert.equal(result.entries.length, 2);
    assert.equal(result.errors, 0);
  });

  test('坏输入不抛：undefined / null / 纯空白', () => {
    assert.doesNotThrow(() => parseChatIndex(undefined));
    assert.doesNotThrow(() => parseChatIndex(null));
    assert.equal(parseChatIndex(undefined).entries.length, 0);
    assert.equal(parseChatIndex('   \n  \n').entries.length, 0);
  });
});

// ---------------------------------------------------------------- toMessages

describe('toMessages', () => {
  test('user/message：content 是 string', () => {
    const parsed = toMessages(eventLine('user/message', { content: '帮我看下这个报错' }));
    assert.equal(parsed.messages.length, 1);
    assert.equal(parsed.messages[0].role, 'user');
    assert.equal(parsed.messages[0].text, '帮我看下这个报错');
    assert.equal(parsed.skipped, 0);
  });

  test('user/message：content 是 [{type:"text",text}] 数组', () => {
    const parsed = toMessages(
      eventLine('user/message', { content: [{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }] })
    );
    assert.equal(parsed.messages.length, 1);
    assert.equal(parsed.messages[0].text, '第一段\n第二段', '多段 text 用换行拼接');
  });

  test('user/message：数组里的非 text 段（图片）被跳过', () => {
    const parsed = toMessages(
      eventLine('user/message', {
        content: [{ type: 'image', mediaType: 'image/png' }, { type: 'text', text: '只有这段要' }]
      })
    );
    assert.equal(parsed.messages[0].text, '只有这段要');
  });

  test('assistant/message：走 data.message.content（数组形态）', () => {
    const parsed = toMessages(
      eventLine('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: '好的' }] } })
    );
    assert.equal(parsed.messages.length, 1);
    assert.equal(parsed.messages[0].role, 'assistant');
    assert.equal(parsed.messages[0].text, '好的');
  });

  test('assistant/message：没有 message 时回落 data.content（string 形态）', () => {
    const parsed = toMessages(eventLine('assistant/message', { content: '直接给正文' }));
    assert.equal(parsed.messages[0].role, 'assistant');
    assert.equal(parsed.messages[0].text, '直接给正文');
  });

  test('tool/call：压成一行「🔧 <name>」，带 toolName、不带参数', () => {
    const parsed = toMessages(
      eventLine('tool/call', { callId: 'call_1', name: 'pwsh', arguments: '{"command":"rm -rf /tmp/x"}' })
    );
    assert.equal(parsed.messages.length, 1);
    assert.equal(parsed.messages[0].role, 'tool');
    assert.equal(parsed.messages[0].text, '🔧 pwsh');
    assert.equal(parsed.messages[0].toolName, 'pwsh');
    assert.ok(!parsed.messages[0].text.includes('rm -rf'), '参数不得出现在摘要里');
  });

  test('tool/call：缺 name 回落「未知工具」', () => {
    const parsed = toMessages(eventLine('tool/call', { callId: 'call_2' }));
    assert.equal(parsed.messages[0].text, '🔧 未知工具');
    assert.equal(parsed.messages[0].toolName, '未知工具');
  });

  test('user / assistant / tool 的先后顺序 = 行序（不重排）', () => {
    const text = [
      eventLine('user/message', { content: '问' }, 1000, 1),
      eventLine('tool/call', { name: 'read' }, 2000, 2),
      eventLine('assistant/message', { content: '答' }, 3000, 3)
    ].join('\n');
    const roles = toMessages(text).messages.map((message) => message.role);
    assert.deepEqual(roles, ['user', 'tool', 'assistant']);
  });

  test('usage 事件被跳过并计入 skipped', () => {
    const parsed = toMessages(eventLine('usage', { inputTokens: 10, outputTokens: 20 }));
    assert.equal(parsed.messages.length, 0);
    assert.equal(parsed.skipped, 1);
  });

  test('tool/result 不渲染（只有调用留一行）', () => {
    const parsed = toMessages(eventLine('tool/result', { message: { role: 'tool', content: '一大段输出' } }));
    assert.equal(parsed.messages.length, 0);
    assert.equal(parsed.skipped, 1);
  });

  test('坏行计数：非法 JSON 只 skipped++', () => {
    const text = [eventLine('user/message', { content: '正常' }), 'not json at all'].join('\n');
    const parsed = toMessages(text);
    assert.equal(parsed.messages.length, 1);
    assert.equal(parsed.skipped, 1);
  });

  test('空行不计入 skipped', () => {
    const text = ['', eventLine('user/message', { content: '有内容' }), '', '  '].join('\n');
    const parsed = toMessages(text);
    assert.equal(parsed.messages.length, 1);
    assert.equal(parsed.skipped, 0);
  });

  test('内容为空的消息记为 skipped（不产出空行气泡）', () => {
    const parsed = toMessages(eventLine('user/message', { content: '   ' }));
    assert.equal(parsed.messages.length, 0);
    assert.equal(parsed.skipped, 1);
  });

  test('system/message → role system', () => {
    const parsed = toMessages(eventLine('system/message', { content: '系统提醒' }));
    assert.equal(parsed.messages[0].role, 'system');
    assert.equal(parsed.messages[0].text, '系统提醒');
  });

  test('developer/message 等其它 *​/message → role other（不丢内容、不假装助手）', () => {
    const parsed = toMessages(eventLine('developer/message', { content: '开发说明' }));
    assert.equal(parsed.messages[0].role, 'other');
    assert.equal(parsed.messages[0].text, '开发说明');
  });

  test('header 行（type:"session"）与 turn/start 被跳过', () => {
    const text = [
      JSON.stringify({ type: 'session', version: 4, id: 'session-1', createdAt: 1794126226642 }),
      eventLine('turn/start', { turn: 1 })
    ].join('\n');
    const parsed = toMessages(text);
    assert.equal(parsed.messages.length, 0);
    assert.equal(parsed.skipped, 2);
  });

  test('time（Unix 毫秒）→ at 是 ISO 8601', () => {
    const parsed = toMessages(eventLine('user/message', { content: 'x' }, Date.UTC(2026, 10, 18, 6, 3, 0)));
    assert.equal(parsed.messages[0].at, '2026-11-18T06:03:00.000Z');
  });

  test('缺 time → at 为空串（不是 undefined）', () => {
    const parsed = toMessages(JSON.stringify({ type: 'user/message', data: { content: 'x' } }));
    assert.equal(parsed.messages[0].at, '');
  });

  test('坏输入不抛：空串 / undefined / 顶层不是对象', () => {
    assert.doesNotThrow(() => toMessages(''));
    assert.doesNotThrow(() => toMessages(undefined));
    assert.equal(toMessages('').messages.length, 0);
    assert.equal(toMessages('42\n"str"').messages.length, 0);
    assert.equal(toMessages('42\n"str"').skipped, 2);
  });
});

// ---------------------------------------------------------------- sortChats

/** 三条用于排序的投影。 */
const SORT_INPUT = [
  { id: 'a', title: 'banana', updatedAt: '2026-11-18T10:00:00+08:00', messageCount: 1, sha256: '' },
  { id: 'b', title: 'Apple', updatedAt: '2026-11-18T12:00:00+08:00', messageCount: 2, sha256: '' },
  { id: 'c', title: 'cherry', updatedAt: '2026-11-18T11:00:00+08:00', messageCount: 3, sha256: '' }
];

describe('sortChats', () => {
  test('updated 模式：新的在前', () => {
    const ids = sortChats(SORT_INPUT, 'updated').map((entry) => entry.id);
    assert.deepEqual(ids, ['b', 'c', 'a']);
  });

  test('title 模式：小写字典序（大小写不敏感）', () => {
    const ids = sortChats(SORT_INPUT, 'title').map((entry) => entry.id);
    assert.deepEqual(ids, ['b', 'a', 'c'], 'Apple → banana → cherry');
  });

  test('updated 相同：保持输入顺序（稳定）', () => {
    const same = [
      { id: 'first', title: 'x', updatedAt: '2026-11-18T10:00:00+08:00', messageCount: 0, sha256: '' },
      { id: 'second', title: 'y', updatedAt: '2026-11-18T10:00:00+08:00', messageCount: 0, sha256: '' },
      { id: 'third', title: 'z', updatedAt: '2026-11-18T10:00:00+08:00', messageCount: 0, sha256: '' }
    ];
    assert.deepEqual(
      sortChats(same, 'updated').map((entry) => entry.id),
      ['first', 'second', 'third']
    );
  });

  test('标题相同：保持输入顺序（稳定）', () => {
    const same = [
      { id: 's1', title: '同名', updatedAt: '2026-11-18T10:00:00+08:00', messageCount: 0, sha256: '' },
      { id: 's2', title: '同名', updatedAt: '2026-11-18T09:00:00+08:00', messageCount: 0, sha256: '' }
    ];
    assert.deepEqual(
      sortChats(same, 'title').map((entry) => entry.id),
      ['s1', 's2']
    );
  });

  test('时间解析不到的排最后（不因为一条坏数据打乱顺序）', () => {
    const mixed = [
      { id: 'bad', title: 'x', updatedAt: '不是时间', messageCount: 0, sha256: '' },
      { id: 'old', title: 'y', updatedAt: '2026-11-01T10:00:00+08:00', messageCount: 0, sha256: '' },
      { id: 'new', title: 'z', updatedAt: '2026-11-18T10:00:00+08:00', messageCount: 0, sha256: '' }
    ];
    assert.deepEqual(
      sortChats(mixed, 'updated').map((entry) => entry.id),
      ['new', 'old', 'bad']
    );
  });

  test('不改入参（返回新数组）', () => {
    const before = SORT_INPUT.map((entry) => entry.id);
    sortChats(SORT_INPUT, 'title');
    assert.deepEqual(SORT_INPUT.map((entry) => entry.id), before);
  });

  test('空数组 / 坏输入不抛', () => {
    assert.deepEqual(sortChats([], 'updated'), []);
    assert.doesNotThrow(() => sortChats(undefined, 'updated'));
    assert.equal(sortChats(undefined, 'title').length, 0);
  });
});

// ---------------------------------------------------------------- filterChats

describe('filterChats', () => {
  test('大小写不敏感的子串匹配', () => {
    const ids = filterChats(SORT_INPUT, 'an').map((entry) => entry.id);
    assert.deepEqual(ids, ['a'], '只命中 banana 里的 an（Apple 不含）');
    assert.deepEqual(filterChats(SORT_INPUT, 'APP').map((entry) => entry.id), ['b']);
  });

  test('空查询返回全部', () => {
    assert.equal(filterChats(SORT_INPUT, '').length, 3);
  });

  test('纯空白查询等同于空查询', () => {
    assert.equal(filterChats(SORT_INPUT, '   ').length, 3);
  });

  test('查询首尾空白被裁掉', () => {
    assert.equal(filterChats(SORT_INPUT, '  cherry  ').length, 1);
  });

  test('无命中返回空数组', () => {
    assert.deepEqual(filterChats(SORT_INPUT, '不存在'), []);
  });

  test('只匹配标题，不匹配 id', () => {
    assert.deepEqual(filterChats(SORT_INPUT, 'zzz'), []);
    assert.equal(filterChats(SORT_INPUT, 'Apple').length, 1);
  });

  test('返回副本：改结果不影响入参', () => {
    const copy = filterChats(SORT_INPUT, '');
    copy.pop();
    assert.equal(SORT_INPUT.length, 3);
  });

  test('坏输入不抛', () => {
    assert.doesNotThrow(() => filterChats(undefined, 'x'));
    assert.equal(filterChats(undefined, 'x').length, 0);
    assert.equal(filterChats(SORT_INPUT, undefined).length, 3);
  });
});

// ---------------------------------------------------------------- 文案

/** 本机时区的 `YYYY-MM-DD HH:MM`（测试里用来独立算出「带时区标记」的期望值）。 */
function localText(date) {
  const pad = (value) => (value < 10 ? `0${value}` : `${value}`);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

describe('chatSummaryLine / formatChatTime', () => {
  test('摘要格式：`YYYY-MM-DD HH:MM · N 条消息`', () => {
    const line = chatSummaryLine({
      id: 's1',
      title: 'A',
      // 不带时区标记 = 记录者墙钟，原样展示（断言因此与运行机器的时区无关）
      updatedAt: '2026-11-18T14:03',
      messageCount: 42,
      sha256: ''
    });
    assert.equal(line, '2026-11-18 14:03 · 42 条消息');
  });

  test('不带时区标记：原样展示墙钟（与日程 ts 的 formatClock 口径一致）', () => {
    assert.equal(formatChatTime('2026-11-18T14:03'), '2026-11-18 14:03');
    assert.equal(formatChatTime('2026-11-18 14:03:59'), '2026-11-18 14:03');
  });

  test('带时区标记（Z / +08:00）：换算到本机时区（插件写的是真实时刻）', () => {
    const zulu = '2026-11-18T06:03:00Z';
    assert.equal(formatChatTime(zulu), localText(new Date(Date.parse(zulu))));
    assert.match(formatChatTime(zulu), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    const offset = '2026-11-18T14:03:00+08:00';
    assert.equal(formatChatTime(offset), localText(new Date(Date.parse(offset))));
  });

  test('时间缺失：`时间未知 · 0 条消息`', () => {
    assert.equal(
      chatSummaryLine({ id: 's1', title: 'A', updatedAt: '', messageCount: 0, sha256: '' }),
      '时间未知 · 0 条消息'
    );
  });

  test('时间非法也不抛，回落「时间未知」', () => {
    assert.equal(formatChatTime('不是时间'), '');
    assert.equal(formatChatTime(''), '');
    assert.doesNotThrow(() => chatSummaryLine({ id: 's', title: '', updatedAt: 'x', messageCount: 1, sha256: '' }));
  });

  test('条数为 1 时也写「1 条消息」（不搞单复数）', () => {
    const line = chatSummaryLine({
      id: 's1',
      title: 'A',
      updatedAt: '2026-11-18T00:00',
      messageCount: 1,
      sha256: ''
    });
    assert.equal(line, '2026-11-18 00:00 · 1 条消息');
  });
});
