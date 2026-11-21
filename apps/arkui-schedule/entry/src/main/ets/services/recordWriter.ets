/**
 * 写入统一门面（mod-drop-v1）：所有日程写调用点都走这里，v2 是唯一写入路径。
 *
 * 规则：
 * - 空仓库不是错误：没有 `timeline/schema.json` 也照常写，`timelineWriteStore` 在首用时
 *   建仓库骨架与当日 `records.json`。**没有**任何 E_NOT_MIGRATED 拒绝或迁移动作；
 * - 一律走 `timelineWriteStore`：
 *   - writeRecord → append(upsert)；
 *   - deleteRecord → scheduleDelete（§7 删除账本，不写墓碑版本）；
 *   - restoreRecord → restore（§7 撤销账本，ts 严格晚于删除）。
 * - **绝不调用 `scheduleStore.appendRecord`**：v1 写入路径已彻底移除。
 *
 * **失败语义（绝不 fork 两 store，P1-1）**：
 * 1. 先用 `writeV2()` 把意图**停放落盘**（durable），再做 v2 写尝试；
 * 2. 写成功 → 出队该意图（幂等）→ 触发同步；
 * 3. 写失败 → 意图**留在 outbox**（并记 typed 原因）→ **仍触发一次同步**，
 *    使停放意图的日期进入周期 days（服务层把 outbox.date 并入 days）→ 抛 `E_V2_WRITE_PARKED`。
 * 这样「新日期首次写盘就失败」的意图不会永久滞留，§9「无静默本地未推提交」成立。
 * 停放本身失败也照样抛类型化错误并如实说明；**绝不回落到 v1 写**（避免双存储分叉）。
 *
 * 硬约束：本文件不写 AppStorage；旧 `devices/**` 与 `open.jsonl` 一律忽略（不读、不写、不删）；不引入新依赖。
 */
import { timelineWriteStore } from './timelineWriteStore';
import { outboxStore } from './outboxStore';
import { makeIntentId } from '../model/syncProtocol';
import { ledgerDeleteLine, ledgerRestoreLine } from '../model/timelineWrite';
import type { OutboxEntry } from '../model/syncProtocol';
import type { ScheduleRecord } from '../model/types';
import { syncProtocolStore } from './syncProtocolStore';
import type { CycleResult } from './syncProtocolStore';
import { bindBridgeRunner } from './gitRunner';
import { syncStatusStore } from './syncStatusStore';
import { common } from '@kit.AbilityKit';

/** 本模块会停放的三种意图（outbox 的 purge 由同步协议自身产生，这里不生成）。 */
type ParkOp = 'upsert' | 'delete' | 'restore';

/** v2 写的一次尝试（由三个公开入口以闭包注入，便于统一顺序）。 */
type V2Apply = () => void;

/** 日期归属键 = ts 前 10 位；畸形 ts 得到空串，随后由写侧 E_TS_SHAPE 门禁拦下并停放。 */
function dateOf(ts: string): string {
  return typeof ts === 'string' && ts.length >= 10 ? ts.slice(0, 10) : '';
}

export class RecordWriter {
  /** 保存 / 勾选完成 / 编辑 / AI 更新：唯一 v2 upsert 路径。 */
  writeRecord(record: ScheduleRecord): void {
    this.writeV2('upsert', record, (): void => {
      timelineWriteStore.append(record, dateOf(record.ts));
    });
  }

  /** 删除：写删除账本（记录行保留到确认清行），绝不写 v1 墓碑版本。 */
  deleteRecord(record: ScheduleRecord): void {
    this.writeV2('delete', record, (): void => {
      timelineWriteStore.scheduleDelete(record.id, dateOf(record.ts), record.ts);
    });
  }

  /** 撤销删除：写撤销账本（ts 严格晚于删除），绝不写 v1 恢复版本。 */
  restoreRecord(record: ScheduleRecord): void {
    this.writeV2('restore', record, (): void => {
      timelineWriteStore.restore(record.id, dateOf(record.ts), record.ts);
    });
  }

