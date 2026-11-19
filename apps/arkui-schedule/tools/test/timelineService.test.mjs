// mod-v2-read-service：v2 只读时间线服务 + 首页 flag 接线的静态契约测试。
//
// 服务层 import 了 @kit.*，无法在 Node 里运行，所以这里断言**代码形状**与它依赖的纯模型契约：
//   - timelineStore.ets 只复用 model/timeline 的解析函数，不含任何写 API；
//   - schema 门槛 / 读模式默认值 / useV2 组合 / 三条 degrade 路径都在源码里可证；
//   - Index.ets 只在 bootstrap / reload 加了最小分支，页头、PageLayout、v1 路径全部不动；
//   - 另从编译产物 import parseSchemaMarker，跑 2 条真实行为断言（版本 2 / 3）。
//
// 前置构建：node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { stripComments } from './helpers/etsSource.mjs';
import { requireOverlayRestored } from './guard.mjs';
import { parseSchemaMarker } from '../.build/model/timeline.js';

requireOverlayRestored('timelineService.test.mjs');

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..');
const SERVICE = readFileSync(join(APP, 'entry', 'src', 'main', 'ets', 'services', 'timelineStore.ets'), 'utf8');
const INDEX = readFileSync(join(APP, 'entry', 'src', 'main', 'ets', 'pages', 'Index.ets'), 'utf8');
const SERVICE_CODE = stripComments(SERVICE);
const INDEX_CODE = stripComments(INDEX);

/** 取「有返回类型 + 花括号」的方法声明体（避开 this.reload() 之类的调用点）。 */
function methodBody(code, name) {
  const signature = new RegExp(`\\b${name}\\s*\\([^)]*\\)\\s*:\\s*[^;{}]+\\{`);
  const matched = signature.exec(code);
  assert.ok(matched, `${name}() 声明未找到`);
  const open = code.indexOf('{', matched.index + matched[0].length - 1);
  assert.ok(open > 0, `${name}() 方法体起始花括号未找到`);
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '{') {
      depth += 1;
    } else if (code[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        return code.slice(open, i + 1);
      }
    }
  }
  throw new Error(`${name}() 花括号不配对`);
}

/** 从源码抽 DATE_KEY_RE 字面值，测试与实现共用同一份正则，避免各写一份造成假绿。 */
function dateKeyRegex() {
  const matched = /DATE_KEY_RE:\s*RegExp\s*=\s*(\/.*?\/[a-z]*)/.exec(SERVICE_CODE);
  assert.ok(matched, 'DATE_KEY_RE 声明未找到');
  const literal = matched[1];
  const split = literal.lastIndexOf('/');
  return new RegExp(literal.slice(1, split), literal.slice(split + 1));
}

/** 服务 import 了 @kit.* 无法在 Node 里 import：抽出 isCalendarDate() 的真实方法体求值。 */
function calendarCheck(date) {
  // ArkTS 的 `const x: number =` 不是合法 JS，求值前只剥这三处类型标注，逻辑一字不改。
  const body = methodBody(SERVICE_CODE, 'isCalendarDate').replace(/:\s*(?:number|string|boolean)\s*=/g, ' =');
  const factory = new Function('DATE_KEY_RE', `"use strict"; return function (name) ${body};`);
  return factory(dateKeyRegex())(date);
}

// ---------------------------------------------------------------- 服务：模型复用与只读边界

test('服务 import model/timeline 的五个解析/读函数，且没有自带解析器', () => {
  assert.match(SERVICE_CODE, /from '\.\.\/model\/timeline'/);
  for (const fn of ['parseSchemaMarker', 'parseTimelineDay', 'parseLedger', 'visibleRecords', 'openRecords', 'timelineDayPath']) {
    assert.match(SERVICE_CODE, new RegExp(`\\b${fn}\\b`), `缺少对 ${fn} 的复用`);
    assert.doesNotMatch(SERVICE_CODE, new RegExp(`function\\s+${fn}\\s*\\(`), `${fn} 不得在服务里重新实现`);
  }
});

test('服务里没有任何写 API（writeTextSync/writeSync/append/mkdirSync/unlinkSync/renameSync）', () => {
  assert.doesNotMatch(SERVICE, /writeTextSync|writeSync|append|mkdirSync|unlinkSync|renameSync/);
});

