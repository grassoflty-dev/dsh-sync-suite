/**
 * 平台能力装配 —— **共享默认实现**（Android / 未知平台走本文件）。
 *
 * 平台覆盖语义（`docs/CONTRACT.md` §3.1）：构建某平台时源码 = `main` + 该平台目录，
 * 同名相对路径以后者为准。`entry/src/harmony/ets/common/platformFeatures.ts` 会整体替换本文件，
 * 在鸿蒙侧无条件打开手写/OCR 并显式 `setPlatform('harmony')`（不依赖运行时检测结果）。
 *
 * 本文件是**第二道防线**：不再写死 `'android'`，而是按 `getPlatform()` 装配 ——
 * `EntryAbility.onCreate` 先用 `setPlatform('android')` 把初值钉成 fail-closed，再被
 * `devicePlatform.detectPlatform()` 的结果覆盖（鸿蒙覆盖层读 `deviceInfo`，共享实现恒为 `'android'`）。
 * 因此 Android 产物里这里只会走关闭分支；只有「平台=harmony」时才打开能力（BRIEF §3.3）。
 *
 * 前提：调用方必须先 `setPlatform(...)` 再调本函数（`getPlatform()` 未设置时默认 `'harmony'`，
 * 这是契约 §3.2 的历史语义，EntryAbility 已按此顺序调用）。
 *
 * 契约：`docs/CONTRACT.md` §3.1 / §3.2、BRIEF §3.1。
 *
 * 除任务书指定的 `installPlatformFeatures()` 之外，本文件额外导出两个「平台钩子」：
 * - `handwritingPageRoute()`：共享层不能出现手写页面的路径字面量（validate 规则 4 会把
 *   共享/Android 侧的手写页名字符串判为不可编译），故由平台覆盖文件提供路由；
 * - `createReminders()`：系统日历提醒（`reminderAgentManager`）只在鸿蒙存在，且其实现
 *   `entry/src/harmony/ets/reminder/ReminderService.ets` 不在共享层，故同样由平台覆盖文件实现。
 */
import { setFeatures } from './features';
import { getPlatform } from './platform';
import type { ScheduleRecord } from '../model/types';

/**
 * 安装当前平台的能力开关。
 * 共享默认实现：按 `getPlatform()` 装配 —— harmony → 手写/OCR 可用，其余（含 Android）关闭。
 */
export function installPlatformFeatures(): void {
  const platform = getPlatform();
  if (platform === 'harmony') {
    setFeatures({ handwriting: true, ocr: true });
    return;
  }
  setFeatures({ handwriting: false, ocr: false });
}

/**
 * 手写板页面的路由路径。
 * 共享默认实现返回空串：Android 侧没有该页面（也不允许出现该路径字面量）。
 */
export function handwritingPageRoute(): string {
  return '';
}

/**
 * 依据日程记录创建系统提醒，返回面向用户的中文结果说明。
 * 共享默认实现无系统提醒能力，直接返回说明（不抛错，页面照常提示）。
 *
 * @param records 待生成提醒的日程（鸿蒙实现内部再用 `buildReminderPlan` 过滤未来未完成项）
 * @param context UIAbilityContext（鸿蒙实现用它申请权限与发通知）
 */
export function createReminders(records: ScheduleRecord[], context: object): Promise<string> {
  // 共享层没有系统提醒 API 可用：如实说明「未创建」，不静默假装成功。
  const count = records.length;
  const hasContext = context !== null;
  const detail = count === 0 ? '没有可提醒的日程' : `${count} 条日程未创建提醒`;
  const suffix = hasContext ? '' : '（上下文缺失）';
  return Promise.resolve(`当前平台（Android）不支持系统日历提醒：${detail}${suffix}。请在 HarmonyOS 设备上使用该功能`);
}
