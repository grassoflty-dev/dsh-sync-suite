/**
 * 设置页的「AI 多源 fallback」面板：**纯展示 + 回调**，不做任何 IO、不读写设置、不落盘。
 *
 * 设计约束（`docs/AI-FALLBACK.md` / `docs/UI-DESIGN.md`）：
 * - 白底、无卡片、无阴影；字号只用 `FONT` 三级，间距只用 `SPACING` 五档，颜色只走
 *   `$r('app.color.*')` 资源（`resources/dark` 已覆盖，自动跟随深色模式）；
 * - 开关旁边**必须**写明「开启后，主源失败时会把**同样的内容**发给下面的备用源」——这是隐私红线，
 *   不能让用户以为 fallback 只是「换个地址取同样的结果」；
 * - 备用源最多 `MAX_FALLBACK_SOURCES`（3）个：provider 用 `aiProvider.ts` 的预设下拉，
 *   模型名允许手输（防模型下线），自定义源多一个 baseURL 输入框；
 * - 上次运行的诊断**只显示在组件内部**（源名 / 原因 / 耗时 ms），由父页面用 `diagnostics` 传入，
 *   组件既不缓存也不持久化；诊断已由运行器 `sanitizeDiagnostic` 脱敏，因此这里可以放心显示 message。
 *
 * 回调契约（父页面负责真正改状态/落盘）：
 * - `onToggle(fallbackEnabled)`；
 * - `onAdd()` / `onRemove(index)` / `onMove(index, offset)`（offset = -1 上移 / +1 下移）；
 * - `onChange(index, patch)`：`patch.providerId` 变更时同时给出该源默认 `modelId` 与空 `baseURL`
 *   （表示「换源了，旧地址/旧模型不再适用」）；`patch.modelId` / `patch.baseURL` 是单字段输入；
 * - `onMaxAttempts(value)`（可选）：不传就只展示次数，不给 +/- 按钮。
 *
 * 契约：共享层组件（Android 与 HarmonyOS 都能编译），不含任何鸿蒙专属模块，也不带 `@crossplatform`。
 */
import { DIVIDER, FONT, LINE_HEIGHT, RADIUS, SPACING, TOUCH_MIN } from '../common/uiTokens';
import {
  DEFAULT_MAX_ATTEMPTS,
  MAX_ATTEMPTS_LIMIT,
  MAX_FALLBACK_SOURCES,
  sourceLabel,
  summarizeDiagnostics
} from '../model/aiFallback';
import type { FallbackDiagnostic, FallbackSource, FallbackSourcePatch, FallbackSummary } from '../model/aiFallback';
import { AI_PROVIDERS, CUSTOM_PROVIDER_ID, defaultModelOf, findProvider } from '../model/aiProvider';
import type { AiProviderPreset } from '../model/aiProvider';

@Component
export struct AiFallbackPanel {
  /** 是否启用 fallback（默认关闭；关闭时内容只发给主源）。 */
  @Prop fallbackEnabled: boolean = false;
  /** 备用源顺序（最多 3 个；不含主源）。 */
  @Prop sources: FallbackSource[] = [];
  /** 最多尝试几次（含主源）。 */
  @Prop maxAttempts: number = DEFAULT_MAX_ATTEMPTS;
  /** 上次运行的诊断（已脱敏；空数组表示还没跑过）。 */
  @Prop diagnostics: FallbackDiagnostic[] = [];
  /** 当前主源的展示名（如 `DeepSeek 官方 · deepseek-chat`），只用于说明文案。 */
  @Prop primaryLabel: string = '';

  onToggle: ((enabled: boolean) => void) | null = null;
  onAdd: (() => void) | null = null;
  onRemove: ((index: number) => void) | null = null;
  onMove: ((index: number, offset: number) => void) | null = null;
  onChange: ((index: number, patch: FallbackSourcePatch) => void) | null = null;
  /** 调整尝试次数的回调；`null` 时只展示不给按钮。 */
  onMaxAttempts: ((value: number) => void) | null = null;

  // ------------------------------------------------------------------ 纯函数帮手

  /** 是否已经放满 3 个（放满后「添加」按钮禁用）。 */
  private isAddBlocked(): boolean {
    return this.sources.length >= MAX_FALLBACK_SOURCES;
  }

  /** provider 下拉的选项（复用 `aiProvider.ts` 的预设表，顺序即设置页顺序）。 */
  private providerOptions(): SelectOption[] {
    const options: SelectOption[] = [];
    for (const preset of AI_PROVIDERS) {
      options.push({ value: preset.label });
    }
    return options;
  }

