/**
 * 编辑页草稿（标题 / 正文）的纯逻辑：**不 import 任何 SDK**，由 `tools/tsconfig.json`
 * 编译成 `.build/model/editorDraft.js` 后可在 Node 直接测（`tools/test/editorDraft.test.mjs`）。
 *
 * 为什么要有它（`docs/FAILURE-MODES.md` §6 的两条 P1）：
 * - 旧实现只把未保存内容写进 `AppStorage`（内存键 `editor.draft`）→ 进程被系统回收/闪退，
 *   刚打的字一个字都不剩，重进只能回到上次保存；
 * - 旧的键只有一个、且 `restoreDraft` 先清键后比对 `recordId` → 从记录 A 切到 B 时 A 的草稿被销毁。
 *
 * 现在的约定：
 * - **一条记录一把键**：`editor.draft.<recordId>`（新建 = `editor.draft.new`），互不覆盖；
 * - 落盘走 `services/draftStore.ets` 的通用文本 API（写 `.tmp` → rename），键名由 `draftKey()` 给；
 * - 输入去抖 `EDITOR_DRAFT_MIN_INTERVAL_MS`（1000ms）：最多丢 1 秒输入；
 * - 解析容错：任何字段坏了都返回 `null`（**不抛**），调用方当成「没有草稿」。
 *
 * 体积上限（本文件负责，不靠调用方自觉）：
 * - 正文最多 `EDITOR_DRAFT_MAX_BODY`（20000 字符），序列化时截断——超长正文只会丢尾部，
 *   不会整段不恢复（「宁可少最后几行，也不要一条都恢复不出来」）；
 * - 标题最多 `EDITOR_DRAFT_MAX_TITLE`（200 字符）；
 * - 整段草稿文本超过 `EDITOR_DRAFT_MAX_RAW`（64000 字符）→ 视为脏数据返回 `null`
 *   （外部塞进来的大文件不往表单里灌）。
 *
 * 只恢复标题与正文：作者 / 完成状态 / 附件属于记录属性（保存态里已有），不进草稿。
 */

/** 草稿键前缀（按记录分槽：`editor.draft.<recordId>`）。 */
export const EDITOR_DRAFT_PREFIX: string = 'editor.draft.';

/** 新建（尚未保存）记录的槽名。 */
export const EDITOR_DRAFT_NEW_SLOT: string = 'new';

/** 去抖间隔（ms）：两次落盘之间至少隔这么久（recordId 变了例外，立即落盘）。 */
export const EDITOR_DRAFT_MIN_INTERVAL_MS: number = 1000;

/** 正文最多保留字符数（超出截断尾部，见文件头）。 */
export const EDITOR_DRAFT_MAX_BODY: number = 20000;

/** 标题最多保留字符数。 */
export const EDITOR_DRAFT_MAX_TITLE: number = 200;

/** 整段草稿文本最长字符数（超过按脏数据返回 `null`）。 */
export const EDITOR_DRAFT_MAX_RAW: number = 64000;

/** 一分钟 / 一小时的毫秒数（`describeRestore` 的分档用）。 */
const MINUTE_MS: number = 60 * 1000;
const HOUR_MS: number = 60 * MINUTE_MS;

/** 一份编辑草稿（磁盘上的完整形态）。 */
export interface EditorDraft {
  /** 记录 id（`''` = 新建）。恢复时必须与当前编辑对象一致，否则不认。 */
  recordId: string;
  title: string;
  body: string;
  /** 落盘时间（毫秒时间戳）：去抖比较与「几分钟前」提示都用它。 */
  savedAt: number;
}

/** 「保存态」与「当前输入」的共同形状（只比标题 / 正文）。 */
export interface EditorText {
  title: string;
  body: string;
}

/** 反序列化的中间形态：所有字段都可能缺失/类型不对（外部数据不可信）。 */
interface RawEditorDraft {
  recordId?: string;
  title?: string;
  body?: string;
  savedAt?: number;
}

/** 截断到 `max` 个字符（非字符串按空串算；`max <= 0` 返回空串）。 */
function truncate(text: string, max: number): string {
  const value: string = typeof text === 'string' ? text : '';
  if (!Number.isFinite(max) || max <= 0) {
    return '';
  }
  const limit: number = Math.floor(max);
  return value.length <= limit ? value : value.slice(0, limit);
}

