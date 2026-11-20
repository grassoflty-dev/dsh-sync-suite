/**
 * mod-v2-import-v1：应用内一次性 v1 → v2 迁移服务（thin IO）。
 *
 * 所有策略（折叠 / 计划 / 写序 / 拒绝 / 汇总）都在 model/importV1.ts 的纯核心里；
 * 本文件只做三件 IO：
 *   1. 通过 timelineWriteStore 的**只读** v1 助手读 devices/**（绝不写 / 移动 / 删除）；
 *   2. 通过 GitSyncService.zipList / zipRead 读 v1 按天 zip（只读桥，绝不写回 zip）；
 *   3. 通过 timelineWriteStore 的**迁移专用** writer 写 timeline/**（records 原子、
 *      summary 原子、media 只增、ledgers 只追加、schema 最后）。
 *
 * 迁移是**用户显式**动作：UI 必须先展示 dry-run 计划，再单独确认；本服务不自动触发。
 * 未迁移时普通 v2 写入仍由 timelineWriteStore.requireEnabled 拒绝，本服务不绕过其它写路径。
 */
import { common } from '@kit.AbilityKit';
import { timelineWriteStore } from './timelineWriteStore';
import { importV1Reader } from './importV1Reader';
import { timelineStore } from './timelineStore';
import { GitSyncService } from './GitSyncService';
import { parseSchemaMarker, parseTimelineDay } from '../model/timeline';
import {
  planV1Import, applyV1Plan, summarizePlan, decideImportRefusal,
  parseV1Summary, isCalendarDate
} from '../model/importV1';
import type {
  V1ImportInput, V1ImportPlan, V1TextLine, V1SummaryDocInput, V1ExistingDayInput,
  V2RecordPlan, V2MediaPlan, V1RefusalInput, ImportRefusal, V1ApplySink,
  V1MediaSource, V1ApplyResult, V1MediaWriteResult, V1MediaSizeInput
} from '../model/importV1';

/** UI 读的 dry-run 视图（计划文本 + 类型化拒绝 + 断点状态消息）。 */
export interface ImportPlanView {
  ok: boolean;
  refusal: ImportRefusal | null;
  stateMessage: string;
  lines: string[];
  plan: V1ImportPlan | null;
}

/** UI 读的 apply 结果（含逐字中文报告；失败也返回，不伪造成功）。 */
export interface ImportApplyView {
  ok: boolean;
  message: string;
  refusal: ImportRefusal | null;
  result: V1ApplyResult | null;
  migrated: boolean;
}

/** 读回来的 v1 摘要 JSON 的形态（只取 generatedAt）。 */
interface V1SummaryRaw {
  generatedAt?: number;
}

/** 从桥返回的 zip 条目形态（只读枚举）。 */
interface ZipEntryShape {
  name: string;
  size: number;
}

const SCHEMA_REL: string = 'timeline/schema.json';

export class ImportV1Service {
  private filesDir: string = '';
  private ready: boolean = false;

  /** 幂等初始化：取 filesDir，并初始化只读 / 写入两个 store。 */
  async ensureReady(context: object): Promise<void> {
    if (this.ready) {
      return;
    }
    const abilityContext: common.UIAbilityContext = context as common.UIAbilityContext;
    this.filesDir = abilityContext.filesDir;
    await timelineStore.ensureReady(context);
    await timelineWriteStore.ensureReady(context);
    await importV1Reader.ensureReady(context);
    GitSyncService.setFilesDir(this.filesDir);
    this.ready = true;
  }

  /**
   * dry-run 计划（零写入）：读 v1 + 现有 timeline + zip 条目枚举，产出计划文本。
   * 任何解析失败都进 skipReasons，不静默跳过；严格模式由 UI 传入。
   */
  async plan(strictMode: boolean): Promise<ImportPlanView> {
    try {
      this.requireReady();
      const input: V1ImportInput = await this.readInputs();
      const plan: V1ImportPlan = planV1Import(input);
      const refusalInput: V1RefusalInput = this.refusalInput(input, plan, strictMode);
      const refusal: ImportRefusal | null = decideImportRefusal(refusalInput);
      const lines: string[] = summarizePlan(plan);
      let stateMessage: string = '';
      if (refusal !== null) {
        lines.unshift(`${refusal.reason} 下一步：${refusal.nextStep}`);
        if (!refusal.blocks) {
          stateMessage = refusal.reason;
        }
      }
      const view: ImportPlanView = {
        ok: refusal === null || !refusal.blocks,
        refusal: refusal,
        stateMessage: stateMessage,
        lines: lines,
        plan: plan
      };
      return view;
    } catch (error) {
      const view: ImportPlanView = {
        ok: false, refusal: null,
        stateMessage: `E_IO: 读取迁移输入失败：${this.errorText(error)}`,
        lines: [`E_IO: 读取迁移输入失败：${this.errorText(error)}`, '下一步：检查仓库可读性与 devices/ 目录后重试。'],
        plan: null
      };
      return view;
    }
  }

