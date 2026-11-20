/**
 * mod-v2-import-v1：v1 → v2 **应用内一次性迁移**的纯核心（零 SDK import、零 IO、零墙钟）。
 *
 * 职责边界（与 docs/DATA-CONTRACT-v2.md §3/§5/§7/§10/§11 对齐）：
 * - 本文件只做「读取输入的折叠 / 计划 / 写序 / 汇总 / 类型化拒绝 / 写序执行」，不碰文件系统；
 *   `.ets` 服务只负责把 v1 文件字节读进来、把 sink 接到 timelineWriteStore 与 zip 桥。
 * - `devices/**` **只读**：本文件没有任何写入目标，输入全部是已读入的文本；输出只描述
 *   `timeline/**` 的写入声明。任何写盘都不产生在 devices/ 下。
 * - 写序（crash-safety 契约）：每一天固定 `records → summary → media → ledgers`，
 *   全部日完成之后才 `schema`。`nextWriteSteps()` 与 `applyV1Plan()` 共用同一份步骤表，
 *   任何一步失败都还没写 schema → 仓库仍「未迁移」，重跑会干净地重新计划。
 * - 幂等：重跑时把已有 timeline 日记录按 id 合并（较晚 ts 胜、同 ts 规范行字节序裁决），
 *   媒体只增、账本按 (id,ts) 去重追加，`alreadyPresent` 计数如实报告，绝不覆盖已有字节。
 * - 严格 ArkTS：无对象字面量当类型、无 `unknown`、无 `in`；全部显式 interface + typeof 收窄。
 *
 * 与离线工具 tools/migrate-v1-to-v2.mjs / migrate-media-v1-to-v2.mjs 的关系：
 * 复用其规则（规范键序 / later-ts-wins / 同 ts 字节裁决 / 占位 sha16 / 账本形状 / 确定性时间戳），
 * 不复用其代码；本模块可在真机 ArkTS 运行时与 Node 单测里跑同一份逻辑。
 */
import { sha256Hex } from './sha256';

const DAY_RE: RegExp = /^\d{4}-\d{2}-\d{2}$/;
const SHA256_RE: RegExp = /^[0-9a-fA-F]{64}$/;
const MEDIA_NAME_RE: RegExp = /^[0-9a-f]{16}\.jpg$/;

/** 规范键序（契约 §3），与 migrate-v1-to-v2.mjs / model/timeline.ts 逐字一致。 */
const KEY_ORDER: string[] = [
  'id', 'ts', 'title', 'body', 'author', 'done', 'media',
  'ocr_text', 'ai_structured', 'ai_processed', 'ocr_time', 'opened_at', 'closed_at'
];
/** v1 行中已知字段：未知扩展字段尾随保留；这些键不进 extras。 */
const KNOWN_V1_KEYS: Set<string> = new Set<string>([
  'id', 'ts', 'title', 'body', 'author', 'done', 'ai_processed', 'ocr_text', 'ai_structured',
  'ocr_time', 'attachments', 'deleted', 'openedAt', 'closedAt', 'media', 'opened_at',
  'closed_at', 'schemaVersion', 'sha256', 'pageIndex', 'archive', 'entry', 'name'
]);

// ---------------------------------------------------------------- 输入 / 输出类型

/** 一行 v1 schedule JSONL 的文本输入（由 .ets 服务读入，纯核心不读文件）。 */
export interface V1TextLine {
  deviceId: string;
  date: string;
  text: string;
}

/** v1 open.jsonl 的一行（同一 id 取较晚 ts）。 */
export interface V1OpenEntry {
  id: string;
  ts: string;
  openedAt: string;
  closedAt: string;
}

/** v1 summaries/<date>.json 的一个文档（generatedAt 较新者胜）。 */
export interface V1SummaryDocInput {
  date: string;
  text: string;
  generatedAt: number;
}

/** v1 附件引用（来自记录的 attachments[]，同时带 zip 归属信息）。 */
export interface V1AttachmentRef {
  sha256: string;
  pageIndex: number;
  archive: string;
  entry: string;
}

/** 未知扩展字段：json 是 JSON.stringify 后的原文片段，保证值不变、位置在规范键之后。 */
export interface V1ExtraField {
  key: string;
  json: string;
}

/** 规范化后的一行 v1 记录。 */
export interface V1RecordRow {
  deviceId: string;
  date: string;
  id: string;
  ts: string;
  title: string;
  body: string;
  author: string;
  done: boolean;
  ai_processed: boolean;
  deleted: boolean;
  attachments: V1AttachmentRef[];
  extras: V1ExtraField[];
  ocr_text?: string;
  ai_structured?: string;
  ocr_time?: string;
}

/** v2 记录的媒体索引元素（file 是不含路径的裸 <sha16>.jpg）。 */
export interface V2MediaPlan {
  file: string;
  sha256: string;
  pageIndex: number;
}

/** v2 记录（仅已知字段 + 尾随 extras；序列化由 canonicalRecordLine 统一完成）。 */
export interface V2RecordPlan {
  id: string;
  ts: string;
  title: string;
  body: string;
  author: string;
  done: boolean;
  media: V2MediaPlan[];
  ai_processed: boolean;
  opened_at: string;
  ocr_text?: string;
  ai_structured?: string;
  ocr_time?: string;
  closed_at?: string;
  extras: V1ExtraField[];
}

/** 已有 timeline 日目录的内容（断点续跑用；全部只读输入）。 */
export interface V1ExistingDayInput {
  date: string;
  records: V2RecordPlan[];
  summaryGeneratedAt: number | null;
  deletedLines: string[];
  restoreLines: string[];
  conflictLines: string[];
  mediaFiles: string[];
}

/** zip 内条目是否存在的只读索引：键为 `<archive>\u0000<entry>`。 */
export interface V1MediaSizeInput {
  archive: string;
  entry: string;
  size: number;
}

