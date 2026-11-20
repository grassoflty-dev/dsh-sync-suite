/**
 * 「未完成索引」存储：`<filesDir>/git-repo/devices/<deviceId>/open.jsonl`。
 *
 * - 与日程同目录树（随 git 一起同步），但**不进 `schedules/*.jsonl`**：索引是派生数据；
 * - 追加写（维护）+ 原子替换写（自愈重建），写失败只 `console.info('[idx] ...')`，绝不让日程保存失败；
 * - 目录/设备标识全部复用 `scheduleStore`（`ensureReady` / `deviceRoot` / `getDeviceId`），不另起一套；
 * - 纯逻辑（编解码、折叠、对账、跨设备合并）在 `model/openIndex.ts`，本文件只管字节与时机；
 * - **只写本机目录**（`docs/DATA-CONTRACT.md` §1「每台设备只写自己的目录」）：
 *   其他设备的 `devices/<id>/open.jsonl` 只读，缺失时用它的日程分片在**内存里**重建，绝不写回。
 *
 * 契约：`docs/DATA-CONTRACT.md` §3（日程 JSONL）的**派生索引**，目录与「只追加」语义与日程一致；
 * 本文件不新增跨设备互通格式，索引仅本机设备目录内自用。
 */
import { fileIo as fs } from '@kit.CoreFileKit';
import {
  RECONCILE_DAYS,
  applyRecordToIndex,
  buildIndexFromRecords,
  diffIndex,
  encodeOpenEntry,
  expectedIndexForWindow,
  foldOpenByid,
  isEntryInWindow,
  isOpenEntryOpen,
  mergeDeviceIndexes,
  mergeIndexForRebuild,
  parseOpenIndex,
  reconcileWindowStart
} from '../model/openIndex';
import type { DeviceOpenIndex, MergedOpenEntry, OpenEntry, OpenIndexDiff } from '../model/openIndex';
import { foldById, parseJsonl, sortRecords } from '../model/jsonl';
import type { ScheduleRecord } from '../model/types';
import { describeError, scheduleStore } from './scheduleStore';

/** 索引文件名（设备根目录下）。 */
const OPEN_INDEX_FILE_NAME: string = 'open.jsonl';
/** 临时文件后缀（写完 rename 成正式文件）。 */
const TMP_SUFFIX: string = '.tmp';
/** 两次自愈的最小间隔（毫秒）：避免每次列表刷新都去扫 30 个分片。 */
const RECONCILE_MIN_INTERVAL_MS: number = 15000;
/** 其他设备缺索引时「内存重建」结果的有效期（毫秒）：避免每次刷新都重读对方全部分片。 */
const MEMORY_INDEX_TTL_MS: number = 15000;
/** 分片目录名（与 `scheduleStore` 内部一致；其他设备目录只能自己拼路径读）。 */
const SCHEDULES_DIR_NAME: string = 'schedules';
/** 分片文件后缀。 */
const JSONL_SUFFIX: string = '.jsonl';
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

/** 其他设备缺 `open.jsonl` 时的内存索引缓存项。 */
interface MemoryIndex {
  at: number;
  entries: OpenEntry[];
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
  /** 其他设备缺 `open.jsonl` 时的内存重建结果（key=deviceId；本机永远走文件）。 */
  private memoryIndexCache: Map<string, MemoryIndex> = new Map<string, MemoryIndex>();

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
   * 跨日未完成的数据源（按索引里的 id 取记录；现 UI tab 名为「未完成」）。
   *
   * - `includeOtherDevices=false`（默认）：只读本机 `devices/<本机>/open.jsonl`；
   * - `true`：每台设备读**它自己**的 `open.jsonl` —— N 台设备只有 N 个小文件；
   *   某台设备缺索引时用它的日程分片在**内存里**重建（`[idx] rebuild-memory device=...`），
   *   **不写回别人的目录**（契约：每台设备只写自己的目录）。
   *
   * 取记录顺序（尽量少读文件）：条目按 (设备, 日期) 分组 → 每个分片只读一次 →
   * 分片里找不到的 id 用该设备的全量记录兜底一次；记录 `done:true` 一律过滤（记录才是真相）。
   * 返回按 ts 升序（跨设备同 id 只留一条），列表展示不跳。
   */
  pendingRecords(includeOtherDevices: boolean = false): ScheduleRecord[] {
    if (!scheduleStore.isReady()) {
      return [];
    }
    // 读索引前顺手自愈（节流；只动本机索引文件，别人的目录不碰）
    this.reconcileIfDue();
    const snapshots: DeviceOpenIndex[] = [];
    for (const deviceId of this.devicesForQuery(includeOtherDevices)) {
      const snapshot: DeviceOpenIndex = { deviceId: deviceId, entries: this.entriesForDevice(deviceId) };
      snapshots.push(snapshot);
    }
    const merged: MergedOpenEntry[] = mergeDeviceIndexes(snapshots);
    if (merged.length === 0) {
      return [];
    }
    return this.resolveRecords(merged);
  }

