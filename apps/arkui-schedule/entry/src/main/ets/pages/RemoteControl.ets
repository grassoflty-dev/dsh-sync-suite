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
 * - `loading`：刚进页面，正在读参数/本机设置 → `LoadingState`（不渲染 Web，避免闪一下空页）；
 *              3 秒后出现的「取消」= 回设置页看看，**只停止这次等待**，不代表连接被取消；
 * - `empty`  ：没有可用地址（或读设置失败）→ `EmptyState`（原因 + 「去设置」）；
 * - `ready`  ：地址可用 → 挂载 `Web`；加载失败时**不**卸载 Web，只在其上叠 `ErrorState`
 *              （三段式 + 诊断行 + 重试 + 「用浏览器打开」），
 *              这样「重试」只是 `controller.refresh()`，不会丢历史/会话。
 * 状态只在「初始化」与「重试/刷新」时变化：`ready` 内部错误态由 `loadError` 单独表达。
 *
 * 刻意不做的两件事：
 * - **不用 `Web.darkMode`**：ArkUI-X 不支持该属性，真机上是 `11706007` 报错（之前踩过）；
 * - 除 `domStorageAccess` 外不加实验属性：DSH 是纯前端 SPA，需要 JS + localStorage
 *   （token/偏好落在这里），这两项是功能必需，其余一律用默认值。
 *
 * mod-remote-tls-termination（证书 pin）：插件旁挂监听已改为 HTTPS（自签证书）。本页只接受
 * 「配对时固定过证书指纹的实例」：进入页面先查 pin（没有 = 从未配对，拒绝；地址不是 https =
 * 没有可校验的证书链，拒绝，绝不加载明文页）；TLS 报错时用平台回调里的 DER 证书链取 leaf
 * 算 SHA-256，与 pin 相同才 `handleConfirm()`，不同就 `handleCancel(true)` 并显示固定中文文案。
 * 三种拒绝（不匹配 / 无 pin / 无法校验链）分开，任何分支都不写 pin、不回显 URL 或 token。
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
import { loadingText } from '../common/copy';
import { APP_VERSION } from '../common/version';
import { encodeLastOk, normalizeRemoteUrl, stripRemoteToken } from '../model/remoteUrl';
import type { LastOkEntry, RemoteUrlCheck } from '../model/remoteUrl';
import { formatDiagnostics } from '../model/stateView';
import type { DiagnosticsInput } from '../model/stateView';
import { findInstance, instanceIdFromUrl } from '../model/instances';
import type { DsInstance } from '../model/instances';
import { instanceStore } from '../services/instanceStore';
import {
  TLS_CHAIN_UNVERIFIABLE_WORDING,
  TLS_NO_PIN_WORDING,
  verifyPinnedCertificate
} from '../model/tlsPin';
import type { TlsPinResult } from '../model/tlsPin';
import { ActionButton } from '../components/ActionButton';
import { EmptyState } from '../components/state/EmptyState';
import { ErrorState } from '../components/state/ErrorState';
import { LoadingState } from '../components/state/LoadingState';
import { settingsStore } from '../services/settingsStore';
import { describeError } from '../services/scheduleStore';
import { DIVIDER, FONT, LINE_HEIGHT, RADIUS, SPACING, TOUCH_MIN } from '../common/uiTokens';
import { Rc3GatePanel, rc3GateRequested } from '../components/Rc3GatePanel';
import { canPrompt } from '../model/instanceGrant';
import { instanceGrantStore } from '../services/instanceGrantStore';
import { RemoteCommandComposer } from '../components/RemoteCommandComposer';

/** 页面状态：加载中 / 没有地址 / 已挂载 Web。 */
const PHASE_LOADING: string = 'loading';
const PHASE_EMPTY: string = 'empty';
const PHASE_READY: string = 'ready';

/** 系统浏览器的 dataability 动作（`用浏览器打开` 兜底路径）。 */
const ACTION_VIEW_DATA: string = 'ohos.want.action.viewData';

/** 加载态文案：标题（`loadingText('远程地址')` →「正在加载远程地址…」）与诚实的补充说明。 */
const LOADING_WHAT: string = '远程地址';
const LOADING_DETAIL: string = '正在读取本机设置；等太久可以先回设置页看看，取消只是停止这里的等待';

/** 空态文案：一句说明（地址缺失/非法）+ 一个下一步动作。 */
const EMPTY_TITLE: string = '先到设置里填写 DSH 地址';
const EMPTY_ADDRESS_HINT: string = '填好电脑上的地址（如 http://192.168.1.6:3080/?token=…）后回到本页';

/** 错误态三段式：发生了什么 / 下一步（`why` 用运行时 `loadError`）。 */
const ERROR_WHAT: string = '打不开这台电脑上的 DSH 页面';
const ERROR_NEXT: string = '确认电脑上的 DSH 已启动、平板与电脑在同一网络；仍不行就改用浏览器打开';

