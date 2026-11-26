/**
 * mod-app-remote-glyph-rail-polish（App 远程页）：浮动图标轨与 DSH 页面的**唯一几何事实来源**。
 *
 * 缺陷（Lead 截图）：`‹` / `↻` / `ⓘ` 三个字形是浮在页面**上面**的（`Stack` 里最后一个孩子），
 * 于是图标轨压在 DSH 页面自己的会话正文上——页面内容被我们自己的控件盖住。
 * 产品决定不变（`mod-app-remote-page-pure`）：成功路径上屏幕里只允许有 DSH 页面本身，
 * 不许为了避让再加标题栏 / 说明文字 / 顶栏。因此这里**不删图标轨、不加 chrome**，只改几何：
 *
 *   图标轨向左让出一条**保留槽（gutter）**，DSH 页面（WebView）整体右移这条槽的宽度，
 *   于是「页面」永远在图标轨右侧，图标轨永远不压在页面内容上。
 *
 * 本文件只做纯函数换算：零 SDK import、零 UI import，因此可被 `tools/tsconfig.json` 编译
 * 成 JS 由 Node 单测逐行验证（`tools/test/glyphRailLayout.test.mjs`）；`.ets` 只消费结果。
 *
 * 几何规则（与测试表逐条对应，单位都是 vp）：
 * - 有效视口 = `viewportW × viewportH`；安全区 = 视口去掉 上/下/左/右 四个 inset 后的盒子；
 * - `glyphSize` 夹在 `[GLYPH_TOUCH_MIN_VP, GLYPH_MAX_VP]`（默认 `GLYPH_DEFAULT_VP`）——
 *   **下限 44vp 是硬约束**：再小就不是「图标的触控目标」而是「看得见的像素」；
 * - `gap` 夹在 `[GAP_MIN_VP, GAP_MAX_VP]`（默认 `GAP_DEFAULT_VP`）；
 * - 窄屏规则：`viewportW < NARROW_VIEWPORT_VP` 时 `glyphSize` 直接取硬下限、`gap` 取最小值，
 *   把保留槽压到最小（44 + 2×4 = 52vp），**不改变任何不变量**；
 * - `railRect`：宽 = `glyphSize`，高 = `glyphCount × glyphSize + (glyphCount − 1) × gap`，
 *   左边缘 `safeAreaLeft + gap`，竖直方向在安全区内**居中**；
 * - `contentRect`（WebView 盒子）：左边缘 = `railRect` 右边缘 + `gap`，竖直占满安全区；
 *   保留槽 `gutter = contentRect.x − safeAreaLeft = glyphSize + 2 × gap`
 *   ——即「rail 宽 + 一个 gap」在 rail 外侧，另外再让出 rail 与安全区边之间的那个 gap；
 * - 退化（typed，绝不静默重叠）：视口非法 / 安全区非法 / 内容宽度 < `MIN_CONTENT_WIDTH_VP` /
 *   内容高度 < `MIN_CONTENT_HEIGHT_VP` / rail 比安全区还高。退化时 `railVisible = false`、
 *   `railRect` 为零盒、`contentRect` 退成**整块安全区**（页面铺满，图标轨不画），
 *   页面因此既不会出现重叠，也不会出现「半条空槽」。
 *
 * 为什么退化时选择「不画图标轨」而不是「缩小页面」：44vp 已经是触控硬下限，再压就只能
 * 牺牲可点性；而 degenerate 只会在视口荒谬（≈0、安全区吃满视口）时出现，那时页面本身
 * 也没法读。宁可如实把 rail 藏起来，也不留一个压在内容上的图标。
 */

/** 矩形（vp）：左上角 + 宽高。`railRect` 与 `contentRect` 共用同一形状，便于直接做相交判定。 */
export interface RectBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 布局结论的 typed 原因。
 * - `ok` / `narrow`：可用（`narrow` 表示走了窄屏规则）；
 * - 其余为退化态：**没有**可用图标轨，页面铺满安全区。
 */
