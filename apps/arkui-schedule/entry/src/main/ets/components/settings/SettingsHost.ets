/**
 * 设置子页共用的实现宿主（API 子页复用）：全部 `@State` 与保存 / 同步业务方法，长说明收进 `?` 弹层。
 * （同步组因为「分支 / 推送 / 状态」三项新需求变长，次要项继续收在组头「更多」里。）
 *
 * 「仅手写笔输入」的入口在**手写板 → 笔迹面板**（`pages/harmony/Handwriting.ets`），
 * 本页不再重复提供该开关；`settingsStore.penOnlyInput` 键仍保留（笔迹面板读写它），
 * 本页保存时**不传**该字段（不传＝不改，见 `settingsStore.save` 的 patch 语义）。
 *
 *
 * AI 组内的「多源 fallback」（`docs/AI-FALLBACK.md` §8）排在「高级」折叠区之前：开关 +
 * 最多 3 个备用源 + 尝试次数 + 本次会话的诊断；三个持久化键由 `applySettings` / `saveSettings`
 * 读写，诊断只留在内存（不落盘、不进同步载荷）。
 *
 * 本页仍做四件事（逻辑未改）：内嵌隐藏 Web 跑 isomorphic-git、注册代理、按钮触发
 * pull/push/status、保存前做表单校验。
 *
 * 远程控制组（mod-settings-remote-dedupe）：设置页**只保留一行入口**打开 `pages/Instances`。
 * 方式选择、地址、令牌、最近成功等字段全部收敛到实例页（`instanceStore`），本页不再重复配置。
 * 旧 `settingsStore.remote*` 键值仍可读，启动时由 `Instances.bootstrap()` 幂等迁移进实例表。
 *
 * 同步组（mod-settings-lean → mod-settings-sync-min：设置只留仓库地址 + 令牌）：
 * - **主表单只留两个控件**：仓库地址 / 访问令牌，地址下固定一行
 *   「平台按地址自动识别 · 分支固定 main」；平台随地址自动推断、分支恒为 main，
 *   没有平台/分支选择控件；
 * - Git 用户名 / 设备标识 / 作者名的输入控件与折叠区**整条删除**：它们都有安全默认值
 *   （用户名按仓库地址推断、编号由仓库自动分配、作者名默认「我」），全部由软件静默安排。
 *   旧值仍可读于 settingsStore（不迁移、不清空），只是不再上屏、不再成为同步的前置门槛；
 * - 「立即同步」（= pull）与「推送」是组内两个主按钮，查看状态 / 重试上次 / 测试连接
 *   在组头「更多」里；
 * - 同步状态（分支 / 领先 / 落后 / 冲突 / 本地改动）与最近一次同步时间+成败都在本页展示；
 * - **SSH 在本版本不可用**（内置内核只有 HTTP(S) 传输）：已保存的是 SSH 时主表单给一行
 *   只读警告，同步按钮照旧拦住，不提供切换控件、不做「看起来支持」的假入口。
 *
 * 设备标识重复（两台设备同一个 id）由 `model/deviceIdentity.ts` + `GitSyncService` 的指纹比对
 * 识别：冲突时本页显示**常驻** warning（不是 toast），同步结果带 `identityConflict: true`。
 *
 * AI 组接 `model/aiProvider.ts`：服务=预设源表，模型随服务联动；`save()` 内部已做
 * `resolveModel` / `aiBaseURLFor` 归一，因此本页**只传原始值**，不重复归一化。
 *
 * token / AI key 只存本机 preferences，不进同步载荷与日志；本页不打印它们。
 *
 * **A2 拆分 / mod-settings-sync-page / mod-settings-export-page（纯重构，行为不变）**：
 * 功能组的界面从本页搬到 `components/settings/{AiSection,AboutSection}.ets`；同步正文迁到
 * `pages/SettingsSync`，数据正文迁到 `pages/SettingsExportImport`（两者都是自带真页面 +
 * presentational body）。本页仍是 API 子页共用的状态持有者（保存链所需的 `@State` 与方法），
 * 并负责装配 `AiGroup()` / `RemoteGroup()` / `AboutGroup()`；组件只收单向 props + 回调。
 * 共用字段构件仍在 `components/settings/SettingsBits.ets`。
 */
