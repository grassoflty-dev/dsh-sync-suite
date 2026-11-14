/**
 * 提醒计划构建（纯逻辑）。
 *
 * 契约：`docs/CONTRACT.md` §3.2 —— `buildReminderPlan` 只取「未来的、未完成的」记录，
 * 单应用最多 30 条（`reminderAgentManager` 日历提醒的硬上限），按时间升序。
 */
import type { ScheduleRecord } from './types';

/** 单应用日历提醒上限（HarmonyOS `reminderAgentManager` 限制）。 */
export const MAX_REMINDER_COUNT = 30;

/** 一条待下发的提醒。 */
export interface ReminderPlanItem {
  id: string;
  title: string;
  /** ISO 8601 时间（取记录的 ts，保留记录者时区）。 */
  dateTime: string;
}

function parseMillis(iso: string): number {
  const value = Date.parse(iso);
  return Number.isNaN(value) ? Number.NaN : value;
}

/**
 * 生成提醒计划：
 * - 跳过已完成（`done === true`）与 ts 无法解析的记录；
 * - 只保留 ts 晚于 `nowIso` 的记录（等于当前时刻也不提醒）；
 * - 同一 id 只保留最早的一次（防止折叠前重复行重复建提醒）；
 * - 按时间升序，最多 `maxCount` 条，且永不突破 30 条上限。
 */
export function buildReminderPlan(
  records: ScheduleRecord[],
  nowIso: string,
  maxCount: number = MAX_REMINDER_COUNT
): ReminderPlanItem[] {
  const now = parseMillis(nowIso);
  if (Number.isNaN(now)) {
    throw new Error(`nowIso 不合法：${String(nowIso)}`);
  }
  const requested = Number.isFinite(maxCount) ? Math.floor(maxCount) : MAX_REMINDER_COUNT;
  const limit = Math.min(Math.max(0, requested), MAX_REMINDER_COUNT);
  if (limit === 0) {
    return [];
  }

  const picked: Array<{ item: ReminderPlanItem; millis: number }> = [];
  const seen = new Set<string>();
  for (const record of records) {
    if (record.done === true) {
      continue;
    }
    if (seen.has(record.id)) {
      continue;
    }
    const millis = parseMillis(record.ts);
    if (Number.isNaN(millis) || millis <= now) {
      continue;
    }
    const title = typeof record.title === 'string' && record.title.trim().length > 0
      ? record.title.trim()
      : '(未命名日程)';
    picked.push({ item: { id: record.id, title, dateTime: record.ts }, millis });
    seen.add(record.id);
  }

  picked.sort((left, right) => left.millis - right.millis);
  return picked.slice(0, limit).map((entry) => entry.item);
}
