/**
 * v2 单时间线**写入**服务（mod-v2-write-service）。默认**惰性**：只有仓库标记明确为 v2
 * 且开关 timeline.readMode='v2' 时才允许落盘；否则每个公开方法在**任何 IO 之前**抛出
 * `Error('timeline v2 写入未启用')`，调用方继续走原 v1 写路径。本模块不翻转开关、不接 UI。
 *
 * 与契约 docs/DATA-CONTRACT-v2.md §3/§6/§7/§8/§11 对齐：
 * - records.json 原子替换：同目录临时文件 → `renameSync`，永不写半个文件、永不先删原文件；
 * - deleted.jsonl / restore.jsonl **只追加**：先读旧字节、再追加一行、最后原子落盘，
 *   旧字节恒为新字节的严格前缀（§7 P2-3）；按 `(id, ts)` 去重，不追加第二份；
 * - 删除三步（§7 P1-4）：scheduleDelete 只写账本、restore 追加撤销账本（校验 ts 严格更晚）、
 *   purgeRows 仅在确认后物理清行；`remove()` 仅为兼容保留的废弃包装；
 * - summary.json 原子替换，`generatedAt` 较新者胜、相等 / 坏候选保留现有字节（§8，
 *   判定下沉到纯模型 `isNewerSummaryText`）；
 * - 读侧复用 model/timeline 的 parseTimelineDay / parseLedger / visibleRecords 做写前基线，
 *   已删记录不参与基线，绝不因一次保存把已删记录复活；
 * - 所有路径都由 model/timeline 的 timelineDayPath(date) 或其同级文件名派生，
 *   绝不触碰旧 v1 目录；本文件不写 AppStorage（只读开关）、不建 schema 标记。
 *
 * **职责边界**：仓库级门禁 `assertWritable()`（schema + 分支 `main` + HEAD==origin/main）与
 * outbox / union / replay 同步周期是 `mod-v2-sync-protocol` 的职责；本模块只做**单进程原子写**
 * 与本地账本落盘，不实现分支断言、不跨设备收敛、不自动 commit / push。
 *
 * 原子替换的安全序列（既不留目标缺失窗口，也不删除唯一一份内容）：
 * ① 写 `<file>.tmp-<tag>-<时间戳>-<序号>` 并回读校验字节；
 * ② 首选覆盖式 rename；失败则把原文件改名为 `<file>.bak-...`（**绝不 unlink 原文件**）；
 * ③ 再把 tmp 改成正式文件；任一步失败都把 backup 恢复回正式文件，并保留 tmp / backup 现场；
 * ④ 只有新文件确认就位后才删除 backup。残留侧文件由 `recoverTemps()` 在启动 / 首次写前收拾。
 *
 * ArkTS 没有 Node 的 process.pid：侧文件后缀用「实例随机标签 + 时间戳 + 进程内单调序号」，
 * 保证两个 store 实例在同一毫秒、同一序号上也不碰撞（仅用于命名，不参与任何数据字节）。
 */
import { fileIo as fs } from '@kit.CoreFileKit';
import { common } from '@kit.AbilityKit';
import { timelineStore } from './timelineStore';
import { parseTimelineDay, parseLedger, visibleRecords, timelineDayPath } from '../model/timeline';
import type { TimelineRecord, TimelineMedia } from '../model/timeline';
import type { ScheduleRecord, Attachment } from '../model/types';
import {
  planUpsert, planRemove, ledgerDeleteLine, ledgerRestoreLine,
  tsMillis, isValidTsShape, isNewerSummaryText, canPurge
} from '../model/timelineWrite';

/**
 * 入站记录视图：静态类型是 ScheduleRecord，但读侧原样带出的 v2 对象运行时仍带扩展字段。
 * 这些字段全部可选，访问后一律用 typeof 收窄——ArkTS 禁用 any / unknown / 索引签名。
 */
interface IncomingRecord extends ScheduleRecord {
  opened_at?: string;
  closed_at?: string;
  media?: TimelineMedia[];
}

