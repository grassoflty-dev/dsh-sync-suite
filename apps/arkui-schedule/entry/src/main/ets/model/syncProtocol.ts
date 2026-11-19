/**
 * v2 同步协议核心（mod-v2-sync-protocol）：纯函数、零 SDK import、无墙钟、确定性。
 *
 * 职责边界（权威契约 docs/DATA-CONTRACT-v2.md §9/§11）：
 * - 本文件只做**决策与字节文本**，不碰文件句柄、不执行 git、不读 AppStorage、不写 v1 路径；
 *   落盘 / 提交 / 推送由 services/syncProtocolStore.ets 负责（默认关闭，inert）。
 * - 门禁 assertWritable() 实现 §11 的唯一门槛：schemaVersion===2、分支 main、
 *   HEAD 是 origin/main 或**其祖先**（behind=可快进，放行；ahead/diverged=E_NOT_SYNCED）。
 *   祖先关系由服务用 git merge-base 计算后以布尔量注入（纯函数不碰 git）；任何写操作前
 *   必须调用，失败返回 typed 错误且零写入。
 * - unionDay() 是 §9「阶段一语义并集 + 阶段二意图重放」的纯函数：远端 ∪ 本地按 id 并集，
 *   不同 ts 较晚者胜，同 ts 取规范整行 UTF-8 字节序较大者，败者写 conflicts.jsonl 行；
 *   两侧账本（deleted/restore）先做 append-only 并集（按 (id,ts[,intentId]) 去重），删除胜
 *   裁决针对**并集后**的账本；再按 FIFO 重放 outbox 意图；账本判删的 upsert 被丢弃并计入
 *   dropped（P1-3(c)）。账本文本以本地原文为严格前缀，便于服务只追加写回。
 * - **不重新实现规范行 / 键序 / open 派生 / 账本裁决**：canonicalRecordLine、
 *   parseTimelineDay、parseLedger、visibleRecords、openRecords、deletionState 复用
 *   model/timeline.ts；buildRecordsText、ledgerDeleteLine、ledgerRestoreLine、canPurge、
 *   planUpsert、isValidTsShape 复用 model/timelineWrite.ts；upsert 的规范化统一走
 *   planUpsert（normalizeForWrite），与拒推重放路径 timelineWriteStore.append 字节一致（F4）。
 * - conflicts.jsonl 行形状与 tools/migrate-v1-to-v2.mjs 一致：
 *   {id,ts,losingLine,decidedAt,dedupeKey}，dedupeKey=sha256(规范 losingLine)，
 *   decidedAt 由输入 ts 派生（与迁移工具 isoFromTs 同口径），绝不读墙钟。
 * - now 由调用方注入：仅用于 outboxAfterReplay 补空 enqueuedAt；不可解析 ts 的意图一律
 *   typed E_TS_SHAPE 丢弃（F5），decidedAt 退回输入 ts 原文，**绝不读墙钟**。
 *
 * 不变量：同输入两次得到相同对象与相同字节；remote/local 互换、账本行序变化均不影响
 * 胜者与最终文本（order-independent）。账本文本是有意 local-prefix 的（追加语义），
 * 跨设备收敛后两端本地账本相同，故字节仍一致。
 */
import {
  canonicalRecordLine, parseTimelineDay, parseLedger, visibleRecords, openRecords, deletionState
} from './timeline';
import type { TimelineRecord, TimelineDay, LedgerEntry } from './timeline';
import {
  buildRecordsText, ledgerDeleteLine, ledgerRestoreLine, canPurge,
  planUpsert, isValidTsShape
} from './timelineWrite';

// ---------------------------------------------------------------- §11 门禁

export type WriteGateCode = 'ok' | 'E_SCHEMA_UNKNOWN' | 'E_BRANCH_MISMATCH' | 'E_NOT_SYNCED';

/** HEAD 与 origin/main 的祖先关系（服务用 git merge-base 计算，纯函数只接收事实）。 */
export type HeadRelation = 'equal' | 'behind' | 'ahead' | 'diverged';

export interface WriteGateInput {
  schemaVersion: number | null;
  branch: string;
  headSha: string;
  originMainSha: string;
  /** HEAD 严格是 origin/main 的祖先（behind，可快进）。缺省 = 仅相等时为真（兼容旧调用）。 */
  headIsAncestorOfOrigin?: boolean;
  /** origin/main 严格是 HEAD 的祖先（ahead）。缺省 = 仅相等时为真。 */
  originIsAncestorOfHead?: boolean;
}

