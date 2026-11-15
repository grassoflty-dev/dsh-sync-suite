/**
 * 本机设置存储（设备标识 / 仓库地址 / token / AI key / 作者名 / 平台 / 认证方式 / AI 模型）。
 *
 * 落盘方式：`@kit.ArkData` 的 `preferences`（值不外泄，不进 Git 同步载荷）。
 * 设备标识同时决定日程目录 `git-repo/devices/<deviceId>/`，因此必须匹配
 * `^[a-z0-9][a-z0-9-]{0,31}$`（`docs/DATA-CONTRACT.md` §1）。
 *
 * 契约：`docs/CONTRACT.md` §3.3、BRIEF §3.5（设置页）。
 */
import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';
import { DEFAULT_AI_MODEL } from '../model/aiRequest';
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
  /** DeepSeek API key（仅存本机）。 */
  aiKey: string;
  /** DeepSeek 模型名，默认 `deepseek-chat`。 */
  aiModel: string;
  /** 作者名，写入日程记录的 author 字段。 */
  author: string;
  /** 托管平台：`github` | `gitee`（只影响提示文案与示例）。 */
  gitPlatform: string;
  /** 认证方式：`https` | `ssh`（只影响提示文案与 token 是否必填）。 */
  authMode: string;
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
  aiModel?: string;
  author?: string;
  gitPlatform?: string;
  authMode?: string;
}

const PREFERENCES_NAME: string = 'schedule_settings';
const KEY_DEVICE_ID: string = 'deviceId';
const KEY_REPO_URL: string = 'repoUrl';
const KEY_TOKEN: string = 'token';
const KEY_AI_KEY: string = 'aiKey';
const KEY_AI_MODEL: string = 'aiModel';
const KEY_AUTHOR: string = 'author';
const KEY_GIT_PLATFORM: string = 'gitPlatform';
const KEY_AUTH_MODE: string = 'authMode';
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

/** 读取 preferences 里的字符串值（非字符串按默认值处理）。 */
function readString(value: preferences.ValueType, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
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
    const aiModel = readString(await prefs.get(KEY_AI_MODEL, DEFAULT_AI_MODEL), DEFAULT_AI_MODEL);
    const author = readString(await prefs.get(KEY_AUTHOR, ''), '');
    const gitPlatform = readString(await prefs.get(KEY_GIT_PLATFORM, PLATFORM_GITHUB), PLATFORM_GITHUB);
    const authMode = readString(await prefs.get(KEY_AUTH_MODE, AUTH_HTTPS), AUTH_HTTPS);
    const lastSyncAt = readString(await prefs.get(KEY_LAST_SYNC_AT, ''), '');
    const lastSyncError = readString(await prefs.get(KEY_LAST_SYNC_ERROR, ''), '');
    const lastSyncAction = readString(await prefs.get(KEY_LAST_SYNC_ACTION, ''), '');
    const settings: ScheduleSettings = {
      deviceId: normalizeDeviceId(deviceId),
      repoUrl: repoUrl,
      token: token,
      aiKey: aiKey,
      aiModel: normalizeAiModel(aiModel),
      author: author,
      gitPlatform: normalizePlatform(gitPlatform),
      authMode: normalizeAuthMode(authMode),
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

  /** 部分更新并立即 flush 到磁盘，返回更新后的完整设置。 */
  async save(patch: SettingsPatch, context?: object): Promise<ScheduleSettings> {
    if (context !== undefined && this.prefs === null) {
      await this.init(context);
    }
    const prefs = this.requirePrefs();
    const current = await this.load();
    const next: ScheduleSettings = {
      deviceId: patch.deviceId === undefined ? current.deviceId : normalizeDeviceId(patch.deviceId),
      repoUrl: patch.repoUrl === undefined ? current.repoUrl : patch.repoUrl.trim(),
      token: patch.token === undefined ? current.token : patch.token.trim(),
      aiKey: patch.aiKey === undefined ? current.aiKey : patch.aiKey.trim(),
      aiModel: patch.aiModel === undefined ? current.aiModel : normalizeAiModel(patch.aiModel),
      author: patch.author === undefined ? current.author : patch.author.trim(),
      gitPlatform: patch.gitPlatform === undefined ? current.gitPlatform : normalizePlatform(patch.gitPlatform),
      authMode: patch.authMode === undefined ? current.authMode : normalizeAuthMode(patch.authMode),
      lastSyncAt: current.lastSyncAt,
      lastSyncError: current.lastSyncError,
      lastSyncAction: current.lastSyncAction
    };
    await prefs.put(KEY_DEVICE_ID, next.deviceId);
    await prefs.put(KEY_REPO_URL, next.repoUrl);
    await prefs.put(KEY_TOKEN, next.token);
    await prefs.put(KEY_AI_KEY, next.aiKey);
    await prefs.put(KEY_AI_MODEL, next.aiModel);
    await prefs.put(KEY_AUTHOR, next.author);
    await prefs.put(KEY_GIT_PLATFORM, next.gitPlatform);
    await prefs.put(KEY_AUTH_MODE, next.authMode);
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
      aiModel: current.aiModel,
      author: current.author,
      gitPlatform: current.gitPlatform,
      authMode: current.authMode,
      lastSyncAt: patch.lastSyncAt === undefined ? current.lastSyncAt : patch.lastSyncAt,
      lastSyncError: patch.lastSyncError === undefined ? current.lastSyncError : patch.lastSyncError,
      lastSyncAction:
        patch.lastSyncAction === undefined ? current.lastSyncAction : normalizeSyncAction(patch.lastSyncAction)
    };
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
