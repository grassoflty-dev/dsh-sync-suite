/**
 * 「未完成索引」（`devices/<deviceId>/open.jsonl`）的编解码、折叠与对账（纯逻辑，零 SDK 依赖）。
 *
 * 为什么需要它：`docs/DATA-CONTRACT.md` §3 的日程落在 `schedules/YYYY-MM-DD.jsonl` 分片里，
 * 跨日未完成若每天扫全部分片，分片越多越慢。索引是**派生数据**：
 * - 一行一个 JSON 对象，和日程日志一样**只追加**，同 id 以 `ts` 较晚的一条为准；
 * - 任何写入失败都不得影响日程保存；读到的索引不信任，启动/拉取后用日程分片重算对账；
 * - 索引只覆盖本机设备目录（`devices/<本机 deviceId>/open.jsonl`），跨设备折叠仍走日程分片。
 *
 * 条目结构：
 * ```json
 * {"id":"...","date":"2026-11-15","ts":"2026-11-15T09:30:00+08:00","openedAt":"2026-11-15T09:30:00+08:00","closedAt":"2026-11-15T18:00:00+08:00"}
 * ```
 * - `openedAt`：本次未完成会话的开始时刻（首次创建 / 最近一次「取消完成」）；
 * - `closedAt`：会话结束时刻，缺失 = 当前仍未完成；空串按缺失处理（历史脏行容错）；
 * - `ts`：该条目对应的**最后一条日程记录的 ts**，折叠时用它比新旧；
 * - `date`：日程归属日期（`YYYY-MM-DD`，取自记录 ts），查询时据此定位分片。
 *
 * 本文件禁止 import 鸿蒙 SDK 运行时 / 页面组件 / services 层 —— 必须能在 Node 下直接运行。
 */
import type { ScheduleRecord } from './types';
import { recordDateKey } from './jsonl';

/** 索引条目（一行 JSONL）。 */
export interface OpenEntry {
  /** 日程记录 id（跨设备折叠键）。 */
  id: string;
  /** 日程归属日期 `YYYY-MM-DD`（来自记录 ts）；异常 ts 时允许空串。 */
  date: string;
  /** 该条目对应记录的最后一条 ts。 */
  ts: string;
  /** 未完成会话开始时刻。 */
  openedAt: string;
  /** 会话结束时刻；缺省/空串 = 仍未完成。 */
  closedAt?: string;
}

/** 坏行定位信息（与 `parseJsonl` 同形）。 */
export interface OpenIndexLineError {
  line: number;
  message: string;
}

/** `applyRecordToIndex` 的结果。 */
export interface OpenIndexApplyResult {
  /** 应用后的条目（`changed=false` 时与入参索引里的旧条目等价）。 */
  entry: OpenEntry;
  /** 内容是否变化；`false` 表示不需要写盘/同步。 */
  changed: boolean;
}

/** 漂移种类：缺项 / 多项 / 状态错（开闭不一致或归属日期不一致）。 */
export type OpenDriftKind = 'missing' | 'extra' | 'state';

/** 单条漂移。 */
export interface OpenDriftItem {
  kind: OpenDriftKind;
  id: string;
  /** 期望条目（`extra` 时缺省）。 */
  expected?: OpenEntry;
  /** 实际条目（`missing` 时缺省）。 */
  actual?: OpenEntry;
}

/** `diffIndex` 的结果。 */
export interface OpenIndexDiff {
  /** 是否有漂移（`items.length > 0`）。 */
  drift: boolean;
  /** 漂移条数。 */
  count: number;
  items: OpenDriftItem[];
  /** 期望有、实际没有的 id。 */
  missing: string[];
  /** 实际有、期望没有的 id。 */
  extra: string[];
  /** 两边都有但开闭状态/归属日期不一致的 id。 */
  state: string[];
}

/** 默认对账窗口（最近 N 天分片）：只对最近 30 天重算期望索引，更早的条目原样保留。 */
export const RECONCILE_DAYS: number = 30;

const DATE_KEY_RE: RegExp = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------- 基础工具

