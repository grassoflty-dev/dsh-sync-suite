/**
 * v2 单时间线读取核心（Stage C 读路径：纯模型、零 SDK import、无副作用、无墙钟）。
 *
 * 模块规格（权威契约 docs/DATA-CONTRACT-v2.md §3/§4/§5/§6/§7/§11）：
 *
 * - v2 布局：仓库级标记 timeline/schema.json；每天一个目录 timeline/<YYYY-MM-DD>/，
 *   内含 records.json、summary.json、deleted.jsonl、restore.jsonl、conflicts.jsonl、media/。
 *   没有设备命名空间，没有根索引（§2）。
 * - records.json 形状 = {date, open, records:[…]}，**一条记录占一整行**（也兼容 pretty JSON）；
 *   目录名（调用方的 expectedDate）是权威日期，文件内 date 字段不符时记一条错误，但仍按目录名
 *   返回当日对象并保留全部记录（§3）。未知扩展字段原样保留、排在规范键序之后（§3）。
 * - 同 id 多行折叠（§3/§4）：不同 ts 较晚者静默胜；ts 相同则取**规范整行按 UTF-8 字节序
 *   字典序较大者**胜（Buffer.compare 等价实现，见下方 utf8Bytes/byteCompare）；规范行完全相同的
 *   两条视为同一条，只留一份。败者落 conflicts.jsonl 属于写阶段职责，本读模块只做折叠。
 * - open 谓词（§6）：**不看文件里的 open 数组，也绝不用 done**；未完成 iff closed_at 缺省
 *   （空串等同缺省，null 亦视为缺省）。day.open 仅按文件原样暴露以供诊断，读路径不信任它。
 * - 删除 / 撤销账本优先级（§7）：对某 id，D = max(deleted.ts)，R = max(restored.ts)；
 *   **可见 iff 存在 R 且 R > D 严格成立**；R 不存在或 R ≤ D（含相等，删除胜）→ 不可见。
 *   多个删除 / 撤销条目之间一律较晚 ts 胜。可见之后才对 records 版本做 §4 折叠。
 * - 媒体（§5）：media[].file 必须是**不含路径的裸 <sha256 前 16 位小写 hex>.jpg**，
 *   拒绝路径分隔符 / `..` / 绝对路径（如 media/x.jpg、../x.jpg、C:/x.jpg）与位数不足的名字；
 *   非法条目被丢弃并计入 errors，记录本身仍保留。
 * - schema 门槛（§11）：只解析仓库级 timeline/schema.json 的 schemaVersion；===2 才 ok，
 *   其他数字 / 缺失 / 非数字 / 畸形 JSON 返回类型化 reason，永不抛。
 * - §4 可观测性：parseTimelineDay 返回 resolutions（每次同 (id,ts) 折叠的胜者 / 败者规范行与
 *   reason）与 duplicates（完全相同而折叠掉的行数）。调用方可据此累计契约 §4 的 equalTsResolved
 *   并写一行行为日志（本模块是纯读路径，只记录、不写盘）；败者落 conflicts.jsonl 仍属写阶段职责。
 * - 并列判定的有意超集：契约 §4 措辞为「ts 字节相同」，本模块（与 tools/migrate-v1-to-v2.mjs
 *   同形）用 compareTs() === 0 先按时刻判等，因此两个**字节不同但同一时刻**的 ts（如 +08:00
 *   与 Z 写法）也会进入 §4 的规范行字节序裁决。两实现一致、结果确定，属刻意超集而非分歧；
 *   这类折叠同样记入 resolutions（reason='equal-ts-byte-order'，ts 取胜者版本的 ts）。
 *
 * 调用者义务（契约 §6/§7/§11；本模块只提供纯函数、不强制门禁，靠调用纪律落地）：
 * 1. 未完成列表一律经 openRecords() 派生：只看 closed_at 缺省，**绝不用 done**，也不要相信
 *    day.open（它只是文件原样缓存，仅供诊断）。
 * 2. day.allRecords 是**未经账本过滤的原始版本行**（含已被判删的 id），禁止直接渲染 / 展示，
 *    否则会复活已删记录；列表 / 详情 / 汇总一律经 visibleRecords()（再做 open 过滤）。
 * 3. visibleRecords() / openRecords() / deletionState() 每次都必须**同时**传入 deleted.jsonl
 *    与 restore.jsonl 两本账本；漏传任一方等于关闭账本过滤。
 * 4. 任何 timeline/** 文件 I/O 之前先用 parseSchemaMarker 判定仓库级 schema.json（未知 / 缺失
 *    且 devices/ 存在 → typed 错误 + 零写入）；本模块只提供判定，不代替 assertWritable()。
 * 5. 写回序列化必须经 canonicalRecordLine，保持键序与未知字段末尾位置，不得自行 JSON.stringify。
 *
 * 关于规范行与键序：本文件的 KEY_ORDER 与 canonicalRecordLine **故意重复**
 * tools/migrate-v1-to-v2.mjs 的实现——迁移工具需要自包含、不依赖本模块；两处都由测试固定到
 * docs/DATA-CONTRACT-v2.md §3 的同一组示例字节，任一侧漂移都会被测试抓到。
 *
 * 不变量：纯函数、确定性（同输入两次得到相同对象与相同字节）、不使用 Date.now()/墙钟。
 */

