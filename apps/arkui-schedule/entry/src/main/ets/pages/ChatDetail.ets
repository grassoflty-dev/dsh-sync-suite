/**
 * 云端对话 · 只读详情（P1）。
 *
 * 数据源：`chats/<id>/meta.json` + `chats/<id>/session.jsonl`（见 `services/chatStore.ets`）。
 * **只读**是产品约束，不是暂时没做：`docs/CHAT-SYNC.md` §1/§5 规定同一会话同一时刻只有一个写者，
 * 平板在这里续写会制造两条分叉的事件流（§1.1 的坏结局）。所以本页：
 * - 顶部固定一条说明「这是从 Git 同步来的只读会话，不能在这里继续对话」；
 * - **底部没有输入框**，也没有发送按钮（不给假入口）；
 * - 底部唯一的出口是「在电脑上继续」：**跳转**到远程控制页（写入仍发生在电脑端），不是接管、
 *   不是输入框、也不是发送按钮；`docs/CHAT-APP.md` §8.5「不做接管入口」的纪律不变；
 * - 工具调用只显示一行灰字等宽摘要（`🔧 <name>`），不渲染参数/结果（参数含绝对路径与命令输出）。
 *
 * 排版选择：**统一左对齐 + 角色小字**，而不是「user 右 / assistant 左」的双侧气泡。
 * 理由（更省空间）：会话正文常有代码块与长段落，双侧气泡要为主/客各留一份左右边距与最大宽度，
 * 窄屏（竖屏平板 673vp、手机 360–430vp）下会把可用行宽压掉 20–30%；统一左对齐能整行铺满。
 *
 * 旋转/切页：`messages` / 标题都在 `@State`，`aboutToAppear` 读一次即可（旋转不重新读盘）。
 *
 * 三态（`docs/STATE-UI.md` §4）：`LoadingState`（可取消，只停止等待）/
 * `EmptyState`（没有可读消息 → 「返回列表」）/ `ErrorState`（三段式 + 诊断 + 重试 + 「返回列表」）。
 * 顶部只读提示 `ReadOnlyNotice` 是产品约束，**永远保留**（在滚动区之外）。
 */
import { promptAction, router } from '@kit.ArkUI';
import { common } from '@kit.AbilityKit';
import { loadingText } from '../common/copy';
import { APP_VERSION } from '../common/version';
import { formatChatTime } from '../model/chatList';
import type { ChatMessage } from '../model/chatList';
import { normalizeRemoteUrl, routeToRemote } from '../model/remoteUrl';
import type { RemoteUrlCheck } from '../model/remoteUrl';
import { formatDiagnostics } from '../model/stateView';
import type { DiagnosticsInput } from '../model/stateView';
import { chatStore } from '../services/chatStore';
import type { ChatDetailResult } from '../services/chatStore';
import { describeError } from '../services/scheduleStore';
import { settingsStore } from '../services/settingsStore';
import { ActionButton } from '../components/ActionButton';
import { PageLayout } from '../components/PageLayout';
import { EmptyState } from '../components/state/EmptyState';
import { ErrorState } from '../components/state/ErrorState';
import { LoadingState } from '../components/state/LoadingState';
import { DIVIDER, FONT, LINE_HEIGHT, RADIUS, SPACING } from '../common/uiTokens';

/** 宽屏下正文最大宽度（vp）：整行铺满宽屏会让 16fp 正文一行过长、难回行。 */
const CONTENT_MAX_WIDTH: number = 720;

/** 标题兜底（meta.title 缺失 / 为空时，页头也不能空着）。 */
const FALLBACK_TITLE: string = '云端会话';

/** 诊断行里的错误码（详情读取失败）：固定值，便于用户反馈时检索。 */
const CHAT_DETAIL_ERROR_CODE: string = 'CHAT_DETAIL';

/** 空态文案：文件完整但没有可读消息（全是工具/用量事件也会这样）。 */
const EMPTY_TITLE: string = '这个会话没有可读的消息内容';
const EMPTY_DETAIL: string = '工具输出、用量统计等事件不在只读视图里展示；换个会话看看';
const BACK_LABEL: string = '返回列表';

/** 错误态文案：为什么失败由 `errorText` 运行时给。 */
const ERROR_WHAT: string = '读取会话失败';
const ERROR_NEXT: string = '文件可能只同步了一半；回列表下拉刷新后再进来';

