/**
 * 设置页「数据」section（导出 / 导入）。
 *
 * A2 拆分：内容从 `pages/Settings.ets` 的 `DataGroup()` 逐字搬出。页面持有 `exportImport`
 * 状态与本机 IO（`services/exportService.ets`），这里只收**单向 props + 回调**。
 *
 * 组内**只有** `ExportImportPanel` 一个组件：区间 / 格式 / 两个开关 / 导出按钮 / 选文件 /
 * dry-run 统计 / 确认 / 取消都在组件内部，这里再包一层控件就会变成两套语义。
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
  onCopyPath: () => void = () => {};

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
        onCopyPath: (): void => {
          this.onCopyPath();
        }
      })
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }
}
