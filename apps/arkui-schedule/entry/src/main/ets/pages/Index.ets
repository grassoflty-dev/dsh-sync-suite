/**
 * 主页：日期条 + 今日待办/全部未完成 + 列表（左勾选 / 中标题+时间 / 右手迹）+ 「新建」主操作
 * + 页头两个明确动作（✨ AI 汇总 / ⚙ 设置）。
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
 */
import { promptAction, router } from '@kit.ArkUI';
import { common } from '@kit.AbilityKit';
import { localDateKey, nextTsSameDate, nowIso } from '../common/date';
import { applyAiResult, buildAiPayload } from '../model/aiPayload';
import type { AiPayload, ScheduleRecord } from '../model/types';
import { cloneRecord } from '../model/types';
import { SUMMARY_MAX_POINTS, truncateSummaryForDisplay } from '../model/dailySummary';
import type { DailySummary, SummaryDisplay } from '../model/dailySummary';
import { describeError, scheduleStore } from '../services/scheduleStore';
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

  aboutToAppear(): void {
    this.syncHomeFilter();
    this.bootstrap();
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

  /** 读存储并刷新列表与状态文案。 */
  private reload(): void {
    if (!this.ready) {
      return;
    }
    try {
      if (this.showAllPending) {
        // 数据源：每台设备读自己的 open.jsonl（N 台设备 = N 个小文件）；某台设备缺索引时
        // 在内存里用它的分片重建，绝不写别人的设备目录（契约：每台设备只写自己的目录）。
        const pending: ScheduleRecord[] = openIndexStore.pendingRecords(this.includeOtherDevices);
        this.records = pending;
        this.statusText = pending.length === 0 ? '所有日程都已完成' : `共 ${pending.length} 条未完成（跨全部日期${this.includeOtherDevices ? '与全部设备' : ''}）`;
      } else {
        const day = this.includeOtherDevices
          ? scheduleStore.readDayAllDevices(this.selectedDate)
          : scheduleStore.readDay(this.selectedDate);
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

  private openNew(): void {
    const params: Record<string, string> = { 'id': '', 'date': this.selectedDate };
    router.pushUrl({ url: 'pages/Edit', params: params }).catch((error: Error) => {
      promptAction.showToast({ message: `打开编辑页失败：${describeError(error)}` });
    });
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
          { text: '继续编辑', color: '#182431' },
          { text: '放弃修改', color: '#0A59F7' }
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

  /** 汇总块标题（页头图标也用它判断该「生成」还是「打开面板」）。 */
  private hasSummary(): boolean {
    return this.summaryHeadline.length > 0;
  }

  /** 头部图标：有汇总 → 打开完整面板；没有 → 立即生成。 */
  private onHeaderSummaryAction(): void {
    if (this.hasSummary()) {
      this.aiResultVisible = true;
      return;
    }
    this.generateSummary();
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
      // 结果已经进块里了，不自动弹面板（要看全部点块或头部图标）
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

  /** 打开详情页。 */
  private openDetail(id: string): void {
    const params: Record<string, string> = { 'id': id };
    router.pushUrl({ url: 'pages/Detail', params: params }).catch((error: Error) => {
      promptAction.showToast({ message: `打开详情页失败：${describeError(error)}` });
    });
  }

  /**
   * 首页快捷同步（带 `autoAction=pull` 跳设置页）。
   *
   * **当前没有入口**：同步相关动作已按用户要求全部收进「设置 → 同步(Git)」组，
   * 这里保留实现与 `autoAction` 参数通道，将来若要恢复首页快捷同步直接接回来即可。
   */
  private openSync(): void {
    const params: Record<string, string> = { 'autoAction': 'pull' };
    router.pushUrl({ url: 'pages/Settings', params: params }).catch((error: Error) => {
      promptAction.showToast({ message: `打开设置页失败：${describeError(error)}` });
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
      promptAction.showToast({ message: `读取设置失败：${describeError(error)}` });
      return;
    }
    if (aiKey.trim().length === 0) {
      this.showAiPanel = false;
      promptAction.showToast({ message: '请先在设置页填写 DeepSeek API Key', duration: 4000 });
      return;
    }

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
      this.aiResultVisible = true;
      this.showAiPanel = false;
      this.reload();
    } catch (error) {
      promptAction.showToast({ message: describeError(error), duration: 5000 });
    } finally {
      this.aiBusy = false;
    }
  }

  // ------------------------------------------------------------------ UI

  /** 日期条：‹ 日期/星期 › + 今天（三处点击区都 ≥ 40vp）；展开时内嵌 DatePicker。 */
  @Builder
  DateBlock() {
    Column({ space: SPACING.sm }) {
      Row({ space: SPACING.sm }) {
        Text('‹')
          .fontSize(FONT.title)
          .lineHeight(LINE_HEIGHT.title)
          .fontColor($r('app.color.brand'))
          .width(TOUCH_MIN)
          .height(TOUCH_MIN)
          .textAlign(TextAlign.Center)
          .onClick(() => this.shiftDate(-1))

        Column({ space: SPACING.xs }) {
          Text(this.selectedDate)
            .fontSize(FONT.body)
            .lineHeight(LINE_HEIGHT.body)
            .fontWeight(FontWeight.Medium)
            .fontColor($r('app.color.text_primary'))
            .width('100%')
            .textAlign(TextAlign.Start)
          Text(this.weekdayLabel())
            .fontSize(FONT.caption)
            .lineHeight(LINE_HEIGHT.caption)
            .fontColor($r('app.color.text_secondary'))
            .width('100%')
            .textAlign(TextAlign.Start)
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)
        .onClick(() => {
          this.showDatePicker = !this.showDatePicker;
        })

        Text('今天')
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.brand'))
          .height(TOUCH_MIN)
          .padding({ left: SPACING.md, right: SPACING.md })
          .textAlign(TextAlign.Center)
          .onClick(() => this.goToday())

        Text('›')
          .fontSize(FONT.title)
          .lineHeight(LINE_HEIGHT.title)
          .fontColor($r('app.color.brand'))
          .width(TOUCH_MIN)
          .height(TOUCH_MIN)
          .textAlign(TextAlign.Center)
          .onClick(() => this.shiftDate(1))
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      if (this.showDatePicker) {
        DatePicker({
          start: new Date(2020, 0, 1),
          end: new Date(2035, 11, 31),
          selected: dateFromKey(this.selectedDate)
        })
          .onDateChange((value: Date) => {
            this.selectedDate = localDateKey(value);
            this.showDatePicker = false;
            this.showAllPending = false;
            this.reload();
            this.loadSummary();
          })
      }
    }
    .width('100%')
  }

  /** 模式分段控件：两段各 40vp 高（选中 = 强调色实底）。 */
  @Builder
  ModeTabs() {
    Row({ space: SPACING.sm }) {
      Text('今日待办')
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontColor(this.showAllPending ? $r('app.color.text_secondary') : $r('app.color.brand'))
        .backgroundColor(this.showAllPending ? $r('app.color.page_background') : $r('app.color.brand_soft'))
        .height(TOUCH_MIN)
        .layoutWeight(1)
        .textAlign(TextAlign.Center)
        .onClick(() => {
          this.showAllPending = false;
          this.reload();
        })
      Text('全部未完成')
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontColor(this.showAllPending ? $r('app.color.brand') : $r('app.color.text_secondary'))
        .backgroundColor(this.showAllPending ? $r('app.color.brand_soft') : $r('app.color.page_background'))
        .height(TOUCH_MIN)
        .layoutWeight(1)
        .textAlign(TextAlign.Center)
        .onClick(() => {
          this.showAllPending = true;
          this.showDatePicker = false;
          this.reload();
        })
    }
    .width('100%')
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
   * ① 今日无日程 → 灰字「今天还没有日程」（无按钮）
   * ② 生成中   → 「正在生成…」
   * ③ 失败     → 一行错误 + 「重试」（不覆盖旧汇总，由 generateSummary 保证）
   * ④ 无汇总   → 一行「✨ 生成今日汇总」（可点）
   * ⑤ 有汇总   → 标题一行 + 要点 ≤3 条 +（>3 时「查看全部」）+ 「更新于 HH:MM · 重新生成」
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
          Text('查看全部')
            .fontSize(FONT.caption)
            .lineHeight(LINE_HEIGHT.caption)
            .fontColor($r('app.color.brand'))
            .height(TOUCH_MIN)
            .padding({ left: SPACING.sm, right: SPACING.sm })
            .textAlign(TextAlign.Center)
            .onClick(() => {
              this.aiResultVisible = true;
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
        // ② 生成中（与页头图标共用 aiBusy，两处状态不会打架）
        Text('正在生成今日汇总…')
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
          .width('100%')
          .textAlign(TextAlign.Start)
      } else if (this.summaryError.length > 0) {
        // ③ 失败：一行错误 + 重试；旧汇总内容保持不变
        Row({ space: SPACING.sm }) {
          Text(this.summaryError)
            .fontSize(FONT.caption)
            .lineHeight(LINE_HEIGHT.caption)
            .fontColor($r('app.color.danger'))
            .maxLines(2)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .layoutWeight(1)
            .textAlign(TextAlign.Start)
          Text('重试')
            .fontSize(FONT.caption)
            .lineHeight(LINE_HEIGHT.caption)
            .fontColor($r('app.color.brand'))
            .height(TOUCH_MIN)
            .padding({ left: SPACING.sm, right: SPACING.sm })
            .textAlign(TextAlign.Center)
            .onClick(() => {
              this.generateSummary();
            })
        }
        .width('100%')
        .alignItems(VerticalAlign.Center)
      } else if (!this.hasSummary()) {
        // ④ 无汇总：整行可点，直接生成
        Text('✨ 生成今日汇总')
          .fontSize(FONT.body)
          .lineHeight(LINE_HEIGHT.body)
          .fontColor($r('app.color.brand'))
          .width('100%')
          .height(TOUCH_MIN)
          .textAlign(TextAlign.Start)
          .onClick(() => {
            this.generateSummary();
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
          Text('重新生成')
            .fontSize(FONT.caption)
            .lineHeight(LINE_HEIGHT.caption)
            .fontColor($r('app.color.brand'))
            .height(TOUCH_MIN)
            .padding({ left: SPACING.sm, right: SPACING.sm })
            .textAlign(TextAlign.Center)
            .enabled(!this.aiBusy)
            .onClick(() => {
              this.generateSummary();
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

  /** 列表行（两条断点共用；行自带 1vp 分割线，所以 List space 为 0）。 */
  @Builder
  ListRows() {
    List() {
      ForEach(
        this.records,
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

  /** 紧凑屏列表：空态已由「今日汇总」块与底部「新建」表达，这里不再重复文案。 */
  @Builder
  RecordList() {
    if (this.records.length > 0) {
      this.ListRows()
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

  /** 紧凑屏：日期条 → 模式 → 今日汇总块（列表第一项）→ 列表 → 新建。 */
  @Builder
  CompactBody() {
    Column({ space: SPACING.md }) {
      this.DateBlock()
      this.ModeTabs()
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
      }
      .width('100%')
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)
      this.PrimaryAction()
    }
    .width('100%')
    .height('100%')
  }

  /**
   * 宽屏/横屏：左右主从。
   * 左栏（`masterPaneWidth` 360–420vp）= 日期条 + 模式 + 汇总块 + 列表 + 新建；
   * 右栏 = 详情 / 编辑 / 空态（点行切右栏内容，点「新建」右栏直接变表单）。
   */
  @Builder
  WideBody() {
    Row({ space: SPACING.lg }) {
      Column({ space: SPACING.md }) {
        this.DateBlock()
        this.ModeTabs()
        Divider()
          .strokeWidth(DIVIDER)
          .color($r('app.color.divider'))
        Column() {
          if (!this.showAllPending) {
            this.SummaryCard()
          }
          this.RecordList()
        }
        .width('100%')
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)
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
        Text(this.aiSelected.length === this.aiCandidates.length ? '全不选' : '全选')
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.brand'))
          .height(TOUCH_MIN)
          .padding({ left: SPACING.md, right: SPACING.md })
          .textAlign(TextAlign.Center)
          .onClick(() => this.selectAllAi())
      }
      .width('100%')

      Text(`${this.aiPanelDate} · 已选 ${this.aiSelected.length} / ${this.aiCandidates.length} 条`)
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontColor($r('app.color.text_secondary'))
        .width('100%')

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

      Row({ space: SPACING.sm }) {
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
        Button(this.aiBusy ? '整理中…' : '开始汇总')
          .layoutWeight(1)
          .height(PRIMARY_HEIGHT)
          .fontSize(FONT.body)
          .backgroundColor($r('app.color.brand'))
          .fontColor($r('app.color.text_inverse'))
          .borderRadius(RADIUS.sm)
          .enabled(!this.aiBusy)
          .onClick(() => {
            this.runAi();
          })
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
        Text('重选')
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
          .height(TOUCH_MIN)
          .padding({ left: SPACING.md, right: SPACING.md })
          .textAlign(TextAlign.Center)
          .onClick(() => {
            // 逐条取消勾选的入口：关掉结果、回到候选面板
            this.aiResultVisible = false;
            this.openAiPanel();
          })
        Text('关闭')
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.brand'))
          .height(TOUCH_MIN)
          .padding({ left: SPACING.md, right: SPACING.md })
          .textAlign(TextAlign.Center)
          .onClick(() => {
            this.aiResultVisible = false;
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
        // 明确动作：直接跑当天的 AI 汇总 / 进设置（同步相关配置都在设置页）
        // 明确动作：有汇总→打开面板，无汇总→立即生成；生成中显示 loading 与列表块同源（aiBusy）
        headerActionOne: this.aiBusy ? '✨ 生成中…' : '✨ AI 汇总',
        onHeaderActionOne: () => {
          this.onHeaderSummaryAction();
        },
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
