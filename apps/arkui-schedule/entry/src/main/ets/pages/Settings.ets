/**
 * 设置根页（mod-settings-root）：**恰好四行菜单**，每行 push 一个真实路由子页。
 *
 * 四行（顺序固定）：同步仓库 / 远程实例 / 数据导入导出 / API 配置。
 * 本页**不渲染任何 section body**：原长滚动的实现搬到
 * `components/settings/SettingsHost.ets`，由四个子页各自复用同一个 section 组件。
 *
 * 摘要只来自已持久化的真实状态：
 * - 同步仓库 = 仓库主机 + `已同步·HH:MM` / `失败：原因`（settingsStore 的 lastSyncAt / lastSyncError）；
 * - 远程实例 = `N 个实例`（instanceStore.list()）；
 * - 数据导入导出 = 上次导出 / 导入时刻或 `未导出`（AppStorage 中落盘成功后写入的时刻）；
 * - API 配置 = `服务 · 模型`（settingsStore 的 aiProviderId / aiModel，走预设表取展示名）。
 *
 * 「关于」原本在长滚动里是一整节（版本 / 平台 / 深色模式 / 隐私弹层）。本模块按设计
 * 只在页脚保留版本号一行；其余内容随实现宿主留存、暂不挂在任何路由上，待后续模块
 * 单独安排落点（不在此处塞第五行，也不伪造可点的空入口）。
 *
 * 设置入口仍是外壳 rail 齿轮唯一一处（Home.openSettings → pages/Settings），本页不再
 * 提供第二个设置入口；子页返回走 router.back() → 本页 → 外壳。
 *
 * mod-app-git-bridge-ready（真机冷启动两个缺陷的修法，判定全在 `model/bridgeReadiness.ts`）：
 * - 每一行**只有三种态**：`读取中…`（真的在飞）→ 值 / `读不到：…（typed 码）· 轻点本行重试`。
 *   读取自带预算，所以「读取中…」不可能无限挂着（旧实现 catch 里不写，行就永远停在占位）；
 * - 失败行的点击语义变成**重试本行**（不跳转），重试会清失败态、重新判一次内核就绪并重读；
 * - 「远程实例」行**读不到就说读不到**，绝不渲染 `0 个实例`（真机那次把 2 个实例显示成 0 个）。
 *
 * mod-app-settings-summary-resolve（新构建真机缺陷的修法，21:36 复测）：
 * - **症状**：外层两行永远停在「读取中…」（等 43 秒），typed 失败行一次都不出现，
 *   而同入口的子页健康、hilog 里没有任何 `E_*` 行。**结论**：数据层没坏，是**绑定**坏了。
 * - **根因**：行原先经 `@Builder MenuRow(title: string, summary: string, route: string)` **按值**
 *   传参。ArkUI 的 @Builder 参数是调用那一刻的快照，Text 节点的更新闭包里没有状态读取，
 *   于是 `@State` 改变不会重建那个 Text —— `applyRows()` 写了终态、屏幕仍停在初值。
 *   仓库内同族证据：`docs/VERIFICATION.md` §15.6.1 真机抓过同一形状（`@Builder HintLine(text)`
 *   按值传参不随 `@Prop` 重建），修法是让状态读取发生在节点闭包里。
 * - **修法**：行改成真子组件 `components/settings/MenuSummaryRow.ets`（`@Prop summary` /
 *   `@Prop retryable`），父 → @Prop → 子 Text 才是 ArkUI 跟踪的那条链。三态模型一字未改。
 * - **终态保证**：`bootstrap()` 的每一条出口（成功 / 超时 / 抛错 / 页面已销毁）都落到
 *   `applyRows()` / `settleFailed()`，且赋值段不再调用任何可能抛错的函数；`aboutToAppear`
 *   里的 Promise 一定挂 `.catch`（旧写法没有 void 也没有 catch，异步拒绝是静默的）。
 * - **重试**：`rowsBusy` 防重入；重试也有同一份预算，**重试又超时**时文案变成
 *   「第 N 次仍没读到：…（E_SETTINGS_READ_FAILED）」，不是悄悄退回「读取中…」。
 */