/** 账本行的已知字段；坏行可能缺字段，故全部可选，读取时用 typeof 收窄。 */
interface LedgerRowShape {
  id?: string;
  ts?: string;
}

const ROOT_DIR_NAME: string = 'git-repo';
const TIMELINE_DIR_NAME: string = 'timeline';
const RECORDS_FILE_NAME: string = 'records.json';
const DELETED_FILE_NAME: string = 'deleted.jsonl';
const RESTORE_FILE_NAME: string = 'restore.jsonl';
const SUMMARY_FILE_NAME: string = 'summary.json';
const TMP_INFIX: string = '.tmp-';
const BAK_INFIX: string = '.bak-';
const NEW_LINE: string = '\n';

/** 本地媒体文件名：<sha256 前 16 位小写 hex>.jpg（与契约 §5 一致，非法附件跳过）。 */
const MEDIA_SHA_RE: RegExp = /^[0-9a-fA-F]{64}$/;

/** 未启用时的唯一错误文案（调用方据此判断「保持 v1」）。 */
const DISABLED_MESSAGE: string = 'timeline v2 写入未启用';

/** ts 形状错误的类型化文案（写侧删除相关入口 + append 共用）。 */
const TS_SHAPE_ERROR: string = 'E_TS_SHAPE: 时间戳格式不合法（需 YYYY-MM-DDTHH:mm:ss 且可解析）';

/** N1：无删除账本行却试图物理清行时的类型化错误（调用方据此区分拒绝写入）。 */
const PURGE_WITHOUT_LEDGER_ERROR: string = 'E_PURGE_WITHOUT_LEDGER: 无删除账本记录，拒绝物理清行';

export class TimelineWriteStore {
  private filesDir: string = '';
  private ready: boolean = false;
  /** 进程内 tmp / backup 序号；配合实例标签与时间戳保证跨实例唯一。 */
  private writeSeq: number = 0;
  /** 每个 store 实例独立的随机标签（非墙钟，仅命名用）。 */
  private instanceTag: string = Math.random().toString(36).slice(2, 10);
  /** 已做过启动恢复的日目录（按 dir 去重，每个进程每目录一次）。 */
  private recoveredDirs: string[] = [];

  /**
   * 初始化（幂等）：取 filesDir。只读路径由 timelineStore 负责；这里只建立写路径前缀。
   * 未初始化时所有写方法在守卫之后立即抛错，绝不拼出 `/git-repo/...` 的错误路径。
   */
  async ensureReady(context: object): Promise<void> {
    if (this.ready) {
      return;
    }
    const abilityContext = context as common.UIAbilityContext;
    this.filesDir = abilityContext.filesDir;
    this.ready = true;
  }

  /** 唯一开关：复用只读服务的组合判定（仓库确为 v2 且读模式选了 v2）。 */
  isEnabled(): boolean {
    return timelineStore.useV2();
  }

  /** upsert：把一条 v1 形状记录规范化为 v2 记录后写入当日 records.json。 */
  append(record: ScheduleRecord, date: string): void {
    this.requireEnabled();
    this.requireReady();
    // N2：在任何 IO 之前校验 ts 形状；畸形 ts 抛 E_TS_SHAPE，绝不进入主写路径。
    this.requireTs(record.ts);
    const base: TimelineRecord[] = this.visibleOf(date);
    const existing: TimelineRecord | null = this.findById(base, record.id);
    const incoming: TimelineRecord = this.toTimelineRecord(record, existing);
    const plan = planUpsert(date, base, incoming);
    if (!plan.ok) {
      throw new Error(`写入 v2 记录失败：${plan.reason}`);
    }
    this.atomicWriteIn(this.dayDir(date), RECORDS_FILE_NAME, plan.text);
  }

  /**
   * §7 P1-4 第一步（schedule，点删除）：只向 deleted.jsonl 追加事实，
   * **records.json 行原样保留**，5 秒宽限期纯属 UI；账本立即落盘，远端立刻可见删除。
   */
  scheduleDelete(id: string, date: string, ts: string): void {
    this.requireEnabled();
    this.requireReady();
    this.requireTs(ts);
    const line: string = ledgerDeleteLine(id, ts, ts);
    if (line.length === 0) {
      throw new Error('删除账本行参数不合法：id / ts 不能为空');
    }
    this.appendLedgerLine(this.dayDir(date), DELETED_FILE_NAME, line);
  }

