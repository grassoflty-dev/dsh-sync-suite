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
 * 复制路径：路径用 `Text(...).copyOption(CopyOptions.LocalDevice)` 渲染，**长按即可复制**，
 * 不需要 pasteboard API、也不需要任何新权限；宿主若想要一个显式按钮，传 `onCopyPath` 即可
 * （此时才会渲染「复制路径」按钮）。
 */
import {
  EXPORT_FORMAT_JSON,
  EXPORT_FORMAT_MARKDOWN,
  EMPTY_EXPORT_IMPORT_STATE,
  canConfirmImport,
  dryRunSummary,
  importBlockedTip,
  isDryRunEmpty
} from '../model/exportImport';
import type { ExportImportState, ExportRequest } from '../model/exportImport';
import { DIVIDER, FONT, LINE_HEIGHT, RADIUS, SPACING, TOUCH_MIN } from '../common/uiTokens';

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
  /** 取消（清空 dry-run 结果；页面用 `clearDryRun` 更新 state）。 */
  onCancel: (() => void) | null = null;
  /** 可选：显式「复制路径」按钮（`null` = 不渲染，只靠长按复制）。 */
  onCopyPath: (() => void) | null = null;

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

  private emitCopyPath(): void {
    const handler: (() => void) | null = this.onCopyPath;
    if (handler !== null) {
      handler();
    }
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

  /** 提示文案：dry-run 的阻塞提示优先于普通 message（阻塞提示更「近」，不能被别的话盖掉）。 */
  private tipText(): string {
    const blocked = importBlockedTip(this.state);
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

  /** 格式切换（选中 = 品牌实底，未选中 = 品牌淡底；高度 `TOUCH_MIN`）。 */
  @Builder
  FormatRow() {
    Row({ space: SPACING.sm }) {
      Text('Markdown')
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontColor(this.format === EXPORT_FORMAT_MARKDOWN ? $r('app.color.text_inverse') : $r('app.color.brand'))
        .backgroundColor(
          this.format === EXPORT_FORMAT_MARKDOWN ? $r('app.color.brand') : $r('app.color.brand_soft')
        )
        .borderRadius(RADIUS.sm)
        .height(TOUCH_MIN)
        .padding({ left: SPACING.md, right: SPACING.md })
        .textAlign(TextAlign.Center)
        .onClick(() => {
          this.format = EXPORT_FORMAT_MARKDOWN;
        })
      Text('JSON')
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontColor(this.format === EXPORT_FORMAT_JSON ? $r('app.color.text_inverse') : $r('app.color.brand'))
        .backgroundColor(this.format === EXPORT_FORMAT_JSON ? $r('app.color.brand') : $r('app.color.brand_soft'))
        .borderRadius(RADIUS.sm)
        .height(TOUCH_MIN)
        .padding({ left: SPACING.md, right: SPACING.md })
        .textAlign(TextAlign.Center)
        .onClick(() => {
          this.format = EXPORT_FORMAT_JSON;
        })
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
          Text('复制路径')
            .fontSize(FONT.caption)
            .lineHeight(LINE_HEIGHT.caption)
            .fontColor($r('app.color.brand'))
            .height(TOUCH_MIN)
            .padding({ left: SPACING.sm, right: SPACING.sm })
            .textAlign(TextAlign.Center)
            .onClick(() => {
              this.emitCopyPath();
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

  build() {
    Column({ space: SPACING.md }) {
      this.GroupTitle('导出')
      this.HintLine('按日期区间导出本机记录（只读派生，不改任何源文件）')

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

      Button(this.state.busy ? '导出中…' : '导出')
        .height(TOUCH_MIN)
        .fontSize(FONT.body)
        .fontColor($r('app.color.text_inverse'))
        .backgroundColor($r('app.color.brand'))
        .borderRadius(RADIUS.sm)
        .enabled(!this.state.busy)
        .opacity(this.state.busy ? 0.4 : 1)
        .width('100%')
        .onClick(() => {
          this.emitExport();
        })

      if (this.state.exportPath.length > 0) {
        this.ExportPathLine()
      }

      Divider()
        .strokeWidth(DIVIDER)
        .color($r('app.color.divider'))

      this.GroupTitle('导入')
      this.HintLine('只追加到本机当天文件：冲突（同 id 且更新）不会覆盖，非法记录整批不写')

      Button(this.pickLabel())
        .height(TOUCH_MIN)
        .fontSize(FONT.body)
        .fontColor($r('app.color.brand'))
        .backgroundColor($r('app.color.brand_soft'))
        .borderRadius(RADIUS.sm)
        .enabled(!this.state.busy)
        .opacity(this.state.busy ? 0.4 : 1)
        .width('100%')
        .onClick(() => {
          this.emitPickFile();
        })

      if (this.state.importFileName.length > 0) {
        this.HintLine(`已选：${this.state.importFileName}`)
      }

      if (this.state.dryRunReady) {
        this.DryRunBlock()
      }

      if (this.tipText().length > 0) {
        Text(this.tipText())
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor(this.tipColor())
          .width('100%')
          .textAlign(TextAlign.Start)
      }

      Row({ space: SPACING.sm }) {
        Button(this.confirmLabel())
          .height(TOUCH_MIN)
          .fontSize(FONT.body)
          .fontColor($r('app.color.text_inverse'))
          .backgroundColor($r('app.color.brand'))
          .borderRadius(RADIUS.sm)
          .enabled(canConfirmImport(this.state))
          .opacity(canConfirmImport(this.state) ? 1 : 0.4)
          .layoutWeight(1)
          .onClick(() => {
            this.emitConfirmImport();
          })
        Button('取消')
          .height(TOUCH_MIN)
          .fontSize(FONT.body)
          .fontColor($r('app.color.brand'))
          .backgroundColor($r('app.color.brand_soft'))
          .borderRadius(RADIUS.sm)
          .enabled(!this.state.busy)
          .layoutWeight(1)
          .onClick(() => {
            this.emitCancel();
          })
      }
      .width('100%')
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .backgroundColor($r('app.color.page_background'))
  }
}
