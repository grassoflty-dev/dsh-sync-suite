/**
 * 设置页「同步（Git）」section。
 *
 * A2 拆分：内容从 `pages/Settings.ets` 的 `SyncHeader()` / `SyncAdvancedFields()` / `SyncGroup()`
 * 逐字搬出。页面持有全部 `@State`，这里只收**单向 props + 回调**（`@Prop` 值 + `onXxx`），
 * 本组件不写任何状态 —— 刷新语义因此与拆分前一致：父页面值变了才重绘，重绘时读到的
 * 就是最新值（`pushBlockedReason()` 之类的只读派生方法由父页面以函数 props 传入）。
 *
 * 契约（与拆分前逐条对齐，改动前先读 `docs/UI-DESIGN.md`）：
 * - 主表单只有「仓库地址 / 访问令牌」两个控件，地址下固定一行说明
 *   「平台按地址自动识别 · 分支固定 main」；平台随地址推断、分支恒为 main，无选择控件；
 * - Git 用户名 / 设备标识 / 作者名在「高级 ▸」折叠区里，**默认收起**（三种情况由页面自动展开）；
 * - 设备标识重复是**常驻** warning（不是 toast），附件被暂停推送同样常驻一行；
 * - 「立即同步」（= pull）与「推送」是组内两个主按钮，查看状态 / 重试 / 测试连接
 *   在组头「更多」弹层里（弹层仍在页面，见 `pages/Settings.ets`）；已保存的认证方式是 SSH 时
 *   本组件给一行只读警告 + 一个显式「改用 HTTPS 令牌」按钮（不是认证方式选择器；只切状态、
 *   不自动保存，落盘仍由用户点「保存设置」完成）；
 * - 隐藏的 Git 运行环境（1x1 全透明 Web）必须挂在本组内（`controller` 与页面是**同一个实例**，
 *   所以是普通成员而不是 `@Prop`：`@Prop` 会深拷贝，代理就注册到副本上了）。
 *
 * A 批（`docs/STATE-UI.md` §4/§5）：
 * - 两个主按钮与三处文字入口统一换成 `ActionButton`（禁用也**可点**，点了给具体中文原因）；
 * - 同步中 → `LoadingState`（>3s 出现「取消」，回调走 `runAction('cancel-wait')`，**不假装成功**）；
 * - 没填仓库地址 → `EmptyState`（「去填仓库地址」），只占状态行位置，**不藏表单**；
 * - `lastSyncError` 非空 → `ErrorState`（三段式 + 诊断四要素 + 重试）。
 */
import { webview } from '@kit.ArkWeb';
import { loadingText } from '../../common/copy';
import { APP_VERSION } from '../../common/version';
import { DIVIDER, FONT, LINE_HEIGHT, RADIUS, SPACING, TOUCH_MIN } from '../../common/uiTokens';
import { AUTH_HTTPS, AUTH_SSH } from '../../model/settingsForm';
import { canRetrySync, classifySyncError, redactSecrets } from '../../model/syncError';
import { formatDiagnostics } from '../../model/stateView';
import type { DiagnosticsInput } from '../../model/stateView';
import { repoUrlPlaceholderFor } from '../../model/gitAuth';
import { tokenPlaceholderFor } from '../../model/gitAuth';
import { ActionButton } from '../ActionButton';
import { EmptyState } from '../state/EmptyState';
import { ErrorState } from '../state/ErrorState';
import { LoadingState } from '../state/LoadingState';
import {
  ErrorText as ErrorTextBit,
  FieldLabel as FieldLabelBit,
  FieldNote as FieldNoteBit,
  HintLine as HintLineBit
} from './SettingsBits';

/** 同步内核（隐藏 Web）没就绪时的禁用原因（两个主按钮共用一句，避免各写一份）。 */
const KERNEL_NOT_READY: string = '同步内核还没就绪，稍等或点重试';

/** 上一次同步还没收尾时两个主按钮的原因。 */
const PREVIOUS_SYNC_RUNNING: string = '上一次同步还没结束';