export interface WriteGateResult {
  ok: boolean;
  code: WriteGateCode;
  message: string;
}

/** 四条门禁消息（verbatim；用户可见文案见 §9 typed 状态）。 */
export const WRITE_GATE_MESSAGES: Record<WriteGateCode, string> = {
  ok: '可写',
  E_SCHEMA_UNKNOWN: '只读（仓库结构版本不认识，见 §11）',
  E_BRANCH_MISMATCH: '分支不是 main，拒绝写入',
  E_NOT_SYNCED: '本地 HEAD 与 origin/main 不一致，请先同步'
};

/**
 * HEAD 与 origin/main 的四种关系（纯逻辑，无需 git）。两个祖先布尔量缺省时按"仅相等"
 * 推导，兼容只传 SHA 的旧调用；服务必须显式提供，以便区分 behind / ahead / diverged。
 */
export function headRelation(input: WriteGateInput): HeadRelation {
  if (input.headSha === input.originMainSha) {
    return 'equal';
  }
  const headAncestor: boolean = input.headIsAncestorOfOrigin ??
    (input.headSha === input.originMainSha);
  const originAncestor: boolean = input.originIsAncestorOfHead ??
    (input.headSha === input.originMainSha);
  if (headAncestor) {
    return 'behind';
  }
  if (originAncestor) {
    return 'ahead';
  }
  return 'diverged';
}

/**
 * §11 唯一门禁（纯逻辑）：schemaVersion===2 → 分支 main → HEAD 是 origin/main 或其祖先。
 * behind（可快进）放行，交给服务做 `git merge --ff-only`；ahead / diverged 返回 E_NOT_SYNCED。
 * 顺序固定；任一不满足即返回 typed 错误（零写入由调用方保证）。
 */
export function assertWritable(input: WriteGateInput): WriteGateResult {
  const relation: HeadRelation = headRelation(input);
  let code: WriteGateCode = 'ok';
  if (input.schemaVersion !== 2) {
    code = 'E_SCHEMA_UNKNOWN';
  } else if (input.branch !== 'main') {
    code = 'E_BRANCH_MISMATCH';
  } else if (relation === 'ahead' || relation === 'diverged') {
    code = 'E_NOT_SYNCED';
  }
  return { ok: code === 'ok', code: code, message: WRITE_GATE_MESSAGES[code] };
}

/** 仅 behind 需要快进；equal 已是同一提交，ahead/diverged 已被门禁拒绝。 */
export function isFastForwardable(input: WriteGateInput): boolean {
  return headRelation(input) === 'behind';
}

// ---------------------------------------------------------------- outbox / 意图

/** 仓库外 outbox 的一条意图；payload（line / date / id / ts）入队后不可变。 */
export interface OutboxEntry {
  intentId: string;
  op: 'upsert' | 'delete' | 'restore' | 'purge';
  date: string;
  id: string;
  ts: string;
  line: string;
  enqueuedAt: string;
  attempts: number;
  state: 'pending' | 'syncing' | 'failed';
  lastError: string;
}

/** P1-1：每个 intentId 全生命周期的总尝试次数，跨会话 / 重启 / pull 成功都不重置。 */
export const MAX_ATTEMPTS: number = 4;

/** 失败后写回 outbox 的 typed 原因（调用方可据前缀归类为 E_PUSH_REJECTED）。 */
export const SYNC_RETRY_ERROR: string = 'E_PUSH_REJECTED: 推送被拒，意图留在 outbox';

/** F5：不可解析 / 形状非法的 ts 不再用墙钟兜底，而是 typed 丢弃该意图。 */
export const E_TS_SHAPE: string = 'E_TS_SHAPE';

// ---------------------------------------------------------------- SHA-256（纯 TS，无 Node 类型）

/** 与 Buffer.from(text,'utf8') 等价的 UTF-8 字节编码（含代理对与孤立代理处理）。 */
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

const SHA_K: number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

function rotr(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) | 0;
}

function hex32(value: number): string {
  return (value >>> 0).toString(16).padStart(8, '0');
}

