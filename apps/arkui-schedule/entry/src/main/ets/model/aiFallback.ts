/**
 * AI 多源 fallback 的**纯决策层**（零 SDK import，Node 可直接跑）。
 *
 * 与 `model/aiRequest.ts` 的分工：
 * - `aiRequest.classifyAiError` 负责「状态码 → 中文文案」（全站唯一措辞来源，本文件不重复造）；
 * - 本文件负责「这次失败**下一步做什么**」：`success` / `next-source` / `abort`（`retry-same` 保留未用）。
 *
 * 决策表（`classifyAttempt` 逐条实现，`tools/test/aiFallback.test.mjs` 逐行钉住）：
 * | 情况 | outcome | 理由 |
 * | --- | --- | --- |
 * | `ok===true` | `success` | 直接返回 |
 * | 401 / 403 | `next-source` | 同一个源重试没意义，换源 |
 * | 429 | `next-source` | 限流，别继续打同一家 |
 * | 超时 / 网络（含伪状态码 -1 / 0） | `next-source` | 无法判断何时恢复 |
 * | 5xx | `next-source` | 服务端故障 |
 * | 解析失败（`kind==='parse'`） | `next-source` | 返回体不可用 |
 * | 其它 4xx（400 / 404 / 422 …） | `abort` | **我们自己的请求**有问题，换源也一样错，别浪费额度 |
 * | 402（余额/配额不足） | `next-source` | 是**这家**的账务问题，换一家通常立刻可用 |
 * | 本地配置问题（`kind==='config'`：缺 key / 地址非法） | `next-source` | 每个源有独立配置，且**一个字节都没发出去** |
 * | 其它（未知状态、2xx 但 ok=false） | `abort` | 无法证明「换源有用」时保守停下，不把内容再发给别家 |
 *
 * 隐私红线：
 * - `enabled===false` 时 `planFallback` **只**返回主源，绝不把同样的内容发给别的供应商；
 * - `FallbackDiagnostic` 只记「源 / 原因 / 耗时」，`sanitizeDiagnostic` 用正则把
 *   `sk-…` / `Bearer …` / `api_key=…` / `token=…` 之类碎片替换成 `***`，并把 message 截断到
 *   `DIAGNOSTIC_MESSAGE_MAX`（200）字符——诊断可以上界面，但永远不含凭据。
 *
 * 本文件不 import 任何 `@kit.*` / ArkUI 类型；`aiProvider` 与 `aiRequest` 也都是纯逻辑模块，
 * 因此它可以被 `tools/tsconfig.json` 编译后由 Node 单测直接验证（`tools/test/aiFallback.test.mjs`）。
 */
import { findProvider, resolveModel } from './aiProvider';
import { AI_STATUS_NETWORK, AI_STATUS_TIMEOUT } from './aiRequest';

/** 一个可尝试的 AI 源（主源与备用源同一形状）。 */
export interface FallbackSource {
  /** 源 id（`deepseek` / `opencode-go` / `codex` / `openrouter` / `custom`）。 */
  providerId: string;
  /** 模型名（空串在运行器里回落该源默认模型）。 */
  modelId: string;
  /** 接口基地址（可选；预设源恒用预设地址，只有自定义源采用）。 */
  baseURL?: string;
}

/** 一次尝试的「下一步」决策。 */
export type FallbackOutcome = 'success' | 'retry-same' | 'next-source' | 'abort';

/** 一次尝试的结果（网络层失败/超时/解析失败也在这里表达，不抛异常）。 */
export interface FallbackAttemptResult {
  /** 是否成功拿到可用正文。 */
  ok: boolean;
  /** HTTP 状态码；网络失败 `AI_STATUS_NETWORK`(0)、超时 `AI_STATUS_TIMEOUT`(-1)。 */
  status?: number;
  /** 失败类别（`timeout` / `network` / `parse` / `config` / `auth` / `rate-limit` / `server` / `bad-request`）。 */
  kind?: string;
  /** 中文原因（成功的尝试为空）。 */
  message?: string;
  /** 本次尝试耗时（毫秒）。 */
  elapsedMs: number;
}

