/**
 * 设置页：三组（同步 / AI / 关于），每组 ≤4 行，长说明收进 `?` 弹层。
 *
 * 本页仍做四件事（逻辑未改）：内嵌隐藏 Web 跑 isomorphic-git、注册代理、按钮触发
 * pull/push/status、保存前做表单校验。「同步组」只留「立即同步」（= pull），
 * 推送/查看状态/重试上次/测试连接 + 平台与认证方式在组头「更多」里。
 *
 * AI 组接 `model/aiProvider.ts`：服务=预设源表，模型随服务联动；`save()` 内部已做
 * `resolveModel` / `aiBaseURLFor` 归一，因此本页**只传原始值**，不重复归一化。
 *
 * token / AI key 只存本机 preferences，不进同步载荷与日志；本页不打印它们。
 */
import { promptAction, router } from '@kit.ArkUI';
import { webview } from '@kit.ArkWeb';
import { common } from '@kit.AbilityKit';
import { http } from '@kit.NetworkKit';
import { util } from '@kit.ArkTS';
import { nowIso } from '../common/date';
import { getFeatures } from '../common/features';
import { isHarmonyOS } from '../common/platform';
import { normalizeDeviceId, settingsStore } from '../services/settingsStore';
import type { ScheduleSettings, SettingsPatch, SyncStatePatch } from '../services/settingsStore';
import { describeError, scheduleStore } from '../services/scheduleStore';
import { GitSyncService } from '../services/GitSyncService';
import type { GitSyncConfig, GitSyncResult } from '../services/GitSyncService';
import { describeRepoProbe, repoProbeUrl, validateRepoUrl } from '../model/repoUrl';
import type { RepoUrlCheck } from '../model/repoUrl';
import {
  AUTH_HTTPS,
  AUTH_SSH,
  FIELD_AI_BASE_URL,
  FIELD_AI_MODEL,
  FIELD_AUTHOR,
  FIELD_DEVICE_ID,
  FIELD_REPO_URL,
  FIELD_TOKEN,
  PLATFORM_GITHUB,
  PLATFORM_GITEE,
  authHint,
  checkSettingsFields,
  describeFirstIssue,
  describeIssues,
  effectiveToken,
  normalizeAuthMode,
  normalizePlatform,
  platformForRepoUrl,
  repoUrlExamples,
  repoUrlPlaceholder,
  validateAuthorName,
  validateDeviceIdText
} from '../model/settingsForm';
import type { SettingsFieldIssue } from '../model/settingsForm';
import {
  canRetrySync,
  classifySyncError,
  describeLastSync,
  normalizeSyncAction,
  syncActionLabel
} from '../model/syncError';
import type { SyncErrorInfo } from '../model/syncError';
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
import { assertHttpsUsername, resolveGitUsername } from '../model/gitAuth';
import { PageLayout } from '../components/PageLayout';
import { DIVIDER, FONT, HOME_INCLUDE_OTHER_KEY, LINE_HEIGHT, RADIUS, SPACING, TOUCH_MIN } from '../common/uiTokens';

/** 同步分支：与 `docs/DATA-CONTRACT.md` §1 一致，固定 main。 */
const SYNC_BRANCH: string = 'main';

/** 仓库探测超时（毫秒）：探测只看域名通不通，不需要长超时。 */
const PROBE_TIMEOUT_MS: number = 10000;

/** 底部弹层的单行高度。 */
const SHEET_ROW: number = 48;

