/**
 * DeepSeek 请求/响应的纯逻辑（不 import 任何 SDK，可在 Node 直接跑）。
 *
 * 契约（P2 + B2 参数 + B3 可靠性 + B4 用量）：
 * - `buildAiRequest` 只负责拼 URL 与 JSON 请求体（`model` + `messages` + 采样参数），不发网络请求；
 * - `AiOptions`（`temperature` / `maxTokens` / `timeoutMs` / `retries`）默认 **0.7 / 1024 / 30000 / 1**，
 *   逐字段校验：类型不对或超范围回落默认/夹到边界，绝不把 NaN 写进请求体；
 * - `clampAiTimeout` 是「整体超时」的**有效值**归一（发请求前调用）：下限 = `AI_CONNECT_TIMEOUT_MS`
 *   （20s）+ 1000，上限 = `AI_MAX_TIMEOUT_MS`。为什么下限不是 1s：整体超时和连接超时都是
 *   `Promise.race` 的竞争者，整体超时若 ≤ 连接超时，底层的 `connectTimeout` 永远等不到自己的 20s；
 *   读超时 `AI_READ_TIMEOUT_MS`（120s）同理，只有整体超时 > 120s 时才可达；
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
/** 用户手填超时的下限（设置页输入夹取用）；**不是**真正发请求时的有效下限，后者见 `clampAiTimeout`。 */
export const AI_MIN_TIMEOUT_MS: number = 1000;
export const AI_MAX_TIMEOUT_MS: number = 180000;

/**
 * 单次 AI 请求的**连接超时**（毫秒）：建连（TCP + TLS）最多等 20 秒。
 *
 * 这个数值原来写死在 `services/deepseek.ets`（`const CONNECT_TIMEOUT_MS = 20000`）。上移到模型层
 * 是因为「整体超时必须 ≥ 连接超时 + 1s」这条隐含依赖需要一个纯函数来保证（`clampAiTimeout`），
 * 而纯函数只能引用模型层常量。**services 层必须 import 这一个常量，禁止再写一份**：
 * 两处各写一份就一定会出现「改了一处、另一处没改」。
 */
export const AI_CONNECT_TIMEOUT_MS: number = 20000;

/**
 * 单次 AI 请求的**读超时**（毫秒）：连上之后等第一个字节最多 120 秒。
 *
 * 与 `AI_CONNECT_TIMEOUT_MS` 同理上移到模型层（同一份来源）。注意它与整体超时的关系：
 * 整体超时（`AiRequest.timeoutMs`，默认 30 秒）是 `Promise.race` 的一条分支，**谁先到谁生效**，
 * 所以 120 秒这个读超时只有在用户把整体超时调到 120 秒以上时才可能真的触发；
 * 默认 30 秒下先到的一定是整体超时（这一句写在这里，省得下次又把它当成「120 秒的兜底」）。
 */
export const AI_READ_TIMEOUT_MS: number = 120000;

/**
 * 整体超时的**有效下限**（毫秒）= 连接超时 + 1 秒。
 *
 * 为什么不能低于「连接超时 + 1s」：整体超时是 `services/deepseek.ets` 里
 * `Promise.race([httpRequest.request(...), timeoutPromise])` 的一条分支，谁先到谁生效。
 * 若整体超时 ≤ 连接超时（例如用户把超时填成 5 秒，而连接超时是 20 秒），`race` 必然先 reject →
 * 底层 `connectTimeout` 永远等不到自己的 20 秒，这个配置项形同虚设，用户也分不清
 * 「连不上」和「连上了但不回包」。留 1 秒是给「连上之后第一个字节」的最小余量。
 */
export const AI_MIN_TOTAL_TIMEOUT_MS: number = AI_CONNECT_TIMEOUT_MS + 1000;
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
/**
 * OpenCode Go 网关要求的会话标识请求头。
 *
 * 网关对 `/inference/go` 的每条请求都要求这个头，缺失时返回 400
 * `request is missing x-opencode-session and cannot be routed`（官方 Console 文档
 * `/docs/console/harnesses#sessions`：Go requires it）。头名只在这里定义一次，
 * 服务层用字面量写进 header 对象（ArkTS 对计算属性名支持不稳），测试钉住两者一致。
 */