import { router } from '@kit.ArkUI';
import { common } from '@kit.AbilityKit';
import { APP_VERSION } from '../common/version';
import { DIVIDER, FONT, LINE_HEIGHT, SPACING } from '../common/uiTokens';
import { settingsStore } from '../services/settingsStore';
import type { ScheduleSettings } from '../services/settingsStore';
import { instanceStore } from '../services/instanceStore';
import { findProvider, defaultModelOf, modelsOf } from '../model/aiProvider';
import type { AiModelOption } from '../model/aiProvider';
import {
  LAST_EXPORT_AT_KEY,
  LAST_IMPORT_AT_KEY,
  repoHostOf,
  syncRowSummary,
  dataRowSummary,
  apiRowSummary
} from '../model/settingsMenu';
import { PageLayout } from '../components/PageLayout';
// mod-settings-configured-state：与同步周期共用同一个已配置判据；阻断态走独立 lane。
import { repoConfigStateOf, repoRowSummary } from '../model/repoConfigured';
import { isRepoBlockedStatus } from '../model/homeGlobalRefresh';
import { syncStatusStore } from '../services/syncStatusStore';
import { syncController } from '../services/syncController';
import { problemText } from '../model/instances';
import type { InstanceProblem } from '../model/instances';
// mod-app-git-bridge-ready：四行摘要的「读取中 → 值 / 失败」与「读不到 ≠ 空」全在纯模型里判定。
import {
  E_INSTANCES_READ_FAILED,
  E_SETTINGS_READ_FAILED,
  instancesReadOf,
  instancesRow,
  rowFailed,
  rowLoading,
  rowValue
} from '../model/bridgeReadiness';
import type { InstancesRead, RowView } from '../model/bridgeReadiness';
// mod-app-settings-summary-resolve：行的渲染绑定换成真组件；重试文案的「第几次」在纯模型里。
import { MenuSummaryRow } from '../components/settings/MenuSummaryRow';
import { nextAttemptOf, retryReasonOf } from '../model/summaryResolve';

/** 摘要读取预算：超时就按 typed 失败上屏——「读取中…」因此不可能无限挂着。 */
const ROW_READ_BUDGET_MS: number = 4000;

/** 一次摘要读取的结论（`ok === false` 时 `settings` 为 null，`reason` 一定有话说）。 */
interface RowRead {
  ok: boolean;
  settings: ScheduleSettings | null;
  reason: string;
}

/** 失败原因归一（只取 message；空 message 给确定中文，绝不把空串上屏）。 */
function describeReadFailure(error: Object): string {
  if (error instanceof Error) {
    const text: string = error.message.trim();
    return text.length > 0 ? `这次没读到本机设置：${text}` : '这次没读到本机设置';
  }
  return '这次没读到本机设置';
}

/** 读一次本机设置（init 幂等 + load）；失败向上抛，由调用方的预算包成 typed 失败。 */
async function loadSettingsNow(context: common.UIAbilityContext): Promise<ScheduleSettings> {
  await settingsStore.init(context);
  return await settingsStore.load();
}

/**
 * 有界读取：`init` + `load` 全部在预算内完成，超时 / 抛错都收敛成 `ok:false`（永不 reject）。
 *
 * 为什么必须自己设上限：真机冷启动出现过设置页「同步仓库」永久停在「读取中…」——旧实现的
 * catch 什么都不写，行就停在初始占位。现在无论成功、失败还是超时，都一定有一个结论。
 */
function readSettingsWithinBudget(context: common.UIAbilityContext, budgetMs: number): Promise<RowRead> {
  return new Promise<RowRead>((resolve: (value: RowRead) => void): void => {
    let settled: boolean = false;
    const finish = (value: RowRead): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };
    const timer: number = setTimeout((): void => {
      finish({ ok: false, settings: null, reason: `读取超时（超过 ${Math.ceil(budgetMs / 1000)} 秒）` });
    }, budgetMs);
    loadSettingsNow(context)
      .then((loaded: ScheduleSettings): void => {
        clearTimeout(timer);
        finish({ ok: true, settings: loaded, reason: '' });
      })
      .catch((error: Object): void => {
        clearTimeout(timer);
        finish({ ok: false, settings: null, reason: describeReadFailure(error) });
      });
  });
}

/** 四行菜单的目标路由；`pages/Instances` 是既有顶层页，原样复用。 */
const ROUTE_SYNC: string = 'pages/SettingsSync';
const ROUTE_INSTANCES: string = 'pages/Instances';
const ROUTE_DATA: string = 'pages/SettingsExportImport';
const ROUTE_API: string = 'pages/SettingsApi';