/** 空态的标题 / 说明 / 动作（未配置仓库时占住「状态行」的位置）。 */
const EMPTY_SYNC_TITLE: string = '还没有配置同步仓库';
const EMPTY_SYNC_DETAIL: string = '填好仓库地址和 token 后，这里会显示同步状态';
const EMPTY_SYNC_ACTION: string = '去填仓库地址';

/** 错误态的三段式标题与两条「下一步」（可重试 / 只能先改配置）。 */
const SYNC_ERROR_WHAT: string = '同步失败';
const SYNC_ERROR_NEXT_RETRY: string = '点重试重新拉取；仍失败就到设置页检查仓库地址与 token';
const SYNC_ERROR_NEXT_FIX: string = '先按上面的原因修正，再重试';

/** 仓库地址下的固定说明：平台随地址推断、分支固定 main（本页没有平台/分支选择控件）。 */
const SYNC_CAPTION: string = '平台按地址自动识别 · 分支固定 main';

/** 已保存的认证方式是 SSH 时的只读提示（同一行还有一个显式切换按钮，不自动迁移）。 */
const SSH_STORED_WARNING: string = '当前保存的是 SSH 方式；本页只提供 HTTPS + 令牌，建议改成 HTTPS 地址后保存';

@Component
export struct SyncSection {
  /** 托管平台（`github` / `gitee` / `gitlab` / `custom`）：由地址自动推断，只影响占位符与示例文案。 */
  @Prop gitPlatform: string = '';
  /** 认证方式：`https` / `ssh`（已保存的 SSH 只显示只读警告，本页不提供选择器）。 */
  @Prop authMode: string = AUTH_HTTPS;

  // ---------------------------------------------------------------- 主表单（两个控件）
  @Prop repoUrl: string = '';
  @Prop repoUrlError: string = '';
  @Prop token: string = '';
  @Prop tokenError: string = '';

  // ---------------------------------------------------------------- 「高级」折叠区
  @Prop syncAdvancedOpen: boolean = false;
  @Prop syncAdvancedReason: string = '';
  @Prop gitUsername: string = '';
  @Prop gitUsernameError: string = '';
  @Prop deviceId: string = '';
  @Prop deviceIdError: string = '';
  /** 设备编号的只读一行（`本机：device-2（自动分配）`；空串 = 还没登记，不占行）。 */
  @Prop deviceIdNotice: string = '';
  @Prop author: string = '';
  @Prop authorError: string = '';

  // ---------------------------------------------------------------- 常驻状态
  /** 设备标识重复的常驻警告（空串 = 正常）。 */
  @Prop identityWarning: string = '';
  /** 本次推送被暂停的附件说明（空串 = 没有暂停）。 */
  @Prop attachmentWarning: string = '';
  @Prop syncMessage: string = '';
  @Prop syncBusy: boolean = false;
  @Prop webReady: boolean = false;
  @Prop statusLine: string = '';
  /** `describePushReadiness(statusView())` 的结果（页面派生，空串 = 不显示）。 */
  @Prop statusReadiness: string = '';
  @Prop lastSyncError: string = '';
  /** 上一次同步的动作（`pull` / `push` / `status`；空串 = 还没同步过）——错误态判断「能不能重试」用。 */
  @Prop lastSyncAction: string = '';
  @Prop saveHint: string = '';
  /** 保存校验的问题汇总：只用于决定 `saveHint` 用红字还是灰字。 */
  @Prop issuesSummary: string = '';
  /** 首页是否展示其他设备的只读记录。 */
  @Prop includeOtherDevices: boolean = false;

  // ---------------------------------------------------------------- 页面只读派生（函数 props）
  /** 推送按钮的阻塞原因（空串 = 可以推）：闭包读页面最新状态，调用点与拆分前一致。 */
  pushBlockedReason: () => string = () => '';
  /** 当前认证方式的阻塞原因（空串 = 可同步）。 */
  authBlocker: () => string = () => '';
  /** 用户名输入框占位文案（跟着平台变）。 */
  gitUsernamePlaceholder: () => string = () => '';
  /** 用户名下方的一行说明（无错误时显示）。 */
  gitUsernameHint: () => string = () => '';

