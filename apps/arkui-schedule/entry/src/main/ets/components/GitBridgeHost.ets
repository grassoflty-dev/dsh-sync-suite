/**
 * GitBridgeHost — 一个**不可见**的 `Web` 宿主，只为同步/附件 zip 提供 WebView 环境。
 *
 * 背景：`GitSyncService` 必须在构造时拿到 `webview.WebviewController`，而控制器只能由
 * 页面里的 `Web` 组件通过 `onControllerAttached`/`onReady` 交出。此前只有设置页创建过
 * `Web`，导致「启动自动 pull」「附件按天 zip」在别的页面拿不到桥能力。
 *
 * 用法（父页面）：
 * ```ts
 * GitBridgeHost({ onReady: (controller: webview.WebviewController) => { ... } })
 *   .width(1).height(1).opacity(0)   // 不占布局、不可见
 * ```
 * 组件本身不渲染任何可见 UI，也不拦截点击。
 */
import { webview } from '@kit.ArkWeb';

@Component
export struct GitBridgeHost {
  /** 桥页面加载完成、控制器可用时回调（只会回调一次）。 */
  onReady: (controller: webview.WebviewController) => void = () => {};
  /** 加载失败（打包进来的 rawfile 缺失等）时回调，便于上层提示。 */
  onFail: (message: string) => void = () => {};

  private controller: webview.WebviewController = new webview.WebviewController();
  private delivered: boolean = false;

  build() {
    Web({ src: $rawfile('git/index.html'), controller: this.controller })
      .width('100%')
      .height('100%')
      .javaScriptAccess(true)
      .domStorageAccess(true)
      .fileAccess(true)
      .imageAccess(false)
      .zoomAccess(false)
      .horizontalScrollBarAccess(false)
      .verticalScrollBarAccess(false)
      .onPageEnd(() => {
        // 页面脚本执行完毕才是「桥可用」的时刻（isomorphic-git + jszip + git-bridge 都到位）
        if (this.delivered) {
          return;
        }
        this.delivered = true;
        this.onReady(this.controller);
      })
      .onErrorReceive(() => {
        this.onFail('同步桥页面加载失败');
      })
  }
}
