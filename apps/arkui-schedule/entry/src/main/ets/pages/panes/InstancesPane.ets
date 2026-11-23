/**
 * 远程 DSH 面板（mod-shell-instances-pane / mod-instances-pane-readonly）：
 * 同一个组件服务两种形态，由 `configurable` 一处开关分叉。
 *
 * - `configurable = false`（默认，首页「远程 DSH」分段）：**只用来用**——远程行
 *   （名称 + 方式徽章 + 可达三态 + 相对 lastSeen + 二次打码 URL）/「打开」/
 *   typed 问题行 / 空态 / 播种迁移。没有添加实例、编辑、删除，也没有内联地址 / 令牌 /
 *   方式表单；所有配置动作都回到「设置 → 远程实例」。
 *   产品决定（`mod-instances-drop-local`）：平板不跑原生 DSH，没有本机实例行；空表是正常首用状态。
 * - `configurable = true`（设置 → 远程实例路由 `pages/Instances`）：**配置落点**——
 *   在上面「用」的能力之外，保留页头「添加实例」、行内「编辑 / 删除」、添加 / 编辑表单
 *   与空态「添加实例」。
 *
 * `Home.ets` 的分段装配不传 `configurable`，走默认 false，因此首页面板天然只读、不必改 Home；
 * `pages/Instances.ets` 显式传 `true`，设置入口看到的仍是原来的完整配置页。
 *
 * 对外契约（Home 的四面板装配）：
 *   - `deepLinkId: string`：深链携带的实例 id，预留给「按 id 打开指定实例」，当前不消费；
 *   - `active: boolean`：由 Home 按当前分段传入，根 Scroll 据此在 Visible / Hidden 间切换；
 *     Hidden 留在树上，@State / 滚动位置不丢；
 *   - `configurable: boolean`：默认 false（只读用），设置路由传 true（可配置）。
 *
 * 令牌纪律不变：只渲染 store.redacted() 的视图，URL 再过 redactUrl()；配置表单的令牌
 * 只在保存时经 typed upsert 进 store，从不进 Text / 日志。
 *
 * 布局纪律：根 Scroll + 自带分段页头，没有固定高度 Column 包裹层；行内名称 / 页头标题的
 * layoutWeight(1) 只是省略号，不是整页的第二层 flex 切分（整页唯一的切分在 Home.build()）。
 */
import { promptAction, router } from '@kit.ArkUI';
import { common, Want } from '@kit.AbilityKit';
import { ActionButton } from '../../components/ActionButton';
import { EmptyState } from '../../components/state/EmptyState';
import { DIVIDER, FONT, LINE_HEIGHT, RADIUS, SPACING, TOUCH_MIN } from '../../common/uiTokens';
import {
  instanceIdFromUrl,
  normalizeInstance,
  problemText,
  redactUrl
} from '../../model/instances';
import type { DsInstance, InstanceProblem, RawInstance, RedactedInstance } from '../../model/instances';
import { reachabilityLabel, relativeLastSeen } from '../../model/instanceSeed';
import { REMOTE_MODE_LAN, REMOTE_MODE_ORDER, findRemoteMode } from '../../model/remoteAccess';
import { mergeRemoteToken, normalizeRemoteUrl, routeToRemote, stripRemoteToken } from '../../model/remoteUrl';
import { FIRST_PAIRING_DETAIL, FIRST_PAIRING_WORDING } from '../../model/remoteAnnounceRefresh';
import type { AnnounceRefreshOutcome, AnnounceRefreshState } from '../../model/remoteAnnounceRefresh';
import { badgeOf, canShowFingerprint } from '../../model/pairingBadge';
import {
  REMOTE_OUTCOME_KEY,
  decodeRemoteOutcome,
  shouldApplyOutcome
} from '../../model/remoteOutcome';
import type { RemoteOutcome } from '../../model/remoteOutcome';
import { instanceStore } from '../../services/instanceStore';
import { tcpConnectProbe } from '../../services/pairingProbeService';
import { remoteAnnounceRefreshService } from '../../services/remoteAnnounceRefresh';
import { settingsStore } from '../../services/settingsStore';
import { describeError } from '../../services/scheduleStore';

/** 系统浏览器的 dataability 动作（空态次操作「用浏览器打开」兜底）。 */
const ACTION_VIEW_DATA: string = 'ohos.want.action.viewData';

/** 空态文案：§1 逐字口径（标题 + 指引 + 主操作 + 次操作）。 */
const EMPTY_TITLE: string = '还没有可管理的 DSH 实例';
const EMPTY_DETAIL: string =
  '在电脑 DSH → 远程访问 → 启动并点「显示二维码与链接」，把地址粘进来；添加一个远程实例即可开始';
/** 可配置模式（设置 → 远程实例）的空态主操作：就地展开添加表单。 */
const EMPTY_ACTION: string = '添加实例';
/** 只读模式（首页远程 DSH 面板）的空态主操作：只导航，不在首页展开配置。 */
const EMPTY_ACTION_READONLY: string = '去设置添加实例';
const EMPTY_SECONDARY: string = '用浏览器打开';

