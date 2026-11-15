/**
 * 编辑页：四字段（标题 / 正文 / 记录者 / 完成情况）。
 *
 * 契约：BRIEF §3.2、§3.5、`docs/CONTRACT.md` §3.4。
 * - 标题、记录者用 `TextInput`（系统全局手写输入对 Input 默认生效）；
 * - 正文用 `TextArea`，手写板入口仅在 `getFeatures().handwriting` 为真时显示，
 *   返回后从 `AppStorage['handwriting.result']` 读取识别文本并**立即清除**该键；
 * - 保存 = 追加一条记录：新 id 用 `newRecordId()`；编辑已有记录时保留原 id、写入新 ts；
 * - 原记录的 `ocr_text` / `attachments` / `ocr_time` 一并保留，正文或标题变更后
 *   置 `ai_processed:false` 等待重新 AI 整理（旧 `ai_structured` 不再展示，避免误导）。
 */
import { promptAction, router } from '@kit.ArkUI';
import { common } from '@kit.AbilityKit';
import { nextTsSameDate, nowIso } from '../common/date';
import { getFeatures } from '../common/features';
import { handwritingPageRoute } from '../common/platformFeatures';
import type { Attachment, ScheduleRecord } from '../model/types';
import { newRecordId, scheduleStore, describeError } from '../services/scheduleStore';
import { settingsStore } from '../services/settingsStore';
import { parseAttachmentList } from '../services/attachmentStore';
import { EmptyState } from '../components/EmptyState';

/** 按 sha256 合并两批附件（去重、按 pageIndex 升序）。 */
function mergeAttachments(base: Attachment[], incoming: Attachment[]): Attachment[] {
  const merged: Attachment[] = [];
  for (const item of base) {
    merged.push(item);
  }
  for (const item of incoming) {
    let exists = false;
    for (const kept of merged) {
      if (kept.sha256 === item.sha256 && kept.pageIndex === item.pageIndex) {
        exists = true;
        break;
      }
    }
    if (!exists) {
      merged.push(item);
    }
  }
  merged.sort((left: Attachment, right: Attachment) => left.pageIndex - right.pageIndex);
  return merged;
}

@Entry
@Component
struct Edit {
  @State recordId: string = '';
  @State title: string = '';
  @State body: string = '';
  @State author: string = '';
  @State done: boolean = false;
  @State ocrText: string = '';
  @State attachments: Attachment[] = [];
  @State handwritingAvailable: boolean = false;
  @State ready: boolean = false;
  @State statusText: string = '';

  // 原记录快照（保存时决定是否保留 AI 结果 / 识别时间）
  private originalTitle: string = '';
  private originalBody: string = '';
  private originalTs: string = '';
  private originalOcrTime: string = '';
  private originalAiStructured: string = '';
  private originalAiProcessed: boolean = false;
  private loaded: boolean = false;

  aboutToAppear(): void {
    this.handwritingAvailable = getFeatures().handwriting;
    this.readRouteParams();
    this.bootstrap();
  }

