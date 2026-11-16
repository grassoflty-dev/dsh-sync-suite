/**
 * 空状态提示组件 —— **兼容层**（已由 `components/StateView.ets` 取代）。
 *
 * 为什么还留着：`EmptyState` 曾被首页/详情/编辑多处引用，一次性删掉会让未同步改完的页面
 * 直接编译失败。这里保留原导出与入参（`title` / `hint` / `icon`），内部转调 `StateView`
 * 的 `empty` 形态，因此**视觉与文案立刻统一**，调用方无需改动。
 *
 * 将来可删：等全仓 `grep EmptyState` 只剩本文件与测试时，直接删除本文件，调用方改用
 * `StateView({ kind: 'empty', title, detail })`。
 *
 * 契约：`docs/CONTRACT.md` §3.4（页面/组件统一风格）。共享层组件 —— 不含任何手写/OCR/PixelMap 代码，
 * Android 与 HarmonyOS 都能编译。
 */
import { StateView } from './StateView';

@Component
export struct EmptyState {
  /** 主提示语（正文级字号）。 */
  @Prop title: string = '暂无内容';
  /** 次要说明（辅助级字号，可为空）。 */
  @Prop hint: string = '';
  /**
   * 旧版 emoji 图标位。
   *
   * 保留该参数只为兼容既有调用方（`Edit.ets` / `Detail.ets` 仍会传），**不再渲染**：
   * 48fp 的装饰性 emoji 与「字号层级只有 3 级」冲突，且深色模式下颜色不可控。
   */
  @Prop icon: string = '';

  build() {
    StateView({ kind: 'empty', title: this.title, detail: this.hint })
  }
}
