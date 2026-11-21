/**
 * v2 单时间线「读 + 规范序列化」核心（纯函数层，零 fs、零墙钟、零副作用）。
 *
 * 这是 App `apps/arkui-schedule/entry/src/main/ets/model/timeline.ts` 的**忠实移植**，
 * 外加 `timelineWrite.ts` 里的纯字节构造 `buildRecordsText` / `openIdsOf`，以及
 * `syncProtocol.ts` 的 `conflictsLine` 审计行形状（契约 §4）。
 * 职责边界：本模块**只产出字节与内存视图**，不实现 writer（原子替换、账本追加、
 * outbox、union/replay、门禁 IO）也不改写 v1 `src/schedule/**` 的任何代码。
 *
 * 关键口径（与 App 逐条一致）：
 * - `canonicalRecordLine`：严格键序、缺席可选字段省略、未知字段原样尾随、`JSON.stringify` 转义；
 * - `parseTimelineDay`：目录名权威、一条一行与 pretty JSON 双形态、坏元素/坏字段/坏媒体
 *   fail-soft 计数、`open` 只读暴露而不信任；
 * - 折叠：较晚 ts 静默胜；同 ts（含同刻不同字节写法，有意超集）按规范整行 UTF-8 字节序较大者胜，
 *   完全相同只留一份；每次并列记一条 `TimelineResolution`（§4 审计），败者落账本属写阶段职责；
 * - open 谓词：只认 `closed_at` 缺省（空串 / 纯空白 / null 等同缺省），**绝不用 done**；
 * - 账本：D=max(deleted.ts)、R=max(restore.ts)，可见 iff 存在 R 且 R>D 严格成立；
 * - schema 门槛：`parseSchemaMarker` 只认 2；`decideFreshStart` 缺标记 = 正常空起点（不拒绝），
 *   标记存在但不可识别 = typed 只读拒绝（`E_SCHEMA_UNKNOWN` / 畸形 JSON `E_CORRUPT`）。
 *
 * 不变量：同输入两次得到相同对象与相同字节；不使用 Date.now() / new Date() 取当前时间。
 */
import { createHash } from 'node:crypto'
import { isTimelineDateKey } from './paths.js'

// ---------------------------------------------------------------- 类型（与 App 同形）

/** 一条 v2 记录；未知字段通过索引签名原样保留。 */
export interface TimelineRecord {
  id: string
  ts: string
  title: string
  body: string
  author: string
  done: boolean
  media: TimelineMedia[]
  ai_processed: boolean
  ocr_text?: string
  ai_structured?: string
  ocr_time?: string
  opened_at: string
  closed_at?: string
  [key: string]: unknown
}

/** 媒体索引元素；`file` 是同日 media/ 下的裸文件名。 */
export interface TimelineMedia {
  file: string
  sha256: string
  pageIndex: number
}

/**
 * 一日的内存视图。`open` 按文件原样暴露、读路径不信任；
 * `allRecords` 是**未经账本过滤**的原始版本行，展示必须经 `visibleRecords()` / `openRecords()`。
 */
export interface TimelineDay {
  date: string
  open: string[]
  allRecords: TimelineRecord[]
}

/** 一行解析错误（1 起行号）。 */
export interface TimelineParseError {
  line: number
  message: string
}

/** 一次同 (id,ts) 折叠的裁决明细（契约 §4 审计）。 */
export interface TimelineResolution {
  id: string
  ts: string
  winner: string
  losers: string[]
  reason: 'equal-ts-byte-order' | 'identical'
}

/** `parseTimelineDay` 的返回值；无法识别顶层对象时 day 为 null。 */
export interface ParsedTimelineDay {
  day: TimelineDay | null
  errors: TimelineParseError[]
  resolutions: TimelineResolution[]
  duplicates: number
}

/** `deleted.jsonl` / `restore.jsonl` 的一条账目。 */
export interface LedgerEntry {
  id: string
  ts: string
  deletedAt?: string
  restoredAt?: string
}

/** `parseLedger` 的返回值。 */
export interface ParsedLedger {
  entries: LedgerEntry[]
  errors: TimelineParseError[]
}

