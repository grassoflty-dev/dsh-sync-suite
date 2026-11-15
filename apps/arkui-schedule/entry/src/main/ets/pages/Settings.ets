/**
 * 设置页：设备标识 / 作者名 / 平台 / 认证方式 / 仓库 URL / token / AI 配置 + Git 同步区
 * + 平台信息 + AGC 说明。
 *
 * 契约：BRIEF §3.4 / §3.5、`docs/CONTRACT.md` §3.4。本页做四件事：
 * 1. 内嵌**隐藏**的 `Web` 环境加载 `rawfile/git/index.html`（isomorphic-git + 桥接脚本）；
 * 2. `onPageEnd` 时 `registerProxy()` 并 `configure()`；
 * 3. 按钮触发 `pull()/push()/status()`，把结果与错误显示在页面上；
 * 4. 保存前做表单校验（设备标识 / 作者名 / token），并提供「测试连接」「测试 AI 连通性」。
 *
 * 校验与文案的纯逻辑在 `model/repoUrl.ts`、`model/settingsForm.ts`、`model/aiRequest.ts`、
 * `model/syncError.ts`（均有 Node 单测），本页只做状态与展示。
 *
 * 仓库地址**允许留空**（首次使用先改设备标识/作者名/AI key 不应该被卡住）：
 * 空地址可以保存，但「测试连接 / 同步」前会强校验并提示补填（见 `docs/ROADMAP.md`）。
 *
 * 注意：token / AI key 只存本机 preferences，永不进入同步载荷或日志；本页也不打印它们。
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
import { DEFAULT_AI_MODEL } from '../model/aiRequest';
import { describeRepoProbe, repoProbeUrl, validateRepoUrl } from '../model/repoUrl';
import type { RepoUrlCheck } from '../model/repoUrl';
import {
  AUTH_HTTPS,
  AUTH_SSH,
  PLATFORM_GITHUB,
  PLATFORM_GITEE,
  authHint,
  normalizeAuthMode,
  normalizePlatform,
  repoUrlExamples,
  repoUrlPlaceholder,
  validateAuthorName,
  validateDeviceIdText,
  validateToken
} from '../model/settingsForm';
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

/** 同步分支：与 `docs/DATA-CONTRACT.md` §1 一致，固定 main。 */
const SYNC_BRANCH: string = 'main';

/** 仓库探测超时（毫秒）：探测只是看域名通不通，不需要长超时。 */
const PROBE_TIMEOUT_MS: number = 10000;

/** 错误文案颜色（与页面其它红字一致）。 */
const ERROR_COLOR: string = '#D94838';
/** 提示文案颜色。 */
const HINT_COLOR: string = '#8A93A0';

@Entry
@Component
struct Settings {
  @State deviceId: string = 'phone-a';
  @State author: string = '';
  @State repoUrl: string = '';
  @State token: string = '';
  @State aiKey: string = '';
  @State aiModel: string = DEFAULT_AI_MODEL;
  /** 托管平台：`github` / `gitee`（只影响提示文案与示例）。 */
  @State gitPlatform: string = PLATFORM_GITHUB;
  /** 认证方式：`https` / `ssh`（只影响提示文案与 token 是否必填）。 */
  @State authMode: string = AUTH_HTTPS;
  @State ready: boolean = false;
  @State saveHint: string = '';
  // 表单校验提示（逐字段红字）
  @State deviceIdError: string = '';
  @State authorError: string = '';
  @State repoUrlError: string = '';
  @State tokenError: string = '';
  @State connectionText: string = '';
  @State connectionBusy: boolean = false;
  @State aiTestText: string = '';
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
  /** 从列表页跳转过来时要自动执行的同步动作（pull / push / status）。 */
  private autoAction: string = '';
  private gitController: webview.WebviewController = new webview.WebviewController();
  private sync: GitSyncService = new GitSyncService(this.gitController);
  private disposed: boolean = false;