  /**
   * 应用计划（仍要求 UI 已单独确认）：重新 dry-run 以复用同一份映射与校验，
   * 严格按 nextWriteSteps 落盘；失败时 schema 尚未写，UI 显示「可继续」。
   */
  async apply(strictMode: boolean): Promise<ImportApplyView> {
    try {
      this.requireReady();
      const planned: ImportPlanView = await this.plan(strictMode);
      if (planned.plan === null) {
        return this.failedApply(planned.stateMessage, planned.refusal);
      }
      if (planned.refusal !== null && planned.refusal.blocks) {
        return this.failedApply(planned.refusal.reason, planned.refusal);
      }
      const prefetched: Map<string, Uint8Array | null> = await this.prefetchMedia(planned.plan);
      const source: V1MediaSource = this.mediaSource(prefetched);
      const sink: V1ApplySink = this.sink();
      const result: V1ApplyResult = applyV1Plan(planned.plan as V1ImportPlan, sink, source);
      const migrated: boolean = this.readSchemaVersion() === 2;
      const text: string = `迁移完成：${result.steps.length} 步；媒体写入 ${result.mediaWritten} / 已存在 ${result.mediaAlreadyPresent}`
        + ` / 冲突 ${result.mediaConflict} / 缺失 ${result.mediaMissing}；schema 最后写入 = ${result.schemaWritten}`
        + (migrated ? '；仓库已切到 v2 时间线' : '；标记未落地，请检查写入失败原因');
      const view: ImportApplyView = {
        ok: migrated && result.schemaWritten,
        message: text, refusal: null, result: result, migrated: migrated
      };
      return view;
    } catch (error) {
      const message: string = `E_PARTIAL_MIGRATION: 迁移在第 ${this.stepCount} 步中断（${this.stepKind}）：${this.errorText(error)}`
        + '；schema 尚未写入，仓库仍为未迁移态，可点「确认迁移」继续。';
      return this.failedApply(message, null);
    }
  }

  /** 迁移完成后重新判定仓库是否已迁移（UI 刷新横幅用，不依赖缓存的 timelineStore.v2）。 */
  isMigratedNow(): boolean {
    try {
      return this.readSchemaVersion() === 2;
    } catch {
      return false;
    }
  }

  /** 最近一次写入的步骤计数 / 种类（仅用于失败文案，不参与数据判定）。 */
  private stepCount: number = 0;
  private stepKind: string = '';

  private failedApply(message: string, refusal: ImportRefusal | null): ImportApplyView {
    const view: ImportApplyView = {
      ok: false, message: message, refusal: refusal, result: null, migrated: false
    };
    return view;
  }

  private requireReady(): void {
    if (!this.ready || this.filesDir.length === 0) {
      throw new Error('迁移服务尚未初始化：请先调用 importV1Service.ensureReady(context)');
    }
  }

  private readSchemaVersion(): number | null {
    const text: string = timelineWriteStore.migrationReadText(SCHEMA_REL);
    if (text.length === 0) {
      return null;
    }
    return parseSchemaMarker(text).version;
  }

