/**
 * DeepSeek 请求/响应的纯逻辑（不 import 任何 SDK，可在 Node 直接跑）。
 *
 * 契约（P2 + B2 参数 + B3 可靠性 + B4 用量）：
 * - `buildAiRequest` 只负责拼 URL 与 JSON 请求体（`model` + `messages` + 采样参数），不发网络请求；
 * - `AiOptions`（`temperature` / `maxTokens` / `timeoutMs` / `retries`）默认 **0.7 / 1024 / 30000 / 1**，
 *   逐字段校验：类型不对或超范围回落默认/夹到边界，绝不把 NaN 写进请求体；
 * - `classifyAiError` 把 HTTP 状态/网络异常映射成**中文**文案（页面直接展示）；源名由调用方
 *   经 `providerLabel` 传入，缺省「AI 服务」——本模块不认识任何具体服务商；
 * - `shouldRetry` 只对「网络错误 / 429 / 5xx」放行重试（超时不重试，避免用户白等两倍时间）；
 * - `shouldFallback` 判断「换个源还有救吗」：超时(-1)/网络(0)/429/5xx 才切备用源；
 *   401/403/404/400 换源也没用，直接失败；
 * - `runWithFallback` 编排主源 + 备用源：**只切一次**，备用也失败就抛 `AiFallbackError`
 *   （message 里同时带主源错误与备用源错误，页面直接展示）；
 * - `parseAiReply` 取 `choices[0].message.content`，缺字段给出明确中文错误；
 * - `parseUsage` / `describeUsage` 把响应的 `usage` 折成「输入 120 / 输出 340 tokens」。
 *
 * 注意：本文件永远不接触 API Key 的值，key 只出现在 services 层的请求头里。
 */

/** 默认接口基地址。 */
export const DEFAULT_AI_BASE_URL: string = 'https://api.deepseek.com';
/** 默认模型名（设置页可改）。 */
export const DEFAULT_AI_MODEL: string = 'deepseek-chat';
/** 聊天补全的路径。 */
export const AI_CHAT_PATH: string = '/chat/completions';
/** 单次请求整体超时默认值（毫秒）：B2 定为 30 秒。 */
export const AI_TIMEOUT_MS: number = 30000;
/** 可重试错误的退避时长（毫秒）：默认只重试 1 次。 */
export const AI_RETRY_BACKOFF_MS: number = 1000;
/** 采样温度默认值（整理任务要稳定，取 0.7）。 */
export const AI_DEFAULT_TEMPERATURE: number = 0.7;
/** 汇总请求的 max_tokens 默认值。 */
export const AI_DEFAULT_MAX_TOKENS: number = 1024;
/** 自动重试次数默认值（不含首次请求）。 */
export const AI_DEFAULT_RETRIES: number = 1;
/** 参数允许范围（防止手填出离谱值）。 */
export const AI_MIN_TEMPERATURE: number = 0;
export const AI_MAX_TEMPERATURE: number = 2;
export const AI_MIN_TIMEOUT_MS: number = 1000;
export const AI_MAX_TIMEOUT_MS: number = 180000;
export const AI_MIN_MAX_TOKENS: number = 1;
export const AI_MAX_MAX_TOKENS: number = 32000;
export const AI_MIN_RETRIES: number = 0;
export const AI_MAX_RETRIES: number = 3;
/** 连通性测试用的最小提示词。 */
export const AI_PROBE_PROMPT: string = 'ping';
/** 连通性测试的 max_tokens（真实发一次最小请求，8 个 token 足够验证鉴权与路由）。 */
export const AI_PROBE_MAX_TOKENS: number = 8;
/** 伪状态码：网络层失败（没拿到 HTTP 响应）。 */
export const AI_STATUS_NETWORK: number = 0;
/** 伪状态码：整体超时。 */
export const AI_STATUS_TIMEOUT: number = -1;
/** 成功状态码。 */
export const AI_STATUS_OK: number = 200;
/** 错误文案里的缺省源名（调用方可用 `providerLabel` 覆盖成具体服务商）。 */
export const AI_SERVICE_LABEL: string = 'AI 服务';
/** 错误响应体在文案里的最大截断长度。 */
export const AI_ERROR_SNIPPET_MAX: number = 160;

