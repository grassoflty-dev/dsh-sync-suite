/**
 * 导出 / 导入的**文件 IO 适配层**（唯一碰磁盘的地方）。
 *
 * 纯逻辑在 `model/exportImport.ts`（可 Node 跑）；本文件只负责：
 * 1. **导出**：把渲染好的文本写到应用沙箱 `<filesDir>/exports/schedule-YYYYMMDD-HHmm.<md|json>`，
 *    文件名时间戳来自**记录**（`exportFileStamp`），同名时加 `-2` / `-3` 后缀（不用随机数）；
 * 2. **选文件 + 读文本**：`picker.DocumentViewPicker` 选一份 JSON，用 `openSync` + `readSync` +
 *    `decodeUtf8` 读成字符串（不新增权限）；
 * 3. **导入落盘**：只按 `ImportPlan.toAppend` 追加，**绝不重写历史行、绝不写别的设备目录**。
 *
 * 边界（`docs/EXPORT-IMPORT.md` §5）：
 * - 导出是只读派生：只读 `scheduleStore.readAll()`，不碰源文件；导出目录是**沙箱内**路径，
 *   不进 Git 仓库（`devices/` 之外），所以不会被同步推走；
 * - 导入**必须**先 `planImportFromText` 拿到 dry-run 结果，再由用户确认后 `appendImportPlan`；
 *   本模块不提供「分析+落盘」一步到位的函数，防止 UI 误用成「选了文件就写」；
 * - 整批写入前先把所有行编码完：任何一条编码失败就整批不写（fail-closed），
 *   不会出现「写了一半」的历史日志；
 * - 同一天多条按 `ts` 升序拼接后**一次**物理追加（定位到文件末尾写入），历史字节一个都不改。
 */
import { fileIo as fs, picker } from '@kit.CoreFileKit';
import { common } from '@kit.AbilityKit';
import { nowIso } from '../common/date';
import {
  EXPORT_FORMAT_JSON,
  decodeUtf8,
  exportFileName,
  exportFileStamp,
  exportRecordsInRange,
  buildJsonExport,
  normalizeExportFormat,
  parseDateRange,
  parseJsonImport,
  planImport,
  renderMarkdownExport
} from '../model/exportImport';
import type {
  ExportFileStampInput,
  ImportPlan,
  JsonExportInput,
  MarkdownExportInput
} from '../model/exportImport';
import { encodeRecord, recordDateKey, sortRecords } from '../model/jsonl';
import type { ScheduleRecord } from '../model/types';
import { describeError, scheduleStore } from './scheduleStore';
import { openIndexStore } from './openIndexStore';

/** 导出目录名（`<filesDir>/exports`，不在 `git-repo/` 里）。 */
const EXPORTS_DIR_NAME: string = 'exports';
/** 换行字节（追加前判断文件末尾是否已经是换行）。 */
const NEW_LINE_BYTE: number = 0x0a;
/** 单份导入文件的大小上限（16MB）：超过直接拒绝，避免把沙箱内存打爆。 */
const MAX_IMPORT_BYTES: number = 16 * 1024 * 1024;
/** 同名导出文件的序号上限（超过说明目录该清理了，不无限试）。 */
const MAX_FILE_SEQUENCE: number = 99;

/** 导出请求（由 `ExportImportPanel` 的 `ExportRequest` 直接映射过来）。 */
export interface ExportRequestInput {
  /** 起始日期 `YYYY-MM-DD`（含）。 */
  from: string;
  /** 结束日期 `YYYY-MM-DD`（含）。 */
  to: string;
  /** `markdown` / `json`（未知按 markdown）。 */
  format: string;
  /** 是否追加附件清单（仅 Markdown）。 */
  includeAttachments: boolean;
  /** 是否追加元信息行（仅 Markdown）。 */
  includeMeta: boolean;
}

/** 一次导出的结果（失败也返回对象，`ok:false` + 中文 `reason`）。 */
export interface ExportFileResult {
  ok: boolean;
  /** 可读绝对路径（给用户看/长按复制）。 */
  path: string;
  fileName: string;
  /** 写入的字符数（人类可读的体量参考）。 */
  chars: number;
  /** 本次导出的记录条数（可能是 0：空区间也产出文件）。 */
  recordCount: number;
  reason: string;
}

/** 选文件 + 读文本的结果。 */
export interface ImportFilePickResult {
  ok: boolean;
  /** 系统返回的文件 URI（空串 = 没选/失败）。 */
  uri: string;
  /** 展示用文件名。 */
  fileName: string;
  /** 文件文本（失败为空串，fail-closed）。 */
  text: string;
  reason: string;
}

