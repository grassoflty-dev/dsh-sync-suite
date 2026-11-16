/**
 * 表格逐格 OCR 的纯逻辑（零 SDK import，Node 可测）。
 *
 * 用户选定方案 C：表格默认开启「识别文字」→ 不填白，按单元格裁剪逐格识别 →
 * 拼成 Markdown 表格写进正文。关闭时回退成「整块填白 + 占位符」。
 */

import type { NormalizedRect, PageObject } from './pageObjects';

/** 允许逐格识别的规模上限（含）：6×6 = 36 格。 */
export const TABLE_OCR_MAX_CELLS: number = 36;
/** 单格 OCR 超时（毫秒）。 */
export const TABLE_CELL_TIMEOUT_MS: number = 5000;
/** 整表 OCR 总超时（毫秒）。 */
export const TABLE_OCR_TIMEOUT_MS: number = 60000;

/** 像素矩形（左上 + 宽高，整数）。 */
export interface CellRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 表格是否允许逐格识别：`R*C <= 36` 且行列都在 1..10。
 * 非法输入（NaN/0/负数/小数）一律 false（调用方负责夹取后重试）。
 */
export function canOcrTable(rows: number, cols: number): boolean {
  if (!isPositiveInt(rows) || !isPositiveInt(cols)) {
    return false;
  }
  if (rows > 10 || cols > 10) {
    return false;
  }
  return rows * cols <= TABLE_OCR_MAX_CELLS;
}

function isPositiveInt(value: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value > 0;
}

/**
 * 把表格对象在「页面像素坐标」里切成 `rows × cols` 个单元格矩形（row-major）。
 *
 * @param rect   表格对象的归一化矩形（0..1，相对整页）
 * @param pageW  截图像素宽
 * @param pageH  截图像素高
 * @param rows   行数
 * @param cols   列数
 * @returns 单元格矩形；入参非法时返回空数组（不抛）
 */
export function cellRegions(rect: NormalizedRect, pageW: number, pageH: number, rows: number, cols: number): CellRegion[] {
  if (!isPositiveInt(rows) || !isPositiveInt(cols)) {
    return [];
  }
  if (!(pageW > 0) || !(pageH > 0)) {
    return [];
  }
  const box = clampRect(rect);
  const left: number = Math.round(box.x * pageW);
  const top: number = Math.round(box.y * pageH);
  const right: number = Math.round((box.x + box.w) * pageW);
  const bottom: number = Math.round((box.y + box.h) * pageH);
  const width: number = Math.max(0, right - left);
  const height: number = Math.max(0, bottom - top);
  if (width === 0 || height === 0) {
    return [];
  }

  const regions: CellRegion[] = [];
  for (let r = 0; r < rows; r += 1) {
    // 用比例边界而不是累加单格宽，避免取整误差累积（最后一格必须贴着右边）
    const y1: number = top + Math.round((height * r) / rows);
    const y2: number = top + Math.round((height * (r + 1)) / rows);
    for (let c = 0; c < cols; c += 1) {
      const x1: number = left + Math.round((width * c) / cols);
      const x2: number = left + Math.round((width * (c + 1)) / cols);
      const w: number = Math.max(1, x2 - x1);
      const h: number = Math.max(1, y2 - y1);
      regions.push({
        x: clampInt(x1, 0, Math.max(0, pageW - 1)),
        y: clampInt(y1, 0, Math.max(0, pageH - 1)),
        w: Math.min(w, Math.max(1, pageW - x1)),
        h: Math.min(h, Math.max(1, pageH - y1))
      });
    }
  }
  return regions;
}

function clampInt(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return Math.round(value);
}

function clampRect(rect: NormalizedRect): NormalizedRect {
  const x = Number.isFinite(rect.x) ? Math.min(Math.max(rect.x, 0), 1) : 0;
  const y = Number.isFinite(rect.y) ? Math.min(Math.max(rect.y, 0), 1) : 0;
  const w = Number.isFinite(rect.w) ? Math.min(Math.max(rect.w, 0), 1 - x) : 0;
  const h = Number.isFinite(rect.h) ? Math.min(Math.max(rect.h, 0), 1 - y) : 0;
  return { x, y, w, h };
}