  /**
   * §7 P1-4 第二步（cancel / restore）：只向 restore.jsonl 追加一行，记录行原样保留。
   * 撤销 ts 必须**严格晚于**该 id 在 deleted.jsonl 中的最大 ts，否则读侧仍判不可见
   * （§7 读侧优先级 R > D），调用方会误以为撤销成功——这里 fail-closed。
   */
  restore(id: string, date: string, ts: string): void {
    this.requireEnabled();
    this.requireReady();
    this.requireTs(ts);
    const dir: string = this.dayDir(date);
    const deleted = parseLedger(this.readText(`${dir}/${DELETED_FILE_NAME}`)).entries;
    let latestDeleteMillis: number | null = null;
    for (const entry of deleted) {
      if (entry.id !== id) {
        continue;
      }
      const at: number | null = tsMillis(entry.ts);
      if (at !== null && (latestDeleteMillis === null || at > latestDeleteMillis)) {
        latestDeleteMillis = at;
      }
    }
    if (latestDeleteMillis !== null) {
      const candidate: number | null = tsMillis(ts);
      if (candidate === null || candidate <= latestDeleteMillis) {
        throw new Error('restore 时间必须晚于删除');
      }
    }
    const line: string = ledgerRestoreLine(id, ts, ts);
    if (line.length === 0) {
      throw new Error('撤销账本行参数不合法：id / ts 不能为空');
    }
    this.appendLedgerLine(dir, RESTORE_FILE_NAME, line);
  }

  /**
   * §7 P1-4 第三步（confirm / 超时）：才物理移除该 id 的全部版本行并重算 open。
   * 只在确认后调用；id 不存在（或已被上一次清掉）时为幂等 no-op，不做任何 IO。
   */
  purgeRows(id: string, date: string, ts: string): void {
    this.requireEnabled();
    this.requireReady();
    this.requireTs(ts);
    const dir: string = this.dayDir(date);
    // N1：基线必须是**原始版本行**（allRecords），不能用账本过滤后的 visibleOf——
    // scheduleDelete 已写 D 账本，该 id 会被 deletionState 过滤，用 visibleOf 会让 confirm 步空转。
    const parsed = parseTimelineDay(this.readText(this.recordsPath(date)), date);
    if (parsed.day === null || parsed.errors.length > 0) {
      throw new Error(`v2 records.json 无法安全读取（${date}），拒绝清行`);
    }
    const base: TimelineRecord[] = parsed.day.allRecords;
    const deleted = parseLedger(this.readText(`${dir}/${DELETED_FILE_NAME}`)).entries;
    // 账本前置校验必须先于幂等短路：无删除账本行绝不物理删除仍可见的行（N1）。
    let hasLedger: boolean = false;
    for (const entry of deleted) {
      if (entry.id === id) {
        hasLedger = true;
        break;
      }
    }
    if (!hasLedger) {
      throw new Error(PURGE_WITHOUT_LEDGER_ERROR);
    }
    // 幂等：id 已在原始行中消失（上一次已清掉）但有账本行 → no-op，不做任何 IO。
    let present: boolean = false;
    for (const record of base) {
      if (record.id === id) {
        present = true;
        break;
      }
    }
    if (!present) {
      return;
    }
    // 纯模型复核：账本 + 原始行必须同时成立，才允许写盘（守卫先于 planRemove / atomicWriteIn）。
    if (!canPurge(base, deleted, id)) {
      throw new Error(PURGE_WITHOUT_LEDGER_ERROR);
    }
    const plan = planRemove(date, base, id);
    if (!plan.ok) {
      throw new Error(`移除 v2 记录失败（ts=${ts}）：${plan.reason}`);
    }
    this.atomicWriteIn(dir, RECORDS_FILE_NAME, plan.text);
  }