  /** 从 v1/v2 仓库读入全部计划输入（只读；devices/** 永不写）。 */
  private async readInputs(): Promise<V1ImportInput> {
    const scheduleLines: V1TextLine[] = [];
    const openLines: string[] = [];
    const summaries: V1SummaryDocInput[] = [];
    const availableZipEntries: string[] = [];
    const mediaSizes: V1MediaSizeInput[] = [];
    const deviceNames: string[] = this.safeNames(importV1Reader.listNames('devices'));
    let zipListAvailable: boolean = false;
    const service: GitSyncService | null = GitSyncService.active();
    if (service !== null && service.isReady()) {
      zipListAvailable = true;
    }
    for (let i = 0; i < deviceNames.length; i += 1) {
      const device: string = deviceNames[i];
      if (!this.safeSegment(device)) {
        continue;
      }
      const scheduleNames: string[] = this.safeNames(
        importV1Reader.listNames(`devices/${device}/schedules`));
      for (let j = 0; j < scheduleNames.length; j += 1) {
        const name: string = scheduleNames[j];
        if (!name.endsWith('.jsonl')) {
          continue;
        }
        const date: string = name.slice(0, name.length - '.jsonl'.length);
        const text: string = importV1Reader.readText(`devices/${device}/schedules/${name}`);
        const rows: string[] = text.split(/\r?\n/);
        for (let k = 0; k < rows.length; k += 1) {
          if (rows[k].trim().length === 0) {
            continue;
          }
          const line: V1TextLine = { deviceId: device, date: date, text: rows[k] };
          scheduleLines.push(line);
        }
      }
      const openText: string = importV1Reader.readText(`devices/${device}/open.jsonl`);
      const openRows: string[] = openText.split(/\r?\n/);
      for (let j = 0; j < openRows.length; j += 1) {
        if (openRows[j].trim().length > 0) {
          openLines.push(openRows[j]);
        }
      }
      const summaryNames: string[] = this.safeNames(
        importV1Reader.listNames(`devices/${device}/summaries`));
      for (let j = 0; j < summaryNames.length; j += 1) {
        const name: string = summaryNames[j];
        if (!name.endsWith('.json')) {
          continue;
        }
        const date: string = name.slice(0, name.length - '.json'.length);
        if (!isCalendarDate(date)) {
          continue;
        }
        const text: string = importV1Reader.readText(`devices/${device}/summaries/${name}`);
        const parsed: V1SummaryDocInput | null = parseV1Summary(text);
        if (parsed !== null) {
          const doc: V1SummaryDocInput = { date: date, text: text, generatedAt: parsed.generatedAt };
          summaries.push(doc);
        }
      }
      const zipNames: string[] = this.safeNames(
        importV1Reader.listNames(`devices/${device}/attachments`));
      for (let j = 0; j < zipNames.length; j += 1) {
        const archive: string = zipNames[j];
        if (!archive.endsWith('.zip')) {
          continue;
        }
        const entries: ZipEntryShape[] = await this.zipEntries(device, archive);
        for (let k = 0; k < entries.length; k += 1) {
          const entryName: string = entries[k].name;
          availableZipEntries.push(`${archive}\u0000${entryName}`);
          mediaSizes.push({ archive: archive, entry: entryName, size: entries[k].size });
        }
      }
    }
    const existingDays: V1ExistingDayInput[] = this.readExistingDays();
    const input: V1ImportInput = {
      scheduleLines: scheduleLines, openLines: openLines, summaries: summaries,
      availableZipEntries: availableZipEntries, mediaSizes: mediaSizes,
      zipListAvailable: zipListAvailable, existingDays: existingDays
    };
    return input;
  }

  /** 只读列已有 timeline 日目录（断点续跑），坏 JSON 不抛、按空日处理并跳过。 */
  private readExistingDays(): V1ExistingDayInput[] {
    const out: V1ExistingDayInput[] = [];
    const names: string[] = this.safeNames(timelineWriteStore.migrationListNames('timeline'));
    for (let i = 0; i < names.length; i += 1) {
      const date: string = names[i];
      if (!isCalendarDate(date)) {
        continue;
      }
      const recordsText: string = timelineWriteStore.migrationReadText(`timeline/${date}/records.json`);
      const parsed = parseTimelineDay(recordsText, date);
      const records: V2RecordPlan[] = [];
      if (parsed.day === null) {
        continue; // 坏日文件：整日跳过，不把不可信字节当成已有记录
      }
      for (let j = 0; j < parsed.day.allRecords.length; j += 1) {
        records.push(this.asRecordPlan(parsed.day.allRecords[j]));
      }
      const summaryText: string = timelineWriteStore.migrationReadText(`timeline/${date}/summary.json`);
      let generatedAt: number | null = null;
      if (summaryText.length > 0) {
        const parsedSummary = parseV1Summary(summaryText);
        generatedAt = parsedSummary === null ? null : parsedSummary.generatedAt;
      }
      const deleted: string[] = this.readLines(`timeline/${date}/deleted.jsonl`);
      const restored: string[] = this.readLines(`timeline/${date}/restore.jsonl`);
      const conflicts: string[] = this.readLines(`timeline/${date}/conflicts.jsonl`);
      const mediaFiles: string[] = this.safeNames(
        timelineWriteStore.migrationListNames(`timeline/${date}/media`));
      const day: V1ExistingDayInput = {
        date: date, records: records, summaryGeneratedAt: generatedAt,
        deletedLines: deleted, restoreLines: restored, conflictLines: conflicts,
        mediaFiles: mediaFiles
      };
      out.push(day);
    }
    return out;
  }

