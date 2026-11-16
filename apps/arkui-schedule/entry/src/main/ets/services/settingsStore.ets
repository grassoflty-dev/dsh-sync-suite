/**
 * 本机设置存储（设备标识 / 仓库地址 / token / AI 源与模型 / AI 参数与备用源 / 作者名 / 平台 / 认证方式）。
 *
 * 落盘方式：`@kit.ArkData` 的 `preferences`（值不外泄，不进 Git 同步载荷）。
 * 设备标识同时决定日程目录 `git-repo/devices/<deviceId>/`，因此必须匹配
 * `^[a-z0-9][a-z0-9-]{0,31}$`（`docs/DATA-CONTRACT.md` §1）。
 *
 * 契约：`docs/CONTRACT.md` §3.3、BRIEF §3.5（设置页）。
 */
import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';
import {
  AI_DEFAULT_MAX_TOKENS,
  AI_DEFAULT_RETRIES,
  AI_DEFAULT_TEMPERATURE,
  AI_TIMEOUT_MS,
  DEFAULT_AI_MODEL,
  defaultAiOptions,
  normalizeAiOptions
} from '../model/aiRequest';
import type { AiOptions } from '../model/aiRequest';
import {
  CUSTOM_PROVIDER_ID,
  DEFAULT_PROVIDER_ID,
  defaultModelOf,
  findProvider,
  migrateLegacyProviderId,
  normalizeBaseURL,
  resolveModel as resolveAiModel
} from '../model/aiProvider';
import { AUTH_HTTPS, PLATFORM_GITHUB, normalizeAuthMode, normalizePlatform } from '../model/settingsForm';
import { normalizeSyncAction } from '../model/syncError';

/** 设备标识默认值：首次启动即 `phone-a`，可在设置页修改。 */
export const DEFAULT_DEVICE_ID: string = 'phone-a';

/** 设备标识合法格式（与 DATA-CONTRACT §1 的快照目录名规则一致）。 */
export const DEVICE_ID_PATTERN: RegExp = new RegExp('^[a-z0-9][a-z0-9-]{0,31}$');

/** 设置项（全部为字符串，避免 preferences 值类型抖动）。 */
export interface ScheduleSettings {
  /** 设备标识，决定 devices/<id>/ 目录。 */
  deviceId: string;
  /** 远端仓库地址（https://… / ssh://… / git@host:path）。 */
  repoUrl: string;
  /** HTTPS 访问 token（仅存本机）。 */
  token: string;
  /** AI 密钥（仅存本机；与源解耦，换源可继续用）。 */
  aiKey: string;
  /** AI 源 id：`deepseek` | `opencode-go` | `codex` | `openrouter` | `custom`（未知/空回退默认源）。 */
  aiProviderId: string;
  /** 模型名，空值与未知值在读取时归一到该源默认模型。 */
  aiModel: string;
  /** 自定义源的接口基地址；预设源忽略此值（用预设地址）。 */
  aiBaseURL: string;
  /** 采样温度（0–2，默认 0.7；旧数据无该字段 = 默认值）。 */
  aiTemperature: number;
  /** 输出 token 上限（默认 1024）。 */
  aiMaxTokens: number;
  /** 单次请求整体超时（毫秒，默认 30000）。 */
  aiTimeoutMs: number;
  /** 自动重试次数（不含首次请求，默认 1，上限 3）。 */
  aiRetries: number;
  /** 备用源 id（空串 = 不启用备用源；未知 id 归一为空串）。 */
  aiFallbackProviderId: string;
  /** 备用源模型名（空串 = 用该源默认模型）。 */
  aiFallbackModel: string;
  /** 备用源接口基地址（预设源恒用预设地址，自定义源用填写值）。 */
  aiFallbackBaseURL: string;
  /** 备用源密钥（仅存本机；与主源 key 分开，允许不同服务商）。 */
  aiFallbackKey: string;
  /** 作者名，写入日程记录的 author 字段。 */
  author: string;
  /** 托管平台：`github` | `gitee`（只影响提示文案与示例）。 */
  gitPlatform: string;
  /** HTTPS 认证用户名（Gitee 必填 = 登录名；GitHub 留空则用 x-access-token）。旧数据无该字段 = ''。 */
  gitUsername: string;
  /** 认证方式：`https` | `ssh`（只影响提示文案与 token 是否必填）。 */
  authMode: string;
  /** 仅手写笔输入：true 时手写板拒绝手指、只接受手写笔（默认 false；旧数据缺字段 = false）。 */
  penOnlyInput: boolean;
  /** 上次同步成功的时刻（ISO 8601，空串表示从未同步）。仅用于设置页展示。 */
  lastSyncAt: string;
  /** 上次同步失败的**分级后中文文案**（空串表示上次没有失败）。仅用于设置页展示。 */
  lastSyncError: string;
  /** 上次同步动作：`pull` | `push` | `status`（空串表示没有可重试的动作）。 */
  lastSyncAction: string;
}

