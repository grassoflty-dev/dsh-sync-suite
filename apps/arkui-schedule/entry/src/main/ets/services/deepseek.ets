/**
 * 每日 AI 汇总（共享层，Android 与 HarmonyOS 都可用）。
 *
 * 契约（BRIEF §3.4、`docs/CONTRACT.md` §3.3、B2 参数 / B3 可靠性 / B4 用量）：
 * - 端点与模型来自 `model/aiProvider` 的预设表：`chatCompletionsURL(baseURL)` + `resolveModel(源, 模型)`；
 * - `messages` 由 `buildAiPrompt` 产出（system 固定整理约束 + user 记录明细），
 *   提示词里已注入当前时间与时区；
 * - 参数（temperature / max_tokens / 超时 / 重试）来自 `settingsStore`（默认 0.7 / 1024 / 30000 / 1），
 *   调用方可显式传 `AiOptions` 覆盖；
 * - 解析 `choices[0].message.content`，并把响应里的 `usage` 折成 `AiUsage`（拿不到就 null）；
 * - 无 key / 网络失败 / 非 200 / 空内容一律抛**带中文 message** 的 `Error`，页面直接展示；
 * - 网络错误 / 429 / 5xx 退避 1 秒后重试（次数由 `retries` 决定，默认 1 次），其余错误不重试；
 * - **key 只出现在 Authorization 头里**；全文件只有一条日志模板
 *   `[ai] provider=%s model=%s latency=%dms ok=%s`，绝不打印 key / 请求体 / 提示词 / 正文；
 * - `summarizeWithFallback` 在主源失败且「换源有意义」（`shouldFallback`）时**只切一次**备用源。
 *
 * 纯逻辑（URL 拼接、请求体、错误分类、重试/切换判定、回复与 usage 解析）都在 `model/aiRequest.ts`，
 * 源/模型归一在 `model/aiProvider.ts`；本文件只负责真实网络调用与编排。
 *
 * 返回值说明：`summarize` 仍返回字符串（`Index` / `RecordDetailView` / `summaryStore` 的现有调用点
 * 不必改）；需要 usage / 耗时时用 `summarizeDetailed`，需要主备切换用 `summarizeWithFallback`。
 */
import { http } from '@kit.NetworkKit';
import { buildAiPrompt } from '../model/aiPayload';
import {
  DEFAULT_PROVIDER_ID,
  chatCompletionsURL,
  defaultModelOf,
  fetchModels,
  findProvider,
  resolveModel as resolvePresetModel
} from '../model/aiProvider';
import type {
  AiFetchImpl,
  AiFetchInit,
  AiFetchResponse,
  AiModelsResult,
  AiProviderPreset
} from '../model/aiProvider';
import {
  AI_PROBE_MAX_TOKENS,
  AI_PROBE_PROMPT,
  AI_RETRY_BACKOFF_MS,
  AI_STATUS_NETWORK,
  AI_STATUS_TIMEOUT,
  DEFAULT_AI_MODEL,
  buildAiRequest,
  classifyAiError,
  defaultAiOptions,
  describeAiTestResult,
  normalizeAiOptions,
  parseAiReplyFull,
  runWithFallback,
  shouldRetry
} from '../model/aiRequest';
import type {
  AiAttemptFn,
  AiAttemptOutcome,
  AiFallbackOutcome,
  AiOptions,
  AiRequest,
  AiUsage
} from '../model/aiRequest';
import type { AiPayload } from '../model/types';
import type { AiFallbackSettings } from './settingsStore';
import { aiBaseURLFor, settingsStore } from './settingsStore';

const CONNECT_TIMEOUT_MS: number = 20000;
const READ_TIMEOUT_MS: number = 120000;
/** 「获取模型列表」的连接/读取超时（列表比对话轻，卡住就早点失败）。 */
const MODELS_CONNECT_TIMEOUT_MS: number = 10000;
const MODELS_READ_TIMEOUT_MS: number = 15000;

