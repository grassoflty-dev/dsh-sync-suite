/**
 * 同步状态的三态视图：首页状态行与设置页共用的唯一数据源。
 *
 * 三态（用户可见文案逐字固定，见 docs/STATE-UI.md）：
 * - `synced`：`已同步 · HH:MM`（最近一次周期成功且 outbox 空）；
 * - `syncing`：`同步中…`（周期在途，含创建记录后的自动周期与首页下拉刷新）；
 * - `failed`：`失败：<typed 原因>`（门禁 / 推送 / IO 等失败或 outbox 仍有待同步意图）。
 *
 * 失败原因保持 typed 原文（E_SCHEMA_UNKNOWN / E_BRANCH_MISMATCH / E_CORRUPT /
 * E_PUSH_REJECTED / E_AUTH / E_IO …），不在这里重新分类、不静默吞掉。
 * 只写 AppStorage 的四个小键（不写文件、不碰仓库、不写 devices/**），页面用 @State 镜像；
 * 失败态的重试是首页状态行上的「点一下」（不是新按钮），见 pages/Index.ets 的 SyncStatusRow。
 *
 * mod-sync-status-persist（重启不再谎报失败）：
 * - 上次**已完成**结果（synced / failed + HH:MM + typed 原因）落进专用 preferences
 *   `git_sync_status` 的版本化键 `v:1.status`；纯判定在 `model/syncStatusPersist.ts`；
 * - 本进程第一次 `snapshot()` 只读一次盘，按决策表还原：`已同步 · <原时刻>` /
 *   `上次失败 · <时刻>`（过去事件，typed reason 仍留在 view.reason）/ `尚未同步`（中性面）；
 * - `syncing` 永不写盘，进程被杀也不会留下永久「同步中…」；在途未结束时仍是在途态；
 * - 偏好设置失败一律吞掉，降级为老的内存行为，绝不把异常抛到 UI。
 *
 * **这是刻意的临时落地**：mod-config-persistence（build 1000006）会把版本化配置的
 * 单一访问器收口，届时上面的 store / 键 / 信封必须并进中央 accessor；这里写了 v:1
 * 不代表本文件被集中化豁免，后续不要把它当成例外。
 */
import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';
import type { CycleResult } from './syncProtocolStore';
import {
  SYNC_STATUS_KEY,
  SYNC_STATUS_PREFS_NAME,
  TEXT_NEVER,
  bootSurface,
  commitStatus,
  decodeStatus,
  readStatus
} from '../model/syncStatusPersist';
import type {
  PersistedOutcome,
  StatusCommit,
  StatusRead,
  StatusStorage,
  StatusSurface,
  SyncStatusState
} from '../model/syncStatusPersist';
// mod-repo-privacy-gate：推送被拒的两条**独立**状态文案只在这里渲染（不在任何 pane）。
import { E_REPO_PUBLIC, E_REPO_VISIBILITY_UNKNOWN, repoBlockStatusText } from '../model/repoVisibility';

/**
 * 三态 + 两个启动-only 中性标记 + 两条仓库可见性阻塞态。
 * `repo_public` / `repo_unknown` 只由真实推送前置门禁产出：它们是「已停止上传」，
 * 不是「失败：…（可重试）」，也不冒充「已同步」。
 */
export type SyncState = SyncStatusState | 'repo_public' | 'repo_unknown';

/** 页面 @State 镜像的只读视图（显式接口：ArkTS 禁止对象字面量当类型）。 */
export interface SyncStatusView {
  state: SyncState;
  /** 短标签（'已同步' / '同步中' / '失败' / 两个启动-only 标签），供着色与可选辅助显示。 */
  label: string;
  /** 状态行完整文案：三态分别是 已同步 · HH:MM / 同步中… / 失败：<typed 原因>。 */
  text: string;
  /** outbox 里仍未同步的意图数（不拼进文案，只供重试入口判断）。 */
  pending: number;
  /** 最近一次 typed 失败原因（空串 = 无失败）；启动的「上次失败」也保留在这里。 */
  reason: string;
  /** 最近一次成功时刻（HH:MM，空串 = 尚未成功）。 */
  lastAt: string;
}

