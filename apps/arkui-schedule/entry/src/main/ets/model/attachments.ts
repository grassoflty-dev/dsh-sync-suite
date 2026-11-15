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

const SHA256_RE = /^[0-9a-f]{64}$/;

/** 校验并规范化 sha256：必须是小写/大写十六进制的 64 位摘要，输出小写。 */
function normalizeSha256(sha256: string): string {
  const value = typeof sha256 === 'string' ? sha256.trim().toLowerCase() : '';
  if (!SHA256_RE.test(value)) {
    throw new Error(`sha256 不合法（需 64 位十六进制）：${String(sha256)}`);
  }
  return value;
}

/** 附件文件名：`<sha256>.png`。 */
export function attachmentFileName(sha256: string): string {
  return `${normalizeSha256(sha256)}.png`;
}

/**
 * 由手写板各页截图信息生成 `Attachment[]`（按 pageIndex 升序，稳定）。
 * `name` 缺失或含路径分隔符时回退为 `<sha256>.png`，避免写出仓库目录之外。
 */
export function buildAttachmentRefs(
  pages: Array<{ sha256: string; name: string; pageIndex: number }>
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
