/**
 * 云端对话 · 会话列表（P1 只读）。
 *
 * 数据源：同步仓库工作副本里的 `chats/index.jsonl`（见 `services/chatStore.ets` 与
 * `docs/CHAT-SYNC.md` §2.4）。页面只做四件事：按 `kind` 分段（`filterByKind`）、
 * 搜索（`filterChats`）、按更新时间排序（`sortChats`）、点行跳只读详情。
 *
 * 顶部「纯云端对话 | dots 对话」两段共用同一份列表、搜索、三态与下拉刷新：切换只重算
 * `visibleChats`，不重读磁盘也不丢数据（`docs/CLOUD-CHAT-AND-DOTS.md` §2）。首页两个入口
 * 经 `kind` 路由参数预选分段；本片仍未接 dots 对话页，dots 行暂时沿用只读详情。
 *
 * 页面骨架走 `PageLayout`（`docs/UI-DESIGN.md` §4）：标题栏返回按钮、白底无卡片、
 * 颜色只用 `$r('app.color.*')`、字号只用 `FONT`、触控目标 ≥ `TOUCH_MIN`。
 * **首页页头不动**（仍只有「今天 / ⚙ 设置」）：本页入口在「设置 → 云端对话」。
 *
 * **no config surface**（mod-cloud-chat-no-config-note）：云端会话直接复用「设置 → 同步仓库」的 Git
 * 配置；本页没有独立设置面，不渲染配置行或机制说明段落，空态唯一下一步是「先在设置里配置仓库」。
 *
 * 三种非常规状态（`docs/CHAT-APP.md` 逐字记录，`docs/STATE-UI.md` §4 组件化）：
 * - **加载中**：`LoadingState`（行内紧凑档），3 秒后可取消——取消只停止「等待」，后台读文件可能仍会完成；
 * - **空态**（`chats/index.jsonl` 不存在，`ok:true`）：`EmptyState` 给出「怎么把会话弄过来」的操作指引
 *   与「下拉刷新试试」，不是一句「暂无数据」——用户第一次进来几乎必然是这个状态；
 * - **错误态**（读文件失败，`ok:false`）：`ErrorState` 三段式 + 诊断行 + 「重试」/「去设置」；
 * - **无匹配**（有会话但搜索词没命中）：提示清空搜索词，与「空态」区分开。
 *
 * 旋转/切页：数据全在 `@State` 里，`aboutToAppear` 加载一次；`onPageShow` 再读一次
 * （从详情页返回、或在别处下拉同步过之后，列表能自己变新）。
 */
import { promptAction, router } from '@kit.ArkUI';
import { common } from '@kit.AbilityKit';
import { loadingText } from '../common/copy';
import { APP_VERSION } from '../common/version';
import { chatSummaryLine, filterByKind, filterChats, sortChats } from '../model/chatList';
import type { ChatIndexEntry, ChatKind } from '../model/chatList';
import { formatDiagnostics } from '../model/stateView';
import type { DiagnosticsInput } from '../model/stateView';
import { chatStore } from '../services/chatStore';
import type { ChatListResult } from '../services/chatStore';
import { describeError } from '../services/scheduleStore';
import { syncController } from '../services/syncController';
import type { SyncOutcome } from '../services/syncController';
import { ActionButton } from '../components/ActionButton';
import { PageLayout } from '../components/PageLayout';
import { EmptyState } from '../components/state/EmptyState';
import { ErrorState } from '../components/state/ErrorState';
import { LoadingState } from '../components/state/LoadingState';
import { DIVIDER, FONT, LINE_HEIGHT, RADIUS, SPACING, TOUCH_MIN } from '../common/uiTokens';

/** 宽屏下内容最大宽度（vp）：单条会话行横跨宽屏会很难读。 */
const CONTENT_MAX_WIDTH: number = 720;

/** 诊断行里的错误码（列表读取失败）：固定值，便于用户反馈时检索。 */
const CHAT_LIST_ERROR_CODE: string = 'CHAT_LIST';

/** 云端段空态：唯一下一步 = 配置同步仓库；其余只是导出/同步的操作指引，不是配置或机制说明。 */
const EMPTY_CLOUD_TITLE: string = '还没有云端对话';
const EMPTY_CLOUD_DETAIL: string =
  '先在设置里配置仓库；之后在电脑点插件「云端对话 → 导出全部」并同步，下拉刷新即可看到；从首页「纯云端对话」可随时回来查看';