  /** provider 在预设表里的下标（未知回调默认源，保证 `Select.selected` 合法）。 */
  private providerIndex(providerId: string): number {
    const text: string = typeof providerId === 'string' ? providerId.trim().toLowerCase() : '';
    for (let index = 0; index < AI_PROVIDERS.length; index++) {
      if (AI_PROVIDERS[index].id === text) {
        return index;
      }
    }
    return 0;
  }

  /** provider 的中文名（未知回落默认源名，`findProvider` 自带兜底）。 */
  private providerLabel(providerId: string): string {
    return findProvider(providerId).label;
  }

  /** 是否自定义源（只有自定义源需要填 baseURL）。 */
  private isCustomProvider(providerId: string): boolean {
    return typeof providerId === 'string' && providerId.trim().toLowerCase() === CUSTOM_PROVIDER_ID;
  }

  /** 模型输入框的占位符（该源默认模型）。 */
  private modelPlaceholder(providerId: string): string {
    return defaultModelOf(providerId);
  }

  /** 一排里「上移/下移」是否可用。 */
  private canMoveUp(index: number): boolean {
    return index > 0;
  }

  private canMoveDown(index: number): boolean {
    return index >= 0 && index < this.sources.length - 1;
  }

  /** 诊断 outcome 的中文标签（决策层的四个值，未知按「停止」显示）。 */
  private outcomeText(outcome: string): string {
    if (outcome === 'success') {
      return '成功';
    }
    if (outcome === 'next-source') {
      return '换源';
    }
    if (outcome === 'retry-same') {
      return '同源重试';
    }
    return '停止';
  }

  /** 诊断行颜色：成功用品牌色，其余用 danger（失败要显眼）。 */
  private outcomeColor(outcome: string): Resource {
    return outcome === 'success' ? $r('app.color.brand') : $r('app.color.danger');
  }

  /** 一行诊断的标题：第几次 / 源名 / 结果 / 耗时。 */
  private diagnosticTitle(item: FallbackDiagnostic): string {
    const source: FallbackSource = { providerId: item.providerId, modelId: item.modelId };
    return `第 ${item.attempt} 次 · ${sourceLabel(source)} · ${this.outcomeText(item.outcome)} · ${item.elapsedMs}ms`;
  }

  /** 诊断汇总一行（共几次 / 第几次成功 / 失败源）。 */
  private summaryText(): string {
    const summary: FallbackSummary = summarizeDiagnostics(this.diagnostics);
    if (summary.attempts === 0) {
      return '';
    }
    const result: string = summary.succeededAt === null ? '全部失败' : `第 ${summary.succeededAt} 次成功`;
    const failed: string =
      summary.failedSources.length === 0 ? '无失败源' : `失败源：${summary.failedSources.join('、')}`;
    return `共 ${summary.attempts} 次尝试 · ${result} · ${failed}`;
  }

  // ------------------------------------------------------------------ 回调出口

  private emitToggle(isOn: boolean): void {
    const handler: ((enabled: boolean) => void) | null = this.onToggle;
    if (handler !== null) {
      handler(isOn);
    }
  }

  private emitAdd(): void {
    const handler: (() => void) | null = this.onAdd;
    if (handler !== null) {
      handler();
    }
  }

  private emitRemove(index: number): void {
    const handler: ((index: number) => void) | null = this.onRemove;
    if (handler !== null) {
      handler(index);
    }
  }

  private emitMove(index: number, offset: number): void {
    const handler: ((index: number, offset: number) => void) | null = this.onMove;
    if (handler !== null) {
      handler(index, offset);
    }
  }

  private emitChange(index: number, patch: FallbackSourcePatch): void {
    const handler: ((index: number, patch: FallbackSourcePatch) => void) | null = this.onChange;
    if (handler !== null) {
      handler(index, patch);
    }
  }

  /** 换 provider：同时把模型重置成新源默认模型、清掉旧 baseURL（见文件头回调契约）。 */
  private emitProvider(index: number, optionIndex: number): void {
    const preset: AiProviderPreset = AI_PROVIDERS[optionIndex];
    if (preset === undefined) {
      return;
    }
    const patch: FallbackSourcePatch = {
      providerId: preset.id,
      modelId: defaultModelOf(preset.id),
      baseURL: ''
    };
    this.emitChange(index, patch);
  }

  private emitModel(index: number, value: string): void {
    const patch: FallbackSourcePatch = { modelId: value };
    this.emitChange(index, patch);
  }

  private emitBaseURL(index: number, value: string): void {
    const patch: FallbackSourcePatch = { baseURL: value };
    this.emitChange(index, patch);
  }

