/**
 * 每日 AI 汇总（共享层，Android 与 HarmonyOS 都可用）。
 *
 * 契约（BRIEF §3.4、`docs/CONTRACT.md` §3.3）：
 * - 端点与模型来自 `model/aiProvider` 的预设表：`chatCompletionsURL(baseURL)` + `resolveModel(源, 模型)`；
 * - `messages` 由 `buildAiPrompt` 产出（system 固定整理约束 + user 记录明细），
 *   提示词里已注入当前时间与时区；
 * - 解析 `choices[0].message.content`；
 * - 无 key / 网络失败 / 非 200 / 空内容一律抛**带中文 message** 的 `Error`，页面直接展示；
 * - 单次请求 20 秒整体超时；网络错误 / 429 / 5xx 退避 1 秒后**重试一次**，其余错误不重试；
 * - **key 只出现在 Authorization 头里，本文件不打印任何请求头/请求体/响应体。**
 *
 * 纯逻辑（URL 拼接、请求体、错误分类、重试判定、回复解析）都在 `model/aiRequest.ts`，
 * 源/模型归一在 `model/aiProvider.ts`；本文件只负责真实网络调用与重试编排。
 */
import { http } from '@kit.NetworkKit';
import { buildAiPrompt } from '../model/aiPayload';
import {
  DEFAULT_PROVIDER_ID,
  chatCompletionsURL,
  defaultModelOf,
  findProvider,
  resolveModel as resolvePresetModel
} from '../model/aiProvider';
import type { AiProviderPreset } from '../model/aiProvider';
import {
  AI_DEFAULT_MAX_TOKENS,
  AI_PROBE_MAX_TOKENS,
  AI_PROBE_PROMPT,
  AI_RETRY_BACKOFF_MS,
  AI_STATUS_NETWORK,
  AI_STATUS_TIMEOUT,
  DEFAULT_AI_MODEL,
  buildAiRequest,
  classifyAiError,
  describeAiTestResult,
  parseAiReply,
  shouldRetry
} from '../model/aiRequest';
import type { AiRequest } from '../model/aiRequest';
import type { AiPayload } from '../model/types';
import { aiBaseURLFor, settingsStore } from './settingsStore';

const CONNECT_TIMEOUT_MS: number = 20000;
const READ_TIMEOUT_MS: number = 120000;

/** system 角色：只约束输出形态，不承载记录内容。 */
const SYSTEM_PROMPT: string =
  '你是日程助手的整理助手。只依据用户提供的记录归纳，用中文 Markdown 输出，不编造人名、时间或数字。';

/** 一次尝试的结果（网络层失败/超时也在这里表达，不抛异常）。 */
interface AiHttpOutcome {
  /** 是否拿到了 HTTP 响应。 */
  responded: boolean;
  /** HTTP 状态码；没拿到响应时是 `AI_STATUS_NETWORK` 或 `AI_STATUS_TIMEOUT`。 */
  status: number;
  /** 响应体文本（`responded=false` 时为空串）。 */
  body: string;
  /** 网络/超时错误文本（`responded=true` 时为空串）。 */
  error: string;
}

/** 连通性测试结果（页面直接展示 `message`，`elapsedMs` 用于「成功 · 320ms」）。 */
export interface AiTestResult {
  ok: boolean;
  /** 拿到的 HTTP 状态码（超时为 -1，网络错误为 0）。 */
  status: number;
  /** 中文提示，例如 `成功：HTTP 200 / 模型 deepseek-chat（DeepSeek 官方）`。 */
  message: string;
  /** 本次请求耗时（毫秒）：取最后一次尝试；未发出请求时为 0。 */
  elapsedMs: number;
}

/** 一次调用的路由：源决定地址与可用模型。 */
interface AiRoute {
  providerId: string;
  model: string;
  baseURL: string;
}

/** 整体超时用的哨兵错误（比字符串匹配可靠）。 */
class AiTimeoutError extends Error {
  constructor() {
    super('AI 请求超时');
  }
}