  /**
   * @deprecated 只等价于 `scheduleDelete`（账本落盘、记录行保留）。
   * 物理清行必须用 `purgeRows`；本包装**不可**用于需要 5 秒撤销的 UI 窗口。
   */
  remove(id: string, date: string, ts: string): void {
    this.requireEnabled();
    this.requireReady();
    this.requireTs(ts);
    this.scheduleDelete(id, date, ts);
  }

  /** 每日汇总：generatedAt 较新者胜，相等 / 更旧 / 坏候选保留现有文件字节（§8）。 */
  appendSummary(date: string, text: string): void {
    this.requireEnabled();
    this.requireReady();
    const dir: string = this.dayDir(date);
    const existing: string = this.readText(`${dir}/${SUMMARY_FILE_NAME}`);
    if (!isNewerSummaryText(existing, text)) {
      return;
    }
    this.atomicWriteIn(dir, SUMMARY_FILE_NAME, text);
  }

  // ------------------------------------------------------------------ 门禁与路径

  /** 所有公开方法的第一句：未启用时在任何 IO 之前抛错。 */
  private requireEnabled(): void {
    if (!this.isEnabled()) {
      throw new Error(DISABLED_MESSAGE);
    }
  }

  private requireReady(): void {
    if (this.filesDir.length === 0) {
      throw new Error('timeline v2 写入存储尚未初始化：请先调用 timelineWriteStore.ensureReady(context)');
    }
  }

  /** 写侧 ts 形状门禁：形状 + 可解析，不合法抛类型化错误（E_TS_SHAPE）。 */
  private requireTs(ts: string): void {
    if (!isValidTsShape(ts)) {
      throw new Error(TS_SHAPE_ERROR);
    }
  }

  private timelineRoot(): string {
    return `${this.filesDir}/${ROOT_DIR_NAME}/${TIMELINE_DIR_NAME}`;
  }

  private dayDir(date: string): string {
    return `${this.timelineRoot()}/${date}`;
  }

  /** 复用纯模型的路径函数，保证与读侧定位同一份文件。 */
  private recordsPath(date: string): string {
    return `${this.filesDir}/${ROOT_DIR_NAME}/${timelineDayPath(date)}`;
  }

  // ------------------------------------------------------------------ 写前基线

  /** records.json + 两本账本 → 可见记录；坏文件 fail-closed，绝不丢着写。 */
  private visibleOf(date: string): TimelineRecord[] {
    const parsed = parseTimelineDay(this.readText(this.recordsPath(date)), date);
    if (parsed.day === null || parsed.errors.length > 0) {
      throw new Error(`v2 records.json 无法安全读取（${date}），拒绝写入`);
    }
    const dir: string = this.dayDir(date);
    const deleted = parseLedger(this.readText(`${dir}/${DELETED_FILE_NAME}`)).entries;
    const restored = parseLedger(this.readText(`${dir}/${RESTORE_FILE_NAME}`)).entries;
    return visibleRecords(parsed.day, deleted, restored);
  }

  private findById(records: TimelineRecord[], id: string): TimelineRecord | null {
    for (let i = 0; i < records.length; i += 1) {
      if (records[i].id === id) {
        return records[i];
      }
    }
    return null;
  }

