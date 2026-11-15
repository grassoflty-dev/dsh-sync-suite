/**
 * 手写板草稿（纯逻辑：不 import 任何 SDK，可在 Node 直接跑）。
 *
 * 用户诉求：手写板要能「退出暂存、再进继续改」，只有点「完成」才走 OCR。
 *
 * 落盘格式（`filesDir/drafts/<draftKey>.json`）：
 * ```json
 * { "version": 1, "draftKey": "new-1763200000000", "canvas": { "w": 2389, "h": 1429 },
 *   "current": 0,
 *   "pages": [ { "id": "p1",
 *     "strokes": [ { "points": [[0.1,0.2],[0.11,0.21]], "width": 3.5,
 *                    "color": "#182431", "brush": "pen", "erase": false } ],
 *     "boxes": [ { "x": 0.1, "y": 0.2, "w": 0.3, "h": 0.25 } ] } ],
 *   "updatedAt": 1763200000000 }
 * ```
 *
 * 设计要点：
 * - **笔迹点必须归一化**（0..1）：画布 vp 坐标随方向/尺寸变化，存像素就会让恢复后的笔迹错位；
 *   归一化与 `RegionBox` 用同一套约定（左上原点、`x/画布宽`、`y/画布高`），
 *   所以「旋转 / 换尺寸后按新尺寸重投影」是同一套换算，不写第二套。
 * - 框（`RegionBox`）本来就归一化，直接存。
 * - 读取容错：任何字段坏了都当草稿损坏处理（返回空草稿 + `corrupt`），**绝不抛异常**。
 * - 体积/页数上限在 `fitDraftToLimits()` 里统一处理（≤10 页、≤2MB）。
 */
import type { BrushKind } from './brush';
import type { RegionBox } from './types';
import type { Stroke, StrokePoint } from './strokeHistory';
import { sanitizeRegion } from './regions';

/** 草稿格式版本（结构变更时 +1；读到不认识的版本按损坏处理）。 */
export const DRAFT_VERSION: number = 1;

/** 草稿最多保留页数（与手写板页数上限一致）。 */
export const DRAFT_MAX_PAGES: number = 10;

/** 草稿文件大小上限（2MB）：超过就裁页，避免把沙箱写爆。 */
export const DRAFT_MAX_BYTES: number = 2 * 1024 * 1024;

/** 草稿目录名（相对 `filesDir`）。 */
export const DRAFT_DIR_NAME: string = 'drafts';

/** 草稿文件名后缀。 */
export const DRAFT_FILE_SUFFIX: string = '.json';

/** 新建记录（尚未保存）时的 draftKey 前缀。 */
export const DRAFT_KEY_NEW_PREFIX: string = 'new-';

/** 默认 draftKey（拿不到路由参数时的兜底，保证仍能存/读一份草稿）。 */
export const DRAFT_KEY_DEFAULT: string = 'default';

/** 默认笔刷（坏数据兜底）。 */
const FALLBACK_BRUSH: BrushKind = 'pen';

/** 默认颜色（坏数据兜底）。 */
const FALLBACK_COLOR: string = '#1A1A1A';

/** 归一化笔迹点（0..1）。 */
export interface DraftPoint {
  x: number;
  y: number;
}

/** 一笔（点是归一化的；`brush` 存字符串，读回时按白名单校验）。 */
export interface DraftStroke {
  /** 归一化坐标，按绘制顺序。 */
  points: DraftPoint[];
  width: number;
  color: string;
  brush: string;
  erase: boolean;
}

/** 一页草稿。 */
export interface DraftPage {
  /** 稳定页 id（`p1`/`p2`…）；恢复时按页序对应，id 作为信息保留。 */
  id: string;
  strokes: DraftStroke[];
  boxes: RegionBox[];
}

/** 保存时的画布尺寸（vp）：仅用于提示/排障，坐标已是归一化的。 */
export interface DraftCanvas {
  w: number;
  h: number;
}

