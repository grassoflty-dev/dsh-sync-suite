#!/usr/bin/env node
// mod-v2-media-migration：v1 按天附件 zip -> v2 timeline/<date>/media/<sha16>.jpg。
//
// 输入（只读）：devices/<deviceId>/schedules/*.jsonl（v1 记录里的 attachments[]）、
//               devices/<deviceId>/attachments/<YYYY-MM-DD>.zip（v1 按天 zip）。
// 输出（只写）：<repo>/timeline.tmp-<pid>/media/<date>/<sha16>.jpg（暂存）
//               -> <repo>/timeline/<date>/media/<sha16>.jpg（逐文件原子 rename）。
// 绝不写 devices/、不改 app / 插件代码、不 commit / push、不碰 .git 与 profile。
// 记录迁移（tools/migrate-v1-to-v2.mjs）已写好裸 <sha16>.jpg 占位；本工具只负责把字节补上。
//
// ============================ 无依赖解包决策（中文说明） ============================
// 决策：用 Node 内置模块实现一个**最小 ZIP 读取器**，不新增任何 npm 依赖。
// 实现要点：
//   - 从文件尾向前扫描 ≤64 KiB+22 字节找 EOCD 签名 0x06054b50；
//   - 读中央目录 0x02014b50 拿每个条目的名字 / 方法 / CRC / 大小 / 本地头偏移；
//   - 读本地头 0x04034b50 定位数据区；
//   - 只支持 stored（method 0）与 deflate（method 8，zlib.inflateRawSync）；
//   - 校验解压后字节数与 CRC-32（标准反转多项式表 0xEDB88320），不符 -> 逐条目错误，文件不写；
//   - 逐条目类型化拒绝：ZIP64（EOCD 前 20 字节出现定位器 0x07064b50，或 EOCD 哨兵值）、
//     加密条目（flag bit 0）、不支持的方法（12/bzip2、14/LZMA 等）；
//   - 单文件上限 256 MiB（压缩字节与解压字节各 cap），超出 -> 类型化拒绝；
//   - 任何错误都记入计数并继续处理其余条目 / 其余 zip，直到最后统一决定退出码。
//
// 考虑过的替代方案（均未采用）：
//   1) 加依赖 jszip / yauzl：会扩大供应链攻击面，且需要改 package.json / lockfile，
//      违反「no new dependencies」硬性约束；
//   2) shell 出 tar / PowerShell Expand-Archive：跨平台 shell 依赖、参数与错误语义不一致，
//      不可在纯 Node 单测里稳定复现，且存在路径穿越风险；
//   3) 让 app 侧 WebView 的 JSZip 复用：跨运行时耦合，离线 CLI 无法独立运行。
// 内置模块胜出：零供应链面、行为确定、可直接用 node:test 覆盖、无跨平台 shell 依赖。
// 已知限制（明确声明）：ZIP64、多磁盘、加密条目不支持，遇到即类型化拒绝（exit 3），
// 不会尝试猜测或写入半成品；超出大小上限的 zip 同样拒绝。这与「按天 zip 很小」的 v1 现状匹配。
//
// 契约依据：docs/DATA-CONTRACT-v2.md §2/§5/§10/§11，docs/DATA-CONTRACT.md §4ter。
//   §4ter：v1 zip 条目名 page-<pageIndex>-<sha8>.jpg，attachment 元素带
//           {sha256, name, pageIndex, archive, entry}；archive 是 zip 文件名，entry 是 zip 内条目名。
//   §5：媒体命名裸 <sha256[0:16]>.jpg；同日 sha16 碰撞 -> E_MEDIA_SHA16_COLLISION，不覆盖。
//   §11：schema 标记最后落地，未过门槛零写入（本工具把「标记存在且 schemaVersion=2」作为 apply 前置）。

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_ZIP_BYTES = 256 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
const MAX_REPORT = 10;

const EOCD_SIG = 0x06054b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

const EXIT = { OK: 0, UNEXPECTED: 1, REFUSED: 2, VERIFY: 3 };

class Refused extends Error {}
class VerifyFailed extends Error {}

// 全部“可预期的坏输入”都归类为 EntryError，带 type 字段供报告与测试断言。
class EntryError extends Error {
  constructor(type, message) {
    super(message);
    this.type = type;
  }
}

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex');
const sha16Of = (sha) => sha.slice(0, 16);
const mediaName = (sha) => `${sha16Of(sha)}.jpg`;

