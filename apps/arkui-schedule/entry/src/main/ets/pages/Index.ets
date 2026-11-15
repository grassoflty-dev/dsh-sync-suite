/**
 * 主页：日期条 + 今日待办/全部未完成 + 列表（左勾选 / 中标题+时间 / 右手迹）+ 「新建」主操作
 * + 「更多」面板（AI 汇总 / 同步 / 提醒 / 含其他设备）。
 *
 * 契约：BRIEF §3.5、`docs/CONTRACT.md` §3.4。**行为完全不变**，只重排 UI（`docs/UI-DESIGN.md`）：
 * - 勾选完成 = `appendRecord` 追加一条同 id 新记录（ts=nowIso()），绝不改写历史行；
 * - 「AI 汇总」读当天 `ai_processed:false` 的记录，允许逐条取消勾选；
 * - 「同步」进入设置页并自动触发拉取（Web 版 Git 内核只挂在设置页，见 services/GitSyncService.ets）；
 * - 「提醒」入口只在 HarmonyOS 侧显示，实际由平台覆盖文件调用 ReminderService。
 *
 * 布局：断点由 `PageLayout` 统一计算（`onAreaChange` + 方向），本页只做一处粗粒度分支
 * `breakpoint === 'compact'`：紧凑屏单列（日期条在上面），宽屏/横屏双栏（左日期条、右列表）。
 *
 * 每日 AI 汇总为**手动触发**（BRIEF §3.4）：不做定时汇总。原因：鸿蒙侧 `setInterval` 在应用
 * 退到后台后会被系统回收，纯 TS 定时器无法保证按时触发；真要做定时汇总，必须申请长时任务
 * （`continuousTask`）+ 前台通知，或改用 `reminderAgentManager` 到点拉起。这里刻意不加
 * 「看起来能用、实际会被回收」的定时器。
 */