/** 一条 v2 记录；未知字段通过索引签名原样保留。 */
export interface TimelineRecord {
  id: string;
  ts: string;
  title: string;
  body: string;
  author: string;
  done: boolean;
  media: TimelineMedia[];
  ai_processed: boolean;
  ocr_text?: string;
  ai_structured?: string;
  ocr_time?: string;
  opened_at: string;
  closed_at?: string;
  [key: string]: unknown; // 未知字段原样保留
}

/** 记录中的媒体索引元素；file 是同日 media/ 下的裸文件名。 */
export interface TimelineMedia {
  file: string;
  sha256: string;
  pageIndex: number;
}

/**
 * 一日的内存视图。date 取目录名（权威）；open 按文件原样暴露、读路径不信任。
 * allRecords 是**未过滤的原始版本行**（含已被账本判删的 id）——为结构性 discourage 裸读、
 * 防止复活已删记录而特意改名；展示只能经 visibleRecords() / openRecords()（见文件头调用者义务）。
 */
export interface TimelineDay {
  date: string;
  open: string[];
  allRecords: TimelineRecord[];
}

/** 一行解析错误（1 起行号）。 */
export interface TimelineParseError {
  line: number;
  message: string;
}

/**
 * 一次同 (id,ts) 折叠的裁决明细（契约 §4 审计）。
 * - winner / losers 均为规范行（canonicalRecordLine 输出）；
 * - reason='identical' 表示 losers 与 winner 逐字节相同、仅折叠掉重复；
 * - reason='equal-ts-byte-order' 表示 ts 判等（见文件头「有意超集」）后按规范行 UTF-8 字节序裁决。
 */
export interface TimelineResolution {
  id: string;
  ts: string;
  winner: string;
  losers: string[];
  reason: 'equal-ts-byte-order' | 'identical';
}

/** parseTimelineDay 的返回值；无法识别顶层对象时 day 为 null。 */
export interface ParsedTimelineDay {
  day: TimelineDay | null;
  errors: TimelineParseError[];
  resolutions: TimelineResolution[];
  duplicates: number;
}

/** deleted.jsonl / restore.jsonl 的一条账目。 */
export interface LedgerEntry {
  id: string;
  ts: string;
  deletedAt?: string;
  restoredAt?: string;
}

/** parseLedger 的返回值。 */
export interface ParsedLedger {
  entries: LedgerEntry[];
  errors: TimelineParseError[];
}

/** 仓库级 schema.json 的门槛判定。 */
export interface SchemaMarker {
  ok: boolean;
  version: number | null;
  reason: string;
}

