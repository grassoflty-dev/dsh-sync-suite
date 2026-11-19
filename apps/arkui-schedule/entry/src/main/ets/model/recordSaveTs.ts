/**
 * 保存记录时的 `ts` 决策（纯 TypeScript，零 SDK / 零服务层依赖；Node 下可直接单测）。
 *
 * ## 收窄后的规则：日期只在新建时选一次
 * - 新建记录：所选日期决定 `ts` 落在哪个日片（`tsForDate`）；
 * - 已有记录：**永不改日期**，只按原 `ts` 同日升级（`nextTsSameDate`），`chosenDate` 不参与决策。
 *
 * `ts` 同时承担两个职责（契约：`docs/DATA-CONTRACT.md` §3，步骤：`docs/UX-STEPS.md` §4.4）：
 * 1. **分片键**：`recordDateKey(ts)` 取日期前缀，决定写进 `devices/<id>/schedules/<date>.jsonl`；
 * 2. **版本序**：`foldById` / `openIndex` 对同一 `id` 只保留 `ts` 较晚的一条。
 * 因此已有记录的唯一更新形式就是"同一天、更晚的 ts"；本模块不产生任何墓碑
 * （删除是另一套已上线功能，见 `model/undoDelete.ts`，与保存无关）。
 *
 * 本模块只做判定、不写文件；调用方按 `SaveTsPlan` 的 `ok` / `ts` 决定追加哪一行。
 */
import { nowIso, nextTsSameDate } from '../common/date';

/** 一次保存的 ts 决策。所有字段恒为字符串 / 布尔，便于直接进 UI 与日志。 */
export interface SaveTsPlan {
  ok: boolean;
  /** 新版本 ts；`ok=false` 时为空串。 */
  ts: string;
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

/**
 * 生成"日期部分是 `dateKey`"的 ts，形状与 `nowIso(now)` 字节一致。
 *
 * **这是全工程唯一把选定日期前缀套到 ts 上的地方**（`dateKey + nowIso(now).slice(10)`）：
 * 时钟与本地时区偏移完全沿用 `now`，不会引入第二种时间格式。
 * 直接后果：`tsForDate(localDateKey(now), now) === nowIso(now)`。非法日期返回空串。
 */
export function tsForDate(dateKey: string, now: Date = new Date()): string {
  if (!isValidDateKey(dateKey)) {
    return '';
  }
  return `${dateKey}${nowIso(clockOf(now)).slice(10)}`;
}

/**
 * 决定这次保存写哪个 ts（纯函数，同一入参恒定输出，不抛错）。
 *
 * `originalTs` 空白 = 新建，用 `chosenDate` 决定日片；`originalTs` 非空 = 已有记录，
 * **故意忽略 `chosenDate`**：记录已在某一天，只能同日升级，不能搬到别的日期。
 * 原 ts 无法解析时不猜日期，直接给出可展示原因、零写入。
 */
export function resolveSaveTs(originalTs: string, chosenDate: string, now: Date = new Date()): SaveTsPlan {
  const clock: Date = clockOf(now);
  const original: string = typeof originalTs === 'string' ? originalTs : '';

  if (original.trim().length === 0) {
    const ts: string = tsForDate(chosenDate, clock);
    if (ts.length === 0) {
      return { ok: false, ts: '', reason: '日期不合法：请为新建记录选择有效日期（YYYY-MM-DD）' };
    }
    return { ok: true, ts, reason: '' };
  }

  if (Number.isNaN(Date.parse(original))) {
    return { ok: false, ts: '', reason: '原记录时间戳无法解析，无法安全保存：请返回列表重试' };
  }

  // chosenDate 故意不参与：已有记录固定在原 ts 的日期，只做同日更晚版本。
  return { ok: true, ts: nextTsSameDate(original, clock), reason: '' };
}
