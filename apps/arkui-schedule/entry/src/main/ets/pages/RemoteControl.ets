/**
 * 远程控制页：用内嵌 `Web` 直接打开电脑上的 DSH Web UI（`http://<电脑IP>:3080/?token=…`）。
 *
 * 为什么不做原生界面：DSH 的会话/工作区面板是网页实现的，平板只要能在局域网里连上，
 * 内嵌 Web 就是最省事、也不会随 DSH 改版而失效的做法（与 `GitBridgeHost` 内嵌 rawfile 同理）。
 *
 * 地址来源（优先级从高到低）：
 * 1. `router` 参数里的 `url`（设置页「打开远程控制」已经归一 + 落盘后带过来）；
 * 2. `settingsStore.load().remoteUrl`（直接进本页、或从历史栈返回时参数已丢）。
 * 两者都拿不到（或都非法）→ 页面只显示「先到设置里填写 DSH 地址」+「去设置」，**不**挂 Web。
 *
 * 页面状态机（`phase`）：
 * - `loading`：刚进页面，正在读参数/本机设置（不渲染 Web，避免闪一下空页）；
 * - `empty`  ：没有可用地址（或读设置失败）→ 空状态 + 原因 + 「去设置」；
 * - `ready`  ：地址可用 → 挂载 `Web`；加载失败时**不**卸载 Web，只在其上叠错误卡片，
 *              这样「重试」只是 `controller.refresh()`，不会丢历史/会话。
 * 状态只在「初始化」与「重试/刷新」时变化：`ready` 内部错误态由 `loadError` 单独表达。
 *
 * 刻意不做的两件事：
 * - **不用 `Web.darkMode`**：ArkUI-X 不支持该属性，真机上是 `11706007` 报错（之前踩过）；
 * - 除 `domStorageAccess` 外不加实验属性：DSH 是纯前端 SPA，需要 JS + localStorage
 *   （token/偏好落在这里），这两项是功能必需，其余一律用默认值。
 *
 * 明文 HTTP：`module.json5` 已声明 `ohos.permission.INTERNET`；HarmonyOS 的明文策略由可选的
 * `network_config.json` 决定，**默认允许**（SDK `@ohos.net.networkSecurity.d.ts` 的
 * `isCleartextPermitted()` 注明「默认 true」）。本工程没有该配置文件，因此不做额外声明。
 * 若真机上被拦，`onErrorReceive` 会带 Chromium 错误码（`-102` 是连接被拒绝，明文被拦通常是
 * 平台侧直接报错），按错误卡片里的码再决定是否补网络明文白名单。
 */
import { promptAction, router } from '@kit.ArkUI';
import { webview } from '@kit.ArkWeb';
import { common, Want } from '@kit.AbilityKit';
import { normalizeRemoteUrl } from '../model/remoteUrl';
import type { RemoteUrlCheck } from '../model/remoteUrl';
import { settingsStore } from '../services/settingsStore';
import { describeError } from '../services/scheduleStore';
import { DIVIDER, FONT, LINE_HEIGHT, RADIUS, SPACING, TOUCH_MIN } from '../common/uiTokens';

/** 主按钮高度：40 + 8 = 48vp（只用令牌组合，不引入新魔法数字）。 */
const BUTTON_HEIGHT: number = TOUCH_MIN + SPACING.sm;

/** 页面状态：加载中 / 没有地址 / 已挂载 Web。 */
const PHASE_LOADING: string = 'loading';
const PHASE_EMPTY: string = 'empty';
const PHASE_READY: string = 'ready';

/** 系统浏览器的 dataability 动作（`用浏览器打开` 兜底路径）。 */
const ACTION_VIEW_DATA: string = 'ohos.want.action.viewData';

@Entry
@Component
struct RemoteControl {
  /** 归一后的 DSH 地址；空串 = 没有可用地址（空状态）。 */
  @State url: string = '';
  /** 加载失败文案（空串 = 无错误）；非空时在 Web 上叠错误卡片。 */
  @State loadError: string = '';
  /** 空状态的补充原因（读设置失败 / 地址非法），空串 = 不显示。 */
  @State emptyReason: string = '';
  /** 页面状态（见文件头状态机）。 */
  @State phase: string = PHASE_LOADING;

  private controller: webview.WebviewController = new webview.WebviewController();
  private disposed: boolean = false;

  aboutToAppear(): void {
    this.resolveAddress();
  }

  aboutToDisappear(): void {
    this.disposed = true;
  }

  // ------------------------------------------------------------------ 地址解析

  /** 取 `router` 参数里的 `url`（没有/异常一律空串）。 */
  private paramUrl(): string {
    try {
      const params = router.getParams() as Record<string, string>;
      if (params === undefined || params === null) {
        return '';
      }
      const value = params['url'];
      if (value === undefined || value === null) {
        return '';
      }
      return value;
    } catch (error) {
      return '';
    }
  }

