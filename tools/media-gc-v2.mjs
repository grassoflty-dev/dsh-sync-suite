#!/usr/bin/env node
// mod-v2-media-gc：v2 共享时间线散图垃圾回收（默认只读；--delete 需 plan hash 确认）。
//
// ============================== 行为契约 ==============================
// 默认只读：扫描 <repo>/timeline/<YYYY-MM-DD>/media/*.jpg，按契约 §5/§7 的可见记录口径
// 计算「未被引用的散图」，逐日计数 + 总字节，打印计划与 planHash，**不写任何文件**。
//
// 默认只读；--delete 需 plan hash 确认
//
// --delete 必须在打印同一份计划后，用 --confirm <token> 交回该计划的 planHash：
//   token = sha256(按路径升序的 plan 列表以 '\n' 相连 + 末尾 '\n') 的前 12 位小写十六进制。
//   空计划也算出 token，但 --delete 空计划直接按「无事可做」拒绝（exit 2、零写入）。
// 无 token / token 不符 → 类型化中文拒绝 + exit 2 + 零写入。
// 允许删除时：只 unlink 计划内、且经路径断言确认位于 timeline/<date>/media/ 下的文件；
// 绝不碰 devices/**、records.json、三本账本、summary.json、schema.json 或任何其它路径；
// 每次 unlink 都写一行日志（--json 下写 stderr，保证 stdout 仍是纯 JSON）。
//
// 引用口径（严格照 docs/DATA-CONTRACT-v2.md §3/§4/§5/§7/§11 的纯规则，Node 内自包含实现）：
//   1. 每天 records.json 先按 id 折叠：较晚 ts 胜；同 (id,ts) 取规范整行 UTF-8 字节序较大者（§4）。
//   2. 再用当日 deleted.jsonl / restore.jsonl 过滤：D=max(deleted.ts)，R=max(restore.ts)，
//      **可见 iff 存在 R 且 R > D（严格大于）**；R 不存在或 R ≤ D（含相等，删除胜）→ 不可见（§7）。
//   3. 只有可见记录的 media[].file 才计入「已引用」；被删记录 / 折叠败者的媒体不保活。
//   4. media[].file 必须是不含路径的 <sha256 前 16 位小写 hex>.jpg（§5 / P2-11）；
//      带 /、\、.. 或位数不对的条目不保活，也不崩。
//   5. 一张散图只有在其裸文件名**不被任何可见记录**引用时才进计划；这是保守口径——
//      宁可多留一张孤儿图，也绝不删掉可能被引用的图。非法日期目录（非 YYYY-MM-DD）整目录跳过。
//
// 退出码：0 = 成功（只读计划已打印，或删除已完成）；
//         2 = 拒绝（参数/门槛不满足、token 缺失或错误、--delete 无事可做），零写入；
//         1 = 未预期错误（保留堆栈）。
//
// 不 import 任何非 Node 内建模块；不 commit / push、不碰 .git 与 profile。
// 与 tools/migrate-media-v1-to-v2.mjs 同一 CLI 风格（--repo / --json / --quiet / 类型化拒绝）。

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MEDIA_FILE_RE = /^[0-9a-f]{16}\.jpg$/;

// 契约 §2：日期目录必须是合法日历日（2026-13-99 这类必须跳过并计数）。
function isValidDay(text) {
  if (!DAY_RE.test(text)) return false;
  const [y, m, d] = text.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const EXIT = { OK: 0, UNEXPECTED: 1, REFUSED: 2 };

class Refused extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const sha256Hex = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

const USAGE = [
  '用法: node tools/media-gc-v2.mjs --repo <path> [--json] [--quiet] [--delete --confirm <token>]',
  '  --repo <path>      数据仓库根目录（或其 timeline/ 目录）',
  '  --json             输出机器可读 JSON（含 planHash / plan / perDay）',
  '  --quiet            省略逐日与逐文件明细，仅保留汇总与 planHash',
  '  --delete           删除计划内散图；必须与 --confirm <token> 同用',
  '  --confirm <token>  计划哈希（planHash），先不带 --delete 运行即可看到',
  '退出码: 0 成功；2 拒绝（参数/token/无事可做，零写入）；1 未预期错误'
].join('\n');

// ---------------------------------------------------------------- 参数 / 路径

function parseArgs(argv) {
  const opts = { repo: null, json: false, quiet: false, del: false, confirm: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--repo') {
      opts.repo = argv[++i];
      if (!opts.repo) throw new Refused('E_BAD_ARG', `拒绝：--repo 需要一个路径参数。\n${USAGE}`);
    } else if (arg === '--json') {
      opts.json = true;
    } else if (arg === '--quiet') {
      opts.quiet = true;
    } else if (arg === '--delete') {
      opts.del = true;
    } else if (arg === '--confirm') {
      opts.confirm = argv[++i];
      if (!opts.confirm) throw new Refused('E_BAD_ARG', `拒绝：--confirm 需要一个 token 参数。\n${USAGE}`);
    } else {
      throw new Refused('E_BAD_ARG', `拒绝：无法识别的参数 ${JSON.stringify(arg)}。\n${USAGE}`);
    }
  }
  if (!opts.repo) throw new Refused('E_MISSING_REPO', `拒绝：缺少 --repo 参数。\n${USAGE}`);
  if (opts.confirm !== null && !opts.del) {
    throw new Refused('E_CONFIRM_WITHOUT_DELETE',
      '拒绝：--confirm 仅在 --delete 时有意义；未指定 --delete（默认只读），不需要确认 token。');
  }
  if (opts.del && (opts.confirm === null || String(opts.confirm).trim() === '')) {
    throw new Refused('E_NO_CONFIRM',
      '拒绝：--delete 必须同时提供 --confirm <token>，token 为本次计划的 planHash（前 12 位十六进制）。请先不带 --delete 运行以查看计划与 planHash。');
  }
  return opts;
}

