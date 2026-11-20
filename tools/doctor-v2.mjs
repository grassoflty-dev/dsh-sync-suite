#!/usr/bin/env node
// v2 单时间线仓库只读体检工具（mod-v2-doctor）。
//
// 用法：node tools/doctor-v2.mjs --repo <path> [--json] [--quiet]
// 退出码：0 = 健康（无 problems）；2 = 发现问题（problems>0）或参数拒绝；1 = 未预期错误。
// 严重度：只有 error 计入 problems 并触发 exit 2；warning / info 仅提示、不阻断。典型非阻断项：
// 已删除清行后保留的账本 → I_LEDGER_RETAINED(info)；无佐证的孤儿账本 → W_LEDGER_ORPHAN(warning)；
// 媒体迁移窗口（media/ 不存在，或 media/ 为空且当日引用媒体全缺）→ W_MEDIA_NOT_MIGRATED(warning)；
// media/ 已有文件却仍缺引用 → E_MEDIA_MISSING(error)。
//
// 硬性约束：**只读**。本工具只使用 fs.existsSync / statSync / readdirSync / readFileSync，
// 不创建、不修改、不删除任何文件（不建 tmp、不做修复、不做 git 操作），因此可在冻结文件系统上运行。
// 契约依据 docs/DATA-CONTRACT-v2.md §2（布局）/ §3（records 一记录一行 + date）/ §4（同 id 折叠 /
// UTF-8 字节 tie-break）/ §5（媒体裸文件名 + sha16 碰撞）/ §6（open 只看 closed_at）/ §7（账本与
// restore.ts > delete.ts 优先级）/ §9（conflicts dedupeKey）/ §11（schema 门槛）。
// 规则在 Node 内以最小实现复刻 apps/.../model/timeline.ts 的纯解析器（本工具自包含，仅 node: 内建）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MEDIA_FILE_RE = /^[0-9a-f]{16}\.jpg$/;

/** 契约 §2：日期目录必须是合法日历日（月份 1..12、日期随月份与闰年校验）。 */
function isValidDay(name) {
  if (!DAY_RE.test(name)) return false;
  const year = Number(name.slice(0, 4));
  const month = Number(name.slice(5, 7));
  const day = Number(name.slice(8, 10));
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day <= daysInMonth;
}
const SHA16_RE = /^[0-9a-f]{16}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const EXIT = { OK: 0, UNEXPECTED: 1, PROBLEMS: 2 };

// 契约 §3 的规范键序（与 timeline.ts / migrate-v1-to-v2.mjs 同口径），用于 §4 字节 tie-break。
const KEY_ORDER = [
  'id', 'ts', 'title', 'body', 'author', 'done', 'media',
  'ocr_text', 'ai_structured', 'ai_processed', 'ocr_time', 'opened_at', 'closed_at'
];
const KNOWN_KEYS = new Set(KEY_ORDER);

class Refused extends Error {}

const USAGE = [
  '用法: node tools/doctor-v2.mjs --repo <path> [--json] [--quiet]',
  '  --repo <path>  待体检的仓库根目录（只读，不写任何文件）',
  '  --json         输出机器可读 JSON 对象（代替分段文本）',
  '  --quiet        省略分段说明，仅保留问题行与汇总行',
  '退出码: 0 = 健康；2 = 发现问题 / 参数拒绝；1 = 未预期错误'
].join('\n');

// ---------------------------------------------------------------- 参数

function parseArgs(argv) {
  const opts = { repo: null, json: false, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--repo') {
      opts.repo = argv[++i];
      if (!opts.repo) throw new Refused('拒绝：--repo 需要一个路径参数。');
    } else if (arg === '--json') {
      opts.json = true;
    } else if (arg === '--quiet') {
      opts.quiet = true;
    } else {
      throw new Refused(`拒绝：无法识别的参数 ${JSON.stringify(arg)}。\n${USAGE}`);
    }
  }
  if (!opts.repo) throw new Refused(`拒绝：缺少 --repo 参数。\n${USAGE}`);
  return opts;
}

// ---------------------------------------------------------------- 只读 FS 帮助函数

