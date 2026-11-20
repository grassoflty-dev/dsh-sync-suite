/**
 * 设置页「数据」section（导出 / 导入）。
 *
 * A2 拆分：内容从 `pages/Settings.ets` 的 `DataGroup()` 逐字搬出。页面持有 `exportImport`
 * 状态与本机 IO（`services/exportService.ets`），这里只收**单向 props + 回调**。
 *
 * 组内**只有** `ExportImportPanel` 一个组件：区间 / 导出按钮 / 选文件 / dry-run 统计 /
 * 确认 / 取消都在组件内部（格式已固定、Markdown 删除），这里再包一层控件就会变成两套语义。
 */
import { FONT, LINE_HEIGHT, SPACING } from '../../common/uiTokens';
import { ExportImportPanel } from '../ExportImportPanel';
import { defaultExportImportState } from '../../model/exportImport';
import type { ExportImportState, ExportRequest } from '../../model/exportImport';

@Component
export struct DataSection {
  /** 导出 / 导入面板的展示状态（页面写回导出路径 / dry-run 计数 / 提示 / busy）。 */
  @Prop exportImport: ExportImportState = defaultExportImportState();

  // ---------------------------------------------------------------- 回调（页面做 IO 并写回状态）
  onExport: (request: ExportRequest) => void = () => {};
  onPickFile: () => void = () => {};
  onConfirmImport: () => void = () => {};
  onCancel: () => void = () => {};
  /**
   * A 批（`docs/STATE-UI.md` §4.1）：loading 里点「取消」= **停止等待**，由页面把 `busy` 复位。
   *
   * 与 `onCancel`（清空 dry-run）刻意分开；这里只做转发，不碰状态（本组件不持有状态）。
   */
  onCancelWait: () => void = () => {};
  onCopyPath: () => void = () => {};

  // ---- v2 时间线备份（ExportImportPanel.V2Section 的展示状态与回调，页面持有真相源）----
  /** v2 导入计划是否已生成（dry-run 成功后由页面置 true）。 */
  @Prop v2PlanReady: boolean = false;
  /** v2 dry-run 计划行（days / records / media / bytes，纯函数 v2PlanSummary 产出）。 */
  @Prop v2PlanText: string = '';
  /** v2 最近一次提示（导出摘要 / 导入结果 / 类型化拒绝原因）。 */
  @Prop v2Message: string = '';
  /** v2 操作忙碌标志（按钮统一不可用原因来源）。 */
  @Prop v2Busy: boolean = false;

  onV2Export: () => void = () => {};
  /** 选 v2 备份并 dry-run（只算不写）。 */
  onV2Pick: () => void = () => {};
  /** 显式确认导入（页面弹确认框后才调 applyV2Import）。 */
  onV2Apply: () => void = () => {};
  /** 取消 v2 导入：清空计划，本机零改动。 */
  onV2Cancel: () => void = () => {};

  /** 数据组：导出 / 导入（排在「关于」之前）。 */
  build() {
    Column({ space: SPACING.md }) {
      Text('数据')
        .fontSize(FONT.body)
        .lineHeight(LINE_HEIGHT.body)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('app.color.text_primary'))
        .width('100%')
        .textAlign(TextAlign.Start)

      ExportImportPanel({
        state: this.exportImport,
        onExport: (request: ExportRequest): void => {
          this.onExport(request);
        },
        onPickFile: (): void => {
          this.onPickFile();
        },
        onConfirmImport: (): void => {
          this.onConfirmImport();
        },
        onCancel: (): void => {
          this.onCancel();
        },
        onCancelWait: (): void => {
          this.onCancelWait();
        },
        onCopyPath: (): void => {
          this.onCopyPath();
        },
        v2PlanReady: this.v2PlanReady,
        v2PlanText: this.v2PlanText,
        v2Message: this.v2Message,
        v2Busy: this.v2Busy,
        onV2Export: (): void => {
          this.onV2Export();
        },
        onV2Pick: (): void => {
          this.onV2Pick();
        },
        onV2Apply: (): void => {
          this.onV2Apply();
        },
        onV2Cancel: (): void => {
          this.onV2Cancel();
        }
      })
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }
}
