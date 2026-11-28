// mod-app-chat-hide：窄写通道的上传范围谓词 + **逐条**入口的源码守卫（Node 可直接跑，无 ArkTS）。
// 前置：node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { ETS_ROOT } from './settingsSources.mjs';

// tsc 产出的 .build 是「无扩展名相对 import」的 ESM（与 pendingUploadDiagnosis.test.mjs 同一套解析钩子）。
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error !== null && typeof error === 'object' &&
          error.code === 'ERR_MODULE_NOT_FOUND' &&
          specifier.startsWith('.') && !specifier.endsWith('.js')) {
        return nextResolve(`${specifier}.js`, context);
      }
      throw error;
    }
  }
});
const {
  CHAT_HIDE_INDEX_PATH, daysInStageSet, isUploadableTimelinePath,
  partitionDirtyPaths, stagePathsForCycle, timelineDayOfPath
} = await import('../.build/model/syncUploadScope.js');

const APP_ROOT = join(ETS_ROOT, '..', '..', '..', '..');
const chatsPage = readFileSync(join(ETS_ROOT, 'pages', 'Chats.ets'), 'utf8');
const chatListModel = readFileSync(join(ETS_ROOT, 'model', 'chatList.ts'), 'utf8');
const chatStore = readFileSync(join(ETS_ROOT, 'services', 'chatStore.ets'), 'utf8');
const bridgePath = join(APP_ROOT, 'entry/src/main/resources/rawfile/git/git-bridge.js');
const bridge = readFileSync(bridgePath, 'utf8');

