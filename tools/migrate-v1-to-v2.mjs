#!/usr/bin/env node
// v1 -> v2 离线迁移工具（只处理记录 / 摘要 / 删除与撤销账本 / 冲突审计）。
//
// 输入：devices/<deviceId>/schedules/*.jsonl、devices/<deviceId>/open.jsonl、
//       devices/<deviceId>/summaries/*.json
// 输出：<repo>/timeline/schema.json、<repo>/timeline/<YYYY-MM-DD>/
//       {records.json, summary.json?, deleted.jsonl, restore.jsonl, conflicts.jsonl}
// 不读 registry.jsonl、不读 attachments/*.zip、不读 chats/，也不创建任何媒体文件。
// 媒体占位由后续模块 mod-v2-media-migration 负责补位。
//
// 确定性说明（重要）：deletedAt / restoredAt / decidedAt / migratedAt 均不取进程墙钟时间，
// 而是由输入事件的 ts 经 new Date(ms).toISOString() 归一化得到（无可用输入时为 epoch）。
// 墙钟时间会让同一输入两次运行产生不同字节，违反本工具「同输入 -> 字节相同」的硬性验收。
//
// 权威规则来自 docs/DATA-CONTRACT-v2.md：
//   §3  规范键序 + 纯函数 canonicalRecordLine(record) + 未知字段末尾保留
//   §4  同 (id,ts) 按规范整行 UTF-8 字节序裁决，败者进 conflicts.jsonl（dedupeKey=sha256(losingLine)）
//   §5  媒体占位 file 是不含路径的裸 <sha16>.jpg（P2-11）
//   §6  open 谓词只看 closed_at 是否缺省（P2-2），done 不参与判定
//   §7  deleted/restore 账本形状与只追加语义（P1-4）
//   §10 步骤 2/4/5：每日三个空账本、open 合并、墓碑后有更晚恢复版本写 restore.jsonl
//   §11 schema 标记最后落地（整树原子 rename 时与日目录同时可见，不可观测到半写状态）

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const EXIT = { OK: 0, UNEXPECTED: 1, REFUSED: 2, VERIFY: 3 };

// 契约 §3 记录字段表的规范键序（「键序即此表顺序」）。缺席的可选字段直接省略；
// 未知扩展字段排在末尾且值不变（§3「未知字段必须原样保留」）。
const KEY_ORDER = [
  'id', 'ts', 'title', 'body', 'author', 'done', 'media',
  'ocr_text', 'ai_structured', 'ai_processed', 'ocr_time', 'opened_at', 'closed_at'
];
const KNOWN_KEYS = new Set(KEY_ORDER);
// 契约 §10 步骤 2：建各日文件夹时「含空的 deleted.jsonl / restore.jsonl / conflicts.jsonl」。
const LEDGERS = ['deleted.jsonl', 'restore.jsonl', 'conflicts.jsonl'];

class Refused extends Error {}
class VerifyFailed extends Error {}

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

const USAGE = [
  '用法: node tools/migrate-v1-to-v2.mjs --repo <path> [--dry-run|--apply] [--force] [--out <path>] [--quiet]',
  '  --repo <path>  v1 仓库根目录，或直接指向其 devices/ 目录',
  '  --dry-run      默认：只打印计划，不写任何文件',
  '  --apply        写入 timeline.tmp-<pid>/ 后再原子落入 timeline/，并做校验',
  '  --force        timeline/ 已存在时，只补缺失的日期目录，绝不覆盖已有 records.json',
  '  --out <path>   指定另一个输出根目录（timeline/ 将建在其下）',
  '  --quiet        省略计划明细，仅保留结果与错误'
].join('\n');

// ---------------------------------------------------------------- 参数

function parseArgs(argv) {
  const opts = { repo: null, mode: 'dry-run', force: false, out: null, quiet: false };
  let sawDry = false;
  let sawApply = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--repo') {
      opts.repo = argv[++i];
      if (!opts.repo) throw new Refused('拒绝：--repo 需要一个路径参数。');
    } else if (arg === '--out') {
      opts.out = argv[++i];
      if (!opts.out) throw new Refused('拒绝：--out 需要一个路径参数。');
    } else if (arg === '--dry-run') {
      sawDry = true;
    } else if (arg === '--apply') {
      sawApply = true;
    } else if (arg === '--force') {
      opts.force = true;
    } else if (arg === '--quiet') {
      opts.quiet = true;
    } else {
      throw new Refused(`拒绝：无法识别的参数 ${JSON.stringify(arg)}。\n${USAGE}`);
    }
  }
  if (sawDry && sawApply) throw new Refused('拒绝：--dry-run 与 --apply 不能同时使用。');
  if (sawApply) opts.mode = 'apply';
  if (!opts.repo) throw new Refused(`拒绝：缺少 --repo 参数。\n${USAGE}`);
  return opts;
}