export type GlyphRailReason =
  | 'ok'
  | 'narrow'
  | 'E_VIEWPORT_INVALID'
  | 'E_SAFE_AREA_INVALID'
  | 'E_CONTENT_TOO_NARROW'
  | 'E_CONTENT_TOO_SHORT'
  | 'E_RAIL_TOO_TALL';

/** 入参：全部是页面已经拿得到的状态位（视口 / 安全区 / 图标数 / 设计令牌），不新增持久化字段。 */
export interface GlyphRailInput {
  /** 视口宽（vp）：页面根容器的 `onAreaChange` 宽。 */
  viewportW: number;
  /** 视口高（vp）。 */
  viewportH: number;
  /** 安全区上 inset（vp）。 */
  safeAreaTop: number;
  /** 安全区下 inset（vp）。 */
  safeAreaBottom: number;
  /** 安全区左 inset（vp）。 */
  safeAreaLeft: number;
  /** 安全区右 inset（vp）。 */
  safeAreaRight: number;
  /** 期望的单个字形边长（vp）；非法 / 0 → `GLYPH_DEFAULT_VP`。 */
  glyphSize: number;
  /** 期望的字形间距（vp）；非法 / 0 → `GAP_DEFAULT_VP`。 */
  gap: number;
  /** 可见字形个数（1..3）；非法 → 1。 */
  glyphCount: number;
}

/** 布局结论（页面的唯一几何输入）。 */
export interface GlyphRailLayout {
  /** 是否可用（`railVisible` 与它同真同假）。 */
  ok: boolean;
  /** typed 原因（见 `GlyphRailReason`）。 */
  reason: GlyphRailReason;
  /** 实际使用的字形边长（vp）：恒 ≥ `GLYPH_TOUCH_MIN_VP`。 */
  glyphSize: number;
  /** 实际使用的字形间距（vp）。 */
  gap: number;
  /** 规范化后的字形个数（1..3）。 */
  glyphCount: number;
  /** 图标轨盒子；不可用时为零盒。 */
  railRect: RectBox;
  /** WebView 盒子；不可用时是整块安全区（页面铺满）。 */
  contentRect: RectBox;
  /** 保留槽宽（vp）= `contentRect.x − safeAreaLeft`；不可用时为 0。 */
  gutter: number;
  /** 是否渲染图标轨；只有 `ok` 为真才画。 */
  railVisible: boolean;
}

/** 图标触控目标的硬下限（vp）：产品约束「每个字形 ≥ 44vp」。 */
export const GLYPH_TOUCH_MIN_VP: number = 44;

/** 默认字形边长（vp）：舒适档，比硬下限宽 4vp。 */
export const GLYPH_DEFAULT_VP: number = 48;

/** 字形边长上限（vp）：再大就把平板竖屏的可用宽度吃掉了。 */
export const GLYPH_MAX_VP: number = 56;

/** 字形间距下限（vp）= `SPACING.xs`。 */
export const GAP_MIN_VP: number = 4;

/** 默认字形间距（vp）= `SPACING.xs`。 */
export const GAP_DEFAULT_VP: number = 4;

/** 字形间距上限（vp）= `SPACING.md`。 */
export const GAP_MAX_VP: number = 12;

/** 窄屏阈值（vp）：比它更窄的视口走窄屏规则（字形 / 间距都取硬下限）。 */
export const NARROW_VIEWPORT_VP: number = 480;

/** 页面（WebView）允许的最小内容宽（vp）：低于它就退化，不再压页面。 */
export const MIN_CONTENT_WIDTH_VP: number = 240;

/** 页面允许的最小内容高（vp）：低于它就退化（横屏矮窗 / 安全区吃满）。 */
export const MIN_CONTENT_HEIGHT_VP: number = 160;

/** 图标轨最多三个字形：返回 / 刷新 / 诊断。 */
export const MAX_GLYPH_COUNT: number = 3;

