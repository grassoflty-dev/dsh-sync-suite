/**
 * GitPort 的 ArkTS 绑定（mod-v2-sync-wiring）：把 model/syncCycle.ts 的端口接到应用的 git 桥。
 *
 * 实际 API（唯一桥点）：`GitSyncService.v2Git(op, args)` → rawfile/git/git-bridge.js 的
 * `opV2Git` → isomorphic-git 1.25.3。该薄桥是**跨模块触碰**（GitSyncService.ets +
 * git-bridge.js 各新增一个入口）；本文件不新增依赖、不直接执行 shell、不碰 devices/**。
 *
 * 分支恒为 main、force 恒为 false、唯一的 reset 是 resetHard（本地分支指回 origin/main）。
 * addPaths 只缓冲路径，commit 时一次性经白名单提交（桥侧拒绝任何非 timeline/** 路径）。
 *
 * 未绑定 / 桥未就绪时先有界等待（首轮周期早于 WebView onPageEnd 是常态）；超时才抛带中文下一步的
 * `E_SYNC_UNAVAILABLE`，由 syncStatusStore 显示为可点「重试同步」的失败行，绝不静默降级为「假同步」。
 */
import { GitSyncService } from './GitSyncService';
import { syncController } from './syncController';
import { syncProtocolStore } from './syncProtocolStore';
import { runnerReadyDecision, E_SYNC_UNAVAILABLE_MESSAGE } from '../model/syncCycle';
import type { GitPort, RemoteLayout, RunnerReadyDecision } from '../model/syncCycle';
import type { common } from '@kit.AbilityKit';

/** 首轮周期早于隐藏 Web 的 onPageEnd 时，最多等 10 秒再报 typed 错（不静默失败、不无限等）。 */
const READY_TIMEOUT_MS: number = 10000;
const READY_POLL_MS: number = 50;

export class BridgeGitRunner implements GitPort {
  private pendingPaths: string[] = [];

  /**
   * 确定性取桥：优先 App 级 `syncController` 绑定的那个服务（启动链唯一真值），
   * 只有它尚未就绪时才退回 `GitSyncService.active()` 这个「最后创建的实例」。
   *
   * 为什么不能只用 active()：设置页 `SettingsSync` 会 new 第二个 GitSyncService，
   * 顺手把 activeService 抢走。用户「设置 → 同步仓库 → 返回 → 重试同步」时，
   * 旧实现会盯住那个可能永远 onPageEnd 不到的设置页实例，10s 后误报 E_SYNC_UNAVAILABLE。
   */
  private resolveService(): GitSyncService | null {
    const canonical: GitSyncService | null = syncController.readyService();
    return canonical !== null ? canonical : GitSyncService.active();
  }

  /**
   * 取可用的服务实例：隐藏 Web 的 onPageEnd 与首条记录写入的先后是不确定的。
   * 旧实现一上来就抛 E_SYNC_UNAVAILABLE，导致「建记录→自动同步」总在内核就绪前失败、
   * 用户不得不手动再点一次同步。这里改为**有界等待**：就绪后照常跑 pull→append→push；
   * 只有超时才抛带中文下一步的 typed 错（状态行可点「重试同步」）。
   */
  private async requireService(): Promise<GitSyncService> {
    const started: number = Date.now();
    for (;;) {
      const active: GitSyncService | null = this.resolveService();
      const ready: boolean = active !== null && active.isBridgeReady();
      const waited: number = Date.now() - started;
      const decision: RunnerReadyDecision = runnerReadyDecision(ready, waited, READY_TIMEOUT_MS);
      if (decision === 'ready' && active !== null) {
        return active;
      }
      if (decision === 'unavailable') {
        throw new Error(E_SYNC_UNAVAILABLE_MESSAGE);
      }
      await new Promise<void>((resolve: () => void): void => {
        setTimeout(resolve, READY_POLL_MS);
      });
    }
  }

  /** 桥是否可用（供激活闸与 UI 预检；不抛异常）。 */
  available(): boolean {
    const active: GitSyncService | null = this.resolveService();
    return active !== null && active.isBridgeReady();
  }

  async fetchMain(): Promise<void> {
    const args: Record<string, string> = {};
    await (await this.requireService()).v2Git('fetch', args);
  }

  async headSha(): Promise<string> {
    const args: Record<string, string> = { 'ref': 'HEAD' };
    return (await (await this.requireService()).v2Git('resolveRef', args)).oid;
  }

  async originMainSha(): Promise<string> {
    const args: Record<string, string> = { 'ref': 'refs/remotes/origin/main' };
    return (await (await this.requireService()).v2Git('resolveRef', args)).oid;
  }

