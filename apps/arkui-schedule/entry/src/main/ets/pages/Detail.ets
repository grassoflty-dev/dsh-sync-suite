/**
 * 详情页：AI 结构化（可编辑保存）+ 原始 OCR 只读 + 手迹截图缩略/全屏 + 附件哈希列表。
 *
 * 契约：BRIEF §3.2（`ocr_text` 保留原始识别结果不被覆盖）、§3.5、`docs/CONTRACT.md` §3.4。
 *
 * 说明：
 * - 截图预览用沙箱文件 URI 交给 `Image()`。共享层禁止引用 `@kit.ImageKit` / PixelMap
 *   （validate 规则 4），因此这里不解码像素；`attachmentStore.readAttachment()` 仍提供
 *   `ArrayBuffer` 供后续校验使用。
 * - 保存 AI 文本时**不改变记录日期**：ts 取「原日期 + 当前时钟」，保证记录留在原
 *   `YYYY-MM-DD.jsonl`，同时 ts 严格变大让 `foldById` 稳定取新值。
 */
import { promptAction, router } from '@kit.ArkUI';
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
import { EmptyState } from '../components/EmptyState';

@Entry
@Component
struct Detail {
  @State recordId: string = '';
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
  @State ready: boolean = false;
  @State aiBusy: boolean = false;
  @State loaded: boolean = false;
  /** 折叠后的原始记录（保存时以此为底板）。 */
  private raw: ScheduleRecord | null = null;

  aboutToAppear(): void {
    this.readRouteParams();
    this.bootstrap();
  }

  private readRouteParams(): void {
    try {
      const params = router.getParams() as Record<string, string>;
      if (params === undefined || params === null) {
        return;
      }
      const id = params['id'];
      if (id !== undefined && id.length > 0) {
        this.recordId = id;
      }
    } catch (error) {
      this.statusText = `读取页面参数失败：${describeError(error)}`;
    }
  }

  private async bootstrap(): Promise<void> {
    const context = getContext(this) as common.UIAbilityContext;
    try {
      await scheduleStore.ensureReady(context);
      this.ready = true;
      this.load();
    } catch (error) {
      this.ready = false;
      this.statusText = `初始化失败：${describeError(error)}`;
    }
  }

