/**
 * 本地时间工具（纯逻辑，不 import 鸿蒙 SDK 运行时，也不依赖 `Intl`）。
 *
 * - `localDateKey` 用本机时区生成日程目录名 `YYYY-MM-DD`（`devices/<id>/schedules/<date>.jsonl`）；
 * - `nowIso` 生成带本地时区偏移的 ISO 8601，与 JSONL 的 `ts` 字段同形；
 * - `formatClock` 用于列表页展示时间。
 *
 * 契约：`docs/CONTRACT.md` §3.2、`docs/DATA-CONTRACT.md` §3。
 */

function pad2(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

/** 本地时区日期键 `YYYY-MM-DD`。 */
export function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** 本地时区偏移（分钟，东八区为 -480，与 `Date#getTimezoneOffset` 同号）。 */
function offsetMinutes(date: Date): number {
  return -date.getTimezoneOffset();
}

/**
 * 当前时间的 ISO 8601 字符串，带本地时区偏移，例如 `2026-11-14T22:25:20+08:00`。
 * 与 `new Date().toISOString()`（UTC + Z）不同，这里保留本地时间，便于人工阅读与跨设备展示。
 */
export function nowIso(date: Date = new Date()): string {
  const offset = offsetMinutes(date);
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  const text =
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    `T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}` +
    `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
  return text;
}

/**
 * 展示用时钟 `HH:MM`。
 * 优先取 ISO 字符串里的本地时间部分（保留记录者时区，跨设备阅读不会被换算）；
 * 无 ISO 形态时退回本机时区换算；无法解析返回空字符串。
 */
export function formatClock(iso: string): string {
  const text = typeof iso === 'string' ? iso.trim() : '';
  const matched = /^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2})/.exec(text);
  if (matched !== null) {
    return `${matched[1]}:${matched[2]}`;
  }
  const millis = Date.parse(text);
  if (Number.isNaN(millis)) {
    return '';
  }
  const date = new Date(millis);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** 从 ISO 字符串取当天毫秒（HH:mm:ss.SSS），非法返回 -1。 */
function clockMillis(iso: string): number {
  const matched = /T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/.exec(iso);
  if (matched === null) {
    return -1;
  }
  const millis = matched[4] === undefined ? 0 : Number(matched[4].padEnd(3, '0'));
  return (Number(matched[1]) * 3600 + Number(matched[2]) * 60 + Number(matched[3])) * 1000 + millis;
}

/**
 * 同一日期内可排序的新 ts：**保留原记录日期**，时刻取 `max(当前时刻, 原时刻 + 1ms)`。
 *
 * 用途：编辑 / 勾选完成 / AI 结构化保存等「追加新版本」场景。记录因此留在原日期文件
 * （`byDate` 不会把它迁到当天），同时严格大于原 ts，保证 `foldById`（ts 升序、后写覆盖）
 * 稳定取到新版本；原记录为 23:59:59.999 时钳到当天上限，靠稳定排序的输入顺序取胜。
 * 原 ts 无法解析时退化为当前时间。
 */
export function nextTsSameDate(originalTs: string, now: Date = new Date()): string {
  if (typeof originalTs !== 'string' || Number.isNaN(Date.parse(originalTs))) {
    return nowIso(now);
  }
  const date = /^\d{4}-\d{2}-\d{2}/.test(originalTs) ? originalTs.slice(0, 10) : localDateKey(now);
  const originalClock = clockMillis(originalTs);
  const nowClock =
    (now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()) * 1000 + now.getMilliseconds();
  const limit = 24 * 3600 * 1000 - 1;
  let target = Math.max(nowClock, originalClock < 0 ? 0 : originalClock + 1);
  if (target > limit) {
    target = limit;
  }
  const hours = Math.floor(target / 3600000);
  const minutes = Math.floor((target % 3600000) / 60000);
  const seconds = Math.floor((target % 60000) / 1000);
  const millis = target % 1000;
  const offset = offsetMinutes(now);
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  const fraction = millis === 0 ? '' : `.${`${millis}`.padStart(3, '0')}`;
  return (
    `${date}T${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}${fraction}` +
    `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
  );
}