  // ---------------------------------------------------------------- 回调（页面改状态）
  onChangeRepoUrl: (value: string) => void = () => {};
  onChangeToken: (value: string) => void = () => {};
  onChangeGitUsername: (value: string) => void = () => {};
  onChangeDeviceId: (value: string) => void = () => {};
  onChangeAuthor: (value: string) => void = () => {};
  /** 用户手动点「高级 ▸ / ▾」。 */
  toggleSyncAdvanced: () => void = () => {};
  /** 首页过滤开关（页面同时写 AppStorage）。 */
  onToggleIncludeOtherDevices: (isOn: boolean) => void = () => {};
  /** pull / push / status（与拆分前 `runAction(action)` 同一个入口）。 */
  runAction: (action: string) => void = () => {};
  /** 打开「更多」弹层（组头「更多」与状态行点击都走这里）。 */
  onOpenSyncMore: () => void = () => {};
  /** 打开仓库地址 `?` 帮助弹层。 */
  onOpenRepoHelp: () => void = () => {};
  /** SSH 警告行的显式出口：页面切 authMode + toast；本组件不改状态、不自动保存。 */
  onSwitchToHttpsToken: () => void = () => {};

  /**
   * 隐藏 Web 的控制器：与页面 `GitSyncService` 用的是**同一个实例**。
   *
   * 刻意不用 `@Prop`（`@Prop` 对对象做深拷贝，代理会注册到副本上、同步内核就白挂了）；
   * 普通成员由父组件在构造时传入，页面生命周期内不变，不需要观察。
   */
  gitController: webview.WebviewController = new webview.WebviewController();
  /** 隐藏 Web 的 `onPageEnd`（页面注册代理 / 置 webReady）。 */
  onWebReady: () => void = () => {};
  /** 隐藏 Web 加载失败（页面写 syncMessage 红字）。 */
  onWebError: () => void = () => {};

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

