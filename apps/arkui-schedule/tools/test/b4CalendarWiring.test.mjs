/**
 * D7（P2）首页日期选择接线回归断言：DateBlock 用 CalendarPicker 替换系统三列滚轮 DatePicker，
 * 且首页与记录编辑页的「日期」入口复用同一个 CalendarPicker 组件（同源，不是各造一套日期网格）。
 *
 * ArkTS（.ets）依赖 @kit.* 运行时，Node 里跑不起来；但「滚轮调用是否清除」「组件是否在 DateBlock 内实例化」
 * 「回调链是否保留 reload/汇总」「reconcileSavedRow 文档是否还写死同 ts」等都是纯文本可判定的事实，
 * 用 bodyFrom / stripComments（沿用 b3Batch.test.mjs 的写法）钉死，挡住「假入口」「半接线」「偷偷改行为」回归。
 *
 * 本文件只读三份源码，不改任何既有实现或测试。
 * 运行：node --test apps/arkui-schedule/tools/test/b4CalendarWiring.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const ETS = new URL('../../entry/src/main/ets/', import.meta.url);
const INDEX = readFileSync(new URL('pages/Index.ets', ETS), 'utf8');
const EDITOR = readFileSync(new URL('components/RecordEditorView.ets', ETS), 'utf8');
const PICKER = readFileSync(new URL('components/CalendarPicker.ets', ETS), 'utf8');

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

/** 从 `marker` 起按大括号配平截取一个块（如 `CalendarPicker({`）。 */
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

/**
 * 剥掉块注释与行注释，保留字符串字面量里的 `//`（避免把 URL / 文案误当注释）。
 * 与 b3Batch.test.mjs 的 stripComments 同一套规则。
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

/** 断言若干锚点在文本里按给定顺序出现（先检查 >=0，避免 -1 比较造成「假通过」）。 */
function assertOrdered(text, tokens, label) {
  let previous = -1;
  for (const token of tokens) {
    const index = text.indexOf(token);
    assert.ok(index >= 0, `${label}：找不到 ${token}`);
    assert.ok(index > previous, `${label}：${token} 的顺序不对`);
    previous = index;
  }
}

const INDEX_CODE = stripComments(INDEX);
const EDITOR_CODE = stripComments(EDITOR);
const PICKER_CODE = stripComments(PICKER);
const DATE_BLOCK = bodyFrom(INDEX, '  DateBlock() {');
const DATE_BLOCK_CODE = stripComments(DATE_BLOCK);
const PICK_DATE = bodyFrom(INDEX, 'private pickDate(dateKey: string): void {');
const PICK_DATE_CODE = stripComments(PICK_DATE);
const RECONCILE = bodyFrom(INDEX, 'private reconcileSavedRow(saved: SavedMarker): void {');
const CALENDAR_INSTANTIATION = braceBlockFrom(DATE_BLOCK_CODE, 'CalendarPicker({');

