/**
 * 设置页「远程控制」section。
 *
 * A2 拆分：内容从 `pages/Settings.ets` 的 `RemoteGroup()` 逐字搬出。页面持有全部 `@State`，
 * 这里只收**单向 props + 回调**（`@Prop` 值 + `onXxx`），本组件不写任何状态。
 *
 * 契约：
 * - 「访问方式」六选一（顺序 = `REMOTE_MODE_ORDER`，`uu` 排末尾并标「不可用」）；
 * - 方式元数据（文案 / 字段 / 可用性 / 前置条件）全部来自 `model/remoteAccess.ts`，页面把
 *   派生方法以函数 props 传入，本组件不另写一套解释；
 * - 「访问令牌（可选）」只出现在 `lan` / `ipv6` / `tailscale`（判据来自方式的 `fields` 表）：
 *   输入框只存"这次想改成的值"，已保存的令牌**只打码显示、永不回填**；
 * - 「DSH 地址」那一行既是最终链接的预览（自动拼），也是 `manual` 方式的手输框；
 * - 空地址时「打开远程控制」不可用（`ActionButton` 的 `enabled` + `disabledReason`：点不动就
 *   toast 出原因），按钮**下方**同样保留「先填写电脑上的 DSH 地址」；
 * - 「一键重连」按钮放在「打开远程控制」**之上**、仅当 `reconnectText` 文案非空时才出现；
 *   文案由页面从最近成功记录派生，只到 host:port，**绝不含令牌**；
 * - 「清除令牌」是 `ActionButton` 的 ghost 档（不是裸 Text 当按钮）。
 */
import { ActionButton } from '../ActionButton';
import { DIVIDER, FONT, LINE_HEIGHT, RADIUS, SPACING, TOUCH_MIN } from '../../common/uiTokens';
import {
  REMOTE_MODE_CLOUDFLARE,
  REMOTE_MODE_IPV6,
  REMOTE_MODE_LAN,
  REMOTE_MODE_MANUAL,
  REMOTE_MODE_TAILSCALE,
  REMOTE_MODES
} from '../../model/remoteAccess';
import type { RemoteModeSpec } from '../../model/remoteAccess';
import {
  ErrorText as ErrorTextBit,
  FieldLabel as FieldLabelBit,
  FieldNote as FieldNoteBit,
  HintLine as HintLineBit
} from './SettingsBits';

@Component
export struct RemoteSection {
  /** 远程访问方式（`lan`/`tailscale`/`ipv6`/`cloudflare`/`manual`/`uu`）。 */
  @Prop remoteMode: string = REMOTE_MODE_LAN;
  /** 局域网方式要填的具体 IPv4。 */
  @Prop remoteLanAddress: string = '';
  /** 端口输入框的原始文本（`InputType.Number` 仍按文本回调；空串/非法 → 0 = 跟 DSH 同端口）。 */
  @Prop remotePortText: string = '0';
  /** Tailscale 方式要填的 100.x 地址或 MagicDNS 名。 */
  @Prop remoteTailscaleHost: string = '';
  /** Cloudflare 隧道域名（不带 https://、不带路径）。 */
  @Prop remoteCloudflareHost: string = '';
  /** 公网 IPv6 地址（不带方括号；拼地址时由 `buildRemoteAccessUrl` 补 `[ ]`）。 */
  @Prop remoteIpv6Address: string = '';
  /** 手动方式的完整地址（与「DSH 地址」那一行共用同一份值）。 */
  @Prop remoteManualUrl: string = '';
  /** 「访问令牌（可选）」的输入框值（只写通道；留空 = 不改，沿用已保存的）。 */
  @Prop remoteToken: string = '';
  /** 最终要打开的地址（也可能是用户手输的那一行）。 */
  @Prop remoteUrl: string = '';
  @Prop remoteUrlError: string = '';
  /** 一键重连按钮文案：非空才出按钮；文案由页面派生（只到 host:port），不含令牌。 */
  @Prop reconnectText: string = '';