/**
 * 纯 SHA-256（UTF-8）；与 Node `createHash('sha256').update(s,'utf8').digest('hex')`
 * 逐字节一致（测试对拍）。无 Node 类型 / 无 SDK import。
 */
export function sha256Hex(text: string): string {
  const bytes = utf8Bytes(text);
  const bitLength = bytes.length * 8;
  const padded = bytes.slice();
  padded.push(0x80);
  while (padded.length % 64 !== 56) {
    padded.push(0);
  }
  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  padded.push((high >>> 24) & 0xff, (high >>> 16) & 0xff, (high >>> 8) & 0xff, high & 0xff);
  padded.push((low >>> 24) & 0xff, (low >>> 16) & 0xff, (low >>> 8) & 0xff, low & 0xff);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const words = new Array<number>(64);

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let t = 0; t < 16; t += 1) {
      const at = offset + t * 4;
      words[t] = ((padded[at] << 24) | (padded[at + 1] << 16) | (padded[at + 2] << 8) | padded[at + 3]) | 0;
    }
    for (let t = 16; t < 64; t += 1) {
      const s0 = rotr(words[t - 15], 7) ^ rotr(words[t - 15], 18) ^ (words[t - 15] >>> 3);
      const s1 = rotr(words[t - 2], 17) ^ rotr(words[t - 2], 19) ^ (words[t - 2] >>> 10);
      words[t] = (words[t - 16] + s0 + words[t - 7] + s1) | 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let t = 0; t < 64; t += 1) {
      const big1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + big1 + choose + SHA_K[t] + words[t]) | 0;
      const big0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (big0 + majority) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
    h5 = (h5 + f) | 0;
    h6 = (h6 + g) | 0;
    h7 = (h7 + h) | 0;
  }
  return `${hex32(h0)}${hex32(h1)}${hex32(h2)}${hex32(h3)}${hex32(h4)}${hex32(h5)}${hex32(h6)}${hex32(h7)}`;
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

/** ts 比较：可解析按时刻，否则字符串序（与 model/timeline.ts 同口径）。 */
function compareTs(left: string, right: string): number {
  const a = Date.parse(left);
  const b = Date.parse(right);
  if (!Number.isNaN(a) && !Number.isNaN(b)) {
    return a === b ? 0 : (a < b ? -1 : 1);
  }
  return left === right ? 0 : (left < right ? -1 : 1);
}

/**
 * 由输入 ts 派生 decidedAt（与迁移工具 isoFromTs 同口径）。不可解析时退回输入串原文，
 * **绝不读墙钟**（F5）：now 仅保留在签名里供调用方传递，自身不使用。
 */
function decidedAtOf(ts: string, _now: Date): string {
  const ms = Date.parse(ts);
  if (!Number.isNaN(ms)) {
    return new Date(ms).toISOString();
  }
  return ts;
}

/**
 * F4：upsert 的单一规范化入口 —— 与 timelineWriteStore.append / planUpsert 走同一套逻辑
 * （ts 形状校验 + 重新打开刷新 opened_at）。返回规范化后的记录；非法输入返回 null。
 * 用 planUpsert 的写计划回读目标记录，保证与拒推重放路径产出**逐字节一致**的规范行。
 */
export function normalizeForWrite(
  date: string,
  record: TimelineRecord,
  existing: TimelineRecord[]
): TimelineRecord | null {
  if (!isValidTsShape(record.ts)) {
    return null;
  }
  const plan = planUpsert(date, existing, record);
  if (!plan.ok) {
    return null;
  }
  const parsed = parseTimelineDay(plan.text, date);
  if (parsed.day === null) {
    return null;
  }
  for (const candidate of parsed.day.allRecords) {
    if (candidate.id === record.id) {
      return candidate;
    }
  }
  return null;
}

// ---------------------------------------------------------------- outbox 纯操作

/**
 * P1-2 内容判重：intentId = op + date + id + ts + sha256(四元组)[0:16]，
 * 同 payload 恒同 id；不引入 applied-intents 文件。
 */
export function makeIntentId(date: string, id: string, ts: string, op: string): string {
  const key = `${op}\u0000${date}\u0000${id}\u0000${ts}`;
  return `${op}:${date}:${id}:${sha256Hex(key).slice(0, 16)}`;
}

