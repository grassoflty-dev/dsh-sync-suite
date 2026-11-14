/**
 * 平台门控（纯逻辑，不 import 鸿蒙 SDK 运行时）。
 *
 * ArkUI-X 用同一份 ArkTS 同时构建 HarmonyOS 与 Android。Android 侧没有 OCR / 手写 /
 * PixelMap 截图能力，因此所有相关入口都必须先用 `isHarmonyOS()` 判断，且 UI 静态隐藏。
 *
 * 事实来源：`globalThis.__arkuiXPlatform`（由 EntryAbility 启动时写入），缺省视为 `'harmony'`。
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
