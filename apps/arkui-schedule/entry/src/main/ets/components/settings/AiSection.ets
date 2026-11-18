/**
 * 设置页「AI 汇总」section。
 *
 * A2 拆分：内容从 `pages/Settings.ets` 的 `AiGroup()` 逐字搬出。页面持有全部 `@State`，
 * 这里只收**单向 props + 回调**（`@Prop` 值 + `onXxx`），本组件不写任何状态。
 *
 * 契约：
 * - 服务 / 模型是「点一行 → 页面开弹层选」的只读行（弹层仍在页面里）；
 * - API Key 只存本机（密码框），测试结果一行 + 失败时的「下一步」一行；
 * - 多源 fallback 面板放在「高级」折叠区**之前**（隐私决策不藏在折叠里），
 *   开关 / 列表 / 次数 / 诊断都在 `AiFallbackPanel` 内，本 section 只转发回调；
 * - 「高级」里只有模型名（预设源也可手输）与自定义源的 baseURL。
 */
import { DIVIDER, FONT, LINE_HEIGHT, RADIUS, SPACING, TOUCH_MIN } from '../../common/uiTokens';
import { AiFallbackPanel } from '../AiFallbackPanel';
import { DEFAULT_MAX_ATTEMPTS, normalizeMaxAttempts } from '../../model/aiFallback';
import type { FallbackDiagnostic, FallbackSource, FallbackSourcePatch } from '../../model/aiFallback';
import { defaultModelOf } from '../../model/aiProvider';
import {
  ErrorText as ErrorTextBit,
  FieldLabel as FieldLabelBit,
  FieldNote as FieldNoteBit,
  HintLine as HintLineBit
} from './SettingsBits';

@Component
export struct AiSection {
  @Prop aiKey: string = '';
  @Prop aiModel: string = '';
  /** AI 服务源 id（`model/aiProvider.ts` 的预设表）。 */
  @Prop aiProviderId: string = '';
  /** 自定义源的接口地址；预设源下存的是预设地址快照，页面上不展示。 */
  @Prop aiBaseURL: string = '';
  @Prop aiModelError: string = '';
  @Prop aiBaseUrlError: string = '';
  /** 「高级」是否展开（选自定义源时由页面自动展开）。 */
  @Prop advancedOpen: boolean = false;
  @Prop aiTestText: string = '';
  /** 失败后的一行可操作建议（成功时为空，不占行）。 */
  @Prop aiTestHint: string = '';
  @Prop aiTestBusy: boolean = false;
  /** 当前源预设的展示名与 Key 说明（页面 `provider()` 派生）。 */
  @Prop providerLabel: string = '';
  @Prop providerKeyHint: string = '';
  /** 当前模型展示名（页面 `modelLabel()` 派生）。 */
  @Prop modelLabel: string = '';
  /** 当前源是不是「自定义」（决定 baseURL 行与「模型名（必填）」文案）。 */
  @Prop customProvider: boolean = false;
  /** 主源的展示名（给 fallback 面板说明「备用源里不要再选它」）。 */
  @Prop primarySourceLabel: string = '';

  // 多源 fallback（`docs/AI-FALLBACK.md` §4）：三个持久化键 + 只留内存的诊断。
  @Prop fallbackEnabled: boolean = false;
  @Prop sources: FallbackSource[] = [];
  @Prop maxAttempts: number = DEFAULT_MAX_ATTEMPTS;
  @Prop diagnostics: FallbackDiagnostic[] = [];