  /** 从手写板返回：读取并清除 AppStorage 里的识别结果。 */
  onPageShow(): void {
    this.applyWritingResult();
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
      const settings = await settingsStore.load(context);
      if (this.author.trim().length === 0) {
        this.author = settings.author.trim().length > 0 ? settings.author : '我';
      }
      this.ready = true;
      if (this.recordId.length > 0) {
        this.loadRecord();
      }
    } catch (error) {
      this.ready = false;
      this.statusText = `初始化失败：${describeError(error)}`;
    }
  }

  /** 载入待编辑记录（保留原字段，供保存时决定沿用还是重置）。 */
  private loadRecord(): void {
    let record: ScheduleRecord | null = null;
    try {
      record = scheduleStore.findByIdAny(this.recordId);
    } catch (error) {
      this.statusText = `读取记录失败：${describeError(error)}`;
      return;
    }
    if (record === null) {
      this.statusText = '记录不存在：可能已被其他设备改写，请返回列表重试';
      return;
    }
    this.title = record.title;
    this.body = record.body;
    this.author = record.author.length > 0 ? record.author : this.author;
    this.done = record.done;
    this.ocrText = record.ocr_text === undefined ? '' : record.ocr_text;
    this.attachments = record.attachments === undefined ? [] : record.attachments;
    this.originalTitle = record.title;
    this.originalBody = record.body;
    this.originalTs = record.ts;
    this.originalOcrTime = record.ocr_time === undefined ? '' : record.ocr_time;
    this.originalAiStructured = record.ai_structured === undefined ? '' : record.ai_structured;
    this.originalAiProcessed = record.ai_processed;
    this.loaded = true;
  }

  /** 手写板回填：正文、原始识别文本、截图附件三路数据。 */
  private applyWritingResult(): void {
    const text = AppStorage.get<string>('handwriting.result');
    if (text !== undefined && text.length > 0) {
      this.body = this.body.length > 0 ? `${this.body}\n${text}` : text;
      AppStorage.setOrCreate<string>('handwriting.result', '');
    }
    const ocrText = AppStorage.get<string>('handwriting.ocrText');
    if (ocrText !== undefined && ocrText.length > 0) {
      this.ocrText = ocrText;
      AppStorage.setOrCreate<string>('handwriting.ocrText', '');
    }
    const attachmentsJson = AppStorage.get<string>('handwriting.attachments');
    if (attachmentsJson !== undefined && attachmentsJson.length > 0) {
      const incoming = parseAttachmentList(attachmentsJson);
      if (incoming.length > 0) {
        this.attachments = mergeAttachments(this.attachments, incoming);
      }
      AppStorage.setOrCreate<string>('handwriting.attachments', '');
    }
  }

  private contentChanged(): boolean {
    if (!this.loaded) {
      return true;
    }
    return this.title.trim() !== this.originalTitle.trim() || this.body !== this.originalBody;
  }

  private openWritingBoard(): void {
    const route = handwritingPageRoute();
    if (route.length === 0) {
      promptAction.showToast({ message: '当前平台不支持手写板' });
      return;
    }
    router.pushUrl({ url: route }).catch((error: Error) => {
      promptAction.showToast({ message: `打开手写板失败：${describeError(error)}` });
    });
  }

  private save(): void {
    const title = this.title.trim();
    if (title.length === 0) {
      promptAction.showToast({ message: '请先填写标题' });
      return;
    }
    if (!scheduleStore.isReady()) {
      promptAction.showToast({ message: '存储尚未就绪，请稍后重试' });
      return;
    }
    const changed = this.contentChanged();
    const record: ScheduleRecord = {
      id: this.recordId.length > 0 ? this.recordId : newRecordId(),
      // 编辑旧记录时保留原日期（不迁到当天），时刻保证严格大于原 ts
      ts: this.recordId.length > 0 ? nextTsSameDate(this.originalTs) : nowIso(),
      title: title,
      body: this.body,
      author: this.author.trim().length > 0 ? this.author.trim() : '我',
      done: this.done,
      ai_processed: changed ? false : this.originalAiProcessed
    };
    if (this.ocrText.length > 0) {
      record.ocr_text = this.ocrText;
    }
    if (this.attachments.length > 0) {
      record.attachments = this.attachments.slice();
    }
    if (!changed && this.originalAiStructured.length > 0) {
      record.ai_structured = this.originalAiStructured;
    }
    const ocrTime =
      this.originalOcrTime.length > 0 ? this.originalOcrTime : (this.ocrText.length > 0 ? nowIso() : '');
    if (ocrTime.length > 0) {
      record.ocr_time = ocrTime;
    }
    try {
      scheduleStore.appendRecord(record);
    } catch (error) {
      promptAction.showToast({ message: `保存失败：${describeError(error)}`, duration: 4000 });
      return;
    }
    promptAction.showToast({ message: changed ? '已保存（待 AI 整理）' : '已保存' });
    router.back();
  }

  build() {
    Column() {
      Row({ space: 8 }) {
        Text('‹')
          .fontSize(26)
          .fontColor($r('app.color.text_primary'))
          .padding({ left: 4, right: 4 })
          .onClick(() => {
            router.back();
          })
        Text(this.recordId.length > 0 ? '编辑日程' : '新建日程')
          .fontSize(18)
          .fontWeight(FontWeight.Bold)
          .fontColor($r('app.color.text_primary'))
          .layoutWeight(1)
        Button('保存')
          .height(36)
          .backgroundColor($r('app.color.brand'))
          .fontColor(Color.White)
          .onClick(() => this.save())
      }
      .width('100%')
      .padding({ left: 12, right: 12, top: 12, bottom: 8 })

      Scroll() {
        Column({ space: 10 }) {
          Text('标题')
            .fontSize(13)
            .fontColor($r('app.color.text_secondary'))
            .width('100%')
            .textAlign(TextAlign.Start)
          TextInput({ text: this.title, placeholder: '例如：周三项目周会' })
            .width('100%')
            .height(44)
            .backgroundColor(Color.White)
            .borderRadius(10)
            .onChange((value: string) => {
              this.title = value;
            })

          Row() {
            Text('正文')
              .fontSize(13)
              .fontColor($r('app.color.text_secondary'))
            Blank()
            if (this.handwritingAvailable) {
              Text('✍️ 手写板')
                .fontSize(13)
                .fontColor($r('app.color.brand'))
                .padding({ left: 8, right: 8, top: 4, bottom: 4 })
                .backgroundColor('#E8F1FF')
                .borderRadius(8)
                .onClick(() => this.openWritingBoard())
            }
          }
          .width('100%')

          TextArea({ text: this.body, placeholder: '记录内容；手写识别结果会追加到这里' })
            .width('100%')
            .height(220)
            .backgroundColor(Color.White)
            .borderRadius(10)
            .onChange((value: string) => {
              this.body = value;
            })

          if (this.attachments.length > 0) {
            Row({ space: 6 }) {
              Text(`📎 已附加 ${this.attachments.length} 页手迹`)
                .fontSize(12)
                .fontColor($r('app.color.brand'))
              if (this.ocrText.length > 0) {
                Text('（原始识别文本只读保存，可在详情页查看）')
                  .fontSize(11)
                  .fontColor($r('app.color.text_secondary'))
                  .layoutWeight(1)
              }
            }
            .width('100%')
          }

          Text('记录者')
            .fontSize(13)
            .fontColor($r('app.color.text_secondary'))
            .width('100%')
            .textAlign(TextAlign.Start)
          TextInput({ text: this.author, placeholder: '记录者姓名' })
            .width('100%')
            .height(44)
            .backgroundColor(Color.White)
            .borderRadius(10)
            .onChange((value: string) => {
              this.author = value;
            })

          Row() {
            Text('完成情况')
              .fontSize(13)
              .fontColor($r('app.color.text_secondary'))
            Blank()
            Text(this.done ? '已完成' : '未完成')
              .fontSize(13)
              .fontColor($r('app.color.text_primary'))
              .margin({ right: 8 })
            Toggle({ type: ToggleType.Switch, isOn: this.done })
              .selectedColor($r('app.color.brand'))
              .onChange((isOn: boolean) => {
                this.done = isOn;
              })
          }
          .width('100%')
          .height(48)
          .padding({ left: 8, right: 8 })
          .backgroundColor(Color.White)
          .borderRadius(10)

          if (this.contentChanged()) {
            Text('标题或正文变更后需要重新执行「AI 汇总」，因此本次保存会重置 AI 处理标记。')
              .fontSize(11)
              .fontColor($r('app.color.text_secondary'))
              .width('100%')
              .textAlign(TextAlign.Start)
          }

          if (!this.ready) {
            EmptyState({
              title: '正在准备存储…',
              hint: this.statusText.length > 0 ? this.statusText : '首次进入会创建 devices/<设备标识>/ 目录',
              icon: '⏳'
            })
          } else if (this.statusText.length > 0) {
            Text(this.statusText)
              .fontSize(12)
              .fontColor('#D94838')
              .width('100%')
          }
        }
        .width('100%')
        .padding({ left: 12, right: 12, bottom: 24 })
      }
      .layoutWeight(1)
      .width('100%')
      .align(Alignment.TopStart)

      Button(this.recordId.length > 0 ? '保存修改' : '保存日程')
        .width('92%')
        .height(46)
        .margin({ top: 8, bottom: 12 })
        .backgroundColor($r('app.color.brand'))
        .fontColor(Color.White)
        .onClick(() => this.save())
    }
    .width('100%')
    .height('100%')
    .backgroundColor($r('app.color.page_background'))
  }
}
