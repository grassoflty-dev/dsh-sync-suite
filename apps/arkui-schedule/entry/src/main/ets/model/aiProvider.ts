/**
 * 多 AI 源的预设表与归一逻辑（纯逻辑：零 SDK import，Node 可直接跑）。
 *
 * 参考 DSH 的 LLM 路由：具名 provider + 模型列表 + 凭据引用。用户只选「源 + 模型」，
 * 密钥单独存（`settingsStore.aiKey`），换源不必重填 key，也不必手抄一堆端点字段。
 *
 * 端点与模型 id 取自本机 DSH 安装包（`resources/app.asar`）里的真实路由；三个预设源都是
 * **OpenAI 兼容的 API Key 模式**（含 codex，走 api.openai.com，不是 ChatGPT 订阅登录）。
 * 模型名允许用户手改（防模型下线），因此 `resolveModel` 对非空模型名一律保留。
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
  /** 一行自助引导：去哪拿 key / 用什么形态的凭据（直接显示在 Key 输入框下方）。 */
  keyHint: string;
  /** 实验源：端点尚未实测，界面应弱化提示，不当成稳定能力宣传。 */
  experimental?: boolean;
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
    baseURL: 'https://opencode.ai/inference/go/v1',
    models: [
      { id: 'deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash' },
      { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' }
    ],
    keyHint: 'OpenCode Go 控制台取 key；端点未实测（标「实验」），失败先查 key 与地址',
    experimental: true
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
  if (status === -1) {
    return '网络或端点不可达（超时），请检查网络/代理';
  }
  if (status === 0) {
    return '网络或端点不可达，请检查网络/代理与防火墙';
  }
  if (status === 401) {
    return preset.id === CUSTOM_PROVIDER_ID
      ? 'key 无效或过期，请核对自定义服务的 key'
      : 'key 无效或过期，请到服务商控制台重新复制';
  }
  if (status === 403) {
    return '账号无该模型权限，请换模型或检查套餐';
  }
  if (status === 404) {
    if (preset.id === 'opencode-go') {
      return '端点可能已变更（OpenCode Go 端点未实测），请核对地址';
    }
    if (preset.id === CUSTOM_PROVIDER_ID) {
      return '端点地址可能不对，请检查 …/v1 路径';
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