// 契约 §3 记录字段表的规范键序（与 tools/migrate-v1-to-v2.mjs 的 KEY_ORDER 逐字一致）。
const KEY_ORDER = [
  'id', 'ts', 'title', 'body', 'author', 'done', 'media',
  'ocr_text', 'ai_structured', 'ai_processed', 'ocr_time', 'opened_at', 'closed_at'
];
const KNOWN_KEYS = new Set<string>(KEY_ORDER);
// 契约 §5 / P2-11：<sha256[0:16]>.jpg，小写 hex，裸文件名（不含任何路径）。
const MEDIA_FILE_RE = /^[0-9a-f]{16}\.jpg$/;
// 契约 §5：sha256 必须是完整 64 位小写十六进制（P2-2：不再只查非空）。
const SHA256_RE = /^[0-9a-f]{64}$/;

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (source[i] === '\n') {
      line += 1;
    }
  }
  return line;
}

/** ts → 毫秒；非法返回 NaN（与 model/jsonl、迁移工具同口径）。 */
function tsMillis(ts: string): number {
  const value = Date.parse(ts);
  return Number.isNaN(value) ? Number.NaN : value;
}

/** ts 比较：可解析按时刻，否则退回字符串逐字符比较。 */
function compareTs(left: string, right: string): number {
  const a = tsMillis(left);
  const b = tsMillis(right);
  if (!Number.isNaN(a) && !Number.isNaN(b)) {
    return a === b ? 0 : (a < b ? -1 : 1);
  }
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/**
 * 字符串 → UTF-8 字节数组。契约 §4 的 tie-break 用
 * `Buffer.compare(Buffer.from(a,'utf8'), Buffer.from(b,'utf8'))`，本模块须零 Node 类型
 * （tsconfig types=[]），故手写等价编码再逐字节比较（代理对按码点编码，孤立代理按 U+FFFD）。
 */
function utf8Bytes(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    let cp = text.charCodeAt(i);
    if (cp >= 0xD800 && cp <= 0xDBFF) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : -1;
      if (next >= 0xDC00 && next <= 0xDFFF) {
        cp = 0x10000 + ((cp - 0xD800) << 10) + (next - 0xDC00);
        i += 1;
      } else {
        cp = 0xFFFD;
      }
    } else if (cp >= 0xDC00 && cp <= 0xDFFF) {
      cp = 0xFFFD;
    }
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xC0 | (cp >> 6), 0x80 | (cp & 0x3F));
    } else if (cp < 0x10000) {
      out.push(0xE0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
    } else {
      out.push(
        0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F),
        0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F)
      );
    }
  }
  return out;
}

/** 与 Buffer.compare(Buffer.from(a,'utf8'), Buffer.from(b,'utf8')) 等价的字节序比较。 */
function byteCompare(a: string, b: string): number {
  const left = utf8Bytes(a);
  const right = utf8Bytes(b);
  const len = Math.min(left.length, right.length);
  for (let i = 0; i < len; i += 1) {
    if (left[i] !== right[i]) {
      return left[i] < right[i] ? -1 : 1;
    }
  }
  return left.length === right.length ? 0 : (left.length < right.length ? -1 : 1);
}

// ---------------------------------------------------------------- 规范序列化

/**
 * 契约 §3 的纯函数：固定键序、无多余空格、未知扩展字段排在末尾且值不变。
 * 与 tools/migrate-v1-to-v2.mjs 的 canonicalRecordLine 故意重复（见文件头注释）。
 */
export function canonicalRecordLine(record: TimelineRecord): string {
  const source = record as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of KEY_ORDER) {
    if (hasOwn(source, key)) {
      out[key] = source[key];
    }
  }
  for (const key of Object.keys(source)) {
    if (!KNOWN_KEYS.has(key)) {
      out[key] = source[key];
    }
  }
  return JSON.stringify(out);
}

/** 写入排序：ts 升序，同 ts 按 id 升序（与迁移工具 byTsId 同口径）。不改入参。 */
export function sortRecordsForWrite(records: TimelineRecord[]): TimelineRecord[] {
  const sorted = records.slice();
  sorted.sort((left: TimelineRecord, right: TimelineRecord): number => {
    const delta = compareTs(left.ts, right.ts);
    if (delta !== 0) {
      return delta;
    }
    if (left.id === right.id) {
      return 0;
    }
    return left.id < right.id ? -1 : 1;
  });
  return sorted;
}