/** system 角色：只约束输出形态，不承载记录内容。 */
const SYSTEM_PROMPT: string =
  '你是DSH-Dots的整理助手。只依据用户提供的记录归纳，用中文 Markdown 输出，不编造人名、时间或数字。';

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
  /** 本次尝试耗时（毫秒）。 */
  elapsedMs: number;
}

/** 一次「请求 + 重试」调用的结果（不抛异常，状态码供 `shouldFallback` 判定）。 */
interface AiCallResult {
  ok: boolean;
  status: number;
  text: string;
  usage: AiUsage | null;
  error: string;
  elapsedMs: number;
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

/** 带用量与耗时的汇总结果（B4；`summarize` 只取其中的 `text`）。 */
export interface AiSummaryResult {
  text: string;
  /** 响应里的 usage（拿不到时 null）。 */
  usage: AiUsage | null;
  /** 本次汇总总耗时（含重试，毫秒）。 */
  elapsedMs: number;
  /** 实际使用的源 id。 */
  providerId: string;
  /** 实际使用的模型名。 */
  model: string;
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

/**
 * 一次请求的行为日志（B3）。
 *
 * **全文件只允许这一条日志**：只带 provider / model / latency / ok 四个字段，
 * 绝不带 key、请求体、提示词或响应正文（`tools/test/aiReliability.test.mjs` 有源码级断言）。
 * 模板固定且用 printf 占位符，便于 grep 与聚合。
 */
function logAttempt(providerId: string, model: string, latencyMs: number, ok: boolean): void {
  console.info('[ai] provider=%s model=%s latency=%dms ok=%s', providerId, model, latencyMs, ok ? 'true' : 'false');
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
function outcomeOf(response: http.HttpResponse, elapsedMs: number): AiHttpOutcome {
  const status: number = response.responseCode;
  const body: string = typeof response.result === 'string' ? response.result : JSON.stringify(response.result);
  const outcome: AiHttpOutcome = { responded: true, status: status, body: body, error: '', elapsedMs: elapsedMs };
  return outcome;
}

function networkFailure(error: object, elapsedMs: number): AiHttpOutcome {
  const failed: AiHttpOutcome = {
    responded: false,
    status: AI_STATUS_NETWORK,
    body: '',
    error: describeError(error),
    elapsedMs: elapsedMs
  };
  return failed;
}

function timeoutFailure(elapsedMs: number): AiHttpOutcome {
  const failed: AiHttpOutcome = {
    responded: false,
    status: AI_STATUS_TIMEOUT,
    body: '',
    error: '整体超时（没有在设定时间内响应）',
    elapsedMs: elapsedMs
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
 * 发一次请求（含整体超时）。**永不抛异常**：网络失败/超时都落到 `AiHttpOutcome`。
 * 每次尝试结束都会写一条 `[ai]` 行为日志（只有源/模型/耗时/成败）。
 */
async function attemptOnce(apiKey: string, request: AiRequest, route: AiRoute): Promise<AiHttpOutcome> {
  const httpRequest = http.createHttp();
  let timer: number = -1;
  const startedAt: number = Date.now();
  let outcome: AiHttpOutcome = {
    responded: false,
    status: AI_STATUS_NETWORK,
    body: '',
    error: '',
    elapsedMs: 0
  };
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
    outcome = outcomeOf(response, Date.now() - startedAt);
  } catch (error) {
    if (error instanceof AiTimeoutError) {
      outcome = timeoutFailure(Date.now() - startedAt);
    } else {
      outcome = networkFailure(error as Object, Date.now() - startedAt);
    }
  } finally {
    // 超时后请求可能仍在飞：destroy 让底层连接尽快回收（不会影响已拿到的 response）
    try {
      httpRequest.destroy();
    } catch (error) {
      // 已销毁/未开始：忽略
    }
  }
  logAttempt(route.providerId, route.model, outcome.elapsedMs, outcome.responded && outcome.status === 200);
  return outcome;
}

/**
 * 发请求并按 `options.retries` 重试，返回结构化结果（不抛异常）。
 *
 * 重试策略：网络错误 / 429 / 5xx → 退避 `AI_RETRY_BACKOFF_MS`；401/403/404/400 等确定性错误
 * 与超时直接失败（重试只会让用户多等）。200 但正文不可用也不再重试（不是限流/网络问题）。
 */
async function callChat(
  apiKey: string,
  request: AiRequest,
  route: AiRoute,
  providerLabel: string,
  options: AiOptions
): Promise<AiCallResult> {
  const maxAttempts: number = options.retries + 1;
  let totalMs: number = 0;
  let lastError: string = '';
  let lastStatus: number = AI_STATUS_NETWORK;
  let attempts: number = 0;
  while (attempts < maxAttempts) {
    const outcome: AiHttpOutcome = await attemptOnce(apiKey, request, route);
    totalMs += outcome.elapsedMs;
    lastStatus = outcome.status;
    if (outcome.responded && outcome.status === 200) {
      try {
        const reply = parseAiReplyFull(outcome.body);
        const succeeded: AiCallResult = {
          ok: true,
          status: 200,
          text: reply.text,
          usage: reply.usage,
          error: '',
          elapsedMs: totalMs
        };
        return succeeded;
      } catch (error) {
        lastError = describeError(error as Object);
        break;
      }
    }
    lastError = failureMessage(outcome, providerLabel);
    attempts++;
    if (attempts >= maxAttempts || !shouldRetry(outcome.status)) {
      break;
    }
    await sleep(AI_RETRY_BACKOFF_MS);
  }
  const retriedSuffix: string = attempts >= maxAttempts && maxAttempts > 1 ? `（已自动重试 ${maxAttempts - 1} 次）` : '';
  const failed: AiCallResult = {
    ok: false,
    status: lastStatus,
    text: '',
    usage: null,
    error: `${lastError}${retriedSuffix}`,
    elapsedMs: totalMs
  };
  return failed;
}

/**
 * 对一条路由做一次完整汇总（含重试），把失败折成 `AiAttemptOutcome`（不抛异常）。
 *
 * 这是 `summarize` / `summarizeDetailed` / `summarizeWithFallback` 共用的单源执行体：
 * 主备切换只是把两个 `AiAttemptOutcome` 生产者交给 `runWithFallback`。
 */
async function attemptSummary(
  route: AiRoute,
  apiKey: string,
  prompt: string,
  options: AiOptions
): Promise<AiAttemptOutcome> {
  const preset: AiProviderPreset = findProvider(route.providerId);
  const key: string = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (key.length === 0) {
    const missing: AiAttemptOutcome = {
      ok: false,
      status: AI_STATUS_NETWORK,
      text: '',
      error: `未设置 ${preset.label} 密钥，请先在设置页填写（密钥只保存在本机）`,
      usage: null,
      elapsedMs: 0,
      providerId: route.providerId,
      model: route.model
    };
    return missing;
  }
  let request: AiRequest;
  try {
    request = buildAiRequest(
      chatCompletionsURL(route.baseURL),
      route.model,
      prompt,
      options,
      SYSTEM_PROMPT
    );
  } catch (error) {
    const invalid: AiAttemptOutcome = {
      ok: false,
      status: AI_STATUS_NETWORK,
      text: '',
      error: describeError(error as Object),
      usage: null,
      elapsedMs: 0,
      providerId: route.providerId,
      model: route.model
    };
    return invalid;
  }
  const call: AiCallResult = await callChat(key, request, route, preset.label, options);
  const outcome: AiAttemptOutcome = {
    ok: call.ok,
    status: call.status,
    text: call.text,
    error: call.error,
    usage: call.usage,
    elapsedMs: call.elapsedMs,
    providerId: route.providerId,
    model: route.model
  };
  return outcome;
}

/** 取本次要用的参数：显式传入优先，否则用设置页缓存（未加载时是默认值）。 */
function optionsFor(explicit?: AiOptions): AiOptions {
  if (explicit === undefined) {
    return settingsStore.cachedAiOptions();
  }
  return normalizeAiOptions(explicit);
}

/**
 * 对一份 AI 载荷做整理，返回 Markdown 摘要正文。
 *
 * 成功才返回正文；任何失败都抛 `Error`，调用方（主页）**不得**因此修改记录
 * （失败时保持 `ai_processed:false`、不写 `ai_structured`）。
 *
 * 需要 usage / 耗时请用 `summarizeDetailed`（签名相同，返回结构化结果）。
 *
 * @param payload 由 `buildAiPayload` 生成的载荷（只含当天未处理记录）
 * @param apiKey AI 密钥（设置页填写；换源不必重填）
 * @param nowIso 当前时间（注入提示词）
 * @param timeZone 时区标签（通常用 `deviceTimeZone()`）
 * @param model 模型名（可选；缺省用设置页保存的模型，再缺省用该源默认模型）
 * @param providerId 源 id（可选；缺省用设置页保存的源，再缺省用 `deepseek`）
 * @param baseURL 接口基地址（可选；只有自定义源采用，其余源用预设地址）
 * @param options 采样/超时/重试参数（可选；缺省读设置页，再缺省默认 0.7 / 1024 / 30000 / 1）
 */
export async function summarize(
  payload: AiPayload,
  apiKey: string,
  nowIso: string,
  timeZone: string,
  model?: string,
  providerId?: string,
  baseURL?: string,
  options?: AiOptions
): Promise<string> {
  const result: AiSummaryResult = await summarizeDetailed(
    payload,
    apiKey,
    nowIso,
    timeZone,
    model,
    providerId,
    baseURL,
    options
  );
  return result.text;
}

/**
 * 同 `summarize`，但返回正文 + usage + 耗时 + 实际源/模型（B4 用量展示用）。
 */
export async function summarizeDetailed(
  payload: AiPayload,
  apiKey: string,
  nowIso: string,
  timeZone: string,
  model?: string,
  providerId?: string,
  baseURL?: string,
  options?: AiOptions
): Promise<AiSummaryResult> {
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
  const prompt: string = buildAiPrompt(payload, nowIso, timeZone);
  const outcome: AiAttemptOutcome = await attemptSummary(route, key, prompt, optionsFor(options));
  if (!outcome.ok) {
    throw new Error(outcome.error);
  }
  const result: AiSummaryResult = {
    text: outcome.text,
    usage: outcome.usage,
    elapsedMs: outcome.elapsedMs,
    providerId: outcome.providerId,
    model: outcome.model
  };
  return result;
}

/**
 * 带备用源的汇总（B3）：主源失败且 `shouldFallback(status)` 时**只切一次**备用源。
 *
 * - 主源成功 → `usedFallback:false`；
 * - 主源失败但 401/403/404/400 等「换源也没用」的错误 / 没配备用源 → 直接抛主源错误；
 * - 切到备用源后仍失败 → 抛 `AiFallbackError`（message 同时带主源与备用源错误，只切一次）。
 *
 * @param fallback 备用源配置（可选；缺省读设置页的 `cachedAiFallback()`）
 * @param options  主备共用的采样/超时/重试参数（可选；缺省读设置页）
 */
export async function summarizeWithFallback(
  payload: AiPayload,
  apiKey: string,
  nowIso: string,
  timeZone: string,
  model?: string,
  providerId?: string,
  baseURL?: string,
  fallback?: AiFallbackSettings,
  options?: AiOptions
): Promise<AiFallbackOutcome> {
  const key: string = typeof apiKey === 'string' ? apiKey.trim() : '';
  const primaryRoute: AiRoute = routeFor(
    providerId === undefined ? '' : providerId,
    model === undefined ? '' : model,
    baseURL === undefined ? '' : baseURL
  );
  const preset: AiProviderPreset = findProvider(primaryRoute.providerId);
  if (key.length === 0) {
    throw new Error(`未设置 ${preset.label} 密钥，请先在设置页填写（密钥只保存在本机）`);
  }
  if (payload.records.length === 0) {
    throw new Error('当天没有需要 AI 整理的记录');
  }
  const prompt: string = buildAiPrompt(payload, nowIso, timeZone);
  const resolvedOptions: AiOptions = optionsFor(options);
  const fallbackSettings: AiFallbackSettings =
    fallback === undefined ? settingsStore.cachedAiFallback() : fallback;
  const primaryAttempt: AiAttemptFn = async (): Promise<AiAttemptOutcome> =>
    attemptSummary(primaryRoute, key, prompt, resolvedOptions);
  let fallbackAttempt: AiAttemptFn | null = null;
  if (fallbackSettings.configured) {
    const fallbackRoute: AiRoute = routeFor(
      fallbackSettings.providerId,
      fallbackSettings.model,
      fallbackSettings.baseURL
    );
    const fallbackKey: string = fallbackSettings.apiKey;
    fallbackAttempt = async (): Promise<AiAttemptOutcome> =>
      attemptSummary(fallbackRoute, fallbackKey, prompt, resolvedOptions);
  }
  return runWithFallback(primaryAttempt, fallbackAttempt);
}

/** 第二个参数是不是已知源 id（否则按旧签名的「模型名」解释）。 */
function isProviderId(text: string): boolean {
  const value: string = typeof text === 'string' ? text.trim().toLowerCase() : '';
  return value.length > 0 && findProvider(value).id === value;
}

/**
 * 鸿蒙侧的「fetch」实现：用 `@kit.NetworkKit` 的 http 发 `GET …/models`。
 *
 * 模型层 `fetchModels` 的默认实现是 `globalThis.fetch`（Node 单测 / Web 复用），但真机上的
 * ArkTS 运行时并不保证有全局 fetch；本应用所有网络调用本来就走 `@kit.NetworkKit`，
 * 这里把它包成 `AiFetchImpl` 注入进去，超时/错误分类/失败不抛等行为完全复用模型层。
 */
async function httpFetch(url: string, init: AiFetchInit): Promise<AiFetchResponse> {
  const request = http.createHttp();
  try {
    const options: http.HttpRequestOptions = {
      method: http.RequestMethod.GET,
      header: init.headers,
      expectDataType: http.HttpDataType.STRING,
      connectTimeout: MODELS_CONNECT_TIMEOUT_MS,
      readTimeout: MODELS_READ_TIMEOUT_MS
    };
    const response: http.HttpResponse = await request.request(url, options);
    const bodyText: string = typeof response.result === 'string' ? response.result : JSON.stringify(response.result);
    const result: AiFetchResponse = {
      status: response.responseCode,
      text: async (): Promise<string> => bodyText
    };
    return result;
  } finally {
    try {
      request.destroy();
    } catch (error) {
      // 已销毁/未开始：忽略
    }
  }
}

/** 类型收窄：确保 `httpFetch` 始终符合注入契约（签名漂移会在这里报错）。 */
const HTTP_FETCH_IMPL: AiFetchImpl = httpFetch;

/**
 * 设置页「获取模型列表」的真机入口：把鸿蒙 http 注入 `model/aiProvider.fetchModels`。
 *
 * 与纯函数版同样的约定：**不抛异常**，失败返回 `{ok:false, status, message}`；
 * 成功返回模型 id 数组（可直接铺进模型弹层，或写回手输框）。
 * 未保存的 key/地址也能测：调用方传当前表单值即可。
 */
export async function fetchModelsOnline(
  providerId: string,
  baseURL: string,
  apiKey: string
): Promise<AiModelsResult> {
  return fetchModels(providerId, baseURL, apiKey, HTTP_FETCH_IMPL);
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
    const defaults: AiOptions = defaultAiOptions();
    const rawProbeOptions: AiOptions = {
      temperature: defaults.temperature,
      maxTokens: AI_PROBE_MAX_TOKENS,
      timeoutMs: defaults.timeoutMs,
      retries: 0
    };
    const probeOptions: AiOptions = normalizeAiOptions(rawProbeOptions);
    request = buildAiRequest(chatCompletionsURL(route.baseURL), route.model, AI_PROBE_PROMPT, probeOptions);
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
  let outcome: AiHttpOutcome = await attemptOnce(key, request, route);
  let elapsedMs: number = outcome.elapsedMs;
  if (!(outcome.responded && outcome.status === 200) && shouldRetry(outcome.status)) {
    await sleep(AI_RETRY_BACKOFF_MS);
    outcome = await attemptOnce(key, request, route);
    elapsedMs = outcome.elapsedMs;
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
