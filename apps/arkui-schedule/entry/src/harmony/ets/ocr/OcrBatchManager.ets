/**
 * 手写页 OCR 批处理（**仅 HarmonyOS**）。
 *
 * 本文件是薄适配层：真实 SDK 能力注入给纯逻辑 `model/pageCapture.ts` 的 `runPageCaptureBatch`，
 * 顺序与内存语义全部由模型层保证（BRIEF §3.2 + 区域框需求）：
 * 1. **阶段 A（全部页都落盘）**：逐页 `componentSnapshot.get` → `image.ImagePacker.packing(PNG)` →
 *    同步写 `attachments/<sha256>.png`。落盘的是**原始截图**（含框内内容），先全部保存再识别，
 *    不做增量/单页识别；
 * 2. **阶段 B（框内填白 + 统一识别）**：有区域框的页先调 `maskPage`（handwriting pager 把框内
 *    填成白色）→ 二次截图 → 只对**遮罩图**做 `textRecognition.recognizeText`；
 *    框内内容因此不会进入识别结果，正文改由 `composePageBody` 插入
 *    `[图表/公式: 查看手迹 · 第N页·区域M]` 占位符。每个 PixelMap 用完立即释放；
 * 3. 整批 `textRecognition.init()` / `release()` 包住；取消时释放所有未处理 PixelMap；
 * 4. 全部页处理完后 0→N 拼接：`concatPageTexts(raw)` 作为 `ocr_text` 原文，
 *    `composePageBody(pageTexts, pageRegions)` 作为写入正文的文本。
 *
 * ⚠ 本机无 HarmonyOS SDK，无法编译/真机验证；`textRecognition` 的 init/release
 * 与 `componentSnapshot.get` 的可用性需真机核对（不同 API 版本存在差异）。
 */
import { componentSnapshot } from '@kit.ArkUI';
import { image } from '@kit.ImageKit';
import { textRecognition } from '@kit.CoreVisionKit';
import type { PageCaptureDeps, PageCaptureOptions, PageCaptureOutcome } from '../model/pageCapture';
import { runPageCaptureBatch } from '../model/pageCapture';
import { composePageBody, concatPageTexts } from '../model/attachments';
import { sha256Hex } from '../model/sha256';
import type { Attachment, RegionBox } from '../model/types';
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
  /** 逐页结果，按 pageIndex 升序（未识别的页 text 为空串）。 */
  pageResults: OcrPageResult[];
  /** 已落盘的原始截图引用，可直接写入记录的 attachments 字段。 */
  attachments: Attachment[];
  /** 每页文本，**按页对齐**（长度 = 页数；有区域框的页是遮罩图的识别结果）。 */
  pageTexts: string[];
  /** 0→N 拼接后的原始识别文本（写入 ocr_text）。 */
  rawText: string;
  /** 正文文本：识别文本 + 区域框占位符（追加到正文）。 */
  text: string;
  /** 实际做了「框内填白 + 二次截图」的页数。 */
  maskedPages: number;
  /** 区域框总数（便于页面提示「框内未识别」）。 */
  regionCount: number;
  /** 是否因取消而提前结束。 */
  cancelled: boolean;
}

export interface OcrBatchOptions {
  /** 每页可被 `componentSnapshot.get` 截图的组件 id，**按页序**排列（顺序即 pageIndex）。 */
  snapshotIds: string[];
  /** 每页的区域框（与 snapshotIds 同序；框内内容不送 OCR，只保存原图）。 */
  pageRegions?: RegionBox[][];
  /** 附件落盘端口（单例 attachmentStore，便于测试时替换）。 */
  store: AttachmentStore;
  /**
   * 截图前的切页钩子：把第 pageIndex 页切到「当前页」并等一帧。
   * 只有当前页是完全不透明参与绘制的，`componentSnapshot` 才能稳定截到内容，
   * 因此整批截图时逐页切换（页面会看到翻页动画结束后的静态页）。
   */
  preparePage?: (pageIndex: number) => Promise<void>;
  /**
   * 框内填白钩子：把第 pageIndex 页上的若干归一化矩形填成白色（再由本类的 `capturePage`
   * 二次截图送 OCR）。有区域框却未提供该能力时，模型层会抛错而不是把框内文字送去识别。
   */
  maskPage?: (pageIndex: number, regions: RegionBox[]) => Promise<void>;
}

