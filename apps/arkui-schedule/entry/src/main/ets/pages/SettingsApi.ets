/**
 * 设置子页：API 配置（mod-settings-api-page）。
 *
 * 本页是**真页面**，不再是复用到实现宿主的薄壳：自带 `PageLayout`、一层 flex、
 * 自己的 `Scroller` 与唯一主操作「保存」；AI 正文由 `components/settings/AiSection.ets`
 * 承接（presentational body，逐字复用，不在本页内联它的渲染）。
 *
 * 状态与业务方法归本页所有（不再走 `SettingsHost` 的 `section='api'` 分支）：
 * - 保存只写本页拥有的 AI 字段（aiKey / aiProviderId / aiModel / aiBaseURL 与多源 fallback
 *   三键），是 `settingsStore.save()` 的 patch —— 同步 / 主题 / 远程等键保持原值，互不覆盖；
 * - 校验仍走 `checkSettingsFields`，与拆分前逐字一致；非本页字段传静默兜底值（仓库地址留空
 *   即跳过地址 / token 校验），本页只有自定义源接口地址一处可能报错，不会有幽灵红字；
 * - 服务 / 模型两个预设下拉的弹层在本页；接口地址只在「自定义」源显示；Key 走密码框；
 * - 模型下拉列表先读上次成功缓存、再回落预设，「刷新模型列表」显式拉取服务商 `GET …/models`：
 *   失败只标注过期、不清空列表；保存但已下线的模型以「自定义 / 未知：<id>」仍可选；
 * - 没有「高级」控制，也没有手输模型名（存量手输模型名由 `modelLabel` 原样显示）；
 * - 返回键走 `router.back()` 回设置根页。
 *
 * 凭据 hygiene：AI Key 只走本机 preferences，不打印、不写日志、不进 Git 载荷。
 */
import { promptAction, router } from '@kit.ArkUI';
import { common } from '@kit.AbilityKit';
import { nowIso } from '../common/date';
import { toastMsFor } from '../common/copy';
import { DIVIDER, FONT, LINE_HEIGHT, RADIUS, SPACING, TOUCH_MIN } from '../common/uiTokens';
import { normalizeDeviceId, settingsStore } from '../services/settingsStore';
import type { ScheduleSettings, SettingsPatch } from '../services/settingsStore';
import { describeError } from '../services/scheduleStore';
import { fetchModelsOnline, testAiConnection } from '../services/deepseek';
import type { AiTestResult } from '../services/deepseek';
import { validateRepoUrl } from '../model/repoUrl';
import type { RepoUrlCheck } from '../model/repoUrl';
import {
  AUTH_HTTPS,
  FIELD_AI_BASE_URL,
  checkSettingsFields,
  describeFirstIssue,
  describeIssues
} from '../model/settingsForm';
import type { SettingsFieldIssue } from '../model/settingsForm';
import {
  AI_PROVIDERS,
  CUSTOM_PROVIDER_ID,
  DEFAULT_PROVIDER_ID,
  customModelLabel,
  defaultModelOf,
  findProvider,
  hintForProvider,
  mergeModelIds,
  modelsOf,
  supportsModelsList
} from '../model/aiProvider';
import type { AiModelOption, AiModelsCacheEntry, AiModelsKind, AiProviderPreset } from '../model/aiProvider';
import {
  DEFAULT_MAX_ATTEMPTS,
  MAX_FALLBACK_SOURCES,
  normalizeMaxAttempts,
  parseFallbackOrder,
  serializeFallbackOrder,
  sourceLabel
} from '../model/aiFallback';
import type { FallbackDiagnostic, FallbackSource, FallbackSourcePatch } from '../model/aiFallback';
import { PageLayout } from '../components/PageLayout';
import { AiSection } from '../components/settings/AiSection';

/** 底部弹层的单行高度。 */
const SHEET_ROW: number = 48;

/** 本次页面会话内最多保留几条 fallback 诊断（只在内存，不落盘、不进同步载荷）。 */
const MAX_SESSION_DIAGNOSTICS: number = 10;

