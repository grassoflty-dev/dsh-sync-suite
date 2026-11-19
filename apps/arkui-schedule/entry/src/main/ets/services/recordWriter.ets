/**
 * 写入统一门面（mod-v2-dual-write-off）：所有 v1 日程写调用点都改走这里。
 *
 * 分流规则（唯一判定源 `timelineStore.useV2()`，即「仓库确为 v2 且开关已翻 v2」）：
 * - `!useV2()`：**仅此路径**调用 `scheduleStore.appendRecord`（翻转前的 v1 路径，保持原行为）；
 * - `useV2()`：走 `timelineWriteStore`：
 *   - writeRecord → append(upsert)；
 *   - deleteRecord → scheduleDelete（§7 删除账本，不写墓碑版本）；
 *   - restoreRecord → restore（§7 撤销账本，ts 严格晚于删除）。
 *
 * **失败语义（绝不 fork 两 store）**：v2 分支一旦抛错，先按 `makeIntentId` 构造意图并
 * `outboxStore.enqueue` 停放，再抛 `E_V2_WRITE_PARKED: …` 类型化错误由调用点 toast 显示；
 * **绝不回落到 v1 写**（那会让 v1 / v2 两份数据分叉）。停放失败也照样抛类型化错误并如实说明。
 *
 * 硬约束：本文件不写 AppStorage、不写 `devices/**`、不迁移数据、不引入新依赖。
 */
import { scheduleStore } from './scheduleStore';
import { timelineStore } from './timelineStore';
import { timelineWriteStore } from './timelineWriteStore';
import { outboxStore } from './outboxStore';
import { makeIntentId } from '../model/syncProtocol';
import { ledgerDeleteLine, ledgerRestoreLine } from '../model/timelineWrite';
import type { OutboxEntry } from '../model/syncProtocol';
import type { ScheduleRecord } from '../model/types';

/** 本模块会停放的三种意图（outbox 的 purge 由同步协议自身产生，这里不生成）。 */
type ParkOp = 'upsert' | 'delete' | 'restore';

/** 日期归属键 = ts 前 10 位；畸形 ts 得到空串，随后由写侧 E_TS_SHAPE 门禁拦下并停放。 */
function dateOf(ts: string): string {
  return typeof ts === 'string' && ts.length >= 10 ? ts.slice(0, 10) : '';
}

export class RecordWriter {
  /** 唯一判定源：两个 store 共用的 useV2()（仓库是 v2 且读模式已翻 v2）。 */
  useV2(): boolean {
    return timelineStore.useV2();
  }

  /** 保存 / 勾选完成 / 编辑 / AI 更新：v2 upsert，否则 v1 追加。 */
  writeRecord(record: ScheduleRecord): void {
    if (this.useV2()) {
      try {
        timelineWriteStore.append(record, dateOf(record.ts));
      } catch (error) {
        // 停放 + 类型化抛出；此分支内没有任何 v1 写。
        this.parkAndThrow('upsert', record, error);
      }
      return;
    }
    // 翻转前的 v1 路径：保持调用点原语义，原样追加一条版本行。
    scheduleStore.appendRecord(record);
  }

  /** 删除：v2 写删除账本（记录行保留到确认清行），否则 v1 追加已构造好的墓碑版本。 */
  deleteRecord(record: ScheduleRecord): void {
    if (this.useV2()) {
      try {
        timelineWriteStore.scheduleDelete(record.id, dateOf(record.ts), record.ts);
      } catch (error) {
        this.parkAndThrow('delete', record, error);
      }
      return;
    }
    // 翻转前的 v1 路径：调用点已用 softDeleteRecord() 构造墓碑，原样追加。
    scheduleStore.appendRecord(record);
  }

  /** 撤销删除：v2 写撤销账本，否则 v1 追加已构造好的恢复版本。 */
  restoreRecord(record: ScheduleRecord): void {
    if (this.useV2()) {
      try {
        timelineWriteStore.restore(record.id, dateOf(record.ts), record.ts);
      } catch (error) {
        this.parkAndThrow('restore', record, error);
      }
      return;
    }
    // 翻转前的 v1 路径：调用点已用 restoreRecord() 构造恢复版本，原样追加。
    scheduleStore.appendRecord(record);
  }

  // ------------------------------------------------------------------ 失败停放

  /** 构造停放意图的 payload：upsert 放整条记录（重放时 JSON.parse），删/撤放账本行。 */
  private lineFor(op: ParkOp, record: ScheduleRecord): string {
    if (op === 'delete') {
      return ledgerDeleteLine(record.id, record.ts, record.ts);
    }
    if (op === 'restore') {
      return ledgerRestoreLine(record.id, record.ts, record.ts);
    }
    return JSON.stringify(record);
  }

  /**
   * 先停放、后抛出：never 返回，调用点不会继续走任何"成功"分支，也不会回落到 v1。
   * enqueuedAt 直接用入队时固定的 ts（与契约 §9「payload 入队不可变、重放不重新生成」一致）。
   */
  private parkAndThrow(op: ParkOp, record: ScheduleRecord, error: object): never {
    const reason: string = this.errorText(error);
    const date: string = dateOf(record.ts);
    const entry: OutboxEntry = {
      intentId: makeIntentId(date, record.id, record.ts, op),
      op: op,
      date: date,
      id: record.id,
      ts: record.ts,
      line: this.lineFor(op, record),
      enqueuedAt: record.ts,
      attempts: 0,
      state: 'pending',
      lastError: reason
    };
    let parkNote: string = '已存入待同步队列';
    try {
      outboxStore.enqueue(entry);
    } catch (parkError) {
      // 停放本身失败也绝不静默、绝不 v1 回落；如实告知用户停放未成功。
      parkNote = `待同步队列写入失败（${this.errorText(parkError)}），请检查本机存储`;
    }
    throw new Error(`E_V2_WRITE_PARKED: v2 写入失败（${reason}），${parkNote}`);
  }

  private errorText(error: object): string {
    return error instanceof Error ? error.message : String(error);
  }
}

/** 全局单例：页面 / 组件共用同一份分流与停放语义。 */
export const recordWriter: RecordWriter = new RecordWriter();