// ---------------------------------------------------------------------------
// A. 首页：系统滚轮 DatePicker 已清除，改为 CalendarPicker 月视图
// ---------------------------------------------------------------------------
describe('D7-A 首页用 CalendarPicker 替换系统三列滚轮 DatePicker', () => {
  test('D7-01 Index 可执行代码里没有任何 DatePicker( 调用（注释提及不算）', () => {
    assert.equal(INDEX_CODE.includes('DatePicker('), false, '首页仍残留 DatePicker( 调用');
  });

  test('D7-02 没有遗留滚轮年份边界 new Date(2020, 0, 1) / new Date(2035, 11, 31)', () => {
    assert.equal(INDEX.includes('new Date(2020, 0, 1)'), false, '残留滚轮起点边界');
    assert.equal(INDEX.includes('new Date(2035, 11, 31)'), false, '残留滚轮终点边界');
  });

  test('D7-03 从 ../components/CalendarPicker 导入 CalendarPicker', () => {
    assert.match(
      INDEX,
      /import \{ CalendarPicker \} from '\.\.\/components\/CalendarPicker';/,
      '缺 CalendarPicker 的组件导入'
    );
  });

  test('D7-04 CalendarPicker 在 DateBlock() 体内实例化（不是别处假挂）', () => {
    assert.match(DATE_BLOCK_CODE, /CalendarPicker\(\{/, 'DateBlock 未实例化 CalendarPicker');
  });

  test('D7-05 CalendarPicker 收到 value: this.selectedDate', () => {
    assert.match(CALENDAR_INSTANTIATION, /value: this\.selectedDate/, 'value 未绑定选中日期');
  });

  test('D7-06 CalendarPicker 收到 todayKey: localDateKey(new Date())', () => {
    assert.match(
      CALENDAR_INSTANTIATION,
      /todayKey: localDateKey\(new Date\(\)\)/,
      'todayKey 未用本地今天键'
    );
  });

  test('D7-07 onPick 回调转调 this.pickDate(dateKey)', () => {
    assert.match(
      CALENDAR_INSTANTIATION,
      /onPick: \(dateKey: string\): void => \{ this\.pickDate\(dateKey\); \}/,
      'onPick 未转调 pickDate'
    );
  });

  test('D7-08 onClose 回调关闭 showDatePicker', () => {
    assert.match(
      CALENDAR_INSTANTIATION,
      /onClose: \(\): void => \{ this\.showDatePicker = false; \}/,
      'onClose 未关闭面板'
    );
  });

  test('D7-09 不新增 weekStart / closeOnBlank 实参（保留 CalendarPicker 默认值）', () => {
    assert.equal(CALENDAR_INSTANTIATION.includes('weekStart'), false, '不应显式传 weekStart');
    assert.equal(CALENDAR_INSTANTIATION.includes('closeOnBlank'), false, '不应显式传 closeOnBlank');
  });

  test('D7-10 DateBlock 文档注释声明展开区是 CalendarPicker 月视图（替代系统滚轮）', () => {
    const builderAt = INDEX.indexOf('DateBlock() {');
    const docStart = INDEX.lastIndexOf('/**', builderAt);
    const doc = INDEX.slice(docStart, builderAt);
    assert.match(doc, /CalendarPicker/, 'DateBlock 文档未提 CalendarPicker');
    assert.match(doc, /月视图/, 'DateBlock 文档未提月视图');
  });
});

// ---------------------------------------------------------------------------
// B. 行为等价 + 防假入口 + 两处日期入口同源
// ---------------------------------------------------------------------------
describe('D7-B 行为等价、防假入口、两处日期入口复用同一组件', () => {
  test('D7-11 pickDate 五个动作按顺序、各恰好一次（与原 onDateChange 等价）', () => {
    const actions = [
      'this.selectedDate = dateKey;',
      'this.showDatePicker = false;',
      'this.showAllPending = false;',
      'this.reload();',
      'this.loadSummary();'
    ];
    assertOrdered(PICK_DATE_CODE, actions, 'Index.pickDate');
    for (const action of actions) {
      assert.equal(
        PICK_DATE_CODE.split(action).length - 1,
        1,
        `pickDate 里 ${action} 必须恰好一次`
      );
    }
  });

  test('D7-12 pickDate 有空键防御且无额外 toast / 路由 / 重复 reload', () => {
    assert.match(
      PICK_DATE_CODE,
      /if \(dateKey\.length !== 10\) \{\s*return;\s*\}/,
      '缺 dateKey.length !== 10 的早退守卫'
    );
    assert.equal(PICK_DATE_CODE.includes('showToast'), false, 'pickDate 不得弹 toast');
    assert.equal(PICK_DATE_CODE.includes('router.'), false, 'pickDate 不得跳转');
    assert.equal((PICK_DATE_CODE.match(/this\.reload\(\)/g) ?? []).length, 1, 'reload 只能一次');
    assert.equal((PICK_DATE_CODE.match(/this\.loadSummary\(\)/g) ?? []).length, 1, 'loadSummary 只能一次');
  });

  test('D7-13 首页没有自定义日期网格 Builder（只复用 CalendarPicker）', () => {
    assert.equal(/\bdayCell\s*\(/.test(INDEX_CODE), false, '首页不得自建 dayCell 网格');
    assert.equal(/\bMonthGrid\s*\(/.test(INDEX_CODE), false, '首页不得自建 MonthGrid 网格');
    assert.equal(/\bWeekdayHeader\s*\(/.test(INDEX_CODE), false, '首页不得自建星期表头');
  });

  test('D7-14 记录编辑页也导入并实例化 CalendarPicker（两个日期入口同源）', () => {
    assert.match(
      EDITOR,
      /import \{ CalendarPicker \} from '\.\/CalendarPicker';/,
      'RecordEditorView 未导入 CalendarPicker'
    );
    assert.match(EDITOR_CODE, /CalendarPicker\(\{/, 'RecordEditorView 未实例化 CalendarPicker');
  });

  test('D7-15 CalendarPicker 仍导出 value/todayKey/onPick/onClose 四个 props', () => {
    assert.match(PICKER_CODE, /@Prop @Watch\('onValueChange'\) value: string/, '缺 value prop');
    assert.match(PICKER_CODE, /@Prop todayKey: string/, '缺 todayKey prop');
    assert.match(PICKER_CODE, /onPick: \(dateKey: string\) => void/, '缺 onPick prop');
    assert.match(PICKER_CODE, /onClose: \(\) => void/, '缺 onClose prop');
  });

  test('D7-16 「今天」/‹/› 入口仍在 DateBlock 内路由到 goToday / shiftDate(-1) / shiftDate(1)', () => {
    assert.match(DATE_BLOCK_CODE, /this\.shiftDate\(-1\)/, '‹ 入口丢失');
    assert.match(DATE_BLOCK_CODE, /this\.goToday\(\)/, '今天入口丢失');
    assert.match(DATE_BLOCK_CODE, /this\.shiftDate\(1\)/, '› 入口丢失');
  });

  test('D7-17 假入口守卫：存在 if(showDatePicker)+CalendarPicker 渲染分支，且无 showDatePicker = true', () => {
    assert.match(
      DATE_BLOCK_CODE,
      /if \(this\.showDatePicker\) \{\s*CalendarPicker\(\{/,
      'showDatePicker 展开分支未挂 CalendarPicker 渲染'
    );
    assert.equal(INDEX_CODE.includes('showDatePicker = true'), false, '不得有脱离渲染分支的 showDatePicker=true');
  });

  test('D7-18 reconcileSavedRow 文档不再写死「同 id 同 ts」，判定调用保持不变', () => {
    assert.equal(INDEX.includes('同 id 同 ts'), false, 'reconcileSavedRow 文档仍写死同 id 同 ts');
    assert.match(
      RECONCILE,
      /containsRecordVersion\(this\.records, saved\.id, saved\.ts\)/,
      'reconcileSavedRow 仍须按 id + ts 调 containsRecordVersion'
    );
  });
});
