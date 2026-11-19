/**
 * v2 单时间线**写入**核心（mod-v2-write-service）：纯模型、零 SDK import、无墙钟、确定性。
 *
 * 职责边界（权威契约 docs/DATA-CONTRACT-v2.md §3/§6/§7）：
 * - 本文件只产出**字节文本**与**写计划**，不碰任何文件句柄、不读 AppStorage、不写 v1 路径；
 *   落盘由 services/timelineWriteStore.ets 负责（且默认关闭，inert）。
 * - **职责边界**：仓库级门禁 `assertWritable()`（schema + 分支 `main` + HEAD==origin/main）与
 *   outbox / union / replay 同步周期都是 `mod-v2-sync-protocol` 的职责；本模块只做**单进程原子写**
 *   与纯字节判定，不实现分支断言、不跨设备收敛。
 * - buildRecordsText() 的字节形状与 §3 示例逐字符一致：顶层 date/open/records 三个键，
 *   每条记录独占一行（canonicalRecordLine 输出），记录行缩进 2 空格、除末行外尾随逗号，
 *   文件末尾恰好一个换行。记录按 (ts 时刻, id) 升序（复用 sortRecordsForWrite）。
 * - open 只由 closed_at 缺省推导（§6：空串 / 纯空白 / null 等同缺省）；done 不参与判定，
 *   也不信任传入的 open 缓存。
 * - upsert 替换同 id 的**全部**旧版本行（任意 ts）并重新排序；remove 删除同 id 的全部版本行，
 *   records.json 内**不写墓碑**（§7 物理删除）。账本行由 ledgerDeleteLine/ledgerRestoreLine
 *   单独产出，调用方负责追加到 deleted.jsonl / restore.jsonl。
 * - 任何非法日期 / 非法记录都 fail-closed：WritePlan.ok=false、text=''，buildRecordsText 返回 ''。
 *   自检手段：把拟写文本交给 parseTimelineDay(date) 回读；day=null 或有 errors 即拒绝输出，
 *   保证「绝不吐出解析不了的文本」。
 * - 不变量：纯函数、同输入两次得到相同字节、不读取系统当前时间或墙钟；所有时间戳由调用方传入。
 */
import { canonicalRecordLine, sortRecordsForWrite, parseTimelineDay } from './timeline';
import type { TimelineRecord, LedgerEntry } from './timeline';

/** 写计划：ok=false 时 text 恒为 ''，调用方必须停止写盘。 */
export interface WritePlan {
  ok: boolean;
  text: string;
  open: string[];
  reason: string;
}

/** 日期目录形状；真实日历合法性由 isCalendarDate() 往返校验（与 timelineStore 同口径）。 */
const DATE_KEY_RE: RegExp = /^\d{4}-\d{2}-\d{2}$/;

/** 纯算术的日历日校验（不构造 Date，彻底排除墙钟）。 */
function isCalendarDate(date: string): boolean {
  if (!DATE_KEY_RE.test(date)) {
    return false;
  }
  const year: number = Number(date.slice(0, 4));
  const month: number = Number(date.slice(5, 7));
  const day: number = Number(date.slice(8, 10));
  if (year < 1 || year > 9999 || month < 1 || month > 12) {
    return false;
  }
  const leap: boolean = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const monthDays: number[] = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= monthDays[month - 1];
}

/** `ts` 的最小形状：ISO 8601 到秒（后跟时区偏移 / 小数秒均可），再由 Date.parse 确认可解析。 */
const TS_SHAPE_RE: RegExp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

/**
 * 把 `ts` 解析为时刻（epoch 毫秒）；不可解析返回 null。
 * 纯函数：Date.parse 只解析传入的字符串，不读墙钟，同输入恒同输出。
 */
export function tsMillis(ts: string): number | null {
  if (typeof ts !== 'string' || ts.length === 0) {
    return null;
  }
  const value: number = Date.parse(ts);
  return Number.isFinite(value) ? value : null;
}

/** 写侧 ts 形状校验（§3/§4）：形状匹配且可解析才算合法。 */
export function isValidTsShape(ts: string): boolean {
  if (typeof ts !== 'string' || !TS_SHAPE_RE.test(ts)) {
    return false;
  }
  return tsMillis(ts) !== null;
}

