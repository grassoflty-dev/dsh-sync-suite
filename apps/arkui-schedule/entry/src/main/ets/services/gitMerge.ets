/**
 * gitMerge — pull 之后的「记录级 / 附件级」合并接线（A3，薄层）。
 * ============================================================================
 * 分工：
 * - 决策全在纯逻辑层（Node 可测）：`model/recordMerge`（日程 JSONL）、
 *   `model/attachmentMerge`（汇总 / open.jsonl / 按天 zip）。
 * - 本文件只做三件事：**按路径读两侧文本或字节** → 调模型 → 写回工作副本 / 返回结果对象。
 *
 * 「本机」与「工作副本」的边界（本层的核心约定）：
 * - **工作副本** = `<filesDir>/git-repo/devices/<deviceId>/…`，是 git 实际跟踪、pull 会覆盖的那份；
 * - **本机** = `<filesDir>/git-merge/<deviceId>/…`，是 pull **之前**由 `captureBeforePull()` 复制出来的
 *   本机快照。它**刻意放在仓库之外**，因此不会被提交、不会被 pull 覆盖。
 *
 * 为什么需要快照：pull 是 fast-forward（桥里另有 `unionJsonl` 行级兜底），跑完之后「拉取前的本机内容」
 * 只存在于 git 历史里，App 侧已无处可读。所以顺序必须是
 * `captureBeforePull()` → `pull()` → `mergeAfterPull()`；没有快照时本机侧为空，
 * 合并退化为「把工作副本规范化为每 id 一行」，同样安全（不会丢任何 id）。
 *
 * 冲突与安全：
 * - `mergeAfterPull()` 在 `conflictIds` 非空时**不写回**，把两侧规范行交给 UI 让用户选；
 *   用户选完再调 `applyMergeChoice('local' | 'remote')` 落定。
 * - 附件**绝不覆盖**：同名不同内容一律改名保留两份（`planArchiveWrites` 保证新名字不撞名）。
 * - 所有失败只返回 `{ok:false, message}`，**永不抛异常**（同步链路不能被合并拖垮），也不打日志
 *   （services 层禁止 console/hilog，见 `credentialHygiene` 测试）。
 * ============================================================================
 */

import { fileIo as fs } from '@kit.CoreFileKit';
import { normalizeDeviceId } from '../model/syncScope';
import { mergeDayFile } from '../model/recordMerge';
import type { MergeConflictDetail, MergeDayResult } from '../model/recordMerge';
import { mergeOpenIndexTexts, mergeSummaryTexts, planArchiveWrites } from '../model/attachmentMerge';
import type {
  ArchiveExisting,
  ArchiveInput,
  ArchiveWritePlan,
  OpenIndexMergeResult,
  SummaryMergeDecision
} from '../model/attachmentMerge';
import { sha256Hex } from '../model/sha256';
import { scheduleStore } from './scheduleStore';

// ---------------------------------------------------------------- 对外数据结构（UI 契约）

/** 一次合并的摘要（UI 只读这一层；`conflictIds` 非空就要让用户选）。 */
export interface MergeSummary {
  /** 只在本机出现的记录数（远端缺行不当删除，一律保留）。 */
  localOnly: number;
  /** 只在远端出现的记录数（远端新增不丢）。 */
  remoteOnly: number;
  /** 同 id、`ts` 相同而内容不同的条数。 */
  conflicts: number;
  /** 冲突 id（`ts` 升序 → `id` 升序）。 */
  conflictIds: string[];
}

/** 一处冲突的两侧规范行（给「保留本机 / 采用远端」选择器用）。 */
export interface MergeConflictItem {
  id: string;
  ts: string;
  localLine: string;
  remoteLine: string;
}

/** 单日合并结果。 */
export interface MergeDayOutcome {
  date: string;
  ok: boolean;
  /** 是否已把合并结果写回工作副本。 */
  applied: boolean;
  summary: MergeSummary;
  /** 冲突明细（无冲突为空数组）。 */
  conflicts: MergeConflictItem[];
  /** 坏行数（两侧之和）。 */
  errors: number;
  /** 可直接展示的中文结果。 */
  message: string;
}

/** `mergeAfterPull()` / `applyMergeChoice()` 的整体结果。 */
export interface MergeAfterPullResult {
  ok: boolean;
  message: string;
  days: MergeDayOutcome[];
  summary: MergeSummary;
}

/** 合并后新增/保留的附件文件。 */
export interface AttachmentMergeFile {
  name: string;
  /** `local` | `remote` | `base`。 */
  role: string;
}

