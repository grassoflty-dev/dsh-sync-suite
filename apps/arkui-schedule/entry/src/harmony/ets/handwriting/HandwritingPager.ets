/**
 * 分页手写板（**仅 HarmonyOS**）：Canvas 槽位化 + 顶部页条 + 5 种笔刷（钢笔/圆珠笔/铅笔/马克笔/荧光笔）
 * + 橡皮 + 框选 overlay + 按页撤销重做。
 *
 * 契约：BRIEF §3.2「分页手写板：Canvas 分页（`setMaxPages` 限制）」+「区域框内不做 OCR，只保存原图」。
 *
 * 设计要点：
 * - 页序与画布槽位**解耦**：账本由模型层 `PageBook`（`slots` / `regions` / `current`）维护，
 *   删除中间页后其余页的画布槽位与框都跟着页走，笔迹不会错位；
 * - 笔迹历史按页存在模型层 `StrokeHistory`（由 `HandwritingPagerState.history` 持有），
 *   每笔记录 `{ points, width, color, erase, brush }`；每页最多 20 步撤销，撤销/重做用
 *   `replayPage()` 整页重绘（重放按 `paintFor(brush, ...)` 还原笔刷，铅笔抖动的点已存在 points 里，
 *   重放时**不再二次抖动**）；
 * - 删除中间页时 `PageBook` 会重排页序，但 `StrokeHistory` 只按页索引存——所以
 *   `HandwritingPagerState.removePage()` 会**按新页序重建** `StrokeHistory`，再让组件
 *   逐页重绘（见 `replayAllImpl`）；重做栈在重建时丢弃（删除是不可逆操作）。
 * - `HandwritingPagerState` 仍是 `@Observed`，但 ArkUI 的 `@ObjectLink` 只监听**自身字段**，
 *   所以每次操作后由 `sync()` 把 `PageBook` 的值复制回扁平字段（`slots`/`regions` 重新赋值以触发刷新）；
 * - `contexts` 预建 `MAX_HANDWRITING_PAGES` 个 `CanvasRenderingContext2D`，`ForEach` 遍历
 *   `state.slots`，只有当前页对应的槽位 `opacity(1)` 且可触摸；
 * - **框选 overlay 是笔迹 Canvas 的兄弟节点**（同在 `Stack` 里）。`componentSnapshot.get(id)` 只截
 *   `hw-page-<slot>` 这一个 Canvas 节点，框/手柄/删除按钮作为兄弟天然不会进截图。
 *   ⚠ 后续改代码的人请勿把框画进 Canvas：一旦框进入 `hw-page-*` 的绘制内容，落盘的原始截图
 *   就会带上橙色虚线，「只保存原图」的语义就被破坏了。
 *
 * 手势设计（重要）：框的视觉必须随拖动每帧更新，而 ArkUI 的 `ForEach` 在键值不变时不会重建子组件，
 * 因此框的关键字里带了几何值（几何变化 → 组件重建 → 位置必然刷新）。若把 `PanGesture` 挂在
 * 会被重建的框组件上，拖动第一帧后手势就被取消，所以整个 overlay 只挂**一个** `PanGesture`，
 * 由坐标命中测试决定这次手势是「新建 / 移动 / 改大小」——overlay 自身不重建，手势可以连续。
 *
 * // TODO(一笔成形)：停顿 600ms 判定直线/矩形/圆（本轮不做，需要拟合与吸附）。
 * //   2026-11-15：一笔闭合轨迹自动成框的方案已评估并整体移除（用户拍板不做），
 * //   「不 OCR 区域」的唯一入口就是下面的「框选」。
 *
 * 手写笔手感（用户有手写笔）：
 * - **压感**：`TouchObject.pressure`(0..65535，API 15+) → `pressureWidth()` 映射线宽，
 *   夹在 `[0.5, 基础线宽×1.6]`；`pressure` 缺失或为 0（部分设备/手指不报压感）按「不缩放」处理；
 * - **历史点补采**：`TouchEvent.getHistoricalPoints()` 把一帧内硬件上报的多个点都收进来，
 *   高倍速书写时不再「一笔几个点」；
 * - **平滑**：实时绘制用二次贝塞尔（以相邻点中点为端点、前一点为控制点），
 *   抬手后用 `smoothPath()`（二次 B 样条，点数不变、首尾不动）重整持久化的点序列；
 * - **速度调宽**：`speedWidthScaleFor()` —— 钢笔沿用原区间，圆珠笔/铅笔也用上「快细慢粗」。
 *
 * ⚠ 本机无设备：Canvas 笔迹、橡皮 `destination-out`、半透明笔刷接缝、
 * `componentSnapshot` 截图、手势表现均需真机核对。
 */
import { promptAction } from '@kit.ArkUI';
import { PageBook, MAX_HANDWRITING_PAGES } from '../model/pageBook';
import { MIN_REGION_SIDE, regionsToMaskRects, sanitizeRegion } from '../model/regions';
import type { MaskRect } from '../model/regions';
import { StrokeHistory, PEN_WIDTHS, PEN_COLORS, DEFAULT_PEN_WIDTH, DEFAULT_PEN_COLOR } from '../model/strokeHistory';
import type { Stroke, StrokePoint } from '../model/strokeHistory';
import {
  BRUSHES,
  DEFAULT_BRUSH,
  brushSpec,
  paintFor,
  pressureWidth,
  speedWidthScaleFor,
  jitterPoint
} from '../model/brush';
import type { BrushKind, BrushPaint, BrushSpec } from '../model/brush';
import { smoothPath } from '../model/strokeSmooth';
import { StylusAssist } from './StylusAssist';
import type { RegionBox } from '../model/types';

export { MAX_HANDWRITING_PAGES };

/** 每页截图组件的 id 前缀：`hw-page-0`、`hw-page-1` …（OCR 截图按 id 定位）。 */
export const HANDWRITING_PAGE_ID_PREFIX: string = 'hw-page-';

/** 区域框描边色（overlay 专用，绝不进截图）。 */
const REGION_STROKE: string = '#F59E0B';
/** 区域框填充色（半透明，便于确认范围）。 */
const REGION_FILL: string = 'rgba(245,158,11,0.10)';
/** 右下角改大小手柄的边长（vp）。 */
const HANDLE_SIZE: number = 14;
/** 右上角删除按钮的边长（vp）。 */
const DELETE_SIZE: number = 18;
/** 粗细档位的视觉直径（与 PEN_WIDTHS 一一对应；只是 UI 展示，不等于线宽）。 */
const PEN_DOT_SIZES: number[] = [6, 8, 10, 13, 16];

/** 工具模式（字符串常量，避免 ArkTS 枚举样板）。 */
const TOOL_BRUSH: string = 'brush';
const TOOL_ERASER: string = 'eraser';
const TOOL_SELECT: string = 'select';

/** 手势类型。 */
const DRAG_NONE: string = 'none';
const DRAG_CREATE: string = 'create';
const DRAG_MOVE: string = 'move';
const DRAG_RESIZE: string = 'resize';