  async showMain(path: string): Promise<string> {
    const args: Record<string, string> = { 'ref': 'origin/main', 'path': path };
    return (await (await this.requireService()).v2Git('readBlob', args)).value;
  }

  async branchName(): Promise<string> {
    const args: Record<string, string> = {};
    return (await (await this.requireService()).v2Git('currentBranch', args)).value;
  }

  async headRelation(): Promise<string> {
    const head: string = await this.headSha();
    const origin: string = await this.originMainSha();
    if (head.length === 0 || origin.length === 0) {
      return 'diverged';
    }
    if (head === origin) {
      return 'equal';
    }
    const args: Record<string, string> = { 'a': head, 'b': origin };
    const base: string = (await (await this.requireService()).v2Git('mergeBase', args)).oid;
    if (base === head) {
      return 'behind';
    }
    if (base === origin) {
      return 'ahead';
    }
    return 'diverged';
  }

  async fastForward(): Promise<void> {
    const args: Record<string, string> = {};
    await (await this.requireService()).v2Git('fastForward', args);
  }

  async listRemoteDays(): Promise<string[]> {
    const args: Record<string, string> = {};
    const raw: string = (await (await this.requireService()).v2Git('listDays', args)).value;
    try {
      const parsed: string[] = JSON.parse(raw) as string[];
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      return [];
    }
  }

  /**
   * 首跑探测：直接列举服务端引用，不依赖 fetch（空远端上 `fetch origin main` 会因缺少引用失败）。
   * 解析失败时按「非空且无 main」fail-closed —— 绝不盲目引导，避免覆盖别人的历史。
   */
  async remoteLayout(): Promise<RemoteLayout> {
    const args: Record<string, string> = {};
    const raw: string = (await (await this.requireService()).v2Git('remoteLayout', args)).value;
    try {
      const parsed: RemoteLayout = JSON.parse(raw) as RemoteLayout;
      return {
        hasMain: parsed.hasMain === true,
        isEmpty: parsed.isEmpty === true,
        refs: Array.isArray(parsed.refs) ? parsed.refs : []
      };
    } catch (error) {
      return { hasMain: false, isEmpty: false, refs: [] };
    }
  }

  /** 首跑引导：列出本地工作副本 timeline/** 的相对路径（含 schema.json 与各日文件）。 */
  async localTimelinePaths(): Promise<string[]> {
    const args: Record<string, string> = {};
    const raw: string = (await (await this.requireService()).v2Git('listLocalTimeline', args)).value;
    try {
      const parsed: string[] = JSON.parse(raw) as string[];
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      return [];
    }
  }

  /**
   * §11 门禁前置：读本地工作副本 timeline/schema.json 原文（缺文件 = 空串）。
   * 桥侧对缺文件返回空串且不抛；空串由 parseSchemaMarker 判为未知版本，fail-closed。
   */
  async localSchemaText(): Promise<string> {
    const args: Record<string, string> = {};
    const raw: string = (await (await this.requireService()).v2Git('readLocalTimelineSchema', args)).value;
    return typeof raw === 'string' ? raw : '';
  }

  /** 只缓冲：真正的 git add + commit 在 commit() 里一次完成（syncCycle 的调用顺序固定）。 */
  async addPaths(paths: string[]): Promise<void> {
    this.pendingPaths = paths.slice();
  }

  async commit(message: string): Promise<void> {
    if (this.pendingPaths.length === 0) {
      return;
    }
    const args: Record<string, string> = {
      'paths': JSON.stringify(this.pendingPaths), 'message': message
    };
    this.pendingPaths = [];
    await (await this.requireService()).v2Git('addCommit', args);
  }

  async pushMain(): Promise<void> {
    const args: Record<string, string> = {};
    await (await this.requireService()).v2Git('push', args); // 桥侧 force=false，无 refspec 重写
  }

  async resetHardOrigin(): Promise<void> {
    const args: Record<string, string> = {};
    await (await this.requireService()).v2Git('resetHard', args); // 唯一 reset；不删远端文件
  }
}

/** 全局单例：syncProtocolStore.setRunner() 注入；页面 bootstrap 绑定。 */
export const bridgeGitRunner: BridgeGitRunner = new BridgeGitRunner();

/**
 * 确定性绑定：任何能发起同步周期的入口（启动、建记录后的 fire-and-forget、
 * 首页「重试同步」/下拉刷新）都先经这里把 runner + filesDir 一次到位。
 * 幂等：重复调用只覆盖同一份单例状态，不会重复建桥或重复注册代理。
 */
export function bindBridgeRunner(ability: common.UIAbilityContext): void {
  syncProtocolStore.bindAtStartup(bridgeGitRunner, ability);
}
