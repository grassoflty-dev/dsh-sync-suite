/**
 * 每日 AI 汇总的服务适配层（mod-v2-only：v2 是唯一读写路径）。
 *
 * - 写：`generate()` 第一句断言迁移态，未迁移在任何 IO（含 AI 请求 / 文件读写）之前抛
 *   `E_NOT_MIGRATED`，绝不回落 v1；已迁移时把 AI 结果交给
 *   `timelineWriteStore.appendSummary(date, text)` 原子落盘到 `timeline/<date>/summary.json`
 *   （契约 docs/DATA-CONTRACT-v2.md §8），newer-wins 由纯函数 isNewerSummaryText 判定，
 *   坏候选 / 更旧 / 相等都不覆盖现有字节；
 * - 读：`read()` 只走 `timelineStore.readSummaryText(date)` 的 v2 字节再过 parseSummary，
 *   未迁移时该读口自然返回空串 → null，**绝不触碰 devices/****；
 * - 本类不持有 fs、不拼设备目录路径、不自建 IO 端口：唯一落盘口是 timelineWriteStore，
 *   唯一读口是 timelineStore。这样「v2 成为唯一读写路径」在汇总链路也成立。
 */
import {
  buildSummaryPayload, parseSummary, serializeSummary, summaryFromReply
} from '../model/dailySummary';
import type { DailySummary, SummaryMeta, SummaryRequestInput } from '../model/dailySummary';
import type { ScheduleRecord } from '../model/types';
import { nowIso } from '../common/date';
import { NOT_MIGRATED_REASON } from '../model/migrationState';
import { deviceTimeZone, summarize } from './deepseek';
import { scheduleStore } from './scheduleStore';
import { timelineStore } from './timelineStore';
import { timelineWriteStore } from './timelineWriteStore';

export class SummaryStore {
  private ready: boolean = false;

  /**
   * 初始化（幂等）：v2 只读 / 写入服务各自幂等初始化。
   * 这里顺带把 timelineWriteStore 拉起来（此前无人调用），保证 generate() 的落盘口可用；
   * 本类不再自建任何 IO 端口。
   */
  async ensureReady(context: object): Promise<void> {
    if (this.ready) {
      return;
    }
    await scheduleStore.ensureReady(context);
    await timelineStore.ensureReady(context);
    await timelineWriteStore.ensureReady(context);
    this.ready = true;
  }

  isReady(): boolean {
    return this.ready && timelineStore.isReady();
  }

  /** 读某天的 v2 汇总；没有 / 损坏 / 未迁移都返回 null（不抛，页面据此显示「还没有汇总」）。 */
  read(date: string): DailySummary | null {
    if (!timelineStore.isMigrated()) {
      return null;
    }
    return parseSummary(timelineStore.readSummaryText(date)).summary;
  }

  /**
   * 生成并落盘某天的 v2 汇总。
   *
   * 顺序固定：
   * ① 未迁移拒绝（零 IO，含不调 AI）→ ② 先 AI（失败即抛，不碰文件，旧汇总保持原样）→
   * ③ 解析回复 → ④ 序列化合法候选文本 → ⑤ timelineWriteStore.appendSummary 原子落盘
   * （generatedAt 较新者胜、相等 / 更旧 / 坏候选保留现有字节）→
   * ⑥ 回读**实际生效**的汇总再返回：同日若已有更新汇总，返回的不是本次候选，
   *    避免界面展示一个没有落盘（或已被判定为陈旧）的结果。
   */
  async generate(
    records: ScheduleRecord[],
    date: string,
    apiKey: string,
    providerId: string,
    model: string,
    baseURL: string
  ): Promise<DailySummary> {
    // ① 未迁移：在任何 IO 之前抛类型化拒绝（与首页横幅同源），零写入、无 v1 回落。
    if (!timelineStore.isMigrated()) {
      throw new Error(NOT_MIGRATED_REASON);
    }
    if (!this.isReady()) {
      throw new Error('汇总存储尚未初始化：请先调用 summaryStore.ensureReady(context)');
    }
    // ② 先 AI：失败直接抛，一个字节都不写，上一次成功汇总保持原样。
    const input: SummaryRequestInput = buildSummaryPayload(records, date, deviceTimeZone());
    if (input.recordCount === 0) {
      throw new Error('当天还没有记录，先写一条再生成汇总');
    }
    const reply: string = await summarize(input.payload, apiKey, nowIso(), input.timeZone, model, providerId, baseURL);
    // ③ 解析回复：无标题等非法内容由 summaryFromReply 抛错，不落盘。
    const meta: SummaryMeta = {
      date: date,
      generatedAt: Date.now(),
      model: model,
      provider: providerId,
      recordCount: input.recordCount,
      doneCount: input.doneCount
    };
    const draft: DailySummary = summaryFromReply(reply, meta);
    // ④ 序列化候选：合法字节由纯模型保证；appendSummary 内部按 generatedAt 判 newer-wins。
    const text: string = serializeSummary(draft);
    // ⑤ 唯一落盘口：timeline/<date>/summary.json 原子替换；未迁移 / 未就绪由 write store 再守一次。
    timelineWriteStore.appendSummary(date, text);
    // ⑥ 回读实际生效的汇总（可能被同日更新的汇总胜出），界面展示的就是仓库里的真值。
    const effective: DailySummary | null = parseSummary(timelineStore.readSummaryText(date)).summary;
    return effective !== null ? effective : draft;
  }
}

/** 全局单例（与 v2 只读 / 写入服务共用同一份迁移门槛与目录状态）。 */
export const summaryStore: SummaryStore = new SummaryStore();
