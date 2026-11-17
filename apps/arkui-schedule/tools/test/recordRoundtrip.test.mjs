// 记录「字段保真」回归：cloneRecord 深拷贝 + encodeRecord/decodeLine 往返。
//
// 背景（两个 P0 缺陷，都会真丢用户数据）：
// 1. `cloneRecord` 曾经漏掉 `pageObjects`（手写板插入的框/图片/表格对象层）。
//    勾一次「完成」= clone 记录再追加新版本 → 旧版本被 `foldById` 折叠掉 → 对象层**永久消失**；
// 2. `encodeRecord` 曾经把 attachments 压成 `{sha256,name,pageIndex}`，丢掉 `archive`/`entry`
//    （按天 zip 归属与 zip 内条目名）→ 读侧把 zip 附件降级成散图路径 → 详情页取图失败。
//
// 这里把两条不变量钉死：clone 逐字段（含所有可选字段）且深拷贝；encode→decode 逐字段往返。
//
// 前置：先构建纯逻辑层
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { encodeRecord, decodeLine, appendRecord, parseJsonl, foldById } from '../.build/model/jsonl.js';
import { cloneRecord } from '../.build/model/types.js';

// `recordMerge.ts` 运行期 import `./jsonl`（无扩展名，ArkTS 要求）；
// Node 的 ESM 不做扩展名推断，这里只为测试进程补 `.js` 后缀（与 recordMerge.test.mjs 同法）。
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

const { mergeDayFile } = await import('../.build/model/recordMerge.js');

const APP = fileURLToPath(new URL('../../entry/src/main/ets/', import.meta.url));
const TYPES_SOURCE = readFileSync(join(APP, 'model/types.ts'), 'utf8');

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

/**
 * 手写板对象层 v2 文档（真实形态：`{version:2, pages:{<页 id>:[对象…]}}`）。
 * 刻意含中文键/中文值、嵌套引号、换行与反斜杠，用来证明 JSON 字符串是**逐字节**保真的。
 */
const PAGE_OBJECTS_V2 = JSON.stringify({
  version: 2,
  pages: {
    p1: [
      {
        id: 'obj-image-1',
        kind: 'image',
        rect: { x: 0.125, y: 0.25, w: 0.5, h: 0.375 },
        sha256: SHA_A,
        name: 'page-0-aaaaaaaa.jpg'
      },
      {
        id: 'obj-table-1',
        kind: 'table',
        rect: { x: 0.05, y: 0.6, w: 0.9, h: 0.3 },
        rows: 3,
        cols: 2,
        ocrEnabled: false
      }
    ],
    '页-2（备注）': [
      {
        id: 'obj-frame-1',
        kind: 'frame',
        rect: { x: 0, y: 0, w: 1, h: 1 },
        label: '公式 "E=mc^2" 与「中文引号」\n第二行带反斜杠 C:\\tmp'
      }
    ]
  }
});

/** 一条「每个可选字段都填满」的记录（覆盖 ScheduleRecord 的全部字段）。 */
function fullRecord() {
  return {
    id: 'rec-full-1',
    ts: '2026-11-17T09:30:00+08:00',
    title: '周会 · 第 12 次（排期）',
    body: '讨论排期\n第二行：补齐字段',
    ocr_text: '手写原文：进度 80%',
    author: '我',
    done: false,
    attachments: [
      {
        sha256: SHA_A,
        name: 'page-0-aaaaaaaa.jpg',
        pageIndex: 0,
        archive: '2026-11-17.zip',
        entry: 'page-0-aaaaaaaa.jpg'
      },
      {
        sha256: SHA_B,
        name: 'page-1-bbbbbbbb.jpg',
        pageIndex: 1,
        archive: '2026-11-17.zip',
        entry: 'page-1-bbbbbbbb.jpg',
        // 未来可能新增的子字段：往返与 clone 都不该把它吃掉
        mime: 'image/jpeg'
      }
    ],
    pageObjects: PAGE_OBJECTS_V2,
    ai_structured: '- 待办：补测试\n- 待办：发布',
    ai_processed: true,
    ocr_time: '2026-11-17T09:31:12+08:00'
  };
}

