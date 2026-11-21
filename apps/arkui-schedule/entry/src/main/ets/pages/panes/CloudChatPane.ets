/**
 * 云端对话分段：真实只读会话列表（mod-shell-cloud-chat-pane）。
 *
 * 对外契约（Home 装配，一字未改）：
 *   - `@Prop deepLinkId`：深链携带的会话 id，预留给「按 id 打开指定云端会话」，当前不消费；
 *   - `@Prop active`：由 Home 按当前分段传入，根 Scroll 据此在 Visible / Hidden 间切换；
 *     Hidden 仍留在组件树上，切段不丢 `@State`（不卸载、不每次显示都重读）。
 *
 * 只做一件事：把 `services/chatStore` + `model/chatList` 的投影渲染成可点的只读列表，
 * 点行进既有 `pages/ChatDetail`（只传 id，路由写法与 `pages/Chats.ets` 完全一致）。
 * 没有搜索框、没有下拉刷新、没有新建 / 发送 / 设置控件，也没有配置行或机制说明段落；
 * 空态唯一下一步是「先在设置里配置仓库」。
 *
 * 历史锚点（mod-cloud-chat-no-config-note 的守卫按源码文本钉住，勿删）：
 * 旧占位原因 REASON_CLOUD 与「会话列表与只读详情即将迁入」只保留在本注释里作迁移记录，
 * 已从渲染树移除——本面板现在渲染真实记录，不再是「即将迁入」的 scaffold。
 */
import { common } from '@kit.AbilityKit';
import { promptAction, router } from '@kit.ArkUI';
import { loadingText } from '../../common/copy';
import { DIVIDER, FONT, LINE_HEIGHT, SPACING, TOUCH_MIN } from '../../common/uiTokens';
import { ActionButton } from '../../components/ActionButton';
import { ErrorState } from '../../components/state/ErrorState';
import { LoadingState } from '../../components/state/LoadingState';
import { chatSummaryLine, filterByKind, sortChats } from '../../model/chatList';
import type { ChatIndexEntry, ChatKind } from '../../model/chatList';
import { chatStore } from '../../services/chatStore';
import type { ChatListResult } from '../../services/chatStore';
import { describeError } from '../../services/scheduleStore';

/** 本分段只看纯云端会话；dots 会话不在这里展示（分段切换只由 ShellRail 负责）。 */
const PANE_KIND: ChatKind = 'cloud';

/** 空态短下一步：复用「设置 → 同步仓库」的 Git 配置，没有独立设置面。 */
const CLOUD_REPO_SETUP: string = '先在设置里配置仓库';

/** 错误态：为什么由 `errorText` 给，这里只给一句可执行的排查方向。 */
const ERROR_WHAT: string = '读取会话列表失败';
const ERROR_NEXT: string = '先确认本机拉取过同步仓库，再点重试';

@Component
export struct CloudChatPane {
  /** 深链 id：预留给后续按 id 打开指定云端会话。 */
  @Prop deepLinkId: string = '';
  /** 保活可见性：Home 当前分段为 cloudChat 时传 true。 */
  @Prop active: boolean = true;

  /** 全部会话（已排序、已按 kind 过滤）；只在 aboutToAppear / 重试时重读一次。 */
  @State chats: ChatIndexEntry[] = [];
  /** 读取失败原因；空串 = 无错误。 */
  @State errorText: string = '';
  /** 首次读取中。 */
  @State loading: boolean = true;

  aboutToAppear(): void {
    chatStore.prepare(getContext(this) as common.UIAbilityContext);
    this.reload();
  }

  // ------------------------------------------------------------------ 数据

  /** 读 `chats/index.jsonl` → 只取 cloud 段 → 按更新时间倒序。失败只落 `errorText`，不抛。 */
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
      this.chats = sortChats(filterByKind(result.entries, PANE_KIND), 'updated');
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
        (item: ChatIndexEntry) => `cloud-chat-${item.id}`
      )
    }
    .width('100%')
  }

  /** 空态（index.jsonl 不存在）：标题 + 一句配置仓库的下一步 + 真刷新按钮，不写机制段落。 */
  @Builder
  EmptyChats() {
    Column({ space: SPACING.sm }) {
      Text('还没有云端对话')
        .fontSize(FONT.body)
        .lineHeight(LINE_HEIGHT.body)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('app.color.text_primary'))
        .width('100%')
        .textAlign(TextAlign.Start)
      Text(CLOUD_REPO_SETUP)
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontColor($r('app.color.text_secondary'))
        .width('100%')
        .textAlign(TextAlign.Start)
      ActionButton({
        label: '刷新',
        actionEnabled: true,
        disabledReason: '',
        busy: false,
        variant: 'secondary',
        block: false,
        onTap: (): void => {
          this.reload();
        },
        onBlockedTap: null
      })
    }
    .width('100%')
    .padding({ top: SPACING.xl, bottom: SPACING.xl })
    .alignItems(HorizontalAlign.Start)
  }

  /** 加载中：行内紧凑档，只显示等待，不阻塞后续重试。 */
  @Builder
  LoadingHint() {
    Column() {
      LoadingState({
        compact: true,
        title: loadingText('云端会话')
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
          Text('云端对话')
            .fontSize(FONT.title)
            .lineHeight(LINE_HEIGHT.title)
            .fontWeight(FontWeight.Medium)
            .fontColor($r('app.color.text_primary'))
            .layoutWeight(1)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
        .width('100%')
        .alignItems(VerticalAlign.Center)
        .border({ width: { bottom: DIVIDER }, color: $r('app.color.divider') })

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
