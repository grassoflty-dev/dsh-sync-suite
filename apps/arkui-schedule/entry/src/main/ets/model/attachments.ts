/**
 * 手写附件与 OCR 文本整理（纯逻辑）。
 *
 * 契约：`docs/CONTRACT.md` §3.2
 * - 附件按 sha256 去重命名 `<sha256>.png`；
 * - 分页识别结果 0→N 一次性拼接、空页跳过；
 * - 表格/公式不做整页结构化，统一降级为 `STRUCTURED_PLACEHOLDER` 占位符 + 原始截图兜底。
 */
import type { Attachment, RegionBox } from './types';
import { regionsToPlaceholders } from './regions';

/** 公式/图表在 AI 结构化文本中的占位符（原文仍可从 OCR 与截图查看）。 */
export const STRUCTURED_PLACEHOLDER = '[公式/图表: 查看手迹]';

/** 附件图片格式：JPEG（手写内容对画质要求不高，体积约 PNG 的 1/5）。 */
export const ATTACHMENT_IMAGE_EXT: string = '.jpg';

/** JPEG 压缩质量（0-100）——用户定版 ≈60，一页目标 ≤150KB。 */
export const ATTACHMENT_JPEG_QUALITY: number = 60;

/** 截图最长边上限（px）——超过就等比缩小，1440 足够看清手写。 */
export const ATTACHMENT_MAX_SIDE: number = 1440;

/** 按天打包的 zip 后缀。 */
export const ATTACHMENT_ARCHIVE_EXT: string = '.zip';

/** zip 内条目名前缀（`page-<pageIndex>-<sha8>.jpg`）。 */
const ZIP_ENTRY_PREFIX: string = 'page-';

const SHA256_RE = /^[0-9a-f]{64}$/;
/** 按天 zip 文件名：`YYYY-MM-DD.zip`。 */
const ARCHIVE_RE = /^\d{4}-\d{2}-\d{2}\.zip$/;
/** zip 条目名：`page-<N>-<8位十六进制>.jpg`。 */
const ZIP_ENTRY_RE = /^page-(\d{1,3})-([0-9a-f]{8})\.jpg$/;

/** 单页截图引用（生成 zip 格式附件时用）：页号 + sha256。 */
export interface PageShotRef {
  sha256: string;
  pageIndex: number;
}

/** 单页截图（生成散图格式附件时用）：额外带文件名。 */
export interface PageShot {
  sha256: string;
  name: string;
  pageIndex: number;
}

/** 校验并规范化 sha256：必须是小写/大写十六进制的 64 位摘要，输出小写。 */
function normalizeSha256(sha256: string): string {
  const value = typeof sha256 === 'string' ? sha256.trim().toLowerCase() : '';
  if (!SHA256_RE.test(value)) {
    throw new Error(`sha256 不合法（需 64 位十六进制）：${String(sha256)}`);
  }
  return value;
}

/** 附件文件名（散图，旧格式）：`<sha256>.png`。 */
export function attachmentFileName(sha256: string): string {
  return `${normalizeSha256(sha256)}.png`;
}

/** 新格式的散图名（本地 cache 里解出来的 JPEG）：`<sha256>.jpg`。 */
export function jpegFileName(sha256: string): string {
  return `${normalizeSha256(sha256)}${ATTACHMENT_IMAGE_EXT}`;
}

/** 按天 zip 的文件名：`2026-11-15.zip`（入参非法时抛错）。 */
export function dayArchiveName(dateKey: string): string {
  const value = typeof dateKey === 'string' ? dateKey.trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`日期不合法（需 YYYY-MM-DD）：${String(dateKey)}`);
  }
  return `${value}${ATTACHMENT_ARCHIVE_EXT}`;
}

/** zip 内条目名：`page-<pageIndex>-<sha256 前 8 位>.jpg`（页号 0 起，负数按 0）。 */
export function zipEntryName(pageIndex: number, sha256: string): string {
  const digest = normalizeSha256(sha256);
  const page = Number.isFinite(pageIndex) ? Math.max(0, Math.floor(pageIndex)) : 0;
  return `${ZIP_ENTRY_PREFIX}${page}-${digest.slice(0, 8)}${ATTACHMENT_IMAGE_EXT}`;
}

/** 解析 zip 条目名；不是本应用的命名规则返回 `null`（调用方据此跳过）。 */
export function parseZipEntryName(entry: string): { pageIndex: number; sha8: string } | null {
  const value = typeof entry === 'string' ? entry.trim() : '';
  const matched = ZIP_ENTRY_RE.exec(value);
  if (matched === null) {
    return null;
  }
  const page = Number.parseInt(matched[1], 10);
  if (!Number.isFinite(page)) {
    return null;
  }
  return { pageIndex: page, sha8: matched[2] };
}

/** 是否是合法的按天 zip 名（用于过滤目录里的杂物）。 */
export function isDayArchiveName(name: string): boolean {
  return ARCHIVE_RE.test(typeof name === 'string' ? name.trim() : '');
}