/** 一次请求的采样/超时/重试参数（B2）。 */
export interface AiOptions {
  /** 采样温度 0–2。 */
  temperature: number;
  /** 输出 token 上限。 */
  maxTokens: number;
  /** 单次请求整体超时（毫秒）。 */
  timeoutMs: number;
  /** 自动重试次数（不含首次请求）。 */
  retries: number;
}

/** 用量（OpenAI 兼容响应的 `usage` 归一后）。 */
export interface AiUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** 一次请求所需的全部信息（由 services 层直接消费）。 */
export interface AiRequest {
  /** 完整端点 URL。 */
  url: string;
  /** JSON 请求体文本（已序列化）。 */
  body: string;
  /** 整体超时（毫秒）。 */
  timeoutMs: number;
  /** 自动重试次数（不含首次请求）。 */
  retries: number;
}

/** 消息体（system 可选 + user 一条）。 */
interface AiMessage {
  role: string;
  content: string;
}

/** 请求体（ArkTS 要求对象字面量有明确类型，故定义成类）。 */
class AiRequestBody {
  model: string = DEFAULT_AI_MODEL;
  messages: AiMessage[] = [];
  temperature: number = AI_DEFAULT_TEMPERATURE;
  max_tokens: number = AI_DEFAULT_MAX_TOKENS;
  stream: boolean = false;
}

/** 错误响应体（OpenAI 兼容格式）。 */
interface AiErrorBody {
  message?: string;
  type?: string;
  code?: string;
}

/** 响应里的单条消息。 */
interface AiChoiceMessage {
  role?: string;
  content?: string;
}

/** 响应里的单个 choice。 */
interface AiChoice {
  message?: AiChoiceMessage;
  finish_reason?: string;
}

/** 响应里的 usage 原始字段（snake_case，OpenAI 兼容）。 */
interface AiUsageBody {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

/** 响应体。 */
interface AiResponse {
  choices?: AiChoice[];
  error?: AiErrorBody;
  usage?: AiUsageBody;
}

/** 解析后的回复（正文 + 用量 + 结束原因）。 */
export interface AiReply {
  /** `choices[0].message.content`（已 trim）。 */
  text: string;
  /** 响应里的 usage（缺失/全 0 时 null）。 */
  usage: AiUsage | null;
  /** `choices[0].finish_reason`（缺失时空串）。 */
  finishReason: string;
}

/** 一次尝试的结果（services 层把网络失败也折成这个结构，供 `runWithFallback` 判定）。 */
export interface AiAttemptOutcome {
  /** 是否成功拿到可用正文。 */
  ok: boolean;
  /** HTTP 状态码；网络失败 `0`、超时 `-1`。 */
  status: number;
  /** 成功时的正文（失败为空串）。 */
  text: string;
  /** 失败时的中文原因（成功为空串）。 */
  error: string;
  /** 用量（拿不到时 null）。 */
  usage: AiUsage | null;
  /** 本次尝试耗时（毫秒）。 */
  elapsedMs: number;
  /** 实际使用的源 id。 */
  providerId: string;
  /** 实际使用的模型名。 */
  model: string;
}

/** 主源 / 备用源各自的「发一次请求」实现（注入便于测试与避免循环依赖）。 */
export type AiAttemptFn = () => Promise<AiAttemptOutcome>;

/** 主源（必要时切一次备用源）后的最终结果。 */
export interface AiFallbackOutcome {
  /** 恒为 true（失败走抛异常，不会返回半成功结果）。 */
  ok: boolean;
  /** 正文。 */
  text: string;
  /** 是否用了备用源（只可能切一次）。 */
  usedFallback: boolean;
  /** 实际产出正文的源 id。 */
  providerId: string;
  /** 实际产出正文的模型名。 */
  model: string;
  /** 总耗时（主源 + 备用源，毫秒）。 */
  elapsedMs: number;
  /** 正文对应的 usage（拿不到时 null）。 */
  usage: AiUsage | null;
  /** 主源失败原因（`usedFallback=false` 时为空串）。 */
  primaryError: string;
  /** 备用源失败原因（成功时为空串）。 */
  fallbackError: string;
}

/**
 * 主备都失败时的错误：message 同时带主源错误与备用源错误（页面直接展示，不必再拼）。
 *
 * 选择「抛异常」而不是「返回 {ok:false}」：调用方（`summarize` / 页面）现有的错误路径都是
 * `try/catch + describeError`，抛错不用改任何调用点；同时错误对象上保留两个字段，便于排障。
 */
export class AiFallbackError extends Error {
  primaryMessage: string = '';
  fallbackMessage: string = '';
  /** 备用源的失败状态码（超时 -1 / 网络 0 / HTTP）。 */
  status: number = 0;
  providerId: string = '';
  fallbackProviderId: string = '';

