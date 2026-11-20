/**
 * 设置页「导出 / 导入」面板（**纯展示 + 回调**）。
 *
 * 分工（`docs/EXPORT-IMPORT.md` §4）：
 * - 本组件**不做 IO、不做路由、不 import services**：dry-run 统计、按钮可用性、提示文案
 *   全部来自 `model/exportImport.ts` 的纯函数；导出 / 选文件 / 确认导入 / 取消都通过回调交给页面；
 * - 页面负责调 `services/exportService.ets`，再把结果写回 `state`（本组件的 `@Prop`）。
 *
 * 两步导入（关键交互）：
 * 1. 「选择 JSON 文件」→ 页面调 `pickImportFile` + `planImportFromText`，把 dry-run 计数写进 `state`；
 * 2. 面板展示「将新增 N 条 / 跳过 M 条 / 冲突 K 条 / 非法 J 条」；**只有 `N>0 && J===0` 才能点
 *    「确认导入」**（有非法条目就 fail-closed，提示「先修正文件」），点确认才真正追加。
 *
 * 设计（`docs/UI-DESIGN.md`）：白底、无卡片/阴影；字号只用 `FONT` 三级；间距只用 `SPACING` 五档；
 * 颜色一律 `$r('app.color.*')`（深色模式自动跟随）；所有可点区域高度 ≥ `TOUCH_MIN`（40vp）。
 *
 * A 批（`docs/STATE-UI.md` §4/§5）：
 * - 五个动作按钮 + 三个文字入口统一换成 `ActionButton`：禁用时**仍可点**，点了给具体中文原因
 *   （不做「静默吞点击」的禁用——那正是 `docs/STATE-UI.md` §0 第 4 条要解决的问题）；
 * - 忙 → `LoadingState`（>3s 出现「取消」，走**独立的** `onCancelWait`——它只复位「等待」，
 *   与「取消导入（清空 dry-run）」不是同一件事，见两个回调的注释）；
 * - 还没导出过 → `EmptyState`（「填今天」用 `todayText()` 算，组件里不散落 `new Date()`）；
 * - 失败 → `ErrorState`（三段式 + 诊断四要素 + 重试）。
 *
 * 复制路径：路径用 `Text(...).copyOption(CopyOptions.LocalDevice)` 渲染，**长按即可复制**，
 * 不需要 pasteboard API、也不需要任何新权限；宿主若想要一个显式按钮，传 `onCopyPath` 即可
 * （此时才会渲染「复制路径」按钮）。
 */
import { loadingText } from '../common/copy';
import { APP_VERSION } from '../common/version';
import { DIVIDER, FONT, LINE_HEIGHT, RADIUS, SPACING, TOUCH_MIN } from '../common/uiTokens';
import {
  EXPORT_FORMAT_JSON,
  EXPORT_FORMAT_MARKDOWN,
  EMPTY_EXPORT_IMPORT_STATE,
  QUICK_RANGE_OPTIONS,
  canConfirmImport,
  dryRunSummary,
  importBlockedTip,
  isDryRunEmpty,
  isQuickRangeActive,
  parseDateRange,
  quickRange,
  todayText
} from '../model/exportImport';
import type { DateRangeResult, ExportImportState, ExportRequest, QuickRangeOption } from '../model/exportImport';
import { formatDiagnostics } from '../model/stateView';
import type { DiagnosticsInput } from '../model/stateView';
import { NOT_MIGRATED_REASON } from '../model/migrationState';
import { timelineStore } from '../services/timelineStore';
import { ActionButton } from './ActionButton';
import { EmptyState } from './state/EmptyState';
import { ErrorState } from './state/ErrorState';
import { LoadingState } from './state/LoadingState';

/** 导出按钮忙碌时的原因。 */
const EXPORT_BUSY_REASON: string = '导出还没结束';

/** 选文件 / 取消按钮忙碌时的原因。 */
const IMPORT_BUSY_REASON: string = '导入还没结束，先等它读完文件';

/** 取消按钮在导入进行中的原因（与上一句同义，但这里是「取消」这个动作自己的口径）。 */
const CANCEL_BUSY_REASON: string = '导入进行中，先等它结束';

/** 确认导入还没选文件时的原因（点了要知道下一步做什么）。 */
const CONFIRM_NEED_FILE: string = '先选择 JSON 文件（会先算一遍，不写任何记录）';

