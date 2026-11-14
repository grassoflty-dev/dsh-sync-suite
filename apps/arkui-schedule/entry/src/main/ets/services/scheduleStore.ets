/**
 * 日程 JSONL 存储（**只追加，绝不重写历史行**）。
 *
 * 目录契约（`docs/DATA-CONTRACT.md` §1 / §3）：
 * ```
 * <filesDir>/git-repo/devices/<deviceId>/schedules/YYYY-MM-DD.jsonl
 * <filesDir>/git-repo/devices/<deviceId>/attachments/<sha256>.png
 * ```
 * - 保存 / 勾选完成 / 编辑一律 `appendRecord` 追加一条「同 id、新 ts」的记录；
 * - 读取走 `parseJsonl` + `foldById`（同 id 取较晚记录），跨设备目录天然不冲突；
 * - 追加是真正的物理追加（定位到文件末尾写入），不会重写历史字节。
 *
 * 契约：`docs/CONTRACT.md` §3.3、BRIEF §3.4。
 */
import { fileIo as fs } from '@kit.CoreFileKit';
import { common } from '@kit.AbilityKit';
import { encodeRecord, foldById, parseJsonl, recordDateKey, sortRecords } from '../model/jsonl';
import type { ScheduleRecord } from '../model/types';
import { localDateKey } from '../common/date';
import { DEFAULT_DEVICE_ID, normalizeDeviceId, settingsStore } from './settingsStore';

const ROOT_DIR_NAME: string = 'git-repo';
const DEVICES_DIR_NAME: string = 'devices';
const SCHEDULES_DIR_NAME: string = 'schedules';
const ATTACHMENTS_DIR_NAME: string = 'attachments';
const JSONL_SUFFIX: string = '.jsonl';
const NEW_LINE_BYTE: number = 0x0a;
/** 设备目录名合法性（与 DATA-CONTRACT §1 一致）。 */
const DEVICE_ID_RE: RegExp = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** 把异常转成可展示的中文文本。 */
export function describeError(error: object): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/** 新记录 id：毫秒时间戳 + 随机后缀（全局唯一，跨设备折叠键）。 */
export function newRecordId(): string {
  const stamp = Date.now().toString(36);
  const random = Math.floor(Math.random() * 1679615).toString(36);
  return `${stamp}-${random}`;
}

/** 记录归属日期：优先 ts 的 ISO 前缀，异常 ts 回退本机今天。 */
export function resolveRecordDate(ts: string): string {
  const key = recordDateKey(ts);
  return key.length === 10 ? key : localDateKey(new Date());
}

export class ScheduleStore {
  private filesDir: string = '';
  private deviceId: string = DEFAULT_DEVICE_ID;
  private ready: boolean = false;

  /** 初始化存储（幂等）：取 filesDir、读取设置里的设备标识、创建目录。 */
  async ensureReady(context: object): Promise<void> {
    if (this.ready) {
      return;
    }
    const abilityContext = context as common.UIAbilityContext;
    const settings = await settingsStore.load(abilityContext);
    this.filesDir = abilityContext.filesDir;
    this.deviceId = normalizeDeviceId(settings.deviceId);
    this.ensureDirsSync();
    this.ready = true;
  }

  isReady(): boolean {
    return this.ready;
  }

  getDeviceId(): string {
    return this.deviceId;
  }

  getFilesDir(): string {
    return this.filesDir;
  }

  /** 切换设备标识（设置页修改后调用），并立即创建新目录。 */
  setDeviceId(deviceId: string): void {
    this.deviceId = normalizeDeviceId(deviceId);
    if (this.ready) {
      this.ensureDirsSync();
    }
  }

  /** 设备根目录：`<filesDir>/git-repo/devices/<deviceId>/`。 */
  deviceRoot(): string {
    return `${this.filesDir}/${ROOT_DIR_NAME}/${DEVICES_DIR_NAME}/${this.deviceId}`;
  }