export const AI_SESSION_HEADER: string = 'x-opencode-session';

/**
 * 生成 UUID v4（16 个随机字节，版本/变体位固定）。
 *
 * 不 import `crypto`：`tools/tsconfig.json` 的 lib 只有 ES2021，且鸿蒙 ArkTS 运行时不保证有
 * `globalThis.crypto.randomUUID`。`Math.random` 拼出的 122 位随机量足够做本地会话标识，
 * 它既不是密钥也不携带任何用户/凭据信息。
 */
export function newAiSessionId(): string {
  const bytes: number[] = [];
  for (let i = 0; i < 16; i++) {
    bytes.push(Math.floor(Math.random() * 256));
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
  const hex: string[] = [];
  for (const byte of bytes) {
    hex.push(`0${byte.toString(16)}`.slice(-2));
  }
  const text: string = hex.join('');
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}

/**
 * 当前 AI 会话标识（进程内内存态，首次 AI 调用时懒生成）。
 *
 * 为什么是「每次应用启动一个」而不是「每次请求一个」：网关用这个头做路由与 prompt cache 复用，
 * 官方建议「每条请求都带同一个稳定会话 id」。本应用的一次汇总/连通性测试是独立的一次性任务，
 * 没有跨请求的聊天会话概念，因此把「会话」定为一次应用运行（进程内单例）：同一进程内所有 AI
 * 请求复用同一个值（包括重试链），应用重启自然换新。它只活在本进程内存里 —— 不写仓库、不写日志、
 * 不进任何持久化文件，因此不存在凭据泄露面。测试用 `restartAiSession()` 模拟应用重启。
 */
let sessionIdInUse: string = '';

/** 换一个新会话标识（应用重启的自然语义；单测里用它模拟重启，证明换 id 而非写死常量）。 */
export function restartAiSession(): string {
  sessionIdInUse = newAiSessionId();
  return sessionIdInUse;
}

/** 取当前会话标识：懒生成，同一会话内每次调用都返回同一个值。 */
export function currentAiSessionId(): string {
  if (sessionIdInUse.length === 0) {
    sessionIdInUse = newAiSessionId();
  }
  return sessionIdInUse;
}

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
  /**
   * 本次会话的标识（UUID v4），服务层放进 `x-opencode-session` 头。
   *
   * 由 `buildAiRequest` 从 `currentAiSessionId()` 取，整个进程内所有请求（含重试）共享同一个值；
   * 应用重启后由 `restartAiSession()` 换新的。它只经 HTTP 头发往 AI 网关，不进日志、不进仓库。
   */
  sessionId: string;
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

/**
 * 网关「无法路由本次请求」的类型化错误（典型：缺/失效的 `x-opencode-session`，HTTP 400）。
 *
 * 服务端原始响应体只用于判定，不回显给用户（可能含网关内部细节）；本错误只带：
 * - `status`：原始 HTTP 状态码（诊断用，不含 key）；
 * - `code`：响应体 `error.code`（若有，诊断用）；
 * - `message`：中文、可操作的一行文案（页面直接展示）。
 */
export class AiRouteRefusalError extends Error {
  /** 原始 HTTP 状态码（通常是 400）。 */
  status: number;
  /** 服务端错误码（响应体 `error.code`，无则空串）。 */
  code: string;

  constructor(providerLabel: string, status: number, code: string = '') {
    super(
      `${providerLabel} ${status}：AI 服务拒绝了请求（会话标识 ${AI_SESSION_HEADER} 缺失或无效，网关无法路由）。` +
        '请重试；若仍失败，请更新 App 或在设置页切换其它 AI 源。'
    );
    this.name = 'AiRouteRefusalError';
    this.status = status;
    this.code = code;
  }
}

/**
 * 判定是否为「网关因会话标识而无法路由」的响应。
 *
 * 只在 400 且响应体出现强特征时命中：会话头名，或 `cannot be routed` + `session/route`。
 * 普通 400（模型名错、参数错）不会误判，仍走原来的「请检查模型名」文案。
 */
export function isAiRouteRefusal(status: number, bodyText: string): boolean {
  if (status !== 400) {
    return false;
  }
  const text: string = typeof bodyText === 'string' ? bodyText.toLowerCase() : '';
  if (text.indexOf(AI_SESSION_HEADER) >= 0) {
    return true;
  }
  return text.indexOf('cannot be routed') >= 0 && (text.indexOf('session') >= 0 || text.indexOf('route') >= 0);
}

/** 从错误响应体里取 `error.code`（只留错误码，绝不回显 key / 正文）。 */
function aiErrorCode(bodyText: string): string {
  const text: string = typeof bodyText === 'string' ? bodyText.trim() : '';
  if (text.length === 0) {
    return '';
  }
  try {
    const parsed: AiResponse | null = JSON.parse(text) as AiResponse | null;
    if (parsed !== null && parsed.error !== undefined && typeof parsed.error.code === 'string') {
      return parsed.error.code.trim().slice(0, AI_ERROR_SNIPPET_MAX);
    }
  } catch {
    // 非 JSON：没有结构化错误码
  }
  return '';
}

/** 命中路由拒绝时返回类型化错误，否则返回 `null`（调用方据此决定是否抛出/换文案）。 */
export function aiRouteRefusalError(status: number, bodyText: string, providerLabel: string): AiRouteRefusalError | null {
  if (!isAiRouteRefusal(status, bodyText)) {
    return null;
  }
  const label: string =
    typeof providerLabel === 'string' && providerLabel.trim().length > 0 ? providerLabel.trim() : AI_SERVICE_LABEL;
  return new AiRouteRefusalError(label, status, aiErrorCode(bodyText));
}

/**
 * 网关「模型名无效 / 该源不支持该模型」的错误码特征（OpenCode Go live-test 400 实测）。
 * 只用于识别，不回显给用户；key 永远不进响应体，也不进这个常量。
 */
const AI_ERROR_CODE_MODEL_REJECTED: string = 'ai_generate';

/**
 * 模型被服务端拒绝时的类型化错误（典型：HTTP 400 `ai_generate`，文案像「请检查模型名」）。
 *
 * 服务端原始响应体只用于判定，**绝不回显**（它可能带网关内部细节）；本错误只带：
 * - `status`：原始 HTTP 状态码（诊断用）；
 * - `providerId` / `model`：实际使用的源 id 与模型名——用户据此在设置里改选或换源；
 * - `message`：中文、同时点名 provider 与 model 的一行可操作文案（页面直接展示）。
 */
export class AiModelRefusalError extends Error {
  /** 原始 HTTP 状态码（通常是 400）。 */
  status: number;
  /** 实际使用的源 id（如 opencode-go）。 */
  providerId: string;
  /** 实际发送的模型名（如 deepseek-v4.1-flash）。 */
  model: string;

  constructor(providerId: string, model: string, status: number) {
    super(
      `AI 服务拒绝了请求（provider=${providerId}，model=${model}）：模型名无效或该源不支持该模型，请在设置里改选模型或切换 AI 源。`
    );
    this.name = 'AiModelRefusalError';
    this.status = status;
    this.providerId = providerId;
    this.model = model;
  }
}

/**
 * 判定是否为「模型名无效 / 该源不支持该模型」的响应。
 *
 * 只认 400/404/422，且响应体出现强特征：错误码 `ai_generate`，或中英文的模型无效措辞。
 * 路由拒绝（缺会话头）由 `isAiRouteRefusal` 先判，命中后不会走到这里；普通 400 也不误判。
 */
export function isAiModelRefusal(status: number, bodyText: string): boolean {
  if (status !== 400 && status !== 404 && status !== 422) {
    return false;
  }
  const text: string = typeof bodyText === 'string' ? bodyText.toLowerCase() : '';
  if (text.length === 0) {
    return false;
  }
  if (text.indexOf(AI_ERROR_CODE_MODEL_REJECTED) >= 0) {
    return true;
  }
  const phrases: string[] = [
    '请检查模型名',
    '模型名无效',
    'invalid model',
    'model not found',
    'unknown model',
    'unsupported model',
    'model_not_found',
    'model is not supported'
  ];
  for (const phrase of phrases) {
    if (text.indexOf(phrase) >= 0) {
      return true;
    }
  }
  return false;
}

/** 命中模型拒绝时返回类型化错误，否则返回 `null`（调用方据此换文案，不回显原始 body）。 */
export function aiModelRefusalError(
  status: number,
  bodyText: string,
  providerId: string,
  model: string
): AiModelRefusalError | null {
  if (!isAiModelRefusal(status, bodyText)) {
    return null;
  }
  const id: string = typeof providerId === 'string' && providerId.trim().length > 0 ? providerId.trim() : 'unknown';
  const name: string = typeof model === 'string' && model.trim().length > 0 ? model.trim() : 'unknown';
  return new AiModelRefusalError(id, name, status);
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
 * 归一「整体超时」（毫秒）：非法/未设 → 默认 30 秒；低于 `AI_MIN_TOTAL_TIMEOUT_MS` → 抬到该下限；
 * 高于 `AI_MAX_TIMEOUT_MS` → 夹到上限。
 *
 * 为什么单独一个函数（而不是塞进 `normalizeAiOptions`）：解析层（`normalizeAiOptions`）只负责
 * 「用户输入的合理范围」（1s–180s，契约与既有测试都依赖 1s 下限）；而「整体超时 ≥ 连接超时 + 1s」
 * 是**发请求那一刻**才成立的约束（连接超时是 services 层的 `http` 参数）。所以解析保持原样，
 * 真正发请求前（`services/deepseek.ets` 的 `attemptOnce`）必须再过一遍这个函数。
 *
 * 语义边界（都是故意选的）：
 * - `undefined` / `null` / `NaN` / `Infinity` / 非数字 → **默认值**（没配就是默认，不是下限）；
 * - `0` / 负数 / 小于下限 → **下限**（不是默认值：用户显式填了「很小」，抬到能生效的最小值）；
 * - 小数向下取整（毫秒不需要小数）。
 */
export function clampAiTimeout(raw?: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return AI_TIMEOUT_MS;
  }
  const value: number = Math.floor(raw);
  if (value < AI_MIN_TOTAL_TIMEOUT_MS) {
    return AI_MIN_TOTAL_TIMEOUT_MS;
  }
  if (value > AI_MAX_TIMEOUT_MS) {
    return AI_MAX_TIMEOUT_MS;
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
    retries: resolved.retries,
    // 会话级稳定：同一应用运行内所有请求（含重试）复用同一个 id；重启换新的。
    // 这里只放 id，不放 key —— 密钥永远只出现在服务层的 Authorization 头里。
    sessionId: currentAiSessionId()
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
 * @param providerId 源 id（如 `opencode-go`）；与 `model` 同时给出时启用「模型被拒绝」类型化文案
 * @param model 实际发送的模型名；类型化文案会同时点名它与 `providerId`
 * @returns 中文文案；状态码 200 返回空串（没有错误）
 */
export function classifyAiError(
  status: number,
  bodyText: string,
  providerLabel: string = AI_SERVICE_LABEL,
  providerId: string = '',
  model: string = ''
): string {
  const label: string =
    typeof providerLabel === 'string' && providerLabel.trim().length > 0 ? providerLabel.trim() : AI_SERVICE_LABEL;
  // 路由拒绝是「可操作」错误：优先给类型化文案，绝不把网关原始响应体摊给用户
  const refusal: AiRouteRefusalError | null = aiRouteRefusalError(status, bodyText, label);
  if (refusal !== null) {
    return refusal.message;
  }
  // 模型被拒绝：类型化文案同时点名 provider 与 model，且不回显服务端原始响应体。
  // 只有服务层把两者都传进来才启用（中性调用/老测试仍走下面的状态码映射）。
  if (typeof providerId === 'string' && providerId.trim().length > 0 && typeof model === 'string' && model.trim().length > 0) {
    const modelRefusal: AiModelRefusalError | null = aiModelRefusalError(status, bodyText, providerId, model);
    if (modelRefusal !== null) {
      return modelRefusal.message;
    }
  }
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
