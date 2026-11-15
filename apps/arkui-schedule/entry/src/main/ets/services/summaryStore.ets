/**
 * 每日 AI 汇总的落盘与生成：`<filesDir>/git-repo/devices/<deviceId>/summaries/YYYY-MM-DD.json`。
 *
 * - 与日程同目录树，随 git 同步（`git-bridge` 的 push 递归 add 整个 `devices/<deviceId>/`）；
 * - **不写进 `schedules/*.jsonl`**：汇总是派生结果，日程日志保持「只追加」；
 * - 顺序固定「先 AI、后写盘」：AI 失败直接抛中文 Error，一个字节都不写，旧汇总保持原样。
 */
import { fileIo as fs } from '@kit.CoreFileKit';
import { buildSummaryPayload, readDailySummary, summaryFromReply, writeDailySummary } from '../model/dailySummary';
import type {
  DailySummary,
  SummaryIO,
  SummaryMeta,
  SummaryRequestInput,
  SummaryWriteResult
} from '../model/dailySummary';
import type { ScheduleRecord } from '../model/types';
import { nowIso } from '../common/date';
import { deviceTimeZone, summarize } from './deepseek';
import { scheduleStore } from './scheduleStore';

const REPO_DIR_NAME: string = 'git-repo';

/** 汇总文件端口：把仓库相对路径映射到沙箱绝对路径，并负责建目录。 */
class RepoSummaryIO implements SummaryIO {
  private repoRoot: string;

  constructor(repoRoot: string) {
    this.repoRoot = repoRoot;
  }

  readText(path: string): string | null {
    const absolute: string = `${this.repoRoot}/${path}`;
    try {
      if (!fs.accessSync(absolute)) {
        return null;
      }
      return fs.readTextSync(absolute);
    } catch (error) {
      return null;
    }
  }

  writeText(path: string, text: string): void {
    const absolute: string = `${this.repoRoot}/${path}`;
    const slash: number = absolute.lastIndexOf('/');
    const dir: string = slash < 0 ? absolute : absolute.slice(0, slash);
    if (!this.dirExists(dir)) {
      fs.mkdirSync(dir, true);
    }
    let file: fs.File | null = null;
    try {
      file = fs.openSync(absolute, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
      fs.writeSync(file.fd, text);
    } finally {
      if (file !== null) {
        fs.closeSync(file);
      }
    }
  }

  private dirExists(dir: string): boolean {
    try {
      return fs.accessSync(dir);
    } catch (error) {
      return false;
    }
  }
}

export class SummaryStore {
  private ready: boolean = false;

  /** 初始化（幂等）：依赖 scheduleStore 的目录与设备标识状态。 */
  async ensureReady(context: object): Promise<void> {
    if (this.ready) {
      return;
    }
    await scheduleStore.ensureReady(context);
    this.ready = true;
  }

  isReady(): boolean {
    return scheduleStore.isReady();
  }

  /** 读取某天的汇总；没有/损坏都返回 `null`（不抛，页面据此显示「还没有汇总」）。 */
  read(date: string): DailySummary | null {
    if (!scheduleStore.isReady()) {
      return null;
    }
    return readDailySummary(this.io(), scheduleStore.getDeviceId(), date).summary;
  }

  /** 汇总文件在仓库里的相对路径（排障/日志用）。 */
  summaryRepoPath(date: string): string {
    return `devices/${scheduleStore.getDeviceId()}/summaries/${date}.json`;
  }

  /**
   * 生成并落盘某天的汇总。
   *
   * 先调 AI（失败即抛，不碰文件）→ 解析回复 → 读旧文件按 `generatedAt` 合并后写入。
   * 因此任何失败都不会覆盖上一次成功的汇总；同一天更旧的回复也不会盖掉新的。
   */
  async generate(
    records: ScheduleRecord[],
    date: string,
    apiKey: string,
    providerId: string,
    model: string,
    baseURL: string
  ): Promise<DailySummary> {
    if (!scheduleStore.isReady()) {
      throw new Error('汇总存储尚未初始化：请先调用 summaryStore.ensureReady(context)');
    }
    const input: SummaryRequestInput = buildSummaryPayload(records, date, deviceTimeZone());
    if (input.recordCount === 0) {
      throw new Error('当天还没有记录，先写一条再生成汇总');
    }
    const reply: string = await summarize(input.payload, apiKey, nowIso(), input.timeZone, model, providerId, baseURL);
    const meta: SummaryMeta = {
      date: date,
      generatedAt: Date.now(),
      model: model,
      provider: providerId,
      recordCount: input.recordCount,
      doneCount: input.doneCount
    };
    const draft: DailySummary = summaryFromReply(reply, meta);
    const result: SummaryWriteResult = writeDailySummary(this.io(), scheduleStore.getDeviceId(), draft);
    if (result.summary === null || result.reason === 'read-failed' || result.reason === 'write-failed') {
      throw new Error(`汇总未保存（${result.reason}），旧汇总保持不变`);
    }
    return result.summary;
  }

  private io(): SummaryIO {
    return new RepoSummaryIO(`${scheduleStore.getFilesDir()}/${REPO_DIR_NAME}`);
  }
}

/** 全局单例（与 scheduleStore 共用同一份目录状态）。 */
export const summaryStore: SummaryStore = new SummaryStore();