function resolvePaths(repoArg) {
  const abs = path.resolve(repoArg);
  let root = abs;
  let timeline = path.join(abs, 'timeline');
  if (!fs.existsSync(timeline)
    && path.basename(abs).toLowerCase() === 'timeline'
    && fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
    timeline = abs;
    root = path.dirname(abs);
  }
  return { repo: root, timeline };
}

// ---------------------------------------------------------------- 折叠 / 账本纯规则（与 model/timeline.ts 同口径）

const KEY_ORDER = [
  'id', 'ts', 'title', 'body', 'author', 'done', 'media',
  'ocr_text', 'ai_structured', 'ai_processed', 'ocr_time', 'opened_at', 'closed_at'
];
const KNOWN_KEYS = new Set(KEY_ORDER);

function canonicalLine(record) {
  const out = {};
  for (const key of KEY_ORDER) if (hasOwn(record, key)) out[key] = record[key];
  for (const key of Object.keys(record)) if (!KNOWN_KEYS.has(key)) out[key] = record[key];
  return JSON.stringify(out);
}

function tsMillis(ts) {
  if (typeof ts !== 'string') return Number.NaN;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? Number.NaN : ms;
}

function compareTs(a, b) {
  const ma = tsMillis(a);
  const mb = tsMillis(b);
  if (!Number.isNaN(ma) && !Number.isNaN(mb)) return ma === mb ? 0 : (ma < mb ? -1 : 1);
  const sa = typeof a === 'string' ? a : '';
  const sb = typeof b === 'string' ? b : '';
  return sa === sb ? 0 : (sa < sb ? -1 : 1);
}

function tsOfLedger(entry) {
  return typeof entry.ts === 'string' ? entry.ts : '';
}

// §7：D=max(deleted.ts)，R=max(restore.ts)；可见 iff 存在 R 且 R > D（严格），否则隐藏。
function deletionState(id, deletions, restores) {
  let d = null;
  for (const e of deletions) {
    if (e.id === id && (d === null || compareTs(tsOfLedger(e), d) > 0)) d = tsOfLedger(e);
  }
  if (d === null) return 'visible';
  let r = null;
  for (const e of restores) {
    if (e.id === id && (r === null || compareTs(tsOfLedger(e), r) > 0)) r = tsOfLedger(e);
  }
  return r !== null && compareTs(r, d) > 0 ? 'visible' : 'deleted';
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readLedger(file) {
  if (!fs.existsSync(file)) return [];
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const raw = line.trim();
    if (!raw) continue;
    let row;
    try { row = JSON.parse(raw); } catch { continue; }
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue;
    if (typeof row.id !== 'string' || !row.id || typeof row.ts !== 'string' || !row.ts) continue;
    out.push({ id: row.id, ts: row.ts });
  }
  return out;
}

function validMediaFiles(record) {
  const out = [];
  if (!Array.isArray(record.media)) return out;
  for (const m of record.media) {
    if (m === null || typeof m !== 'object' || Array.isArray(m)) continue;
    if (typeof m.file !== 'string' || !MEDIA_FILE_RE.test(m.file)) continue;
    out.push(m.file);
  }
  return out;
}