  // ------------------------------------------------------------------ 内部实现

  /** 要查询的设备列表：默认只有本机；跨设备时 = 磁盘上所有合法设备目录（本机必在其中）。 */
  private devicesForQuery(includeOtherDevices: boolean): string[] {
    const own = scheduleStore.getDeviceId();
    const devices: string[] = [];
    if (!includeOtherDevices) {
      devices.push(own);
      return devices;
    }
    let listed: string[] = [];
    try {
      listed = scheduleStore.listDeviceIds();
    } catch (error) {
      console.info(`[idx] 列出设备目录失败：${describeError(error)}`);
    }
    let hasOwn = false;
    for (const deviceId of listed) {
      if (deviceId === own) {
        hasOwn = true;
      }
      devices.push(deviceId);
    }
    if (!hasOwn) {
      devices.push(own);
    }
    return devices;
  }

  /** 其他设备的索引路径 —— 只读（本机索引用 `indexPath()`）。 */
  private deviceIndexPath(deviceId: string): string {
    return `${scheduleStore.devicesRoot()}/${deviceId}/${OPEN_INDEX_FILE_NAME}`;
  }

  /**
   * 取某台设备的索引条目。
   *
   * 本机：`open.jsonl`（已自愈）；其他设备：只读它的 `open.jsonl`，**文件缺失**时在内存里
   * 用它的日程分片重建（带 15s 缓存 + `[idx] rebuild-memory device=<id> count=N` 日志），绝不写回。
   */
  private entriesForDevice(deviceId: string): OpenEntry[] {
    if (deviceId === scheduleStore.getDeviceId()) {
      return this.readEntries();
    }
    const path = this.deviceIndexPath(deviceId);
    if (this.fileExists(path)) {
      const parsed = parseOpenIndex(this.readText(path));
      if (parsed.errors.length > 0) {
        console.info(`[idx] 设备 ${deviceId} 的索引有 ${parsed.errors.length} 行坏行（已跳过）`);
      }
      return foldOpenByid(parsed.entries);
    }
    return this.memoryRebuild(deviceId);
  }

  /**
   * 其他设备缺索引时的**内存重建**（只读该设备分片，不写任何文件）。
   *
   * 读它的**全部分片**而不是只读最近 30 天：这类设备多半是旧版本，漏掉老分片会让
   * 它很早创建、至今未完成的条目从「未完成」里消失。
   */
  private memoryRebuild(deviceId: string): OpenEntry[] {
    const now = Date.now();
    const cached = this.memoryIndexCache.get(deviceId);
    if (cached !== undefined && now - cached.at < MEMORY_INDEX_TTL_MS) {
      return cached.entries;
    }
    const rebuilt = buildIndexFromRecords(this.readDeviceRecords(deviceId));
    let pending = 0;
    for (const entry of rebuilt) {
      if (isOpenEntryOpen(entry)) {
        pending++;
      }
    }
    console.info(`[idx] rebuild-memory device=${deviceId} count=${pending}`);
    const snapshot: MemoryIndex = { at: now, entries: rebuilt };
    this.memoryIndexCache.set(deviceId, snapshot);
    return rebuilt;
  }

