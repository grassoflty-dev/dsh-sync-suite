/**
 * 改日期时的 `ts` 决策（纯 TypeScript，零 SDK / 零服务层依赖；Node 下可直接单测）。
 *
 * ## 为什么"往更早的日期改"不能就地写
 * JSONL 的 `ts` 同时承担两个职责（契约：`docs/DATA-CONTRACT.md` §3）：
 * 1. **分片键**：`recordDateKey(ts)` 取日期前缀，决定记录写进 `devices/<id>/schedules/<date>.jsonl`；
 * 2. **折叠版本**：`foldById` / `openIndex` 对同一 `id` 只保留 `ts` 较晚的那条（"同 id 取较晚 ts"）。
 *
 * 因此把记录往更早的日期改在本数据模型里**无法表达**：目标日的 ts 必然早于旧版本，
 * `foldById` 仍会选中旧版本，用户这次编辑会被静默丢弃（旧版本还会反过来盖掉新写入）。
 * 本模块遇到往早改直接 `ok:false` 拒绝，绝不写出注定丢失的数据；补记过去日期只能新建一条。
 *
 * ## 往更晚的日期怎么表达
 * 目标日严格晚于原日期时，"改日期" = 两个追加事件：
 * - (a) 目标日一片新的**存活版本**：`ts = tsForDate(targetDate, now)`（日期是目标日，时钟与本地偏移沿用 now）；
 * - (b) 原日片一条 `deleted:true` 墓碑：`ts = nextTsSameDate(originalTs, now)`（仍归属原日期且严格变大），
 *   这样旧分片不会留下"幽灵副本"。墓碑实体由 `model/undoDelete.ts` 的 `softDeleteRecord()` 构造。
 *
 * 本模块**只做判定、不写文件**；调用方按 `DateMovePlan` 的 `ts` / `tombstoneTs` 决定追加哪些行。
 *
 * 背景：`docs/UX-STEPS.md` §3 D5（新建 / 编辑可指定日期）。
 */
import { nowIso, nextTsSameDate } from '../common/date';
import { recordDateKey } from './jsonl';

/** 一次日期变更的完整决策。所有字段恒为字符串 / 布尔，便于直接进 UI 与日志。 */
export interface DateMovePlan {
  ok: boolean;
  kind: 'same' | 'later' | 'earlier' | 'invalid';
  /** 目标日期键 `YYYY-MM-DD`；invalid 且目标非法时为空串。 */
  date: string;
  /** 新版本 ts；`ok=false` 时为空串。 */
  ts: string;
  /** 旧日片墓碑 ts；`needsTombstone=false` 时为空串。 */
  tombstoneTs: string;
  needsTombstone: boolean;
  /** `ok=false` 时的可展示中文原因；`ok=true` 时为空串。 */
  reason: string;
}

/**
 * 日期键合法性：必须是 `YYYY-MM-DD` 且是真实日历日（年份 1–9999）。
 * 本地构造 `new Date(y, m-1, d)` 后回读三个字段，不用 UTC 解析，避免时区把日期挪一天。
 */
function isValidDateKey(dateKey: string): boolean {
  if (typeof dateKey !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    return false;
  }
  const year = Number(dateKey.slice(0, 4));
  const month = Number(dateKey.slice(5, 7));
  const day = Number(dateKey.slice(8, 10));
  if (year < 1 || year > 9999) {
    return false;
  }
  const probe = new Date(year, month - 1, day);
  return probe.getFullYear() === year && probe.getMonth() === month - 1 && probe.getDate() === day;
}

/** 取可用的时钟：脏 `now` 退化为当前时间，保证后续函数永不抛错。 */
function clockOf(now: Date): Date {
  return now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
}

/** 失败计划的统一形状（无任何写入）。 */
function failed(kind: 'invalid' | 'earlier', date: string, reason: string): DateMovePlan {
  return { ok: false, kind, date, ts: '', tombstoneTs: '', needsTombstone: false, reason };
}

/**
 * 生成"日期部分是 `dateKey`"的 ts，形状与 `nowIso(now)` 字节一致。
 *
 * 实现：先取 `nowIso(now)`（`YYYY-MM-DDTHH:MM:SS±HH:MM`，无毫秒），再把前 10 个字符换成
 * `dateKey`。这样时钟与本地时区偏移完全沿用 `now`，且不会引入第二种时间格式。
 * 直接后果：`tsForDate(localDateKey(now), now) === nowIso(now)`。
 * 非法日期返回空串。
 */
export function tsForDate(dateKey: string, now: Date = new Date()): string {
  if (!isValidDateKey(dateKey)) {
    return '';
  }
  return `${dateKey}${nowIso(clockOf(now)).slice(10)}`;
}

/**
 * 决定"把记录改到 `targetDate`"该写哪个 ts（纯函数，同一入参恒定输出，不抛错）。
 *
 * 顺序：非法目标日 → 新记录（空 originalTs）→ 原 ts 无法解析 → 同日 → 往后 → 往早。
 * 往后改时 fail-closed：新版本必须严格晚于原记录与墓碑，异常偏移 / 时钟下宁可拒绝。
 */
export function planDateMove(originalTs: string, targetDate: string, now: Date = new Date()): DateMovePlan {
  // 运行时脏数据兜底：类型声明管不到调用方传进来的垃圾，下面每个分支都不能抛。
  const clock: Date = clockOf(now);
  if (!isValidDateKey(targetDate)) {
    return failed('invalid', '', '日期不合法：请选择有效日期（YYYY-MM-DD）');
  }
  const target: string = targetDate;
  const original: string = typeof originalTs === 'string' ? originalTs : '';

  if (original.trim().length === 0) {
    const ts: string = tsForDate(target, clock);
    if (ts.length === 0) {
      return failed('invalid', '', '日期不合法：请选择有效日期（YYYY-MM-DD）');
    }
    return { ok: true, kind: 'same', date: target, ts, tombstoneTs: '', needsTombstone: false, reason: '' };
  }

  const originalMillis: number = Date.parse(original);
  if (Number.isNaN(originalMillis)) {
    return failed('invalid', target, '原记录时间戳无法解析，无法安全改日期：请返回列表重试');
  }

  const originalDate: string = recordDateKey(original);
  if (target === originalDate) {
    return {
      ok: true,
      kind: 'same',
      date: target,
      ts: nextTsSameDate(original, clock),
      tombstoneTs: '',
      needsTombstone: false,
      reason: ''
    };
  }

  if (target > originalDate) {
    const ts: string = tsForDate(target, clock);
    const tombstoneTs: string = nextTsSameDate(original, clock);
    const tsMillis: number = Date.parse(ts);
    const tombstoneMillis: number = Date.parse(tombstoneTs);
    if (
      ts.length === 0 ||
      Number.isNaN(tsMillis) ||
      Number.isNaN(tombstoneMillis) ||
      tsMillis <= originalMillis ||
      tsMillis <= tombstoneMillis
    ) {
      return failed(
        'invalid',
        target,
        `无法为日期 ${target} 生成严格晚于原记录的版本时间（时区/时钟异常）：请稍后重试`
      );
    }
    return { ok: true, kind: 'later', date: target, ts, tombstoneTs, needsTombstone: true, reason: '' };
  }

  return failed(
    'earlier',
    target,
    '不能把记录改到更早的日期：日程按「同 id 取较晚 ts」折叠，往早改会被判成旧版本而忽略（旧版本还会盖掉这次修改）。补记过去日期请新建一条并选那天。'
  );
}