/** 计划输入：所有字段都是已经读入内存的数据，函数本身零 IO。 */
export interface V1ImportInput {
  scheduleLines: V1TextLine[];
  openLines: string[];
  summaries: V1SummaryDocInput[];
  /** 已枚举到的 zip 条目键 `${archive}\u0000${entry}`；zipListAvailable=false 时忽略。 */
  availableZipEntries: string[];
  mediaSizes: V1MediaSizeInput[];
  zipListAvailable: boolean;
  existingDays: V1ExistingDayInput[];
}

/** 一天的媒体写入声明。 */
export interface V1MediaPlan {
  date: string;
  file: string;
  sha256: string;
  pageIndex: number;
  deviceId: string;
  archive: string;
  entry: string;
  /** 预估解压字节；未知为 0，仅用于 E_NO_SPACE 的 best-effort 预检。 */
  size: number;
  status: 'to-write' | 'already-present' | 'missing';
}

/** 跳过原因（逐行上报，绝不静默跳过）。 */
export interface V1SkipReason {
  source: string;
  reason: string;
}

/** 一天的完整写入计划。 */
export interface V1DayPlan {
  date: string;
  records: V2RecordPlan[];
  recordsJson: string;
  summaryJson: string;
  media: V1MediaPlan[];
  deletedLines: string[];
  restoreLines: string[];
  conflictLines: string[];
  recordCount: number;
  mediaFiles: number;
  summaries: number;
  deletes: number;
  restores: number;
  conflicts: number;
  bytes: number;
  alreadyPresent: number;
}

/** 计划合计（UI dry-run 展示与 E_NO_SPACE 预检都读这里）。 */
export interface V1PlanTotals {
  days: number;
  records: number;
  mediaFiles: number;
  mediaMissing: number;
  bytes: number;
  summaries: number;
  skippedRows: number;
  conflicts: number;
  deletes: number;
  restores: number;
  alreadyPresent: number;
  recordsAlreadyPresent: number;
}

/** 完整计划。 */
export interface V1ImportPlan {
  days: V1DayPlan[];
  totals: V1PlanTotals;
  skipReasons: V1SkipReason[];
  schemaText: string;
  migratedAt: string;
}

/** 类型化拒绝码（严格按任务清单）。 */
export type ImportRefusalCode =
  'E_ALREADY_MIGRATED' | 'E_NO_V1_DATA' | 'E_PARTIAL_STATE' | 'E_CORRUPT_V1' | 'E_NO_SPACE';

/** 类型化拒绝：中文原因 + 下一步；E_PARTIAL_STATE 是可继续的「状态消息」，blocks=false。 */
export interface ImportRefusal {
  code: ImportRefusalCode;
  stateCode: string;
  reason: string;
  nextStep: string;
  blocks: boolean;
}

/** 拒绝判定输入（纯标量，便于单测与 UI 共用）。 */
export interface V1RefusalInput {
  schemaVersion: number | null;
  hasDevices: boolean;
  hasV1Schedules: boolean;
  timelineDayDirs: string[];
  strictMode: boolean;
  corruptRows: number;
  plannedBytes: number;
  /** null = 探测不到可用空间，best-effort 跳过 E_NO_SPACE 检查。 */
  availableBytes: number | null;
}

/** 写序步骤：records → summary → media → ledgers，最后一步才是 schema。 */
export type WriteStepKind = 'records' | 'summary' | 'media' | 'ledgers' | 'schema';

export interface WriteStep {
  date: string;
  kind: WriteStepKind;
  dayIndex: number;
}

/** 媒体写入返回值（add-only：已存在相同字节不覆盖；不同字节报冲突不覆盖）。 */
export type V1MediaWriteResult = 'written' | 'already-present' | 'conflict';

/** IO 汇：.ets 服务把 timelineWriteStore + zip 桥接到这里；测试用假 sink。 */
export interface V1ApplySink {
  writeRecords(date: string, text: string): void;
  writeSummary(date: string, text: string): void;
  writeMedia(date: string, file: string, bytes: Uint8Array): V1MediaWriteResult;
  appendLedgers(date: string, deleted: string[], restored: string[], conflicts: string[]): void;
  writeSchema(text: string): void;
}

/** 媒体来源（zip 桥）：只读 devices/<id>/attachments/<archive> 的 <entry>，缺条目返回 null。 */
export interface V1MediaSource {
  read(deviceId: string, archive: string, entry: string): Uint8Array | null;
}

/** apply 结果（计数 + 已执行步骤，供 UI 报告与测试断言写序）。 */
export interface V1ApplyResult {
  steps: WriteStep[];
  mediaWritten: number;
  mediaAlreadyPresent: number;
  mediaConflict: number;
  mediaMissing: number;
  schemaWritten: boolean;
}

// ---------------------------------------------------------------- 基础工具

/** 真实日历日校验（YYYY-MM-DD + 往返）。 */
export function isCalendarDate(date: string): boolean {
  if (!DAY_RE.test(date)) {
    return false;
  }
  const year: number = Number(date.slice(0, 4));
  const month: number = Number(date.slice(5, 7));
  const day: number = Number(date.slice(8, 10));
  if (year < 1 || year > 9999) {
    return false;
  }
  const probe: Date = new Date(year, month - 1, day);
  probe.setFullYear(year);
  return probe.getFullYear() === year && probe.getMonth() === month - 1 && probe.getDate() === day;
}

/** ts → 毫秒；不可解析返回 null（不抛）。 */
export function tsMillis(ts: string): number | null {
  if (typeof ts !== 'number' && typeof ts !== 'string') {
    return null;
  }
  const value: number = Date.parse(ts);
  return Number.isNaN(value) ? null : value;
}

/** ts 比较：可解析按时刻，否则字符串序（与迁移工具同口径）。 */
export function compareTs(left: string, right: string): number {
  const a: number | null = tsMillis(left);
  const b: number | null = tsMillis(right);
  if (a !== null && b !== null) {
    return a === b ? 0 : (a < b ? -1 : 1);
  }
  return left === right ? 0 : (left < right ? -1 : 1);
}

/** 事件时间 → 确定性 ISO（不读墙钟，同输入同字节）。 */
export function isoFromTs(ts: string): string {
  const ms: number | null = tsMillis(ts);
  return ms === null ? '1970-01-01T00:00:00.000Z' : new Date(ms).toISOString();
}