import { promptAction, router } from '@kit.ArkUI';
import { webview } from '@kit.ArkWeb';
import { common } from '@kit.AbilityKit';
import { http } from '@kit.NetworkKit';
import { util } from '@kit.ArkTS';
import { nowIso } from '../../common/date';
import { getFeatures } from '../../common/features';
import { isHarmonyOS } from '../../common/platform';
import { normalizeDeviceId, settingsStore } from '../../services/settingsStore';
import type { ScheduleSettings, SettingsPatch, SyncStatePatch } from '../../services/settingsStore';
import { describeError, scheduleStore } from '../../services/scheduleStore';
import { GitSyncService } from '../../services/GitSyncService';
import type { GitSyncConfig, GitSyncResult } from '../../services/GitSyncService';
import { describeRepoProbe, repoProbeUrl, validateRepoUrl } from '../../model/repoUrl';
import type { RepoUrlCheck } from '../../model/repoUrl';
import type {
  RemoteAccessConfig,
  RemoteAccessUrlResult,
  RemoteModeField,
  RemoteModeSpec
} from '../../model/remoteAccess';
import {
  AUTH_HTTPS,
  FIELD_AI_BASE_URL,
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
} from '../../model/settingsForm';
import type { SettingsFieldIssue } from '../../model/settingsForm';
import {
  canRetrySync,
  classifySyncError,
  describePushReadiness,
  normalizeSyncAction,
  syncActionLabel,
  DEFAULT_BRANCH
} from '../../model/syncError';
import type { SyncErrorInfo, SyncStatusView } from '../../model/syncError';
import { testAiConnection } from '../../services/deepseek';
import type { AiTestResult } from '../../services/deepseek';
import {
  AI_PROVIDERS,
  CUSTOM_PROVIDER_ID,
  DEFAULT_PROVIDER_ID,
  defaultModelOf,
  findProvider,
  hintForProvider,
  modelsOf
} from '../../model/aiProvider';
import type { AiModelOption, AiProviderPreset } from '../../model/aiProvider';
import {
  GITEE_PLATFORM,
  PLATFORM_GITHUB,
  SSH_UNSUPPORTED_SHORT,
  authHintFor,
  describeAuthModeBlocker,
  isSshAuthMode,
  repoUrlExamplesFor,
  resolveGitUsername,
  resolvePlatformSelection,
  httpsUsernameFor
} from '../../model/gitAuth';
import type { PlatformResolution } from '../../model/gitAuth';
import { gitExtrasStore } from '../../services/syncController';
import type { GitSyncExtras } from '../../services/syncController';
import { PageLayout } from '../PageLayout';
// A2 拆分：其余 section 组件（页面只做装配；共享字段构件在 SettingsBits）。
// 同步 / 数据正文已各自迁到 pages/SettingsSync / pages/SettingsExportImport，本宿主不再装配。
import { AiSection } from './AiSection';
import { AboutSection } from './AboutSection';
import { FieldLabel as FieldLabelBit, HintLine as HintLineBit } from './SettingsBits';
import {
  DEFAULT_MAX_ATTEMPTS,
  MAX_FALLBACK_SOURCES,
  normalizeMaxAttempts,
  parseFallbackOrder,
  serializeFallbackOrder,
  sourceLabel
} from '../../model/aiFallback';
import type { FallbackDiagnostic, FallbackSource, FallbackSourcePatch } from '../../model/aiFallback';
import { DIVIDER, FONT, LINE_HEIGHT, RADIUS, SPACING, TOUCH_MIN } from '../../common/uiTokens';
import { applyThemeMode, isSystemDark } from '../../common/themeApply';
import { normalizeThemeMode, resolveTheme, themeModeHint, themeModeLabel } from '../../model/theme';

/** 仓库探测超时（毫秒）：探测只看域名通不通，不需要长超时。 */
const PROBE_TIMEOUT_MS: number = 10000;

/** 底部弹层的单行高度。 */
const SHEET_ROW: number = 48;

/** 锚点还没测到位置时的提示（点了不能静默，见 docs/STATE-UI.md §3）。 */
const ANCHOR_NOT_READY: string = '页面还在排版，稍后再点一次';

/**
 * 本页会话内最多保留几条 fallback 诊断。
 *
 * 诊断只用于「刚才那次为什么失败」的即时排查，不落盘、不跨页面；留 10 条足够覆盖
 * 「主源 + 3 个备用源」的两轮尝试，再多就只是在设置页里堆噪音。
 */
const MAX_SESSION_DIAGNOSTICS: number = 10;

/**
 * mod-settings-root：设置根页四行菜单各自 push 的子页，本页面是它们共用的实现宿主。
 * 旧 `CompactBody` / `WideBody` 及其组锚点 builder 原样保留（历史静态守卫的锚点），
 * 但子页只渲染自己那一段 section —— 根页不渲染任何 section body。
 */
const SECTION_API: string = 'api';
const SECTION_ABOUT: string = 'about';

/** 弹层标识：同一时刻只开一个。 */
const PANEL_NONE: string = '';
const PANEL_SYNC_MORE: string = 'syncMore';
const PANEL_PROVIDER: string = 'provider';
const PANEL_MODEL: string = 'model';
const PANEL_PRIVACY: string = 'privacy';
const PANEL_REPO: string = 'repo';

