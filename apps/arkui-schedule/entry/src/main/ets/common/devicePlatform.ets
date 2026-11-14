/**
 * 设备平台探测 —— **共享默认实现**（Android / 未知平台走本文件）。
 *
 * 平台覆盖语义（`docs/CONTRACT.md` §3.1）：构建某平台时源码 = `main` + 该平台目录，
 * 同名相对路径以后者为准。鸿蒙构建时 `entry/src/harmony/ets/common/devicePlatform.ets`
 * 会整体替换本文件，改读 `@ohos.deviceInfo` 再交给纯函数 `detectPlatformFrom` 判定。
 *
 * 因此本文件必须 **fail-closed**：没有 `@ohos.deviceInfo` 的构建（Android）一律返回
 * `'android'`，绝不猜测成 `'harmony'` 而打开手写/OCR 入口（BRIEF §3.3）。
 *
 * 本文件被 `entryability/EntryAbility.ets` 静态 import；因为它**不引用任何鸿蒙 SDK**，
 * 所以 Android 产物可以正常编译。
 */
import type { PlatformName } from './platform';

/** 探测当前设备平台（共享默认实现：按 Android 处理，fail-closed）。 */
export async function detectPlatform(): Promise<PlatformName> {
  return 'android';
}