/** 仓库级 `timeline/schema.json` 的门槛判定（与 App 同形）。 */
export interface SchemaMarker {
  ok: boolean
  version: number | null
  reason: string
}

/** 对外 typed 拒绝：`code` 取自 App 的错误码词表。 */
export interface TypedRefusal {
  ok: boolean
  code: string
  version: number | null
  reason: string
}

/** `decideFreshStart` 的决策（前两字段与 App 同形，后两字段给出 typed 原因）。 */
export interface FreshStartDecision {
  needSchema: boolean
  unsupported: boolean
  code: string
  reason: string
}

/** App 契约 §4 / §11 用到的 typed 错误码。 */
export const TIMELINE_ERROR_CODES = {
  SCHEMA_UNKNOWN: 'E_SCHEMA_UNKNOWN',
  CORRUPT: 'E_CORRUPT',
  VALIDATION: 'E_VALIDATION',
} as const

/** 首用时仓库级标记的规范字节（与 App `FRESH_SCHEMA_TEXT` 逐字相同）。 */
export const FRESH_SCHEMA_TEXT = '{"schemaVersion":2}\n'

// 契约 §3 记录字段表的规范键序（与 App timeline.ts、迁移工具逐字一致）。
const KEY_ORDER: string[] = [
  'id', 'ts', 'title', 'body', 'author', 'done', 'media',
  'ocr_text', 'ai_structured', 'ai_processed', 'ocr_time', 'opened_at', 'closed_at'
]
const KNOWN_KEYS = new Set<string>(KEY_ORDER)
// 契约 §5 / P2-11：<sha256[0:16]>.jpg，小写 hex，裸文件名（不含任何路径）。
const MEDIA_FILE_RE = /^[0-9a-f]{16}\.jpg$/
// 契约 §5：sha256 必须是完整 64 位小写十六进制。
const SHA256_RE = /^[0-9a-f]{64}$/

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function lineOf(source: string, index: number): number {
  let line = 1
  for (let i = 0; i < index; i += 1) {
    if (source[i] === '\n') {
      line += 1
    }
  }
  return line
}

/** ts → 毫秒；非法返回 NaN（与 App `tsMillis` 同口径）。 */
export function tsMillis(ts: string): number {
  const value = Date.parse(ts)
  return Number.isNaN(value) ? Number.NaN : value
}

/** ts 比较：可解析按时刻，否则退回字符串逐字符比较。 */
function compareTs(left: string, right: string): number {
  const a = tsMillis(left)
  const b = tsMillis(right)
  if (!Number.isNaN(a) && !Number.isNaN(b)) {
    return a === b ? 0 : (a < b ? -1 : 1)
  }
  if (left === right) {
    return 0
  }
  return left < right ? -1 : 1
}

/**
 * 字符串 → UTF-8 字节数组。契约 §4 的 tie-break 用 Buffer.compare，
 * 这里手写等价编码（代理对按码点编码，孤立代理按 U+FFFD），零 Node 类型依赖。
 */
function utf8Bytes(text: string): number[] {
  const out: number[] = []
  for (let i = 0; i < text.length; i += 1) {
    let cp = text.charCodeAt(i)
    if (cp >= 0xD800 && cp <= 0xDBFF) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : -1
      if (next >= 0xDC00 && next <= 0xDFFF) {
        cp = 0x10000 + ((cp - 0xD800) << 10) + (next - 0xDC00)
        i += 1
      } else {
        cp = 0xFFFD
      }
    } else if (cp >= 0xDC00 && cp <= 0xDFFF) {
      cp = 0xFFFD
    }
    if (cp < 0x80) {
      out.push(cp)
    } else if (cp < 0x800) {
      out.push(0xC0 | (cp >> 6), 0x80 | (cp & 0x3F))
    } else if (cp < 0x10000) {
      out.push(0xE0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F))
    } else {
      out.push(
        0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F),
        0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F)
      )
    }
  }
  return out
}

