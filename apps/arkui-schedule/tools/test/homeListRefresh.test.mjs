// 新建后即时可见（mod-home-list-instant-refresh）回归守卫。
//
// 用户反馈（安装版 1000006）：新建日程不会立即出现在「当日全部日程」，必须先点「未完成」
// 再点回来。根因是 shell 路由下 Home 才是 @Entry 页，日程面板是保活 @Component，框架不会
// 调用它的 onPageShow()；一次性「保存返回」标记没人消费，只有切 tab 的 onTap 调 reload()，
// 顺带把列表重算出来。修复 = Home.onPageShow 推进 showTick → 面板 @Watch 复用原 onPageShow
// 入口 → reload() 重读 v2 时间线 → refreshQuery() 按当前 filter 重算 visibleRecords。
//
// 本文件分两部分：
//   A. 源码形状静态断言（.ets 在 Node 里跑不起来，只能钉「链路存在且顺序正确」）；
//   B. 纯逻辑单测（编译后的 model/query.js，真正验证「records 变了、filter 不变 → visible 跟着变」）。
// 前置：node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { describe, test } from 'node:test';
import { matchBrace, stripComments } from './helpers/etsSource.mjs';

// query.ts 运行时依赖 ./undoDelete（tsc 输出的 import 不带 `.js`），补后缀解析（与 query.test.mjs 同款）。
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (
        error !== null &&
        typeof error === 'object' &&
        error.code === 'ERR_MODULE_NOT_FOUND' &&
        specifier.startsWith('.') &&
        !specifier.endsWith('.js')
      ) {
        return nextResolve(`${specifier}.js`, context);
      }
      throw error;
    }
  }
});

const ETS = new URL('../../entry/src/main/ets/', import.meta.url);
const HOME = stripComments(readFileSync(new URL('pages/Home.ets', ETS), 'utf8'));
const PANE = stripComments(readFileSync(new URL('pages/panes/SchedulePane.ets', ETS), 'utf8'));
const INDEX = stripComments(readFileSync(new URL('pages/Index.ets', ETS), 'utf8'));

/** 取方法签名后那对花括号的内部文本（与 b3Batch.bodyFrom 同口径）。 */
function bodyOf(source, signature) {
  const at = source.indexOf(signature);
  assert.notEqual(at, -1, `找不到方法：${signature}`);
  const brace = source.indexOf('{', at);
  assert.notEqual(brace, -1, `${signature} 没有起始花括号`);
  const [start, end] = matchBrace(source, brace);
  return source.slice(start + 1, end - 1);
}

/** 先判存在再比较顺序，避免 indexOf=-1 造成「假通过」。 */
function assertOrdered(text, tokens, label) {
  let previous = -1;
  for (const token of tokens) {
    const index = text.indexOf(token);
    assert.ok(index >= 0, `${label}：找不到 ${token}`);
    assert.ok(index > previous, `${label}：${token} 顺序不对`);
    previous = index;
  }
}

const HOME_ON_SHOW = bodyOf(HOME, 'onPageShow(): void');
const PANE_WATCHER = bodyOf(PANE, 'onShowTick(): void');
const PANE_ON_SHOW = bodyOf(PANE, 'onPageShow(): void');
const PANE_READY = bodyOf(PANE_ON_SHOW, 'if (this.ready) {');
const PANE_RELOAD = bodyOf(PANE, 'private reload(): void');
const PANE_REFRESH = bodyOf(PANE, 'private refreshQuery(): void');
const INDEX_ON_SHOW = bodyOf(INDEX, 'onPageShow(): void');
const INDEX_RELOAD = bodyOf(INDEX, 'private reload(): void');
const INDEX_REFRESH = bodyOf(INDEX, 'private refreshQuery(): void');

// 纯逻辑：query.ts 零 SDK import，编译产物可直接 import。
const { applyQuery, makeFilter } = await import('../.build/model/query.js');

