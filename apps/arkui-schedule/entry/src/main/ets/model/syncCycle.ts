/**
 * v2 同步周期的纯决策层（mod-v2-sync-wiring）：只依赖注入的 GitPort / WritePort，
 * 不 import 任何 @kit.*，不碰文件句柄、不读 AppStorage、不读墙钟（now 由调用方注入）。
 *
 * 与 services/syncProtocolStore.ets 的分工：
 * - 本文件负责**周期决策**：门禁 → fetch → union（复用 syncProtocol.unionDay）→ 落盘意图 →
 *   commit `[v2] sync <n> days` → push；push 被拒 → resetHardOrigin → 重放意图 → 重试
 *   ≤ MAX_ATTEMPTS（4）；dropped 意图在推送前出队、不 bump；返回 tri-state 计数。
 * - 服务负责**具体 IO**：GitPort 由 services/gitRunner.ets 绑定到应用的 isomorphic-git 桥，
 *   WritePort 由服务用既有原子写助手实现；outbox 文件读写仍在服务里（仓库之外）。
 *
 * 三条硬禁令（与契约 §9 / §11 一致）：
 * 1. 绝不 force-push：只有 pushMain()，push 失败只能 resetHardOrigin() 后重来；
 * 2. 绝不改写历史：唯一的快进是 fastForward()（→ `git merge --ff-only`），无 rebase / amend / clean；
 * 3. 绝不删除远端文件：commit 路径只来自 timeline/** 的日文件与账本，无 rm / 清理。
 *
 * GitPort 的方法均为 Promise（真实 git 绑定必须异步）；相对任务草图的同步签名，这是把
 * 「IO 在端口内、决策在本文件」落地的必要调整，fake runner 用内存状态即可满足。
 */
import {
  assertWritable, unionDay, replayable, outboxAfterReplay, markAttempt,
  MAX_ATTEMPTS, SYNC_RETRY_ERROR
} from './syncProtocol';
import type { OutboxEntry, WriteGateResult, DayTexts, DayUnion } from './syncProtocol';
import { parseSchemaMarker, parseTimelineDay } from './timeline';

/** 单日读取输入：远端/本地 records.json 与本地两本账本；远端账本可显式给出，否则用 showMain 取。 */
export interface DayRead {
  /** origin/main:timeline/<date>/records.json 的原文（缺文件 = 空串）。 */
  remote: string;
  /** 工作区 timeline/<date>/records.json 的原文（缺文件 = 空串）。 */
  local: string;
  /** 工作区 timeline/<date>/deleted.jsonl 的原文（并集的 local 前缀）。 */
  deleted: string;
  /** 工作区 timeline/<date>/restore.jsonl 的原文（并集的 local 前缀）。 */
  restore: string;
  /** 可选：远端删除账本原文；缺省时由 showMain 读取。 */
  remoteDeleted?: string;
  /** 可选：远端撤销账本原文；缺省时由 showMain 读取。 */
  remoteRestore?: string;
}

/** 单日写回输出（由 WritePort 落到工作副本；本文件不碰 fs）。 */
export interface DayWriteTexts {
  records: string;
  deleted: string;
  restore: string;
  conflicts: string[];
}

/** 写端口：把 union 结果原子写进工作副本（由 syncProtocolStore 实现）。 */
export interface WritePort {
  writeDay(date: string, texts: DayWriteTexts): Promise<void>;
  /**
   * P1-3：每次推送尝试的 attempts/state 变化都要**当场**原子落盘（仓库之外的 outbox）。
   * 可选只为保持旧预览调用（write 缺省）可用；生产接线必须实现，否则崩溃会重置预算。
   */
  writeOutbox?(entries: OutboxEntry[]): Promise<void>;
}

/**
 * git 端口：syncProtocolStore 通过 setRunner() 注入，默认没有实现即拒绝接线。
 * 前 8 个方法是任务指定的最小集；后三个为 §11 门禁与 behind 快进所必需。
 */