import { promptAction, router } from '@kit.ArkUI';
import { common } from '@kit.AbilityKit';
import { localDateKey, nextTsSameDate, nowIso } from '../common/date';
import { applyAiResult, buildAiPayload } from '../model/aiPayload';
import type { AiPayload, ScheduleRecord } from '../model/types';
import { cloneRecord } from '../model/types';
import { isHarmonyOS } from '../common/platform';
import { createReminders } from '../common/platformFeatures';
import { describeError, scheduleStore } from '../services/scheduleStore';
import { settingsStore } from '../services/settingsStore';
import { deviceTimeZone, summarize } from '../services/deepseek';
import { EmptyState } from '../components/EmptyState';
import { PageLayout } from '../components/PageLayout';
import { RecordRow } from '../components/RecordRow';
import { DIVIDER, FONT, LINE_HEIGHT, RADIUS, SPACING, TOUCH_MIN, sidebarWidth } from '../common/uiTokens';

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
  @State ready: boolean = false;
  @State canRemind: boolean = false;

  /** 断点（由 `PageLayout` 回调同步，页面只按 compact / 非 compact 分支）。 */
  @State breakpoint: string = 'compact';
  /** 内容区宽度（vp），宽屏下算侧栏宽度。 */
  @State contentWidth: number = 0;
  /** 「更多」面板是否展开。 */
  @State showMore: boolean = false;

  // AI 汇总面板状态
  @State showAiPanel: boolean = false;
  @State aiCandidates: ScheduleRecord[] = [];
  @State aiSelected: string[] = [];
  @State aiPanelDate: string = '';
  @State aiBusy: boolean = false;
  @State aiResultVisible: boolean = false;
  @State aiResultText: string = '';

  aboutToAppear(): void {
    this.canRemind = isHarmonyOS();
    this.bootstrap();
  }

  /** 从编辑页/设置页返回时重新加载（追加写语义下必须重读）。 */
  onPageShow(): void {
    if (this.ready) {
      this.reload();
      return;
    }
    scheduleStore
      .ensureReady(getContext(this) as common.UIAbilityContext)
      .then(() => {
        this.ready = true;
        this.reload();
      })
      .catch((error: Error) => {
        this.statusText = `存储初始化失败：${describeError(error)}`;
      });
  }

  private async bootstrap(): Promise<void> {
    try {
      await scheduleStore.ensureReady(getContext(this) as common.UIAbilityContext);
      this.ready = true;
      this.reload();
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
        const all = this.includeOtherDevices ? scheduleStore.readAllDevices() : scheduleStore.readAll();
        const pending: ScheduleRecord[] = [];
        for (const record of all) {
          if (record.done !== true) {
            pending.push(record);
          }
        }
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
  }

  /** 标题：今日待办显示日期，全部未完成显示模式名。 */
  private pageTitle(): string {
    return this.showAllPending ? '全部未完成' : this.selectedDate;
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
  }

  private goToday(): void {
    this.selectedDate = localDateKey(new Date());
    this.showAllPending = false;
    this.showDatePicker = false;
    this.reload();
  }

  private openNew(): void {
    const params: Record<string, string> = { 'id': '', 'date': this.selectedDate };
    router.pushUrl({ url: 'pages/Edit', params: params }).catch((error: Error) => {
      promptAction.showToast({ message: `打开编辑页失败：${describeError(error)}` });
    });
  }

  private openDetail(id: string): void {
    const params: Record<string, string> = { 'id': id };
    router.pushUrl({ url: 'pages/Detail', params: params }).catch((error: Error) => {
      promptAction.showToast({ message: `打开详情页失败：${describeError(error)}` });
    });
  }

  /** 同步入口：设置页挂载了 Git Web 内核，这里带参数过去自动触发拉取。 */
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

  private async createRemindersNow(): Promise<void> {
    try {
      const all = scheduleStore.readAll();
      const message = await createReminders(all, getContext(this) as common.UIAbilityContext);
      promptAction.showToast({ message: message, duration: 4000 });
    } catch (error) {
      promptAction.showToast({ message: `创建提醒失败：${describeError(error)}`, duration: 4000 });
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

  /** 唯一主操作：新建（强调色实底，全宽 48vp）。 */
  @Builder
  PrimaryAction() {
    Button('新建')
      .width('100%')
      .height(PRIMARY_HEIGHT)
      .fontSize(FONT.body)
      .backgroundColor($r('app.color.brand'))
      .fontColor($r('app.color.text_inverse'))
      .borderRadius(RADIUS.sm)
      .onClick(() => this.openNew())
  }

  /** 列表（行自带 1vp 分割线，因此 List space 为 0）。 */
  @Builder
  RecordList() {
    if (this.records.length === 0) {
      EmptyState({
        title: this.showAllPending ? '没有未完成的日程' : '这一天还没有日程',
        hint: this.showAllPending ? '切换回「今日待办」看看当天安排' : '点「新建」记录一条，或切换日期'
      })
    } else {
      List() {
        ForEach(
          this.records,
          (item: ScheduleRecord) => {
            ListItem() {
              RecordRow({
                record: item,
                onToggle: (id: string, done: boolean) => {
                  this.toggleDone(id, done);
                },
                onOpen: (id: string) => {
                  this.openDetail(id);
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
  }

  /** 紧凑屏：日期条 → 模式 → 列表 → 新建（单列自上而下）。 */
  @Builder
  CompactBody() {
    Column({ space: SPACING.md }) {
      this.DateBlock()
      this.ModeTabs()
      Divider()
        .strokeWidth(DIVIDER)
        .color($r('app.color.divider'))
      this.RecordList()
      this.PrimaryAction()
    }
    .width('100%')
    .height('100%')
  }

  /** 宽屏/横屏：左日期列（日期条 + 模式 + 新建）+ 右列表。 */
  @Builder
  WideBody() {
    Row({ space: SPACING.lg }) {
      Column({ space: SPACING.md }) {
        this.DateBlock()
        this.ModeTabs()
        Divider()
          .strokeWidth(DIVIDER)
          .color($r('app.color.divider'))
        this.PrimaryAction()
      }
      .width(sidebarWidth(this.contentWidth))
      .height('100%')
      .alignItems(HorizontalAlign.Start)

      Divider()
        .vertical(true)
        .strokeWidth(DIVIDER)
        .color($r('app.color.divider'))
        .height('100%')

      Column() {
        this.RecordList()
      }
      .layoutWeight(1)
      .height('100%')
    }
    .width('100%')
    .height('100%')
    .alignItems(VerticalAlign.Top)
  }

  /** 「更多」底部面板：次要操作全部收在这里，每行 48vp。 */
  @Builder
  MoreSheet() {
    Column() {
      Row() {
        Text('更多')
          .fontSize(FONT.body)
          .lineHeight(LINE_HEIGHT.body)
          .fontWeight(FontWeight.Medium)
          .fontColor($r('app.color.text_primary'))
        Blank()
        Text('关闭')
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
          .height(TOUCH_MIN)
          .padding({ left: SPACING.md, right: SPACING.md })
          .textAlign(TextAlign.Center)
          .onClick(() => {
            this.showMore = false;
          })
      }
      .width('100%')

      Divider()
        .strokeWidth(DIVIDER)
        .color($r('app.color.divider'))

      Text('AI 汇总（今日记录）')
        .fontSize(FONT.body)
        .lineHeight(LINE_HEIGHT.body)
        .fontColor($r('app.color.text_primary'))
        .width('100%')
        .height(PRIMARY_HEIGHT)
        .textAlign(TextAlign.Start)
        .onClick(() => {
          this.showMore = false;
          this.openAiPanel();
        })
      Divider()
        .strokeWidth(DIVIDER)
        .color($r('app.color.divider'))

      Text('同步（拉取远端）')
        .fontSize(FONT.body)
        .lineHeight(LINE_HEIGHT.body)
        .fontColor($r('app.color.text_primary'))
        .width('100%')
        .height(PRIMARY_HEIGHT)
        .textAlign(TextAlign.Start)
        .onClick(() => {
          this.showMore = false;
          this.openSync();
        })
      Divider()
        .strokeWidth(DIVIDER)
        .color($r('app.color.divider'))

      if (this.canRemind) {
        Text('创建提醒')
          .fontSize(FONT.body)
          .lineHeight(LINE_HEIGHT.body)
          .fontColor($r('app.color.text_primary'))
          .width('100%')
          .height(PRIMARY_HEIGHT)
          .textAlign(TextAlign.Start)
          .onClick(() => {
            this.showMore = false;
            this.createRemindersNow();
          })
        Divider()
          .strokeWidth(DIVIDER)
          .color($r('app.color.divider'))
      }

      Text(this.includeOtherDevices ? '只看本机（当前含其他设备）' : '含其他设备（只读）')
        .fontSize(FONT.body)
        .lineHeight(LINE_HEIGHT.body)
        .fontColor(this.includeOtherDevices ? $r('app.color.brand') : $r('app.color.text_primary'))
        .width('100%')
        .height(PRIMARY_HEIGHT)
        .textAlign(TextAlign.Start)
        .onClick(() => {
          this.includeOtherDevices = !this.includeOtherDevices;
          this.showMore = false;
          this.reload();
        })
    }
    .width('100%')
    .padding(SPACING.lg)
    .backgroundColor($r('app.color.surface'))
    .borderRadius({ topLeft: RADIUS.md, topRight: RADIUS.md })
    .alignItems(HorizontalAlign.Start)
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
        subtitle: this.statusText,
        onMore: () => {
          this.showMore = true;
        },
        onBreakpointChange: (breakpoint: string, widthVp: number) => {
          this.breakpoint = breakpoint;
          this.contentWidth = widthVp;
        }
      }) {
        if (this.breakpoint === 'compact') {
          this.CompactBody()
        } else {
          this.WideBody()
        }
      }

      if (this.showAiPanel || this.aiResultVisible || this.showMore) {
        Column()
          .width('100%')
          .height('100%')
          .backgroundColor($r('app.color.scrim'))
          .onClick(() => {
            if (!this.aiBusy) {
              this.showAiPanel = false;
              this.aiResultVisible = false;
              this.showMore = false;
            }
          })
      }
      if (this.showMore) {
        Column() {
          Blank()
          this.MoreSheet()
        }
        .width('100%')
        .height('100%')
      }
      if (this.showAiPanel) {
        this.AiPanel()
      }
      if (this.aiResultVisible) {
        this.AiResultPanel()
      }
    }
    .width('100%')
    .height('100%')
  }
}
