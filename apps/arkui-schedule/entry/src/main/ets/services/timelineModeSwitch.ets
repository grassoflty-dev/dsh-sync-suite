/**
 * 读模式翻转开关（mod-v2-dual-write-off）：启动时**唯一**允许写 `timeline.readMode` 的地方。
 *
 * 流程（幂等，可重复调用）：
 * 1. ensureReady：timelineStore（只读门槛）+ timelineWriteStore（写路径）+ outboxStore（停放路径）；
 * 2. 读 `<filesDir>/git-repo/timeline/schema.json` 文本；读不到按缺标记处理；
 * 3. 交给纯函数 decideMode；
 * 4. 仅当决策为 v2：`timelineStore.setReadMode('v2')`（既有 sanctioned setter，也是本模块
 *    唯一的 AppStorage 写入）+ timelineWriteStore.ensureReady（幂等）；
 * 5. 否则保持 v1：不写 AppStorage（契约 §9「开关不写默认值，回退 v1 不需清理持久状态」），
 *    不创建 / 删除 / 重写任何 `devices/**` 文件，只返回类型化原因给调用方显示。
 *
 * 不实现迁移、不建 schema 标记、不碰 git、不删除任何 v1 数据。
 */
import { fileIo as fs } from '@kit.CoreFileKit';
import { common } from '@kit.AbilityKit';
import { timelineStore } from './timelineStore';
import { timelineWriteStore } from './timelineWriteStore';
import { outboxStore } from './outboxStore';
import { decideMode } from '../model/timelineMode';
import type { ModeDecision } from '../model/timelineMode';
import { PERSISTENT_V2_WRITE_KEY } from '../model/persistentSettings';

const ROOT_DIR_NAME: string = 'git-repo';
const SCHEMA_FILE_NAME: string = 'schema.json';

/**
 * v2 写入的**第二道闸**（显式激活）：同步周期（syncProtocolStore.runCycle）接线之前，
 * 即使仓库已是 v2 结构也不许翻转，否则记录只会落在本地 timeline/ 而永远不会 commit/push，
 * 违反契约 §9「不得静默本地未提交」。默认缺失 = 未激活。
 */
/**
 * 第二道闸键；键与缺省值由 model/persistentSettings.ts 统一定义，EntryAbility 启动时
 * 用 PersistentStorage.persistProp 绑定（P1-5：重启后仍是用户的显式选择）。
 */
export const V2_WRITE_ENABLED_KEY: string = PERSISTENT_V2_WRITE_KEY;

export interface ModeApplyResult {
  mode: 'v1' | 'v2';
  code: string;
  reason: string;
}

export class TimelineModeSwitch {
  /**
   * 应用读模式；返回决策结果（含类型化原因），调用方据此决定是否 toast。
   * 任何文件读异常都按「缺标记」交给 decideMode，不抛出、不写任何文件。
   */
  async applyMode(context: object): Promise<ModeApplyResult> {
    const abilityContext = context as common.UIAbilityContext;
    await timelineStore.ensureReady(abilityContext);
    await timelineWriteStore.ensureReady(abilityContext);
    await outboxStore.ensureReady(abilityContext);

    const markerPath: string = `${abilityContext.filesDir}/${ROOT_DIR_NAME}/timeline/${SCHEMA_FILE_NAME}`;
    let schemaText: string = '';
    try {
      schemaText = this.fileExists(markerPath) ? fs.readTextSync(markerPath) : '';
    } catch {
      // 读失败与缺文件等价：decideMode('') → E_SCHEMA_MISSING，v1 原路继续。
      schemaText = '';
    }

    const decision: ModeDecision = decideMode(schemaText);
    if (decision.mode === 'v2' && !this.writeActivated()) {
      // 仓库结构已是 v2，但本版本尚未接线同步周期：保持 v1，绝不半激活。
      return {
        mode: 'v1',
        code: 'E_V2_WRITE_NOT_ACTIVATED',
        reason: '仓库已是 v2 结构，但本版本尚未开启 v2 写入（同步周期未接线）：继续使用 v1 路径，未改动任何数据'
      };
    }
    if (decision.mode === 'v2') {
      // 唯一翻转点：只在 schemaVersion===2 时调用 sanctioned setter。
      timelineStore.setReadMode('v2');
      await timelineWriteStore.ensureReady(abilityContext);
      return { mode: 'v2', code: decision.code, reason: decision.reason };
    }

    // 非 v2：保持默认 v1（不写开关、不迁移、不删 v1），把 typed 原因交回调用方显示。
    return { mode: 'v1', code: decision.code, reason: decision.reason };
  }

  /** 显式激活位（默认 false）：只有同步周期接线并验证后才允许打开。 */
  private writeActivated(): boolean {
    return AppStorage.get<boolean>(V2_WRITE_ENABLED_KEY) === true;
  }

  private fileExists(path: string): boolean {
    try {
      return fs.accessSync(path);
    } catch {
      return false;
    }
  }
}

/** 全局单例：与首页 bootstrap 共用。 */
export const timelineModeSwitch: TimelineModeSwitch = new TimelineModeSwitch();