// 允许 --repo 直接指向 devices/ 目录（真实仓库核查命令使用这种写法）。
function resolvePaths(repoArg, outArg) {
  const repo = path.resolve(repoArg);
  let root = repo;
  let devices = path.join(repo, 'devices');
  if (!fs.existsSync(devices) && fs.existsSync(repo) && fs.statSync(repo).isDirectory()) {
    const looksLikeDevices = path.basename(repo).toLowerCase() === 'devices'
      || fs.readdirSync(repo, { withFileTypes: true }).some((entry) => {
        if (!entry.isDirectory()) return false;
        const child = path.join(repo, entry.name);
        return ['schedules', 'summaries', 'open.jsonl'].some((name) => fs.existsSync(path.join(child, name)));
      });
    if (looksLikeDevices) {
      devices = repo;
      root = path.dirname(repo);
    }
  }
  const outputRoot = outArg ? path.resolve(outArg) : root;
  return { root, devices, outputRoot, finalDir: path.join(outputRoot, 'timeline') };
}

// ---------------------------------------------------------------- 工具函数

// 契约 §3（第 48 行）：「必须存在纯函数 canonicalRecordLine(record)，其输出与本节示例的
// 字节（含键序）逐字符一致；tie-break（§4）与判重（§9）只在这一种字节形状上进行。」
// 这是一条纯函数：同对象两次调用逐字节相等；人为交换字段插入顺序后规范化会恢复规范序。
export function canonicalRecordLine(record) {
  const out = {};
  for (const key of KEY_ORDER) if (hasOwn(record, key)) out[key] = record[key];
  // 未知扩展字段排在末尾且值不变（§3）。
  for (const key of Object.keys(record)) if (!KNOWN_KEYS.has(key)) out[key] = record[key];
  return JSON.stringify(out);
}

function lineSha256(line) {
  return createHash('sha256').update(line, 'utf8').digest('hex');
}

// 时间比较：能解析就按时刻（毫秒）比；不能解析则退回字符串比较。
// 汇总的 generatedAt 是 epoch 毫秒数字（契约 §8），必须按数值比较，否则
// cmpTs 会走字符串兜底把数字当作 ''，导致「较新者胜」失效。
function tsMs(ts) {
  if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
  const ms = typeof ts === 'string' ? Date.parse(ts) : NaN;
  return Number.isNaN(ms) ? null : ms;
}

function cmpTs(a, b) {
  const ma = tsMs(a);
  const mb = tsMs(b);
  if (ma !== null && mb !== null) return ma === mb ? 0 : (ma < mb ? -1 : 1);
  const sa = typeof a === 'string' ? a : '';
  const sb = typeof b === 'string' ? b : '';
  return sa === sb ? 0 : (sa < sb ? -1 : 1);
}

