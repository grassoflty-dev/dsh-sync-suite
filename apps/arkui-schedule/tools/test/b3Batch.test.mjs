// B3 批回归断言：路径 1「保存返回首页 = 一次性标记 + 局部刷新」+ D1-P2「DSH 地址失焦即归一」。
//
// 断言风格沿用 b2Batch.test.mjs：ArkTS（.ets）依赖 @kit.ArkUI 等运行时，Node 里跑不起来，
// 但「读后即清的先后顺序」「保存分支不许跑全量」「令牌绝不进输入框」「失焦只归一不落盘」
// 这些都是纯文本可判定的事实，用测试钉死能挡住「标记写晚了一步」「归一顺手把 token 拼进去」
// 「失焦直接跳页」这类回归。
//
// 本文件只新增断言，不改任何既有源码/测试；断言按契约写，实现偏离就红，不放宽。
// 前置：先构建纯逻辑层
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { readSettingsPage } from './settingsSources.mjs';

// 纯逻辑：homeRefresh.ts 零 SDK import，编译产物可直接 import（无运行时相对依赖）。
const { SAVED_MARKER_KEY, encodeSavedMarker, decodeSavedMarker, containsRecordVersion } =
  await import('../.build/model/homeRefresh.js');

const ETS = new URL('../../entry/src/main/ets/', import.meta.url);
// S3：日程契约锚点从 fallback 路由 pages/Index.ets 移到真 body 所在的日程面板。
const INDEX = readFileSync(new URL('pages/panes/SchedulePane.ets', ETS), 'utf8');
const EDITOR = readFileSync(new URL('components/RecordEditorView.ets', ETS), 'utf8');
const EDIT = readFileSync(new URL('pages/Edit.ets', ETS), 'utf8');
const SETTINGS = readSettingsPage();

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

/**
 * 剥掉块注释与行注释，但**保留字符串字面量里的 `//`**（避免把 URL / 文案误当注释）。
 * 用途：保存分支的注释里写了「不推进 paneTick」这句纪律，那是陈述纪律、不是执行代码；
 * 只有剥注释后仍在可执行代码里的 `paneTick` / `loadSummary()` 才算破坏「局部刷新」契约。
 * 与 b2Batch.test.mjs 的 stripComments 同一套规则。
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

/** 从 `marker`（如 `if (this.ready) {` / `RecordEditorView({`）起按大括号配平截取块。 */
function braceBlockFrom(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `找不到块：${marker}`);
  const brace = source.indexOf('{', start);
  assert.ok(brace >= 0, `${marker} 找不到起始大括号`);
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
  assert.fail(`${marker} 的大括号不配平`);
}

/** 断言若干锚点在文本里按给定顺序出现（先检查 >=0，避免出现 -1 时比较「假通过」）。 */
function assertOrdered(text, tokens, label) {
  let previous = -1;
  for (const token of tokens) {
    const index = text.indexOf(token);
    assert.ok(index >= 0, `${label}：找不到 ${token}`);
    assert.ok(index > previous, `${label}：${token} 的顺序不对（应排在 ${tokens[tokens.indexOf(token) - 1] ?? '开头'} 之后）`);
    previous = index;
  }
}

const ON_PAGE_SHOW = bodyFrom(INDEX, 'onPageShow(): void {');
const READY_BRANCH = braceBlockFrom(ON_PAGE_SHOW, 'if (this.ready) {');
const SAVED_BRANCH = braceBlockFrom(ON_PAGE_SHOW, 'if (saved !== null) {');
const SAVED_BRANCH_CODE = stripComments(SAVED_BRANCH);
const CONSUME = bodyFrom(INDEX, 'private consumeSavedMarker(): SavedMarker | null {');
const RECONCILE = bodyFrom(INDEX, 'private reconcileSavedRow(saved: SavedMarker): void {');
const EDITOR_SAVE = bodyFrom(EDITOR, 'private save(): void {');
const MARKER_OF = bodyFrom(EDITOR, 'private savedMarkerOf(record: ScheduleRecord): SavedMarker {');
const EDIT_VIEW = braceBlockFrom(EDIT, 'RecordEditorView({');
// mod-settings-remote-dedupe（old→new）：normalizeRemoteOnBlur / RemoteSection 装配已随远程组删除。
// 旧锚点不再可取；C 段断言整体 retarget 到「字段确实删除 + 入口唯一 + 迁移幂等」，
// 避免留下取不到锚点的死断言（那会让测试永久红而不是守约）。