function isDir(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function dirsOf(dir) {
  if (!isDir(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function filesOf(dir) {
  if (!isDir(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort();
}

function readText(file) {
  if (!isFile(file)) return null;
  return fs.readFileSync(file, 'utf8');
}

function linesOf(text) {
  if (text === null) return [];
  return text.split(/\r?\n/).filter((line) => line.trim() !== '');
}

// ---------------------------------------------------------------- 纯解析帮助函数

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** 契约 §3 的规范行（只用于 §4 同 ts 字节裁决；不写盘）。 */
function canonicalLine(record) {
  const out = {};
  for (const key of KEY_ORDER) if (hasOwn(record, key)) out[key] = record[key];
  for (const key of Object.keys(record)) if (!KNOWN_KEYS.has(key)) out[key] = record[key];
  return JSON.stringify(out);
}

function tsMillis(ts) {
  if (typeof ts !== 'string') return NaN;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? NaN : ms;
}

/** 可解析按时刻比，否则按字符串比（timeline.ts compareTs 同口径）。 */
function compareTs(a, b) {
  const ma = tsMillis(a);
  const mb = tsMillis(b);
  if (!Number.isNaN(ma) && !Number.isNaN(mb)) return ma === mb ? 0 : (ma < mb ? -1 : 1);
  const sa = typeof a === 'string' ? a : '';
  const sb = typeof b === 'string' ? b : '';
  return sa === sb ? 0 : (sa < sb ? -1 : 1);
}

/** 契约 §4：Buffer.compare(Buffer.from(a,'utf8'), Buffer.from(b,'utf8'))。 */
function byteCompare(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** 从 JSON 文本里找 `"key": [` 的 '[' 下标；找不到返回 -1。 */
function arrayStart(source, key) {
  const match = new RegExp(`"${key}"\\s*:\\s*\\[`).exec(source);
  return match === null ? -1 : match.index + match[0].length - 1;
}

/** 从 '[' 起做配平扫描，返回顶层元素的原始文本切片（字符串内括号安全忽略）。 */
function splitArray(source, open) {
  const elements = [];
  let depth = 1;
  let inString = false;
  let escaped = false;
  let start = -1;
  for (let i = open + 1; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      if (start < 0 && depth === 1) start = i;
      inString = true;
      continue;
    }
    if (ch === '{' || ch === '[') {
      if (start < 0 && depth === 1) start = i;
      depth += 1;
      continue;
    }
    if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) {
        if (start >= 0) elements.push(source.slice(start, i));
        break;
      }
      continue;
    }
    if (ch === ',' && depth === 1) {
      if (start >= 0) elements.push(source.slice(start, i));
      start = -1;
      continue;
    }
    if (start < 0 && depth === 1 && !/\s/.test(ch)) start = i;
  }
  return elements;
}

/** 从 records 键之前的文本取 date 字段（目录名权威，这里只做比对）。 */
function readFileDate(source, recordsAt) {
  const prefix = recordsAt < 0 ? source : source.slice(0, recordsAt);
  const match = /"date"\s*:\s*"([^"]*)"/.exec(prefix);
  return match === null ? null : match[1];
}

function parseArrayField(source, key) {
  const open = arrayStart(source, key);
  if (open < 0) return null;
  return splitArray(source, open);
}

/** 解析一条 JSONL 文本：返回 {entries, malformed}；坏行 fail-soft 跳过并计数。 */
function parseJsonl(text) {
  const entries = [];
  let malformed = 0;
  for (const line of linesOf(text)) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)
      || typeof obj.id !== 'string' || !obj.id
      || typeof obj.ts !== 'string' || !obj.ts) {
      malformed += 1;
      continue;
    }
    entries.push(obj);
  }
  return { entries, malformed };
}

/** 同 id 折叠：较晚 ts 胜；ts 相同时规范整行 UTF-8 字节较大者胜。返回每个 id 的胜者。 */
function foldById(records) {
  const groups = new Map();
  for (const record of records) {
    if (!groups.has(record.id)) groups.set(record.id, []);
    groups.get(record.id).push(record);
  }
  const winners = new Map();
  let groupsWithDuplicates = 0;
  let duplicateLines = 0;
  for (const [id, group] of groups) {
    let winner = group[0];
    let winnerLine = canonicalLine(winner);
    for (let i = 1; i < group.length; i += 1) {
      const candidate = group[i];
      const delta = compareTs(candidate.ts, winner.ts);
      if (delta > 0) {
        winner = candidate;
        winnerLine = canonicalLine(candidate);
      } else if (delta === 0 && byteCompare(canonicalLine(candidate), winnerLine) > 0) {
        winner = candidate;
        winnerLine = canonicalLine(candidate);
      }
    }
    winners.set(id, winner);
    if (group.length > 1) {
      groupsWithDuplicates += 1;
      duplicateLines += group.length - 1;
    }
  }
  return { winners, groupsWithDuplicates, duplicateLines };
}

/** open 派生谓词（§6）：closed_at 缺省（null / 空串 / 纯空白）即未完成；不看 done。 */
function isOpen(record) {
  const closed = record.closed_at;
  return closed === undefined || closed === null || (typeof closed === 'string' && closed.trim() === '');
}

