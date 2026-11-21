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
import { runnerReadyDecision, E_SYNC_UNAVAILABLE_MESSAGE } from '../model/syncCycle';
import type { GitPort, RunnerReadyDecision } from '../model/syncCycle';

/** 首轮周期早于隐藏 Web 的 onPageEnd 时，最多等 10 秒再报 typed 错（不静默失败、不无限等）。 */
const READY_TIMEOUT_MS: number = 10000;
const READY_POLL_MS: number = 50;

export class BridgeGitRunner implements GitPort {
  private pendingPaths: string[] = [];

  /**
   * 取可用的服务实例：隐藏 Web 的 onPageEnd 与首条记录写入的先后是不确定的。
   * 旧实现一上来就抛 E_SYNC_UNAVAILABLE，导致「建记录→自动同步」总在内核就绪前失败、
   * 用户不得不手动再点一次同步。这里改为**有界等待**：就绪后照常跑 pull→append→push；
   * 只有超时才抛带中文下一步的 typed 错（状态行可点「重试同步」）。
   */
  private async requireService(): Promise<GitSyncService> {
    const started: number = Date.now();
    for (;;) {
      const active: GitSyncService | null = GitSyncService.active();
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
    const active: GitSyncService | null = GitSyncService.active();
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
