// mod-v2-dual-write-off：条件翻转 + 写入门面 + 停放失败语义的行为/静态契约测试。
//
// 前置构建：node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
// 纯模型（model/timelineMode.ts 等）从 ../.build 导入；.ets 服务 import @kit.* 无法在 Node
// 运行，按本仓既有口径做源码形状断言（stripComments 后剥掉注释，行号保持与源文件一致）。
//
// 覆盖：decideMode 四分支 + 纯函数性；v2 写入→读回同一条记录；v1 决策不产出任何 v2 文本；
//       七调用点接线；v2 分支零 v1 回落；停放后抛出 E_V2_WRITE_PARKED；零 devices/** 写删；
//       outbox 仓库外路径 + tmp/回读/rename + intentId 去重；flip 只在 v2 决策后；bootstrap 单条提示。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { matchBrace, stripComments } from './helpers/etsSource.mjs';
import { requireOverlayRestored } from './guard.mjs';

requireOverlayRestored('dualWriteOff.test.mjs');

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..');
/** 相对 `entry/src/main/ets` 读源码（本批模块的根）。 */
function readSrc(rel) {
  return readFileSync(join(APP, 'entry', 'src', 'main', 'ets', rel), 'utf8');
}

// 编译产物里的 `import ... from './timeline'` 不带 .js（ArkTS 要求），Node ESM 需补后缀。
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error !== null && typeof error === 'object' &&
          error.code === 'ERR_MODULE_NOT_FOUND' &&
          specifier.startsWith('.') && !specifier.endsWith('.js')) {
        return nextResolve(`${specifier}.js`, context);
      }
      throw error;
    }
  }
});

const { decideMode } = await import('../.build/model/timelineMode.js');
const { parseTimelineDay, visibleRecords } = await import('../.build/model/timeline.js');
const { planUpsert, buildRecordsText } = await import('../.build/model/timelineWrite.js');

// ---------------------------------------------------------------- 源码形状工具

/** 取方法声明体（签名 + 可选返回类型 + 花括号）。 */
function methodBody(code, name) {
  const signature = new RegExp(`\\b${name}\\s*\\([^)]*\\)(?:\\s*:[^{;]+)?\\s*\\{`);
  const matched = signature.exec(code);
  assert.ok(matched, `${name}() 声明未找到`);
  const open = code.indexOf('{', matched.index + matched[0].length - 1);
  assert.ok(open > 0, `${name}() 起始花括号未找到`);
  const [start, end] = matchBrace(code, open);
  return { body: code.slice(start, end), open: start, close: end };
}

/** 文件里某个方法调用出现的 1 起始行号列表。 */
function callLines(rel, invocation) {
  const lines = readSrc(rel).split('\n');
  const out = [];
  lines.forEach((line, index) => {
    if (line.includes(invocation)) {
      out.push(index + 1);
    }
  });
  return out;
}

const MODE_MODEL = 'model/timelineMode.ts';
const OUTBOX_SVC = 'services/outboxStore.ets';
const WRITER_SVC = 'services/recordWriter.ets';
const SWITCH_SVC = 'services/timelineModeSwitch.ets';
const INDEX_PAGE = 'pages/Index.ets';
const EDITOR_CMP = 'components/RecordEditorView.ets';
const DETAIL_CMP = 'components/RecordDetailView.ets';

const DAY = '2026-11-19';
const TS = `${DAY}T09:30:00+08:00`;
const RECORD = {
  id: 'm9x2k1-3fk', ts: TS, title: '周会', body: '讨论同步方案',
  author: '我', done: false, media: [], ai_processed: false, opened_at: TS
};

/** 模拟调用点：仅当决策为 v2 才产出 v2 文本，否则保持空串（证明 v1 不产生任何 v2 字节）。 */
function writeIfV2(schemaText) {
  const decision = decideMode(schemaText);
  if (decision.mode !== 'v2') {
    return { decision: decision, text: '' };
  }
  const base = parseTimelineDay(buildRecordsText(DAY, []), DAY);
  const plan = planUpsert(DAY, base.day.allRecords, RECORD);
  assert.equal(plan.ok, true, 'v2 upsert 计划应当成立');
  return { decision: decision, text: plan.text };
}