/** 旧数据判定：没有 `archive`（或为空）→ 仍按散图路径读。 */
export function isLegacyAttachment(item: Attachment): boolean {
  return item.archive === undefined || item.archive === null || item.archive.length === 0;
}

/**
 * 由手写板各页截图信息生成 `Attachment[]`（按 pageIndex 升序，稳定）。
 * `name` 缺失或含路径分隔符时回退为 `<sha256>.png`，避免写出仓库目录之外。
 *
 * **旧格式（散图 PNG）**：仅在兼容旧数据/旧链路时使用；新链路用 `buildArchivedAttachmentRefs()`。
 */
export function buildAttachmentRefs(
  pages: PageShot[]
): Attachment[] {
  const refs: Array<{ attachment: Attachment; order: number }> = [];
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const sha256 = normalizeSha256(page.sha256);
    const rawName = typeof page.name === 'string' ? page.name.trim() : '';
    const safeName =
      rawName.length > 0 && !rawName.includes('/') && !rawName.includes('\\')
        ? rawName
        : attachmentFileName(sha256);
    const pageIndex = Number.isFinite(page.pageIndex) ? Math.max(0, Math.floor(page.pageIndex)) : i;
    refs.push({ attachment: { sha256, name: safeName, pageIndex }, order: i });
  }
  refs.sort((left, right) => {
    if (left.attachment.pageIndex !== right.attachment.pageIndex) {
      return left.attachment.pageIndex - right.attachment.pageIndex;
    }
    return left.order - right.order;
  });
  return refs.map((item) => item.attachment);
}

/**
 * 由各页截图生成**按天 zip** 格式的 `Attachment[]`：
 * `{ sha256, name, pageIndex, archive: '2026-11-15.zip', entry: 'page-1-1a2b3c4d.jpg' }`。
 *
 * `dateKey` 是 `YYYY-MM-DD`（记录日期），决定条目落在哪一天的 zip 里；
 * 同一页重复出现时按 `页号` 去重（后写覆盖先写，保证同一页只引用一张图）。
 */
export function buildArchivedAttachmentRefs(
  pages: PageShotRef[],
  dateKey: string
): Attachment[] {
  const archive = dayArchiveName(dateKey);
  const byPage = new Map<number, Attachment>();
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const sha256 = normalizeSha256(page.sha256);
    const pageIndex = Number.isFinite(page.pageIndex) ? Math.max(0, Math.floor(page.pageIndex)) : i;
    const entry = zipEntryName(pageIndex, sha256);
    byPage.set(pageIndex, { sha256, name: entry, pageIndex, archive, entry });
  }
  const result: Attachment[] = [];
  const keys: number[] = [];
  byPage.forEach((_value: Attachment, key: number) => {
    keys.push(key);
  });
  keys.sort((left: number, right: number) => left - right);
  for (let i = 0; i < keys.length; i++) {
    const item: Attachment | undefined = byPage.get(keys[i]);
    if (item !== undefined) {
      result.push(item);
    }
  }
  return result;
}

/**
 * 解析某条记录的附件 JSON（详情页/Edit 页共用）。
 *
 * 兼容两种形态：
 * - 旧：`{sha256, name, pageIndex}`（无 `archive`）→ 走散图路径；
 * - 新：额外带 `archive` + `entry` → 走 zip 解压路径。
 * 坏条目一律跳过（不让页面崩）。
 */
export function parseAttachmentList(json: string): Attachment[] {
  const list: Attachment[] = [];
  const text = typeof json === 'string' ? json.trim() : '';
  if (text.length === 0) {
    return list;
  }
  let parsed: Attachment[] = [];
  try {
    parsed = JSON.parse(text) as Attachment[];
  } catch {
    return list;
  }
  if (!Array.isArray(parsed)) {
    return list;
  }
  for (const item of parsed) {
    if (item === null || item === undefined) {
      continue;
    }
    if (!SHA256_RE.test(typeof item.sha256 === 'string' ? item.sha256.trim().toLowerCase() : '')) {
      continue;
    }
    if (typeof item.name !== 'string' || !Number.isFinite(item.pageIndex)) {
      continue;
    }
    const attachment: Attachment = {
      sha256: item.sha256.trim().toLowerCase(),
      name: item.name,
      pageIndex: Math.max(0, Math.floor(item.pageIndex))
    };
    // 新格式：archive + entry 必须同时合法才认；否则按旧格式（散图）处理
    if (typeof item.archive === 'string' && isDayArchiveName(item.archive)) {
      const entry = typeof item.entry === 'string' ? item.entry.trim() : '';
      if (parseZipEntryName(entry) !== null) {
        attachment.archive = item.archive.trim();
        attachment.entry = entry;
      }
    }
    list.push(attachment);
  }
  list.sort((left: Attachment, right: Attachment) => left.pageIndex - right.pageIndex);
  return list;
}