/** 最小合法记录（不含任何可选字段）。 */
function minimalRecord() {
  return {
    id: 'rec-min-1',
    ts: '2026-11-17T10:00:00+08:00',
    title: '最小记录',
    body: '',
    author: '我',
    done: false,
    ai_processed: false
  };
}

/** 从 `model/types.ts` 源码里取 `ScheduleRecord` 的可选字段清单（`?:` 顶层字段）。 */
function optionalFieldsOfScheduleRecord() {
  const start = TYPES_SOURCE.indexOf('export interface ScheduleRecord {');
  assert.notEqual(start, -1, 'types.ts 里必须能找到 export interface ScheduleRecord');
  const nextExport = TYPES_SOURCE.indexOf('\nexport ', start + 10);
  const block = nextExport === -1 ? TYPES_SOURCE.slice(start) : TYPES_SOURCE.slice(start, nextExport);
  const names = [];
  for (const matched of block.matchAll(/^\s{2}([a-z_][a-z0-9_]*)\?:/gim)) {
    names.push(matched[1]);
  }
  return names;
}

// ---------------------------------------------------------------- cloneRecord

test('cloneRecord：保留 pageObjects（v2 按页 JSON，含中文/嵌套引号），改 clone 不影响原件', () => {
  const original = fullRecord();
  const copy = cloneRecord(original);

  assert.equal(copy.pageObjects, PAGE_OBJECTS_V2, 'cloneRecord 必须带上 pageObjects');
  assert.equal(JSON.parse(copy.pageObjects).version, 2);
  assert.deepEqual(Object.keys(JSON.parse(copy.pageObjects).pages), ['p1', '页-2（备注）']);

  // 改 clone 的 pageObjects 不得回写原记录
  copy.pageObjects = '{"version":2,"pages":{}}';
  assert.equal(original.pageObjects, PAGE_OBJECTS_V2, 'clone 与原记录不能共享同一字段的引用链');

  // 完整对象相等（含 attachments 的每个子字段）
  assert.deepEqual(cloneRecord(original), original);
});

test('cloneRecord：attachments 深拷贝（数组与每条附件都不共享引用），archive/entry/mime 一个不丢', () => {
  const original = fullRecord();
  const copy = cloneRecord(original);

  assert.notEqual(copy.attachments, original.attachments, '附件数组必须是新数组');
  assert.equal(copy.attachments.length, 2);
  for (let index = 0; index < original.attachments.length; index++) {
    assert.notEqual(copy.attachments[index], original.attachments[index], `attachments[${index}] 必须是新对象`);
    assert.equal(copy.attachments[index].archive, '2026-11-17.zip');
    assert.equal(copy.attachments[index].entry, `page-${index}-${index === 0 ? 'aaaaaaaa' : 'bbbbbbbb'}.jpg`);
  }
  assert.equal(copy.attachments[1].mime, 'image/jpeg', '未知子字段也要跟着 clone');

  // 改 clone 的附件不能污染原记录
  copy.attachments[0].pageIndex = 99;
  copy.attachments[0].entry = 'hacked.jpg';
  copy.attachments.push({ sha256: SHA_A, name: 'extra.png', pageIndex: 2 });
  assert.equal(original.attachments.length, 2);
  assert.equal(original.attachments[0].pageIndex, 0);
  assert.equal(original.attachments[0].entry, 'page-0-aaaaaaaa.jpg');
});

test('cloneRecord：ScheduleRecord 的每一个可选字段都被覆盖（清单取自接口源码）', () => {
  const optional = optionalFieldsOfScheduleRecord();
  // 新增可选字段时这条会失败 —— 提醒同步更新 fullRecord() 与 cloneRecord()
  assert.deepEqual(
    optional.sort(),
    ['ai_structured', 'attachments', 'ocr_text', 'ocr_time', 'pageObjects'],
    `ScheduleRecord 可选字段清单变了：${optional.join(', ')}`
  );

  const original = fullRecord();
  const copy = cloneRecord(original);
  for (const key of optional) {
    assert.equal(key in copy, true, `cloneRecord 丢了可选字段 ${key}`);
    assert.deepEqual(copy[key], original[key], `cloneRecord 改写了可选字段 ${key}`);
  }
  assert.deepEqual(Object.keys(copy).sort(), Object.keys(original).sort(), '字段集合必须与原件一致（不多不少）');
});

