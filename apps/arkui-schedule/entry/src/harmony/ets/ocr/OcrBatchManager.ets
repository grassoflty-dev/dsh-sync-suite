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
import { composePageBody, concatPageTexts, ATTACHMENT_JPEG_QUALITY, ATTACHMENT_MAX_SIDE } from '../model/attachments';
import { sha256Hex } from '../model/sha256';
import type { Attachment, RegionBox } from '../model/types';
import type { AttachmentStore } from '../services/attachmentStore';
import { cellRegions, tableToMarkdown, TABLE_CELL_TIMEOUT_MS, TABLE_OCR_TIMEOUT_MS } from '../model/tableOcr';
import type { CellRegion } from '../model/tableOcr';
import type { NormalizedRect } from '../model/pageObjects';

/** 一个待逐格识别的表格（`finish()` 按页收集后传进来）。 */
export interface TableCellTask {
  /** 页面对象 id（结果按它回填）。 */
  id: string;
  /** 属于第几页（0 起，与 `snapshotIds` 同序）。 */
  pageIndex: number;
  /** 表格矩形（归一化 0..1，**画布区域坐标系**：与落盘 JPEG 同基准）。 */
  rect: NormalizedRect;
  rows: number;
  cols: number;
}

/** 单个表格的识别结果。 */
export interface TableOcrResult {
  id: string;
  pageIndex: number;
  /** true = 成功（`markdown` 有效）；false = 回退占位符。 */
  ok: boolean;
  markdown: string;
  failedCells: number;
  /** 失败原因（中文，`ok:true` 时为空串）。 */
  reason: string;
}

/** 单页处理结果（pageIndex 与手写板页码一一对应）。 */
export interface OcrPageResult {
  pageIndex: number;
  sha256: string;
  name: string;
  text: string;
}