const FULL_MARKER = {
  id: 'r1',
  date: '2026-11-19',
  ts: '2026-11-19T09:00:00+08:00',
  done: true
};

// ---------------------------------------------------------------------------
// A. 纯逻辑（model/homeRefresh.ts → tools/.build/model/homeRefresh.js）
// ---------------------------------------------------------------------------
describe('B3 纯逻辑 homeRefresh：一次性标记的编解码与版本判定', () => {
  test('B3-01 AppStorage 键固定为 home.lastSaved（改键要同步改文档，钉死）', () => {
    assert.equal(SAVED_MARKER_KEY, 'home.lastSaved');
  });

  test('B3-02 encode → decode 往返四字段全等', () => {
    assert.deepEqual(decodeSavedMarker(encodeSavedMarker(FULL_MARKER)), FULL_MARKER);
  });

  test('B3-03 done 缺失/非 boolean → false；id/date/ts 缺失、空串、非字符串 → null', () => {
    const base = { id: 'r1', date: '2026-11-19', ts: '2026-11-19T09:00:00+08:00' };
    assert.equal(decodeSavedMarker(JSON.stringify(base)).done, false, 'done 缺失应归 false');
    for (const bad of ['true', 1, null, {}]) {
      assert.equal(decodeSavedMarker(JSON.stringify({ ...base, done: bad })).done, false, `done=${JSON.stringify(bad)} 应归 false`);
    }
    for (const key of ['id', 'date', 'ts']) {
      const missing = { ...base };
      delete missing[key];
      assert.equal(decodeSavedMarker(JSON.stringify(missing)), null, `${key} 缺失 → null`);
      assert.equal(decodeSavedMarker(JSON.stringify({ ...base, [key]: '' })), null, `${key} 空串 → null`);
      assert.equal(decodeSavedMarker(JSON.stringify({ ...base, [key]: 123 })), null, `${key} 非字符串 → null`);
    }
  });

  test('B3-04 脏输入一律 null 且不抛（空/空白/坏 JSON/标量/未传/超长）', () => {
    const dirty = ['', '   ', '{', '[]', 'null', '"x"', undefined, null, 'x'.repeat(3000)];
    for (const raw of dirty) {
      assert.doesNotThrow(
        () => assert.equal(decodeSavedMarker(raw), null, `脏输入应返回 null：${String(raw).slice(0, 24)}`),
        `decodeSavedMarker 不得抛异常：${String(raw).slice(0, 24)}`
      );
    }
  });

  test('B3-05 containsRecordVersion：同 id 同 ts 才算命中，空列表/null/undefined 为 false', () => {
    const records = [{ id: 'r1', ts: 't1' }, { id: 'r2', ts: 't1' }];
    assert.equal(containsRecordVersion(records, 'r1', 't1'), true, '同 id 同 ts → true');
    assert.equal(containsRecordVersion(records, 'r1', 't2'), false, '同 id 不同 ts → false');
    assert.equal(containsRecordVersion(records, 'r3', 't1'), false, '不同 id → false');
    assert.equal(containsRecordVersion([], 'r1', 't1'), false, '空数组 → false');
    assert.equal(containsRecordVersion(null, 'r1', 't1'), false, 'null → false');
    assert.equal(containsRecordVersion(undefined, 'r1', 't1'), false, 'undefined → false');
  });

  test('B3-06 序列化字段顺序固定为 id,date,ts,done', () => {
    assert.deepEqual(Object.keys(JSON.parse(encodeSavedMarker(FULL_MARKER))), ['id', 'date', 'ts', 'done']);
  });
});

