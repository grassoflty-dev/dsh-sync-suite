/**
 * 编辑页：标题 / 正文 / 记录者 / 完成情况 + 手写板入口（仅鸿蒙）+ 附件预览。
 *
 * 契约：BRIEF §3.2、§3.5、`docs/CONTRACT.md` §3.4。逻辑未改：
 * - 标题、记录者用 `TextInput`（系统全局手写输入对 Input 默认生效）；
 * - 正文用 `TextArea`，手写板入口仅在 `getFeatures().handwriting` 为真时显示，
 *   返回后从 `AppStorage['handwriting.result']` 读取识别文本并**立即清除**该键；
 * - 保存 = 追加一条记录：新 id 用 `newRecordId()`；编辑已有记录时保留原 id、写入新 ts；
 * - 原记录的 `ocr_text` / `attachments` / `ocr_time` 一并保留，正文或标题变更后置
 *   `ai_processed:false` 等待重新 AI 整理。
 *
 * 布局：竖屏表单自上而下、底部单一「保存」；横屏左表单 / 右手写与附件预览。
 */
import { promptAction, router } from '@kit.ArkUI';
import { common } from '@kit.AbilityKit';
import { nextTsSameDate, nowIso } from '../common/date';
import { getFeatures } from '../common/features';
import { handwritingPageRoute } from '../common/platformFeatures';
import type { Attachment, ScheduleRecord } from '../model/types';
import { newRecordId, scheduleStore, describeError } from '../services/scheduleStore';
import { settingsStore } from '../services/settingsStore';
import { attachmentStore, parseAttachmentList } from '../services/attachmentStore';
import { EmptyState } from '../components/EmptyState';
import { PageLayout } from '../components/PageLayout';
import { DIVIDER, FONT, LINE_HEIGHT, RADIUS, SPACING, TOUCH_MIN } from '../common/uiTokens';

/** 输入框高度（≥ TOUCH_MIN，留出点击余量）。 */
const INPUT_HEIGHT: number = 44;

/** 正文输入区高度：表单在独立 Scroll 里，固定高度即可（横屏不会再顶出屏幕）。 */
const BODY_HEIGHT: number = 200;

/** 主操作按钮高度。 */
const PRIMARY_HEIGHT: number = 48;