/** 弹层标识：同一时刻只开一个。 */
const PANEL_NONE: string = '';
const PANEL_PROVIDER: string = 'provider';
const PANEL_MODEL: string = 'model';

@Entry
@Component
struct SettingsApi {
  // ------------------------------------------------------------------ 主表单（本页唯一可编辑的字段）
  @State aiKey: string = '';
  @State aiModel: string = '';
  /** AI 服务源 id（`model/aiProvider.ts` 的预设表）。 */
  @State aiProviderId: string = DEFAULT_PROVIDER_ID;
  /** 自定义源的接口地址；预设源下存的是预设地址快照，页面上不展示。 */
  @State aiBaseURL: string = '';
  /** 自定义源接口地址的内联错误（唯一有可见落点的 issue）。 */
  @State aiBaseUrlError: string = '';
  @State aiTestText: string = '';
  /** 失败后的一行可操作建议（成功时为空，不占行）。 */
  @State aiTestHint: string = '';
  @State aiTestBusy: boolean = false;

  // ------------------------------------------------------------------ 模型列表在线拉取（mod-ai-models-fetch）
  /** 模型下拉当前选项：预设 → 上次成功缓存 → 在线列表（id 保持服务商返回值原样）。 */
  @State aiModelOptions: AiModelOption[] = [];
  /** 列表来源 / 刷新结果的一行中文说明（含上次刷新时间或类型化失败原因）。 */
  @State modelsHint: string = '';
  /** 刷新失败但保留了缓存时为 true（界面标注「已过期」）。 */
  @State modelsStale: boolean = false;
  /** 刷新中：禁用按钮，防止并发重复请求。 */
  @State modelsBusy: boolean = false;

  // ------------------------------------------------------------------ 多源 fallback（三个持久化键 + 只留内存的诊断）
  @State aiFallbackEnabled: boolean = false;
  @State aiFallbackSources: FallbackSource[] = [];
  @State aiFallbackMaxAttempts: number = DEFAULT_MAX_ATTEMPTS;
  @State aiFallbackDiagnostics: FallbackDiagnostic[] = [];

  // ------------------------------------------------------------------ 页面壳 / 保存反馈
  @State ready: boolean = false;
  @State saveHint: string = '';
  /** 保存校验的问题汇总（「还有 N 项需要处理：…」，空串 = 无问题）。 */
  @State issuesSummary: string = '';
  /** 第一条问题的「字段名 · 原因」：横幅第二行。 */
  @State firstIssueText: string = '';
  /** 当前打开的弹层（服务 / 模型）。 */
  @State panel: string = PANEL_NONE;

  /**
   * 校验用的静默值（无输入控件，不参与渲染）：
   * 仓库地址留空时 `checkSettingsFields` 不校验地址 / token，保证本页只会出现 aiBaseURL 一处 issue。
   */
  private deviceId: string = 'phone-a';
  private author: string = '我';

  private disposed: boolean = false;
  private pageScroller: Scroller = new Scroller();

  aboutToAppear(): void {
    this.bootstrap();
  }

  aboutToDisappear(): void {
    this.disposed = true;
  }