  /** 把合并后的条目解析成记录：每个 (设备, 日期) 分片只读一次。 */
  private resolveRecords(merged: MergedOpenEntry[]): ScheduleRecord[] {
    const dayCache = new Map<string, ScheduleRecord[]>();
    const unresolved: MergedOpenEntry[] = [];
    const byId = new Map<string, ScheduleRecord>();
    for (const item of merged) {
      const date = item.entry.date;
      if (!DATE_KEY_RE.test(date)) {
        unresolved.push(item);
        continue;
      }
      const key = `${item.deviceId}/${date}`;
      let dayRecords = dayCache.get(key);
      if (dayRecords === undefined) {
        dayRecords = this.readDayRecords(item.deviceId, date);
        dayCache.set(key, dayRecords);
      }
      const record = pickRecord(dayRecords, item.entry.id);
      if (record === null) {
        unresolved.push(item);
      } else if (record.done !== true) {
        byId.set(record.id, record);
      }
    }
    if (unresolved.length > 0) {
      // 兜底：归属日期异常 / 记录被挪走 → 用该设备全量记录再查一次（每台设备最多一次）
      const allCache = new Map<string, ScheduleRecord[]>();
      for (const item of unresolved) {
        let all = allCache.get(item.deviceId);
        if (all === undefined) {
          all = this.readAllRecords(item.deviceId);
          allCache.set(item.deviceId, all);
        }
        const record = pickRecord(all, item.entry.id);
        if (record !== null && record.done !== true) {
          byId.set(record.id, record);
        }
      }
    }
    return sortRecords(Array.from(byId.values()));
  }

  /** 读某台设备某天的记录（本机走 `scheduleStore.readDay`，其他设备只读分片文件）。 */
  private readDayRecords(deviceId: string, date: string): ScheduleRecord[] {
    if (deviceId === scheduleStore.getDeviceId()) {
      try {
        return scheduleStore.readDay(date);
      } catch (error) {
        console.info(`[idx] 读分片失败（${deviceId}/${date}）：${describeError(error)}`);
        return [];
      }
    }
    return this.readRecordsFile(`${this.deviceSchedulesDir(deviceId)}/${date}${JSONL_SUFFIX}`, `${deviceId}/${date}`);
  }

  /** 读某台设备的全部记录（本机走 `scheduleStore.readAll`，其他设备读它的全部分片）。 */
  private readAllRecords(deviceId: string): ScheduleRecord[] {
    if (deviceId === scheduleStore.getDeviceId()) {
      try {
        return scheduleStore.readAll();
      } catch (error) {
        console.info(`[idx] 全量兜底读取失败（${deviceId}）：${describeError(error)}`);
        return [];
      }
    }
    return this.readDeviceRecords(deviceId);
  }

  /** 只读：其他设备的全部分片记录（未排序，交给 `buildIndexFromRecords` 按 ts 处理）。 */
  private readDeviceRecords(deviceId: string): ScheduleRecord[] {
    const dir = this.deviceSchedulesDir(deviceId);
    const records: ScheduleRecord[] = [];
    let names: string[] = [];
    try {
      names = fs.listFileSync(dir);
    } catch (error) {
      console.info(`[idx] 列出设备分片失败（${deviceId}）：${describeError(error)}`);
      return records;
    }
    for (const name of names) {
      if (!name.endsWith(JSONL_SUFFIX)) {
        continue;
      }
      const date = name.slice(0, name.length - JSONL_SUFFIX.length);
      if (!DATE_KEY_RE.test(date)) {
        continue;
      }
      for (const record of this.readRecordsFile(`${dir}/${name}`, `${deviceId}/${date}`)) {
        records.push(record);
      }
    }
    return records;
  }

  /** 其他设备的分片目录（只读拼接，不创建、不写入）。 */
  private deviceSchedulesDir(deviceId: string): string {
    return `${scheduleStore.devicesRoot()}/${deviceId}/${SCHEDULES_DIR_NAME}`;
  }

  /** 读一个分片文件并折叠（只读，失败只记日志）。 */
  private readRecordsFile(path: string, label: string): ScheduleRecord[] {
    try {
      if (!this.fileExists(path)) {
        return [];
      }
      return sortRecords(foldById(parseJsonl(fs.readTextSync(path)).records));
    } catch (error) {
      console.info(`[idx] 读分片失败（${label}）：${describeError(error)}`);
      return [];
    }
  }

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
