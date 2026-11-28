/**
 * 云端对话 · 会话列表（内容只读；每条会话可单条删除）。
 *
 * 数据源：同步仓库工作副本里的 `chats/index.jsonl`（见 `services/chatStore.ets` 与
 * `docs/CHAT-SYNC.md` §2.4）。页面做五件事：按 `kind` 分段（`filterByKind`）、
 * 搜索（`filterChats`）、按更新时间排序（`sortChats`）、点行跳只读详情、
 * **逐行**「删除」打开确认 sheet（mod-app-chat-hide）。
 *
 * 删除入口的形状是刻意的：`ChatRow` 内一行一个 `ActionButton`，`askHide(id)` 只接这一行的
 * 单个 id 字符串并写进单个 `@State pendingId`；没有长按、没有滑动、没有多选 / 批量 API，
 * 所以一次确认永远只隐藏一条会话。sheet 文案逐字来自 `chatHidePlanOf()`；确认失败时
 * `confirmHide()` 无条件重读索引，不保留本地乐观隐藏（索引是唯一真相）。
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
 * 配置；本页没有独立设置面，不渲染配置行或机制说明段落；空态只陈述事实，配置仓库仍是前提但不是下一步按钮。
 *
 * 三种非常规状态（`docs/CHAT-APP.md` 逐字记录，`docs/STATE-UI.md` §4 组件化）：
 * - **加载中**：`LoadingState`（行内紧凑档），3 秒后可取消——取消只停止「等待」，后台读文件可能仍会完成；
 * - **空态**（`chats/index.jsonl` 不存在，`ok:true`）：只讲事实——会话在后台自动同步，回到本页（或下拉刷新）
 *   即可看到更新；按产品规则不渲染同步 / 导出按钮，也不是一句「暂无数据」；
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
import { chatHidePlanOf, hideReasonOf } from '../model/chatHide';
import type { ChatHidePlan } from '../model/chatHide';
import { formatDiagnostics } from '../model/stateView';
import type { DiagnosticsInput } from '../model/stateView';
import { chatStore } from '../services/chatStore';
import type { ChatListResult, HideOutcome } from '../services/chatStore';
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

/** 云端段空态：只讲事实——配置同步仓库后会话自动同步；没有同步 / 导出按钮。 */
const EMPTY_CLOUD_TITLE: string = '还没有云端对话';
const EMPTY_CLOUD_DETAIL: string =
  '先在设置里配置仓库；之后云端会话会在后台自动同步过来；列表在下次同步后更新，回到本页即可看到。';
