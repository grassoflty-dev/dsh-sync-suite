/**
 * AI 多源 fallback 的**运行器**：把 `model/aiFallback.ts` 的决策表套到真实 HTTP 调用上。
 *
 * 契约：
 * - **串行**：按 `planFallback` 的顺序一个一个试，绝不并发（同一份日程内容不会同时发给多家）；
 * - **每次尝试前重读设置**（`settingsStore.load()`）：用户中途关掉 fallback，下一轮立刻只剩主源；
 * - **两层开关取「都开」**（`options.enabled && settings.aiFallbackEnabled`）：任一层说关就关（fail-closed）；
 * - 每次尝试后把**已脱敏**的诊断交给 `onAttempt`（界面逐条显示「源名 + 原因 + 耗时」）；
 * - 全部失败返回 `{ok:false, lastError, diagnostics}`，**不抛异常**；成功返回正文 + 实际使用的源；
 * - 请求路径完全复用 `model/aiRequest`（`buildAiRequest` / `parseAiReplyFull` / `classifyAiError`），
 *   与 `services/deepseek.ets` 同形；本文件不 import `deepseek.ets`（避免将来「deepseek 挂载本运行器」
 *   时形成循环 import），因此 `deviceTimeZone()` 与 `SYSTEM_PROMPT` 在这里各有一份**逐字相同**的副本，
 *   `tools/test/aiFallback.test.mjs` 有源码级断言盯着它们不许漂移。
 *
 * 密钥：主源用设置里的 `aiKey`，所有备用源共用 `aiFallbackKey`（设置模型目前只有一个备用 key 字段）。
 * **key 只出现在 Authorization 头里**，绝不进诊断、日志或返回值。
 */
import { http } from '@kit.NetworkKit';
import { nowIso } from '../common/date';
import { buildAiPrompt } from '../model/aiPayload';
import {
  KIND_CONFIG,
  KIND_PARSE,
  attemptKindForStatus,
  categoryOfAttempt,
  classifyAttempt,
  isSameSource,
  normalizeMaxAttempts,
  parseFallbackOrder,
  planFallback,
  sanitizeDiagnostic,
  sourceLabel
} from '../model/aiFallback';
import type {
  FallbackAttemptResult,
  FallbackDiagnostic,
  FallbackOutcome,
  FallbackSource
} from '../model/aiFallback';
import { chatCompletionsURL, findProvider, resolveModel } from '../model/aiProvider';
import type { AiProviderPreset } from '../model/aiProvider';
import {
  AI_STATUS_NETWORK,
  AI_STATUS_TIMEOUT,
  buildAiRequest,
  classifyAiError,
  defaultAiOptions,
  parseAiReplyFull
} from '../model/aiRequest';
import type { AiOptions, AiRequest, AiUsage } from '../model/aiRequest';
import type { AiPayload } from '../model/types';
import { aiBaseURLFor, settingsStore } from './settingsStore';
import type { ScheduleSettings } from './settingsStore';

/** 连接超时（与 `deepseek.ets` 对齐）。 */
const CONNECT_TIMEOUT_MS: number = 20000;

/** 读取超时（与 `deepseek.ets` 对齐）。 */
const READ_TIMEOUT_MS: number = 120000;

/** 同一个源最多「同源重试」几次（决策表目前从不产出 `retry-same`，这里只兜底防死循环）。 */
const MAX_SAME_SOURCE_RETRIES: number = 1;

/**
 * system 角色：只约束输出形态，不承载记录内容。
 *
 * **必须与 `services/deepseek.ets` 的 `SYSTEM_PROMPT` 逐字一致**（测试有断言）：
 * 两条路径（单源 / 多源 fallback）产出的汇总口径不同会让人误以为换了模型。
 */
const SYSTEM_PROMPT: string =
  '你是DSH-Dots的整理助手。只依据用户提供的记录归纳，用中文 Markdown 输出，不编造人名、时间或数字。';

