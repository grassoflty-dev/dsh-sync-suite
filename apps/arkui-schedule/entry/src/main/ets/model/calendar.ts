/**
 * 日历网格纯逻辑（零 SDK import，可在 Node 下直接单测）。
 *
 * 用途：首页日期条的「日历选择器」（`components/MonthCalendar.ets`）需要一张
 * **固定 6 行 × 7 列** 的月视图 —— 跨月补位也必须是真实日期（可点击直接跳过去），
 * 否则切月时网格高度会随月份跳动，弹层一跳一跳。
 *
 * 约束（必须保持）：
 * - 不 import 任何 SDK / ArkUI / `$r()` / 页面组件，因此 `tools/tsconfig.json` 能把它编译成
 *   JS 交给 `tools/test/calendar.test.mjs` 直接跑；
 * - 全部用**纯整数运算**（Howard Hinnant 的 civil-from-days 算法），不碰 `Date` 与 `Intl`：
 *   单测在任何时区/区域都得到同一结果（`new Date(y, m, d).getDay()` 在夏令时边界会漂一天，
 *   不能作为「星期几」的唯一依据）；
 * - 返回类型一律是**具名接口**而不是对象字面量类型（ArkTS `arkts-no-obj-literals-as-types`），
 *   函数里也不写无类型对象字面量（`arkts-no-untyped-obj-literals`）；
 * - 所有函数对非法输入（`2026-13-01`、`abc`、空串、NaN）**返回兜底值，绝不抛异常**：
 *   调用方是 UI，少画一格好过崩一屏。
 *
 * 与 `common/date.ts` 的分工：那边是「本地时区的当下」（`localDateKey(new Date())`），
 * 这边是「给定日期键的日历结构」；两边只交换 `YYYY-MM-DD` 文本，互不依赖。
 */

/** 年 / 月 / 日（`parseDateKey` 的解析结果）。 */
export interface DateParts {
  /** 年（1–9999）。 */
  year: number;
  /** 月（1–12）。 */
  month: number;
  /** 日（1–31，已按真日历校验）。 */
  day: number;
}

/** 年 / 月（`shiftMonth` 的平移结果）。 */
export interface MonthParts {
  /** 年。 */
  year: number;
  /** 月（1–12，已归一化）。 */
  month: number;
}

/** 日历网格里的一格（可能是上个月 / 下个月的补位）。 */
export interface CalendarDay {
  /** 该格的日期键 `YYYY-MM-DD`（补位格也是**真实日期**，点击可直接跳转）。 */
  dateKey: string;
  /** 日（1–31）。 */
  day: number;
  /** 是否属于当前展示月（`false` = 上月 / 下月补位格）。 */
  inMonth: boolean;
  /** 是否等于 `todayKey`（`todayKey` 非法时全为 `false`，不会误标）。 */
  isToday: boolean;
  /** 该日期的星期：0=周日 … 6=周六。 */
  weekday: number;
}

/** 一个月的日历网格：**固定 6 行 × 7 列**。 */
export interface CalendarMonth {
  /** 年（1–9999）。 */
  year: number;
  /** 月（1–12）。 */
  month: number;
  /** 标题，形如 `2026 年 11 月`（非法入参为空串）。 */
  title: string;
  /** 6 行 × 7 列（非法入参为空数组，调用方据此判断「无可渲染」）。 */
  weeks: CalendarDay[][];
}

/** 每周首日：0=周日，1=周一（默认，中文习惯）。 */
export type WeekStart = 0 | 1;

/** 网格固定行数（6 行保证任何月份都不跳动）。 */
const GRID_ROWS: number = 6;
/** 网格固定列数。 */
const GRID_COLUMNS: number = 7;
/** 合法年份下限。 */
const MIN_YEAR: number = 1;
/** 合法年份上限。 */
const MAX_YEAR: number = 9999;
/** 一年 12 个月。 */
const MONTHS_PER_YEAR: number = 12;
/** 星期文本（0=周日 起）。 */
const WEEKDAY_TEXT: string[] = ['日', '一', '二', '三', '四', '五', '六'];
/** 平年每月天数（2 月由 `daysInMonth` 单独处理闰年）。 */
const MONTH_DAYS: number[] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
/** 1970-01-01 是周四（0=周日 编号为 4）。 */
const EPOCH_WEEKDAY: number = 4;
/** civil-from-days 的纪元偏移（1970-01-01）。 */
const DAYS_EPOCH_OFFSET: number = 719468;

