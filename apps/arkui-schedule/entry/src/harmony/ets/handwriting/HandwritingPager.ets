/**
 * 分页手写板（**仅 HarmonyOS**）：Canvas 逐页书写 + 翻页 / 清空 / 页数上限。
 *
 * 契约：BRIEF §3.2「分页手写板：Canvas 分页（`setMaxPages` 限制）」。
 *
 * 设计要点：
 * - `HandwritingPagerState` 用 `@Observed` 承载页数 / 当前页 / 上限，父页面与 OCR 批处理
 *   都通过它翻页，避免「组件内部状态拿不到」的问题；
 * - 每页一个独立 `Canvas`（最多 10 个，`aboutToAppear` 预建上下文，翻页不会丢笔迹）；
 * - 非当前页用 `opacity(0)` 保持参与布局，但**不接收触摸**；OCR 截图前由页面把目标页
 *   切到当前页（`preparePage` 钩子），保证 `componentSnapshot.get` 拿到完整内容。
 *
 * ⚠ 本机无 HarmonyOS SDK：Canvas 笔迹、`componentSnapshot` 截图需真机核对。
 */

/** 手写板页数上限（BRIEF §3.2 `setMaxPages` 的限制值）。 */
export const MAX_HANDWRITING_PAGES: number = 10;

/** 每页截图组件的 id 前缀：`hw-page-0`、`hw-page-1` …（OCR 截图按 id 定位）。 */
export const HANDWRITING_PAGE_ID_PREFIX: string = 'hw-page-';

/** 手写板状态（@Observed：父页面与子组件共享同一份）。 */
@Observed
export class HandwritingPagerState {
  /** 当前总页数（1 起）。 */
  pages: number = 1;
  /** 当前页索引（0 起）。 */
  current: number = 0;
  /** 页数上限。 */
  maxPages: number = MAX_HANDWRITING_PAGES;

  /** 设置页数上限（1..10，越界自动夹紧；超出后裁剪多余页）。 */
  setMaxPages(max: number): void {
    const requested = Number.isFinite(max) ? Math.floor(max) : MAX_HANDWRITING_PAGES;
    this.maxPages = requested < 1 ? 1 : (requested > MAX_HANDWRITING_PAGES ? MAX_HANDWRITING_PAGES : requested);
    if (this.pages > this.maxPages) {
      this.pages = this.maxPages;
    }
    if (this.current >= this.pages) {
      this.current = this.pages - 1;
    }
  }

  /** 新增一页；已达上限返回 false。 */
  addPage(): boolean {
    if (this.pages >= this.maxPages) {
      return false;
    }
    this.pages += 1;
    this.current = this.pages - 1;
    return true;
  }

  /** 上一页；已在首页返回 false。 */
  prevPage(): boolean {
    if (this.current <= 0) {
      return false;
    }
    this.current -= 1;
    return true;
  }

  /** 下一页；已在末页返回 false。 */
  nextPage(): boolean {
    if (this.current >= this.pages - 1) {
      return false;
    }
    this.current += 1;
    return true;
  }

  /** 页索引数组（供 ForEach 使用）。 */
  pageIndexes(): number[] {
    const list: number[] = [];
    for (let i = 0; i < this.pages; i++) {
      list.push(i);
    }
    return list;
  }
}

@Component
@crossplatform
export struct HandwritingPager {
  /** 与父页面共享的分页状态。 */
  @ObjectLink state: HandwritingPagerState;
  /** 页数上限（与 state.setMaxPages 联动）。 */
  maxPages: number = MAX_HANDWRITING_PAGES;
  /** 翻页/增页后通知父页面（父页面用它拼截图 id 列表）。 */
  onStateChange: (pages: number, current: number) => void = () => {};

  private settings: RenderingContextSettings = new RenderingContextSettings(true);
  private contexts: CanvasRenderingContext2D[] = [];
  /** 正在书写的页（-1 表示未落笔）。 */
  private drawingPage: number = -1;

