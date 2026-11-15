/**
 * 手写分页账本（纯逻辑：不 import 任何 SDK，可在 Node 直接跑）。
 *
 * 要解决两件事：
 * 1. **页序 ≠ 画布槽位**：手写板每个画布槽位有自己的笔迹，删除中间页时如果按「页序 i → 画布 i」
 *    恒等映射，后面所有页的笔迹都会串位。因此用 `slots[i]` 记录「第 i 页用哪个画布槽位」，
 *    删中间页只重排 `slots`；新增页优先复用被删掉（回收）的槽位，画布数永不超过上限。
 * 2. **每页的框选区域跟着页走**：`regions[i]` 与 `slots[i]` 等长同序，页重排时一起重排，
 *    保证「删掉中间页后，第 2 页框的还是原来那块内容」。
 *
 * 不变量（任何方法执行后都成立）：
 * - `slots.length === regions.length === pageCount()`，且 `1 <= pageCount() <= maxPages`；
 * - `slots` 各元素互不相同且都落在 `0..maxPages-1`；
 * - 区域一律经 `regions.ts` 的 `sanitizeRegions`（越界夹紧、误触丢弃），账本里不存脏数据。
 */
import { sanitizeRegion, sanitizeRegions } from './regions';
import type { RegionBox } from './types';

/** 手写板最多保留的页数（同时也是画布槽位上限）。 */
export const MAX_HANDWRITING_PAGES: number = 10;

/** 页数上限夹紧到 `1..MAX_HANDWRITING_PAGES`；非有限数回退到最大值。 */
function clampMaxPages(max: number): number {
  if (!Number.isFinite(max)) {
    return MAX_HANDWRITING_PAGES;
  }
  const value: number = Math.floor(max);
  if (value < 1) {
    return 1;
  }
  if (value > MAX_HANDWRITING_PAGES) {
    return MAX_HANDWRITING_PAGES;
  }
  return value;
}

/** 页序下标是否合法（整数且落在 `0..count-1`）。 */
function isPageIndex(index: number, count: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < count;
}

/** 深拷贝一组区域（`regionsAt` 返回副本，UI 改了也不影响账本）。 */
function cloneRegions(boxes: RegionBox[]): RegionBox[] {
  const copy: RegionBox[] = [];
  for (let index = 0; index < boxes.length; index++) {
    const box: RegionBox = boxes[index];
    copy.push({ x: box.x, y: box.y, w: box.w, h: box.h });
  }
  return copy;
}

/**
 * 分页账本：页序 → 画布槽位映射 + 每页区域框。
 *
 * 初始固定 1 页（`slots = [0]`、`regions = [[]]`、`current = 0`）。
 */
export class PageBook {
  /** 页序 → 画布索引（`0..maxPages-1`），长度 = 页数。 */
  slots: number[];
  /** 与 `slots` 等长同序，每页一组区域框。 */
  regions: RegionBox[][];
  /** 当前页（页序，0 起）。 */
  current: number;
  /** 页数上限（1..10）。 */
  maxPages: number;

  constructor(maxPages?: number) {
    this.maxPages = clampMaxPages(maxPages === undefined ? MAX_HANDWRITING_PAGES : maxPages);
    this.slots = [0];
    this.regions = [[]];
    this.current = 0;
  }

  /** 当前页数。 */
  pageCount(): number {
    return this.slots.length;
  }

  /** 页序数组：`0..pageCount()-1`（给 `ForEach` 之类的 UI 用）。 */
  indexes(): number[] {
    const list: number[] = [];
    for (let index = 0; index < this.slots.length; index++) {
      list.push(index);
    }
    return list;
  }

  /**
   * 设置页数上限：夹紧到 1..10；超出上限的页（连同其区域）被裁掉，`current` 夹紧。
   * 被裁掉的槽位自动变为空闲，后续 `addPage` 会复用。
   */
  setMaxPages(max: number): void {
    this.maxPages = clampMaxPages(max);
    while (this.slots.length > this.maxPages) {
      this.slots.pop();
      this.regions.pop();
    }
    this.current = Math.min(this.current, this.slots.length - 1);
  }