/**
 * 手写板状态（@Observed：父页面与子组件共享同一份）。
 *
 * 内部的 `book`（页序/框）与 `history`（笔迹）是事实来源；扁平字段只是 `book` 的**可观察快照**，
 * 供 `build()` / 父页面直接读取（ArkUI 不监听深层对象字段）。
 */
@Observed
export class HandwritingPagerState {
  /** 当前总页数（1 起）。 */
  pages: number = 1;
  /** 当前页索引（0 起）。 */
  current: number = 0;
  /** 页数上限。 */
  maxPages: number = MAX_HANDWRITING_PAGES;
  /** 页序 → 画布槽位（第 i 页用哪个 Canvas 索引）。 */
  slots: number[] = [];
  /** 每页的区域框（与 `slots` 等长同序；归一化坐标，框内不做 OCR）。 */
  regions: RegionBox[][] = [];
  /** 按页索引的笔迹历史（页数变化时由本类维护；删中间页会整体重建）。 */
  history: StrokeHistory = new StrokeHistory(MAX_HANDWRITING_PAGES);

  /**
   * 区域填白实现（由 `HandwritingPager` 在 `aboutToAppear` 注册）。
   * 父页面拿不到子组件实例，只能通过它转调；未注册时 `maskPage()` 抛错。
   */
  maskImpl: ((pageIndex: number, regions: RegionBox[]) => Promise<void>) | null = null;

  /**
   * 页序重排后的重绘钩子（由 `HandwritingPager` 注册）：
   * 入参是「被删页原来的画布槽位」，组件据此清空该槽位并按新页序重绘其余页面。
   */
  replayAllImpl: ((removedSlot: number) => void) | null = null;

  /** 页序账本（模型层纯逻辑，负责增删页与区域框）。 */
  private book: PageBook = new PageBook(MAX_HANDWRITING_PAGES);

  constructor() {
    if (this.book.pageCount() < 1) {
      // 账本正常构造已含首页，这里只做防御
      this.book.addPage();
    }
    this.sync();
  }

  /** 把账本的值复制到可观察扁平字段（重新赋值才会触发刷新）。 */
  private sync(): void {
    this.pages = this.book.pageCount();
    this.current = this.book.current;
    this.maxPages = this.book.maxPages;
    this.slots = this.book.indexes().slice();
    const regions: RegionBox[][] = [];
    for (let index = 0; index < this.pages; index++) {
      // regionsAt 返回副本；外层再包一个新数组 → 赋值即触发刷新
      regions.push(this.book.regionsAt(index).slice());
    }
    this.regions = regions;
    this.history.ensurePageCount(this.pages);
  }

  /** 设置页数上限（模型层负责夹紧到 1..MAX 并裁剪多余页）。 */
  setMaxPages(max: number): void {
    this.book.setMaxPages(max);
    this.sync();
  }

  /** 新增一页（空白、无框、无笔迹）；已达上限返回 false。 */
  addPage(): boolean {
    const added: boolean = this.book.addPage();
    this.sync();
    return added;
  }

  /**
   * 删除第 index 页；只剩 1 页返回 false。
   *
   * `PageBook` 会把后面的页整体前移，但 `StrokeHistory` 只按页索引存笔迹，
   * 不重建就会「第 3 页的笔迹跑到第 2 页」。因此这里按**新页序**重建历史，
   * 再通过 `replayAllImpl` 让组件逐页重绘（重做栈丢弃）。
   */
  removePage(index: number): boolean {
    const beforeCount: number = this.pages;
    if (index < 0 || index >= beforeCount || beforeCount <= 1) {
      return false;
    }
    // 先按旧页序拍下每页笔迹（深拷贝，重建时不受后续影响）
    const snapshot: Stroke[][] = [];
    for (let page = 0; page < beforeCount; page++) {
      snapshot.push(this.history.strokesAt(page));
    }
    const removedSlot: number = this.slots[index];
    if (!this.book.removePage(index)) {
      return false;
    }
    this.sync();
    const rebuilt: StrokeHistory = new StrokeHistory(this.pages);
    for (let page = 0; page < this.pages; page++) {
      const oldPage: number = page < index ? page : page + 1;
      const strokes: Stroke[] = oldPage < snapshot.length ? snapshot[oldPage] : [];
      for (let step = 0; step < strokes.length; step++) {
        rebuilt.push(page, strokes[step]);
      }
    }
    this.history = rebuilt;
    const replay = this.replayAllImpl;
    if (replay !== null) {
      replay(removedSlot);
    }
    return true;
  }

  /** 跳到第 index 页；越界返回 false。 */
  jumpTo(index: number): boolean {
    const jumped: boolean = this.book.jumpTo(index);
    this.sync();
    return jumped;
  }

  /** 上一页；已在首页返回 false。 */
  prev(): boolean {
    const moved: boolean = this.book.prev();
    this.sync();
    return moved;
  }

  /** 下一页；已在末页返回 false。 */
  next(): boolean {
    const moved: boolean = this.book.next();
    this.sync();
    return moved;
  }

  /** 第 index 页的框（副本；越界为空数组）。 */
  regionsAt(index: number): RegionBox[] {
    return this.book.regionsAt(index);
  }

  /** 覆盖第 index 页的框（模型层内部清洗）。 */
  setRegions(index: number, boxes: RegionBox[]): void {
    this.book.setRegions(index, boxes);
    this.sync();
  }

  /** 给第 index 页加一个框；非法/太小返回 false。 */
  addRegion(index: number, box: RegionBox): boolean {
    const added: boolean = this.book.addRegion(index, box);
    this.sync();
    return added;
  }

  /** 删除第 index 页的第 regionIndex 个框。 */
  removeRegion(index: number, regionIndex: number): boolean {
    const removed: boolean = this.book.removeRegion(index, regionIndex);
    this.sync();
    return removed;
  }

  /** 更新第 index 页的第 regionIndex 个框（拖动 / 改大小都走这里）。 */
  updateRegion(index: number, regionIndex: number, box: RegionBox): boolean {
    const updated: boolean = this.book.updateRegion(index, regionIndex, box);
    this.sync();
    return updated;
  }

  /** 每页框列表（供 `finish()` 传给 OcrBatchManager；按页序）。 */
  regionsList(): RegionBox[][] {
    const list: RegionBox[][] = [];
    const source: RegionBox[][] = this.book.regions;
    for (let index = 0; index < source.length; index++) {
      const page: RegionBox[] = source[index];
      list.push(page.slice());
    }
    return list;
  }

  /** 按页序生成截图组件 id（`${prefix}${slot}`），供 OCR 批处理使用。 */
  snapshotIds(prefix: string): string[] {
    return this.book.snapshotIds(prefix);
  }

  /** 记录一笔（笔迹数 / 撤销深度变化由组件负责刷新文案）。 */
  pushStroke(pageIndex: number, stroke: Stroke): void {
    this.history.push(pageIndex, stroke);
  }

