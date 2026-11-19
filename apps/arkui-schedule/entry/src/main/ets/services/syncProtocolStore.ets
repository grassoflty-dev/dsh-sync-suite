/**
 * v2 同步周期编排（mod-v2-sync-protocol）：薄 IO 层，默认**惰性**。
 *
 * 三条硬约束（绝不违反）：
 * 1. **绝不 force-push**：推送只用 `git push origin main`，不出现 --force / -f / +refspec；
 * 2. **绝不重写远端历史**：唯一的 merge 形式是 `git merge --ff-only origin/main`（仅 behind 时，
 *    不改写任何提交）；push 被拒只 `git reset --hard origin/main` 回到远端真值后重来，
 *    不 pull --rebase / 不 amend / 不 clean / 不改写已推送提交；
 * 3. **绝不删除远端文件**：只写 `timeline/**` 的日文件与账本，不运行任何远端 rm / 清理。
 *
 * 门禁与职责：
 * - `isEnabled()` = timelineStore.useV2()；每个公开 IO 方法第一句 requireEnabled()，
 *   未启用时在任何 IO 之前抛 `Error('timeline v2 同步未启用')`。本模块不翻转开关、不接 UI、
 *   不写 AppStorage、不写 v1 路径。
 * - §11 唯一门禁 assertWritable()：schema=2 + 分支 main + HEAD 是 origin/main 或其祖先
 *   （behind 放行、ahead/diverged 拒绝）。门禁在 fetch **之后**（需 freshly fetched origin/main
 *   才能算祖先关系），但早于任何写；behind 时先 `git merge --ff-only origin/main` 快进，
 *   失败即 `E_NOT_SYNCED: 本地与 origin/main 已分叉，请先手工处理` 且零写入；快进后复检
 *   schema+分支门禁（标记可能已变），再读文本 / union / 落盘。
 * - §9 周期固定 7 步（见 runCycle 内编号）：fetch → 门禁/ff/复检 → 读远端/本地文本 →
 *   unionDay（两侧账本并集） → 原子落盘 + 账本/conflicts 追加 → commit `[v2] sync <n> days`
 *   → push origin main。
 * - outbox 是周期之间唯一的本地真值：`<filesDir>/sync-outbox.json`，在 `git-repo/` 之外，
 *   JSON 数组 + tmp 改名原子替换；push 被拒 → reset --hard origin/main → 重放意图 →
 *   重试至多 MAX_ATTEMPTS(4) 次，耗尽则 failed 终态留在 outbox，报 pending=N failed=M。
 *   dropped 意图（记录已删被有意放弃）立即出队、不计 attempts、不误报 E_PUSH_REJECTED。
 *
 * git 命令通过注入的 GitRunner 执行（参数数组，绝不拼 shell 字符串）；这样本文件只负责
 * 命令**序列**的正确性，不依赖具体 git 绑定，也便于上层测试注入。
 */
import { fileIo as fs } from '@kit.CoreFileKit';
import { common } from '@kit.AbilityKit';
import { timelineStore } from './timelineStore';
import { timelineWriteStore } from './timelineWriteStore';
import { parseSchemaMarker, timelineDayPath } from '../model/timeline';
import {
  assertWritable, isFastForwardable, unionDay, replayable, markAttempt,
  outboxAfterReplay, isApplied, MAX_ATTEMPTS, SYNC_RETRY_ERROR
} from '../model/syncProtocol';
import type {
  OutboxEntry, DayUnion, DayTexts, WriteGateInput, WriteGateCode, WriteGateResult
} from '../model/syncProtocol';
import type { ScheduleRecord } from '../model/types';

/** git 命令执行器：接收参数数组，返回 stdout；非 0 退出由 runner 抛错。 */
export type GitRunner = (args: string[]) => Promise<string>;

export interface SyncCycleContext {
  ability: common.UIAbilityContext;
  git: GitRunner;
}