  aboutToAppear(): void {
    for (let i = 0; i < MAX_HANDWRITING_PAGES; i++) {
      this.contexts.push(new CanvasRenderingContext2D(this.settings));
    }
    this.state.setMaxPages(this.maxPages);
    this.notifyParent();
  }

  /** 清空某一页（默认当前页）。 */
  clearPage(index: number): void {
    if (index < 0 || index >= this.contexts.length) {
      return;
    }
    const context = this.contexts[index];
    context.clearRect(0, 0, context.width, context.height);
  }

  private notifyParent(): void {
    this.onStateChange(this.state.pages, this.state.current);
  }

  private initContext(index: number): void {
    const context = this.contexts[index];
    context.lineWidth = 3;
    context.strokeStyle = '#182431';
    context.lineCap = 'round';
    context.lineJoin = 'round';
  }

  private handleTouch(index: number, event: TouchEvent): void {
    if (index !== this.state.current) {
      return;
    }
    const touches = event.touches;
    if (touches === undefined || touches.length === 0) {
      return;
    }
    const context = this.contexts[index];
    const x = touches[0].x;
    const y = touches[0].y;
    if (event.type === TouchType.Down) {
      this.drawingPage = index;
      context.beginPath();
      context.moveTo(x, y);
    } else if (event.type === TouchType.Move) {
      if (this.drawingPage !== index) {
        return;
      }
      context.lineTo(x, y);
      context.stroke();
    } else if (event.type === TouchType.Up || event.type === TouchType.Cancel) {
      this.drawingPage = -1;
    }
  }

  build() {
    Column({ space: 8 }) {
      Stack() {
        ForEach(
          this.state.pageIndexes(),
          (index: number) => {
            Canvas(this.contexts[index])
              .id(`${HANDWRITING_PAGE_ID_PREFIX}${index}`)
              .width('100%')
              .height('100%')
              .backgroundColor(Color.White)
              .opacity(index === this.state.current ? 1 : 0)
              .hitTestBehavior(index === this.state.current ? HitTestMode.Default : HitTestMode.None)
              .onReady(() => {
                this.initContext(index);
              })
              .onTouch((event: TouchEvent) => {
                this.handleTouch(index, event);
              })
          },
          (index: number) => `page-${index}`
        )
      }
      .width('100%')
      .layoutWeight(1)
      .backgroundColor(Color.White)
      .borderRadius(12)
      .clip(true)

      Row({ space: 8 }) {
        Button('上一页')
          .height(34)
          .fontSize(13)
          .backgroundColor('#E8F1FF')
          .fontColor($r('app.color.brand'))
          .enabled(this.state.current > 0)
          .onClick(() => {
            if (this.state.prevPage()) {
              this.notifyParent();
            }
          })
        Text(`${this.state.current + 1} / ${this.state.pages}`)
          .fontSize(13)
          .fontColor($r('app.color.text_primary'))
          .layoutWeight(1)
          .textAlign(TextAlign.Center)
        Button('下一页')
          .height(34)
          .fontSize(13)
          .backgroundColor('#E8F1FF')
          .fontColor($r('app.color.brand'))
          .enabled(this.state.current < this.state.pages - 1)
          .onClick(() => {
            if (this.state.nextPage()) {
              this.notifyParent();
            }
          })
      }
      .width('100%')

      Row({ space: 8 }) {
        Button('新增页')
          .layoutWeight(1)
          .height(34)
          .fontSize(13)
          .backgroundColor('#E8F1FF')
          .fontColor($r('app.color.brand'))
          .enabled(this.state.pages < this.state.maxPages)
          .onClick(() => {
            if (this.state.addPage()) {
              this.notifyParent();
            }
          })
        Button('清空本页')
          .layoutWeight(1)
          .height(34)
          .fontSize(13)
          .backgroundColor('#F3F4F6')
          .fontColor($r('app.color.text_primary'))
          .onClick(() => {
            this.clearPage(this.state.current);
          })
      }
      .width('100%')
    }
    .width('100%')
    .height('100%')
  }
}