/** 一次 HTTP 尝试的原始结果（网络层失败/超时也在这里表达，不抛异常）。 */
interface HttpOutcome {
  /** 是否拿到了 HTTP 响应。 */
  responded: boolean;
  /** HTTP 状态码；没拿到响应时是 `AI_STATUS_NETWORK` / `AI_STATUS_TIMEOUT`。 */
  status: number;
  /** 响应体文本（`responded=false` 时为空串）。 */
  body: string;
  /** 网络/超时错误文本（`responded=true` 时为空串）。 */
  error: string;
}

/** 一次尝试的结果（在决策层的形状上补正文与用量）。 */
interface SourceAttempt extends FallbackAttemptResult {
  /** 成功时的正文（失败为空串）。 */
  text: string;
  /** 响应里的 usage（拿不到时 null）。 */
  usage: AiUsage | null;
}

/** 运行参数。`enabled` / `maxAttempts` 只是**初值**，每轮尝试前会被设置页里的最新值覆盖。 */
export interface AiFallbackRunOptions {
  /** 本次是否允许 fallback（与设置里的开关取「都开」）。 */
  enabled: boolean;
  /** 最多尝试几次（含主源，夹到 1..4）。 */
  maxAttempts: number;
  /** 每次尝试后的回调（UI 逐条显示诊断；抛错不会打断流程）。 */
  onAttempt?: (diagnostic: FallbackDiagnostic) => void;
  /** 覆盖主源密钥（缺省读设置里的 `aiKey`）。 */
  primaryApiKey?: string;
  /** 覆盖备用源密钥（缺省读设置里的 `aiFallbackKey`）。 */
  fallbackApiKey?: string;
  /** 注入当前时间（缺省 `nowIso()`），便于复现。 */
  nowIso?: string;
  /** 注入时区标签（缺省本机时区）。 */
  timeZone?: string;
}

/** 运行结果（成功/失败同一形状，调用方不必先判空再取字段）。 */
export interface AiFallbackRunResult {
  /** 是否成功拿到正文。 */
  ok: boolean;
  /** 成功时的正文；失败为空串。 */
  reply: string;
  /** 产出正文的源；失败为 `null`。 */
  usedSource: FallbackSource | null;
  /** 逐次尝试的诊断（已脱敏，可直接上界面）。 */
  diagnostics: FallbackDiagnostic[];
  /** 全部失败时的中文原因（成功为空串）。 */
  lastError: string;
  /** 正文对应的 usage（拿不到时 null）。 */
  usage: AiUsage | null;
}

/** 每轮尝试前重读的设置快照。 */
interface LiveSettings {
  /** 设置是否读到了（未初始化时 `false`，此时只信入参）。 */
  readable: boolean;
  /** 两层开关取「都开」后的结果。 */
  enabled: boolean;
  maxAttempts: number;
  /** 设置里保存的备用源顺序（坏数据已经回落成 `[]`）。 */
  order: FallbackSource[];
  primaryKey: string;
  fallbackKey: string;
  aiOptions: AiOptions;
}

/** 整体超时用的哨兵错误（比字符串匹配可靠）。 */
class AiFallbackTimeoutError extends Error {
  constructor() {
    super('AI 请求超时');
  }
}

/** 把 catch 到的错误折成一句可读文本。 */
function describeError(error: object): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/** 本机时区标签，形如 `UTC+08:00`（与 `deepseek.deviceTimeZone` 同一实现，见文件头说明）。 */
function deviceTimeZone(): string {
  const offset: number = -new Date().getTimezoneOffset();
  const sign: string = offset >= 0 ? '+' : '-';
  const abs: number = Math.abs(offset);
  const hours: number = Math.floor(abs / 60);
  const minutes: number = abs % 60;
  const hh: string = hours < 10 ? `0${hours}` : `${hours}`;
  const mm: string = minutes < 10 ? `0${minutes}` : `${minutes}`;
  return `UTC${sign}${hh}:${mm}`;
}

/** 取源的接口基地址：显式 `baseURL` 优先，预设源恒用预设地址（自定义源必须显式给）。 */
function baseURLOf(source: FallbackSource): string {
  const raw: string = source.baseURL === undefined ? '' : source.baseURL;
  return aiBaseURLFor(source.providerId, raw);
}

/**
 * 每轮尝试前重读设置（**用户中途关掉 fallback 必须立即生效**）。
 *
 * 设置读不到（`settingsStore` 还没 init）时不报错，只信入参——运行器不该因为设置在加载中而失败，
 * 但也绝不因此把 `enabled` 当成 true（入参说 false 就是 false）。
 */
