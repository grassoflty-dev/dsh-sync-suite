/**
 * mod-remote-command-wire（RC-4 接线）：单次确认闸在远程控制页上的**真实界面**。
 *
 * 本组件是「有且只有一个按钮、且永久禁用」的草稿编辑器：
 * - 目标 / 工具 / 正文都可见，勾选「确认发送」只是把当前草稿指纹记下来，
 *   改动正文或目标会立刻作废这次确认（见 `model/remoteCommandDraft.ts`）；
 * - 禁用原因不是手写文案：`refreshReason()` 逐字取冻结闸门 `decideCommandSend()` 返回的
 *   `wording`，同一个字符串既传给 ActionButton 的 `disabledReason`，也作为可见 `Text` 渲染，
 *   用户不点任何东西就能读到为什么发不了；
 * - 没有投递通道：今天 `sessionPrompt` RPC 不存在、RC-3 真机门禁未跑，`REMOTE_CHANNEL_VERIFIED`
 *   恒为 false，所以按钮永远禁用，界面上没有任何在途态或成功态。
 *
 * 零网络、零日志、零凭据：不发请求、不加载网页、不碰令牌、不调用日志 API。
 */

import { COMMAND_TEXT_LIMIT } from '../model/remoteCommandGate';
import {
  COMMAND_TOOL,
  changeTarget,
  changeText,
  composerReason,
  setConfirmed
} from '../model/remoteCommandDraft';
import type { ComposerState } from '../model/remoteCommandDraft';
import { DIVIDER, FONT, LINE_HEIGHT, RADIUS, SPACING, TOUCH_MIN } from '../common/uiTokens';
import { ActionButton } from './ActionButton';

/** 工具标签前缀：值只来自 COMMAND_TOOL，组件不写第二份工具名。 */
const TOOL_PREFIX: string = '工具：';

/** 目标标签前缀。 */
const TARGET_PREFIX: string = '目标：';

/** 确认勾选框的无障碍名（不是理由文案）。 */
const CONFIRM_NAME: string = 'remote-command-confirm';

@Component
export struct RemoteCommandComposer {
  /** 目标实例 id（由页面从当前地址派生，见 `RemoteControl.targetInstanceId()`）。 */
  @Prop @Watch('onTargetChanged') instanceId: string = '';
  /** 目标展示名（只在预览里用；不参与指纹）。 */
  @Prop @Watch('onTargetChanged') instanceName: string = '';
  /** 是否显式授予了 session.prompt（view 权不算）。 */
  @Prop @Watch('onGrantChanged') commandGranted: boolean = false;

  @State text: string = '';
  @State confirmed: boolean = false;
  @State confirmedFingerprint: string = '';
  /** 闸门给出的逐字文案；空串 = 闸门通过（今天不可达）。 */
  @State reason: string = '';

  aboutToAppear(): void {
    // 首次渲染就要有原因（不能等用户点按钮才弹 toast）。
    this.refreshReason();
  }

  /** 由 primitives 派生具名状态对象（ArkTS 不做跨具名接口的结构化赋值）。 */
  private currentState(): ComposerState {
    const state: ComposerState = {
      instanceId: this.instanceId,
      instanceName: this.instanceName,
      tool: COMMAND_TOOL,
      text: this.text,
      confirmed: this.confirmed,
      confirmedFingerprint: this.confirmedFingerprint
    };
    return state;
  }

  /** 把纯函数结果写回本地 @State；目标 / 工具来自 props，不在这里改。 */
  private applyState(state: ComposerState): void {
    this.text = state.text;
    this.confirmed = state.confirmed;
    this.confirmedFingerprint = state.confirmedFingerprint;
  }

  /** 唯一的理由刷新入口：文案只来自闸门返回的 wording。 */
  private refreshReason(): void {
    this.reason = composerReason(this.currentState(), this.commandGranted);
  }

  private onTargetChanged(): void {
    this.applyState(changeTarget(this.currentState(), this.instanceId, this.instanceName));
    this.refreshReason();
  }

  private onGrantChanged(): void {
    this.refreshReason();
  }

  private onTextChange(value: string): void {
    this.applyState(changeText(this.currentState(), value));
    this.refreshReason();
  }

  private onConfirmChange(value: boolean): void {
    this.applyState(setConfirmed(this.currentState(), value));
    this.refreshReason();
  }

  /** 目标行：父页面已经把「名字缺失则退回 id」算好；这里只兜住父页面传空的情况。 */
  private targetLabel(): string {
    const name: string = this.instanceName.trim();
    if (name.length > 0) {
      return name;
    }
    return this.instanceId;
  }

  build() {
    Column({ space: SPACING.sm }) {
      Text('发指令到这台电脑')
        .fontSize(FONT.title)
        .lineHeight(LINE_HEIGHT.title)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('app.color.text_primary'))
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })

      Text(`${TARGET_PREFIX}${this.targetLabel()}`)
        .fontSize(FONT.body)
        .lineHeight(LINE_HEIGHT.body)
        .fontColor($r('app.color.text_primary'))
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })

      Text(`${TOOL_PREFIX}${COMMAND_TOOL}`)
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontColor($r('app.color.text_secondary'))

      TextArea({ text: this.text, placeholder: '输入要发送给这台电脑的指令' })
        .width('100%')
        .height(SPACING.xl * 4)
        .fontSize(FONT.body)
        .fontColor($r('app.color.text_primary'))
        .backgroundColor($r('app.color.field_fill'))
        .borderRadius(RADIUS.sm)
        .padding(SPACING.sm)
        .maxLength(COMMAND_TEXT_LIMIT)
        .onChange((value: string) => {
          this.onTextChange(value);
        })

      Text(`${this.text.length}/${COMMAND_TEXT_LIMIT}`)
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontColor($r('app.color.text_secondary'))
        .width('100%')
        .textAlign(TextAlign.End)

      Row({ space: SPACING.sm }) {
        Checkbox({ name: CONFIRM_NAME })
          .select(this.confirmed)
          .selectedColor($r('app.color.brand'))
          .width(TOUCH_MIN)
          .height(TOUCH_MIN)
          .onChange((value: boolean) => {
            this.onConfirmChange(value);
          })
        Text('确认发送')
          .fontSize(FONT.body)
          .lineHeight(LINE_HEIGHT.body)
          .fontColor($r('app.color.text_primary'))
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      Divider()
        .strokeWidth(DIVIDER)
        .color($r('app.color.divider'))

      // 永久禁用：actionEnabled 恒 false；无投递通道，onTap 永远不会被业务执行。
      // D1 真机收口：默认 disabledReason + opacity 0.4 仍让按钮 enabled:"true" / clickable:"true"，
      // 因此这里显式打开 additive hardDisabled —— 渲染层 .enabled(false)、handleClick 早退，
      // 用户点不到；同一句原因仍由下面的可见 Text 常驻呈现，不需要先点一下才知道为什么。
      ActionButton({
        label: '发送指令',
        actionEnabled: false,
        disabledReason: this.reason,
        busy: false,
        variant: 'secondary',
        block: true,
        hardDisabled: true,
        onTap: (): void => {},
        onBlockedTap: null
      })

      // 同一句闸门文案必须是可见 Text；用户不点按钮也不需要「猜为什么不能发」。
      if (this.reason.length > 0) {
        Text(this.reason)
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
          .width('100%')
          .maxLines(3)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }
    }
    .width('100%')
    .padding(SPACING.md)
    .backgroundColor($r('app.color.surface'))
    .borderRadius(RADIUS.sm)
    .alignItems(HorizontalAlign.Start)
  }
}
