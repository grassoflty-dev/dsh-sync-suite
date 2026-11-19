/**
 * v2 写入的显式激活服务（mod-v2-sync-wiring）：设置页开关的唯一后端。
 *
 * 只做两件事：
 * 1. `decide()`：读仓库级 schema + 目录形态 + timeline 有效日数 + 周期可用性 +
 *    并存裁决确认位，交给纯函数 decideActivation；
 * 2. `activate()/deactivate()`：允许时写 AppStorage['timeline.v2WriteEnabled'] 并翻
 *    timeline.readMode；关闭时反向写回 v1。**不迁移、不建目录、不删 v1 数据、不自动激活**。
 *
 * 并存（devices/ + timeline/）是迁移后常态：timeline/ 有 ≥1 天有效数据时返回
 * needsConfirm=true，设置页必须弹**专用**确认框；确认后写 `AppStorage['timeline.v1Retained']='1'`
 * （键见 model/v2Activation.ts 的 V1_RETAINED_KEY），之后 decide 视为 confirmed=true，
 * 不再重复询问。deactivate() 不清除该键：裁决记录的是「v1 文件保留、timeline 权威」这一事实。
 *
 * 门槛见 model/v2Activation.ts（schema 非 v2 / 并存但 timeline 空 / 并存未确认 / 周期不可用）。
 */
import { fileIo as fs } from '@kit.CoreFileKit';
import { common } from '@kit.AbilityKit';
import { parseSchemaMarker, parseTimelineDay } from '../model/timeline';
import { decideActivation, V1_RETAINED_KEY } from '../model/v2Activation';
import type { ActivationDecision } from '../model/v2Activation';
import { V2_WRITE_ENABLED_KEY } from './timelineModeSwitch';
import { timelineStore } from './timelineStore';
import { bridgeGitRunner } from './gitRunner';

const REPO_DIR_NAME: string = 'git-repo';
const DEVICES_DIR_NAME: string = 'devices';
const TIMELINE_DIR_NAME: string = 'timeline';
const SCHEMA_FILE_NAME: string = 'schema.json';
const RECORDS_FILE_NAME: string = 'records.json';
/** 合法日期目录形状；真实日历日由 isCalendarDate() 往返校验（与 timelineStore 同口径）。 */
const DATE_KEY_RE: RegExp = /^\d{4}-\d{2}-\d{2}$/;

export class V2ActivationService {
  /** 当前是否已显式激活（默认缺失 = false）。 */
  isActivated(): boolean {
    return AppStorage.get<boolean>(V2_WRITE_ENABLED_KEY) === true;
  }

  /** 并存裁决是否已确认（默认缺失 = false）。 */
  private v1RetentionConfirmed(): boolean {
    return AppStorage.get<string>(V1_RETAINED_KEY) === '1';
  }

  /** 预检（不写任何状态）：设置页用它决定开关能否打开、拒绝原因与下一步。 */
  async decide(context: object): Promise<ActivationDecision> {
    return this.decideWith(context, this.v1RetentionConfirmed());
  }

  /**
   * 带显式 confirmed 覆盖的预检：`activate(context, true)` 用它在确认弹层后重算，
   * 避免「弹层确认了但预检还按未确认拒绝」的自相矛盾。
   */
  private async decideWith(context: object, confirmed: boolean): Promise<ActivationDecision> {
    const abilityContext: common.UIAbilityContext = context as common.UIAbilityContext;
    await timelineStore.ensureReady(abilityContext);
    const repoRoot: string = `${abilityContext.filesDir}/${REPO_DIR_NAME}`;
    const schemaPath: string = `${repoRoot}/${TIMELINE_DIR_NAME}/${SCHEMA_FILE_NAME}`;
    let schemaText: string = '';
    try {
      schemaText = this.fileExists(schemaPath) ? fs.readTextSync(schemaPath) : '';
    } catch (error) {
      schemaText = '';
    }
    const marker = parseSchemaMarker(schemaText);
    return decideActivation({
      schemaVersion: marker.ok ? marker.version : null,
      hasDevices: this.isDirectory(`${repoRoot}/${DEVICES_DIR_NAME}`),
      hasTimeline: this.isDirectory(`${repoRoot}/${TIMELINE_DIR_NAME}`),
      timelineDays: this.countValidTimelineDays(repoRoot),
      confirmed: confirmed,
      cycleAvailable: bridgeGitRunner.available()
    });
  }

