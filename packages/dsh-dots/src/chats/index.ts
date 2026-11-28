/**
 * 云端对话模式 P1（插件侧）的**唯一入口**：`src/chats/` 对 RPC 层只暴露这里的函数与类型。
 *
 * 分工：
 *   - `readSessions.ts`：本机 zstd 帧 → 明文行（纯逻辑 + 解帧）；
 *   - `exportChats.ts`：明文 → `{meta, jsonl}`（隐私过滤）→ 落盘/提交/推送；
 *   - 本文件：把两者编排成 RPC 需要的三种结果（status / all / one），
 *     并保证**任何失败都不抛到 RPC 之外**（逐会话记原因，push 失败只降级整体 ok）。
 */
import path from 'node:path'
import {
  AUTO_EXPORT_PHASE_TIMEOUT_MS,
  CHAT_EXPORT_PER_RUN_CAP,
  ChatExportError,
  chatPayloadExists,
  indexEntryOf,
  isPublishablePresetHeader,
  isValidChatIndexLine,
  readChatIndex,
  readHiddenChatIds,
  sanitizeChatReason,
  shouldExportChat,
  uploadChats,
  writeChatExportPayloads,
} from './exportChats.js'
import type { BuildChatExportOptions, ChatExportGateDecision, UploadChatsOptions } from './exportChats.js'
import { buildChatExport } from './exportChats.js'
import { listLocalSessions, readSessionEvents } from './readSessions.js'
import type {
  ChatExport,
  ChatExportItemResult,
  ChatExportOutcome,
  ChatExportStatus,
  ChatGitRepoLike,
  ChatIndexSnapshot,
  ChatSessionSource,
  LocalSessionInfo,
} from './types.js'

export * from './types.js'
export {
  AUTO_EXPORT_PHASE_TIMEOUT_MS,
  CHATS_DIR,
  CHAT_EXPORT_PER_RUN_CAP,
  CHAT_SCHEMA_VERSION,
  ChatExportError,
  INDEX_FILE_NAME,
  META_JSON_NAME,
  PUBLISHABLE_PRESET_IDS,
  REDACTED_PATH,
  SESSION_JSONL_NAME,
  buildChatExport,
  chatPayloadExists,
  indexEntryOf,
  isPublishablePresetHeader,
  isValidChatIndexLine,
  readChatIndex,
  readHiddenChatIds,
  recordedSha256Of,
  redactSecrets,
  sanitizeChatReason,
  scanForLeaks,
  scrubAbsolutePaths,
  scrubAbsolutePathsDeep,
  shouldExportChat,
  uploadChats,
  workspaceNameOf,
  writeChatExportPayloads,
} from './exportChats.js'
export type { BuildChatExportOptions, ChatExportGateDecision, UploadChatsOptions } from './exportChats.js'
export { foldChatIndex } from './foldChatIndex.js'
export type { ChatFoldMarker, ChatFoldState, ChatIndexFold } from './foldChatIndex.js'
export {
  SESSION_FILE_NAME,
  classifyEvents,
  countMessages,
  eventText,
  firstUserTextOf,
  frameByteLength,
  latestTitleOf,
  listLocalSessions,
  modelOf,
  readSessionEvents,
  resolveSessionsRoot,
  splitZstdFrames,
} from './readSessions.js'

/** `chatExportAll` 的默认上限：一次推爆远端仓库没有意义（每会话最多几 MB 明文）。 */
export const DEFAULT_EXPORT_LIMIT = 50
/** 硬上限：即使调用方传了更大的值也不越过（防止一次上传把工作副本/网络打满）。 */
export const MAX_EXPORT_LIMIT = 200

export interface ChatExportStatusOptions {
  /** 本地工作副本根（`work/<repoHash>`）；仓库未配置时给空串即可。 */
  workDir?: string
  homeDir?: string
  sessionsRoot?: string
}

/**
 * `chatExportStatus` 的实现。**绝不联网**：只扫本机会话目录 + 读工作副本里的 `chats/index.jsonl`。
 *
 * `pending` 是「本机有、index 里没有」的会话数；`exported` 是 index 里不同 id 的个数。
 */
