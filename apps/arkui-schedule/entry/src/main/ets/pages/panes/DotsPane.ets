/**
 * dots 分段：真实只读会话列表 + 只读授权视图（mod-shell-dots-pane / mod-dots-readonly）。
 *
 * 对外契约（Home 装配，一字未改）：
 *   - `@Prop deepLinkId`：深链携带的会话 id，预留给「按 id 打开指定 dots 会话」，当前不消费；
 *   - `@Prop active`：由 Home 按当前分段传入，根 Scroll 据此在 Visible / Hidden 间切换；
 *     Hidden 仍留在组件树上，切段不丢 @State（不卸载、不每次显示都重读）。
 *
 * 数据链与 CloudChatPane 同源：`services/chatStore` 的 prepare / listChats + `model/chatList`
 * 的 filterBySegment / sortChats / chatSummaryLine，只取投影 preset 为 dots 的会话；
 * 不读 `chats/index.jsonl` 的 `kind`（投影胜出），不另建 store、不自行解析 JSON。
 * 点行进既有 `pages/ChatDetail`（只传 id，路由写法与 `pages/Chats.ets` 完全一致）。
 *
 * mod-dots-readonly：只读消费 `services/instanceGrantStore`（仅 lastProblem / redacted 两个 read API，
 * 不调 upsert / revoke），在列表上方渲染一条紧凑的授权行 —— 当前有效实例的 view 工具并集 +
 * 「命令工具 session.prompt 未授予」；坏信封 / 空表由 store 的 typed problem _fail-closed_ 到
 * 「未授权 / 未知」，绝不声称权限存在。**发指令保持禁用**：原因写在禁用的 Text 上（渲染文案，
 * 不是日志），且逐字来自冻结闸门 `COMMAND_WORDING`（经纯函数 `placeholderRefusalReason`），
 * 没有手写拒绝文案。没有 grant UI / 没有 RPC / 没有配置面。
 * 加载 / 空 / 错误+重试 / 列表四态齐全，不渲染任何假行。
 * 空态经 `components/state/EmptyState` 显式 `showAction: false`：没有可点的东西时只给一句事实，
 * 不渲染同步 / 导出形状的按钮（旧「下一步 + 刷新按钮」口径已作废）。
 * 事实句只陈述「本页显示上次读取到的同步结果」，不承诺结果时效性，也不承诺回到本页就读到新数据：
 * 本面板是保活组件，重读只发生在 aboutToAppear 与 @Watch('onGlobalRefreshTick') 的外壳全局刷新 tick，
 * 切段回到本页不触发读取；一次同步若没被本面板读到（Chats 页 pull 不推进 dots tick、
 * Home 前台 5 分钟冷却挡住补偿周期），结果要等到下一次读取才反映，所以这句只按读到的那一刻说，
 * 不能承诺结果一定是最新的；`pages/Chats.ets` 是页面，onPageShow 真会重读，所以那句真话只留在页面里，本面板不照抄。
 *
 * 历史锚点（守卫按源码文本钉住，勿当作现行语义）：
 * scaffold 原因旧值「dots 尚未接线」与禁用输入框 `输入给 dots 的指令…` 已随真列表移除，
 * 旧的过度承诺副标题（「可发指令 + 所有操作需你确认」口径）已被只读口径取代；
 * 只在本注释里留迁移记录；渲染树里不再有它们。
 */
import { common } from '@kit.AbilityKit';
import { promptAction, router } from '@kit.ArkUI';
import { loadingText } from '../../common/copy';
import { DIVIDER, FONT, LINE_HEIGHT, SPACING, TOUCH_MIN } from '../../common/uiTokens';
import { EmptyState } from '../../components/state/EmptyState';
import { ErrorState } from '../../components/state/ErrorState';
import { LoadingState } from '../../components/state/LoadingState';
import { chatSummaryLine, filterBySegment, sortChats } from '../../model/chatList';
import type { ChatIndexEntry, ChatKind } from '../../model/chatList';
import { isViewTool, problemText, TOOL_SESSION_PROMPT, VIEW_TOOLS } from '../../model/instanceGrant';
import type { GrantProblem, RedactedGrant } from '../../model/instanceGrant';
import { placeholderRefusalReason, remoteChannelVerified } from '../../model/remoteCommandDraft';
import { chatStore } from '../../services/chatStore';
import type { ChatListResult } from '../../services/chatStore';
import { instanceGrantStore } from '../../services/instanceGrantStore';
import { describeError } from '../../services/scheduleStore';