async function readLiveSettings(options: AiFallbackRunOptions): Promise<LiveSettings> {
  const live: LiveSettings = {
    readable: false,
    enabled: options.enabled === true,
    maxAttempts: normalizeMaxAttempts(options.maxAttempts),
    order: [],
    primaryKey: options.primaryApiKey === undefined ? '' : options.primaryApiKey,
    fallbackKey: options.fallbackApiKey === undefined ? '' : options.fallbackApiKey,
    aiOptions: defaultAiOptions()
  };
  let settings: ScheduleSettings;
  try {
    // load() 每次都重新 prefs.get，因此这就是「最新设置」而不是缓存
    settings = await settingsStore.load();
  } catch (error) {
    // 未初始化 / 读取失败：沿用入参（fail-closed，enabled 仍取入参值）
    return live;
  }
  live.readable = true;
  // 两层开关取「都开」：调用方显式传 false 或设置里关掉，都立即生效
  live.enabled = live.enabled && settings.aiFallbackEnabled === true;
  live.maxAttempts = normalizeMaxAttempts(settings.aiFallbackMaxAttempts);
  live.order = parseFallbackOrder(settings.aiFallbackOrder);
  live.primaryKey = options.primaryApiKey === undefined ? settings.aiKey.trim() : options.primaryApiKey;
  live.fallbackKey = options.fallbackApiKey === undefined ? settings.aiFallbackKey.trim() : options.fallbackApiKey;
  live.aiOptions = settingsStore.cachedAiOptions();
  return live;
}

/**
 * 组装本轮候选源：主源恒在第一位，备用源优先用设置里保存的顺序。
 *
 * 调用方显式给了多个源（`sources.length > 1`，例如设置页拿当前表单值试跑）时以调用方为准；
 * 否则用设置里的顺序补全——这样「改了备用顺序但没保存」不会被静默采用，保存后的改动立即生效。
 */
function candidatesFor(sources: FallbackSource[], primary: FallbackSource, live: LiveSettings): FallbackSource[] {
  const list: FallbackSource[] = [primary];
  const extra: FallbackSource[] = sources.length > 1 ? sources.slice(1) : live.order;
  for (const item of extra) {
    list.push(item);
  }
  return list;
}

/** 把回调抛错挡在流程外（界面崩了不该连带 fallback 失败）。 */
function notifyAttempt(options: AiFallbackRunOptions, diagnostic: FallbackDiagnostic): void {
  const handler: ((diagnostic: FallbackDiagnostic) => void) | undefined = options.onAttempt;
  if (handler === undefined || handler === null) {
    return;
  }
  try {
    handler(diagnostic);
  } catch (error) {
    // 回调是纯展示逻辑：吞掉异常，诊断已经记在返回值里
  }
}

/** 发一次请求（含整体超时）。**永不抛异常**：网络失败/超时都落到 `HttpOutcome`。 */
async function sendOnce(apiKey: string, request: AiRequest): Promise<HttpOutcome> {
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
          reject(new AiFallbackTimeoutError());
        }, request.timeoutMs);
      }
    );
    const tasks: Array<Promise<http.HttpResponse>> = [httpRequest.request(request.url, requestOptions), timeoutPromise];
    const response: http.HttpResponse = await Promise.race<http.HttpResponse>(tasks);
    const body: string = typeof response.result === 'string' ? response.result : JSON.stringify(response.result);
    const ok: HttpOutcome = { responded: true, status: response.responseCode, body: body, error: '' };
    return ok;
  } catch (error) {
    if (error instanceof AiFallbackTimeoutError) {
      const timeout: HttpOutcome = {
        responded: false,
        status: AI_STATUS_TIMEOUT,
        body: '',
        error: '整体超时（没有在设定时间内响应）'
      };
      return timeout;
    }
    const network: HttpOutcome = {
      responded: false,
      status: AI_STATUS_NETWORK,
      body: '',
      error: describeError(error as Object)
    };
    return network;
  } finally {
    if (timer >= 0) {
      clearTimeout(timer);
    }
    // 超时后请求可能仍在飞：destroy 让底层连接尽快回收
    try {
      httpRequest.destroy();
    } catch (error) {
      // 已销毁/未开始：忽略
    }
  }
}