/** 与 `Buffer.compare(Buffer.from(a,'utf8'), Buffer.from(b,'utf8'))` 等价的字节序比较。 */
export function byteCompare(a: string, b: string): number {
  const left = utf8Bytes(a)
  const right = utf8Bytes(b)
  const len = Math.min(left.length, right.length)
  for (let i = 0; i < len; i += 1) {
    if (left[i] !== right[i]) {
      return left[i] < right[i] ? -1 : 1
    }
  }
  return left.length === right.length ? 0 : (left.length < right.length ? -1 : 1)
}

// ---------------------------------------------------------------- 规范序列化

/**
 * 契约 §3 的纯函数：固定键序、无多余空格、未知扩展字段排在末尾且值不变。
 * 与 App 的实现故意重复（见文件头注释）——任何漂移都会被字节对拍测试抓到。
 */
export function canonicalRecordLine(record: TimelineRecord): string {
  const source = record as unknown as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of KEY_ORDER) {
    if (hasOwn(source, key)) {
      out[key] = source[key]
    }
  }
  for (const key of Object.keys(source)) {
    if (!KNOWN_KEYS.has(key)) {
      out[key] = source[key]
    }
  }
  return JSON.stringify(out)
}

/** 写入排序：ts 升序，同 ts 按 id 升序（与 App `sortRecordsForWrite` 同口径）。不改入参。 */
export function sortRecordsForWrite(records: TimelineRecord[]): TimelineRecord[] {
  const sorted = records.slice()
  sorted.sort((left: TimelineRecord, right: TimelineRecord): number => {
    const delta = compareTs(left.ts, right.ts)
    if (delta !== 0) {
      return delta
    }
    if (left.id === right.id) {
      return 0
    }
    return left.id < right.id ? -1 : 1
  })
  return sorted
}

/**
 * 派生当日未完成 id（§6）：只看 closed_at 缺省（空串 / 纯空白 / null 等同缺省），
 * 绝不用 done，也不看调用方给的 open 缓存。保留入参顺序。
 */
export function openIdsOf(records: TimelineRecord[]): string[] {
  const out: string[] = []
  for (let i = 0; i < records.length; i += 1) {
    const record: TimelineRecord = records[i]
    const closed: unknown = record.closed_at
    const isOpen: boolean = closed === undefined || closed === null ||
      (typeof closed === 'string' && closed.trim().length === 0)
    if (isOpen) {
      out.push(record.id)
    }
  }
  return out
}

/**
 * 构造一日的 `records.json` 全文（§3 字节形状）：整份是合法 JSON 对象，
 * `records` 每个元素独占一行、末尾恰好一个换行。非法日期 / 任一记录非法 / 自检失败 → 返回 ''。
 * 纯字节构造，不写盘；不做 id 折叠（折叠属读侧语义）。
 */
export function buildRecordsText(date: string, records: TimelineRecord[]): string {
  if (!isTimelineDateKey(date)) {
    return ''
  }
  const sorted: TimelineRecord[] = sortRecordsForWrite(records)
  const lines: string[] = []
  lines.push('{')
  lines.push(`  "date": ${JSON.stringify(date)},`)
  lines.push(`  "open": ${JSON.stringify(openIdsOf(sorted))},`)
  lines.push('  "records": [')
  for (let i = 0; i < sorted.length; i += 1) {
    const comma: string = i < sorted.length - 1 ? ',' : ''
    lines.push(`  ${canonicalRecordLine(sorted[i])}${comma}`)
  }
  lines.push('  ]')
  lines.push('}')
  const text: string = `${lines.join('\n')}\n`
  // 自检：把拟写字节交给读侧解析器，坏字段 / 坏媒体 / 日期不符都在这里挡下。
  const parsed = parseTimelineDay(text, date)
  if (parsed.day === null || parsed.errors.length > 0) {
    return ''
  }
  return text
}

// ---------------------------------------------------------------- 记录校验