  /** 尝试次数 ±1（夹到 1..`MAX_ATTEMPTS_LIMIT`）。 */
  private emitMaxAttempts(delta: number): void {
    const handler: ((value: number) => void) | null = this.onMaxAttempts;
    if (handler === null) {
      return;
    }
    const next: number = Math.max(1, Math.min(MAX_ATTEMPTS_LIMIT, Math.floor(this.maxAttempts + delta)));
    if (next !== this.maxAttempts) {
      handler(next);
    }
  }

  // ------------------------------------------------------------------ UI

  /** 开关 + 隐私说明（说明里必须出现「同样的内容」）。 */
  @Builder
  Header() {
    Row({ space: SPACING.sm }) {
      Column({ space: SPACING.xs }) {
        Text('多源 fallback')
          .fontSize(FONT.body)
          .lineHeight(LINE_HEIGHT.body)
          .fontWeight(FontWeight.Medium)
          .fontColor($r('app.color.text_primary'))
          .width('100%')
          .textAlign(TextAlign.Start)
        Text(`开启后，主源失败时会把同样的内容发给下面的备用源（按顺序，最多 ${MAX_FALLBACK_SOURCES} 个）。`)
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
          .width('100%')
          .textAlign(TextAlign.Start)
        if (this.primaryLabel.length > 0) {
          Text(`主源：${this.primaryLabel}（备用源里不要再选它）`)
            .fontSize(FONT.caption)
            .lineHeight(LINE_HEIGHT.caption)
            .fontColor($r('app.color.text_secondary'))
            .width('100%')
            .textAlign(TextAlign.Start)
        }
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)

      Toggle({ type: ToggleType.Switch, isOn: this.fallbackEnabled })
        .selectedColor($r('app.color.brand'))
        .onChange((isOn: boolean) => {
          this.emitToggle(isOn);
        })
    }
    .width('100%')
    .constraintSize({ minHeight: TOUCH_MIN + SPACING.sm })
    .alignItems(VerticalAlign.Center)
  }

