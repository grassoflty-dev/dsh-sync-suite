/**
 * v2 单时间线**只读**服务（mod-v2-only：v2 是唯一读写路径）。
 *
 * 职责边界（与契约 docs/DATA-CONTRACT-v2.md §2/§6/§7/§11 对齐）：
 * - 只读：本文件**从不写任何 v2 路径**，不提供任何写入口；唯一的持久化写入方
 *   是同步 / 写入服务，本服务连临时文件都不建。
 * - 门槛：ensureReady() 只读一次 `<filesDir>/git-repo/timeline/schema.json`，交给纯函数
 *   parseSchemaMarker 判定；`schemaVersion === 2` 才算已迁移。缺文件、坏 JSON、别的版本
 *   一律是**未迁移**状态：首页显示固定横幅，所有写入在任何 IO 之前抛 E_NOT_MIGRATED；
 *   本文件不修改任何标记、不迁移数据、不删 v1。
 * - 没有 open.jsonl、没有 reconcile、没有派生索引：v2 的「未完成」直接由记录内 closed_at
 *   缺省推导（model/timeline.ts 的 openRecords()），本服务只做文件字节与时机。
 * - 不自带解析器：records.json / 两本账本 / schema 标记全部交给 model/timeline.ts 的纯函数，
 *   本文件只负责定位路径、读文本、把纯函数结果转给调用方。
 * - 删撤销账本 visibleRecords() 是唯一的展示记录来源；day.allRecords 绝不外泄给页面。
 * - 没有 v1/v2 模式开关、没有读模式回退：任何读路径都直接查 v2 时间线；未迁移时返回空。
 * - 任何读取异常都吞掉并记一条 `console.info('[tl] …')`，绝不抛给调用方；
 *   返回类型沿用页面既有的 ScheduleRecord，v2 的多余字段（media/opened_at/closed_at 等）
 *   随对象原样带出，不做字段裁剪。
 */
import { fileIo as fs } from '@kit.CoreFileKit';
import { common } from '@kit.AbilityKit';
import {
  parseSchemaMarker,
  parseTimelineDay,
  parseLedger,
  visibleRecords,
  openRecords,
  timelineDayPath
} from '../model/timeline';
import type { TimelineDay, TimelineRecord, LedgerEntry } from '../model/timeline';
import type { ScheduleRecord } from '../model/types';

const ROOT_DIR_NAME: string = 'git-repo';
const SCHEMA_FILE_NAME: string = 'schema.json';
const DELETED_FILE_NAME: string = 'deleted.jsonl';
const RESTORE_FILE_NAME: string = 'restore.jsonl';
const SUMMARY_FILE_NAME: string = 'summary.json';
/** 日期目录的**形状**：YYYY-MM-DD；真实日历合法性由 isCalendarDate() 往返校验（契约 §2 可测项）。 */
const DATE_KEY_RE: RegExp = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 一日三文件的解析结果（loadDay 的返回类型）。
 * ArkTS 不允许把对象字面量直接当类型声明，故显式声明本接口。
 */
interface LoadedDay {
  day: TimelineDay;
  deleted: LedgerEntry[];
  restored: LedgerEntry[];
}

export class TimelineStore {
  private filesDir: string = '';
  private ready: boolean = false;
  /** schema 门槛结论；缺省 false，只有标记明确为 v2 时才翻成 true。 */
  private v2: boolean = false;

  /**
   * 初始化（幂等）：取 filesDir，读一次仓库级 schema 标记。
   *
   * 任何异常都按「未迁移」处理并记日志，绝不抛；页面据此显示唯一横幅并拒绝写入。
   */
  async ensureReady(context: object): Promise<void> {
    if (this.ready) {
      return;
    }
    const abilityContext = context as common.UIAbilityContext;
    this.filesDir = abilityContext.filesDir;
    try {
      const markerPath = this.schemaPath();
      if (!this.fileExists(markerPath)) {
        console.info('[tl] 缺少 timeline/schema.json，按未迁移处理');
      } else {
        const marker = parseSchemaMarker(fs.readTextSync(markerPath));
        // 门槛：parseSchemaMarker(...).ok !== true → 未迁移（缺字段 / 坏 JSON / 其他版本一律拒绝写入）
        if (marker.ok !== true) {
          console.info('[tl] schema 标记不是 v2，按未迁移处理：' + marker.reason);
          this.v2 = false;
        } else {
          this.v2 = true;
        }
      }
    } catch (error) {
      this.v2 = false;
      console.info('[tl] 读取 schema 标记失败，按未迁移处理：' + this.errorText(error));
    }
    this.ready = true;
  }