@Entry
@Component
struct ChatDetail {
  /** 路由参数里的会话 id（空串 = 参数丢了，走错误态）。 */
  @State chatId: string = '';
  /** 页头标题（meta.title 优先）。 */
  @State chatTitle: string = FALLBACK_TITLE;
  /** 页头副标题：`只读 · <updatedAt>`。 */
  @State subtitle: string = '只读';
  /** 可读消息（工具调用压成一行摘要）。 */
  @State messages: ChatMessage[] = [];
  /** 失败原因；空串 = 无错误。 */
  @State errorText: string = '';
  /** 首次读取中。 */
  @State loading: boolean = true;
  /** 远程控制可用的地址；空串 = 不可用，按钮禁用并给原因。 */
  @State remoteUrl: string = '';

  private disposed: boolean = false;

  aboutToAppear(): void {
    this.chatId = this.readParamId();
    chatStore.prepare(getContext(this) as common.UIAbilityContext);
    this.load();
    // 跳转出口的地址与正文读取互不依赖：并行取，失败也只是按钮禁用，不影响会话内容。
    this.loadRemoteTarget();
  }

  aboutToDisappear(): void {
    this.disposed = true;
  }

  // ------------------------------------------------------------------ 数据

  /** 读路由参数 `id`（没有参数 / 抛异常都当空串，走错误态）。 */
  private readParamId(): string {
    try {
      const params = router.getParams() as Record<string, string>;
      if (params === undefined || params === null) {
        return '';
      }
      const value = params['id'];
      if (value === undefined || value === null) {
        return '';
      }
      return value;
    } catch (error) {
      return '';
    }
  }

  /** 读会话：成功后铺标题/副标题/消息；失败只落 `errorText`（不抛、不留半截内容）。 */
  private async load(): Promise<void> {
    this.errorText = '';
    this.loading = true;
    if (this.chatId.length === 0) {
      this.errorText = '会话 ID 缺失：请从云端对话列表重新进入';
      this.loading = false;
      return;
    }
    try {
      const result: ChatDetailResult = await chatStore.loadChat(this.chatId);
      if (this.disposed) {
        return;
      }
      if (!result.ok) {
        this.messages = [];
        this.errorText = result.reason === undefined ? '会话文件不完整' : result.reason;
        this.loading = false;
        return;
      }
      this.applyMeta(result);
      this.messages = result.messages === undefined ? [] : result.messages;
    } catch (error) {
      if (this.disposed) {
        return;
      }
      this.messages = [];
      this.errorText = `读取会话失败：${describeError(error)}`;
    }
    this.loading = false;
  }

  /** 读「电脑上的 DSH 地址」：只用于跳转出口；不可用就留空串（按钮禁用并给原因）。 */
  private async loadRemoteTarget(): Promise<void> {
    try {
      // 带 context：本页可能先于设置页被打开（历史栈返回 / 深链），load 会顺带幂等初始化
      const settings = await settingsStore.load(getContext(this) as common.UIAbilityContext);
      if (this.disposed) {
        return;
      }
      const check: RemoteUrlCheck = normalizeRemoteUrl(settings.remoteUrl);
      this.remoteUrl = check.ok ? check.url : '';
    } catch {
      if (!this.disposed) {
        this.remoteUrl = '';
      }
    }
  }

  /** 「在电脑上继续」：跳到远程控制页，把地址作为路由参数带过去（写入仍发生在电脑端）。 */
  private continueOnPc(): void {
    if (this.remoteUrl.length === 0) {
      return;
    }
    try {
      router.pushUrl({ url: routeToRemote(), params: { url: this.remoteUrl } });
    } catch (error) {
      promptAction.showToast({ message: `打开远程控制失败：${describeError(error)}` });
    }
  }

  /**
   * 停止等待（`LoadingState.onCancel`）：收掉本页的等待状态，并给一条可重试的说明。
   *
   * 后台读文件可能仍会完成，所以**不**假装成功、也**不**假装文件坏了：把「已停止等待」写进
   * `errorText`，让 `ErrorState` 同时给出原因与「重试」出路。
   */
  private stopWaiting(): void {
    this.loading = false;
    this.errorText = '已停止等待：这次没有读完会话文件，点「重试」可以重新读取';
    promptAction.showToast({ message: '已停止等待：可以点重试，或回列表下拉刷新后再进来' });
  }

