/**
 * v2 写入的显式激活决策（mod-v2-sync-wiring）：纯函数、零 SDK import。
 *
 * 为什么单独放一个纯模型：设置页的开关是「显式激活」，不是启动时偷偷翻的隐藏 flag；
 * 每条拒绝/待确认分支都必须能在 Node 里直接断言，而不是靠 ArkTS 服务的源码形状猜测。
 *
 * 设计 contradiction 修复：契约 §10 明确「timeline/schema.json 存在且版本=2 时，无论
 * devices/ 是否存在都算 v2」——迁移提交只新增 timeline/、不删 v1，所以「两者并存」是
 * **迁移后常态**，旧版见到并存就 E_MIGRATION_AMBIGUOUS 拒绝会让激活永远无法成功。
 * 并存必须**显式裁决**而不是静默偏好：
 * 1. schemaVersion !== 2 → E_SCHEMA_MISSING / E_SCHEMA_UNKNOWN（schema 门槛，零写入）；
 * 2. 并存但 timeline/ 没有有效日数据（≥1 条记录）→ E_MIGRATION_EMPTY（迁移未完成，拒绝）；
 * 3. 并存且 timeline/ 有 ≥1 天有效数据且未确认 → E_NEEDS_EXPLICIT_RESOLUTION，
 *    needsConfirm=true，UI 弹**专用**确认框（与单态的普通确认文案不同）；
 * 4. cycleAvailable=false（未绑定 GitRunner / 桥未就绪）→ E_SYNC_UNAVAILABLE；
 * 5. 否则 ok（单态：devices/ 缺失或 timeline/ 独占，走原来的普通确认文案）。
 *
 * 并存裁决一旦在专用弹层确认，服务层写 `AppStorage['timeline.v1Retained']='1'`
 * （键名见 V1_RETAINED_KEY），之后 decide 把它当成 confirmed=true 不再重复询问；
 * 关闭 v2 写入**不清除**该键（裁决是「保留 v1 文件、timeline 权威」这一事实的持久记录）。
 */
import { PERSISTENT_V1_RETAINED_KEY } from './persistentSettings';

export type ActivationCode =
  | 'ok'
  | 'E_SCHEMA_MISSING'
  | 'E_SCHEMA_UNKNOWN'
  | 'E_MIGRATION_EMPTY'
  | 'E_NEEDS_EXPLICIT_RESOLUTION'
  | 'E_SYNC_UNAVAILABLE';

/**
 * 并存裁决的持久键：值为字符串 '1' 表示已确认。
 * P1-5：键与缺省值（''）由 persistentSettings 统一定义，EntryAbility 启动时绑定
 * PersistentStorage；deactivate() 不清该键（裁决是事实记录）。
 */
export const V1_RETAINED_KEY: string = PERSISTENT_V1_RETAINED_KEY;

/** 并存时的专用确认文案（设置页弹层逐字使用；与普通单态激活的文案不同）。 */
export const BOTH_PRESENT_CONFIRM_TEXT: string =
  '检测到 v1（devices/）与 v2（timeline/）数据并存：确认以 timeline/ 为权威并停用 v1 写入？v1 文件不会被删除。';

export interface ActivationInput {
  /** timeline/schema.json 解析出的 schemaVersion；null = 缺标记 / 坏 JSON。 */
  schemaVersion: number | null;
  /** 仓库根是否存在 devices/ 目录（含任何 v1 日程数据）。 */
  hasDevices: boolean;
  /** 仓库根是否存在 timeline/ 目录。 */
  hasTimeline: boolean;
  /** timeline/ 下「合法日历日且 records.json 有有效记录」的日目录数（服务层读盘得出）。 */
  timelineDays: number;
  /** 用户是否已显式确认「timeline/ 为权威、停用 v1 写入」的并存裁决。 */
  confirmed: boolean;
  /** 同步周期是否可用（runner 已注入且 git 桥就绪）。 */
  cycleAvailable: boolean;
}

