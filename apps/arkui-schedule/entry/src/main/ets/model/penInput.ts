/**
 * 手写板输入方式的纯逻辑（零 SDK import，Node 可测）。
 *
 * 用户要求：手写区可以「只接受手写笔」，也可以「手指 + 笔都用」。
 *
 * 为什么不 import `@kit.ArkUI` 的 `SourceTool`：这会把手写链路拖进 Android 可见路径
 * （`tools/validate-app.mjs` 规则 4），也让这段规则无法在 Node 里跑测试。
 * 因此这里只固化数值常量（与 `SourceTool` 的枚举值一一对应，页面把 `event.sourceTool`
 * 原样传进来即可），规则本身是纯函数。
 */

/** `SourceTool.Pen`：手写笔。 */
export const PEN_TOOL: number = 3;
/** `SourceTool.Finger`：手指。 */
export const FINGER_TOOL: number = 1;
/** `SourceTool.Unknown`：未知来源（部分设备/输入法拿不到笔类型）。 */
export const UNKNOWN_TOOL: number = 0;

/** 连续拒绝多少次手指输入后提示用户（避免第一次误触就弹提示）。 */
export const FINGER_REJECT_THRESHOLD: number = 3;

/**
 * 是否接受这次触摸。
 *
 * - `penOnly=false`：全部接受（手指 + 笔，默认行为）；
 * - `penOnly=true`：**只拒绝 `FINGER_TOOL`**；笔、`UNKNOWN_TOOL`（拿不到笔类型的设备）
 *   以及其它任何取值一律放行。
 *
 * 放行 `UNKNOWN_TOOL` 是硬要求：一些设备/容器拿不到笔类型，若把它当成手指拒掉，
 * 用户会「写不了字且不知道为什么」——宁可漏放一次手指，也不能让笔写不了。
 */
export function shouldAcceptTouch(penOnly: boolean, sourceTool: number): boolean {
  if (penOnly !== true) {
    return true;
  }
  return sourceTool !== FINGER_TOOL;
}

/**
 * 连续拒绝手指输入达到阈值时的提示文案（含次数，便于用户确认「确实是被开关拦下的」）。
 *
 * @param count 连续被拒绝的手指触摸次数（非法值按阈值处理）
 */
export function fingerRejectNotice(count: number): string {
  const times: number = Number.isFinite(count) && count > 0 ? Math.floor(count) : FINGER_REJECT_THRESHOLD;
  return `已连续忽略 ${times} 次手指输入：当前开启了「仅手写笔输入」，请改用手写笔书写（可在「设置 → 手写」关闭）`;
}

/**
 * 这一次被拒绝的手指触摸该不该弹提示（**每 N 次一次**，不是每次点击都弹）。
 *
 * 为什么需要它：一根手指在纸上按住/连点会产生**几十次**触摸事件（Down/Move/Up 各算一次），
 * 若每次都 `showToast`，提示会一直糊在画布上，反而看不见字。规则：
 * `count` 是 `FINGER_REJECT_THRESHOLD` 的**正整数倍**时提示一次（3、6、9…），其余静默。
 *
 * @param count 连续被拒绝的手指触摸次数（0 / 负数 / NaN / Infinity → 不提示）
 */
export function shouldShowRejectNotice(count: number): boolean {
  if (!Number.isFinite(count) || count <= 0) {
    return false;
  }
  const times: number = Math.floor(count);
  return times > 0 && times % FINGER_REJECT_THRESHOLD === 0;
}

/**
 * 手写板内被拦下时的提示文案（`fingerRejectNotice` 的手写板场景版）。
 *
 * 与 `fingerRejectNotice` 的唯一区别是**告诉用户去哪儿关**：这个开关现在在手写板自己的
 * 「笔迹 → 更多」里（设置页那条已移除），把用户指去设置页等于让他找不到。
 * 老的 `fingerRejectNotice` 保持原样不动（既有调用方/测试按原文案断言）。
 *
 * @param count 连续被拒绝的手指触摸次数（非法值按阈值处理）
 */
export function fingerRejectNoticeOnBoard(count: number): string {
  const times: number = Number.isFinite(count) && count > 0 ? Math.floor(count) : FINGER_REJECT_THRESHOLD;
  return `已连续忽略 ${times} 次手指输入：当前开启了「仅手写笔输入」，请改用手写笔书写（可在「笔迹 → 更多」里关闭）`;
}

