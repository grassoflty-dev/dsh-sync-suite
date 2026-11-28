/**
 * 「云端对话」列表 / 详情的**纯逻辑层**（零 SDK import）。
 *
 * 数据形态见 `docs/CHAT-SYNC.md` §2：
 * - `chats/index.jsonl`：**只追加**的列表投影，一行
 *   `{"id","title","updatedAt","messageCount","sha256","kind?"}`；同一个 id 可能出现多行，
 *   读侧**取最后一行**（§2.4：唯一允许「取最新」的地方，因为它是展示投影，不是事件流）。
 *   `kind` 是 `docs/CLOUD-CHAT-AND-DOTS.md` §3 的 additive 字段：缺字段的历史行**只在读侧**
 *   回落 `'cloud'`，不重写任何已有文件（存储侧 `kind:"chat"` 同样归一成 `'cloud'`）。
 * - `chats/<id>/session.jsonl`：**明文事件流**，行序即事件序；本模块只把它压成可读消息，
 *   绝不重排、不折叠（§1.2 明确拒绝在会话事件上做「按 ts 折叠」）。
 *
 * 三条硬约束（`docs/CONTRACT.md` §3.2 的纯逻辑层口径）：
 * 1. **不 import 任何鸿蒙 SDK**，也不用 `$r()` / ArkUI 类型 —— 因此可被
 *    `tools/tsconfig.json` 编译到 `tools/.build/` 并由 `tools/test/chatList.test.mjs` 直接跑；
 * 2. **任何函数都不抛异常**：坏 JSON 只计数（`errors` / `skipped`），调用方永远拿到可用结果；
 * 3. 不做 IO（读文件在 `services/chatStore.ets`），这里只吃字符串。
 *
 * 事件流的字段事实来自 `docs/RESEARCH-session-import.md` §3.2（workspace 根 docs/）：
 * `{type, seq, time(ms), data, ?surfaceOp, ?sourceEventSeqs}`；
 * - `user/message`        → `data.content`（string 或 `[{type:'text',text}]`）；
 * - `assistant/message`   → `data.message.content`（同上，部分版本直接给 `data.content`）；
 * - `tool/call`           → `data.name`（**只压成一行摘要，不渲染完整参数**：参数里常含绝对路径/命令输出）；
 * - `system/message` / 其它 `*​/message` → 也当消息展示（角色 `system` / `other`）；
 * - `usage` / `status` / `tool/result` / `turn/*` / `step/*` 等 → 跳过（列表页/详情页都不展示）。
 */

// ---------------------------------------------------------------- 列表投影

/**
 * 会话种类（`docs/CLOUD-CHAT-AND-DOTS.md` §2/§3）：
 * - `cloud` = 纯云端对话（存储侧写 `kind:"chat"` 或缺 `kind` 的历史行都归到这里）；
 * - `dots` = 与 dots 对话。
 *
 * 页面顶部分段按此字段过滤；旧行不写盘、只在读侧补默认值。
 */
export type ChatKind = 'cloud' | 'dots';

/**
 * 会话 preset（**不是**上面的 `ChatKind` 分段）：事实来自 workspace 根
 * `docs/RESEARCH-chat-preset.md` §5.1 的 `agentPreset` 投影。
 * - `chat` = 云端对话模式，**唯一**允许进平板列表 / 被隐藏的会话；
 * - `other` = standard（工作会话）/ 缺字段 / 未知 id / 读不到 —— 一律不可见、不可隐藏（fail-closed）。
 *
 * 不从标题、工作区、index 的 `kind` 猜测；没有可证明的 `agentPreset === 'chat'` 就当不是。
 */
export type ChatSessionPreset = 'chat' | 'other';

/** `chats/index.jsonl` 的一行（读侧已归一：缺字段用安全默认值补上）。 */
export interface ChatIndexEntry {
  /** 会话 id（= 目录名 = DSH header 的 `id`），空串绝不会出现在返回值里。 */
  id: string;
  /** 展示标题（缺失时回落「未命名会话」，**不会**为空串，避免列表行没字）。 */
  title: string;
  /** 最后一次上传时间（ISO 8601 字符串，原样保留，格式化见 `formatChatTime`）。 */
  updatedAt: string;
  /** 事件行数（不含 header）；非法/缺失回落 0。 */
  messageCount: number;
  /** 明文 `session.jsonl` 整文件的 sha256（P1 只展示不校验，校验属 `services/` 的活）。 */
  sha256: string;
  /** 会话种类；缺字段 / 未知值一律回落 `'cloud'`（只读默认，不改文件）。 */
  kind: ChatKind;
}