@Entry
@Component
struct Settings {
  // 读取中给中性占位，绝不先写死「未配置」：prefs 尚未加载时的初值不是配置事实。
  @State repoSummary: string = '读取中…';
  // 「读不到」绝不能显示成「0 个实例」：初值是「读取中…」，只有真的读到 0 条才报 0。
  @State instanceSummary: string = '读取中…';
  @State dataSummary: string = '未导出';
  @State apiSummary: string = '未配置 · 未配置';
  /** 本行当前是否处于「读不到」态：是 → 点本行重试（不跳转），并显示行尾「重试」。 */
  @State repoRetryable: boolean = false;
  @State instancesRetryable: boolean = false;
  /** 重试去抖：正在读时再点多下只算一次。 */
  private rowsBusy: boolean = false;
  /** 已完成的读取次数（0 = 首次；每点一次「重试」+1，成功后归零）。 */
  private retryAttempt: number = 0;
  /** 页面已销毁：不再为一个已经不在的页面发起新的读取（已发出的结论照常落终态）。 */
  private disposed: boolean = false;

  aboutToAppear(): void {
    // 显式挂 .catch：异步拒绝不许静默（旧写法 `this.bootstrap();` 既没有 void 也没有 catch，
    // 一旦在预算武装之前抛错，两行就永远停在「读取中…」且没有任何 typed 文案上屏）。
    this.bootstrap().catch((error: Object): void => {
      this.settleFailed(error);
    });
  }

  aboutToDisappear(): void {
    this.disposed = true;
  }

  /**
   * 读一次持久化状态铺到四行摘要（**一定有结论**：值、或 typed 失败行）。
   *
   * 三条出口都落终态：读取本身永不 reject（超时 / 抛错都收成 `ok:false`），
   * 读取之外的意外异常由 `readRowsWithinBudget()` 的 try/catch 兜住，
   * 再由 `aboutToAppear` / `retryRows` 的 `.catch` 兜底成失败行。
   * 页面销毁不改变这条规则：晚到的结论照写（对已销毁的组件是空操作，不会有可见刷新）。
   */
  private async bootstrap(): Promise<void> {
    const read: RowRead = await this.readRowsWithinBudget();
    this.applyRows(read);
  }

  /**
   * 有界读取的唯一入口：**永不 reject**。
   *
   * `getContext(this)` 这类同步抛错以前会直接冒泡成一次未处理的 Promise 拒绝（静默），
   * 现在同样收敛成一条 typed 失败结论。
   */
  private async readRowsWithinBudget(): Promise<RowRead> {
    try {
      const context: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
      return await readSettingsWithinBudget(context, ROW_READ_BUDGET_MS);
    } catch (error) {
      return { ok: false, settings: null, reason: describeReadFailure(error) };
    }
  }

  /** 把一次读取结论落到四行：成功给值（可带内核附注），失败给「读不到 + 原因 + 重试」。 */
  private applyRows(read: RowRead): void {
    const note: string = this.engineNote();
    // 重试过的失败换一句话说（typed 码不变）：同一句重复上屏等于没说。
    const reason: string = retryReasonOf(this.retryAttempt, read.reason);
    if (!read.ok || read.settings === null) {
      // 这次连设置都没读到，实例表根本没被读取：同样只能说「读不到」，不许退化成「0 个实例」。
      this.writeRows(rowFailed(E_SETTINGS_READ_FAILED, reason, note), this.unreadInstancesView(note));
      return;
    }
    const settings: ScheduleSettings = read.settings;
    this.writeRows(this.repoViewOf(settings, note), this.instancesViewOf(note));
    // 成功即归零：下一轮若再失败，文案从「首次」重新说起。
    this.retryAttempt = 0;
    this.apiSummary = this.apiSummaryOf(settings);
    this.dataSummary = this.dataSummaryOf();
  }

  /**
   * 两行终态的唯一写入口。
   *
   * 赋值段（这个方法体）里**不调用任何可能抛错的函数**：调用方先把两个 `RowView` 算完
   * （各自的细节读取都在自己的 try/catch 里降级成 typed 失败行），再进来一次性落状态。
   * 这样「两行一定会离开在飞态」是从代码形状上可判定的，不靠运气。
   */
  private writeRows(repoView: RowView, instanceView: RowView): void {
    this.repoSummary = repoView.text;
    this.repoRetryable = repoView.canRetry;
    this.instanceSummary = instanceView.text;
    this.instancesRetryable = instanceView.canRetry;
  }

