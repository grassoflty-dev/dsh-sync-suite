/**
 * 云端对话 · 只读详情（P1）。
 *
 * 数据源：`chats/<id>/meta.json` + `chats/<id>/session.jsonl`（见 `services/chatStore.ets`）。
 * **只读**是产品约束，不是暂时没做：`docs/CHAT-SYNC.md` §1/§5 规定同一会话同一时刻只有一个写者，
 * 平板在这里续写会制造两条分叉的事件流（§1.1 的坏结局）。所以本页：
 * - 顶部固定一条说明「这是从 Git 同步来的只读会话，不能在这里继续对话」；
 * - **底部没有输入框**，也没有发送按钮（不给假入口）；
 * - 工具调用只显示一行灰字等宽摘要（`🔧 <name>`），不渲染参数/结果（参数含绝对路径与命令输出）。
 *
 * 排版选择：**统一左对齐 + 角色小字**，而不是「user 右 / assistant 左」的双侧气泡。
 * 理由（更省空间）：会话正文常有代码块与长段落，双侧气泡要为主/客各留一份左右边距与最大宽度，
 * 窄屏（竖屏平板 673vp、手机 360–430vp）下会把可用行宽压掉 20–30%；统一左对齐能整行铺满。
 *
 * 旋转/切页：`messages` / 标题都在 `@State`，`aboutToAppear` 读一次即可（旋转不重新读盘）。
 */
import { router } from '@kit.ArkUI';
import { common } from '@kit.AbilityKit';
import { formatChatTime } from '../model/chatList';
import type { ChatMessage } from '../model/chatList';
import { chatStore } from '../services/chatStore';
import type { ChatDetailResult } from '../services/chatStore';
import { describeError } from '../services/scheduleStore';
import { PageLayout } from '../components/PageLayout';
import { DIVIDER, FONT, LINE_HEIGHT, RADIUS, SPACING, TOUCH_MIN } from '../common/uiTokens';

/** 主按钮高度：40 + 8 = 48vp（与全站按钮一致）。 */
const BUTTON_HEIGHT: number = TOUCH_MIN + SPACING.sm;

/** 宽屏下正文最大宽度（vp）：整行铺满宽屏会让 16fp 正文一行过长、难回行。 */
const CONTENT_MAX_WIDTH: number = 720;

/** 标题兜底（meta.title 缺失 / 为空时，页头也不能空着）。 */
const FALLBACK_TITLE: string = '云端会话';

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

  private disposed: boolean = false;

  aboutToAppear(): void {
    this.chatId = this.readParamId();
    chatStore.prepare(getContext(this) as common.UIAbilityContext);
    this.load();
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

  /** 空态：文件完整但没有任何可读消息（全是工具/用量事件也会这样）。 */
  @Builder
  EmptyMessages() {
    Column({ space: SPACING.md }) {
      Text('这个会话没有可读的消息内容')
        .fontSize(FONT.body)
        .lineHeight(LINE_HEIGHT.body)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('app.color.text_primary'))
        .width('100%')
        .textAlign(TextAlign.Start)
      Text('工具输出、用量统计等事件不在只读视图里展示；换个会话看看。')
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

  /** 字段级错误文案（danger 令牌）。 */
  @Builder
  ErrorText(text: string) {
    Text(text)
      .fontSize(FONT.caption)
      .lineHeight(LINE_HEIGHT.caption)
      .fontColor($r('app.color.danger'))
      .width('100%')
      .textAlign(TextAlign.Start)
  }

  /** 错误态：原因 + 「重试」+ 返回列表的出路。 */
  @Builder
  ErrorBlock() {
    Column({ space: SPACING.md }) {
      this.ErrorText(this.errorText)
      Text('文件可能只同步了一半；下拉刷新列表或稍后重试。')
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontColor($r('app.color.text_secondary'))
        .width('100%')
        .textAlign(TextAlign.Start)
      Row({ space: SPACING.md }) {
        Button('重试')
          .height(BUTTON_HEIGHT)
          .fontSize(FONT.body)
          .backgroundColor($r('app.color.brand'))
          .fontColor($r('app.color.text_inverse'))
          .borderRadius(RADIUS.sm)
          .onClick(() => {
            this.load();
          })
        Button('返回列表')
          .height(BUTTON_HEIGHT)
          .fontSize(FONT.body)
          .backgroundColor($r('app.color.brand_soft'))
          .fontColor($r('app.color.brand'))
          .borderRadius(RADIUS.sm)
          .onClick(() => {
            router.back();
          })
      }
      .width('100%')
      .justifyContent(FlexAlign.Start)
    }
    .width('100%')
    .padding({ top: SPACING.lg, bottom: SPACING.lg })
    .alignItems(HorizontalAlign.Start)
  }

  /** 首次读取中的一行灰字。 */
  @Builder
  LoadingHint() {
    Text('正在读取会话…')
      .fontSize(FONT.caption)
      .lineHeight(LINE_HEIGHT.caption)
      .fontColor($r('app.color.text_secondary'))
      .width('100%')
      .padding({ top: SPACING.lg, bottom: SPACING.lg })
      .textAlign(TextAlign.Start)
  }

  build() {
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
      }
      .width('100%')
      .height('100%')
      .constraintSize({ maxWidth: CONTENT_MAX_WIDTH })
      .alignItems(HorizontalAlign.Start)
    }
  }
}