/** 截图 + PNG 编码的结果（显式接口：ArkTS 禁止内联对象类型字面量与 `unknown`）。 */
interface PageShot {
  pixelMap: image.PixelMap;
  bytes: Uint8Array;
}

/** 把异常转成可展示的中文文本。 */
function describeError(error: object): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/** 统计整批的区域框数量（跨页求和）。 */
function countRegions(pageRegions: RegionBox[][]): number {
  let count: number = 0;
  for (let pageIndex = 0; pageIndex < pageRegions.length; pageIndex++) {
    const boxes: RegionBox[] = pageRegions[pageIndex];
    count += boxes.length;
  }
  return count;
}

export class OcrBatchManager {
  /** 串行：同一时刻只处理一页（BRIEF §3.2 硬要求）。 */
  readonly maxConcurrency: number = 1;

  private options: OcrBatchOptions;
  private cancelled: boolean = false;
  private running: boolean = false;

  constructor(options: OcrBatchOptions) {
    this.options = options;
  }

  isCancelled(): boolean {
    return this.cancelled;
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * 取消整批：只置取消标志（`runPageCaptureBatch` 在下一个检查点释放全部未处理 PixelMap，
   * 已落盘的附件保留）。保留 `async` 以兼容页面 `await manager.cancel()` 的调用方式。
   */
  async cancel(): Promise<void> {
    this.cancelled = true;
  }

  /**
   * 执行整批（两阶段：**先把所有页的原始截图落盘**，再对框内填白、统一识别）。
   * @param onProgress 每页处理完成后回调（页面用它显示「已处理 n / N 页（原图已保存）」）
   */
  async run(onProgress?: (done: number, total: number) => void): Promise<OcrBatchResult> {
    const ids: string[] = this.options.snapshotIds;
    const total: number = ids.length;
    if (total === 0) {
      throw new Error('没有可识别的手写页：请先在画布上书写');
    }
    if (this.running) {
      throw new Error('OCR 批次正在执行中，请勿重复触发');
    }
    this.running = true;
    this.cancelled = false;

    let ocrStarted: boolean = false;
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
      const activePacker: image.ImagePacker = packer;

      const deps: PageCaptureDeps = {
        capturePage: (pageIndex: number): Promise<PageShot> =>
          this.capturePage(activePacker, ids[pageIndex], pageIndex),
        savePageAttachment: (pageIndex: number, sha256: string, bytes: Uint8Array): Promise<void> => {
          this.savePageAttachment(sha256, bytes, pageIndex);
          return Promise.resolve();
        },
        recognize: (pixelMap: image.PixelMap): Promise<string> => this.recognize(pixelMap),
        release: (pixelMap: image.PixelMap): void => {
          this.releasePixelMap(pixelMap);
        },
        sha256: (bytes: Uint8Array): string => sha256Hex(bytes)
      };
      // 区域填白能力按需透传：没有配置就不注册（模型层会在「有框但无遮罩」时抛错）
      const maskOption: ((pageIndex: number, regions: RegionBox[]) => Promise<void>) | undefined =
        this.options.maskPage;
      if (maskOption !== undefined) {
        deps.maskPage = (pageIndex: number, regions: RegionBox[]): Promise<void> =>
          this.applyMask(maskOption, pageIndex, regions);
      }

      const options: PageCaptureOptions = {
        cancelled: (): boolean => this.cancelled,
        onProgress: onProgress
      };
      if (this.options.pageRegions !== undefined) {
        options.pageRegions = this.options.pageRegions;
      }

      const outcome: PageCaptureOutcome = await runPageCaptureBatch(total, deps, options);
      return this.toResult(outcome);
    } finally {
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
  }

  // ------------------------------------------------------------------ 内部实现

  /** 转调页面注册的填白实现（包装成 Promise，异常带页码）。 */
  private async applyMask(
    impl: (pageIndex: number, regions: RegionBox[]) => Promise<void>,
    pageIndex: number,
    regions: RegionBox[]
  ): Promise<void> {
    try {
      await impl(pageIndex, regions);
    } catch (error) {
      throw new Error(`第 ${pageIndex + 1} 页区域填白失败：${describeError(error as object)}`);
    }
  }

  /** 截图 + PNG 编码：编码失败也要释放 PixelMap。 */
  private async capturePage(
    packer: image.ImagePacker,
    pageId: string,
    pageIndex: number
  ): Promise<PageShot> {
    if (this.options.preparePage !== undefined) {
      await this.options.preparePage(pageIndex);
    }
    let pixelMap: image.PixelMap;
    try {
      pixelMap = await componentSnapshot.get(pageId);
    } catch (error) {
      throw new Error(`截图失败（组件 ${pageId} 尚未渲染完成）：${describeError(error as object)}`);
    }
    try {
      const packed: ArrayBuffer = await packer.packing(pixelMap, { format: 'image/png', quality: 100 });
      return { pixelMap: pixelMap, bytes: new Uint8Array(packed) };
    } catch (error) {
      this.releasePixelMap(pixelMap);
      throw new Error(`编码 PNG 失败：${describeError(error as object)}`);
    }
  }

  /**
   * 同步落盘一页截图（attachmentStore 内部按 sha256 去重命名，返回时文件已可读）。
   * 顺带校验 store 计算出的 sha256 与阶段 A 计算值一致，避免附件名与内容错位。
   */
  private savePageAttachment(sha256: string, bytes: Uint8Array, pageIndex: number): void {
    const attachment: Attachment = this.options.store.savePageAttachment(this.toArrayBuffer(bytes), pageIndex);
    if (attachment.sha256 !== sha256) {
      throw new Error(
        `第 ${pageIndex + 1} 页附件 sha256 与截图内容不一致（落盘 ${attachment.sha256}，计算 ${sha256}）`
      );
    }
  }

  private async recognize(pixelMap: image.PixelMap): Promise<string> {
    const visionInfo: textRecognition.VisionInfo = { pixelMap: pixelMap };
    // 返回类型由 SDK 推断（不同 API 版本命名略有差异，避免写死不存在的类型名）
    const result = await textRecognition.recognizeText(visionInfo);
    const value: string = result.value;
    return typeof value === 'string' ? value : '';
  }

  private releasePixelMap(pixelMap: image.PixelMap): void {
    try {
      const task: Promise<void> = pixelMap.release();
      task.catch(() => {
        // 已释放或已失效，忽略
      });
    } catch {
      // 同步抛错同样忽略
    }
  }

  /** `Uint8Array` → 独立 `ArrayBuffer`（attachmentStore 只接受 ArrayBuffer）。 */
  private toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    const copy: Uint8Array = new Uint8Array(bytes.length);
    copy.set(bytes);
    return copy.buffer as ArrayBuffer;
  }