/** `mergeAttachments()` 的结果。 */
export interface AttachmentMergeResult {
  ok: boolean;
  message: string;
  /** 本次新写出的文件名（改名保留的那一份也在这里）。 */
  written: string[];
  /** 已存在同内容、无需重写的文件名。 */
  kept: string[];
  /** 发生了「同名不同内容 → 保留两份」的份数。 */
  renamed: number;
  files: AttachmentMergeFile[];
}

/** `mergeSummaries()` 的结果。 */
export interface SummaryMergeOutcome {
  ok: boolean;
  message: string;
  /** 实际改写过的日期（`YYYY-MM-DD`）。 */
  written: string[];
  /** 采用远端版本的日期。 */
  adoptedRemote: string[];
  errors: number;
}

/** `mergeOpenIndex()` 的结果。 */
export interface OpenIndexMergeOutcome {
  ok: boolean;
  message: string;
  /** 合并后仍有效的条目数。 */
  merged: number;
  conflicts: number;
  conflictIds: string[];
  /** 是否写回了工作副本。 */
  applied: boolean;
  errors: number;
}

/** `captureBeforePull()` 的结果。 */
export interface CaptureResult {
  ok: boolean;
  message: string;
  /** 复制到快照目录的文件数。 */
  files: number;
}

// ---------------------------------------------------------------- 常量

const SNAPSHOT_ROOT_NAME: string = 'git-merge';
const REPO_DIR_NAME: string = 'git-repo';
const DEVICES_DIR_NAME: string = 'devices';
const SCHEDULES_DIR_NAME: string = 'schedules';
const ATTACHMENTS_DIR_NAME: string = 'attachments';
const SUMMARIES_DIR_NAME: string = 'summaries';
const OPEN_INDEX_NAME: string = 'open.jsonl';
const JSONL_SUFFIX: string = '.jsonl';
const JSON_SUFFIX: string = '.json';
const ZIP_SUFFIX: string = '.zip';
const DATE_KEY_RE: RegExp = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------- 小工具（全部不抛）

function messageOf(error: Object): string {
  if (error instanceof Error) {
    return error.message;
  }
  return '未知错误';
}

function dirnameOf(path: string): string {
  const index: number = path.lastIndexOf('/');
  if (index < 0) {
    return '';
  }
  if (index === 0) {
    return '/';
  }
  return path.substring(0, index);
}

function fileExists(path: string): boolean {
  try {
    return fs.accessSync(path);
  } catch (error) {
    return false;
  }
}

function ensureDir(dir: string): boolean {
  if (dir.length === 0 || fileExists(dir)) {
    return true;
  }
  try {
    fs.mkdirSync(dir, true);
    return true;
  } catch (error) {
    return fileExists(dir);
  }
}

/** 读文本；不存在/读失败返回空串。 */
function readTextOrEmpty(path: string): string {
  if (!fileExists(path)) {
    return '';
  }
  try {
    return fs.readTextSync(path);
  } catch (error) {
    return '';
  }
}

/** 读原始字节；不存在/空文件/读失败返回 `null`。 */
function readBytesOrNull(path: string): Uint8Array | null {
  if (!fileExists(path)) {
    return null;
  }
  let file: fs.File | null = null;
  try {
    const size: number = fs.statSync(path).size;
    if (size <= 0) {
      return null;
    }
    const buffer: ArrayBuffer = new ArrayBuffer(size);
    file = fs.openSync(path, fs.OpenMode.READ_ONLY);
    const readLength: number = fs.readSync(file.fd, buffer);
    if (readLength <= 0) {
      return null;
    }
    const bytes: Uint8Array = new Uint8Array(buffer, 0, readLength);
    const copy: Uint8Array = new Uint8Array(readLength);
    copy.set(bytes);
    return copy;
  } catch (error) {
    return null;
  } finally {
    if (file !== null) {
      try {
        fs.closeSync(file);
      } catch (error) {
        // 关闭失败不影响读取结果
      }
    }
  }
}

/** 整文件覆写文本；成功返回 true。 */
function writeTextFile(path: string, text: string): boolean {
  if (!ensureDir(dirnameOf(path))) {
    return false;
  }
  let file: fs.File | null = null;
  try {
    file = fs.openSync(path, fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC);
    fs.writeSync(file.fd, text);
    return true;
  } catch (error) {
    return false;
  } finally {
    if (file !== null) {
      try {
        fs.closeSync(file);
      } catch (error) {
        // 内容已落盘，关闭失败按成功处理
      }
    }
  }
}

