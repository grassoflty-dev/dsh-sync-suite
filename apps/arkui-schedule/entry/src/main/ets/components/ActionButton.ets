/**
 * 全站唯一按钮（`docs/STATE-UI.md` §3）。
 *
 * 存在的唯一理由：ArkUI 的禁用修饰符（enabled 链式属性）会把 `onClick` 一起吞掉，用户点不动却不知道为什么。
 * 所以本组件**绝不使用禁用修饰符**：按钮永远可点，`onClick` 里先问 `model/actionButton.ts`
 * 的 `resolveButton()` 能不能执行——
 * - 可点：执行 `onTap`；
 * - 忙碌：忽略重复点击（标签已经是「处理中…」），不弹 toast（那是噪音）；
 * - 不可用：`promptAction.showToast()` 说出原因（`disabledReason` 为空时由 model 兜底
 *   「当前不可用，请稍后再试」），并且**不**执行 `onTap`。
 *
 * 视觉档位（`variant`）：`primary` 品牌底反白字 / `secondary` 控件灰底 / `ghost` 白底品牌字 /
 * `danger` 危险底反白字。不可用时：`primary` 背景降 `brand_soft`、文字 `brand`；
 * `secondary` / `ghost` 只降透明度；三档透明度 1 / 0.5（忙）/ 0.4（不可用）由 model 给。
 *
 * 为什么 `block` 写了两份 Builder：ArkUI 的属性链不能条件化（`.width()` 必须静态挂在某一次
 * 调用上），所以「撑满」与「内容宽」各一份；颜色/标签/透明度全部来自同一组私有方法，不会漂。
 */
import { promptAction } from '@kit.ArkUI';
import { toastMsFor } from '../common/copy';
import { FONT, RADIUS, SPACING, TOUCH_MIN } from '../common/uiTokens';
import { blockedTapText, resolveButton } from '../model/actionButton';
import type { ButtonState } from '../model/actionButton';

/** 视觉档位：主操作。 */
const VARIANT_PRIMARY: string = 'primary';

/** 视觉档位：次操作（灰底）。 */
const VARIANT_SECONDARY: string = 'secondary';

/** 视觉档位：文字链（白底品牌字，不给边框）。 */
const VARIANT_GHOST: string = 'ghost';

/** 视觉档位：危险操作（删除/清空）。 */
const VARIANT_DANGER: string = 'danger';

@Component
export struct ActionButton {
  /** 按钮文字（忙碌时组件自动加「…」）。 */
  @Prop label: string = '';
  /** 业务上是否可用；`false` 时仍可点，点击给出 `disabledReason`。 */
  @Prop enabled: boolean = true;
  /** 不可用原因（`enabled=false` 时显示；空则回落「当前不可用，请稍后再试」）。 */
  @Prop disabledReason: string = '';
  /** 是否忙碌（标签加「…」并忽略重复点击）。 */
  @Prop busy: boolean = false;
  /** 视觉档位：`'primary' | 'secondary' | 'ghost' | 'danger'`（未知值按 `primary` 渲染）。 */
  @Prop variant: string = VARIANT_PRIMARY;
  /** `true` = 撑满父容器（表单底部主操作 / 空态主按钮）。 */
  @Prop block: boolean = false;

  /** 可点时的业务回调（忙碌/不可用时不执行）。 */
  onTap: () => void = () => {};

  /** 不可用时的附加回调（埋点/提示增强用，可为 null；不替代 toast）。 */
  onBlockedTap: (() => void) | null = null;

  /** 解析后的按钮状态：唯一一处同时决定「能不能点 / 多透明 / 说什么」。 */
  private buttonState(): ButtonState {
    return resolveButton(this.enabled, this.busy, this.disabledReason);
  }

  /** 显示文案：忙碌时加「…」（已带省略号则不重复叠加）。 */
  private displayLabel(): string {
    if (this.busy !== true) {
      return this.label;
    }
    const base: string = this.label.endsWith('…') ? this.label.slice(0, this.label.length - 1) : this.label;
    return `${base}…`;
  }

  /** 背景色：`primary` 不可用时降 `brand_soft`（视觉上必须明显不同）；忙碌保持本色靠透明度区分。 */
  private background(): Resource {
    if (this.variant === VARIANT_SECONDARY) {
      return $r('app.color.control_fill');
    }
    if (this.variant === VARIANT_DANGER) {
      return $r('app.color.danger');
    }
    if (this.variant === VARIANT_GHOST) {
      return $r('app.color.surface');
    }
    return this.enabled ? $r('app.color.brand') : $r('app.color.brand_soft');
  }

  /** 文字色：与背景配对（品牌底/危险底用反白字；`brand_soft` 底用 `brand`）。 */
  private fontColor(): Resource {
    if (this.variant === VARIANT_SECONDARY) {
      return $r('app.color.text_primary');
    }
    if (this.variant === VARIANT_DANGER) {
      return $r('app.color.text_inverse');
    }
    if (this.variant === VARIANT_GHOST) {
      return $r('app.color.brand');
    }
    return this.enabled ? $r('app.color.text_inverse') : $r('app.color.brand');
  }

  /** 点击统一入口：先判状态，再决定「执行 / 忽略 / 说原因」。 */
  private handleClick(): void {
    const state: ButtonState = this.buttonState();
    if (state.busy === true) {
      return;
    }
    if (state.tappable !== true) {
      const message: string = blockedTapText(state);
      if (message.length > 0) {
        promptAction.showToast({ message: message, duration: toastMsFor(true) });
      }
      const blocked: (() => void) | null = this.onBlockedTap;
      if (blocked !== null) {
        blocked();
      }
      return;
    }
    this.onTap();
  }

  // ------------------------------------------------------------------ UI

  /** 内容宽按钮（表格行内、弹层按钮行）。 */
  @Builder
  InlineButton() {
    Button(this.displayLabel())
      .height(TOUCH_MIN)
      .fontSize(FONT.body)
      .fontColor(this.fontColor())
      .backgroundColor(this.background())
      .borderRadius(RADIUS.sm)
      .padding({ left: SPACING.lg, right: SPACING.lg })
      .opacity(this.buttonState().opacity)
      .onClick(() => this.handleClick())
  }

  /** 撑满按钮（表单底部主操作、空态主按钮）。 */
  @Builder
  BlockButton() {
    Row() {
      Button(this.displayLabel())
        .height(TOUCH_MIN)
        .fontSize(FONT.body)
        .fontColor(this.fontColor())
        .backgroundColor(this.background())
        .borderRadius(RADIUS.sm)
        .padding({ left: SPACING.lg, right: SPACING.lg })
        .opacity(this.buttonState().opacity)
        .width('100%')
        .onClick(() => this.handleClick())
    }
    .width('100%')
    .justifyContent(FlexAlign.Center)
  }

  build() {
    if (this.block) {
      this.BlockButton()
    } else {
      this.InlineButton()
    }
  }
}