export async function readChatExportStatus(options: ChatExportStatusOptions = {}): Promise<ChatExportStatus> {
  const local = await listLocalSessions({
    ...(options.sessionsRoot !== undefined ? { sessionsRoot: options.sessionsRoot } : {}),
    ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
  })
  const workDir = typeof options.workDir === 'string' ? options.workDir : ''
  const snapshot = workDir === '' ? null : await readChatIndex(workDir)
  const exportedIds = new Set<string>((snapshot?.entries ?? []).map((entry) => entry.id))
  // 隐藏会话不再提示"待导出"：源 zstd 还在，但导出器会按隐藏集合跳过它。
  const hiddenIds = workDir === '' ? new Set<string>() : await readHiddenChatIds(workDir)
  let pending = 0
  for (const session of local) {
    if (!exportedIds.has(session.sessionId) && !hiddenIds.has(session.sessionId)) pending += 1
  }
  return {
    localSessions: local.length,
    exported: snapshot?.exported ?? 0,
    lastExportAt: snapshot?.lastExportAt ?? '',
    pending,
  }
}

export interface ExportChatsToRepoOptions {
  repo: ChatGitRepoLike
  /** 写进 `meta.deviceId`；必须匹配 `^[a-z0-9][a-z0-9-]{0,31}$`。 */
  deviceId: string
  homeDir?: string
  sessionsRoot?: string
  /** 指定会话（`chatExportOne`）；给了就不按 `limit` 遍历。 */
  sessionIds?: string[]
  /** 最多导出多少个会话（按 mtime 降序取最近的）；缺省 `DEFAULT_EXPORT_LIMIT`。 */
  limit?: number
  now?: () => Date
  /** 是否 push；默认 true。 */
  push?: boolean
}

/** 把 limit 归一：非正数/非数字 → 默认 50；超过硬上限 → 200。 */
export function normalizeLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return DEFAULT_EXPORT_LIMIT
  return Math.min(Math.floor(value), MAX_EXPORT_LIMIT)
}

function readFailureReason(error: unknown): string {
  if (error instanceof ChatExportError) return error.code
  const message = sanitizeChatReason(error)
  return message === '' ? 'read-failed' : `read-failed: ${message}`
}

/**
 * 导出（构建 + 写盘 + 提交 + 推送）并返回逐会话结果。
 *
 * 关键语义：
 *   - **单个会话的读取/构建失败不抛**：只在 `results[]` 里记 `ok:false` + 原因码；
 *   - 写盘成功但 push 失败：`ok` 仍为 true（本地已落盘，可重试），
 *     `summary`/`reason` 里带整体失败原因；
 *   - 一个会话都没有可导出时 `pushed:false`，但不算失败（`ok:0 / failed:0`）。
 */
