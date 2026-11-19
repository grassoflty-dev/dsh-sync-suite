/**
 * 同步状态的三态视图（mod-v2-sync-wiring）：首页状态行与设置页共用的唯一数据源。
 *
 * 三态（契约 §9 可见状态 + 本模块激活闸）：
 * - `synced`：最近一次周期成功且 outbox 空 → 文案「已同步·<HH:MM>」；
 * - `pending`：outbox 仍有可重放意图或已有 failed 终态 → 「N 条待同步·最近失败：<typed 原因>」；
 * - `readonly`：未启用 v2 写入 / 门禁拒绝 / 周期不可用 → 「只读·<原因>」。
 *
 * 只写 AppStorage 的四个小键（不写文件、不碰仓库、不写 devices/**），页面用 @State 镜像；
 * recordWriter 的 fire-and-forget 同步结果也经这里落到 UI，失败原因如实展示，不静默吞。
 */
import type { CycleResult } from './syncProtocolStore';

/** 三态枚举（用字符串而非联合字面量，避免在 ArkTS 里写类型断言）。 */
export type SyncState = 'synced' | 'pending' | 'readonly';

/** 页面 @State 镜像的只读视图（显式接口：ArkTS 禁止对象字面量当类型）。 */
export interface SyncStatusView {
  state: SyncState;
  /** 「已同步」/「N 条待同步」/「只读」。 */
  label: string;
  /** 状态行完整文案（label·detail）。 */
  text: string;
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

function two(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

/** 本地 HH:MM（不用 toISOString，避免把本地时间显示成 UTC）。 */
function hhmm(now: Date): string {
  return `${two(now.getHours())}:${two(now.getMinutes())}`;
}

export class SyncStatusStore {
  /** 从周期结果刷新状态（成功且无待同步=已同步；否则按 pending / 失败原因显示）。 */
  fromCycle(outcome: CycleResult, now: Date): SyncStatusView {
    if (outcome.pending > 0 || outcome.failed > 0) {
      const count: number = outcome.pending + outcome.failed;
      this.setPending(count, outcome.message);
    } else if (outcome.ok) {
      this.setSynced(now);
    } else {
      this.setPending(0, outcome.message);
    }
    return this.snapshot();
  }

  /** 只读态（未激活 / 门禁拒绝 / 周期不可用），原因如实展示。 */
  setReadOnly(reason: string): SyncStatusView {
    AppStorage.setOrCreate<string>(KEY_STATE, 'readonly');
    AppStorage.setOrCreate<string>(KEY_REASON, reason);
    AppStorage.setOrCreate<number>(KEY_PENDING, 0);
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

  /** 待同步（N 条 + 最近失败原因）。 */
  setPending(count: number, reason: string): SyncStatusView {
    AppStorage.setOrCreate<string>(KEY_STATE, 'pending');
    AppStorage.setOrCreate<string>(KEY_REASON, reason);
    AppStorage.setOrCreate<number>(KEY_PENDING, count);
    return this.snapshot();
  }

  /** 组装页面 @State（任何异常都降级为只读，绝不 throwing 到 UI 线程）。 */
  snapshot(): SyncStatusView {
    let state: SyncState = 'readonly';
    try {
      const raw: string | undefined = AppStorage.get<string>(KEY_STATE);
      if (raw === 'synced' || raw === 'pending') {
        state = raw;
      }
    } catch (error) {
      state = 'readonly';
    }
    const pending: number = this.numberOf(KEY_PENDING);
    const reason: string = this.textOf(KEY_REASON);
    const lastAt: string = this.textOf(KEY_LAST_AT);
    let label: string = '只读';
    let detail: string = reason.length > 0 ? reason : 'v2 写入未启用，当前使用 v1 日程路径';
    if (state === 'synced') {
      label = '已同步';
      detail = lastAt.length > 0 ? lastAt : '刚刚';
    } else if (state === 'pending') {
      label = `${pending} 条待同步`;
      detail = reason.length > 0 ? `最近失败：${reason}` : '等待重试';
    }
    return {
      state: state, label: label, text: `${label}·${detail}`,
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

/** 全局单例：首页状态行 / 设置页激活 / recordWriter 共用同一份三态视图。 */
export const syncStatusStore: SyncStatusStore = new SyncStatusStore();