/** 返回 null 表示合法，否则返回坏行原因（用于 errors）。 */
function describeRecordProblem(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return '记录必须是 JSON 对象'
  }
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || record.id.trim().length === 0) {
    return '缺少字段 id（非空字符串）'
  }
  if (typeof record.ts !== 'string' || record.ts.trim().length === 0) {
    return '缺少字段 ts（ISO 8601 字符串）'
  }
  if (typeof record.title !== 'string') {
    return '缺少字段 title（字符串）'
  }
  if (typeof record.body !== 'string') {
    return '缺少字段 body（字符串）'
  }
  if (typeof record.author !== 'string') {
    return '缺少字段 author（字符串）'
  }
  if (typeof record.done !== 'boolean') {
    return '缺少字段 done（布尔）'
  }
  if (!Array.isArray(record.media)) {
    return '缺少字段 media（数组）'
  }
  if (typeof record.ai_processed !== 'boolean') {
    return '缺少字段 ai_processed（布尔）'
  }
  if (typeof record.opened_at !== 'string') {
    return '缺少字段 opened_at（字符串）'
  }
  for (const key of ['ocr_text', 'ai_structured', 'ocr_time', 'closed_at']) {
    const value = record[key]
    if (value !== undefined && value !== null && typeof value !== 'string') {
      return `字段 ${key} 必须是字符串`
    }
  }
  return null
}

/** 校验 media[]：非法条目丢弃并各记一条 error；记录本身不因媒体非法被整条拒绝（§5）。 */
function validMedia(value: unknown, line: number, errors: TimelineParseError[]): TimelineMedia[] {
  const kept: TimelineMedia[] = []
  const source = Array.isArray(value) ? value : []
  for (let i = 0; i < source.length; i += 1) {
    const item = source[i]
    let problem: string | null = null
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      problem = '必须是 {file,sha256,pageIndex} 对象'
    } else {
      const media = item as Record<string, unknown>
      if (typeof media.file !== 'string' || !MEDIA_FILE_RE.test(media.file)) {
        problem = `media[${i}].file 必须是不含路径的 <hex16>.jpg 裸文件名`
      } else if (typeof media.sha256 !== 'string' || !SHA256_RE.test(media.sha256)) {
        problem = `media[${i}].sha256 必须是 64 位小写十六进制字符串`
      } else if (!Number.isInteger(media.pageIndex) || (media.pageIndex as number) < 0) {
        problem = `media[${i}].pageIndex 必须是非负整数`
      }
    }
    if (problem === null) {
      kept.push(item as TimelineMedia)
    } else {
      errors.push({ line: line, message: problem })
    }
  }
  return kept
}

/** 把一个 JSON 块解析成记录；坏块 / 坏字段 / 坏媒体都 fail-soft。 */
function consumeBlock(
  block: string,
  line: number,
  errors: TimelineParseError[],
  out: TimelineRecord[]
): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(block)
  } catch (error) {
    errors.push({ line: line, message: `记录行不是合法 JSON：${errorText(error)}` })
    return
  }
  const problem = describeRecordProblem(parsed)
  if (problem !== null) {
    errors.push({ line: line, message: `字段校验失败：${problem}` })
    return
  }
  const record = parsed as TimelineRecord
  record.media = validMedia(record.media, line, errors)
  out.push(record)
}

/**
 * 从 records 数组的 '[' 起做括号配平扫描，按顶层元素切分后逐块处理。
 * 一条一行与 pretty JSON 都走同一路径；字符串内的括号被正确忽略。
 * 顶层非对象元素（数字 / 字符串 / null / 布尔 / 数组）跳过并计入 errors。
 */
