/**
 * 设置页：设备标识 / 作者名 / 仓库 URL / token / DeepSeek key + Git 同步区 + 平台信息 + AGC 说明。
 *
 * 契约：BRIEF §3.4 / §3.5、`docs/CONTRACT.md` §3.4。
 * 同步实现由执行者 G 提供（`services/GitSyncService.ets`），本页只做三件事：
 * 1. 内嵌**隐藏**的 `Web` 环境加载 `rawfile/git/index.html`（isomorphic-git + 桥接脚本）；
 * 2. `onPageEnd` 时 `registerProxy()` 并 `configure()`；
 * 3. 按钮触发 `pull()/push()/status()`，把结果与错误显示在页面上。
 *
 * 注意：token / AI key 只存本机 preferences，永不进入同步载荷或日志。
 */
import { promptAction, router } from '@kit.ArkUI';
import { webview } from '@kit.ArkWeb';
import { common } from '@kit.AbilityKit';
import { nowIso } from '../common/date';
import { getFeatures } from '../common/features';
import { isHarmonyOS } from '../common/platform';
import { DEVICE_ID_PATTERN, normalizeDeviceId, settingsStore } from '../services/settingsStore';
import { describeError, scheduleStore } from '../services/scheduleStore';
import { GitSyncService } from '../services/GitSyncService';
import type { GitSyncConfig, GitSyncResult } from '../services/GitSyncService';

/** 同步分支：与 `docs/DATA-CONTRACT.md` §1 一致，固定 main。 */
const SYNC_BRANCH: string = 'main';

@Entry
@Component
struct Settings {
  @State deviceId: string = 'phone-a';
  @State author: string = '';
  @State repoUrl: string = '';
  @State token: string = '';
  @State aiKey: string = '';
  @State ready: boolean = false;
  @State saveHint: string = '';
  @State syncMessage: string = '同步内核尚未就绪：请保持本页打开，等待隐藏 Web 环境加载完成';
  @State syncBusy: boolean = false;
  @State webReady: boolean = false;
  @State platformText: string = '';
  @State handwritingText: string = '';
  @State ocrText: string = '';
  @State storageHint: string = '';
  /** 从列表页跳转过来时要自动执行的同步动作（pull / push / status）。 */
  private autoAction: string = '';
  private gitController: webview.WebviewController = new webview.WebviewController();
  private sync: GitSyncService = new GitSyncService(this.gitController);
  private disposed: boolean = false;

  aboutToAppear(): void {
    this.platformText = isHarmonyOS() ? 'HarmonyOS' : 'Android';
    const features = getFeatures();
    this.handwritingText = features.handwriting ? '可用（Canvas 分页手写 + 逐页截图落盘）' : '不可用';
    this.ocrText = features.ocr ? '可用（textRecognition 逐页串行识别）' : '不可用';
    this.readAutoAction();
    this.bootstrap();
  }

  aboutToDisappear(): void {
    // 页面销毁后不要再改状态（异步回调里用 disposed 拦截），避免销毁后 setState 崩溃
    this.disposed = true;
    this.webReady = false;
  }

  private readAutoAction(): void {
    try {
      const params = router.getParams() as Record<string, string>;
      if (params === undefined || params === null) {
        return;
      }
      const action = params['autoAction'];
      if (action !== undefined) {
        this.autoAction = action;
      }
    } catch {
      this.autoAction = '';
    }
  }

  private async bootstrap(): Promise<void> {
    const context = getContext(this) as common.UIAbilityContext;
    try {
      await settingsStore.init(context);
      const settings = await settingsStore.load();
      if (this.disposed) {
        return;
      }
      this.deviceId = settings.deviceId;
      this.author = settings.author;
      this.repoUrl = settings.repoUrl;
      this.token = settings.token;
      this.aiKey = settings.aiKey;
      // 让 Git 桥使用与应用一致的沙箱根目录（G 的服务支持静态预置，缺省时才回落 getContext()）
      GitSyncService.setFilesDir(context.filesDir);
      await scheduleStore.ensureReady(context);
      if (this.disposed) {
        return;
      }
      this.ready = true;
      this.storageHint = `日程目录：${scheduleStore.deviceRoot()}/schedules/`;
      this.configure();
      // Web 先于设置就绪时，自动动作排在这里补触发
      if (this.webReady && this.autoAction.length > 0) {
        const pending = this.autoAction;
        this.autoAction = '';
        this.runAction(pending);
      }
    } catch (error) {
      if (this.disposed) {
        return;
      }
      this.ready = false;
      this.saveHint = `初始化失败：${describeError(error)}`;
    }
  }