/** 空态：还没导出过时给一句说明 + 一个「填今天」的动作。 */
const EMPTY_EXPORT_TITLE: string = '还没有导出记录';
const EMPTY_EXPORT_DETAIL: string = '选好区间和格式后点「导出」';
const EMPTY_EXPORT_ACTION: string = '填今天';

/** 错误态的三段式文案（面板拿不到设备号，诊断里的设备写「未登记」由 model 兜底）。 */
const PANEL_ERROR_WHAT: string = '导出/导入失败';
const PANEL_ERROR_NEXT: string = '检查日期区间与文件后重试';

/**
 * 失败文案的前缀。
 *
 * `state.message` 同时承载**成功**提示（页面写「已导出 N 条…」/「已追加 N 条…」/「已取消导入…」），
 * 所以错误态不能只看「message 非空」——否则成功提示会被渲染成「导出/导入失败」。
 * 这里按页面的文案前缀认（页面所有失败提示都以这几个词开头，成功提示一律以「已」开头）。
 */
const FAILURE_PREFIXES: string[] = ['导出失败', '导入失败', '选择文件失败', '无法读取导入文件', '复制路径失败', '没有待确认'];

// ---- v2 时间线备份（只在 timelineStore.isMigrated() 时渲染，未迁移用户看不到这一节）----
const V2_GROUP_TITLE: string = 'v2 时间线备份';
const V2_HINT: string = '导出共享时间线（含媒体）为只读备份；导入先 dry-run，确认后才写入 timeline/';
const V2_EXPORT_LABEL: string = '导出 v2 备份';
const V2_PICK_LABEL: string = '选择 v2 备份并试算';
const V2_APPLY_LABEL: string = '确认导入 v2';
const V2_CANCEL_LABEL: string = '取消 v2 导入';
const V2_EMPTY_TITLE: string = '还没有 v2 导入计划';
const V2_EMPTY_DETAIL: string = '选一份 v2 备份的 manifest.json，先算出计划再决定要不要写入';
const V2_EMPTY_ACTION: string = '去选备份';
const V2_BUSY: string = 'v2 备份正在处理，请稍候';

@Component
export struct ExportImportPanel {
  /** 展示状态（区间初值、格式、开关、dry-run 计数、导出路径、错误文案、忙碌标志）。 */
  @Prop state: ExportImportState = EMPTY_EXPORT_IMPORT_STATE;
  /**
   * 导出回调：把用户当前选的区间/格式/开关原样交回页面。
   * 页面据此拼 `exportService.exportSchedules(request)`（无参实现也兼容：忽略入参即可）。
   */
  onExport: ((request: ExportRequest) => void) | null = null;
  /** 选导入文件（页面负责 picker + dry-run）。 */
  onPickFile: (() => void) | null = null;
  /** 确认导入（仅 `canConfirmImport(state)` 为真时可点）。 */
  onConfirmImport: (() => void) | null = null;
  /** 取消（清空 dry-run 结果；页面用 `clearDryRun` 更新 state）。**不是**「停止等待」。 */
  onCancel: (() => void) | null = null;
  /**
   * 停止等待（loading 里点「取消」时调用）：页面把 `state.busy` 复位为 false。
   *
   * 与 `onCancel` 刻意分开：`onCancel` 的语义是「丢掉 dry-run 计划」（用户主动放弃导入），
   * 这里只是「不再等这次读写」——文件可能已经写出一部分，所以页面给的是「已停止等待」而不是
   * 「已取消」，避免假反馈（`docs/STATE-UI.md` §4.1）。
   */
  onCancelWait: () => void = () => {};
  /** 可选：显式「复制路径」按钮（`null` = 不渲染，只靠长按复制）。 */
  onCopyPath: (() => void) | null = null;