function extractRecords(source: string, openBracket: number, errors: TimelineParseError[]): TimelineRecord[] {
  const out: TimelineRecord[] = []
  const elements: { start: number; end: number }[] = []
  let arrayDepth = 1
  let braceDepth = 0
  let inString = false
  let escaped = false
  let elemStart = -1
  const topLevel = (): boolean => arrayDepth === 1 && braceDepth === 0
  for (let i = openBracket + 1; i < source.length; i += 1) {
    const ch = source[i]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      if (topLevel() && elemStart < 0) {
        elemStart = i
      }
      inString = true
      continue
    }
    if (ch === '{') {
      if (topLevel() && elemStart < 0) {
        elemStart = i
      }
      braceDepth += 1
      continue
    }
    if (ch === '}') {
      if (braceDepth > 0) {
        braceDepth -= 1
      }
      continue
    }
    if (ch === '[') {
      if (topLevel() && elemStart < 0) {
        elemStart = i
      }
      arrayDepth += 1
      continue
    }
    if (ch === ']') {
      arrayDepth -= 1
      if (arrayDepth === 0) {
        if (elemStart >= 0) {
          elements.push({ start: elemStart, end: i })
        }
        break
      }
      continue
    }
    if (ch === ',' && topLevel()) {
      if (elemStart >= 0) {
        elements.push({ start: elemStart, end: i })
        elemStart = -1
      }
      continue
    }
    if (topLevel() && elemStart < 0 && !/\s/.test(ch)) {
      elemStart = i
    }
  }
  for (const range of elements) {
    const text = source.slice(range.start, range.end).trim()
    if (text.length === 0) {
      continue
    }
    if (text.startsWith('{')) {
      consumeBlock(text, lineOf(source, range.start), errors, out)
    } else {
      errors.push({
        line: lineOf(source, range.start),
        message: `records 数组中的非对象元素被跳过：${text.slice(0, 40)}`
      })
    }
  }
  return out
}

/** 从 records 键之前的文本里取顶层数组字段（open）；畸形时返回空数组。 */
function extractTopArray(source: string, prefix: string, key: string): string[] {
  const regex = new RegExp(`"${key}"\\s*:\\s*\\[`)
  const match = regex.exec(prefix)
  if (match === null) {
    return []
  }
  const start = match.index + match[0].length - 1
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '[') {
      depth += 1
      continue
    }
    if (ch === ']') {
      depth -= 1
      if (depth === 0) {
        try {
          const parsed: unknown = JSON.parse(source.slice(start, i + 1))
          if (Array.isArray(parsed)) {
            return parsed.filter((value: unknown): boolean => typeof value === 'string') as string[]
          }
        } catch {
          return []
        }
        return []
      }
    }
  }
  return []
}

/** `foldDuplicateIds` 的结果：折叠后的记录 + §4 裁决明细 + 完全相同而折叠掉的行数。 */
interface FoldResult {
  records: TimelineRecord[]
  resolutions: TimelineResolution[]
  duplicates: number
}

/**
 * 同 id 多行折叠：较晚 ts 胜；ts 判等（compareTs===0，同刻不同字节写法也算，见 App 头文件
 * 「有意超集」）时规范整行 UTF-8 字节较大者胜；完全相同只留一条。
 * 不同 ts 的静默折叠不记 resolution；同 (id,ts) 的每次折叠都记一条（§4 审计）。
 */
function foldDuplicateIds(records: TimelineRecord[]): FoldResult {
  const byId = new Map<string, TimelineRecord[]>()
  for (const record of records) {
    const group = byId.get(record.id)
    if (group === undefined) {
      byId.set(record.id, [record])
    } else {
      group.push(record)
    }
  }
  const folded: TimelineRecord[] = []
  const resolutions: TimelineResolution[] = []
  let duplicates = 0
  for (const [id, group] of byId) {
    let winner = group[0]
    let winnerLine = canonicalRecordLine(winner)
    let winnerTs = winner.ts
    let losers: string[] = []
    const emit = (): void => {
      if (losers.length === 0) {
        return
      }
      const reason: TimelineResolution['reason'] =
        losers.every((line: string): boolean => line === winnerLine) ? 'identical' : 'equal-ts-byte-order'
      resolutions.push({ id: id, ts: winnerTs, winner: winnerLine, losers: losers.slice(), reason: reason })
      losers = []
    }
    for (let k = 1; k < group.length; k += 1) {
      const candidate = group[k]
      const delta = compareTs(candidate.ts, winner.ts)
      if (delta > 0) {
        emit()
        winner = candidate
        winnerLine = canonicalRecordLine(candidate)
        winnerTs = candidate.ts
        continue
      }
      if (delta < 0) {
        continue
      }
      const candidateLine = canonicalRecordLine(candidate)
      const cmp = byteCompare(candidateLine, winnerLine)
      if (cmp > 0) {
        losers.push(winnerLine)
        winner = candidate
        winnerLine = candidateLine
        winnerTs = candidate.ts
      } else {
        losers.push(candidateLine)
        if (cmp === 0) {
          duplicates += 1
        }
      }
    }
    emit()
    folded.push(winner)
  }
  return { records: folded, resolutions: resolutions, duplicates: duplicates }
}

