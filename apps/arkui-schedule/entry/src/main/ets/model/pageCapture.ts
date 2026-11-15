/**
 * 手写 OCR 两阶段批处理（**纯逻辑**：不 import @ohos / UI，可在 Node 直接跑）。
 *
 * 契约：BRIEF §3.2、「手迹**先全部落盘**，再串行 OCR」+「框选区域不参与 OCR」：
 *
 * 阶段 A（落盘优先，**完全不变**）：
 *   `for pageIndex 0..N-1`：`capturePage` → `sha256` → `savePageAttachment`。
 *   落盘的是**原始**页面截图（含框内内容），整批结束后 `attachments` 已包含全部 N 页；
 *   此时任何一页 OCR 失败，截图仍可人工补录。PixelMap 保留到阶段 B 才释放。
 *
 * 阶段 B（按页序串行识别）：
 *   - 该页有区域框（`sanitizeRegions(pageRegions[i])` 非空）：
 *     先释放**原图** PixelMap → `maskPage(i, regions)` 把框内填白 →
 *     再 `capturePage(i)` 拍一张**遮罩图** → `recognize(遮罩图)` → 释放遮罩图；
 *     `maskedPages++`。没提供 `maskPage` 直接抛错（有框却没法遮 = 不能把框内文字送 OCR）。
 *   - 该页无区域框：直接 `recognize(原图)`，然后释放原图。
 *   每页结果按页序写入 `results`（与页一一对齐）。任一项抛错：释放该页与全部未处理 PixelMap，
 *   抛 `PageCaptureError`（带 `pageIndex` / `attachments` / `pageRegions` / `savedPages`），
 *   **attachments 仍是 N 页**。
 *
 * 取消：`options.cancelled()` 为 true 时，阶段 A 已落盘的保留，未处理的 PixelMap 全部释放；
 * 返回 `failedPage: null`，`results` 只含已处理页（取消只发生在页与页之间，因此是前缀）。
 *
 * 真实 SDK（`componentSnapshot.get` / `image.ImagePacker` / `textRecognition` / 填白）由
 * `harmony/ets/ocr/OcrBatchManager.ets` 注入；本模块只负责编排，Node 测试用假对象即可覆盖。
 *
 * 命名说明：本文件位于 Android 也会编译的共享层（`entry/src/main/ets`），validate 规则 4
 * 禁止出现 `OcrBatch*` 形式的标识符；对外入口仍是 `runPageCaptureBatch`。
 */
import { attachmentFileName, buildAttachmentRefs } from './attachments';
import { sanitizeRegions } from './regions';
import type { Attachment, RegionBox } from './types';

/** 阶段 A 收集到的一页：PixelMap 留到阶段 B 识别，bytes 供排障/校验。 */
export interface PageImage {
  pageIndex: number;
  pixelMap: unknown;
  bytes: Uint8Array;
  sha256: string;
}

/** 可注入依赖：真实实现见 `OcrBatchManager`，测试传假对象。 */
export interface PageCaptureDeps {
  /** 截图第 pageIndex 页（真实实现内部切页 + `componentSnapshot.get` + PNG 编码）。 */
  capturePage(pageIndex: number): Promise<{ pixelMap: unknown; bytes: Uint8Array }>;
  /** 把第 pageIndex 页截图**同步落盘**到 attachments/<sha256>.png（真实实现走 attachmentStore）。 */
  savePageAttachment(pageIndex: number, sha256: string, bytes: Uint8Array): Promise<void>;
  /**
   * 把第 pageIndex 页上的若干**归一化**区域填白（第二次截图前调用）。
   * 缺失而某页又有区域框时，批次会抛 `PageCaptureError`（不会把框内文字送进 OCR）。
   */
  maskPage?: (pageIndex: number, regions: RegionBox[]) => Promise<void>;
  /** 识别单页；失败请直接抛错（本模块会补页码与「截图已落盘」信息）。 */
  recognize(pixelMap: unknown, pageIndex: number): Promise<string>;
  /** 释放单页 PixelMap（真实实现是 `pixelMap.release()`，失败忽略）。 */
  release(pixelMap: unknown): void;
  /** 计算截图 SHA-256（真实实现复用 `model/sha256.ts`）。 */
  sha256(bytes: Uint8Array): string;
}

