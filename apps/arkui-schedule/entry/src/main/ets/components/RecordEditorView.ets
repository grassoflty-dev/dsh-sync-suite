/**
 * 日程编辑视图（可嵌入 Edit 页，也可作为首页横屏主从布局的右栏）。
 *
 * 入参是**记录 id**（`''` = 新建）：编辑已有记录时保留原 id / 原日期 / 原 `ocr_text` /
 * 原 `attachments` / 原 `ocr_time`，正文或标题变更后置 `ai_processed:false` 等重新整理。
 *
 * 契约：BRIEF §3.2、§3.5、`docs/CONTRACT.md` §3.4：
 * - 保存 = 追加一条记录（新 id 用 `newRecordId()`；已有记录保留 id、ts 用 `nextTsSameDate()`）；
 * - 手写板入口仅在 `getFeatures().handwriting` 为真时显示，回填走 AppStorage：
 *   容器在页面 `onPageShow` 里把 `refreshTick` 加一，组件在 `@Watch` 里读取并**立即清除**三个键。
 */
import { promptAction, router } from '@kit.ArkUI';
import { common } from '@kit.AbilityKit';
import { nextTsSameDate, nowIso, localDateKey } from '../common/date';import { getFeatures } from '../common/features';
import { handwritingPageRoute } from '../common/platformFeatures';
import type { Attachment, ScheduleRecord } from '../model/types';
import { newRecordId, scheduleStore, describeError } from '../services/scheduleStore';
import { settingsStore } from '../services/settingsStore';
import { attachmentStore, parseAttachmentList } from '../services/attachmentStore';
import { loadingText, toastMsFor } from '../common/copy';
import { DIVIDER, FONT, LINE_HEIGHT, RADIUS, SPACING, TOUCH_MIN } from '../common/uiTokens';
import { StateView } from './StateView';

const INPUT_HEIGHT: number = 44;
const BODY_HEIGHT: number = 200;
const PRIMARY_HEIGHT: number = 48;
const THUMB: number = 88;

/**
 * 编辑草稿的 AppStorage 键（只存内存）。
 *
 * 用途：主从布局在旋转/切回单列时右栏会被卸载，编辑内容不能静默丢失——卸载前写草稿，
 * 下次挂载且 `recordId` 相同时恢复，恢复后立即清键。不是持久化配置，重启即失效。
 */
const DRAFT_KEY: string = 'editor.draft';

/** 草稿结构（显式接口，ArkTS 不接受匿名对象字面量做 JSON.parse 的类型）。 */
interface EditorDraft {
  recordId: string;
  title: string;
  body: string;
  author: string;
  done: boolean;
}

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

@Component
export struct RecordEditorView {
  /** 要编辑的记录 id；空串 = 新建。 */
  @Prop recordId: string = '';
  /** 新建时用于副标题提示的日期（可空）。 */
  @Prop defaultDate: string = '';
  /** 容器在页面 `onPageShow` 时 +1（手写板返回后回填）。 */
  @Prop @Watch('onRefreshTick') refreshTick: number = 0;
  /** 保存成功回调：带上刚追加的记录。 */
  onSaved: (record: ScheduleRecord) => void = () => {};
  /** 取消回调；为 null 时不渲染「取消」。 */
  onCancel: (() => void) | null = null;
  /** 脏状态变化（容器用它做「放弃未保存内容？」提示）。 */
  onDirtyChange: ((dirty: boolean) => void) | null = null;

  @State title: string = '';
  @State body: string = '';
  @State author: string = '';
  @State done: boolean = false;
  @State ocrText: string = '';
  @State attachments: Attachment[] = [];
  @State handwritingAvailable: boolean = false;
  @State ready: boolean = false;
  @State statusText: string = '';
  @State saving: boolean = false;

  private originalTitle: string = '';
  private originalBody: string = '';
  private originalTs: string = '';
  private originalOcrTime: string = '';
  private originalAiStructured: string = '';
  private originalAiProcessed: boolean = false;
  private loaded: boolean = false;
  private lastDirty: boolean = false;

  aboutToAppear(): void {
    this.handwritingAvailable = getFeatures().handwriting;
    this.bootstrap();
  }