/** 某日的 records.json 仓库相对路径。 */
export function timelineDayPath(date: string): string {
  return `timeline/${date}/records.json`;
}

// ---------------------------------------------------------------- 记录校验

/** 返回 null 表示合法，否则返回坏行原因（用于 errors）。 */
function describeRecordProblem(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return '记录必须是 JSON 对象';
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || record.id.trim().length === 0) {
    return '缺少字段 id（非空字符串）';
  }
  if (typeof record.ts !== 'string' || record.ts.trim().length === 0) {
    return '缺少字段 ts（ISO 8601 字符串）';
  }
  if (typeof record.title !== 'string') {
    return '缺少字段 title（字符串）';
  }
  if (typeof record.body !== 'string') {
    return '缺少字段 body（字符串）';
  }
  if (typeof record.author !== 'string') {
    return '缺少字段 author（字符串）';
  }
  if (typeof record.done !== 'boolean') {
    return '缺少字段 done（布尔）';
  }
  if (!Array.isArray(record.media)) {
    return '缺少字段 media（数组）';
  }
  if (typeof record.ai_processed !== 'boolean') {
    return '缺少字段 ai_processed（布尔）';
  }
  if (typeof record.opened_at !== 'string') {
    return '缺少字段 opened_at（字符串）';
  }
  for (const key of ['ocr_text', 'ai_structured', 'ocr_time', 'closed_at']) {
    const value = record[key];
    if (value !== undefined && value !== null && typeof value !== 'string') {
      return `字段 ${key} 必须是字符串`;
    }
  }
  return null;
}

/**
 * 校验 media[]：非法条目丢弃并各记一条 error；合法条目按原顺序保留。
 * 记录本身不因媒体非法而被整条拒绝（契约 §5 / P2-11）。
 */
function validMedia(value: unknown, line: number, errors: TimelineParseError[]): TimelineMedia[] {
  const kept: TimelineMedia[] = [];
  const source = Array.isArray(value) ? value : [];
  for (let i = 0; i < source.length; i += 1) {
    const item = source[i];
    let problem: string | null = null;
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      problem = '必须是 {file,sha256,pageIndex} 对象';
    } else {
      const media = item as Record<string, unknown>;
      if (typeof media.file !== 'string' || !MEDIA_FILE_RE.test(media.file)) {
        problem = `media[${i}].file 必须是不含路径的 <hex16>.jpg 裸文件名`;
      } else if (typeof media.sha256 !== 'string' || !SHA256_RE.test(media.sha256)) {
        problem = `media[${i}].sha256 必须是 64 位小写十六进制字符串`;
      } else if (!Number.isInteger(media.pageIndex) || (media.pageIndex as number) < 0) {
        problem = `media[${i}].pageIndex 必须是非负整数`;
      }
    }
    if (problem === null) {
      kept.push(item as TimelineMedia);
    } else {
      errors.push({ line: line, message: problem });
    }
  }
  return kept;
}

/** 把一个 JSON 块解析成记录；坏块 / 坏字段 / 坏媒体都 fail-soft。 */
function consumeBlock(
  block: string,
  line: number,
  errors: TimelineParseError[],
  out: TimelineRecord[]
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch (error) {
    errors.push({ line: line, message: `记录行不是合法 JSON：${errorText(error)}` });
    return;
  }
  const problem = describeRecordProblem(parsed);
  if (problem !== null) {
    errors.push({ line: line, message: `字段校验失败：${problem}` });
    return;
  }
  const record = parsed as TimelineRecord;
  record.media = validMedia(record.media, line, errors);
  out.push(record);
}

/**
 * 从 records 数组的 '[' 起做括号配平扫描，按顶层元素切分后逐块处理。
 * 一条一行与 pretty JSON（一条跨多行）都走同一路径；字符串内的括号被正确忽略。
 * 顶层元素若不是以 '{' 开头（标量：数字 / 字符串 / null / 布尔 / 数组），跳过并计入 errors
 * （契约 §3 fail-soft：坏元素跳过并计数，P2-1），不再静默丢弃。
 */