// ---------------------------------------------------------------- 集成：模式决策 + 写入 + 读回

test('1 decideMode: schemaVersion=2 → v2 / ok / 空原因', () => {
  assert.deepEqual(decideMode('{"schemaVersion":2}'), { mode: 'v2', code: 'ok', reason: '' });
  // 额外非语义键（契约 §10 P2-4：读侧只解析 schemaVersion）同样放行。
  assert.equal(decideMode('{"schemaVersion":2,"migratedAt":"x"}').mode, 'v2');
});

test('2 decideMode: 未知版本 3 → v1 / E_SCHEMA_UNKNOWN / 原因含 3', () => {
  const result = decideMode('{"schemaVersion":3}');
  assert.equal(result.mode, 'v1');
  assert.equal(result.code, 'E_SCHEMA_UNKNOWN');
  assert.match(result.reason, /3/);
});

test('3 decideMode: 垃圾 JSON / 非对象 / 缺字段 / 字符串版本 → v1 / E_SCHEMA_UNKNOWN', () => {
  for (const text of ['not-json', '[]', 'null', '{}', '{"schemaVersion":"2"}']) {
    const result = decideMode(text);
    assert.equal(result.mode, 'v1', text);
    assert.equal(result.code, 'E_SCHEMA_UNKNOWN', text);
    assert.ok(result.reason.length > 0, text);
  }
});

test('4 decideMode: 缺标记（空串 / 空白）→ v1 / E_SCHEMA_MISSING', () => {
  for (const text of ['', '   ', '\n\t']) {
    const result = decideMode(text);
    assert.equal(result.mode, 'v1', JSON.stringify(text));
    assert.equal(result.code, 'E_SCHEMA_MISSING', JSON.stringify(text));
    assert.match(result.reason, /缺少 timeline\/schema\.json/);
  }
});