  /** 诊断行（`docs/STATE-UI.md` §4.3）：版本 / 设备 / 错误码 / 时间；设备 id 本页没有 → 兜底「未登记」。 */
  private diagnosticsText(errorCode: string): string {
    const input: DiagnosticsInput = {
      version: APP_VERSION,
      deviceId: '',
      errorCode: errorCode,
      timestamp: Date.now()
    };
    return formatDiagnostics(input);
  }

  /** `meta.json` → 页头标题与 `只读 · <updatedAt>` 副标题（字段缺失都安全降级）。 */
  private applyMeta(result: ChatDetailResult): void {
    const meta = result.meta;
    if (meta === undefined) {
      this.chatTitle = FALLBACK_TITLE;
      this.subtitle = '只读';
      return;
    }
    const title: string = meta.title === undefined ? '' : meta.title.trim();
    this.chatTitle = title.length > 0 ? title : FALLBACK_TITLE;
    const updated: string = meta.updatedAt === undefined ? '' : formatChatTime(meta.updatedAt);
    this.subtitle = updated.length > 0 ? `只读 · ${updated}` : '只读';
  }

  /** 角色中文标签（`tool` 行不显示标签：摘要本身已带「🔧」）。 */
  private roleLabel(role: string): string {
    if (role === 'user') {
      return '我';
    }
    if (role === 'assistant') {
      return '助手';
    }
    if (role === 'system') {
      return '系统';
    }
    if (role === 'tool') {
      return '工具';
    }
    return '其他';
  }

  // ------------------------------------------------------------------ UI

  /**
   * 顶部固定只读提示（**在滚动区之外**，滚到哪都能看见）。
   *
   * 用 `brand_soft` 底 + 辅助字号：它是说明而不是错误，不该用 danger 色。
   */
  @Builder
  ReadOnlyNotice() {
    Text('这是从 Git 同步来的只读会话，不能在这里继续对话')
      .fontSize(FONT.caption)
      .lineHeight(LINE_HEIGHT.caption)
      .fontColor($r('app.color.text_primary'))
      .width('100%')
      .padding({ top: SPACING.sm, bottom: SPACING.sm, left: SPACING.md, right: SPACING.md })
      .backgroundColor($r('app.color.brand_soft'))
      .borderRadius(RADIUS.sm)
      .textAlign(TextAlign.Start)
  }

  /**
   * 一条消息：统一左对齐 + 角色小字；工具行灰字等宽。
   *
   * 参数只收**基础类型**（role / 正文）：`@Builder` 传对象是按值快照，消息列表刷新时会粘住旧值。
   */
  @Builder
  MessageRow(role: string, text: string) {
    Column({ space: SPACING.xs }) {
      if (role === 'tool') {
        // 工具调用：一行灰字等宽摘要（不渲染参数/结果）。
        // 工程里没有自带等宽字体文件，所以用通用族名 'monospace'：系统认得就用等宽，
        // 不认得就回落默认字体（不崩、仍然靠灰字 + 辅助字号与正文区分）。
        Text(text)
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
          .fontFamily('monospace')
          .width('100%')
          .textAlign(TextAlign.Start)
      } else {
        Text(this.roleLabel(role))
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
          .width('100%')
          .textAlign(TextAlign.Start)
        Text(text)
          .fontSize(FONT.body)
          .lineHeight(LINE_HEIGHT.body)
          .fontColor($r('app.color.text_primary'))
          .width('100%')
          .textAlign(TextAlign.Start)
          .copyOption(CopyOptions.LocalDevice)
      }
    }
    .width('100%')
    .padding({ top: SPACING.md, bottom: SPACING.md })
    .alignItems(HorizontalAlign.Start)
  }

  /** 消息流（长会话靠 List 懒加载；行间 1vp 细线）。 */
  @Builder
  MessageList() {
    List() {
      ForEach(
        this.messages,
        (item: ChatMessage, index: number) => {
          ListItem() {
            Column() {
              this.MessageRow(item.role, item.text)
              Divider()
                .strokeWidth(DIVIDER)
                .color($r('app.color.divider'))
            }
            .width('100%')
            .alignItems(HorizontalAlign.Start)
          }
        },
        (item: ChatMessage, index: number) => `msg-${index}-${item.role}`
      )
    }
    .width('100%')
    .layoutWeight(1)
    .scrollBar(BarState.Off)
  }