  /** 按页取值（越界一律空串）。 */
  private textAt(pageTexts: string[], pageIndex: number): string {
    if (pageIndex < 0 || pageIndex >= pageTexts.length) {
      return '';
    }
    const text: string = pageTexts[pageIndex];
    return typeof text === 'string' ? text : '';
  }

  /** 模型层结果 → 页面 API 结果（保持 Handwriting 页现有调用方式）。 */
  private toResult(outcome: PageCaptureOutcome): OcrBatchResult {
    // results 已按页对齐：有区域框的页是「框内填白后」的识别文本
    const pageTexts: string[] = outcome.results.slice();
    const pageResults: OcrPageResult[] = [];
    for (let index = 0; index < outcome.attachments.length; index++) {
      const attachment: Attachment = outcome.attachments[index];
      pageResults.push({
        pageIndex: attachment.pageIndex,
        sha256: attachment.sha256,
        name: attachment.name,
        text: this.textAt(pageTexts, attachment.pageIndex)
      });
    }
    const rawText: string = concatPageTexts(pageTexts);
    const text: string = composePageBody(pageTexts, outcome.pageRegions);
    return {
      pageResults: pageResults,
      attachments: outcome.attachments,
      pageTexts: pageTexts,
      rawText: rawText,
      text: text,
      maskedPages: outcome.maskedPages,
      regionCount: countRegions(outcome.pageRegions),
      cancelled: this.cancelled
    };
  }
}

/** 默认截图组件 id 前缀（页面按页序拼出 `hw-page-<slot>`）。 */
export const OCR_PAGE_ID_PREFIX: string = 'hw-page-';