  isReady(): boolean {
    return this.ready;
  }

  /** 仓库级 schema 标记是否明确为 v2（即迁移已完成）。 */
  isV2(): boolean {
    return this.ready && this.v2;
  }

  /** v2 是唯一读写路径：迁移完成即可读写；未迁移时所有写入拒绝、读返回空。 */
  isMigrated(): boolean {
    return this.isV2();
  }

  /** 有 records.json 的合法日历日目录（升序）。未迁移时返回空。 */
  listDates(): string[] {
    const dates: string[] = [];
    if (!this.isV2()) {
      return dates;
    }
    try {
      const root = this.timelineRoot();
      if (!this.fileExists(root)) {
        return dates;
      }
      const names: string[] = fs.listFileSync(root);
      let skipped: number = 0;
      for (const name of names) {
        if (!DATE_KEY_RE.test(name)) {
          // 非日期形状目录（.git 等）本就不是日目录，静默跳过。
          continue;
        }
        if (!this.isCalendarDate(name)) {
          // 形状像日期但不是真实日历日（如 2026-13-99）：跳过并计数，绝不读其内容。
          skipped += 1;
          continue;
        }
        if (!this.fileExists(`${root}/${name}/records.json`)) {
          continue;
        }
        dates.push(name);
      }
      if (skipped > 0) {
        console.info('[tl] skipped invalid day dirs=' + skipped);
      }
      dates.sort();
    } catch (error) {
      console.info('[tl] 列出时间线日期失败：' + this.errorText(error));
      return [];
    }
    return dates;
  }

  /**
   * 某日的可见记录：records.json + deleted.jsonl + restore.jsonl → visibleRecords()。
   * 未知日期 / 解析失败 / 任何异常都返回 [] 并只记一条 `[tl]` 日志，不外抛。
   */
  readDay(date: string): ScheduleRecord[] {
    if (!this.isV2() || !this.isCalendarDate(date)) {
      return [];
    }
    try {
      const day = this.loadDay(date);
      if (day === null) {
        console.info('[tl] ' + date + ' 的 records.json 无法解析，返回空');
        return [];
      }
      return this.asScheduleRecords(visibleRecords(day.day, day.deleted, day.restored));
    } catch (error) {
      console.info('[tl] 读 ' + date + ' 失败：' + this.errorText(error));
      return [];
    }
  }

  /** 全部可见记录（跨日期拼接后按 ts 升序），非 v2 返回 []。 */
  readAll(): ScheduleRecord[] {
    if (!this.isV2()) {
      return [];
    }
    try {
      const all: ScheduleRecord[] = [];
      for (const date of this.listDates()) {
        for (const record of this.readDay(date)) {
          all.push(record);
        }
      }
      all.sort((left: ScheduleRecord, right: ScheduleRecord): number => this.compareTs(left.ts, right.ts));
      return all;
    } catch (error) {
      console.info('[tl] 读全部记录失败：' + this.errorText(error));
      return [];
    }
  }

  /**
   * 全部未完成：逐日走 openRecords()（只看 closed_at 缺省，绝不用 done、不信 open 缓存），
   * 按 ts 升序；非 v2 返回 []。这里不碰 openIndexStore，也不做 reconcile。
   */
  pendingRecords(): ScheduleRecord[] {
    if (!this.isV2()) {
      return [];
    }
    try {
      const open: ScheduleRecord[] = [];
      for (const date of this.listDates()) {
        const loaded = this.loadDay(date);
        if (loaded === null) {
          continue;
        }
        for (const record of openRecords(loaded.day, loaded.deleted, loaded.restored)) {
          open.push(this.asScheduleRecord(record));
        }
      }
      open.sort((left: ScheduleRecord, right: ScheduleRecord): number => this.compareTs(left.ts, right.ts));
      return open;
    } catch (error) {
      console.info('[tl] 读全部未完成失败：' + this.errorText(error));
      return [];
    }
  }

  /** 当日 summary.json 原文；缺文件 / 读失败返回 ''。 */
  readSummaryText(date: string): string {
    if (!this.isV2() || !this.isCalendarDate(date)) {
      return '';
    }
    try {
      return this.readText(`${this.timelineRoot()}/${date}/${SUMMARY_FILE_NAME}`);
    } catch (error) {
      console.info('[tl] 读 ' + date + ' 汇总失败：' + this.errorText(error));
      return '';
    }
  }

