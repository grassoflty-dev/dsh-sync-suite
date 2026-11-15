/**
 * 手写笔适配层（**仅 HarmonyOS**，所有 SDK 调用都在 try/catch 里，失败只降级不崩页面）。
 *
 * 只保留两件「锦上添花」的能力，都不影响主书写链路：
 * - `stylusInteraction`：手写笔**轻捏切橡皮 / 双击撤销**（需 `SystemCapability.Stylus.StylusService`）；
 * - `StylusFrameBoost`：书写时请求**帧率提升**（需 `ohos.permission.STYLUS_FRAME_BOOST`，API 26+）。
 *
 * 设计约束：
 * - 页面（`HandwritingPager.ets`）只依赖这里的布尔返回值，SDK 挂了页面照常手写；
 * - 失败日志以 `STYLUS` 前缀输出且**每个失败点只打一次**（`hilog | grep STYLUS` 即可取证）；
 * - 2026-11-15 起本文件只保留上面两项能力（形状识别类能力已随对应功能一起移除）。
 */
import { StylusFrameBoost, stylusInteraction } from '@kit.Penkit';

/** 把异常转成可展示文本（`catch` 里的类型在 ArkTS 里不可直接当 Error 用）。 */
function describeError(error: object): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * 手写笔交互 / 帧率提升助手。
 *
 * 两者都是「拿到就用、拿不到就静默禁用」：轻捏/双击注册失败会退化成纯手写；
 * 帧率提升失败（无权限 201 或能力不支持）会永久禁用，避免每次触摸都刷日志。
 */
export class StylusAssist {
  /** 快捷操作是否注册成功（失败后不再重试）。 */
  private static shortcutsOn: boolean = false;
  private static shortcutsFailed: boolean = false;
  /** 帧率提升是否已禁用（失败后不再重试，避免每次触摸都刷日志）。 */
  private static boostFailed: boolean = false;
  /** 帧率提升实例（每次触摸都会调用，必须复用，不能每次都 new）。 */
  private static boost: StylusFrameBoost | null = null;

  /**
   * 注册手写笔快捷操作。任一步失败 → 返回 `false` 并把该能力整体禁用（页面照常手写）。
   */
  static enableShortcuts(onSqueeze: () => void, onDoubleTap: () => void): boolean {
    if (StylusAssist.shortcutsOn) {
      return true;
    }
    if (StylusAssist.shortcutsFailed) {
      return false;
    }
    try {
      stylusInteraction.on('squeeze', (): void => {
        onSqueeze();
      });
      stylusInteraction.on('doubleTap', (): void => {
        onDoubleTap();
      });
      StylusAssist.shortcutsOn = true;
      console.info('STYLUS shortcuts_ready');
      return true;
    } catch (error) {
      StylusAssist.shortcutsFailed = true;
      console.info(`STYLUS sdk_failed shortcuts: ${describeError(error as object)}`);
      return false;
    }
  }

  /** 取消注册（页面销毁时调用；`receiver` 省略 = 全部取消）。 */
  static disableShortcuts(): void {
    if (!StylusAssist.shortcutsOn) {
      return;
    }
    StylusAssist.shortcutsOn = false;
    try {
      stylusInteraction.off('squeeze');
      stylusInteraction.off('doubleTap');
    } catch {
      // 取消失败忽略
    }
  }

  /**
   * 请求提升一帧书写帧率：`action` 0=按下、1=抬起、2=移动、3=取消。
   * 无权限（201）/能力不可用 → 返回 `false` 并永久禁用。
   */
  static boostFrame(action: number): boolean {
    if (StylusAssist.boostFailed) {
      return false;
    }
    try {
      if (StylusAssist.boost === null) {
        StylusAssist.boost = new StylusFrameBoost();
      }
      const boost: StylusFrameBoost = StylusAssist.boost;
      const code: number = boost.forceRefreshOneFrame(action);
      if (code !== 0) {
        StylusAssist.boostFailed = true;
        StylusAssist.boost = null;
        console.info(`STYLUS sdk_failed frame_boost code=${code}`);
        return false;
      }
      return true;
    } catch (error) {
      StylusAssist.boostFailed = true;
      StylusAssist.boost = null;
      console.info(`STYLUS sdk_failed frame_boost: ${describeError(error as object)}`);
      return false;
    }
  }

  /** 是否已永久禁用帧率提升（页面据此跳过后续调用）。 */
  static boostDisabled(): boolean {
    return StylusAssist.boostFailed;
  }
}