  constructor(primary: AiAttemptOutcome, fallback: AiAttemptOutcome) {
    super(`${primary.error}；备用源 ${fallback.providerId} 也失败：${fallback.error}`);
    this.name = 'AiFallbackError';
    this.primaryMessage = primary.error;
    this.fallbackMessage = fallback.error;
    this.status = fallback.status;
    this.providerId = primary.providerId;
    this.fallbackProviderId = fallback.providerId;
  }
}

/** 默认参数（每次返回新对象，避免调用方改到共享常量）。 */
export function defaultAiOptions(): AiOptions {
  const options: AiOptions = {
    temperature: AI_DEFAULT_TEMPERATURE,
    maxTokens: AI_DEFAULT_MAX_TOKENS,
    timeoutMs: AI_TIMEOUT_MS,
    retries: AI_DEFAULT_RETRIES
  };
  return options;
}

/** 数字归一：类型不对/NaN 回落默认，超范围夹到边界。 */
function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

/**
 * 归一参数表：逐字段校验后返回完整 `AiOptions`。
 *
 * `null`/`undefined` 直接返回默认值；字段缺失（老调用点只传了部分字段）也按默认处理。
 */
export function normalizeAiOptions(raw: AiOptions | null): AiOptions {
  const defaults: AiOptions = defaultAiOptions();
  if (raw === null || raw === undefined) {
    return defaults;
  }
  const options: AiOptions = {
    temperature: clampNumber(raw.temperature, AI_MIN_TEMPERATURE, AI_MAX_TEMPERATURE, defaults.temperature),
    maxTokens: Math.floor(clampNumber(raw.maxTokens, AI_MIN_MAX_TOKENS, AI_MAX_MAX_TOKENS, defaults.maxTokens)),
    timeoutMs: Math.floor(clampNumber(raw.timeoutMs, AI_MIN_TIMEOUT_MS, AI_MAX_TIMEOUT_MS, defaults.timeoutMs)),
    retries: Math.floor(clampNumber(raw.retries, AI_MIN_RETRIES, AI_MAX_RETRIES, defaults.retries))
  };
  return options;
}

/**
 * 拼出聊天补全的完整 URL：
 * - 基地址末尾的 `/` 会被去掉；
 * - 已经以 `/chat/completions` 结尾时原样使用（允许用户填完整端点）。
 *
 * 基地址为空或不是 http(s) 时抛错。
 */
export function aiChatUrl(baseUrl: string): string {
  const base: string = typeof baseUrl === 'string' ? baseUrl.trim() : '';
  if (base.length === 0) {
    throw new Error('AI 接口地址不能为空');
  }
  if (!/^https?:\/\//i.test(base)) {
    throw new Error(`AI 接口地址必须以 http:// 或 https:// 开头：${base}`);
  }
  let text: string = base;
  while (text.endsWith('/')) {
    text = text.slice(0, text.length - 1);
  }
  if (text.toLowerCase().endsWith(AI_CHAT_PATH)) {
    return text;
  }
  return `${text}${AI_CHAT_PATH}`;
}

/**
 * 构造一次聊天补全请求（不发网络请求）。
 *
 * @param baseUrl 基地址（`https://api.deepseek.com`）或完整端点
 * @param model   模型名，空串回退 `deepseek-chat`
 * @param prompt  用户提示词，空串抛错
 * @param options 采样/超时/重试参数（`null` 用默认值；非法字段逐项回落默认）
 * @param systemPrompt 可选的 system 消息（非空时作为第一条 message）
 */
export function buildAiRequest(
  baseUrl: string,
  model: string,
  prompt: string,
  options: AiOptions | null = null,
  systemPrompt: string = ''
): AiRequest {
  const text: string = typeof prompt === 'string' ? prompt.trim() : '';
  if (text.length === 0) {
    throw new Error('AI 提示词不能为空');
  }
  const name: string = typeof model === 'string' && model.trim().length > 0 ? model.trim() : DEFAULT_AI_MODEL;
  const system: string = typeof systemPrompt === 'string' ? systemPrompt.trim() : '';
  const resolved: AiOptions = normalizeAiOptions(options);
  const messages: AiMessage[] = [];
  if (system.length > 0) {
    messages.push({ role: 'system', content: system });
  }
  messages.push({ role: 'user', content: text });
  const requestBody = new AiRequestBody();
  requestBody.model = name;
  requestBody.messages = messages;
  requestBody.temperature = resolved.temperature;
  requestBody.max_tokens = resolved.maxTokens;
  requestBody.stream = false;
  const request: AiRequest = {
    url: aiChatUrl(baseUrl),
    body: JSON.stringify(requestBody),
    timeoutMs: resolved.timeoutMs,
    retries: resolved.retries
  };
  return request;
}

/** 从错误响应体里尽量取出可读原因（前缀带中文冒号，无内容返回空串）。 */
function aiErrorDetail(bodyText: string): string {
  const text: string = typeof bodyText === 'string' ? bodyText.trim() : '';
  if (text.length === 0) {
    return '';
  }
  try {
    const parsed: AiResponse | null = JSON.parse(text) as AiResponse | null;
    if (parsed !== null && parsed.error !== undefined && typeof parsed.error.message === 'string') {
      const message: string = parsed.error.message.trim();
      if (message.length > 0) {
        return `：${message}`;
      }
    }
  } catch {
    // 非 JSON：下面按原文截断展示
  }
  const snippet: string = text.length > AI_ERROR_SNIPPET_MAX ? `${text.slice(0, AI_ERROR_SNIPPET_MAX)}…` : text;
  return `：${snippet}`;
}

/**
 * 把 HTTP 状态码（或伪状态码 `0` 网络错误 / `-1` 超时）映射成中文文案。
 *
 * 本模块不认识具体服务商：源名由调用方经 `providerLabel` 传入，缺省用中性的「AI 服务」。
 *
 * @param status   HTTP 状态码；`AI_STATUS_NETWORK`（0）= 网络层失败，`AI_STATUS_TIMEOUT`（-1）= 超时
 * @param bodyText 响应体文本（用于提取 `error.message`，可为空）
 * @param providerLabel 源名（如 `OpenCode Go`），空白/缺省 → `AI 服务`
 * @returns 中文文案；状态码 200 返回空串（没有错误）
 */
export function classifyAiError(status: number, bodyText: string, providerLabel: string = AI_SERVICE_LABEL): string {
  const label: string =
    typeof providerLabel === 'string' && providerLabel.trim().length > 0 ? providerLabel.trim() : AI_SERVICE_LABEL;
  switch (status) {
    case AI_STATUS_OK:
      return '';
    case AI_STATUS_TIMEOUT:
      return `${label} 请求超时（${AI_TIMEOUT_MS / 1000} 秒内没有响应）：请检查网络后重试，或换一个网络环境`;
    case AI_STATUS_NETWORK:
      return `${label} 网络异常：无法连接接口（请检查网络、代理或防火墙）${aiErrorDetail(bodyText)}`;
    case 400:
      return `${label} 400：请求无效，请检查模型名${aiErrorDetail(bodyText)}`;
    case 401:
      return `${label} 401：密钥无效或已失效，请到设置页重新填写${aiErrorDetail(bodyText)}`;
    case 402:
      return `${label} 402：余额不足，请到服务商控制台充值${aiErrorDetail(bodyText)}`;
    case 403:
      return `${label} 403：无访问权限，该密钥没有调用该模型的权限${aiErrorDetail(bodyText)}`;
    case 404:
      return `${label} 404：接口不存在，请检查模型名或接口地址${aiErrorDetail(bodyText)}`;
    case 422:
      return `${label} 422：参数错误，请检查模型名与 max_tokens${aiErrorDetail(bodyText)}`;
    case 429:
      return `${label} 429：请求过于频繁或额度超限，请稍后重试${aiErrorDetail(bodyText)}`;
    default:
      break;
  }
  if (status >= 500) {
    return `${label} ${status}：服务端错误，服务暂时不可用，请稍后重试${aiErrorDetail(bodyText)}`;
  }
  if (status >= 400) {
    return `${label} ${status}：请求失败${aiErrorDetail(bodyText)}`;
  }
  return `${label} ${status}：未知响应${aiErrorDetail(bodyText)}`;
}

/**
 * 该状态是否值得退避重试一次。
 *
 * 只放行：网络错误（0）、429、5xx。超时（-1）**不重试**：单次已等 30 秒，再等一轮只会让用户
 * 多等一倍；401/403/404/400 这类确定性错误重试也没有意义。
 */
export function shouldRetry(status: number): boolean {
  if (status === AI_STATUS_NETWORK) {
    return true;
  }
  if (status === 429) {
    return true;
  }
  return status >= 500 && status <= 599;
}

/**
 * 主源失败后是否值得换备用源（B3）。
 *
 * - `-1` 超时 / `0` 网络失败 / `429` 限流 / `5xx` 服务端错误 → true（换源可能立刻成功）；
 * - `400/401/403/404` → false：key 错、没权限、模型名/地址错，换源解决不了，只会多等一次；
 * - 其余（含 2xx、402、422 等未列出状态）→ false，按「不切换」保守处理。
 */
export function shouldFallback(status: number): boolean {
  if (status === AI_STATUS_TIMEOUT) {
    return true;
  }
  if (status === AI_STATUS_NETWORK) {
    return true;
  }
  if (status === 429) {
    return true;
  }
  return status >= 500;
}

/**
 * 编排「主源 → 备用源」：主源成功直接返回；主源失败且 `shouldFallback(status)` 且配了备用源时
 * **只切一次**；备用也失败就抛 `AiFallbackError`（不再尝试第三次）。
 *
 * @param primaryAttempt  主源请求（返回结构化结果，不抛异常）
 * @param fallbackAttempt 备用源请求；`null` = 没配备用源
 */
export async function runWithFallback(
  primaryAttempt: AiAttemptFn,
  fallbackAttempt: AiAttemptFn | null
): Promise<AiFallbackOutcome> {
  const primary: AiAttemptOutcome = await primaryAttempt();
  if (primary.ok) {
    const primaryOnly: AiFallbackOutcome = {
      ok: true,
      text: primary.text,
      usedFallback: false,
      providerId: primary.providerId,
      model: primary.model,
      elapsedMs: primary.elapsedMs,
      usage: primary.usage,
      primaryError: '',
      fallbackError: ''
    };
    return primaryOnly;
  }
  if (fallbackAttempt === null || !shouldFallback(primary.status)) {
    throw new Error(primary.error);
  }
  const fallback: AiAttemptOutcome = await fallbackAttempt();
  if (fallback.ok) {
    const usedFallback: AiFallbackOutcome = {
      ok: true,
      text: fallback.text,
      usedFallback: true,
      providerId: fallback.providerId,
      model: fallback.model,
      elapsedMs: primary.elapsedMs + fallback.elapsedMs,
      usage: fallback.usage,
      primaryError: primary.error,
      fallbackError: ''
    };
    return usedFallback;
  }
  throw new AiFallbackError(primary, fallback);
}

/** 去掉首尾空白；非字符串一律空串。 */
function trimmed(value: string): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 解析响应里的 usage（缺失、非数字或全 0 返回 null）。
 *
 * 兼容 `prompt_tokens` / `completion_tokens` / `total_tokens`；`total_tokens` 缺失时用两者之和补。
 */
export function parseUsage(jsonText: string): AiUsage | null {
  const text: string = trimmed(jsonText);
  if (text.length === 0) {
    return null;
  }
  let parsed: AiResponse | null;
  try {
    parsed = JSON.parse(text) as AiResponse | null;
  } catch {
    return null;
  }
  if (parsed === null || parsed.usage === undefined || parsed.usage === null) {
    return null;
  }
  const body: AiUsageBody = parsed.usage;
  const promptTokens: number =
    typeof body.prompt_tokens === 'number' && Number.isFinite(body.prompt_tokens)
      ? Math.max(0, Math.floor(body.prompt_tokens))
      : 0;
  const completionTokens: number =
    typeof body.completion_tokens === 'number' && Number.isFinite(body.completion_tokens)
      ? Math.max(0, Math.floor(body.completion_tokens))
      : 0;
  const totalRaw: number =
    typeof body.total_tokens === 'number' && Number.isFinite(body.total_tokens)
      ? Math.max(0, Math.floor(body.total_tokens))
      : 0;
  if (promptTokens === 0 && completionTokens === 0 && totalRaw === 0) {
    return null;
  }
  const usage: AiUsage = {
    promptTokens: promptTokens,
    completionTokens: completionTokens,
    totalTokens: totalRaw > 0 ? totalRaw : promptTokens + completionTokens
  };
  return usage;
}

/**
 * 用量的展示文案：`输入 120 / 输出 340 tokens`。
 *
 * null / 全 0 返回空串（界面据此决定是否显示这一行，不必判空）。
 */
export function describeUsage(usage: AiUsage | null): string {
  if (usage === null || usage === undefined) {
    return '';
  }
  const promptTokens: number = Math.max(0, Math.floor(usage.promptTokens));
  const completionTokens: number = Math.max(0, Math.floor(usage.completionTokens));
  if (promptTokens === 0 && completionTokens === 0) {
    return '';
  }
  return `输入 ${promptTokens} / 输出 ${completionTokens} tokens`;
}

/**
 * 解析聊天补全响应，返回正文 + usage + finish_reason。
 * 非 JSON、缺 `choices`、缺 `content`、content 为空都抛带中文 message 的 `Error`。
 */
export function parseAiReplyFull(jsonText: string): AiReply {
  const text: string = trimmed(jsonText);
  if (text.length === 0) {
    throw new Error('AI 返回内容为空（响应体为空）');
  }
  let parsed: AiResponse | null;
  try {
    parsed = JSON.parse(text) as AiResponse | null;
  } catch {
    throw new Error('AI 返回内容不是合法 JSON（可能被网关截断或需要登录）');
  }
  if (parsed === null || parsed.choices === undefined || !Array.isArray(parsed.choices) || parsed.choices.length === 0) {
    throw new Error(`AI 返回内容缺少 choices 字段${aiErrorDetail(text)}`);
  }
  const first: AiChoice | undefined = parsed.choices[0];
  if (first === undefined || first.message === undefined) {
    throw new Error('AI 返回内容缺少 choices[0].message（响应结构不完整）');
  }
  const content: string | undefined = first.message.content;
  if (typeof content !== 'string') {
    throw new Error('AI 返回内容缺少 choices[0].message.content（content 不是字符串）');
  }
  const replyText: string = content.trim();
  if (replyText.length === 0) {
    throw new Error('AI 返回内容为空（content 为空）');
  }
  const finishReason: string = typeof first.finish_reason === 'string' ? first.finish_reason : '';
  const reply: AiReply = {
    text: replyText,
    usage: parseUsage(text),
    finishReason: finishReason
  };
  return reply;
}

/**
 * 解析聊天补全响应，返回 `choices[0].message.content`（已 trim）。
 * 非 JSON、缺 `choices`、缺 `content`、content 为空都抛带中文 message 的 `Error`。
 */
export function parseAiReply(jsonText: string): string {
  return parseAiReplyFull(jsonText).text;
}

/**
 * 连通性测试结果的展示文案（不含 key 的任何片段）。
 *
 * 成功：`成功：HTTP 200 / 模型 deepseek-chat`；
 * 失败：`失败：密钥无效（HTTP 401）…` / `失败：请求超时…` / `失败：请求过于频繁…`。
 */
export function describeAiTestResult(okFlag: boolean, status: number, model: string, errorText: string): string {
  const name: string = typeof model === 'string' && model.trim().length > 0 ? model.trim() : DEFAULT_AI_MODEL;
  if (okFlag) {
    return `成功：HTTP ${status} / 模型 ${name}`;
  }
  const reason: string = typeof errorText === 'string' ? errorText.trim() : '';
  if (reason.length > 0) {
    return `失败：${reason}`;
  }
  return `失败：${classifyAiError(status, '')}`;
}