function byTsId(a, b) {
  return cmpTs(a.ts, b.ts) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

// 由事件时间派生 ISO 时间戳；保证同输入同字节。
function isoFromTs(ts) {
  const ms = tsMs(ts);
  return ms === null ? (typeof ts === 'string' ? ts : '1970-01-01T00:00:00.000Z') : new Date(ms).toISOString();
}

function jsonl(rows) {
  return `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
}

function readLines(file) {
  const text = fs.readFileSync(file, 'utf8');
  return text.split(/\r?\n/).filter((line) => line.trim() !== '');
}

function listDir(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}

function listDeviceDirs(devices) {
  return fs.readdirSync(devices, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function baseName(file, ext) {
  return path.basename(file, ext);
}

// ---------------------------------------------------------------- 读取 v1

function readV1(devices) {
  // key = day + '\0' + id，值 = 该 id 在当日的全部原始版本行。
  // 保留全部版本而不是只留 winner，才能同时做 §4 tie-break 与 §10 步骤 5 的恢复识别。
  const versions = new Map();
  const openById = new Map(); // key = id，值 = 较新的 open 事件
  const summariesByDay = new Map();
  const stats = { skipped: 0, duplicates: 0, devices: [] };

  for (const device of listDeviceDirs(devices)) {
    const deviceDir = path.join(devices, device);
    const files = [];
    const scheduleDir = path.join(deviceDir, 'schedules');
    for (const name of listDir(scheduleDir)) {
      if (name.endsWith('.jsonl')) files.push({ file: path.join(scheduleDir, name), day: baseName(name, '.jsonl') });
    }

    for (const { file, day } of files) {
      const validDay = DAY_RE.test(day);
      for (const line of readLines(file)) {
        let rec;
        try {
          rec = JSON.parse(line);
        } catch {
          stats.skipped += 1;
          continue;
        }
        if (!rec || typeof rec !== 'object' || Array.isArray(rec)
          || typeof rec.id !== 'string' || !rec.id
          || typeof rec.ts !== 'string' || !rec.ts || !validDay) {
          stats.skipped += 1;
          continue;
        }
        const key = `${day}\0${rec.id}`;
        if (!versions.has(key)) versions.set(key, []);
        versions.get(key).push(rec);
      }
    }

    const openFile = path.join(deviceDir, 'open.jsonl');
    if (fs.existsSync(openFile)) {
      for (const line of readLines(openFile)) {
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          stats.skipped += 1;
          continue;
        }
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)
          || typeof entry.id !== 'string' || !entry.id
          || typeof entry.ts !== 'string' || !entry.ts) {
          stats.skipped += 1;
          continue;
        }
        const prev = openById.get(entry.id);
        if (!prev) {
          openById.set(entry.id, entry);
        } else {
          const cmp = cmpTs(entry.ts, prev.ts);
          if (cmp > 0) openById.set(entry.id, entry);
          else if (cmp === 0) stats.duplicates += 1;
        }
      }
    }

    const summaryDir = path.join(deviceDir, 'summaries');
    for (const name of listDir(summaryDir)) {
      if (!name.endsWith('.json')) continue;
      const day = baseName(name, '.json');
      let doc;
      try {
        doc = JSON.parse(fs.readFileSync(path.join(summaryDir, name), 'utf8'));
      } catch {
        stats.skipped += 1;
        continue;
      }
      if (!doc || typeof doc !== 'object' || Array.isArray(doc) || !DAY_RE.test(day)) {
        stats.skipped += 1;
        continue;
      }
      const prev = summariesByDay.get(day);
      if (!prev || cmpTs(doc.generatedAt || '', prev.doc.generatedAt || '') > 0) {
        summariesByDay.set(day, { day, doc });
      }
    }
    stats.devices.push(device);
  }
  return { versions, openById, summariesByDay, stats };
}

// ---------------------------------------------------------------- 构造 v2

// 把一条 v1 记录映射成 v2 记录；键的插入顺序即 §3 规范键序。
function mapRecord(rec, openById) {
  const out = {
    id: rec.id,
    ts: rec.ts,
    title: typeof rec.title === 'string' ? rec.title : '',
    body: typeof rec.body === 'string' ? rec.body : '',
    author: typeof rec.author === 'string' ? rec.author : '',
    done: rec.done === true,
    // 契约 §5 / §10 步骤 3：file 是「不含路径的文件名」，任何写入端不得带 media/ 前缀（P2-11）。
    // 只写占位，不读 zip、不创建媒体文件（真实解包归 mod-v2-media-migration）。
    media: Array.isArray(rec.attachments)
      ? rec.attachments
        .filter((att) => att && typeof att === 'object' && typeof att.sha256 === 'string' && att.sha256)
        .map((att) => ({
          file: `${att.sha256.slice(0, 16)}.jpg`,
          sha256: att.sha256,
          pageIndex: Number.isInteger(att.pageIndex) ? att.pageIndex : 0
        }))
      : []
  };
  // 契约 §3：已知可选字段必须落在其规范槽位——ocr_text / ai_structured 在 ai_processed 之前，
  // ocr_time 在 opened_at 之前；它们不能像未知扩展字段那样追加到末尾（评审 P1-3）。
  if (hasOwn(rec, 'ocr_text')) out.ocr_text = rec.ocr_text;
  if (hasOwn(rec, 'ai_structured')) out.ai_structured = rec.ai_structured;
  out.ai_processed = rec.ai_processed === true;
  if (hasOwn(rec, 'ocr_time')) out.ocr_time = rec.ocr_time;

  // 契约 §10 步骤 4：v1 open.jsonl 的 openedAt/closedAt 合并进 opened_at/closed_at。
  const oe = openById.get(rec.id);
  let openedAt;
  let closedAt;
  if (oe) {
    openedAt = typeof oe.openedAt === 'string' && oe.openedAt ? oe.openedAt : rec.ts;
    if (typeof oe.closedAt === 'string' && oe.closedAt) closedAt = oe.closedAt;
  } else {
    openedAt = rec.ts;
    if (out.done) closedAt = rec.ts;
  }
  out.opened_at = openedAt;
  if (closedAt !== undefined) out.closed_at = closedAt;

  // 未知扩展字段排在末尾且值不变（§3）；已映射的 attachments 与墓碑标记 deleted 不复制。
  for (const key of Object.keys(rec)) {
    if (KNOWN_KEYS.has(key) || key === 'deleted' || key === 'attachments') continue;
    out[key] = rec[key];
  }
  return out;
}

// 契约 §4 P0-1：「若同一 id 的两行 ts 字节相同而规范整行不同，取规范整行 JSON 按 UTF-8
// 字节序字典序较大者胜出（比较函数 = Buffer.compare(Buffer.from(lineA,'utf8'), Buffer.from(lineB,'utf8'))）」。
// 不同 ts 仍是 later-ts-wins 静默折叠（旧版本不是冲突）；同一规范行是真重复，不写冲突。
function pickWinner(entries, stats) {
  let best = null;
  const conflicts = [];
  for (const entry of entries) {
    if (!best) {
      best = entry;
      continue;
    }
    const cmp = cmpTs(entry.rec.ts, best.rec.ts);
    if (cmp > 0) {
      best = entry; // 不同 ts：较晚者静默胜，旧版本不是冲突
      continue;
    }
    if (cmp < 0) continue;
    const byteCmp = Buffer.compare(Buffer.from(entry.line, 'utf8'), Buffer.from(best.line, 'utf8'));
    if (byteCmp === 0) {
      stats.duplicates += 1; // 同一规范行 = 真重复，不写 conflicts.jsonl
      continue;
    }
    if (byteCmp > 0) {
      conflicts.push(best);
      best = entry;
    } else {
      conflicts.push(entry);
    }
  }
  return { best, conflicts };
}

function foldToDays(v1) {
  const perDay = new Map();
  for (const [key, rawVersions] of v1.versions) {
    const sep = key.indexOf('\0');
    const day = key.slice(0, sep);
    const id = key.slice(sep + 1);
    if (!perDay.has(day)) perDay.set(day, []);
    const mapped = rawVersions.map((raw) => {
      const rec = mapRecord(raw, v1.openById);
      const line = canonicalRecordLine(rec);
      return { raw, rec, line, dedupeKey: lineSha256(line) };
    });
    const { best, conflicts } = pickWinner(mapped, v1.stats);
    const winnerDeleted = best.raw.deleted === true;
    // 契约 §10 步骤 5：「若存在更晚恢复版本则保留记录、不写账本、并按 §7 写 restore.jsonl」。
    const earlierTombstone = !winnerDeleted
      && rawVersions.some((raw) => raw.deleted === true && cmpTs(raw.ts, best.rec.ts) < 0);
    perDay.get(day).push({ id, best, conflicts, winnerDeleted, earlierTombstone });
  }
  return perDay;
}

function buildDoc(day, entries) {
  const records = entries.filter((e) => !e.winnerDeleted).map((e) => e.best.rec);
  records.sort(byTsId);

  // 契约 §6 P2-2：「未完成 iff closed_at 缺省（空串等同缺省）；done 只作展示，不参与判定」。
  const open = records.filter((r) => !r.closed_at).map((r) => r.id);

  const deletes = entries.filter((e) => e.winnerDeleted)
    .map((e) => ({ id: e.id, ts: e.best.rec.ts, deletedAt: isoFromTs(e.best.rec.ts) }))
    .sort(byTsId);

  const restores = entries.filter((e) => e.earlierTombstone)
    .map((e) => ({ id: e.id, ts: e.best.rec.ts, restoredAt: isoFromTs(e.best.rec.ts) }))
    .sort(byTsId);

  // 契约 §4：「败者不丢：union 写阶段把败者原样追加进当日 conflicts.jsonl，供人工恢复」；
  // 行形状 {id,ts,losingLine,decidedAt,dedupeKey}，按 (id,ts,dedupeKey) 去重。
  // losingLine 即败者的规范整行；decidedAt 由输入 ts 派生，不用墙钟。
  const conflicts = [];
  const seen = new Set();
  for (const e of entries) {
    for (const loser of e.conflicts) {
      const key = `${e.id}\0${loser.rec.ts}\0${loser.dedupeKey}`;
      if (seen.has(key)) continue;
      seen.add(key);
      conflicts.push({
        id: e.id,
        ts: loser.rec.ts,
        losingLine: loser.line,
        decidedAt: isoFromTs(loser.rec.ts),
        dedupeKey: loser.dedupeKey
      });
    }
  }
  conflicts.sort((a, b) => byTsId(a, b)
    || (a.dedupeKey < b.dedupeKey ? -1 : a.dedupeKey > b.dedupeKey ? 1 : 0));

  // 契约 §3/§11：schemaVersion 只在仓库级 timeline/schema.json，records.json 不含。
  return { date: day, open, records, deletes, restores, conflicts };
}

// records.json：数组括号各自独占一行，每个记录对象恰好一行，\n 换行，一个尾换行。
// 顶层键顺序固定为 date / open / records（契约 §3）；每条记录用规范序列化。
function serializeRecords(doc) {
  const lines = ['{', `  "date": ${JSON.stringify(doc.date)},`];
  if (doc.open.length === 0) {
    lines.push('  "open": [],');
  } else {
    lines.push('  "open": [');
    doc.open.forEach((id, i) => lines.push(`    ${JSON.stringify(id)}${i < doc.open.length - 1 ? ',' : ''}`));
    lines.push('  ],');
  }
  if (doc.records.length === 0) {
    lines.push('  "records": []');
  } else {
    lines.push('  "records": [');
    doc.records.forEach((rec, i) => lines.push(`    ${canonicalRecordLine(rec)}${i < doc.records.length - 1 ? ',' : ''}`));
    lines.push('  ]');
  }
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

function buildPlan(paths) {
  const v1 = readV1(paths.devices);
  const perDay = foldToDays(v1);

  const allTs = [];
  for (const versions of v1.versions.values()) for (const raw of versions) allTs.push(raw.ts);
  for (const e of v1.openById.values()) allTs.push(e.ts);
  allTs.sort(cmpTs);
  const migratedAt = allTs.length ? isoFromTs(allTs[allTs.length - 1]) : '1970-01-01T00:00:00.000Z';
  const schemaText = `${JSON.stringify({ schemaVersion: 2, migratedAt, source: 'v1' }, null, 2)}\n`;

  const days = [];
  for (const day of [...perDay.keys()].sort()) {
    const doc = buildDoc(day, perDay.get(day));
    const summary = v1.summariesByDay.get(day);
    // 契约 §10 步骤 2：每日三本账本文件无条件创建（无条目时写空文件）。
    const files = {
      'records.json': serializeRecords(doc),
      'deleted.jsonl': doc.deletes.length ? jsonl(doc.deletes) : '',
      'restore.jsonl': doc.restores.length ? jsonl(doc.restores) : '',
      'conflicts.jsonl': doc.conflicts.length ? jsonl(doc.conflicts) : ''
    };
    if (summary) files['summary.json'] = `${JSON.stringify(summary.doc, null, 2)}\n`;
    days.push({
      date: day,
      doc,
      files,
      recordsText: files['records.json'],
      deletesText: files['deleted.jsonl'],
      restoresText: files['restore.jsonl'],
      conflictsText: files['conflicts.jsonl'],
      summaryText: files['summary.json'] || null,
      // 按日期望计数（复审 P1）：verifyPlan 只拿「本次实际写入的日」的这些值逐日比对，
      // 绝不使用含 skipped-existing 日的 plan.conflicts / plan.restores 计划全量。
      records: doc.records.length,
      deletes: doc.deletes.length,
      restores: doc.restores.length,
      conflicts: doc.conflicts.length,
      summaries: summary ? 1 : 0,
      bytes: Object.values(files).reduce((n, text) => n + Buffer.byteLength(text), 0)
    });
  }
  const conflicts = days.reduce((n, d) => n + d.doc.conflicts.length, 0);
  const restores = days.reduce((n, d) => n + d.doc.restores.length, 0);
  const totalBytes = Buffer.byteLength(schemaText) + days.reduce((sum, d) => sum + d.bytes, 0);
  return { ...paths, ...v1.stats, conflicts, restores, days, schemaText, totalBytes, migratedAt };
}

// ---------------------------------------------------------------- 计划输出

function printPlan(plan, opts) {
  if (opts.quiet) return;
  const records = plan.days.reduce((n, d) => n + d.doc.records.length, 0);
  const deletes = plan.days.reduce((n, d) => n + d.doc.deletes.length, 0);
  const summaries = plan.days.filter((d) => d.summaryText).length;
  console.log(`[migrate] mode=${opts.mode} repo=${plan.root} devices=${plan.devices}`);
  console.log(`[migrate] devices-scanned=${plan.devices.length ? plan.devices.join(',') : '(none)'}`);
  console.log(`[migrate] plan days=${plan.days.length} records=${records} deletes=${deletes} summaries=${summaries} skipped=${plan.skipped} duplicates=${plan.duplicates} conflicts=${plan.conflicts} restores=${plan.restores}`);
  for (const day of plan.days) {
    console.log(`[migrate] day ${day.date} records=${day.doc.records.length} deletes=${day.doc.deletes.length} restores=${day.doc.restores.length} conflicts=${day.doc.conflicts.length} summaries=${day.summaryText ? 1 : 0} open=${day.doc.open.length} bytes=${day.bytes}`);
  }
  console.log(`[migrate] schema.json bytes=${Buffer.byteLength(plan.schemaText)} migratedAt=${plan.migratedAt}`);
  console.log(`[migrate] plan total bytes=${plan.totalBytes}`);
  if (opts.mode === 'dry-run') console.log('[migrate] dry-run: 未写入任何文件');
}

// ---------------------------------------------------------------- 写入 / 校验

// 单日原子写：先写同父目录下的临时目录，全部文件成功后再一次性 rename 落位。
// 任一步抛错都清理临时目录，绝不留半写的 records.json（评审 P2-1）。
export function writeDayAtomic(targetDir, files) {
  const parent = path.dirname(targetDir);
  const tmp = path.join(parent, `.${path.basename(targetDir)}.tmp-${process.pid}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  try {
    fs.mkdirSync(tmp, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(tmp, name), content, 'utf8');
    }
    if (fs.existsSync(targetDir)) throw new Error(`目标目录已存在：${targetDir}`);
    fs.renameSync(tmp, targetDir);
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
}

function applyPlan(plan) {
  const stage = path.join(plan.outputRoot, `timeline.tmp-${process.pid}`);
  const final = plan.finalDir;
  fs.mkdirSync(plan.outputRoot, { recursive: true });
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  fs.writeFileSync(path.join(stage, 'schema.json'), plan.schemaText, 'utf8');
  for (const day of plan.days) {
    // 每日先写到 stage 下的原子日目录；stage 本身再整体 rename 成 timeline/。
    writeDayAtomic(path.join(stage, day.date), day.files);
  }

  const skippedExisting = [];
  if (!fs.existsSync(final)) {
    // 目录级原子 rename：timeline/ 对外要么不存在、要么完整可见（schema 与所有日同时落地）。
    fs.renameSync(stage, final);
    return { stage: null, final, site: final, skippedExisting };
  }
  // final 已存在（--force）：只补缺失日，绝不覆盖已有日期目录。
  for (const day of plan.days) {
    const target = path.join(final, day.date);
    if (fs.existsSync(target)) {
      skippedExisting.push(day.date); // 绝不覆盖已有日期目录
      continue;
    }
    fs.renameSync(path.join(stage, day.date), target);
  }
  // 契约 §10 步骤 7 / §11：schema 标记最后落地。
  const schemaOut = path.join(final, 'schema.json');
  if (!fs.existsSync(schemaOut)) fs.copyFileSync(path.join(stage, 'schema.json'), schemaOut);
  return { stage, final, site: stage, skippedExisting };
}

function failVerify(reason) {
  throw new VerifyFailed(`校验失败：${reason}`);
}

function parseJsonlRows(file, day, name, required) {
  const rows = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line !== '');
  for (const [i, row] of rows.entries()) {
    let obj;
    try {
      obj = JSON.parse(row);
    } catch {
      failVerify(`${day}/${name} 第 ${i + 1} 行不是合法 JSON`);
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) failVerify(`${day}/${name} 第 ${i + 1} 行不是对象`);
    for (const key of required) {
      if (typeof obj[key] !== 'string' || !obj[key]) failVerify(`${day}/${name} 第 ${i + 1} 行缺字段 ${key}`);
    }
  }
  return rows;
}

