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
 * 2026-11-16 尺寸定版（**按屏比例自适应**，详见 `model/toolbarMetrics.ts`）：
 * - 上面那些写死的 48 / 72 / 44 / 40 全部作废：工具条控件的**宽/高/间距/图标/字号**改为从
 *   `toolbarMetrics(视口宽, 视口高, 横屏?)` 取（竖屏 `barThickness`=顶部条高度、横屏=rail 宽度）；
 * - 分页区**放宽**：`−`/`+`、`‹`/`›` 每半 ≥44vp、`1/1` 格 ≥64vp、格间距 = `max(8vp, metrics.gap)`；
 * - 放不下就折行、**不压缩控件**：竖屏顶部条一屏排完 9 项，极窄屏折成两行；
 *   横屏 rail 中段竖向 Scroll（「完成」永远固定）；
 * - 页面侧只读派生方法（`barThickness()/itemSize()/controlGap()/iconSize()/toolbarFontSize()`），
 *   两套布局的组件树结构保持恒定。
 *
 * 2026-11-18 真机缺陷修复（用户报的三条，见 `docs/UI-DESIGN.md` §9）：
 * - 竖屏顶部条**删掉横向 Scroll**（工具项被滚出屏幕 = 用户以为按钮没了），9 项一屏排完，
 *   极窄屏（<640vp 或实算放不下）折成**两行**，绝不用滚动；
 * - 「仅手写笔输入」开关从设置页搬到**笔迹面板「更多」**二级菜单，切换即落盘并立刻生效；
 * - 撤销/重做按钮改成 `Row` + `.onClick`（不是裸 `Text`），禁用时仍可点并 toast 说明，
 *   `onStatsChange → touchUi()` 保证撤销栈一变工具条就重建。
 *
 * 布局不用 `if/else` 切横竖屏（会重建 `HandwritingPager`，画布已画的像素会丢）：
 * rail 宽度、顶部条高度随 `landscape` 变化，组件树结构保持恒定。
 */
import { promptAction, router } from '@kit.ArkUI';
import { image } from '@kit.ImageKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { photoAccessHelper } from '@kit.MediaLibraryKit';
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
import { draftStore } from '../services/draftStore';
import { settingsStore } from '../services/settingsStore';
import { localDateKey } from '../common/date';
import { describeError, scheduleStore } from '../services/scheduleStore';
import { BRUSHES, brushSpec } from '../model/brush';
import type { BrushKind, BrushSpec } from '../model/brush';
import { PEN_WIDTHS, PEN_COLORS } from '../model/strokeHistory';
// 色值收编（2026-11-18）：字面色一律走资源令牌；Canvas 内绘制色走 `CANVAS_PAINTS`
// （Canvas 的 fillStyle/strokeStyle 不收 `$r()` 资源对象）；被静态测试钉住的字面量走
// `DARK_FALLBACK` 取深色档。判定规则见 `model/theme.ts` 与 `docs/UI-DESIGN.md` §8。
import { CANVAS_PAINTS, DARK_FALLBACK } from '../model/theme';
import { isSystemDark } from '../common/themeApply';
import type { Stroke } from '../model/strokeHistory';
import {
  DRAFT_KEY_DEFAULT,
  DRAFT_MAX_BYTES,
  DRAFT_MAX_PAGES,
  DRAFT_VERSION,
  fitDraftToLimits,
  fromDraftBoxes,
  fromDraftStrokes,
  hasContent,
  isUsableCanvas,
  parseDraft,
  sanitizeDraftKey,
  toDraftBoxes,
  toDraftStrokes
} from '../model/draft';
import type { DraftDoc, DraftPage } from '../model/draft';
import { DIVIDER, FONT, LINE_HEIGHT, RADIUS, SPACING, TOUCH_MIN, isLandscapeSize } from '../common/uiTokens';
import { toolbarMetrics } from '../model/toolbarMetrics';
import type { ToolbarMetrics } from '../model/toolbarMetrics';
import type { RegionBox } from '../model/types';
import type { Attachment } from '../model/types';
import { IMAGE_MAX_BYTES, IMAGE_MAX_SIDE, TABLE_DEFAULT_LINES, addEmptyPage, bringToFront, clampTableLines, countObjects, deleteObject, findObject, hitTest, imageEntryName, imageRectFor, makePageObject, moveObject, objectsOfPage, removePageObjects, replaceObject, resizeObject, serializePageObjects, setObjectsOfPage, tableRect } from '../model/pageObjects';
import type { NormalizedRect, ObjectsByPage, PageObject } from '../model/pageObjects';
import { canOcrTable, objectsToMask, tableOcrEnabled, tablePlaceholder } from '../model/tableOcr';
import { imageObjectFromSelection } from '../model/pageObjects';
import type { SelectionImagePlan } from '../model/pageObjects';
import type { TableCellTask, TableOcrResult } from '../ocr/OcrBatchManager';
import { objectPlaceholder, sortObjectsByPosition } from '../model/pageObjects';
import type { SavedImage } from '../services/attachmentStore';

/** `archiveDay` 的入参形状（显式接口：ArkTS 禁止内联对象类型）。 */
interface ArchivePage {
  sha256: string;
  pageIndex: number;
}

/** 插入图片的 JPEG 质量：先 90（清晰），体积仍超 5MB 再降到 60。 */
const IMAGE_JPEG_QUALITY: number = 90;
const IMAGE_JPEG_LOW_QUALITY: number = 60;

/**
 * 工具条尺寸（2026-11-16 定版）：**整页不再写死 48 / 72 / 44 / 40**。
 *
 * 唯一来源是 `model/toolbarMetrics` 的 `toolbarMetrics(vw, vh, landscape)`：
 * - 竖屏：`barThickness` = 顶部条高度（48~64vp）、`itemSize` = 控件边长（40~64vp）；
 * - 横屏：`barThickness` = rail 宽度（56~84vp）、`itemSize` = 控件边长（40~72vp）；
 * - `gap` / `iconSize` / `fontSize` 由 `itemSize` 派生（0.15 / 0.5 / 0.32，各带上下限）。
 *
 * 页面侧一律通过派生方法取值（`barThickness()` / `itemSize()` / `controlGap()` /
 * `iconSize()` / `toolbarFontSize()` / `pagerCellWidth()` / `pagerLabelWidth()`），
 * 这样「屏变大 → 控件变大」只有一处系数可调，也不会再出现某个控件漏改的写死值。
 */
/** 横屏 rail 底色（比画布浅一点，与内容区分开；不用投影）。 */
const RAIL_BG: string = '#F7F9FB';
/**
 * 「完成」最小宽度（vp）——定版要求 ≥64vp（真机上曾被省略号截断）。
 *
 * 实际宽度 = `max(该下限, metrics.itemSize)`：小屏守住 64、大屏与控制齐平。
 */
const FINISH_MIN_WIDTH: number = 64;
/**
 * 分页区单元格的硬下限（vp）：`−`/`+`、`‹`/`›` **每半边 ≥44vp**，
 * `1/1` 页码格 ≥64vp（用户定版：分页区要「放宽」，不许再压成 36vp 的小格）。
 */
const PAGER_HALF_MIN: number = 44;
const PAGER_LABEL_MIN: number = 64;
/** 控件间距的硬下限（vp）：分页区三个单元格挨太近会误触。 */
const GAP_MIN: number = 8;
/**
 * 竖屏顶部条「一屏一行」的宽度下限（vp，缺陷 3）。
 *
 * 低于它（手机竖屏 / 分屏）不可能把 9 项挤进一行，**直接折成两行**；
 * 高于它还要再按 `topBarRequiredWidth()` 实算一次，实算放不下才折行。
 * 任何情况下都**不许再用横向 `Scroll`**（真机上工具按钮被滚走 = 用户找不到）。
 */
const TOP_BAR_SINGLE_ROW_MIN: number = 640;

/**
 * 工具条单元格 id：`buttonCell(id, layout, width)` 的语义键。
 *
 * 2026-11-18 重构（A 线）：「退出/笔迹/橡皮/手动框/插入/↶/↷/完成」原先在 `topBar` 与
 * `railBar` 里各写一套 builder（8 对近似重复，改一处必须同步另一处）；现在语义只有一份
 * （`cellLabel` / `cellTextColor` / `cellBackground` / `onCellTap`），两个布局壳只决定
 * 「怎么排」与「宽度从哪儿来」。
 */
const CELL_EXIT: string = 'exit';
const CELL_INK: string = 'ink';
const CELL_ERASER: string = 'eraser';
const CELL_SELECT: string = 'select';
const CELL_INSERT: string = 'insert';
const CELL_UNDO: string = 'undo';
const CELL_REDO: string = 'redo';
const CELL_FINISH: string = 'finish';
/**
 * 布局壳标识（只有两个）：竖屏顶部条的单元格宽度**按内容自适应**，
 * 横屏 rail 的单元格**铺满 rail 宽**（`railWidth()`）——几何差异只在这里分叉。
 */
const LAYOUT_PORTRAIT: string = 'portrait';
const LAYOUT_RAIL: string = 'rail';
/** 二级面板每行高度（vp）。 */
const MENU_ROW_HEIGHT: number = 44;
/** 二级面板每项最小宽度（vp）——用户定版 ≥140。 */
const MENU_MIN_WIDTH: number = 140;
/** 面板里粗细圆点的直径（与 `PEN_WIDTHS` 一一对应，定版 4/7/10/13/16）。 */
const SIZE_DOTS: number[] = [4, 7, 10, 13, 16];
/** 面板里颜色块的边长（vp）。 */
const SWATCH: number = 28;
/** 颜色名（与 `PEN_COLORS` 顺序一一对应）。 */
const COLOR_LABELS: string[] = ['黑', '红', '蓝', '绿', '橙'];
/** 二级面板标识。 */
/** 「笔迹设置」面板：笔形 + 粗细合在一个浮层里（用户需求：合并成一个二级菜单）。 */
const PANEL_INK: string = 'ink';
const PANEL_COLOR: string = 'color';
/** 「插入」二级菜单：图片 / 表格（不为它们各加一个 rail 按钮）。 */
const PANEL_INSERT: string = 'insert';
/** 笔迹设置面板最小宽度（vp）——用户定版 ≥260（三段：笔形 / 粗细 / 颜色）。 */
const INK_PANEL_MIN_WIDTH: number = 260;
/** 笔迹设置面板里 chip / 档位格的触控高度（vp）——定版 ≥40。 */
const CHIP_HEIGHT: number = 40;
/** 首次引导存储（不建设置项，只存一个布尔标记）。 */
const TIP_STORE: string = 'handwriting';
const TIP_KEY: string = 'handwriting.tipShown';
/** 两步删除确认的阶段。 */
const CONFIRM_NONE: number = 0;
const CONFIRM_FIRST: number = 1;
const CONFIRM_SECOND: number = 2;
/** 抬笔后自动保存草稿的防抖时间（ms）。 */
const DRAFT_SAVE_DEBOUNCE_MS: number = 2000;
/** 草稿提示文案（用户可见，别写内部术语）。 */
const DRAFT_TOAST_RESTORED: string = '已恢复上次未完成的手迹';
const DRAFT_TOAST_TOO_LARGE: string = '草稿过大，已只保留前 10 页';
const DRAFT_TOAST_SAVE_FAILED: string = '暂存失败，退出后可能丢失这次手迹';

/** 归一化坐标点（拖拽起点、触摸换算共用，避免 ArkTS 禁止的"对象字面量当类型"）。 */
interface NormPoint {
  nx: number;
  ny: number;
}

@Entry
@Component
struct Handwriting {
  /**
   * 与手写板组件共享的分页/书写状态（工具条直接改 `state` 里的 brush/penWidth/penColor/tool，
   * 画布读同一份；撤销/重做由画布组件注册的实现转调）。
   */
  @State pagerState: HandwritingPagerState = new HandwritingPagerState();
  // ⚠ 不在这里维护 pageCount / currentPage / undoSteps / redoAvailable 副本：
  // 它们是 `HandwritingPagerState`（@Observed）的字段，**唯一真相源**在 pagerState 里。
  // 过去父页面持有一份 @State 副本，只靠 onStateChange 同步 —— 插页/删页走的是
  // `state.insertPageAfterCurrent()/removePage()`，不会触发那个回调，于是页码停在 1/1、
  // `−` 的 enabled 也停在旧值（删除功能直接不可用，真机 P0）。现改为 build 里直接读 pagerState。
  /** 当前展开的二级面板（'' = 全关）。 */
  @State panel: string = '';
  /** 删除确认阶段（0/1/2）。 */
  @State confirmStage: number = CONFIRM_NONE;
  /**
   * 当前页的可调对象（框 / 图片 / 表格，共用一套交互）。
   *
   * **B1 已知限制**：这里是「当前页一份列表」，翻页时不清空也不按页保存 ——
   * 按页持久化（以 `PageBook` 的稳定页 id 为键）会在 B2 与 `pageObjects` 写进 JSONL 时一起做，
   * 避免现在改数据形状把已通过的模型测试推翻。
   */
  @State objectsByPage: ObjectsByPage = {};
  /** 「插入 → 表格」面板里的行列选择（1..10，默认 3×3）。 */
  /** OCR 进度文案（表格逐格识别时显示在状态行）。 */
  @State ocrProgress: string = '';
  @State insertRows: number = TABLE_DEFAULT_LINES;
  @State insertCols: number = TABLE_DEFAULT_LINES;
  /** 当前选中的对象 id（'' = 没选中）；选中态画品牌色描边 + 手柄 + ×。 */
  @State selectedObjectId: string = '';
  /** 对象层尺寸（vp，onAreaChange 写入；归一化坐标换算用）。 */
  private objectW: number = 0;
  private objectH: number = 0;
  /** 对象层画布上下文与图片位图缓存（B2 阶段用选图结果填充）。 */
  private objectCtx: CanvasRenderingContext2D = new CanvasRenderingContext2D(new RenderingContextSettings(true));
  private objectImages: Map<string, image.PixelMap> = new Map<string, image.PixelMap>();
  /** 拖拽中的对象与起始点（手势状态，不需要触发重绘）。 */
  private dragObject: PageObject | null = null;
  private dragPart: string = 'body';
  private dragStart: NormPoint = { nx: 0, ny: 0 };
  /** 是否横屏（由 `onAreaChange` 的宽高比较得出，不依赖 mediaquery）。 */
  @State landscape: boolean = false;
  /** 页面尺寸（vp）：浮层定位用。 */
  @State pageW: number = 0;
  @State pageH: number = 0;
  /** 首次引导是否可见。 */
  @State tipVisible: boolean = false;
  /**
   * 重绘信号（值本身无意义）：变更 pagerState 后 bump 一次，保证本页 build() 重跑。
   * 之所以还要它：`@Observed` 字段变化在个别 ArkUI 版本上不会稳定触发父页面重绘，
   * 而页码/`−` 的可用性必须立刻反映真实页数（真机 P0：插页后页码停在 1/1、删除按钮不可用）。
   */
  @State uiTick: number = 0;
  @State busy: boolean = false;
  /**
   * 「仅手写笔输入」（缺陷 1/2 的开关值，页面侧镜像）。
   *
   * 读取路径：`aboutToAppear → settingsStore.load() → penOnlyInput`；
   * 写入路径：笔迹面板「更多 → 仅手写笔输入」→ `savePenOnlyInput()` →
   * ① 立刻写 `pagerState.setPenOnlyInput()`（画布下一次触摸即生效，不用退出重进）
   * ② `settingsStore.save({ penOnlyInput })` 落盘。
   */
  @State penOnlyInput: boolean = false;
  /** 笔迹面板的二级菜单（「更多 ▸」）是否展开。 */
  @State inkMoreOpen: boolean = false;
  /** 上一次打印过的「撤销/重做可用性」组合（只在变化时打日志 + 触发重建）。 */
  private lastHistoryKey: string = '';
  private manager: OcrBatchManager | null = null;
  private tipLoaded: boolean = false;
  /** 草稿键：编辑已有记录 = recordId，新建 = new-<时间戳>（由 Edit 页路由参数传入）。 */
  private draftKey: string = DRAFT_KEY_DEFAULT;
  /** 防抖定时器 id（-1 = 没有待触发的保存）。 */
  private draftTimer: number = -1;
  /** 已读到但还没落到画布上的草稿（等画布量出尺寸再按归一化重投影）。 */
  private pendingDraft: DraftDoc | null = null;
  /** 是否已经完成过一次草稿恢复（避免每次 onAreaChange 都重放）。 */
  private draftApplied: boolean = false;
  /**
   * 「完成」且 OCR 成功后置 true：本页不再写草稿。
   *
   * 否则 `discardDraft()` 删掉草稿后，紧接着的 `aboutToDisappear()` 又会从画布
   * 重新生成一份存回去 —— 用户下次进来就会看到「已经识别过了的手迹」还在。
   */
  private draftClosed: boolean = false;

