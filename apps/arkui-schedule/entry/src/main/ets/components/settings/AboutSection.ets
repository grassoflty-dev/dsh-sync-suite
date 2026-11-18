/**
 * 设置页「关于」section（版本 / 上次同步 / 平台信息 / 隐私 `?` / 深色模式三态）。
 *
 * A2 拆分：内容从 `pages/Settings.ets` 的 `ThemeRow()` + `AboutGroup()` 逐字搬出。页面持有
 * 全部 `@State`（含 `themeMode`），这里只收**单向 props + 回调**，本组件不写任何状态。
 *
 * 契约：
 * - 版本号 / 上次同步「时间 + 动作 + 成败」都从页面状态派生（`describeLastSyncOutcome` 纯函数）；
 * - 深色模式是**三态片**（跟随系统 / 浅色 / 深色）：点击立刻生效并落盘（页面 `saveThemeMode`），
 *   不等底部「保存设置」；标签 `maxLines(1)` 可压、三态片只守 `minWidth` 不写死宽（大字号验收项）；
 * - 「隐私与凭据」的 `?` 打开页面的帮助弹层。
 */
import { DIVIDER, FONT, LINE_HEIGHT, RADIUS, SPACING, TOUCH_MIN } from '../../common/uiTokens';
import { describeLastSyncOutcome } from '../../model/syncError';
import { THEME_MODE_ORDER, themeModeLabel } from '../../model/theme';
import { nowIso } from '../../common/date';
import {
  ErrorText as ErrorTextBit,
  FieldLabel as FieldLabelBit,
  FieldNote as FieldNoteBit,
  HintLine as HintLineBit
} from './SettingsBits';

/** 展示用版本号：与 `AppScope/app.json5` 的 versionName 保持一致（改版本时两处同步）。 */
const APP_VERSION: string = '1.0.0';

/**
 * 深色模式三态片的最小宽度（vp）。
 *
 * 「跟随系统」四个字在 ×1.5 大字号下约 4 × 14 × 1.5 × 0.6 ≈ 50vp，加左右 padding 8×2 = 66；
 * 这里取 56 作**下限**、靠 `padding` 自然撑开（不给固定宽，避免大字号被裁——见
 * `docs/UI-DESIGN.md` §8 布局规则 ①）。
 */
const THEME_CHIP_MIN_WIDTH: number = 56;

@Component
export struct AboutSection {
  /** 上次同步成功时刻（ISO，空串=从未同步）。 */
  @Prop lastSyncAt: string = '';
  /** 上次同步失败的分级后中文文案（空串=上次没有失败）。 */
  @Prop lastSyncError: string = '';
  /** 上次同步动作：`pull` | `push` | `status`（空串=没有可重试的动作）。 */
  @Prop lastSyncAction: string = '';
  /** `${平台} · ${手写} · ${OCR}` 一行（页面 `platformLine()` 派生）。 */
  @Prop platformLine: string = '';
  /** 日程目录提示（页面写；空串 = 不显示）。 */
  @Prop storageHint: string = '';
  /** 深色模式三态（`system` | `light` | `dark`）。 */
  @Prop themeMode: string = 'system';

  /** 深色模式那行说明（跟随系统时补一句「系统当前为深/浅」，页面派生）。 */
  themeModeHintText: () => string = () => '';

  // ---------------------------------------------------------------- 回调（页面改状态）
  /** 点三态片的一档：立刻 setColorMode + 落盘。 */
  onPickTheme: (mode: string) => void = () => {};
  /** 打开「隐私与凭据」帮助弹层。 */
  onOpenPrivacy: () => void = () => {};

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

  /**
   * 深色模式行：标签 + 三态片 + 一行说明（唯一入口，紧凑/宽屏两套骨架共用）。
   *
   * 布局规则（大字号验收的「表单行」代表）：标签 `layoutWeight(1)` 可压 + `maxLines(1)` +
   * 省略号；三态片是**固定项**（`flexShrink(0)`），只守下限宽不写死宽。
   */
  @Builder
  ThemeRow() {
    Column({ space: SPACING.sm }) {
      Row({ space: SPACING.sm }) {
        Text('深色模式')
          .fontSize(FONT.body)
          .lineHeight(LINE_HEIGHT.body)
          .fontColor($r('app.color.text_primary'))
          .layoutWeight(1)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .textAlign(TextAlign.Start)

        Row({ space: SPACING.xs }) {
          ForEach(
            THEME_MODE_ORDER,
            (mode: string) => {
              Text(themeModeLabel(mode))
                .fontSize(FONT.caption)
                .lineHeight(LINE_HEIGHT.caption)
                .fontColor(
                  this.themeMode === mode ? $r('app.color.brand') : $r('app.color.text_secondary')
                )
                .constraintSize({ minWidth: THEME_CHIP_MIN_WIDTH })
                .height(TOUCH_MIN)
                .padding({ left: SPACING.sm, right: SPACING.sm })
                .textAlign(TextAlign.Center)
                .borderRadius(RADIUS.sm)
                .backgroundColor(
                  this.themeMode === mode ? $r('app.color.selection_fill') : $r('app.color.control_fill')
                )
                .border({
                  width: this.themeMode === mode ? DIVIDER : 0,
                  color: $r('app.color.selection_stroke')
                })
                .maxLines(1)
                .onClick(() => {
                  this.onPickTheme(mode);
                })
            },
            (mode: string) => `theme-${mode}`
          )
        }
        .flexShrink(0)
        .alignItems(VerticalAlign.Center)
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      Text(this.themeModeHintText())
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontColor($r('app.color.text_secondary'))
        .width('100%')
        .maxLines(2)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .textAlign(TextAlign.Start)
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  /** 关于组：版本+上次同步 / 平台信息 / 隐私? / 权限?。 */
  build() {
    Column({ space: SPACING.md }) {
      Text('关于')
        .fontSize(FONT.body)
        .lineHeight(LINE_HEIGHT.body)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('app.color.text_primary'))
        .width('100%')
        .textAlign(TextAlign.Start)

      Row({ space: SPACING.sm }) {
        Text('版本 v' + APP_VERSION)
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
        Blank()
        // A2：最近一次同步时间 + 动作 + 成败（失败原因是分级后的中文）
        Text(describeLastSyncOutcome(this.lastSyncAt, this.lastSyncError, this.lastSyncAction, nowIso()))
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }
      .width('100%')

      this.HintLine(this.platformLine)
      if (this.storageHint.length > 0) {
        this.HintLine(this.storageHint)
      }

      Row({ space: SPACING.sm }) {
        Text('隐私与凭据')
          .fontSize(FONT.body)
          .lineHeight(LINE_HEIGHT.body)
          .fontColor($r('app.color.text_primary'))
          .layoutWeight(1)
          .textAlign(TextAlign.Start)
        Text('?')
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.brand'))
          .width(TOUCH_MIN)
          .height(TOUCH_MIN)
          .textAlign(TextAlign.Center)
          .onClick(() => {
            this.onOpenPrivacy();
          })
      }
      .width('100%')
      .height(TOUCH_MIN)
      .alignItems(VerticalAlign.Center)

      Divider()
        .strokeWidth(DIVIDER)
        .color($r('app.color.divider'))

      this.ThemeRow()
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }
}