  /** 「同步仓库」行：值来自 settingsStore + syncStatusStore + repoConfigured（与子页同一套事实）。 */
  private repoViewOf(settings: ScheduleSettings, note: string): RowView {
    try {
      const host: string = repoHostOf(settings.repoUrl);
      // 状态文案只看权威最新尝试（git_sync_status）；lastSyncAt 只是比较证据，不渲染。
      const syncText: string = syncRowSummary(
        settings.lastSyncAt, settings.lastSyncError, syncStatusStore.latestAttempt()
      );
      // 阻断是独立问题：已配置但仓库公开 / 不可确认 → 「已配置（可见性阻断…）」，不是「未配置」。
      const blocked: boolean = isRepoBlockedStatus(syncStatusStore.snapshot());
      return rowValue(repoRowSummary(host, syncText, repoConfigStateOf(settings), blocked), note);
    } catch (error) {
      return rowFailed(E_SETTINGS_READ_FAILED, describeReadFailure(error), note);
    }
  }

  /** 「远程实例」行：「读不到」与「空」是两件事，判定在纯模型 instancesReadOf / instancesRow 里。 */
  private instancesViewOf(note: string): RowView {
    try {
      const count: number = instanceStore.list().length;
      const problem: InstanceProblem = instanceStore.lastProblem();
      const read2: InstancesRead = instancesReadOf(count, problem, problemText(problem));
      return instancesRow(read2, note);
    } catch (error) {
      return this.unreadInstancesViewWith(describeReadFailure(error), note);
    }
  }

  /** 设置都没读到时的实例行：明确说「这次读取没有完成」，绝不写成 0 条。 */
  private unreadInstancesView(note: string): RowView {
    return this.unreadInstancesViewWith('这次读取没有完成（设置也没读到）', note);
  }

  private unreadInstancesViewWith(reason: string, note: string): RowView {
    const unread: InstancesRead = instancesReadOf(0, 'E_STORAGE_UNAVAILABLE', reason);
    return instancesRow(unread, note);
  }

  /** 「API 配置」行：源 / 模型展示名；算不出来就保留上一次的值（不把这两行拖回占位）。 */
  private apiSummaryOf(settings: ScheduleSettings): string {
    try {
      return apiRowSummary(
        findProvider(settings.aiProviderId).label,
        this.modelLabelOf(settings.aiProviderId, settings.aiModel)
      );
    } catch (error) {
      return this.apiSummary;
    }
  }

  /** 「数据导入导出」行：上次导出 / 导入时刻或「未导出」；读不到就保留上一次的值。 */
  private dataSummaryOf(): string {
    try {
      const exported: string | undefined = AppStorage.get<string>(LAST_EXPORT_AT_KEY);
      const imported: string | undefined = AppStorage.get<string>(LAST_IMPORT_AT_KEY);
      return dataRowSummary(
        exported === undefined ? '' : exported,
        imported === undefined ? '' : imported
      );
    } catch (error) {
      return this.dataSummary;
    }
  }

  /**
   * 兜底终态：**任何**意外拒绝（`bootstrap()` 之外也没想到的路径）都把两行写成 typed 失败行。
   *
   * 这一段刻意不调用 `repoViewOf()` / `instancesViewOf()` 之类可能再次抛错的函数，
   * 只用纯模型拼两句文案：兜底本身不许再有失败模式。
   */
  private settleFailed(error: Object): void {
    const reason: string = retryReasonOf(this.retryAttempt, describeReadFailure(error));
    this.writeRows(
      rowFailed(E_SETTINGS_READ_FAILED, reason, ''),
      rowFailed(E_INSTANCES_READ_FAILED, reason, '')
    );
  }

  /**
   * 本行失败时的重试（不需要重启 App）：清掉失败态 → 回「读取中…」→ 重新判一次内核就绪 →
   * 重新读一遍（同一次有界预算）。
   *
   * 内核仍然没就绪时：读取照样有结论（读到就显示值 + 附注「同步内核未就绪」，读不到就显示
   * 带 typed 码的失败行），绝不停在「读取中…」；再点一次仍是同样的有界过程。
   *
   * 重试**又**超时：`retryAttempt` 已经 +1，`applyRows()` 会把原因拼成
   * 「第 2 次仍没读到：读取超时（超过 4 秒）」——句子不同、typed 码相同，行仍可再点。
   */
  private async retryRows(): Promise<void> {
    if (this.rowsBusy || this.disposed) {
      return;
    }
    this.rowsBusy = true;
    this.retryAttempt = nextAttemptOf(this.retryAttempt);
    const loading: RowView = rowLoading();
    this.repoSummary = loading.text;
    this.instanceSummary = loading.text;
    this.repoRetryable = false;
    this.instancesRetryable = false;
    try {
      await this.bootstrap();
    } catch (error) {
      // bootstrap 自身已保证不 reject；这一层是形状上的兜底，不留未处理拒绝。
      this.settleFailed(error);
    } finally {
      this.rowsBusy = false;
    }
  }

