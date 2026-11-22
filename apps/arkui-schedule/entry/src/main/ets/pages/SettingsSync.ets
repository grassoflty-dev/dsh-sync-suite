/**
 * 设置子页：同步仓库（mod-settings-sync-page）。
 *
 * 本页是**真页面**，不再是复用到实现宿主的薄壳：自带 `PageLayout`、一层 flex、
 * 自己的 `Scroll` 与唯一主操作「保存」；仓库地址 + 访问令牌的正文由
 * `components/settings/SyncSection.ets` 承接（presentational body，逐字复用）。
 *
 * 状态与业务方法归本页所有（不再走 `SettingsHost` 的 `section='sync'` 分支）：
 * - 保存只写本页拥有的同步字段（repoUrl / token 与静默派生的 authMode / gitUsername /
 *   gitPlatform），是 `settingsStore.save()` 的 patch —— 其它设置键保持原值，互不覆盖；
 * - 校验仍走 `checkSettingsFields`，与拆分前逐字一致（仓库地址可空、token 留空沿用已存值）；
 * - 诚实状态行：`已同步·HH:MM` / `同步中…` / `失败：原因`，失败态点一下即「重试」；
 * - 失败出口「查看状态 / 测试连接 / 重试」都在本页；没有「高级」，也没有「推送 / 立即同步」。
 *
 * 凭据 hygiene：token 只走 HTTPS Basic 头，不打印、不写日志、不进 Git 载荷。
 */
import { promptAction, router } from '@kit.ArkUI';
import { webview } from '@kit.ArkWeb';
import { common } from '@kit.AbilityKit';
import { http } from '@kit.NetworkKit';
import { util } from '@kit.ArkTS';
import { nowIso } from '../common/date';
import { toastMsFor } from '../common/copy';
import {
  DIVIDER,
  FONT,
  HOME_INCLUDE_OTHER_KEY,
  LINE_HEIGHT,
  RADIUS,
  SPACING,
  TOUCH_MIN
} from '../common/uiTokens';
import { normalizeDeviceId, settingsStore } from '../services/settingsStore';
import type { ScheduleSettings, SettingsPatch, SyncStatePatch } from '../services/settingsStore';
import { describeError } from '../services/scheduleStore';
import { GitSyncService } from '../services/GitSyncService';
import type { GitSyncConfig, GitSyncResult } from '../services/GitSyncService';
import { validateRepoUrl } from '../model/repoUrl';
import type { RepoUrlCheck } from '../model/repoUrl';
import { describeRepoProbe, repoProbeUrl } from '../model/repoUrl';
// mod-repo-privacy-gate：保存 / 测试连接都要做权威 provider API 私有校验（硬阻断）。
import { repoVisibilityChecker } from '../services/repoVisibilityChecker';
import { repoTargetFromUrl } from '../model/repoVisibilityClient';
import type { RepoVisibilityTarget } from '../model/repoVisibilityClient';
import { E_REPO_HOST_UNSUPPORTED, decisionForRepoCode } from '../model/repoVisibility';
import type { RepoVisibilityDecision } from '../model/repoVisibility';
import {
  AUTH_HTTPS,
  FIELD_REPO_URL,
  FIELD_TOKEN,
  checkSettingsFields,
  describeFirstIssue,
  describeIssues,
  effectiveToken,
  normalizeAuthMode,
  normalizePlatform
} from '../model/settingsForm';
import type { SettingsFieldIssue } from '../model/settingsForm';
import {
  DEFAULT_BRANCH,
  canRetrySync,
  classifySyncError,
  normalizeSyncAction,
  syncActionLabel
} from '../model/syncError';
import type { SyncErrorInfo } from '../model/syncError';
import { CUSTOM_PROVIDER_ID } from '../model/aiProvider';
import {
  GITEE_PLATFORM,
  PLATFORM_GITHUB,
  SSH_UNSUPPORTED_SHORT,
  describeAuthModeBlocker,
  httpsUsernameFor,
  isSshAuthMode,
  resolveGitUsername,
  resolvePlatformSelection
} from '../model/gitAuth';
import type { PlatformResolution } from '../model/gitAuth';
import { clockOf } from '../model/settingsMenu';
import { gitExtrasStore } from '../services/syncController';
import type { GitSyncExtras } from '../services/syncController';
import { PageLayout } from '../components/PageLayout';
import { describeIdentityConflict } from '../model/deviceIdentity';
import { SyncSection } from '../components/settings/SyncSection';
import { FieldLabel as FieldLabelBit, HintLine as HintLineBit } from '../components/settings/SettingsBits';

