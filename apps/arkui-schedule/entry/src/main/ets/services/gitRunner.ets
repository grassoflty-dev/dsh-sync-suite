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
 * 未绑定 / 桥未就绪时所有方法抛 `E_SYNC_UNAVAILABLE`，由 syncStatusStore 显示为「只读·原因」，
 * 绝不静默降级为「假同步」。
 */
import { GitSyncService } from './GitSyncService';
import type { GitPort } from '../model/syncCycle';

const UNAVAILABLE: string = 'E_SYNC_UNAVAILABLE: 同步内核或 GitRunner 未就绪';

export class BridgeGitRunner implements GitPort {
  private pendingPaths: string[] = [];

  /** 当前可用的服务实例（syncController / 设置页构造出的最后一个 GitSyncService）。 */
  private service(): GitSyncService {
    const active: GitSyncService | null = GitSyncService.active();
    if (active === null || !active.isBridgeReady()) {
      throw new Error(UNAVAILABLE);
    }
    return active;
  }

  /** 桥是否可用（供激活闸与 UI 预检；不抛异常）。 */
  available(): boolean {
    const active: GitSyncService | null = GitSyncService.active();
    return active !== null && active.isBridgeReady();
  }

  async fetchMain(): Promise<void> {
    const args: Record<string, string> = {};
    await this.service().v2Git('fetch', args);
  }

  async headSha(): Promise<string> {
    const args: Record<string, string> = { 'ref': 'HEAD' };
    return (await this.service().v2Git('resolveRef', args)).oid;
  }

  async originMainSha(): Promise<string> {
    const args: Record<string, string> = { 'ref': 'refs/remotes/origin/main' };
    return (await this.service().v2Git('resolveRef', args)).oid;
  }

  async showMain(path: string): Promise<string> {
    const args: Record<string, string> = { 'ref': 'origin/main', 'path': path };
    return (await this.service().v2Git('readBlob', args)).value;
  }

  async branchName(): Promise<string> {
    const args: Record<string, string> = {};
    return (await this.service().v2Git('currentBranch', args)).value;
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
    const base: string = (await this.service().v2Git('mergeBase', args)).oid;
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
    await this.service().v2Git('fastForward', args);
  }

  async listRemoteDays(): Promise<string[]> {
    const args: Record<string, string> = {};
    const raw: string = (await this.service().v2Git('listDays', args)).value;
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
    await this.service().v2Git('addCommit', args);
  }

  async pushMain(): Promise<void> {
    const args: Record<string, string> = {};
    await this.service().v2Git('push', args); // 桥侧 force=false，无 refspec 重写
  }

  async resetHardOrigin(): Promise<void> {
    const args: Record<string, string> = {};
    await this.service().v2Git('resetHard', args); // 唯一 reset；不删远端文件
  }
}

/** 全局单例：syncProtocolStore.setRunner() 注入；页面 bootstrap 绑定。 */
export const bridgeGitRunner: BridgeGitRunner = new BridgeGitRunner();