/** 展示用版本号：与 `AppScope/app.json5` 的 versionName 保持一致（改版本时两处同步）。 */
const APP_VERSION: string = '1.0.0';

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
  /** 托管平台：`github` / `gitee`（只影响提示文案与示例）。 */
  @State gitPlatform: string = PLATFORM_GITHUB;
  /** 认证方式：`https` / `ssh`（只影响提示文案与 token 是否必填）。 */
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

  /** 从列表页跳转过来时要自动执行的同步动作（pull / push / status）。 */
  private autoAction: string = '';
  private gitController: webview.WebviewController = new webview.WebviewController();
  private sync: GitSyncService = new GitSyncService(this.gitController);
  private disposed: boolean = false;
  /** 已保存的 token：输入框留空时沿用（用户「不改 token」不该被拦）。 */
  private savedToken: string = '';
  /** 页面主滚动容器：校验失败时滚回顶部，让红色汇总与第一个错误字段进入视野。 */
  private pageScroller: Scroller = new Scroller();

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
      // 让 Git 桥使用与应用一致的沙箱根目录（G 的服务支持静态预置，缺省时才回落 getContext()）
      GitSyncService.setFilesDir(context.filesDir);
      await scheduleStore.ensureReady(context);
      if (this.disposed) {
        return;
      }
      this.ready = true;
      this.storageHint = `日程目录：${scheduleStore.deviceRoot()}/schedules/`;
      this.configure();
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
    this.gitPlatform = normalizePlatform(settings.gitPlatform);
    this.authMode = normalizeAuthMode(settings.authMode);
    this.lastSyncAt = settings.lastSyncAt;
    this.lastSyncError = settings.lastSyncError;
    this.lastSyncAction = normalizeSyncAction(settings.lastSyncAction);
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
      branch: SYNC_BRANCH,
      deviceId: normalizeDeviceId(this.deviceId),
      token: this.token.trim(),
      authorName: this.author.trim().length > 0 ? this.author.trim() : normalizeDeviceId(this.deviceId),
      authorEmail: this.authorEmail()
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
    // 平台自动纠正（URL 含 gitee.com → gitee），避免「URL 是 gitee、平台还是 github」导致提示错乱
    const platform: string = platformForRepoUrl(this.gitPlatform, this.repoUrl);
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
        // 保留用户输入的地址原文，只去掉首尾空白（末尾 .git 不擅自增删）；空地址存空串
        repoUrl: repoEmpty ? '' : repoCheck.url,
        // 输入框留空 = 沿用已保存的 token（不要把旧 token 清空）
        token: effectiveToken(this.token, this.savedToken),
        aiKey: this.aiKey,
        aiProviderId: this.aiProviderId,
        aiModel: this.aiModel,
        aiBaseURL: this.aiBaseURL,
        author: this.author,
        gitPlatform: platform,
        authMode: this.authMode,
        // HTTPS 用户名（Gitee 必填登录名；GitHub 留空由同步层回落 x-access-token）
        gitUsername: this.gitUsername.trim()
      };
      const saved = await settingsStore.save(patch, context);
      if (this.disposed) {
        return;
      }
      this.applySettings(saved);
      this.issuesSummary = '';
      scheduleStore.setDeviceId(saved.deviceId);
      this.storageHint = `日程目录：${scheduleStore.deviceRoot()}/schedules/`;
      this.configure();
      if (repoEmpty) {
        this.saveHint = `设置已保存（${nowIso()}）；仓库地址为空，同步前需要先填写`;
      } else if (this.authMode === AUTH_SSH) {
        this.saveHint = `设置已保存（${nowIso()}）；应用内同步内核只支持 HTTPS，真正同步前请切回 HTTPS(PAT)`;
      } else {
        this.saveHint = `设置已保存（${nowIso()}）`;
      }
      promptAction.showToast({ message: '设置已保存' });
    } catch (error) {
      if (this.disposed) {
        return;
      }
      this.saveHint = `保存失败：${describeError(error)}`;
    }
  }

  /** 选择平台（只改文案与示例，同步逻辑不变）。 */
  private pickPlatform(value: string): void {
    this.gitPlatform = normalizePlatform(value);
  }

  /** 选择认证方式（影响 token 是否必填与示例文案）。 */
  private pickAuthMode(value: string): void {
    this.authMode = normalizeAuthMode(value);
    this.gitUsernameError = '';
    // 切到 SSH 时 token 不再必填，清掉残留的必填红字
    if (this.authMode === AUTH_SSH) {
      this.tokenError = '';
    }
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
      this.connectionText = `ℹ️ SSH 地址无法在应用内探测（依赖系统 ssh-agent）：请在本机执行 git ls-remote ${repoCheck.url} 验证`;
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

  /** 当前源是否「实验」级（预设表 `experimental` 标记，地址/模型尚未实测）。 */
  private isExperimentalProvider(): boolean {
    return this.provider().experimental === true;
  }

  private isExperimental(id: string): boolean {
    return findProvider(id).experimental === true;
  }

  private platformLine(): string {
    return `${this.platformText} · ${this.handwritingText} · ${this.ocrText}`;
  }

  /** 用户名输入框占位文案（跟着平台变）。 */
  private gitUsernamePlaceholder(): string {
    if (this.gitPlatform === PLATFORM_GITEE) {
      return '必填：Gitee 登录名';
    }
    if (this.gitPlatform === PLATFORM_GITHUB) {
      return '可留空（默认 x-access-token）';
    }
    return '可选';
  }

  /** 用户名下方的一行说明（无错误时显示）。 */
  private gitUsernameHint(): string {
    if (this.gitPlatform === PLATFORM_GITEE) {
      return 'Gitee 的 HTTPS 认证用「登录名 + 私人令牌作密码」，用户名留空必然 401。';
    }
    if (this.gitPlatform === PLATFORM_GITHUB) {
      return 'GitHub 可留空：留空时按 x-access-token 认证。';
    }
    return '自建/其他托管：按服务端要求填写，留空则用 x-access-token。';
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
    const pending = this.autoAction;
    this.autoAction = '';
    if (pending.length > 0) {
      this.runAction(pending);
    }
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
      this.syncMessage = '应用内同步内核只支持 HTTPS 仓库地址：请把认证方式切回 HTTPS(PAT) 并填写 token';
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
    try {
      this.configure();
      let result: GitSyncResult;
      if (op === 'pull') {
        result = await this.sync.pull();
      } else if (op === 'push') {
        result = await this.sync.push(`日程同步：${nowIso()}`);
      } else {
        result = await this.sync.status();
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

      TextInput({ text: this.repoUrl, placeholder: repoUrlPlaceholder(this.gitPlatform, this.authMode) })
        .width('100%')
        .height(TOUCH_MIN + SPACING.xs)
        .fontSize(FONT.body)
        .backgroundColor($r('app.color.page_background'))
        .borderRadius(RADIUS.none)
        .padding({ left: 0, right: 0 })
        .onChange((value: string) => {
          this.repoUrl = value;
          this.repoUrlError = '';
        })
      Divider()
        .strokeWidth(DIVIDER)
        .color($r('app.color.divider'))
      if (this.repoUrlError.length > 0) {
        this.ErrorText(this.repoUrlError)
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
        placeholder: this.authMode === AUTH_SSH ? 'SSH 依赖系统 ssh-agent，可留空' : 'ghp_… / gitee token'
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
          .enabled(!this.syncBusy && this.webReady)
          .onClick(() => {
            this.runAction('pull');
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

      if (this.isExperimentalProvider()) {
        this.HintLine('实验：接口地址与模型清单待核实，请以服务商控制台为准。')
      }

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
        Text(describeLastSync(this.lastSyncAt, nowIso()))
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

  /** 紧凑屏：三组自上而下。 */
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

  /** 宽屏/横屏：左（同步 + 关于）/ 右（AI），底部统一保存。 */
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
        Text('GitHub')
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor(this.gitPlatform === PLATFORM_GITHUB ? $r('app.color.brand') : $r('app.color.text_secondary'))
          .backgroundColor(this.gitPlatform === PLATFORM_GITHUB ? $r('app.color.brand_soft') : $r('app.color.page_background'))
          .height(TOUCH_MIN)
          .layoutWeight(1)
          .textAlign(TextAlign.Center)
          .onClick(() => {
            this.pickPlatform(PLATFORM_GITHUB);
          })
        Text('Gitee')
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor(this.gitPlatform === PLATFORM_GITEE ? $r('app.color.brand') : $r('app.color.text_secondary'))
          .backgroundColor(this.gitPlatform === PLATFORM_GITEE ? $r('app.color.brand_soft') : $r('app.color.page_background'))
          .height(TOUCH_MIN)
          .layoutWeight(1)
          .textAlign(TextAlign.Center)
          .onClick(() => {
            this.pickPlatform(PLATFORM_GITEE);
          })
      }
      .width('100%')

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
        Text('SSH')
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor(this.authMode === AUTH_SSH ? $r('app.color.brand') : $r('app.color.text_secondary'))
          .backgroundColor(this.authMode === AUTH_SSH ? $r('app.color.brand_soft') : $r('app.color.page_background'))
          .height(TOUCH_MIN)
          .layoutWeight(1)
          .textAlign(TextAlign.Center)
          .onClick(() => {
            this.pickAuthMode(AUTH_SSH);
          })
      }
      .width('100%')

      this.HintLine(authHint(this.authMode))
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
            Text(repoUrlExamples(this.gitPlatform, this.authMode))
              .fontSize(FONT.body)
              .lineHeight(LINE_HEIGHT.body)
              .fontColor($r('app.color.text_primary'))
              .width('100%')
            Text('仓库地址可以先留空（只在本机记录日程）；留空时保存不报错，但「测试连接 / 立即同步 / 推送」前必须先填写。')
              .fontSize(FONT.caption)
              .lineHeight(LINE_HEIGHT.caption)
              .fontColor($r('app.color.text_secondary'))
              .width('100%')
            Text(authHint(this.authMode))
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
              if (this.isExperimental(item.id)) {
                Text('实验')
                  .fontSize(FONT.caption)
                  .lineHeight(LINE_HEIGHT.caption)
                  .fontColor($r('app.color.warning'))
              }
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
        subtitle: this.saveHint.length > 0 ? this.saveHint : '同步 / AI / 关于',
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