function verifyDayDir(dir, day, plannedDay, skipBytes) {
  // 契约 §10 步骤 2：每日三本账本必须存在（无条目时是空文件）。
  for (const name of LEDGERS) {
    if (!fs.existsSync(path.join(dir, name))) failVerify(`缺少 ${day}/${name}`);
  }
  const file = path.join(dir, 'records.json');
  if (!fs.existsSync(file)) failVerify(`缺少 ${file}`);
  const text = fs.readFileSync(file, 'utf8');
  if (!text.endsWith('\n') || text.endsWith('\n\n')) failVerify(`${day}/records.json 尾换行不唯一`);
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    failVerify(`${day}/records.json 不是合法 JSON`);
  }
  // 校验只针对 records.json 的三个顶层字段 date / open / records（契约 §3）。
  if (doc.date !== day) failVerify(`${day}/records.json 的 date 不符`);
  if ('schemaVersion' in doc) failVerify(`${day}/records.json 不应含 schemaVersion`);
  if (!Array.isArray(doc.open) || !Array.isArray(doc.records)) failVerify(`${day}/records.json 缺少数组`);
  const lines = text.split('\n');
  const ids = new Set();
  if (!lines.includes('  "records": []')) {
    // 空数组写成一行；非空数组必须括号独占一行、每个对象恰好一行。
    const start = lines.indexOf('  "records": [');
    const end = lines.indexOf('  ]', start + 1);
    if (start < 0 || end < 0 || end - start - 1 !== doc.records.length) {
      failVerify(`${day}/records.json 记录未做到「一行一对象」`);
    }
    for (let i = start + 1; i < end; i += 1) {
      const line = lines[i];
      if (!line.startsWith('    {') || !(line.endsWith('},') || line.endsWith('}'))) {
        failVerify(`${day}/records.json 第 ${i + 1} 行不是单行对象`);
      }
      let obj;
      try {
        obj = JSON.parse(line.trim().replace(/,$/, ''));
      } catch {
        failVerify(`${day}/records.json 第 ${i + 1} 行无法解析`);
      }
      if (!obj || typeof obj !== 'object' || Array.isArray(obj) || 'deleted' in obj) {
        failVerify(`${day}/records.json 第 ${i + 1} 行含 deleted 或不是对象`);
      }
      // 每条记录的序列化必须与 §3 的纯函数逐字节一致。
      if (canonicalRecordLine(obj) !== line.trim().replace(/,$/, '')) {
        failVerify(`${day}/records.json 第 ${i + 1} 行不是规范字节`);
      }
      ids.add(obj.id);
    }
  }
  for (const id of doc.open) if (!ids.has(id)) failVerify(`${day}/records.json open 引用了不存在的 id ${id}`);

  const deletes = parseJsonlRows(path.join(dir, 'deleted.jsonl'), day, 'deleted.jsonl', ['id', 'ts', 'deletedAt']);
  const restores = parseJsonlRows(path.join(dir, 'restore.jsonl'), day, 'restore.jsonl', ['id', 'ts', 'restoredAt']);
  const conflicts = parseJsonlRows(path.join(dir, 'conflicts.jsonl'), day, 'conflicts.jsonl',
    ['id', 'ts', 'losingLine', 'decidedAt', 'dedupeKey']);
  const seenConflicts = new Set();
  for (const row of conflicts) {
    const obj = JSON.parse(row);
    const key = `${obj.id}\0${obj.ts}\0${obj.dedupeKey}`;
    if (seenConflicts.has(key)) failVerify(`${day}/conflicts.jsonl 重复 dedupeKey`);
    seenConflicts.add(key);
  }

  const summaryFile = path.join(dir, 'summary.json');
  const hasSummary = fs.existsSync(summaryFile);
  if (hasSummary) {
    try {
      JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
    } catch {
      failVerify(`${day}/summary.json 不是合法 JSON`);
    }
  }

  // byte-exact 回读：只对本次新建的日做（--force 跳过的旧日允许保留用户后改内容）。
  if (!skipBytes && plannedDay) {
    for (const [name, expected] of Object.entries(plannedDay.files)) {
      const actual = fs.readFileSync(path.join(dir, name), 'utf8');
      if (actual !== expected) failVerify(`${day}/${name} 回读字节与计划不符`);
    }
  }
  return {
    records: doc.records.length, deletes: deletes.length, restores: restores.length,
    conflicts: conflicts.length, summary: hasSummary ? 1 : 0
  };
}

