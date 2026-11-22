/**
 * 多 AI 源的预设表与归一逻辑（纯逻辑：零 SDK import，Node 可直接跑）。
 *
 * 参考 DSH 的 LLM 路由：具名 provider + 模型列表 + 凭据引用。用户只选「源 + 模型」，
 * 密钥单独存（`settingsStore.aiKey`），换源不必重填 key，也不必手抄一堆端点字段。
 *
 * 预设源全部是 **OpenAI 兼容的 API Key 模式**（含 codex，走 api.openai.com，不是 ChatGPT 订阅登录）；
 * OpenRouter 用 `provider/model` 命名；本地自建服务请选「自定义」并手填地址（key 可留空）。
 * 模型名允许用户手改（防模型下线），因此 `resolveModel` 对非空模型名一律保留。
 *
 * B2 起本文件还提供「在线拉模型列表」：`parseModelsResponse`（纯解析）+ `modelsURL`（拼 /models）
 * + `fetchModels`（注入 fetch 便于测试，默认 `globalThis.fetch`，失败不抛）。
 *
 * mod-ai-models-fetch 追加：结果的 `kind` 把失败分成九个**类型**（页面按类型显示不同中文文案），
 * 以及模型列表缓存的纯编解码 / 合并函数（provider id → ids + fetchedAt）与「自定义 / 未知」条目。
 * 这些仍是零 import 的纯逻辑，Node 可直接跑；缓存真正落盘在 `services/settingsStore.ets`。
 */

/** 单个模型选项（id 为请求体里的 `model` 值）。 */
export interface AiModelOption {
  id: string;
  label: string;
}

/** 一个可选的 AI 源。 */
export interface AiProviderPreset {
  id: 'deepseek' | 'opencode-go' | 'codex' | 'openrouter' | 'custom';
  label: string;
  baseURL: string;
  models: AiModelOption[];
  /** 一行自助引导：去哪拿 key / 用什么形态的凭据（直接显示在 Key 输入框下方）。 */
  keyHint: string;
}

/** 顺序即设置页展示顺序。 */
export const AI_PROVIDERS: AiProviderPreset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek 官方',
    baseURL: 'https://api.deepseek.com/v1',
    models: [
      { id: 'deepseek-chat', label: 'DeepSeek Chat' },
      { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner' }
    ],
    keyHint: 'platform.deepseek.com → API keys 创建（sk- 开头），测试最稳'
  },
  {
    id: 'opencode-go',
    label: 'OpenCode Go',
    // 官方 Go 网关把 Chat Completions 挂在 /inference/go/openai/v1（模型目录的
    // api.chat-completions.base_url 也是这个值）；旧值 /inference/go/v1 只服务 /models，
    // 拿它拼 /chat/completions 会被网关判为无效请求（400 ai_generate，看着像模型名错）。
    // 模型 slug 本身是对的：deepseek-v4.1-flash 就是官方 id，不加 opencode/ 前缀。
    baseURL: 'https://opencode.ai/inference/go/openai/v1',
    models: [
      { id: 'deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash' },
      { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' }
    ],
    keyHint: 'OpenCode Go 控制台取 key（OpenAI 兼容端点），失败先查 key 与地址'
  },
  {
    id: 'codex',
    label: 'Codex API',
    baseURL: 'https://api.openai.com/v1',
    models: [
      { id: 'gpt-5.1-codex', label: 'GPT-5.1 Codex' },
      { id: 'gpt-5-codex', label: 'GPT-5 Codex' },
      { id: 'gpt-5.1', label: 'GPT-5.1' }
    ],
    keyHint: 'platform.openai.com → API keys（API Key 模式，非 ChatGPT 订阅）'
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    models: [
      { id: 'deepseek/deepseek-chat', label: 'DeepSeek Chat（OpenRouter）' },
      { id: 'anthropic/claude-3.5-sonnet', label: 'Claude 3.5 Sonnet（OpenRouter）' },
      { id: 'google/gemini-2.0-flash', label: 'Gemini 2.0 Flash（OpenRouter）' }
    ],
    keyHint: 'openrouter.ai/keys 取 key；模型名是 provider/model 形式'
  },
  {
    id: 'custom',
    label: '自定义（OpenAI 兼容）',
    baseURL: '',
    models: [{ id: 'custom-model', label: '自定义模型' }],
    keyHint: '任意 OpenAI 兼容服务，填 …/v1 地址与 key'
  }
];