/** 字符是否 ASCII 数字（用于决定「已恢复 2 分钟前…」里要不要空格）。 */
function startsWithDigit(text: string): boolean {
  if (text.length === 0) {
    return false;
  }
  const code: number = text.charCodeAt(0);
  return code >= 0x30 && code <= 0x39;
}

/**
 * 记录 id → 草稿键。
 *
 * `''`（新建）落到固定槽 `editor.draft.new`；已有记录落到 `editor.draft.<recordId>`。
 * `recordId` 已由上层校验（时间戳+随机后缀），这里不做字符清洗——落盘前
 * `model/draft.ts` 的 `sanitizeDraftKey()` 会把它变成安全文件名。
 */
export function draftKey(recordId: string): string {
  const id: string = typeof recordId === 'string' ? recordId.trim() : '';
  if (id.length === 0) {
    return `${EDITOR_DRAFT_PREFIX}${EDITOR_DRAFT_NEW_SLOT}`;
  }
  return `${EDITOR_DRAFT_PREFIX}${id}`;
}

/**
 * 序列化到可落盘文本（字段顺序固定，便于 diff / 排障）。
 *
 * 超长正文截断到 `EDITOR_DRAFT_MAX_BODY`、标题截断到 `EDITOR_DRAFT_MAX_TITLE`；
 * `savedAt` 非法时写 0（读回时按「刚刚」提示，不会让整份草稿作废）。
 */
export function serializeEditorDraft(draft: EditorDraft): string {
  const safe: EditorDraft = {
    recordId: typeof draft.recordId === 'string' ? draft.recordId : '',
    title: truncate(draft.title, EDITOR_DRAFT_MAX_TITLE),
    body: truncate(draft.body, EDITOR_DRAFT_MAX_BODY),
    savedAt: Number.isFinite(draft.savedAt) ? draft.savedAt : 0
  };
  return JSON.stringify(safe);
}

/**
 * 解析草稿文本。
 *
 * 返回 `null` 的几种情况（**一律不抛**）：
 * - `null` / `undefined` / 空串 / 纯空白（没有草稿，正常情况）；
 * - 整段文本超过 `EDITOR_DRAFT_MAX_RAW` 字符（超大脏数据）；
 * - JSON 语法错误、不是对象、是数组；
 * - `recordId` 不是非空字符串；`title` / `body` 不是字符串；`savedAt` 不是有限数。
 *
 * 字段超长（正文 > 20000 / 标题 > 200）时**截断保留**（见文件头：不整段丢弃）。
 */
export function parseEditorDraft(raw: string | null | undefined): EditorDraft | null {
  const text: string = typeof raw === 'string' ? raw.trim() : '';
  if (text.length === 0 || text.length > EDITOR_DRAFT_MAX_RAW) {
    return null;
  }
  let parsed: RawEditorDraft | null = null;
  try {
    parsed = JSON.parse(text) as RawEditorDraft;
  } catch {
    return null;
  }
  if (parsed === null || parsed === undefined || typeof parsed !== 'object') {
    return null;
  }
  if (Array.isArray(parsed)) {
    return null;
  }
  const rawRecordId: string | undefined = parsed.recordId;
  const rawTitle: string | undefined = parsed.title;
  const rawBody: string | undefined = parsed.body;
  const rawSavedAt: number | undefined = parsed.savedAt;
  if (typeof rawRecordId !== 'string' || rawRecordId.length === 0) {
    return null;
  }
  if (typeof rawTitle !== 'string' || typeof rawBody !== 'string') {
    return null;
  }
  if (rawSavedAt === undefined || rawSavedAt === null || !Number.isFinite(rawSavedAt)) {
    return null;
  }
  const draft: EditorDraft = {
    recordId: rawRecordId,
    title: truncate(rawTitle, EDITOR_DRAFT_MAX_TITLE),
    body: truncate(rawBody, EDITOR_DRAFT_MAX_BODY),
    savedAt: rawSavedAt
  };
  return draft;
}