  /** 空态：文件完整但没有任何可读消息（全是工具/用量事件也会这样）→ 「返回列表」有出路。 */
  @Builder
  EmptyMessages() {
    EmptyState({
      title: EMPTY_TITLE,
      detail: EMPTY_DETAIL,
      actionLabel: BACK_LABEL,
      onAction: (): void => {
        router.back();
      }
    })
  }

  /**
   * 错误态：三段式 + 诊断行 + 「重试」。
   *
   * 第二按钮**不**走 `ErrorState.onOpenSettings`（文案固定「去设置」，本页要的是「返回列表」），
   * 所以 `onOpenSettings` 传 `null`，在组件外自己放一个 `ActionButton`。
   */
  @Builder
  ErrorBlock() {
    Column({ space: SPACING.md }) {
      ErrorState({
        what: ERROR_WHAT,
        why: this.errorText,
        next: ERROR_NEXT,
        diagnostics: this.diagnosticsText(CHAT_DETAIL_ERROR_CODE),
        onRetry: (): void => {
          this.load();
        },
        onOpenSettings: null
      })
      Row() {
        ActionButton({
          label: BACK_LABEL,
          enabled: true,
          disabledReason: '',
          busy: false,
          variant: 'secondary',
          block: false,
          onTap: (): void => {
            router.back();
          },
          onBlockedTap: null
        })
      }
      .width('100%')
      .justifyContent(FlexAlign.Center)
    }
    .width('100%')
    .padding({ top: SPACING.lg, bottom: SPACING.lg })
    .alignItems(HorizontalAlign.Start)
  }

  /** 首次读取中：行内紧凑档，3 秒后可取消（只停止等待，不假装读完）。 */
  @Builder
  LoadingHint() {
    Column() {
      LoadingState({
        compact: true,
        title: loadingText('会话'),
        onCancel: (): void => {
          this.stopWaiting();
        }
      })
    }
    .width('100%')
    .padding({ top: SPACING.lg, bottom: SPACING.lg })
    .alignItems(HorizontalAlign.Start)
  }

  /**
   * 底部跳转出口「在电脑上继续」：**只跳转，不接管**（写入仍在电脑端）。
   *
   * 地址不可用时给出 `disabledReason`（由 `ActionButton` 在点击时 toast），而不是给一个点了
   * 没反应的假按钮；说明行用辅助字号 + 灰字，和顶部只读提示一样是「说明」而非操作。
   */
  @Builder
  ContinueOnPc() {
    Column({ space: SPACING.xs }) {
      ActionButton({
        label: '在电脑上继续',
        enabled: this.remoteUrl.length > 0,
        disabledReason: '先在设置里填写电脑上的 DSH 地址',
        busy: false,
        variant: 'secondary',
        block: true,
        onTap: (): void => {
          this.continueOnPc();
        },
        onBlockedTap: null
      })
      Text('在电脑上打开 DSH 接管这条会话；本页只读，写入仍是电脑端的事')
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontColor($r('app.color.text_secondary'))
        .width('100%')
        .textAlign(TextAlign.Start)
    }
    .width('100%')
    .padding({ top: SPACING.sm })
    .alignItems(HorizontalAlign.Start)
  }

  build() {
    // 根节点必须是**容器组件**（同 Chats.ets：10905210 实测），与 Detail/Edit/Index/Settings 同形：
    // Stack 兜底 + PageLayout 作为其唯一子节点。
    Stack({ alignContent: Alignment.TopStart }) {
      PageLayout({
        title: this.chatTitle,
        subtitle: this.subtitle,
        onBack: () => {
          router.back();
        }
      }) {
        Column({ space: SPACING.md }) {
          // 只读提示固定在顶部：无论列表滚到哪里都在
          this.ReadOnlyNotice()
          if (this.errorText.length > 0) {
            this.ErrorBlock()
          } else if (this.loading) {
            this.LoadingHint()
          } else if (this.messages.length === 0) {
            this.EmptyMessages()
          } else {
            this.MessageList()
          }
          // 跳转出口在四选一内容区之外、列表之下：列表 layoutWeight(1) 吃剩余空间，出口固定可见。
          this.ContinueOnPc()
        }
        .width('100%')
        .height('100%')
        .constraintSize({ maxWidth: CONTENT_MAX_WIDTH })
        .alignItems(HorizontalAlign.Start)
      }
    }
    .width('100%')
    .height('100%')
  }
}