/** 默认源：DeepSeek 官方，与旧版默认模型 `deepseek-chat` 一致。 */
export const DEFAULT_PROVIDER_ID: string = 'deepseek';

/** 自定义源 id：地址由用户填，预设地址留空。 */
export const CUSTOM_PROVIDER_ID: string = 'custom';

/**
 * 已下线的本地源 id（预设表里已删除，仅用于把旧设置迁移到「自定义」）。
 *
 * 只在这里出现一次：迁移逻辑（`migrateLegacyProviderId`）是唯一消费方。
 */
export const LEGACY_OLLAMA_ID: string = 'ollama';

/** 旧源 id 归一：已下线的本地源 → `custom`（地址/模型由调用方原样保留），其它源原样返回。 */
export function migrateLegacyProviderId(value: string): string {
  const text: string = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return text === LEGACY_OLLAMA_ID ? CUSTOM_PROVIDER_ID : value;
}

/** OpenRouter 源 id（模型名是 provider/model 形式）。 */
export const OPENROUTER_PROVIDER_ID: string = 'openrouter';

/** 聊天补全路径。 */
const CHAT_COMPLETIONS_PATH: string = '/chat/completions';

/** 模型列表路径（OpenAI 兼容 `GET /models`）。 */
const MODELS_PATH: string = '/models';

/** 拉模型列表的整体超时（毫秒）。 */
export const AI_MODELS_TIMEOUT_MS: number = 15000;

/** 伪状态码：网络层失败（没拿到 HTTP 响应）。 */
const MODELS_STATUS_NETWORK: number = 0;

/** 伪状态码：整体超时。 */
const MODELS_STATUS_TIMEOUT: number = -1;

/** 按 id 取预设：未知/空一律回退默认源，调用方不用判空。 */
export function findProvider(id: string): AiProviderPreset {
  const text: string = typeof id === 'string' ? id.trim().toLowerCase() : '';
  for (const preset of AI_PROVIDERS) {
    if (preset.id === text) {
      return preset;
    }
  }
  return AI_PROVIDERS[0];
}

/** 该源的模型列表（未知源 → 默认源的列表）。 */
export function modelsOf(id: string): AiModelOption[] {
  return findProvider(id).models;
}

/** 该源的默认模型（列表为空时返回空串）。 */
export function defaultModelOf(id: string): string {
  const models: AiModelOption[] = findProvider(id).models;
  if (models.length === 0) {
    return '';
  }
  return models[0].id;
}

/**
 * 归一模型名：非空一律原样保留，只有空/空白才回落该源默认模型。
 *
 * 预设源的模型列表只是**建议**（模型下线、灰度新模型时用户可手输），因此这里不做白名单校验；
 * 真正打错模型名时由服务商返回 400/404，错误文案里会带出模型名。
 */
export function resolveModel(providerId: string, modelId: string): string {
  const preset: AiProviderPreset = findProvider(providerId);
  const text: string = typeof modelId === 'string' ? modelId.trim() : '';
  if (text.length > 0) {
    return text;
  }
  return defaultModelOf(preset.id);
}

/**
 * 归一接口基地址：去掉全部空白、缺协议补 `https://`、去尾斜杠、协议与域名小写。
 *
 * 路径大小写必须保留（`/v1/Chat` 与 `/v1/chat` 是两条路径）；空串返回空串，
 * 由 `isValidBaseURL` 判不合格，不要在这里猜一个地址。
 */
export function normalizeBaseURL(raw: string): string {
  let text: string = typeof raw === 'string' ? raw.replace(/\s+/g, '') : '';
  if (text.length === 0) {
    return '';
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    text = `https://${text}`;
  }
  while (text.endsWith('/')) {
    text = text.slice(0, text.length - 1);
  }
  const match: RegExpExecArray | null = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)(.*)$/i.exec(text);
  if (match === null) {
    return text;
  }
  return `${match[1].toLowerCase()}://${match[2].toLowerCase()}${match[3]}`;
}

/**
 * 是否为可用的接口基地址。先归一，因此用户只填域名（`api.deepseek.com`）也算通过；
 * 不要求域名带点，`http://localhost:8080/v1` 这类本地反代同样放行。
 */