/**
 * 分页识别结果 0→N 拼接：逐页去除首尾空白，空页跳过，页间用单个换行连接。
 */
export function concatPageTexts(results: string[]): string {
  const parts: string[] = [];
  for (const raw of results) {
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (text.length === 0) {
      continue;
    }
    parts.push(text);
  }
  return parts.join('\n');
}

/** 行内 LaTeX（`$x^2$`），只接受数学字符集，避免误伤「$5 和 $10」这类中文文本。 */
const LATEX_INLINE_RE = /\$[A-Za-z0-9\\^_{}()[\]+\-*=/. ]{1,120}\$/;
/** 行间公式定界符 `$$ … $$`、`\[ … \]`、`\( … \)`。 */
const LATEX_DISPLAY_RE = /\$\$|\\\[|\\\]|\\\(|\\\)/;
/** 常见 LaTeX 命令。 */
const LATEX_COMMAND_RE =
  /\\(?:frac|sqrt|sum|int|iint|prod|lim|alpha|beta|gamma|delta|theta|lambda|mu|sigma|omega|pi|times|cdot|div|pm|le|ge|leq|geq|neq|approx|infty|partial|nabla|begin|end|left|right|text|mathrm|mathbf|overline|vec|hat|bar|dot)\b/;
/** 表格行：一行里至少两根竖线（Markdown/OCR 表格）。 */
const TABLE_PIPE_RE = /\|.*\|/;
/** 表格分隔行：`| --- | --- |` 或 `+----+----+`。 */
const TABLE_SEPARATOR_RE = /^\s*\|?[\s:|-]*-{3,}[\s:|-]*\|?\s*$/;
const ASCII_TABLE_RE = /^\s*[+|][-=+|\s]{2,}[+|]\s*$/;

/** 该行是否为表格/公式等「不宜结构化」的内容。 */
function isComplexLine(trimmed: string): boolean {
  if (trimmed.length === 0) {
    return false;
  }
  return (
    LATEX_DISPLAY_RE.test(trimmed) ||
    LATEX_INLINE_RE.test(trimmed) ||
    LATEX_COMMAND_RE.test(trimmed) ||
    TABLE_SEPARATOR_RE.test(trimmed) ||
    ASCII_TABLE_RE.test(trimmed) ||
    TABLE_PIPE_RE.test(trimmed)
  );
}

/**
 * 按页拼正文：
 * - 文字页 = `replaceComplexBlocks(该页文本).trim()`，空串跳过（不产生空行）；
 * - 随后**追加该页的区域占位符**（`[图表/公式: 查看手迹 · 第N页·区域M]`，按 y 升序、区域序号 1 起，
 *   见 `regions.ts`）——框内内容不参与 OCR，正文只留占位符指向原图；
 * - 页间用单个 `'\n'` 连接；全空返回 `''`。
 *
 * `pageTexts` 与页一一对齐（页数以此为准）；`pageRegions` 短于 `pageTexts` 或缺省时，
 * 该页按「无区域」处理（多出的 `pageRegions` 会被忽略）。
 */
export function composePageBody(pageTexts: string[], pageRegions: RegionBox[][]): string {
  const texts: string[] = Array.isArray(pageTexts) ? pageTexts : [];
  const regionsByPage: RegionBox[][] = Array.isArray(pageRegions) ? pageRegions : [];
  const parts: string[] = [];
  for (let pageIndex = 0; pageIndex < texts.length; pageIndex++) {
    const raw: string = texts[pageIndex];
    const text: string = replaceComplexBlocks(typeof raw === 'string' ? raw : '').trim();
    if (text.length > 0) {
      parts.push(text);
    }
    let pageBoxes: RegionBox[] = [];
    if (pageIndex < regionsByPage.length && Array.isArray(regionsByPage[pageIndex])) {
      pageBoxes = regionsByPage[pageIndex];
    }
    const placeholders: string[] = regionsToPlaceholders(pageIndex, pageBoxes);
    for (let index = 0; index < placeholders.length; index++) {
      parts.push(placeholders[index]);
    }
  }
  return parts.join('\n');
}

/**
 * 把 OCR 文本里的表格/公式/LaTeX 行替换为占位符，普通文本原样保留。
 * 连续的多行复杂内容只保留一个占位符，避免刷屏；空行与普通行不做任何改动。
 */
export function replaceComplexBlocks(ocrText: string): string {
  const text = typeof ocrText === 'string' ? ocrText : '';
  if (text.length === 0) {
    return '';
  }
  const lines = text.split(/\r?\n/);
  const output: string[] = [];
  let previousWasPlaceholder = false;
  for (const line of lines) {
    if (isComplexLine(line.trim())) {
      if (!previousWasPlaceholder) {
        output.push(STRUCTURED_PLACEHOLDER);
      }
      previousWasPlaceholder = true;
      continue;
    }
    output.push(line);
    previousWasPlaceholder = false;
  }
  return output.join('\n');
}