export interface GitPort {
  fetchMain(): Promise<void>;
  headSha(): Promise<string>;
  originMainSha(): Promise<string>;
  showMain(path: string): Promise<string>;
  addPaths(paths: string[]): Promise<void>;
  commit(message: string): Promise<void>;
  pushMain(): Promise<void>;
  resetHardOrigin(): Promise<void>;
  /** 当前分支名（§11 必须是 main）。 */
  branchName(): Promise<string>;
  /** HEAD 与 origin/main 的祖先关系：equal | behind | ahead | diverged。 */
  headRelation(): Promise<string>;
  /** 仅 behind 调用：快进到 origin/main（绝不 rebase / merge 非 ff-only）。 */
  fastForward(): Promise<void>;
  /** 可选：远端有 records.json 的日目录；服务用它合并出周期覆盖的 days。 */
  listRemoteDays?(): Promise<string[]>;
}

/** 周期结果：前 8 个字段是任务指定的 tri-state 契约，其余为出队/审计所需的扩展。 */
export interface CycleOutcome {
  ok: boolean;
  code: string;
  /** 真正提交并推送成功的日期（门禁失败 / 耗尽时为空）。 */
  days: string[];
  /** 已幂等应用或 §4 裁决视为已应用的意图条数。 */
  applied: number;
  /** 因删除账本 / 形状非法而有意放弃并出队的意图条数。 */
  dropped: number;
  /** 达到 MAX_ATTEMPTS 后停在 failed 终态的意图条数。 */
  failed: number;
  /** 仍在 outbox 可重放的意图条数（tri-state 的「N 条待同步」）。 */
  pending: number;
  message: string;
  /** 扩展：新增冲突审计行 / 新增规范记录行 / 本周期实际尝试次数。 */
  conflicts: number;
  added: number;
  attempts: number;
  /** 扩展：出队后的 outbox（调用方据此原子落盘）。 */
  resultOutbox: OutboxEntry[];
  /** 扩展：dropped 的 intentId（驱动「该记录已被删除，编辑未同步」提示）。 */
  droppedIds: string[];
}

const COMMIT_PREFIX: string = '[v2] sync ';
const EMPTY_DAYS: string[] = [];

/** P1-4：坏远端/本地日文件的 typed 码与逐字中文原因（§9 阶段 1：整日不动、意图留 outbox）。 */
export const E_CORRUPT_CODE: string = 'E_CORRUPT';
export const E_CORRUPT_MESSAGE: string =
  'E_CORRUPT: 远端或本地 records.json 无法解析，或 date 字段与目录名不符，整日不动、意图留在 outbox';

/** E_SYNC_UNAVAILABLE：GitRunner 未绑定 / 同步内核未就绪的 typed 码、原因与可执行下一步。 */
export const E_SYNC_UNAVAILABLE_CODE: string = 'E_SYNC_UNAVAILABLE';
export const E_SYNC_UNAVAILABLE_REASON: string = '同步内核或 GitRunner 未就绪';
/** 中文下一步：不静默、给可操作动作（页面就绪后自动重试；仍失败则手动重试）。 */
export const E_SYNC_UNAVAILABLE_NEXT_STEP: string =
  '下一步：记录已保存在本机，请稍候；页面就绪后会自动重试，若仍未同步请下拉刷新或点状态行「重试同步」';
/** 面向用户的完整 typed 文案（code + 原因 + 下一步），状态行原样显示。 */
export const E_SYNC_UNAVAILABLE_MESSAGE: string =
  `${E_SYNC_UNAVAILABLE_CODE}: ${E_SYNC_UNAVAILABLE_REASON}；${E_SYNC_UNAVAILABLE_NEXT_STEP}`;

/**
 * 阶段 1 前置校验：任一侧非空 records.json 不可解析（day===null）或 `date` 与目录名不符
 * → 返回 typed 中文原因；空串表示可继续 union。缺文件（空文本）= 合法空日，不在此报错。
 */
