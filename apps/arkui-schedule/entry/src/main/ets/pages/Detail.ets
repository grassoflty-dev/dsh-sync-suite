/**
 * 详情页：正文 + AI 结构化（可编辑保存）+ 原始 OCR 只读 + 手迹截图缩略/全屏。
 *
 * 契约：BRIEF §3.2（`ocr_text` 保留原始识别结果不被覆盖）、§3.5、`docs/CONTRACT.md` §3.4。
 *
 * 说明：
 * - 截图预览用沙箱文件 URI 交给 `Image()`。共享层禁止引用 `@kit.ImageKit` / PixelMap
 *   （validate 规则 4），因此这里不解码像素。
 * - 保存 AI 文本时**不改变记录日期**：ts 取「原日期 + 当前时钟」，保证记录留在原
 *   `YYYY-MM-DD.jsonl`，同时 ts 严格变大让 `foldById` 稳定取新值。
 * - 布局：竖屏正文+附件自上而下；横屏左正文/AI、右附件与元信息。附件哈希等排障信息
 *   收进「更多」，不再常驻。
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
import { PageLayout } from '../components/PageLayout';
import { DIVIDER, FONT, LINE_HEIGHT, RADIUS, SPACING, TOUCH_MIN } from '../common/uiTokens';

/** 主操作按钮高度。 */
const PRIMARY_HEIGHT: number = 48;

/** 附件缩略图边长。 */
const THUMB: number = 96;

