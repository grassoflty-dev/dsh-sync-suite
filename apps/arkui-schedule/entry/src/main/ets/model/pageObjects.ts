/**
 * 页面对象模型：把「框」升级成通用可调矩形（框 / 图片 / 表格共用一套交互）。
 *
 * 契约：
 * - 坐标全部**归一化 0..1**（与 `RegionBox` 一致），便于跨设备/横竖屏复用；
 * - 三种对象的交互完全一致：拖拽移动、右下角手柄缩放、左上角 `×` 删除、最小 40×40vp、超出画布夹回；
 * - 一页可以有多个、可混合；对象跟随**稳定页 id**（`PageBook`），不跟页序；
 * - 旧数据只有 `boxes`（`RegionBox[]`）→ 读取时迁移成 `kind: 'box'`，写回用新结构（不丢数据）。
 *
 * 所有函数都是纯逻辑（无 IO / 无 UI），可以在 Node 里直接单测。
 */

/** 已有区域框（`model/regions.ts`）——这里只用它的 4 个归一化字段，避免循环依赖。 */
export interface NormalizedRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 对象类型：框 / 图片 / 表格。 */
export type PageObjectKind = 'box' | 'image' | 'table';

/** 画布上的一个可调矩形对象。 */
export interface PageObject {
  /** 稳定 id（同页内唯一，删除/拖动都靠它）。 */
  id: string;
  kind: PageObjectKind;
  /** 归一化坐标（0..1，左上角为原点）。 */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 图片对象：内容摘要（zip 条目名里带前 8 位）。 */
  sha256?: string;
  /** 图片对象：zip 内条目名（`image-<sha8>.<ext>`）。 */
  name?: string;
  /** 表格对象：行数（1..10）。 */
  rows?: number;
  /** 表格对象：列数（1..10）。 */
  cols?: number;
}

/** 对象最小尺寸（归一化）：对应真机 40vp（页宽约 1000vp 量级，按比例给 0.04）。 */
export const OBJECT_MIN_SIZE: number = 0.04;

/** 表格行/列上下限。 */
export const TABLE_MIN_LINES: number = 1;
export const TABLE_MAX_LINES: number = 10;

/** 表格默认行/列。 */
export const TABLE_DEFAULT_LINES: number = 3;

/** 插入图片默认占页宽比例（按原图比例算高）。 */
export const IMAGE_DEFAULT_WIDTH_RATIO: number = 0.4;

/** 插入表格默认尺寸（占页宽/页高）。 */
export const TABLE_DEFAULT_WIDTH_RATIO: number = 0.6;
export const TABLE_DEFAULT_HEIGHT_RATIO: number = 0.4;

/** 图片插入前的最大边长（px）与体积上限（字节）：超过就缩。 */
export const IMAGE_MAX_SIDE: number = 2048;
export const IMAGE_MAX_BYTES: number = 5 * 1024 * 1024;

const SHA256_RE = /^[0-9a-f]{64}$/;

function clamp01(value: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(1, Math.max(0, value));
}

/** 表格行/列夹紧到 1..10（0 / 负数 / 99 都能夹回合法值）。 */
export function clampTableLines(value: number): number {
  if (!Number.isFinite(value)) {
    return TABLE_DEFAULT_LINES;
  }
  const rounded: number = Math.round(value);
  return Math.min(TABLE_MAX_LINES, Math.max(TABLE_MIN_LINES, rounded));
}

/**
 * 把任意矩形规整成合法对象矩形：夹回画布内、保证最小尺寸。
 *
 * 夹取策略：先限制宽高（≥最小尺寸、≤1），再把左上角拉回 `[0, 1-w]`×`[0, 1-h]`，
 * 因此「拖出右/下边界」会把整个矩形推回画布内，而不是只裁掉一角。
 */
export function normalizeRect(rect: NormalizedRect): NormalizedRect {
  const w: number = Math.min(1, Math.max(OBJECT_MIN_SIZE, clamp01(rect.w, OBJECT_MIN_SIZE)));
  const h: number = Math.min(1, Math.max(OBJECT_MIN_SIZE, clamp01(rect.h, OBJECT_MIN_SIZE)));
  const x: number = Math.min(1 - w, Math.max(0, clamp01(rect.x, 0)));
  const y: number = Math.min(1 - h, Math.max(0, clamp01(rect.y, 0)));
  return { x: x, y: y, w: w, h: h };
}