/** 整份草稿。 */
export interface DraftDoc {
  version: number;
  draftKey: string;
  canvas: DraftCanvas;
  current: number;
  pages: DraftPage[];
  updatedAt: number;
}

/** 解析结果分类：正常 / 没有草稿 / 草稿损坏。 */
export type DraftParseReason = 'ok' | 'empty' | 'corrupt';

/** 解析结果。 */
export interface DraftParseResult {
  /** 是否得到可用草稿（`empty`/`corrupt` 时为 false）。 */
  ok: boolean;
  reason: DraftParseReason;
  /** 可用草稿；`ok === false` 时是空草稿（1 页、无笔迹）。 */
  doc: DraftDoc;
}

/** 裁页结果。 */
export interface DraftTrimResult {
  doc: DraftDoc;
  /** 是否真的裁掉了页。 */
  trimmed: boolean;
}

/** 编码到「可落盘 JSON」的结果（含体积与超限标记）。 */
export interface DraftEncodeResult {
  json: string;
  /** UTF-8 字节数。 */
  bytes: number;
  /** 是否因超限丢了页。 */
  trimmed: boolean;
  /** 最终页数。 */
  pages: number;
  /** 被丢掉的页数。 */
  dropped: number;
}

/**
 * 草稿 JSON 的「原始」形状：所有字段都可能缺失/类型不对（外部数据不可信）。
 * 内部用它接 `JSON.parse` 的结果，再做逐字段校验，避免对必填字段做 `=== undefined` 判断。
 */
interface RawDraft {
  version?: number;
  draftKey?: string;
  canvas?: RawCanvas;
  current?: number;
  pages?: RawPage[];
  updatedAt?: number;
}

interface RawCanvas {
  w?: number;
  h?: number;
}

interface RawPage {
  id?: string;
  strokes?: RawStroke[];
  boxes?: RawBox[];
}

interface RawStroke {
  points?: RawPoint[];
  width?: number;
  color?: string;
  brush?: string;
  erase?: boolean;
}

interface RawPoint {
  x?: number;
  y?: number;
}