/** 尝试次数 +1；达到 MAX_ATTEMPTS 时进入 failed 终态，停止自动重放。 */
export function markAttempt(entry: OutboxEntry, error: string): OutboxEntry {
  const attempts = entry.attempts + 1;
  const state: OutboxEntry['state'] = attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
  return {
    intentId: entry.intentId, op: entry.op, date: entry.date, id: entry.id, ts: entry.ts,
    line: entry.line, enqueuedAt: entry.enqueuedAt, attempts: attempts, state: state, lastError: error
  };
}

/** 可重放入队：pending / syncing 且 attempts < MAX，严格 FIFO（保持入参顺序）。 */
export function replayable(entries: OutboxEntry[]): OutboxEntry[] {
  const out: OutboxEntry[] = [];
  for (const entry of entries) {
    if ((entry.state === 'pending' || entry.state === 'syncing') && entry.attempts < MAX_ATTEMPTS) {
      out.push(entry);
    }
  }
  return out;
}

// ---------------------------------------------------------------- conflicts.jsonl

/**
 * 契约 §4 / §9 审计行：一行 JSON，键序与 tools/migrate-v1-to-v2.mjs 一致。
 * dedupeKey = sha256(规范 losingLine)；decidedAt 由调用方从输入 ts 派生（无墙钟）。
 */
export function conflictsLine(id: string, ts: string, losingLine: string, decidedAt: string): string {
  return JSON.stringify({
    id: id, ts: ts, losingLine: losingLine, decidedAt: decidedAt, dedupeKey: sha256Hex(losingLine)
  });
}

/** 从 JSON 行安全取对象；坏行返回 null。 */
function asObject(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // 坏行不参与判定
  }
  return null;
}

function tsOfLine(line: string): string {
  const obj = asObject(line);
  if (obj !== null && typeof obj.ts === 'string') {
    return obj.ts;
  }
  return '';
}

/** 同 (id,ts) 两条不同规范行的败者（UTF-8 字节较小者）。 */
function loserLine(a: string, b: string): string {
  return byteCompare(a, b) >= 0 ? b : a;
}

/** 空 payload 时由 (id,ts) 确定性地补出账本行（deletedAt / restoredAt 均取输入 ts）。 */
function ledgerLineOf(entry: OutboxEntry): string {
  if (entry.line.length > 0) {
    return entry.line;
  }
  if (entry.op === 'delete' || entry.op === 'purge') {
    return ledgerDeleteLine(entry.id, entry.ts, entry.ts);
  }
  if (entry.op === 'restore') {
    return ledgerRestoreLine(entry.id, entry.ts, entry.ts);
  }
  return '';
}

/** 从意图的账本 payload 行取 LedgerEntry；payload 不可变，ts 恒为入队时固定值。 */
function ledgerEntryOf(entry: OutboxEntry): LedgerEntry | null {
  const obj = asObject(ledgerLineOf(entry));
  if (obj === null || typeof obj.id !== 'string' || typeof obj.ts !== 'string') {
    return null;
  }
  const out: LedgerEntry = { id: obj.id, ts: obj.ts };
  if (entry.op === 'restore') {
    out.restoredAt = obj.ts;
  } else {
    out.deletedAt = obj.ts;
  }
  return out;
}

/** 从 records.json 文本取 id → 规范行（parseTimelineDay 已按 id 折叠）。 */
function recordsByLine(text: string, date: string): Map<string, TimelineRecord> {
  const out = new Map<string, TimelineRecord>();
  const parsed = parseTimelineDay(text, date);
  if (parsed.day === null) {
    return out;
  }
  for (const record of parsed.day.allRecords) {
    out.set(record.id, record);
  }
  return out;
}

/** 并集结果文本 → 未完成 id（复用读侧 openRecords，open 只由 closed_at 派生）。 */
export function openIdsForDay(
  date: string,
  recordsText: string,
  deletedText: string,
  restoredText: string
): string[] {
  const parsed = parseTimelineDay(recordsText, date);
  if (parsed.day === null) {
    return [];
  }
  const day: TimelineDay = parsed.day;
  const deletions = parseLedger(deletedText).entries;
  const restores = parseLedger(restoredText).entries;
  // visibleRecords 是唯一 sanctioned 展示来源；未完成在其结果上按 closed_at 过滤。
  const visible = visibleRecords(day, deletions, restores);
  const visibleDay: TimelineDay = { date: date, open: day.open, allRecords: visible };
  return openRecords(visibleDay, deletions, restores).map((record: TimelineRecord): string => record.id);
}

