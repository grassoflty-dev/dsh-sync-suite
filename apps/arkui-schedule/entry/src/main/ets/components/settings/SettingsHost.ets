/**
 * 设置子页共用的实现宿主（历史锚点）：保留同步内核 / 主题 / 关于组的状态与业务方法。
 * （同步组因为「分支 / 推送 / 状态」三项新需求变长，次要项继续收在组头「更多」里。）
 *
 * 「仅手写笔输入」的入口在**手写板 → 笔迹面板**（`pages/harmony/Handwriting.ets`），
 * 本页不再重复提供该开关；`settingsStore.penOnlyInput` 键仍保留（笔迹面板读写它），
 * 本页保存时**不传**该字段（不传＝不改，见 `settingsStore.save` 的 patch 语义）。
 *
 * 本页仍做四件事（逻辑未改）：内嵌隐藏 Web 跑 isomorphic-git、注册代理、按钮触发
 * pull/push/status、保存前做表单校验。
 *
 * 远程实例入口（mod-settings-instances-entry-dedupe）：唯一入口是设置根页 `pages/Settings`
 * 的「远程实例」行；本宿主不再渲染任何打开 `pages/Instances` 的入口行。
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
 * token 只存本机 preferences，不进同步载荷与日志；本页不打印它。
 *
 * **A2 拆分 / mod-settings-sync-page / mod-settings-export-page / mod-settings-api-page（纯重构）**：
 * 三个设置子页都已成为自带真页面（`pages/SettingsSync` / `pages/SettingsExportImport` /
 * `pages/SettingsApi`），各自持有状态与业务方法、装配自己的 presentational body。
 * 本宿主的 AI 分支（`AiGroup` / AI 状态 / AI imports）随 mod-settings-api-page 删除；
 * `saveSettings()` 仍走 `settingsStore.save()` 的 patch（未提供的键保留磁盘原值），
 * 所以当宿主保存时**不会清空已存的 AI 字段**。现存 `CompactBody` / `WideBody` /
 * `SectionBody()` 等 builder 仅作历史守卫锚点，不再由任何路由渲染。
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
  classifySyncError,
  describePushReadiness,
  normalizeSyncAction,
  syncActionLabel,
  DEFAULT_BRANCH
} from '../../model/syncError';
import type { SyncErrorInfo, SyncStatusView } from '../../model/syncError';
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
// 同步 / 数据 / API 正文已各自迁到 pages/SettingsSync / pages/SettingsExportImport /
// pages/SettingsApi，本宿主不再装配 AiSection。
import { AboutSection } from './AboutSection';
import { FieldLabel as FieldLabelBit, HintLine as HintLineBit } from './SettingsBits';
import { DIVIDER, FONT, LINE_HEIGHT, RADIUS, SPACING, TOUCH_MIN } from '../../common/uiTokens';
import { applyThemeMode, isSystemDark } from '../../common/themeApply';
import { normalizeThemeMode, resolveTheme, themeModeHint, themeModeLabel } from '../../model/theme';

/** 仓库探测超时（毫秒）：探测只看域名通不通，不需要长超时。 */
const PROBE_TIMEOUT_MS: number = 10000;

/** 锚点还没测到位置时的提示（点了不能静默，见 docs/STATE-UI.md §3）。 */
const ANCHOR_NOT_READY: string = '页面还在排版，稍后再点一次';

/**
 * mod-settings-root：设置根页四行菜单各自 push 的子页，本页面是它们共用的实现宿主。
 * 旧 `CompactBody` / `WideBody` 及其组锚点 builder 原样保留（历史静态守卫的锚点），
 * 但子页只渲染自己那一段 section —— 根页不渲染任何 section body。
 * mod-settings-api-page：AI 分支及其 `SECTION_API` 标识已删除，API 子页改为自带真页面。
 */
const SECTION_ABOUT: string = 'about';

/** 弹层标识：同一时刻只开一个。 */
const PANEL_NONE: string = '';
const PANEL_SYNC_MORE: string = 'syncMore';
const PANEL_PRIVACY: string = 'privacy';
const PANEL_REPO: string = 'repo';