  /** 作者邮箱按设备标识派生（同步提交只用于署名，不涉及个人邮箱）。 */
  private authorEmail(): string {
    const id = normalizeDeviceId(this.deviceId);
    return `${id}@schedule.local`;
  }

  /** 把表单内容推给 GitSyncService（每次操作前都推一次，避免用旧配置）。 */
  private configure(): void {
    const config: GitSyncConfig = {
      repoUrl: this.repoUrl.trim(),
      branch: SYNC_BRANCH,
      deviceId: normalizeDeviceId(this.deviceId),
      token: this.token.trim(),
      authorName: this.author.trim().length > 0 ? this.author.trim() : normalizeDeviceId(this.deviceId),
      authorEmail: this.authorEmail()
    };
    this.sync.configure(config);
  }

  private async saveSettings(): Promise<void> {
    const deviceId = normalizeDeviceId(this.deviceId);
    if (!DEVICE_ID_PATTERN.test(this.deviceId.trim().toLowerCase())) {
      this.saveHint = '设备标识不合法：只能用小写字母、数字与「-」，且以字母或数字开头，最长 32 位（已回退为 ' + deviceId + '）';
    } else {
      this.saveHint = '';
    }
    const context = getContext(this) as common.UIAbilityContext;
    try {
      const saved = await settingsStore.save(
        {
          deviceId: deviceId,
          repoUrl: this.repoUrl,
          token: this.token,
          aiKey: this.aiKey,
          author: this.author
        },
        context
      );
      if (this.disposed) {
        return;
      }
      this.deviceId = saved.deviceId;
      this.author = saved.author;
      this.repoUrl = saved.repoUrl;
      this.token = saved.token;
      this.aiKey = saved.aiKey;
      scheduleStore.setDeviceId(saved.deviceId);
      this.storageHint = `日程目录：${scheduleStore.deviceRoot()}/schedules/`;
      this.configure();
      this.saveHint = `设置已保存（${nowIso()}）`;
      promptAction.showToast({ message: '设置已保存' });
    } catch (error) {
      if (this.disposed) {
        return;
      }
      this.saveHint = `保存失败：${describeError(error)}`;
    }
  }

  /**
   * `Web` 页面加载完成回调。
   *
   * 注意 `GitSyncService.registerProxy()` 内部会 `controller.refresh()`，所以本方法会被
   * **调用两次**：第一次注册代理并触发刷新，第二次（刷新后的 onPageEnd）才算真正就绪。
   * 因此用 `sync.isReady()` 做幂等保护，避免「注册 → 刷新 → 再注册 → 再刷新」的死循环。
   */
  private onWebReady(): void {
    if (this.disposed) {
      return;
    }
    this.configure();
    if (!this.sync.isReady()) {
      try {
        this.sync.registerProxy();
        this.syncMessage = '同步内核已注册，正在初始化页面…';
      } catch (error) {
        this.syncMessage = `注册同步代理失败：${describeError(error)}`;
      }
      return;
    }
    this.webReady = true;
    if (!this.ready) {
      // 设置还在读盘：保留 autoAction，等 bootstrap 完成后由它触发，避免用空仓库地址发请求
      this.syncMessage = '同步内核已就绪，正在读取设置…';
      return;
    }
    this.syncMessage = this.repoUrl.trim().length === 0
      ? '同步内核已就绪；请先填写仓库地址并保存'
      : '同步内核已就绪，可以拉取 / 推送 / 查看状态';
    const pending = this.autoAction;
    this.autoAction = '';
    if (pending.length > 0) {
      this.runAction(pending);
    }
  }

  private async runAction(action: string): Promise<void> {
    if (!this.webReady) {
      this.syncMessage = '同步内核尚未就绪，请稍候再试（隐藏 Web 环境仍在加载）';
      return;
    }
    if (this.repoUrl.trim().length === 0) {
      this.syncMessage = '请先填写仓库地址（https:// 或 git@ 形式）并保存';
      return;
    }
    // ArkTS 要求对象字面量有显式声明类型，这里用显式分支代替 Record 字面量
    let label: string = action;
    if (action === 'pull') {
      label = '拉取';
    } else if (action === 'push') {
      label = '推送';
    } else if (action === 'status') {
      label = '查询状态';
    }
    this.syncBusy = true;
    this.syncMessage = `正在${label}…`;
    try {
      this.configure();
      let result: GitSyncResult;
      if (action === 'pull') {
        result = await this.sync.pull();
      } else if (action === 'push') {
        result = await this.sync.push(`日程同步：${nowIso()}`);
      } else {
        result = await this.sync.status();
      }
      if (this.disposed) {
        return;
      }
      const mark = result.ok ? '✅' : '❌';
      const commit = result.commit === undefined || result.commit.length === 0 ? '' : `（commit ${result.commit}）`;
      this.syncMessage = `${mark} ${result.message}${commit}`;
    } catch (error) {
      if (this.disposed) {
        return;
      }
      this.syncMessage = `❌ ${label}失败：${describeError(error)}`;
    } finally {
      if (!this.disposed) {
        this.syncBusy = false;
      }
    }
  }

