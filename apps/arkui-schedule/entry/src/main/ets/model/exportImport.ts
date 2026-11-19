/**
 * 导出 / 导入的纯逻辑（**零 SDK import**，`tools/tsconfig.json` 可直接编到 `tools/.build/` 由 Node 跑）。
 *
 * 契约：`docs/EXPORT-IMPORT.md`（本文件的规格来源）与 `docs/DATA-CONTRACT.md` §3 / §4bis。
 * 三条硬约束：
 * 1. **导出是只读派生**：只读 `ScheduleRecord[]`、只产出文本，不碰任何源文件；
 * 2. **导入是 append-only**：本文件算「计划」（`ImportPlan`）+ 写盘前的**幂等复核**
 *    （`reconcileBeforeAppend`）+ 落盘的**纯实现**（`writePlan`，IO 由 `services/exportService.ets`
 *    注入真实文件系统）；绝不重写历史行、绝不写别的设备目录；
 * 3. **绝不覆盖**：同 `id` 且 incoming 的 `ts` 更新时只计入 `conflict`（不追加、不改既有行），
 *    让「谁更新」这件事被人看见，而不是被静默丢弃或静默覆盖。
 *
 * 纯逻辑纪律（与 `model/calendar.ts` / `model/jsonl.ts` 一致）：
 * - 不 import `@ohos.*` / `@kit.*` / `$r()` / 页面组件，也不 `import` services（模型层必须能在 Node 跑）；
 * - 不写对象展开（ArkTS `arkts-no-spread`）；对象字面量一律先声明具名接口类型的 `const`；
 * - 非法输入**不抛异常**（返回 `ok:false` / `invalid` / 兜底值）；
 *   只有「导出区间非法 / 缺 deviceId」这类**调用方编程错误**才抛中文 Error（区间必须先过 `parseDateRange`）。
 */
import { localDateKey } from '../common/date';
import { formatDateKey, monthGrid, parseDateKey } from './calendar';
import { encodeRecord, recordDateKey, sortRecords } from './jsonl';
import type { Attachment, ScheduleRecord } from './types';
import { buildRecordsText } from './timelineWrite';
import { parseTimelineDay } from './timeline';
import type { TimelineMedia, TimelineRecord } from './timeline';
import { sha256Hex } from './sha256';

/** 导出格式：Markdown。 */
export const EXPORT_FORMAT_MARKDOWN: string = 'markdown';
/** 导出格式：JSON。 */
export const EXPORT_FORMAT_JSON: string = 'json';
/**
 * JSON 导出文件的版本号。
 * **只认 1**：不认识就 fail-closed（`ok:false`），绝不「猜着导入」——猜错就是往历史日志里写脏行。
 */
export const EXPORT_VERSION: number = 1;
/** 空区间 Markdown 的占位行（逐字，测试钉住）。 */
export const EMPTY_RANGE_TEXT: string = '（该区间没有记录）';
/** 无附件时附件清单的占位行（逐字）。 */
export const NO_ATTACHMENT_TEXT: string = '（无附件）';
/** 空标题的兜底（避免出现 `- [ ] 　\`id=…\`` 这种空心行）。 */
export const UNTITLED_TEXT: string = '（无标题）';
/** 没有可导入记录时的提示（逐字）。 */
export const NO_IMPORTABLE_TEXT: string = '没有可导入的记录';
/** Markdown 导出里每条记录附带的 `id=` 引用（便于人肉回溯到原始 JSONL 行）。 */
const ID_TAG_PREFIX: string = '`id=';
/** 记录行里标题与 id 之间的分隔（全角空格，避免与标题里的半角空格混淆）。 */
const ID_TAG_SEPARATOR: string = '　';

/** 日期区间（`YYYY-MM-DD`，含首尾）。 */
export interface ExportRange {
  from: string;
  to: string;
}

/** `parseDateRange` 的结果（失败时 `from`/`to` 为空串，`reason` 为中文原因）。 */
export interface DateRangeResult {
  ok: boolean;
  from: string;
  to: string;
  reason: string;
}

/** Markdown 导出入参。 */
export interface MarkdownExportInput {
  /** 起始日期 `YYYY-MM-DD`（含）。 */
  from: string;
  /** 结束日期 `YYYY-MM-DD`（含）。 */
  to: string;
  /** 待导出的记录（调用方通常传 `foldById` 折叠后的列表）。 */
  records: ScheduleRecord[];
  /** 是否在文末追加「## 附件清单」（默认 false）。 */
  includeAttachments?: boolean;
  /** 是否在每条后追加缩进元信息行（默认 false）。 */
  includeMeta?: boolean;
}

/** JSON 导出入参。 */
export interface JsonExportInput {
  from: string;
  to: string;
  /** 导出方设备标识（写进文件，便于对方知道来源）。 */
  deviceId: string;
  records: ScheduleRecord[];
  /** 导出时刻（ISO 8601）；缺省取当前时间，测试可显式传入以获得确定性。 */
  exportedAt?: string;
}

/** JSON 导出文档（`buildJsonExport` 的产物结构，字段名即契约）。 */
export interface JsonExportDocument {
  version: number;
  exportedAt: string;
  range: ExportRange;
  deviceId: string;
  records: ScheduleRecord[];
}

/** `exportFileStamp` 入参。 */
export interface ExportStampInput {
  /** 本次导出的记录（时间戳取其中 `ts` 最新的一条）。 */
  records: ScheduleRecord[];
  /** 兜底时间（ISO 8601）：区间内没有合法 `ts` 时用它。 */
  now: string;
}

/** 一条非法导入记录的定位信息。 */
export interface InvalidImportItem {
  /** 在 `incoming` 里的下标（0 起，便于人回到文件里找第几条）。 */
  index: number;
  /** 中文原因（来自 `importRecordProblem`）。 */
  reason: string;
}

/** 一条冲突记录（同 id、incoming 更新，**不会覆盖**，只报告）。 */
export interface ImportConflictItem {
  /** 在 `incoming` 里的下标。 */
  index: number;
  id: string;
  /** 导入文件里的 `ts`（较新，因此被拒）。 */
  incomingTs: string;
  /** 本机已有的最新 `ts`。 */
  existingTs: string;
}

/** 导入计划（dry-run 结果；`toAppend` 只含 `added`）。 */
export interface ImportPlan {
  added: number;
  skipped: number;
  conflict: number;
  invalid: number;
  /** 真正要追加的记录：**保序**（incoming 顺序），服务层按日期分组后再按 `ts` 排序落盘。 */
  toAppend: ScheduleRecord[];
  invalidItems: InvalidImportItem[];
  conflictItems: ImportConflictItem[];
  /** 计划生成时刻（ISO 8601；用于日志/展示，不参与判定）。 */
  plannedAt: string;
}

/** `planImport` 入参。 */
export interface PlanImportInput {
  /** 本机已折叠的记录（`scheduleStore.readAll()`）。 */
  existing: ScheduleRecord[];
  /** 导入文件里的记录（顺序即文件顺序）。 */
  incoming: ScheduleRecord[];
  /** 当前时刻（ISO 8601）；缺省取 `new Date().toISOString()`。 */
  now?: string;
}

/** `parseJsonImport` 的结果（失败时 `records` 为空数组，fail-closed）。 */
export interface JsonImportResult {
  ok: boolean;
  records: ScheduleRecord[];
  reason: string;
  /** 文件里的区间（缺省空串；仅用于展示，不参与导入判定）。 */
  from: string;
  to: string;
  /** 文件里的导出方设备（缺省空串；仅用于展示）。 */
  deviceId: string;
  /** 文件里的导出时刻（缺省空串）。 */
  exportedAt: string;
}

/**
 * 设置页导出/导入面板的展示状态（纯数据，无观察者）。
 *
 * 组件（`components/ExportImportPanel.ets`）只读它渲染；区间/格式/开关这几项由组件本地
 * `@State` 承接用户输入并通过 `ExportRequest` 回传给页面——页面的这份 state 只负责
 * 「最近一次结果」与错误文案，避免 UI 与 IO 互相倒灌。
 */
export interface ExportImportState {
  fromText: string;
  toText: string;
  format: string;
  includeAttachments: boolean;
  includeMeta: boolean;
  /** 已选中的导入文件名（空串 = 还没选）。 */
  importFileName: string;
  /** 是否已有一次 dry-run 结果（false 时统计行不渲染）。 */
  dryRunReady: boolean;
  dryRunAdded: number;
  dryRunSkipped: number;
  dryRunConflict: number;
  dryRunInvalid: number;
  /** 最近一次导出的可读绝对路径（空串 = 还没导出）。 */
  exportPath: string;
  /** 错误 / 提示文案（空串 = 无）。 */
  message: string;
  /** 正在导出/导入（true 时按钮禁用、不重复触发）。 */
  busy: boolean;
}

/** 组件回传给页面的导出请求（用户当前选的区间/格式/开关）。 */
export interface ExportRequest {
  fromText: string;
  toText: string;
  format: string;
  includeAttachments: boolean;
  includeMeta: boolean;
}

/** 空结果的 `DateRangeResult`。 */
function dateRangeFailure(reason: string): DateRangeResult {
  const result: DateRangeResult = { ok: false, from: '', to: '', reason: reason };
  return result;
}

/** 空结果的 `JsonImportResult`（fail-closed：`records` 一定为空）。 */
function jsonImportFailure(reason: string): JsonImportResult {
  const result: JsonImportResult = {
    ok: false,
    records: [],
    reason: reason,
    from: '',
    to: '',
    deviceId: '',
    exportedAt: ''
  };
  return result;
}

