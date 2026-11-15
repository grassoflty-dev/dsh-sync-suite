/**
 * 手写页区域框（纯逻辑：不 import 任何 SDK，可在 Node 直接跑）。
 *
 * 需求：用户不再给整页打「图文页」标记，而是在画布上**拖出若干矩形**；框内内容
 * **不参与 OCR**（落盘时先遮白再二次截图送识别），正文对应位置插入
 * `[图表/公式: 查看手迹 · 第N页·区域M]` 占位符。
 *
 * 本模块只做几何：清洗（夹紧/丢弃误触）、排序、占位符文案、归一化 → 像素矩形。
 * 真正的填白 + 二次截图由 UI/适配层注入（`PageCaptureDeps.maskPage`），模型层不碰 PixelMap。
 */
import type { RegionBox } from './types';

/** 归一化最小边长：小于该值的框视为误触，直接丢弃。 */
export const MIN_REGION_SIDE: number = 0.02;

/** 像素矩形（`regionsToMaskRects` 的产物，供 UI 填白用）。 */
export interface MaskRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 排序辅助项（显式接口，避免 ArkTS 对匿名对象字面量的限制）。 */
interface IndexedRegion {
  box: RegionBox;
  index: number;
}

/** 夹紧到 [0,1]；NaN 按 0 处理（调用方先做有限性校验）。 */
function clamp01(value: number): number {
  if (!(value > 0)) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

/**
 * 清洗单个区域框：
 * - 非有限数（NaN / Infinity）→ `null`；
 * - 负宽高按「反方向拖拽」理解（取 min/max 换算出矩形）；
 * - 夹紧到 `[0,1]` 并裁掉越界部分；
 * - 清洗后宽或高 `< MIN_REGION_SIDE` → `null`（误触/零面积）。
 */
export function sanitizeRegion(box: RegionBox): RegionBox | null {
  if (box === null || box === undefined || typeof box !== 'object') {
    return null;
  }
  const x: number = box.x;
  const y: number = box.y;
  const w: number = box.w;
  const h: number = box.h;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) {
    return null;
  }
  const rawLeft: number = Math.min(x, x + w);
  const rawRight: number = Math.max(x, x + w);
  const rawTop: number = Math.min(y, y + h);
  const rawBottom: number = Math.max(y, y + h);
  // 完全在画布内且方向为正：原样返回（保持用户输入的精确值，不引入浮点误差）
  if (x >= 0 && y >= 0 && w >= 0 && h >= 0 && rawRight <= 1 && rawBottom <= 1) {
    if (w < MIN_REGION_SIDE || h < MIN_REGION_SIDE) {
      return null;
    }
    return { x: x, y: y, w: w, h: h };
  }
  const left: number = clamp01(rawLeft);
  const right: number = clamp01(rawRight);
  const top: number = clamp01(rawTop);
  const bottom: number = clamp01(rawBottom);
  const width: number = right - left;
  const height: number = bottom - top;
  if (width < MIN_REGION_SIDE || height < MIN_REGION_SIDE) {
    return null;
  }
  return { x: left, y: top, w: width, h: height };
}

/** 批量清洁：丢弃 `null`，保持数组顺序（不排序）。 */
export function sanitizeRegions(boxes: RegionBox[]): RegionBox[] {
  const list: RegionBox[] = Array.isArray(boxes) ? boxes : [];
  const clean: RegionBox[] = [];
  for (let index = 0; index < list.length; index++) {
    const box: RegionBox | null = sanitizeRegion(list[index]);
    if (box !== null) {
      clean.push(box);
    }
  }
  return clean;
}

/**
 * 按 `y` 升序（阅读顺序）排序；`y` 相同按 `x` 升序；两者都相同保持原序。
 * 不修改入参（返回新数组）。
 */
export function sortRegionsByY(boxes: RegionBox[]): RegionBox[] {
  const list: RegionBox[] = Array.isArray(boxes) ? boxes.slice() : [];
  const indexed: IndexedRegion[] = [];
  for (let index = 0; index < list.length; index++) {
    indexed.push({ box: list[index], index: index });
  }
  indexed.sort(function (left: IndexedRegion, right: IndexedRegion): number {
    if (left.box.y !== right.box.y) {
      return left.box.y - right.box.y;
    }
    if (left.box.x !== right.box.x) {
      return left.box.x - right.box.x;
    }
    return left.index - right.index;
  });
  const sorted: RegionBox[] = [];
  for (let index = 0; index < indexed.length; index++) {
    sorted.push(indexed[index].box);
  }
  return sorted;
}

/** 区域占位符：`[图表/公式: 查看手迹 · 第N页·区域M]`（页码/区域序号都从 1 起）。 */
export function regionPlaceholder(pageIndex: number, regionIndex: number): string {
  const page: number = (Number.isFinite(pageIndex) && pageIndex > 0 ? Math.floor(pageIndex) : 0) + 1;
  const region: number = (Number.isFinite(regionIndex) && regionIndex > 0 ? Math.floor(regionIndex) : 0) + 1;
  return `[图表/公式: 查看手迹 · 第${page}页·区域${region}]`;
}

/**
 * 归一化区域 → 像素矩形：先 `sanitizeRegions`，再按画布尺寸换算。
 * 坐标/宽高**向下取整**、宽高**至少 1**，并夹进 `[0,width] × [0,height]`（不越界）。
 * 画布尺寸非正/非有限 → 返回空数组（没有可填白的像素）。
 */
export function regionsToMaskRects(boxes: RegionBox[], width: number, height: number): MaskRect[] {
  const rects: MaskRect[] = [];
  const canvasWidth: number = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  const canvasHeight: number = Number.isFinite(height) ? Math.max(0, Math.floor(height)) : 0;
  if (canvasWidth <= 0 || canvasHeight <= 0) {
    return rects;
  }
  const clean: RegionBox[] = sanitizeRegions(boxes);
  for (let index = 0; index < clean.length; index++) {
    const box: RegionBox = clean[index];
    let left: number = Math.floor(box.x * canvasWidth);
    let top: number = Math.floor(box.y * canvasHeight);
    let rectWidth: number = Math.floor(box.w * canvasWidth);
    let rectHeight: number = Math.floor(box.h * canvasHeight);
    if (left > canvasWidth - 1) {
      left = canvasWidth - 1;
    }
    if (top > canvasHeight - 1) {
      top = canvasHeight - 1;
    }
    if (rectWidth < 1) {
      rectWidth = 1;
    }
    if (rectHeight < 1) {
      rectHeight = 1;
    }
    if (left + rectWidth > canvasWidth) {
      rectWidth = canvasWidth - left;
    }
    if (top + rectHeight > canvasHeight) {
      rectHeight = canvasHeight - top;
    }
    rects.push({ x: left, y: top, w: rectWidth, h: rectHeight });
  }
  return rects;
}

/**
 * 该页的占位符序列：先清洗、按 `y` 升序，再按序生成 `regionPlaceholder`。
 * 区域序号 `1..N` 按排序后的顺序编号（与正文里出现的顺序一致）。
 */
export function regionsToPlaceholders(pageIndex: number, boxes: RegionBox[]): string[] {
  const sorted: RegionBox[] = sortRegionsByY(sanitizeRegions(boxes));
  const placeholders: string[] = [];
  for (let index = 0; index < sorted.length; index++) {
    placeholders.push(regionPlaceholder(pageIndex, index));
  }
  return placeholders;
}
