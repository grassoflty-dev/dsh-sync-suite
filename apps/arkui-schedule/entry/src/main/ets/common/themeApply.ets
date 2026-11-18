/**
 * 主题落地（**SDK 侧**）：把纯逻辑的三态（`model/theme.ts`）接到 ArkUI 的 `ColorMode`。
 *
 * 为什么单独一个 `.ets`：`model/theme.ts` 必须保持零 SDK import 才能被 Node 单测直接
 * import，而「三态 → `ConfigurationConstant.ColorMode`」的映射、以及「当前系统是不是深色」
 * 只能靠 SDK 读。于是分工是：**判定在 model/theme.ts，落地在这里**。
 *
 * 三个调用点（改这里就够，别各写一份 enum 映射）：
 * 1. `entryability/EntryAbility.ets`：启动时按持久化值设置一次；
 * 2. `pages/Settings.ets`：用户切换三态时立即生效；
 * 3. `harmony/ets/pages/Handwriting.ets`：画布内绘制色用不了 `$r()`，需要知道当前是深是浅。
 *
 * 注意：`system` 必须用 `COLOR_MODE_NOT_SET`（不是「跟随系统」的字面量），
 * 传 `COLOR_MODE_LIGHT` 会把 App 钉死在浅色、系统切深色时不再跟随。
 */
import { ConfigurationConstant, common } from '@kit.AbilityKit';
// `Configuration.colorMode` 的类型来自 `resourceManager`，比较时必须用它的枚举（不要用
// `ConfigurationConstant.ColorMode`，那是「设置入口」用的另一套枚举，两者不能互比）。
import { resourceManager } from '@kit.LocalizationKit';
import { clampFontScale, normalizeThemeMode } from '../model/theme';
import type { ThemeMode } from '../model/theme';

/** 三态 → ArkUI `ColorMode`（未知/空按 `system` 处理）。 */
export function colorModeOf(mode: string): ConfigurationConstant.ColorMode {
  const normalized: ThemeMode = normalizeThemeMode(mode);
  if (normalized === 'light') {
    return ConfigurationConstant.ColorMode.COLOR_MODE_LIGHT;
  }
  if (normalized === 'dark') {
    return ConfigurationConstant.ColorMode.COLOR_MODE_DARK;
  }
  return ConfigurationConstant.ColorMode.COLOR_MODE_NOT_SET;
}

/**
 * 立即应用三态（`setColorMode`）。
 *
 * 返回值只表示「这一步有没有抛错」，不阻塞任何流程：设置页切换时如果 API 调用失败，
 * 页面仍然把值落盘（下次启动照样生效），不因为一次 API 失败就把用户的选择吞掉。
 */
export function applyThemeMode(context: common.Context, mode: string): boolean {
  try {
    context.getApplicationContext().setColorMode(colorModeOf(mode));
    return true;
  } catch {
    return false;
  }
}

/**
 * 当前系统是否深色（`resolveTheme('system', isSystemDark(...))` 的那半个入参）。
 *
 * 读 `resourceManager.getConfigurationSync().colorMode`（`@since 10`，跨平台可用）。
 * 注意**不能用 `context.config`**：本 SDK 的 `Context` 没有 `config` 属性（只有
 * `resourceManager` / `filesDir` 这类），写了编译不过。
 * 任何异常都按浅色处理（fail-safe：浅色是默认档）。
 */
export function isSystemDark(context: common.Context): boolean {
  try {
    // 本 SDK 的 `Configuration.colorMode` 是 `resourceManager.ColorMode`，
    // **不能**与 `ConfigurationConstant.ColorMode` 比较（枚举不同名空间，编译期就报错）。
    const configuration = context.resourceManager.getConfigurationSync();
    return configuration.colorMode === resourceManager.ColorMode.DARK;
  } catch {
    return false;
  }
}

/**
 * 系统字体缩放倍率（夹到 `[1.0, 1.6]`，见 `model/theme.ts` 的 `clampFontScale`）。
 *
 * 仅供**需要自己算宽度/高度的非文本控件**参考：`fp` 字号本身已跟随系统缩放，
 * 页面**不需要**拿它去乘字号（乘了会放大两次）。
 *
 * 说明：本 SDK 的 `resourceManager.Configuration` **没有** `fontSizeScale` 字段
 * （那是 `ConfigurationConstant` 之外的另一套 API），所以这里不读系统值、直接回 1.0；
 * 保留函数是为了让调用方接口稳定（将来 SDK 提供该字段时只改这一处）。
 */
export function systemFontScale(context: common.Context): number {
  void context;
  return clampFontScale(1);
}
