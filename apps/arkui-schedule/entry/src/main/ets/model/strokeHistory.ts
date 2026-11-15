/**
 * 手写笔迹历史（纯逻辑：不 import 任何 SDK，可在 Node 直接跑）。
 *
 * 需求：自研分页画布上要支持「笔粗细 5 档 / 橡皮擦 / 撤销重做 / 颜色」。画笔与橡皮都只产出
 * `Stroke`（一串 vp 坐标点 + 笔宽 + 颜色 + 是否橡皮），真正的绘制由 UI 完成；本模块只负责
 * **按页隔离地记账**，让 UI 能「清屏 → 用 `strokesAt()` 整页重放」实现撤销/重做。
 *
 * 设计要点：
 * - 每页一条笔迹数组 + 一个重做栈（栈顶 = 最近被撤销的那一笔），页与页互不影响；
 * - 不设历史上限（一笔几十个点，内存可忽略），因此撤销深度天然 ≥ `MIN_UNDO_DEPTH`；
 * - 橡皮也是普通一笔（`erase: true`），所以「撤销橡皮」= 把橡皮那笔从序列里去掉、重放即恢复；
 * - 所有读写都走深拷贝：UI 改了返回值不会污染账本，账本也不会持有调用方的对象。
 */
import type { BrushKind } from './brush';

/** 笔迹上的一个点（画布 vp 坐标）。 */
export interface StrokePoint {
  x: number;
  y: number;
}

/** 一笔（橡皮也算一笔，便于撤销）。 */
export interface Stroke {
  /** 采样点，按绘制顺序。 */
  points: StrokePoint[];
  /** 笔宽（vp）；橡皮用 `ERASER_WIDTH`。 */
  width: number;
  /** 颜色 `'#RRGGBB'`；橡皮忽略颜色。 */
  color: string;
  /** `true` = 橡皮（`destination-out` 擦除）。 */
  erase: boolean;
  /** 笔刷类型（钢笔/圆珠笔/铅笔/马克笔/荧光笔），见 `model/brush.ts`。 */
  brush: BrushKind;
}

/** 笔宽预设（5 档，vp，升序；3.5 是默认值）。 */
export const PEN_WIDTHS: number[] = [2, 3.5, 5, 7, 10];

/** 颜色预设（黑 / 红 / 蓝 / 绿 / 橙）。 */
export const PEN_COLORS: string[] = ['#1A1A1A', '#D93025', '#1A73E8', '#188038', '#E8710A'];

/** 默认笔宽（vp）。 */
export const DEFAULT_PEN_WIDTH: number = 3.5;

/** 默认颜色（黑）。 */
export const DEFAULT_PEN_COLOR: string = '#1A1A1A';

/** 橡皮宽度（vp）：明显比最粗的笔还宽，才擦得干净。 */
export const ERASER_WIDTH: number = 20;

/** 撤销深度保证（至少 20 步）。 */
export const MIN_UNDO_DEPTH: number = 20;

/** 页数归一化：非有限数回退到 1 页，负数按 0 页。 */
function normalizePageCount(pageCount: number | undefined): number {
  if (pageCount === undefined || !Number.isFinite(pageCount)) {
    return 1;
  }
  const value: number = Math.floor(pageCount);
  return value > 0 ? value : 0;
}

/** 页序是否是可用的非负整数（`push` 用：允许超出当前页数，自动扩容）。 */
function isPageNumber(pageIndex: number): boolean {
  return Number.isInteger(pageIndex) && pageIndex >= 0;
}

/** 深拷贝一个点。 */
function clonePoint(point: StrokePoint): StrokePoint {
  return { x: point.x, y: point.y };
}

/** 深拷贝一笔（点数组逐点复制；`erase` 归一化为布尔，`brush` 原样保留）。 */
function cloneStroke(stroke: Stroke): Stroke {
  const points: StrokePoint[] = [];
  if (Array.isArray(stroke.points)) {
    for (let index = 0; index < stroke.points.length; index++) {
      const point: StrokePoint = stroke.points[index];
      if (point !== null && point !== undefined && typeof point === 'object') {
        points.push(clonePoint(point));
      }
    }
  }
  return {
    points: points,
    width: stroke.width,
    color: stroke.color,
    erase: stroke.erase === true,
    brush: stroke.brush
  };
}

/** 深拷贝一组笔迹。 */
function cloneStrokes(strokes: Stroke[]): Stroke[] {
  const copy: Stroke[] = [];
  for (let index = 0; index < strokes.length; index++) {
    copy.push(cloneStroke(strokes[index]));
  }
  return copy;
}