/** 同步状态的部分更新（不触碰 token 等其它设置）。 */
export interface SyncStatePatch {
  lastSyncAt?: string;
  lastSyncError?: string;
  lastSyncAction?: string;
}

/** 部分更新（未出现的字段保持原值）。 */
export interface SettingsPatch {
  deviceId?: string;
  repoUrl?: string;
  token?: string;
  aiKey?: string;
  aiProviderId?: string;
  aiModel?: string;
  aiBaseURL?: string;
  aiTemperature?: number;
  aiMaxTokens?: number;
  aiTimeoutMs?: number;
  aiRetries?: number;
  aiFallbackProviderId?: string;
  aiFallbackModel?: string;
  aiFallbackBaseURL?: string;
  aiFallbackKey?: string;
  author?: string;
  gitPlatform?: string;
  gitUsername?: string;
  authMode?: string;
  penOnlyInput?: boolean;
}

/** 备用源配置（`deepseek` 服务层直接消费；`configured=false` 表示不启用）。 */
export interface AiFallbackSettings {
  /** 是否配了备用源（`aiFallbackProviderId` 非空且是已知源）。 */
  configured: boolean;
  providerId: string;
  model: string;
  baseURL: string;
  apiKey: string;
}

const PREFERENCES_NAME: string = 'schedule_settings';
const KEY_DEVICE_ID: string = 'deviceId';
const KEY_REPO_URL: string = 'repoUrl';
const KEY_TOKEN: string = 'token';
const KEY_AI_KEY: string = 'aiKey';
const KEY_AI_PROVIDER_ID: string = 'aiProviderId';
const KEY_AI_MODEL: string = 'aiModel';
const KEY_AI_BASE_URL: string = 'aiBaseURL';
const KEY_AI_TEMPERATURE: string = 'aiTemperature';
const KEY_AI_MAX_TOKENS: string = 'aiMaxTokens';
const KEY_AI_TIMEOUT_MS: string = 'aiTimeoutMs';
const KEY_AI_RETRIES: string = 'aiRetries';
const KEY_AI_FALLBACK_PROVIDER_ID: string = 'aiFallbackProviderId';
const KEY_AI_FALLBACK_MODEL: string = 'aiFallbackModel';
const KEY_AI_FALLBACK_BASE_URL: string = 'aiFallbackBaseURL';
const KEY_AI_FALLBACK_KEY: string = 'aiFallbackKey';
const KEY_AUTHOR: string = 'author';
const KEY_GIT_PLATFORM: string = 'gitPlatform';
const KEY_GIT_USERNAME: string = 'gitUsername';
const KEY_AUTH_MODE: string = 'authMode';
const KEY_PEN_ONLY_INPUT: string = 'penOnlyInput';
const KEY_LAST_SYNC_AT: string = 'lastSyncAt';
const KEY_LAST_SYNC_ERROR: string = 'lastSyncError';
const KEY_LAST_SYNC_ACTION: string = 'lastSyncAction';

/** 规范化设备标识：非法值回退默认，避免写出非法目录名。 */
export function normalizeDeviceId(value: string): string {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return DEVICE_ID_PATTERN.test(text) ? text : DEFAULT_DEVICE_ID;
}