function extractRecords(source: string, openBracket: number, errors: TimelineParseError[]): TimelineRecord[] {
  const out: TimelineRecord[] = [];
  const elements: { start: number; end: number }[] = [];
  let arrayDepth = 1;
  let braceDepth = 0;
  let inString = false;
  let escaped = false;
  let elemStart = -1;
  const topLevel = (): boolean => arrayDepth === 1 && braceDepth === 0;
  for (let i = openBracket + 1; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      if (topLevel() && elemStart < 0) {
        elemStart = i;
      }
      inString = true;
      continue;
    }
    if (ch === '{') {
      if (topLevel() && elemStart < 0) {
        elemStart = i;
      }
      braceDepth += 1;
      continue;
    }
    if (ch === '}') {
      if (braceDepth > 0) {
        braceDepth -= 1;
      }
      continue;
    }
    if (ch === '[') {
      if (topLevel() && elemStart < 0) {
        elemStart = i;
      }
      arrayDepth += 1;
      continue;
    }
    if (ch === ']') {
      arrayDepth -= 1;
      if (arrayDepth === 0) {
        if (elemStart >= 0) {
          elements.push({ start: elemStart, end: i });
        }
        break;
      }
      continue;
    }
    if (ch === ',' && topLevel()) {
      if (elemStart >= 0) {
        elements.push({ start: elemStart, end: i });
        elemStart = -1;
      }
      continue;
    }
    if (topLevel() && elemStart < 0 && !/\s/.test(ch)) {
      elemStart = i;
    }
  }
  for (const range of elements) {
    const text = source.slice(range.start, range.end).trim();
    if (text.length === 0) {
      continue;
    }
    if (text.startsWith('{')) {
      consumeBlock(text, lineOf(source, range.start), errors, out);
    } else {
      errors.push({
        line: lineOf(source, range.start),
        message: `records 数组中的非对象元素被跳过：${text.slice(0, 40)}`
      });
    }
  }
  return out;
}

/** 从 records 键之前的文本里取顶层数组字段（open）；畸形时返回空数组。 */
function extractTopArray(source: string, prefix: string, key: string): string[] {
  const regex = new RegExp(`"${key}"\\s*:\\s*\\[`);
  const match = regex.exec(prefix);
  if (match === null) {
    return [];
  }
  const start = match.index + match[0].length - 1; // '[' 的下标
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '[') {
      depth += 1;
      continue;
    }
    if (ch === ']') {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed: unknown = JSON.parse(source.slice(start, i + 1));
          if (Array.isArray(parsed)) {
            return parsed.filter((value: unknown): boolean => typeof value === 'string') as string[];
          }
        } catch {
          return [];
        }
        return [];
      }
    }
  }
  return [];
}

/** foldDuplicateIds 的结果：折叠后的记录 + §4 裁决明细 + 完全相同而折叠掉的行数。 */
interface FoldResult {
  records: TimelineRecord[];
  resolutions: TimelineResolution[];
  duplicates: number;
}

/**
 * 同 id 多行折叠：较晚 ts 胜；ts 判等（compareTs===0，见文件头「有意超集」）时规范整行
 * UTF-8 字节较大者胜；完全相同只留一条。每次同 (id,ts) 折叠都记一条 TimelineResolution
 * （§4 审计），完全相同的行同时计入 duplicates。不同 ts 的静默折叠不记 resolution。
 */