  /** 卸载时（旋转到单列 / 切走）把未保存内容写进草稿，避免静默丢失。 */
  aboutToDisappear(): void {
    if (!this.isDirty()) {
      AppStorage.setOrCreate<string>(DRAFT_KEY, '');
      return;
    }
    const draft: EditorDraft = {
      recordId: this.recordId,
      title: this.title,
      body: this.body,
      author: this.author,
      done: this.done
    };
    AppStorage.setOrCreate<string>(DRAFT_KEY, JSON.stringify(draft));
  }

  /** 挂载时恢复同一条记录的草稿（读后立即清键）。 */
  private restoreDraft(): boolean {
    const raw = AppStorage.get<string>(DRAFT_KEY);
    if (raw === undefined || raw.length === 0) {
      return false;
    }
    AppStorage.setOrCreate<string>(DRAFT_KEY, '');
    try {
      const draft = JSON.parse(raw) as EditorDraft;
      if (draft === null || draft.recordId !== this.recordId) {
        return false;
      }
      this.title = draft.title !== undefined ? draft.title : this.title;
      this.body = draft.body !== undefined ? draft.body : this.body;
      if (draft.author !== undefined && draft.author.length > 0) {
        this.author = draft.author;
      }
      this.done = draft.done === true;
      return true;
    } catch (error) {
      return false;
    }
  }

  /** 页面从手写板返回时触发回填。 */
  onRefreshTick(): void {
    this.applyPendingInkResult();
  }

  /**
   * 三态里的「重试」：清掉错误文案、退回未就绪，再重跑一次「确保存储就绪 → 读记录」。
   *
   * 失败的两种来源（`ensureReady` 失败 / `findByIdAny` 失败）都在 `bootstrap()` 里，
   * 所以重试必须整条链路重来，只 `loadRecord()` 会在存储未就绪时立刻再失败一次。
   */
  private retryLoad(): void {
    this.statusText = '';
    this.ready = false;
    this.bootstrap();
  }

  /** 错误标题：取 `statusText` 冒号前那半句，取不到给通用标题。 */
  private statusTitle(): string {
    const cut: number = this.statusText.indexOf('：');
    if (cut > 0) {
      return this.statusText.slice(0, cut);
    }
    return '读取失败';
  }

  private async bootstrap(): Promise<void> {
    const context = getContext(this) as common.UIAbilityContext;
    try {
      await scheduleStore.ensureReady(context);
      let defaultAuthor = '我';
      try {
        const settings = await settingsStore.load(context);
        defaultAuthor = settings.author.trim().length > 0 ? settings.author : '我';
      } catch (error) {
        // 读设置失败不阻断编辑：回落「我」
      }
      if (this.author.trim().length === 0) {
        this.author = defaultAuthor;
      }
      this.ready = true;
      if (this.recordId.length > 0) {
        this.loadRecord();
      } else {
        this.loaded = true;
      }
      // 有草稿（同一条记录）就优先用草稿，覆盖刚读到的记录字段
      this.restoreDraft();
    } catch (error) {
      this.ready = false;
      this.statusText = `初始化失败：${describeError(error)}`;
    }
    this.notifyDirty();
  }

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

  /** 手写板回填：正文、原始识别文本、截图附件三路数据（读后立即清空键）。 */
  private applyPendingInkResult(): void {
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
    this.notifyDirty();
  }

  private contentChanged(): boolean {
    if (!this.loaded) {
      return this.title.trim().length > 0 || this.body.length > 0;
    }
    return this.title.trim() !== this.originalTitle.trim() || this.body !== this.originalBody;
  }

  /** 脏判定：新建时只要有内容就算脏；编辑时看标题/正文是否变过。 */
  private isDirty(): boolean {
    if (this.recordId.length === 0) {
      return this.title.trim().length > 0 || this.body.length > 0 || this.attachments.length > 0;
    }
    return this.contentChanged();
  }

  private notifyDirty(): void {
    const dirty: boolean = this.isDirty();
    if (dirty === this.lastDirty) {
      return;
    }
    this.lastDirty = dirty;
    const handler: ((dirty: boolean) => void) | null = this.onDirtyChange;
    if (handler !== null) {
      handler(dirty);
    }
  }

