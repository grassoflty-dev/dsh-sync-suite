/**
 * 云端对话 · 会话列表（P1 只读）。
 *
 * 数据源：同步仓库工作副本里的 `chats/index.jsonl`（见 `services/chatStore.ets` 与
 * `docs/CHAT-SYNC.md` §2.4）。页面只做三件事：搜索（`filterChats`）、按更新时间排序
 * （`sortChats`）、点行跳只读详情。
 *
 * 页面骨架走 `PageLayout`（`docs/UI-DESIGN.md` §4）：标题栏返回按钮、白底无卡片、
 * 颜色只用 `$r('app.color.*')`、字号只用 `FONT`、触控目标 ≥ `TOUCH_MIN`。
 * **首页页头不动**（仍只有「今天 / ⚙ 设置」）：本页入口在「设置 → 云端对话」。
 *
 * 三种非常规状态（`docs/CHAT-APP.md` 逐字记录）：
 * - **空态**（`chats/index.jsonl` 不存在，`ok:true`）：给出「怎么把会话弄过来」的操作指引，
 *   不是一句「暂无数据」——用户第一次进来几乎必然是这个状态；
 * - **错误态**（读文件失败，`ok:false`）：`ErrorText` + 「重试」，可恢复；
 * - **无匹配**（有会话但搜索词没命中）：提示清空搜索词，与「空态」区分开。
 *
 * 旋转/切页：数据全在 `@State` 里，`aboutToAppear` 加载一次；`onPageShow` 再读一次
 * （从详情页返回、或在别处下拉同步过之后，列表能自己变新）。
 */
import { promptAction, router } from '@kit.ArkUI';
import { common } from '@kit.AbilityKit';
import { chatSummaryLine, filterChats, sortChats } from '../model/chatList';
import type { ChatIndexEntry } from '../model/chatList';
import { chatStore } from '../services/chatStore';
import type { ChatListResult } from '../services/chatStore';
import { describeError } from '../services/scheduleStore';
import { syncController } from '../services/syncController';
import type { SyncOutcome } from '../services/syncController';
import { PageLayout } from '../components/PageLayout';
import { DIVIDER, FONT, LINE_HEIGHT, RADIUS, SPACING, TOUCH_MIN } from '../common/uiTokens';

/** 主按钮高度：40 + 8 = 48vp（与全站按钮一致，只用令牌组合）。 */
const BUTTON_HEIGHT: number = TOUCH_MIN + SPACING.sm;

/** 宽屏下内容最大宽度（vp）：单条会话行横跨宽屏会很难读。 */
const CONTENT_MAX_WIDTH: number = 720;

@Entry
@Component
struct Chats {
  /** 全部会话（已按更新时间倒序）。 */
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

  /** 读 `chats/index.jsonl` → 排序 → 过滤。失败只落 `errorText`，不抛。 */
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

  /** 重新按搜索词过滤（只算内存，不重读磁盘）。 */
  private applyQuery(): void {
    this.visibleChats = filterChats(this.chats, this.queryText);
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
    if (this.chats.length === 0) {
      return '只读 · 从同步仓库读取';
    }
    if (this.queryText.trim().length > 0) {
      return `只读 · 共 ${this.chats.length} 个会话 · 筛选出 ${this.visibleChats.length} 个`;
    }
    return `只读 · 共 ${this.chats.length} 个会话`;
  }