  /** 读盘一次铺到表单；读失败给确定文案，不编造「已就绪」。 */
  private async bootstrap(): Promise<void> {
    const context = getContext(this) as common.UIAbilityContext;
    try {
      await settingsStore.init(context);
      const settings: ScheduleSettings = await settingsStore.load();
      if (this.disposed) {
        return;
      }
      this.applySettings(settings);
      // 缓存读取是本地 preferences 操作，不联网、不阻塞 UI；失败静默回落预设列表。
      await this.restoreModelsCache();
      if (this.disposed) {
        return;
      }
      this.ready = true;
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
    this.aiKey = settings.aiKey;
    this.aiProviderId = settings.aiProviderId;
    this.aiModel = settings.aiModel;
    this.aiBaseURL = settings.aiBaseURL;
    this.aiFallbackEnabled = settings.aiFallbackEnabled;
    this.aiFallbackSources = parseFallbackOrder(settings.aiFallbackOrder);
    this.aiFallbackMaxAttempts = normalizeMaxAttempts(settings.aiFallbackMaxAttempts);
    this.deviceId = settings.deviceId;
    this.author = settings.author.trim().length > 0 ? settings.author : '我';
  }

  // ------------------------------------------------------------------ 模型列表（缓存 / 在线 / 自定义条目）

  /** 预设列表快照（fetch 未跑 / 失败时的兜底，label 用预设中文名）。 */
  private applyPresetOptions(): void {
    const options: AiModelOption[] = [];
    for (const item of modelsOf(this.aiProviderId)) {
      options.push({ id: item.id, label: item.label });
    }
    this.aiModelOptions = options;
    this.modelsHint = `预设模型列表（${options.length} 个）；可点「刷新模型列表」拉取服务商最新列表`;
    this.modelsStale = false;
  }

  /** 用一组服务商返回的 id 铺列表：id 原样保留，label 也不美化。 */
  private applyFetchedIds(ids: string[], hint: string, stale: boolean): void {
    const options: AiModelOption[] = [];
    for (const id of ids) {
      options.push({ id: id, label: id });
    }
    this.aiModelOptions = options;
    this.modelsHint = hint;
    this.modelsStale = stale;
  }

  /** 上次刷新时刻的 HH:MM（坏值原样显示，不给假时间）。 */
  private shortTime(iso: string): string {
    const parsed: Date = new Date(iso);
    if (Number.isNaN(parsed.getTime())) {
      return iso;
    }
    const hh: number = parsed.getHours();
    const mm: number = parsed.getMinutes();
    return `${hh < 10 ? '0' : ''}${hh}:${mm < 10 ? '0' : ''}${mm}`;
  }

  /** 失败类型的短中文标签（详细原因由 result.message 给）。 */
  private modelsKindLabel(kind: AiModelsKind): string {
    if (kind === 'timeout') {
      return '超时';
    }
    if (kind === 'unauthorized') {
      return '密钥无效';
    }
    if (kind === 'forbidden') {
      return '无权限';
    }
    if (kind === 'malformed') {
      return '数据格式错误';
    }
    if (kind === 'empty') {
      return '空列表';
    }
    if (kind === 'config' || kind === 'network') {
      return '网络或地址';
    }
    return '请求失败';
  }

  /** 页面打开 / 换源时恢复该源的上次成功列表；没有缓存就用预设。 */
  private async restoreModelsCache(): Promise<void> {
    try {
      const context = getContext(this) as common.UIAbilityContext;
      const map = await settingsStore.loadAiModelsCache(context);
      const entry: AiModelsCacheEntry | undefined = map[this.aiProviderId];
      if (this.disposed) {
        return;
      }
      if (entry !== undefined && entry.ids.length > 0) {
        this.applyFetchedIds(
          entry.ids,
          `上次刷新 ${this.shortTime(entry.fetchedAt)} · 共 ${entry.ids.length} 个模型（离线可用）`,
          false
        );
      } else {
        this.applyPresetOptions();
      }
    } catch (error) {
      if (!this.disposed) {
        this.applyPresetOptions();
      }
    }
  }

  /** 当前下拉的选项：已拉取列表 + 保存但不在列表里的「自定义 / 未知」条目。 */
  private modelOptions(): AiModelOption[] {
    const ids: string[] = [];
    for (const item of this.aiModelOptions) {
      ids.push(item.id);
    }
    const merged: string[] = mergeModelIds(ids, this.aiModel);
    const options: AiModelOption[] = [];
    for (const id of merged) {
      let label: string = customModelLabel(id);
      for (const item of this.aiModelOptions) {
        if (item.id === id) {
          label = item.label;
          break;
        }
      }
      options.push({ id: id, label: label });
    }
    return options;
  }

  /** 「刷新模型列表」：显式动作，失败只改提示、不动已缓存列表；不打印 key。 */
  private async refreshModels(): Promise<void> {
    if (this.modelsBusy) {
      return;
    }
    const providerId: string = findProvider(this.aiProviderId).id;
    if (!supportsModelsList(providerId)) {
      this.modelsHint = '该服务不支持在线获取模型列表，继续使用预设列表';
      return;
    }
    if (providerId === CUSTOM_PROVIDER_ID && this.aiBaseURL.trim().length === 0) {
      this.modelsStale = true;
      this.modelsHint = '自定义服务需先填写接口地址，才能刷新模型列表（继续使用上次缓存）';
      return;
    }
    this.modelsBusy = true;
    this.modelsHint = '正在获取模型列表…';
    try {
      const baseURL: string = providerId === CUSTOM_PROVIDER_ID ? this.aiBaseURL : '';
      // key 只作为参数传给请求头构造，绝不写进提示 / 日志。
      const result = await fetchModelsOnline(providerId, baseURL, this.aiKey);
      if (this.disposed) {
        return;
      }
      if (result.kind === 'ok' && result.models.length > 0) {
        const context = getContext(this) as common.UIAbilityContext;
        const entry = await settingsStore.saveAiModelsCache(providerId, result.models, nowIso(), context);
        if (this.disposed) {
          return;
        }
        const at: string = entry === null ? nowIso() : entry.fetchedAt;
        this.applyFetchedIds(
          result.models,
          `已从服务商刷新 ${result.models.length} 个模型 · ${this.shortTime(at)}`,
          false
        );
      } else {
        // 失败 / 空列表：一个选项都不删，只标注缓存已过期。
        this.modelsStale = true;
        this.modelsHint = `刷新失败（${this.modelsKindLabel(result.kind)}）：${result.message}；继续使用上次缓存，可能已过期`;
      }
    } catch (error) {
      if (this.disposed) {
        return;
      }
      this.modelsStale = true;
      this.modelsHint = `刷新失败：${describeError(error)}；继续使用上次缓存，可能已过期`;
    } finally {
      if (!this.disposed) {
        this.modelsBusy = false;
      }
    }
  }

  // ------------------------------------------------------------------ 保存（本页唯一主操作）

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
    // 换源后列表跟着换：优先该源上次成功缓存，没有则回落预设（不联网）。
    this.restoreModelsCache();
  }