/** typed 周期结果：失败时 code/message 可直接驱动 §9 的三态 UI。 */
export interface CycleResult {
  ok: boolean;
  code: WriteGateCode | 'E_PUSH_REJECTED';
  message: string;
  days: number;
  conflicts: number;
  added: number;
  /** F3：被有意放弃的 upsert 意图数（记录已删，出队且不重试，单独上报）。 */
  dropped: string[];
  pending: number;
  failed: number;
  attempts: number;
}

interface PrepareResult {
  gate: WriteGateResult | null;
  appliedIds: string[];
  droppedIds: string[];
  days: number;
  conflicts: number;
  added: number;
}

/** HEAD 与 origin/main 的祖先判据（由 git merge-base 得出，交给纯门禁函数）。 */
interface HeadFacts {
  branch: string;
  headSha: string;
  originMainSha: string;
  headIsAncestorOfOrigin: boolean;
  originIsAncestorOfHead: boolean;
}

const ROOT_DIR_NAME: string = 'git-repo';
/** outbox 在 git-repo 之外（契约 §9 本地 outbox 表）。 */
const OUTBOX_FILE_NAME: string = 'sync-outbox.json';
const CONFLICTS_FILE_NAME: string = 'conflicts.jsonl';
const DELETED_FILE_NAME: string = 'deleted.jsonl';
const RESTORE_FILE_NAME: string = 'restore.jsonl';
const TMP_INFIX: string = '.tmp-';
const COMMIT_PREFIX: string = '[v2] sync ';
const DISABLED_MESSAGE: string = 'timeline v2 同步未启用';
/** F1：快进失败（本地分叉）时的 typed 文案；零写入。 */
const FF_DIVERGED_MESSAGE: string = '本地与 origin/main 已分叉，请先手工处理';

/** 冲突行解析形状（只读 id/ts/dedupeKey；未知字段忽略）。 */
interface ConflictRowShape {
  id?: string;
  ts?: string;
  dedupeKey?: string;
}

export class SyncProtocolStore {
  private filesDir: string = '';
  private ready: boolean = false;
  private sequence: number = 0;
  private instanceTag: string = Math.random().toString(36).slice(2, 10);

  /** 唯一开关：与写入服务共用 timelineStore 的组合判定；本方法不执行任何 IO。 */
  isEnabled(): boolean {
    return timelineStore.useV2();
  }