const KEY_STATE: string = 'timeline.sync.state';
const KEY_REASON: string = 'timeline.sync.reason';
const KEY_PENDING: string = 'timeline.sync.pending';
const KEY_LAST_AT: string = 'timeline.sync.lastAt';
/** 仓库可见性阻塞的最近**尝试**时刻（HH:MM），单独存，不复用 lastAt（后者只能由真实成功写）。 */
const KEY_REPO_BLOCK_AT: string = 'timeline.sync.repoBlockAt';

const SYNCED_LABEL: string = '已同步';
const SYNCING_LABEL: string = '同步中';
const FAILED_LABEL: string = '失败';
const REPO_PUBLIC_LABEL: string = '仓库已公开';
const REPO_UNKNOWN_LABEL: string = '可见性未确认';
const SYNCED_PREFIX: string = '已同步 · ';
const SYNCING_TEXT: string = '同步中…';
const FAILED_PREFIX: string = '失败：';
const UNKNOWN_REASON: string = '未知错误';

function two(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

/** 本地 HH:MM（不用 toISOString，避免把本地时间显示成 UTC）。 */
function hhmm(now: Date): string {
  return `${two(now.getHours())}:${two(now.getMinutes())}`;
}

/**
 * 专用偏好访问器 —— 本文件**唯一**的 preferences 入口。
 *
 * 用同步 API（`getPreferencesSync` / `getSync` / `putSync` / `flushSync`），
 * 因为 `snapshot()` 被页面 @State 初始化同步调用，不能改成 async。
 * 拿不到 context / 读写异常时置 `unavailable` 并静默降级：只读路径返回空串，
 * 写路径变成 no-op，内存三态照常工作。
 */
class StatusPrefsStorage implements StatusStorage {
  private prefs: preferences.Preferences | null = null;
  private unavailable: boolean = false;

  private accessor(): preferences.Preferences | null {
    if (this.unavailable) {
      return null;
    }
    if (this.prefs !== null) {
      return this.prefs;
    }
    try {
      const context: common.UIAbilityContext = getContext() as common.UIAbilityContext;
      this.prefs = preferences.getPreferencesSync(context, { name: SYNC_STATUS_PREFS_NAME });
      return this.prefs;
    } catch {
      this.unavailable = true;
      return null;
    }
  }

  read(): string {
    const prefs: preferences.Preferences | null = this.accessor();
    if (prefs === null) {
      return '';
    }
    try {
      const value: preferences.ValueType = prefs.getSync(SYNC_STATUS_KEY, '');
      return typeof value === 'string' ? value : '';
    } catch {
      return '';
    }
  }

  write(value: string): void {
    const prefs: preferences.Preferences | null = this.accessor();
    if (prefs === null) {
      return;
    }
    try {
      prefs.putSync(SYNC_STATUS_KEY, value);
      prefs.flushSync();
    } catch {
      // 写盘失败只降级为内存态，不打断同步主流程
    }
  }
}

export class SyncStatusStore {
  /** 本进程是否已发生过真实周期写入：为 true 时实时三态优先于盘上的上次结果。 */
  private live: boolean = false;
  /** undefined = 本进程还没读盘；null = 读盘确认「没有已知结果」。整进程只读一次。 */
  private restored: PersistedOutcome | null | undefined = undefined;
  /** 上次已写盘的 JSON；编码相同就不重写（仅真实变化才落盘）。 */
  private lastWritten: string = '';
  /** 唯一访问器（懒创建；构造失败也降级为不写盘的内存态）。 */
  private storage: StatusStorage | null = null;

  private accessor(): StatusStorage | null {
    if (this.storage === null) {
      try {
        this.storage = new StatusPrefsStorage();
      } catch {
        this.storage = null;
      }
    }
    return this.storage;
  }

  /** 首次读取时还原：只读一次偏好，永不写盘、永不抛。 */
  private restore(): PersistedOutcome | null {
    if (this.restored !== undefined) {
      return this.restored;
    }
    const read: StatusRead = readStatus(this.accessor());
    this.restored = read.outcome;
    this.lastWritten = read.raw;
    return this.restored;
  }

  /** 真实状态变化时落盘一次；偏好失败只影响盘，不影响内存里的实时视图。 */
  private commit(outcome: PersistedOutcome): void {
    try {
      const result: StatusCommit = commitStatus(this.accessor(), outcome, this.lastWritten);
      this.lastWritten = result.json;
    } catch {
      // 连纯函数都不许把异常带进 UI
    }
  }

  /**
   * 只读当前是否处于仓库可见性阻塞态。
   * 判定放在 store（而不是某个调用点）：所有失败写入都必须经过这里，才能挡住
   * `E_SYNC_UNAVAILABLE` 这类「没走到推送门禁就早退」的结果覆盖更可执行的阻塞文案。
   */
  private repoBlockedNow(): boolean {
    const state: string = this.stateOf();
    return state === 'repo_public' || state === 'repo_unknown';
  }

  /** 从 typed 失败原因里认出隐私码（精确码或「码: 文案」前缀），用于失败写入的分流。 */
  private repoBlockCodeOf(reason: string): string {
    if (reason.length === 0) {
      return '';
    }
    if (reason === E_REPO_PUBLIC || reason.indexOf(`${E_REPO_PUBLIC}:`) === 0) {
      return E_REPO_PUBLIC;
    }
    if (reason === E_REPO_VISIBILITY_UNKNOWN || reason.indexOf(`${E_REPO_VISIBILITY_UNKNOWN}:`) === 0) {
      return E_REPO_VISIBILITY_UNKNOWN;
    }
    return '';
  }

  /**
   * 唯一权威「最新一次已完成尝试」，供设置页状态行消费（mod-status-honesty-regression）。
   *
   * 只读、不写盘：优先取本进程最后一次提交（commit / restore 都会刷新 `lastWritten`），
   * 坏值回落到启动读盘结果；永远只返回最新一次，不存在「旧成功 + 新失败」并存的视图。
   * 页面因此不可能再拿 settingsStore 的 lastSyncAt 拼出假成功。
   */
  latestAttempt(): PersistedOutcome | null {
    try {
      const live: PersistedOutcome | null = decodeStatus(this.lastWritten);
      return live === null ? this.restore() : live;
    } catch (error) {
      void error;
      return null;
    }
  }

  /**
   * 实时可见性复核通过：只解除阻塞，绝不伪造一次同步成功。
   *
   * 清掉阻塞三键并把 `live` 归零 ⇒ `snapshot()` 回到盘上**最近真实结果**（没有则「尚未同步」）；
   * `KEY_LAST_AT`（上次成功时刻）与已落盘的偏好 outcome 一字不动——复核通过不是同步。
   */
  clearRepoBlock(): SyncStatusView {
    if (!this.repoBlockedNow()) {
      return this.snapshot();
    }
    AppStorage.setOrCreate<string>(KEY_STATE, '');
    AppStorage.setOrCreate<string>(KEY_REASON, '');
    AppStorage.setOrCreate<string>(KEY_REPO_BLOCK_AT, '');
    this.live = false;
    return this.snapshot();
  }

  /** 安全读 AppStorage 的 state（给启动决策判断是否有在途周期）。 */
  private stateOf(): string {
    try {
      const value: string | undefined = AppStorage.get<string>(KEY_STATE);
      return value === undefined ? '' : value;
    } catch (error) {
      void error;
      return '';
    }
  }

  /** 从周期结果刷新状态：成功且无待同步=已同步；否则如实显示 typed 失败原因。 */
  fromCycle(outcome: CycleResult, now: Date): SyncStatusView {
    if (!outcome.ok || outcome.pending > 0 || outcome.failed > 0) {
      // 仓库可见性拒绝有两条独立文案 + 最近尝试时刻，绝不折叠进「失败：…（可重试）」。
      if (outcome.code === E_REPO_PUBLIC || outcome.code === E_REPO_VISIBILITY_UNKNOWN) {
        return this.setRepoBlocked(outcome.code, now);
      }
      // 已有仓库阻塞 ⇒ 非隐私失败（如 E_SYNC_UNAVAILABLE 早退）只保留原阻塞与原「最近尝试」戳。
      // setFailed 里还有同一道闸，防止其它直接调用点绕过 fromCycle。
      if (this.repoBlockedNow()) {
        return this.snapshot();
      }
      const reason: string = outcome.message.length > 0 ? outcome.message : UNKNOWN_REASON;
      return this.setFailed(reason, outcome.pending + outcome.failed);
    }
    return this.setSynced(now);
  }

  /**
   * 推送被可见性门禁挡住：状态行显示「已停止上传」+ 最近尝试 HH:MM。
   * `reason` 保留 typed 码（不是长文案）；`lastSyncAt` 一律不写，所以永远不会出现「已同步」。
   */
  setRepoBlocked(code: string, now: Date): SyncStatusView {
    this.live = true;
    const at: string = hhmm(now);
    AppStorage.setOrCreate<string>(KEY_STATE, code === E_REPO_PUBLIC ? 'repo_public' : 'repo_unknown');
    AppStorage.setOrCreate<string>(KEY_REASON, code);
    AppStorage.setOrCreate<number>(KEY_PENDING, 0);
    AppStorage.setOrCreate<string>(KEY_REPO_BLOCK_AT, at);
    return this.snapshot();
  }

  /** 周期在途（创建记录后的自动周期 / 下拉刷新均已发起）。**不写盘**：被杀不留下在途态。 */
  setSyncing(): SyncStatusView {
    this.live = true;
    AppStorage.setOrCreate<string>(KEY_STATE, 'syncing');
    AppStorage.setOrCreate<string>(KEY_REASON, '');
    return this.snapshot();
  }

  /**
   * 失败态：typed 原因逐字展示；count 记下仍有几条待同步意图（不拼进文案）。
   *
   * 唯一失败写入口（fromCycle / reportFailure / setPending / setError 都汇到此处）：
   * - 隐私码 ⇒ 刷新仓库阻塞态（这是新的尝试，允许更新戳）；
   * - 已是阻塞态 + 非隐私失败 ⇒ **整体拒绝写入**（保留原文案与原戳），绝不让「失败：…」盖掉更可执行的提示；
   * - 其它情况照常写失败态。成功清理由 setSynced 负责，不在这里开后门。
   */
  setFailed(reason: string, count: number = 0): SyncStatusView {
    const privacyCode: string = this.repoBlockCodeOf(reason);
    if (privacyCode.length > 0) {
      return this.setRepoBlocked(privacyCode, new Date());
    }
    if (this.repoBlockedNow()) {
      return this.snapshot();
    }
    this.live = true;
    const shown: string = reason.length > 0 ? reason : UNKNOWN_REASON;
    AppStorage.setOrCreate<string>(KEY_STATE, 'failed');
    AppStorage.setOrCreate<string>(KEY_REASON, shown);
    AppStorage.setOrCreate<number>(KEY_PENDING, count);
    this.commit({ kind: 'failed', at: hhmm(new Date()), reason: shown });
    return this.snapshot();
  }

  /** 已同步（成功且 outbox 空）。 */
  setSynced(now: Date): SyncStatusView {
    const at: string = hhmm(now);
    this.live = true;
    AppStorage.setOrCreate<string>(KEY_STATE, 'synced');
    AppStorage.setOrCreate<string>(KEY_REASON, '');
    AppStorage.setOrCreate<number>(KEY_PENDING, 0);
    AppStorage.setOrCreate<string>(KEY_LAST_AT, at);
    this.commit({ kind: 'synced', at: at, reason: '' });
    return this.snapshot();
  }

  /** 兼容旧调用点：待同步 = 失败态（文案只有三态，不再有第四态）。 */
  setPending(count: number, reason: string): SyncStatusView {
    return this.setFailed(reason, count);
  }

  /** 兼容旧调用点：门禁拒绝 = 失败态（typed 原因如实展示）。 */
  setError(reason: string): SyncStatusView {
    return this.setFailed(reason, 0);
  }

  /**
   * 组装页面 @State：有实时周期就用老三态；否则按盘上的上次结果走启动决策表。
   * 只读、不写盘、任何异常都回中性面，绝不 throwing 到 UI 线程。
   */
  snapshot(): SyncStatusView {
    try {
      if (this.live) {
        return this.liveView();
      }
      return this.viewOf(bootSurface(this.restore(), this.stateOf() === 'syncing'));
    } catch (error) {
      void error;
      return this.viewOf(bootSurface(null, false));
    }
  }

  /** 纯视图转换（不在这里拼文案，文案只有 model 一份事实来源）。 */
  private viewOf(surface: StatusSurface): SyncStatusView {
    return {
      state: surface.state, label: surface.label, text: surface.text,
      pending: surface.pending, reason: surface.reason, lastAt: surface.lastAt
    };
  }

  /** 实时三态组装（原有逻辑逐字保留，只从 snapshot 挪到独立方法）。 */
  private liveView(): SyncStatusView {
    let state: SyncState = 'failed';
    try {
      const raw: string | undefined = AppStorage.get<string>(KEY_STATE);
      if (raw === 'synced' || raw === 'syncing' || raw === 'failed' ||
        raw === 'repo_public' || raw === 'repo_unknown') {
        state = raw;
      }
    } catch (error) {
      void error;
      state = 'failed';
    }
    const pending: number = this.numberOf(KEY_PENDING);
    const reason: string = this.textOf(KEY_REASON);
    const lastAt: string = this.textOf(KEY_LAST_AT);
    let label: string = FAILED_LABEL;
    let text: string = `${FAILED_PREFIX}${reason.length > 0 ? reason : UNKNOWN_REASON}`;
    if (state === 'repo_public' || state === 'repo_unknown') {
      const attempted: string = this.textOf(KEY_REPO_BLOCK_AT);
      label = state === 'repo_public' ? REPO_PUBLIC_LABEL : REPO_UNKNOWN_LABEL;
      // 唯一渲染点：文案来自纯模型，时间来自最近一次尝试（不是上次成功时刻）。
      text = repoBlockStatusText(reason, attempted);
      if (text.length === 0) {
        text = state === 'repo_public'
          ? repoBlockStatusText(E_REPO_PUBLIC, attempted)
          : repoBlockStatusText(E_REPO_VISIBILITY_UNKNOWN, attempted);
      }
      return { state: state, label: label, text: text, pending: pending, reason: reason, lastAt: attempted };
    }
    if (state === 'synced') {
      if (lastAt.length > 0) {
        // 唯一合法成功文案：真完成过周期并落盘的 HH:MM。
        label = SYNCED_LABEL;
        text = `${SYNCED_PREFIX}${lastAt}`;
      } else {
        // 没有完成时刻就没有「已同步」。相对时间措辞会凭空暗示最近成功过，
        // 与 M1 的假成功同类，已整支删除；这里只给中性面，绝不算一次成功。
        label = TEXT_NEVER;
        text = TEXT_NEVER;
      }
    } else if (state === 'syncing') {
      label = SYNCING_LABEL;
      text = SYNCING_TEXT;
    }
    return {
      state: state, label: label, text: text,
      pending: pending, reason: reason, lastAt: lastAt
    };
  }

  private textOf(key: string): string {
    const value: string | undefined = AppStorage.get<string>(key);
    return value === undefined ? '' : value;
  }

  private numberOf(key: string): number {
    const value: number | undefined = AppStorage.get<number>(key);
    return value !== undefined && Number.isFinite(value) ? value : 0;
  }
}

/** 全局单例：首页状态行 / recordWriter 共用同一份三态视图。 */
export const syncStatusStore: SyncStatusStore = new SyncStatusStore();
