/**
 * 编辑页（薄壳）：只做路由参数读取 + 复用 `RecordEditorView`。
 *
 * 真正的表单/保存逻辑在 `components/RecordEditorView.ets`，与首页横屏右栏共用同一份实现。
 * 手写板返回时 `onPageShow` 把 `refreshTick` 加一，组件据此读 AppStorage 回填并清键。
 */
import { router } from '@kit.ArkUI';
import { PageLayout } from '../components/PageLayout';
import { RecordEditorView } from '../components/RecordEditorView';

@Entry
@Component
struct Edit {
  @State recordId: string = '';
  @State defaultDate: string = '';
  /** 子组件回填触发器（手写板返回 +1）。 */
  @State tick: number = 0;

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

  build() {
    Stack({ alignContent: Alignment.TopStart }) {
      PageLayout({
        title: this.recordId.length > 0 ? '编辑日程' : '新建日程',
        subtitle: this.defaultDate,
        onBack: () => {
          router.back();
        }
      }) {
        RecordEditorView({
          recordId: this.recordId,
          defaultDate: this.defaultDate,
          refreshTick: this.tick,
          onSaved: () => {
            router.back();
          },
          onCancel: () => {
            router.back();
          }
        })
      }
    }
    .width('100%')
    .height('100%')
  }
}