export async function exportChatsToRepo(options: ExportChatsToRepoOptions): Promise<ChatExportOutcome> {
  const limit = normalizeLimit(options.limit)
  const results: ChatExportItemResult[] = []
  const pendingExports: ChatExport[] = []

  const local = await listLocalSessions({
    ...(options.sessionsRoot !== undefined ? { sessionsRoot: options.sessionsRoot } : {}),
    ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
  })
  const byId = new Map<string, LocalSessionInfo>()
  for (const session of local) byId.set(session.sessionId, session)

  // 纵深第 1 层（选中前过滤）：隐藏会话既不构建也不上传，源 zstd 留着但绝不重新发布。
  const hiddenIds = await readHiddenChatIds(options.repo.dir)

  let selected: LocalSessionInfo[] = []
  if (Array.isArray(options.sessionIds) && options.sessionIds.length > 0) {
    for (const requested of options.sessionIds) {
      const id = typeof requested === 'string' ? requested.trim() : ''
      if (id === '') {
        results.push({ id: '', ok: false, reason: 'bad-session-id' })
        continue
      }
      if (hiddenIds.has(id)) {
        results.push({ id, ok: false, reason: 'deleted' })
        continue
      }
      const found = byId.get(id)
      if (found === undefined) {
        results.push({ id, ok: false, reason: 'not-found' })
        continue
      }
      selected.push(found)
    }
  } else {
    selected = local.filter((session) => !hiddenIds.has(session.sessionId)).slice(0, limit)
    for (const session of local) {
      if (hiddenIds.has(session.sessionId)) {
        results.push({ id: session.sessionId, ok: false, reason: 'deleted' })
      }
    }
  }

  const buildOptions: BuildChatExportOptions = {
    deviceId: options.deviceId,
    ...(options.now !== undefined ? { now: options.now() } : {}),
  }

  for (const info of selected) {
    try {
      const session = await readSessionEvents(info.file)
      const built = buildChatExport(info, session, buildOptions)
      pendingExports.push(built)
    } catch (error) {
      results.push({ id: info.sessionId, ok: false, reason: readFailureReason(error) })
    }
  }

  let pushed = false
  let failureReason: string | undefined
  if (pendingExports.length > 0) {
    const uploadOptions: UploadChatsOptions = options.push === false ? { push: false } : {}
    const uploaded = await uploadChats(options.repo, pendingExports, uploadOptions)
    pushed = uploaded.pushed
    const writtenIds = new Set(uploaded.sessionIds)
    for (const item of pendingExports) {
      if (writtenIds.has(item.id)) results.push({ id: item.id, ok: true })
      else results.push({ id: item.id, ok: false, reason: uploaded.reason ?? 'write-failed' })
    }
    if (!uploaded.ok) failureReason = uploaded.reason ?? 'upload-failed'
  }

  const ok = results.filter((item) => item.ok).length
  const outcome: ChatExportOutcome = {
    results,
    summary: { total: results.length, ok, failed: results.length - ok, limit },
    pushed,
  }
  if (failureReason !== undefined) outcome.reason = failureReason
  return outcome
}

/** 供 RPC 层拼工作副本路径（`work/<repoHash>/chats`）时复用。 */
export function chatsDirOf(workDir: string): string {
  return path.join(workDir, 'chats')
}

/* -------------------------------------------------------------------------- */
/* mod-plugin-chat-export-auto：有界、幂等的候选选择                            */
/* -------------------------------------------------------------------------- */

export interface SelectAutoExportOptions {
  /** 本机规范会话（readSessions 可见 888 个，全是 work）。 */
  local: LocalSessionInfo[]
  hiddenIds: Set<string>
  /** 隐藏感知折叠后的索引快照；op 行不会折成 sha256:''。 */
  index: ChatIndexSnapshot
  workDir: string
  deviceId: string
  now?: Date
  /** 注入单调时钟（测试用）；缺省 `Date.now`。 */
  nowMs?: () => number
  /**
   * 注入会话读取（测试用）：生产缺省 `readSessionEvents`，测试可给纯假读数，
   * 从而在不构造 888 个 zstd 文件的前提下证明「work 会话一个都不导出」。
   */
  readEvents?: (file: string) => Promise<ChatSessionSource>
  /** 覆盖安全上限；最终仍夹到 `CHAT_EXPORT_PER_RUN_CAP`，调用方传更大值无效。 */
  limit?: number
}

export interface AutoExportSelection {
  /** 门控放行、待写盘的会话（≤ CHAT_EXPORT_PER_RUN_CAP）。 */
  exports: ChatExport[]
  /** 每个待写会话的门控结论（修复场景据此追加原 sha 行）。 */
  decisions: Map<string, ChatExportGateDecision>
  considered: number
  /** preset 不在 {'chat','dots'} 白名单里的 work 会话数（永不发布）。 */
  skippedWork: number
  /** 通过白名单的会话数（含零轮：刚创建的 chat / dots 会话也要发布）。 */
  eligible: number
  skippedUnchanged: number
  skippedHidden: number
  /** `truncated-session` fail-closed 跳过的个数；其余会话继续。 */
  truncated: number
  /** 其它读/构建失败的个数。 */
  failures: number
  /** 是否撞到阶段时间上限；撞到则只在会话边界停下。 */
  timedOut: boolean
  /** 已识别为可发布但因时间上限 / 安全上限未发布的个数。 */
  remaining: number
}