// ---------------------------------------------------------------- 对外读函数

/** 解析一日的 `records.json`；目录名 expectedDate 权威，永不抛。 */
export function parseTimelineDay(text: string, expectedDate: string): ParsedTimelineDay {
  const errors: TimelineParseError[] = []
  const source = typeof text === 'string' ? text : ''
  if (source.trim().length === 0) {
    return {
      day: { date: expectedDate, open: [], allRecords: [] },
      errors: errors, resolutions: [], duplicates: 0
    }
  }

  const recordsMatch = /"records"\s*:\s*\[/.exec(source)
  const prefix = recordsMatch === null ? source : source.slice(0, recordsMatch.index)
  const dateMatch = /"date"\s*:\s*"([^"]*)"/.exec(prefix)
  const fileDate = dateMatch === null ? expectedDate : dateMatch[1]
  const open = extractTopArray(source, prefix, 'open')

  if (fileDate !== expectedDate) {
    errors.push({
      line: dateMatch === null ? 1 : lineOf(source, dateMatch.index),
      message: `date 字段 ${JSON.stringify(fileDate)} 与目录日期 ${JSON.stringify(expectedDate)} 不符，按目录日期处理`
    })
  }

  if (recordsMatch === null) {
    let isObject = false
    try {
      const parsed: unknown = JSON.parse(source)
      isObject = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    } catch {
      isObject = false
    }
    if (!isObject) {
      errors.push({ line: 1, message: 'records.json 顶层不是合法 JSON 对象' })
      return { day: null, errors: errors, resolutions: [], duplicates: 0 }
    }
    errors.push({ line: 1, message: 'records.json 缺少 records 数组' })
    return {
      day: { date: expectedDate, open: open, allRecords: [] },
      errors: errors, resolutions: [], duplicates: 0
    }
  }

  const openBracket = recordsMatch.index + recordsMatch[0].length - 1
  const folded = foldDuplicateIds(extractRecords(source, openBracket, errors))
  return {
    day: { date: expectedDate, open: open, allRecords: folded.records },
    errors: errors, resolutions: folded.resolutions, duplicates: folded.duplicates
  }
}

/** 解析追加式账本（`deleted.jsonl` / `restore.jsonl`）；坏行跳过计数，永不抛。 */
export function parseLedger(text: string): ParsedLedger {
  const entries: LedgerEntry[] = []
  const errors: TimelineParseError[] = []
  const source = typeof text === 'string' ? text : ''
  if (source.length === 0) {
    return { entries: entries, errors: errors }
  }
  const lines = source.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i].trim()
    if (raw.length === 0) {
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      errors.push({ line: i + 1, message: `不是合法 JSON：${errorText(error)}` })
      continue
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      errors.push({ line: i + 1, message: '账本条目必须是 JSON 对象' })
      continue
    }
    const row = parsed as Record<string, unknown>
    if (typeof row.id !== 'string' || row.id.length === 0) {
      errors.push({ line: i + 1, message: '缺少字段 id（非空字符串）' })
      continue
    }
    if (typeof row.ts !== 'string' || row.ts.length === 0) {
      errors.push({ line: i + 1, message: '缺少字段 ts（非空字符串）' })
      continue
    }
    const entry: LedgerEntry = { id: row.id, ts: row.ts }
    if (typeof row.deletedAt === 'string') {
      entry.deletedAt = row.deletedAt
    }
    if (typeof row.restoredAt === 'string') {
      entry.restoredAt = row.restoredAt
    }
    entries.push(entry)
  }
  return { entries: entries, errors: errors }
}