export function isValidBaseURL(raw: string): boolean {
  const text: string = normalizeBaseURL(raw);
  if (!/^https?:\/\//i.test(text)) {
    return false;
  }
  const afterScheme: string = text.slice(text.indexOf('://') + 3);
  const host: string = afterScheme.split('/')[0];
  return host.length > 0;
}

/**
 * 拼聊天补全端点：已含 `/chat/completions` 就不重复拼。
 *
 * 与 `aiRequest.aiChatUrl` 同义，区别是先走 `normalizeBaseURL`（补 https、去尾斜杠），
 * 空地址/非法地址直接抛中文错误，由服务层翻成界面文案。
 */
export function chatCompletionsURL(baseURL: string): string {
  const base: string = normalizeBaseURL(baseURL);
  if (base.length === 0) {
    throw new Error('接口地址不能为空：请先在设置页选择 AI 源（自定义源还需填写接口地址）');
  }
  if (!isValidBaseURL(base)) {
    throw new Error(`接口地址格式不正确：${base}（需要 http:// 或 https:// 开头的地址）`);
  }
  if (base.toLowerCase().endsWith(CHAT_COMPLETIONS_PATH)) {
    return base;
  }
  return `${base}${CHAT_COMPLETIONS_PATH}`;
}

/**
 * 拼模型列表端点（`GET …/models`）：已含 `/models` 不重复拼；
 * 用户填了完整 `/chat/completions` 时自动截掉换成 `/models`。
 */
export function modelsURL(baseURL: string): string {
  const base: string = normalizeBaseURL(baseURL);
  if (base.length === 0) {
    throw new Error('接口地址不能为空：请先在设置页选择 AI 源（自定义源还需填写接口地址）');
  }
  if (!isValidBaseURL(base)) {
    throw new Error(`接口地址格式不正确：${base}（需要 http:// 或 https:// 开头的地址）`);
  }
  const lower: string = base.toLowerCase();
  if (lower.endsWith(MODELS_PATH)) {
    return base;
  }
  if (lower.endsWith(CHAT_COMPLETIONS_PATH)) {
    return `${base.slice(0, base.length - CHAT_COMPLETIONS_PATH.length)}${MODELS_PATH}`;
  }
  return `${base}${MODELS_PATH}`;
}

/**
 * 解析 `GET /models` 的响应体，返回模型 id 列表（去重、保持顺序）。
 *
 * 兼容三种形态（实测各家都在这三种里）：
 * - OpenAI：`{ "data": [{ "id": "deepseek-chat" }, …] }`
 * - 直数组：`[{ "id": "llama3.2" }, …]`
 * - `{ "models": [{ "name": "qwen2.5" }] }` 或 `{ "models": ["qwen2.5"] }`
 *
 * 坏 JSON / 空串 / 结构不认识一律返回 `[]`（不抛异常）。
 */
export function parseModelsResponse(jsonText: string): string[] {
  const text: string = typeof jsonText === 'string' ? jsonText.trim() : '';
  if (text.length === 0) {
    return [];
  }
  let parsed: Object | null;
  try {
    parsed = JSON.parse(text) as Object | null;
  } catch {
    return [];
  }
  const result: string[] = [];
  try {
    const entries: Object[] = modelEntries(parsed);
    for (const entry of entries) {
      // 单条坏数据（数组里混 null / 数字）只跳过它，不影响其它模型
      let id: string = '';
      try {
        id = modelIdOf(entry);
      } catch {
        id = '';
      }
      if (id.length > 0 && result.indexOf(id) < 0) {
        result.push(id);
      }
    }
  } catch {
    // 顶层结构诡异（data/models 不是数组等）：按「不认识的结构」处理，绝不抛给界面
    return [];
  }
  return result;
}

/** 从任意响应体里取出候选条目数组（不认识的结构返回空数组）。 */
function modelEntries(parsed: Object | null): Object[] {
  if (parsed === null) {
    return [];
  }
  if (Array.isArray(parsed)) {
    return parsed as Object[];
  }
  const bag: Record<string, Object> = parsed as unknown as Record<string, Object>;
  const data: Object = bag['data'];
  if (Array.isArray(data)) {
    return data as Object[];
  }
  const models: Object = bag['models'];
  if (Array.isArray(models)) {
    return models as Object[];
  }
  return [];
}

