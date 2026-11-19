/**
 * 导出 / 导入的**文件 IO 适配层**（唯一碰磁盘的地方）。
 *
 * 纯逻辑在 `model/exportImport.ts`（可 Node 跑）；本文件只负责：
 * 1. **导出**：把渲染好的文本写到应用沙箱 `<filesDir>/exports/schedule-YYYYMMDD-HHmm.<md|json>`，
 *    文件名时间戳来自**记录**（`exportFileStamp`），同名时加 `-2` / `-3` 后缀（不用随机数）；
 * 2. **选文件 + 读文本**：`picker.DocumentViewPicker` 选一份 JSON，用 `openSync` + `readSync` +
 *    `decodeUtf8` 读成字符串（不新增权限）；
 * 3. **导入落盘**：先**复核**（重读本机 + `reconcileBeforeAppend`）再按复核后的 added 追加，
 *    **绝不重写历史行、绝不写别的设备目录**，并且在飞时拒绝第二次调用（并发闸）。
 *
 * 边界（`docs/EXPORT-IMPORT.md` §5）：
 * - 导出是只读派生：只读 `scheduleStore.readAll()`，不碰源文件；导出目录是**沙箱内**路径，
 *   不进 Git 仓库（`devices/` 之外），所以不会被同步推走；
 * - 导入**必须**先 `planImportFromText` 拿到 dry-run 结果，再由用户确认后 `appendImportPlan`；
 *   本模块不提供「分析+落盘」一步到位的函数，防止 UI 误用成「选了文件就写」；
 * - 落盘的**纯实现**在 `model/exportImport.ts` 的 `writePlan`（IO 由本文件注入，可 fake 测）；
 *   整批写入前先把所有行编码完：任何一条编码失败就整批不写（fail-closed），
 *   不会出现「写了一半」的历史日志；
 * - 同一天多条按 `ts` 升序拼接后**一次**物理追加（定位到文件末尾写入），历史字节一个都不改。
 */
import { fileIo as fs, picker } from '@kit.CoreFileKit';
import { common } from '@kit.AbilityKit';
import { nowIso } from '../common/date';
import {
  EXPORT_FORMAT_JSON,
  V2_LEDGER_CONFLICTS,
  V2_LEDGER_FILES,
  V2_LEDGER_RESTORE,
  V2_REFUSAL_BUNDLE_CORRUPT,
  V2_REFUSAL_MEDIA_CORRUPT,
  V2_REFUSAL_MEDIA_COLLISION,
  V2_REFUSAL_TARGET_BUSY,
  V2_REFUSAL_V1_TARGET,
  buildV2Manifest,
  buildV2RecordsText,
  checkV2MediaIntegrity,
  decodeUtf8,
  mergeV2LedgerText,
  v2PlanNotes,
  v2Utf8ByteLength,
  exportFileName,
  exportFileStamp,
  exportRecordsInRange,
  buildJsonExport,
  normalizeExportFormat,
  parseDateRange,
  parseJsonImport,
  parseV2Manifest,
  planImport,
  planV2Import,
  reconcileBeforeAppend,
  renderMarkdownExport,
  v2PlanSummary,
  writePlan
} from '../model/exportImport';
import type {
  ExportStampInput,
  ImportPlan,
  ImportWriteIo,
  JsonExportInput,
  MarkdownExportInput,
  ReconcileResult,
  V2BundleDay,
  V2BundleDayInput,
  V2BundleMedia,
  V2ImportPlan,
  V2LedgerInput,
  V2LedgerKind,
  V2LedgerMeta,
  V2Manifest,
  V2TargetState,
  WritePlanResult
} from '../model/exportImport';
import type { ScheduleRecord } from '../model/types';
import type { TimelineMedia } from '../model/timeline';
import { describeError, scheduleStore } from './scheduleStore';
import { openIndexStore } from './openIndexStore';
import { timelineStore } from './timelineStore';
import { timelineWriteStore } from './timelineWriteStore';

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