test('5 decideMode 是纯函数：同输入恒同输出、源码无墙钟 / 文件 / AppStorage 副作用', () => {
  const a = decideMode('{"schemaVersion":2}');
  const b = decideMode('{"schemaVersion":2}');
  assert.deepEqual(a, b);
  const code = stripComments(readSrc(MODE_MODEL));
  assert.doesNotMatch(code, /Date\.now|new Date\(|fs\.|AppStorage|writeTextSync|renameSync|unlinkSync|rmSync/);
  assert.doesNotMatch(code, /devices\//);
});

test('6 集成：v2 决策 → planUpsert 写文本 → parseTimelineDay + visibleRecords 读回同一条记录', () => {
  const result = writeIfV2('{"schemaVersion":2}');
  assert.equal(result.decision.mode, 'v2');
  assert.ok(result.text.length > 0, 'v2 分支必须产出文本');
  const parsed = parseTimelineDay(result.text, DAY);
  assert.equal(parsed.day !== null, true);
  assert.equal(parsed.errors.length, 0, '产出的文本必须能被读侧无错解析');
  const visible = visibleRecords(parsed.day, [], []);
  assert.equal(visible.length, 1);
  assert.equal(visible[0].id, RECORD.id);
  assert.equal(visible[0].ts, RECORD.ts);
  assert.equal(visible[0].title, RECORD.title);
});

test('7 集成：planUpsert 结果与 buildRecordsText 同一记录逐字节一致（确定性）', () => {
  const result = writeIfV2('{"schemaVersion":2}');
  const direct = buildRecordsText(DAY, [RECORD]);
  assert.ok(direct.length > 0);
  assert.equal(result.text, direct);
  assert.equal(buildRecordsText(DAY, [RECORD]), direct, '同输入两次字节相等');
});

test('8 集成：未知版本 / 垃圾 / 缺标记一律不产出任何 v2 文本', () => {
  for (const text of ['{"schemaVersion":3}', 'garbage', '']) {
    const result = writeIfV2(text);
    assert.equal(result.decision.mode, 'v1', text);
    assert.equal(result.text, '', text);
  }
});

test('9 集成：v1 分支不触碰写文本 API（源码层证明调用点被 mode 判定挡住）', () => {
  // writeIfV2 的实现即被测契约：只有 decision.mode==='v2'（且显式激活）才执行 planUpsert。
  const source = stripComments(readSrc('services/timelineModeSwitch.ets'));
  assert.match(source, /decideMode\(schemaText\)/);
  assert.match(source, /if \(decision\.mode === 'v2' && !this\.writeActivated\(\)\)/);
  assert.match(source, /if \(decision\.mode === 'v2'\)/);
  // v2 写入块（含激活闸）之外只有 return 结果对象，没有任何写函数调用。
  const apply = methodBody(source, 'applyMode').body;
  const notActivated = apply.indexOf('E_V2_WRITE_NOT_ACTIVATED');
  const notActivatedEnd = apply.indexOf('}', apply.indexOf('reason:', notActivated));
  const gateSlice = apply.slice(notActivated, notActivatedEnd);
  assert.doesNotMatch(gateSlice, /setReadMode|append|writeText|scheduleDelete/);
  const lastReturn = apply.lastIndexOf('return { mode: \'v1\'');
  assert.ok(lastReturn > notActivatedEnd, 'v1 兜底 return 必须在激活闸之后');
  const tail = apply.slice(lastReturn);
  assert.doesNotMatch(tail, /setReadMode|append|writeText|scheduleDelete/);
});

// ---------------------------------------------------------------- 静态：七调用点与翻转接线

test('10 七个 v1 写调用点全部经 recordWriter（原 544/822/918/950/1093/663/193）', () => {
  // 七个锚点全部直调 recordWriter：Index 5 处（快速记录 / 勾选 / 删除 / 撤销 / AI 回写）、
  // 编辑器保存 1 处、详情页 AI 回写 1 处。没有任何一处再直连 v1 scheduleStore。
  assert.equal(callLines(INDEX_PAGE, 'recordWriter.writeRecord(').length, 3);
  assert.equal(callLines(INDEX_PAGE, 'recordWriter.deleteRecord(').length, 1);
  assert.equal(callLines(INDEX_PAGE, 'recordWriter.restoreRecord(').length, 1);
  assert.equal(callLines(EDITOR_CMP, 'recordWriter.writeRecord(').length, 1);
  assert.equal(callLines(DETAIL_CMP, 'recordWriter.writeRecord(').length, 1);
  const total = 3 + 1 + 1 + 1 + 1;
  assert.equal(total, 7, '恰好七个写入锚点');
  for (const rel of [INDEX_PAGE, EDITOR_CMP, DETAIL_CMP]) {
    assert.equal(callLines(rel, 'scheduleStore.appendRecord(').length, 0, rel + ' 不得直连 v1 写入');
  }
});

test('11 三个 UI 文件均经 recordWriter：全部直调，不再有 appendRecord 局部别名', () => {
  for (const rel of [INDEX_PAGE, EDITOR_CMP, DETAIL_CMP]) {
    const code = stripComments(readSrc(rel));
    assert.match(code, /import \{ recordWriter \}/, `${rel} 缺少 recordWriter import`);
    assert.doesNotMatch(code, /scheduleStore\.appendRecord/, `${rel} 不得再有 v1 直连写入`);
    assert.doesNotMatch(code, /const scheduleStore:\s*\{/, `${rel} 不得再用局部别名冒充分流`);
  }
});

test('12 bootstrap 在既有 ensureReady 之后 applyMode，且仅一条 typed 提示（配置了仓库才显示）', () => {
  const code = stripComments(readSrc(INDEX_PAGE));
  const boot = methodBody(code, 'bootstrap').body;
  const readyAt = boot.indexOf('openIndexStore.ensureReady');
  const applyAt = boot.indexOf('timelineModeSwitch.applyMode');
  assert.ok(readyAt > 0 && applyAt > readyAt, 'applyMode 必须在既有 ensureReady 之后');
  assert.match(boot, /modeResult\.mode === 'v1' && modeResult\.code !== 'ok'/);
  assert.match(boot, /settingsStore\.cached\(\)/);
  assert.match(boot, /repoUrl\.trim\(\)\.length > 0/);
  assert.match(boot, /promptAction\.showToast\(\{ message: modeResult\.reason/);
  assert.equal((boot.match(/modeResult\.reason/g) || []).length, 1, '只弹一条 toast');
  assert.match(code, /import \{ timelineModeSwitch \}/);
});

// ---------------------------------------------------------------- 静态：失败语义 / 数据边界

test('13 recordWriter 的三个 v2 分支零 scheduleStore.appendRecord（无静默 v1 回落）', () => {
  const code = stripComments(readSrc(WRITER_SVC));
  for (const name of ['writeRecord', 'deleteRecord', 'restoreRecord']) {
    const { body } = methodBody(code, name);
    const ifAt = body.indexOf('if (this.useV2())');
    assert.ok(ifAt >= 0, `${name} 缺少 useV2 分流`);
    const open = body.indexOf('{', ifAt);
    const [start, end] = matchBrace(body, open);
    const branch = body.slice(start, end);
    assert.doesNotMatch(branch, /scheduleStore\.appendRecord/, `${name} 的 v2 分支不得写 v1`);
    assert.match(body.slice(end), /scheduleStore\.appendRecord\(record\)/, `${name} 的 v1 路径仍在`);
  }
  // 全文件恰好三处 v1 写（各方法的翻转前路径），没有第四处。
  assert.equal((code.match(/scheduleStore\.appendRecord/g) || []).length, 3);
  assert.match(code, /useV2\(\): boolean \{\s*return timelineStore\.useV2\(\);/);
});

test('14 失败路径：先 makeIntentId + outboxStore.enqueue 停放，再抛 E_V2_WRITE_PARKED（中文原因 + 已存入待同步队列）', () => {
  const code = stripComments(readSrc(WRITER_SVC));
  const { body } = methodBody(code, 'parkAndThrow');
  const intentAt = body.indexOf('makeIntentId(');
  const enqueueAt = body.indexOf('outboxStore.enqueue(');
  const throwAt = body.indexOf('E_V2_WRITE_PARKED');
  assert.ok(intentAt > 0 && enqueueAt > intentAt && throwAt > enqueueAt,
    '顺序必须是 构造意图 → 停放 → 抛出');
  assert.match(body, /E_V2_WRITE_PARKED: v2 写入失败（\$\{reason\}）/);
  assert.match(body, /已存入待同步队列/);
  assert.doesNotMatch(body, /scheduleStore|appendRecord|timelineWriteStore/, '停放函数内无任何写回落');
  // 三个 v2 catch 都调用 parkAndThrow，无吞错分支。
  for (const name of ['writeRecord', 'deleteRecord', 'restoreRecord']) {
    const m = methodBody(code, name).body;
    assert.match(m, /catch \(error\) \{\s*this\.parkAndThrow\(/, `${name} 的 catch 必须停放并抛出`);
  }
});

test('15 四个新文件零 devices/** 写入 / 删除 / 迁移（v1 数据物理保留）', () => {
  for (const rel of [MODE_MODEL, OUTBOX_SVC, WRITER_SVC, SWITCH_SVC]) {
    const code = stripComments(readSrc(rel));
    assert.doesNotMatch(code, /devices\//, `${rel} 不得出现 devices/ 路径`);
    assert.doesNotMatch(code, /unlinkSync|rmSync|rmdirSync|deleteFile|migrate/, `${rel} 不得删/迁移 v1`);
    assert.doesNotMatch(code, /AppStorage\.setOrCreate/, `${rel} 不得自行写 AppStorage`);
  }
});

// ---------------------------------------------------------------- 静态：outbox 与 flip

test('16 outboxStore：路径在 git-repo 之外 + tmp 写/回读/rename + intentId 去重', () => {
  const code = stripComments(readSrc(OUTBOX_SVC));
  assert.match(code, /sync-outbox\.json/);
  const pathBody = methodBody(code, 'outboxPath').body;
  assert.ok(pathBody.includes('this.filesDir') && pathBody.includes('OUTBOX_FILE_NAME'));
  assert.doesNotMatch(pathBody, /git-repo/);
  const writeBody = methodBody(code, 'writeOutbox').body;
  assert.match(writeBody, /TMP_INFIX/);
  assert.match(writeBody, /this\.writeTextSync/);
  assert.match(writeBody, /fs\.readTextSync/);
  assert.match(writeBody, /!==\s*text/);
  assert.match(writeBody, /fs\.renameSync/);
  assert.doesNotMatch(writeBody, /unlinkSync|rmSync/);
  const enqueueBody = methodBody(code, 'enqueue').body;
  assert.match(enqueueBody, /intentId/);
  assert.match(code, /enqueue\(entry: OutboxEntry\)|list\(\): OutboxEntry\[\]|remove\(intentId: string\)|clear\(\): void/);
});

test('17 timelineModeSwitch：仅 v2 决策后才 setReadMode("v2")，且全文件只有这一处', () => {
  const code = stripComments(readSrc(SWITCH_SVC));
  const apply = methodBody(code, 'applyMode').body;
  const decisionAt = apply.indexOf("decision.mode === 'v2'");
  const setAt = apply.indexOf("setReadMode('v2')");
  assert.ok(decisionAt > 0 && setAt > decisionAt, 'setReadMode 必须在 v2 决策之后');
  assert.equal((code.match(/setReadMode\(/g) || []).length, 1, '唯一允许的 AppStorage 写');
  assert.match(apply, /await timelineStore\.ensureReady/);
  assert.match(apply, /await timelineWriteStore\.ensureReady/);
  assert.match(apply, /await outboxStore\.ensureReady/);
  assert.doesNotMatch(apply, /scheduleStore|appendRecord|devices\//);
});

test('17b 第二道闸：未激活（默认）时即使 schema=v2 也不翻转，返回 E_V2_WRITE_NOT_ACTIVATED', () => {
  const code = stripComments(readSrc('services/timelineModeSwitch.ets'));
  const apply = methodBody(code, 'applyMode').body;
  const gateAt = apply.indexOf('writeActivated()');
  const setAt = apply.indexOf("setReadMode('v2')");
  assert.ok(gateAt > 0 && setAt > gateAt, '激活闸必须在 setReadMode 之前');
  assert.match(apply, /E_V2_WRITE_NOT_ACTIVATED/);
  assert.match(code, /V2_WRITE_ENABLED_KEY: string = 'timeline\.v2WriteEnabled'/);
  assert.match(code, /AppStorage\.get<boolean>\(V2_WRITE_ENABLED_KEY\) === true/);
  // 默认缺失 = 未激活：没有任何地方写入该键（只能由显式激活流程写）。
  assert.equal((code.match(/setOrCreate[^\n]*V2_WRITE_ENABLED_KEY/g) || []).length, 0,
    '本模块不得写激活位');
});

test('18 无新依赖：四个新文件只 import @kit 内置与仓内相对模块', () => {
  for (const rel of [MODE_MODEL, OUTBOX_SVC, WRITER_SVC, SWITCH_SVC]) {
    const imports = [...readSrc(rel).matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    for (const spec of imports) {
      assert.ok(
        spec.startsWith('@kit.') || spec.startsWith('../model/') || spec.startsWith('./'),
        `${rel} 出现未授权依赖：${spec}`
      );
    }
  }
});