  // ---- v2 时间线备份（展示数据由页面写回，组件只读；不新增 @State，保持纯展示）----
  /** v2 导入计划是否已生成（页面 dry-run 成功后置 true）。 */
  @Prop v2PlanReady: boolean = false;
  /** v2 计划的中文展示行（days / records / media / bytes，由纯函数 v2PlanSummary 产出）。 */
  @Prop v2PlanText: string = '';
  /** v2 导入最近一次提示（成功 / 类型化拒绝原因，空串 = 无）。 */
  @Prop v2Message: string = '';
  /** v2 操作是否进行中（按钮统一的忙碌原因来源）。 */
  @Prop v2Busy: boolean = false;
  /** 导出 v2 备份（页面调 exportV2Timeline 并写回 v2Message）。 */
  onV2Export: (() => void) | null = null;
  /** 选择 v2 备份并 dry-run（页面调 picker + planV2ImportFromPicked，写回 v2Plan*）。 */
  onV2Pick: (() => void) | null = null;
  /** 显式确认导入（页面调 applyV2Import；dry-run 默认不写）。 */
  onV2Apply: (() => void) | null = null;
  /** 取消 v2 导入（页面清空计划，本机零改动）。 */
  onV2Cancel: (() => void) | null = null;

  // 可编辑项在组件本地承接：`@Prop` 是单向的，输入框直接改父状态会来回抖动。
  // 初始值来自 `state`（`aboutToAppear` 同步一次），之后由用户输入主导并随 `onExport` 回传。
  @State fromText: string = '';
  @State toText: string = '';
  @State format: string = EXPORT_FORMAT_MARKDOWN;
  @State includeAttachments: boolean = false;
  @State includeMeta: boolean = false;

  aboutToAppear(): void {
    this.fromText = this.state.fromText;
    this.toText = this.state.toText;
    this.format = this.state.format === EXPORT_FORMAT_JSON ? EXPORT_FORMAT_JSON : EXPORT_FORMAT_MARKDOWN;
    this.includeAttachments = this.state.includeAttachments;
    this.includeMeta = this.state.includeMeta;
  }

  /** 当前选择（回传给页面的导出请求）。 */
  private currentRequest(): ExportRequest {
    const request: ExportRequest = {
      fromText: this.fromText,
      toText: this.toText,
      format: this.format,
      includeAttachments: this.includeAttachments,
      includeMeta: this.includeMeta
    };
    return request;
  }

  private emitExport(): void {
    if (this.state.busy) {
      return;
    }
    const handler: ((request: ExportRequest) => void) | null = this.onExport;
    if (handler !== null) {
      handler(this.currentRequest());
    }
  }

  private emitPickFile(): void {
    if (this.state.busy) {
      return;
    }
    const handler: (() => void) | null = this.onPickFile;
    if (handler !== null) {
      handler();
    }
  }

  private emitConfirmImport(): void {
    if (!canConfirmImport(this.state)) {
      return;
    }
    const handler: (() => void) | null = this.onConfirmImport;
    if (handler !== null) {
      handler();
    }
  }

  private emitCancel(): void {
    const handler: (() => void) | null = this.onCancel;
    if (handler !== null) {
      handler();
    }
  }

  /** 停止等待：只通知页面复位忙碌标志，组件自己**不**把界面说成「已取消」。 */
  private emitCancelWait(): void {
    this.onCancelWait();
  }

  private emitCopyPath(): void {
    const handler: (() => void) | null = this.onCopyPath;
    if (handler !== null) {
      handler();
    }
  }

  // ------------------------------------------------------------------ v2 时间线备份

  /** v2 是唯一路径：迁移完成才显示这一节；未迁移用户只看到首页横幅，不看到 v2 备份。 */
  private v2Visible(): boolean {
    return timelineStore.isMigrated();
  }

  /**
   * v1 格式导入节在 v2-only 里的门槛：未迁移时整节禁用并给出 typed 原因，
   * 按钮点了也只展示同一句原因（不做「静默吞点击」），回调根本不会被触发，因此零写入。
   * 已迁移时导入目标仍是 timeline/（由页面经 timelineWriteStore 落盘）。
   */
  private importDisabledReason(): string {
    return this.v2Visible() ? '' : NOT_MIGRATED_REASON;
  }

  /**
   * 按钮不可用原因：当前只有「忙碌」一种。
   * 四个 v2 回调在设置页全部接线（onV2Export / onV2Pick / onV2Apply / onV2Cancel），
   * 回调缺失时的不可达文案分支已删除；`v2CanTap` 仍保留 null 检查作防御，不会误调用。
   */
  private v2BlockedReason(): string {
    if (this.v2Busy) {
      return V2_BUSY;
    }
    return '';
  }