@Component
export struct SettingsHost {
  /**
   * 子页标识（`SECTION_*`）：决定本页面渲染哪一段 section。
   * 同步 / 数据 / API 子页已有自己的真页面，不再向本宿主传 section；
   * 默认值留空串（不渲染任何 section），仅历史 `about` 分支保留。
   */
  @Prop section: string = '';
  /** 页面标题（由薄壳传入，与各自 `main_pages.json` 路由一一对应）。 */
  @Prop pageTitle: string = '';

  @State deviceId: string = 'phone-a';
  @State author: string = '';
  @State repoUrl: string = '';
  @State token: string = '';
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
  /**
   * Git 用户名（仅 HTTPS 认证用）：**无输入控件**，由 `ensureGiteeUsernameResolved()` 按仓库地址静默推断；
   * 旧值从 settingsStore 读出后原样保留（不迁移、不清空），只是不再上屏。
   */
  @State gitUsername: string = '';
  // 表单校验提示：mod-settings-sync-page 后仓库地址 / 令牌的红字归 pages/SettingsSync，
  // mod-settings-api-page 后 AI 接口地址的红字归 pages/SettingsApi，本宿主不再持有任何字段错误态。
  @State connectionText: string = '';
  @State connectionBusy: boolean = false;
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

  /**
   * 深色模式三态（`system` | `light` | `dark`）。
   *
   * 切换即生效（`setColorMode` + 落盘，见 `saveThemeMode`），不等底部「保存设置」——
   * 用户点「深色」就是为了立刻看效果，中间不该再要一次确认。
   */
  @State themeMode: string = 'system';
  // 远程控制字段已收敛到 pages/Instances；入口行也已移到设置根页（本宿主不再保留）。

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
    // mod-settings-api-page：AI 字段与多源 fallback 三键已归 pages/SettingsApi，
    // 宿主读全量只是为了保留同步 / 主题 / 关于的口径；不传键的保存不会改动 AI 值。
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
   * 保存：先做全字段校验，全部通过才写 preferences。
   *
   * 仓库地址**允许为空**（首次使用不该被卡住），空地址会在
   * 「测试连接 / 拉取 / 查看状态」前被强校验拦住（见 `runAction` / `testConnection`）。
   * mod-settings-api-page：AI 字段已归 pages/SettingsApi，本宿主的 patch 不再写它们 ——
   * `settingsStore.save()` 是 patch，未提供的键保留磁盘原值，故宿主保存不会清空已存 AI 配置。
   */
  /**
   * 把校验问题摊到可见字段的 `*Error` 状态上。
   *
   * mod-settings-sync-page / mod-settings-api-page 后本宿主没有可编辑字段：
   * 仓库地址 / 令牌的红字归 pages/SettingsSync，AI 接口地址归 pages/SettingsApi。
   * 这里只保留同一份整表校验入口，不把无落点的问题伪装成界面红字（幽灵报错）。
   */
  private applyIssues(issues: SettingsFieldIssue[]): void {
    const applied: SettingsFieldIssue[] = [];
    for (const issue of issues) {
      // 设备标识 / 作者名 / 仓库地址 / token / AI 接口地址都归各自的真页面渲染，
      // 本宿主没有它们的输入控件；校验入口传的是「已归一 / 已兜底」的静默值，
      // 这类 issue 不可达，宁可不计入横幅也不制造「说有 N 项却看不到红字」的幽灵报错。
      if (issue.field === FIELD_REPO_URL || issue.field === FIELD_TOKEN) {
        continue;
      }
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
        // mod-settings-api-page：AI 字段不在本宿主编辑，传静默值保证 AI issue 不可达。
        customProvider: false,
        aiModel: '',
        aiBaseURL: ''
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
        // mod-settings-api-page：AI 字段不在此处写。settingsStore.save() 是 patch，
        // 未提供的 aiKey / aiProviderId / aiModel / aiBaseURL 保留磁盘原值（不会被清空）。
        author: silentAuthor,
        // settingsStore 只认 github/gitee（它的 normalizePlatform 会把 gitlab/custom 折成 github），
        // 真正的四值平台存在 gitExtrasStore 里，这里写回一个它认识的等价物即可。
        gitPlatform: platform === GITEE_PLATFORM ? GITEE_PLATFORM : PLATFORM_GITHUB,
        authMode: this.authMode,
        // HTTPS 用户名（Gitee 必填登录名；GitHub 留空由同步层回落 x-access-token）
        gitUsername: this.gitUsername.trim(),
        // 远程字段不再随本页整表保存：配置入口已迁到 pages/Instances（旧键值仍原样留在 store）。
        // AI 与多源 fallback 三键归 pages/SettingsApi：不传即保留 preferences 里的原值。
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

  // mod-settings-api-page：测试 AI / 多源 fallback / AI 源选择方法随 AI 分支一并迁到
  // pages/SettingsApi，本宿主不再持有任何 AI 状态或 handler。

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
   * 紧凑屏组锚点行：同步 / AI / 数据 / 关于（顺序 = 组顺序）。
   *
   * 位置：`Scroll` 内容的最上面、`IssuesBanner` 与第一个组头之前 —— 随内容一起滚走，
   * **不悬浮**，因此不会遮住首屏表单；进页面时就在视野内，点一下直达目标组。
   *
   * 为什么不用 `ActionButton`：它的左右内边距是 `SPACING.lg`，4 个塞进 360vp 宽会溢出/裁字；
   * 锚点也没有「禁用」语义（未测量时点击会 toast 原因），因此用原生 `Button` + 令牌尺寸。
   * 宽屏两列已短，不做锚点（见 docs/UX-STEPS.md §4.2）。
   */
  @Builder
  GroupAnchorBar() {
    Row({ space: SPACING.sm }) {
      this.GroupAnchorChip('同步', 0)
      this.GroupAnchorChip('AI', 1)
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
   * 分工：**页面持有全部 `@State` 与业务方法**（保存 / 同步 / 导出 / 主题切换），
   * 组件只收单向 props + 回调（`@Prop` 值 + `onXxx`）。因此：
   * - 刷新语义不变（父页面值变了才重绘组件）；
   * - 回调闭包始终读页面最新状态（`authBlocker()` 之类的只读派生以函数 props 传入）；
   * - 输入框仍是「受控」的：组件把输入回传给页面，页面写 `@State`，值再经 `@Prop` 铺回去。
   *
   * 紧凑屏与宽屏两套骨架都调用下面这五个 builder（组顺序与拆分前逐字一致）。
   */
  // mod-settings-sync-page / mod-settings-api-page：SyncGroup 与 AiGroup 装配均已迁出本宿主，
  // 正文、状态与保存都在各自真页面；CompactBody / WideBody 仅作历史守卫锚点保留。

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

  /** 紧凑屏历史骨架（不再由任何路由渲染）：AI 分支已随 mod-settings-api-page 删除。 */
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

  /** 宽屏/横屏历史骨架（不再由任何路由渲染）：原右栏 AI 分支已删除。 */
  @Builder
  WideBody() {
    Column({ space: SPACING.md }) {
      Scroll(this.pageScroller) {
        Column({ space: SPACING.md }) {
          this.IssuesBanner()
          Column({ space: SPACING.xl }) {
            this.AboutGroup()
          }
          .width('100%')
          .alignItems(HorizontalAlign.Start)
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

  /**
   * 遗留实现宿主里的「更多」弹层（mod-sync-silence-phase-b）。
   * 本组件未挂任何路由 / 未被任何 @Component 实例化（reachability 见 §module doc），
   * 但为避免任何「可达面提供手动同步」的可能，三个手动同步控件仍在此删除：
   * 查看状态 / 重试 / 测试连接的能力方法保留给支持排障，本弹层只剩只读探测诊断。
   */
  @Builder
  SyncMoreSheet() {
    Column({ space: SPACING.md }) {
      this.SheetHeader('同步（Git）更多操作')

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

  // mod-settings-api-page：服务 / 模型选择弹层（PickerSheet）随 AI 分支迁到 pages/SettingsApi。

  @Builder
  SheetBody() {
    Column() {
      if (this.panel === PANEL_SYNC_MORE) {
        this.SyncMoreSheet()
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
   * 历史守卫锚点：同步数据 / API / 数据正文都已迁到各自真页面，
   * 本宿主的 `SectionBody()` 不再由任何路由渲染（根页是四行菜单）。
   */
  @Builder
  SectionBody() {
    Column({ space: SPACING.md }) {
      Scroll(this.pageScroller) {
        Column({ space: SPACING.xl }) {
          // mod-settings-sync-page / mod-settings-api-page / mod-settings-export-page：
          // 三个子页各有真页面，本宿主不再为 section 渲染任何正文或 prop 装配。
          if (this.section === SECTION_ABOUT) {
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
