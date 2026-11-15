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
import { draftStore } from '../services/draftStore';
import { localDateKey } from '../common/date';
import { describeError, scheduleStore } from '../services/scheduleStore';
import { BRUSHES, brushSpec } from '../model/brush';
import type { BrushKind, BrushSpec } from '../model/brush';
import { PEN_WIDTHS, PEN_COLORS } from '../model/strokeHistory';
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
import type { RegionBox } from '../model/types';
import type { Attachment } from '../model/types';

/** `archiveDay` 的入参形状（显式接口：ArkTS 禁止内联对象类型）。 */
interface ArchivePage {
  sha256: string;
  pageIndex: number;
}

/** 竖屏顶部工具条高度（vp）——定版要求 ≤48vp。 */
const TOP_BAR_HEIGHT: number = 48;
/**
 * 横屏左侧 rail 宽度（vp）。
 *
 * 真机实测：56vp 时「手动框」被截成「手动」、「完成」显示成「...」、
 * 步进器 −/+ 被挤出 rail。加宽到 72vp 后 3 字标签完整、步进器改竖向堆叠。
 */
const RAIL_WIDTH: number = 72;
/** 横屏 rail 内每个控件的统一高度（vp）——比竖屏的 40vp 高一档，图标/文字更好点。 */
const RAIL_ITEM_HEIGHT: number = 44;
/**
 * 横屏 rail 内控件间距（vp）。
 *
 * 取 2vp 而不是 4vp：rail 竖向空间被「退出（固定 40）+ 完成（固定 48）」吃掉后只剩
 * ~500vp，2vp 间距能让滚动区多容纳一项；视觉上仍与竖屏 4vp 差异不大。
 */
const RAIL_GAP: number = 2;
/**
 * 分页区的单元格宽度（vp）。
 *
 * - 横屏 rail：`CELL_WIDTH = 72`，与 rail 里其它控件等宽；
 * - 竖屏顶部条：`CELL_W_COMPACT = 36vp`（≈85px @2.375，每个格 ≈84px），三个单元格 + 间距共 116vp，
 *   给横向 Scroll 留出 ≈420vp 放 7 个工具按钮（实测够用，不会把分页组挤出屏幕）。
 *   单元格内部两半等分，每半 ≈41px 宽（> 34px 验收线）。
 */