  schedulesDir(): string {
    return `${this.deviceRoot()}/${SCHEDULES_DIR_NAME}`;
  }

  attachmentsDir(): string {
    return `${this.deviceRoot()}/${ATTACHMENTS_DIR_NAME}`;
  }

  /** 某天的 JSONL 路径。 */
  dayFilePath(date: string): string {
    return `${this.schedulesDir()}/${date}${JSONL_SUFFIX}`;
  }

  /** 读取某天文本（文件不存在返回空串）。 */
  readDayText(date: string): string {
    this.requireReady();
    const path = this.dayFilePath(date);
    if (!this.fileExists(path)) {
      return '';
    }
    try {
      return fs.readTextSync(path);
    } catch (error) {
      throw new Error(`读取日程文件失败（${path}）：${describeError(error)}`);
    }
  }

  /** 读取某天记录：JSONL → 折叠同 id → 按 ts 升序。 */
  readDay(date: string): ScheduleRecord[] {
    const text = this.readDayText(date);
    const parsed = parseJsonl(text);
    return sortRecords(foldById(parsed.records));
  }

  /** 列出本设备已存在的日期（`YYYY-MM-DD`，升序）。 */
  listDates(): string[] {
    this.requireReady();
    const dir = this.schedulesDir();
    const dates: string[] = [];
    if (!this.fileExists(dir)) {
      return dates;
    }
    let names: string[] = [];
    try {
      names = fs.listFileSync(dir);
    } catch (error) {
      throw new Error(`列出日程目录失败（${dir}）：${describeError(error)}`);
    }
    for (const name of names) {
      if (name.endsWith(JSONL_SUFFIX)) {
        dates.push(name.slice(0, name.length - JSONL_SUFFIX.length));
      }
    }
    dates.sort();
    return dates;
  }

  /** 读取本设备全部记录（跨日期折叠，按 ts 升序）。 */
  readAll(): ScheduleRecord[] {
    const dates = this.listDates();
    const merged: ScheduleRecord[] = [];
    for (const date of dates) {
      const parsed = parseJsonl(this.readDayText(date));
      for (const record of parsed.records) {
        merged.push(record);
      }
    }
    return sortRecords(foldById(merged));
  }

  /** 全部设备目录根：`<filesDir>/git-repo/devices`（只读其他设备，永不写入）。 */
  devicesRoot(): string {
    return `${this.filesDir}/${ROOT_DIR_NAME}/${DEVICES_DIR_NAME}`;
  }

  /** 本机磁盘上存在的设备标识（自己 + 已 fetch/pull 的其他设备），过滤非法目录名。 */
  listDeviceIds(): string[] {
    this.requireReady();
    const root = this.devicesRoot();
    const ids: string[] = [];
    if (!this.fileExists(root)) {
      return ids;
    }
    let names: string[] = [];
    try {
      names = fs.listFileSync(root);
    } catch (error) {
      throw new Error(`列出设备目录失败（${root}）：${describeError(error)}`);
    }
    for (const name of names) {
      if (!DEVICE_ID_RE.test(name)) {
        continue;
      }
      if (this.fileExists(`${root}/${name}/${SCHEDULES_DIR_NAME}`)) {
        ids.push(name);
      }
    }
    ids.sort();
    return ids;
  }

  /** 读某设备某天的记录（只读；用于跨设备折叠展示）。 */
  private readDeviceDay(deviceId: string, date: string): ScheduleRecord[] {
    const path = `${this.devicesRoot()}/${deviceId}/${SCHEDULES_DIR_NAME}/${date}${JSONL_SUFFIX}`;
    if (!this.fileExists(path)) {
      return [];
    }
    try {
      return parseJsonl(fs.readTextSync(path)).records;
    } catch (error) {
      throw new Error(`读取其他设备日程失败（${path}）：${describeError(error)}`);
    }
  }

