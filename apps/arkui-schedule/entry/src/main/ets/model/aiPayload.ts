/**
 * 每日 AI 汇总的载荷与提示词构建，以及结果回写（纯逻辑）。
 *
 * 契约：`docs/CONTRACT.md` §3.2、`docs/DATA-CONTRACT.md` §3
 * - 只提交当天 `ai_processed:false` 的记录；
 * - 提示词必须注入当前时间与时区；
 * - 回写只写 `ai_structured` 与 `ai_processed:true`，**永不修改 `ocr_text`**。
 */
import type { AiPayload, ScheduleRecord } from './types';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 取记录里该交给 AI 的文本：优先用户可编辑的 `body`（已包含手写识别结果与人工修正），
 * 正文为空时退回原始 `ocr_text`。两者都为空则为空串。
 */
function textForAi(record: ScheduleRecord): string {
  const body = typeof record.body === 'string' ? record.body : '';
  if (body.trim().length > 0) {
    return body;
  }
  return typeof record.ocr_text === 'string' ? record.ocr_text : '';
}

/** 构建某天的 AI 载荷：只取 `ai_processed === false` 且归属该天的记录。 */
export function buildAiPayload(date: string, records: ScheduleRecord[]): AiPayload {
  return selectPayload(date, records, true);
}

/**
 * 构建某天的**全量**载荷（含已 `ai_processed` 的记录）。
 *
 * 每日汇总要把整天重新讲一遍，与增量整理（只取未处理）区分；两者共用同一套字段映射，
 * 不复制第二份。
 */
export function buildDaySummaryPayload(date: string, records: ScheduleRecord[]): AiPayload {
  return selectPayload(date, records, false);
}

/** 载荷选取的共用实现：`unprocessedOnly` 决定是否跳过已处理记录。 */
function selectPayload(date: string, records: ScheduleRecord[], unprocessedOnly: boolean): AiPayload {
  if (!DATE_RE.test(date)) {
    throw new Error(`日期格式必须是 YYYY-MM-DD：${String(date)}`);
  }
  const selected: AiPayload['records'] = [];
  const list: ScheduleRecord[] = Array.isArray(records) ? records : [];
  for (const record of list) {
    if (unprocessedOnly && record.ai_processed !== false) {
      continue;
    }
    // ts 是含时区的 ISO 8601，前 10 位即记录者本地日期（与 model/jsonl 的日期归属一致）
    if (typeof record.ts !== 'string' || record.ts.slice(0, 10) !== date) {
      continue;
    }
    selected.push({
      id: record.id,
      ocr_time: record.ocr_time !== undefined && record.ocr_time.length > 0 ? record.ocr_time : record.ts,
      text: textForAi(record)
    });
  }
  return { date, records: selected };
}

/** 记录内容超过该长度时截断，避免单次请求 token 失控。 */
const MAX_TEXT_LENGTH = 4000;

function clipText(text: string): string {
  if (text.length <= MAX_TEXT_LENGTH) {
    return text;
  }
  return `${text.slice(0, MAX_TEXT_LENGTH)}\n…（超长内容已截断）`;
}

/**
 * 构建提交给 DeepSeek 的提示词：注入当前时间与时区，逐条列出记录并要求输出结构化摘要。
 */
export function buildAiPrompt(payload: AiPayload, nowIso: string, timeZone: string): string {
  const lines: string[] = [];
  lines.push('你是DSH-Dots的整理助手。请把用户当天的手写日程记录整理成结构化摘要。');
  lines.push('');
  lines.push(`当前时间：${nowIso}`);
  lines.push(`时区：${timeZone}`);
  lines.push(`记录日期：${payload.date}`);
  lines.push(`记录条数：${payload.records.length}`);
  lines.push('');
  if (payload.records.length === 0) {
    lines.push('（当天没有需要整理的记录）');
    return lines.join('\n');
  }
  lines.push('记录明细：');
  for (let i = 0; i < payload.records.length; i++) {
    const record = payload.records[i];
    lines.push('');
    lines.push(`### 记录 ${i + 1}`);
    lines.push(`- id: ${record.id}`);
    lines.push(`- 识别时间: ${record.ocr_time}`);
    lines.push('- 内容:');
    lines.push(clipText(record.text));
  }
  lines.push('');
  lines.push('输出要求：');
  lines.push('1. 用中文 Markdown 输出，按「重点事项 / 待办 / 时间点 / 备注」分类；');
  lines.push('2. 只依据记录内容归纳，不要编造记录中不存在的人名、时间、数字；');
  lines.push('3. 记录中「查看手迹」类的占位符表示该处为表格/公式截图，原样保留即可；');
  lines.push('4. 保留每位记录者的姓名与各自的待办归属；');
  lines.push('5. 摘要正文放在回答里，不要输出 JSON。');
  return lines.join('\n');
}

/**
 * 回写 AI 结果：只设置命中的 `ai_structured` 与 `ai_processed:true`。
 * `ocr_text` 等其它字段一概不动；入参数组与对象不被修改（返回新数组/新对象）。
 */
export function applyAiResult(
  records: ScheduleRecord[],
  structuredById: Record<string, string>,
  processedIds: string[]
): ScheduleRecord[] {
  const processed = new Set<string>(Array.isArray(processedIds) ? processedIds : []);
  return records.map((record) => {
    const hasStructured = Object.prototype.hasOwnProperty.call(structuredById, record.id);
    const isProcessed = processed.has(record.id);
    if (!hasStructured && !isProcessed) {
      return { ...record };
    }
    const next: ScheduleRecord = { ...record };
    if (hasStructured) {
      next.ai_structured = structuredById[record.id];
    }
    next.ai_processed = true;
    return next;
  });
}
