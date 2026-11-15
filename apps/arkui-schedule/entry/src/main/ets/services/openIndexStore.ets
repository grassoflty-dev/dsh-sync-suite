/**
 * 「未完成索引」存储：`<filesDir>/git-repo/devices/<deviceId>/open.jsonl`。
 *
 * - 与日程同目录树（随 git 一起同步），但**不进 `schedules/*.jsonl`**：索引是派生数据；
 * - 追加写（维护）+ 原子替换写（自愈重建），写失败只 `console.info('[idx] ...')`，绝不让日程保存失败；
 * - 目录/设备标识全部复用 `scheduleStore`（`ensureReady` / `deviceRoot` / `getDeviceId`），不另起一套；
 * - 纯逻辑（编解码、折叠、对账）在 `model/openIndex.ts`，本文件只管字节与时机。
 *
 * 契约：`docs/DATA-CONTRACT.md` §3（日程 JSONL）的**派生索引**，目录与「只追加」语义与日程一致；
 * 本文件不新增跨设备互通格式，索引仅本机设备目录内自用。
 */
import { fileIo as fs } from '@kit.CoreFileKit';
import {
  RECONCILE_DAYS,
  applyRecordToIndex,
  diffIndex,
  encodeOpenEntry,
  expectedIndexForWindow,
  foldOpenByid,
  isEntryInWindow,
  isOpenEntryOpen,
  mergeIndexForRebuild,
  parseOpenIndex,
  reconcileWindowStart
} from '../model/openIndex';
import type { OpenEntry, OpenIndexDiff } from '../model/openIndex';
import { sortRecords } from '../model/jsonl';
import type { ScheduleRecord } from '../model/types';
import { describeError, scheduleStore } from './scheduleStore';

/** 索引文件名（设备根目录下）。 */
const OPEN_INDEX_FILE_NAME: string = 'open.jsonl';
/** 临时文件后缀（写完 rename 成正式文件）。 */
const TMP_SUFFIX: string = '.tmp';
/** 两次自愈的最小间隔（毫秒）：避免每次列表刷新都去扫 30 个分片。 */
const RECONCILE_MIN_INTERVAL_MS: number = 15000;
/** 分片日期名合法性（`listDates()` 只按后缀筛，脏文件名要挡掉）。 */
const DATE_KEY_RE: RegExp = /^\d{4}-\d{2}-\d{2}$/;
const NEW_LINE_BYTE: number = 0x0a;

/** 自愈结果（供页面/日志判断是否真的写了盘）。 */
export interface OpenIndexReconcileResult {
  /** 是否真的重建并写回。 */
  rebuilt: boolean;
  /** 漂移条数（未重建时为 0）。 */
  drift: number;
  /** 重建后写入的条目数。 */
  written: number;
  /** 失败原因（空串 = 没有失败）。 */
  error: string;
}

/** 「什么都没做」的统一返回值（未就绪 / 被节流 / 无漂移）。 */
function noChange(): OpenIndexReconcileResult {
  const empty: OpenIndexReconcileResult = { rebuilt: false, drift: 0, written: 0, error: '' };
  return empty;
}

/** 在（已折叠的）记录里按 id 取一条；没有返回 `null`。 */
function pickRecord(records: ScheduleRecord[], id: string): ScheduleRecord | null {
  for (const record of records) {
    if (record.id === id) {
      return record;
    }
  }
  return null;
}

export class OpenIndexStore {
  /** 上次自愈时间（毫秒；0 = 本次进程还没跑过）。 */
  private lastReconcileAt: number = 0;

  /** 初始化（幂等）：完全复用 `scheduleStore` 的 ready / deviceId 状态。 */
  async ensureReady(context: object): Promise<void> {
    await scheduleStore.ensureReady(context);
  }

  isReady(): boolean {
    return scheduleStore.isReady();
  }

  /** 索引文件的绝对路径。 */
  indexPath(): string {
    return `${scheduleStore.deviceRoot()}/${OPEN_INDEX_FILE_NAME}`;
  }

  /** 索引文件在仓库里的相对路径（排障/日志用）。 */
  repoPath(): string {
    return `devices/${scheduleStore.getDeviceId()}/${OPEN_INDEX_FILE_NAME}`;
  }

  /**
   * 读索引并折叠（同 id 取 ts 较晚条目）。
   *
   * 读失败/坏行都不抛：坏行跳过 + 日志，调用方拿到的是「能读到的部分」，
   * 真正的修复交给 `reconcile()`（对账只认日程分片）。
   */
  readEntries(): OpenEntry[] {
    if (!scheduleStore.isReady()) {
      return [];
    }
    const text = this.readText(this.indexPath());
    if (text.length === 0) {
      return [];
    }
    const parsed = parseOpenIndex(text);
    if (parsed.errors.length > 0) {
      console.info(
        `[idx] 索引有 ${parsed.errors.length} 行坏行（已跳过）：第 ${parsed.errors[0].line} 行 ${parsed.errors[0].message}`
      );
    }
    return foldOpenByid(parsed.entries);
  }