// ---------------------------------------------------------------------------
// B. 路径 1：SchedulePane.ets（S3 迁入的日程正文）+ RecordEditorView.ets + Edit.ets 的静态契约
// ---------------------------------------------------------------------------
describe('B3 路径 1：保存返回首页走局部刷新的源码级契约', () => {
  test('B3-07（v2-only  retarget）onPageShow ready 分支：先 consume 再 reload；无 v1 索引对账', () => {
    assertOrdered(
      READY_BRANCH,
      ['this.consumeSavedMarker()', 'this.reload()'],
      'SchedulePane.onPageShow.ready'
    );
    assert.doesNotMatch(READY_BRANCH, /reconcileIfDue/, 'v2-only：不得再写 v1 索引');
    assert.match(SAVED_BRANCH, /this\.reload\(\);/, '保存分支必须重读列表');
    assert.match(SAVED_BRANCH, /this\.reconcileSavedRow\(saved\);/, '保存分支必须做单行对账');
    assert.equal(SAVED_BRANCH_CODE.includes('loadSummary()'), false, '保存分支的可执行代码不得重读汇总（全量重载）');
    assert.equal(SAVED_BRANCH_CODE.includes('paneTick'), false, '保存分支的可执行代码不得推进 paneTick（全量重载）');
  });

  test('B3-08 consumeSavedMarker：get 之后立刻 setOrCreate 清空，并 return decodeSavedMarker(raw)', () => {
    assert.match(
      CONSUME,
      /const raw: string \| undefined = AppStorage\.get<string>\(SAVED_MARKER_KEY\);\s*AppStorage\.setOrCreate<string>\(SAVED_MARKER_KEY, ''\);/,
      '一次性标记必须读后即清，且 get 后紧接 setOrCreate，不许插其他语句'
    );
    assert.match(CONSUME, /return decodeSavedMarker\(raw\);/, '必须把原文交给 decodeSavedMarker');
  });

  test('B3-09（v2-only  retarget）reconcileSavedRow：三条早退 + 兜底 reload + loadSummary + 非静默中文 toast', () => {
    assert.match(RECONCILE, /if \(this\.tab === 'pending' && saved\.done === true\) \{\s*return;\s*\}/, '早退①：未完成 tab 里已完成');
    assert.match(
      RECONCILE,
      /if \(this\.tab === 'today' && saved\.date !== this\.selectedDate\) \{\s*return;\s*\}/,
      '早退②：today tab（当日全部日程）但日期不匹配'
    );
    assert.match(
      RECONCILE,
      /if \(containsRecordVersion\(this\.records, saved\.id, saved\.ts\)\) \{\s*return;\s*\}/,
      '早退③：列表已有同 id 同 ts 版本'
    );
    assert.match(RECONCILE, /this\.reload\(\);/, '兜底必须重读 v2 列表');
    assert.doesNotMatch(RECONCILE, /openIndexStore\.reconcile\(\)/, 'v2-only：不得写 v1 索引');
    assert.match(RECONCILE, /this\.loadSummary\(\);/, '兜底必须重读汇总');
    assert.match(
      RECONCILE,
      /promptAction\.showToast\(\{[\s\S]*?message: '返回列表时没读到刚保存的日程，已重新加载'/,
      '兜底必须给中文 toast，不许静默'
    );
  });

  test('B3-10a RecordEditorView 有 @Prop autoFocusTitle: boolean = false', () => {
    assert.match(EDITOR, /@Prop autoFocusTitle: boolean = false;/, '契约丢了：缺 autoFocusTitle prop 或默认值不是 false');
  });

  test('B3-10b 标题 defaultFocus 表达式同时含 autoFocusTitle / recordId.length === 0 / title.trim().length === 0', () => {
    assert.match(
      EDITOR,
      /\.defaultFocus\(this\.autoFocusTitle && this\.recordId\.length === 0 && this\.title\.trim\(\)\.length === 0\)/,
      '契约丢了：defaultFocus 三条件必须齐全（新建 + 标题空白 + 开关打开）'
    );
  });

  test('B3-10c save() 里一次性标记写在 this.onSaved(record) 之前', () => {
    const markerCall = 'AppStorage.setOrCreate<string>(SAVED_MARKER_KEY, encodeSavedMarker(this.savedMarkerOf(record)))';
    const markerAt = EDITOR_SAVE.indexOf(markerCall);
    assert.ok(markerAt >= 0, '契约丢了：save() 未写一次性标记');
    const savedAt = EDITOR_SAVE.indexOf('this.onSaved(record);');
    assert.ok(savedAt >= 0, '契约丢了：save() 未调用 onSaved');
    assert.ok(markerAt < savedAt, '标记必须在 onSaved（它会 router.back 触发首页 onPageShow）之前写好');
  });

  test('B3-10d savedMarkerOf 的 date 来自 resolveRecordDate(record.ts)，不猜 defaultDate/selectedDate', () => {
    assert.match(MARKER_OF, /date: resolveRecordDate\(record\.ts\)/, 'date 必须由记录 ts 推导');
    assert.equal(MARKER_OF.includes('defaultDate'), false, '不许拿 defaultDate 猜日期');
    assert.equal(MARKER_OF.includes('selectedDate'), false, '不许拿首页 selectedDate 猜日期');
  });

  test('B3-11 Edit.ets 薄壳：RecordEditorView 传 autoFocusTitle: true，全文无 showToast', () => {
    assert.match(EDIT_VIEW, /autoFocusTitle: true/, 'Edit.ets 必须打开标题自动聚焦');
    assert.equal(EDIT.includes('showToast'), false, 'Edit.ets 必须保持薄壳，不得自己弹 toast');
  });
});

// ---------------------------------------------------------------------------
// C. mod-settings-remote-dedupe：设置页远程组已删除，归一/配置收敛到实例页
// ---------------------------------------------------------------------------
describe('B3 C（retarget）：远程组删除后，地址归一仍在实例页、设置页无重复字段', () => {
  test('B3-12（old→new）normalizeRemoteOnBlur 与 RemoteSection 一并删除；归一是实例页的职责', () => {
    for (const gone of [
      /normalizeRemoteOnBlur/, /parseRemoteInput/, /lastBlurNormalizeText/,
      /onBlurRemoteUrl/, /onChangeRemoteUrl/, /savedRemoteToken/
    ]) {
      assert.equal(gone.test(SETTINGS), false, `设置页残留已删远程归一逻辑：${gone}`);
    }
  });

  test('B3-13（old→new）RemoteSection.ets 文件删除，设置页不再导入/装配它', () => {
    assert.equal(SETTINGS.includes("from '../components/settings/RemoteSection'"), false, '不该再导入 RemoteSection');
    assert.equal(/RemoteSection\(\{/.test(SETTINGS), false, '不该再装配 RemoteSection');
  });

  test('B3-14（old→new）入口唯一：RemoteGroup 只渲染 ChatEntryRow，指向 pages/Instances', () => {
    const group = bodyFrom(SETTINGS, 'RemoteGroup() {');
    assert.equal((group.match(/this\.ChatEntryRow\(\)/g) ?? []).length, 1, '入口行恰好一行');
    assert.equal((group.match(/TextInput\(/g) ?? []).length, 0, '入口组里不该有输入框');
    assert.match(SETTINGS, /router\.pushUrl\(\{ url: 'pages\/Instances' \}\)/, '入口指向实例页');
    // 归一规则本身仍在 model 层，由实例面板 submitForm 复用（不是删掉校验）。
    // mod-shell-instances-pane（old→new）：锚点 pages/Instances.ets → pages/panes/InstancesPane.ets。
    assert.match(
      readFileSync(new URL('pages/panes/InstancesPane.ets', ETS), 'utf8'),
      /normalizeRemoteUrl\(this\.formUrl\.trim\(\)\)/,
      '实例面板保存仍走同一条归一规则'
    );
  });

  test('B3-15（old→new）旧值不丢：实例面板 bootstrap 把 remoteUrl / lastOk / mode / token 全量播种', () => {
    // mod-shell-instances-pane（old→new）：锚点 pages/Instances.ets → pages/panes/InstancesPane.ets。
    const page = readFileSync(new URL('pages/panes/InstancesPane.ets', ETS), 'utf8');
    for (const field of ['remoteUrl', 'remoteLastOk', 'remoteMode', 'remoteToken']) {
      assert.match(page, new RegExp(`${field}: settings\\.${field}`), `播种必须带上旧 ${field}`);
    }
  });

  // mod-home-drop-quick：快捷记录的独立写入路径已删除，SAVED_MARKER_KEY 只属于编辑页返回。
  test('B3-17（mod-home-drop-quick）首页无快捷记录写入路径；唯一新建入口 onNewTap 仍在', () => {
    for (const dead of ['QuickRecordBar', 'QuickRecordRow', 'quickBusy', 'submitQuickRecord', '快速记一条', '回车保存']) {
      assert.equal(INDEX.includes(dead), false, `SchedulePane.ets 不应再出现快捷记录痕迹：${dead}`);
    }
    assert.equal(INDEX.includes("Button('新建')"), true, '唯一新建入口必须仍在');
    assert.ok(INDEX.includes('private onNewTap(): void'), 'onNewTap 必须仍在');
  });
});