test('cloneRecord：不含可选字段的记录不产生多余键（key 集合与原件一致）', () => {
  const original = minimalRecord();
  const copy = cloneRecord(original);
  assert.deepEqual(Object.keys(copy), ['id', 'ts', 'title', 'body', 'author', 'done', 'ai_processed']);
  assert.equal('pageObjects' in copy, false, '没有 pageObjects 时不得凭空塞空串');
  assert.equal('attachments' in copy, false);
  assert.deepEqual(copy, original);
});

// ---------------------------------------------------------------- encode/decode 往返

test('encodeRecord→decodeLine 往返：attachments 的 sha256/name/pageIndex/archive/entry/mime 全在', () => {
  const original = fullRecord();
  const decoded = decodeLine(encodeRecord(original));
  assert.notEqual(decoded, null, '合法记录必须能读回');

  assert.deepEqual(decoded.attachments, original.attachments, '附件子字段必须逐字段往返');
  assert.deepEqual(Object.keys(decoded.attachments[0]), ['sha256', 'name', 'pageIndex', 'archive', 'entry']);
  assert.equal(decoded.attachments[0].sha256, SHA_A);
  assert.equal(decoded.attachments[0].name, 'page-0-aaaaaaaa.jpg');
  assert.equal(decoded.attachments[0].pageIndex, 0);
  assert.equal(decoded.attachments[0].archive, '2026-11-17.zip');
  assert.equal(decoded.attachments[0].entry, 'page-0-aaaaaaaa.jpg');
  assert.equal(decoded.attachments[1].mime, 'image/jpeg', '未知子字段也必须透传（不能被白名单吃掉）');
});

test('encodeRecord→decodeLine 往返：pageObjects 原样保留（中文/引号/换行不丢）', () => {
  const original = fullRecord();
  const decoded = decodeLine(encodeRecord(original));
  assert.equal(decoded.pageObjects, PAGE_OBJECTS_V2, 'pageObjects 必须逐字节往返');
  assert.deepEqual(JSON.parse(decoded.pageObjects), JSON.parse(PAGE_OBJECTS_V2));
  const frame = JSON.parse(decoded.pageObjects).pages['页-2（备注）'][0];
  assert.equal(frame.label, '公式 "E=mc^2" 与「中文引号」\n第二行带反斜杠 C:\\tmp', '引号/换行/反斜杠不得被吞');
  assert.match(decoded.pageObjects, /\\"E=mc\^2\\"/, 'JSON 文本里应是转义后的引号');
});

test('encodeRecord：旧格式附件（无 archive/entry）往返后不新增空键', () => {
  const legacy = {
    ...minimalRecord(),
    attachments: [{ sha256: SHA_A, name: `${SHA_A}.png`, pageIndex: 0 }]
  };
  const line = encodeRecord(legacy);
  assert.equal(line.includes('archive'), false, '旧数据不得凭空长出 archive');
  assert.equal(line.includes('entry'), false, '旧数据不得凭空长出 entry');

  const decoded = decodeLine(line);
  assert.deepEqual(Object.keys(decoded.attachments[0]), ['sha256', 'name', 'pageIndex']);
  assert.deepEqual(decoded.attachments, legacy.attachments);
});

test('encodeRecord：坏 sha256 / 缺字段的附件仍被拒绝（不放宽校验）', () => {
  const base = minimalRecord();
  const bad = [
    { sha256: '', name: 'x.png', pageIndex: 0 },
    { sha256: 42, name: 'x.png', pageIndex: 0 },
    { sha256: SHA_A, name: '', pageIndex: 0 },
    { sha256: SHA_A, name: 'x.png', pageIndex: -1 },
    { sha256: SHA_A, name: 'x.png', pageIndex: Number.NaN },
    { sha256: 'x' }
  ];
  for (const item of bad) {
    assert.throws(
      () => encodeRecord({ ...base, attachments: [item] }),
      /attachments/,
      `坏附件必须被拒绝：${JSON.stringify(item)}`
    );
  }

  // 读侧同样拒绝：手工拼一行坏附件
  const brokenLine = `${JSON.stringify({
    ...base,
    attachments: [{ sha256: '', name: 'x.png', pageIndex: 0 }]
  })}\n`;
  assert.equal(decodeLine(brokenLine), null, '坏 sha256 的行必须整行判坏（不静默降级）');
});