function foldDuplicateIds(records: TimelineRecord[]): FoldResult {
  const byId = new Map<string, TimelineRecord[]>();
  for (const record of records) {
    const group = byId.get(record.id);
    if (group === undefined) {
      byId.set(record.id, [record]);
    } else {
      group.push(record);
    }
  }
  const folded: TimelineRecord[] = [];
  const resolutions: TimelineResolution[] = [];
  let duplicates = 0;
  for (const [id, group] of byId) {
    let winner = group[0];
    let winnerLine = canonicalRecordLine(winner);
    let winnerTs = winner.ts;
    let losers: string[] = [];
    const emit = (): void => {
      if (losers.length === 0) {
        return;
      }
      const reason: TimelineResolution['reason'] =
        losers.every((line: string): boolean => line === winnerLine) ? 'identical' : 'equal-ts-byte-order';
      resolutions.push({ id: id, ts: winnerTs, winner: winnerLine, losers: losers.slice(), reason: reason });
      losers = [];
    };
    for (let k = 1; k < group.length; k += 1) {
      const candidate = group[k];
      const delta = compareTs(candidate.ts, winner.ts);
      if (delta > 0) {
        emit();
        winner = candidate;
        winnerLine = canonicalRecordLine(candidate);
        winnerTs = candidate.ts;
        continue;
      }
      if (delta < 0) {
        continue; // 不同 ts 的较早版本：静默丢弃，不属于 §4 并列裁决
      }
      const candidateLine = canonicalRecordLine(candidate);
      const cmp = byteCompare(candidateLine, winnerLine);
      if (cmp > 0) {
        losers.push(winnerLine);
        winner = candidate;
        winnerLine = candidateLine;
        winnerTs = candidate.ts;
      } else {
        losers.push(candidateLine);
        if (cmp === 0) {
          duplicates += 1;
        }
      }
    }
    emit();
    folded.push(winner);
  }
  return { records: folded, resolutions: resolutions, duplicates: duplicates };
}

// ---------------------------------------------------------------- 对外读函数

/** 解析一日的 records.json；目录名 expectedDate 权威，永不抛。 */
export function parseTimelineDay(text: string, expectedDate: string): ParsedTimelineDay {
  const errors: TimelineParseError[] = [];
  const source = typeof text === 'string' ? text : '';
  if (source.trim().length === 0) {
    return {
      day: { date: expectedDate, open: [], allRecords: [] },
      errors: errors, resolutions: [], duplicates: 0
    };
  }

  const recordsMatch = /"records"\s*:\s*\[/.exec(source);
  const prefix = recordsMatch === null ? source : source.slice(0, recordsMatch.index);
  const dateMatch = /"date"\s*:\s*"([^"]*)"/.exec(prefix);
  const fileDate = dateMatch === null ? expectedDate : dateMatch[1];
  const open = extractTopArray(source, prefix, 'open');

  if (fileDate !== expectedDate) {
    errors.push({
      line: dateMatch === null ? 1 : lineOf(source, dateMatch.index),
      message: `date 字段 ${JSON.stringify(fileDate)} 与目录日期 ${JSON.stringify(expectedDate)} 不符，按目录日期处理`
    });
  }

  if (recordsMatch === null) {
    let isObject = false;
    try {
      const parsed: unknown = JSON.parse(source);
      isObject = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
    } catch {
      isObject = false;
    }
    if (!isObject) {
      errors.push({ line: 1, message: 'records.json 顶层不是合法 JSON 对象' });
      return { day: null, errors: errors, resolutions: [], duplicates: 0 };
    }
    errors.push({ line: 1, message: 'records.json 缺少 records 数组' });
    return {
      day: { date: expectedDate, open: open, allRecords: [] },
      errors: errors, resolutions: [], duplicates: 0
    };
  }

  const openBracket = recordsMatch.index + recordsMatch[0].length - 1;
  const folded = foldDuplicateIds(extractRecords(source, openBracket, errors));
  return {
    day: { date: expectedDate, open: open, allRecords: folded.records },
    errors: errors, resolutions: folded.resolutions, duplicates: folded.duplicates
  };
}

/** 解析追加式账本（deleted.jsonl / restore.jsonl）；坏行跳过计数，永不抛。 */
export function parseLedger(text: string): ParsedLedger {
  const entries: LedgerEntry[] = [];
  const errors: TimelineParseError[] = [];
  const source = typeof text === 'string' ? text : '';
  if (source.length === 0) {
    return { entries: entries, errors: errors };
  }
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i].trim();
    if (raw.length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      errors.push({ line: i + 1, message: `不是合法 JSON：${errorText(error)}` });
      continue;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      errors.push({ line: i + 1, message: '账本条目必须是 JSON 对象' });
      continue;
    }
    const row = parsed as Record<string, unknown>;
    if (typeof row.id !== 'string' || row.id.length === 0) {
      errors.push({ line: i + 1, message: '缺少字段 id（非空字符串）' });
      continue;
    }
    if (typeof row.ts !== 'string' || row.ts.length === 0) {
      errors.push({ line: i + 1, message: '缺少字段 ts（非空字符串）' });
      continue;
    }
    const entry: LedgerEntry = { id: row.id, ts: row.ts };
    if (typeof row.deletedAt === 'string') {
      entry.deletedAt = row.deletedAt;
    }
    if (typeof row.restoredAt === 'string') {
      entry.restoredAt = row.restoredAt;
    }
    entries.push(entry);
  }
  return { entries: entries, errors: errors };
}

