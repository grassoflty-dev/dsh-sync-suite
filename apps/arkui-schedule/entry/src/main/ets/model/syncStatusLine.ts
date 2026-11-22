/**
 * 同步状态行的**唯一渲染器**（mod-status-honesty-regression）。
 *
 * 为什么必须有这一层：历史上「已同步 · HH:MM」曾经由三个地方各自拼出来——
 * `pages/SettingsSync.ets` 的页面本地 `honestStatus()` 读 `lastSyncAt`、
 * `model/settingsMenu.ts` 的 `syncRowSummary()` 也读 `lastSyncAt`、
 * 而真正的**最新一次尝试**只写在 `git_sync_status`（`syncStatusStore`）。
 * 于是 1000008 上出现「已同步 · 19:47」（2026-11-21 的旧成功）
 * 盖住「上次失败 · 16:26」（2026-11-22 的最新失败）。
 *
 * 本模块把状态收敛成**五态互斥联合类型**，渲染是覆盖全部五种的 total function：
 * - `unconfigured` 未配置 + 点名缺项；
 * - `never` 已配置 · 尚未同步；
 * - `synced` 已同步 · HH:MM（只有最新尝试成功才可能出现）；
 * - `failed` 上次失败 · HH:MM · typed 原因（追加在同行，不弹 toast）；
 * - `blocked` 已配置（可见性阻断，禁止推送）· 最近尝试 HH:MM。
 *
 * 时间字符串本身只由 `syncStatusPersist.bootSurface()` 生成（唯一拼串点），
 * 成功时刻只存在于 `synced` 分支、失败原因只存在于 `failed` 分支，
 * 「成功时间 + 失败」在类型层面就不可能同时出现。
 * `lastSyncAt` / `lastSyncError` 只作为比较证据传入，永不参与文案插值。
 *
 * 零 SDK import、零 IO、零墙钟（时钟可注入），由 tools/tsconfig.json 编译后供 Node 单测直跑。
 */
import type { PersistedOutcome } from './syncStatusPersist';
import { bootSurface, normalizeAt } from './syncStatusPersist';
import type { RepoConfigState } from './repoConfigured';

/** 隐私阻断文案：与 `repoConfigured.repoRowSummary` 共用这一个字面量。 */
export const REPO_BLOCKED_TEXT: string = '已配置（可见性阻断，禁止推送）';

/** 互斥五态。成功时刻 / 失败原因分别只存在于对应分支，不能交叉组合。 */
export type StatusLineState =
  | { kind: 'unconfigured'; reason: string }
  | { kind: 'never' }
  | { kind: 'synced'; at: string }
  | { kind: 'failed'; at: string; reason: string }
  | { kind: 'blocked'; at: string };

/** 由权威事实推导五态。除这里之外没有任何地方再判断「成功还是失败」。 */
export interface StatusFacts {
  /** 权威：git_sync_status 里的最新一次已完成尝试。 */
  latest: PersistedOutcome | null;
  /** 旧设置字段，只作比较证据，绝不渲染。 */
  legacyLastSyncAt: string;
  /** 旧设置字段，只作比较证据，绝不渲染。 */
  legacyLastSyncError: string;
  /** 仓库配置状态（未配置点名缺项）。 */
  config: RepoConfigState;
  /** 当前是否处于可见性阻断。 */
  blocked: boolean;
  /** 阻断态的最近一次尝试时刻 HH:MM（不是上次成功时刻）。 */
  blockAt: string;
}

/**
 * 事实 → 五态的**唯一**推导。优先级固定：未配置 > 阻断 > 最新尝试 > 中性面。
 * 旧的 lastSyncAt / lastSyncError 只用于识别「有过更早的事」，不产生任何分支。
 */
export function statusStateOf(facts: StatusFacts): StatusLineState {
  if (!facts.config.configured) {
    return { kind: 'unconfigured', reason: facts.config.reason };
  }
  if (facts.blocked) {
    return { kind: 'blocked', at: normalizeAt(facts.blockAt) };
  }
  const latest: PersistedOutcome | null = facts.latest;
  if (latest === null) {
    return { kind: 'never' };
  }
  const at: string = normalizeAt(latest.at);
  if (at.length === 0) {
    return { kind: 'never' };
  }
  if (latest.kind === 'failed') {
    return { kind: 'failed', at: at, reason: latest.reason };
  }
  return { kind: 'synced', at: at };
}

/**
 * 五态 → 用户可见文案的 total function。没有 default 兜底、没有第二个 if 链；
 * 新增一态时 TypeScript 会强制在 switch 里补分支。
 */
export function syncStatusText(state: StatusLineState): string {
  switch (state.kind) {
    case 'unconfigured':
      return state.reason;
    case 'never':
      return `已配置 · ${bootSurface(null, false).text}`;
    case 'synced':
      return bootSurface({ kind: 'synced', at: state.at, reason: '' }, false).text;
    case 'failed': {
      const base: string = bootSurface(
        { kind: 'failed', at: state.at, reason: state.reason }, false
      ).text;
      const reason: string = state.reason.trim();
      return reason.length > 0 ? `${base} · ${reason}` : base;
    }
    case 'blocked':
      return state.at.length > 0
        ? `${REPO_BLOCKED_TEXT} · 最近尝试 ${state.at}`
        : REPO_BLOCKED_TEXT;
  }
}

/** 兼容既有调用点：事实 → 五态 → 文案，一步到位。 */
export function syncStatusLineOf(facts: StatusFacts): string {
  return syncStatusText(statusStateOf(facts));
}

/** 本地 HH:MM 的两位补零，与 `syncStatusStore.hhmm()` 逐字同构。 */
function two(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

/**
 * 注入时钟下的本机 `HH:MM`（把带时区的 ISO 折算到本机时区）。
 *
 * 与失败戳 `hhmm(now)` 用的是同一台时钟、同一个本地取时方式，所以两个数可以直接比：
 * 单测注入 2026-11-22 16:26（Asia/Shanghai）时，`clockOfIso('2026-11-21T19:47:20+08:00', now)`
 * 给出 `19:47`，而 `hhmm(now)` 给出 `16:26` —— 19:47 属于**前一天**，不是「更晚」。
 */
export function clockOfIso(iso: string, now: Date): string {
  const ms: number = Date.parse(iso);
  if (Number.isNaN(ms)) {
    return '';
  }
  // 折算到注入时钟所在时区：now 与 ISO 时刻的 UTC 偏移差决定平移量。
  const source: Date = new Date(ms);
  const shiftMin: number = now.getTimezoneOffset() - source.getTimezoneOffset();
  const at: Date = new Date(ms - shiftMin * 60000);
  return `${two(at.getHours())}:${two(at.getMinutes())}`;
}

/** ISO 所在本地日历日是否早于注入时钟的本地日历日（跨天时 HH:MM 不可直接比大小）。 */
export function isOlderLocalDay(iso: string, now: Date): boolean {
  const ms: number = Date.parse(iso);
  if (Number.isNaN(ms)) {
    return false;
  }
  const at: Date = new Date(ms);
  const day: number = at.getFullYear() * 10000 + (at.getMonth() + 1) * 100 + at.getDate();
  const nowDay: number = now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate();
  return day < nowDay;
}
