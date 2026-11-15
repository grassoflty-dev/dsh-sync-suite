/**
 * DeepSeek 请求/响应的纯逻辑（不 import 任何 SDK，可在 Node 直接跑）。
 *
 * 契约（P2）：
 * - `buildAiRequest` 只负责拼 URL 与 JSON 请求体（`model` + `messages`），不发网络请求；
 * - `classifyAiError` 把 HTTP 状态/网络异常映射成**中文**文案（页面直接展示）；源名由调用方
 *   经 `providerLabel` 传入，缺省「AI 服务」——本模块不认识任何具体服务商；
 * - `shouldRetry` 只对「网络错误 / 429 / 5xx」放行重试（超时不重试，避免用户白等两倍时间）；
 * - `parseAiReply` 取 `choices[0].message.content`，缺字段给出明确中文错误。
 *
 * 注意：本文件永远不接触 API Key 的值，key 只出现在 services 层的请求头里。
 */

/** 默认接口基地址。 */
export const DEFAULT_AI_BASE_URL: string = 'https://api.deepseek.com';
/** 默认模型名（设置页可改）。 */
export const DEFAULT_AI_MODEL: string = 'deepseek-chat';
/** 聊天补全的路径。 */
export const AI_CHAT_PATH: string = '/chat/completions';
/** 单次请求整体超时（毫秒）。 */
export const AI_TIMEOUT_MS: number = 20000;
/** 可重试错误的退避时长（毫秒）：只重试 1 次。 */
export const AI_RETRY_BACKOFF_MS: number = 1000;
/** 汇总请求的 max_tokens 默认值。 */
export const AI_DEFAULT_MAX_TOKENS: number = 2000;
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

/** 一次请求所需的全部信息（由 services 层直接消费）。 */
export interface AiRequest {
  /** 完整端点 URL。 */
  url: string;
  /** JSON 请求体文本（已序列化）。 */
  body: string;
  /** 整体超时（毫秒）。 */
  timeoutMs: number;
}

/** 消息体（只有 user 一条，system 约束已写进 prompt 文本）。 */
interface AiMessage {
  role: string;
  content: string;
}

/** 请求体（ArkTS 要求对象字面量有明确类型，故定义成类）。 */
class AiRequestBody {
  model: string = DEFAULT_AI_MODEL;
  messages: AiMessage[] = [];
  temperature: number = 0.2;
  max_tokens: number = AI_DEFAULT_MAX_TOKENS;
  stream: boolean = false;
}

/** 错误响应体（DeepSeek 的 OpenAI 兼容格式）。 */
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

/** 响应体。 */
interface AiResponse {
  choices?: AiChoice[];
  error?: AiErrorBody;
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
 * @param maxTokens 输出上限，<=0 时回退默认值
 * @param systemPrompt 可选的 system 消息（非空时作为第一条 message）
 */
export function buildAiRequest(
  baseUrl: string,
  model: string,
  prompt: string,
  maxTokens: number = AI_DEFAULT_MAX_TOKENS,
  systemPrompt: string = ''
): AiRequest {
  const text: string = typeof prompt === 'string' ? prompt.trim() : '';
  if (text.length === 0) {
    throw new Error('AI 提示词不能为空');
  }
  const name: string = typeof model === 'string' && model.trim().length > 0 ? model.trim() : DEFAULT_AI_MODEL;
  const system: string = typeof systemPrompt === 'string' ? systemPrompt.trim() : '';
  const messages: AiMessage[] = [];
  if (system.length > 0) {
    messages.push({ role: 'system', content: system });
  }
  messages.push({ role: 'user', content: text });
  const requestBody = new AiRequestBody();
  requestBody.model = name;
  requestBody.messages = messages;
  requestBody.max_tokens = maxTokens > 0 ? maxTokens : AI_DEFAULT_MAX_TOKENS;
  const request: AiRequest = {
    url: aiChatUrl(baseUrl),
    body: JSON.stringify(requestBody),
    timeoutMs: AI_TIMEOUT_MS
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
 * 只放行：网络错误（0）、429、5xx。超时（-1）**不重试**：单次已等 20 秒，再等一轮只会让用户
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
 * 解析聊天补全响应，返回 `choices[0].message.content`（已 trim）。
 * 非 JSON、缺 `choices`、缺 `content`、content 为空都抛带中文 message 的 `Error`。
 */
export function parseAiReply(jsonText: string): string {
  const text: string = typeof jsonText === 'string' ? jsonText.trim() : '';
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
  const trimmed: string = content.trim();
  if (trimmed.length === 0) {
    throw new Error('AI 返回内容为空（content 为空）');
  }
  return trimmed;
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
