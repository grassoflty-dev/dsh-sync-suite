// 首页快捷记录（QuickRecordBar.ets + Index.ets）源码级接线断言。
//
// ArkTS（.ets）依赖 @kit.ArkUI 等运行时，Node 里跑不起来；但「组件里只有一个输入框 + 一个保存键」
// 「成功才清空」「列表区两个断点都渲染且在新建之上」「保存链路不写编辑页的一次性标记」这些都是
// 纯文本可判定的事实，沿用 b4DateUi.test.mjs / indexHeader.test.mjs 的 stripComments + bodyFrom 风格钉死。
//
// 本文件只读源码，不 import 编译产物；纯逻辑由 quickRecord.test.mjs 覆盖。
// 页头守卫 indexHeader.test.mjs 不在本文件职责内，这里只断言它没有被削弱。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const COMPONENT_PATH = new URL('../../entry/src/main/ets/components/QuickRecordBar.ets', import.meta.url);
const INDEX_PATH = new URL('../../entry/src/main/ets/pages/Index.ets', import.meta.url);
const HEADER_GUARD_PATH = new URL('indexHeader.test.mjs', import.meta.url);

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

/** `build()` 里 `PageLayout({ ... })` 的属性区（不含尾随闭包内容）。 */
function pageLayoutProps(code) {
  const start = code.indexOf('PageLayout({');
  assert.notEqual(start, -1, 'build() 必须渲染 PageLayout');
  const end = code.indexOf('}) {', start);
  assert.ok(end > start, '找不到 PageLayout 的尾随闭包起点');
  return code.slice(start, end);
}

const COMPONENT = stripComments(readFileSync(COMPONENT_PATH, 'utf8'));
const INDEX = stripComments(readFileSync(INDEX_PATH, 'utf8'));