  // ------------------------------------------------------------------ UI

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
        Text('清空')
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.brand'))
          .height(TOUCH_MIN)
          .padding({ left: SPACING.sm, right: SPACING.sm })
          .textAlign(TextAlign.Center)
          .onClick(() => {
            this.queryText = '';
            this.applyQuery();
          })
      }
    }
    .width('100%')
    .alignItems(VerticalAlign.Center)
  }

  /**
   * 一行会话：标题 + 「只读」徽章 + 摘要行（`2026-11-18 14:03 · 42 条消息`）。
   *
   * 参数只收**基础类型**（id / 标题 / 摘要）：`@Builder` 传对象属于按值快照，
   * 列表刷新时容易被旧快照粘住；传字符串既便宜又不会踩这个坑。
   */
  @Builder
  ChatRow(id: string, title: string, summary: string) {
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
        // 「只读」徽章：非交互元素，不占独立触控区（整行都可点）
        Text('只读')
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
              this.ChatRow(item.id, item.title, chatSummaryLine(item))
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
   * 文案与 `docs/CHAT-APP.md` §3 一致：说清「去哪儿导出」「怎么同步过来」，
   * 而不是只写「暂无数据」让人无从下手。
   */
  @Builder
  EmptyChats() {
    Column({ space: SPACING.md }) {
      Text('还没有云端会话。')
        .fontSize(FONT.body)
        .lineHeight(LINE_HEIGHT.body)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('app.color.text_primary'))
        .width('100%')
        .textAlign(TextAlign.Start)
      Text('在电脑的 DSH 上运行一次会话后，点插件「云端对话 → 导出全部」即可同步到这里。')
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontColor($r('app.color.text_secondary'))
        .width('100%')
        .textAlign(TextAlign.Start)
      Text('导出并推送后，回到本页下拉刷新（或等 App 启动时自动拉取）就能看到列表。')
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontColor($r('app.color.text_secondary'))
        .width('100%')
        .textAlign(TextAlign.Start)
    }
    .width('100%')
    .padding({ top: SPACING.xl, bottom: SPACING.xl })
    .alignItems(HorizontalAlign.Start)
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
      Button('清空搜索')
        .height(BUTTON_HEIGHT)
        .fontSize(FONT.body)
        .backgroundColor($r('app.color.brand_soft'))
        .fontColor($r('app.color.brand'))
        .borderRadius(RADIUS.sm)
        .onClick(() => {
          this.queryText = '';
          this.applyQuery();
        })
    }
    .width('100%')
    .padding({ top: SPACING.xl, bottom: SPACING.xl })
    .alignItems(HorizontalAlign.Start)
  }

  /** 首次读取中：一行灰字，不占整页（读取通常只有几毫秒）。 */
  @Builder
  LoadingHint() {
    Text('正在读取云端会话…')
      .fontSize(FONT.caption)
      .lineHeight(LINE_HEIGHT.caption)
      .fontColor($r('app.color.text_secondary'))
      .width('100%')
      .padding({ top: SPACING.lg, bottom: SPACING.lg })
      .textAlign(TextAlign.Start)
  }

  /** 字段级错误文案（danger 令牌，深色模式下同样可见）。 */
  @Builder
  ErrorText(text: string) {
    Text(text)
      .fontSize(FONT.caption)
      .lineHeight(LINE_HEIGHT.caption)
      .fontColor($r('app.color.danger'))
      .width('100%')
      .textAlign(TextAlign.Start)
  }

  /** 错误态：`ErrorText` + 「重试」（可恢复，不把用户困在错误页）。 */
  @Builder
  ErrorBlock() {
    Column({ space: SPACING.md }) {
      this.ErrorText(this.errorText)
      Text('会话列表读不出来时，先确认本机已经拉取过同步仓库（设置 → 同步 → 立即拉取）。')
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontColor($r('app.color.text_secondary'))
        .width('100%')
        .textAlign(TextAlign.Start)
      Button('重试')
        .height(BUTTON_HEIGHT)
        .fontSize(FONT.body)
        .backgroundColor($r('app.color.brand'))
        .fontColor($r('app.color.text_inverse'))
        .borderRadius(RADIUS.sm)
        .onClick(() => {
          this.loading = true;
          this.reload();
        })
    }
    .width('100%')
    .padding({ top: SPACING.lg, bottom: SPACING.lg })
    .alignItems(HorizontalAlign.Start)
  }

  /** 列表区：错误 → 搜索框 + 下拉刷新（空态/列表/无匹配三选一）。 */
  @Builder
  Body() {
    Column({ space: SPACING.md }) {
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
}
