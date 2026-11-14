/**
 * 应用入口 Ability（共享，Android 与 HarmonyOS 共用同一份源码）。
 *
 * 启动顺序（契约 `docs/CONTRACT.md` §3.1）：
 * 1. `installPlatformFeatures()`：解析到**当前平台**的覆盖文件 —— 鸿蒙覆盖层写
 *    `setPlatform('harmony')` + 打开手写/OCR，共享默认实现写 `setPlatform('android')` + 关闭；
 * 2. 初始化设置（preferences）与日程存储（`<filesDir>/git-repo/devices/<deviceId>/`）；
 * 3. 加载首页 `pages/Index`。
 *
 * 本文件只 import 共享层模块，不引用任何 OCR / 手写 / 截图代码，Android 侧可正常编译。
 */
import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { installPlatformFeatures } from '../common/platformFeatures';
import { scheduleStore } from '../services/scheduleStore';

const DOMAIN: number = 0x0000;
const TAG: string = 'ScheduleEntry';

export default class EntryAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    // 平台能力必须先于任何页面渲染装配（页面在 build/aboutToAppear 里读 getFeatures()）
    installPlatformFeatures();
    hilog.info(DOMAIN, TAG, 'EntryAbility 启动，平台能力已装配');

    scheduleStore
      .ensureReady(this.context)
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