describe('QuickRecordBar.ets：一个输入框 + 一个保存键，成功才清空', () => {
  test('组件恰好有一个 TextInput 与一个 ActionButton，且按钮文案为「保存」', () => {
    assert.equal((COMPONENT.match(/TextInput\(/g) ?? []).length, 1, '只能有一个 TextInput');
    assert.equal((COMPONENT.match(/ActionButton\(\{/g) ?? []).length, 1, '只能有一个 ActionButton');
    assert.match(COMPONENT, /label: '保存'/);
  });

  test('输入框占位文案按规格给出，不承诺未接线的回车，且高度走 TOUCH_MIN 令牌', () => {
    assert.match(COMPONENT, /placeholder: '快速记一条：标题，点「保存」'/);
    const placeholder = (COMPONENT.match(/placeholder: '([^']*)'/) ?? [])[1] ?? '';
    assert.equal(placeholder.includes('回车'), false, '占位符不得承诺未接线的回车提交');
    assert.match(COMPONENT, /\.height\(TOUCH_MIN\)/);
  });

  test('onSubmit prop 的签名是 (title: string) => boolean', () => {
    assert.match(COMPONENT, /onSubmit:\s*\(title: string\) => boolean\s*=/);
  });

  test('只有回调返回 true 才清空输入框（失败保留原文）', () => {
    assert.match(COMPONENT, /const saved: boolean = this\.onSubmit\(this\.text\);/);
    assert.match(COMPONENT, /if \(saved\) \{\s*this\.text = '';\s*\}/);
    assert.equal((COMPONENT.match(/this\.text = '';/g) ?? []).length, 1, '清空赋值必须只有一处');
  });

  test('空标题 / 忙碌由 ActionButton 的 actionEnabled + 中文原因接管，另有防御 toast', () => {
    assert.match(COMPONENT, /actionEnabled: !this\.busy && this\.text\.trim\(\)\.length > 0/);
    assert.match(COMPONENT, /message: '请输入标题'/);
  });

  test('组件没有日期 UI，也不抢父页面「已记下」的成功反馈', () => {
    for (const banned of ['DatePicker', 'MonthCalendar', 'CalendarPicker', 'selectedDate']) {
      assert.equal(COMPONENT.includes(banned), false, `组件不得出现日期 UI：${banned}`);
    }
    assert.equal(COMPONENT.includes('已记下'), false, '成功 toast 由父页面负责');
  });
});

describe('Index.ets：快捷记录只接在列表区，不动页头', () => {
  test('Builder 渲染 QuickRecordBar 组件并传入 busy / onSubmit', () => {
    const bar = bodyFrom(INDEX, '\n  QuickRecordRow() {');
    assert.match(bar, /QuickRecordBar\(\{/);
    assert.match(bar, /busy: this\.quickBusy/);
    assert.match(bar, /onSubmit: \(title: string\): boolean => this\.submitQuickRecord\(title\)/);
  });

  test('CompactBody 与 WideBody 各渲染一次，且都在主操作之上', () => {
    for (const [builder, action] of [['CompactBody', 'PrimaryAction'], ['WideBody', 'SidebarAction']]) {
      const body = bodyFrom(INDEX, `\n  ${builder}() {`);
      const barAt = body.indexOf('this.QuickRecordRow()');
      const actionAt = body.indexOf(`this.${action}()`);
      assert.ok(barAt >= 0, `${builder} 必须渲染 this.QuickRecordRow()`);
      assert.ok(actionAt > barAt, `${builder} 的快捷记录条必须在 this.${action}() 之前`);
    }
    assert.equal((INDEX.match(/this\.QuickRecordRow\(\)/g) ?? []).length, 2, '两个断点各渲染一次');
  });

  test('submitQuickRecord 先算 plan、先挡 !plan.ok，再 appendRecord', () => {
    const fn = bodyFrom(INDEX, 'private submitQuickRecord(');
    assert.match(fn, /planQuickRecord\(rawTitle, this\.selectedDate, new Date\(\)\)/);
    assert.match(fn, /if \(!plan\.ok\)/);
    assert.ok(fn.indexOf('!plan.ok') < fn.indexOf('appendRecord'), '无效输入必须在写入前挡住');
    assert.match(fn, /message: plan\.reason/);
    assert.match(fn, /scheduleStore\.isReady\(\)/);
  });

  test('记录字段与编辑器路径一致，作者走同步缓存', () => {
    const fn = bodyFrom(INDEX, 'private submitQuickRecord(');
    assert.match(fn, /id: newRecordId\(\)/);
    assert.match(fn, /ts: plan\.ts/);
    assert.match(fn, /title: plan\.title/);
    assert.match(fn, /body: ''/);
    assert.match(fn, /author: this\.defaultAuthorOrMe\(\)/);
    assert.match(fn, /done: false/);
    assert.match(fn, /ai_processed: false/);
    const author = bodyFrom(INDEX, 'private defaultAuthorOrMe(');
    assert.match(author, /settingsStore\.cached\(\)/, '作者取 settingsStore 已加载的同步缓存');
    assert.match(author, /settings\.author\.trim\(\)\.length > 0/);
    assert.match(author, /return '我'/);
  });

  test('appendRecord 出错有中文 toast；成功后刷新列表 + 汇总并提示已记下', () => {
    const fn = bodyFrom(INDEX, 'private submitQuickRecord(');
    assert.match(fn, /scheduleStore\.appendRecord\(record\)/);
    assert.match(fn, /保存失败：\$\{describeError\(error\)\}/);
    assert.match(fn, /this\.reload\(\)/);
    assert.match(fn, /this\.loadSummary\(\)/);
    assert.match(fn, /message: '已记下'/);
  });

  test('点击路径零异步，且不写编辑页的一次性保存标记', () => {
    const fn = bodyFrom(INDEX, 'private submitQuickRecord(');
    assert.equal(/\bawait\b/.test(fn), false, '快捷记录保存不得引入新的异步等待');
    assert.equal(fn.includes('SAVED_MARKER_KEY'), false, 'SAVED_MARKER_KEY 只属于编辑页返回路径');
  });

  test('PageLayout 页头属性没有新增任何 headerAction', () => {
    const head = pageLayoutProps(INDEX);
    assert.match(head, /headerActionTwo: '⚙ 设置'/);
    assert.deepEqual(head.match(/headerAction\w*/g) ?? [], ['headerActionTwo']);
    assert.deepEqual(head.match(/onHeaderAction\w*/g) ?? [], ['onHeaderActionTwo']);
    assert.equal(head.includes('headerActionOne'), false);
  });

  test('indexHeader 守卫文件仍在且断言未被削弱', () => {
    const guard = readFileSync(HEADER_GUARD_PATH, 'utf8');
    assert.match(guard, /'✨ AI 汇总'/);
    assert.match(guard, /'headerActionOne'/);
    assert.match(guard, /headerActionTwo: '⚙ 设置'/);
  });

  test('append-throw 分支：catch → 保存失败 toast（含 toastMsFor）→ return false', () => {
    const fn = bodyFrom(INDEX, 'private submitQuickRecord(');
    const catchBody = bodyFrom(fn, 'catch (error)');
    assert.match(catchBody, /保存失败：/, 'catch 内必须有中文失败 toast');
    assert.match(catchBody, /toastMsFor\(true\)/, '失败 toast 必须给出时长');
    assert.match(catchBody, /return false;/, 'catch 内必须 return false');
    const toastAt = catchBody.indexOf('保存失败：');
    const returnAt = catchBody.indexOf('return false;');
    assert.ok(toastAt >= 0 && returnAt > toastAt, 'catch 内顺序必须是 toast → return false');
  });

  test('store-not-ready 守卫：文案 + return false 位于首次 appendRecord 之前', () => {
    const fn = bodyFrom(INDEX, 'private submitQuickRecord(');
    const notReady = bodyFrom(fn, 'if (!scheduleStore.isReady())');
    assert.match(notReady, /存储尚未就绪/, '未就绪分支必须有中文提示');
    assert.match(notReady, /return false;/, '未就绪分支必须 return false');
    const firstAppend = fn.indexOf('appendRecord(');
    assert.ok(firstAppend >= 0, '必须存在写入调用');
    assert.ok(fn.indexOf('if (!scheduleStore.isReady())') < firstAppend, '未就绪守卫必须在首次写入之前');
  });

  test('quickBusy：写入前置 true，catch 与成功路径各复位一次 false', () => {
    const fn = bodyFrom(INDEX, 'private submitQuickRecord(');
    assert.equal((fn.match(/this\.quickBusy = true;/g) ?? []).length, 1, '写入前恰好置一次 true');
    assert.equal((fn.match(/this\.quickBusy = false;/g) ?? []).length, 2, '恰好两处复位：catch 与成功路径');
    const trueAt = fn.indexOf('this.quickBusy = true;');
    const appendAt = fn.indexOf('appendRecord(record)');
    assert.ok(trueAt >= 0 && appendAt > trueAt, '必须先置 busy=true 再写入');
    const resets = [...fn.matchAll(/this\.quickBusy = false;/g)].map((m) => m.index);
    const catchStart = fn.indexOf('catch (error)');
    const catchReturnFalse = fn.indexOf('return false;', catchStart);
    assert.ok(resets[0] > catchStart && resets[0] < catchReturnFalse, 'catch 内 return false 前必须复位 busy');
    const returnTrueAt = fn.indexOf('return true;');
    assert.ok(resets[1] > catchStart && resets[1] < returnTrueAt, '成功路径 return true 前必须复位 busy');
  });

  test('defaultAuthorOrMe：null/空白回落「我」，否则返回 trim 后的作者', () => {
    const author = bodyFrom(INDEX, 'private defaultAuthorOrMe(');
    assert.match(author, /const settings = settingsStore\.cached\(\);/, '必须调用同步缓存 cached()');
    assert.match(author, /settings !== null/, '必须先做 null 检查');
    assert.match(author, /settings\.author\.trim\(\)\.length > 0/, '空白作者视为无作者');
    assert.match(author, /return settings\.author\.trim\(\);/, '命中时返回 trim 后的作者');
    assert.match(author, /return '我'/, '兜底返回「我」');
    const nullCheckAt = author.indexOf('settings !== null');
    const authorAccessAt = author.indexOf('settings.author');
    assert.ok(nullCheckAt >= 0 && authorAccessAt > nullCheckAt, 'null 检查必须先于 settings.author 访问');
    const trimmedReturnAt = author.indexOf('return settings.author.trim();');
    const fallbackAt = author.indexOf("return '我'");
    assert.ok(trimmedReturnAt < fallbackAt, 'trim 作者命中分支在前，「我」兜底在后');
  });
});