  private load(): void {
    if (this.recordId.length === 0) {
      this.statusText = '缺少记录 id：请从列表进入详情页';
      return;
    }
    let record: ScheduleRecord | null = null;
    try {
      record = scheduleStore.findByIdAny(this.recordId);
    } catch (error) {
      this.statusText = `读取记录失败：${describeError(error)}`;
      return;
    }
    if (record === null) {
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

  /** 仅有当前记录时单独跑一次 AI 结构化。 */
  private async runAiForRecord(): Promise<void> {
    const base = this.raw;
    if (base === null) {
      promptAction.showToast({ message: '记录尚未载入，无法整理' });
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
      promptAction.showToast({ message: '请先在设置页填写 DeepSeek API Key', duration: 4000 });
      return;
    }
    // buildAiPayload 只收 ai_processed:false 的记录；这里构造一份副本作为候选，不写回存储。
    const candidate: ScheduleRecord = cloneRecord(base);
    candidate.ai_processed = false;
    const payload = buildAiPayload(recordDateKey(candidate.ts), [candidate]);
    if (payload.records.length === 0) {
      promptAction.showToast({ message: '这条记录没有可整理的内容（正文与识别文本都为空）' });
      return;
    }
    this.aiBusy = true;
    try {
      const text = await summarize(payload, aiKey, nowIso(), deviceTimeZone());
      this.aiText = text;
      promptAction.showToast({ message: 'AI 结果已填入，点击「保存」写入记录', duration: 4000 });
    } catch (error) {
      promptAction.showToast({ message: describeError(error), duration: 5000 });
    } finally {
      this.aiBusy = false;
    }
  }

  private openEdit(): void {
    if (this.recordId.length === 0) {
      return;
    }
    const params: Record<string, string> = { 'id': this.recordId };
    router.pushUrl({ url: 'pages/Edit', params: params }).catch((error: Error) => {
      promptAction.showToast({ message: `打开编辑页失败：${describeError(error)}` });
    });
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

  @Builder
  AttachmentStrip() {
    Column({ space: 8 }) {
      Text(`手迹附件（${this.attachments.length} 页，点击查看大图）`)
        .fontSize(13)
        .fontColor($r('app.color.text_secondary'))
        .width('100%')
        .textAlign(TextAlign.Start)
      List({ space: 8 }) {
        ForEach(
          this.attachments,
          (item: Attachment) => {
            ListItem() {
              Column({ space: 4 }) {
                Image(attachmentStore.attachmentUri(item.sha256))
                  .width(96)
                  .height(96)
                  .borderRadius(8)
                  .objectFit(ImageFit.Cover)
                  .backgroundColor('#EEF1F4')
                  .onClick(() => {
                    this.previewSha = item.sha256;
                  })
                Text(`第 ${item.pageIndex + 1} 页`)
                  .fontSize(11)
                  .fontColor($r('app.color.text_secondary'))
              }
            }
          },
          (item: Attachment) => `${item.sha256}|${item.pageIndex}`
        )
      }
      .listDirection(Axis.Horizontal)
      .height(130)
      .width('100%')

      Column({ space: 2 }) {
        ForEach(
          this.attachments,
          (item: Attachment) => {
            Text(`#${item.pageIndex}  ${item.sha256}  ${item.name}`)
              .fontSize(10)
              .fontColor($r('app.color.text_secondary'))
              .width('100%')
              .textAlign(TextAlign.Start)
              .copyOption(CopyOptions.LocalDevice)
          },
          (item: Attachment) => `sha-${item.sha256}|${item.pageIndex}`
        )
      }
      .width('100%')
    }
    .width('100%')
    .padding(12)
    .backgroundColor(Color.White)
    .borderRadius(12)
  }

  build() {
    Stack({ alignContent: Alignment.Center }) {
      Column() {
        Row({ space: 8 }) {
          Text('‹')
            .fontSize(26)
            .fontColor($r('app.color.text_primary'))
            .padding({ left: 4, right: 4 })
            .onClick(() => {
              router.back();
            })
          Text('日程详情')
            .fontSize(18)
            .fontWeight(FontWeight.Bold)
            .fontColor($r('app.color.text_primary'))
            .layoutWeight(1)
          Button('编辑')
            .height(34)
            .backgroundColor('#E8F1FF')
            .fontColor($r('app.color.brand'))
            .onClick(() => this.openEdit())
        }
        .width('100%')
        .padding({ left: 12, right: 12, top: 12, bottom: 8 })

        Scroll() {
          Column({ space: 12 }) {
            if (!this.ready || !this.loaded) {
              EmptyState({
                title: this.ready ? '没有找到这条记录' : '正在准备存储…',
                hint: this.statusText.length > 0 ? this.statusText : '首次进入会创建 devices/<设备标识>/ 目录',
                icon: '🔍'
              })
            } else {
              Column({ space: 6 }) {
                Text(this.title.length > 0 ? this.title : '(未命名日程)')
                  .fontSize(20)
                  .fontWeight(FontWeight.Bold)
                  .fontColor($r('app.color.text_primary'))
                  .width('100%')
                  .textAlign(TextAlign.Start)
                Text(this.metaLine())
                  .fontSize(12)
                  .fontColor($r('app.color.text_secondary'))
                  .width('100%')
                  .textAlign(TextAlign.Start)
              }
              .width('100%')
              .padding(12)
              .backgroundColor(Color.White)
              .borderRadius(12)

              Column({ space: 6 }) {
                Text('正文')
                  .fontSize(13)
                  .fontColor($r('app.color.text_secondary'))
                  .width('100%')
                  .textAlign(TextAlign.Start)
                Text(this.body.length > 0 ? this.body : '（空）')
                  .fontSize(14)
                  .fontColor($r('app.color.text_primary'))
                  .width('100%')
                  .textAlign(TextAlign.Start)
                  .copyOption(CopyOptions.LocalDevice)
              }
              .width('100%')
              .padding(12)
              .backgroundColor(Color.White)
              .borderRadius(12)

              Column({ space: 8 }) {
                Row() {
                  Text('AI 结构化（可编辑）')
                    .fontSize(13)
                    .fontColor($r('app.color.text_secondary'))
                  Blank()
                  if (this.aiText.trim().length > 0) {
                    Button('保存')
                      .height(30)
                      .backgroundColor($r('app.color.brand'))
                      .fontColor(Color.White)
                      .onClick(() => this.saveAiText())
                  }
                }
                .width('100%')

                if (this.aiText.trim().length === 0) {
                  Button(this.aiBusy ? '正在整理…' : 'AI 结构化')
                    .width('100%')
                    .height(40)
                    .backgroundColor('#E8F1FF')
                    .fontColor($r('app.color.brand'))
                    .enabled(!this.aiBusy)
                    .onClick(() => {
                      this.runAiForRecord();
                    })
                  Text('尚未生成 AI 结构化内容；生成后可在上方编辑并保存。')
                    .fontSize(11)
                    .fontColor($r('app.color.text_secondary'))
                    .width('100%')
                    .textAlign(TextAlign.Start)
                } else {
                  TextArea({ text: this.aiText, placeholder: 'AI 结构化结果' })
                    .width('100%')
                    .height(180)
                    .backgroundColor('#F7F9FB')
                    .borderRadius(10)
                    .onChange((value: string) => {
                      this.aiText = value;
                    })
                }
              }
              .width('100%')
              .padding(12)
              .backgroundColor(Color.White)
              .borderRadius(12)

              Column({ space: 6 }) {
                Text('原始识别文本 ocr_text（只读，永不覆盖）')
                  .fontSize(13)
                  .fontColor($r('app.color.text_secondary'))
                  .width('100%')
                  .textAlign(TextAlign.Start)
                Text(this.ocrText.length > 0 ? this.ocrText : '（这条记录没有手写识别原文）')
                  .fontSize(13)
                  .fontColor($r('app.color.text_primary'))
                  .width('100%')
                  .textAlign(TextAlign.Start)
                  .copyOption(CopyOptions.LocalDevice)
              }
              .width('100%')
              .padding(12)
              .backgroundColor(Color.White)
              .borderRadius(12)

              if (this.attachments.length > 0) {
                this.AttachmentStrip()
              }

              if (this.statusText.length > 0) {
                Text(this.statusText)
                  .fontSize(12)
                  .fontColor('#D94838')
                  .width('100%')
              }
            }
          }
          .width('100%')
          .padding({ left: 12, right: 12, bottom: 24 })
        }
        .layoutWeight(1)
        .width('100%')
        .align(Alignment.TopStart)
      }
      .width('100%')
      .height('100%')
      .backgroundColor($r('app.color.page_background'))

      if (this.previewSha.length > 0) {
        Column() {
          Image(attachmentStore.attachmentUri(this.previewSha))
            .width('100%')
            .height('82%')
            .objectFit(ImageFit.Contain)
          Text('点击任意位置关闭')
            .fontSize(12)
            .fontColor('#CCFFFFFF')
            .margin({ top: 12 })
        }
        .width('100%')
        .height('100%')
        .justifyContent(FlexAlign.Center)
        .backgroundColor('#000000')
        .onClick(() => {
          this.previewSha = '';
        })
      }
    }
    .width('100%')
    .height('100%')
  }
}