function sameIdSet(a, b) {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

// ---------------------------------------------------------------- findings / 汇总

function add(state, code, severity, message, next, extra) {
  const finding = { code, severity, message, next };
  if (extra && typeof extra.day === 'string') finding.day = extra.day;
  state.findings.push(finding);
}

function problem(state, code, message, next, extra) {
  add(state, code, 'error', message, next, extra);
}

function warning(state, code, message, next, extra) {
  add(state, code, 'warning', message, next, extra);
}

function info(state, code, message, next, extra) {
  add(state, code, 'info', message, next, extra);
}

function summaryLine(state) {
  return `[doctor] days=${state.days} records=${state.records} deletes=${state.deletes} `
    + `restores=${state.restores} media=${state.media} problems=${state.problems} warnings=${state.warnings}`;
}

function finishState(state) {
  state.problems = state.findings.filter((f) => f.severity === 'error').length;
  state.warnings = state.findings.filter((f) => f.severity === 'warning').length;
  state.informational = state.findings.filter((f) => f.severity === 'info').length;
  // 稳定输出：按 day / code / message 排序（不使用墙钟，同仓库两次运行逐字节一致）。
  state.findings.sort((a, b) => {
    const da = a.day || '';
    const db = b.day || '';
    return (da < db ? -1 : da > db ? 1 : 0)
      || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)
      || (a.message < b.message ? -1 : a.message > b.message ? 1 : 0);
  });
  state.summary = summaryLine(state);
  return state;
}

// ---------------------------------------------------------------- 各检查项

function checkSchema(state, timelineDir) {
  const file = path.join(timelineDir, 'schema.json');
  const text = readText(file);
  state.schema = { present: false, parseable: false, version: null };
  if (text === null) {
    state.schema.code = 'E_SCHEMA_MISSING';
    problem(state, 'E_SCHEMA_MISSING',
      '仓库已有 timeline/ 但缺少 timeline/schema.json，无法确认结构版本。',
      '下一步：先跑 node tools/migrate-v1-to-v2.mjs --repo <repo> --apply 生成标记（契约 §11）。');
    return;
  }
  state.schema.present = true;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    state.schema.code = 'E_SCHEMA_MISSING';
    problem(state, 'E_SCHEMA_MISSING',
      'timeline/schema.json 不是合法 JSON，结构版本不明。',
      '下一步：核对标记文件内容，重跑记录迁移 apply；不要手改 schemaVersion 绕过门槛。');
    return;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    state.schema.code = 'E_SCHEMA_MISSING';
    problem(state, 'E_SCHEMA_MISSING',
      'timeline/schema.json 顶层不是 JSON 对象，结构版本不明。',
      '下一步：重跑记录迁移 apply 生成形如 {"schemaVersion":2} 的标记。');
    return;
  }
  state.schema.parseable = true;
  state.schema.version = hasOwn(parsed, 'schemaVersion') ? parsed.schemaVersion : null;
  if (parsed.schemaVersion !== 2) {
    state.schema.code = 'E_SCHEMA_UNKNOWN';
    problem(state, 'E_SCHEMA_UNKNOWN',
      `timeline/schema.json 的 schemaVersion 不是 2（实际 ${JSON.stringify(parsed.schemaVersion)}），本工具不认识该结构。`,
      '下一步：核对标记内容并重跑记录迁移 apply，不要手改 schemaVersion 绕过门槛（契约 §11）。');
  }
}