/** 编辑备用源时的字段补丁（UI 回调用它表达「只改了一项」）。 */
export interface FallbackSourcePatch {
  providerId?: string;
  modelId?: string;
  baseURL?: string;
}

/** 一次尝试的诊断记录（**不含任何凭据**，可直接显示在设置页）。 */
export interface FallbackDiagnostic {
  /** 第几次尝试（1 起）。 */
  attempt: number;
  providerId: string;
  modelId: string;
  outcome: FallbackOutcome;
  elapsedMs: number;
  /** 失败类别（成功为 `ok`）。 */
  category: string;
  /** 中文原因（已脱敏、已截断）。 */
  message: string;
}

/** 诊断汇总（设置页「上次运行」概要）。 */
export interface FallbackSummary {
  /** 一共尝试了几次。 */
  attempts: number;
  /** 失败过的源 id（按首次出现顺序去重）。 */
  failedSources: string[];
  /** 成功的尝试序号（`attempt` 值）；全失败为 `null`。 */
  succeededAt: number | null;
}

/** 默认尝试次数（主源 + 1 个备用源）。 */
export const DEFAULT_MAX_ATTEMPTS: number = 2;

/** 配置里最多允许几个备用源（设置页上限）。 */
export const MAX_FALLBACK_SOURCES: number = 3;

/** 尝试次数的硬上限（含主源）：主源 + 3 个备用源。 */
export const MAX_ATTEMPTS_LIMIT: number = 4;

/** 诊断 message 的最大长度（超出截断，避免把整段响应体搬上界面）。 */
export const DIAGNOSTIC_MESSAGE_MAX: number = 200;

/** 失败类别常量（`kind` 与 `category` 共用同一套字符串，便于 grep 与测试）。 */
export const KIND_OK: string = 'ok';
export const KIND_TIMEOUT: string = 'timeout';
export const KIND_NETWORK: string = 'network';
export const KIND_PARSE: string = 'parse';
export const KIND_CONFIG: string = 'config';
export const KIND_AUTH: string = 'auth';
export const KIND_RATE_LIMIT: string = 'rate-limit';
export const KIND_SERVER: string = 'server';
export const KIND_BAD_REQUEST: string = 'bad-request';
export const KIND_UNKNOWN: string = 'unknown';

/** 归一源 id：去空白 + 小写（预设 id 全小写；`findProvider` 也是这么比的）。 */
function normalizeProviderId(value: string): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** 归一模型名：只去空白（大小写有意义，不转小写）。 */
function normalizeModelId(value: string): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 归一失败类别：去空白 + 小写。 */
function normalizeKind(value: string): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** 取状态码：缺失/NaN 返回 `null`（与「0 = 网络失败」区分开）。 */
function statusOf(result: FallbackAttemptResult): number | null {
  const status: number = result.status === undefined ? Number.NaN : result.status;
  if (typeof status !== 'number' || !Number.isFinite(status)) {
    return null;
  }
  return status;
}

/**
 * 状态码 → 失败类别（`-1` 超时 / `0` 网络失败 / 401-403 鉴权 / 429 限流 / 5xx 服务端 / 其它 4xx 请求错）。
 *
 * 只做分类，不做决策；决策在 `classifyAttempt`。放在这里是因为运行器要用它填 `diagnostic.category`，
 * 而 `category` 与 `kind` 必须同源，否则界面上的「原因」会和实际决策对不上。
 */