/**
 * 单元格文本 → Markdown 表格。
 *
 * - 第 1 行当表头；列数取各行最大长度（不足补空，保证 `|` 数量一致）；
 * - 空单元格写一个空格；
 * - 文本里的 `|` 转义成 `\|`，换行折成空格；
 * - 无有效行列时返回空串（调用方据此回退成占位符）。
 */
export function tableToMarkdown(cells: string[][]): string {
  const rows: string[][] = (cells ?? [])
    .filter((row) => Array.isArray(row))
    .map((row) => row.map((cell) => normalizeCell(cell)));

  if (rows.length === 0) {
    return '';
  }
  const cols: number = rows.reduce((max, row) => Math.max(max, row.length), 0);
  if (cols === 0) {
    return '';
  }

  const padded: string[][] = rows.map((row) => {
    const copy: string[] = row.slice();
    while (copy.length < cols) {
      copy.push('');
    }
    return copy;
  });

  const lines: string[] = [];
  lines.push(renderRow(padded[0]));
  lines.push(renderRow(new Array<string>(cols).fill('---')));
  for (let i = 1; i < padded.length; i += 1) {
    lines.push(renderRow(padded[i]));
  }
  return lines.join('\n');
}

function normalizeCell(cell: string): string {
  const text: string = typeof cell === 'string' ? cell : '';
  return text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}

function renderRow(cells: string[]): string {
  const body: string = cells.map((cell) => (cell.length === 0 ? ' ' : cell)).join(' | ');
  return `| ${body} |`;
}

/** 表格对象的占位符（关闭逐格识别时使用）。 */
export function tablePlaceholder(rows: number, cols: number, pageNumber: number): string {
  const page: number = pageNumber > 0 ? pageNumber : 1;
  return `[表格 ${rows}×${cols}: 见附件 · 第${page}页]`;
}

/**
 * 某页的对象里，哪些需要「整块填白」。
 *
 * 规则：box 永远填白；image 永远填白；table 仅在 **关闭** 逐格识别（或规模超限）时填白。
 * 这是将来切换表格识别策略的**唯一开关点**。
 */
export function objectsToMask(objects: PageObject[]): NormalizedRect[] {
  const rects: NormalizedRect[] = [];
  for (const obj of objects ?? []) {
    // D1（reviewer 阻塞缺陷）：**表格永远进遮罩**，与是否开启逐格识别无关。
    // 原因：页级 OCR 会读整页，若表格不进遮罩，表格里的手写字会被页 OCR 读一遍，
    // 正文再追加 Markdown/占位符 → 同一张表出现两份。
    // 单元格文字只从**阶段 A 原图**裁剪识别（`cellRegions` + 原图 JPEG），不依赖页 OCR。
    rects.push({ x: obj.x, y: obj.y, w: obj.w, h: obj.h });
  }
  return rects;
}

/** 该表格对象是否开启逐格识别（默认开启；规模超限强制关闭）。 */
export function tableOcrEnabled(obj: PageObject): boolean {
  if (obj.kind !== 'table') {
    return false;
  }
  const rows: number = Number.isFinite(obj.rows) ? Number(obj.rows) : 0;
  const cols: number = Number.isFinite(obj.cols) ? Number(obj.cols) : 0;
  if (!canOcrTable(rows, cols)) {
    return false;
  }
  // `ocrEnabled === false` 表示用户手动关闭；缺省视为开启
  return obj.ocrEnabled !== false;
}

/** 能力白名单：这类对象**是否可能**被 OCR（box 是装饰框，永远不识别）。 */
export function shouldOcrObject(obj: PageObject): boolean {
  return obj.kind === 'image' || obj.kind === 'table';
}