/** ts → 毫秒；非法返回 NaN（与 `model/jsonl` 同样只做宽松解析）。 */
function tsMillis(ts: string): number {
  const value = Date.parse(ts);
  return Number.isNaN(value) ? Number.NaN : value;
}

/** ts 比较：可解析时按毫秒，否则按字符串；返回 <0 / 0 / >0。 */
function compareTs(left: string, right: string): number {
  const a = tsMillis(left);
  const b = tsMillis(right);
  if (!Number.isNaN(a) && !Number.isNaN(b)) {
    return a - b;
  }
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

/** 本地日期键（用于窗口起点计算；不依赖 `Intl` / 鸿蒙 API）。 */
function localDateKeyOf(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** 规范化：`closedAt` 为空串视为「未关闭」并丢弃，保证同一状态只有一种写法。 */
function normalizeEntry(entry: OpenEntry): OpenEntry {
  const normalized: OpenEntry = {
    id: entry.id,
    date: entry.date,
    ts: entry.ts,
    openedAt: entry.openedAt
  };
  if (entry.closedAt !== undefined && entry.closedAt.length > 0) {
    normalized.closedAt = entry.closedAt;
  }
  return normalized;
}

/** 校验条目；返回 `null` 表示合法，否则返回中文原因。 */
function describeEntryProblem(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return '条目必须是 JSON 对象';
  }
  const item = value as Record<string, unknown>;
  if (typeof item.id !== 'string' || item.id.trim().length === 0) {
    return '缺少字段 id（非空字符串）';
  }
  if (typeof item.date !== 'string') {
    return '缺少字段 date（字符串）';
  }
  if (item.date.length > 0 && !DATE_KEY_RE.test(item.date)) {
    return '字段 date 必须是 YYYY-MM-DD（或空串表示归属日期未知）';
  }
  if (typeof item.ts !== 'string' || item.ts.length === 0) {
    return '缺少字段 ts（非空字符串）';
  }
  if (typeof item.openedAt !== 'string' || item.openedAt.length === 0) {
    return '缺少字段 openedAt（非空字符串）';
  }
  if (item.closedAt !== undefined && typeof item.closedAt !== 'string') {
    return '字段 closedAt 必须是字符串';
  }
  return null;
}

/** 两条条目是否等价（`closedAt` 缺省与空串等价）。 */
function sameEntry(left: OpenEntry | null, right: OpenEntry | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  if (left.id !== right.id || left.date !== right.date) {
    return false;
  }
  if (left.ts !== right.ts || left.openedAt !== right.openedAt) {
    return false;
  }
  const leftClosed = left.closedAt === undefined ? '' : left.closedAt;
  const rightClosed = right.closedAt === undefined ? '' : right.closedAt;
  return leftClosed === rightClosed;
}

/** 按 ts 稳定升序（ts 相同保持输入顺序）。 */
function sortOpenEntries(entries: OpenEntry[]): OpenEntry[] {
  const list = entries.slice();
  list.sort((left: OpenEntry, right: OpenEntry) => compareTs(left.ts, right.ts));
  return list;
}

// ---------------------------------------------------------------- 编解码

/** 把一条索引条目编码成单行 JSON + `\n`；条目非法时抛错（不把垃圾写进索引）。 */
export function encodeOpenEntry(entry: OpenEntry): string {
  const normalized = normalizeEntry(entry);
  const problem = describeEntryProblem(normalized);
  if (problem !== null) {
    throw new Error(`索引条目不合法：${problem}`);
  }
  return `${JSON.stringify(normalized)}\n`;
}

/** 解析单行；空行、坏 JSON、字段不合法返回 `null`（不抛错）。 */
export function decodeOpenLine(line: string): OpenEntry | null {
  const text = typeof line === 'string' ? line.trim() : '';
  if (text.length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (describeEntryProblem(parsed) !== null) {
    return null;
  }
  return normalizeEntry(parsed as OpenEntry);
}

/**
 * 解析整份索引：跳过空行，坏行不中断，按 1 起行号记入 `errors`。
 * 返回**原始顺序**（未折叠），折叠请再调 `foldOpenByid`。
 */
export function parseOpenIndex(text: string): { entries: OpenEntry[]; errors: OpenIndexLineError[] } {
  const entries: OpenEntry[] = [];
  const errors: OpenIndexLineError[] = [];
  if (typeof text !== 'string' || text.length === 0) {
    return { entries, errors };
  }
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const line = i + 1;
    if (trimmed.length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      errors.push({ line, message: `不是合法 JSON：${reason}` });
      continue;
    }
    const problem = describeEntryProblem(parsed);
    if (problem !== null) {
      errors.push({ line, message: `字段校验失败：${problem}` });
      continue;
    }
    entries.push(normalizeEntry(parsed as OpenEntry));
  }
  return { entries, errors };
}

// ---------------------------------------------------------------- 折叠 / 查询

/**
 * 按 id 折叠：先按 ts 稳定升序，再让后者覆盖前者（同 id 取 ts 较晚条目）。
 * 输出顺序 = 各 id 首次出现的顺序。
 */
export function foldOpenByid(entries: OpenEntry[]): OpenEntry[] {
  const folded = new Map<string, OpenEntry>();
  for (const entry of sortOpenEntries(entries)) {
    folded.set(entry.id, entry);
  }
  return Array.from(folded.values());
}

/** 条目是否仍「未完成」（`closedAt` 缺省或空串）。 */
export function isOpenEntryOpen(entry: OpenEntry): boolean {
  return entry.closedAt === undefined || entry.closedAt.length === 0;
}

/** 在（可能未折叠的）索引里取某 id 的最新条目；没有返回 `null`。 */
export function findOpenEntry(index: OpenEntry[], id: string): OpenEntry | null {
  let latest: OpenEntry | null = null;
  for (const entry of index) {
    if (entry.id !== id) {
      continue;
    }
    if (latest === null || compareTs(entry.ts, latest.ts) >= 0) {
      latest = entry;
    }
  }
  return latest;
}

/** 当前未完成的 id 列表（折叠后按出现顺序，已关闭的不含）。 */
export function openIds(index: OpenEntry[]): string[] {
  const ids: string[] = [];
  for (const entry of foldOpenByid(index)) {
    if (isOpenEntryOpen(entry)) {
      ids.push(entry.id);
    }
  }
  return ids;
}

// ---------------------------------------------------------------- 状态推进

/**
 * 把一条日程记录应用到「该 id 当前条目」上，返回新条目（纯函数，不修改入参）。
 *
 * 规则（幂等：同样的记录再来一次不产生变化）：
 * - 没有旧条目：开新会话；记录本身就是 `done:true` 时同时立即关闭（`openedAt=closedAt=ts`）；
 * - 记录比旧条目更旧（乱序到达）：忽略，保留旧条目；
 * - `done:true`：已关闭则不变（关闭后编辑其它字段不写索引）；未关闭则写 `closedAt=record.ts`；
 * - `done:false`：已关闭 → 重新打开（`openedAt=record.ts`，清 `closedAt`）；
 *   仍开着 → **保留会话开始时间**，只把 `ts` 刷到这条记录（编辑不应重置 openedAt）。
 */
function applyRecordToEntry(previous: OpenEntry | null, record: ScheduleRecord): OpenEntry {
  const recordDate = recordDateKey(record.ts);
  if (previous === null) {
    const entry: OpenEntry = {
      id: record.id,
      date: recordDate,
      ts: record.ts,
      openedAt: record.ts
    };
    if (record.done) {
      entry.closedAt = record.ts;
    }
    return entry;
  }
  if (compareTs(record.ts, previous.ts) < 0) {
    return previous;
  }
  const date = recordDate.length === 10 ? recordDate : previous.date;
  if (record.done) {
    if (!isOpenEntryOpen(previous)) {
      return previous;
    }
    const closed: OpenEntry = {
      id: previous.id,
      date,
      ts: record.ts,
      openedAt: previous.openedAt,
      closedAt: record.ts
    };
    return closed;
  }
  if (!isOpenEntryOpen(previous)) {
    const reopened: OpenEntry = {
      id: previous.id,
      date,
      ts: record.ts,
      openedAt: record.ts
    };
    return reopened;
  }
  const refreshed: OpenEntry = {
    id: previous.id,
    date,
    ts: record.ts,
    openedAt: previous.openedAt
  };
  return refreshed;
}

/**
 * `applyRecordToIndex(index, record)` → `{ entry, changed }`。
 *
 * `changed=false` 表示索引内容与现有条目一致，**不要写盘**（避免无谓追加与同步噪音）。
 */
export function applyRecordToIndex(index: OpenEntry[], record: ScheduleRecord): OpenIndexApplyResult {
  const previous = findOpenEntry(index, record.id);
  const entry = applyRecordToEntry(previous, record);
  return { entry, changed: !sameEntry(previous, entry) };
}

/**
 * 首次全量重建：把一组记录（同一 id 可多条，顺序任意）折叠成当前状态的索引条目。
 *
 * 做法是按 ts 升序逐条应用与增量维护**同一套**规则，因此「重建结果」与「逐条追加维护的结果」
 * 收敛到同一个条目（对账不会因为两条路径规则不同而反复漂移）。
 * 输出顺序 = 各 id 首次出现的顺序。
 */
export function buildIndexFromRecords(records: ScheduleRecord[]): OpenEntry[] {
  const order: string[] = [];
  const grouped = new Map<string, ScheduleRecord[]>();
  for (const record of records) {
    let list = grouped.get(record.id);
    if (list === undefined) {
      list = [];
      grouped.set(record.id, list);
      order.push(record.id);
    }
    list.push(record);
  }
  const result: OpenEntry[] = [];
  for (const id of order) {
    const list = grouped.get(id);
    if (list === undefined) {
      continue;
    }
    const sorted = list.slice();
    sorted.sort((left: ScheduleRecord, right: ScheduleRecord) => compareTs(left.ts, right.ts));
    let current: OpenEntry | null = null;
    for (const record of sorted) {
      current = applyRecordToEntry(current, record);
    }
    if (current !== null) {
      result.push(current);
    }
  }
  return result;
}

// ---------------------------------------------------------------- 对账（自愈）

/**
 * 对账窗口起点（含今天）：`days=30` 且今天 `2026-11-15` → `2026-10-17`。
 * `days` 非法（<1 / NaN）时按 1 天处理。
 */
export function reconcileWindowStart(days: number, today: Date = new Date()): string {
  const span = Number.isFinite(days) && days > 0 ? Math.floor(days) : 1;
  const date = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  date.setDate(date.getDate() - (span - 1));
  return localDateKeyOf(date);
}

/**
 * 条目是否落在对账窗口内（`date >= windowStart`）。
 * `date` 为空的条目（归属日期未知）按窗口内处理：它无法用日期排除，交给 id 比对。
 */
export function isEntryInWindow(entry: OpenEntry, windowStart: string): boolean {
  if (entry.date.length === 0) {
    return true;
  }
  return entry.date >= windowStart;
}

/**
 * 期望索引 = 窗口内记录重建后再按窗口裁剪（窗口外的记录不进期望集）。
 *
 * 只裁剪期望值、**不裁剪**实际索引：窗口外仍可能躺着很早以前创建、至今未完成的条目，
 * 它们不在本次对账范围，重建时必须原样保留（见 `mergeIndexForRebuild`）。
 */
export function expectedIndexForWindow(records: ScheduleRecord[], windowStart: string): OpenEntry[] {
  const rebuilt = buildIndexFromRecords(records);
  const scoped: OpenEntry[] = [];
  for (const entry of rebuilt) {
    if (isEntryInWindow(entry, windowStart)) {
      scoped.push(entry);
    }
  }
  return scoped;
}

/**
 * 漂移检测：期望 vs 实际（两边都会先折叠）。
 *
 * - `missing`：期望有、实际没有 → 索引漏记（首次启动 / 索引文件被判坏后重建）；
 * - `extra`：实际有、期望没有 → 记录已不存在（分片被清理）或索引记录了不该记的 id；
 * - `state`：两边都有但开闭状态或归属日期不一致 → 勾选事件丢了。
 *
 * `drift=false` 时调用方**不得**写盘（避免每次启动都重写索引文件）。
 */
export function diffIndex(expected: OpenEntry[], actual: OpenEntry[]): OpenIndexDiff {
  const wanted = foldOpenByid(expected);
  const applied = foldOpenByid(actual);
  const actualById = new Map<string, OpenEntry>();
  for (const entry of applied) {
    actualById.set(entry.id, entry);
  }
  const items: OpenDriftItem[] = [];
  const missing: string[] = [];
  const state: string[] = [];
  for (const want of wanted) {
    const have = actualById.get(want.id);
    if (have === undefined) {
      missing.push(want.id);
      items.push({ kind: 'missing', id: want.id, expected: want });
      continue;
    }
    actualById.delete(want.id);
    if (isOpenEntryOpen(want) !== isOpenEntryOpen(have) || want.date !== have.date) {
      state.push(want.id);
      items.push({ kind: 'state', id: want.id, expected: want, actual: have });
    }
  }
  const extra: string[] = [];
  actualById.forEach((have: OpenEntry, id: string) => {
    extra.push(id);
    items.push({ kind: 'extra', id, actual: have });
  });
  return { drift: items.length > 0, count: items.length, items, missing, extra, state };
}

/**
 * 重建时的合并：窗口内以期望为准（覆盖/新增/丢弃多余），窗口外的实际条目原样保留。
 *
 * 结果按 ts 升序去重后写回，因此重建后的文件是**紧凑的当前状态**（每个 id 一行），
 * 而不是继续堆历史行。
 */
export function mergeIndexForRebuild(expected: OpenEntry[], actual: OpenEntry[], windowStart: string): OpenEntry[] {
  const merged = new Map<string, OpenEntry>();
  for (const entry of foldOpenByid(actual)) {
    if (!isEntryInWindow(entry, windowStart)) {
      merged.set(entry.id, entry);
    }
  }
  for (const entry of foldOpenByid(expected)) {
    merged.set(entry.id, entry);
  }
  return sortOpenEntries(Array.from(merged.values()));
}

// ---------------------------------------------------------------- 跨设备合并

/** 一台设备的索引快照（`deviceId` + 原始条目，可以是文件读出来的，也可以是内存重建的）。 */
export interface DeviceOpenIndex {
  deviceId: string;
  entries: OpenEntry[];
}

/** 跨设备合并后的一条待办：条目 + 它所属的设备目录（记录要去这个目录里取）。 */
export interface MergedOpenEntry {
  deviceId: string;
  entry: OpenEntry;
}

/**
 * 跨设备合并「未完成」：
 * - 每台设备先各自折叠（同设备同 id 取 ts 较晚者），只保留仍未完成的；
 * - 不同设备的目录互不重叠，同 id 理论上不会重复；真重复（手工拷贝目录）时取 ts 较晚的一条，
 *   因此**输出无重复 id**；
 * - 排序稳定：ts 升序 → deviceId → id，同一输入任意次数结果一致（列表不抖）。
 *
 * 注意：这里只做内存合并，不落盘 —— 其他设备的 `open.jsonl` 属于别人的目录（契约：每台设备只写
 * 自己的目录），缺失时调用方用 `buildIndexFromRecords()` 在内存里重建即可。
 */
export function mergeDeviceIndexes(indexes: DeviceOpenIndex[]): MergedOpenEntry[] {
  const byId = new Map<string, MergedOpenEntry>();
  for (const device of indexes) {
    for (const entry of foldOpenByid(device.entries)) {
      if (!isOpenEntryOpen(entry)) {
        continue;
      }
      const existing = byId.get(entry.id);
      if (existing === undefined || compareTs(entry.ts, existing.entry.ts) > 0) {
        byId.set(entry.id, { deviceId: device.deviceId, entry: entry });
      }
    }
  }
  const merged = Array.from(byId.values());
  merged.sort((left: MergedOpenEntry, right: MergedOpenEntry) => {
    const delta = compareTs(left.entry.ts, right.entry.ts);
    if (delta !== 0) {
      return delta;
    }
    if (left.deviceId !== right.deviceId) {
      return left.deviceId < right.deviceId ? -1 : 1;
    }
    if (left.entry.id === right.entry.id) {
      return 0;
    }
    return left.entry.id < right.entry.id ? -1 : 1;
  });
  return merged;
}

