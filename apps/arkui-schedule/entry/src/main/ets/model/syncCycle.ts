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
import { decideFreshStart } from './freshStart';
import type { FreshStartDecision } from './freshStart';

/**
 * mod-sync-empty-repo-bootstrap：首次同步的远端状态探测（只读，不依赖 fetch 是否成功）。
 *
 * 检测规则（三种状态，互斥且穷尽）：
 * - `hasMain === true`                    → 普通周期：门禁 / ff / union / commit / push 全部不变；
 * - `hasMain === false && isEmpty`        → E_REMOTE_EMPTY 首跑态：远端连一个引用都没有，这是**正常起点**，
 *   引导建 `main`（不是错误、不需要用户确认）；
 * - `hasMain === false && !isEmpty`       → 远端非空但没有 `main`（只有 master 或无关历史）：
 *   **保留 typed 错误，绝不引导覆盖别人的历史**。这一区分是本模块的安全底线。
 *
 * 说明：在空远端上 `git fetch origin main` 会以 "Could not find origin/main" 失败（这是首跑态，不是传输故障），
 * 所以状态探测放在 fetch **之前**。mod-p0a-no-main-probe 起，桥侧用 isomorphic-git 的
 * `listServerRefs` 原始引用数组判空（空数组 = 真正空仓库），不再受 `getRemoteInfo` 嵌套 refs 形状差异影响；
 * 探测抛错是 typed「无法确认远端状态」，绝不 fallthrough 到 clone。非空无 main 只产 typed 文案，
 * 不在本模块创建分支、不克隆、不覆盖任何已有历史。
 */
export interface RemoteLayout {
  /** 服务端是否存在 refs/heads/main。 */
  hasMain: boolean;
  /** 服务端是否完全为空：任何 heads/tags/pull 引用都没有（= 首跑态）。 */
  isEmpty: boolean;
  /** 服务端已有分支名（诊断 / 中文文案用）。 */
  refs: string[];
}

export type RemoteStateDecision = 'normal' | 'bootstrap' | 'no-main';

/** 纯判定：与 git / IO 无关，便于 fake-runner 精确钉住三种状态。 */
export function remoteStateDecision(hasMain: boolean, isEmpty: boolean): RemoteStateDecision {
  if (hasMain) {
    return 'normal';
  }
  return isEmpty ? 'bootstrap' : 'no-main';
}

/** 首跑态的 typed 码与中文文案（状态标记，不作为失败上报）。 */
export const E_REMOTE_EMPTY_CODE: string = 'E_REMOTE_EMPTY';
export const E_REMOTE_EMPTY_MESSAGE: string = '远端仓库为空（首次同步的正常起点），正在初始化 main 时间线';
/**
 * 非空但无 main 的 typed 错误（mod-p0a-no-main-probe）：点名服务端**实际存在的分支**，
 * 不再说「远端仓库为空」——那会把有内容的仓库误报成空仓库。保留 `Could not find origin/main`
 * 作为可诊断的原始错误串（既有断言与日志口径），但不再把 known typed 错包进「未知错误…原始信息」。
 * 不引入新的错误码，避免改变 UI 既有分类（仍归 E_GIT）。
 * 边界：本模块**不创建任何引用 / 不克隆 / 不覆盖历史**；用户只能在远端自行改名分支或换空仓库。
 */
export const E_NO_MAIN_CODE: string = 'E_GIT';

/** 用探测到的分支名构造诚实的 typed 文案（空数组时退化成通用版）。 */
export function noMainMessage(refs: string[]): string {
  const names: string = Array.isArray(refs)
    ? refs.filter((item: string): boolean => typeof item === 'string' && item.length > 0).join('、')
    : '';
  const head: string = names.length > 0
    ? `E_GIT: 远端已有分支：${names}；缺少 main。远端并非空仓库。`
    : 'E_GIT: 远端缺少 main 分支。远端并非空仓库。';
  return head +
    ' 原始错误：Could not find origin/main.' +
    ' 下一步：本应用不会克隆，也不会覆盖任何已有历史；请把远端默认分支改名为 main（或改用空仓库）后重试';
}