/** `loadError` 里的数字错误码（`-102` / `-173` / `HTTP 401`）；抽不到时的兜底码。 */
const ERROR_CODE_PATTERN: RegExp = /-?\d{2,5}/;
const FALLBACK_ERROR_CODE: string = 'WEB_LOAD';

/** 标题栏「刷新」：没地址时点不动，但必须说出原因（不静默）。 */
const REFRESH_LABEL: string = '刷新';
const REFRESH_BLOCKED_REASON: string = '还没有可用地址';
const OPEN_BROWSER_LABEL: string = '用浏览器打开';

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
  /** 证书 pin 拒绝后为 true：不挂 Web（页面从未加载），刷新也不再重试。 */
  @State tlsBlocked: boolean = false;

  @State rc3Gate: boolean = false;

  private controller: webview.WebviewController = new webview.WebviewController();
  private disposed: boolean = false;

  aboutToAppear(): void {
    this.rc3Gate = rc3GateRequested();
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
      this.tlsBlocked = false;
      // 预检：pin 只从实例（配对写入）读，连接本身永不写 pin。
      // 没有 pin = 从未配对/老实例 ⇒ 直接拒绝，不挂 Web；
      // 不是 https = 没有证书链可 pin ⇒ 按「无法校验」拒绝，绝不加载明文页。
      const pin: string = this.storedPin();
      if (pin.length === 0) {
        this.tlsBlocked = true;
        this.loadError = TLS_NO_PIN_WORDING;
      } else if (!check.url.toLowerCase().startsWith('https://')) {
        this.tlsBlocked = true;
        this.loadError = TLS_CHAIN_UNVERIFIABLE_WORDING;
      } else {
        // 原生客户端尚未通过设备验收；不能回退到只在证书报错时才校验的 WebView。
        this.tlsBlocked = true;
        this.loadError = '安全连接尚未启用，未向电脑发送凭据。';
      }
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

  /**
   * 当前地址对应的实例 id：整个页面**唯一**一处 URL→实例 id 派生。
   *
   * 证书 pin 查询与「发指令」目标都走这里，绝不各写一次 URL 派生调用——
   * 两处派生一旦漂移，pin 校验的就会是另一台电脑。
   */
  private targetInstanceId(): string {
    return instanceIdFromUrl(this.url);
  }

  /** 发指令目标展示名：有实例行用其名字，缺行退回 id（不编造名字）。 */
  private targetDisplayName(): string {
    const id: string = this.targetInstanceId();
    if (id.length === 0) {
      return '';
    }
    const found: DsInstance | null = findInstance(instanceStore.list(), id);
    return found === null ? id : found.name;
  }

  /**
   * 发指令授权：只认显式授予的 session.prompt。
   * 实例行缺失或授权表损坏 / 存储不可用时一律 false（fail-closed），不猜测、不放行。
   */
  private targetCommandGranted(): boolean {
    const id: string = this.targetInstanceId();
    if (id.length === 0) {
      return false;
    }
    if (findInstance(instanceStore.list(), id) === null) {
      return false;
    }
    if (instanceGrantStore.lastProblem() !== 'ok') {
      return false;
    }
    return canPrompt(instanceGrantStore.list(), id, Date.now());
  }

  /**
   * 读该地址对应实例的配对 pin。
   *
   * pin 的唯一来源是 `addPairedInstance` 写入实例信封的 `tlsFingerprint`；
   * 这里只按 URL 派生的稳定 id 查表，**不写回、不补 pin、不升级老实例**。
   * 读取失败 / 老实例无此字段 → 空串（= 拒绝，绝不当成"任意证书匹配"）。
   */
  private storedPin(): string {
    try {
      const id: string = this.targetInstanceId();
      if (id.length === 0) {
        return '';
      }
      const found: DsInstance | null = findInstance(instanceStore.list(), id);
      if (found === null || found.tlsFingerprint === undefined) {
        return '';
      }
      return found.tlsFingerprint;
    } catch (error) {
      return '';
    }
  }

  /**
   * `onSslErrorEventReceive`：平台把 DER 证书链放在 `event.certChainData`（leaf 第一项）。
   *
   * - match ⇒ `handleConfirm()`，按 pin 放行这张自签证书；
   * - mismatch / no-pin / unverifiable ⇒ `handleCancel(true)` 中止加载（页面根本没打开），
   *   并把三种固定文案之一写进错误卡；任何分支都不记录 event（URL 带 token）。
   */
  private handleSslError(event: OnSslErrorEventReceiveEvent): void {
    const outcome: TlsPinResult = verifyPinnedCertificate(event.certChainData, this.storedPin());
    if (outcome.outcome === 'match') {
      this.loadError = '';
      try {
        event.handler.handleConfirm();
      } catch (error) {
        // handler 已失效（页面正在销毁）：忽略，下一次加载会重新触发校验
      }
      return;
    }
    this.tlsBlocked = true;
    this.loadError = outcome.wording;
    try {
      event.handler.handleCancel(true);
    } catch (error) {
      // 同上：拒绝状态已经落定，页面不会继续加载
    }
  }

  // ------------------------------------------------------------------ 动作

  /**
   * 记录「最近一次成功」：`onPageEnd` = 主文档加载完成，是 App 侧最接近「这台电脑的 DSH 页面
   * 确实打开了」的信号（`docs/CONFIG-UX.md` §B.4 的「一键重连」数据源）。
   *
   * 三条纪律：
   * - **失败不覆盖**：`loadError` 非空时直接返回——旧记录是用户找回「上次能连的地址」的唯一线索；
   * - **不含 secret**：落盘前 `stripRemoteToken()` 删掉 `token` / `k`，令牌在偏好文件里只存
   *   `remoteToken` 一份，重连时用 `mergeRemoteToken()` 现拼；
   * - **写失败不影响页面**：纯展示状态，下一次加载成功还会再写一次。
   */
  private recordLastOk(): void {
    if (this.url.length === 0 || this.loadError.length > 0) {
      return;
    }
    const stored: string = stripRemoteToken(this.url);
    if (stored.length === 0) {
      return;
    }
    const entry: LastOkEntry = { url: stored, at: Date.now() };
    settingsStore.save({ remoteLastOk: encodeLastOk(entry) }).catch((): void => {
      // 纯展示状态：写失败不改 UI、不打断 Web
    });
  }

  /** 刷新：先清错误态，再让 Web 重新加载（错误卡片上的「重试」与标题栏「刷新」共用）。 */
  private refresh(): void {
    // 证书拒绝是一次性终态：不静默重试、不借刷新绕过 pin；要恢复必须先回设置页重新配对。
    if (this.tlsBlocked) {
      return;
    }
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
    // 证书被拒后不允许用系统浏览器绕过 pin（那条路径没有我们的校验回调）。
    if (this.url.length === 0 || this.tlsBlocked) {
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

  /** 空态说明：有具体原因（读设置失败 / 地址非法）就先说原因，再给「怎么填」的出路。 */
  private emptyDetail(): string {
    const reason: string = this.emptyReason.trim();
    if (reason.length === 0) {
      return EMPTY_ADDRESS_HINT;
    }
    return `${reason}。${EMPTY_ADDRESS_HINT}`;
  }

  /** 从 `loadError` 文案里抽出数字错误码（`-102` / `-173` / `HTTP 401`）；抽不到用 `WEB_LOAD`。 */
  private errorCode(): string {
    const text: string = this.loadError;
    const start: number = text.search(ERROR_CODE_PATTERN);
    if (start < 0) {
      return FALLBACK_ERROR_CODE;
    }
    // 只吃连续数字（保留前面的负号）：`页面加载失败（-173）：…` → `-173`
    let end: number = start;
    if (text.charAt(end) === '-') {
      end++;
    }
    while (end < text.length) {
      const ch: string = text.charAt(end);
      if (ch < '0' || ch > '9') {
        break;
      }
      end++;
    }
    return text.slice(start, end);
  }

  /**
   * 诊断行（`docs/STATE-UI.md` §4.3）：版本 / 设备 / 错误码 / 时间四段永远都在。
   *
   * 设备 id 留空（本页没有设备身份）→ `formatDiagnostics` 兜底「未登记」，不编造。
   */
  private diagnosticsText(): string {
    const input: DiagnosticsInput = {
      version: APP_VERSION,
      deviceId: '',
      errorCode: this.errorCode(),
      timestamp: Date.now()
    };
    return formatDiagnostics(input);
  }

  // ------------------------------------------------------------------ UI

  /** 标题栏：返回 ‹ + 标题 + 刷新（没地址时点不动，但会 toast 出原因）。 */
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
      ActionButton({
        label: REFRESH_LABEL,
        actionEnabled: this.url.length > 0,
        disabledReason: REFRESH_BLOCKED_REASON,
        busy: false,
        variant: 'ghost',
        block: false,
        onTap: (): void => {
          this.refresh();
        },
        onBlockedTap: null
      })
    }
    .width('100%')
    .alignItems(VerticalAlign.Center)
    .padding({ left: SPACING.sm, right: SPACING.sm, top: SPACING.md, bottom: SPACING.md })
  }

  /** 加载态：读地址/设置的那几毫秒也必须有反馈；取消 = 回设置页（停止等待，不是断开连接）。 */
  @Builder
  LoadingView() {
    Column() {
      LoadingState({
        title: loadingText(LOADING_WHAT),
        detail: LOADING_DETAIL,
        onCancel: (): void => {
          this.goSettings();
        }
      })
    }
    .width('100%')
    .layoutWeight(1)
    .justifyContent(FlexAlign.Center)
  }

  /** 空状态：没配地址（或读设置失败/地址非法）时唯一可见的内容 + 「去设置」出路。 */
  @Builder
  EmptyView() {
    Column() {
      EmptyState({
        title: EMPTY_TITLE,
        detail: this.emptyDetail(),
        actionLabel: '去设置',
        onAction: (): void => {
          this.goSettings();
        }
      })
    }
    .width('100%')
    .layoutWeight(1)
    .justifyContent(FlexAlign.Center)
  }

  /**
   * 错误卡片：叠在 Web 之上，说明原因 + 诊断行 + 「重试」+「用浏览器打开」。
   *
   * 第二按钮**不**走 `ErrorState.onOpenSettings`（那里的文案固定是「去设置」，本页要的是
   * 「用浏览器打开」），所以 `onOpenSettings` 传 `null`，在组件外自己放一个 `ActionButton`。
   */
  @Builder
  ErrorView() {
    Column({ space: SPACING.md }) {
      ErrorState({
        what: ERROR_WHAT,
        why: this.loadError,
        next: ERROR_NEXT,
        diagnostics: this.diagnosticsText(),
        onRetry: (): void => {
          this.refresh();
        },
        onOpenSettings: null
      })
      Row() {
        ActionButton({
          label: OPEN_BROWSER_LABEL,
          // 证书被拒时禁用兜底：系统浏览器没有我们的 pin 校验，点了也不能绕过
          actionEnabled: !this.tlsBlocked,
          disabledReason: this.tlsBlocked ? '证书未通过校验，不能用浏览器绕过' : '',
          busy: false,
          variant: 'secondary',
          block: false,
          onTap: (): void => {
            this.openInBrowser();
          },
          onBlockedTap: null
        })
      }
      .width('100%')
      .justifyContent(FlexAlign.Center)
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
        .onPageEnd(() => {
          // 主文档加载完成 → 记下「最近一次成功」（失败路径由 onErrorReceive 标 loadError，不写）
          this.recordLastOk();
        })
        .onSslErrorEventReceive((event: OnSslErrorEventReceiveEvent) => {
          // 只有这里能看到平台给的 DER 证书链；pin 命中才确认，否则中止加载并显示固定文案。
          // 不打印 event：url 里带 token。
          this.handleSslError(event);
        })
        .onErrorReceive((event: OnErrorReceiveEvent) => {
          // 证书拒绝已经给出终态文案，后续的 net::ERR_* 不覆盖（也不带 URL/token 进文案）
          if (this.tlsBlocked) {
            return;
          }
          // 只看主文档：子资源（favicon 之类）失败不该把整页判成打不开
          if (!event.request.isMainFrame()) {
            return;
          }
          this.loadError = this.describeLoadError(event.error.getErrorCode(), event.error.getErrorInfo());
        })
        .onHttpErrorReceive((event: OnHttpErrorReceiveEvent) => {
          if (this.tlsBlocked || !event.request.isMainFrame()) {
            return;
          }
          const status: number = event.response.getResponseCode();
          this.loadError = `电脑上的 DSH 返回 HTTP ${status}：地址或 token 可能不对，请回设置页检查`;
        })
      if (this.loadError.length > 0) {
        Column() {
          this.ErrorView()
        }
        .width('100%')
        .padding(SPACING.lg)
      }
    }
    .width('100%')
    .layoutWeight(1)
  }

  /** 证书拒绝终态：只渲染错误卡，Web 根本不挂载（页面从未加载）。 */
  @Builder
  RefusedView() {
    Column() {
      this.ErrorView()
    }
    .width('100%')
    .padding(SPACING.lg)
    .layoutWeight(1)
  }

  build() {
    Column() {
      this.Header()
      Divider()
        .strokeWidth(DIVIDER)
        .color($r('app.color.divider'))
      if (this.phase === PHASE_LOADING) {
        this.LoadingView()
      } else if (this.phase === PHASE_READY) {
        if (this.rc3Gate) {
          Rc3GatePanel({ endpoint: this.url })
        } else {
          // 不挂旧 WebView；常规路径必须等原生客户端通过设备验收。
          this.RefusedView()
        }
        // mod-remote-command-wire：单次确认闸的真实界面，挂在今天唯一可达的 PHASE_READY 态
        // （证书未启用 ⇒ tlsBlocked=true ⇒ RefusedView）。目标派生与 storedPin() 共用一处。
        RemoteCommandComposer({
          instanceId: this.targetInstanceId(),
          instanceName: this.targetDisplayName(),
          commandGranted: this.targetCommandGranted()
        })
      } else if (this.phase === PHASE_EMPTY) {
        this.EmptyView()
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor($r('app.color.page_background'))
  }
}