// ---------------------------------------------------------------- §9 union → replay

/** 单日三份文本（records + 两本账本）。远端与本地各传一份，缺文件传空串。 */
export interface DayTexts {
  records: string;
  deleted: string;
  restore: string;
}

export interface DayUnion {
  date: string;
  /** 由 buildRecordsText 产出的 §3 精确文件文本（open 从 closed_at 重算）。 */
  text: string;
  /** 并集后的 deleted.jsonl 全文：本地原文是严格前缀，仅追加远端/意图新行。 */
  deleted: string;
  /** 并集后的 restore.jsonl 全文：本地原文是严格前缀，仅追加远端/意图新行。 */
  restored: string;
  /** 待追加到 conflicts.jsonl 的审计行（已按 (id,ts,dedupeKey) 去重、确定性排序）。 */
  conflicts: string[];
  /** 已幂等落地 / 按 §4 裁决视为已应用的 intentId（可按此出队）。 */
  applied: string[];
  /** 因删除账本存在而被丢弃的 upsert intentId（进 droppedDeleted，出队不重试）。 */
  dropped: string[];
  /** F5：ts 形状非法、以 E_TS_SHAPE 丢弃的 intentId（也计入 dropped）。 */
  tsShapeDropped: string[];
  /** 本次重放实际新增 / 替换的规范记录行数。 */
  added: number;
}

/** 账本行去重键：deleted 按 (id,ts,intentId)，restore 按 (id,ts)（契约 §7）。 */
function ledgerKey(line: string, withIntent: boolean): string {
  const obj = asObject(line);
  if (obj === null || typeof obj.id !== 'string' || typeof obj.ts !== 'string') {
    return line;
  }
  const base = `${obj.id}\u0000${obj.ts}`;
  if (withIntent && typeof obj.intentId === 'string') {
    return `${base}\u0000${obj.intentId}`;
  }
  return base;
}

/** 非空账本行（坏行 / 空行过滤，便于按行追加）。 */
function ledgerLines(text: string): string[] {
  return typeof text === 'string' ? text.split(/\r?\n/).filter((line: string): boolean => line.length > 0) : [];
}

/** append-only 并集：base 字节恒为新文本严格前缀；新行按 key 去重后追加在末尾。 */
function unionLedgerText(base: string, incoming: string[], withIntent: boolean): string {
  const seen = new Set<string>();
  for (const line of ledgerLines(base)) {
    seen.add(ledgerKey(line, withIntent));
  }
  const appended: string[] = [];
  for (const line of incoming) {
    const key = ledgerKey(line, withIntent);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    appended.push(line);
  }
  if (appended.length === 0) {
    return base;
  }
  const head: string = base.length === 0 || base.endsWith('\n') ? base : `${base}\n`;
  return `${head}${appended.join('\n')}\n`;
}

/** F9：账本行携带 intentId（§7 可选字段 + 未知字段原样保留），让内容判重第二道防线生效。 */
function intentLedgerLine(entry: OutboxEntry): string {
  const base = ledgerLineOf(entry);
  if (base.length === 0) {
    return '';
  }
  const obj = asObject(base);
  if (obj === null) {
    return base;
  }
  return JSON.stringify({ ...obj, intentId: entry.intentId });
}

/** merged 的规范行 → TimelineRecord[]（供 normalizeForWrite / canPurge 复用）。 */
function recordsOfMerged(merged: Map<string, string>): TimelineRecord[] {
  const records = new Array<TimelineRecord>();
  for (const line of merged.values()) {
    const obj = asObject(line);
    if (obj !== null) {
      records.push(obj as unknown as TimelineRecord);
    }
  }
  return records;
}