  /** 清空某页笔迹历史（同时清掉重做栈）。 */
  clearPageHistory(pageIndex: number): void {
    this.history.clearPage(pageIndex);
  }

  /**
   * 区域填白（转调已注册的 `maskImpl`）：把第 pageIndex 页上的框填成白色。
   * 批次阶段 B 会紧接着二次截图送 OCR，框内内容因此不会进入识别结果。
   */
  async maskPage(pageIndex: number, regions: RegionBox[]): Promise<void> {
    const impl: ((pageIndex: number, regions: RegionBox[]) => Promise<void>) | null = this.maskImpl;
    if (impl === null) {
      throw new Error('手写板尚未就绪：没有可用的区域填白能力');
    }
    await impl(pageIndex, regions);
  }
}

/** 一个采样点（画布 vp 坐标 + 压感；`pressure < 0` 表示该点没有压感信息）。 */
interface StrokeSample {
  x: number;
  y: number;
  pressure: number;
}

@Component
export struct HandwritingPager {
  /** 与父页面共享的分页状态。 */
  @ObjectLink state: HandwritingPagerState;
  /** 页数上限（与 state.setMaxPages 联动）。 */
  maxPages: number = MAX_HANDWRITING_PAGES;
  /** 翻页/增页/删页后通知父页面（父页面用它显示页码）。 */
  onStateChange: (pages: number, current: number) => void = () => {};
  /**
   * 笔迹/框数/工具变化后通知父页面（父页面显示状态行）：
   * `(本页笔数, 本页框数, 撤销深度, 笔刷中文名, 粗细)`。
   */
  onStatsChange: (strokes: number, regions: number, undoDepth: number, brushLabel: string, width: number) => void =
    () => {};

  private settings: RenderingContextSettings = new RenderingContextSettings(true);
  private contexts: CanvasRenderingContext2D[] = [];
  /** 正在书写的画布槽位（-1 表示未落笔）。 */
  private drawingSlot: number = -1;
  /** 正在画的那一笔（未结束时为 null）。 */
  private activeStroke: Stroke | null = null;
  /** 上一移动点与时间（钢笔速度调制用）。 */
  private lastX: number = 0;
  private lastY: number = 0;
  private lastMoveMs: number = 0;

  /** 当前工具：画笔（某笔刷）/ 橡皮 / 框选（三选一，全局设置）。 */
  @State tool: string = TOOL_BRUSH;
  /** 当前笔刷（全局设置）。 */
  @State brush: BrushKind = DEFAULT_BRUSH;
  /** 粗细档（全局设置）。 */
  @State penWidth: number = DEFAULT_PEN_WIDTH;
  /** 颜色（全局设置）。 */
  @State penColor: string = DEFAULT_PEN_COLOR;
  /** 当前页笔迹数 / 框数 / 撤销可用性（用于按钮与状态行）。 */
  @State strokeCount: number = 0;
  @State regionCount: number = 0;
  @State undoSteps: number = 0;
  @State redoAvailable: boolean = false;
  /** 画布可视尺寸（vp；归一化坐标换算用）。 */
  @State canvasW: number = 0;
  @State canvasH: number = 0;
  /** 新建框时的虚线预览（像素坐标）。 */
  @State dragging: boolean = false;
  @State dragStartX: number = 0;
  @State dragStartY: number = 0;
  @State dragCurX: number = 0;
  @State dragCurY: number = 0;
  /** 当前手势类型与命中框（不参与渲染）。 */
  private dragMode: string = DRAG_NONE;
  private dragIndex: number = -1;
  private dragBaseX: number = 0;
  private dragBaseY: number = 0;
  private dragBaseW: number = 0;
  private dragBaseH: number = 0;

  /** 手写笔快捷操作（轻捏切橡皮 / 双击撤销）是否注册成功。 */
  private stylusShortcuts: boolean = false;

  aboutToAppear(): void {
    for (let i = 0; i < MAX_HANDWRITING_PAGES; i++) {
      this.contexts.push(new CanvasRenderingContext2D(this.settings));
    }
    this.state.setMaxPages(this.maxPages);
    // 注册填白实现：父页面通过 state.maskPage() 用到它
    this.state.maskImpl = (pageIndex: number, regions: RegionBox[]): Promise<void> =>
      this.maskPage(pageIndex, regions);
    // 注册页序重排后的重绘：删中间页时 state 会重建 StrokeHistory，再让这里整页重绘
    this.state.replayAllImpl = (removedSlot: number) => {
      this.afterPageRemoved(removedSlot);
    };
    // 手写笔快捷操作：轻捏切橡皮、双击撤销（取不到就静默禁用，不影响书写）
    this.stylusShortcuts = StylusAssist.enableShortcuts(
      () => {
        this.setTool(TOOL_ERASER);
        promptAction.showToast({ message: '手写笔轻捏：已切到橡皮', duration: 1200 });
      },
      () => {
        this.onUndo();
      }
    );
    this.notifyParent();
    this.refreshStats();
  }

  aboutToDisappear(): void {
    StylusAssist.disableShortcuts();
  }

  // ------------------------------------------------------------------ 状态辅助

  private notifyParent(): void {
    this.onStateChange(this.state.pages, this.state.current);
  }

  /** 刷新笔迹数 / 框数 / 撤销重做可用性（ArkUI 只监听 @State，所以必须落到 @State）。 */
  private refreshStats(): void {
    const current: number = this.state.current;
    const history: StrokeHistory = this.state.history;
    this.strokeCount = history.strokesAt(current).length;
    this.regionCount = this.currentRegions().length;
    this.undoSteps = history.undoDepth(current);
    this.redoAvailable = history.canRedo(current);
    this.onStatsChange(this.strokeCount, this.regionCount, this.undoSteps, brushSpec(this.brush).label, this.penWidth);
  }

  /** 当前页对应的画布槽位（无效时返回 -1）。 */
  private activeSlot(): number {
    const slots: number[] = this.state.slots;
    if (this.state.current < 0 || this.state.current >= slots.length) {
      return -1;
    }
    return slots[this.state.current];
  }

  /** 当前页的框列表（缺页时给空数组，避免渲染期取到 undefined）。 */
  private currentRegions(): RegionBox[] {
    const regions: RegionBox[][] = this.state.regions;
    if (this.state.current < 0 || this.state.current >= regions.length) {
      return [];
    }
    return regions[this.state.current];
  }

  private isSelectMode(): boolean {
    return this.tool === TOOL_SELECT;
  }

  private isEraseMode(): boolean {
    return this.tool === TOOL_ERASER;
  }

  // ------------------------------------------------------------------ 笔迹绘制

  /** 把 `paintFor` 的产物落到 canvas 上（颜色/线宽/合成模式都由模型层决定）。 */
  private applyPaint(context: CanvasRenderingContext2D, paint: BrushPaint): void {
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.globalCompositeOperation = paint.composite;
    context.strokeStyle = paint.strokeStyle;
    context.fillStyle = paint.strokeStyle;
    context.lineWidth = paint.lineWidth;
  }