export const E_NO_MAIN_MESSAGE: string = noMainMessage([]);
/** 引导提交信息：只建一次，后续周期继续用 [`COMMIT_PREFIX`]。 */
export const BOOTSTRAP_COMMIT_MESSAGE: string = '[v2] bootstrap main';

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
  /** 可选（首跑引导）：服务端引用快照；未注入的旧端口跳过引导、保持原有周期。 */
  remoteLayout?(): Promise<RemoteLayout>;
  /** 可选（首跑引导）：本地工作副本 timeline/** 的相对路径（schema.json + 各日文件）。 */
  localTimelinePaths?(): Promise<string[]>;
  /** 可选（首跑引导 §11）：本地工作副本 timeline/schema.json 原文（缺文件 = 空串）。 */
  localSchemaText?(): Promise<string>;
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
  /** 扩展：本周期是否执行了首跑引导（空远端建 main）；普通周期为 false/absent。 */
  bootstrapped?: boolean;
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
/** 中文下一步：不静默、给可操作动作（页面就绪后自动重试；仍失败则用下拉手势）。 */
export const E_SYNC_UNAVAILABLE_NEXT_STEP: string =
  '下一步：记录已保存在本机，请稍候；页面就绪后会自动重试，若仍未同步请下拉刷新';
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

/**
 * 引导路径的 schema 判定：先用 decideFreshStart 区分「缺标记 = 正常起点」与「标记存在但不可识别」，
 * 再交给与普通周期同一个 assertWritable 产出逐字 typed 码与文案。
 * 空远端没有 HEAD/origin/main 可断言，故用相等占位让祖先维度恒过；分支维度已单独校验。
 */