  // ------------------------------------------------------------------ 内部实现

  /**
   * 真实日历日校验：先判 YYYY-MM-DD 形状，再按本地时间 new Date(y, m-1, d) 往返比对。
   * 年份限定 1..9999（new Date 会把 0..99 解释成 1900+，故用 setFullYear 校正）。
   * 2026-13-99 / 2026-02-30 判非法；2028-02-29 这类闰日判合法。
   */
  private isCalendarDate(name: string): boolean {
    if (!DATE_KEY_RE.test(name)) {
      return false;
    }
    const year: number = Number(name.slice(0, 4));
    const month: number = Number(name.slice(5, 7));
    const day: number = Number(name.slice(8, 10));
    if (year < 1 || year > 9999) {
      return false;
    }
    const probe = new Date(year, month - 1, day);
    probe.setFullYear(year);
    return probe.getFullYear() === year && probe.getMonth() === month - 1 && probe.getDate() === day;
  }

  /** `<filesDir>/git-repo/timeline/schema.json`。 */
  private schemaPath(): string {
    return `${this.filesDir}/${ROOT_DIR_NAME}/timeline/${SCHEMA_FILE_NAME}`;
  }

  /** `<filesDir>/git-repo/timeline/<date>/`。records.json 路径复用 model 的 timelineDayPath。 */
  private timelineRoot(): string {
    return `${this.filesDir}/${ROOT_DIR_NAME}/timeline`;
  }

  private dayRecordsPath(date: string): string {
    return `${this.filesDir}/${ROOT_DIR_NAME}/${timelineDayPath(date)}`;
  }

  /** 一日的三个文件一次性读入并交给纯函数；顶层坏文件返回 null（不抛）。 */
  private loadDay(date: string): LoadedDay | null {
    const parsed = parseTimelineDay(this.readText(this.dayRecordsPath(date)), date);
    if (parsed.day === null) {
      return null;
    }
    const root = `${this.timelineRoot()}/${date}`;
    const deleted = parseLedger(this.readText(`${root}/${DELETED_FILE_NAME}`)).entries;
    const restored = parseLedger(this.readText(`${root}/${RESTORE_FILE_NAME}`)).entries;
    if (parsed.errors.length > 0) {
      console.info('[tl] ' + date + ' 有 ' + parsed.errors.length + ' 行坏行（已跳过）');
    }
    const loaded: LoadedDay = { day: parsed.day, deleted: deleted, restored: restored };
    return loaded;
  }

  /**
   * 原样带出 v2 记录的全部字段（包括未知字段），只做类型视图转换，不拷贝、不裁剪。
   * TimelineRecord 结构上是 ScheduleRecord 的扩展（同名同类型字段 + 额外字段），
   * 因此可直接按结构赋值；返回同一个对象引用，未知字段原样随对象带出。
   */
  private asScheduleRecord(record: TimelineRecord): ScheduleRecord {
    return record;
  }

  private asScheduleRecords(records: TimelineRecord[]): ScheduleRecord[] {
    const out: ScheduleRecord[] = [];
    for (const record of records) {
      out.push(this.asScheduleRecord(record));
    }
    return out;
  }

  /** ts 比较：可解析按时刻，否则字符串序（与 model/timeline.ts 同口径）。 */
  private compareTs(left: string, right: string): number {
    const a = Date.parse(left);
    const b = Date.parse(right);
    if (!Number.isNaN(a) && !Number.isNaN(b)) {
      return a === b ? 0 : (a < b ? -1 : 1);
    }
    return left === right ? 0 : (left < right ? -1 : 1);
  }

  /** 读文本：文件不存在返回 ''，异常由调用方的 try/catch 统一记日志并降级。 */
  private readText(path: string): string {
    if (!this.fileExists(path)) {
      return '';
    }
    return fs.readTextSync(path);
  }

  private fileExists(path: string): boolean {
    try {
      return fs.accessSync(path);
    } catch {
      return false;
    }
  }

  private errorText(error: object): string {
    return error instanceof Error ? error.message : String(error);
  }
}

/** 全局单例：页面与后续模块共用同一份目录与门槛状态。 */
export const timelineStore: TimelineStore = new TimelineStore();