  /**
   * 新增一页（空白页，区域 = `[]`）：达到上限返回 `false` 且**不改状态**；
   * 成功时 `current` 指向新页。优先复用被删除页回收的槽位（取最小空闲槽）。
   */
  addPage(): boolean {
    if (this.slots.length >= this.maxPages) {
      return false;
    }
    const slot: number = this.firstFreeSlot();
    if (slot < 0) {
      return false;
    }
    this.slots.push(slot);
    this.regions.push([]);
    this.current = this.slots.length - 1;
    return true;
  }

  /**
   * 删除第 `index` 页：页序重排、`regions` 与 `slots` 同步重排（其余页的区域跟着自己的页走）、
   * 槽位回收，`current` 夹紧到 `min(current, pageCount-1)`。
   * 只剩 1 页或下标越界时返回 `false`。
   */
  removePage(index: number): boolean {
    if (this.slots.length <= 1) {
      return false;
    }
    if (!isPageIndex(index, this.slots.length)) {
      return false;
    }
    this.slots.splice(index, 1);
    this.regions.splice(index, 1);
    this.current = Math.min(this.current, this.slots.length - 1);
    return true;
  }

  /** 跳到第 `index` 页；越界返回 `false`（`current` 不变）。 */
  jumpTo(index: number): boolean {
    if (!isPageIndex(index, this.slots.length)) {
      return false;
    }
    this.current = index;
    return true;
  }

  /** 上一页；已在首页返回 `false`。 */
  prev(): boolean {
    return this.jumpTo(this.current - 1);
  }

  /** 下一页；已在末页返回 `false`。 */
  next(): boolean {
    return this.jumpTo(this.current + 1);
  }

  /** 第 `index` 页的区域（**深拷贝副本**）；越界返回 `[]`。 */
  regionsAt(index: number): RegionBox[] {
    if (!isPageIndex(index, this.regions.length)) {
      return [];
    }
    return cloneRegions(this.regions[index]);
  }

  /** 整体替换第 `index` 页的区域（内部 `sanitizeRegions`）；越界忽略。 */
  setRegions(index: number, boxes: RegionBox[]): void {
    if (!isPageIndex(index, this.regions.length)) {
      return;
    }
    this.regions[index] = sanitizeRegions(boxes);
  }

  /** 追加一个区域（sanitize 后）；框非法（NaN/零面积/误触）返回 `false` 且不改状态。 */
  addRegion(index: number, box: RegionBox): boolean {
    if (!isPageIndex(index, this.regions.length)) {
      return false;
    }
    const clean: RegionBox | null = sanitizeRegion(box);
    if (clean === null) {
      return false;
    }
    this.regions[index].push(clean);
    return true;
  }

  /** 删除第 `index` 页的第 `regionIndex` 个区域；越界返回 `false`。 */
  removeRegion(index: number, regionIndex: number): boolean {
    if (!isPageIndex(index, this.regions.length)) {
      return false;
    }
    if (!isPageIndex(regionIndex, this.regions[index].length)) {
      return false;
    }
    this.regions[index].splice(regionIndex, 1);
    return true;
  }

  /** 用新框替换第 `index` 页的第 `regionIndex` 个区域（sanitize 后）；非法/越界返回 `false`。 */
  updateRegion(index: number, regionIndex: number, box: RegionBox): boolean {
    if (!isPageIndex(index, this.regions.length)) {
      return false;
    }
    if (!isPageIndex(regionIndex, this.regions[index].length)) {
      return false;
    }
    const clean: RegionBox | null = sanitizeRegion(box);
    if (clean === null) {
      return false;
    }
    this.regions[index][regionIndex] = clean;
    return true;
  }

  /** 按页序生成画布 id：`${prefix}${slot}`（例：`hw-page-2`）。 */
  snapshotIds(prefix: string): string[] {
    const ids: string[] = [];
    for (let index = 0; index < this.slots.length; index++) {
      ids.push(`${prefix}${this.slots[index]}`);
    }
    return ids;
  }

  /** 最小的空闲画布槽位（0..maxPages-1）；无空闲返回 -1。 */
  private firstFreeSlot(): number {
    for (let slot = 0; slot < this.maxPages; slot++) {
      if (this.slots.indexOf(slot) < 0) {
        return slot;
      }
    }
    return -1;
  }
}