  /** 单点（按下没移动）：实心圆点；橡皮同样按半径擦除。 */
  private drawDot(context: CanvasRenderingContext2D, stroke: Stroke): void {
    if (stroke.points.length === 0) {
      return;
    }
    const paint: BrushPaint = paintFor(stroke.brush, stroke.color, stroke.width, stroke.erase);
    this.applyPaint(context, paint);
    const radius: number = paint.lineWidth / 2;
    context.beginPath();
    context.arc(stroke.points[0].x, stroke.points[0].y, radius, 0, Math.PI * 2);
    context.fill();
  }

  /**
   * 重放一笔（撤销/重做、删页重绘都用它）。
   * 铅笔抖动的点已经存在 `points` 里，这里**不做二次抖动**，保证与实时绘制一致。
   */
  private drawStroke(context: CanvasRenderingContext2D, stroke: Stroke): void {
    if (stroke.points.length === 0) {
      return;
    }
    if (stroke.points.length === 1) {
      this.drawDot(context, stroke);
      return;
    }
    const paint: BrushPaint = paintFor(stroke.brush, stroke.color, stroke.width, stroke.erase);
    this.applyPaint(context, paint);
    context.beginPath();
    context.moveTo(stroke.points[0].x, stroke.points[0].y);
    for (let index = 1; index < stroke.points.length; index++) {
      context.lineTo(stroke.points[index].x, stroke.points[index].y);
    }
    context.stroke();
  }

  /** 整页重绘（先清空该页画布，再按顺序重放笔迹）。 */
  private replayPage(pageIndex: number, strokes: Stroke[]): void {
    const slots: number[] = this.state.slots;
    if (pageIndex < 0 || pageIndex >= slots.length) {
      return;
    }
    const slot: number = slots[pageIndex];
    if (slot < 0 || slot >= this.contexts.length) {
      return;
    }
    const context = this.contexts[slot];
    context.save();
    context.globalCompositeOperation = 'source-over';
    context.clearRect(0, 0, context.width, context.height);
    for (let index = 0; index < strokes.length; index++) {
      this.drawStroke(context, strokes[index]);
    }
    context.restore();
  }

  /** 删页后：清掉被删页的槽位，再按新页序重绘每一页。 */
  private afterPageRemoved(removedSlot: number): void {
    if (removedSlot >= 0 && removedSlot < this.contexts.length) {
      const context = this.contexts[removedSlot];
      context.clearRect(0, 0, context.width, context.height);
    }
    for (let page = 0; page < this.state.pages; page++) {
      this.replayPage(page, this.state.history.strokesAt(page));
    }
    this.drawingSlot = -1;
    this.activeStroke = null;
    this.refreshStats();
  }

  // ------------------------------------------------------------------ 工具 / 笔刷

  private setTool(tool: string): void {
    if (this.tool === tool) {
      return;
    }
    // 切换工具时结束进行中的这一笔（避免半笔悬空）
    this.drawingSlot = -1;
    this.activeStroke = null;
    this.dragMode = DRAG_NONE;
    this.dragging = false;
    this.tool = tool;
    this.refreshStats();
  }

  /** 选笔刷：自动切回画笔模式（笔刷与橡皮/框选互斥）。 */
  private setBrush(kind: BrushKind): void {
    this.brush = kind;
    this.setTool(TOOL_BRUSH);
    this.refreshStats();
  }

  private initContext(slot: number): void {
    if (slot < 0 || slot >= this.contexts.length) {
      return;
    }
    const context = this.contexts[slot];
    const paint: BrushPaint = paintFor(this.brush, this.penColor, this.penWidth, false);
    context.globalCompositeOperation = 'source-over';
    context.lineWidth = paint.lineWidth;
    context.strokeStyle = paint.strokeStyle;
    context.lineCap = 'round';
    context.lineJoin = 'round';
  }

  /** 本笔的绘制参数（橡皮走 erase=true，其余按笔刷）。 */
  private paintForActiveStroke(): BrushPaint {
    return paintFor(this.brush, this.penColor, this.penWidth, this.isEraseMode());
  }

  // ------------------------------------------------------------------ 触摸输入

  /** 取本次事件的主触摸点（`Up` 时 `touches` 可能已空，退到 `changedTouches`）。 */
  private primaryTouch(event: TouchEvent): TouchObject | null {
    const touches: TouchObject[] = event.touches;
    if (touches !== undefined && touches !== null && touches.length > 0) {
      return touches[0];
    }
    const changed: TouchObject[] = event.changedTouches;
    if (changed !== undefined && changed !== null && changed.length > 0) {
      return changed[0];
    }
    return null;
  }

  /** 读当前触摸点的压感：缺失/0/非有限 → `-1`（= 没有压感信息，线宽不缩放）。 */
  private readPressure(touch: TouchObject): number {
    const raw: number | undefined = touch.pressure;
    if (raw === undefined || !Number.isFinite(raw) || raw <= 0) {
      return -1;
    }
    return raw;
  }

  /**
   * 单点 + 历史点 → 采样序列。
   *
   * `TouchEvent.getHistoricalPoints()`（API 10+）返回**同一帧内**硬件上报的其余点：
   * 高倍速书写一帧可能有多个点，只取 `touches[0]` 会把笔画画成折线。
   * 预置/部分设备取不到历史点 → 退化成「只有一个当前点」，不影响书写。
   */
  private collectSamples(event: TouchEvent, x: number, y: number, pressure: number): StrokeSample[] {
    const samples: StrokeSample[] = [];
    try {
      const history: HistoricalPoint[] = event.getHistoricalPoints();
      if (history !== undefined && history !== null) {
        for (let index = 0; index < history.length; index++) {
          const point: HistoricalPoint = history[index];
          const touch: TouchObject = point.touchObject;
          if (touch === undefined || touch === null) {
            continue;
          }
          let historyPressure: number = -1;
          if (touch.pressure !== undefined) {
            historyPressure = touch.pressure;
          } else if (point.force > 0) {
            historyPressure = point.force;
          }
          samples.push({ x: touch.x, y: touch.y, pressure: historyPressure });
        }
      }
    } catch {
      // 没有历史点：忽略（当前点照常入账）
    }
    samples.push({ x: x, y: y, pressure: pressure });
    return samples;
  }