@Component
export struct SettingsHost {
  /**
   * 子页标识（`SECTION_*`）：决定本页面渲染哪一段 section，子页之间共用同一套状态与方法。
   * mod-settings-sync-page：同步子页已有自己的真页面，不再向本宿主传 section；
   * 默认值留空串（不渲染任何 section），三个调用方都显式传 section。
   */
  @Prop section: string = '';
  /** 页面标题（由薄壳传入，与各自 `main_pages.json` 路由一一对应）。 */
  @Prop pageTitle: string = '';

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
  /** 托管平台：`github` / `gitee` / `gitlab` / `custom`（按仓库地址自动推断，只影响文案与示例）。 */
  @State gitPlatform: string = PLATFORM_GITHUB;
  /** 已保存过的平台锁定标记（本页没有手动选择器；旧数据里的 platformTouched 会在 applyExtras() 里被重置为 false（平台一律按地址重新推断））。 */
  @State platformTouched: boolean = false;
  /** 认证方式：`https` / `ssh`（已保存的 SSH 只显示只读警告，同步仍被拦）。 */
  @State authMode: string = AUTH_HTTPS;
  @State ready: boolean = false;
  @State saveHint: string = '';
  /** 保存校验的问题汇总（「还有 N 项需要处理：…」，空串 = 无问题）。 */
  @State issuesSummary: string = '';
  /** 第一条问题的「字段名 · 原因」：横幅第二行，用户不滚动也能看懂要改什么。 */
  @State firstIssueText: string = '';
  /** AI 接口地址的内联错误（自定义源专用）。 */
  @State aiBaseUrlError: string = '';
  /**
   * Git 用户名（仅 HTTPS 认证用）：**无输入控件**，由 `ensureGiteeUsernameResolved()` 按仓库地址静默推断；
   * 旧值从 settingsStore 读出后原样保留（不迁移、不清空），只是不再上屏。
   */
  @State gitUsername: string = '';
  // 表单校验提示：mod-settings-sync-page 后仓库地址 / 令牌的红字归 pages/SettingsSync，
  // 本宿主只剩 AI 接口地址一处（其余子页不编辑那两个字段）。
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
  // mod-settings-sync-page：identityWarning / attachmentWarning 随同步正文迁到 pages/SettingsSync。
  @State webReady: boolean = false;
  @State platformText: string = '';
  @State handwritingText: string = '';
  @State ocrText: string = '';
  @State storageHint: string = '';
  // UI 状态：mod-settings-root 后子页只有一层 Scroll、没有断点骨架分支，
  // 原 `breakpoint` / `contentWidth` 两个半断点字段随旧 build() 一起删除（无消费者、不留死状态）。
  /** 当前打开的弹层（`PANEL_*`）。 */
  @State panel: string = PANEL_NONE;
  /** 本机设备编号是否由仓库自动分配（true = 仓库分配；存量非自动值仍可读、不改）。 */
  @State deviceIdAuto: boolean = false;
  // mod-settings-sync-page：首页「含其他设备」开关随同步正文迁到 pages/SettingsSync。

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
  // 远程控制字段已收敛到 pages/Instances（mod-settings-remote-dedupe）；本页只保留入口行。

  /** 从列表页跳转过来时要自动执行的同步动作（pull / push / status）。 */
  private autoAction: string = '';
  private gitController: webview.WebviewController = new webview.WebviewController();
  private sync: GitSyncService = new GitSyncService(this.gitController);
  private disposed: boolean = false;
  /** 已保存的 token：输入框留空时沿用（用户「不改 token」不该被拦）。 */
  private savedToken: string = '';
  /** 最近一次同步状态结果（只在页面内部用于派生「推送是否就绪」的说明行）。 */
  private lastStatusResult: GitSyncResult | null = null;
  /** 页面主滚动容器：校验失败时滚回顶部，让红色汇总与第一个错误字段进入视野。 */
  private pageScroller: Scroller = new Scroller();
  /**
   * 紧凑屏各组在滚动内容里的 y 偏移（vp；-1 = 还没测到）。
   * 刻意**不是** @State：它只在点击时读一次、不参与渲染；ArkUI V1 对「数组下标赋值」不触发刷新，
   * 若写成 @State 反而会给人「已经会刷新」的错觉。
   */
  private groupOffsets: number[] = [-1, -1, -1, -1, -1];

