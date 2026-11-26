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
 * 未绑定 / 桥未就绪时先**等页面回传的就绪信号**（首轮周期早于 WebView onPageEnd 是常态）；
 * 超时才抛带中文下一步的 `E_SYNC_UNAVAILABLE`，由 syncStatusStore 显示为可点「重试同步」的
 * 失败行，绝不静默降级为「假同步」。为什么信号而不是 `onPageEnd`：`onPageEnd` 只证明页面加载完，
 * 不证明代理可调用（真机 `FindObject Unknown object: objectId = 10737418` 就是反证）。
 */
import { GitSyncService } from './GitSyncService';
import { syncController } from './syncController';
import { syncProtocolStore } from './syncProtocolStore';
import { runnerReadyDecision, E_SYNC_UNAVAILABLE_MESSAGE } from '../model/syncCycle';
import type { GitPort, RemoteLayout, RunnerReadyDecision } from '../model/syncCycle';
import type { common } from '@kit.AbilityKit';

/**
 * 等就绪信号的总预算：首轮周期早于隐藏 Web 的就绪信号时，最多等 10 秒再报 typed 错
 * （不静默失败、不无限等）。这个预算是**上限**，不是轮询间隔。
 */
const READY_TIMEOUT_MS: number = 10000;
/** 只在「连服务实例都还没有」时按此节拍再取一次（等页面交出控制器；不是就绪判定）。 */
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
   * 取可用的服务实例，并**等页面自己的就绪信号**（不是靠定时器猜）。
   *
   * 旧实现每 50ms 轮询 `isBridgeReady()`，而那个位是在 `onPageEnd` 里直接置上的——真机冷启动
   * 证明这句话不成立：`onPageEnd` 之后代理仍未注册，窗口里的第一次调用打在空对象上
   * （`FindObject Unknown object: objectId = 10737418`），设置页就永久停在「读取中…」。
   * 现在改成向服务要「就绪信号」（页面真的调到代理之后才回传），拿到才算可用；
   * 总预算仍是 `READY_TIMEOUT_MS`，超时才抛带中文下一步的 typed `E_SYNC_UNAVAILABLE`
   * （状态行可点重试），绝不无限等、也不静默降级为「假同步」。
   *
   * `setTimeout(READY_POLL_MS)` 只剩一个用途：**连服务实例都还没有**时按节拍再取一次
   * （等页面把控制器交出来）；那一步没有信号可等，不构成就绪判定。
   */
  private async requireService(): Promise<GitSyncService> {
    const started: number = Date.now();
    for (;;) {
      const active: GitSyncService | null = this.resolveService();
      if (active !== null) {
        const remaining: number = READY_TIMEOUT_MS - (Date.now() - started);
        const ready: boolean = await active.awaitBridgeReady(remaining);
        const waited: number = Date.now() - started;
        const decision: RunnerReadyDecision = runnerReadyDecision(ready, waited, READY_TIMEOUT_MS);
        if (decision === 'ready') {
          return active;
        }
        if (decision === 'unavailable') {
          throw new Error(E_SYNC_UNAVAILABLE_MESSAGE);
        }
        continue;
      }
      const waited: number = Date.now() - started;
      const decision: RunnerReadyDecision = runnerReadyDecision(false, waited, READY_TIMEOUT_MS);
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