/** 仓库探测超时（毫秒）：只判断域名可达，不需要长超时。 */
const PROBE_TIMEOUT_MS: number = 10000;

/**
 * Wave C：本页用户可见状态只有 `honestStatus()` 一个来源（三态 + 启动中性面）。
 * `syncRowSummary` 只属于设置根页摘要，禁止在本页调用——保存不是一次同步，绝不写成功时刻。
 */

@Entry
@Component
struct SettingsSync {
  // ------------------------------------------------------------------ 主表单（本页唯一可编辑的两个字段）
  @State repoUrl: string = '';
  @State token: string = '';
  @State repoUrlError: string = '';
  @State tokenError: string = '';

  // ------------------------------------------------------------------ 静默派生（无输入控件）
  @State gitPlatform: string = PLATFORM_GITHUB;
  @State authMode: string = AUTH_HTTPS;
  @State gitUsername: string = '';
  @State platformTouched: boolean = false;
  @State deviceId: string = 'phone-a';
  @State author: string = '我';

  /** 已保存的 token：输入框留空时沿用（与拆分前同一语义）。 */
  private savedToken: string = '';

  // 只用于校验：这些字段的编辑在各自的子页，本页读取原值只为 `checkSettingsFields` 形状不变。
  @State aiProviderId: string = '';
  @State aiModel: string = '';
  @State aiBaseURL: string = '';

  // ------------------------------------------------------------------ 诚实状态行 / 失败出口
  @State lastSyncAt: string = '';
  @State lastSyncError: string = '';
  @State lastSyncAction: string = '';
  // 用户可见状态行由 honestStatus() 单一来源生成并直接传给 SyncSection；
  // 不再持有 syncMessage @State —— 保存 / 加载 / Web 就绪等事件都不许伪造同步结果。
  @State syncBusy: boolean = false;
  @State webReady: boolean = false;
  @State statusLine: string = '';
  @State ready: boolean = false;
  @State saveHint: string = '';
  @State issuesSummary: string = '';
  @State firstIssueText: string = '';
  @State identityWarning: string = '';
  @State attachmentWarning: string = '';
  @State includeOtherDevices: boolean = false;
  @State connectionText: string = '';
  @State connectionBusy: boolean = false;
  /** 唯一「更多」弹层的开关（空串 = 关闭）。 */
  @State panel: string = '';

  private disposed: boolean = false;
  private gitController: webview.WebviewController = new webview.WebviewController();
  private sync: GitSyncService = new GitSyncService(this.gitController);
  private lastStatusResult: GitSyncResult | null = null;
  private pageScroller: Scroller = new Scroller();

  aboutToAppear(): void {
    this.bootstrap();
  }

  aboutToDisappear(): void {
    this.disposed = true;
    this.webReady = false;
  }

  /** 读盘一次，铺到表单与状态行；读失败留确定文案，不编造同步状态。 */
  private async bootstrap(): Promise<void> {
    const context = getContext(this) as common.UIAbilityContext;
    try {
      await settingsStore.init(context);
      const settings: ScheduleSettings = await settingsStore.load();
      if (this.disposed) {
        return;
      }
      this.applySettings(settings);
      const extras: GitSyncExtras = await gitExtrasStore.load(context);
      if (this.disposed) {
        return;
      }
      this.applyExtras(extras);
      GitSyncService.setFilesDir(context.filesDir);
      this.ready = true;
      this.ensureUsernameResolved();
      this.configure();
      this.refreshStatus(true);
      this.refreshIdentityWarning();
    } catch (error) {
      if (this.disposed) {
        return;
      }
      this.ready = false;
      this.saveHint = `初始化失败：${describeError(error)}`;
    }
  }

