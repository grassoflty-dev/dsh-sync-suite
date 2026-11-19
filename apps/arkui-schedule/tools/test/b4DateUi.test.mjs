// B4 / D5-P1 回归断言：编辑页「日期」入口 + 改期保存的源码级契约。
//
// ArkTS（.ets）依赖 @kit.ArkUI 等运行时，Node 里跑不起来；但「复用了哪个日期组件」
// 「拒绝分支是否排在写入之前」「墓碑是否用编辑前快照」「旧日幽灵清理是否非静默」
// 这些都是纯文本可判定的事实，沿用 b3Batch.test.mjs 的 bodyFrom / stripComments 风格钉死。
//
// 本文件只读源码，不 import 编译产物：recordDateMove.ts 由另一路实现，
// 这里只断言接线契约，不重复它的纯逻辑单测。也不改任何既有源码/测试。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const ETS = new URL('../../entry/src/main/ets/', import.meta.url);
const EDITOR = readFileSync(new URL('components/RecordEditorView.ets', ETS), 'utf8');
const EDIT = readFileSync(new URL('pages/Edit.ets', ETS), 'utf8');

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

/** 剥掉块注释与行注释，但保留字符串字面量里的 `//`（与 b3Batch.test.mjs 同一套规则）。 */
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

/** 从 `marker`（如 `if (this.showDatePicker) {`）起按大括号配平截取块。 */
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

const SAVE = bodyFrom(EDITOR, 'private save(): void {');
const SAVE_CODE = stripComments(SAVE);
const LOAD = bodyFrom(EDITOR, 'private loadRecord(): void {');
const BOOTSTRAP = bodyFrom(EDITOR, 'private async bootstrap(): Promise<void> {');
const CONTENT_CHANGED = bodyFrom(EDITOR, 'private contentChanged(): boolean {');
const DATE_CHANGED = bodyFrom(EDITOR, 'private dateChanged(): boolean {');
const IS_DIRTY = bodyFrom(EDITOR, 'private isDirty(): boolean {');
const DATE_HINT = bodyFrom(EDITOR, 'private dateMoveHint(): string {');
const APPLY_PICKED = bodyFrom(EDITOR, 'private applyPickedDate(dateKey: string): void {');
const BUILD = bodyFrom(EDITOR, 'build() {');
const EDIT_VIEW = braceBlockFrom(EDIT, 'RecordEditorView({');

const RECORD_LITERAL = braceBlockFrom(SAVE_CODE, 'const record: ScheduleRecord = {');
const PLAN_GUARD = braceBlockFrom(SAVE_CODE, 'if (!plan.ok) {');
const TOMB_BLOCK = braceBlockFrom(SAVE_CODE, 'if (plan.needsTombstone) {');
const LATER_BRANCH = braceBlockFrom(SAVE_CODE, "if (plan.kind === 'later') {");
const PICKER_IF = braceBlockFrom(BUILD, 'if (this.showDatePicker) {');
const PICKER = braceBlockFrom(BUILD, 'CalendarPicker({');
const HINT_IF = braceBlockFrom(BUILD, 'if (this.dateMoveHint().length > 0) {');

