/**
 * 手写板页面（**仅 HarmonyOS**，只在鸿蒙清单 `entry/src/harmony/resources/base/profile/main_pages.json` 登记）。
 *
 * 契约：BRIEF §3.2、`docs/CONTRACT.md` §3.4 + 「区域框内不做 OCR，只保存原图」。
 *
 * 流程：逐页书写（画笔 / 橡皮 / 框选三模式，笔宽 5 档、颜色 5 色、撤销重做按页）→
 * **全部写完**后点「完成（统一识别）」→ OcrBatchManager 两阶段处理：
 *   阶段 A：按页序逐页「切页 → 截图 → 落盘 attachments/<sha256>.png」（**原始截图**，含框内内容）；
 *   阶段 B：有框的页先把框内填白 → 二次截图 → 只对遮罩图 OCR；正文对应位置插入区域占位符；
 * 最后 0→N 拼接到 `AppStorage['handwriting.result']` 并 `router.back()`。
 *
 * 关键约束（用户需求基准）：
 * - **只有一个「完成」入口触发整批**，不存在「翻页即识别 / 单页即识别」的路径；
 * - 框内内容不做 OCR，但仍保存原始截图；框外的文字才送识别；
 * - 回传的三个键（编辑页 `onPageShow` 读取后立即清空）保持不变：
 *   `handwriting.result`（正文）、`handwriting.ocrText`（OCR 原文）、
 *   `handwriting.attachments`（`Attachment[]` 的 JSON）。
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
import type { RegionBox } from '../model/types';

@Entry
@Component
struct Handwriting {
  /** 与手写板组件共享的分页状态（父页面用它拼截图 id、显示页码与框数）。 */
  @State pagerState: HandwritingPagerState = new HandwritingPagerState();
  @State pageCount: number = 1;
  @State currentPage: number = 0;
  /** 当前页笔迹数 / 框数 / 撤销深度（子组件回调刷新）。 */
  @State strokeCount: number = 0;
  @State regionCount: number = 0;
  @State undoDepth: number = 0;
  /** 当前笔刷中文名与粗细（状态行展示，全局设置）。 */
  @State brushLabel: string = '钢笔';
  @State penWidth: number = 3.5;
  @State busy: boolean = false;
  @State progressText: string =
    '提示：全部写完再点完成；框选区域框内不做 OCR、只保存原图，完成后统一识别其余文字。';
  private manager: OcrBatchManager | null = null;

  aboutToDisappear(): void {
    // 页面销毁时取消在跑的批次，释放所有未处理的 PixelMap
    if (this.manager !== null) {
      this.manager.cancel();
      this.manager = null;
    }
  }

  /**
   * 截图前把目标页切到前台并等一帧（只有当前页完全可见，截图才完整）。
   * 必须走 `jumpTo`：直接改 `current` 会让 PageBook 账本与 UI 不同步。
   * 这一帧同时覆盖「区域填白后画布重绘」，保证二次截图拿到填白后的画面。
   */
  private async preparePage(pageIndex: number): Promise<void> {
    if (this.pagerState.current !== pageIndex) {
      this.pagerState.jumpTo(pageIndex);
    }
    this.currentPage = pageIndex;
    this.pageCount = this.pagerState.pages;
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
    // 按页序取槽位 id（删除中间页后页序 ≠ 0..N，必须用 slots 映射）
    const ids: string[] = this.pagerState.snapshotIds(HANDWRITING_PAGE_ID_PREFIX);
    const pageRegions: RegionBox[][] = this.pagerState.regionsList();
    let regionTotal: number = 0;
    for (let index = 0; index < pageRegions.length; index++) {
      regionTotal += pageRegions[index].length;
    }
    const manager = new OcrBatchManager({
      snapshotIds: ids,
      pageRegions: pageRegions,
      store: attachmentStore,
      preparePage: (pageIndex: number) => this.preparePage(pageIndex),
      // 区域填白由子组件实现（pager 持有画布上下文），这里只转调注册好的实现
      maskPage: (pageIndex: number, regions: RegionBox[]) => this.pagerState.maskPage(pageIndex, regions)
    });
    this.manager = manager;
    this.busy = true;
    this.progressText = `共 ${ids.length} 页（${regionTotal} 个框）：先逐页保存原图，再对框内填白、统一识别…`;
    try {
      const result = await manager.run((done: number, total: number) => {
        this.progressText = `已处理 ${done} / ${total} 页（原图已保存）`;
      });
      if (result.cancelled) {
        this.progressText = '已取消识别：未处理的截图已释放，已落盘的附件保留在设备目录中。';
        return;
      }
      AppStorage.setOrCreate<string>('handwriting.result', result.text);
      AppStorage.setOrCreate<string>('handwriting.ocrText', result.rawText);
      AppStorage.setOrCreate<string>('handwriting.attachments', JSON.stringify(result.attachments));
      promptAction.showToast({
        message:
          `识别完成：${result.attachments.length} 页、${result.regionCount} 个框` +
          '（框内未识别，原始截图已保存）',
        duration: 3000
      });
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
          Text(
            `画布 ${this.pageCount} 页（上限 ${MAX_HANDWRITING_PAGES}）· 第 ${this.currentPage + 1} 页` +
              ` · 笔刷：${this.brushLabel} · 粗细 ${this.penWidth}`
          )
            .fontSize(11)
            .fontColor($r('app.color.text_secondary'))
          Text(
            `本页 ${this.strokeCount} 笔 · 框 ${this.regionCount} 个 · 撤销深度 ${this.undoDepth} 步` +
              ' · 框内不做 OCR（只保存原图）'
          )
            .fontSize(11)
            .fontColor('#B26A00')
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
        },
        onStatsChange: (strokes: number, regions: number, undoSteps: number, brush: string, width: number) => {
          this.strokeCount = strokes;
          this.regionCount = regions;
          this.undoDepth = undoSteps;
          this.brushLabel = brush;
          this.penWidth = width;
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
        Button(this.busy ? '识别中…' : '完成（统一识别）')
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
