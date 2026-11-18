/**
 * 错误态（`docs/STATE-UI.md` §4.3）：**发生了什么 / 为什么 / 下一步 + 可复制诊断 + 重试**。
 *
 * 渲染顺序是固定的（评审按这个顺序看）：
 * **红色标题（what）→ 为什么（why）→ 下一步（next）→ 诊断块 → 按钮行**。
 *
 * 诊断块的三条硬指标：
 * - 灰底（`control_fill`）+ 等宽（`fontFamily('monospace')`）—— 错误码/版本号对齐才扫得动；
 * - `copyOption(CopyOptions.LocalDevice)`：**长按可复制**，用户反馈时能整段贴出来；
 * - 块上方必须有「长按可复制诊断信息」——用户不知道能长按，等于没有复制能力。
 *
 * 缺省不编造：`why` 为空就不渲染那一行；`next` 为空则回落到 `copy.ts` 的默认建议
 * （「重试，或到设置页检查配置」，从 `errorText('')` 里取，不在这里另抄一份字面量）。
 */
import { errorText, issueText } from '../../common/copy';
import { FONT, LINE_HEIGHT, RADIUS, SPACING } from '../../common/uiTokens';
import { ActionButton } from '../ActionButton';

/** 诊断块上方的提示（必须存在：不说用户不知道能长按复制）。 */
const DIAGNOSTICS_HINT: string = '长按可复制诊断信息';

/** 重试按钮文字（错误态必须有出路，不允许空标签）。 */
const RETRY_LABEL: string = '重试';

/** 第二出路：去设置页检查配置。 */
const SETTINGS_LABEL: string = '去设置';

/** 「下一步：」标记（与 `common/copy.ts` 的格式一致）。 */
const NEXT_MARK: string = '下一步：';

/** 句末标点（取首句用）。 */
const SENTENCE_END: string = '。';

/**
 * 默认「下一步」建议：从 `copy.ts` 的 `errorText('')` 里取「下一步：」之后的内容。
 *
 * 这样默认建议只有**一处**文案来源（`common/copy.ts`），组件里不再抄第二份。
 */
function defaultNextText(): string {
  const text: string = errorText('');
  const at: number = text.indexOf(NEXT_MARK);
  if (at < 0) {
    return text;
  }
  return text.slice(at + NEXT_MARK.length);
}

/** 取第一句（`操作失败。下一步：…` → `操作失败`），用于标题兜底。 */
function firstSentence(text: string): string {
  const at: number = text.indexOf(SENTENCE_END);
  if (at < 0) {
    return text;
  }
  return text.slice(0, at);
}

@Component
export struct ErrorState {
  /** 发生了什么（红色标题，例「同步失败」）；空则用 `errorText('')` 的首句兜底。 */
  @Prop what: string = '';
  /** 为什么（原因，例「网络不可达」）；空则不渲染该行。 */
  @Prop why: string = '';
  /** 下一步（例「检查网络后重试」）；空则回落默认建议。 */
  @Prop next: string = '';
  /** `formatDiagnostics()` 的产物（版本 / 设备 / 错误码 / 时间）；空则不渲染诊断块。 */
  @Prop diagnostics: string = '';
  /** `true` = 行内小条（表单里），`false` = 整块居中。 */
  @Prop compact: boolean = false;

  /** 重试回调；`null` = 不提供重试按钮。 */
  onRetry: (() => void) | null = null;

  /** 第二出路（去设置页）；`null` = 不提供该按钮。 */
  onOpenSettings: (() => void) | null = null;

  /** 标题：调用方没给就用 copy 的错误文案首句，绝不空标题。 */
  private titleText(): string {
    const given: string = this.what.trim();
    return given.length > 0 ? given : firstSentence(errorText(''));
  }

  /** 原因：空串 = 不渲染（不编造原因）。 */
  private whyText(): string {
    return this.why.trim();
  }

  /** 下一步：空则回落 `copy.ts` 的默认建议（永远有出路）。 */
  private nextText(): string {
    const given: string = this.next.trim();
    return given.length > 0 ? given : defaultNextText();
  }

  /** 紧凑模式把「为什么 + 下一步」压成一行，格式由 `copy.issueText()` 统一。 */
  private compactLine(): string {
    return issueText(this.whyText(), this.nextText());
  }

  /** 是否渲染按钮行：两个回调都没有时不留空行。 */
  private hasButtons(): boolean {
    return this.onRetry !== null || this.onOpenSettings !== null;
  }