/** UTF-8 字节数（E_NO_SPACE 预检用；不依赖 TextEncoder / Buffer）。 */
export function utf8Length(text: string): number {
  let bytes: number = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code: number = text.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdfff) {
      bytes += 3; // 代理对按两个 3 字节替换符计，上限估计保守（不会低估）
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
        const next: number = text.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          bytes += 1; // 真代理对共 4 字节，抵消上面的 +3 后补 +1
          i += 1;
        }
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/** 字符串 → UTF-8 字节数组（同 ts 裁决用，逐字节比较与 Buffer.compare 等价）。 */
function utf8Bytes(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    let cp: number = text.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff) {
      const next: number = i + 1 < text.length ? text.charCodeAt(i + 1) : -1;
      if (next >= 0xdc00 && next <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (next - 0xdc00);
        i += 1;
      } else {
        cp = 0xfffd;
      }
    } else if (cp >= 0xdc00 && cp <= 0xdfff) {
      cp = 0xfffd;
    }
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(
        0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)
      );
    }
  }
  return out;
}

/** 规范整行的 UTF-8 字节序比较（契约 §4 tie-break）。 */
export function byteCompare(a: string, b: string): number {
  const left: number[] = utf8Bytes(a);
  const right: number[] = utf8Bytes(b);
  const len: number = Math.min(left.length, right.length);
  for (let i = 0; i < len; i += 1) {
    if (left[i] !== right[i]) {
      return left[i] < right[i] ? -1 : 1;
    }
  }
  return left.length === right.length ? 0 : (left.length < right.length ? -1 : 1);
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

// ---------------------------------------------------------------- v1 行解析（纯函数）

/** v1 JSON 行里只做 typeof 收窄的形态；所有字段可选，坏行由调用方跳过并计数。 */
interface V1RawRecord {
  id?: string;
  ts?: string;
  title?: string;
  body?: string;
  author?: string;
  done?: boolean;
  ai_processed?: boolean;
  deleted?: boolean;
  ocr_text?: string;
  ai_structured?: string;
  ocr_time?: string;
  attachments?: V1RawAttachment[];
}

interface V1RawAttachment {
  sha256?: string;
  pageIndex?: number;
  archive?: string;
  entry?: string;
}

interface V1RawOpen {
  id?: string;
  ts?: string;
  openedAt?: string;
  closedAt?: string;
}

interface V1RawSummary {
  generatedAt?: number;
}

/** 解析一行 v1 schedule；返回行或中文错误原因（永不抛）。 */
export function parseV1RecordLine(line: V1TextLine): V1RecordRow | string {
  let raw: V1RawRecord;
  let map: Record<string, Object>;
  try {
    raw = JSON.parse(line.text) as V1RawRecord;
    map = JSON.parse(line.text) as Record<string, Object>;
  } catch (error) {
    return `不是合法 JSON：${error instanceof Error ? error.message : String(error)}`;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return '记录必须是 JSON 对象';
  }
  if (typeof raw.id !== 'string' || raw.id.length === 0) {
    return '缺少非空字符串 id';
  }
  if (typeof raw.ts !== 'string' || raw.ts.length === 0) {
    return '缺少非空字符串 ts';
  }
  if (!isCalendarDate(line.date)) {
    return `文件名日期 ${line.date} 不是合法日历日`;
  }
  if (typeof raw.title !== 'string' || typeof raw.body !== 'string' || typeof raw.author !== 'string') {
    return 'title / body / author 必须是字符串';
  }
  if (typeof raw.done !== 'boolean' || typeof raw.ai_processed !== 'boolean') {
    return 'done / ai_processed 必须是布尔值';
  }
  const attachments: V1AttachmentRef[] = [];
  if (Array.isArray(raw.attachments)) {
    for (let i = 0; i < raw.attachments.length; i += 1) {
      const att: V1RawAttachment = raw.attachments[i];
      if (att === null || typeof att !== 'object' || Array.isArray(att)) {
        continue;
      }
      if (typeof att.sha256 !== 'string' || !SHA256_RE.test(att.sha256)) {
        continue;
      }
      if (typeof att.entry !== 'string' || att.entry.length === 0) {
        continue;
      }
      if (typeof att.archive !== 'string' || !att.archive.endsWith('.zip')) {
        continue;
      }
      const page: number = typeof att.pageIndex === 'number' && Number.isInteger(att.pageIndex) && att.pageIndex >= 0
        ? att.pageIndex : 0;
      attachments.push({
        sha256: att.sha256.toLowerCase(),
        pageIndex: page,
        archive: att.archive,
        entry: att.entry
      });
    }
  }
  const extras: V1ExtraField[] = [];
  for (const key of Object.keys(map)) {
    if (!KNOWN_V1_KEYS.has(key)) {
      extras.push({ key: key, json: JSON.stringify(map[key]) });
    }
  }
  const row: V1RecordRow = {
    deviceId: line.deviceId,
    date: line.date,
    id: raw.id,
    ts: raw.ts,
    title: raw.title,
    body: raw.body,
    author: raw.author,
    done: raw.done,
    ai_processed: raw.ai_processed,
    deleted: raw.deleted === true,
    attachments: attachments,
    extras: extras
  };
  if (typeof raw.ocr_text === 'string') {
    row.ocr_text = raw.ocr_text;
  }
  if (typeof raw.ai_structured === 'string') {
    row.ai_structured = raw.ai_structured;
  }
  if (typeof raw.ocr_time === 'string') {
    row.ocr_time = raw.ocr_time;
  }
  return row;
}

/** 解析一行 v1 open.jsonl；坏行返回 null。 */
export function parseV1OpenLine(text: string): V1OpenEntry | null {
  let raw: V1RawOpen;
  try {
    raw = JSON.parse(text) as V1RawOpen;
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  if (typeof raw.id !== 'string' || raw.id.length === 0 || typeof raw.ts !== 'string' || raw.ts.length === 0) {
    return null;
  }
  const entry: V1OpenEntry = {
    id: raw.id,
    ts: raw.ts,
    openedAt: typeof raw.openedAt === 'string' ? raw.openedAt : '',
    closedAt: typeof raw.closedAt === 'string' ? raw.closedAt : ''
  };
  return entry;
}

/** 解析一份 v1 summary JSON；坏行返回 null。 */
export function parseV1Summary(text: string): V1SummaryDocInput | null {
  let raw: V1RawSummary;
  try {
    raw = JSON.parse(text) as V1RawSummary;
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  if (typeof raw.generatedAt !== 'number' || !Number.isFinite(raw.generatedAt)) {
    return null;
  }
  return { date: '', text: text, generatedAt: raw.generatedAt };
}

// ---------------------------------------------------------------- 映射 / 序列化

/** v1 行（+ open 会话）→ v2 记录。未知字段尾随，opened_at/closed_at 保持完成耗时可算。 */
export function mapV1Record(row: V1RecordRow, open: V1OpenEntry | null): V2RecordPlan {
  const media: V2MediaPlan[] = [];
  for (let i = 0; i < row.attachments.length; i += 1) {
    const att: V1AttachmentRef = row.attachments[i];
    media.push({
      file: `${att.sha256.slice(0, 16)}.jpg`,
      sha256: att.sha256,
      pageIndex: att.pageIndex
    });
  }
  const openedAt: string = open !== null && open.openedAt.length > 0 ? open.openedAt : row.ts;
  let closedAt: string = '';
  if (open !== null && open.closedAt.length > 0) {
    closedAt = open.closedAt;
  } else if (row.done) {
    closedAt = row.ts;
  }
  const out: V2RecordPlan = {
    id: row.id,
    ts: row.ts,
    title: row.title,
    body: row.body,
    author: row.author,
    done: row.done,
    media: media,
    ai_processed: row.ai_processed,
    opened_at: openedAt,
    extras: row.extras.slice()
  };
  if (row.ocr_text !== undefined) {
    out.ocr_text = row.ocr_text;
  }
  if (row.ai_structured !== undefined) {
    out.ai_structured = row.ai_structured;
  }
  if (row.ocr_time !== undefined) {
    out.ocr_time = row.ocr_time;
  }
  if (closedAt.length > 0) {
    out.closed_at = closedAt;
  }
  return out;
}

/** 契约 §3 规范序列化：固定键序、无多余空格、未知字段尾随（值用其原始 JSON 片段）。 */
export function canonicalRecordLine(record: V2RecordPlan): string {
  const parts: string[] = [];
  for (let i = 0; i < KEY_ORDER.length; i += 1) {
    const key: string = KEY_ORDER[i];
    if (!hasOwn(record, key)) {
      continue;
    }
    if (key === 'media') {
      const items: string[] = [];
      for (let j = 0; j < record.media.length; j += 1) {
        const m: V2MediaPlan = record.media[j];
        items.push(`{"file":${JSON.stringify(m.file)},"sha256":${JSON.stringify(m.sha256)},"pageIndex":${m.pageIndex}}`);
      }
      parts.push(`"media":[${items.join(',')}]`);
    } else if (key === 'done') {
      parts.push(`"done":${record.done === true}`);
    } else if (key === 'ai_processed') {
      parts.push(`"ai_processed":${record.ai_processed === true}`);
    } else if (key === 'ocr_text' && record.ocr_text !== undefined) {
      parts.push(`"ocr_text":${JSON.stringify(record.ocr_text)}`);
    } else if (key === 'ai_structured' && record.ai_structured !== undefined) {
      parts.push(`"ai_structured":${JSON.stringify(record.ai_structured)}`);
    } else if (key === 'ocr_time' && record.ocr_time !== undefined) {
      parts.push(`"ocr_time":${JSON.stringify(record.ocr_time)}`);
    } else if (key === 'closed_at' && record.closed_at !== undefined) {
      parts.push(`"closed_at":${JSON.stringify(record.closed_at)}`);
    } else if (key === 'ocr_text' || key === 'ai_structured' || key === 'ocr_time' || key === 'closed_at') {
      continue; // 缺席的可选字段直接省略
    } else if (key === 'id') {
      parts.push(`"id":${JSON.stringify(record.id)}`);
    } else if (key === 'ts') {
      parts.push(`"ts":${JSON.stringify(record.ts)}`);
    } else if (key === 'title') {
      parts.push(`"title":${JSON.stringify(record.title)}`);
    } else if (key === 'body') {
      parts.push(`"body":${JSON.stringify(record.body)}`);
    } else if (key === 'author') {
      parts.push(`"author":${JSON.stringify(record.author)}`);
    } else if (key === 'opened_at') {
      parts.push(`"opened_at":${JSON.stringify(record.opened_at)}`);
    }
  }
  for (let i = 0; i < record.extras.length; i += 1) {
    const extra: V1ExtraField = record.extras[i];
    parts.push(`${JSON.stringify(extra.key)}:${extra.json}`);
  }
  return `{${parts.join(',')}}`;
}

/** records.json：数组括号各自独占一行、每个记录恰好一行、末尾恰好一个换行。 */
export function serializeDay(date: string, records: V2RecordPlan[]): string {
  const sorted: V2RecordPlan[] = records.slice();
  sorted.sort((left: V2RecordPlan, right: V2RecordPlan): number => {
    const delta: number = compareTs(left.ts, right.ts);
    return delta !== 0 ? delta : (left.id < right.id ? -1 : (left.id > right.id ? 1 : 0));
  });
  const open: string[] = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const closed: string | undefined = sorted[i].closed_at;
    if (closed === undefined || closed === null || closed.length === 0) {
      open.push(sorted[i].id);
    }
  }
  const lines: string[] = ['{', `  "date": ${JSON.stringify(date)},`];
  if (open.length === 0) {
    lines.push('  "open": [],');
  } else {
    lines.push('  "open": [');
    for (let i = 0; i < open.length; i += 1) {
      lines.push(`    ${JSON.stringify(open[i])}${i < open.length - 1 ? ',' : ''}`);
    }
    lines.push('  ],');
  }
  if (sorted.length === 0) {
    lines.push('  "records": []');
  } else {
    lines.push('  "records": [');
    for (let i = 0; i < sorted.length; i += 1) {
      lines.push(`    ${canonicalRecordLine(sorted[i])}${i < sorted.length - 1 ? ',' : ''}`);
    }
    lines.push('  ]');
  }
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

function jsonl(lines: string[]): string {
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

function compactLine(value: object): string {
  return JSON.stringify(value);
}

// ---------------------------------------------------------------- 折叠 / 计划

interface FoldEntry {
  row: V1RecordRow;
  rec: V2RecordPlan;
  line: string;
  dedupeKey: string;
}

interface FoldOutcome {
  records: V2RecordPlan[];
  /** 每个 id 真正胜出的 v1 行（单一裁决规则；媒体计划必须用它，避免与记录 media[] 错配）。 */
  winnerRows: Map<string, V1RecordRow>;
  deletedLines: string[];
  restoreLines: string[];
  conflictLines: string[];
  duplicates: number;
}

/** 同 id 折叠：较晚 ts 胜；同 ts 规范行 UTF-8 字节较大者胜；败者进 conflicts.jsonl。 */
function foldDay(
  date: string,
  rows: V1RecordRow[],
  openById: Map<string, V1OpenEntry>,
  existing: V1ExistingDayInput | null,
  skipReasons: V1SkipReason[]
): FoldOutcome {
  const groups: Map<string, FoldEntry[]> = new Map<string, FoldEntry[]>();
  const winnerRows: Map<string, V1RecordRow> = new Map<string, V1RecordRow>();
  for (let i = 0; i < rows.length; i += 1) {
    const row: V1RecordRow = rows[i];
    const open: V1OpenEntry | null = openById.get(row.id) === undefined ? null : openById.get(row.id) as V1OpenEntry;
    const rec: V2RecordPlan = mapV1Record(row, open);
    const line: string = canonicalRecordLine(rec);
    const entry: FoldEntry = { row: row, rec: rec, line: line, dedupeKey: sha256Hex(line) };
    const group: FoldEntry[] | undefined = groups.get(row.id);
    if (group === undefined) {
      groups.set(row.id, [entry]);
    } else {
      group.push(entry);
    }
  }
  const records: V2RecordPlan[] = [];
  const deletedLines: string[] = [];
  const restoreLines: string[] = [];
  const conflictLines: string[] = [];
  const seenConflicts: Set<string> = new Set<string>();
  const existById: Map<string, V2RecordPlan> = new Map<string, V2RecordPlan>();
  if (existing !== null) {
    for (let i = 0; i < existing.records.length; i += 1) {
      existById.set(existing.records[i].id, existing.records[i]);
    }
    for (let i = 0; i < existing.deletedLines.length; i += 1) {
      deletedLines.push(existing.deletedLines[i]);
    }
    for (let i = 0; i < existing.restoreLines.length; i += 1) {
      restoreLines.push(existing.restoreLines[i]);
    }
    for (let i = 0; i < existing.conflictLines.length; i += 1) {
      const line: string = existing.conflictLines[i];
      seenConflicts.add(line);
      conflictLines.push(line);
    }
  }
  const ids: string[] = Array.from(groups.keys());
  ids.sort();
  for (let i = 0; i < ids.length; i += 1) {
    const id: string = ids[i];
    const group: FoldEntry[] = groups.get(id) as FoldEntry[];
    let best: FoldEntry = group[0];
    for (let k = 1; k < group.length; k += 1) {
      const candidate: FoldEntry = group[k];
      const delta: number = compareTs(candidate.rec.ts, best.rec.ts);
      if (delta > 0) {
        best = candidate;
      } else if (delta === 0) {
        const cmp: number = byteCompare(candidate.line, best.line);
        if (cmp > 0) {
          addConflict(conflictLines, seenConflicts, best);
          best = candidate;
        } else if (cmp < 0) {
          addConflict(conflictLines, seenConflicts, candidate);
        } else {
          skipReasons.push({ source: `${date}/${id}`, reason: '重复版本逐字节相同，已折叠' });
        }
      }
    }
    // 与折叠记录共用同一个胜者行：媒体来源不得用另一套「较晚 ts、并列取先到」的规则（P2-2）。
    winnerRows.set(id, best.row);
    // 断点续跑：已有同 id 的更晚版本胜出（v2 侧编辑不因重跑被 v1 旧版本覆盖）。
    const prior: V2RecordPlan | undefined = existById.get(id);
    if (prior !== undefined) {
      const priorLine: string = canonicalRecordLine(prior);
      const delta: number = compareTs(prior.ts, best.rec.ts);
      if (delta > 0 || (delta === 0 && byteCompare(priorLine, best.line) >= 0)) {
        continue; // 已有版本更晚（或同 ts 字节更大）：原样保留在 existById，稍后进入 remain
      }
      existById.delete(id); // 已有版本被 v1 更晚版本覆盖：只写新版本，不重复保留旧版本
    }
    if (best.row.deleted) {
      addLedgerLine(deletedLines, compactLine({
        id: id, ts: best.rec.ts, deletedAt: isoFromTs(best.rec.ts)
      }));
      continue;
    }
    let earlierTombstone: boolean = false;
    for (let k = 0; k < group.length; k += 1) {
      if (group[k].row.deleted && compareTs(group[k].row.ts, best.rec.ts) < 0) {
        earlierTombstone = true;
        break;
      }
    }
    if (earlierTombstone) {
      addLedgerLine(restoreLines, compactLine({
        id: id, ts: best.rec.ts, restoredAt: isoFromTs(best.rec.ts)
      }));
    }
    records.push(best.rec);
  }
  // 已有但 v1 没有的 id（断点续跑）：原样保留，不删、不覆盖。
  const remain: V2RecordPlan[] = Array.from(existById.values());
  for (let i = 0; i < remain.length; i += 1) {
    records.push(remain[i]);
  }
  return {
    records: records,
    winnerRows: winnerRows,
    deletedLines: deletedLines,
    restoreLines: restoreLines,
    conflictLines: conflictLines,
    duplicates: 0
  };
}

function addConflict(lines: string[], seen: Set<string>, loser: FoldEntry): void {
  const line: string = compactLine({
    id: loser.rec.id,
    ts: loser.rec.ts,
    losingLine: loser.line,
    decidedAt: isoFromTs(loser.rec.ts),
    dedupeKey: loser.dedupeKey
  });
  addLedgerLine(lines, line, seen);
}

/** 账本按 (id,ts[,dedupeKey]) 去重（简单整行去重亦覆盖重复重放）。 */
function addLedgerLine(lines: string[], line: string, seen?: Set<string>): void {
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i] === line) {
      return;
    }
  }
  if (seen !== undefined && seen.has(line)) {
    return;
  }
  if (seen !== undefined) {
    seen.add(line);
  }
  lines.push(line);
}

/** 构造完整计划：只读输入，零 IO，零墙钟；dry-run 与 apply 共用同一份结果。 */
export function planV1Import(input: V1ImportInput): V1ImportPlan {
  const openById: Map<string, V1OpenEntry> = new Map<string, V1OpenEntry>();
  for (let i = 0; i < input.openLines.length; i += 1) {
    const entry: V1OpenEntry | null = parseV1OpenLine(input.openLines[i]);
    if (entry === null) {
      continue;
    }
    const prior: V1OpenEntry | undefined = openById.get(entry.id);
    if (prior === undefined || compareTs(entry.ts, prior.ts) > 0) {
      openById.set(entry.id, entry);
    }
  }
  const summaryByDay: Map<string, V1SummaryDocInput> = new Map<string, V1SummaryDocInput>();
  for (let i = 0; i < input.summaries.length; i += 1) {
    const doc: V1SummaryDocInput = input.summaries[i];
    const prior: V1SummaryDocInput | undefined = summaryByDay.get(doc.date);
    if (prior === undefined || doc.generatedAt > prior.generatedAt) {
      summaryByDay.set(doc.date, doc);
    }
  }
  const existingByDay: Map<string, V1ExistingDayInput> = new Map<string, V1ExistingDayInput>();
  for (let i = 0; i < input.existingDays.length; i += 1) {
    existingByDay.set(input.existingDays[i].date, input.existingDays[i]);
  }
  const rowsByDay: Map<string, V1RecordRow[]> = new Map<string, V1RecordRow[]>();
  const skipReasons: V1SkipReason[] = [];
  for (let i = 0; i < input.scheduleLines.length; i += 1) {
    const line: V1TextLine = input.scheduleLines[i];
    const parsed: V1RecordRow | string = parseV1RecordLine(line);
    if (typeof parsed === 'string') {
      skipReasons.push({ source: `${line.date}/${line.deviceId}`, reason: `坏行已跳过：${parsed}` });
      continue;
    }
    const group: V1RecordRow[] | undefined = rowsByDay.get(parsed.date);
    if (group === undefined) {
      rowsByDay.set(parsed.date, [parsed]);
    } else {
      group.push(parsed);
    }
  }
  const available: Set<string> = new Set<string>(input.availableZipEntries);
  const sizes: Map<string, number> = new Map<string, number>();
  for (let i = 0; i < input.mediaSizes.length; i += 1) {
    sizes.set(`${input.mediaSizes[i].archive}\u0000${input.mediaSizes[i].entry}`, input.mediaSizes[i].size);
  }
  const dates: string[] = Array.from(rowsByDay.keys());
  for (let i = 0; i < input.existingDays.length; i += 1) {
    const d: string = input.existingDays[i].date;
    if (dates.indexOf(d) < 0) {
      dates.push(d);
    }
  }
  dates.sort();
  const days: V1DayPlan[] = [];
  let records: number = 0;
  let mediaFiles: number = 0;
  let mediaMissing: number = 0;
  let summaries: number = 0;
  let conflicts: number = 0;
  let deletes: number = 0;
  let restores: number = 0;
  let alreadyPresent: number = 0;
  let recordsAlreadyPresent: number = 0;
  for (let i = 0; i < dates.length; i += 1) {
    const date: string = dates[i];
    const existing: V1ExistingDayInput | undefined = existingByDay.get(date);
    const folded: FoldOutcome = foldDay(
      date, rowsByDay.get(date) === undefined ? [] : rowsByDay.get(date) as V1RecordRow[],
      openById, existing === undefined ? null : existing, skipReasons
    );
    const media: V1MediaPlan[] = [];
    let dayAlready: number = 0;
    const mediaNames: Set<string> = new Set<string>();
    if (existing !== undefined) {
      for (let k = 0; k < existing.mediaFiles.length; k += 1) {
        mediaNames.add(existing.mediaFiles[k]);
      }
    }
    // 媒体来源 = foldDay 的胜者行（较晚 ts、同 ts 规范行字节较大者），与记录 media[] 同一裁决规则。
    const winnerRows: Map<string, V1RecordRow> = folded.winnerRows;
    const recordIds: Set<string> = new Set<string>();
    for (let k = 0; k < folded.records.length; k += 1) {
      recordIds.add(folded.records[k].id);
    }
    const ids: string[] = Array.from(winnerRows.keys());
    ids.sort();
    for (let k = 0; k < ids.length; k += 1) {
      const row: V1RecordRow = winnerRows.get(ids[k]) as V1RecordRow;
      if (!recordIds.has(row.id) || row.deleted) {
        continue;
      }
      for (let j = 0; j < row.attachments.length; j += 1) {
        const att: V1AttachmentRef = row.attachments[j];
        if (att.entry.startsWith('/') || att.entry.includes('\\') || att.entry.split('/').indexOf('..') >= 0) {
          skipReasons.push({ source: `${date}/${row.id}`, reason: `附件条目名不合法已跳过：${att.entry}` });
          continue;
        }
        const key: string = `${att.archive}\u0000${att.entry}`;
        const file: string = `${att.sha256.slice(0, 16)}.jpg`;
        if (mediaNames.has(file)) {
          alreadyPresent += 1;
          dayAlready += 1;
          continue;
        }
        mediaNames.add(file);
        let status: 'to-write' | 'missing' = 'to-write';
        if (input.zipListAvailable && !available.has(key)) {
          status = 'missing';
          mediaMissing += 1;
          skipReasons.push({ source: `${date}/${row.id}`, reason: `zip 条目缺失：${att.archive}!${att.entry}（记录仍迁移）` });
        }
        const size: number = sizes.get(key) === undefined ? 0 : sizes.get(key) as number;
        media.push({
          date: date, file: file, sha256: att.sha256, pageIndex: att.pageIndex,
          deviceId: row.deviceId, archive: att.archive, entry: att.entry,
          size: status === 'missing' ? 0 : size, status: status
        });
      }
    }
    const recordsJson: string = serializeDay(date, folded.records);
    let summaryJson: string = '';
    const summary: V1SummaryDocInput | undefined = summaryByDay.get(date);
    if (summary !== undefined) {
      const priorAt: number = existing === undefined || existing.summaryGeneratedAt === null
        ? -1 : existing.summaryGeneratedAt;
      if (summary.generatedAt > priorAt) {
        summaryJson = `${summary.text.trimEnd()}\n`;
      } else {
        skipReasons.push({ source: `${date}/summary.json`, reason: '已有汇总更新或相同，保留现有字节' });
      }
    }
    const bytes: number = utf8Length(recordsJson) + utf8Length(summaryJson)
      + utf8Length(jsonl(folded.deletedLines)) + utf8Length(jsonl(folded.restoreLines))
      + utf8Length(jsonl(folded.conflictLines));
    let mediaBytes: number = 0;
    for (let k = 0; k < media.length; k += 1) {
      mediaBytes += media[k].size;
    }
    for (let k = 0; k < folded.records.length; k += 1) {
      const line: string = canonicalRecordLine(folded.records[k]);
      const src: V2RecordPlan | undefined = existing === undefined ? undefined : findRecord(existing.records, folded.records[k].id);
      if (src !== undefined && canonicalRecordLine(src) === line) {
        recordsAlreadyPresent += 1;
      }
    }
    const day: V1DayPlan = {
      date: date,
      records: folded.records,
      recordsJson: recordsJson,
      summaryJson: summaryJson,
      media: media,
      deletedLines: folded.deletedLines,
      restoreLines: folded.restoreLines,
      conflictLines: folded.conflictLines,
      recordCount: folded.records.length,
      mediaFiles: media.length,
      summaries: summaryJson.length > 0 ? 1 : 0,
      deletes: folded.deletedLines.length,
      restores: folded.restoreLines.length,
      conflicts: folded.conflictLines.length,
      bytes: bytes + mediaBytes,
      alreadyPresent: dayAlready
    };
    days.push(day);
    records += day.recordCount;
    mediaFiles += day.mediaFiles;
    summaries += day.summaries;
    conflicts += day.conflicts;
    deletes += day.deletes;
    restores += day.restores;
  }
  const allTs: string[] = [];
  for (let i = 0; i < input.scheduleLines.length; i += 1) {
    const parsed: V1RecordRow | string = parseV1RecordLine(input.scheduleLines[i]);
    if (typeof parsed !== 'string') {
      allTs.push(parsed.ts);
    }
  }
  for (let i = 0; i < input.openLines.length; i += 1) {
    const entry: V1OpenEntry | null = parseV1OpenLine(input.openLines[i]);
    if (entry !== null) {
      allTs.push(entry.ts);
    }
  }
  allTs.sort(compareTs);
  const migratedAt: string = allTs.length > 0 ? isoFromTs(allTs[allTs.length - 1]) : '1970-01-01T00:00:00.000Z';
  const schemaText: string = `${JSON.stringify({ schemaVersion: 2, migratedAt: migratedAt, source: 'v1-app-import' }, null, 2)}\n`;
  let totalBytes: number = utf8Length(schemaText);
  for (let i = 0; i < days.length; i += 1) {
    totalBytes += days[i].bytes;
  }
  return {
    days: days,
    totals: {
      days: days.length, records: records, mediaFiles: mediaFiles, mediaMissing: mediaMissing,
      bytes: totalBytes, summaries: summaries, skippedRows: skipReasons.length,
      conflicts: conflicts, deletes: deletes, restores: restores,
      alreadyPresent: alreadyPresent, recordsAlreadyPresent: recordsAlreadyPresent
    },
    skipReasons: skipReasons,
    schemaText: schemaText,
    migratedAt: migratedAt
  };
}

function findRecord(records: V2RecordPlan[], id: string): V2RecordPlan | undefined {
  for (let i = 0; i < records.length; i += 1) {
    if (records[i].id === id) {
      return records[i];
    }
  }
  return undefined;
}

// ---------------------------------------------------------------- 写序 / 汇总 / 拒绝

/** 固定写序：每天 records → summary → media → ledgers；所有日之后 schema（最后一步）。 */
export function nextWriteSteps(plan: V1ImportPlan): WriteStep[] {
  const steps: WriteStep[] = [];
  for (let i = 0; i < plan.days.length; i += 1) {
    const date: string = plan.days[i].date;
    steps.push({ date: date, kind: 'records', dayIndex: i });
    steps.push({ date: date, kind: 'summary', dayIndex: i });
    steps.push({ date: date, kind: 'media', dayIndex: i });
    steps.push({ date: date, kind: 'ledgers', dayIndex: i });
  }
  steps.push({ date: '', kind: 'schema', dayIndex: -1 });
  return steps;
}

/** dry-run 展示文本（逐字中文；含跳过原因与断点状态）。 */
export function summarizePlan(plan: V1ImportPlan): string[] {
  const t: V1PlanTotals = plan.totals;
  const out: string[] = [
    `计划：${t.days} 天 / ${t.records} 条记录 / ${t.mediaFiles} 个媒体文件 / ${t.bytes} 字节 / ${t.summaries} 份汇总`,
    `账本：删除 ${t.deletes} / 恢复 ${t.restores} / 冲突 ${t.conflicts}；跳过 ${t.skippedRows} 行，其中缺失媒体 ${t.mediaMissing}`,
    `已存在不覆盖：记录 ${t.recordsAlreadyPresent} 条 / 媒体 ${t.alreadyPresent} 个`,
    `写序：每天 records → summary → media → ledgers；最后才写 timeline/schema.json（提交边界）`
  ];
  for (let i = 0; i < plan.days.length; i += 1) {
    const d: V1DayPlan = plan.days[i];
    out.push(`日 ${d.date}：记录 ${d.recordCount} / 媒体 ${d.mediaFiles} / 字节 ${d.bytes} / 删除 ${d.deletes} / 恢复 ${d.restores} / 冲突 ${d.conflicts}`);
  }
  for (let i = 0; i < plan.skipReasons.length; i += 1) {
    const s: V1SkipReason = plan.skipReasons[i];
    out.push(`跳过原因（${s.source}）：${s.reason}`);
  }
  return out;
}

/** 断点/续跑状态消息（不阻断迁移，但必须在 UI 明确可见）。 */
export const PARTIAL_MIGRATION_STATE: string =
  'E_PARTIAL_MIGRATION: 上次迁移未完成，可继续（timeline/ 已存在但缺少 schema.json）';

function refusal(code: ImportRefusalCode, stateCode: string, reason: string, nextStep: string, blocks: boolean): ImportRefusal {
  const out: ImportRefusal = { code: code, stateCode: stateCode, reason: reason, nextStep: nextStep, blocks: blocks };
  return out;
}

/** 类型化拒绝判定：按固定优先级返回首个命中，全部通过返回 null。 */
export function decideImportRefusal(input: V1RefusalInput): ImportRefusal | null {
  if (input.schemaVersion === 2) {
    return refusal('E_ALREADY_MIGRATED', 'E_ALREADY_MIGRATED',
      'E_ALREADY_MIGRATED: 仓库已迁移到 v2 时间线（timeline/schema.json 的 schemaVersion 为 2），无需重复迁移。',
      '无需操作；如需检查数据请用只读体检工具，不要重复写 timeline/。', true);
  }
  if (!input.hasV1Schedules || !input.hasDevices) {
    return refusal('E_NO_V1_DATA', 'E_NO_V1_DATA',
      'E_NO_V1_DATA: 未发现 devices/ 下的日程记录，没有可迁移的数据。',
      '请确认仓库路径，以及 devices/<设备>/schedules/*.jsonl 是否存在。', true);
  }
  if (input.strictMode && input.corruptRows > 0) {
    return refusal('E_CORRUPT_V1', 'E_CORRUPT_V1',
      `E_CORRUPT_V1: 严格模式下发现 ${input.corruptRows} 行无法解析的 v1 数据，已中止且未写入任何文件。`,
      '修正 v1 数据后重试，或关闭严格模式以跳过坏行并查看逐行报告。', true);
  }
  if (input.availableBytes !== null && input.plannedBytes > input.availableBytes) {
    return refusal('E_NO_SPACE', 'E_NO_SPACE',
      `E_NO_SPACE: 预估需要 ${input.plannedBytes} 字节，当前可用 ${input.availableBytes} 字节，空间不足；未写入任何文件。`,
      '释放空间或在空间充足的设备上重试；dry-run 计划可随时重算。', true);
  }
  // 断点续跑状态放在所有阻断检查之后：部分态不得短路严格模式 / 空间不足检查（P2-1）。
  if (input.timelineDayDirs.length > 0) {
    return refusal('E_PARTIAL_STATE', 'E_PARTIAL_MIGRATION',
      PARTIAL_MIGRATION_STATE + '；本次会按 id 与较晚 ts 幂等续跑，不覆盖 v1。',
      '点「确认迁移」继续；中断前的日目录会合并，schema.json 仍在最后写。', false);
  }
  return null;
}

/** 执行计划：严格按 nextWriteSteps 的顺序；任一步抛错时 schema 尚未写，可干净重跑。 */
export function applyV1Plan(plan: V1ImportPlan, sink: V1ApplySink, mediaSource: V1MediaSource): V1ApplyResult {
  const steps: WriteStep[] = nextWriteSteps(plan);
  const result: V1ApplyResult = {
    steps: steps, mediaWritten: 0, mediaAlreadyPresent: 0,
    mediaConflict: 0, mediaMissing: 0, schemaWritten: false
  };
  for (let i = 0; i < steps.length; i += 1) {
    const step: WriteStep = steps[i];
    if (step.kind === 'schema') {
      sink.writeSchema(plan.schemaText);
      result.schemaWritten = true;
      continue;
    }
    const day: V1DayPlan = plan.days[step.dayIndex];
    if (step.kind === 'records') {
      sink.writeRecords(day.date, day.recordsJson);
    } else if (step.kind === 'summary') {
      if (day.summaryJson.length > 0) {
        sink.writeSummary(day.date, day.summaryJson);
      }
    } else if (step.kind === 'media') {
      for (let k = 0; k < day.media.length; k += 1) {
        const media: V1MediaPlan = day.media[k];
        if (media.status === 'already-present') {
          result.mediaAlreadyPresent += 1;
          continue;
        }
        const bytes: Uint8Array | null = mediaSource.read(media.deviceId, media.archive, media.entry);
        if (bytes === null) {
          result.mediaMissing += 1;
          continue;
        }
        const written: V1MediaWriteResult = sink.writeMedia(media.date, media.file, bytes);
        if (written === 'written') {
          result.mediaWritten += 1;
        } else if (written === 'already-present') {
          result.mediaAlreadyPresent += 1;
        } else {
          result.mediaConflict += 1;
        }
      }
    } else if (step.kind === 'ledgers') {
      sink.appendLedgers(day.date, day.deletedLines, day.restoreLines, day.conflictLines);
    }
  }
  return result;
}

/** 媒体文件名合法性（<sha16>.jpg，裸文件名、不含路径）。 */
export function isMediaFileName(name: string): boolean {
  return MEDIA_NAME_RE.test(name);
}