  /**
   * 把一个采样点画到画布上并记进 `stroke.points`。
   *
   * 线宽 = 笔刷线宽 × 速度系数 × 压感系数（只影响「这一笔内」的粗细）：
   * `Stroke.width` 仍记基础线宽，撤销/重放按基础线宽还原，模型里不存每点宽度。
   * 绘制用二次贝塞尔（起点=前两点中点、控制点=前一点、终点=前一点与当前点中点），
   * 比逐点 `lineTo` 平滑，且**不需要回看未来点**（可以流式绘制）。
   */
  private appendSample(
    context: CanvasRenderingContext2D,
    stroke: Stroke,
    paint: BrushPaint,
    sample: StrokeSample,
    elapsedPerSample: number
  ): void {
    let px: number = sample.x;
    let py: number = sample.y;
    if (paint.jitter > 0) {
      // 铅笔：抖动后的点才是真正画上去的点（也存进 points，撤销重绘可 1:1 还原）
      const jittered: StrokePoint = jitterPoint({ x: sample.x, y: sample.y }, paint.jitter);
      px = jittered.x;
      py = jittered.y;
    }
    const dx: number = px - this.lastX;
    const dy: number = py - this.lastY;
    const distance: number = Math.sqrt(dx * dx + dy * dy);
    let width: number = paint.lineWidth;
    if (!stroke.erase) {
      const speed: number = elapsedPerSample > 0 ? distance / elapsedPerSample : 0;
      width = width * speedWidthScaleFor(stroke.brush, speed);
      if (sample.pressure > 0) {
        // 压感只在「同一笔内」变粗细，不改笔刷的基准宽度
        width = pressureWidth(width, sample.pressure);
      }
    }
    context.lineWidth = width;
    const points: StrokePoint[] = stroke.points;
    const previous: StrokePoint = points[points.length - 1];
    points.push({ x: px, y: py });
    context.beginPath();
    if (points.length >= 3) {
      const before: StrokePoint = points[points.length - 3];
      context.moveTo((before.x + previous.x) / 2, (before.y + previous.y) / 2);
      context.quadraticCurveTo(previous.x, previous.y, (previous.x + px) / 2, (previous.y + py) / 2);
    } else {
      context.moveTo(previous.x, previous.y);
      context.lineTo(px, py);
    }
    context.stroke();
    this.lastX = px;
    this.lastY = py;
  }

  /** 收笔：把平滑曲线补到真实的最后一点（贝塞尔只画到「中点」，还差半段）。 */
  private finishStrokeTail(context: CanvasRenderingContext2D, stroke: Stroke): void {
    const points: StrokePoint[] = stroke.points;
    if (points.length < 2 || stroke.erase) {
      return;
    }
    const last: StrokePoint = points[points.length - 1];
    const previous: StrokePoint = points[points.length - 2];
    this.applyPaint(context, paintFor(stroke.brush, stroke.color, stroke.width, false));
    context.beginPath();
    context.moveTo((previous.x + last.x) / 2, (previous.y + last.y) / 2);
    context.lineTo(last.x, last.y);
    context.stroke();
  }

  private handleTouch(slot: number, event: TouchEvent): void {
    // 框选模式下画布不落笔（触摸交给 overlay 层建框）
    if (this.isSelectMode()) {
      return;
    }
    if (slot !== this.activeSlot()) {
      return;
    }
    const touch: TouchObject | null = this.primaryTouch(event);
    if (touch === null) {
      return;
    }
    const context = this.contexts[slot];
    const x: number = touch.x;
    const y: number = touch.y;
    if (event.type === TouchType.Down) {
      const stroke: Stroke = {
        points: [{ x: x, y: y }],
        width: this.penWidth,
        color: this.penColor,
        erase: this.isEraseMode(),
        brush: this.brush
      };
      this.activeStroke = stroke;
      this.drawingSlot = slot;
      this.applyPaint(context, this.paintForActiveStroke());
      this.lastX = x;
      this.lastY = y;
      this.lastMoveMs = Date.now();
      context.beginPath();
      context.moveTo(x, y);
      // 手写笔：请求提高书写帧率（无权限/能力不可用会在内部永久禁用，不影响书写）
      StylusAssist.boostFrame(0);
      return;
    }
    if (event.type === TouchType.Move) {
      const stroke: Stroke | null = this.activeStroke;
      if (this.drawingSlot !== slot || stroke === null) {
        return;
      }
      const paint: BrushPaint = paintFor(stroke.brush, stroke.color, stroke.width, stroke.erase);
      const samples: StrokeSample[] = this.collectSamples(event, x, y, this.readPressure(touch));
      const now: number = Date.now();
      const elapsedTotal: number = now - this.lastMoveMs;
      const elapsedPerSample: number = samples.length > 0 ? elapsedTotal / samples.length : 0;
      this.applyPaint(context, paint);
      for (let index = 0; index < samples.length; index++) {
        this.appendSample(context, stroke, paint, samples[index], elapsedPerSample);
      }
      this.lastMoveMs = now;
      StylusAssist.boostFrame(2);
      return;
    }
    if (event.type === TouchType.Up || event.type === TouchType.Cancel) {
      const stroke: Stroke | null = this.activeStroke;
      this.drawingSlot = -1;
      this.activeStroke = null;
      StylusAssist.boostFrame(1);
      if (stroke === null) {
        return;
      }
      if (stroke.points.length === 1) {
        // 只按了一下：补一个实心点，否则用户点不出痕迹
        this.drawDot(context, stroke);
      } else {
        this.finishStrokeTail(context, stroke);
        // 平滑并固化点序列（二次 B 样条：点数不变、首尾不动）。
        // 铅笔保留抖动纹理、橡皮保留原始擦除轨迹，都不参与平滑。
        if (!stroke.erase && stroke.brush !== 'pencil') {
          stroke.points = smoothPath(stroke.points);
        }
      }
      this.state.pushStroke(this.state.current, stroke);
      this.refreshStats();
    }
  }

  // ------------------------------------------------------------------ 撤销 / 重做 / 清空

  private onUndo(): void {
    const strokes: Stroke[] | null = this.state.history.undo(this.state.current);
    if (strokes === null) {
      return;
    }
    this.replayPage(this.state.current, strokes);
    this.refreshStats();
  }

  private onRedo(): void {
    const strokes: Stroke[] | null = this.state.history.redo(this.state.current);
    if (strokes === null) {
      return;
    }
    this.replayPage(this.state.current, strokes);
    this.refreshStats();
  }

  /** 清空第 position 页：笔迹 + 笔迹历史 + 该页的框（避免「字没了框还在」）。 */
  clearPage(position: number): void {
    if (position < 0 || position >= this.state.slots.length) {
      return;
    }
    const slot: number = this.state.slots[position];
    if (slot < 0 || slot >= this.contexts.length) {
      return;
    }
    const context = this.contexts[slot];
    context.save();
    context.globalCompositeOperation = 'source-over';
    context.clearRect(0, 0, context.width, context.height);
    context.restore();
    this.state.clearPageHistory(position);
    this.state.setRegions(position, []);
    this.drawingSlot = -1;
    this.activeStroke = null;
    this.refreshStats();
  }

  /** 删除当前页；槽位清空 / 历史重建 / 其余页重绘都由 state.removePage → replayAllImpl 完成。 */
  private removeCurrentPage(): void {
    if (!this.state.removePage(this.state.current)) {
      return;
    }
    this.dragMode = DRAG_NONE;
    this.dragging = false;
    this.drawingSlot = -1;
    this.activeStroke = null;
    this.notifyParent();
    this.refreshStats();
  }