function pad2(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

/** 年份是否可用于日历运算（整数且在 1–9999 内）。 */
function isUsableYear(year: number): boolean {
  return Number.isInteger(year) && year >= MIN_YEAR && year <= MAX_YEAR;
}

/** 月份是否合法（1–12 的整数）。 */
function isUsableMonth(month: number): boolean {
  return Number.isInteger(month) && month >= 1 && month <= MONTHS_PER_YEAR;
}

/** 是否闰年（公历规则：4 年一闰、100 年不闰、400 年再闰）。非法年份返回 `false`。 */
export function isLeapYear(year: number): boolean {
  if (!isUsableYear(year)) {
    return false;
  }
  if (year % 400 === 0) {
    return true;
  }
  if (year % 100 === 0) {
    return false;
  }
  return year % 4 === 0;
}

/**
 * 某年某月的天数（`month` 为 1–12）。
 *
 * 非法年 / 月返回 `0`（而不是抛异常或猜 31）：调用方据此判断「这个月画不出来」。
 */
export function daysInMonth(year: number, month: number): number {
  if (!isUsableYear(year) || !isUsableMonth(month)) {
    return 0;
  }
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }
  return MONTH_DAYS[month - 1];
}

/** 「年-月-日」→ 距 1970-01-01 的天数（纯整数，proleptic Gregorian）。 */
function daysFromCivil(year: number, month: number, day: number): number {
  const adjustedYear = month <= 2 ? year - 1 : year;
  const era = Math.floor(adjustedYear / 400);
  const yearOfEra = adjustedYear - era * 400;
  const monthOfYear = (month + 9) % 12;
  const dayOfYear = Math.floor((153 * monthOfYear + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - DAYS_EPOCH_OFFSET;
}

/** 距 1970-01-01 的天数 → 年/月/日（`daysFromCivil` 的逆运算）。 */
function civilFromDays(days: number): DateParts {
  const shifted = days + DAYS_EPOCH_OFFSET;
  const era = Math.floor(shifted / 146097);
  const dayOfEra = shifted - era * 146097;
  const yearOfEra = Math.floor(
    (dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36524) - Math.floor(dayOfEra / 146096)) / 365
  );
  const year = yearOfEra + era * 400;
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthOfYear = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthOfYear + 2) / 5) + 1;
  const month = monthOfYear < 10 ? monthOfYear + 3 : monthOfYear - 9;
  const result: DateParts = { year: month <= 2 ? year + 1 : year, month: month, day: day };
  return result;
}

/** 距 1970-01-01 的天数 → 星期（0=周日 … 6=周六）。 */
function weekdayFromDays(days: number): number {
  const raw = (days + EPOCH_WEEKDAY) % 7;
  return raw < 0 ? raw + 7 : raw;
}

/** 宽松的日期键拼装（网格补位可能落到 0 年，不能被 `formatDateKey` 的严格校验吞掉）。 */
function keyOf(year: number, month: number, day: number): string {
  const yearText = `${year}`;
  const padded = yearText.length >= 4 ? yearText : `0000${yearText}`.slice(-4);
  return `${padded}-${pad2(month)}-${pad2(day)}`;
}

/** 严格解析日期键 `YYYY-MM-DD`，并做真日历校验（`2026-02-30` / `2026-13-01` / `abc` / 空串 → `null`）。 */
export function parseDateKey(dateKey: string): DateParts | null {
  if (typeof dateKey !== 'string') {
    return null;
  }
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey.trim());
  if (matched === null) {
    return null;
  }
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  if (!isUsableYear(year) || !isUsableMonth(month)) {
    return null;
  }
  if (!Number.isInteger(day) || day < 1 || day > daysInMonth(year, month)) {
    return null;
  }
  const result: DateParts = { year: year, month: month, day: day };
  return result;
}