/** 本地配置问题（缺 key / 地址非法 / 未知源）：一个字节都没发出去，按 `config` 归类。 */
function configAttempt(message: string, startedAt: number): SourceAttempt {
  const failed: SourceAttempt = {
    ok: false,
    status: 400,
    kind: KIND_CONFIG,
    message: message,
    elapsedMs: Date.now() - startedAt,
    text: '',
    usage: null
  };
  return failed;
}

/**
 * 对**一个源**做一次完整尝试（含整体超时），把一切失败折成结构化结果（不抛异常）。
 *
 * 错误文案统一走 `aiRequest.classifyAiError`（与设置页「测试连通性」逐字同源）。
 */
async function attemptSource(
  source: FallbackSource,
  prompt: string,
  apiKey: string,
  options: AiOptions
): Promise<SourceAttempt> {
  const startedAt: number = Date.now();
  const providerId: string = source.providerId.trim().toLowerCase();
  const preset: AiProviderPreset = findProvider(providerId);
  // 未知源**绝不**静默改投默认源：findProvider 会把未知 id 回落 deepseek，那等于把内容发给用户没选的供应商
  if (preset.id !== providerId) {
    return configAttempt(`未知的 AI 源「${source.providerId}」：请检查源配置后重试`, startedAt);
  }
  const key: string = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (key.length === 0) {
    return configAttempt(`未设置 ${preset.label} 密钥：请先在设置页填写（密钥只保存在本机）`, startedAt);
  }
  let request: AiRequest;
  try {
    request = buildAiRequest(
      chatCompletionsURL(baseURLOf(source)),
      resolveModel(preset.id, source.modelId),
      prompt,
      options,
      SYSTEM_PROMPT
    );
  } catch (error) {
    return configAttempt(describeError(error as Object), startedAt);
  }
  const response: HttpOutcome = await sendOnce(key, request);
  const elapsedMs: number = Date.now() - startedAt;
  if (response.responded && response.status === 200) {
    try {
      const reply = parseAiReplyFull(response.body);
      const succeeded: SourceAttempt = {
        ok: true,
        status: 200,
        kind: '',
        message: '',
        elapsedMs: elapsedMs,
        text: reply.text,
        usage: reply.usage
      };
      return succeeded;
    } catch (error) {
      // 200 但正文不可用：决策层按 `parse` → 换源（别的源通常能给出可用正文）
      const unparsable: SourceAttempt = {
        ok: false,
        status: 200,
        kind: KIND_PARSE,
        message: describeError(error as Object),
        elapsedMs: elapsedMs,
        text: '',
        usage: null
      };
      return unparsable;
    }
  }
  const message: string = response.responded
    ? classifyAiError(response.status, response.body, preset.label)
    : classifyAiError(response.status, response.error, preset.label);
  const failed: SourceAttempt = {
    ok: false,
    status: response.status,
    kind: attemptKindForStatus(response.status),
    message: message,
    elapsedMs: elapsedMs,
    text: '',
    usage: null
  };
  return failed;
}

/**
 * 按「主源 → 备用源（用户配置的顺序）」串行执行一次 AI 汇总请求。
 *
 * @param payload    AI 载荷（`buildAiPayload` 的产物；只含当天未处理记录）
 * @param sources    源序列，`sources[0]` 是主源；其余是备用源（也可以只给主源，让运行器读设置里的顺序）
 * @param options    开关 / 尝试次数 / 诊断回调（`enabled` 与设置取「都开」）
 */
