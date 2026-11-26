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
 * - `ready`  ：地址可用 → 挂载 `Web`；加载失败时**不**卸载 Web，只在其上整屏叠错误块
 *              （三段式 + 诊断行 + 重试 + 「用浏览器打开」），
 *              这样「重试」只是 `controller.refresh()`，不会丢历史/会话。
 * 状态只在「初始化」与「重试/刷新」时变化：`ready` 内部错误态由 `loadError` 单独表达。
 *
 * 刻意不做的两件事：
 * - **不用 `Web.darkMode`**：ArkUI-X 不支持该属性，真机上是 `11706007` 报错（之前踩过）；
 * - 除 `domStorageAccess` 外不加实验属性：DSH 是纯前端 SPA，需要 JS + localStorage
 *   （token/偏好落在这里），这两项是功能必需，其余一律用默认值。
 *
 * mod-app-remote-page-pure（本批次）：**本页只显示电脑自己的 DSH 页面**。我们此前加在页面上的
 * 东西全部下架，全部判断收进纯模型 `model/remotePageChrome.ts`：
 * - 发指令面板（目标 / 工具 / 确认勾选 / 发送按钮）整块删除。本页没有命令入口，
 *   `session.prompt` 在平板上**没有** UI 入口；唯一交互面就是 DSH 页面本身。
 *   那个只读命令面板组件因此变成零 importer 的死文件（仍可编译），保留是因为
 *   它自己的组件级守卫测试仍在跑，删文件会连带删掉那些断言。
 * - 顶部整块删除：传输方式标签、证书比对标签、「两次连接之间更换证书不会发现」的 caveat、URL 行。
 * - CDP 实时视图与预览标记的说明位删除（本版本页面源码里本来就没有这两处文案）。
 * - 我们自己的标题栏（返回 + 「远程控制」+ 刷新按钮）删除，改成左侧居中的浮动图标轨：
 *   返回 `‹` / 刷新 `↻` / 连接诊断 `ⓘ`，**无文字、无标题栏、无 chip**，透明度与尺寸都取设计令牌。
 * - 配对 / 指纹诊断没有删，只是搬进「连接诊断」浮层：点 `ⓘ` 或长按 `↻` 打开；地址行先
 *   `stripRemoteToken()` 再显示（浮层里也不出现令牌）。成功路径上它不渲染。
 *
 * 成功路径只有 Web：`remoteSurface()` 是唯一表面决策，`page` 时屏幕上除了 Web 与浮动图标轨
 * 没有任何我们自己的东西；`error` 时错误块**整屏**替换页面（原因 + 下一步 + 重试），
 * 绝不出现空白页，也绝不出现英文错误页。
 *
 * mod-app-remote-glyph-rail-polish（本批次）：浮动图标轨此前是 `Stack` 的最后一个孩子，
 * **浮在页面上面**——Lead 截图里 `‹`/`↻`/`ⓘ` 就压在 DSH 页面的会话正文上。产品决定不变
 * （仍然只有 DSH 页面，不加标题栏 / 说明文字），因此这里**只改几何**：
 * - 几何全部由纯模型 `model/glyphRailLayout.ts` 算：`railRect`（图标轨盒子）与
 *   `contentRect`（WebView 盒子）在模型里保证**永不相交**（页面右移出一条保留槽）；
 * - 本页只做三件接线：把 `onAreaChange` 的真实视口交给 `railLayout()`、用 `railRect` 摆图标轨、
 *   用 `contentRect` 定 Web 的位置与尺寸；**页面里没有一处写死的几何数字**；
 * - 模型给 `railVisible=false`（视口还没量到 / 放不下）时连图标轨都不画，宁可这一帧没有图标，
 *   也不留一个压在页面上的图标。真机观感仍是 `unverified`（本批次无设备）。
 *
 * mod-remote-page-webview（前一批次，仍有效）：地址归一、传输方式、标签与一次性放行凭据分别收在纯模型
 * `model/remoteAddress.ts` / `model/pageTransport.ts` / `model/sslAllowance.ts`，本页只做接线：
 * 1. `normalizeHostPort` → `classifyTransport`（chip 文案）→ `pageDecision`（标签 + load/refuse）；
 * 2. http ⇒ 直接 load；
 * 3. https ⇒ 查实例的配对 pin；无 pin / 不匹配在 `pageDecision` 处拒绝，绝不挂 Web；
 *    pin 存在时经 `services/remotePinnedClient.ets` 发**一条不带凭证**的预检请求，
 *    用 `verifyLeafPin` 比对叶证书指纹；通过才 `sslAllowance.grant()` 并挂 Web；
 * 4. `onSslErrorEventReceive` 只在 `sslAllowance.consume()` 为真时 `handleConfirm()`，
 *    否则 `handleCancel(true)` + typed 原因。**这里不写 pin、不改实例表**。
 * 预检是一次连接，WebView 握手是另一次独立连接：这条残留 TOCTOU 风险仍逐字保留在
 * `TransportInfo()` 里（现在只在诊断浮层可见），不假装两次连接是同一条，
 * 也不写任何过度承诺的安全形容词（禁用词见 pageTransport 模型头）。
 *
 * 旧页面级「安全已启用才发凭据」式拒绝句已从页面路径删除：页面本身不发送任何来自 App 的
 * 敏感数据，那条话只属于命令通道（composer 的 `E_COMMAND_REMOTE_UNVERIFIED`）。
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
import { http } from '@kit.NetworkKit';
import { normalizeHostPort, classifyTransport, transportChip, hostPortKey } from '../model/remoteAddress';
import type { HostPortCheck } from '../model/remoteAddress';
import { pageDecision, TOCTOU_SENTENCE } from '../model/pageTransport';
import type { PageDecision, PinState } from '../model/pageTransport';
import {
  grant as sslGrant,
  consume as sslConsume,
  clear as sslClear,
  SSL_ALLOWANCE_REFUSAL_WORDING
} from '../model/sslAllowance';
import { normalizePin, verifyLeafPin, PIN_REFUSAL_WORDING } from '../model/remotePinnedClient';
import type { PinnedRefusalCode } from '../model/remotePinnedClient';
import { collectLeafCandidates, requestWithValidation } from '../services/remotePinnedClient';
import { ActionButton } from '../components/ActionButton';
import { EmptyState } from '../components/state/EmptyState';
import { ErrorState } from '../components/state/ErrorState';
import { LoadingState } from '../components/state/LoadingState';
import { settingsStore } from '../services/settingsStore';
import { describeError } from '../services/scheduleStore';
import { FONT, LINE_HEIGHT, RADIUS, SPACING } from '../common/uiTokens';
import { Rc3GatePanel, rc3GateRequested } from '../components/Rc3GatePanel';
import {
  DIAGNOSTICS_GLYPH,
  DIAGNOSTICS_LONG_PRESS_MS,
  DIAGNOSTICS_TITLE,
  BACK_GLYPH,
  RELOAD_GLYPH,
  chromeAffordances,
  pairingDiagnostics,
  remoteSurface
} from '../model/remotePageChrome';
import type {
  ChromeAffordances,
  PairingDiagnosticsInput,
  RemoteSurface,
  RemoteSurfaceInput
} from '../model/remotePageChrome';
import {
  REMOTE_OUTCOME_KEY,
  encodeRemoteOutcome,
  outcomeForLoadSuccess,
  outcomeForRefusal
} from '../model/remoteOutcome';
import type { RemoteOutcome, RemoteRefusalKind } from '../model/remoteOutcome';
import { GAP_DEFAULT_VP, GLYPH_DEFAULT_VP, glyphRailLayout } from '../model/glyphRailLayout';
import type { GlyphRailInput, GlyphRailLayout } from '../model/glyphRailLayout';

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