/** 整文件覆写字节；成功返回 true。 */
function writeBytesFile(path: string, bytes: Uint8Array): boolean {
  if (!ensureDir(dirnameOf(path))) {
    return false;
  }
  let file: fs.File | null = null;
  try {
    const copy: Uint8Array = new Uint8Array(bytes.length);
    copy.set(bytes);
    file = fs.openSync(path, fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC);
    if (copy.length > 0) {
      fs.writeSync(file.fd, copy.buffer as ArrayBuffer);
    }
    return true;
  } catch (error) {
    return false;
  } finally {
    if (file !== null) {
      try {
        fs.closeSync(file);
      } catch (error) {
        // 同上
      }
    }
  }
}

/** 列目录文件名（不存在/读失败返回空数组，已排序）。 */
function listNames(dir: string): string[] {
  if (!fileExists(dir)) {
    return [];
  }
  let names: string[] = [];
  try {
    names = fs.listFileSync(dir);
  } catch (error) {
    return [];
  }
  names.sort();
  return names;
}

/** 目录里的按天 zip 日期键（`YYYY-MM-DD`，升序）。 */
function listZipDates(dir: string): string[] {
  const dates: string[] = [];
  for (const name of listNames(dir)) {
    if (!name.endsWith(ZIP_SUFFIX)) {
      continue;
    }
    const date: string = name.substring(0, name.length - ZIP_SUFFIX.length);
    if (DATE_KEY_RE.test(date)) {
      dates.push(date);
    }
  }
  return dates;
}

/** 合并两个字符串列表并去重（保持升序）。 */
function unionSorted(left: string[], right: string[]): string[] {
  const seen: Record<string, boolean> = {};
  const merged: string[] = [];
  for (const item of left) {
    if (seen[item] !== true) {
      seen[item] = true;
      merged.push(item);
    }
  }
  for (const item of right) {
    if (seen[item] !== true) {
      seen[item] = true;
      merged.push(item);
    }
  }
  merged.sort();
  return merged;
}

/** 过滤出合法的 `YYYY-MM-DD`（去重、升序）。 */
function normalizeDateKeys(dateKeys: string[]): string[] {
  const seen: Record<string, boolean> = {};
  const keys: string[] = [];
  if (!Array.isArray(dateKeys)) {
    return keys;
  }
  for (const raw of dateKeys) {
    const text: string = typeof raw === 'string' ? raw.trim() : '';
    if (!DATE_KEY_RE.test(text) || seen[text] === true) {
      continue;
    }
    seen[text] = true;
    keys.push(text);
  }
  keys.sort();
  return keys;
}

function emptySummary(): MergeSummary {
  const summary: MergeSummary = { localOnly: 0, remoteOnly: 0, conflicts: 0, conflictIds: [] };
  return summary;
}

/** 把模型层的冲突明细翻成 UI 用的结构。 */
function toConflictItems(details: MergeConflictDetail[]): MergeConflictItem[] {
  const items: MergeConflictItem[] = [];
  for (const detail of details) {
    items.push({ id: detail.id, ts: detail.ts, localLine: detail.localLine, remoteLine: detail.remoteLine });
  }
  return items;
}

/** 把模型层合并结果翻成 `MergeSummary`。 */
function toMergeSummary(merged: MergeDayResult): MergeSummary {
  const summary: MergeSummary = {
    localOnly: merged.stats.localOnly,
    remoteOnly: merged.stats.remoteOnly,
    conflicts: merged.stats.conflicts,
    conflictIds: merged.conflictIds
  };
  return summary;
}

/** 累加到整体摘要（`conflictIds` 去重）。 */
function accumulateSummary(target: MergeSummary, item: MergeSummary): void {
  target.localOnly += item.localOnly;
  target.remoteOnly += item.remoteOnly;
  target.conflicts += item.conflicts;
  for (const id of item.conflictIds) {
    if (target.conflictIds.indexOf(id) < 0) {
      target.conflictIds.push(id);
    }
  }
}

function failedMerge(message: string): MergeAfterPullResult {
  const result: MergeAfterPullResult = {
    ok: false,
    message: message,
    days: [],
    summary: emptySummary()
  };
  return result;
}

function failedAttachments(message: string): AttachmentMergeResult {
  const result: AttachmentMergeResult = {
    ok: false,
    message: message,
    written: [],
    kept: [],
    renamed: 0,
    files: []
  };
  return result;
}

// ---------------------------------------------------------------- 路径

function repoRoot(): string {
  return `${scheduleStore.getFilesDir()}/${REPO_DIR_NAME}`;
}