export function dayIntegrityError(date: string, remote: string, local: string): string {
  const sides: string[] = [remote, local];
  for (const text of sides) {
    if (typeof text !== 'string' || text.trim().length === 0) {
      continue;
    }
    const parsed = parseTimelineDay(text, date);
    if (parsed.day === null) {
      return `${E_CORRUPT_MESSAGE}（${date}：records.json 顶层不是合法 JSON 对象）`;
    }
    for (const error of parsed.errors) {
      // 只把「结构损坏」升级为 E_CORRUPT；其它解析告警（重复 id 等）仍按 §4 裁决。
      if (error.message.indexOf('与目录日期') >= 0 ||
          error.message.indexOf('records.json 顶层不是合法 JSON 对象') >= 0) {
        return `${E_CORRUPT_MESSAGE}（${date}：${error.message}）`;
      }
    }
  }
  return '';
}

/** E_CORRUPT 结果：零写入、零提交、意图原样留 outbox（调用方据此原子落盘现状）。 */
function corruptOutcome(reason: string, outbox: OutboxEntry[]): CycleOutcome {
  return {
    ok: false, code: E_CORRUPT_CODE, days: EMPTY_DAYS.slice(),
    applied: 0, dropped: 0, failed: countFailed(outbox),
    pending: replayable(outbox).length, message: reason,
    conflicts: 0, added: 0, attempts: 0,
    resultOutbox: outbox.slice(), droppedIds: []
  };
}

/**
 * 首轮周期可能早于隐藏 WebView 的 onPageEnd（GitSyncService 尚未构造/注册代理）。
 * 此时不立刻失败，而是做**有界等待**；纯判定便于 fake-runner 测试钉住「等待→就绪 / 等待→typed 失败」。
 */
export type RunnerReadyDecision = 'ready' | 'wait' | 'unavailable';

export function runnerReadyDecision(ready: boolean, waitedMs: number, timeoutMs: number): RunnerReadyDecision {
  if (ready) {
    return 'ready';
  }
  if (waitedMs >= timeoutMs) {
    return 'unavailable';
  }
  return 'wait';
}

/** 未就绪的 typed 结果：零写入、零提交、意图原样留 outbox（可点状态行重试，绝不静默成功）。 */
export function unavailableOutcome(outbox: OutboxEntry[]): CycleOutcome {
  return {
    ok: false, code: E_SYNC_UNAVAILABLE_CODE, days: EMPTY_DAYS.slice(),
    applied: 0, dropped: 0, failed: countFailed(outbox),
    pending: replayable(outbox).length, message: E_SYNC_UNAVAILABLE_MESSAGE,
    conflicts: 0, added: 0, attempts: 0,
    resultOutbox: outbox.slice(), droppedIds: []
  };
}

/** push 失败的可诊断结果：code 用于分类、message 给用户、lastError 原样留存细节。 */
interface TypedPushError {
  code: string;
  message: string;
  lastError: string;
}

/**
 * push 失败类型的保真（cheap extra）：`E_AUTH` / `E_IO` 等原始 typed 原因不再被
 * 一律收窄成 E_PUSH_REJECTED；`E_PUSH_REJECTED` 带附加细节（码后仍有非空文本，
 * 如 `E_PUSH_REJECTED: rival advanced first (non-fast-forward)`）时逐字保留原文，
 * 让非快进等真实原因既进入用户可见 message，也进入 lastError；
 * 只有裸码（或普通传输错误）才折叠成通用中文下一步文案（兼容既有断言）。
 */
function typedPushError(text: string): TypedPushError {
  const matched: RegExpExecArray | null = /^(E_[A-Z_]+)/.exec(text);
  if (matched !== null && matched[1] !== 'E_PUSH_REJECTED') {
    // E_AUTH / E_IO 等：typed 码 + 原文细节均保留，行为不变。
    return { code: matched[1], message: `${SYNC_RETRY_ERROR}（${text}）`, lastError: text };
  }
  // E_PUSH_REJECTED 且码后还有细节：逐字保真，不再塌缩成通用文案。
  if (matched !== null && text.slice(matched[1].length).trim().length > 0) {
    return { code: 'E_PUSH_REJECTED', message: `${SYNC_RETRY_ERROR}（${text}）`, lastError: text };
  }
  // 裸 E_PUSH_REJECTED / 非 E_ 传输错误：通用中文原因 + 下一步，行为不变。
  return { code: 'E_PUSH_REJECTED', message: SYNC_RETRY_ERROR, lastError: text };
}