/** 把异常/未知值转成可展示文本。 */
function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/** 截断过长的用户输入，避免错误提示里塞进整段文件内容。 */
function clip(text: string, limit: number = 32): string {
  const value = typeof text === 'string' ? text : '';
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

/**
 * 严格校验日期区间（含首尾）。
 *
 * - 两端都必须是**真实存在**的 `YYYY-MM-DD`（`2026-02-30` / `2026-13-01` / `2026-1-1` 全部拒绝）；
 * - `from > to` 报错（空区间没有意义，宁可让用户改，也不导出一份自相矛盾的文件）；
 * - 首尾空白会被 trim 后再判；失败返回 `ok:false` + 中文 `reason`，**不抛异常**。
 */
export function parseDateRange(fromText: string, toText: string): DateRangeResult {
  const fromRaw = typeof fromText === 'string' ? fromText.trim() : '';
  const toRaw = typeof toText === 'string' ? toText.trim() : '';
  if (fromRaw.length === 0) {
    return dateRangeFailure('请先填写开始日期（YYYY-MM-DD）');
  }
  if (toRaw.length === 0) {
    return dateRangeFailure('请先填写结束日期（YYYY-MM-DD）');
  }
  const fromParts = parseDateKey(fromRaw);
  if (fromParts === null) {
    return dateRangeFailure(`开始日期不是合法日期（要 YYYY-MM-DD，且必须是真实存在的日期）：${clip(fromRaw)}`);
  }
  const toParts = parseDateKey(toRaw);
  if (toParts === null) {
    return dateRangeFailure(`结束日期不是合法日期（要 YYYY-MM-DD，且必须是真实存在的日期）：${clip(toRaw)}`);
  }
  const from = formatDateKey(fromParts.year, fromParts.month, fromParts.day);
  const to = formatDateKey(toParts.year, toParts.month, toParts.day);
  if (from > to) {
    return dateRangeFailure(`开始日期不能晚于结束日期（${from} > ${to}）`);
  }
  const result: DateRangeResult = { ok: true, from: from, to: to, reason: '' };
  return result;
}

/**
 * 取导出区间（非法即抛中文 Error）。
 *
 * 为什么这里抛而 `parseDateRange` 不抛：`parseDateRange` 是给 UI 的校验入口（要展示原因），
 * `renderMarkdownExport` / `buildJsonExport` 是「已经校验过」的渲染入口；渲染阶段再拿到非法区间
 * 说明调用方跳过了校验，此时静默产出半份文件比报错更危险。
 */
function requireRange(from: string, to: string): ExportRange {
  const checked = parseDateRange(from, to);
  if (!checked.ok) {
    throw new Error(`导出区间非法：${checked.reason}`);
  }
  const range: ExportRange = { from: checked.from, to: checked.to };
  return range;
}

/** `ts` → 记录归属日期（`YYYY-MM-DD`；推不出返回空串）。 */
function dateKeyOf(record: ScheduleRecord): string {
  if (record === null || record === undefined) {
    return '';
  }
  const ts = typeof record.ts === 'string' ? record.ts : '';
  if (ts.length === 0) {
    return '';
  }
  return recordDateKey(ts);
}

/** `ts` → 时刻文本 `HH:MM`（`2026-11-03` 这类只有日期的 `ts` 返回空串 = 不写时间）。 */
function clockOf(record: ScheduleRecord): string {
  const ts = typeof record.ts === 'string' ? record.ts : '';
  const matched = /^\d{4}-\d{2}-\d{2}[T ](\d{2}):(\d{2})/.exec(ts);
  if (matched === null) {
    return '';
  }
  return `${matched[1]}:${matched[2]}`;
}

/** 标题渲染文本：换行压成空格、去首尾空白、空标题给兜底。 */
function titleOf(record: ScheduleRecord): string {
  const raw = typeof record.title === 'string' ? record.title : '';
  const flat = raw.replace(/\r?\n/g, ' ').trim();
  return flat.length === 0 ? UNTITLED_TEXT : flat;
}

/** 日期对应的星期后缀（形如 `（周二）`；推不出返回空串）。 */
function weekdaySuffix(dateKey: string): string {
  const parts = parseDateKey(dateKey);
  if (parts === null) {
    return '';
  }
  const names: string[] = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  // 复用 `monthGrid` 的星期计算：日历模块用纯整数算法（不碰 Date / 时区），
  // 这里只从 6×7 网格里取出该日期的 weekday，避免在导出模块里再抄一份 civil-from-days。
  const grid = monthGrid(parts.year, parts.month, 1, '');
  for (const week of grid.weeks) {
    for (const cell of week) {
      if (cell.dateKey === dateKey) {
        return `（${names[cell.weekday]}）`;
      }
    }
  }
  return '';
}

/** 稳定升序：先按记录日期，再按 `ts`（同一日期内时刻早的在前，相同则保持输入顺序）。 */
function sortByDateThenTs(records: ScheduleRecord[]): ScheduleRecord[] {
  const list: ScheduleRecord[] = [];
  for (const record of records) {
    list.push(record);
  }
  list.sort((left, right) => {
    const leftDate = dateKeyOf(left);
    const rightDate = dateKeyOf(right);
    if (leftDate !== rightDate) {
      return leftDate < rightDate ? -1 : 1;
    }
    const leftMs = Date.parse(left.ts);
    const rightMs = Date.parse(right.ts);
    if (!Number.isNaN(leftMs) && !Number.isNaN(rightMs) && leftMs !== rightMs) {
      return leftMs - rightMs;
    }
    if (left.ts === right.ts) {
      return 0;
    }
    return left.ts < right.ts ? -1 : 1;
  });
  return list;
}

/**
 * 选出区间内（含首尾）的记录，按 `(date, ts)` 升序返回**新数组**。
 *
 * - 日期推不出 / 不是真实日期的记录直接排除（导出宁可少一条，也不产出 `## 2026-02-30` 这种假日期）；
 * - 不折叠 id：调用方应传 `foldById` 之后的列表（`scheduleStore.readAll()` 已折叠）。
 */
export function exportRecordsInRange(records: ScheduleRecord[], from: string, to: string): ScheduleRecord[] {
  const list: ScheduleRecord[] = [];
  if (!Array.isArray(records)) {
    return list;
  }
  for (const record of records) {
    const dateKey = dateKeyOf(record);
    if (parseDateKey(dateKey) === null) {
      continue;
    }
    if (dateKey < from || dateKey > to) {
      continue;
    }
    list.push(record);
  }
  return sortByDateThenTs(list);
}

/** 一条记录行的 Markdown 文本（`- [ ] 09:30 标题　\`id=…\``）。 */
function renderRecordLine(record: ScheduleRecord): string {
  const box = record.done === true ? '[x]' : '[ ]';
  const clock = clockOf(record);
  const title = titleOf(record);
  const id = typeof record.id === 'string' ? record.id : '';
  const head = clock.length > 0 ? `${box} ${clock} ${title}` : `${box} ${title}`;
  return `- ${head}${ID_TAG_SEPARATOR}${ID_TAG_PREFIX}${id}\``;
}

/** 记录上的扩展 `tags` 字段（`string[]` 或 `string`；没有/非法返回空串）。 */
function tagsText(record: ScheduleRecord): string {
  const source = record as unknown as Record<string, unknown>;
  const raw = source.tags;
  if (typeof raw === 'string') {
    return raw.trim();
  }
  if (Array.isArray(raw)) {
    const parts: string[] = [];
    for (const item of raw) {
      if (typeof item === 'string' && item.trim().length > 0) {
        parts.push(item.trim());
      }
    }
    return parts.join(',');
  }
  return '';
}

/** 记录上的「来源设备」扩展字段（`device` / `sourceDevice` / `deviceId` 取第一个非空）。 */
function sourceDeviceText(record: ScheduleRecord): string {
  const source = record as unknown as Record<string, unknown>;
  const keys: string[] = ['device', 'sourceDevice', 'deviceId'];
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return '';
}

/**
 * 元信息行（`  > tags=… · author=… · 来源设备=…`）。
 *
 * 三个字段都存在才成行；`tags` 与「来源设备」不是 `ScheduleRecord` 的必填字段
 * （`docs/DATA-CONTRACT.md` §3 的表格里没有），因此**有才写、没有就不猜**。
 */
function renderMetaLine(record: ScheduleRecord): string {
  const parts: string[] = [];
  const tags = tagsText(record);
  if (tags.length > 0) {
    parts.push(`tags=${tags}`);
  }
  const author = typeof record.author === 'string' ? record.author.trim() : '';
  if (author.length > 0) {
    parts.push(`author=${author}`);
  }
  const device = sourceDeviceText(record);
  if (device.length > 0) {
    parts.push(`来源设备=${device}`);
  }
  if (parts.length === 0) {
    return '';
  }
  return `  > ${parts.join(' · ')}`;
}

/** 附件清单行（`- 2026-11-03 · 09:30 · 写周报 · 图片.png · 第 1 页 · entry=… · bytes=…`）。 */
function renderAttachmentLine(record: ScheduleRecord, item: Attachment): string {
  const parts: string[] = [`- ${dateKeyOf(record)}`];
  const clock = clockOf(record);
  if (clock.length > 0) {
    parts.push(clock);
  }
  parts.push(titleOf(record));
  const name = typeof item.name === 'string' ? item.name : '';
  parts.push(name.length > 0 ? name : '（未命名附件）');
  if (typeof item.pageIndex === 'number' && Number.isFinite(item.pageIndex) && item.pageIndex >= 0) {
    parts.push(`第 ${item.pageIndex + 1} 页`);
  }
  if (typeof item.entry === 'string' && item.entry.length > 0) {
    parts.push(`entry=${item.entry}`);
  }
  // `bytes` 不是 `Attachment` 的契约字段（§3 只有 sha256/name/pageIndex[/archive/entry]）：
  // 只有数据里真的带了数字才写，避免导出里出现「bytes=undefined」。
  const bytes = (item as unknown as Record<string, unknown>).bytes;
  if (typeof bytes === 'number' && Number.isFinite(bytes)) {
    parts.push(`bytes=${bytes}`);
  }
  return parts.join(' · ');
}

/** 全部附件行（顺序 = 记录顺序 × 附件顺序）。 */
function renderAttachmentLines(records: ScheduleRecord[]): string[] {
  const lines: string[] = [];
  for (const record of records) {
    const items = record.attachments;
    if (items === undefined || items.length === 0) {
      continue;
    }
    for (const item of items) {
      lines.push(renderAttachmentLine(record, item));
    }
  }
  return lines;
}

/**
 * 渲染 Markdown 导出（纯函数，不写盘）。
 *
 * 形态（逐字契约见 `docs/EXPORT-IMPORT.md` §2）：
 * ```
 * # 日程导出 2026-11-01 ~ 2026-11-30
 *
 * ## 2026-11-03（周二）
 * - [ ] 09:30 写周报　`id=abc123`
 * - [x] 14:00 体检　`id=def456`
 * ```
 * - 已完成 `[x]`、未完成 `[ ]`；`done` 只由复选框表达，**不再追加「（已完成）」**（不重复）；
 * - 有 `HH:MM` 才写时间（`ts` 只有日期就不写）；
 * - 日期升序、同日按 `ts` 升序；空区间也产出文件（只有标题 + `（该区间没有记录）`）；
 * - `includeAttachments` / `includeMeta` 默认 false。
 *
 * 区间非法时抛中文 Error（见 `requireRange` 的注释）。
 */
export function renderMarkdownExport(input: MarkdownExportInput): string {
  const range = requireRange(input.from, input.to);
  const includeAttachments = input.includeAttachments === true;
  const includeMeta = input.includeMeta === true;
  const records = exportRecordsInRange(input.records, range.from, range.to);
  const lines: string[] = [];
  lines.push(`# 日程导出 ${range.from} ~ ${range.to}`);
  if (records.length === 0) {
    lines.push(EMPTY_RANGE_TEXT);
  } else {
    let currentDate = '';
    for (const record of records) {
      const dateKey = dateKeyOf(record);
      if (dateKey !== currentDate) {
        currentDate = dateKey;
        lines.push('');
        lines.push(`## ${dateKey}${weekdaySuffix(dateKey)}`);
      }
      lines.push(renderRecordLine(record));
      if (includeMeta) {
        const meta = renderMetaLine(record);
        if (meta.length > 0) {
          lines.push(meta);
        }
      }
    }
  }
  if (includeAttachments) {
    lines.push('');
    lines.push('## 附件清单');
    const attachmentLines = renderAttachmentLines(records);
    if (attachmentLines.length === 0) {
      lines.push(NO_ATTACHMENT_TEXT);
    } else {
      for (const line of attachmentLines) {
        lines.push(line);
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * 构造 JSON 导出文本（纯函数，不写盘）。
 *
 * - 顶层固定 `{version:1, exportedAt, range:{from,to}, deviceId, records}`；
 * - `records` 按 `(date, ts)` 升序，**字段原样保留**（不裁剪、不改名、不补默认值），
 *   因此 `parseJsonImport` + `planImport` 能把它原样吃回；
 * - 2 空格缩进 + 末尾一个换行（人能读、diff 稳定）。
 *
 * 区间非法或缺 `deviceId` 时抛中文 Error（缺失设备标识的导出文件没有来源，不接受）。
 */
export function buildJsonExport(input: JsonExportInput): string {
  const range = requireRange(input.from, input.to);
  const deviceId = typeof input.deviceId === 'string' ? input.deviceId.trim() : '';
  if (deviceId.length === 0) {
    throw new Error('导出缺少设备标识（deviceId 不能为空）');
  }
  const exportedAtRaw = typeof input.exportedAt === 'string' ? input.exportedAt.trim() : '';
  const exportedAt = exportedAtRaw.length > 0 ? exportedAtRaw : new Date().toISOString();
  const records = exportRecordsInRange(input.records, range.from, range.to);
  const doc: JsonExportDocument = {
    version: EXPORT_VERSION,
    exportedAt: exportedAt,
    range: range,
    deviceId: deviceId,
    records: records
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** ISO 文本 → 文件名时间戳 `YYYYMMDD-HHmm`（取文本自带的数字，不做时区换算；推不出返回空串）。 */
function stampOfText(text: string): string {
  const value = typeof text === 'string' ? text.trim() : '';
  const matched = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(value);
  if (matched === null) {
    return '';
  }
  return `${matched[1]}${matched[2]}${matched[3]}-${matched[4]}${matched[5]}`;
}

/**
 * 导出文件名的时间戳：取 `records` 里 `ts` **最新**的一条（同样是「记录自带时区」的取法，
 * 不做本机时区换算）；区间内没有可用 `ts` 时退回 `now`。
 *
 * 为什么不用随机数/当前时间：同一份数据重复导出应得到同一个文件名，便于对比与去重；
 * 真要用当前时间也该由调用方显式传 `now`，测试才能确定。
 */
export function exportFileStamp(input: ExportStampInput): string {
  const records = Array.isArray(input.records) ? input.records : [];
  let latestMs = Number.NaN;
  let latestText = '';
  for (const record of records) {
    const ts = typeof record.ts === 'string' ? record.ts : '';
    const ms = Date.parse(ts);
    if (Number.isNaN(ms)) {
      continue;
    }
    if (Number.isNaN(latestMs) || ms > latestMs) {
      latestMs = ms;
      latestText = ts;
    }
  }
  if (latestText.length > 0) {
    const fromRecord = stampOfText(latestText);
    if (fromRecord.length > 0) {
      return fromRecord;
    }
  }
  return stampOfText(input.now);
}

/** 导出文件名：`schedule-<stamp>.<md|json>`（格式未知按 Markdown，时间戳为空用零值占位）。 */
export function exportFileName(format: string, stamp: string): string {
  const normalized = normalizeExportFormat(format);
  const suffix = normalized === EXPORT_FORMAT_JSON ? 'json' : 'md';
  const safeStamp = typeof stamp === 'string' && stamp.length > 0 ? stamp : '00000000-0000';
  return `schedule-${safeStamp}.${suffix}`;
}

/** 归一化导出格式（未知值回落 Markdown：它是人能直接读的那一种）。 */
export function normalizeExportFormat(format: string): string {
  return format === EXPORT_FORMAT_JSON ? EXPORT_FORMAT_JSON : EXPORT_FORMAT_MARKDOWN;
}

/**
 * 校验一条「导入记录」是否符合 `docs/DATA-CONTRACT.md` §3 的记录契约。
 *
 * 返回空串 = 合法；否则返回中文原因（用于 `invalid` 列表与「先修正文件」提示）。
 *
 * 复用 `jsonl.encodeRecord` 作为**唯一字段校验源**：id / ts / title / body / author / done /
 * ai_processed / ocr_* / attachments 的规则不许在导出导入里再抄一份，抄一份就必然漂移。
 * 在此之上补两条导出导入特有的检查：
 * 1. 若带扩展字段 `date`，它必须是**真实存在**的 `YYYY-MM-DD`（`2026-02-30` 这类假日期必拒）；
 * 2. `ts` 必须能推出真实日期（否则落盘时不知道该追加到哪个 `YYYY-MM-DD.jsonl`）。
 */
export function importRecordProblem(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return '记录必须是 JSON 对象';
  }
  const record = value as ScheduleRecord;
  try {
    encodeRecord(record);
  } catch (error) {
    return describe(error);
  }
  const source = value as Record<string, unknown>;
  const dateField = source.date;
  if (dateField !== undefined) {
    if (typeof dateField !== 'string' || parseDateKey(dateField) === null) {
      return `字段 date 不是合法日期（YYYY-MM-DD，且必须真实存在）：${clip(String(dateField))}`;
    }
  }
  const dateKey = dateKeyOf(record);
  if (parseDateKey(dateKey) === null) {
    return `字段 ts 推不出合法日期（要 ISO 8601，如 2026-11-03T09:30:00+08:00）：${clip(
      typeof record.ts === 'string' ? record.ts : ''
    )}`;
  }
  return '';
}

/** `candidate` 是否严格晚于 `baseline`（都能解析按毫秒比，否则按字符串比）。 */
function isTsAfter(candidate: string, baseline: string): boolean {
  const left = Date.parse(candidate);
  const right = Date.parse(baseline);
  if (!Number.isNaN(left) && !Number.isNaN(right)) {
    return left > right;
  }
  return candidate > baseline;
}

/** 规范化 `now`（非法/缺省取当前时间）。 */
function normalizeNow(now: string | undefined): string {
  if (typeof now === 'string' && now.trim().length > 0) {
    return now.trim();
  }
  return new Date().toISOString();
}

/**
 * 计算导入计划（dry-run）：**只算，不写**。
 *
 * 归属规则（`docs/EXPORT-IMPORT.md` §3.2）：
 * | 情形 | 归属 | 落盘 |
 * | --- | --- | --- |
 * | 新 id | `added` | ✅ 进 `toAppend` |
 * | 同 id，incoming `ts` 更新 | `conflict` | ❌ **不覆盖**，只报告 |
 * | 同 id，incoming `ts` 更旧或相同 | `skipped` | ❌ |
 * | 字段非法 | `invalid` | ❌（带 index + 原因） |
 *
 * 两个补充细节：
 * - `existing` 里同一 id 可能有多条历史行，比较基准取其中**最新**的 `ts`（即 `foldById` 的结果）；
 * - 同一批 incoming 里重复出现同一个新 id 时，先到的按 `added` 接收，后到的按上面的规则
 *   归入 `conflict`（更新）或 `skipped`（更旧/相同）——绝不让同一 id 在同一批里出现两次追加。
 *
 * `toAppend` **保持 incoming 顺序**（服务层再按日期分组、组内按 `ts` 排序后一次追加）。
 */
export function planImport(input: PlanImportInput): ImportPlan {
  const existing: ScheduleRecord[] = Array.isArray(input.existing) ? input.existing : [];
  const incoming: ScheduleRecord[] = Array.isArray(input.incoming) ? input.incoming : [];
  const latestTs = new Map<string, string>();
  for (const record of existing) {
    if (record === null || record === undefined) {
      continue;
    }
    const id = typeof record.id === 'string' ? record.id : '';
    if (id.length === 0) {
      continue;
    }
    const ts = typeof record.ts === 'string' ? record.ts : '';
    const known = latestTs.get(id);
    if (known === undefined || isTsAfter(ts, known)) {
      latestTs.set(id, ts);
    }
  }

  const toAppend: ScheduleRecord[] = [];
  const invalidItems: InvalidImportItem[] = [];
  const conflictItems: ImportConflictItem[] = [];
  const acceptedTs = new Map<string, string>();
  let skipped = 0;

  for (let index = 0; index < incoming.length; index++) {
    const raw: unknown = incoming[index];
    const problem = importRecordProblem(raw);
    if (problem.length > 0) {
      const invalidItem: InvalidImportItem = { index: index, reason: problem };
      invalidItems.push(invalidItem);
      continue;
    }
    const record = raw as ScheduleRecord;
    const id = record.id;
    const ts = record.ts;
    const known = latestTs.get(id);
    if (known !== undefined) {
      if (isTsAfter(ts, known)) {
        const conflictItem: ImportConflictItem = {
          index: index,
          id: id,
          incomingTs: ts,
          existingTs: known
        };
        conflictItems.push(conflictItem);
      } else {
        skipped += 1;
      }
      continue;
    }
    const accepted = acceptedTs.get(id);
    if (accepted !== undefined) {
      if (isTsAfter(ts, accepted)) {
        const conflictItem: ImportConflictItem = {
          index: index,
          id: id,
          incomingTs: ts,
          existingTs: accepted
        };
        conflictItems.push(conflictItem);
      } else {
        skipped += 1;
      }
      continue;
    }
    acceptedTs.set(id, ts);
    toAppend.push(record);
  }

  const plan: ImportPlan = {
    added: toAppend.length,
    skipped: skipped,
    conflict: conflictItems.length,
    invalid: invalidItems.length,
    toAppend: toAppend,
    invalidItems: invalidItems,
    conflictItems: conflictItems,
    plannedAt: normalizeNow(input.now)
  };
  return plan;
}

/** `reconcileBeforeAppend` 的结果（写盘前复核后的归属）。 */
export interface ReconcileResult {
  /** 复核后确实还应当追加的记录（保持传入顺序，**只有它会被写**）。 */
  added: ScheduleRecord[];
  /** 同 id 且「更旧或相同」而不再追加的条数。 */
  skipped: number;
  /** 同 id 且「导入版本更新、本机版本较旧」的条数（仍**绝不覆盖**）。 */
  conflict: number;
}

/**
 * 写盘前的**幂等复核**（`docs/EXPORT-IMPORT.md` §3.3 第 2 道闸）。
 *
 * 为什么需要它：dry-run（`planImport`）与用户点「确认导入」之间可能隔着任意长时间——
 * 期间本机可能被别的页面、另一次导入、或另一台设备经 Git 同步写入了同一个 `id`。
 * 光靠「确认时重用用户看过的那份计划」只能保证**统计与用户看到的一致**，不能保证
 * 「同一个 id 不被追加两次」。所以落盘前必须用**此刻**的 `existingNow` 再判一次。
 *
 * 判定规则与 `planImport` 完全一致（同一个 `isTsAfter`）：
 * | 情形 | 归属 |
 * | --- | --- |
 * | 本机没有这个 `id` | `added`（进 `added` 数组） |
 * | 同 `id`，planned 的 `ts` 更新 | `conflict`（不追加、不覆盖） |
 * | 同 `id`，planned 的 `ts` 更旧或相同 | `skipped`（重复导入 / 双击就会落到这里） |
 *
 * 另外：`planned` 内部重复的 `id` 也只放行第一次（与 `planImport` 的 `acceptedTs` 同构），
 * 因此「复核」本身也是幂等的——连续两次调用，第二次的 `added` 必为空。
 * 非法/空 `id` 一律算 `skipped`：复核不做字段校验（那是 `planImport` 的职责），只保证**不写脏主键**。
 */
export function reconcileBeforeAppend(
  planned: ScheduleRecord[],
  existingNow: ScheduleRecord[]
): ReconcileResult {
  const plannedList: ScheduleRecord[] = Array.isArray(planned) ? planned : [];
  const existing: ScheduleRecord[] = Array.isArray(existingNow) ? existingNow : [];
  const latestTs = new Map<string, string>();
  for (const record of existing) {
    if (record === null || record === undefined) {
      continue;
    }
    const id = typeof record.id === 'string' ? record.id : '';
    if (id.length === 0) {
      continue;
    }
    const ts = typeof record.ts === 'string' ? record.ts : '';
    const known = latestTs.get(id);
    if (known === undefined || isTsAfter(ts, known)) {
      latestTs.set(id, ts);
    }
  }

  const added: ScheduleRecord[] = [];
  const acceptedTs = new Map<string, string>();
  let skipped = 0;
  let conflict = 0;
  for (const record of plannedList) {
    if (record === null || record === undefined) {
      skipped += 1;
      continue;
    }
    const id = typeof record.id === 'string' ? record.id : '';
    const ts = typeof record.ts === 'string' ? record.ts : '';
    if (id.length === 0) {
      skipped += 1;
      continue;
    }
    const known = latestTs.get(id);
    const accepted = acceptedTs.get(id);
    let baseline: string | undefined = known;
    if (accepted !== undefined && (baseline === undefined || isTsAfter(accepted, baseline))) {
      baseline = accepted;
    }
    if (baseline !== undefined) {
      if (isTsAfter(ts, baseline)) {
        conflict += 1;
      } else {
        skipped += 1;
      }
      continue;
    }
    acceptedTs.set(id, ts);
    added.push(record);
  }

  const result: ReconcileResult = { added: added, skipped: skipped, conflict: conflict };
  return result;
}

/**
 * `writePlan` 需要的**全部 IO 能力**（由 `services/exportService.ets` 用真实文件系统实现，
 * 测试用假写入器注入）。
 *
 * 刻意只开这三个写入口：**没有**「覆盖写 / 截断写 / 删除」这类能力——追加计划在类型层面
 * 就碰不到 `TRUNC`，历史字节改不了。要加新写法先改这个接口，评审一定会看到。
 */
export interface ImportWriteIo {
  /** 幂等创建目录（含父目录）。 */
  ensureDirs(): void;
  /** 某天的 JSONL 绝对路径（**唯一**写入目标来源；调用方不许自己拼路径）。 */
  dayFilePath(date: string): string;
  /** 定位到文件末尾追加（实现方**不得**使用截断/覆盖写）。 */
  appendTextAtEnd(path: string, text: string): void;
  /** 维护派生索引（可选；约定不抛异常，抛了也只影响索引，不影响已落盘的日程）。 */
  applyRecord?: (record: ScheduleRecord) => void;
}

/** `writePlan` 的结果（`files` 只含**已成功追加**的文件，失败时如实报告半批）。 */
export interface WritePlanResult {
  ok: boolean;
  /** 已追加的记录条数（按成功写下的日期桶累加）。 */
  appended: number;
  /** 已成功追加的绝对路径（按日期，去重后顺序稳定）。 */
  files: string[];
  /** 失败时的中文原因（含「已写入 N 个文件」）；成功为空串。 */
  reason: string;
}

/**
 * 把待追加记录按 `ts` 的日期分组（组内按 `ts` 稳定升序）。
 *
 * 抽到模型层的原因：它是「同一天多条只发生**一次**物理追加」这条契约的判定依据，
 * 必须能被 Node 直接测到（服务层 `.ets` 跑不进 `node --test`）。
 */
export function groupImportByDate(records: ScheduleRecord[]): Map<string, ScheduleRecord[]> {
  const list: ScheduleRecord[] = Array.isArray(records) ? records : [];
  const grouped = new Map<string, ScheduleRecord[]>();
  for (const record of list) {
    const date = recordDateKey(record.ts);
    const bucket = grouped.get(date);
    if (bucket === undefined) {
      const created: ScheduleRecord[] = [record];
      grouped.set(date, created);
    } else {
      bucket.push(record);
    }
  }
  for (const date of Array.from(grouped.keys())) {
    const bucket = grouped.get(date);
    if (bucket !== undefined) {
      grouped.set(date, sortRecords(bucket));
    }
  }
  return grouped;
}

/**
 * 导入落盘的**纯实现**（`appendImportPlan` 的全部副作用都经由注入的 `io`）。
 *
 * 保证（逐条对应 `docs/EXPORT-IMPORT.md` §3.3，并由 `tools/test/exportImport.test.mjs` 的
 * fake-IO 契约测试钉住）：
 * 1. **先编码、后落盘**：任一记录编码失败 → 整批 `ok:false`、`files` 为空、一个字节不写；
 * 2. **同一天多条只追加一次**：按日期分组后，每个日期只调一次 `io.appendTextAtEnd`；
 * 3. **只追加**：唯一的写入口是 `appendTextAtEnd`（没有截断写），历史行逐字节不变；
 * 4. **半批如实报告**：第 N 个日期失败时 `ok:false`，`files` 只含已写成功的文件，
 *    `appended` 只算已写下的条数（不虚报）；
 * 5. 派生索引在**写入成功之后**才维护，且索引异常不会把「已落盘」改报成失败。
 */
export function writePlan(records: ScheduleRecord[], io: ImportWriteIo): WritePlanResult {
  const list: ScheduleRecord[] = Array.isArray(records) ? records : [];
  const failed = (reason: string, appended: number, files: string[]): WritePlanResult => {
    const result: WritePlanResult = { ok: false, appended: appended, files: files, reason: reason };
    return result;
  };

  let grouped: Map<string, ScheduleRecord[]> = new Map<string, ScheduleRecord[]>();
  const payloads = new Map<string, string>();
  const orderedDates: string[] = [];
  try {
    grouped = groupImportByDate(list);
    for (const date of Array.from(grouped.keys())) {
      const bucket = grouped.get(date);
      if (bucket === undefined || bucket.length === 0) {
        continue;
      }
      let text = '';
      for (const record of bucket) {
        text += encodeRecord(record);
      }
      payloads.set(date, text);
      orderedDates.push(date);
    }
  } catch (error) {
    return failed(`导入内容不合法，整批未写入：${describe(error)}`, 0, []);
  }
  if (orderedDates.length === 0) {
    return failed('导入内容为空，未写入任何文件', 0, []);
  }

  const files: string[] = [];
  let appended = 0;
  try {
    io.ensureDirs();
    for (const date of orderedDates) {
      const text = payloads.get(date);
      if (text === undefined) {
        continue;
      }
      const path = io.dayFilePath(date);
      io.appendTextAtEnd(path, text);
      files.push(path);
      const bucket = grouped.get(date);
      if (bucket !== undefined) {
        appended += bucket.length;
      }
    }
  } catch (error) {
    return failed(`追加导入记录失败（已写入 ${files.length} 个文件）：${describe(error)}`, appended, files);
  }

  const applyRecord = io.applyRecord;
  if (applyRecord !== undefined) {
    for (const record of list) {
      try {
        applyRecord(record);
      } catch {
        // 派生索引（未完成清单）失败只影响索引，不影响已经落盘的日程。
      }
    }
  }

  const ok: WritePlanResult = { ok: true, appended: appended, files: files, reason: '' };
  return ok;
}

/**
 * 解析 JSON 导入文件（fail-closed：任何一项不对都 `ok:false` + 中文原因，`records` 为空）。
 *
 * 拒绝清单：
 * - 空串 / 全是空白；
 * - 不是合法 JSON（半截文件、注释、BOM 之外的垃圾）；
 * - 顶层是数组 / 标量 / null；
 * - 缺 `version` 或版本 ≠ 1（不认识的版本不猜）；
 * - 缺 `records` 或 `records` 不是数组。
 *
 * 逐条字段校验**不在这里做**（由 `planImport` 归入 `invalid`），这样「文件能读但有几条坏记录」
 * 仍能在 dry-run 里被人看见，而不是整份文件被一句 `ok:false` 盖掉。
 */
export function parseJsonImport(text: string): JsonImportResult {
  const rawText = typeof text === 'string' ? text.replace(/^\ufeff/, '').trim() : '';
  if (rawText.length === 0) {
    return jsonImportFailure('导入文件是空的（没有任何内容）');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    return jsonImportFailure(`不是合法的 JSON：${describe(error)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return jsonImportFailure('顶层必须是 JSON 对象（形如 {"version":1,"records":[…]}）');
  }
  const doc = parsed as Record<string, unknown>;
  if (doc.version === undefined) {
    return jsonImportFailure('缺少 version 字段（本机只认 version=1 的导出文件）');
  }
  if (doc.version !== EXPORT_VERSION) {
    return jsonImportFailure(`不认识的版本号（${clip(String(doc.version))}），本机只认 version=1`);
  }
  if (!Array.isArray(doc.records)) {
    return jsonImportFailure('缺少 records 数组（本机只认 {"version":1,"records":[…]} 的导出文件）');
  }
  const range = doc.range;
  let from = '';
  let to = '';
  if (range !== null && typeof range === 'object' && !Array.isArray(range)) {
    const rangeDoc = range as Record<string, unknown>;
    from = typeof rangeDoc.from === 'string' ? rangeDoc.from : '';
    to = typeof rangeDoc.to === 'string' ? rangeDoc.to : '';
  }
  const deviceId = typeof doc.deviceId === 'string' ? doc.deviceId : '';
  const exportedAt = typeof doc.exportedAt === 'string' ? doc.exportedAt : '';
  const result: JsonImportResult = {
    ok: true,
    records: doc.records as ScheduleRecord[],
    reason: '',
    from: from,
    to: to,
    deviceId: deviceId,
    exportedAt: exportedAt
  };
  return result;
}

/**
 * UTF-8 字节 → 字符串（纯函件，供 `services/exportService.ets` 读用户选的文件）。
 *
 * 为什么不用 `util.TextDecoder`：那会把 `@kit.ArkTS` 拖进共享层（Android 侧不一定有）；
 * 这里只依赖 `Uint8Array`（`scheduleStore` 已在用），且**坏了不抛**：
 * 非法/截断的字节序列放一个 `U+FFFD`，调用方随后会被 JSON 解析的 `ok:false` 拦住。
 * UTF-8 BOM 会被剥掉。
 */
export function decodeUtf8(bytes: Uint8Array): string {
  if (bytes === null || bytes === undefined || bytes.length === 0) {
    return '';
  }
  let out = '';
  let index = 0;
  const replacement = '\ufffd';
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    index = 3;
  }
  while (index < bytes.length) {
    const b0 = bytes[index];
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
      index += 1;
      continue;
    }
    if (b0 >= 0xc2 && b0 <= 0xdf && index + 1 < bytes.length) {
      const b1 = bytes[index + 1];
      if ((b1 & 0xc0) === 0x80) {
        out += String.fromCharCode(((b0 & 0x1f) << 6) | (b1 & 0x3f));
        index += 2;
        continue;
      }
    } else if (b0 >= 0xe0 && b0 <= 0xef && index + 2 < bytes.length) {
      const b1 = bytes[index + 1];
      const b2 = bytes[index + 2];
      if ((b1 & 0xc0) === 0x80 && (b2 & 0xc0) === 0x80) {
        const code = ((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f);
        const valid = code >= 0x800 && !(code >= 0xd800 && code <= 0xdfff);
        if (valid) {
          out += String.fromCharCode(code);
          index += 3;
          continue;
        }
      }
    } else if (b0 >= 0xf0 && b0 <= 0xf4 && index + 3 < bytes.length) {
      const b1 = bytes[index + 1];
      const b2 = bytes[index + 2];
      const b3 = bytes[index + 3];
      if ((b1 & 0xc0) === 0x80 && (b2 & 0xc0) === 0x80 && (b3 & 0xc0) === 0x80) {
        const code =
          ((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f);
        if (code >= 0x10000 && code <= 0x10ffff) {
          const shifted = code - 0x10000;
          out += String.fromCharCode(0xd800 + (shifted >> 10));
          out += String.fromCharCode(0xdc00 + (shifted & 0x3ff));
          index += 4;
          continue;
        }
      }
    }
    out += replacement;
    index += 1;
  }
  return out;
}

// ---------------------------------------------------------------- 面板展示用纯助手

/**
 * 面板初始状态（区间留空、格式 Markdown、两个开关关闭、没有结果）。
 *
 * 导出成常量是为了给 `@Prop state: ExportImportState = EMPTY_EXPORT_IMPORT_STATE` 一个
 * 字段齐全的默认值（ArkUI 的 `@Prop` 需要本地初始化；组件里再抄一遍字段就会随字段增删漂移）。
 * 调用方要可变副本请用 `defaultExportImportState()`。
 */
export const EMPTY_EXPORT_IMPORT_STATE: ExportImportState = {
  fromText: '',
  toText: '',
  format: EXPORT_FORMAT_MARKDOWN,
  includeAttachments: false,
  includeMeta: false,
  importFileName: '',
  dryRunReady: false,
  dryRunAdded: 0,
  dryRunSkipped: 0,
  dryRunConflict: 0,
  dryRunInvalid: 0,
  exportPath: '',
  message: '',
  busy: false
};

/** 面板默认状态（`EMPTY_EXPORT_IMPORT_STATE` 的逐字段副本，可安全修改）。 */
export function defaultExportImportState(): ExportImportState {
  return copyExportImportState(EMPTY_EXPORT_IMPORT_STATE);
}

/** 逐字段复制一份状态（ArkTS 不支持对象展开，只能手抄；新增字段必须同步加在这里）。 */
export function copyExportImportState(source: ExportImportState): ExportImportState {
  const copy: ExportImportState = {
    fromText: source.fromText,
    toText: source.toText,
    format: source.format,
    includeAttachments: source.includeAttachments,
    includeMeta: source.includeMeta,
    importFileName: source.importFileName,
    dryRunReady: source.dryRunReady,
    dryRunAdded: source.dryRunAdded,
    dryRunSkipped: source.dryRunSkipped,
    dryRunConflict: source.dryRunConflict,
    dryRunInvalid: source.dryRunInvalid,
    exportPath: source.exportPath,
    message: source.message,
    busy: source.busy
  };
  return copy;
}

/**
 * 本地「今天」的日期键 `YYYY-MM-DD`（本机时区）。
 *
 * 为什么放在模型层：面板的空态要给一个「填今天」的动作，但 `components/**` 是纯展示组件——
 * 在里面散落 `new Date()` 会让「今天」这件事无法单测、也容易各处口径不一。
 * 这里复用 `common/date.ts` 的 `localDateKey()`（同一个函数生成 `devices/<id>/schedules/<date>.jsonl`
 * 的目录名），所以「填今天」填出来的日期一定落在本机当天的文件上。
 *
 * 纯函数：只看入参（`now` 缺省取当前时间），不读全局状态；非法 `Date` 由 `localDateKey` 自身容错。
 */
export function todayText(now: Date = new Date()): string {
  return localDateKey(now);
}

// ---------------------------------------------------------------- 导出区间快捷 chip（D4）

/** 导出区间快捷：今天。 */
export const QUICK_RANGE_TODAY: string = 'today';
/** 导出区间快捷：本周（周一为首日，见 model/calendar.ts 的 WeekStart）。 */
export const QUICK_RANGE_WEEK: string = 'week';
/** 导出区间快捷：近 7 天。 */
export const QUICK_RANGE_LAST7: string = 'last7';

/** 一个快捷区间 chip 的定义（kind + 中文标签；界面按数组顺序渲染）。 */
export interface QuickRangeOption {
  kind: string;
  label: string;
}

const QUICK_TODAY_OPTION: QuickRangeOption = { kind: QUICK_RANGE_TODAY, label: '今天' };
const QUICK_WEEK_OPTION: QuickRangeOption = { kind: QUICK_RANGE_WEEK, label: '本周' };
const QUICK_LAST7_OPTION: QuickRangeOption = { kind: QUICK_RANGE_LAST7, label: '近 7 天' };

/** 三个 chip 的定义（顺序 = 界面顺序，标签逐字）。 */
export const QUICK_RANGE_OPTIONS: QuickRangeOption[] = [
  QUICK_TODAY_OPTION,
  QUICK_WEEK_OPTION,
  QUICK_LAST7_OPTION
];

/**
 * 按**本机时区**算快捷区间（含首尾）：
 * - 'today'：今天~今天；
 * - 'week' ：本周一~今天（周一为首日，沿用 model/calendar.ts 的 WeekStart=1 中文习惯）；
 * - 'last7'：今天-6 天~今天（含今天共 7 天）。
 * 未知 kind / 非法 Date → ok:false + 中文 reason，绝不抛异常。
 */
export function quickRange(kind: string, now: Date = new Date()): DateRangeResult {
  if (now === null || now === undefined || typeof now.getTime !== 'function' || Number.isNaN(now.getTime())) {
    return dateRangeFailure('当前时间无效，无法计算快捷区间');
  }
  const today: string = localDateKey(now);
  if (kind === QUICK_RANGE_TODAY) {
    // 再走一遍 parseDateRange 当自检：保证返回的是用户手打同格式的规范形态。
    return parseDateRange(today, today);
  }
  if (kind === QUICK_RANGE_WEEK) {
    // 周一为首日：周日(0)回退 6 天落到上一个周一，周一(1)回退 0 天，周二(2)回退 1 天……
    const weekday: number = now.getDay();
    const backDays: number = (weekday + 6) % 7;
    const monday: Date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - backDays);
    return parseDateRange(localDateKey(monday), today);
  }
  if (kind === QUICK_RANGE_LAST7) {
    const start: Date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
    return parseDateRange(localDateKey(start), today);
  }
  return dateRangeFailure(`未知的快捷区间：${clip(kind)}`);
}

/**
 * 当前 from/to 是否**正好**等于该快捷区间（chip 高亮用；用户手改后自动失配 → false）。
 */
export function isQuickRangeActive(kind: string, fromText: string, toText: string, now: Date = new Date()): boolean {
  const current: DateRangeResult = parseDateRange(fromText, toText);
  if (!current.ok) {
    return false;
  }
  const quick: DateRangeResult = quickRange(kind, now);
  if (!quick.ok) {
    return false;
  }
  return current.from === quick.from && current.to === quick.to;
}

/** 把 dry-run 计划写进展示状态（返回**新对象**，不改入参）。 */
export function applyPlan(state: ExportImportState, plan: ImportPlan): ExportImportState {
  const next = copyExportImportState(state);
  next.dryRunReady = true;
  next.dryRunAdded = plan.added;
  next.dryRunSkipped = plan.skipped;
  next.dryRunConflict = plan.conflict;
  next.dryRunInvalid = plan.invalid;
  next.busy = false;
  return next;
}

/** 只改提示文案 / 忙碌标志（返回新对象）。 */
export function withPanelMessage(state: ExportImportState, message: string, busy: boolean): ExportImportState {
  const next = copyExportImportState(state);
  next.message = typeof message === 'string' ? message : '';
  next.busy = busy;
  return next;
}

/** 只改导出路径（返回新对象）。 */
export function withExportPath(state: ExportImportState, exportPath: string): ExportImportState {
  const next = copyExportImportState(state);
  next.exportPath = typeof exportPath === 'string' ? exportPath : '';
  return next;
}

/** 只改「已选文件名」（返回新对象）。 */
export function withImportFileName(state: ExportImportState, fileName: string): ExportImportState {
  const next = copyExportImportState(state);
  next.importFileName = typeof fileName === 'string' ? fileName : '';
  return next;
}

/** 清空 dry-run 结果（重新选文件 / 取消后调用）。 */
export function clearDryRun(state: ExportImportState): ExportImportState {
  const next = copyExportImportState(state);
  next.dryRunReady = false;
  next.dryRunAdded = 0;
  next.dryRunSkipped = 0;
  next.dryRunConflict = 0;
  next.dryRunInvalid = 0;
  next.importFileName = '';
  next.busy = false;
  return next;
}

/** dry-run 统计行（逐字：`将新增 N 条 / 跳过 M 条（同 id 且更旧）/ 冲突 K 条（同 id 且更新，不会覆盖）/ 非法 J 条`）。 */
export function dryRunSummary(state: ExportImportState): string {
  return (
    `将新增 ${state.dryRunAdded} 条 / 跳过 ${state.dryRunSkipped} 条（同 id 且更旧）` +
    ` / 冲突 ${state.dryRunConflict} 条（同 id 且更新，不会覆盖） / 非法 ${state.dryRunInvalid} 条`
  );
}

/** dry-run 是否什么都没算出来（四类全 0）。 */
export function isDryRunEmpty(state: ExportImportState): boolean {
  return state.dryRunAdded + state.dryRunSkipped + state.dryRunConflict + state.dryRunInvalid === 0;
}

/**
 * 「确认导入」是否可点：**必须已有 dry-run 结果、有可新增记录、且非法条数为 0**（fail-closed）。
 *
 * 非法条目存在时整批不写：导入是往只追加的历史日志里塞行，塞错就只能靠人工回滚了。
 */
export function canConfirmImport(state: ExportImportState): boolean {
  if (state.busy || !state.dryRunReady) {
    return false;
  }
  return state.dryRunAdded > 0 && state.dryRunInvalid === 0;
}

/** dry-run 之后的提示文案（空串 = 不需要提示）。 */
export function importBlockedTip(state: ExportImportState): string {
  if (!state.dryRunReady) {
    return '';
  }
  if (state.dryRunInvalid > 0) {
    return `文件里有 ${state.dryRunInvalid} 条非法记录：请先修正文件再导入（一条非法就整批不写）`;
  }
  if (state.dryRunAdded === 0) {
    return NO_IMPORTABLE_TEXT;
  }
  return '';
}

// ================================================================ v2 单时间线导出 / 导入（additive）
//
// 这一节只服务 `timelineStore.useV2()` 分支：v1 的 Markdown/JSON 导出与 append-only 导入
// 一节不改（字节不变、测试不变）。全部是纯函数、零 SDK import，可由 `tools/tsconfig.json`
// 直接编到 `.build/` 用 Node 跑；文件 IO 与原子写盘分别在 `services/exportService.ets`
// 与 `services/timelineWriteStore.ets`。
//
// v2 bundle（放在沙箱 `<filesDir>/exports/v2-<stamp>/`，**不在 git 仓库里**）的形状：
//   manifest.json                       # {schemaVersion:2, kind, range, exportedAt, dayCount, days, media}
//   timeline/<date>/records.json         # 当日可见记录（已套用 deleted/restore 账本优先级）
//   timeline/<date>/summary.json         # 当日汇总原文（存在才导出）
//   timeline/<date>/media/<sha16>.jpg    # 散图，内容寻址名原样保留
// 确定性：days 按 date、records 按 (ts,id)（buildRecordsText）、media 按 (date,file) 排序；
// 同一份数据重复导出得到逐字节相同的 manifest 与日文件。

/** v2 bundle 的 schema 标记值（只认 2；其余按 E_SCHEMA_UNKNOWN 拒绝）。 */
export const V2_BUNDLE_SCHEMA_VERSION: number = 2;
/** v2 bundle 的 kind 标记（避免把别的 JSON 误当成时间线备份）。 */
export const V2_BUNDLE_KIND: string = 'dsh-schedule-v2';

/** 五类类型化拒绝原因（对应 brief / DATA-CONTRACT-v2 §11 的写路径门禁）。 */
export const V2_REFUSAL_SCHEMA_UNKNOWN: string = 'E_SCHEMA_UNKNOWN';
export const V2_REFUSAL_BUNDLE_CORRUPT: string = 'E_BUNDLE_CORRUPT';
export const V2_REFUSAL_MEDIA_MISSING: string = 'E_MEDIA_MISSING';
export const V2_REFUSAL_V1_TARGET: string = 'E_V1_TARGET';
export const V2_REFUSAL_TARGET_BUSY: string = 'E_TARGET_BUSY';
/** 媒体内容 sha256 与 manifest 不符 / 读不出来 → fail-closed，整包零写入（DATA-CONTRACT-v2 §5）。 */
export const V2_REFUSAL_MEDIA_CORRUPT: string = 'E_MEDIA_CORRUPT';
/** 同日同名（sha16 前缀）不同内容 → 拒绝，不覆盖、不保留错误旧图（§14 开放项 1 的"拒绝"分支）。 */
export const V2_REFUSAL_MEDIA_COLLISION: string = 'E_MEDIA_COLLISION';

/** manifest 中「一天」的摘要。 */
export interface V2BundleDay {
  date: string;
  recordCount: number;
  hasSummary: boolean;
  /** 该日 media/ 下的裸文件名（sha16.jpg），按文件名升序。 */
  media: string[];
}

/** manifest 中「一张媒体」的条目。 */
export interface V2BundleMedia {
  file: string;
  sha256: string;
  bytes: number;
  date: string;
}

/** v2 manifest 的逐字结构（键序即契约）。 */
export interface V2Manifest {
  schemaVersion: number;
  kind: string;
  range: ExportRange;
  exportedAt: string;
  dayCount: number;
  days: V2BundleDay[];
  media: V2BundleMedia[];
}

/** `buildV2Manifest` 入参。 */
export interface V2ManifestInput {
  from: string;
  to: string;
  exportedAt: string;
  days: V2BundleDay[];
  media: V2BundleMedia[];
}

/** 裸媒体文件名：<sha256[0:16]>.jpg（与契约 §5 / P2-11 一致）。 */
const V2_MEDIA_FILE_RE: RegExp = /^[0-9a-f]{16}\.jpg$/;
/** 完整 sha256：64 位小写十六进制。 */
const V2_SHA256_RE: RegExp = /^[0-9a-f]{64}$/;

function copyV2BundleDay(day: V2BundleDay): V2BundleDay {
  const media: string[] = [];
  const source: string[] = Array.isArray(day.media) ? day.media : [];
  for (const name of source) {
    media.push(name);
  }
  media.sort();
  const out: V2BundleDay = {
    date: day.date,
    recordCount: day.recordCount,
    hasSummary: day.hasSummary === true,
    media: media
  };
  return out;
}

function copyV2BundleMedia(item: V2BundleMedia): V2BundleMedia {
  const out: V2BundleMedia = { file: item.file, sha256: item.sha256, bytes: item.bytes, date: item.date };
  return out;
}

/**
 * 构造 v2 manifest 文本（纯函数，不写盘）。
 *
 * - 顶层键序固定 `schemaVersion, kind, range, exportedAt, dayCount, days, media`；
 * - days 按 date 升序、day.media 按文件名升序、media 按 (date, file) 升序；
 * - 2 空格缩进 + 末尾一个换行；区间非法时抛中文 Error（与 v1 渲染入口同口径）。
 */
export function buildV2Manifest(input: V2ManifestInput): string {
  const range = requireRange(input.from, input.to);
  const days: V2BundleDay[] = [];
  const sourceDays: V2BundleDay[] = Array.isArray(input.days) ? input.days : [];
  for (const day of sourceDays) {
    days.push(copyV2BundleDay(day));
  }
  days.sort((left: V2BundleDay, right: V2BundleDay): number => {
    if (left.date === right.date) {
      return 0;
    }
    return left.date < right.date ? -1 : 1;
  });
  const media: V2BundleMedia[] = [];
  const sourceMedia: V2BundleMedia[] = Array.isArray(input.media) ? input.media : [];
  for (const item of sourceMedia) {
    media.push(copyV2BundleMedia(item));
  }
  media.sort((left: V2BundleMedia, right: V2BundleMedia): number => {
    if (left.date !== right.date) {
      return left.date < right.date ? -1 : 1;
    }
    if (left.file === right.file) {
      return 0;
    }
    return left.file < right.file ? -1 : 1;
  });
  const doc: V2Manifest = {
    schemaVersion: V2_BUNDLE_SCHEMA_VERSION,
    kind: V2_BUNDLE_KIND,
    range: range,
    exportedAt: typeof input.exportedAt === 'string' ? input.exportedAt : '',
    dayCount: days.length,
    days: days,
    media: media
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** `parseV2Manifest` 的结果（失败时 manifest 为 null）。 */
export interface V2ManifestResult {
  ok: boolean;
  code: string;
  reason: string;
  manifest: V2Manifest | null;
}

function v2ManifestFailure(code: string, reason: string): V2ManifestResult {
  const out: V2ManifestResult = { ok: false, code: code, reason: reason, manifest: null };
  return out;
}

/**
 * 解析并校验 v2 manifest（fail-closed）。
 *
 * - 空 / 非法 JSON / 顶层非对象 / kind 不符 / 字段缺失或畸形 → E_BUNDLE_CORRUPT；
 * - schemaVersion 存在但不为 2 → E_SCHEMA_UNKNOWN；完全缺标记 → E_BUNDLE_CORRUPT。
 */
export function parseV2Manifest(text: string): V2ManifestResult {
  const raw = typeof text === 'string' ? text.replace(/^\ufeff/, '').trim() : '';
  if (raw.length === 0) {
    return v2ManifestFailure(V2_REFUSAL_BUNDLE_CORRUPT, 'v2 备份的 manifest.json 是空的');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return v2ManifestFailure(V2_REFUSAL_BUNDLE_CORRUPT, `v2 备份 manifest 不是合法 JSON：${describe(error)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return v2ManifestFailure(V2_REFUSAL_BUNDLE_CORRUPT, 'v2 备份 manifest 顶层必须是 JSON 对象');
  }
  const doc = parsed as Record<string, unknown>;
  if (doc.schemaVersion === undefined) {
    return v2ManifestFailure(V2_REFUSAL_BUNDLE_CORRUPT, 'v2 备份 manifest 缺少 schemaVersion 标记');
  }
  if (doc.schemaVersion !== V2_BUNDLE_SCHEMA_VERSION) {
    return v2ManifestFailure(
      V2_REFUSAL_SCHEMA_UNKNOWN,
      `不认识的 v2 备份版本（${clip(String(doc.schemaVersion))}），只支持 schemaVersion=2`
    );
  }
  if (doc.kind !== V2_BUNDLE_KIND) {
    return v2ManifestFailure(V2_REFUSAL_BUNDLE_CORRUPT, `v2 备份 kind 不是 ${V2_BUNDLE_KIND}`);
  }
  const rangeRaw = doc.range;
  if (rangeRaw === null || typeof rangeRaw !== 'object' || Array.isArray(rangeRaw)) {
    return v2ManifestFailure(V2_REFUSAL_BUNDLE_CORRUPT, 'v2 备份 manifest 缺少 range 对象');
  }
  const rangeDoc = rangeRaw as Record<string, unknown>;
  const range = parseDateRange(
    typeof rangeDoc.from === 'string' ? rangeDoc.from : '',
    typeof rangeDoc.to === 'string' ? rangeDoc.to : ''
  );
  if (!range.ok) {
    return v2ManifestFailure(V2_REFUSAL_BUNDLE_CORRUPT, `v2 备份区间非法：${range.reason}`);
  }
  if (!Array.isArray(doc.days) || !Array.isArray(doc.media)) {
    return v2ManifestFailure(V2_REFUSAL_BUNDLE_CORRUPT, 'v2 备份 manifest 缺少 days 或 media 数组');
  }
  const days: V2BundleDay[] = [];
  for (const rawDay of doc.days as unknown[]) {
    if (rawDay === null || typeof rawDay !== 'object' || Array.isArray(rawDay)) {
      return v2ManifestFailure(V2_REFUSAL_BUNDLE_CORRUPT, 'v2 备份 days 里有非对象元素');
    }
    const dayDoc = rawDay as Record<string, unknown>;
    const date = typeof dayDoc.date === 'string' ? dayDoc.date : '';
    if (parseDateKey(date) === null) {
      return v2ManifestFailure(V2_REFUSAL_BUNDLE_CORRUPT, `v2 备份 days 里有非法日期：${clip(date)}`);
    }
    const count = dayDoc.recordCount;
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
      return v2ManifestFailure(V2_REFUSAL_BUNDLE_CORRUPT, `v2 备份 ${date} 的 recordCount 非法`);
    }
    if (typeof dayDoc.hasSummary !== 'boolean') {
      return v2ManifestFailure(V2_REFUSAL_BUNDLE_CORRUPT, `v2 备份 ${date} 的 hasSummary 非法`);
    }
    if (!Array.isArray(dayDoc.media)) {
      return v2ManifestFailure(V2_REFUSAL_BUNDLE_CORRUPT, `v2 备份 ${date} 的 media 不是数组`);
    }
    const mediaNames: string[] = [];
    for (const name of dayDoc.media as unknown[]) {
      if (typeof name !== 'string' || !V2_MEDIA_FILE_RE.test(name)) {
        return v2ManifestFailure(V2_REFUSAL_BUNDLE_CORRUPT, `v2 备份 ${date} 的媒体文件名非法：${clip(String(name))}`);
      }
      mediaNames.push(name);
    }
    const day: V2BundleDay = {
      date: date,
      recordCount: count,
      hasSummary: dayDoc.hasSummary,
      media: mediaNames
    };
    days.push(copyV2BundleDay(day));
  }
  const media: V2BundleMedia[] = [];
  for (const rawMedia of doc.media as unknown[]) {
    if (rawMedia === null || typeof rawMedia !== 'object' || Array.isArray(rawMedia)) {
      return v2ManifestFailure(V2_REFUSAL_BUNDLE_CORRUPT, 'v2 备份 media 里有非对象元素');
    }
    const mediaDoc = rawMedia as Record<string, unknown>;
    const file = typeof mediaDoc.file === 'string' ? mediaDoc.file : '';
    const sha = typeof mediaDoc.sha256 === 'string' ? mediaDoc.sha256 : '';
    const bytes = mediaDoc.bytes;
    const date = typeof mediaDoc.date === 'string' ? mediaDoc.date : '';
    if (!V2_MEDIA_FILE_RE.test(file) || !V2_SHA256_RE.test(sha)) {
      return v2ManifestFailure(V2_REFUSAL_BUNDLE_CORRUPT, `v2 备份媒体条目非法：${clip(file)}`);
    }
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) {
      return v2ManifestFailure(V2_REFUSAL_BUNDLE_CORRUPT, `v2 备份媒体大小非法：${clip(file)}`);
    }
    if (parseDateKey(date) === null) {
      return v2ManifestFailure(V2_REFUSAL_BUNDLE_CORRUPT, `v2 备份媒体日期非法：${clip(date)}`);
    }
    media.push(copyV2BundleMedia({ file: file, sha256: sha, bytes: bytes, date: date }));
  }
  const declaredDayCount = doc.dayCount;
  if (typeof declaredDayCount !== 'number' || declaredDayCount !== days.length) {
    return v2ManifestFailure(V2_REFUSAL_BUNDLE_CORRUPT, 'v2 备份 dayCount 与 days 数量不一致');
  }
  const exportedAt = typeof doc.exportedAt === 'string' ? doc.exportedAt : '';
  const result: V2Manifest = {
    schemaVersion: V2_BUNDLE_SCHEMA_VERSION,
    kind: V2_BUNDLE_KIND,
    range: range,
    exportedAt: exportedAt,
    dayCount: days.length,
    days: days,
    media: media
  };
  const ok: V2ManifestResult = { ok: true, code: '', reason: '', manifest: result };
  return ok;
}

/** 从一条 v1 形状记录构造 v2 记录（导出 bundle 时用，全部字段显式搬运）。 */
interface IncomingV2Record extends ScheduleRecord {
  media?: TimelineMedia[];
  opened_at?: string;
  closed_at?: string;
}

/** 把媒体数组逐项校验后复制（畸形条目丢弃，不写进 bundle）。 */
function v2MediaOf(value: TimelineMedia[] | undefined): TimelineMedia[] {
  const out: TimelineMedia[] = [];
  if (!Array.isArray(value)) {
    return out;
  }
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    if (!V2_MEDIA_FILE_RE.test(item.file) || !V2_SHA256_RE.test(item.sha256)) {
      continue;
    }
    if (!Number.isInteger(item.pageIndex) || item.pageIndex < 0) {
      continue;
    }
    const copy: TimelineMedia = { file: item.file, sha256: item.sha256, pageIndex: item.pageIndex };
    out.push(copy);
  }
  return out;
}

/** v2 记录已写入的字段名（搬运未知扩展字段时避免重复）。 */
function v2WrittenFieldNames(): Set<string> {
  const names: Set<string> = new Set<string>();
  for (const name of [
    'id', 'ts', 'title', 'body', 'author', 'done', 'media',
    'ocr_text', 'ai_structured', 'ai_processed', 'ocr_time', 'opened_at', 'closed_at'
  ]) {
    names.add(name);
  }
  return names;
}

/** 把 `timelineStore.readDay()` 带出的记录规范化为可序列化的 v2 记录。 */
export function asV2Record(record: ScheduleRecord): TimelineRecord {
  const src: IncomingV2Record = record as IncomingV2Record;
  const opened = typeof src.opened_at === 'string' && src.opened_at.length > 0 ? src.opened_at : record.ts;
  const out: TimelineRecord = {
    id: record.id,
    ts: record.ts,
    title: record.title,
    body: record.body,
    author: record.author,
    done: record.done,
    media: v2MediaOf(src.media),
    ai_processed: record.ai_processed,
    opened_at: opened
  };
  const ocr = record.ocr_text;
  if (typeof ocr === 'string') {
    out.ocr_text = ocr;
  }
  const structured = record.ai_structured;
  if (typeof structured === 'string') {
    out.ai_structured = structured;
  }
  const ocrTime = record.ocr_time;
  if (typeof ocrTime === 'string') {
    out.ocr_time = ocrTime;
  }
  const closed = src.closed_at;
  if (typeof closed === 'string' && closed.length > 0) {
    out.closed_at = closed;
  } else if (record.done) {
    out.closed_at = record.ts;
  }
  // 未知扩展字段原样尾随（与 model/timeline.ts 的 canonicalRecordLine 同口径）。
  const written = v2WrittenFieldNames();
  const source = record as unknown as Record<string, unknown>;
  const target = out as unknown as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if (!written.has(key)) {
      target[key] = source[key];
    }
  }
  return out;
}

/** 用 v2 原子写入的字节生成器序列化一日可见记录（先规范化，再由 buildRecordsText 自检）。 */
export function buildV2RecordsText(date: string, records: ScheduleRecord[]): string {
  const list: ScheduleRecord[] = Array.isArray(records) ? records : [];
  const v2Records: TimelineRecord[] = [];
  for (const record of list) {
    v2Records.push(asV2Record(record));
  }
  return buildRecordsText(date, v2Records);
}

/** 从 v2 bundle 目录读入的一日原文。 */
export interface V2BundleDayInput {
  date: string;
  recordsText: string;
  summaryText: string;
  /** 该日 media/ 目录里实际存在的文件名（裸名）。 */
  mediaFiles: string[];
}

/** 从磁盘拼好的、待校验的 v2 bundle。 */
export interface V2BundleInput {
  manifestText: string;
  days: V2BundleDayInput[];
}

/** 校验通过的一日（records 为已折叠、已过滤账本的记录）。 */
export interface V2ValidatedDay {
  date: string;
  records: TimelineRecord[];
  summaryText: string;
  mediaFiles: string[];
}

/** `validateV2Bundle` 的结果。 */
export interface V2ValidationResult {
  ok: boolean;
  code: string;
  reason: string;
  manifest: V2Manifest | null;
  days: V2ValidatedDay[];
}

function v2ValidationFailure(code: string, reason: string, manifest: V2Manifest | null): V2ValidationResult {
  const out: V2ValidationResult = { ok: false, code: code, reason: reason, manifest: manifest, days: [] };
  return out;
}

/**
 * 校验一个 v2 bundle（只读、无 IO）：manifest 标记 → 逐日 records.json 解析 → 媒体文件在位。
 *
 * - manifest 不对：透传 `parseV2Manifest` 的 E_SCHEMA_UNKNOWN / E_BUNDLE_CORRUPT；
 * - 天数 / 日期 / 记录数 / summary 标记与 manifest 不符：E_BUNDLE_CORRUPT；
 * - 某日 records.json 解析失败（顶层坏 / 有坏行）：E_BUNDLE_CORRUPT；
 * - manifest 里声明的媒体文件在某日 media/ 名单里缺失：E_MEDIA_MISSING。
 */
export function validateV2Bundle(bundle: V2BundleInput): V2ValidationResult {
  const parsed = parseV2Manifest(bundle === null || bundle === undefined ? '' : bundle.manifestText);
  if (!parsed.ok || parsed.manifest === null) {
    return v2ValidationFailure(parsed.code, parsed.reason, null);
  }
  const manifest = parsed.manifest;
  const inputDays: V2BundleDayInput[] = Array.isArray(bundle.days) ? bundle.days : [];
  if (inputDays.length !== manifest.days.length) {
    return v2ValidationFailure(
      V2_REFUSAL_BUNDLE_CORRUPT,
      `v2 备份天数不符：manifest 声明 ${manifest.days.length} 天，实际 ${inputDays.length} 天`,
      manifest
    );
  }
  const byDate = new Map<string, V2BundleDay>();
  for (const day of manifest.days) {
    byDate.set(day.date, day);
  }
  const sorted = inputDays.slice();
  sorted.sort((left: V2BundleDayInput, right: V2BundleDayInput): number => {
    if (left.date === right.date) {
      return 0;
    }
    return left.date < right.date ? -1 : 1;
  });
  const seen = new Set<string>();
  const days: V2ValidatedDay[] = [];
  for (const input of sorted) {
    if (seen.has(input.date)) {
      return v2ValidationFailure(V2_REFUSAL_BUNDLE_CORRUPT, `v2 备份有重复日期：${input.date}`, manifest);
    }
    seen.add(input.date);
    const declared = byDate.get(input.date);
    if (declared === undefined) {
      return v2ValidationFailure(V2_REFUSAL_BUNDLE_CORRUPT, `v2 备份多出 manifest 未声明的一天：${input.date}`, manifest);
    }
    const dayParse = parseTimelineDay(input.recordsText, input.date);
    if (dayParse.day === null || dayParse.errors.length > 0) {
      return v2ValidationFailure(
        V2_REFUSAL_BUNDLE_CORRUPT,
        `v2 备份 ${input.date} 的 records.json 无法安全解析（${dayParse.errors.length} 处错误）`,
        manifest
      );
    }
    const records = dayParse.day.allRecords;
    if (records.length !== declared.recordCount) {
      return v2ValidationFailure(
        V2_REFUSAL_BUNDLE_CORRUPT,
        `v2 备份 ${input.date} 记录数不符：manifest 声明 ${declared.recordCount}，实际 ${records.length}`,
        manifest
      );
    }
    if ((typeof input.summaryText === 'string' && input.summaryText.length > 0) !== declared.hasSummary) {
      return v2ValidationFailure(V2_REFUSAL_BUNDLE_CORRUPT, `v2 备份 ${input.date} 的汇总存在标记不符`, manifest);
    }
    const present = new Set<string>();
    for (const name of input.mediaFiles) {
      present.add(name);
    }
    for (const name of declared.media) {
      if (!present.has(name)) {
        return v2ValidationFailure(
          V2_REFUSAL_MEDIA_MISSING,
          `v2 备份缺少媒体文件 ${input.date}/media/${name}（content-addressed 文件必须一起搬运）`,
          manifest
        );
      }
    }
    const valid: V2ValidatedDay = {
      date: input.date,
      records: records,
      summaryText: typeof input.summaryText === 'string' ? input.summaryText : '',
      mediaFiles: input.mediaFiles.slice()
    };
    days.push(valid);
  }
  const ok: V2ValidationResult = { ok: true, code: '', reason: '', manifest: manifest, days: days };
  return ok;
}

/** 导入目标的门槛状态（由服务层从 timelineStore / timelineWriteStore 读取后传入）。 */
export interface V2TargetState {
  /** 仓库级 timeline/schema.json 明确为 schemaVersion:2。 */
  repoIsV2: boolean;
  /** 写入闸已开启（timelineWriteStore.isEnabled()）。 */
  writeEnabled: boolean;
}

/** dry-run 计划的总量。 */
export interface V2PlanTotals {
  days: number;
  records: number;
  media: number;
  bytes: number;
}

/** `planV2Import` 的结果（ok=false 时 code 为五类类型化原因之一）。 */
export interface V2ImportPlan {
  ok: boolean;
  code: string;
  reason: string;
  totals: V2PlanTotals;
  manifest: V2Manifest | null;
  days: V2ValidatedDay[];
}

function emptyV2Totals(): V2PlanTotals {
  const out: V2PlanTotals = { days: 0, records: 0, media: 0, bytes: 0 };
  return out;
}

function v2PlanFailure(code: string, reason: string, manifest: V2Manifest | null): V2ImportPlan {
  const out: V2ImportPlan = {
    ok: false,
    code: code,
    reason: reason,
    totals: emptyV2Totals(),
    manifest: manifest,
    days: []
  };
  return out;
}

/**
 * v2 导入 dry-run（**只算不写**）：先校验 bundle，再检查目标门槛，最后给出 days/records/media/bytes。
 *
 * 拒绝优先级（typed）：
 * 1. bundle 校验失败的 E_SCHEMA_UNKNOWN / E_BUNDLE_CORRUPT / E_MEDIA_MISSING；
 * 2. 目标是 v1 仓库（无 v2 schema 标记）→ E_V1_TARGET（先迁移）；
 * 3. 写入路径未启用（显式激活闸关闭 / 存储未初始化）→ E_TARGET_BUSY。
 */
export function planV2Import(bundle: V2BundleInput, target: V2TargetState): V2ImportPlan {
  const checked = validateV2Bundle(bundle);
  if (!checked.ok) {
    return v2PlanFailure(checked.code, checked.reason, checked.manifest);
  }
  if (!target.repoIsV2) {
    return v2PlanFailure(
      V2_REFUSAL_V1_TARGET,
      '目标是 v1 仓库：请先把仓库单向迁移到 v2（timeline/schema.json 声明 schemaVersion:2）后再导入',
      checked.manifest
    );
  }
  if (!target.writeEnabled) {
    return v2PlanFailure(
      V2_REFUSAL_TARGET_BUSY,
      'v2 写入路径未启用：请先在设置页显式激活 v2 写入后再导入',
      checked.manifest
    );
  }
  const totals: V2PlanTotals = emptyV2Totals();
  totals.days = checked.days.length;
  for (const day of checked.days) {
    totals.records += day.records.length;
    totals.media += day.mediaFiles.length;
  }
  if (checked.manifest !== null) {
    for (const item of checked.manifest.media) {
      totals.bytes += item.bytes;
    }
  }
  const out: V2ImportPlan = {
    ok: true,
    code: '',
    reason: '',
    totals: totals,
    manifest: checked.manifest,
    days: checked.days
  };
  return out;
}

// ---------------------------------------------------------------- 落盘前媒体完整性预检（P1-1 / P2 碰撞）

/** 媒体预检所需的最小 IO：服务层注入真实 fileIo，Node 测试注入假读，不碰 SDK。 */
export interface V2MediaCheckIo {
  /** 目标日 media/ 下是否已有同名文件（只增不覆盖：已有就不复制）。 */
  targetExists: (date: string, file: string) => boolean;
  /** 读目标已有的同名媒体字节（仅 targetExists 为真时调用；不可读则抛）。 */
  readTarget: (date: string, file: string) => Uint8Array;
  /** 读 bundle 里的源媒体字节（不可读则抛）。 */
  readSource: (date: string, file: string) => Uint8Array;
}

/** 通过预检、待复制到目标的媒体（bytes 就是已校验的那一份，避免"验完再读"被换掉）。 */
export interface V2VerifiedMedia {
  date: string;
  file: string;
  sha256: string;
  bytes: Uint8Array;
}

/** `checkV2MediaIntegrity` 的结果（失败时 code 为 E_MEDIA_CORRUPT / E_MEDIA_COLLISION，verified 为空）。 */
export interface V2MediaCheckResult {
  ok: boolean;
  code: string;
  reason: string;
  verified: V2VerifiedMedia[];
}

/**
 * `applyV2Import` 的**落盘前媒体预检**（纯逻辑、零 IO；三个读能力由调用方注入）。
 *
 * 设计决策（P1-1）：选"**fail closed before any write**"，不做"逐日回滚"。
 * records.json / summary.json 是原子替换，媒体是另一批文件，二者没有跨文件事务；
 * 边写边校一旦发现坏图，当天（甚至前几天）的记录已经落盘，回滚还要处理已 rename 的
 * 原子写，复杂且易错。这里把校验整体前移到任何写入之前：任何一张图坏 / 读不出 /
 * 同名不同内容 → typed 拒绝，调用方一个字节都不写。代价只是把校验读到的字节原样交给
 * 写入（不二次读），顺带消除"校验后文件被换掉"的竞态。
 *
 * 规则：
 * 1. manifest.media[] 同一 (date,file) 声明两个不同 sha256 → E_MEDIA_COLLISION；
 *    （同日 sha16 前缀碰撞：本实现选"拒绝"而非"延长前缀"，不改名、不覆盖、不留错误旧图。
 *    理由：文件名由内容寻址 sha16 决定，改名要同步改记录里的 media[].file，牵动 bundle
 *    字节契约；拒绝是 fail-closed 且改动面最小，符合 no-silent-failure 纪律。）
 * 2. 目标已有同名文件：读其字节比对 manifest sha256，不同 → E_MEDIA_COLLISION（既不覆盖，
 *    也不把错误旧图当成功）；相同 → 跳过复制（media 只增）；
 * 3. 目标没有该文件：读 bundle 源字节算 sha256，不符 / 读失败 → E_MEDIA_CORRUPT；
 * 4. 计划里有媒体文件却没有 manifest sha256 条目 → E_MEDIA_CORRUPT（无法校验就不搬）。
 *
 * 注：dry-run（planV2Import）只有文件名、没有字节，故不在这里校哈希；真正的字节校验在
 * 用户确认后的 apply 阶段做，面板展示的计划不改变。
 */
export function checkV2MediaIntegrity(plan: V2ImportPlan, io: V2MediaCheckIo): V2MediaCheckResult {
  const fail = (code: string, reason: string): V2MediaCheckResult => {
    const out: V2MediaCheckResult = { ok: false, code: code, reason: reason, verified: [] };
    return out;
  };
  const manifest: V2Manifest | null = plan !== null && plan.ok ? plan.manifest : null;
  const expectedByKey = new Map<string, string>();
  if (manifest !== null && Array.isArray(manifest.media)) {
    for (const item of manifest.media) {
      const key: string = `${item.date}/${item.file}`;
      const known: string | undefined = expectedByKey.get(key);
      if (known !== undefined && known !== item.sha256) {
        return fail(
          V2_REFUSAL_MEDIA_COLLISION,
          `v2 备份同日媒体名碰撞：${key} 声明了两个不同的 sha256，拒绝导入且未写入任何内容`
        );
      }
      expectedByKey.set(key, item.sha256);
    }
  }
  const verified: V2VerifiedMedia[] = [];
  const days: V2ValidatedDay[] = plan !== null && Array.isArray(plan.days) ? plan.days : [];
  for (const day of days) {
    for (const file of day.mediaFiles) {
      const key: string = `${day.date}/${file}`;
      const expected: string | undefined = expectedByKey.get(key);
      if (expected === undefined || expected.length === 0) {
        return fail(
          V2_REFUSAL_MEDIA_CORRUPT,
          `v2 备份媒体 ${key} 没有 manifest sha256 条目，无法校验，拒绝导入且未写入任何内容`
        );
      }
      if (io.targetExists(day.date, file)) {
        let targetBytes: Uint8Array;
        try {
          targetBytes = io.readTarget(day.date, file);
        } catch (error) {
          return fail(
            V2_REFUSAL_MEDIA_CORRUPT,
            `v2 目标媒体 ${key} 已存在但无法读取校验：${describe(error)}，拒绝导入且未写入任何内容`
          );
        }
        if (sha256Hex(targetBytes) !== expected.toLowerCase()) {
          return fail(
            V2_REFUSAL_MEDIA_COLLISION,
            `v2 目标媒体 ${key} 已存在但内容摘要与备份不符（sha16 碰撞：拒绝覆盖，也不保留错误旧图），未写入任何内容`
          );
        }
        continue; // 内容一致：只增不覆盖，无需复制
      }
      let bytes: Uint8Array;
      try {
        bytes = io.readSource(day.date, file);
      } catch (error) {
        return fail(
          V2_REFUSAL_MEDIA_CORRUPT,
          `v2 备份媒体 ${key} 无法读取：${describe(error)}，拒绝导入且未写入任何内容`
        );
      }
      const actual: string = sha256Hex(bytes);
      if (actual !== expected.toLowerCase()) {
        return fail(
          V2_REFUSAL_MEDIA_CORRUPT,
          `v2 备份媒体 ${key} 内容 sha256 不符（期望 ${clip(expected, 16)}…，实际 ${clip(actual, 16)}…），拒绝导入且未写入任何内容`
        );
      }
      const item: V2VerifiedMedia = { date: day.date, file: file, sha256: expected, bytes: bytes };
      verified.push(item);
    }
  }
  const ok: V2MediaCheckResult = { ok: true, code: '', reason: '', verified: verified };
  return ok;
}

/** dry-run 计划的中文展示行（面板逐字显示）。 */
export function v2PlanSummary(plan: V2ImportPlan): string {
  if (!plan.ok) {
    return '';
  }
  return (
    `将导入 ${plan.totals.days} 天 / ${plan.totals.records} 条记录 / ` +
    `${plan.totals.media} 个媒体文件（共 ${plan.totals.bytes} 字节）`
  );
}

/** 五类拒绝原因对应的「下一步」文案（面板错误态用，未登记的类型给通用文案）。 */
export function v2RefusalNext(code: string): string {
  if (code === V2_REFUSAL_SCHEMA_UNKNOWN) {
    return '换用 schemaVersion=2 的 v2 备份；不认识的版本不猜着导入';
  }
  if (code === V2_REFUSAL_BUNDLE_CORRUPT) {
    return '重新导出一份完整备份；坏 manifest / 坏日文件不写盘';
  }
  if (code === V2_REFUSAL_MEDIA_MISSING) {
    return '重新导出并确保 media/ 散图一起搬运；缺图不会静默丢图';
  }
  if (code === V2_REFUSAL_V1_TARGET) {
    return '先执行 v1→v2 单向迁移，再导入 v2 备份';
  }
  if (code === V2_REFUSAL_TARGET_BUSY) {
    return '稍后重试，或到设置页检查 v2 写入是否已显式激活';
  }
  if (code === V2_REFUSAL_MEDIA_CORRUPT) {
    return '重新导出并完整搬运 media/，确认散图未被改动后再导入（坏图不会写盘）';
  }
  if (code === V2_REFUSAL_MEDIA_COLLISION) {
    return '重新导出该日媒体后重试；同名不同内容不覆盖、不保留错误旧图，需人工核对 sha16 碰撞';
  }
  return '检查备份与仓库状态后重试';
}