  /** 读所有设备某天的记录并折叠（BRIEF §3.4：fetch 后折叠展示；本机目录优先）。 */
  readDayAllDevices(date: string): ScheduleRecord[] {
    this.requireReady();
    const merged: ScheduleRecord[] = [];
    for (const deviceId of this.listDeviceIds()) {
      for (const record of this.readDeviceDay(deviceId, date)) {
        merged.push(record);
      }
    }
    return sortRecords(foldById(merged));
  }

  /** 读所有设备全部记录并折叠（只读）。 */
  readAllDevices(): ScheduleRecord[] {
    this.requireReady();
    const merged: ScheduleRecord[] = [];
    for (const deviceId of this.listDeviceIds()) {
      for (const date of this.listDeviceDates(deviceId)) {
        for (const record of this.readDeviceDay(deviceId, date)) {
          merged.push(record);
        }
      }
    }
    return sortRecords(foldById(merged));
  }

  /** 某设备已有的日期列表（只读）。 */
  private listDeviceDates(deviceId: string): string[] {
    const dir = `${this.devicesRoot()}/${deviceId}/${SCHEDULES_DIR_NAME}`;
    if (!this.fileExists(dir)) {
      return [];
    }
    let names: string[] = [];
    try {
      names = fs.listFileSync(dir);
    } catch {
      return [];
    }
    const dates: string[] = [];
    for (const name of names) {
      if (name.endsWith(JSONL_SUFFIX)) {
        dates.push(name.slice(0, name.length - JSONL_SUFFIX.length));
      }
    }
    dates.sort();
    return dates;
  }

  /** 按 id 查一条折叠后的记录（先本机，再其他设备；找不到返回 null）。 */
  findById(id: string): ScheduleRecord | null {
    const all = this.readAll();
    for (const record of all) {
      if (record.id === id) {
        return record;
      }
    }
    return null;
  }

  /** 跨设备按 id 查找（详情/编辑打开其他设备记录时使用，只读）。 */
  findByIdAny(id: string): ScheduleRecord | null {
    const own = this.findById(id);
    if (own !== null) {
      return own;
    }
    const merged = this.readAllDevices();
    for (const record of merged) {
      if (record.id === id) {
        return record;
      }
    }
    return null;
  }

  /**
   * 追加一条记录（物理追加到它 ts 所属日期的文件末尾）。
   * 同 id 的新记录即「更新」：读时 `foldById` 会取 ts 较晚的一条。
   */
  appendRecord(record: ScheduleRecord): void {
    this.requireReady();
    let encoded: string = '';
    try {
      encoded = encodeRecord(record);
    } catch (error) {
      throw new Error(`日程记录不合法：${describeError(error)}`);
    }
    const date = resolveRecordDate(record.ts);
    this.ensureDirsSync();
    const path = this.dayFilePath(date);
    try {
      this.appendLineSync(path, encoded);
    } catch (error) {
      throw new Error(`写入日程失败（${path}）：${describeError(error)}`);
    }
  }

  /** 确认目录存在（幂等）。 */
  ensureDirs(): void {
    this.ensureDirsSync();
  }

  // ------------------------------------------------------------------ 内部实现

  private requireReady(): void {
    if (!this.ready) {
      throw new Error('日程存储尚未初始化：请先调用 scheduleStore.ensureReady(context)');
    }
  }

  private ensureDirsSync(): void {
    if (this.filesDir.length === 0) {
      throw new Error('文件根目录尚未就绪：请先调用 scheduleStore.ensureReady(context)');
    }
    this.ensureDirSync(this.schedulesDir());
    this.ensureDirSync(this.attachmentsDir());
  }

  private ensureDirSync(dir: string): void {
    if (this.fileExists(dir)) {
      return;
    }
    try {
      fs.mkdirSync(dir, true);
    } catch (error) {
      throw new Error(`创建目录失败（${dir}）：${describeError(error)}`);
    }
  }

  private fileExists(path: string): boolean {
    try {
      return fs.accessSync(path);
    } catch {
      return false;
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
}

/** 全局单例：页面与服务共用同一份目录状态。 */
export const scheduleStore: ScheduleStore = new ScheduleStore();