/** 本分段只看 dots 会话；云端会话不在这里展示（分段切换只由 ShellRail 负责）。 */
const PANE_KIND: ChatKind = 'dots';

/** 新副标题：取代过度承诺的旧句，只陈述今天真做到的事（只读查看 + 发指令暂不可用）。 */
const DOTS_SUBTITLE: string = 'dots 只读查看会话，暂不能发指令。';

/** 只读授权行的固定片段：前缀 + 命令工具未授予的结论（view 权永不隐含 command 权）。 */
const GRANT_LINE_PREFIX: string = 'dots 权限（只读）：';
const GRANT_LINE_NO_COMMAND: string = `；命令工具 ${TOOL_SESSION_PROMPT} 未授予。`;

/** 空态文案（old→new）：前两条沿用批准措辞；第三句只说「本页显示上次读取到的同步结果」——保活面板只在 aboutToAppear / @Watch('onGlobalRefreshTick') 重读，没被它读到的同步要到下一次读取才反映，既不承诺回到本页就读到新数据，也不承诺结果一定是最新的。 */
const EMPTY_DOTS_TITLE: string = '还没有 dots 对话';
const EMPTY_DOTS_DETAIL: string =
  '先在设置里配置仓库；之后 dots 会话会在后台自动同步过来；本页显示上次读取到的同步结果。';

/** 错误态：为什么由 `errorText` 给，这里只给一句可执行的排查方向。 */
const ERROR_WHAT: string = '读取 dots 会话失败';
const ERROR_NEXT: string = '先确认本机拉取过同步仓库，再点重试';

@Component
export struct DotsPane {
  /** 深链 id：预留给后续按 id 打开指定 dots 会话。 */
  @Prop deepLinkId: string = '';
  /** 保活可见性：Home 当前分段为 dots 时传 true。 */
  @Prop active: boolean = true;
  /**
   * 首页全局下拉刷新的读回信号（mod-home-global-refresh）：Home 在一次周期 settle 后 +1。
   * 本面板是保活 @Component，框架不会调用自己的 onPageShow，只能靠 @Watch 接外壳信号；
   * 这里**只重读 chatStore**（无网络、无第二个周期），与 aboutToAppear 共用同一条 reload()。
   */
  @Prop @Watch('onGlobalRefreshTick') globalRefreshTick: number = 0;

  /** 全部 dots 会话（已排序、已按投影 preset 过滤）；只在 aboutToAppear / 重试 / 全局刷新时重读。 */
  @State chats: ChatIndexEntry[] = [];
  /** 读取失败原因；空串 = 无错误。 */
  @State errorText: string = '';
  /** 首次读取中。 */
  @State loading: boolean = true;
  /** 只读授权行（单一 aboutToAppear 内算一次；坏信封 / 空表 fail-closed 到「未授权 / 未知」）。 */
  @State grantLine: string = '';
  /** 发指令禁用原因：逐字来自 COMMAND_WORDING，经纯函数派生；常量与面板都不写第二份中文。 */
  @State refusalReason: string = '';

  aboutToAppear(): void {
    chatStore.prepare(getContext(this) as common.UIAbilityContext);
    this.reload();
    this.grantLine = this.buildGrantLine();
    this.refusalReason = this.buildRefusalReason();
  }

  /** 外壳全局刷新信号：一次周期的结果已落盘，这里只从 chatStore 重读，不重跑任何同步。 */
  onGlobalRefreshTick(): void {
    this.reload();
  }

  // ------------------------------------------------------------------ 数据