  /**
   * 参数优先、设置兜底：参数里有地址就不再读 preferences（少一次 IO，也避免读到旧值）。
   */
  private async resolveAddress(): Promise<void> {
    const fromParam: string = this.paramUrl();
    if (fromParam.trim().length > 0) {
      this.applyAddress(fromParam);
      return;
    }
    let stored: string = '';
    try {
      const settings = await settingsStore.load(getContext(this) as common.UIAbilityContext);
      stored = settings.remoteUrl;
    } catch (error) {
      if (!this.disposed) {
        this.emptyReason = `读取本机设置失败：${describeError(error)}`;
      }
    }
    if (this.disposed) {
      return;
    }
    this.applyAddress(stored);
  }

  /**
   * 归一地址并决定状态：合法 → 挂 Web；空/非法 → 空状态（非法时把原因写进 `emptyReason`）。
   *
   * 用 `model/remoteUrl` 的同一份规则：非法地址绝不挂 Web（否则用户看到一个注定打不开的白屏）。
   */
  private applyAddress(raw: string): void {
    const check: RemoteUrlCheck = normalizeRemoteUrl(raw);
    if (check.ok) {
      this.url = check.url;
      this.emptyReason = '';
      this.loadError = '';
      this.phase = PHASE_READY;
      return;
    }
    this.url = '';
    this.loadError = '';
    this.phase = PHASE_EMPTY;
    // 用户明确填过东西但不可用：保留具体原因（比只写「先到设置里填写」更能定位问题）
    if (raw.trim().length > 0 && this.emptyReason.length === 0) {
      this.emptyReason = check.reason;
    }
  }

  // ------------------------------------------------------------------ 动作

  /** 刷新：先清错误态，再让 Web 重新加载（错误卡片上的「重试」与标题栏「刷新」共用）。 */
  private refresh(): void {
    this.loadError = '';
    if (this.url.length === 0) {
      return;
    }
    try {
      this.controller.refresh();
    } catch (error) {
      // 控制器还没附着（页面刚建好/正在销毁）时 refresh 会抛，忽略：下一次加载本来就会重新请求
      console.info(`[remote] refresh skipped: ${describeError(error)}`);
    }
  }

  /**
   * 兜底：「用浏览器打开」把地址交给系统浏览器。
   *
   * 失败只 toast（例如设备上没有任何浏览器），绝不因为兜底路径失败而崩掉当前页。
   */
  private async openInBrowser(): Promise<void> {
    if (this.url.length === 0) {
      return;
    }
    try {
      const context = getContext(this) as common.UIAbilityContext;
      const want: Want = { action: ACTION_VIEW_DATA, uri: this.url };
      await context.startAbility(want);
    } catch (error) {
      if (!this.disposed) {
        promptAction.showToast({ message: `打开浏览器失败：${describeError(error)}`, duration: 3000 });
      }
    }
  }

  /** 空状态 → 设置页填地址。 */
  private async goSettings(): Promise<void> {
    try {
      await router.pushUrl({ url: 'pages/Settings' });
    } catch (error) {
      if (!this.disposed) {
        promptAction.showToast({ message: `打开设置页失败：${describeError(error)}`, duration: 3000 });
      }
    }
  }

  /**
   * `onErrorReceive` 的文案：把 Chromium 错误码一起展示，真机上据此判断原因。
   *
   * `-102`（ERR_CONNECTION_REFUSED）单独解释：局域网场景里几乎都是「电脑上的 DSH 没启动」
   * 或「地址里的端口写错」，比原始英文描述有用。
   */
  private describeLoadError(code: number, info: string): string {
    const detail: string = info.length > 0 ? info : '未知原因';
    if (code === -102) {
      return `连接被拒绝（${code}）：电脑上的 DSH 可能没启动，或地址里的端口不对`;
    }
    return `页面加载失败（${code}）：${detail}`;
  }

  // ------------------------------------------------------------------ UI