const USAGE = [
  '用法: node tools/migrate-media-v1-to-v2.mjs --repo <path> [--dry-run|--apply] [--force] [--out <path>] [--quiet]',
  '  --repo <path>  v1 仓库根目录，或直接指向其 devices/ 目录',
  '  --dry-run      默认：只打印计划，不写任何文件（不要求 timeline/schema.json）',
  '  --apply        写入 timeline.tmp-<pid>/media/ 后校验并逐文件原子合并进 timeline/<date>/media/',
  '                 （要求 timeline/schema.json 的 schemaVersion=2，即记录迁移必须先跑）',
  '  --force        有逐条目错误时仍把已成功解包的条目合并进 timeline/；错误照报，退出码仍为 3',
  '  --out <path>   指定另一个输出根目录（timeline/ 与 timeline.tmp-* 都建在其下）',
  '  --quiet        省略计划明细，仅保留结果与错误',
  '退出码:',
  '  0  成功：dry-run 计划已产出，或 --apply 已校验并合并（含已存在相同字节跳过）',
  '  1  未预期错误（unexpected）',
  '  2  拒绝：参数/门槛不满足（缺 devices/、缺 timeline/schema.json、schemaVersion≠2 等），零写入',
  '  3  校验失败：逐条目错误 / missing / cross-missing / sha-mismatch；默认未合并（--force 仍报 3）'
].join('\n');

// ---------------------------------------------------------------- 参数 / 路径

function parseArgs(argv) {
  const opts = { repo: null, mode: 'dry-run', force: false, out: null, quiet: false };
  let sawDry = false;
  let sawApply = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--repo') {
      opts.repo = argv[++i];
      if (!opts.repo) throw new Refused(`拒绝：--repo 需要一个路径参数。\n${USAGE}`);
    } else if (arg === '--out') {
      opts.out = argv[++i];
      if (!opts.out) throw new Refused(`拒绝：--out 需要一个路径参数。\n${USAGE}`);
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
  if (sawDry && sawApply) throw new Refused(`拒绝：--dry-run 与 --apply 不能同时使用。\n${USAGE}`);
  if (sawApply) opts.mode = 'apply';
  if (!opts.repo) throw new Refused(`拒绝：缺少 --repo 参数。\n${USAGE}`);
  return opts;
}

// 与记录迁移工具一致：--repo 可直接指向 devices/。
function resolvePaths(repoArg, outArg) {
  const repo = path.resolve(repoArg);
  let root = repo;
  let devices = path.join(repo, 'devices');
  if (!fs.existsSync(devices) && fs.existsSync(repo) && fs.statSync(repo).isDirectory()) {
    const looksLikeDevices = path.basename(repo).toLowerCase() === 'devices'
      || fs.readdirSync(repo, { withFileTypes: true }).some((entry) => {
        if (!entry.isDirectory()) return false;
        const child = path.join(repo, entry.name);
        return ['schedules', 'attachments', 'open.jsonl'].some((name) => fs.existsSync(path.join(child, name)));
      });
    if (looksLikeDevices) {
      devices = repo;
      root = path.dirname(repo);
    }
  }
  const outputRoot = outArg ? path.resolve(outArg) : root;
  return {
    repo, root, devices, outputRoot,
    finalDir: path.join(outputRoot, 'timeline'),
    stageDir: path.join(outputRoot, `timeline.tmp-${process.pid}`)
  };
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

function readLines(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line.trim() !== '');
}

// ---------------------------------------------------------------- CRC-32（标准表）

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

// ---------------------------------------------------------------- 最小 ZIP 读取器

