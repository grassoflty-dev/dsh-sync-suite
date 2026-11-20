/**
 * 未迁移（v1 仓库）状态的纯决策（mod-v2-only）：零 SDK import、零 IO、零墙钟。
 *
 * v2 时间线现在是**唯一**的读写路径，不再有 v1/v2 模式开关、显式激活或读模式回退。
 * 唯一的前置条件是仓库级标记 `<repo>/timeline/schema.json` 明确为 schemaVersion:2。
 * 标记缺失 / 坏 JSON / 其他版本 → 「未迁移」：首页显示一条固定横幅，所有写入
 * 在任何 IO 之前抛类型化中文错误 E_NOT_MIGRATED；本模块**不**自动迁移、不删 v1 数据。
 *
 * devices/ 与 timeline/ 并存是迁移后的常态（迁移只新增 timeline/、从不删 devices/），
 * 因此 hasDevices 只用于说明横幅文案来源，不参与迁移判定；标记存在即视为已迁移。
 */

/** 决策原因码：ok 仅随已迁移（schemaVersion===2）出现。 */
export type MigrationCode = 'ok' | 'E_NOT_MIGRATED';

/** 决策输入（显式接口：ArkTS 禁止把对象字面量直接当类型）。 */
export interface MigrationInput {
  /** timeline/schema.json 解析出的 schemaVersion；null = 缺标记 / 坏 JSON。 */
  schemaVersion: number | null;
  /** 仓库根是否存在 devices/ 目录（v1 旧数据）。 */
  hasDevices: boolean;
}

/** 决策输出（显式接口，供 UI 与服务共用逐字文案）。 */
export interface MigrationDecision {
  migrated: boolean;
  code: MigrationCode;
  /** 类型化中文原因（写入拒绝逐字使用；已迁移时为空串）。 */
  reason: string;
  /** 首页横幅文案（未迁移时逐字渲染；已迁移时为空串）。 */
  banner: string;
  /** 用户下一步动作（空串 = 无需动作）。 */
  nextStep: string;
}

/** 首页唯一横幅文案（未迁移时逐字显示，不随仓库形态变化）。 */
export const NOT_MIGRATED_BANNER: string =
  '检测到旧版数据（devices/），尚未迁移到时间线。旧数据不会被删除。';

/** 所有写入路径拒绝时的类型化中文原因（逐字抛错，不伪造成功）。 */
export const NOT_MIGRATED_REASON: string =
  'E_NOT_MIGRATED: 时间线尚未初始化，请先迁移旧数据';

/** 横幅按钮被点时的下一步提示（只给动作，不执行迁移）。 */
export const NOT_MIGRATED_NEXT_STEP: string =
  '下一步：先在 PC 端运行 v1→v2 单向迁移，生成 timeline/schema.json 后重开应用（旧数据不会删除）';

/** 纯决策：只有 schemaVersion===2 才允许读写；devices/ 并存不影响结论。 */
export function decideMigration(input: MigrationInput): MigrationDecision {
  if (input.schemaVersion === 2) {
    const ready: MigrationDecision = {
      migrated: true, code: 'ok', reason: '', banner: '', nextStep: ''
    };
    return ready;
  }
  const blocked: MigrationDecision = {
    migrated: false,
    code: 'E_NOT_MIGRATED',
    reason: NOT_MIGRATED_REASON,
    banner: NOT_MIGRATED_BANNER,
    nextStep: NOT_MIGRATED_NEXT_STEP
  };
  return blocked;
}
