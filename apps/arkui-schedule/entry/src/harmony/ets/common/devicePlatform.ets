/**
 * 设备平台探测 —— **HarmonyOS 覆盖实现**。
 *
 * 与共享层 `entry/src/main/ets/common/devicePlatform.ets` 同名相对路径，`sourceRoots`
 * 装配生效时整体替换共享实现（`docs/CONTRACT.md` §3.1），因此这里可以安全地静态 import
 * `@ohos.deviceInfo` —— 该模块只存在于鸿蒙构建的输入里，Android 产物看不到本文件。
 *
 * 判定交给纯函数 `detectPlatformFrom`（`common/platform.ts`，无 SDK 依赖、Node 可单测）：
 * `osFullName` 是主证据（`OpenHarmony 5.0.0` 含 `ohos`），`deviceType` 兜底；
 * 读取失败或无法判定一律 `'android'`（fail-closed，第二道防线）。
 */
import deviceInfo from '@ohos.deviceInfo';
import { detectPlatformFrom } from './platform';
import type { PlatformName } from './platform';

/** 探测当前设备平台（鸿蒙覆盖实现：读 deviceInfo → 纯函数判定）。 */
export async function detectPlatform(): Promise<PlatformName> {
  try {
    // 注意：这里**不用** `deviceInfo as Record<string, string>` 的断言 —— 在 ArkTS 严格模式下，
    // 命名空间对象到 Record 的断言会被判「类型不重叠」（TS2352）。直接读字段即可：
    // SDK 声明保证 osFullName/deviceType 是 string，字段异常时交给 detectPlatformFrom 兜底。
    const osFullName: string = deviceInfo.osFullName;
    const deviceType: string = deviceInfo.deviceType;
    return detectPlatformFrom(osFullName, deviceType);
  } catch (error) {
    // 读取 deviceInfo 失败时按 Android 降级，绝不猜测成 harmony 打开手写/OCR。
    return 'android';
  }
}