/** 从 summary.json 文本中取有效的 generatedAt；坏 JSON / 缺字段 / NaN 一律 null。 */
function summaryMillis(text: string): number | null {
  if (typeof text !== 'string' || text.length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const generated: unknown = (parsed as Record<string, unknown>).generatedAt;
  if (typeof generated !== 'number' || !Number.isFinite(generated)) {
    return null;
  }
  return generated;
}

/**
 * summary.json 的 newer-wins 纯判定（§8）。规则（顺序即优先级）：
 * 1. 候选无效 / 空 / NaN → false（坏候选永不覆盖好汇总）；
 * 2. 旧文件缺失 / 无效 → true（合法候选可以替换坏文件）；
 * 3. 两边都合法 → 严格 `next.generatedAt > old.generatedAt`（相等保留现有）。
 */
export function isNewerSummaryText(oldText: string, nextText: string): boolean {
  const next: number | null = summaryMillis(nextText);
  if (next === null) {
    return false;
  }
  const old: number | null = summaryMillis(oldText);
  if (old === null) {
    return true;
  }
  return next > old;
}

/** 统一的失败计划：绝不携带任何待写文本。 */
function fail(reason: string): WritePlan {
  return { ok: false, text: '', open: [], reason: reason };
}

/**
 * 派生当日未完成 id（§6）：只看 closed_at 缺省（空串 / 纯空白 / null 等同缺省），
 * 绝不用 done，也不看调用方给的 open 缓存。保留入参顺序，由调用方决定是否排序。
 */
export function openIdsOf(records: TimelineRecord[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < records.length; i += 1) {
    const record: TimelineRecord = records[i];
    const closed: unknown = record.closed_at;
    const isOpen: boolean = closed === undefined || closed === null ||
      (typeof closed === 'string' && closed.trim().length === 0);
    if (isOpen) {
      out.push(record.id);
    }
  }
  return out;
}

/**
 * 构造一日的 records.json 全文（§3 字节形状）。非法日期 / 任一记录非法 / 自检失败 → 返回 ''。
 * 注意：不做 id 折叠，折叠是上游语义；这里只保证「给出什么就规范地写出什么」。
 */
export function buildRecordsText(date: string, records: TimelineRecord[]): string {
  if (!isCalendarDate(date)) {
    return '';
  }
  const sorted: TimelineRecord[] = sortRecordsForWrite(records);
  const lines: string[] = [];
  lines.push('{');
  lines.push(`  "date": ${JSON.stringify(date)},`);
  lines.push(`  "open": ${JSON.stringify(openIdsOf(sorted))},`);
  lines.push('  "records": [');
  for (let i = 0; i < sorted.length; i += 1) {
    const comma: string = i < sorted.length - 1 ? ',' : '';
    lines.push(`  ${canonicalRecordLine(sorted[i])}${comma}`);
  }
  lines.push('  ]');
  lines.push('}');
  const text: string = `${lines.join('\n')}\n`;
  // 自检：把拟写字节交给读侧解析器，任何坏字段 / 坏媒体 / 日期不符都在这里被挡下。
  const parsed = parseTimelineDay(text, date);
  if (parsed.day === null || parsed.errors.length > 0) {
    return '';
  }
  return text;
}

/** closed_at 缺省（空串 / 纯空白 / null）等同未关闭，与 §6 的 open 谓词同口径。 */
function hasClosedAt(record: TimelineRecord): boolean {
  const value: unknown = record.closed_at;
  return typeof value === 'string' && (value as string).trim().length > 0;
}

/**
 * 重新打开判定（§6 P2-2）：该 id 的最新旧版本处于关闭态，而本次写入不带 closed_at
 * （v1 「取消完成」由服务层映射为清掉 closed_at）→ 刷新 opened_at = 本次 ts。
 * 用「最新旧版本」而非「任意旧版本」，避免历史关闭行把当前已打开的会话误判为重新打开。
 */
function wasClosedAndNowOpen(records: TimelineRecord[], incoming: TimelineRecord): boolean {
  if (hasClosedAt(incoming)) {
    return false;
  }
  let latestTs: number | null = null;
  let latestClosed: boolean = false;
  for (let i = 0; i < records.length; i += 1) {
    const existing: TimelineRecord = records[i];
    if (existing.id !== incoming.id) {
      continue;
    }
    const at: number | null = tsMillis(existing.ts);
    if (at === null) {
      continue;
    }
    if (latestTs === null || at > latestTs) {
      latestTs = at;
      latestClosed = hasClosedAt(existing);
    }
  }
  return latestClosed;
}

/**  upsert：替换同 id（任意 ts）的全部旧版本行，重新排序后给出写计划。 */
export function planUpsert(date: string, records: TimelineRecord[], record: TimelineRecord): WritePlan {
  if (!isCalendarDate(date)) {
    return fail(`非法日期：${date}`);
  }
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    return fail('记录必须是 JSON 对象');
  }
  if (typeof record.id !== 'string' || record.id.trim().length === 0) {
    return fail('记录 id 必须是非空字符串');
  }
  // N2：写侧 ts 形状门禁。describeRecordProblem 只要求 ts 非空，畸形 ts 不能经主写路径落盘。
  if (!isValidTsShape(record.ts)) {
    return fail('记录 ts 形状不合法（需 YYYY-MM-DDTHH:mm:ss 且可解析）');
  }
  // 重新打开 = 新会话：刷新 opened_at 到本次 ts（§6 P2-2）。复制入参，绝不改写调用方对象。
  const reopened: boolean = wasClosedAndNowOpen(records, record);
  const incoming: TimelineRecord = reopened ? { ...record, opened_at: record.ts } : record;
  const next: TimelineRecord[] = [];
  for (let i = 0; i < records.length; i += 1) {
    if (records[i].id !== record.id) {
      next.push(records[i]);
    }
  }
  next.push(incoming);
  const text: string = buildRecordsText(date, next);
  if (text.length === 0) {
    return fail('规范化后的记录文本无法通过解析自检');
  }
  return { ok: true, text: text, open: openIdsOf(next), reason: '' };
}