  /** 按钮是否真的能执行：有回调且不在忙碌中（不可用按钮仍可点，点了给原因）。 */
  private v2CanTap(handler: (() => void) | null): boolean {
    return handler !== null && !this.v2Busy;
  }

  /** 确认导入是否可点：必须已有 dry-run 计划且不忙（与 v1 的「先算后写」纪律一致）。 */
  private v2CanApply(): boolean {
    return this.v2CanTap(this.onV2Apply) && this.v2PlanReady && this.v2PlanText.length > 0;
  }

  /** 确认导入的不可用原因：先解释忙碌，其次「还没试算」。 */
  private v2ApplyBlockedReason(): string {
    const blocked: string = this.v2BlockedReason();
    if (blocked.length > 0) {
      return blocked;
    }
    if (!this.v2PlanReady || this.v2PlanText.length === 0) {
      return '先选择 v2 备份并试算（dry-run 不写任何记录）';
    }
    return '';
  }

  /** 选文件按钮文案：还没选过 → 「选择 JSON 文件」；选过 → 「重新选择文件」。 */
  private pickLabel(): string {
    return this.state.importFileName.length > 0 ? '重新选择文件' : '选择 JSON 文件';
  }

  /** 确认导入按钮文案：有非法条目时明确写「先修正文件」，避免用户以为按钮坏了。 */
  private confirmLabel(): string {
    if (this.state.dryRunInvalid > 0) {
      return '请先修正文件';
    }
    if (this.state.dryRunReady && this.state.dryRunAdded === 0) {
      return '无可导入记录';
    }
    return '确认导入';
  }

  // ------------------------------------------------------------------ 可用性与三态判定

  /**
   * 「导出」不可用的具体原因（空串 = 可以点）。
   *
   * 忙碌优先（这时区间怎么改都不该再发一次），其次用 `parseDateRange` 的**原话**说明区间哪里不对：
   * 用户点了不可用的按钮会看到同一句原因，不必等一次失败的导出才知道。
   */
  private exportBlockedReason(): string {
    if (this.state.busy) {
      return EXPORT_BUSY_REASON;
    }
    const range: DateRangeResult = parseDateRange(this.fromText, this.toText);
    if (!range.ok) {
      return range.reason;
    }
    return '';
  }

  /** 「选文件 / 取消」不可用的原因：只有忙碌一种。 */
  private busyReason(text: string): string {
    return this.state.busy ? text : '';
  }

  /** 「确认导入」不可用的原因：忙碌 → 文件里的阻塞提示（非法/无可导入）→ 还没选文件。 */
  private confirmBlockedReason(): string {
    if (this.state.busy) {
      return IMPORT_BUSY_REASON;
    }
    const blocked: string = importBlockedTip(this.state);
    if (blocked.length > 0) {
      return blocked;
    }
    if (!this.state.dryRunReady) {
      return CONFIRM_NEED_FILE;
    }
    return '';
  }

  /** 还没导出过（且没有提示文案）：给出「填今天」这一步，而不是一片空白。 */
  private showEmptyExport(): boolean {
    return this.state.exportPath.length === 0 && this.state.message.length === 0;
  }

  /** 当前 message 是一条失败提示（成功提示共用同一个字段，不能一律当错误）。 */
  private isFailureMessage(): boolean {
    const message: string = this.state.message.trim();
    if (message.length === 0) {
      return false;
    }
    for (let index = 0; index < FAILURE_PREFIXES.length; index++) {
      if (message.indexOf(FAILURE_PREFIXES[index]) === 0) {
        return true;
      }
    }
    return false;
  }

  /**
   * 是否渲染错误态：失败文案 + 没有更近的阻塞提示（`importBlockedTip` 更近，优先显示）。
   *
   * `docs/STATE-UI.md` §5 的口径（message 非空 + 阻塞提示为空）在这里加了一道「是失败文案」的
   * 判定——否则「已导出 3 条」这种成功提示会被画成「导出/导入失败」。
   */
  private showErrorState(): boolean {
    return this.isFailureMessage() && importBlockedTip(this.state).length === 0;
  }

