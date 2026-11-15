/**
 * 详情页（薄壳）：只做路由参数读取 + 复用 `RecordDetailView`。
 *
 * 真正的展示/保存逻辑在 `components/RecordDetailView.ets`，与首页横屏右栏共用同一份实现，
 * 避免两套 UI 漂移。行为不变：AI 结构化可编辑保存、原始 OCR 只读、附件缩略/全屏、编辑入口。
 */
import { router } from '@kit.ArkUI';
import { PageLayout } from '../components/PageLayout';
import { RecordDetailView } from '../components/RecordDetailView';

@Entry
@Component
struct Detail {
  @State recordId: string = '';
  /** 子组件重读触发器（编辑页返回后 +1）。 */
  @State tick: number = 0;

  aboutToAppear(): void {
    try {
      const params = router.getParams() as Record<string, string>;
      if (params !== undefined && params !== null) {
        const id = params['id'];
        if (id !== undefined && id.length > 0) {
          this.recordId = id;
        }
      }
    } catch (error) {
      this.recordId = '';
    }
  }

  /** 从编辑页返回：刷新右侧内容。 */
  onPageShow(): void {
    this.tick = this.tick + 1;
  }

  private openEdit(): void {
    if (this.recordId.length === 0) {
      return;
    }
    const params: Record<string, string> = { 'id': this.recordId };
    router.pushUrl({ url: 'pages/Edit', params: params }).catch(() => {
      // 打不开编辑页时保持当前页，不弹错（详情仍可读）
    });
  }

  build() {
    Stack({ alignContent: Alignment.TopStart }) {
      PageLayout({
        title: '日程详情',
        subtitle: '',
        onBack: () => {
          router.back();
        }
      }) {
        RecordDetailView({
          recordId: this.recordId,
          refreshTick: this.tick,
          onEdit: () => {
            this.openEdit();
          }
        })
      }
    }
    .width('100%')
    .height('100%')
  }
}
