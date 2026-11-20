// mod-v2-import-v1：纯核心 + 假 IO 的端到端测试（fixture 仓库，零写 devices/）。
//
// 前置：node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
// 覆盖：plan 算术 / 折叠与裁决 / 账本 / 媒体 / 五类 typed 拒绝 / 写序 / schema-last /
//       中断重跑幂等 / devices 字节不变 / 静态接线断言。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import test from 'node:test';
import zlib from 'node:zlib';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error && error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.js')) {
        return nextResolve(`${specifier}.js`, context);
      }
      throw error;
    }
  }
});

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = path.resolve(HERE, '../../../..');
const M = await import('../.build/model/importV1.js');
const DAY = '2026-11-19';
const NEXT = '2026-11-20';
const SHA = 'ab'.repeat(32);
const SHA2 = 'cd'.repeat(32);
const ENTRY = 'page-0-abcd1234.jpg';

// ---------------------------------------------------------------- fixture helpers

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const packed = entry.method === 8 ? zlib.deflateRawSync(entry.data) : Buffer.from(entry.data);
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, packed);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(packed.length, 20);
    cen.writeUInt32LE(entry.data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([cen, name]));
    offset += local.length + name.length + packed.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

function fixture(t, name = 'v1') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `importv1-${name}-`));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repo, 'devices'), { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, repo, zips: new Map(), out: path.join(dir, 'out') };
}
function schedule(ctx, device, day, rows) {
  const file = path.join(ctx.repo, 'devices', device, 'schedules', `${day}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => typeof r === 'string' ? r : JSON.stringify(r)).join('\n') + '\n', 'utf8');
}
function open(ctx, device, lines) {
  const file = path.join(ctx.repo, 'devices', device, 'open.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((r) => typeof r === 'string' ? r : JSON.stringify(r)).join('\n') + '\n', 'utf8');
}
function summary(ctx, device, day, doc) {
  const file = path.join(ctx.repo, 'devices', device, 'summaries', `${day}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(doc), 'utf8');
}
function zip(ctx, device, archive, entries) {
  const file = path.join(ctx.repo, 'devices', device, 'attachments', archive);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, makeZip(entries));
  ctx.zips.set(archive, entries);
}
function record(id, ts, overrides = {}) {
  return { id, ts, title: `标题-${id}`, body: '正文', author: '我', done: false, ai_processed: false, ...overrides };
}
function attachment(entryName = ENTRY, archive = `${DAY}.zip`, sha = SHA, pageIndex = 0) {
  return { sha256: sha, name: entryName, pageIndex, archive, entry: entryName };
}
function snapshot(dir) {
  const out = new Map();
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out.set(path.relative(dir, full).split(path.sep).join('/'), sha256(fs.readFileSync(full)));
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

/** 把 fixture 仓库读成纯核心输入（只走 node:fs，模拟 .ets 服务的读侧）。 */
function buildInput(ctx, existingDays = []) {
  const scheduleLines = [];
  const openLines = [];
  const summaries = [];
  const availableZipEntries = [];
  const mediaSizes = [];
  for (const device of fs.readdirSync(path.join(ctx.repo, 'devices'))) {
    const schedDir = path.join(ctx.repo, 'devices', device, 'schedules');
    if (fs.existsSync(schedDir)) {
      for (const name of fs.readdirSync(schedDir).filter((n) => n.endsWith('.jsonl')).sort()) {
        const day = name.slice(0, -'.jsonl'.length);
        for (const line of fs.readFileSync(path.join(schedDir, name), 'utf8').split(/\r?\n/)) {
          if (line.trim()) scheduleLines.push({ deviceId: device, date: day, text: line });
        }
      }
    }
    const openFile = path.join(ctx.repo, 'devices', device, 'open.jsonl');
    if (fs.existsSync(openFile)) {
      for (const line of fs.readFileSync(openFile, 'utf8').split(/\r?\n/)) {
        if (line.trim()) openLines.push(line);
      }
    }
    const sumDir = path.join(ctx.repo, 'devices', device, 'summaries');
    if (fs.existsSync(sumDir)) {
      for (const name of fs.readdirSync(sumDir).filter((n) => n.endsWith('.json')).sort()) {
        const text = fs.readFileSync(path.join(sumDir, name), 'utf8');
        const doc = JSON.parse(text);
        summaries.push({ date: name.slice(0, -'.json'.length), text, generatedAt: doc.generatedAt });
      }
    }
  }
  for (const [archive, entries] of ctx.zips) {
    for (const e of entries) {
      availableZipEntries.push(`${archive}\u0000${e.name}`);
      mediaSizes.push({ archive, entry: e.name, size: e.data.length });
    }
  }
  return {
    scheduleLines, openLines, summaries, availableZipEntries, mediaSizes,
    zipListAvailable: true, existingDays
  };
}

/** 假 sink：真正写文件到 out/，同时记录调用顺序；可在指定步骤抛错。 */
function diskSink(ctx, failOn = null) {
  const calls = [];
  const write = (rel, text) => {
    const file = path.join(ctx.out, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
  };
  const step = (kind, date) => {
    calls.push(`${kind}:${date}`);
    if (failOn && failOn.kind === kind && calls.length === failOn.at) {
      throw new Error(`注入失败：第 ${calls.length} 步 ${kind}`);
    }
  };
  return {
    calls,
    sink: {
      writeRecords(date, text) { step('records', date); write(`timeline/${date}/records.json`, text); },
      writeSummary(date, text) { step('summary', date); write(`timeline/${date}/summary.json`, text); },
      writeMedia(date, file, bytes) {
        step('media', date);
        const rel = `timeline/${date}/media/${file}`;
        if (fs.existsSync(path.join(ctx.out, rel))) {
          return sha256(fs.readFileSync(path.join(ctx.out, rel))) === sha256(bytes) ? 'already-present' : 'conflict';
        }
        fs.mkdirSync(path.dirname(path.join(ctx.out, rel)), { recursive: true });
        fs.writeFileSync(path.join(ctx.out, rel), Buffer.from(bytes));
        return 'written';
      },
      appendLedgers(date, deleted, restored, conflicts) {
        step('ledgers', date);
        for (const [name, lines] of [['deleted.jsonl', deleted], ['restore.jsonl', restored], ['conflicts.jsonl', conflicts]]) {
          for (const line of lines) {
            const rel = `timeline/${date}/${name}`;
            const old = fs.existsSync(path.join(ctx.out, rel)) ? fs.readFileSync(path.join(ctx.out, rel), 'utf8') : '';
            if (old.split('\n').includes(line)) continue;
            write(rel, `${old.length === 0 || old.endsWith('\n') ? old : old + '\n'}${line}\n`);
          }
        }
      },
      writeSchema(text) { step('schema', ''); write('timeline/schema.json', text); }
    }
  };
}
function memoryMediaSource(ctx) {
  const data = new Map();
  for (const entries of ctx.zips.values()) {
    for (const e of entries) data.set(e.name, new Uint8Array(e.data));
  }
  return { read(deviceId, archive, entry) { return data.get(entry) === undefined ? null : data.get(entry); } };
}
function emptyMediaSource() {
  return { read() { return null; } };
}
function refusalBase(overrides = {}) {
  return {
    schemaVersion: null, hasDevices: true, hasV1Schedules: true, timelineDayDirs: [],
    strictMode: false, corruptRows: 0, plannedBytes: 100, availableBytes: null, ...overrides
  };
}
/** 从已写出的 out/timeline/<date> 构造 existingDays（模拟断点续跑的只读回读）。 */
function existingFromOut(ctx) {
  const days = [];
  const root = path.join(ctx.out, 'timeline');
  if (!fs.existsSync(root)) return days;
  for (const date of fs.readdirSync(root).filter((d) => M.isCalendarDate(d)).sort()) {
    const text = fs.readFileSync(path.join(root, date, 'records.json'), 'utf8');
    const parsed = M_canonicalParse(text, date);
    const mediaDir = path.join(root, date, 'media');
    days.push({
      date,
      records: parsed,
      summaryGeneratedAt: null,
      deletedLines: readOutLines(ctx, date, 'deleted.jsonl'),
      restoreLines: readOutLines(ctx, date, 'restore.jsonl'),
      conflictLines: readOutLines(ctx, date, 'conflicts.jsonl'),
      mediaFiles: fs.existsSync(mediaDir) ? fs.readdirSync(mediaDir) : []
    });
  }
  return days;
}
function readOutLines(ctx, date, name) {
  const file = path.join(ctx.out, 'timeline', date, name);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0);
}
function M_canonicalParse(text, date) {
  // records.json 每条一行；只取模型需要的已知字段与尾随字段，跳过 date/open 容器行。
  const out = [];
  for (const line of text.split('\n')) {
    const t = line.trim().replace(/,$/, '');
    if (!t.startsWith('{') || !t.includes('"id"')) continue;
    const raw = JSON.parse(t);
    const extras = [];
    const known = new Set(['id', 'ts', 'title', 'body', 'author', 'done', 'media', 'ocr_text',
      'ai_structured', 'ai_processed', 'ocr_time', 'opened_at', 'closed_at']);
    for (const key of Object.keys(raw)) if (!known.has(key)) extras.push({ key, json: JSON.stringify(raw[key]) });
    out.push({
      id: raw.id, ts: raw.ts, title: raw.title, body: raw.body, author: raw.author, done: raw.done,
      media: raw.media || [], ai_processed: raw.ai_processed, opened_at: raw.opened_at,
      ocr_text: raw.ocr_text, ai_structured: raw.ai_structured, ocr_time: raw.ocr_time,
      closed_at: raw.closed_at, extras
    });
  }
  void date;
  return out;
}

// ---------------------------------------------------------------- A. 解析 / 计划算术

test('01 解析：合法 v1 行映射为 V2RecordPlan，未知字段尾随', () => {
  const row = M.parseV1RecordLine({ deviceId: 'd1', date: DAY, text: JSON.stringify(record('a', `${DAY}T09:00:00+08:00`, { x: 1 })) });
  assert.equal(typeof row, 'object');
  const plan = M.mapV1Record(row, null);
  const line = M.canonicalRecordLine(plan);
  assert.match(line, /"id":"a".*"opened_at":/);
  assert.ok(line.endsWith(',"x":1}'));
  assert.equal(plan.opened_at, row.ts);
});

test('02 解析：坏行逐条返回中文原因（永不抛）', () => {
  assert.equal(typeof M.parseV1RecordLine({ deviceId: 'd1', date: DAY, text: '{bad' }), 'string');
  assert.equal(typeof M.parseV1RecordLine({ deviceId: 'd1', date: DAY, text: '{}' }), 'string');
  assert.equal(typeof M.parseV1RecordLine({ deviceId: 'd1', date: '2026-13-99', text: JSON.stringify(record('a', 'x')) }), 'string');
});

test('03 plan 算术：days = 记录分组数（多设备同日并一组）', (t) => {
  const ctx = fixture(t, 'arith');
  schedule(ctx, 'd1', DAY, [record('a', `${DAY}T09:00:00+08:00`)]);
  schedule(ctx, 'd2', DAY, [record('b', `${DAY}T10:00:00+08:00`)]);
  schedule(ctx, 'd1', NEXT, [record('c', `${NEXT}T09:00:00+08:00`)]);
  const p = M.planV1Import(buildInput(ctx));
  assert.equal(p.totals.days, 2);
  assert.equal(p.totals.records, 3);
  assert.deepEqual(p.days.map((d) => d.date), [DAY, NEXT]);
  assert.equal(p.days[0].recordCount, 2);
});

test('04 plan 算术：媒体计数 / 字节含 zip 条目大小', (t) => {
  const ctx = fixture(t, 'media');
  const data = Buffer.from('JPEG-ONE');
  const att = attachment();
  schedule(ctx, 'd1', DAY, [record('a', `${DAY}T09:00:00+08:00`, { attachments: [att] })]);
  zip(ctx, 'd1', `${DAY}.zip`, [{ name: ENTRY, data }]);
  const p = M.planV1Import(buildInput(ctx));
  assert.equal(p.totals.mediaFiles, 1);
  assert.equal(p.days[0].media[0].file, `${SHA.slice(0, 16)}.jpg`);
  assert.ok(p.totals.bytes > data.length);
  assert.equal(p.days[0].media[0].size, data.length);
});

test('05 确定性：同输入两次计划逐字节相同（含 schemaText）', (t) => {
  const ctx = fixture(t, 'determinism');
  schedule(ctx, 'd1', DAY, [record('a', `${DAY}T09:00:00+08:00`)]);
  const a = M.planV1Import(buildInput(ctx));
  const b = M.planV1Import(buildInput(ctx));
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(a.schemaText, b.schemaText);
});

// ---------------------------------------------------------------- B. 折叠 / 账本

test('06 同 id 较晚 ts 静默胜（无冲突计数）', (t) => {
  const ctx = fixture(t, 'later');
  schedule(ctx, 'd1', DAY, [
    record('a', `${DAY}T09:00:00+08:00`, { body: 'old' }),
    record('a', `${DAY}T10:00:00+08:00`, { body: 'new' })
  ]);
  const p = M.planV1Import(buildInput(ctx));
  assert.equal(p.totals.records, 1);
  assert.equal(p.totals.conflicts, 0);
  assert.match(p.days[0].recordsJson, /"body":"new"/);
});

test('07 同 (id,ts) 内容不同：字节较大者胜、败者入 conflicts.jsonl', (t) => {
  const ctx = fixture(t, 'tie');
  const ts = `${DAY}T09:00:00+08:00`;
  schedule(ctx, 'd1', DAY, [record('a', ts, { body: 'aaa' }), record('a', ts, { body: 'zzz' })]);
  const p = M.planV1Import(buildInput(ctx));
  assert.equal(p.totals.conflicts, 1);
  assert.match(p.days[0].recordsJson, /"body":"zzz"/);
  const losing = JSON.parse(p.days[0].conflictLines[0]);
  assert.equal(losing.id, 'a');
  assert.match(losing.losingLine, /"body":"aaa"/);
  assert.equal(losing.dedupeKey, sha256(losing.losingLine));
});

test('08 完全相同重复行只留一条，不写冲突', (t) => {
  const ctx = fixture(t, 'dup');
  const row = record('a', `${DAY}T09:00:00+08:00`);
  schedule(ctx, 'd1', DAY, [row, row]);
  const p = M.planV1Import(buildInput(ctx));
  assert.equal(p.totals.records, 1);
  assert.equal(p.totals.conflicts, 0);
});

test('09 墓碑胜出：物理移除 + deleted.jsonl 一条', (t) => {
  const ctx = fixture(t, 'deleted');
  schedule(ctx, 'd1', DAY, [
    record('a', `${DAY}T09:00:00+08:00`),
    record('a', `${DAY}T11:00:00+08:00`, { deleted: true })
  ]);
  const p = M.planV1Import(buildInput(ctx));
  assert.equal(p.totals.records, 0);
  assert.equal(p.days[0].deletedLines.length, 1);
  const line = JSON.parse(p.days[0].deletedLines[0]);
  assert.equal(line.id, 'a');
  assert.ok(line.deletedAt.endsWith('Z'));
});

test('10 墓碑后有更晚恢复版本：保留记录 + restore.jsonl', (t) => {
  const ctx = fixture(t, 'restore');
  schedule(ctx, 'd1', DAY, [
    record('a', `${DAY}T09:00:00+08:00`, { deleted: true }),
    record('a', `${DAY}T12:00:00+08:00`)
  ]);
  const p = M.planV1Import(buildInput(ctx));
  assert.equal(p.totals.records, 1);
  assert.equal(p.days[0].restoreLines.length, 1);
  assert.equal(p.days[0].deletedLines.length, 0);
});

test('11 open.jsonl 合并 opened_at / closed_at，完成耗时可算', (t) => {
  const ctx = fixture(t, 'open');
  schedule(ctx, 'd1', DAY, [record('a', `${DAY}T09:00:00+08:00`, { done: true })]);
  open(ctx, 'd1', [{ id: 'a', ts: `${DAY}T10:00:00+08:00`, openedAt: `${DAY}T08:30:00+08:00`, closedAt: `${DAY}T10:00:00+08:00` }]);
  const p = M.planV1Import(buildInput(ctx));
  assert.match(p.days[0].recordsJson, /"opened_at":"2026-11-19T08:30:00\+08:00"/);
  assert.match(p.days[0].recordsJson, /"closed_at":"2026-11-19T10:00:00\+08:00"/);
  assert.ok(Date.parse('2026-11-19T10:00:00+08:00') > Date.parse('2026-11-19T08:30:00+08:00'));
});

test('12 open 谓词只看 closed_at（done=true 但无 closed_at 补偿为完成）', (t) => {
  const ctx = fixture(t, 'openpred');
  schedule(ctx, 'd1', DAY, [record('a', `${DAY}T09:00:00+08:00`, { done: true })]);
  const p = M.planV1Import(buildInput(ctx));
  assert.match(p.days[0].recordsJson, /"open": \[\]/);
  assert.match(p.days[0].recordsJson, /"closed_at":"2026-11-19T09:00:00\+08:00"/);
});

test('13 汇总 newer-wins；已有更新汇总时不覆盖', (t) => {
  const ctx = fixture(t, 'summary');
  schedule(ctx, 'd1', DAY, [record('a', `${DAY}T09:00:00+08:00`)]);
  summary(ctx, 'd1', DAY, { version: 1, date: DAY, generatedAt: 100, headline: 'old' });
  const p1 = M.planV1Import(buildInput(ctx));
  assert.equal(p1.days[0].summaries, 1);
  const existing = [{ date: DAY, records: [], summaryGeneratedAt: 200, deletedLines: [], restoreLines: [], conflictLines: [], mediaFiles: [] }];
  const p2 = M.planV1Import(buildInput(ctx, existing));
  assert.equal(p2.days[0].summaryJson, '');
  assert.ok(p2.skipReasons.some((s) => s.reason.includes('已有汇总更新或相同')));
});

// ---------------------------------------------------------------- C. 媒体

test('14 缺 zip 条目：mediaMissing 计数，记录仍迁移', (t) => {
  const ctx = fixture(t, 'missingmedia');
  schedule(ctx, 'd1', DAY, [record('a', `${DAY}T09:00:00+08:00`, { attachments: [attachment()] })]);
  const p = M.planV1Import(buildInput(ctx)); // 没有 fixture zip → availableZipEntries 为空
  assert.equal(p.days[0].recordCount, 1);
  assert.equal(p.totals.mediaMissing, 1);
  assert.ok(p.skipReasons.some((s) => s.reason.includes('zip 条目缺失')));
});

test('15 媒体占位 file 是不含路径的 sha16.jpg（P2-11）', (t) => {
  const ctx = fixture(t, 'medianame');
  schedule(ctx, 'd1', DAY, [record('a', `${DAY}T09:00:00+08:00`, { attachments: [attachment()] })]);
  zip(ctx, 'd1', `${DAY}.zip`, [{ name: ENTRY, data: Buffer.from('x') }]);
  const p = M.planV1Import(buildInput(ctx));
  const file = p.days[0].media[0].file;
  assert.equal(file, `${SHA.slice(0, 16)}.jpg`);
  assert.ok(M.isMediaFileName(file));
  assert.ok(!file.includes('/') && !file.includes('..'));
});

test('16 同日同 sha16 去重（两条记录索引同一文件只写一份）', (t) => {
  const ctx = fixture(t, 'mediaDedupe');
  schedule(ctx, 'd1', DAY, [
    record('a', `${DAY}T09:00:00+08:00`, { attachments: [attachment()] }),
    record('b', `${DAY}T10:00:00+08:00`, { attachments: [attachment()] })
  ]);
  zip(ctx, 'd1', `${DAY}.zip`, [{ name: ENTRY, data: Buffer.from('x') }]);
  const p = M.planV1Import(buildInput(ctx));
  assert.equal(p.totals.mediaFiles, 1);
  assert.equal(p.totals.records, 2);
});

// ---------------------------------------------------------------- D. 类型化拒绝

test('17 E_ALREADY_MIGRATED（schema v2 存在）', () => {
  const r = M.decideImportRefusal(refusalBase({ schemaVersion: 2 }));
  assert.equal(r.code, 'E_ALREADY_MIGRATED');
  assert.equal(r.blocks, true);
  assert.match(r.reason, /无需重复迁移/);
  assert.match(r.nextStep, /不要重复写/);
});

test('18 E_NO_V1_DATA（无 devices 日程）', () => {
  const r = M.decideImportRefusal(refusalBase({ hasV1Schedules: false }));
  assert.equal(r.code, 'E_NO_V1_DATA');
  assert.match(r.reason, /没有可迁移的数据/);
});

test('19 E_PARTIAL_STATE：可继续，带 E_PARTIAL_MIGRATION 状态消息', () => {
  const r = M.decideImportRefusal(refusalBase({ timelineDayDirs: [DAY] }));
  assert.equal(r.code, 'E_PARTIAL_STATE');
  assert.equal(r.stateCode, 'E_PARTIAL_MIGRATION');
  assert.equal(r.blocks, false);
  assert.match(r.reason, /上次迁移未完成，可继续/);
});

test('20 E_CORRUPT_V1：严格模式拒绝，宽松模式不拒绝且逐行报告', (t) => {
  const ctx = fixture(t, 'corrupt');
  schedule(ctx, 'd1', DAY, [record('a', `${DAY}T09:00:00+08:00`), '{bad json']);
  const p = M.planV1Import(buildInput(ctx));
  assert.equal(p.totals.records, 1);
  assert.equal(p.totals.skippedRows, 1);
  assert.ok(p.skipReasons.some((s) => s.reason.includes('坏行已跳过')));
  assert.equal(M.decideImportRefusal(refusalBase({ strictMode: true, corruptRows: 1 })).code, 'E_CORRUPT_V1');
  assert.equal(M.decideImportRefusal(refusalBase({ strictMode: false, corruptRows: 1 })), null);
});

test('21 E_NO_SPACE：计划字节超过可用空间；不可用空间探测 best-effort', () => {
  const r = M.decideImportRefusal(refusalBase({ plannedBytes: 1000, availableBytes: 10 }));
  assert.equal(r.code, 'E_NO_SPACE');
  assert.match(r.reason, /空间不足；未写入任何文件/);
  assert.equal(M.decideImportRefusal(refusalBase({ plannedBytes: 1000, availableBytes: null })), null);
});

// ---------------------------------------------------------------- E. 写序 / schema-last / 幂等

test('22 写序：每天 records → summary → media → ledgers，schema 在最后', (t) => {
  const ctx = fixture(t, 'order');
  schedule(ctx, 'd1', DAY, [record('a', `${DAY}T09:00:00+08:00`)]);
  schedule(ctx, 'd1', NEXT, [record('b', `${NEXT}T09:00:00+08:00`)]);
  const p = M.planV1Import(buildInput(ctx));
  const kinds = M.nextWriteSteps(p).map((s) => s.kind);
  assert.deepEqual(kinds, ['records', 'summary', 'media', 'ledgers', 'records', 'summary', 'media', 'ledgers', 'schema']);
  assert.equal(M.nextWriteSteps(p).at(-1).kind, 'schema');
});

test('23 apply：假 sink 按写序落盘，schema.json 存在且 devices 字节不变', (t) => {
  const ctx = fixture(t, 'apply');
  schedule(ctx, 'd1', DAY, [record('a', `${DAY}T09:00:00+08:00`)]);
  const before = snapshot(path.join(ctx.repo, 'devices'));
  const p = M.planV1Import(buildInput(ctx));
  const io = diskSink(ctx);
  const result = M.applyV1Plan(p, io.sink, memoryMediaSource(ctx));
  assert.equal(result.schemaWritten, true);
  assert.equal(io.calls.at(-1), 'schema:');
  assert.ok(fs.existsSync(path.join(ctx.out, 'timeline/schema.json')));
  assert.deepEqual(snapshot(path.join(ctx.repo, 'devices')), before);
  assert.equal(JSON.parse(fs.readFileSync(path.join(ctx.out, 'timeline/schema.json'), 'utf8')).schemaVersion, 2);
});

test('24 schema-last：末步之前（ledgers）失败时 schema.json 不存在，但此前日已落 records', (t) => {
  const ctx = fixture(t, 'crash');
  schedule(ctx, 'd1', DAY, [record('a', `${DAY}T09:00:00+08:00`)]);
  const before = snapshot(path.join(ctx.repo, 'devices'));
  const p = M.planV1Import(buildInput(ctx));
  const io = diskSink(ctx, { kind: 'ledgers', at: 2 }); // 无 summary/媒体：records → ledgers 失败，schema 未写
  assert.throws(() => M.applyV1Plan(p, io.sink, memoryMediaSource(ctx)), /注入失败/);
  assert.ok(!fs.existsSync(path.join(ctx.out, 'timeline/schema.json')));
  assert.ok(fs.existsSync(path.join(ctx.out, 'timeline', DAY, 'records.json')));
  assert.deepEqual(snapshot(path.join(ctx.repo, 'devices')), before);
});

test('25 中断重跑：读入已写日 → 续跑完成，schema 最后落地', (t) => {
  const ctx = fixture(t, 'resume');
  schedule(ctx, 'd1', DAY, [record('a', `${DAY}T09:00:00+08:00`)]);
  const p1 = M.planV1Import(buildInput(ctx));
  const io1 = diskSink(ctx, { kind: 'ledgers', at: 2 });
  assert.throws(() => M.applyV1Plan(p1, io1.sink, memoryMediaSource(ctx)));
  assert.ok(!fs.existsSync(path.join(ctx.out, 'timeline/schema.json')));
  const existing = existingFromOut(ctx);
  assert.equal(existing.length, 1);
  const p2 = M.planV1Import(buildInput(ctx, existing));
  const io2 = diskSink(ctx);
  const result = M.applyV1Plan(p2, io2.sink, memoryMediaSource(ctx));
  assert.equal(result.schemaWritten, true);
  assert.equal(io2.calls.at(-1), 'schema:');
  assert.ok(fs.existsSync(path.join(ctx.out, 'timeline/schema.json')));
});

test('26 幂等重跑：已有更晚 ts 的 v2 版本不被 v1 旧版本覆盖', (t) => {
  const ctx = fixture(t, 'upsert');
  schedule(ctx, 'd1', DAY, [record('a', `${DAY}T09:00:00+08:00`, { body: 'old' })]);
  const p1 = M.planV1Import(buildInput(ctx));
  M.applyV1Plan(p1, diskSink(ctx).sink, emptyMediaSource());
  const updated = M_canonicalParse(fs.readFileSync(path.join(ctx.out, 'timeline', DAY, 'records.json'), 'utf8'), DAY);
  updated[0].ts = `${DAY}T15:00:00+08:00`;
  updated[0].body = 'v2 newer';
  fs.writeFileSync(path.join(ctx.out, 'timeline', DAY, 'records.json'),
    M.serializeDay(DAY, updated), 'utf8');
  const existing = existingFromOut(ctx);
  const p2 = M.planV1Import(buildInput(ctx, existing));
  const io2 = diskSink(ctx);
  M.applyV1Plan(p2, io2.sink, emptyMediaSource());
  const after = fs.readFileSync(path.join(ctx.out, 'timeline', DAY, 'records.json'), 'utf8');
  assert.match(after, /"body":"v2 newer"/);
  assert.ok(!after.includes('"body":"old"'));
  assert.ok(p2.totals.recordsAlreadyPresent >= 0);
});

test('27 幂等重跑：媒体 add-only，已存在相同字节记 already-present', (t) => {
  const ctx = fixture(t, 'mediaidem');
  const data = Buffer.from('JPEG-IDEMPOTENT');
  schedule(ctx, 'd1', DAY, [record('a', `${DAY}T09:00:00+08:00`, { attachments: [attachment()] })]);
  zip(ctx, 'd1', `${DAY}.zip`, [{ name: ENTRY, data }]);
  const p1 = M.planV1Import(buildInput(ctx));
  const r1 = M.applyV1Plan(p1, diskSink(ctx).sink, memoryMediaSource(ctx));
  assert.equal(r1.mediaWritten, 1);
  const existing = existingFromOut(ctx);
  const p2 = M.planV1Import(buildInput(ctx, existing));
  assert.equal(p2.totals.alreadyPresent, 1);
  assert.equal(p2.days[0].media.length, 0);
  const r2 = M.applyV1Plan(p2, diskSink(ctx).sink, memoryMediaSource(ctx));
  assert.equal(r2.mediaWritten, 0);
});

test('28 幂等重跑：账本行按整行去重，不追加第二份', (t) => {
  const ctx = fixture(t, 'ledgeridem');
  schedule(ctx, 'd1', DAY, [
    record('a', `${DAY}T09:00:00+08:00`, { body: 'aaa' }),
    record('a', `${DAY}T09:00:00+08:00`, { body: 'zzz' })
  ]);
  const p1 = M.planV1Import(buildInput(ctx));
  M.applyV1Plan(p1, diskSink(ctx).sink, emptyMediaSource());
  const first = readOutLines(ctx, DAY, 'conflicts.jsonl');
  assert.equal(first.length, 1);
  const existing = existingFromOut(ctx);
  const p2 = M.planV1Import(buildInput(ctx, existing));
  const io2 = diskSink(ctx);
  M.applyV1Plan(p2, io2.sink, emptyMediaSource());
  assert.deepEqual(readOutLines(ctx, DAY, 'conflicts.jsonl'), first);
});

test('29 summarizePlan：天数/记录/媒体/字节/汇总/跳过/冲突逐项可见', (t) => {
  const ctx = fixture(t, 'summarytext');
  schedule(ctx, 'd1', DAY, [record('a', `${DAY}T09:00:00+08:00`, { attachments: [attachment()] }), '{bad']);
  const p = M.planV1Import(buildInput(ctx));
  const text = M.summarizePlan(p).join('\n');
  for (const token of ['计划：1 天 / 1 条记录 / 1 个媒体文件', '字节', '跳过 2 行', '缺失媒体 1', '冲突 0', '跳过原因', 'schema.json']) {
    assert.ok(text.includes(token), token);
  }
});

// ---------------------------------------------------------------- F. 静态接线断言（源码）

test('30 静态：横幅按钮打开迁移面板，apply 需要独立二次确认', () => {
  const idx = fs.readFileSync(path.join(ROOT, 'apps/arkui-schedule/entry/src/main/ets/pages/Index.ets'), 'utf8');
  assert.ok(idx.includes('迁移旧数据（先查看计划）'));
  assert.ok(idx.includes('this.openMigrationSheet()'));
  assert.ok(idx.includes('private confirmMigrationPlan()'));
  assert.ok(idx.includes("title: '确认迁移旧数据？'"));
  assert.ok(idx.includes('this.applyMigration()'));
  const banner = idx.indexOf('MigrationBanner()');
  assert.ok(banner >= 0);
});

test('31 静态：新代码没有对 devices/ 的写 / unlink / rename，也没有 zipUpsert', () => {
  const files = [
    'apps/arkui-schedule/entry/src/main/ets/model/importV1.ts',
    'apps/arkui-schedule/entry/src/main/ets/services/importV1Service.ets'
  ];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.ok(!/zipUpsert/.test(src), rel);
    assert.ok(!/(unlinkSync|renameSync|writeFileSync|writeTextSync)\([^)]*devices\//.test(src), rel);
  }
  const store = fs.readFileSync(path.join(ROOT, 'apps/arkui-schedule/entry/src/main/ets/services/timelineWriteStore.ets'), 'utf8');
  assert.ok(store.includes('migrationWriteRecords'));
  assert.ok(store.includes('migrationWriteSummary'));
  assert.ok(store.includes('migrationWriteMedia'));
  assert.ok(store.includes('migrationWriteSchema'));
  const service = fs.readFileSync(path.join(ROOT, 'apps/arkui-schedule/entry/src/main/ets/services/importV1Service.ets'), 'utf8');
  assert.ok(service.includes('timelineWriteStore.migrationWriteRecords'));
  assert.ok(service.includes('timelineWriteStore.migrationWriteSummary'));
  assert.ok(service.includes('timelineWriteStore.migrationWriteMedia'));
  assert.ok(service.includes('zipRead'));
});

test('32 静态：写序常量固定 records → summary → media → ledgers → schema', () => {
  const src = fs.readFileSync(path.join(ROOT, 'apps/arkui-schedule/entry/src/main/ets/model/importV1.ts'), 'utf8');
  const i1 = src.indexOf("kind: 'records'");
  const i2 = src.indexOf("kind: 'summary'");
  const i3 = src.indexOf("kind: 'media'");
  const i4 = src.indexOf("kind: 'ledgers'");
  const i5 = src.indexOf("kind: 'schema'");
  assert.ok(i1 >= 0 && i1 < i2 && i2 < i3 && i3 < i4 && i4 < i5);
});

// ---------------------------------------------------------------- G. 拒绝优先级回归（P2-1）

test('33 P2-1(a)：部分态 + 严格模式坏行 → E_CORRUPT_V1 阻断，零写入', (t) => {
  const input = refusalBase({
    timelineDayDirs: [DAY], strictMode: true, corruptRows: 5, plannedBytes: 1000, availableBytes: 1
  });
  const r = M.decideImportRefusal(input);
  assert.equal(r.code, 'E_CORRUPT_V1');
  assert.equal(r.blocks, true);
  assert.match(r.reason, /5 行无法解析/);
  assert.match(r.reason, /未写入任何文件/);

  // 服务侧：blocks=true → 不调用 apply；out/ 不存在，devices 树字节不变。
  const ctx = fixture(t, 'p21corrupt');
  schedule(ctx, 'd1', DAY, [record('a', `${DAY}T09:00:00+08:00`), '{bad json']);
  const before = snapshot(path.join(ctx.repo, 'devices'));
  const gate = M.decideImportRefusal(refusalBase({ timelineDayDirs: [DAY], strictMode: true, corruptRows: 1 }));
  if (!gate.blocks) {
    M.applyV1Plan(M.planV1Import(buildInput(ctx)), diskSink(ctx).sink, emptyMediaSource());
  }
  assert.ok(!fs.existsSync(ctx.out));
  assert.deepEqual(snapshot(path.join(ctx.repo, 'devices')), before);
});

test('34 P2-1(b)：部分态 + 空间不足 → E_NO_SPACE 阻断', () => {
  const r = M.decideImportRefusal(refusalBase({
    timelineDayDirs: [DAY], plannedBytes: 1000, availableBytes: 1
  }));
  assert.equal(r.code, 'E_NO_SPACE');
  assert.equal(r.blocks, true);
  assert.match(r.reason, /预估需要 1000 字节，当前可用 1 字节/);
});

test('35 P2-1(c)：部分态 + 干净 + 空间充足 → E_PARTIAL_STATE 可续跑', () => {
  const r = M.decideImportRefusal(refusalBase({
    timelineDayDirs: [DAY], plannedBytes: 100, availableBytes: 1000
  }));
  assert.equal(r.code, 'E_PARTIAL_STATE');
  assert.equal(r.stateCode, 'E_PARTIAL_MIGRATION');
  assert.equal(r.blocks, false);
  assert.match(r.reason, /上次迁移未完成，可继续/);
});

test('36 P2-1(d)：已迁移（schema v2）优先于坏行 / 空间不足 / 部分态 / 无数据', () => {
  const r = M.decideImportRefusal(refusalBase({
    schemaVersion: 2, timelineDayDirs: [DAY], strictMode: true, corruptRows: 5,
    plannedBytes: 1000, availableBytes: 1, hasV1Schedules: false, hasDevices: false
  }));
  assert.equal(r.code, 'E_ALREADY_MIGRATED');
  assert.equal(r.blocks, true);
  assert.match(r.reason, /无需重复迁移/);
});

// ---------------------------------------------------------------- H. 媒体来源裁决一致性（P2-2）

test('37 P2-2：同 (id,ts) 不同附件 → 媒体计划与记录 media[] 同源于字节胜者', (t) => {
  const ts = `${DAY}T09:00:00+08:00`;
  const small = attachment('small-abcd1234.jpg', `${DAY}.zip`, SHA);
  const large = attachment('large-abcd1234.jpg', `${DAY}.zip`, SHA2);
  const ctx = fixture(t, 'tiesha');
  // body aaa + sha ab… 先到；body zzz + sha cd… 后到。字节裁决胜者必须是后者。
  schedule(ctx, 'd1', DAY, [
    record('a', ts, { body: 'aaa', attachments: [small] }),
    record('a', ts, { body: 'zzz', attachments: [large] })
  ]);
  zip(ctx, 'd1', `${DAY}.zip`, [
    { name: small.entry, data: Buffer.from('AAA') },
    { name: large.entry, data: Buffer.from('ZZZ') }
  ]);
  const p = M.planV1Import(buildInput(ctx));
  assert.equal(p.totals.records, 1);
  assert.equal(p.days[0].records[0].body, 'zzz');
  const recMedia = p.days[0].records[0].media[0];
  assert.equal(recMedia.sha256, SHA2);
  assert.equal(p.days[0].media.length, 1);
  assert.equal(p.days[0].media[0].sha256, recMedia.sha256);
  assert.equal(p.days[0].media[0].file, `${SHA2.slice(0, 16)}.jpg`);
  assert.equal(p.days[0].media[0].entry, large.entry);
});