export function attemptKindForStatus(status: number): string {
  if (typeof status !== 'number' || !Number.isFinite(status)) {
    return KIND_UNKNOWN;
  }
  if (status === AI_STATUS_TIMEOUT) {
    return KIND_TIMEOUT;
  }
  if (status === AI_STATUS_NETWORK) {
    return KIND_NETWORK;
  }
  if (status >= 200 && status <= 299) {
    return KIND_OK;
  }
  if (status === 401 || status === 403) {
    return KIND_AUTH;
  }
  if (status === 429) {
    return KIND_RATE_LIMIT;
  }
  if (status >= 500 && status <= 599) {
    return KIND_SERVER;
  }
  if (status >= 400 && status <= 499) {
    return KIND_BAD_REQUEST;
  }
  return KIND_UNKNOWN;
}

/**
 * 一次尝试的「下一步」决策（**决策表逐条实现**，见文件头）。
 *
 * 注意顺序：`kind` 先于 `status` 判定——`kind==='parse'` 的尝试可能是 HTTP 200，
 * 若先看状态码就会落到「2xx 但 ok=false → abort」，那正是我们要避免的（解析失败换源常能成功）。
 */
export function classifyAttempt(result: FallbackAttemptResult): FallbackOutcome {
  if (result.ok === true) {
    return 'success';
  }
  const kind: string = normalizeKind(result.kind === undefined ? '' : result.kind);
  // 运输层/返回体/本地配置：换源有意义，且 config 情形一个字节都没发出去
  if (kind === KIND_TIMEOUT || kind === KIND_NETWORK || kind === KIND_PARSE || kind === KIND_CONFIG) {
    return 'next-source';
  }
  const status: number | null = statusOf(result);
  if (status === null) {
    // 没有状态码时只能靠类别：鉴权/限流/服务端都值得换源，其余（含未知）保守停下
    if (kind === KIND_AUTH || kind === KIND_RATE_LIMIT || kind === KIND_SERVER) {
      return 'next-source';
    }
    return 'abort';
  }
  if (status === AI_STATUS_TIMEOUT || status === AI_STATUS_NETWORK) {
    return 'next-source';
  }
  if (status === 401 || status === 403) {
    return 'next-source';
  }
  if (status === 429) {
    return 'next-source';
  }
  if (status >= 500 && status <= 599) {
    return 'next-source';
  }
  if (status === 402) {
    // 402 Payment Required = **这家**账户余额/配额不够，换一家通常立刻可用；
    // 归到下面「4xx 一律 abort」会白白放掉最该 fallback 的一类失败。
    return 'next-source';
  }
  if (status >= 400 && status <= 499) {
    // 我们自己的请求有问题（400 参数错 / 404 模型名错 / 422 参数越界）：换源一样错，别浪费额度
    return 'abort';
  }
  return 'abort';
}

/** 这次尝试的展示类别（成功 `ok`；失败优先用调用方给的 `kind`，否则按状态码推）。 */
export function categoryOfAttempt(result: FallbackAttemptResult): string {
  if (result.ok === true) {
    return KIND_OK;
  }
  const kind: string = normalizeKind(result.kind === undefined ? '' : result.kind);
  if (kind.length > 0) {
    return kind;
  }
  const status: number | null = statusOf(result);
  return status === null ? KIND_UNKNOWN : attemptKindForStatus(status);
}

/** 两个源是否是「同一个」（provider + model，大小写不敏感；baseURL 不参与）。 */
export function isSameSource(left: FallbackSource, right: FallbackSource): boolean {
  const leftProvider: string = normalizeProviderId(left.providerId);
  const rightProvider: string = normalizeProviderId(right.providerId);
  if (leftProvider.length === 0 || leftProvider !== rightProvider) {
    return false;
  }
  return normalizeModelId(left.modelId).toLowerCase() === normalizeModelId(right.modelId).toLowerCase();
}

/** 归一单个源（去空白；空 provider/model 的条目返回 `null`，表示「这条不算数」）。 */
function normalizeSource(source: FallbackSource): FallbackSource | null {
  if (source === null || source === undefined) {
    return null;
  }
  const providerId: string = normalizeProviderId(source.providerId);
  const modelId: string = normalizeModelId(source.modelId);
  if (providerId.length === 0 || modelId.length === 0) {
    return null;
  }
  const baseURL: string = typeof source.baseURL === 'string' ? source.baseURL.trim() : '';
  const normalized: FallbackSource = { providerId: providerId, modelId: modelId };
  if (baseURL.length > 0) {
    normalized.baseURL = baseURL;
  }
  return normalized;
}