function deviceDir(deviceId: string): string {
  return `${repoRoot()}/${DEVICES_DIR_NAME}/${deviceId}`;
}

function liveSchedulesDir(deviceId: string): string {
  return `${deviceDir(deviceId)}/${SCHEDULES_DIR_NAME}`;
}

function liveAttachmentsDir(deviceId: string): string {
  return `${deviceDir(deviceId)}/${ATTACHMENTS_DIR_NAME}`;
}

function liveSummariesDir(deviceId: string): string {
  return `${deviceDir(deviceId)}/${SUMMARIES_DIR_NAME}`;
}

function liveDayPath(deviceId: string, date: string): string {
  return `${liveSchedulesDir(deviceId)}/${date}${JSONL_SUFFIX}`;
}

function liveArchivePath(deviceId: string, date: string): string {
  return `${liveAttachmentsDir(deviceId)}/${date}${ZIP_SUFFIX}`;
}

function liveSummaryPath(deviceId: string, date: string): string {
  return `${liveSummariesDir(deviceId)}/${date}${JSON_SUFFIX}`;
}

function liveOpenIndexPath(deviceId: string): string {
  return `${deviceDir(deviceId)}/${OPEN_INDEX_NAME}`;
}

/** 本机快照根（**仓库之外**，不会被提交、不会被 pull 覆盖）。 */
function snapshotRoot(deviceId: string): string {
  return `${scheduleStore.getFilesDir()}/${SNAPSHOT_ROOT_NAME}/${deviceId}`;
}

function snapshotDayPath(deviceId: string, date: string): string {
  return `${snapshotRoot(deviceId)}/${SCHEDULES_DIR_NAME}/${date}${JSONL_SUFFIX}`;
}

function snapshotArchivePath(deviceId: string, date: string): string {
  return `${snapshotRoot(deviceId)}/${ATTACHMENTS_DIR_NAME}/${date}${ZIP_SUFFIX}`;
}

function snapshotSummaryPath(deviceId: string, date: string): string {
  return `${snapshotRoot(deviceId)}/${SUMMARIES_DIR_NAME}/${date}${JSON_SUFFIX}`;
}

function snapshotOpenIndexPath(deviceId: string): string {
  return `${snapshotRoot(deviceId)}/${OPEN_INDEX_NAME}`;
}

/** 校验前置条件：存储就绪 + 设备标识合法。返回错误信息（空串 = 通过）。 */
function checkReady(deviceId: string): string {
  if (!scheduleStore.isReady()) {
    return '日程存储尚未初始化：请先调用 scheduleStore.ensureReady(context)';
  }
  if (scheduleStore.getFilesDir().length === 0) {
    return '应用文件目录尚未就绪';
  }
  try {
    normalizeDeviceId(deviceId);
  } catch (error) {
    return messageOf(error as Object);
  }
  return '';
}

// ---------------------------------------------------------------- pull 前快照

/**
 * pull **之前**把本机日程 / 汇总 / 附件复制到快照目录（`<filesDir>/git-merge/<deviceId>/…`）。
 *
 * 只处理 `dateKeys` 里列出的日期（建议最近 7～30 天），另外固定带上 `open.jsonl`。
 * 已存在且内容相同则跳过；失败只返回 `{ok:false}`，不影响随后的 pull。
 */
export async function captureBeforePull(deviceId: string, dateKeys: string[]): Promise<CaptureResult> {
  const result: CaptureResult = { ok: true, message: '', files: 0 };
  const problem: string = checkReady(deviceId);
  if (problem.length > 0) {
    result.ok = false;
    result.message = 'pull 前快照跳过：' + problem;
    return result;
  }
  let id: string;
  try {
    id = normalizeDeviceId(deviceId);
  } catch (error) {
    result.ok = false;
    result.message = 'pull 前快照跳过：' + messageOf(error as Object);
    return result;
  }

  let copied: number = 0;
  const keys: string[] = normalizeDateKeys(dateKeys);
  for (const date of keys) {
    const pairs: string[][] = [
      [liveDayPath(id, date), snapshotDayPath(id, date)],
      [liveSummaryPath(id, date), snapshotSummaryPath(id, date)]
    ];
    for (const pair of pairs) {
      const text: string = readTextOrEmpty(pair[0]);
      if (text.length === 0) {
        continue;
      }
      if (readTextOrEmpty(pair[1]) === text) {
        continue;
      }
      if (writeTextFile(pair[1], text)) {
        copied += 1;
      }
    }
    const bytes: Uint8Array | null = readBytesOrNull(liveArchivePath(id, date));
    if (bytes !== null) {
      const existing: Uint8Array | null = readBytesOrNull(snapshotArchivePath(id, date));
      if (existing === null || sha256Hex(existing) !== sha256Hex(bytes)) {
        if (writeBytesFile(snapshotArchivePath(id, date), bytes)) {
          copied += 1;
        }
      }
    }
  }

  const openText: string = readTextOrEmpty(liveOpenIndexPath(id));
  if (openText.length > 0 && readTextOrEmpty(snapshotOpenIndexPath(id)) !== openText) {
    if (writeTextFile(snapshotOpenIndexPath(id), openText)) {
      copied += 1;
    }
  }

  result.files = copied;
  result.message = copied > 0 ? `已保存 pull 前本机快照：${copied} 个文件` : '本机快照已是最新，无需复制';
  return result;
}