export async function runWithFallback(
  payload: AiPayload,
  sources: FallbackSource[],
  options: AiFallbackRunOptions
): Promise<AiFallbackRunResult> {
  const diagnostics: FallbackDiagnostic[] = [];
  if (payload === null || payload === undefined || !Array.isArray(payload.records) || payload.records.length === 0) {
    const empty: AiFallbackRunResult = {
      ok: false,
      reply: '',
      usedSource: null,
      diagnostics: diagnostics,
      lastError: '当天没有需要 AI 整理的记录',
      usage: null
    };
    return empty;
  }
  const list: FallbackSource[] = Array.isArray(sources) ? sources : [];
  if (list.length === 0) {
    const missing: AiFallbackRunResult = {
      ok: false,
      reply: '',
      usedSource: null,
      diagnostics: diagnostics,
      lastError: '没有可用的 AI 源：请先在设置页选择 AI 源',
      usage: null
    };
    return missing;
  }
  const primary: FallbackSource = list[0];
  const prompt: string = buildAiPrompt(
    payload,
    options.nowIso === undefined ? nowIso() : options.nowIso,
    options.timeZone === undefined ? deviceTimeZone() : options.timeZone
  );
  let candidates: FallbackSource[] = list;
  let index: number = 0;
  let attemptNo: number = 0;
  let sameSourceRetries: number = 0;
  let lastError: string = '';
  while (true) {
    const live: LiveSettings = await readLiveSettings(options);
    candidates = candidatesFor(list, primary, live);
    // 重新规划：关掉 fallback 后只剩主源，index 越过 0 就自然退出（这就是「立即生效」）
    const plan: FallbackSource[] = planFallback(candidates, live.enabled, live.maxAttempts);
    if (index >= plan.length) {
      break;
    }
    const target: FallbackSource = plan[index];
    attemptNo++;
    const apiKey: string = isSameSource(target, primary) ? live.primaryKey : live.fallbackKey;
    const result: SourceAttempt = await attemptSource(target, prompt, apiKey, live.aiOptions);
    const outcome: FallbackOutcome = classifyAttempt(result);
    const rawMessage: string = result.message === undefined ? '' : result.message;
    const diagnostic: FallbackDiagnostic = sanitizeDiagnostic({
      attempt: attemptNo,
      providerId: target.providerId,
      modelId: target.modelId,
      outcome: outcome,
      elapsedMs: result.elapsedMs,
      category: categoryOfAttempt(result),
      message: rawMessage.length > 0 ? rawMessage : outcome === 'success' ? `成功：${sourceLabel(target)}` : ''
    });
    diagnostics.push(diagnostic);
    notifyAttempt(options, diagnostic);
    if (outcome === 'success') {
      const succeeded: AiFallbackRunResult = {
        ok: true,
        reply: result.text,
        usedSource: target,
        diagnostics: diagnostics,
        lastError: '',
        usage: result.usage
      };
      return succeeded;
    }
    lastError =
      diagnostic.message.length > 0
        ? diagnostic.message
        : `${sourceLabel(target)} 失败（${diagnostic.category}），已尝试 ${attemptNo} 次`;
    if (outcome === 'abort') {
      break;
    }
    if (outcome === 'retry-same') {
      // 决策表目前不会产出该分支；保留兜底但限制次数，绝不无限重试
      sameSourceRetries++;
      if (sameSourceRetries <= MAX_SAME_SOURCE_RETRIES) {
        continue;
      }
    }
    index++;
    sameSourceRetries = 0;
  }
  const failed: AiFallbackRunResult = {
    ok: false,
    reply: '',
    usedSource: null,
    diagnostics: diagnostics,
    lastError: lastError.length > 0 ? lastError : '所有 AI 源都失败了：请检查网络、密钥与模型名',
    usage: null
  };
  return failed;
}

/**
 * 从设置构造源序列（主源 + 备用顺序，**已过滤掉与主源重复的条目**）。
 *
 * 设置页挂载时只需 `sourcesFromSettings(settings)` 传给 `runWithFallback`，
 * 「主源仍来自 `aiProviderId` / `aiModel` / `aiBaseURL`」这条契约就落在一处。
 */
export function sourcesFromSettings(settings: ScheduleSettings): FallbackSource[] {
  const primary: FallbackSource = { providerId: settings.aiProviderId, modelId: settings.aiModel };
  if (settings.aiBaseURL.length > 0) {
    primary.baseURL = settings.aiBaseURL;
  }
  const result: FallbackSource[] = [primary];
  for (const item of parseFallbackOrder(settings.aiFallbackOrder)) {
    if (!isSameSource(item, primary)) {
      result.push(item);
    }
  }
  return result;
}