/** 新建一个对象（自动夹取；`id` 由调用方给，便于稳定）。 */
export function makePageObject(
  id: string,
  kind: PageObjectKind,
  rect: NormalizedRect,
  extra?: { sha256?: string; name?: string; rows?: number; cols?: number }
): PageObject {
  const normalized: NormalizedRect = normalizeRect(rect);
  const object: PageObject = {
    id: id,
    kind: kind,
    x: normalized.x,
    y: normalized.y,
    w: normalized.w,
    h: normalized.h
  };
  if (kind === 'image') {
    if (extra !== undefined && extra.sha256 !== undefined) {
      object.sha256 = extra.sha256.toLowerCase();
    }
    if (extra !== undefined && extra.name !== undefined) {
      object.name = extra.name;
    }
  }
  if (kind === 'table') {
    object.rows = clampTableLines(extra === undefined || extra.rows === undefined ? TABLE_DEFAULT_LINES : extra.rows);
    object.cols = clampTableLines(extra === undefined || extra.cols === undefined ? TABLE_DEFAULT_LINES : extra.cols);
  }
  return object;
}

/** 以画布中心插入：给定宽高（归一化），算出左上角。 */
export function centerRect(w: number, h: number): NormalizedRect {
  return normalizeRect({ x: (1 - w) / 2, y: (1 - h) / 2, w: w, h: h });
}

/** 按原图比例算插入矩形：默认占页宽 `widthRatio`，高度按 `imageH/imageW` 折算并夹回画布。 */
export function imageRectFor(imageW: number, imageH: number, widthRatio: number = IMAGE_DEFAULT_WIDTH_RATIO): NormalizedRect {
  if (!Number.isFinite(imageW) || !Number.isFinite(imageH) || imageW <= 0 || imageH <= 0) {
    return centerRect(widthRatio, widthRatio);
  }
  const ratio: number = Math.min(1, Math.max(0.05, widthRatio));
  const w: number = ratio;
  const h: number = Math.min(1, (ratio * imageH) / imageW);
  return normalizeRect({ x: (1 - w) / 2, y: (1 - h) / 2, w: w, h: h });
}

/** 表格默认矩形（页中心，60% × 40%）。 */
export function tableRect(): NormalizedRect {
  return centerRect(TABLE_DEFAULT_WIDTH_RATIO, TABLE_DEFAULT_HEIGHT_RATIO);
}

/** 图片在 zip 里的条目名：`image-<sha256前8位>.<ext>`（扩展名只留字母数字）。 */
export function imageEntryName(sha256: string, ext: string): string {
  const digest: string = typeof sha256 === 'string' ? sha256.trim().toLowerCase() : '';
  if (!SHA256_RE.test(digest)) {
    throw new Error(`sha256 不合法（需 64 位十六进制）：${String(sha256)}`);
  }
  const rawExt: string = typeof ext === 'string' ? ext.trim().toLowerCase().replace(/^\./, '') : '';
  const safeExt: string = /^[a-z0-9]{2,5}$/.test(rawExt) ? rawExt : 'jpg';
  return `image-${digest.slice(0, 8)}.${safeExt}`;
}

/** 对象矩形 → 填白遮罩矩形（与 `regionsToMaskRects` 同形，直接复用现有填白逻辑）。 */
export function objectsToMaskRects(objects: PageObject[]): NormalizedRect[] {
  const rects: NormalizedRect[] = [];
  for (const object of objects) {
    const normalized: NormalizedRect = normalizeRect(object);
    rects.push(normalized);
  }
  return rects;
}

/**
 * 按对象生成正文占位符，**按 y 升序、同 y 按 x**（用户要求：正文顺序跟着页面从上到下）。
 *
 * - 框：沿用现有 `[图表/公式: 查看手迹 · 第N页·区域M]`（由 `regions.ts` 负责，这里不重复）；
 * - 图片：`[图片: 见附件 · 第N页]`；
 * - 表格：`[表格 R×C: 见附件 · 第N页]`。
 */