function checkRecords(state, dayDir, day) {
  const file = path.join(dayDir, 'records.json');
  const text = readText(file);
  if (text === null) {
    state.recordsMissing += 1;
    problem(state, 'E_RECORDS_MISSING', `${day}/records.json 缺失，无法读取当日记录。`,
      '下一步：重跑记录迁移 apply 或检查该日目录是否被误删。', { day });
    return { ids: new Set(), records: [], fileDate: null };
  }

  const recordsAt = arrayStart(text, 'records');
  const fileDate = readFileDate(text, recordsAt);
  if (fileDate !== day) {
    problem(state, 'E_DAY_DATE_MISMATCH',
      `${day}/records.json 的 date=${JSON.stringify(fileDate)} 与目录名不符（目录名权威）。`,
      '下一步：按目录名修正 date 字段后重写该文件；不要新建目录（契约 §3/P1-3(b)）。', { day });
  }

  if (recordsAt < 0) {
    problem(state, 'E_RECORDS_PARSE', `${day}/records.json 找不到 records 数组，该文件不可解析。`,
      '下一步：按契约 §3 的 {date, open, records:[…]} 形状重建该日文件。', { day });
    return { ids: new Set(), records: [], fileDate };
  }

  const elements = splitArray(text, recordsAt);
  const records = [];
  let malformed = 0;
  let multiline = 0;
  for (const element of elements) {
    const block = element.trim().replace(/,$/, '');
    if (block.includes('\n') || block.includes('\r')) multiline += 1;
    let obj;
    try {
      obj = JSON.parse(block);
    } catch {
      malformed += 1;
      continue;
    }
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)
      || typeof obj.id !== 'string' || !obj.id || typeof obj.ts !== 'string' || !obj.ts) {
      malformed += 1;
      continue;
    }
    records.push(obj);
  }
  state.records += records.length;
  state.malformedLines += malformed;
  if (malformed > 0) {
    problem(state, 'E_RECORDS_MALFORMED',
      `${day}/records.json 有 ${malformed} 行既不是合法 JSON 对象、也缺 id/ts，已跳过。`,
      '下一步：对照契约 §3 修正这几行的字节（一条记录占一整行），再重跑本工具。', { day });
  }
  if (multiline > 0) {
    warning(state, 'W_RECORDS_MULTILINE',
      `${day}/records.json 有 ${multiline} 条记录跨多行（契约 §3 要求一条记录占一整行）。`,
      '下一步：用 canonicalRecordLine 重新序列化该日文件，使每条记录独占一行。', { day });
  }

  // open 派生漂移（§6，informational）：不代表损坏，只提示写侧缓存陈旧。
  const openElements = parseArrayField(text, 'open');
  const fileOpen = new Set();
  if (openElements) {
    for (const element of openElements) {
      try {
        const value = JSON.parse(element.trim());
        if (typeof value === 'string') fileOpen.add(value);
      } catch {
        // open 缓存里的坏元素只计数，不升级为错误（读侧本就不信任 open）。
        state.openBadEntries += 1;
      }
    }
  }
  const { winners, groupsWithDuplicates, duplicateLines } = foldById(records);
  const derived = new Set();
  for (const record of winners.values()) if (isOpen(record)) derived.add(record.id);
  if (!sameIdSet(fileOpen, derived)) {
    info(state, 'E_OPEN_DRIFT',
      `${day}/records.json 顶层 open 与按 closed_at 派生结果不一致（文件 ${fileOpen.size} 项 / 派生 ${derived.size} 项），按派生为准。`,
      '下一步：写侧下次落盘会重算 open；无需手工修数据（契约 §6：读侧不信任 open）。', { day });
  }
  state.openDriftDays += sameIdSet(fileOpen, derived) ? 0 : 1;
  state.duplicateGroups += groupsWithDuplicates;
  state.duplicateLines += duplicateLines;
  if (groupsWithDuplicates > 0) {
    info(state, 'I_DUPLICATE_IDS',
      `${day}/records.json 有 ${groupsWithDuplicates} 个重复 id（共 ${duplicateLines} 条旧版本），已按 later-ts / 字节 tie-break 折叠。`,
      '下一步：无需处理（契约 §4 的确定性折叠）；败者应已进 conflicts.jsonl。', { day });
  }

  return { ids: new Set(records.map((r) => r.id)), records, fileDate };
}

