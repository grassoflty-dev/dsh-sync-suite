/**
 * syncController — App 级 Git 同步入口（启动自动 pull / 下拉刷新共用一份实例）。
 *
 * 为什么需要它：`GitSyncService` 构造时要 `webview.WebviewController`，而控制器只能由页面里的
 * `Web` 组件交出。`GitBridgeHost` 负责提供这个隐藏的 `Web`，本模块负责「拿到控制器之后」的
 * 一切：建服务、按设置填写配置、执行 pull，并做 60s 节流避免回前台反复拉。
 *
 * 另外这里放 **Git 扩展设置**（`gitExtrasStore`）：分支名 + 平台 + 「平台是否被用户手动改过」。
 * 为什么不进 `settingsStore`：那边只有 `gitPlatform`（且归一成 github/gitee），放不下
 * gitlab/custom 与分支名；扩展项单独一个 preferences 文件，键名带前缀，互不覆盖。
 *
 * 约定：
 * - **不做定时器 / 不用 workScheduler / 不跑后台任务**：只在显式调用点（启动、回前台、下拉）跑；
 * - **同一时刻只允许一个 pull 在飞**（`PullGate`，复用 `model/syncGuard.ts` 的闸）：启动 pull 还没
 *   回来时，回前台/下拉再调 `pullNow()` 一律返回 `skipped: true`，不会双发、不会互相覆盖结果；
 * - 失败只返回结果给调用方（页面层 toast + `[sync]` 日志），这里**不 toast、不打日志**；
 * - 未配置仓库（repoUrl 为空）→ 直接返回「跳过」，不算错误。
 */
import { webview } from '@kit.ArkWeb';
import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';
import { GitSyncService } from './GitSyncService';
import type { GitSyncConfig, GitSyncResult } from './GitSyncService';
import { settingsStore } from './settingsStore';
import type { ScheduleSettings } from './settingsStore';
import { BRIDGE_NOT_READY_MESSAGE, PullGate } from '../model/syncGuard';
import type { PullGateDecision } from '../model/syncGuard';
import { DEFAULT_BRANCH, normalizeBranchName } from '../model/syncError';
import { normalizeGitPlatform } from '../model/gitAuth';

/** 两次自动 pull 之间的最小间隔（回前台节流）：60 秒。 */
const STARTUP_THROTTLE_MS: number = 60 * 1000;

// ---------------------------------------------------------------- Git 扩展设置

/** Git 扩展设置（分支 / 平台 / 平台是否被手动改过）。 */
export interface GitSyncExtras {
  /** 分支名（归一后；空串表示「沿用默认」）。 */
  branch: string;
  /** 平台：github | gitee | gitlab | custom（空串表示「沿用 settingsStore.gitPlatform」）。 */
  platform: string;
  /** 用户是否手动点过平台 chip（点过就以用户为准，不再按地址推断）。 */
  platformTouched: boolean;
}

/** 扩展设置的部分更新。 */
export interface GitExtrasPatch {
  branch?: string;
  platform?: string;
  platformTouched?: boolean;
}

const EXTRAS_PREFS_NAME: string = 'git_sync_extras';
const KEY_BRANCH: string = 'branch';
const KEY_PLATFORM: string = 'platform';
const KEY_PLATFORM_TOUCHED: string = 'platformTouched';