  /**
   * 单一同步周期（§9 七步）。未启用时第一句即抛错，零 IO。
   */
  async runCycle(ctx: SyncCycleContext): Promise<CycleResult> {
    this.requireEnabled();
    await this.ensureReady(ctx.ability);
    const git: GitRunner = ctx.git;
    const now = new Date();
    let outbox: OutboxEntry[] = this.readOutbox();

    // 步骤 1：git fetch origin main（绝不 pull --rebase；唯一 merge 是后面的 --ff-only）。
    await git(['fetch', 'origin', 'main']);

    // 步骤 2–6：门禁 → behind 快进 → 复检门禁 → 读文本 → union → 落盘 → commit。
    // 门禁 / 快进失败由 prepare 返回 typed，零写入。
    let prepared: PrepareResult = await this.prepare(git, outbox, now);
    if (prepared.gate !== null && !prepared.gate.ok) {
      return this.gateFailure(prepared.gate, outbox);
    }

    // F3：dropped 意图（记录已删，编辑被有意放弃）必须在进入推送循环前就出队：
    // 既不参与 bumpAttempts（永不被误判 failed / E_PUSH_REJECTED），也不被 reapplyIntents
    // 重放成"复活"本地行。它的出队与 push 成败无关，因为该记录按账本本就不可见。
    // 拒推重来后可能再产生新的 dropped，用 droppedReported 跨轮累计上报。
    const droppedReported: string[] = [];
    const dequeueDropped = (result: PrepareResult): void => {
      if (result.droppedIds.length === 0) {
        return;
      }
      const droppedSet = new Set<string>(result.droppedIds);
      outbox = outbox.filter((entry: OutboxEntry): boolean => !droppedSet.has(entry.intentId));
      for (const id of result.droppedIds) {
        if (droppedReported.indexOf(id) < 0) {
          droppedReported.push(id);
        }
      }
      this.writeOutbox(outbox);
    };
    dequeueDropped(prepared);

    // 步骤 7：git push origin main；被拒走唯一 reset --hard 路径，重试 ≤ MAX_ATTEMPTS。
    let attempts = 0;
    for (;;) {
      attempts += 1;
      // P1-1：每次进入推送前 attempts += 1 并落盘（跨会话累计，不重置）。
      outbox = this.bumpAttempts(outbox);
      this.writeOutbox(outbox);
      try {
        await git(['push', 'origin', 'main']); // 唯一推送命令：无 --force / 无 refspec 重写
        // F3：applied 与 dropped 一并出队；dropped 不计 attempts、单独上报。
        const done = outboxAfterReplay(outbox, prepared.appliedIds, [], droppedReported, now);
        this.writeOutbox(done);
        return {
          ok: true, code: 'ok', message: '已同步',
          days: prepared.days, conflicts: prepared.conflicts, added: prepared.added,
          dropped: droppedReported,
          pending: this.pendingCount(done), failed: this.failedCount(done), attempts: attempts
        };
      } catch (error) {
        // push 被拒（非快进）→ 本地唯一真值在仓库外 outbox，故 reset 不丢数据。
        await git(['reset', '--hard', 'origin/main']);
        if (attempts >= MAX_ATTEMPTS) {
          break;
        }
        // 重放 outbox 意图（复用写入服务的公开入口），随后重新并集 / 提交。
        this.reapplyIntents(outbox);
        prepared = await this.prepare(git, outbox, now);
        if (prepared.gate !== null && !prepared.gate.ok) {
          return this.gateFailure(prepared.gate, outbox);
        }
        dequeueDropped(prepared);
      }
    }

    // 重试预算耗尽：failed 终态留在 outbox，停自动重放，只等用户点「重试」。
    const failedIds: string[] = [];
    for (const entry of replayable(outbox)) {
      failedIds.push(entry.intentId);
    }
    const parked = outboxAfterReplay(outbox, [], failedIds, droppedReported, now);
    this.writeOutbox(parked);
    return {
      ok: false, code: 'E_PUSH_REJECTED', message: SYNC_RETRY_ERROR,
      days: prepared.days, conflicts: prepared.conflicts, added: prepared.added,
      dropped: droppedReported,
      pending: this.pendingCount(parked), failed: this.failedCount(parked), attempts: attempts
    };
  }

  // ------------------------------------------------------------------ 门禁与初始化

  /** 每个公开 IO 方法的第一句：未启用时在任何 IO 之前抛错。 */
  private requireEnabled(): void {
    if (!this.isEnabled()) {
      throw new Error(DISABLED_MESSAGE);
    }
  }

  private async ensureReady(ability: common.UIAbilityContext): Promise<void> {
    if (this.ready) {
      return;
    }
    this.filesDir = ability.filesDir;
    this.ready = true;
  }

  // ------------------------------------------------------------------ 步骤 2–6

  /** 读取 HEAD / origin/main 的祖先事实（纯 git 只读，无写句柄）。 */
  private async headFacts(git: GitRunner): Promise<HeadFacts> {
    const branch: string = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    const headSha: string = (await git(['rev-parse', 'HEAD'])).trim();
    const originMainSha: string = (await git(['rev-parse', 'origin/main'])).trim();
    let headIsAncestorOfOrigin: boolean = false;
    let originIsAncestorOfHead: boolean = false;
    if (headSha === originMainSha) {
      headIsAncestorOfOrigin = true;
      originIsAncestorOfHead = true;
    } else {
      try {
        const base: string = (await git(['merge-base', 'HEAD', 'origin/main'])).trim();
        headIsAncestorOfOrigin = base === headSha;
        originIsAncestorOfHead = base === originMainSha;
      } catch {
        // 无共同祖先 → 视为分叉；两个布尔量保持 false。
      }
    }
    return {
      branch: branch, headSha: headSha, originMainSha: originMainSha,
      headIsAncestorOfOrigin: headIsAncestorOfOrigin,
      originIsAncestorOfHead: originIsAncestorOfHead
    };
  }

