/**
 * 设置子页：数据导入导出（mod-settings-export-page）。
 *
 * 本页是**真页面**，不再是复用到实现宿主的薄壳：自带 `PageLayout`、一层 flex、
 * 自己的 `Scroller` 与唯一主操作「导出」（按今天日期导出完整包）。
 * 正文由 `components/settings/DataSection.ets` → `components/ExportImportPanel.ets`
 * 承接（presentational body，逐字复用，不在本页内联它们的渲染）。
 *
 * 状态与业务方法归本页所有（不再走 `SettingsHost` 的 `section='data'` 分支）：
 * - 导出是只读派生，走 `exportV2Timeline` 产出 repo-shaped bundle（记录 + 媒体 + 账本）；
 * - 导入必须两步（选文件 → 试算 → 显式确认才落盘），同一流程先按完整包 manifest 试算、
 *   不是完整包再回落兼容 JSON；确认时用用户看过的那份计划，不重新解析；
 * - 只写日程文件与 AppStorage 的导出/导入时刻，不碰 `settingsStore` 的配置键，
 *   因此与本页无关的保存（API 子页复用 `SettingsHost.saveSettings`）不会互相覆盖。
 */
import { promptAction, router } from '@kit.ArkUI';
import { webview } from '@kit.ArkWeb';
import { common } from '@kit.AbilityKit';
import { pasteboard } from '@kit.BasicServicesKit';
import { nowIso } from '../common/date';
import { toastMsFor } from '../common/copy';
import { FONT, RADIUS, SPACING } from '../common/uiTokens';
import { settingsStore } from '../services/settingsStore';
import { describeError, scheduleStore } from '../services/scheduleStore';
import { GitSyncService } from '../services/GitSyncService';
import type { ZipWriteBundleInput } from '../services/GitSyncService';
import {
  applyPlan,
  clearDryRun,
  defaultExportImportState,
  todayText,
  v2PlanSummary,
  v2RefusalNext,
  withExportPath,
  withImportFileName,
  withPanelMessage
} from '../model/exportImport';
import { LAST_EXPORT_AT_KEY, LAST_IMPORT_AT_KEY } from '../model/settingsMenu';
import type { ExportImportState, ExportRequest, ImportPlan, V2ImportPlan } from '../model/exportImport';
import {
  appendImportPlan,
  applyV2Import,
  exportV2Timeline,
  exportsDirPath,
  pickImportFile,
  planImportFromText,
  planV2ImportFromPicked
} from '../services/exportService';
import type {
  ExportRequestInput,
  ImportApplyResult,
  ImportFilePickResult,
  ImportPlanResult,
  V2ApplyResult,
  V2ExportResult,
  V2ImportPlanResult,
  V2ZipBridge,
  V2ZipEntry,
  V2ZipWriteResult
} from '../services/exportService';
import { timelineStore } from '../services/timelineStore';
import { timelineWriteStore } from '../services/timelineWriteStore';
import { PageLayout } from '../components/PageLayout';
import { DataSection } from '../components/settings/DataSection';

/**
 * exportService 与 GitSyncService 之间的显式适配器（ArkTS 禁止结构化类型，不能直接把
 * GitSyncService 当 V2ZipBridge 用）。只做参数形状转换，不含任何 IO 决策。
 */
class SettingsZipBridge implements V2ZipBridge {
  private service: GitSyncService;

  constructor(service: GitSyncService) {
    this.service = service;
  }

  zipWriteBundle(archivePath: string, entries: V2ZipEntry[]): Promise<V2ZipWriteResult> {
    const inputs: ZipWriteBundleInput[] = [];
    for (const entry of entries) {
      const input: ZipWriteBundleInput = { name: entry.name, bytes: entry.bytes };
      inputs.push(input);
    }
    return this.service.zipWriteBundle(archivePath, inputs);
  }

  zipRead(archivePath: string, entryName: string): Promise<Uint8Array | null> {
    return this.service.zipRead(archivePath, entryName);
  }
}

@Entry
@Component
struct SettingsExportImport {
  /** 面板展示状态（导出路径 / 试算计数 / 提示 / busy），写回后由 DataSection 逐字渲染。 */
  @State exportImport: ExportImportState = defaultExportImportState();
  @State ready: boolean = false;

  private disposed: boolean = false;
  private gitController: webview.WebviewController = new webview.WebviewController();
  private sync: GitSyncService = new GitSyncService(this.gitController);
  private pageScroller: Scroller = new Scroller();