interface RawBox {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

/** 空白页 id 前缀（与 `PageBook` 一致：p1/p2…）。 */
const PAGE_ID_PREFIX: string = 'p';

/** 生成一个新建记录的 draftKey（`new-<时间戳>`）。 */
export function newDraftKey(now: number): string {
  const stamp: number = Number.isFinite(now) ? Math.floor(now) : Date.now();
  return `${DRAFT_KEY_NEW_PREFIX}${stamp}`;
}

/**
 * 清洗 draftKey → 可安全做文件名的字符串。
 *
 * 只允许 `[A-Za-z0-9._-]`（记录 id 是「时间戳+随机」，新建是 `new-<ts>`，都满足）；
 * 其余字符一律替换为 `_`，并限制长度，避免目录穿越（`../`）与超长文件名。
 */
export function sanitizeDraftKey(key: string): string {
  const text: string = typeof key === 'string' ? key.trim() : '';
  if (text.length === 0) {
    return DRAFT_KEY_DEFAULT;
  }
  let cleaned: string = '';
  for (let index = 0; index < text.length && cleaned.length < 64; index++) {
    const ch: string = text[index];
    const ok: boolean =
      (ch >= 'a' && ch <= 'z') ||
      (ch >= 'A' && ch <= 'Z') ||
      (ch >= '0' && ch <= '9') ||
      ch === '.' ||
      ch === '_' ||
      ch === '-';
    cleaned += ok ? ch : '_';
  }
  // 纯点号（`.`/`..`）不能当文件名
  let dotsOnly: boolean = cleaned.length > 0;
  for (let index = 0; index < cleaned.length; index++) {
    if (cleaned[index] !== '.') {
      dotsOnly = false;
      break;
    }
  }
  if (cleaned.length === 0 || dotsOnly) {
    return DRAFT_KEY_DEFAULT;
  }
  return cleaned;
}

/** 草稿文件名（`<sanitized>.json`）。 */
export function draftFileName(key: string): string {
  return `${sanitizeDraftKey(key)}${DRAFT_FILE_SUFFIX}`;
}

/** 造一份空草稿（1 页空白、当前页 0）。 */
export function emptyDraft(draftKey: string, canvas: DraftCanvas): DraftDoc {
  const pages: DraftPage[] = [];
  pages.push({ id: `${PAGE_ID_PREFIX}1`, strokes: [], boxes: [] });
  return {
    version: DRAFT_VERSION,
    draftKey: sanitizeDraftKey(draftKey),
    canvas: { w: canvas.w, h: canvas.h },
    current: 0,
    pages: pages,
    updatedAt: 0
  };
}

/** 有限数夹到 [0,1]；非法值给 0。 */
function clamp01(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

/** 画布尺寸是否可用于归一化（宽高都要为正的有限数）。 */
export function isUsableCanvas(w: number, h: number): boolean {
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0;
}

/** 笔刷白名单校验（坏数据回退到钢笔）。 */
export function toBrushKind(value: string): BrushKind {
  if (value === 'pen' || value === 'ballpoint' || value === 'pencil' || value === 'marker' || value === 'highlighter') {
    return value;
  }
  return FALLBACK_BRUSH;
}

/**
 * 一笔 vp 坐标 → 归一化点（除以画布宽高）。
 *
 * 尺寸不可用时返回空数组（宁可少存，也不要写进去一堆 NaN/Infinity 的坐标）。
 */
export function toNormalizedPoints(points: StrokePoint[], w: number, h: number): DraftPoint[] {
  const result: DraftPoint[] = [];
  if (!isUsableCanvas(w, h) || !Array.isArray(points)) {
    return result;
  }
  for (let index = 0; index < points.length; index++) {
    const point: StrokePoint = points[index];
    if (point === null || point === undefined || typeof point !== 'object') {
      continue;
    }
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      continue;
    }
    result.push({ x: point.x / w, y: point.y / h });
  }
  return result;
}

/**
 * 归一化点 → 当前画布的 vp 坐标（乘新宽高）。
 *
 * 这就是「旋转/换尺寸后重投影」：同一份归一化数据在 2389×1429 与 1429×2389 上
 * 都落到相同的相对位置，与框选 `RegionBox` 的换算完全一致。
 */
export function fromNormalizedPoints(points: DraftPoint[], w: number, h: number): StrokePoint[] {
  const result: StrokePoint[] = [];
  if (!isUsableCanvas(w, h) || !Array.isArray(points)) {
    return result;
  }
  for (let index = 0; index < points.length; index++) {
    const point: DraftPoint = points[index];
    if (point === null || point === undefined || typeof point !== 'object') {
      continue;
    }
    const nx: number = Number.isFinite(point.x) ? clamp01(point.x) : 0;
    const ny: number = Number.isFinite(point.y) ? clamp01(point.y) : 0;
    result.push({ x: nx * w, y: ny * h });
  }
  return result;
}

/** 把一页的 vp 笔迹转成草稿笔迹（点归一化）。 */
export function toDraftStrokes(strokes: Stroke[], w: number, h: number): DraftStroke[] {
  const result: DraftStroke[] = [];
  if (!Array.isArray(strokes)) {
    return result;
  }
  for (let index = 0; index < strokes.length; index++) {
    const stroke: Stroke = strokes[index];
    if (stroke === null || stroke === undefined || typeof stroke !== 'object') {
      continue;
    }
    const points: DraftPoint[] = toNormalizedPoints(stroke.points, w, h);
    if (points.length === 0) {
      continue;
    }
    result.push({
      points: points,
      width: Number.isFinite(stroke.width) && stroke.width > 0 ? stroke.width : 1,
      color: typeof stroke.color === 'string' && stroke.color.length > 0 ? stroke.color : FALLBACK_COLOR,
      brush: stroke.brush,
      erase: stroke.erase === true
    });
  }
  return result;
}

/** 把草稿笔迹还原成当前画布上的 vp 笔迹。 */
export function fromDraftStrokes(strokes: DraftStroke[], w: number, h: number): Stroke[] {
  const result: Stroke[] = [];
  if (!Array.isArray(strokes) || !isUsableCanvas(w, h)) {
    return result;
  }
  for (let index = 0; index < strokes.length; index++) {
    const stroke: DraftStroke = strokes[index];
    if (stroke === null || stroke === undefined || typeof stroke !== 'object') {
      continue;
    }
    const points: StrokePoint[] = fromNormalizedPoints(stroke.points, w, h);
    if (points.length === 0) {
      continue;
    }
    const restored: Stroke = {
      points: points,
      width: Number.isFinite(stroke.width) && stroke.width > 0 ? stroke.width : 1,
      color: typeof stroke.color === 'string' && stroke.color.length > 0 ? stroke.color : FALLBACK_COLOR,
      erase: stroke.erase === true,
      brush: toBrushKind(typeof stroke.brush === 'string' ? stroke.brush : FALLBACK_BRUSH)
    };
    result.push(restored);
  }
  return result;
}

/** 框原样保留（已归一化，只做一次清洗，丢掉误触/坏框）。 */
export function toDraftBoxes(boxes: RegionBox[]): RegionBox[] {
  const result: RegionBox[] = [];
  if (!Array.isArray(boxes)) {
    return result;
  }
  for (let index = 0; index < boxes.length; index++) {
    const cleaned: RegionBox | null = sanitizeRegion(boxes[index]);
    if (cleaned !== null) {
      result.push(cleaned);
    }
  }
  return result;
}

/** 草稿里的框还原（仍是归一化坐标，直接用；坏框丢掉）。 */
export function fromDraftBoxes(boxes: RegionBox[]): RegionBox[] {
  return toDraftBoxes(boxes);
}

/** 序列化（字段顺序固定，便于 diff 与体积估算）。 */
export function serializeDraft(doc: DraftDoc): string {
  return JSON.stringify(doc);
}

/** UTF-8 字节数（中文按 3 字节；不用 TextEncoder，Node 与 ArkTS 结果一致）。 */
export function sizeOfDraft(json: string): number {
  const text: string = typeof json === 'string' ? json : '';
  let bytes: number = 0;
  for (let index = 0; index < text.length; index++) {
    const code: number = text.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      // 代理对：一个 emoji 占 4 字节（低半已含在本次计算里）
      bytes += 4;
      index++;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/** 草稿是否有内容（有笔迹或有框）；用来决定是否提示「已恢复」。 */
export function hasContent(doc: DraftDoc): boolean {
  if (doc === null || doc === undefined || !Array.isArray(doc.pages)) {
    return false;
  }
  for (let index = 0; index < doc.pages.length; index++) {
    const page: DraftPage = doc.pages[index];
    if (page === null || page === undefined) {
      continue;
    }
    const strokes: DraftStroke[] = Array.isArray(page.strokes) ? page.strokes : [];
    const boxes: RegionBox[] = Array.isArray(page.boxes) ? page.boxes : [];
    if (strokes.length > 0 || boxes.length > 0) {
      return true;
    }
  }
  return false;
}

/** 把页数裁到 `max`（保留**前** max 页，顺序不变）。 */
export function trimToMaxPages(doc: DraftDoc, max: number): DraftTrimResult {
  const limit: number = Number.isFinite(max) && max >= 1 ? Math.floor(max) : DRAFT_MAX_PAGES;
  if (doc === null || doc === undefined || !Array.isArray(doc.pages)) {
    return { doc: doc, trimmed: false };
  }
  if (doc.pages.length <= limit) {
    return { doc: doc, trimmed: false };
  }
  const kept: DraftPage[] = doc.pages.slice(0, limit);
  const trimmedDoc: DraftDoc = {
    version: doc.version,
    draftKey: doc.draftKey,
    canvas: doc.canvas,
    current: doc.current >= limit ? limit - 1 : doc.current,
    pages: kept,
    updatedAt: doc.updatedAt
  };
  return { doc: trimmedDoc, trimmed: true };
}

/**
 * 编码到可落盘的 JSON，并强制满足「≤ maxPages 页、≤ maxBytes 字节」。
 *
 * 超限策略：先裁页到 `maxPages`；仍超字节上限就**继续从尾部丢页**（至少留 1 页）。
 * 返回 `trimmed/dropped` 供 UI 提示「草稿过大，已只保留前 N 页」。
 */
export function fitDraftToLimits(doc: DraftDoc, maxPages: number, maxBytes: number): DraftEncodeResult {
  const pageLimit: number = Number.isFinite(maxPages) && maxPages >= 1 ? Math.floor(maxPages) : DRAFT_MAX_PAGES;
  const byteLimit: number = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : DRAFT_MAX_BYTES;
  const totalPages: number = doc !== null && doc !== undefined && Array.isArray(doc.pages) ? doc.pages.length : 0;

  let working: DraftDoc = doc;
  let json: string = serializeDraft(working);
  let bytes: number = sizeOfDraft(json);

  // ① 先按页数裁
  if (Array.isArray(working.pages) && working.pages.length > pageLimit) {
    working = trimToMaxPages(working, pageLimit).doc;
    json = serializeDraft(working);
    bytes = sizeOfDraft(json);
  }

  // ② 再按字节裁（从尾部丢页，至少留 1 页）
  while (bytes > byteLimit && Array.isArray(working.pages) && working.pages.length > 1) {
    const kept: DraftPage[] = working.pages.slice(0, working.pages.length - 1);
    working = {
      version: working.version,
      draftKey: working.draftKey,
      canvas: working.canvas,
      current: working.current >= kept.length ? kept.length - 1 : working.current,
      pages: kept,
      updatedAt: working.updatedAt
    };
    json = serializeDraft(working);
    bytes = sizeOfDraft(json);
  }

  const finalPages: number = Array.isArray(working.pages) ? working.pages.length : 0;
  return {
    json: json,
    bytes: bytes,
    trimmed: finalPages < totalPages,
    pages: finalPages,
    dropped: totalPages - finalPages
  };
}

/** 读一个数值字段（非有限数给 fallback）。 */
function readNumber(value: number | undefined, fallback: number): number {
  if (value === undefined || value === null || !Number.isFinite(value)) {
    return fallback;
  }
  return value;
}

/**
 * 解析草稿 JSON。
 *
 * - `null`/空串/空白 → `empty`（没有草稿，正常情况）；
 * - JSON 语法错误、结构不对、版本不认识 → `corrupt`（调用方应删掉坏文件）；
 * - 否则 `ok`，并把所有字段夹到合法范围（页数、当前页、坐标 0..1）。
 *
 * **本函数不抛异常**（坏数据绝不能把页面搞崩）。
 */
export function parseDraft(json: string | null | undefined, fallbackKey: string): DraftParseResult {
  const key: string = sanitizeDraftKey(fallbackKey);
  const empty: DraftDoc = emptyDraft(key, { w: 0, h: 0 });
  const text: string = typeof json === 'string' ? json.trim() : '';
  if (text.length === 0) {
    return { ok: false, reason: 'empty', doc: empty };
  }
  let raw: RawDraft | null = null;
  try {
    raw = JSON.parse(text) as RawDraft;
  } catch {
    return { ok: false, reason: 'corrupt', doc: empty };
  }
  if (raw === null || raw === undefined || typeof raw !== 'object') {
    return { ok: false, reason: 'corrupt', doc: empty };
  }
  if (readNumber(raw.version, -1) !== DRAFT_VERSION) {
    return { ok: false, reason: 'corrupt', doc: empty };
  }
  const rawPages: RawPage[] | undefined = raw.pages;
  if (rawPages === undefined || !Array.isArray(rawPages) || rawPages.length === 0) {
    return { ok: false, reason: 'corrupt', doc: empty };
  }

  const pages: DraftPage[] = [];
  for (let index = 0; index < rawPages.length; index++) {
    const page: RawPage = rawPages[index];
    if (page === null || page === undefined || typeof page !== 'object') {
      continue;
    }
    const strokes: DraftStroke[] = [];
    const rawStrokes: RawStroke[] | undefined = page.strokes;
    if (rawStrokes !== undefined && Array.isArray(rawStrokes)) {
      for (let s = 0; s < rawStrokes.length; s++) {
        const stroke: RawStroke = rawStrokes[s];
        if (stroke === null || stroke === undefined || typeof stroke !== 'object') {
          continue;
        }
        const points: DraftPoint[] = [];
        const rawPoints: RawPoint[] | undefined = stroke.points;
        if (rawPoints !== undefined && Array.isArray(rawPoints)) {
          for (let p = 0; p < rawPoints.length; p++) {
            const point: RawPoint = rawPoints[p];
            if (point === null || point === undefined || typeof point !== 'object') {
              continue;
            }
            const px: number = readNumber(point.x, NaN);
            const py: number = readNumber(point.y, NaN);
            if (!Number.isFinite(px) || !Number.isFinite(py)) {
              continue;
            }
            points.push({ x: clamp01(px), y: clamp01(py) });
          }
        }
        if (points.length === 0) {
          continue;
        }
        const width: number = readNumber(stroke.width, 1);
        strokes.push({
          points: points,
          width: width > 0 ? width : 1,
          color: typeof stroke.color === 'string' && stroke.color.length > 0 ? stroke.color : FALLBACK_COLOR,
          brush: typeof stroke.brush === 'string' && stroke.brush.length > 0 ? stroke.brush : FALLBACK_BRUSH,
          erase: stroke.erase === true
        });
      }
    }
    const boxes: RegionBox[] = [];
    const rawBoxes: RawBox[] | undefined = page.boxes;
    if (rawBoxes !== undefined && Array.isArray(rawBoxes)) {
      for (let b = 0; b < rawBoxes.length; b++) {
        const box: RawBox = rawBoxes[b];
        if (box === null || box === undefined || typeof box !== 'object') {
          continue;
        }
        const cleaned: RegionBox | null = sanitizeRegion({
          x: readNumber(box.x, NaN),
          y: readNumber(box.y, NaN),
          w: readNumber(box.w, NaN),
          h: readNumber(box.h, NaN)
        });
        if (cleaned !== null) {
          boxes.push(cleaned);
        }
      }
    }
    pages.push({
      id: typeof page.id === 'string' && page.id.length > 0 ? page.id : `${PAGE_ID_PREFIX}${index + 1}`,
      strokes: strokes,
      boxes: boxes
    });
  }
  if (pages.length === 0) {
    return { ok: false, reason: 'corrupt', doc: empty };
  }

  const rawCanvas: RawCanvas | undefined = raw.canvas;
  const trimmed: DraftTrimResult = trimToMaxPages(
    {
      version: DRAFT_VERSION,
      draftKey: key,
      canvas: {
        w: rawCanvas === undefined ? 0 : readNumber(rawCanvas.w, 0),
        h: rawCanvas === undefined ? 0 : readNumber(rawCanvas.h, 0)
      },
      current: Math.floor(readNumber(raw.current, 0)),
      pages: pages,
      updatedAt: readNumber(raw.updatedAt, 0)
    },
    DRAFT_MAX_PAGES
  );
  const doc: DraftDoc = trimmed.doc;
  // 文件存在却一条可用笔迹/框都没有 → 当作损坏（保存侧本来就不写空草稿）
  if (!hasContent(doc)) {
    return { ok: false, reason: 'corrupt', doc: empty };
  }
  if (doc.current < 0) {
    doc.current = 0;
  }
  if (doc.current >= doc.pages.length) {
    doc.current = doc.pages.length - 1;
  }
  return { ok: true, reason: 'ok', doc: doc };
}