/** 单个条目的 id：字符串条目直接当 id，对象取 `id` / `name` / `model`。 */
function modelIdOf(entry: Object): string {
  if (typeof entry === 'string') {
    return entry.trim();
  }
  const bag: Record<string, Object> = entry as unknown as Record<string, Object>;
  for (const key of ['id', 'name', 'model']) {
    const value: Object = bag[key];
    if (typeof value === 'string') {
      const text: string = value.trim();
      if (text.length > 0) {
        return text;
      }
    }
  }
  return '';
}

/** 拉模型列表的注入点：标准 fetch 的最小子集（只用到 status / text()）。 */
export interface AiFetchInit {
  method: string;
  headers: Record<string, string>;
}

/** 标准 fetch 的响应（只声明用到的部分）。 */
export interface AiFetchResponse {
  status: number;
  text(): Promise<string>;
}

/** 注入用的 fetch 形状（测试传假实现，生产用 `globalThis.fetch`）。 */
export type AiFetchImpl = (url: string, init: AiFetchInit) => Promise<AiFetchResponse>;

/** 拉模型列表的**类型化**结果分类（页面按 kind 取不同中文文案，不再靠字符串猜）。 */
export type AiModelsKind =
  | 'ok'
  | 'config'
  | 'network'
  | 'timeout'
  | 'unauthorized'
  | 'forbidden'
  | 'http'
  | 'malformed'
  | 'empty';

/** 拉模型列表的结果（失败不抛，页面直接显示 `message`）。 */
export interface AiModelsResult {
  ok: boolean;
  /** 解析出的模型 id（失败为空数组）。 */
  models: string[];
  /** HTTP 状态码；网络失败 0，超时 -1。 */
  status: number;
  /** 中文文案（成功含数量，失败含原因）。 */
  message: string;
  /** 失败类型；'ok' = 拿到非空列表，'empty'/'malformed' 是 HTTP 200 但不可用。 */
  kind: AiModelsKind;
}

/** 单个源的模型列表缓存（只存成功拉到的列表）。 */
export interface AiModelsCacheEntry {
  /** 原样保留的模型 id（不归一、不美化）。 */
  ids: string[];
  /** 拉取成功的时刻（ISO 8601）。 */
  fetchedAt: string;
}

/** 缓存表：provider id → 该源最近一次成功列表。 */
export type AiModelsCacheMap = Record<string, AiModelsCacheEntry>;

/** 支持 `GET …/models` 的源；全部为 OpenAI 兼容源，`custom` 需先填接口地址。 */
export const MODELS_LIST_PROVIDERS: string[] = [
  'deepseek',
  'opencode-go',
  'codex',
  'openrouter',
  CUSTOM_PROVIDER_ID
];

/** 该源有没有模型列表端点（未知源回退默认源，仍返回 true）。 */
export function supportsModelsList(providerId: string): boolean {
  const id: string = findProvider(providerId).id;
  for (const candidate of MODELS_LIST_PROVIDERS) {
    if (candidate === id) {
      return true;
    }
  }
  return false;
}

/** 「自定义 / 未知」条目的展示名（保存的模型 id 不在列表里时仍可选）。 */
export function customModelLabel(id: string): string {
  return `自定义 / 未知：${id}`;
}

/**
 * 合并列表与当前保存的模型 id：id 不在列表里时**追加**为自定义条目，绝不静默丢弃。
 *
 * 去重、保持原顺序；空 id 不追加。列表里已有的 id 原样保留，不改写标签。
 */
export function mergeModelIds(ids: string[], savedId: string): string[] {
  const result: string[] = [];
  for (const id of ids) {
    if (typeof id === 'string' && id.trim().length > 0 && result.indexOf(id) < 0) {
      result.push(id);
    }
  }
  const saved: string = typeof savedId === 'string' ? savedId.trim() : '';
  if (saved.length > 0 && result.indexOf(saved) < 0) {
    result.push(saved);
  }
  return result;
}

/**
 * 把某源的成功列表写进缓存表（纯 patch）：只替换该源条目，其它源逐字保留。
 *
 * `ids` 为空时**直接返回原表**：失败 / 空列表绝不覆盖上一次成功缓存。
 */
