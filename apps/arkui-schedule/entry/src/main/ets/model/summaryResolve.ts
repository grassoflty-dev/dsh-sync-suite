/**
 * 设置根页「摘要行」的尝试序号 / 重试文案 / 行尾提示（模块 `mod-app-settings-summary-resolve`）。
 *
 * 为什么单独一层：真机 21:36 复测里两行**永远停在「读取中…」且从不出现 typed 失败行**，
 * 而同一入口的子页健康。根因不在数据层（同一批 services 在子页读得出值），在**渲染绑定**：
 * 行文本原经 `@Builder MenuRow(title, summary, route)` 按值传参，ArkUI 不随 `@State` 重建那个
 * Text 节点（同一类缺陷在 `docs/VERIFICATION.md` §15.6.1 已被真机抓过一次）。修法是把行换成
 * 真组件（`components/settings/MenuSummaryRow.ets` 的 `@Prop`），数据层一个字没改。
 *
 * 本文件只补另一半：**重试也没成功时必须有一句不同的 typed 文案**，不允许悄悄退回占位。
 * 纯函数：不碰 SDK、不联网、不打日志、不持有状态。
 */
import { LOADING_TEXT } from './bridgeReadiness';

/** 行尾提示：失败态是「重试」（点本行即重试），其余是进入箭头。 */
export const ROW_HINT_RETRY: string = '重试';
export const ROW_HINT_OPEN: string = '›';

/** 行尾提示（失败态 → 「重试」；正常态 → 「›」）。由 `@Prop retryable` 现算，不缓存。 */
export function rowHintOf(retryable: boolean): string {
  return retryable === true ? ROW_HINT_RETRY : ROW_HINT_OPEN;
}

/** 已完成的重试次数归一（负数 / 非数字 → 0；小数向下取整）。 */
export function attemptOf(previous: number): number {
  return typeof previous === 'number' && previous > 0 ? Math.floor(previous) : 0;
}

/**
 * 下一次尝试的序号：首次读取 = 0，每点一次「重试」+1。
 *
 * 为什么需要序号：同一句「读不到」重复出现等于没有新信息；用户点了重试、重试又超时，
 * 必须能从文案里看出「这是第几次」，否则「又回到读取中…」的错觉无法排除。
 */
export function nextAttemptOf(previous: number): number {
  return attemptOf(previous) + 1;
}

/** 该序号是**第几次**读取（序号 0 → 第 1 次）。 */
export function readNoOf(attempt: number): number {
  return attemptOf(attempt) + 1;
}

/**
 * 把这次失败的原因接上「第几次」的说法。
 *
 * - `attempt === 0`（首次读取）：原因原样返回（首读超时就是「读取超时（超过 4 秒）」）；
 * - `attempt >= 1`（点过重试）：前置「第 N 次仍没读到」，于是**文案一定与上一次不同**。
 *
 * 空原因也给出确定说法（绝不把空串上屏）。
 */
export function retryReasonOf(attempt: number, reason: string): string {
  const tries: number = attemptOf(attempt);
  const detail: string = typeof reason === 'string' ? reason.trim() : '';
  if (tries <= 0) {
    return detail;
  }
  const head: string = `第 ${tries + 1} 次仍没读到`;
  return detail.length > 0 ? `${head}：${detail}` : head;
}

/**
 * 一段行文案是不是**终态**（既不是空串，也不是唯一的在飞文案）。
 *
 * 用途：三态模型（`bridgeReadiness`）的所有出口都必须满足它；测试用它逐条钉住
 * 「成功 / 超时 / 抛错 / 重试又超时」都不会把行留在「读取中…」。
 */
export function isTerminalRowText(text: string): boolean {
  const value: string = typeof text === 'string' ? text.trim() : '';
  return value.length > 0 && value !== LOADING_TEXT;
}