test('encodeRecord：attachments 为空数组时不产生脏字段', () => {
  const line = encodeRecord({ ...minimalRecord(), attachments: [] });
  const parsed = JSON.parse(line);
  assert.deepEqual(parsed.attachments, []);
  assert.equal(line.includes('archive'), false);
  assert.equal(line.includes('entry'), false);
  assert.deepEqual(Object.keys(parsed), ['id', 'ts', 'title', 'body', 'author', 'done', 'attachments', 'ai_processed']);
  assert.deepEqual(decodeLine(line).attachments, []);
});

test('encodeRecord：同一记录两次编码逐字节相同（字段顺序固定，diff 友好）', () => {
  const original = fullRecord();
  const first = encodeRecord(original);
  const second = encodeRecord(decodeLine(first));
  assert.equal(first, second, '编码必须幂等：往返一次不得改变行文本');
  // pageObjects 的字段位置固定（在 attachments 之后、ai_structured 之前）
  const keys = Object.keys(JSON.parse(first));
  assert.ok(keys.indexOf('pageObjects') > keys.indexOf('attachments'));
  assert.ok(keys.indexOf('pageObjects') < keys.indexOf('ai_structured'));
});

// ---------------------------------------------------------------- 真实缺陷场景回归

test('回归：勾完成（cloneRecord→done:true→appendRecord→foldById）后 pageObjects 与 zip 附件仍在', () => {
  const original = fullRecord();
  const before = encodeRecord(original);

  // 首页「勾完成」的真实链路：clone → 改 done/ts → 追加一行
  const next = cloneRecord(original);
  next.done = true;
  next.ts = '2026-11-17T10:00:00+08:00';
  const text = appendRecord(before, next);

  const parsed = parseJsonl(text);
  assert.equal(parsed.errors.length, 0, '追加的行必须合法');
  assert.equal(parsed.records.length, 2);

  const folded = foldById(parsed.records);
  assert.equal(folded.length, 1, '同 id 折叠成一条（较晚者胜）');
  const winner = folded[0];
  assert.equal(winner.done, true);
  assert.equal(winner.pageObjects, PAGE_OBJECTS_V2, '勾完成后手写对象层不能消失');
  assert.deepEqual(winner.attachments, original.attachments, '勾完成后 zip 归属/条目名不能丢');
});

test('recordMerge：行级合并出口保真 pageObjects 与 archive/entry（含冲突明细行）', () => {
  const base = fullRecord();
  const local = encodeRecord({ ...base, ts: '2026-11-17T11:00:00+08:00' });
  const remote = encodeRecord({ ...base, ts: '2026-11-17T11:00:00+08:00', body: '远端改过的正文' });

  const merged = mergeDayFile(local, remote);
  assert.equal(merged.stats.conflicts, 1, '同 id 同 ts 不同内容 = 一处冲突');
  assert.equal(merged.stats.errors, 0);

  // 冲突明细里的规范行必须保真（UI 会拿它做预览）
  const localLine = JSON.parse(merged.conflictDetails[0].localLine);
  assert.equal(localLine.pageObjects, PAGE_OBJECTS_V2);
  assert.equal(localLine.attachments[0].archive, '2026-11-17.zip');
  assert.equal(localLine.attachments[0].entry, 'page-0-aaaaaaaa.jpg');

  // 写回文本（mergeDayFile.text）同样保真
  const written = JSON.parse(merged.text.trim());
  assert.equal(written.pageObjects, PAGE_OBJECTS_V2);
  assert.deepEqual(written.attachments, base.attachments);
});