  /** 组装 §11 门禁输入：schema + 分支 + HEAD 与 origin/main 的祖先事实。 */
  private gateInput(schemaVersion: number | null, facts: HeadFacts): WriteGateInput {
    return {
      schemaVersion: schemaVersion, branch: facts.branch,
      headSha: facts.headSha, originMainSha: facts.originMainSha,
      headIsAncestorOfOrigin: facts.headIsAncestorOfOrigin,
      originIsAncestorOfHead: facts.originIsAncestorOfHead
    };
  }

  /**
   * 步骤 2 门禁 → 步骤 3 behind 快进 → 步骤 4 复检门禁 →
   * 步骤 5 读文本 / unionDay（两侧账本并集） → 步骤 6 原子写 / commit。
   * 门禁与快进失败均 typed 返回且**零写入**（此前只有 git 只读命令与 show）。
   */
  private async prepare(git: GitRunner, outbox: OutboxEntry[], now: Date): Promise<PrepareResult> {
    const empty: PrepareResult = {
      gate: null, appliedIds: [], droppedIds: [], days: 0, conflicts: 0, added: 0
    };

    // 步骤 2：§11 唯一门禁（fetch 之后：origin/main 已是远端最新，才能算祖先关系）。
    const marker = parseSchemaMarker(await this.remoteText(git, '', 'schema.json'));
    const facts = await this.headFacts(git);
    const firstInput: WriteGateInput = this.gateInput(marker.ok ? marker.version : null, facts);
    let gate: WriteGateResult = assertWritable(firstInput);
    if (!gate.ok) {
      return { gate: gate, appliedIds: [], droppedIds: [], days: 0, conflicts: 0, added: 0 };
    }

    // 步骤 3：behind（HEAD 是 origin/main 的祖先）→ `git merge --ff-only origin/main`。
    // 这是全文件唯一的 merge 形式：不改写历史；失败即 typed E_NOT_SYNCED + 零写入。
    if (isFastForwardable(firstInput)) {
      try {
        await git(['merge', '--ff-only', 'origin/main']);
      } catch {
        const diverged: WriteGateResult = {
          ok: false, code: 'E_NOT_SYNCED', message: FF_DIVERGED_MESSAGE
        };
        return { gate: diverged, appliedIds: [], droppedIds: [], days: 0, conflicts: 0, added: 0 };
      }
    }

    // 步骤 4：快进后复检 schema + 分支门禁（schema.json 可能已随快进改变），仍零写入。
    const recheck = parseSchemaMarker(await this.remoteText(git, '', 'schema.json'));
    const reFacts = await this.headFacts(git);
    gate = assertWritable(this.gateInput(recheck.ok ? recheck.version : null, reFacts));
    if (!gate.ok) {
      return { gate: gate, appliedIds: [], droppedIds: [], days: 0, conflicts: 0, added: 0 };
    }

    // 步骤 5：读远端/本地文本（含两本账本）→ 逐日 unionDay（远端 ∪ 本地 → 意图重放）。
    const dates = this.mergeDates(this.localDates(), await this.remoteDates(git));
    const changedPaths: string[] = [];
    const appliedIds: string[] = [];
    const droppedIds: string[] = [];
    let conflicts = 0;
    let added = 0;
    for (const date of dates) {
      const remoteTexts: DayTexts = {
        records: await this.remoteText(git, date, 'records.json'),
        deleted: await this.remoteText(git, date, DELETED_FILE_NAME),
        restore: await this.remoteText(git, date, RESTORE_FILE_NAME)
      };
      const localTexts: DayTexts = {
        records: this.readText(this.recordsPath(date)),
        deleted: this.readText(this.timelineFilePath(date, DELETED_FILE_NAME)),
        restore: this.readText(this.timelineFilePath(date, RESTORE_FILE_NAME))
      };
      const dayEntries = this.entriesForDate(outbox, date).filter((entry: OutboxEntry): boolean =>
        // P1-2：账本类意图先做幂等判定；已删 id 的 upsert 由 isApplied 放行，进 unionDay 计 dropped。
        entry.op === 'upsert' ||
        !isApplied(entry, localTexts.records, localTexts.deleted, localTexts.restore));
      const union: DayUnion = unionDay(date, remoteTexts, localTexts, dayEntries, now);
      for (const id of union.applied) {
        appliedIds.push(id);
      }
      for (const id of union.dropped) {
        droppedIds.push(id);
      }
      added += union.added;

      // 步骤 6：只写发生变化的日；records.json 由 buildRecordsText 产出后原子替换。
      let touched = false;
      if (union.text.length > 0 && union.text !== localTexts.records) {
        this.atomicReplaceText(this.recordsPath(date), union.text);
        changedPaths.push(`timeline/${date}/records.json`);
        touched = true;
      }
      // conflicts：远端审计行与本地审计行一起按 (id,ts,dedupeKey) 追加去重。
      const remoteConflicts: string = await this.remoteText(git, date, CONFLICTS_FILE_NAME);
      const conflictLines: string[] = union.conflicts.concat(
        remoteConflicts.split(/\r?\n/).filter((line: string): boolean => line.length > 0));
      if (conflictLines.length > 0) {
        const appended = this.appendDedupLines(
          this.timelineFilePath(date, CONFLICTS_FILE_NAME), conflictLines,
          (line: string): string => this.conflictKey(line));
        if (appended > 0) {
          changedPaths.push(`timeline/${date}/${CONFLICTS_FILE_NAME}`);
          conflicts += appended;
          touched = true;
        }
      }
      // F2：并集账本写回（本地原文是严格前缀，只追加远端/意图新行）。
      if (union.deleted !== localTexts.deleted) {
        if (!union.deleted.startsWith(localTexts.deleted)) {
          throw new Error('E_LEDGER_APPEND: 删除账本并集破坏只追加前缀不变量，现场保留');
        }
        this.atomicReplaceText(this.timelineFilePath(date, DELETED_FILE_NAME), union.deleted);
        changedPaths.push(`timeline/${date}/${DELETED_FILE_NAME}`);
        touched = true;
      }
      if (union.restored !== localTexts.restore) {
        if (!union.restored.startsWith(localTexts.restore)) {
          throw new Error('E_LEDGER_APPEND: 撤销账本并集破坏只追加前缀不变量，现场保留');
        }
        this.atomicReplaceText(this.timelineFilePath(date, RESTORE_FILE_NAME), union.restored);
        changedPaths.push(`timeline/${date}/${RESTORE_FILE_NAME}`);
        touched = true;
      }
      if (touched) {
        empty.days += 1;
      }
    }

    // 步骤 6（续）：git add 仅受影响日 → commit `[v2] sync <n> days`。
    if (changedPaths.length > 0) {
      const addArgs: string[] = ['add', '--'];
      for (const path of changedPaths) {
        addArgs.push(path);
      }
      await git(addArgs);
      await git(['commit', '-m', `${COMMIT_PREFIX}${empty.days} days`]);
    }
    return {
      gate: null, appliedIds: appliedIds, droppedIds: droppedIds,
      days: empty.days, conflicts: conflicts, added: added
    };
  }

