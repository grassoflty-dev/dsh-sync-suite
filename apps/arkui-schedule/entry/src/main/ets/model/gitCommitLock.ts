/**
 * git 写操作的串行闸（mod-app-git-commit-atomic）。
 *
 * 为什么需要这一层：BridgeGitRunner.addPaths() 只把路径缓冲到单例的 pendingPaths，
 * commit() 才真正排空缓冲并提交。隐藏会话（services/chatStore.hideChat）与同步周期
 * （本文件 runCyclePure）共用同一个 runner 实例：若两边各自 addPaths → commit → push
 * 互不排队，A 缓冲的路径会被 B 的 addPaths 覆盖，于是 B 的 `[v2] sync N days` 提交里
 * 混进 A 的文件，A 却照样拿到 ok:true（隐藏行留在工作区未提交）。本模块提供**唯一**的
 * async 互斥原语：两个写口把整段 add → commit → push 放进同一个 runner Owned 的
 * `withWriteLock` 闭包，临界区内不允许出现第二个写者；缓冲仍由 runner 在 commit 里
 * 恰好排空一次。
 *
 * 闸是**实例级**的，不是进程级全局：它属于被保护的那个 GitPort/runner。这样多设备
 * 仿真（两个独立 port）互不牵连，而应用内两个写口共享单例 runner 时必然取到同一把闸。
 * 实现只是一串 Promise：新任务挂在前一个任务的尾巴上；无论前一次是 resolve 还是 reject，
 * 尾巴都归一成已兑现的 Promise，因此任何异常都不会把闸卡死（无死锁、无定时等待）。
 * 纯模型、零 IO、Node 可直接编译测试（tools/.build/model/gitCommitLock.js）。
 */

/**
 * 阶段判别（mod-app-git-commit-atomic）：ArkTS 的流分析看不到异步回调里对 stage 的赋值，
 * 在 catch 里直接写 `stage === 'push'` 会报「'commit' 与 'push' 无重叠」。
 * 经**参数位置**读取可保留完整的 'commit' | 'push' 联合（实参 'commit' 是联合成员），
 * 既不必放宽成 string，也不会让两个写口各自复制一份判定而漂移。
 */
export function isPushStage(stage: 'commit' | 'push'): boolean {
  return stage === 'push';
}

/** 实例级串行闸：一个 runner 持有一个；所有调用方经 run() 进入同一临界区。 */
export class GitCommitLock {
  /** 串行尾：任何 settle 都归一成已兑现，保证队列永远向前。 */
  private tail: Promise<void> = Promise.resolve();

  /** 当前在临界区内执行的任务数（只读观测值，供测试证明没有两个写者重叠）。 */
  private activeTasks: number = 0;

  /** 只读：当前在闸内执行的任务数（不改变闸状态）。 */
  active(): number {
    return this.activeTasks;
  }

  /**
   * 在闸内执行 task。调用方必须把 add → commit → push 全部包进同一个闭包。
   * task 抛错时原样把错误交还调用方，但计数与尾巴都在 finally / 归一回调里收口，
   * 失败路径同样释放闸。
   */
  run<T>(task: () => Promise<T>): Promise<T> {
    const guarded: () => Promise<T> = async (): Promise<T> => {
      this.activeTasks += 1;
      try {
        return await task();
      } finally {
        this.activeTasks -= 1;
      }
    };
    const result: Promise<T> = this.tail.then(guarded, guarded);
    this.tail = result.then(
      (): void => {},
      (): void => {}
    );
    return result;
  }
}