/** 整批结果。 */
export interface OcrBatchResult {
  /** 表格逐格识别结果（每个 ocrEnabled 表格一条）。 */
  tables: TableOcrResult[];
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
  /** 需要逐格识别的表格（按页收集；空/未传则不识别表格）。 */
  tableTasks?: TableCellTask[];
  /** 进度回调（状态行文案 + 0..1 进度）。 */
  onProgress?: (message: string, ratio: number) => void;
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
  /** 超时未等到、需要整批收尾再释放的 PixelMap（D4：避免 use-after-release）。 */
  private deferredReleases: image.PixelMap[] = [];
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
      const result: OcrBatchResult = this.toResult(outcome);
      // 表格逐格识别：在页图全部落盘之后做（用 ttachments-src 里的页 JPEG，画布区域坐标系）
      const tasks: TableCellTask[] = this.options.tableTasks === undefined ? [] : this.options.tableTasks;
      result.tables = await this.runTableOcr(tasks, result.attachments);
      return result;
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
      this.drainDeferred();
      this.running = false;
    }
  }

  // ------------------------------------------------------------------ 内部实现

  // ------------------------------------------------------------------ 表格逐格 OCR

  /**
   * 对每个 `ocrEnabled` 的表格做逐格 OCR（串行、每格 5s、总计 60s）。
   *
   * 关键点（坐标系，C 项注释订正）：`cellRegions(rect, pageW, pageH, rows, cols)` 接受的是
   * **画布区域截图**的像素尺寸。这里从「页 JPEG」（`attachments-src/<sha>.jpg`，与 zip 同一份）解码，
   * 拿到的就是**画布区域**像素图 —— 对象归一化坐标与落盘 JPEG **同基准**，所以 `rect` 直接按该图
   * 尺寸换算即可，**不要**改成整窗截图。若将来必须改：换算放 `collectTableTasks` / `finish()` 侧
   * （offset = 横屏 rail 73vp / 竖屏顶栏 49vp），不要在这里偷偷加偏移，否则整体错位。
   *
   * 裁剪方式：**每格重新从 JPEG 解码一次再 `crop`**。`PixelMap.crop()` 是就地修改，
   * 复用同一张图会让后续格子的坐标失效；每格解码的代价（≤36 格）远小于坐标错位的风险。
   */
  private async runTableOcr(tasks: TableCellTask[], attachments: Attachment[]): Promise<TableOcrResult[]> {
    const results: TableOcrResult[] = [];
    if (tasks.length === 0) {
      return results;
    }
    const deadline: number = Date.now() + TABLE_OCR_TIMEOUT_MS;
    for (const task of tasks) {
      if (this.cancelled) {
        results.push(this.tableFailed(task, 0, '已取消识别'));
        continue;
      }
      if (task.pageIndex < 0 || task.pageIndex >= attachments.length) {
        results.push(this.tableFailed(task, 0, '页面截图缺失'));
        continue;
      }
      const sha256: string = attachments[task.pageIndex].sha256;
      let bytes: ArrayBuffer;
      try {
        bytes = this.options.store.readSourceBytes(sha256);
      } catch (error) {
        results.push(this.tableFailed(task, 0, `读取页面图失败：${describeError(error as object)}`));
        continue;
      }
      let pagePixel: image.PixelMap | null = null;
      let cells: CellRegion[] = [];
      let pageW: number = 0;
      let pageH: number = 0;
      try {
        pagePixel = await this.decodePixel(bytes);
        const info: image.ImageInfo = await pagePixel.getImageInfo();
        pageW = info.size.width;
        pageH = info.size.height;
        cells = cellRegions(task.rect, pageW, pageH, task.rows, task.cols);
      } catch (error) {
        results.push(this.tableFailed(task, 0, `页面图解析失败：${describeError(error as object)}`));
        continue;
      } finally {
        if (pagePixel !== null) {
          this.releasePixelMap(pagePixel);
        }
      }
      // 逐格识别（串行）
      const texts: string[] = [];
      let failed: number = 0;
      for (let index = 0; index < cells.length; index++) {
        if (this.cancelled || Date.now() > deadline) {
          failed += cells.length - index;
          break;
        }
        const text: string | null = await this.recognizeCell(bytes, cells[index]);
        if (text === null) {
          failed++;
          texts.push('');
        } else {
          texts.push(text);
        }
        if (this.options.onProgress !== undefined) {
          this.options.onProgress(
            `正在识别表格 ${Math.min(index + 1, cells.length)}/${cells.length} 格…`,
            (task.pageIndex + 1) / Math.max(1, attachments.length)
          );
        }
      }
      // 失败格数 > 一半 → 放弃该表（回退占位符），否则拼 Markdown
      // D2（reviewer 阻塞缺陷）：格子数必须 = rows*cols，否则是空壳表（禁止 tableToMarkdown([]) 产出 \|   |   |\）
      if (cells.length !== task.rows * task.cols) {
        results.push(
          this.tableFailed(task, cells.length, '表格格子数异常：已保留原图')
        );
        continue;
      }
      if (failed > Math.floor(cells.length / 2)) {
        results.push(this.tableFailed(task, failed, failed >= cells.length ? '表格识别超时，已保留原图' : '表格识别失败格过多'));
        continue;
      }
      const matrix: string[][] = [];
      for (let row = 0; row < task.rows; row++) {
        const line: string[] = [];
        for (let col = 0; col < task.cols; col++) {
          line.push(texts[row * task.cols + col] === undefined ? '' : texts[row * task.cols + col]);
        }
        matrix.push(line);
      }
      results.push({
        id: task.id,
        pageIndex: task.pageIndex,
        ok: true,
        markdown: tableToMarkdown(matrix),
        failedCells: failed,
        reason: ''
      });
      console.info(`[hw] table ocr id=${task.id} cells=${cells.length} failed=${failed} ok=1`);
    }
    return results;
  }

  /**
   * 单格识别：重新解码 → crop → recognize，5s 超时；失败/超时返回 null。
   *
   * D4（reviewer 阻塞缺陷）：**超时那一路不能立刻 release PixelMap**。
   * 超时只是我们不等了，但 native 侧的 `recognizeText` 仍在读这块内存，
   * 立刻 release 会踩 use-after-free / use-after-release 导致整批崩溃。
   * 因此超时把 PixelMap 记进 `deferredReleases`，由整批收尾（`run()` 的 finally）统一释放。
   */
  private async recognizeCell(bytes: ArrayBuffer, cell: CellRegion): Promise<string | null> {
    let pixel: image.PixelMap | null = null;
    let timedOut: boolean = false;
    try {
      pixel = await this.decodePixel(bytes);
      const region: image.Region = {
        x: cell.x,
        y: cell.y,
        size: { width: cell.w, height: cell.h }
      };
      await pixel.crop(region);
      const text: string = await this.withTimeout(this.recognize(pixel), TABLE_CELL_TIMEOUT_MS);
      return text;
    } catch (error) {
      timedOut = pixel !== null;
      return null;
    } finally {
      if (pixel !== null) {
        if (timedOut) {
          // 交给整批收尾释放（识别 promise 可能仍在跑）
          this.deferredReleases.push(pixel);
        } else {
          this.releasePixelMap(pixel);
        }
      }
    }
  }

  /** 整批收尾：释放所有「超时未等到」的 PixelMap。 */
  private drainDeferred(): void {
    for (const pixel of this.deferredReleases) {
      this.releasePixelMap(pixel);
    }
    this.deferredReleases = [];
  }

  /** 从 JPEG 字节解码 PixelMap（每格一次，避免就地 crop 污染）。 */
  private async decodePixel(bytes: ArrayBuffer): Promise<image.PixelMap> {
    const source: image.ImageSource = image.createImageSource(bytes);
    try {
      return await source.createPixelMap();
    } finally {
      source.release().catch(() => {
        // 释放失败忽略
      });
    }
  }

  /** 给识别加超时（超时 reject，上层按失败格计数）。 */
  private withTimeout(task: Promise<string>, ms: number): Promise<string> {
    return new Promise<string>((resolve: (value: string) => void, reject: (error: Object) => void) => {
      const timer: number = setTimeout(() => {
        reject(new Error('识别超时'));
      }, ms);
      task.then(
        (value: string) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: Object) => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  }

  private tableFailed(task: TableCellTask, failedCells: number, reason: string): TableOcrResult {
    console.info(`[hw] table ocr id=${task.id} ok=0 reason=${reason}`);
    return { id: task.id, pageIndex: task.pageIndex, ok: false, markdown: '', failedCells: failedCells, reason: reason };
  }

  /** 转调页面注册的填白实现（包装成 Promise，异常带页码）。 */  private async applyMask(
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

  /**
   * 截图 + **JPEG 编码**（q=60，最长边 ≤1440px）：编码失败也要释放 PixelMap。
   *
   * 为什么要压缩：附件要进 git，PNG 一页 1–3MB，JPEG q60 + 1440 上限下一页 ≈80–150KB，
   * 一天 10 页 ≤1.5MB（用户定版：「手写内容对画质要求也不高」）。
   * 缩放是**就地**的（`PixelMap.scale`），缩放后的图同时用于 OCR —— 1440 对手写识别足够。
   */
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
      await this.shrinkToMaxSide(pixelMap);
      const packed: ArrayBuffer = await packer.packing(pixelMap, {
        format: 'image/jpeg',
        quality: ATTACHMENT_JPEG_QUALITY
      });
      return { pixelMap: pixelMap, bytes: new Uint8Array(packed) };
    } catch (error) {
      this.releasePixelMap(pixelMap);
      throw new Error(`编码 JPEG 失败：${describeError(error as object)}`);
    }
  }

  /** 最长边超过 `ATTACHMENT_MAX_SIDE` 时等比缩小（小于则不放大，避免糊字）。 */
  private async shrinkToMaxSide(pixelMap: image.PixelMap): Promise<void> {
    const info: image.ImageInfo = await pixelMap.getImageInfo();
    const width: number = info.size.width;
    const height: number = info.size.height;
    const longest: number = Math.max(width, height);
    if (!Number.isFinite(longest) || longest <= ATTACHMENT_MAX_SIDE) {
      return;
    }
    const ratio: number = ATTACHMENT_MAX_SIDE / longest;
    await pixelMap.scale(ratio, ratio);
    console.info(
      `[hw] jpeg shrink ${width}x${height} -> ${Math.round(width * ratio)}x${Math.round(height * ratio)}`
    );
  }

  /**
   * 同步落盘一页截图（attachmentStore 内部按 sha256 去重命名，返回时文件已可读）。
   * 顺带校验 store 计算出的 sha256 与阶段 A 计算值一致，避免附件名与内容错位。
   */
  private savePageAttachment(sha256: string, bytes: Uint8Array, pageIndex: number): void {
    // 落 **JPEG 源图**（`attachments-src/<sha>.jpg`）；仓库里只放按天 zip（见 attachmentStore.archiveDay）
    const attachment: Attachment = this.options.store.savePageJpeg(this.toArrayBuffer(bytes), pageIndex);
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
      tables: [],
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