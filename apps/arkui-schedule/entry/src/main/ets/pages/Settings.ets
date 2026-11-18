/**
 * 设置页：五组（同步 / AI 汇总 / 远程控制 / 数据 / 关于），长说明收进 `?` 弹层。
 * （同步组因为「分支 / 推送 / 状态」三项新需求变长，次要项继续收在组头「更多」里。）
 *
 * 「仅手写笔输入」的入口在**手写板 → 笔迹面板**（`pages/harmony/Handwriting.ets`），
 * 本页不再重复提供该开关；`settingsStore.penOnlyInput` 键仍保留（笔迹面板读写它），
 * 本页保存时**不传**该字段（不传＝不改，见 `settingsStore.save` 的 patch 语义）。
 *
 * 「数据」组（导出 / 导入，`docs/EXPORT-IMPORT.md` §4）：只放 `ExportImportPanel` 一个组件，
 * 页面负责调 `services/exportService.ets` 并把结果写回 `exportImport`；导入**必须两步**
 * （选文件 → dry-run 统计 → 用户点确认才 `appendImportPlan` 落盘，且用同一份计划）。
 *
 * AI 组内的「多源 fallback」（`docs/AI-FALLBACK.md` §8）排在「高级」折叠区之前：开关 +
 * 最多 3 个备用源 + 尝试次数 + 本次会话的诊断；三个持久化键由 `applySettings` / `saveSettings`
 * 读写，诊断只留在内存（不落盘、不进同步载荷）。
 *
 * 本页仍做四件事（逻辑未改）：内嵌隐藏 Web 跑 isomorphic-git、注册代理、按钮触发
 * pull/push/status、保存前做表单校验。
 *
 * 远程控制组（最后一个功能组，排在「关于」之前）：
 * 1. 「访问方式」六选一（`model/remoteAccess.ts` 的 `REMOTE_MODES`，与插件侧同一套枚举与字段）；
 * 2. 按方式的 `fields` 渲染输入（局域网 / IPv6 → 地址+端口，Tailscale → 主机+端口，
 *    Cloudflare → 域名，手动 → 完整地址；`lan`/`ipv6`/`tailscale` 另有「访问令牌（可选）」
 *    密码框，已保存的令牌只打码显示、不回填明文），`unsupported`（网易 UU 远程）只显示原因、不给假开关；
 * 3. 「DSH 地址」是最终要打开的地址（`lan`/`ipv6`/`tailscale`/`cloudflare` 由字段自动拼出来，
 *    `manual` 就是手输那一行）；点「打开远程控制」时 `buildRemoteAccessUrl` 拼地址、`normalizeRemoteUrl`
 *    再归一，`settingsStore.save` 落盘（含方式与各字段）后才 `router.pushUrl` 到内嵌页
 *    （`routeToRemote()` + params.url）。地址里的 token 只存本机，不进同步载荷。
 *
 * 同步组（A1/A2 之后）：
 * - 仓库地址 / 用户名 / token / **分支** / 设备标识 + 作者名；
 * - 「立即同步」（= pull）与「推送」（A2 第 3 条）是组内两个主按钮，
 *   查看状态 / 重试上次 / 测试连接 / **托管平台（GitHub、Gitee、GitLab、自建）** /
 *   认证方式在组头「更多」里；
 * - 平台按仓库地址自动推断（手动选过则以用户为准），保存后给一行「已按地址推断平台为 X」；
 * - 分支默认 main、可配，非法值给可读红字；首次推送时远端没有该分支会自动创建；
 * - 同步状态（分支 / 领先 / 落后 / 冲突 / 本地改动）与最近一次同步时间+成败都在本页展示；
 * - **SSH 在本版本不可用**（内置内核只有 HTTP(S) 传输），选中时直接写「当前版本仅支持 HTTPS」
 *   并禁用同步按钮，不做「看起来支持」的假入口。
 *
 * AI 组接 `model/aiProvider.ts`：服务=预设源表，模型随服务联动；`save()` 内部已做
 * `resolveModel` / `aiBaseURLFor` 归一，因此本页**只传原始值**，不重复归一化。
 *
 * token / AI key 只存本机 preferences，不进同步载荷与日志；本页不打印它们。
 */
import { promptAction, router } from '@kit.ArkUI';
import { webview } from '@kit.ArkWeb';
import { common } from '@kit.AbilityKit';
import { pasteboard } from '@kit.BasicServicesKit';
import { http } from '@kit.NetworkKit';
import { util } from '@kit.ArkTS';
import { nowIso } from '../common/date';
import { toastMsFor } from '../common/copy';
import { getFeatures } from '../common/features';
import { isHarmonyOS } from '../common/platform';
import { normalizeDeviceId, settingsStore } from '../services/settingsStore';
import type { ScheduleSettings, SettingsPatch, SyncStatePatch } from '../services/settingsStore';
import { describeError, scheduleStore } from '../services/scheduleStore';
import { GitSyncService } from '../services/GitSyncService';
import type { GitSyncConfig, GitSyncResult } from '../services/GitSyncService';
import { describeRepoProbe, repoProbeUrl, validateRepoUrl } from '../model/repoUrl';
import type { RepoUrlCheck } from '../model/repoUrl';
import { normalizeRemoteUrl, routeToRemote } from '../model/remoteUrl';
import type { RemoteUrlCheck } from '../model/remoteUrl';
import {
  REMOTE_AVAILABILITY_NEEDS_SETUP,
  REMOTE_AVAILABILITY_UNSUPPORTED,
  REMOTE_MODE_CLOUDFLARE,
  REMOTE_MODE_IPV6,
  REMOTE_MODE_LAN,
  REMOTE_MODE_MANUAL,
  REMOTE_MODE_ORDER,
  REMOTE_MODE_TAILSCALE,
  REMOTE_MODES,
  buildRemoteAccessUrl,
  defaultRemoteAccessConfig,
  findRemoteMode,
  maskRemoteToken,
  normalizeRemoteMode,
  normalizeRemotePort
} from '../model/remoteAccess';
import type {
  RemoteAccessConfig,
  RemoteAccessUrlResult,
  RemoteModeField,
  RemoteModeSpec
} from '../model/remoteAccess';
import {
  AUTH_HTTPS,
  AUTH_SSH,
  FIELD_AI_BASE_URL,
  FIELD_AI_MODEL,
  FIELD_AUTHOR,
  FIELD_DEVICE_ID,
  FIELD_REPO_URL,
  FIELD_TOKEN,
  checkSettingsFields,
  describeFirstIssue,
  describeIssues,
  effectiveToken,
  normalizeAuthMode,
  normalizePlatform,
  validateAuthorName,
  validateDeviceIdText
} from '../model/settingsForm';
import type { SettingsFieldIssue } from '../model/settingsForm';
import {
  canRetrySync,
  classifySyncError,
  describeLastSyncOutcome,
  describePushReadiness,
  normalizeBranchName,
  normalizeSyncAction,
  syncActionLabel,
  validateBranchName,
  DEFAULT_BRANCH
} from '../model/syncError';
import type { SyncErrorInfo, SyncStatusView } from '../model/syncError';
import { testAiConnection } from '../services/deepseek';
import type { AiTestResult } from '../services/deepseek';
import {
  AI_PROVIDERS,
  CUSTOM_PROVIDER_ID,
  DEFAULT_PROVIDER_ID,
  defaultModelOf,
  findProvider,
  hintForProvider,
  modelsOf
} from '../model/aiProvider';
import type { AiModelOption, AiProviderPreset } from '../model/aiProvider';
import {
  GITEE_PLATFORM,
  PLATFORM_CUSTOM,
  PLATFORM_GITHUB,
  PLATFORM_GITLAB,
  SSH_UNSUPPORTED_SHORT,
  assertHttpsUsername,
  authHintFor,
  describeAuthModeBlocker,
  gitUsernameHintFor,
  gitUsernamePlaceholderFor,
  isSshAuthMode,
  normalizeGitPlatform,
  platformLabel,
  repoUrlExamplesFor,
  repoUrlPlaceholderFor,
  resolveGitUsername,
  resolvePlatformSelection,
  tokenPlaceholderFor
} from '../model/gitAuth';
import type { PlatformResolution } from '../model/gitAuth';
import { gitExtrasStore } from '../services/syncController';
import type { GitSyncExtras } from '../services/syncController';
import { PageLayout } from '../components/PageLayout';
import { AiFallbackPanel } from '../components/AiFallbackPanel';
import { ExportImportPanel } from '../components/ExportImportPanel';
import {
  DEFAULT_MAX_ATTEMPTS,
  MAX_FALLBACK_SOURCES,
  normalizeMaxAttempts,
  parseFallbackOrder,
  serializeFallbackOrder,
  sourceLabel
} from '../model/aiFallback';
import type { FallbackDiagnostic, FallbackSource, FallbackSourcePatch } from '../model/aiFallback';
import {
  applyPlan,
  clearDryRun,
  defaultExportImportState,
  withExportPath,
  withImportFileName,
  withPanelMessage
} from '../model/exportImport';
import type { ExportImportState, ExportRequest, ImportPlan } from '../model/exportImport';
import {
  appendImportPlan,
  exportSchedules,
  exportsDirPath,
  pickImportFile,
  planImportFromText
} from '../services/exportService';
import type {
  ExportFileResult,
  ExportRequestInput,
  ImportApplyResult,
  ImportFilePickResult,
  ImportPlanResult
} from '../services/exportService';
import { DIVIDER, FONT, HOME_INCLUDE_OTHER_KEY, LINE_HEIGHT, RADIUS, SPACING, TOUCH_MIN } from '../common/uiTokens';
import { applyThemeMode, isSystemDark } from '../common/themeApply';
import { THEME_MODE_ORDER, normalizeThemeMode, resolveTheme, themeModeHint, themeModeLabel } from '../model/theme';

/** 仓库探测超时（毫秒）：探测只看域名通不通，不需要长超时。 */
const PROBE_TIMEOUT_MS: number = 10000;

/** 底部弹层的单行高度。 */
const SHEET_ROW: number = 48;

/**
 * 深色模式三态片的最小宽度（vp）。
 *
 * 「跟随系统」四个字在 ×1.5 大字号下约 4 × 14 × 1.5 × 0.6 ≈ 50vp，加左右 padding 8×2 = 66；
 * 这里取 56 作**下限**、靠 `padding` 自然撑开（不给固定宽，避免大字号被裁——见
 * `docs/UI-DESIGN.md` §8 布局规则 ①）。
 */
const THEME_CHIP_MIN_WIDTH: number = 56;

/** 展示用版本号：与 `AppScope/app.json5` 的 versionName 保持一致（改版本时两处同步）。 */
const APP_VERSION: string = '1.0.0';

/**
 * 本页会话内最多保留几条 fallback 诊断。
 *
 * 诊断只用于「刚才那次为什么失败」的即时排查，不落盘、不跨页面；留 10 条足够覆盖
 * 「主源 + 3 个备用源」的两轮尝试，再多就只是在设置页里堆噪音。
 */
const MAX_SESSION_DIAGNOSTICS: number = 10;

/** 弹层标识：同一时刻只开一个。 */
const PANEL_NONE: string = '';
const PANEL_SYNC_MORE: string = 'syncMore';
const PANEL_PROVIDER: string = 'provider';
const PANEL_MODEL: string = 'model';
const PANEL_PRIVACY: string = 'privacy';
const PANEL_REPO: string = 'repo';
/**
 * Git 用户名字段标识。
 *
 * 与 `model/settingsForm.ts` 里的 `FIELD_*` 同构，但那个文件由另一位执行者维护
 * （他正在加 `gitUsername` 与 `assertHttpsUsername`），所以先放在页面里，
 * 两份常量值必须一致（守卫测试会盯）。
 */
const FIELD_GIT_USERNAME: string = 'gitUsername';

@Entry
@Component
struct Settings {
  @State deviceId: string = 'phone-a';
  @State author: string = '';
  @State repoUrl: string = '';
  @State token: string = '';
  @State aiKey: string = '';
  @State aiModel: string = '';
  /** AI 服务源 id（`model/aiProvider.ts` 的预设表）。 */
  @State aiProviderId: string = DEFAULT_PROVIDER_ID;
  /** 自定义源的接口地址；预设源下存的是预设地址快照，页面上不展示。 */
  @State aiBaseURL: string = '';
  /** 托管平台：`github` / `gitee` / `gitlab` / `custom`（只影响提示文案与示例）。 */
  @State gitPlatform: string = PLATFORM_GITHUB;
  /** 用户是否手动点过平台 chip（点过 = 以用户为准，不再按地址推断）。 */
  @State platformTouched: boolean = false;
  /** 平台推断/锁定的一行提示（空串 = 不显示）。 */
  @State platformNotice: string = '';
  /** 同步分支（默认 main，可配；存在 gitExtrasStore 里）。 */
  @State branch: string = DEFAULT_BRANCH;
  /** 分支名的内联错误。 */
  @State branchError: string = '';
  /** 认证方式：`https` / `ssh`（SSH 本版本不可用，会被拦）。 */
  @State authMode: string = AUTH_HTTPS;
  @State ready: boolean = false;
  @State saveHint: string = '';
  /** 保存校验的问题汇总（「还有 N 项需要处理：…」，空串 = 无问题）。 */
  @State issuesSummary: string = '';
  /** 第一条问题的「字段名 · 原因」：横幅第二行，用户不滚动也能看懂要改什么。 */
  @State firstIssueText: string = '';
  /** AI 模型名的内联错误（其余字段各有自己的 *Error 状态）。 */
  @State aiModelError: string = '';
  /** AI 接口地址的内联错误（自定义源专用）。 */
  @State aiBaseUrlError: string = '';
  /** Git 用户名（仅 HTTPS 认证用：GitHub 可留空，Gitee 必填登录名）。 */
  @State gitUsername: string = '';
  @State gitUsernameError: string = '';
  // 表单校验提示（逐字段红字）
  @State deviceIdError: string = '';
  @State authorError: string = '';
  @State repoUrlError: string = '';
  @State tokenError: string = '';
  @State connectionText: string = '';
  @State connectionBusy: boolean = false;
  @State aiTestText: string = '';
  /** 失败后的一行可操作建议（成功时为空，不占行）。 */
  @State aiTestHint: string = '';
  @State aiTestBusy: boolean = false;
  /** 上次同步成功时刻（ISO，空串=从未同步；来自 preferences，跨启动保留）。 */
  @State lastSyncAt: string = '';
  /** 上次同步失败的分级后中文文案（空串=上次没有失败）。 */
  @State lastSyncError: string = '';
  /** 上次同步动作：`pull` | `push` | `status`（空串=没有可重试的动作）。 */
  @State lastSyncAction: string = '';
  @State syncMessage: string = '同步内核尚未就绪：请保持本页打开，等待隐藏 Web 环境加载完成';
  @State syncBusy: boolean = false;
  /** 最近一次「查看状态」的结果（分支 / ahead / behind / 冲突 / 本地改动）。 */
  @State statusLine: string = '';
  @State webReady: boolean = false;
  @State platformText: string = '';
  @State handwritingText: string = '';
  @State ocrText: string = '';
  @State storageHint: string = '';
  // UI 状态：断点由 PageLayout 计算，本页只做 compact / 非 compact 分支
  @State breakpoint: string = 'compact';
  @State contentWidth: number = 0;
  /** 当前打开的弹层（`PANEL_*`）。 */
  @State panel: string = PANEL_NONE;
  /** 「高级」是否展开（选自定义源时自动展开）。 */
  @State advancedOpen: boolean = false;
  /** 首页是否展示其他设备的只读记录（写 AppStorage，首页读取）。 */
  @State includeOtherDevices: boolean = false;

  /**
   * 导出 / 导入面板的展示状态（`components/ExportImportPanel.ets` 的 `@Prop state`）。
   *
   * 组件只读它渲染，交互（区间 / 格式 / 两个开关）在组件本地承接并通过 `ExportRequest`
   * 回传；本页只负责把**结果**（导出路径 / dry-run 计数 / 提示文案 / busy）写回来。
   */
  @State exportImport: ExportImportState = defaultExportImportState();

