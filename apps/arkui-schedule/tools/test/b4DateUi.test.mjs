// B4 / 日期收窄回归断言：编辑页「日期」入口 + 保存 ts 决策的源码级契约。
//
// ArkTS（.ets）依赖 @kit.ArkUI 等运行时，Node 里跑不起来；但「复用了哪个日期组件」
// 「新建才可选 / 已有记录只读」「拒绝分支是否排在写入之前」「保存是否只弹一条 toast」
// 这些都是纯文本可判定的事实，沿用 b3Batch.test.mjs 的 bodyFrom / stripComments 风格钉死。
//
// 本文件只读源码，不 import 编译产物：recordSaveTs.ts 的纯逻辑由 b4SaveTs.test.mjs 覆盖，
// 这里只断言接线契约。也不改任何既有源码/测试。
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
const DATE_EDITABLE = bodyFrom(EDITOR, 'private dateEditable(): boolean {');
const IS_DIRTY = bodyFrom(EDITOR, 'private isDirty(): boolean {');
const APPLY_PICKED = bodyFrom(EDITOR, 'private applyPickedDate(dateKey: string): void {');
const BUILD = bodyFrom(EDITOR, 'build() {');
const EDIT_VIEW = braceBlockFrom(EDIT, 'RecordEditorView({');

const RECORD_LITERAL = braceBlockFrom(SAVE_CODE, 'const record: ScheduleRecord = {');
const PLAN_GUARD = braceBlockFrom(SAVE_CODE, 'if (!plan.ok) {');
const PICKER_IF = braceBlockFrom(BUILD, 'if (this.dateEditable() && this.showDatePicker) {');
const PICKER = braceBlockFrom(BUILD, 'CalendarPicker({');

/** 日期表单段：从注释起到下一个字段的 Column 之前，避免别处的提示/按钮混进来。 */
const dateAt = BUILD.indexOf('// 日期');
assert.ok(dateAt >= 0, 'build() 里找不到日期段');
const dateColumnAt = BUILD.indexOf('Column({ space: SPACING.xs }) {', dateAt + 1);
assert.ok(dateColumnAt >= 0, '日期段找不到起始 Column');
const nextFieldAt = BUILD.indexOf('Column({ space: SPACING.xs }) {', dateColumnAt + 1);
const DATE_SECTION = BUILD.slice(dateAt, nextFieldAt > 0 ? nextFieldAt : BUILD.length);
const EDITABLE_HINT = braceBlockFrom(DATE_SECTION, 'if (this.dateEditable()) {');
const DATE_ON_CLICK = braceBlockFrom(DATE_SECTION, '.onClick(() => {');