/**
 * 是否该把 `next` 落盘（去抖的核心判定，纯函数）。
 *
 * 规则（按优先级）：
 * 1. 没有上一份（`previous === null`）→ `true`（第一笔就要有盘上的草稿）；
 * 2. `recordId` 变了 → `true`（换记录必须立即落盘，绝不能等间隔）；
 * 3. 标题与正文都没变 → `false`（重复输入/重绘不写盘）；
 * 4. 距上次落盘（`previous.savedAt`）< `minIntervalMs` → `false`（去抖）；
 * 5. 其余 → `true`。
 *
 * `minIntervalMs` 非法（NaN / 负数）按 0 处理；`now` 非法时按「间隔已过」处理
 * （宁可多写一次，也不能因为时钟异常一直不落盘）。
 */
export function shouldPersistDraft(
  previous: EditorDraft | null,
  next: EditorDraft,
  minIntervalMs: number,
  now: number
): boolean {
  if (previous === null || previous === undefined) {
    return true;
  }
  if (previous.recordId !== next.recordId) {
    return true;
  }
  if (previous.title === next.title && previous.body === next.body) {
    return false;
  }
  const interval: number = Number.isFinite(minIntervalMs) && minIntervalMs > 0 ? minIntervalMs : 0;
  if (!Number.isFinite(now) || !Number.isFinite(previous.savedAt)) {
    return true;
  }
  const elapsed: number = now - previous.savedAt;
  if (elapsed >= 0 && elapsed < interval) {
    return false;
  }
  return true;
}

/**
 * 与「保存态」相比是否有改动（脏判定，只比标题 / 正文）。
 *
 * 标题按 `trim()` 比较（与 `RecordEditorView.contentChanged()` 一致：只打一个空格不算改）；
 * 正文按原样比较（换行/空格都是用户内容）。
 */
export function dirtyAgainst(saved: EditorText, current: EditorText): boolean {
  if (saved === null || saved === undefined || current === null || current === undefined) {
    return false;
  }
  const savedTitle: string = typeof saved.title === 'string' ? saved.title.trim() : '';
  const currentTitle: string = typeof current.title === 'string' ? current.title.trim() : '';
  if (savedTitle !== currentTitle) {
    return true;
  }
  const savedBody: string = typeof saved.body === 'string' ? saved.body : '';
  const currentBody: string = typeof current.body === 'string' ? current.body : '';
  return savedBody !== currentBody;
}

/**
 * 「已恢复 …」提示文案（给用户看的一句话）。
 *
 * - 没有草稿 / 草稿里标题正文都空（含只有空白）→ `''`（不占一行）；
 * - `savedAt` 非法或晚于 `now`（时钟回拨）→ 按「刚刚」；
 * - 三档：`< 1 分钟` → `刚刚`；`< 1 小时` → `N 分钟前`；其余 → `N 小时前`。
 *
 * 例：`已恢复 2 分钟前未保存的草稿`；刚刚恢复时是 `已恢复刚刚未保存的草稿`
 * （同一句模板，只为可读性在数字前补一个空格）。
 */
export function describeRestore(draft: EditorDraft | null, now: number): string {
  if (draft === null || draft === undefined) {
    return '';
  }
  const title: string = typeof draft.title === 'string' ? draft.title.trim() : '';
  const body: string = typeof draft.body === 'string' ? draft.body : '';
  if (title.length === 0 && body.length === 0) {
    return '';
  }
  const current: number = Number.isFinite(now) ? now : Date.now();
  const savedAt: number = Number.isFinite(draft.savedAt) ? draft.savedAt : NaN;
  let label: string = '';
  if (!Number.isFinite(savedAt)) {
    label = '刚刚';
  } else {
    const elapsed: number = current - savedAt;
    if (elapsed < MINUTE_MS) {
      // 含负数（时钟回拨）与 0：都按「刚刚」说，别给用户看「-1 分钟前」
      label = '刚刚';
    } else if (elapsed < HOUR_MS) {
      label = `${Math.floor(elapsed / MINUTE_MS)} 分钟前`;
    } else {
      label = `${Math.floor(elapsed / HOUR_MS)} 小时前`;
    }
  }
  const gap: string = startsWithDigit(label) ? ' ' : '';
  return `已恢复${gap}${label}未保存的草稿`;
}
