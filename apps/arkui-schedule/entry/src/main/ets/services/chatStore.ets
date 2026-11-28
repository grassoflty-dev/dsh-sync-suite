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
 * 三条约定（读取路径仍是只读；唯一写口见 `hideChat`）：
 * 1. **空态不是错误**：`chats/index.jsonl` 不存在 → `{ok:true, entries: []}`，
 *    页面据此显示「还没有云端会话」+ 操作指引（§2.4：允许缺省，插件还没导出过就是这样）；
 * 2. 所有 IO 都 `try/catch`，**绝不把异常抛给页面**：最坏情况返回 `{ok:false, reason}`；
 * 3. 复用 `GitSyncService` 的目录约定（`<filesDir>/git-repo`），**不修改它**：
 *    这里不调 `getRepoRoot()`（那个方法会 `mkdirp`，属于写副作用），只拼路径 + 读文件。
 *
 * mod-app-chat-hide 的**唯一**写口是 `hideChat(id)`：只向 `chats/index.jsonl` 追加一条墓碑行，
 * 经窄写通道 commit/push；`chats/<id>/**` 全层只读，无恢复 / 无批量 / 无载荷删除。
 * 隐藏状态不缓存在本层，列表永远以索引折叠结果为真相（失败不留乐观隐藏）。
 *
 * 云端准入（mod-app-three-kind）：`listChats` 只返回 `agentPreset` 投影为 `chat` / `dots` 的
 * 两种云端会话（读 `chats/<id>/session.jsonl`，缺字段 / 读不到 / standard 一律 fail-closed
 * 不渲染）；分段只认准入时派生的 preset，不认 `chats/index.jsonl` 的 `kind` —— 索引与投影
 * 冲突时投影胜出。`hideChat` 在写前复核 preset 判据，工作会话既没有可点的行也无法被隐藏。
 * 平板只读取与隐藏，没有创建会话的入口。
 *
 * 为什么不用 `router` 参数直接传会话内容：参数是字符串表，长会话会被截断/超限；
 * 详情页只接 `id`，每次重新读文件（旋转、返回都靠 `@State` 保内容，见页面注释）。
 */
import { fileIo as fs } from '@kit.CoreFileKit';
import { common } from '@kit.AbilityKit';
import { filterChatPreset, parseChatIndex, sessionPresetOf, toMessages } from '../model/chatList';
import type {
  ChatIndexEntry, ChatIndexParse, ChatMessage, ChatMessageParse, ChatMeta, ChatSessionPreset
} from '../model/chatList';
// mod-app-chat-hide：写侧只复用 chatHide 的纯逻辑（确认文案 / 行形状 / 只追加 / 四阶段原因），
// 不在此处重写折叠，也不产生任何 unarchive 行。
import {
  appendHideLine, decideHideReconcile, hasHideLine, hideCommitMessageOf, hideLineOf, hideReasonOf, isHideId,
  HIDE_INDEX_PATH
} from '../model/chatHide';
import type { HideReconcileDecision, HideStage } from '../model/chatHide';
import { isPushStage } from '../model/gitCommitLock';
import { bridgeGitRunner } from './gitRunner';

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

/**
 * `hideChat` 的结果：`stage` 记停在哪个阶段（`done` = 四步全过）；
 * `reason` 成功为空串，失败时是 `chatHide.ts` 四句 typed 中文原因之一（不夹带原始错误）。
 */