const CELL_WIDTH: number = 72;
const CELL_W_COMPACT: number = 36;
/** 横屏 rail 底色（比画布浅一点，与内容区分开；不用投影）。 */
const RAIL_BG: string = '#F7F9FB';
/** 工具条控件高度（vp）。 */
const TOOL_HEIGHT: number = 40;
/** 工具条控件最小宽度（vp）——定版要求 ≥44vp（徽标 + ▾ 不再被挤没）。 */
const TOOL_MIN_WIDTH: number = 44;
/** 「完成」最小宽度（vp）——定版要求 ≥64vp。 */
const FINISH_MIN_WIDTH: number = 64;
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
/** 退出按钮（`‹`）的边长（vp，与工具条同高）。 */
const EXIT_SIZE: number = 40;
/** 草稿提示文案（用户可见，别写内部术语）。 */
const DRAFT_TOAST_RESTORED: string = '已恢复上次未完成的手迹';
const DRAFT_TOAST_TOO_LARGE: string = '草稿过大，已只保留前 10 页';
const DRAFT_TOAST_SAVE_FAILED: string = '暂存失败，退出后可能丢失这次手迹';

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

  aboutToAppear(): void {
    this.draftKey = this.resolveDraftKey();
    this.loadTipFlag();
    // 画布尺寸变化/落笔/改框都通过 state 的钩子回调本页（父页面拿不到子组件实例）
    this.pagerState.dirtyImpl = () => {
      this.scheduleDraftSave();
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
    // 真机自证（Popup/自定义浮层不一定出现在 `ui layout` 里）：
    // hilog | grep '[hw] menu=' 就能看到「点了哪个菜单、开还是关」
    console.info(`[hw] menu=${name} open=${next.length === 0 ? 0 : 1} panel=${next.length === 0 ? 'none' : next}`);
  }

  private closeOverlays(): void {
    if (this.panel.length > 0) {
      console.info('[hw] menu=none open=0');
    }
    this.panel = '';
    this.confirmStage = CONFIRM_NONE;
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
      this.touchUi();
      this.scheduleDraftSave();
    }
  }

  private goNextPage(): void {
    if (this.pagerState.next()) {
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
      if (this.pagerState.removePage(this.pagerState.current)) {
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
      // 附件：优先打成「当天 zip」引用（仓库里只放 zip）；失败回退散图引用，不阻塞完成
      const packed: Attachment[] = await this.archiveAttachments(result.attachments);
      AppStorage.setOrCreate<string>('handwriting.attachments', JSON.stringify(packed));
      promptAction.showToast({
        message:
          `识别完成：${result.attachments.length} 页、${result.regionCount} 个框` +
          '（框内未识别，原始截图已保存）',
        duration: 3000
      });
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

  // ------------------------------------------------------------------ 工具条按钮（宽度随内容自适应）

  /**
   * 「笔迹设置」按钮上的状态文案：`钢笔 · 3.5`。
   *
   * 用户允许「太长可缩成 `钢笔`」；这里取 `笔刷名 · 档位`，面板里再给完整信息。
   */
  private inkSummary(): string {
    // 三段合并后按钮文案：笔刷 · 档位 · 色名（例：`钢笔 · 3.5 · 黑`）
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

  /**
   * 「笔迹设置」按钮（笔形 + 粗细合并后的入口）。
   *
   * 文案显示当前状态：`钢笔 · 3.5`（太长时用户可只看笔刷名，见 `inkSummary()`）。
   * 宽度按内容自适应：只给 `minWidth(44)` + 左右 8vp padding，`flexShrink(0)` 不压缩。
   */
  @Builder
  brushMenuButton() {
    Row({ space: 2 }) {
      Text(this.inkSummary())
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.None })
        .fontColor(this.panel === PANEL_INK ? Color.White : $r('app.color.text_primary'))
      // 12×12 当前色块：即使文案收缩成「钢笔 · 3.5」也能看出颜色
      Text('')
        .width(12)
        .height(12)
        .borderRadius(3)
        .backgroundColor(this.pagerState.penColor)
        .border({ width: 1, color: this.panel === PANEL_INK ? Color.White : '#DDDDDD' })
        .margin({ left: 2 })
      Text('▾')
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.None })
        .fontColor(this.panel === PANEL_INK ? Color.White : $r('app.color.text_secondary'))
    }
    .height(TOOL_HEIGHT)
    .constraintSize({ minWidth: TOOL_MIN_WIDTH })
    .padding({ left: SPACING.sm, right: SPACING.sm })
    .borderRadius(RADIUS.sm)
    .backgroundColor(this.panel === PANEL_INK ? $r('app.color.brand') : '#F1F3F5')
    .flexShrink(0)
    .onClick(() => {
      this.togglePanel(PANEL_INK);
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
      .padding({ left: SPACING.sm, right: SPACING.sm })
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
      .padding({ left: SPACING.sm, right: SPACING.sm })
      .fontSize(FONT.body)
      .maxLines(1)
      .textOverflow({ overflow: TextOverflow.None })
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
   * 分页区 = **三个单元格**（用户定版：`-+` 一个单元格、`3/5` 一个、`<>` 一个）。
   *
   * ```
   * [ − | + ]   [ 3/5 ]   [ ‹ | › ]
   * ```
   * 竖屏：放在**顶部条**里、**横向 Scroll 之外**（固定显示，宽度取紧凑档 `CELL_W_COMPACT = 36vp ≈84px`），
   * 这样不会被 Scroll 边缘裁掉；
   * 横屏：放在 rail 里纵向堆叠，宽度取 `CELL_WIDTH`（72vp，与 rail 其它控件等宽）。
   */
  @Builder
  pageStepper() {
    Row({ space: SPACING.xs }) {
      this.insertDeleteCell(CELL_W_COMPACT)
      this.pageLabelCell(CELL_W_COMPACT)
      this.prevNextCell(CELL_W_COMPACT)
    }
    .height(RAIL_ITEM_HEIGHT)
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
        .height(RAIL_ITEM_HEIGHT)
        .fontSize(FONT.body)
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
        .height(RAIL_ITEM_HEIGHT)

      Text('+')
        .layoutWeight(1)
        .height(RAIL_ITEM_HEIGHT)
        .fontSize(FONT.body)
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
    .height(RAIL_ITEM_HEIGHT)
    .borderRadius(RADIUS.sm)
    .backgroundColor('#F7F8FA')
    .clip(true)
    .flexShrink(0)
  }

  /** `[n/m]` 单元格：只读页码。 */
  @Builder
  pageLabelCell(width: number) {
    Row() {
      Text(`${this.pageIndex() + 1}/${this.pageTotal()}`)
        .width('100%')
        .height(RAIL_ITEM_HEIGHT)
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.None })
        .textAlign(TextAlign.Center)
        .fontColor($r('app.color.text_primary'))
    }
    .width(width)
    .height(RAIL_ITEM_HEIGHT)
    .borderRadius(RADIUS.sm)
    .backgroundColor('#F7F8FA')
    .clip(true)
    .flexShrink(0)
  }

  /** `[‹|›]` 单元格：左半上一页（首页禁用）、右半下一页（末页禁用）。 */
  @Builder
  prevNextCell(width: number) {
    Row() {
      Text('‹')
        .layoutWeight(1)
        .height(RAIL_ITEM_HEIGHT)
        .fontSize(FONT.body)
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
        .height(RAIL_ITEM_HEIGHT)

      Text('›')
        .layoutWeight(1)
        .height(RAIL_ITEM_HEIGHT)
        .fontSize(FONT.body)
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
    .height(RAIL_ITEM_HEIGHT)
    .borderRadius(RADIUS.sm)
    .backgroundColor('#F7F8FA')
    .clip(true)
    .flexShrink(0)
  }

  /**
   * 「完成」：唯一主操作，实底品牌蓝 + 白字、不收缩。
   *
   * 真机缺陷：rail 里 56vp 宽时 Button 内部 padding 把 2 个字挤成「...」。
   * 现在：竖屏固定 64vp 宽（横屏改用 `railFinishButton()`），并显式给 4vp 左右 padding，
   * 否则 Button 默认内边距会把 2 个字挤成「...」。
   */
  @Builder
  finishButton() {
    Button(this.busy ? '识别中' : '完成')
      .height(TOOL_HEIGHT)
      .width(FINISH_MIN_WIDTH)
      .constraintSize({ minWidth: FINISH_MIN_WIDTH })
      .padding({ left: SPACING.xs, right: SPACING.xs })
      .fontSize(FONT.caption)
      .backgroundColor($r('app.color.brand'))
      .fontColor(Color.White)
      .enabled(!this.busy)
      .flexShrink(0)
      .onClick(() => {
        this.finish();
      })
  }

  /**
   * 「‹」退出：**暂存草稿后返回**（不二次确认）。
   *
   * 用户诉求：「退出后应该要暂存当前手写页的所有内容，可以后续进入再修改，
   * 完成才是按照要求做 OCR」——所以退出只存草稿，不触发识别。
   */
  @Builder
  exitButton() {
    Text('‹')
      .width(EXIT_SIZE)
      .height(TOOL_HEIGHT)
      .constraintSize({ minWidth: EXIT_SIZE })
      .fontSize(FONT.title)
      .lineHeight(LINE_HEIGHT.title)
      .maxLines(1)
      .textOverflow({ overflow: TextOverflow.None })
      .textAlign(TextAlign.Center)
      .borderRadius(RADIUS.sm)
      .backgroundColor('#F1F3F5')
      .fontColor($r('app.color.text_primary'))
      .flexShrink(0)
      .onClick(() => {
        this.exitWritingBoard();
      })
  }

  /**
   * 竖屏：顶部单行工具条（48vp）——**四段固定布局，分页组不参与横向滚动**：
   *
   * ```
   * [‹ 退出] [Scroll: 钢笔▾ 3.5▾ 黑▾ 橡皮 手动框 ↶ ↷] [ [−|+] [1/1] [‹|›] ] [完成]
   * ```
   * 之前分页组塞在 Scroll 里，真机上 `‹` 被 Scroll 边缘裁成 20px、`›` 完全不可见；
   * 现在三个单元格固定在 `完成` 左侧，只有中间那 7 个工具按钮横向滚动。
   */
  @Builder
  topBar() {
    Row({ space: SPACING.xs }) {
      this.exitButton()

      // 「笔迹设置」：笔形/粗细/颜色三合一入口，固定在 Scroll 之外（主操作，不被滚走）
      this.brushMenuButton()

      Scroll() {
        Row({ space: SPACING.xs }) {
          this.toolButton('橡皮', HW_TOOL_ERASER)
          this.toolButton('手动框', HW_TOOL_SELECT)
          this.historyButton('undo', '↶', this.pagerState.undoSteps > 0)
          this.historyButton('redo', '↷', this.pagerState.redoAvailable)
        }
        .height(TOOL_HEIGHT)
        .alignItems(VerticalAlign.Center)
      }
      .scrollable(ScrollDirection.Horizontal)
      .scrollBar(BarState.Off)
      .layoutWeight(1)
      .height(TOOL_HEIGHT)
      .align(Alignment.Start)

      // 分页三单元格：Scroll 之外、完成左侧，固定可见
      this.pageStepper()

      this.finishButton()
    }
    .width('100%')
    .height(TOP_BAR_HEIGHT)
    .padding({ left: SPACING.sm, right: SPACING.sm })
    .backgroundColor($r('app.color.page_background'))
    .alignItems(VerticalAlign.Center)
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
   * 横屏：最左侧竖排 rail（72vp 内容 + 1vp 分割线）。
   *
   * 11 项：`‹` 退出 + 笔形/粗细/颜色 + 橡皮 + 手动框 + ↶ + ↷ + **三个分页单元格**
   * （`[−|+]` / `[n/m]` / `[‹|›]`），`完成` 用 `Blank()` 压到底部固定可见。
   *
   * 高度核算：11×44 + 10×2(间距) = 504，再加完成 44 + 间距 2 + 上下 padding 16 ≈ **566vp**
   * ≤ 真机 rail 可用 ≈601vp ⇒ 不需要 Scroll，「完成」也不会被挤出屏幕。
   */
  @Builder
  railBar() {
    Row() {
      Column({ space: RAIL_GAP }) {
        // 横屏专用一套按钮：**统一 72vp 宽（100%）+ 高 44vp（退出 40）+ 同圆角/同底色**
        this.railExitButton()
        this.railBrushButton()
        this.railToolButton('橡皮', HW_TOOL_ERASER)
        this.railToolButton('手动框', HW_TOOL_SELECT)
        this.railHistoryButton('undo', '↶', this.pagerState.undoSteps > 0)
        this.railHistoryButton('redo', '↷', this.pagerState.redoAvailable)
        // 分页三单元格：宽度同为 72vp（CELL_WIDTH == RAIL_WIDTH），与上面按钮等宽
        this.insertDeleteCell(CELL_WIDTH)
        this.pageLabelCell(CELL_WIDTH)
        this.prevNextCell(CELL_WIDTH)
        Blank()
        this.railFinishButton()
      }
      .width(RAIL_WIDTH)
      .height('100%')
      .padding({ top: SPACING.sm, bottom: SPACING.sm })
      .backgroundColor(RAIL_BG)
      .alignItems(HorizontalAlign.Center)

      // 与画布之间的 1vp 分割线（用户反馈：工具条与画布「糊在一起」）
      Divider()
        .vertical(true)
        .strokeWidth(DIVIDER)
        .color($r('app.color.divider'))
        .height('100%')
    }
    .width(RAIL_WIDTH + DIVIDER)
    .height('100%')
    .alignItems(VerticalAlign.Top)
  }

  // ------------------------------------------------------------------ 横屏 rail 专用按钮（统一 100% × 44vp）

  /** rail 顶部「‹」退出：固定 72×40、不参与滚动（与竖屏同一个动作：存草稿 → 返回）。 */
  @Builder
  railExitButton() {
    Text('‹')
      .width('100%')
      .height(TOOL_HEIGHT)
      .fontSize(FONT.title)
      .lineHeight(LINE_HEIGHT.title)
      .maxLines(1)
      .textOverflow({ overflow: TextOverflow.None })
      .textAlign(TextAlign.Center)
      .borderRadius(RADIUS.sm)
      .backgroundColor('#F1F3F5')
      .fontColor($r('app.color.text_primary'))
      .flexShrink(0)
      .onClick(() => {
        this.exitWritingBoard();
      })
  }

  /** rail「笔迹设置」按钮：宽 100%（=72vp）、高 44vp、内容居中，文案带 笔形·档位·色名 + 12×12 色块。 */
  @Builder
  railBrushButton() {
    Row({ space: 2 }) {
      Text(this.inkSummary())
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.None })
        .fontColor(this.panel === PANEL_INK ? Color.White : $r('app.color.text_primary'))
      Text('')
        .width(12)
        .height(12)
        .borderRadius(3)
        .backgroundColor(this.pagerState.penColor)
        .border({ width: 1, color: this.panel === PANEL_INK ? Color.White : '#DDDDDD' })
        .margin({ left: 2 })
      Text('▾')
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.None })
        .fontColor(this.panel === PANEL_INK ? Color.White : $r('app.color.text_secondary'))
    }
    .justifyContent(FlexAlign.Center)
    .width('100%')
    .height(RAIL_ITEM_HEIGHT)
    .borderRadius(RADIUS.sm)
    .backgroundColor(this.panel === PANEL_INK ? $r('app.color.brand') : '#F1F3F5')
    .onClick(() => {
      this.togglePanel(PANEL_INK);
    })
  }

  /** rail 的橡皮 / 手动框：与竖屏语义一致（再点回画笔），尺寸统一。 */
  /** rail 的橡皮 / 手动框：与竖屏语义一致（再点回画笔），尺寸统一。 */
  @Builder
  railToolButton(label: string, tool: string) {
    Text(label)
      .width('100%')
      .height(RAIL_ITEM_HEIGHT)
      .fontSize(FONT.caption)
      .lineHeight(LINE_HEIGHT.caption)
      .maxLines(1)
      .textOverflow({ overflow: TextOverflow.None })
      .textAlign(TextAlign.Center)
      .borderRadius(RADIUS.sm)
      .backgroundColor(this.pagerState.tool === tool ? '#E8F1FF' : '#F1F3F5')
      .fontColor(this.pagerState.tool === tool ? $r('app.color.brand') : $r('app.color.text_primary'))
      .border({ width: this.pagerState.tool === tool ? 1 : 0, color: $r('app.color.brand') })
      .onClick(() => {
        this.toggleTool(tool);
      })
  }

  /** rail 的撤销 / 重做。 */
  @Builder
  railHistoryButton(kind: string, label: string, enabled: boolean) {
    Text(label)
      .width('100%')
      .height(RAIL_ITEM_HEIGHT)
      .fontSize(FONT.body)
      .maxLines(1)
      .textOverflow({ overflow: TextOverflow.None })
      .textAlign(TextAlign.Center)
      .borderRadius(RADIUS.sm)
      .backgroundColor('#EEF1F4')
      .fontColor(enabled ? $r('app.color.text_primary') : $r('app.color.text_secondary'))
      .enabled(enabled)
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

  /** rail 底部「完成」：72×44 实底品牌蓝 + 白字，固定底部、不压缩、不参与滚动。 */
  @Builder
  railFinishButton() {
    Button(this.busy ? '识别中' : '完成')
      .width(CELL_WIDTH)
      .height(RAIL_ITEM_HEIGHT)
      .borderRadius(RADIUS.sm)
      .constraintSize({ minWidth: FINISH_MIN_WIDTH })
      .fontSize(FONT.caption)
      .backgroundColor($r('app.color.brand'))
      .fontColor(Color.White)
      .enabled(!this.busy)
      .flexShrink(0)
      .onClick(() => {
        this.finish();
      })
  }

  // ------------------------------------------------------------------ 二级面板（绝对定位浮层，不挤压画布）

  /** 面板锚点：竖屏在工具条下方、横屏在 rail 右侧（都不碰画布中心）。 */
  private panelLeft(): number {
    // 横屏：rail（72）+ 1vp 分割线 + 8vp 间距；竖屏：贴工具条左边 8vp
    return this.landscape ? RAIL_WIDTH + DIVIDER + SPACING.sm : SPACING.sm;
  }

  private panelTop(): number {
    if (this.landscape) {
      // rail 里第 1 个按钮是「笔迹设置」、第 2 个是「颜色」（rail 控件统一 44vp 高）
      const index: number = this.panel === PANEL_INK ? 0 : 1;
      return SPACING.sm + index * (RAIL_ITEM_HEIGHT + SPACING.xs);
    }
    return TOP_BAR_HEIGHT + DIVIDER + SPACING.xs;
  }

  /** 面板宽度（按内容给足，避免文字被截断）。 */
  private panelWidth(): number {
    if (this.panel === PANEL_INK) {
      return INK_PANEL_MIN_WIDTH + 2 * SPACING.sm;
    }
    return 156;
  }

  /** 选中行底色。 */
  private rowBackground(selected: boolean): ResourceColor {
    return selected ? '#E8F1FF' : Color.Transparent;
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
                this.pagerState.brush === spec.kind && this.pagerState.tool === HW_TOOL_BRUSH ? '#E8F1FF' : '#F5F6F8'
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
              .backgroundColor(this.pagerState.penWidth === width ? '#E8F1FF' : Color.Transparent)
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
                    color: this.pagerState.penColor === color ? $r('app.color.brand') : '#DDDDDD'
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
              .backgroundColor(this.pagerState.penColor === color ? '#E8F1FF' : Color.Transparent)
              .onClick(() => {
                this.pickColor(color);
              })
            },
            (color: string) => `ink-color-${color}`
          )
        }
        .width('100%')
        .height(CHIP_HEIGHT)
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
        // rail 容器 = 72vp 内容 + 1vp 分割线（分割线在 railBar 内部，宽度也算进来）
        .width(this.landscape ? RAIL_WIDTH + DIVIDER : 0)
        .height('100%')
        .clip(true)

        Column() {
          Column() {
            this.topBar()
            this.topBarDivider()
          }
          .height(this.landscape ? 0 : TOP_BAR_HEIGHT + DIVIDER)
          .clip(true)

          HandwritingPager({
            state: this.pagerState,
            maxPages: MAX_HANDWRITING_PAGES,
            // 页码/撤销可用性都直接读 pagerState（唯一真相源）；这个回调只用来**触发重绘**
            onStateChange: () => {
              this.touchUi();
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