  private pickModel(id: string): void {
    this.aiModel = id;
    this.panel = PANEL_NONE;
  }

  private isCustomProvider(): boolean {
    return this.aiProviderId === CUSTOM_PROVIDER_ID;
  }

  /** 把校验问题摊到本页唯一可见落点；无落点的问题不计入横幅（不造幽灵报错）。 */
  private applyIssues(issues: SettingsFieldIssue[]): void {
    this.aiBaseUrlError = '';
    const applied: SettingsFieldIssue[] = [];
    for (const issue of issues) {
      if (issue.field === FIELD_AI_BASE_URL) {
        // 接口地址行在自定义源下常驻显示，红字直接落在它下方
        this.aiBaseUrlError = issue.message;
      } else {
        // 设备标识 / 作者名 / 仓库地址 / token 不在本页编辑：校验入口传的是静默兜底值，
        // 这类 issue 不可达；万一模型侧新增了无落点的字段，宁可不计入横幅。
        continue;
      }
      applied.push(issue);
    }
    this.issuesSummary = describeIssues(applied.length > 0 || issues.length === 0 ? applied : issues);
    this.firstIssueText = applied.length > 0 ? describeFirstIssue(applied) : '';
  }

  /** 保存：整表校验（与拆分前同一入口），通过后只写本页拥有的 AI 字段。 */
  private async saveSettings(): Promise<void> {
    const silentAuthor: string = this.author.trim().length > 0 ? this.author.trim() : '我';
    const repoCheck: RepoUrlCheck = validateRepoUrl('');
    const issues: SettingsFieldIssue[] = checkSettingsFields(
      {
        deviceId: normalizeDeviceId(this.deviceId),
        author: silentAuthor,
        repoUrl: '',
        token: '',
        authMode: AUTH_HTTPS,
        savedToken: '',
        customProvider: this.isCustomProvider(),
        aiModel: this.aiModel,
        aiBaseURL: this.aiBaseURL
      },
      repoCheck
    );
    this.applyIssues(issues);
    const blocking: boolean = this.issuesSummary.length > 0;
    if (blocking) {
      this.saveHint = this.issuesSummary;
      this.pageScroller.scrollEdge(Edge.Top);
      return;
    }
    const context = getContext(this) as common.UIAbilityContext;
    try {
      // 字段作用域：本页只写 AI 字段；同步 / 主题 / 远程等键不传 = `save()` 保持原值。
      const patch: SettingsPatch = {
        aiKey: this.aiKey,
        aiProviderId: this.aiProviderId,
        aiModel: this.aiModel,
        aiBaseURL: this.aiBaseURL,
        // 备用源的共用 key（`aiFallbackKey`）不传——不传即保留 preferences 里的原值。
        aiFallbackEnabled: this.aiFallbackEnabled,
        aiFallbackMaxAttempts: normalizeMaxAttempts(this.aiFallbackMaxAttempts),
        aiFallbackOrder: serializeFallbackOrder(this.aiFallbackSources)
      };
      const saved = await settingsStore.save(patch, context);
      if (this.disposed) {
        return;
      }
      this.applySettings(saved);
      this.issuesSummary = '';
      this.firstIssueText = '';
      this.saveHint = `设置已保存（${nowIso()}）`;
      promptAction.showToast({ message: '设置已保存', duration: toastMsFor(false) });
    } catch (error) {
      if (this.disposed) {
        return;
      }
      this.saveHint = `保存失败：${describeError(error)}`;
    }
  }