/** 把当前 outbox 立刻原子落盘（P1-3：崩溃不重置跨会话预算）。 */
async function persistOutbox(write: WritePort | undefined, entries: OutboxEntry[]): Promise<void> {
  if (write !== undefined && write.writeOutbox !== undefined) {
    await write.writeOutbox(entries);
  }
}

/** 拼接去重（保持首次出现顺序）：跨重放的 applied/dropped 只计一次。 */
function pushUnique(target: string[], incoming: string[]): void {
  for (const id of incoming) {
    if (target.indexOf(id) < 0) {
      target.push(id);
    }
  }
}

/** 本日起叉的意图（FIFO，保持 outbox 顺序）。 */
function entriesForDate(outbox: OutboxEntry[], date: string): OutboxEntry[] {
  const out: OutboxEntry[] = [];
  for (const entry of outbox) {
    if (entry.date === date && replayable([entry]).length > 0) {
      out.push(entry);
    }
  }
  return out;
}

/** 尝试次数 +1（跨会话累计；failed 终态不动）；把原始 push 失败原因写进 lastError。 */
function bumpAttempts(outbox: OutboxEntry[], error: string): OutboxEntry[] {
  const out: OutboxEntry[] = [];
  for (const entry of outbox) {
    if (entry.state === 'pending' || entry.state === 'syncing') {
      out.push(markAttempt(entry, error));
    } else {
      out.push(entry);
    }
  }
  return out;
}

function countFailed(outbox: OutboxEntry[]): number {
  let count = 0;
  for (const entry of outbox) {
    if (entry.state === 'failed') {
      count += 1;
    }
  }
  return count;
}

/** dropped 意图立即出队（参与 outboxAfterReplay 的 droppedIds 口径，不计 attempts）。 */
function dequeueIds(outbox: OutboxEntry[], ids: string[]): OutboxEntry[] {
  const dropped = new Set<string>(ids);
  if (dropped.size === 0) {
    return outbox;
  }
  const out: OutboxEntry[] = [];
  for (const entry of outbox) {
    if (!dropped.has(entry.intentId)) {
      out.push(entry);
    }
  }
  return out;
}

/** §11 唯一门禁：schema=2 + 分支 main + HEAD 是 origin/main 或其祖先。 */
async function gateOf(port: GitPort): Promise<WriteGateResult> {
  const marker = parseSchemaMarker(await port.showMain('timeline/schema.json'));
  const head: string = (await port.headSha()).trim();
  const origin: string = (await port.originMainSha()).trim();
  const relation: string = await port.headRelation();
  const input = {
    schemaVersion: marker.ok ? marker.version : null,
    branch: (await port.branchName()).trim(),
    headSha: head,
    originMainSha: origin,
    headIsAncestorOfOrigin: relation === 'equal' || relation === 'behind',
    originIsAncestorOfHead: relation === 'equal' || relation === 'ahead'
  };
  return assertWritable(input);
}

/** 门禁失败：零写入、零 git 提交，返回 typed 原因与 outbox 现状。 */
function gateFailure(gate: WriteGateResult, outbox: OutboxEntry[]): CycleOutcome {
  return {
    ok: false, code: gate.code, days: EMPTY_DAYS.slice(),
    applied: 0, dropped: 0, failed: countFailed(outbox),
    pending: replayable(outbox).length, message: gate.message,
    conflicts: 0, added: 0, attempts: 0,
    resultOutbox: outbox.slice(), droppedIds: []
  };
}

/**
 * 单一同步周期（纯决策）。详见文件头；write 缺省时只产出决策（预览），
 * 生产调用（syncProtocolStore）必须注入 WritePort，否则 union 文本不会落盘。
 */