/** 仓库级 `schema.json` 门槛：只解析 schemaVersion，永不抛（与 App 同形同文案）。 */
export function parseSchemaMarker(text: string): SchemaMarker {
  let parsed: unknown
  try {
    parsed = JSON.parse(typeof text === 'string' ? text : '')
  } catch (error) {
    return { ok: false, version: null, reason: `schema.json 不是合法 JSON：${errorText(error)}` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, version: null, reason: 'schema.json 顶层必须是 JSON 对象' }
  }
  const marker = parsed as Record<string, unknown>
  if (!hasOwn(marker, 'schemaVersion')) {
    return { ok: false, version: null, reason: 'schema.json 缺少 schemaVersion 字段' }
  }
  const version = marker.schemaVersion
  if (typeof version !== 'number' || !Number.isFinite(version)) {
    return {
      ok: false,
      version: null,
      reason: `schemaVersion 必须是数字，实际为 ${typeof version}`
    }
  }
  if (version !== 2) {
    return { ok: false, version: version, reason: `不支持的 schemaVersion：${version}（仅支持 2）` }
  }
  return { ok: true, version: 2, reason: '' }
}

/** 空仓库正常起点的规范空骨架（与 App `freshDayText` 逐字相同）。 */
export function freshDayText(date: string): string {
  return `{"date":"${date}","open":[],"records":[]}\n`
}

/**
 * typed 门槛：缺标记 / 空标记 = fresh start（不拒绝）；
 * 标记存在但版本不可识别 → `E_SCHEMA_UNKNOWN`；标记本身畸形 JSON → `E_CORRUPT`。
 * 只判定、不 IO；调用方据此在打开任何 timeline 写句柄前决定是否零写入。
 */
export function schemaRefusal(schemaText: string): TypedRefusal {
  const present: boolean = typeof schemaText === 'string' && schemaText.trim().length > 0
  if (!present) {
    return { ok: true, code: '', version: null, reason: '' }
  }
  const marker = parseSchemaMarker(schemaText)
  if (marker.ok) {
    return { ok: true, code: '', version: marker.version, reason: '' }
  }
  const code: string = marker.reason.includes('不是合法 JSON')
    ? TIMELINE_ERROR_CODES.CORRUPT
    : TIMELINE_ERROR_CODES.SCHEMA_UNKNOWN
  return { ok: false, code: code, version: marker.version, reason: marker.reason }
}

/**
 * App `decideFreshStart` 的等价物（前两字段同形，后两字段带 typed 原因）。
 * 缺标记 = 正常空仓库（needSchema=true，不拒绝）；有标记但不可识别 = unsupported 只读门槛。
 */
export function decideFreshStart(schemaText: string): FreshStartDecision {
  const present: boolean = typeof schemaText === 'string' && schemaText.trim().length > 0
  if (!present) {
    return { needSchema: true, unsupported: false, code: '', reason: '' }
  }
  const refusal = schemaRefusal(schemaText)
  return { needSchema: false, unsupported: !refusal.ok, code: refusal.code, reason: refusal.reason }
}

/**
 * 删除 / 撤销优先级（§7）：D=max(deletion.ts)，R=max(restore.ts)，
 * 可见 iff 存在 R 且 R>D 严格成立；同 ts 删除胜。
 */
export function deletionState(
  id: string,
  deletions: LedgerEntry[],
  restores: LedgerEntry[]
): 'visible' | 'deleted' {
  let deletedTs: string | null = null
  for (let i = 0; i < deletions.length; i += 1) {
    const entry = deletions[i]
    if (entry.id === id && (deletedTs === null || compareTs(entry.ts, deletedTs) > 0)) {
      deletedTs = entry.ts
    }
  }
  if (deletedTs === null) {
    return 'visible'
  }
  let restoredTs: string | null = null
  for (let i = 0; i < restores.length; i += 1) {
    const entry = restores[i]
    if (entry.id === id && (restoredTs === null || compareTs(entry.ts, restoredTs) > 0)) {
      restoredTs = entry.ts
    }
  }
  if (restoredTs !== null && compareTs(restoredTs, deletedTs) > 0) {
    return 'visible'
  }
  return 'deleted'
}