  /** 把存储里的值铺到本页（读取与保存后共用）。 */
  private applySettings(settings: ScheduleSettings): void {
    this.deviceId = settings.deviceId;
    this.author = settings.author.trim().length > 0 ? settings.author : '我';
    this.repoUrl = settings.repoUrl;
    this.token = settings.token;
    this.savedToken = settings.token;
    this.gitUsername = settings.gitUsername;
    this.gitPlatform = normalizePlatform(settings.gitPlatform);
    this.authMode = normalizeAuthMode(settings.authMode);
    this.aiProviderId = settings.aiProviderId;
    this.aiModel = settings.aiModel;
    this.aiBaseURL = settings.aiBaseURL;
    this.lastSyncAt = settings.lastSyncAt;
    this.lastSyncError = settings.lastSyncError;
    this.lastSyncAction = normalizeSyncAction(settings.lastSyncAction);
    const storedFilter: boolean | undefined = AppStorage.get<boolean>(HOME_INCLUDE_OTHER_KEY);
    this.includeOtherDevices = storedFilter === true;
    // 只读铺状态；状态文案由 honestStatus() 现算，加载配置不是一次同步。
  }

  /** 平台扩展设置（分支恒为 main）；旧 platformTouched 锁定标记一律退役、按地址重新推断。 */
  private applyExtras(extras: GitSyncExtras): void {
    this.platformTouched = false;
    if (extras.platform.length > 0) {
      this.gitPlatform = extras.platform;
    }
  }

  /** HTTPS 用户名按仓库地址静默推断；推不出来也不打断用户，失败由状态行给原因。 */
  private ensureUsernameResolved(): void {
    if (this.gitUsername.trim().length > 0) {
      return;
    }
    const inferred: string = httpsUsernameFor(this.gitPlatform, this.repoUrl, '');
    if (inferred.length > 0) {
      this.gitUsername = inferred;
    }
  }

  /** 把本页配置推给同步内核（每个操作前都推一次，避免用旧配置）。 */
  private configure(): void {
    const config: GitSyncConfig = {
      repoUrl: this.repoUrl.trim(),
      branch: DEFAULT_BRANCH,
      deviceId: normalizeDeviceId(this.deviceId),
      token: this.token.trim(),
      authorName: this.author.trim().length > 0 ? this.author.trim() : normalizeDeviceId(this.deviceId),
      authorEmail: `${normalizeDeviceId(this.deviceId)}@schedule.local`,
      platform: this.gitPlatform,
      gitUsername: this.gitUsername.trim(),
      authMode: this.authMode
    };
    this.sync.configure(config);
  }

  // ------------------------------------------------------------------ 保存（本页唯一主操作）

  /** 把校验问题摊到本页两个可见字段；无可见落点的问题不计入横幅（不造幽灵报错）。 */
  private applyIssues(issues: SettingsFieldIssue[]): void {
    this.repoUrlError = '';
    this.tokenError = '';
    const applied: SettingsFieldIssue[] = [];
    for (const issue of issues) {
      if (issue.field === FIELD_REPO_URL) {
        this.repoUrlError = issue.message;
      } else if (issue.field === FIELD_TOKEN) {
        this.tokenError = issue.message;
      } else {
        // 设备标识 / 作者名 / AI 接口地址不在本页编辑，由各自页面负责显示红字。
        continue;
      }
      applied.push(issue);
    }
    this.issuesSummary = describeIssues(applied.length > 0 || issues.length === 0 ? applied : issues);
    this.firstIssueText = applied.length > 0 && applied.length === issues.length
      ? describeFirstIssue(applied)
      : '';
  }

