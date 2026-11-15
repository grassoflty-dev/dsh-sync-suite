/**
 * 桌面端的 id 与时间生成，**逐字符对齐 App 实现**：
 *
 * - `newRecordId` ← `entry/src/main/ets/services/scheduleStore.ets` 的 `newRecordId()`
 *   （`Date.now().toString(36)` + `-` + `Math.floor(Math.random()*1679615).toString(36)`）；
 * - `nowIso` / `nextTsSameDate` / `localDateKey` ← `entry/src/main/ets/common/date.ts` 同名函数。
 *
 * 为什么要抄而不是"改成 ISO UTC"：`id` 是跨设备折叠键，`ts` 是折叠排序键（`foldById` 按 ts 升序
 * 让后者覆盖前者）。两端产出同形字符串，平板与 PC 写的行才能在同一份 JSONL 里正确折叠，
 * 而不是因为 `Z` 与 `+08:00` 混排出现"同 id 取错版本"。
 *
 * 契约：`docs/DATA-CONTRACT.md` §3。
 */
/** 随机后缀上界，与 App 一致（36^4 - 1，产出最多 4 位 base36）。 */
const ID_RANDOM_RANGE = 1679615;
function pad2(value) {
    return value < 10 ? `0${value}` : `${value}`;
}
/**
 * 新记录 id：毫秒时间戳 base36 + 随机后缀，例如 `m9x2k1-3fk`。
 *
 * 与 App `newRecordId()` 完全同构（唯一差别是这里允许注入 `now` 便于测试）。
 */
export function newRecordId(now = new Date()) {
    const stamp = now.getTime().toString(36);
    const random = Math.floor(Math.random() * ID_RANDOM_RANGE).toString(36);
    return `${stamp}-${random}`;
}
/** 本地时区日期键 `YYYY-MM-DD`（日程文件名）。 */
export function localDateKey(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}
/** 本地时区偏移分钟数（东八区为 480，与 `Date#getTimezoneOffset` 反号）。 */
function offsetMinutes(date) {
    return -date.getTimezoneOffset();
}
function offsetSuffix(offset) {
    const sign = offset >= 0 ? '+' : '-';
    const abs = Math.abs(offset);
    return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}
/**
 * 当前时间的 ISO 8601 字符串，带本地时区偏移（例如 `2026-11-15T21:45:27+08:00`）。
 *
 * 与 `toISOString()`（UTC + `Z`）不同：保留本地时间偏移，与 App `nowIso()` 逐字符一致
 * （秒级精度，无毫秒）。
 */
export function nowIso(date = new Date()) {
    return (`${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
        `T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}` +
        offsetSuffix(offsetMinutes(date)));
}
/** 从 ISO 字符串取当天毫秒（HH:mm:ss.SSS）；非法返回 -1。 */
function clockMillis(iso) {
    const matched = /T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/.exec(iso);
    if (matched === null)
        return -1;
    const millis = matched[4] === undefined ? 0 : Number(matched[4].padEnd(3, '0'));
    return (Number(matched[1]) * 3600 + Number(matched[2]) * 60 + Number(matched[3])) * 1000 + millis;
}
/**
 * 同一日期内可排序的新 ts：保留原记录日期，时刻取 `max(当前时刻, 原时刻 + 1ms)`。
 *
 * 与 App `nextTsSameDate()` 同义：用于"追加同 id 的新版本"（编辑 / 勾选完成），
 * 保证 `foldById` 稳定取到新版本，同时记录不会被迁到别的日期文件。
 */
export function nextTsSameDate(originalTs, now = new Date()) {
    if (typeof originalTs !== 'string' || Number.isNaN(Date.parse(originalTs))) {
        return nowIso(now);
    }
    const date = /^\d{4}-\d{2}-\d{2}/.test(originalTs) ? originalTs.slice(0, 10) : localDateKey(now);
    const originalClock = clockMillis(originalTs);
    const nowClock = (now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()) * 1000 + now.getMilliseconds();
    const limit = 24 * 3600 * 1000 - 1;
    let target = Math.max(nowClock, originalClock < 0 ? 0 : originalClock + 1);
    if (target > limit)
        target = limit;
    const hours = Math.floor(target / 3600000);
    const minutes = Math.floor((target % 3600000) / 60000);
    const seconds = Math.floor((target % 60000) / 1000);
    const millis = target % 1000;
    const fraction = millis === 0 ? '' : `.${`${millis}`.padStart(3, '0')}`;
    return (`${date}T${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}${fraction}` +
        offsetSuffix(offsetMinutes(now)));
}
/** `HH:MM`（从 ts 的 ISO 前缀直接取，跨设备阅读不做时区换算）；不可解析返回空串。 */
export function formatClock(iso) {
    const text = typeof iso === 'string' ? iso.trim() : '';
    const matched = /^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2})/.exec(text);
    if (matched !== null)
        return `${matched[1]}:${matched[2]}`;
    const millis = Date.parse(text);
    if (Number.isNaN(millis))
        return '';
    const date = new Date(millis);
    return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}
