// mod-chat-hide：平板读侧折叠 + 确认文案 + 隐藏行追加的纯逻辑单测。
// 前置（与其它纯逻辑单测同口径）：
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
//   node --test apps/arkui-schedule/tools/test/chatHide.test.mjs
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { filterChatPreset, foldChatIndex, parseChatIndex, sessionPresetOf } from '../.build/model/chatList.js';
import {
  HIDE_BODY_KEEP, HIDE_BODY_NO_RESTORE, HIDE_CANCEL, HIDE_COMMIT_SUBJECT_PREFIX,
  HIDE_COMMIT_TRAILER, HIDE_CONFIRM, HIDE_FAIL_COMMIT, HIDE_FAIL_PREPARE, HIDE_FAIL_PUSH,
  HIDE_FAIL_WRITE, HIDE_INDEX_PATH, HIDE_TITLE, appendHideLine, chatHidePlanOf,
  hideCommitMessageOf, hideLineOf, hideReasonOf, isHideId
} from '../.build/model/chatHide.js';

const normal = (id, extra = {}) => JSON.stringify({
  id, title: `标题-${id}`, updatedAt: '2026-11-27T10:00:00.000Z', messageCount: 2, sha256: 'a'.repeat(64), ...extra
});
const archive = (id, deletedAt) => JSON.stringify({ op: 'archive', id, deletedAt });
const unarchive = (id, ts) => JSON.stringify({ op: 'unarchive', id, ts });
const fold = (...lines) => foldChatIndex(lines.join('\n'));

describe('chatList.foldChatIndex（折叠全函数）', () => {
  test('AH-01 普通行 last-wins；同 id 多行只出一条', () => {
    const result = fold(normal('s1', { title: '旧' }), normal('s1', { title: '新' }));
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].title, '新');
    assert.deepEqual(result.hiddenIds, []);
  });

  test('AH-02 隐藏后老客户端追加普通行仍隐藏（A6）', () => {
    const result = fold(normal('s1'), archive('s1', 1000), normal('s1', { title: '重导出' }));
    assert.deepEqual(result.entries.map((e) => e.id), []);
    assert.deepEqual(result.hiddenIds, ['s1']);
  });

  test('AH-03 乱序 + 重复隐藏：按 (ts,seq) 严格决胜', () => {
    const result = fold(archive('s1', 900), archive('s1', 1000), archive('s1', 1000), archive('s1', 800));
    assert.deepEqual(result.hiddenIds, ['s1']);
    assert.equal(result.errors, 0);
  });

  test('AH-04 同毫秒：后一行胜出（两种行序）', () => {
    const hideWins = fold(normal('s1'), unarchive('s1', 1000), archive('s1', 1000));
    assert.deepEqual(hideWins.hiddenIds, ['s1']);
    const showWins = fold(normal('s1'), archive('s1', 1000), unarchive('s1', 1000));
    assert.deepEqual(showWins.entries.map((e) => e.id), ['s1']);
  });

  test('AH-05 unarchive 行先于 hide 出现，仍由时间戳/行号决胜', () => {
    assert.deepEqual(fold(normal('s1'), unarchive('s1', 100), archive('s1', 200)).hiddenIds, ['s1']);
    assert.deepEqual(fold(unarchive('s1', 200), archive('s1', 200)).hiddenIds, ['s1']);
  });

  test('AH-06 读取侧认识 unarchive（A8，本模块不产生）', () => {
    const result = fold(normal('s1'), archive('s1', 1000), unarchive('s1', 2000));
    assert.deepEqual(result.entries.map((e) => e.id), ['s1']);
    assert.deepEqual(result.hiddenIds, []);
    assert.equal(parseChatIndex([normal('s2'), archive('s2', 1000), unarchive('s2', 2000)].join('\n')).entries.length, 1);
  });

  test('AH-07 坏行只计数不抛；总函数吞掉任意输入', () => {
    const result = fold(
      '{坏 JSON', '123', 'null', JSON.stringify({ title: '没有 id' }),
      JSON.stringify({ op: 'unknown', id: 's1', ts: 1 }),
      JSON.stringify({ op: 'archive', id: 's1', deletedAt: 'x' }),
      JSON.stringify({ op: 'archive', id: '../s1', deletedAt: 1000 }),
      normal('s1'), archive('s1', 1000)
    );
    assert.equal(result.errors, 7);
    assert.deepEqual(result.entries, []);
    assert.deepEqual(result.hiddenIds, ['s1']);
    assert.doesNotThrow(() => foldChatIndex(undefined));
    assert.equal(foldChatIndex(null).entries.length, 0);
  });

  test('AH-08 只有隐藏行也进 hiddenIds；列表解析只暴露可见条目', () => {
    const text = [archive('ghost', 1234), normal('s1'), archive('s1', 2000)].join('\n');
    assert.deepEqual(foldChatIndex(text).hiddenIds.sort(), ['ghost', 's1']);
    assert.deepEqual(parseChatIndex(text).entries, []);
  });
});