// 逐日核对「本次写入日」的计数。actual 来自 verifyDayDir（summary 为单数键），
// expected 是 buildPlan 为该日携带的期望值。任一字段不符即校验失败（exit 3），
// 因此写入日的 conflicts/restores 即使只差一行也不会被跳过日的存在掩盖。
function verifyDayCounts(day, actual, expected) {
  const pairs = [
    ['records', actual.records, expected.records],
    ['deletes', actual.deletes, expected.deletes],
    ['restores', actual.restores, expected.restores],
    ['conflicts', actual.conflicts, expected.conflicts],
    ['summaries', actual.summary, expected.summaries]
  ];
  for (const [name, got, want] of pairs) {
    if (got !== want) failVerify(`${day} ${name} 计数 ${got} != 预期 ${want}`);
  }
}

function verifyPlan(plan, applied) {
  // 评审 P2-1：校验范围扩展到 timeline/ 下全部合法日期目录，而不只是 plan.days 的计数。
  const presentDays = fs.readdirSync(applied.final, { withFileTypes: true })
    .filter((e) => e.isDirectory() && DAY_RE.test(e.name))
    .map((e) => e.name)
    .sort();
  const planned = new Map(plan.days.map((d) => [d.date, d]));
  let records = 0;
  let deletes = 0;
  let restores = 0;
  let conflicts = 0;
  let summaries = 0;
  // 期望侧只累计「本次实际写入的日」（fresh 日 + --force 新补的日）的按日期望值；
  // skipped-existing 日的冲突/恢复是历史存量，不属于本次写入，不进入任何比对。
  const wroteExpected = { records: 0, deletes: 0, restores: 0, conflicts: 0, summaries: 0 };
  const wroteActual = { records: 0, deletes: 0, restores: 0, conflicts: 0, summaries: 0 };
  for (const day of presentDays) {
    const d = planned.get(day);
    const skipBytes = d ? applied.skippedExisting.includes(day) : false;
    const r = verifyDayDir(path.join(applied.final, day), day, d, skipBytes);
    records += r.records;
    deletes += r.deletes;
    restores += r.restores;
    conflicts += r.conflicts;
    summaries += r.summary;
    if (d && !skipBytes) {
      // 分日核对：每个写入日对自己的期望计数负责，不借用任何计划全量。
      verifyDayCounts(day, r, d);
      wroteExpected.records += d.records;
      wroteExpected.deletes += d.deletes;
      wroteExpected.restores += d.restores;
      wroteExpected.conflicts += d.conflicts;
      wroteExpected.summaries += d.summaries;
      wroteActual.records += r.records;
      wroteActual.deletes += r.deletes;
      wroteActual.restores += r.restores;
      wroteActual.conflicts += r.conflicts;
      wroteActual.summaries += r.summary;
    }
  }
  for (const d of plan.days) if (!presentDays.includes(d.date)) failVerify(`缺少日期目录 ${d.date}`);
  // 汇总复核同样只由写入日派生：写错任一日都会先被 verifyDayCounts 抓住；
  // 这里保留按写入日累计的防御性复核，避免把 plan.conflicts / plan.restores 的计划全量
  // （含被跳过日）误当成写入日的期望（复审 P1：历史冲突/恢复导致的误报失败）。
  if (wroteExpected.conflicts !== wroteActual.conflicts) {
    failVerify(`conflicts 计数 ${wroteActual.conflicts} != 预期 ${wroteExpected.conflicts}`);
  }
  if (wroteExpected.restores !== wroteActual.restores) {
    failVerify(`restores 计数 ${wroteActual.restores} != 预期 ${wroteExpected.restores}`);
  }
  return { days: presentDays.length, records, deletes, restores, conflicts, summaries };
}