function bootstrapSchemaGate(schemaText: string, branch: string): WriteGateResult {
  const fresh: FreshStartDecision = decideFreshStart(schemaText);
  const marker = fresh.needSchema ? null : parseSchemaMarker(schemaText);
  return assertWritable({
    schemaVersion: marker !== null && marker.ok ? marker.version : null,
    branch: branch, headSha: '', originMainSha: '',
    headIsAncestorOfOrigin: true, originIsAncestorOfHead: true
  });
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

/** 非空无 main 的 typed 结果：零写入、零提交、意图原样留 outbox（绝不克隆 / 建引用 / 覆盖历史）。 */
function noMainOutcome(outbox: OutboxEntry[], refs?: string[]): CycleOutcome {
  const message: string = refs !== undefined && refs.length > 0 ? noMainMessage(refs) : E_NO_MAIN_MESSAGE;
  return {
    ok: false, code: E_NO_MAIN_CODE, days: EMPTY_DAYS.slice(),
    applied: 0, dropped: 0, failed: countFailed(outbox),
    pending: replayable(outbox).length, message: message,
    conflicts: 0, added: 0, attempts: 0,
    resultOutbox: outbox.slice(), droppedIds: []
  };
}

/** fetch 传输失败的 typed 结果：不静默吞掉网络/认证故障，也不伪装成首跑态。 */
function pullFailureOutcome(text: string, outbox: OutboxEntry[]): CycleOutcome {
  return {
    ok: false, code: 'E_PULL_FAILED', days: EMPTY_DAYS.slice(),
    applied: 0, dropped: 0, failed: countFailed(outbox),
    pending: replayable(outbox).length,
    message: `E_PULL_FAILED: 拉取远端失败（${text}）；下一步：检查网络与仓库地址，稍后会自动重试或下拉刷新`,
    conflicts: 0, added: 0, attempts: 0,
    resultOutbox: outbox.slice(), droppedIds: []
  };
}

/**
 * 探测失败码的保真：底层 typed 码（E_AUTH / E_IO / E_GIT / E_SYNC_UNAVAILABLE）原样透出，
 * 其它传输错误归 E_GIT。E_SYNC_UNAVAILABLE 是 requireService() 的就绪故障，不能被探测 catch 改写成
 * E_GIT（那会给出错误的「检查网络与仓库地址」下一步）。与 typedPushError 不同，
 * 这里绝不产生 E_PUSH_REJECTED —— 探测阶段还没有推送任何字节。
 */
function typedProbeCode(text: string): string {
  const matched: RegExpExecArray | null = /^(E_[A-Z_]+)/.exec(text);
  if (matched !== null &&
      (matched[1] === 'E_AUTH' || matched[1] === 'E_IO' || matched[1] === 'E_GIT' ||
       matched[1] === E_SYNC_UNAVAILABLE_CODE)) {
    return matched[1];
  }
  return 'E_GIT';
}

/** 远端状态探测失败的 typed 结果：零写入、零提交、不 bump attempts（探测阶段没有推送）。 */
function probeFailureOutcome(text: string, outbox: OutboxEntry[]): CycleOutcome {
  const code: string = typedProbeCode(text);
  const message: string = code === E_SYNC_UNAVAILABLE_CODE
    ? `远端状态探测失败；${E_SYNC_UNAVAILABLE_MESSAGE}（${text}）`
    : `${code}: 远端状态探测失败（${text}）；下一步：检查网络与仓库地址，稍后会自动重试或下拉刷新`;
  return {
    ok: false, code: code, days: EMPTY_DAYS.slice(),
    applied: 0, dropped: 0, failed: countFailed(outbox),
    pending: replayable(outbox).length,
    message: message,
    conflicts: 0, added: 0, attempts: 0,
    resultOutbox: outbox.slice(), droppedIds: []
  };
}

/**
 * 单日读取端口：`remote=false` 时只读本地工作副本，不碰 origin/main。
 * mod-empty-remote-unborn-head：空远端尚未建立 origin/main 跟踪引用，
 * `showMain`/`readBlob` 会在 `resolveRef('origin/main')` 抛 NotFound；引导阶段必须走 local-only。
 */
export type DayReader = (date: string, remote?: boolean) => Promise<DayRead>;

/**
 * 首跑引导（E_REMOTE_EMPTY 状态）：为**完全为空**的远端建第一个 main 提交。
 *
 * 门禁例外说明（唯一一处）：§11 门禁要求 `HEAD == origin/main`，但空远端上 origin/main 根本不存在，
 * 无法断言；此处只验证「分支是 main + 远端确认为空」，随即 push 建 main 并 fetch 建立跟踪引用，
 * 再回到普通周期过完整门禁。非空无 main 的远端**不进本函数**（由 noMainOutcome 拒绝）。
 *
 * 幂等：只有 `remoteStateDecision(...) === 'bootstrap'` 才会调用本函数；main 一旦存在即走普通路径，
 * 所以第二次运行不会再建根提交。引导内部 commit 走既有 addPaths/commit（桥侧 nothing-to-commit 为 no-op），
 * 推送失败时下一次重跑会对同一棵树重试，不会堆叠重复根提交。
 */
async function bootstrapEmptyRemote(
  port: GitPort,
  days: string[],
  readDay: DayReader,
  outbox: OutboxEntry[],
  now: Date,
  write?: WritePort
): Promise<CycleOutcome> {
  const branch: string = (await port.branchName()).trim();
  if (branch !== 'main') {
    return gateFailure({ ok: false, code: 'E_BRANCH_MISMATCH', message: '分支不是 main，拒绝写入' }, outbox);
  }

  // §11 门禁：任何 timeline 目录文件的写句柄之前必须先读仓库级 schema.json。
  // 用 decideFreshStart 区分「缺标记 = 空仓库正常起点」与「标记存在但不可识别 = E_SCHEMA_UNKNOWN」；
  // 标记缺失且有 WritePort 时放行到阶段 1 —— 生产 writer 就是 syncProtocolStore.writeDay，
  // 它在写任何 timeline 文件前调用 timelineWriteStore.ensureSkeleton() 幂等建 v2 骨架
  // （纯模型自己不建，零新增 IO）；阶段 1 之后必须重读复核（见下），否则绝不 addPaths/commit。
  // 端口未实现 localSchemaText、读取抛错，或纯预览没有 WritePort（没人能建骨架）时一律 fail-closed。
  // 生产 runner 总是与 localTimelinePaths 一起提供这两个方法。
  let schemaText: string = '';
  let schemaReadable: boolean = false;
  if (port.localSchemaText !== undefined) {
    try {
      schemaText = await port.localSchemaText();
      schemaReadable = true;
    } catch (error) {
      schemaReadable = false;
    }
  }
  const fresh: FreshStartDecision = decideFreshStart(schemaText);
  if (!schemaReadable || (fresh.needSchema && write === undefined) || fresh.unsupported) {
    return gateFailure(bootstrapSchemaGate(schemaText, branch), outbox);
  }
  if (!fresh.needSchema) {
    const schemaGate: WriteGateResult = bootstrapSchemaGate(schemaText, branch);
    if (!schemaGate.ok) {
      return gateFailure(schemaGate, outbox);
    }
  }
  const needsPostWriteCheck: boolean = fresh.needSchema;

  // 阶段 1：远端为空 → 无并发冲突可能。用既有 unionDay + WritePort 把本地记录与 outbox 意图落盘，
  // 这些字节随后一起进入初始提交（「via existing writer/commit path」）。
  // mod-empty-remote-unborn-head：这里**绝不能**读 origin/main —— 空远端没有该引用，
  // showMain/readBlob 的 resolveRef 会抛「Could not find origin/main」并在写/commit 之前逃逸，
  // 使引导虽然已被选中却永远落不了地。远端文本按空串处理（union 的 remote 侧本就是空）。
  const derived: string[] = [];
  for (const date of days) {
    const read: DayRead = await readDay(date, false);
    const corrupt: string = dayIntegrityError(date, read.remote, read.local);
    if (corrupt.length > 0) {
      await persistOutbox(write, outbox);
      return corruptOutcome(corrupt, outbox);
    }
    const emptyRemoteTexts: DayTexts = { records: '', deleted: '', restore: '' };
    const localTexts: DayTexts = { records: read.local, deleted: read.deleted, restore: read.restore };
    const union: DayUnion = unionDay(date, emptyRemoteTexts, localTexts, entriesForDate(outbox, date), now);
    if (write !== undefined) {
      await write.writeDay(date, {
        records: union.text, deleted: union.deleted,
        restore: union.restored, conflicts: union.conflicts
      });
    }
    // 回退枚举必须与 WritePort 实际写下的文件集合一致：有 WritePort 时 records/deleted/restore
    // 三个文件每轮都写（内容可能为空），conflicts 仅在有审计行时写；无 WritePort（纯预览）没有写句柄，
    // 才退回按非空内容推断。否则初始提交树会与工作副本不一致。
    const written: string[] = [];
    if (write !== undefined) {
      written.push(`timeline/${date}/records.json`);
      written.push(`timeline/${date}/deleted.jsonl`);
      written.push(`timeline/${date}/restore.jsonl`);
    } else {
      if (union.text.length > 0) {
        written.push(`timeline/${date}/records.json`);
      }
      if (union.deleted.length > 0) {
        written.push(`timeline/${date}/deleted.jsonl`);
      }
      if (union.restored.length > 0) {
        written.push(`timeline/${date}/restore.jsonl`);
      }
    }
    if (union.conflicts.length > 0) {
      written.push(`timeline/${date}/conflicts.jsonl`);
    }
    for (const path of written) {
      if (derived.indexOf(path) < 0) {
        derived.push(path);
      }
    }
  }

  // 兜底复核：阶段 1 之前标记缺失时，writer 本应建好 v2 骨架；这里重读并再过一次同一个门禁。
  // 仍然缺失 / 不可识别 / 版本不是 2 → 零 addPaths、零 commit、零 push，绝不提交无标记的树。
  if (needsPostWriteCheck) {
    let afterText: string = '';
    if (port.localSchemaText !== undefined) {
      try {
        afterText = await port.localSchemaText();
      } catch (error) {
        afterText = '';
      }
    }
    const afterGate: WriteGateResult = bootstrapSchemaGate(afterText, branch);
    if (!afterGate.ok) {
      return gateFailure(afterGate, outbox);
    }
  }

  // 阶段 2：初始提交树 = schema.json + 本地全量 timeline 文件；端口未枚举时回退到本次派生日文件。
  let paths: string[] = [];
  if (port.localTimelinePaths !== undefined) {
    paths = await port.localTimelinePaths();
  } else {
    paths = derived.slice();
  }
  if (paths.indexOf('timeline/schema.json') < 0) {
    paths = ['timeline/schema.json'].concat(paths);
  }

  // 阶段 3：commit + push（无 force / 无 reset / 不改写历史）。失败即 typed 错误 + outbox 停放，
  // 绝不把「本地已提交但没推成功」的中间态报成成功。
  try {
    await port.addPaths(paths);
    await port.commit(BOOTSTRAP_COMMIT_MESSAGE);
    await port.pushMain();
  } catch (error) {
    const text: string = error instanceof Error ? error.message : String(error);
    const typed: TypedPushError = typedPushError(text);
    const parked: OutboxEntry[] = bumpAttempts(outbox, text);
    await persistOutbox(write, parked);
    return {
      ok: false, code: typed.code, days: EMPTY_DAYS.slice(),
      applied: 0, dropped: 0, failed: countFailed(parked),
      pending: replayable(parked).length,
      message: `首次初始化 main 推送失败；${typed.message}（${text}）`,
      conflicts: 0, added: 0, attempts: 1,
      resultOutbox: parked, droppedIds: [], bootstrapped: true
    };
  }

  // 阶段 4：fetch 建立 origin/main 跟踪引用（本项目的 upstream 语义 = refs/remotes/origin/main）。
  await port.fetchMain();

  // 阶段 5：回到普通周期过完整门禁。意图已落在初始提交里，union 幂等判定把它们出队，用户看到「已同步」。
  const resumed: CycleOutcome = await runCyclePure(port, days, readDay, outbox, now, write, true);
  resumed.bootstrapped = true;
  return resumed;
}

/**
 * 单一同步周期（纯决策）。详见文件头；write 缺省时只产出决策（预览），
 * 生产调用（syncProtocolStore）必须注入 WritePort，否则 union 文本不会落盘。
 * `skipBootstrapProbe` 只由首跑引导的「继续普通周期」内部使用，防止递归回引导。
 */
export async function runCyclePure(
  port: GitPort,
  days: string[],
  readDay: DayReader,
  outbox: OutboxEntry[],
  now: Date,
  write?: WritePort,
  skipBootstrapProbe?: boolean
): Promise<CycleOutcome> {
  // 步骤 0（可选）：远端引用探测在 fetch 之前 —— 空远端的 `fetch origin main` 会直接抛
  // "Could not find origin/main"，那是首跑态而非传输故障，必须先分流。未注入该端口的调用保持原行为。
  if (skipBootstrapProbe !== true && port.remoteLayout !== undefined) {
    let layout: RemoteLayout;
    try {
      layout = await port.remoteLayout();
    } catch (error) {
      // 首调用的认证/传输故障必须和 fetch 失败一样进入 typed 三态结果，不能逃逸成未捕获 rejection。
      // 异常一律不映射成 isEmpty=true —— fail-closed：探测不到远端状态就绝不引导写历史。
      const text: string = error instanceof Error ? error.message : String(error);
      await persistOutbox(write, outbox);
      return probeFailureOutcome(text, outbox);
    }
    const decision: RemoteStateDecision = remoteStateDecision(layout.hasMain, layout.isEmpty);
    if (decision === 'bootstrap') {
      return await bootstrapEmptyRemote(port, days, readDay, outbox, now, write);
    }
    if (decision === 'no-main') {
      // 把服务端实际分支名带进用户可见文案；这里只产出 typed 结果，不做任何 git 写入。
      return noMainOutcome(outbox, layout.refs);
    }
  }
  // 步骤 1：fetch（只读）→ 步骤 2：§11 门禁（以 freshly fetched origin/main 计算祖先关系）。
  try {
    await port.fetchMain();
  } catch (error) {
    const text: string = error instanceof Error ? error.message : String(error);
    await persistOutbox(write, outbox);
    return pullFailureOutcome(text, outbox);
  }
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
    // 普通周期在 fetch 之后运行，origin/main 已存在，这里必须读远端（remote=true 缺省）。
    for (const date of days) {
      const read: DayRead = await readDay(date, true);
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