  /**
   * 同步内核附注（空串 = 一切正常）。
   *
   * 只读判断（`syncController.isReady()` 不注册、不刷新、不产生副作用）；失败行与值行共用
   * 同一句话，让用户知道「这次读不到」有没有内核那一半的原因。重试时重算。
   */
  private engineNote(): string {
    try {
      if (syncController.isReady()) {
        return '';
      }
      return '同步内核未就绪（页面加载完会自行恢复）';
    } catch (error) {
      return '';
    }
  }

  /** 模型展示名：预设表命中走 label；存量手输名原样显示（不迁移、不丢失）。 */
  private modelLabelOf(providerId: string, modelId: string): string {
    const id: string = typeof modelId === 'string' ? modelId.trim() : '';
    const models: AiModelOption[] = modelsOf(providerId);
    for (const item of models) {
      if (item.id === id) {
        return item.label;
      }
    }
    return id.length > 0 ? id : defaultModelOf(providerId);
  }

  /**
   * 行点击唯一出口：**失败态先重试本行**，正常态才推子页。
   *
   * 为什么失败态不直接跳转：这一行此刻要的不是「进去看」，而是「再读一次」；跳进去只会把
   * 失败掩进子页。重试成功后本行显示真实值，再点一下就是正常的进子页。
   */
  private push(route: string): void {
    if (!this.isRetryable(route)) {
      router.pushUrl({ url: route }).catch(() => {
        // 路由失败保持在本页；不做「假装已打开」的假反馈。
      });
      return;
    }
    this.retryRows().catch((error: Object): void => {
      // 重试路径内部已把结论写进行状态；这里只兜住 Promise，不留未处理拒绝
      this.settleFailed(error);
    });
  }

  /** 本行是否处于「读不到」态（决定点击语义与行尾提示）。 */
  private isRetryable(route: string): boolean {
    if (route === ROUTE_SYNC) {
      return this.repoRetryable;
    }
    if (route === ROUTE_INSTANCES) {
      return this.instancesRetryable;
    }
    return false;
  }

  build() {
    Stack({ alignContent: Alignment.TopStart }) {
      PageLayout({
        title: '设置',
        subtitle: '',
        onBack: () => {
          router.back();
        }
      }) {
        Scroll() {
          Column({ space: SPACING.md }) {
            // 四行都是真子组件 + @Prop（不是 @Builder 按值传参）：摘要 @State 变化时，
            // 父 → @Prop → 子 Text 这条链会被 ArkUI 跟踪，行才会真的刷新。
            MenuSummaryRow({
              title: '同步仓库',
              summary: this.repoSummary,
              retryable: this.repoRetryable,
              onTap: () => {
                this.push(ROUTE_SYNC);
              }
            })
            Divider()
              .strokeWidth(DIVIDER)
              .color($r('app.color.divider'))
            MenuSummaryRow({
              title: '远程实例',
              summary: this.instanceSummary,
              retryable: this.instancesRetryable,
              onTap: () => {
                this.push(ROUTE_INSTANCES);
              }
            })
            Divider()
              .strokeWidth(DIVIDER)
              .color($r('app.color.divider'))
            MenuSummaryRow({
              title: '数据导入导出',
              summary: this.dataSummary,
              retryable: false,
              onTap: () => {
                this.push(ROUTE_DATA);
              }
            })
            Divider()
              .strokeWidth(DIVIDER)
              .color($r('app.color.divider'))
            MenuSummaryRow({
              title: 'API 配置',
              summary: this.apiSummary,
              retryable: false,
              onTap: () => {
                this.push(ROUTE_API);
              }
            })

            Text(`关于 · v${APP_VERSION}`)
              .fontSize(FONT.caption)
              .lineHeight(LINE_HEIGHT.caption)
              .fontColor($r('app.color.text_secondary'))
              .width('100%')
              .textAlign(TextAlign.Center)
              .padding({ top: SPACING.xl })
          }
          .width('100%')
          .alignItems(HorizontalAlign.Start)
          .padding({ bottom: SPACING.xl })
        }
        .width('100%')
        .height('100%')
        .scrollBar(BarState.Off)
        .align(Alignment.TopStart)
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor($r('app.color.page_background'))
  }
}
