/**
 * 构建期文件系统异常的**唯一**日志出口（mod-crash-settings-sync）。
 *
 * 为什么单独成文件：
 * - `credentialHygiene` 硬守卫禁止 services / settings 页面源码出现 `hilog.*` 字面量
 *   （凭据敏感区域零日志）；但 P0 又要求「目录列举失败要 log 一次 path + code」。
 * - 本文件只收 path + code 两个字段，绝不碰 token / 仓库地址内容 / 文件字节，
 *   因此可以安全地持有 hilog；服务层通过函数引用调用，源码里没有 hilog 调用点。
 *
 * 去重：同一个 (path, code) 只打一行。真机上坏目录会被反复列举（build → aboutToAppear
 * → 刷新状态），不去重会把 hilog 刷爆，反而淹没真正的错误。
 */
import { hilog } from '@kit.PerformanceAnalysisKit';

const DOMAIN: number = 0x0000;
const TAG: string = 'FsSafety';

/** 进程内已打过的 (path|code) 集合。仅用于去重，不承载任何业务状态。 */
const loggedKeys: Set<string> = new Set<string>();

/** 打一行 fs 安全日志（只含路径与 typed code；同一组合仅一次）。 */
export function logFsSafety(path: string, code: string): void {
  const safePath: string = path.length === 0 ? '<empty>' : path;
  const key: string = safePath + '|' + code;
  if (loggedKeys.has(key)) {
    return;
  }
  loggedKeys.add(key);
  hilog.error(DOMAIN, TAG, '[fs-safety] path=%{public}s code=%{public}s', safePath, code);
}