  /** 是否启用「多源 fallback」（默认关闭：关闭时内容只发给主源，见 `docs/AI-FALLBACK.md` §6）。 */
  @State aiFallbackEnabled: boolean = false;
  /** 备用源顺序（不含主源，最多 3 个；`parseFallbackOrder` / `serializeFallbackOrder` 归一）。 */
  @State aiFallbackSources: FallbackSource[] = [];
  /** 最多尝试几次（含主源）。 */
  @State aiFallbackMaxAttempts: number = DEFAULT_MAX_ATTEMPTS;
  /**
   * 本次页面会话内的 fallback 诊断（源名 / 原因 / 耗时，已由运行器脱敏）。
   *
   * **只在内存里**：不写 preferences、不进 Git 载荷；条数上限见 `MAX_SESSION_DIAGNOSTICS`。
   */
  @State aiFallbackDiagnostics: FallbackDiagnostic[] = [];

  /**
   * 深色模式三态（`system` | `light` | `dark`）。
   *
   * 切换即生效（`setColorMode` + 落盘，见 `saveThemeMode`），不等底部「保存设置」——
   * 用户点「深色」就是为了立刻看效果，中间不该再要一次确认。
   */
  @State themeMode: string = 'system';
  /** 电脑上的 DSH Web 地址（「远程控制」内嵌加载；地址可能含 token，只存本机）。 */
  @State remoteUrl: string = '';
  /** 远程控制地址的内联错误（非法地址 / 保存失败），非空时按钮上方显示红字。 */
  @State remoteUrlError: string = '';
  /** 远程访问方式（`lan`/`tailscale`/`ipv6`/`cloudflare`/`manual`/`uu`，见 `model/remoteAccess.ts`）。 */
  @State remoteMode: string = REMOTE_MODE_LAN;
  /** 局域网方式要填的具体 IPv4。 */
  @State remoteLanAddress: string = '';
  /** 端口输入框的原始文本（`InputType.Number` 仍按文本回调；空串/非法 → 0 = 跟 DSH 同端口）。 */
  @State remotePortText: string = '0';
  /** Tailscale 方式要填的 100.x 地址或 MagicDNS 名。 */
  @State remoteTailscaleHost: string = '';
  /** Cloudflare 隧道域名（不带 https://、不带路径）。 */
  @State remoteCloudflareHost: string = '';
  /** 公网 IPv6 地址（不带方括号；拼地址时由 `buildRemoteAccessUrl` 补 `[ ]`）。 */
  @State remoteIpv6Address: string = '';
  /** 手动方式的完整地址（与「DSH 地址」那一行共用同一份值，见 `manualUrl` 的取值逻辑）。 */
  @State remoteManualUrl: string = '';
  /**
   * 「访问令牌（可选）」的**输入框值**（只写通道）。
   *
   * 这里只存「用户这次想改成的新令牌」，**永不**回填已保存的明文：已保存的令牌在
   * `savedRemoteToken`（private，不给输入框），页面只用 `maskRemoteToken` 显示「已保存」。
   * 输入框留空 = 不改（沿用已保存的令牌），见 `effectiveRemoteToken()`。
   */
  @State remoteToken: string = '';

  /** 从列表页跳转过来时要自动执行的同步动作（pull / push / status）。 */
  private autoAction: string = '';
  private gitController: webview.WebviewController = new webview.WebviewController();
  private sync: GitSyncService = new GitSyncService(this.gitController);
  private disposed: boolean = false;
  /** 已保存的 token：输入框留空时沿用（用户「不改 token」不该被拦）。 */
  private savedToken: string = '';
  /**
   * 已保存的「访问令牌」（明文，页面内部只用于 mask 显示与"沿用"语义）。
   *
   * 刻意不是 `@State`：它**不进任何输入框**，改动它也不需要触发重绘（mask 显示读的是方法）。
   * 声明成普通字段能提醒后来者：这个值只允许 mask 后上屏。
   */
  private savedRemoteToken: string = '';
  /** 最近一次同步状态结果（只在页面内部用于派生「推送是否就绪」的说明行）。 */
  private lastStatusResult: GitSyncResult | null = null;
  /** 页面主滚动容器：校验失败时滚回顶部，让红色汇总与第一个错误字段进入视野。 */
  private pageScroller: Scroller = new Scroller();
  /** 远程控制的「旧数据 → manual」迁移是否已经做过（只做一次，见 `applySettings`）。 */
  private remoteMigrated: boolean = false;
  /**
   * 待用户确认的导入计划（**就是 dry-run 那一份**）。
   *
   * 确认导入时直接把它交给 `appendImportPlan`，**绝不重新解析文件**：两次读取之间本机记录
   * 可能已被别的页面改动，重新规划会得到与用户看到的统计不一致的结果（`docs/EXPORT-IMPORT.md` §4.1）。
   * `null` = 没有待确认的计划（没选文件 / 已取消 / 已确认落盘）。
   */
  private pendingImport: ImportPlan | null = null;

  aboutToAppear(): void {
    this.platformText = isHarmonyOS() ? 'HarmonyOS' : 'Android';
    const features = getFeatures();
    this.handwritingText = features.handwriting ? '手写可用' : '手写不可用';
    this.ocrText = features.ocr ? 'OCR 可用' : 'OCR 不可用';
    const storedFilter: boolean | undefined = AppStorage.get<boolean>(HOME_INCLUDE_OTHER_KEY);
    this.includeOtherDevices = storedFilter === true;
    this.readAutoAction();
    this.bootstrap();
  }

  aboutToDisappear(): void {
    // 页面销毁后不要再改状态（异步回调里用 disposed 拦截），避免销毁后 setState 崩溃
    this.disposed = true;
    this.webReady = false;
  }

  private readAutoAction(): void {
    try {
      const params = router.getParams() as Record<string, string>;
      if (params === undefined || params === null) {
        return;
      }
      const action = params['autoAction'];
      if (action !== undefined) {
        this.autoAction = action;
      }
    } catch {
      this.autoAction = '';
    }
  }

  private async bootstrap(): Promise<void> {
    const context = getContext(this) as common.UIAbilityContext;
    try {
      await settingsStore.init(context);
      const settings = await settingsStore.load();
      if (this.disposed) {
        return;
      }
      this.applySettings(settings);
      // Git 扩展设置（分支 / 平台）：单独 preferences，读失败内部退回默认值
      const extras: GitSyncExtras = await gitExtrasStore.load(context);
      if (this.disposed) {
        return;
      }
      this.applyExtras(extras);
      // 让 Git 桥使用与应用一致的沙箱根目录（G 的服务支持静态预置，缺省时才回落 getContext()）
      GitSyncService.setFilesDir(context.filesDir);
      await scheduleStore.ensureReady(context);
      if (this.disposed) {
        return;
      }
      this.ready = true;
      this.storageHint = `日程目录：${scheduleStore.deviceRoot()}/schedules/`;
      this.configure();
      // 分支/平台可能已经改过：等桥就绪后补一次本地状态（不联网，只是 git.status/log）
      this.refreshStatus(true);
      // Web 先于设置就绪时，自动动作排在这里补触发
      if (this.webReady && this.autoAction.length > 0) {
        const pending = this.autoAction;
        this.autoAction = '';
        this.runAction(pending);
      }
    } catch (error) {
      if (this.disposed) {
        return;
      }
      this.ready = false;
      this.saveHint = `初始化失败：${describeError(error)}`;
    }
  }

  /** 把存储里的设置铺到表单上（读取与保存后共用）。 */
  private applySettings(settings: ScheduleSettings): void {
    this.deviceId = settings.deviceId;
    this.author = settings.author;
    this.repoUrl = settings.repoUrl;
    this.token = settings.token;
    // 记住已保存的 token：输入框被清空时按「沿用旧 token」处理，不要误判为空
    this.savedToken = settings.token;
    // HTTPS 用户名（Gitee 必填；GitHub 可空）
    this.gitUsername = settings.gitUsername;
    this.aiKey = settings.aiKey;
    this.aiModel = settings.aiModel;
    this.aiProviderId = settings.aiProviderId;
    this.aiBaseURL = settings.aiBaseURL;
    // 多源 fallback（`docs/AI-FALLBACK.md` §4）：三个键都由 store 归一过，这里只铺回表单；
    // 备用源的 key（`aiFallbackKey`）不在本页建输入框——保存时不传该键就保留原值。
    this.aiFallbackEnabled = settings.aiFallbackEnabled;
    this.aiFallbackSources = parseFallbackOrder(settings.aiFallbackOrder);
    this.aiFallbackMaxAttempts = normalizeMaxAttempts(settings.aiFallbackMaxAttempts);
    this.gitPlatform = normalizePlatform(settings.gitPlatform);
    this.authMode = normalizeAuthMode(settings.authMode);
    // 深色模式三态（旧数据没有该键 → system，由 settingsStore / normalizeThemeMode 归一）
    this.themeMode = normalizeThemeMode(settings.themeMode);
    this.remoteUrl = settings.remoteUrl;
    // 远程访问方式与各字段（旧数据没有这些键 → lan / 0 / 空串，由 settingsStore 归一）
    this.remoteMode = normalizeRemoteMode(settings.remoteMode);
    this.remoteLanAddress = settings.remoteLanAddress;
    this.remotePortText = String(normalizeRemotePort(settings.remotePort));
    this.remoteTailscaleHost = settings.remoteTailscaleHost;
    this.remoteCloudflareHost = settings.remoteCloudflareHost;
    this.remoteIpv6Address = settings.remoteIpv6Address;
    // 旧版本只存过 remoteUrl：仍是 manual 方式的唯一来源，不能丢
    this.remoteManualUrl = settings.remoteManualUrl.length > 0 ? settings.remoteManualUrl : settings.remoteUrl;
    // 访问令牌：读到的明文只留在 savedRemoteToken（供 mask 显示 / 拼地址 / 「没改就沿用」），
    // **不回填输入框**——输入框只存"用户这次想改成的值"，留空即"不改"。
    this.savedRemoteToken = settings.remoteToken.trim();
    this.remoteToken = '';
    // 升级迁移（**只在首次铺表单时做一次**）：老数据只有 `remoteUrl`、没有任何方式字段。
    // 若按默认的 `lan` 走，「局域网地址」是空的 → 原来能打开的地址会突然点不动。
    // 因此把它当成「手动填的完整地址」打开；用户点一次「打开远程控制」后方式就落盘成 manual。
    // 用 `remoteMigrated` 兜住：否则用户主动选了「局域网直连」再点保存，会被这段迁移拽回手动方式。
    if (!this.remoteMigrated) {
      this.remoteMigrated = true;
      if (
        this.remoteMode === REMOTE_MODE_LAN &&
        settings.remoteUrl.trim().length > 0 &&
        settings.remoteLanAddress.trim().length === 0 &&
        settings.remoteTailscaleHost.trim().length === 0 &&
        settings.remoteCloudflareHost.trim().length === 0 &&
        settings.remoteIpv6Address.trim().length === 0 &&
        settings.remoteManualUrl.trim().length === 0
      ) {
        this.remoteMode = REMOTE_MODE_MANUAL;
      }
    }
    this.lastSyncAt = settings.lastSyncAt;
    this.lastSyncError = settings.lastSyncError;
    this.lastSyncAction = normalizeSyncAction(settings.lastSyncAction);
  }

  /**
   * 深色模式三态：切换即生效 + 立即落盘。
   *
   * 顺序是「先 setColorMode 再写 preferences」：界面上用户已经看到的那一档必须立刻生效，
   * 落盘失败只回退**存储**并给一句提示，不把界面晃回去（否则用户会以为点了没反应）。
   */
  private async saveThemeMode(mode: string): Promise<void> {
    const next: string = normalizeThemeMode(mode);
    const previous: string = this.themeMode;
    this.themeMode = next;
    const context = getContext(this) as common.UIAbilityContext;
    applyThemeMode(context, next);
    const patch: SettingsPatch = { themeMode: next };
    try {
      await settingsStore.save(patch, context);
      if (this.disposed) {
        return;
      }
      this.saveHint = `深色模式：${themeModeLabel(next)}（已保存）`;
    } catch (error) {
      if (this.disposed) {
        return;
      }
      this.themeMode = previous;
      applyThemeMode(context, previous);
      this.saveHint = `深色模式保存失败：${describeError(error)}`;
    }
  }

  /**
   * 把扩展设置（分支 / 平台 / 平台锁定标记）铺到表单上。
   *
   * 平台以扩展设置为准（它能表达 gitlab/custom）；扩展设置为空时回落到 settingsStore 的
   * github/gitee，保证老数据不受影响。
   */
  private applyExtras(extras: GitSyncExtras): void {
    this.branch = extras.branch.length > 0 ? extras.branch : DEFAULT_BRANCH;
    this.platformTouched = extras.platformTouched;
    if (extras.platform.length > 0) {
      this.gitPlatform = extras.platform;
    }
    this.platformNotice = this.platformTouched
      ? `平台已固定为 ${platformLabel(this.gitPlatform)}（手动选择优先）`
      : '';
  }

  /** 作者邮箱按设备标识派生（同步提交只用于署名，不涉及个人邮箱）。 */
  private authorEmail(): string {
    const id = normalizeDeviceId(this.deviceId);
    return `${id}@schedule.local`;
  }

  /** 把表单内容推给 GitSyncService（每次操作前都推一次，避免用旧配置）。 */
  private configure(): void {
    const config: GitSyncConfig = {
      repoUrl: this.repoUrl.trim(),
      // 分支可配（A2）：空值回落 main，非法值由 `runAction` / 服务层统一拦住
      branch: normalizeBranchName(this.branch).length > 0 ? normalizeBranchName(this.branch) : DEFAULT_BRANCH,
      deviceId: normalizeDeviceId(this.deviceId),
      token: this.token.trim(),
      authorName: this.author.trim().length > 0 ? this.author.trim() : normalizeDeviceId(this.deviceId),
      authorEmail: this.authorEmail(),
      // A1：平台决定 HTTPS 用户名兜底与示例文案；认证方式决定是否放行同步
      platform: this.gitPlatform,
      gitUsername: this.gitUsername.trim(),
      authMode: this.authMode
    };
    this.sync.configure(config);
  }

  /**
   * 保存：先做全字段校验（红字提示），全部通过才写 preferences。
   *
   * 仓库地址**允许为空**（首次使用先改设备标识/作者名/AI key 不应该被卡住），空地址会在
   * 「测试连接 / 立即同步 / 推送 / 查看状态」前被强校验拦住（见 `runAction` / `testConnection`）。
   * AI 源与模型只传原始值：`settingsStore.save()` 内部做 `resolveModel` / `aiBaseURLFor` 归一。
   */
  /**
   * 把校验问题摊到各字段的 `*Error` 状态上。
   *
   * 两条硬约束（对应线上「幽灵报错」：横幅说有 N 项，界面却没有一处红字）：
   * 1. **每个 issue 都必须落到一个可见字段的内联错误状态**，否则它就是**不可见问题**；
   * 2. 顶部横幅只统计**真正写进了内联状态的**问题（`applied`），绝不出现「说有 N 项但看不到」。
   */
  private applyIssues(issues: SettingsFieldIssue[]): void {
    this.deviceIdError = '';
    this.authorError = '';
    this.repoUrlError = '';
    this.tokenError = '';
    this.aiModelError = '';
    this.aiBaseUrlError = '';
    this.gitUsernameError = '';
    const applied: SettingsFieldIssue[] = [];
    for (const issue of issues) {
      if (issue.field === FIELD_DEVICE_ID) {
        this.deviceIdError = issue.message;
      } else if (issue.field === FIELD_AUTHOR) {
        this.authorError = issue.message;
      } else if (issue.field === FIELD_REPO_URL) {
        this.repoUrlError = issue.message;
      } else if (issue.field === FIELD_TOKEN) {
        this.tokenError = issue.message;
      } else if (issue.field === FIELD_GIT_USERNAME) {
        this.gitUsernameError = issue.message;
      } else if (issue.field === FIELD_AI_MODEL) {
        this.aiModelError = issue.message;
        this.advancedOpen = true;
      } else if (issue.field === FIELD_AI_BASE_URL) {
        this.aiBaseUrlError = issue.message;
        this.advancedOpen = true;
      } else {
        // 未知字段：没有内联渲染位置，不计入横幅（守卫测试保证走不到这里）
        continue;
      }
      applied.push(issue);
    }
    // 横幅只来自 applied；万一全都没映射（理论不可达），宁可报出来也不静默卡住保存
    this.issuesSummary = describeIssues(applied.length > 0 || issues.length === 0 ? applied : issues);
    this.firstIssueText = applied.length > 0 ? describeFirstIssue(applied) : '';
  }