/** 整批结果（正常完成或取消时返回；OCR/遮罩失败改为抛 `PageCaptureError`）。 */
export interface PageCaptureOutcome {
  /** 已落盘的附件引用（阶段 A 的结果；原始截图，含框内内容；失败时通过错误对象携带，仍是 N 页）。 */
  attachments: Attachment[];
  /**
   * 按页对齐的识别文本（正常完成时长度 = 总页数；取消时是前缀）。
   * 有区域框的页拿到的是**遮罩图**的识别结果（框内已填白）。
   */
  results: string[];
  /** 已落盘页数。 */
  savedPages: number;
  /** 失败页码（0 起）；成功与取消时为 null（失败走异常，见 `PageCaptureError`）。 */
  failedPage: number | null;
  /** `sanitize` 后的每页区域（长度 = 总页数 `N`，不是已处理页数）。 */
  pageRegions: RegionBox[][];
  /** 实际做了「填白 + 二次截图」的页数（有区域框的页数）。 */
  maskedPages: number;
}

/** 可选钩子。 */
export interface PageCaptureOptions {
  /** 取消查询（每页开始前检查；由页面「取消识别」按钮置位）。 */
  cancelled?: () => boolean;
  /** 每页处理完成后回调（页面用它显示「第 n / N 页」；`done` = 已处理页数，`total` = 总页数）。 */
  onProgress?: (done: number, total: number) => void;
  /** 每页区域（归一化）；缺省/短于页数 → 该页无区域。内部一律 `sanitizeRegions`。 */
  pageRegions?: RegionBox[][];
}

/**
 * OCR/遮罩失败异常：除可展示信息外，携带**已全部落盘**的附件与失败页码，
 * 让调用方在失败时仍能把截图引用写进记录（BRIEF §3.2「截图兜底」）。
 */
export class PageCaptureError extends Error {
  /** 失败页（0 起）。 */
  readonly pageIndex: number;
  /** 阶段 A 已落盘的全部附件（失败不影响该列表）。 */
  readonly attachments: Attachment[];
  /** 失败前已完成的识别结果（按 pageIndex 升序）。 */
  readonly results: string[];
  /** 已落盘页数。 */
  readonly savedPages: number;
  /** `sanitize` 后的每页区域（长度 = 总页数），便于失败时仍能按区域补录正文。 */
  readonly pageRegions: RegionBox[][];

  constructor(
    pageIndex: number,
    message: string,
    attachments: Attachment[],
    results: string[],
    savedPages: number,
    pageRegions: RegionBox[][]
  ) {
    super(message);
    this.name = 'PageCaptureError';
    this.pageIndex = pageIndex;
    this.attachments = attachments;
    this.results = results;
    this.savedPages = savedPages;
    this.pageRegions = pageRegions;
  }
}

/** 把未知异常转成可展示文本。 */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/** 页码归一化：非有限数/负数按 0 处理（调用方应传实际页数）。 */
function normalizePageCount(pageCount: number): number {
  if (!Number.isFinite(pageCount)) {
    return 0;
  }
  const value: number = Math.floor(pageCount);
  return value > 0 ? value : 0;
}

/**
 * 归一化每页区域：长度 = 总页数，每页内部 `sanitizeRegions`（丢弃误触、夹紧越界）。
 * `pageRegions` 缺失、比页数短、或某页不是数组时，该页按「无区域」处理。
 */
function normalizePageRegions(pageCount: number, raw: RegionBox[][] | undefined): RegionBox[][] {
  const source: RegionBox[][] = Array.isArray(raw) ? raw : [];
  const regions: RegionBox[][] = [];
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
    let boxes: RegionBox[] = [];
    if (pageIndex < source.length && Array.isArray(source[pageIndex])) {
      boxes = source[pageIndex];
    }
    regions.push(sanitizeRegions(boxes));
  }
  return regions;
}

/** 进度回调：异常不影响整批（UI 回调不该让识别失败）。 */
function reportProgress(
  progress: ((done: number, total: number) => void) | undefined,
  done: number,
  total: number
): void {
  if (progress === undefined) {
    return;
  }
  try {
    progress(done, total);
  } catch {
    // 进度回调异常不影响整批
  }
}

