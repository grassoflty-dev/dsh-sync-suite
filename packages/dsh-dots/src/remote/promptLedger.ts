/**
 * mod-plugin-session-prompt：requestId 幂等账本（纯编解码 + 注入路径的单键 store）。
 *
 * 键是 (sessionId, requestId)，**不是**全局 requestId：同一条 id 在不同会话里各算一次。
 * 窗口判定本身是纯函数（`seenInWindow`），由 gate 用注入的 nowMs 调用；store 只负责落盘。
 *
 * 零 console；坏信封 ⇒ 空表 + typed problem（不抛给 load/record 的调用方）；
 * 原子写 = 临时文件 + rename，POSIX 0600。测试路径全部注入到包内 `.tmp/`。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** 一条已见 requestId（会话内局部）。 */
export interface SeenRequest {
  requestId: string
  atMs: number
}

/** gate 消费的只读视图：按 sessionId 分组。 */
export type PromptLedgerView = Readonly<Record<string, readonly SeenRequest[]>>

export type LedgerProblem =
  | 'E_LEDGER_SHAPE'
  | 'E_LEDGER_SESSION_ID'
  | 'E_LEDGER_REQUEST_ID'
  | 'E_LEDGER_AT_MS'
  | 'E_LEDGER_UNKNOWN_FIELD'
  | 'E_LEDGER_ENVELOPE_EMPTY'
  | 'E_LEDGER_ENVELOPE_JSON'
  | 'E_LEDGER_ENVELOPE_SHAPE'
  | 'E_LEDGER_ENVELOPE_VERSION'
  | 'E_LEDGER_ENVELOPE_ITEM'
  | 'E_LEDGER_STORAGE_UNAVAILABLE'

export function ledgerProblemText(problem: LedgerProblem): string {
  switch (problem) {
    case 'E_LEDGER_SHAPE': return '账本记录不是对象'
    case 'E_LEDGER_SESSION_ID': return '账本会话 id 不能为空'
    case 'E_LEDGER_REQUEST_ID': return '账本请求 id 不能为空'
    case 'E_LEDGER_AT_MS': return '账本记录时间必须是正整数时间戳'
    case 'E_LEDGER_UNKNOWN_FIELD': return '账本记录含未知字段，按损坏处理'
    case 'E_LEDGER_ENVELOPE_EMPTY': return '还没有保存过指令账本'
    case 'E_LEDGER_ENVELOPE_JSON': return '指令账本 JSON 损坏，已回落空表'
    case 'E_LEDGER_ENVELOPE_SHAPE': return '指令账本结构不正确，已回落空表'
    case 'E_LEDGER_ENVELOPE_VERSION': return '指令账本版本不认识，已回落空表'
    case 'E_LEDGER_ENVELOPE_ITEM': return '指令账本中有损坏的记录，已回落空表'
    case 'E_LEDGER_STORAGE_UNAVAILABLE': return '本地存储不可用，指令账本只在本次运行内有效'
    default: return ''
  }
}

export const LEDGER_ENVELOPE_VERSION = 1

export interface LedgerNormalizeResult {
  ok: boolean
  entry: SeenRequest | null
  sessionId: string
  problem: LedgerProblem | null
  reason: string
}

export interface LedgerDecodeResult {
  ok: boolean
  view: PromptLedgerView
  problem: LedgerProblem | null
  reason: string
}

interface LedgerEnvelope {
  v: number
  items: Array<SeenRequest & { sessionId: string }>
}

