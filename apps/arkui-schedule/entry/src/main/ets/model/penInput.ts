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