  // ------------------------------------------------------------------ 重放 / outbox

  /**
   * push 被拒后重放意图：复用 timelineWriteStore 的公开入口（它自身也要求已启用）。
   * F4：timelineWriteStore.append 内部走 planUpsert，与正常路径 unionDay 的
   * normalizeForWrite（同样委托 planUpsert）是同一套规范化，两条路径产出逐字节一致。
   */
  private reapplyIntents(outbox: OutboxEntry[]): void {
    for (const entry of replayable(outbox)) {
      if (entry.op === 'upsert') {
        const obj: ScheduleRecord = JSON.parse(entry.line);
        this.timelineWriteStoreAppend(obj, entry.date);
      } else if (entry.op === 'delete') {
        timelineWriteStore.scheduleDelete(entry.id, entry.date, entry.ts);
      } else if (entry.op === 'restore') {
        timelineWriteStore.restore(entry.id, entry.date, entry.ts);
      } else {
        timelineWriteStore.purgeRows(entry.id, entry.date, entry.ts);
      }
    }
  }

  /** upsert 重放的类型转换隔离（payload 入队即固定，重放不重新生成 ts）。 */
  private timelineWriteStoreAppend(record: ScheduleRecord, date: string): void {
    timelineWriteStore.append(record, date);
  }

  /** 推送前累计尝试次数（attempts += 1，failed 终态不参与）。 */
  private bumpAttempts(outbox: OutboxEntry[]): OutboxEntry[] {
    const out: OutboxEntry[] = [];
    for (const entry of outbox) {
      if (entry.state === 'syncing' || entry.state === 'pending') {
        out.push(markAttempt(entry, ''));
      } else {
        out.push(entry);
      }
    }
    return out;
  }

