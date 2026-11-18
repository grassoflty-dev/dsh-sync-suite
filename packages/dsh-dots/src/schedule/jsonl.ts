/**
 * 日程 JSONL 的编解码与折叠（Node 侧权威实现，**逐条对齐** App 的 `model/jsonl.ts`）。
 *
 * 契约（`docs/DATA-CONTRACT.md` §3）：
 *   - 一行一个 JSON 对象，**只追加，绝不重写历史行**；
 *   - `appendRecord` 原有文本逐字节保留，只在末尾补一个换行再追加新行；
 *   - `foldById` 先按 ts 稳定升序，再让后者覆盖前者（同 id 取较晚记录）；
 *   - 未知扩展字段保留在末尾：读路径只校验已知字段，多出来的键既不报错也不丢弃。
 *
 * 之所以照抄而不是"读 JSON 数组再整体写回"：平板可能同时在写同一份文件，
 * 重写历史行会让追加语义失效（并制造 rebase 冲突）。
 */
import type { Attachment, ScheduleRecord } from './types.js'

/** 附件字段的形状校验结果。 */
function isAttachmentLike(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return (
    typeof item.sha256 === 'string' &&
    item.sha256.length > 0 &&
    typeof item.name === 'string' &&
    item.name.length > 0 &&
    typeof item.pageIndex === 'number' &&
    Number.isFinite(item.pageIndex) &&
    item.pageIndex >= 0
  )
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * 校验一个已解析的 JSON 值是否符合 `ScheduleRecord`。
 * 返回 `null` 表示合法；返回字符串表示不合法的原因（用于坏行定位）。
 */
export function describeRecordProblem(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return '记录必须是 JSON 对象'
  const record = value as Record<string, unknown>
  if (!isNonEmptyString(record.id)) return '缺少字段 id（非空字符串）'
  if (!isNonEmptyString(record.ts)) return '缺少字段 ts（ISO 8601 字符串）'
  if (typeof record.title !== 'string') return '缺少字段 title（字符串）'
  if (typeof record.body !== 'string') return '缺少字段 body（字符串）'
  if (typeof record.author !== 'string') return '缺少字段 author（字符串）'
  if (typeof record.done !== 'boolean') return '缺少字段 done（布尔）'
  if (typeof record.ai_processed !== 'boolean') return '缺少字段 ai_processed（布尔）'
  if (record.ocr_text !== undefined && typeof record.ocr_text !== 'string') return '字段 ocr_text 必须是字符串'
  if (record.ai_structured !== undefined && typeof record.ai_structured !== 'string') {
    return '字段 ai_structured 必须是字符串'
  }
  if (record.ocr_time !== undefined && typeof record.ocr_time !== 'string') return '字段 ocr_time 必须是字符串'
  if (record.attachments !== undefined) {
    if (!Array.isArray(record.attachments)) return '字段 attachments 必须是数组'
    for (let i = 0; i < record.attachments.length; i += 1) {
      if (!isAttachmentLike(record.attachments[i])) return `字段 attachments[${i}] 必须是 {sha256,name,pageIndex}`
    }
  }
  return null
}

/**
 * 按契约的字段顺序重建对象（保证同一记录永远产出同一行文本，便于 diff 与去重）。
 * 未知扩展字段保留在末尾。
 */
function normalizeRecord(record: ScheduleRecord): ScheduleRecord {
  const source = record as unknown as Record<string, unknown>
  const normalized: Record<string, unknown> = {
    id: record.id,
    ts: record.ts,
    title: record.title,
    body: record.body,
  }
  if (record.ocr_text !== undefined) normalized.ocr_text = record.ocr_text
  normalized.author = record.author
  normalized.done = record.done
  if (record.attachments !== undefined) {
    normalized.attachments = (record.attachments as Attachment[]).map((item) => ({
      sha256: item.sha256,
      name: item.name,
      pageIndex: item.pageIndex,
    }))
  }
  if (record.ai_structured !== undefined) normalized.ai_structured = record.ai_structured
  normalized.ai_processed = record.ai_processed
  if (record.ocr_time !== undefined) normalized.ocr_time = record.ocr_time
  for (const key of Object.keys(source)) {
    if (!(key in normalized)) normalized[key] = source[key]
  }
  return normalized as unknown as ScheduleRecord
}

/** 把一条记录编码成单行 JSON + `\n`；记录不合法时抛错，避免把垃圾写进历史日志。 */
export function encodeRecord(record: ScheduleRecord): string {
  const normalized = normalizeRecord(record)
  const problem = describeRecordProblem(normalized)
  if (problem !== null) throw new Error(`记录不合法：${problem}`)
  return `${JSON.stringify(normalized)}\n`
}

/** 解析单行；空行、坏 JSON、字段不合法的行返回 `null`（不抛错）。 */
export function decodeLine(line: string): ScheduleRecord | null {
  const text = typeof line === 'string' ? line.trim() : ''
  if (text.length === 0) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (describeRecordProblem(parsed) !== null) return null
  return parsed as ScheduleRecord
}

/** 解析整份 JSONL：跳过空行，坏行不中断，按 1 起行号记入 `errors`。 */
export function parseJsonl(text: string): {
  records: ScheduleRecord[]
  errors: Array<{ line: number; message: string }>
} {
  const records: ScheduleRecord[] = []
  const errors: Array<{ line: number; message: string }> = []
  if (typeof text !== 'string' || text.length === 0) return { records, errors }
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] as string
    const line = index + 1
    const trimmed = raw.trim()
    if (trimmed.length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      errors.push({ line, message: `不是合法 JSON：${reason}` })
      continue
    }
    const problem = describeRecordProblem(parsed)
    if (problem !== null) {
      errors.push({ line, message: `字段校验失败：${problem}` })
      continue
    }
    records.push(parsed as ScheduleRecord)
  }
  return { records, errors }
}