  // ---------------------------------------------------------------- 页面只读派生（函数 props）
  /** 当时「访问方式」的元数据（页面读 `REMOTE_MODES`，未知/空回落 `lan`）。 */
  remoteSpec: () => RemoteModeSpec = () => REMOTE_MODES[REMOTE_MODE_LAN];
  /** 当前方式在下拉框里的下标。 */
  remoteModeIndex: () => number = () => 0;
  /** 下拉框第 index 项的文案（`unsupported` 项标「不可用」）。 */
  remoteModeOptionLabel: (index: number) => string = () => '';
  /** 某方式字段的标签 / 占位符 / 提示（都来自 `REMOTE_MODES.fields`）。 */
  remoteFieldLabel: (key: string) => string = () => '';
  remoteFieldPlaceholder: (key: string) => string = () => '';
  remoteFieldHint: (key: string) => string = () => '';
  /** 方式可用性提示（unsupported 给原因、needs-setup 给第一条前置条件）。 */
  remoteAvailabilityHint: () => string = () => '';
  /** 当前方式有没有「访问令牌（可选）」字段。 */
  remoteUsesToken: () => boolean = () => false;
  /** 令牌状态小字（「保存后生效」/「已保存访问令牌（打码）」）。 */
  remoteTokenStatus: () => string = () => '';
  /** 是否已保存访问令牌（决定「清除令牌」是否显示）。 */
  hasSavedRemoteToken: () => boolean = () => false;
  /** 「地址未包含 token」的橙色次要提示（空串 = 不显示）。 */
  remoteTokenHint: () => string = () => '';