/** `parseChatIndex` 的结果：坏行只计数，不抛。 */
export interface ChatIndexParse {
  entries: ChatIndexEntry[];
  /** 坏行数（JSON 解析失败 / 不是对象 / 缺 `id` / op 行时间非法）。 */
  errors: number;
}

/**
 * mod-chat-hide：op 行的决胜标记。`(ts, seq)` 字典序比较；seq = 行号（1 起），同毫秒时定胜负。
 */
export interface ChatFoldMarker {
  ts: number;
  seq: number;
}

/** 每个 id 的隐藏状态；普通行**永不**触碰它（迟到的重导出行不能解除隐藏）。 */
export interface ChatFoldState {
  hidden: boolean;
  at: ChatFoldMarker;
}

/** `foldChatIndex` 的结果：正常列表只取 `entries`（已排除隐藏 id）。 */
export interface ChatIndexFold {
  entries: ChatIndexEntry[];
  /** 当前隐藏的 id（含只有隐藏行的 id）；本模块不提供任何恢复入口。 */
  hiddenIds: string[];
  errors: number;
}

/** `chats/<id>/meta.json` 里本页用得到的字段（其余字段忽略；文件由插件侧写）。 */
export interface ChatMeta {
  title?: string;
  updatedAt?: string;
  createdAt?: string;
  messageCount?: number;
  model?: string;
  deviceId?: string;
  workspaceName?: string;
}

// ---------------------------------------------------------------- 消息

/** 消息角色。`other` 兜住 `developer/message` 这类非对话消息，不丢内容也不假装是助手。 */
export type ChatRole = 'user' | 'assistant' | 'tool' | 'system' | 'other';

/** 一条可读消息。 */
export interface ChatMessage {
  role: ChatRole;
  /** 可读文本：正文，或工具调用的一行摘要（`🔧 <name>`）。 */
  text: string;
  /** 事件时间（ISO 8601，UTC；解析不到时为空串）。 */
  at: string;
  /** 仅 `role === 'tool'` 时有值：工具名（页面据此做等宽灰字，不再解析参数）。 */
  toolName?: string;
}

/** `toMessages` 的结果：跳过多少行一并给出（页面可用来提示「部分事件不展示」）。 */
export interface ChatMessageParse {
  messages: ChatMessage[];
  /** 被跳过的行数（坏 JSON + 不展示的事件类型 + 内容为空的消息）。 */
  skipped: number;
}

// ---------------------------------------------------------------- 内部：原始行形状

/** index.jsonl 的一行（只声明本模块读的键）。 */
interface RawIndexLine {
  id?: string;
  title?: string;
  updatedAt?: string;
  messageCount?: number;
  sha256?: string;
  /** additive 字段：存储侧可能写 `chat`（§3），读侧归一为 `cloud`。 */
  kind?: string;
  /** mod-chat-hide：隐藏 / 恢复行；本模块只产生 archive，unarchive 只读兼容。 */
  op?: string;
  deletedAt?: number;
  ts?: number;
}

/** 隐藏行的 id 白名单（与 `chatStore.isSafeChatId` 同口径），坏 id 只让该行失效。 */
const HIDE_ID_PATTERN: RegExp = /^[A-Za-z0-9._-]+$/;

/** 消息内容数组里的一段（只有 `text` 段会被读，图片等其它段直接跳过）。 */
interface ChatPart {
  type?: string;
  text?: string;
}

/** 嵌套的 message 对象（`assistant/message.data.message`）。 */
interface ChatMessagePayload {
  role?: string;
  content?: string | ChatPart[] | null;
}

/** 事件行的 `data`（只声明本模块读的键）。 */
interface ChatEventData {
  content?: string | ChatPart[] | null;
  message?: ChatMessagePayload | null;
  name?: string;
  callId?: string;
  title?: string;
}