export interface ActivationDecision {
  /** 是否允许直接激活（与 allowed 恒等；新调用方用 ok）。 */
  ok: boolean;
  /** 兼容旧字段名（与 ok 恒等），既有调用方无需改动。 */
  allowed: boolean;
  code: ActivationCode;
  /** 是否需要「v1/v2 并存」的专用确认弹层（仅 E_NEEDS_EXPLICIT_RESOLUTION 为真）。 */
  needsConfirm: boolean;
  /** 面向用户的中文原因（E_NEEDS_EXPLICIT_RESOLUTION 时即专用确认文案）。 */
  reason: string;
  /** 面向用户的下一步动作（空串 = 无需动作）。 */
  nextStep: string;
}

/** 各分支的逐字文案（设置页与 Node 断言共用）。 */
export const ACTIVATION_MESSAGES: Record<ActivationCode, string> = {
  ok: '可以启用 v2 时间线写入',
  E_SCHEMA_MISSING: '仓库缺少 timeline/schema.json（或无法解析），不能启用 v2 写入',
  E_SCHEMA_UNKNOWN: '仓库结构版本不是 2（不认识），不能启用 v2 写入',
  E_MIGRATION_EMPTY: '仓库同时存在 devices/ 与 timeline/，但 timeline/ 没有有效日程数据（迁移未完成），拒绝启用',
  E_NEEDS_EXPLICIT_RESOLUTION: BOTH_PRESENT_CONFIRM_TEXT,
  E_SYNC_UNAVAILABLE: '同步周期不可用（未绑定 GitRunner 或同步内核未就绪），启用后记录只会留在本地，拒绝启用'
};

const NEXT_EMPTY: string = '下一步：先运行单向迁移，让 timeline/ 产生有效日程数据，再回来开启';
const NEXT_RESOLVE: string = '下一步：在弹层确认以 timeline/ 为权威并停用 v1 写入（v1 文件保留）';
const NEXT_CYCLE: string = '下一步：先进入设置页让同步内核就绪，再回来开启';
const NEXT_SCHEMA: string = '下一步：先运行 v1→v2 迁移生成 timeline/schema.json，再回来开启';

/** 显式激活决策（纯函数，同输入恒同输出）。 */
export function decideActivation(input: ActivationInput): ActivationDecision {
  const bothPresent: boolean = input.hasDevices && input.hasTimeline;
  let code: ActivationCode = 'ok';
  if (input.schemaVersion === null) {
    code = 'E_SCHEMA_MISSING';
  } else if (input.schemaVersion !== 2) {
    code = 'E_SCHEMA_UNKNOWN';
  } else if (bothPresent && input.timelineDays < 1) {
    // 两者并存但 timeline/ 还没有数据 = 迁移尚未完成，不能静默把 v1 当权威。
    code = 'E_MIGRATION_EMPTY';
  } else if (bothPresent && !input.confirmed) {
    // 并存是迁移后常态：不默认 timeline 优先，必须走专用确认弹层显式裁决。
    code = 'E_NEEDS_EXPLICIT_RESOLUTION';
  } else if (!input.cycleAvailable) {
    code = 'E_SYNC_UNAVAILABLE';
  }

  let nextStep: string = '';
  if (code === 'E_SCHEMA_MISSING' || code === 'E_SCHEMA_UNKNOWN') {
    nextStep = NEXT_SCHEMA;
  } else if (code === 'E_MIGRATION_EMPTY') {
    nextStep = NEXT_EMPTY;
  } else if (code === 'E_NEEDS_EXPLICIT_RESOLUTION') {
    nextStep = NEXT_RESOLVE;
  } else if (code === 'E_SYNC_UNAVAILABLE') {
    nextStep = NEXT_CYCLE;
  }
  const ok: boolean = code === 'ok';
  return {
    ok: ok,
    allowed: ok,
    code: code,
    needsConfirm: code === 'E_NEEDS_EXPLICIT_RESOLUTION',
    reason: ACTIVATION_MESSAGES[code],
    nextStep: nextStep
  };
}
