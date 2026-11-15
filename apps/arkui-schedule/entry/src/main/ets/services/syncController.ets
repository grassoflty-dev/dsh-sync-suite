/**
 * syncController — App 级 Git 同步入口（启动自动 pull / 下拉刷新共用一份实例）。
 *
 * 为什么需要它：`GitSyncService` 构造时要 `webview.WebviewController`，而控制器只能由页面里的
 * `Web` 组件交出。`GitBridgeHost` 负责提供这个隐藏的 `Web`，本模块负责「拿到控制器之后」的
 * 一切：建服务、按设置填写配置、执行 pull，并做 60s 节流避免回前台反复拉。
 *
 * 约定：
 * - **不做定时器 / 不用 workScheduler / 不跑后台任务**：只在显式调用点（启动、回前台、下拉）跑；
 * - 失败只返回结果给调用方（页面层 toast + `[sync]` 日志），这里**不 toast、不打日志**；
 * - 未配置仓库（repoUrl 为空）→ 直接返回「跳过」，不算错误。
 */
import { webview } from '@kit.ArkWeb';
import { GitSyncService } from './GitSyncService';
import type { GitSyncConfig, GitSyncResult } from './GitSyncService';
import { settingsStore } from './settingsStore';
import type { ScheduleSettings } from './settingsStore';

/** 两次自动 pull 之间的最小间隔（回前台节流）：60 秒。 */
const STARTUP_THROTTLE_MS: number = 60 * 1000;

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
  private lastPullAt: number = 0;
  private starting: boolean = false;

  /** 桥是否可用（隐藏 Web 已加载 + 服务已配置）。 */
  isReady(): boolean {
    return this.service !== null;
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
      this.service.configure(this.toConfig(settings));
    } catch {
      // 配置失败（设置未初始化）：保持 null，下次调用再试
      this.service = null;
    } finally {
      this.starting = false;
    }
  }

  /** 设置 → 服务配置（字段全部显式映射，避免 ArkTS 对象字面量推断问题）。 */
  private toConfig(settings: ScheduleSettings): GitSyncConfig {
    // 注意：`ScheduleSettings` 没有「分支/作者邮箱」字段 → 分支固定 main，
    // 作者邮箱用 GitHub noreply 形式占位（只影响 commit 元数据，不影响同步）。
    const authorName: string = settings.author.length > 0 ? settings.author : 'dsh-schedule';
    const config: GitSyncConfig = {
      repoUrl: settings.repoUrl,
      branch: 'main',
      deviceId: settings.deviceId,
      token: settings.token,
      authorName: authorName,
      authorEmail: `${authorName}@users.noreply.github.com`
    };
    return config;
  }

  /**
   * 启动 / 回前台自动 pull：**静默**、失败只返回结果、60s 节流。
   * 下拉刷新请用 `pullNow()`（不节流）。
   */
  async pullOnStartup(): Promise<SyncOutcome> {
    const now: number = Date.now();
    if (this.lastPullAt > 0 && now - this.lastPullAt < STARTUP_THROTTLE_MS) {
      return { ok: true, message: '刚刚已拉取，跳过', elapsedMs: 0, skipped: true };
    }
    return this.pullNow();
  }

  /** 立即 pull（下拉刷新 / 启动强拉），不节流。 */
  async pullNow(): Promise<SyncOutcome> {
    const started: number = Date.now();
    if (this.service === null) {
      return { ok: false, message: '同步桥尚未就绪', elapsedMs: 0, skipped: false };
    }
    let result: GitSyncResult;
    try {
      result = await this.service.pullOnStartup();
    } catch (error) {
      return { ok: false, message: '自动拉取失败', elapsedMs: Date.now() - started, skipped: false };
    }
    this.lastPullAt = Date.now();
    return {
      ok: result.ok,
      message: result.message,
      elapsedMs: this.lastPullAt - started,
      skipped: false
    };
  }
}

/** App 级单例。 */
export const syncController: SyncController = new SyncController();