/** 事件行（`{type,seq,time,data,...}`）。 */
interface ChatEvent {
  type?: string;
  seq?: number;
  time?: number;
  data?: ChatEventData | null;
}

/** 稳定排序的装饰项（`index` 是输入下标，用来在同值时保持原顺序）。 */
interface SortEntry {
  entry: ChatIndexEntry;
  index: number;
  /** updatedAt 的毫秒值（解析不到 = -1，排最后）。 */
  key: number;
  /** 小写标题（排序键）。 */
  text: string;
}

/** 标题缺失时的兜底（与 `model/query.ts` 的空标题口径一致：不留空行）。 */
const UNTITLED: string = '未命名会话';

/** 时间未知时的摘要前缀（不显示「Invalid Date」之类机器味文案）。 */
const UNKNOWN_TIME: string = '时间未知';

/** 工具调用摘要前缀（详情页据此识别「这是工具行」的视觉标记）。 */
const TOOL_PREFIX: string = '🔧 ';

/** 数字兜底：非有限数字 / 负数 → 0（`messageCount` 只用于展示，不必区分「缺」与「0」）。 */
function countOf(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.floor(value);
}

/** 两位补零（日期格式化用）。 */
function pad2(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

/** 文本归一：统一换行、去掉首尾空白（**不改中间内容**，会话正文要原样可读）。 */
function normalizeText(text: string): string {
  if (typeof text !== 'string' || text.length === 0) {
    return '';
  }
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

/** 标题归一：非空字符串直接用；否则回落「未命名会话」（列表行不能没有字）。 */
function normalizeTitle(value: string | undefined): string {
  if (typeof value === 'string') {
    const text: string = value.trim();
    if (text.length > 0) {
      return text;
    }
  }
  return UNTITLED;
}

/**
 * 种类归一（**纯读侧**，绝不写回文件）：
 * - `dots`（忽略大小写与首尾空白）→ `'dots'`；
 * - 缺字段 / 空串 / `chat` / 任何未知值 → `'cloud'`。
 *
 * 历史索引行没有 `kind`，设计稿存储侧用 `chat` 表示纯云端对话；两种都归到 `'cloud'`，
 * 这样分段切换不会因为一条脏数据把会话藏起来（fail-open 到默认段，而不是丢行）。
 */
function normalizeChatKind(value: string | undefined): ChatKind {
  if (typeof value === 'string' && value.trim().toLowerCase() === 'dots') {
    return 'dots';
  }
  return 'cloud';
}

/** 按行切分 JSONL（空串 → 空数组；不做 trim，交给调用方逐行处理）。 */
function splitJsonl(text: string): string[] {
  if (typeof text !== 'string' || text.length === 0) {
    return [];
  }
  return text.split('\n');
}

/** ISO 字符串 → 毫秒（解析不到返回 -1）。 */
function timeValue(iso: string): number {
  if (typeof iso !== 'string' || iso.length === 0) {
    return -1;
  }
  const millis: number = Date.parse(iso);
  if (!Number.isFinite(millis)) {
    return -1;
  }
  return millis;
}

/** 小写化（非字符串 → 空串；`filterChats` / `sortChats` 共用）。 */
function lowerOf(text: string): string {
  return typeof text === 'string' ? text.toLowerCase() : '';
}

/**
 * 事件时间（Unix 毫秒）→ ISO 8601（UTC）。
 *
 * 存机器可读值而不是「HH:MM」：详情页当前不展示时间（省空间），但保留原始时间便于以后加
 * 「按天分组」，也避免在纯逻辑层引入时区换算（跨机时区不同会让排序与展示不一致）。
 */
function isoAt(time: number | undefined): string {
  if (typeof time !== 'number' || !Number.isFinite(time) || time <= 0) {
    return '';
  }
  const date: Date = new Date(time);
  const millis: number = date.getTime();
  if (Number.isNaN(millis)) {
    return '';
  }
  return date.toISOString();
}

/** 内容字段 → 可读文本：**同时支持 string 与 `[{type:'text',text}]` 两种形态**。 */
function contentText(content: string | ChatPart[] | null | undefined): string {
  if (typeof content === 'string') {
    return normalizeText(content);
  }
  if (content === undefined || content === null) {
    return '';
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (let index = 0; index < content.length; index++) {
      const part: ChatPart | null = content[index];
      if (part === null) {
        continue;
      }
      const text: string = typeof part.text === 'string' ? part.text : '';
      if (text.length === 0) {
        continue;
      }
      parts.push(text);
    }
    return normalizeText(parts.join('\n'));
  }
  return '';
}

/** 助手类消息取文本：优先 `data.message.content`，再回落 `data.content`。 */
function messageText(data: ChatEventData | null): string {
  if (data === null) {
    return '';
  }
  const message: ChatMessagePayload | null = data.message === undefined ? null : data.message;
  if (message !== null) {
    const inner: string = contentText(message.content);
    if (inner.length > 0) {
      return inner;
    }
  }
  return contentText(data.content);
}

// ---------------------------------------------------------------- 列表：解析 / 排序 / 过滤

/**
 * 折叠 `chats/index.jsonl`（mod-chat-hide，`docs/CHAT-DELETE-DESIGN.md` §11.3 / §12）。
 *
 * 全函数：任意行序列都有确定结果，坏行只计数、绝不抛。
 * 1. 普通行：同 id 取最后一行（行序即追加序），**只更新内容投影、永不改变 hidden**；
 * 2. `op:"archive"`（带 `deletedAt` 毫秒）：`(ts,seq)` 严格新于当前标记才隐藏；
 * 3. `op:"unarchive"`（带 `ts`，格式兼容、本模块不产生）：严格更新才恢复可见；
 * 4. 坏行 / 未知 op 只 `errors++`；返回顺序 = id 首次出现顺序（排序交给 `sortChats`）。
 */
export function foldChatIndex(jsonlText: unknown): ChatIndexFold {
  const text: string = typeof jsonlText === 'string' ? jsonlText : '';
  const byId: Map<string, ChatIndexEntry> = new Map<string, ChatIndexEntry>();
  const states: Map<string, ChatFoldState> = new Map<string, ChatFoldState>();
  const order: string[] = [];
  let errors: number = 0;
  const lines: string[] = splitJsonl(text);
  for (let index = 0; index < lines.length; index++) {
    const line: string = lines[index].trim();
    if (line.length === 0) {
      continue;
    }
    let raw: RawIndexLine | null = null;
    try {
      raw = JSON.parse(line) as RawIndexLine | null;
    } catch {
      errors++;
      continue;
    }
    if (raw === null || typeof raw !== 'object') {
      errors++;
      continue;
    }
    const id: string = typeof raw.id === 'string' ? raw.id.trim() : '';
    if (id.length === 0) {
      errors++;
      continue;
    }
    if (raw.op !== undefined) {
      const op: string = raw.op === 'archive' || raw.op === 'unarchive' ? raw.op : '';
      const rawMillis: number | undefined = op === 'archive'
        ? raw.deletedAt
        : (raw.ts !== undefined ? raw.ts : raw.deletedAt);
      const ts: number = typeof rawMillis === 'number' && Number.isFinite(rawMillis) &&
        Number.isInteger(rawMillis) && rawMillis >= 0 ? rawMillis : -1;
      const safeId: boolean = id.length <= 200 && id !== '.' && id !== '..' && HIDE_ID_PATTERN.test(id);
      if (op.length === 0 || !safeId || ts < 0) {
        errors++;
        continue;
      }
      const seq: number = index + 1;
      const current: ChatFoldState | undefined = states.get(id);
      const at: ChatFoldMarker = current === undefined ? { ts: -1, seq: -1 } : current.at;
      if (ts > at.ts || (ts === at.ts && seq > at.seq)) {
        states.set(id, { hidden: op === 'archive', at: { ts: ts, seq: seq } });
      }
      continue;
    }
    if (!byId.has(id)) {
      order.push(id);
    }
    const entry: ChatIndexEntry = {
      id: id,
      title: normalizeTitle(raw.title),
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt.trim() : '',
      messageCount: countOf(raw.messageCount),
      sha256: typeof raw.sha256 === 'string' ? raw.sha256.trim() : '',
      kind: normalizeChatKind(raw.kind)
    };
    // 后写覆盖：只追加文件里「最后一行」才是该 id 的最新内容投影；这里刻意不碰 states。
    byId.set(id, entry);
  }
  const entries: ChatIndexEntry[] = [];
  for (let index = 0; index < order.length; index++) {
    const state: ChatFoldState | undefined = states.get(order[index]);
    if (state !== undefined && state.hidden) {
      continue;
    }
    const entry: ChatIndexEntry | undefined = byId.get(order[index]);
    if (entry !== undefined) {
      entries.push(entry);
    }
  }
  const hiddenIds: string[] = [];
  states.forEach((state: ChatFoldState, id: string): void => {
    if (state.hidden) {
      hiddenIds.push(id);
    }
  });
  return { entries: entries, hiddenIds: hiddenIds, errors: errors };
}

/** 解析索引：只把可见条目交给列表页；隐藏判定收口在 `foldChatIndex`。 */
export function parseChatIndex(jsonlText: string): ChatIndexParse {
  const folded: ChatIndexFold = foldChatIndex(jsonlText);
  return { entries: folded.entries, errors: folded.errors };
}

/**
 * 排序（返回新数组，**不改入参**）。
 *
 * - `updated`（默认）：`updatedAt` 新的在前；时间相同 → 保持输入顺序（稳定）；
 *   无法解析的时间排最后（`-1`），不因为一条坏数据把整个列表打乱；
 * - `title`：小写标题字典序；标题相同 → 保持输入顺序。
 *
 * 稳定性由装饰项里的 `index` 显式保证（不依赖引擎的 `Array#sort` 是否稳定）。
 */
export function sortChats(entries: ChatIndexEntry[], mode: 'updated' | 'title'): ChatIndexEntry[] {
  const list: ChatIndexEntry[] = Array.isArray(entries) ? entries : [];
  const keyed: SortEntry[] = [];
  for (let index = 0; index < list.length; index++) {
    const entry: ChatIndexEntry | null = list[index];
    if (entry === null) {
      continue;
    }
    keyed.push({
      entry: entry,
      index: index,
      key: timeValue(entry.updatedAt),
      text: lowerOf(entry.title)
    });
  }
  const byTitle: boolean = mode === 'title';
  keyed.sort((left: SortEntry, right: SortEntry): number => {
    if (byTitle) {
      if (left.text < right.text) {
        return -1;
      }
      if (left.text > right.text) {
        return 1;
      }
      return left.index - right.index;
    }
    if (left.key !== right.key) {
      // 新的在前：key 大的先出
      return right.key - left.key;
    }
    return left.index - right.index;
  });
  const sorted: ChatIndexEntry[] = [];
  for (let index = 0; index < keyed.length; index++) {
    sorted.push(keyed[index].entry);
  }
  return sorted;
}

/**
 * 标题子串过滤（大小写不敏感，**只匹配标题**，与列表行展示的信息一致）。
 *
 * 空查询（或全空白）→ 返回全部（返回副本，调用方可以放心改）。
 */
export function filterChats(entries: ChatIndexEntry[], query: string): ChatIndexEntry[] {
  const list: ChatIndexEntry[] = Array.isArray(entries) ? entries : [];
  const needle: string = typeof query === 'string' ? query.trim().toLowerCase() : '';
  if (needle.length === 0) {
    return list.slice();
  }
  const matched: ChatIndexEntry[] = [];
  for (let index = 0; index < list.length; index++) {
    const entry: ChatIndexEntry | null = list[index];
    if (entry === null) {
      continue;
    }
    if (lowerOf(entry.title).indexOf(needle) >= 0) {
      matched.push(entry);
    }
  }
  return matched;
}

/**
 * 分段过滤：只保留 `kind` 等于给定值的会话（返回副本，不改入参）。
 *
 * 与 `filterChats` 正交：页面先按 `kind` 切段，再按搜索词过滤，两段共用同一份 `chats`
 * （切换不丢数据）。脏输入返回空数组，不抛。
 */
export function filterByKind(entries: ChatIndexEntry[], kind: ChatKind): ChatIndexEntry[] {
  const list: ChatIndexEntry[] = Array.isArray(entries) ? entries : [];
  const matched: ChatIndexEntry[] = [];
  for (let index = 0; index < list.length; index++) {
    const entry: ChatIndexEntry | null = list[index];
    if (entry !== null && entry.kind === kind) {
      matched.push(entry);
    }
  }
  return matched;
}

// ---------------------------------------------------------------- 会话 preset（云端对话准入）

/** session.jsonl 里只声明 preset 投影要用的键；其它行内容一概不读。 */
interface SessionPresetLine {
  type?: string;
  agentPreset?: string;
  data?: { agentPreset?: string } | null;
}

/** 只有字面量 `'chat'` 算 chat：大小写 / 空白 / 别名都不放宽。 */
function presetOf(value: unknown): ChatSessionPreset {
  return value === 'chat' ? 'chat' : 'other';
}

/**
 * 从 `chats/<id>/session.jsonl` **原文**投影最终 agentPreset（纯函数、坏行跳过、不抛）。
 *
 * 与 DSH 的 `agentPreset` 投影同口径：header 首行的 `agentPreset` 给初值，
 * 后续 `agent-preset/selected` 事件按顺序覆盖；缺 header / 值非法 / 空输入 → `other`。
 * 这是判定「是不是云端对话」的**唯一**来源；`chats/index.jsonl` 与 `meta.json` 都没有这个字段。
 */
export function sessionPresetOf(sessionJsonl: string): ChatSessionPreset {
  const text: string = typeof sessionJsonl === 'string' ? sessionJsonl : '';
  let current: ChatSessionPreset = 'other';
  let sawHeader: boolean = false;
  const lines: string[] = splitJsonl(text);
  for (let index = 0; index < lines.length; index++) {
    const line: string = lines[index].trim();
    if (line.length === 0) {
      continue;
    }
    let raw: SessionPresetLine | null = null;
    try {
      raw = JSON.parse(line) as SessionPresetLine | null;
    } catch {
      continue;
    }
    if (raw === null || typeof raw !== 'object') {
      continue;
    }
    if (raw.type === 'session') {
      sawHeader = true;
      current = presetOf(raw.agentPreset);
      continue;
    }
    if (raw.type === 'agent-preset/selected') {
      const data: { agentPreset?: string } | null =
        raw.data === undefined ? null : raw.data;
      current = presetOf(data === null ? undefined : data.agentPreset);
    }
  }
  return sawHeader ? current : 'other';
}

/**
 * allow-list：只保留 preset 恰好为 `chat` 的条目；缺映射 / `other` / 未知 id 一律丢弃。
 * 工作会话即使被误写进索引也不会渲染，因此没有可点的行、也就没有可隐藏的目标。
 */
export function filterChatPreset(
  entries: ChatIndexEntry[],
  presetById: Record<string, ChatSessionPreset>
): ChatIndexEntry[] {
  const list: ChatIndexEntry[] = Array.isArray(entries) ? entries : [];
  const presets: Record<string, ChatSessionPreset> =
    presetById === null || presetById === undefined ? {} : presetById;
  const kept: ChatIndexEntry[] = [];
  for (let index = 0; index < list.length; index++) {
    const entry: ChatIndexEntry | null = list[index];
    if (entry === null || entry === undefined) {
      continue;
    }
    if (presets[entry.id] === 'chat') {
      kept.push(entry);
    }
  }
  return kept;
}

// ---------------------------------------------------------------- 详情：事件流 → 消息

/**
 * 明文事件流 → 可读消息列表。
 *
 * 支持的内容形态（`docs/RESEARCH-session-import.md` §3.2 实测）：
 * 1. `content` 是 **string**（旧版本 / 单段文本）；
 * 2. `content` 是 **数组** `[{type:'text',text:'…'}, …]`（当前版本；只拼 `text` 段，图片段跳过）。
 *
 * 工具调用只留一行 `🔧 <name>`：参数与结果里常含绝对路径、命令输出、大段文件内容，
 * 列表/详情页把它们铺开会淹没对话本身（脱敏是上传侧的责任，见 `docs/CHAT-SYNC.md` §7）。
 */
export function toMessages(jsonlText: string): ChatMessageParse {
  const messages: ChatMessage[] = [];
  let skipped: number = 0;
  const lines: string[] = splitJsonl(jsonlText);
  for (let index = 0; index < lines.length; index++) {
    const line: string = lines[index].trim();
    if (line.length === 0) {
      continue;
    }
    let raw: ChatEvent | null = null;
    try {
      raw = JSON.parse(line) as ChatEvent | null;
    } catch {
      skipped++;
      continue;
    }
    if (raw === null || typeof raw !== 'object') {
      skipped++;
      continue;
    }
    const type: string = typeof raw.type === 'string' ? raw.type : '';
    const data: ChatEventData | null = raw.data === undefined ? null : raw.data;
    const at: string = isoAt(raw.time);

    if (type === 'user/message') {
      const text: string = contentText(data === null ? null : data.content);
      if (text.length === 0) {
        skipped++;
        continue;
      }
      messages.push({ role: 'user', text: text, at: at });
      continue;
    }

    if (type === 'assistant/message') {
      const text: string = messageText(data);
      if (text.length === 0) {
        skipped++;
        continue;
      }
      messages.push({ role: 'assistant', text: text, at: at });
      continue;
    }

    if (type === 'tool/call') {
      const rawName: string = data !== null && typeof data.name === 'string' ? data.name.trim() : '';
      const name: string = rawName.length > 0 ? rawName : '未知工具';
      messages.push({ role: 'tool', text: TOOL_PREFIX + name, at: at, toolName: name });
      continue;
    }

    if (type === 'system/message') {
      const text: string = messageText(data);
      if (text.length === 0) {
        skipped++;
        continue;
      }
      messages.push({ role: 'system', text: text, at: at });
      continue;
    }

    // 兜底：`developer/message` 等其它 `*​/message` 事件有正文就展示，不假装是助手消息
    if (type.endsWith('/message')) {
      const text: string = messageText(data);
      if (text.length === 0) {
        skipped++;
        continue;
      }
      messages.push({ role: 'other', text: text, at: at });
      continue;
    }

    // usage / status / tool/result / turn/* / step/* / header 等：不展示
    skipped++;
  }
  return { messages: messages, skipped: skipped };
}

// ---------------------------------------------------------------- 展示文案

/**
 * 时间展示：`YYYY-MM-DD HH:MM`。
 *
 * 两种输入形态（插件侧 `packages/dsh-dots/src/chats/exportChats.ts` 用
 * `new Date().toISOString()` 写 `updatedAt`，所以线上数据几乎都是第一种）：
 * - **带时区标记**（`Z` 或 `±HH:MM`）→ 这是一个真实时刻，**换算到本机时区**再展示。
 *   不换算的话东八区用户会看到比实际早 8 小时的时间（会话是「刚导出的」，一眼就错）；
 * - **不带时区标记**（`2026-11-18T14:03`）→ 视为「记录者本地墙钟」，原样展示
 *   （与 `common/date.ts` 的 `formatClock` 对日程 `ts` 的口径一致）。
 *
 * 解析不到返回空串（调用方决定显示「时间未知」还是干脆不显示）。
 */
export function formatChatTime(iso: string): string {
  const text: string = typeof iso === 'string' ? iso.trim() : '';
  if (text.length === 0) {
    return '';
  }
  const wall: RegExpExecArray | null = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})/.exec(text);
  const wallText: string = wall === null ? '' : `${wall[1]} ${wall[2]}:${wall[3]}`;
  // 末尾是 Z / +08:00 / -0500 → 带时区标记，需要换算到本机时区
  const zoned: boolean = /(?:Z|[+-]\d{2}:?\d{2})$/.test(text);
  if (!zoned && wallText.length > 0) {
    return wallText;
  }
  const millis: number = Date.parse(text);
  if (!Number.isFinite(millis)) {
    // 带时区标记却解析不了：能取到墙钟就退回墙钟，否则空串
    return wallText;
  }
  const date: Date = new Date(millis);
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  );
}

/**
 * 列表行的第二行：`2026-11-18 14:03 · 42 条消息`。
 *
 * 时间缺失 → `时间未知`；`messageCount` 非法 → `0 条消息`（**不会**出现 NaN / undefined）。
 */
export function chatSummaryLine(entry: ChatIndexEntry): string {
  let time: string = '';
  let count: number = 0;
  try {
    time = formatChatTime(entry.updatedAt);
    count = countOf(entry.messageCount);
  } catch {
    time = '';
    count = 0;
  }
  const clock: string = time.length > 0 ? time : UNKNOWN_TIME;
  return `${clock} · ${count} 条消息`;
}