export function withCachedModels(
  map: AiModelsCacheMap,
  providerId: string,
  ids: string[],
  fetchedAt: string
): AiModelsCacheMap {
  if (ids.length === 0) {
    return map;
  }
  const next: AiModelsCacheMap = {};
  for (const key of Object.keys(map)) {
    if (key !== providerId) {
      next[key] = map[key];
    }
  }
  next[providerId] = { ids: ids.slice(), fetchedAt: fetchedAt };
  return next;
}

/** 解码 preferences 里的缓存串（坏 JSON / 旧结构 / 空列表条目一律丢掉，返回空表，不抛）。 */
export function decodeAiModelsCache(text: string): AiModelsCacheMap {
  const result: AiModelsCacheMap = {};
  const raw: string = typeof text === 'string' ? text.trim() : '';
  if (raw.length === 0) {
    return result;
  }
  try {
    const parsed: Object | null = JSON.parse(raw) as Object | null;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return result;
    }
    const bag: Record<string, Object> = parsed as unknown as Record<string, Object>;
    for (const key of Object.keys(bag)) {
      const value: Object = bag[key];
      if (value === null || typeof value !== 'object') {
        continue;
      }
      const entry: Record<string, Object> = value as unknown as Record<string, Object>;
      const idsRaw: Object = entry['ids'];
      const fetchedAtRaw: Object = entry['fetchedAt'];
      if (!Array.isArray(idsRaw) || typeof fetchedAtRaw !== 'string') {
        continue;
      }
      const ids: string[] = [];
      for (const item of idsRaw) {
        if (typeof item === 'string' && item.trim().length > 0 && ids.indexOf(item) < 0) {
          ids.push(item);
        }
      }
      if (ids.length > 0) {
        result[key] = { ids: ids, fetchedAt: fetchedAtRaw };
      }
    }
  } catch {
    // 坏数据当「没有缓存」：页面回落预设列表，不让一行脏数据影响设置页
    return {};
  }
  return result;
}

/** 编码缓存表为 preferences 字符串（只存 id 与 fetchedAt，不含 key / URL / 响应正文）。 */
export function encodeAiModelsCache(map: AiModelsCacheMap): string {
  return JSON.stringify(map);
}

/** 拉模型列表超时的哨兵错误（比字符串匹配可靠）。 */
class AiModelsTimeoutError extends Error {
  constructor() {
    super('获取模型列表超时');
  }
}

/**
 * 定时器宿主接口。
 *
 * 模型层不 import 任何运行时（包括 `@kit.*`），而 `tools/tsconfig.json` 的 lib 只有 ES2021
 * （没有 DOM 的 `setTimeout` 声明），因此从 `globalThis` 取——与 `common/platform.ts`
 * 读 `globalThis.__arkuiXPlatform` 同一手法。Node 与 ArkTS 两侧都提供这两个全局函数。
 */
interface TimerScope {
  setTimeout(handler: () => void, timeout: number): number;
  clearTimeout(handle: number): void;
}

/** 取定时器宿主（见 `TimerScope` 注释）。 */
function timerScope(): TimerScope {
  return globalThis as unknown as TimerScope;
}

/** 取运行时全局 fetch（Node 18+ / 浏览器 / 鸿蒙 NEXT 都有）；缺失返回 null。 */
function defaultFetchImpl(): AiFetchImpl | null {
  const scope: Record<string, AiFetchImpl | undefined> = globalThis as unknown as Record<
    string,
    AiFetchImpl | undefined
  >;
  const impl: AiFetchImpl | undefined = scope['fetch'];
  if (typeof impl === 'function') {
    return impl;
  }
  return null;
}

/** 失败文案（源名只用于 401，其余统一措辞）。 */
function modelsFailureMessage(providerId: string, status: number): string {
  const preset: AiProviderPreset = findProvider(providerId);
  if (status === MODELS_STATUS_TIMEOUT) {
    return '获取模型列表超时：请检查网络或代理后再试（可继续用缓存列表）';
  }
  if (status === MODELS_STATUS_NETWORK) {
    return '网络异常：无法连接接口（请检查网络、代理或防火墙；可继续用缓存列表）';
  }
  if (status === 401) {
    return `密钥无效或已失效：请核对 ${preset.label} 的 key 后重试`;
  }
  if (status === 403) {
    return '无权限读取模型列表：请检查 key 的权限范围（可继续用缓存列表）';
  }
  if (status === 404) {
    return '接口地址可能不对：请检查 …/v1 路径（可继续用缓存列表）';
  }
  if (status === 429) {
    return '请求过于频繁，请稍后再试（可继续用缓存列表）';
  }
  if (status >= 500) {
    return '服务端错误，请稍后再试（可继续用缓存列表）';
  }
  return `请求失败（HTTP ${status}）：请检查接口地址或稍后重试（可继续用缓存列表）`;
}

