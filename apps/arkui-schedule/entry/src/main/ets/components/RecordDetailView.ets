/**
 * 日程详情视图（可嵌入 Detail 页，也可作为首页横屏主从布局的右栏）。
 *
 * 入参是**记录 id** 而不是记录对象：组件自己从 `scheduleStore` 读，容器在保存/返回后用
 * `refreshTick` 加一触发重读；记录不存在 → 渲染空态（被删/换日期后自然回空态）。
 *
 * 契约：BRIEF §3.2（`ocr_text` 保留原始识别结果不被覆盖）、§3.5、`docs/CONTRACT.md` §3.4。
 * - 保存 AI 文本时**不改变记录日期**：ts 取「原日期 + 当前时钟」，记录留在原 `YYYY-MM-DD.jsonl`，
 *   同时 ts 严格变大，`foldById` 稳定取新值；
 * - 截图预览用沙箱文件 URI 交给 `Image()`；共享层禁止引用 `@kit.ImageKit` / PixelMap（validate 规则 4）。
 */
import { promptAction } from '@kit.ArkUI';
import { common } from '@kit.AbilityKit';
import { formatClock, nextTsSameDate, nowIso } from '../common/date';
import { recordDateKey } from '../model/jsonl';
import { buildAiPayload } from '../model/aiPayload';
import type { Attachment, ScheduleRecord } from '../model/types';
import { cloneRecord } from '../model/types';
import { describeError, scheduleStore } from '../services/scheduleStore';
import { settingsStore } from '../services/settingsStore';
import { attachmentStore } from '../services/attachmentStore';
import { deviceTimeZone, summarize } from '../services/deepseek';
import { DIVIDER, FONT, LINE_HEIGHT, RADIUS, SPACING, TOUCH_MIN } from '../common/uiTokens';

const PRIMARY_HEIGHT: number = 48;
const THUMB: number = 88;
const AI_TEXT_HEIGHT: number = 160;

@Component
export struct RecordDetailView {
  /** 要展示的记录 id；空串 = 空态（「从左侧选一条日程查看」）。 */
  @Prop recordId: string = '';
  /** 容器在保存/切页后 +1，触发重新读记录。 */
  @Prop @Watch('onRefreshTick') refreshTick: number = 0;
  /** 「编辑」动作：由容器决定（跳页面或切右栏）；为 null 时不渲染该按钮。 */
  onEdit: (() => void) | null = null;
  /** 「AI 整理」动作：默认组件内直接跑；容器传了就交给容器。 */
  onAi: (() => void) | null = null;
  /** 删除动作：当前应用没有删除语义（契约无墓碑字段），传 null 时不渲染。 */
  onDelete: (() => void) | null = null;

  @State title: string = '';
  @State ts: string = '';
  @State author: string = '';
  @State done: boolean = false;
  @State body: string = '';
  @State ocrText: string = '';
  @State aiText: string = '';
  @State attachments: Attachment[] = [];
  @State previewSha: string = '';
  @State statusText: string = '';
  @State loaded: boolean = false;
  @State aiBusy: boolean = false;
  private raw: ScheduleRecord | null = null;

  aboutToAppear(): void {
    this.bootstrap();
  }

  /** 存储可能尚未初始化（深链/冷启动直达详情）：先确保就绪再读。 */
  private async bootstrap(): Promise<void> {
    if (!scheduleStore.isReady()) {
      try {
        await scheduleStore.ensureReady(getContext(this) as common.UIAbilityContext);
      } catch (error) {
        this.statusText = `存储初始化失败：${describeError(error)}`;
        this.loaded = false;
        return;
      }
    }
    this.load();
  }

  /** 容器刷新（保存 / 切选中行）时重读。 */
  onRefreshTick(): void {
    this.load();
  }