/**
 * 白名单选择（产品裁决）：**不按时间、不按数量挑会话，也不按轮次挑**。
 * `header.agentPreset` 命中 `{'chat','dots'}` 才进入 sha256 门控；`standard` / null / 缺失 /
 * 非字符串 / 未知 id 一律是 work、永不发布（本机 888 个规范会话全是 work ⇒ 今天发布 0 个）。
 * 零轮的 chat / dots 会话**照常发布**：用户刚建好就应出现在平板；残余风险是它尚未被
 * `agentPresets.select` 锁定（只有产生过一轮的会话才锁定），本模块只读 header、从不改 preset。
 * `CHAT_EXPORT_PER_RUN_CAP = 50` 只是安全天花板，不是候选窗口，今天不可达。
 *
 * 时间上限 `AUTO_EXPORT_PHASE_TIMEOUT_MS` 只在会话边界检查：触顶时保留已构建的会话，
 * 剩余交给下一轮门控自然接上；本函数绝不起定时器、绝不重试。
 */
export async function selectAutoExportCandidates(
  options: SelectAutoExportOptions,
): Promise<AutoExportSelection> {
  const requested = typeof options.limit === 'number' && Number.isFinite(options.limit)
    ? Math.floor(options.limit)
    : CHAT_EXPORT_PER_RUN_CAP
  const cap = Math.max(0, Math.min(requested, CHAT_EXPORT_PER_RUN_CAP))
  const clock = typeof options.nowMs === 'function' ? options.nowMs : Date.now
  const startedAt = clock()
  const selection: AutoExportSelection = {
    exports: [], decisions: new Map(), considered: 0, skippedWork: 0,
    eligible: 0, skippedUnchanged: 0, skippedHidden: 0, truncated: 0, failures: 0,
    timedOut: false, remaining: 0,
  }
  const buildOptions: BuildChatExportOptions = {
    deviceId: options.deviceId,
    ...(options.now !== undefined ? { now: options.now } : {}),
  }

  for (const info of options.local) {
    if (selection.exports.length >= cap) break
    // 时间上限：只在会话边界停，绝不写到一半。
    if (clock() - startedAt >= AUTO_EXPORT_PHASE_TIMEOUT_MS) {
      selection.timedOut = true
      break
    }
    selection.considered += 1
    if (options.hiddenIds.has(info.sessionId)) {
      selection.skippedHidden += 1
      continue
    }
    try {
      const events = await (options.readEvents ?? readSessionEvents)(info.file)
      // 第一道 allow-list：只在会话首行 header 上做 preset 全等，不猜路径/标题。
      // work 会话连 buildChatExport 都不调用；零轮的 chat / dots 会话照常进入门控。
      if (!isPublishablePresetHeader(events.header)) {
        selection.skippedWork += 1
        continue
      }
      selection.eligible += 1
      const built = buildChatExport(info, events, buildOptions)
      const entry = indexEntryOf(options.index, built.id)
      const exists = await chatPayloadExists(options.workDir, built.id)
      // 第二道 allow-list：变更门控在 exportChats.ts 里用同一个谓词再验一次这份 header。
      const decision = shouldExportChat(built, entry, exists, events.header)
      if (decision.action === 'skip') {
        selection.skippedUnchanged += 1
        continue
      }
      selection.exports.push(built)
      selection.decisions.set(built.id, decision)
    } catch (error) {
      // 截断会话 fail-closed 跳过（truncated-session 已在 exportChats.ts 定义），其余继续。
      if (error instanceof ChatExportError && error.code === 'truncated-session') selection.truncated += 1
      else selection.failures += 1
    }
  }
  selection.remaining = Math.max(0, selection.eligible - selection.exports.length)
  return selection
}
