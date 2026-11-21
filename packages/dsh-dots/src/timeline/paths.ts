/**
 * v2 单时间线的仓库相对路径与日期键校验（只读层，零 fs 调用、零副作用）。
 *
 * 与 v1（`src/schedule/paths.ts` 的 `devices/<id>/schedules/<date>.jsonl`）**完全平行**：
 * 本文件不迁移、不删除、不改写任何 v1 路径，只提供契约
 * `docs/DATA-CONTRACT-v2.md` §2 的唯一布局：
 * ```
 * timeline/schema.json
 * timeline/<YYYY-MM-DD>/records.json
 * timeline/<YYYY-MM-DD>/deleted.jsonl
 * timeline/<YYYY-MM-DD>/restore.jsonl
 * timeline/<YYYY-MM-DD>/conflicts.jsonl
 * timeline/<YYYY-MM-DD>/summary.json
 * timeline/<YYYY-MM-DD>/media/
 * ```
 * 没有设备命名空间、没有根索引（§2）；所有路径用 `/` 拼，不含绝对路径与 `..`。
 *
 * 日期键校验与 App `model/timelineWrite.ts` 的 `isCalendarDate()` 同口径：
 * 纯算术、不构造 Date、不读墙钟；`2026-02-30` / `2026-13-99` 必须被拒。
 */
import { SyncError } from '../engine/errors.js'

/** 仓库根下的时间线目录名。 */
export const TIMELINE_ROOT = 'timeline'

/** 仓库级 schema 标记的规范相对路径（§11）。 */
export const SCHEMA_MARKER_PATH = 'timeline/schema.json'

/** 日期键形状 `YYYY-MM-DD`（真实日历日由 `isTimelineDateKey` 往返校验）。 */
export const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * 纯算术日历日校验（与 App `isCalendarDate` 逐条同口径，彻底不碰墙钟）。
 * 只对形状合法的字符串做运算；任何非法输入一律 false，绝不抛。
 */
export function isTimelineDateKey(date: string): boolean {
  if (typeof date !== 'string' || !DATE_KEY_RE.test(date)) {
    return false
  }
  const year: number = Number(date.slice(0, 4))
  const month: number = Number(date.slice(5, 7))
  const day: number = Number(date.slice(8, 10))
  if (year < 1 || year > 9999 || month < 1 || month > 12) {
    return false
  }
  const leap: boolean = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  const monthDays: number[] = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return day >= 1 && day <= monthDays[month - 1]
}

/**
 * 严格校验并返回日期键；失败抛 `E_VALIDATION`（与 v1 `assertDateKey` 的错误口径一致）。
 * 校验发生在任何路径拼装之前，杜绝 `../` 与不存在的日期混入路径。
 */
export function assertTimelineDateKey(date: string): string {
  const text: string = typeof date === 'string' ? date.trim() : ''
  if (!isTimelineDateKey(text)) {
    throw new SyncError('E_VALIDATION', `日期必须是合法日历日 YYYY-MM-DD：${String(date)}`, { date: String(date) })
  }
  return text
}

/** 当日目录：`timeline/<date>`。 */
export function timelineDayDir(date: string): string {
  return `${TIMELINE_ROOT}/${assertTimelineDateKey(date)}`
}

/** 当日 records 文件：`timeline/<date>/records.json`（与 App `timelineDayPath` 同形）。 */
export function timelineRecordsPath(date: string): string {
  return `${timelineDayDir(date)}/records.json`
}

/** 与 App `timelineDayPath` 同名的别名，便于逐字对拍 App 的测试期望。 */
export const timelineDayPath = timelineRecordsPath

/** 追加式删除账本：`timeline/<date>/deleted.jsonl`。 */
export function timelineDeletedPath(date: string): string {
  return `${timelineDayDir(date)}/deleted.jsonl`
}

/** 追加式撤销账本：`timeline/<date>/restore.jsonl`。 */
export function timelineRestorePath(date: string): string {
  return `${timelineDayDir(date)}/restore.jsonl`
}

/** 追加式冲突审计：`timeline/<date>/conflicts.jsonl`。 */
export function timelineConflictsPath(date: string): string {
  return `${timelineDayDir(date)}/conflicts.jsonl`
}

/** 每日 AI 汇总：`timeline/<date>/summary.json`。 */
export function timelineSummaryPath(date: string): string {
  return `${timelineDayDir(date)}/summary.json`
}

/** 当日媒体目录：`timeline/<date>/media`（只由写/导入阶段落文件，本模块只拼路径）。 */
export function timelineMediaDir(date: string): string {
  return `${timelineDayDir(date)}/media`
}

/**
 * 从仓库相对路径反解日期键（读侧枚举日期目录的 helper）。
 * 仅接受 `timeline/<YYYY-MM-DD>/records.json` 这一种精确形状；其余返回 null。
 */
export function timelineDateFromRecordsPath(relativePath: string): string | null {
  if (typeof relativePath !== 'string') {
    return null
  }
  const matched: RegExpExecArray | null = /^timeline\/(\d{4}-\d{2}-\d{2})\/records\.json$/.exec(relativePath)
  if (matched === null) {
    return null
  }
  const date: string = matched[1]
  return isTimelineDateKey(date) ? date : null
}