  // ---------------------------------------------------------------- 回调（页面改状态）
  /** 点「服务」行 → 页面开服务选择弹层。 */
  onOpenProviderPanel: () => void = () => {};
  /** 点「模型」行 → 页面开模型选择弹层。 */
  onOpenModelPanel: () => void = () => {};
  onChangeAiKey: (value: string) => void = () => {};
  onTestAi: () => void = () => {};
  /** 手动点「高级 ▸ / ▾」（页面只翻转一个 @State）。 */
  onToggleAdvanced: () => void = () => {};
  onChangeAiModel: (value: string) => void = () => {};
  onChangeAiBaseURL: (value: string) => void = () => {};
  onToggleFallback: (isOn: boolean) => void = () => {};
  onAddFallback: () => void = () => {};
  onRemoveFallback: (index: number) => void = () => {};
  onMoveFallback: (index: number, offset: number) => void = () => {};
  onChangeFallback: (index: number, patch: FallbackSourcePatch) => void = () => {};
  onMaxAttempts: (value: number) => void = () => {};

  // ---------------------------------------------------------------- 共用字段构件（转发 SettingsBits）
  @Builder
  FieldLabel(text: string) {
    FieldLabelBit(text)
  }

  @Builder
  ErrorText(text: string) {
    ErrorTextBit(text)
  }

  @Builder
  HintLine(text: string) {
    HintLineBit(text)
  }

  @Builder
  FieldNote(text: string) {
    FieldNoteBit(text)
  }

