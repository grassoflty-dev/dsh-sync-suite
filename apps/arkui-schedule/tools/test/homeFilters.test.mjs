// mod-home-filters / mod-home-filters-2：首页筛选控件收敛的源码级契约。
// 最终控制集 = 恰好 2 个 tab（当日全部日程 / 未完成），没有完成状态开关：
// - 当日全部日程 tab 显示当天**全部**记录（已完成 + 未完成，行上勾选只是状态指示，不参与过滤），
//   计数 = 当天记录总数（tab 全量），排序规则不变；
// - 未完成 tab 保留跨日未完成取数与「先日期、再 ts」排序，计数 = 未完成条数。
//
// ArkTS（.ets）依赖 @kit.ArkUI，Node 里跑不起来；沿用 b4DateUi.test.mjs / indexHeader.test.mjs 的
// stripComments + bodyFrom 风格，只钉「能在源码里逐字复核」的事实：状态默认值、tab 取数、
// 排序键、计数来源、空态文案，以及旧控件名 / 开关在 UI、测试与工具源码里彻底消失。
// 被删控件名按字符拼出来，避免本测试文件自身被下面的「旧标签消失」扫描命中。
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, test } from 'node:test';

const HERE = new URL('./', import.meta.url);
// S3：日程契约锚点从 fallback 路由 pages/Index.ets 移到真 body 所在的日程面板。
const INDEX_PATH = new URL('../../entry/src/main/ets/pages/panes/SchedulePane.ets', import.meta.url);
const QUERY_PATH = new URL('../../entry/src/main/ets/model/query.ts', import.meta.url);
const TIMELINE_PATH = new URL('../../entry/src/main/ets/services/timelineStore.ets', import.meta.url);
const DEVICE_ACCEPT_PATH = new URL('../device-accept.mjs', import.meta.url);
const QA_TABLE_PATH = new URL('../qa-table-markdown.mjs', import.meta.url);
const TEST_DIR = new URL('./', import.meta.url);

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

const INDEX_RAW = readFileSync(INDEX_PATH, 'utf8');
const INDEX = stripComments(INDEX_RAW);
const RELOAD = bodyFrom(INDEX, 'private reload()');
const REFRESH_QUERY = bodyFrom(INDEX, 'private refreshQuery()');
const PENDING_SORTED = bodyFrom(INDEX, 'private pendingSorted()');
const TODAY_COUNT_TEXT = bodyFrom(INDEX, 'private todayCountText(');
const EMPTY_COPY = bodyFrom(INDEX, 'private emptyCopy()');
const MODE_TABS = bodyFrom(INDEX, '\n  ModeTabs() {');
const SEARCH_BAR = bodyFrom(INDEX, '\n  SearchFilterBar() {');
const TAB_EMPTY = bodyFrom(INDEX, '\n  TabEmpty() {');
const RECORD_LIST = bodyFrom(INDEX, '\n  RecordList() {');
const LIST_ROWS = bodyFrom(INDEX, '\n  ListRows() {');

// 被删控件名按字符拼出来，避免本测试文件自身被扫描命中。
const QUOTE = String.fromCharCode(39);
const ALL = '全' + '部';
const DONE = '已' + '完' + '成';
const PENDING = '未' + '完' + '成';
const REMOVED_LABELS = [ALL + PENDING, QUOTE + DONE + QUOTE, QUOTE + ALL + QUOTE];
const TODAY_TODO = '今' + '日' + '待' + '办';
// 已删的开关 / 状态 / 回调名同样拼接，保证仓库里不再出现这些字面量。
const SHOW_DONE = 'show' + 'Done';
const ON_SHOW_DONE_CHANGE = 'on' + SHOW_DONE + 'Change';
const TOGGLE_LABEL = '显' + '示' + DONE;