  /** 标题栏：返回 ‹ + 标题 + 刷新（刷新在没地址时置灰，点了也不动）。 */
  @Builder
  Header() {
    Row({ space: SPACING.sm }) {
      Text('‹')
        .fontSize(FONT.title)
        .lineHeight(LINE_HEIGHT.title)
        .fontColor($r('app.color.text_primary'))
        .width(TOUCH_MIN)
        .height(TOUCH_MIN)
        .textAlign(TextAlign.Center)
        .onClick(() => {
          router.back();
        })
      Text('远程控制')
        .fontSize(FONT.title)
        .lineHeight(LINE_HEIGHT.title)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('app.color.text_primary'))
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)
        .textAlign(TextAlign.Start)
      Text('刷新')
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontColor($r('app.color.brand'))
        .height(TOUCH_MIN)
        .padding({ left: SPACING.sm, right: SPACING.sm })
        .textAlign(TextAlign.Center)
        .opacity(this.url.length > 0 ? 1 : 0.4)
        .onClick(() => {
          this.refresh();
        })
    }
    .width('100%')
    .alignItems(VerticalAlign.Center)
    .padding({ left: SPACING.sm, right: SPACING.sm, top: SPACING.md, bottom: SPACING.md })
  }

  /** 空状态：没配地址（或读设置失败/地址非法）时唯一可见的内容。 */
  @Builder
  EmptyState() {
    Column({ space: SPACING.md }) {
      Text('先到设置里填写 DSH 地址')
        .fontSize(FONT.body)
        .lineHeight(LINE_HEIGHT.body)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('app.color.text_primary'))
        .width('100%')
        .textAlign(TextAlign.Start)
      if (this.emptyReason.length > 0) {
        Text(this.emptyReason)
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
          .width('100%')
          .textAlign(TextAlign.Start)
      }
      Text('填好电脑上的地址（如 http://192.168.1.6:3080/?token=…）后，回到本页即可内嵌操作 DSH。')
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontColor($r('app.color.text_secondary'))
        .width('100%')
        .textAlign(TextAlign.Start)
      Button('去设置')
        .height(BUTTON_HEIGHT)
        .fontSize(FONT.body)
        .backgroundColor($r('app.color.brand'))
        .fontColor($r('app.color.text_inverse'))
        .borderRadius(RADIUS.sm)
        .onClick(() => {
          this.goSettings();
        })
    }
    .width('100%')
    .padding(SPACING.lg)
    .alignItems(HorizontalAlign.Start)
  }

  /** 错误卡片：叠在 Web 之上，说明原因 + 「重试」+「用浏览器打开」。 */
  @Builder
  ErrorCard() {
    Column({ space: SPACING.md }) {
      Text('打不开这台电脑上的 DSH 页面')
        .fontSize(FONT.body)
        .lineHeight(LINE_HEIGHT.body)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('app.color.danger'))
        .width('100%')
        .textAlign(TextAlign.Start)
      Text(this.loadError)
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontColor($r('app.color.text_primary'))
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
            this.refresh();
          })
        Button('用浏览器打开')
          .height(BUTTON_HEIGHT)
          .fontSize(FONT.body)
          .backgroundColor($r('app.color.brand_soft'))
          .fontColor($r('app.color.brand'))
          .borderRadius(RADIUS.sm)
          .onClick(() => {
            this.openInBrowser();
          })
      }
      .width('100%')
      .justifyContent(FlexAlign.Start)
    }
    .width('100%')
    .padding(SPACING.lg)
    .backgroundColor($r('app.color.warning_soft'))
    .borderRadius(RADIUS.sm)
    .alignItems(HorizontalAlign.Start)
  }

  /** 主体：内嵌 Web + 错误卡片遮罩（Web 始终挂着，重试不丢会话）。 */
  @Builder
  RemoteBody() {
    Stack({ alignContent: Alignment.TopStart }) {
      Web({ src: this.url, controller: this.controller })
        .width('100%')
        .height('100%')
        .javaScriptAccess(true)
        .domStorageAccess(true)
        .onErrorReceive((event: OnErrorReceiveEvent) => {
          // 只看主文档：子资源（favicon 之类）失败不该把整页判成打不开
          if (!event.request.isMainFrame()) {
            return;
          }
          this.loadError = this.describeLoadError(event.error.getErrorCode(), event.error.getErrorInfo());
        })
        .onHttpErrorReceive((event: OnHttpErrorReceiveEvent) => {
          if (!event.request.isMainFrame()) {
            return;
          }
          const status: number = event.response.getResponseCode();
          this.loadError = `电脑上的 DSH 返回 HTTP ${status}：地址或 token 可能不对，请回设置页检查`;
        })
      if (this.loadError.length > 0) {
        Column() {
          this.ErrorCard()
        }
        .width('100%')
        .padding(SPACING.lg)
      }
    }
    .width('100%')
    .layoutWeight(1)
  }

  build() {
    Column() {
      this.Header()
      Divider()
        .strokeWidth(DIVIDER)
        .color($r('app.color.divider'))
      if (this.phase === PHASE_READY) {
        this.RemoteBody()
      } else if (this.phase === PHASE_EMPTY) {
        this.EmptyState()
      }
      // PHASE_LOADING：什么都不画（通常只有几毫秒，读 preferences 的时间）
    }
    .width('100%')
    .height('100%')
    .backgroundColor($r('app.color.page_background'))
  }
}
