/**
 * 平台门控（纯逻辑，不 import 鸿蒙 SDK 运行时）。
 *
 * ArkUI-X 用同一份 ArkTS 同时构建 HarmonyOS 与 Android。Android 侧没有 OCR / 手写 /
 * PixelMap 截图能力，因此所有相关入口都必须先用 `isHarmonyOS()` 判断，且 UI 静态隐藏。
 *
 * 事实来源：`globalThis.__arkuiXPlatform`（由 EntryAbility 启动时写入），缺省视为 `'harmony'`。
 * 平台写入方有两级：`devicePlatform.ets` 的运行期检测（`detectPlatformFrom` 从这里导出）优先，
 * 构建期的平台覆盖层 `platformFeatures.ts` 兜底。
 * 契约：`docs/CONTRACT.md` §3.2。
 */

export type PlatformName = 'harmony' | 'android';

/** 承载平台标识的全局键名（ArkUI-X 启动时由 EntryAbility 显式写入）。 */
export const PLATFORM_GLOBAL_KEY = '__arkuiXPlatform';

type GlobalBag = { [key: string]: unknown };

function globalBag(): GlobalBag {
  return globalThis as unknown as GlobalBag;
}

/** 显式设置当前平台（同时写回 `globalThis`，页面/组件读取到同一状态）。 */
export function setPlatform(name: PlatformName): void {
  globalBag()[PLATFORM_GLOBAL_KEY] = name === 'android' ? 'android' : 'harmony';
}

/** 读取当前平台；未设置或值无法识别时判定为 HarmonyOS。 */
export function getPlatform(): PlatformName {
  const value = globalBag()[PLATFORM_GLOBAL_KEY];
  return value === 'android' ? 'android' : 'harmony';
}

/** 是否处于 HarmonyOS 侧（手写、OCR、PixelMap、Canvas 截图等能力仅在此时可用）。 */
export function isHarmonyOS(): boolean {
  return getPlatform() !== 'android';
}

/**
 * 依据设备信息推断平台（**纯函数**，无 @ohos 依赖，可在 Node 单测）。
 *
 * 这是「运行时检测」的第二道防线：即使 `build-profile.json5` 的 `sourceRoots` 装配没有生效，
 * 也能在设备侧纠正 `setPlatform()` 的结果（`entry/src/harmony/ets/common/devicePlatform.ets`
 * 把真实 `deviceInfo` 喂进来）。
 *
 * 判定顺序：
 * 1. `osFullName` / `deviceType` 任一含 `harmony` 或 `ohos`（大小写不敏感）→ `'harmony'`；
 * 2. 含 `android` → `'android'`；
 * 3. 无法判定（含空串、缺省、异常）→ `'android'`（**fail-closed**：宁可关功能，不可在 Android
 *    产物里暴露鸿蒙专属入口）。
 *
 * @param osFullName `deviceInfo.osFullName`（如 `OpenHarmony 5.0.0` / `Android 14`），可选
 * @param deviceType `deviceInfo.deviceType`（如 `phone` / `tablet`），仅作兜底证据
 */
export function detectPlatformFrom(osFullName?: string, deviceType?: string): PlatformName {
  const evidence: string[] = [];
  if (typeof osFullName === 'string') {
    evidence.push(osFullName.toLowerCase());
  }
  if (typeof deviceType === 'string') {
    evidence.push(deviceType.toLowerCase());
  }
  for (const text of evidence) {
    if (text.includes('harmony') || text.includes('ohos')) {
      return 'harmony';
    }
  }
  for (const text of evidence) {
    if (text.includes('android')) {
      return 'android';
    }
  }
  return 'android';
}
