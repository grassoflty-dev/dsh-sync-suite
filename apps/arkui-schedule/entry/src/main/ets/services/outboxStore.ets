/**
 * 本地 outbox 存储（mod-v2-dual-write-off）：v2 写入失败时把意图**停放在仓库之外**。
 *
 * 与契约 docs/DATA-CONTRACT-v2.md §9「本地 outbox」表一致：
 * - 路径 `<filesDir>/sync-outbox.json`，在 `git-repo/` **之外**，永不进仓库；
 * - 文件形态是 JSON 数组，条目形状复用 `model/syncProtocol.ts` 的 `OutboxEntry`；
 * - 原子替换：同目录写 tmp → 回读逐字校验 → rename，**不删除唯一副本、不删除任何历史意图**；
 * - `enqueue` 按 `intentId` 去重（同 payload 重复停放不产生第二条）；
 * - 操作面：enqueue / list / remove / clear + P1-2 `retry`（failed→pending，attempts=0）
 *   与 `updateLastError`（回写 typed 原因）；不实现同步周期（那是 syncProtocolStore）。
 *
 * 硬约束：本文件不碰 `devices/**`、不写 AppStorage、不引入新依赖。
 */
import { fileIo as fs } from '@kit.CoreFileKit';
import { common } from '@kit.AbilityKit';
import { resetForRetry } from '../model/syncProtocol';
import type { OutboxEntry } from '../model/syncProtocol';

/** outbox 落在 filesDir 根，不在 git-repo/ 之内。 */
const OUTBOX_FILE_NAME: string = 'sync-outbox.json';
const TMP_INFIX: string = '.tmp-';

export class OutboxStore {
  private filesDir: string = '';
  private ready: boolean = false;
  private sequence: number = 0;
  /** 实例随机标签 + 单调序号，保证并发 tmp 文件名不碰撞（仅命名，不参与数据）。 */
  private instanceTag: string = Math.random().toString(36).slice(2, 10);

  /** 初始化（幂等）：只取 filesDir，不创建仓库内任何目录。 */
  async ensureReady(context: object): Promise<void> {
    if (this.ready) {
      return;
    }
    const abilityContext = context as common.UIAbilityContext;
    this.filesDir = abilityContext.filesDir;
    this.ready = true;
  }

  /**
   * 入队：按 `intentId` 去重；同 id 已存在则完全不动（幂等，不刷新 attempts / enqueuedAt）。
   */
  enqueue(entry: OutboxEntry): void {
    this.requireReady();
    const entries: OutboxEntry[] = this.list();
    for (let i = 0; i < entries.length; i += 1) {
      if (entries[i].intentId === entry.intentId) {
        return;
      }
    }
    entries.push(entry);
    this.writeOutbox(entries);
  }

  /** 列出全部停放意图；坏文件 / 缺文件按空数组处理，绝不猜测历史内容。 */
  list(): OutboxEntry[] {
    this.requireReady();
    const path: string = this.outboxPath();
    if (!this.fileExists(path)) {
      return [];
    }
    try {
      // 文件形态就是 OutboxEntry[]（声明好的接口数组），不是 any / unknown 的临时形状。
      const parsed: OutboxEntry[] = JSON.parse(fs.readTextSync(path));
      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // 坏文件按空处理；下一次写入会用合法数组覆盖，不丢任何已成功落盘的意图。
    }
    return [];
  }

  /**
   * P1-2 用户「重试」：把一条 failed 意图原子复位为 `attempts=0, state=pending`。
   * 复用纯函数 `resetForRetry`（payload 不可变）；id 不存在返回 false、零写盘。
   * 这是 §9 P1-1「只有用户在 UI 点重试才原子重新入队」的唯一入口。
   */
  retry(intentId: string): boolean {
    this.requireReady();
    const entries: OutboxEntry[] = this.list();
    const next: OutboxEntry[] = [];
    let changed: boolean = false;
    for (const entry of entries) {
      if (entry.intentId === intentId) {
        next.push(resetForRetry(entry));
        changed = true;
      } else {
        next.push(entry);
      }
    }
    if (!changed) {
      return false;
    }
    this.writeOutbox(next);
    return true;
  }

  /** 回填写失败 / 推送失败的 typed 原因（payload 不变，attempts 不变）。 */
  updateLastError(intentId: string, reason: string): void {
    this.requireReady();
    const entries: OutboxEntry[] = this.list();
    const next: OutboxEntry[] = [];
    for (const entry of entries) {
      if (entry.intentId === intentId) {
        next.push({
          intentId: entry.intentId, op: entry.op, date: entry.date, id: entry.id, ts: entry.ts,
          line: entry.line, enqueuedAt: entry.enqueuedAt, attempts: entry.attempts,
          state: entry.state, lastError: reason
        });
      } else {
        next.push(entry);
      }
    }
    this.writeOutbox(next);
  }

  /** 按 intentId 出队；不存在时 no-op（不产生 IO 之外的副作用）。 */
  remove(intentId: string): void {
    this.requireReady();
    const kept: OutboxEntry[] = [];
    for (const entry of this.list()) {
      if (entry.intentId !== intentId) {
        kept.push(entry);
      }
    }
    this.writeOutbox(kept);
  }

  /** 清空（仅供用户在 UI 显式放弃停放意图时调用；本模块不自动调用）。 */
  clear(): void {
    this.requireReady();
    this.writeOutbox([]);
  }

  // ------------------------------------------------------------------ 内部实现

  private requireReady(): void {
    if (this.filesDir.length === 0) {
      throw new Error('outbox 尚未初始化：请先调用 outboxStore.ensureReady(context)');
    }
  }

  /** `<filesDir>/sync-outbox.json` —— 明确在 git-repo/ 之外。 */
  private outboxPath(): string {
    return `${this.filesDir}/${OUTBOX_FILE_NAME}`;
  }

  /** 原子替换：tmp 写 + 回读校验 + rename（不做 unlink，仓库外文件也不删历史）。 */
  private writeOutbox(entries: OutboxEntry[]): void {
    const path: string = this.outboxPath();
    const tmp: string = `${path}${TMP_INFIX}${this.instanceTag}-${Date.now()}-${this.nextSequence()}`;
    const text: string = JSON.stringify(entries);
    this.writeTextSync(tmp, text);
    if (fs.readTextSync(tmp) !== text) {
      throw new Error('E_OUTBOX_ATOMIC: outbox 临时文件回读不一致，现场保留待检查');
    }
    fs.renameSync(tmp, path);
  }

  /**
   * 文本写入：本 SDK 的 fileIo 没有 writeTextSync，按 scheduleStore / draftStore / timelineWriteStore
   * 的同一模式用 openSync(READ_WRITE|CREATE|TRUNC) + writeSync(fd, text) + closeSync。
   * 成功字节与旧 API 完全一致，tmp + 回读 + rename 的原子性不变。
   */
  private writeTextSync(path: string, text: string): void {
    let file: fs.File | null = null;
    try {
      file = fs.openSync(path, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
      fs.writeSync(file.fd, text);
    } catch (error) {
      throw new Error(`写入 outbox 临时文件失败（${path}）：${this.errorText(error)}`);
    } finally {
      if (file !== null) {
        fs.closeSync(file);
      }
    }
  }

  private errorText(error: object): string {
    return error instanceof Error ? error.message : String(error);
  }

  private nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }

  private fileExists(path: string): boolean {
    try {
      return fs.accessSync(path);
    } catch {
      return false;
    }
  }
}

/** 全局单例：与读 / 写 / 同步服务共用同一份 filesDir 视图。 */
export const outboxStore: OutboxStore = new OutboxStore();