/** 只读面板跳到配置唯一落点：设置根页的「远程实例」行指向同一个路由。 */
const ROUTE_INSTANCES: string = 'pages/Instances';

/** 面板模式：空 = 收起；`add` = 添加实例；`edit` = 编辑当前行（仅 configurable=true 可进入）。 */
const PANEL_ADD: string = 'add';
const PANEL_EDIT: string = 'edit';

/**
 * 公告结果行的展示种类：与文案一起显式设置，不从其它字段反推。
 * 成功 / 无公告没有可确认的事，因此不渲染 CTA；只有不可信与首配各有自己的 CTA。
 */
type AnnounceNoticeKind = '' | 'success' | 'refusal' | 'first-pairing' | 'no-announcement';

@Component
export struct InstancesPane {
  /** 深链 id：预留给后续按 id 打开指定实例。 */
  @Prop deepLinkId: string = '';
  /** 保活可见性：Home 当前分段为 instances 时传 true。 */
  @Prop active: boolean = true;
  /**
   * 配置模式：默认 false = 首页「远程 DSH」面板（只用不配置）；
   * 设置路由 pages/Instances 传 true = 保留添加 / 编辑 / 删除 / 地址·令牌·方式表单。
   */
  @Prop configurable: boolean = false;

  /** 实例真身（只供打开 / 配置取 token / 原值，不直接进 Text）。 */
  @State rows: DsInstance[] = [];
  /** 渲染视图：结构上没有 token，URL 已由 store 的 `redacted()` 打码。 */
  @State views: RedactedInstance[] = [];
  /** 存储 typed 问题码（坏信封 / 存储不可用）。 */
  @State problem: InstanceProblem = 'ok';
  /** 首次加载中（避免闪一帧空态）。 */
  @State loading: boolean = true;
  /** 添加 / 编辑面板模式（只读模式恒为空串）。 */
  @State panelMode: string = '';
  /** 正在编辑的 id（添加时空串）。 */
  @State formId: string = '';
  /** 表单：名称 / 地址 / 方式（仅 configurable=true 可见；所有实例都是远程）。 */
  @State formName: string = '';
  @State formUrl: string = '';
  @State formMode: string = REMOTE_MODE_LAN;
  /** 表单错误文案（中文，永不回显 token）。 */
  @State formError: string = '';
  /** 公告刷新结果文案（空串 = 不显示；不可信时逐字显示 KEEP_WORDING，永不回显地址）。 */
  @State announceNotice: string = '';
  /** 触发刷新的实例 id：失败时「手动确认」据此打开对应配置，成功时清空。 */
  @State announceNoticeId: string = '';
  /** 结果行种类（显式设置，决定颜色 / 后果说明 / CTA，绝不由其它字段猜）。 */
  @State announceNoticeKind: AnnounceNoticeKind = '';
  /** 手动配对粘贴框原文（bearer secret，只在 addByPairing() 内交给 store，不进日志 / 不回显）。 */
  @State pairingText: string = '';
  /** 手动配对的 typed 错误中文文案（固定原因，永不含 token / 地址 / 指纹的值）。 */
  @State pairingError: string = '';
  /** 正在做 ≤3 s 的 TCP 探活：按钮进入 busy，防重复点击；探针全程异步不卡 UI 线程。 */
  @State pairingBusy: boolean = false;
  /**
   * mod-pairing-badge-truth：远程打开终局的**唯一消费者**。
   * 本面板是保活 @Component，`onPageShow()` 永远不会被框架调用，Home 也不传刷新 tick，
   * 所以必须靠 AppStorage 绑定 + @Watch 在面板存活期间直接驱动；一次性标记读后即清。
   */
  @StorageLink(REMOTE_OUTCOME_KEY) @Watch('onRemoteOutcome') lastOutcome: string = '';

  /**
   * 首配提案（非 @State：候选地址是 capability，绝不进页面响应式状态 / 日志）。
   * 只有用户点「确认信任该公告」才把它交给服务的 confirmFirstPairing()。
   */
  private pendingAnnounce: AnnounceRefreshOutcome | null = null;
  /** 首配提案对应的实例 id（非秘密，仅用于取回真身）。 */
  private pendingViewId: string = '';
  /** 页面是否已销毁（异步 bootstrap 回来后不再 setState）。 */
  private disposed: boolean = false;
  /** 下拉框顺序与 `REMOTE_MODE_ORDER` 同源。 */
  private modeOptions: string[] = REMOTE_MODE_ORDER.slice();

  aboutToAppear(): void {
    this.bootstrap();
  }

  aboutToDisappear(): void {
    this.disposed = true;
  }

  onPageShow(): void {
    if (!this.disposed) {
      this.reload();
    }
  }