/**
 * §9 单日 union（阶段一）+ replay（阶段二）的纯函数。
 * - 两侧账本先做 append-only 并集（本地原文为前缀），删除胜裁决读**并集后**账本；
 * - remote / local 互换得到相同胜者、相同 conflicts、相同 text（order-independent）；
 * - 败者统一落 conflicts.jsonl 行（dedupeKey=sha256(规范行)）；
 * - upsert 经 normalizeForWrite（planUpsert）规范化，与拒推重放路径字节一致（F4）；
 * - 重放按 FIFO；账本判删的 upsert 计入 dropped 并出队（P1-3(c) / F3）；
 * - 不可解析 ts 以 E_TS_SHAPE 丢弃，不再用注入 now 兜底（F5）；
 * - 输出 records 文本必须经 buildRecordsText（§3 字节形状 + §6 open 派生 + 解析自检）。
 *
 * 注：命中账本 id 的 records.json 行按 §7 P2-13 **保留**（读侧 visibleRecords 过滤），
 * 不因看到账本就自行清行；本函数只保证陈旧 upsert 不再把它写回来。
 */
export function unionDay(
  date: string,
  remote: DayTexts,
  local: DayTexts,
  entries: OutboxEntry[],
  now: Date
): DayUnion {
  const remoteRecords = recordsByLine(remote.records, date);
  const localRecords = recordsByLine(local.records, date);
  const merged = new Map<string, string>();
  const conflictRows: string[] = [];
  const seenConflict = new Set<string>();

  const addConflict = (id: string, ts: string, losingLine: string): void => {
    const row = conflictsLine(id, ts, losingLine, decidedAtOf(ts, now));
    const obj = asObject(row);
    const key = obj === null ? row : `${String(obj.id)}\u0000${String(obj.ts)}\u0000${String(obj.dedupeKey)}`;
    if (seenConflict.has(key)) {
      return;
    }
    seenConflict.add(key);
    conflictRows.push(row);
  };

  const ids = new Set<string>();
  for (const id of remoteRecords.keys()) {
    ids.add(id);
  }
  for (const id of localRecords.keys()) {
    ids.add(id);
  }
  for (const id of ids) {
    const a = remoteRecords.get(id);
    const b = localRecords.get(id);
    if (a !== undefined && b !== undefined) {
      const lineA = canonicalRecordLine(a);
      const lineB = canonicalRecordLine(b);
      const delta = compareTs(a.ts, b.ts);
      let winner: TimelineRecord;
      let loser: TimelineRecord | null;
      if (delta > 0) {
        winner = a;
        loser = b;
      } else if (delta < 0) {
        winner = b;
        loser = a;
      } else if (lineA === lineB) {
        winner = a;
        loser = null;
      } else if (byteCompare(lineB, lineA) > 0) {
        winner = b;
        loser = a;
      } else {
        winner = a;
        loser = b;
      }
      merged.set(id, canonicalRecordLine(winner));
      // 只有同 ts 的字节裁决败者才进 conflicts.jsonl；不同 ts 是静默折叠（§4）。
      if (loser !== null && delta === 0) {
        addConflict(id, loser.ts, canonicalRecordLine(loser));
      }
    } else if (a !== undefined) {
      merged.set(id, canonicalRecordLine(a));
    } else if (b !== undefined) {
      merged.set(id, canonicalRecordLine(b));
    }
  }

  // 阶段二前置：先聚合两侧账本 + 本周期意图账本，再算删除胜（顺序无关）。
  const replay = replayable(entries);
  const intentDeleteLines: string[] = [];
  const intentRestoreLines: string[] = [];
  const allDeleteTexts: string[] = [local.deleted, remote.deleted];
  const allRestoreTexts: string[] = [local.restore, remote.restore];
  for (const entry of replay) {
    if (entry.op === 'upsert') {
      continue;
    }
    const line = intentLedgerLine(entry);
    if (line.length === 0) {
      continue;
    }
    if (entry.op === 'restore') {
      intentRestoreLines.push(line);
    } else {
      intentDeleteLines.push(line);
    }
  }
  const unionDeleted = unionLedgerText(local.deleted, ledgerLines(remote.deleted).concat(intentDeleteLines), true);
  const unionRestored = unionLedgerText(local.restore, ledgerLines(remote.restore).concat(intentRestoreLines), false);
  const deletions = allDeleteTexts.concat([unionDeleted]).reduce(
    (acc: LedgerEntry[], text: string): LedgerEntry[] => acc.concat(parseLedger(text).entries), []);
  const restores = allRestoreTexts.concat([unionRestored]).reduce(
    (acc: LedgerEntry[], text: string): LedgerEntry[] => acc.concat(parseLedger(text).entries), []);

  const applied: string[] = [];
  const dropped: string[] = [];
  const tsShapeDropped: string[] = [];
  let added = 0;

  for (const entry of replay) {
    if (entry.op === 'upsert') {
      const incoming = asObject(entry.line);
      if (incoming === null || typeof incoming.id !== 'string' || typeof incoming.ts !== 'string') {
        dropped.push(entry.intentId);
        continue;
      }
      const record = incoming as unknown as TimelineRecord;
      // F5：不可解析 / 形状非法 ts 一律 typed 丢弃，不用注入 now 兜底。
      if (!isValidTsShape(record.ts)) {
        dropped.push(entry.intentId);
        tsShapeDropped.push(entry.intentId);
        continue;
      }
      // P1-3(c)：id 已在并集删除账本且无更晚 restore → 丢弃 upsert，绝不复活。
      if (deletionState(record.id, deletions, restores) === 'deleted') {
        dropped.push(entry.intentId);
        continue;
      }
      // F4：与 timelineWriteStore.append / planUpsert 走同一规范化（ts 校验 + reopened_at）。
      const normalized = normalizeForWrite(date, record, recordsOfMerged(merged));
      if (normalized === null) {
        dropped.push(entry.intentId);
        tsShapeDropped.push(entry.intentId);
        continue;
      }
      const incomingLine = canonicalRecordLine(normalized);
      const existing = merged.get(record.id);
      if (existing !== undefined) {
        const olderOrEqual = compareTs(tsOfLine(existing), record.ts) >= 0;
        if (existing === incomingLine || olderOrEqual) {
          // P1-2：相同字节，或同 (id,ts) 按 §4 裁决（胜败均视为已应用，出队）。
          if (existing !== incomingLine && compareTs(tsOfLine(existing), record.ts) === 0) {
            addConflict(record.id, record.ts, loserLine(existing, incomingLine));
          }
          applied.push(entry.intentId);
          continue;
        }
      }
      merged.set(record.id, incomingLine);
      added += 1;
      applied.push(entry.intentId);
      continue;
    }

    if (entry.op === 'delete' || entry.op === 'restore') {
      const ledger = ledgerEntryOf(entry);
      if (ledger === null) {
        dropped.push(entry.intentId);
        continue;
      }
      const ledgerList = entry.op === 'restore' ? restores : deletions;
      const duplicate = ledgerList.some((row: LedgerEntry): boolean =>
        row.id === ledger.id && compareTs(row.ts, ledger.ts) === 0);
      if (!duplicate) {
        ledgerList.push(ledger);
      }
      applied.push(entry.intentId);
      continue;
    }

    // purge：物理清行；账本不存在或行已消失时 canPurge=false → 幂等 no-op（仍算出队）。
    if (canPurge(recordsOfMerged(merged), deletions, entry.id)) {
      merged.delete(entry.id);
      const ledger = ledgerEntryOf(entry);
      if (ledger !== null && !deletions.some((row: LedgerEntry): boolean =>
        row.id === ledger.id && compareTs(row.ts, ledger.ts) === 0)) {
        deletions.push(ledger);
      }
    }
    applied.push(entry.intentId);
  }

  // 冲突行确定性排序（与 ts/id/dedupeKey 无关的输入顺序都收敛到同一字节序列）。
  conflictRows.sort((left: string, right: string): number => {
    const a = asObject(left);
    const b = asObject(right);
    if (a === null || b === null) {
      return byteCompare(left, right);
    }
    const delta = compareTs(String(a.ts), String(b.ts));
    if (delta !== 0) {
      return delta;
    }
    if (String(a.id) !== String(b.id)) {
      return String(a.id) < String(b.id) ? -1 : 1;
    }
    return byteCompare(String(a.dedupeKey), String(b.dedupeKey));
  });

  // 账本只影响删除胜裁决；records 文本由 buildRecordsText 独立产出（P2-13 保留命中行）。
  const text = buildRecordsText(date, recordsOfMerged(merged));
  return {
    date: date, text: text, deleted: unionDeleted, restored: unionRestored,
    conflicts: conflictRows, applied: applied, dropped: dropped,
    tsShapeDropped: tsShapeDropped, added: added
  };
}