  // ------------------------------------------------------------------ 区域框手势

  /** 命中测试：返回被点中的框下标（从最后绘制的开始，视觉上层优先）；没有命中返回 -1。 */
  private hitRegionIndex(x: number, y: number): number {
    const regions: RegionBox[] = this.currentRegions();
    if (this.canvasW <= 0 || this.canvasH <= 0) {
      return -1;
    }
    for (let index = regions.length - 1; index >= 0; index--) {
      const box: RegionBox = regions[index];
      const left: number = box.x * this.canvasW;
      const top: number = box.y * this.canvasH;
      const right: number = left + box.w * this.canvasW;
      const bottom: number = top + box.h * this.canvasH;
      if (x >= left && x <= right && y >= top && y <= bottom) {
        return index;
      }
    }
    return -1;
  }

  /** 点是否落在某个框的右下角「改大小」手柄上。 */
  private isOnHandle(index: number, x: number, y: number): boolean {
    const regions: RegionBox[] = this.currentRegions();
    if (index < 0 || index >= regions.length || this.canvasW <= 0 || this.canvasH <= 0) {
      return false;
    }
    const box: RegionBox = regions[index];
    const right: number = (box.x + box.w) * this.canvasW;
    const bottom: number = (box.y + box.h) * this.canvasH;
    return x >= right - HANDLE_SIZE - 2 && y >= bottom - HANDLE_SIZE - 2;
  }

  /** 手势开始：命中框 → 移动/改大小；空白处 → 新建。 */
  private handleGestureStart(event: GestureEvent): void {
    if (this.canvasW <= 0 || this.canvasH <= 0) {
      return;
    }
    const fingers = event.fingerList;
    if (fingers === undefined || fingers.length === 0) {
      return;
    }
    const x: number = fingers[0].localX;
    const y: number = fingers[0].localY;
    this.dragStartX = x;
    this.dragStartY = y;
    const index: number = this.hitRegionIndex(x, y);
    if (index >= 0) {
      const box: RegionBox = this.currentRegions()[index];
      this.dragIndex = index;
      this.dragBaseX = box.x;
      this.dragBaseY = box.y;
      this.dragBaseW = box.w;
      this.dragBaseH = box.h;
      this.dragMode = this.isOnHandle(index, x, y) ? DRAG_RESIZE : DRAG_MOVE;
      return;
    }
    // 空白处起手：拖拽新建（先显示虚线预览，松手才入账）
    this.dragIndex = -1;
    this.dragMode = DRAG_CREATE;
    this.dragCurX = x;
    this.dragCurY = y;
    this.dragging = true;
  }

  /** 手势移动：按模式翻译成归一化坐标。 */
  private handleGestureUpdate(event: GestureEvent): void {
    if (this.dragMode === DRAG_NONE) {
      return;
    }
    if (this.dragMode === DRAG_CREATE) {
      this.dragCurX = this.dragStartX + event.offsetX;
      this.dragCurY = this.dragStartY + event.offsetY;
      return;
    }
    const box: RegionBox = this.currentRegions()[this.dragIndex];
    if (box === undefined) {
      this.dragMode = DRAG_NONE;
      return;
    }
    if (this.dragMode === DRAG_MOVE) {
      const next: RegionBox = {
        x: this.dragBaseX + event.offsetX / this.canvasW,
        y: this.dragBaseY + event.offsetY / this.canvasH,
        w: this.dragBaseW,
        h: this.dragBaseH
      };
      this.state.updateRegion(this.state.current, this.dragIndex, next);
      return;
    }
    // DRAG_RESIZE：不小于 MIN_REGION_SIDE，避免缩成看不见的一条线
    const width: number = this.dragBaseW + event.offsetX / this.canvasW;
    const height: number = this.dragBaseH + event.offsetY / this.canvasH;
    const next: RegionBox = {
      x: this.dragBaseX,
      y: this.dragBaseY,
      w: width < MIN_REGION_SIDE ? MIN_REGION_SIDE : width,
      h: height < MIN_REGION_SIDE ? MIN_REGION_SIDE : height
    };
    this.state.updateRegion(this.state.current, this.dragIndex, next);
  }

  /** 手势结束：新建框归一化 + sanitize 后入账（太小/越界直接丢弃，不弹错）。 */
  private handleGestureEnd(event: GestureEvent): void {
    if (this.dragMode === DRAG_CREATE && this.dragging) {
      this.dragging = false;
      if (this.canvasW > 0 && this.canvasH > 0) {
        const left: number = Math.min(this.dragStartX, this.dragCurX);
        const top: number = Math.min(this.dragStartY, this.dragCurY);
        const raw: RegionBox = {
          x: left / this.canvasW,
          y: top / this.canvasH,
          w: Math.abs(this.dragCurX - this.dragStartX) / this.canvasW,
          h: Math.abs(this.dragCurY - this.dragStartY) / this.canvasH
        };
        const box: RegionBox | null = sanitizeRegion(raw);
        if (box !== null) {
          this.state.addRegion(this.state.current, box);
          this.refreshStats();
        }
      }
    }
    this.dragMode = DRAG_NONE;
    this.dragIndex = -1;
  }

  private removeRegionAt(index: number): void {
    if (this.state.removeRegion(this.state.current, index)) {
      this.refreshStats();
    }
  }

  /**
   * 区域填白（批次阶段 B 调用）：把第 pageIndex 页的框填成白色。
   *
   * ⚠ 填白会抹掉框内笔迹，这是**允许**的：原始页面截图已在阶段 A 落盘，
   * 框内内容随时可从附件原图查看；这里只是让送 OCR 的图不含框内内容。
   * 填白前把合成模式复位成 `source-over`，否则上一笔若是橡皮（`destination-out`）
   * 就会「填白变成擦成透明」。
   *
   * 填白后不需要手动刷新：`componentSnapshot.get` 前的 `preparePage` 会等一帧（80ms），
   * 画布重新绘制完成后再截图。
   */
  async maskPage(pageIndex: number, regions: RegionBox[]): Promise<void> {
    const slots: number[] = this.state.slots;
    if (pageIndex < 0 || pageIndex >= slots.length) {
      throw new Error(`第 ${pageIndex + 1} 页不存在，无法区域填白`);
    }
    const slot: number = slots[pageIndex];
    if (slot < 0 || slot >= this.contexts.length) {
      throw new Error(`第 ${pageIndex + 1} 页画布尚未就绪，无法区域填白`);
    }
    const context = this.contexts[slot];
    const rects: MaskRect[] = regionsToMaskRects(regions, context.width, context.height);
    context.save();
    context.globalCompositeOperation = 'source-over';
    context.fillStyle = '#FFFFFF';
    for (let index = 0; index < rects.length; index++) {
      const rect: MaskRect = rects[index];
      context.fillRect(rect.x, rect.y, rect.w, rect.h);
    }
    context.restore();
  }

  // ------------------------------------------------------------------ 视图