/** dry-run 结果（`plan` 为 null 表示文件本身不可用）。 */
export interface ImportPlanResult {
  ok: boolean;
  plan: ImportPlan | null;
  fileName: string;
  reason: string;
}

/** 确认导入后的落盘结果。 */
export interface ImportApplyResult {
  ok: boolean;
  appended: number;
  skipped: number;
  conflict: number;
  invalid: number;
  /** 实际追加到的绝对路径（按日期，去重后顺序稳定）。 */
  files: string[];
  reason: string;
}

/** 导出目录的绝对路径（不保证已存在）。 */
export function exportsDirPath(): string {
  return `${scheduleStore.getFilesDir()}/${EXPORTS_DIR_NAME}`;
}

/** 文件是否存在（不抛）。 */
function fileExists(path: string): boolean {
  try {
    return fs.accessSync(path);
  } catch {
    return false;
  }
}

/** 确保目录存在（幂等；失败抛中文 Error）。 */
function ensureDir(dir: string): void {
  if (fileExists(dir)) {
    return;
  }
  try {
    fs.mkdirSync(dir, true);
  } catch (error) {
    throw new Error(`创建导出目录失败（${dir}）：${describeError(error)}`);
  }
}

/** 覆盖写一个文本文件（只在「本次新建的导出文件」上用）。 */
function writeTextFile(path: string, text: string): void {
  const file = fs.openSync(path, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
  try {
    fs.writeSync(file.fd, text);
  } finally {
    fs.closeSync(file);
  }
}

/**
 * 在文件末尾**物理追加**文本（与 `scheduleStore` 的追加方式一致：定位到末尾写入）。
 *
 * 不复用 `scheduleStore.appendRecord` 的原因：那条路一次只能写一条记录，而导入要求
 * 「同一天多条按 ts 排序后一次追加」；这里保持同一套语义（末尾写入、必要时补换行），
 * 只是把多行拼成一次写。派生索引由调用方用 `openIndexStore.applyRecord` 补上。
 */
function appendTextAtEnd(path: string, text: string): void {
  const file = fs.openSync(path, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE);
  try {
    const stat = fs.statSync(path);
    let offset = stat.size;
    if (offset > 0) {
      const tailBuffer = new ArrayBuffer(1);
      fs.readSync(file.fd, tailBuffer, { offset: offset - 1, length: 1 });
      if (new Uint8Array(tailBuffer)[0] !== NEW_LINE_BYTE) {
        fs.writeSync(file.fd, '\n', { offset: offset });
        offset += 1;
      }
    }
    fs.writeSync(file.fd, text, { offset: offset });
  } finally {
    fs.closeSync(file);
  }
}

/** 取一个未被占用的导出路径（同名按 `-2` / `-3` 递增；不用随机数，可复现）。 */
function uniqueExportPath(format: string, stamp: string): string {
  const dir = exportsDirPath();
  ensureDir(dir);
  const base = exportFileName(format, stamp);
  const first = `${dir}/${base}`;
  if (!fileExists(first)) {
    return first;
  }
  const dot = base.lastIndexOf('.');
  const stem = dot < 0 ? base : base.slice(0, dot);
  const suffix = dot < 0 ? '' : base.slice(dot);
  for (let sequence = 2; sequence <= MAX_FILE_SEQUENCE; sequence++) {
    const candidate = `${dir}/${stem}-${sequence}${suffix}`;
    if (!fileExists(candidate)) {
      return candidate;
    }
  }
  throw new Error(`导出目录里同名文件太多（${base}），请先清理 ${dir}`);
}

/**
 * 导出某日期区间的日程（只读派生，绝不动源文件）。
 *
 * 成功：返回可读绝对路径 + 记录条数（**空区间也成功**，产出只有标题与占位行的文件）；
 * 失败：`ok:false` + 中文原因（存储未初始化 / 区间非法 / 写盘失败），不抛异常给 UI。
 */
export function exportSchedules(request: ExportRequestInput): ExportFileResult {
  const failed = (reason: string): ExportFileResult => {
    const result: ExportFileResult = {
      ok: false,
      path: '',
      fileName: '',
      chars: 0,
      recordCount: 0,
      reason: reason
    };
    return result;
  };
  if (!scheduleStore.isReady()) {
    return failed('日程存储尚未初始化：请先调用 scheduleStore.ensureReady(context)');
  }
  const range = parseDateRange(request.from, request.to);
  if (!range.ok) {
    return failed(range.reason);
  }
  const format = normalizeExportFormat(request.format);
  let records: ScheduleRecord[] = [];
  try {
    records = scheduleStore.readAll();
  } catch (error) {
    return failed(`读取本机日程失败：${describeError(error)}`);
  }
  const inRange = exportRecordsInRange(records, range.from, range.to);
  const at = nowIso();
  let content: string = '';
  try {
    if (format === EXPORT_FORMAT_JSON) {
      const jsonInput: JsonExportInput = {
        from: range.from,
        to: range.to,
        deviceId: scheduleStore.getDeviceId(),
        records: inRange,
        exportedAt: at
      };
      content = buildJsonExport(jsonInput);
    } else {
      const markdownInput: MarkdownExportInput = {
        from: range.from,
        to: range.to,
        records: inRange,
        includeAttachments: request.includeAttachments === true,
        includeMeta: request.includeMeta === true
      };
      content = renderMarkdownExport(markdownInput);
    }
  } catch (error) {
    return failed(`生成导出内容失败：${describeError(error)}`);
  }
  const stampInput: ExportFileStampInput = { records: inRange, now: at };
  const stamp = exportFileStamp(stampInput);
  try {
    const path = uniqueExportPath(format, stamp);
    writeTextFile(path, content);
    const fileName = path.slice(path.lastIndexOf('/') + 1);
    const ok: ExportFileResult = {
      ok: true,
      path: path,
      fileName: fileName,
      chars: content.length,
      recordCount: inRange.length,
      reason: ''
    };
    return ok;
  } catch (error) {
    return failed(`写入导出文件失败：${describeError(error)}`);
  }
}

/** URI 里取文件名（`.../求职%20简历.json` → 解码后的文件名）。 */
function fileNameOfUri(uri: string): string {
  const text = typeof uri === 'string' ? uri : '';
  const cut = text.lastIndexOf('/');
  const name = cut < 0 ? text : text.slice(cut + 1);
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

/** 读一个用户选中的文件（URI / 沙箱路径都行）；超过 `MAX_IMPORT_BYTES` 直接拒绝。 */
function readTextFromUri(uri: string): string {
  const file = fs.openSync(uri, fs.OpenMode.READ_ONLY);
  try {
    const stat = fs.statSync(file.fd);
    const size = stat.size;
    if (size <= 0) {
      return '';
    }
    if (size > MAX_IMPORT_BYTES) {
      throw new Error(`文件太大（${size} 字节，上限 ${MAX_IMPORT_BYTES} 字节）`);
    }
    const buffer = new ArrayBuffer(size);
    const read = fs.readSync(file.fd, buffer);
    return decodeUtf8(new Uint8Array(buffer, 0, read));
  } finally {
    fs.closeSync(file);
  }
}

/**
 * 让用户选一份 JSON 导出文件并读成字符串。
 *
 * 用系统文件选择器（`@kit.CoreFileKit` 的 `picker`），**不新增任何权限**；
 * 用户取消 / 读取失败都返回 `ok:false`（`reason` 为中文），由面板展示。
 */
export async function pickImportFile(context: object): Promise<ImportFilePickResult> {
  const failed = (reason: string): ImportFilePickResult => {
    const result: ImportFilePickResult = { ok: false, uri: '', fileName: '', text: '', reason: reason };
    return result;
  };
  try {
    const documentPicker = new picker.DocumentViewPicker(context as common.UIAbilityContext);
    const options = new picker.DocumentSelectOptions();
    options.maxSelectNumber = 1;
    options.fileSuffixFilters = ['JSON 文件|.json'];
    const selected: string[] = await documentPicker.select(options);
    if (selected.length === 0) {
      return failed('没有选择文件');
    }
    const uri = selected[0];
    const text = readTextFromUri(uri);
    const ok: ImportFilePickResult = {
      ok: true,
      uri: uri,
      fileName: fileNameOfUri(uri),
      text: text,
      reason: ''
    };
    return ok;
  } catch (error) {
    return failed(`选择或读取文件失败：${describeError(error)}`);
  }
}

/**
 * 只做 dry-run：解析导入文本 + 与本机记录比对，产出 `ImportPlan`（**一个字节都不写**）。
 *
 * 页面拿到它之后把四个计数渲染给用户，用户点「确认导入」才调 `appendImportPlan`。
 * 文件本身不可用（空 / 不是 JSON / 版本不认识）时 `ok:false`，`plan` 为 null。
 */
export function planImportFromText(text: string, fileName: string): ImportPlanResult {
  if (!scheduleStore.isReady()) {
    const notReady: ImportPlanResult = {
      ok: false,
      plan: null,
      fileName: fileName,
      reason: '日程存储尚未初始化：请先调用 scheduleStore.ensureReady(context)'
    };
    return notReady;
  }
  const parsed = parseJsonImport(text);
  if (!parsed.ok) {
    const rejected: ImportPlanResult = { ok: false, plan: null, fileName: fileName, reason: parsed.reason };
    return rejected;
  }
  let existing: ScheduleRecord[] = [];
  try {
    existing = scheduleStore.readAll();
  } catch (error) {
    const readFailed: ImportPlanResult = {
      ok: false,
      plan: null,
      fileName: fileName,
      reason: `读取本机日程失败：${describeError(error)}`
    };
    return readFailed;
  }
  const plan = planImport({ existing: existing, incoming: parsed.records, now: nowIso() });
  const ok: ImportPlanResult = { ok: true, plan: plan, fileName: fileName, reason: '' };
  return ok;
}

/** 把 `plan.toAppend` 按日期分组（组内按 `ts` 稳定升序）。 */
function groupByDate(records: ScheduleRecord[]): Map<string, ScheduleRecord[]> {
  const grouped = new Map<string, ScheduleRecord[]>();
  for (const record of records) {
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
 * 确认导入：把 dry-run 里 `added` 的记录追加到本设备当天的 JSONL 末尾。
 *
 * 安全性质（逐条对应 `docs/EXPORT-IMPORT.md` §3.3）：
 * - 只写 `plan.toAppend`：`conflict` / `skipped` / `invalid` 一律不写（**绝不覆盖**既有行）；
 * - 只写 `scheduleStore.dayFilePath(date)`：即 `<self>/schedules/<date>.jsonl`，别的设备目录永不触碰；
 * - **先编码、后落盘**：任意一条编码失败 → 整批返回 `ok:false`，一个字节都不写；
 * - 同一天的多条按 `ts` 升序拼成一次物理追加；
 * - 追加成功后调用 `openIndexStore.applyRecord` 维护未完成索引（派生数据，失败不影响已写入的记录）。
 */
export function appendImportPlan(plan: ImportPlan): ImportApplyResult {
  const failed = (reason: string): ImportApplyResult => {
    const result: ImportApplyResult = {
      ok: false,
      appended: 0,
      skipped: plan.skipped,
      conflict: plan.conflict,
      invalid: plan.invalid,
      files: [],
      reason: reason
    };
    return result;
  };
  if (!scheduleStore.isReady()) {
    return failed('日程存储尚未初始化：请先调用 scheduleStore.ensureReady(context)');
  }
  if (plan.toAppend.length === 0) {
    const empty: ImportApplyResult = {
      ok: true,
      appended: 0,
      skipped: plan.skipped,
      conflict: plan.conflict,
      invalid: plan.invalid,
      files: [],
      reason: ''
    };
    return empty;
  }

  // 第一步：把每个日期要写的内容全部编码好（任何一条失败就整批放弃，绝不半写）。
  const grouped = groupByDate(plan.toAppend);
  const payloads = new Map<string, string>();
  const orderedDates: string[] = [];
  try {
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
    return failed(`导入内容不合法，整批未写入：${describeError(error)}`);
  }
  if (orderedDates.length === 0) {
    return failed('导入内容为空，未写入任何文件');
  }

  // 第二步：逐日一次物理追加。
  const files: string[] = [];
  let appended = 0;
  try {
    scheduleStore.ensureDirs();
    for (const date of orderedDates) {
      const text = payloads.get(date);
      if (text === undefined) {
        continue;
      }
      const path = scheduleStore.dayFilePath(date);
      appendTextAtEnd(path, text);
      files.push(path);
      const bucket = grouped.get(date);
      if (bucket !== undefined) {
        appended += bucket.length;
      }
    }
  } catch (error) {
    const partial: ImportApplyResult = {
      ok: false,
      appended: appended,
      skipped: plan.skipped,
      conflict: plan.conflict,
      invalid: plan.invalid,
      files: files,
      reason: `追加导入记录失败（已写入 ${files.length} 个文件）：${describeError(error)}`
    };
    return partial;
  }

  // 第三步：派生索引维护（失败只影响索引，不影响已落盘的日程）。
  for (const record of plan.toAppend) {
    openIndexStore.applyRecord(record);
  }

  const ok: ImportApplyResult = {
    ok: true,
    appended: appended,
    skipped: plan.skipped,
    conflict: plan.conflict,
    invalid: plan.invalid,
    files: files,
    reason: ''
  };
  return ok;
}