// ---------------------------------------------------------------- 幂等判定 / 出队

/**
 * P1-2 判重（阶段二执行前）：
 * - upsert：规范行逐字节存在，或同 (id,ts) 已存在（§4 裁决视为已应用）；
 * - delete：deleted.jsonl 已有同 intentId 或同 (id,ts)；
 * - restore：restore.jsonl 已有同 (id,ts)；
 * - purge：该 id 版本行已不存在且删除账本已存在。
 */
export function isApplied(
  entry: OutboxEntry,
  dayText: string,
  deletedText: string,
  restoredText: string
): boolean {
  const parsed = parseTimelineDay(dayText, entry.date);
  const deletes = parseLedger(deletedText).entries;
  const restores = parseLedger(restoredText).entries;

  if (entry.op === 'upsert') {
    const incoming = asObject(entry.line);
    if (incoming === null || typeof incoming.id !== 'string' || typeof incoming.ts !== 'string') {
      return false;
    }
    // F2/P1-3(c)：已删 id 的 upsert 绝不能算"已应用"提前出队 —— 必须进入 unionDay
    // 计入 dropped 并出队（否则既丢失 droppedDeleted 计数，又可能复活记录）。
    if (deletionState(incoming.id, deletes, restores) === 'deleted') {
      return false;
    }
    if (parsed.day === null) {
      return false;
    }
    for (const record of parsed.day.allRecords) {
      if (record.id !== incoming.id) {
        continue;
      }
      if (canonicalRecordLine(record) === canonicalRecordLine(incoming as unknown as TimelineRecord)) {
        return true;
      }
      if (compareTs(record.ts, incoming.ts) === 0) {
        return true; // 同 (id,ts) 不同内容：§4 已确定性裁决，视为已应用
      }
    }
    return false;
  }

  if (entry.op === 'delete') {
    for (const row of deletes) {
      if (row.id === entry.id && compareTs(row.ts, entry.ts) === 0) {
        return true;
      }
    }
    return deletedText.split(/\r?\n/).some((line: string): boolean => {
      const obj = asObject(line);
      return obj !== null && typeof obj.intentId === 'string' && obj.intentId === entry.intentId;
    });
  }

  if (entry.op === 'restore') {
    for (const row of restores) {
      if (row.id === entry.id && compareTs(row.ts, entry.ts) === 0) {
        return true;
      }
    }
    return false;
  }

  // purge：行消失 + 账本存在（P1-2）
  let rowPresent = false;
  if (parsed.day !== null) {
    for (const record of parsed.day.allRecords) {
      if (record.id === entry.id) {
        rowPresent = true;
        break;
      }
    }
  }
  let ledgerPresent = false;
  for (const row of deletes) {
    if (row.id === entry.id) {
      ledgerPresent = true;
      break;
    }
  }
  return !rowPresent && ledgerPresent;
}