  /**
   * 远程结果标记的一次性消费者（mod-pairing-badge-truth）。
   *
   * 与 `onPageShow()` 无关：本面板保活，框架不会调用它自己的 `onPageShow`，
   * Home 也没有传 tick；结果一到 AppStorage，@StorageLink + @Watch 就会在这里触发。
   * 空串直接返回——这同时挡住「清空标记」回写引起的二次 watch。
   * 坏 / 异 id / 陈旧标记 fail-closed：清掉标记、不动任何行。
   */
  onRemoteOutcome(): void {
    const raw: string = this.lastOutcome;
    if (raw.length === 0) {
      return;
    }
    const outcome: RemoteOutcome | null = decodeRemoteOutcome(raw);
    // 坏信封 / 异 id（行不在本面板实例表里）⇒ fail-closed，不落任何标记
    if (outcome !== null && this.fullOf(outcome.instanceId) !== null) {
      const nowMs: number = Date.now();
      if (shouldApplyOutcome(outcome, outcome.instanceId, nowMs)) {
        instanceStore.markReachable(outcome.instanceId, outcome.status, nowMs);
        this.reload();
      }
    }
    // 恰好清一次：无论应用与否都收口，重复 watch 不会重复处理（与 home.lastSaved 同口径）
    AppStorage.setOrCreate<string>(REMOTE_OUTCOME_KEY, '');
  }

  // ------------------------------------------------------------------ 数据

  /** 读一次旧设置做幂等播种（只迁远程地址）；读失败也照常播种空迁移、不算失败。 */
  private async bootstrap(): Promise<void> {
    try {
      const settings = await settingsStore.load(getContext(this) as common.UIAbilityContext);
      if (!this.disposed) {
        instanceStore.ensureSeeded({
          remoteUrl: settings.remoteUrl,
          remoteLastOk: settings.remoteLastOk,
          remoteMode: settings.remoteMode,
          // 旧令牌与地址分开存，必须一并迁进实例行（mod-settings-remote-dedupe）
          remoteToken: settings.remoteToken
        });
      }
    } catch (error) {
      // 设置读不到不影响实例表：按空迁移播种（不加任何实例），不在 UI 回显错误细节
      if (!this.disposed) {
        instanceStore.ensureSeeded({ remoteUrl: '', remoteLastOk: '', remoteMode: '', remoteToken: '' });
      }
    }
    if (!this.disposed) {
      this.reload();
    }
  }

  /** 内存镜像 → 两组状态：真身给动作、打码视图给渲染。 */
  private reload(): void {
    this.rows = instanceStore.list();
    this.views = instanceStore.redacted();
    this.problem = instanceStore.lastProblem();
    this.loading = false;
  }

  /** 按 id 取真身（拼打开地址 / 令牌；徽章只读它的 pin / 可达 / scheme，绝不读令牌）。 */
  private fullOf(id: string): DsInstance | null {
    for (const item of this.rows) {
      if (item.id === id) {
        return item;
      }
    }
    return null;
  }

  /** 徽章唯一出口：把真身交给纯函数，视图不自己拼「已配对 / 未配对」文案。 */
  private badgeFor(view: RedactedInstance): string {
    const full: DsInstance | null = this.fullOf(view.id);
    return full === null ? '' : badgeOf(full);
  }

  /** 指纹行与徽章共用判据：http 行即便误存 pin 也不展示「已固定指纹」。 */
  private hasPinFor(view: RedactedInstance): boolean {
    const full: DsInstance | null = this.fullOf(view.id);
    return full !== null && canShowFingerprint(full);
  }

  /**
   * 地址不再应答时的显式恢复动作（唯一的公告消费者入口）：
   * 从同步仓库工作副本只读公告 → 四步验证。有 pin 且全过才直接改地址；
   * 没有 pin 时只生成首配提案（零写入），等用户点「确认信任该公告」再落锚点 + 地址。
   * 不轮询、不后台定时器、不在 aboutToAppear / onPageShow 自动触发（HarmonyOS 后台限制见
   * docs/TAILCAT-HARMONYOS-SPIKE.md）；服务吞异常，这里不写 try/catch 也不抛到 UI 线程。
   */
  /** 由服务返回的 typed 状态映射展示种类；不从 pendingAnnounce / noticeId 反推。 */
  private noticeKindOf(state: AnnounceRefreshState): AnnounceNoticeKind {
    if (state === 'refreshed') {
      return 'success';
    }
    if (state === 'first-pairing-pending' || state === 'awaiting-consent') {
      return 'first-pairing';
    }
    if (state === 'no-announcement') {
      return 'no-announcement';
    }
    return 'refusal';
  }

  private refreshAddressFromAnnouncement(view: RedactedInstance): void {
    const full: DsInstance | null = this.fullOf(view.id);
    if (full === null) {
      return;
    }
    remoteAnnounceRefreshService.init(getContext(this) as common.UIAbilityContext);
    const outcome = remoteAnnounceRefreshService.refresh(full);
    // 只取文案 / 状态：outcome.newUrl 是地址，不进 @State、不进日志
    if (outcome.state === 'first-pairing-pending') {
      this.pendingAnnounce = outcome;
      this.pendingViewId = view.id;
      this.announceNotice = FIRST_PAIRING_WORDING;
    } else {
      this.pendingAnnounce = null;
      this.pendingViewId = '';
      this.announceNotice = outcome.wording;
    }
    this.announceNoticeId = outcome.state === 'refreshed' ? '' : view.id;
    this.announceNoticeKind = this.noticeKindOf(outcome.state);
    this.reload();
  }

