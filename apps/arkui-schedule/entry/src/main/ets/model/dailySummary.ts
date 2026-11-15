/**
 * 每日 AI 汇总（纯逻辑，零 SDK import，Node 可直接跑）。
 *
 * 落盘位置：`devices/<deviceId>/summaries/YYYY-MM-DD.json` —— 与日程同一棵设备目录树，
 * 随 git 同步；**不写进 `schedules/*.jsonl`**，避免污染「只追加」的日程日志。
 *
 * 文件读走 `SummaryIO` 端口：模型层不碰宿主文件 API，Node 测试用临时目录实现，
 * 服务层用 `@kit.CoreFileKit` 实现（见 `services/summaryStore.ets`）。
 *
 * 冲突策略：同一天以 `generatedAt` 较新者为准，相等保留现有；写入前先读旧文件，
 * 因此坏的/读不到的旧文件不会让新结果被静默丢弃——由 `SummaryWriteResult.reason` 交代。
 */
import { buildDaySummaryPayload } from './aiPayload';
import { byDate } from './jsonl';
import { devicePathPrefix } from './syncScope';
import type { AiPayload, ScheduleRecord } from './types';

/** 汇总文件格式版本。 */
export const SUMMARY_VERSION: number = 1;
/** 设备目录下的汇总子目录名。 */
export const SUMMARIES_DIR_NAME: string = 'summaries';
/** 汇总文件后缀。 */
export const SUMMARY_FILE_SUFFIX: string = '.json';
/** 展示用要点上限。 */
export const SUMMARY_MAX_POINTS: number = 3;
/** headline 单行最大长度。 */
export const SUMMARY_MAX_HEADLINE: number = 120;
/** 单条要点最大长度。 */
export const SUMMARY_MAX_POINT: number = 80;

const DATE_RE: RegExp = /^\d{4}-\d{2}-\d{2}$/;
const BULLET_RE: RegExp = /^(?:[-*•·]|\d+[.)])\s+/;
const RULE_LINE_RE: RegExp = /^[=-]{3,}$/;

/** 一天的汇总（落盘即此结构，键顺序固定便于 git diff）。 */
export interface DailySummary {
  version: number;
  /** `YYYY-MM-DD`，与文件名一致。 */
  date: string;
  /** 生成时刻（epoch 毫秒），合并时以此判新旧。 */
  generatedAt: number;
  model: string;
  provider: string;
  /** 一句话总述（单行）。 */
  headline: string;
  /** 要点，最多 3 条。 */
  points: string[];
  recordCount: number;
  doneCount: number;
}

/** 解析结果类型：`empty` = 没文件/空文件，`corrupt` = 有内容但不可用。 */
export type SummaryParseKind = 'ok' | 'empty' | 'corrupt';

export interface SummaryParseResult {
  kind: SummaryParseKind;
  summary: DailySummary | null;
}

export interface SummaryMergeResult {
  summary: DailySummary;
  /** 是否用 `incoming` 覆盖了 `existing`。 */
  replaced: boolean;
}

/** 汇总文件的读写端口：读不到返回 `null`，实现方不要抛（抛了按读失败处理）。 */
export interface SummaryIO {
  readText(path: string): string | null;
  writeText(path: string, text: string): void;
}

export interface SummaryReadResult {
  kind: SummaryParseKind;
  summary: DailySummary | null;
  /** 仓库相对路径 `devices/<id>/summaries/<date>.json`。 */
  path: string;
  /** 读到的原文（读失败为空串）。 */
  text: string;
}

/** 写入原因，供调用方记录/展示（不静默覆盖）。 */
export type SummaryWriteReason =
  | 'created'
  | 'newer'
  | 'repaired'
  | 'stale'
  | 'unchanged'
  | 'invalid'
  | 'read-failed'
  | 'write-failed';

export interface SummaryWriteResult {
  /** 落盘后该天的有效汇总（写失败时可能为 `null`）。 */
  summary: DailySummary | null;
  path: string;
  written: boolean;
  replaced: boolean;
  reason: SummaryWriteReason;
}

/** 生成汇总的请求输入：时区只进提示词，不进 JSON。 */
export interface SummaryRequestInput {
  date: string;
  timeZone: string;
  payload: AiPayload;
  recordCount: number;
  doneCount: number;
}

/** 生成汇总的元信息（服务层在 AI 返回后补齐）。 */
export interface SummaryMeta {
  date: string;
  generatedAt: number;
  model: string;
  provider: string;
  recordCount: number;
  doneCount: number;
}

/** UI 展示用的裁剪结果。 */
export interface SummaryDisplay {
  headline: string;
  points: string[];
}

/** 合法日期 `YYYY-MM-DD` 返回原文，否则返回空串（含 `2026-13-01` 这类不存在的日期）。 */
function normalizeDate(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!DATE_RE.test(text)) {
    return '';
  }
  const year = Number(text.slice(0, 4));
  const month = Number(text.slice(5, 7));
  const day = Number(text.slice(8, 10));
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    return '';
  }
  return text;
}