/**
 * 校验并归一化 sha256，复用 `attachmentFileName`（不复制实现）：
 * 返回小写摘要与 `<sha256>.png` 文件名。
 */
function canonicalAttachment(rawSha256: string): { sha256: string; name: string } {
  const name: string = attachmentFileName(rawSha256);
  return { sha256: name.slice(0, name.length - '.png'.length), name: name };
}

/** 释放单页：依赖实现抛错不影响整批（释放是尽力而为）。 */
function safeRelease(deps: PageCaptureDeps, pixelMap: unknown): void {
  try {
    deps.release(pixelMap);
  } catch {
    // 已释放 / 已失效：忽略
  }
}

/** 释放一组尚未处理的 PixelMap（按数组顺序，逐个尝试）。 */
function releaseAll(deps: PageCaptureDeps, pages: PageImage[]): void {
  for (let index = 0; index < pages.length; index++) {
    safeRelease(deps, pages[index].pixelMap);
  }
}

/**
 * 执行两阶段批处理（截图落盘 → 区域填白 → 串行 OCR）。
 *
 * @param pageCount 手写页数（≥1；0 页抛 `Error`）
 * @param deps 注入的截图/落盘/填白/识别/释放/sha256 实现
 * @param options 取消查询、进度回调与每页区域框
 * @throws {PageCaptureError} 阶段 A 或阶段 B 任一项失败（携带 `pageIndex` 与已落盘附件）
 */