function describeError(error: object): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/** 本机时区标签，形如 `UTC+08:00`（不依赖 Intl，鸿蒙/Android 一致）。 */
export function deviceTimeZone(): string {
  const offset = -new Date().getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  const hours = Math.floor(abs / 60);
  const minutes = abs % 60;
  const hh = hours < 10 ? `0${hours}` : `${hours}`;
  const mm = minutes < 10 ? `0${minutes}` : `${minutes}`;
  return `UTC${sign}${hh}:${mm}`;
}

/** 解析实际使用的源：显式参数 > 设置页缓存 > 默认源。 */
function cachedProviderId(): string {
  const cached: string = settingsStore.cachedProviderId();
  return cached.length > 0 ? cached : DEFAULT_PROVIDER_ID;
}

/** 接口基地址：显式参数 > 设置页缓存 > 预设；预设源不采用缓存里的旧地址。 */
function baseURLFor(providerId: string, explicit: string): string {
  const text: string = typeof explicit === 'string' ? explicit.trim() : '';
  if (text.length > 0) {
    return aiBaseURLFor(providerId, text);
  }
  return aiBaseURLFor(providerId, settingsStore.cachedBaseURL());
}

/** 把「显式参数 / 设置缓存 / 预设」归一成一次调用的路由。 */
function routeFor(providerId: string, model: string, baseURL: string): AiRoute {
  const preset: AiProviderPreset = findProvider(providerId.length > 0 ? providerId : cachedProviderId());
  const route: AiRoute = {
    providerId: preset.id,
    model: resolveModel(preset.id, model),
    baseURL: baseURLFor(preset.id, baseURL)
  };
  return route;
}

/**
 * 解析实际使用的模型名：显式参数 > 设置页缓存 > 该源默认模型。
 *
 * 解析结果还要过一遍该源的模型表：换源后旧模型名不在新源列表里，会自动回到新源默认模型。
 */
function resolveModel(providerId: string, explicit: string): string {
  const explicitModel: string = typeof explicit === 'string' ? explicit.trim() : '';
  if (explicitModel.length > 0) {
    return resolvePresetModel(providerId, explicitModel);
  }
  const cached: string = settingsStore.cachedAiModel();
  if (cached.length > 0) {
    return resolvePresetModel(providerId, cached);
  }
  if (providerId === DEFAULT_PROVIDER_ID) {
    return DEFAULT_AI_MODEL;
  }
  return defaultModelOf(providerId);
}

/** 把 `http.HttpResponse` 归一成一次尝试的结果。 */
function outcomeOf(response: http.HttpResponse): AiHttpOutcome {
  const status: number = response.responseCode;
  const body: string =
    typeof response.result === 'string' ? response.result : JSON.stringify(response.result);
  const outcome: AiHttpOutcome = { responded: true, status: status, body: body, error: '' };
  return outcome;
}

function networkFailure(error: object): AiHttpOutcome {
  const failed: AiHttpOutcome = {
    responded: false,
    status: AI_STATUS_NETWORK,
    body: '',
    error: describeError(error)
  };
  return failed;
}

function timeoutFailure(): AiHttpOutcome {
  const failed: AiHttpOutcome = {
    responded: false,
    status: AI_STATUS_TIMEOUT,
    body: '',
    error: '整体超时（20 秒内没有响应）'
  };
  return failed;
}

/** 等待 `ms` 毫秒（重试退避用）。 */
function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve: () => void) => {
    setTimeout(() => {
      resolve();
    }, ms);
  });
}

/** 取失败文案：拿到响应时按状态码映射，否则用网络/超时文案（源名由调用方给出）。 */
function failureMessage(outcome: AiHttpOutcome, providerLabel: string): string {
  if (outcome.responded) {
    return classifyAiError(outcome.status, outcome.body, providerLabel);
  }
  return classifyAiError(outcome.status, outcome.error, providerLabel);
}

/**
 * 发一次请求（含 20 秒整体超时）。**永不抛异常**：网络失败/超时都落到 `AiHttpOutcome`。
 */