describe('新建后即时可见：shell 的 show → reload → re-derive 链路（源码形状）', () => {
  test('HLR-01 Home 是 show 信号唯一生产者：onPageShow 只推进一个 @State tick，无定时器', () => {
    assert.match(HOME, /@State scheduleShowTick: number = 0;/, 'Home 必须持有单调递增的 show tick');
    assert.match(HOME_ON_SHOW, /this\.scheduleShowTick = this\.scheduleShowTick \+ 1;/,
      'onPageShow 必须推进 tick（唯一语句级要求，不替面板读盘）');
    assert.equal(/setInterval|setTimeout|requestAnimationFrame/.test(HOME_ON_SHOW), false,
      'show 信号只能来自页面生命周期，不得用定时器 / 轮询伪造');
    assert.equal((HOME.match(/onPageShow\(\): void/g) ?? []).length, 1, 'Home 只能有一个 onPageShow');
  });

  test('HLR-02 show tick 只传给日程面板一处：装配点逐字钉死', () => {
    assert.equal((HOME.match(/showTick: this\.scheduleShowTick/g) ?? []).length, 1,
      'showTick 只能装配给 SchedulePane 一次');
    const callAt = HOME.indexOf('SchedulePane({');
    assert.ok(callAt >= 0, 'Home 必须装配 SchedulePane');
    const call = HOME.slice(callAt, HOME.indexOf('})', callAt) + 2);
    assert.match(call, /showTick: this\.scheduleShowTick/, 'SchedulePane 必须收到 show tick');
    assert.match(call, /active: this\.section === SHELL_SECTION_SCHEDULE/, '保活 prop 不变');
  });

  test('HLR-03 面板用 @Watch 接住 show 信号并复用原 onPageShow（不另造刷新逻辑）', () => {
    assert.match(PANE, /@Prop @Watch\('onShowTick'\) showTick: number = 0;/,
      '日程面板必须声明 @Watch 的 showTick prop');
    assert.match(PANE_WATCHER, /this\.onPageShow\(\);/, 'watcher 必须复用原保存返回入口');
    assert.equal(/setInterval|setTimeout/.test(PANE_WATCHER), false, 'watcher 不得引入定时器');
    assert.equal((PANE.match(/onShowTick\(\): void/g) ?? []).length, 1, 'watch 回调只有一处');
  });

  test('HLR-04 保存返回分支仍是「先 consume 标记 → 再 reload → 单行对账」', () => {
    assertOrdered(PANE_READY, ['this.consumeSavedMarker()', 'this.reload()'], 'SchedulePane.onPageShow.ready');
    assert.match(PANE_ON_SHOW, /this\.reconcileSavedRow\(saved\);/, '保存行对账必须保留');
    assert.match(PANE, /AppStorage\.setOrCreate<string>\(SAVED_MARKER_KEY, ''\)/, '标记仍读后即清');
  });

  test('HLR-05 reload 重读 v2 时间线后重算 visible：derive 是唯一列表数据源', () => {
    assert.match(PANE_RELOAD, /timelineStore\.readDay\(this\.selectedDate\)/, '今日 tab 必须重读时间线');
    assert.match(PANE_RELOAD, /this\.refreshQuery\(\);/, 'reload 必须触发 derive');
    assert.match(PANE_REFRESH, /this\.visibleRecords = applyQuery\(this\.records, filter\);/,
      'visibleRecords 必须由当前 records + 当前 filter 派生');
    assert.match(PANE, /ForEach\(\s*this\.visibleRecords/, '列表渲染的必须是派生后的 visibleRecords');
    // 旧 bug 形状：只有切 tab 才 reload。现在 show 链路也在，故切 tab 的 onTap 可以保留，
    // 但必须另有来自 Home tick 的非筛选触发源（HLR-01..03 已钉）。
    assert.match(PANE, /label: '未完成'[\s\S]{0,400}this\.reload\(\)/, '切 tab 仍照旧 reload（语义不变）');
  });
});

describe('fallback 路由与纯派生：同一条 write → reload → re-derive 链', () => {
  test('HLR-06 fallback Index 自带 onPageShow → consume → reload → refreshQuery（本就已具备）', () => {
    assertOrdered(INDEX_ON_SHOW, ['this.consumeSavedMarker()', 'this.reload()'], 'Index.onPageShow.ready');
    assert.match(INDEX_RELOAD, /timelineStore\.readDay\(this\.selectedDate\)/, 'fallback 今日 tab 重读时间线');
    assert.match(INDEX_RELOAD, /this\.refreshQuery\(\);/, 'fallback reload 也重算 derive');
    assert.match(INDEX_REFRESH, /this\.visibleRecords = applyQuery\(this\.records, filter\);/,
      'fallback 的 derive 口径与面板一致');
  });

  function rec(id, title, extra = {}) {
    return {
      id,
      ts: `2026-11-22T09:00:00+08:00`,
      title,
      body: '',
      author: '我',
      done: false,
      ai_processed: false,
      ...extra
    };
  }

  test('HLR-07 records 增加、filter 不变 → 新记录立刻进 visible（无需切筛选）', () => {
    const before = [rec('old-1', '周会讨论排期')];
    const filter = makeFilter('周会', 'all', '我');
    const visibleBefore = applyQuery(before, filter);
    assert.equal(visibleBefore.length, 1, '变更前可见集应先有一条');

    const created = rec('new-1', '周会纪要归档');
    const after = before.concat([created]);
    const visibleAfter = applyQuery(after, filter);

    assert.equal(visibleAfter.length, 2, '新记录必须在同一 filter 下立即可见');
    assert.ok(visibleAfter.some((item) => item.id === 'new-1'), 'visible 必须包含新建记录');
    assert.deepEqual(filter, makeFilter('周会', 'all', '我'), 'filter 本身未被改动');
    assert.equal(before.length, 1, 'applyQuery 不得原地改 records');
  });

  test('HLR-08 筛选语义逐字不变：关键词 / 作者 / 状态 / 墓碑仍按原口径过滤', () => {
    const records = [
      rec('a', '周会排期', { author: '我' }),
      rec('b', ' unrelated ', { author: '别人' }),
      rec('c', '已完成事项', { done: true, author: '我' }),
      rec('d', '周会已删', { deleted: true, author: '我' })
    ];
    assert.deepEqual(applyQuery(records, makeFilter('', 'all', '')).map((r) => r.id), ['a', 'b', 'c'],
      'all：全部可见记录（排除墓碑）');
    assert.deepEqual(applyQuery(records, makeFilter('', 'open', '')).map((r) => r.id), ['a', 'b'],
      'open：只看未完成');
    assert.deepEqual(applyQuery(records, makeFilter('', 'done', '')).map((r) => r.id), ['c'],
      'done：只看已完成');
    assert.deepEqual(applyQuery(records, makeFilter('', 'all', '我')).map((r) => r.id), ['a', 'c'],
      '作者精确匹配');
    assert.deepEqual(applyQuery(records, makeFilter('周会', 'all', '我')).map((r) => r.id), ['a'],
      '关键词 AND 作者，墓碑不出现');
  });
});
