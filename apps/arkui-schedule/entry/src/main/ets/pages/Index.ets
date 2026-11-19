/**
 * 主页：日期条 + 今日待办/全部未完成 + 列表（左勾选 / 中标题+时间 / 右手迹）+ 「新建」主操作
 * + 页头唯一动作「⚙ 设置」。
 *
 * ## 页头 AI 汇总入口已删除（用户反馈：点了没反应，但图标还占着位置）
 * AI 汇总本来就是**列表第一项**（`SummaryCard`，数据源 `summaryStore.read` / `generate`），
 * 页头再放一个 AI 汇总图标属于同一动作两处入口，且点了没有可见反馈。现在页头只留
 * `今天`（左）+ `⚙ 设置`（右），中间不放任何空按钮；AI 汇总只能从汇总块进入
 * （空态「生成汇总」/ 失败态「重试」/「重新生成」/「查看全部」/ 点标题与要点）。
 * 守卫测试：`tools/test/indexHeader.test.mjs`。
 *
 * 契约：BRIEF §3.5、`docs/CONTRACT.md` §3.4：
 * - 勾选完成 = `appendRecord` 追加一条同 id 新记录（ts=nowIso()），绝不改写历史行；
 * - 「AI 汇总」读当天 `ai_processed:false` 的记录，允许逐条取消勾选（结果面板里可「重选」）；
 * - 同步配置（仓库/token/含其他设备/立即同步/推送/测试连接）全部在设置页，首页不再提供入口；
 * - 日历提醒功能已按用户要求删除（UI 侧调用点与文案已移除）。
 *
 * 布局：断点由 `PageLayout` 统一计算（`onAreaChange` + 方向），本页只做一处粗粒度分支
 * `breakpoint === 'compact'`：紧凑屏单列（日期条在上面），宽屏/横屏双栏（左日期条、右列表）。
 *
 * 每日 AI 汇总为**手动触发**（BRIEF §3.4）：不做定时汇总。原因：鸿蒙侧 `setInterval` 在应用
 * 退到后台后会被系统回收，纯 TS 定时器无法保证按时触发；真要做定时汇总，必须申请长时任务
 * （`continuousTask`）+ 前台通知，或在到点拉起应用后由用户点触发。这里刻意不加
 * 「看起来能用、实际会被回收」的定时器。
 *
 * ## 搜索 / 筛选（Wave 2-A）
 * - 列表顶部：搜索框（标题/正文/OCR/作者，大小写不敏感、多关键词 AND）+ 状态 chips
 *   （全部/未完成/已完成）+ 作者 chips（来自 `authorsOf`）；
 * - **与「今日待办|全部未完成」tab 正交**：先按 tab 取数（`scheduleStore.readDay` /
 *   `openIndexStore.pendingRecords`），再 `applyQuery` 过滤（见 `model/query.ts`，纯逻辑可单测）；
 * - 列表真正渲染的是 `visibleRecords`；`records` 仍是 tab 级全量（汇总块 / 计数 / AI 面板用它）。
 *
 * ## 删除 + 5 秒撤销（Wave 2-A）
 * - 入口：行尾「删除」按钮（`RecordRow.onDelete`）+ 右栏详情的「删除」（`RecordDetailView.onDelete`）；
 * - 删除 = 追加一条 `deleted:true` 的同 id 新版本（软删除，见 `model/undoDelete.ts`），读取侧统一过滤；
 * - 删除后列表下方出现 5 秒倒计时条「已删除 · 撤销（Ns）」：点「撤销」再追加 `deleted:false` 版本，
 *   记录恢复；超时倒计时条自动消失（墓碑早已落盘，超时不需要补写）；
 * - 倒计时只是为了给用户一个撤销机会：即使定时器被系统回收（应用退后台），删除结论依然正确。
 */
import { promptAction, router } from '@kit.ArkUI';
import { common } from '@kit.AbilityKit';
import { loadingText, toastMsFor } from '../common/copy';
import { localDateKey, nextTsSameDate, nowIso } from '../common/date';
import { APP_VERSION } from '../common/version';
import { applyAiResult, buildAiPayload } from '../model/aiPayload';
import type { AiPayload, ScheduleRecord } from '../model/types';
import { cloneRecord } from '../model/types';
import { planQuickRecord } from '../model/quickRecord';
import type { QuickRecordPlan } from '../model/quickRecord';
import { SUMMARY_MAX_POINTS, truncateSummaryForDisplay } from '../model/dailySummary';
import type { DailySummary, SummaryDisplay } from '../model/dailySummary';
import { applyQuery, authorsOf, hasKeyword, isFilterActive, makeFilter } from '../model/query';
import type { QueryFilter } from '../model/query';
import { UNDO_TTL_MS, UndoDelete, restoreRecord, softDeleteRecord, withoutDeleted } from '../model/undoDelete';
import { formatDiagnostics } from '../model/stateView';
import type { DiagnosticsInput } from '../model/stateView';
import { SAVED_MARKER_KEY, decodeSavedMarker, containsRecordVersion } from '../model/homeRefresh';
import type { SavedMarker } from '../model/homeRefresh';
import { redactSecrets } from '../model/syncError';
import { describeError, newRecordId, scheduleStore } from '../services/scheduleStore';
import { openIndexStore } from '../services/openIndexStore';
import { summaryStore } from '../services/summaryStore';
import { settingsStore } from '../services/settingsStore';
import { deviceTimeZone, summarize } from '../services/deepseek';
import { PageLayout } from '../components/PageLayout';
import { GitBridgeHost } from '../components/GitBridgeHost';
import { syncController } from '../services/syncController';
import type { SyncOutcome } from '../services/syncController';
import { webview } from '@kit.ArkWeb';
import { RecordDetailView } from '../components/RecordDetailView';
import { RecordEditorView } from '../components/RecordEditorView';
import { RecordRow } from '../components/RecordRow';
import { ActionButton } from '../components/ActionButton';
import { MonthCalendar } from '../components/MonthCalendar';
import { QuickRecordBar } from '../components/QuickRecordBar';
import { LoadingState } from '../components/state/LoadingState';
import { EmptyState } from '../components/state/EmptyState';
import { ErrorState } from '../components/state/ErrorState';
import {
  DIVIDER,
  FONT,
  HOME_INCLUDE_OTHER_KEY,
  LINE_HEIGHT,
  RADIUS,
  SPACING,
  TOUCH_MIN,
  isMasterDetailWidth,
  masterPaneWidth
} from '../common/uiTokens';

/** `YYYY-MM-DD` → 本地 Date（避免 `new Date('2026-11-14')` 按 UTC 解析造成偏移）。 */
function dateFromKey(key: string): Date {
  const parts = key.split('-');
  if (parts.length !== 3) {
    return new Date();
  }
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(day)) {
    return new Date();
  }
  return new Date(year, month - 1, day);
}

/** 主操作按钮高度（> `TOUCH_MIN`，唯一强调色块）。 */
const PRIMARY_HEIGHT: number = 48;

/** 宽屏左栏「新建」按钮宽度（vp）：固定 240 左对齐，占满整列会显得笨重。 */
const SIDEBAR_ACTION_WIDTH: number = 240;

/** 宽屏列表最大宽度（vp）：超过后居中留白，避免单条记录横跨整个宽屏（720vp ≈ 14fp 下 45–50 字/行）。 */
const LIST_MAX_WIDTH: number = 720;