  /**
   * 首配的**唯一**确认出口（与「手动确认」是不同按钮、不同语义）：
   * 只有这里会把提案交给服务的 confirmFirstPairing()；取消 / 关闭页面都让提案自然作废，
   * 不写 pin、不改地址。已有 pin 时服务 typed 拒绝，按钮永不复用成换钥入口。
   */
  private confirmFirstPairing(): void {
    const pending: AnnounceRefreshOutcome | null = this.pendingAnnounce;
    const id: string = this.pendingViewId;
    if (pending === null || id.length === 0) {
      return;
    }
    const full: DsInstance | null = this.fullOf(id);
    if (full === null) {
      return;
    }
    const outcome = remoteAnnounceRefreshService.confirmFirstPairing(full, pending);
    this.pendingAnnounce = null;
    this.pendingViewId = '';
    this.announceNotice = outcome.wording;
    this.announceNoticeId = outcome.state === 'refreshed' ? '' : id;
    this.announceNoticeKind = this.noticeKindOf(outcome.state);
    this.reload();
  }

  /** 「手动确认」出口：设置页就地打开对应行的编辑表单，首页回到设置配置落点。 */
  private confirmAnnounceManually(): void {
    if (this.configurable) {
      for (const view of this.views) {
        if (view.id === this.announceNoticeId) {
          this.showEdit(view);
          return;
        }
      }
      return;
    }
    this.openInstanceConfig();
  }

  /** 方式徽章：六种枚举给中文标签，未知值原样显示（不猜、不回落）。 */
  private modeLabel(mode: string): string {
    const spec = findRemoteMode(mode);
    return spec === null ? mode : spec.label;
  }

  /** 表单下拉选项（顺序 = REMOTE_MODE_ORDER，标签取自唯一的枚举元数据表）。 */
  private modeSelectOptions(): SelectOption[] {
    const options: SelectOption[] = [];
    for (const mode of this.modeOptions) {
      options.push({ value: this.modeLabel(mode) });
    }
    return options;
  }

  /** 当前方式在下拉里的下标（未知值按第 0 项，保证 `Select.selected` 合法）。 */
  private modeIndex(): number {
    const index: number = this.modeOptions.indexOf(this.formMode);
    return index >= 0 ? index : 0;
  }

  // ------------------------------------------------------------------ 动作

  /**
   * 打开：复用 `RemoteControl` 的内嵌 Web。所有实例都是远程，把 base 与一次性 token 现拼；
   * 真身缺失时不塞空地址（不再有回退到旧设置的本机分支）。
   *
   * mod-pairing-badge-truth：**导航成功不是可达性**，因此 pushUrl 成功不再写 ok，
   * 行保持 unknown，直到 `RemoteControl` 的一次性结果标记经 `onRemoteOutcome` 回写；
   * 跳转本身抛错仍立即记 fail（这不是「页面加载完成」的证据，是连接尝试失败的证据）。
   */
  private openInstance(view: RedactedInstance): void {
    const full: DsInstance | null = this.fullOf(view.id);
    const params: Record<string, string> = {};
    if (full !== null) {
      const token: string = full.token === undefined ? '' : full.token;
      const url: string = mergeRemoteToken(full.url, token);
      if (url.length > 0) {
        params['url'] = url;
      }
    }
    router
      .pushUrl({ url: routeToRemote(), params: params })
      .catch((): void => {
        instanceStore.markReachable(view.id, 'fail', Date.now());
        this.reload();
      });
  }

  /**
   * 只读面板的统一配置出口：不在这里展开表单，回到设置根页的「远程实例」行。
   * 空态主操作与问题行「去设置添加实例」共用这一条；设置路由本身是 configurable=true，
   * 不会走到这里，避免自跳。
   */
  private openInstanceConfig(): void {
    router.pushUrl({ url: ROUTE_INSTANCES }).catch((error: Error) => {
      promptAction.showToast({ message: `打开实例设置失败：${describeError(error)}`, duration: 3000 });
    });
  }

  /** 打开添加面板（仅 configurable=true 的空态 / 错误行调用）。 */
  private showAdd(): void {
    this.panelMode = PANEL_ADD;
    this.formId = '';
    this.formName = '';
    this.formUrl = '';
    this.formMode = REMOTE_MODE_LAN;
    this.formError = '';
  }

  /** 打开编辑面板：远程行带名称 + 地址 + 方式（没有本机只改名的特例）。 */
  private showEdit(view: RedactedInstance): void {
    const full: DsInstance | null = this.fullOf(view.id);
    this.panelMode = PANEL_EDIT;
    this.formId = view.id;
    this.formName = view.name;
    this.formUrl = full === null ? '' : full.url;
    this.formMode = view.mode;
    this.formError = '';
  }

  /** 面板下拉：下标 → 六方式枚举。 */
  private pickMode(index: number): void {
    if (index >= 0 && index < this.modeOptions.length) {
      this.formMode = this.modeOptions[index];
    }
  }

