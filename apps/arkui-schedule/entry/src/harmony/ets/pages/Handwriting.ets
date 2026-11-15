/**
 * 手写板页面（**仅 HarmonyOS**，只在鸿蒙清单 `entry/src/harmony/resources/base/profile/main_pages.json` 登记）。
 *
 * 契约：BRIEF §3.2、`docs/CONTRACT.md` §3.4 + 「区域框内不做 OCR，只保存原图」。
 *
 * 流程：逐页书写（画笔 / 橡皮 / 框选，笔宽 5 档、颜色 5 色、撤销重做按页）→
 * **全部写完**后点「完成」→ OcrBatchManager 两阶段处理：
 *   阶段 A：按页序逐页「切页 → 截图 → 落盘 attachments/<sha256>.png」（**原始截图**，含框内内容）；
 *   阶段 B：有框的页先把框内填白 → 二次截图 → 只对遮罩图 OCR；正文对应位置插入区域占位符；
 * 最后 0→N 拼接到 `AppStorage['handwriting.result']` 并 `router.back()`。
 *
 * 2026-11-15 UI 定版（用户拍板）：
 * - **竖屏**：顶部单行工具条（高度 48vp）
 *   `[笔▾][粗▾][色▾][工具▾][撤销][重做][‹ n/m › +][完成]`；
 * - **横屏**：最左侧竖排 rail（宽度 56vp），同序竖排，「完成」贴底；
 * - 带 ▾ 的按钮点开**二级浮层**（绝对定位在根 Stack 上，不参与布局、**不挤压画布**，也不遮挡画布中心）；
 * - 「完成」是唯一主操作且**始终可见**（不随工具条横向滚动）；
 * - 页码与加页合并成 `‹ n/m › +` 一个组件；长按它 = 页面菜单（清空本页 / 清空本页框 / 删除本页 / 返回）；
 * - 页面上**没有任何常驻提示文案**：识别进度只走 toast，失败也只 toast；
 * - 首次进入弹一次引导（`preferences` 的 `handwriting.tipShown`），点「知道了」写入标记，不加设置项。
 *
 * 布局不用 `if/else` 切横竖屏（那会重建 `HandwritingPager`，画布已画的像素会丢）：
 * rail 宽度、顶部条高度都随 `landscape` 变化，组件树结构保持恒定。
 */
import { promptAction, router } from '@kit.ArkUI';
import { common } from '@kit.AbilityKit';
import { preferences } from '@kit.ArkData';
import {
  HANDWRITING_PAGE_ID_PREFIX,
  HandwritingPager,
  HandwritingPagerState,
  HW_TOOL_BRUSH,
  HW_TOOL_ERASER,
  HW_TOOL_SELECT,
  MAX_HANDWRITING_PAGES
} from '../handwriting/HandwritingPager';
import { OcrBatchManager } from '../ocr/OcrBatchManager';
import { attachmentStore } from '../services/attachmentStore';
import { describeError } from '../services/scheduleStore';
import { BRUSHES, brushSpec } from '../model/brush';
import type { BrushKind, BrushSpec } from '../model/brush';
import { PEN_WIDTHS, PEN_COLORS } from '../model/strokeHistory';
import { FONT, LINE_HEIGHT, RADIUS, SPACING, TOUCH_MIN, isLandscapeSize } from '../common/uiTokens';
import type { RegionBox } from '../model/types';

/** 竖屏顶部工具条高度（vp）——定版要求 ≤48vp。 */
const TOP_BAR_HEIGHT: number = 48;
/** 横屏左侧 rail 宽度（vp）——定版要求 ≤56vp。 */
const RAIL_WIDTH: number = 56;
/** 工具条按钮边长（vp）：取 `TOUCH_MIN`，满足最小触控目标。 */
const BAR_BUTTON: number = TOUCH_MIN;
/** 粗细档的视觉直径（只是示意，不等于线宽）。 */
const PEN_DOT_SIZES: number[] = [6, 8, 10, 13, 16];
/** 二级面板文案。 */
const PANEL_BRUSH: string = 'brush';
const PANEL_SIZE: string = 'size';
const PANEL_COLOR: string = 'color';
const PANEL_TOOL: string = 'tool';
/** 首次引导存储（不建设置项，只存一个布尔标记）。 */
const TIP_STORE: string = 'handwriting';
const TIP_KEY: string = 'handwriting.tipShown';