export interface HideOutcome {
  ok: boolean;
  stage: string;
  reason: string;
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
   * 会话是哪种云端会话：只读 `chats/<id>/session.jsonl` 的 `agentPreset` 投影
   * （纯逻辑在 `model/chatList.sessionPresetOf`，`chat` / `dots` 为云端，其余 → `other`）。
   * 读不到 / 缺 header / standard / 未知 → `other`，fail-closed：
   * 绝不按标题 / 工作区 / index 的 kind 猜。
   */
  private readSessionPreset(id: string): ChatSessionPreset {
    if (!isSafeChatId(id)) {
      return 'other';
    }
    const dir: string = this.chatsDir();
    if (dir.length === 0) {
      return 'other';
    }
    const path: string = `${dir}/${id}/${SESSION_FILE_NAME}`;
    if (!this.fileExists(path)) {
      return 'other';
    }
    try {
      return sessionPresetOf(fs.readTextSync(path));
    } catch (error) {
      return 'other';
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
      // 云端准入：只渲染投影为 chat / dots 的会话；工作会话即使在索引里（哪怕 kind 写成 dots）也不可见。
      const presets: Record<string, ChatSessionPreset> = {};
      for (let index = 0; index < parsed.entries.length; index++) {
        const entry: ChatIndexEntry = parsed.entries[index];
        presets[entry.id] = this.readSessionPreset(entry.id);
      }
      const result: ChatListResult = { ok: true, entries: filterChatPreset(parsed.entries, presets) };
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

  // ------------------------------------------------------------ mod-app-chat-hide 窄写通道

  /** 四阶段失败结果：只返回 typed 中文原因，绝不把桥的原始错误 / 路径 / 令牌带到界面。 */
  private hideFailure(stage: HideStage): HideOutcome {
    return { ok: false, stage: stage, reason: hideReasonOf(stage) };
  }

  /**
   * tmp 写 + 回读 + rename：写失败时**旧索引字节原样保留**，不会出现半行 / 乐观隐藏。
   * tmp 落在 `chats/` 根且不在上传白名单里（只认 `chats/index.jsonl`），不会被误提交。
   */
  private writeHideText(path: string, text: string): void {
    const tmp: string = `${path}.tmp-hide-${Date.now()}`;
    let file: fs.File | null = null;
    try {
      file = fs.openSync(tmp, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
      fs.writeSync(file.fd, text);
    } catch (error) {
      throw new Error('E_HIDE_WRITE: 隐藏行临时文件写入失败');
    } finally {
      if (file !== null) {
        fs.closeSync(file);
      }
    }
    if (fs.readTextSync(tmp) !== text) {
      throw new Error('E_HIDE_WRITE: 隐藏行临时文件回读不一致，现场保留');
    }
    fs.renameSync(tmp, path);
  }

  /**
   * 隐藏**一条**会话（id 是单个字符串，没有批量 / 多 id 入口）：
   * ① prepare：id 合法 + 仓库目录可定位 + `chats/index.jsonl` 存在且可读；
   * ② write：`hideLineOf` 生成一行 → `appendHideLine` 只追加 → tmp 写 / 回读 / rename；
   * ③ commit：`chats: delete <id>` + v2 尾注，仅提交 `chats/index.jsonl` 一个路径；
   * ④ push：`pushMain()`，不 force、不 reset。
   * 任何阶段失败即停并给出对应中文原因；本方法**不缓存隐藏状态**，页面每次从索引重读。
   * 不写 `chats/<id>/**`，不产出 `unarchive`，不删除载荷，不改写历史。
   */
  async hideChat(id: string): Promise<HideOutcome> {
    try {
      const safeId: string = typeof id === 'string' ? id.trim() : '';
      if (!isHideId(safeId)) {
        return this.hideFailure('prepare');
      }
      // 工作种类（other）没有行可点；两种云端种类（chat / dots）都可隐藏。
      const preset: ChatSessionPreset = this.readSessionPreset(safeId);
      if (preset !== 'chat' && preset !== 'dots') {
        return this.hideFailure('prepare');
      }
      const dir: string = this.chatsDir();
      if (dir.length === 0) {
        return this.hideFailure('prepare');
      }
      const path: string = `${dir}/${INDEX_FILE_NAME}`;
      if (!this.fileExists(path)) {
        return this.hideFailure('prepare');
      }
      let oldText: string = '';
      try {
        oldText = fs.readTextSync(path);
      } catch (error) {
        return this.hideFailure('prepare');
      }
      const line: string = hideLineOf(safeId, Date.now());
      if (line.length === 0) {
        return this.hideFailure('prepare');
      }
      const nextText: string = appendHideLine(oldText, line);
      if (!nextText.startsWith(oldText) || nextText.length <= oldText.length) {
        return this.hideFailure('write');
      }
      try {
        this.writeHideText(path, nextText);
      } catch (error) {
        return this.hideFailure('write');
      }
      const message: string = hideCommitMessageOf(safeId);
      if (message.length === 0) {
        return this.hideFailure('commit');
      }
      // mod-app-git-commit-atomic：隐藏行的 add → commit → push 与同步周期共用同一把闸，
      // 否则两个写口的 addPaths 会互相覆盖 runner 单例的 pendingPaths。
      // mod-app-hide-commit-reconcile（本模块）：闸只解决了「缓冲竞态」，没解决「发现竞态」——
      // 隐藏行在拿闸之前已经落盘，同步周期的 stagePaths 又总是含 chats/index.jsonl，
      // 所以周期完全可能在它自己的 `[v2] sync N days` 提交里把这一行带走，甚至已经推送。
      // 因此闸内先用只读的 HEAD/关系事实做三态对账（model/chatHide.decideHideReconcile），
      // 再决定「不再写 / 只推送 / 照旧 add→commit→push」；stage 只在真正发起写口后推进，
      // 原来的「提交失败 / 推送失败」两阶段原因与成功文案都不变，不新增会话发布尾注。
      let stage: 'commit' | 'push' = 'commit';
      try {
        await bridgeGitRunner.withWriteLock(async (): Promise<void> => {
          // HEAD 首次隐藏时可能根本没有该文件 / 没有提交；窄捕获按「未提交」处理，
          // 绝不让异常冒到外层 catch 被误判成 prepare（那也会是一次假失败）。
          let headText: string = '';
          try {
            headText = await bridgeGitRunner.showHead(HIDE_INDEX_PATH);
          } catch (error) {
            headText = '';
          }
          let relation: string = 'diverged';
          if (hasHideLine(headText, line)) {
            // 只有隐藏行**整行**确实在 HEAD 时才需要问远端关系；gate 与 decideHideReconcile
            // 共用 model/chatHide.hasHideLine 这一个判据，子串包含不算命中，避免无关的更长行
            // 白白发一次只读的关系请求。关系读失败按「未推送」处理（fail-safe：真去 push，
            // 让 push 的真实成败说话，而不是凭空报成功）。
            try {
              relation = await bridgeGitRunner.headRelation();
            } catch (error) {
              relation = 'diverged';
            }
          }
          const decision: HideReconcileDecision = decideHideReconcile(headText, line, relation);
          if (decision === 'done') {
            // (a) 周期已提交并推送：隐藏已落地，直接成功，不碰任何写口、不造新失败文案。
            return;
          }
          if (decision === 'push') {
            // (b) 本地已提交但未到 origin/main：只补一次推送；stage 推进保证失败归 push 原因。
            stage = 'push';
            await bridgeGitRunner.pushMain();
            return;
          }
          // (c) / 常规路径：隐藏行还没进任何提交，按原顺序 add → commit → push。
          await bridgeGitRunner.addPaths([HIDE_INDEX_PATH]);
          await bridgeGitRunner.commit(message);
          stage = 'push';
          await bridgeGitRunner.pushMain();
        });
      } catch (error) {
        // 经 helper 读取 stage：参数位置保留联合类型，既不触发 ArkTS 窄化误报，
        // 也不把 stage 放宽成 string；两个阶段的字面量原因各自保留。
        if (isPushStage(stage)) {
          return this.hideFailure('push');
        }
        return this.hideFailure('commit');
      }
      const done: HideOutcome = { ok: true, stage: 'done', reason: '' };
      return done;
    } catch (error) {
      // 兜底：服务层对页面永不抛；意外异常按 prepare 处理（未推进任何阶段）。
      return this.hideFailure('prepare');
    }
  }
}

/** App 级单例（列表页与详情页共用；只持有 filesDir，不缓存会话内容）。 */
export const chatStore: ChatStore = new ChatStore();
