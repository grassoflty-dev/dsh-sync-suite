/**
 * 读模式决策纯函数（mod-v2-dual-write-off）。
 *
 * 职责（严格限定）：只根据 `<repo>/timeline/schema.json` 的**文本**判断该仓库是否是合法 v2
 * 时间线，给出 `'v1' | 'v2'` 与类型化原因码；不读文件、不写文件、不读 AppStorage、
 * 不读墙钟、不迁移任何数据。
 *
 * 唯一翻转条件：`JSON.parse(schemaText)` 是对象且 `schemaVersion === 2`（数字）。
 * 缺标记（空串 / 空白）/ 非法 JSON / 非对象 / 缺字段 / 非数字 / 其他版本一律 `'v1'`，
 * 并给出 `E_SCHEMA_MISSING` 或 `E_SCHEMA_UNKNOWN`；绝不隐式迁移、绝不静默写开关。
 *
 * 与 model/timeline.ts 的 parseSchemaMarker 判定口径一致（同为 schemaVersion===2），
 * 但本函数额外区分「缺文件」与「有文件但坏/未知」，以便上层给出可操作的中文提示。
 */

/** v1 = 原 `devices/**` 日程路径（唯一默认）；v2 = 共享 `timeline/**`。 */
export type TimelineMode = 'v1' | 'v2';

/** 决策原因码：ok 仅随 v2 出现；缺标记 / 标记不认识分别给两个 typed 码。 */
export type ModeCode = 'ok' | 'E_SCHEMA_MISSING' | 'E_SCHEMA_UNKNOWN';

export interface ModeDecision {
  mode: TimelineMode;
  code: ModeCode;
  /** 中文原因，可直接用于 UI；v2 成功时为空串。 */
  reason: string;
}

/**
 * 纯决策：只有可解析的 `schemaVersion: 2` 才返回 v2。
 * 无副作用、无墙钟，同输入恒同输出。
 */
export function decideMode(schemaText: string): ModeDecision {
  // 缺标记：上层读不到文件 / 读到空文件都会传空串（或纯空白）。
  if (typeof schemaText !== 'string' || schemaText.trim().length === 0) {
    return {
      mode: 'v1',
      code: 'E_SCHEMA_MISSING',
      reason: '缺少 timeline/schema.json，继续使用 v1 日程路径（未改动任何数据）'
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(schemaText);
  } catch (error) {
    const detail: string = error instanceof Error ? error.message : String(error);
    return {
      mode: 'v1',
      code: 'E_SCHEMA_UNKNOWN',
      reason: `timeline/schema.json 不是合法 JSON（${detail}），继续使用 v1 日程路径`
    };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      mode: 'v1',
      code: 'E_SCHEMA_UNKNOWN',
      reason: 'timeline/schema.json 顶层必须是 JSON 对象，继续使用 v1 日程路径'
    };
  }

  const marker = parsed as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(marker, 'schemaVersion')) {
    return {
      mode: 'v1',
      code: 'E_SCHEMA_UNKNOWN',
      reason: 'timeline/schema.json 缺少 schemaVersion 字段，继续使用 v1 日程路径'
    };
  }

  const version: unknown = marker.schemaVersion;
  if (typeof version !== 'number' || !Number.isFinite(version)) {
    return {
      mode: 'v1',
      code: 'E_SCHEMA_UNKNOWN',
      reason: `schemaVersion 必须是数字（实际为 ${typeof version}），继续使用 v1 日程路径`
    };
  }
  if (version !== 2) {
    return {
      mode: 'v1',
      code: 'E_SCHEMA_UNKNOWN',
      reason: `不支持的 schemaVersion：${version}（仅支持 2），继续使用 v1 日程路径`
    };
  }

  return { mode: 'v2', code: 'ok', reason: '' };
}