/** 递归列出目录下的全部文件（源码守卫用：确保扫描不是空集）。 */
function listFiles(dir) {
  let files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files = files.concat(listFiles(full));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

/** confirmHide 方法体切片（守卫「一次只写一条 + 失败重读索引」）。 */
function confirmHideBody(src) {
  const start = src.indexOf('private async confirmHide()');
  assert.notEqual(start, -1, '必须存在 confirmHide');
  const end = src.indexOf('/** 标题栏副标题', start);
  assert.notEqual(end, -1, 'confirmHide 之后必须接副标题方法');
  return src.slice(start, end);
}

describe('mod-app-chat-hide：上传范围谓词（精确字面量，不是 chats/ 前缀）', () => {
  test('WS-01 isUploadableTimelinePath 只额外接受 chats/index.jsonl', () => {
    assert.equal(CHAT_HIDE_INDEX_PATH, 'chats/index.jsonl');
    assert.equal(isUploadableTimelinePath('chats/index.jsonl'), true);
    for (const path of [
      'chats/<id>/meta.json', 'chats/s1/meta.json', 'chats/s1/session.jsonl',
      'chats/', 'chats', 'chats//index.jsonl', 'chats/index.jsonl.bak',
      'chats/../chats/index.jsonl', '/chats/index.jsonl', 'C:\\repo\\chats\\index.jsonl',
      'devices/tablet-a/open.jsonl', 'README.md', 'timeline/notes.txt'
    ]) {
      assert.equal(isUploadableTimelinePath(path), false, `不得接受：${path}`);
    }
    // 既有时间线口径一条不放宽
    assert.equal(isUploadableTimelinePath('timeline/schema.json'), true);
    assert.equal(isUploadableTimelinePath('timeline/2026-11-28/records.json'), true);
    assert.equal(isUploadableTimelinePath('timeline/2026-11-28/records.json.tmp-1-2'), false);
    assert.equal(timelineDayOfPath('chats/index.jsonl'), null, '隐藏行不属于任何日');
  });

  test('WS-02 partitionDirtyPaths / stagePathsForCycle 只把那一个路径放进提交集合', () => {
    const dirty = [
      'chats/index.jsonl', 'chats/s1/meta.json', 'chats/s1/session.jsonl',
      'chats//index.jsonl', 'timeline/2026-11-28/records.json'
    ];
    const split = partitionDirtyPaths(dirty);
    assert.deepEqual(split.uploadable, ['chats/index.jsonl', 'timeline/2026-11-28/records.json']);
    // chats//index.jsonl 归一化后与合法字面量同键，按既有「同一路径只出现一次」去重，不单列。
    assert.deepEqual(split.notUploadable, ['chats/s1/meta.json', 'chats/s1/session.jsonl']);
    const staged = stagePathsForCycle([], dirty, []);
    assert.equal(staged.includes('chats/index.jsonl'), true, '隐藏行不因 days 为空而被漏提交');
    assert.equal(staged.includes('chats/s1/meta.json'), false);
    assert.equal(staged.includes('chats//index.jsonl'), false);
    assert.equal(daysInStageSet(staged), 0, '隐藏行不属于任何日，不改变 [v2] sync 的日数');
    const withDay = stagePathsForCycle([], dirty, ['2026-11-28']);
    assert.equal(withDay.includes('chats/index.jsonl'), true);
    assert.equal(daysInStageSet(withDay), 1, '有日文件时日数仍按 timeline 算');
  });

  test('WS-02A stagePathsForCycle 的 changedPaths 也过谓词与原始字面量守卫', () => {
    // changedPaths 不再无条件放行：chats/<id>/**、归一化同形路径、残留、越界都不进提交集合。
    assert.deepEqual(stagePathsForCycle(['chats/s1/session.jsonl', 'chats/s1/meta.json'], undefined, []), []);
    assert.deepEqual(stagePathsForCycle(['chats//index.jsonl', 'chats/index.jsonl.bak'], undefined, []), []);
    assert.deepEqual(stagePathsForCycle(['timeline/2026-11-28/records.json.tmp-1-2'], undefined, []), []);
    assert.deepEqual(stagePathsForCycle(['../timeline/2026-11-28/records.json'], undefined, []), []);
    // 精确字面量与合法时间线路径仍按原口径进集合（不放宽也不收紧）。
    assert.deepEqual(stagePathsForCycle(['chats/index.jsonl', 'timeline/2026-11-28/records.json'], undefined, []),
      ['chats/index.jsonl', 'timeline/2026-11-28/records.json']);
  });

  test('WS-02B partitionDirtyPaths 去重：畸形同形路径先到也不压制精确字面量', () => {
    const malformedFirst = partitionDirtyPaths(['chats//index.jsonl', 'chats/index.jsonl']);
    assert.deepEqual(malformedFirst.uploadable, ['chats/index.jsonl']);
    assert.deepEqual(malformedFirst.notUploadable, [], '别名不冒充不可上传项，也不占用字面量的去重键');
    const literalFirst = partitionDirtyPaths(['chats/index.jsonl', 'chats//index.jsonl']);
    assert.deepEqual(literalFirst.uploadable, ['chats/index.jsonl'], '既有顺序仍然成立');
    assert.deepEqual(literalFirst.notUploadable, []);
    // 没有真字面量时，畸形路径仍按原口径计入 notUploadable，且自身之间照旧去重。
    const onlyMalformed = partitionDirtyPaths(['chats//index.jsonl', 'chats//index.jsonl']);
    assert.deepEqual(onlyMalformed.uploadable, []);
    assert.deepEqual(onlyMalformed.notUploadable, ['chats//index.jsonl']);
  });

  test('WS-02C stagePathsForCycle 脏路径：隐藏行两种到达顺序都进集合，<id> 路径仍拒', () => {
    const malformedFirst = stagePathsForCycle(
      [], ['chats//index.jsonl', 'chats/index.jsonl', 'chats/s1/session.jsonl'], []);
    assert.deepEqual(malformedFirst, ['chats/index.jsonl'], '别名先到不占位；真字面量提交；<id> 路径被拒');
    assert.deepEqual(stagePathsForCycle([], ['chats/index.jsonl', 'chats//index.jsonl'], []), ['chats/index.jsonl']);
    assert.equal(daysInStageSet(malformedFirst), 0, '隐藏行仍不属于任何日');
  });

  test('WS-03 桥侧 addCommit 白名单同样只多一个字面量', () => {
    assert.equal(bridge.includes("paths[i] === 'chats/index.jsonl'"), true);
    assert.equal(bridge.includes("paths[i].indexOf('timeline/') === 0"), true);
    assert.equal(bridge.includes("paths[i].indexOf('chats/') === 0"), false, '不得改成 chats/ 前缀');
    assert.equal(bridge.includes("paths[i].indexOf('..') < 0"), true, '穿越仍被拒');
  });
});

describe('mod-app-chat-hide：**逐条**入口与写者形状（源码守卫）', () => {
  test('WS-04 列表行只有一个单 id 删除按钮，没有多选 / 长按 / 滑动 / 批量 API', () => {
    assert.match(chatsPage, /pendingId: string = ''/, '待确认项只能是单个 id');
    assert.equal(/pendingIds|selectedIds|checkedIds/.test(chatsPage), false, '不得有多选集合');
    assert.match(chatsPage, /private askHide\(id: string\): void/, '入口只收一个 id');
    assert.match(chatsPage, /chatStore\.hideChat\(id\)/, '确认只调用该行的 id');
    for (const banned of ['LongPressGesture', 'onLongPress', '.swipeAction(', 'hideAll', 'hideMany', 'deleteAll']) {
      assert.equal(chatsPage.includes(banned), false, `禁止手势 / 批量：${banned}`);
    }
    const body = confirmHideBody(chatsPage);
    assert.equal(body.includes('hideChat(ids'), false, '不得有复数 id 的写 API');
    assert.match(body, /await this\.reload\(\)/, '无论成败都重读索引，不留乐观隐藏');
  });

  test('WS-05 确认 sheet 逐字渲染 chatHidePlanOf；写者只有单 id / 四阶段 / 无恢复', () => {
    for (const field of ['title', 'lines', 'confirmLabel', 'cancelLabel']) {
      assert.match(chatsPage, new RegExp(`this\\.hidePlan\\.${field}`), `sheet 必须渲染 ${field}`);
    }
    assert.match(chatStore, /async hideChat\(id: string\): Promise<HideOutcome>/);
    assert.equal(/hideChat\(ids\s*:/.test(chatStore), false);
    assert.equal(/['"]unarchive['"]/.test(chatStore), false, '写者不产出 unarchive 行');
    assert.equal(chatStore.includes('op: \'archive\''), false, '行形状只由 chatHide.hideLineOf 决定');
    assert.match(chatStore, /hideReasonOf\(stage\)/, '四阶段文案统一经 hideReasonOf');
    for (const stage of ['prepare', 'write', 'commit', 'push']) {
      assert.match(chatStore, new RegExp(`this\\.hideFailure\\('${stage}'\\)`), `必须接线阶段 ${stage}`);
    }
    assert.match(chatStore, /HIDE_INDEX_PATH/, '提交路径只能是精确白名单里的那一条');
  });

  test('WS-05A 会话发布尾注两种拼写都不在 ets 源码 / git 桥里（防漂移源码守卫）', () => {
    const sources = listFiles(ETS_ROOT).concat([bridgePath]);
    assert.ok(sources.length > 1, '守卫必须真的扫到文件，不能空集 vacuous pass');
    for (const file of sources) {
      const text = readFileSync(file, 'utf8');
      for (const trailer of ['dsh-dots-chat-export:', 'dsh-dots-chat-sync:']) {
        assert.equal(text.includes(trailer), false, `${file} 不得出现会话发布尾注：${trailer}`);
      }
    }
  });

  test('WS-06 读侧只渲染 chat preset，写侧复核同一判据（工作会话不可隐藏）', () => {
    assert.match(chatListModel, /export type ChatSessionPreset = 'chat' \| 'other'/);
    assert.match(chatListModel, /raw\.type === 'session'/);
    assert.match(chatListModel, /raw\.type === 'agent-preset\/selected'/);
    assert.match(chatListModel, /export function filterChatPreset\(/);
    assert.match(chatStore, /filterChatPreset\(parsed\.entries, presets\)/, '列表只返回 chat preset 条目');
    assert.match(chatStore, /this\.readSessionPreset\(entry\.id\)/, '每条索引行都要查 preset');
    const writer = chatStore.slice(chatStore.indexOf('async hideChat('));
    assert.match(writer, /this\.readSessionPreset\(safeId\) !== 'chat'/, '写口必须复核 preset');
    const writeIndex = writer.indexOf('this.writeHideText(');
    const presetCheck = writer.indexOf("this.readSessionPreset(safeId) !== 'chat'");
    assert.ok(presetCheck >= 0 && presetCheck < writeIndex, 'preset 检查必须在任何写动作之前');
    // 没有从标题 / 工作区 / index.kind 猜测 preset 的第二来源
    assert.equal(/presetOf\(\s*entry\.title|presetOf\(\s*entry\.kind/.test(chatListModel), false);
  });

  test('WS-07 行只来自 visibleChats：工作会话连行尾按钮都不会出现', () => {
    assert.match(chatsPage, /ForEach\(\s*this\.visibleChats,[\s\S]{0,500}this\.ChatRow\(item\.id/);
    assert.equal(/ForEach\(\s*this\.chats,[\s\S]{0,300}this\.ChatRow/.test(chatsPage), false);
    assert.match(chatsPage, /this\.askHide\(id\)/, '按钮只把可见行的 id 交给确认');
  });
});
