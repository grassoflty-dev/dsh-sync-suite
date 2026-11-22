/**
 * 设置页「同步（Git）」section。
 *
 * A2 拆分：内容从 `pages/Settings.ets` 逐字搬出。页面持有全部 `@State`，
 * 这里只收**单向 props + 回调**（`@Prop` 值 + `onXxx`），
 * 本组件不写任何状态 —— 刷新语义因此与拆分前一致：父页面值变了才重绘，重绘时读到的
 * 就是最新值（`authBlocker()` 之类的只读派生方法由父页面以函数 props 传入）。
 *
 * 契约（改动前先读 `docs/UI-DESIGN.md`；mod-settings-sync-min：高级折叠区整条删除）：
 * - 主表单只有「仓库地址 / 访问令牌」两个控件，地址下固定一行说明
 *   「平台按地址自动识别 · 分支固定 main」；平台随地址推断、分支恒为 main，无选择控件；
 * - Git 用户名 / 设备标识 / 作者名不再有输入控件：用户名按地址推断、编号由仓库自动分配、
 *   作者名默认「我」，全部由软件静默安排；旧值仍可读于 settingsStore，只是不再上屏；
 * - 设备标识重复是**常驻** warning（不是 toast），附件被暂停推送同样常驻一行；
 * - Git 操作全部由 app 自动完成（冷启动 / 保存 / 下拉 / 前台恢复 / 网络恢复静默触发），
 *   本组件**没有**任何手动同步按钮；组头**唯一**的「更多」只留仓库地址帮助文案
 *   （弹层在页面，见 `pages/SettingsSync.ets`，mod-sync-silence-phase-b）；
 *   已保存的认证方式是 SSH 时
 *   本组件给一行只读警告 + 一个显式「改用 HTTPS 令牌」按钮（不是认证方式选择器；只切状态、
 *   不自动保存，落盘仍由用户点「保存设置」完成）；
 * - 隐藏的 Git 运行环境（1x1 全透明 Web）必须挂在本组内（`controller` 与页面是**同一个实例**，
 *   所以是普通成员而不是 `@Prop`：`@Prop` 会深拷贝，代理就注册到副本上了）。
 *
 * A 批（`docs/STATE-UI.md` §4/§5）：
 * - 组头「更多」与 SSH 切换入口统一用 `ActionButton`（禁用也**可点**，点了给具体中文原因）；
 * - 同步中 → `LoadingState`（只读进度；取消等待的手动控制已删除，周期自行 settle）；
 * - 没填仓库地址 → `EmptyState`（「去填仓库地址」），只占状态行位置，**不藏表单**；
 * - `lastSyncError` 非空 → `ErrorState`（三段式 + 诊断四要素；`onRetry` 为 null）。
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
  HintLine as HintLineBit
} from './SettingsBits';

/** 空态的标题 / 说明 / 动作（未配置仓库时占住「状态行」的位置）。 */
const EMPTY_SYNC_TITLE: string = '还没有配置同步仓库';
const EMPTY_SYNC_DETAIL: string = '填好仓库地址和 token 后，这里会显示同步状态';
const EMPTY_SYNC_ACTION: string = '去填仓库地址';

/** 错误态的三段式标题与两条「下一步」（可重试 / 只能先改配置）。 */
const SYNC_ERROR_WHAT: string = '同步失败';
// mod-sync-silence-phase-b：下一步不再指向任何手动按钮；下一次自动周期会自行重试。
const SYNC_ERROR_NEXT_RETRY: string = '下一次自动同步会自行重试；持续失败请检查仓库地址与 token';
const SYNC_ERROR_NEXT_FIX: string = '先按上面的原因修正，随后会自动重试';

/** 仓库地址下的固定说明：平台随地址推断、分支固定 main（本页没有平台/分支选择控件）。 */
const SYNC_CAPTION: string = '平台按地址自动识别 · 分支固定 main';

/**
 * mod-repo-privacy-gate：同步仓库字段下方的唯一规则行。
 * 日程 `timeline/**`、聊天 `chats/**`、远程控制配置 `remote/**` 共用这一个仓库，
 * 所以必须是私有仓库；具体拒绝文案由 typed 模型给出，不在这里另编第二套。
 */