// 返回 Map<entryName, {name, flags, method, crc, compSize, uncompSize, locOff}>。
// 只用中央目录作为元数据权威；本地头只用来定位数据区。
function readCentralDirectory(buf, label) {
  if (buf.length < 22) throw new EntryError('zip-eocd', `${label}: 文件不足 22 字节，无 EOCD`);
  let eocd = -1;
  const low = Math.max(0, buf.length - (22 + 0xFFFF));
  for (let i = buf.length - 22; i >= low; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new EntryError('zip-eocd', `${label}: 未找到 EOCD 签名 0x06054b50`);

  // ZIP64 定位器固定在 EOCD 前 20 字节；出现即类型化拒绝（本工具不支持 ZIP64）。
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === EOCD64_LOCATOR_SIG) {
    throw new EntryError('zip64', `${label}: 检测到 ZIP64 定位器 0x07064b50，不支持`);
  }

  const diskNo = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const nOnDisk = buf.readUInt16LE(eocd + 8);
  const nTotal = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  const commentLen = buf.readUInt16LE(eocd + 20);
  if (eocd + 22 + commentLen > buf.length) {
    throw new EntryError('zip-truncated', `${label}: EOCD 注释长度超出文件末尾`);
  }
  if (nTotal === 0xFFFF || cdSize === 0xFFFFFFFF || cdOff === 0xFFFFFFFF || nOnDisk === 0xFFFF) {
    throw new EntryError('zip64', `${label}: EOCD 含 ZIP64 哨兵值，不支持`);
  }
  if (diskNo !== 0 || cdDisk !== 0 || nOnDisk !== nTotal) {
    throw new EntryError('zip-multidisk', `${label}: 多磁盘 ZIP 不支持`);
  }
  if (cdOff + cdSize > eocd) {
    throw new EntryError('zip-truncated', `${label}: 中央目录区间超出 EOCD 之前`);
  }

  const entries = new Map();
  let p = cdOff;
  for (let i = 0; i < nTotal; i += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) {
      throw new EntryError('zip-truncated', `${label}: 中央目录第 ${i + 1} 项签名错误`);
    }
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const locOff = buf.readUInt32LE(p + 42);
    const end = p + 46 + nameLen + extraLen + cmtLen;
    if (end > buf.length) throw new EntryError('zip-truncated', `${label}: 中央目录第 ${i + 1} 项越界`);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.set(name, { name, flags, method, crc, compSize, uncompSize, locOff });
    p = end;
  }
  return entries;
}

// 解出单个条目并做大小 / CRC 校验。任一失败 -> 抛 EntryError（带 type）。
function extractEntry(buf, entry, label) {
  const { name, flags, method, crc, compSize, uncompSize, locOff } = entry;
  const where = `${label}!${name}`;
  if (flags & 1) throw new EntryError('encrypted', `${where}: 加密条目（flag bit 0）不支持`);
  if (method !== 0 && method !== 8) {
    throw new EntryError('unsupported-method', `${where}: 不支持的压缩方法 ${method}（仅支持 0=stored / 8=deflate）`);
  }
  if (uncompSize > MAX_UNCOMPRESSED_BYTES || compSize > MAX_UNCOMPRESSED_BYTES) {
    throw new EntryError('zip-too-large', `${where}: 条目大小超过 ${MAX_UNCOMPRESSED_BYTES} 字节上限`);
  }
  if (locOff + 30 > buf.length || buf.readUInt32LE(locOff) !== LOC_SIG) {
    throw new EntryError('zip-truncated', `${where}: 本地头签名 0x04034b50 缺失`);
  }
  const nameLen = buf.readUInt16LE(locOff + 26);
  const extraLen = buf.readUInt16LE(locOff + 28);
  const start = locOff + 30 + nameLen + extraLen;
  if (start + compSize > buf.length) throw new EntryError('zip-truncated', `${where}: 条目数据越界`);
  const packed = buf.subarray(start, start + compSize);
  let raw;
  try {
    raw = method === 0 ? Buffer.from(packed) : zlib.inflateRawSync(packed);
  } catch (err) {
    throw new EntryError('inflate-failed', `${where}: deflate 解压失败（${err && err.message ? err.message : String(err)}）`);
  }
  if (raw.length !== uncompSize) {
    throw new EntryError('size-mismatch', `${where}: 解压字节数 ${raw.length} != 中央目录 ${uncompSize}`);
  }
  if (crc32(raw) !== crc) {
    throw new EntryError('crc-mismatch', `${where}: CRC-32 不符（解压字节未被写入）`);
  }
  return raw;
}

// ---------------------------------------------------------------- 折叠 v1 记录（与记录工具同规则）

// 镜像 tools/migrate-v1-to-v2.mjs 的 KEY_ORDER / canonicalRecordLine / cmpTs /
// pickWinner：同 id 较晚 ts 胜；同 (id,ts) 取规范整行 UTF-8 字节序较大者。
// 这里刻意不 import，保持本工具自包含（node: builtins only）。
const KEY_ORDER = [
  'id', 'ts', 'title', 'body', 'author', 'done', 'media',
  'ocr_text', 'ai_structured', 'ai_processed', 'ocr_time', 'opened_at', 'closed_at'
];
const KNOWN_KEYS = new Set(KEY_ORDER);