  private async saveSettings(): Promise<void> {
    const repoEmpty: boolean = this.repoUrl.trim().length === 0;
    const repoCheck: RepoUrlCheck = validateRepoUrl(this.repoUrl);
    // A1：平台按地址推断（用户手动改过则以用户为准）——保存前算出最终值 + 一行提示
    const platformResolution: PlatformResolution = resolvePlatformSelection(
      this.repoUrl,
      this.gitPlatform,
      this.platformTouched
    );
    const platform: string = platformResolution.platform;
    // 整表校验交给纯函数：一次返回**全部**问题，页面逐字段标红 + 顶部汇总
    const issues: SettingsFieldIssue[] = checkSettingsFields(
      {
        deviceId: this.deviceId,
        author: this.author,
        repoUrl: this.repoUrl,
        token: this.token,
        authMode: this.authMode,
        savedToken: this.savedToken,
        customProvider: this.isCustomProvider(),
        aiModel: this.aiModel,
        aiBaseURL: this.aiBaseURL
      },
      repoCheck
    );
    // HTTPS 用户名（Gitee 必填）：用**纠正后**的平台判定，URL 改了平台没改也不会漏报
    const usernameIssue: SettingsFieldIssue | null = this.gitUsernameIssue(platform);
    if (usernameIssue !== null) {
      issues.push(usernameIssue);
    }
    this.applyIssues(issues);
    // A2：分支名（不进 settingsForm 的那张表，单独落内联红字 + 拦保存）
    const branchProblem: string = validateBranchName(this.branch);
    this.branchError = branchProblem;
    // 无可见落点的 issue 不拦保存（Settings 属凭据敏感文件，禁止 console/hilog，故这里静默跳过）。
    const blocking: boolean = this.issuesSummary.length > 0 || branchProblem.length > 0;
    if (blocking) {
      this.saveHint = this.issuesSummary.length > 0 ? this.issuesSummary : branchProblem;
      // 滚回顶部：红色汇总 + 第一个错误字段（设备标识/作者名/token/仓库地址都在同步组）
      this.pageScroller.scrollEdge(Edge.Top);
      return;
    }
    const context = getContext(this) as common.UIAbilityContext;
    try {
      const patch: SettingsPatch = {
        deviceId: normalizeDeviceId(this.deviceId),
        // 保留用户输入的地址原文，只去掉首尾空白（末尾 .git 不擅自增删）；空地址存空串
        repoUrl: repoEmpty ? '' : repoCheck.url,
        // 输入框留空 = 沿用已保存的 token（不要把旧 token 清空）
        token: effectiveToken(this.token, this.savedToken),
        aiKey: this.aiKey,
        aiProviderId: this.aiProviderId,
        aiModel: this.aiModel,
        aiBaseURL: this.aiBaseURL,
        author: this.author,
        // settingsStore 只认 github/gitee（它的 normalizePlatform 会把 gitlab/custom 折成 github），
        // 真正的四值平台存在 gitExtrasStore 里，这里写回一个它认识的等价物即可。
        gitPlatform: platform === GITEE_PLATFORM ? GITEE_PLATFORM : PLATFORM_GITHUB,
        authMode: this.authMode,
        // HTTPS 用户名（Gitee 必填登录名；GitHub 留空由同步层回落 x-access-token）
        gitUsername: this.gitUsername.trim(),
        // 远程控制地址也随整表保存：否则「保存设置」后 applySettings 会把刚输入的值退回旧值。
        // 这里存原文，点「打开远程控制」时再由 normalizeRemoteUrl 归一。
        remoteUrl: this.remoteUrl,
        // 访问方式与各方式字段一并落盘（与 remoteUrl 成对，缺一项下次进设置页就会退回默认）
        remoteMode: this.remoteMode,
        remoteLanAddress: this.remoteLanAddress,
        remotePort: normalizeRemotePort(Number.parseInt(this.remotePortText.trim(), 10)),
        remoteTailscaleHost: this.remoteTailscaleHost,
        remoteCloudflareHost: this.remoteCloudflareHost,
        remoteIpv6Address: this.remoteIpv6Address,
        remoteManualUrl: this.remoteManualUrl,
        // 访问令牌：输入框留空 = 沿用已保存的（**不能**把空串写进去，那等于悄悄清除令牌）；
        // 想清除只有「清除令牌」那一个入口。
        remoteToken: this.effectiveRemoteToken(),
        // 多源 fallback：开关 / 次数 / 备用顺序（顺序先过 serializeFallbackOrder：去重 + 最多 3 条）。
        // 备用源的共用 key（`aiFallbackKey`）**不传**——不传即保留 preferences 里的原值，
        // 本页没有这个输入框，也就不该在保存时把它写空。
        aiFallbackEnabled: this.aiFallbackEnabled,
        aiFallbackMaxAttempts: normalizeMaxAttempts(this.aiFallbackMaxAttempts),
        aiFallbackOrder: serializeFallbackOrder(this.aiFallbackSources)
      };
      const saved = await settingsStore.save(patch, context);
      if (this.disposed) {
        return;
      }
      // A2：分支 + 平台（四值）+ 平台锁定标记单独落盘
      const extras: GitSyncExtras = await gitExtrasStore.save(
        {
          branch: normalizeBranchName(this.branch),
          platform: platform,
          platformTouched: this.platformTouched
        },
        context
      );
      if (this.disposed) {
        return;
      }
      this.applySettings(saved);
      this.applyExtras(extras);
      this.gitPlatform = platform;
      this.platformNotice = platformResolution.notice;
      this.issuesSummary = '';
      this.branchError = '';
      scheduleStore.setDeviceId(saved.deviceId);
      this.storageHint = `日程目录：${scheduleStore.deviceRoot()}/schedules/`;
      this.configure();
      let hint: string = `设置已保存（${nowIso()}）`;
      if (repoEmpty) {
        hint = `设置已保存（${nowIso()}）；仓库地址为空，同步前需要先填写`;
      } else if (isSshAuthMode(this.authMode)) {
        hint = `设置已保存（${nowIso()}）；${SSH_UNSUPPORTED_SHORT}，请切回 HTTPS(PAT) 后再同步`;
      }
      if (platformResolution.notice.length > 0) {
        hint = `${hint}；${platformResolution.notice}`;
      }
      if (this.branch !== normalizeBranchName(this.branch)) {
        this.branch = normalizeBranchName(this.branch);
      }
      this.saveHint = hint;
      promptAction.showToast({ message: '设置已保存' });
    } catch (error) {
      if (this.disposed) {
        return;
      }
      this.saveHint = `保存失败：${describeError(error)}`;
    }
  }

  /**
   * 选择平台（只改文案与示例，同步协议不变）。
   *
   * 点过就以用户为准（`platformTouched`）：之后保存时不再被地址推断覆盖。
   */
  private pickPlatform(value: string): void {
    this.gitPlatform = normalizeGitPlatform(value);
    this.platformTouched = true;
    this.platformNotice = `已手动选择 ${platformLabel(this.gitPlatform)}（保存后不再按地址推断）`;
  }

  /** 仓库地址变化时更新平台提示（只提示，保存时才真正采用推断值）。 */
  private syncPlatformNotice(): void {
    const resolution: PlatformResolution = resolvePlatformSelection(
      this.repoUrl,
      this.gitPlatform,
      this.platformTouched
    );
    if (this.platformTouched) {
      this.platformNotice = resolution.inferred.length > 0 && resolution.inferred !== this.gitPlatform
        ? `地址看起来是 ${platformLabel(resolution.inferred)}，但平台已按你的选择固定为 ${platformLabel(this.gitPlatform)}`
        : `平台已固定为 ${platformLabel(this.gitPlatform)}（手动选择优先）`;
      return;
    }
    this.platformNotice = resolution.inferred.length > 0
      ? `地址识别为 ${platformLabel(resolution.inferred)}（保存时采用）`
      : '';
  }

  /** 选择认证方式（影响 token 是否必填与示例文案）。 */
  private pickAuthMode(value: string): void {
    this.authMode = normalizeAuthMode(value);
    this.gitUsernameError = '';
    // 切到 SSH 时 token 不再必填，清掉残留的必填红字
    if (this.authMode === AUTH_SSH) {
      this.tokenError = '';
      this.syncMessage = `${SSH_UNSUPPORTED_SHORT}：SSH 不会被使用，请切回 HTTPS(PAT)`;
    }
  }

  /** 当前认证方式的阻塞原因（空串 = 可同步）；页面据此禁用按钮并说明原因。 */
  private authBlocker(): string {
    return describeAuthModeBlocker(this.authMode);
  }

  /** 推送按钮的阻塞原因（空串 = 可以推）：未就绪 / SSH / 无地址 / 分支非法 / 无改动。 */
  private pushBlockedReason(): string {
    if (isSshAuthMode(this.authMode)) {
      return `${SSH_UNSUPPORTED_SHORT}：SSH 下无法推送`;
    }
    if (this.repoUrl.trim().length === 0) {
      return '推送前需要先填写并保存仓库地址';
    }
    const branchProblem: string = validateBranchName(this.branch);
    if (branchProblem.length > 0) {
      return branchProblem;
    }
    return '';
  }

  // ------------------------------------------------------------------ 测试连接

  /** Git 探测用的 Basic 认证头（token 只在这里出现，不打印、不落盘）。 */
  private basicAuthHeader(): string {
    const encoder: util.TextEncoder = new util.TextEncoder();
    const helper: util.Base64Helper = new util.Base64Helper();
    // P0：用户名必须按平台解析（Gitee = 登录名，写死 x-access-token 必然 401）
    const username: string = resolveGitUsername(this.gitPlatform, this.gitUsername);
    return helper.encodeToStringSync(encoder.encodeInto(`${username}:${this.token.trim()}`));
  }

  /**
   * 对仓库发一次真实的 Git smart-HTTP 探测（`GET <repo>/info/refs?service=git-upload-pack`）。
   * 不依赖隐藏 Web 就绪，也不新增网络权限（INTERNET 已声明）。
   */
  private async probeRepo(url: string): Promise<number> {
    const request = http.createHttp();
    const headers: Record<string, string> = { 'User-Agent': 'dsh-arkui-schedule' };
    if (this.token.trim().length > 0) {
      headers['Authorization'] = `Basic ${this.basicAuthHeader()}`;
    }
    const options: http.HttpRequestOptions = {
      method: http.RequestMethod.GET,
      header: headers,
      expectDataType: http.HttpDataType.STRING,
      connectTimeout: PROBE_TIMEOUT_MS,
      readTimeout: PROBE_TIMEOUT_MS
    };
    try {
      const response: http.HttpResponse = await request.request(url, options);
      return response.responseCode;
    } finally {
      try {
        request.destroy();
      } catch (error) {
        // 已销毁/未开始：忽略
      }
    }
  }

  /** 「测试连接」：校验地址 → 探测仓库 → 中文结果（可达/不可达 + 状态码或错误）。 */
  private async testConnection(): Promise<void> {
    if (this.connectionBusy) {
      return;
    }
    const repoCheck: RepoUrlCheck = validateRepoUrl(this.repoUrl);
    this.repoUrlError = repoCheck.ok ? '' : repoCheck.error;
    if (!repoCheck.ok) {
      this.connectionText = `❌ 无法测试：${repoCheck.error}`;
      return;
    }
    if (repoCheck.scheme === 'ssh' || repoCheck.scheme === 'scp') {
      this.connectionText = `ℹ️ ${SSH_UNSUPPORTED_SHORT}：SSH 地址不会被应用使用（内置同步内核只有 HTTP(S) 传输），请改成 https:// 地址再测`;
      return;
    }
    const probeUrl: string = repoProbeUrl(repoCheck.url);
    if (probeUrl.length === 0) {
      this.connectionText = '❌ 无法生成探测地址：请填写 https:// 或 http:// 形式的仓库地址';
      return;
    }
    this.connectionBusy = true;
    this.connectionText = `正在探测 ${repoCheck.host} …`;
    try {
      const code: number = await this.probeRepo(probeUrl);
      if (this.disposed) {
        return;
      }
      this.connectionText = describeRepoProbe(code, '');
    } catch (error) {
      if (this.disposed) {
        return;
      }
      this.connectionText = describeRepoProbe(0, describeError(error));
    } finally {
      if (!this.disposed) {
        this.connectionBusy = false;
      }
    }
  }

  // ------------------------------------------------------------------ 测试 AI

  /**
   * 「测试」：用最小 prompt 调一次当前源，结果只显示一行。
   * 传 4 参 → 用「填了但还没保存」的源/模型/地址也能测；`testAiConnection` 不抛异常。
   */
  private async testAi(): Promise<void> {
    if (this.aiTestBusy) {
      return;
    }
    if (this.aiKey.trim().length === 0) {
      this.aiTestText = '失败：请先填写 API Key';
      this.aiTestHint = findProvider(this.aiProviderId).keyHint;
      return;
    }
    this.aiTestBusy = true;
    this.aiTestText = '正在测试…';
    this.aiTestHint = '';
    try {
      const result: AiTestResult = await testAiConnection(
        this.aiKey,
        this.aiProviderId,
        this.aiModel,
        this.aiBaseURL
      );
      if (this.disposed) {
        return;
      }
      // 真实往返耗时由 testAiConnection 给出（未发出请求时为 0，此时不显示 ms）；
      // 失败文案里已含源名与错误码，原样展示；再加一行「下一步做什么」。
      const tail: string = result.elapsedMs > 0 ? ` · ${result.elapsedMs}ms` : '';
      this.aiTestText = result.ok ? `成功${tail}` : `${result.message}${tail}`;
      this.aiTestHint = result.ok ? '' : hintForProvider(this.aiProviderId, result.status);
    } catch (error) {
      if (this.disposed) {
        return;
      }
      this.aiTestText = `失败：${describeError(error)}`;
      this.aiTestHint = hintForProvider(this.aiProviderId, 0);
    } finally {
      if (!this.disposed) {
        this.aiTestBusy = false;
      }
    }
  }

  // ------------------------------------------------------------------ 导出 / 导入（A 线）

  /**
   * 导出：把面板回传的区间 / 格式 / 两个开关交给 `exportSchedules`（只读派生，不改源文件）。
   *
   * 说明：`ExportRequest` 的字段是 `fromText` / `toText`，服务层的 `ExportRequestInput` 是
   * `from` / `to`——**不是同名透传**，这里显式映射（只改调用侧，不动服务层与组件）。
   */
  private handleExport(request: ExportRequest): void {
    if (this.disposed) {
      return;
    }
    this.exportImport = withPanelMessage(this.exportImport, '', true);
    const input: ExportRequestInput = {
      from: request.fromText,
      to: request.toText,
      format: request.format,
      includeAttachments: request.includeAttachments,
      includeMeta: request.includeMeta
    };
    try {
      const result: ExportFileResult = exportSchedules(input);
      if (this.disposed) {
        return;
      }
      if (!result.ok) {
        this.exportImport = withPanelMessage(this.exportImport, `导出失败：${result.reason}`, false);
        return;
      }
      this.exportImport = withExportPath(
        withPanelMessage(this.exportImport, `已导出 ${result.recordCount} 条（${result.fileName}）`, false),
        result.path
      );
      promptAction.showToast({ message: '已导出', duration: toastMsFor(false) });
    } catch (error) {
      if (this.disposed) {
        return;
      }
      this.exportImport = withPanelMessage(this.exportImport, `导出失败：${describeError(error)}`, false);
    }
  }