// ---------------------------------------------------------------- 记录级合并

/**
 * pull 之后合并本机快照与工作副本的同名 `schedules/<date>.jsonl`。
 *
 * - 无冲突：合并结果（每行 `encodeRecord` 规范格式、`ts` 升序 → `id` 升序）**直接写回工作副本**；
 * - 有冲突：**不写回**，返回 `{conflictIds, conflicts:[{localLine, remoteLine}]}` 供 UI 让用户选；
 * - 写回失败 / 读失败只体现在 `ok:false` 与 `message` 里，永不抛。
 */
export async function mergeAfterPull(deviceId: string, dateKeys: string[]): Promise<MergeAfterPullResult> {
  const problem: string = checkReady(deviceId);
  if (problem.length > 0) {
    return failedMerge('拉取后合并跳过：' + problem);
  }
  let id: string;
  try {
    id = normalizeDeviceId(deviceId);
  } catch (error) {
    return failedMerge('拉取后合并跳过：' + messageOf(error as Object));
  }
  const keys: string[] = normalizeDateKeys(dateKeys);
  if (keys.length === 0) {
    return failedMerge('拉取后合并跳过：没有指定日期');
  }

  const overall: MergeSummary = emptySummary();
  const days: MergeDayOutcome[] = [];
  let allOk: boolean = true;
  let applied: number = 0;

  for (const date of keys) {
    const livePath: string = liveDayPath(id, date);
    const localText: string = readTextOrEmpty(snapshotDayPath(id, date));
    const remoteText: string = readTextOrEmpty(livePath);
    if (localText.length === 0 && remoteText.length === 0) {
      const empty: MergeDayOutcome = {
        date: date,
        ok: true,
        applied: false,
        summary: emptySummary(),
        conflicts: [],
        errors: 0,
        message: '两侧都没有该日文件，跳过'
      };
      days.push(empty);
      continue;
    }

    let merged: MergeDayResult;
    try {
      merged = mergeDayFile(localText, remoteText, 'local');
    } catch (error) {
      allOk = false;
      const failedDay: MergeDayOutcome = {
        date: date,
        ok: false,
        applied: false,
        summary: emptySummary(),
        conflicts: [],
        errors: 0,
        message: '合并失败：' + messageOf(error as Object)
      };
      days.push(failedDay);
      continue;
    }

    const summary: MergeSummary = toMergeSummary(merged);
    accumulateSummary(overall, summary);

    if (merged.conflictIds.length > 0) {
      const pending: MergeDayOutcome = {
        date: date,
        ok: true,
        applied: false,
        summary: summary,
        conflicts: toConflictItems(merged.conflictDetails),
        errors: merged.stats.errors,
        message: `发现 ${merged.conflictIds.length} 个记录冲突，已暂停写回，请选择保留本机或采用远端`
      };
      days.push(pending);
      continue;
    }

    let wrote: boolean = false;
    let dayMessage: string = '合并完成，无冲突';
    if (merged.text !== remoteText) {
      wrote = writeTextFile(livePath, merged.text);
      if (!wrote) {
        allOk = false;
        dayMessage = '合并完成但写回失败：' + livePath;
      } else {
        applied += 1;
        dayMessage = '合并完成并写回（规范化为每 id 一行）';
      }
    } else {
      dayMessage = '合并结果与工作副本一致，未改动';
    }
    const ok: boolean = wrote || merged.text === remoteText;
    const outcome: MergeDayOutcome = {
      date: date,
      ok: ok,
      applied: wrote,
      summary: summary,
      conflicts: [],
      errors: merged.stats.errors,
      message: dayMessage
    };
    days.push(outcome);
  }

  let message: string;
  if (overall.conflicts > 0) {
    message =
      `拉取后合并：${keys.length} 天中 ${applied} 天已写回，` +
      `${overall.localOnly} 条本机独有、${overall.remoteOnly} 条远端独有，` +
      `${overall.conflicts} 条冲突待选择`;
  } else {
    message =
      `拉取后合并：${keys.length} 天，${applied} 天写回，` +
      `${overall.localOnly} 条本机独有、${overall.remoteOnly} 条远端独有，无冲突`;
  }

  const result: MergeAfterPullResult = {
    ok: allOk,
    message: message,
    days: days,
    summary: overall
  };
  return result;
}

