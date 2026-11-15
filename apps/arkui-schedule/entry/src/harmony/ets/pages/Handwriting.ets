/**
 * 手写板页面（**仅 HarmonyOS**，只在鸿蒙清单 `entry/src/harmony/resources/base/profile/main_pages.json` 登记）。
 *
 * 契约：BRIEF §3.2、`docs/CONTRACT.md` §3.4 + 「区域框内不做 OCR，只保存原图」。
 *
 * 流程：逐页书写（画笔 / 橡皮 / 手动框，笔宽 5 档、颜色 5 色、撤销重做按页）→
 * **全部写完**后点「完成」→ OcrBatchManager 两阶段处理：
 *   阶段 A：按页序逐页「切页 → 截图 → 落盘 attachments/<sha256>.png」（**原始截图**，含框内内容）；
 *   阶段 B：有框的页先把框内填白 → 二次截图 → 只对遮罩图 OCR；正文对应位置插入区域占位符；
 * 最后 0→N 拼接到 `AppStorage['handwriting.result']` 并 `router.back()`。
 *
 * 2026-11-15 UI 定版（用户逐条确认）——**9 个位置**：
 * ```
 * 竖屏顶部横排： [笔形▾] [粗细▾] [颜色▾] [橡皮] [手动框] [撤销] [重做] [− n/m +] [完成]
 * 横屏左侧竖排： 同序自上而下（rail ≤56vp，「完成」贴底）
 * ```
 * 2026-11-15 真机缺陷修复（第二轮，Lead 定版）：
 * - 笔形/粗细/颜色按钮改成**图标 + ▾**（不再显示「钢」「粗」「色」单字，真机被截断）；
 * - 每个控件 `minWidth ≥44vp`、`height 40vp`、`flexShrink(0)`，`Text` 一律 `maxLines(1)` +
 *   `textOverflow(TextOverflow.None)`，**禁止省略号**；整行仍是横向 `Scroll`（溢出滚动、不加高）；
 * - 二级面板改成**竖向列表**：笔形「图标 + 名称 + ✓」、粗细「圆点 + 数值 + ✓」、颜色「色块 + 名称 + ✓」，
 *   行高 44vp（用户原话：粗细微菜单「5 个选项空白」= 旧实现只画了空 Text 没画圆点）；
 * - 禁用态**不再整体降透明度**（用户反馈「-」看不见）：只改文字/图标颜色，控件本体保持不透明；
 * - 「完成」实底品牌蓝 + 白字、`minWidth 64vp`、`flexShrink(0)`（真机被省略号截断）；
 * - 面板开合打 `[hw] panel open=...` 日志，便于 `hilog | grep '[hw]'` 自证（Popup 不一定进 `ui layout`）。
 *
 * 布局不用 `if/else` 切横竖屏（会重建 `HandwritingPager`，画布已画的像素会丢）：
 * rail 宽度、顶部条高度随 `landscape` 变化，组件树结构保持恒定。
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
/** 工具条控件高度（vp）。 */
const TOOL_HEIGHT: number = 40;
/** 工具条控件最小宽度（vp）——定版要求 ≥44vp（徽标 + ▾ 不再被挤没）。 */
const TOOL_MIN_WIDTH: number = 44;
/** 步进器 `−` / `+` 的边长（vp）。 */
const STEPPER_BTN: number = 40;
/** 步进器中间「当前/总数」宽度（vp）——定版要求 ≥56vp。 */
const STEPPER_LABEL_W: number = 56;
/** 「完成」最小宽度（vp）——定版要求 ≥64vp。 */
const FINISH_MIN_WIDTH: number = 64;
/** 二级面板每行高度（vp）。 */
const MENU_ROW_HEIGHT: number = 44;
/** 面板里粗细圆点的直径（与 `PEN_WIDTHS` 一一对应，定版 4/7/10/13/16）。 */
const SIZE_DOTS: number[] = [4, 7, 10, 13, 16];
/** 面板里颜色块的边长（vp）。 */
const SWATCH: number = 28;
/** 颜色名（与 `PEN_COLORS` 顺序一一对应）。 */
const COLOR_LABELS: string[] = ['黑', '红', '蓝', '绿', '橙'];
/** 二级面板标识。 */
const PANEL_BRUSH: string = 'brush';
const PANEL_SIZE: string = 'size';
const PANEL_COLOR: string = 'color';
/** 首次引导存储（不建设置项，只存一个布尔标记）。 */
const TIP_STORE: string = 'handwriting';
const TIP_KEY: string = 'handwriting.tipShown';
/** 两步删除确认的阶段。 */
const CONFIRM_NONE: number = 0;
const CONFIRM_FIRST: number = 1;
const CONFIRM_SECOND: number = 2;

