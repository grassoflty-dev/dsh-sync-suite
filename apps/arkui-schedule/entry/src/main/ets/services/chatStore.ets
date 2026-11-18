/**
 * 云端对话（只读）存储层：读**同步仓库工作副本**里的 `chats/**`。
 *
 * 目录事实（`docs/CHAT-SYNC.md` §2）：
 * ```
 * <filesDir>/git-repo/            ← 与 GitSyncService.getRepoRoot() 同一个工作副本
 *   chats/index.jsonl             ← 只追加的列表投影
 *   chats/<id>/meta.json          ← 元信息 + 租约（本层只读，不校验租约）
 *   chats/<id>/session.jsonl      ← 明文事件流
 * ```
 *
 * 三条约定（P1 只读，**一个字节都不写**）：
 * 1. **空态不是错误**：`chats/index.jsonl` 不存在 → `{ok:true, entries: []}`，
 *    页面据此显示「还没有云端会话」+ 操作指引（§2.4：允许缺省，插件还没导出过就是这样）；
 * 2. 所有 IO 都 `try/catch`，**绝不把异常抛给页面**：最坏情况返回 `{ok:false, reason}`；
 * 3. 只读复用 `GitSyncService` 的目录约定（`<filesDir>/git-repo`），**不修改它**：
 *    这里不调 `getRepoRoot()`（那个方法会 `mkdirp`，属于写副作用），只拼路径 + 读文件。
 *
 * 为什么不用 `router` 参数直接传会话内容：参数是字符串表，长会话会被截断/超限；
 * 详情页只接 `id`，每次重新读文件（旋转、返回都靠 `@State` 保内容，见页面注释）。
 */
import { fileIo as fs } from '@kit.CoreFileKit';
import { common } from '@kit.AbilityKit';
import { parseChatIndex, toMessages } from '../model/chatList';
import type { ChatIndexEntry, ChatIndexParse, ChatMessage, ChatMessageParse, ChatMeta } from '../model/chatList';

const REPO_DIR_NAME: string = 'git-repo';
const CHATS_DIR_NAME: string = 'chats';
const INDEX_FILE_NAME: string = 'index.jsonl';
const META_FILE_NAME: string = 'meta.json';
const SESSION_FILE_NAME: string = 'session.jsonl';

/** 缺文件 / 坏 JSON 的统一原因（详情页直接展示这一句，不再拼技术细节）。 */
const REASON_INCOMPLETE: string = '会话文件不完整';
/** 索引文件存在但读不出来（权限 / IO 错误）。 */
const REASON_INDEX: string = '读取会话索引失败';
/** 会话 id 不合法（防止拼出跨目录路径）。 */
const REASON_BAD_ID: string = '会话 ID 不合法';

/**
 * 会话 id 白名单：`^[A-Za-z0-9._-]+$`，长度 ≤ 200，且不能是 `.` / `..`。
 *
 * 与插件侧写盘时的校验（`packages/dsh-dots/src/chats/exportChats.ts`
 * 的 `assertSafeSessionId`：`^[A-Za-z0-9._-]+$`、≤200、非 `.`/`..`）**完全一致**——
 * 读侧比写侧更严会让「列表里有、点开说 ID 不合法」。正则里没有 `/` 与 `\`，
 * 所以拼出来的路径永远落在 `chats/` 下（不越界）。
 */
const ID_PATTERN: RegExp = /^[A-Za-z0-9._-]+$/;
const ID_MAX_LENGTH: number = 200;

/** `listChats` 的结果（`ok:false` 时 `entries` 为空数组，页面只需看 `reason`）。 */
export interface ChatListResult {
  ok: boolean;
  entries: ChatIndexEntry[];
  reason?: string;
}

/** `loadChat` 的结果（失败时不带 `messages`，页面只显示 `reason` + 重试）。 */
export interface ChatDetailResult {
  ok: boolean;
  meta?: ChatMeta;
  messages?: ChatMessage[];
  reason?: string;
}

/** 会话 id 是否可用作目录名（纯字符串判定，不碰磁盘）。 */
export function isSafeChatId(value: string): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  const text: string = value.trim();
  if (text.length === 0 || text.length > ID_MAX_LENGTH) {
    return false;
  }
  if (text === '.' || text === '..') {
    return false;
  }
  return ID_PATTERN.test(text);
}

export class ChatStore {
  /** 应用文件目录（页面 `aboutToAppear` 用 `context.filesDir` 预置；未预置时自己 `getContext()`）。 */
  private filesDir: string = '';

  /** 预置 filesDir（幂等；由页面传入，避免服务层依赖页面生命周期）。 */
  prepare(context: object): void {
    try {
      const abilityContext: common.UIAbilityContext = context as common.UIAbilityContext;
      const dir: string = abilityContext.filesDir;
      if (typeof dir === 'string' && dir.length > 0) {
        this.filesDir = dir.replace(/\\/g, '/');
      }
    } catch (error) {
      // 拿不到 context 时保持原值：`repoRoot()` 会再试一次 getContext()（永不抛给页面）
    }
  }

  /** 是否已经拿到应用文件目录（页面据此决定要不要提示「存储未就绪」）。 */
  isReady(): boolean {
    return this.filesDir.length > 0 || this.repoRoot().length > 0;
  }

