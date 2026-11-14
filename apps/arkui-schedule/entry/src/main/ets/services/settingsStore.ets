/**
 * 本机设置存储（设备标识 / 仓库地址 / token / AI key / 作者名）。
 *
 * 落盘方式：`@kit.ArkData` 的 `preferences`（值不外泄，不进 Git 同步载荷）。
 * 设备标识同时决定日程目录 `git-repo/devices/<deviceId>/`，因此必须匹配
 * `^[a-z0-9][a-z0-9-]{0,31}$`（`docs/DATA-CONTRACT.md` §1）。
 *
 * 契约：`docs/CONTRACT.md` §3.3、BRIEF §3.5（设置页）。
 */
import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';

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
  /** 作者名，写入日程记录的 author 字段。 */
  author: string;
}

/** 部分更新（未出现的字段保持原值）。 */
export interface SettingsPatch {
  deviceId?: string;
  repoUrl?: string;
  token?: string;
  aiKey?: string;
  author?: string;
}

const PREFERENCES_NAME: string = 'schedule_settings';
const KEY_DEVICE_ID: string = 'deviceId';
const KEY_REPO_URL: string = 'repoUrl';
const KEY_TOKEN: string = 'token';
const KEY_AI_KEY: string = 'aiKey';
const KEY_AUTHOR: string = 'author';

/** 规范化设备标识：非法值回退默认，避免写出非法目录名。 */
export function normalizeDeviceId(value: string): string {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return DEVICE_ID_PATTERN.test(text) ? text : DEFAULT_DEVICE_ID;
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
    const author = readString(await prefs.get(KEY_AUTHOR, ''), '');
    const settings: ScheduleSettings = {
      deviceId: normalizeDeviceId(deviceId),
      repoUrl: repoUrl,
      token: token,
      aiKey: aiKey,
      author: author
    };
    this.cache = settings;
    return settings;
  }

  /** 最近一次读取/写入的缓存（未加载过返回 null）。 */
  cached(): ScheduleSettings | null {
    return this.cache;
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
      author: patch.author === undefined ? current.author : patch.author.trim()
    };
    await prefs.put(KEY_DEVICE_ID, next.deviceId);
    await prefs.put(KEY_REPO_URL, next.repoUrl);
    await prefs.put(KEY_TOKEN, next.token);
    await prefs.put(KEY_AI_KEY, next.aiKey);
    await prefs.put(KEY_AUTHOR, next.author);
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