@Entry
@Component
struct Handwriting {
  /**
   * 与手写板组件共享的分页/书写状态（工具条直接改 `state` 里的 brush/penWidth/penColor/tool，
   * 画布读同一份；撤销/重做由画布组件注册的实现转调）。
   */
  @State pagerState: HandwritingPagerState = new HandwritingPagerState();
  @State pageCount: number = 1;
  @State currentPage: number = 0;
  @State undoSteps: number = 0;
  @State redoAvailable: boolean = false;
  /** 当前展开的二级面板（'' = 全关）。 */
  @State panel: string = '';
  /** 删除确认阶段（0/1/2）。 */
  @State confirmStage: number = CONFIRM_NONE;
  /** 是否横屏（由 `onAreaChange` 的宽高比较得出，不依赖 mediaquery）。 */
  @State landscape: boolean = false;
  /** 页面尺寸（vp）：浮层定位用。 */
  @State pageW: number = 0;
  @State pageH: number = 0;
  /** 首次引导是否可见。 */
  @State tipVisible: boolean = false;
  @State busy: boolean = false;
  private manager: OcrBatchManager | null = null;
  private tipLoaded: boolean = false;

  aboutToAppear(): void {
    this.loadTipFlag();
  }

  aboutToDisappear(): void {
    if (this.manager !== null) {
      this.manager.cancel();
      this.manager = null;
    }
  }

  // ------------------------------------------------------------------ 首次引导（只弹一次）

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
      // 读不到偏好：视为已看过（不弹）
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

  private togglePanel(name: string): void {
    this.confirmStage = CONFIRM_NONE;
    const next: string = this.panel === name ? '' : name;
    this.panel = next;
    // 真机自证：Popup/自定义浮层不一定出现在 `ui layout` 里，用 hilog 记开合
    console.info(`[hw] panel open=${next.length === 0 ? 'none' : next}`);
  }

  private closeOverlays(): void {
    if (this.panel.length > 0) {
      console.info('[hw] panel open=none');
    }
    this.panel = '';
    this.confirmStage = CONFIRM_NONE;
  }

  private pickBrush(kind: BrushKind): void {
    this.pagerState.setBrush(kind);
    this.panel = '';
    console.info(`[hw] panel open=none brush=${kind}`);
  }

  private pickWidth(width: number): void {
    this.pagerState.setPenWidth(width);
    this.panel = '';
    console.info(`[hw] panel open=none penWidth=${width}`);
  }

  private pickColor(color: string): void {
    this.pagerState.setPenColor(color);
    this.panel = '';
    console.info(`[hw] panel open=none penColor=${color}`);
  }