/**
 * 冲突定案：按 `choice`（`'local'` | `'remote'`）重跑合并并**强制写回**。
 *
 * UI 在 `mergeAfterPull()` 返回 `conflictIds` 非空后调用：用户点「保留本机」传 `'local'`，
 * 点「采用远端」传 `'remote'`；其它值按 `'local'` 处理（收敛到安全的默认）。
 */
export async function applyMergeChoice(
  deviceId: string,
  dateKeys: string[],
  choice: string
): Promise<MergeAfterPullResult> {
  const problem: string = checkReady(deviceId);
  if (problem.length > 0) {
    return failedMerge('冲突定案跳过：' + problem);
  }
  let id: string;
  try {
    id = normalizeDeviceId(deviceId);
  } catch (error) {
    return failedMerge('冲突定案跳过：' + messageOf(error as Object));
  }
  const keys: string[] = normalizeDateKeys(dateKeys);
  if (keys.length === 0) {
    return failedMerge('冲突定案跳过：没有指定日期');
  }
  const keepLocal: boolean = choice !== 'remote';

  const overall: MergeSummary = emptySummary();
  const days: MergeDayOutcome[] = [];
  let allOk: boolean = true;
  let applied: number = 0;

  for (const date of keys) {
    const livePath: string = liveDayPath(id, date);
    const localText: string = readTextOrEmpty(snapshotDayPath(id, date));
    const remoteText: string = readTextOrEmpty(livePath);
    if (localText.length === 0 && remoteText.length === 0) {
      continue;
    }
    let merged: MergeDayResult;
    try {
      merged = mergeDayFile(localText, remoteText, keepLocal ? 'local' : 'remote');
    } catch (error) {
      allOk = false;
      const failedDay: MergeDayOutcome = {
        date: date,
        ok: false,
        applied: false,
        summary: emptySummary(),
        conflicts: [],
        errors: 0,
        message: '定案失败：' + messageOf(error as Object)
      };
      days.push(failedDay);
      continue;
    }
    const summary: MergeSummary = toMergeSummary(merged);
    accumulateSummary(overall, summary);
    let wrote: boolean = false;
    let ok: boolean = true;
    let dayMessage: string = '内容已一致，无需改动';
    if (merged.text !== remoteText) {
      wrote = writeTextFile(livePath, merged.text);
      if (!wrote) {
        ok = false;
        allOk = false;
        dayMessage = '定案写回失败：' + livePath;
      } else {
        applied += 1;
        dayMessage = keepLocal ? '已按「保留本机」写回' : '已按「采用远端」写回';
      }
    }
    const outcome: MergeDayOutcome = {
      date: date,
      ok: ok,
      applied: wrote,
      summary: summary,
      conflicts: toConflictItems(merged.conflictDetails),
      errors: merged.stats.errors,
      message: dayMessage
    };
    days.push(outcome);
  }

  const result: MergeAfterPullResult = {
    ok: allOk,
    message: `${keepLocal ? '保留本机' : '采用远端'}：${applied} 天已写回（共 ${keys.length} 天）`,
    days: days,
    summary: overall
  };
  return result;
}

// ---------------------------------------------------------------- 附件 / 汇总 / 索引

/**
 * 附件合并：把快照里的本机 zip 与工作副本里的当前 zip 按「同名不同内容 → 保留两份」处理。
 *
 * 只处理 `attachments/<YYYY-MM-DD>.zip`；写入的新名字不会与任何已存在文件重名
 * （`planArchiveWrites` 会退到 `.1`/`.2`），因此**不存在覆盖丢手迹的路径**。
 */