export async function runPageCaptureBatch(
  pageCount: number,
  deps: PageCaptureDeps,
  options: PageCaptureOptions = {}
): Promise<PageCaptureOutcome> {
  const total: number = normalizePageCount(pageCount);
  if (total === 0) {
    throw new Error('没有可识别的手写页：请先在画布上书写');
  }
  const isCancelled: () => boolean = function (): boolean {
    if (options.cancelled === undefined) {
      return false;
    }
    try {
      return options.cancelled() === true;
    } catch {
      return false;
    }
  };
  const onProgress: ((done: number, total: number) => void) | undefined = options.onProgress;
  /** 归一化后的每页区域（长度 = 总页数），阶段 A/B 与错误对象都复用这一份。 */
  const pageRegions: RegionBox[][] = normalizePageRegions(total, options.pageRegions);

  /** 阶段 A 收集的页（PixelMap 尚未释放）。 */
  const pages: PageImage[] = [];
  /** 已落盘页（用于生成 Attachment[]，命名复用 buildAttachmentRefs）。 */
  const saved: Array<{ sha256: string; name: string; pageIndex: number }> = [];

  // ---------------------------------------------------------------- 阶段 A：先全部落盘（原始截图）
  for (let pageIndex = 0; pageIndex < total; pageIndex++) {
    if (isCancelled()) {
      break;
    }
    let pixelMap: unknown = null;
    let captured: boolean = false;
    try {
      const shot: { pixelMap: unknown; bytes: Uint8Array } = await deps.capturePage(pageIndex);
      pixelMap = shot.pixelMap;
      captured = true;
      if (isCancelled()) {
        // 取消发生在截图之后、落盘之前：本页不落盘，直接释放
        safeRelease(deps, pixelMap);
        captured = false;
        break;
      }
      const canonical: { sha256: string; name: string } = canonicalAttachment(deps.sha256(shot.bytes));
      // 关键顺序：先把截图写进 attachments/<sha256>.png
      await deps.savePageAttachment(pageIndex, canonical.sha256, shot.bytes);
      saved.push({ sha256: canonical.sha256, name: canonical.name, pageIndex: pageIndex });
      pages.push({
        pageIndex: pageIndex,
        pixelMap: pixelMap,
        bytes: shot.bytes,
        sha256: canonical.sha256
      });
      // 所有权移交给 pages，异常路径不再重复释放
      captured = false;
    } catch (error) {
      if (captured) {
        safeRelease(deps, pixelMap);
      }
      releaseAll(deps, pages);
      throw new PageCaptureError(
        pageIndex,
        `第 ${pageIndex + 1} 页截图/落盘失败：${describeError(error)}（已落盘 ${saved.length} 页）`,
        buildAttachmentRefs(saved),
        [],
        saved.length,
        pageRegions
      );
    }
  }

  // 阶段 A 结束：无论后面 OCR 是否成功，这 N 个附件都已落盘
  const attachments: Attachment[] = buildAttachmentRefs(saved);

  // ---------------------------------------------------------------- 阶段 B：区域填白 + 串行识别
  const pending: PageImage[] = pages.slice();
  const results: string[] = [];
  /** 实际做了「填白 + 二次截图」的页数。 */
  let maskedPages: number = 0;
  while (pending.length > 0) {
    if (isCancelled()) {
      releaseAll(deps, pending);
      pending.length = 0;
      break;
    }
    // 当前页先出队：后续失败时 `releaseAll(pending)` 只释放「还没处理」的页，
    // 当前页（及其遮罩图）由下面的错误分支自己释放，避免重复 release。
    const image: PageImage = pending[0];
    pending.shift();
    const regions: RegionBox[] = pageRegions[image.pageIndex];

    if (regions.length === 0) {
      let text: string;
      try {
        text = await deps.recognize(image.pixelMap, image.pageIndex);
      } catch (error) {
        safeRelease(deps, image.pixelMap);
        releaseAll(deps, pending);
        throw new PageCaptureError(
          image.pageIndex,
          `第 ${image.pageIndex + 1} 页 OCR 识别失败：${describeError(error)}（${attachments.length} 页截图已全部落盘）`,
          attachments,
          results.slice(),
          saved.length,
          pageRegions
        );
      }
      results.push(typeof text === 'string' ? text : '');
      safeRelease(deps, image.pixelMap);
      reportProgress(onProgress, results.length, total);
      continue;
    }

    // 有区域框：先释放原图（填白 + 二次截图需要独占画布/内存），再遮罩
    safeRelease(deps, image.pixelMap);
    const maskPage: ((pageIndex: number, boxes: RegionBox[]) => Promise<void>) | undefined = deps.maskPage;
    if (maskPage === undefined) {
      releaseAll(deps, pending);
      throw new PageCaptureError(
        image.pageIndex,
        `第 ${image.pageIndex + 1} 页有区域框但未提供遮罩能力（框内内容不能送 OCR；${attachments.length} 页截图已全部落盘）`,
        attachments,
        results.slice(),
        saved.length,
        pageRegions
      );
    }
    try {
      await maskPage(image.pageIndex, regions);
    } catch (error) {
      releaseAll(deps, pending);
      throw new PageCaptureError(
        image.pageIndex,
        `第 ${image.pageIndex + 1} 页区域填白失败：${describeError(error)}（${attachments.length} 页截图已全部落盘）`,
        attachments,
        results.slice(),
        saved.length,
        pageRegions
      );
    }

    // 遮罩图只用于识别，不落盘（附件里的 N 页是原始截图，不丢框内内容）
    let maskedPixelMap: unknown = null;
    try {
      const maskedShot: { pixelMap: unknown; bytes: Uint8Array } = await deps.capturePage(image.pageIndex);
      maskedPixelMap = maskedShot.pixelMap;
    } catch (error) {
      releaseAll(deps, pending);
      throw new PageCaptureError(
        image.pageIndex,
        `第 ${image.pageIndex + 1} 页遮罩截图失败：${describeError(error)}（${attachments.length} 页截图已全部落盘）`,
        attachments,
        results.slice(),
        saved.length,
        pageRegions
      );
    }

    let maskedText: string;
    try {
      maskedText = await deps.recognize(maskedPixelMap, image.pageIndex);
    } catch (error) {
      safeRelease(deps, maskedPixelMap);
      releaseAll(deps, pending);
      throw new PageCaptureError(
        image.pageIndex,
        `第 ${image.pageIndex + 1} 页 OCR 识别失败：${describeError(error)}（${attachments.length} 页截图已全部落盘）`,
        attachments,
        results.slice(),
        saved.length,
        pageRegions
      );
    }
    results.push(typeof maskedText === 'string' ? maskedText : '');
    maskedPages += 1;
    safeRelease(deps, maskedPixelMap);
    reportProgress(onProgress, results.length, total);
  }

  return {
    attachments: attachments,
    results: results,
    savedPages: saved.length,
    failedPage: null,
    pageRegions: pageRegions,
    maskedPages: maskedPages
  };
}