  /** v1 ScheduleRecord → v2 TimelineRecord：补 media / opened_at / closed_at，未知字段原样尾随。 */
  private toTimelineRecord(record: ScheduleRecord, existing: TimelineRecord | null): TimelineRecord {
    const src: IncomingRecord = record as IncomingRecord;
    const incomingOpened: string | undefined = src.opened_at;
    const openedAt: string = typeof incomingOpened === 'string' && incomingOpened.length > 0
      ? incomingOpened
      : (existing !== null ? existing.opened_at : record.ts);
    const out: TimelineRecord = {
      id: record.id,
      ts: record.ts,
      title: record.title,
      body: record.body,
      author: record.author,
      done: record.done,
      media: this.mediaOf(src.media, record.attachments),
      ai_processed: record.ai_processed,
      opened_at: openedAt
    };
    if (record.ocr_text !== undefined) {
      out.ocr_text = record.ocr_text;
    }
    if (record.ai_structured !== undefined) {
      out.ai_structured = record.ai_structured;
    }
    if (record.ocr_time !== undefined) {
      out.ocr_time = record.ocr_time;
    }
    const closed: string | undefined = src.closed_at;
    if (typeof closed === 'string' && closed.length > 0) {
      out.closed_at = closed;
    } else if (record.done) {
      // v1 没有 closed_at；勾选完成等价于关闭当前会话（§6 open 谓词只看 closed_at）。
      out.closed_at = record.ts;
    }
    // 未知字段原样尾随：src 与 record 是同一对象，借 TimelineRecord 的声明形状逐键搬运；
    // 用显式字段名集合替代被 ArkTS 禁用的 in / hasOwnProperty.call（只枚举自有可枚举键）。
    const tailSource: TimelineRecord = record as TimelineRecord;
    const written: Set<string> = this.writtenFieldNames(out);
    for (const key of Object.keys(tailSource)) {
      if (!written.has(key)) {
        out[key] = tailSource[key];
      }
    }
    return out;
  }

  /** out 上已写入的字段名：必写字段 + 本次实际带出的可选字段（不用 in / 原型方法）。 */
  private writtenFieldNames(out: TimelineRecord): Set<string> {
    const names: Set<string> = new Set<string>();
    names.add('id');
    names.add('ts');
    names.add('title');
    names.add('body');
    names.add('author');
    names.add('done');
    names.add('media');
    names.add('ai_processed');
    names.add('opened_at');
    if (out.ocr_text !== undefined) {
      names.add('ocr_text');
    }
    if (out.ai_structured !== undefined) {
      names.add('ai_structured');
    }
    if (out.ocr_time !== undefined) {
      names.add('ocr_time');
    }
    if (out.closed_at !== undefined) {
      names.add('closed_at');
    }
    return names;
  }

