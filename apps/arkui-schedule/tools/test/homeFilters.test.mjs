// mod-home-filters：首页筛选控件从 5 个（今日待办/全部未完成 + 全部/未完成/已完成）
// 收敛为 2 个 tab（今日 / 未完成）+ 1 个开关（显示已完成，默认关）的源码级契约。
//
// ArkTS（.ets）依赖 @kit.ArkUI，Node 里跑不起来；这里沿用 quickRecordUi.test.mjs 的
// stripComments + bodyFrom 风格，只钉「能在源码里逐字复核」的事实：状态默认值、tab 取数、
// 排序键、开关作用域、计数来源、空态文案，以及旧控件名在 UI/测试源码里彻底消失。
// 不是覆盖削弱：旧 5 控件的行为被逐条映射到新的 3 控件（见 docs/UI-DESIGN.md 的映射表）。
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, test } from 'node:test';

const HERE = new URL('./', import.meta.url);
const INDEX_PATH = new URL('../../entry/src/main/ets/pages/Index.ets', import.meta.url);
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
const PENDING_COUNT = bodyFrom(INDEX, 'private pendingCountOf(');
const TODAY_COUNT_TEXT = bodyFrom(INDEX, 'private todayCountText(');
const EMPTY_COPY = bodyFrom(INDEX, 'private emptyCopy()');
const MODE_TABS = bodyFrom(INDEX, '\n  ModeTabs() {');
const SEARCH_BAR = bodyFrom(INDEX, '\n  SearchFilterBar() {');
const TAB_EMPTY = bodyFrom(INDEX, '\n  TabEmpty() {');
const RECORD_LIST = bodyFrom(INDEX, '\n  RecordList() {');
const SHOW_DONE_CHANGE = bodyFrom(INDEX, 'private onShowDoneChange(');

// 旧控件的「带引号标签」按字符拼出来，避免本测试文件自身被下面的「旧标签消失」扫描命中。
// 注意 `显示已完成` 是**新开关**的合法文案，不能用裸 `已完成'` 当判据（会误报）。
const QUOTE = String.fromCharCode(39);
const ALL = '全' + '部';
const DONE = '已' + '完' + '成';
const PENDING = '未' + '完' + '成';
const REMOVED_LABELS = [ALL + PENDING, QUOTE + DONE + QUOTE, QUOTE + ALL + QUOTE];
// P2-2：设备验收 / QA 表格脚本里死掉的旧 tab fallback 标签（同样拼出来，避免本文件被守卫命中）。
const TODAY_TODO = '今' + '日' + '待' + '办';