function checkLedgers(state, dayDir, day, knownIds) {
  const result = { deletes: [], restores: [], retained: 0, orphans: 0, restoreWins: 0, restoreIgnored: 0 };
  for (const [name, key] of [['deleted.jsonl', 'deletes'], ['restore.jsonl', 'restores']]) {
    const text = readText(path.join(dayDir, name));
    if (text === null) {
      warning(state, 'W_LEDGER_MISSING', `${day}/${name} 缺失，按空账本处理。`,
        '下一步：契约 §10 要求每日本契约账本存在；重跑记录迁移 apply 补齐空文件。', { day });
      continue;
    }
    const { entries, malformed } = parseJsonl(text);
    result[key] = entries;
    if (malformed > 0) {
      problem(state, 'E_LEDGER_PARSE', `${day}/${name} 有 ${malformed} 行不是合法账本条目（需 id + ts 字符串）。`,
        '下一步：修正这几行或补齐字段；账本只追加，勿重写历史行（契约 §7）。', { day });
    }
  }
  state.deletes += result.deletes.length;
  state.restores += result.restores.length;

  // 契约 §7：确认删除后物理清行，但 deleted 账本条目永不过期、永不清理，因此「账本有该 id、
  // 当日 records 无该 id」是**正常终态**，绝不能报 error / exit 2。best-effort 判定：
  //   - 有 delete 条目本身即构成「该 id 曾存在且已被删」的账本佐证 → I_LEDGER_RETAINED(info)；
  //   - 只有 restore 而无 delete、也无记录行的条目无法自证（§7：restore 只能由产生 delete 的 UI 写出）
  //     → W_LEDGER_ORPHAN(warning)。
  // 仓库里没有可证明「原行是否真的存在过」的独立事实，故两者都不计入 problems（见文件头严重度说明）。
  const orphanIds = new Set();
  for (const entry of [...result.deletes, ...result.restores]) {
    if (!knownIds.has(entry.id)) orphanIds.add(entry.id);
  }
  const deleteIds = new Set(result.deletes.map((e) => e.id));
  const retained = [...orphanIds].filter((id) => deleteIds.has(id));
  const unjustified = [...orphanIds].filter((id) => !deleteIds.has(id));
  if (retained.length > 0) {
    result.retained = retained.length;
    state.ledgerRetained += retained.length;
    info(state, 'I_LEDGER_RETAINED',
      `${day} 账本中 ${retained.length} 个 id 已无当日 records 行但有删除账本条目（例：${retained.slice(0, 3).join(', ')}），已删除并清行，账本保留（契约 §7 正常终态）。`,
      '下一步：无需处理——删除账本条目按契约永不过期、不清理；本工具以 delete 条目作为该 id 曾存在的账本佐证（best-effort：仓库无法证明原行是否确实存在过）。', { day });
  }
  if (unjustified.length > 0) {
    result.orphans = unjustified.length;
    state.ledgerOrphans += unjustified.length;
    warning(state, 'W_LEDGER_ORPHAN',
      `${day} 账本中 ${unjustified.length} 个 id 既无当日 records 行、也无删除账本条目佐证（例：${unjustified.slice(0, 3).join(', ')}）。`,
      '下一步：核对账本来源；契约 §7 的 restore 只能由产生 delete 的 UI 写出，缺 delete 属可疑。本工具按 best-effort 降为 warning，不计入 problems、不阻断。', { day });
  }

  // restore.ts > delete.ts 优先级 sanity（§7）：R<=D 合法（删除胜），只做计数与说明，不报错。
  const maxDelete = new Map();
  const maxRestore = new Map();
  for (const e of result.deletes) {
    if (!maxDelete.has(e.id) || compareTs(e.ts, maxDelete.get(e.id)) > 0) maxDelete.set(e.id, e.ts);
  }
  for (const e of result.restores) {
    if (!maxRestore.has(e.id) || compareTs(e.ts, maxRestore.get(e.id)) > 0) maxRestore.set(e.id, e.ts);
  }
  for (const [id, dts] of maxDelete) {
    if (!maxRestore.has(id)) continue;
    if (compareTs(maxRestore.get(id), dts) > 0) result.restoreWins += 1;
    else result.restoreIgnored += 1;
  }
  state.restoreWins += result.restoreWins;
  state.restoreIgnored += result.restoreIgnored;
  return result;
}

function checkConflicts(state, dayDir, day) {
  const text = readText(path.join(dayDir, 'conflicts.jsonl'));
  let rows = 0;
  if (text === null) {
    warning(state, 'W_LEDGER_MISSING', `${day}/conflicts.jsonl 缺失，按空审计处理。`,
      '下一步：契约 §10 要求每日本契约审计文件存在；重跑记录迁移 apply 补齐空文件。', { day });
    return rows;
  }
  let malformed = 0;
  let badDedupe = 0;
  for (const line of linesOf(text)) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    rows += 1;
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)
      || typeof obj.id !== 'string' || !obj.id
      || typeof obj.ts !== 'string' || !obj.ts
      || typeof obj.losingLine !== 'string'
      || typeof obj.decidedAt !== 'string'
      || typeof obj.dedupeKey !== 'string' || !SHA256_RE.test(obj.dedupeKey)) {
      badDedupe += 1;
    }
  }
  state.conflicts += rows;
  if (malformed > 0) {
    problem(state, 'E_CONFLICTS_PARSE', `${day}/conflicts.jsonl 有 ${malformed} 行不是合法 JSON。`,
      '下一步：修正冲突审计行；每行应含 id/ts/losingLine/decidedAt/dedupeKey（契约 §4）。', { day });
  }
  if (badDedupe > 0) {
    problem(state, 'E_CONFLICTS_DEDUPE_KEY',
      `${day}/conflicts.jsonl 有 ${badDedupe} 行的字段或 dedupeKey 形状不合法（应为 sha256(losingLine) 的 64 位小写 hex）。`,
      '下一步：按契约 §4 重算 dedupeKey；按 (id, ts, dedupeKey) 去重后再写回。', { day });
  }
  return rows;
}

