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
  @State instanceSummary: string = '0 个实例';
  @State dataSummary: string = '未导出';
  @State apiSummary: string = '未配置 · 未配置';
  private disposed: boolean = false;

  aboutToAppear(): void {
    this.bootstrap();
  }

  aboutToDisappear(): void {
    this.disposed = true;
  }

  /** 读一次持久化状态铺到四行摘要；读失败也保留确定文案，不编造同步 / 导出状态。 */
  private async bootstrap(): Promise<void> {
    const context = getContext(this) as common.UIAbilityContext;
    try {
      await settingsStore.init(context);
      const settings: ScheduleSettings = await settingsStore.load();
      if (this.disposed) {
        return;
      }
      const host: string = repoHostOf(settings.repoUrl);
      // 状态文案只看权威最新尝试（git_sync_status）；lastSyncAt 只是比较证据，不渲染。
      const syncText: string = syncRowSummary(
        settings.lastSyncAt, settings.lastSyncError, syncStatusStore.latestAttempt()
      );
      // 阻断是独立问题：已配置但仓库公开 / 不可确认 → 「已配置（可见性阻断…）」，不是「未配置」。
      const blocked: boolean = isRepoBlockedStatus(syncStatusStore.snapshot());
      this.repoSummary = repoRowSummary(host, syncText, repoConfigStateOf(settings), blocked);
      this.apiSummary = apiRowSummary(
        findProvider(settings.aiProviderId).label,
        this.modelLabelOf(settings.aiProviderId, settings.aiModel)
      );
      this.instanceSummary = `${instanceStore.list().length} 个实例`;
      const exported: string | undefined = AppStorage.get<string>(LAST_EXPORT_AT_KEY);
      const imported: string | undefined = AppStorage.get<string>(LAST_IMPORT_AT_KEY);
      this.dataSummary = dataRowSummary(
        exported === undefined ? '' : exported,
        imported === undefined ? '' : imported
      );
    } catch (error) {
      // 读盘失败时四行仍保留初始的「未配置 / 未同步 / 未导出」，并照常可进入子页自查。
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

  /** 真正的跳转：每行只做一次 pushUrl，失败只留当前页（不静默换成假状态）。 */
  private push(route: string): void {
    router.pushUrl({ url: route }).catch(() => {
      // 路由失败保持在本页；不做「假装已打开」的假反馈。
    });
  }

  /** 一行菜单：标题 + 摘要 + ›，命中区 ≥ TOUCH_MIN。 */
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

      Text('›')
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