async function attemptOnce(apiKey: string, request: AiRequest): Promise<AiHttpOutcome> {
  const httpRequest = http.createHttp();
  let timer: number = -1;
  try {
    const requestOptions: http.HttpRequestOptions = {
      method: http.RequestMethod.POST,
      header: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      extraData: request.body,
      expectDataType: http.HttpDataType.STRING,
      connectTimeout: CONNECT_TIMEOUT_MS,
      readTimeout: READ_TIMEOUT_MS
    };
    const timeoutPromise = new Promise<http.HttpResponse>(
      (_resolve: (value: http.HttpResponse) => void, reject: (reason: Object) => void) => {
        timer = setTimeout(() => {
          reject(new AiTimeoutError());
        }, request.timeoutMs);
      }
    );
    const tasks: Array<Promise<http.HttpResponse>> = [httpRequest.request(request.url, requestOptions), timeoutPromise];
    let response: http.HttpResponse;
    try {
      response = await Promise.race<http.HttpResponse>(tasks);
    } finally {
      if (timer >= 0) {
        clearTimeout(timer);
      }
    }
    return outcomeOf(response);
  } catch (error) {
    if (error instanceof AiTimeoutError) {
      return timeoutFailure();
    }
    return networkFailure(error as Object);
  } finally {
    // 超时后请求可能仍在飞：destroy 让底层连接尽快回收（不会影响已拿到的 response）
    try {
      httpRequest.destroy();
    } catch (error) {
      // 已销毁/未开始：忽略
    }
  }
}

/**
 * 发请求并解析正文，失败时抛带中文 message 的 `Error`。
 *
 * 重试策略：网络错误 / 429 / 5xx → 退避 `AI_RETRY_BACKOFF_MS` 后重试**一次**；
 * 401/403/404/400 等确定性错误与超时直接失败（重试只会让用户多等）。
 */
async function requestContent(apiKey: string, request: AiRequest, providerLabel: string): Promise<string> {
  let outcome: AiHttpOutcome = await attemptOnce(apiKey, request);
  if (outcome.responded && outcome.status === 200) {
    return parseAiReply(outcome.body);
  }
  if (!shouldRetry(outcome.status)) {
    throw new Error(failureMessage(outcome, providerLabel));
  }
  await sleep(AI_RETRY_BACKOFF_MS);
  outcome = await attemptOnce(apiKey, request);
  if (outcome.responded && outcome.status === 200) {
    return parseAiReply(outcome.body);
  }
  throw new Error(`${failureMessage(outcome, providerLabel)}（已自动重试 1 次）`);
}

/**
 * 对一份 AI 载荷做整理，返回 Markdown 摘要正文。
 *
 * 成功才返回正文；任何失败都抛 `Error`，调用方（主页）**不得**因此修改记录
 * （失败时保持 `ai_processed:false`、不写 `ai_structured`）。
 *
 * @param payload 由 `buildAiPayload` 生成的载荷（只含当天未处理记录）
 * @param apiKey AI 密钥（设置页填写；换源不必重填）
 * @param nowIso 当前时间（注入提示词）
 * @param timeZone 时区标签（通常用 `deviceTimeZone()`）
 * @param model 模型名（可选；缺省用设置页保存的模型，再缺省用该源默认模型）
 * @param providerId 源 id（可选；缺省用设置页保存的源，再缺省用 `deepseek`）
 * @param baseURL 接口基地址（可选；只有自定义源采用，其余源用预设地址）
 */