  /** 保存：先归一（旧裸地址补 http://），再交给 store 的 typed upsert；坏值只出中文原因。 */
  private submitForm(): void {
    const name: string = this.formName.trim();
    if (name.length === 0) {
      this.formError = '实例名称不能为空';
      return;
    }
    const check = normalizeRemoteUrl(this.formUrl.trim());
    if (!check.ok) {
      this.formError = `地址不可用：${check.reason}`;
      return;
    }
    const id: string = instanceIdFromUrl(check.url);
    if (id.length === 0) {
      this.formError = '地址不可用：请填写完整的 http(s) 地址';
      return;
    }
    const existing: DsInstance | null = this.fullOf(this.formId);
    const raw: RawInstance = {
      id: id,
      name: name,
      url: check.url,
      mode: this.formMode,
      reachable: existing === null ? 'unknown' : existing.reachable
    };
    if (existing !== null && existing.token !== undefined && existing.token.length > 0) {
      raw.token = existing.token;
    }
    if (existing !== null && existing.lastSeen !== undefined && existing.lastSeen > 0) {
      raw.lastSeen = existing.lastSeen;
    }
    const result = normalizeInstance(raw);
    if (!result.ok || result.instance === null) {
      this.formError = result.reason;
      return;
    }
    // 改地址 = 换 id：先删旧行再落新行，避免列表里同时留两条
    if (this.panelMode === PANEL_EDIT && id !== this.formId) {
      instanceStore.remove(this.formId);
    }
    instanceStore.upsert(result.instance);
    this.panelMode = '';
    this.reload();
  }

  /**
   * 手动配对（与签名公告的两步同意是**不同路径**）：粘贴电脑面板给出的
   * `DSHDOTS1|…` 或规范 JSON，端口 / 令牌随串带好，不用手输。
   *
   * mod-pairing-reachability：写表前先做一次真实短超时 TCP 探活（≤3 s，Promise 异步不卡 UI）。
   * 探针失败 ⇒ typed 原因逐字上屏、**粘贴框原文保留**供改端口重试，整表零写入、不产行、不写 pin；
   * 探针通过才由 store 的 TOFU 门禁落表，成功提示逐字说明「地址可达、证书未校验」：
   * TCP 可达只是传输层事实，不冒充证书指纹已校验的身份真实性。
   * 绝不把 token 拼进任何提示 / 日志；冲突时旧 pin 与旧地址不动。
   */
  private async addByPairing(): Promise<void> {
    if (this.pairingBusy) {
      return;
    }
    const text: string = this.pairingText.trim();
    if (text.length === 0) {
      this.pairingError = '请先粘贴电脑面板生成的配对串';
      return;
    }
    this.pairingBusy = true;
    this.pairingError = '';
    try {
      const result = await instanceStore.addByPairing(text, tcpConnectProbe);
      if (!result.ok) {
        // 失败保留粘贴原文（与 sync-repo 保存同一口径）：改端口 / 地址后可直接重试。
        this.pairingError = result.reason;
        return;
      }
      this.pairingText = '';
      promptAction.showToast({ message: result.reason, duration: 3000 });
      this.reload();
    } finally {
      if (!this.disposed) {
        this.pairingBusy = false;
      }
    }
  }

  /** 删除任意远程行（没有受保护的本机行）；删完立刻重读内存镜像，空表不回补实例。 */
  private deleteInstance(view: RedactedInstance): void {
    instanceStore.remove(view.id);
    this.reload();
  }

  /**
   * 空态次操作：把旧设置里的 DSH 地址交给系统浏览器；没填就说明原因，不假装能开。
   *
   * 令牌出口边界：`settingsStore.cached().remoteUrl` 可能带 `?token=` / `?k=`，
   * 绝不能把它直接交给 `Want.uri`（Intent / 浏览器历史会留明文令牌）。这里复用
   * `stripRemoteToken()` 整对删掉令牌参数后再拼 `Want`——与 `remoteShowLink`
   * 「用户显式出口才出明文」的纪律一致；URL 本身没有令牌时逐字不变。
   */
  private async openInBrowser(): Promise<void> {
    const cached = settingsStore.cached();
    const raw: string = cached === null ? '' : cached.remoteUrl.trim();
    if (raw.length === 0) {
      promptAction.showToast({ message: '先在设置里填写电脑上的 DSH 地址', duration: 3000 });
      return;
    }
    const url: string = stripRemoteToken(raw); // 唯一进 Want.uri 的地址：已去令牌
    try {
      const context = getContext(this) as common.UIAbilityContext;
      const want: Want = { action: ACTION_VIEW_DATA, uri: url };
      await context.startAbility(want);
    } catch (error) {
      promptAction.showToast({ message: `打开浏览器失败：${describeError(error)}`, duration: 3000 });
    }
  }

  // ------------------------------------------------------------------ 渲染