describe('mod-home-filters · 状态机与控制集（5 → 3）', () => {
  test('默认状态：tab=today + showDone=false；旧 showAllPending/statusFilter 状态已删', () => {
    assert.match(INDEX, /type HomeTab = 'today' \| 'pending';/);
    assert.match(INDEX, /@State tab: HomeTab = 'today';/);
    assert.match(INDEX, /@State showDone: boolean = false;/);
    assert.equal(INDEX.includes('showAllPending'), false, '旧 tab 状态名及其所有引用必须删除');
    assert.equal(INDEX.includes('@State statusFilter'), false, '旧状态 chip 字符串状态必须删除');
  });

  test('两个 tab 文案恰好是「今日 / 未完成」，顶部不再有「今日待办 / 全部未完成」', () => {
    const labels = [...MODE_TABS.matchAll(/label: '([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(labels, ['今日', '未完成'], `tab 文案应为两项，实际 ${JSON.stringify(labels)}`);
    assert.ok(MODE_TABS.includes("this.tab === 'today' ? 'primary' : 'ghost'"));
    assert.ok(MODE_TABS.includes("this.tab === 'pending' ? 'primary' : 'ghost'"));
  });

  test('「显示已完成」开关只在今日 tab 渲染，isOn 绑定 showDone，改动走 onShowDoneChange', () => {
    assert.ok(MODE_TABS.includes("if (this.tab === 'today') {"), '开关必须只在今日 tab 出现');
    assert.ok(MODE_TABS.includes("Text('显示已完成')"));
    assert.ok(MODE_TABS.includes('Toggle({ type: ToggleType.Switch, isOn: this.showDone })'));
    assert.ok(MODE_TABS.includes('this.onShowDoneChange(isOn);'));
    assert.ok(SHOW_DONE_CHANGE.includes('this.showDone = isOn;'));
    assert.ok(SHOW_DONE_CHANGE.includes('this.refreshQuery();'));
    assert.equal(SHOW_DONE_CHANGE.includes('this.reload()'), false, '拨开关不重读磁盘');
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

  test('首页 UI 源码不含被删控件名（旧状态 chip 与旧跨日 tab）', () => {
    for (const label of REMOVED_LABELS) {
      assert.equal(INDEX_RAW.includes(label), false, `Index.ets 不应再出现旧控件名 ${label}`);
    }
    assert.equal(INDEX_RAW.includes('今日待办'), false, '旧「今日待办」按钮名必须删除');
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

describe('mod-home-filters · tab 取数与排序', () => {
  test('reload：未完成 tab 走 pendingSorted，今日 tab 走 readDay(所选日期)', () => {
    assert.ok(RELOAD.includes("this.tab === 'pending'"));
    assert.ok(RELOAD.includes('this.pendingSorted()'));
    assert.ok(RELOAD.includes('timelineStore.readDay(this.selectedDate)'));
    assert.equal(RELOAD.includes('openIndexStore'), false, 'v2-only：不碰 v1 索引');
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

  test('刷新可见范围：仅今日 + 开关关闭时挡掉已完成；未完成 tab 始终用 tab 全量', () => {
    assert.ok(REFRESH_QUERY.includes("this.tab === 'today' && !this.showDone"));
    assert.ok(REFRESH_QUERY.includes('record.done !== true'));
    assert.ok(REFRESH_QUERY.includes('applyQuery(source, filter)'));
    assert.ok(REFRESH_QUERY.includes(': this.records;'), '未完成 tab 不经过开关过滤');
  });

  test('服务层仍是唯一的跨日未完成取数口（读 closed_at 派生）', () => {
    const service = readFileSync(TIMELINE_PATH, 'utf8');
    assert.ok(service.includes('pendingRecords(): ScheduleRecord[]'));
    assert.ok(service.includes('openRecords(loaded.day'));
  });
});

describe('mod-home-filters · 计数、空态与不变量', () => {
  test('今日计数 = 今日未完成条数，开关开启只追加「共 N 条」而不替换它', () => {
    assert.ok(RELOAD.includes('this.statusText = this.todayCountText();'), 'reload 今日分支走统一计数文案');
    assert.ok(TODAY_COUNT_TEXT.includes('`今日 ${this.pendingCountOf(this.records)} 条未完成`'));
    assert.ok(TODAY_COUNT_TEXT.includes("(this.showDone ? ` · 共 ${this.records.length} 条` : '')"));
    assert.ok(PENDING_COUNT.includes('record.done !== true'));
    assert.equal(TODAY_COUNT_TEXT.includes('visibleRecords.length'), false, '计数不能取被开关裁过的可见列表');
  });

  test('拨「显示已完成」即时重算副标题：开→含共 N 条、关→去掉，未完成计数两种状态相同', () => {
    // ArkTS 不能在 Node 跑，这里按本文件惯例做源码级静态钉死：
    // reload 与 onShowDoneChange 调同一个 todayCountText()，后缀不可能停留在上次 reload 的旧值。
    assert.ok(SHOW_DONE_CHANGE.includes('this.statusText = this.todayCountText();'),
      '拨开关必须重算计数文案（含后缀）');
    assert.ok(SHOW_DONE_CHANGE.includes("this.tab === 'today'"), '只在今日 tab 重算');
    assert.ok(SHOW_DONE_CHANGE.includes('this.records.length > 0'), '空态/错误态文案不被覆盖');
    assert.equal(SHOW_DONE_CHANGE.includes('this.reload()'), false, '重算后缀不得重读磁盘');

    // 三种断言对应三种行为：开关开→后缀取 tab 全量（含已完成）；关→后缀消失；
    // 主计数始终取 pendingCountOf（未完成集合），表达式里不含 showDone，故两态相同。
    assert.ok(TODAY_COUNT_TEXT.includes('this.pendingCountOf(this.records)'), '主计数取未完成集合');
    assert.ok(TODAY_COUNT_TEXT.includes("this.showDone ? ` · 共 ${this.records.length} 条` : ''"),
      '后缀由 showDone 门控，N = tab 全量（含已完成）');
    const pendingAt = TODAY_COUNT_TEXT.indexOf('this.pendingCountOf(this.records)');
    const suffixAt = TODAY_COUNT_TEXT.indexOf("this.showDone ? ` · 共");
    assert.ok(pendingAt >= 0 && suffixAt > pendingAt, '主计数与后缀同处一条文案');
    assert.equal(TODAY_COUNT_TEXT.slice(pendingAt, suffixAt).includes('showDone'), false,
      '未完成计数表达式不得依赖 showDone（两态必须相同）');
  });

  test('空态文案：今日 → 今天还没有日程；未完成 → 没有未完成的日程；旧文案已删', () => {
    assert.ok(EMPTY_COPY.includes("this.tab === 'pending' ? '没有未完成的日程' : '今天还没有日程'"));
    assert.ok(TAB_EMPTY.includes("Text('没有未完成的日程')"));
    assert.ok(INDEX.includes("Text('✨ 今日汇总')"));
    assert.ok(INDEX.includes("Text('今天还没有日程')"), '今日汇总块的今日空态灰字保留');
    assert.ok(RECORD_LIST.includes('this.TabEmpty()'));
    assert.ok(RECORD_LIST.includes('this.EmptyResults()'));
    assert.equal(INDEX.includes('所有日程都已完成'), false);
    assert.equal(INDEX.includes('这一天还没有日程'), false);
  });

  test('今日汇总块 / 撤销条 / 两个断点的渲染位置未被本模块改动', () => {
    for (const builderName of ['CompactBody', 'WideBody']) {
      const body = bodyFrom(INDEX, `\n  ${builderName}() {`);
      for (const piece of ['this.ModeTabs()', 'this.SearchFilterBar()', 'this.RecordList()', 'this.UndoBar()']) {
        assert.ok(body.includes(piece), `${builderName} 仍须渲染 ${piece}`);
      }
      assert.ok(body.includes('this.SummaryCard()'), `${builderName} 仍须渲染今日汇总块`);
      assert.ok(body.includes("if (this.tab === 'today') {"), `${builderName} 的汇总块必须按新 tab 名门控`);
    }
    assert.ok(INDEX.includes('this.UndoBar()'));
  });
});

describe('mod-home-filters · 测试与工具里没有旧控件名', () => {
  test('retarget 过的 5 个测试文件不含旧状态名与旧控件名', () => {
    const files = [
      'b3Batch.test.mjs', 'timelineService.test.mjs', 'uiTokens.test.mjs',
      'b4CalendarWiring.test.mjs', 'quickRecordUi.test.mjs', 'openIndex.test.mjs'
    ];
    for (const name of files) {
      const text = readFileSync(new URL(name, HERE), 'utf8');
      assert.equal(text.includes('showAllPending'), false, `${name} 仍引用旧状态名`);
      assert.equal(text.includes('statusFilter'), false, `${name} 仍引用旧状态名`);
      for (const label of REMOVED_LABELS) {
        assert.equal(text.includes(label), false, `${name} 仍引用旧控件名 ${label}`);
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
      for (const label of REMOVED_LABELS) {
        assert.equal(tool.includes(label), false, `${path.pathname} 仍引用旧控件名 ${label}`);
      }
    }
    // 仍容忍编辑器/详情里逐条的「已完成 / 未完成」状态文案：本守卫只禁带引号的旧状态片与旧 tab 名。
  });

  test('测试目录存在且本文件被 node --test 收拢（无新增依赖）', () => {
    const names = readdirSync(TEST_DIR).filter((n) => n.endsWith('.test.mjs'));
    assert.ok(names.includes('homeFilters.test.mjs'));
  });
});