/** dots 段空态：说清 dots 能做什么、一切操作都要用户确认（没有假的输入框）。 */
const EMPTY_DOTS_TITLE: string = '还没有 dots 对话';
const EMPTY_DOTS_DETAIL: string =
  '从首页「与 dots 对话」进入本页；dots 可查看实例并对会话发指令，所有操作需你确认，当前为只读预览';
const EMPTY_ACTION: string = '下拉刷新试试';

/** 错误态文案：为什么失败由 `errorText` 运行时给。 */
const ERROR_WHAT: string = '读取会话列表失败';
const ERROR_NEXT: string = '先确认本机拉取过同步仓库（设置 → 同步 → 立即同步）';

@Entry
@Component
struct Chats {
  /** 顶部分段：cloud = 纯云端对话（默认左），dots = 与 dots 对话。 */
  @State kind: ChatKind = 'cloud';
  /** 全部会话（已按更新时间倒序，含两段；分段只在渲染前过滤）。 */
  @State chats: ChatIndexEntry[] = [];
  /** 当前渲染的列表（= `chats` 过一遍搜索词）。 */
  @State visibleChats: ChatIndexEntry[] = [];
  /** 搜索框原始输入。 */
  @State queryText: string = '';
  /** 读取失败原因；空串 = 无错误。 */
  @State errorText: string = '';
  /** 首次读取中（决定「正在读取…」提示，不阻塞后续刷新）。 */
  @State loading: boolean = true;
  /** 下拉刷新状态（`Refresh` 组件 `$$` 双向绑定）。 */
  @State refreshing: boolean = false;

  /** 页面是否已销毁（异步回调回来时不再 setState）。 */
  private disposed: boolean = false;

  aboutToAppear(): void {
    chatStore.prepare(getContext(this) as common.UIAbilityContext);
    // 首页双格条经路由参数预选分段；没有参数 / 坏参数都留在默认 cloud 段。
    this.kind = this.readKindParam();
    this.reload();
  }

  aboutToDisappear(): void {
    this.disposed = true;
  }

  /** 从详情页返回 / 从设置页回来：重读一次（文件很便宜，比让用户怀疑「怎么没更新」划算）。 */
  onPageShow(): void {
    if (!this.disposed) {
      this.reload();
    }
  }

  // ------------------------------------------------------------------ 数据

  /** 读路由参数 `kind`；只认 `dots`，其它一律回落默认 `cloud`（与 ChatDetail 的读法一致）。 */
  private readKindParam(): ChatKind {
    try {
      const params = router.getParams() as Record<string, string>;
      if (params === undefined || params === null) {
        return 'cloud';
      }
      return params['kind'] === 'dots' ? 'dots' : 'cloud';
    } catch (error) {
      return 'cloud';
    }
  }

  /** 读 `chats/index.jsonl` → 排序 → 分段 → 搜索过滤。失败只落 `errorText`，不抛。 */
  private async reload(): Promise<void> {
    this.errorText = '';
    try {
      const result: ChatListResult = await chatStore.listChats();
      if (this.disposed) {
        return;
      }
      if (!result.ok) {
        this.chats = [];
        this.visibleChats = [];
        this.errorText = result.reason === undefined ? '读取会话列表失败' : result.reason;
        this.loading = false;
        return;
      }
      this.chats = sortChats(result.entries, 'updated');
      this.applyQuery();
    } catch (error) {
      if (this.disposed) {
        return;
      }
      this.chats = [];
      this.visibleChats = [];
      this.errorText = `读取会话列表失败：${describeError(error)}`;
    }
    this.loading = false;
  }

  /** 重新按分段 + 搜索词过滤（只算内存，不重读磁盘；切段不丢数据）。 */
  private applyQuery(): void {
    this.visibleChats = filterChats(filterByKind(this.chats, this.kind), this.queryText);
  }

