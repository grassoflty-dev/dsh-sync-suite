/**
 * 云端对话模式 P1（插件侧）的**类型契约**，不含任何副作用。
 *
 * 事实来源（不要在这里自由发挥）：
 *   - `docs/CHAT-SYNC.md` §2：`chats/<sessionId>/{meta.json,session.jsonl}` + `chats/index.jsonl`，
 *     `meta.json` 字段白名单、只追加语义、禁绝对路径；
 *   - `docs/RESEARCH-session-import.md`（下称 RSI）§2：`session.v4.jsonl.zstd` 是**裸 zstd 帧串联**，
 *     `zlib.zstdDecompressSync` 只解第一帧，必须自己按帧切；§3：header 行 `type:"session"`、
 *     事件行 `{type,seq,time,data}`。
 *
 * 本文件的类型只描述「插件读到的本机事实」与「要写进共享仓库的投影」；不含任何绝对路径字段。
 */

/** 本机一个会话文件：`<sessionsRoot>/<slug>/<sessionId>/session.v4.jsonl.zstd`。 */
export interface LocalSessionInfo {
  /** DSH header 会在 `session` 事件里给出同一个 id（本字段取自目录名，二者应相等）。 */
  sessionId: string
  /** `projectKey(cwd)`，即 `--C-Users-GWL-Desktop-proj--` 这种目录名。 */
  slug: string
  /** 会话文件的绝对路径。**只在插件内部使用**，绝不进 `meta.json`、绝不进日志/错误消息。 */
  file: string
  bytes: number
  /** 文件 mtime（Unix 毫秒）。 */
  mtime: number
}

/** DSH header 行（`type:"session"`）。其余字段按 RSI §3.1 是可选/版本相关，这里不锁定。 */
export interface SessionHeader {
  type: 'session'
  version?: number
  id?: string
  createdAt?: number
  cwd?: string
  title?: string
  [key: string]: unknown
}

/** 事件行：`{type,seq,time,data,?surfaceOp,?sourceEventSeqs}`。 */
export type SessionEvent = Record<string, unknown>

/** 一个 zstd 帧在 buffer 里的切片（`offset` 指向 magic）。 */
export interface ZstdFrame {
  offset: number
  length: number
  /** `offset + length`，便于直接 `buffer.subarray`。 */
  end: number
}

/** `splitZstdFrames` 的返回：纯数据，可离线断言。 */
export interface ZstdFrameScan {
  frames: ZstdFrame[]
  /** 尾部帧头/帧体不完整，或完整帧之后出现非 magic 字节（数据到此为止）。 */
  truncated: boolean
  /** 第一个 magic 之前被跳过的垃圾字节数。 */
  garbageBytes: number
  /** 没有被任何完整帧覆盖的尾部字节数（= `buffer.length - 最后一个完整帧的 end`）。 */
  remainderBytes: number
}

/** `classifyEvents` 的结果：把「明文行」分类成 header / 事件 / 坏行。 */
export interface ClassifiedEvents {
  /** 第一条 `type === 'session'` 的行；没有则为 null。 */
  header: SessionHeader | null
  /** header 的行号（1 起）；没有则为 -1。 */
  headerLine: number
  /** 解析成功且 `type` 非空的事件行（保持行序，不含 header）。 */
  events: SessionEvent[]
  /** 不是合法 JSON / 不是对象 / 没有 `type` 的行数。 */
  badLines: number
  /** 坏行的行号（1 起），最多保留前 20 个（防止病态文件把内存撑爆）。 */
  badLineNumbers: number[]
  /** `type → 出现次数`，便于排障（不含任何正文）。 */
  types: Record<string, number>
}

/** `readSessionEvents` 的返回：解帧 + 行分类的完整事实。 */
export interface SessionReadResult {
  header: SessionHeader | null
  events: SessionEvent[]
  /** 解码后的**完整明文**，行序原样，末尾保证有且只有一个 `\n`（空会话为空串）。 */
  rawJsonl: string
  /** 解码后的原始行（含坏行），供排障使用。 */
  lines: string[]
  badLines: number
  badLineNumbers: number[]
  /** 帧被截断 / 解压失败 / 末行没有换行（尾撕裂）。 */
  truncated: boolean
  /** 成功解压的帧数。 */
  frameCount: number
}

/**
 * `buildChatExport` 的输入：只要「header + 事件 + 明文」这三件事，
 * 因此 `SessionReadResult` 天然满足它（测试也可以直接构造）。
 */
export interface ChatSessionSource {
  header: SessionHeader | null
  events: SessionEvent[]
  rawJsonl: string
  /** 坏行数；>0 时 fail-closed（不导出）。 */
  badLines?: number
  /** 帧截断 / 尾撕裂；true 时 fail-closed。 */
  truncated?: boolean
}