  /**
   * 已是 v2 media 原样用；否则把 v1 attachments 映射为 <sha16>.jpg 占位（解包归独立模块）。
   * 入参全是声明过形状的字段；运行时仍用 typeof / Array.isArray 收窄，畸形数据只跳过坏条目。
   */
  private mediaOf(incomingMedia: TimelineMedia[] | undefined, attachments: Attachment[] | undefined): TimelineMedia[] {
    const out: TimelineMedia[] = [];
    if (Array.isArray(incomingMedia)) {
      for (const item of incomingMedia) {
        if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
          out.push(item);
        }
      }
      return out;
    }
    if (!Array.isArray(attachments)) {
      return out;
    }
    for (const item of attachments) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        continue;
      }
      const sha: string = item.sha256;
      if (typeof sha !== 'string' || !MEDIA_SHA_RE.test(sha)) {
        continue;
      }
      const lower: string = sha.toLowerCase();
      const page: number = item.pageIndex;
      const pageIndex: number = typeof page === 'number' && Number.isInteger(page) && page >= 0 ? page : 0;
      out.push({ file: `${lower.slice(0, 16)}.jpg`, sha256: lower, pageIndex: pageIndex });
    }
    return out;
  }

  // ------------------------------------------------------------------ 落盘原语

  /**
   * 追加式账本：旧字节恒为新字节的严格前缀；按 `(id, ts)` 去重（§7 并集合并键），
   * 解析不了的历史行退化为整行比较，绝不误删任何历史行。
   */
  private appendLedgerLine(dir: string, fileName: string, line: string): void {
    const path: string = `${dir}/${fileName}`;
    const existing: string = this.readText(path);
    const oldLines: string[] = existing.split(NEW_LINE);
    const key: string | null = this.ledgerKey(line);
    for (let i = 0; i < oldLines.length; i += 1) {
      const old: string = oldLines[i];
      if (old === line) {
        return;
      }
      if (key !== null && this.ledgerKey(old) === key) {
        return;
      }
    }
    const head: string = existing.length === 0 || existing.endsWith(NEW_LINE) ? existing : `${existing}${NEW_LINE}`;
    this.atomicWriteIn(dir, fileName, `${head}${line}${NEW_LINE}`);
  }

  /** 从一行账本取 `(id, ts)` 去重键；坏行返回 null（调用方仍按整行比较兜底）。 */
  private ledgerKey(line: string): string | null {
    if (typeof line !== 'string' || line.length === 0) {
      return null;
    }
    try {
      const row: LedgerRowShape = JSON.parse(line);
      if (row !== null && typeof row === 'object' && !Array.isArray(row)) {
        if (typeof row.id === 'string' && typeof row.ts === 'string') {
          return `${row.id}\u0000${row.ts}`;
        }
      }
    } catch {
      // 坏行不参与键去重
    }
    return null;
  }

  /**
   * 同目录原子替换的安全序列（绝不先删原文件、绝不删唯一副本）：
   * 写 tmp + 回读校验 → 覆盖式 rename → 失败则原文件改名 backup → tmp 改名正式文件 →
   * 成功删 backup；任一步失败都恢复 backup 并保留 tmp / backup 现场，抛类型化错误。
   */
  private atomicWriteIn(dir: string, fileName: string, text: string): void {
    this.ensureDirSync(dir);
    this.recoverOnce(dir);
    const path: string = `${dir}/${fileName}`;
    const suffix: string = this.uniqueSuffix();
    const tmpPath: string = `${path}${TMP_INFIX}${suffix}`;
    const backupPath: string = `${path}${BAK_INFIX}${suffix}`;

    // ① 写临时文件并回读校验（长度 + 内容）；校验失败保留现场，绝不继续覆盖正式文件
    this.writeTextSync(tmpPath, text);
    this.verifyTmp(tmpPath, text);

    // ② 首选：同目录覆盖式 rename（原子，中间没有「正式文件不存在」窗口）
    try {
      fs.renameSync(tmpPath, path);
      return;
    } catch (error) {
      const reason: string = this.errorText(error);
      let hadOriginal: boolean = false;
      // ③ 回落：先把原文件改名为 backup（**绝不 unlink 原文件**），再让 tmp 顶上
      if (this.fileExists(path)) {
        hadOriginal = true;
        try {
          fs.renameSync(path, backupPath);
        } catch (backupError) {
          throw this.writeError(path,
            `覆盖式改名失败（${reason}），备份原文件失败（${this.errorText(backupError)}）；原文件与临时文件均保留于 ${tmpPath}`);
        }
      }
      try {
        fs.renameSync(tmpPath, path);
      } catch (fallbackError) {
        if (hadOriginal) {
          try {
            fs.renameSync(backupPath, path);
          } catch (restoreError) {
            throw this.writeError(path,
              `覆盖式改名失败（${reason}），回落失败（${this.errorText(fallbackError)}），备份恢复也失败（${this.errorText(restoreError)}）；请从 ${backupPath} 手工恢复`);
          }
        }
        throw this.writeError(path,
          `覆盖式改名失败（${reason}），回落失败（${this.errorText(fallbackError)}）；原文件已恢复，临时文件保留于 ${tmpPath}`);
      }
      // ④ 新文件已就位，才删除备份（唯一一次 unlink，删的是 backup 而非正式文件）
      if (hadOriginal) {
        this.cleanupTemp(backupPath);
      }
    }
  }

  /** 回读临时文件并逐字节（长度 + 内容）校验；失败时保留现场，抛类型化错误。 */
  private verifyTmp(tmpPath: string, text: string): void {
    let actual: string;
    try {
      actual = fs.readTextSync(tmpPath);
    } catch (error) {
      throw this.writeError(tmpPath, `临时文件回读失败（${this.errorText(error)}），现场保留待检查`);
    }
    if (actual.length !== text.length || actual !== text) {
      throw this.writeError(tmpPath, '临时文件字节与待写内容不一致，现场保留待检查');
    }
  }

  /** 侧文件唯一后缀：实例标签 + 时间戳 + 单调序号（仅命名用，不读墙钟做数据）。 */
  private uniqueSuffix(): string {
    this.writeSeq += 1;
    return `${this.instanceTag}-${Date.now()}-${this.writeSeq}`;
  }

  /** 类型化原子错误：统一 E_ATOMIC_WRITE 前缀，便于调用方识别与上报。 */
  private writeError(path: string, detail: string): Error {
    return new Error(`E_ATOMIC_WRITE: 原子写入失败（${path}）：${detail}`);
  }

  private writeTextSync(path: string, text: string): void {
    let file: fs.File | null = null;
    try {
      file = fs.openSync(path, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
      fs.writeSync(file.fd, text);
    } catch (error) {
      throw new Error(`写入 v2 文件失败（${path}）：${this.errorText(error)}`);
    } finally {
      if (file !== null) {
        fs.closeSync(file);
      }
    }
  }

  /** 只删侧文件（tmp / backup），绝不用于正式文件。 */
  private cleanupTemp(tmpPath: string): void {
    try {
      if (this.fileExists(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch {
      // 清理失败不阻塞主流程；残留侧文件由下次启动 recoverTemps 处理
    }
  }

  /** 每个日目录首次写前做一次启动恢复（best-effort，失败不阻塞写入）。 */
  private recoverOnce(dir: string): void {
    if (this.recoveredDirs.indexOf(dir) >= 0) {
      return;
    }
    this.recoveredDirs.push(dir);
    const slash: number = dir.lastIndexOf('/');
    const date: string = slash >= 0 ? dir.slice(slash + 1) : dir;
    this.recoverTemps(date);
  }

  /**
   * 启动恢复（§7 安全序列配套）：
   * - 目标缺失：把 `*.tmp-*` / `*.bak-*` 改名顶回正式文件并**报告**（不静默丢数据）；
   * - 目标存在且 tmp 内容相同：陈旧副本，删除；内容不同则两边都保留供人工检查；
   * - 目标存在但留下 `*.bak-*`：正式文件已就位，报告并保留备份，绝不静默删除。
   */
  private recoverTemps(date: string): void {
    const dir: string = this.dayDir(date);
    let names: string[] = [];
    try {
      if (!this.fileExists(dir)) {
        return;
      }
      names = fs.listFileSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const isTmp: boolean = name.includes(TMP_INFIX);
      const isBak: boolean = name.includes(BAK_INFIX);
      if (!isTmp && !isBak) {
        continue;
      }
      const marker: string = isTmp ? TMP_INFIX : BAK_INFIX;
      const cut: number = name.indexOf(marker);
      const targetName: string = name.slice(0, cut);
      if (targetName.length === 0) {
        continue;
      }
      const targetPath: string = `${dir}/${targetName}`;
      const sidePath: string = `${dir}/${name}`;
      try {
        if (!this.fileExists(targetPath)) {
          fs.renameSync(sidePath, targetPath);
          console.warn(`[timeline v2] 启动恢复：目标缺失，已从 ${name} 还原 ${targetName}（${date}）`);
          continue;
        }
        if (isTmp) {
          const current: string = fs.readTextSync(targetPath);
          const staged: string = fs.readTextSync(sidePath);
          if (current === staged) {
            fs.unlinkSync(sidePath);
          }
        } else {
          console.warn(`[timeline v2] 启动恢复：正式文件已存在，保留备份 ${name} 供检查（${date}）`);
        }
      } catch {
        // 单个文件处理失败不影响其它文件（下次启动再试）
      }
    }
  }

  private ensureDirSync(dir: string): void {
    if (this.fileExists(dir)) {
      return;
    }
    try {
      fs.mkdirSync(dir, true);
    } catch (error) {
      if (!this.fileExists(dir)) {
        throw new Error(`创建 v2 时间线目录失败（${dir}）：${this.errorText(error)}`);
      }
    }
  }

  private readText(path: string): string {
    if (!this.fileExists(path)) {
      return '';
    }
    try {
      return fs.readTextSync(path);
    } catch (error) {
      throw new Error(`读取 v2 文件失败（${path}）：${this.errorText(error)}`);
    }
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

/** 全局单例：与只读服务共用同一份门槛与目录状态。 */
export const timelineWriteStore: TimelineWriteStore = new TimelineWriteStore();