  /** 读 outbox：坏文件 / 缺文件返回 []（fail-soft，绝不丢已落盘的意图）。 */
  private readOutbox(): OutboxEntry[] {
    const path = this.outboxPath();
    if (!this.fileExists(path)) {
      return [];
    }
    try {
      const parsed: OutboxEntry[] = JSON.parse(fs.readTextSync(path));
      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // 坏文件按空处理；下一步写入会以合法数组覆盖，但不猜测任何历史意图内容。
    }
    return [];
  }

  /** outbox 原子替换：同目录 tmp 写 + 回读校验 + rename（tmp 在 git-repo 之外）。 */
  private writeOutbox(entries: OutboxEntry[]): void {
    const path = this.outboxPath();
    const tmp = `${path}${TMP_INFIX}${this.instanceTag}-${Date.now()}-${this.nextSequence()}`;
    const text = JSON.stringify(entries);
    this.writeTextToFile(tmp, text);
    if (fs.readTextSync(tmp) !== text) {
      throw new Error('E_OUTBOX_ATOMIC: outbox 临时文件回读不一致，现场保留');
    }
    fs.renameSync(tmp, path);
  }

  private nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }

  // ------------------------------------------------------------------ 文件 / git 原语

  private outboxPath(): string {
    return `${this.filesDir}/${OUTBOX_FILE_NAME}`;
  }

  private recordsPath(date: string): string {
    return `${this.filesDir}/${ROOT_DIR_NAME}/${timelineDayPath(date)}`;
  }

  private timelineRoot(): string {
    return `${this.filesDir}/${ROOT_DIR_NAME}/timeline`;
  }

  private timelineFilePath(date: string, name: string): string {
    return `${this.timelineRoot()}/${date}/${name}`;
  }

  private async remoteText(git: GitRunner, date: string, name: string): Promise<string> {
    const spec = date.length === 0 ? 'origin/main:timeline/schema.json' : `origin/main:timeline/${date}/${name}`;
    try {
      return await git(['show', spec]);
    } catch {
      return ''; // 远端缺该文件 = 空文本（union 的 remote-only / local-only 口径）
    }
  }

  private async remoteDates(git: GitRunner): Promise<string[]> {
    const out: string[] = [];
    let listing = '';
    try {
      listing = await git(['ls-tree', '-r', '--name-only', 'origin/main', '--', 'timeline']);
    } catch {
      return out;
    }
    for (const raw of listing.split(/\r?\n/)) {
      const matched = /^timeline\/(\d{4}-\d{2}-\d{2})\/records\.json$/.exec(raw.trim());
      if (matched !== null) {
        out.push(matched[1]);
      }
    }
    return out.sort();
  }

  /** 本地日期列表：只列有 records.json 的合法日历日（复用只读服务的 listDates）。 */
  private localDates(): string[] {
    return timelineStore.listDates();
  }

  private mergeDates(local: string[], remote: string[]): string[] {
    const set = new Set<string>();
    for (const date of local) {
      set.add(date);
    }
    for (const date of remote) {
      set.add(date);
    }
    const out: string[] = [];
    for (const date of set) {
      out.push(date);
    }
    return out.sort();
  }

  private entriesForDate(outbox: OutboxEntry[], date: string): OutboxEntry[] {
    const out: OutboxEntry[] = [];
    for (const entry of outbox) {
      if (entry.date === date) {
        out.push(entry);
      }
    }
    return out;
  }

  /** 冲突行去重键：(id, ts, dedupeKey)（与 §4 / 迁移工具一致）。 */
  private conflictKey(line: string): string {
    try {
      const row: ConflictRowShape = JSON.parse(line);
      if (typeof row.id === 'string' && typeof row.ts === 'string' && typeof row.dedupeKey === 'string') {
        return `${row.id}\u0000${row.ts}\u0000${row.dedupeKey}`;
      }
    } catch {
      // 坏行退化为整行比较
    }
    return line;
  }

  /** 追加式写：旧字节恒为新字节严格前缀；按 key 去重；原子落盘。 */
  private appendDedupLines(path: string, lines: string[], keyOf: (line: string) => string): number {
    const existing = this.readText(path);
    const seen = new Set<string>();
    for (const raw of existing.split(/\r?\n/)) {
      if (raw.length > 0) {
        seen.add(keyOf(raw));
      }
    }
    const addedLines: string[] = [];
    for (const line of lines) {
      const key = keyOf(line);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      addedLines.push(line);
    }
    if (addedLines.length === 0) {
      return 0;
    }
    const head = existing.length === 0 || existing.endsWith('\n') ? existing : `${existing}\n`;
    this.atomicReplaceText(path, `${head}${addedLines.join('\n')}\n`);
    return addedLines.length;
  }

  /** 原子替换（tmp 写 + 回读 + rename），不先删原文件、不删唯一副本。 */
  private atomicReplaceText(path: string, text: string): void {
    const slash = path.lastIndexOf('/');
    const dir = slash >= 0 ? path.slice(0, slash) : path;
    this.ensureDir(dir);
    const tmp = `${path}${TMP_INFIX}${this.instanceTag}-${Date.now()}-${this.nextSequence()}`;
    this.writeTextToFile(tmp, text);
    if (fs.readTextSync(tmp) !== text) {
      throw new Error(`E_SYNC_ATOMIC: 临时文件回读不一致（${path}），现场保留`);
    }
    fs.renameSync(tmp, path);
  }

  /** 写文本到指定路径（ArkTS 无 fs.writeTextSync；与 draftStore 同一写法）。 */
  private writeTextToFile(path: string, text: string): void {
    const file = fs.openSync(path, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
    try {
      fs.writeSync(file.fd, text);
    } finally {
      fs.closeSync(file);
    }
  }

  private ensureDir(dir: string): void {
    if (this.fileExists(dir)) {
      return;
    }
    try {
      fs.mkdirSync(dir, true);
    } catch (error) {
      if (!this.fileExists(dir)) {
        throw new Error(`创建 v2 时间线目录失败（${dir}）：${this.errorText(error)}`);
      }
    }
  }

  private readText(path: string): string {
    if (!this.fileExists(path)) {
      return '';
    }
    return fs.readTextSync(path);
  }

  private fileExists(path: string): boolean {
    try {
      return fs.accessSync(path);
    } catch {
      return false;
    }
  }

  private pendingCount(outbox: OutboxEntry[]): number {
    return replayable(outbox).length;
  }

  private failedCount(outbox: OutboxEntry[]): number {
    let count = 0;
    for (const entry of outbox) {
      if (entry.state === 'failed') {
        count += 1;
      }
    }
    return count;
  }

  private gateFailure(gate: WriteGateResult, outbox: OutboxEntry[]): CycleResult {
    return {
      ok: false, code: gate.code, message: gate.message,
      days: 0, conflicts: 0, added: 0, dropped: [],
      pending: this.pendingCount(outbox), failed: this.failedCount(outbox), attempts: 0
    };
  }

  private errorText(error: object): string {
    return error instanceof Error ? error.message : String(error);
  }
}

/** 全局单例：与读 / 写服务共用同一份门槛与目录状态。 */
export const syncProtocolStore: SyncProtocolStore = new SyncProtocolStore();