function checkMedia(state, dayDir, day, records) {
  const mediaDir = path.join(dayDir, 'media');
  const mediaDirExists = isDir(mediaDir);
  const onDisk = filesOf(mediaDir);
  state.media += onDisk.length;
  const referenced = new Set();
  let badName = 0;
  let missing = 0;
  let collision = 0;
  const sha16ToShas = new Map();
  const sha16ToFiles = new Map();

  for (const record of records) {
    const media = Array.isArray(record.media) ? record.media : [];
    for (const item of media) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)
        || typeof item.file !== 'string') {
        badName += 1;
        continue;
      }
      const file = item.file;
      const sha = typeof item.sha256 === 'string' ? item.sha256 : '';
      const sha16 = SHA256_RE.test(sha) ? sha.slice(0, 16) : (SHA16_RE.test(file) ? file.slice(0, 16) : '');
      if (!MEDIA_FILE_RE.test(file) || (SHA256_RE.test(sha) && file !== `${sha.slice(0, 16)}.jpg`)) {
        badName += 1;
      }
      if (sha16) {
        if (!sha16ToShas.has(sha16)) sha16ToShas.set(sha16, new Set());
        sha16ToShas.get(sha16).add(sha);
        if (!sha16ToFiles.has(sha16)) sha16ToFiles.set(sha16, new Set());
        sha16ToFiles.get(sha16).add(file);
      }
      if (!MEDIA_FILE_RE.test(file)) continue; // 绝不拿含路径 / .. 的名字碰磁盘
      referenced.add(file);
      if (!onDisk.includes(file)) missing += 1;
      state.mediaRefs += 1;
    }
  }
  for (const [sha16, shas] of sha16ToShas) {
    if (shas.size > 1 || (sha16ToFiles.get(sha16)?.size || 0) > 1) collision += 1;
  }
  const unreferenced = onDisk.filter((name) => !referenced.has(name));

  state.mediaBadName += badName;
  state.mediaMissing += missing;
  state.mediaCollisions += collision;
  state.mediaUnreferenced += unreferenced.length;
  if (missing > 0) {
    // 契约 §5 规则：media/ 不存在，或 media/ 为空且当日引用媒体全缺 = 合法迁移窗口 → warning；否则真缺文件 → error。
    const allReferencedMissing = referenced.size > 0 && [...referenced].every((name) => !onDisk.includes(name));
    const inMigrationWindow = !mediaDirExists || (onDisk.length === 0 && allReferencedMissing);
    if (inMigrationWindow) {
      warning(state, 'W_MEDIA_NOT_MIGRATED',
        `${day} 有 ${missing} 处 media[].file 引用，但同日 media/ 目录${mediaDirExists ? '为空' : '尚不存在'}（媒体迁移未运行，引用为占位）。`,
        '下一步：先跑 node tools/migrate-media-v1-to-v2.mjs --repo <repo> --apply；未迁移前 App 应显示「媒体待迁移」占位（契约 §5），本项不计入 problems。', { day });
    } else {
      problem(state, 'E_MEDIA_MISSING',
        `${day} 有 ${missing} 处 media[].file 在同日 media/ 中找不到文件（目录已存在且非空，或已有部分引用文件到位）。`,
        '下一步：先跑 node tools/migrate-media-v1-to-v2.mjs --repo <repo> --apply 补齐缺文件；未迁移前 App 应显示「媒体待迁移」占位（契约 §5）。', { day });
    }
  }
  if (badName > 0) {
    problem(state, 'E_MEDIA_NAME',
      `${day} 有 ${badName} 个媒体索引名不是裸 <hex16>.jpg（或与 sha256 前 16 位不符）。`,
      '下一步：按契约 §5 把 file 改成不含路径的小写 sha256[0:16].jpg；带 / 或 .. 的名字必须拒绝。', { day });
  }
  if (collision > 0) {
    problem(state, 'E_MEDIA_COLLISION',
      `${day} 有 ${collision} 组 sha16 前缀对应多个不同 sha256 或多个文件名。`,
      '下一步：按契约 §5/§14 逐步延长前缀直到唯一，完整 sha256 仍存记录里；同名不同内容不可覆盖。', { day });
  }
  if (unreferenced.length > 0) {
    warning(state, 'W_MEDIA_UNREFERENCED',
      `${day}/media/ 有 ${unreferenced.length} 个文件未被任何 records[].media 引用（例：${unreferenced.slice(0, 3).join(', ')}）。`,
      '下一步：媒体只增不减，先核对是否为旧记录残留；确认后再决定是否做离线清理（契约 §5/§7）。', { day });
  }
}