test('服务只用 CoreFileKit 的只读文件接口（readTextSync/accessSync/listFileSync）', () => {
  assert.match(SERVICE_CODE, /import \{ fileIo as fs \} from '@kit\.CoreFileKit'/);
  assert.match(SERVICE_CODE, /fs\.readTextSync/);
  assert.match(SERVICE_CODE, /fs\.accessSync/);
  assert.match(SERVICE_CODE, /fs\.listFileSync/);
});

test('schema 门槛：解析 schema.json 后 ok !== true 一律降级为非 v2', () => {
  const ensure = methodBody(SERVICE_CODE, 'ensureReady');
  assert.match(ensure, /const marker = parseSchemaMarker\(/);
  assert.match(ensure, /marker\.ok !== true/);
  assert.match(ensure, /this\.v2 = false/);
  assert.match(SERVICE, /schema\.json/);
});

test('isV2() 只有 ready 且标记明确为 v2 时才为真（降级路径可证）', () => {
  const body = methodBody(SERVICE_CODE, 'isV2');
  assert.match(body, /return this\.ready && this\.v2/);
  const isV2Index = SERVICE_CODE.indexOf('isV2()');
  const flagIndex = SERVICE_CODE.indexOf('useV2()');
  assert.ok(isV2Index < flagIndex);
});

test('readMode() 缺省返回 v1，且不把默认值写进 AppStorage', () => {
  const body = methodBody(SERVICE_CODE, 'readMode');
  assert.match(body, /AppStorage\.get<string>/);
  assert.match(body, /return stored === 'v2' \? 'v2' : 'v1'/);
  assert.doesNotMatch(body, /setOrCreate/);
});

test('setReadMode() 只接受 v1/v2，非法值直接忽略', () => {
  const body = methodBody(SERVICE_CODE, 'setReadMode');
  assert.match(body, /if \(mode !== 'v1' && mode !== 'v2'\) \{\s*return;\s*\}/);
  assert.match(body, /AppStorage\.setOrCreate<string>/);
});

test('读模式键名与 useV2() 组合条件逐字符匹配契约', () => {
  assert.match(SERVICE_CODE, /TIMELINE_READ_MODE_KEY:\s*string\s*=\s*'timeline\.readMode'/);
  const body = methodBody(SERVICE_CODE, 'useV2');
  assert.match(body, /return this\.isV2\(\) && this\.readMode\(\) === 'v2'/);
});

test('readDay 只读 records.json + deleted.jsonl + restore.jsonl，并应用 visibleRecords', () => {
  assert.match(SERVICE_CODE, /timelineDayPath\(date\)/);
  assert.match(SERVICE_CODE, /records\.json/);
  assert.match(SERVICE_CODE, /DELETED_FILE_NAME/);
  assert.match(SERVICE_CODE, /RESTORE_FILE_NAME/);
  const body = methodBody(SERVICE_CODE, 'readDay');
  assert.match(body, /visibleRecords\(day\.day, day\.deleted, day\.restored\)/);
  assert.doesNotMatch(body, /day\.allRecords/);
});

test('pendingRecords 走 openRecords（closed_at 派生），不用 done / 不碰 open.jsonl', () => {
  const body = methodBody(SERVICE_CODE, 'pendingRecords');
  assert.match(body, /openRecords\(loaded\.day, loaded\.deleted, loaded\.restored\)/);
  assert.doesNotMatch(body, /\.done\b/);
  assert.doesNotMatch(body, /openIndexStore/);
});

test('每个公开读方法都有 try/catch，异常只记一条 [tl] 日志并返回空', () => {
  for (const name of ['ensureReady', 'listDates', 'readDay', 'readAll', 'pendingRecords', 'readSummaryText']) {
    const body = methodBody(SERVICE_CODE, name);
    assert.match(body, /try\s*\{/, `${name}() 缺 try`);
    assert.match(body, /catch\s*\(/, `${name}() 缺 catch`);
  }
  const logs = SERVICE.match(/console\.info\('\[tl\]/g) || [];
  assert.ok(logs.length >= 6, `期望至少 6 条 [tl] 日志，实际 ${logs.length}`);
});

test('degrade：非 v2 时 readDay / readAll / pendingRecords 直接返回 []', () => {
  for (const name of ['readDay', 'readAll', 'pendingRecords']) {
    const body = methodBody(SERVICE_CODE, name);
    assert.match(body, /if \(!this\.isV2\(\)/, `${name}() 必须在非 v2 时降级`);
    assert.match(body, /return \[\]/, `${name}() 必须返回空数组`);
  }
});

test('非法日历日目录 2026-13-99 被跳过：不进 listDates、不被读取，且记一条计数日志', () => {
  const body = methodBody(SERVICE_CODE, 'listDates');
  assert.match(body, /if \(!DATE_KEY_RE\.test\(name\)\)/);
  assert.match(body, /if \(!this\.isCalendarDate\(name\)\)/);
  assert.match(body, /skipped \+= 1/);
  assert.match(body, /console\.info\('\[tl\] skipped invalid day dirs=' \+ skipped\)/);
  assert.ok(
    body.indexOf('this.isCalendarDate(name)') < body.indexOf('dates.push(name)'),
    '日历校验必须发生在 dates.push 之前'
  );
  // 对真实源码方法体求值：形状命中但非日历日的目录判非法
  assert.equal(calendarCheck('2026-13-99'), false);
  assert.equal(calendarCheck('2026-02-30'), false);
  // 直接按非法日期读也不能落盘；两处守卫都在读文件之前
  for (const name of ['readDay', 'readSummaryText']) {
    const read = methodBody(SERVICE_CODE, name);
    assert.match(read, /!this\.isCalendarDate\(date\)/, `${name}() 必须拒绝非法日历日`);
    assert.ok(read.indexOf('isCalendarDate(date)') < read.indexOf('try'), `${name}() 必须在读文件前拒绝`);
  }
});

test('合法闰日目录 2028-02-29 被接受：本地 new Date 往返校验通过', () => {
  assert.equal(calendarCheck('2028-02-29'), true);
  assert.equal(calendarCheck('2028-02-28'), true);
  assert.equal(calendarCheck('2026-02-29'), false); // 非闰年
  assert.equal(calendarCheck('0000-01-01'), false); // 年份下界
  const body = methodBody(SERVICE_CODE, 'isCalendarDate');
  assert.match(body, /if \(year < 1 \|\| year > 9999\)/);
  assert.match(body, /new Date\(year, month - 1, day\)/);
  assert.match(body, /probe\.setFullYear\(year\)/);
  assert.match(body, /probe\.getFullYear\(\) === year && probe\.getMonth\(\) === month - 1 && probe\.getDate\(\) === day/);
});

test('服务不调用 openIndexStore / reconcile，也不建立派生索引', () => {
  assert.doesNotMatch(SERVICE_CODE, /openIndexStore/);
  assert.doesNotMatch(SERVICE_CODE, /\breconcile\s*\(/);
  assert.doesNotMatch(SERVICE_CODE, /OPEN_INDEX|openIndex/);
});

test('服务导出契约要求的完整 API 与单例', () => {
  for (const name of [
    'ensureReady', 'isReady', 'isV2', 'readMode', 'setReadMode', 'useV2',
    'listDates', 'readDay', 'readAll', 'pendingRecords', 'readSummaryText'
  ]) {
    assert.match(SERVICE_CODE, new RegExp(`\\b${name}\\s*\\(`), `缺少 API ${name}`);
  }
  assert.match(SERVICE_CODE, /export class TimelineStore/);
  assert.match(SERVICE_CODE, /export const timelineStore: TimelineStore = new TimelineStore\(\)/);
});

// ---------------------------------------------------------------- 首页：最小 flag 接线

test('Index 导入 timelineStore，并在 bootstrap 中于 scheduleStore 之后 ensureReady', () => {
  assert.match(INDEX_CODE, /import \{ timelineStore \} from '\.\.\/services\/timelineStore'/);
  const body = methodBody(INDEX_CODE, 'bootstrap');
  assert.match(body, /await scheduleStore\.ensureReady/);
  assert.match(body, /await timelineStore\.ensureReady/);
  assert.ok(
    body.indexOf('scheduleStore.ensureReady') < body.indexOf('timelineStore.ensureReady'),
    'timelineStore.ensureReady 必须排在 scheduleStore.ensureReady 之后'
  );
});

test('reload 的 useV2() 分支位于两条 v1 取数分支之前', () => {
  const body = methodBody(INDEX_CODE, 'reload');
  const v2 = body.indexOf('timelineStore.useV2()');
  const v1 = body.indexOf('} else if (this.showAllPending)');
  assert.ok(v2 >= 0, 'reload 缺少 useV2() 分支');
  assert.ok(v1 >= 0, 'reload 缺少 v1 未完成分支');
  assert.ok(v2 < v1, 'v2 分支必须出现在 v1 分支之前');
});

test('v2 分支只读 timelineStore 的 readDay / pendingRecords，不触发 v1 写入或对账', () => {
  const body = methodBody(INDEX_CODE, 'reload');
  const start = body.indexOf('timelineStore.useV2()');
  const end = body.indexOf('} else if (this.showAllPending)');
  const branch = body.slice(start, end);
  assert.match(branch, /timelineStore\.readDay\(this\.selectedDate\)/);
  assert.match(branch, /timelineStore\.pendingRecords\(\)/);
  assert.doesNotMatch(branch, /openIndexStore|reconcile|loadSummary/);
  assert.doesNotMatch(branch, /appendRecord|saveText/);
});

test('reload 赋值后仍执行 refreshQuery + pruneSelection（筛选/排序逻辑不变）', () => {
  const body = methodBody(INDEX_CODE, 'reload');
  assert.match(body, /this\.refreshQuery\(\);/);
  assert.match(body, /this\.pruneSelection\(\);/);
  assert.ok(body.lastIndexOf('this.refreshQuery()') > body.indexOf('timelineStore.useV2()'));
});

test('本模块不写读模式开关默认值（无 AppStorage.setOrCreate 指向 timeline.readMode）', () => {
  assert.doesNotMatch(INDEX_CODE, /setOrCreate[^;]*timeline\.readMode/);
  assert.doesNotMatch(INDEX_CODE, /setOrCreate[^;]*TIMELINE_READ_MODE_KEY/);
  assert.doesNotMatch(SERVICE_CODE, /ensureReady[\s\S]{0,400}setOrCreate/);
});

test('bootstrap 的 v1 索引 reconcile() 由 !useV2() 守护（v2 启动零 v1 写）', () => {
  const body = methodBody(INDEX_CODE, 'bootstrap');
  const guarded = /if \(!timelineStore\.useV2\(\)\) \{\s*openIndexStore\.reconcile\(\);\s*\}/;
  assert.match(body, guarded, 'reconcile() 必须位于 !timelineStore.useV2() 分支内');
  assert.doesNotMatch(
    body.replace(guarded, ''),
    /openIndexStore\.reconcile\(\)/,
    'bootstrap 中不应存在未被守护的 reconcile()'
  );
});

test('onPageShow / reconcileSavedRow 的 v1 对账调用保持原样（未触碰）', () => {
  const onShow = methodBody(INDEX_CODE, 'onPageShow');
  assert.match(onShow, /openIndexStore\.reconcileIfDue\(\)/);
  const saved = methodBody(INDEX_CODE, 'reconcileSavedRow');
  assert.match(saved, /openIndexStore\.reconcile\(\)/);
});

test('页头注释与 PageLayout 结构未被本模块改动', () => {
  assert.match(INDEX, /页头唯一动作「⚙ 设置」/);
  assert.match(INDEX, /页头 AI 汇总入口已删除/);
  assert.match(INDEX_CODE, /PageLayout/);
});

// ---------------------------------------------------------------- 纯模型契约（编译产物真实行为）

test('parseSchemaMarker：版本 3 判为不支持（服务据此降级为 v1）', () => {
  const marker = parseSchemaMarker('{"schemaVersion":3}');
  assert.equal(marker.ok, false);
  assert.equal(marker.version, 3);
});

test('parseSchemaMarker：版本 2 判为通过（服务据此可进入 v2 读路径）', () => {
  const marker = parseSchemaMarker('{"schemaVersion":2}');
  assert.equal(marker.ok, true);
  assert.equal(marker.version, 2);
});