  /** 顶部页条：页码块（当前页高亮）+ 末尾「＋」加页块 + 当前页摘要。 */
  @Builder
  pageBar() {
    Row({ space: 8 }) {
      Scroll() {
        Row({ space: 6 }) {
          ForEach(
            this.state.slots,
            (slot: number, pageIndex: number) => {
              Text(`${pageIndex + 1}`)
                .width(36)
                .height(36)
                .fontSize(14)
                .textAlign(TextAlign.Center)
                .borderRadius(8)
                .backgroundColor(pageIndex === this.state.current ? $r('app.color.brand') : '#F1F3F5')
                .fontColor(pageIndex === this.state.current ? Color.White : $r('app.color.text_primary'))
                .fontWeight(pageIndex === this.state.current ? FontWeight.Bold : FontWeight.Normal)
                .onClick(() => {
                  if (this.state.jumpTo(pageIndex)) {
                    this.resetGestureState();
                    this.notifyParent();
                    this.refreshStats();
                  }
                })
            },
            (slot: number) => `page-slot-chip-${slot}`
          )
          Text('＋')
            .width(36)
            .height(36)
            .fontSize(18)
            .textAlign(TextAlign.Center)
            .borderRadius(8)
            .backgroundColor('#E8F1FF')
            .fontColor($r('app.color.brand'))
            .enabled(this.state.pages < this.state.maxPages)
            .opacity(this.state.pages < this.state.maxPages ? 1 : 0.4)
            .onClick(() => {
              if (this.state.addPage()) {
                this.resetGestureState();
                this.notifyParent();
                this.refreshStats();
              }
            })
        }
        .padding({ left: 1, right: 1 })
      }
      .scrollable(ScrollDirection.Horizontal)
      .scrollBar(BarState.Off)
      .height(40)
      .layoutWeight(1)
      .align(Alignment.Start)

      Text(`第 ${this.state.current + 1} 页 · ${this.strokeCount} 笔 · ${this.regionCount} 框`)
        .fontSize(11)
        .fontColor($r('app.color.text_secondary'))
    }
    .width('100%')
    .alignItems(VerticalAlign.Center)
  }

  /** 工具条第 1 行：5 种笔刷 chip。 */
  @Builder
  brushBar() {
    Scroll() {
      Row({ space: 6 }) {
        ForEach(
          BRUSHES,
          (spec: BrushSpec) => {
            Text(spec.label)
              .fontSize(12)
              .height(30)
              .padding({ left: 10, right: 10 })
              .borderRadius(8)
              .backgroundColor(
                this.tool === TOOL_BRUSH && this.brush === spec.kind ? $r('app.color.brand') : '#F1F3F5'
              )
              .fontColor(
                this.tool === TOOL_BRUSH && this.brush === spec.kind
                  ? Color.White
                  : $r('app.color.text_primary')
              )
              .onClick(() => {
                this.setBrush(spec.kind);
              })
          },
          (spec: BrushSpec) => `brush-${spec.kind}`
        )
      }
    }
    .scrollable(ScrollDirection.Horizontal)
    .scrollBar(BarState.Off)
    .width('100%')
    .height(32)
    .align(Alignment.Start)
  }

  /** 工具条第 2 行：粗细 5 档 + 颜色 5 色。 */
  @Builder
  sizeColorBar() {
    Row({ space: 8 }) {
      ForEach(
        PEN_WIDTHS,
        (width: number, index: number) => {
          Row() {
            Text('')
              .width(PEN_DOT_SIZES[index])
              .height(PEN_DOT_SIZES[index])
              .borderRadius(PEN_DOT_SIZES[index] / 2)
              .backgroundColor($r('app.color.text_primary'))
          }
          .width(PEN_DOT_SIZES[index] + 10)
          .height(26)
          .justifyContent(FlexAlign.Center)
          .borderRadius(6)
          .border({ width: this.penWidth === width ? 2 : 0, color: $r('app.color.brand') })
          .backgroundColor(this.penWidth === width ? '#E8F1FF' : '#F7F8FA')
          .opacity(this.isEraseMode() ? 0.5 : 1)
          .onClick(() => {
            this.penWidth = width;
            this.refreshStats();
          })
        },
        (width: number) => `pen-width-${width}`
      )
      Blank()
      ForEach(
        PEN_COLORS,
        (color: string) => {
          Text('')
            .width(22)
            .height(22)
            .borderRadius(4)
            .backgroundColor(color)
            .border({ width: this.penColor === color ? 2 : 0, color: $r('app.color.brand') })
            .onClick(() => {
              this.penColor = color;
              this.refreshStats();
            })
        },
        (color: string) => `pen-color-${color}`
      )
    }
    .width('100%')
    .height(30)
    .alignItems(VerticalAlign.Center)
  }