  private openWritingBoard(): void {
    const route = handwritingPageRoute();
    if (route.length === 0) {
      promptAction.showToast({ message: '当前平台不支持手写板' });
      return;
    }
    // 记录日期透传给手写板：决定附件打哪一天的 zip（`attachments/<YYYY-MM-DD>.zip`）
    const dateParam: string = this.defaultDate.length === 10 ? this.defaultDate : localDateKey(new Date());
    const params: Record<string, string> = { 'date': dateParam };
    router.pushUrl({ url: route, params: params }).catch((error: Error) => {
      promptAction.showToast({ message: `打开手写板失败：${describeError(error)}` });
    });
  }

  private save(): void {
    if (this.saving) {
      return;
    }
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
    this.saving = true;
    try {
      scheduleStore.appendRecord(record);
    } catch (error) {
      this.saving = false;
      promptAction.showToast({ message: `保存失败：${describeError(error)}`, duration: toastMsFor(true) });
      return;
    }
    this.saving = false;
    this.originalTitle = title;
    this.originalBody = this.body;
    this.originalTs = record.ts;
    this.lastDirty = false;
    const dirtyHandler: ((dirty: boolean) => void) | null = this.onDirtyChange;
    if (dirtyHandler !== null) {
      dirtyHandler(false);
    }
    promptAction.showToast({ message: changed ? '已保存（待 AI 整理）' : '已保存' });
    this.onSaved(record);
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
      .height(THUMB + 32)
      .width('100%')
      .scrollBar(BarState.Off)
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  build() {
    Column() {
      Scroll() {
        Column({ space: SPACING.lg }) {
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
                this.notifyDirty();
              })
            Divider()
              .strokeWidth(DIVIDER)
              .color($r('app.color.divider'))
          }
          .width('100%')
          .alignItems(HorizontalAlign.Start)

          Column({ space: SPACING.xs }) {
            Row({ space: SPACING.sm }) {
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
                this.notifyDirty();
              })
            Divider()
              .strokeWidth(DIVIDER)
              .color($r('app.color.divider'))
          }
          .width('100%')
          .alignItems(HorizontalAlign.Start)

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

          if (this.contentChanged()) {
            Text('标题或正文变更后需要重新「AI 汇总」：本次保存会重置 AI 处理标记。')
              .fontSize(FONT.caption)
              .lineHeight(LINE_HEIGHT.caption)
              .fontColor($r('app.color.text_secondary'))
              .width('100%')
              .textAlign(TextAlign.Start)
          }

          if (this.attachments.length > 0) {
            this.AttachmentPreview()
          }

          if (this.statusText.length > 0) {
            // 初始化失败 / 记录不存在：行内错误条（原因 + 下一步），给「重试」出口
            StateView({
              kind: 'error',
              title: this.statusTitle(),
              detail: this.statusText,
              retryLabel: '重试',
              compact: true,
              onRetry: () => {
                this.retryLoad();
              }
            })
          } else if (!this.ready) {
            // 正在等存储就绪：行内加载态（与错误态共用同一套三态视觉）
            StateView({ kind: 'loading', title: loadingText('存储'), compact: true })
          }
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start)
        .padding({ bottom: SPACING.lg })
      }
      .layoutWeight(1)
      .width('100%')
      .scrollBar(BarState.Off)
      .align(Alignment.TopStart)

      Row({ space: SPACING.md }) {
        if (this.onCancel !== null) {
          Button('取消')
            .height(PRIMARY_HEIGHT)
            .fontSize(FONT.body)
            .backgroundColor($r('app.color.brand_soft'))
            .fontColor($r('app.color.text_secondary'))
            .borderRadius(RADIUS.sm)
            .onClick(() => {
              const handler: (() => void) | null = this.onCancel;
              if (handler !== null) {
                handler();
              }
            })
        }
        Button(this.recordId.length > 0 ? '保存修改' : '保存日程')
          .layoutWeight(1)
          .height(PRIMARY_HEIGHT)
          .fontSize(FONT.body)
          .backgroundColor($r('app.color.brand'))
          .fontColor($r('app.color.text_inverse'))
          .borderRadius(RADIUS.sm)
          .enabled(!this.saving)
          .onClick(() => this.save())
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)
    }
    .width('100%')
    .height('100%')
    .alignItems(HorizontalAlign.Start)
  }
}