  private load(): void {
    this.previewSha = '';
    if (this.recordId.length === 0) {
      this.raw = null;
      this.loaded = false;
      this.statusText = '';
      return;
    }
    if (!scheduleStore.isReady()) {
      this.raw = null;
      this.loaded = false;
      this.statusText = '存储尚未就绪';
      return;
    }
    let record: ScheduleRecord | null = null;
    try {
      record = scheduleStore.findByIdAny(this.recordId);
    } catch (error) {
      this.raw = null;
      this.loaded = false;
      this.statusText = `读取记录失败：${describeError(error)}`;
      return;
    }
    if (record === null) {
      this.raw = null;
      this.loaded = false;
      this.statusText = '记录不存在：可能已被其他设备改写';
      return;
    }
    this.raw = record;
    this.title = record.title;
    this.ts = record.ts;
    this.author = record.author;
    this.done = record.done;
    this.body = record.body;
    this.ocrText = record.ocr_text === undefined ? '' : record.ocr_text;
    this.aiText = record.ai_structured === undefined ? '' : record.ai_structured;
    this.attachments = record.attachments === undefined ? [] : record.attachments;
    this.loaded = true;
    this.statusText = '';
  }

  /** 保存可编辑的 AI 结构化文本（不触碰 ocr_text）。 */
  private saveAiText(): void {
    const base = this.raw;
    if (base === null) {
      promptAction.showToast({ message: '记录尚未载入，无法保存' });
      return;
    }
    const text = this.aiText.trim();
    const next: ScheduleRecord = cloneRecord(base);
    next.ts = nextTsSameDate(base.ts);
    next.ai_structured = text;
    next.ai_processed = true;
    try {
      scheduleStore.appendRecord(next);
    } catch (error) {
      promptAction.showToast({ message: `保存失败：${describeError(error)}`, duration: 4000 });
      return;
    }
    promptAction.showToast({ message: 'AI 结构化内容已保存' });
    this.load();
  }

  /** 只对当前记录跑一次 AI 结构化。 */
  private async runAiForRecord(): Promise<void> {
    const base = this.raw;
    if (base === null) {
      promptAction.showToast({ message: '记录尚未载入，无法整理' });
      return;
    }
    let aiKey = '';
    let providerId = '';
    let model = '';
    let baseURL = '';
    try {
      const settings = await settingsStore.load(getContext(this) as common.UIAbilityContext);
      aiKey = settings.aiKey;
      providerId = settings.aiProviderId;
      model = settings.aiModel;
      baseURL = settings.aiBaseURL;
    } catch (error) {
      promptAction.showToast({ message: `读取设置失败：${describeError(error)}` });
      return;
    }
    if (aiKey.trim().length === 0) {
      promptAction.showToast({ message: '请先在设置页填写 AI Key', duration: 4000 });
      return;
    }
    const candidate: ScheduleRecord = cloneRecord(base);
    candidate.ai_processed = false;
    const payload = buildAiPayload(recordDateKey(candidate.ts), [candidate]);
    if (payload.records.length === 0) {
      promptAction.showToast({ message: '这条记录没有可整理的内容（正文与识别文本都为空）' });
      return;
    }
    this.aiBusy = true;
    try {
      const text = await summarize(payload, aiKey, nowIso(), deviceTimeZone(), model, providerId, baseURL);
      this.aiText = text;
      promptAction.showToast({ message: 'AI 结果已填入，点「保存」写入记录', duration: 4000 });
    } catch (error) {
      promptAction.showToast({ message: describeError(error), duration: 5000 });
    } finally {
      this.aiBusy = false;
    }
  }

  private metaLine(): string {
    const clock = formatClock(this.ts);
    const parts: string[] = [];
    if (this.ts.length >= 10) {
      parts.push(this.ts.slice(0, 10));
    }
    if (clock.length > 0) {
      parts.push(clock);
    }
    if (this.author.length > 0) {
      parts.push(this.author);
    }
    parts.push(this.done ? '已完成' : '未完成');
    return parts.join(' · ');
  }

  // ------------------------------------------------------------------ UI

  @Builder
  FieldLabel(text: string) {
    Text(text)
      .fontSize(FONT.caption)
      .lineHeight(LINE_HEIGHT.caption)
      .fontColor($r('app.color.text_secondary'))
      .width('100%')
      .textAlign(TextAlign.Start)
  }