/** 去重（保持首次出现顺序；同 provider + model 只留第一次；空条目丢弃）。 */
export function dedupeSources(sources: FallbackSource[]): FallbackSource[] {
  const result: FallbackSource[] = [];
  if (!Array.isArray(sources)) {
    return result;
  }
  for (const raw of sources) {
    const source: FallbackSource | null = normalizeSource(raw);
    if (source === null) {
      continue;
    }
    let duplicated: boolean = false;
    for (const kept of result) {
      if (isSameSource(kept, source)) {
        duplicated = true;
        break;
      }
    }
    if (!duplicated) {
      result.push(source);
    }
  }
  return result;
}

/** 归一尝试次数：非法回落 `DEFAULT_MAX_ATTEMPTS`，超范围夹到 `1..MAX_ATTEMPTS_LIMIT`。 */
export function normalizeMaxAttempts(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_MAX_ATTEMPTS;
  }
  const floor: number = Math.floor(value);
  if (floor < 1) {
    return 1;
  }
  if (floor > MAX_ATTEMPTS_LIMIT) {
    return MAX_ATTEMPTS_LIMIT;
  }
  return floor;
}

/**
 * 规划本次要尝试的源序列（**未开启 fallback 时只会返回主源**）。
 *
 * - `enabled !== true` → `[sources[0]]`（无主源 → `[]`）：没有任何「发给别家」的可能；
 * - 去重（同 provider + model 只留一次）后，尝试次数夹到 `1..去重后长度`；
 * - 主源恒为去重后的第一个（备用列表里重复出现的主源会被这条去重规则吃掉）。
 */
export function planFallback(sources: FallbackSource[], enabled: boolean, maxAttempts: number): FallbackSource[] {
  const list: FallbackSource[] = dedupeSources(sources);
  if (list.length === 0) {
    return [];
  }
  if (enabled !== true) {
    const primaryOnly: FallbackSource[] = [list[0]];
    return primaryOnly;
  }
  const limit: number = Math.min(normalizeMaxAttempts(maxAttempts), list.length);
  return list.slice(0, limit);
}

/** 单个源的展示名（`DeepSeek 官方 · deepseek-chat`），供界面与诊断文案用。 */
export function sourceLabel(source: FallbackSource): string {
  const modelId: string = normalizeModelId(source.modelId);
  const providerId: string = normalizeProviderId(source.providerId);
  if (providerId.length === 0) {
    return modelId.length > 0 ? modelId : '未知源';
  }
  const label: string = findProvider(providerId).label;
  return modelId.length > 0 ? `${label} · ${modelId}` : label;
}

/** 从任意 JSON 条目解析一个源（不认识的条目返回 `null`，绝不抛）。 */
function sourceFromEntry(entry: Object): FallbackSource | null {
  if (entry === null || entry === undefined || typeof entry !== 'object' || Array.isArray(entry)) {
    return null;
  }
  const bag: Record<string, Object> = entry as unknown as Record<string, Object>;
  const rawProvider: Object = bag['providerId'];
  const rawModel: Object = bag['modelId'];
  const providerId: string = normalizeProviderId(typeof rawProvider === 'string' ? rawProvider : '');
  if (providerId.length === 0) {
    return null;
  }
  // 源 id 必须是预设表里真实存在的（否则 `findProvider` 会静默回退 deepseek → 内容发给用户没选的供应商）
  if (findProvider(providerId).id !== providerId) {
    return null;
  }
  const rawModelText: string = normalizeModelId(typeof rawModel === 'string' ? rawModel : '');
  const modelId: string = rawModelText.length > 0 ? rawModelText : resolveModel(providerId, '');
  if (modelId.length === 0) {
    return null;
  }
  const rawBase: Object = bag['baseURL'];
  const baseURL: string = typeof rawBase === 'string' ? rawBase.trim() : '';
  const source: FallbackSource = { providerId: providerId, modelId: modelId };
  if (baseURL.length > 0) {
    source.baseURL = baseURL;
  }
  return source;
}