/** 复核计数（`reconfirmed`）：写盘前用**此刻**的本机记录重算出来的归属。 */
export interface ReconfirmedCounts {
  /** 复核后真正交给写入的条数（实际写下多少见 `appended`）。 */
  added: number;
  /** 复核新增的「同 id 且更旧/相同」条数。 */
  skipped: number;
  /** 复核新增的「同 id 且本机版本较旧、导入版本更新」条数（仍不覆盖）。 */
  conflict: number;
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
  /**
   * 写盘前复核的计数（`reconcileBeforeAppend` 的结果）。
   *
   * 顶层的 `skipped` / `conflict` 已把这里的增量加进去（它们是**这一次确认**的最终归属），
   * `reconfirmed` 单独留一份，便于面板区分「dry-run 时的统计」与「复核后的统计」。
   * 未做复核时（存储未 ready / 计划为空 / 复核读盘失败）三个数都是 0。
   */
  reconfirmed: ReconfirmedCounts;
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
  const stampInput: ExportStampInput = { records: inRange, now: at };
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
 * 读一本账本的原文（**逐字节搬运**：不做 JSON 解析、不重排、不裁剪）。
 * 文件不存在按空串处理（契约 §10：空账本也要建文件，但旧 bundle / 手工拼装可能缺文件）。
 */
function v2ReadLedgerText(path: string): string {
  if (!fileExists(path)) {
    return '';
  }
  return readTextFromUri(path);
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

/**
 * 把纯逻辑层的 `writePlan` 接到真实文件系统上（本文件是**唯一**提供 IO 的地方）。
 *
 * 只交出这四个能力：建目录 / 取本机某天路径 / 末尾追加 / 维护派生索引。
 * 没有覆盖写、没有截断写、没有删除——导入在类型层面就碰不到 `TRUNC`。
 */
function importWriteIo(): ImportWriteIo {
  const io: ImportWriteIo = {
    ensureDirs: (): void => {
      scheduleStore.ensureDirs();
    },
    dayFilePath: (date: string): string => scheduleStore.dayFilePath(date),
    appendTextAtEnd: (path: string, text: string): void => {
      appendTextAtEnd(path, text);
    },
    applyRecord: (record: ScheduleRecord): void => {
      openIndexStore.applyRecord(record);
    }
  };
  return io;
}

/**
 * 导入落盘的**并发闸**。
 *
 * 为什么需要：`appendImportPlan` 是同步函数，两次极快的点击（或一次点击 + 一次重渲染前的
 * 重复派发）可以在 ArkUI 把按钮置灰之前把它调两次 → 同一批被追加两遍。
 * 这里**不排队**：在飞时的第二次调用直接返回 `ok:false`（排队只会把两次写都排上，
 * 而且让「第二次到底该写什么」重新变回一个需要推理的问题）。
 */
let importInFlight: boolean = false;

/** 复核计数（未做复核时三个数都是 0）。 */
function noReconfirmed(): ReconfirmedCounts {
  const counts: ReconfirmedCounts = { added: 0, skipped: 0, conflict: 0 };
  return counts;
}

/**
 * 确认导入：把 dry-run 里 `added` 的记录追加到本设备当天的 JSONL 末尾。
 *
 * 安全性质（逐条对应 `docs/EXPORT-IMPORT.md` §3.3）：
 * - **并发闸**：在飞时再次调用直接返回 `ok:false`（`reason='正在导入中，请稍候'`），不排队；
 * - **写盘前复核**：用 `scheduleStore.readAll()` 重读**此刻**的本机记录，再用
 *   `reconcileBeforeAppend` 对 `plan.toAppend` 过滤一次——只有复核后的 `added` 才会被写。
 *   于是「双击」「dry-run 之后本机（或远端同步）写入了同一个 id」都不会重复追加；
 * - 只写复核后的 added（`conflict` / `skipped` / `invalid` 一律不写，**绝不覆盖**既有行）；
 * - 只写 `scheduleStore.dayFilePath(date)`：别的设备目录永不触碰；
 * - **先编码、后落盘** + **同一天多条只追加一次**：都在纯逻辑 `writePlan` 里，
 *   并由 `tools/test/exportImport.test.mjs` 的 fake-IO 契约测试逐条钉住。
 */
export function appendImportPlan(plan: ImportPlan): ImportApplyResult {
  if (importInFlight) {
    const busy: ImportApplyResult = {
      ok: false,
      appended: 0,
      skipped: plan.skipped,
      conflict: plan.conflict,
      invalid: plan.invalid,
      files: [],
      reason: '正在导入中，请稍候',
      reconfirmed: noReconfirmed()
    };
    return busy;
  }
  importInFlight = true;
  try {
    return applyImportPlanOnce(plan);
  } finally {
    importInFlight = false;
  }
}

/** `appendImportPlan` 的单次实现（进入时并发闸已置位，退出时由调用方复位）。 */
function applyImportPlanOnce(plan: ImportPlan): ImportApplyResult {
  const failed = (reason: string): ImportApplyResult => {
    const result: ImportApplyResult = {
      ok: false,
      appended: 0,
      skipped: plan.skipped,
      conflict: plan.conflict,
      invalid: plan.invalid,
      files: [],
      reason: reason,
      reconfirmed: noReconfirmed()
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
      reason: '',
      reconfirmed: noReconfirmed()
    };
    return empty;
  }

  // 第一步：复核——写盘前重读本机记录；读不到就 fail-closed，绝不凭一份过期计划写盘。
  let existingNow: ScheduleRecord[] = [];
  try {
    existingNow = scheduleStore.readAll();
  } catch (error) {
    return failed(`导入复核失败（读取本机日程）：${describeError(error)}`);
  }
  const reconciled: ReconcileResult = reconcileBeforeAppend(plan.toAppend, existingNow);
  const counts: ReconfirmedCounts = {
    added: reconciled.added.length,
    skipped: reconciled.skipped,
    conflict: reconciled.conflict
  };
  if (reconciled.added.length === 0) {
    // 复核后没有一条还该写（典型：双击的第二下、或本机刚同步到同 id 的更新版本）。
    const nothing: ImportApplyResult = {
      ok: true,
      appended: 0,
      skipped: plan.skipped + reconciled.skipped,
      conflict: plan.conflict + reconciled.conflict,
      invalid: plan.invalid,
      files: [],
      reason: '',
      reconfirmed: counts
    };
    return nothing;
  }

  // 第二步：真正落盘（编码 → 逐日一次追加 → 派生索引），全部在纯逻辑 `writePlan` 里。
  const written: WritePlanResult = writePlan(reconciled.added, importWriteIo());
  const result: ImportApplyResult = {
    ok: written.ok,
    appended: written.appended,
    skipped: plan.skipped + reconciled.skipped,
    conflict: plan.conflict + reconciled.conflict,
    invalid: plan.invalid,
    files: written.files,
    reason: written.reason,
    reconfirmed: counts
  };
  return result;
}

// ================================================================ v2 单时间线导出 / 导入（additive）
//
// 只在 `timelineStore.useV2()` 为真时可用；v1 的 exportSchedules / planImportFromText /
// appendImportPlan 一节一行未改。v2 bundle 落在沙箱 `<filesDir>/exports/v2-<stamp>/`，
// **不在 git 仓库里**；导入只经 `timelineWriteStore`（原子写 records.json / summary.json）
// 与 media/ 只增复制，绝不写 devices/**、绝不删媒体；三本账本按 bundleVersion 做**并集追加**
// （目标已有账本字节恒为新字节前缀，只追加新行，绝不重写历史行，见 docs/EXPORT-IMPORT.md §7）。
//
// 关键纪律：
// - 导出：读侧复用 timelineStore.readDay（已套用 deleted/restore 优先级）+ readSummaryText，
//   日文件字节由 model/timelineWrite.buildRecordsText 生成（按 ts,id 排序 + 自检）；
// - 导入：先 dry-run（planV2Import，默认不写），`applyV2Import` 必须显式调用才落盘；
//   落盘前再查一次门禁（dry-run 到确认之间状态可能变了），并逐条复核「绝不覆盖更晚版本」；
// - 媒体完整性（P1-1 / P2 碰撞）：**任何写入之前**统一跑 `checkV2MediaIntegrity`：
//   * 内容 sha256 不符 / 读不出 → E_MEDIA_CORRUPT；
//   * 同日同名不同内容（含目标已有错误旧图） → E_MEDIA_COLLISION；
//   选 "fail closed before any write" 而非"逐日回滚"：records/summary 与 media 分属不同文件，
//   没有跨文件事务；回滚要处理已 rename 的原子写，复杂且易错。预检失败 = 整包零写入。
//   校验读到的字节原样写入，避免"验完再读"的竞态；已存在且内容一致的同名媒体只增不覆盖。

/** v2 bundle 目录前缀（沙箱 exports/ 下，与 v1 的 schedule-*.md/json 并列）。 */
const V2_BUNDLE_DIR_PREFIX: string = 'v2-';
/** bundle 内的文件名。 */
const V2_MANIFEST_FILE: string = 'manifest.json';
const V2_RECORDS_FILE: string = 'records.json';
const V2_SUMMARY_FILE: string = 'summary.json';
const V2_MEDIA_DIR: string = 'media';
/** 仓库内 v2 时间线根（相对 filesDir）。 */
const V2_REPO_RELATIVE: string = 'git-repo/timeline';
/** 裸媒体文件名（与 model 的 V2_MEDIA_FILE_RE 同口径）。 */
const V2_MEDIA_FILE_RE: RegExp = /^[0-9a-f]{16}\.jpg$/;

/** 导出一日已准备好的字节（manifest 之外，直接写进 bundle）。 */
interface V2PreparedDay {
  date: string;
  recordsText: string;
  summaryText: string;
  mediaNames: string[];
  /** 三本账本原文（逐字节搬运，空账本为空串但仍在 bundle 里建文件）。 */
  ledgers: V2LedgerInput[];
}

/** v2 记录的服务层视图（v2 扩展字段可选，读取一律 typeof / Array.isArray 收窄）。 */
interface V2RecordWithMedia extends ScheduleRecord {
  media?: TimelineMedia[];
}

/** 写盘时把 TimelineRecord 桥接回 ScheduleRecord（结构体是超集，显式声明避免 ArkTS 类型摩擦）。 */
interface V2ScheduleBridge extends ScheduleRecord {
  media?: TimelineMedia[];
  opened_at?: string;
  closed_at?: string;
}

/** v2 导出结果（失败也返回对象，code 为类型化原因或空串）。 */
export interface V2ExportResult {
  ok: boolean;
  code: string;
  reason: string;
  dirPath: string;
  manifestPath: string;
  days: number;
  records: number;
  media: number;
  bytes: number;
}

/** v2 导入 dry-run 结果（plan 为 null 表示不可用；summary 是可直接展示的中文计划行）。 */
export interface V2ImportPlanResult {
  ok: boolean;
  code: string;
  reason: string;
  plan: V2ImportPlan | null;
  bundleDir: string;
  summary: string;
}

/** v2 确认导入后的落盘结果。 */
export interface V2ApplyResult {
  ok: boolean;
  code: string;
  reason: string;
  days: number;
  records: number;
  media: number;
  skipped: number;
  files: string[];
}

/** 列出某日 media/ 下文件名合法的散图（缺目录 / 读失败都返回空，不抛）。 */
function v2ListMedia(dayDir: string): string[] {
  const names: string[] = [];
  try {
    const mediaDir = `${dayDir}/${V2_MEDIA_DIR}`;
    if (!fileExists(mediaDir)) {
      return names;
    }
    const listed: string[] = fs.listFileSync(mediaDir);
    for (const name of listed) {
      if (V2_MEDIA_FILE_RE.test(name)) {
        names.push(name);
      }
    }
    names.sort();
  } catch {
    // 媒体目录读失败视为该日没有可搬运媒体，交给导入侧按 E_MEDIA_MISSING 拒绝。
  }
  return names;
}

/** 二进制文件复制（只在目标不存在时调用；不截断、不覆盖、不删任何文件）。 */
function v2CopyBinary(src: string, dest: string): void {
  let reader: fs.File | null = null;
  let writer: fs.File | null = null;
  try {
    reader = fs.openSync(src, fs.OpenMode.READ_ONLY);
    const size: number = fs.statSync(src).size;
    const buffer = new ArrayBuffer(size);
    const read: number = fs.readSync(reader.fd, buffer);
    writer = fs.openSync(dest, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE);
    fs.writeSync(writer.fd, buffer, { length: read });
  } finally {
    if (writer !== null) {
      fs.closeSync(writer);
    }
    if (reader !== null) {
      fs.closeSync(reader);
    }
  }
}

/**
 * 读一个媒体文件的全部字节（**只供落盘前 sha256 预检**；不可读 / 过大抛中文 Error，
 * 由 `checkV2MediaIntegrity` 收窄为 E_MEDIA_CORRUPT）。
 */
function v2ReadBinary(path: string): Uint8Array {
  const file = fs.openSync(path, fs.OpenMode.READ_ONLY);
  try {
    const size: number = fs.statSync(file.fd).size;
    if (size < 0 || size > MAX_IMPORT_BYTES) {
      throw new Error(`媒体文件过大（${size} 字节，上限 ${MAX_IMPORT_BYTES} 字节）`);
    }
    const buffer = new ArrayBuffer(size);
    let read: number = 0;
    if (size > 0) {
      read = fs.readSync(file.fd, buffer);
    }
    return new Uint8Array(buffer, 0, read);
  } finally {
    fs.closeSync(file);
  }
}

/** 写入**已通过 sha256 预检**的媒体字节（只在目标不存在时调用；不 TRUNC、不覆盖、不删）。 */
function v2WriteBinary(dest: string, bytes: Uint8Array): void {
  const file = fs.openSync(dest, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE);
  try {
    const exact = new ArrayBuffer(bytes.length);
    new Uint8Array(exact).set(bytes);
    fs.writeSync(file.fd, exact);
  } finally {
    fs.closeSync(file);
  }
}

/** URI 所在目录（picker 选中 manifest.json 后，兄弟文件都在同一 bundle 目录下）。 */
function v2DirOfUri(uri: string): string {
  const cut: number = typeof uri === 'string' ? uri.lastIndexOf('/') : -1;
  return cut < 0 ? '' : uri.slice(0, cut);
}

/** 取一个未被占用的 bundle 目录（同名加 -2 / -3；不用随机数，可复现）。 */
function uniqueV2BundleDir(stamp: string): string {
  const parent = exportsDirPath();
  ensureDir(parent);
  const base = `${V2_BUNDLE_DIR_PREFIX}${stamp}`;
  const first = `${parent}/${base}`;
  if (!fileExists(first)) {
    return first;
  }
  for (let sequence = 2; sequence <= MAX_FILE_SEQUENCE; sequence++) {
    const candidate = `${parent}/${base}-${sequence}`;
    if (!fileExists(candidate)) {
      return candidate;
    }
  }
  throw new Error(`v2 备份目录里同名目录太多（${base}），请先清理 ${parent}`);
}

/** 从 timelineStore / timelineWriteStore 读取当前门禁状态。 */
function v2TargetState(): V2TargetState {
  const state: V2TargetState = {
    repoIsV2: timelineStore.isV2(),
    writeEnabled: timelineWriteStore.isEnabled()
  };
  return state;
}

/** ts 比较：可解析按时刻，否则字符串序（与 model 的 planImport 同口径）。 */
function v2TsAfter(candidate: string, baseline: string): boolean {
  const left: number = Date.parse(candidate);
  const right: number = Date.parse(baseline);
  if (!Number.isNaN(left) && !Number.isNaN(right)) {
    return left > right;
  }
  return candidate > baseline;
}

/** ts 形状规范化为导出文件名时间戳（取记录里最新 ts，无记录用零值，保证同数据同名）。 */
function v2StampOf(latestTs: string): string {
  if (latestTs.length === 0) {
    return '00000000-0000';
  }
  const stampInput: ExportStampInput = { records: [], now: latestTs };
  const stamp: string = exportFileStamp(stampInput);
  return stamp.length > 0 ? stamp : '00000000-0000';
}

/**
 * v2 导出：把共享时间线搬运成一份**只读派生** bundle（不碰 timeline/ 源文件）。
 *
 * 非 v2（v1 仓库 / 未激活）直接返回 E_V1_TARGET；区间非法 / 读取失败都返回 ok:false + 中文原因。
 */
export function exportV2Timeline(request: ExportRequestInput): V2ExportResult {
  const failed = (code: string, reason: string): V2ExportResult => {
    const result: V2ExportResult = {
      ok: false, code: code, reason: reason, dirPath: '', manifestPath: '',
      days: 0, records: 0, media: 0, bytes: 0
    };
    return result;
  };
  if (!timelineStore.useV2()) {
    return failed(V2_REFUSAL_V1_TARGET, '当前不是 v2 时间线模式：请激活 v2 后再导出时间线备份');
  }
  if (!scheduleStore.isReady()) {
    return failed('', '日程存储尚未初始化：请先调用 scheduleStore.ensureReady(context)');
  }
  const range = parseDateRange(request.from, request.to);
  if (!range.ok) {
    return failed('', range.reason);
  }
  const dates: string[] = [];
  for (const date of timelineStore.listDates()) {
    if (date >= range.from && date <= range.to) {
      dates.push(date);
    }
  }
  const prepared: V2PreparedDay[] = [];
  const dayEntries: V2BundleDay[] = [];
  const mediaEntries: V2BundleMedia[] = [];
  let latestTs: string = '';
  let totalRecords: number = 0;
  let totalBytes: number = 0;
  const repoRoot = `${scheduleStore.getFilesDir()}/${V2_REPO_RELATIVE}`;
  try {
    for (const date of dates) {
      const records: ScheduleRecord[] = timelineStore.readDay(date);
      const recordsText: string = buildV2RecordsText(date, records);
      if (recordsText.length === 0) {
        return failed(V2_REFUSAL_BUNDLE_CORRUPT, `导出 ${date} 的 records.json 规范化失败（自检未通过）`);
      }
      const summaryText: string = timelineStore.readSummaryText(date);
      const shaByFile = new Map<string, string>();
      for (const record of records) {
        const at: number = Date.parse(record.ts);
        if (!Number.isNaN(at) && (latestTs.length === 0 || at > Date.parse(latestTs))) {
          latestTs = record.ts;
        }
        const withMedia: V2RecordWithMedia = record as V2RecordWithMedia;
        const items: TimelineMedia[] | undefined = withMedia.media;
        if (Array.isArray(items)) {
          for (const item of items) {
            shaByFile.set(item.file, item.sha256);
          }
        }
      }
      const mediaNames: string[] = [];
      for (const name of v2ListMedia(`${repoRoot}/${date}/${V2_MEDIA_DIR}`)) {
        const sha: string | undefined = shaByFile.get(name);
        if (sha === undefined || sha.length === 0) {
          // 未被引用的孤立散图不进 bundle（仓库里的媒体一个都不删）。
          continue;
        }
        const size: number = fs.statSync(`${repoRoot}/${date}/${V2_MEDIA_DIR}/${name}`).size;
        mediaEntries.push({ file: name, sha256: sha, bytes: size, date: date });
        mediaNames.push(name);
        totalBytes += size;
      }
      // 三本账本逐字节搬运（§7 P2-3：源文件 append-only、绝不重写历史行）。
      // 空账本也进 bundle（契约 §10：按日新建账本，故空文件也要写），manifest 记字节数。
      const ledgers: V2LedgerInput[] = [];
      const ledgerMetas: V2LedgerMeta[] = [];
      for (const name of V2_LEDGER_FILES) {
        const text = v2ReadLedgerText(`${repoRoot}/${date}/${name}`);
        ledgers.push({ name: name, text: text });
        ledgerMetas.push({ name: name, bytes: v2Utf8ByteLength(text) });
      }
      totalRecords += records.length;
      dayEntries.push({
        date: date, recordCount: records.length, hasSummary: summaryText.length > 0,
        media: mediaNames, ledgers: ledgerMetas
      });
      prepared.push({ date: date, recordsText: recordsText, summaryText: summaryText, mediaNames: mediaNames, ledgers: ledgers });
    }
  } catch (error) {
    return failed('', `读取 v2 时间线失败：${describeError(error)}`);
  }

  let manifestText: string = '';
  try {
    manifestText = buildV2Manifest({
      from: range.from, to: range.to, exportedAt: latestTs, days: dayEntries, media: mediaEntries
    });
  } catch (error) {
    return failed('', `生成 v2 manifest 失败：${describeError(error)}`);
  }
  try {
    const dir: string = uniqueV2BundleDir(v2StampOf(latestTs));
    ensureDir(dir);
    writeTextFile(`${dir}/${V2_MANIFEST_FILE}`, manifestText);
    for (const day of prepared) {
      const dayDir = `${dir}/timeline/${day.date}`;
      ensureDir(dayDir);
      writeTextFile(`${dayDir}/${V2_RECORDS_FILE}`, day.recordsText);
      if (day.summaryText.length > 0) {
        writeTextFile(`${dayDir}/${V2_SUMMARY_FILE}`, day.summaryText);
      }
      // 三本账本恒写出（空账本为空文件），字节与 manifest 声明逐字对应。
      for (const ledger of day.ledgers) {
        writeTextFile(`${dayDir}/${ledger.name}`, ledger.text);
      }
      if (day.mediaNames.length > 0) {
        const mediaDir = `${dayDir}/${V2_MEDIA_DIR}`;
        ensureDir(mediaDir);
        const srcDir = `${repoRoot}/${day.date}/${V2_MEDIA_DIR}`;
        for (const name of day.mediaNames) {
          v2CopyBinary(`${srcDir}/${name}`, `${mediaDir}/${name}`);
        }
      }
    }
    const ok: V2ExportResult = {
      ok: true, code: '', reason: '', dirPath: dir, manifestPath: `${dir}/${V2_MANIFEST_FILE}`,
      days: prepared.length, records: totalRecords, media: mediaEntries.length, bytes: totalBytes
    };
    return ok;
  } catch (error) {
    return failed('', `写入 v2 备份失败：${describeError(error)}`);
  }
}

/**
 * v2 导入 dry-run（默认不写）：用已选中的 manifest 文本 + 其 URI 定位兄弟文件，
 * 拼好 bundle 后交给纯函数 planV2Import 校验并给出 days/records/media/bytes 计划。
 */
export function planV2ImportFromPicked(text: string, uri: string): V2ImportPlanResult {
  const failed = (code: string, reason: string): V2ImportPlanResult => {
    const result: V2ImportPlanResult = {
      ok: false, code: code, reason: reason, plan: null, bundleDir: v2DirOfUri(uri), summary: ''
    };
    return result;
  };
  const parsed = parseV2Manifest(text);
  if (!parsed.ok || parsed.manifest === null) {
    return failed(parsed.code, parsed.reason);
  }
  const manifest: V2Manifest = parsed.manifest;
  const bundleDir: string = v2DirOfUri(uri);
  const dayInputs: V2BundleDayInput[] = [];
  try {
    for (const day of manifest.days) {
      const dayDir = `${bundleDir}/timeline/${day.date}`;
      const recordsText: string = readTextFromUri(`${dayDir}/${V2_RECORDS_FILE}`);
      const summaryText: string = day.hasSummary ? readTextFromUri(`${dayDir}/${V2_SUMMARY_FILE}`) : '';
      const ledgers: V2LedgerInput[] = [];
      // 旧 bundle（bundleVersion<2）没有账本文件；跳过读取，plan 会返回 informational note。
      if (manifest.bundleVersion >= 2) {
        for (const name of V2_LEDGER_FILES) {
          ledgers.push({ name: name, text: v2ReadLedgerText(`${dayDir}/${name}`) });
        }
      }
      dayInputs.push({
        date: day.date, recordsText: recordsText, summaryText: summaryText,
        mediaFiles: v2ListMedia(`${dayDir}/${V2_MEDIA_DIR}`), ledgers: ledgers
      });
    }
  } catch (error) {
    return failed(V2_REFUSAL_BUNDLE_CORRUPT, `读取 v2 备份文件失败：${describeError(error)}`);
  }
  const plan: V2ImportPlan = planV2Import({ manifestText: text, days: dayInputs }, v2TargetState());
  // informational note（不是拒绝）：记日志 + 随计划行回给面板展示。
  const notes: string = v2PlanNotes(plan);
  if (notes.length > 0) {
    console.info(`[export-v2-ledgers] ${notes}`);
  }
  const result: V2ImportPlanResult = {
    ok: plan.ok,
    code: plan.code,
    reason: plan.reason,
    plan: plan.ok ? plan : null,
    bundleDir: bundleDir,
    summary: v2PlanSummary(plan)
  };
  return result;
}

/** 导入并发闸：在飞时直接拒绝（不排队），退出时复位。 */
let v2ImportInFlight: boolean = false;

function v2ApplyFailure(code: string, reason: string): V2ApplyResult {
  const result: V2ApplyResult = { ok: false, code: code, reason: reason, days: 0, records: 0, media: 0, skipped: 0, files: [] };
  return result;
}

/** 确认导入：把 dry-run 计划显式落盘（必须用户确认后调用）。 */
export function applyV2Import(plan: V2ImportPlan | null, bundleDir: string): V2ApplyResult {
  if (v2ImportInFlight) {
    return v2ApplyFailure('', '正在导入 v2 备份，请稍候');
  }
  v2ImportInFlight = true;
  try {
    return applyV2ImportOnce(plan, bundleDir);
  } finally {
    v2ImportInFlight = false;
  }
}

/** `applyV2Import` 的单次实现（进入时并发闸已置位）。 */
function applyV2ImportOnce(plan: V2ImportPlan | null, bundleDir: string): V2ApplyResult {
  if (plan === null || !plan.ok) {
    const code: string = plan === null ? '' : plan.code;
    const reason: string = plan === null ? '没有待应用的 v2 导入计划' : plan.reason;
    return v2ApplyFailure(code, reason);
  }
  // dry-run 到确认之间状态可能变了：落盘前再查一次门禁（失败即零写入）。
  const target: V2TargetState = v2TargetState();
  if (!target.repoIsV2) {
    return v2ApplyFailure(V2_REFUSAL_V1_TARGET, '目标已不是 v2 仓库：请先迁移，再导入 v2 备份');
  }
  if (!target.writeEnabled) {
    return v2ApplyFailure(V2_REFUSAL_TARGET_BUSY, 'v2 写入路径当前不可用：请检查显式激活开关后重试');
  }
  let days: number = 0;
  let records: number = 0;
  let media: number = 0;
  let skipped: number = 0;
  const files: string[] = [];
  const repoRoot = `${scheduleStore.getFilesDir()}/${V2_REPO_RELATIVE}`;

  // 落盘前媒体完整性预检（fail closed）：失败即 typed 拒绝，整个 bundle 一个字节都不写。
  // 放在所有 records.json / summary.json / media 写入之前，是 P1-1 的核心保证。
  const mediaCheck = checkV2MediaIntegrity(plan, {
    targetExists: (date: string, file: string): boolean =>
      fileExists(`${repoRoot}/${date}/${V2_MEDIA_DIR}/${file}`),
    readTarget: (date: string, file: string): Uint8Array =>
      v2ReadBinary(`${repoRoot}/${date}/${V2_MEDIA_DIR}/${file}`),
    readSource: (date: string, file: string): Uint8Array =>
      v2ReadBinary(`${bundleDir}/timeline/${date}/${V2_MEDIA_DIR}/${file}`)
  });
  if (!mediaCheck.ok) {
    return v2ApplyFailure(mediaCheck.code, mediaCheck.reason);
  }

  for (const day of plan.days) {
    let existing: ScheduleRecord[] = [];
    try {
      existing = timelineStore.readDay(day.date);
    } catch (error) {
      return v2ApplyFailure('', `复核 ${day.date} 的本机记录失败：${describeError(error)}`);
    }
    const latest = new Map<string, string>();
    for (const record of existing) {
      const known: string | undefined = latest.get(record.id);
      if (known === undefined || v2TsAfter(record.ts, known)) {
        latest.set(record.id, record.ts);
      }
    }
    for (const record of day.records) {
      const known: string | undefined = latest.get(record.id);
      if (known !== undefined && !v2TsAfter(record.ts, known)) {
        skipped += 1;
        continue;
      }
      const bridge: V2ScheduleBridge = record as V2ScheduleBridge;
      try {
        timelineWriteStore.append(bridge, day.date);
      } catch (error) {
        return v2ApplyFailure('', `写入 ${day.date} 的记录失败：${describeError(error)}`);
      }
      records += 1;
      latest.set(record.id, record.ts);
      const path = `${repoRoot}/${day.date}/${V2_RECORDS_FILE}`;
      if (files.indexOf(path) < 0) {
        files.push(path);
      }
    }
    const destMediaDir = `${repoRoot}/${day.date}/${V2_MEDIA_DIR}`;
    for (const item of mediaCheck.verified) {
      if (item.date !== day.date) {
        continue;
      }
      const dest = `${destMediaDir}/${item.file}`;
      if (fileExists(dest)) {
        // 媒体只增：预检已确认同名内容一致（不一致的碰撞已提前 typed 拒绝）；再守一次，不覆盖、不删。
        continue;
      }
      try {
        ensureDir(destMediaDir);
        // 写入的是预检时那一份已校验字节，不二次读源文件，避免验后被换。
        v2WriteBinary(dest, item.bytes);
      } catch (error) {
        return v2ApplyFailure(
          V2_REFUSAL_MEDIA_CORRUPT,
          `搬运媒体 ${item.file} 失败：${describeError(error)}`
        );
      }
      media += 1;
    }
    if (day.summaryText.length > 0) {
      try {
        timelineWriteStore.appendSummary(day.date, day.summaryText);
      } catch (error) {
        return v2ApplyFailure('', `写入 ${day.date} 的汇总失败：${describeError(error)}`);
      }
    }
    // 账本并集（bundleVersion>=2 才有）：目标旧字节恒为新字节前缀，只追加备份里没有的新行。
    // delete/restore 按 (id,ts)、conflicts 按 (id,ts,dedupeKey) 去重；绝不截断 / 重写目标账本。
    if (plan.bundleVersion >= 2) {
      for (const ledger of day.ledgers) {
        const dest = `${repoRoot}/${day.date}/${ledger.name}`;
        let targetText: string = '';
        try {
          targetText = v2ReadLedgerText(dest);
        } catch (error) {
          return v2ApplyFailure('', `复核 ${day.date}/${ledger.name} 的既有账本失败：${describeError(error)}`);
        }
        const kind: V2LedgerKind = ledger.name === V2_LEDGER_CONFLICTS
          ? 'conflict'
          : (ledger.name === V2_LEDGER_RESTORE ? 'restore' : 'delete');
        const merged = mergeV2LedgerText(targetText, ledger.text, kind);
        if (merged.toAppend.length === 0) {
          continue; // 全部已在目标里（幂等），零 IO。
        }
        try {
          ensureDir(`${repoRoot}/${day.date}`);
          appendTextAtEnd(dest, merged.toAppend);
        } catch (error) {
          return v2ApplyFailure('', `追加 ${day.date}/${ledger.name} 账本失败：${describeError(error)}`);
        }
      }
    }
    days += 1;
  }
  const ok: V2ApplyResult = { ok: true, code: '', reason: '', days: days, records: records, media: media, skipped: skipped, files: files };
  return ok;
}
