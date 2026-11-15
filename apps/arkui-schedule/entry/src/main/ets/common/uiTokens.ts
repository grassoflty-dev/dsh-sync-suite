/**
 * UI 设计令牌（Design Tokens）。
 *
 * 约束（必须保持）：
 * - **纯常量 + 纯函数**，不 import 任何 SDK / `$r()` / ArkUI 类型，因此可以被
 *   `tools/tsconfig.json` 编译成 JS 并由 Node 单测直接验证（`tools/test/uiTokens.test.mjs`）；
 * - 只有三个字号层级：标题 / 正文 / 辅助（`FONT`），不允许页面里再出现第四个字号；
 * - 只有五档间距：4 / 8 / 12 / 16 / 24（`SPACING`），不允许页面里写 5 / 10 / 14 / 20 这类值；
 * - 颜色不在这里：颜色必须走 `$r('app.color.*')` 资源（深色模式由 `resources/dark` 覆盖）。
 *
 * 断点（与 `docs/UI-DESIGN.md` §3 一致）：
 * - `compact`  : 宽度 < 600vp   → 单列；
 * - `medium`   : 600 ≤ 宽度 ≤ 840vp → 双列（或用 expanded 的窄版）；
 * - `expanded` : 宽度 > 840vp   → 双列 / 主从布局。
 *
 * 横屏特例：`resolveBreakpoint()` 在横屏下**至少返回 `medium`**。理由：横屏时可用宽度被
 * 高度换掉了（例如 568×320vp 的手机横屏），若仍按宽度判 `compact` 走单列，纵向只剩 320vp
 * 可滚动，反而更挤；横屏天然应该用左右分栏把宽度用起来。这样页面只需要判断
 * `breakpoint === 'compact'` 就能决定「单列 vs 双栏」，不必各自再写方向判断。
 */

/** 断点定义。 */
export interface Breakpoint {
  /** 断点名（页面只允许用它做粗粒度分支）。 */
  name: 'compact' | 'medium' | 'expanded';
  /** 该断点的最小宽度（vp，含）。 */
  minWidth: number;
  /** 该断点下的默认列数。 */
  columns: number;
}

/** 间距令牌（vp），五档。 */
export interface SpacingTokens {
  xs: number;
  sm: number;
  md: number;
  lg: number;
  xl: number;
}

/** 圆角令牌（vp）。 */
export interface RadiusTokens {
  none: number;
  sm: number;
  md: number;
}

/** 字号令牌（fp），只有三级。 */
export interface FontTokens {
  title: number;
  body: number;
  caption: number;
}

/** 行高令牌（fp），与 `FONT` 一一对应。 */
export interface LineHeightTokens {
  title: number;
  body: number;
  caption: number;
}

/**
 * 断点表（升序，`minWidth` 单调递增）。
 *
 * 数值取 Material 3 的窗口尺寸类：600 / 840。
 */
export const BREAKPOINTS: Breakpoint[] = [
  { name: 'compact', minWidth: 0, columns: 1 },
  { name: 'medium', minWidth: 600, columns: 2 },
  { name: 'expanded', minWidth: 841, columns: 2 }
];

/** 间距：4 / 8 / 12 / 16 / 24（vp）。 */
export const SPACING: SpacingTokens = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };

/**
 * 圆角：0 / 8 / 12（vp）。
 *
 * 卡片、列表行、分割线区域一律 `none`（0，直角 + 细线取代卡片）；按钮/输入框用 `sm`；
 * `md` 只留给浮层（弹窗、预览遮罩内的面板）。
 */
export const RADIUS: RadiusTokens = { none: 0, sm: 8, md: 12 };

/** 字号：标题 20 / 正文 16 / 辅助 14（fp）。 */
export const FONT: FontTokens = { title: 20, body: 16, caption: 14 };

/** 行高：标题 28 / 正文 24 / 辅助 20（fp）。 */
export const LINE_HEIGHT: LineHeightTokens = { title: 28, body: 24, caption: 20 };

/** 触控目标最小边长（vp）：小于它的可点击控件必须补 padding 或 hitTestBehavior。 */
export const TOUCH_MIN: number = 40;

/** 细分割线宽度（vp）。 */
export const DIVIDER: number = 1;

/** 横屏判定阈值：宽高比大于该值视为横屏（避免 1:1 方屏误判）。 */
export const LANDSCAPE_ASPECT: number = 1.0;

/**
 * 是否横屏尺寸：宽 > 高。
 *
 * 供 `onAreaChange` 里拿到的宽高直接用（`isLandscapeSize(area.width, area.height)`），
 * 不依赖 `mediaquery` / `display` 之类 SDK 调用。
 */
export function isLandscapeSize(widthVp: number, heightVp: number): boolean {
  if (!Number.isFinite(widthVp) || !Number.isFinite(heightVp)) {
    return false;
  }
  return widthVp > heightVp * LANDSCAPE_ASPECT;
}

/**
 * 由宽度（vp）与方向解析断点。
 *
 * 横屏时不低于 `medium`（见文件头「横屏特例」）。
 * 宽度非法（NaN / 负数）时按 `compact` 处理，保证永远返回合法断点。
 */
export function resolveBreakpoint(widthVp: number, landscape: boolean): 'compact' | 'medium' | 'expanded' {
  let width = widthVp;
  if (!Number.isFinite(width) || width < 0) {
    width = 0;
  }
  let name: 'compact' | 'medium' | 'expanded' = 'compact';
  if (width > 840) {
    name = 'expanded';
  } else if (width >= 600) {
    name = 'medium';
  }
  if (landscape && name === 'compact') {
    return 'medium';
  }
  return name;
}

/** 该断点是否算「宽」（可以用双栏 / 主从布局）。 */
export function isWide(breakpoint: string): boolean {
  return breakpoint === 'medium' || breakpoint === 'expanded';
}

/** 该断点是否算「紧凑」（必须单列）。 */
export function isCompact(breakpoint: string): boolean {
  return !isWide(breakpoint);
}

/** 断点对应的默认列数（未知断点名回落单列，fail-safe）。 */
export function columnsFor(breakpoint: string): number {
  for (const item of BREAKPOINTS) {
    if (item.name === breakpoint) {
      return item.columns;
    }
  }
  return 1;
}

/** 断点对应的最小宽度（未知断点名回落 0）。 */
export function minWidthFor(breakpoint: string): number {
  for (const item of BREAKPOINTS) {
    if (item.name === breakpoint) {
      return item.minWidth;
    }
  }
  return 0;
}

/**
 * 双栏布局里「侧栏」宽度：紧凑屏不用它；宽屏取 1/3 且夹在 280–420vp。
 *
 * 保证侧栏既放得下日期条 / 手写预览，又不会把主列表挤到 300vp 以下。
 */
export function sidebarWidth(contentWidthVp: number): number {
  if (!Number.isFinite(contentWidthVp) || contentWidthVp <= 0) {
    return 280;
  }
  const third = Math.round(contentWidthVp / 3);
  if (third < 280) {
    return contentWidthVp >= 280 ? 280 : contentWidthVp;
  }
  if (third > 420) {
    return 420;
  }
  return third;
}

/** 可点击元素的实际高度是否需要补足到 `TOUCH_MIN`，返回需要补的 padding（vp，0 表示不用补）。 */
export function touchPadding(heightVp: number): number {
  const diff = TOUCH_MIN - heightVp;
  if (!Number.isFinite(diff) || diff <= 0) {
    return 0;
  }
  return Math.ceil(diff / 2);
}