/**
 * 读侧统一入口：先按账本过滤 `day.allRecords`，再给出可见记录（不排序、不改入参）。
 * 调用方必须同时传入 deleted 与 restore 两本账本，漏传即等于关闭账本过滤。
 */
export function visibleRecords(
  day: TimelineDay,
  deletions: LedgerEntry[],
  restores: LedgerEntry[]
): TimelineRecord[] {
  const out: TimelineRecord[] = []
  for (let i = 0; i < day.allRecords.length; i += 1) {
    const record = day.allRecords[i]
    if (deletionState(record.id, deletions, restores) === 'visible') {
      out.push(record)
    }
  }
  return out
}

/** 未完成记录：closed_at 缺省（空串 / 纯空白 / null 等同缺省）者；绝不看 done，也不信 day.open。 */
export function openRecords(
  day: TimelineDay,
  deletions: LedgerEntry[],
  restores: LedgerEntry[]
): TimelineRecord[] {
  return visibleRecords(day, deletions, restores).filter((record: TimelineRecord): boolean => {
    const closed = record.closed_at
    return closed === undefined || closed === null || (typeof closed === 'string' && closed.trim().length === 0)
  })
}

// ---------------------------------------------------------------- 冲突审计行（§4）

/** 纯 SHA-256（UTF-8）；与 App `sha256Hex` 对拍一致（node:crypto 是内建，非 npm 依赖）。 */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 由输入 ts 派生 decidedAt（不可解析时退回原文），绝不读墙钟（与 App `decidedAtOf` 同口径）。 */
export function decidedAtFromTs(ts: string): string {
  const ms = Date.parse(ts)
  if (!Number.isNaN(ms)) {
    return new Date(ms).toISOString()
  }
  return ts
}

/**
 * `conflicts.jsonl` 的一行（契约 §4 / App `conflictsLine`）：键序
 * `id, ts, losingLine, decidedAt, dedupeKey`；`dedupeKey = sha256(规范 losingLine)`。
 * 这里是纯字节构造；追加写入 / 按 `(id,ts,dedupeKey)` 去重落盘属于写阶段模块。
 */
export function conflictsLine(id: string, ts: string, losingLine: string, decidedAt: string): string {
  return JSON.stringify({
    id: id, ts: ts, losingLine: losingLine, decidedAt: decidedAt, dedupeKey: sha256Hex(losingLine)
  })
}

/**
 * 把读侧 §4 裁决明细映射成审计行（每条 loser 一行；`identical` 重复不算冲突，跳过）。
 *
 * 逐行派生 decidedAt（与 App `model/syncProtocol.ts:595-596` 的 `decidedAtOf(ts, now)` 同口径）：
 * App 在 `syncProtocol.ts:641` 把**败者自己的 `loser.ts`** 传给 addConflict，再由 :596 对每行调用
 * conflictsLine(id, ts, losingLine, decidedAtOf(ts, now))。因此一天里不同时刻的冲突必须得到
 * 不同的 decidedAt，不能给整批盖同一个值。本读模块只持有败者的规范行，故从该行取回它自己的 ts
 * （规范行由 canonicalRecordLine 产出，其 ts 与败者记录逐字相同）；不可解析时退回 resolution.ts，
 * 全程不读墙钟。纯函数，不写盘。
 */
export function conflictRowsFromResolutions(resolutions: TimelineResolution[]): string[] {
  const out: string[] = []
  for (const resolution of resolutions) {
    if (resolution.reason === 'identical') {
      continue
    }
    for (const loser of resolution.losers) {
      let loserTs: string = resolution.ts
      try {
        const parsed: unknown = JSON.parse(loser)
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const candidate = (parsed as Record<string, unknown>).ts
          if (typeof candidate === 'string' && candidate.length > 0) {
            loserTs = candidate
          }
        }
      } catch {
        // 败者行理论上总是本模块的规范行；兜底用 resolution.ts，绝不读墙钟
      }
      out.push(conflictsLine(resolution.id, loserTs, loser, decidedAtFromTs(loserTs)))
    }
  }
  return out
}
