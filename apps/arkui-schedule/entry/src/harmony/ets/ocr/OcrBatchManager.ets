/**
 * 手写页 OCR 批处理（**仅 HarmonyOS**）。
 *
 * 严格按 BRIEF §3.2 的顺序，逐页串行（`maxConcurrency = 1`）：
 * 1. `componentSnapshot.get(<pageId>)` 拿到该页 PixelMap；
 * 2. `image.createImagePacker().packing(pixelMap, {format:'image/png'})` → 写
 *    `attachments/<sha256>.png`（同步落盘：OCR 失败也能凭截图人工补录）；
 * 3. `textRecognition.recognizeText({ pixelMap })` → 写 `results[pageIndex]`（保持页码顺序）；
 * 4. **立刻** `pixelMap.release()`，不把上一页的内存带到下一页。
 *
 * 整批 `textRecognition.init()` / `release()` 包住；取消时释放所有未处理的 PixelMap。
 * 全部完成后 0→N 拼接：`concatPageTexts(raw)` 作为 `ocr_text` 原文，
 * `replaceComplexBlocks(...)` 作为写入正文的文本（表格/公式行降级为
 * `[公式/图表: 查看手迹]` 占位符，原图仍是兜底）。
 *
 * ⚠ 本机无 HarmonyOS SDK，无法编译/真机验证；`textRecognition` 的 init/release
 * 与 `componentSnapshot.get` 的可用性需真机核对（不同 API 版本存在差异）。
 */
import { componentSnapshot } from '@kit.ArkUI';
import { image } from '@kit.ImageKit';
import { textRecognition } from '@kit.CoreVisionKit';
import { buildAttachmentRefs, concatPageTexts, replaceComplexBlocks } from '../model/attachments';
import type { Attachment } from '../model/types';
import type { AttachmentStore } from '../services/attachmentStore';

/** 单页处理结果（pageIndex 与手写板页码一一对应）。 */
export interface OcrPageResult {
  pageIndex: number;
  sha256: string;
  name: string;
  text: string;
}

/** 整批结果。 */
export interface OcrBatchResult {
  /** 逐页结果，按 pageIndex 升序。 */
  pageResults: OcrPageResult[];
  /** 已落盘的截图引用，可直接写入记录的 attachments 字段。 */
  attachments: Attachment[];
  /** 每页原始识别文本（未做占位符替换）。 */
  pageTexts: string[];
  /** 0→N 拼接后的原始识别文本（写入 ocr_text）。 */
  rawText: string;
  /** 占位符替换后的文本（追加到正文）。 */
  text: string;
  /** 是否因取消而提前结束。 */
  cancelled: boolean;
}

export interface OcrBatchOptions {
  /** 每页可被 `componentSnapshot.get` 截图的组件 id，顺序即 pageIndex。 */
  snapshotIds: string[];
  /** 附件落盘端口（单例 attachmentStore，便于测试时替换）。 */
  store: AttachmentStore;
  /**
   * 截图前的切页钩子：把第 pageIndex 页切到「当前页」并等一帧。
   * 只有当前页是完全不透明参与绘制的，`componentSnapshot` 才能稳定截到内容，
   * 因此整批识别时逐页切换（页面会看到翻页动画结束后的静态页）。
   */
  preparePage?: (pageIndex: number) => Promise<void>;
}

export class OcrBatchManager {
  /** 串行：同一时刻只处理一页（BRIEF §3.2 硬要求）。 */
  readonly maxConcurrency: number = 1;

  private options: OcrBatchOptions;
  private cancelled: boolean = false;
  private running: boolean = false;
  /** 已截图但尚未完成 OCR 的 PixelMap（取消时全部释放）。 */
  private pending: image.PixelMap[] = [];

  constructor(options: OcrBatchOptions) {
    this.options = options;
  }