export async function mergeAttachments(deviceId: string = scheduleStore.getDeviceId()): Promise<AttachmentMergeResult> {
  const problem: string = checkReady(deviceId);
  if (problem.length > 0) {
    return failedAttachments('附件合并跳过：' + problem);
  }
  let id: string;
  try {
    id = normalizeDeviceId(deviceId);
  } catch (error) {
    return failedAttachments('附件合并跳过：' + messageOf(error as Object));
  }

  const liveDir: string = liveAttachmentsDir(id);
  const snapDir: string = snapshotRoot(id) + '/' + ATTACHMENTS_DIR_NAME;
  const dates: string[] = unionSorted(listZipDates(liveDir), listZipDates(snapDir));

  const existing: ArchiveExisting[] = [];
  for (const name of listNames(liveDir)) {
    if (!name.endsWith(ZIP_SUFFIX)) {
      continue;
    }
    const bytes: Uint8Array | null = readBytesOrNull(`${liveDir}/${name}`);
    if (bytes === null) {
      continue;
    }
    existing.push({ name: name, sha256: sha256Hex(bytes) });
  }

  const written: string[] = [];
  const kept: string[] = [];
  const files: AttachmentMergeFile[] = [];
  let renamed: number = 0;
  let ok: boolean = true;

  for (const date of dates) {
    const localBytes: Uint8Array | null = readBytesOrNull(snapshotArchivePath(id, date));
    const remoteBytes: Uint8Array | null = readBytesOrNull(liveArchivePath(id, date));
    const local: ArchiveInput | null =
      localBytes === null ? null : { name: `${date}${ZIP_SUFFIX}`, bytes: localBytes };
    const remote: ArchiveInput | null =
      remoteBytes === null ? null : { name: `${date}${ZIP_SUFFIX}`, bytes: remoteBytes };
    let plan: ArchiveWritePlan;
    try {
      plan = planArchiveWrites(existing, local, remote);
    } catch (error) {
      ok = false;
      continue;
    }
    if (plan.renamed) {
      renamed += 1;
    }
    for (const keep of plan.kept) {
      if (kept.indexOf(keep) < 0) {
        kept.push(keep);
      }
    }
    for (const write of plan.writes) {
      const target: string = `${liveDir}/${write.name}`;
      if (fileExists(target)) {
        // 双保险：盘上已有同名文件就绝不写（plan 已避开，这里防御并发/外部改动）
        ok = false;
        continue;
      }
      if (!writeBytesFile(target, write.bytes)) {
        ok = false;
        continue;
      }
      written.push(write.name);
      const role: string = write.role;
      files.push({ name: write.name, role: role });
      existing.push({ name: write.name, sha256: sha256Hex(write.bytes) });
    }
  }

  let message: string;
  if (written.length === 0) {
    message =
      dates.length === 0
        ? '没有需要合并的附件'
        : `附件无冲突：${dates.length} 天全部已存在相同内容（无需写盘）`;
  } else {
    message =
      `附件合并：${dates.length} 天中 ${renamed} 天同名内容不同，` +
      `新增 ${written.length} 个文件（原文件一律保留）`;
  }

  const result: AttachmentMergeResult = {
    ok: ok,
    message: message,
    written: written,
    kept: kept,
    renamed: renamed,
    files: files
  };
  return result;
}

/**
 * 每日汇总合并：`summaries/<date>.json` 按 `generatedAt` 较新者胜。
 * 采用远端时才写回；一侧损坏时保留可用的一侧。
 */
export async function mergeSummaries(deviceId: string, dateKeys: string[]): Promise<SummaryMergeOutcome> {
  const outcome: SummaryMergeOutcome = { ok: true, message: '', written: [], adoptedRemote: [], errors: 0 };
  const problem: string = checkReady(deviceId);
  if (problem.length > 0) {
    outcome.ok = false;
    outcome.message = '汇总合并跳过：' + problem;
    return outcome;
  }
  let id: string;
  try {
    id = normalizeDeviceId(deviceId);
  } catch (error) {
    outcome.ok = false;
    outcome.message = '汇总合并跳过：' + messageOf(error as Object);
    return outcome;
  }
  const keys: string[] = normalizeDateKeys(dateKeys);
  for (const date of keys) {
    const localText: string = readTextOrEmpty(snapshotSummaryPath(id, date));
    const remoteText: string = readTextOrEmpty(liveSummaryPath(id, date));
    if (localText.length === 0 && remoteText.length === 0) {
      continue;
    }
    let decision: SummaryMergeDecision;
    try {
      decision = mergeSummaryTexts(localText, remoteText);
    } catch (error) {
      outcome.ok = false;
      continue;
    }
    outcome.errors += decision.errors;
    if (decision.winner === 'empty' || decision.winner === 'identical') {
      continue;
    }
    if (decision.winner === 'remote') {
      outcome.adoptedRemote.push(date);
    }
    if (decision.text === remoteText) {
      continue;
    }
    if (writeTextFile(liveSummaryPath(id, date), decision.text)) {
      outcome.written.push(date);
    } else {
      outcome.ok = false;
    }
  }
  outcome.message =
    outcome.written.length === 0
      ? `汇总无变化（${keys.length} 天）`
      : `汇总合并：改写 ${outcome.written.length} 天（其中采用远端 ${outcome.adoptedRemote.length} 天）`;
  return outcome;
}