/** 附件缩略图边长。 */
const THUMB: number = 96;

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
  /** 新建记录的手写草稿键（本页会话内只生成一次，退出再进才能恢复同一份草稿）。 */
  private newDraftKey: string = '';
  @State ready: boolean = false;
  @State statusText: string = '';
  /** 断点由 `PageLayout` 计算，本页只做 compact / 非 compact 分支。 */
  @State breakpoint: string = 'compact';

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
    const draftKey: string = this.handwritingDraftKey();
    AppStorage.setOrCreate<string>('handwriting.draftKey', draftKey);
    // ArkTS 不允许未声明类型的对象字面量：与 Index/Detail 一样用 Record<string, string>
    const params: Record<string, string> = { 'draftKey': draftKey };
    router
      .pushUrl({ url: route, params: params })
      .catch((error: Error) => {
        promptAction.showToast({ message: `打开手写板失败：${describeError(error)}` });
      });
  }

  /**
   * 手写板草稿键：编辑已有记录 = recordId；新建 = `new-<时间戳>`。
   *
   * 新建的键**在本页会话内只生成一次**并缓存：否则每次点「手写板」都会换一个新键，
   * 「退出再进」就恢复不到刚才的手迹（用户明确要求退出后能接着改）。
   */
  private handwritingDraftKey(): string {
    if (this.recordId.length > 0) {
      return this.recordId;
    }
    if (this.newDraftKey.length === 0) {
      this.newDraftKey = `new-${Date.now()}`;
    }
    return this.newDraftKey;
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

  /** 手写板入口（仅鸿蒙，`getFeatures().handwriting` 门控）。 */
  @Builder
  WritingEntry() {
    if (this.handwritingAvailable) {
      Text('手写板')
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontColor($r('app.color.brand'))
        .height(TOUCH_MIN)
        .padding({ left: SPACING.md, right: SPACING.md })
        .textAlign(TextAlign.Center)
        .onClick(() => this.openWritingBoard())
    }
  }

  @Builder
  TitleField() {
    Column({ space: SPACING.xs }) {
      this.FieldLabel('标题')
      TextInput({ text: this.title, placeholder: '例如：周三项目周会' })
        .width('100%')
        .height(INPUT_HEIGHT)
        .fontSize(FONT.body)
        .backgroundColor($r('app.color.page_background'))
        .borderRadius(RADIUS.none)
        .padding({ left: 0, right: 0 })
        .onChange((value: string) => {
          this.title = value;
        })
      Divider()
        .strokeWidth(DIVIDER)
        .color($r('app.color.divider'))
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  BodyField() {
    Column({ space: SPACING.xs }) {
      Row({ space: SPACING.sm }) {
        // 这一行不能用 FieldLabel（它 width('100%') 会把右侧手写入口挤出屏幕）
        Text('正文')
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
        Blank()
        this.WritingEntry()
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      TextArea({ text: this.body, placeholder: '记录内容；手写识别结果会追加到这里' })
        .width('100%')
        .height(BODY_HEIGHT)
        .fontSize(FONT.body)
        .backgroundColor($r('app.color.page_background'))
        .borderRadius(RADIUS.none)
        .padding({ left: 0, right: 0 })
        .onChange((value: string) => {
          this.body = value;
        })
      Divider()
        .strokeWidth(DIVIDER)
        .color($r('app.color.divider'))
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  AuthorField() {
    Column({ space: SPACING.xs }) {
      this.FieldLabel('记录者')
      TextInput({ text: this.author, placeholder: '记录者姓名' })
        .width('100%')
        .height(INPUT_HEIGHT)
        .fontSize(FONT.body)
        .backgroundColor($r('app.color.page_background'))
        .borderRadius(RADIUS.none)
        .padding({ left: 0, right: 0 })
        .onChange((value: string) => {
          this.author = value;
        })
      Divider()
        .strokeWidth(DIVIDER)
        .color($r('app.color.divider'))
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  DoneRow() {
    Row({ space: SPACING.sm }) {
      Text('完成情况')
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontColor($r('app.color.text_secondary'))
      Blank()
      Text(this.done ? '已完成' : '未完成')
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontColor($r('app.color.text_primary'))
      Toggle({ type: ToggleType.Switch, isOn: this.done })
        .selectedColor($r('app.color.brand'))
        .onChange((isOn: boolean) => {
          this.done = isOn;
        })
    }
    .width('100%')
    .height(TOUCH_MIN + SPACING.sm)
    .alignItems(VerticalAlign.Center)
  }

  /** 附件缩略图（右侧预览 / 竖屏在表单末尾）。 */
  @Builder
  AttachmentPreview() {
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
      .height(THUMB + 40)
      .width('100%')
      .scrollBar(BarState.Off)

      if (this.ocrText.length > 0) {
        Text('原始识别文本已保存（只读），可在详情页查看。')
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
          .maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
          .textAlign(TextAlign.Start)
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  SaveButton() {
    Button(this.recordId.length > 0 ? '保存修改' : '保存日程')
      .width('100%')
      .height(PRIMARY_HEIGHT)
      .fontSize(FONT.body)
      .backgroundColor($r('app.color.brand'))
      .fontColor($r('app.color.text_inverse'))
      .borderRadius(RADIUS.sm)
      .onClick(() => this.save())
  }

  /** 表单主体（两种断点共用）。 */
  @Builder
  FormBody() {
    Column({ space: SPACING.lg }) {
      this.TitleField()
      this.BodyField()
      this.AuthorField()
      this.DoneRow()

      if (this.contentChanged()) {
        Text('标题或正文变更后需要重新「AI 汇总」：本次保存会重置 AI 处理标记。')
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
          .width('100%')
          .textAlign(TextAlign.Start)
      }

      if (!this.ready) {
        EmptyState({
          title: '正在准备存储…',
          hint: this.statusText.length > 0 ? this.statusText : '首次进入会创建 devices/<设备标识>/ 目录'
        })
      } else if (this.statusText.length > 0) {
        Text(this.statusText)
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.danger'))
          .width('100%')
          .textAlign(TextAlign.Start)
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  /** 紧凑屏：表单 → 附件 → 保存（单列）。 */
  @Builder
  CompactBody() {
    Column({ space: SPACING.md }) {
      Scroll() {
        Column({ space: SPACING.lg }) {
          this.FormBody()
          if (this.attachments.length > 0) {
            Divider()
              .strokeWidth(DIVIDER)
              .color($r('app.color.divider'))
            this.AttachmentPreview()
          }
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start)
        .padding({ bottom: SPACING.xl })
      }
      .layoutWeight(1)
      .width('100%')
      .scrollBar(BarState.Off)
      .align(Alignment.TopStart)

      this.SaveButton()
    }
    .width('100%')
    .height('100%')
  }

  /** 宽屏/横屏：左表单（底部保存）/ 右手写与附件预览。 */
  @Builder
  WideBody() {
    Row({ space: SPACING.xl }) {
      Column({ space: SPACING.md }) {
        Scroll() {
          Column() {
            this.FormBody()
          }
          .width('100%')
          .padding({ bottom: SPACING.xl })
        }
        .layoutWeight(1)
        .width('100%')
        .scrollBar(BarState.Off)
        .align(Alignment.TopStart)
        this.SaveButton()
      }
      .layoutWeight(1)
      .height('100%')

      Divider()
        .vertical(true)
        .strokeWidth(DIVIDER)
        .color($r('app.color.divider'))
        .height('100%')

      Column({ space: SPACING.md }) {
        Row({ space: SPACING.sm }) {
          Text('手写与附件')
            .fontSize(FONT.body)
            .lineHeight(LINE_HEIGHT.body)
            .fontWeight(FontWeight.Medium)
            .fontColor($r('app.color.text_primary'))
            .layoutWeight(1)
            .textAlign(TextAlign.Start)
          this.WritingEntry()
        }
        .width('100%')
        .alignItems(VerticalAlign.Center)

        Divider()
          .strokeWidth(DIVIDER)
          .color($r('app.color.divider'))

        if (this.attachments.length > 0) {
          this.AttachmentPreview()
        } else {
          Text('还没有手迹附件。在鸿蒙上手写并「完成」后，页面会回到这里。')
            .fontSize(FONT.caption)
            .lineHeight(LINE_HEIGHT.caption)
            .fontColor($r('app.color.text_secondary'))
            .width('100%')
            .textAlign(TextAlign.Start)
        }
      }
      .layoutWeight(1)
      .height('100%')
      .alignItems(HorizontalAlign.Start)
    }
    .width('100%')
    .height('100%')
    .alignItems(VerticalAlign.Top)
  }

  build() {
    Stack({ alignContent: Alignment.TopStart }) {
      PageLayout({
        title: this.recordId.length > 0 ? '编辑日程' : '新建日程',
        subtitle: this.recordId.length > 0 ? '修改后会追加一条新记录' : '保存后追加到今天的日程',
        onBack: () => {
          router.back();
        },
        onBreakpointChange: (breakpoint: string) => {
          this.breakpoint = breakpoint;
        }
      }) {
        if (this.breakpoint === 'compact') {
          this.CompactBody()
        } else {
          this.WideBody()
        }
      }
    }
    .width('100%')
    .height('100%')
  }
}