  /**
   * 分段页头：左标题（省略号）+ pane 专属动作——「添加实例」只在可配置模式出现；
   * 只读页头只有标题，没有任何跨节导航（换段只走 ShellRail，云端对话等分段由轨负责）。
   */
  @Builder
  Header() {
    Row() {
      Text('远程 DSH')
        .fontSize(FONT.title)
        .lineHeight(LINE_HEIGHT.title)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('app.color.text_primary'))
        .layoutWeight(1)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
      if (this.configurable) {
        Text('添加实例')
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.brand'))
          .height(TOUCH_MIN)
          .padding({ left: SPACING.sm, right: SPACING.sm })
          .onClick(() => {
            this.showAdd();
          })
      }
    }
    .width('100%')
    .alignItems(VerticalAlign.Center)
    .border({ width: { bottom: DIVIDER }, color: $r('app.color.divider') })
  }

  /**
   * 空态：§1 的逐字标题 + 指引 + 次操作「用浏览器打开」两种模式共用；
   * 主操作分叉——可配置就地「添加实例」，只读「去设置添加实例」跳设置路由。
   */
  @Builder
  EmptyView() {
    Column({ space: SPACING.sm }) {
      if (this.configurable) {
        EmptyState({
          title: EMPTY_TITLE,
          detail: EMPTY_DETAIL,
          actionLabel: EMPTY_ACTION,
          compact: false,
          onAction: (): void => {
            this.showAdd();
          }
        })
      } else {
        EmptyState({
          title: EMPTY_TITLE,
          detail: EMPTY_DETAIL,
          actionLabel: EMPTY_ACTION_READONLY,
          compact: false,
          onAction: (): void => {
            this.openInstanceConfig();
          }
        })
      }
      ActionButton({
        label: EMPTY_SECONDARY,
        actionEnabled: true,
        disabledReason: '',
        busy: false,
        variant: 'secondary',
        block: true,
        onTap: (): void => {
          this.openInBrowser();
        },
        onBlockedTap: null
      })
    }
    .width('100%')
  }

  /** 存储问题行：typed 原因逐字上屏；恢复动作两种模式共用同一个出口选择。 */
  @Builder
  ProblemRow() {
    if (this.problem !== 'ok') {
      Column({ space: SPACING.xs }) {
        Text(problemText(this.problem))
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.danger'))
          .width('100%')
          .textAlign(TextAlign.Start)
        if (this.configurable) {
          ActionButton({
            label: '重新添加',
            actionEnabled: true,
            disabledReason: '',
            busy: false,
            variant: 'secondary',
            block: false,
            onTap: (): void => {
              this.showAdd();
            },
            onBlockedTap: null
          })
        } else {
          ActionButton({
            label: '去设置添加实例',
            actionEnabled: true,
            disabledReason: '',
            busy: false,
            variant: 'secondary',
            block: false,
            onTap: (): void => {
              this.openInstanceConfig();
            },
            onBlockedTap: null
          })
        }
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
      .padding(SPACING.md)
      .backgroundColor($r('app.color.warning_soft'))
      .borderRadius(RADIUS.sm)
    }
  }

  /**
   * 公告结果行：严格按 announceNoticeKind 渲染，颜色 / 后果说明 / CTA 都由种类决定。
   * - success / no-announcement：中性色 + **没有 CTA**（没有需要用户确认的事）；
   * - refusal：danger 色 + 「手动确认」（只走手动改地址，绝不写 pin）；
   * - first-pairing：中性色 + 后果说明 + 「确认信任该公告」（唯一信任锚点写入路径）。
   */
  @Builder
  AnnounceNoticeRow() {
    if (this.announceNotice.length > 0 && this.announceNoticeKind.length > 0) {
      Column({ space: SPACING.xs }) {
        Text(this.announceNotice)
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor(this.announceNoticeKind === 'refusal' ? $r('app.color.danger') : $r('app.color.text_secondary'))
          .width('100%')
          .textAlign(TextAlign.Start)
        if (this.announceNoticeKind === 'first-pairing') {
          Text(FIRST_PAIRING_DETAIL)
            .fontSize(FONT.caption)
            .lineHeight(LINE_HEIGHT.caption)
            .fontColor($r('app.color.text_secondary'))
            .width('100%')
            .textAlign(TextAlign.Start)
          ActionButton({
            label: '确认信任该公告',
            actionEnabled: true,
            disabledReason: '',
            busy: false,
            variant: 'secondary',
            block: false,
            onTap: (): void => {
              this.confirmFirstPairing();
            },
            onBlockedTap: null
          })
        }
        if (this.announceNoticeKind === 'refusal') {
          ActionButton({
            label: '手动确认',
            actionEnabled: true,
            disabledReason: '',
            busy: false,
            variant: 'secondary',
            block: false,
            onTap: (): void => {
              this.confirmAnnounceManually();
            },
            onBlockedTap: null
          })
        }
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
      .padding(SPACING.md)
      .backgroundColor($r('app.color.warning_soft'))
      .borderRadius(RADIUS.sm)
    }
  }

  /** 单行：名称 / 方式 / 三态 + 相对时间 / 打码 URL /「打开」；编辑·删除只在可配置模式。 */
  @Builder
  InstanceRow(view: RedactedInstance) {
    Column({ space: SPACING.xs }) {
      Row({ space: SPACING.sm }) {
        Text(view.name)
          .fontSize(FONT.body)
          .lineHeight(LINE_HEIGHT.body)
          .fontColor($r('app.color.text_primary'))
          .layoutWeight(1)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .textAlign(TextAlign.Start)
        Text(this.modeLabel(view.mode))
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
          .flexShrink(0)
          .maxLines(1)
        Text(reachabilityLabel(view.reachable))
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor(view.reachable === 'fail' ? $r('app.color.danger') : $r('app.color.text_secondary'))
          .flexShrink(0)
          .maxLines(1)
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      Text(`${reachabilityLabel(view.reachable)} · ${relativeLastSeen(view.lastSeen, Date.now())}`)
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontColor($r('app.color.text_secondary'))
        .width('100%')
        .textAlign(TextAlign.Start)

      // 展示路径唯一出口：store 先 redacted()，这里再过一次 redactUrl()，token 永不出现
      Text(redactUrl(view.url))
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontColor($r('app.color.text_secondary'))
        .width('100%')
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .textAlign(TextAlign.Start)

      // D3 徽章：文案只由 model/pairingBadge.ts 的 badgeOf(真身) 给出——pin × reachable × scheme。
      // 有 pin 才可能说「已配对」；手动地址（无 pin）/ http 明文行一律「未配对」口径。
      // 监听器停了 / 打开失败时 reachable 由 onRemoteOutcome 降为 fail，同一纯函数自然改文案。
      if (this.badgeFor(view).length > 0) {
        Text(this.badgeFor(view))
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor(view.reachable === 'fail' ? $r('app.color.danger') : $r('app.color.text_secondary'))
          .width('100%')
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .textAlign(TextAlign.Start)
        // 只展示前缀 + 已固定标记，完整指纹 / 令牌都不上屏；http 行不显示（无 TLS 可固定）。
        if (this.hasPinFor(view)) {
          Text(`指纹 ${view.fingerprintPrefix} · 已固定指纹`)
            .fontSize(FONT.caption)
            .lineHeight(LINE_HEIGHT.caption)
            .fontColor($r('app.color.text_secondary'))
            .width('100%')
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .textAlign(TextAlign.Start)
        }
      }

      Row({ space: SPACING.sm }) {
        // 地址不再应答（reachable=fail，由远程打开结果标记 / 跳转失败标记）才出现的显式恢复动作。
        // 没有 pin 时是首配：标签 / 后果说明都与普通刷新刻意不同，且这一下只生成提案，
        // 不写 pin / 地址；真正确认走结果行的「确认信任该公告」。不轮询、不后台定时器。
        if (view.reachable === 'fail') {
          Column({ space: SPACING.xs }) {
            if (!remoteAnnounceRefreshService.hasPin(view.id)) {
              Text(FIRST_PAIRING_DETAIL)
                .fontSize(FONT.caption)
                .lineHeight(LINE_HEIGHT.caption)
                .fontColor($r('app.color.text_secondary'))
                .width('100%')
                .textAlign(TextAlign.Start)
            }
            ActionButton({
              label: remoteAnnounceRefreshService.hasPin(view.id)
                ? '按公告刷新地址'
                : FIRST_PAIRING_WORDING,
              actionEnabled: true,
              disabledReason: '',
              busy: false,
              variant: 'secondary',
              block: false,
              onTap: (): void => {
                this.refreshAddressFromAnnouncement(view);
              },
              onBlockedTap: null
            })
          }
        }
        ActionButton({
          label: '打开',
          actionEnabled: true,
          disabledReason: '',
          busy: false,
          variant: 'ghost',
          block: false,
          onTap: (): void => {
            this.openInstance(view);
          },
          onBlockedTap: null
        })
        if (this.configurable) {
          ActionButton({
            label: '编辑',
            actionEnabled: true,
            disabledReason: '',
            busy: false,
            variant: 'ghost',
            block: false,
            onTap: (): void => {
              this.showEdit(view);
            },
            onBlockedTap: null
          })
          ActionButton({
            label: '删除',
            actionEnabled: true,
            disabledReason: '',
            busy: false,
            variant: 'danger',
            block: false,
            onTap: (): void => {
              this.deleteInstance(view);
            },
            onBlockedTap: null
          })
        }
      }
      .width('100%')
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .padding({ top: SPACING.md, bottom: SPACING.md })
    .borderRadius(RADIUS.none)
  }

  /**
   * 手动配对面板（仅 configurable=true）：粘贴电脑面板的配对串即可添加实例。
   * 与下面的地址 / 令牌 / 方式表单是两条独立路径：配对串自带端口与令牌，不走两步公告同意。
   * 错误区只显示 store 返回的固定中文 reason，绝不回显粘贴原文（token）。
   */
  @Builder
  PairingPanel() {
    if (this.configurable) {
      Column({ space: SPACING.sm }) {
        Text('手动配对（粘贴配对串）')
          .fontSize(FONT.body)
          .lineHeight(LINE_HEIGHT.body)
          .fontColor($r('app.color.text_primary'))
          .width('100%')
          .textAlign(TextAlign.Start)
        Text('在电脑 DSH 面板点「显示配对信息」，复制配对串粘到下方；端口和令牌会一起带好，不用手输。')
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
          .width('100%')
          .textAlign(TextAlign.Start)
        Text('添加前会先连一次电脑的监听端口（最多 3 秒）；连不上不会保存，配对串会留在框里供修改重试。')
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
          .width('100%')
          .textAlign(TextAlign.Start)
        TextInput({ text: this.pairingText, placeholder: 'DSHDOTS1|… 或 {…} 配对 JSON' })
          .width('100%')
          .height(TOUCH_MIN)
          .fontSize(FONT.body)
          .onChange((value: string) => {
            this.pairingText = value;
            this.pairingError = '';
          })
        if (this.pairingError.length > 0) {
          Text(this.pairingError)
            .fontSize(FONT.caption)
            .lineHeight(LINE_HEIGHT.caption)
            .fontColor($r('app.color.danger'))
            .width('100%')
            .textAlign(TextAlign.Start)
        }
        ActionButton({
          label: '添加实例',
          actionEnabled: true,
          disabledReason: '',
          busy: this.pairingBusy,
          variant: 'primary',
          block: false,
          onTap: (): void => {
            this.addByPairing();
          },
          onBlockedTap: null
        })
      }
      .width('100%')
      .padding(SPACING.md)
      .backgroundColor($r('app.color.surface'))
      .borderRadius(RADIUS.sm)
    }
  }

  /** 添加 / 编辑面板：每个远程实例都给名称 + 地址 + 方式（六选一）。仅 configurable=true 装配。 */
  @Builder
  FormPanel() {
    if (this.panelMode.length > 0) {
      Column({ space: SPACING.sm }) {
        Text(this.panelMode === PANEL_ADD ? '添加实例' : '编辑实例')
          .fontSize(FONT.body)
          .lineHeight(LINE_HEIGHT.body)
          .fontColor($r('app.color.text_primary'))
          .width('100%')
          .textAlign(TextAlign.Start)
        TextInput({ text: this.formName, placeholder: '实例名称' })
          .width('100%')
          .height(TOUCH_MIN)
          .fontSize(FONT.body)
          .onChange((value: string) => {
            this.formName = value;
            this.formError = '';
          })
        TextInput({ text: this.formUrl, placeholder: 'http://192.168.1.6:3080/?token=…' })
          .width('100%')
          .height(TOUCH_MIN)
          .fontSize(FONT.body)
          .onChange((value: string) => {
            this.formUrl = value;
            this.formError = '';
          })
        Select(this.modeSelectOptions())
          .selected(this.modeIndex())
          .width('100%')
          .height(TOUCH_MIN)
          .onSelect((index: number) => {
            this.pickMode(index);
          })
        if (this.formError.length > 0) {
          Text(this.formError)
            .fontSize(FONT.caption)
            .lineHeight(LINE_HEIGHT.caption)
            .fontColor($r('app.color.danger'))
            .width('100%')
            .textAlign(TextAlign.Start)
        }
        Row({ space: SPACING.sm }) {
          ActionButton({
            label: '保存',
            actionEnabled: true,
            disabledReason: '',
            busy: false,
            variant: 'primary',
            block: false,
            onTap: (): void => {
              this.submitForm();
            },
            onBlockedTap: null
          })
          ActionButton({
            label: '取消',
            actionEnabled: true,
            disabledReason: '',
            busy: false,
            variant: 'secondary',
            block: false,
            onTap: (): void => {
              this.panelMode = '';
              this.formError = '';
            },
            onBlockedTap: null
          })
        }
        .width('100%')
      }
      .width('100%')
      .padding(SPACING.md)
      .backgroundColor($r('app.color.surface'))
      .borderRadius(RADIUS.sm)
    }
  }

  build() {
    Scroll() {
      Column({ space: SPACING.md }) {
        this.Header()
        Text(`共 ${this.views.length} 个实例`)
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
          .width('100%')
          .textAlign(TextAlign.Start)
        this.ProblemRow()
        this.AnnounceNoticeRow()
        if (this.configurable) {
          this.PairingPanel()
          this.FormPanel()
        }
        if (this.loading) {
          Text('正在读取实例表…')
            .fontSize(FONT.caption)
            .lineHeight(LINE_HEIGHT.caption)
            .fontColor($r('app.color.text_secondary'))
            .width('100%')
            .textAlign(TextAlign.Start)
        } else if (this.views.length === 0) {
          this.EmptyView()
        } else {
          ForEach(this.views, (view: RedactedInstance): void => {
            this.InstanceRow(view)
          }, (view: RedactedInstance): string => view.id)
        }
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
      .padding({ left: SPACING.lg, right: SPACING.lg, top: SPACING.md, bottom: SPACING.xl })
    }
    .width('100%')
    .height('100%')
    .scrollBar(BarState.Off)
    .visibility(this.active ? Visibility.Visible : Visibility.Hidden)
  }
}