function checkV1(state, devicesDir) {
  const devices = dirsOf(devicesDir);
  state.v1.devices = devices.length;
  const idToDevices = new Map();
  for (const device of devices) {
    const deviceDir = path.join(devicesDir, device);
    let deviceRecords = 0;
    let deviceDays = 0;
    let deviceMalformed = 0;
    const scheduleDir = path.join(deviceDir, 'schedules');
    for (const name of filesOf(scheduleDir)) {
      if (!name.endsWith('.jsonl')) continue;
      deviceDays += 1;
      state.v1.days += 1;
      const { entries, malformed } = parseJsonl(readText(path.join(scheduleDir, name)));
      deviceRecords += entries.length;
      deviceMalformed += malformed;
      for (const entry of entries) {
        if (!idToDevices.has(entry.id)) idToDevices.set(entry.id, new Set());
        idToDevices.get(entry.id).add(device);
      }
    }
    const openFile = path.join(deviceDir, 'open.jsonl');
    let deviceOpenEntries = 0;
    if (isFile(openFile)) {
      const { entries, malformed } = parseJsonl(readText(openFile));
      deviceOpenEntries = entries.length;
      state.v1.openEntries += deviceOpenEntries;
      deviceMalformed += malformed;
    }
    state.v1.records += deviceRecords;
    state.v1.malformed += deviceMalformed;
    state.v1.perDevice.push({ device, days: deviceDays, records: deviceRecords, openEntries: deviceOpenEntries, malformed: deviceMalformed });
    if (deviceMalformed > 0) {
      problem(state, 'E_V1_JSONL_PARSE', `v1 设备 ${device} 有 ${deviceMalformed} 行 JSONL 无法解析（schedules/ 或 open.jsonl）。`,
        '下一步：修正坏行后再跑迁移；迁移 dry-run 会把解析失败先暴露给用户（契约 §10 步骤 1）。');
    }
  }
  let cross = 0;
  for (const owners of idToDevices.values()) if (owners.size > 1) cross += 1;
  state.v1.crossDeviceIds = cross;
  if (cross > 0) {
    info(state, 'I_V1_CROSS_DEVICE_ID',
      `v1 侧有 ${cross} 个 id 出现在多台设备的 schedules/ 中（informational，按 id 折叠时较晚 ts 胜）。`,
      '下一步：迁移会按 §4 规则折叠；如属真实并发编辑，检查 conflicts.jsonl 是否留有败者。');
  }
}

// ---------------------------------------------------------------- 主流程

export function runDoctor(repoArg) {
  const repo = path.resolve(repoArg);
  const state = {
    repo,
    layout: 'none',
    schema: null,
    days: 0,
    records: 0,
    recordsMissing: 0,
    deletes: 0,
    restores: 0,
    conflicts: 0,
    malformedLines: 0,
    duplicateGroups: 0,
    duplicateLines: 0,
    openDriftDays: 0,
    openBadEntries: 0,
    ledgerOrphans: 0,
    ledgerRetained: 0,
    restoreWins: 0,
    restoreIgnored: 0,
    media: 0,
    mediaRefs: 0,
    mediaMissing: 0,
    mediaBadName: 0,
    mediaUnreferenced: 0,
    mediaCollisions: 0,
    skippedDays: 0,
    v1: { devices: 0, days: 0, records: 0, openEntries: 0, malformed: 0, crossDeviceIds: 0, perDevice: [] },
    findings: [],
    problems: 0,
    warnings: 0,
    informational: 0
  };

  const devicesDir = path.join(repo, 'devices');
  const timelineDir = path.join(repo, 'timeline');
  const hasDevices = isDir(devicesDir);
  const hasTimeline = isDir(timelineDir);

  if (!isDir(repo)) {
    state.layout = 'none';
    problem(state, 'E_NO_DATA', `--repo 指向的目录不存在或不可读：${repo}；既无 devices/ 也无 timeline/。`,
      '下一步：传一个真实的数据仓库路径（不是代码仓库路径）。');
    return finishState(state);
  }
  if (hasDevices && hasTimeline) {
    state.layout = 'mixed';
    info(state, 'I_LAYOUT_MIXED',
      'devices/ 与 timeline/ 并存（迁移后常态，非错误）：按契约 §10 以 timeline/ 为权威。',
      '下一步：确认 timeline.v1Retained 并存裁决已记录；v1 文件不删除（契约 §10/§13）。');
  } else if (hasDevices) {
    state.layout = 'v1';
    info(state, 'I_LAYOUT_V1', '仓库只有 devices/（v1 布局）。',
      '下一步：需要切换时先跑 node tools/migrate-v1-to-v2.mjs --repo <repo> --apply（契约 §10）。');
  } else if (hasTimeline) {
    state.layout = 'v2';
  } else {
    state.layout = 'none';
    problem(state, 'E_NO_DATA', '仓库既无 devices/ 也无 timeline/，没有可体检的时间线数据。',
      '下一步：确认 --repo 指向数据仓库；空仓库可按 v2 初始化并写 timeline/schema.json（契约 §10）。');
    return finishState(state);
  }

  if (hasTimeline) {
    checkSchema(state, timelineDir);
    for (const name of dirsOf(timelineDir)) {
      if (!isValidDay(name)) {
        state.skippedDays += 1;
        continue;
      }
      state.days += 1;
      const dayDir = path.join(timelineDir, name);
      const rec = checkRecords(state, dayDir, name);
      const led = checkLedgers(state, dayDir, name, rec.ids);
      const conflictRows = checkConflicts(state, dayDir, name);
      checkMedia(state, dayDir, name, rec.records);
      state.perDay = state.perDay || [];
      state.perDay.push({
        date: name,
        records: rec.records.length,
        deletes: led.deletes.length,
        restores: led.restores.length,
        conflicts: conflictRows,
        retained: led.retained,
        orphans: led.orphans,
        restoreWins: led.restoreWins,
        restoreIgnored: led.restoreIgnored
      });
    }
    if (state.skippedDays > 0) {
      warning(state, 'W_DAY_DIR_NAME', `timeline/ 下有 ${state.skippedDays} 个非 YYYY-MM-DD 目录名被跳过。`,
        '下一步：按契约 §2 校正目录名；读侧遇非法目录名跳过并计数，不崩溃。');
    }
  }
  if (hasDevices) checkV1(state, devicesDir);
  return finishState(state);
}