export async function runCyclePure(
  port: GitPort,
  days: string[],
  readDay: (date: string) => Promise<DayRead>,
  outbox: OutboxEntry[],
  now: Date,
  write?: WritePort
): Promise<CycleOutcome> {
  // 步骤 1：fetch（只读）→ 步骤 2：§11 门禁（以 freshly fetched origin/main 计算祖先关系）。
  await port.fetchMain();
  let gate: WriteGateResult = await gateOf(port);
  if (!gate.ok) {
    return gateFailure(gate, outbox);
  }
  // 步骤 3：behind（HEAD 是 origin/main 的祖先）→ 快进；失败在端口层抛错，此处 typed 返回。
  const relation: string = await port.headRelation();
  if (relation === 'behind') {
    try {
      await port.fastForward();
    } catch (error) {
      const message: string = error instanceof Error ? error.message : String(error);
      return gateFailure({ ok: false, code: 'E_NOT_SYNCED', message: message }, outbox);
    }
    gate = await gateOf(port);
    if (!gate.ok) {
      return gateFailure(gate, outbox);
    }
  }
  // ahead / diverged 已在 gateOf 里被 assertWritable 拒绝（E_NOT_SYNCED）。

  let current: OutboxEntry[] = outbox.slice();
  let attempts: number = 0;
  /** 最近一次 push 的原始错误文本（typed 码 / 文案保真用，见 typedPushError）。 */
  let lastPushError: string = '';
  const allApplied: string[] = [];
  const allDropped: string[] = [];
  let conflicts: number = 0;
  let added: number = 0;
  let daysCommitted: string[] = EMPTY_DAYS.slice();

  for (;;) {
    attempts += 1;
    const attemptApplied: string[] = [];
    const attemptDropped: string[] = [];
    const changedPaths: string[] = [];
    let touchedDays: number = 0;
    let attemptConflicts: number = 0;
    let attemptAdded: number = 0;

    // 步骤 4：逐日 union（阶段一）+ 意图重放（阶段二，复用 syncProtocol.unionDay）。
    for (const date of days) {
      const read: DayRead = await readDay(date);
      // P1-4：union 前先查两侧文件完整性；坏文件绝不「当作空日」被本地覆盖。
      const corrupt: string = dayIntegrityError(date, read.remote, read.local);
      if (corrupt.length > 0) {
        await persistOutbox(write, current);
        return corruptOutcome(corrupt, current);
      }
      const remoteDeleted: string = read.remoteDeleted !== undefined
        ? read.remoteDeleted
        : await port.showMain(`timeline/${date}/deleted.jsonl`);
      const remoteRestore: string = read.remoteRestore !== undefined
        ? read.remoteRestore
        : await port.showMain(`timeline/${date}/restore.jsonl`);
      const remoteTexts: DayTexts = {
        records: read.remote, deleted: remoteDeleted, restore: remoteRestore
      };
      const localTexts: DayTexts = {
        records: read.local, deleted: read.deleted, restore: read.restore
      };
      const replayEntries: OutboxEntry[] = entriesForDate(current, date);
      // P1-3(a) cheap extra：每条意图重放前都重新过一次唯一门禁（不是每轮只看一次）。
      // 门禁失败即零写入、意图留 outbox；fetch 已在前，这里只读 HEAD/origin 事实。
      for (let i = 0; i < replayEntries.length; i += 1) {
        const preGate: WriteGateResult = await gateOf(port);
        if (!preGate.ok) {
          await persistOutbox(write, current);
          return gateFailure(preGate, current);
        }
      }
      const union: DayUnion = unionDay(date, remoteTexts, localTexts, replayEntries, now);

      if (write !== undefined) {
        await write.writeDay(date, {
          records: union.text, deleted: union.deleted,
          restore: union.restored, conflicts: union.conflicts
        });
      }
      let changed: boolean = false;
      if (union.text.length > 0 && union.text !== read.local) {
        changedPaths.push(`timeline/${date}/records.json`);
        changed = true;
      }
      if (union.deleted !== read.deleted) {
        changedPaths.push(`timeline/${date}/deleted.jsonl`);
        changed = true;
      }
      if (union.restored !== read.restore) {
        changedPaths.push(`timeline/${date}/restore.jsonl`);
        changed = true;
      }
      if (union.conflicts.length > 0) {
        changedPaths.push(`timeline/${date}/conflicts.jsonl`);
        changed = true;
      }
      if (changed) {
        touchedDays += 1;
      }
      pushUnique(attemptApplied, union.applied);
      pushUnique(attemptDropped, union.dropped);
      attemptConflicts += union.conflicts.length;
      attemptAdded += union.added;
    }

    // F3：dropped 与推送成败无关，进入推送循环前就出队（绝不 bump，绝不误报 E_PUSH_REJECTED）。
    pushUnique(allDropped, attemptDropped);
    current = dequeueIds(current, allDropped);

    // 步骤 5：只 add 受影响日 → commit `[v2] sync <n> days`。
    if (changedPaths.length > 0) {
      await port.addPaths(changedPaths);
      await port.commit(`${COMMIT_PREFIX}${touchedDays} days`);
    }

    // 步骤 6：push origin main；被拒 → 唯一 reset 路径 → 重放 → 重来（≤ MAX_ATTEMPTS）。
    try {
      await port.pushMain();
      pushUnique(allApplied, attemptApplied);
      daysCommitted = days.slice();
      conflicts = attemptConflicts;
      added = attemptAdded;
      current = outboxAfterReplay(current, allApplied, [], allDropped, now);
      await persistOutbox(write, current);
      return {
        ok: true, code: 'ok', days: daysCommitted,
        applied: allApplied.length, dropped: allDropped.length,
        failed: countFailed(current), pending: replayable(current).length,
        message: '已同步', conflicts: conflicts, added: added,
        attempts: attempts, resultOutbox: current, droppedIds: allDropped.slice()
      };
    } catch (error) {
      // 保真原始 push 错误（E_AUTH / E_IO / 拒推文案），不再一律塌缩成 E_PUSH_REJECTED。
      lastPushError = error instanceof Error ? error.message : String(error);
      // 本地真值在仓库外 outbox，reset 不丢数据；绝不 force-push / 改写远端历史。
      await port.resetHardOrigin();
      if (attempts >= MAX_ATTEMPTS) {
        break;
      }
      // 重放前置：reset 后重新过门禁（schema 可能已被远端改掉）。
      const recheck: WriteGateResult = await gateOf(port);
      if (!recheck.ok) {
        await persistOutbox(write, current);
        return gateFailure(recheck, current);
      }
      // P1-3：跨会话累计 attempts —— 每次失败尝试后立刻 +1 并**在 rejection path 内**落盘；
      // 崩溃发生在下一次推送前也不会把预算重置为 0（不是周期末尾才写一次）。
      current = bumpAttempts(current, lastPushError);
      await persistOutbox(write, current);
    }
  }

  // 预算耗尽：failed 终态留在 outbox，停自动重放，只等用户点「重试」。
  const failedIds: string[] = [];
  for (const entry of replayable(current)) {
    failedIds.push(entry.intentId);
  }
  const typed: TypedPushError = typedPushError(lastPushError);
  // lastError 用原文（含码 + 细节），message 才带中文下一步；二者都保真原始拒推原因。
  current = outboxAfterReplay(current, [], failedIds, allDropped, now, typed.lastError);
  // 终态（failed）也当场落盘；调用方末尾的兜底写入只是幂等冗余。
  await persistOutbox(write, current);
  return {
    ok: false, code: typed.code, days: EMPTY_DAYS.slice(),
    applied: allApplied.length, dropped: allDropped.length,
    failed: countFailed(current), pending: replayable(current).length,
    message: typed.message, conflicts: conflicts, added: added,
    attempts: attempts, resultOutbox: current, droppedIds: allDropped.slice()
  };
}
