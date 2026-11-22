// mod-sync-ui-silence / PHASE A — 日程面板「手动同步控件绝迹」守卫。
//
// 用户的诉求：用户只做必要配置，同步由软件静默处理；日程页那个点了没反应的「重试同步」必须消失。
// 本守卫刻意区分三种长得像的东西，避免「一刀切」把合法手势 / 状态文本也误删：
//   ① button  = 渲染树里的可点控件。本 pane 的真实写法是 ActionButton({ label:'…', onTap:… })，
//               也有 Text('…').onClick / Button('…') / LoadingState({title:'…', onAction:…})。
//               所以既查位置字面量，也查组件 prop 文案（label / text / title）。
//   ② gesture = Refresh({…}).onRefreshing(() => this.onPullRefresh())（不是按钮）；必须保留，
//               且**刻意不纳入 handler prop 名单**——它是合法同步触发，不是手动按钮。
//   ③ text    = Text(this.syncStatus.text)（只读状态行）；必须保留且不得挂 onClick。
//
// 扫描器先 mask 字符串 / 模板 / 注释 / 正则字面量（保留下标），再做括号配对与 handler 提取，
// 因此 `/a)b/` 里的 `)` 不会截断 body；调用识别覆盖 name( / ['name']( / 别名 / 裸引用。
// S6/S7 是**正对照自测**：用合成片段喂同一套扫描器，证明它能真的失败（不是空跑的守卫）。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { matchBrace, readEts, renderRegions, stripComments } from './helpers/etsSource.mjs';
import { requireOverlayRestored } from './guard.mjs';

requireOverlayRestored('syncUiSilence.test.mjs');

const PANE = stripComments(readEts('main/ets/pages/panes/SchedulePane.ets'));