  /** 仓库工作副本根：`<filesDir>/git-repo`；拿不到 filesDir 时返回空串（后续一切当「无数据」）。 */
  private repoRoot(): string {
    if (this.filesDir.length === 0) {
      try {
        const context: common.UIAbilityContext = getContext() as common.UIAbilityContext;
        const dir: string = context.filesDir;
        if (typeof dir === 'string' && dir.length > 0) {
          this.filesDir = dir.replace(/\\/g, '/');
        }
      } catch (error) {
        this.filesDir = '';
      }
    }
    if (this.filesDir.length === 0) {
      return '';
    }
    return `${this.filesDir}/${REPO_DIR_NAME}`;
  }

  /** `chats/` 目录（不创建；不存在时读操作会自然得到「空态」）。 */
  chatsDir(): string {
    const root: string = this.repoRoot();
    return root.length > 0 ? `${root}/${CHATS_DIR_NAME}` : '';
  }

  /** 文件是否存在（`fs.accessSync` 对不存在返回 false / 抛异常，都归一成 false）。 */
  private fileExists(path: string): boolean {
    if (path.length === 0) {
      return false;
    }
    try {
      return fs.accessSync(path);
    } catch (error) {
      return false;
    }
  }

  /**
   * 列出云端会话（只读 `chats/index.jsonl`）。
   *
   * - 文件不存在 → `{ok:true, entries: []}`（**空态**，页面给操作指引）；
   * - 文件存在但读失败 / 目录拿不到 → `{ok:false, reason}`（页面给「重试」）；
   * - 坏行由纯函数 `parseChatIndex` 计数丢弃，不影响其它行。
   */
  async listChats(): Promise<ChatListResult> {
    try {
      const dir: string = this.chatsDir();
      if (dir.length === 0) {
        const empty: ChatListResult = { ok: true, entries: [] };
        return empty;
      }
      const path: string = `${dir}/${INDEX_FILE_NAME}`;
      if (!this.fileExists(path)) {
        // 空态不是错误：插件还没导出过 / 本机还没拉取过仓库
        const empty: ChatListResult = { ok: true, entries: [] };
        return empty;
      }
      let text: string = '';
      try {
        text = fs.readTextSync(path);
      } catch (error) {
        const failed: ChatListResult = { ok: false, entries: [], reason: REASON_INDEX };
        return failed;
      }
      const parsed: ChatIndexParse = parseChatIndex(text);
      const result: ChatListResult = { ok: true, entries: parsed.entries };
      return result;
    } catch (error) {
      const failed: ChatListResult = { ok: false, entries: [], reason: REASON_INDEX };
      return failed;
    }
  }

  /**
   * 读一个会话：`meta.json` + `session.jsonl` → 纯函数 `toMessages`。
   *
   * 任一文件缺失 / 任一 JSON 坏掉 → `{ok:false, reason:'会话文件不完整'}`（P1 不做「半个会话」
   * 的降级展示：用户看到的必须是一份完整的历史，缺一半比空着更容易误导）。
   */
  async loadChat(id: string): Promise<ChatDetailResult> {
    try {
      const safeId: string = typeof id === 'string' ? id.trim() : '';
      if (!isSafeChatId(safeId)) {
        const bad: ChatDetailResult = { ok: false, reason: REASON_BAD_ID };
        return bad;
      }
      const dir: string = this.chatsDir();
      if (dir.length === 0) {
        const missing: ChatDetailResult = { ok: false, reason: REASON_INCOMPLETE };
        return missing;
      }
      const chatDir: string = `${dir}/${safeId}`;
      const metaPath: string = `${chatDir}/${META_FILE_NAME}`;
      const sessionPath: string = `${chatDir}/${SESSION_FILE_NAME}`;
      if (!this.fileExists(metaPath) || !this.fileExists(sessionPath)) {
        const missing: ChatDetailResult = { ok: false, reason: REASON_INCOMPLETE };
        return missing;
      }
      let metaText: string = '';
      let sessionText: string = '';
      try {
        metaText = fs.readTextSync(metaPath);
        sessionText = fs.readTextSync(sessionPath);
      } catch (error) {
        const unreadable: ChatDetailResult = { ok: false, reason: REASON_INCOMPLETE };
        return unreadable;
      }
      let meta: ChatMeta | null = null;
      try {
        meta = JSON.parse(metaText) as ChatMeta | null;
      } catch (error) {
        const badMeta: ChatDetailResult = { ok: false, reason: REASON_INCOMPLETE };
        return badMeta;
      }
      if (meta === null || typeof meta !== 'object') {
        const badMeta: ChatDetailResult = { ok: false, reason: REASON_INCOMPLETE };
        return badMeta;
      }
      const parsed: ChatMessageParse = toMessages(sessionText);
      const result: ChatDetailResult = { ok: true, meta: meta, messages: parsed.messages };
      return result;
    } catch (error) {
      const failed: ChatDetailResult = { ok: false, reason: REASON_INCOMPLETE };
      return failed;
    }
  }
}

/** App 级单例（列表页与详情页共用；只持有 filesDir，不缓存会话内容）。 */
export const chatStore: ChatStore = new ChatStore();