  /** 单个备用源行：序号 + 上移/下移/删除 + provider 下拉 + 模型输入（自定义源多一个地址）。 */
  @Builder
  SourceRow(item: FallbackSource, index: number) {
    Column({ space: SPACING.xs }) {
      Row({ space: SPACING.sm }) {
        Text(`备用源 ${index + 1}`)
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
          .layoutWeight(1)
          .textAlign(TextAlign.Start)
        Button('上移')
          .height(TOUCH_MIN)
          .fontSize(FONT.caption)
          .backgroundColor($r('app.color.brand_soft'))
          .fontColor($r('app.color.brand'))
          .borderRadius(RADIUS.sm)
          .enabled(this.canMoveUp(index))
          .onClick(() => {
            this.emitMove(index, -1);
          })
        Button('下移')
          .height(TOUCH_MIN)
          .fontSize(FONT.caption)
          .backgroundColor($r('app.color.brand_soft'))
          .fontColor($r('app.color.brand'))
          .borderRadius(RADIUS.sm)
          .enabled(this.canMoveDown(index))
          .onClick(() => {
            this.emitMove(index, 1);
          })
        Button('删除')
          .height(TOUCH_MIN)
          .fontSize(FONT.caption)
          .backgroundColor($r('app.color.brand_soft'))
          .fontColor($r('app.color.danger'))
          .borderRadius(RADIUS.sm)
          .onClick(() => {
            this.emitRemove(index);
          })
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      Select(this.providerOptions())
        .selected(this.providerIndex(item.providerId))
        .value(this.providerLabel(item.providerId))
        .font({ size: FONT.body })
        .optionFont({ size: FONT.body })
        .selectedOptionFont({ size: FONT.body })
        .width('100%')
        .height(TOUCH_MIN + SPACING.xs)
        .onSelect((optionIndex: number) => {
          this.emitProvider(index, optionIndex);
        })

      TextInput({ text: item.modelId, placeholder: this.modelPlaceholder(item.providerId) })
        .width('100%')
        .height(TOUCH_MIN + SPACING.xs)
        .fontSize(FONT.body)
        .backgroundColor($r('app.color.page_background'))
        .borderRadius(RADIUS.none)
        .padding({ left: 0, right: 0 })
        .onChange((value: string) => {
          this.emitModel(index, value);
        })

      if (this.isCustomProvider(item.providerId)) {
        TextInput({ text: item.baseURL === undefined ? '' : item.baseURL, placeholder: 'https://api.example.com/v1' })
          .width('100%')
          .height(TOUCH_MIN + SPACING.xs)
          .fontSize(FONT.caption)
          .backgroundColor($r('app.color.page_background'))
          .borderRadius(RADIUS.none)
          .padding({ left: 0, right: 0 })
          .onChange((value: string) => {
            this.emitBaseURL(index, value);
          })
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  /** 备用源列表（空态给一句说明，不放空卡片）。 */
  @Builder
  SourceList() {
    if (this.sources.length === 0) {
      Text('还没有备用源：添加一个后，主源失败会按顺序自动重试。')
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontColor($r('app.color.text_secondary'))
        .width('100%')
        .textAlign(TextAlign.Start)
    } else {
      ForEach(
        this.sources,
        (item: FallbackSource, index: number) => {
          this.SourceRow(item, index)
        },
        (item: FallbackSource, index: number) => `${index}-${item.providerId}-${item.modelId}`
      )
    }
  }

  /** 添加按钮（满 3 个禁用并说明原因）。 */
  @Builder
  AddButton() {
    Row({ space: SPACING.sm }) {
      Button(this.isAddBlocked() ? `最多 ${MAX_FALLBACK_SOURCES} 个备用源` : '+ 添加备用源')
        .height(TOUCH_MIN)
        .fontSize(FONT.body)
        .backgroundColor($r('app.color.brand_soft'))
        .fontColor($r('app.color.brand'))
        .borderRadius(RADIUS.sm)
        .enabled(!this.isAddBlocked())
        .onClick(() => {
          this.emitAdd();
        })
    }
    .width('100%')
    .alignItems(VerticalAlign.Center)
  }

  /** 最多尝试次数（含主源）：没有 `onMaxAttempts` 时只展示。 */
  @Builder
  AttemptsRow() {
    Row({ space: SPACING.sm }) {
      Column({ space: SPACING.xs }) {
        Text('最多尝试次数（含主源）')
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
          .width('100%')
          .textAlign(TextAlign.Start)
        Text(`当前：${this.maxAttempts} 次（上限 ${MAX_ATTEMPTS_LIMIT}）`)
          .fontSize(FONT.body)
          .lineHeight(LINE_HEIGHT.body)
          .fontColor($r('app.color.text_primary'))
          .width('100%')
          .textAlign(TextAlign.Start)
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)

      if (this.onMaxAttempts !== null) {
        Button('−')
          .height(TOUCH_MIN)
          .fontSize(FONT.body)
          .backgroundColor($r('app.color.brand_soft'))
          .fontColor($r('app.color.brand'))
          .borderRadius(RADIUS.sm)
          .enabled(this.maxAttempts > 1)
          .onClick(() => {
            this.emitMaxAttempts(-1);
          })
        Button('+')
          .height(TOUCH_MIN)
          .fontSize(FONT.body)
          .backgroundColor($r('app.color.brand_soft'))
          .fontColor($r('app.color.brand'))
          .borderRadius(RADIUS.sm)
          .enabled(this.maxAttempts < MAX_ATTEMPTS_LIMIT)
          .onClick(() => {
            this.emitMaxAttempts(1);
          })
      }
    }
    .width('100%')
    .alignItems(VerticalAlign.Center)
  }

  /** 上次运行的诊断（只在组件内部显示，不落盘）。 */
  @Builder
  DiagnosticsBlock() {
    Column({ space: SPACING.xs }) {
      Text('上次运行')
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('app.color.text_primary'))
        .width('100%')
        .textAlign(TextAlign.Start)

      if (this.diagnostics.length === 0) {
        Text('还没有运行记录：生成一次汇总后这里会显示每个源的尝试结果（源名 / 原因 / 耗时）。')
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
          .width('100%')
          .textAlign(TextAlign.Start)
      } else {
        Text(this.summaryText())
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
          .width('100%')
          .textAlign(TextAlign.Start)
        ForEach(
          this.diagnostics,
          (item: FallbackDiagnostic) => {
            Column({ space: SPACING.xs }) {
              Text(this.diagnosticTitle(item))
                .fontSize(FONT.caption)
                .lineHeight(LINE_HEIGHT.caption)
                .fontColor(this.outcomeColor(item.outcome))
                .width('100%')
                .textAlign(TextAlign.Start)
              if (item.message.length > 0) {
                Text(item.message)
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
          },
          (item: FallbackDiagnostic, index: number) => `${index}-${item.attempt}-${item.outcome}`
        )
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  build() {
    Column({ space: SPACING.md }) {
      this.Header()
      Divider()
        .strokeWidth(DIVIDER)
        .color($r('app.color.divider'))
      this.SourceList()
      this.AddButton()
      Divider()
        .strokeWidth(DIVIDER)
        .color($r('app.color.divider'))
      this.AttemptsRow()
      Divider()
        .strokeWidth(DIVIDER)
        .color($r('app.color.divider'))
      this.DiagnosticsBlock()
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }
}