/**
 * 出队更新（F3）：
 * - applied / dropped 的意图都移除（dropped 是"记录已删、编辑被有意放弃"）；
 * - 只有 failed 才 attempts+1；dropped 绝不 bump，绝不会 4 次后误报 E_PUSH_REJECTED；
 * - 其余原样保留（FIFO），空 enqueuedAt 用注入 now 补齐。
 */
export function outboxAfterReplay(
  entries: OutboxEntry[],
  appliedIds: string[],
  failedIds: string[],
  droppedIds: string[],
  now: Date
): OutboxEntry[] {
  const applied = new Set<string>(appliedIds);
  const failed = new Set<string>(failedIds);
  const dropped = new Set<string>(droppedIds);
  const out: OutboxEntry[] = [];
  for (const entry of entries) {
    if (applied.has(entry.intentId) || dropped.has(entry.intentId)) {
      continue;
    }
    const normalized: OutboxEntry = {
      intentId: entry.intentId, op: entry.op, date: entry.date, id: entry.id, ts: entry.ts,
      line: entry.line,
      enqueuedAt: entry.enqueuedAt.length > 0 ? entry.enqueuedAt : now.toISOString(),
      attempts: entry.attempts, state: entry.state, lastError: entry.lastError
    };
    out.push(failed.has(entry.intentId) ? markAttempt(normalized, SYNC_RETRY_ERROR) : normalized);
  }
  return out;
}
