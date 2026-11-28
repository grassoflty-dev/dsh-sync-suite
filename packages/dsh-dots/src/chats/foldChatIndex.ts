/**
 * `chats/index.jsonl` 的隐藏折叠（mod-chat-hide，设计 `docs/CHAT-DELETE-DESIGN.md` §11.3 / §12）。
 *
 * 这是**全函数**：任意行序列都给出确定结果，坏行只计数，绝不抛异常。
 * 两级规则（不要改成"全体行按时间 LWW"）：
 *   1. 普通行 `{id,title,updatedAt,messageCount,sha256}` **只更新内容投影，永不改变 hidden**；
 *      所以一条迟到的重导出行不会让隐藏静默失效（§11.4 / §12.2）。
 *   2. `op:"archive"` 带 `deletedAt`（毫秒）与 `op:"unarchive"` 带 `ts`（兼容未来模块，本模块不写）
 *      之间按 `(ts, seq)` 严格单调决胜；seq = 行号（1 起），用于同一毫秒的确定性决胜。
 *
 * 隐藏只活在这一行里：载荷文件、meta.json 与历史都不动（§11.1）。
 */
import type { ChatIndexEntry } from './types.js'

/** 隐藏行 / 恢复行的 op 字面量；`unarchive` 只读不写。 */
export const ARCHIVE_OP = 'archive'
export const UNARCHIVE_OP = 'unarchive'

/** 一条 op 行的决胜标记；比较顺序是 ts 先、seq 后。 */
export interface ChatFoldMarker {
  ts: number
  seq: number
}

/** 每个 id 的折叠状态；普通行永不触碰它。 */
export interface ChatFoldState {
  hidden: boolean
  at: ChatFoldMarker
}

/** `foldChatIndex` 的结果：只读投影 + 隐藏集合 + 可审计计数。 */
export interface ChatIndexFold {
  /** 正常列表投影：**只含 hidden=false 的条目**，顺序 = 各 id 首次出现顺序。 */
  entries: ChatIndexEntry[]
  /** 当前隐藏的 id（含只有隐藏行、没有普通行的 id）；顺序不承诺。 */
  hiddenIds: string[]
  /** 每个 id 的最新状态（含 `at`，便于测试断言同毫秒决胜）。 */
  states: Map<string, ChatFoldState>
  /** 坏行数：JSON 解析失败 / 缺 id / op 行时间非法 / 未知 op。 */
  badLines: number
  /** 所有可见条目里最大的 `updatedAt`；没有则空串。 */
  lastExportAt: string
}

const SAFE_ID = /^[A-Za-z0-9._-]+$/

/** op 行的 id 才走白名单（与 `assertSafeSessionId` 同口径）；普通行保持历史兼容（非空即可）。 */
function safeIdOf(value: unknown): string {
  if (typeof value !== 'string') return ''
  const id = value.trim()
  if (id === '' || id.length > 200 || id === '.' || id === '..' || !SAFE_ID.test(id)) return ''
  return id
}

/** 毫秒时间戳：只认非负整数；坏值让该 op 行失效（只计数、不改状态）。 */
function opMillisOf(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null
  return value
}

/** `(ts, seq)` 严格新于 `at`？同毫秒时行号大的胜出。 */
function isNewer(marker: ChatFoldMarker, at: ChatFoldMarker): boolean {
  return marker.ts > at.ts || (marker.ts === at.ts && marker.seq > at.seq)
}

/**
 * 按文件顺序折叠 `chats/index.jsonl`。
 *
 * - 普通行：同 id 取最后一行（沿用既有"展示投影取最新"语义），但**不动 hidden**；
 * - archive：若 `(deletedAt, seq)` 严格新于当前 `at` ⇒ hidden=true，记录该标记；
 * - unarchive：若 `(ts, seq)`（缺 ts 时回落 deletedAt）严格新于当前 `at` ⇒ hidden=false；
 * - 坏行 / 未知 op：只 `badLines++`，状态与投影都不变。
 */
export function foldChatIndex(jsonlText: unknown): ChatIndexFold {
  const text: string = typeof jsonlText === 'string' ? jsonlText : ''
  const byId = new Map<string, ChatIndexEntry>()
  const states = new Map<string, ChatFoldState>()
  const order: string[] = []
  let badLines = 0
  let lastExportAt = ''

  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index]!.trim()
    if (trimmed === '') continue

    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      badLines += 1
      continue
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      badLines += 1
      continue
    }
    const record = parsed as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    if (id === '') {
      badLines += 1
      continue
    }

    if (record.op !== undefined) {
      const op = record.op === ARCHIVE_OP || record.op === UNARCHIVE_OP ? record.op : ''
      const safe = safeIdOf(id)
      // 兼容格式定义里 unarchive 用 ts；也接受 deletedAt，避免未来模块两种写法分裂。
      const rawMillis = op === ARCHIVE_OP
        ? record.deletedAt
        : (record.ts !== undefined ? record.ts : record.deletedAt)
      const ts = opMillisOf(rawMillis)
      if (op === '' || safe === '' || ts === null) {
        badLines += 1
        continue
      }
      const seq = index + 1
      const current = states.get(safe) ?? { hidden: false, at: { ts: -1, seq: -1 } }
      if (isNewer({ ts, seq }, current.at)) {
        states.set(safe, { hidden: op === ARCHIVE_OP, at: { ts, seq } })
      }
      continue
    }

    // 普通行：只更新内容投影。注意这里刻意不碰 states。
    if (!byId.has(id)) order.push(id)
    const entry: ChatIndexEntry = {
      id,
      title: typeof record.title === 'string' ? record.title : '',
      updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
      messageCount: typeof record.messageCount === 'number' ? record.messageCount : 0,
      sha256: typeof record.sha256 === 'string' ? record.sha256 : '',
    }
    byId.set(id, entry)
    if (entry.updatedAt > lastExportAt) lastExportAt = entry.updatedAt
  }

  const entries: ChatIndexEntry[] = []
  for (const id of order) {
    if (states.get(id)?.hidden === true) continue
    entries.push(byId.get(id)!)
  }
  const hiddenIds: string[] = []
  for (const [id, state] of states) {
    if (state.hidden) hiddenIds.push(id)
  }
  return { entries, hiddenIds, states, badLines, lastExportAt }
}
