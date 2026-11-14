/**
 * 平台能力装配 —— **HarmonyOS 覆盖实现**。
 *
 * 与共享层 `entry/src/main/ets/common/platformFeatures.ts` 同名相对路径，
 * 鸿蒙构建时整体替换共享实现（`docs/CONTRACT.md` §3.1）。因此这里必须：
 * - `setPlatform('harmony')`：页面才能正确判定 `isHarmonyOS()`；
 * - `setFeatures({ handwriting: true, ocr: true })`：打开手写板与 OCR 入口；
 * - 提供真实的手写页路由与系统日历提醒实现（共享层不能引用它们）。
 *
 * 关键：这里的 `setPlatform('harmony')` **不依赖运行时检测结果**。`EntryAbility.onCreate` 会先同步
 * 调一次 `installPlatformFeatures()`（第一道防线，页面 `aboutToAppear()` 立刻读到正确开关），再用
 * `detectPlatform()` 的结果重放（第二道防线）。即使设备检测失败/误判为 android，本覆盖层仍然让
 * 「鸿蒙构建 = 鸿蒙能力」，保证 sourceRoots 生效时手写/OCR 一定可用。
 */
import { setFeatures } from './features';
import { setPlatform } from './platform';
import { ReminderService } from '../reminder/ReminderService';
import { common } from '@kit.AbilityKit';
import type { ScheduleRecord } from '../model/types';

/** 安装鸿蒙平台能力：平台标记 + 打开手写/OCR。 */
export function installPlatformFeatures(): void {
  setPlatform('harmony');
  setFeatures({ handwriting: true, ocr: true });
}

/** 手写板页面路径（仅鸿蒙清单 `entry/src/harmony/resources/base/profile/main_pages.json` 登记）。 */
export function handwritingPageRoute(): string {
  return 'pages/Handwriting';
}

/**
 * 依据日程记录创建系统提醒。
 * 权限未获批时 ReminderService 自动降级为应用内通知，返回中文结果说明。
 */
export async function createReminders(records: ScheduleRecord[], context: object): Promise<string> {
  const abilityContext = context as common.UIAbilityContext;
  const service = new ReminderService(abilityContext);
  const result = await service.createForRecords(records);
  return result.message;
}