/**
 * 解析设置项里保存的备用源顺序（JSON 字符串）。
 *
 * 坏数据（空串 / 非 JSON / 非数组 / 条目缺字段 / 源 id 不在预设表）一律**逐条丢弃**，
 * 整体不可解析时返回 `[]`——绝不抛异常，也绝不把脏 id 交给运行器。最多保留
 * `MAX_FALLBACK_SOURCES` 条。
 */
export function parseFallbackOrder(raw: string): FallbackSource[] {
  const text: string = typeof raw === 'string' ? raw.trim() : '';
  const result: FallbackSource[] = [];
  if (text.length === 0) {
    return result;
  }
  let parsed: Object | null;
  try {
    parsed = JSON.parse(text) as Object | null;
  } catch {
    return result;
  }
  if (!Array.isArray(parsed)) {
    return result;
  }
  for (const entry of parsed as Object[]) {
    const source: FallbackSource | null = sourceFromEntry(entry);
    if (source === null) {
      continue;
    }
    let duplicated: boolean = false;
    for (const kept of result) {
      if (isSameSource(kept, source)) {
        duplicated = true;
        break;
      }
    }
    if (!duplicated) {
      result.push(source);
    }
    if (result.length >= MAX_FALLBACK_SOURCES) {
      break;
    }
  }
  return result;
}

/** 序列化备用源顺序（只写 `providerId` / `modelId` / 非空 `baseURL`；空列表 → `'[]'`）。 */
export function serializeFallbackOrder(sources: FallbackSource[]): string {
  const list: FallbackSource[] = dedupeSources(sources).slice(0, MAX_FALLBACK_SOURCES);
  const entries: FallbackSource[] = [];
  for (const source of list) {
    const entry: FallbackSource = { providerId: source.providerId, modelId: source.modelId };
    if (source.baseURL !== undefined && source.baseURL.length > 0) {
      entry.baseURL = source.baseURL;
    }
    entries.push(entry);
  }
  return JSON.stringify(entries);
}

/**
 * 值级脱敏：把「看起来就是凭据」的整段替换成 `***`（含键名，避免把 `api_key` 字样留在界面上）。
 *
 * 逐条规则（顺序有意义：先处理带引号的值，再处理裸值）：
 * 1. `sk-xxxx`（各家常见的 key 前缀）；
 * 2. `Bearer <cred>` / `Basic <cred>`（整个「方案 + 凭据」一起抹掉）；
 * 3. `token="…"` / `api_key='…'` 这类带引号的赋值；
 * 4. `token=…` / `apiKey: …` 这类裸值赋值。
 */
function maskSecretValues(text: string): string {
  let out: string = text;
  out = out.replace(/\bsk-[A-Za-z0-9_-]{4,}/g, '***');
  out = out.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{4,}/gi, '***');
  const names: string =
    '(?:authorization|x[-_]api[-_]key|api[-_]?key|apikey|access[-_]?key|secret|password|passwd|token)';
  out = out.replace(new RegExp(`\\b${names}\\b\\s*[:=]\\s*"[^"]*"`, 'gi'), '***');
  out = out.replace(new RegExp(`\\b${names}\\b\\s*[:=]\\s*'[^']*'`, 'gi'), '***');
  out = out.replace(new RegExp(`\\b${names}\\b\\s*[:=]\\s*[^\\s,;)]+`, 'gi'), '***');
  return out;
}

/** 词级脱敏（只用于自由文本 message）：残留的 `bearer` / `key` / `token` 单词也替换成 `***`。 */
function maskLooseWords(text: string): string {
  const names: string =
    '(?:bearer|authorization|token|api[-_]?key|apikey|key|secret|password|passwd|sk-[a-z0-9_-]+)';
  return text.replace(new RegExp(`\\b${names}\\b`, 'gi'), '***');
}