  // ---------------------------------------------------------------- 回调（页面改状态）
  /** 选访问方式（下标 → 页面归一成枚举值，并重算预览）。 */
  onSelectMode: (index: number) => void = () => {};
  onChangeLanAddress: (value: string) => void = () => {};
  onChangeIpv6Address: (value: string) => void = () => {};
  onChangeTailscaleHost: (value: string) => void = () => {};
  onChangeCloudflareHost: (value: string) => void = () => {};
  onChangePort: (value: string) => void = () => {};
  onChangeRemoteToken: (value: string) => void = () => {};
  /** 「DSH 地址」那一行（手动方式下同时同步到手输框）。 */
  onChangeRemoteUrl: (value: string) => void = () => {};
  /** 「DSH 地址」失焦即归一（D1 的 P2；只改输入框文本 + 一次性 toast，不落盘不跳转）。 */
  onBlurRemoteUrl: () => void = () => {};
  /** 「清除令牌」：立刻落盘空串。 */
  onClearToken: () => void = () => {};
  /** 「打开远程控制」：拼地址 → 归一 → 落盘 → 跳内嵌页。 */
  onOpenRemote: () => void = () => {};
  /** 「一键重连」：照最近一次成功的地址原路重开（不重新推导方式字段）。 */
  onReconnect: () => void = () => {};

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
   * 远程控制组：访问方式（六选一）+ 该方式的字段 + 最终「DSH 地址」+ 打开按钮。
   *
   * 方式元数据（文案 / 字段 / 可用性 / 前置条件）全部来自 `model/remoteAccess.ts`，
   * 与插件侧 `src/remote/accessMode.ts` 是同一份语义——页面只负责画，不另写一套解释。
   */
  build() {
    Column({ space: SPACING.md }) {
      Text('远程控制')
        .fontSize(FONT.body)
        .lineHeight(LINE_HEIGHT.body)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('app.color.text_primary'))
        .width('100%')
        .textAlign(TextAlign.Start)

      // 访问方式：6 项（顺序 = REMOTE_MODE_ORDER，uu 排末尾并标「不可用」）
      this.FieldLabel('访问方式')
      Select([
        { value: this.remoteModeOptionLabel(0) },
        { value: this.remoteModeOptionLabel(1) },
        { value: this.remoteModeOptionLabel(2) },
        { value: this.remoteModeOptionLabel(3) },
        { value: this.remoteModeOptionLabel(4) },
        { value: this.remoteModeOptionLabel(5) }
      ])
        .selected(this.remoteModeIndex())
        .value(this.remoteSpec().label)
        .font({ size: FONT.body })
        .optionFont({ size: FONT.body })
        .selectedOptionFont({ size: FONT.body })
        .width('100%')
        .height(TOUCH_MIN + SPACING.xs)
        .onSelect((index: number) => {
          this.onSelectMode(index);
        })
      Divider()
        .strokeWidth(DIVIDER)
        .color($r('app.color.divider'))

      // 一句话说明 + 可用性（unsupported 显示原因、needs-setup 显示第一条前置条件）
      Text(this.remoteSpec().description)
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontColor($r('app.color.text_secondary'))
        .width('100%')
        .textAlign(TextAlign.Start)
      if (this.remoteAvailabilityHint().length > 0) {
        Text(this.remoteAvailabilityHint())
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
          .width('100%')
          .textAlign(TextAlign.Start)
      }

      // ---- 各方式的字段（标签/占位符/提示都取自 REMOTE_MODES.fields）----
      if (this.remoteMode === REMOTE_MODE_LAN) {
        this.FieldLabel(this.remoteFieldLabel('lanAddress'))
        TextInput({ text: this.remoteLanAddress, placeholder: this.remoteFieldPlaceholder('lanAddress') })
          .width('100%')
          .height(TOUCH_MIN + SPACING.xs)
          .fontSize(FONT.body)
          .backgroundColor($r('app.color.page_background'))
          .borderRadius(RADIUS.none)
          .padding({ left: 0, right: 0 })
          .onChange((value: string) => {
            this.onChangeLanAddress(value);
          })
        Divider()
          .strokeWidth(DIVIDER)
          .color($r('app.color.divider'))
        this.HintLine(this.remoteFieldHint('lanAddress'))
      }

      if (this.remoteMode === REMOTE_MODE_IPV6) {
        this.FieldLabel(this.remoteFieldLabel('ipv6Address'))
        TextInput({ text: this.remoteIpv6Address, placeholder: this.remoteFieldPlaceholder('ipv6Address') })
          .width('100%')
          .height(TOUCH_MIN + SPACING.xs)
          .fontSize(FONT.body)
          .backgroundColor($r('app.color.page_background'))
          .borderRadius(RADIUS.none)
          .padding({ left: 0, right: 0 })
          .onChange((value: string) => {
            this.onChangeIpv6Address(value);
          })
        Divider()
          .strokeWidth(DIVIDER)
          .color($r('app.color.divider'))
        this.HintLine(this.remoteFieldHint('ipv6Address'))
      }

      if (this.remoteMode === REMOTE_MODE_TAILSCALE) {
        this.FieldLabel(this.remoteFieldLabel('tailscaleHost'))
        TextInput({ text: this.remoteTailscaleHost, placeholder: this.remoteFieldPlaceholder('tailscaleHost') })
          .width('100%')
          .height(TOUCH_MIN + SPACING.xs)
          .fontSize(FONT.body)
          .backgroundColor($r('app.color.page_background'))
          .borderRadius(RADIUS.none)
          .padding({ left: 0, right: 0 })
          .onChange((value: string) => {
            this.onChangeTailscaleHost(value);
          })
        Divider()
          .strokeWidth(DIVIDER)
          .color($r('app.color.divider'))
        this.HintLine(this.remoteFieldHint('tailscaleHost'))
      }

      if (this.remoteMode === REMOTE_MODE_CLOUDFLARE) {
        this.FieldLabel(this.remoteFieldLabel('cloudflareHost'))
        TextInput({ text: this.remoteCloudflareHost, placeholder: this.remoteFieldPlaceholder('cloudflareHost') })
          .width('100%')
          .height(TOUCH_MIN + SPACING.xs)
          .fontSize(FONT.body)
          .backgroundColor($r('app.color.page_background'))
          .borderRadius(RADIUS.none)
          .padding({ left: 0, right: 0 })
          .onChange((value: string) => {
            this.onChangeCloudflareHost(value);
          })
        Divider()
          .strokeWidth(DIVIDER)
          .color($r('app.color.divider'))
        this.HintLine(this.remoteFieldHint('cloudflareHost'))
      }

      // 端口：只有要起监听的方式才填（cloudflare 对外恒 443，manual 由地址自带端口）
      if (
        this.remoteMode === REMOTE_MODE_LAN ||
        this.remoteMode === REMOTE_MODE_IPV6 ||
        this.remoteMode === REMOTE_MODE_TAILSCALE
      ) {
        this.FieldLabel(this.remoteFieldLabel('port'))
        TextInput({ text: this.remotePortText, placeholder: this.remoteFieldPlaceholder('port') })
          // 纯数字键盘；ArkTS 里输入类型写在属性上（`.type(InputType.Number)`），
          // 等价于给输入框声明 inputType=Number。
          .type(InputType.Number)
          .width('100%')
          .height(TOUCH_MIN + SPACING.xs)
          .fontSize(FONT.body)
          .backgroundColor($r('app.color.page_background'))
          .borderRadius(RADIUS.none)
          .padding({ left: 0, right: 0 })
          .onChange((value: string) => {
            this.onChangePort(value);
          })
        Divider()
          .strokeWidth(DIVIDER)
          .color($r('app.color.divider'))
        this.HintLine(this.remoteFieldHint('port'))
      }

      // 「访问令牌（可选）」：只出现在 lan / ipv6 / tailscale 的字段表里（端口之后）。
      // 密码框里**只**是"用户这次想改成的值"（`remoteToken`）；已保存的令牌不回填，
      // 只用打码小字说明"已保存"，这样旁边有人看屏幕也看不到明文。
      if (this.remoteUsesToken()) {
        this.FieldLabel(this.remoteFieldLabel('token'))
        TextInput({ text: this.remoteToken, placeholder: this.remoteFieldPlaceholder('token') })
          .type(InputType.Password)
          .width('100%')
          .height(TOUCH_MIN + SPACING.xs)
          .fontSize(FONT.body)
          .backgroundColor($r('app.color.page_background'))
          .borderRadius(RADIUS.none)
          .padding({ left: 0, right: 0 })
          .onChange((value: string) => {
            this.onChangeRemoteToken(value);
          })
        Divider()
          .strokeWidth(DIVIDER)
          .color($r('app.color.divider'))
        this.HintLine(this.remoteFieldHint('token'))
        if (this.remoteTokenStatus().length > 0) {
          Text(this.remoteTokenStatus())
            .fontSize(FONT.caption)
            .lineHeight(LINE_HEIGHT.caption)
            .fontColor($r('app.color.text_secondary'))
            .width('100%')
            .textAlign(TextAlign.Start)
        }
        if (this.hasSavedRemoteToken()) {
          ActionButton({
            label: '清除令牌',
            enabled: true,
            disabledReason: '',
            busy: false,
            variant: 'ghost',
            block: false,
            onTap: (): void => {
              this.onClearToken();
            },
            onBlockedTap: null
          })
        }
      }

      if (this.remoteMode === REMOTE_MODE_MANUAL) {
        // 手动方式的「完整地址」就是下面「DSH 地址」那一行（同一个值，不画两个输入框）
        this.FieldLabel(this.remoteFieldLabel('manualUrl'))
      } else {
        this.FieldLabel('DSH 地址')
      }
      TextInput({ text: this.remoteUrl, placeholder: 'http://192.168.1.6:3080/?token=…' })
        .width('100%')
        .height(TOUCH_MIN + SPACING.xs)
        .fontSize(FONT.body)
        .backgroundColor($r('app.color.page_background'))
        .borderRadius(RADIUS.none)
        .padding({ left: 0, right: 0 })
        .onChange((value: string) => {
          this.onChangeRemoteUrl(value);
        })
        .onBlur(() => {
          this.onBlurRemoteUrl();
        })
      Divider()
        .strokeWidth(DIVIDER)
        .color($r('app.color.divider'))
      if (this.remoteUrlError.length > 0) {
        this.ErrorText(this.remoteUrlError)
      } else {
        this.HintLine('平板需与电脑在同一局域网；地址含 token，只存本机')
      }

      // 缺 token：橙色次要提示（不是错误，DSH 仍可能直接可用）
      if (this.remoteTokenHint().length > 0) {
        Text(this.remoteTokenHint())
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.warning'))
          .width('100%')
          .textAlign(TextAlign.Start)
      }

      // 一键重连：只有文案非空（有可用的最近成功记录）时才出现，且放在主按钮之上
      if (this.reconnectText.length > 0) {
        ActionButton({
          label: this.reconnectText,
          enabled: true,
          disabledReason: '',
          busy: false,
          variant: 'secondary',
          block: true,
          onTap: (): void => {
            this.onReconnect();
          },
          onBlockedTap: null
        })
      }

      ActionButton({
        label: '打开远程控制',
        enabled: this.remoteUrl.trim().length > 0,
        disabledReason: '先填写电脑上的 DSH 地址',
        busy: false,
        variant: 'primary',
        block: true,
        onTap: (): void => {
          this.onOpenRemote();
        },
        onBlockedTap: null
      })
      if (this.remoteUrl.trim().length === 0) {
        Text('先填写电脑上的 DSH 地址')
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
          .width('100%')
          .textAlign(TextAlign.Start)
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }
}