/** 手动同步文案（用户明确不要的控制）。只匹配控件字面量，不匹配状态行里的动态文案。 */
const MANUAL_SYNC_WORDS = ['重试同步', '立即同步', '查看状态', '测试连接', '重试'];
/** 同步触发函数名：任何 UI handler 都不许直接或间接调用它们。 */
const SYNC_NAMES = ['retrySync', 'runConfiguredCycle', 'runOnce', 'triggerSync', 'pullOnStartup'];
const NAME_ALT = SYNC_NAMES.join('|');
/** 扫描的 handler prop：button 类动作；刻意**不含** `.onRefreshing`（下拉手势，合法）。 */
const HANDLER_MARKER =
  /\b(?:onClick\s*\(|onTap\s*:|onAction\s*:|onSubmit\s*:|onPress\s*:|onChange\s*:)/g;

/**
 * 把字符串 / 模板 / 行注释 / 块注释 / 正则字面量的内容替换成空格，保留长度与下标。
 * 正则判定用「前一个有效字符是 = ( [ { , : ; ! & | ? + - * ~ %」或关键字 return/case/… 的启发式；
 * 这样 `/a)b/` 的 `)` 对后续括号配对不可见，而 `a / b` 不会被误当正则。
 */
function maskLiterals(code) {
  const out = code.split('');
  const blank = (from, to) => {
    for (let i = from; i < to && i < out.length; i++) {
      if (out[i] !== '\n') {
        out[i] = ' ';
      }
    }
  };
  let i = 0;
  let prevSig = '';
  while (i < code.length) {
    const c = code[i];
    const n = code[i + 1];
    if (c === '/' && n === '/') {
      const start = i;
      i += 2;
      while (i < code.length && code[i] !== '\n') {
        i++;
      }
      blank(start, i);
      continue;
    }
    if (c === '/' && n === '*') {
      const start = i;
      i += 2;
      while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) {
        i++;
      }
      i = Math.min(i + 2, code.length);
      blank(start, i);
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const start = i;
      const quote = c;
      i++;
      while (i < code.length) {
        if (code[i] === '\\') {
          i += 2;
          continue;
        }
        if (code[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      blank(start, i);
      prevSig = ';';
      continue;
    }
    if (c === '/' && regexCanStart(prevSig, code, i)) {
      const start = i;
      i++;
      let inClass = false;
      while (i < code.length) {
        if (code[i] === '\\') {
          i += 2;
          continue;
        }
        if (code[i] === '[') {
          inClass = true;
        } else if (code[i] === ']') {
          inClass = false;
        } else if (code[i] === '/' && !inClass) {
          i++;
          break;
        } else if (code[i] === '\n') {
          break;
        }
        i++;
      }
      blank(start, i);
      prevSig = ';';
      continue;
    }
    if (!/\s/.test(c)) {
      prevSig = c;
    }
    i++;
  }
  return out.join('');
}

function regexCanStart(prevSig, code, at) {
  if (prevSig === '') {
    return true;
  }
  if ('=([{,:;!&|?+-*~%'.includes(prevSig)) {
    return true;
  }
  return /\b(?:return|case|throw|typeof|void|delete|instanceof|in|of|yield)\s*$/
    .test(code.slice(Math.max(0, at - 14), at));
}

/** 在已 mask 的源码里从 open 下标做括号配对，返回配对结束下标（exclusive）。 */
function matchBalanced(mask, start, open, close) {
  let depth = 0;
  for (let i = start; i < mask.length; i++) {
    if (mask[i] === open) {
      depth++;
    } else if (mask[i] === close) {
      depth--;
      if (depth === 0) {
        return i + 1;
      }
    }
  }
  return mask.length;
}

/** 取 `Name(...)[: ReturnType] { … }` 的区间；跳过调用点（后面不是 `{`）。 */
function memberBody(source, name) {
  const found = new RegExp(`\\b${name}\\s*\\([^)]*\\)\\s*(?::[^\\{]+)?\\{`).exec(source);
  assert.ok(found, `${name} body not found`);
  const open = source.indexOf('{', found.index);
  const [start, end] = matchBrace(source, open);
  return source.slice(start, end);
}

/** 所有 handler 区域（含 `onTap: this.retrySync` 这类无花括号的裸引用）。 */
function handlerRegions(code) {
  const mask = maskLiterals(code);
  const regions = [];
  const marker = new RegExp(HANDLER_MARKER.source, 'g');
  let matched;
  while ((matched = marker.exec(mask)) !== null) {
    const start = matched.index;
    const after = start + matched[0].length;
    let end;
    if (matched[0].endsWith('(')) {
      end = matchBalanced(mask, after - 1, '(', ')');
    } else {
      let open = -1;
      const limit = Math.min(mask.length, after + 240);
      for (let i = after; i < limit; i++) {
        if (mask[i] === '{') {
          open = i;
          break;
        }
        if (mask[i] === '}' || mask[i] === ',') {
          break;
        }
      }
      end = open >= 0 ? matchBalanced(mask, open, '{', '}') : Math.min(mask.length, after + 160);
    }
    regions.push(code.slice(start, end));
    marker.lastIndex = Math.max(end, after);
  }
  return regions;
}

/** 控件文案：位置字面量 + 组件 prop（label / text / title），均支持引号与模板串。 */
function controlLabels(code) {
  const labels = [];
  for (const m of code.matchAll(/(?:Text|Button)\(\s*(['"`])([^'"`]*?)\1\s*\)/g)) {
    labels.push(m[2]);
  }
  for (const m of code.matchAll(/\b(?:label|text|title)\s*:\s*(['"`])([^'"`]*?)\1/g)) {
    labels.push(m[2]);
  }
  return labels;
}

/** 直接 / 方括号 / void / 别名 / 裸引用五种同步调用形态。 */
function syncTriggered(region) {
  const direct = new RegExp(`\\b(?:${NAME_ALT})\\s*\\(`);
  const bracket = new RegExp(`\\[\\s*['"](?:${NAME_ALT})['"]\\s*\\]\\s*\\(`);
  const bareHandler =
    new RegExp(`\\bon(?:Click|Tap|Action|Submit|Press|Change)\\s*:\\s*(?:this\\.)?(?:${NAME_ALT})\\b`);
  if (direct.test(region) || bracket.test(region) || bareHandler.test(region)) {
    return true;
  }
  const aliasDecl =
    new RegExp(`\\b(?:const|let|var)\\s+(\\w+)\\s*=\\s*(?:this\\.)?(?:${NAME_ALT})\\b`, 'g');
  let matched;
  while ((matched = aliasDecl.exec(region)) !== null) {
    if (new RegExp(`\\b${matched[1]}\\s*\\(`).test(region)) {
      return true;
    }
  }
  return false;
}

test('S1 status row is read-only: text survives, no click handler / button', () => {
  const row = memberBody(PANE, 'SyncStatusRow');
  assert.match(row, /Text\(this\.syncStatus\.text\)/, '状态文本（唯一诚实状态面）必须保留');
  assert.match(row, /this\.syncStatus\.state === 'failed'/, '失败态着色必须保留');
  assert.doesNotMatch(row, /\.onClick\s*\(/, '状态行不得挂点击 handler');
  assert.doesNotMatch(row, /\bButton\s*\(/, '状态行不得是按钮');
  for (const word of MANUAL_SYNC_WORDS) {
    assert.doesNotMatch(row, new RegExp(word), `只读状态行不得出现 ${word}`);
  }
});

/** S2 的实际判定体（同时供 S2 与 S8 变异自测调用，保证正对照走的是同一套代码）。 */
function assertNoManualControl(source) {
  const regions = renderRegions(source);
  assert.ok(regions.length > 0, 'render regions not found');
  for (const [start, end] of regions) {
    const region = source.slice(start, end);
    // ① button：位置字面量 + ActionButton/LoadingState/EmptyState 的 prop 文案。
    for (const label of controlLabels(region)) {
      assert.equal(label.includes('重试'), false, `渲染树里仍有「重试」类按钮文案「${label}」`);
      for (const word of MANUAL_SYNC_WORDS) {
        assert.equal(label.includes(word), false, `渲染树里仍有手动同步控件文案「${label}」`);
      }
    }
    // ② gesture：Refresh 手势不是按钮，允许且必须存在（且不在 S3 的 handler prop 名单里）。
    if (/Refresh\(\{\s*refreshing:/.test(region)) {
      assert.doesNotMatch(region, /Refresh\([\s\S]{0,120}\.onClick\s*\(/, '下拉手势不得伪装成按钮');
    }
  }
}

/** S3 的实际判定体（同时供 S3 与 S8 变异自测调用）。 */
function assertNoSyncHandler(source) {
  const handlers = handlerRegions(source);
  assert.ok(handlers.length >= 10, `pane has many legitimate handlers (sanity; got ${handlers.length})`);
  for (const body of handlers) {
    assert.equal(syncTriggered(body), false,
      `UI handler 不得直接 / 间接触发同步：${body.slice(0, 140)}`);
  }
  // 能力保留：方法仍在，但面板里没有调用点（支持 / 诊断可复用，用户点不到）。
  assert.match(source, /private async retrySync\(\): Promise<void> \{/, 'retrySync 能力必须保留给支持');
  assert.doesNotMatch(source, /this\.retrySync\(\)/, 'retrySync 不得由任何 UI handler 调用');
}

test('S2 no manual sync control anywhere in the pane render tree (button vs gesture vs text)', () => {
  assertNoManualControl(PANE);
});

test('S3 no sync trigger is reachable from any UI handler prop', () => {
  assertNoSyncHandler(PANE);
});

test('S4 gesture and both status-row render sites survive (guard is not over-broad)', () => {
  const compact = memberBody(PANE, 'CompactBody');
  const wide = memberBody(PANE, 'WideBody');
  const shared = memberBody(PANE, 'RefreshableList');
  for (const [name, body] of [['CompactBody', compact], ['WideBody', wide]]) {
    assert.match(body, /this\.SyncStatusRow\(\)/, `${name} 仍渲染唯一状态行`);
  }
  assert.match(shared, /Refresh\(\{\s*refreshing: \$\$this\.refreshing\s*\}/, '下拉刷新手势必须保留');
  assert.match(shared, /this\.onPullRefresh\(\)/, '下拉仍复用同一 handler');
  const pull = memberBody(PANE, 'onPullRefresh');
  assert.equal((pull.match(/globalRefreshCoordinator\.runOnce\(\{/g) || []).length, 1,
    '面板下拉只有一处单飞协调器入口');
  assert.match(pull, /syncProtocolStore\.runConfiguredCycle\(\)/, '手势走既有唯一周期，不是第二份实现');
});

test('S5 trigger label reaches the log exactly once per attempt, with no payload', () => {
  const LINE = "console.info('[sync-trigger] pull');";
  const pull = memberBody(PANE, 'onPullRefresh');
  // 日志在 runCycle 注入里：协调器只对 leader 执行一次 runCycle ⇒ 一次尝试恰好一行。
  const runCycle = pull.slice(pull.indexOf('runCycle:'), pull.indexOf('reloadSchedule:'));
  assert.ok(runCycle.length > 0, 'runCycle callback not found');
  assert.equal((runCycle.split(LINE).length - 1), 1, '每次尝试恰好一条 [sync-trigger] pull');
  assert.equal((PANE.split(LINE).length - 1), 1, '整份面板里该触发日志只有一处定义');
  assert.doesNotMatch(LINE, /\$\{|token|secret|password|repoUrl|hilog/i, '日志行无插值 / 无凭据 / 用 console 不用 hilog');
  // 凭据卫生的受限文件集（pages/Settings / GitSyncService / settingsStore / scheduleStore /
  // deepseek / model/types）不含本面板；这里再钉一次它们没有同名日志，避免有人把日志搬过去。
  const restricted = [
    'main/ets/pages/Settings.ets',
    'main/ets/services/GitSyncService.ets',
    'main/ets/services/settingsStore.ets',
    'main/ets/services/scheduleStore.ets',
    'main/ets/services/deepseek.ets',
    'main/ets/model/types.ts'
  ];
  for (const rel of restricted) {
    assert.doesNotMatch(readFileSync(join(fileURLToPath(new URL('../../entry/src/', import.meta.url)), rel), 'utf8'),
      /\[sync-trigger\]/, `${rel} 属凭据卫生受限文件，不得加同步触发日志`);
  }
});

// --------------------------- 正对照自测（守卫必须能失败） ---------------------------

test('S6 self-test: S2 label scan flags the pane-native ActionButton idiom', () => {
  const probe = "ActionButton({ label: '重试同步', onTap: (): void => { this.retrySync(); } })";
  const labels = controlLabels(probe);
  assert.deepEqual(labels, ['重试同步'], 'component-prop label must be seen');
  assert.ok(labels.some((label) => MANUAL_SYNC_WORDS.some((word) => label.includes(word))),
    'positive control: a real retry control must be flagged by S2');
  const benign = controlLabels("ActionButton({ label: '新建', onTap: (): void => { this.openNew(); } })");
  assert.equal(benign.some((label) => MANUAL_SYNC_WORDS.some((word) => label.includes(word))), false,
    'negative control: a normal action label must not be flagged');
});

test('S7 self-test: S3 scanner survives a regex literal with ) and catches indirect calls', () => {
  // ① 正则字面量里的 `)` 不得截断 handler body（mask 后仍能看见后面的语句）。
  const regexProbe = "Button().onClick(() => { const r = /a)b/; console.info('tail'); })";
  const [regexBody] = handlerRegions(regexProbe);
  assert.ok(regexBody.includes("console.info('tail')"), 'regex-literal ) must not truncate the body');
  assert.equal(syncTriggered(regexBody), false, 'regex literal alone is not a sync trigger');

  // ② 同一套扫描器必须抓到方括号调用、别名调用、void 调用与裸 handler 引用。
  for (const probe of [
    "Button().onClick(() => { this['retrySync'](); })",
    "ActionButton({ label: 'x', onTap: (): void => { const f = this.runConfiguredCycle; void f(); } })",
    "ActionButton({ label: 'x', onTap: (): void => { void this.retrySync(); } })",
    "ActionButton({ label: 'x', onTap: this.retrySync })"
  ]) {
    const bodies = handlerRegions(probe);
    assert.ok(bodies.length > 0, `handler not found in probe: ${probe}`);
    assert.equal(syncTriggered(bodies[0]), true, `positive control must be flagged: ${probe}`);
  }
  // ③ 负对照：普通 handler（含正则与字符串里的 `)`）不得误报。
  const benign = "ActionButton({ label: '今天', onTap: (): void => { this.goToday(); } })";
  assert.equal(syncTriggered(handlerRegions(benign)[0]), false, 'benign handler must pass');
});

test('S8 self-test: the REAL guard assertions fail on a mutated pane (not just synthetic probes)', () => {
  // 把用户不想要的控件按本 pane 的真实写法注入到一个真实 render region 里。
  const mutated = PANE.replace(
    'this.SyncStatusRow()',
    "ActionButton({ label: '重试同步', onTap: (): void => { this['retrySync'](); } })\n      this.SyncStatusRow()"
  );
  assert.notEqual(mutated, PANE, 'mutation must actually apply');
  assert.throws(() => assertNoManualControl(mutated), /重试同步/,
    'S2 must fail on the pane-native ActionButton regression');
  assert.throws(() => assertNoSyncHandler(mutated),
    /retrySync/, 'S3 must fail on the bracket-call / onTap regression');
  // 负对照：未变异的真面板仍然通过这两条断言。
  assertNoManualControl(PANE);
  assertNoSyncHandler(PANE);
});
