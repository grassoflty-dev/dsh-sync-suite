/**
 * OpenAI 兼容的聊天补全请求（Node 侧，**不引 SDK**，只用全局 `fetch`）。
 *
 * 与 App `model/aiRequest.ts` 同契约：
 * - 端点 = `{baseURL}/chat/completions`（已含该后缀时不重复拼）；
 * - 请求体 `{model, messages, temperature: 0.2, max_tokens, stream: false}`；
 * - 回复取 `choices[0].message.content`，缺字段给明确中文错误。
 *
 * 安全：**本文件不打印、不返回任何请求头**；key 只出现在 `Authorization` 头里，
 * 且所有对外错误文案都由 `classifyAiError` 生成（不含 key 片段）。
 */

/** 默认接口基地址（与 App 一致）。 */
export const DEFAULT_AI_BASE_URL = 'https://api.deepseek.com'
/** 默认模型名（与 App 一致）。 */
export const DEFAULT_AI_MODEL = 'deepseek-chat'
/** 聊天补全路径。 */
export const AI_CHAT_PATH = '/chat/completions'
/** 单次请求整体超时（毫秒），与 App 一致。 */
export const AI_TIMEOUT_MS = 20000
/** 汇总请求的 max_tokens。 */
export const AI_DEFAULT_MAX_TOKENS = 2000

/** 伪状态码：网络层失败（没拿到 HTTP 响应）。 */
export const AI_STATUS_NETWORK = 0
/** 伪状态码：整体超时。 */
export const AI_STATUS_TIMEOUT = -1

export interface AiRequest {
  url: string
  body: string
  timeoutMs: number
}

/** 拼聊天补全 URL：去尾斜杠，已含 `/chat/completions` 时原样用。 */
export function aiChatUrl(baseUrl: string): string {
  const base = typeof baseUrl === 'string' ? baseUrl.trim() : ''
  if (base.length === 0) throw new Error('AI 接口地址不能为空')
  if (!/^https?:\/\//i.test(base)) throw new Error(`AI 接口地址必须以 http:// 或 https:// 开头：${base}`)
  let text = base
  while (text.endsWith('/')) text = text.slice(0, text.length - 1)
  if (text.toLowerCase().endsWith(AI_CHAT_PATH)) return text
  return `${text}${AI_CHAT_PATH}`
}

/** 构造一次聊天补全请求（不发网络请求）。 */
export function buildAiRequest(
  baseUrl: string,
  model: string,
  prompt: string,
  maxTokens: number = AI_DEFAULT_MAX_TOKENS,
  systemPrompt = '',
): AiRequest {
  const text = typeof prompt === 'string' ? prompt.trim() : ''
  if (text.length === 0) throw new Error('AI 提示词不能为空')
  const name = typeof model === 'string' && model.trim().length > 0 ? model.trim() : DEFAULT_AI_MODEL
  const messages: Array<{ role: string; content: string }> = []
  const system = typeof systemPrompt === 'string' ? systemPrompt.trim() : ''
  if (system.length > 0) messages.push({ role: 'system', content: system })
  messages.push({ role: 'user', content: text })
  const body = JSON.stringify({
    model: name,
    messages,
    temperature: 0.2,
    max_tokens: maxTokens > 0 ? maxTokens : AI_DEFAULT_MAX_TOKENS,
    stream: false,
  })
  return { url: aiChatUrl(baseUrl), body, timeoutMs: AI_TIMEOUT_MS }
}

/** 从错误响应体里尽量取出可读原因（前缀中文冒号，无内容返回空串）。 */
function aiErrorDetail(bodyText: string): string {
  const text = typeof bodyText === 'string' ? bodyText.trim() : ''
  if (text.length === 0) return ''
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } } | null
    const message = parsed?.error?.message
    if (typeof message === 'string' && message.trim().length > 0) return `：${message.trim()}`
  } catch {
    /* 非 JSON：按原文截断展示 */
  }
  return `：${text.length > 160 ? `${text.slice(0, 160)}…` : text}`
}

/** 把 HTTP 状态码（或伪状态码 0 / -1）映射成中文文案；不含 key。 */
export function classifyAiError(status: number, bodyText: string, providerLabel = 'AI 服务'): string {
  const label = providerLabel.trim() !== '' ? providerLabel : 'AI 服务'
  switch (status) {
    case 200:
      return ''
    case AI_STATUS_TIMEOUT:
      return `${label} 请求超时（${AI_TIMEOUT_MS / 1000} 秒内没有响应）：请检查网络后重试`
    case AI_STATUS_NETWORK:
      return `${label} 网络异常：无法连接接口（请检查网络、代理或防火墙）${aiErrorDetail(bodyText)}`
    case 400:
      return `${label} 400：请求无效，请检查模型名${aiErrorDetail(bodyText)}`
    case 401:
      return `${label} 401：密钥无效或已失效${aiErrorDetail(bodyText)}`
    case 402:
      return `${label} 402：余额不足${aiErrorDetail(bodyText)}`
    case 403:
      return `${label} 403：无访问权限${aiErrorDetail(bodyText)}`
    case 404:
      return `${label} 404：接口不存在，请检查模型名或接口地址${aiErrorDetail(bodyText)}`
    case 422:
      return `${label} 422：参数错误，请检查模型名与 max_tokens${aiErrorDetail(bodyText)}`
    case 429:
      return `${label} 429：请求过于频繁或额度超限，请稍后重试${aiErrorDetail(bodyText)}`
    default:
      break
  }
  if (status >= 500) return `${label} ${status}：服务端错误，请稍后重试${aiErrorDetail(bodyText)}`
  if (status >= 400) return `${label} ${status}：请求失败${aiErrorDetail(bodyText)}`
  return `${label} ${status}：未知响应${aiErrorDetail(bodyText)}`
}

/** 解析聊天补全响应，返回 `choices[0].message.content`（已 trim）。 */
export function parseAiReply(jsonText: string): string {
  const text = typeof jsonText === 'string' ? jsonText.trim() : ''
  if (text.length === 0) throw new Error('AI 返回内容为空（响应体为空）')
  let parsed: { choices?: Array<{ message?: { content?: unknown } }> } | null
  try {
    parsed = JSON.parse(text) as { choices?: Array<{ message?: { content?: unknown } }> } | null
  } catch {
    throw new Error('AI 返回内容不是合法 JSON（可能被网关截断或需要登录）')
  }
  const choices = parsed?.choices
  if (!Array.isArray(choices) || choices.length === 0) throw new Error('AI 返回内容缺少 choices 字段')
  const content = choices[0]?.message?.content
  if (typeof content !== 'string') throw new Error('AI 返回内容缺少 choices[0].message.content（不是字符串）')
  const trimmed = content.trim()
  if (trimmed.length === 0) throw new Error('AI 返回内容为空（content 为空）')
  return trimmed
}