describe('chatHide 纯逻辑（确认文案 + 隐藏行）', () => {
  test('AH-09 确认 sheet 文案逐字锁定，禁用词绝不出现', () => {
    const plan = chatHidePlanOf();
    assert.equal(plan.title, HIDE_TITLE);
    assert.equal(plan.title, '删除这条会话？');
    assert.deepEqual(plan.lines, [
      '删除后不再显示在会话列表；云端记录不会被抹除。',
      '目前没有恢复入口，删除后应用内无法找回。'
    ]);
    assert.equal(HIDE_BODY_KEEP, plan.lines[0]);
    assert.equal(HIDE_BODY_NO_RESTORE, plan.lines[1]);
    assert.equal(plan.confirmLabel, HIDE_CONFIRM);
    assert.equal(plan.cancelLabel, HIDE_CANCEL);
    assert.equal(plan.confirmLabel, '删除');
    assert.equal(plan.cancelLabel, '取消');
    const all = [plan.title, ...plan.lines, plan.confirmLabel, plan.cancelLabel].join(' ');
    for (const banned of ['可恢复', '已在已删除中找到', '撤销', '彻底', '永久']) {
      assert.equal(all.includes(banned), false, banned);
    }
  });

  test('AH-10 隐藏行形状固定；坏 id / 坏时间返回空串', () => {
    const line = hideLineOf('s1', 1795000000000);
    assert.deepEqual(JSON.parse(line), { op: 'archive', id: 's1', deletedAt: 1795000000000 });
    assert.equal(hideLineOf('../s1', 1000), '');
    assert.equal(hideLineOf('s1', -1), '');
    assert.equal(hideLineOf('s1', 1.5), '');
    assert.equal(hideLineOf('s1', '1000'), '');
  });

  test('AH-11 只追加：旧字节是严格前缀；缺换行先补；空行不写', () => {
    const line = hideLineOf('s1', 1000);
    const old = '{"id":"s1","title":"A"}\n';
    const next = appendHideLine(old, line);
    assert.equal(next.startsWith(old), true);
    assert.equal(next, `${old}${line}\n`);
    const noNewline = appendHideLine('{"id":"s1"}', line);
    assert.equal(noNewline, `{"id":"s1"}\n${line}\n`);
    assert.equal(appendHideLine(old, ''), old);
  });

  test('AH-12 typed 中文失败原因只说阶段，不泄漏原始错误文本', () => {
    assert.match(hideReasonOf('prepare'), /没有写入任何内容/);
    assert.match(hideReasonOf('write'), /写入失败/);
    assert.match(hideReasonOf('commit'), /提交未完成/);
    assert.match(hideReasonOf('push'), /推送未完成/);
  });
});

