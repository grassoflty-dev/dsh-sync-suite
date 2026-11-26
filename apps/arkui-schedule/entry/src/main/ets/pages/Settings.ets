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
 */
import { router } from '@kit.ArkUI';
import { common } from '@kit.AbilityKit';
import { APP_VERSION } from '../common/version';
import { DIVIDER, FONT, LINE_HEIGHT, SPACING, TOUCH_MIN } from '../common/uiTokens';
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
  E_SETTINGS_READ_FAILED,
  instancesReadOf,
  instancesRow,
  rowFailed,
  rowLoading,
  rowValue
} from '../model/bridgeReadiness';
import type { InstancesRead, RowView } from '../model/bridgeReadiness';

/** 摘要读取预算：超时就按 typed 失败上屏——「读取中…」因此不可能无限挂着。 */
const ROW_READ_BUDGET_MS: number = 4000;
/** 行尾提示：失败态显示「重试」（点本行即重试），正常态是进入箭头。 */
const ROW_HINT_RETRY: string = '重试';
const ROW_HINT_OPEN: string = '›';

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
  private disposed: boolean = false;
  /** 重试去抖：正在读时再点多下只算一次。 */
  private rowsBusy: boolean = false;

  aboutToAppear(): void {
    this.bootstrap();
  }

  aboutToDisappear(): void {
    this.disposed = true;
  }

  /**
   * 读一次持久化状态铺到四行摘要（**一定有结论**：值、或 typed 失败行）。
   *
   * 旧实现在 catch 里什么都不写，于是「同步仓库」永久停在「读取中…」、实例行永久停在
   * 「0 个实例」——真机冷启动那两个症状就是同一段代码的两面。
   */
  private async bootstrap(): Promise<void> {
    const context = getContext(this) as common.UIAbilityContext;
    const read: RowRead = await readSettingsWithinBudget(context, ROW_READ_BUDGET_MS);
    if (this.disposed) {
      return;
    }
    this.applyRows(read);
  }

  /** 把一次读取结论落到四行：成功给值（可带内核附注），失败给「读不到 + 原因 + 重试」。 */
  private applyRows(read: RowRead): void {
    const note: string = this.engineNote();
    if (!read.ok || read.settings === null) {
      const repoView: RowView = rowFailed(E_SETTINGS_READ_FAILED, read.reason, note);
      this.repoSummary = repoView.text;
      this.repoRetryable = repoView.canRetry;
      // 这次连设置都没读到，实例表根本没被读取：同样只能说「读不到」，不许退化成「0 个实例」。
      const unread: InstancesRead = instancesReadOf(0, 'E_STORAGE_UNAVAILABLE',
        '这次读取没有完成（设置也没读到）');
      const instanceView: RowView = instancesRow(unread, note);
      this.instanceSummary = instanceView.text;
      this.instancesRetryable = instanceView.canRetry;
      return;
    }
    const settings: ScheduleSettings = read.settings;
    const host: string = repoHostOf(settings.repoUrl);
    // 状态文案只看权威最新尝试（git_sync_status）；lastSyncAt 只是比较证据，不渲染。
    const syncText: string = syncRowSummary(
      settings.lastSyncAt, settings.lastSyncError, syncStatusStore.latestAttempt()
    );
    // 阻断是独立问题：已配置但仓库公开 / 不可确认 → 「已配置（可见性阻断…）」，不是「未配置」。
    const blocked: boolean = isRepoBlockedStatus(syncStatusStore.snapshot());
    const repoView: RowView = rowValue(
      repoRowSummary(host, syncText, repoConfigStateOf(settings), blocked), note
    );
    this.repoSummary = repoView.text;
    this.repoRetryable = repoView.canRetry;
    this.apiSummary = apiRowSummary(
      findProvider(settings.aiProviderId).label,
      this.modelLabelOf(settings.aiProviderId, settings.aiModel)
    );
    // 实例行：「读不到」与「空」是两件事，判定在纯模型 instancesReadOf / instancesRow 里。
    const count: number = instanceStore.list().length;
    const problem: InstanceProblem = instanceStore.lastProblem();
    const read2: InstancesRead = instancesReadOf(count, problem, problemText(problem));
    const instanceView: RowView = instancesRow(read2, note);
    this.instanceSummary = instanceView.text;
    this.instancesRetryable = instanceView.canRetry;
    const exported: string | undefined = AppStorage.get<string>(LAST_EXPORT_AT_KEY);
    const imported: string | undefined = AppStorage.get<string>(LAST_IMPORT_AT_KEY);
    this.dataSummary = dataRowSummary(
      exported === undefined ? '' : exported,
      imported === undefined ? '' : imported
    );
  }

  /**
   * 本行失败时的重试（不需要重启 App）：清掉失败态 → 回「读取中…」→ 重新判一次内核就绪 →
   * 重新读一遍（同一次有界预算）。
   *
   * 内核仍然没就绪时：读取照样有结论（读到就显示值 + 附注「同步内核未就绪」，读不到就显示
   * 带 typed 码的失败行），绝不停在「读取中…」；再点一次仍是同样的有界过程。
   */
  private async retryRows(): Promise<void> {
    if (this.rowsBusy) {
      return;
    }
    this.rowsBusy = true;
    const loading: RowView = rowLoading();
    this.repoSummary = loading.text;
    this.instanceSummary = loading.text;
    this.repoRetryable = false;
    this.instancesRetryable = false;
    try {
      await this.bootstrap();
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
    if (syncController.isReady()) {
      return '';
    }
    return '同步内核未就绪（页面加载完会自行恢复）';
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
    if (this.isRetryable(route)) {
      this.retryRows().catch((): void => {
        // 重试路径内部已把结论写进行状态；这里只兜住 Promise，不留未处理拒绝
      });
      return;
    }
    router.pushUrl({ url: route }).catch(() => {
      // 路由失败保持在本页；不做「假装已打开」的假反馈。
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

  /** 行尾提示：失败态是「重试」（点本行即重试），其余是进入箭头。 */
  private rowHint(route: string): string {
    return this.isRetryable(route) ? ROW_HINT_RETRY : ROW_HINT_OPEN;
  }

  /** 一行菜单：标题 + 摘要 + 行尾提示（失败态是「重试」，其余是 ›），命中区 ≥ TOUCH_MIN。 */
  @Builder
  MenuRow(title: string, summary: string, route: string) {
    Row({ space: SPACING.sm }) {
      Column({ space: SPACING.xs }) {
        Text(title)
          .fontSize(FONT.body)
          .lineHeight(LINE_HEIGHT.body)
          .fontColor($r('app.color.text_primary'))
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
          .textAlign(TextAlign.Start)
        Text(summary)
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
          .textAlign(TextAlign.Start)
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)

      Text(this.rowHint(route))
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontColor($r('app.color.text_secondary'))
        .flexShrink(0)
        .textAlign(TextAlign.Center)
    }
    .width('100%')
    .constraintSize({ minHeight: TOUCH_MIN + SPACING.md })
    .alignItems(VerticalAlign.Center)
    .onClick(() => {
      this.push(route);
    })
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
            this.MenuRow('同步仓库', this.repoSummary, ROUTE_SYNC)
            Divider()
              .strokeWidth(DIVIDER)
              .color($r('app.color.divider'))
            this.MenuRow('远程实例', this.instanceSummary, ROUTE_INSTANCES)
            Divider()
              .strokeWidth(DIVIDER)
              .color($r('app.color.divider'))
            this.MenuRow('数据导入导出', this.dataSummary, ROUTE_DATA)
            Divider()
              .strokeWidth(DIVIDER)
              .color($r('app.color.divider'))
            this.MenuRow('API 配置', this.apiSummary, ROUTE_API)

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