  /**
   * v2 写的统一编排（P1-1）：**先停放、后写、成败都触发一次周期**。
   *
   * 空仓库照常写：骨架创建由 write store 完成，这里不再有任何「未迁移」前置拒绝。
   * 停放发生在写尝试之前，因此进程在写盘中/写盘后崩溃都仍有 outbox 真值；
   * 写失败留停放并记 typed 原因；写成功出队。两条路径都 `triggerSync()`：
   * 失败路径也触发是为了让新日期进入周期 days、把停放意图真正重放掉。
   */
  private writeV2(op: ParkOp, record: ScheduleRecord, apply: V2Apply): void {
    const entry: OutboxEntry = this.buildIntent(op, record);
    let parkNote: string = '已存入待同步队列';
    try {
      // durable first：意图在任何 v2 写句柄打开之前就已落盘（仓库之外）。
      outboxStore.enqueue(entry);
    } catch (parkError) {
      parkNote = `待同步队列写入失败（${this.errorText(parkError)}），请检查本机存储`;
    }
    try {
      apply();
    } catch (error) {
      const reason: string = this.errorText(error);
      // 停放成功则把 typed 原因写回该意图（供三态行 / 重试入口显示），失败也不二次吞错。
      try {
        outboxStore.updateLastError(entry.intentId, `E_V2_WRITE_PARKED: ${reason}`);
      } catch (parkError) {
        void parkError; // enqueue 失败已由 parkNote 如实告知，此处不再叠加提示
      }
      // 关键：失败仍触发同步 —— 服务层把 outbox 的 date 并入 days，
      // 这条「只有停放意图才存在的新日期」才会被周期取到并重放。
      this.triggerSync();
      throw new Error(`E_V2_WRITE_PARKED: v2 写入失败（${reason}），${parkNote}`);
    }
    // 写成功：出队停放意图（若 enqueue 失败则 remove 是 no-op），随后照常 fire-and-forget 同步。
    outboxStore.remove(entry.intentId);
    this.triggerSync();
  }

  /**
   * 写成功后的 fire-and-forget 同步（F1 关闭）：typed 结果统一交给 syncStatusStore 驱动三态，
   * 失败如实显示原因；没有 runner / 未启用时周期返回 null，只跳过不伪造「已同步」。
   */
  private triggerSync(): void {
    // 建记录后的 fire-and-forget 也走同一条确定性绑定：不依赖「EntryAbility.onCreate 一定先跑过」
    // 或「页面 bootstrap 已完成」这种时序假设；即使两者都缺席，runner 也在此一次到位。
    bindBridgeRunner(getContext() as common.UIAbilityContext);
    // 三态行先切「同步中…」，周期返回后再由 fromCycle 落到「已同步 · HH:MM」或 typed 失败。
    syncStatusStore.setSyncing();
    syncProtocolStore.runConfiguredCycle()
      .then((result: CycleResult | null): void => {
        if (result !== null) {
          syncStatusStore.fromCycle(result, new Date());
        }
      })
      .catch((error: Error): void => {
        syncStatusStore.setPending(0, this.errorText(error));
      });
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
   * 纯构造：intentId / date / ts 全部在入队时固定（契约 §9「payload 入队不可变、
   * 重放不重新生成」），lastError 初始为空，写失败再由 updateLastError 回填。
   */
  private buildIntent(op: ParkOp, record: ScheduleRecord): OutboxEntry {
    const date: string = dateOf(record.ts);
    return {
      intentId: makeIntentId(date, record.id, record.ts, op),
      op: op,
      date: date,
      id: record.id,
      ts: record.ts,
      line: this.lineFor(op, record),
      enqueuedAt: record.ts,
      attempts: 0,
      state: 'pending',
      lastError: ''
    };
  }

  private errorText(error: object): string {
    return error instanceof Error ? error.message : String(error);
  }
}

/** 全局单例：页面 / 组件共用同一份分流与停放语义。 */
export const recordWriter: RecordWriter = new RecordWriter();