  @Builder
  FieldLabel(text: string) {
    Text(text)
      .fontSize(13)
      .fontColor($r('app.color.text_secondary'))
      .width('100%')
      .textAlign(TextAlign.Start)
  }

  @Builder
  Card(title: string) {
    Text(title)
      .fontSize(15)
      .fontWeight(FontWeight.Bold)
      .fontColor($r('app.color.text_primary'))
      .width('100%')
      .textAlign(TextAlign.Start)
  }

  @Builder
  SyncPanel() {
    Column({ space: 10 }) {
      this.Card('Git 同步')
      Text(this.syncMessage)
        .fontSize(12)
        .fontColor(this.syncMessage.startsWith('❌') ? '#D94838' : $r('app.color.text_secondary'))
        .width('100%')
        .textAlign(TextAlign.Start)

      Row({ space: 8 }) {
        Button('拉取')
          .layoutWeight(1)
          .height(40)
          .backgroundColor($r('app.color.brand'))
          .fontColor(Color.White)
          .enabled(!this.syncBusy)
          .onClick(() => {
            this.runAction('pull');
          })
        Button('推送')
          .layoutWeight(1)
          .height(40)
          .backgroundColor('#E8F1FF')
          .fontColor($r('app.color.brand'))
          .enabled(!this.syncBusy)
          .onClick(() => {
            this.runAction('push');
          })
        Button('查看状态')
          .layoutWeight(1)
          .height(40)
          .backgroundColor('#E8F1FF')
          .fontColor($r('app.color.brand'))
          .enabled(!this.syncBusy)
          .onClick(() => {
            this.runAction('status');
          })
      }
      .width('100%')

      Text('同步只写本机目录 devices/<设备标识>/，不会重写其他设备的历史文件。')
        .fontSize(11)
        .fontColor($r('app.color.text_secondary'))
        .width('100%')
        .textAlign(TextAlign.Start)

      // 隐藏的 Git 运行环境：1x1、全透明，只用于执行 isomorphic-git
      Stack() {
        Web({ src: $rawfile('git/index.html'), controller: this.gitController })
          .width(1)
          .height(1)
          .opacity(0)
          .onPageEnd(() => {
            this.onWebReady();
          })
          .onErrorReceive(() => {
            if (!this.disposed) {
              this.syncMessage = '❌ 同步内核加载失败：rawfile/git/index.html 无法加载';
            }
          })
      }
      .width(1)
      .height(1)
      .opacity(0)
    }
    .width('100%')
    .padding(12)
    .backgroundColor(Color.White)
    .borderRadius(12)
  }

  @Builder
  PlatformPanel() {
    Column({ space: 8 }) {
      this.Card('平台信息')
      Row() {
        Text('运行平台')
          .fontSize(13)
          .fontColor($r('app.color.text_secondary'))
        Blank()
        Text(this.platformText)
          .fontSize(13)
          .fontColor($r('app.color.text_primary'))
      }
      .width('100%')

      Row() {
        Text('手写板')
          .fontSize(13)
          .fontColor($r('app.color.text_secondary'))
        Blank()
        Text(this.handwritingText)
          .fontSize(13)
          .fontColor($r('app.color.text_primary'))
      }
      .width('100%')

      Row() {
        Text('OCR')
          .fontSize(13)
          .fontColor($r('app.color.text_secondary'))
        Blank()
        Text(this.ocrText)
          .fontSize(13)
          .fontColor($r('app.color.text_primary'))
      }
      .width('100%')

      if (this.storageHint.length > 0) {
        Text(this.storageHint)
          .fontSize(11)
          .fontColor($r('app.color.text_secondary'))
          .width('100%')
          .textAlign(TextAlign.Start)
      }
    }
    .width('100%')
    .padding(12)
    .backgroundColor(Color.White)
    .borderRadius(12)
  }