/** 压成单行并截断到 `maxLength`。 */
function oneLine(value: unknown, maxLength: number): string {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

/** 非负整数（非数字/负数/NaN → 0；给了 `max` 时夹紧）。 */
function nonNegativeInt(value: unknown, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }
  const count = Math.floor(value);
  if (count <= 0) {
    return 0;
  }
  return max >= 0 && count > max ? max : count;
}

/** 设备目录下的汇总目录（仓库相对路径）：`devices/<deviceId>/summaries`。 */
export function summariesPath(deviceId: string): string {
  return `${devicePathPrefix(deviceId)}${SUMMARIES_DIR_NAME}`;
}

/** 某天的汇总文件（仓库相对路径）；日期非法直接抛错（路径不做猜测）。 */
export function summaryFilePath(deviceId: string, date: string): string {
  const key = normalizeDate(date);
  if (key.length === 0) {
    throw new Error(`汇总日期必须是 YYYY-MM-DD：${String(date)}`);
  }
  return `${summariesPath(deviceId)}/${key}${SUMMARY_FILE_SUFFIX}`;
}

/**
 * 归一一条汇总：日期必须是合法 `YYYY-MM-DD`、`generatedAt` 必须是非负有限数，
 * 否则返回 `null`（调用方据此判 `corrupt`）。其余字段能修就修：要点截断到 3 条、
 * headline/要点压成单行、计数取非负整数且 `doneCount <= recordCount`。
 */
export function sanitizeSummary(raw: unknown): DailySummary | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const item = raw as Record<string, unknown>;
  const date = normalizeDate(item.date);
  if (date.length === 0) {
    return null;
  }
  const generatedAtRaw = item.generatedAt;
  if (typeof generatedAtRaw !== 'number' || !Number.isFinite(generatedAtRaw) || generatedAtRaw < 0) {
    return null;
  }
  const points: string[] = [];
  const rawPoints = item.points;
  if (Array.isArray(rawPoints)) {
    for (const entry of rawPoints) {
      if (points.length >= SUMMARY_MAX_POINTS) {
        break;
      }
      const text = oneLine(entry, SUMMARY_MAX_POINT);
      if (text.length > 0) {
        points.push(text);
      }
    }
  }
  const recordCount = nonNegativeInt(item.recordCount, -1);
  const summary: DailySummary = {
    version: SUMMARY_VERSION,
    date: date,
    generatedAt: Math.floor(generatedAtRaw),
    model: oneLine(item.model, 64),
    provider: oneLine(item.provider, 32),
    headline: oneLine(item.headline, SUMMARY_MAX_HEADLINE),
    points: points,
    recordCount: recordCount,
    doneCount: nonNegativeInt(item.doneCount, recordCount)
  };
  return summary;
}

/** 序列化（`sanitizeSummary` 后按固定键序输出，末尾带换行）。非法内容抛错，不写垃圾。 */
export function serializeSummary(summary: DailySummary): string {
  const clean = sanitizeSummary(summary);
  if (clean === null) {
    throw new Error('汇总内容不合法：日期或生成时间缺失');
  }
  return `${JSON.stringify(clean, null, 2)}\n`;
}

