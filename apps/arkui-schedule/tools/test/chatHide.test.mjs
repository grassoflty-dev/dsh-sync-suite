// mod-chat-hide：平板读侧折叠 + 确认文案 + 隐藏行追加的纯逻辑单测。
// 前置（与其它纯逻辑单测同口径）：
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
//   node --test apps/arkui-schedule/tools/test/chatHide.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { filterChatPreset, foldChatIndex, parseChatIndex, sessionPresetOf } from '../.build/model/chatList.js';
// mod-app-hide-commit-reconcile：三态决策从纯模型导入（用命名空间，pre-fix 时只让 HCR 用例红，
// 不把本文件其它既有断言一起拖下水）。
import * as chatHideModel from '../.build/model/chatHide.js';
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

// mod-app-hide-commit-reconcile：假失败回归。隐藏行在写盘之后可能被同步周期顺手提交 / 推送；
// hideChat 必须在闸内区分「已推送 / 本地已提交未推 / 真没提交」，而不是把「没东西可提交」一律报成
// commit 失败。三态决策是 chatHide.ts 的纯函数（真实实现），测试断言的是用户可见的 HideOutcome。
describe('mod-app-hide-commit-reconcile：闸内对账三态（用户可见结果）', () => {
  const LINE = hideLineOf('sess-1', 1795000000000);
  const withLine = `${normal('sess-1')}\n${LINE}\n`;
  const withoutLine = `${normal('sess-1')}\n`;

  /** 与 chatStore.hideChat 闸内同构的假 runner：只读 showHead/headRelation + 三个写口；push 单独计数。 */
  function fakeRunner(headText, relation, failPush, failCommit) {
    const calls = [];
    let pushCount = 0;
    return {
      calls,
      get pushCount() { return pushCount; },
      async showHead() { calls.push('showHead'); return headText; },
      async headRelation() { calls.push('headRelation'); return relation; },
      async addPaths(paths) { calls.push(`add:${paths[0]}`); },
      async commit() {
        calls.push('commit');
        if (failCommit) throw new Error('fake commit failure');
      },
      async pushMain() {
        pushCount += 1;
        calls.push('push');
        if (failPush) throw new Error('fake push failure');
      }
    };
  }

  /**
   * 闸门内的完整前置：只读 HEAD → 用与决策共用的 hasHideLine 做廉价 gate → 仅在命中时读关系。
   * 与 chatStore.hideChat 闸内接线一致（由 HCR-04 源码守卫钉住，复制体不能漂移）。
   */
  async function decide(port, line) {
    const head = await port.showHead();
    let relation = 'diverged';
    if (chatHideModel.hasHideLine(head, line)) {
      relation = await port.headRelation();
    }
    return chatHideModel.decideHideReconcile(head, line, relation);
  }

  /**
   * 复刻 hideChat 闸内的阶段机（由 HCR-04 源码守卫钉住，复制体不能漂移）：
   * done → 直接成功；push → 只推送；commit → add→commit→push。
   */
  async function visibleOutcome(decision, port) {
    if (decision === 'done') return { ok: true, stage: 'done', reason: '' };
    if (decision === 'push') {
      try {
        await port.pushMain();
        return { ok: true, stage: 'done', reason: '' };
      } catch (error) {
        return { ok: false, stage: 'push', reason: hideReasonOf('push') };
      }
    }
    try {
      await port.addPaths([HIDE_INDEX_PATH]);
      await port.commit('chats: delete sess-1');
    } catch (error) {
      return { ok: false, stage: 'commit', reason: hideReasonOf('commit') };
    }
    try {
      await port.pushMain();
      return { ok: true, stage: 'done', reason: '' };
    } catch (error) {
      return { ok: false, stage: 'push', reason: hideReasonOf('push') };
    }
  }

  test('HCR-01 (a) 周期已提交并推送 → ok:true、无失败原因、不重复推送', async () => {
    // 连 push/commit 的失败开关都打开也不该触发：这条分支一个写口都不碰。
    const port = fakeRunner(withLine, 'equal', true, true);
    const decision = await decide(port, LINE);
    assert.equal(decision, 'done', '隐藏行在 HEAD 且 HEAD == origin/main ⇒ 已被周期推送');
    const outcome = await visibleOutcome(decision, port);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.stage, 'done');
    assert.equal(outcome.reason.length, 0, '成功路径不得带任何用户可见失败原因');
    assert.equal(/删除失败/.test(outcome.reason), false);
    assert.deepEqual(port.calls, ['showHead', 'headRelation'], '已推送分支不得 add/commit/push');
    assert.equal(port.pushCount, 0, 'equal 分支连 push 口都不碰（push 计数器为 0）');
  });

  test('HCR-02 (b) ahead/diverged 本地已提交未推 → 推送成功；推送失败仍是 push 原因', async () => {
    // behind 已从这条断言中移出并单独归入 done（HCR-02b）：它已在远端历史里，push 不可能成功。
    for (const relation of ['ahead', 'diverged']) {
      const probe = fakeRunner(withLine, relation, false, false);
      assert.equal(await decide(probe, LINE), 'push', `关系 ${relation} 是本地已提交、远端还没有`);
    }
    const okPort = fakeRunner(withLine, 'ahead', false, false);
    const okOutcome = await visibleOutcome(await decide(okPort, LINE), okPort);
    assert.deepEqual(okOutcome, { ok: true, stage: 'done', reason: '' });
    assert.equal(okPort.calls.includes('push'), true, '必须真的尝试推送');
    assert.equal(okPort.calls.includes('commit'), false, '提交已由周期完成，不再重复提交');

    const badPort = fakeRunner(withLine, 'ahead', true, false);
    const badOutcome = await visibleOutcome(await decide(badPort, LINE), badPort);
    assert.equal(badOutcome.ok, false);
    assert.equal(badOutcome.stage, 'push');
    assert.equal(badOutcome.reason, HIDE_FAIL_PUSH, '推送失败必须是既有 push 原因，不是 commit 原因');
  });

  test('HCR-02b behind（HEAD 是 origin/main 祖先）→ 已发布 done：ok:true 且调用序列无 push', async () => {
    // 这一行已经在远端历史里，push 只会 non-fast-forward；把两个失败开关都打开也不会被触发。
    const port = fakeRunner(withLine, 'behind', true, true);
    const decision = await decide(port, LINE);
    assert.equal(decision, 'done', 'HEAD 是 origin/main 的祖先 ⇒ 隐藏行已发布，修正后的真相是 done');
    const outcome = await visibleOutcome(decision, port);
    assert.deepEqual(outcome, { ok: true, stage: 'done', reason: '' });
    assert.equal(outcome.ok, true, '已发布的删除不能再报一次假失败');
    assert.equal(port.pushCount, 0, 'behind 绝不尝试 push（push 计数器必须为 0）');
    assert.equal(port.calls.includes('push'), false, '调用序列中不得出现 push');
    assert.deepEqual(port.calls, ['showHead', 'headRelation'], '完整序列只有两个只读口，无 add/commit/push');
  });

  test('HCR-03 (c) 真没提交 → 仍是 commit 原因；HEAD 缺文件 / 空串按未提交处理', async () => {
    for (const head of [withoutLine, '', '{"op":"archive","id":"other","deletedAt":1}\n']) {
      const probe = fakeRunner(head, 'ahead', false, false);
      assert.equal(await decide(probe, LINE), 'commit', `HEAD 文本未含本行 ⇒ 未提交：${JSON.stringify(head)}`);
    }
    const probe = fakeRunner(withoutLine, 'ahead', false, false);
    const decision = await decide(probe, LINE);
    const port = fakeRunner(withoutLine, 'ahead', false, true);
    const outcome = await visibleOutcome(decision, port);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.stage, 'commit');
    assert.equal(outcome.reason, HIDE_FAIL_COMMIT, '提交真的失败时保持既有 commit 原因');
    assert.deepEqual(port.calls, [`add:${HIDE_INDEX_PATH}`, 'commit'], 'commit 失败即停，不推进 push');
  });

  test('HCR-04 服务闸内接线守卫：showHead 窄捕获 + 三态分支 + 原两阶段原因不变', () => {
    const chatStore = readFileSync(
      new URL('../../entry/src/main/ets/services/chatStore.ets', import.meta.url), 'utf8');
    const body = chatStore.slice(chatStore.indexOf('async hideChat('));
    assert.match(body, /bridgeGitRunner\.withWriteLock\(/, '对账必须在同一把闸内');
    assert.match(body, /showHead\(HIDE_INDEX_PATH\)/, '必须读 HEAD 的索引原文');
    assert.match(body, /decideHideReconcile\(headText, line, relation\)/, '三态由纯函数判定');
    // showHead 缺文件 / 读失败按「未提交」处理，绝不让异常冒到外层 catch 变成 prepare 假失败。
    assert.match(body, /showHead\(HIDE_INDEX_PATH\)[\s\S]{0,200}catch[\s\S]{0,120}headText = ''/,
      'showHead 必须窄捕获并把缺文件映射为未提交');
    assert.match(body, /this\.hideFailure\('commit'\)/);
    assert.match(body, /this\.hideFailure\('push'\)/);
    // P2-2：闸内 gate 与三态决策必须共用 hasHideLine 这一个整行判据。
    // 不允许再出现 headText.includes(line) 的子串判据（无关超串会白白发一次关系读）。
    assert.doesNotMatch(body, /headText\.includes\(line\)/, '不得再用子串包含做 gate');
    assert.match(body, /hasHideLine\(headText, line\)/, 'gate 必须调用与决策共用的整行判据');
    assert.match(chatStore, /import\s*\{[\s\S]{0,300}\bhasHideLine\b[\s\S]{0,300}\}\s*from\s*'\.\.\/model\/chatHide'/,
      'hasHideLine 必须从 model/chatHide 导入，不能在此处另写一份判据');
  });

  test('HCR-05 P2-2 超串不算命中：整行判据共用，未命中就不读关系', async () => {
    // 前置：这一行只是「被包含」在某条更长行里，trim 后并不等于隐藏行。
    const superLine = `{"note":${LINE},"extra":true}`;
    const superHead = `${normal('sess-1')}\n${superLine}\n`;
    assert.equal(superHead.includes(LINE), true, '前置条件：HEAD 文本确实包含隐藏行子串');
    assert.equal(chatHideModel.hasHideLine(superHead, LINE), false, '整行判据不得把超串当命中');
    assert.equal(chatHideModel.hasHideLine(withLine, LINE), true, '真正的整行仍然命中');
    assert.equal(chatHideModel.hasHideLine(`${LINE}\r\n`, LINE), true, 'CRLF 差异仍算命中');

    const port = fakeRunner(superHead, 'ahead', false, false);
    const decision = await decide(port, LINE);
    assert.equal(decision, 'commit', '只有超串含本行 ⇒ 没被提交，走 commit');
    assert.deepEqual(port.calls, ['showHead'], 'gate 未命中 ⇒ 不读 headRelation（与决策同一判据）');
    assert.equal(port.calls.includes('headRelation'), false);
  });
});