/** HTTP 状态码 → 失败类型（401/403 单独列，其余非 200 统一 'http'）。 */
function modelsKindForStatus(status: number): AiModelsKind {
  if (status === 401) {
    return 'unauthorized';
  }
  if (status === 403) {
    return 'forbidden';
  }
  return 'http';
}

/**
 * 200 的响应体是不是「认识的结构」（即使列表为空）。
 *
 * 用来区分 `empty`（服务端明确返回空列表）与 `malformed`（结构不认识 / 坏 JSON）：
 * 两者都解析出空数组，但页面文案不同，且都**不覆盖**已有缓存。
 */
function modelsEnvelopeRecognized(jsonText: string): boolean {
  const text: string = typeof jsonText === 'string' ? jsonText.trim() : '';
  if (text.length === 0) {
    return false;
  }
  try {
    const parsed: Object | null = JSON.parse(text) as Object | null;
    if (Array.isArray(parsed)) {
      return true;
    }
    if (parsed === null || typeof parsed !== 'object') {
      return false;
    }
    const bag: Record<string, Object> = parsed as unknown as Record<string, Object>;
    return Array.isArray(bag['data']) || Array.isArray(bag['models']);
  } catch {
    return false;
  }
}

/** 组装失败结果（带类型，页面不需要再靠字符串猜原因）。 */
function modelsFailure(status: number, message: string, kind: AiModelsKind): AiModelsResult {
  const failed: AiModelsResult = {
    ok: false,
    models: [],
    status: status,
    message: message,
    kind: kind
  };
  return failed;
}

/**
 * 在线拉取某个源的模型列表（B2）。
 *
 * - `baseURL` 为空时用预设地址（自定义源为空 → 返回失败，不猜地址）；
 * - `apiKey` 为空时不发 Authorization（本地自建服务通常不校验 key）；
 * - `fetchImpl` 可注入（测试用假实现），缺省 `globalThis.fetch`；
 * - **永不抛异常**：网络失败/超时/非 200 都折成 `{ok:false, status, message, kind}`；
 * - key 只进 `Authorization` 头，失败文案与日志均不带 key。
 *
 * @param providerId 源 id（未知回退默认源）
 * @param baseURL    接口基地址（空串用预设）
 * @param apiKey     密钥（空串不带鉴权头）
 * @param fetchImpl  注入的 fetch（可选）
 * @param timeoutMs  整体超时（可选，默认 `AI_MODELS_TIMEOUT_MS`）
 */