/**
 * 按页隔离的笔迹历史（撤销/重做）。
 *
 * - 每页独立；一处撤销不影响别的页；
 * - 撤销返回「撤销后仍应留在画布上的笔迹」（UI 清屏后按此重放）；
 * - 不设上限地保留笔迹，因此撤销深度天然 ≥ `MIN_UNDO_DEPTH`。
 */
export class StrokeHistory {
  /** 每页当前笔迹（按绘制顺序，橡皮也是一笔）。 */
  private pages: Stroke[][];
  /** 每页重做栈（栈顶 = 最近被撤销的那一笔）。 */
  private redoPages: Stroke[][];

  constructor(pageCount?: number) {
    const count: number = normalizePageCount(pageCount);
    this.pages = [];
    this.redoPages = [];
    for (let index = 0; index < count; index++) {
      this.pages.push([]);
      this.redoPages.push([]);
    }
  }

  /** 当前记录的页数。 */
  pageCount(): number {
    return this.pages.length;
  }

  /**
   * 记一笔到 `pageIndex`：越界页自动扩容后写入；`pageIndex` 非法（非整数/负数）忽略、不抛。
   * 新笔会**清空该页的重做栈**（画了新东西，旧的重做分支作废）。
   */
  push(pageIndex: number, stroke: Stroke): void {
    if (!isPageNumber(pageIndex)) {
      return;
    }
    if (stroke === null || stroke === undefined || typeof stroke !== 'object') {
      return;
    }
    this.ensurePageCount(pageIndex + 1);
    this.pages[pageIndex].push(cloneStroke(stroke));
    this.redoPages[pageIndex] = [];
  }

  /**
   * 撤销该页最后一笔：把它移入重做栈。
   * 返回**撤销后该页应重绘的笔迹**（深拷贝）；没有可撤销的笔返回 `null`。
   */
  undo(pageIndex: number): Stroke[] | null {
    if (!this.hasPage(pageIndex)) {
      return null;
    }
    const strokes: Stroke[] = this.pages[pageIndex];
    if (strokes.length === 0) {
      return null;
    }
    const removed: Stroke = strokes[strokes.length - 1];
    strokes.pop();
    this.redoPages[pageIndex].push(cloneStroke(removed));
    return cloneStrokes(strokes);
  }

  /**
   * 重做该页最近撤销的一笔。
   * 返回**重做后该页应重绘的笔迹**（深拷贝）；没有可重做的笔返回 `null`。
   */
  redo(pageIndex: number): Stroke[] | null {
    if (!this.hasPage(pageIndex)) {
      return null;
    }
    const redoStack: Stroke[] = this.redoPages[pageIndex];
    if (redoStack.length === 0) {
      return null;
    }
    const restored: Stroke = redoStack[redoStack.length - 1];
    redoStack.pop();
    this.pages[pageIndex].push(cloneStroke(restored));
    return cloneStrokes(this.pages[pageIndex]);
  }

  /** 该页是否还有可撤销的笔。 */
  canUndo(pageIndex: number): boolean {
    if (!this.hasPage(pageIndex)) {
      return false;
    }
    return this.pages[pageIndex].length > 0;
  }

  /** 该页是否还有可重做的笔。 */
  canRedo(pageIndex: number): boolean {
    if (!this.hasPage(pageIndex)) {
      return false;
    }
    return this.redoPages[pageIndex].length > 0;
  }

  /** 该页当前笔迹（深拷贝，UI 用它整页重绘）；越界页返回空数组。 */
  strokesAt(pageIndex: number): Stroke[] {
    if (!this.hasPage(pageIndex)) {
      return [];
    }
    return cloneStrokes(this.pages[pageIndex]);
  }

  /** 该页可撤销步数（= 当前笔迹数）；越界页返回 0。 */
  undoDepth(pageIndex: number): number {
    if (!this.hasPage(pageIndex)) {
      return 0;
    }
    return this.pages[pageIndex].length;
  }

  /** 清空该页笔迹与重做栈；越界页忽略。 */
  clearPage(pageIndex: number): void {
    if (!this.hasPage(pageIndex)) {
      return;
    }
    this.pages[pageIndex] = [];
    this.redoPages[pageIndex] = [];
  }

  /**
   * 页数变化后补齐（`PageBook.addPage()` 之后调用）：只增不减，已有页的笔迹全部保留。
   * 传更小的值 == 什么都不做（不丢数据）；非法值忽略。
   */
  ensurePageCount(count: number): void {
    if (!Number.isFinite(count)) {
      return;
    }
    const target: number = Math.max(0, Math.floor(count));
    while (this.pages.length < target) {
      this.pages.push([]);
      this.redoPages.push([]);
    }
  }

  /** 页序是否落在已记录的页范围内。 */
  private hasPage(pageIndex: number): boolean {
    return isPageNumber(pageIndex) && pageIndex < this.pages.length;
  }
}
