/**
 * 设置页「数据」section（导出 / 导入）。
 *
 * A2 拆分：内容从 `pages/Settings.ets` 的 `DataGroup()` 逐字搬出。页面持有 `exportImport`
 * 状态与本机 IO（`services/exportService.ets`），这里只收**单向 props + 回调**。
 *
 * 组内**只有** `ExportImportPanel` 一个组件，是设置页唯一的导入 / 导出入口：区间 / 导出按钮 /
 * 选文件 / dry-run 统计 / 确认 / 取消都在组件内部，这里再包一层控件就会变成两套语义。
 * 媒体能力走主导出/导入流程（完整包含 media.zip），没有独立的「备份」节或第二套回调。
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

  /** 数据组：唯一的导出 / 导入入口（排在「关于」之前）。 */
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
        }
      })
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }
}