describe('mod-app-chat-hide：窄写通道（字节级 / 四阶段 / 入口形状）', () => {
  test('AH-13 只追加一行：旧内容是新内容的严格前缀，其余字节逐字不变', () => {
    const line = hideLineOf('sess-1', 1795000000000);
    const oldText = `${normal('sess-1')}\n${normal('sess-2')}\n`;
    const next = appendHideLine(oldText, line);
    assert.equal(next.startsWith(oldText), true, '旧字节必须是新字节的严格前缀');
    assert.equal(next.slice(oldText.length), `${line}\n`, '只允许多出这一行');
    assert.deepEqual(JSON.parse(next.split('\n')[2]), {
      op: 'archive', id: 'sess-1', deletedAt: 1795000000000
    });
    const noNewline = normal('s1');
    const next2 = appendHideLine(noNewline, line);
    assert.equal(next2.startsWith(noNewline), true);
    assert.equal(next2.slice(noNewline.length), `\n${line}\n`);
    assert.equal(HIDE_INDEX_PATH, 'chats/index.jsonl');
  });

  test('AH-14 四阶段原因逐字互异；失败处理绝不追加第二行', () => {
    const stages = ['prepare', 'write', 'commit', 'push'];
    const reasons = stages.map((stage) => hideReasonOf(stage));
    assert.equal(new Set(reasons).size, 4, '四个阶段必须是四条不同的 typed 文案');
    assert.deepEqual(reasons, [HIDE_FAIL_PREPARE, HIDE_FAIL_WRITE, HIDE_FAIL_COMMIT, HIDE_FAIL_PUSH]);
    for (const reason of reasons) {
      assert.equal(reason.startsWith('删除失败：'), true);
      assert.equal(/E_[A-Z]+|git-repo|index\.jsonl/.test(reason), false, '不得泄漏原始错误 / 路径');
    }
    const oldText = `${normal('s1')}\n`;
    const line = hideLineOf('s1', 1000);
    const appended = appendHideLine(oldText, line);
    for (const stage of stages) {
      // 服务在 prepare/write 失败即停：索引字节原样；commit/push 失败时那一行已在盘上，
      // 但失败处理本身绝不再写第二行（成功 / 失败都只有这一条墓碑）。
      const text = stage === 'prepare' || stage === 'write' ? oldText : appended;
      assert.equal(text.startsWith(oldText), true);
      assert.equal(text.split('\n').filter((row) => row.length > 0).length,
        stage === 'prepare' || stage === 'write' ? 1 : 2);
      assert.equal(appendHideLine(text, ''), text, '失败处理不追加空行 / 重复行');
    }
  });

  test('AH-15 追加后折叠只隐藏该 id，另一条仍可见（无乐观覆盖）', () => {
    const oldText = [normal('s1'), normal('s2')].join('\n');
    const next = appendHideLine(oldText, hideLineOf('s2', 2000));
    const folded = foldChatIndex(next);
    assert.deepEqual(folded.entries.map((entry) => entry.id), ['s1']);
    assert.deepEqual(folded.hiddenIds, ['s2']);
    assert.equal(parseChatIndex(next).entries.length, 1);
    // 没写进去时，读侧不隐藏任何 id（失败不留假隐藏）
    assert.deepEqual(foldChatIndex(oldText).hiddenIds, []);
  });

  test('AH-16 隐藏提交 subject 精确形状 + v2 尾注；非法 id 不产出提交信息', () => {
    const message = hideCommitMessageOf('sess-1');
    const subject = message.split('\n')[0];
    assert.match(subject, /^chats: delete ([A-Za-z0-9._-]{1,200})$/);
    assert.equal(HIDE_COMMIT_SUBJECT_PREFIX, 'chats: delete ');
    assert.equal(message.includes(HIDE_COMMIT_TRAILER), true);
    assert.equal(message.includes('unarchive'), false, '本模块不产生恢复语义');
    // mod-app-chat-hide 只追加墓碑行：会话发布尾注（旧/新两种拼写）一律不得出现在隐藏提交里。
    assert.equal(message.includes('dsh-dots-chat-export:'), false, '隐藏提交不得带会话发布尾注（旧拼写）');
    assert.equal(message.includes('dsh-dots-chat-sync:'), false, '隐藏提交不得带会话发布尾注（新拼写）');
    assert.equal(hideCommitMessageOf('../s1'), '');
    assert.equal(isHideId('s1'), true);
    assert.equal(isHideId('..'), false);
  });
});