  /** 组标题 + 右侧「更多」入口。 */
  @Builder
  SyncHeader() {
    Row({ space: SPACING.sm }) {
      Text('同步（Git）')
        .fontSize(FONT.body)
        .lineHeight(LINE_HEIGHT.body)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('app.color.text_primary'))
        .layoutWeight(1)
        .textAlign(TextAlign.Start)
      ActionButton({
        label: '更多',
        actionEnabled: true,
        disabledReason: '',
        busy: false,
        variant: 'ghost',
        block: false,
        onTap: (): void => {
          this.onOpenSyncMore();
        },
        onBlockedTap: null
      })
    }
    .width('100%')
    .alignItems(VerticalAlign.Center)
  }

  /**
   * 同步组「高级」折叠区：Git 用户名 / 设备标识 / 作者名。
   *
   * 这三项都有安全的默认值（用户名按仓库地址推断、编号自动分配、作者名默认「我」），
   * 所以**默认收起**：用户要做的只有「填仓库地址 + token」。只有三种情况会自动展开
   * （页面 `openSyncAdvanced`）：① 设备标识重复 ② 编号分配失败 / 仓库不可读 ③ Gitee 用户名推不出来。
   */
  @Builder
  SyncAdvancedFields() {
    Column({ space: SPACING.md }) {
      // HTTPS 认证必须带用户名：GitHub 可留空（默认 x-access-token），Gitee 自动取仓库 owner
      if (this.authMode === AUTH_HTTPS) {
        this.FieldLabel('用户名（HTTPS 认证）')
        // 语义说明（用户最常见的困惑：GitHub 要不要填？Gitee 填什么？）
        this.FieldNote('HTTPS 认证用；GitHub 可留空（自动 x-access-token），Gitee 自动取仓库 owner')
        TextInput({ text: this.gitUsername, placeholder: this.gitUsernamePlaceholder() })
          .width('100%')
          .height(TOUCH_MIN + SPACING.xs)
          .fontSize(FONT.body)
          .backgroundColor($r('app.color.page_background'))
          .borderRadius(RADIUS.none)
          .padding({ left: 0, right: 0 })
          .onChange((value: string) => {
            this.onChangeGitUsername(value);
          })
        Divider()
          .strokeWidth(DIVIDER)
          .color($r('app.color.divider'))
        if (this.gitUsernameError.length > 0) {
          this.ErrorText(this.gitUsernameError)
        } else {
          this.HintLine(this.gitUsernameHint())
        }
      }

      // 设备标识：编号由仓库自动分配（`devices/registry.jsonl`），这里只是「手工指定」的逃生门
      this.FieldLabel('设备标识')
      this.FieldNote('自动分配；仅当你要手工指定时才改')
      TextInput({ text: this.deviceId, placeholder: '自动分配（例如 device-2）' })
        .width('100%')
        .height(TOUCH_MIN + SPACING.xs)
        .fontSize(FONT.body)
        .backgroundColor($r('app.color.page_background'))
        .borderRadius(RADIUS.none)
        .padding({ left: 0, right: 0 })
        .onChange((value: string) => {
          this.onChangeDeviceId(value);
        })
      Divider()
        .strokeWidth(DIVIDER)
        .color($r('app.color.divider'))
      if (this.deviceIdError.length > 0) {
        this.ErrorText(this.deviceIdError)
      } else if (this.deviceIdNotice.length > 0) {
        this.HintLine(this.deviceIdNotice)
      }

      // 作者名：只影响记录里的「谁记的」，与同步/认证无关
      this.FieldLabel('作者名')
      this.FieldNote('默认「我」，只影响记录里的"谁记的"')
      TextInput({ text: this.author, placeholder: '我' })
        .width('100%')
        .height(TOUCH_MIN + SPACING.xs)
        .fontSize(FONT.body)
        .backgroundColor($r('app.color.page_background'))
        .borderRadius(RADIUS.none)
        .padding({ left: 0, right: 0 })
        .onChange((value: string) => {
          this.onChangeAuthor(value);
        })
      Divider()
        .strokeWidth(DIVIDER)
        .color($r('app.color.divider'))
      if (this.authorError.length > 0) {
        this.ErrorText(this.authorError)
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  // ---------------------------------------------------------------- 三态判定 + 按钮可用性
  //
  // 这一组派生都放在组件里（只读 `@Prop` / 函数 props，不写状态、不发起动作）：
  // 按钮的 `enabled` 与 `disabledReason` 必须来自**同一个**判定，否则会出现
  // 「灰着但原因为空」或「原因在、按钮却能点」。

  /** 「立即同步」可点吗（与拆分前的条件逐字等价：不忙 + 内核就绪 + 认证可用）。 */
  private canPull(): boolean {
    return !this.syncBusy && this.webReady && this.authBlocker().length === 0;
  }

  /**
   * 「立即同步」不可用的具体原因（空串 = 可以点）。
   *
   * 优先级：内核未就绪 → 认证不可用（用页面给的原话）→ 上一次还没结束。
   */
  private pullBlockedReason(): string {
    if (!this.webReady) {
      return KERNEL_NOT_READY;
    }
    const blocker: string = this.authBlocker();
    if (blocker.length > 0) {
      return blocker;
    }
    if (this.syncBusy) {
      return PREVIOUS_SYNC_RUNNING;
    }
    return '';
  }

  /** 「推送」可点吗（未就绪 / SSH / 无地址 / 分叉都由 `pushBlockedReason()` 给出原因；分支恒为 main）。 */
  private canPush(): boolean {
    return !this.syncBusy && this.webReady && this.pushBlockedReason().length === 0;
  }

  /** 「推送」不可用的具体原因（空串 = 可以点）：原因优先用页面的 `pushBlockedReason()`。 */
  private pushBlockedText(): string {
    if (!this.webReady) {
      return KERNEL_NOT_READY;
    }
    const blocked: string = this.pushBlockedReason();
    if (blocked.length > 0) {
      return blocked;
    }
    if (this.syncBusy) {
      return PREVIOUS_SYNC_RUNNING;
    }
    return '';
  }

  /** 加载态的动作说明：页面在忙时把 `syncMessage` 写成「正在拉取…」，直接复用（空则不渲染该行）。 */
  private loadingDetail(): string {
    return this.syncMessage;
  }

  /** 未配置仓库且不在忙碌中（此时状态行位置让给空态）。 */
  private showEmptyState(): boolean {
    return !this.syncBusy && this.repoUrl.trim().length === 0;
  }

  /** 错误态「为什么」：先用分级结果（已脱敏）；分级给不出内容时退回原始错误行（同样脱敏）。 */
  private errorReason(raw: string): string {
    const detail: string = classifySyncError('', raw).detail.trim();
    if (detail.length > 0) {
      return redactSecrets(detail);
    }
    return redactSecrets(raw);
  }

  /** 错误态「下一步」：有可重放的动作就给「重试」，否则让用户先按原因修正。 */
  private errorNext(): string {
    if (canRetrySync(this.lastSyncAction, this.syncBusy)) {
      return SYNC_ERROR_NEXT_RETRY;
    }
    return SYNC_ERROR_NEXT_FIX;
  }

  /**
   * 诊断单行（`formatDiagnostics` 的产物）：版本 / 设备 / 错误码 / 时间四要素永远都在。
   *
   * 错误码取分级结果的 `kind`（`model/syncError.ts` 没有 `code` 字段，`kind` 就是它的分类键），
   * 不另外编一个。
   */
  private errorDiagnostics(raw: string): string {
    const input: DiagnosticsInput = {
      version: APP_VERSION,
      deviceId: this.deviceId,
      errorCode: classifySyncError('', raw).kind,
      timestamp: Date.now()
    };
    return formatDiagnostics(input);
  }

  /** 同步组：仓库地址 / 访问令牌（主表单两个控件 + 一行固定说明）+「高级」折叠区 / 立即同步 + 1 行状态。 */
  build() {
    Column({ space: SPACING.md }) {
      this.SyncHeader()

      Row({ space: SPACING.sm }) {
        Text('仓库地址')
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
        Blank()
        ActionButton({
          label: '?',
          actionEnabled: true,
          disabledReason: '',
          busy: false,
          variant: 'ghost',
          block: false,
          onTap: (): void => {
            this.onOpenRepoHelp();
          },
          onBlockedTap: null
        })
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      TextInput({ text: this.repoUrl, placeholder: repoUrlPlaceholderFor(this.gitPlatform, this.authMode) })
        .width('100%')
        .height(TOUCH_MIN + SPACING.xs)
        .fontSize(FONT.body)
        .backgroundColor($r('app.color.page_background'))
        .borderRadius(RADIUS.none)
        .padding({ left: 0, right: 0 })
        .onChange((value: string) => {
          this.onChangeRepoUrl(value);
        })
      Divider()
        .strokeWidth(DIVIDER)
        .color($r('app.color.divider'))
      if (this.repoUrlError.length > 0) {
        this.ErrorText(this.repoUrlError)
      } else {
        // 固定说明：平台按地址推断、分支固定 main（没有平台/分支选择控件）
        this.HintLine(SYNC_CAPTION)
      }

      this.FieldLabel('访问令牌（仅存本机）')
      TextInput({
        text: this.token,
        placeholder: tokenPlaceholderFor(this.gitPlatform)
      })
        .type(InputType.Password)
        .width('100%')
        .height(TOUCH_MIN + SPACING.xs)
        .fontSize(FONT.body)
        .backgroundColor($r('app.color.page_background'))
        .borderRadius(RADIUS.none)
        .padding({ left: 0, right: 0 })
        .onChange((value: string) => {
          this.onChangeToken(value);
        })
      Divider()
        .strokeWidth(DIVIDER)
        .color($r('app.color.divider'))
      if (this.tokenError.length > 0) {
        this.ErrorText(this.tokenError)
      }

      // 已保存的是 SSH 方式时给一行只读警告 + 一个显式出口（不是认证方式选择器，也不自动迁移）
      if (this.authMode === AUTH_SSH) {
        Row({ space: SPACING.sm }) {
          Text(SSH_STORED_WARNING)
            .fontSize(FONT.caption)
            .lineHeight(LINE_HEIGHT.caption)
            .fontColor($r('app.color.warning'))
            .layoutWeight(1)
            .textAlign(TextAlign.Start)
          ActionButton({
            label: '改用 HTTPS 令牌',
            actionEnabled: true,
            disabledReason: '',
            busy: false,
            variant: 'ghost',
            block: false,
            onTap: (): void => {
              this.onSwitchToHttpsToken();
            },
            onBlockedTap: null
          })
        }
        .width('100%')
        .alignItems(VerticalAlign.Center)
      }

      // ---- 主表单到此结束：只剩「仓库地址 / 访问令牌」两个控件 ----
      // 设备编号是仓库自动分配的：成功登记后这里只显示一行只读文字（用户不需要、也不应该手填）。
      if (this.deviceIdNotice.length > 0) {
        this.HintLine(this.deviceIdNotice)
      }

      // 「高级 ▸」折叠区：Git 用户名 / 设备标识 / 作者名（默认收起，见 SyncAdvancedFields）
      Row({ space: SPACING.xs }) {
        Text(this.syncAdvancedOpen ? '高级 ▾' : '高级 ▸')
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.brand'))
        Blank()
      }
      .width('100%')
      .height(TOUCH_MIN)
      .alignItems(VerticalAlign.Center)
      .onClick(() => {
        this.toggleSyncAdvanced();
      })
      // 自动展开时的那一行原因（只有 ① 设备标识重复 ② 分配失败/仓库不可读 ③ Gitee 用户名推不出来）
      if (this.syncAdvancedReason.length > 0) {
        this.HintLine(this.syncAdvancedReason)
      }
      if (this.syncAdvancedOpen) {
        this.SyncAdvancedFields()
      }

      // 设备标识重复：**常驻**警告（不是 toast）。两台设备同一个 id 时，附件 zip 互相覆盖、
      // 历史混在一起，而且旧校验根本挡不住——所以这里必须一直红着，直到用户改成唯一值。
      if (this.identityWarning.length > 0) {
        Column({ space: SPACING.xs }) {
          Text('⚠️ 设备标识重复：数据会互相覆盖')
            .fontSize(FONT.caption)
            .lineHeight(LINE_HEIGHT.caption)
            .fontWeight(FontWeight.Medium)
            .fontColor($r('app.color.warning'))
            .width('100%')
            .textAlign(TextAlign.Start)
          Text(this.identityWarning)
            .fontSize(FONT.caption)
            .lineHeight(LINE_HEIGHT.caption)
            .fontColor($r('app.color.warning'))
            .width('100%')
            .textAlign(TextAlign.Start)
        }
        .width('100%')
        .padding({ top: SPACING.sm, bottom: SPACING.sm, left: SPACING.md, right: SPACING.md })
        .backgroundColor($r('app.color.brand_soft'))
        .alignItems(HorizontalAlign.Start)
      }

      // 附件被暂停推送（其它文件照常推）：一行 warning 说明，提醒先处理再重试
      if (this.attachmentWarning.length > 0) {
        Text(this.attachmentWarning)
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.warning'))
          .width('100%')
          .textAlign(TextAlign.Start)
      }

      // ---- 加载态（`docs/STATE-UI.md` §5）：忙时在按钮区上方给进度 + 5s 后可取消 ----
      if (this.syncBusy) {
        LoadingState({
          title: loadingText('同步'),
          detail: this.loadingDetail(),
          progress: -1,
          compact: true,
          onCancel: (): void => {
            // 只停「等待」，不假装同步已结束（后台可能仍在跑，页面只写「已停止等待」）
            this.runAction('cancel-wait');
          }
        })
      }

      Row({ space: SPACING.md }) {
        // 「立即同步」（= pull）：未就绪 / 认证不可用 / 忙碌时**仍可点**，点了给具体原因
        ActionButton({
          label: '立即同步',
          actionEnabled: this.canPull(),
          disabledReason: this.pullBlockedReason(),
          busy: this.syncBusy,
          variant: 'secondary',
          block: false,
          onTap: (): void => {
            this.runAction('pull');
          },
          onBlockedTap: null
        })
        // 手动推送：未就绪 / SSH / 无地址时给出原因（分支恒为 main，无非法输入）
        ActionButton({
          label: '推送',
          actionEnabled: this.canPush(),
          disabledReason: this.pushBlockedText(),
          busy: this.syncBusy,
          variant: 'secondary',
          block: false,
          onTap: (): void => {
            this.runAction('push');
          },
          onBlockedTap: null
        })
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      // 状态行位置：未配置仓库 → 空态（给出「去填仓库地址」这一步），否则显示最近一次结果
      // （状态行本身不再可点：它要保留 caption 字号与失败红字，重复入口统一走组头「更多」）
      if (this.showEmptyState()) {
        EmptyState({
          title: EMPTY_SYNC_TITLE,
          detail: EMPTY_SYNC_DETAIL,
          actionLabel: EMPTY_SYNC_ACTION,
          compact: true,
          onAction: (): void => {
            this.onOpenSyncMore();
          }
        })
      } else {
        Text(this.syncMessage)
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor(this.syncMessage.startsWith('❌') ? $r('app.color.danger') : $r('app.color.text_secondary'))
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
          .textAlign(TextAlign.Start)
      }

      // 推送被禁用的具体原因（未就绪/SSH/无地址），避免「按钮灰着不知道为什么」
      if (this.pushBlockedReason().length > 0) {
        this.HintLine(`推送不可用：${this.pushBlockedReason()}`)
      }

      // A2：同步状态（分支 / 领先 / 落后 / 冲突 / 本地改动）——桥就绪后自动刷新一次
      if (this.statusLine.length > 0) {
        Text(this.statusLine)
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
          .maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
          .textAlign(TextAlign.Start)
      }
      if (this.statusLine.length > 0 && this.statusReadiness.length > 0) {
        this.HintLine(this.statusReadiness)
      }

      // 从首页搬来的过滤开关：首页列表是否同时展示其他设备的只读记录
      Row({ space: SPACING.sm }) {
        Text('首页含其他设备（只读）')
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
          .layoutWeight(1)
          .textAlign(TextAlign.Start)
        Toggle({ type: ToggleType.Switch, isOn: this.includeOtherDevices })
          .selectedColor($r('app.color.brand'))
          .onChange((isOn: boolean) => {
            this.onToggleIncludeOtherDevices(isOn);
          })
      }
      .width('100%')
      .height(TOUCH_MIN + SPACING.sm)
      .alignItems(VerticalAlign.Center)

      // 错误态（`docs/STATE-UI.md` §4.3）：发生了什么 / 为什么 / 下一步 + 可复制诊断 + 重试
      if (this.lastSyncError.length > 0) {
        ErrorState({
          what: SYNC_ERROR_WHAT,
          why: this.errorReason(this.lastSyncError),
          next: this.errorNext(),
          diagnostics: this.errorDiagnostics(this.lastSyncError),
          compact: false,
          onRetry: (): void => {
            this.runAction('pull');
          },
          onOpenSettings: null
        })
      }

      if (this.saveHint.length > 0) {
        // 校验失败时这条也必须是红的：它在「保存」按钮正上方，用户一定看得到
        Text(this.saveHint)
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor(this.issuesSummary.length > 0 ? $r('app.color.danger') : $r('app.color.text_secondary'))
          .maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
          .textAlign(TextAlign.Start)
      }

      // 隐藏的 Git 运行环境：1x1、全透明，只用于执行 isomorphic-git（必须挂载）
      Stack() {
        Web({ src: $rawfile('git/index.html'), controller: this.gitController })
          .width(1)
          .height(1)
          .opacity(0)
          .onPageEnd(() => {
            this.onWebReady();
          })
          .onErrorReceive(() => {
            this.onWebError();
          })
      }
      .width(1)
      .height(1)
      .opacity(0)
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }
}