  aboutToAppear(): void {
    this.platformText = isHarmonyOS() ? 'HarmonyOS' : 'Android';
    const features = getFeatures();
    this.handwritingText = features.handwriting ? '手写可用' : '手写不可用';
    this.ocrText = features.ocr ? 'OCR 可用' : 'OCR 不可用';
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
      // 日程目录的读门槛在这里初始化（保存链需要设备根路径）。
      if (this.disposed) {
        return;
      }
      this.ready = true;
      this.storageHint = `日程目录：${scheduleStore.deviceRoot()}/schedules/`;
      // 主表单没有用户名字段：进页面就按仓库地址推断一次（Gitee = owner），推不出来会展开「高级」
      this.ensureGiteeUsernameResolved();
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
    // 作者名默认「我」：输入控件删掉后默认值必须在这里兜住（mod-settings-sync-min），
    // 存量非空作者名原样保留，只是不再上屏。
    this.author = settings.author.trim().length > 0 ? settings.author : '我';
    this.deviceIdAuto = settings.deviceIdAuto;
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
    // 远程配置不在设置页铺表单：旧值仍留在 settingsStore，由实例页 bootstrap() 幂等迁移。
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
   * 把扩展设置（平台 / 平台锁定标记）铺到表单上。
   *
   * 平台以扩展设置为准（它能表达 gitlab/custom）；扩展设置为空时回落到 settingsStore 的
   * github/gitee，保证老数据不受影响。旧的 platformTouched 锁定标记在加载时退役：本页没有
   * 选平台的控件，平台一律按仓库地址重新推断，不再让历史锁定值永久生效。
   * 分支固定 `main`；旧 extras 里的 branch 会被忽略并在下次保存时写成 main。
   */
  private applyExtras(extras: GitSyncExtras): void {
    // 旧的 platformTouched=true 会让 resolvePlatformSelection 永远返回历史平台，而本页没有清除入口，
    // 故加载时统一退役（mod-settings-lean F2），平台重新由地址推断。
    this.platformTouched = false;
    if (extras.platform.length > 0) {
      this.gitPlatform = extras.platform;
    }
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
      // 分支固定 main（mod-settings-lean）：本页没有分支输入，内核始终收到 DEFAULT_BRANCH
      branch: DEFAULT_BRANCH,
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
    this.aiBaseUrlError = '';
    const applied: SettingsFieldIssue[] = [];
    for (const issue of issues) {
      if (issue.field === FIELD_AI_BASE_URL) {
        // 接口地址行在自定义源下常驻显示，红字直接落在它下方
        this.aiBaseUrlError = issue.message;
      } else if (issue.field === FIELD_REPO_URL || issue.field === FIELD_TOKEN) {
        // mod-settings-sync-page：仓库地址 / 令牌的红字归 pages/SettingsSync，本宿主不渲染它们。
        continue;
      } else {
        // 设备标识 / 作者名 / 用户名已无输入控件（mod-settings-sync-min）：
        // 页面在校验入口传的就是「已归一 / 已兜底」的静默值，这三类 issue 不可达；
        // 万一模型侧新增了无落点的字段，宁可不计入横幅，也不制造「说有 N 项却看不到红字」的幽灵报错。
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
    // 平台按仓库地址自动推断（applyExtras() 已把旧锁定标记重置为 false，这里一律按地址推断）——保存前算出最终值
    const platformResolution: PlatformResolution = resolvePlatformSelection(
      this.repoUrl,
      this.gitPlatform,
      this.platformTouched
    );
    const platform: string = platformResolution.platform;
    // 整表校验交给纯函数：一次返回**全部**问题，页面逐字段标红 + 顶部汇总
    // 设备标识 / 作者名已无输入控件：传「已归一 / 已兜底」的静默值，保证这两类 issue 不可达，
    // 也就不存在「横幅说有 N 项、界面却没有红字」的幽灵报错（旧值仍在 store，只是不上屏）。
    const silentAuthor: string = this.author.trim().length > 0 ? this.author.trim() : '我';
    const issues: SettingsFieldIssue[] = checkSettingsFields(
      {
        deviceId: normalizeDeviceId(this.deviceId),
        author: silentAuthor,
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
    // 用户名无输入控件：保存前按仓库地址静默推断（Gitee = owner），推不出来也不打断用户。
    this.ensureGiteeUsernameResolved();
    this.applyIssues(issues);
    // 无可见落点的 issue 不拦保存（Settings 属凭据敏感文件，禁止 console/hilog，故这里静默跳过）。
    const blocking: boolean = this.issuesSummary.length > 0;
    if (blocking) {
      this.saveHint = this.issuesSummary;
      // 滚回顶部：红色汇总 + 第一个错误字段（设备标识/作者名/token/仓库地址都在同步组）
      this.pageScroller.scrollEdge(Edge.Top);
      return;
    }
    const context = getContext(this) as common.UIAbilityContext;
    try {
      const patch: SettingsPatch = {
        deviceId: normalizeDeviceId(this.deviceId),
        // 编号来源（自动分配 / 沿用存量标识）：无手改入口，保持读到的原值
        deviceIdAuto: this.deviceIdAuto,
        // 保留用户输入的地址原文，只去掉首尾空白（末尾 .git 不擅自增删）；空地址存空串
        repoUrl: repoEmpty ? '' : repoCheck.url,
        // 输入框留空 = 沿用已保存的 token（不要把旧 token 清空）
        token: effectiveToken(this.token, this.savedToken),
        aiKey: this.aiKey,
        aiProviderId: this.aiProviderId,
        aiModel: this.aiModel,
        aiBaseURL: this.aiBaseURL,
        author: silentAuthor,
        // settingsStore 只认 github/gitee（它的 normalizePlatform 会把 gitlab/custom 折成 github），
        // 真正的四值平台存在 gitExtrasStore 里，这里写回一个它认识的等价物即可。
        gitPlatform: platform === GITEE_PLATFORM ? GITEE_PLATFORM : PLATFORM_GITHUB,
        authMode: this.authMode,
        // HTTPS 用户名（Gitee 必填登录名；GitHub 留空由同步层回落 x-access-token）
        gitUsername: this.gitUsername.trim(),
        // 远程字段不再随本页整表保存：配置入口已迁到 pages/Instances（旧键值仍原样留在 store）。
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
      // 分支固定写入 DEFAULT_BRANCH（保留旧键，不改存储结构）；平台（四值）+ 锁定标记照旧落盘
      const extras: GitSyncExtras = await gitExtrasStore.save(
        {
          branch: DEFAULT_BRANCH,
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
      this.issuesSummary = '';
      scheduleStore.setDeviceId(saved.deviceId);
      this.storageHint = `日程目录：${scheduleStore.deviceRoot()}/schedules/`;
      this.configure();
      let hint: string = `设置已保存（${nowIso()}）`;
      if (repoEmpty) {
        hint = `设置已保存（${nowIso()}）；仓库地址为空，同步前需要先填写`;
      } else if (isSshAuthMode(this.authMode)) {
        hint = `设置已保存（${nowIso()}）；${SSH_UNSUPPORTED_SHORT}，请点「改用 HTTPS 令牌」后再同步`;
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

  /** 当前认证方式的阻塞原因（空串 = 可同步）；页面据此禁用按钮并说明原因。 */
  private authBlocker(): string {
    return describeAuthModeBlocker(this.authMode);
  }

  /**
   * SSH 警告行的显式出口（mod-settings-lean F1）：只切本地状态 + 短提示，不自动保存。
   *
   * `@Prop authMode` 是单向的：必须改页面的 `@State`，子节点才会重绘，`configure()` /
   * `saveSettings()` 也才会拿到新值（下一步由用户点「保存设置」落盘）。顺手清掉上次被 SSH
   * 拦下时写下的 ❌ 红字，避免切换后界面上还挂着过时的说明。
   */
  private switchToHttpsToken(): void {
    this.authMode = AUTH_HTTPS;
    if (this.syncMessage.startsWith('❌')) {
      this.syncMessage = '';
    }
    promptAction.showToast({ message: '已切换为 HTTPS + 令牌，保存后生效' });
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

  /** 切换服务：模型不在新源表里就回落到该源默认（模型只能通过下拉选，没有手输路径）。 */
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

  /**
   * Git 用户名：**没有输入控件**，完全静默派生（mod-settings-sync-min）。
   *
   * 非空存量值原样保留（不迁移、不清空）；为空时按仓库地址推断（Gitee = owner，GitHub 由同步层
   * 回落 x-access-token）。推不出来也不打断用户——同步失败会由诚实状态行给出原因与重试路径。
   */
  private ensureGiteeUsernameResolved(): void {
    if (this.gitUsername.trim().length > 0) {
      return;
    }
    const inferred: string = httpsUsernameFor(this.gitPlatform, this.repoUrl, '');
    if (inferred.length > 0) {
      this.gitUsername = inferred;
    }
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
    } catch (error) {
      // 状态刷新失败不影响主流程（同步结果已经展示在 syncMessage 里）
    }
  }

  // mod-settings-sync-page：设备身份 / 附件暂停的常驻 warning 与「查看状态」结果行
  // 随同步正文与诚实状态行迁到 pages/SettingsSync；本宿主只保留设备编号回填（保存链需要）。

  /** 把同步结果里的设备编号回填到保存链（同步服务登记成功后带回）。 */
  private applySyncFlags(result: GitSyncResult): void {
    const claimedId: string = result.deviceId === undefined ? '' : result.deviceId.trim();
    if (claimedId.length > 0) {
      this.deviceId = claimedId;
      this.deviceIdAuto = result.deviceIdAuto === true;
      this.configure();
      this.storageHint = `日程目录：${scheduleStore.deviceRoot()}/schedules/`;
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

  /**
   * 「能不能推」的一行说明（`describePushReadiness` 的纯逻辑结果）。
   *
   * A2 拆分后由页面派生；mod-settings-sync-page 后这段派生与 `statusView()` 一并位于
   * `pages/SettingsSync`，本宿主保留同名方法只为其它设置子页的保存链共用状态视图口径。
   */
  private statusReadiness(): string {
    return describePushReadiness(this.statusView());
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
    // A 批（`docs/STATE-UI.md` §4.1）：LoadingState 的「取消」只停**等待**。
    // 后台的 Git 调用可能仍在收尾，所以这里只复位忙态并如实说「已停止等待」——
    // 绝不敢写「已取消 / 已成功」（那是假反馈），真正的结果稍后靠「查看状态」确认。
    if (action === 'cancel-wait') {
      this.syncBusy = false;
      this.syncMessage = '已停止等待：后台可能仍在执行，稍后点「查看状态」确认结果';
      return;
    }
    if (!this.webReady) {
      this.syncMessage = '同步内核尚未就绪，请稍候再试（隐藏 Web 环境仍在加载）';
      return;
    }
    const repoCheck: RepoUrlCheck = validateRepoUrl(this.repoUrl);
    if (!repoCheck.ok) {
      this.syncMessage = `请先修正仓库地址：${repoCheck.error}`;
      return;
    }
    if (repoCheck.scheme !== 'https' && repoCheck.scheme !== 'http') {
      // 同步内核（isomorphic-git + 桥）只实现 HTTPS，SSH 地址会直接失败，这里先拦住
      this.syncMessage = `${SSH_UNSUPPORTED_SHORT}：请把仓库地址改成 https:// 并点「改用 HTTPS 令牌」`;
      return;
    }
    // A1：SSH 认证方式在本版本没有传输层，直接拦住并写清原因（不发起任何请求）
    const authBlocker: string = this.authBlocker();
    if (authBlocker.length > 0) {
      this.syncMessage = `❌ ${authBlocker}`;
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
      // 设备身份 / 附件暂停：落到常驻警告（失败结果也可能带着「附件被暂停推送」的说明）
      this.applySyncFlags(result);
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

  // ------------------------------------------------------------------ 通用 Builder

  /** 字段标题：转发 `SettingsBits` 的共享实现（弹层里也要用它）。 */
  @Builder
  FieldLabel(text: string) {
    FieldLabelBit(text)
  }

  /** 一行说明（单行省略）：转发 `SettingsBits` 的共享实现（弹层里也要用它）。 */
  @Builder
  HintLine(text: string) {
    HintLineBit(text)
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

  /**
   * `Area.position.y` 的 Length → vp 数字（口径与 `components/PageLayout.ets` 的 toVp 一致）。
   * 无法换算时返回 **-1**（而不是 0）：0 是合法的内容偏移（例如某组正好是内容第一个元素），
   * 用 0 当「未测量」哨兵会把「测不到」误当成「在顶部」，跳转会落错位置。
   */
  private lengthToVp(value: Length | undefined): number {
    if (typeof value === 'number') {
      return Number.isFinite(value) && value >= 0 ? value : -1;
    }
    if (typeof value === 'string') {
      const parsed: number = Number(value);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : -1;
    }
    return -1;
  }

  /**
   * 记录第 index 组在滚动内容里的 y 偏移（同一 Column 内的相对位置 = 内容偏移，滚动时不变）。
   * 等值不重写、越界/无法换算（-1）忽略；`IssuesBanner` 出现/消失导致整体位移时会再次触发。
   */
  private measureGroup(index: number, area: Area): void {
    if (index < 0 || index >= this.groupOffsets.length) {
      return;
    }
    const y: number = this.lengthToVp(area.position.y);
    if (y < 0 || this.groupOffsets[index] === y) {
      return;
    }
    this.groupOffsets[index] = y;
  }

  /** 真跳转：用页面已有的 pageScroller 滚到该组；还没测到位置就 toast 原因（不静默、不假跳）。 */
  private jumpToGroup(index: number): void {
    if (index < 0 || index >= this.groupOffsets.length) {
      return;
    }
    const offset: number = this.groupOffsets[index];
    if (offset < 0) {
      promptAction.showToast({ message: ANCHOR_NOT_READY });
      return;
    }
    this.pageScroller.scrollTo({ xOffset: 0, yOffset: offset, animation: { duration: 250 } });
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
   * 「远程实例与云端对话」入口（**只放一行入口**，列表在独立页面）。
   *
   * 设计稿 `docs/REMOTE-INSTANCES.md` §1 定的唯一入口：把原来的「云端对话（只读 ›）」
   * 升级为本行，跳新建的顶层 `pages/Instances`（本机 + 远程实例列表）。
   * 实例/会话是要反复来读的内容，不塞进「改配置」的设置页分组里；保留 `ChatEntryRow`
   * 这个 builder 名与紧凑屏 / 宽屏两处裸调用，B2 的组锚点契约不受影响。
   */
  @Builder
  ChatEntryRow() {
    Row({ space: SPACING.sm }) {
      Text('远程实例与云端对话')
        .fontSize(FONT.body)
        .lineHeight(LINE_HEIGHT.body)
        .fontColor($r('app.color.text_primary'))
        .layoutWeight(1)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .textAlign(TextAlign.Start)
      Text('›')
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontColor($r('app.color.text_secondary'))
        .flexShrink(0)
        .maxLines(1)
        .textAlign(TextAlign.Center)
    }
    .width('100%')
    .height(TOUCH_MIN)
    .alignItems(VerticalAlign.Center)
    .onClick(() => {
      this.openInstances();
    })
  }

  /** 打开实例列表页（失败只 toast，不影响设置页任何状态）。 */
  private openInstances(): void {
    router.pushUrl({ url: 'pages/Instances' }).catch((error: Error) => {
      promptAction.showToast({ message: `打开实例列表失败：${describeError(error)}` });
    });
  }

  /** 子页唯一主操作：保存（mod-settings-root：原「保存设置」按新设计收敛为「保存」）。 */
  @Builder
  SaveButton() {
    Button('保存')
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

  /** 一个组锚点（等宽 1/5，命中区 TOUCH_MIN）：点一下真滚到对应组。 */
  @Builder
  GroupAnchorChip(label: string, index: number) {
    Button(label)
      .fontSize(FONT.caption)
      .fontColor($r('app.color.brand'))
      .backgroundColor($r('app.color.control_fill'))
      .height(TOUCH_MIN)
      .borderRadius(RADIUS.sm)
      .padding({ left: 0, right: 0 })
      .layoutWeight(1)
      .onClick(() => {
        this.jumpToGroup(index);
      })
  }

  /**
   * 紧凑屏组锚点行：同步 / AI / 远程 / 数据 / 关于（顺序 = 组顺序）。
   *
   * 位置：`Scroll` 内容的最上面、`IssuesBanner` 与第一个组头之前 —— 随内容一起滚走，
   * **不悬浮**，因此不会遮住首屏表单；进页面时就在视野内，点一下直达目标组。
   *
   * 为什么不用 `ActionButton`：它的左右内边距是 `SPACING.lg`，5 个塞进 360vp 宽会溢出/裁字；
   * 锚点也没有「禁用」语义（未测量时点击会 toast 原因），因此用原生 `Button` + 令牌尺寸。
   * 宽屏两列已短，不做锚点（见 docs/UX-STEPS.md §4.2）。
   */
  @Builder
  GroupAnchorBar() {
    Row({ space: SPACING.sm }) {
      this.GroupAnchorChip('同步', 0)
      this.GroupAnchorChip('AI', 1)
      this.GroupAnchorChip('远程', 2)
      this.GroupAnchorChip('数据', 3)
      this.GroupAnchorChip('关于', 4)
    }
    .width('100%')
    .alignItems(VerticalAlign.Center)
  }

  // ------------------------------------------------------------------ 装配（A2 拆分）

  /**
   * 四个 section 组件（`components/settings/*.ets`）的装配点。
   *
   * 分工：**页面持有全部 `@State` 与业务方法**（保存 / 同步 / 导出 / 远程控制 / 主题切换），
   * 组件只收单向 props + 回调（`@Prop` 值 + `onXxx`）。因此：
   * - 刷新语义不变（父页面值变了才重绘组件）；
   * - 回调闭包始终读页面最新状态（`authBlocker()` 之类的只读派生以函数 props 传入）；
   * - 输入框仍是「受控」的：组件把输入回传给页面，页面写 `@State`，值再经 `@Prop` 铺回去。
   *
   * 紧凑屏与宽屏两套骨架都调用下面这五个 builder（组顺序与拆分前逐字一致）。
   */
  // mod-settings-sync-page：SyncGroup 与 SyncSection 装配已迁出本宿主，
  // 正文、状态与保存都在 pages/SettingsSync；CompactBody / WideBody 仅作历史守卫锚点保留。

  @Builder
  AiGroup() {
    AiSection({
      aiKey: this.aiKey,
      aiProviderId: this.aiProviderId,
      aiBaseURL: this.aiBaseURL,
      aiBaseUrlError: this.aiBaseUrlError,
      aiTestText: this.aiTestText,
      aiTestHint: this.aiTestHint,
      aiTestBusy: this.aiTestBusy,
      providerLabel: this.provider().label,
      providerKeyHint: this.provider().keyHint,
      modelLabel: this.modelLabel(),
      customProvider: this.isCustomProvider(),
      primarySourceLabel: this.primarySourceLabel(),
      fallbackEnabled: this.aiFallbackEnabled,
      sources: this.aiFallbackSources,
      maxAttempts: this.aiFallbackMaxAttempts,
      diagnostics: this.aiFallbackDiagnostics,
      onOpenProviderPanel: (): void => {
        this.panel = PANEL_PROVIDER;
      },
      onOpenModelPanel: (): void => {
        this.panel = PANEL_MODEL;
      },
      onChangeAiKey: (value: string): void => {
        this.aiKey = value;
      },
      onTestAi: (): void => {
        this.testAi();
      },
      onChangeAiBaseURL: (value: string): void => {
        this.aiBaseURL = value;
        this.aiBaseUrlError = '';
      },
      onToggleFallback: (isOn: boolean): void => {
        this.aiFallbackEnabled = isOn;
      },
      onAddFallback: (): void => {
        this.addFallbackSource();
      },
      onRemoveFallback: (index: number): void => {
        this.removeFallbackSource(index);
      },
      onMoveFallback: (index: number, offset: number): void => {
        this.moveFallbackSource(index, offset);
      },
      onChangeFallback: (index: number, patch: FallbackSourcePatch): void => {
        this.patchFallbackSource(index, patch);
      },
      onMaxAttempts: (value: number): void => {
        this.aiFallbackMaxAttempts = value;
      }
    })
  }

  /**
   * 远程控制组现在只有一行入口：打开 `pages/Instances`（本机 + 远程实例表）。
   * 原方式下拉 / 地址 / 令牌 / 提示行全部删除，配置只在实例页发生——避免两处漂移。
   */
  @Builder
  RemoteGroup() {
    this.ChatEntryRow()
  }

  @Builder
  AboutGroup() {
    AboutSection({
      lastSyncAt: this.lastSyncAt,
      lastSyncError: this.lastSyncError,
      lastSyncAction: this.lastSyncAction,
      platformLine: this.platformLine(),
      storageHint: this.storageHint,
      themeMode: this.themeMode,
      themeModeHintText: (): string => this.themeModeHintText(),
      onPickTheme: (mode: string): void => {
        this.saveThemeMode(mode);
      },
      onOpenPrivacy: (): void => {
        this.panel = PANEL_PRIVACY;
      }
    })
  }

  /** 紧凑屏：五组自上而下；滚动内容顶部一行组锚点（随内容滚走，非悬浮）直达目标组。 */
  @Builder
  CompactBody() {
    Column({ space: SPACING.md }) {
      Scroll(this.pageScroller) {
        Column({ space: SPACING.xl }) {
          this.GroupAnchorBar()
          this.IssuesBanner()
          Divider()
            .strokeWidth(DIVIDER)
            .color($r('app.color.divider'))
          Column() { this.AiGroup() }
            .width('100%')
            .alignItems(HorizontalAlign.Start)
            .onAreaChange((_oldValue: Area, newValue: Area) => { this.measureGroup(1, newValue); })
          Divider()
            .strokeWidth(DIVIDER)
            .color($r('app.color.divider'))
          Column() { this.RemoteGroup() }
            .width('100%')
            .alignItems(HorizontalAlign.Start)
            .onAreaChange((_oldValue: Area, newValue: Area) => { this.measureGroup(2, newValue); })
          Divider()
            .strokeWidth(DIVIDER)
            .color($r('app.color.divider'))
          Column() { this.AboutGroup() }
            .width('100%')
            .alignItems(HorizontalAlign.Start)
            .onAreaChange((_oldValue: Area, newValue: Area) => { this.measureGroup(4, newValue); })
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

  /** 宽屏/横屏：左（远程控制 + 数据 + 关于）/ 右（AI），底部统一保存（仅作历史守卫锚点）。 */
  @Builder
  WideBody() {
    Column({ space: SPACING.md }) {
      Scroll(this.pageScroller) {
        Column({ space: SPACING.md }) {
          this.IssuesBanner()
          Row({ space: SPACING.xl }) {
            Column({ space: SPACING.xl }) {
              this.RemoteGroup()
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

  /** 同步组「更多」：查看状态 / 重试 / 测试连接（Git 操作自动完成，无手动推送入口）。 */
  @Builder
  SyncMoreSheet() {
    Column({ space: SPACING.md }) {
      this.SheetHeader('同步（Git）更多操作')

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
            Text('仓库地址可以先留空（只在本机记录日程）；留空时保存不报错，但同步与测试连接前必须先填写。')
              .fontSize(FONT.caption)
              .lineHeight(LINE_HEIGHT.caption)
              .fontColor($r('app.color.text_secondary'))
              .width('100%')
            Text(`平台按仓库地址自动识别；分支固定 ${DEFAULT_BRANCH}（首次推送时远端没有会自动创建）。`)
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

  /**
   * mod-settings-root / mod-settings-export-page：本宿主只渲染仍复用它的子页（API）那一段
   * section —— 一层 Scroll + 一个主操作。同步正文在 pages/SettingsSync，数据正文在
   * pages/SettingsExportImport；旧的 CompactBody / WideBody 仅作为历史守卫锚点保留，
   * 不再由任何路由渲染（根页是四行菜单）。
   */
  @Builder
  SectionBody() {
    Column({ space: SPACING.md }) {
      Scroll(this.pageScroller) {
        Column({ space: SPACING.xl }) {
          // mod-settings-sync-page：同步子页已拥有自己的真页面（pages/SettingsSync），
          // 本宿主不再为 section='sync' 渲染任何正文或 prop 装配。
          if (this.section === SECTION_API) {
            this.AiGroup()
          } else if (this.section === SECTION_ABOUT) {
            this.AboutGroup()
          }
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

  build() {
    Stack({ alignContent: Alignment.Center }) {
      PageLayout({
        title: this.pageTitle,
        subtitle: this.saveHint.length > 0 ? this.saveHint : '',
        onBack: () => {
          router.back();
        }
      }) {
        this.SectionBody()
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