  // ------------------------------------------------------------------ 工具条尺寸（按视口比例自适应）

  /**
   * 当前视口 → 一组工具条尺寸（纯函数在 `model/toolbarMetrics`，Node 单测覆盖）。
   *
   * `pageW/pageH` 由 `build()` 的 `onAreaChange` 写入、`landscape` 由宽高比较得出；
   * 这三个 @State 一变，所有读 `metrics()` 的控件就跟着重算（不依赖 mediaquery）。
   */
  private metrics(): ToolbarMetrics {
    return toolbarMetrics(this.pageW, this.pageH, this.landscape);
  }

  /** 工具条「厚度」：竖屏 = 顶部条高度；横屏 = rail 宽度（vp）。 */
  private barThickness(): number {
    return this.metrics().barThickness;
  }

  /** 单个控件的方形边长（vp）：控件高度与最小宽度都用它。 */
  private itemSize(): number {
    const metrics: ToolbarMetrics = this.metrics();
    if (this.landscape) {
      return metrics.itemSize;
    }
    // 竖屏兜底：控件不能比顶部条还高（极端方形屏会出现 barThickness < itemSize）
    return Math.min(metrics.itemSize, metrics.barThickness);
  }

  /** 控件间距（vp）：取 `metrics.gap`，但**不小于 8vp**（`SPACING.sm`，分页区三格挨太近会误触）。 */
  private controlGap(): number {
    const metrics: ToolbarMetrics = this.metrics();
    return Math.max(SPACING.sm, metrics.gap);
  }

  /** 自绘图标的基准尺寸（vp）。 */
  private iconSize(): number {
    return this.metrics().iconSize;
  }

  /** 工具条文字字号（fp）。 */
  private toolbarFontSize(): number {
    return this.metrics().fontSize;
  }

  /**
   * 横屏 rail 的实际宽度（vp）。
   *
   * 主值取 `metrics.barThickness`（56~84），但 rail 里还塞着**分页区三个单元格**：
   * `[−|+]` / `[‹|›]` 每半 ≥44vp ⇒ 单元格 ≥89vp，`1/1` ≥64vp。窄于这个下限时宁可 rail 宽一点，
   * 也不压缩分页区（用户定版「不要压缩控件」）；同时兜住「手动框」这类 3 字标签的排版宽度。
   */
  private railWidth(): number {
    const metrics: ToolbarMetrics = this.metrics();
    const forThreeLabels: number = metrics.fontSize * 3 + SPACING.xs;
    let width: number = Math.max(metrics.barThickness, forThreeLabels);
    width = Math.max(width, this.pagerCellWidth());
    return Math.max(width, this.pagerLabelWidth());
  }

  /** 横屏 rail 容器宽度（含 1vp 分割线；竖屏为 0）。 */
  private railTotalWidth(): number {
    return this.landscape ? this.railWidth() + DIVIDER : 0;
  }

  /** 竖屏顶部条容器高度（含 1vp 分割线；横屏为 0）。 */
  private topBarTotalHeight(): number {
    return this.landscape ? 0 : this.topBarHeight() + DIVIDER;
  }

  /**
   * 竖屏顶部条内容高度（vp，不含分割线）：一行 = `barThickness`，两行 = 2 × `barThickness`。
   *
   * 折行后**必须把高度一起放大**：`build()` 里装工具条的 `Column` 带 `clip(true)`，
   * 高度不变的话第二行会被裁掉（这正是「工具项看不见」的另一种死法）。
   */
  private topBarHeight(): number {
    return this.topBarTwoRows() ? 2 * this.barThickness() : this.barThickness();
  }

  /**
   * 竖屏顶部条是否折成**两行**（缺陷 3 的唯一判据；横屏 rail 不参与）。
   *
   * 1. 极窄屏（`pageW < TOP_BAR_SINGLE_ROW_MIN` = 640vp）：9 项不可能一行放下 → 直接两行；
   * 2. 否则按**真实控件宽度**实算（`topBarRequiredWidth()`），超过可用宽度才折行。
   *
   * 屏幕尺寸还没量出来（`pageW === 0`）时先按一行画，`onAreaChange` 一到就重算 —— 不猜设备。
   */
  private topBarTwoRows(): boolean {
    if (this.landscape) {
      return false;
    }
    if (this.pageW <= 0) {
      return false;
    }
    if (this.pageW < TOP_BAR_SINGLE_ROW_MIN) {
      return true;
    }
    return this.topBarRequiredWidth() > this.pageW;
  }

  /**
   * 竖屏一行放下 **9 项**所需的宽度（vp）：控件宽度之和 + 8 个间距 + 两侧 padding。
   *
   * 9 项 = 退出 / 笔迹 / 橡皮 / 手动框 / 插入 / ↶ / ↷ / 分页组 / 完成。
   * 「笔迹」比 `itemSize` 宽（文字 + 色块 + ▾ 三段），按两侧 padding 兜住。
   */
  private topBarRequiredWidth(): number {
    // 8 个单控件里，只有「完成」用 finishWidth()（≥64vp），其余 7 个都按 itemSize 兜
    const singles: number = 7 * this.itemSize() + this.finishWidth();
    const brushExtra: number = 2 * SPACING.sm;
    const gaps: number = 8 * this.controlGap();
    return singles + brushExtra + this.pagerTotalWidth() + gaps + 2 * SPACING.sm;
  }

  /**
   * 分页区每个「半边」（`−` / `+` / `‹` / `›`）的宽度（vp）：**≥44vp**。
   *
   * 竖屏顶部条宽裕，跟着 `itemSize` 一起放大；横屏 rail 竖向空间宝贵，守住 44 下限即可，
   * 否则 rail 会被分页区撑得过宽。
   */
  private pagerHalfWidth(): number {
    if (this.landscape) {
      return PAGER_HALF_MIN;
    }
    const metrics: ToolbarMetrics = this.metrics();
    return Math.max(PAGER_HALF_MIN, metrics.itemSize * 0.75);
  }

  /** 分页区 `[−|+]` / `[‹|›]` 单元格宽度（vp）：两半 + 中间 1vp 分割线。 */
  private pagerCellWidth(): number {
    return 2 * this.pagerHalfWidth() + DIVIDER;
  }

  /** 分页区 `1/1` 页码格宽度（vp）：**≥64vp**。 */
  private pagerLabelWidth(): number {
    const metrics: ToolbarMetrics = this.metrics();
    return Math.max(PAGER_LABEL_MIN, metrics.itemSize * 1.1);
  }

  /** 分页区「三格 + 两个间距」的总宽（vp，竖屏判断放不放得下用）。 */
  private pagerTotalWidth(): number {
    return 2 * this.pagerCellWidth() + this.pagerLabelWidth() + 2 * this.controlGap();
  }

  /**
   * 竖屏顶部条里，分页组是否**固定在横向 Scroll 之外**（永远可见）。
   *
   * ⚠ 2026-11-18 起这条判断已作废：横向 Scroll 整体删除（缺陷 3），9 项要么一行、
   * 要么两行（`topBarTwoRows()`），分页组永远在可视区内。保留此注释只为说明历史原因。
   */

  /** 「完成」按钮宽度（vp）：≥64vp，且不小于控件边长。 */
  private finishWidth(): number {
    return Math.max(FINISH_MIN_WIDTH, this.itemSize());
  }

  aboutToAppear(): void {
    this.draftKey = this.resolveDraftKey();
    this.loadTipFlag();
    // 「仅手写笔输入」：从 settingsStore 读一次（笔迹面板里改，退出重进也保持）
    this.loadPenOnlyInput();
    // 画布尺寸变化/落笔/改框都通过 state 的钩子回调本页（父页面拿不到子组件实例）
    this.pagerState.dirtyImpl = () => {
      this.scheduleDraftSave();
      // 抬笔后撤销按钮要立刻变成可点（缺陷 4b：以前只改 @Observed 字段，
      // 个别 ArkUI 版本不重建父页面，按钮就一直是「变灰但点不动」）
      this.touchUi();
    };
    this.pagerState.canvasReadyImpl = () => {
      this.applyPendingDraft();
    };
    this.restoreDraft();
  }

  aboutToDisappear(): void {
    this.clearDraftTimer();
    // 兜底再存一次（正常情况下退出按钮/返回键已经存过了）
    this.saveDraftNow(false);
    if (this.manager !== null) {
      this.manager.cancel();
      this.manager = null;
    }
  }

  /** 系统返回 / 侧滑返回：与「‹」按钮走同一条路径（先存草稿再放行）。 */
  onBackPress(): boolean {
    this.clearDraftTimer();
    this.saveDraftNow(false);
    // 返回 false = 仍按系统默认行为退出页面（此时草稿已落盘）
    return false;
  }

  // ------------------------------------------------------------------ 仅手写笔输入（缺陷 1 / 2）

  /**
   * 读「仅手写笔输入」并铺到画布（进入页面时一次）。
   *
   * 读失败不阻塞手写：日志记一笔、按默认「手指 + 笔都能写」跑（旧数据缺键也是 false）。
   */
  private async loadPenOnlyInput(): Promise<void> {
    try {
      const settings = await settingsStore.load(getContext(this) as common.UIAbilityContext);
      this.penOnlyInput = settings.penOnlyInput === true;
    } catch (error) {
      console.error(`[hw] penOnly load failed, fallback=false: ${describeError(error)}`);
      this.penOnlyInput = false;
    }
    // 画布用的是 pagerState 里的同一份值（@Observed），这里同步过去即立刻生效
    this.pagerState.setPenOnlyInput(this.penOnlyInput);
    console.info(`[hw] penOnly=${this.penOnlyInput ? 1 : 0} source=settings`);
  }

  /**
   * 笔迹面板「更多 → 仅手写笔输入」切换：**先作用于画布、再落盘**。
   *
   * 先作用于画布是刻意的：落盘失败也不该让用户「拨了开关却还能用手指写」。
   * 落盘失败回退界面状态并 toast（与设置页的处理一致）。
   */
  private async savePenOnlyInput(enabled: boolean): Promise<void> {
    const next: boolean = enabled === true;
    this.penOnlyInput = next;
    this.pagerState.setPenOnlyInput(next);
    this.touchUi();
    console.info(`[hw] penOnly=${next ? 1 : 0} source=panel`);
    try {
      await settingsStore.save({ penOnlyInput: next }, getContext(this) as common.UIAbilityContext);
    } catch (error) {
      this.penOnlyInput = !next;
      this.pagerState.setPenOnlyInput(!next);
      this.touchUi();
      promptAction.showToast({ message: `保存「仅手写笔输入」失败：${describeError(error)}`, duration: 4000 });
      console.error(`[hw] penOnly save failed: ${describeError(error)}`);
    }
  }

  /** 二级菜单「更多 ▸」开合（笔迹面板底部；展开后才出现开关，面板默认只有笔形/粗细/颜色三段）。 */
  private toggleInkMore(): void {
    this.inkMoreOpen = !this.inkMoreOpen;
    console.info(`[hw] ink more open=${this.inkMoreOpen ? 1 : 0} panel=open`);
  }

  // ------------------------------------------------------------------ 撤销 / 重做（缺陷 4）

  /**
   * 撤销/重做可用性变化（`HandwritingPager.onStatsChange` 回调）→ 让工具条重建。
   *
   * 为什么还要重建：`undoSteps / redoAvailable` 是 `@Observed` 字段，但个别 ArkUI 版本
   * 不会因此重跑父页面 `build()`，于是按钮停在旧状态（真机「↶ 点不动 / 变灰了也不弹提示」）。
   * 子组件在 `aboutToAppear` 里也会回调一次（那一刻父页面正在 build），
   * 所以统一延到下一拍再写 `@State`，避免「build 期间改状态」。
   */
  private onHistoryStats(undoSteps: number, redoAvailable: boolean): void {
    const key: string = `${undoSteps > 0 ? 1 : 0}${redoAvailable ? 1 : 0}`;
    if (key === this.lastHistoryKey) {
      return;
    }
    this.lastHistoryKey = key;
    console.info(`[hw] history undo=${undoSteps} redo=${redoAvailable ? 1 : 0}`);
    setTimeout(() => {
      this.touchUi();
    }, 0);
  }

  /**
   * 撤销 / 重做点击。
   *
   * 禁用态（没有可撤销/可重做的笔画）**仍然可点**：点下去 toast 说明原因，
   * 而不是让按钮变成「看着能点、点了没反应」（缺陷 4b）。
   * 点击后 `touchUi()`：撤销/重做会改可用性，工具条必须立刻跟着变。
   */
  private onHistoryTap(kind: string, available: boolean): void {
    if (!available) {
      promptAction.showToast({
        message: kind === 'redo' ? '没有可重做的笔画' : '没有可撤销的笔画',
        duration: 1600
      });
      return;
    }
    if (kind === 'undo') {
      this.pagerState.applyUndo();
    } else {
      this.pagerState.applyRedo();
    }
    this.touchUi();
  }