/** 规范化模型名：空白回退默认 `deepseek-chat`。 */
export function normalizeAiModel(value: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > 0 ? text : DEFAULT_AI_MODEL;
}

/**
 * 归一接口基地址：预设源恒用预设地址（预设升级后旧设置自动跟上，用户不必手改），
 * 自定义源才用用户填写的值。
 */
export function aiBaseURLFor(providerId: string, rawBaseURL: string): string {
  const preset = findProvider(providerId);
  if (preset.id !== CUSTOM_PROVIDER_ID) {
    return preset.baseURL;
  }
  return normalizeBaseURL(typeof rawBaseURL === 'string' ? rawBaseURL : '');
}

/**
 * 归一备用源 id：空/未知一律 `''`（= 不启用备用源）。
 *
 * 与主源不同，这里**不**回退默认源：备用源是可选能力，写错 id 就当没配，绝不悄悄把
 * DeepSeek 当备用源去打请求（用户会看到「没切源」而不是莫名多花一次钱）。
 */
export function normalizeFallbackProviderId(value: string): string {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (text.length === 0) {
    return '';
  }
  return findProvider(text).id === text ? text : '';
}

/**
 * 归一备用源接口基地址：没配备用源 → 空串；预设源恒用预设地址；自定义源用填写值。
 */
export function aiFallbackBaseURLFor(fallbackProviderId: string, rawBaseURL: string): string {
  const providerId: string = normalizeFallbackProviderId(fallbackProviderId);
  if (providerId.length === 0) {
    return '';
  }
  return aiBaseURLFor(providerId, rawBaseURL);
}

