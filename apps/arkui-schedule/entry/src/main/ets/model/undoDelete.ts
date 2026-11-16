/**
 * 「删除 + 5 秒撤销」纯逻辑（零 SDK / 零服务层依赖，Node 下可直接跑单测）。
 *
 * ## 软删除方案（复用 JSONL 追加语义，不做物理删除）
 * 契约：`docs/DATA-CONTRACT.md` §3 —— 一行一个 JSON 对象，**只追加，绝不重写历史行**。
 * - **删除 = 追加一条同 `id`、`ts` 更新的 `deleted:true` 版本**（墓碑）；历史行一个字节都不改；
 * - `foldById` 取同 id 里 `ts` 最晚的一条 → 最新版本就是墓碑；读取侧用
 *   `isDeletedRecord()` / `withoutDeleted()` 过滤，`deleted` 作为**扩展字段**由
 *   `model/jsonl` 原样透传（`normalizeRecord` 保留未知字段，校验也不拦它）；
 * - **撤销 = 再追加一条 `deleted:false` 的版本**（`ts` 继续变大），记录重新可见。
 *
 * ## 跨设备同步一致性
 * 删除与撤销都是**普通追加事件**，落在 `devices/<deviceId>/schedules/YYYY-MM-DD.jsonl` 里，
 * 随 git 同步。任何设备拉取后 `parseJsonl` + `foldById` 得到同一个「最新版本」，
 * 因此「删/恢复」的结论在所有设备上一致，**不需要**额外的墓碑文件、也不需要内存里的延迟删除：
 * - 设备 A 删除 → 推送 → 设备 B 拉取后该记录同样消失；
 * - 设备 A 在 5 秒内撤销（追加 `deleted:false`）→ 推送 → 设备 B 拉取后记录回来；
 * - 两台设备同时操作同一 id 时，仍然由既有的「同 id 取 ts 较晚者」规则裁决，不会产生双份记录。
 *
 * ## 5 秒窗口的语义（`UndoDelete`）
 * 窗口只是**界面上的撤销机会**：墓碑在 `schedule()` 那一刻就已经落盘，所以
 * - 应用被杀/崩溃也不会把「已确认要删的记录」留在库里（删除不丢）；
 * - 超时 `confirm()` = 关掉撤销机会，**不产生任何新写入**；
 * - `cancel()` = 追加 `deleted:false` 版本（撤销）。
 *
 * 兼容性：老版本 App 不认识 `deleted` 字段，会把墓碑当成普通记录显示，
 * 因此上线后两端应一起升级（字段本身向后兼容：老版本不会报错、不会丢行）。
 */
import type { ScheduleRecord } from './types';
import { cloneRecord } from './types';

/** 默认撤销窗口（毫秒）。 */
export const UNDO_TTL_MS: number = 5000;

/** 一条待撤销的删除。 */
export interface PendingDelete {
  /** 被删记录 id。 */
  recordId: string;
  /** 撤销窗口截止时刻（epoch ms）。 */
  dueAt: number;
  /** 本次窗口长度（毫秒）。 */
  ttlMs: number;
}

/** `schedule()` 的结果。 */
export interface DeleteScheduleResult {
  /** true = 新建了待撤销项；false = 被忽略（空 id，或同 id 重复登记）。 */
  created: boolean;
  /** 被本次顶替掉的上一个待撤销 id（空串 = 没有）。 */
  replacedRecordId: string;
}

/**
 * 带软删除标记的记录。
 *
 * `deleted` 不在 `ScheduleRecord` 的必填字段里（历史数据没有它），
 * 但 `model/jsonl` 会把它当成未知扩展字段**原样透传**，所以读写都走这个子类型。
 */
export interface DeletableRecord extends ScheduleRecord {
  /** true = 已删除（墓碑版本）。缺省/false = 正常可见。 */
  deleted?: boolean;
}

/** 读墓碑标记（缺失 / 非 true 一律视为可见）。 */
export function isDeletedRecord(record: ScheduleRecord | null): boolean {
  if (record === null) {
    return false;
  }
  const flags = record as DeletableRecord;
  return flags.deleted === true;
}

/**
 * 过滤墓碑（返回新数组，保持原顺序）。
 *
 * 读取侧（列表 / 详情 / 未完成索引）统一走它，避免「删除只对首页生效」。
 */
export function withoutDeleted(records: ScheduleRecord[]): ScheduleRecord[] {
  const visible: ScheduleRecord[] = [];
  for (const record of records) {
    if (!isDeletedRecord(record)) {
      visible.push(record);
    }
  }
  return visible;
}

/**
 * 生成「带 deleted 标记」的新版本记录（纯函数，不改入参、不改历史行）。
 *
 * `ts` 由调用方给（通常是 `nextTsSameDate(旧记录.ts)`）：必须**严格大于**旧记录的 ts，
 * 否则 `foldById` 折叠时可能仍取到旧版本。`ts` 为空/非字符串时退化为原 ts（调用方的错，但不会写坏数据）。
 */