export async function fetchModels(
  providerId: string,
  baseURL: string,
  apiKey: string,
  fetchImpl?: AiFetchImpl,
  timeoutMs: number = AI_MODELS_TIMEOUT_MS
): Promise<AiModelsResult> {
  const preset: AiProviderPreset = findProvider(providerId);
  const explicitBase: string = typeof baseURL === 'string' ? normalizeBaseURL(baseURL) : '';
  const base: string = explicitBase.length > 0 ? explicitBase : preset.baseURL;
  let url: string;
  try {
    url = modelsURL(base);
  } catch (error) {
    return modelsFailure(MODELS_STATUS_NETWORK, describeErrorText(error), 'config');
  }
  const impl: AiFetchImpl | null = fetchImpl === undefined ? defaultFetchImpl() : fetchImpl;
  if (impl === null) {
    return modelsFailure(
      MODELS_STATUS_NETWORK,
      '当前运行时不支持 fetch：无法在线获取模型列表（可继续用缓存列表）',
      'network'
    );
  }
  const key: string = typeof apiKey === 'string' ? apiKey.trim() : '';
  const headers: Record<string, string> = { 'Accept': 'application/json' };
  if (key.length > 0) {
    headers['Authorization'] = `Bearer ${key}`;
  }
  const init: AiFetchInit = { method: 'GET', headers: headers };
  const waitMs: number = timeoutMs > 0 ? timeoutMs : AI_MODELS_TIMEOUT_MS;
  const timers: TimerScope = timerScope();
  let timer: number = -1;
  let response: AiFetchResponse;
  try {
    const timeoutPromise = new Promise<AiFetchResponse>(
      (_resolve: (value: AiFetchResponse) => void, reject: (reason: Object) => void) => {
        timer = timers.setTimeout(() => {
          reject(new AiModelsTimeoutError());
        }, waitMs);
      }
    );
    response = await Promise.race<AiFetchResponse>([impl(url, init), timeoutPromise]);
  } catch (error) {
    if (error instanceof AiModelsTimeoutError) {
      return modelsFailure(MODELS_STATUS_TIMEOUT, modelsFailureMessage(preset.id, MODELS_STATUS_TIMEOUT), 'timeout');
    }
    return modelsFailure(MODELS_STATUS_NETWORK, modelsFailureMessage(preset.id, MODELS_STATUS_NETWORK), 'network');
  } finally {
    if (timer >= 0) {
      timers.clearTimeout(timer);
    }
  }
  let bodyText: string = '';
  try {
    bodyText = await response.text();
  } catch (error) {
    return modelsFailure(MODELS_STATUS_NETWORK, modelsFailureMessage(preset.id, MODELS_STATUS_NETWORK), 'network');
  }
  if (response.status !== 200) {
    return modelsFailure(
      response.status,
      modelsFailureMessage(preset.id, response.status),
      modelsKindForStatus(response.status)
    );
  }
  const models: string[] = parseModelsResponse(bodyText);
  if (models.length === 0) {
    const recognized: boolean = modelsEnvelopeRecognized(bodyText);
    const unusable: AiModelsResult = {
      ok: true,
      models: [],
      status: 200,
      message: recognized
        ? '成功：HTTP 200，但返回的模型列表为空（可继续用缓存列表）'
        : '返回的数据格式无法识别：请用上次缓存或稍后重试',
      kind: recognized ? 'empty' : 'malformed'
    };
    return unusable;
  }
  const succeeded: AiModelsResult = {
    ok: true,
    models: models,
    status: 200,
    message: `成功：HTTP 200 / ${models.length} 个模型`,
    kind: 'ok'
  };
  return succeeded;
}

/** 把 catch 到的错误折成一句中文（fetchModels 内部用）。 */
function describeErrorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * 失败后的一行可操作建议（空串 = 成功，无需提示）。
 *
 * `status` 与 `aiRequest.classifyAiError` 同源：HTTP 状态码，或伪状态码 `-1`（超时）/`0`（网络失败）。
 * 这里只说「下一步做什么」，不复述错误码——原因由 `classifyAiError` 的文案负责。
 */
export function hintForProvider(providerId: string, status: number): string {
  const preset: AiProviderPreset = findProvider(providerId);
  if (status === 200) {
    return '';
  }
  if (status === -1 || status === 0) {
    return status === -1 ? '网络或端点不可达（超时），请检查网络/代理' : '网络或端点不可达，请检查网络/代理与防火墙';
  }
  if (status === 401) {
    if (preset.id === CUSTOM_PROVIDER_ID) {
      return 'key 无效或过期，请核对自定义服务的 key';
    }
    if (preset.id === OPENROUTER_PROVIDER_ID) {
      return 'key 无效或过期，请到 openrouter.ai/keys 重新复制';
    }
    return 'key 无效或过期，请到服务商控制台重新复制';
  }
  if (status === 403) {
    return '账号无该模型权限，请换模型或检查套餐';
  }
  if (status === 404) {
    if (preset.id === 'opencode-go') {
      return '端点可能已变更（OpenCode Go），请核对地址';
    }
    if (preset.id === CUSTOM_PROVIDER_ID) {
      return '端点地址可能不对，请检查 …/v1 路径';
    }
    if (preset.id === OPENROUTER_PROVIDER_ID) {
      return '模型名是 provider/model 形式（如 deepseek/deepseek-chat），请核对';
    }
    return '端点或模型名可能已变更，可手改模型名再试';
  }
  if (status === 429) {
    return '限流，请稍后再试';
  }
  if (status === 400 || status === 422) {
    return '模型名或参数不被接受，可手改模型名再试';
  }
  if (status >= 500) {
    return '服务商服务端异常，请稍后再试';
  }
  return '请求失败，请检查源配置后重试';
}
