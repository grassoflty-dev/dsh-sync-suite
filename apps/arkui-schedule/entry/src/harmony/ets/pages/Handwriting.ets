/**
 * 手写板页面（**仅 HarmonyOS**，只在鸿蒙清单 `entry/src/harmony/resources/base/profile/main_pages.json` 登记）。
 *
 * 契约：BRIEF §3.2、`docs/CONTRACT.md` §3.4。
 * 流程：书写 → 「完成并识别」→ OcrBatchManager 逐页「切页 → 截图 → 落盘 attachments/<sha256>.png
 * → OCR → 释放 PixelMap」→ 0→N 拼接 → 写 `AppStorage['handwriting.result']` 后 `router.back()`。
 *
 * 回传的三个键（编辑页 `onPageShow` 读取后立即清空）：
 * - `handwriting.result`：占位符处理后的正文文本；
 * - `handwriting.ocrText`：OCR 原始文本（写入记录 `ocr_text`，永不覆盖）；
 * - `handwriting.attachments`：`Attachment[]` 的 JSON（写入记录 `attachments`）。
 */
import { promptAction, router } from '@kit.ArkUI';
import { common } from '@kit.AbilityKit';
import {
  HANDWRITING_PAGE_ID_PREFIX,
  HandwritingPager,
  HandwritingPagerState,
  MAX_HANDWRITING_PAGES
} from '../handwriting/HandwritingPager';
import { OcrBatchManager } from '../ocr/OcrBatchManager';
import { attachmentStore } from '../services/attachmentStore';
import { describeError } from '../services/scheduleStore';

@Entry
@Component
@crossplatform
struct Handwriting {
  /** 与手写板组件共享的分页状态（父页面用它拼截图 id、显示页码）。 */
  @State pagerState: HandwritingPagerState = new HandwritingPagerState();
  @State pageCount: number = 1;
  @State currentPage: number = 0;
  @State busy: boolean = false;
  @State progressText: string = '在白色画布上书写；点「完成并识别」会逐页保存截图，再串行 OCR。';
  private manager: OcrBatchManager | null = null;

  aboutToDisappear(): void {
    // 页面销毁时取消在跑的批次，释放所有未处理的 PixelMap
    if (this.manager !== null) {
      this.manager.cancel();
      this.manager = null;
    }
  }

  /** 截图前把目标页切到前台并等一帧（只有当前页完全可见，截图才完整）。 */
  private async preparePage(pageIndex: number): Promise<void> {
    if (this.pagerState.current !== pageIndex) {
      this.pagerState.current = pageIndex;
    }
    this.currentPage = pageIndex;
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 80);
    });
  }

  private async finish(): Promise<void> {
    if (this.busy) {
      return;
    }
    try {
      await attachmentStore.ensureReady(getContext(this) as common.UIAbilityContext);
    } catch (error) {
      this.progressText = `附件存储初始化失败：${describeError(error)}`;
      return;
    }
    const ids: string[] = [];
    for (let i = 0; i < this.pageCount; i++) {
      ids.push(`${HANDWRITING_PAGE_ID_PREFIX}${i}`);
    }
    const manager = new OcrBatchManager({
      snapshotIds: ids,
      store: attachmentStore,
      preparePage: (pageIndex: number) => this.preparePage(pageIndex)
    });
    this.manager = manager;
    this.busy = true;
    this.progressText = `共 ${this.pageCount} 页，开始逐页截图并识别…`;
    try {
      const result = await manager.run((done: number, total: number) => {
        this.progressText = `第 ${done} / ${total} 页已完成（截图已落盘，OCR 结果已记录）`;
      });
      if (result.cancelled) {
        this.progressText = '已取消识别：未处理的截图已释放，已落盘的附件保留在设备目录中。';
        return;
      }
      AppStorage.setOrCreate<string>('handwriting.result', result.text);
      AppStorage.setOrCreate<string>('handwriting.ocrText', result.rawText);
      AppStorage.setOrCreate<string>('handwriting.attachments', JSON.stringify(result.attachments));
      const note = result.rawText.length === 0 ? '（未识别到文字，截图已保存）' : '';
      promptAction.showToast({ message: `识别完成：${result.pageResults.length} 页${note}`, duration: 3000 });
      router.back();
    } catch (error) {
      this.progressText = `识别失败：${describeError(error)}`;
      promptAction.showToast({ message: this.progressText, duration: 5000 });
    } finally {
      this.busy = false;
      this.manager = null;
    }
  }

  private async onCancel(): Promise<void> {
    if (this.busy && this.manager !== null) {
      await this.manager.cancel();
      this.progressText = '正在取消：释放未处理的截图内存…';
      return;
    }
    router.back();
  }

  build() {
    Column() {
      Row({ space: 8 }) {
        Text('‹')
          .fontSize(26)
          .fontColor($r('app.color.text_primary'))
          .padding({ left: 4, right: 4 })
          .onClick(() => {
            router.back();
          })
        Column({ space: 1 }) {
          Text('手写板')
            .fontSize(18)
            .fontWeight(FontWeight.Bold)
            .fontColor($r('app.color.text_primary'))
          Text(`共 ${this.pageCount} 页（上限 ${MAX_HANDWRITING_PAGES} 页）· 当前第 ${this.currentPage + 1} 页`)
            .fontSize(11)
            .fontColor($r('app.color.text_secondary'))
        }
        .alignItems(HorizontalAlign.Start)
        .layoutWeight(1)
      }
      .width('100%')
      .padding({ left: 12, right: 12, top: 12, bottom: 8 })

      HandwritingPager({
        state: this.pagerState,
        maxPages: MAX_HANDWRITING_PAGES,
        onStateChange: (pages: number, current: number) => {
          this.pageCount = pages;
          this.currentPage = current;
        }
      })
        .layoutWeight(1)
        .margin({ left: 12, right: 12 })

      Text(this.progressText)
        .fontSize(12)
        .fontColor($r('app.color.text_secondary'))
        .width('100%')
        .padding({ left: 16, right: 16, top: 8 })
        .textAlign(TextAlign.Start)

      Row({ space: 10 }) {
        Button(this.busy ? '取消识别' : '取消')
          .layoutWeight(1)
          .height(44)
          .backgroundColor('#EEF1F4')
          .fontColor($r('app.color.text_primary'))
          .onClick(() => {
            this.onCancel();
          })
        Button(this.busy ? '识别中…' : '完成并识别')
          .layoutWeight(2)
          .height(44)
          .backgroundColor($r('app.color.brand'))
          .fontColor(Color.White)
          .enabled(!this.busy)
          .onClick(() => {
            this.finish();
          })
      }
      .width('100%')
      .padding({ left: 12, right: 12, top: 8, bottom: 12 })
    }
    .width('100%')
    .height('100%')
    .backgroundColor($r('app.color.page_background'))
  }
}