  /**
   * 只读授权行：只调 `instanceGrantStore.lastProblem()` / `redacted()`，绝不 grant / revoke。
   * 坏信封 / 空表 / 无有效实例 → 「未授权 / 未知」+ typed 原因，绝不声称权限存在；
   * 健康表 → 当前有效实例的 view 工具并集（canonical 顺序），命令工具固定给「未授予」结论。
   */
  private buildGrantLine(): string {
    const problem: GrantProblem = instanceGrantStore.lastProblem();
    const tail: string = GRANT_LINE_NO_COMMAND;
    if (problem !== 'ok') {
      return `${GRANT_LINE_PREFIX}未授权 / 未知（${problemText(problem)}）${tail}`;
    }
    const nowMs: number = Date.now();
    const views: RedactedGrant[] = instanceGrantStore.redacted(nowMs);
    const granted: string[] = [];
    let instances: number = 0;
    for (const view of views) {
      if (!view.active) {
        continue;
      }
      instances++;
      for (const tool of view.tools) {
        if (isViewTool(tool) && granted.indexOf(tool) < 0) {
          granted.push(tool);
        }
      }
    }
    if (instances === 0 || granted.length === 0) {
      return `${GRANT_LINE_PREFIX}未授权 / 未知${tail}`;
    }
    const ordered: string[] = [];
    for (const tool of VIEW_TOOLS) {
      if (granted.indexOf(tool) >= 0) {
        ordered.push(tool);
      }
    }
    return `${GRANT_LINE_PREFIX}${instances} 个实例已授权查看 ${ordered.join(' / ')}${tail}`;
  }

  /**
   * 禁用原因 = 前置条件 → 闸门文案的唯一映射（纯函数在 model 里，面板只喂布尔、只渲染结果）。
   * 坏信封 / 空表没有目标 ⇒ 目标缺失句；有目标但未显式授予 session.prompt ⇒ 未授权句；
   * 已授权但通道未过真机门禁 ⇒ 通道未校验句。今天 `remoteChannelVerified()` 恒 false。
   */
  private buildRefusalReason(): string {
    const problem: GrantProblem = instanceGrantStore.lastProblem();
    if (problem !== 'ok') {
      return placeholderRefusalReason({
        hasTarget: false, commandGranted: false, remoteVerified: remoteChannelVerified()
      });
    }
    const views: RedactedGrant[] = instanceGrantStore.redacted(Date.now());
    let hasTarget: boolean = false;
    let commandGranted: boolean = false;
    for (const view of views) {
      if (!view.active) {
        continue;
      }
      hasTarget = true;
      if (view.canPrompt) {
        commandGranted = true;
      }
    }
    return placeholderRefusalReason({
      hasTarget: hasTarget, commandGranted: commandGranted, remoteVerified: remoteChannelVerified()
    });
  }

  /** 读 `chats/index.jsonl` → 只取 dots 段 → 按更新时间倒序。失败只落 `errorText`，不抛。 */
  private async reload(): Promise<void> {
    this.errorText = '';
    this.loading = true;
    try {
      const result: ChatListResult = await chatStore.listChats();
      if (!result.ok) {
        this.chats = [];
        this.errorText = result.reason === undefined ? ERROR_WHAT : result.reason;
        this.loading = false;
        return;
      }
      this.chats = sortChats(filterBySegment(result.entries, PANE_KIND), 'updated');
    } catch (error) {
      this.chats = [];
      this.errorText = `${ERROR_WHAT}：${describeError(error)}`;
    }
    this.loading = false;
  }

  /** 进只读详情：与 `pages/Chats.ets` 一字一致，只传 id，不传会话正文。 */
  private openDetail(id: string): void {
    const params: Record<string, string> = { 'id': id };
    router.pushUrl({ url: 'pages/ChatDetail', params: params }).catch((error: Error) => {
      promptAction.showToast({ message: `打开会话失败：${describeError(error)}` });
    });
  }

  // ------------------------------------------------------------------ UI