  /** 保存：整表校验（与拆分前同一入口），通过后只写本页拥有的同步字段。 */
  private async saveSettings(): Promise<void> {
    const repoEmpty: boolean = this.repoUrl.trim().length === 0;
    const repoCheck: RepoUrlCheck = validateRepoUrl(this.repoUrl);
    const platformResolution: PlatformResolution = resolvePlatformSelection(
      this.repoUrl,
      this.gitPlatform,
      this.platformTouched
    );
    const platform: string = platformResolution.platform;
    const silentAuthor: string = this.author.trim().length > 0 ? this.author.trim() : '我';
    const issues: SettingsFieldIssue[] = checkSettingsFields(
      {
        deviceId: normalizeDeviceId(this.deviceId),
        author: silentAuthor,
        repoUrl: this.repoUrl,
        token: this.token,
        authMode: this.authMode,
        savedToken: this.savedToken,
        customProvider: this.aiProviderId === CUSTOM_PROVIDER_ID,
        aiModel: this.aiModel,
        aiBaseURL: this.aiBaseURL
      },
      repoCheck
    );
    this.ensureUsernameResolved();
    this.applyIssues(issues);
    if (this.issuesSummary.length > 0) {
      this.saveHint = this.issuesSummary;
      this.pageScroller.scrollEdge(Edge.Top);
      return;
    }
    // mod-repo-privacy-gate（调用点 1/3）：只要填了仓库地址就必须实时确认私有。
    // 硬阻断：不落盘、不标记已配置；**不清空** repoUrl 输入框，用户改完仓库可一点重试。
    if (!repoEmpty) {
      const targetFromForm: RepoVisibilityTarget | null = repoTargetFromUrl(repoCheck.url);
      if (targetFromForm === null) {
        this.saveHint = decisionForRepoCode(E_REPO_HOST_UNSUPPORTED).message;
        return;
      }
      const tokenForGate: string = effectiveToken(this.token, this.savedToken);
      this.saveHint = '正在校验仓库可见性…';
      const verdict: RepoVisibilityDecision = await repoVisibilityChecker.checkNow(targetFromForm, tokenForGate);
      if (this.disposed) {
        return;
      }
      if (!verdict.ok) {
        this.saveHint = verdict.message;
        this.pageScroller.scrollEdge(Edge.Top);
        return;
      }
    }
    const context = getContext(this) as common.UIAbilityContext;
    try {
      // 字段作用域：本页只写同步字段；AI / 主题 / 远程等键不传 = `save()` 保持原值。
      const patch: SettingsPatch = {
        repoUrl: repoEmpty ? '' : repoCheck.url,
        token: effectiveToken(this.token, this.savedToken),
        authMode: this.authMode,
        gitPlatform: platform === GITEE_PLATFORM ? GITEE_PLATFORM : PLATFORM_GITHUB,
        gitUsername: this.gitUsername.trim()
      };
      await settingsStore.save(patch, context);
      if (this.disposed) {
        return;
      }
      await gitExtrasStore.save(
        { branch: DEFAULT_BRANCH, platform: platform, platformTouched: this.platformTouched },
        context
      );
      if (this.disposed) {
        return;
      }
      this.issuesSummary = '';
      this.firstIssueText = '';
      // 保存只写配置，不是一次同步：lastSyncAt / lastSyncError 一律不碰，
      // honestStatus() 因此保持不变，绝不出现「保存即已同步」的假成功。
      let hint: string = `设置已保存（${nowIso()}）`;
      if (repoEmpty) {
        hint = `设置已保存（${nowIso()}）；仓库地址为空，同步前需要先填写`;
      } else if (isSshAuthMode(this.authMode)) {
        hint = `设置已保存（${nowIso()}）；${SSH_UNSUPPORTED_SHORT}，请点「改用 HTTPS 令牌」后再同步`;
      }
      this.saveHint = hint;
      promptAction.showToast({ message: '设置已保存', duration: toastMsFor(false) });
      this.configure();
    } catch (error) {
      if (this.disposed) {
        return;
      }
      this.saveHint = `保存失败：${describeError(error)}`;
    }
  }

  /** 当前认证方式的阻塞原因（空串 = 可同步）。 */
  private authBlocker(): string {
    return describeAuthModeBlocker(this.authMode);
  }

  /** SSH 警告行的显式出口：只切本地状态 + toast，落盘仍由「保存」完成。 */
  private switchToHttpsToken(): void {
    this.authMode = AUTH_HTTPS;
    // 只改认证方式，不动任何同步状态；诚实状态行由页内唯一来源现算，不写也不清。
    promptAction.showToast({ message: '已切换为 HTTPS + 令牌，保存后生效' });
  }

  // ------------------------------------------------------------------ 测试连接