function readString(value: preferences.ValueType, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/** 扩展设置的默认值（未写盘/读失败时用它，保证同步仍能用 main + 默认平台）。 */
function defaultExtras(): GitSyncExtras {
  const extras: GitSyncExtras = { branch: DEFAULT_BRANCH, platform: '', platformTouched: false };
  return extras;
}

/**
 * Git 扩展设置的持久化（`@kit.ArkData` 的 preferences，单独一个文件 `git_sync_extras`）。
 *
 * 与 `settingsStore` 一致：不落任何凭据（这里只有分支名与平台枚举），不进同步载荷。
 */
export class GitExtrasStore {
  private prefs: preferences.Preferences | null = null;
  private cache: GitSyncExtras | null = null;

  /** 初始化（幂等）：拿不到 context 时由 `load()` 自己 `getContext()`。 */
  async init(context: object): Promise<void> {
    if (this.prefs !== null) {
      return;
    }
    const abilityContext: common.UIAbilityContext = context as common.UIAbilityContext;
    this.prefs = await preferences.getPreferences(abilityContext, { name: EXTRAS_PREFS_NAME });
  }

  /** 读取扩展设置；读失败返回默认值（**永不抛**：调用方是同步主流程）。 */
  async load(context?: object): Promise<GitSyncExtras> {
    try {
      if (this.prefs === null) {
        const abilityContext: common.UIAbilityContext =
          context === undefined ? (getContext() as common.UIAbilityContext) : (context as common.UIAbilityContext);
        await this.init(abilityContext);
      }
      const prefs: preferences.Preferences = this.prefs as preferences.Preferences;
      const branch: string = normalizeBranchName(
        readString(await prefs.get(KEY_BRANCH, DEFAULT_BRANCH), DEFAULT_BRANCH)
      );
      const platformRaw: string = readString(await prefs.get(KEY_PLATFORM, ''), '').trim();
      const touchedRaw: preferences.ValueType = await prefs.get(KEY_PLATFORM_TOUCHED, false);
      const extras: GitSyncExtras = {
        branch: branch.length > 0 ? branch : DEFAULT_BRANCH,
        platform: platformRaw.length > 0 ? normalizeGitPlatform(platformRaw) : '',
        platformTouched: touchedRaw === true
      };
      this.cache = extras;
      return extras;
    } catch (error) {
      const fallback: GitSyncExtras = this.cache === null ? defaultExtras() : this.cache;
      return fallback;
    }
  }

  /** 最近一次读取/写入的缓存（未加载过返回 null）。 */
  cached(): GitSyncExtras | null {
    return this.cache;
  }

  /** 部分更新并 flush；失败时返回当前值（**永不抛**）。 */
  async save(patch: GitExtrasPatch, context?: object): Promise<GitSyncExtras> {
    const current: GitSyncExtras = this.cache === null ? await this.load(context) : this.cache;
    let branch: string = current.branch;
    if (patch.branch !== undefined) {
      const normalized: string = normalizeBranchName(patch.branch);
      branch = normalized.length > 0 ? normalized : DEFAULT_BRANCH;
    }
    let platform: string = current.platform;
    if (patch.platform !== undefined) {
      platform = patch.platform.trim().length > 0 ? normalizeGitPlatform(patch.platform) : '';
    }
    const next: GitSyncExtras = {
      branch: branch,
      platform: platform,
      platformTouched: patch.platformTouched === undefined ? current.platformTouched : patch.platformTouched
    };
    this.cache = next;
    try {
      const prefs: preferences.Preferences = this.prefs as preferences.Preferences;
      await prefs.put(KEY_BRANCH, next.branch);
      await prefs.put(KEY_PLATFORM, next.platform);
      await prefs.put(KEY_PLATFORM_TOUCHED, next.platformTouched);
      await prefs.flush();
    } catch (error) {
      // 写盘失败不阻断同步：内存缓存已更新，本次会话内仍然生效
    }
    return next;
  }
}

/** App 级单例（设置页与 syncController 共用一份）。 */
export const gitExtrasStore: GitExtrasStore = new GitExtrasStore();

/** pull 结果（连耗时一起给调用方打日志用）。 */
export interface SyncOutcome {
  ok: boolean;
  /** 中文结果/原因，可直接 toast。 */
  message: string;
  /** 本次耗时（毫秒）。 */
  elapsedMs: number;
  /** 是否被节流跳过（没真正发起拉取）。 */
  skipped: boolean;
}

class SyncController {
  private service: GitSyncService | null = null;
  /** pull 的在飞闸 + 上次完成时间（`model/syncGuard.ts` 的 `PullGate`，不另造状态机）。 */
  private pullGate: PullGate = new PullGate();
  private starting: boolean = false;
  /** 桥加载失败的原因（`GitBridgeHost.onFail` 写入）。 */
  private bridgeReason: string = '';

  /** 桥是否可用（隐藏 Web 已加载 + 服务已配置）。 */
  isReady(): boolean {
    return this.service !== null && this.service.isBridgeReady();
  }

  /** 桥不可用的原因（`isReady()` 为 true 时为空串）：页面用它做说明行/禁用理由。 */
  notReadyReason(): string {
    if (this.service === null) {
      return BRIDGE_NOT_READY_MESSAGE;
    }
    const reason: string = this.service.bridgeFailure();
    return reason.length > 0 ? reason : BRIDGE_NOT_READY_MESSAGE;
  }

  /** 桥加载失败（`GitBridgeHost.onFail` 调）：置未就绪 + 记原因，**不抛**。 */
  markBridgeFailed(reason: string): void {
    this.bridgeReason = reason;
  }

  /** 桥失败原因（空串表示没失败过）。 */
  bridgeFailure(): string {
    return this.bridgeReason;
  }

  /**
   * 绑定控制器并配置好服务（幂等：重复调用只更新配置）。
   * `GitBridgeHost.onReady` 里调这个。
   */
  async ensureStarted(controller: webview.WebviewController): Promise<void> {
    if (this.starting) {
      return;
    }
    this.starting = true;
    try {
      if (this.service === null) {
        this.service = new GitSyncService(controller);
        this.service.registerProxy();
      }
      const settings: ScheduleSettings = await settingsStore.load();
      // 扩展设置（分支 / 平台）读失败也要能同步：`load()` 内部已退回默认值
      await gitExtrasStore.load();
      this.service.configure(this.toConfig(settings));
    } catch {
      // 配置失败（设置未初始化）：保持 null，下次调用再试
      this.service = null;
    } finally {
      this.starting = false;
    }
  }

  /** 设置 + 扩展设置 → 服务配置（字段全部显式映射，避免 ArkTS 对象字面量推断问题）。 */
  private toConfig(settings: ScheduleSettings): GitSyncConfig {
    // 注意：`ScheduleSettings` 没有「分支」字段 → 分支来自扩展设置（gitExtrasStore），默认 main；
    // 作者邮箱用 GitHub noreply 形式占位（只影响 commit 元数据，不影响同步）。
    const authorName: string = settings.author.length > 0 ? settings.author : 'dsh-schedule';
    const extras: GitSyncExtras | null = gitExtrasStore.cached();
    const branch: string = extras !== null && extras.branch.length > 0 ? extras.branch : DEFAULT_BRANCH;
    // 平台：扩展设置优先（能表达 gitlab/custom），否则沿用 settingsStore 的 github/gitee
    const platform: string =
      extras !== null && extras.platform.length > 0 ? extras.platform : settings.gitPlatform;
    const config: GitSyncConfig = {
      repoUrl: settings.repoUrl,
      branch: branch,
      deviceId: settings.deviceId,
      token: settings.token,
      authorName: authorName,
      authorEmail: `${authorName}@users.noreply.github.com`,
      // P0：Gitee 的 HTTPS 用户名必须=登录名；这里只透传，兜底规则在 model/gitAuth.ts
      platform: platform,
      gitUsername: settings.gitUsername,
      // A1：SSH 在本版本不可用，服务层会在发请求前拦住（见 describeAuthModeBlocker）
      authMode: settings.authMode
    };
    return config;
  }

  /**
   * 启动 / 回前台自动 pull：**静默**、失败只返回结果、60s 节流。
   * 下拉刷新请用 `pullNow()`（不节流，但在飞时同样跳过）。
   */
  async pullOnStartup(): Promise<SyncOutcome> {
    const now: number = Date.now();
    if (this.pullGate.throttled(STARTUP_THROTTLE_MS, now)) {
      return { ok: true, message: '刚刚已拉取，跳过', elapsedMs: 0, skipped: true };
    }
    return this.pullNow();
  }

  /**
   * 立即 pull（下拉刷新 / 启动强拉），不节流。**永不抛异常**。
   *
   * 重入：入口先抢闸（`PullGate.enter`，同步完成、在第一个 `await` 之前）——已有 pull 在飞时，
   * 本次直接返回 `skipped: true`（**跳过不是失败**，调用方靠 `skipped` 区分），且**不推进**
   * `lastPullAt`（否则「忙跳过」会把 60s 节流续上，等于一次没发生的拉取也能压住回前台拉取）。
   * 闸在 `finally` 里放，异常/超时路径也会清掉，下一次调用能正常开始。
   */
  async pullNow(): Promise<SyncOutcome> {
    const started: number = Date.now();
    // 判定必须在第一个 await 之前：JS 单线程下只有 await 会让出执行权，
    // 同步抢闸后第二个入口（回前台 / 下拉刷新）才必然看得到「已在飞」。
    const gate: PullGateDecision = this.pullGate.enter(started);
    if (!gate.proceed) {
      return { ok: true, message: gate.message, elapsedMs: 0, skipped: true };
    }
    try {
      const service: GitSyncService | null = this.service;
      if (service === null || !service.isBridgeReady()) {
        // 闪退回归：桥没好就绝不下探，直接返回可读错误给调用方展示。
        // 这里同样不推进 lastPullAt：没真正拉取，就不该压住 60s 节流。
        const reason: string = this.notReadyReason();
        return { ok: false, message: reason, elapsedMs: 0, skipped: true };
      }
      // 分支/平台可能刚在设置页改过：拉取前按最新设置重配一次（只读 preferences，不联网）
      try {
        const settings: ScheduleSettings = await settingsStore.load();
        await gitExtrasStore.load();
        service.configure(this.toConfig(settings));
      } catch {
        // 读设置失败就沿用上一次的配置，不阻断这次拉取
      }
      let result: GitSyncResult;
      try {
        result = await service.pullOnStartup();
      } catch {
        return { ok: false, message: '自动拉取失败', elapsedMs: Date.now() - started, skipped: false };
      }
      const finished: number = Date.now();
      // 只有真正发出 pull 并拿到结果（成功或失败）才推进节流基准
      this.pullGate.markCompleted(finished);
      return {
        ok: result.ok,
        message: result.message,
        elapsedMs: finished - started,
        skipped: false
      };
    } finally {
      // 异常/超时/提前 return 都会走到这里：清掉在飞标志
      this.pullGate.leave();
    }
  }
}

/** App 级单例。 */
export const syncController: SyncController = new SyncController();