// 同 id 折叠：较晚 ts 胜；同 (id,ts) 取规范整行 UTF-8 字节序较大者。
function foldRecords(records) {
  const byId = new Map();
  for (const rec of records) {
    if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) continue;
    if (typeof rec.id !== 'string' || !rec.id) continue;
    if (typeof rec.ts !== 'string' || !rec.ts) continue;
    if (!Array.isArray(rec.media)) continue;
    const group = byId.get(rec.id);
    if (group === undefined) byId.set(rec.id, [rec]);
    else group.push(rec);
  }
  const winners = [];
  for (const group of byId.values()) {
    let best = group[0];
    let bestLine = canonicalLine(best);
    for (let i = 1; i < group.length; i += 1) {
      const candidate = group[i];
      const cmpTs = compareTs(candidate.ts, best.ts);
      if (cmpTs > 0) {
        best = candidate;
        bestLine = canonicalLine(best);
        continue;
      }
      if (cmpTs < 0) continue;
      const line = canonicalLine(candidate);
      if (Buffer.compare(Buffer.from(line, 'utf8'), Buffer.from(bestLine, 'utf8')) > 0) {
        best = candidate;
        bestLine = line;
      }
    }
    winners.push(best);
  }
  return winners;
}

// ---------------------------------------------------------------- 计划构建

function listDayDirs(timeline) {
  if (!fs.existsSync(timeline) || !fs.statSync(timeline).isDirectory()) return { valid: [], skipped: 0 };
  const valid = [];
  let skipped = 0;
  for (const entry of fs.readdirSync(timeline, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (isValidDay(entry.name)) valid.push(entry.name);
    else skipped += 1;
  }
  valid.sort();
  return { valid, skipped };
}

function buildPlan(paths) {
  const { valid: days, skipped: skippedDays } = listDayDirs(paths.timeline);
  const referenced = new Set();      // 所有可见记录的 media[].file 裸文件名
  const candidates = [];             // 所有实际存在的散图
  let badDays = 0;

  for (const date of days) {
    const dayDir = path.join(paths.timeline, date);
    const doc = readJsonFile(path.join(dayDir, 'records.json'));
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc) || !Array.isArray(doc.records)) {
      badDays += 1;
    } else {
      const folded = foldRecords(doc.records);
      const deletions = readLedger(path.join(dayDir, 'deleted.jsonl'));
      const restores = readLedger(path.join(dayDir, 'restore.jsonl'));
      for (const rec of folded) {
        if (deletionState(rec.id, deletions, restores) !== 'visible') continue;
        for (const file of validMediaFiles(rec)) referenced.add(file);
      }
    }

    const mediaDir = path.join(dayDir, 'media');
    if (!fs.existsSync(mediaDir) || !fs.statSync(mediaDir).isDirectory()) continue;
    for (const entry of fs.readdirSync(mediaDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.jpg')) continue;
      let bytes = 0;
      try {
        bytes = fs.statSync(path.join(mediaDir, entry.name)).size;
      } catch {
        continue;
      }
      candidates.push({
        date,
        file: entry.name,
        path: `timeline/${date}/media/${entry.name}`,
        bytes
      });
    }
  }

  candidates.sort((a, b) => a.path < b.path ? -1 : (a.path > b.path ? 1 : 0));
  const plan = candidates.filter((c) => !referenced.has(c.file));

  const sortedPaths = plan.map((p) => p.path).sort();
  const hashInput = sortedPaths.length ? `${sortedPaths.join('\n')}\n` : '';
  const planHash = sha256Hex(hashInput).slice(0, 12);

  const perDayMap = new Map();
  for (const c of candidates) {
    let row = perDayMap.get(c.date);
    if (!row) {
      row = { date: c.date, mediaFiles: 0, referenced: 0, unreferenced: 0, bytes: 0 };
      perDayMap.set(c.date, row);
    }
    row.mediaFiles += 1;
    if (referenced.has(c.file)) row.referenced += 1;
    else {
      row.unreferenced += 1;
      row.bytes += c.bytes;
    }
  }
  const perDay = [...perDayMap.values()].sort((a, b) => a.date < b.date ? -1 : (a.date > b.date ? 1 : 0));

  return {
    repo: paths.repo,
    days: days.length,
    skippedDays,
    badDays,
    mediaFiles: candidates.length,
    referenced: candidates.length - plan.length,
    unreferenced: plan.length,
    bytes: plan.reduce((sum, p) => sum + p.bytes, 0),
    plan,
    perDay,
    planHash
  };
}

// ---------------------------------------------------------------- 输出