  /** 一行会话：标题 + 摘要；整行可点，触摸目标 ≥ TOUCH_MIN。 */
  @Builder
  ChatRow(id: string, title: string, summary: string) {
    Column({ space: SPACING.xs }) {
      Text(title)
        .fontSize(FONT.body)
        .lineHeight(LINE_HEIGHT.body)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('app.color.text_primary'))
        .maxLines(2)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .width('100%')
        .textAlign(TextAlign.Start)
      Text(summary)
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontColor($r('app.color.text_secondary'))
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .width('100%')
        .textAlign(TextAlign.Start)
    }
    .width('100%')
    .constraintSize({ minHeight: TOUCH_MIN })
    .padding({ top: SPACING.md, bottom: SPACING.md })
    .alignItems(HorizontalAlign.Start)
    .onClick(() => {
      this.openDetail(id);
    })
  }

  /** 会话列表：行间 1vp 细线；滚动交给面板根 Scroll（竖屏 / 横屏都只有一层滚动容器）。 */
  @Builder
  ChatList() {
    Column() {
      ForEach(
        this.chats,
        (item: ChatIndexEntry) => {
          Column() {
            this.ChatRow(item.id, item.title, chatSummaryLine(item))
            Divider()
              .strokeWidth(DIVIDER)
              .color($r('app.color.divider'))
          }
          .width('100%')
        },
        (item: ChatIndexEntry) => `dots-chat-${item.id}`
      )
    }
    .width('100%')
  }

  /** 空态（没有投影为 dots 的会话）：只讲事实，显式不渲染按钮（没有可点的东西时出路靠 detail）。 */
  @Builder
  EmptyChats() {
    EmptyState({
      title: EMPTY_DOTS_TITLE,
      detail: EMPTY_DOTS_DETAIL,
      showAction: false
    })
  }

  /** 加载中：行内紧凑档，只显示等待，不阻塞后续重试。 */
  @Builder
  LoadingHint() {
    Column() {
      LoadingState({
        compact: true,
        title: loadingText('dots 会话')
      })
    }
    .width('100%')
    .padding({ top: SPACING.lg, bottom: SPACING.lg })
    .alignItems(HorizontalAlign.Start)
  }

  /** 读取失败：三段式 + 重试；「去设置」不在这里给（唯一设置出口是 rail 齿轮）。 */
  @Builder
  ErrorBlock() {
    Column() {
      ErrorState({
        what: ERROR_WHAT,
        why: this.errorText,
        next: ERROR_NEXT,
        onRetry: (): void => {
          this.reload();
        }
      })
    }
    .width('100%')
    .padding({ top: SPACING.lg, bottom: SPACING.lg })
    .alignItems(HorizontalAlign.Start)
  }

  build() {
    Scroll() {
      Column({ space: SPACING.md }) {
        Row() {
          Text('dots')
            .fontSize(FONT.title)
            .lineHeight(LINE_HEIGHT.title)
            .fontWeight(FontWeight.Medium)
            .fontColor($r('app.color.text_primary'))
            .layoutWeight(1)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
          Text(`发指令（${this.refusalReason}）`)
            .fontSize(FONT.caption)
            .lineHeight(LINE_HEIGHT.caption)
            .fontColor($r('app.color.text_secondary'))
            .height(TOUCH_MIN)
            .padding({ left: SPACING.sm, right: SPACING.sm })
            .enabled(false)
        }
        .width('100%')
        .alignItems(VerticalAlign.Center)
        .border({ width: { bottom: DIVIDER }, color: $r('app.color.divider') })

        Text(DOTS_SUBTITLE)
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
          .width('100%')

        Text(this.grantLine)
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
          .width('100%')
          .maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })

        if (this.errorText.length > 0) {
          this.ErrorBlock()
        } else if (this.loading && this.chats.length === 0) {
          this.LoadingHint()
        } else if (this.chats.length > 0) {
          this.ChatList()
        } else {
          this.EmptyChats()
        }
      }
      .width('100%')
      .padding({ left: SPACING.lg, right: SPACING.lg, top: SPACING.md, bottom: SPACING.xl })
    }
    .width('100%')
    .height('100%')
    .visibility(this.active ? Visibility.Visible : Visibility.Hidden)
  }
}