  /** 诊断单行：面板拿不到设备号（`deviceId: ''` → model 写「未登记」），错误码也不编。 */
  private panelDiagnostics(): string {
    const input: DiagnosticsInput = {
      version: APP_VERSION,
      deviceId: '',
      errorCode: '',
      timestamp: Date.now()
    };
    return formatDiagnostics(input);
  }

  /** 空态的「填今天」：区间两端都填本机今天（纯函数算，本文件里没有 `new Date()`）。 */
  private fillToday(): void {
    const today: string = todayText();
    this.fromText = today;
    this.toText = today;
  }

  /** 应用快捷区间：只写本地输入态；手改后以手改为准（本组件不记住任何 chip 选择）。 */
  private applyQuickRange(kind: string): void {
    const range: DateRangeResult = quickRange(kind);
    if (!range.ok) {
      return;
    }
    this.fromText = range.from;
    this.toText = range.to;
  }

  /** chip 是否处于高亮（现算，不存状态）。 */
  private isQuickActive(kind: string): boolean {
    return isQuickRangeActive(kind, this.fromText, this.toText);
  }

  /** 提示文案：dry-run 的阻塞提示优先于普通 message（阻塞提示更「近」，不能被别的话盖掉）。 */
  private tipText(): string {
    const blocked: string = importBlockedTip(this.state);
    if (blocked.length > 0) {
      return blocked;
    }
    return this.state.message;
  }

  /** 提示颜色：非法条目用 danger，其余用 secondary。 */
  private tipColor(): Resource {
    if (this.state.dryRunReady && this.state.dryRunInvalid > 0) {
      return $r('app.color.danger');
    }
    return $r('app.color.text_secondary');
  }

  // ------------------------------------------------------------------ UI

  /** 组标题（与设置页其它分组一致：正文级 + `text_primary`）。 */
  @Builder
  GroupTitle(title: string) {
    Text(title)
      .fontSize(FONT.body)
      .lineHeight(LINE_HEIGHT.body)
      .fontWeight(FontWeight.Medium)
      .fontColor($r('app.color.text_primary'))
      .width('100%')
      .textAlign(TextAlign.Start)
  }

  /** 一行说明文字（辅助级）。 */
  @Builder
  HintLine(text: string) {
    Text(text)
      .fontSize(FONT.caption)
      .lineHeight(LINE_HEIGHT.caption)
      .fontColor($r('app.color.text_secondary'))
      .width('100%')
      .textAlign(TextAlign.Start)
  }

  /** 开始日期输入框（高度 `TOUCH_MIN`，白底 + 1vp 下边线，不用圆角卡片）。 */
  @Builder
  FromInput() {
    TextInput({ text: this.fromText, placeholder: '开始日期 2026-11-01' })
      .fontSize(FONT.body)
      .height(TOUCH_MIN)
      .padding({ left: SPACING.sm, right: SPACING.sm })
      .backgroundColor($r('app.color.surface'))
      .fontColor($r('app.color.text_primary'))
      .placeholderColor($r('app.color.text_secondary'))
      .borderRadius(RADIUS.none)
      .border({ width: { bottom: DIVIDER }, color: { bottom: $r('app.color.divider') } })
      .layoutWeight(1)
      .onChange((text: string) => {
        this.fromText = text;
      })
  }

  /** 结束日期输入框（同上）。 */
  @Builder
  ToInput() {
    TextInput({ text: this.toText, placeholder: '结束日期 2026-11-30' })
      .fontSize(FONT.body)
      .height(TOUCH_MIN)
      .padding({ left: SPACING.sm, right: SPACING.sm })
      .backgroundColor($r('app.color.surface'))
      .fontColor($r('app.color.text_primary'))
      .placeholderColor($r('app.color.text_secondary'))
      .borderRadius(RADIUS.none)
      .border({ width: { bottom: DIVIDER }, color: { bottom: $r('app.color.divider') } })
      .layoutWeight(1)
      .onChange((text: string) => {
        this.toText = text;
      })
  }

