/**
 * 仓库可见性校验器（mod-repo-privacy-gate，app 侧薄适配器 + 门禁状态宿主）。
 *
 * 契约：
 * - 权威 provider API 校验，只有 `private: true` 放行；判定全在 `model/repoVisibility.ts`；
 * - 硬超时 ≤ 5 s（`connectTimeout` / `readTimeout`），异步 Promise I/O，绝不在 UI 线程同步等待；
 * - token 只进 Authorization header：不拼 URL、不打印、不回写设置；
 * - 推送路径带 60 s 去重 + sticky；保存 / 测试连接走 force 实时校验。
 */
import { http } from '@kit.NetworkKit';
import { settingsStore } from './settingsStore';
import type { ScheduleSettings } from './settingsStore';
import { REPO_VISIBILITY_OK, E_REPO_VISIBILITY_UNKNOWN, decideRepoVisibility } from '../model/repoVisibility';
import type { RepoVisibilityDecision } from '../model/repoVisibility';
import {
  REPO_VISIBILITY_TIMEOUT_MS,
  fetchRepoVisibility,
  repoTargetFromUrl
} from '../model/repoVisibilityClient';
import type { RepoVisibilityTarget, RepoVisibilityTransportResponse } from '../model/repoVisibilityClient';
import {
  applyRepoVisibilityDecision,
  cachedRepoVisibilityDecision,
  initialRepoVisibilityGate,
  shouldRunRepoVisibilityCheck
} from '../model/repoVisibilityGate';
import type { RepoVisibilityGateState } from '../model/repoVisibilityGate';

/** 推送前置结果：`allowed=false` 时 decision 是 typed 拒绝（码 + 逐字中文）。 */
export interface RepoPushGuardResult {
  allowed: boolean;
  decision: RepoVisibilityDecision;
}

class RepoVisibilityChecker {
  /** 进程内门禁状态：不落盘，重启后第一次推送重新实时查。 */
  private state: RepoVisibilityGateState = initialRepoVisibilityGate();

  /** 唯一网络出口：把 @kit.NetworkKit 的响应折成纯模型四元组；异常一律 status=0。 */
  private async transport(
    url: string,
    headers: Record<string, string>,
    timeoutMs: number
  ): Promise<RepoVisibilityTransportResponse> {
    const request = http.createHttp();
    try {
      const options: http.HttpRequestOptions = {
        method: http.RequestMethod.GET,
        header: headers,
        expectDataType: http.HttpDataType.STRING,
        connectTimeout: timeoutMs,
        readTimeout: timeoutMs
      };
      const response: http.HttpResponse = await request.request(url, options);
      const raw: Object = response.result as Object;
      const body: string = typeof raw === 'string' ? raw : '';
      const responseHeaders: Record<string, string> = response.header as Record<string, string>;
      let contentType: string = '';
      for (const key of Object.keys(responseHeaders)) {
        if (key.toLowerCase() === 'content-type') {
          contentType = responseHeaders[key];
          break;
        }
      }
      const facts: RepoVisibilityTransportResponse = {
        status: response.responseCode, contentType: contentType, body: body
      };
      return facts;
    } finally {
      try {
        request.destroy();
      } catch (error) {
        void error; // 未开始 / 已销毁：忽略
      }
    }
  }

  /** 保存 / 测试连接：强制实时校验（不复用 60 s 窗口），并同步门禁状态。 */
  async checkNow(target: RepoVisibilityTarget, token: string): Promise<RepoVisibilityDecision> {
    return await this.runCheck(target, token, true);
  }

  /** 推送前置：只按 60 s 窗口复用，任何非私有判定 sticky 阻断。 */
  async guardPush(): Promise<RepoPushGuardResult> {
    let settings: ScheduleSettings;
    try {
      settings = await settingsStore.load();
    } catch (error) {
      void error;
      // 读不到配置 ⇒ 无法确认私有 ⇒ 失败关闭（绝不假定私有）。
      const blocked: RepoVisibilityDecision = decideRepoVisibility({
        host: '', status: 0, contentType: '', body: ''
      });
      this.state = applyRepoVisibilityDecision(this.state, blocked, Date.now());
      return { allowed: false, decision: blocked };
    }
    const target: RepoVisibilityTarget | null = repoTargetFromUrl(settings.repoUrl);
    if (target === null) {
      // 没配置可用仓库地址时不会推（本地记录照常写）；这里不制造拒绝文案。
      return { allowed: true, decision: cachedRepoVisibilityDecision(this.state) };
    }
    const decision: RepoVisibilityDecision = await this.runCheck(target, settings.token, false);
    const result: RepoPushGuardResult = { allowed: decision.ok, decision: decision };
    return result;
  }

  /** 实际发一次校验（force / 窗口到期），或复用上次判定。 */
  private async runCheck(
    target: RepoVisibilityTarget,
    token: string,
    force: boolean
  ): Promise<RepoVisibilityDecision> {
    const now: number = Date.now();
    if (!shouldRunRepoVisibilityCheck(this.state, now, force)) {
      return cachedRepoVisibilityDecision(this.state);
    }
    const decision: RepoVisibilityDecision = await fetchRepoVisibility(
      target, token,
      (url: string, headers: Record<string, string>, timeoutMs: number): Promise<RepoVisibilityTransportResponse> =>
        this.transport(url, headers, timeoutMs)
    );
    this.state = applyRepoVisibilityDecision(this.state, decision, Date.now());
    return decision;
  }

  /** 最近一次拒绝时刻（epoch ms；0 = 无拒绝），供诊断读数，不进用户文案。 */
  lastBlockedAtMs(): number {
    return this.state.blockedAtMs;
  }

  /** 当前是否被挡（只读；状态文案的唯一来源仍是 syncStatusStore）。 */
  isBlocked(): boolean {
    return this.state.blocked;
  }

  /** 未配置仓库时的中性结果码（仅供调用方判等，不生成文案）。 */
  okCode(): string {
    return REPO_VISIBILITY_OK;
  }

  /** 未知码（失败关闭的兜底常量，测试与守卫可读）。 */
  unknownCode(): string {
    return E_REPO_VISIBILITY_UNKNOWN;
  }

  /** 超时上限（毫秒，≤ 5000），供源码守卫核对。 */
  timeoutMs(): number {
    return REPO_VISIBILITY_TIMEOUT_MS;
  }
}

/** 全局单例：设置页两个调用点与推送路径共用同一份 60 s 去重 / sticky 状态。 */
export const repoVisibilityChecker: RepoVisibilityChecker = new RepoVisibilityChecker();