/** remove：删除同 id 的全部版本行（文件内不留墓碑）；id 不存在时为幂等 no-op。 */
export function planRemove(date: string, records: TimelineRecord[], id: string): WritePlan {
  if (!isCalendarDate(date)) {
    return fail(`非法日期：${date}`);
  }
  if (typeof id !== 'string' || id.trim().length === 0) {
    return fail('记录 id 必须是非空字符串');
  }
  const next: TimelineRecord[] = [];
  for (let i = 0; i < records.length; i += 1) {
    if (records[i].id !== id) {
      next.push(records[i]);
    }
  }
  const text: string = buildRecordsText(date, next);
  if (text.length === 0) {
    return fail('规范化后的记录文本无法通过解析自检');
  }
  return { ok: true, text: text, open: openIdsOf(next), reason: '' };
}

/**
 * 物理清行前置判定（§7 P1-4 第三步 / N1）：只有该 id 存在于**原始版本行**（allRecords）
 * 且删除账本确有该 id 的条目时才返回 true。
 * - 防止未 schedule（无账本行）却直接 purge 掉仍可见、本地不可恢复的行；
 * - 行已消失（上次已清掉）时返回 false，服务层据此区分「幂等 no-op」与「拒绝清行」。
 * 纯函数：只读入参、不改写、不读墙钟。
 */
export function canPurge(
  records: TimelineRecord[],
  deleteLedger: LedgerEntry[],
  id: string
): boolean {
  if (typeof id !== 'string' || id.length === 0) {
    return false;
  }
  let inRecords: boolean = false;
  for (let i = 0; i < records.length; i += 1) {
    if (records[i].id === id) {
      inRecords = true;
      break;
    }
  }
  if (!inRecords) {
    return false;
  }
  for (let i = 0; i < deleteLedger.length; i += 1) {
    if (deleteLedger[i].id === id) {
      return true;
    }
  }
  return false;
}

/** 删除账本的一行（§7 形状；intentId 为可选字段，本 API 不产出）。非法入参返回 ''。 */
export function ledgerDeleteLine(id: string, ts: string, deletedAt: string): string {
  if (id.length === 0 || ts.length === 0 || deletedAt.length === 0) {
    return '';
  }
  return JSON.stringify({ id: id, ts: ts, deletedAt: deletedAt });
}

/** 撤销账本的一行（§7 形状）。非法入参返回 ''。 */
export function ledgerRestoreLine(id: string, ts: string, restoredAt: string): string {
  if (id.length === 0 || ts.length === 0 || restoredAt.length === 0) {
    return '';
  }
  return JSON.stringify({ id: id, ts: ts, restoredAt: restoredAt });
}