/**
 * 追加一条记录：**原有文本逐字节保留**，只在末尾补一个换行再追加新行。
 * 这是「只追加、绝不重写历史」的实现基础（落盘时配合 `appendFile` 使用）。
 */
export function appendRecord(text: string, record: ScheduleRecord): string {
  const encoded = encodeRecord(record)
  const base = typeof text === 'string' ? text : ''
  if (base.length === 0) return encoded
  if (base.endsWith('\n')) return base + encoded
  return `${base}\n${encoded}`
}

/** ts → 毫秒；非法返回 NaN。 */
function tsMillis(ts: string): number {
  const value = Date.parse(ts)
  return Number.isNaN(value) ? Number.NaN : value
}

/** 稳定升序排序：ts 早的在前，ts 相同保持输入顺序。 */
export function sortRecords(records: ScheduleRecord[]): ScheduleRecord[] {
  const list = records.slice()
  list.sort((left, right) => {
    const a = tsMillis(left.ts)
    const b = tsMillis(right.ts)
    if (!Number.isNaN(a) && !Number.isNaN(b)) return a - b
    if (left.ts < right.ts) return -1
    if (left.ts > right.ts) return 1
    return 0
  })
  return list
}

/**
 * 按 id 折叠：先按 ts 稳定升序，再让后者覆盖前者（同 id 取较晚记录）。
 * 输出顺序 = 各 id 首次出现的顺序，值为该 id 的最后一条记录。
 */
export function foldById(records: ScheduleRecord[]): ScheduleRecord[] {
  const folded = new Map<string, ScheduleRecord>()
  for (const record of sortRecords(records)) folded.set(record.id, record)
  return Array.from(folded.values())
}

/**
 * 从 ts 取「本地日期」`YYYY-MM-DD`。
 * 优先直接取 ISO 前缀（保留记录者时区，跨设备阅读不会把 23:30 的记录移到第二天）。
 */
export function recordDateKey(ts: string): string {
  const text = typeof ts === 'string' ? ts : ''
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10)
  const millis = tsMillis(text)
  if (Number.isNaN(millis)) return ''
  const date = new Date(millis)
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** 取某一天的记录（按 ts 的日期归属，不改变原顺序）。 */
export function byDate(records: ScheduleRecord[], date: string): ScheduleRecord[] {
  return records.filter((record) => recordDateKey(record.ts) === date)
}
