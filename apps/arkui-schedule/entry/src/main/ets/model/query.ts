/**
 * 首页「搜索 + 筛选」纯逻辑（零 SDK / 零服务层依赖，`tools/tsconfig.json` 直接编成 JS 跑单测）。
 *
 * 设计（与首页「今日 / 未完成」两段 + 「显示已完成」开关 **正交**）：
 * 1. 先按 tab 取数（`scheduleStore.readDay` / `openIndexStore.pendingRecords`）；
 * 2. 再用 `applyQuery(records, filter)` 过滤：关键词 AND + 状态 + 作者；
 * 3. `applyQuery` 保持输入顺序（不重排），因此列表排序仍由数据源决定（ts 升序），筛选不会让行乱跳。
 *
 * 匹配规则：
 * - **大小写不敏感**：`normalizeKeyword` 负责 trim + lower + 折叠连续空白；
 * - **多关键词 AND**：按空格分词，每个词都要命中 `title` / `body` / `ocr_text` / `author` 之一；
 * - **中文无空格**：整串就是一个词（子串匹配），因此「周会」能命中「周会讨论排期」；
 * - **墓碑永远不出现**：`applyQuery` 内部一律过滤 `deleted === true`（与读取侧 `withoutDeleted` 同一口径）。
 */
import type { ScheduleRecord } from './types';
import { isDeletedRecord } from './undoDelete';

/** 状态筛选三态。 */
export type QueryStatus = 'all' | 'open' | 'done';

/** 一次查询的条件（空 filter = 不过滤，按原顺序返回全部可见记录）。 */
export interface QueryFilter {
  /** 原始关键词串（保留用户输入的大小写与空白，仅用于空态文案）。 */
  text: string;
  /** 状态：全部 / 未完成 / 已完成。 */
  status: QueryStatus;
  /** 作者**精确**匹配；空串 = 不筛作者。 */
  author: string;
}

/** 空 filter（首页初始状态）。每次返回新对象，调用方改它不会污染别人。 */
export function emptyFilter(): QueryFilter {
  const filter: QueryFilter = { text: '', status: 'all', author: '' };
  return filter;
}

/** 把任意字符串收敛成合法的状态值（未知值回落 `all`，页面里的 @State 不必做类型断言）。 */
export function filterStatusOf(status: string): QueryStatus {
  if (status === 'open') {
    return 'open';
  }
  if (status === 'done') {
    return 'done';
  }
  return 'all';
}

/** 由页面的三个 @State（都是 string）构造 filter，避免在 .ets 里写联合类型断言。 */
export function makeFilter(text: string, status: string, author: string): QueryFilter {
  const filter: QueryFilter = {
    text: typeof text === 'string' ? text : '',
    status: filterStatusOf(status),
    author: typeof author === 'string' ? author.trim() : ''
  };
  return filter;
}

/** 规范化关键词：trim → 小写 → 连续空白折叠成一个空格（全角空格也算空白）。 */
export function normalizeKeyword(text: string): string {
  const raw = typeof text === 'string' ? text : '';
  return raw.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * 关键词分词：按空格切开，丢弃空词。
 *
 * 中文没有空格时整串就是一个词（`splitKeywords('周会讨论')` → `['周会讨论']`），
 * 走子串匹配即可命中；英文/多词则要求**每个词都出现**（AND）。
 */
export function splitKeywords(text: string): string[] {
  const normalized = normalizeKeyword(text);
  const words: string[] = [];
  if (normalized.length === 0) {
    return words;
  }
  for (const part of normalized.split(' ')) {
    if (part.length > 0) {
      words.push(part);
    }
  }
  return words;
}

/** 单个关键词是否命中一条记录的可搜索字段（`title` / `body` / `ocr_text` / `author`）。 */
function keywordHitsRecord(record: ScheduleRecord, keyword: string): boolean {
  if (record.title.toLowerCase().indexOf(keyword) >= 0) {
    return true;
  }
  if (record.body.toLowerCase().indexOf(keyword) >= 0) {
    return true;
  }
  if (record.author.toLowerCase().indexOf(keyword) >= 0) {
    return true;
  }
  if (record.ocr_text !== undefined && record.ocr_text.toLowerCase().indexOf(keyword) >= 0) {
    return true;
  }
  return false;
}

/**
 * 一条记录是否匹配 filter。
 *
 * 顺序：墓碑 → 状态 → 作者 → 关键词（AND）。任一条不满足即 false。
 */
export function matchesQuery(record: ScheduleRecord, filter: QueryFilter): boolean {
  if (isDeletedRecord(record)) {
    return false;
  }
  if (filter.status === 'open' && record.done === true) {
    return false;
  }
  if (filter.status === 'done' && record.done !== true) {
    return false;
  }
  const author = filter.author.trim();
  if (author.length > 0 && record.author.trim() !== author) {
    return false;
  }
  for (const keyword of splitKeywords(filter.text)) {
    if (!keywordHitsRecord(record, keyword)) {
      return false;
    }
  }
  return true;
}

/**
 * 应用 filter：过滤 + **保持原顺序**（稳定）。
 *
 * 空 filter 也会返回与入参等值的新数组（内部要剔除墓碑，不能直接复用入参引用）。
 */
export function applyQuery(records: ScheduleRecord[], filter: QueryFilter): ScheduleRecord[] {
  const result: ScheduleRecord[] = [];
  for (const record of records) {
    if (matchesQuery(record, filter)) {
      result.push(record);
    }
  }
  return result;
}

/**
 * 作者 chips 数据源：去重 + 排序（升序、按码点比较，跨设备结果一致）。
 * 空作者（历史数据里 author 可能是空串）不产生 chip。
 */
export function authorsOf(records: ScheduleRecord[]): string[] {
  const seen = new Set<string>();
  for (const record of records) {
    const author = record.author.trim();
    if (author.length > 0) {
      seen.add(author);
    }
  }
  const authors = Array.from(seen.values());
  authors.sort((left: string, right: string) => {
    if (left === right) {
      return 0;
    }
    return left < right ? -1 : 1;
  });
  return authors;
}

/** 是否有搜索词（空态文案要区分「没有匹配」与「没有符合条件的筛选」）。 */
export function hasKeyword(filter: QueryFilter): boolean {
  return normalizeKeyword(filter.text).length > 0;
}

/** 是否有任何筛选条件（搜索词 / 状态 / 作者）。全空 = 沿用页面原有空态。 */
export function isFilterActive(filter: QueryFilter): boolean {
  if (hasKeyword(filter)) {
    return true;
  }
  if (filter.status !== 'all') {
    return true;
  }
  return filter.author.trim().length > 0;
}