/**
 * `open.jsonl`（未完成索引）合并：同 id 取 `ts` 较新，冲突取本机；结果写回工作副本。
 *
 * 索引是派生数据，写失败不影响日程；冲突时仍以本机为准（索引可由分片重建）。
 */
export async function mergeOpenIndex(deviceId: string): Promise<OpenIndexMergeOutcome> {
  const outcome: OpenIndexMergeOutcome = {
    ok: true,
    message: '',
    merged: 0,
    conflicts: 0,
    conflictIds: [],
    applied: false,
    errors: 0
  };
  const problem: string = checkReady(deviceId);
  if (problem.length > 0) {
    outcome.ok = false;
    outcome.message = '索引合并跳过：' + problem;
    return outcome;
  }
  let id: string;
  try {
    id = normalizeDeviceId(deviceId);
  } catch (error) {
    outcome.ok = false;
    outcome.message = '索引合并跳过：' + messageOf(error as Object);
    return outcome;
  }
  const localText: string = readTextOrEmpty(snapshotOpenIndexPath(id));
  const remoteText: string = readTextOrEmpty(liveOpenIndexPath(id));
  if (localText.length === 0 && remoteText.length === 0) {
    outcome.message = '没有未完成索引，跳过';
    return outcome;
  }
  let merged: OpenIndexMergeResult;
  try {
    merged = mergeOpenIndexTexts(localText, remoteText);
  } catch (error) {
    outcome.ok = false;
    outcome.message = '索引合并失败：' + messageOf(error as Object);
    return outcome;
  }
  outcome.merged = merged.stats.result.length;
  outcome.conflicts = merged.stats.conflicts;
  outcome.conflictIds = merged.conflictIds;
  outcome.errors = merged.stats.errors;
  if (merged.text !== remoteText && merged.text.length > 0) {
    outcome.applied = writeTextFile(liveOpenIndexPath(id), merged.text);
    if (!outcome.applied) {
      outcome.ok = false;
    }
  }
  outcome.message = outcome.applied
    ? `索引合并：${merged.stats.result.length} 条（本机独有 ${merged.stats.localOnly}、远端独有 ${merged.stats.remoteOnly}）`
    : '索引无变化';
  return outcome;
}

// ---------------------------------------------------------------- 一次性入口（UI 接线用）

/** `mergeAllAfterPull()` 的结果：四类数据各自的结论 + 合并后的中文摘要。 */
export interface MergeAllResult {
  ok: boolean;
  message: string;
  records: MergeAfterPullResult;
  attachments: AttachmentMergeResult;
  summaries: SummaryMergeOutcome;
  index: OpenIndexMergeOutcome;
}

/**
 * pull 成功后的一站式入口：记录 → 附件 → 汇总 → 未完成索引，依次合并。
 *
 * 全部是「只返回结果、不抛」的调用，任何一步失败都不影响其它步；`ok` 是四步的与。
 * UI 只需要读 `records.summary.conflictIds`（非空就让用户选，选完调 `applyMergeChoice`），
 * 其余字段用于 toast/详情展示。
 */
export async function mergeAllAfterPull(deviceId: string, dateKeys: string[]): Promise<MergeAllResult> {
  const records: MergeAfterPullResult = await mergeAfterPull(deviceId, dateKeys);
  const attachments: AttachmentMergeResult = await mergeAttachments(deviceId);
  const summaries: SummaryMergeOutcome = await mergeSummaries(deviceId, dateKeys);
  const index: OpenIndexMergeOutcome = await mergeOpenIndex(deviceId);
  const ok: boolean = records.ok && attachments.ok && summaries.ok && index.ok;
  let message: string = records.message;
  message = message + '；' + attachments.message;
  message = message + '；' + summaries.message;
  message = message + '；' + index.message;
  const result: MergeAllResult = {
    ok: ok,
    message: message,
    records: records,
    attachments: attachments,
    summaries: summaries,
    index: index
  };
  return result;
}
