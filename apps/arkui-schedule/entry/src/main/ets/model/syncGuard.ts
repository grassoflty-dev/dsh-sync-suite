/**
 * 同步前置守卫（纯逻辑，可在 Node 里单测）。
 *
 * 背景：真机出现过「设置页点『立即同步』直接闪退」。闪退的根因是**同步入口没有统一守卫**：
 * 桥未就绪 / 仓库地址为空时仍然往下走，最终在 bridge（WebView）调用处抛出未捕获异常，
 * 抛到 UI 线程把进程带走。这里把所有「能不能开始同步」的判断收敛成一个纯函数，
 * 让 `GitSyncService` / `syncController` / 页面三处用同一套结论，并且**永不抛异常**。
 *
 * 约定：
 * - 返回 `{ ok: false, code, message }`，`message` 是可直接展示的中文；
 * - `code` 与 `model/syncError.ts` 的分类码保持一致（`E_CONFIG` / `E_BRIDGE` / `E_BUSY`）；
 * - 只有全部通过才 `ok: true`。
 */

/** 守卫需要的输入（全部显式，避免读全局状态）。 */
export interface SyncPreconditionInput {
  /** 仓库地址（用户填的原始值）。 */
  repoUrl: string;
  /** HTTPS token（空 token 也能拉公共仓库，但私有仓库会认证失败；这里只拦「地址为空」）。 */
  token: string;
  /** 同步桥（WebView 里的 isomorphic-git + jszip）是否就绪。 */
  bridgeReady: boolean;
  /** 当前是否已有同步动作在跑（防连点）。 */
  busy?: boolean;
}

/** 守卫结论。 */
export interface SyncPreconditionResult {
  ok: boolean;
  /** 错误码（`E_CONFIG` / `E_BRIDGE` / `E_BUSY`）；`ok: true` 时为空串。 */
  code: string;
  /** 可直接展示的中文说明；`ok: true` 时为空串。 */
  message: string;
}

/** 桥未就绪时统一文案（设置页与首页共用）。 */
export const BRIDGE_NOT_READY_MESSAGE: string = '请先保存仓库地址并等待同步内核就绪';

/** 仓库地址为空时统一文案。 */
export const REPO_EMPTY_MESSAGE: string = '请先填写并保存仓库地址（只在本机记录日程可以留空）';

/** 同步进行中时统一文案。 */
export const SYNC_BUSY_MESSAGE: string = '同步正在进行中，请稍候';

function normalize(value: string): string {
  const text: string = typeof value === 'string' ? value.trim() : '';
  return text;
}

/**
 * 判断能否开始一次同步。
 *
 * 顺序刻意如此：**先看忙不忙**（连点），再看桥就绪（最容易被忽略、也是闪退根因），
 * 最后看仓库地址（用户可读、可修）。这样「桥没好」时不会先报「地址为空」误导用户。
 */
export function checkSyncPrecondition(input: SyncPreconditionInput): SyncPreconditionResult {
  if (input !== undefined && input !== null && input.busy === true) {
    return { ok: false, code: 'E_BUSY', message: SYNC_BUSY_MESSAGE };
  }
  if (input === undefined || input === null || input.bridgeReady !== true) {
    return { ok: false, code: 'E_BRIDGE', message: BRIDGE_NOT_READY_MESSAGE };
  }
  if (normalize(input.repoUrl).length === 0) {
    return { ok: false, code: 'E_CONFIG', message: REPO_EMPTY_MESSAGE };
  }
  return { ok: true, code: '', message: '' };
}

/**
 * 把「桥调用抛出来的东西」归一成一段中文说明（**不抛**）。
 *
 * WebView 侧异常可能来自：页面未加载完（`E_BRIDGE`）、控制器未绑定、超时、
 * isomorphic-git 内部错误。这里只做展示层归一，具体分级交给 `model/syncError.ts`。
 */
export function describeBridgeFailure(error: Object | undefined | null): string {
  if (error === undefined || error === null) {
    return '同步内核无响应';
  }
  const message: string = (error as Error).message === undefined ? '' : String((error as Error).message);
  const trimmed: string = message.trim();
  return trimmed.length === 0 ? '同步内核无响应' : trimmed;
}