@Entry
@Component
struct Handwriting {
  /**
   * 与手写板组件共享的分页/书写状态（工具条直接改 `state` 里的 brush/penWidth/penColor/tool，
   * 画布读同一份；撤销/重做/清空由画布组件注册的实现转调）。
   */
  @State pagerState: HandwritingPagerState = new HandwritingPagerState();
  @State pageCount: number = 1;
  @State currentPage: number = 0;
  @State undoSteps: number = 0;
  @State redoAvailable: boolean = false;
  /** 当前展开的二级面板（'' = 全关）。 */
  @State panel: string = '';
  /** 页面菜单（长按页码组件）。 */
  @State pageMenuOpen: boolean = false;
  /** 是否横屏（由 `onAreaChange` 的宽高比较得出，不依赖 mediaquery）。 */
  @State landscape: boolean = false;
  /** 页面尺寸（vp）：浮层定位用。 */
  @State pageW: number = 0;
  @State pageH: number = 0;
  /** 首次引导是否可见。 */
  @State tipVisible: boolean = false;
  @State busy: boolean = false;
  private manager: OcrBatchManager | null = null;
  /** 本次识别是否已提示（避免重复 toast）。 */
  private tipLoaded: boolean = false;

  aboutToAppear(): void {
    this.loadTipFlag();
  }

  aboutToDisappear(): void {
    // 页面销毁时取消在跑的批次，释放所有未处理的 PixelMap
    if (this.manager !== null) {
      this.manager.cancel();
      this.manager = null;
    }
  }

  // ------------------------------------------------------------------ 首次引导

  /** 读 `handwriting.tipShown`：读不到/出错都**不弹**（宁可少弹，也不要每次进来都骚扰）。 */
  private async loadTipFlag(): Promise<void> {
    if (this.tipLoaded) {
      return;
    }
    this.tipLoaded = true;
    try {
      const context: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
      const prefs: preferences.Preferences = await preferences.getPreferences(context, { name: TIP_STORE });
      const shown: preferences.ValueType = await prefs.get(TIP_KEY, false);
      if (shown !== true) {
        this.tipVisible = true;
      }
    } catch {
      // 读不到偏好：视为已看过（不弹），保证不会「每次进来都弹」
    }
  }

  /** 点「知道了」：写标记并关掉引导（写失败也关，下次最多再弹一次）。 */
  private markTipShown(): void {
    this.tipVisible = false;
    try {
      const context: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
      preferences
        .getPreferences(context, { name: TIP_STORE })
        .then((prefs: preferences.Preferences) => {
          prefs
            .put(TIP_KEY, true)
            .then(() => {
              prefs.flush();
            })
            .catch(() => {});
        })
        .catch(() => {});
    } catch {
      // 忽略：不因为写偏好失败而卡住用户
    }
  }

  // ------------------------------------------------------------------ 工具条动作

  /** 开/关二级面板（同一个按钮再点一次收起）。 */
  private togglePanel(name: string): void {
    this.pageMenuOpen = false;
    this.panel = this.panel === name ? '' : name;
  }

  private closeOverlays(): void {
    this.panel = '';
    this.pageMenuOpen = false;
  }

  private pickBrush(kind: BrushKind): void {
    this.pagerState.setBrush(kind);
    this.panel = '';
  }

  private pickWidth(width: number): void {
    this.pagerState.setPenWidth(width);
    this.panel = '';
  }

  private pickColor(color: string): void {
    this.pagerState.setPenColor(color);
    this.panel = '';
  }

  private pickTool(tool: string): void {
    this.pagerState.setTool(tool);
    this.panel = '';
  }

  /** 当前工具的显示名（工具条按钮文案）。 */
  private currentToolLabel(): string {
    if (this.pagerState.tool === HW_TOOL_ERASER) {
      return '橡皮';
    }
    if (this.pagerState.tool === HW_TOOL_SELECT) {
      return '手动框';
    }
    return '画笔';
  }

  /** 当前笔形显示名（没选笔形时显示「笔」）。 */
  private currentBrushLabel(): string {
    if (this.pagerState.tool !== HW_TOOL_BRUSH) {
      return '笔';
    }
    return brushSpec(this.pagerState.brush).label.substring(0, 1);
  }

  // ------------------------------------------------------------------ 页序动作