export function objectPlaceholder(object: PageObject, pageNumber: number): string {
  const page: number = Number.isFinite(pageNumber) ? Math.max(1, Math.floor(pageNumber)) : 1;
  if (object.kind === 'image') {
    return `[图片: 见附件 · 第${page}页]`;
  }
  if (object.kind === 'table') {
    const rows: number = clampTableLines(object.rows === undefined ? TABLE_DEFAULT_LINES : object.rows);
    const cols: number = clampTableLines(object.cols === undefined ? TABLE_DEFAULT_LINES : object.cols);
    return `[表格 ${rows}×${cols}: 见附件 · 第${page}页]`;
  }
  return `[图表/公式: 查看手迹 · 第${page}页]`;
}

/** 按阅读顺序（y 升序、同 y 按 x）排列对象。 */
export function sortObjectsByPosition(objects: PageObject[]): PageObject[] {
  const copy: PageObject[] = objects.slice();
  copy.sort((left: PageObject, right: PageObject) => {
    if (Math.abs(left.y - right.y) > 1e-6) {
      return left.y - right.y;
    }
    if (Math.abs(left.x - right.x) > 1e-6) {
      return left.x - right.x;
    }
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  return copy;
}

/** 生成一页的占位符列表（已排序），框类对象交给 `regions.ts` 处理时可传 `includeBox=false`。 */
export function pagePlaceholders(objects: PageObject[], pageNumber: number, includeBox: boolean = true): string[] {
  const sorted: PageObject[] = sortObjectsByPosition(objects);
  const texts: string[] = [];
  for (const object of sorted) {
    if (object.kind === 'box' && !includeBox) {
      continue;
    }
    texts.push(objectPlaceholder(object, pageNumber));
  }
  return texts;
}

/** 序列化（JSONL 里存 `pageObjects` 字段）；只保留关键字面量字段。 */
export function serializePageObjects(objects: PageObject[]): string {
  const clean: PageObject[] = [];
  for (const object of objects) {
    const normalized: NormalizedRect = normalizeRect(object);
    const item: PageObject = {
      id: object.id,
      kind: object.kind,
      x: normalized.x,
      y: normalized.y,
      w: normalized.w,
      h: normalized.h
    };
    if (object.kind === 'image') {
      if (object.sha256 !== undefined) {
        item.sha256 = object.sha256;
      }
      if (object.name !== undefined) {
        item.name = object.name;
      }
    }
    if (object.kind === 'table') {
      item.rows = clampTableLines(object.rows === undefined ? TABLE_DEFAULT_LINES : object.rows);
      item.cols = clampTableLines(object.cols === undefined ? TABLE_DEFAULT_LINES : object.cols);
    }
    clean.push(item);
  }
  return JSON.stringify(clean);
}

function readKind(value: string | undefined): PageObjectKind {
  if (value === 'image' || value === 'table') {
    return value;
  }
  return 'box';
}

/**
 * 解析 `pageObjects`（损坏一律跳过，不让整页丢失）。
 *
 * 兼容两种输入：
 * - 新结构：`[{id, kind, x, y, w, h, ...}]`；
 * - 旧结构（只有框）：`[{x, y, w, h}]` → 自动补 `id`（`box-<序号>`）与 `kind: 'box'`。
 */
export function parsePageObjects(json: string): PageObject[] {
  const text: string = typeof json === 'string' ? json.trim() : '';
  if (text.length === 0) {
    return [];
  }
  let parsed: PageObject[] = [];
  try {
    parsed = JSON.parse(text) as PageObject[];
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const result: PageObject[] = [];
  let seq: number = 0;
  for (const raw of parsed) {
    if (raw === null || raw === undefined) {
      continue;
    }
    const kind: PageObjectKind = readKind(raw.kind);
    const id: string = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : `box-${seq}`;
    seq++;
    const object: PageObject = makePageObject(id, kind, raw, {
      sha256: raw.sha256,
      name: raw.name,
      rows: raw.rows,
      cols: raw.cols
    });
    result.push(object);
  }
  return result;
}

/** 旧数据迁移：`RegionBox[]`（只有 4 个坐标）→ `PageObject[]`（kind 全是 'box'）。 */
export function migrateLegacyBoxes(boxes: NormalizedRect[]): PageObject[] {
  const objects: PageObject[] = [];
  for (let index = 0; index < boxes.length; index++) {
    objects.push(makePageObject(`box-${index}`, 'box', boxes[index]));
  }
  return objects;
}

/**
 * 一次「完成」要写进当天 zip 的条目名列表：**页 JPEG + 插入的原始图片**。
 *
 * 便于单测断言「条目数 = 页数 + 图片数」，也便于调用方核对：页在前、图片按出现顺序在后，
 * 同名去重（同一张图被插两次只存一份）。
 */
export function archiveEntryNames(pageCount: number, imageEntries: string[]): string[] {
  const names: string[] = [];
  const pages: number = Number.isFinite(pageCount) ? Math.max(0, Math.floor(pageCount)) : 0;
  for (let index = 0; index < pages; index++) {
    names.push(`page-${index}.jpg`);
  }
  const seen: Set<string> = new Set<string>();
  for (const entry of imageEntries) {
    const name: string = typeof entry === 'string' ? entry.trim() : '';
    if (name.length === 0 || seen.has(name)) {
      continue;
    }
    seen.add(name);
    names.push(name);
  }
  return names;
}

/** 汇总一页里所有图片对象的 zip 条目名（按对象顺序、去重）。 */
export function imageEntriesOf(objects: PageObject[]): string[] {
  const entries: string[] = [];
  const seen: Set<string> = new Set<string>();
  for (const object of objects) {
    if (object.kind !== 'image' || object.name === undefined || object.name.length === 0) {
      continue;
    }
    if (seen.has(object.name)) {
      continue;
    }
    seen.add(object.name);
    entries.push(object.name);
  }
  return entries;
}

/** 图片是否需要压缩：超过 5MB 或长边超过 2048 → true。 */
export function needsImageCompression(byteLength: number, longestSide: number): boolean {
  const tooBig: boolean = Number.isFinite(byteLength) && byteLength > IMAGE_MAX_BYTES;
  const tooWide: boolean = Number.isFinite(longestSide) && longestSide > IMAGE_MAX_SIDE;
  return tooBig || tooWide;
}

// ---------------------------------------------------------------------------
// B1：命中判定与手势（纯函数，Node 可测）
//
// 交互定版（三类对象共用一套）：
// - 点中对象本体 → 选中（选中态品牌色描边）；再拖动 = 移动；
// - 点中**右下角手柄**（`HANDLE_HIT_RADIUS` 内）→ 拖 = 等比/自由缩放（最小 40×40vp，夹回画布）；
// - 点中**左上角 ×**（`CLOSE_HIT_RADIUS` 内）→ 删除；
// - 点空白 → 取消选中。
// 层级：`objects` 数组顺序即 z 序，**后插入的在上面**；命中从上往下找第一个。
// ---------------------------------------------------------------------------

/** 右下角缩放手柄的命中半径（归一化）。 */
export const HANDLE_HIT_RADIUS: number = 0.035;

/** 左上角删除按钮的命中半径（归一化）。 */
export const CLOSE_HIT_RADIUS: number = 0.03;

/** 命中类型。 */
export type ObjectHitPart = 'body' | 'handle' | 'close';

/** 命中结果。 */
export interface ObjectHit {
  /** 命中的对象 id；没命中为空串。 */
  id: string;
  part: ObjectHitPart;
}

const NO_HIT: ObjectHit = { id: '', part: 'body' };

function distance(ax: number, ay: number, bx: number, by: number): number {
  const dx: number = ax - bx;
  const dy: number = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * 命中测试：优先 `×`（左上角）→ 手柄（右下角）→ 本体；同层命中返回**最上面**那个。
 *
 * @param objects 页内对象（数组顺序即 z 序，后者在上）
 * @param nx 触摸点归一化 x（0..1）
 * @param ny 触摸点归一化 y（0..1）
 */
export function hitTest(objects: PageObject[], nx: number, ny: number): ObjectHit {
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) {
    return NO_HIT;
  }
  for (let index = objects.length - 1; index >= 0; index--) {
    const object: PageObject = objects[index];
    const rect: NormalizedRect = normalizeRect(object);
    // 近距离优先判定「×」与手柄，避免小手柄被本体吞掉
    if (distance(nx, ny, rect.x, rect.y) <= CLOSE_HIT_RADIUS) {
      return { id: object.id, part: 'close' };
    }
    const right: number = rect.x + rect.w;
    const bottom: number = rect.y + rect.h;
    if (distance(nx, ny, right, bottom) <= HANDLE_HIT_RADIUS) {
      return { id: object.id, part: 'handle' };
    }
    if (nx >= rect.x && nx <= right && ny >= rect.y && ny <= bottom) {
      return { id: object.id, part: 'body' };
    }
  }
  return NO_HIT;
}

/** 按 id 取对象（找不到 undefined）。 */
export function findObject(objects: PageObject[], id: string): PageObject | undefined {
  for (const object of objects) {
    if (object.id === id) {
      return object;
    }
  }
  return undefined;
}

/** 移动：左上角平移到 `(nx, ny)`（夹回画布，尺寸不变）。 */
export function moveObject(object: PageObject, nx: number, ny: number): PageObject {
  const moved: PageObject = {
    id: object.id,
    kind: object.kind,
    x: nx,
    y: ny,
    w: object.w,
    h: object.h
  };
  copyExtras(object, moved);
  const normalized: NormalizedRect = normalizeRect(moved);
  moved.x = normalized.x;
  moved.y = normalized.y;
  moved.w = normalized.w;
  moved.h = normalized.h;
  return moved;
}

/** 拖动右下角缩放：右下角跟到 `(nx, ny)`，左上角固定；小于最小尺寸时用最小尺寸。 */
export function resizeObject(object: PageObject, nx: number, ny: number): PageObject {
  const rect: NormalizedRect = normalizeRect(object);
  const resized: PageObject = {
    id: object.id,
    kind: object.kind,
    x: rect.x,
    y: rect.y,
    w: (Number.isFinite(nx) ? nx : rect.x + rect.w) - rect.x,
    h: (Number.isFinite(ny) ? ny : rect.y + rect.h) - rect.y
  };
  copyExtras(object, resized);
  const normalized: NormalizedRect = normalizeRect(resized);
  resized.x = normalized.x;
  resized.y = normalized.y;
  resized.w = normalized.w;
  resized.h = normalized.h;
  return resized;
}

/** 把 `source` 的图片/表格附加字段拷到 `target`（保持类型干净）。 */
function copyExtras(source: PageObject, target: PageObject): void {
  if (source.kind === 'image') {
    if (source.sha256 !== undefined) {
      target.sha256 = source.sha256;
    }
    if (source.name !== undefined) {
      target.name = source.name;
    }
  }
  if (source.kind === 'table') {
    target.rows = clampTableLines(source.rows === undefined ? TABLE_DEFAULT_LINES : source.rows);
    target.cols = clampTableLines(source.cols === undefined ? TABLE_DEFAULT_LINES : source.cols);
  }
}

/** 用新对象替换同 id 的旧对象（返回新数组，保持 z 序）。 */
export function replaceObject(objects: PageObject[], next: PageObject): PageObject[] {
  const result: PageObject[] = [];
  for (const object of objects) {
    result.push(object.id === next.id ? next : object);
  }
  return result;
}

/** 删除对象（返回新数组）。 */
export function deleteObject(objects: PageObject[], id: string): PageObject[] {
  const result: PageObject[] = [];
  for (const object of objects) {
    if (object.id !== id) {
      result.push(object);
    }
  }
  return result;
}

/** 置顶（选中即提到最上层，符合「点谁谁在上」的直觉）。 */
export function bringToFront(objects: PageObject[], id: string): PageObject[] {
  const target: PageObject | undefined = findObject(objects, id);
  if (target === undefined) {
    return objects.slice();
  }
  const rest: PageObject[] = deleteObject(objects, id);
  rest.push(target);
  return rest;
}

/** 三对象渲染分类（画布按 kind 走不同绘制分支）。 */
export interface ObjectRenderPlan {
  boxes: PageObject[];
  images: PageObject[];
  tables: PageObject[];
}

/** 按 kind 分组，且**保持 z 序**（先画下面的，后画上面的）。 */
export function planRender(objects: PageObject[]): ObjectRenderPlan {
  const plan: ObjectRenderPlan = { boxes: [], images: [], tables: [] };
  for (const object of objects) {
    if (object.kind === 'image') {
      plan.images.push(object);
    } else if (object.kind === 'table') {
      plan.tables.push(object);
    } else {
      plan.boxes.push(object);
    }
  }
  return plan;
}