export async function summarize(
  payload: AiPayload,
  apiKey: string,
  nowIso: string,
  timeZone: string,
  model?: string,
  providerId?: string,
  baseURL?: string
): Promise<string> {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  const route: AiRoute = routeFor(
    providerId === undefined ? '' : providerId,
    model === undefined ? '' : model,
    baseURL === undefined ? '' : baseURL
  );
  const preset: AiProviderPreset = findProvider(route.providerId);
  if (key.length === 0) {
    throw new Error(`未设置 ${preset.label} 密钥，请先在设置页填写（密钥只保存在本机）`);
  }
  if (payload.records.length === 0) {
    throw new Error('当天没有需要 AI 整理的记录');
  }

  const prompt = buildAiPrompt(payload, nowIso, timeZone);
  const request = buildAiRequest(
    chatCompletionsURL(route.baseURL),
    route.model,
    prompt,
    AI_DEFAULT_MAX_TOKENS,
    SYSTEM_PROMPT
  );
  return requestContent(key, request, preset.label);
}

/** 第二个参数是不是已知源 id（否则按旧签名的「模型名」解释）。 */
function isProviderId(text: string): boolean {
  const value: string = typeof text === 'string' ? text.trim().toLowerCase() : '';
  return value.length > 0 && findProvider(value).id === value;
}

/**
 * 设置页的「测试 AI 连通性」：真实发一次最小 chat completions（`ping`，max_tokens=8），
 * 返回状态码、中文文案与耗时，供界面显示「成功 · 320ms」。
 *
 * **不抛异常**，所有失败都折成中文文案；返回的 message 里只有源/状态码/模型名，
 * 绝不包含 key 的任何片段。旧签名 `testAiConnection(key, model)` 仍可用：
 * 第二个参数不是已知源 id 时按模型名处理，源取设置页缓存。
 */
export async function testAiConnection(
  apiKey: string,
  providerIdOrModel: string = '',
  modelId: string = '',
  baseURL: string = ''
): Promise<AiTestResult> {
  const key: string = typeof apiKey === 'string' ? apiKey.trim() : '';
  const legacyCall: boolean = !isProviderId(providerIdOrModel);
  const route: AiRoute = routeFor(
    legacyCall ? '' : providerIdOrModel,
    legacyCall ? providerIdOrModel : modelId,
    baseURL
  );
  const preset: AiProviderPreset = findProvider(route.providerId);
  const label: string = preset.label;
  if (key.length === 0) {
    const missing: AiTestResult = {
      ok: false,
      status: AI_STATUS_NETWORK,
      message: `失败：未填写 ${label} 密钥（密钥只存本机，不会写进日志）`,
      elapsedMs: 0
    };
    return missing;
  }
  let request: AiRequest;
  try {
    request = buildAiRequest(chatCompletionsURL(route.baseURL), route.model, AI_PROBE_PROMPT, AI_PROBE_MAX_TOKENS);
  } catch (error) {
    const invalid: AiTestResult = {
      ok: false,
      status: AI_STATUS_NETWORK,
      message: describeAiTestResult(false, AI_STATUS_NETWORK, route.model, describeError(error as Object)),
      elapsedMs: 0
    };
    return invalid;
  }
  // 连通性测试也允许重试一次：网络抖动很常见，用户在设置页等 1 秒无感。
  // 耗时不累计退避的 1 秒，只报最后一次请求本身（否则延迟数字会虚高）。
  const startedAt: number = Date.now();
  let outcome: AiHttpOutcome = await attemptOnce(key, request);
  let elapsedMs: number = Date.now() - startedAt;
  if (!(outcome.responded && outcome.status === 200) && shouldRetry(outcome.status)) {
    await sleep(AI_RETRY_BACKOFF_MS);
    const retryStartedAt: number = Date.now();
    outcome = await attemptOnce(key, request);
    elapsedMs = Date.now() - retryStartedAt;
  }
  if (outcome.responded && outcome.status === 200) {
    const okResult: AiTestResult = {
      ok: true,
      status: 200,
      message: `${describeAiTestResult(true, 200, route.model, '')}（${label}）`,
      elapsedMs: elapsedMs
    };
    return okResult;
  }
  const failedResult: AiTestResult = {
    ok: false,
    status: outcome.status,
    message: describeAiTestResult(false, outcome.status, route.model, failureMessage(outcome, label)),
    elapsedMs: elapsedMs
  };
  return failedResult;
}