  /** v2 TimelineRecord → 纯核心的 V2RecordPlan（未知字段尾随，不丢字段）。 */
  private asRecordPlan(record: object): V2RecordPlan {
    const map: Record<string, Object> = JSON.parse(JSON.stringify(record)) as Record<string, Object>;
    const str = (key: string): string => typeof map[key] === 'string' ? map[key] as string : '';
    const bool = (key: string): boolean => map[key] === true;
    const media: V2MediaPlan[] = [];
    const rawMedia: Object | undefined = map['media'];
    if (Array.isArray(rawMedia)) {
      for (let i = 0; i < rawMedia.length; i += 1) {
        const item: Record<string, Object> = rawMedia[i] as Record<string, Object>;
        const file: string = typeof item['file'] === 'string' ? item['file'] as string : '';
        const sha: string = typeof item['sha256'] === 'string' ? item['sha256'] as string : '';
        const page: Object | undefined = item['pageIndex'];
        if (file.length > 0 && sha.length > 0) {
          media.push({
            file: file, sha256: sha,
            pageIndex: typeof page === 'number' && Number.isInteger(page) && (page as number) >= 0 ? page as number : 0
          });
        }
      }
    }
    const out: V2RecordPlan = {
      id: str('id'), ts: str('ts'), title: str('title'), body: str('body'), author: str('author'),
      done: bool('done'), media: media, ai_processed: bool('ai_processed'),
      opened_at: str('opened_at'), extras: []
    };
    const known: string[] = [
      'id', 'ts', 'title', 'body', 'author', 'done', 'media', 'ai_processed', 'opened_at',
      'ocr_text', 'ai_structured', 'ocr_time', 'closed_at'
    ];
    const ocrText: string = str('ocr_text');
    const aiStructured: string = str('ai_structured');
    const ocrTime: string = str('ocr_time');
    const closedAt: string = str('closed_at');
    if (ocrText.length > 0) {
      out.ocr_text = ocrText;
    }
    if (aiStructured.length > 0) {
      out.ai_structured = aiStructured;
    }
    if (ocrTime.length > 0) {
      out.ocr_time = ocrTime;
    }
    if (closedAt.length > 0) {
      out.closed_at = closedAt;
    }
    for (const key of Object.keys(map)) {
      if (known.indexOf(key) < 0) {
        out.extras.push({ key: key, json: JSON.stringify(map[key]) });
      }
    }
    return out;
  }

  /** 只读枚举一个 v1 zip 的条目（缺 zip / 桥未就绪 → 空数组）。 */
  private async zipEntries(device: string, archive: string): Promise<ZipEntryShape[]> {
    const service: GitSyncService | null = GitSyncService.active();
    if (service === null || !service.isReady()) {
      return [];
    }
    try {
      const path: string = importV1Reader.filePath(`devices/${device}/attachments/${archive}`);
      const entries = await service.zipList(path);
      const out: ZipEntryShape[] = [];
      for (let i = 0; i < entries.length; i += 1) {
        out.push({ name: entries[i].name, size: entries[i].size });
      }
      return out;
    } catch {
      return [];
    }
  }

  /** 预取所有媒体字节（zipRead 是异步，applyV1Plan 的 source 必须是同步）。 */
  private async prefetchMedia(plan: V1ImportPlan): Promise<Map<string, Uint8Array | null>> {
    const out: Map<string, Uint8Array | null> = new Map<string, Uint8Array | null>();
    const service: GitSyncService | null = GitSyncService.active();
    for (let i = 0; i < plan.days.length; i += 1) {
      const media = plan.days[i].media;
      for (let j = 0; j < media.length; j += 1) {
        const item = media[j];
        const key: string = this.mediaKey(item.deviceId, item.archive, item.entry);
        if (out.has(key)) {
          continue;
        }
        if (service === null || !service.isReady()) {
          out.set(key, null);
          continue;
        }
        try {
          const path: string = importV1Reader.filePath(
            `devices/${item.deviceId}/attachments/${item.archive}`);
          const bytes: Uint8Array | null = await service.zipRead(path, item.entry);
          out.set(key, bytes);
        } catch {
          out.set(key, null);
        }
      }
    }
    return out;
  }