  /**
   * 显式激活。confirmed=true 只在设置页的**并存专用**确认弹层返回后传入：
   * 仅当预检命中 E_NEEDS_EXPLICIT_RESOLUTION 时才落并存裁决键，单态激活保持原逻辑。
   */
  async activate(context: object, confirmed: boolean = false): Promise<ActivationDecision> {
    const raw: ActivationDecision = await this.decide(context);
    if (raw.needsConfirm && !confirmed) {
      // 未确认的并存绝不激活；设置页应先弹专用确认框再调用。
      return raw;
    }
    if (!raw.allowed && !raw.needsConfirm) {
      return raw;
    }
    let decision: ActivationDecision = raw;
    if (raw.needsConfirm) {
      decision = await this.decideWith(context, true);
      if (!decision.ok) {
        return decision;
      }
      AppStorage.setOrCreate<string>(V1_RETAINED_KEY, '1');
    }
    AppStorage.setOrCreate<boolean>(V2_WRITE_ENABLED_KEY, true);
    timelineStore.setReadMode('v2');
    return decision;
  }

  /**
   * 关闭：无条件回到 v1（v1 数据不删不改），清掉激活位与读模式；并存裁决键保留。
   * P1-5：这两个键已在 EntryAbility 绑定 PersistentStorage，setOrCreate 即持久写入 ——
   * 关闭后重启仍是 v1；`deactivate()` 必须显式写 `false` / `'v1'`（不能只 delete / 不写）。
   */
  deactivate(): void {
    AppStorage.setOrCreate<boolean>(V2_WRITE_ENABLED_KEY, false);
    timelineStore.setReadMode('v1');
  }

  /**
   * timeline/ 下「有有效记录的合法日历日」数量（契约 §10 的"timeline/ 有东西"判据）。
   * 只读、永不抛：目录不存在 / 扫描失败 / 单日解析失败一律按 0 或跳过处理。
   */
  private countValidTimelineDays(repoRoot: string): number {
    const timelineRoot: string = `${repoRoot}/${TIMELINE_DIR_NAME}`;
    let count: number = 0;
    try {
      if (!this.isDirectory(timelineRoot)) {
        return 0;
      }
      const names: string[] = fs.listFileSync(timelineRoot);
      for (const name of names) {
        if (!this.isCalendarDate(name)) {
          continue;
        }
        const recordsPath: string = `${timelineRoot}/${name}/${RECORDS_FILE_NAME}`;
        if (!this.fileExists(recordsPath)) {
          continue;
        }
        let text: string = '';
        try {
          text = fs.readTextSync(recordsPath);
        } catch (error) {
          continue;
        }
        const parsed = parseTimelineDay(text, name);
        const day = parsed.day;
        if (day !== null && day.allRecords.length > 0) {
          count += 1;
        }
      }
    } catch (error) {
      return 0;
    }
    return count;
  }

  /** 真实日历日校验（与 timelineStore.isCalendarDate 同口径）：形状 + 本地日期往返。 */
  private isCalendarDate(name: string): boolean {
    if (!DATE_KEY_RE.test(name)) {
      return false;
    }
    const year: number = Number(name.slice(0, 4));
    const month: number = Number(name.slice(5, 7));
    const day: number = Number(name.slice(8, 10));
    if (year < 1 || year > 9999) {
      return false;
    }
    const probe = new Date(year, month - 1, day);
    probe.setFullYear(year);
    return probe.getFullYear() === year && probe.getMonth() === month - 1 && probe.getDate() === day;
  }

  private fileExists(path: string): boolean {
    try {
      return fs.accessSync(path);
    } catch (error) {
      return false;
    }
  }

  private isDirectory(path: string): boolean {
    try {
      if (!this.fileExists(path)) {
        return false;
      }
      return fs.statSync(path).isDirectory();
    } catch (error) {
      return false;
    }
  }
}

/** 全局单例：设置页 SyncGroup 与首页共用。 */
export const v2ActivationService: V2ActivationService = new V2ActivationService();