/** 截断到 `DIAGNOSTIC_MESSAGE_MAX` 字符（只截 message，不截源名）。 */
function truncateMessage(text: string): string {
  if (text.length <= DIAGNOSTIC_MESSAGE_MAX) {
    return text;
  }
  return text.slice(0, DIAGNOSTIC_MESSAGE_MAX);
}

/** 归一 outcome：未知值按 `abort` 处理（fail-closed，绝不让未知状态被当成 success）。 */
function normalizeOutcome(value: string): FallbackOutcome {
  const text: string = typeof value === 'string' ? value.trim() : '';
  if (text === 'success') {
    return 'success';
  }
  if (text === 'retry-same') {
    return 'retry-same';
  }
  if (text === 'next-source') {
    return 'next-source';
  }
  return 'abort';
}

/** 归一非负整数（耗时/序号；NaN、负数、小数都折成合法值）。 */
function nonNegativeInt(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }
  const floor: number = Math.floor(value);
  return floor > 0 ? floor : 0;
}

/**
 * 诊断脱敏：返回一份**可以上界面**的副本。
 *
 * - 所有字符串字段走值级脱敏（`sk-…` / `Bearer …` / `token=…` → `***`）；
 * - `message` 额外走词级脱敏并截断到 200 字符；
 * - `elapsedMs` / `attempt` 归一成非负整数，`outcome` 归一成四个合法值之一。
 */
export function sanitizeDiagnostic(diag: FallbackDiagnostic): FallbackDiagnostic {
  const providerId: string =
    typeof diag.providerId === 'string' ? maskSecretValues(diag.providerId.trim()) : '';
  const modelId: string = typeof diag.modelId === 'string' ? maskSecretValues(diag.modelId.trim()) : '';
  const category: string = typeof diag.category === 'string' ? maskSecretValues(diag.category.trim()) : '';
  const rawMessage: string = typeof diag.message === 'string' ? diag.message.trim() : '';
  const message: string = truncateMessage(maskLooseWords(maskSecretValues(rawMessage)));
  const sanitized: FallbackDiagnostic = {
    attempt: nonNegativeInt(diag.attempt),
    providerId: providerId,
    modelId: modelId,
    outcome: normalizeOutcome(diag.outcome),
    elapsedMs: nonNegativeInt(diag.elapsedMs),
    category: category.length > 0 ? category : KIND_UNKNOWN,
    message: message
  };
  return sanitized;
}

/** 汇总诊断：尝试次数 / 失败源清单（去重、保持顺序）/ 成功位置（`attempt` 序号）。 */
export function summarizeDiagnostics(list: FallbackDiagnostic[]): FallbackSummary {
  const failedSources: string[] = [];
  let attempts: number = 0;
  let succeededAt: number | null = null;
  if (!Array.isArray(list)) {
    const empty: FallbackSummary = { attempts: 0, failedSources: failedSources, succeededAt: null };
    return empty;
  }
  for (let index = 0; index < list.length; index++) {
    const diag: FallbackDiagnostic = list[index];
    if (diag === null || diag === undefined) {
      continue;
    }
    attempts++;
    const outcome: FallbackOutcome = normalizeOutcome(diag.outcome);
    if (outcome === 'success') {
      if (succeededAt === null) {
        const attempt: number = nonNegativeInt(diag.attempt);
        succeededAt = attempt > 0 ? attempt : attempts;
      }
      continue;
    }
    const providerId: string = typeof diag.providerId === 'string' ? diag.providerId.trim() : '';
    if (providerId.length > 0 && failedSources.indexOf(providerId) < 0) {
      failedSources.push(providerId);
    }
  }
  const summary: FallbackSummary = {
    attempts: attempts,
    failedSources: failedSources,
    succeededAt: succeededAt
  };
  return summary;
}