  // ------------------------------------------------------------------ 草稿（退出暂存 / 再进恢复）

  /**
   * 解析 draftKey：优先路由参数 `draftKey`，其次 `AppStorage['handwriting.draftKey']`，都没有用默认键。
   *
   * Edit 页只加了一个传参（`router.pushUrl({ url, params: { draftKey } })`），
   * 编辑已有记录传 recordId、新建传 `new-<时间戳>`，同一次编辑会话内保持不变。
   */
  private resolveDraftKey(): string {
    try {
      const params: Record<string, string> = router.getParams() as Record<string, string>;
      if (params !== undefined && params !== null) {
        const fromRoute: string = params['draftKey'];
        if (typeof fromRoute === 'string' && fromRoute.length > 0) {
          return sanitizeDraftKey(fromRoute);
        }
      }
    } catch {
      // 取不到路由参数不算错，用下面的兜底
    }
    const fromStorage: string | undefined = AppStorage.get<string>('handwriting.draftKey');
    if (fromStorage !== undefined && fromStorage.length > 0) {
      return sanitizeDraftKey(fromStorage);
    }
    return DRAFT_KEY_DEFAULT;
  }

  /** 把当前分页状态打包成草稿（笔迹点在这里归一化）。 */
  private buildDraftDoc(): DraftDoc | null {
    const w: number = this.pagerState.canvasW;
    const h: number = this.pagerState.canvasH;
    if (!isUsableCanvas(w, h)) {
      return null;
    }
    const pages: DraftPage[] = [];
    const count: number = this.pageTotal();
    for (let index = 0; index < count; index++) {
      const strokes: Stroke[] = this.pagerState.history.strokesAt(index);
      const ids: string[] = this.pagerState.pageIds;
      pages.push({
        id: index < ids.length ? ids[index] : `p${index + 1}`,
        strokes: toDraftStrokes(strokes, w, h),
        boxes: toDraftBoxes(this.pagerState.regionsAt(index))
      });
    }
    return {
      version: DRAFT_VERSION,
      draftKey: this.draftKey,
      canvas: { w: w, h: h },
      current: this.pageIndex(),
      pages: pages,
      updatedAt: Date.now()
    };
  }

  /**
   * 立即把草稿写盘（同步，几百 KB 级别）。
   *
   * - 没有内容就不写（避免留下一份空草稿把下次进入搞成「恢复了空白」）；
   * - 超 10 页 / 2MB 由 `fitDraftToLimits` 裁掉多余页并 toast 一次；
   * - `notifyFailure = true` 时失败才 toast（退出路径上静默，不挡用户离开）。
   */
  private saveDraftNow(notifyFailure: boolean): void {
    if (this.draftClosed) {
      return;
    }
    const doc: DraftDoc | null = this.buildDraftDoc();
    if (doc === null || !hasContent(doc)) {
      return;
    }
    const encoded = fitDraftToLimits(doc, DRAFT_MAX_PAGES, DRAFT_MAX_BYTES);
    if (encoded.trimmed) {
      promptAction.showToast({ message: DRAFT_TOAST_TOO_LARGE, duration: 3000 });
    }
    try {
      draftStore.saveDraftSync(this.draftKey, encoded.json);
      console.info(`[hw] draft saved key=${this.draftKey} pages=${encoded.pages} bytes=${encoded.bytes}`);
    } catch (error) {
      console.error(`[hw] draft save failed: ${describeError(error)}`);
      if (notifyFailure) {
        promptAction.showToast({ message: DRAFT_TOAST_SAVE_FAILED, duration: 4000 });
      }
    }
  }

  /** 安排一次防抖保存（抬笔 2s 后、或页/框变化后触发）。 */
  private scheduleDraftSave(): void {
    this.clearDraftTimer();
    this.draftTimer = setTimeout(() => {
      this.draftTimer = -1;
      this.saveDraftNow(true);
    }, DRAFT_SAVE_DEBOUNCE_MS);
  }

  private clearDraftTimer(): void {
    if (this.draftTimer !== -1) {
      clearTimeout(this.draftTimer);
      this.draftTimer = -1;
    }
  }

  /** 进入页面时读草稿：有就等画布就绪后恢复（归一化重投影），坏文件直接删掉。 */
  private async restoreDraft(): Promise<void> {
    try {
      await scheduleStore.ensureReady(getContext(this) as common.UIAbilityContext);
    } catch (error) {
      console.error(`[hw] draft restore skipped: ${describeError(error)}`);
      return;
    }
    let text: string = '';
    try {
      text = draftStore.readDraftSync(this.draftKey);
    } catch (error) {
      console.error(`[hw] draft read failed: ${describeError(error)}`);
      return;
    }
    const parsed = parseDraft(text, this.draftKey);
    if (parsed.reason === 'empty') {
      return;
    }
    if (!parsed.ok) {
      // 损坏：删掉坏文件，页面照常空白进入
      try {
        draftStore.deleteDraftSync(this.draftKey);
        console.info(`[hw] draft corrupt, removed key=${this.draftKey}`);
      } catch (error) {
        console.error(`[hw] draft corrupt, remove failed: ${describeError(error)}`);
      }
      return;
    }
    this.pendingDraft = parsed.doc;
    this.applyPendingDraft();
  }

  /**
   * 把已读到的草稿落到画布上。
   *
   * 必须等画布量出尺寸：草稿里是归一化点，要用**当前**画布宽高重投影
   * （旋转/换尺寸后位置才对）。这套换算与框选 `RegionBox` 完全一致。
   */
  private applyPendingDraft(): void {
    const doc: DraftDoc | null = this.pendingDraft;
    if (doc === null || this.draftApplied) {
      return;
    }
    const w: number = this.pagerState.canvasW;
    const h: number = this.pagerState.canvasH;
    if (!isUsableCanvas(w, h)) {
      return;
    }
    this.draftApplied = true;
    this.pendingDraft = null;

    // 页数：先补到草稿页数（`PageBook` 只提供「追加」的公开操作）
    const target: number = doc.pages.length;
    while (this.pagerState.pages < target) {
      if (!this.pagerState.addPage()) {
        break;
      }
    }
    for (let index = 0; index < doc.pages.length && index < this.pagerState.pages; index++) {
      const page: DraftPage = doc.pages[index];
      const strokes: Stroke[] = fromDraftStrokes(page.strokes, w, h);
      this.pagerState.clearPageHistory(index);
      for (let step = 0; step < strokes.length; step++) {
        this.pagerState.history.push(index, strokes[step]);
      }
      this.pagerState.setRegions(index, fromDraftBoxes(page.boxes));
    }
    this.pagerState.jumpTo(doc.current);
    const replay = this.pagerState.replayAllImpl;
    if (replay !== null) {
      replay();
    }
    this.touchUi();
    if (hasContent(doc)) {
      promptAction.showToast({ message: DRAFT_TOAST_RESTORED, duration: 2500 });
      console.info(
        `[hw] draft restored key=${this.draftKey} pages=${doc.pages.length} current=${doc.current + 1}`
      );
    }
  }

  /** 「完成」且 OCR 成功：草稿作废（失败要保留，让用户能重试）。 */
  private discardDraft(): void {
    this.clearDraftTimer();
    this.pendingDraft = null;
    // 关掉后续保存（否则离开页面时 aboutToDisappear 会把刚删的草稿又写回去）
    this.draftClosed = true;
    try {
      draftStore.deleteDraftSync(this.draftKey);
      console.info(`[hw] draft cleared key=${this.draftKey}`);
    } catch (error) {
      console.error(`[hw] draft clear failed: ${describeError(error)}`);
    }
  }

  /**
   * 把本次的附件打包成「当天 zip」并返回带 `archive/entry` 的引用。
   *
   * - 日期取路由参数 `date`（Edit 侧传记录日期），读不到就退回今天；
   * - 打不进 zip（桥未就绪 / 写失败）→ **不影响完成**：返回原散图引用 + toast 提示，
   *   原图已经在 `attachments-src/`，下次完成或同步时会再次尝试打包（幂等、同名覆盖）。
   */
  private async archiveAttachments(items: Attachment[]): Promise<Attachment[]> {
    if (items.length === 0) {
      return items;
    }
    const dateKey: string = this.resolveRecordDateKey();
    try {
      const packed: Attachment[] = await attachmentStore.archiveDay(
        dateKey,
        items.map((item: Attachment) => {
          const page: ArchivePage = { sha256: item.sha256, pageIndex: item.pageIndex };
          return page;
        })
      );
      return packed.length > 0 ? packed : items;
    } catch (error) {
      console.error(`[hw] archive day failed: ${describeError(error)}`);
      promptAction.showToast({ message: '手迹已保存，打包当天压缩包失败（下次同步会重试）', duration: 3000 });
      return items;
    }
  }