describe('mod-app-chat-hide：会话 preset 准入（只有 agentPreset === chat）', () => {
  const header = (preset) => JSON.stringify({ type: 'session', id: 'x', agentPreset: preset });
  const selected = (preset) => JSON.stringify({ type: 'agent-preset/selected', data: { agentPreset: preset } });

  test('CW-01 preset 只读 session.jsonl 的 agentPreset：allow-list、fail-closed', () => {
    assert.equal(sessionPresetOf(`${header('chat')}\n${normal('x')}`), 'chat');
    for (const bad of [header('standard'), header('ptc'), header('CHAT'), header(' chat'),
      JSON.stringify({ type: 'session', id: 'x' }),
      JSON.stringify({ type: 'session', id: 'x', agentPreset: null }),
      normal('x'), '', '{坏行']) {
      assert.equal(sessionPresetOf(bad), 'other', `不得把非 chat 当 chat：${bad}`);
    }
    assert.equal(sessionPresetOf(undefined), 'other');
  });

  test('CW-02 preset 投影按事件顺序覆盖 header，非法事件不放松', () => {
    assert.equal(sessionPresetOf([header('standard'), selected('chat')].join('\n')), 'chat');
    assert.equal(sessionPresetOf([header('chat'), selected('standard')].join('\n')), 'other');
    assert.equal(sessionPresetOf([header('chat'), selected('unknown')].join('\n')), 'other');
    assert.equal(sessionPresetOf([header('chat'), JSON.stringify({ type: 'agent-preset/selected' })].join('\n')), 'other');
  });

  test('CW-03 索引里的工作会话不渲染，因此没有行可隐藏', () => {
    const work = normal('work-1');
    const chatEntry = normal('chat-1');
    const entries = parseChatIndex([work, chatEntry].join('\n')).entries;
    const presets = { 'work-1': 'other', 'chat-1': 'chat' };
    const visible = filterChatPreset(entries, presets);
    assert.deepEqual(visible.map((entry) => entry.id), ['chat-1']);
    assert.equal(visible.some((entry) => entry.id === 'work-1'), false);
    assert.deepEqual(filterChatPreset(entries, {}), [], '读不到 preset 时一条都不渲染');
    // 即便索引里误有工作会话的隐藏行，它依然不进可见列表（没有按钮 ⇒ 无隐藏目标）
    const withHide = parseChatIndex([work, chatEntry, archive('work-1', 1000)].join('\n')).entries;
    assert.deepEqual(filterChatPreset(withHide, presets).map((entry) => entry.id), ['chat-1']);
  });

  test('CW-04 工作 kind 的 id 在索引里既不渲染、也无法成为隐藏目标', () => {
    // preset 来自两条真实 session.jsonl 原文，不是手写的 presets map
    const workText = [header('standard'), normal('work-1')].join('\n');
    const chatText = [header('chat'), normal('chat-1')].join('\n');
    const presets = { 'work-1': sessionPresetOf(workText), 'chat-1': sessionPresetOf(chatText) };
    assert.deepEqual(presets, { 'work-1': 'other', 'chat-1': 'chat' });
    const index = [normal('work-1'), normal('chat-1')].join('\n');
    // 先证明工作会话确实在索引里：没有 filterChatPreset 的读侧会把 work-1 渲染出来（本例随之变红）
    assert.equal(parseChatIndex(index).entries.some((entry) => entry.id === 'work-1'), true);
    const visible = filterChatPreset(parseChatIndex(index).entries, presets);
    assert.deepEqual(visible.map((entry) => entry.id), ['chat-1']);
    assert.equal(visible.some((entry) => entry.id === 'work-1'), false, '工作会话没有行 ⇒ 没有按钮可点');
    // id 本身合法，但写口用同一 preset 判据拒绝（prepare，零字节写入）
    assert.equal(isHideId('work-1'), true);
    assert.equal(presets['work-1'] === 'chat', false);
    assert.match(hideReasonOf('prepare'), /没有写入任何内容/);
  });
});