function withDeletedFlag(record: ScheduleRecord, deleted: boolean, ts: string): ScheduleRecord {
  const copy: ScheduleRecord = cloneRecord(record);
  // cloneRecord 只复制已知字段，因此这里拿到的对象一定没有 deleted，下面统一显式写 true/false
  const nextVersion = copy as DeletableRecord;
  if (typeof ts === 'string' && ts.length > 0) {
    nextVersion.ts = ts;
  }
  nextVersion.deleted = deleted;
  return nextVersion;
}

/** 墓碑版本：`deleted:true`（删除）。调用方负责传入严格更大的 `ts`。 */
export function softDeleteRecord(record: ScheduleRecord, ts: string): ScheduleRecord {
  return withDeletedFlag(record, true, ts);
}

/** 恢复版本：`deleted:false`（撤销删除）。调用方负责传入严格更大的 `ts`。 */
export function restoreRecord(record: ScheduleRecord, ts: string): ScheduleRecord {
  return withDeletedFlag(record, false, ts);
}

/**
 * 「删除 → 5 秒撤销」状态机（纯内存、可注入时钟，便于单测）。
 *
 * 只维护**一个**待撤销项（界面上同时只有一条倒计时条）；登记新的删除会顶替旧的，
 * 被顶替的那条视为「已确认」（墓碑早已落盘，`confirm()` 不需要补写）。
 */
export class UndoDelete {
  private pending: PendingDelete | null = null;

  /** 当前待撤销的记录 id；空串 = 没有。 */
  pendingId(): string {
    return this.pending === null ? '' : this.pending.recordId;
  }

  /**
   * 登记一次删除。
   *
   * - 空 id 直接忽略（`created:false`）；
   * - **幂等**：同一个 id 重复登记不刷新截止时刻（否则每点一次删除就续命 5s）；
   * - 顶替：已有别的待撤销项时，返回 `replacedRecordId`，由调用方按「已确认」处理；
   * - `ttlMs` 非正/非法 → 回落 `UNDO_TTL_MS`；`now` 非法 → 回落 `Date.now()`。
   */
  schedule(recordId: string, ttlMs: number = UNDO_TTL_MS, now: number = Date.now()): DeleteScheduleResult {
    const ignored: DeleteScheduleResult = { created: false, replacedRecordId: '' };
    const id = typeof recordId === 'string' ? recordId.trim() : '';
    if (id.length === 0) {
      return ignored;
    }
    const replaced = this.pendingId();
    if (replaced === id) {
      return ignored;
    }
    const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? Math.floor(ttlMs) : UNDO_TTL_MS;
    const at = Number.isFinite(now) ? now : Date.now();
    this.pending = { recordId: id, dueAt: at + ttl, ttlMs: ttl };
    return { created: true, replacedRecordId: replaced };
  }

  /** 是否有待撤销项；给了 `recordId` 时判断「是不是这一条」。 */
  isPending(recordId: string = ''): boolean {
    if (this.pending === null) {
      return false;
    }
    if (recordId.length === 0) {
      return true;
    }
    return this.pending.recordId === recordId.trim();
  }

  /** 剩余毫秒：没有待撤销项 / 已超时都返回 0（**不返回负数**）。 */
  remainingMs(now: number = Date.now()): number {
    if (this.pending === null) {
      return 0;
    }
    const at = Number.isFinite(now) ? now : Date.now();
    const left = this.pending.dueAt - at;
    return left > 0 ? left : 0;
  }

  /** 剩余秒数（向上取整，界面「撤销（5s）」用；超时为 0）。 */
  remainingSeconds(now: number = Date.now()): number {
    return Math.ceil(this.remainingMs(now) / 1000);
  }

  /** 是否已到/超过截止时刻（没有待撤销项时为 false）。 */
  isExpired(now: number = Date.now()): boolean {
    if (this.pending === null) {
      return false;
    }
    const at = Number.isFinite(now) ? now : Date.now();
    return at >= this.pending.dueAt;
  }

  /** 本次窗口总时长（毫秒；没有待撤销项为 0）。 */
  ttlMs(): number {
    return this.pending === null ? 0 : this.pending.ttlMs;
  }

  /** 截止时刻（epoch ms；没有待撤销项为 0）。 */
  dueAtMs(): number {
    return this.pending === null ? 0 : this.pending.dueAt;
  }

  /** 提交（超时/被顶替/离开页面）：清空并返回被提交的 id（空串 = 没有待撤销项）。 */
  confirm(): string {
    const id = this.pendingId();
    this.pending = null;
    return id;
  }

  /** 撤销：清空并返回被撤销的 id（空串 = 没有）。是否已超时由调用方用 `isExpired()` 判断。 */
  cancel(): string {
    const id = this.pendingId();
    this.pending = null;
    return id;
  }

  /** 清空（页面销毁 / 测试重置）。 */
  reset(): void {
    this.pending = null;
  }
}
