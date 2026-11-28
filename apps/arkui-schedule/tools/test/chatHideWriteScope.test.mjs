// mod-app-chat-hide：窄写通道的上传范围谓词 + **逐条**入口的源码守卫（Node 可直接跑，无 ArkTS）。
// 前置：node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { ETS_ROOT } from './settingsSources.mjs';
import { stripComments } from './helpers/etsSource.mjs';

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

  test('WS-06 读侧渲染 chat / dots 两种云端 preset，写侧白名单复核两种云端 preset（工作会话不可隐藏）', () => {
    assert.match(chatListModel, /export type ChatSessionPreset = 'chat' \| 'dots' \| 'other'/);
    assert.match(chatListModel, /raw\.type === 'session'/);
    assert.match(chatListModel, /raw\.type === 'agent-preset\/selected'/);
    assert.match(chatListModel, /export function filterChatPreset\(/);
    assert.match(chatListModel, /preset === 'chat' \|\| preset === 'dots'/, '两种云端种类都准入');
    assert.match(chatListModel, /preset: preset/, '准入时把投影派生到条目字段，供分段使用');
    assert.match(chatStore, /filterChatPreset\(parsed\.entries, presets\)/, '列表只返回云端 preset 条目');
    assert.match(chatStore, /this\.readSessionPreset\(entry\.id\)/, '每条索引行都要查 preset');
    const writer = chatStore.slice(chatStore.indexOf('async hideChat('));
    // 这条守卫管的是「只有云端种类可写」，不是「写口必须长得像 chat」：
    // dots 现在也是云端、也渲染出可点行，必须与 chat 一样可隐藏；工作种类（other）仍一律 prepare 早退。
    // 所以按产品规则把字面量从单一 chat 放宽到恰好 chat / dots 两个白名单成员，并且更严：
    // 任何第三种 preset（standard / null / 缺字段 / 未知值）都不允许通过。
    assert.match(writer, /const preset: ChatSessionPreset = this\.readSessionPreset\(safeId\)/,
      '写口必须先取真实投影 preset');
    assert.match(writer, /if \(preset !== 'chat' && preset !== 'dots'\)/,
      '写口白名单必须恰好接受 chat / dots 两种云端种类');
    assert.doesNotMatch(writer, /preset !== 'other'/, '不得放宽成「不是 other」的黑名单');
    const writeIndex = writer.indexOf('this.writeHideText(');
    const presetCheck = writer.indexOf("preset !== 'chat' && preset !== 'dots'");
    assert.ok(presetCheck >= 0 && presetCheck < writeIndex, 'preset 检查必须在任何写动作之前');
    // 没有从标题 / 工作区 / index.kind 猜测 preset 的第二来源
    assert.equal(/presetOf\(\s*entry\.title|presetOf\(\s*entry\.kind/.test(chatListModel), false);
  });

  test('WS-07 行只来自 visibleChats：工作会话连行尾按钮都不会出现', () => {
    assert.match(chatsPage, /ForEach\(\s*this\.visibleChats,[\s\S]{0,500}this\.ChatRow\(item\.id/);
    assert.equal(/ForEach\(\s*this\.chats,[\s\S]{0,300}this\.ChatRow/.test(chatsPage), false);
    assert.match(chatsPage, /this\.askHide\(id\)/, '按钮只把可见行的 id 交给确认');
  });

  test('WS-08 三处视图分段都只认投影派生 preset，不认 index.kind', () => {
    assert.match(chatListModel, /export function filterBySegment\(/);
    assert.match(chatListModel, /`kind` 只是第二来源/, '中文注释钉住「投影胜出」');
    assert.match(chatsPage, /filterBySegment\(this\.chats, this\.kind\)/, 'Chats 页按投影分段');
    assert.equal(/filterByKind\(this\.chats/.test(chatsPage), false, 'Chats 页不得按索引 kind 分段');
    assert.match(chatsPage, /item\.preset === 'dots' \? 'dots' : 'chat'/, '行徽章只认投影派生字段');
    assert.equal(/item\.kind === 'dots'/.test(chatsPage), false, '行徽章不得读索引 kind');
    for (const pane of ['DotsPane.ets', 'CloudChatPane.ets']) {
      const text = readFileSync(join(ETS_ROOT, 'pages', 'panes', pane), 'utf8');
      assert.match(text, /filterBySegment\(result\.entries, PANE_KIND\)/, `${pane} 按投影分段`);
      assert.equal(/filterByKind\(result\.entries/.test(text), false, `${pane} 不得按索引 kind 分段`);
    }
  });

  test('WS-09 任何视图不得用 entry.kind 决定分段/可见性', () => {
    // 【规则：以后要放宽先读完这段，别再加临时正则】
    // 唯一真相是 session.jsonl 投影出的 preset（filterChatPreset 派生、filterBySegment 消费）；
    // chats/index.jsonl 复制来的 entry.kind 是第二来源，视图（以及视图 outsourcing 出去的
    // 助手）不得拿它决定分段或可见性。
    //
    // 【禁止】严格口径 = pages/** + 所有 import model/chatList 的源文件：
    //   A. 除白名单外任何 `.kind` / `['kind']` 属性读——不挑变量名，所以别名
    //      `const e = entry; e.kind` 一样拦；switch / GROUP[entry.kind] / 无比较读
    //      都由这一条统一覆盖，不再依赖「有没有 ===」；
    //   B. 行名 entry/item/row/chat/chatEntry 上的 `[K]` 计算键读（K 为任意标识符），
    //      专门钉住 `entry[K] === 'dots'` 这种没有 kind 字面量的绕法；
    //   C. 任何解构出 kind 的写法 `{ kind } = x` / `{ kind: k } = x`；
    //   D. `filterBySegment(..., <第二参数含 kind>)`——把索引 kind 直接喂进分段函数
    //      根本不需要比较运算符，所以单独钉死（即便 A 被白名单遮掉也仍然红）。
    //
    // 【允许】this.kind 是页面 UI 段状态（路由只读它）；params['kind'] === 'dots'
    //   是 readKindParam 的路由入参判别（预选 UI 段，也不是索引行）；
    //   kind: 是对象键 / 形参名，压根不是属性读；
    //   result.kind === 'ok' 与 modelsKindLabel(result.kind) 是 SettingsApi 的模型
    //   拉取判别联合，与会话行毫无关系。这些形状先被遮成等长空格，剩下的代码才受审。
    //   白名单刻意逐字精确：不能泛化成「任意 result.kind」，否则别名可以借这个名字溜走。
    //
    // 【范围】严格口径放 pages/** 与 chatList 的全部导入者（助手想拿到行对象就得
    //   import 它的类型/函数，逃不出这张网）；另外 model/services/common 再用窄口径
    //   （行名 entry/chatEntry/row/chat 的 kind 读 + C + D）扫一遍，堵住「不 import
    //   却收了个结构相同的行对象」的助手。这三个目录没有用严格口径，是因为
    //   result / decision / spec / object.kind 是大量合法的判别字段，全禁会淹没真信号。
    // ────────────────────────────────────────────────────────────────────────

    const files = listFiles(ETS_ROOT).filter((file) => /\.(?:ets|ts)$/.test(file));
    assert.ok(files.length > 1, '源码扫描必须是非空集合，不能 vacuous pass');
    const relOf = (file) => file.replace(/\\/g, '/');
    const isPage = (file) => relOf(file).includes('/pages/');
    const fromChatList = /from\s*['"][^'"]*model\/chatList['"]/;
    const sources = files.map((file) => ({ file, raw: readFileSync(file, 'utf8') }));
    const strictSources = sources.filter(({ file, raw }) => isPage(file) || fromChatList.test(raw));
    assert.ok(strictSources.some(({ file }) => relOf(file).endsWith('/pages/Chats.ets')),
      '扫描集合必须包含 pages/Chats.ets');
    assert.ok(strictSources.some(({ file }) => !isPage(file)),
      '扫描集合必须包含 pages 外的 chatList 导入者（services/chatStore.ets），否则助手仍能逃逸');
    const wideSources = sources.filter(({ file }) => /\/(?:model|services|common)\//.test(relOf(file)));
    assert.ok(wideSources.length > 1, 'model/services/common 的助手扫描不能是空集');

    // 先剥注释、再把白名单遮成等长空格（换行不动，报错仍可定位行号）。
    const allowed = [
      /this\.kind/g,
      /params\s*\[\s*['"]kind['"]\s*\]\s*===\s*['"]dots['"]/g,
      /result\.kind\s*===\s*['"]ok['"]/g,
      /modelsKindLabel\(\s*result\.kind\s*\)/g
    ];
    const masked = (raw) => allowed.reduce(
      (text, re) => text.replace(re, (hit) => hit.replace(/[^\n]/g, ' ')),
      stripComments(raw));

    // A/B：严格口径认任何 .kind 读；助手窄口径只认行名，避开合法判别字段。
    const strictKindRead = /\.\s*kind\b|\[\s*['"]kind['"]\s*\]|\b(?:entry|item|row|chat|chatEntry)\s*\[\s*[A-Za-z_$]\w*\s*\]/;
    const helperKindRead = /\b(?:entry|chatEntry|row|chat)\s*(?:\?\.\s*)?\.\s*kind\b|\b(?:entry|chatEntry|row|chat)\s*\[\s*(?:['"]kind['"]|[A-Za-z_$]\w*)\s*\]/;
    // C/D：两种口径共用。
    const kindDestructure = /\{[^{}]*\bkind\b[^{}]*\}\s*=/;
    const kindIntoSegment = /\bfilterBySegment\s*\([^)]*,[^)]*(?:\.\s*kind\b|\[\s*['"]kind['"]\s*\])/;

    for (const { file, raw } of strictSources) {
      const code = masked(raw);
      // D 先判：让「直接把 kind 喂进分段函数」有自己的报错，便于定位这类无比较读。
      assert.equal(kindIntoSegment.test(code), false,
        `${file} 不得把 kind 当第二参数喂给 filterBySegment`);
      assert.equal(strictKindRead.test(code), false,
        `${file} 不得读索引行 kind（别名 / 计算键 / 无比较读都算）`);
      assert.equal(kindDestructure.test(code), false,
        `${file} 不得解构 kind 再拿它分段`);
    }
    for (const { file, raw } of wideSources) {
      const code = masked(raw);
      assert.equal(kindIntoSegment.test(code), false,
        `${file} 助手不得把 kind 喂给 filterBySegment`);
      assert.equal(helperKindRead.test(code), false,
        `${file} 助手不得读行名 kind 再交给视图`);
      assert.equal(kindDestructure.test(code), false,
        `${file} 助手不得解构 kind`);
    }
  });
});