  /** Git 探测用的 Basic 头：token 只在这里出现，不打印、不落盘。 */
  private basicAuthHeader(): string {
    const encoder: util.TextEncoder = new util.TextEncoder();
    const helper: util.Base64Helper = new util.Base64Helper();
    const username: string = resolveGitUsername(this.gitPlatform, this.gitUsername);
    return helper.encodeToStringSync(encoder.encodeInto(`${username}:${this.token.trim()}`));
  }

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
        // 已销毁 / 未开始：忽略
      }
    }
  }

  /** 「测试连接」：校验地址 → 真实 Git smart-HTTP 探测 → 中文结果。 */
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
      this.connectionText = `ℹ️ ${SSH_UNSUPPORTED_SHORT}：请改成 https:// 地址再测`;
      return;
    }
    // mod-repo-privacy-gate（调用点 2/3）：测试连接同样是权威 API 硬阻断。
    // 公开 / 无法校验的仓库绝不进入 Git 探测，更不会给出任何成功假象。
    const gateTarget: RepoVisibilityTarget | null = repoTargetFromUrl(repoCheck.url);
    if (gateTarget === null) {
      this.connectionText = decisionForRepoCode(E_REPO_HOST_UNSUPPORTED).message;
      return;
    }
    const gateToken: string = effectiveToken(this.token, this.savedToken);
    this.connectionBusy = true;
    this.connectionText = '正在校验仓库可见性…';
    let gatePassed: boolean = false;
    try {
      const gateVerdict: RepoVisibilityDecision = await repoVisibilityChecker.checkNow(gateTarget, gateToken);
      if (this.disposed) {
        return;
      }
      if (!gateVerdict.ok) {
        this.connectionText = gateVerdict.message;
        return;
      }
      gatePassed = true;
    } finally {
      if (!this.disposed && !gatePassed) {
        this.connectionBusy = false;
      }
    }
    const probeUrl: string = repoProbeUrl(repoCheck.url);
    if (probeUrl.length === 0) {
      this.connectionText = '失败：无法生成探测地址，请填写 https:// 或 http:// 形式的仓库地址（可重试）';
      return;
    }
    // mod-sync-silent-autoinit：测试连接不要求先手动拉取——先静默建好工作副本，再看真实远端状态。
    this.configure();
    const init: GitSyncResult = await this.sync.ensureRepoInitialised();
    if (!init.ok) {
      this.connectionText = `失败：${init.message}（可重试）`;
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
      // 真实远端状态（可达 / 领先 / 落后 / 一致 / 上次提交）只落诊断区，不进状态行。
      const state: GitSyncResult = await this.sync.status(true);
      if (!this.disposed && state.ok) {
        this.statusLine = state.diagnostics === undefined ? '' : state.diagnostics;
      }
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

  // ------------------------------------------------------------------ 同步逻辑

  /** 隐藏 Web 的 onPageEnd：注册代理（refresh 会二次触发，用 isReady 做幂等）。 */
  private onWebReady(): void {
    if (this.disposed) {
      return;
    }
    this.configure();
    if (!this.sync.isReady()) {
      try {
        this.sync.registerProxy();
      } catch (error) {
        // 内核注册失败是环境问题，不是同步结果：只写 saveHint，不碰状态行。
        this.saveHint = `注册同步代理失败：${describeError(error)}`;
      }
      return;
    }
    this.webReady = true;
    if (!this.ready) {
      return;
    }
    // 状态行完全由 honestStatus() 现算；Web 就绪不产生任何同步结果。
    this.refreshStatus(true);
    this.refreshIdentityWarning();
  }

  /** 刷新本地同步状态（分支 / ahead / behind / 冲突 / 本地改动）。 */
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
      if (result.diagnostics !== undefined && result.diagnostics.length > 0) {
        this.statusLine = result.diagnostics;
      }
    } catch (error) {
      // 状态刷新失败不影响主流程（状态行由 honestStatus() 现算，诊断事实留旧值即可）
    }
  }

  /** 复查设备身份（只读工作副本指纹，不联网）。 */
  private async refreshIdentityWarning(): Promise<void> {
    if (this.disposed || !this.ready) {
      return;
    }
    try {
      const text: string = await this.sync.identityWarning();
      if (!this.disposed) {
        this.identityWarning = text;
      }
    } catch (error) {
      // 读不到就保留上次的结论，不误清常驻警告
    }
  }

  /** 把同步结果的身份 / 附件标记铺到常驻状态（成功与失败都过一遍）。 */
  private applySyncFlags(result: GitSyncResult): void {
    const claimedId: string = result.deviceId === undefined ? '' : result.deviceId.trim();
    if (claimedId.length > 0) {
      this.deviceId = claimedId;
      this.configure();
    }
    if (result.identityConflict === true) {
      const warning: string = result.identityWarning === undefined ? '' : result.identityWarning.trim();
      this.identityWarning = warning.length > 0 ? warning : describeIdentityConflict(normalizeDeviceId(this.deviceId));
    } else {
      this.refreshIdentityWarning();
    }
    if (result.attachmentsBlocked !== undefined && result.attachmentsBlocked > 0) {
      const count: string = result.attachmentsBlocked.toString();
      const reason: string = result.attachmentWarning === undefined ? '' : result.attachmentWarning.trim();
      this.attachmentWarning = reason.length > 0
        ? `已暂停推送 ${count} 个附件：${reason}`
        : `已暂停推送 ${count} 个附件（远端可能已被别的设备改过）`;
    } else {
      this.attachmentWarning = '';
    }
  }

  /** 状态行只有 honestStatus() 一个来源；「能不能推」类可执行文案已随 m1 移出诊断区。 */

  /**
   * 用户可见状态行只有三态（mod-sync-silent-autoinit）：
   * `同步中…` / `已同步 · HH:MM` / `失败：<原因>（可重试）`。
   * 仓库是否已克隆、分支 / HEAD / 领先落后 / outbox 等待数一律只在诊断区出现。
   */
  private honestStatus(): string {
    if (this.syncBusy) {
      return '同步中…';
    }
    if (this.lastSyncError.length > 0) {
      return `失败：${this.lastSyncError}（可重试）`;
    }
    const clock: string = clockOf(this.lastSyncAt);
    return clock.length > 0 ? `已同步 · ${clock}` : '尚未同步';
  }

  /** 失败时点状态行即重放上次动作（不可重放则点不动、不假重试）。 */
  private retryFromStatus(): void {
    if (this.syncBusy || this.lastSyncError.length === 0) {
      return;
    }
    if (canRetrySync(this.lastSyncAction, this.syncBusy)) {
      this.runAction(this.lastSyncAction);
    }
  }

  /** 把「上次同步」三项回写 preferences。 */
  private async persistSyncState(): Promise<void> {
    if (!this.ready) {
      return;
    }
    const patch: SyncStatePatch = {
      lastSyncAt: this.lastSyncAt,
      lastSyncError: this.lastSyncError,
      lastSyncAction: this.lastSyncAction
    };
    const context = getContext(this) as common.UIAbilityContext;
    try {
      await settingsStore.saveSyncState(patch, context);
    } catch (error) {
      // 失败不影响已经完成的同步动作
    }
  }

  /**
   * 失败结果折成第三态 `失败：<原因>（可重试）` + 持久化；原因保留 typed 原文，不静默吞。
   * 失败后 `lastSyncAction` 不动，状态行点击与「更多 → 重试」都仍在（零步恢复）。
   */
  private async applySyncFailure(code: string, message: string): Promise<void> {
    const info: SyncErrorInfo = classifySyncError(code, message);
    // 只写 typed 原因；文案由 honestStatus() 折成第三态，页面不持有状态字符串。
    this.lastSyncError = `${info.title}：${info.detail}`;
    await this.persistSyncState();
  }

  /** 配置 / 环境类提示走 toast 或 saveHint，绝不写进同步状态行（不是同步结果）。 */
  private notice(message: string): void {
    promptAction.showToast({ message: message, duration: toastMsFor(false) });
  }

  /** 同步动作入口：只有 status / pull（重试用），没有推送 / 立即同步按钮。 */
  private async runAction(action: string): Promise<void> {
    if (action === 'cancel-wait') {
      this.syncBusy = false;
      this.notice('已停止等待：后台可能仍在执行，稍后点「查看状态」确认结果');
      return;
    }
    if (!this.webReady) {
      this.notice('同步内核尚未就绪，请稍候再试（隐藏 Web 环境仍在加载）');
      return;
    }
    const repoCheck: RepoUrlCheck = validateRepoUrl(this.repoUrl);
    this.repoUrlError = repoCheck.ok ? '' : repoCheck.error;
    if (!repoCheck.ok) {
      this.notice(`请先修正仓库地址：${repoCheck.error}`);
      return;
    }
    if (repoCheck.scheme !== 'https' && repoCheck.scheme !== 'http') {
      this.notice(`${SSH_UNSUPPORTED_SHORT}：请把仓库地址改成 https:// 并点「改用 HTTPS 令牌」`);
      return;
    }
    const authBlocker: string = this.authBlocker();
    if (authBlocker.length > 0) {
      this.notice(`失败：${authBlocker}（可重试）`);
      return;
    }
    const op: string = normalizeSyncAction(action);
    if (op.length === 0) {
      this.notice('未知的同步动作：只支持拉取 / 查看状态');
      return;
    }
    const label: string = syncActionLabel(op);
    // 忙碌态由 syncBusy 驱动 honestStatus() 输出「同步中…」，不再写字符串。
    this.syncBusy = true;
    this.lastSyncAction = op;
    let succeeded: boolean = false;
    try {
      this.configure();
      let result: GitSyncResult;
      if (op === 'pull') {
        result = await this.sync.pull();
      } else {
        result = await this.sync.status(true);
      }
      if (this.disposed) {
        return;
      }
      this.applySyncFlags(result);
      if (!result.ok) {
        const code: string = result.code === undefined ? '' : result.code;
        await this.applySyncFailure(code, result.message);
        return;
      }
      // 事实只进诊断区；成功时刻只在**真正跑过同步（pull）**后写，
      // 纯 status 查询不是一次同步，不得把「已同步 · HH:MM」刷新成现在。
      if (result.diagnostics !== undefined && result.diagnostics.length > 0) {
        this.statusLine = result.diagnostics;
      }
      this.lastSyncError = '';
      if (op === 'pull') {
        this.lastSyncAt = nowIso();
      }
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
    if (succeeded) {
      await this.refreshStatus(true);
    }
  }

  // ------------------------------------------------------------------ 共用构件 / 装配

  @Builder
  FieldLabel(text: string) {
    FieldLabelBit(text)
  }

  @Builder
  HintLine(text: string) {
    HintLineBit(text)
  }

  /** 保存失败时的顶部红色汇总。 */
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

  /** 状态行已统一到 SyncSection 的 `syncMessage`（由 honestStatus() 提供），本页不再渲染第二行。 */

  /**
   * 唯一的「更多」弹层（mod-fix-sync-affordance）：组头「更多」是唯一帮助/动作入口，
   * 承载查看状态 / 测试连接 / 重试（没有手动推送 / 立即同步）+ 仓库地址帮助文案。
   * 原先仓库地址行的 `?` 打开的是同一个弹层，重复入口已移除。
   */
  @Builder
  SyncMoreSheet() {
    Column({ space: SPACING.md }) {
      Row({ space: SPACING.sm }) {
        Text('更多')
          .fontSize(FONT.body)
          .lineHeight(LINE_HEIGHT.body)
          .fontWeight(FontWeight.Medium)
          .fontColor($r('app.color.text_primary'))
          .layoutWeight(1)
          .textAlign(TextAlign.Start)
        Text('关闭')
          .fontSize(FONT.caption)
          .fontColor($r('app.color.text_secondary'))
          .height(TOUCH_MIN)
          .onClick(() => {
            this.panel = '';
          })
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      Text('查看状态')
        .fontSize(FONT.body)
        .lineHeight(LINE_HEIGHT.body)
        .fontColor($r('app.color.text_primary'))
        .width('100%')
        .height(TOUCH_MIN)
        .textAlign(TextAlign.Start)
        .enabled(!this.syncBusy)
        .onClick(() => {
          this.panel = '';
          this.runAction('status');
        })
      Text('测试连接')
        .fontSize(FONT.body)
        .lineHeight(LINE_HEIGHT.body)
        .fontColor($r('app.color.text_primary'))
        .width('100%')
        .height(TOUCH_MIN)
        .textAlign(TextAlign.Start)
        .enabled(!this.connectionBusy)
        .onClick(() => {
          this.panel = '';
          this.testConnection();
        })
      if (canRetrySync(this.lastSyncAction, this.syncBusy)) {
        Text('重试')
          .fontSize(FONT.body)
          .lineHeight(LINE_HEIGHT.body)
          .fontColor($r('app.color.warning'))
          .width('100%')
          .height(TOUCH_MIN)
          .textAlign(TextAlign.Start)
          .onClick(() => {
            this.panel = '';
            this.runAction(this.lastSyncAction);
          })
      }

      Divider()
        .strokeWidth(DIVIDER)
        .color($r('app.color.divider'))
      if (this.connectionText.length > 0) {
        // 诊断区：连接探测的 HTTP 事实只在这里出现，不是提示也不是「先做什么」的死结。
        Text('诊断（仅排查用）')
          .fontSize(FONT.caption)
          .fontColor($r('app.color.text_secondary'))
          .width('100%')
          .textAlign(TextAlign.Start)
        this.HintLine(this.connectionText)
      }
      this.HintLine('仓库地址可以先留空（只在本机记录日程）；留空时保存不报错，但同步与测试连接前必须先填写。')
      this.HintLine(`平台按仓库地址自动识别；分支固定 ${DEFAULT_BRANCH}。`)
      this.HintLine('token 只保存在本机 preferences，不会写进同步仓库，也不会出现在日志里。')
    }
    .width('100%')
    .padding(SPACING.lg)
    .alignItems(HorizontalAlign.Start)
  }

  /** 本页唯一主操作：保存（与拆分前同一校验入口）。 */
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

  build() {
    Stack({ alignContent: Alignment.TopStart }) {
      PageLayout({
        title: '同步仓库',
        subtitle: this.saveHint.length > 0 ? this.saveHint : '',
        onBack: () => {
          router.back();
        }
      }) {
        // 一层 flex：内容 Scroll 吃余量 + 底部唯一「保存」；没有断点骨架 / 嵌套固定高度外壳。
        Column({ space: SPACING.md }) {
          Scroll(this.pageScroller) {
            Column({ space: SPACING.xl }) {
              this.IssuesBanner()
              SyncSection({
                gitPlatform: this.gitPlatform,
                authMode: this.authMode,
                repoUrl: this.repoUrl,
                repoUrlError: this.repoUrlError,
                token: this.token,
                tokenError: this.tokenError,
                deviceId: this.deviceId,
                identityWarning: this.identityWarning,
                attachmentWarning: this.attachmentWarning,
                // 唯一状态来源：honestStatus() 现算的三态/中性文案，直接喂给正文区的状态行。
                syncMessage: this.honestStatus(),
                syncBusy: this.syncBusy,
                webReady: this.webReady,
                statusLine: this.statusLine,
                lastSyncError: this.lastSyncError,
                lastSyncAction: this.lastSyncAction,
                saveHint: this.saveHint,
                issuesSummary: this.issuesSummary,
                includeOtherDevices: this.includeOtherDevices,
                authBlocker: (): string => this.authBlocker(),
                onChangeRepoUrl: (value: string): void => {
                  this.repoUrl = value;
                  this.repoUrlError = '';
                },
                onChangeToken: (value: string): void => {
                  this.token = value;
                  this.tokenError = '';
                },
                onToggleIncludeOtherDevices: (isOn: boolean): void => {
                  this.includeOtherDevices = isOn;
                  AppStorage.setOrCreate<boolean>(HOME_INCLUDE_OTHER_KEY, isOn);
                },
                runAction: (action: string): void => {
                  this.runAction(action);
                },
                onRetryStatus: (): void => {
                  this.retryFromStatus();
                },
                onOpenSyncMore: (): void => {
                  this.panel = 'more';
                },
                onSwitchToHttpsToken: (): void => {
                  this.switchToHttpsToken();
                },
                gitController: this.gitController,
                onWebReady: (): void => {
                  this.onWebReady();
                },
                onWebError: (): void => {
                  if (!this.disposed) {
                    // 内核加载失败是环境问题，不是同步结果：只写 saveHint。
                    this.saveHint = '同步内核加载失败：rawfile/git/index.html 无法加载';
                  }
                }
              })
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

      // 唯一的「更多」弹层（查看状态 / 测试连接 / 重试 + 仓库地址帮助与测试连接结果）；点 scrim 关闭。
      if (this.panel.length > 0) {
        Column()
          .width('100%')
          .height('100%')
          .backgroundColor($r('app.color.scrim'))
          .onClick(() => {
            this.panel = '';
          })
        Column() {
          Blank()
          Column() {
            this.SyncMoreSheet()
          }
          .width('100%')
          .backgroundColor($r('app.color.surface'))
          .borderRadius({ topLeft: RADIUS.md, topRight: RADIUS.md })
        }
        .width('100%')
        .height('100%')
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor($r('app.color.page_background'))
  }
}