function printHuman(state, opts) {
  if (!opts.quiet) {
    console.log(`[doctor] repo ${state.repo}`);
    console.log(`[doctor] layout ${state.layout}${state.schema ? ` schema=${state.schema.version === null ? 'unknown' : state.schema.version}` : ''}`);
    console.log('[doctor] --- timeline/v2 ---');
    console.log(`[doctor] days=${state.days} skippedDays=${state.skippedDays} records=${state.records} malformedLines=${state.malformedLines} duplicateGroups=${state.duplicateGroups} duplicateLines=${state.duplicateLines} openDriftDays=${state.openDriftDays}`);
    console.log(`[doctor] ledgers deletes=${state.deletes} restores=${state.restores} conflicts=${state.conflicts} retained=${state.ledgerRetained} orphans=${state.ledgerOrphans} restoreWins=${state.restoreWins} restoreIgnored=${state.restoreIgnored}`);
    console.log(`[doctor] media files=${state.media} referenced=${state.mediaRefs} missing=${state.mediaMissing} badName=${state.mediaBadName} unreferenced=${state.mediaUnreferenced} collisions=${state.mediaCollisions}`);
    console.log('[doctor] --- devices/v1 ---');
    console.log(`[doctor] v1 devices=${state.v1.devices} days=${state.v1.days} records=${state.v1.records} openEntries=${state.v1.openEntries} malformed=${state.v1.malformed} crossDeviceIds=${state.v1.crossDeviceIds}`);
    for (const d of state.v1.perDevice) {
      console.log(`[doctor] v1 device ${d.device} days=${d.days} records=${d.records} openEntries=${d.openEntries} malformed=${d.malformed}`);
    }
    for (const d of state.perDay || []) {
      console.log(`[doctor] day ${d.date} records=${d.records} deletes=${d.deletes} restores=${d.restores} conflicts=${d.conflicts} retained=${d.retained} orphans=${d.orphans}`);
    }
    console.log(`[doctor] --- findings: problems=${state.problems} warnings=${state.warnings} informational=${state.informational} ---`);
  }
  for (const f of state.findings) {
    const where = f.day ? ` [${f.day}]` : '';
    console.log(`[doctor] [${f.severity}] ${f.code}${where} ${f.message} → ${f.next}`);
  }
  console.log(state.summary);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    return EXIT.OK;
  }
  const state = runDoctor(opts.repo);
  if (opts.json) console.log(JSON.stringify(state, null, 2));
  else printHuman(state, opts);
  return state.problems > 0 ? EXIT.PROBLEMS : EXIT.OK;
}

// 作为 CLI 直接执行时才运行 main；被测试 import 时只暴露纯函数 runDoctor。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (err) {
    if (err instanceof Refused) {
      console.error(err.message);
      process.exitCode = EXIT.PROBLEMS;
    } else {
      console.error(`[doctor] 未预期错误：${err && err.stack ? err.stack : String(err)}`);
      process.exitCode = EXIT.UNEXPECTED;
    }
  }
}