  /**
   * 格式切换（选中 = 品牌实底反白字，未选中 = 白底品牌字）。
   *
   * A 批：不再拿裸文本当按钮（`Text` 链 `onClick` 已禁），改用 `ActionButton`：
   * 选中档 `primary`、未选中档 `ghost`，两种状态的视觉差异由组件统一保证（可点区仍是 `TOUCH_MIN`）。
   */
  @Builder
  FormatRow() {
    Row({ space: SPACING.sm }) {
      ActionButton({
        label: 'Markdown',
        actionEnabled: true,
        disabledReason: '',
        busy: false,
        variant: this.format === EXPORT_FORMAT_MARKDOWN ? 'primary' : 'ghost',
        block: false,
        onTap: (): void => {
          this.format = EXPORT_FORMAT_MARKDOWN;
        },
        onBlockedTap: null
      })
      ActionButton({
        label: 'JSON',
        actionEnabled: true,
        disabledReason: '',
        busy: false,
        variant: this.format === EXPORT_FORMAT_JSON ? 'primary' : 'ghost',
        block: false,
        onTap: (): void => {
          this.format = EXPORT_FORMAT_JSON;
        },
        onBlockedTap: null
      })
    }
    .width('100%')
    .alignItems(VerticalAlign.Center)
  }

  /** 三个快捷 chip：点一下把 from/to 写成对应区间（不触发导出、不碰 IO）。 */
  @Builder
  QuickRangeRow() {
    Row({ space: SPACING.sm }) {
      ForEach(
        QUICK_RANGE_OPTIONS,
        (option: QuickRangeOption) => {
          ActionButton({
            label: option.label,
            actionEnabled: true,
            disabledReason: '',
            busy: false,
            variant: this.isQuickActive(option.kind) ? 'primary' : 'ghost',
            block: false,
            onTap: (): void => {
              this.applyQuickRange(option.kind);
            },
            onBlockedTap: null
          })
        },
        (option: QuickRangeOption) => option.kind
      )
    }
    .width('100%')
    .alignItems(VerticalAlign.Center)
  }