  /** 当前未完成的条目（折叠后，按 ts 升序）。 */
  pendingEntries(): OpenEntry[] {
    const open: OpenEntry[] = [];
    for (const entry of this.readEntries()) {
      if (isOpenEntryOpen(entry)) {
        open.push(entry);
      }
    }
    return open;
  }

  /**
   * 追加一条索引条目（物理追加，绝不重写历史行）。
   *
   * 失败抛错：调用方是「日程已经写成功」之后的维护路径，由 `applyRecord` 兜底成日志。
   */
  appendEntry(entry: OpenEntry): void {
    const encoded = encodeOpenEntry(entry);
    this.ensureDirSync(scheduleStore.deviceRoot());
    this.appendLineSync(this.indexPath(), encoded);
  }

  /** 整体替换索引（原子替换：先写 `.tmp`，再 rename）。 */
  replaceEntries(entries: OpenEntry[]): void {
    let text = '';
    // 先把所有条目编码完再动文件：非法条目不会毁掉现有索引
    for (const entry of entries) {
      text += encodeOpenEntry(entry);
    }
    this.ensureDirSync(scheduleStore.deviceRoot());
    const path = this.indexPath();
    const tmpPath = `${path}${TMP_SUFFIX}`;
    this.writeTextSync(tmpPath, text);
    try {
      fs.renameSync(tmpPath, path);
    } catch (error) {
      // 部分实现不允许覆盖式 rename：删旧文件再 rename
      try {
        if (this.fileExists(path)) {
          fs.unlinkSync(path);
        }
        fs.renameSync(tmpPath, path);
      } catch (retryError) {
        try {
          if (this.fileExists(tmpPath)) {
            fs.unlinkSync(tmpPath);
          }
        } catch {
          // 清理失败不影响主流程
        }
        throw new Error(`写入未完成索引失败（${path}）：${describeError(retryError)}`);
      }
    }
  }

  /**
   * 索引维护入口：一条日程记录落盘后调用（由 `scheduleStore` 的追加钩子触发）。
   *
   * **幂等**：`applyRecordToIndex` 判定内容不变时不写盘；任何异常只记日志，
   * 日程已经在磁盘上，索引最迟由下次 `reconcile()` 自愈补上。
   */
  applyRecord(record: ScheduleRecord): void {
    if (!scheduleStore.isReady()) {
      return;
    }
    try {
      const result = applyRecordToIndex(this.readEntries(), record);
      if (!result.changed) {
        return;
      }
      this.appendEntry(result.entry);
    } catch (error) {
      console.info(`[idx] 索引维护失败（日程已保存，等下次自愈）：${describeError(error)}`);
    }
  }

  /**
   * 自愈对账：用最近 `recentDays` 天的日程分片重算期望索引，与现有索引比对；
   * **仅当有漂移（或索引文件缺失）时才重建写回**，否则一个字节都不写。
   */
  reconcile(recentDays: number = RECONCILE_DAYS): OpenIndexReconcileResult {
    if (!scheduleStore.isReady()) {
      const notReady: OpenIndexReconcileResult = {
        rebuilt: false,
        drift: 0,
        written: 0,
        error: '日程存储尚未初始化'
      };
      return notReady;
    }
    // 先记时间戳：失败也不要每次刷新都重试，避免把日志刷满
    this.lastReconcileAt = Date.now();
    const path = this.indexPath();
    try {
      const absent = !this.fileExists(path);
      const actual = this.readEntries();
      const windowStart = reconcileWindowStart(recentDays);
      const expected = expectedIndexForWindow(this.readRecentRecords(windowStart), windowStart);
      const actualInScope: OpenEntry[] = [];
      for (const entry of actual) {
        if (isEntryInWindow(entry, windowStart)) {
          actualInScope.push(entry);
        }
      }
      const diff: OpenIndexDiff = diffIndex(expected, actualInScope);
      if (!diff.drift && !absent) {
        return noChange();
      }
      const merged = mergeIndexForRebuild(expected, actual, windowStart);
      this.replaceEntries(merged);
      console.info(`[idx] rebuilt drift=${diff.count}`);
      const rebuilt: OpenIndexReconcileResult = {
        rebuilt: true,
        drift: diff.count,
        written: merged.length,
        error: ''
      };
      return rebuilt;
    } catch (error) {
      const message = describeError(error);
      console.info(`[idx] 自愈失败（保留原索引）：${message}`);
      const failed: OpenIndexReconcileResult = { rebuilt: false, drift: 0, written: 0, error: message };
      return failed;
    }
  }

  /**
   * 带节流的自愈：距上次不足 `minIntervalMs` 时直接跳过（用于页面 onPageShow 等高频入口）。
   *
   * pull 完成后回到首页会触发 onPageShow → 这里对账，从而把「拉取下来的分片」并进索引。
   */
  reconcileIfDue(
    recentDays: number = RECONCILE_DAYS,
    minIntervalMs: number = RECONCILE_MIN_INTERVAL_MS
  ): OpenIndexReconcileResult {
    const now = Date.now();
    if (this.lastReconcileAt > 0 && now - this.lastReconcileAt < minIntervalMs) {
      return noChange();
    }
    return this.reconcile(recentDays);
  }