  aboutToAppear(): void {
    this.platformText = isHarmonyOS() ? 'HarmonyOS' : 'Android';
    const features = getFeatures();
    this.handwritingText = features.handwriting ? '可用（Canvas 分页手写 + 逐页截图落盘）' : '不可用';
    this.ocrText = features.ocr ? '可用（textRecognition 逐页串行识别）' : '不可用';
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
    this.aiKey = settings.aiKey;
    this.aiModel = settings.aiModel;
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
   * 校验口径见 `model/settingsForm.ts` / `model/repoUrl.ts`：
   * 设备标识（非空、≥3、无空白/斜杠、合法字符）、作者名（非空）、
   * 仓库地址（**允许为空**；非空时必须是 http(s)/ssh/git@ 形态）、
   * token（仅当仓库地址非空且认证方式为 HTTPS 时必填）。
   *
   * 为什么允许仓库地址为空：首次使用的真实路径是「先在本机记录日程，之后再配同步」，
   * 若强制要求仓库地址+token，用户连设备标识/作者名/AI key 都存不下来（设置页死锁）。
   * 空地址会在「测试连接 / 拉取 / 推送 / 查看状态」前被强校验拦住（见 `testConnection` / `runAction`），
   * 所以不会把空地址带上网络。决策记录：`docs/ROADMAP.md`。
   */
  private async saveSettings(): Promise<void> {
    const deviceError: string = validateDeviceIdText(this.deviceId);
    const authorError: string = validateAuthorName(this.author);
    const repoEmpty: boolean = this.repoUrl.trim().length === 0;
    const repoCheck: RepoUrlCheck = validateRepoUrl(this.repoUrl);
    // 仓库地址为空 → 不做地址/ token 的必填校验（其余字段照常校验）
    const repoError: string = repoEmpty || repoCheck.ok ? '' : repoCheck.error;
    const tokenError: string = repoEmpty ? '' : validateToken(this.authMode, this.token);
    this.deviceIdError = deviceError;
    this.authorError = authorError;
    this.tokenError = tokenError;
    this.repoUrlError = repoError;
    if (deviceError.length > 0 || authorError.length > 0 || tokenError.length > 0 || repoError.length > 0) {
      this.saveHint = '设置未保存：请先修正标红的问题';
      return;
    }
    const context = getContext(this) as common.UIAbilityContext;
    try {
      const patch: SettingsPatch = {
        deviceId: normalizeDeviceId(this.deviceId),
        // 保留用户输入的地址原文，只去掉首尾空白（末尾 .git 不擅自增删）；空地址存空串
        repoUrl: repoEmpty ? '' : repoCheck.url,
        token: this.token,
        aiKey: this.aiKey,
        aiModel: this.aiModel,
        author: this.author,
        gitPlatform: this.gitPlatform,
        authMode: this.authMode
      };
      const saved = await settingsStore.save(patch, context);
      if (this.disposed) {
        return;
      }
      this.applySettings(saved);
      scheduleStore.setDeviceId(saved.deviceId);
      this.storageHint = `日程目录：${scheduleStore.deviceRoot()}/schedules/`;
      this.configure();
      if (repoEmpty) {
        this.saveHint = `设置已保存（${nowIso()}）；仓库地址为空，同步前需要先填写`;
      } else if (this.authMode === AUTH_SSH) {
        this.saveHint = `设置已保存（${nowIso()}）；注意应用内同步内核只支持 HTTPS，真正同步前请切回 HTTPS(PAT)`;
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
    return helper.encodeToStringSync(encoder.encodeInto(`x-access-token:${this.token.trim()}`));
  }

  /**
   * 对仓库发一次真实的 Git smart-HTTP 探测（`GET <repo>/info/refs?service=git-upload-pack`）。
   *
   * 为什么本页自己发：`services/GitSyncService.ets` 的 `probeRemote()` 是 private，
   * 且只在 `status()` 里被调用（要求隐藏 Web 桥就绪、结果与本地仓库状态混在一起）；
   * 这里沿用同一套探测语义（200/401/403/404），但不依赖 Web 就绪，也不新增网络权限
   * （INTERNET 已在 module.json5 声明）。
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
   * 「测试 AI 连通性」：用最小 prompt 调一次 DeepSeek，显示
   * `成功：HTTP 200 / 模型 deepseek-chat` 或 `失败：密钥无效（HTTP 401）…`。
   * key 只在请求头里出现，页面与本页都不打印它。
   */
  private async testAi(): Promise<void> {
    if (this.aiTestBusy) {
      return;
    }
    if (this.aiKey.trim().length === 0) {
      this.aiTestText = '失败：请先填写 DeepSeek API Key';
      return;
    }
    this.aiTestBusy = true;
    this.aiTestText = '正在调用 DeepSeek（最长等 20 秒）…';
    try {
      const result: AiTestResult = await testAiConnection(this.aiKey, this.aiModel);
      if (this.disposed) {
        return;
      }
      this.aiTestText = result.message;
    } catch (error) {
      if (this.disposed) {
        return;
      }
      this.aiTestText = `失败：${describeError(error)}`;
    } finally {
      if (!this.disposed) {
        this.aiTestBusy = false;
      }
    }
  }

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
      .fontSize(13)
      .fontColor($r('app.color.text_secondary'))
      .width('100%')
      .textAlign(TextAlign.Start)
  }

  @Builder
  Card(title: string) {
    Text(title)
      .fontSize(15)
      .fontWeight(FontWeight.Bold)
      .fontColor($r('app.color.text_primary'))
      .width('100%')
      .textAlign(TextAlign.Start)
  }

  @Builder
  SyncPanel() {
    Column({ space: 10 }) {
      this.Card('Git 同步')
      // 上次同步时间：来自本机 preferences（跨启动保留），不联网也能看
      Text(describeLastSync(this.lastSyncAt, nowIso()))
        .fontSize(12)
        .fontColor($r('app.color.text_secondary'))
        .width('100%')
        .textAlign(TextAlign.Start)
      Text(this.syncMessage)
        .fontSize(12)
        .fontColor(this.syncMessage.startsWith('❌') ? ERROR_COLOR : $r('app.color.text_secondary'))
        .width('100%')
        .textAlign(TextAlign.Start)
      if (this.lastSyncError.length > 0) {
        Text(`上次错误：${this.lastSyncError}`)
          .fontSize(12)
          .fontColor(ERROR_COLOR)
          .width('100%')
          .textAlign(TextAlign.Start)
          .lineHeight(18)
      }

      Row({ space: 8 }) {
        Button('拉取')
          .layoutWeight(1)
          .height(40)
          .backgroundColor($r('app.color.brand'))
          .fontColor(Color.White)
          .enabled(!this.syncBusy)
          .onClick(() => {
            this.runAction('pull');
          })
        Button('推送')
          .layoutWeight(1)
          .height(40)
          .backgroundColor('#E8F1FF')
          .fontColor($r('app.color.brand'))
          .enabled(!this.syncBusy)
          .onClick(() => {
            this.runAction('push');
          })
        Button('查看状态')
          .layoutWeight(1)
          .height(40)
          .backgroundColor('#E8F1FF')
          .fontColor($r('app.color.brand'))
          .enabled(!this.syncBusy)
          .onClick(() => {
            this.runAction('status');
          })
      }
      .width('100%')

      // 「重试」：重放上一次动作（失败后最常见的一步），不记住成功与否也能用来再同步一次
      if (canRetrySync(this.lastSyncAction, this.syncBusy)) {
        Button(`重试${syncActionLabel(this.lastSyncAction)}`)
          .width('100%')
          .height(40)
          .backgroundColor('#FFF3E6')
          .fontColor('#B26A00')
          .enabled(!this.syncBusy)
          .onClick(() => {
            this.runAction(this.lastSyncAction);
          })
      }

      Text('同步只写本机目录 devices/<设备标识>/，不会重写其他设备的历史文件。')
        .fontSize(11)
        .fontColor($r('app.color.text_secondary'))
        .width('100%')
        .textAlign(TextAlign.Start)

      // 隐藏的 Git 运行环境：1x1、全透明，只用于执行 isomorphic-git
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
    .padding(12)
    .backgroundColor(Color.White)
    .borderRadius(12)
  }

  @Builder
  PlatformPanel() {
    Column({ space: 8 }) {
      this.Card('平台信息')
      Row() {
        Text('运行平台')
          .fontSize(13)
          .fontColor($r('app.color.text_secondary'))
        Blank()
        Text(this.platformText)
          .fontSize(13)
          .fontColor($r('app.color.text_primary'))
      }
      .width('100%')

      Row() {
        Text('手写板')
          .fontSize(13)
          .fontColor($r('app.color.text_secondary'))
        Blank()
        Text(this.handwritingText)
          .fontSize(13)
          .fontColor($r('app.color.text_primary'))
      }
      .width('100%')

      Row() {
        Text('OCR')
          .fontSize(13)
          .fontColor($r('app.color.text_secondary'))
        Blank()
        Text(this.ocrText)
          .fontSize(13)
          .fontColor($r('app.color.text_primary'))
      }
      .width('100%')

      if (this.storageHint.length > 0) {
        Text(this.storageHint)
          .fontSize(11)
          .fontColor($r('app.color.text_secondary'))
          .width('100%')
          .textAlign(TextAlign.Start)
      }
    }
    .width('100%')
    .padding(12)
    .backgroundColor(Color.White)
    .borderRadius(12)
  }

  @Builder
  AgcPanel() {
    Column({ space: 8 }) {
      this.Card('提醒权限与开放能力（AGC）')
      Text(
        '日历提醒依赖 ohos.permission.PUBLISH_AGENT_REMINDER，单应用最多 30 条；权限未获批时降级为应用内通知。\n\n' +
        '线上签名 / 真机安装步骤：\n' +
        '1. 登录 AppGallery Connect → 我的项目 → 选择本应用 →「开放能力」申请日历提醒/通知相关权限；\n' +
        '2. 审核通过后到「证书、APP ID 和 Profile」重新生成 Profile；\n' +
        '3. DevEco Studio → Project Structure → Signing Configs 勾选手动签名，导入 .p12 与 .p7b（关闭 Automatically generate signature）；\n' +
        '4. 重新安装应用，首次创建提醒时按系统弹窗授权；\n' +
        '5. 开放能力审批周期约 8 个工作日，请预留时间。\n\n' +
        '本地调试：未签名的调试包可以创建提醒但无法上架；通知通道需要用户手动允许。'
      )
        .fontSize(12)
        .fontColor($r('app.color.text_primary'))
        .width('100%')
        .textAlign(TextAlign.Start)
        .lineHeight(19)
    }
    .width('100%')
    .padding(12)
    .backgroundColor(Color.White)
    .borderRadius(12)
  }

  /** 平台单选（GitHub / Gitee）：只影响提示文案与示例。 */
  @Builder
  PlatformChooser() {
    Row({ space: 8 }) {
      Text('GitHub')
        .fontSize(14)
        .fontColor(this.gitPlatform === PLATFORM_GITHUB ? Color.White : $r('app.color.text_secondary'))
        .backgroundColor(this.gitPlatform === PLATFORM_GITHUB ? $r('app.color.brand') : Color.White)
        .borderRadius(16)
        .padding({ left: 14, right: 14, top: 6, bottom: 6 })
        .onClick(() => {
          this.pickPlatform(PLATFORM_GITHUB);
        })
      Text('Gitee')
        .fontSize(14)
        .fontColor(this.gitPlatform === PLATFORM_GITEE ? Color.White : $r('app.color.text_secondary'))
        .backgroundColor(this.gitPlatform === PLATFORM_GITEE ? $r('app.color.brand') : Color.White)
        .borderRadius(16)
        .padding({ left: 14, right: 14, top: 6, bottom: 6 })
        .onClick(() => {
          this.pickPlatform(PLATFORM_GITEE);
        })
      Blank()
      Text('只影响示例文案')
        .fontSize(11)
        .fontColor(HINT_COLOR)
    }
    .width('100%')
  }

  /** 认证方式单选（HTTPS(PAT) / SSH）。 */
  @Builder
  AuthChooser() {
    Row({ space: 8 }) {
      Text('HTTPS(PAT)')
        .fontSize(14)
        .fontColor(this.authMode === AUTH_HTTPS ? Color.White : $r('app.color.text_secondary'))
        .backgroundColor(this.authMode === AUTH_HTTPS ? $r('app.color.brand') : Color.White)
        .borderRadius(16)
        .padding({ left: 14, right: 14, top: 6, bottom: 6 })
        .onClick(() => {
          this.pickAuthMode(AUTH_HTTPS);
        })
      Text('SSH')
        .fontSize(14)
        .fontColor(this.authMode === AUTH_SSH ? Color.White : $r('app.color.text_secondary'))
        .backgroundColor(this.authMode === AUTH_SSH ? $r('app.color.brand') : Color.White)
        .borderRadius(16)
        .padding({ left: 14, right: 14, top: 6, bottom: 6 })
        .onClick(() => {
          this.pickAuthMode(AUTH_SSH);
        })
      Blank()
    }
    .width('100%')
  }

  /** 本机与仓库：设备标识 / 作者名 / 平台 / 认证方式 / 仓库地址 / token + 测试连接 + 保存。 */
  @Builder
  RepoSettingsPanel() {
    Column({ space: 8 }) {
      this.Card('本机与仓库')

      this.FieldLabel('设备标识（决定 devices/<id>/ 目录）')
      TextInput({ text: this.deviceId, placeholder: 'phone-a' })
        .width('100%')
        .height(44)
        .backgroundColor('#F7F9FB')
        .borderRadius(10)
        .onChange((value: string) => {
          this.deviceId = value;
        })
      if (this.deviceIdError.length > 0) {
        Text(this.deviceIdError)
          .fontSize(12)
          .fontColor(ERROR_COLOR)
          .width('100%')
          .textAlign(TextAlign.Start)
      }

      this.FieldLabel('作者名（写入日程 author 字段）')
      TextInput({ text: this.author, placeholder: '例如：我' })
        .width('100%')
        .height(44)
        .backgroundColor('#F7F9FB')
        .borderRadius(10)
        .onChange((value: string) => {
          this.author = value;
        })
      if (this.authorError.length > 0) {
        Text(this.authorError)
          .fontSize(12)
          .fontColor(ERROR_COLOR)
          .width('100%')
          .textAlign(TextAlign.Start)
      }

      this.FieldLabel('托管平台')
      this.PlatformChooser()

      this.FieldLabel('认证方式')
      this.AuthChooser()
      Text(authHint(this.authMode))
        .fontSize(11)
        .fontColor(HINT_COLOR)
        .width('100%')
        .textAlign(TextAlign.Start)
        .lineHeight(16)

      this.FieldLabel('仓库地址')
      TextInput({ text: this.repoUrl, placeholder: repoUrlPlaceholder(this.gitPlatform, this.authMode) })
        .width('100%')
        .height(44)
        .backgroundColor('#F7F9FB')
        .borderRadius(10)
        .onChange((value: string) => {
          this.repoUrl = value;
        })
      Text(repoUrlExamples(this.gitPlatform, this.authMode))
        .fontSize(11)
        .fontColor(HINT_COLOR)
        .width('100%')
        .textAlign(TextAlign.Start)
        .lineHeight(16)
      Text('仓库地址可以先留空（只在本机记录日程）；留空时保存不报错，但「测试连接 / 拉取 / 推送」前必须先填写。')
        .fontSize(11)
        .fontColor(HINT_COLOR)
        .width('100%')
        .textAlign(TextAlign.Start)
        .lineHeight(16)
      if (this.repoUrlError.length > 0) {
        Text(this.repoUrlError)
          .fontSize(12)
          .fontColor(ERROR_COLOR)
          .width('100%')
          .textAlign(TextAlign.Start)
      }

      Text(this.authMode === AUTH_SSH ? '访问 token（SSH 方式可留空）' : '访问 token（HTTPS 必填，仅存本机）')
        .fontSize(13)
        .fontColor($r('app.color.text_secondary'))
        .width('100%')
        .textAlign(TextAlign.Start)
      TextInput({
        text: this.token,
        placeholder: this.authMode === AUTH_SSH ? 'SSH 依赖系统 ssh-agent，可留空' : 'ghp_… / gitee token'
      })
        .type(InputType.Password)
        .width('100%')
        .height(44)
        .backgroundColor('#F7F9FB')
        .borderRadius(10)
        .onChange((value: string) => {
          this.token = value;
        })
      if (this.tokenError.length > 0) {
        Text(this.tokenError)
          .fontSize(12)
          .fontColor(ERROR_COLOR)
          .width('100%')
          .textAlign(TextAlign.Start)
      }
      Text('token 只保存在本机 preferences，不会写进同步仓库，也不会出现在日志里。')
        .fontSize(11)
        .fontColor(HINT_COLOR)
        .width('100%')
        .textAlign(TextAlign.Start)
        .lineHeight(16)

      Row({ space: 8 }) {
        Button(this.connectionBusy ? '探测中…' : '测试连接')
          .layoutWeight(1)
          .height(44)
          .backgroundColor('#E8F1FF')
          .fontColor($r('app.color.brand'))
          .enabled(!this.connectionBusy)
          .onClick(() => {
            this.testConnection();
          })
        Button('保存设置')
          .layoutWeight(1)
          .height(44)
          .backgroundColor($r('app.color.brand'))
          .fontColor(Color.White)
          .enabled(this.ready)
          .onClick(() => {
            this.saveSettings();
          })
      }
      .width('100%')

      if (this.connectionText.length > 0) {
        Text(this.connectionText)
          .fontSize(12)
          .fontColor(this.connectionText.startsWith('❌') ? ERROR_COLOR : $r('app.color.text_primary'))
          .width('100%')
          .textAlign(TextAlign.Start)
          .lineHeight(18)
      }

      if (this.saveHint.length > 0) {
        Text(this.saveHint)
          .fontSize(12)
          .fontColor(this.saveHint.startsWith('设置已保存') ? $r('app.color.brand') : ERROR_COLOR)
          .width('100%')
          .textAlign(TextAlign.Start)
      }
    }
    .width('100%')
    .padding(12)
    .backgroundColor(Color.White)
    .borderRadius(12)
  }

  /** AI 配置：DeepSeek Key / 模型名 / 测试 AI 连通性。 */
  @Builder
  AiPanel() {
    Column({ space: 8 }) {
      this.Card('AI 汇总（DeepSeek）')

      this.FieldLabel('DeepSeek API Key（仅存本机）')
      TextInput({ text: this.aiKey, placeholder: 'sk-…' })
        .type(InputType.Password)
        .width('100%')
        .height(44)
        .backgroundColor('#F7F9FB')
        .borderRadius(10)
        .onChange((value: string) => {
          this.aiKey = value;
        })
      Text('key 只保存在本机 preferences，不会写进同步仓库，也不会出现在日志里。')
        .fontSize(11)
        .fontColor(HINT_COLOR)
        .width('100%')
        .textAlign(TextAlign.Start)
        .lineHeight(16)

      this.FieldLabel('模型名')
      TextInput({ text: this.aiModel, placeholder: DEFAULT_AI_MODEL })
        .width('100%')
        .height(44)
        .backgroundColor('#F7F9FB')
        .borderRadius(10)
        .onChange((value: string) => {
          this.aiModel = value;
        })
      Text(`默认 ${DEFAULT_AI_MODEL}；留空按默认模型调用。`)
        .fontSize(11)
        .fontColor(HINT_COLOR)
        .width('100%')
        .textAlign(TextAlign.Start)
        .lineHeight(16)

      Button(this.aiTestBusy ? '测试中…' : '测试 AI 连通性')
        .width('100%')
        .height(44)
        .backgroundColor('#E8F1FF')
        .fontColor($r('app.color.brand'))
        .enabled(!this.aiTestBusy)
        .onClick(() => {
          this.testAi();
        })

      if (this.aiTestText.length > 0) {
        Text(this.aiTestText)
          .fontSize(12)
          .fontColor(this.aiTestText.startsWith('成功') ? $r('app.color.brand') : ERROR_COLOR)
          .width('100%')
          .textAlign(TextAlign.Start)
          .lineHeight(18)
      }
    }
    .width('100%')
    .padding(12)
    .backgroundColor(Color.White)
    .borderRadius(12)
  }

  /** 页面底部隐私说明。 */
  @Builder
  PrivacyFooter() {
    Text('token / AI Key 只保存在本机 preferences，不会进入同步载荷（jsonl）与日志')
      .fontSize(11)
      .fontColor(HINT_COLOR)
      .width('100%')
      .textAlign(TextAlign.Center)
  }

  build() {
    Column() {
      Row({ space: 8 }) {
        Text('‹')
          .fontSize(26)
          .fontColor($r('app.color.text_primary'))
          .padding({ left: 4, right: 4 })
          .onClick(() => {
            router.back();
          })
        Text('设置')
          .fontSize(18)
          .fontWeight(FontWeight.Bold)
          .fontColor($r('app.color.text_primary'))
          .layoutWeight(1)
      }
      .width('100%')
      .padding({ left: 12, right: 12, top: 12, bottom: 8 })

      Scroll() {
        Column({ space: 12 }) {
          this.RepoSettingsPanel()
          this.AiPanel()
          this.SyncPanel()
          this.PlatformPanel()
          this.AgcPanel()
          this.PrivacyFooter()
        }
        .width('100%')
        .padding({ left: 12, right: 12, bottom: 24 })
      }
      .layoutWeight(1)
      .width('100%')
      .align(Alignment.TopStart)
    }
    .width('100%')
    .height('100%')
    .backgroundColor($r('app.color.page_background'))
  }
}