  /**
   * 导入第一步：选文件 → dry-run 统计（**一个字节都不写**）。
   *
   * 把计划存进 `pendingImport`，等用户点「确认导入」才落盘；选文件失败 / 文件不可解析都只改
   * `exportImport.message`（中文），绝不留半份计划。
   */
  private async handlePickImportFile(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.exportImport = withPanelMessage(this.exportImport, '', true);
    try {
      const context = getContext(this) as common.UIAbilityContext;
      const picked: ImportFilePickResult = await pickImportFile(context);
      if (this.disposed) {
        return;
      }
      if (!picked.ok) {
        this.pendingImport = null;
        this.exportImport = withPanelMessage(this.exportImport, `选择文件失败：${picked.reason}`, false);
        return;
      }
      const planned: ImportPlanResult = planImportFromText(picked.text, picked.fileName);
      if (this.disposed) {
        return;
      }
      if (planned.plan === null) {
        this.pendingImport = null;
        this.exportImport = withPanelMessage(this.exportImport, `无法读取导入文件：${planned.reason}`, false);
        return;
      }
      this.pendingImport = planned.plan;
      const tip: string =
        planned.plan.conflict > 0 ? '有冲突记录（同 id 且更新）：本机版本不会被覆盖，需人工决定' : '';
      this.exportImport = applyPlan(
        withImportFileName(withPanelMessage(this.exportImport, tip, false), picked.fileName),
        planned.plan
      );
    } catch (error) {
      if (this.disposed) {
        return;
      }
      this.pendingImport = null;
      this.exportImport = withPanelMessage(this.exportImport, `选择文件失败：${describeError(error)}`, false);
    }
  }

  /**
   * 导入第二步：用户点「确认导入」，把**同一份 dry-run 计划**追加落盘。
   *
   * 落盘后清掉 dry-run（避免同一份文件被连点两次追加两遍），提示里保留追加 / 跳过 / 冲突计数。
   */
  private handleConfirmImport(): void {
    const plan: ImportPlan | null = this.pendingImport;
    if (plan === null) {
      if (this.disposed) {
        return;
      }
      this.exportImport = withPanelMessage(this.exportImport, '没有待确认的导入计划：请先选择 JSON 文件', false);
      return;
    }
    try {
      const applied: ImportApplyResult = appendImportPlan(plan);
      this.pendingImport = null;
      if (this.disposed) {
        return;
      }
      if (!applied.ok) {
        this.exportImport = withPanelMessage(this.exportImport, `导入失败：${applied.reason}`, false);
        return;
      }
      const done: string =
        `已追加 ${applied.appended} 条、跳过 ${applied.skipped} 条、冲突 ${applied.conflict} 条` +
        `（非法 ${applied.invalid} 条未写入）`;
      this.exportImport = withPanelMessage(clearDryRun(this.exportImport), done, false);
      promptAction.showToast({ message: `已导入 ${applied.appended} 条`, duration: toastMsFor(false) });
    } catch (error) {
      if (this.disposed) {
        return;
      }
      this.exportImport = withPanelMessage(this.exportImport, `导入失败：${describeError(error)}`, false);
    }
  }

  /** 取消导入：丢掉待确认计划 + 清空 dry-run 统计（本机记录没有任何改动）。 */
  private handleCancelImport(): void {
    this.pendingImport = null;
    if (this.disposed) {
      return;
    }
    this.exportImport = withPanelMessage(clearDryRun(this.exportImport), '已取消导入（本机记录没有任何改动）', false);
  }