  @Builder
  BodyBlock() {
    Column({ space: SPACING.sm }) {
      Text(this.title.length > 0 ? this.title : '(未命名日程)')
        .fontSize(FONT.title)
        .lineHeight(LINE_HEIGHT.title)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('app.color.text_primary'))
        .width('100%')
        .textAlign(TextAlign.Start)
      Text(this.metaLine())
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontColor($r('app.color.text_secondary'))
        .width('100%')
        .textAlign(TextAlign.Start)
      Text(this.body.length > 0 ? this.body : '（空）')
        .fontSize(FONT.body)
        .lineHeight(LINE_HEIGHT.body)
        .fontColor(this.body.length > 0 ? $r('app.color.text_primary') : $r('app.color.text_secondary'))
        .width('100%')
        .textAlign(TextAlign.Start)
        .copyOption(CopyOptions.LocalDevice)
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  AiBlock() {
    Column({ space: SPACING.sm }) {
      Row({ space: SPACING.sm }) {
        Text('AI 结构化')
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
          .layoutWeight(1)
          .textAlign(TextAlign.Start)
        if (this.aiText.trim().length > 0) {
          Text(this.aiBusy ? '保存中…' : '保存')
            .fontSize(FONT.caption)
            .lineHeight(LINE_HEIGHT.caption)
            .fontColor($r('app.color.brand'))
            .height(TOUCH_MIN)
            .padding({ left: SPACING.md, right: SPACING.md })
            .textAlign(TextAlign.Center)
            .onClick(() => this.saveAiText())
        }
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      if (this.aiText.trim().length === 0) {
        Text(this.aiBusy ? '正在整理…' : '尚未生成。点下方「AI 整理」生成，生成后可编辑并保存。')
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
          .width('100%')
          .textAlign(TextAlign.Start)
      } else {
        TextArea({ text: this.aiText, placeholder: 'AI 结构化结果' })
          .width('100%')
          .height(AI_TEXT_HEIGHT)
          .fontSize(FONT.body)
          .backgroundColor($r('app.color.page_background'))
          .borderRadius(RADIUS.none)
          .padding({ left: 0, right: 0 })
          .onChange((value: string) => {
            this.aiText = value;
          })
        Divider()
          .strokeWidth(DIVIDER)
          .color($r('app.color.divider'))
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  OcrBlock() {
    Column({ space: SPACING.sm }) {
      this.FieldLabel('原始识别文本（只读）')
      Text(this.ocrText.length > 0 ? this.ocrText : '（这条记录没有手写识别原文）')
        .fontSize(FONT.body)
        .lineHeight(LINE_HEIGHT.body)
        .fontColor(this.ocrText.length > 0 ? $r('app.color.text_primary') : $r('app.color.text_secondary'))
        .width('100%')
        .textAlign(TextAlign.Start)
        .copyOption(CopyOptions.LocalDevice)
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  AttachmentStrip() {
    Column({ space: SPACING.sm }) {
      Text(`手迹附件（${this.attachments.length} 页）`)
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontColor($r('app.color.text_secondary'))
        .width('100%')
        .textAlign(TextAlign.Start)
      List({ space: SPACING.sm }) {
        ForEach(
          this.attachments,
          (item: Attachment) => {
            ListItem() {
              Column({ space: SPACING.xs }) {
                Image(attachmentStore.attachmentUri(item.sha256))
                  .width(THUMB)
                  .height(THUMB)
                  .borderRadius(RADIUS.none)
                  .objectFit(ImageFit.Cover)
                  .backgroundColor($r('app.color.page_background'))
                  .onClick(() => {
                    this.previewSha = item.sha256;
                  })
                Text(`第 ${item.pageIndex + 1} 页`)
                  .fontSize(FONT.caption)
                  .lineHeight(LINE_HEIGHT.caption)
                  .fontColor($r('app.color.text_secondary'))
              }
            }
          },
          (item: Attachment) => `${item.sha256}|${item.pageIndex}`
        )
      }
      .listDirection(Axis.Horizontal)
      .height(THUMB + 32)
      .width('100%')
      .scrollBar(BarState.Off)
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  /** 底部动作行：编辑（主）+ AI 整理（次）；删除槽位存在但默认不渲染。 */
  @Builder
  Actions() {
    Row({ space: SPACING.md }) {
      if (this.onEdit !== null) {
        Button('编辑')
          .height(PRIMARY_HEIGHT)
          .fontSize(FONT.body)
          .backgroundColor($r('app.color.brand'))
          .fontColor($r('app.color.text_inverse'))
          .borderRadius(RADIUS.sm)
          .onClick(() => {
            const handler: (() => void) | null = this.onEdit;
            if (handler !== null) {
              handler();
            }
          })
      }
      Button(this.aiBusy ? '整理中…' : 'AI 整理')
        .height(PRIMARY_HEIGHT)
        .fontSize(FONT.body)
        .backgroundColor($r('app.color.brand_soft'))
        .fontColor($r('app.color.brand'))
        .borderRadius(RADIUS.sm)
        .enabled(!this.aiBusy)
        .onClick(() => {
          const handler: (() => void) | null = this.onAi;
          if (handler !== null) {
            handler();
          } else {
            this.runAiForRecord();
          }
        })
      if (this.onDelete !== null) {
        Button('删除')
          .height(PRIMARY_HEIGHT)
          .fontSize(FONT.body)
          .backgroundColor($r('app.color.brand_soft'))
          .fontColor($r('app.color.danger'))
          .borderRadius(RADIUS.sm)
          .onClick(() => {
            const handler: (() => void) | null = this.onDelete;
            if (handler !== null) {
              handler();
            }
          })
      }
    }
    .width('100%')
    .alignItems(VerticalAlign.Center)
  }

  build() {
    Stack({ alignContent: Alignment.Center }) {
      Column() {
        if (this.recordId.length === 0) {
          Column({ space: SPACING.sm }) {
            Text('从左侧选一条日程查看')
              .fontSize(FONT.body)
              .lineHeight(LINE_HEIGHT.body)
              .fontColor($r('app.color.text_secondary'))
              .width('100%')
              .textAlign(TextAlign.Center)
          }
          .width('100%')
          .height('100%')
          .justifyContent(FlexAlign.Center)
        } else if (!this.loaded) {
          Column({ space: SPACING.sm }) {
            Text(this.statusText.length > 0 ? this.statusText : '正在读取记录…')
              .fontSize(FONT.caption)
              .lineHeight(LINE_HEIGHT.caption)
              .fontColor($r('app.color.text_secondary'))
              .width('100%')
              .textAlign(TextAlign.Center)
          }
          .width('100%')
          .height('100%')
          .justifyContent(FlexAlign.Center)
        } else {
          Scroll() {
            Column({ space: SPACING.lg }) {
              this.BodyBlock()
              Divider()
                .strokeWidth(DIVIDER)
                .color($r('app.color.divider'))
              this.AiBlock()
              Divider()
                .strokeWidth(DIVIDER)
                .color($r('app.color.divider'))
              this.OcrBlock()
              if (this.attachments.length > 0) {
                Divider()
                  .strokeWidth(DIVIDER)
                  .color($r('app.color.divider'))
                this.AttachmentStrip()
              }
              if (this.statusText.length > 0) {
                Text(this.statusText)
                  .fontSize(FONT.caption)
                  .lineHeight(LINE_HEIGHT.caption)
                  .fontColor($r('app.color.danger'))
                  .width('100%')
                  .textAlign(TextAlign.Start)
              }
              this.Actions()
            }
            .width('100%')
            .alignItems(HorizontalAlign.Start)
            .padding({ bottom: SPACING.xl })
          }
          .layoutWeight(1)
          .width('100%')
          .scrollBar(BarState.Off)
          .align(Alignment.TopStart)
        }
      }
      .width('100%')
      .height('100%')

      if (this.previewSha.length > 0) {
        Column() {
          Image(attachmentStore.attachmentUri(this.previewSha))
            .width('100%')
            .height('82%')
            .objectFit(ImageFit.Contain)
          Text('点击任意位置关闭')
            .fontSize(FONT.caption)
            .lineHeight(LINE_HEIGHT.caption)
            .fontColor($r('app.color.text_inverse'))
            .margin({ top: SPACING.md })
        }
        .width('100%')
        .height('100%')
        .justifyContent(FlexAlign.Center)
        .backgroundColor($r('app.color.preview_background'))
        .onClick(() => {
          this.previewSha = '';
        })
      }
    }
    .width('100%')
    .height('100%')
  }
}