  // ------------------------------------------------------------------ 测试 AI

  /** 「测试」：用最小 prompt 调一次当前源，结果只显示一行。 */
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

  /** 主源的展示名（`AiFallbackPanel` 的 `primaryLabel`）。 */
  private primarySourceLabel(): string {
    const primary: FallbackSource = { providerId: this.aiProviderId, modelId: this.aiModel };
    return sourceLabel(primary);
  }

  /** 新增备用源的初值：优先挑「既不是主源、也还没被用过」的预设源。 */
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

  /** 添加备用源（满 `MAX_FALLBACK_SOURCES` 个就不再加）。 */
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

  /** 删除第 `index` 个备用源（越界直接忽略）。 */
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

  /** 改写第 `index` 个备用源的一个或多个字段（ArkTS 不支持对象展开，逐字段重建）。 */
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

  /** 尝试次数归一（备用源增减后重新夹一次）。 */
  private clampMaxAttempts(): void {
    this.aiFallbackMaxAttempts = normalizeMaxAttempts(this.aiFallbackMaxAttempts);
  }

  /**
   * 记一条 fallback 诊断：只保留本次页面会话内最近 `MAX_SESSION_DIAGNOSTICS` 条，
   * 不落盘、不进同步载荷，页面销毁后自然消失。
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

  // ------------------------------------------------------------------ 装配

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

  /** 弹层标题行（服务 / 模型选择共用）。 */
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
          this.modelOptions(),
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
      this.PickerSheet()
    }
    .width('100%')
    .padding(SPACING.lg)
    .backgroundColor($r('app.color.surface'))
    .borderRadius({ topLeft: RADIUS.md, topRight: RADIUS.md })
  }

  build() {
    Stack({ alignContent: Alignment.TopStart }) {
      PageLayout({
        title: 'API 配置',
        subtitle: this.saveHint.length > 0 ? this.saveHint : '',
        onBack: () => {
          router.back();
        }
      }) {
        // 一层 flex：内容 Scroll 吃余量 + 底部唯一「保存」；没有嵌套固定高度外壳。
        Column({ space: SPACING.md }) {
          Scroll(this.pageScroller) {
            Column({ space: SPACING.xl }) {
              this.IssuesBanner()
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
                modelsHint: this.modelsHint,
                modelsStale: this.modelsStale,
                modelsBusy: this.modelsBusy,
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
                onRefreshModels: (): void => {
                  this.refreshModels();
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

      // 服务 / 模型弹层：同一时刻只开一层，点 scrim 关闭。
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
    .backgroundColor($r('app.color.page_background'))
  }
}