  /** 记录日期（`YYYY-MM-DD`）：优先路由参数 `date`，否则今天。 */
  private resolveRecordDateKey(): string {
    try {
      const params: Record<string, string> = router.getParams() as Record<string, string>;
      if (params !== undefined && params !== null) {
        const value: string = params['date'];
        if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
          return value;
        }
      }
    } catch {
      // 读不到路由参数就用今天
    }
    return localDateKey(new Date());
  }

  // ------------------------------------------------------------------ 完成流程：遮罩 + 占位符

  /**
   * 把每页的「插入对象」矩形合并进手动框遮罩（`objectsToMask` 是唯一开关点）。
   *
   * `objectsToMask()` 只返回**需要填白**的矩形：box/image 总是、table 在关闭识别或超 6×6 时
   * —— 因此「表格逐格 OCR」打开后，表格区域会自动从遮罩里消失（下一批接线）。
   */
  private mergeObjectMasks(base: RegionBox[][], pageIds: string[]): RegionBox[][] {
    const merged: RegionBox[][] = [];
    for (let index = 0; index < pageIds.length; index++) {
      const boxes: RegionBox[] = index < base.length ? base[index].slice() : [];
      const objects: PageObject[] = objectsOfPage(this.objectsByPage, pageIds[index]);
      const rects: NormalizedRect[] = objectsToMask(objects);
      for (const rect of rects) {
        boxes.push({ x: rect.x, y: rect.y, w: rect.w, h: rect.h });
      }
      merged.push(boxes);
    }
    return merged;
  }

  /**
   * 拼正文：每页「OCR 文本 + 该页占位符（按 y 升序、同 y 按 x）」。
   *
   * 占位符与正文的相对位置：遮罩已经把对象区域从识别图里挖掉，OCR 文本里没有对应内容，
   * 因此这里把该页的占位符**按 y 顺序追加在该页文本之后**（稳定、可预期，且不会打乱跨页顺序）。
   */
  private composeBodyWithObjects(pageTexts: string[], pageIds: string[], markdowns: Map<string, string>): string {
    const parts: string[] = [];
    for (let index = 0; index < pageIds.length; index++) {
      const text: string = index < pageTexts.length ? pageTexts[index].trim() : '';
      const objects: PageObject[] = sortObjectsByPosition(objectsOfPage(this.objectsByPage, pageIds[index]));
      const lines: string[] = [];
      if (text.length > 0) {
        lines.push(text);
      }
      for (const object of objects) {
        // 表格识别成功 → 用 Markdown 替换占位符；关闭/超时/失败 → 保留占位符
        const markdown: string | undefined = markdowns.get(object.id);
        if (object.kind === 'table' && markdown !== undefined && markdown.length > 0) {
          lines.push(markdown);
        } else {
          lines.push(this.placeholderOf(object, index + 1));
        }
      }
      if (lines.length > 0) {
        parts.push(lines.join('\n'));
      }
    }
    return parts.join('\n\n');
  }

  /** 单个对象的正文占位符（表格关闭识别/超限 → `tablePlaceholder`，否则先按占位符）。 */
  private placeholderOf(object: PageObject, pageNumber: number): string {
    if (object.kind === 'table') {
      const rows: number = object.rows === undefined ? TABLE_DEFAULT_LINES : object.rows;
      const cols: number = object.cols === undefined ? TABLE_DEFAULT_LINES : object.cols;
      return tablePlaceholder(rows, cols, pageNumber);
    }
    return objectPlaceholder(object, pageNumber);
  }

  /**
   * 收集需要逐格识别的表格（`ocrEnabled` 的才收）。
   *
   * 坐标（C 项注释订正）：`rect` 是**画布区域**归一化坐标，对象层与落盘 JPEG **同基准**，
   * `cellRegions()` 用该截图尺寸换算成像素 —— 因此这里**不做任何偏移修正**。
   * 若将来改成整窗截图，换算必须在此（offset = 横屏 `railTotalWidth()` / 竖屏 `topBarTotalHeight()`，
   * 两者都随视口自适应，写死数值会漂），不要改到 OCR 侧。
   */
  private collectTableTasks(pageIds: string[]): TableCellTask[] {
    const tasks: TableCellTask[] = [];
    for (let index = 0; index < pageIds.length; index++) {
      const objects: PageObject[] = objectsOfPage(this.objectsByPage, pageIds[index]);
      for (const object of objects) {
        if (object.kind !== 'table' || !tableOcrEnabled(object)) {
          continue;
        }
        tasks.push({
          id: object.id,
          pageIndex: index,
          rect: { x: object.x, y: object.y, w: object.w, h: object.h },
          rows: object.rows === undefined ? TABLE_DEFAULT_LINES : object.rows,
          cols: object.cols === undefined ? TABLE_DEFAULT_LINES : object.cols
        });
      }
    }
    return tasks;
  }

  /** 表格识别结果 → `Map<对象 id, markdown>`（失败/未识别的不进表）。 */
  private markdownMap(tables: TableOcrResult[]): Map<string, string> {
    const map: Map<string, string> = new Map<string, string>();
    for (const item of tables) {
      if (item.ok && item.markdown.length > 0) {
        map.set(item.id, item.markdown);
      }
    }
    return map;
  }

  /** 「‹」退出：存草稿 → 返回上一页（不二次确认）。 */
  private exitWritingBoard(): void {    this.clearDraftTimer();
    this.saveDraftNow(false);
    console.info(`[hw] exit key=${this.draftKey}`);
    router.back();
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
    // 换到别处（或关面板）就收起「更多」：下次点「笔迹」仍是最常用的笔形/粗细/颜色三段
    if (next !== PANEL_INK) {
      this.inkMoreOpen = false;
    }
    // 真机自证（Popup/自定义浮层不一定出现在 `ui layout` 里）：
    // hilog | grep '[hw] menu=' 就能看到「点了哪个菜单、开还是关」
    console.info(`[hw] menu=${name} open=${next.length === 0 ? 0 : 1} panel=${next.length === 0 ? 'none' : next}`);
  }

  /**
   * 插入图片：拍照/相册选图 → 读入 → 以页中心插入（默认 40% 页宽、按原图比例）。
   *
   * 真机接线（`photoAccessHelper`）在 `beginInsertImage()`；选图失败/拒绝权限只 toast，不崩。
   */
  private insertImage(): void {
    this.panel = '';
    console.info('[hw] insert=image open=0');
    promptAction.showToast({ message: '插入图片：请选择图片', duration: 1500 });
    this.requestInsertImage();
  }

  /** 插入表格：把当前行列插入到页中心（默认 3×3、60%×40%）。 */
  private insertTable(): void {
    const rows: number = clampTableLines(this.insertRows);
    const cols: number = clampTableLines(this.insertCols);
    const obj: PageObject = makePageObject(`table-${Date.now().toString()}`, 'table', tableRect(), {
      rows: rows,
      cols: cols
    });
    this.writeObjects(this.objectsOfCurrentPage().concat([obj]));
    this.redrawObjects();
    this.panel = '';
    console.info(`[hw] insert=table rows=${rows} cols=${cols} count=${this.currentObjects().length}`);
    if (canOcrTable(rows, cols)) {
      promptAction.showToast({ message: `已插入表格 ${rows}×${cols}（可识别文字）`, duration: 1500 });
    } else {
      // 超过 6×6 或超 36 格：自动关闭文字识别，只保留原图 + 占位符
      promptAction.showToast({ message: '表格超过 6×6，已关闭文字识别', duration: 3000 });
    }
  }

  /** 当前选中的表格对象（没有选中或选中的不是表格 → undefined）。 */
  private selectedTableObject(): PageObject | undefined {
    if (this.selectedObjectId.length === 0) {
      return undefined;
    }
    const found: PageObject | undefined = findObject(this.currentObjects(), this.selectedObjectId);
    if (found === undefined || found.kind !== 'table') {
      return undefined;
    }
    return found;
  }

  /** 开关文案：开 = `识别文字：开`，关 = `识别文字：关`。 */
  private tableOcrSwitchText(): string {
    return this.tableOcrSwitchOn() ? '开' : '关';
  }

  /** 选中表格当前是否开启识别（没有选中表格时按关闭处理）。 */
  private tableOcrSwitchOn(): boolean {
    const table: PageObject | undefined = this.selectedTableObject();
    return table === undefined ? false : tableOcrEnabled(table);
  }

  /** 切换选中表格的「识别文字」开关（写回 `ocrEnabled` 并重绘：关闭后该表重新整块填白）。 */
  private toggleTableOcr(): void {
    const table: PageObject | undefined = this.selectedTableObject();
    if (table === undefined) {
      return;
    }
    const next: PageObject = {
      id: table.id,
      kind: table.kind,
      x: table.x,
      y: table.y,
      w: table.w,
      h: table.h,
      rows: table.rows,
      cols: table.cols,
      ocrEnabled: !tableOcrEnabled(table)
    };
    this.writeObjects(replaceObject(this.currentObjects(), next));
    this.redrawObjects();
    console.info(`[hw] table ocr toggle id=${table.id} enabled=${next.ocrEnabled === true ? 1 : 0}`);
  }

  /** 表格行列步进（1..10，超出夹回边界）。 */
  private stepTableLines(delta: number, isRows: boolean): void {
    if (isRows) {
      this.insertRows = clampTableLines(this.insertRows + delta);
    } else {
      this.insertCols = clampTableLines(this.insertCols + delta);
    }
  }

  /** 选图入口（真机接线替换：photoAccessHelper.PhotoViewPicker → 读入 → insertImageAt）。 */
  private requestInsertImage(): void {
    this.pickImageFromGallery().catch((error: Error) => {
      // 取消/权限拒绝/解码失败一律不崩：toast + 日志，用户可再试
      console.info(`[hw] insert=image failed reason=${describeError(error)}`);
      promptAction.showToast({ message: `插入图片失败：${describeError(error)}`, duration: 3000 });
    });
  }

  /**
   * 相册选图 → PixelMap → （必要时压缩）→ 存本地源图 → 插入到当前页中心。
   *
   * 流程细节：
   * - `PhotoViewPicker.select()` 返回 uri；用户取消时返回空数组 → 静默返回（不 toast 报错）；
   * - 用 `image.createImageSource(uri)` 直接解码（鸿蒙支持 file uri），拿到 PixelMap 与尺寸；
   * - 体积/边长超限（>5MB 或长边 >2048）→ `scale()` 等比缩到长边 2048，再 `packing(jpeg, q90)`；
   * - 落盘走 `attachmentStore.saveImageJpeg()`（按 sha256 去重，条目名 `image-<sha8>.jpg`）；
   * - 插到页中心后**必须重绘**（真机踩过：只改状态不重绘 → 画布全白）。
   */
  private async pickImageFromGallery(): Promise<void> {
    const options: photoAccessHelper.PhotoSelectOptions = new photoAccessHelper.PhotoSelectOptions();
    options.MIMEType = photoAccessHelper.PhotoViewMIMETypes.IMAGE_TYPE;
    options.maxSelectNumber = 1;
    const picker: photoAccessHelper.PhotoViewPicker = new photoAccessHelper.PhotoViewPicker();
    const result: photoAccessHelper.PhotoSelectResult = await picker.select(options);
    const uris: string[] = result.photoUris === undefined ? [] : result.photoUris;
    if (uris.length === 0) {
      console.info('[hw] insert=image cancelled');
      return;
    }
    const uri: string = uris[0];
    console.info(`[hw] pick uri=${uri.slice(0, 40)} count=${uris.length}`);
    await this.insertImageFromUri(uri);
  }

  /**
   * 从 picker 返回的 **media URI** 插图（P0 修复点）。
   *
   * 为什么不能 `image.createImageSource(uri)`：picker 给的是 `file://media/Photo/…` 这类
   * **媒体 URI**，不是普通文件路径，鸿蒙上按 uri 解码不可靠（用户实测选完图后失败）。
   * 正确做法：`fs.openSync(uri)` 拿 **fd** → `createImageSource(fd)` 解码；
   * 需要原始字节时也从**同一个 fd** 读，避免"解码走 uri、读字节走路径"两套语义混用。
   *
   * 失败回滚：已落盘的源图/临时文件清掉，zip 条目本轮未写入（`archiveImages` 只在成功路径调用），
   * 因此不会留下半成品。
   */
  private async insertImageFromUri(uri: string): Promise<void> {
    let file: fs.File | null = null;
    let pixel: image.PixelMap | null = null;
    // 位图是否已交给 objectImages（成功插入后由画布持有，不能再释放）
    let taken: boolean = false;
    try {
      // ① 打开 fd（media URI 必须走这一步）
      try {
        file = fs.openSync(uri, fs.OpenMode.READ_ONLY);
      } catch (error) {
        console.info(`[hw] insert image failed at open: ${describeError(error)}`);
        promptAction.showToast({ message: '插入图片失败（无法读取文件）', duration: 3000 });
        return;
      }
      console.info(`[hw] open ok fd=${file.fd}`);
      // ② 解码（fd，不是 uri）
      try {
        const source: image.ImageSource = image.createImageSource(file.fd);
        const info: image.ImageInfo = await source.getImageInfo();
        pixel = await source.createPixelMap();
        source.release().catch(() => {
          // 释放失败忽略
        });
        console.info(`[hw] decode ok w=${info.size.width} h=${info.size.height}`);
      } catch (error) {
        console.info(`[hw] insert image failed at decode: ${describeError(error)}`);
        promptAction.showToast({ message: '插入图片失败（解码）', duration: 3000 });
        return;
      }
      const info: image.ImageInfo = await pixel.getImageInfo();
      const width: number = Math.max(1, info.size.width);
      const height: number = Math.max(1, info.size.height);
      // ③ 按边长压（>2048 等比缩）
      const longest: number = Math.max(width, height);
      if (longest > IMAGE_MAX_SIDE) {
        const ratio: number = IMAGE_MAX_SIDE / longest;
        await pixel.scale(ratio, ratio);
        console.info(
          `[hw] insert=image scaled ${width}x${height} -> ${Math.round(width * ratio)}x${Math.round(height * ratio)}`
        );
      }
      // ④ 编 JPEG（q90，超 5MB 再 q60）
      let bytes: ArrayBuffer;
      try {
        bytes = await this.packJpeg(pixel, IMAGE_JPEG_QUALITY);
        if (bytes.byteLength > IMAGE_MAX_BYTES) {
          bytes = await this.packJpeg(pixel, IMAGE_JPEG_LOW_QUALITY);
        }
      } catch (error) {
        console.info(`[hw] insert image failed at encode: ${describeError(error)}`);
        promptAction.showToast({ message: '插入图片失败（压缩）', duration: 3000 });
        return;
      }
      // ⑤ 落本地源图 + 算条目名（纯函数决定扩展名/矩形）
      let saved: SavedImage;
      try {
        const plan: SelectionImagePlan = imageObjectFromSelection(uri, width, height, '');
        saved = attachmentStore.saveImageJpeg(bytes, plan.ext);
        console.info(`[hw] save ok name=${saved.entry} bytes=${bytes.byteLength}`);
      } catch (error) {
        console.info(`[hw] insert image failed at save: ${describeError(error)}`);
        promptAction.showToast({ message: '插入图片失败（保存附件）', duration: 3000 });
        return;
      }
      // ⑥ 插进当前页（画布上出现 + 可拖动缩放）
      this.objectImages.set('image-' + saved.sha256.slice(0, 8), pixel);
      taken = true;
      this.insertImageAt(saved.sha256, saved.entry, width, height);
      console.info(`[hw] insert ok id=image-${saved.sha256.slice(0, 8)}`);
      // ⑦ 打进当天 zip（失败不回滚插入：原图已在本地源目录，完成时会再打包一次）
      try {
        await attachmentStore.archiveImages(this.resolveRecordDateKey(), [saved]);
        console.info(`[hw] save zip ok name=${saved.entry}`);
      } catch (error) {
        console.info(`[hw] insert=image archive deferred reason=${describeError(error)}`);
      }
    } finally {
      if (file !== null) {
        try {
          fs.closeSync(file);
        } catch {
          // 关闭失败忽略
        }
      }
      // 位图已交给 objectImages（成功时），失败时释放，避免泄漏
      if (pixel !== null && !taken) {
        this.releasePixelSafely(pixel);
      }
    }
  }

  /** 编 JPEG（独立方法便于两档质量复用与释放）。 */
  private async packJpeg(pixel: image.PixelMap, quality: number): Promise<ArrayBuffer> {
    const packer: image.ImagePacker = image.createImagePacker();
    try {
      return await packer.packing(pixel, { format: 'image/jpeg', quality: quality });
    } finally {
      packer.release().catch(() => {
        // 释放失败忽略
      });
    }
  }

  /** 释放 PixelMap（吞掉异常）。 */
  private releasePixelSafely(pixel: image.PixelMap): void {
    try {
      pixel.release().catch(() => {
        // 释放失败忽略
      });
    } catch {
      // 同步抛错忽略
    }
  }

  /** 把已读入的图片按「页中心 + 40% 页宽」插入（选图回调里调它）。 */
  private insertImageAt(sha256: string, name: string, imageW: number, imageH: number): void {
    const rect: NormalizedRect = imageRectFor(imageW, imageH);
    const obj: PageObject = makePageObject('image-' + sha256.slice(0, 8), 'image', rect, {
      sha256: sha256,
      name: name
    });
    this.writeObjects(this.objectsOfCurrentPage().concat([obj]));
    this.redrawObjects();
    const ext: string = name.indexOf('.') >= 0 ? name.slice(name.lastIndexOf('.') + 1) : 'jpg';
    console.info('[hw] insert=image entry=' + imageEntryName(sha256, ext) + ' w=' + String(imageW) + ' h=' + String(imageH) + ' count=' + String(this.currentObjects().length));
  }

  private closeOverlays(): void {
    if (this.panel.length > 0) {
      console.info('[hw] menu=none open=0');
    }
    this.panel = '';
    this.confirmStage = CONFIRM_NONE;
    this.inkMoreOpen = false;
  }

  private pickBrush(kind: BrushKind): void {
    this.pagerState.setBrush(kind);
    // 点选项**不关面板**（用户要连续调：笔形→粗细→颜色）；点面板外由 scrim 关闭
    console.info(
      `[hw] ink brush=${kind} label=${brushSpec(kind).label} width=${this.pagerState.penWidth}` +
        ` color=${this.pagerState.penColor} panel=open`
    );
  }

  private pickWidth(width: number): void {
    this.pagerState.setPenWidth(width);
    console.info(
      `[hw] ink brush=${this.pagerState.brush} width=${width} color=${this.pagerState.penColor} panel=open`
    );
  }

  private pickColor(color: string): void {
    this.pagerState.setPenColor(color);
    console.info(
      `[hw] ink brush=${this.pagerState.brush} width=${this.pagerState.penWidth} color=${color} panel=open`
    );
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

  /** 总页数（直接读唯一真相源）。 */
  private pageTotal(): number {
    return this.pagerState.pages;
  }

  /** 当前页下标 0 起（直接读唯一真相源）。 */
  private pageIndex(): number {
    return this.pagerState.current;
  }

  /**
   * 强制重绘信号：只用来让本页重新走一遍 `build()`，**不承载任何状态值**
   * （页数/当前页/撤销可用性都直接读 `pagerState`，那里才是唯一真相源）。
   */
  private touchUi(): void {
    this.uiTick = this.uiTick + 1;
    // 页可能变了：对象层跟着当前页重绘（对象随页切换，不串页）
    this.redrawObjects();
  }

  /** 打印当前页状态（真机取证用：页码文本必须与这里一致）。 */
  private logPageState(action: string): void {
    console.info(
      `[hw] pages ${action} total=${this.pageTotal()} current=${this.pageIndex() + 1}` +
        ` canDelete=${this.pageTotal() > 1} canInsert=${this.pageTotal() < MAX_HANDWRITING_PAGES}`
    );
  }

  private goPrevPage(): void {
    if (this.pagerState.prev()) {
      this.onPageSwitched();
      this.touchUi();
      this.scheduleDraftSave();
    }
  }

  private goNextPage(): void {
    if (this.pagerState.next()) {
      this.onPageSwitched();
      this.touchUi();
      this.scheduleDraftSave();
    }
  }

  /** `+`：在当前页之后插入空白页（自动跳到新页）。 */
  private insertPage(): void {
    if (this.pagerState.insertPageAfterCurrent()) {
      console.info(`[hw] page insert after, now=${this.pagerState.current + 1}/${this.pagerState.pages}`);
      this.logPageState('insert');
      this.touchUi();
      this.scheduleDraftSave();
    }
  }

  /** `−`：删除当前页（两步确认）。 */
  private startDeletePage(): void {
    if (this.pageTotal() <= 1) {
      return;
    }
    this.closeOverlays();
    this.confirmStage = CONFIRM_FIRST;
    console.info(`[hw] delete confirm stage=1 page=${this.pageIndex() + 1}/${this.pageTotal()}`);
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
      // 删页前先记下该页 id：删掉后它的对象要一起删（不让对象留在孤儿页上）
      const removedPageId: string = this.currentPageId();
      if (this.pagerState.removePage(this.pagerState.current)) {
        if (removedPageId.length > 0) {
          this.objectsByPage = removePageObjects(this.objectsByPage, removedPageId);
        }
        this.selectedObjectId = '';
        console.info(`[hw] page deleted ${pageNo}, pages=${this.pagerState.pages}`);
        this.logPageState('delete');
        this.touchUi();
        this.scheduleDraftSave();
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
    // 切页只走 pagerState.jumpTo（真相源），不再维护本地副本
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
    // 插入对象（框/图片/表格）也要填白：合并到每页的遮罩矩形里，框内内容不送 OCR
    const maskRegions: RegionBox[][] = this.mergeObjectMasks(pageRegions, ids);
    let regionTotal: number = 0;
    for (let index = 0; index < maskRegions.length; index++) {
      regionTotal += maskRegions[index].length;
    }
    const manager = new OcrBatchManager({
      snapshotIds: ids,
      pageRegions: maskRegions,
      store: attachmentStore,
      preparePage: (pageIndex: number) => this.preparePage(pageIndex),
      // 区域填白由子组件实现（pager 持有画布上下文），这里只转调注册好的实现
      maskPage: (pageIndex: number, regions: RegionBox[]) => this.pagerState.maskPage(pageIndex, regions),
      // 表格逐格识别任务（仅 ocrEnabled 的表格；矩形是**画布区域**归一化坐标（与落盘 JPEG 同基准））
      tableTasks: this.collectTableTasks(ids),
      onProgress: (message: string, ratio: number) => {
        this.ocrProgress = message;
      }
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
      // 正文：每页「识别文本 + 该页对象占位符（按 y 升序）」，页间空行分隔
      const markdowns: Map<string, string> = this.markdownMap(result.tables);
      const body: string = this.composeBodyWithObjects(result.pageTexts, ids, markdowns);
      const failedTables: TableOcrResult[] = result.tables.filter((item: TableOcrResult) => !item.ok);
      AppStorage.setOrCreate<string>('handwriting.result', body);
      AppStorage.setOrCreate<string>('handwriting.ocrText', result.rawText);
      // 附件：优先打成「当天 zip」引用（仓库里只放 zip）；失败回退散图引用，不阻塞完成
      const packed: Attachment[] = await this.archiveAttachments(result.attachments);
      AppStorage.setOrCreate<string>('handwriting.attachments', JSON.stringify(packed));
      // 插入对象（框/图片/表格）按页写入记录：v2 文档，键是稳定页 id
      const objectsJson: string = this.hasAnyObject() ? serializePageObjects(this.objectsByPage) : '';
      AppStorage.setOrCreate<string>('handwriting.pageObjects', objectsJson);
      if (objectsJson.length > 0) {
        console.info(`[hw] objects total=${countObjects(this.objectsByPage)} pages=${Object.keys(this.objectsByPage).length}`);
      }
      promptAction.showToast({
        message: `已保存 ${result.attachments.length} 页手迹`,
        duration: 3000
      });
      if (failedTables.length > 0) {
        promptAction.showToast({ message: '表格识别超时，已保留原图', duration: 3000 });
      }
      // 只有「完成且 OCR 成功」才作废草稿；失败路径保留（catch 里不动草稿）
      this.discardDraft();
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

  /** 当前是否深色（只有「被静态测试钉住、无法用 `$r()` 的底色」需要它选两套值）。 */
  private isDarkTheme(): boolean {
    try {
      return isSystemDark(getContext(this) as common.Context);
    } catch {
      return false;
    }
  }

  /**
   * 横屏 rail 底色：深色档取 `DARK_FALLBACK.railFill`（= `dark/color.json` 的 `control_fill`），
   * 浅色档继续用 `RAIL_BG`。
   *
   * ⚠ `tools/test/handwritingToolbar.test.mjs:652` 曾断言这里必须是 `.backgroundColor(RAIL_BG)`；
   * 该断言在深色下会把 rail 钉在 #F7F9FB 浅灰上，而文字色是令牌（深色下变浅灰）→ 字看不见。
   * 因此把它降级为「浅色档常量」（其值仍被 :653 钉住），断言需由该测试 owner 改成
   * `$r('app.color.control_fill_alt')`。
   */
  private railBackground(): ResourceColor {
    return this.isDarkTheme() ? DARK_FALLBACK.railFill : RAIL_BG;
  }

  /** 笔形的图标颜色（铅笔灰、荧光笔黄，其余主文字色）。 */
  private brushIconColor(kind: string): ResourceColor {
    if (kind === 'pencil') {
      return $r('app.color.ink_pencil');
    }
    if (kind === 'highlighter') {
      return $r('app.color.ink_highlighter');
    }
    return $r('app.color.text_primary');
  }

  /** 笔形图标：一根按笔刷类型变粗的斜杆（长度取 `metrics.iconSize`）。 */
  @Builder
  brushIcon(kind: string) {
    Text('')
      .width(this.brushIconWidth(kind))
      .height(this.iconSize() * 0.75)
      .borderRadius(2)
      .backgroundColor(this.brushIconColor(kind))
      .rotate({ angle: -35 })
  }

  /** 粗细图标：三个递增圆点（圆点直径代表档位，容器高度取 `metrics.iconSize`）。 */
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
    .height(this.iconSize() * 0.75)
    .alignItems(VerticalAlign.Center)
  }

  /** 颜色图标：三个小色块（尺寸随 `metrics.iconSize` 缩放）。 */
  @Builder
  colorIcon() {
    Row({ space: 1 }) {
      Text('')
        .width(this.iconSize() * 0.25)
        .height(this.iconSize() * 0.4)
        .backgroundColor(PEN_COLORS[0])
      Text('')
        .width(this.iconSize() * 0.25)
        .height(this.iconSize() * 0.4)
        .backgroundColor(PEN_COLORS[1])
      Text('')
        .width(this.iconSize() * 0.25)
        .height(this.iconSize() * 0.4)
        .backgroundColor(PEN_COLORS[2])
    }
    .height(this.iconSize() * 0.75)
  }

  // ------------------------------------------------------------------ 工具条按钮（宽度随内容自适应）

  /**
   * 当前笔迹状态摘要：`笔刷名 · 档位 · 色名`（例：`钢笔 · 3.5 · 黑`）。
   *
   * **按钮上不再显示它**（真机上会被裁成 `钢笔 · 3.5`）——按钮固定写「笔迹」，
   * 具体选中项在面板里看。这里只留给 hilog / 提示文案用。
   */
  private inkSummary(): string {
    return `${this.currentBrushLabel()} · ${this.pagerState.penWidth} · ${this.currentColorLabel()}`;
  }

  /** 当前颜色名（颜色面板里显示；按钮上只写「颜色」+ 色块）。 */
  private currentColorLabel(): string {
    const index: number = PEN_COLORS.indexOf(this.pagerState.penColor);
    return index >= 0 && index < COLOR_LABELS.length ? COLOR_LABELS[index] : '色';
  }

  /** 当前笔刷中文名（笔形按钮的动态文案：钢笔 / 圆珠笔 / 铅笔 / 马克笔 / 荧光笔）。 */
  private currentBrushLabel(): string {
    return brushSpec(this.pagerState.brush).label;
  }

  /** 当前粗细档对应的圆点直径（按钮与菜单共用，保证「看到的粗细 = 选中的档位」）。 */
  private currentDotSize(): number {
    const index: number = PEN_WIDTHS.indexOf(this.pagerState.penWidth);
    return index >= 0 && index < SIZE_DOTS.length ? SIZE_DOTS[index] : SIZE_DOTS[2];
  }

  // ------------------------------------------------------------------ 工具条单元格（唯一实现，两套布局壳共用）

  /**
   * 单元格主文案（`''` = 没有文字）。
   *
   * **唯一文案表**：竖屏顶部条与横屏 rail 都从这里取字，不再各自写一遍 `Text('橡皮')`。
   */
  private cellLabel(id: string): string {
    switch (id) {
      case CELL_EXIT:
        return '‹';
      case CELL_INK:
        return '笔迹';
      case CELL_ERASER:
        return '橡皮';
      case CELL_SELECT:
        return '手动框';
      case CELL_INSERT:
        return '插入';
      case CELL_UNDO:
        return '↶';
      case CELL_REDO:
        return '↷';
      default:
        return '';
    }
  }

  /** 单元格绑定的绘画工具（只有橡皮 / 手动框有，其余返回 `''`）。 */
  private cellTool(id: string): string {
    if (id === CELL_ERASER) {
      return HW_TOOL_ERASER;
    }
    if (id === CELL_SELECT) {
      return HW_TOOL_SELECT;
    }
    return '';
  }

  /** 选中态：橡皮 / 手动框看当前工具，笔迹 / 插入看对应面板是否展开（其余永远 false）。 */
  private cellSelected(id: string): boolean {
    if (id === CELL_ERASER || id === CELL_SELECT) {
      return this.pagerState.tool === this.cellTool(id);
    }
    if (id === CELL_INK) {
      return this.panel === PANEL_INK;
    }
    if (id === CELL_INSERT) {
      return this.panel === PANEL_INSERT;
    }
    return false;
  }

  /** 历史单元格是否可用（撤销栈空 / 没有可重做时为 false：只影响字色，按钮仍然可点）。 */
  private historyAvailable(id: string): boolean {
    return id === CELL_UNDO ? this.pagerState.undoSteps > 0 : this.pagerState.redoAvailable;
  }

  /** 单元格文字颜色：选中态品牌色、面板展开反白、历史不可用走次要色（**不降透明度**）。 */
  private cellTextColor(id: string): ResourceColor {
    const selected: boolean = this.cellSelected(id);
    if (id === CELL_UNDO || id === CELL_REDO) {
      return this.historyAvailable(id) ? $r('app.color.text_primary') : $r('app.color.text_secondary');
    }
    if (id === CELL_INK || id === CELL_INSERT) {
      return selected ? $r('app.color.text_inverse') : $r('app.color.text_primary');
    }
    if (id === CELL_ERASER || id === CELL_SELECT) {
      return selected ? $r('app.color.brand') : $r('app.color.text_primary');
    }
    return $r('app.color.text_primary');
  }

  /** 单元格「▾」的颜色（面板展开时与文字一起反白）。 */
  private cellArrowColor(id: string): ResourceColor {
    return this.cellSelected(id) ? $r('app.color.text_inverse') : $r('app.color.text_secondary');
  }

  /** 单元格底色：面板展开 = 品牌蓝、工具选中 = 选中底、历史 = 输入框底、其余 = 控件底。 */
  private cellBackground(id: string): ResourceColor {
    if (id === CELL_INK || id === CELL_INSERT) {
      return this.cellSelected(id) ? $r('app.color.brand') : $r('app.color.control_fill');
    }
    if (id === CELL_ERASER || id === CELL_SELECT) {
      return this.cellSelected(id)
        ? $r('app.color.selection_fill')
        : (this.isDarkTheme() ? DARK_FALLBACK.railFill : '#F1F3F5');
    }
    if (id === CELL_UNDO || id === CELL_REDO) {
      return $r('app.color.field_fill');
    }
    return $r('app.color.control_fill');
  }

  /** 选中描边宽度：只有橡皮 / 手动框选中时 1vp，其余 0（0 = 不描边，也就没有视觉差）。 */
  private cellBorderWidth(id: string): number {
    if (id === CELL_ERASER || id === CELL_SELECT) {
      return this.cellSelected(id) ? 1 : 0;
    }
    return 0;
  }

  /**
   * 单元格点击分派（`@Builder` 里**不传闭包**：只传 id，行为在这里 `switch`）。
   *
   * 缺陷 4 的两个成因都在这里收口：
   * - (a) 手势被 Scrollable 抢走：历史按钮是 `Row` + `.onClick`（有独立点击区的真按钮），
   *   竖屏顶部条里没有任何 Scroll，横屏那条 Scroll 是竖向的，不会吃横向点击；
   * - (b) 禁用态哑巴：**不用 `.enabled(false)`**（真机会「看着能点、点了没反应」），
   *   历史按钮永远可点，只用字色体现「没东西可撤销」，点下去 toast 说明原因。
   */
  private onCellTap(id: string): void {
    switch (id) {
      case CELL_EXIT:
        this.exitWritingBoard();
        break;
      case CELL_INK:
        this.togglePanel(PANEL_INK);
        break;
      case CELL_ERASER:
        this.toggleTool(HW_TOOL_ERASER);
        break;
      case CELL_SELECT:
        this.toggleTool(HW_TOOL_SELECT);
        break;
      case CELL_INSERT:
        this.togglePanel(PANEL_INSERT);
        break;
      case CELL_UNDO:
        this.onHistoryTap('undo', this.pagerState.undoSteps > 0);
        break;
      case CELL_REDO:
        this.onHistoryTap('redo', this.pagerState.redoAvailable);
        break;
      case CELL_FINISH:
        this.finish();
        break;
      default:
        break;
    }
  }

  /** 单元格主文案：字号 / 不截断 / 颜色全部由 id 派生（`maxLines(1)` + 禁止省略号）。 */
  @Builder
  cellText(id: string) {
    Text(this.cellLabel(id))
      .fontSize(this.toolbarFontSize())
      .maxLines(1)
      .textOverflow({ overflow: TextOverflow.None })
      .textAlign(TextAlign.Center)
      .fontColor(this.cellTextColor(id))
  }

  /** 「▾」：面板类单元格（笔迹 / 插入）的展开指示。 */
  @Builder
  cellArrow(id: string) {
    Text('▾')
      .fontSize(this.toolbarFontSize())
      .maxLines(1)
      .textOverflow({ overflow: TextOverflow.None })
      .fontColor(this.cellArrowColor(id))
  }

  /** 单元格内容（文字 / 当前色块 / ▾）：竖屏与横屏共用同一份。 */
  @Builder
  cellContent(id: string) {
    if (id === CELL_INK) {
      Row({ space: 2 }) {
        this.cellText(id)
        // 当前色块（边长取 `metrics.iconSize × 0.6`）：文案收缩时也还能看出颜色
        Text('')
          .width(this.iconSize() * 0.6)
          .height(this.iconSize() * 0.6)
          .borderRadius(3)
          .backgroundColor(this.pagerState.penColor)
          .border({
            width: 1,
            color: this.cellSelected(id) ? $r('app.color.text_inverse') : $r('app.color.border')
          })
          .margin({ left: 2 })
        this.cellArrow(id)
      }
    } else if (id === CELL_INSERT) {
      Row({ space: 2 }) {
        this.cellText(id)
        this.cellArrow(id)
      }
    } else {
      this.cellText(id)
    }
  }

  /**
   * 工具条单元格（**所有按钮的唯一实现**，竖屏顶部条 / 横屏 rail 共用）。
   *
   * 两个布局壳只差几何，语义一律走 id（`cellLabel` / `cellTextColor` / `cellBackground`）：
   * - 竖屏（`LAYOUT_PORTRAIT`）：宽度**按内容自适应**——只给 `minWidth = itemSize` + 左右 8vp
   *   padding + `flexShrink(0)`，**不给固定 width**（真机上固定宽会把「手动框」截断）；
   * - 横屏（`LAYOUT_RAIL`）：铺满 rail（`minWidth = railWidth()`）、不加内边距。
   * 参数只用简单类型（`@Builder` 不传闭包），点击行为由 `onCellTap(id)` 的 `switch` 分派；
   * `width` 只给「完成」用（竖屏 `finishWidth()` / 横屏 `railWidth()`），其余单元格传 0。
   */
  @Builder
  buttonCell(id: string, layout: string, width: number) {
    if (id === CELL_FINISH) {
      // 「完成」是唯一主操作：实底品牌蓝 + 白字、不收缩。真机缺陷：rail 里 56vp 宽时
      // Button 内部 padding 会把 2 个字挤成「...」——宽度守 64 下限，并显式给 4vp 左右 padding。
      Button(this.busy ? '识别中' : '完成')
        .width(width)
        .height(this.itemSize())
        .constraintSize({ minWidth: FINISH_MIN_WIDTH })
        .padding({ left: SPACING.xs, right: SPACING.xs })
        // 横屏用 RADIUS.sm（与 rail 其它控件一致）；竖屏保持 Button 默认的胶囊圆角（= 高度的一半）
        .borderRadius(layout === LAYOUT_RAIL ? RADIUS.sm : this.itemSize() / 2)
        .fontSize(this.toolbarFontSize())
        .backgroundColor($r('app.color.brand'))
        .fontColor(Color.White)
        .enabled(!this.busy)
        .flexShrink(0)
        .onClick(() => {
          this.onCellTap(id);
        })
    } else {
      Row() {
        this.cellContent(id)
      }
      .constraintSize({ minWidth: layout === LAYOUT_RAIL ? this.railWidth() : this.itemSize() })
      .height(this.itemSize())
      .padding({
        left: layout === LAYOUT_RAIL ? 0 : SPACING.sm,
        right: layout === LAYOUT_RAIL ? 0 : SPACING.sm
      })
      .justifyContent(FlexAlign.Center)
      .borderRadius(RADIUS.sm)
      .backgroundColor(this.cellBackground(id))
      .border({ width: this.cellBorderWidth(id), color: $r('app.color.brand') })
      .flexShrink(0)
      .onClick(() => {
        this.onCellTap(id);
      })
    }
  }

  /**
   * 分页区 = **三个单元格**（用户定版：`-+` 一个单元格、`3/5` 一个、`<>` 一个）。
   *
   * ```
   * [ − | + ]   [ 3/5 ]   [ ‹ | › ]
   * ```
   * 2026-11-16「分页区放宽」定版：`−`/`+`、`‹`/`›` **每半 ≥44vp**（`PAGER_HALF_MIN`），
   * 页码格 **≥64vp**（`PAGER_LABEL_MIN`），格间距 = `controlGap()`（`metrics.gap`，且不小于 8vp）。
   * 竖屏顶部条与横屏 rail **共用这一套单元格**，宽度分别由 `pagerCellWidth()` / `pagerLabelWidth()` 给。
   *
   * 竖屏：默认固定在顶部条里、横向 Scroll 之外（永远可见，真机上曾被 Scroll 边缘裁掉）；
   * 只有窄屏连「退出 + 笔迹 + 分页组 + 完成」都放不下时，才整体并进 Scroll（宁可滚动、不压缩）。
   * 横屏：放在 rail 里纵向堆叠，宽度 = rail 宽度（`railWidth()` 已兜住 ≥89vp 的分页下限）。
   */
  @Builder
  pageStepper() {
    Row({ space: this.controlGap() }) {
      this.insertDeleteCell(this.pagerCellWidth())
      this.pageLabelCell(this.pagerLabelWidth())
      this.prevNextCell(this.pagerCellWidth())
    }
    .height(this.itemSize())
    .flexShrink(0)
  }

  /** 是否还有上一页（首页禁用 `‹`）。 */
  private canPrevPage(): boolean {
    return this.pageIndex() > 0;
  }

  /** 是否还有下一页（末页禁用 `›`）。 */
  private canNextPage(): boolean {
    return this.pageIndex() < this.pageTotal() - 1;
  }

  /** `[−|+]` 单元格：左半删当前页（两次确认）、右半在当前页之后插页，各自独立禁用。 */
  @Builder
  insertDeleteCell(width: number) {
    Row() {
      Text('−')
        .layoutWeight(1)
        .height(this.itemSize())
        .fontSize(this.toolbarFontSize())
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.None })
        .textAlign(TextAlign.Center)
        .fontColor(this.pageTotal() > 1 ? $r('app.color.danger') : $r('app.color.text_secondary'))
        .enabled(this.pageTotal() > 1)
        .onClick(() => {
          this.startDeletePage();
        })

      // 两半之间的 1vp 分割线（单元格内部结构，不是控件之间的间距）
      Divider()
        .vertical(true)
        .strokeWidth(DIVIDER)
        .color($r('app.color.divider'))
        .height(this.itemSize())

      Text('+')
        .layoutWeight(1)
        .height(this.itemSize())
        .fontSize(this.toolbarFontSize())
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.None })
        .textAlign(TextAlign.Center)
        .fontColor(this.pageTotal() < MAX_HANDWRITING_PAGES ? $r('app.color.brand') : $r('app.color.text_secondary'))
        .enabled(this.pageTotal() < MAX_HANDWRITING_PAGES)
        .onClick(() => {
          this.insertPage();
        })
    }
    .width(width)
    .height(this.itemSize())
    .borderRadius(RADIUS.sm)
    .backgroundColor(this.isDarkTheme() ? DARK_FALLBACK.chipFill : '#F7F8FA')
    .clip(true)
    .flexShrink(0)
  }

  /** `[n/m]` 单元格：只读页码。 */
  @Builder
  pageLabelCell(width: number) {
    Row() {
      Text(`${this.pageIndex() + 1}/${this.pageTotal()}`)
        .width('100%')
        .height(this.itemSize())
        .fontSize(this.toolbarFontSize())
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.None })
        .textAlign(TextAlign.Center)
        .fontColor($r('app.color.text_primary'))
    }
    .width(width)
    .height(this.itemSize())
    .borderRadius(RADIUS.sm)
    .backgroundColor(this.isDarkTheme() ? DARK_FALLBACK.chipFill : '#F7F8FA')
    .clip(true)
    .flexShrink(0)
  }

  /** `[‹|›]` 单元格：左半上一页（首页禁用）、右半下一页（末页禁用）。 */
  @Builder
  prevNextCell(width: number) {
    Row() {
      Text('‹')
        .layoutWeight(1)
        .height(this.itemSize())
        .fontSize(this.toolbarFontSize())
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.None })
        .textAlign(TextAlign.Center)
        .fontColor(this.canPrevPage() ? $r('app.color.text_primary') : $r('app.color.text_secondary'))
        .enabled(this.canPrevPage())
        .onClick(() => {
          this.goPrevPage();
        })

      Divider()
        .vertical(true)
        .strokeWidth(DIVIDER)
        .color($r('app.color.divider'))
        .height(this.itemSize())

      Text('›')
        .layoutWeight(1)
        .height(this.itemSize())
        .fontSize(this.toolbarFontSize())
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.None })
        .textAlign(TextAlign.Center)
        .fontColor(this.canNextPage() ? $r('app.color.text_primary') : $r('app.color.text_secondary'))
        .enabled(this.canNextPage())
        .onClick(() => {
          this.goNextPage();
        })
    }
    .width(width)
    .height(this.itemSize())
    .borderRadius(RADIUS.sm)
    .backgroundColor(this.isDarkTheme() ? DARK_FALLBACK.chipFill : '#F7F8FA')
    .clip(true)
    .flexShrink(0)
  }

  /**
   * 竖屏：顶部工具条（**9 项一屏排完，绝不横向滚动**）。
   *
   * ```
   * 宽屏（一屏一行）：
   * [‹] [笔迹▾] [橡皮] [手动框] [插入▾] [↶] [↷] [ −|+ ][n/m][‹|› ] [完成]
   *
   * 极窄屏（两行折行，`topBarTwoRows()` 为真）：
   * 第一行 [‹] [笔迹▾] [橡皮] [手动框] [插入▾] [↶] [↷]
   * 第二行 [ −|+ ][n/m][‹|› ] [完成]
   * ```
   *
   * 缺陷 3 的定版：**删掉包裹工具项的 `Scroll().scrollable(Horizontal)`** —— 真机上
   * 橡皮/手动框/插入/撤销/重做 被滚出屏幕、用户以为「按钮没了」；而且这条横向 Scroll
   * 会抢走历史按钮的点击手势（缺陷 4a）。现在要么一行、要么两行，**两种都是静态布局**：
   * - 一行判据：`pageW ≥ 640vp` 且 `topBarRequiredWidth() ≤ pageW`（按真实控件宽度实算）；
   * - 否则两行：第一行 7 个工具按钮 + 第二行「分页组 + 完成」（两行都放得下才叫折行，
   *   控件尺寸一律不压缩、不隐藏）；顶部条高度由 `topBarHeight()` 一起放大到 2 × 厚度。
   * - **注意**：这里只是同一个 builder 的两个 if 分支，画布（`HandwritingPager`）始终在
   *   `build()` 的同一位置，不会因宽度变化被重建（重建会丢掉已经画好的像素）。
   *
   * 单元格语义只有一份（`buttonCell` + `cellContent`）：本壳只负责「排成一行还是两行」，
   * 不再重复定义按钮。
   */
  @Builder
  topBar() {
    if (this.topBarTwoRows()) {
      // ---- 极窄屏：两行折行（不用滚动，也不隐藏任何控件）
      Column() {
        Row({ space: this.controlGap() }) {
          this.buttonCell(CELL_EXIT, LAYOUT_PORTRAIT, 0)
          this.buttonCell(CELL_INK, LAYOUT_PORTRAIT, 0)
          this.buttonCell(CELL_ERASER, LAYOUT_PORTRAIT, 0)
          this.buttonCell(CELL_SELECT, LAYOUT_PORTRAIT, 0)
          this.buttonCell(CELL_INSERT, LAYOUT_PORTRAIT, 0)
          this.buttonCell(CELL_UNDO, LAYOUT_PORTRAIT, 0)
          this.buttonCell(CELL_REDO, LAYOUT_PORTRAIT, 0)
        }
        .width('100%')
        .height(this.barThickness())
        .justifyContent(FlexAlign.Center)
        .alignItems(VerticalAlign.Center)

        Row({ space: this.controlGap() }) {
          this.pageStepper()
          this.buttonCell(CELL_FINISH, LAYOUT_PORTRAIT, this.finishWidth())
        }
        .width('100%')
        .height(this.barThickness())
        .justifyContent(FlexAlign.Center)
        .alignItems(VerticalAlign.Center)
      }
      .width('100%')
      .height(this.topBarHeight())
      .padding({ left: SPACING.sm, right: SPACING.sm })
      .backgroundColor($r('app.color.page_background'))
      .justifyContent(FlexAlign.Center)
    } else {
      // ---- 宽屏：9 项一屏一行
      Row({ space: this.controlGap() }) {
        this.buttonCell(CELL_EXIT, LAYOUT_PORTRAIT, 0)
        this.buttonCell(CELL_INK, LAYOUT_PORTRAIT, 0)
        this.buttonCell(CELL_ERASER, LAYOUT_PORTRAIT, 0)
        this.buttonCell(CELL_SELECT, LAYOUT_PORTRAIT, 0)
        this.buttonCell(CELL_INSERT, LAYOUT_PORTRAIT, 0)
        this.buttonCell(CELL_UNDO, LAYOUT_PORTRAIT, 0)
        this.buttonCell(CELL_REDO, LAYOUT_PORTRAIT, 0)
        this.pageStepper()
        this.buttonCell(CELL_FINISH, LAYOUT_PORTRAIT, this.finishWidth())
      }
      .width('100%')
      .height(this.barThickness())
      .padding({ left: SPACING.sm, right: SPACING.sm })
      .backgroundColor($r('app.color.page_background'))
      .alignItems(VerticalAlign.Center)
    }
  }

  /** 竖屏：工具条与画布之间的 1vp 横分割线（用户反馈两者「糊在一起」）。 */
  @Builder
  topBarDivider() {
    Divider()
      .strokeWidth(DIVIDER)
      .color($r('app.color.divider'))
      .width('100%')
  }

  /**
   * 横屏：最左侧竖排 rail（宽度 = `railWidth()` + 1vp 分割线）。
   *
   * 12 项：`‹` 退出 + 笔迹 + 橡皮 + 手动框 + 插入 + ↶ + ↷ + **三个分页单元格**
   * （`[−|+]` / `[n/m]` / `[‹|›]`）；「完成」压到底部、不参与滚动。
   *
   * 尺寸改成随屏自适应后（`itemSize` 最大 72vp），12 项竖向总高可能超过真机可用高度
   * （≈601vp），因此中段整体放进**竖向 Scroll**：所有控件都点得到、「完成」也不会被挤出屏幕。
   * 这不是「压缩控件」——每个控件仍是 `metrics.itemSize` 见方，只是允许滚动。
   *
   * 单元格语义与竖屏完全一致（同一个 `buttonCell`）：本壳只负责「竖着排、铺满 rail 宽」。
   */
  @Builder
  railBar() {
    Row() {
      Column({ space: this.controlGap() }) {
        Scroll() {
          Column({ space: this.controlGap() }) {
            // 与竖屏同一份单元格语义，这里只换成「铺满 rail 宽」的布局壳（LAYOUT_RAIL）
            this.buttonCell(CELL_EXIT, LAYOUT_RAIL, 0)
            this.buttonCell(CELL_INK, LAYOUT_RAIL, 0)
            this.buttonCell(CELL_ERASER, LAYOUT_RAIL, 0)
            this.buttonCell(CELL_SELECT, LAYOUT_RAIL, 0)
            this.buttonCell(CELL_INSERT, LAYOUT_RAIL, 0)
            this.buttonCell(CELL_UNDO, LAYOUT_RAIL, 0)
            this.buttonCell(CELL_REDO, LAYOUT_RAIL, 0)
            // 分页三单元格：宽度 = rail 宽度（`railWidth()` 已兜住「每半 ≥44」的下限）
            this.insertDeleteCell(this.railWidth())
            this.pageLabelCell(this.railWidth())
            this.prevNextCell(this.railWidth())
          }
          .width('100%')
        }
        .scrollable(ScrollDirection.Vertical)
        .scrollBar(BarState.Off)
        .width('100%')
        .layoutWeight(1)
        .align(Alignment.Top)

        this.buttonCell(CELL_FINISH, LAYOUT_RAIL, this.railWidth())
      }
      .width(this.railWidth())
      .height('100%')
      .padding({ top: SPACING.sm, bottom: SPACING.sm })
      .backgroundColor(this.railBackground())
      .alignItems(HorizontalAlign.Center)

      // 与画布之间的 1vp 分割线（用户反馈：工具条与画布「糊在一起」）
      Divider()
        .vertical(true)
        .strokeWidth(DIVIDER)
        .color($r('app.color.divider'))
        .height('100%')
    }
    .width(this.railWidth() + DIVIDER)
    .height('100%')
    .alignItems(VerticalAlign.Top)
  }

  // ------------------------------------------------------------------ 二级面板（绝对定位浮层，不挤压画布）

  // ------------------------------------------------------------------ 对象层（框 / 图片 / 表格）

  // ------------------------------------------------------------------ 按页对象（B2 批 1）

  /** 当前页的稳定 id（`PageBook` 的 `p1/p2…`）；取不到返回空串。 */
  private currentPageId(): string {
    const ids: string[] = this.pagerState.pageIds;
    const index: number = this.pagerState.current;
    if (index < 0 || index >= ids.length) {
      return '';
    }
    return ids[index];
  }

  /** 当前页对象（只读副本；空页返回空数组）。 */
  private currentObjects(): PageObject[] {
    return objectsOfPage(this.objectsByPage, this.currentPageId());
  }

  /** 当前页对象（同 `currentObjects()`，命名区分「按页取」的语义）。 */
  private objectsOfCurrentPage(): PageObject[] {
    return this.currentObjects();
  }

  /** 写回当前页对象（按页 id 存；空页自动删键）。 */
  private writeObjects(objects: PageObject[]): void {
    const pageId: string = this.currentPageId();
    if (pageId.length === 0) {
      return;
    }
    this.objectsByPage = setObjectsOfPage(this.objectsByPage, pageId, objects);
  }

  /** 是否有任何页存在对象（finish 决定要不要写 pageObjects 字段）。 */
  private hasAnyObject(): boolean {
    return countObjects(this.objectsByPage) > 0;
  }

  /** 页面切换后：取消选中并重绘（对象随页切换，不会串页）。 */
  private onPageSwitched(): void {
    this.selectedObjectId = '';
    this.redrawObjects();
  }

  /** 对象层左上角 x（竖屏贴左边、横屏贴 rail 右侧；rail 宽度随屏自适应）。 */
  private objectLeft(): number {
    return this.railTotalWidth();
  }

  /** 对象层左上角 y（竖屏在工具条下方、横屏顶到 0）。 */
  private objectTop(): number {
    return this.topBarTotalHeight();
  }

  private objectWidth(): number {
    return Math.max(0, this.pageW - this.objectLeft());
  }

  private objectHeight(): number {
    return Math.max(0, this.pageH - this.objectTop());
  }

  /** 触摸点（`Up` 时 `touches` 可能已空，退到 `changedTouches`）。 */
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

  /** 触摸点 → 归一化坐标（用对象层自身尺寸，和画布 1:1）。 */
  private toNormalized(x: number, y: number): NormPoint {
    const width: number = Math.max(1, this.objectW);
    const height: number = Math.max(1, this.objectH);
    return { nx: x / width, ny: y / height };
  }

  @Builder
  objectLayer() {
    Canvas(this.objectCtx)
      .width(this.objectWidth())
      .height(this.objectHeight())
      .position({ x: this.objectLeft(), y: this.objectTop() })
      .hitTestBehavior(HitTestMode.Transparent)
      .onReady(() => {
        this.redrawObjects();
      })
      .onAreaChange((_oldArea: Area, newArea: Area) => {
        this.objectW = Number(newArea.width);
        this.objectH = Number(newArea.height);
        this.redrawObjects();
      })
      .onTouch((event: TouchEvent) => {
        this.onObjectTouch(event);
      })
  }

  /** 重绘整层：清屏 → 按 z 序画三种对象 → 选中态高亮 + 手柄/×。 */
  private redrawObjects(): void {
    const context: CanvasRenderingContext2D = this.objectCtx;
    const width: number = this.objectW;
    const height: number = this.objectH;
    if (width <= 0 || height <= 0) {
      return;
    }
    context.clearRect(0, 0, width, height);
    for (const obj of this.currentObjects()) {
      this.drawObject(context, obj, obj.id === this.selectedObjectId);
    }
  }

  /** 画单个对象（box：半透明描边；image：有 pixelMap 画图、否则占位框；table：网格线）。 */
  private drawObject(context: CanvasRenderingContext2D, obj: PageObject, selected: boolean): void {
    const width: number = this.objectW;
    const height: number = this.objectH;
    const x: number = obj.x * width;
    const y: number = obj.y * height;
    const w: number = obj.w * width;
    const h: number = obj.h * height;
    const stroke: string = selected ? CANVAS_PAINTS.selectionStroke : CANVAS_PAINTS.objectOutlineFaded;

    if (obj.kind === 'image') {
      const pixel: image.PixelMap | undefined = this.objectImages.get(obj.id);
      if (pixel !== undefined) {
        context.drawImage(pixel, x, y, w, h);
      } else {
        // 没有位图（B1 阶段/解码失败）：画占位框 + 「图片」字样，保证看得见
        context.globalAlpha = 0.12;
        context.fillStyle = CANVAS_PAINTS.objectTint;
        context.fillRect(x, y, w, h);
        context.globalAlpha = 1;
        context.fillStyle = CANVAS_PAINTS.objectStroke;
        context.font = '14vp sans-serif';
        context.fillText('图片', x + 8, y + h / 2);
      }
    } else if (obj.kind === 'table') {
      const rows: number = obj.rows === undefined ? 3 : obj.rows;
      const cols: number = obj.cols === undefined ? 3 : obj.cols;
      context.strokeStyle = CANVAS_PAINTS.grid;
      context.lineWidth = 1;
      for (let row = 0; row <= rows; row++) {
        const lineY: number = y + (h * row) / Math.max(1, rows);
        context.beginPath();
        context.moveTo(x, lineY);
        context.lineTo(x + w, lineY);
        context.stroke();
      }
      for (let col = 0; col <= cols; col++) {
        const lineX: number = x + (w * col) / Math.max(1, cols);
        context.beginPath();
        context.moveTo(lineX, y);
        context.lineTo(lineX, y + h);
        context.stroke();
      }
    } else {
      context.globalAlpha = 0.08;
      context.fillStyle = CANVAS_PAINTS.objectTint;
      context.fillRect(x, y, w, h);
      context.globalAlpha = 1;
    }

    // 外框 + 选中态加粗
    context.strokeStyle = stroke;
    context.lineWidth = selected ? 2 : 1;
    context.strokeRect(x, y, w, h);

    if (selected) {
      // 右下角缩放手柄
      context.fillStyle = CANVAS_PAINTS.selectionStroke;
      context.fillRect(x + w - 8, y + h - 8, 8, 8);
      // 左上角删除 ×
      context.strokeStyle = CANVAS_PAINTS.objectDanger;
      context.lineWidth = 2;
      context.beginPath();
      context.moveTo(x, y);
      context.lineTo(x + 14, y + 14);
      context.moveTo(x + 14, y);
      context.lineTo(x, y + 14);
      context.stroke();
    }
  }

  /**
   * 对象层手势（定版：三类对象共用一套）。
   *
   * 互斥关系（**定死**）：`手动框`模式仍然是「拉出一个新框」（原有语义不变）；
   * 插入的对象在**选择/移动态**下操作 —— 两者不抢手势：
   * - `手动框` 激活时，对象层**不消费**触摸（`hitTestBehavior` 透明 + 这里直接 return），
   *   用户仍可拉新框；
   * - 否则对象层优先命中已有对象（选中/移动/缩放/删除），点空白才把事件让给画布。
   */
  private onObjectTouch(event: TouchEvent): void {
    if (this.pagerState.tool === HW_TOOL_SELECT) {
      // 手动框优先：不拦截，让画布拉框
      return;
    }
    const touch: TouchObject | null = this.primaryTouch(event);
    if (touch === null) {
      return;
    }
    const point = this.toNormalized(touch.x, touch.y);
    if (event.type === TouchType.Down) {
      const hit = hitTest(this.currentObjects(), point.nx, point.ny);
      if (hit.id.length === 0) {
        // 点空白：取消选中，并把事件让给画布（不 return，画笔照常落笔）
        if (this.selectedObjectId.length > 0) {
          this.selectedObjectId = '';
          this.redrawObjects();
        }
        return;
      }
      if (hit.part === 'close') {
        this.writeObjects(deleteObject(this.currentObjects(), hit.id));
        this.selectedObjectId = '';
        console.info(`[hw] object delete id=${hit.id} count=${this.currentObjects().length}`);
        this.redrawObjects();
        return;
      }
      // 选中即置顶（点谁谁在上）
      this.writeObjects(bringToFront(this.currentObjects(), hit.id));
      this.selectedObjectId = hit.id;
      const origin: PageObject | undefined = findObject(this.currentObjects(), hit.id);
      if (origin === undefined) {
        return;
      }
      this.dragObject = origin;
      this.dragPart = hit.part;
      this.dragStart = point;
      this.redrawObjects();
      console.info(`[hw] object select id=${hit.id} part=${hit.part}`);
      return;
    }
    if (event.type === TouchType.Move && this.dragObject !== null) {
      const origin: PageObject = this.dragObject;
      if (this.dragPart === 'handle') {
        const next: PageObject = resizeObject(origin, point.nx, point.ny);
        this.writeObjects(replaceObject(this.currentObjects(), next));
      } else {
        const dx: number = point.nx - this.dragStart.nx;
        const dy: number = point.ny - this.dragStart.ny;
        const next: PageObject = moveObject(origin, origin.x + dx, origin.y + dy);
        this.writeObjects(replaceObject(this.currentObjects(), next));
        this.dragStart = point;
      }
      this.redrawObjects();
      return;
    }
    if (event.type === TouchType.Up || event.type === TouchType.Cancel) {
      if (this.dragObject !== null) {
        console.info(`[hw] object ${this.dragPart === 'handle' ? 'resize' : 'move'} id=${this.dragObject.id} done`);
      }
      this.dragObject = null;
      this.dragPart = 'body';
      this.redrawObjects();
    }
  }

  /** 面板锚点：竖屏在工具条下方、横屏在 rail 右侧（都不碰画布中心）。 */
  private panelLeft(): number {
    // 横屏：rail 宽 + 8vp 间距；竖屏：贴工具条左边 8vp（railTotalWidth 竖屏为 0）
    return this.railTotalWidth() + SPACING.sm;
  }

  private panelTop(): number {
    if (this.landscape) {
      // rail 顺序：笔迹(0) / 橡皮(1) / 手动框(2) / 插入(3)，控件高 = metrics.itemSize、间距 = controlGap
      const index: number = this.panel === PANEL_INK ? 0 : (this.panel === PANEL_INSERT ? 3 : 1);
      return SPACING.sm + index * (this.itemSize() + this.controlGap());
    }
    return this.topBarTotalHeight() + SPACING.xs;
  }

  /** 面板宽度（按内容给足，避免文字被截断）。 */
  private panelWidth(): number {
    if (this.panel === PANEL_INK) {
      return INK_PANEL_MIN_WIDTH + 2 * SPACING.sm;
    }
    if (this.panel === PANEL_INSERT) {
      return 224;
    }
    return 156;
  }

  /** 选中行底色。 */
  private rowBackground(selected: boolean): ResourceColor {
    return selected ? $r('app.color.selection_fill') : Color.Transparent;
  }

  /**
   * 二级面板：**「笔迹设置」= 笔形 + 粗细两段**（用户需求：合并成一个二级菜单）；
   * 另一套是「颜色」。
   *
   * 结构：标题 → `笔形` 小标题 + 5 个 chip（可换行）→ 1vp 分割线 → `粗细` 小标题 + 5 个档位格。
   * 选任一项立即生效并关面板（`pickBrush`/`pickWidth` 内部已 `panel = ''`）。
   */
  @Builder
  overlayPanel() {
    Column({ space: SPACING.xs }) {
      if (this.panel === PANEL_INK) {
        Text('笔迹设置')
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.None })
          .fontWeight(FontWeight.Bold)
          .fontColor($r('app.color.text_secondary'))

        // ---- 段 1：笔形（5 个 chip，窄屏自动换行）
        Text('笔形')
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.None })
          .fontColor($r('app.color.text_secondary'))
        Flex({ direction: FlexDirection.Row, wrap: FlexWrap.Wrap, justifyContent: FlexAlign.Start }) {
          ForEach(
            BRUSHES,
            (spec: BrushSpec) => {
              Row({ space: 4 }) {
                if (this.pagerState.brush === spec.kind && this.pagerState.tool === HW_TOOL_BRUSH) {
                  Text('✓')
                    .fontSize(FONT.caption)
                    .maxLines(1)
                    .textOverflow({ overflow: TextOverflow.None })
                    .fontColor($r('app.color.brand'))
                }
                Text(spec.label)
                  .fontSize(FONT.caption)
                  .lineHeight(LINE_HEIGHT.caption)
                  .maxLines(1)
                  .textOverflow({ overflow: TextOverflow.None })
                  .fontColor(
                    this.pagerState.brush === spec.kind && this.pagerState.tool === HW_TOOL_BRUSH
                      ? $r('app.color.brand')
                      : $r('app.color.text_primary')
                  )
              }
              .height(CHIP_HEIGHT)
              .constraintSize({ minWidth: 56 })
              .padding({ left: SPACING.sm, right: SPACING.sm })
              .margin({ right: SPACING.xs, bottom: SPACING.xs })
              .borderRadius(RADIUS.sm)
              .backgroundColor(
                this.pagerState.brush === spec.kind && this.pagerState.tool === HW_TOOL_BRUSH ? $r('app.color.selection_fill') : $r('app.color.control_fill_alt')
              )
              .border({
                width: this.pagerState.brush === spec.kind && this.pagerState.tool === HW_TOOL_BRUSH ? 1.5 : 0,
                color: $r('app.color.brand')
              })
              .onClick(() => {
                this.pickBrush(spec.kind);
              })
            },
            (spec: BrushSpec) => `ink-brush-${spec.kind}`
          )
        }
        .width('100%')

        // ---- 两段之间的 1vp 分割线
        Divider()
          .strokeWidth(DIVIDER)
          .color($r('app.color.divider'))
          .width('100%')

        // ---- 段 2：粗细（圆点 + 数值，5 档等分，选中加粗描边 + 数值高亮）
        Text('粗细')
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.None })
          .fontColor($r('app.color.text_secondary'))
        Row() {
          ForEach(
            PEN_WIDTHS,
            (width: number, index: number) => {
              Row({ space: 2 }) {
                // 圆点必须显式给宽高/圆角/颜色（用户曾反馈「5 个选项空白」）
                Text('')
                  .width(SIZE_DOTS[index])
                  .height(SIZE_DOTS[index])
                  .borderRadius(SIZE_DOTS[index] / 2)
                  .backgroundColor(
                    this.pagerState.penWidth === width
                      ? $r('app.color.brand')
                      : $r('app.color.text_primary')
                  )
                Text(`${width}`)
                  .fontSize(FONT.caption)
                  .lineHeight(LINE_HEIGHT.caption)
                  .maxLines(1)
                  .textOverflow({ overflow: TextOverflow.None })
                  .fontColor(
                    this.pagerState.penWidth === width
                      ? $r('app.color.brand')
                      : $r('app.color.text_primary')
                  )
                  .fontWeight(this.pagerState.penWidth === width ? FontWeight.Bold : FontWeight.Normal)
              }
              .layoutWeight(1)
              .height(CHIP_HEIGHT)
              .justifyContent(FlexAlign.Center)
              .borderRadius(RADIUS.sm)
              .backgroundColor(this.pagerState.penWidth === width ? $r('app.color.selection_fill') : Color.Transparent)
              .border({
                width: this.pagerState.penWidth === width ? 1.5 : 0,
                color: $r('app.color.brand')
              })
              .onClick(() => {
                this.pickWidth(width);
              })
            },
            (width: number) => `ink-size-${width}`
          )
        }
        .width('100%')
        .height(CHIP_HEIGHT)

        // ---- 两段之间的 1vp 分割线（粗细 → 颜色）
        Divider()
          .strokeWidth(DIVIDER)
          .color($r('app.color.divider'))
          .width('100%')

        // ---- 段 3：颜色（色块 + 色名，5 个等分，选中加描边）
        Text('颜色')
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.None })
          .fontColor($r('app.color.text_secondary'))
        Row() {
          ForEach(
            PEN_COLORS,
            (color: string, index: number) => {
              Row({ space: 4 }) {
                Text('')
                  .width(20)
                  .height(20)
                  .borderRadius(RADIUS.sm)
                  .backgroundColor(color)
                  .border({
                    width: this.pagerState.penColor === color ? 2 : 1,
                    color: this.pagerState.penColor === color ? $r('app.color.brand') : $r('app.color.border')
                  })
                Text(COLOR_LABELS[index])
                  .fontSize(FONT.caption)
                  .lineHeight(LINE_HEIGHT.caption)
                  .maxLines(1)
                  .textOverflow({ overflow: TextOverflow.None })
                  .fontColor(
                    this.pagerState.penColor === color
                      ? $r('app.color.brand')
                      : $r('app.color.text_primary')
                  )
                  .fontWeight(this.pagerState.penColor === color ? FontWeight.Bold : FontWeight.Normal)
              }
              .layoutWeight(1)
              .height(CHIP_HEIGHT)
              .justifyContent(FlexAlign.Center)
              .borderRadius(RADIUS.sm)
              .backgroundColor(this.pagerState.penColor === color ? $r('app.color.selection_fill') : Color.Transparent)
              .onClick(() => {
                this.pickColor(color);
              })
            },
            (color: string) => `ink-color-${color}`
          )
        }
        .width('100%')
        .height(CHIP_HEIGHT)

        // ---- 二级菜单入口「更多 ▸」：把「仅手写笔输入」这类不常改的开关收在面板第二层，
        // 视觉上仍守住「每屏 1 个主操作、其余进更多」（docs/UI-DESIGN.md §9）。
        Divider()
          .strokeWidth(DIVIDER)
          .color($r('app.color.divider'))
          .width('100%')

        Row({ space: SPACING.xs }) {
          Text('更多')
            .fontSize(FONT.caption)
            .lineHeight(LINE_HEIGHT.caption)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.None })
            .fontColor($r('app.color.text_primary'))
            .layoutWeight(1)
          Text(this.inkMoreOpen ? '▾' : '▸')
            .fontSize(FONT.caption)
            .lineHeight(LINE_HEIGHT.caption)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.None })
            .fontColor($r('app.color.text_secondary'))
        }
        .width('100%')
        .height(CHIP_HEIGHT)
        .padding({ left: SPACING.sm, right: SPACING.sm })
        .borderRadius(RADIUS.sm)
        .onClick(() => {
          this.toggleInkMore();
        })

        if (this.inkMoreOpen) {
          // 缺陷 2：「仅手写笔输入」的开关落在手写板自己的笔迹面板里（设置页那条已删除）。
          // 切换即落盘（settingsStore.save）+ 立刻作用于画布（pagerState.setPenOnlyInput）。
          Row({ space: SPACING.sm }) {
            Text('仅手写笔输入')
              .fontSize(FONT.caption)
              .lineHeight(LINE_HEIGHT.caption)
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.None })
              .fontColor($r('app.color.text_primary'))
              .layoutWeight(1)
            Toggle({ type: ToggleType.Switch, isOn: this.penOnlyInput })
              .selectedColor($r('app.color.brand'))
              .onChange((isOn: boolean) => {
                this.savePenOnlyInput(isOn);
              })
          }
          .width('100%')
          .height(CHIP_HEIGHT)
          .padding({ left: SPACING.sm, right: SPACING.sm })
          .alignItems(VerticalAlign.Center)

          Text('开启后手指不能写，只能用手写笔')
            .fontSize(FONT.caption)
            .lineHeight(LINE_HEIGHT.caption)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.None })
            .fontColor($r('app.color.text_secondary'))
            .padding({ left: SPACING.sm, right: SPACING.sm })
        }
      } else if (this.panel === PANEL_INSERT) {
        // ---- 「插入」二级菜单：图片 / 表格（表格带 行×列 步进，1..10）
        Text('插入')
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.None })
          .fontWeight(FontWeight.Bold)
          .fontColor($r('app.color.text_secondary'))

        Row({ space: SPACING.xs }) {
          Text('图片')
            .fontSize(FONT.body)
            .lineHeight(LINE_HEIGHT.body)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.None })
            .textAlign(TextAlign.Center)
            .height(CHIP_HEIGHT)
            .layoutWeight(1)
            .borderRadius(RADIUS.sm)
            .backgroundColor($r('app.color.control_fill_alt'))
            .fontColor($r('app.color.text_primary'))
            .onClick(() => {
              this.insertImage();
            })
          Text('表格')
            .fontSize(FONT.body)
            .lineHeight(LINE_HEIGHT.body)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.None })
            .textAlign(TextAlign.Center)
            .height(CHIP_HEIGHT)
            .layoutWeight(1)
            .borderRadius(RADIUS.sm)
            .backgroundColor($r('app.color.control_fill_alt'))
            .fontColor($r('app.color.text_primary'))
            .onClick(() => {
              this.insertTable();
            })
        }
        .width('100%')

        Divider()
          .strokeWidth(DIVIDER)
          .color($r('app.color.divider'))
          .width('100%')

        // ---- 表格行列（1..10，默认 3×3）；「表格」按钮用当前选择插入
        Text('表格行列')
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.None })
          .fontColor($r('app.color.text_secondary'))
        Row({ space: SPACING.xs }) {
          Text('−')
            .fontSize(FONT.body)
            .lineHeight(LINE_HEIGHT.body)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.None })
            .height(CHIP_HEIGHT)
            .width(TOUCH_MIN)
            .textAlign(TextAlign.Center)
            .borderRadius(RADIUS.sm)
            .backgroundColor($r('app.color.control_fill'))
            .onClick(() => {
              this.stepTableLines(-1, true);
            })
          Text(`行 ${this.insertRows}`)
            .fontSize(FONT.caption)
            .lineHeight(LINE_HEIGHT.caption)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.None })
            .layoutWeight(1)
            .textAlign(TextAlign.Center)
            .fontColor($r('app.color.text_primary'))
          Text('+')
            .fontSize(FONT.body)
            .lineHeight(LINE_HEIGHT.body)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.None })
            .height(CHIP_HEIGHT)
            .width(TOUCH_MIN)
            .textAlign(TextAlign.Center)
            .borderRadius(RADIUS.sm)
            .backgroundColor($r('app.color.control_fill'))
            .onClick(() => {
              this.stepTableLines(1, true);
            })
          Text('−')
            .fontSize(FONT.body)
            .lineHeight(LINE_HEIGHT.body)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.None })
            .height(CHIP_HEIGHT)
            .width(TOUCH_MIN)
            .textAlign(TextAlign.Center)
            .borderRadius(RADIUS.sm)
            .backgroundColor($r('app.color.control_fill'))
            .onClick(() => {
              this.stepTableLines(-1, false);
            })
          Text(`列 ${this.insertCols}`)
            .fontSize(FONT.caption)
            .lineHeight(LINE_HEIGHT.caption)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.None })
            .layoutWeight(1)
            .textAlign(TextAlign.Center)
            .fontColor($r('app.color.text_primary'))
          Text('+')
            .fontSize(FONT.body)
            .lineHeight(LINE_HEIGHT.body)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.None })
            .height(CHIP_HEIGHT)
            .width(TOUCH_MIN)
            .textAlign(TextAlign.Center)
            .borderRadius(RADIUS.sm)
            .backgroundColor($r('app.color.control_fill'))
            .onClick(() => {
              this.stepTableLines(1, false);
            })
        }
        .width('100%')
        .height(CHIP_HEIGHT)
        // 选中表格时给「识别文字」开关（关闭后该表恢复整块填白 + 占位符）
        if (this.selectedTableObject() !== undefined) {
          Divider()
            .strokeWidth(DIVIDER)
            .color($r('app.color.divider'))
            .width('100%')
          Row({ space: SPACING.xs }) {
            Text('识别文字')
              .fontSize(FONT.caption)
              .lineHeight(LINE_HEIGHT.caption)
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.None })
              .fontColor($r('app.color.text_primary'))
              .layoutWeight(1)
            Text(this.tableOcrSwitchText())
              .fontSize(FONT.caption)
              .lineHeight(LINE_HEIGHT.caption)
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.None })
              .fontColor(this.tableOcrSwitchOn() ? $r('app.color.brand') : $r('app.color.text_secondary'))
          }
          .width('100%')
          .height(CHIP_HEIGHT)
          .padding({ left: SPACING.sm, right: SPACING.sm })
          .borderRadius(RADIUS.sm)
          .backgroundColor($r('app.color.control_fill_alt'))
          .onClick(() => {
            this.toggleTableOcr();
          })
        }
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
                  color: this.pagerState.penColor === color ? $r('app.color.brand') : $r('app.color.border')
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
                  .maxLines(1)
                  .textOverflow({ overflow: TextOverflow.None })
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
    .constraintSize({ minWidth: MENU_MIN_WIDTH })
    .width(this.panelWidth())
    .padding({ top: SPACING.xs, bottom: SPACING.xs })
    .borderRadius(RADIUS.md)
    .backgroundColor($r('app.color.surface_raised'))
    .shadow({ radius: 16, color: $r('app.color.shadow'), offsetY: 4 })
    .position({ x: this.panelLeft(), y: this.panelTop() })
    .alignItems(HorizontalAlign.Start)
  }

  /** 透明遮罩：点空白处收起浮层（画布点击不会漏进去）。 */
  @Builder
  overlayScrim() {
    Column()
      .width('100%')
      .height('100%')
      .backgroundColor($r('app.color.scrim'))
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
            ? `删除第 ${this.pageIndex() + 1} 页？该页手迹与附件将一并移除。`
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
            .backgroundColor($r('app.color.field_fill'))
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
            .fontColor($r('app.color.text_inverse'))
            .onClick(() => {
              this.confirmDelete();
            })
        }
        .width('100%')
      }
      .width(this.dialogWidth())
      .padding(SPACING.lg)
      .borderRadius(RADIUS.md)
      .backgroundColor($r('app.color.surface_raised'))
      .alignItems(HorizontalAlign.Start)
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
    .backgroundColor($r('app.color.scrim'))
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
          .fontColor($r('app.color.text_inverse'))
          .onClick(() => {
            this.markTipShown();
          })
      }
      .width(this.dialogWidth())
      .padding(SPACING.lg)
      .borderRadius(RADIUS.md)
      .backgroundColor($r('app.color.surface_raised'))
      .alignItems(HorizontalAlign.Start)
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
    .backgroundColor($r('app.color.scrim'))
  }

  build() {
    Stack() {
      // 恒定组件树：rail 宽度 / 顶部条高度随方向变化（不重建画布）
      Row() {
        Column() {
          this.railBar()
        }
        // rail 容器 = railWidth + 1vp 分割线（分割线在 railBar 内部，宽度也算进来）
        .width(this.railTotalWidth())
        .height('100%')
        .clip(true)

        Column() {
          Column() {
            this.topBar()
            this.topBarDivider()
          }
          .height(this.topBarTotalHeight())
          .clip(true)

          HandwritingPager({
            state: this.pagerState,
            maxPages: MAX_HANDWRITING_PAGES,
            // 页码都直接读 pagerState（唯一真相源）；这个回调只用来**触发重绘**
            onStateChange: () => {
              this.touchUi();
            },
            // 撤销/重做可用性变化 → 工具条重建（缺陷 4b：子组件只改 @Observed 字段时，
            // 个别 ArkUI 版本不会重跑父页面 build，按钮就停在旧状态）
            onStatsChange: (undoSteps: number, redoAvailable: boolean) => {
              this.onHistoryStats(undoSteps, redoAvailable);
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

      // 对象层（框 / 图片 / 表格）：**绝对定位覆盖在画布区域之上**，不参与布局，
      // 因此不影响笔迹画布尺寸；它自己一层 Canvas，笔迹重绘/撤销与对象层互不影响。
      if (this.pageW > 0) {
        this.objectLayer()
      }

      // 读取 uiTick 建立重绘依赖（条件恒为假，不渲染任何东西）：
      // 页数/当前页变化后 bump 一次，页码与 `− / +` 的可用性立刻跟着变。
      if (this.uiTick < 0) {
        Text('')
      }

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