/** 兜底按钮：把地址交给系统浏览器（只在错误块里出现）。 */
const OPEN_BROWSER_LABEL: string = '用浏览器打开';

@Entry
@Component
struct RemoteControl {
  /** 归一后的 DSH 地址；空串 = 没有可用地址（空状态）。 */
  @State url: string = '';
  /** 加载失败文案（空串 = 无错误）；非空时在 Web 上整屏叠错误块。 */
  @State loadError: string = '';
  /** 空状态的补充原因（读设置失败 / 地址非法），空串 = 不显示。 */
  @State emptyReason: string = '';
  /** 页面状态（见文件头状态机）。 */
  @State phase: string = PHASE_LOADING;
  /** 拒绝终态：不挂 Web（页面从未加载），刷新也不再重试。 */
  @State tlsBlocked: boolean = false;

  /** mod-remote-page-webview：归一后的 host/port/scheme；null = 地址非法。 */
  private address: HostPortCheck | null = null;
  /** 传输方式文案（只从 TRANSPORT_LABELS 取，不在组件里写死；只在诊断浮层里显示）。 */
  @State transportLabel: string = '';
  /** pageDecision 的标签（唯一决策文案出口；只在诊断浮层里显示）。 */
  @State pageLabel: string = '';
  /** 只有决策 action='load' 才为 true；Web 只在此为真时挂载。 */
  @State webMounted: boolean = false;
  /** https 预检通过过：刷新时需要重新发放一次性放行凭据。 */
  @State httpsVerified: boolean = false;
  /** 连接诊断浮层是否展开（默认关：成功路径上不渲染任何诊断内容）。 */
  @State showDiagnostics: boolean = false;