const REPO_PRIVATE_RULE: string = '仓库必须是私有仓库（日程、聊天与远程控制配置会提交到这里）';

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

  // ---------------------------------------------------------------- 静默派生的设备标识
  /**
   * 设备标识**只进可复制的诊断文本**（版本/设备/错误码/时间四要素），不是配置字段、不上屏为输入框。
   * 值来自页面已归一的设备标识（仓库自动分配或存量值），mod-settings-sync-min 后「高级」折叠区整条删除。
   */
  @Prop deviceId: string = '';

  // ---------------------------------------------------------------- 常驻状态
  /** 设备标识重复的常驻警告（空串 = 正常）。 */
  @Prop identityWarning: string = '';
  /** 本次推送被暂停的附件说明（空串 = 没有暂停）。 */
  @Prop attachmentWarning: string = '';
  @Prop syncMessage: string = '';
  @Prop syncBusy: boolean = false;
  @Prop webReady: boolean = false;
  @Prop statusLine: string = '';
  @Prop lastSyncError: string = '';
  /** 上一次同步的动作（`pull` / `push` / `status`；空串 = 还没同步过）——错误态判断「能不能重试」用。 */
  @Prop lastSyncAction: string = '';
  @Prop saveHint: string = '';
  /** 保存校验的问题汇总：只用于决定 `saveHint` 用红字还是灰字。 */
  @Prop issuesSummary: string = '';
  /** 首页是否展示其他设备的只读记录。 */
  @Prop includeOtherDevices: boolean = false;

  // ---------------------------------------------------------------- 页面只读派生（函数 props）
  /** 当前认证方式的阻塞原因（空串 = 可同步）。 */
  authBlocker: () => string = () => '';

  // ---------------------------------------------------------------- 回调（页面改状态）
  onChangeRepoUrl: (value: string) => void = () => {};
  onChangeToken: (value: string) => void = () => {};
  /** 首页过滤开关（页面同时写 AppStorage）。 */
  onToggleIncludeOtherDevices: (isOn: boolean) => void = () => {};
  // mod-sync-silence-phase-b：runAction / onRetryStatus 两个回调已移除——
  // 同步由事件静默触发，状态行与错误态都不再提供可点的手动同步出口。
  /** 打开唯一的「更多」帮助弹层（组头「更多」与空态动作都走这里）。 */
  onOpenSyncMore: () => void = () => {};
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

  /** 组标题 + 右侧「更多」入口。 */
  @Builder
  SyncHeader() {
    Row({ space: SPACING.sm }) {
      Text('同步仓库')
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

  // ---------------------------------------------------------------- 状态行派生
  //
  // Git 操作全部自动完成，这里只剩只读派生（不写状态、不发起手动同步）。

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

  /** 同步组：仓库地址 / 访问令牌（主表单两个控件 + 一行固定说明）+ 1 行诚实状态。 */
  build() {
    Column({ space: SPACING.md }) {
      this.SyncHeader()

      // mod-fix-sync-affordance：仓库地址行的 `?` 与组头「更多」曾打开同一个仓库地址帮助弹层，
      // 是同一入口的两次露脸。只保留组头「更多」（它承载查看状态 / 测试连接 / 重试），
      // 帮助文案并入同一个弹层；本行不再放第二个帮助按钮。
      Text('仓库地址')
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontColor($r('app.color.text_secondary'))

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
      // 常驻规则行：日程 / 聊天 / 远程控制配置共用同一仓库，只接受私有仓库。
      this.HintLine(REPO_PRIVATE_RULE)

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

      // ---- 主表单到此结束：只有「仓库地址 / 访问令牌」两个控件 ----
      // mod-settings-sync-min：原折叠区（用户名 / 设备标识 / 作者名）整条删除，
      // 三者改由软件静默派生（用户名按地址推断、编号自动分配、作者名默认「我」），旧值仍留在 store。

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

      // ---- 加载态（`docs/STATE-UI.md` §5）：忙时在状态行上方给进度 ----
      // mod-sync-silence-phase-b：取消等待也是手动同步控制，已移除；后台周期自行 settle。
      if (this.syncBusy) {
        LoadingState({
          title: loadingText('同步'),
          detail: this.loadingDetail(),
          progress: -1,
          compact: true,
          onCancel: null
        })
      }

      // 状态行位置：未配置仓库 → 空态（给出「去填仓库地址」这一步），否则显示最近一次结果
      // （状态行只读：mod-sync-silence-phase-b 删除了点状态行重试的 onClick）
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
          // 失败态含实时「失败：…」与启动/权威「上次失败 · HH:MM」两种同源文案，都要红色。
          .fontColor(this.syncMessage.startsWith('失败：') || this.syncMessage.startsWith('上次失败 · ')
            ? $r('app.color.danger') : $r('app.color.text_secondary'))
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
          .textAlign(TextAlign.Start)
      }

      // 诊断区（mod-sync-silent-autoinit）：分支 / HEAD / 领先落后 / 本地改动 / 等待重试数
      // 都是**只读排障事实**，不是用户下一步动作，更不是「先拉取才能继续」的死结；
      // 「能不能推」这类可执行文案已从本区块移除，只留只读事实。
      // 用户可见状态行始终只有三态。
      if (this.statusLine.length > 0 && !this.showEmptyState()) {
        Column({ space: SPACING.xs }) {
          Text('诊断（仅排查用）')
            .fontSize(FONT.caption)
            .lineHeight(LINE_HEIGHT.caption)
            .fontColor($r('app.color.text_secondary'))
            .width('100%')
            .textAlign(TextAlign.Start)
          Text(this.statusLine)
            .fontSize(FONT.caption)
            .lineHeight(LINE_HEIGHT.caption)
            .fontColor($r('app.color.text_secondary'))
            .maxLines(2)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .width('100%')
            .textAlign(TextAlign.Start)
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start)
      }

      // 从首页搬来的过滤开关：首页列表是否同时展示其他设备的只读记录
      Row({ space: SPACING.sm }) {
        Text('首页含其他设备')
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

      // 写入统一走日程目录；状态行只展示同步结果，不表达任何模式。
      // 错误态（`docs/STATE-UI.md` §4.3）：发生了什么 / 为什么 / 下一步 + 可复制诊断；
      // mod-sync-silence-phase-b：`onRetry` 置 null——失败由下一次自动周期自行恢复，用户点不到手动重试。
      if (this.lastSyncError.length > 0) {
        ErrorState({
          what: SYNC_ERROR_WHAT,
          why: this.errorReason(this.lastSyncError),
          next: this.errorNext(),
          diagnostics: this.errorDiagnostics(this.lastSyncError),
          compact: false,
          onRetry: null,
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
