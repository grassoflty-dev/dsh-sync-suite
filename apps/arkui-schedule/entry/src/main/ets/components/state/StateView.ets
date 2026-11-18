/**
 * 三态调度器（`docs/STATE-UI.md` §1 / §4）：一套 props 表达 loading / empty / error，
 * 内部转调 `LoadingState` / `EmptyState` / `ErrorState` 三个组件，页面不需要各自记住三套 API。
 *
 * 与旧 `components/StateView.ets` 的区别（两套并存是刻意的）：
 * - 旧件只管「块内三态」，`RecordDetailView` / `RecordEditorView` / `EmptyState` 还在用它；
 * - 新件带**取消 / 诊断 / 动作**三件套，新代码一律用 `components/state/`。
 *
 * props 语义（下游装配照这张表）：
 * | prop | loading | empty | error |
 * |---|---|---|---|
 * | `title` | 加载文案（空则「正在加载…」） | 空态标题（「暂无日程」） | 发生了什么（红标题） |
 * | `detail` | 次要说明 | 次要说明 | 为什么 |
 * | `next` | 未使用 | **按钮文字**（空则「刷新」） | 下一步文案 |
 * | `diagnostics` | 未使用 | 未使用 | `formatDiagnostics()` 的产物（必传） |
 * | `progress` | 进度 `0..100` / `-1` | 未使用 | 未使用 |
 *
 * `next` 在空态是「按钮文字」而不是一句说明：`EmptyState` 的契约是「永远有一个按钮」
 * （`docs/STATE-UI.md` §4.2），而按钮文字只能由调用方给（「去填地址」/「换个区间」/「先勾选」）。
 *
 * 回调都是普通成员（不是 `@Prop`）：函数不能被 `@Prop` 深拷贝，`@Prop` 会把它变成副本。
 */
import { STATE_EMPTY, STATE_ERROR, STATE_LOADING } from '../../model/stateView';
import { EmptyState } from './EmptyState';
import { ErrorState } from './ErrorState';
import { LoadingState } from './LoadingState';

@Component
export struct StateView {
  /** 形态：`'loading' | 'empty' | 'error'`（未知值按 `empty` 处理，fail-safe）。 */
  @Prop kind: string = STATE_EMPTY;
  /** 主文案（含义随 `kind` 变，见文件头表）。 */
  @Prop title: string = '';
  /** 次要说明 / 失败原因。 */
  @Prop detail: string = '';
  /** 空态按钮文字 / 错误态下一步（见文件头表）。 */
  @Prop next: string = '';
  /** 诊断行（`formatDiagnostics()` 产物）；只有 error 用，且调用点应当总是传。 */
  @Prop diagnostics: string = '';
  /** 加载进度 `0..100`；`-1` = 不确定进度。 */
  @Prop progress: number = -1;
  /** `true` = 行内小条，`false` = 整块居中。 */
  @Prop compact: boolean = false;

  /** 加载态取消回调；`null` = 不允许取消。 */
  onCancel: (() => void) | null = null;

  /** 错误态重试回调；`null` = 不给重试按钮。 */
  onRetry: (() => void) | null = null;

  /** 空态动作回调；`null` = 点了没反应（但按钮仍然渲染，不出现死界面）。 */
  onAction: (() => void) | null = null;

  /** 触发空态动作（回调取值期间固定一次）。 */
  private invokeAction(): void {
    const handler: (() => void) | null = this.onAction;
    if (handler !== null) {
      handler();
    }
  }

  build() {
    Column() {
      if (this.kind === STATE_LOADING) {
        LoadingState({
          title: this.title,
          detail: this.detail,
          progress: this.progress,
          compact: this.compact,
          onCancel: this.onCancel
        })
      } else if (this.kind === STATE_ERROR) {
        ErrorState({
          what: this.title,
          why: this.detail,
          next: this.next,
          diagnostics: this.diagnostics,
          compact: this.compact,
          onRetry: this.onRetry,
          onOpenSettings: null
        })
      } else {
        EmptyState({
          title: this.title,
          detail: this.detail,
          actionLabel: this.next,
          compact: this.compact,
          onAction: (): void => {
            this.invokeAction();
          }
        })
      }
    }
    .width('100%')
  }
}