  @State rc3Gate: boolean = false;

  /**
   * 根容器实测视口（vp）：`onAreaChange` 送进来，是图标轨 / WebView 几何的唯一来源。
   * 还没量到（0）时模型给退化结论（图标轨不画、页面铺满），绝不猜一个尺寸去摆位置。
   */
  @State viewportW: number = 0;
  @State viewportH: number = 0;

  private controller: webview.WebviewController = new webview.WebviewController();
  private disposed: boolean = false;
  /**
   * mod-pairing-badge-truth：本次打开尝试是否已经写过结果标记。
   * 一次尝试只会有一个终局；重渲染 / 多个 Web 回调不得重复写 AppStorage。
   * 新尝试（applyAddress / 真正执行的 refresh）先清回 false。
   */
  private outcomeWritten: boolean = false;

  aboutToAppear(): void {
    this.rc3Gate = rc3GateRequested();
    this.resolveAddress();
  }

  aboutToDisappear(): void {
    this.disposed = true;
  }

  // ------------------------------------------------------------------ 表面与浮动操作

  /** 唯一表面决策（纯模型）：loading / empty / page / error。 */
  private surface(): RemoteSurface {
    const input: RemoteSurfaceInput = {
      phase: this.phase,
      webMounted: this.webMounted,
      hasLoadError: this.loadError.length > 0
    };
    return remoteSurface(input);
  }

  /**
   * 浮动操作可见性（纯模型）：返回永远有；刷新只在有地址、已到终态且**不是**证书拒绝终态时出现
   * （拒绝不会因为重新加载而改变，留一个没反应的图标就是假动作）。
   */
  private affordances(): ChromeAffordances {
    return chromeAffordances(this.surface(), this.url.length > 0, this.tlsBlocked);
  }

  // ------------------------------------------- 浮动图标轨几何（mod-app-remote-glyph-rail-polish）

  /** `Area` 的 `Length` → vp 数字（非数字 / 非有限 / ≤0 一律 0，与 `Home.applyArea` 同一口径）。 */
  private toVp(value: Length): number {
    if (typeof value === 'number') {
      return Number.isFinite(value) && value > 0 ? value : 0;
    }
    if (typeof value === 'string') {
      const parsed: number = Number(value);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    }
    return 0;
  }

  /** 面积变化 → 视口状态（只存真实量到的宽高；量不到就保持退化，不猜）。 */
  private applyArea(area: Area): void {
    const width: number = this.toVp(area.width);
    const height: number = this.toVp(area.height);
    if (width <= 0 || height <= 0) {
      return;
    }
    if (this.viewportW !== width) {
      this.viewportW = width;
    }
    if (this.viewportH !== height) {
      this.viewportH = height;
    }
  }

  /**
   * 当前可见字形个数：返回恒在（用户的出口），刷新看 `affordances()`，诊断看 `phase`。
   * 个数只影响图标轨高度，不影响保留槽宽度（槽只由字形宽 + gap 决定）。
   */
  private railGlyphCount(): number {
    let count: number = 1;
    if (this.affordances().reload) {
      count += 1;
    }
    if (this.phase === PHASE_READY) {
      count += 1;
    }
    return count;
  }