  private mediaSource(prefetched: Map<string, Uint8Array | null>): V1MediaSource {
    const maps: Map<string, Uint8Array | null> = prefetched;
    return {
      read: (deviceId: string, archive: string, entry: string): Uint8Array | null => {
        const key: string = this.mediaKey(deviceId, archive, entry);
        const value: Uint8Array | null | undefined = maps.get(key);
        return value === undefined ? null : value;
      }
    };
  }

  private mediaKey(deviceId: string, archive: string, entry: string): string {
    return `${deviceId}\u0000${archive}\u0000${entry}`;
  }

  /** 迁移专用写入汇：只调 timelineWriteStore 的迁移方法，不碰任何其它写路径。 */
  private sink(): V1ApplySink {
    const self: ImportV1Service = this;
    return {
      writeRecords: (date: string, text: string): void => {
        self.beforeStep('records');
        timelineWriteStore.migrationWriteRecords(date, text);
      },
      writeSummary: (date: string, text: string): void => {
        self.beforeStep('summary');
        timelineWriteStore.migrationWriteSummary(date, text);
      },
      writeMedia: (date: string, file: string, bytes: Uint8Array): V1MediaWriteResult => {
        self.beforeStep('media');
        return timelineWriteStore.migrationWriteMedia(date, file, bytes);
      },
      appendLedgers: (date: string, deleted: string[], restored: string[], conflicts: string[]): void => {
        self.beforeStep('ledgers');
        timelineWriteStore.migrationAppendLedgers(date, deleted, restored, conflicts);
      },
      writeSchema: (text: string): void => {
        self.beforeStep('schema');
        timelineWriteStore.migrationWriteSchema(text);
      }
    };
  }

  /** 失败文案用的步骤计数（不改变数据判定）。 */
  private beforeStep(kind: string): void {
    this.stepCount += 1;
    this.stepKind = kind;
  }

  /** 纯核心需要的拒绝输入（可用空间 API 不可靠时传 null，由核心 best-effort 跳过）。 */
  private refusalInput(input: V1ImportInput, plan: V1ImportPlan, strictMode: boolean): V1RefusalInput {
    let corruptRows: number = 0;
    for (let i = 0; i < plan.skipReasons.length; i += 1) {
      if (plan.skipReasons[i].reason.startsWith('坏行已跳过')) {
        corruptRows += 1;
      }
    }
    const timelineDays: string[] = [];
    for (let i = 0; i < input.existingDays.length; i += 1) {
      timelineDays.push(input.existingDays[i].date);
    }
    const out: V1RefusalInput = {
      schemaVersion: this.readSchemaVersion(),
      hasDevices: importV1Reader.listNames('devices').length > 0,
      hasV1Schedules: input.scheduleLines.length > 0,
      timelineDayDirs: timelineDays,
      strictMode: strictMode,
      corruptRows: corruptRows,
      plannedBytes: plan.totals.bytes,
      availableBytes: this.availableBytes()
    };
    return out;
  }

  /**
   * 可用空间预检（best-effort）：本运行时无可靠的空闲字节 API，返回 null，
   * 由纯核心跳过 E_NO_SPACE，并在 UI 报告中给出计划总字节数作为替代依据。
   */
  private availableBytes(): number | null {
    return timelineWriteStore.migrationAvailableBytes();
  }

  private readLines(relPath: string): string[] {
    const text: string = timelineWriteStore.migrationReadText(relPath);
    if (text.length === 0) {
      return [];
    }
    const lines: string[] = text.split(/\r?\n/);
    const out: string[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].trim().length > 0) {
        out.push(lines[i]);
      }
    }
    return out;
  }

  private safeNames(names: string[]): string[] {
    const out: string[] = names.slice();
    out.sort();
    return out;
  }

  private safeSegment(name: string): boolean {
    return name.length > 0 && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\');
  }

  private errorText(error: Object): string {
    return error instanceof Error ? error.message : String(error);
  }
}

/** 全局单例：首页迁移面板与设置页共用同一份状态。 */
export const importV1Service: ImportV1Service = new ImportV1Service();