/** dots 段空态：说清 dots 能做什么、一切操作都要用户确认（没有假的输入框、没有按钮）。 */
const EMPTY_DOTS_TITLE: string = '还没有 dots 对话';
const EMPTY_DOTS_DETAIL: string =
  '从首页「与 dots 对话」进入本页；dots 可查看实例并对会话发指令，所有操作需你确认，当前为只读预览；列表在下次同步后更新，回到本页即可看到。';

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

  // ---- mod-app-chat-hide：逐行删除（单 id，无批量状态） ----
  /** 正在确认的**单条**会话 id（空串 = 没有待确认项）；不存在 id 数组 / 多选集合。 */
  @State pendingId: string = '';
  /** 确认 sheet 文案（纯模型唯一来源，页面不拼规则）。 */
  @State hidePlan: ChatHidePlan = chatHidePlanOf();
  /** 确认 sheet 开关（`bindSheet` 唯一入口）。 */
  @State showHideSheet: boolean = false;
  /** 删除进行中：重复点击不产生第二次写。 */
  @State hiding: boolean = false;
  /** 失败说明（空串 = 不显示）；成功只 toast，不在这里声称跨设备已一致。 */
  @State hideHint: string = '';

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

  // ---------------------------------------------------------- 逐行删除（mod-app-chat-hide）

  /**
   * 第一步：某一行的「删除」按钮只把**那一行**的 id 交给 sheet，不写任何数据。
   * 入参是单个 `string`，没有数组 / 批量入口；`hiding` 时忽略重复点击。
   */
  private askHide(id: string): void {
    if (this.hiding || id.length === 0) {
      return;
    }
    this.pendingId = id;
    this.hidePlan = chatHidePlanOf();
    this.hideHint = '';
    this.showHideSheet = true;
  }

  /** 取消：sheet 关闭、待确认项清空，不写任何数据。 */
  private cancelHide(): void {
    this.showHideSheet = false;
    this.pendingId = '';
    this.hidePlan = chatHidePlanOf();
  }

  /**
   * 第二步：一次确认只删 `pendingId` 这一条。失败原因取写者的四句 typed 中文文案，
   * 逐字展示（不泄漏原始错误、不冒称成功）；无论成败都重读索引，绝不留乐观隐藏。
   */
  private async confirmHide(): Promise<void> {
    const id: string = this.pendingId;
    if (this.hiding || id.length === 0) {
      return;
    }
    this.hiding = true;
    try {
      const outcome: HideOutcome = await chatStore.hideChat(id);
      if (outcome.ok) {
        this.showHideSheet = false;
        this.pendingId = '';
        this.hideHint = '';
        promptAction.showToast({ message: '已删除；会话不再显示在本机列表' });
      } else {
        this.hideHint = outcome.reason;
        promptAction.showToast({ message: outcome.reason, duration: 4000 });
      }
    } catch (error) {
      // 写者对页面永不抛；兜底也只用模型的 typed 文案，不把原始错误带进界面。
      this.hideHint = hideReasonOf('prepare');
    } finally {
      this.hiding = false;
      await this.reload();
    }
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
      return '可逐条删除';
    }
    if (this.queryText.trim().length > 0) {
      return `可逐条删除 · 共 ${segmentCount} 个会话 · 筛选出 ${this.visibleChats.length} 个`;
    }
    return `可逐条删除 · 共 ${segmentCount} 个会话`;
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
   * 会话内容不可编辑（没有输入框、详情页只给「在电脑上继续」），但行尾有一个逐条删除按钮。
   * 参数只收**基础类型**（id / 标题 / 摘要 / 徽章）：`@Builder` 传对象属于按值快照，
   * 列表刷新时容易被旧快照粘住；传字符串既便宜又不会踩这个坑。
   */
  @Builder
  ChatRow(id: string, title: string, summary: string, badge: string) {
    Row({ space: SPACING.sm }) {
      // 只有这块「标题 + 徽章 + 摘要」区域进详情；删除按钮是兄弟节点，
      // 所以按钮的点击不会冒泡到 openDetail（不靠手势拦截，避免误触整行）。
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
          // 种类徽章：非交互元素，不占独立触控区（详情区都可点）
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
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)
      .constraintSize({ minHeight: TOUCH_MIN })
      .onClick(() => {
        this.openDetail(id);
      })

      // 每行恰好一个删除按钮：只携带本行的 id，不长按、不滑动、不多选。
      Column() {
        ActionButton({
          label: this.hidePlan.confirmLabel,
          actionEnabled: true,
          disabledReason: '',
          busy: this.hiding && this.pendingId === id,
          variant: 'danger',
          block: false,
          onTap: (): void => {
            this.askHide(id);
          },
          onBlockedTap: null
        })
      }
      .flexShrink(0)
      .alignItems(HorizontalAlign.Center)
    }
    .width('100%')
    .constraintSize({ minHeight: TOUCH_MIN })
    .padding({ top: SPACING.md, bottom: SPACING.md })
    .alignItems(VerticalAlign.Center)
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
   * 空态：**只讲事实，不给按钮**（产品规则：不要有同步 / 导出按钮）。
   *
   * 两段各自的空文案不同：云端说清「先在设置里配置，之后后台自动同步」（`docs/CHAT-APP.md` §3），
   * dots 说清「它能做什么 / 操作要你确认」。两态都显式 `showAction: false`，出路由 `detail` 的
   * 事实句承担，不渲染假行、不写「暂无数据」。
   */
  @Builder
  EmptyCloudChats() {
    EmptyState({
      title: EMPTY_CLOUD_TITLE,
      detail: EMPTY_CLOUD_DETAIL,
      showAction: false
    })
  }

  /** dots 段空态：只读预览 + 需确认的说明 + 自动同步的事实；没有假的输入框，也没有按钮。 */
  @Builder
  EmptyDotsChats() {
    EmptyState({
      title: EMPTY_DOTS_TITLE,
      detail: EMPTY_DOTS_DETAIL,
      showAction: false
    })
  }

  /** 按当前分段落空态；两段都不渲染按钮，只读事实句。 */
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

  /**
   * 删除确认 sheet（mod-app-chat-hide）：标题 / 两行正文 / 「删除」「取消」全部逐字来自
   * `chatHidePlanOf()`；没有恢复入口、没有「归档」第二个名词，也没有任何可逆承诺。
   */
  @Builder
  HideConfirmSheet() {
    Column({ space: SPACING.md }) {
      Text(this.hidePlan.title)
        .fontSize(FONT.title)
        .lineHeight(LINE_HEIGHT.title)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('app.color.text_primary'))
        .width('100%')
        .textAlign(TextAlign.Start)
      ForEach(this.hidePlan.lines, (line: string) => {
        Text(line)
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
          .width('100%')
          .textAlign(TextAlign.Start)
      }, (line: string) => line)
      Row({ space: SPACING.sm }) {
        Column() {
          ActionButton({
            label: this.hidePlan.cancelLabel,
            actionEnabled: true,
            disabledReason: '',
            busy: false,
            variant: 'secondary',
            block: true,
            onTap: (): void => {
              this.cancelHide();
            },
            onBlockedTap: null
          })
        }
        .layoutWeight(1)
        Column() {
          ActionButton({
            label: this.hidePlan.confirmLabel,
            actionEnabled: true,
            disabledReason: '',
            busy: this.hiding,
            variant: 'danger',
            block: true,
            onTap: (): void => {
              this.confirmHide();
            },
            onBlockedTap: null
          })
        }
        .layoutWeight(1)
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)
    }
    .width('100%')
    .padding(SPACING.lg)
    .alignItems(HorizontalAlign.Start)
  }

  /** 列表区：分段（常驻）→ 失败说明 → 错误 → 搜索框 + 下拉刷新（空态/列表/无匹配三选一）。 */
  @Builder
  Body() {
    Column({ space: SPACING.md }) {
      // 分段常驻：错误态下也能切段看另一段（错误来自本地读文件，与 kind 无关）
      this.KindSegment()
      // 删除失败说明：逐字取写者的 typed 文案；成功后清空，不伪造「已同步到其它设备」。
      if (this.hideHint.length > 0) {
        Text(this.hideHint)
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.danger'))
          .width('100%')
          .textAlign(TextAlign.Start)
      }
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
    .bindSheet(this.showHideSheet, this.HideConfirmSheet(), {
      height: SheetSize.MEDIUM,
      dragBar: true,
      showClose: true,
      onDisappear: (): void => {
        this.showHideSheet = false;
      }
    })
  }
}