  /** 橡皮 / 手动框：点一下进该模式，**再点一次回到画笔**（定版语义），与画笔互斥。 */
  private toggleTool(tool: string): void {
    this.panel = '';
    this.confirmStage = CONFIRM_NONE;
    const next: string = this.pagerState.tool === tool ? HW_TOOL_BRUSH : tool;
    this.pagerState.setTool(next);
    console.info(`[hw] tool=${next}`);
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

  /** `+`：在当前页之后插入空白页（自动跳到新页）。 */
  private insertPage(): void {
    if (this.pagerState.insertPageAfterCurrent()) {
      this.syncHistoryState();
      console.info(`[hw] page insert after, now=${this.pagerState.current + 1}/${this.pagerState.pages}`);
    }
  }

  /** `−`：删除当前页（两步确认）。 */
  private startDeletePage(): void {
    if (this.pageCount <= 1) {
      return;
    }
    this.closeOverlays();
    this.confirmStage = CONFIRM_FIRST;
    console.info(`[hw] delete confirm stage=1 page=${this.currentPage + 1}/${this.pageCount}`);
  }

  private confirmDelete(): void {
    if (this.confirmStage === CONFIRM_FIRST) {
      this.confirmStage = CONFIRM_SECOND;
      console.info('[hw] delete confirm stage=2');
      return;
    }
    if (this.confirmStage === CONFIRM_SECOND) {
      this.confirmStage = CONFIRM_NONE;
      const pageNo: number = this.pagerState.current + 1;
      if (this.pagerState.removePage(this.pagerState.current)) {
        this.syncHistoryState();
        console.info(`[hw] page deleted ${pageNo}, pages=${this.pagerState.pages}`);
      }
    }
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
    // 按页序取截图 id（稳定页 id：插页/删页后 id 不漂移）
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

  // ------------------------------------------------------------------ 图标（自绘几何，不依赖 sys.symbol 名字）

  /** 笔形的图标粗细（vp，按笔刷类型区分）。 */
  private brushIconWidth(kind: string): number {
    if (kind === 'ballpoint') {
      return 2;
    }
    if (kind === 'pencil') {
      return 4;
    }
    if (kind === 'marker') {
      return 7;
    }
    if (kind === 'highlighter') {
      return 9;
    }
    return 3;
  }

  /** 笔形的图标颜色（铅笔灰、荧光笔黄，其余主文字色）。 */
  private brushIconColor(kind: string): ResourceColor {
    if (kind === 'pencil') {
      return '#8A8A8A';
    }
    if (kind === 'highlighter') {
      return '#F5B700';
    }
    return $r('app.color.text_primary');
  }

  /** 笔形图标：一根按笔刷类型变粗的斜杆（18vp 高）。 */
  @Builder
  brushIcon(kind: string) {
    Text('')
      .width(this.brushIconWidth(kind))
      .height(18)
      .borderRadius(2)
      .backgroundColor(this.brushIconColor(kind))
      .rotate({ angle: -35 })
  }

  /** 粗细图标：三个递增圆点。 */
  @Builder
  sizeIcon() {
    Row({ space: 1 }) {
      Text('')
        .width(4)
        .height(4)
        .borderRadius(2)
        .backgroundColor($r('app.color.text_primary'))
      Text('')
        .width(7)
        .height(7)
        .borderRadius(3.5)
        .backgroundColor($r('app.color.text_primary'))
      Text('')
        .width(10)
        .height(10)
        .borderRadius(5)
        .backgroundColor($r('app.color.text_primary'))
    }
    .height(18)
    .alignItems(VerticalAlign.Center)
  }

  /** 颜色图标：三个小色块。 */
  @Builder
  colorIcon() {
    Row({ space: 1 }) {
      Text('')
        .width(7)
        .height(12)
        .backgroundColor('#1A1A1A')
      Text('')
        .width(7)
        .height(12)
        .backgroundColor('#D93025')
      Text('')
        .width(7)
        .height(12)
        .backgroundColor('#1A73E8')
    }
    .height(18)
  }

  /** 按面板/工具类型挑图标。 */
  @Builder
  toolbarIcon(kind: string) {
    if (kind === PANEL_SIZE) {
      this.sizeIcon()
    } else if (kind === PANEL_COLOR) {
      this.colorIcon()
    } else {
      this.brushIcon(this.pagerState.brush)
    }
  }

  // ------------------------------------------------------------------ 工具条按钮

  /** 图标 + ▾ 的菜单按钮（笔形 / 粗细 / 颜色）。 */
  @Builder
  iconMenuButton(kind: string, panelName: string) {
    Row({ space: 2 }) {
      this.toolbarIcon(kind)
      Text('▾')
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.None })
        .fontColor(this.panel === panelName ? Color.White : $r('app.color.text_secondary'))
    }
    .justifyContent(FlexAlign.Center)
    .constraintSize({ minWidth: TOOL_MIN_WIDTH })
    .height(TOOL_HEIGHT)
    .padding({ left: SPACING.xs, right: SPACING.xs })
    .borderRadius(RADIUS.sm)
    .backgroundColor(this.panel === panelName ? $r('app.color.brand') : '#F1F3F5')
    .flexShrink(0)
    .onClick(() => {
      this.togglePanel(panelName);
    })
  }

