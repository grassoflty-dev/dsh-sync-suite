/**
 * 每日 AI 汇总的载荷与提示词（Node 侧，语义**照搬** App 的 `model/aiPayload.ts`）。
 *
 * 契约（`docs/DATA-CONTRACT.md` §3、`docs/CONTRACT.md` §3.2）：
 * - 载荷只含 `{id, ocr_time, text}` 三元组，`text` 优先取用户可编辑的 `body`，为空退回 `ocr_text`；
 * - 提示词必须注入当前时间与时区；
 * - 桌面端只做"读 + 汇总"，**不**回写 `ai_structured`/`ai_processed`（回写是平板侧的行为，
 *   要回写就得追加同 id 新行，属于 App 的编辑流程）。
 *
 * 桌面端与平板共用同一份提示词，才能保证同一批记录在两处得到可比的摘要。
 */
import type { AiPayload, ScheduleRecord } from './types.js'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** 取记录里该交给 AI 的文本：优先 `body`，为空退回 `ocr_text`。 */
function textForAi(record: ScheduleRecord): string {
  const body = typeof record.body === 'string' ? record.body : ''
  if (body.trim().length > 0) return body
  return typeof record.ocr_text === 'string' ? record.ocr_text : ''
}

function selectPayload(date: string, records: ScheduleRecord[], unprocessedOnly: boolean): AiPayload {
  if (!DATE_RE.test(date)) throw new Error(`日期格式必须是 YYYY-MM-DD：${String(date)}`)
  const selected: AiPayload['records'] = []
  const list: ScheduleRecord[] = Array.isArray(records) ? records : []
  for (const record of list) {
    if (unprocessedOnly && record.ai_processed !== false) continue
    // ts 是含时区的 ISO 8601，前 10 位即记录者本地日期（与 jsonl 的日期归属一致）
    if (typeof record.ts !== 'string' || record.ts.slice(0, 10) !== date) continue
    selected.push({
      id: record.id,
      ocr_time: record.ocr_time !== undefined && record.ocr_time.length > 0 ? record.ocr_time : record.ts,
      text: textForAi(record),
    })
  }
  return { date, records: selected }
}

/** 构建某天的增量载荷：只取 `ai_processed === false` 且归属该天的记录。 */
export function buildAiPayload(date: string, records: ScheduleRecord[]): AiPayload {
  return selectPayload(date, records, true)
}

/** 构建某天的**全量**载荷（含已 `ai_processed` 的记录）；每日汇总用这个。 */
export function buildDaySummaryPayload(date: string, records: ScheduleRecord[]): AiPayload {
  return selectPayload(date, records, false)
}

/** 记录内容超过该长度时截断，避免单次请求 token 失控。 */
const MAX_TEXT_LENGTH = 4000

function clipText(text: string): string {
  if (text.length <= MAX_TEXT_LENGTH) return text
  return `${text.slice(0, MAX_TEXT_LENGTH)}\n…（超长内容已截断）`
}

/**
 * 构建提交给 AI 的提示词：注入当前时间与时区，逐条列出记录并要求输出结构化摘要。
 * 与 App `buildAiPrompt` 逐行一致。
 */
export function buildAiPrompt(payload: AiPayload, nowIso: string, timeZone: string): string {
  const lines: string[] = []
  lines.push('你是DSH-Dots的整理助手。请把用户当天的手写日程记录整理成结构化摘要。')
  lines.push('')
  lines.push(`当前时间：${nowIso}`)
  lines.push(`时区：${timeZone}`)
  lines.push(`记录日期：${payload.date}`)
  lines.push(`记录条数：${payload.records.length}`)
  lines.push('')
  if (payload.records.length === 0) {
    lines.push('（当天没有需要整理的记录）')
    return lines.join('\n')
  }
  lines.push('记录明细：')
  for (let i = 0; i < payload.records.length; i += 1) {
    const record = payload.records[i]
    if (record === undefined) continue
    lines.push('')
    lines.push(`### 记录 ${i + 1}`)
    lines.push(`- id: ${record.id}`)
    lines.push(`- 识别时间: ${record.ocr_time}`)
    lines.push('- 内容:')
    lines.push(clipText(record.text))
  }
  lines.push('')
  lines.push('输出要求：')
  lines.push('1. 用中文 Markdown 输出，按「重点事项 / 待办 / 时间点 / 备注」分类；')
  lines.push('2. 只依据记录内容归纳，不要编造记录中不存在的人名、时间、数字；')
  lines.push('3. 记录中「查看手迹」类的占位符表示该处为表格/公式截图，原样保留即可；')
  lines.push('4. 保留每位记录者的姓名与各自的待办归属；')
  lines.push('5. 摘要正文放在回答里，不要输出 JSON。')
  return lines.join('\n')
}

/** AI 的 system 角色（与 App `services/deepseek.ets` 的 `SYSTEM_PROMPT` 同句）。 */
export const SUMMARY_SYSTEM_PROMPT =
  '你是DSH-Dots的整理助手。只依据用户提供的记录归纳，用中文 Markdown 输出，不编造人名、时间或数字。'

/** 当前时区标签（`Intl` 可用时给 IANA 名，否则回退偏移字符串）。 */
export function currentTimeZone(date: Date = new Date()): string {
  try {
    const name = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (typeof name === 'string' && name.trim() !== '') return name.trim()
  } catch {
    /* 极端环境下没有 Intl：回退到偏移量 */
  }
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
}