/** `chats/<id>/meta.json`（字段严格按 `docs/CHAT-SYNC.md` §2.1）。 */
export interface ChatExportMeta {
  schemaVersion: 1
  sessionId: string
  title: string
  /** 首次上传时间（ISO）；同一 id 二次导出时**保留旧值**。 */
  createdAt: string
  /** 本次成功写入时间（ISO）。 */
  updatedAt: string
  /** 最后使用的 `provider/model`；解不出来时**整个字段省略**。 */
  model?: string
  /** user + assistant 消息数（列表页摘要用）。 */
  messageCount: number
  /** 明文 `session.jsonl` 整文件字节的 sha256（乐观锁与完整性锚点）。 */
  sha256: string
  deviceId: string
  /** workspace 的**末段名**，绝不写整条路径。 */
  workspaceName: string
  /** 被 `<redacted-path>` 替换的字符串个数（隐私自检用）。 */
  redactions: number
  /** P1 不租约：显式写 null（`docs/CHAT-SYNC.md` §2.2 允许省略或 null）。 */
  lease: null
}

/** `buildChatExport` 的返回。 */
export interface ChatExport {
  /** 仓库内相对目录，posix 分隔符：`chats/<sessionId>`。 */
  dir: string
  /** 与目录名一致；等于 header 的 `id`（缺失时退化为目录名）。 */
  id: string
  meta: ChatExportMeta
  /** 已脱敏、逐行校验过的明文 JSONL（LF 结尾）。 */
  jsonl: string
}

/** `chats/index.jsonl` 的一行（`docs/CHAT-SYNC.md` §2.4：只追加的展示投影）。 */
export interface ChatIndexEntry {
  id: string
  title: string
  updatedAt: string
  messageCount: number
  sha256: string
}

/** `readChatIndex` 的返回：按 id 取最新一行后的投影。 */
export interface ChatIndexSnapshot {
  /** 按 id 折叠后的条目（顺序 = 各 id 首次出现顺序）。 */
  entries: ChatIndexEntry[]
  /** 不同的 id 个数（= 已导出的会话数）。 */
  exported: number
  /** 所有条目里最大的 `updatedAt`；没有则空串。 */
  lastExportAt: string
  /** 解析失败的行数（坏行不影响其它行）。 */
  badLines: number
}

/**
 * `uploadChats` 只需要 GitRepo 的三个能力。
 *
 * 用接口而不是 `GitRepo` 类型，是为了让测试能注入一个「push 必抛」的假仓库，
 * 同时不把 `src/chats/**` 和 `src/engine/git.ts` 的实现细节绑死。
 * 真实的 `GitRepo`（`src/engine/git.ts`）结构上满足它。
 */
export interface ChatGitRepoLike {
  /** 工作副本根目录（`work/<repoHash>`）。 */
  dir: string
  /** 可选：确保工作副本已 clone。 */
  ensureWorkTree?(): Promise<{ cloned: boolean }>
  /** 只把 `chats/` 加进提交（`onlyPath`），message 形如 `chats: export <id> (n msgs)`。 */
  commitAll(message: string, options?: { onlyPath?: string }): Promise<{ commit: string; files: string[] }>
  /** 推送；非快进由实现自行处理（本插件永不 force）。 */
  pushWithRebase(): Promise<{ pushed: boolean; rebased: boolean }>
}

/** `uploadChats` 的返回。**push 失败不抛异常**：`{ok:false, reason}` 且本地文件保留。 */
export interface ChatUploadResult {
  ok: boolean
  /** 失败原因（已脱敏：无正文、无 token、无绝对路径）。 */
  reason?: string
  /** 已写入本地工作副本的会话 id。 */
  sessionIds: string[]
  /** 每个会话各自的提交。 */
  commits: Array<{ id: string; commit: string }>
  /** 是否真的推送成功（无会话可写时为 false）。 */
  pushed: boolean
}

/** 逐会话结果（`chatExportAll` / `chatExportOne` 的 `results[]`）。 */
export interface ChatExportItemResult {
  id: string
  ok: boolean
  /** 失败原因码 + 细节（**不含正文/路径/token**）。 */
  reason?: string
}

/** `chatExportStatus` 的返回。 */
export interface ChatExportStatus {
  /** 本机会话文件个数。 */
  localSessions: number
  /** `chats/index.jsonl` 里不同 id 的个数。 */
  exported: number
  /** 最近一次写入时间（ISO）；没有导出过为空串。 */
  lastExportAt: string
  /** 本机有、`chats/` 里没有（或 index 落后）的会话个数。 */
  pending: number
}

/** `exportChatsToRepo` 的返回：逐会话结果 + 汇总。 */
export interface ChatExportOutcome {
  results: ChatExportItemResult[]
  summary: {
    /** 本次考虑的会话数（受 limit 限制）。 */
    total: number
    /** 构建 + 写盘成功的会话数。 */
    ok: number
    failed: number
    /** 生效的 limit。 */
    limit: number
  }
  /** 是否推送成功（0 个会话可写时恒为 false）。 */
  pushed: boolean
  /** 整体失败原因（push 失败 / 工作副本不可用），已脱敏。 */
  reason?: string
}

/** 会话导出失败的错误码（机器可读，App 侧可做本地化映射）。 */
export type ChatExportErrorCode =
  | 'empty-session'
  | 'bad-jsonl'
  | 'truncated-session'
  | 'missing-header'
  | 'bad-session-id'
  | 'path-leak'
  // mod-chat-hide：会话已隐藏，导出器按隐藏集合跳过（不是失败，但结果里必须如实记原因）。
  | 'deleted'