  private syncHistoryState(): void {
    const current: number = this.pagerState.current;
    this.undoSteps = this.pagerState.history.undoDepth(current);
    this.redoAvailable = this.pagerState.history.canRedo(current);
  }

  private goPrevPage(): void {
    if (this.pagerState.prev()) {
      this.syncHistoryState();
    }
  }

  private goNextPage(): void {
    if (this.pagerState.next()) {
      this.syncHistoryState();
    }
  }

  private addPage(): void {
    if (this.pagerState.addPage()) {
      this.syncHistoryState();
    }
  }

  private removePage(): void {
    if (this.pagerState.removePage(this.pagerState.current)) {
      this.syncHistoryState();
    }
    this.pageMenuOpen = false;
  }

  private clearPage(): void {
    this.pagerState.clearPage(this.pagerState.current);
    this.syncHistoryState();
    this.pageMenuOpen = false;
  }

  private clearRegions(): void {
    this.pagerState.setRegions(this.pagerState.current, []);
    this.pageMenuOpen = false;
  }

  // ------------------------------------------------------------------ 完成（统一识别）

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
    this.closeOverlays();
    try {
      await attachmentStore.ensureReady(getContext(this) as common.UIAbilityContext);
    } catch (error) {
      promptAction.showToast({ message: `附件存储初始化失败：${describeError(error)}`, duration: 5000 });
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
    promptAction.showToast({ message: `正在保存 ${ids.length} 页原图并识别…`, duration: 2000 });
    try {
      const result = await manager.run();
      if (result.cancelled) {
        promptAction.showToast({ message: '已取消识别：已落盘的附件保留在设备目录中', duration: 3000 });
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
      promptAction.showToast({ message: `识别失败：${describeError(error)}`, duration: 5000 });
    } finally {
      this.busy = false;
      this.manager = null;
    }
  }

  // ------------------------------------------------------------------ 工具条（竖屏横排 / 横屏竖排共用一套按钮）

  /** 带 ▾ 的菜单按钮。 */
  @Builder
  menuButton(label: string, panelName: string) {
    Text(`${label}▾`)
      .height(BAR_BUTTON)
      .width(BAR_BUTTON)
      .fontSize(FONT.caption)
      .lineHeight(LINE_HEIGHT.caption)
      .textAlign(TextAlign.Center)
      .borderRadius(RADIUS.sm)
      .backgroundColor(this.panel === panelName ? $r('app.color.brand') : '#F1F3F5')
      .fontColor(this.panel === panelName ? Color.White : $r('app.color.text_primary'))
      .onClick(() => {
        this.togglePanel(panelName);
      })
  }

  /**
   * 撤销 / 重做（图标按钮：不用文字，省出竖屏宽度）。
   *
   * 不把回调传进 `@Builder`（ArkUI 的 Builder 参数只适合值类型），改用 `kind` 字符串分发。
   */
  @Builder
  historyButton(kind: string, label: string, enabled: boolean) {
    Text(label)
      .height(BAR_BUTTON)
      .width(BAR_BUTTON)
      .fontSize(FONT.body)
      .textAlign(TextAlign.Center)
      .borderRadius(RADIUS.sm)
      .backgroundColor('#EEF1F4')
      .fontColor($r('app.color.text_primary'))
      .enabled(enabled)
      .opacity(enabled ? 1 : 0.35)
      .onClick(() => {
        if (!enabled) {
          return;
        }
        if (kind === 'undo') {
          this.pagerState.applyUndo();
        } else {
          this.pagerState.applyRedo();
        }
      })
  }

  /** 页码 + 加页：`‹ n/m › +`（长按 = 页面菜单）。 */
  @Builder
  pageStepper() {
    Row() {
      Text('‹')
        .width(this.landscape ? BAR_BUTTON : 22)
        .height(BAR_BUTTON)
        .fontSize(FONT.body)
        .textAlign(TextAlign.Center)
        .fontColor($r('app.color.brand'))
        .opacity(this.currentPage > 0 ? 1 : 0.35)
        .enabled(this.currentPage > 0)
        .onClick(() => {
          this.goPrevPage();
        })
      Text(`${this.currentPage + 1}/${this.pageCount}`)
        .height(BAR_BUTTON)
        .width(this.landscape ? BAR_BUTTON : 36)
        .fontSize(FONT.caption)
        .textAlign(TextAlign.Center)
        .fontColor($r('app.color.text_primary'))
        .onClick(() => {
          this.pageMenuOpen = !this.pageMenuOpen;
          this.panel = '';
        })
        .gesture(
          LongPressGesture()
            .onAction(() => {
              this.pageMenuOpen = true;
              this.panel = '';
            })
        )
      Text('›')
        .width(this.landscape ? BAR_BUTTON : 22)
        .height(BAR_BUTTON)
        .fontSize(FONT.body)
        .textAlign(TextAlign.Center)
        .fontColor($r('app.color.brand'))
        .opacity(this.currentPage < this.pageCount - 1 ? 1 : 0.35)
        .enabled(this.currentPage < this.pageCount - 1)
        .onClick(() => {
          this.goNextPage();
        })
      Text('＋')
        .width(this.landscape ? BAR_BUTTON : 26)
        .height(BAR_BUTTON)
        .fontSize(FONT.body)
        .textAlign(TextAlign.Center)
        .fontColor($r('app.color.brand'))
        .opacity(this.pageCount < MAX_HANDWRITING_PAGES ? 1 : 0.35)
        .enabled(this.pageCount < MAX_HANDWRITING_PAGES)
        .onClick(() => {
          this.addPage();
        })
    }
    .height(BAR_BUTTON)
    .borderRadius(RADIUS.sm)
  }

  /** 「完成」：唯一主操作，横竖屏都常驻（竖屏不参与横向滚动、横屏贴 rail 底部）。 */
  @Builder
  finishButton(fullWidth: boolean) {
    Button(this.busy ? '识别中' : '完成')
      .height(BAR_BUTTON)
      .width(fullWidth ? RAIL_WIDTH - SPACING.sm : 56)
      .fontSize(FONT.caption)
      .backgroundColor($r('app.color.brand'))
      .fontColor(Color.White)
      .enabled(!this.busy)
      .onClick(() => {
        this.finish();
      })
  }

  /** 竖屏：顶部单行工具条（48vp）。 */
  @Builder
  topBar() {
    Row({ space: SPACING.xs }) {
      Scroll() {
        Row({ space: SPACING.xs }) {
          this.menuButton(this.currentBrushLabel(), PANEL_BRUSH)
          this.menuButton('粗', PANEL_SIZE)
          this.menuButton('色', PANEL_COLOR)
          this.menuButton('工具', PANEL_TOOL)
          this.historyButton('undo', '↶', this.undoSteps > 0)
          this.historyButton('redo', '↷', this.redoAvailable)
          this.pageStepper()
        }
      }
      .scrollable(ScrollDirection.Horizontal)
      .scrollBar(BarState.Off)
      .layoutWeight(1)
      .height(BAR_BUTTON)
      .align(Alignment.Start)

      this.finishButton(false)
    }
    .width('100%')
    .height(TOP_BAR_HEIGHT)
    .padding({ left: SPACING.sm, right: SPACING.sm })
    .backgroundColor($r('app.color.page_background'))
    .alignItems(VerticalAlign.Center)
  }

  /** 横屏：最左侧竖排 rail（56vp），「完成」贴底。 */
  @Builder
  railBar() {
    Column({ space: SPACING.xs }) {
      this.menuButton(this.currentBrushLabel(), PANEL_BRUSH)
      this.menuButton('粗', PANEL_SIZE)
      this.menuButton('色', PANEL_COLOR)
      this.menuButton('具', PANEL_TOOL)
      this.historyButton('undo', '↶', this.undoSteps > 0)
      this.historyButton('redo', '↷', this.redoAvailable)
      this.pageStepper()
      Blank()
      this.finishButton(true)
    }
    .width(RAIL_WIDTH)
    .height('100%')
    .padding({ top: SPACING.sm, bottom: SPACING.sm })
    .backgroundColor($r('app.color.page_background'))
    .alignItems(HorizontalAlign.Center)
  }

  // ------------------------------------------------------------------ 二级浮层（绝对定位，不挤压画布）

  /** 面板锚点：竖屏在工具条下方、横屏在 rail 右侧（都不碰画布中心）。 */
  private panelLeft(): number {
    return this.landscape ? RAIL_WIDTH + SPACING.sm : SPACING.sm;
  }

  private panelTop(): number {
    if (this.landscape) {
      // rail 里第 1~4 个按钮对应笔形/粗细/颜色/工具
      const index: number = this.panel === PANEL_BRUSH
        ? 0
        : (this.panel === PANEL_SIZE ? 1 : (this.panel === PANEL_COLOR ? 2 : 3));
      return SPACING.sm + index * (BAR_BUTTON + SPACING.xs);
    }
    return TOP_BAR_HEIGHT + SPACING.xs;
  }

  /** 二级面板内容（笔形 / 粗细 / 颜色 / 工具）。 */
  @Builder
  overlayPanel() {
    Column() {
      if (this.panel === PANEL_BRUSH) {
        Row({ space: SPACING.xs }) {
          ForEach(
            BRUSHES,
            (spec: BrushSpec) => {
              Text(spec.label)
                .height(BAR_BUTTON - 8)
                .padding({ left: SPACING.sm, right: SPACING.sm })
                .fontSize(FONT.caption)
                .textAlign(TextAlign.Center)
                .borderRadius(RADIUS.sm)
                .backgroundColor(
                  this.pagerState.brush === spec.kind && this.pagerState.tool === HW_TOOL_BRUSH
                    ? $r('app.color.brand')
                    : '#F1F3F5'
                )
                .fontColor(
                  this.pagerState.brush === spec.kind && this.pagerState.tool === HW_TOOL_BRUSH
                    ? Color.White
                    : $r('app.color.text_primary')
                )
                .onClick(() => {
                  this.pickBrush(spec.kind);
                })
            },
            (spec: BrushSpec) => `panel-brush-${spec.kind}`
          )
        }
      } else if (this.panel === PANEL_SIZE) {
        Row({ space: SPACING.xs }) {
          ForEach(
            PEN_WIDTHS,
            (width: number, index: number) => {
              Text('')
                .width(PEN_DOT_SIZES[index] + 14)
                .height(BAR_BUTTON - 8)
                .fontSize(FONT.caption)
                .borderRadius(RADIUS.sm)
                .border({
                  width: this.pagerState.penWidth === width ? 2 : 0,
                  color: $r('app.color.brand')
                })
                .backgroundColor('#F7F8FA')
                .onClick(() => {
                  this.pickWidth(width);
                })
            },
            (width: number) => `panel-size-${width}`
          )
        }
      } else if (this.panel === PANEL_COLOR) {
        Row({ space: SPACING.xs }) {
          ForEach(
            PEN_COLORS,
            (color: string) => {
              Text('')
                .width(BAR_BUTTON - 12)
                .height(BAR_BUTTON - 12)
                .borderRadius(RADIUS.sm)
                .backgroundColor(color)
                .border({ width: this.pagerState.penColor === color ? 2 : 0, color: $r('app.color.brand') })
                .onClick(() => {
                  this.pickColor(color);
                })
            },
            (color: string) => `panel-color-${color}`
          )
        }
      } else {
        Row({ space: SPACING.xs }) {
          this.toolChip('橡皮', HW_TOOL_ERASER)
          this.toolChip('手动框', HW_TOOL_SELECT)
        }
      }
    }
    .padding(SPACING.xs)
    .borderRadius(RADIUS.md)
    .backgroundColor(Color.White)
    .shadow({ radius: 16, color: 'rgba(0,0,0,0.16)', offsetY: 4 })
    .position({ x: this.panelLeft(), y: this.panelTop() })
  }

  /** 工具面板里的选项（橡皮 / 手动框）。 */
  @Builder
  toolChip(label: string, tool: string) {
    Text(label)
      .height(BAR_BUTTON - 8)
      .padding({ left: SPACING.md, right: SPACING.md })
      .fontSize(FONT.caption)
      .textAlign(TextAlign.Center)
      .borderRadius(RADIUS.sm)
      .backgroundColor(this.pagerState.tool === tool ? $r('app.color.brand') : '#F1F3F5')
      .fontColor(this.pagerState.tool === tool ? Color.White : $r('app.color.text_primary'))
      .onClick(() => {
        this.pickTool(tool);
      })
  }

  /** 长按页码后的页面菜单（破坏性动作都收在这里，工具条保持定版结构）。 */
  @Builder
  pageMenu() {
    Column({ space: SPACING.xs }) {
      this.pageMenuItem('清空本页笔迹', 'clear')
      this.pageMenuItem('清空本页框', 'regions')
      this.pageMenuItem('删除本页', 'remove')
      this.pageMenuItem('返回（不保存）', 'back')
    }
    .padding(SPACING.xs)
    .borderRadius(RADIUS.md)
    .backgroundColor(Color.White)
    .shadow({ radius: 16, color: 'rgba(0,0,0,0.16)', offsetY: 4 })
    .position({ x: this.panelLeft(), y: this.panelTop() })
  }

  @Builder
  pageMenuItem(label: string, action: string) {
    Text(label)
      .height(BAR_BUTTON - 8)
      .padding({ left: SPACING.md, right: SPACING.md })
      .fontSize(FONT.caption)
      .fontColor($r('app.color.text_primary'))
      .onClick(() => {
        if (action === 'clear') {
          this.clearPage();
        } else if (action === 'regions') {
          this.clearRegions();
        } else if (action === 'remove') {
          this.removePage();
        } else {
          this.pageMenuOpen = false;
          router.back();
        }
      })
  }

  /** 透明遮罩：点空白处收起浮层（画布点击不会漏进去）。 */
  @Builder
  overlayScrim() {
    Column()
      .width('100%')
      .height('100%')
      .backgroundColor('rgba(0,0,0,0.08)')
      .onClick(() => {
        this.closeOverlays();
      })
  }

  // ------------------------------------------------------------------ 首次引导对话框（自绘遮罩，不占常驻空间）

  @Builder
  tipDialog() {
    Column() {
      Column({ space: SPACING.md }) {
        Text('手写板')
          .fontSize(FONT.title)
          .lineHeight(LINE_HEIGHT.title)
          .fontWeight(FontWeight.Bold)
          .fontColor($r('app.color.text_primary'))
        Text('全部写完后点「完成」，系统会把每页截图保存并统一识别；框选的内容只存原图、不做识别。')
          .fontSize(FONT.body)
          .lineHeight(LINE_HEIGHT.body)
          .fontColor($r('app.color.text_secondary'))
        Button('知道了')
          .width('100%')
          .height(TOUCH_MIN)
          .fontSize(FONT.body)
          .backgroundColor($r('app.color.brand'))
          .fontColor(Color.White)
          .onClick(() => {
            this.markTipShown();
          })
      }
      .width(Math.min(360, Math.max(240, this.pageW - 2 * SPACING.xl)))
      .padding(SPACING.lg)
      .borderRadius(RADIUS.md)
      .backgroundColor(Color.White)
      .alignItems(HorizontalAlign.Start)
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
    .backgroundColor('rgba(0,0,0,0.35)')
  }

  build() {
    Stack() {
      // 恒定组件树：rail 宽度 / 顶部条高度随方向变化（不重建画布）
      Row() {
        Column() {
          this.railBar()
        }
        .width(this.landscape ? RAIL_WIDTH : 0)
        .height('100%')
        .clip(true)

        Column() {
          Column() {
            this.topBar()
          }
          .height(this.landscape ? 0 : TOP_BAR_HEIGHT)
          .clip(true)

          HandwritingPager({
            state: this.pagerState,
            maxPages: MAX_HANDWRITING_PAGES,
            onStateChange: (pages: number, current: number) => {
              this.pageCount = pages;
              this.currentPage = current;
              this.syncHistoryState();
            },
            onStatsChange: (undoSteps: number, redoAvailable: boolean) => {
              this.undoSteps = undoSteps;
              this.redoAvailable = redoAvailable;
            }
          })
            .width('100%')
            .layoutWeight(1)
        }
        .layoutWeight(1)
        .height('100%')
      }
      .width('100%')
      .height('100%')

      // 浮层永远画在画布之上，但**不参与布局**（绝对定位），所以不挤压画布
      if (this.panel !== '' || this.pageMenuOpen) {
        this.overlayScrim()
        if (this.panel !== '') {
          this.overlayPanel()
        }
        if (this.pageMenuOpen) {
          this.pageMenu()
        }
      }

      if (this.tipVisible) {
        this.tipDialog()
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor($r('app.color.page_background'))
    .onAreaChange((_oldValue: Area, newValue: Area) => {
      const width: number = newValue.width as number;
      const height: number = newValue.height as number;
      this.pageW = width;
      this.pageH = height;
      this.landscape = isLandscapeSize(width, height);
    })
  }
}