function printPlan(result, opts, deleted) {
  if (opts.json) {
    const payload = {
      mode: opts.del ? 'delete' : 'read-only',
      repo: result.repo,
      planHash: result.planHash,
      days: result.days,
      skippedDays: result.skippedDays,
      badDays: result.badDays,
      mediaFiles: result.mediaFiles,
      referenced: result.referenced,
      unreferenced: result.unreferenced,
      bytes: result.bytes,
      perDay: result.perDay,
      plan: result.plan,
      deleted: deleted || []
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  console.log(`[gc] mode=${opts.del ? 'delete' : 'read-only'} repo=${result.repo} days=${result.days} media=${result.mediaFiles} referenced=${result.referenced} unreferenced=${result.unreferenced} bytes=${result.bytes} skippedDays=${result.skippedDays} badDays=${result.badDays}`);
  console.log(`[gc] planHash=${result.planHash}`);
  if (!opts.quiet) {
    for (const row of result.perDay) {
      console.log(`[gc] day ${row.date} media=${row.mediaFiles} referenced=${row.referenced} unreferenced=${row.unreferenced} bytes=${row.bytes}`);
    }
    for (const p of result.plan) {
      console.log(`[gc] orphan ${p.path} bytes=${p.bytes}`);
    }
  }
  if (opts.del) {
    console.log(`[gc] 已删除 ${deleted.length} 个文件；账本 / 记录 / devices/ 均未触碰`);
  } else {
    console.log('[gc] read-only: 未写入任何文件；删除需 --delete --confirm <planHash>');
  }
}

// ---------------------------------------------------------------- 删除（受确认门保护）

function preflightDeletion(paths, result, confirm) {
  if (result.unreferenced === 0) {
    throw new Refused('E_NOTHING_TO_DELETE',
      '拒绝：--delete 无事可做（计划中没有未引用的散图）；未删除任何文件。');
  }
  if (String(confirm).trim().toLowerCase() !== result.planHash.toLowerCase()) {
    throw new Refused('E_BAD_CONFIRM',
      `拒绝：--confirm token 与本次计划的 planHash 不符（期望 ${result.planHash}，实际 ${String(confirm).trim()}）。未删除任何文件；请先不带 --delete 重跑取得最新 planHash。`);
  }
  // 全部目标先断言一次，避免删到一半才发现问题（零部分写入）。
  const targets = [];
  const seen = new Set();
  for (const p of result.plan) {
    if (!MEDIA_FILE_RE.test(p.file) || !DAY_RE.test(p.date) || seen.has(p.path)) {
      throw new Refused('E_UNSAFE_PATH', `拒绝：计划项路径不合法：${p.path}。未删除任何文件。`);
    }
    seen.add(p.path);
    const mediaRoot = path.resolve(paths.repo, 'timeline', p.date, 'media');
    const abs = path.resolve(mediaRoot, p.file);
    if (path.dirname(abs) !== mediaRoot || path.basename(abs) !== p.file) {
      throw new Refused('E_UNSAFE_PATH', `拒绝：计划项逃出 media 目录：${p.path}。未删除任何文件。`);
    }
    let stat;
    try { stat = fs.statSync(abs); } catch {
      throw new Refused('E_PLAN_STALE', `拒绝：计划项已不存在：${p.path}。未删除任何文件；请重跑取得最新计划。`);
    }
    if (!stat.isFile()) {
      throw new Refused('E_UNSAFE_PATH', `拒绝：计划项不是普通文件：${p.path}。未删除任何文件。`);
    }
    if (stat.size !== p.bytes) {
      throw new Refused('E_PLAN_STALE', `拒绝：计划项大小已变化：${p.path}（计划 ${p.bytes}，实际 ${stat.size}）。未删除任何文件；请重跑取得最新计划。`);
    }
    targets.push({ ...p, abs });
  }
  return targets;
}

function unlinkAll(targets) {
  const deleted = [];
  for (const t of targets) {
    fs.unlinkSync(t.abs);
    const record = { path: t.path, bytes: t.bytes, date: t.date, file: t.file };
    deleted.push(record);
    // 每次 unlink 都留痕；统一写 stderr，使 --json 的 stdout 保持纯 JSON。
    process.stderr.write(`[gc] unlink ${t.path} bytes=${t.bytes}\n`);
  }
  return deleted;
}

// ---------------------------------------------------------------- main

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    return EXIT.OK;
  }
  const paths = resolvePaths(opts.repo);
  const result = buildPlan(paths);
  let deleted = [];
  if (opts.del) {
    const targets = preflightDeletion(paths, result, opts.confirm);
    deleted = unlinkAll(targets);
  }
  printPlan(result, opts, deleted);
  return EXIT.OK;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (err) {
    if (err instanceof Refused) {
      process.stderr.write(`[gc] 拒绝：${err.code} ${err.message}\n`);
      process.exitCode = EXIT.REFUSED;
    } else {
      process.stderr.write(`[gc] 未预期错误：${err && err.stack ? err.stack : String(err)}\n`);
      process.exitCode = EXIT.UNEXPECTED;
    }
  }
}