  /**
   * 「全部未完成」的数据源：按索引里的 id 取记录。
   *
   * 读取顺序（尽量少读文件）：
   * 1. 按条目 `date` 分组，每个分片只读一次（`readDay` 已折叠排序）；
   * 2. 分片里找不到的 id（归属日期异常/记录被挪走）→ 用本设备全量记录兜底一次；
   * 3. 记录若已被别的设备标记完成（`done:true`），这里过滤掉 —— 索引只是线索，记录才是真相。
   *
   * 返回值按 ts 升序，与原「扫全部分片」的顺序一致，列表展示不跳。
   */
  pendingRecords(): ScheduleRecord[] {
    if (!scheduleStore.isReady()) {
      return [];
    }
    // 读索引前顺手自愈（节流）：切到「全部未完成」时拿到的是最新索引
    this.reconcileIfDue();
    const open = this.pendingEntries();
    if (open.length === 0) {
      return [];
    }
    const byDate = new Map<string, string[]>();
    const unresolved: string[] = [];
    for (const entry of open) {
      if (!DATE_KEY_RE.test(entry.date)) {
        unresolved.push(entry.id);
        continue;
      }
      let ids = byDate.get(entry.date);
      if (ids === undefined) {
        ids = [];
        byDate.set(entry.date, ids);
      }
      ids.push(entry.id);
    }
    const found: ScheduleRecord[] = [];
    byDate.forEach((ids: string[], date: string) => {
      let dayRecords: ScheduleRecord[] = [];
      try {
        dayRecords = scheduleStore.readDay(date);
      } catch (error) {
        console.info(`[idx] 读分片失败（${date}）：${describeError(error)}`);
      }
      for (const id of ids) {
        const record = pickRecord(dayRecords, id);
        if (record === null) {
          unresolved.push(id);
        } else if (record.done !== true) {
          found.push(record);
        }
      }
    });
    if (unresolved.length > 0) {
      let all: ScheduleRecord[] = [];
      try {
        all = scheduleStore.readAll();
      } catch (error) {
        console.info(`[idx] 全量兜底读取失败：${describeError(error)}`);
      }
      for (const id of unresolved) {
        const record = pickRecord(all, id);
        if (record !== null && record.done !== true) {
          found.push(record);
        }
      }
    }
    return sortRecords(found);
  }

  // ------------------------------------------------------------------ 内部实现

  /** 读最近窗口内的分片记录（只读本机设备目录）。 */
  private readRecentRecords(windowStart: string): ScheduleRecord[] {
    const records: ScheduleRecord[] = [];
    let dates: string[] = [];
    try {
      dates = scheduleStore.listDates();
    } catch (error) {
      console.info(`[idx] 列出分片失败：${describeError(error)}`);
      return records;
    }
    for (const date of dates) {
      if (!DATE_KEY_RE.test(date) || date < windowStart) {
        continue;
      }
      try {
        for (const record of scheduleStore.readDay(date)) {
          records.push(record);
        }
      } catch (error) {
        console.info(`[idx] 跳过分片（${date}）：${describeError(error)}`);
      }
    }
    return records;
  }

  private readText(path: string): string {
    try {
      if (!this.fileExists(path)) {
        return '';
      }
      return fs.readTextSync(path);
    } catch (error) {
      console.info(`[idx] 读索引失败（${path}）：${describeError(error)}`);
      return '';
    }
  }

  private writeTextSync(path: string, text: string): void {
    let file: fs.File | null = null;
    try {
      file = fs.openSync(path, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
      fs.writeSync(file.fd, text);
    } catch (error) {
      throw new Error(`写入索引文件失败（${path}）：${describeError(error)}`);
    } finally {
      if (file !== null) {
        fs.closeSync(file);
      }
    }
  }

  /** 定位到文件末尾写入：上一行没有换行时先补 `\n`，历史字节一个都不改。 */
  private appendLineSync(path: string, line: string): void {
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
      fs.writeSync(file.fd, line, { offset: offset });
    } finally {
      fs.closeSync(file);
    }
  }

  private fileExists(path: string): boolean {
    try {
      return fs.accessSync(path);
    } catch {
      return false;
    }
  }

  private ensureDirSync(dir: string): void {
    try {
      fs.mkdirSync(dir, true);
    } catch (error) {
      // 目录已存在时个别实现会抛错，只有确实不可用才向上抛
      if (!this.fileExists(dir)) {
        throw new Error(`创建索引目录失败（${dir}）：${describeError(error)}`);
      }
    }
  }
}

/** 全局单例（与 `scheduleStore` 共用同一份目录状态）。 */
export const openIndexStore: OpenIndexStore = new OpenIndexStore();

// 索引是派生数据：日程追加成功后的维护钩子。失败只记日志，绝不影响保存。
scheduleStore.setAppendHook((record: ScheduleRecord): void => {
  openIndexStore.applyRecord(record);
});