/** 仓库级 schema.json 门槛：只解析 schemaVersion，永不抛。 */
export function parseSchemaMarker(text: string): SchemaMarker {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof text === 'string' ? text : '');
  } catch (error) {
    return { ok: false, version: null, reason: `schema.json 不是合法 JSON：${errorText(error)}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, version: null, reason: 'schema.json 顶层必须是 JSON 对象' };
  }
  const marker = parsed as Record<string, unknown>;
  if (!hasOwn(marker, 'schemaVersion')) {
    return { ok: false, version: null, reason: 'schema.json 缺少 schemaVersion 字段' };
  }
  const version = marker.schemaVersion;
  if (typeof version !== 'number' || !Number.isFinite(version)) {
    return {
      ok: false,
      version: null,
      reason: `schemaVersion 必须是数字，实际为 ${typeof version}`
    };
  }
  if (version !== 2) {
    return { ok: false, version: version, reason: `不支持的 schemaVersion：${version}（仅支持 2）` };
  }
  return { ok: true, version: 2, reason: '' };
}

/**
 * 删除 / 撤销优先级（§7）：D=max(deletion.ts)，R=max(restore.ts)，
 * 可见 iff 存在 R 且 R > D 严格成立；同 ts 删除胜。
 */
export function deletionState(
  id: string,
  deletions: LedgerEntry[],
  restores: LedgerEntry[]
): 'visible' | 'deleted' {
  let deletedTs: string | null = null;
  for (let i = 0; i < deletions.length; i += 1) {
    const entry = deletions[i];
    if (entry.id === id && (deletedTs === null || compareTs(entry.ts, deletedTs) > 0)) {
      deletedTs = entry.ts;
    }
  }
  if (deletedTs === null) {
    return 'visible';
  }
  let restoredTs: string | null = null;
  for (let i = 0; i < restores.length; i += 1) {
    const entry = restores[i];
    if (entry.id === id && (restoredTs === null || compareTs(entry.ts, restoredTs) > 0)) {
      restoredTs = entry.ts;
    }
  }
  if (restoredTs !== null && compareTs(restoredTs, deletedTs) > 0) {
    return 'visible';
  }
  return 'deleted';
}

/**
 * 读侧统一入口（唯一 sanctioned 的展示记录来源）：先按账本过滤 day.allRecords，再给出可见记录
 * （不做排序、不改入参）。列表 / 详情 / 汇总都必须经此入口；直接遍历 day.allRecords 会复活已删记录。
 * 调用方须同时传入 deleted.jsonl 与 restore.jsonl 两本账本，漏传即等于关闭账本过滤。
 */
export function visibleRecords(
  day: TimelineDay,
  deletions: LedgerEntry[],
  restores: LedgerEntry[]
): TimelineRecord[] {
  const out: TimelineRecord[] = [];
  for (let i = 0; i < day.allRecords.length; i += 1) {
    const record = day.allRecords[i];
    if (deletionState(record.id, deletions, restores) === 'visible') {
      out.push(record);
    }
  }
  return out;
}

/** 未完成记录：closed_at 缺省（空串 / 纯空白 / null 等同缺省）者；绝不看 done，也不信 day.open。 */
export function openRecords(
  day: TimelineDay,
  deletions: LedgerEntry[],
  restores: LedgerEntry[]
): TimelineRecord[] {
  return visibleRecords(day, deletions, restores).filter((record: TimelineRecord): boolean => {
    const closed = record.closed_at;
    return closed === undefined || closed === null || (typeof closed === 'string' && closed.trim().length === 0);
  });
}