  /**
   * 待用户确认的兼容 JSON 导入计划（就是试算那一份，确认时原样交给 appendImportPlan，
   * 绝不重新解析：两次读取之间本机记录可能已被别的页面改动）。
   */
  private pendingImport: ImportPlan | null = null;
  /** 待确认的完整包导入计划（非 null = 走完整包分支，确认时原样交给 applyV2Import）。 */
  private pendingV2Plan: V2ImportPlan | null = null;
  /** 待确认完整包所在目录（媒体从 media.zip 预取后搬运，绝不写 devices/**）。 */
  private pendingV2BundleDir: string = '';

  aboutToAppear(): void {
    this.bootstrap();
  }

  aboutToDisappear(): void {
    this.disposed = true;
  }

  /** 读盘 + 初始化日程目录与 zip 桥；读失败给确定文案，不编造「已就绪」。 */
  private async bootstrap(): Promise<void> {
    const context = getContext(this) as common.UIAbilityContext;
    try {
      await settingsStore.init(context);
      if (this.disposed) {
        return;
      }
      GitSyncService.setFilesDir(context.filesDir);
      await scheduleStore.ensureReady(context);
      await timelineStore.ensureReady(context);
      await timelineWriteStore.ensureReady(context);
      if (this.disposed) {
        return;
      }
      this.ready = true;
    } catch (error) {
      if (this.disposed) {
        return;
      }
      this.ready = false;
      this.exportImport = withPanelMessage(this.exportImport, `初始化失败：${describeError(error)}`, false);
    }
  }

  // ------------------------------------------------------------------ 导出 / 导入