function canonicalLine(rec) {
  const out = {};
  for (const key of KEY_ORDER) if (hasOwn(rec, key)) out[key] = rec[key];
  for (const key of Object.keys(rec)) if (!KNOWN_KEYS.has(key)) out[key] = rec[key];
  return JSON.stringify(out);
}

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

function pickWinner(versions) {
  let best = null;
  for (const rec of versions) {
    if (!best) { best = rec; continue; }
    const cmp = cmpTs(rec.ts, best.ts);
    if (cmp > 0) { best = rec; continue; }
    if (cmp < 0) continue;
    const byteCmp = Buffer.compare(Buffer.from(canonicalLine(rec), 'utf8'), Buffer.from(canonicalLine(best), 'utf8'));
    if (byteCmp > 0) best = rec; // 字节较大者胜；相等视为真重复，保留先者即可
  }
  return best;
}

// 收集引用：archive(zip 文件名) -> Map(entry -> {sha256, ids, day})。
// 同时按 sha16 建索引，供「同日 sha16 碰撞」检测（§5）。
function collectReferences(devices) {
  const byArchive = new Map();
  const stats = { devices: 0, records: 0, skippedLines: 0, noSha: 0, noEntry: 0, noArchive: 0, badEntry: 0 };
  for (const device of listDeviceDirs(devices)) {
    stats.devices += 1;
    const scheduleDir = path.join(devices, device, 'schedules');
    for (const name of listDir(scheduleDir)) {
      if (!name.endsWith('.jsonl')) continue;
      const day = path.basename(name, '.jsonl');
      if (!DAY_RE.test(day)) { stats.skippedLines += 1; continue; }
      const versions = new Map();
      for (const line of readLines(path.join(scheduleDir, name))) {
        let rec;
        try { rec = JSON.parse(line); } catch { stats.skippedLines += 1; continue; }
        if (!rec || typeof rec !== 'object' || Array.isArray(rec)
          || typeof rec.id !== 'string' || !rec.id
          || typeof rec.ts !== 'string' || !rec.ts) {
          stats.skippedLines += 1;
          continue;
        }
        if (!versions.has(rec.id)) versions.set(rec.id, []);
        versions.get(rec.id).push(rec);
      }
      for (const [id, recVersions] of versions) {
        const winner = pickWinner(recVersions);
        if (!winner) continue;
        stats.records += 1;
        if (!Array.isArray(winner.attachments)) continue;
        for (const att of winner.attachments) {
          if (!att || typeof att !== 'object' || Array.isArray(att)) continue;
          if (typeof att.sha256 !== 'string' || !SHA256_RE.test(att.sha256)) { stats.noSha += 1; continue; }
          if (typeof att.entry !== 'string' || att.entry === '') { stats.noEntry += 1; continue; }
          if (typeof att.archive !== 'string' || !att.archive.endsWith('.zip')) { stats.noArchive += 1; continue; }
          // entry 只作为 zip 内 Map key，不拼文件路径；仍拒绝明显穿越形态。
          if (att.entry.startsWith('/') || att.entry.split('/').includes('..') || att.entry.includes('\\')) {
            stats.badEntry += 1;
            continue;
          }
          if (!byArchive.has(att.archive)) byArchive.set(att.archive, new Map());
          const entries = byArchive.get(att.archive);
          const prev = entries.get(att.entry);
          if (prev) {
            prev.ids.add(id);
            if (prev.sha256 !== att.sha256) prev.conflict = true; // 同 (archive,entry) 两个 sha256：数据不一致
          } else {
            entries.set(att.entry, { sha256: att.sha256, ids: new Set([id]), day, conflict: false });
          }
        }
      }
    }
  }
  return { byArchive, stats };
}

// ---------------------------------------------------------------- 计划构建

function makeDay(date) {
  return {
    date, zips: [], entries: 0, writes: [], unreferenced: 0,
    errors: [], missing: [], missingRefs: [], bytes: 0,
    alreadyPresent: [], duplicates: 0
  };
}

function pushError(day, err) {
  const type = err instanceof EntryError ? err.type : 'unexpected';
  day.errors.push({ type, message: err && err.message ? err.message : String(err) });
}

