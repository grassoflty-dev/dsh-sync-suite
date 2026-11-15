/**
 * 主页：日期选择 + 今日待办/全部未完成切换 + 列表（左勾选 / 中标题+时间 / 右 📎 手迹）
 * + 底部「新建 / AI 汇总 / 同步 / 提醒」。
 *
 * 契约：BRIEF §3.5、`docs/CONTRACT.md` §3.4。
 * - 勾选完成 = `appendRecord` 追加一条同 id 新记录（ts=nowIso()），绝不改写历史行；
 * - 「AI 汇总」读当天 `ai_processed:false` 的记录，允许逐条取消勾选；
 * - 「同步」进入设置页并自动触发拉取（Web 版 Git 内核只挂在设置页，见 services/GitSyncService.ets）；
 * - 「提醒」入口只在 HarmonyOS 侧显示，实际由平台覆盖文件调用 ReminderService。
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
import { RecordRow } from '../components/RecordRow';
import { EmptyState } from '../components/EmptyState';

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

  private countDoneText(): string {
    return this.showAllPending ? '全部未完成' : this.selectedDate;
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

  @Builder
  DateBar() {
    Column({ space: 8 }) {
      Row({ space: 8 }) {
        Button('‹')
          .type(ButtonType.Circle)
          .width(36)
          .height(36)
          .backgroundColor('#E8F1FF')
          .fontColor($r('app.color.brand'))
          .onClick(() => this.shiftDate(-1))

        Column({ space: 2 }) {
          Text(this.selectedDate)
            .fontSize(18)
            .fontWeight(FontWeight.Bold)
            .fontColor($r('app.color.text_primary'))
          Text('点击选择日期')
            .fontSize(11)
            .fontColor($r('app.color.text_secondary'))
        }
        .layoutWeight(1)
        .onClick(() => {
          this.showDatePicker = !this.showDatePicker;
        })

        Button('›')
          .type(ButtonType.Circle)
          .width(36)
          .height(36)
          .backgroundColor('#E8F1FF')
          .fontColor($r('app.color.brand'))
          .onClick(() => this.shiftDate(1))

        Button('今天')
          .height(36)
          .fontSize(13)
          .backgroundColor($r('app.color.brand'))
          .fontColor(Color.White)
          .onClick(() => this.goToday())
      }
      .width('100%')

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

  @Builder
  ModeTabs() {
    Row({ space: 8 }) {
      Text('今日待办')
        .fontSize(14)
        .fontColor(this.showAllPending ? $r('app.color.text_secondary') : Color.White)
        .backgroundColor(this.showAllPending ? Color.White : $r('app.color.brand'))
        .borderRadius(16)
        .padding({ left: 14, right: 14, top: 6, bottom: 6 })
        .onClick(() => {
          this.showAllPending = false;
          this.reload();
        })
      Text('全部未完成')
        .fontSize(14)
        .fontColor(this.showAllPending ? Color.White : $r('app.color.text_secondary'))
        .backgroundColor(this.showAllPending ? $r('app.color.brand') : Color.White)
        .borderRadius(16)
        .padding({ left: 14, right: 14, top: 6, bottom: 6 })
        .onClick(() => {
          this.showAllPending = true;
          this.showDatePicker = false;
          this.reload();
        })
      Blank()
      Text(this.includeOtherDevices ? '含其他设备' : '仅本机')
        .fontSize(13)
        .fontColor(this.includeOtherDevices ? Color.White : $r('app.color.text_secondary'))
        .backgroundColor(this.includeOtherDevices ? $r('app.color.brand') : Color.White)
        .borderRadius(14)
        .padding({ left: 12, right: 12, top: 5, bottom: 5 })
        .onClick(() => {
          this.includeOtherDevices = !this.includeOtherDevices;
          this.reload();
        })
      Text(this.countDoneText())
        .fontSize(12)
        .fontColor($r('app.color.text_secondary'))
    }
    .width('100%')
  }

  @Builder
  RecordList() {
    if (this.records.length === 0) {
      EmptyState({
        title: this.showAllPending ? '没有未完成的日程' : '这一天还没有日程',
        hint: this.showAllPending ? '切换回「今日待办」看看当天安排' : '点击底部「新建」记录一条，或切换日期',
        icon: '📅'
      })
    } else {
      List({ space: 8 }) {
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

  @Builder
  AiPanel() {
    Column({ space: 10 }) {
      Row() {
        Text('AI 汇总（可取消勾选）')
          .fontSize(16)
          .fontWeight(FontWeight.Bold)
          .fontColor($r('app.color.text_primary'))
        Blank()
        Text(this.aiSelected.length === this.aiCandidates.length ? '全不选' : '全选')
          .fontSize(13)
          .fontColor($r('app.color.brand'))
          .onClick(() => this.selectAllAi())
      }
      .width('100%')

      Text(`${this.aiPanelDate} · 已选 ${this.aiSelected.length} / ${this.aiCandidates.length} 条`)
        .fontSize(12)
        .fontColor($r('app.color.text_secondary'))
        .width('100%')

      List({ space: 6 }) {
        ForEach(
          this.aiCandidates,
          (item: ScheduleRecord) => {
            ListItem() {
              Row({ space: 8 }) {
                Checkbox({ name: `ai-${item.id}` })
                  .select(this.isAiSelected(item.id))
                  .selectedColor($r('app.color.brand'))
                  .onChange(() => {
                    this.toggleAi(item.id);
                  })
                Column({ space: 2 }) {
                  Text(item.title.length > 0 ? item.title : '(未命名日程)')
                    .fontSize(14)
                    .fontColor($r('app.color.text_primary'))
                    .maxLines(1)
                    .textOverflow({ overflow: TextOverflow.Ellipsis })
                    .width('100%')
                  Text(item.body.length > 0 ? item.body : '（无正文，将使用原始识别文本）')
                    .fontSize(11)
                    .fontColor($r('app.color.text_secondary'))
                    .maxLines(1)
                    .textOverflow({ overflow: TextOverflow.Ellipsis })
                    .width('100%')
                }
                .layoutWeight(1)
                .alignItems(HorizontalAlign.Start)
              }
              .width('100%')
              .padding({ top: 4, bottom: 4 })
            }
          },
          (item: ScheduleRecord) => `${item.id}|${this.isAiSelected(item.id) ? '1' : '0'}`
        )
      }
      .width('100%')
      .height(220)
      .scrollBar(BarState.Auto)

      Row({ space: 10 }) {
        Button('取消')
          .layoutWeight(1)
          .backgroundColor('#EEF1F4')
          .fontColor($r('app.color.text_primary'))
          .onClick(() => {
            this.showAiPanel = false;
          })
        Button(this.aiBusy ? '整理中…' : '开始汇总')
          .layoutWeight(1)
          .backgroundColor($r('app.color.brand'))
          .fontColor(Color.White)
          .enabled(!this.aiBusy)
          .onClick(() => {
            this.runAi();
          })
      }
      .width('100%')

      if (this.aiBusy) {
        Text('正在调用 DeepSeek，请稍候…')
          .fontSize(12)
          .fontColor($r('app.color.brand'))
      }
    }
    .width('92%')
    .padding(16)
    .backgroundColor(Color.White)
    .borderRadius(16)
    .shadow({ radius: 24, color: '#22000000', offsetY: 8 })
  }

  @Builder
  AiResultPanel() {
    Column({ space: 10 }) {
      Row() {
        Text('AI 整理结果')
          .fontSize(16)
          .fontWeight(FontWeight.Bold)
          .fontColor($r('app.color.text_primary'))
        Blank()
        Text('关闭')
          .fontSize(13)
          .fontColor($r('app.color.brand'))
          .onClick(() => {
            this.aiResultVisible = false;
          })
      }
      .width('100%')
      Scroll() {
        Text(this.aiResultText)
          .fontSize(13)
          .fontColor($r('app.color.text_primary'))
          .width('100%')
          .textAlign(TextAlign.Start)
          .lineHeight(20)
      }
      .layoutWeight(1)
      .width('100%')
      Text('结果已写入各条记录的 ai_structured，原始识别文本 ocr_text 保持不变')
        .fontSize(11)
        .fontColor($r('app.color.text_secondary'))
        .width('100%')
    }
    .width('92%')
    .height('70%')
    .padding(16)
    .backgroundColor(Color.White)
    .borderRadius(16)
  }

  build() {
    Stack({ alignContent: Alignment.Center }) {
      Column({ space: 12 }) {
        this.DateBar()
        this.ModeTabs()
        this.RecordList()

        Text(this.statusText)
          .fontSize(12)
          .fontColor($r('app.color.text_secondary'))
          .width('100%')

        Row({ space: 8 }) {
          Button('新建')
            .layoutWeight(1)
            .height(44)
            .backgroundColor($r('app.color.brand'))
            .fontColor(Color.White)
            .onClick(() => this.openNew())
          Button('AI 汇总')
            .layoutWeight(1)
            .height(44)
            .backgroundColor('#E8F1FF')
            .fontColor($r('app.color.brand'))
            .onClick(() => this.openAiPanel())
          Button('同步')
            .layoutWeight(1)
            .height(44)
            .backgroundColor('#E8F1FF')
            .fontColor($r('app.color.brand'))
            .onClick(() => this.openSync())
          if (this.canRemind) {
            Button('提醒')
              .layoutWeight(1)
              .height(44)
              .backgroundColor('#E8F1FF')
              .fontColor($r('app.color.brand'))
              .onClick(() => {
                this.createRemindersNow();
              })
          }
        }
        .width('100%')
      }
      .width('100%')
      .height('100%')
      .padding(12)
      .backgroundColor($r('app.color.page_background'))

      if (this.showAiPanel || this.aiResultVisible) {
        Column()
          .width('100%')
          .height('100%')
          .backgroundColor('#66000000')
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
    }
    .width('100%')
    .height('100%')
  }
}