  /**
   * 图标轨 + WebView 的盒子（纯模型，唯一几何来源）。
   *
   * 安全区：本页没有 `expandSafeArea`，ArkUI 默认把页面内容排在安全区内，
   * 所以根容器的矩形**就是**安全区，这里四个 inset 传 0；模型本身支持非零 inset
   * （`glyphRailLayout.test.mjs` 的表格覆盖零 / 小 / 大安全区），要沉浸式时只改这一处。
   */
  private railLayout(): GlyphRailLayout {
    const input: GlyphRailInput = {
      viewportW: this.viewportW,
      viewportH: this.viewportH,
      safeAreaTop: 0,
      safeAreaBottom: 0,
      safeAreaLeft: 0,
      safeAreaRight: 0,
      glyphSize: GLYPH_DEFAULT_VP,
      gap: GAP_DEFAULT_VP,
      glyphCount: this.railGlyphCount()
    };
    return glyphRailLayout(input);
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
   * 地址解析 → 纯分类 → 纯决策 →（https 时）pin 预检。
   *
   * 全部判定都由纯模型给出：本页没有一行 IP/域名嗅探、没有一份内联文案。
   * http 直接 load；https 无 pin / 预检失败 → refuse 且不挂 Web。
   */
  private applyAddress(raw: string): void {
    // 新的一次打开尝试：结果标记与一次性放行凭据都允许重置（mod-pairing-badge-truth）
    this.outcomeWritten = false;
    sslClear();
    this.address = null;
    this.transportLabel = '';
    this.pageLabel = '';
    this.webMounted = false;
    this.httpsVerified = false;
    this.showDiagnostics = false;

    const addr: HostPortCheck = normalizeHostPort(raw);
    if (!addr.ok) {
      this.url = '';
      this.loadError = '';
      this.tlsBlocked = false;
      this.phase = PHASE_EMPTY;
      if (raw.trim().length > 0 && this.emptyReason.length === 0) {
        this.emptyReason = addr.reason;
      }
      return;
    }

    this.address = addr;
    // Web 的 src 沿用既有归一规则（保留原始 query token 以维持 DSH 鉴权行为）；
    // 裸 IPv6 host:port 的配对载荷由 normalizeHostPort 补出带方括号的 URL。
    const check: RemoteUrlCheck = normalizeRemoteUrl(raw);
    this.url = check.ok ? check.url : addr.url;
    this.emptyReason = '';
    this.loadError = '';
    this.tlsBlocked = false;
    this.transportLabel = transportChip(classifyTransport(addr.host, addr.port));
    this.phase = PHASE_READY;

    if (addr.scheme === 'http') {
      this.applyDecision(addr.scheme, 'absent');
      return;
    }

    const pin: string = normalizePin(this.storedPin());
    if (pin.length === 0) {
      this.applyDecision(addr.scheme, 'absent');
      this.refuse('no-pin');
      return;
    }
    // pin 存在：发一条不带凭证的预检请求，握手期比对叶证书指纹。
    this.preflight(addr, pin);
  }

  /** 取决策表的一行并落到状态；Web 只在 action='load' 时挂载。 */
  private applyDecision(scheme: string, state: PinState): PageDecision {
    const decision: PageDecision = pageDecision({ scheme: scheme, pinState: state });
    this.pageLabel = decision.label;
    this.webMounted = decision.action === 'load';
    return decision;
  }

  /** 统一拒绝终局：typed 原因 + 不挂 Web + 一次性结果标记。 */
  private refuse(kind: RemoteRefusalKind): void {
    this.tlsBlocked = true;
    this.webMounted = false;
    this.reportRefusal(kind);
  }

  /** 预检的 typed 拒绝码 → 决策标签 + 固定文案 + 结果标记。 */
  private refusePreflight(code: PinnedRefusalCode, state: PinState, kind: RemoteRefusalKind): void {
    this.applyDecision('https', state);
    this.loadError = PIN_REFUSAL_WORDING[code];
    this.refuse(kind);
  }

  /**
   * 只归一「观察到」的 host：SDK 的 ValidationContext.host 对 IPv6 可能带方括号
   *（如 `[fd7a:…:1]`），而配对记录里的 addr.host 是不带括号的小写字面量。
   * 只在预检调用点剥一层括号，避免逐字比对时误判 E_HOST_MISMATCH 而让 IPv6 永远 fail-closed。
   * 不改模型、不改实例表、不改预期值。
   */
  private normalizeObservedHost(rawHost: string): string {
    let host: string = rawHost;
    if (host.startsWith('[')) {
      host = host.substring(1);
    }
    if (host.endsWith(']')) {
      host = host.substring(0, host.length - 1);
    }
    return host;
  }

  /**
   * 唯一的 pin 预检：一条不带凭证的请求，握手期用 verifyLeafPin 比对叶证书。
   *
   * leafOrderProven 不是常量 true：它只在**观察到单证书链**（pemCerts===1 且 x509<=1）时为真——
   * 链条里只有一张证书时，那张就是 leaf，不存在「链首顺序」的歧义；多证书继续 fail-closed。
   * 任何异常 / 回调未触发 / 指纹不符都拒绝，绝不回退到「只在报错时放行」的 WebView 路径。
   */
  private async preflight(addr: HostPortCheck, pin: string): Promise<void> {
    let callbackInvoked: boolean = false;
    let pinOk: boolean = false;
    const validation: http.ValidationCallback = async (context: http.ValidationContext): Promise<boolean> => {
      callbackInvoked = true;
      const pemCount: number = Array.isArray(context.pemCerts) ? context.pemCerts.length : 0;
      const x509Count: number = Array.isArray(context.x509Certs) ? context.x509Certs.length : 0;
      // 只在这里归一观察到的 host：SDK 对 IPv6 可能给 `[ipv6]`，预期值不带括号。
      const observedHost: string = this.normalizeObservedHost(context.host);
      const outcome = verifyLeafPin({
        host: observedHost,
        ip: context.ip,
        expectedHost: addr.host,
        expectedIp: '',
        expectedPin: pin,
        leaves: collectLeafCandidates(context),
        chainShape: { x509Count: x509Count, pemCount: pemCount },
        leafOrderProven: pemCount === 1 && x509Count <= 1
      });
      pinOk = outcome.ok;
      return outcome.ok;
    };
    try {
      const response = await requestWithValidation(addr.url, validation);
      if (this.disposed) {
        return;
      }
      if (!callbackInvoked) {
        const code: PinnedRefusalCode = response.errorCode !== 0
          ? 'E_TRANSPORT_FAILURE' : 'E_API_UNSUPPORTED';
        this.refusePreflight(code, 'preflight-failed', 'permanent-refusal');
        return;
      }
      if (!pinOk) {
        this.refusePreflight('E_PIN_MISMATCH', 'mismatch', 'tls-mismatch');
        return;
      }
      this.applyDecision(addr.scheme, 'verified');
      sslGrant(hostPortKey(addr.host, addr.port), true, Date.now());
      this.httpsVerified = true;
      this.loadError = '';
    } catch (error) {
      if (!this.disposed) {
        this.refusePreflight('E_TRANSPORT_FAILURE', 'preflight-failed', 'permanent-refusal');
      }
    }
  }

  /** 当前 host:port 的一次性放行键（IPv6 带方括号）。 */
  private allowanceKey(): string {
    if (this.address === null) {
      return '';
    }
    return hostPortKey(this.address.host, this.address.port);
  }

  /**
   * 当前地址对应的实例 id：整个页面**唯一**一处 URL→实例 id 派生。
   *
   * 证书 pin 查询走这里，绝不另写一次 URL 派生调用——两处派生一旦漂移，
   * pin 校验的就会是另一台电脑。（发指令面板已删除，不再有第二个消费者。）
   */
  private targetInstanceId(): string {
    return instanceIdFromUrl(this.url);
  }

  // ------------------------------------------------------------ 结果标记（mod-pairing-badge-truth）

  /**
   * 一次打开尝试只写一次结果标记（guard 在 writeOutcome 内）：
   * 被拒绝 / 未建立起来的通道一律 fail，只有页面真正加载完成才写 ok。
   * 无法从地址派生实例 id 时不写（没有可归属的行，fail-closed）。
   */
  private writeOutcome(outcome: RemoteOutcome): void {
    if (this.outcomeWritten || outcome.instanceId.length === 0) {
      return;
    }
    AppStorage.setOrCreate<string>(REMOTE_OUTCOME_KEY, encodeRemoteOutcome(outcome));
    this.outcomeWritten = true;
  }

  /** 六种拒绝终局的统一出口；文字 / 状态机语义不变，只追加一次性结果标记。 */
  private reportRefusal(kind: RemoteRefusalKind): void {
    const id: string = this.targetInstanceId();
    if (id.length === 0) {
      return;
    }
    this.writeOutcome(outcomeForRefusal(kind, id, Date.now()));
  }

  /** 真正的主文档加载完成（`onPageEnd`）才可能把行提升为 ok。 */
  private reportLoadSuccess(): void {
    const id: string = this.targetInstanceId();
    if (id.length === 0) {
      return;
    }
    this.writeOutcome(outcomeForLoadSuccess(id, Date.now()));
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
   * `onSslErrorEventReceive`（SDK 契约：只报主文档）：
   *
   * - `sslConsume(host:port, now)` 为真 ⇒ 这是预检通过后的那一次握手，`handleConfirm()`；
   * - 否则（无授权 / 过期 / 已消费 / 换主机）⇒ `handleCancel(true)`，渲染固定拒绝文案。
   *
   * 这里**不再**重复读 pin，也绝不写 pin；pin 只在 applyAddress 的预检里比对过一次。
   * 任何分支都不记录 event（URL 可能带 token）。
   */
  private handleSslError(event: OnSslErrorEventReceiveEvent): void {
    if (sslConsume(this.allowanceKey(), Date.now())) {
      this.loadError = '';
      try {
        event.handler.handleConfirm();
      } catch (error) {
        // handler 已失效（页面正在销毁）：忽略，下一次加载会重新走预检
      }
      return;
    }
    this.refuse('tls-mismatch');
    this.loadError = SSL_ALLOWANCE_REFUSAL_WORDING;
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

  /** 刷新：先清错误态，再让 Web 重新加载（错误块上的「重试」与浮动 ↻ 共用）。 */
  private refresh(): void {
    // 拒绝是一次性终态：不静默重试、不借刷新绕过校验；恢复需重新进入本页
    //（无 pin 的情形仍须先回设置页配对）。
    if (this.tlsBlocked) {
      return;
    }
    this.loadError = '';
    if (this.url.length === 0) {
      return;
    }
    // 真正会重新加载 = 新的一次尝试：结果标记与一次性放行凭据都重新发放
    this.outcomeWritten = false;
    if (this.httpsVerified) {
      sslGrant(this.allowanceKey(), true, Date.now());
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

  /** 浮动返回：不用读文字就能找到的出口（系统返回手势不是保证）。 */
  private goBack(): void {
    router.back();
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
   * 只用在**错误块**里；成功路径上不渲染（诊断浮层是另一套配对诊断，见下）。
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

  /** 配对诊断正文：地址先剥 token，再交给纯模型拼行（浮层专用，成功路径不渲染）。 */
  private pairingText(): string {
    const input: PairingDiagnosticsInput = {
      address: stripRemoteToken(this.url),
      pin: this.storedPin()
    };
    return pairingDiagnostics(input);
  }

  // ------------------------------------------------------------------ UI

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
    .height('100%')
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
    .height('100%')
    .justifyContent(FlexAlign.Center)
  }

  /**
   * 错误块：说明原因 + 诊断行 + 「重试」+「用浏览器打开」。
   *
   * 第二按钮**不**走 `ErrorState.onOpenSettings`（那里的文案固定是「去设置」，本页要的是
   * 「用浏览器打开」），所以 `onOpenSettings` 传 `null`，在组件外自己放一个 `ActionButton`。
   * 调用方负责把它整屏摆出来（成功路径上不渲染）。
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
          // 拒绝态禁用兜底：系统浏览器没有我们的预检 + 一次性放行，点了等于绕过
          actionEnabled: !this.tlsBlocked,
          disabledReason: this.tlsBlocked ? '当前连接未通过校验，不能用浏览器绕过' : '',
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

  /**
   * 浮动图标轨（屏幕上我们唯一常驻的东西）：返回 ‹ / 刷新 ↻ / 连接诊断 ⓘ。
   *
   * 四条约束：
   * - **没有文字**：不写标题、不写分类、不写说明——用户看到的字全部来自 DSH 页面；
   * - 尺寸与颜色只取设计令牌 / 纯模型，深色模式下由资源覆盖；
   * - `back` 恒可见（不能被关在页面里），`reload` 只在有地址、已到终态且不是证书拒绝终态时出现
   *   （纯模型判定），`ⓘ` 只在 `ready` 出现（那时才有配对/传输可诊断）；
   * - **位置与尺寸全部来自 `railLayout().railRect` / `glyphSize` / `gap`**（mod-app-remote-glyph-rail-polish）：
   *   页面已经按模型给出的 `contentRect` 右移，图标轨落在自己的保留槽里，**不可能压到页面内容上**。
   */
  @Builder
  Rail() {
    Column({ space: this.railLayout().gap }) {
      Text(BACK_GLYPH)
        .fontSize(FONT.title)
        .lineHeight(LINE_HEIGHT.title)
        .fontColor($r('app.color.text_primary'))
        .textAlign(TextAlign.Center)
        .width(this.railLayout().glyphSize)
        .height(this.railLayout().glyphSize)
        .backgroundColor($r('app.color.control_fill'))
        .borderRadius(RADIUS.sm)
        .onClick((): void => {
          this.goBack();
        })
      if (this.affordances().reload) {
        Text(RELOAD_GLYPH)
          .fontSize(FONT.title)
          .lineHeight(LINE_HEIGHT.title)
          .fontColor($r('app.color.text_primary'))
          .textAlign(TextAlign.Center)
          .width(this.railLayout().glyphSize)
          .height(this.railLayout().glyphSize)
          .backgroundColor($r('app.color.control_fill'))
          .borderRadius(RADIUS.sm)
          .onClick((): void => {
            this.refresh();
          })
          // 长按同一个图标也能打开诊断：与 ⓘ 等价，不需要读文字就能发现。
          .gesture(
            LongPressGesture({ repeat: false, duration: DIAGNOSTICS_LONG_PRESS_MS })
              .onAction((): void => {
                this.showDiagnostics = true;
              })
          )
      }
      if (this.phase === PHASE_READY) {
        Text(DIAGNOSTICS_GLYPH)
          .fontSize(FONT.title)
          .lineHeight(LINE_HEIGHT.title)
          .fontColor($r('app.color.text_secondary'))
          .textAlign(TextAlign.Center)
          .width(this.railLayout().glyphSize)
          .height(this.railLayout().glyphSize)
          .backgroundColor($r('app.color.control_fill'))
          .borderRadius(RADIUS.sm)
          .onClick((): void => {
            this.showDiagnostics = true;
          })
      }
    }
    .width(this.railLayout().railRect.width)
    .height(this.railLayout().railRect.height)
    .position({
      x: this.railLayout().railRect.x,
      y: this.railLayout().railRect.y
    })
  }

  /**
   * 连接诊断浮层（`bindSheet`）：配对 / 指纹 / 传输诊断的**唯一**展示位。
   *
   * 首行固定是 `DIAGNOSTICS_TITLE`（「连接诊断」）；之后依次是传输方式行、证书比对行、
   * 预检通过才有的 TOCTOU caveat（都来自 `TransportInfo()`）、以及地址 + 配对指纹。
   * 地址已剥 token；浮层默认关闭，成功路径上不渲染。
   */
  @Builder
  DiagnosticsSheet() {
    Column({ space: SPACING.md }) {
      Text(DIAGNOSTICS_TITLE)
        .fontSize(FONT.title)
        .lineHeight(LINE_HEIGHT.title)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('app.color.text_primary'))
        .width('100%')
        .textAlign(TextAlign.Start)
      this.TransportInfo()
      Text(this.pairingText())
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontFamily('monospace')
        .fontColor($r('app.color.text_primary'))
        .copyOption(CopyOptions.LocalDevice)
        .width('100%')
        .textAlign(TextAlign.Start)
      if (this.rc3Gate) {
        Rc3GatePanel({ endpoint: this.url })
      }
    }
    .width('100%')
    .padding(SPACING.lg)
    .alignItems(HorizontalAlign.Start)
  }

  /**
   * 诊断内容：传输方式 + 决策标签 + 残留 TOCTOU 风险各一行（第三行只在预检真正通过后显示）。
   *
   * 文案全部来自纯模型（TRANSPORT_LABELS / PAGE_TRANSPORT_TABLE / TOCTOU_SENTENCE），
   * 组件里没有任何内联分类/IP 嗅探；Tailscale 不额外加任何形容词。
   * 本 builder **只被 `DiagnosticsSheet()` 调用**，成功路径上不渲染。
   */
  @Builder
  TransportInfo() {
    Column({ space: SPACING.xs }) {
      Text(`传输：${this.transportLabel}`)
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontColor($r('app.color.text_secondary'))
        .width('100%')
        .textAlign(TextAlign.Start)
      Text(this.pageLabel)
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontColor($r('app.color.text_secondary'))
        .width('100%')
        .textAlign(TextAlign.Start)
      // 只有预检真正通过（verifyLeafPin 命中且已放行）才显示；无 pin / 拒绝 / http 都没发生过预检。
      if (this.httpsVerified) {
        Text(TOCTOU_SENTENCE)
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
          .width('100%')
          .textAlign(TextAlign.Start)
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  /**
   * 主体：内嵌 Web + 整屏错误块（决策成功后才挂，重试不丢会话）。
   *
   * 成功路径（`surface() === 'page'`）上这个 Stack 只有 Web 一个孩子——没有横幅、没有分类、
   * 没有说明文字；加载失败时错误块**整屏**盖住 Web（Web 仍挂着，所以「重试」只是 refresh）。
   *
   * Web 的盒子（位置 + 尺寸）来自 `railLayout().contentRect`：左边让出一条保留槽，
   * DSH 页面整体右移，因此页面自己的排版里没有任何一处落在图标轨下面
   * （mod-app-remote-glyph-rail-polish；此前 Web 是 100%×100%，图标轨就压在页面正文上）。
   */
  @Builder
  RemoteBody() {
    Stack({ alignContent: Alignment.TopStart }) {
      Web({ src: this.url, controller: this.controller })
        .width(this.railLayout().contentRect.width)
        .height(this.railLayout().contentRect.height)
        .position({
          x: this.railLayout().contentRect.x,
          y: this.railLayout().contentRect.y
        })
        .javaScriptAccess(true)
        .domStorageAccess(true)
        .onPageEnd(() => {
          // 主文档加载完成 → 记下「最近一次成功」（失败路径由 onErrorReceive 标 loadError，不写）
          this.recordLastOk();
          // 只有真正加载完成才是可达性 ok（拒绝路径不挂 Web，此回调不会触发）
          this.reportLoadSuccess();
        })
        .onSslErrorEventReceive((event: OnSslErrorEventReceiveEvent) => {
          // SDK 契约只对主文档触发；只按一次性放行凭据决定是否确认，不再读 pin。
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
          this.reportRefusal('web-load-error');
        })
        .onHttpErrorReceive((event: OnHttpErrorReceiveEvent) => {
          if (this.tlsBlocked || !event.request.isMainFrame()) {
            return;
          }
          const status: number = event.response.getResponseCode();
          this.loadError = `电脑上的 DSH 返回 HTTP ${status}：地址或 token 可能不对，请回设置页检查`;
          this.reportRefusal('web-load-error');
        })
      if (this.surface() === 'error') {
        Column() {
          this.ErrorView()
        }
        .width('100%')
        .height('100%')
        .padding(SPACING.lg)
        .justifyContent(FlexAlign.Center)
        .backgroundColor($r('app.color.page_background'))
      }
    }
    .width('100%')
    .height('100%')
  }

  /** 证书拒绝终态：只渲染整屏错误块，Web 根本不挂载（页面从未加载）。 */
  @Builder
  RefusedView() {
    Column() {
      this.ErrorView()
    }
    .width('100%')
    .height('100%')
    .padding(SPACING.lg)
    .justifyContent(FlexAlign.Center)
    .backgroundColor($r('app.color.page_background'))
  }

  build() {
    Stack({ alignContent: Alignment.Start }) {
      if (this.phase === PHASE_LOADING) {
        this.LoadingView()
      } else if (this.phase === PHASE_EMPTY) {
        this.EmptyView()
      } else if (this.webMounted) {
        this.RemoteBody()
      } else {
        this.RefusedView()
      }
      // 图标轨只在模型允许时画：视口还没量到 / 放不下就这一帧不画，绝不压在页面上
      if (this.railLayout().railVisible) {
        this.Rail()
      }
    }
    .width('100%')
    .height('100%')
    .onAreaChange((_oldValue: Area, newValue: Area) => {
      this.applyArea(newValue);
    })
    .backgroundColor($r('app.color.page_background'))
    .bindSheet(this.showDiagnostics, this.DiagnosticsSheet(), {
      height: SheetSize.MEDIUM,
      dragBar: true,
      showClose: true,
      backgroundColor: $r('app.color.surface'),
      onDisappear: (): void => {
        this.showDiagnostics = false;
      }
    })
  }
}