  /** AI 组：服务 / 模型 / API Key / 测试 + 折叠的高级（仅 baseURL）。 */
  build() {
    Column({ space: SPACING.md }) {
      Text('AI 汇总')
        .fontSize(FONT.body)
        .lineHeight(LINE_HEIGHT.body)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('app.color.text_primary'))
        .width('100%')
        .textAlign(TextAlign.Start)

      Row({ space: SPACING.sm }) {
        Text('服务')
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
          .width(72)
          .textAlign(TextAlign.Start)
        Text(this.providerLabel)
          .fontSize(FONT.body)
          .lineHeight(LINE_HEIGHT.body)
          .fontColor($r('app.color.text_primary'))
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
          .textAlign(TextAlign.End)
        Text('▾')
          .fontSize(FONT.caption)
          .fontColor($r('app.color.text_secondary'))
      }
      .width('100%')
      .height(TOUCH_MIN)
      .alignItems(VerticalAlign.Center)
      .onClick(() => {
        this.onOpenProviderPanel();
      })
      Divider()
        .strokeWidth(DIVIDER)
        .color($r('app.color.divider'))

      Row({ space: SPACING.sm }) {
        Text('模型')
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
          .width(72)
          .textAlign(TextAlign.Start)
        Text(this.modelLabel)
          .fontSize(FONT.body)
          .lineHeight(LINE_HEIGHT.body)
          .fontColor($r('app.color.text_primary'))
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
          .textAlign(TextAlign.End)
        Text('▾')
          .fontSize(FONT.caption)
          .fontColor($r('app.color.text_secondary'))
      }
      .width('100%')
      .height(TOUCH_MIN)
      .alignItems(VerticalAlign.Center)
      .onClick(() => {
        this.onOpenModelPanel();
      })
      Divider()
        .strokeWidth(DIVIDER)
        .color($r('app.color.divider'))

      this.FieldLabel('API Key（仅存本机）')
      TextInput({ text: this.aiKey, placeholder: 'sk-…' })
        .type(InputType.Password)
        .width('100%')
        .height(TOUCH_MIN + SPACING.xs)
        .fontSize(FONT.body)
        .backgroundColor($r('app.color.page_background'))
        .borderRadius(RADIUS.none)
        .padding({ left: 0, right: 0 })
        .onChange((value: string) => {
          this.onChangeAiKey(value);
        })
      Divider()
        .strokeWidth(DIVIDER)
        .color($r('app.color.divider'))
      this.HintLine(this.providerKeyHint)

      Row({ space: SPACING.md }) {
        Button(this.aiTestBusy ? '测试中…' : '测试')
          .height(TOUCH_MIN + SPACING.sm)
          .fontSize(FONT.body)
          .backgroundColor($r('app.color.brand_soft'))
          .fontColor($r('app.color.brand'))
          .borderRadius(RADIUS.sm)
          .enabled(!this.aiTestBusy)
          .onClick(() => {
            this.onTestAi();
          })
        Text(this.aiTestText.length > 0 ? this.aiTestText : '未测试')
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor(this.aiTestText.startsWith('失败') ? $r('app.color.danger') : $r('app.color.text_secondary'))
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
          .textAlign(TextAlign.Start)
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      // 失败才出现的「下一步做什么」；成功时不占行
      if (this.aiTestHint.length > 0) {
        Text(this.aiTestHint)
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
          .maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
          .textAlign(TextAlign.Start)
      }

      // 多源 fallback（`docs/AI-FALLBACK.md` §8 的挂载片段）：放在「高级」折叠区**之前**，
      // 因为「主源失败后要不要发给别家」是隐私决策，不能藏在折叠里。组件自带开关 / 列表 /
      // 次数 / 诊断，本页只接回调（改状态）与三个持久化键（保存时写回）。
      Divider()
        .strokeWidth(DIVIDER)
        .color($r('app.color.divider'))

      AiFallbackPanel({
        fallbackEnabled: this.fallbackEnabled,
        sources: this.sources,
        maxAttempts: this.maxAttempts,
        diagnostics: this.diagnostics,
        primaryLabel: this.primarySourceLabel,
        onToggle: (isOn: boolean): void => {
          this.onToggleFallback(isOn);
        },
        onAdd: (): void => {
          this.onAddFallback();
        },
        onRemove: (index: number): void => {
          this.onRemoveFallback(index);
        },
        onMove: (index: number, offset: number): void => {
          this.onMoveFallback(index, offset);
        },
        onChange: (index: number, patch: FallbackSourcePatch): void => {
          this.onChangeFallback(index, patch);
        },
        onMaxAttempts: (value: number): void => {
          this.onMaxAttempts(normalizeMaxAttempts(value));
        }
      })

      Row({ space: SPACING.sm }) {
        Text(this.advancedOpen ? '高级 ▾' : '高级 ▸')
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
          .height(TOUCH_MIN)
          .textAlign(TextAlign.Start)
          .onClick(() => {
            this.onToggleAdvanced();
          })
      }
      .width('100%')

      if (this.advancedOpen) {
        // 模型名允许手输（三个预设源也允许，防模型下线）；留空回落到该源默认
        this.FieldLabel(this.customProvider ? '模型名（必填）' : '模型名（可手输，留空用默认）')
        TextInput({ text: this.aiModel, placeholder: defaultModelOf(this.aiProviderId) })
          .width('100%')
          .height(TOUCH_MIN + SPACING.xs)
          .fontSize(FONT.caption)
          .backgroundColor($r('app.color.page_background'))
          .borderRadius(RADIUS.none)
          .padding({ left: 0, right: 0 })
          .onChange((value: string) => {
            this.onChangeAiModel(value);
          })
        Divider()
          .strokeWidth(DIVIDER)
          .color($r('app.color.divider'))
        if (this.aiModelError.length > 0) {
          this.ErrorText(this.aiModelError)
        }

        if (this.customProvider) {
          this.FieldLabel('接口地址 baseURL')
          TextInput({ text: this.aiBaseURL, placeholder: 'https://api.example.com/v1' })
            .width('100%')
            .height(TOUCH_MIN + SPACING.xs)
            .fontSize(FONT.caption)
            .backgroundColor($r('app.color.page_background'))
            .borderRadius(RADIUS.none)
            .padding({ left: 0, right: 0 })
            .onChange((value: string) => {
              this.onChangeAiBaseURL(value);
            })
          Divider()
            .strokeWidth(DIVIDER)
            .color($r('app.color.divider'))
          if (this.aiBaseUrlError.length > 0) {
            this.ErrorText(this.aiBaseUrlError)
          }
        } else {
          this.HintLine('预设源使用内置接口地址；要自定义地址请把「服务」切到「自定义」。')
        }
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }
}