  /** 最近一次导出的可读路径（长按复制）+ 可选的显式按钮。 */
  @Builder
  ExportPathLine() {
    Column({ space: SPACING.xs }) {
      Text(this.state.exportPath)
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontColor($r('app.color.text_primary'))
        .width('100%')
        .textAlign(TextAlign.Start)
        .copyOption(CopyOptions.LocalDevice)
      Row({ space: SPACING.sm }) {
        Text('长按路径可复制')
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
          .layoutWeight(1)
          .textAlign(TextAlign.Start)
        if (this.onCopyPath !== null) {
          ActionButton({
            label: '复制路径',
            actionEnabled: true,
            disabledReason: '',
            busy: false,
            variant: 'ghost',
            block: false,
            onTap: (): void => {
              this.emitCopyPath();
            },
            onBlockedTap: null
          })
        }
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  /** dry-run 统计块（选文件后出现）。 */
  @Builder
  DryRunBlock() {
    Column({ space: SPACING.xs }) {
      Text(dryRunSummary(this.state))
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontColor($r('app.color.text_primary'))
        .width('100%')
        .textAlign(TextAlign.Start)
      if (isDryRunEmpty(this.state)) {
        this.HintLine('没有可导入的记录')
      }
      if (this.state.dryRunConflict > 0) {
        this.HintLine('冲突的同 id 记录比本机更新，本机版本不会覆盖：需要的话请手工决定')
      }
      if (this.state.dryRunInvalid > 0) {
        this.HintLine('先修正文件：一条非法记录就整批不写（不会写一半）')
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  /**
   * v2 时间线备份节：只在迁移完成（isMigrated()）时渲染。
   *
   * 三态纪律（docs/STATE-UI.md）：没计划 → EmptyState 给「去选备份」；忙 → LoadingState；
   * 类型化拒绝文案走 v2Message + HintLine（不是静默吞点击）。按钮统一 ActionButton，
   * 不可用时不禁用命中，而是点击给 v2BlockedReason() 的具体原因。
   */
  @Builder
  V2Section() {
    Column({ space: SPACING.md }) {
      this.GroupTitle(V2_GROUP_TITLE)
      this.HintLine(V2_HINT)

      if (!this.v2PlanReady && this.v2Message.length === 0) {
        EmptyState({
          title: V2_EMPTY_TITLE,
          detail: V2_EMPTY_DETAIL,
          actionLabel: V2_EMPTY_ACTION,
          compact: true,
          onAction: (): void => {
            const handler: (() => void) | null = this.onV2Pick;
            if (handler !== null) {
              handler();
            }
          }
        })
      }

      Row({ space: SPACING.sm }) {
        ActionButton({
          label: V2_EXPORT_LABEL,
          actionEnabled: this.v2CanTap(this.onV2Export),
          disabledReason: this.v2BlockedReason(),
          busy: this.v2Busy,
          variant: 'secondary',
          block: false,
          onTap: (): void => {
            const handler: (() => void) | null = this.onV2Export;
            if (handler !== null) {
              handler();
            }
          },
          onBlockedTap: null
        })
        ActionButton({
          label: V2_PICK_LABEL,
          actionEnabled: this.v2CanTap(this.onV2Pick),
          disabledReason: this.v2BlockedReason(),
          busy: this.v2Busy,
          variant: 'secondary',
          block: false,
          onTap: (): void => {
            const handler: (() => void) | null = this.onV2Pick;
            if (handler !== null) {
              handler();
            }
          },
          onBlockedTap: null
        })
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      if (this.v2Busy) {
        LoadingState({
          title: loadingText('处理 v2 备份'),
          progress: -1,
          compact: true,
          onCancel: (): void => {
            const handler: (() => void) | null = this.onV2Cancel;
            if (handler !== null) {
              handler();
            }
          }
        })
      }

      if (this.v2PlanReady && this.v2PlanText.length > 0) {
        this.HintLine(this.v2PlanText)
      }
      if (this.v2Message.length > 0) {
        this.HintLine(this.v2Message)
      }

      Row({ space: SPACING.sm }) {
        Column() {
          ActionButton({
            label: V2_APPLY_LABEL,
            actionEnabled: this.v2CanApply(),
            disabledReason: this.v2ApplyBlockedReason(),
            busy: this.v2Busy,
            variant: 'primary',
            block: true,
            onTap: (): void => {
              const handler: (() => void) | null = this.onV2Apply;
              if (handler !== null) {
                handler();
              }
            },
            onBlockedTap: null
          })
        }
        .layoutWeight(1)

        Column() {
          ActionButton({
            label: V2_CANCEL_LABEL,
            actionEnabled: this.v2CanTap(this.onV2Cancel),
            disabledReason: this.v2BlockedReason(),
            busy: false,
            variant: 'secondary',
            block: true,
            onTap: (): void => {
              const handler: (() => void) | null = this.onV2Cancel;
              if (handler !== null) {
                handler();
              }
            },
            onBlockedTap: null
          })
        }
        .layoutWeight(1)
      }
      .width('100%')
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  build() {
    Column({ space: SPACING.md }) {
      this.GroupTitle('导出')
      this.HintLine('按日期区间导出本机记录（只读派生，不改任何源文件）')
      this.QuickRangeRow()

      // 空态：还没导出过 → 「填今天」一键把区间填成本机今天（空态永远有出路）
      if (this.showEmptyExport()) {
        EmptyState({
          title: EMPTY_EXPORT_TITLE,
          detail: EMPTY_EXPORT_DETAIL,
          actionLabel: EMPTY_EXPORT_ACTION,
          compact: true,
          onAction: (): void => {
            this.fillToday();
          }
        })
      }

      Row({ space: SPACING.sm }) {
        this.FromInput()
        Text('~')
          .fontSize(FONT.body)
          .fontColor($r('app.color.text_secondary'))
        this.ToInput()
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      this.FormatRow()

      Row({ space: SPACING.sm }) {
        Checkbox({ name: 'export-attachments' })
          .select(this.includeAttachments)
          .selectedColor($r('app.color.brand'))
          .width(TOUCH_MIN)
          .height(TOUCH_MIN)
          .onChange((value: boolean) => {
            this.includeAttachments = value;
          })
        Text('Markdown 附带附件清单')
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_primary'))
          .layoutWeight(1)
          .textAlign(TextAlign.Start)
      }
      .width('100%')
      .height(TOUCH_MIN)
      .alignItems(VerticalAlign.Center)

      Row({ space: SPACING.sm }) {
        Checkbox({ name: 'export-meta' })
          .select(this.includeMeta)
          .selectedColor($r('app.color.brand'))
          .width(TOUCH_MIN)
          .height(TOUCH_MIN)
          .onChange((value: boolean) => {
            this.includeMeta = value;
          })
        Text('Markdown 附带元信息（标签 / 作者 / 来源设备）')
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_primary'))
          .layoutWeight(1)
          .textAlign(TextAlign.Start)
      }
      .width('100%')
      .height(TOUCH_MIN)
      .alignItems(VerticalAlign.Center)

      ActionButton({
        label: '导出',
        actionEnabled: this.exportBlockedReason().length === 0,
        disabledReason: this.exportBlockedReason(),
        busy: this.state.busy,
        variant: 'primary',
        block: true,
        onTap: (): void => {
          this.emitExport();
        },
        onBlockedTap: null
      })

      // 加载态：导出/导入进行中 → 进度 + 可取消（取消只停「等待」，不等于「已取消」）
      if (this.state.busy) {
        LoadingState({
          title: loadingText('导出'),
          progress: -1,
          compact: true,
          onCancel: (): void => {
            this.emitCancelWait();
          }
        })
      }

      if (this.state.exportPath.length > 0) {
        this.ExportPathLine()
      }

      Divider()
        .strokeWidth(DIVIDER)
        .color($r('app.color.divider'))

      this.GroupTitle('导入')
      // v2-only：未迁移整节禁用，先给 typed 原因；已迁移的落点是 timeline/<date>/records.json。
      this.HintLine(this.importDisabledReason().length > 0
        ? `导入不可用：${this.importDisabledReason()}`
        : '只追加到 timeline/<date>/records.json：冲突（同 id 且更新）不会覆盖，非法记录整批不写')

      ActionButton({
        label: this.pickLabel(),
        actionEnabled: this.importDisabledReason().length === 0 && !this.state.busy,
        disabledReason: this.importDisabledReason().length > 0
          ? this.importDisabledReason()
          : this.busyReason(IMPORT_BUSY_REASON),
        busy: false,
        variant: 'secondary',
        block: true,
        onTap: (): void => {
          this.emitPickFile();
        },
        onBlockedTap: null
      })

      if (this.state.importFileName.length > 0) {
        this.HintLine(`已选：${this.state.importFileName}`)
      }

      if (this.state.dryRunReady) {
        this.DryRunBlock()
      }

      // 提示行：dry-run 的阻塞提示（非法 / 无可导入）与成功提示都走这里；
      // 失败提示改由下面的 ErrorState 呈现（带诊断与重试）。
      if (this.tipText().length > 0 && !this.showErrorState()) {
        Text(this.tipText())
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor(this.tipColor())
          .width('100%')
          .textAlign(TextAlign.Start)
      }

      // 错误态：失败提示 + 诊断四要素 + 重试（重试 = 再导出一次，最常用的重放动作）
      if (this.showErrorState()) {
        ErrorState({
          what: PANEL_ERROR_WHAT,
          why: this.state.message,
          next: PANEL_ERROR_NEXT,
          diagnostics: this.panelDiagnostics(),
          compact: true,
          onRetry: (): void => {
            this.emitExport();
          },
          onOpenSettings: null
        })
      }

      Row({ space: SPACING.sm }) {
        Column() {
          ActionButton({
            label: this.confirmLabel(),
            actionEnabled: canConfirmImport(this.state) && this.importDisabledReason().length === 0,
            disabledReason: this.importDisabledReason().length > 0
              ? this.importDisabledReason()
              : this.confirmBlockedReason(),
            busy: this.state.busy,
            variant: 'primary',
            block: true,
            onTap: (): void => {
              this.emitConfirmImport();
            },
            onBlockedTap: null
          })
        }
        .layoutWeight(1)

        Column() {
          ActionButton({
            label: '取消',
            actionEnabled: !this.state.busy && this.importDisabledReason().length === 0,
            disabledReason: this.importDisabledReason().length > 0
              ? this.importDisabledReason()
              : this.busyReason(CANCEL_BUSY_REASON),
            busy: false,
            variant: 'secondary',
            block: true,
            onTap: (): void => {
              this.emitCancel();
            },
            onBlockedTap: null
          })
        }
        .layoutWeight(1)
      }
      .width('100%')

      // v2 时间线备份：只在共享时间线模式启用时出现；v1 用户看不到这一节。
      if (this.v2Visible()) {
        Divider()
          .strokeWidth(DIVIDER)
          .color($r('app.color.divider'))
        this.V2Section()
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .backgroundColor($r('app.color.page_background'))
  }
}
