/**
 * 仓库可见性门禁的状态机（mod-repo-privacy-gate，纯逻辑 / 零 IO）。
 *
 * 三条硬语义：
 * 1. **60 s 去重窗口**：两次推送尝试在 60 s 内只发一次真实 API 调用；过了窗口才再查一次。
 *    例外（mod-sync-silence-phase-b）：阻塞态强制实时复核，绕过窗口；没有「本会话只查一次」、
 *    没有 24 h 缓存。
 * 2. **sticky**：public / unknown 等任何非私有判定一直挡着；时间流逝不会自动解挡，
 *    后续「成功周期」也不会解挡 —— 只有一次**通过的实时校验**才清掉（且清挡不写同步成功）。
 * 3. **本地优先**：门禁只决定「能不能推」，从不拦本地写入 / outbox 停放。
 */
import { REPO_VISIBILITY_OK, decisionForRepoCode } from './repoVisibility';
import type { RepoVisibilityDecision } from './repoVisibility';

/** 去重窗口（毫秒）：恰好 60 s。 */
export const REPO_VISIBILITY_DEDUPE_MS: number = 60000;

/** 最近一次实时判定的归纳：`none` = 还没查过，`private` = 通过，`blocked` = 任何拒绝。 */
export type RepoVisibilityVerdict = 'none' | 'private' | 'blocked';

/** 内存里的门禁状态（进程级，不落盘：重启后第一次推送重新实时查）。 */
export interface RepoVisibilityGateState {
  /** 最近一次实时校验时刻（epoch ms；0 = 从未查过）。 */
  lastCheckAtMs: number;
  verdict: RepoVisibilityVerdict;
  /** 最近一次判定的 typed 码。 */
  code: string;
  blocked: boolean;
  /** sticky 拒绝的 typed 码（去重窗口内复用它的逐字文案）。 */
  blockedCode: string;
  /** 最近一次**尝试**时刻（epoch ms），供状态行显示「最近尝试 HH:MM」。 */
  blockedAtMs: number;
  /** 实时校验次数（测试用来证明 60 s 去重：两次推送只增 1）。 */
  checkCount: number;
}

/** 初始状态。 */
export function initialRepoVisibilityGate(): RepoVisibilityGateState {
  const state: RepoVisibilityGateState = {
    lastCheckAtMs: 0, verdict: 'none', code: '', blocked: false,
    blockedCode: '', blockedAtMs: 0, checkCount: 0
  };
  return state;
}

/**
 * 是否要发一次真实校验。
 * - `force=true`（保存设置 / 测试连接）：永远实时查，不受去重窗口影响；
 * - **阻塞态强制实时复核**（mod-sync-silence-phase-b）：`state.blocked=true` 时绕过 60 s 去重，
 *   让下一个自动周期在仓库重新变为私有后立刻解挡，不被窗口卡住；
 * - 其余推送路径：从未查过，或距上次校验 ≥ 60 s 才查；窗口内复用上次判定。
 *
 * sticky 语义不变：强制复核**不自动解挡**，只有复核结果 `ok=true` 才由调用方清阻塞；
 * 复核仍失败则维持原阻塞（并刷新最近尝试时刻）。
 */
export function shouldRunRepoVisibilityCheck(
  state: RepoVisibilityGateState,
  nowMs: number,
  force: boolean
): boolean {
  if (force || state.blocked || state.lastCheckAtMs === 0) {
    return true;
  }
  const elapsed: number = Math.max(0, nowMs - state.lastCheckAtMs);
  return elapsed >= REPO_VISIBILITY_DEDUPE_MS;
}

/**
 * 应用一次实时判定：只有 `decision.ok === true` 才清挡；任何拒绝都（重新）挡上并记时刻。
 * 返回新对象，不改入参（便于测试断言 sticky 不会被时间/成功周期悄悄抹掉）。
 */
export function applyRepoVisibilityDecision(
  state: RepoVisibilityGateState,
  decision: RepoVisibilityDecision,
  nowMs: number
): RepoVisibilityGateState {
  const next: RepoVisibilityGateState = {
    lastCheckAtMs: nowMs,
    verdict: decision.ok ? 'private' : 'blocked',
    code: decision.code,
    blocked: !decision.ok,
    blockedCode: decision.ok ? '' : decision.code,
    blockedAtMs: decision.ok ? 0 : nowMs,
    checkCount: state.checkCount + 1
  };
  return next;
}

/** 去重窗口内的复用结果（不再发请求，也不改变 sticky 状态）。 */
export function cachedRepoVisibilityDecision(state: RepoVisibilityGateState): RepoVisibilityDecision {
  return decisionForRepoCode(state.blocked ? state.blockedCode : REPO_VISIBILITY_OK);
}