/** 读取 preferences 里的字符串值（非字符串按默认值处理）。 */
function readString(value: preferences.ValueType, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/** 读取 preferences 里的数字值（非数字/NaN 按默认值处理：旧数据没有这些键）。 */
function readNumber(value: preferences.ValueType, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** 读取 preferences 里的布尔值（旧数据没有该键 / 非布尔值 → 默认值）。 */
function readBoolean(value: preferences.ValueType, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export class SettingsStore {
  private prefs: preferences.Preferences | null = null;
  private cache: ScheduleSettings | null = null;

  /** 初始化（幂等）：必须在使用 load/save 之前调用一次。 */
  async init(context: object): Promise<void> {
    if (this.prefs !== null) {
      return;
    }
    const abilityContext = context as common.UIAbilityContext;
    this.prefs = await preferences.getPreferences(abilityContext, { name: PREFERENCES_NAME });
  }

  /** 读取全部设置；`context` 存在且尚未初始化时顺带初始化。 */
  async load(context?: object): Promise<ScheduleSettings> {
    if (context !== undefined && this.prefs === null) {
      await this.init(context);
    }
    const prefs = this.requirePrefs();
    const deviceId = readString(await prefs.get(KEY_DEVICE_ID, DEFAULT_DEVICE_ID), DEFAULT_DEVICE_ID);
    const repoUrl = readString(await prefs.get(KEY_REPO_URL, ''), '');
    const token = readString(await prefs.get(KEY_TOKEN, ''), '');
    const aiKey = readString(await prefs.get(KEY_AI_KEY, ''), '');
    // 迁移：旧版本只存了 aiKey。providerId 为空即旧数据 → findProvider 回退默认源 deepseek，
    // 模型为空 → deepseek-chat，地址 → 该源预设地址（三个字段一起补齐，不留半套配置）。
    // 另一条迁移：已下线的本地源（用户升级前选的）归一为「自定义」，原 baseURL / 模型原样保留，
    // 不报错、不丢配置——「自定义」本来就允许手填 http:// 地址。
    const aiProviderIdRaw = readString(await prefs.get(KEY_AI_PROVIDER_ID, ''), '');
    const aiModel = readString(await prefs.get(KEY_AI_MODEL, DEFAULT_AI_MODEL), DEFAULT_AI_MODEL);
    const aiBaseURLRaw = readString(await prefs.get(KEY_AI_BASE_URL, ''), '');
    // B2 参数：旧数据没有这四个键 → 逐项回落默认（0.7 / 1024 / 30000 / 1），不留 NaN
    const rawOptions: AiOptions = {
      temperature: readNumber(await prefs.get(KEY_AI_TEMPERATURE, AI_DEFAULT_TEMPERATURE), AI_DEFAULT_TEMPERATURE),
      maxTokens: readNumber(await prefs.get(KEY_AI_MAX_TOKENS, AI_DEFAULT_MAX_TOKENS), AI_DEFAULT_MAX_TOKENS),
      timeoutMs: readNumber(await prefs.get(KEY_AI_TIMEOUT_MS, AI_TIMEOUT_MS), AI_TIMEOUT_MS),
      retries: readNumber(await prefs.get(KEY_AI_RETRIES, AI_DEFAULT_RETRIES), AI_DEFAULT_RETRIES)
    };
    const aiOptions: AiOptions = normalizeAiOptions(rawOptions);
    // B3 备用源：空 providerId = 不启用；model/baseURL/key 只在启用时才有意义
    const aiFallbackProviderIdRaw = readString(await prefs.get(KEY_AI_FALLBACK_PROVIDER_ID, ''), '');
    const aiFallbackProviderId: string =
      normalizeFallbackProviderId(migrateLegacyProviderId(aiFallbackProviderIdRaw));
    const aiFallbackModelRaw = readString(await prefs.get(KEY_AI_FALLBACK_MODEL, ''), '');
    const aiFallbackBaseURLRaw = readString(await prefs.get(KEY_AI_FALLBACK_BASE_URL, ''), '');
    const aiFallbackKeyRaw = readString(await prefs.get(KEY_AI_FALLBACK_KEY, ''), '');
    const author = readString(await prefs.get(KEY_AUTHOR, ''), '');
    const gitPlatform = readString(await prefs.get(KEY_GIT_PLATFORM, PLATFORM_GITHUB), PLATFORM_GITHUB);
    // 向后兼容：旧版本没有这个键 → 读成空串（Gitee 场景由 assertHttpsUsername 提示补填）
    const gitUsername = readString(await prefs.get(KEY_GIT_USERNAME, ''), '');
    const authMode = readString(await prefs.get(KEY_AUTH_MODE, AUTH_HTTPS), AUTH_HTTPS);
    // 旧数据没有这个键 → false（手指 + 笔都能写，与升级前行为一致）
    const penOnlyInput = readBoolean(await prefs.get(KEY_PEN_ONLY_INPUT, false), false);
    const lastSyncAt = readString(await prefs.get(KEY_LAST_SYNC_AT, ''), '');
    const lastSyncError = readString(await prefs.get(KEY_LAST_SYNC_ERROR, ''), '');
    const lastSyncAction = readString(await prefs.get(KEY_LAST_SYNC_ACTION, ''), '');
    const aiProviderId: string = findProvider(migrateLegacyProviderId(aiProviderIdRaw)).id;
    // 默认源沿用旧默认值 deepseek-chat（迁移）；其它源的空模型由 resolveModel 回落到该源默认模型
    const aiModelForSource: string = aiProviderId === DEFAULT_PROVIDER_ID ? normalizeAiModel(aiModel) : aiModel;
    const settings: ScheduleSettings = {
      deviceId: normalizeDeviceId(deviceId),
      repoUrl: repoUrl,
      token: token,
      aiKey: aiKey,
      aiProviderId: aiProviderId,
      aiModel: resolveAiModel(aiProviderId, aiModelForSource),
      aiBaseURL: aiBaseURLFor(aiProviderId, aiBaseURLRaw),
      aiTemperature: aiOptions.temperature,
      aiMaxTokens: aiOptions.maxTokens,
      aiTimeoutMs: aiOptions.timeoutMs,
      aiRetries: aiOptions.retries,
      aiFallbackProviderId: aiFallbackProviderId,
      aiFallbackModel: aiFallbackProviderId.length > 0 ? resolveAiModel(aiFallbackProviderId, aiFallbackModelRaw) : '',
      aiFallbackBaseURL: aiFallbackBaseURLFor(aiFallbackProviderId, aiFallbackBaseURLRaw),
      aiFallbackKey: aiFallbackProviderId.length > 0 ? aiFallbackKeyRaw.trim() : '',
      author: author,
      gitPlatform: normalizePlatform(gitPlatform),
      gitUsername: gitUsername.trim(),
      authMode: normalizeAuthMode(authMode),
      penOnlyInput: penOnlyInput,
      lastSyncAt: lastSyncAt,
      lastSyncError: lastSyncError,
      lastSyncAction: normalizeSyncAction(lastSyncAction)
    };
    this.cache = settings;
    return settings;
  }

  /** 最近一次读取/写入的缓存（未加载过返回 null）。 */
  cached(): ScheduleSettings | null {
    return this.cache;
  }

  /** 缓存里的模型名（未加载过或为空时返回空串），供 services/deepseek 兜底取模型。 */
  cachedAiModel(): string {
    if (this.cache === null) {
      return '';
    }
    return this.cache.aiModel.trim();
  }

  /** 缓存里的 AI 源 id（未加载过返回空串），供 services/deepseek 兜底选源。 */
  cachedProviderId(): string {
    if (this.cache === null) {
      return '';
    }
    return this.cache.aiProviderId.trim();
  }

  /** 缓存里的接口基地址（未加载过返回空串），供 services/deepseek 兜底取地址。 */
  cachedBaseURL(): string {
    if (this.cache === null) {
      return '';
    }
    return this.cache.aiBaseURL.trim();
  }

  /** 缓存里的采样/超时/重试参数（未加载过返回默认值），供 services/deepseek 直接消费。 */
  cachedAiOptions(): AiOptions {
    if (this.cache === null) {
      return defaultAiOptions();
    }
    const raw: AiOptions = {
      temperature: this.cache.aiTemperature,
      maxTokens: this.cache.aiMaxTokens,
      timeoutMs: this.cache.aiTimeoutMs,
      retries: this.cache.aiRetries
    };
    return normalizeAiOptions(raw);
  }

  /**
   * 缓存里的备用源配置（未加载/未启用时 `configured=false`）。
   *
   * 返回副本而不是缓存对象：服务层拿去做一次请求，不需要也不应该改到设置缓存。
   */
  cachedAiFallback(): AiFallbackSettings {
    if (this.cache === null) {
      const empty: AiFallbackSettings = {
        configured: false,
        providerId: '',
        model: '',
        baseURL: '',
        apiKey: ''
      };
      return empty;
    }
    const providerId: string = normalizeFallbackProviderId(this.cache.aiFallbackProviderId);
    const settings: AiFallbackSettings = {
      configured: providerId.length > 0,
      providerId: providerId,
      model: this.cache.aiFallbackModel.trim(),
      baseURL: this.cache.aiFallbackBaseURL.trim(),
      apiKey: this.cache.aiFallbackKey.trim()
    };
    return settings;
  }

  /** 部分更新并立即 flush 到磁盘，返回更新后的完整设置。 */
  async save(patch: SettingsPatch, context?: object): Promise<ScheduleSettings> {
    if (context !== undefined && this.prefs === null) {
      await this.init(context);
    }
    const prefs = this.requirePrefs();
    const current = await this.load();
    const nextProviderId: string =
      patch.aiProviderId === undefined ? current.aiProviderId : findProvider(patch.aiProviderId).id;
    // 模型名允许手输（预设列表只是建议），因此只有「换源且没手填模型」时才重置成新源默认，
    // 否则旧源的模型名会跟着带过去（例：deepseek-chat 落到 codex 上必 404）。
    const requestedModel: string = patch.aiModel === undefined ? '' : patch.aiModel;
    const nextModel: string =
      requestedModel.length > 0
        ? resolveAiModel(nextProviderId, requestedModel)
        : nextProviderId === current.aiProviderId
          ? resolveAiModel(nextProviderId, current.aiModel)
          : defaultModelOf(nextProviderId);
    // B2 参数：只传了部分字段时其余沿用当前值，再整体夹到合法范围
    const rawOptions: AiOptions = {
      temperature: patch.aiTemperature === undefined ? current.aiTemperature : patch.aiTemperature,
      maxTokens: patch.aiMaxTokens === undefined ? current.aiMaxTokens : patch.aiMaxTokens,
      timeoutMs: patch.aiTimeoutMs === undefined ? current.aiTimeoutMs : patch.aiTimeoutMs,
      retries: patch.aiRetries === undefined ? current.aiRetries : patch.aiRetries
    };
    const nextOptions: AiOptions = normalizeAiOptions(rawOptions);
    // B3 备用源：清空 providerId 即关闭（同时清掉 model/baseURL/key，避免残留旧凭据）；
    // 只改 model/baseURL/key 而没给 providerId 时沿用当前备用源。
    const requestedFallbackProviderId: string =
      patch.aiFallbackProviderId === undefined
        ? current.aiFallbackProviderId
        : normalizeFallbackProviderId(patch.aiFallbackProviderId);
    const fallbackModelRaw: string =
      patch.aiFallbackModel === undefined ? current.aiFallbackModel : patch.aiFallbackModel;
    const nextFallbackModel: string =
      requestedFallbackProviderId.length > 0
        ? resolveAiModel(requestedFallbackProviderId, fallbackModelRaw)
        : '';
    const next: ScheduleSettings = {
      deviceId: patch.deviceId === undefined ? current.deviceId : normalizeDeviceId(patch.deviceId),
      repoUrl: patch.repoUrl === undefined ? current.repoUrl : patch.repoUrl.trim(),
      token: patch.token === undefined ? current.token : patch.token.trim(),
      aiKey: patch.aiKey === undefined ? current.aiKey : patch.aiKey.trim(),
      aiProviderId: nextProviderId,
      aiModel: nextModel,
      aiBaseURL: aiBaseURLFor(nextProviderId, patch.aiBaseURL === undefined ? current.aiBaseURL : patch.aiBaseURL),
      aiTemperature: nextOptions.temperature,
      aiMaxTokens: nextOptions.maxTokens,
      aiTimeoutMs: nextOptions.timeoutMs,
      aiRetries: nextOptions.retries,
      aiFallbackProviderId: requestedFallbackProviderId,
      aiFallbackModel: nextFallbackModel,
      aiFallbackBaseURL:
        requestedFallbackProviderId.length > 0
          ? aiFallbackBaseURLFor(
              requestedFallbackProviderId,
              patch.aiFallbackBaseURL === undefined ? current.aiFallbackBaseURL : patch.aiFallbackBaseURL
            )
          : '',
      aiFallbackKey:
        requestedFallbackProviderId.length > 0
          ? (patch.aiFallbackKey === undefined ? current.aiFallbackKey : patch.aiFallbackKey).trim()
          : '',
      author: patch.author === undefined ? current.author : patch.author.trim(),
      gitPlatform: patch.gitPlatform === undefined ? current.gitPlatform : normalizePlatform(patch.gitPlatform),
      gitUsername: patch.gitUsername === undefined ? current.gitUsername : patch.gitUsername.trim(),
      authMode: patch.authMode === undefined ? current.authMode : normalizeAuthMode(patch.authMode),
      penOnlyInput: patch.penOnlyInput === undefined ? current.penOnlyInput : patch.penOnlyInput === true,
      lastSyncAt: current.lastSyncAt,
      lastSyncError: current.lastSyncError,
      lastSyncAction: current.lastSyncAction
    };
    await prefs.put(KEY_DEVICE_ID, next.deviceId);
    await prefs.put(KEY_REPO_URL, next.repoUrl);
    await prefs.put(KEY_TOKEN, next.token);
    await prefs.put(KEY_AI_KEY, next.aiKey);
    await prefs.put(KEY_AI_PROVIDER_ID, next.aiProviderId);
    await prefs.put(KEY_AI_MODEL, next.aiModel);
    await prefs.put(KEY_AI_BASE_URL, next.aiBaseURL);
    await prefs.put(KEY_AI_TEMPERATURE, next.aiTemperature);
    await prefs.put(KEY_AI_MAX_TOKENS, next.aiMaxTokens);
    await prefs.put(KEY_AI_TIMEOUT_MS, next.aiTimeoutMs);
    await prefs.put(KEY_AI_RETRIES, next.aiRetries);
    await prefs.put(KEY_AI_FALLBACK_PROVIDER_ID, next.aiFallbackProviderId);
    await prefs.put(KEY_AI_FALLBACK_MODEL, next.aiFallbackModel);
    await prefs.put(KEY_AI_FALLBACK_BASE_URL, next.aiFallbackBaseURL);
    await prefs.put(KEY_AI_FALLBACK_KEY, next.aiFallbackKey);
    await prefs.put(KEY_AUTHOR, next.author);
    await prefs.put(KEY_GIT_PLATFORM, next.gitPlatform);
    await prefs.put(KEY_GIT_USERNAME, next.gitUsername);
    await prefs.put(KEY_AUTH_MODE, next.authMode);
    await prefs.put(KEY_PEN_ONLY_INPUT, next.penOnlyInput);
    await prefs.put(KEY_GIT_USERNAME, next.gitUsername);
    await prefs.put(KEY_LAST_SYNC_AT, next.lastSyncAt);
    await prefs.put(KEY_LAST_SYNC_ERROR, next.lastSyncError);
    await prefs.put(KEY_LAST_SYNC_ACTION, next.lastSyncAction);
    await prefs.flush();
    this.cache = next;
    return next;
  }

  /**
   * 只更新「上次同步状态」三项（不动 token / 仓库地址等设置）。
   *
   * 设置页每次同步结束后调用：成功清空错误、失败写入分级后的中文文案。
   * 单独一条写入路径可以避免「同步状态回写」把用户正在编辑的表单值顺带覆盖掉。
   */
  async saveSyncState(patch: SyncStatePatch, context?: object): Promise<ScheduleSettings> {
    if (context !== undefined && this.prefs === null) {
      await this.init(context);
    }
    const prefs = this.requirePrefs();
    const current = await this.load();
    const next: ScheduleSettings = {
      deviceId: current.deviceId,
      repoUrl: current.repoUrl,
      token: current.token,
      aiKey: current.aiKey,
      aiProviderId: current.aiProviderId,
      aiModel: current.aiModel,
      aiBaseURL: current.aiBaseURL,
      aiTemperature: current.aiTemperature,
      aiMaxTokens: current.aiMaxTokens,
      aiTimeoutMs: current.aiTimeoutMs,
      aiRetries: current.aiRetries,
      aiFallbackProviderId: current.aiFallbackProviderId,
      aiFallbackModel: current.aiFallbackModel,
      aiFallbackBaseURL: current.aiFallbackBaseURL,
      aiFallbackKey: current.aiFallbackKey,
      author: current.author,
      gitPlatform: current.gitPlatform,
      gitUsername: current.gitUsername,
      authMode: current.authMode,
      penOnlyInput: current.penOnlyInput,
      lastSyncAt: patch.lastSyncAt === undefined ? current.lastSyncAt : patch.lastSyncAt,
      lastSyncError: patch.lastSyncError === undefined ? current.lastSyncError : patch.lastSyncError,
      lastSyncAction:
        patch.lastSyncAction === undefined ? current.lastSyncAction : normalizeSyncAction(patch.lastSyncAction)
    };
    await prefs.put(KEY_GIT_USERNAME, next.gitUsername);
    await prefs.put(KEY_LAST_SYNC_AT, next.lastSyncAt);
    await prefs.put(KEY_LAST_SYNC_ERROR, next.lastSyncError);
    await prefs.put(KEY_LAST_SYNC_ACTION, next.lastSyncAction);
    await prefs.flush();
    this.cache = next;
    return next;
  }

  private requirePrefs(): preferences.Preferences {
    if (this.prefs === null) {
      throw new Error('设置存储尚未初始化：请先调用 settingsStore.init(context)');
    }
    return this.prefs;
  }
}

/** 全局单例（页面与服务共用同一份 preferences 连接）。 */
export const settingsStore: SettingsStore = new SettingsStore();