describe('mod-home-filters-2 · 控制集恰好两 tab，开关彻底删除', () => {
  test('默认状态：仅 tab=today；旧跨日状态 / 状态片 / 完成状态开关状态均已删', () => {
    assert.match(INDEX, /type HomeTab = 'today' \| 'pending';/);
    assert.match(INDEX, /@State tab: HomeTab = 'today';/);
    assert.equal(INDEX.includes('showAllPending'), false, '旧 tab 状态名及其所有引用必须删除');
    assert.equal(INDEX.includes('@State statusFilter'), false, '旧状态 chip 字符串状态必须删除');
    assert.equal(INDEX.includes('@State ' + SHOW_DONE), false, '开关 @State 必须删除');
  });

  test('tab 文案恰好两项「当日全部日程 / 未完成」，两段各自的主次态绑定正确', () => {
    const labels = [...MODE_TABS.matchAll(/label: '([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(labels, ['当日全部日程', '未完成'], `tab 文案应为两项，实际 ${JSON.stringify(labels)}`);
    assert.ok(MODE_TABS.includes("this.tab === 'today' ? 'primary' : 'ghost'"));
    assert.ok(MODE_TABS.includes("this.tab === 'pending' ? 'primary' : 'ghost'"));
  });

  // mod-home-drop-quick：快捷记录行整条删除后的正向守卫（替代已删除的 quickRecordUi.test.mjs 跨文件断言）。
  test('首页没有快捷记录行：组件 / builder / 在途状态 / 提示文案均已删除', () => {
    const source = readFileSync(INDEX_PATH, 'utf8');
    for (const dead of ['QuickRecordBar', 'QuickRecordRow', 'quickBusy', 'submitQuickRecord',
      'defaultAuthorOrMe', '快速记一条', '回车保存', '已记下']) {
      assert.equal(source.includes(dead), false, `SchedulePane.ets 不应再出现快捷记录痕迹：${dead}`);
    }
    assert.ok(INDEX.includes("Button('新建')"), '唯一创建入口「新建」必须仍在');
  });

  test('没有完成状态开关：无 Toggle / 文案 / @State / 回调', () => {
    assert.equal(MODE_TABS.includes('Toggle('), false, 'ModeTabs 不应渲染任何开关');
    assert.equal(INDEX.includes('ToggleType.Switch'), false, '首页不应残留 Toggle 类型');
    assert.equal(INDEX_RAW.includes(TOGGLE_LABEL), false, '开关文案必须逐字删除');
    assert.equal(INDEX.includes(SHOW_DONE), false, '开关状态名必须逐字删除');
    assert.equal(INDEX.includes(ON_SHOW_DONE_CHANGE), false, '开关回调必须逐字删除');
  });

  test('状态 chip 的 builder / handler / makeFilter 状态入参全部删除，搜索与作者筛选保留', () => {
    assert.equal(INDEX.includes('StatusChip('), false);
    assert.equal(INDEX.includes('pickStatus('), false);
    assert.ok(INDEX.includes("makeFilter(this.queryText, 'all', this.authorFilter)"));
    assert.ok(SEARCH_BAR.includes('TextInput({ text: this.queryText'));
    assert.ok(REFRESH_QUERY.includes('authorsOf(this.records)'));
    assert.ok(SEARCH_BAR.includes('this.pickAuthor(author)'));
    assert.ok(SEARCH_BAR.includes('this.resetFilters()'));
  });

  test('首页 UI 源码不含被删控件名（旧状态 chip / 旧跨日 tab / 开关文案）', () => {
    for (const label of [...REMOVED_LABELS, TOGGLE_LABEL]) {
      assert.equal(INDEX_RAW.includes(label), false, `SchedulePane.ets 不应再出现被删控件名 ${label}`);
    }
    assert.equal(INDEX_RAW.includes(TODAY_TODO), false, '旧「今日待办」按钮名必须删除');
    assert.equal(INDEX.includes("this.StatusChip('"), false);
  });

  test('页头标题与换日期路径跟随新 tab 名', () => {
    assert.ok(INDEX.includes("return '未完成';"));
    assert.ok(INDEX.includes("this.tab = 'today';"));
    for (const method of ['shiftDate', 'goToday', 'pickDate']) {
      assert.ok(bodyFrom(INDEX, `private ${method}(`).includes("this.tab = 'today';"), `${method} 应回到今日 tab`);
    }
  });
});

describe('mod-home-filters-2 · tab 取数、排序与今日全量', () => {
  test('reload：未完成 tab 走 pendingSorted，今日 tab 走 readDay（所选日期全部记录）', () => {
    assert.ok(RELOAD.includes("this.tab === 'pending'"));
    assert.ok(RELOAD.includes('this.pendingSorted()'));
    assert.ok(RELOAD.includes('timelineStore.readDay(this.selectedDate)'));
    assert.equal(RELOAD.includes('openIndexStore'), false, 'v2-only：不碰 v1 索引');
  });

  test('今日 tab 列出已完成 + 未完成：不做完成状态过滤，行上勾选只是展示', () => {
    assert.ok(REFRESH_QUERY.includes('applyQuery(this.records, filter)'),
      'tab 全量直接进 applyQuery，不再按 done 裁可见列表');
    assert.equal(REFRESH_QUERY.includes('record.done !== true'), false, '今日不得按完成状态过滤');
    assert.equal(REFRESH_QUERY.includes('.filter('), false, '可见范围不得额外裁剪 records');
    assert.equal(REFRESH_QUERY.includes(SHOW_DONE), false);
    assert.ok(LIST_ROWS.includes('this.visibleRecords'), '列表渲染过滤后的 tab 全量');
    assert.ok(LIST_ROWS.includes('RecordRow({'));
    assert.ok(LIST_ROWS.includes('record: item'));
    assert.ok(LIST_ROWS.includes('onToggle:'), '逐行勾选完成仍保留（只改变记录状态）');
  });

  test('pendingSorted：先按日期（ts 前 10 位）再按 ts 排序，且不改动 store 返回值', () => {
    assert.ok(PENDING_SORTED.includes('timelineStore.pendingRecords()'));
    assert.ok(PENDING_SORTED.includes('.slice()'));
    const dateAt = PENDING_SORTED.indexOf('left.ts.slice(0, 10)');
    const rightDateAt = PENDING_SORTED.indexOf('right.ts.slice(0, 10)');
    const tsAt = PENDING_SORTED.indexOf('left.ts === right.ts');
    assert.ok(dateAt >= 0 && rightDateAt > dateAt, '必须有日期键比较');
    assert.ok(tsAt > rightDateAt, '同一天才比 ts：日期比较必须写在 ts 比较之前');
    assert.ok(PENDING_SORTED.includes('left.ts < right.ts'));
  });

  test('服务层仍是唯一的跨日未完成取数口（读 closed_at 派生）', () => {
    const service = readFileSync(TIMELINE_PATH, 'utf8');
    assert.ok(service.includes('pendingRecords(): ScheduleRecord[]'));
    assert.ok(service.includes('openRecords(loaded.day'));
  });

  test('query.ts 不再宣称与完成状态开关正交（开关已删除）', () => {
    const query = readFileSync(QUERY_PATH, 'utf8');
    assert.equal(query.includes(TOGGLE_LABEL), false);
    assert.ok(query.includes('完成状态不做过滤'));
  });
});

describe('mod-home-filters-2 · 计数、空态与不变量', () => {
  test('今日计数 = 当天记录总数（tab 全量），不是未完成数、不是可见列表长度', () => {
    assert.ok(RELOAD.includes('this.statusText = this.todayCountText();'), 'reload 今日分支走统一计数文案');
    assert.ok(TODAY_COUNT_TEXT.includes('`当日全部日程 ${this.records.length} 条（v2 时间线，自动同步）`'),
      '当日全部日程 N 条 = 当天记录总数');
    assert.equal(TODAY_COUNT_TEXT.includes('pendingCountOf'), false, '不再按未完成数计数');
    assert.equal(TODAY_COUNT_TEXT.includes('visibleRecords.length'), false, '计数不取被过滤的可见列表');
  });

  test('无任何「共 M 条」后缀：今日与未完成副标题都不含「共」', () => {
    assert.equal(TODAY_COUNT_TEXT.includes('共'), false, '今日副标题无「共 M 条」');
    assert.ok(RELOAD.includes('`未完成 ${this.records.length} 条（v2 时间线，自动同步）`'),
      '未完成 tab 副标题 = 未完成 N 条');
    assert.equal(RELOAD.includes('条未完成'), false, '旧「共 N 条未完成」句式已删');
    assert.equal(INDEX.includes('· 共 '), false, '首页所有副标题都无「· 共 M 条」后缀');
  });

  test('空态文案：今日 → 今天还没有日程；未完成 → 没有未完成的日程；旧文案已删', () => {
    assert.ok(EMPTY_COPY.includes("this.tab === 'pending' ? '没有未完成的日程' : '今天还没有日程'"));
    assert.ok(TAB_EMPTY.includes("Text('没有未完成的日程')"));
    assert.equal(TAB_EMPTY.includes('this.records.length > 0'), false, '今日不再有「全已完成所以列表空」的空态');
    assert.ok(INDEX.includes("Text('✨ 今日汇总')"));
    assert.ok(INDEX.includes("Text('今天还没有日程')"), '今日汇总块的今日空态灰字保留');
    assert.ok(RECORD_LIST.includes('this.TabEmpty()'));
    assert.ok(RECORD_LIST.includes('this.EmptyResults()'));
    assert.equal(INDEX.includes('所有日程都已完成'), false);
    assert.equal(INDEX.includes('这一天还没有日程'), false);
  });

  // mod-home-entries retarget → S3 retarget：本条原先钉「汇总 / 列表 / 撤销 / 主操作」的渲染位置，
  // 双格条新增后补钉它在主操作之上；S3 把两条对话入口删掉（外壳导航轨取代），
  // 旧的位置断言改成「双格条绝迹 + 加权列表区直接接唯一主操作」——覆盖不降反升。
  test('今日汇总块 / 撤销条 / 两个断点的渲染位置未被本模块改动（双格条已由导航轨取代）', () => {
    for (const builderName of ['CompactBody', 'WideBody']) {
      const body = bodyFrom(INDEX, `\n  ${builderName}() {`);
      for (const piece of ['this.ModeTabs()', 'this.SearchFilterBar()', 'this.RecordList()', 'this.UndoBar()']) {
        assert.ok(body.includes(piece), `${builderName} 仍须渲染 ${piece}`);
      }
      assert.ok(body.includes('this.SummaryCard()'), `${builderName} 仍须渲染今日汇总块`);
      assert.ok(body.includes("if (this.tab === 'today') {"), `${builderName} 的汇总块必须按新 tab 名门控`);
      assert.equal(body.includes('this.ChatEntries()'), false, `${builderName} 不得再渲染对话双格条（导航轨取代）`);
      const action = builderName === 'CompactBody' ? 'this.PrimaryAction()' : 'this.SidebarAction()';
      const actionAt = body.indexOf(action);
      const listAt = body.indexOf('.layoutWeight(1)');
      assert.ok(listAt >= 0 && actionAt > listAt, `${builderName} 的主操作 ${action} 必须落在加权列表区之后`);
    }
    assert.ok(INDEX.includes('this.UndoBar()'));
    assert.ok(!/^\s*ChatEntries\(/m.test(INDEX), '日程面板不得再声明 ChatEntries builder');
  });
});

describe('mod-home-filters-2 · 测试与工具里没有旧控件名', () => {
  test('retarget 过的测试文件不含旧状态名、旧控件名或已删开关名', () => {
    const files = [
      'b3Batch.test.mjs', 'timelineService.test.mjs', 'uiTokens.test.mjs',
      'b4CalendarWiring.test.mjs', 'openIndex.test.mjs', 'query.test.mjs'
    ];
    for (const name of files) {
      const text = readFileSync(new URL(name, HERE), 'utf8');
      assert.equal(text.includes('showAllPending'), false, `${name} 仍引用旧状态名`);
      assert.equal(text.includes('statusFilter'), false, `${name} 仍引用旧状态名`);
      assert.equal(text.includes(SHOW_DONE), false, `${name} 仍引用已删开关状态名`);
      assert.equal(text.includes(ON_SHOW_DONE_CHANGE), false, `${name} 仍引用已删开关回调`);
      for (const label of [...REMOVED_LABELS, TOGGLE_LABEL]) {
        assert.equal(text.includes(label), false, `${name} 仍引用被删控件名 ${label}`);
      }
    }
  });

  test('工具源码不含旧控件名：设备验收 / QA 表格都不残留死掉的「' + TODAY_TODO + '」fallback', () => {
    const deviceAccept = readFileSync(DEVICE_ACCEPT_PATH, 'utf8');
    assert.ok(deviceAccept.includes("byText(flat, '未完成')"));
    assert.ok(deviceAccept.includes("pass('未完成·索引'"));
    for (const path of [DEVICE_ACCEPT_PATH, QA_TABLE_PATH]) {
      const tool = readFileSync(path, 'utf8');
      assert.equal(tool.includes(TODAY_TODO), false, `${path.pathname} 仍残留旧「${TODAY_TODO}」fallback 标签`);
      for (const label of [...REMOVED_LABELS, TOGGLE_LABEL]) {
        assert.equal(tool.includes(label), false, `${path.pathname} 仍引用被删控件名 ${label}`);
      }
    }
    // 仍容忍编辑器/详情里逐条的「已完成 / 未完成」状态文案：本守卫只禁带引号的旧状态片与旧 tab 名。
  });

  test('测试目录存在且本文件被 node --test 收拢（无新增依赖）', () => {
    const names = readdirSync(TEST_DIR).filter((n) => n.endsWith('.test.mjs'));
    assert.ok(names.includes('homeFilters.test.mjs'));
  });
});