  /** 工具条第 3 行：橡皮 / 框选 / 撤销 / 重做 / 清空本页 + 当前提示。 */
  @Builder
  modeBar() {
    Column({ space: 4 }) {
      Scroll() {
        Row({ space: 8 }) {
          Button('橡皮')
            .height(30)
            .fontSize(12)
            .backgroundColor(this.isEraseMode() ? $r('app.color.brand') : '#F1F3F5')
            .fontColor(this.isEraseMode() ? Color.White : $r('app.color.text_primary'))
            .onClick(() => {
              this.setTool(TOOL_ERASER);
            })
          Button('框选')
            .height(30)
            .fontSize(12)
            .backgroundColor(this.isSelectMode() ? $r('app.color.brand') : '#F1F3F5')
            .fontColor(this.isSelectMode() ? Color.White : $r('app.color.text_primary'))
            .onClick(() => {
              this.setTool(TOOL_SELECT);
            })
          Button(`撤销(${this.undoSteps})`)
            .height(30)
            .fontSize(12)
            .backgroundColor('#EEF1F4')
            .fontColor($r('app.color.text_primary'))
            .enabled(this.undoSteps > 0)
            .opacity(this.undoSteps > 0 ? 1 : 0.4)
            .onClick(() => {
              this.onUndo();
            })
          Button('重做')
            .height(30)
            .fontSize(12)
            .backgroundColor('#EEF1F4')
            .fontColor($r('app.color.text_primary'))
            .enabled(this.redoAvailable)
            .opacity(this.redoAvailable ? 1 : 0.4)
            .onClick(() => {
              this.onRedo();
            })
          Button('清空本页')
            .height(30)
            .fontSize(12)
            .backgroundColor('#FDECEC')
            .fontColor('#C0392B')
            .onClick(() => {
              this.clearPage(this.state.current);
            })
        }
      }
      .scrollable(ScrollDirection.Horizontal)
      .scrollBar(BarState.Off)
      .width('100%')
      .height(32)
      .align(Alignment.Start)

      Text(this.modeHint())
        .fontSize(11)
        .fontColor(this.isSelectMode() ? '#B26A00' : $r('app.color.text_secondary'))
        .width('100%')
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  /** 当前工具的提示语。 */
  private modeHint(): string {
    if (this.isSelectMode()) {
      return '在画布上拖出一个矩形；框内内容不做 OCR，只保存原图';
    }
    if (this.isEraseMode()) {
      return '橡皮：擦掉笔迹（不会擦掉白底）';
    }
    return `${brushSpec(this.brush).label}：直接在画布上书写`;
  }

  /** 单个区域框：虚线框体 + 右下角改大小手柄 + 右上角删除按钮（手势统一在 overlay 上）。 */
  @Builder
  regionBox(box: RegionBox, index: number) {
    Stack() {
      Text('×')
        .width(DELETE_SIZE)
        .height(DELETE_SIZE)
        .fontSize(12)
        .textAlign(TextAlign.Center)
        .borderRadius(DELETE_SIZE / 2)
        .backgroundColor(Color.White)
        .fontColor('#C0392B')
        .border({ width: 1, color: REGION_STROKE })
        .position({ x: Math.max(0, box.w * this.canvasW - DELETE_SIZE - 2), y: 2 })
        .onClick(() => {
          this.removeRegionAt(index);
        })
      Text('')
        .width(HANDLE_SIZE)
        .height(HANDLE_SIZE)
        .backgroundColor(Color.White)
        .border({ width: 1, color: REGION_STROKE })
        .borderRadius(3)
        .position({
          x: Math.max(0, box.w * this.canvasW - HANDLE_SIZE - 2),
          y: Math.max(0, box.h * this.canvasH - HANDLE_SIZE - 2)
        })
        .hitTestBehavior(HitTestMode.None)
    }
    .width(box.w * this.canvasW)
    .height(box.h * this.canvasH)
    .position({ x: box.x * this.canvasW, y: box.y * this.canvasH })
    .border({ width: 1.5, color: REGION_STROKE, style: BorderStyle.Dashed })
    .backgroundColor(REGION_FILL)
    .borderRadius(4)
    .hitTestBehavior(HitTestMode.Transparent)
  }

  /** 切页/增删页时清掉进行中的手势与未完成的一笔。 */
  private resetGestureState(): void {
    this.drawingSlot = -1;
    this.activeStroke = null;
    this.dragMode = DRAG_NONE;
    this.dragging = false;
  }

  build() {
    Column({ space: 6 }) {
      this.pageBar()
      this.brushBar()
      this.sizeColorBar()
      this.modeBar()

      Stack() {
        ForEach(
          this.state.slots,
          (slot: number) => {
            Canvas(this.contexts[slot])
              .id(`${HANDWRITING_PAGE_ID_PREFIX}${slot}`)
              .width('100%')
              .height('100%')
              .backgroundColor(Color.White)
              .opacity(slot === this.activeSlot() ? 1 : 0)
              // 框选模式下画布不接收触摸（交给上面的 overlay）
              .hitTestBehavior(
                slot === this.activeSlot() && !this.isSelectMode() ? HitTestMode.Default : HitTestMode.None
              )
              .onReady(() => {
                this.initContext(slot);
              })
              .onTouch((event: TouchEvent) => {
                this.handleTouch(slot, event);
              })
          },
          (slot: number) => `page-slot-${slot}`
        )

        // ---- 框选 overlay：与笔迹 Canvas **兄弟节点**，永远不会进入 componentSnapshot 截图。
        // 关键字里带几何值：几何一变组件就重建，保证拖动/改大小每帧都能看到新位置；
        // 手势挂在这一层（自身不重建），所以手势不会被重建打断。
        Stack() {
          ForEach(
            this.currentRegions(),
            (box: RegionBox, index: number) => {
              this.regionBox(box, index)
            },
            (box: RegionBox, index: number) =>
              `region-${this.state.current}-${index}-${box.x}-${box.y}-${box.w}-${box.h}`
          )
          if (this.dragging) {
            Stack() {}
            .width(Math.abs(this.dragCurX - this.dragStartX))
            .height(Math.abs(this.dragCurY - this.dragStartY))
            .position({
              x: Math.min(this.dragStartX, this.dragCurX),
              y: Math.min(this.dragStartY, this.dragCurY)
            })
            .border({ width: 1.5, color: REGION_STROKE, style: BorderStyle.Dashed })
            .backgroundColor(REGION_FILL)
            .borderRadius(4)
            .hitTestBehavior(HitTestMode.None)
          }
        }
        .width('100%')
        .height('100%')
        .hitTestBehavior(this.isSelectMode() ? HitTestMode.Default : HitTestMode.None)
        .gesture(
          PanGesture()
            .onActionStart((event: GestureEvent) => {
              this.handleGestureStart(event);
            })
            .onActionUpdate((event: GestureEvent) => {
              this.handleGestureUpdate(event);
            })
            .onActionEnd((event: GestureEvent) => {
              this.handleGestureEnd(event);
            })
        )
      }
      .width('100%')
      .layoutWeight(1)
      .backgroundColor(Color.White)
      .borderRadius(12)
      .clip(true)
      .onAreaChange((_oldValue: Area, newValue: Area) => {
        // 画布 vp 尺寸：归一化坐标 = 触摸坐标 / 尺寸（换算处都做了除零保护）
        this.canvasW = newValue.width as number;
        this.canvasH = newValue.height as number;
      })

      Row({ space: 8 }) {
        Button('上一页')
          .height(32)
          .fontSize(12)
          .backgroundColor('#E8F1FF')
          .fontColor($r('app.color.brand'))
          .enabled(this.state.current > 0)
          .onClick(() => {
            if (this.state.prev()) {
              this.resetGestureState();
              this.notifyParent();
              this.refreshStats();
            }
          })
        Text(`${this.state.current + 1} / ${this.state.pages}`)
          .fontSize(13)
          .fontColor($r('app.color.text_primary'))
          .layoutWeight(1)
          .textAlign(TextAlign.Center)
        Button('下一页')
          .height(32)
          .fontSize(12)
          .backgroundColor('#E8F1FF')
          .fontColor($r('app.color.brand'))
          .enabled(this.state.current < this.state.pages - 1)
          .onClick(() => {
            if (this.state.next()) {
              this.resetGestureState();
              this.notifyParent();
              this.refreshStats();
            }
          })
      }
      .width('100%')

      Row({ space: 8 }) {
        Button('清空本页框')
          .layoutWeight(1)
          .height(32)
          .fontSize(12)
          .backgroundColor('#FFF3E0')
          .fontColor('#B26A00')
          .enabled(this.regionCount > 0)
          .opacity(this.regionCount > 0 ? 1 : 0.4)
          .onClick(() => {
            this.state.setRegions(this.state.current, []);
            this.refreshStats();
          })
        Button('删除本页')
          .layoutWeight(1)
          .height(32)
          .fontSize(12)
          .backgroundColor('#FDECEC')
          .fontColor('#C0392B')
          .enabled(this.state.pages > 1)
          .opacity(this.state.pages > 1 ? 1 : 0.4)
          .onClick(() => {
            this.removeCurrentPage();
          })
      }
      .width('100%')
    }
    .width('100%')
    .height('100%')
  }
}