/** AI 文本编辑框高度。 */
const AI_TEXT_HEIGHT: number = 160;

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
  /** 断点由 `PageLayout` 计算，本页只做 compact / 非 compact 分支。 */
  @State breakpoint: string = 'compact';
  /** 「更多」弹层：`''` | `more` | `files`。 */
  @State panel: string = '';
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
      promptAction.showToast({ message: '请先在设置页填写 AI Key', duration: 4000 });
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
      promptAction.showToast({ message: 'AI 结果已填入，点「保存」写入记录', duration: 4000 });
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

  /** 正文块（含记录标题）。 */
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

  /** AI 结构化块：可编辑 + 条件出现的「保存」（次要动作，不做主按钮）。 */
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
        Text(this.aiBusy ? '正在整理…' : '尚未生成。可从右上「更多」运行 AI 整理，生成后可编辑并保存。')
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

  /** 原始识别文本（只读，永不覆盖）。 */
  @Builder
  OcrBlock() {
    Column({ space: SPACING.sm }) {
      Text('原始识别文本（只读）')
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontColor($r('app.color.text_secondary'))
        .width('100%')
        .textAlign(TextAlign.Start)
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

  /** 手迹附件缩略图（点击全屏）。 */
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
      .height(THUMB + 40)
      .width('100%')
      .scrollBar(BarState.Off)
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  EditButton() {
    Button('编辑')
      .width('100%')
      .height(PRIMARY_HEIGHT)
      .fontSize(FONT.body)
      .backgroundColor($r('app.color.brand'))
      .fontColor($r('app.color.text_inverse'))
      .borderRadius(RADIUS.sm)
      .onClick(() => this.openEdit())
  }

  /** 紧凑屏：正文 → AI → 原始识别 → 附件 → 编辑。 */
  @Builder
  CompactBody() {
    Column({ space: SPACING.md }) {
      Scroll() {
        Column({ space: SPACING.lg }) {
          if (!this.ready || !this.loaded) {
            EmptyState({
              title: this.ready ? '没有找到这条记录' : '正在准备存储…',
              hint: this.statusText.length > 0 ? this.statusText : '首次进入会创建 devices/<设备标识>/ 目录'
            })
          } else {
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

      if (this.loaded) {
        this.EditButton()
      }
    }
    .width('100%')
    .height('100%')
  }

  /** 宽屏/横屏：左正文 + AI + 原始识别；右附件 + 元信息；左下编辑。 */
  @Builder
  WideBody() {
    Row({ space: SPACING.xl }) {
      Column({ space: SPACING.md }) {
        Scroll() {
          Column({ space: SPACING.lg }) {
            if (!this.ready || !this.loaded) {
              EmptyState({
                title: this.ready ? '没有找到这条记录' : '正在准备存储…',
                hint: this.statusText.length > 0 ? this.statusText : '首次进入会创建 devices/<设备标识>/ 目录'
              })
            } else {
              this.BodyBlock()
              Divider()
                .strokeWidth(DIVIDER)
                .color($r('app.color.divider'))
              this.AiBlock()
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
        if (this.loaded) {
          this.EditButton()
        }
      }
      .layoutWeight(1)
      .height('100%')

      Divider()
        .vertical(true)
        .strokeWidth(DIVIDER)
        .color($r('app.color.divider'))
        .height('100%')

      Column({ space: SPACING.md }) {
        Scroll() {
          Column({ space: SPACING.lg }) {
            if (this.attachments.length > 0) {
              this.AttachmentStrip()
              Divider()
                .strokeWidth(DIVIDER)
                .color($r('app.color.divider'))
            }
            this.FieldLabel('元信息')
            this.OcrBlock()
            if (this.statusText.length > 0) {
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
          .padding({ bottom: SPACING.xl })
        }
        .layoutWeight(1)
        .width('100%')
        .scrollBar(BarState.Off)
        .align(Alignment.TopStart)
      }
      .layoutWeight(1)
      .height('100%')
      .alignItems(HorizontalAlign.Start)
    }
    .width('100%')
    .height('100%')
    .alignItems(VerticalAlign.Top)
  }

  /** 「更多」：AI 整理 + 附件排障信息（哈希），不再常驻页面。 */
  @Builder
  MoreSheet() {
    Column({ space: SPACING.md }) {
      Row() {
        Text('更多')
          .fontSize(FONT.body)
          .lineHeight(LINE_HEIGHT.body)
          .fontWeight(FontWeight.Medium)
          .fontColor($r('app.color.text_primary'))
          .layoutWeight(1)
          .textAlign(TextAlign.Start)
        Text('关闭')
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
          .height(TOUCH_MIN)
          .padding({ left: SPACING.md, right: SPACING.md })
          .textAlign(TextAlign.Center)
          .onClick(() => {
            this.panel = '';
          })
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      Divider()
        .strokeWidth(DIVIDER)
        .color($r('app.color.divider'))

      Text(this.aiBusy ? '正在整理…' : '用 AI 整理这条记录')
        .fontSize(FONT.body)
        .lineHeight(LINE_HEIGHT.body)
        .fontColor($r('app.color.text_primary'))
        .width('100%')
        .height(48)
        .textAlign(TextAlign.Start)
        .enabled(!this.aiBusy)
        .onClick(() => {
          this.panel = '';
          this.runAiForRecord();
        })

      Divider()
        .strokeWidth(DIVIDER)
        .color($r('app.color.divider'))

      Text('附件信息（哈希）')
        .fontSize(FONT.body)
        .lineHeight(LINE_HEIGHT.body)
        .fontColor($r('app.color.text_primary'))
        .width('100%')
        .height(48)
        .textAlign(TextAlign.Start)
        .onClick(() => {
          this.panel = 'files';
        })

      if (this.panel === 'files') {
        if (this.attachments.length === 0) {
          Text('没有附件')
            .fontSize(FONT.caption)
            .lineHeight(LINE_HEIGHT.caption)
            .fontColor($r('app.color.text_secondary'))
            .width('100%')
        } else {
          Scroll() {
            Column({ space: SPACING.xs }) {
              ForEach(
                this.attachments,
                (item: Attachment) => {
                  Text(`#${item.pageIndex}  ${item.sha256}  ${item.name}`)
                    .fontSize(FONT.caption)
                    .lineHeight(LINE_HEIGHT.caption)
                    .fontColor($r('app.color.text_secondary'))
                    .width('100%')
                    .textAlign(TextAlign.Start)
                    .maxLines(2)
                    .copyOption(CopyOptions.LocalDevice)
                },
                (item: Attachment) => `sha-${item.sha256}|${item.pageIndex}`
              )
            }
            .width('100%')
          }
          .width('100%')
          .height(180)
          .scrollBar(BarState.Auto)
        }
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  build() {
    Stack({ alignContent: Alignment.Center }) {
      PageLayout({
        title: '日程详情',
        subtitle: this.metaLine(),
        onBack: () => {
          router.back();
        },
        onMore: () => {
          this.panel = this.panel.length > 0 ? '' : 'more';
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

      if (this.panel.length > 0) {
        Column()
          .width('100%')
          .height('100%')
          .backgroundColor($r('app.color.scrim'))
          .onClick(() => {
            this.panel = '';
          })
        Column() {
          Blank()
          Column() {
            this.MoreSheet()
          }
          .width('100%')
          .padding(SPACING.lg)
          .backgroundColor($r('app.color.surface'))
          .borderRadius({ topLeft: RADIUS.md, topRight: RADIUS.md })
        }
        .width('100%')
        .height('100%')
      }

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