  /**
   * 下拉刷新：先尝试一次 Git 拉取（拿到电脑上刚导出的会话），再重读本地文件。
   *
   * 桥没就绪（没配仓库 / 还没加载同步内核）时**不报错**、也不 toast，只读本地已有内容——
   * 列表页不能因为「同步没配好」就整页不可用。
   */
  private async pullAndReload(): Promise<void> {
    try {
      if (syncController.isReady()) {
        const outcome: SyncOutcome = await syncController.pullNow();
        if (!outcome.ok && !outcome.skipped && !this.disposed) {
          promptAction.showToast({ message: `同步失败：${outcome.message}`, duration: 3000 });
        }
      }
    } catch (error) {
      if (!this.disposed) {
        promptAction.showToast({ message: `同步失败：${describeError(error)}`, duration: 3000 });
      }
    }
    await this.reload();
  }

  /**
   * 停止等待（`LoadingState.onCancel`）：只把本页的等待状态收掉，并诚实说明后台可能仍在读。
   *
   * **不**清 `chats`：已经读出来的列表不变；`errorText` 清空后如果仍然空，会落到空态（有出路）。
   */
  private stopWaiting(): void {
    this.loading = false;
    this.errorText = '';
    promptAction.showToast({ message: '已停止等待：稍后可下拉刷新重试' });
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

  /** 进只读详情：只传 `id`（会话内容由详情页自己读，参数不会被长文本撑爆）。 */
  private openDetail(id: string): void {
    const params: Record<string, string> = { 'id': id };
    router.pushUrl({ url: 'pages/ChatDetail', params: params }).catch((error: Error) => {
      promptAction.showToast({ message: `打开会话失败：${describeError(error)}` });
    });
  }

  /** 标题栏副标题：一句统计 / 一句状态（空态不写「0 个会话」，避免和列表空态重复）。 */
  private subtitleText(): string {
    if (this.errorText.length > 0) {
      return '读取失败';
    }
    if (this.loading && this.chats.length === 0) {
      return '正在读取…';
    }
    // 计数按当前分段：切到 dots 段时不该显示云端段的会话总数。
    const segmentCount: number = filterByKind(this.chats, this.kind).length;
    if (segmentCount === 0) {
      return '只读';
    }
    if (this.queryText.trim().length > 0) {
      return `只读 · 共 ${segmentCount} 个会话 · 筛选出 ${this.visibleChats.length} 个`;
    }
    return `只读 · 共 ${segmentCount} 个会话`;
  }

  // ------------------------------------------------------------------ UI

  /**
   * 顶部分段：默认左侧「纯云端对话」，右侧「dots 对话」。
   * 选中段用 `secondary` 控件灰底、未选中用 `ghost`；切换只重算 `visibleChats`，
   * 搜索词 / 三态 / 下拉刷新全部复用（不重读磁盘，不丢数据）。
   */
  @Builder
  KindSegment() {
    Row({ space: SPACING.sm }) {
      Column() {
        ActionButton({
          label: '纯云端对话',
          actionEnabled: true,
          disabledReason: '',
          busy: false,
          variant: this.kind === 'cloud' ? 'secondary' : 'ghost',
          block: true,
          onTap: (): void => {
            this.kind = 'cloud';
            this.applyQuery();
          },
          onBlockedTap: null
        })
      }
      .layoutWeight(1)

      Column() {
        ActionButton({
          label: 'dots 对话',
          actionEnabled: true,
          disabledReason: '',
          busy: false,
          variant: this.kind === 'dots' ? 'secondary' : 'ghost',
          block: true,
          onTap: (): void => {
            this.kind = 'dots';
            this.applyQuery();
          },
          onBlockedTap: null
        })
      }
      .layoutWeight(1)
    }
    .width('100%')
    .alignItems(VerticalAlign.Center)
  }

  /** 搜索框 + 「清空」（清空只在有输入时出现，避免常驻噪音）。 */
  @Builder
  SearchBar() {
    Row({ space: SPACING.sm }) {
      TextInput({ text: this.queryText, placeholder: '搜索会话标题' })
        .fontSize(FONT.body)
        .placeholderFont({ size: FONT.caption })
        .height(TOUCH_MIN)
        .backgroundColor($r('app.color.surface'))
        .borderRadius(RADIUS.sm)
        .padding({ left: SPACING.md, right: SPACING.md })
        .layoutWeight(1)
        .onChange((value: string) => {
          this.queryText = value;
          this.applyQuery();
        })
      if (this.queryText.length > 0) {
        ActionButton({
          label: '清空',
          actionEnabled: true,
          disabledReason: '',
          busy: false,
          variant: 'ghost',
          block: false,
          onTap: (): void => {
            this.queryText = '';
            this.applyQuery();
          },
          onBlockedTap: null
        })
      }
    }
    .width('100%')
    .alignItems(VerticalAlign.Center)
  }

  /**
   * 一行会话：标题 + `chat`/`dots` 徽章 + 摘要行（`2026-11-18 14:03 · 42 条消息`）。
   *
   * 徽章替代原来固定的「只读」（`docs/CLOUD-CHAT-AND-DOTS.md` §2）：两段共用一行渲染，
   * 只读性由本页没有输入框 + 详情页的「在电脑上继续」保证，不再用「只读」占位。
   * 参数只收**基础类型**（id / 标题 / 摘要 / 徽章）：`@Builder` 传对象属于按值快照，
   * 列表刷新时容易被旧快照粘住；传字符串既便宜又不会踩这个坑。
   */
  @Builder
  ChatRow(id: string, title: string, summary: string, badge: string) {
    Column({ space: SPACING.xs }) {
      Row({ space: SPACING.sm }) {
        Text(title)
          .fontSize(FONT.body)
          .lineHeight(LINE_HEIGHT.body)
          .fontWeight(FontWeight.Medium)
          .fontColor($r('app.color.text_primary'))
          .maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
          .textAlign(TextAlign.Start)
        // 种类徽章：非交互元素，不占独立触控区（整行都可点）
        Text(badge)
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
          .backgroundColor($r('app.color.control_fill'))
          .borderRadius(RADIUS.sm)
          .padding({ left: SPACING.sm, right: SPACING.sm })
          .flexShrink(0)
          .maxLines(1)
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

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

  /** 会话列表（行间 1vp 细线，与全站列表一致）。 */
  @Builder
  ChatList() {
    List() {
      ForEach(
        this.visibleChats,
        (item: ChatIndexEntry) => {
          ListItem() {
            Column() {
              this.ChatRow(item.id, item.title, chatSummaryLine(item),
                item.kind === 'dots' ? 'dots' : 'chat')
              Divider()
                .strokeWidth(DIVIDER)
                .color($r('app.color.divider'))
            }
            .width('100%')
            .alignItems(HorizontalAlign.Start)
          }
        },
        (item: ChatIndexEntry) => `chat-${item.id}`
      )
    }
    .width('100%')
    .height('100%')
    .scrollBar(BarState.Off)
  }

  /**
   * 空态：**必须带操作指引**（用户第一次进来几乎必然是这个状态）。
   *
   * 两段各自的空文案不同：云端说清「去哪儿导出 / 怎么同步过来」（`docs/CHAT-APP.md` §3），
   * dots 说清「它能做什么 / 操作要你确认」。两态都给真按钮（`EmptyState` 兜底），
   * 不渲染假行、不写「暂无数据」。
   */
  @Builder
  EmptyCloudChats() {
    EmptyState({
      title: EMPTY_CLOUD_TITLE,
      detail: EMPTY_CLOUD_DETAIL,
      actionLabel: EMPTY_ACTION,
      onAction: (): void => {
        this.pullAndReload();
      }
    })
  }

  /** dots 段空态：只读预览 + 需确认的说明，下一步仍是刷新（没有假的输入框）。 */
  @Builder
  EmptyDotsChats() {
    EmptyState({
      title: EMPTY_DOTS_TITLE,
      detail: EMPTY_DOTS_DETAIL,
      actionLabel: EMPTY_ACTION,
      onAction: (): void => {
        this.pullAndReload();
      }
    })
  }

  /** 按当前分段落空态；两段共用同一个刷新出口。 */
  @Builder
  EmptyChats() {
    if (this.kind === 'dots') {
      this.EmptyDotsChats()
    } else {
      this.EmptyCloudChats()
    }
  }

  /** 有会话但搜索没命中：与空态区分（否则用户会以为会话被删了）。 */
  @Builder
  NoMatch() {
    Column({ space: SPACING.md }) {
      Text('没有匹配的会话')
        .fontSize(FONT.body)
        .lineHeight(LINE_HEIGHT.body)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('app.color.text_primary'))
        .width('100%')
        .textAlign(TextAlign.Start)
      Text('换个关键词，或清空搜索框看全部会话。')
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontColor($r('app.color.text_secondary'))
        .width('100%')
        .textAlign(TextAlign.Start)
      ActionButton({
        label: '清空搜索',
        actionEnabled: true,
        disabledReason: '',
        busy: false,
        variant: 'secondary',
        block: false,
        onTap: (): void => {
          this.queryText = '';
          this.applyQuery();
        },
        onBlockedTap: null
      })
    }
    .width('100%')
    .padding({ top: SPACING.xl, bottom: SPACING.xl })
    .alignItems(HorizontalAlign.Start)
  }

  /** 首次读取中：行内紧凑档（读取通常只有几毫秒），3 秒后可取消（只停止等待）。 */
  @Builder
  LoadingHint() {
    Column() {
      LoadingState({
        compact: true,
        title: loadingText('云端会话'),
        onCancel: (): void => {
          this.stopWaiting();
        }
      })
    }
    .width('100%')
    .padding({ top: SPACING.lg, bottom: SPACING.lg })
    .alignItems(HorizontalAlign.Start)
  }

  /** 错误态：三段式 + 诊断行 + 「重试」/「去设置」（可恢复，不把用户困在错误页）。 */
  @Builder
  ErrorBlock() {
    Column() {
      ErrorState({
        what: ERROR_WHAT,
        why: this.errorText,
        next: ERROR_NEXT,
        diagnostics: this.diagnosticsText(CHAT_LIST_ERROR_CODE),
        onRetry: (): void => {
          this.loading = true;
          this.reload();
        },
        onOpenSettings: (): void => {
          router.pushUrl({ url: 'pages/Settings' }).catch((error: Error) => {
            promptAction.showToast({ message: `打开设置页失败：${describeError(error)}` });
          });
        }
      })
    }
    .width('100%')
    .padding({ top: SPACING.lg, bottom: SPACING.lg })
    .alignItems(HorizontalAlign.Start)
  }

  /** 列表区：分段（常驻）→ 错误 → 搜索框 + 下拉刷新（空态/列表/无匹配三选一）。 */
  @Builder
  Body() {
    Column({ space: SPACING.md }) {
      // 分段常驻：错误态下也能切段看另一段（错误来自本地读文件，与 kind 无关）
      this.KindSegment()
      if (this.errorText.length > 0) {
        this.ErrorBlock()
      } else {
        this.SearchBar()
        Refresh({ refreshing: $$this.refreshing }) {
          Column() {
            if (this.loading && this.chats.length === 0) {
              this.LoadingHint()
            } else if (this.visibleChats.length > 0) {
              this.ChatList()
            } else if (this.chats.length === 0) {
              this.EmptyChats()
            } else {
              this.NoMatch()
            }
          }
          .width('100%')
          .height('100%')
          .alignItems(HorizontalAlign.Start)
        }
        .width('100%')
        .layoutWeight(1)
        .onRefreshing(() => {
          this.refreshing = true;
          this.pullAndReload()
            .then(() => {
              this.refreshing = false;
            })
            .catch(() => {
              this.refreshing = false;
            });
        })
      }
    }
    .width('100%')
    .height('100%')
    .constraintSize({ maxWidth: CONTENT_MAX_WIDTH })
    .alignItems(HorizontalAlign.Start)
  }

  build() {
    // 根节点必须是**容器组件**：`PageLayout(...) { ... }` 尾随闭包形式只能出现在容器内部，
    // 直接当 @Entry 的 build() 根节点会被 ArkTS 拒绝（10905210，2026-11-18 构建实测）。
    // 与 Detail/Edit/Index/Settings 保持同一形态：Stack 兜底，PageLayout 作为其唯一子节点。
    Stack({ alignContent: Alignment.TopStart }) {
      PageLayout({
        title: '云端对话',
        subtitle: this.subtitleText(),
        onBack: () => {
          router.back();
        }
      }) {
        this.Body()
      }
    }
    .width('100%')
    .height('100%')
  }
}