function readText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function validTime(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/** 严格归一一条记录；键白名单，未知字段即损坏（fail-closed）。 */
export function normalizeLedgerEntry(raw: unknown): LedgerNormalizeResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, entry: null, sessionId: '', problem: 'E_LEDGER_SHAPE', reason: ledgerProblemText('E_LEDGER_SHAPE') }
  }
  const item = raw as Record<string, unknown>
  for (const key of Object.keys(item)) {
    if (key !== 'sessionId' && key !== 'requestId' && key !== 'atMs') {
      return { ok: false, entry: null, sessionId: '', problem: 'E_LEDGER_UNKNOWN_FIELD', reason: ledgerProblemText('E_LEDGER_UNKNOWN_FIELD') }
    }
  }
  const sessionId = readText(item.sessionId)
  if (sessionId === '') return { ok: false, entry: null, sessionId: '', problem: 'E_LEDGER_SESSION_ID', reason: ledgerProblemText('E_LEDGER_SESSION_ID') }
  const requestId = readText(item.requestId)
  if (requestId === '') return { ok: false, entry: null, sessionId: '', problem: 'E_LEDGER_REQUEST_ID', reason: ledgerProblemText('E_LEDGER_REQUEST_ID') }
  const atMs = item.atMs
  if (!validTime(atMs) || typeof atMs !== 'number') {
    return { ok: false, entry: null, sessionId: '', problem: 'E_LEDGER_AT_MS', reason: ledgerProblemText('E_LEDGER_AT_MS') }
  }
  return {
    ok: true,
    entry: { requestId, atMs: Math.trunc(atMs) },
    sessionId,
    problem: null,
    reason: '',
  }
}

function fail(problem: LedgerProblem): LedgerDecodeResult {
  return { ok: false, view: {}, problem, reason: ledgerProblemText(problem) }
}

function flatten(view: PromptLedgerView): Array<SeenRequest & { sessionId: string }> {
  const items: Array<SeenRequest & { sessionId: string }> = []
  for (const sessionId of Object.keys(view).sort()) {
    for (const entry of view[sessionId] ?? []) {
      items.push({ sessionId, requestId: entry.requestId, atMs: entry.atMs })
    }
  }
  items.sort((a, b) => {
    if (a.sessionId < b.sessionId) return -1
    if (a.sessionId > b.sessionId) return 1
    if (a.atMs < b.atMs) return -1
    if (a.atMs > b.atMs) return 1
    if (a.requestId < b.requestId) return -1
    if (a.requestId > b.requestId) return 1
    return 0
  })
  return items
}

/** 固定键顺序 + 确定性排序的整表序列化。 */
export function encodeLedger(view: PromptLedgerView): string {
  const envelope: LedgerEnvelope = { v: LEDGER_ENVELOPE_VERSION, items: flatten(view) }
  return JSON.stringify(envelope)
}

/** 空串 / 坏 JSON / 错结构 / 错版本 / 任一坏记录 ⇒ 空表 + typed problem；不抛。 */
export function decodeLedger(raw: string | null | undefined): LedgerDecodeResult {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') return fail('E_LEDGER_ENVELOPE_EMPTY')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return fail('E_LEDGER_ENVELOPE_JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return fail('E_LEDGER_ENVELOPE_SHAPE')
  const envelope = parsed as Partial<LedgerEnvelope>
  if (typeof envelope.v !== 'number' || !Number.isFinite(envelope.v)) return fail('E_LEDGER_ENVELOPE_SHAPE')
  if (envelope.v !== LEDGER_ENVELOPE_VERSION) return fail('E_LEDGER_ENVELOPE_VERSION')
  if (!Array.isArray(envelope.items)) return fail('E_LEDGER_ENVELOPE_SHAPE')
  const view: Record<string, SeenRequest[]> = {}
  for (const rawItem of envelope.items as unknown[]) {
    const normalized = normalizeLedgerEntry(rawItem)
    if (!normalized.ok || normalized.entry === null) return fail('E_LEDGER_ENVELOPE_ITEM')
    const bucket = view[normalized.sessionId] ?? (view[normalized.sessionId] = [])
    if (!bucket.some((item) => item.requestId === normalized.entry!.requestId)) bucket.push(normalized.entry)
  }
  return { ok: true, view, problem: null, reason: '' }
}

/**
 * 纯判定：同一 sessionId 内 requestId 是否落在窗口里。
 * `nowMs - atMs < windowMs`：恰好等于窗口长度时视为已过期（可重试）；
 * 时钟回拨（atMs 在未来）按「仍在窗口内」处理（fail-closed，不重复写）。
 */
