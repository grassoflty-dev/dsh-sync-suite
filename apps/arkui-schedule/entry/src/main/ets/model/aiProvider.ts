/**
 * 多 AI 源的预设表与归一逻辑（纯逻辑：零 SDK import，Node 可直接跑）。
 *
 * 参考 DSH 的 LLM 路由：具名 provider + 模型列表 + 凭据引用。用户只选「源 + 模型」，
 * 密钥单独存（`settingsStore.aiKey`），换源不必重填 key，也不必手抄一堆端点字段。
 *
 * 模型 id 以各服务商公开文档为准；不确定的（opencode-go 地址、codex 模型清单）
 * 标「待核实」，不要照抄猜测值。
 */

/** 单个模型选项（id 为请求体里的 `model` 值）。 */
export interface AiModelOption {
  id: string;
  label: string;
}

/** 一个可选的 AI 源。 */
export interface AiProviderPreset {
  id: 'deepseek' | 'opencode-go' | 'codex' | 'custom';
  label: string;
  baseURL: string;
  models: AiModelOption[];
  /** 一行提示：去哪拿 key / 用什么形态的凭据。 */
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
    keyHint: 'platform.deepseek.com → API keys 创建（sk- 开头）'
  },
  {
    id: 'opencode-go',
    label: 'OpenCode Go',
    baseURL: 'https://api.opencode.ai/v1',
    models: [
      { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
      { id: 'deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash' }
    ],
    keyHint: '密钥与接口地址以服务商控制台为准（地址为占位，待核实）'
  },
  {
    id: 'codex',
    label: 'Codex 订阅',
    baseURL: 'https://chatgpt.com/backend-api/codex',
    models: [
      { id: 'gpt-5-codex', label: 'GPT-5 Codex' },
      { id: 'gpt-5', label: 'GPT-5' }
    ],
    keyHint: '使用订阅 OAuth 登录，不是 API Key（模型与额度取决于账号）'
  },
  {
    id: 'custom',
    label: '自定义',
    baseURL: '',
    models: [{ id: 'custom-model', label: '自定义模型' }],
    keyHint: '填 OpenAI 兼容接口地址（…/v1）与密钥'
  }
];

/** 默认源：DeepSeek 官方，与旧版默认模型 `deepseek-chat` 一致。 */
export const DEFAULT_PROVIDER_ID: string = 'deepseek';

/** 自定义源 id：地址由用户填，预设地址留空。 */
export const CUSTOM_PROVIDER_ID: string = 'custom';

/** 聊天补全路径。 */
const CHAT_COMPLETIONS_PATH: string = '/chat/completions';

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
 * 归一模型名：空/未知 → 该源默认模型。
 *
 * 自定义源例外：端点与模型都由用户掌握，非空模型名原样保留，
 * 否则「自定义」等于只剩一个写死的模型。
 */
export function resolveModel(providerId: string, modelId: string): string {
  const preset: AiProviderPreset = findProvider(providerId);
  const text: string = typeof modelId === 'string' ? modelId.trim() : '';
  if (preset.id === CUSTOM_PROVIDER_ID && text.length > 0) {
    return text;
  }
  for (const model of preset.models) {
    if (model.id === text) {
      return text;
    }
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
 * 不要求域名带点，`http://localhost:11434/v1` 这类本地反代同样放行。
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