// ---------------------------------------------------------------- main

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    return EXIT.OK;
  }
  const paths = resolvePaths(opts.repo, opts.out);
  if (!fs.existsSync(paths.devices) || !fs.statSync(paths.devices).isDirectory()) {
    throw new Refused(`拒绝：未找到 devices/ 目录：${paths.devices}`);
  }
  if (fs.existsSync(path.join(paths.finalDir, 'schema.json'))) {
    let schema;
    try {
      schema = JSON.parse(fs.readFileSync(path.join(paths.finalDir, 'schema.json'), 'utf8'));
    } catch {
      throw new Refused(`拒绝：${path.join(paths.finalDir, 'schema.json')} 无法解析为 JSON。`);
    }
    if (!schema || schema.schemaVersion !== 2) {
      throw new Refused(`拒绝：timeline/schema.json 的 schemaVersion 不是 2（实际：${JSON.stringify(schema && schema.schemaVersion)}），不覆盖。`);
    }
  }
  if (opts.mode === 'apply' && fs.existsSync(paths.finalDir) && !opts.force) {
    throw new Refused(`拒绝：目标 timeline/ 已存在（${paths.finalDir}）。请改用 --out <path> 指定新的输出目录，或加 --force 只补缺失的日期目录。`);
  }

  const plan = buildPlan(paths);
  printPlan(plan, opts);
  if (opts.mode === 'dry-run') return EXIT.OK;

  const applied = applyPlan(plan);
  if (applied.skippedExisting.length && !opts.quiet) {
    console.log(`[migrate] skipped-existing days=${applied.skippedExisting.join(',')}`);
  }
  try {
    const result = verifyPlan(plan, applied);
    console.log(`[migrate] verify ok days=${result.days} records=${result.records} deletes=${result.deletes} summaries=${result.summaries} skipped=${plan.skipped} conflicts=${result.conflicts} restores=${result.restores}`);
    if (applied.stage) fs.rmSync(applied.stage, { recursive: true, force: true });
    return EXIT.OK;
  } catch (err) {
    if (err instanceof VerifyFailed) {
      console.error(`[migrate] ${err.message}；保留现场 ${applied.site}`);
      return EXIT.VERIFY;
    }
    throw err;
  }
}

// 作为 CLI 直接执行时才运行 main；被测试 import 时只暴露纯函数 helpers。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (err) {
    if (err instanceof Refused) {
      console.error(err.message);
      process.exitCode = EXIT.REFUSED;
    } else {
      console.error(`[migrate] 未预期错误：${err && err.stack ? err.stack : String(err)}`);
      process.exitCode = EXIT.UNEXPECTED;
    }
  }
}
