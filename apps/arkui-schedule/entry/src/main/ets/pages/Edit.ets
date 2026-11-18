/**
 * 编辑页（薄壳）：只做路由参数读取 + 复用 `RecordEditorView`。
 *
 * 真正的表单/保存逻辑在 `components/RecordEditorView.ets`，与首页横屏右栏共用同一份实现。
 * 手写板返回时 `onPageShow` 把 `refreshTick` 加一，组件据此读 AppStorage 回填并清键。
 *
 * 返回守卫（`docs/FAILURE-MODES.md` §6 的 P1）：页内不自己复制脏状态——组件通过
 * `onRegisterGuard` 把「同步探针 + 放弃草稿动作」登记过来。脏时先问一句再退，不脏直接放行；
 * 系统返回手势 / 返回键 / 页面左上角返回 / 「取消」按钮四个入口走同一套逻辑。
 */
import { promptAction, router } from '@kit.ArkUI';
import { PageLayout } from '../components/PageLayout';
import { RecordEditorView } from '../components/RecordEditorView';

@Entry
@Component
struct Edit {
  @State recordId: string = '';
  @State defaultDate: string = '';
  /** 子组件回填触发器（手写板返回 +1）。 */
  @State tick: number = 0;

  /**
   * 子组件登记的「现在的编辑内容脏不脏」同步探针。
   *
   * 默认实现返回 `false`：组件没登记（或已卸载）时一律不拦返回——拦错比没拦住更恼人；
   * 没拦住时草稿仍在磁盘上，下次进来还能恢复。
   */
  private dirtyProbe: () => boolean = (): boolean => false;
  /** 子组件登记的「放弃草稿」动作（用户确认放弃后调用，删本记录的草稿键）；默认什么也不做。 */
  private discardDraft: () => void = (): void => {};
  /** 已经确认放弃、正在退出：避免 `router.back()` 再次触发 `onBackPress` 形成弹窗循环。 */
  private leaving: boolean = false;

  aboutToAppear(): void {
    try {
      const params = router.getParams() as Record<string, string>;
      if (params !== undefined && params !== null) {
        const id = params['id'];
        if (id !== undefined && id.length > 0) {
          this.recordId = id;
        }
        const date = params['date'];
        if (date !== undefined && date.length > 0) {
          this.defaultDate = date;
        }
      }
    } catch (error) {
      this.recordId = '';
    }
  }

  /** 从手写板返回：让子组件读回填数据。 */
  onPageShow(): void {
    this.tick = this.tick + 1;
  }

  /**
   * 系统返回手势 / 返回键：脏就拦下问一句（返回 `true` 吃掉本次返回），不脏直接放行。
   *
   * 旧实现没有这个钩子，误触返回 = 刚打的字直接丢且没有撤销（§6 表格第 3 行）。
   */
  onBackPress(): boolean {
    if (this.leaving) {
      return false;
    }
    if (!this.dirtyProbe()) {
      return false;
    }
    this.confirmLeave();
    return true;
  }

  /** 左上角返回 / 「取消」：与返回键同一套判断（不脏就直接退，脏就先问）。 */
  private leave(): void {
    if (this.leaving) {
      return;
    }
    if (!this.dirtyProbe()) {
      this.leaving = true;
      router.back();
      return;
    }
    this.confirmLeave();
  }

  /** 「放弃当前编辑？」确认框（文案风格与首页 `guardEditor` 一致）。 */
  private confirmLeave(): void {
    promptAction
      .showDialog({
        title: '放弃当前编辑？',
        message: '刚打的字还没保存，返回后会丢失。',
        buttons: [
          // 颜色一律走资源令牌（深色下系统对话框是深底，写死深灰字会直接看不见）
          { text: '继续编辑', color: $r('app.color.text_primary') },
          { text: '放弃修改', color: $r('app.color.selection_stroke') }
        ]
      })
      .then((result: promptAction.ShowDialogSuccessResponse) => {
        if (result.index === 1) {
          this.leaving = true;
          this.discardDraft();
          router.back();
        }
      })
      .catch(() => {
        // 对话框失败：保持当前编辑，不做危险动作
      });
  }

  build() {
    Stack({ alignContent: Alignment.TopStart }) {
      PageLayout({
        title: this.recordId.length > 0 ? '编辑日程' : '新建日程',
        subtitle: this.defaultDate,
        onBack: () => {
          this.leave();
        }
      }) {
        RecordEditorView({
          recordId: this.recordId,
          defaultDate: this.defaultDate,
          refreshTick: this.tick,
          onSaved: () => {
            this.leaving = true;
            router.back();
          },
          onCancel: () => {
            this.leave();
          },
          onRegisterGuard: (probe: () => boolean, discard: () => void): void => {
            this.dirtyProbe = probe;
            this.discardDraft = discard;
          }
        })
      }
    }
    .width('100%')
    .height('100%')
  }
}
