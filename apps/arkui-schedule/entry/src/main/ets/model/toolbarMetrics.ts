/**
 * 手写板工具条尺寸：**按视口比例自适应**（纯逻辑，零 SDK import）。
 *
 * 背景（2026-11-16 定版）：`Handwriting.ets` 里工具条控件的尺寸原本是写死的
 * 48 / 72 / 44 / 40，平板与手机共用同一套数字 —— 大屏上控件偏小、窄屏上又放不下。
 * 现在统一由本模块按「当前视口 + 横竖屏」算出一组尺寸，页面只消费结果，不再写死数字。
 *
 * 一组 `ToolbarMetrics` 同时服务两套布局：
 * - 竖屏：顶部横排工具条（`barThickness` = **工具条高度**）；
 * - 横屏：左侧竖排 rail（`barThickness` = **rail 宽度**）。
 *
 * 规则（与 `tools/test/toolbarMetrics.test.mjs` 一一对应）：
 * - 竖屏：`barThickness = clamp(48, viewportH × 0.09, 64)`、`itemSize = clamp(40, viewportW × 0.11, 64)`；
 * - 横屏：`barThickness = clamp(56, viewportW × 0.045, 84)`、`itemSize = clamp(40, viewportH × 0.12, 72)`；
 * - 派生：`gap = itemSize × 0.15`、`iconSize = itemSize × 0.5`、`fontSize = clamp(12, itemSize × 0.32, 18)`；
 * - 非法视口（0 / 负数 / NaN / Infinity）→ 退化成竖屏 360×780 的默认值，**不抛异常**；
 * - 所有返回值保留 1 位小数（`Math.round(x × 10) / 10`），避免亚像素抖动导致控件宽度来回跳。
 *
 * 为什么不读 `display` / `mediaquery`：页面已经在 `onAreaChange` 里拿到视口宽高与方向，
 * 这里只做纯函数换算，Node 单测可直接跑，不需要 SDK。
 */

/** 一组工具条尺寸（vp / fp）。 */
export interface ToolbarMetrics {
  /** 工具条「厚度」：竖屏 = 顶部条高度；横屏 = rail 宽度（vp）。 */
  barThickness: number;
  /** 单个控件的方形边长（vp）：同时用作控件高度与最小宽度。 */
  itemSize: number;
  /** 控件之间的间距（vp）。 */
  gap: number;
  /** 自绘图标的基准尺寸（vp）。 */
  iconSize: number;
  /** 工具条文字字号（fp）。 */
  fontSize: number;
}

/** 非法视口退化的默认竖屏视口（vp）：与手写板最小目标机型一致。 */
export const FALLBACK_VIEWPORT_W: number = 360;
export const FALLBACK_VIEWPORT_H: number = 780;

/** 竖屏顶部条高度区间（vp）：定版要求「≥48、≤64」。 */
const PORTRAIT_BAR_MIN: number = 48;
const PORTRAIT_BAR_RATIO: number = 0.09;
const PORTRAIT_BAR_MAX: number = 64;

/** 竖屏单个控件边长区间（vp）：下限 40 = `TOUCH_MIN`，上限 64（再大就把工具条吃光了）。 */
const PORTRAIT_ITEM_RATIO: number = 0.11;
const PORTRAIT_ITEM_MAX: number = 64;

/** 横屏 rail 宽度区间（vp）。 */
const LANDSCAPE_BAR_MIN: number = 56;
const LANDSCAPE_BAR_RATIO: number = 0.045;
const LANDSCAPE_BAR_MAX: number = 84;

/** 横屏单个控件边长区间（vp）：rail 是竖向的，所以按**高度**算。 */
const LANDSCAPE_ITEM_RATIO: number = 0.12;
const LANDSCAPE_ITEM_MAX: number = 72;

/** 单个控件边长的公共下限（vp）：小于它就没法点了（与 `TOUCH_MIN` 同量级）。 */
const ITEM_MIN: number = 40;

/** 间距 / 图标 / 字号的派生比例。 */
const GAP_RATIO: number = 0.15;
const ICON_RATIO: number = 0.5;
const FONT_MIN: number = 12;
const FONT_RATIO: number = 0.32;
const FONT_MAX: number = 18;

/** 上限/下限夹紧（输入必须是有限数，调用方已保证）。 */
function clampValue(min: number, value: number, max: number): number {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

/** 保留 1 位小数（消除浮点尾数，避免布局抖动）。 */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** 视口是否可用于换算（有限且为正）。 */
function isUsableViewport(widthVp: number, heightVp: number): boolean {
  if (!Number.isFinite(widthVp) || !Number.isFinite(heightVp)) {
    return false;
  }
  return widthVp > 0 && heightVp > 0;
}

/**
 * 由视口宽高 + 横竖屏算出工具条尺寸。
 *
 * @param viewportW 视口宽度（vp，`onAreaChange` 的 `area.width`）
 * @param viewportH 视口高度（vp）
 * @param landscape 是否横屏（页面用 `isLandscapeSize()` 判出来）
 * @returns 全部字段为 1 位小数的 `ToolbarMetrics`；非法输入返回竖屏 360×780 的默认值
 */
export function toolbarMetrics(viewportW: number, viewportH: number, landscape: boolean): ToolbarMetrics {
  const usable: boolean = isUsableViewport(viewportW, viewportH);
  const width: number = usable ? viewportW : FALLBACK_VIEWPORT_W;
  const height: number = usable ? viewportH : FALLBACK_VIEWPORT_H;
  const isLandscape: boolean = usable ? landscape : false;

  let barThickness: number;
  let itemSize: number;
  if (isLandscape) {
    barThickness = clampValue(LANDSCAPE_BAR_MIN, width * LANDSCAPE_BAR_RATIO, LANDSCAPE_BAR_MAX);
    itemSize = clampValue(ITEM_MIN, height * LANDSCAPE_ITEM_RATIO, LANDSCAPE_ITEM_MAX);
  } else {
    barThickness = clampValue(PORTRAIT_BAR_MIN, height * PORTRAIT_BAR_RATIO, PORTRAIT_BAR_MAX);
    itemSize = clampValue(ITEM_MIN, width * PORTRAIT_ITEM_RATIO, PORTRAIT_ITEM_MAX);
  }

  const metrics: ToolbarMetrics = {
    barThickness: round1(barThickness),
    itemSize: round1(itemSize),
    gap: round1(itemSize * GAP_RATIO),
    iconSize: round1(itemSize * ICON_RATIO),
    fontSize: round1(clampValue(FONT_MIN, itemSize * FONT_RATIO, FONT_MAX))
  };
  return metrics;
}
