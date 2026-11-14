/**
 * 应用入口 Ability（共享，Android 与 HarmonyOS 共用同一份源码）。
 *
 * 启动顺序（契约 `docs/CONTRACT.md` §3.1，两级装配）：
 * 1. **第一道防线（同步）**：先 `setPlatform('android')` 再 `installPlatformFeatures()` —— 立刻处于
 *    fail-closed 状态，保证 Android 侧页面 `aboutToAppear()` 读到的手写/OCR 开关一定是关的；
 *    鸿蒙构建时 `platformFeatures.ts` 被覆盖层整体替换，于是这里同步得到 `'harmony'` + 能力开启
 *    （覆盖层不依赖检测结果，见 `entry/src/harmony/ets/common/platformFeatures.ts`）。
 * 2. **第二道防线（异步）**：`detectPlatform()` 读设备信息（鸿蒙覆盖层读 `deviceInfo`，共享实现返回
 *    `'android'`）→ `setPlatform(p)` → 再 `installPlatformFeatures()`。用 `.then()` 链，不阻塞
 *    生命周期；检测/装配失败时 hilog 记录并按 Android 降级。
 * 3. 最后初始化日程存储（`<filesDir>/git-repo/devices/<deviceId>/`），页面加载首页 `pages/Index`。
 *
 * 本文件只 import 共享层模块（`../common/devicePlatform`、`../common/platformFeatures` 在 Android
 * 产物里解析到不带 @ohos SDK 的共享实现），不引用任何 OCR / 手写 / 截图代码，Android 侧可正常编译。
 */
import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { detectPlatform } from '../common/devicePlatform';
import { getPlatform, setPlatform } from '../common/platform';
import { installPlatformFeatures } from '../common/platformFeatures';
import { scheduleStore } from '../services/scheduleStore';

const DOMAIN: number = 0x0000;
const TAG: string = 'ScheduleEntry';

export default class EntryAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    // 第一道防线：同步 fail-closed（鸿蒙覆盖层会在此处直接切成 harmony + 能力开启）
    setPlatform('android');
    installPlatformFeatures();
    hilog.info(DOMAIN, TAG, 'EntryAbility 启动，平台能力已装配（fail-closed 初值）');

    // 第二道防线：异步探测真实设备平台，结果覆盖上面的初值；不阻塞生命周期
    detectPlatform()
      .then((platform) => {
        setPlatform(platform);
        installPlatformFeatures();
        hilog.info(DOMAIN, TAG, '平台检测完成：%{public}s', getPlatform());
      })
      .catch((error: Error) => {
        // 检测失败不能阻断启动：按 Android 降级并如实记录
        hilog.error(DOMAIN, TAG, '平台检测失败，按 Android 降级：%{public}s', error.message);
        setPlatform('android');
        installPlatformFeatures();
      })
      .then(() => {
        return scheduleStore.ensureReady(this.context);
      })
      .then(() => {
        hilog.info(DOMAIN, TAG, '存储就绪：%{public}s', scheduleStore.deviceRoot());
      })
      .catch((error: Error) => {
        hilog.error(DOMAIN, TAG, '存储初始化失败：%{public}s', error.message);
      });
  }

  onDestroy(): void {
    hilog.info(DOMAIN, TAG, 'EntryAbility onDestroy');
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.loadContent('pages/Index', (err) => {
      if (err.code !== 0) {
        hilog.error(DOMAIN, TAG, '加载首页失败：%{public}s', JSON.stringify(err));
        return;
      }
      hilog.info(DOMAIN, TAG, '首页加载完成');
    });
  }

  onWindowStageDestroy(): void {
    hilog.info(DOMAIN, TAG, 'onWindowStageDestroy');
  }

  onForeground(): void {
    hilog.info(DOMAIN, TAG, 'onForeground');
  }

  onBackground(): void {
    hilog.info(DOMAIN, TAG, 'onBackground');
  }
}