/** 两位补零（本地 HH:MM 展示用）。 */
function two(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

@Entry
@Component
struct Index {
  /** 当前查看的日期（今日待办模式）。 */
  @State selectedDate: string = localDateKey(new Date());
  /** 是否展开日期选择器。 */
  @State showDatePicker: boolean = false;
  /** false=今日待办；true=全部未完成。 */
  @State showAllPending: boolean = false;
  /** true=同时折叠展示其他设备目录（pull 后只读展示，写入仍只进本机目录）。 */
  @State includeOtherDevices: boolean = false;
  /** 列表数据（每次操作后重读存储，保证跨设备/追加语义一致）。 */
  @State records: ScheduleRecord[] = [];
  @State statusText: string = '';
  /** 下拉刷新中的转圈状态（`Refresh` 组件用 `$$` 双向绑定）。 */
  @State refreshing: boolean = false;
  @State ready: boolean = false;
  /** 快捷记录保存中（防重复提交；appendRecord 同步完成，正常一闪而过）。 */
  @State quickBusy: boolean = false;

  // 搜索 / 筛选状态（与 tab 正交：tab 决定数据源，这里只过滤）
  /** 搜索框原始输入（匹配时才做 trim / 小写 / 空白折叠）。 */
  @State queryText: string = '';
  /** 状态筛选：`all` / `open` / `done`（字符串，避免在 .ets 里写联合类型断言）。 */
  @State statusFilter: string = 'all';
  /** 作者筛选（空串 = 全部作者；再点一次同一个 chip 取消）。 */
  @State authorFilter: string = '';
  /** 作者 chips（来自 `authorsOf(records)`，随 tab/日期变化）。 */
  @State authorChips: string[] = [];
  /** 过滤后的列表（列表真正渲染的数据源）。 */
  @State visibleRecords: ScheduleRecord[] = [];
  /** 是否有搜索词（决定空态文案用「没有匹配…」还是「没有符合筛选条件…」）。 */
  @State hasSearchWord: boolean = false;
  /** 是否有任何筛选条件（关键词 / 状态 / 作者）。 */
  @State hasActiveFilter: boolean = false;

  // 删除 + 5 秒撤销
  /** 待撤销删除的记录 id（空串 = 没有 → 倒计时条不渲染）。 */
  @State undoId: string = '';
  /** 待撤销记录的标题（倒计时条文案用）。 */
  @State undoTitle: string = '';
  /** 剩余毫秒（每 200ms 刷新一次，驱动「撤销（Ns）」重绘）。 */
  @State undoLeftMs: number = 0;

  /** 断点（由 `PageLayout` 回调同步，页面只按 compact / 非 compact 分支）。 */
  @State breakpoint: string = 'compact';
  /** 内容区宽度（vp），宽屏下算侧栏宽度。 */
  @State contentWidth: number = 0;
  /** 是否走左右主从（内容宽 ≥ 840vp）；`false` = 单列，点行进详情页/编辑页。 */
  @State masterDetail: boolean = false;

  // 主从布局（横屏/宽屏）右栏状态
  /** 右栏当前模式：`empty`（未选）/ `detail`（选中记录）/ `editor`（新建或编辑）。 */
  @State paneMode: string = 'empty';
  /** 左栏选中的记录 id（空串 = 未选）。 */
  @State selectedId: string = '';
  /** 右栏编辑器的目标 id（空串 = 新建）。 */
  @State editorRecordId: string = '';
  /** 右栏编辑器是否有未保存内容（切选中行时用来提示）。 */
  @State editorDirty: boolean = false;
  /** 右栏子组件重读触发器（保存/取消/手写板返回后 +1）。 */
  @State paneTick: number = 0;
  /** 右栏下拉刷新状态（与左栏的 `refreshing` 各管各的，互不干扰）。 */
  @State paneRefreshing: boolean = false;

  // AI 汇总面板状态
  @State showAiPanel: boolean = false;
  @State aiCandidates: ScheduleRecord[] = [];
  @State aiSelected: string[] = [];
  @State aiPanelDate: string = '';
  @State aiBusy: boolean = false;
  @State aiResultVisible: boolean = false;
  @State aiResultText: string = '';

  // 「今日汇总」块（列表第一项）的展示状态。
  // 单一数据源 = `summaryStore.read(date)`（落盘在 devices/<id>/summaries/<date>.json），
  // 仅把读到的结果物化到下面这几个 @State 供渲染；`aiResultText` 同时供「查看全部」面板使用。
  /** 汇总标题；空串 = 这一天还没有汇总。 */
  @State summaryHeadline: string = '';
  /** 正文要点（最多展示 3 条）。 */
  @State summaryPoints: string[] = [];
  /** 要点总条数（>3 时显示「查看全部」）。 */
  @State summaryPointTotal: number = 0;
  /** 更新时间（HH:MM）。 */
  @State summaryUpdatedAt: string = '';
  /** 生成失败的一行文案；空串 = 无错误。 */
  @State summaryError: string = '';
  /**
   * AI 候选面板里的失败原因（空串 = 无错误）。
   *
   * 为什么和 `summaryError` 分开：`runAi()` 的失败原先只弹 5 秒 toast，面板一关/一过就再也
   * 看不到原因（用户在面板里点「开始汇总」，toast 消失后面板还在，却不知道刚才是为什么失败）。
   * toast 保留（即时反馈），这条 @State 负责「可复读」。
   */
  @State aiPanelError: string = '';

  /** 撤销状态机（纯内存，5 秒窗口；墓碑在删除那一刻已落盘）。 */
  private undoState: UndoDelete = new UndoDelete();
  /**
   * 删除时落盘的墓碑版本。
   *
   * 撤销以它为底（它是该 id 的最新记录），因此不需要再读盘 —— 读取侧已过滤墓碑，
   * 从这里恢复字段最省事，也不会把「删除前的快照」和「删除后别人的修改」搞混。
   */
  private pendingTombstone: ScheduleRecord | null = null;
  /** 倒计时定时器 id（-1 = 未启动）。 */
  private undoTimer: number = -1;

  aboutToAppear(): void {
    this.syncHomeFilter();
    this.bootstrap();
  }

  /** 页面销毁：停掉撤销倒计时（墓碑已落盘，不需要任何补写）。 */
  aboutToDisappear(): void {
    this.clearUndoTimer();
    this.undoState.reset();
    this.pendingTombstone = null;
  }

  /** 隐藏桥就绪：启动自动 pull（节流；失败只提示，不阻塞任何 UI）。 */
  private onBridgeReady(controller: webview.WebviewController): void {
    syncController.ensureStarted(controller).then(() => {
      if (!syncController.isReady()) {
        // 桥没真正就绪（注册失败等）：不做同步，只记录原因
        console.info('[sync] bridge not ready, skip startup pull');
        return;
      }
      syncController.pullOnStartup().then((outcome: SyncOutcome) => {
        console.info(`[sync] startup pull ok=${outcome.ok} elapsed=${outcome.elapsedMs}ms skipped=${outcome.skipped}`);
        if (!outcome.ok && !outcome.skipped) {
          promptAction.showToast({ message: `同步失败：${outcome.message}`, duration: 3000 });
        }
      });
    });
  }

  /** 下拉刷新：立即 pull 一次，然后重读列表。 */
  private async onPullRefresh(): Promise<void> {
    const outcome: SyncOutcome = await syncController.pullNow();
    console.info(`[sync] refresh pull ok=${outcome.ok} elapsed=${outcome.elapsedMs}ms`);
    this.reload();
    this.loadSummary();
    if (!outcome.ok) {
      promptAction.showToast({ message: `同步失败：${outcome.message}`, duration: 3000 });
    }
  }

  /** 从编辑页/设置页返回时重新加载（追加写语义下必须重读）。 */
  onPageShow(): void {
    // 「含其他设备」开关归设置页管，回来时同步一次
    this.syncHomeFilter();
    if (this.ready) {
      const saved: SavedMarker | null = this.consumeSavedMarker();
      if (saved !== null) {
        // 保存返回：只重读列表（写盘与派生索引在 appendRecord 内已同步完成），
        // 不再**直接**跑 reconcileIfDue 全量对账、不重读汇总、不推进 paneTick。
        // 注：「全部未完成」tab 的 reload() 走 pendingRecords()，它内部仍会做一次
        // 被 15s 节流的索引自愈（openIndexStore.ets），这里省掉的是首页自己那次显式调用。
        this.reload();
        this.reconcileSavedRow(saved);
        return;
      }
      // 从设置页 pull 回来也走这里：顺手做一次带节流的索引自愈，保证「全部未完成」数据是新的
      openIndexStore.reconcileIfDue();
      this.reload();
      this.loadSummary();
      this.paneTick = this.paneTick + 1;
      return;
    }
    summaryStore
      .ensureReady(getContext(this) as common.UIAbilityContext)
      .then(() => {
        this.ready = true;
        openIndexStore.reconcileIfDue();
        this.reload();
        this.loadSummary();
        this.paneTick = this.paneTick + 1;
      })
      .catch((error: Error) => {
        this.statusText = `存储初始化失败：${describeError(error)}`;
      });
  }

  /**
   * 取出并立刻清掉一次性「保存返回」标记。
   *
   * 一次性：读后即清，避免下一次从设置页返回被误判成保存返回
   * （从设置页返回仍要走全量对账 + 重读汇总）。
   */
  private consumeSavedMarker(): SavedMarker | null {
    const raw: string | undefined = AppStorage.get<string>(SAVED_MARKER_KEY);
    AppStorage.setOrCreate<string>(SAVED_MARKER_KEY, '');
    return decodeSavedMarker(raw);
  }

  /**
   * 保存返回、局部 `reload()` 之后对账刚保存的那一行（**不许静默**）。
   *
   * 三种情况直接返回（不需要额外开销，也不打扰用户）：
   * - 「全部未完成」里 `saved.done=true`：已完成的记录本来就不在该 tab；
   * - 非「全部未完成」且保存的是别的日期：当前列表本就不该出现它；
   * - 列表里已有同 id 且 `ts` 不早于标记 ts 的新版本：数据已是刚保存的最新版。
   * 兜底（读不到刚保存的版本）才全量重建，并明确 toast 告知用户。
   */
  private reconcileSavedRow(saved: SavedMarker): void {
    if (this.showAllPending && saved.done === true) {
      return;
    }
    if (!this.showAllPending && saved.date !== this.selectedDate) {
      return;
    }
    if (containsRecordVersion(this.records, saved.id, saved.ts)) {
      return;
    }
    openIndexStore.reconcile();
    this.reload();
    this.loadSummary();
    promptAction.showToast({
      message: '返回列表时没读到刚保存的日程，已重新加载',
      duration: toastMsFor(true)
    });
  }

  private async bootstrap(): Promise<void> {
    try {
      // summaryStore.ensureReady 内部会先 ensureReady(scheduleStore)，这里两处都调以保持幂等与顺序清晰
      await scheduleStore.ensureReady(getContext(this) as common.UIAbilityContext);
      await summaryStore.ensureReady(getContext(this) as common.UIAbilityContext);
      await openIndexStore.ensureReady(getContext(this) as common.UIAbilityContext);
      // 启动自愈：「全部未完成」读索引，这里先把索引与最近 30 天分片对齐（无漂移则不写盘）
      openIndexStore.reconcile();
      this.ready = true;
      this.reload();
      this.loadSummary();
    } catch (error) {
      this.ready = false;
      this.statusText = `存储初始化失败：${describeError(error)}`;
    }
  }

  /**
   * 读存储并刷新列表与状态文案。
   *
   * 数据流：tab 取数（`records`）→ 搜索/筛选（`visibleRecords`）。两者正交：
   * 切 tab / 换日期只换数据源，筛选条件保留；改筛选只重算 `visibleRecords`，不重读磁盘。
   */
  private reload(): void {
    if (!this.ready) {
      return;
    }
    try {
      if (this.showAllPending) {
        // 数据源：每台设备读自己的 open.jsonl（N 台设备 = N 个小文件）；某台设备缺索引时
        // 在内存里用它的分片重建，绝不写别人的设备目录（契约：每台设备只写自己的目录）。
        // 墓碑过滤：本机走 readDay 时已过滤；跨设备的内存重建读的是原始分片，这里再兜一层。
        const pending: ScheduleRecord[] = withoutDeleted(openIndexStore.pendingRecords(this.includeOtherDevices));
        this.records = pending;
        this.statusText = pending.length === 0 ? '所有日程都已完成' : `共 ${pending.length} 条未完成（跨全部日期${this.includeOtherDevices ? '与全部设备' : ''}）`;
      } else {
        const day: ScheduleRecord[] = withoutDeleted(
          this.includeOtherDevices
            ? scheduleStore.readDayAllDevices(this.selectedDate)
            : scheduleStore.readDay(this.selectedDate)
        );
        this.records = day;
        let doneCount = 0;
        for (const record of day) {
          if (record.done === true) {
            doneCount++;
          }
        }
        this.statusText = day.length === 0 ? '这一天还没有日程' : `共 ${day.length} 条 · 已完成 ${doneCount} 条${this.includeOtherDevices ? ' · 含其他设备（只读）' : ''}`;
      }
    } catch (error) {
      this.records = [];
      this.statusText = `读取日程失败：${describeError(error)}`;
    }
    this.refreshQuery();
    this.pruneSelection();
  }

  /** 刷新后如果选中的记录已不在列表里（被删/换日期）→ 右栏回空态。 */
  private pruneSelection(): void {
    if (this.selectedId.length === 0 || this.paneMode === 'editor') {
      return;
    }
    let found = false;
    for (const record of this.records) {
      if (record.id === this.selectedId) {
        found = true;
        break;
      }
    }
    if (!found) {
      this.selectedId = '';
      this.paneMode = 'empty';
    }
  }

  /** 页头标题：只给相对标签（今天 / 全部未完成 / 日程），具体日期归左栏或日期条，避免同一信息出现两次。 */
  private pageTitle(): string {
    if (this.showAllPending) {
      return '全部未完成';
    }
    return this.selectedDate === localDateKey(new Date()) ? '今天' : '日程';
  }

  /** 页头副标题：只在有统计意义（或有错误）时显示；空态文案归列表，避免两处重复。 */
  private subtitleText(): string {
    if (this.records.length > 0 || this.statusText.indexOf('失败') >= 0) {
      // 有筛选条件时补一句「筛选出 K 条」，让「列表比 tab 计数少」有解释
      if (this.hasActiveFilter && this.records.length > 0) {
        return `${this.statusText} · 筛选出 ${this.visibleRecords.length} 条`;
      }
      return this.statusText;
    }
    return '';
  }

  /** 星期几（辅助信息，跟着日期走）。 */
  private weekdayLabel(): string {
    const names: string[] = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    return names[dateFromKey(this.selectedDate).getDay()];
  }

  private shiftDate(delta: number): void {
    const base = dateFromKey(this.selectedDate);
    base.setDate(base.getDate() + delta);
    this.selectedDate = localDateKey(base);
    this.showAllPending = false;
    this.reload();
    this.loadSummary();
  }

  private goToday(): void {
    this.selectedDate = localDateKey(new Date());
    this.showAllPending = false;
    this.showDatePicker = false;
    this.reload();
    this.loadSummary();
  }

  /**
   * 日历选中日期：复用 `MonthCalendar.onPick` 回传的 `YYYY-MM-DD` 键（选择器只发合法键），
   * 行为与原 `DatePicker.onDateChange` 完全一致，仅换控件。
   */
  private pickDate(dateKey: string): void {
    // 空串/非法宽度不应来自选择器；防御性早退且不打扰用户（合法键由选择器保证，无需提示）。
    if (dateKey.length !== 10) {
      return;
    }
    this.selectedDate = dateKey;
    this.showDatePicker = false;
    this.showAllPending = false;
    this.reload();
    this.loadSummary();
  }

  private openNew(): void {
    const params: Record<string, string> = { 'id': '', 'date': this.selectedDate };
    router.pushUrl({ url: 'pages/Edit', params: params }).catch((error: Error) => {
      promptAction.showToast({ message: `打开编辑页失败：${describeError(error)}` });
    });
  }

  // ------------------------------------------------------------------ 首页快捷记录（列表区一行落盘，不进编辑页）

  /**
   * 快捷记录的作者：与 `RecordEditorView` 同一来源（`settings.author`，空则「我」），但走
   * `settingsStore.cached()` 这个**同步**读取口。`bootstrap()` 里的 `scheduleStore.ensureReady()`
   * 已经 `await settingsStore.load()` 填好缓存（下面还挡了一层 `isReady()`），所以点击路径
   * 零异步、零等待，不需要在保存时再读一次偏好设置。
   */
  private defaultAuthorOrMe(): string {
    const settings = settingsStore.cached();
    if (settings !== null && settings.author.trim().length > 0) {
      return settings.author.trim();
    }
    return '我';
  }

  /**
   * 保存快捷记录：纯标题 + 当前所选日期，走与编辑页相同的 `appendRecord` 落盘链。
   *
   * 返回 `boolean` 给 `QuickRecordBar`：成功才清空输入框，失败保留原文供重试。
   * 不写 `SAVED_MARKER_KEY`（那是「编辑页保存返回」的一次性标记，本路径不返回列表）；
   * 派生索引在 `appendRecord` 内已同步更新，这里直接 `reload()` + `loadSummary()` 刷新首页。
   */
  private submitQuickRecord(rawTitle: string): boolean {
    const plan: QuickRecordPlan = planQuickRecord(rawTitle, this.selectedDate, new Date());
    if (!plan.ok) {
      promptAction.showToast({ message: plan.reason, duration: toastMsFor(true) });
      return false;
    }
    if (!scheduleStore.isReady()) {
      promptAction.showToast({ message: '存储尚未就绪，请稍后重试' });
      return false;
    }
    const record: ScheduleRecord = {
      id: newRecordId(),
      ts: plan.ts,
      title: plan.title,
      body: '',
      author: this.defaultAuthorOrMe(),
      done: false,
      ai_processed: false
    };
    this.quickBusy = true;
    try {
      scheduleStore.appendRecord(record);
    } catch (error) {
      this.quickBusy = false;
      promptAction.showToast({ message: `保存失败：${describeError(error)}`, duration: toastMsFor(true) });
      return false;
    }
    this.quickBusy = false;
    this.reload();
    this.loadSummary();
    promptAction.showToast({ message: '已记下' });
    return true;
  }

  /** 进设置页：同步配置（仓库/token/含其他设备/立即同步/推送/测试连接）全部在那里。 */
  private openSettings(): void {
    router.pushUrl({ url: 'pages/Settings' }).catch((error: Error) => {
      promptAction.showToast({ message: `打开设置页失败：${describeError(error)}` });
    });
  }

  // ------------------------------------------------------------------ 主从布局交互（仅宽屏/横屏）

  /** 右栏编辑有未保存内容时先确认；确认后清脏标记再执行动作。 */
  private guardEditor(action: () => void): void {
    if (!this.editorDirty) {
      action();
      return;
    }
    promptAction
      .showDialog({
        title: '放弃当前编辑？',
        message: '右栏有未保存的内容，切换后会丢失。',
        buttons: [
          // 颜色一律走资源令牌（深色下系统对话框是深底，写死深灰字会直接看不见）
          { text: '继续编辑', color: $r('app.color.text_primary') },
          { text: '放弃修改', color: $r('app.color.selection_stroke') }
        ]
      })
      .then((result: promptAction.ShowDialogSuccessResponse) => {
        if (result.index === 1) {
          this.editorDirty = false;
          action();
        }
      })
      .catch(() => {
        // 对话框失败：保持当前编辑，不做危险动作
      });
  }

  /** 点列表行：单列（内容宽 <840vp）跳详情页；主从布局切右栏。 */
  private onRowTap(id: string): void {
    if (!this.masterDetail) {
      this.openDetail(id);
      return;
    }
    this.guardEditor(() => {
      this.selectedId = id;
      this.paneMode = 'detail';
      this.paneTick = this.paneTick + 1;
    });
  }

  /** 点「新建」：单列跳编辑页；主从布局右栏直接变编辑表单。 */
  private onNewTap(): void {
    if (!this.masterDetail) {
      this.openNew();
      return;
    }
    this.guardEditor(() => {
      this.editorRecordId = '';
      this.editorDirty = false;
      this.paneMode = 'editor';
      this.paneTick = this.paneTick + 1;
    });
  }

  /** 右栏的「编辑」：切到编辑模式，目标 = 当前选中记录。 */
  private startEditSelected(): void {
    if (this.selectedId.length === 0) {
      return;
    }
    this.editorRecordId = this.selectedId;
    this.editorDirty = false;
    this.paneMode = 'editor';
    this.paneTick = this.paneTick + 1;
  }

  /** 右栏编辑保存成功：刷新左栏并把右栏切到该记录详情。 */
  private onEditorSaved(record: ScheduleRecord): void {
    // 右栏保存也会写标记，这里消费掉，避免之后从设置页返回时误走「保存返回」分支。
    this.consumeSavedMarker();
    this.editorDirty = false;
    this.editorRecordId = '';
    this.selectedId = record.id;
    this.paneMode = 'detail';
    this.reload();
    this.loadSummary();
    this.paneTick = this.paneTick + 1;
  }

  /** 右栏编辑取消：回上一条详情；没有上一条则回空态。 */
  private onEditorCancel(): void {
    this.editorDirty = false;
    this.editorRecordId = '';
    this.paneMode = this.selectedId.length > 0 ? 'detail' : 'empty';
    this.paneTick = this.paneTick + 1;
  }

  /** 「含其他设备」由设置页的开关写 AppStorage，首页返回时读一次（不新增配置项）。 */
  private syncHomeFilter(): void {
    const stored: boolean | undefined = AppStorage.get<boolean>(HOME_INCLUDE_OTHER_KEY);
    this.includeOtherDevices = stored === true;
  }

  // ------------------------------------------------------------------ 今日汇总块（数据源：summaryStore 持久化）

  /** 是否已有可展示的汇总（决定汇总块走 ④「生成」态还是 ⑤「有汇总」态）。 */
  private hasSummary(): boolean {
    return this.summaryHeadline.length > 0;
  }

  /** `generatedAt`（epoch ms）→ 本地 `HH:MM`。 */
  private clockOf(generatedAt: number): string {
    if (!Number.isFinite(generatedAt) || generatedAt <= 0) {
      return '';
    }
    const date = new Date(generatedAt);
    return `${two(date.getHours())}:${two(date.getMinutes())}`;
  }

  /** 把持久化汇总铺到块上（`null` = 该日无汇总 → ④ 态）。 */
  private applySummary(summary: DailySummary | null): void {
    if (summary === null) {
      this.summaryHeadline = '';
      this.summaryPoints = [];
      this.summaryPointTotal = 0;
      this.summaryUpdatedAt = '';
      this.aiResultText = '';
      return;
    }
    const display: SummaryDisplay = truncateSummaryForDisplay(summary, SUMMARY_MAX_POINTS);
    this.summaryHeadline = display.headline;
    this.summaryPoints = display.points;
    this.summaryPointTotal = summary.points.length;
    this.summaryUpdatedAt = this.clockOf(summary.generatedAt);
    // 「查看全部」复用结果面板：正文 = 标题 + 全部要点 + 一行元信息
    const lines: string[] = [];
    if (display.headline.length > 0) {
      lines.push(display.headline);
    }
    for (const point of display.points) {
      lines.push(`· ${point}`);
    }
    lines.push(`共 ${summary.recordCount} 条 · 已完成 ${summary.doneCount} 条 · ${summary.model}`);
    this.aiResultText = lines.join('\n');
  }

  /** 读当前日期的汇总（`aboutToAppear` / 换日期 / 换模式 都走它，单一数据源）。 */
  private loadSummary(): void {
    this.summaryError = '';
    if (!this.ready) {
      this.applySummary(null);
      return;
    }
    try {
      this.applySummary(summaryStore.read(this.selectedDate));
    } catch (error) {
      this.applySummary(null);
      this.summaryError = `读取汇总失败：${describeError(error)}`;
    }
  }

  /**
   * 生成今日汇总并落盘（`summaryStore.generate` 内部保证：失败不覆盖旧文件）。
   *
   * 失败时**不清空**：重新 `read()` 一次旧汇总继续显示，块内只多一行错误 + 重试。
   */
  private async generateSummary(): Promise<void> {
    if (this.aiBusy || this.records.length === 0) {
      return;
    }
    this.summaryError = '';
    this.aiBusy = true;
    try {
      const context = getContext(this) as common.UIAbilityContext;
      let aiKey: string = '';
      let providerId: string = '';
      let model: string = '';
      let baseURL: string = '';
      try {
        const settings = await settingsStore.load(context);
        aiKey = settings.aiKey;
        providerId = settings.aiProviderId;
        model = settings.aiModel;
        baseURL = settings.aiBaseURL;
      } catch (error) {
        this.summaryError = `读取设置失败：${describeError(error)}`;
        return;
      }
      // 全量当天记录（含已处理），不要自己按 ai_processed 过滤
      const dayRecords: ScheduleRecord[] = scheduleStore.readDay(this.selectedDate);
      const saved: DailySummary = await summaryStore.generate(
        dayRecords,
        this.selectedDate,
        aiKey,
        providerId,
        model,
        baseURL
      );
      this.applySummary(saved);
      // 结果真的回来了：清掉「已停止等待」的提示，否则块内会同时显示旧错误与新汇总
      this.summaryError = '';
      // 结果已经进块里了，不自动弹面板（要看全部点汇总块）
      this.aiResultVisible = false;
    } catch (error) {
      // C2 抛中文 Error；旧汇总保持不变 → 重新读回来继续显示
      this.summaryError = describeError(error);
      try {
        this.applySummary(summaryStore.read(this.selectedDate));
      } catch (readError) {
        // 读失败也不清空错误文案
      }
    } finally {
      this.aiBusy = false;
    }
  }

  /**
   * 用户点「取消」停止等待 AI 回复（`LoadingState.onCancel`）。
   *
   * 三条刻意的选择：
   * 1. **不写「已取消」**：取消的是「等待」，请求本身可能已经发出去了，写「已取消」等于假成功；
   * 2. **不宣称结果不会回来**：文案直说「模型回复可能仍会到达」，让用户知道稍后要「重新生成」覆盖；
   * 3. **只置空闲 + 写原因**：结果若真回来了，`generateSummary` 的成功分支会清掉这条提示。
   */
  private cancelAiWait(): void {
    this.aiBusy = false;
    this.summaryError = '已停止等待：模型回复可能仍会到达，稍后点「重新生成」覆盖';
    console.info('[ai] wait cancelled by user');
  }

  /** AI 错误态用的单行诊断（版本 / 设备 / 错误码 / 时间四段永远都在，见 `model/stateView.ts`）。 */
  private aiDiagnostics(): string {
    const input: DiagnosticsInput = {
      version: APP_VERSION,
      deviceId: '',
      errorCode: 'AI_GENERATE',
      timestamp: Date.now()
    };
    return formatDiagnostics(input);
  }

  /** 打开详情页。 */
  private openDetail(id: string): void {
    const params: Record<string, string> = { 'id': id };
    router.pushUrl({ url: 'pages/Detail', params: params }).catch((error: Error) => {
      promptAction.showToast({ message: `打开详情页失败：${describeError(error)}` });
    });
  }

  /** 勾选完成：追加一条同 id、新 ts 的记录（事件溯源，不改历史行）。 */
  private toggleDone(id: string, done: boolean): void {
    let target: ScheduleRecord | null = null;
    for (const record of this.records) {
      if (record.id === id) {
        target = record;
        break;
      }
    }
    if (target === null) {
      this.reload();
      return;
    }
    const next: ScheduleRecord = cloneRecord(target);
    // 保留原记录日期（不迁到当天），时刻严格大于原 ts，保证折叠取到新版本
    next.ts = nextTsSameDate(target.ts);
    next.done = done;
    try {
      scheduleStore.appendRecord(next);
    } catch (error) {
      promptAction.showToast({ message: `保存失败：${describeError(error)}` });
    }
    this.reload();
  }

  // ------------------------------------------------------------------ 搜索 / 筛选

  /** 当前筛选条件（页面的三个字符串状态 → 纯逻辑层 filter）。 */
  private currentFilter(): QueryFilter {
    return makeFilter(this.queryText, this.statusFilter, this.authorFilter);
  }

  /**
   * 重算 `visibleRecords` 与作者 chips（tab 取数之后调用；改筛选时只调它，不重读磁盘）。
   *
   * 作者 chip 已不在当前数据里（换日期 / 切 tab / 记录被删）时自动取消作者筛选，
   * 否则会出现「筛选条件看得见、列表却永远为空」的怪异状态。
   */
  private refreshQuery(): void {
    this.authorChips = authorsOf(this.records);
    if (this.authorFilter.length > 0 && this.authorChips.indexOf(this.authorFilter) < 0) {
      this.authorFilter = '';
    }
    const filter: QueryFilter = this.currentFilter();
    this.visibleRecords = applyQuery(this.records, filter);
    this.hasSearchWord = hasKeyword(filter);
    this.hasActiveFilter = isFilterActive(filter);
  }

  private onQueryTextChange(value: string): void {
    this.queryText = value;
    this.refreshQuery();
  }

  /** 状态 chip：单选；重复点同一个仍是它本身（不做「点第二次取消」，取消走「全部」）。 */
  private pickStatus(status: string): void {
    this.statusFilter = status;
    this.refreshQuery();
  }

  /** 作者 chip：再点一次同一个 author 取消筛选。 */
  private pickAuthor(author: string): void {
    this.authorFilter = this.authorFilter === author ? '' : author;
    this.refreshQuery();
  }

  /** 清空搜索框 + 状态 + 作者（空态里的「清空」与搜索框的「清空」共用）。 */
  private resetFilters(): void {
    this.queryText = '';
    this.authorFilter = '';
    this.statusFilter = 'all';
    this.refreshQuery();
  }

  // ------------------------------------------------------------------ 删除 + 5 秒撤销

  /** 倒计时条上的秒数（向上取整，5 → 0）。 */
  private undoSeconds(): number {
    const seconds: number = Math.ceil(this.undoLeftMs / 1000);
    return seconds > 0 ? seconds : 0;
  }

  /** 在 tab 级数据里按 id 找记录（列表只渲染它的子集，因此一定能找到）。 */
  private findRecordById(id: string): ScheduleRecord | null {
    for (const record of this.records) {
      if (record.id === id) {
        return record;
      }
    }
    return null;
  }

  /**
   * 请求删除：**立刻**追加墓碑（`deleted:true` 的同 id 新版本），然后开 5 秒撤销窗口。
   *
   * 选择「立刻落盘 + 撤销再追加」而不是「延迟删除」：删除结果随时可同步、崩溃不丢；
   * 撤销只是一次普通的反向追加事件，两台设备折叠后结论一致（详见 `model/undoDelete.ts` 文件头）。
   */
  private requestDelete(id: string): void {
    if (!this.ready) {
      promptAction.showToast({ message: '存储尚未就绪，请稍后再试' });
      return;
    }
    let target: ScheduleRecord | null = this.findRecordById(id);
    if (target === null) {
      target = scheduleStore.findByIdAny(id);
    }
    if (target === null) {
      promptAction.showToast({ message: '记录已不存在，列表已刷新' });
      this.reload();
      return;
    }
    const tombstone: ScheduleRecord = softDeleteRecord(target, nextTsSameDate(target.ts));
    try {
      scheduleStore.appendRecord(tombstone);
    } catch (error) {
      promptAction.showToast({ message: `删除失败：${describeError(error)}` });
      return;
    }
    // 顶替上一条待撤销项：它已经落盘，视为「已确认」，只需把界面上的倒计时换掉
    this.undoState.schedule(id, UNDO_TTL_MS);
    this.pendingTombstone = tombstone;
    this.undoId = id;
    const title: string = target.title.trim();
    this.undoTitle = title.length > 0 ? title : '(未命名日程)';
    this.undoLeftMs = this.undoState.remainingMs();
    this.startUndoTimer();
    this.reload();
    this.loadSummary();
  }

  /** 撤销删除：追加 `deleted:false` 的恢复版本（以墓碑为底，字段原样回来）。 */
  private undoDelete(): void {
    const id: string = this.undoState.cancel();
    const tombstone: ScheduleRecord | null = this.pendingTombstone;
    this.clearUndoTimer();
    this.undoId = '';
    this.undoTitle = '';
    this.undoLeftMs = 0;
    this.pendingTombstone = null;
    if (id.length === 0 || tombstone === null) {
      this.reload();
      return;
    }
    const restored: ScheduleRecord = restoreRecord(tombstone, nextTsSameDate(tombstone.ts));
    try {
      scheduleStore.appendRecord(restored);
      promptAction.showToast({ message: '已撤销删除', duration: 2000 });
    } catch (error) {
      promptAction.showToast({ message: `撤销失败：${describeError(error)}`, duration: 3000 });
    }
    this.reload();
    this.loadSummary();
  }

  /** 超时提交：墓碑早已落盘，这里只关掉撤销机会（不产生任何新写入）。 */
  private finishPendingDelete(): void {
    this.undoState.confirm();
    this.clearUndoTimer();
    this.undoId = '';
    this.undoTitle = '';
    this.undoLeftMs = 0;
    this.pendingTombstone = null;
  }

  /** 启动倒计时：200ms 一跳，到 0 自动提交；页面销毁时清掉。 */
  private startUndoTimer(): void {
    this.clearUndoTimer();
    this.undoTimer = setInterval(() => {
      this.undoLeftMs = this.undoState.remainingMs();
      if (this.undoLeftMs <= 0) {
        this.finishPendingDelete();
      }
    }, 200);
  }

  private clearUndoTimer(): void {
    if (this.undoTimer !== -1) {
      clearInterval(this.undoTimer);
      this.undoTimer = -1;
    }
  }

  // ------------------------------------------------------------------ AI 汇总

  private openAiPanel(): void {
    if (!this.ready) {
      promptAction.showToast({ message: '存储尚未就绪，请稍后再试' });
      return;
    }
    const dayRecords = scheduleStore.readDay(this.selectedDate);
    const payload = buildAiPayload(this.selectedDate, dayRecords);
    if (payload.records.length === 0) {
      promptAction.showToast({ message: '这一天没有需要 AI 整理的记录（或已全部处理）' });
      return;
    }
    const ids: string[] = [];
    for (const item of payload.records) {
      ids.push(item.id);
    }
    const candidates: ScheduleRecord[] = [];
    for (const record of dayRecords) {
      if (ids.indexOf(record.id) >= 0) {
        candidates.push(record);
      }
    }
    this.aiCandidates = candidates;
    this.aiSelected = ids;
    this.aiPanelDate = this.selectedDate;
    this.aiBusy = false;
    // 上一次的失败原因不带进新面板（否则一打开就顶着一条旧报错）
    this.aiPanelError = '';
    this.showAiPanel = true;
  }

  private isAiSelected(id: string): boolean {
    return this.aiSelected.indexOf(id) >= 0;
  }

  private toggleAi(id: string): void {
    if (this.isAiSelected(id)) {
      this.aiSelected = this.aiSelected.filter((item: string) => item !== id);
    } else {
      this.aiSelected = this.aiSelected.concat([id]);
    }
  }

  private selectAllAi(): void {
    if (this.aiSelected.length === this.aiCandidates.length) {
      this.aiSelected = [];
      return;
    }
    const ids: string[] = [];
    for (const record of this.aiCandidates) {
      ids.push(record.id);
    }
    this.aiSelected = ids;
  }

  private async runAi(): Promise<void> {
    if (this.aiSelected.length === 0) {
      promptAction.showToast({ message: '请至少选择一条记录' });
      return;
    }
    const dayRecords = scheduleStore.readDay(this.aiPanelDate);
    const payload = buildAiPayload(this.aiPanelDate, dayRecords);
    const selected: AiPayload = { date: payload.date, records: [] };
    for (const item of payload.records) {
      if (this.isAiSelected(item.id)) {
        selected.records.push(item);
      }
    }
    if (selected.records.length === 0) {
      this.showAiPanel = false;
      promptAction.showToast({ message: '所选记录已不在待处理列表中，请重新打开面板' });
      this.reload();
      return;
    }
    let aiKey = '';
    try {
      const settings = await settingsStore.load(getContext(this) as common.UIAbilityContext);
      aiKey = settings.aiKey;
    } catch (error) {
      // 面板还开着：除了 toast，把原因留在面板里（toast 5 秒后消失，面板里的可复读）
      this.aiPanelError = `读取设置失败：${describeError(error)}`;
      promptAction.showToast({ message: `读取设置失败：${describeError(error)}` });
      return;
    }
    if (aiKey.trim().length === 0) {
      this.showAiPanel = false;
      promptAction.showToast({ message: '请先在设置页填写 DeepSeek API Key', duration: 4000 });
      return;
    }

    // 新一轮开始：上一次的失败原因作废（成功/失败分支会各自重新决定它）
    this.aiPanelError = '';
    this.aiBusy = true;
    try {
      const structured = await summarize(selected, aiKey, nowIso(), deviceTimeZone());
      const structuredById: Record<string, string> = {};
      const processedIds: string[] = [];
      for (const item of selected.records) {
        structuredById[item.id] = structured;
        processedIds.push(item.id);
      }
      const updated = applyAiResult(dayRecords, structuredById, processedIds);
      for (const record of updated) {
        if (processedIds.indexOf(record.id) >= 0) {
          // 保留原 ts（记录仍归属原日期文件），只追加 ai_structured / ai_processed 变化
          scheduleStore.appendRecord(record);
        }
      }
      this.aiResultText = structured;
      this.aiPanelError = '';
      this.aiResultVisible = true;
      this.showAiPanel = false;
      this.reload();
    } catch (error) {
      // toast 保留即时反馈；面板里的 ErrorState 负责「可复读 + 诊断 + 重试」
      this.aiPanelError = describeError(error);
      promptAction.showToast({ message: describeError(error), duration: 5000 });
    } finally {
      this.aiBusy = false;
    }
  }

  // ------------------------------------------------------------------ UI

  /** 日期条：‹ 日期/星期 › + 今天（三处点击区都 ≥ 40vp）；展开时内嵌 MonthCalendar（月视图，替代系统三列滚轮 DatePicker）。 */
  @Builder
  DateBlock() {
    Column({ space: SPACING.sm }) {
      Row({ space: SPACING.sm }) {
        ActionButton({
          label: '‹',
          actionEnabled: true,
          disabledReason: '',
          busy: false,
          variant: 'ghost',
          block: false,
          onTap: (): void => {
            this.shiftDate(-1);
          }
        })

        Column({ space: SPACING.xs }) {
          Text(this.selectedDate)
            .fontSize(FONT.body)
            .lineHeight(LINE_HEIGHT.body)
            .fontWeight(FontWeight.Medium)
            .fontColor($r('app.color.text_primary'))
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .width('100%')
            .textAlign(TextAlign.Start)
          Text(this.weekdayLabel())
            .fontSize(FONT.caption)
            .lineHeight(LINE_HEIGHT.caption)
            .fontColor($r('app.color.text_secondary'))
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .width('100%')
            .textAlign(TextAlign.Start)
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)
        .onClick(() => {
          this.showDatePicker = !this.showDatePicker;
        })

        ActionButton({
          label: '今天',
          actionEnabled: true,
          disabledReason: '',
          busy: false,
          variant: 'ghost',
          block: false,
          onTap: (): void => {
            this.goToday();
          }
        })

        ActionButton({
          label: '›',
          actionEnabled: true,
          disabledReason: '',
          busy: false,
          variant: 'ghost',
          block: false,
          onTap: (): void => {
            this.shiftDate(1);
          }
        })
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      if (this.showDatePicker) {
        MonthCalendar({
          value: this.selectedDate,
          todayKey: localDateKey(new Date()),
          onPick: (dateKey: string): void => { this.pickDate(dateKey); },
          onClose: (): void => { this.showDatePicker = false; }
        })
      }
    }
    .width('100%')
  }

  /** 模式分段控件：两段各 40vp 高（选中 = 强调色实底）。 */
  @Builder
  ModeTabs() {
    Row({ space: SPACING.sm }) {
      // 分段控件：两段各占一半（ActionButton 撑满外层 Column，宽度仍由 layoutWeight 均分）
      Column() {
        ActionButton({
          label: '今日待办',
          actionEnabled: true,
          disabledReason: '',
          busy: false,
          variant: this.showAllPending ? 'ghost' : 'primary',
          block: true,
          onTap: (): void => {
            this.showAllPending = false;
            this.reload();
          }
        })
      }
      .layoutWeight(1)

      Column() {
        ActionButton({
          label: '全部未完成',
          actionEnabled: true,
          disabledReason: '',
          busy: false,
          variant: this.showAllPending ? 'primary' : 'ghost',
          block: true,
          onTap: (): void => {
            this.showAllPending = true;
            this.showDatePicker = false;
            this.reload();
          }
        })
      }
      .layoutWeight(1)
    }
    .width('100%')
  }

  /** 列表区的快捷记录条（紧凑屏 / 宽屏共用同一个 Builder，都放在主操作之上）。 */
  @Builder
  QuickRecordRow() {
    QuickRecordBar({
      busy: this.quickBusy,
      onSubmit: (title: string): boolean => this.submitQuickRecord(title)
    })
  }

  /** 紧凑屏底部主操作：全宽（紧凑屏跳编辑页）。 */
  @Builder
  PrimaryAction() {
    Button('新建')
      .width('100%')
      .height(PRIMARY_HEIGHT)
      .fontSize(FONT.body)
      .backgroundColor($r('app.color.brand'))
      .fontColor($r('app.color.text_inverse'))
      .borderRadius(RADIUS.sm)
      .onClick(() => this.onNewTap())
  }

  /** 宽屏左栏的工具按钮：固定 240vp 左对齐（宽屏下右栏直接变编辑表单）。 */
  @Builder
  SidebarAction() {
    Button('新建')
      .width(SIDEBAR_ACTION_WIDTH)
      .height(PRIMARY_HEIGHT)
      .fontSize(FONT.body)
      .backgroundColor($r('app.color.brand'))
      .fontColor($r('app.color.text_inverse'))
      .borderRadius(RADIUS.sm)
      .onClick(() => this.onNewTap())
  }

  /**
   * 「今日汇总」块：今日日程列表的第一项。
   *
   * 五态（同一时刻只显示一态，互斥）：
   * ① 今日无日程 → 灰字「今天还没有日程」（无按钮：没有记录时生成只会空转）
   * ② 生成中     → `LoadingState`（3 秒后出现「取消」；取消只停止等待，结果真回来就用真结果）
   * ③ 失败       → `ErrorState`（发生了什么 / 为什么 / 下一步 + 诊断 + 重试 / 去设置）
   * ④ 无汇总     → `EmptyState`（一句说明 + 「生成汇总」；空态必须有下一步）
   * ⑤ 有汇总     → 标题一行 + 要点 ≤3 条 +（>3 时「查看全部」）+ 「更新于 HH:MM · 重新生成」
   */
  @Builder
  SummaryCard() {
    Column({ space: SPACING.sm }) {
      Row({ space: SPACING.sm }) {
        Text('✨ 今日汇总')
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.brand'))
          .layoutWeight(1)
          .textAlign(TextAlign.Start)
        if (this.hasSummary() && this.summaryPointTotal > 3) {
          ActionButton({
            label: '查看全部',
            actionEnabled: true,
            disabledReason: '',
            busy: false,
            variant: 'ghost',
            block: false,
            onTap: (): void => {
              this.aiResultVisible = true;
            }
          })
        }
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      if (this.records.length === 0) {
        // ① 无日程：只给一句弱提示，不出现生成按钮（避免两个都显示）
        Text('今天还没有日程')
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
          .width('100%')
          .textAlign(TextAlign.Start)
      } else if (this.aiBusy) {
        // ② 生成中：可取消（取消只停止等待，不假装成功，也不说结果不会回来）
        LoadingState({
          title: loadingText('AI 汇总'),
          detail: '正在请求模型，可随时停止等待',
          progress: -1,
          compact: true,
          onCancel: (): void => {
            this.cancelAiWait();
          }
        })
      } else if (this.summaryError.length > 0) {
        // ③ 失败：三段式 + 诊断 + 重试 / 去设置；旧汇总内容保持不变
        ErrorState({
          what: 'AI 汇总失败',
          why: redactSecrets(this.summaryError),
          next: '检查设置页的 AI Key / 服务是否可用后重试',
          diagnostics: this.aiDiagnostics(),
          compact: true,
          onRetry: (): void => {
            this.generateSummary();
          },
          onOpenSettings: (): void => {
            this.openSettings();
          }
        })
      } else if (!this.hasSummary() && this.summaryError.length === 0 && !this.aiBusy) {
        // ④ 无汇总：空态（一句说明 + 下一步动作，不允许只留一句话）
        EmptyState({
          compact: true,
          title: '今天还没有 AI 汇总',
          detail: '有记录后点「生成」让模型总结今天的安排',
          actionLabel: '生成汇总',
          onAction: (): void => {
            this.generateSummary();
          }
        })
      } else {
        // ⑤ 有汇总：标题 + 要点（点标题/要点 → 打开完整面板）
        Column({ space: SPACING.xs }) {
          Text(this.summaryHeadline)
            .fontSize(FONT.body)
            .lineHeight(LINE_HEIGHT.body)
            .fontWeight(FontWeight.Medium)
            .fontColor($r('app.color.text_primary'))
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .width('100%')
            .textAlign(TextAlign.Start)
          ForEach(
            this.summaryPoints,
            (item: string) => {
              Text(`· ${item}`)
                .fontSize(FONT.caption)
                .lineHeight(LINE_HEIGHT.caption)
                .fontColor($r('app.color.text_secondary'))
                .maxLines(2)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
                .width('100%')
                .textAlign(TextAlign.Start)
            },
            (item: string, index: number) => `point-${index}-${item}`
          )
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start)
        .onClick(() => {
          this.aiResultVisible = true;
        })

        Row({ space: SPACING.sm }) {
          Text(`更新于 ${this.summaryUpdatedAt}`)
            .fontSize(FONT.caption)
            .lineHeight(LINE_HEIGHT.caption)
            .fontColor($r('app.color.text_secondary'))
            .layoutWeight(1)
            .textAlign(TextAlign.End)
          ActionButton({
            label: '重新生成',
            actionEnabled: !this.aiBusy,
            disabledReason: 'AI 汇总正在生成，请稍候',
            busy: this.aiBusy,
            variant: 'ghost',
            block: false,
            onTap: (): void => {
              this.generateSummary();
            }
          })
        }
        .width('100%')
        .alignItems(VerticalAlign.Center)
      }

      Divider()
        .strokeWidth(DIVIDER)
        .color($r('app.color.divider'))
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  // ------------------------------------------------------------------ 搜索 / 筛选 / 撤销（UI）

  /**
   * 搜索框 + 状态 chips + 作者 chips。
   *
   * 三条互不干扰，任一变化都只重算 `visibleRecords`（不重读磁盘、不改 tab）。
   */
  @Builder
  SearchFilterBar() {
    Column({ space: SPACING.sm }) {
      Row({ space: SPACING.sm }) {
        TextInput({ text: this.queryText, placeholder: '搜索标题/正文/作者' })
          .fontSize(FONT.body)
          .placeholderFont({ size: FONT.caption })
          .height(TOUCH_MIN)
          .backgroundColor($r('app.color.surface'))
          .borderRadius(RADIUS.sm)
          .padding({ left: SPACING.md, right: SPACING.md })
          .layoutWeight(1)
          .onChange((value: string) => {
            this.onQueryTextChange(value);
          })
        if (this.queryText.length > 0) {
          ActionButton({
            label: '清空',
            actionEnabled: true,
            disabledReason: '',
            busy: false,
            variant: 'ghost',
            block: false,
            onTap: (): void => {
              this.resetFilters();
            }
          })
        }
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      Row({ space: SPACING.sm }) {
        this.StatusChip('全部', 'all')
        this.StatusChip('未完成', 'open')
        this.StatusChip('已完成', 'done')
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      if (this.authorChips.length > 0) {
        Scroll() {
          Row({ space: SPACING.sm }) {
            ForEach(
              this.authorChips,
              (author: string) => {
                Row() {
                  ActionButton({
                    label: author,
                    actionEnabled: true,
                    disabledReason: '',
                    busy: false,
                    variant: this.authorFilter === author ? 'primary' : 'ghost',
                    block: false,
                    onTap: (): void => {
                      this.pickAuthor(author);
                    }
                  })
                }
                .flexShrink(0)
              },
              (author: string) => `author-chip-${author}`
            )
          }
          .alignItems(VerticalAlign.Center)
        }
        .scrollable(ScrollDirection.Horizontal)
        .scrollBar(BarState.Off)
        .width('100%')
        .height(TOUCH_MIN)
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  /** 状态 chip（`all` / `open` / `done`）：选中 = 品牌实底反白字，未选 = 文字链形态。 */
  @Builder
  StatusChip(label: string, value: string) {
    ActionButton({
      label: label,
      actionEnabled: true,
      disabledReason: '',
      busy: false,
      variant: this.statusFilter === value ? 'primary' : 'ghost',
      block: false,
      onTap: (): void => {
        this.pickStatus(value);
      }
    })
  }

  /**
   * 空态文案：有搜索词 → 「没有匹配「xxx」的日程」+ 清空；只有筛选 → 「没有符合筛选条件的日程」+ 清空；
   * 完全没有筛选条件时不渲染（沿用「今日汇总」块与底部「新建」表达的原有空态）。
   */
  @Builder
  EmptyResults() {
    if (this.hasSearchWord) {
      Column({ space: SPACING.sm }) {
        Text(`没有匹配「${this.queryText.trim()}」的日程`)
          .fontSize(FONT.body)
          .lineHeight(LINE_HEIGHT.body)
          .fontColor($r('app.color.text_secondary'))
          .maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
          .textAlign(TextAlign.Start)
        ActionButton({
          label: '清空',
          actionEnabled: true,
          disabledReason: '',
          busy: false,
          variant: 'ghost',
          block: false,
          onTap: (): void => {
            this.resetFilters();
          }
        })
      }
      .width('100%')
      .padding({ top: SPACING.md })
      .alignItems(HorizontalAlign.Start)
    } else if (this.hasActiveFilter) {
      Column({ space: SPACING.sm }) {
        Text('没有符合筛选条件的日程')
          .fontSize(FONT.body)
          .lineHeight(LINE_HEIGHT.body)
          .fontColor($r('app.color.text_secondary'))
          .width('100%')
          .textAlign(TextAlign.Start)
        ActionButton({
          label: '清空筛选',
          actionEnabled: true,
          disabledReason: '',
          busy: false,
          variant: 'ghost',
          block: false,
          onTap: (): void => {
            this.resetFilters();
          }
        })
      }
      .width('100%')
      .padding({ top: SPACING.md })
      .alignItems(HorizontalAlign.Start)
    }
  }

  /**
   * 删除后的 5 秒撤销条：「已删除 · 标题」+「撤销（Ns）」。
   *
   * 只在 `undoId` 非空时渲染；到 0 自动消失（墓碑已落盘，超时不需要补写）。
   */
  @Builder
  UndoBar() {
    Row({ space: SPACING.sm }) {
      Text(`已删除 · ${this.undoTitle}`)
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontColor($r('app.color.text_primary'))
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)
        .textAlign(TextAlign.Start)
      ActionButton({
        label: `撤销（${this.undoSeconds()}s）`,
        actionEnabled: this.undoId.length > 0,
        disabledReason: '没有可撤销的删除',
        busy: false,
        variant: 'secondary',
        block: false,
        onTap: (): void => {
          this.undoDelete();
        }
      })
    }
    .width('100%')
    .padding({ left: SPACING.md, right: SPACING.sm })
    .backgroundColor($r('app.color.brand_soft'))
    .borderRadius(RADIUS.sm)
    .alignItems(VerticalAlign.Center)
  }

  /** 列表行（两条断点共用；行自带 1vp 分割线，所以 List space 为 0）。 */
  @Builder
  ListRows() {
    List() {
      ForEach(
        this.visibleRecords,
        (item: ScheduleRecord) => {
          ListItem() {
            RecordRow({
              record: item,
              selected: this.selectedId === item.id,
              onToggle: (id: string, done: boolean) => {
                this.toggleDone(id, done);
              },
              onOpen: (id: string) => {
                this.onRowTap(id);
              },
              onDelete: (id: string) => {
                this.requestDelete(id);
              }
            })
          }
        },
        (item: ScheduleRecord) => `${item.id}|${item.ts}|${item.done ? '1' : '0'}`
      )
    }
    .width('100%')
    .layoutWeight(1)
    .scrollBar(BarState.Off)
  }

  /** 列表区：有结果渲染行；无结果时只在「有筛选条件」时显示空态文案。 */
  @Builder
  RecordList() {
    if (this.visibleRecords.length > 0) {
      this.ListRows()
    } else {
      this.EmptyResults()
    }
  }

  /** 宽屏/横屏右栏：三态（空 / 详情 / 编辑），内容限宽 720vp 居中便于阅读；支持下拉刷新。 */
  @Builder
  RightPane() {
    Refresh({ refreshing: $$this.paneRefreshing }) {
      Column() {
        if (this.paneMode === 'editor') {
          RecordEditorView({
            recordId: this.editorRecordId,
            defaultDate: this.selectedDate,
            refreshTick: this.paneTick,
            onSaved: (record: ScheduleRecord) => {
              this.onEditorSaved(record);
            },
            onCancel: () => {
              this.onEditorCancel();
            },
            onDirtyChange: (dirty: boolean) => {
              this.editorDirty = dirty;
            }
          })
        } else {
          RecordDetailView({
            recordId: this.paneMode === 'detail' ? this.selectedId : '',
            refreshTick: this.paneTick,
            onEdit: () => {
              this.startEditSelected();
            },
            onDelete: () => {
              this.requestDelete(this.selectedId);
            }
          })
        }
      }
      .width('100%')
      .height('100%')
      .constraintSize({ maxWidth: LIST_MAX_WIDTH })
      .alignItems(HorizontalAlign.Start)
    }
    .width('100%')
    .height('100%')
    .onRefreshing(() => {
      this.paneRefreshing = true;
      this.onPullRefresh()
        .then(() => {
          // 编辑态且有未保存内容：不推进 paneTick，否则子组件重读会把草稿冲掉
          if (this.paneMode === 'editor' && this.editorDirty) {
            promptAction.showToast({ message: '列表已刷新；右栏有未保存内容，保持原样', duration: 3000 });
          } else {
            this.paneTick = this.paneTick + 1;
          }
          this.paneRefreshing = false;
        })
        .catch(() => {
          this.paneRefreshing = false;
        });
    })
  }

  /** 紧凑屏：日期条 → 模式 → 搜索/筛选 → 今日汇总块（列表第一项）→ 列表 → 撤销条 → 新建。 */
  @Builder
  CompactBody() {
    Column({ space: SPACING.md }) {
      this.DateBlock()
      this.ModeTabs()
      this.SearchFilterBar()
      Divider()
        .strokeWidth(DIVIDER)
        .color($r('app.color.divider'))
      Column() {
        if (!this.showAllPending) {
          this.SummaryCard()
        }
        // 下拉刷新：只包列表，不改主从/单列结构
        Refresh({ refreshing: $$this.refreshing }) {
          this.RecordList()
        }
        .onRefreshing(() => {
          this.refreshing = true;
          this.onPullRefresh().then(() => {
            this.refreshing = false;
          });
        })
        if (this.undoId.length > 0) {
          this.UndoBar()
        }
      }
      .width('100%')
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)
      this.QuickRecordRow()
      this.PrimaryAction()
    }
    .width('100%')
    .height('100%')
  }

  /**
   * 宽屏/横屏：左右主从。
   * 左栏（`masterPaneWidth` 360–420vp）= 日期条 + 模式 + 搜索/筛选 + 汇总块 + 列表 + 撤销条 + 新建；
   * 右栏 = 详情 / 编辑 / 空态（点行切右栏内容，点「新建」右栏直接变表单）。
   */
  @Builder
  WideBody() {
    Row({ space: SPACING.lg }) {
      Column({ space: SPACING.md }) {
        this.DateBlock()
        this.ModeTabs()
        this.SearchFilterBar()
        Divider()
          .strokeWidth(DIVIDER)
          .color($r('app.color.divider'))
        Column() {
          if (!this.showAllPending) {
            this.SummaryCard()
          }
          this.RecordList()
          if (this.undoId.length > 0) {
            this.UndoBar()
          }
        }
        .width('100%')
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)
        this.QuickRecordRow()
        this.SidebarAction()
      }
      .width(masterPaneWidth(this.contentWidth))
      .height('100%')
      .alignItems(HorizontalAlign.Start)

      Divider()
        .vertical(true)
        .strokeWidth(DIVIDER)
        .color($r('app.color.divider'))
        .height('100%')

      Column() {
        this.RightPane()
      }
      .layoutWeight(1)
      .height('100%')
      .constraintSize({ minWidth: 360 })
      .alignItems(HorizontalAlign.Center)
    }
    .width('100%')
    .height('100%')
    .alignItems(VerticalAlign.Top)
  }

  /** AI 汇总候选面板（保留逐条勾选与全选/全不选）。 */
  @Builder
  AiPanel() {
    Column({ space: SPACING.md }) {
      Row() {
        Text('AI 汇总（可取消勾选）')
          .fontSize(FONT.body)
          .lineHeight(LINE_HEIGHT.body)
          .fontWeight(FontWeight.Medium)
          .fontColor($r('app.color.text_primary'))
        Blank()
        ActionButton({
          label: this.aiSelected.length === this.aiCandidates.length ? '全不选' : '全选',
          actionEnabled: this.aiCandidates.length > 0,
          disabledReason: '没有可勾选的记录',
          busy: false,
          variant: 'ghost',
          block: false,
          onTap: (): void => {
            this.selectAllAi();
          }
        })
      }
      .width('100%')

      Text(`${this.aiPanelDate} · 已选 ${this.aiSelected.length} / ${this.aiCandidates.length} 条`)
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontColor($r('app.color.text_secondary'))
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .width('100%')

      if (this.aiPanelError.length > 0) {
        // 失败原因留在面板里（toast 会消失，这条可复读 + 带诊断 + 可重试）
        ErrorState({
          compact: true,
          what: 'AI 生成失败',
          why: redactSecrets(this.aiPanelError),
          next: '检查设置页的 AI Key / 网络后重试',
          diagnostics: this.aiDiagnostics(),
          onRetry: (): void => {
            this.runAi();
          },
          onOpenSettings: (): void => {
            this.openSettings();
          }
        })
      }

      List({ space: SPACING.sm }) {
        ForEach(
          this.aiCandidates,
          (item: ScheduleRecord) => {
            ListItem() {
              Row({ space: SPACING.sm }) {
                Checkbox({ name: `ai-${item.id}` })
                  .select(this.isAiSelected(item.id))
                  .selectedColor($r('app.color.brand'))
                  .width(TOUCH_MIN)
                  .height(TOUCH_MIN)
                  .onChange(() => {
                    this.toggleAi(item.id);
                  })
                Column({ space: SPACING.xs }) {
                  Text(item.title.length > 0 ? item.title : '(未命名日程)')
                    .fontSize(FONT.body)
                    .lineHeight(LINE_HEIGHT.body)
                    .fontColor($r('app.color.text_primary'))
                    .maxLines(1)
                    .textOverflow({ overflow: TextOverflow.Ellipsis })
                    .width('100%')
                  Text(item.body.length > 0 ? item.body : '（无正文，将使用原始识别文本）')
                    .fontSize(FONT.caption)
                    .lineHeight(LINE_HEIGHT.caption)
                    .fontColor($r('app.color.text_secondary'))
                    .maxLines(1)
                    .textOverflow({ overflow: TextOverflow.Ellipsis })
                    .width('100%')
                }
                .layoutWeight(1)
                .alignItems(HorizontalAlign.Start)
              }
              .width('100%')
              .padding({ top: SPACING.xs, bottom: SPACING.xs })
            }
          },
          (item: ScheduleRecord) => `${item.id}|${this.isAiSelected(item.id) ? '1' : '0'}`
        )
      }
      .width('100%')
      .layoutWeight(1)
      .scrollBar(BarState.Auto)

      if (this.aiSelected.length === 0) {
        // 一条都没勾选：界面上的空态（toast 只有几秒，回头看不到「为什么生成按钮不动」）
        EmptyState({
          compact: true,
          title: '还没有选择记录',
          detail: '勾选要发给模型的记录，至少一条',
          actionLabel: '全选',
          onAction: (): void => {
            this.selectAllAi();
          }
        })
      }

      Row({ space: SPACING.sm }) {
        // 「取消」是面板级关闭（不是 Text 当按钮），形态与主操作不同档：保留原 48vp 次按钮，
        // 主操作换成 ActionButton（本批要求它走 `busy` 形态）；两者高度差 8vp 是刻意不改的既有外观。
        Button('取消')
          .layoutWeight(1)
          .height(PRIMARY_HEIGHT)
          .fontSize(FONT.body)
          .backgroundColor(Color.Transparent)
          .fontColor($r('app.color.text_secondary'))
          .borderRadius(RADIUS.sm)
          .onClick(() => {
            this.showAiPanel = false;
          })
        Column() {
          ActionButton({
            label: '开始汇总',
            actionEnabled: this.aiSelected.length > 0,
            disabledReason: '请至少选择一条记录',
            busy: this.aiBusy,
            variant: 'primary',
            block: true,
            onTap: (): void => {
              this.runAi();
            }
          })
        }
        .layoutWeight(1)
      }
      .width('100%')

      if (this.aiBusy) {
        Text('正在调用 DeepSeek，请稍候…')
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.brand'))
      }
    }
    .width('92%')
    .height('70%')
    .padding(SPACING.lg)
    .backgroundColor($r('app.color.surface'))
    .borderRadius(RADIUS.md)
  }

  /** AI 结果面板。 */
  @Builder
  AiResultPanel() {
    Column({ space: SPACING.md }) {
      Row() {
        Text('AI 整理结果')
          .fontSize(FONT.body)
          .lineHeight(LINE_HEIGHT.body)
          .fontWeight(FontWeight.Medium)
          .fontColor($r('app.color.text_primary'))
        Blank()
        ActionButton({
          label: '重选',
          actionEnabled: true,
          disabledReason: '',
          busy: false,
          variant: 'ghost',
          block: false,
          onTap: (): void => {
            // 逐条取消勾选的入口：关掉结果、回到候选面板
            this.aiResultVisible = false;
            this.openAiPanel();
          }
        })
        ActionButton({
          label: '关闭',
          actionEnabled: true,
          disabledReason: '',
          busy: false,
          variant: 'ghost',
          block: false,
          onTap: (): void => {
            this.aiResultVisible = false;
          }
        })
      }
      .width('100%')

      Scroll() {
        Text(this.aiResultText)
          .fontSize(FONT.body)
          .lineHeight(LINE_HEIGHT.body)
          .fontColor($r('app.color.text_primary'))
          .width('100%')
          .textAlign(TextAlign.Start)
      }
      .layoutWeight(1)
      .width('100%')

      Text('结果已写入各条记录的 ai_structured，原始识别文本 ocr_text 保持不变')
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontColor($r('app.color.text_secondary'))
        .width('100%')
    }
    .width('92%')
    .height('70%')
    .padding(SPACING.lg)
    .backgroundColor($r('app.color.surface'))
    .borderRadius(RADIUS.md)
  }

  build() {
    Stack({ alignContent: Alignment.Center }) {
      PageLayout({
        title: this.pageTitle(),
        subtitle: this.subtitleText(),
        // 页头唯一动作：进设置。AI 汇总入口只在列表第一项的汇总块（页头不再重复）
        headerActionTwo: '⚙ 设置',
        onHeaderActionTwo: () => {
          this.openSettings();
        },
        onBreakpointChange: (breakpoint: string, widthVp: number) => {
          this.breakpoint = breakpoint;
          this.contentWidth = widthVp;
          // 主从门槛按内容宽算（≥840vp）；竖屏平板/手机一律单列
          this.masterDetail = isMasterDetailWidth(widthVp);
        }
      }) {
        if (this.masterDetail) {
          this.WideBody()
        } else {
          this.CompactBody()
        }
      }

      if (this.showAiPanel || this.aiResultVisible) {
        Column()
          .width('100%')
          .height('100%')
          .backgroundColor($r('app.color.scrim'))
          .onClick(() => {
            if (!this.aiBusy) {
              this.showAiPanel = false;
              this.aiResultVisible = false;
            }
          })
      }
      if (this.showAiPanel) {
        this.AiPanel()
      }
      if (this.aiResultVisible) {
        this.AiResultPanel()
      }
      // 同步/附件 zip 的隐藏桥（1×1、全透明、不参与交互）；就绪后做一次启动 pull
      GitBridgeHost({
        onReady: (controller: webview.WebviewController) => {
          this.onBridgeReady(controller);
        },
        onFail: (message: string) => {
          // 桥加载失败：记住原因（不抛），下拉刷新时会以可读文案返回
          syncController.markBridgeFailed(message);
        }
      })
        .width(1)
        .height(1)
        .opacity(0)
        .position({ x: 0, y: 0 })
        .hitTestBehavior(HitTestMode.None)
    }
    .width('100%')
    .height('100%')
  }
}