  /**
   * 导出：主按钮导出**完整包**（repo-shaped bundle：记录 + 媒体 + 账本，只读派生，不改源文件）。
   * `ExportRequest` 的字段是 `fromText` / `toText`，服务层 `ExportRequestInput` 是 `from` / `to`，
   * 这里显式映射（只改调用侧，不动服务层与组件）。
   */
  private async handleExport(request: ExportRequest): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.exportImport = withPanelMessage(this.exportImport, '', true);
    const input: ExportRequestInput = {
      from: request.fromText,
      to: request.toText
    };
    try {
      const zip: V2ZipBridge = new SettingsZipBridge(this.sync);
      const result: V2ExportResult = await exportV2Timeline(input, zip);
      if (this.disposed) {
        return;
      }
      if (!result.ok) {
        this.exportImport = withPanelMessage(this.exportImport, this.v2RefusalLine(result.code, result.reason, '导出'), false);
        return;
      }
      this.exportImport = withExportPath(
        withPanelMessage(
          this.exportImport,
          `已导出完整包：${result.days} 天 / ${result.records} 条记录 / ${result.media} 个媒体文件（${result.dirPath}）`,
          false
        ),
        result.dirPath
      );
      // 设置根页「数据导入导出」行的摘要读这个时刻（只记真实成功落盘）。
      AppStorage.setOrCreate<string>(LAST_EXPORT_AT_KEY, nowIso());
      promptAction.showToast({ message: '已导出完整包', duration: toastMsFor(false) });
    } catch (error) {
      if (this.disposed) {
        return;
      }
      this.exportImport = withPanelMessage(this.exportImport, `导出失败：${describeError(error)}`, false);
    }
  }

  /**
   * 底部主操作「导出」：按今天日期导出一个真实完整包。
   * 面板内的「导出完整包」仍可用来自选区间；这里是一步到位的默认路径，走同一条落盘链。
   */
  private quickExportToday(): void {
    const today: string = todayText();
    this.handleExport({ fromText: today, toText: today });
  }

  /** 导入第一步：选文件 → 试算统计（一个字节都不写），计划留到用户点「确认导入」。 */
  private async handlePickImportFile(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.exportImport = withPanelMessage(this.exportImport, '', true);
    try {
      const context = getContext(this) as common.UIAbilityContext;
      const picked: ImportFilePickResult = await pickImportFile(context);
      if (this.disposed) {
        return;
      }
      if (!picked.ok) {
        this.pendingImport = null;
        this.exportImport = withPanelMessage(this.exportImport, `选择文件失败：${picked.reason}`, false);
        return;
      }
      // 一个入口识别两种文件：先按完整包 manifest 试算（带媒体），不是完整包再回落兼容 JSON。
      const bundled: V2ImportPlanResult = planV2ImportFromPicked(picked.text, picked.uri);
      if (this.disposed) {
        return;
      }
      if (bundled.ok && bundled.plan !== null) {
        this.pendingV2Plan = bundled.plan;
        this.pendingV2BundleDir = bundled.bundleDir;
        this.pendingImport = null;
        this.exportImport = this.withBundleDryRun(
          withImportFileName(this.exportImport, picked.fileName),
          bundled.plan,
          `已选完整包（先试算，未写入）：${bundled.summary}`
        );
        return;
      }
      this.pendingV2Plan = null;
      this.pendingV2BundleDir = '';
      const planned: ImportPlanResult = planImportFromText(picked.text, picked.fileName);
      if (this.disposed) {
        return;
      }
      if (planned.plan === null) {
        this.pendingImport = null;
        this.exportImport = withPanelMessage(this.exportImport, `无法读取导入文件：${planned.reason}`, false);
        return;
      }
      this.pendingImport = planned.plan;
      const tip: string =
        planned.plan.conflict > 0 ? '有冲突记录（同 id 且更新）：本机版本不会被覆盖，需人工决定' : '';
      this.exportImport = applyPlan(
        withImportFileName(withPanelMessage(this.exportImport, tip, false), picked.fileName),
        planned.plan
      );
    } catch (error) {
      if (this.disposed) {
        return;
      }
      this.pendingImport = null;
      this.exportImport = withPanelMessage(this.exportImport, `选择文件失败：${describeError(error)}`, false);
    }
  }

  /** 完整包试算计数写回同一个 ExportImportState，让「确认导入」的可用性与兼容 JSON 共用一套规则。 */
  private withBundleDryRun(state: ExportImportState, plan: V2ImportPlan, message: string): ExportImportState {
    const next: ExportImportState = {
      fromText: state.fromText,
      toText: state.toText,
      importFileName: state.importFileName,
      dryRunReady: plan.ok && plan.totals.records > 0,
      dryRunAdded: plan.totals.records,
      dryRunSkipped: 0,
      dryRunConflict: 0,
      dryRunInvalid: 0,
      exportPath: state.exportPath,
      message: message,
      busy: false
    };
    return next;
  }

  /** 导入第二步：用户点「确认导入」，把同一份试算计划追加落盘（先弹显式对话框的是完整包）。 */
  private handleConfirmImport(): void {
    if (this.pendingV2Plan !== null) {
      this.confirmBundleImport();
      return;
    }
    const plan: ImportPlan | null = this.pendingImport;
    if (plan === null) {
      if (this.disposed) {
        return;
      }
      this.exportImport = withPanelMessage(this.exportImport, '没有待确认的导入计划：请先选择文件', false);
      return;
    }
    try {
      const applied: ImportApplyResult = appendImportPlan(plan);
      this.pendingImport = null;
      if (this.disposed) {
        return;
      }
      if (!applied.ok) {
        this.exportImport = withPanelMessage(this.exportImport, `导入失败：${applied.reason}`, false);
        return;
      }
      const done: string =
        `已追加 ${applied.appended} 条、跳过 ${applied.skipped} 条、冲突 ${applied.conflict} 条` +
        `（非法 ${applied.invalid} 条未写入）`;
      this.exportImport = withPanelMessage(clearDryRun(this.exportImport), done, false);
      AppStorage.setOrCreate<string>(LAST_IMPORT_AT_KEY, nowIso());
      promptAction.showToast({ message: `已导入 ${applied.appended} 条`, duration: toastMsFor(false) });
    } catch (error) {
      if (this.disposed) {
        return;
      }
      this.exportImport = withPanelMessage(this.exportImport, `导入失败：${describeError(error)}`, false);
    }
  }

  /** 取消导入：丢掉待确认计划（两种格式都清）+ 清空试算统计（本机记录没有任何改动）。 */
  private handleCancelImport(): void {
    this.pendingImport = null;
    this.pendingV2Plan = null;
    this.pendingV2BundleDir = '';
    if (this.disposed) {
      return;
    }
    this.exportImport = withPanelMessage(clearDryRun(this.exportImport), '已取消导入（本机记录没有任何改动）', false);
  }

  /** 复制导出路径（面板也有「长按路径可复制」退路）；失败只写面板提示，不弹崩溃。 */
  private async handleCopyPath(): Promise<void> {
    const target: string = this.exportImport.exportPath.length > 0 ? this.exportImport.exportPath : exportsDirPath();
    try {
      const data: pasteboard.PasteData = pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, target);
      await pasteboard.getSystemPasteboard().setData(data);
      if (this.disposed) {
        return;
      }
      promptAction.showToast({ message: '路径已复制', duration: toastMsFor(false) });
    } catch (error) {
      if (this.disposed) {
        return;
      }
      this.exportImport = withPanelMessage(
        this.exportImport,
        `复制路径失败：${describeError(error)}（可在面板里长按路径手动复制）`,
        false
      );
    }
  }

  /** 类型化错误行：`动作失败：E_xxx 原因（下一步：…）`；无类型码时只给动作与原因。 */
  private v2RefusalLine(code: string, reason: string, action: string): string {
    const head: string = code.length > 0 ? `${action}失败：${code}` : `${action}失败`;
    return `${head} ${reason}（下一步：${v2RefusalNext(code)}）`;
  }

  /** 完整包的确认导入：先弹显式确认框，确认后才调 applyV2Import（试算默认不写）。 */
  private async confirmBundleImport(): Promise<void> {
    const plan: V2ImportPlan | null = this.pendingV2Plan;
    if (this.disposed || plan === null || !plan.ok) {
      if (!this.disposed) {
        this.exportImport = withPanelMessage(this.exportImport, '没有待确认的导入计划，请先选择文件并试算', false);
      }
      return;
    }
    this.exportImport = withPanelMessage(this.exportImport, '', true);
    try {
      const response = await promptAction.showDialog({
        title: '确认导入完整包',
        message:
          `将按试算计划写入日程：${v2PlanSummary(plan)}。` +
          '只追加记录与媒体，不覆盖更晚版本、不删除任何历史；点「取消」本机零改动。',
        buttons: [
          { text: '取消', color: $r('app.color.text_secondary') },
          { text: '确认导入', color: $r('app.color.brand') }
        ]
      });
      if (this.disposed) {
        return;
      }
      if (response.index !== 1) {
        this.exportImport = withPanelMessage(this.exportImport, '已取消导入（本机记录没有任何改动）', false);
        return;
      }
      const zip: V2ZipBridge = new SettingsZipBridge(this.sync);
      const result: V2ApplyResult = await applyV2Import(plan, this.pendingV2BundleDir, zip);
      if (this.disposed) {
        return;
      }
      if (!result.ok) {
        this.exportImport =
          withPanelMessage(this.exportImport, this.v2RefusalLine(result.code, result.reason, '导入'), false);
        return;
      }
      this.pendingV2Plan = null;
      this.pendingV2BundleDir = '';
      const done: string =
        `已导入完整包：${result.days} 天 / ${result.records} 条记录 / ` +
        `${result.media} 个媒体文件（跳过 ${result.skipped} 条）`;
      this.exportImport = withPanelMessage(clearDryRun(this.exportImport), done, false);
      AppStorage.setOrCreate<string>(LAST_IMPORT_AT_KEY, nowIso());
      promptAction.showToast({ message: '已导入完整包', duration: toastMsFor(false) });
    } catch (error) {
      if (this.disposed) {
        return;
      }
      this.exportImport =
        withPanelMessage(this.exportImport, this.v2RefusalLine('', describeError(error), '导入'), false);
    }
  }

  // ------------------------------------------------------------------ 装配

  /** 数据组正文：只装配 DataSection 一个组件（它内部再挂唯一的 ExportImportPanel）。 */
  @Builder
  DataGroup() {
    DataSection({
      exportImport: this.exportImport,
      onExport: (request: ExportRequest): void => {
        this.handleExport(request);
      },
      onPickFile: (): void => {
        this.handlePickImportFile();
      },
      onConfirmImport: (): void => {
        this.handleConfirmImport();
      },
      // loading 里的「取消」只停止等待（≠ 取消导入），不假装回滚。
      onCancelWait: (): void => {
        this.exportImport = withPanelMessage(this.exportImport, '已停止等待：文件可能已写出一部分', false);
      },
      onCancel: (): void => {
        this.handleCancelImport();
      },
      onCopyPath: (): void => {
        this.handleCopyPath();
      }
    })
  }

  /** 本页唯一主操作：按今天日期导出完整包（面板内可另选区间）。 */
  @Builder
  PrimaryExportButton() {
    Button('导出')
      .width('100%')
      .height(48)
      .fontSize(FONT.body)
      .backgroundColor($r('app.color.brand'))
      .fontColor($r('app.color.text_inverse'))
      .borderRadius(RADIUS.sm)
      .enabled(this.ready)
      .onClick(() => {
        this.quickExportToday();
      })
  }

  build() {
    Stack({ alignContent: Alignment.TopStart }) {
      PageLayout({
        title: '数据导入导出',
        subtitle: '',
        onBack: () => {
          router.back();
        }
      }) {
        // 一层 flex：内容 Scroll 吃余量 + 底部唯一「导出」；没有断点骨架 / 嵌套固定高度外壳。
        Column({ space: SPACING.md }) {
          Scroll(this.pageScroller) {
            Column({ space: SPACING.xl }) {
              this.DataGroup()
            }
            .width('100%')
            .alignItems(HorizontalAlign.Start)
            .padding({ bottom: SPACING.xl })
          }
          .layoutWeight(1)
          .width('100%')
          .scrollBar(BarState.Off)
          .align(Alignment.TopStart)

          this.PrimaryExportButton()
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