/** 解析汇总文本：空 → `empty`，坏 JSON/字段不全 → `corrupt`，**永不抛异常**。 */
export function parseSummary(text: string): SummaryParseResult {
  const source = typeof text === 'string' ? text.trim() : '';
  if (source.length === 0) {
    return { kind: 'empty', summary: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return { kind: 'corrupt', summary: null };
  }
  const summary = sanitizeSummary(parsed);
  if (summary === null) {
    return { kind: 'corrupt', summary: null };
  }
  return { kind: 'ok', summary: summary };
}

/**
 * 同一天的两份汇总合并：`generatedAt` 较新者为准；相等时保留现有（先到的先得，避免抖动）。
 * `replaced` 明确告诉调用方是否真的换了内容，便于记日志。
 */
export function mergeSummary(existing: DailySummary | null, incoming: DailySummary): SummaryMergeResult {
  if (existing === null) {
    return { summary: incoming, replaced: true };
  }
  if (existing.generatedAt >= incoming.generatedAt) {
    return { summary: existing, replaced: false };
  }
  return { summary: incoming, replaced: true };
}

/** UI 展示裁剪：headline 单行、要点最多 `maxPoints` 条（默认 3）。 */
export function truncateSummaryForDisplay(summary: DailySummary, maxPoints: number = SUMMARY_MAX_POINTS): SummaryDisplay {
  const limit = maxPoints > 0 ? Math.floor(maxPoints) : 0;
  const points: string[] = [];
  const rawPoints = summary === null || summary === undefined ? [] : summary.points;
  if (Array.isArray(rawPoints)) {
    for (const entry of rawPoints) {
      if (points.length >= limit) {
        break;
      }
      const text = oneLine(entry, SUMMARY_MAX_POINT);
      if (text.length > 0) {
        points.push(text);
      }
    }
  }
  const headline = summary === null || summary === undefined ? '' : oneLine(summary.headline, SUMMARY_MAX_HEADLINE);
  return { headline: headline, points: points };
}

/**
 * 构建某天的汇总请求：载荷复用 `buildDaySummaryPayload`（全量、含已处理记录），
 * 并顺手给出 `recordCount` / `doneCount` 供汇总结构使用。
 */
export function buildSummaryPayload(records: ScheduleRecord[], date: string, timeZone: string): SummaryRequestInput {
  const list: ScheduleRecord[] = Array.isArray(records) ? records : [];
  const payload = buildDaySummaryPayload(date, list);
  const dayRecords: ScheduleRecord[] = byDate(list, date);
  let doneCount = 0;
  for (const record of dayRecords) {
    if (record.done === true) {
      doneCount++;
    }
  }
  const input: SummaryRequestInput = {
    date: date,
    timeZone: typeof timeZone === 'string' ? timeZone : '',
    payload: payload,
    recordCount: payload.records.length,
    doneCount: doneCount
  };
  return input;
}

/**
 * 把 AI 回复（中文 Markdown）压成汇总结构：第一行非项目符号文本当 headline，
 * 项目符号行（`-` / `*` / `1.`）当要点；章节标题（`#` 开头）只用于 headline。
 *
 * 回复里没有可识别文本时抛错（由服务层保证不落盘）。
 */
export function summaryFromReply(replyText: string, meta: SummaryMeta): DailySummary {
  const text = typeof replyText === 'string' ? replyText : '';
  const lines: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.length === 0 || RULE_LINE_RE.test(line)) {
      continue;
    }
    lines.push(line);
  }
  let headline = '';
  const points: string[] = [];
  for (const line of lines) {
    const isBullet = BULLET_RE.test(line);
    const content = isBullet ? line.replace(BULLET_RE, '').trim() : line.replace(/^#+\s*/, '').trim();
    if (content.length === 0) {
      continue;
    }
    if (!isBullet && headline.length === 0) {
      headline = content;
      continue;
    }
    if (!isBullet && line.startsWith('#')) {
      continue;
    }
    if (points.length >= SUMMARY_MAX_POINTS) {
      continue;
    }
    points.push(content);
  }
  if (headline.length === 0) {
    throw new Error('AI 返回内容里没有可用的标题，请重试');
  }
  const draft: DailySummary = {
    version: SUMMARY_VERSION,
    date: meta.date,
    generatedAt: meta.generatedAt,
    model: meta.model,
    provider: meta.provider,
    headline: headline,
    points: points,
    recordCount: meta.recordCount,
    doneCount: meta.doneCount
  };
  const clean = sanitizeSummary(draft);
  if (clean === null) {
    throw new Error('AI 汇总内容不合法：日期或生成时间缺失');
  }
  return clean;
}

/** 读某天的汇总（走端口）：不存在 → `empty`，坏文件/读失败 → `corrupt`，**不抛**。 */
export function readDailySummary(io: SummaryIO, deviceId: string, date: string): SummaryReadResult {
  const path = summaryFilePath(deviceId, date);
  let text = '';
  try {
    const raw = io.readText(path);
    text = typeof raw === 'string' ? raw : '';
  } catch {
    return { kind: 'corrupt', summary: null, path: path, text: '' };
  }
  const parsed = parseSummary(text);
  return { kind: parsed.kind, summary: parsed.summary, path: path, text: text };
}

/**
 * 写某天的汇总（走端口）：先读旧文件，只有「新的更晚 / 旧文件缺失 / 旧文件损坏」才落盘。
 *
 * - 旧文件读失败 → 拒绝写入（`read-failed`），避免把可能更新的远端内容盖掉；
 * - 写入抛错 → `write-failed`，旧文件原样保留；
 * - 内容不合法 → `invalid`，一个字节都不写。
 */
export function writeDailySummary(io: SummaryIO, deviceId: string, incoming: DailySummary): SummaryWriteResult {
  const clean = sanitizeSummary(incoming);
  if (clean === null) {
    return { summary: null, path: '', written: false, replaced: false, reason: 'invalid' };
  }
  const path = summaryFilePath(deviceId, clean.date);
  let existingText: string | null;
  try {
    existingText = io.readText(path);
  } catch {
    return { summary: null, path: path, written: false, replaced: false, reason: 'read-failed' };
  }
  const existing = parseSummary(existingText === null ? '' : existingText);
  const merged = mergeSummary(existing.summary, clean);
  if (!merged.replaced) {
    return {
      summary: merged.summary,
      path: path,
      written: false,
      replaced: false,
      reason: existing.kind === 'ok' ? 'stale' : 'unchanged'
    };
  }
  const text = serializeSummary(merged.summary);
  try {
    io.writeText(path, text);
  } catch {
    return { summary: merged.summary, path: path, written: false, replaced: false, reason: 'write-failed' };
  }
  let reason: SummaryWriteReason = 'newer';
  if (existing.kind === 'corrupt') {
    reason = 'repaired';
  } else if (existingText === null || existing.kind === 'empty') {
    reason = 'created';
  }
  return { summary: merged.summary, path: path, written: true, replaced: true, reason: reason };
}