// ---------------------------------------------------------------------------
// A. 日期行与日历组件接线
// ---------------------------------------------------------------------------
describe('B4 收窄：编辑页日期入口复用 CalendarPicker（仅新建可选）', () => {
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

  test('B4-05 日期行 onClick 仅在可编辑时切换 showDatePicker，只读时早退且不弹 toast', () => {
    assert.match(DATE_ON_CLICK, /if \(!this\.dateEditable\(\)\) \{\s*return;\s*\}/);
    assert.match(DATE_ON_CLICK, /this\.showDatePicker = !this\.showDatePicker;/);
    const gateAt = DATE_ON_CLICK.indexOf('if (!this.dateEditable())');
    const toggleAt = DATE_ON_CLICK.indexOf('this.showDatePicker = !this.showDatePicker;');
    assert.ok(gateAt >= 0 && toggleAt > gateAt, '只读早退必须排在切换之前');
    assert.equal(DATE_ON_CLICK.includes('showToast'), false, '只读行点按不弹 toast');
  });

  test('B4-06 日历只在 if (this.dateEditable() && this.showDatePicker) 里渲染，条件恰好一处', () => {
    assert.equal((BUILD.match(/if \(this\.dateEditable\(\) && this\.showDatePicker\) \{/g) ?? []).length, 1);
    assert.equal((BUILD.match(/if \(this\.showDatePicker\) \{/g) ?? []).length, 0, '不许无条件展开日历');
    assert.ok(PICKER_IF.includes('CalendarPicker({'), '日历必须同时受 dateEditable 与 showDatePicker 控制');
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
describe('B4 收窄：formDate 初值与已有记录日期来源', () => {
  test('B4-08 formDate / showDatePicker 仍是 @State', () => {
    assert.match(EDITOR, /@State formDate: string = '';/);
    assert.match(EDITOR, /@State showDatePicker: boolean = false;/);
  });

  test('B4-09 新建默认日期取校验后的 defaultDate，非法回落 localDateKey(new Date())', () => {
    assert.match(EDITOR, /import \{ parseDateKey \} from '\.\.\/model\/calendar';/);
    assert.match(BOOTSTRAP, /if \(this\.formDate\.length === 0\) \{/, '仅在 formDate 为空时写入，重试不冲掉用户选择');
    assert.match(
      BOOTSTRAP,
      /parseDateKey\(this\.defaultDate\) === null \? localDateKey\(new Date\(\)\) : this\.defaultDate/
    );
  });

  test('B4-10 loadRecord 从原 ts 解析日期，不留编辑前快照', () => {
    assert.match(LOAD, /this\.formDate = resolveRecordDate\(this\.originalTs\);/);
    assert.equal(LOAD.includes('originalRecord'), false, '日期不可改，不再需要编辑前记录快照');
  });
});

// ---------------------------------------------------------------------------
// C. 保存路径：先拒绝，再写唯一一条新版本
// ---------------------------------------------------------------------------
describe('B4 收窄：save() 的 ts 决策与单一成功提示', () => {
  test('B4-11 save() 先算 resolveSaveTs，!plan.ok 拦截块在第一次 appendRecord 之前', () => {
    assert.ok(SAVE_CODE.includes('resolveSaveTs(this.originalTs, this.formDate'), 'save() 必须调用 resolveSaveTs');
    const planAt = SAVE_CODE.indexOf('const plan: SaveTsPlan = resolveSaveTs(');
    const guardAt = SAVE_CODE.indexOf('if (!plan.ok) {');
    const firstAppendAt = SAVE_CODE.indexOf('appendRecord(');
    assert.ok(planAt >= 0, '缺 const plan: SaveTsPlan = resolveSaveTs(...)');
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

  test('B4-16 成功后只同步原内容快照 / 收起面板，不写 formDate 也不存记录快照', () => {
    assert.match(SAVE_CODE, /this\.originalTitle = title;/);
    assert.match(SAVE_CODE, /this\.originalBody = this\.body;/);
    assert.match(SAVE_CODE, /this\.originalTs = record\.ts;/);
    assert.match(SAVE_CODE, /this\.showDatePicker = false;/);
    assert.equal(SAVE_CODE.includes('this.formDate ='), false, '保存后不得改写日期');
    assert.equal(SAVE_CODE.includes('originalRecord'), false, '保存后不再记录编辑前快照');
    assert.equal(SAVE_CODE.includes('plan.date'), false, 'SaveTsPlan 没有 date 字段');
  });

  test('B4-17 恰好一条成功 toast（已保存 / 已保存（待 AI 整理）），无日期改为变体', () => {
    assert.match(SAVE_CODE, /const savedMessage: string = changed \? '已保存（待 AI 整理）' : '已保存';/);
    const successAt = SAVE_CODE.indexOf('const savedMessage');
    assert.ok(successAt >= 0, '找不到成功提示');
    const successTail = SAVE_CODE.slice(successAt);
    assert.equal((successTail.match(/promptAction\.showToast\(/g) ?? []).length, 1, '成功路径只弹一次 toast');
    assert.equal(SAVE_CODE.includes('日期改为'), false, '不再有改期成功文案');
    assert.equal(SAVE_CODE.includes('cleanupNote'), false, '不再有清理提示分支');
  });

  test('B4-18 一次性保存标记仍在 onSaved 之前（B3 契约未破）', () => {
    const markerAt = SAVE_CODE.indexOf('AppStorage.setOrCreate<string>(SAVED_MARKER_KEY');
    const savedAt = SAVE_CODE.indexOf('this.onSaved(record);');
    assert.ok(markerAt >= 0 && savedAt > markerAt, '标记必须在 onSaved 之前写好');
  });
});

// ---------------------------------------------------------------------------
// D. 脏判定、只读行与禁止回归
// ---------------------------------------------------------------------------
describe('B4 收窄：脏判定、日期只读行与禁止回归', () => {
  test('B4-19 已有记录脏判定 = contentChanged() 单独一项，dateChanged 已删除', () => {
    assert.match(IS_DIRTY, /return this\.contentChanged\(\);/);
    assert.equal(IS_DIRTY.includes('dateChanged'), false);
    assert.equal(EDITOR.includes('dateChanged'), false, '日期不再参与脏判定');
    assert.match(DATE_EDITABLE, /return this\.recordId\.length === 0;/);
    assert.match(CONTENT_CHANGED, /this\.title\.trim\(\) !== this\.originalTitle\.trim\(\) \|\| this\.body !== this\.originalBody/);
    assert.equal(CONTENT_CHANGED.includes('formDate'), false, '内容变更判定不得掺入日期（ai_processed 语义）');
    assert.equal(CONTENT_CHANGED.includes('dateChanged'), false);
  });

  test('B4-21 不手写 deleted:true、不删文件、不第二个保存按钮，且不调用 softDeleteRecord', () => {
    assert.equal(EDITOR.includes('deleted: true'), false, '保存不产生墓碑');
    assert.equal(EDITOR.includes('unlink'), false, '不得物理删除文件');
    assert.equal(EDITOR.includes('softDeleteRecord'), false, '编辑器不再导入/调用 softDeleteRecord');
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

  test('B4-26 已有记录日期行只读：选择提示/点按切换/日历渲染都受 dateEditable 门控，并显示创建时选定，不可改', () => {
    assert.match(DATE_EDITABLE, /return this\.recordId\.length === 0;/);
    // brand 色的「选择 / 收起」提示只在可编辑分支里
    assert.match(EDITABLE_HINT, /Text\(this\.showDatePicker \? '收起' : '选择'\)/);
    assert.match(EDITABLE_HINT, /\$r\('app\.color\.brand'\)/);
    assert.match(EDITABLE_HINT, /FONT\.caption/);
    // 点行早退；日历渲染受双重条件门控
    assert.match(DATE_ON_CLICK, /if \(!this\.dateEditable\(\)\) \{\s*return;\s*\}/);
    assert.match(BUILD, /if \(this\.dateEditable\(\) && this\.showDatePicker\) \{\s*CalendarPicker\(\{/);
    // 只读提示：灰字一行，无 danger 色
    assert.match(DATE_SECTION, /if \(!this\.dateEditable\(\)\) \{\s*Text\('创建时选定，不可改'\)/);
    const readonlyTail = DATE_SECTION.slice(DATE_SECTION.indexOf("Text('创建时选定，不可改')"));
    assert.match(readonlyTail, /\$r\('app\.color\.text_secondary'\)/);
    assert.equal(readonlyTail.includes('app.color.danger'), false, '只读提示不得用 danger 色');
  });

  test('B4-27 编辑器源码不含已删除的改期 / 墓碑机制与旧快照字段', () => {
    for (const token of [
      'planDateMove',
      'DateMovePlan',
      'needsTombstone',
      'tombstoneTs',
      'cleanupNote',
      'softDeleteRecord',
      'dateMoveHint',
      'originalRecord',
      '日期改为'
    ]) {
      assert.equal(EDITOR.includes(token), false, `编辑器残留已删除概念：${token}`);
    }
  });

  test('B4-28 新建记录仍可点行展开日历：唯一 CalendarPicker 实例受双重条件门控', () => {
    assert.equal((EDITOR.match(/CalendarPicker\(\{/g) ?? []).length, 1);
    assert.equal((BUILD.match(/if \(this\.dateEditable\(\) && this\.showDatePicker\) \{/g) ?? []).length, 1);
    assert.ok(PICKER_IF.includes('CalendarPicker({'), '新建时日历必须仍可展开');
    assert.match(DATE_EDITABLE, /return this\.recordId\.length === 0;/);
    assert.match(EDITABLE_HINT, /Text\(this\.showDatePicker \? '收起' : '选择'\)/);
  });
});