  /**
   * 橡皮 / 手动框：独立按钮，点一次进该模式、再点一次回画笔。
   * 选中态品牌淡底 + 品牌色文字；**禁用态不降透明度**（定版：只改颜色）。
   */
  @Builder
  toolButton(label: string, tool: string) {
    Text(label)
      .height(TOOL_HEIGHT)
      .constraintSize({ minWidth: TOOL_MIN_WIDTH })
      .padding({ left: SPACING.xs, right: SPACING.xs })
      .fontSize(FONT.caption)
      .lineHeight(LINE_HEIGHT.caption)
      .maxLines(1)
      .textOverflow({ overflow: TextOverflow.None })
      .textAlign(TextAlign.Center)
      .borderRadius(RADIUS.sm)
      .backgroundColor(this.pagerState.tool === tool ? '#E8F1FF' : '#F1F3F5')
      .fontColor(this.pagerState.tool === tool ? $r('app.color.brand') : $r('app.color.text_primary'))
      .border({ width: this.pagerState.tool === tool ? 1 : 0, color: $r('app.color.brand') })
      .flexShrink(0)
      .onClick(() => {
        this.toggleTool(tool);
      })
  }

  /** 撤销 / 重做（图标按钮；`kind` 分发，避免把回调传进 @Builder）。 */
  @Builder
  historyButton(kind: string, label: string, enabled: boolean) {
    Text(label)
      .height(TOOL_HEIGHT)
      .constraintSize({ minWidth: TOOL_MIN_WIDTH })
      .fontSize(FONT.body)
      .textAlign(TextAlign.Center)
      .borderRadius(RADIUS.sm)
      .backgroundColor('#EEF1F4')
      // 禁用态：只改颜色，不整体透明（真机上透明会被误认为「按钮没了」）
      .fontColor(enabled ? $r('app.color.text_primary') : $r('app.color.text_secondary'))
      .enabled(enabled)
      .flexShrink(0)
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

  /**
   * 页码步进器 `− n/m +`（整体一个控件，`flexShrink(0)`）：
   * `−` 删当前页（两步确认）、`+` 在当前页之后插入空白页。
   */
  @Builder
  pageStepper() {
    Row() {
      Text('−')
        .width(STEPPER_BTN)
        .height(TOOL_HEIGHT)
        .fontSize(FONT.body)
        .textAlign(TextAlign.Center)
        // 禁用态只改色，不降透明度
        .fontColor(this.pageCount > 1 ? $r('app.color.danger') : $r('app.color.text_secondary'))
        .enabled(this.pageCount > 1)
        .onClick(() => {
          this.startDeletePage();
        })
      Text(`${this.currentPage + 1}/${this.pageCount}`)
        .width(STEPPER_LABEL_W)
        .height(TOOL_HEIGHT)
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.None })
        .textAlign(TextAlign.Center)
        .fontColor($r('app.color.text_primary'))
      Text('+')
        .width(STEPPER_BTN)
        .height(TOOL_HEIGHT)
        .fontSize(FONT.body)
        .textAlign(TextAlign.Center)
        .fontColor(this.pageCount < MAX_HANDWRITING_PAGES ? $r('app.color.brand') : $r('app.color.text_secondary'))
        .enabled(this.pageCount < MAX_HANDWRITING_PAGES)
        .onClick(() => {
          this.insertPage();
        })
    }
    .height(TOOL_HEIGHT)
    .constraintSize({ minWidth: STEPPER_BTN * 2 + STEPPER_LABEL_W })
    .borderRadius(RADIUS.sm)
    .backgroundColor('#F7F8FA')
    .flexShrink(0)
  }

  /** 「完成」：唯一主操作，实底品牌蓝 + 白字、`minWidth 64vp`、不收缩。 */
  @Builder
  finishButton(fullWidth: boolean) {
    Button(this.busy ? '识别中' : '完成')
      .height(TOOL_HEIGHT)
      .width(fullWidth ? RAIL_WIDTH - SPACING.sm : undefined)
      .constraintSize({ minWidth: FINISH_MIN_WIDTH })
      .fontSize(FONT.caption)
      .lineHeight(LINE_HEIGHT.caption)
      .maxLines(1)
      .textOverflow({ overflow: TextOverflow.None })
      .backgroundColor($r('app.color.brand'))
      .fontColor(Color.White)
      .enabled(!this.busy)
      .flexShrink(0)
      .onClick(() => {
        this.finish();
      })
  }

  /** 竖屏：顶部单行工具条（48vp，9 个控件；溢出时该行横向滚动、不换行不加高）。 */
  @Builder
  topBar() {
    Row({ space: SPACING.xs }) {
      Scroll() {
        Row({ space: SPACING.xs }) {
          this.iconMenuButton(PANEL_BRUSH, PANEL_BRUSH)
          this.iconMenuButton(PANEL_SIZE, PANEL_SIZE)
          this.iconMenuButton(PANEL_COLOR, PANEL_COLOR)
          this.toolButton('橡皮', HW_TOOL_ERASER)
          this.toolButton('手动框', HW_TOOL_SELECT)
          this.historyButton('undo', '↶', this.undoSteps > 0)
          this.historyButton('redo', '↷', this.redoAvailable)
          this.pageStepper()
        }
        .height(TOOL_HEIGHT)
        .alignItems(VerticalAlign.Center)
      }
      .scrollable(ScrollDirection.Horizontal)
      .scrollBar(BarState.Off)
      .layoutWeight(1)
      .height(TOOL_HEIGHT)
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
      this.iconMenuButton(PANEL_BRUSH, PANEL_BRUSH)
      this.iconMenuButton(PANEL_SIZE, PANEL_SIZE)
      this.iconMenuButton(PANEL_COLOR, PANEL_COLOR)
      this.toolButton('橡皮', HW_TOOL_ERASER)
      this.toolButton('手动框', HW_TOOL_SELECT)
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

  // ------------------------------------------------------------------ 二级面板（绝对定位浮层，不挤压画布）

  /** 面板锚点：竖屏在工具条下方、横屏在 rail 右侧（都不碰画布中心）。 */
  private panelLeft(): number {
    return this.landscape ? RAIL_WIDTH + SPACING.sm : SPACING.sm;
  }

  private panelTop(): number {
    if (this.landscape) {
      // rail 里第 1~3 个按钮对应笔形/粗细/颜色
      const index: number = this.panel === PANEL_BRUSH ? 0 : (this.panel === PANEL_SIZE ? 1 : 2);
      return SPACING.sm + index * (TOOL_HEIGHT + SPACING.xs);
    }
    return TOP_BAR_HEIGHT + SPACING.xs;
  }

  /** 面板宽度（按内容给足，避免文字被截断）。 */
  private panelWidth(): number {
    if (this.panel === PANEL_BRUSH) {
      return 176;
    }
    if (this.panel === PANEL_SIZE) {
      return 140;
    }
    return 156;
  }

  /** 选中行底色。 */
  private rowBackground(selected: boolean): ResourceColor {
    return selected ? '#E8F1FF' : Color.Transparent;
  }

  /** 二级面板：竖向列表（行高 44vp），笔形 / 粗细 / 颜色各一套。 */
  @Builder
  overlayPanel() {
    Column() {
      if (this.panel === PANEL_BRUSH) {
        ForEach(
          BRUSHES,
          (spec: BrushSpec) => {
            Row() {
              this.brushIcon(spec.kind)
              Text(spec.label)
                .fontSize(FONT.caption)
                .lineHeight(LINE_HEIGHT.caption)
                .maxLines(1)
                .textOverflow({ overflow: TextOverflow.None })
                .fontColor($r('app.color.text_primary'))
                .margin({ left: SPACING.sm })
              Blank()
              if (this.pagerState.brush === spec.kind && this.pagerState.tool === HW_TOOL_BRUSH) {
                Text('✓')
                  .fontSize(FONT.caption)
                  .fontColor($r('app.color.brand'))
              }
            }
            .width('100%')
            .height(MENU_ROW_HEIGHT)
            .padding({ left: SPACING.sm, right: SPACING.sm })
            .backgroundColor(
              this.rowBackground(this.pagerState.brush === spec.kind && this.pagerState.tool === HW_TOOL_BRUSH)
            )
            .onClick(() => {
              this.pickBrush(spec.kind);
            })
          },
          (spec: BrushSpec) => `panel-brush-${spec.kind}`
        )
      } else if (this.panel === PANEL_SIZE) {
        ForEach(
          PEN_WIDTHS,
          (width: number, index: number) => {
            Row() {
              // 用户反馈「5 个选项空白」：圆点必须显式给宽高/圆角/颜色
              Text('')
                .width(SIZE_DOTS[index])
                .height(SIZE_DOTS[index])
                .borderRadius(SIZE_DOTS[index] / 2)
                .backgroundColor($r('app.color.text_primary'))
              Text(`${width}`)
                .fontSize(FONT.caption)
                .lineHeight(LINE_HEIGHT.caption)
                .maxLines(1)
                .textOverflow({ overflow: TextOverflow.None })
                .fontColor($r('app.color.text_primary'))
                .margin({ left: SPACING.sm })
              Blank()
              if (this.pagerState.penWidth === width) {
                Text('✓')
                  .fontSize(FONT.caption)
                  .fontColor($r('app.color.brand'))
              }
            }
            .width('100%')
            .height(MENU_ROW_HEIGHT)
            .padding({ left: SPACING.sm, right: SPACING.sm })
            .backgroundColor(this.rowBackground(this.pagerState.penWidth === width))
            .onClick(() => {
              this.pickWidth(width);
            })
          },
          (width: number) => `panel-size-${width}`
        )
      } else {
        ForEach(
          PEN_COLORS,
          (color: string, index: number) => {
            Row() {
              Text('')
                .width(SWATCH)
                .height(SWATCH)
                .borderRadius(RADIUS.sm)
                .backgroundColor(color)
                .border({
                  width: this.pagerState.penColor === color ? 2 : 1,
                  color: this.pagerState.penColor === color ? $r('app.color.brand') : '#DDDDDD'
                })
              Text(COLOR_LABELS[index])
                .fontSize(FONT.caption)
                .lineHeight(LINE_HEIGHT.caption)
                .maxLines(1)
                .textOverflow({ overflow: TextOverflow.None })
                .fontColor($r('app.color.text_primary'))
                .margin({ left: SPACING.sm })
              Blank()
              if (this.pagerState.penColor === color) {
                Text('✓')
                  .fontSize(FONT.caption)
                  .fontColor($r('app.color.brand'))
              }
            }
            .width('100%')
            .height(MENU_ROW_HEIGHT)
            .padding({ left: SPACING.sm, right: SPACING.sm })
            .backgroundColor(this.rowBackground(this.pagerState.penColor === color))
            .onClick(() => {
              this.pickColor(color);
            })
          },
          (color: string) => `panel-color-${color}`
        )
      }
    }
    .width(this.panelWidth())
    .padding({ top: SPACING.xs, bottom: SPACING.xs })
    .borderRadius(RADIUS.md)
    .backgroundColor(Color.White)
    .shadow({ radius: 16, color: 'rgba(0,0,0,0.16)', offsetY: 4 })
    .position({ x: this.panelLeft(), y: this.panelTop() })
    .alignItems(HorizontalAlign.Start)
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

  // ------------------------------------------------------------------ 删除页两步确认

  private dialogWidth(): number {
    return Math.min(360, Math.max(240, this.pageW - 2 * SPACING.xl));
  }

  @Builder
  deleteDialog() {
    Column() {
      Column({ space: SPACING.md }) {
        Text(this.confirmStage === CONFIRM_FIRST ? '删除这一页？' : '再次确认')
          .fontSize(FONT.title)
          .lineHeight(LINE_HEIGHT.title)
          .fontWeight(FontWeight.Bold)
          .fontColor($r('app.color.text_primary'))
        Text(
          this.confirmStage === CONFIRM_FIRST
            ? `删除第 ${this.currentPage + 1} 页？该页手迹与附件将一并移除。`
            : '再次确认：删除后无法恢复。'
        )
          .fontSize(FONT.body)
          .lineHeight(LINE_HEIGHT.body)
          .fontColor($r('app.color.text_secondary'))
        Row({ space: SPACING.sm }) {
          Button('取消')
            .layoutWeight(1)
            .height(TOUCH_MIN)
            .fontSize(FONT.body)
            .backgroundColor('#EEF1F4')
            .fontColor($r('app.color.text_primary'))
            .onClick(() => {
              this.confirmStage = CONFIRM_NONE;
              console.info('[hw] delete confirm cancelled');
            })
          Button(this.confirmStage === CONFIRM_FIRST ? '删除' : '确认删除')
            .layoutWeight(1)
            .height(TOUCH_MIN)
            .fontSize(FONT.body)
            .backgroundColor($r('app.color.danger'))
            .fontColor(Color.White)
            .onClick(() => {
              this.confirmDelete();
            })
        }
        .width('100%')
      }
      .width(this.dialogWidth())
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

  // ------------------------------------------------------------------ 首次引导

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
      .width(this.dialogWidth())
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
      if (this.panel !== '') {
        this.overlayScrim()
        this.overlayPanel()
      }

      if (this.confirmStage !== CONFIRM_NONE) {
        this.deleteDialog()
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
