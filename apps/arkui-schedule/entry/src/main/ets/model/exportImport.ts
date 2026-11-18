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
import { formatDateKey, monthGrid, parseDateKey } from './calendar';
import { encodeRecord, recordDateKey, sortRecords } from './jsonl';
import type { Attachment, ScheduleRecord } from './types';

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
