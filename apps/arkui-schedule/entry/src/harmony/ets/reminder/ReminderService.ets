/**
 * 系统提醒（**仅 HarmonyOS**）：日历提醒 + 权限未获批时降级为应用内通知。
 *
 * 契约：BRIEF §3.4、`docs/CONTRACT.md` §3.3。
 * - 提醒计划由纯逻辑 `buildReminderPlan` 生成（只取未来、未完成、去重、≤30 条）；
 * - `reminderAgentManager.publishReminder` 需要 `ohos.permission.PUBLISH_AGENT_REMINDER`；
 * - 权限被拒 / 申请失败 → 逐条降级 `notificationManager.publish`（普通通知，不占用日历提醒额度）；
 * - AGC 开放能力申请与手动签名步骤见设置页说明（审批约 8 个工作日）。
 *
 * ⚠ 本机无 HarmonyOS SDK：权限授予与提醒实际触发需真机 + AGC 配置后才能验证。
 */
import { reminderAgentManager } from '@kit.BackgroundTasksKit';
import { notificationManager } from '@kit.NotificationKit';
import { abilityAccessCtrl, common, Permissions } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { buildReminderPlan } from '../model/reminder';
import type { ReminderPlanItem } from '../model/reminder';
import type { ScheduleRecord } from '../model/types';
import { nowIso } from '../common/date';

/** 权限名（module.json5 已声明）。 */
const REMINDER_PERMISSION: Permissions = 'ohos.permission.PUBLISH_AGENT_REMINDER';

/** 单应用日历提醒上限（与 model/reminder 的 MAX_REMINDER_COUNT 一致）。 */
const MAX_REMINDER_COUNT: number = 30;

/** 提醒入口的入参/出参。 */
export interface ReminderRunResult {
  /** 计划条数（`buildReminderPlan` 的结果）。 */
  planned: number;
  /** 成功写入系统日历提醒的条数。 */
  published: number;
  /** 降级为普通通知的条数。 */
  degraded: number;
  /** 失败条数。 */
  failed: number;
  /** 面向用户的中文总结。 */
  message: string;
  /** 是否拿到日历提醒权限。 */
  permissionGranted: boolean;
}

export class ReminderService {
  private context: common.UIAbilityContext;

  constructor(context: common.UIAbilityContext) {
    this.context = context;
  }

  /** 依据日程记录创建提醒（未来未完成、最多 30 条）。 */
  async createForRecords(records: ScheduleRecord[]): Promise<ReminderRunResult> {
    const plan = buildReminderPlan(records, nowIso(), MAX_REMINDER_COUNT);
    if (plan.length === 0) {
      return {
        planned: 0,
        published: 0,
        degraded: 0,
        failed: 0,
        permissionGranted: false,
        message: '没有未来且未完成的日程，未创建提醒'
      };
    }

    const granted = await this.ensurePermission();
    if (!granted) {
      // 降级前先请求通知授权（失败也继续尝试发布，用户可在系统设置里打开）
      try {
        await notificationManager.requestEnableNotification(this.context);
      } catch {
        // 用户拒绝通知授权时仍然尝试发布，失败会记入 failed
      }
    }

    let published = 0;
    let degraded = 0;
    let failed = 0;
    for (let i = 0; i < plan.length; i++) {
      const item = plan[i];
      try {
        if (granted) {
          await this.publishCalendarReminder(item);
          published += 1;
        } else {
          await this.publishNotification(item, i);
          degraded += 1;
        }
      } catch {
        failed += 1;
      }
    }

    const parts: string[] = [];
    parts.push(`计划 ${plan.length} 条`);
    if (published > 0) {
      parts.push(`日历提醒 ${published} 条`);
    }
    if (degraded > 0) {
      parts.push(`降级为通知 ${degraded} 条`);
    }
    if (failed > 0) {
      parts.push(`失败 ${failed} 条`);
    }
    const prefix = granted ? '' : '日历提醒权限未获批，';
    return {
      planned: plan.length,
      published: published,
      degraded: degraded,
      failed: failed,
      permissionGranted: granted,
      message: `${prefix}已创建：${parts.join('，')}`
    };
  }

  /** 申请日历提醒权限；返回是否已获批。 */
  async ensurePermission(): Promise<boolean> {
    try {
      const atManager = abilityAccessCtrl.createAtManager();
      const result = await atManager.requestPermissionsFromUser(this.context, [REMINDER_PERMISSION]);
      if (result.authResults === undefined || result.authResults.length === 0) {
        return false;
      }
      return result.authResults[0] === 0;
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------------ 内部实现

  private async publishCalendarReminder(item: ReminderPlanItem): Promise<number> {
    const date = new Date(item.dateTime);
    const millis = date.getTime();
    if (Number.isNaN(millis)) {
      throw new Error(`提醒时间无法解析：${item.dateTime}`);
    }
    const request: reminderAgentManager.ReminderRequestCalendar = {
      reminderType: reminderAgentManager.ReminderType.REMINDER_TYPE_CALENDAR,
      dateTime: {
        year: date.getFullYear(),
        month: date.getMonth() + 1,
        day: date.getDate(),
        hour: date.getHours(),
        minute: date.getMinutes(),
        second: 0
      },
      title: '日程提醒',
      content: item.title,
      wantAgent: {
        pkgName: this.context.abilityInfo.bundleName,
        abilityName: 'EntryAbility'
      }
    };
    return await new Promise<number>((resolve, reject) => {
      reminderAgentManager.publishReminder(request, (err: BusinessError, reminderId: number) => {
        if (err) {
          reject(new Error(`发布日历提醒失败：${err.message}`));
          return;
        }
        resolve(reminderId);
      });
    });
  }

  private async publishNotification(item: ReminderPlanItem, index: number): Promise<void> {
    const request: notificationManager.NotificationRequest = {
      id: index + 1,
      content: {
        notificationContentType: notificationManager.ContentType.NOTIFICATION_CONTENT_BASIC_TEXT,
        normal: {
          title: '日程提醒',
          text: item.title,
          additionalText: item.dateTime
        }
      }
    };
    await notificationManager.publish(request);
  }
}