/** 拼装并校验日期键：非法（`2026-2-1`、`2026-02-30`、NaN）返回空串。 */
export function formatDateKey(year: number, month: number, day: number): string {
  if (!isUsableYear(year) || !isUsableMonth(month)) {
    return '';
  }
  if (!Number.isInteger(day) || day < 1 || day > daysInMonth(year, month)) {
    return '';
  }
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** 月份标题，如 `2026 年 11 月`（非法入参返回空串；月不补前导零）。 */
export function formatMonthTitle(year: number, month: number): string {
  if (!isUsableYear(year) || !isUsableMonth(month)) {
    return '';
  }
  return `${year} 年 ${month} 月`;
}

/**
 * 星期表头文本（7 个单字）。
 *
 * `weekStart` 只认 0/1：0 = 周日起，1 = 周一起；其它值（含不传）一律按 1 处理。
 */
export function weekdayLabels(weekStart: number = 1): string[] {
  const start = weekStart === 0 ? 0 : 1;
  const labels: string[] = [];
  for (let index = 0; index < GRID_COLUMNS; index++) {
    labels.push(WEEKDAY_TEXT[(start + index) % 7]);
  }
  return labels;
}

/**
 * 生成一个月的 6×7 网格。
 *
 * - 跨月补位格 `inMonth=false`，但 `dateKey` / `day` / `weekday` 都是**真实值**（可直接点击跳转）；
 * - `weekStart`：0 = 周日起，1 = 周一起（其它值按 1 处理）；
 * - `todayKey` 非法时不会有任何 `isToday=true`；`todayKey` 落在补位格里也会被正确标记；
 * - 年 / 月非法时返回 `weeks: []` + `title: ''` 的兜底对象（不抛），调用方据此不渲染网格。
 */
export function monthGrid(year: number, month: number, weekStart: number, todayKey: string): CalendarMonth {
  const fallback: CalendarMonth = { year: year, month: month, title: '', weeks: [] };
  if (!isUsableYear(year) || !isUsableMonth(month)) {
    return fallback;
  }

  const start = weekStart === 0 ? 0 : 1;
  const firstSerial = daysFromCivil(year, month, 1);
  const firstWeekday = weekdayFromDays(firstSerial);
  const lead = (firstWeekday - start + GRID_COLUMNS) % GRID_COLUMNS;
  const today = parseDateKey(todayKey);
  const todayText = today === null ? '' : formatDateKey(today.year, today.month, today.day);

  const weeks: CalendarDay[][] = [];
  for (let row = 0; row < GRID_ROWS; row++) {
    const week: CalendarDay[] = [];
    for (let column = 0; column < GRID_COLUMNS; column++) {
      const serial = firstSerial - lead + row * GRID_COLUMNS + column;
      const civil = civilFromDays(serial);
      const dateKey = keyOf(civil.year, civil.month, civil.day);
      const cell: CalendarDay = {
        dateKey: dateKey,
        day: civil.day,
        inMonth: civil.year === year && civil.month === month,
        isToday: todayText.length > 0 && dateKey === todayText,
        weekday: weekdayFromDays(serial)
      };
      week.push(cell);
    }
    weeks.push(week);
  }

  const result: CalendarMonth = {
    year: year,
    month: month,
    title: formatMonthTitle(year, month),
    weeks: weeks
  };
  return result;
}

/**
 * 平移月份：`delta` 可正可负、可跨年。
 *
 * 越界的 `month`（0 / 13 / 负数）按「月序号」归一化：`(2026, 13, 0) → (2027, 1)`、
 * `(2026, 1, -1) → (2025, 12)`。非数值按年 1970 / 月 1 / 位移 0 兜底，绝不抛。
 */
export function shiftMonth(year: number, month: number, delta: number): MonthParts {
  const safeYear = Number.isFinite(year) ? Math.trunc(year) : 1970;
  const safeMonth = Number.isFinite(month) ? Math.trunc(month) : 1;
  const safeDelta = Number.isFinite(delta) ? Math.trunc(delta) : 0;
  const total = safeYear * MONTHS_PER_YEAR + (safeMonth - 1) + safeDelta;
  const nextYear = Math.floor(total / MONTHS_PER_YEAR);
  const nextMonth = total - nextYear * MONTHS_PER_YEAR + 1;
  const result: MonthParts = { year: nextYear, month: nextMonth };
  return result;
}

/** 把日期键规范化成 `YYYY-MM-DD`；非法返回空串。 */
function normalizeKey(dateKey: string | undefined): string {
  if (dateKey === undefined) {
    return '';
  }
  const parts = parseDateKey(dateKey);
  if (parts === null) {
    return '';
  }
  return formatDateKey(parts.year, parts.month, parts.day);
}

/**
 * 把日期键夹到 `[minKey, maxKey]` 区间内。
 *
 * - `dateKey` 非法 → 返回空串（垃圾进垃圾出没有意义，让调用方自己决定兜底）；
 * - `minKey` / `maxKey` 非法或未传 → 该侧不生效；
 * - `minKey > maxKey`（区间为空）→ 返回 `minKey`（下限优先：宁可显示起始日，也不显示越界日期）；
 * - 返回的一定是规范化后的 `YYYY-MM-DD`。
 */
export function clampDateKey(dateKey: string, minKey?: string, maxKey?: string): string {
  const parts = parseDateKey(dateKey);
  if (parts === null) {
    return '';
  }
  const text = formatDateKey(parts.year, parts.month, parts.day);
  const minText = normalizeKey(minKey);
  const maxText = normalizeKey(maxKey);
  if (minText.length > 0 && maxText.length > 0 && minText > maxText) {
    return minText;
  }
  if (minText.length > 0 && text < minText) {
    return minText;
  }
  if (maxText.length > 0 && text > maxText) {
    return maxText;
  }
  return text;
}