  /** 触发重试（回调取值期间固定一次）。 */
  private invokeRetry(): void {
    const handler: (() => void) | null = this.onRetry;
    if (handler !== null) {
      handler();
    }
  }

  /** 触发「去设置」。 */
  private invokeOpenSettings(): void {
    const handler: (() => void) | null = this.onOpenSettings;
    if (handler !== null) {
      handler();
    }
  }

  // ------------------------------------------------------------------ UI

  /** 红色标题：整块用正文级、行内用辅助级（不引入第四级字号）。 */
  @Builder
  TitleLine() {
    Text(this.titleText())
      .fontSize(this.compact ? FONT.caption : FONT.body)
      .lineHeight(this.compact ? LINE_HEIGHT.caption : LINE_HEIGHT.body)
      .fontWeight(FontWeight.Medium)
      .fontColor($r('app.color.danger'))
      .width('100%')
      .textAlign(this.compact ? TextAlign.Start : TextAlign.Center)
  }

  /** 为什么：空则不渲染。 */
  @Builder
  WhyLine() {
    if (this.whyText().length > 0) {
      Text(this.whyText())
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontColor($r('app.color.text_secondary'))
        .width('100%')
        .textAlign(this.compact ? TextAlign.Start : TextAlign.Center)
    }
  }

  /** 下一步：永远有内容（空入参由 `nextText()` 兜底）。 */
  @Builder
  NextLine() {
    Text(`${NEXT_MARK}${this.nextText()}`)
      .fontSize(FONT.caption)
      .lineHeight(LINE_HEIGHT.caption)
      .fontColor($r('app.color.text_primary'))
      .width('100%')
      .textAlign(this.compact ? TextAlign.Start : TextAlign.Center)
  }

  /** 紧凑模式：原因 + 下一步压成一行（`copy.issueText` 的格式）。 */
  @Builder
  CompactLine() {
    Text(this.compactLine())
      .fontSize(FONT.caption)
      .lineHeight(LINE_HEIGHT.caption)
      .fontColor($r('app.color.text_secondary'))
      .width('100%')
      .textAlign(TextAlign.Start)
  }

  /** 诊断块：灰底 + 等宽 + 长按复制，上方一行提示。 */
  @Builder
  DiagnosticsBlock() {
    if (this.diagnostics.length > 0) {
      Column({ space: SPACING.xs }) {
        Text(DIAGNOSTICS_HINT)
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
          .width('100%')
          .textAlign(TextAlign.Start)

        Text(this.diagnostics)
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_primary'))
          .fontFamily('monospace')
          .copyOption(CopyOptions.LocalDevice)
          .width('100%')
          .textAlign(TextAlign.Start)
      }
      .width('100%')
      .padding(SPACING.sm)
      .backgroundColor($r('app.color.control_fill'))
      .borderRadius(RADIUS.sm)
    }
  }

  /** 按钮行：重试（主）+ 去设置（次，可选）。 */
  @Builder
  ButtonRow() {
    if (this.hasButtons()) {
      Row({ space: SPACING.sm }) {
        if (this.onRetry !== null) {
          ActionButton({
            label: RETRY_LABEL,
            enabled: true,
            disabledReason: '',
            busy: false,
            variant: 'primary',
            block: false,
            onTap: (): void => {
              this.invokeRetry();
            },
            onBlockedTap: null
          })
        }
        if (this.onOpenSettings !== null) {
          ActionButton({
            label: SETTINGS_LABEL,
            enabled: true,
            disabledReason: '',
            busy: false,
            variant: 'secondary',
            block: false,
            onTap: (): void => {
              this.invokeOpenSettings();
            },
            onBlockedTap: null
          })
        }
      }
      .width('100%')
      .justifyContent(this.compact ? FlexAlign.Start : FlexAlign.Center)
    }
  }

  build() {
    Column({ space: this.compact ? SPACING.xs : SPACING.sm }) {
      this.TitleLine()
      if (this.compact) {
        this.CompactLine()
      } else {
        this.WhyLine()
        this.NextLine()
      }
      this.DiagnosticsBlock()
      this.ButtonRow()
    }
    .width('100%')
    .alignItems(this.compact ? HorizontalAlign.Start : HorizontalAlign.Center)
    .justifyContent(FlexAlign.Center)
    .padding({
      top: this.compact ? SPACING.xs : SPACING.xl,
      bottom: this.compact ? SPACING.xs : SPACING.xl,
      left: this.compact ? 0 : SPACING.lg,
      right: this.compact ? 0 : SPACING.lg
    })
  }
}