  isCancelled(): boolean {
    return this.cancelled;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** 取消整批：标记 + 释放所有未处理的 PixelMap。 */
  async cancel(): Promise<void> {
    this.cancelled = true;
    await this.releasePending();
  }

  /**
   * 执行整批识别。
   * @param onProgress 每页完成后回调（页面用它显示「第 n / N 页」）
   */
  async run(onProgress?: (done: number, total: number) => void): Promise<OcrBatchResult> {
    const ids = this.options.snapshotIds;
    const total = ids.length;
    if (total === 0) {
      throw new Error('没有可识别的手写页：请先在画布上书写');
    }
    if (this.running) {
      throw new Error('OCR 批次正在执行中，请勿重复触发');
    }
    this.running = true;
    this.cancelled = false;

    const pageTexts: string[] = [];
    for (let i = 0; i < total; i++) {
      pageTexts.push('');
    }
    const pages: Array<{ sha256: string; name: string; pageIndex: number }> = [];
    const pageResults: OcrPageResult[] = [];

    let ocrStarted = false;
    let packer: image.ImagePacker | null = null;
    try {
      // OCR 引擎整批初始化（部分版本无需显式 init，失败不阻断逐页调用）
      try {
        await textRecognition.init();
        ocrStarted = true;
      } catch {
        ocrStarted = false;
      }
      packer = image.createImagePacker();

      for (let pageIndex = 0; pageIndex < total; pageIndex++) {
        if (this.cancelled) {
          break;
        }
        const pageId = ids[pageIndex];
        let pixelMap: image.PixelMap | null = null;
        try {
          // 先把该页切到前台并等一帧，保证截图拿到的是完整内容
          if (this.options.preparePage !== undefined) {
            await this.options.preparePage(pageIndex);
          }
          pixelMap = await this.capture(pageId, pageIndex);
          this.pending.push(pixelMap);

          const png = await this.packToPng(packer, pixelMap, pageIndex);
          // 先落盘再识别：OCR 失败也有截图兜底
          const attachment = this.options.store.savePageAttachment(png, pageIndex);
          pages.push({ sha256: attachment.sha256, name: attachment.name, pageIndex: pageIndex });

          const text = await this.recognize(pixelMap, pageIndex);
          pageTexts[pageIndex] = text;
          pageResults.push({
            pageIndex: pageIndex,
            sha256: attachment.sha256,
            name: attachment.name,
            text: text
          });
          if (onProgress !== undefined) {
            onProgress(pageIndex + 1, total);
          }
        } finally {
          // 每页立即释放，避免多页 PixelMap 叠加占用内存
          if (pixelMap !== null) {
            await this.releasePixelMap(pixelMap);
            this.removePending(pixelMap);
          }
        }
      }
    } finally {
      await this.releasePending();
      if (packer !== null) {
        try {
          await packer.release();
        } catch {
          // 释放失败不影响结果
        }
      }
      if (ocrStarted) {
        try {
          await textRecognition.release();
        } catch {
          // release 失败忽略
        }
      }
      this.running = false;
    }

    const rawText = concatPageTexts(pageTexts);
    pageResults.sort((left: OcrPageResult, right: OcrPageResult) => left.pageIndex - right.pageIndex);
    return {
      pageResults: pageResults,
      attachments: buildAttachmentRefs(pages),
      pageTexts: pageTexts,
      rawText: rawText,
      text: replaceComplexBlocks(rawText),
      cancelled: this.cancelled
    };
  }

  // ------------------------------------------------------------------ 内部实现

  private async capture(pageId: string, pageIndex: number): Promise<image.PixelMap> {
    try {
      return await componentSnapshot.get(pageId);
    } catch (error) {
      throw new Error(`第 ${pageIndex + 1} 页截图失败（组件 ${pageId} 尚未渲染完成）：${this.describe(error)}`);
    }
  }

  private async packToPng(packer: image.ImagePacker, pixelMap: image.PixelMap, pageIndex: number): Promise<ArrayBuffer> {
    try {
      return await packer.packing(pixelMap, { format: 'image/png', quality: 100 });
    } catch (error) {
      throw new Error(`第 ${pageIndex + 1} 页编码 PNG 失败：${this.describe(error)}`);
    }
  }

  private async recognize(pixelMap: image.PixelMap, pageIndex: number): Promise<string> {
    try {
      const visionInfo: textRecognition.VisionInfo = { pixelMap: pixelMap };
      const result = await textRecognition.recognizeText(visionInfo);
      const value = result.value;
      return typeof value === 'string' ? value : '';
    } catch (error) {
      throw new Error(`第 ${pageIndex + 1} 页 OCR 识别失败：${this.describe(error)}`);
    }
  }

  private async releasePixelMap(pixelMap: image.PixelMap): Promise<void> {
    try {
      await pixelMap.release();
    } catch {
      // 已释放或已失效，忽略
    }
  }

  private async releasePending(): Promise<void> {
    const list = this.pending;
    this.pending = [];
    for (const pixelMap of list) {
      await this.releasePixelMap(pixelMap);
    }
  }

  private removePending(pixelMap: image.PixelMap): void {
    const kept: image.PixelMap[] = [];
    for (const item of this.pending) {
      if (item !== pixelMap) {
        kept.push(item);
      }
    }
    this.pending = kept;
  }

  private describe(error: object): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }
}

/** 默认单例构造参数（页面用当前单例 store + 页码 id 前缀拼出 snapshotIds）。 */
export const OCR_PAGE_ID_PREFIX: string = 'hw-page-';