  /**
   * 复制导出路径到系统剪贴板（面板里也有「长按路径可复制」这一条退路）。
   *
   * 复制目标优先「最近一次导出的文件路径」，还没导出过就复制导出目录（`exportsDirPath()`），
   * 用户至少知道文件在哪。剪贴板写入失败不弹崩溃，只把原因写进面板提示。
   */
  private async handleCopyPath(): Promise<void> {
    const target: string = this.exportImport.exportPath.length > 0 ? this.exportImport.exportPath : exportsDirPath();
    try {
      const data: pasteboard.PasteData = pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, target);
      await pasteboard.getSystemPasteboard().setData(data);
      if (this.disposed) {
        return;
      }
      promptAction.showToast({ message: '路径已复制', duration: toastMsFor(false) });
    } catch (error) {
      if (this.disposed) {
        return;
      }
      this.exportImport = withPanelMessage(
        this.exportImport,
        `复制路径失败：${describeError(error)}（可在面板里长按路径手动复制）`,
        false
      );
    }
  }

  // ------------------------------------------------------------------ 多源 fallback（C 线）

  /** 主源的展示名（`AiFallbackPanel` 的 `primaryLabel`，用于「备用源里不要再选它」的说明）。 */
  private primarySourceLabel(): string {
    const primary: FallbackSource = { providerId: this.aiProviderId, modelId: this.aiModel };
    return sourceLabel(primary);
  }

  /**
   * 新增一个备用源的初值：优先挑「既不是主源、也还没被用过」的预设源。
   *
   * 不选「自定义」：它必须手填 baseURL，作为自动加进来的初值只会让人以为配好了却发不出去。
   * 预设源都被占用时退回主源（运行器会去重，界面上也不会多出一条假源）。
   */
  private defaultFallbackSource(): FallbackSource {
    let picked: string = '';
    for (const preset of AI_PROVIDERS) {
      if (preset.id === CUSTOM_PROVIDER_ID || preset.id === this.aiProviderId) {
        continue;
      }
      let used: boolean = false;
      for (const item of this.aiFallbackSources) {
        if (item.providerId === preset.id) {
          used = true;
          break;
        }
      }
      if (!used) {
        picked = preset.id;
        break;
      }
    }
    if (picked.length === 0) {
      picked = this.aiProviderId;
    }
    const source: FallbackSource = { providerId: picked, modelId: defaultModelOf(picked) };
    return source;
  }

  /** 添加备用源（满 `MAX_FALLBACK_SOURCES` 个就不再加；组件里的按钮同时会禁用）。 */
  private addFallbackSource(): void {
    if (this.aiFallbackSources.length >= MAX_FALLBACK_SOURCES) {
      return;
    }
    const next: FallbackSource[] = [];
    for (const item of this.aiFallbackSources) {
      next.push(item);
    }
    next.push(this.defaultFallbackSource());
    this.aiFallbackSources = next;
    this.clampMaxAttempts();
  }

  /** 删除第 `index` 个备用源（越界直接忽略，空列表也不会崩）。 */
  private removeFallbackSource(index: number): void {
    if (index < 0 || index >= this.aiFallbackSources.length) {
      return;
    }
    const next: FallbackSource[] = [];
    for (let cursor = 0; cursor < this.aiFallbackSources.length; cursor++) {
      if (cursor !== index) {
        next.push(this.aiFallbackSources[cursor]);
      }
    }
    this.aiFallbackSources = next;
    this.clampMaxAttempts();
  }

  /** 上移 / 下移第 `index` 个备用源（`offset` = -1 上移 / +1 下移；越界不动）。 */
  private moveFallbackSource(index: number, offset: number): void {
    const length: number = this.aiFallbackSources.length;
    const target: number = index + offset;
    if (index < 0 || index >= length || target < 0 || target >= length || target === index) {
      return;
    }
    const next: FallbackSource[] = [];
    for (const item of this.aiFallbackSources) {
      next.push(item);
    }
    const moved: FallbackSource = next[index];
    next[index] = next[target];
    next[target] = moved;
    this.aiFallbackSources = next;
  }

  /**
   * 改写第 `index` 个备用源的一个或多个字段（`FallbackSourcePatch`）。
   *
   * ArkTS 不支持对象展开，因此逐字段合并并**重建**一条源；`baseURL` 补丁为空串表示清空
   * （切换 provider 时组件就是用它来丢掉旧地址的）。
   */
  private patchFallbackSource(index: number, patch: FallbackSourcePatch): void {
    if (index < 0 || index >= this.aiFallbackSources.length) {
      return;
    }
    const current: FallbackSource = this.aiFallbackSources[index];
    const providerId: string = patch.providerId === undefined ? current.providerId : patch.providerId;
    const modelId: string = patch.modelId === undefined ? current.modelId : patch.modelId;
    const currentBaseURL: string = current.baseURL === undefined ? '' : current.baseURL;
    const baseURL: string = patch.baseURL === undefined ? currentBaseURL : patch.baseURL;
    const updated: FallbackSource = { providerId: providerId, modelId: modelId };
    if (baseURL.length > 0) {
      updated.baseURL = baseURL;
    }
    const next: FallbackSource[] = [];
    for (let cursor = 0; cursor < this.aiFallbackSources.length; cursor++) {
      next.push(cursor === index ? updated : this.aiFallbackSources[cursor]);
    }
    this.aiFallbackSources = next;
  }

  /** 尝试次数归一（夹到 `1..MAX_ATTEMPTS_LIMIT`；备用源增减后重新夹一次）。 */
  private clampMaxAttempts(): void {
    this.aiFallbackMaxAttempts = normalizeMaxAttempts(this.aiFallbackMaxAttempts);
  }

  /**
   * 记一条 fallback 诊断（`runWithFallback` 的 `onAttempt` 回调落点）。
   *
   * 只保留**本次页面会话内**最近 `MAX_SESSION_DIAGNOSTICS` 条：诊断是即时排查用的，
   * 不落盘、不进同步载荷（`docs/AI-FALLBACK.md` §6），页面销毁后自然消失。
   */
  private recordFallbackDiagnostic(diagnostic: FallbackDiagnostic): void {
    if (this.disposed) {
      return;
    }
    const next: FallbackDiagnostic[] = [];
    for (const item of this.aiFallbackDiagnostics) {
      next.push(item);
    }
    next.push(diagnostic);
    const start: number = next.length > MAX_SESSION_DIAGNOSTICS ? next.length - MAX_SESSION_DIAGNOSTICS : 0;
    this.aiFallbackDiagnostics = next.slice(start);
  }

  // ------------------------------------------------------------------ AI 源

  /** 当前源预设（`findProvider` 永不返回 null，未知 id 回落默认源）。 */
  private provider(): AiProviderPreset {
    return findProvider(this.aiProviderId);
  }

  /** 当前模型展示名（不在预设表里时原样显示 id，custom 源允许任意名）。 */
  private modelLabel(): string {
    const id: string = this.aiModel.trim();
    const models: AiModelOption[] = modelsOf(this.aiProviderId);
    for (const item of models) {
      if (item.id === id) {
        return item.label;
      }
    }
    return id.length > 0 ? id : defaultModelOf(this.aiProviderId);
  }

  /** 切换服务：模型不在新源表里就回落到该源默认；选自定义源自动展开「高级」。 */
  private pickProvider(id: string): void {
    const preset: AiProviderPreset = findProvider(id);
    this.aiProviderId = preset.id;
    let keep: boolean = false;
    for (const item of modelsOf(preset.id)) {
      if (item.id === this.aiModel) {
        keep = true;
        break;
      }
    }
    if (!keep) {
      this.aiModel = defaultModelOf(preset.id);
    }
    if (preset.id === CUSTOM_PROVIDER_ID) {
      this.advancedOpen = true;
    }
    this.panel = PANEL_NONE;
  }

  private pickModel(id: string): void {
    this.aiModel = id;
    this.panel = PANEL_NONE;
  }

  private isCustomProvider(): boolean {
    return this.aiProviderId === CUSTOM_PROVIDER_ID;
  }

  private platformLine(): string {
    return `${this.platformText} · ${this.handwritingText} · ${this.ocrText}`;
  }

  /** 用户名输入框占位文案（跟着平台变）。 */
  private gitUsernamePlaceholder(): string {
    return gitUsernamePlaceholderFor(this.gitPlatform);
  }

  /** 用户名下方的一行说明（无错误时显示）。 */
  private gitUsernameHint(): string {
    return gitUsernameHintFor(this.gitPlatform);
  }

  /**
   * HTTPS 用户名规则：直接复用 `model/gitAuth.ts` 的 `assertHttpsUsername`
   * （设置页与同步入口共用同一条规则，避免两处判定漂移）。
   *
   * 平台用**自动纠正后**的值判断，避免「URL 是 gitee、平台还是 github」时漏报。
   */
  private gitUsernameIssue(platform: string): SettingsFieldIssue | null {
    const message: string | null = assertHttpsUsername(platform, this.authMode, this.gitUsername);
    if (message === null) {
      return null;
    }
    return { field: FIELD_GIT_USERNAME, message: message };
  }

  // ------------------------------------------------------------------ 同步逻辑

  /**
   * `Web` 页面加载完成回调。
   *
   * 注意 `GitSyncService.registerProxy()` 内部会 `controller.refresh()`，所以本方法会被
   * **调用两次**：第一次注册代理并触发刷新，第二次（刷新后的 onPageEnd）才算真正就绪。
   * 因此用 `sync.isReady()` 做幂等保护，避免「注册 → 刷新 → 再注册 → 再刷新」的死循环。
   */
  private onWebReady(): void {
    if (this.disposed) {
      return;
    }
    this.configure();
    if (!this.sync.isReady()) {
      try {
        this.sync.registerProxy();
        this.syncMessage = '同步内核已注册，正在初始化页面…';
      } catch (error) {
        this.syncMessage = `注册同步代理失败：${describeError(error)}`;
      }
      return;
    }
    this.webReady = true;
    if (!this.ready) {
      // 设置还在读盘：保留 autoAction，等 bootstrap 完成后由它触发，避免用空仓库地址发请求
      this.syncMessage = '同步内核已就绪，正在读取设置…';
      return;
    }
    this.syncMessage = this.repoUrl.trim().length === 0
      ? '同步内核已就绪；仓库地址为空，请先填写并保存（只在本机记录日程可以留空）'
      : '同步内核已就绪，可以拉取 / 推送 / 查看状态';
    // A2：桥一就绪就先读一次本地同步状态（不联网），让「领先/落后/冲突」立即可见
    this.refreshStatus(true);
    const pending = this.autoAction;
    this.autoAction = '';
    if (pending.length > 0) {
      this.runAction(pending);
    }
  }

  /**
   * 刷新同步状态（A2 第 2 条）：分支 / ahead / behind / 冲突数 / 本地改动。
   *
   * @param localOnly true = 只读本地仓库（`status(false)`，不额外发 `info/refs` 探测）；
   *                  false = 带一次真实连通性探测（用户点「查看状态」时用）。
   */
  private async refreshStatus(localOnly: boolean): Promise<void> {
    if (!this.webReady || !this.ready || this.disposed || this.syncBusy) {
      return;
    }
    const repoCheck: RepoUrlCheck = validateRepoUrl(this.repoUrl);
    if (!repoCheck.ok || (repoCheck.scheme !== 'https' && repoCheck.scheme !== 'http')) {
      return;
    }
    if (this.authBlocker().length > 0) {
      return;
    }
    try {
      this.configure();
      const result: GitSyncResult = await this.sync.status(!localOnly);
      if (this.disposed || !result.ok) {
        return;
      }
      this.lastStatusResult = result;
      this.statusLine = result.message;
    } catch (error) {
      // 状态刷新失败不影响主流程（同步结果已经展示在 syncMessage 里）
    }
  }

  /** 最近一次 status 结果 → 纯逻辑视图（供 `describePushReadiness` 生成「能不能推」的说明）。 */
  private statusView(): SyncStatusView {
    const result: GitSyncResult | null = this.lastStatusResult;
    const view: SyncStatusView = {
      initialized: result !== null && result.initialized === true,
      branch: result === null || result.branch === undefined ? DEFAULT_BRANCH : result.branch,
      head: result === null || result.commit === undefined ? '' : result.commit,
      ahead: result === null || result.ahead === undefined ? 0 : result.ahead,
      behind: result === null || result.behind === undefined ? 0 : result.behind,
      diverged: result !== null && result.diverged === true,
      conflicts: result === null || result.conflicts === undefined ? 0 : result.conflicts,
      changedCount: result === null || result.changedCount === undefined ? 0 : result.changedCount,
      remoteConfigured: result !== null && result.remoteConfigured === true,
      lastCommitMessage: ''
    };
    return view;
  }

  /** 把「上次同步」三项状态回写本机 preferences（失败不影响已完成的同步动作）。 */
  private async persistSyncState(): Promise<void> {
    if (!this.ready) {
      return;
    }
    const context = getContext(this) as common.UIAbilityContext;
    const patch: SyncStatePatch = {
      lastSyncAt: this.lastSyncAt,
      lastSyncError: this.lastSyncError,
      lastSyncAction: this.lastSyncAction
    };
    try {
      await settingsStore.saveSyncState(patch, context);
    } catch (error) {
      if (!this.disposed) {
        this.storageHint = `同步状态未能保存（不影响本次结果）：${describeError(error)}`;
      }
    }
  }

  /** 把失败结果折成「分级标题 + 详情」，写入界面并把状态落盘。 */
  private async applySyncFailure(code: string, message: string): Promise<void> {
    const info: SyncErrorInfo = classifySyncError(code, message);
    const suffix: string = info.retryable ? '（可直接重试）' : '';
    this.syncMessage = `❌ ${info.title}：${info.detail}${suffix}`;
    this.lastSyncError = `${info.title}：${info.detail}`;
    await this.persistSyncState();
  }

  private async runAction(action: string): Promise<void> {
    if (!this.webReady) {
      this.syncMessage = '同步内核尚未就绪，请稍候再试（隐藏 Web 环境仍在加载）';
      return;
    }
    const repoCheck: RepoUrlCheck = validateRepoUrl(this.repoUrl);
    this.repoUrlError = repoCheck.ok ? '' : repoCheck.error;
    if (!repoCheck.ok) {
      this.syncMessage = `请先修正仓库地址：${repoCheck.error}`;
      return;
    }
    if (repoCheck.scheme !== 'https' && repoCheck.scheme !== 'http') {
      // 同步内核（isomorphic-git + 桥）只实现 HTTPS，SSH 地址会直接失败，这里先拦住
      this.syncMessage = `${SSH_UNSUPPORTED_SHORT}：请把仓库地址改成 https:// 并切回 HTTPS(PAT)`;
      return;
    }
    // A1：SSH 认证方式在本版本没有传输层，直接拦住并写清原因（不发起任何请求）
    const authBlocker: string = this.authBlocker();
    if (authBlocker.length > 0) {
      this.syncMessage = `❌ ${authBlocker}`;
      return;
    }
    // A2：分支名先在本页校验，非法值不发请求
    const branchProblem: string = validateBranchName(this.branch);
    this.branchError = branchProblem;
    if (branchProblem.length > 0) {
      this.syncMessage = `❌ 分支名不合法：${branchProblem}`;
      return;
    }
    const op: string = normalizeSyncAction(action);
    if (op.length === 0) {
      this.syncMessage = '未知的同步动作：只支持拉取 / 推送 / 查看状态';
      return;
    }
    const label: string = syncActionLabel(op);
    this.syncBusy = true;
    this.syncMessage = `正在${label}…`;
    // 先记住动作：失败后「重试」按钮据此重放同一次操作
    this.lastSyncAction = op;
    let succeeded: boolean = false;
    try {
      this.configure();
      let result: GitSyncResult;
      if (op === 'pull') {
        result = await this.sync.pull();
      } else if (op === 'push') {
        result = await this.sync.push(`日程同步：${nowIso()}`);
      } else {
        result = await this.sync.status(true);
      }
      if (this.disposed) {
        return;
      }
      if (!result.ok) {
        const code: string = result.code === undefined ? '' : result.code;
        await this.applySyncFailure(code, result.message);
        return;
      }
      const commit = result.commit === undefined || result.commit.length === 0 ? '' : `（commit ${result.commit}）`;
      this.syncMessage = `✅ ${result.message}${commit}`;
      this.lastSyncError = '';
      this.lastSyncAt = nowIso();
      succeeded = true;
      await this.persistSyncState();
    } catch (error) {
      if (this.disposed) {
        return;
      }
      await this.applySyncFailure('', `${label}失败：${describeError(error)}`);
    } finally {
      if (!this.disposed) {
        this.syncBusy = false;
      }
    }
    // A2：动作成功后刷新一次本地状态（领先/落后/冲突），失败不影响已经展示的结果
    if (succeeded) {
      await this.refreshStatus(true);
    }
  }

  // ------------------------------------------------------------------ 远程控制

  /** 按枚举值取方式元数据（未知/空已由 `normalizeRemoteMode` 回落 `lan`）。 */
  private remoteSpecOf(mode: string): RemoteModeSpec {
    const spec: RemoteModeSpec | null = findRemoteMode(normalizeRemoteMode(mode));
    return spec === null ? REMOTE_MODES[REMOTE_MODE_LAN] : spec;
  }

  /** 当前「访问方式」的元数据（下拉框文案、字段、可用性都从这里读，页面不另写一份）。 */
  private remoteSpec(): RemoteModeSpec {
    return this.remoteSpecOf(this.remoteMode);
  }

  /** 当前方式在「访问方式」下拉框里的下标（找不到 → 0 = 局域网直连）。 */
  private remoteModeIndex(): number {
    const index: number = REMOTE_MODE_ORDER.indexOf(this.remoteSpec().mode);
    return index < 0 ? 0 : index;
  }

  /** 下拉框第 index 项的文案（`unsupported` 项明确标「不可用」，不做假开关）。 */
  private remoteModeOptionLabel(index: number): string {
    if (index < 0 || index >= REMOTE_MODE_ORDER.length) {
      return '';
    }
    const spec: RemoteModeSpec = this.remoteSpecOf(REMOTE_MODE_ORDER[index]);
    return spec.availability === REMOTE_AVAILABILITY_UNSUPPORTED ? `${spec.label}（不可用）` : spec.label;
  }

  /** 端口输入框的文本 → 合法端口（非数字/负数 → 0 = 跟 DSH 同端口）。 */
  private remotePortValue(): number {
    return normalizeRemotePort(Number.parseInt(this.remotePortText.trim(), 10));
  }

  /** 某个方式字段的元数据（标签/占位符/提示都来自 `REMOTE_MODES`，不在页面里重复）。 */
  private remoteField(key: string): RemoteModeField {
    for (const field of this.remoteSpec().fields) {
      if (field.key === key) {
        return field;
      }
    }
    const fallback: RemoteModeField = { key: key, label: '', placeholder: '', hint: '' };
    return fallback;
  }

  private remoteFieldLabel(key: string): string {
    return this.remoteField(key).label;
  }

  private remoteFieldPlaceholder(key: string): string {
    return this.remoteField(key).placeholder;
  }

  private remoteFieldHint(key: string): string {
    return this.remoteField(key).hint;
  }

  /**
   * 方式可用性提示：`unsupported` 给原因、`needs-setup` 给第一条前置条件、`ready` 空串。
   *
   * 12fp 的小字在 `uiTokens` 里没有对应令牌（只有 14/16/20 三级），所以统一用 `FONT.caption`
   * 的中性色（`text_secondary`）——「小一号、灰一点」的意图保留，字号不与设计令牌打架。
   */
  private remoteAvailabilityHint(): string {
    const spec: RemoteModeSpec = this.remoteSpec();
    if (spec.availability === REMOTE_AVAILABILITY_UNSUPPORTED) {
      return spec.unavailableReason;
    }
    if (spec.availability === REMOTE_AVAILABILITY_NEEDS_SETUP && spec.requires.length > 0) {
      return `需先准备：${spec.requires[0]}`;
    }
    return '';
  }

  /**
   * 当前方式有没有「访问令牌（可选）」字段（只有 `lan` / `ipv6` / `tailscale` 有）。
   *
   * 判据来自 `REMOTE_MODES[mode].fields`，不在页面里另写一份方式名单：插件侧改字段表时
   * 这里自动跟上，不会出现「模型说有、页面不画」或反向的漂移。
   */
  private remoteUsesToken(): boolean {
    for (const field of this.remoteSpec().fields) {
      if (field.key === 'token') {
        return true;
      }
    }
    return false;
  }

  /** 已保存的访问令牌是否存在（空串 = 未设置）。 */
  private hasSavedRemoteToken(): boolean {
    return this.savedRemoteToken.trim().length > 0;
  }

  /**
   * 最终要用的访问令牌：输入框有值就用它（用户正在改成新的），否则沿用已保存的。
   *
   * 与 `effectiveToken`（Git token）同一套语义：留空 ≠ 清除，清除必须点「清除令牌」。
   */
  private effectiveRemoteToken(): string {
    return effectiveToken(this.remoteToken, this.savedRemoteToken);
  }

  /**
   * 令牌状态小字：输入框有值 → 「保存后生效」；否则已保存 → 「已保存访问令牌（打码）」。
   *
   * 打码走 `maskRemoteToken`（前 4 + … + 后 4，太短一律 `***`），**明文永不上屏**。
   */
  private remoteTokenStatus(): string {
    if (this.remoteToken.trim().length > 0) {
      return '保存后生效';
    }
    if (this.hasSavedRemoteToken()) {
      return `已保存访问令牌（${maskRemoteToken(this.savedRemoteToken)}）`;
    }
    return '';
  }

  /**
   * 「清除令牌」：把已保存的令牌置空并立即落盘（与深色模式同样是即时生效项）。
   *
   * 失败时把内存里的旧值放回去，避免界面显示"已清除"但下次读盘又冒出来。
   */
  private async clearRemoteToken(): Promise<void> {
    const previous: string = this.savedRemoteToken;
    const context = getContext(this) as common.UIAbilityContext;
    this.savedRemoteToken = '';
    this.remoteToken = '';
    this.remoteUrlError = '';
    try {
      await settingsStore.save({ remoteToken: '' }, context);
      if (this.disposed) {
        return;
      }
      this.refreshRemotePreview();
      promptAction.showToast({ message: '已清除访问令牌', duration: toastMsFor(false) });
    } catch (error) {
      if (this.disposed) {
        return;
      }
      this.savedRemoteToken = previous;
      this.remoteUrlError = `访问令牌保存失败：${describeError(error)}`;
    }
  }

  /**
   * 方式字段 + 「DSH 地址」当前值 → 完整配置。
   *
   * `manual` 的完整地址优先取手输框（`remoteManualUrl`），为空时退回「DSH 地址」那一行：
   * 旧版本只存过 `remoteUrl`，这样升级后不会丢用户原来填的地址。
   */
  private remoteAccessConfig(): RemoteAccessConfig {
    const config: RemoteAccessConfig = defaultRemoteAccessConfig();
    config.mode = normalizeRemoteMode(this.remoteMode);
    config.lanAddress = this.remoteLanAddress.trim();
    config.port = this.remotePortValue();
    config.tailscaleHost = this.remoteTailscaleHost.trim();
    config.cloudflareHost = this.remoteCloudflareHost.trim();
    config.ipv6Address = this.remoteIpv6Address.trim();
    const manual: string = this.remoteManualUrl.trim();
    config.manualUrl = manual.length > 0 ? manual : this.remoteUrl.trim();
    // 令牌：输入框优先、留空沿用已保存值（`lan`/`ipv6`/`tailscale` 才参与拼装）
    config.token = this.effectiveRemoteToken();
    return config;
  }

  /**
   * 方式字段一变就重算「DSH 地址」那一行（它就是最终要打开的链接，用户看得到拼出来的结果）。
   *
   * `manual` 不重算：那一行就是用户正在手输的完整地址，边打边归一（补 `http://`）会把光标顶走。
   *
   * `uu` 与其它方式一样参与重算：它把「对外入口地址」归一成可打开链接（第 5 轮订正 ——
   * UU 远程确实有图形化端口映射，见 `docs/REMOTE-ACCESS-OPTIONS.md` §2.6）。
   */
  private refreshRemotePreview(): void {
    const mode: string = normalizeRemoteMode(this.remoteMode);
    if (mode === REMOTE_MODE_MANUAL) {
      return;
    }
    const built: RemoteAccessUrlResult = buildRemoteAccessUrl(this.remoteAccessConfig());
    this.remoteUrl = built.ok ? built.url : '';
  }

  /** 选择访问方式；`unsupported` 只显示原因（按钮随之禁用），不做假开关。 */
  private pickRemoteMode(index: number): void {
    const picked: string = index >= 0 && index < REMOTE_MODE_ORDER.length ? REMOTE_MODE_ORDER[index] : REMOTE_MODE_LAN;
    this.remoteMode = normalizeRemoteMode(picked);
    this.remoteUrlError = '';
    if (this.remoteMode === REMOTE_MODE_MANUAL) {
      // 切到手动方式时把当前地址接管进手输框（反向也补一次），用户不用重新敲一遍；
      // 两者只在这一行上来回同步，别处不会悄悄改「完整地址」。
      if (this.remoteManualUrl.trim().length === 0) {
        this.remoteManualUrl = this.remoteUrl;
      } else if (this.remoteUrl.trim().length === 0) {
        this.remoteUrl = this.remoteManualUrl;
      }
      return;
    }
    this.refreshRemotePreview();
  }

  /**
   * 「地址未包含 token」的橙色次要提示（**不是**错误）。
   *
   * 地址为空、或地址本身就不合法时不显示：非法由红色 `ErrorText` 表达，两种提示不打架。
   */
  private remoteTokenHint(): string {
    if (this.remoteUrl.trim().length === 0) {
      return '';
    }
    const check: RemoteUrlCheck = normalizeRemoteUrl(this.remoteUrl);
    if (!check.ok || check.hasToken) {
      return '';
    }
    return '地址未包含 token，DSH 可能要求登录';
  }

  /**
   * 「打开远程控制」：按访问方式拼地址 → 归一 → 落盘 → 再跳内嵌页。
   *
   * 顺序是刻意的：先保存再跳转，远程控制页拿到的一定是已经落盘的新地址；
   * 拼不出地址（缺字段 / `uu` 不可用）或地址非法时只标红、**不**跳转
   * （不要打开一个注定不可达的内嵌 Web）。
   */
  private async openRemote(): Promise<void> {
    const config: RemoteAccessConfig = this.remoteAccessConfig();
    const built: RemoteAccessUrlResult = buildRemoteAccessUrl(config);
    if (!built.ok) {
      // 方式侧的中文原因（缺字段 / 隧道域名带路径 / UU 入口为空 等）
      const why: string = built.reason.trim();
      this.remoteUrlError = why.length > 0 ? `地址不可用：${why}` : '地址不可用：请先填写电脑上的 DSH 地址';
      return;
    }
    this.remoteUrl = built.url;
    const check: RemoteUrlCheck = normalizeRemoteUrl(this.remoteUrl);
    if (!check.ok) {
      // 红字直接用 model/remoteUrl 给的中文原因（缺协议/有空格/不完整），空则退回通用提示
      const reason: string = check.reason.trim();
      this.remoteUrlError = reason.length > 0 ? `地址不可用：${reason}` : '地址不可用：请先填写电脑上的 DSH 地址';
      return;
    }
    this.remoteUrlError = '';
    this.remoteUrl = check.url;
    if (this.remoteMode === REMOTE_MODE_MANUAL) {
      // 手动方式的「完整地址」以归一后的地址为准，避免存一份 `192.168.1.6:3080` 半成品
      this.remoteManualUrl = check.url;
    }
    try {
      // 只写远程控制这一项（SettingsPatch 未出现的字段保持原值）
      await settingsStore.save({ remoteUrl: check.url });
      // 访问方式与各字段再存一次：第一条已经把「能打开的地址」落盘，即使第二条写入失败，
      // 用户下次进设置页仍有可用地址（不会两样都丢）。
      // 令牌走「输入框优先、留空沿用已保存」的语义：这里传的是真正拼进地址的那个值，
      // 所以「打开远程控制」也顺手把刚填的令牌保存下来（不会出现地址带新令牌、字段还是旧的）。
      const nextRemoteToken: string = this.effectiveRemoteToken();
      await settingsStore.save({
        remoteMode: this.remoteMode,
        remoteLanAddress: this.remoteLanAddress,
        remotePort: config.port,
        remoteTailscaleHost: this.remoteTailscaleHost,
        remoteCloudflareHost: this.remoteCloudflareHost,
        remoteIpv6Address: this.remoteIpv6Address,
        remoteManualUrl: this.remoteManualUrl,
        remoteToken: nextRemoteToken
      });
      this.savedRemoteToken = nextRemoteToken;
      this.remoteToken = '';
    } catch (error) {
      if (this.disposed) {
        return;
      }
      this.remoteUrlError = `远程地址保存失败：${describeError(error)}`;
      return;
    }
    if (this.disposed) {
      return;
    }
    promptAction.showToast({ message: '已保存', duration: toastMsFor(false) });
    try {
      router.pushUrl({ url: routeToRemote(), params: { url: check.url } });
    } catch (error) {
      if (!this.disposed) {
        this.remoteUrlError = `打开远程控制失败：${describeError(error)}`;
      }
    }
  }

  // ------------------------------------------------------------------ 通用 Builder

  @Builder
  FieldLabel(text: string) {
    Text(text)
      .fontSize(FONT.caption)
      .lineHeight(LINE_HEIGHT.caption)
      .fontColor($r('app.color.text_secondary'))
      .width('100%')
      .textAlign(TextAlign.Start)
  }

  /** 字段内联错误：danger 令牌（深色模式同样可见），与灰色说明文字区分开。 */
  @Builder
  ErrorText(text: string) {
    Text(text)
      .fontSize(FONT.caption)
      .lineHeight(LINE_HEIGHT.caption)
      .fontColor($r('app.color.danger'))
      .width('100%')
      .textAlign(TextAlign.Start)
  }

  /** 保存失败时的顶部红色汇总（「还有 N 项需要处理：…」+ 第一条原因）。 */
  @Builder
  IssuesBanner() {
    if (this.issuesSummary.length > 0) {
      Column({ space: SPACING.xs }) {
        Text(this.issuesSummary)
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.danger'))
          .width('100%')
          .textAlign(TextAlign.Start)
        if (this.firstIssueText.length > 0) {
          Text(this.firstIssueText)
            .fontSize(FONT.caption)
            .lineHeight(LINE_HEIGHT.caption)
            .fontColor($r('app.color.danger'))
            .width('100%')
            .textAlign(TextAlign.Start)
        }
      }
      .width('100%')
      .padding({ top: SPACING.sm, bottom: SPACING.sm, left: SPACING.md, right: SPACING.md })
      .backgroundColor($r('app.color.brand_soft'))
      .alignItems(HorizontalAlign.Start)
    }
  }

  /** 一行说明（超长省略，完整内容进 `?`）。 */
  @Builder
  HintLine(text: string) {
    Text(text)
      .fontSize(FONT.caption)
      .lineHeight(LINE_HEIGHT.caption)
      .fontColor($r('app.color.text_secondary'))
      .maxLines(1)
      .textOverflow({ overflow: TextOverflow.Ellipsis })
      .width('100%')
      .textAlign(TextAlign.Start)
  }

  /** 组标题 + 右侧「更多」入口。 */
  @Builder
  SyncHeader() {
    Row({ space: SPACING.sm }) {
      Text('同步（Git）')
        .fontSize(FONT.body)
        .lineHeight(LINE_HEIGHT.body)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('app.color.text_primary'))
        .layoutWeight(1)
        .textAlign(TextAlign.Start)
      Text('更多')
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontColor($r('app.color.brand'))
        .height(TOUCH_MIN)
        .padding({ left: SPACING.md, right: SPACING.md })
        .textAlign(TextAlign.Center)
        .onClick(() => {
          this.panel = PANEL_SYNC_MORE;
        })
    }
    .width('100%')
    .alignItems(VerticalAlign.Center)
  }

  /** 同步组：仓库地址 / token / 设备标识+作者名 / 立即同步 + 1 行状态。 */
  @Builder
  SyncGroup() {
    Column({ space: SPACING.md }) {
      this.SyncHeader()

      Row({ space: SPACING.sm }) {
        Text('仓库地址')
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
        Blank()
        Text('?')
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.brand'))
          .width(TOUCH_MIN)
          .height(TOUCH_MIN)
          .textAlign(TextAlign.Center)
          .onClick(() => {
            this.panel = PANEL_REPO;
          })
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      TextInput({ text: this.repoUrl, placeholder: repoUrlPlaceholderFor(this.gitPlatform, this.authMode) })
        .width('100%')
        .height(TOUCH_MIN + SPACING.xs)
        .fontSize(FONT.body)
        .backgroundColor($r('app.color.page_background'))
        .borderRadius(RADIUS.none)
        .padding({ left: 0, right: 0 })
        .onChange((value: string) => {
          this.repoUrl = value;
          this.repoUrlError = '';
          // A1：地址一变就更新「将按地址推断为哪个平台」的提示（保存时才真正采用）
          this.syncPlatformNotice();
        })
      Divider()
        .strokeWidth(DIVIDER)
        .color($r('app.color.divider'))
      if (this.repoUrlError.length > 0) {
        this.ErrorText(this.repoUrlError)
      } else if (this.platformNotice.length > 0) {
        // 平台推断/锁定的提示（「已按地址推断平台为 X」/「已保留你的手动选择」）
        this.HintLine(this.platformNotice)
      }

      // HTTPS 认证必须带用户名：GitHub 可留空（默认 x-access-token），Gitee 必填登录名，否则必 401
      if (this.authMode === AUTH_HTTPS) {
        this.FieldLabel('用户名（HTTPS 认证）')
        TextInput({ text: this.gitUsername, placeholder: this.gitUsernamePlaceholder() })
          .width('100%')
          .height(TOUCH_MIN + SPACING.xs)
          .fontSize(FONT.body)
          .backgroundColor($r('app.color.page_background'))
          .borderRadius(RADIUS.none)
          .padding({ left: 0, right: 0 })
          .onChange((value: string) => {
            this.gitUsername = value;
            this.gitUsernameError = '';
          })
        Divider()
          .strokeWidth(DIVIDER)
          .color($r('app.color.divider'))
        if (this.gitUsernameError.length > 0) {
          this.ErrorText(this.gitUsernameError)
        } else {
          this.HintLine(this.gitUsernameHint())
        }
      }

      this.FieldLabel(this.authMode === AUTH_SSH ? '访问 token（SSH 方式可留空）' : '访问 token（仅存本机）')
      TextInput({
        text: this.token,
        placeholder: this.authMode === AUTH_SSH ? '当前版本仅支持 HTTPS，可留空' : tokenPlaceholderFor(this.gitPlatform)
      })
        .type(InputType.Password)
        .width('100%')
        .height(TOUCH_MIN + SPACING.xs)
        .fontSize(FONT.body)
        .backgroundColor($r('app.color.page_background'))
        .borderRadius(RADIUS.none)
        .padding({ left: 0, right: 0 })
        .onChange((value: string) => {
          this.token = value;
          this.tokenError = '';
        })
      Divider()
        .strokeWidth(DIVIDER)
        .color($r('app.color.divider'))
      if (this.tokenError.length > 0) {
        this.ErrorText(this.tokenError)
      }

      // A2：分支可配（默认 main）。首次推送时远端没有该分支会自动创建（桥里 force:false）。
      Row({ space: SPACING.sm }) {
        Text('分支')
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
          .width(72)
          .textAlign(TextAlign.Start)
        TextInput({ text: this.branch, placeholder: DEFAULT_BRANCH })
          .height(TOUCH_MIN + SPACING.xs)
          .fontSize(FONT.body)
          .backgroundColor($r('app.color.page_background'))
          .borderRadius(RADIUS.none)
          .padding({ left: 0, right: 0 })
          .layoutWeight(1)
          .onChange((value: string) => {
            this.branch = value;
            this.branchError = '';
          })
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)
      Divider()
        .strokeWidth(DIVIDER)
        .color($r('app.color.divider'))
      if (this.branchError.length > 0) {
        this.ErrorText(this.branchError)
      } else {
        this.HintLine('默认 main；首次推送时远端没有该分支会自动创建（永不强制覆盖远端）')
      }

      Row({ space: SPACING.md }) {
        Column({ space: SPACING.xs }) {
          this.FieldLabel('设备标识')
          TextInput({ text: this.deviceId, placeholder: 'phone-a' })
            .width('100%')
            .height(TOUCH_MIN + SPACING.xs)
            .fontSize(FONT.body)
            .backgroundColor($r('app.color.page_background'))
            .borderRadius(RADIUS.none)
            .padding({ left: 0, right: 0 })
            .onChange((value: string) => {
              this.deviceId = value;
              this.deviceIdError = '';
            })
          Divider()
            .strokeWidth(DIVIDER)
            .color($r('app.color.divider'))
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)

        Column({ space: SPACING.xs }) {
          this.FieldLabel('作者名')
          TextInput({ text: this.author, placeholder: '例如：我' })
            .width('100%')
            .height(TOUCH_MIN + SPACING.xs)
            .fontSize(FONT.body)
            .backgroundColor($r('app.color.page_background'))
            .borderRadius(RADIUS.none)
            .padding({ left: 0, right: 0 })
            .onChange((value: string) => {
              this.author = value;
              this.authorError = '';
            })
          Divider()
            .strokeWidth(DIVIDER)
            .color($r('app.color.divider'))
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)
      }
      .width('100%')
      .alignItems(VerticalAlign.Top)

      if (this.deviceIdError.length > 0) {
        this.ErrorText(this.deviceIdError)
      }
      if (this.authorError.length > 0) {
        this.ErrorText(this.authorError)
      }

      Row({ space: SPACING.md }) {
        Button(this.syncBusy ? '同步中…' : '立即同步')
          .height(TOUCH_MIN + SPACING.sm)
          .fontSize(FONT.body)
          .backgroundColor($r('app.color.brand_soft'))
          .fontColor($r('app.color.brand'))
          .borderRadius(RADIUS.sm)
          // 闪退回归：桥未就绪时禁用（原因显示在右侧状态行），避免未就绪就发起同步
          .enabled(!this.syncBusy && this.webReady && this.authBlocker().length === 0)
          .onClick(() => {
            this.runAction('pull');
          })
        // 手动推送（A2 第 3 条）：未就绪 / SSH / 无地址 / 分支非法时禁用并给出原因
        Button('推送')
          .height(TOUCH_MIN + SPACING.sm)
          .fontSize(FONT.body)
          .backgroundColor($r('app.color.brand_soft'))
          .fontColor($r('app.color.brand'))
          .borderRadius(RADIUS.sm)
          .enabled(!this.syncBusy && this.webReady && this.pushBlockedReason().length === 0)
          .onClick(() => {
            this.runAction('push');
          })
        Text(this.syncMessage)
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor(this.syncMessage.startsWith('❌') ? $r('app.color.danger') : $r('app.color.text_secondary'))
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
          .textAlign(TextAlign.Start)
          .onClick(() => {
            this.panel = PANEL_SYNC_MORE;
          })
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      // 推送被禁用的具体原因（未就绪/SSH/无地址/分支非法），避免「按钮灰着不知道为什么」
      if (this.pushBlockedReason().length > 0) {
        this.HintLine(`推送不可用：${this.pushBlockedReason()}`)
      }

      // A2：同步状态（分支 / 领先 / 落后 / 冲突 / 本地改动）——桥就绪后自动刷新一次
      if (this.statusLine.length > 0) {
        Text(this.statusLine)
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
          .maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
          .textAlign(TextAlign.Start)
      }
      if (this.statusLine.length > 0 && describePushReadiness(this.statusView()).length > 0) {
        this.HintLine(describePushReadiness(this.statusView()))
      }

      // 从首页搬来的过滤开关：首页列表是否同时展示其他设备的只读记录
      Row({ space: SPACING.sm }) {
        Text('首页含其他设备（只读）')
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
          .layoutWeight(1)
          .textAlign(TextAlign.Start)
        Toggle({ type: ToggleType.Switch, isOn: this.includeOtherDevices })
          .selectedColor($r('app.color.brand'))
          .onChange((isOn: boolean) => {
            this.includeOtherDevices = isOn;
            AppStorage.setOrCreate<boolean>(HOME_INCLUDE_OTHER_KEY, isOn);
          })
      }
      .width('100%')
      .height(TOUCH_MIN + SPACING.sm)
      .alignItems(VerticalAlign.Center)

      if (this.lastSyncError.length > 0) {
        Text(`上次错误：${this.lastSyncError}`)
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.danger'))
          .maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
          .textAlign(TextAlign.Start)
      }

      if (this.saveHint.length > 0) {
        // 校验失败时这条也必须是红的：它在「保存」按钮正上方，用户一定看得到
        Text(this.saveHint)
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor(this.issuesSummary.length > 0 ? $r('app.color.danger') : $r('app.color.text_secondary'))
          .maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
          .textAlign(TextAlign.Start)
      }

      // 隐藏的 Git 运行环境：1x1、全透明，只用于执行 isomorphic-git（必须挂载）
      Stack() {
        Web({ src: $rawfile('git/index.html'), controller: this.gitController })
          .width(1)
          .height(1)
          .opacity(0)
          .onPageEnd(() => {
            this.onWebReady();
          })
          .onErrorReceive(() => {
            if (!this.disposed) {
              this.syncMessage = '❌ 同步内核加载失败：rawfile/git/index.html 无法加载';
            }
          })
      }
      .width(1)
      .height(1)
      .opacity(0)
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  /** AI 组：服务 / 模型 / API Key / 测试 + 折叠的高级（仅 baseURL）。 */
  @Builder
  AiGroup() {
    Column({ space: SPACING.md }) {
      Text('AI 汇总')
        .fontSize(FONT.body)
        .lineHeight(LINE_HEIGHT.body)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('app.color.text_primary'))
        .width('100%')
        .textAlign(TextAlign.Start)

      Row({ space: SPACING.sm }) {
        Text('服务')
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
          .width(72)
          .textAlign(TextAlign.Start)
        Text(this.provider().label)
          .fontSize(FONT.body)
          .lineHeight(LINE_HEIGHT.body)
          .fontColor($r('app.color.text_primary'))
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
          .textAlign(TextAlign.End)
        Text('▾')
          .fontSize(FONT.caption)
          .fontColor($r('app.color.text_secondary'))
      }
      .width('100%')
      .height(TOUCH_MIN)
      .alignItems(VerticalAlign.Center)
      .onClick(() => {
        this.panel = PANEL_PROVIDER;
      })
      Divider()
        .strokeWidth(DIVIDER)
        .color($r('app.color.divider'))

      Row({ space: SPACING.sm }) {
        Text('模型')
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
          .width(72)
          .textAlign(TextAlign.Start)
        Text(this.modelLabel())
          .fontSize(FONT.body)
          .lineHeight(LINE_HEIGHT.body)
          .fontColor($r('app.color.text_primary'))
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
          .textAlign(TextAlign.End)
        Text('▾')
          .fontSize(FONT.caption)
          .fontColor($r('app.color.text_secondary'))
      }
      .width('100%')
      .height(TOUCH_MIN)
      .alignItems(VerticalAlign.Center)
      .onClick(() => {
        this.panel = PANEL_MODEL;
      })
      Divider()
        .strokeWidth(DIVIDER)
        .color($r('app.color.divider'))

      this.FieldLabel('API Key（仅存本机）')
      TextInput({ text: this.aiKey, placeholder: 'sk-…' })
        .type(InputType.Password)
        .width('100%')
        .height(TOUCH_MIN + SPACING.xs)
        .fontSize(FONT.body)
        .backgroundColor($r('app.color.page_background'))
        .borderRadius(RADIUS.none)
        .padding({ left: 0, right: 0 })
        .onChange((value: string) => {
          this.aiKey = value;
        })
      Divider()
        .strokeWidth(DIVIDER)
        .color($r('app.color.divider'))
      this.HintLine(this.provider().keyHint)

      Row({ space: SPACING.md }) {
        Button(this.aiTestBusy ? '测试中…' : '测试')
          .height(TOUCH_MIN + SPACING.sm)
          .fontSize(FONT.body)
          .backgroundColor($r('app.color.brand_soft'))
          .fontColor($r('app.color.brand'))
          .borderRadius(RADIUS.sm)
          .enabled(!this.aiTestBusy)
          .onClick(() => {
            this.testAi();
          })
        Text(this.aiTestText.length > 0 ? this.aiTestText : '未测试')
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor(this.aiTestText.startsWith('失败') ? $r('app.color.danger') : $r('app.color.text_secondary'))
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
          .textAlign(TextAlign.Start)
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      // 失败才出现的「下一步做什么」；成功时不占行
      if (this.aiTestHint.length > 0) {
        Text(this.aiTestHint)
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
          .maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
          .textAlign(TextAlign.Start)
      }

      // 多源 fallback（`docs/AI-FALLBACK.md` §8 的挂载片段）：放在「高级」折叠区**之前**，
      // 因为「主源失败后要不要发给别家」是隐私决策，不能藏在折叠里。组件自带开关 / 列表 /
      // 次数 / 诊断，本页只接回调（改状态）与三个持久化键（保存时写回）。
      Divider()
        .strokeWidth(DIVIDER)
        .color($r('app.color.divider'))

      AiFallbackPanel({
        fallbackEnabled: this.aiFallbackEnabled,
        sources: this.aiFallbackSources,
        maxAttempts: this.aiFallbackMaxAttempts,
        diagnostics: this.aiFallbackDiagnostics,
        primaryLabel: this.primarySourceLabel(),
        onToggle: (isOn: boolean): void => {
          this.aiFallbackEnabled = isOn;
        },
        onAdd: (): void => {
          this.addFallbackSource();
        },
        onRemove: (index: number): void => {
          this.removeFallbackSource(index);
        },
        onMove: (index: number, offset: number): void => {
          this.moveFallbackSource(index, offset);
        },
        onChange: (index: number, patch: FallbackSourcePatch): void => {
          this.patchFallbackSource(index, patch);
        },
        onMaxAttempts: (value: number): void => {
          this.aiFallbackMaxAttempts = normalizeMaxAttempts(value);
        }
      })

      Row({ space: SPACING.sm }) {
        Text(this.advancedOpen ? '高级 ▾' : '高级 ▸')
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
          .height(TOUCH_MIN)
          .textAlign(TextAlign.Start)
          .onClick(() => {
            this.advancedOpen = !this.advancedOpen;
          })
      }
      .width('100%')

      if (this.advancedOpen) {
        // 模型名允许手输（三个预设源也允许，防模型下线）；留空回落到该源默认
        this.FieldLabel(this.isCustomProvider() ? '模型名（必填）' : '模型名（可手输，留空用默认）')
        TextInput({ text: this.aiModel, placeholder: defaultModelOf(this.aiProviderId) })
          .width('100%')
          .height(TOUCH_MIN + SPACING.xs)
          .fontSize(FONT.caption)
          .backgroundColor($r('app.color.page_background'))
          .borderRadius(RADIUS.none)
          .padding({ left: 0, right: 0 })
          .onChange((value: string) => {
            this.aiModel = value;
            this.aiModelError = '';
          })
        Divider()
          .strokeWidth(DIVIDER)
          .color($r('app.color.divider'))
        if (this.aiModelError.length > 0) {
          this.ErrorText(this.aiModelError)
        }

        if (this.isCustomProvider()) {
          this.FieldLabel('接口地址 baseURL')
          TextInput({ text: this.aiBaseURL, placeholder: 'https://api.example.com/v1' })
            .width('100%')
            .height(TOUCH_MIN + SPACING.xs)
            .fontSize(FONT.caption)
            .backgroundColor($r('app.color.page_background'))
            .borderRadius(RADIUS.none)
            .padding({ left: 0, right: 0 })
            .onChange((value: string) => {
              this.aiBaseURL = value;
              this.aiBaseUrlError = '';
            })
          Divider()
            .strokeWidth(DIVIDER)
            .color($r('app.color.divider'))
          if (this.aiBaseUrlError.length > 0) {
            this.ErrorText(this.aiBaseUrlError)
          }
        } else {
          this.HintLine('预设源使用内置接口地址；要自定义地址请把「服务」切到「自定义」。')
        }
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  /**
   * 远程控制组：访问方式（六选一）+ 该方式的字段 + 最终「DSH 地址」+ 打开按钮。
   *
   * 方式元数据（文案 / 字段 / 可用性 / 前置条件）全部来自 `model/remoteAccess.ts`，
   * 与插件侧 `src/remote/accessMode.ts` 是同一份语义——页面只负责画，不另写一套解释。
   * 「DSH 地址」那一行既是最终链接的预览（lan/ipv6/tailscale/cloudflare 自动拼），
   * 也是 `manual` 方式的手输框；存的仍是 `remoteUrl`（历史键，保留）。
   */
  @Builder
  RemoteGroup() {
    Column({ space: SPACING.md }) {
      Text('远程控制')
        .fontSize(FONT.body)
        .lineHeight(LINE_HEIGHT.body)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('app.color.text_primary'))
        .width('100%')
        .textAlign(TextAlign.Start)

      // 访问方式：6 项（顺序 = REMOTE_MODE_ORDER，uu 排末尾并标「不可用」）
      this.FieldLabel('访问方式')
      Select([
        { value: this.remoteModeOptionLabel(0) },
        { value: this.remoteModeOptionLabel(1) },
        { value: this.remoteModeOptionLabel(2) },
        { value: this.remoteModeOptionLabel(3) },
        { value: this.remoteModeOptionLabel(4) },
        { value: this.remoteModeOptionLabel(5) }
      ])
        .selected(this.remoteModeIndex())
        .value(this.remoteSpec().label)
        .font({ size: FONT.body })
        .optionFont({ size: FONT.body })
        .selectedOptionFont({ size: FONT.body })
        .width('100%')
        .height(TOUCH_MIN + SPACING.xs)
        .onSelect((index: number) => {
          this.pickRemoteMode(index);
        })
      Divider()
        .strokeWidth(DIVIDER)
        .color($r('app.color.divider'))

      // 一句话说明 + 可用性（unsupported 显示原因、needs-setup 显示第一条前置条件）
      Text(this.remoteSpec().description)
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontColor($r('app.color.text_secondary'))
        .width('100%')
        .textAlign(TextAlign.Start)
      if (this.remoteAvailabilityHint().length > 0) {
        Text(this.remoteAvailabilityHint())
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
          .width('100%')
          .textAlign(TextAlign.Start)
      }

      // ---- 各方式的字段（标签/占位符/提示都取自 REMOTE_MODES.fields）----
      if (this.remoteMode === REMOTE_MODE_LAN) {
        this.FieldLabel(this.remoteFieldLabel('lanAddress'))
        TextInput({ text: this.remoteLanAddress, placeholder: this.remoteFieldPlaceholder('lanAddress') })
          .width('100%')
          .height(TOUCH_MIN + SPACING.xs)
          .fontSize(FONT.body)
          .backgroundColor($r('app.color.page_background'))
          .borderRadius(RADIUS.none)
          .padding({ left: 0, right: 0 })
          .onChange((value: string) => {
            this.remoteLanAddress = value;
            this.remoteUrlError = '';
            this.refreshRemotePreview();
          })
        Divider()
          .strokeWidth(DIVIDER)
          .color($r('app.color.divider'))
        this.HintLine(this.remoteFieldHint('lanAddress'))
      }

      if (this.remoteMode === REMOTE_MODE_IPV6) {
        this.FieldLabel(this.remoteFieldLabel('ipv6Address'))
        TextInput({ text: this.remoteIpv6Address, placeholder: this.remoteFieldPlaceholder('ipv6Address') })
          .width('100%')
          .height(TOUCH_MIN + SPACING.xs)
          .fontSize(FONT.body)
          .backgroundColor($r('app.color.page_background'))
          .borderRadius(RADIUS.none)
          .padding({ left: 0, right: 0 })
          .onChange((value: string) => {
            this.remoteIpv6Address = value;
            this.remoteUrlError = '';
            this.refreshRemotePreview();
          })
        Divider()
          .strokeWidth(DIVIDER)
          .color($r('app.color.divider'))
        this.HintLine(this.remoteFieldHint('ipv6Address'))
      }

      if (this.remoteMode === REMOTE_MODE_TAILSCALE) {
        this.FieldLabel(this.remoteFieldLabel('tailscaleHost'))
        TextInput({ text: this.remoteTailscaleHost, placeholder: this.remoteFieldPlaceholder('tailscaleHost') })
          .width('100%')
          .height(TOUCH_MIN + SPACING.xs)
          .fontSize(FONT.body)
          .backgroundColor($r('app.color.page_background'))
          .borderRadius(RADIUS.none)
          .padding({ left: 0, right: 0 })
          .onChange((value: string) => {
            this.remoteTailscaleHost = value;
            this.remoteUrlError = '';
            this.refreshRemotePreview();
          })
        Divider()
          .strokeWidth(DIVIDER)
          .color($r('app.color.divider'))
        this.HintLine(this.remoteFieldHint('tailscaleHost'))
      }

      if (this.remoteMode === REMOTE_MODE_CLOUDFLARE) {
        this.FieldLabel(this.remoteFieldLabel('cloudflareHost'))
        TextInput({ text: this.remoteCloudflareHost, placeholder: this.remoteFieldPlaceholder('cloudflareHost') })
          .width('100%')
          .height(TOUCH_MIN + SPACING.xs)
          .fontSize(FONT.body)
          .backgroundColor($r('app.color.page_background'))
          .borderRadius(RADIUS.none)
          .padding({ left: 0, right: 0 })
          .onChange((value: string) => {
            this.remoteCloudflareHost = value;
            this.remoteUrlError = '';
            this.refreshRemotePreview();
          })
        Divider()
          .strokeWidth(DIVIDER)
          .color($r('app.color.divider'))
        this.HintLine(this.remoteFieldHint('cloudflareHost'))
      }

      // 端口：只有要起监听的方式才填（cloudflare 对外恒 443，manual 由地址自带端口）
      if (
        this.remoteMode === REMOTE_MODE_LAN ||
        this.remoteMode === REMOTE_MODE_IPV6 ||
        this.remoteMode === REMOTE_MODE_TAILSCALE
      ) {
        this.FieldLabel(this.remoteFieldLabel('port'))
        TextInput({ text: this.remotePortText, placeholder: this.remoteFieldPlaceholder('port') })
          // 纯数字键盘；ArkTS 里输入类型写在属性上（`.type(InputType.Number)`），
          // 等价于给输入框声明 inputType=Number。
          .type(InputType.Number)
          .width('100%')
          .height(TOUCH_MIN + SPACING.xs)
          .fontSize(FONT.body)
          .backgroundColor($r('app.color.page_background'))
          .borderRadius(RADIUS.none)
          .padding({ left: 0, right: 0 })
          .onChange((value: string) => {
            this.remotePortText = value;
            this.remoteUrlError = '';
            this.refreshRemotePreview();
          })
        Divider()
          .strokeWidth(DIVIDER)
          .color($r('app.color.divider'))
        this.HintLine(this.remoteFieldHint('port'))
      }

      // 「访问令牌（可选）」：只出现在 lan / ipv6 / tailscale 的字段表里（端口之后）。
      // 密码框里**只**是"用户这次想改成的值"（`remoteToken`）；已保存的令牌不回填，
      // 只用打码小字说明"已保存"，这样旁边有人看屏幕也看不到明文。
      if (this.remoteUsesToken()) {
        this.FieldLabel(this.remoteFieldLabel('token'))
        TextInput({ text: this.remoteToken, placeholder: this.remoteFieldPlaceholder('token') })
          .type(InputType.Password)
          .width('100%')
          .height(TOUCH_MIN + SPACING.xs)
          .fontSize(FONT.body)
          .backgroundColor($r('app.color.page_background'))
          .borderRadius(RADIUS.none)
          .padding({ left: 0, right: 0 })
          .onChange((value: string) => {
            this.remoteToken = value;
            this.remoteUrlError = '';
            this.refreshRemotePreview();
          })
        Divider()
          .strokeWidth(DIVIDER)
          .color($r('app.color.divider'))
        this.HintLine(this.remoteFieldHint('token'))
        if (this.remoteTokenStatus().length > 0) {
          Text(this.remoteTokenStatus())
            .fontSize(FONT.caption)
            .lineHeight(LINE_HEIGHT.caption)
            .fontColor($r('app.color.text_secondary'))
            .width('100%')
            .textAlign(TextAlign.Start)
        }
        if (this.hasSavedRemoteToken()) {
          Text('清除令牌')
            .fontSize(FONT.caption)
            .lineHeight(LINE_HEIGHT.caption)
            .fontColor($r('app.color.brand'))
            .height(TOUCH_MIN)
            .padding({ left: SPACING.md, right: SPACING.md })
            .textAlign(TextAlign.Center)
            .onClick(() => {
              this.clearRemoteToken();
            })
        }
      }

      if (this.remoteMode === REMOTE_MODE_MANUAL) {
        // 手动方式的「完整地址」就是下面「DSH 地址」那一行（同一个值，不画两个输入框）
        this.FieldLabel(this.remoteFieldLabel('manualUrl'))
      } else {
        this.FieldLabel('DSH 地址')
      }
      TextInput({ text: this.remoteUrl, placeholder: 'http://192.168.1.6:3080/?token=…' })
        .width('100%')
        .height(TOUCH_MIN + SPACING.xs)
        .fontSize(FONT.body)
        .backgroundColor($r('app.color.page_background'))
        .borderRadius(RADIUS.none)
        .padding({ left: 0, right: 0 })
        .onChange((value: string) => {
          this.remoteUrl = value;
          // 手动方式下这一行就是「完整地址」字段：两份状态同步，拼地址与落盘才不会打架
          if (this.remoteMode === REMOTE_MODE_MANUAL) {
            this.remoteManualUrl = value;
          }
          this.remoteUrlError = '';
        })
      Divider()
        .strokeWidth(DIVIDER)
        .color($r('app.color.divider'))
      if (this.remoteUrlError.length > 0) {
        this.ErrorText(this.remoteUrlError)
      } else {
        this.HintLine('平板需与电脑在同一局域网；地址含 token，只存本机')
      }

      // 缺 token：橙色次要提示（不是错误，DSH 仍可能直接可用）
      if (this.remoteTokenHint().length > 0) {
        Text(this.remoteTokenHint())
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.warning'))
          .width('100%')
          .textAlign(TextAlign.Start)
      }

      Button('打开远程控制')
        .width('100%')
        .height(48)
        .fontSize(FONT.body)
        .backgroundColor($r('app.color.brand'))
        .fontColor($r('app.color.text_inverse'))
        .borderRadius(RADIUS.sm)
        // 空地址禁用（提示写在按钮下方，用户知道先做什么）
        .enabled(this.remoteUrl.trim().length > 0)
        .onClick(() => {
          this.openRemote();
        })
      if (this.remoteUrl.trim().length === 0) {
        Text('先填写电脑上的 DSH 地址')
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
   * 深色模式那行说明：跟随系统时补一句「系统当前为深/浅」，让用户知道实际生效的是哪一档。
   *
   * 判定一律走纯函数（`resolveTheme` + `isSystemDark`），页面不自己拼字符串规则。
   */
  private themeModeHintText(): string {
    const hint: string = themeModeHint(this.themeMode);
    if (normalizeThemeMode(this.themeMode) !== 'system') {
      return hint;
    }
    const context = getContext(this) as common.UIAbilityContext;
    const effective: string = resolveTheme('system', isSystemDark(context));
    return `${hint}（系统当前：${effective === 'dark' ? '深色' : '浅色'}）`;
  }

  /**
   * 深色模式行：标签 + 三态片 + 一行说明（唯一入口，紧凑/宽屏两套骨架共用）。
   *
   * 布局规则（大字号验收的「表单行」代表）：标签 `layoutWeight(1)` 可压 + `maxLines(1)` +
   * 省略号；三态片是**固定项**（`flexShrink(0)`），只守下限宽不写死宽。
   */
  @Builder
  ThemeRow() {
    Column({ space: SPACING.sm }) {
      Row({ space: SPACING.sm }) {
        Text('深色模式')
          .fontSize(FONT.body)
          .lineHeight(LINE_HEIGHT.body)
          .fontColor($r('app.color.text_primary'))
          .layoutWeight(1)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .textAlign(TextAlign.Start)

        Row({ space: SPACING.xs }) {
          ForEach(
            THEME_MODE_ORDER,
            (mode: string) => {
              Text(themeModeLabel(mode))
                .fontSize(FONT.caption)
                .lineHeight(LINE_HEIGHT.caption)
                .fontColor(
                  this.themeMode === mode ? $r('app.color.brand') : $r('app.color.text_secondary')
                )
                .constraintSize({ minWidth: THEME_CHIP_MIN_WIDTH })
                .height(TOUCH_MIN)
                .padding({ left: SPACING.sm, right: SPACING.sm })
                .textAlign(TextAlign.Center)
                .borderRadius(RADIUS.sm)
                .backgroundColor(
                  this.themeMode === mode ? $r('app.color.selection_fill') : $r('app.color.control_fill')
                )
                .border({
                  width: this.themeMode === mode ? DIVIDER : 0,
                  color: $r('app.color.selection_stroke')
                })
                .maxLines(1)
                .onClick(() => {
                  this.saveThemeMode(mode);
                })
            },
            (mode: string) => `theme-${mode}`
          )
        }
        .flexShrink(0)
        .alignItems(VerticalAlign.Center)
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      Text(this.themeModeHintText())
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontColor($r('app.color.text_secondary'))
        .width('100%')
        .maxLines(2)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .textAlign(TextAlign.Start)
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  /** 关于组：版本+上次同步 / 平台信息 / 隐私? / 权限?。 */
  @Builder
  AboutGroup() {
    Column({ space: SPACING.md }) {
      Text('关于')
        .fontSize(FONT.body)
        .lineHeight(LINE_HEIGHT.body)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('app.color.text_primary'))
        .width('100%')
        .textAlign(TextAlign.Start)

      Row({ space: SPACING.sm }) {
        Text('版本 v' + APP_VERSION)
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
        Blank()
        // A2：最近一次同步时间 + 动作 + 成败（失败原因是分级后的中文）
        Text(describeLastSyncOutcome(this.lastSyncAt, this.lastSyncError, this.lastSyncAction, nowIso()))
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }
      .width('100%')

      this.HintLine(this.platformLine())
      if (this.storageHint.length > 0) {
        this.HintLine(this.storageHint)
      }

      Row({ space: SPACING.sm }) {
        Text('隐私与凭据')
          .fontSize(FONT.body)
          .lineHeight(LINE_HEIGHT.body)
          .fontColor($r('app.color.text_primary'))
          .layoutWeight(1)
          .textAlign(TextAlign.Start)
        Text('?')
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.brand'))
          .width(TOUCH_MIN)
          .height(TOUCH_MIN)
          .textAlign(TextAlign.Center)
          .onClick(() => {
            this.panel = PANEL_PRIVACY;
          })
      }
      .width('100%')
      .height(TOUCH_MIN)
      .alignItems(VerticalAlign.Center)

      Divider()
        .strokeWidth(DIVIDER)
        .color($r('app.color.divider'))

      this.ThemeRow()
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  /**
   * 数据组：导出 / 导入（排在「关于」之前）。
   *
   * 组内**只有** `ExportImportPanel` 一个组件：区间 / 格式 / 两个开关 / 导出按钮 / 选文件 /
   * dry-run 统计 / 确认 / 取消都在组件内部，这里再包一层控件就会变成两套语义。
   */
  @Builder
  DataGroup() {
    Column({ space: SPACING.md }) {
      Text('数据')
        .fontSize(FONT.body)
        .lineHeight(LINE_HEIGHT.body)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('app.color.text_primary'))
        .width('100%')
        .textAlign(TextAlign.Start)

      ExportImportPanel({
        state: this.exportImport,
        onExport: (request: ExportRequest): void => {
          this.handleExport(request);
        },
        onPickFile: (): void => {
          this.handlePickImportFile();
        },
        onConfirmImport: (): void => {
          this.handleConfirmImport();
        },
        onCancel: (): void => {
          this.handleCancelImport();
        },
        onCopyPath: (): void => {
          this.handleCopyPath();
        }
      })
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  /** 页面唯一主操作：保存设置（三组共用一份表单）。 */
  @Builder
  SaveButton() {
    Button('保存设置')
      .width('100%')
      .height(48)
      .fontSize(FONT.body)
      .backgroundColor($r('app.color.brand'))
      .fontColor($r('app.color.text_inverse'))
      .borderRadius(RADIUS.sm)
      .enabled(this.ready)
      .onClick(() => {
        this.saveSettings();
      })
  }

  /** 紧凑屏：五组自上而下。 */
  @Builder
  CompactBody() {
    Column({ space: SPACING.md }) {
      Scroll(this.pageScroller) {
        Column({ space: SPACING.xl }) {
          this.IssuesBanner()
          this.SyncGroup()
          Divider()
            .strokeWidth(DIVIDER)
            .color($r('app.color.divider'))
          this.AiGroup()
          Divider()
            .strokeWidth(DIVIDER)
            .color($r('app.color.divider'))
          this.RemoteGroup()
          Divider()
            .strokeWidth(DIVIDER)
            .color($r('app.color.divider'))
          this.DataGroup()
          Divider()
            .strokeWidth(DIVIDER)
            .color($r('app.color.divider'))
          this.AboutGroup()
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start)
        .padding({ bottom: SPACING.xl })
      }
      .layoutWeight(1)
      .width('100%')
      .scrollBar(BarState.Off)
      .align(Alignment.TopStart)

      this.SaveButton()
    }
    .width('100%')
    .height('100%')
  }

  /** 宽屏/横屏：左（同步 + 远程控制 + 数据 + 关于）/ 右（AI），底部统一保存。 */
  @Builder
  WideBody() {
    Column({ space: SPACING.md }) {
      Scroll(this.pageScroller) {
        Column({ space: SPACING.md }) {
          this.IssuesBanner()
          Row({ space: SPACING.xl }) {
            Column({ space: SPACING.xl }) {
              this.SyncGroup()
              Divider()
                .strokeWidth(DIVIDER)
                .color($r('app.color.divider'))
              this.RemoteGroup()
              Divider()
                .strokeWidth(DIVIDER)
                .color($r('app.color.divider'))
              this.DataGroup()
              Divider()
                .strokeWidth(DIVIDER)
                .color($r('app.color.divider'))
              this.AboutGroup()
            }
            .layoutWeight(1)
            .alignItems(HorizontalAlign.Start)

            Divider()
              .vertical(true)
              .strokeWidth(DIVIDER)
              .color($r('app.color.divider'))

            Column({ space: SPACING.md }) {
              this.AiGroup()
            }
            .layoutWeight(1)
            .alignItems(HorizontalAlign.Start)
          }
          .width('100%')
          .alignItems(VerticalAlign.Top)
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start)
        .padding({ bottom: SPACING.xl })
      }
      .layoutWeight(1)
      .width('100%')
      .scrollBar(BarState.Off)
      .align(Alignment.TopStart)

      this.SaveButton()
    }
    .width('100%')
    .height('100%')
  }

  // ------------------------------------------------------------------ 弹层

  @Builder
  SheetHeader(title: string) {
    Row({ space: SPACING.sm }) {
      Text(title)
        .fontSize(FONT.body)
        .lineHeight(LINE_HEIGHT.body)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('app.color.text_primary'))
        .layoutWeight(1)
        .textAlign(TextAlign.Start)
      Text('关闭')
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontColor($r('app.color.text_secondary'))
        .height(TOUCH_MIN)
        .padding({ left: SPACING.md, right: SPACING.md })
        .textAlign(TextAlign.Center)
        .onClick(() => {
          this.panel = PANEL_NONE;
        })
    }
    .width('100%')
    .alignItems(VerticalAlign.Center)
  }

  /** 一个平台 chip（A1：四个预设 GitHub / Gitee / GitLab / 自建）。 */
  @Builder
  PlatformChip(id: string) {
    Text(platformLabel(id))
      .fontSize(FONT.caption)
      .lineHeight(LINE_HEIGHT.caption)
      .fontColor(this.gitPlatform === id ? $r('app.color.brand') : $r('app.color.text_secondary'))
      .backgroundColor(this.gitPlatform === id ? $r('app.color.brand_soft') : $r('app.color.page_background'))
      .height(TOUCH_MIN)
      .layoutWeight(1)
      .textAlign(TextAlign.Center)
      .onClick(() => {
        this.pickPlatform(id);
      })
  }

  /** 同步组「更多」：推送 / 查看状态 / 重试 / 测试连接 / 平台 / 认证。 */
  @Builder
  SyncMoreSheet() {
    Column({ space: SPACING.md }) {
      this.SheetHeader('同步（Git）更多操作')

      Text('推送')
        .fontSize(FONT.body)
        .lineHeight(LINE_HEIGHT.body)
        .fontColor($r('app.color.text_primary'))
        .width('100%')
        .height(SHEET_ROW)
        .textAlign(TextAlign.Start)
        .enabled(!this.syncBusy)
        .onClick(() => {
          this.panel = PANEL_NONE;
          this.runAction('push');
        })

      Text('查看状态')
        .fontSize(FONT.body)
        .lineHeight(LINE_HEIGHT.body)
        .fontColor($r('app.color.text_primary'))
        .width('100%')
        .height(SHEET_ROW)
        .textAlign(TextAlign.Start)
        .enabled(!this.syncBusy)
        .onClick(() => {
          this.panel = PANEL_NONE;
          this.runAction('status');
        })

      if (canRetrySync(this.lastSyncAction, this.syncBusy)) {
        Text(`重试${syncActionLabel(this.lastSyncAction)}`)
          .fontSize(FONT.body)
          .lineHeight(LINE_HEIGHT.body)
          .fontColor($r('app.color.warning'))
          .width('100%')
          .height(SHEET_ROW)
          .textAlign(TextAlign.Start)
          .onClick(() => {
            this.panel = PANEL_NONE;
            this.runAction(this.lastSyncAction);
          })
      }

      Text(this.connectionBusy ? '探测中…' : '测试连接')
        .fontSize(FONT.body)
        .lineHeight(LINE_HEIGHT.body)
        .fontColor($r('app.color.text_primary'))
        .width('100%')
        .height(SHEET_ROW)
        .textAlign(TextAlign.Start)
        .enabled(!this.connectionBusy)
        .onClick(() => {
          this.testConnection();
        })

      Divider()
        .strokeWidth(DIVIDER)
        .color($r('app.color.divider'))

      this.FieldLabel('托管平台')
      Row({ space: SPACING.sm }) {
        this.PlatformChip(PLATFORM_GITHUB)
        this.PlatformChip(GITEE_PLATFORM)
      }
      .width('100%')
      Row({ space: SPACING.sm }) {
        this.PlatformChip(PLATFORM_GITLAB)
        this.PlatformChip(PLATFORM_CUSTOM)
      }
      .width('100%')
      if (this.platformNotice.length > 0) {
        this.HintLine(this.platformNotice)
      }

      this.FieldLabel('认证方式')
      Row({ space: SPACING.sm }) {
        Text('HTTPS(PAT)')
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor(this.authMode === AUTH_HTTPS ? $r('app.color.brand') : $r('app.color.text_secondary'))
          .backgroundColor(this.authMode === AUTH_HTTPS ? $r('app.color.brand_soft') : $r('app.color.page_background'))
          .height(TOUCH_MIN)
          .layoutWeight(1)
          .textAlign(TextAlign.Center)
          .onClick(() => {
            this.pickAuthMode(AUTH_HTTPS);
          })
        Text('SSH（本版本不可用）')
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor(this.authMode === AUTH_SSH ? $r('app.color.warning') : $r('app.color.text_secondary'))
          .backgroundColor(this.authMode === AUTH_SSH ? $r('app.color.brand_soft') : $r('app.color.page_background'))
          .height(TOUCH_MIN)
          .layoutWeight(1)
          .textAlign(TextAlign.Center)
          .onClick(() => {
            this.pickAuthMode(AUTH_SSH);
          })
      }
      .width('100%')

      if (this.authMode === AUTH_SSH) {
        // 明确写「仅支持 HTTPS」+ 原因，绝不让用户以为填了私钥路径就能同步
        Text(describeAuthModeBlocker(this.authMode))
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.danger'))
          .width('100%')
          .textAlign(TextAlign.Start)
      } else {
        this.HintLine(authHintFor(this.gitPlatform, this.authMode))
      }
      if (this.connectionText.length > 0) {
        this.HintLine(this.connectionText)
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  /** `?` 帮助弹层：隐私与凭据 / 仓库地址说明。 */
  @Builder
  HelpSheet() {
    Column({ space: SPACING.md }) {
      this.SheetHeader(this.panel === PANEL_PRIVACY ? '隐私与凭据' : '仓库地址')
      Scroll() {
        Column({ space: SPACING.md }) {
          if (this.panel === PANEL_PRIVACY) {
            Text('token / AI Key 只保存在本机 preferences，不会写进同步仓库（jsonl 载荷里没有凭据字段），也不会出现在日志里。')
              .fontSize(FONT.body)
              .lineHeight(LINE_HEIGHT.body)
              .fontColor($r('app.color.text_primary'))
              .width('100%')
          } else {
            Text(repoUrlExamplesFor(this.gitPlatform, this.authMode))
              .fontSize(FONT.body)
              .lineHeight(LINE_HEIGHT.body)
              .fontColor($r('app.color.text_primary'))
              .width('100%')
            Text('仓库地址可以先留空（只在本机记录日程）；留空时保存不报错，但「测试连接 / 立即同步 / 推送」前必须先填写。')
              .fontSize(FONT.caption)
              .lineHeight(LINE_HEIGHT.caption)
              .fontColor($r('app.color.text_secondary'))
              .width('100%')
            Text(`平台：${platformLabel(this.gitPlatform)}（保存时按地址自动推断；手动选过则以你的选择为准）。分支默认 ${DEFAULT_BRANCH}，首次推送时远端没有会自动创建。`)
              .fontSize(FONT.caption)
              .lineHeight(LINE_HEIGHT.caption)
              .fontColor($r('app.color.text_secondary'))
              .width('100%')
            Text(authHintFor(this.gitPlatform, this.authMode))
              .fontSize(FONT.caption)
              .lineHeight(LINE_HEIGHT.caption)
              .fontColor($r('app.color.text_secondary'))
              .width('100%')
          }
        }
        .width('100%')
      }
      .layoutWeight(1)
      .width('100%')
      .scrollBar(BarState.Auto)
      .align(Alignment.TopStart)
    }
    .width('100%')
    .constraintSize({ maxHeight: '60%' })
    .alignItems(HorizontalAlign.Start)
  }

  /** 服务 / 模型选择弹层（每行 48vp，当前项打勾）。 */
  @Builder
  PickerSheet() {
    Column({ space: SPACING.sm }) {
      this.SheetHeader(this.panel === PANEL_PROVIDER ? '选择服务' : '选择模型')
      Divider()
        .strokeWidth(DIVIDER)
        .color($r('app.color.divider'))
      if (this.panel === PANEL_PROVIDER) {
        ForEach(
          AI_PROVIDERS,
          (item: AiProviderPreset) => {
            Row({ space: SPACING.sm }) {
              Text(item.label)
                .fontSize(FONT.body)
                .lineHeight(LINE_HEIGHT.body)
                .fontColor($r('app.color.text_primary'))
                .layoutWeight(1)
                .textAlign(TextAlign.Start)
              Text(item.id === this.aiProviderId ? '✓' : '')
                .fontSize(FONT.caption)
                .fontColor($r('app.color.brand'))
            }
            .width('100%')
            .height(SHEET_ROW)
            .alignItems(VerticalAlign.Center)
            .onClick(() => {
              this.pickProvider(item.id);
            })
          },
          (item: AiProviderPreset) => item.id
        )
      } else {
        ForEach(
          modelsOf(this.aiProviderId),
          (item: AiModelOption) => {
            Row({ space: SPACING.sm }) {
              Text(item.label)
                .fontSize(FONT.body)
                .lineHeight(LINE_HEIGHT.body)
                .fontColor($r('app.color.text_primary'))
                .layoutWeight(1)
                .textAlign(TextAlign.Start)
              Text(item.id === this.aiModel ? '✓' : '')
                .fontSize(FONT.caption)
                .fontColor($r('app.color.brand'))
            }
            .width('100%')
            .height(SHEET_ROW)
            .alignItems(VerticalAlign.Center)
            .onClick(() => {
              this.pickModel(item.id);
            })
          },
          (item: AiModelOption) => item.id
        )
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  SheetBody() {
    Column() {
      if (this.panel === PANEL_SYNC_MORE) {
        this.SyncMoreSheet()
      } else if (this.panel === PANEL_PROVIDER || this.panel === PANEL_MODEL) {
        this.PickerSheet()
      } else {
        this.HelpSheet()
      }
    }
    .width('100%')
    .padding(SPACING.lg)
    .backgroundColor($r('app.color.surface'))
    .borderRadius({ topLeft: RADIUS.md, topRight: RADIUS.md })
  }

  build() {
    Stack({ alignContent: Alignment.Center }) {
      PageLayout({
        title: '设置',
        subtitle: this.saveHint.length > 0 ? this.saveHint : '同步 / AI / 远程 / 数据 / 关于',
        onBack: () => {
          router.back();
        },
        onBreakpointChange: (breakpoint: string, widthVp: number) => {
          this.breakpoint = breakpoint;
          this.contentWidth = widthVp;
        }
      }) {
        if (this.breakpoint === 'compact') {
          this.CompactBody()
        } else {
          this.WideBody()
        }
      }

      if (this.panel !== PANEL_NONE) {
        Column()
          .width('100%')
          .height('100%')
          .backgroundColor($r('app.color.scrim'))
          .onClick(() => {
            this.panel = PANEL_NONE;
          })
        Column() {
          Blank()
          this.SheetBody()
        }
        .width('100%')
        .height('100%')
      }
    }
    .width('100%')
    .height('100%')
  }
}