// ---------------------------------------------------------------------------
// A. 日期行与日历组件接线
// ---------------------------------------------------------------------------
describe('B4 D5-P1：编辑页日期入口复用 CalendarPicker', () => {
  test('B4-01 只 import 一次 CalendarPicker，且全文只实例化一次', () => {
    assert.equal(
      (EDITOR.match(/import \{ CalendarPicker \} from '\.\/CalendarPicker';/g) ?? []).length,
      1,
      '必须从 ./CalendarPicker 导入且恰好一次'
    );
    assert.equal((EDITOR.match(/CalendarPicker\(\{/g) ?? []).length, 1, '编辑器只能实例化一个日历组件');
  });

  test('B4-02 日历实例四个入参齐全（value / todayKey / onPick / onClose）', () => {
    for (const prop of [
      'value: this.formDate',
      'todayKey: localDateKey(new Date())',
      'onPick: (dateKey: string): void => this.applyPickedDate(dateKey)',
      'onClose: (): void => {'
    ]) {
      assert.ok(PICKER.includes(prop), `日历入参缺失：${prop}`);
    }
  });

  test('B4-03 编辑器里不许出现系统 DatePicker(（禁止两套日期 UI）', () => {
    assert.equal(EDITOR.includes('DatePicker('), false, '日期只能走 CalendarPicker，不许系统滚轮兜底');
  });

  test('B4-04 日期行：标签 / 当前日期 / 收起-选择提示齐全，触控高用 TOUCH_MIN', () => {
    assert.match(BUILD, /Text\('日期'\)/, '表单必须有一行「日期」');
    assert.match(BUILD, /Text\(this\.formDate\)/, '行内要显示当前 formDate');
    assert.match(BUILD, /Text\(this\.showDatePicker \? '收起' : '选择'\)/, '要有展开/收起提示');
    assert.match(BUILD, /\.height\(TOUCH_MIN\)/, '整行触控区不得小于 TOUCH_MIN');
  });

  test('B4-05 日期行 onClick 只切换 showDatePicker', () => {
    assert.match(BUILD, /\.onClick\(\(\) => \{\s*this\.showDatePicker = !this\.showDatePicker;\s*\}\)/);
  });

  test('B4-06 日历只在 if (this.showDatePicker) 里渲染，且该条件恰好一处', () => {
    assert.equal((BUILD.match(/if \(this\.showDatePicker\) \{/g) ?? []).length, 1);
    assert.ok(PICKER_IF.includes('CalendarPicker({'), '日历必须受 showDatePicker 控制');
  });

  test('B4-07 选中日期写 formDate、收面板、同步脏状态', () => {
    assert.match(APPLY_PICKED, /this\.formDate = dateKey;/);
    assert.match(APPLY_PICKED, /this\.showDatePicker = false;/);
    assert.match(APPLY_PICKED, /this\.notifyDirty\(\);/);
  });
});

// ---------------------------------------------------------------------------
// B. 状态与初值
// ---------------------------------------------------------------------------
describe('B4 D5-P1：formDate 初值与编辑前快照', () => {
  test('B4-08 formDate / showDatePicker 是 @State，originalRecord 是私有快照', () => {
    assert.match(EDITOR, /@State formDate: string = '';/);
    assert.match(EDITOR, /@State showDatePicker: boolean = false;/);
    assert.match(EDITOR, /private originalRecord: ScheduleRecord \| null = null;/);
  });

  test('B4-09 新建默认日期取校验后的 defaultDate，非法回落 localDateKey(new Date())', () => {
    assert.match(EDITOR, /import \{ parseDateKey \} from '\.\.\/model\/calendar';/);
    assert.match(BOOTSTRAP, /if \(this\.formDate\.length === 0\) \{/, '仅在 formDate 为空时写入，重试不冲掉用户选择');
    assert.match(
      BOOTSTRAP,
      /parseDateKey\(this\.defaultDate\) === null \? localDateKey\(new Date\(\)\) : this\.defaultDate/
    );
  });

  test('B4-10 loadRecord 里存编辑前快照，并从原 ts 解析日期', () => {
    assert.match(LOAD, /this\.originalRecord = record;/);
    assert.match(LOAD, /this\.formDate = resolveRecordDate\(this\.originalTs\);/);
  });
});

// ---------------------------------------------------------------------------
// C. 保存路径：先拒绝，再写新版本，最后清理旧日期
// ---------------------------------------------------------------------------
describe('B4 D5-P1：save() 的日期计划与旧日幽灵清理', () => {
  test('B4-11 save() 先算 planDateMove，!plan.ok 拦截块在第一次 appendRecord 之前', () => {
    assert.ok(SAVE_CODE.includes('planDateMove(this.originalTs, this.formDate'), 'save() 必须按 formDate 生成计划');
    const planAt = SAVE_CODE.indexOf('const plan: DateMovePlan = planDateMove(');
    const guardAt = SAVE_CODE.indexOf('if (!plan.ok) {');
    const firstAppendAt = SAVE_CODE.indexOf('appendRecord(');
    assert.ok(planAt >= 0, '缺 const plan: DateMovePlan = planDateMove(...)');
    assert.ok(guardAt > planAt, '!plan.ok 拦截必须紧随计划');
    assert.ok(firstAppendAt > guardAt, '拒绝分支必须排在第一次 appendRecord 之前（不写半条记录）');
    assert.match(PLAN_GUARD, /return;/);
    assert.match(PLAN_GUARD, /plan\.reason/);
    assert.match(PLAN_GUARD, /toastMsFor\(true\)/);
  });

  test('B4-12 记录字面量的 ts 用 plan.ts，旧 nowIso()/nextTsSameDate() ts 表达式已删除', () => {
    assert.match(RECORD_LITERAL, /ts: plan\.ts,/);
    assert.equal(RECORD_LITERAL.includes('nextTsSameDate('), false, '记录字面量不得再用 nextTsSameDate');
    assert.equal(RECORD_LITERAL.includes('nowIso()'), false, '记录字面量不得再用 nowIso()（ocr_time 除外）');
    assert.equal(SAVE_CODE.includes('nextTsSameDate'), false, 'save() 内不许残留 nextTsSameDate');
    assert.equal(EDITOR.includes('import { nextTsSameDate'), false, '无用的 nextTsSameDate import 必须删除');
  });

  test('B4-13 新版本先落盘，旧日期墓碑后追加（live < tombstone）', () => {
    const liveAt = SAVE_CODE.indexOf('appendRecord(record)');
    const tombAt = SAVE_CODE.indexOf('softDeleteRecord');
    const appendTombAt = SAVE_CODE.indexOf('appendRecord(tombstone)');
    assert.ok(liveAt >= 0, '缺 appendRecord(record)');
    assert.ok(tombAt > liveAt, 'live 必须在墓碑之前追加');
    assert.ok(appendTombAt > tombAt, '墓碑必须先构造再追加');
  });

  test('B4-14 墓碑基于编辑前快照，快照缺失给中文 cleanupNote 并停止补写', () => {
    assert.match(TOMB_BLOCK, /softDeleteRecord\(this\.originalRecord, plan\.tombstoneTs\)/);
    assert.match(TOMB_BLOCK, /this\.originalRecord === null/);
    assert.match(TOMB_BLOCK, /旧版本未清理/);
    assert.match(TOMB_BLOCK, /请返回列表确认，必要时删除旧日期那条/);
    assert.match(TOMB_BLOCK, /cleanupNote = `已保存到 \$\{plan\.date\}/);
    // 修复：快照缺失不再 return（否则跳过一次性标记与 onSaved），只记一条清理提示。
    assert.doesNotMatch(TOMB_BLOCK, /return;/);
  });

  test('B4-15 墓碑追加有自己的 try/catch，失败只记 cleanupNote 不回滚', () => {
    assert.match(TOMB_BLOCK, /try \{[\s\S]*appendRecord\(tombstone\)[\s\S]*\} catch \(error\)/);
    assert.match(TOMB_BLOCK, /describeError\(error\)/);
    // 长 toast 时长钉在最终那条 cleanupNote toast 上（比只查墓碑块更严格）。
    assert.match(SAVE_CODE, /message: cleanupNote, duration: toastMsFor\(true\)/);
    assert.equal(TOMB_BLOCK.includes('throw '), false, '清理失败不许抛，新版本已落盘');
  });

  test('B4-16 成功后同步 snapshot / formDate / 收起面板，保留原 ts 更新', () => {
    assert.match(SAVE_CODE, /this\.originalTs = record\.ts;/);
    assert.match(SAVE_CODE, /this\.originalRecord = record;/);
    assert.match(SAVE_CODE, /this\.formDate = plan\.date;/);
    assert.match(SAVE_CODE, /this\.showDatePicker = false;/);
  });

  test('B4-17 迁到更晚一天只弹一次成功 toast 且写明新日期（保留 AI 变体语义）', () => {
    assert.match(LATER_BRANCH, /已保存，日期改为 \$\{plan\.date\}/);
    assert.match(LATER_BRANCH, /待 AI 整理/);
    assert.equal((SAVE_CODE.match(/message: savedMessage/g) ?? []).length, 1, '成功 toast 只能有一处');
    const successTail = SAVE_CODE.slice(SAVE_CODE.indexOf('let savedMessage'));
    assert.equal((successTail.match(/promptAction\.showToast\(/g) ?? []).length, 1, '成功路径只弹一次 toast，不许补第二条迁期提示');
  });

  test('B4-18 一次性保存标记仍在 onSaved 之前（B3 契约未破）', () => {
    const markerAt = SAVE_CODE.indexOf('AppStorage.setOrCreate<string>(SAVED_MARKER_KEY');
    const savedAt = SAVE_CODE.indexOf('this.onSaved(record);');
    assert.ok(markerAt >= 0 && savedAt > markerAt, '标记必须在 onSaved 之前写好');
  });

  test('B4-23 墓碑块到收尾行之间没有任何 return（修复后收尾不跳过）', () => {
    const tombAt = SAVE_CODE.indexOf('if (plan.needsTombstone) {');
    const syncAt = SAVE_CODE.indexOf('this.originalTs = record.ts;');
    assert.ok(tombAt >= 0 && syncAt > tombAt, '墓碑块与收尾行的定位失败');
    const slice = SAVE_CODE.slice(tombAt, syncAt);
    assert.equal(slice.includes('return;'), false, '新版本落盘后不许提前 return，否则跳过一次性标记与 onSaved');
  });

  test('B4-24 cleanupNote 先声明、门控唯一 toast，成功文案落在 else 分支', () => {
    const declaredAt = SAVE_CODE.indexOf("let cleanupNote: string = '';");
    const tombAt = SAVE_CODE.indexOf('if (plan.needsTombstone) {');
    const gateAt = SAVE_CODE.indexOf('if (cleanupNote.length > 0) {');
    assert.ok(declaredAt >= 0 && declaredAt < tombAt, 'cleanupNote 必须在墓碑块之前声明');
    assert.ok(gateAt > tombAt, 'cleanupNote 必须门控墓碑块之后的 toast');
    const cleanupToast = braceBlockFrom(SAVE_CODE, 'if (cleanupNote.length > 0) {');
    assert.match(cleanupToast, /message: cleanupNote, duration: toastMsFor\(true\)/, '清理提示独占一条长 toast');
    const elseAt = SAVE_CODE.indexOf('} else {', gateAt);
    assert.ok(elseAt > gateAt, '必须有 else 分支承载成功 toast');
    const elseTail = SAVE_CODE.slice(elseAt);
    assert.match(elseTail, /promptAction\.showToast\(\{ message: savedMessage \}\)/, '成功 toast 必须在 else 分支');
    const gateTail = SAVE_CODE.slice(gateAt);
    assert.equal((gateTail.match(/promptAction\.showToast\(/g) ?? []).length, 2, '门控后清理/成功各一条，恰好一条/路径');
  });

  test('B4-25 encodeSavedMarker 排在墓碑块之后且不受 cleanupNote 约束', () => {
    const tombAt = SAVE_CODE.indexOf('if (plan.needsTombstone) {');
    const markerAt = SAVE_CODE.indexOf('encodeSavedMarker(');
    const savedAt = SAVE_CODE.indexOf('this.onSaved(record);');
    assert.ok(markerAt > tombAt, 'encodeSavedMarker 必须排在墓碑块之后');
    assert.ok(savedAt > markerAt, 'marker 仍须先于 onSaved（否则 router.back() 抢跑）');
    const markerLine = SAVE_CODE.split('\n').find((line) => line.includes('encodeSavedMarker('));
    assert.ok(markerLine !== undefined, '找不到 encodeSavedMarker 所在行');
    assert.equal(markerLine.includes('cleanupNote'), false, 'marker 行不得掺入 cleanupNote 条件');
  });
});

// ---------------------------------------------------------------------------
// D. 脏判定、提示与禁用写法
// ---------------------------------------------------------------------------
describe('B4 D5-P1：脏判定、改期提示与禁止回归', () => {
  test('B4-19 dateChanged 参与 isDirty，contentChanged 仍只比标题/正文', () => {
    assert.match(IS_DIRTY, /this\.contentChanged\(\) \|\| this\.dateChanged\(\)/);
    assert.match(DATE_CHANGED, /this\.recordId\.length === 0 \|\| this\.originalTs\.length === 0/);
    assert.match(DATE_CHANGED, /this\.formDate !== resolveRecordDate\(this\.originalTs\)/);
    assert.match(CONTENT_CHANGED, /this\.title\.trim\(\) !== this\.originalTitle\.trim\(\) \|\| this\.body !== this\.originalBody/);
    assert.equal(CONTENT_CHANGED.includes('formDate'), false, '内容变更判定不得掺入日期（ai_processed 语义）');
    assert.equal(CONTENT_CHANGED.includes('dateChanged'), false);
  });

  test('B4-20 更早日期提示走 planDateMove(...).reason，danger 文案在行下', () => {
    assert.match(DATE_HINT, /planDateMove\(this\.originalTs, this\.formDate, new Date\(\)\)/);
    assert.match(DATE_HINT, /plan\.reason/);
    assert.match(HINT_IF, /Text\(this\.dateMoveHint\(\)\)/);
    assert.match(HINT_IF, /\$r\('app\.color\.danger'\)/);
    assert.match(HINT_IF, /FONT\.caption/);
  });

  test('B4-21 不手写 deleted:true、不删文件、不第二个保存按钮', () => {
    assert.equal(EDITOR.includes('deleted: true'), false, '墓碑必须走 softDeleteRecord');
    assert.equal((EDITOR.match(/softDeleteRecord\(/g) ?? []).length, 1, '墓碑构造只能一处');
    assert.equal(EDITOR.includes('unlink'), false, '不得物理删除文件');
    assert.equal(
      (BUILD.match(/Button\(this\.recordId\.length > 0 \? '保存修改' : '保存日程'\)/g) ?? []).length,
      1,
      '保存按钮只能一个（标签仍沿用原来的保存修改/保存日程三元式）'
    );
    assert.equal((BUILD.match(/\.onClick\(\(\) => this\.save\(\)\)/g) ?? []).length, 1, '保存动作只能绑定一处');
  });

  test('B4-22 Edit.ets 薄壳：defaultDate / autoFocusTitle 原样透传', () => {
    assert.match(EDIT_VIEW, /defaultDate: this\.defaultDate,/);
    assert.match(EDIT_VIEW, /autoFocusTitle: true,/);
    assert.equal(EDIT_VIEW.includes('formDate'), false, '薄壳不得复制日期逻辑');
    assert.equal(EDIT.includes('showDatePicker'), false);
  });
});
