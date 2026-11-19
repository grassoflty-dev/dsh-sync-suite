/**
 * 保存返回首页的一次性标记与局部刷新判定（纯 TypeScript，零 SDK import）。
 *
 * 由 `tools/tsconfig.json` 编译成 `.build/model/homeRefresh.js`，可在 Node 直接测
 * （与 `model/editorDraft.ts` 同一约定）。本文件只做数据形状与判定，不碰任何 UI / 存储 API。
 *
 * 为什么要有它：
 * 首页原来 `onPageShow` 每次都跑 `reconcileIfDue()` + `reload()` + `loadSummary()` + `paneTick+1`，
 * 这是一次「全量对账 + 全量重读」。但从编辑页保存返回时，写盘（`scheduleStore.appendRecord`）
 * 与派生索引（`open.jsonl`）都已在 `appendRecord` 内同步完成，首页真正需要的只是
 * 「重读一次列表」。所以保存时写一把一次性标记，首页读到就走局部刷新分支：
 * 只 `reload()` + 对账刚保存的那一行，不再跑全量对账、不重读汇总、不推进 `paneTick`。
 * 标记读后即清，避免下一次从设置页返回被误判成保存返回。
 */

import type { ScheduleRecord } from './types';

/** 一次性「刚保存返回」标记的 AppStorage 键。 */
export const SAVED_MARKER_KEY: string = 'home.lastSaved';

/** 单条标记文本的长度上限（超过按脏数据返回 `null`，绝不灌进 UI）。 */
const MAX_RAW_LENGTH: number = 2048;

/** 保存标记的数据形状。 */
export interface SavedMarker {
  id: string;
  date: string;
  ts: string;
  done: boolean;
}

/** 反序列化的中间形态：所有字段都可能缺失 / 类型不对（外部数据不可信）。 */
interface RawSavedMarker {
  id?: string;
  date?: string;
  ts?: string;
  done?: boolean;
}

/** 非字符串字段给兜底空串（真值由类型系统保证，运行时仍防一手脏数据）。 */
function safeString(value: string): string {
  return typeof value === 'string' ? value : '';
}

/**
 * 序列化保存标记（字段顺序固定，便于 diff / 排障）。
 *
 * `id` / `date` / `ts` 非字符串给兜底空串，`done` 非 boolean 兜底 `false`。
 */
export function encodeSavedMarker(marker: SavedMarker): string {
  const safe: SavedMarker = {
    id: safeString(marker.id),
    date: safeString(marker.date),
    ts: safeString(marker.ts),
    done: typeof marker.done === 'boolean' ? marker.done : false
  };
  return JSON.stringify(safe);
}

/**
 * 解析保存标记。返回 `null` 的情况（**一律不抛**）：
 * - `null` / `undefined` / 空串 / 纯空白 / 超过 `MAX_RAW_LENGTH` 字符；
 * - JSON 语法错误、不是对象、是数组；
 * - `id` / `date` / `ts` 任一不是非空字符串。
 *
 * `done` 缺失或非 boolean 按 `false`。
 */
export function decodeSavedMarker(raw: string | null | undefined): SavedMarker | null {
  const text: string = typeof raw === 'string' ? raw.trim() : '';
  if (text.length === 0 || text.length > MAX_RAW_LENGTH) {
    return null;
  }
  let parsed: RawSavedMarker | null = null;
  try {
    parsed = JSON.parse(text) as RawSavedMarker;
  } catch {
    return null;
  }
  if (parsed === null || parsed === undefined || typeof parsed !== 'object') {
    return null;
  }
  if (Array.isArray(parsed)) {
    return null;
  }
  const rawId: string | undefined = parsed.id;
  const rawDate: string | undefined = parsed.date;
  const rawTs: string | undefined = parsed.ts;
  const rawDone: boolean | undefined = parsed.done;
  if (typeof rawId !== 'string' || rawId.length === 0) {
    return null;
  }
  if (typeof rawDate !== 'string' || rawDate.length === 0) {
    return null;
  }
  if (typeof rawTs !== 'string' || rawTs.length === 0) {
    return null;
  }
  const marker: SavedMarker = {
    id: rawId,
    date: rawDate,
    ts: rawTs,
    done: typeof rawDone === 'boolean' ? rawDone : false
  };
  return marker;
}

/**
 * `records` 里是否已有「同 id 且同 ts」的记录版本（`ts` 精确匹配）。
 *
 * `records` 为 `null` / `undefined` 按空数组处理（返回 `false`）。
 */
export function containsRecordVersion(records: ScheduleRecord[], id: string, ts: string): boolean {
  const list: ScheduleRecord[] = records === null || records === undefined ? [] : records;
  for (const record of list) {
    if (record !== null && record !== undefined && record.id === id && record.ts === ts) {
      return true;
    }
  }
  return false;
}