function listDayZips(devices) {
  const out = [];
  for (const device of listDeviceDirs(devices)) {
    const dir = path.join(devices, device, 'attachments');
    for (const name of listDir(dir)) {
      if (!name.endsWith('.zip')) continue;
      const date = path.basename(name, '.zip');
      out.push({ device, date, archive: name, file: path.join(dir, name) });
    }
  }
  out.sort((a, b) => a.archive.localeCompare(b.archive) || a.device.localeCompare(b.device));
  return out;
}

// 对「同一天」的全部引用按 sha16 分组，标出「不同 sha256 共用前 16 位」的碰撞（§5）。
// 只打 skip 标记，不在此记错误：真正遍历到该 zip 条目时再记一条 sha16-collision，
// 这样每个 zip 条目恰好落入 written / skipped / errors 一类，算术闭合。
function markSha16Collisions(refList) {
  const groups = new Map(); // sha16 -> [{archive, entryName, ref}]
  for (const item of refList) {
    const key = sha16Of(item.ref.sha256);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  for (const [sha16, items] of groups) {
    const shas = new Set(items.map((i) => i.ref.sha256));
    if (shas.size < 2) continue;
    for (const item of items) {
      item.ref.skip = true;
      item.ref.skipReason = `sha16=${sha16} 被多个不同 sha256 共用（${[...shas].join(', ')}），跳过且不覆盖`;
    }
  }
}

function buildPlan(paths) {
  const refs = collectReferences(paths.devices);
  const zips = listDayZips(paths.devices);
  const days = new Map();
  // P2-1: 同一输出路径（<date>/<sha16>.jpg）的写入声明跨全部 zip 共享，不再每个 zip 各建一份。
  // stagedPath 由该路径派生（裸 <sha16>.jpg），所以按最终输出路径认领即可覆盖跨设备同日同名 zip。
  // 值记录首个「提取字节」的 sha256 与来源，用于区分「字节相同」与「字节冲突」：
  //   字节相同 -> 记为重复、不重复写暂存；字节不同 -> 类型化冲突错误、fail-closed 不合并。
  // 注意：这里刻意比较提取字节的 sha256，而不是记录里的 ref.sha256——
  // 跨设备同名条目共用同一 ref.sha256，但某设备的 zip 字节可能被篡改，只看 ref.sha256 会漏判。
  const stagedClaims = new Map(); // finalPath -> { extractedSha, source }
  const getDay = (date) => {
    if (!days.has(date)) days.set(date, makeDay(date));
    return days.get(date);
  };

  // 先按「同日」汇聚全部引用（跨 archive 也算同一天），再做 sha16 碰撞检测。
  const byDate = new Map(); // date -> [{archive, entryName, ref}]
  for (const [archive, entries] of refs.byArchive) {
    const date = path.basename(archive, '.zip');
    getDay(date); // 保证即使 archive 不存在也有该日条目（missing 会落到这里）
    if (!byDate.has(date)) byDate.set(date, []);
    for (const [entryName, ref] of entries) byDate.get(date).push({ archive, entryName, ref });
  }
  for (const refList of byDate.values()) markSha16Collisions(refList);
  // 引用了不存在的 archive -> missing（不会创建空文件）。
  const presentArchives = new Set(zips.map((z) => z.archive));
  for (const [archive, entries] of refs.byArchive) {
    if (presentArchives.has(archive)) continue;
    const day = getDay(path.basename(archive, '.zip'));
    for (const [entryName, ref] of entries) {
      day.missingRefs.push({ id: [...ref.ids][0], archive, entry: entryName, sha256: ref.sha256 });
    }
  }

  for (const zip of zips) {
    const day = getDay(zip.date);
    day.zips.push(zip.archive);
    let buf;
    try {
      buf = fs.readFileSync(zip.file);
    } catch (err) {
      day.entries += 1;
      pushError(day, new EntryError('zip-io', `${zip.archive}: 读取失败（${err.message}）`));
      continue;
    }
    if (buf.length > MAX_ZIP_BYTES) {
      day.entries += 1;
      pushError(day, new EntryError('zip-too-large', `${zip.archive}: ${buf.length} 字节超过 ${MAX_ZIP_BYTES} 上限`));
      continue;
    }
    let central;
    try {
      central = readCentralDirectory(buf, zip.archive);
    } catch (err) {
      day.entries += 1; // 无法枚举时按 1 个“zip 级条目”计入，保持算术闭合
      pushError(day, err);
      continue;
    }
    day.entries += central.size;
    const wanted = refs.byArchive.get(zip.archive) || new Map();

    for (const [entryName, ref] of wanted) {
      if (!central.has(entryName)) {
        day.missingRefs.push({ id: [...ref.ids][0], archive: zip.archive, entry: entryName, sha256: ref.sha256 });
      }
    }

    const names = [...central.keys()].sort();
    for (const entryName of names) {
      const ent = central.get(entryName);
      const ref = wanted.get(entryName);
      if (!ref) { day.unreferenced += 1; continue; }
      if (ref.skip) {
        pushError(day, new EntryError('sha16-collision', `${zip.archive}!${entryName}: ${ref.skipReason}`));
        continue;
      }
      if (ref.conflict) {
        pushError(day, new EntryError('entry-sha-conflict', `${zip.archive}!${entryName}: 多条记录给出不同 sha256，跳过`));
        continue;
      }
      const sha16 = sha16Of(ref.sha256);
      let bytes;
      try {
        bytes = extractEntry(buf, ent, zip.archive);
      } catch (err) {
        pushError(day, err);
        continue;
      }
      const name = mediaName(ref.sha256);
      const finalPath = path.join(paths.finalDir, day.date, 'media', name);
      // P2-1: 跨 zip 的同一输出路径必须比对实际提取字节，不能只看共用的 ref.sha256。
      const extractedSha = sha256Hex(bytes);
      const source = `${zip.device}/${zip.archive}!${entryName}`;
      const claim = stagedClaims.get(finalPath);
      if (claim) {
        if (claim.extractedSha === extractedSha) {
          day.duplicates += 1; // 字节相同：保留首个写，后续记为重复，计数不虚高
          continue;
        }
        pushError(day, new EntryError('entry-sha-conflict',
          `${day.date} ${name}: 同名条目在不同设备给出不同字节（${claim.source} vs ${source}），跳过且不覆盖`));
        continue;
      }
      stagedClaims.set(finalPath, { extractedSha, source });
      let status = 'absent';
      if (fs.existsSync(finalPath)) {
        let existing;
        try { existing = fs.readFileSync(finalPath); } catch { existing = null; }
        if (existing && existing.equals(bytes)) status = 'identical';
        else status = 'different';
      }
      const write = {
        date: day.date, name, sha16, sha256: ref.sha256, bytes,
        entry: entryName, archive: zip.archive, finalPath, status
      };
      if (status === 'identical') {
        day.alreadyPresent.push(name);
      } else if (status === 'different') {
        pushError(day, new EntryError('existing-different', `${path.relative(paths.outputRoot, finalPath)} 已存在且字节不同，绝不覆盖`));
      } else {
        day.writes.push(write);
        day.bytes += bytes.length;
      }
    }
  }

  // 与 v2 records.json 交叉核对：每个 media[].file 必须会被产出或已存在。
  const crossMissing = [];
  const crossPlaceholders = [];
  let crossDays = 0;
  // 覆盖 timeline/ 下所有合法日期目录（不只本次有 zip 的日），与记录工具 §P2-1 的校验口径一致。
  const crossDates = new Set(days.keys());
  if (fs.existsSync(paths.finalDir)) {
    for (const entry of fs.readdirSync(paths.finalDir, { withFileTypes: true })) {
      if (entry.isDirectory() && DAY_RE.test(entry.name)) crossDates.add(entry.name);
    }
  }
  for (const date of [...crossDates].sort()) {
    const day = days.get(date) || makeDay(date);
    const produced = new Set([
      ...day.writes.map((w) => w.name),
      ...day.alreadyPresent
    ]);
    const recFile = path.join(paths.finalDir, date, 'records.json');
    if (!fs.existsSync(recFile)) continue;
    crossDays += 1;
    let doc;
    try { doc = JSON.parse(fs.readFileSync(recFile, 'utf8')); } catch { continue; }
    if (!doc || !Array.isArray(doc.records)) continue;
    for (const rec of doc.records) {
      if (!rec || !Array.isArray(rec.media)) continue;
      for (const m of rec.media) {
        if (!m || typeof m.file !== 'string' || m.file === '') continue;
        crossPlaceholders.push({ date, file: m.file, id: rec.id });
        const safeName = !m.file.includes('/') && !m.file.includes('\\') && !m.file.includes('..');
        const onDisk = safeName && fs.existsSync(path.join(paths.finalDir, date, 'media', m.file));
        if (!safeName || (!produced.has(m.file) && !onDisk)) {
          crossMissing.push({ date, file: m.file, id: rec.id });
        }
      }
    }
  }

  const sortedDays = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
  const totals = sortedDays.reduce((acc, d) => {
    acc.entries += d.entries;
    acc.written += d.writes.length;
    acc.skipped += d.unreferenced + d.duplicates + d.alreadyPresent.length;
    acc.errors += d.errors.length;
    acc.unreferenced += d.unreferenced;
    acc.alreadyPresent += d.alreadyPresent.length;
    acc.bytes += d.bytes;
    acc.missing += d.missingRefs.length;
    return acc;
  }, { days: sortedDays.length, entries: 0, written: 0, skipped: 0, errors: 0, unreferenced: 0, alreadyPresent: 0, bytes: 0, missing: 0 });

  return {
    ...paths, refs: refs.stats, zips, days: sortedDays, totals,
    crossDays, crossPlaceholders: crossPlaceholders.length, crossMissing
  };
}

// ---------------------------------------------------------------- 计划输出

function reportBounded(items, prefix, max = MAX_REPORT) {
  for (const item of items.slice(0, max)) console.log(`[media]   ${prefix} ${item}`);
  if (items.length > max) console.log(`[media]   ...(另有 ${items.length - max} 条，省略)`);
}

function printPlan(plan, opts) {
  if (opts.quiet) return;
  const t = plan.totals;
  console.log(`[media] mode=${opts.mode} repo=${plan.repo} devices=${plan.devices} out=${plan.outputRoot}`);
  const schemaPath = path.join(plan.finalDir, 'schema.json');
  if (fs.existsSync(schemaPath)) {
    let version = '(unparsable)';
    try { version = JSON.parse(fs.readFileSync(schemaPath, 'utf8')).schemaVersion; } catch { /* keep sentinel */ }
    console.log(`[media] schema: schemaVersion=${JSON.stringify(version)}`);
  } else {
    console.log('[media] schema: 缺失（dry-run 允许产出计划；--apply 需先运行记录迁移）');
  }
  console.log(`[media] refs: devices=${plan.refs.devices} records=${plan.refs.records} skippedLines=${plan.refs.skippedLines} noSha=${plan.refs.noSha} noEntry=${plan.refs.noEntry} noArchive=${plan.refs.noArchive} badEntry=${plan.refs.badEntry}`);
  // entries = written + skipped + errors（每个 zip 条目恰好落入一类）
  console.log(`[media] plan days=${t.days} zips=${plan.zips.length} entries=${t.entries} written=${t.written} skipped=${t.skipped} errors=${t.errors} unreferenced=${t.unreferenced} already-present=${t.alreadyPresent} missing=${t.missing} bytes=${t.bytes}`);
  for (const day of plan.days) {
    console.log(`[media] day ${day.date} zips=${day.zips.length ? day.zips.join(',') : '(none)'} entries=${day.entries} written=${day.writes.length} skipped=${day.unreferenced + day.duplicates + day.alreadyPresent.length} errors=${day.errors.length} unreferenced=${day.unreferenced} already-present=${day.alreadyPresent.length} missing=${day.missingRefs.length} bytes=${day.bytes}`);
    if (day.errors.length) reportBounded(day.errors.map((e) => `${e.type}: ${e.message}`), 'error');
    if (day.missingRefs.length) reportBounded(day.missingRefs.map((m) => `${m.id} ${m.archive}!${m.entry}`), 'missing');
  }
  console.log(`[media] cross-check days=${plan.crossDays} placeholders=${plan.crossPlaceholders} missing=${plan.crossMissing.length}`);
  if (plan.crossMissing.length) {
    reportBounded(plan.crossMissing.map((m) => `${m.date} ${m.id} ${m.file}`), 'cross-missing');
  }
  if (opts.mode === 'dry-run') console.log('[media] dry-run: 未写入任何文件');
}

// ---------------------------------------------------------------- apply：暂存 / 校验 / 合并

function writeStaging(plan) {
  const stage = plan.stageDir;
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  for (const day of plan.days) {
    if (day.writes.length === 0) continue;
    const dir = path.join(stage, 'media', day.date);
    fs.mkdirSync(dir, { recursive: true });
    for (const w of day.writes) {
      const staged = path.join(dir, w.name);
      fs.writeFileSync(staged, w.bytes);
      w.stagedPath = staged;
    }
  }
}

// 回读每个暂存文件，重算 sha256 并与记录里的完整 sha256 比对。
function verifyStaging(plan) {
  const failures = [];
  for (const day of plan.days) {
    for (const w of day.writes) {
      const actual = sha256Hex(fs.readFileSync(w.stagedPath));
      if (actual !== w.sha256) {
        failures.push(`${path.join(day.date, 'media', w.name)}: sha256 回读不符（期望 ${w.sha256}，实际 ${actual}）`);
      }
    }
  }
  return failures;
}

function applyPlan(plan) {
  writeStaging(plan);
  const shaMismatch = verifyStaging(plan);
  const totalErrors = plan.totals.errors + plan.totals.missing + plan.crossMissing.length + shaMismatch.length;

  if (shaMismatch.length) reportBounded(shaMismatch, 'verify-mismatch');

  if (totalErrors > 0 && !plan.force) {
    throw new VerifyFailed(`逐条目错误=${plan.totals.errors} missing=${plan.totals.missing} cross-missing=${plan.crossMissing.length} sha-mismatch=${shaMismatch.length}；未合并，暂存现场保留于 ${plan.stageDir}`);
  }

  // 合并前再查一次目标：已存在且不同 -> 报错不覆盖；相同 -> 跳过。
  let merged = 0;
  let already = 0;
  const conflicts = [];
  for (const day of plan.days) {
    for (const w of day.writes) {
      if (fs.existsSync(w.finalPath)) {
        const existing = fs.readFileSync(w.finalPath);
        if (existing.equals(w.bytes)) { already += 1; continue; }
        conflicts.push(`${path.relative(plan.outputRoot, w.finalPath)} 已存在且字节不同，未覆盖`);
        continue;
      }
      fs.mkdirSync(path.dirname(w.finalPath), { recursive: true });
      // 暂存与最终目录同处 outputRoot，rename 是同一卷上的原子操作。
      fs.renameSync(w.stagedPath, w.finalPath);
      merged += 1;
    }
  }

  if (conflicts.length) reportBounded(conflicts, 'existing-different');
  fs.rmSync(plan.stageDir, { recursive: true, force: true });

  if (totalErrors > 0 || conflicts.length > 0) {
    throw new VerifyFailed(`逐条目错误=${plan.totals.errors} missing=${plan.totals.missing} cross-missing=${plan.crossMissing.length} sha-mismatch=${shaMismatch.length} existing-different=${conflicts.length}；已合并可安全条目 ${merged} 个，暂存现场已清理`);
  }
  return { merged, already };
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

  if (opts.mode === 'apply') {
    const schemaPath = path.join(paths.finalDir, 'schema.json');
    if (!fs.existsSync(paths.finalDir) || !fs.statSync(paths.finalDir).isDirectory()) {
      throw new Refused(`拒绝：--apply 需要 timeline/ 已存在（记录迁移必须先运行）：${paths.finalDir}`);
    }
    if (!fs.existsSync(schemaPath)) {
      throw new Refused(`拒绝：缺少 ${schemaPath}，必须先运行 tools/migrate-v1-to-v2.mjs 建立 schemaVersion=2 标记。`);
    }
    let schema;
    try { schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8')); } catch {
      throw new Refused(`拒绝：${schemaPath} 无法解析为 JSON。`);
    }
    if (!schema || schema.schemaVersion !== 2) {
      throw new Refused(`拒绝：timeline/schema.json 的 schemaVersion 不是 2（实际：${JSON.stringify(schema && schema.schemaVersion)}），不写入媒体。`);
    }
  }

  const plan = buildPlan(paths);
  plan.force = opts.force;
  printPlan(plan, opts);
  if (opts.mode === 'dry-run') return EXIT.OK;

  try {
    const result = applyPlan(plan);
    console.log(`[media] verify ok days=${plan.totals.days} merged=${result.merged} already-present=${plan.totals.alreadyPresent + result.already} entries=${plan.totals.entries} errors=0 missing=0 cross-missing=0`);
    return EXIT.OK;
  } catch (err) {
    if (err instanceof VerifyFailed) {
      console.error(`[media] 校验失败：${err.message}`);
      return EXIT.VERIFY;
    }
    throw err;
  }
}

// 作为 CLI 直接执行时才运行 main；被测试 import 时不触发写入。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (err) {
    if (err instanceof Refused) {
      console.error(err.message);
      process.exitCode = EXIT.REFUSED;
    } else {
      console.error(`[media] 未预期错误：${err && err.stack ? err.stack : String(err)}`);
      process.exitCode = EXIT.UNEXPECTED;
    }
  }
}
