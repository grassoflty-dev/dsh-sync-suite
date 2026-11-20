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
 */
import type { CycleResult } from './syncProtocolStore';

/** 三态枚举（用字符串而非联合字面量，避免在 ArkTS 里写类型断言）。 */
export type SyncState = 'synced' | 'syncing' | 'failed';

/** 页面 @State 镜像的只读视图（显式接口：ArkTS 禁止对象字面量当类型）。 */
export interface SyncStatusView {
  state: SyncState;
  /** 短标签（'已同步' / '同步中' / '失败'），供着色与可选辅助显示。 */
  label: string;
  /** 状态行完整文案：三态分别是 已同步 · HH:MM / 同步中… / 失败：<typed 原因>。 */
  text: string;
  /** outbox 里仍未同步的意图数（不拼进文案，只供重试入口判断）。 */
  pending: number;
  /** 最近一次 typed 失败原因（空串 = 无失败）。 */
  reason: string;
  /** 最近一次成功时刻（HH:MM，空串 = 尚未成功）。 */
  lastAt: string;
}

const KEY_STATE: string = 'timeline.sync.state';
const KEY_REASON: string = 'timeline.sync.reason';
const KEY_PENDING: string = 'timeline.sync.pending';
const KEY_LAST_AT: string = 'timeline.sync.lastAt';

const SYNCED_LABEL: string = '已同步';
const SYNCING_LABEL: string = '同步中';
const FAILED_LABEL: string = '失败';
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

export class SyncStatusStore {
  /** 从周期结果刷新状态：成功且无待同步=已同步；否则如实显示 typed 失败原因。 */
  fromCycle(outcome: CycleResult, now: Date): SyncStatusView {
    if (!outcome.ok || outcome.pending > 0 || outcome.failed > 0) {
      const reason: string = outcome.message.length > 0 ? outcome.message : UNKNOWN_REASON;
      return this.setFailed(reason, outcome.pending + outcome.failed);
    }
    return this.setSynced(now);
  }

  /** 周期在途（创建记录后的自动周期 / 下拉刷新均已发起）。 */
  setSyncing(): SyncStatusView {
    AppStorage.setOrCreate<string>(KEY_STATE, 'syncing');
    AppStorage.setOrCreate<string>(KEY_REASON, '');
    return this.snapshot();
  }

  /** 失败态：typed 原因逐字展示；count 记下仍有几条待同步意图（不拼进文案）。 */
  setFailed(reason: string, count: number = 0): SyncStatusView {
    AppStorage.setOrCreate<string>(KEY_STATE, 'failed');
    AppStorage.setOrCreate<string>(KEY_REASON, reason.length > 0 ? reason : UNKNOWN_REASON);
    AppStorage.setOrCreate<number>(KEY_PENDING, count);
    return this.snapshot();
  }

  /** 已同步（成功且 outbox 空）。 */
  setSynced(now: Date): SyncStatusView {
    const at: string = hhmm(now);
    AppStorage.setOrCreate<string>(KEY_STATE, 'synced');
    AppStorage.setOrCreate<string>(KEY_REASON, '');
    AppStorage.setOrCreate<number>(KEY_PENDING, 0);
    AppStorage.setOrCreate<string>(KEY_LAST_AT, at);
    return this.snapshot();
  }

  /** 兼容旧调用点：待同步 = 失败态（文案只有三态，不再有「N 条待同步」第四态）。 */
  setPending(count: number, reason: string): SyncStatusView {
    return this.setFailed(reason, count);
  }

  /** 兼容旧调用点：门禁拒绝 = 失败态（typed 原因如实展示）。 */
  setError(reason: string): SyncStatusView {
    return this.setFailed(reason, 0);
  }

  /** 组装页面 @State（任何异常都降级为失败态，绝不 throwing 到 UI 线程）。 */
  snapshot(): SyncStatusView {
    let state: SyncState = 'failed';
    try {
      const raw: string | undefined = AppStorage.get<string>(KEY_STATE);
      if (raw === 'synced' || raw === 'syncing' || raw === 'failed') {
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
    if (state === 'synced') {
      label = SYNCED_LABEL;
      text = `${SYNCED_PREFIX}${lastAt.length > 0 ? lastAt : '刚刚'}`;
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