/** 有限且为正（视口类输入的唯一合法性判定）。 */
function isPositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/** 有限且非负（安全区 inset 的合法性判定；负数一律视为非法，不做静默夹紧）。 */
function isInset(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/** 上限/下限夹紧（调用方已保证输入有限）。 */
function clampValue(min: number, value: number, max: number): number {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

/** 保留 1 位小数（消除浮点尾数，避免布局在亚像素上来回抖）。 */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** 零盒（退化态图标轨）。 */
function zeroBox(): RectBox {
  return { x: 0, y: 0, width: 0, height: 0 };
}

/** 归一后的盒子（四个分量都保留 1 位小数）。 */
function boxOf(x: number, y: number, width: number, height: number): RectBox {
  return { x: round1(x), y: round1(y), width: round1(width), height: round1(height) };
}

/** 视口是否走窄屏规则（视口非法时不走：那种情况本来就要退化）。 */
function isNarrow(viewportW: number): boolean {
  return isPositive(viewportW) && viewportW < NARROW_VIEWPORT_VP;
}

/** 字形个数规范化：非有限 → 1；否则夹到 [1, MAX_GLYPH_COUNT]。 */
function normalizeGlyphCount(glyphCount: number): number {
  if (!Number.isFinite(glyphCount)) {
    return 1;
  }
  return Math.round(clampValue(1, glyphCount, MAX_GLYPH_COUNT));
}

/**
 * 字形边长：窄屏取硬下限，其余把期望值夹进 `[硬下限, 上限]`。
 *
 * 期望值非法（0 / 负数 / NaN / Infinity）→ 默认档；**任何分支都不会低于 44vp**。
 */
function resolveGlyphSize(requested: number, viewportW: number): number {
  if (isNarrow(viewportW)) {
    return GLYPH_TOUCH_MIN_VP;
  }
  const wanted: number = isPositive(requested) ? requested : GLYPH_DEFAULT_VP;
  return round1(clampValue(GLYPH_TOUCH_MIN_VP, wanted, GLYPH_MAX_VP));
}

/** 字形间距：窄屏取最小值，其余把期望值夹进 `[下限, 上限]`。 */
function resolveGap(requested: number, viewportW: number): number {
  if (isNarrow(viewportW)) {
    return GAP_MIN_VP;
  }
  const wanted: number = Number.isFinite(requested) && requested > 0 ? requested : GAP_DEFAULT_VP;
  return round1(clampValue(GAP_MIN_VP, wanted, GAP_MAX_VP));
}

/**
 * 退化结论。
 *
 * `contentRect` 由调用点决定：视口/安全区非法时是零盒（页面还没有可信尺寸），
 * 内容太窄/太矮时是整块安全区（尺寸可信，只是放不下图标轨）。
 */
function degenerate(reason: GlyphRailReason, contentRect: RectBox, glyphSize: number, gap: number,
  glyphCount: number): GlyphRailLayout {
  return {
    ok: false,
    reason: reason,
    glyphSize: glyphSize,
    gap: gap,
    glyphCount: glyphCount,
    railRect: zeroBox(),
    contentRect: contentRect,
    gutter: 0,
    railVisible: false
  };
}

/** 两个盒子是否真重叠（只贴边不算：内部交集为空即视作不相交）。 */
export function rectsIntersect(a: RectBox, b: RectBox): boolean {
  if (a.width <= 0 || a.height <= 0 || b.width <= 0 || b.height <= 0) {
    return false;
  }
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * 由视口 + 安全区 + 字形规格算出图标轨与 WebView 的盒子。
 *
 * 不变量（每一条都在测试表每一行上断言）：
 * 1. `rectsIntersect(railRect, contentRect) === false`；
 * 2. `railRect` 完全落在安全区内；
 * 3. `glyphSize ≥ GLYPH_TOUCH_MIN_VP`（且 `railRect.width ≥ glyphSize`）；
 * 4. `contentRect.width > 0`、`contentRect.height > 0`，且 `contentRect` 也在安全区内；
 * 5. `contentRect.x = railRect.x + railRect.width + gap`（两者之间恰好一个 gap，不是贴边）；
 * 6. `gutter = contentRect.x − safeAreaLeft = glyphSize + 2 × gap`（保留槽自洽）。
 *
 * 任何一行都不允许「静默重叠」：做不到就返回 `ok=false` 的 typed 退化结论。
 *
 * @param input 视口 / 安全区 / 字形规格
 * @returns 图标轨与页面盒子 + typed 原因
 */
export function glyphRailLayout(input: GlyphRailInput): GlyphRailLayout {
  const glyphCount: number = normalizeGlyphCount(input.glyphCount);
  const glyphSize: number = resolveGlyphSize(input.glyphSize, input.viewportW);
  const gap: number = resolveGap(input.gap, input.viewportW);
  const reasonForOk: GlyphRailReason = isNarrow(input.viewportW) ? 'narrow' : 'ok';

  // 1. 视口必须可信：拿到 0 / NaN 时不给任何几何（页面这一帧铺满，等 onAreaChange 再来）
  if (!isPositive(input.viewportW) || !isPositive(input.viewportH)) {
    return degenerate('E_VIEWPORT_INVALID', zeroBox(), glyphSize, gap, glyphCount);
  }

  // 2. 安全区 inset 必须非负有限；负数不是「小安全区」，是坏输入 → 退化，不静默夹紧
  if (!isInset(input.safeAreaTop) || !isInset(input.safeAreaBottom)
    || !isInset(input.safeAreaLeft) || !isInset(input.safeAreaRight)) {
    return degenerate('E_SAFE_AREA_INVALID', zeroBox(), glyphSize, gap, glyphCount);
  }

  const safeW: number = input.viewportW - input.safeAreaLeft - input.safeAreaRight;
  const safeH: number = input.viewportH - input.safeAreaTop - input.safeAreaBottom;
  if (safeW <= 0 || safeH <= 0) {
    return degenerate('E_SAFE_AREA_INVALID', zeroBox(), glyphSize, gap, glyphCount);
  }
  const safeBox: RectBox = boxOf(input.safeAreaLeft, input.safeAreaTop, safeW, safeH);

  // 3. 图标轨：宽 = 一个字形，高 = n 个字形的列 + (n−1) 个 gap；左边缘让出一个 gap，
  //    竖直在安全区内居中（不贴顶也不贴底，两侧都不会压到系统栏）。
  const railWidth: number = glyphSize;
  const railHeight: number = glyphCount * glyphSize + (glyphCount - 1) * gap;
  if (railHeight > safeH) {
    return degenerate('E_RAIL_TOO_TALL', safeBox, glyphSize, gap, glyphCount);
  }
  const railX: number = input.safeAreaLeft + gap;
  // 居中后再夹一次：round1 的 0.1 级误差不允许把 rail 顶出安全区（不变量 2 是**精确**包含）
  const centered: number = round1(input.safeAreaTop + (safeH - railHeight) / 2);
  const lowest: number = round1(input.safeAreaTop + safeH - railHeight);
  const railY: number = centered > lowest ? lowest : centered;
  const railRect: RectBox = boxOf(railX, railY, railWidth, railHeight);

  // 4. 页面：从 rail 的右边缘再让一个 gap 起算，竖直占满安全区
  //    用已取整的 railRect 派生，`contentRect.x === railRect.x + railRect.width + gap` 精确成立
  const contentX: number = railRect.x + railRect.width + gap;
  const contentRect: RectBox = boxOf(contentX, input.safeAreaTop,
    input.viewportW - contentX - input.safeAreaRight, safeH);

  // 5. 页面必须有正面积，而且不能窄到没法读；否则退化（页面铺满安全区、图标轨不画）
  if (contentRect.width < MIN_CONTENT_WIDTH_VP) {
    return degenerate('E_CONTENT_TOO_NARROW', safeBox, glyphSize, gap, glyphCount);
  }
  if (contentRect.height < MIN_CONTENT_HEIGHT_VP) {
    return degenerate('E_CONTENT_TOO_SHORT', safeBox, glyphSize, gap, glyphCount);
  }

  return {
    ok: true,
    reason: reasonForOk,
    glyphSize: glyphSize,
    gap: gap,
    glyphCount: glyphCount,
    railRect: railRect,
    contentRect: contentRect,
    gutter: round1(contentRect.x - input.safeAreaLeft),
    railVisible: true
  };
}