  @Builder
  AgcPanel() {
    Column({ space: 8 }) {
      this.Card('提醒权限与开放能力（AGC）')
      Text(
        '日历提醒依赖 ohos.permission.PUBLISH_AGENT_REMINDER，单应用最多 30 条；权限未获批时降级为应用内通知。\n\n' +
        '线上签名 / 真机安装步骤：\n' +
        '1. 登录 AppGallery Connect → 我的项目 → 选择本应用 →「开放能力」申请日历提醒/通知相关权限；\n' +
        '2. 审核通过后到「证书、APP ID 和 Profile」重新生成 Profile；\n' +
        '3. DevEco Studio → Project Structure → Signing Configs 勾选手动签名，导入 .p12 与 .p7b（关闭 Automatically generate signature）；\n' +
        '4. 重新安装应用，首次创建提醒时按系统弹窗授权；\n' +
        '5. 开放能力审批周期约 8 个工作日，请预留时间。\n\n' +
        '本地调试：未签名的调试包可以创建提醒但无法上架；通知通道需要用户手动允许。'
      )
        .fontSize(12)
        .fontColor($r('app.color.text_primary'))
        .width('100%')
        .textAlign(TextAlign.Start)
        .lineHeight(19)
    }
    .width('100%')
    .padding(12)
    .backgroundColor(Color.White)
    .borderRadius(12)
  }

  build() {
    Column() {
      Row({ space: 8 }) {
        Text('‹')
          .fontSize(26)
          .fontColor($r('app.color.text_primary'))
          .padding({ left: 4, right: 4 })
          .onClick(() => {
            router.back();
          })
        Text('设置')
          .fontSize(18)
          .fontWeight(FontWeight.Bold)
          .fontColor($r('app.color.text_primary'))
          .layoutWeight(1)
      }
      .width('100%')
      .padding({ left: 12, right: 12, top: 12, bottom: 8 })

      Scroll() {
        Column({ space: 12 }) {
          Column({ space: 8 }) {
            this.Card('本机与仓库')
            this.FieldLabel('设备标识（决定 devices/<id>/ 目录）')
            TextInput({ text: this.deviceId, placeholder: 'phone-a' })
              .width('100%')
              .height(44)
              .backgroundColor('#F7F9FB')
              .borderRadius(10)
              .onChange((value: string) => {
                this.deviceId = value;
              })

            this.FieldLabel('作者名（写入日程 author 字段）')
            TextInput({ text: this.author, placeholder: '例如：我' })
              .width('100%')
              .height(44)
              .backgroundColor('#F7F9FB')
              .borderRadius(10)
              .onChange((value: string) => {
                this.author = value;
              })

            this.FieldLabel('仓库 URL')
            TextInput({ text: this.repoUrl, placeholder: 'https://github.com/<user>/<repo>.git' })
              .width('100%')
              .height(44)
              .backgroundColor('#F7F9FB')
              .borderRadius(10)
              .onChange((value: string) => {
                this.repoUrl = value;
              })

            this.FieldLabel('访问 token（HTTPS，仅存本机）')
            TextInput({ text: this.token, placeholder: 'ghp_… / gitee token' })
              .type(InputType.Password)
              .width('100%')
              .height(44)
              .backgroundColor('#F7F9FB')
              .borderRadius(10)
              .onChange((value: string) => {
                this.token = value;
              })

            this.FieldLabel('DeepSeek API Key（AI 汇总用，仅存本机）')
            TextInput({ text: this.aiKey, placeholder: 'sk-…' })
              .type(InputType.Password)
              .width('100%')
              .height(44)
              .backgroundColor('#F7F9FB')
              .borderRadius(10)
              .onChange((value: string) => {
                this.aiKey = value;
              })

            Button('保存设置')
              .width('100%')
              .height(44)
              .backgroundColor($r('app.color.brand'))
              .fontColor(Color.White)
              .enabled(this.ready)
              .onClick(() => {
                this.saveSettings();
              })

            if (this.saveHint.length > 0) {
              Text(this.saveHint)
                .fontSize(12)
                .fontColor(this.saveHint.startsWith('设置已保存') ? $r('app.color.brand') : '#D94838')
                .width('100%')
                .textAlign(TextAlign.Start)
            }
          }
          .width('100%')
          .padding(12)
          .backgroundColor(Color.White)
          .borderRadius(12)

          this.SyncPanel()
          this.PlatformPanel()
          this.AgcPanel()
        }
        .width('100%')
        .padding({ left: 12, right: 12, bottom: 24 })
      }
      .layoutWeight(1)
      .width('100%')
      .align(Alignment.TopStart)
    }
    .width('100%')
    .height('100%')
    .backgroundColor($r('app.color.page_background'))
  }
}