export function seenInWindow(
  view: PromptLedgerView,
  sessionId: string,
  requestId: string,
  nowMs: number,
  windowMs: number,
): boolean {
  if (!validTime(nowMs) || !validTime(windowMs)) return true
  const bucket = Object.prototype.hasOwnProperty.call(view, sessionId) ? view[sessionId] : undefined
  if (bucket === undefined) return false
  for (const entry of bucket) {
    if (entry.requestId === requestId && nowMs - entry.atMs < windowMs) return true
  }
  return false
}

/** 纯返回新视图（不改入参），记录 (sessionId, requestId) 的最新时刻。 */
export function recordSeen(view: PromptLedgerView, sessionId: string, requestId: string, atMs: number): PromptLedgerView {
  const next: Record<string, SeenRequest[]> = {}
  for (const key of Object.keys(view)) next[key] = (view[key] ?? []).map((item) => ({ ...item }))
  const bucket = next[sessionId] ?? (next[sessionId] = [])
  const at = Math.trunc(atMs)
  const existing = bucket.find((item) => item.requestId === requestId)
  if (existing !== undefined) existing.atMs = at
  else bucket.push({ requestId, atMs: at })
  return next
}

export interface PromptLedgerStoreOptions {
  filePath: string
  now?: () => number
}

export interface PromptLedgerStoreResult {
  ok: boolean
  view: PromptLedgerView
  problem: LedgerProblem | null
}

export interface PromptLedgerStore {
  readonly file: string
  load(): Promise<PromptLedgerStoreResult>
  record(sessionId: string, requestId: string, atMs?: number): Promise<PromptLedgerStoreResult>
  lastProblem(): LedgerProblem | null
}

export function createPromptLedger(options: PromptLedgerStoreOptions): PromptLedgerStore {
  const file = options.filePath
  const now = options.now ?? ((): number => Date.now())
  let problem: LedgerProblem | null = null
  let seq = 0

  function writeFilePrivate(target: string, content: string): void {
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
    seq += 1
    const stamp = Number.isFinite(now()) ? Math.trunc(now()) : 0
    const tmp = `${target}.${process.pid}.${stamp}.${seq}.tmp`
    writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 })
    try {
      renameSync(tmp, target)
    } catch (error) {
      try {
        unlinkSync(tmp)
      } catch {
        /* 清理失败不改变写入失败的事实 */
      }
      throw error
    }
    if (process.platform !== 'win32') {
      try {
        chmodSync(target, 0o600)
      } catch {
        /* POSIX chmod 失败不改变已落盘内容 */
      }
    }
  }

  function commit(view: PromptLedgerView): PromptLedgerStoreResult {
    try {
      writeFilePrivate(file, encodeLedger(view))
      problem = null
      return { ok: true, view, problem: null }
    } catch {
      problem = 'E_LEDGER_STORAGE_UNAVAILABLE'
      return { ok: false, view: {}, problem }
    }
  }

  async function load(): Promise<PromptLedgerStoreResult> {
    let raw = ''
    try {
      if (!existsSync(file)) {
        problem = null
        return { ok: true, view: {}, problem: null }
      }
      raw = readFileSync(file, 'utf8')
    } catch {
      problem = 'E_LEDGER_STORAGE_UNAVAILABLE'
      return { ok: false, view: {}, problem }
    }
    const decoded = decodeLedger(raw)
    problem = decoded.problem
    return { ok: decoded.ok, view: decoded.view, problem: decoded.problem }
  }

  async function record(sessionId: string, requestId: string, atMs?: number): Promise<PromptLedgerStoreResult> {
    const current = await load()
    if (!current.ok) return { ok: false, view: {}, problem: current.problem ?? 'E_LEDGER_STORAGE_UNAVAILABLE' }
    const stamp = typeof atMs === 'number' ? atMs : now()
    return commit(recordSeen(current.view, sessionId, requestId, stamp))
  }

  return { file, load, record, lastProblem: (): LedgerProblem | null => problem }
}
