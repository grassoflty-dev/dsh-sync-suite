/**
 * 日程路径的构造与越界防护。
 *
 * 允许写的**唯一**路径形状（`docs/DATA-CONTRACT.md` §1）：
 * ```
 * devices/<deviceId>/schedules/<YYYY-MM-DD>.jsonl
 * ```
 * 这里把三件事分开做，避免"校验一次到处复用"：
 *   1. `assertDeviceId` / `assertDateKey`：标识符与日期的形状校验（含真实日历日校验）；
 *   2. `scheduleRelPath`：只按契约拼路径，不接受调用方给的任意相对路径；
 *   3. `resolveInsideRepo` + `assertSchedulesScope`：拼出来的路径必须仍在仓库内、
 *      且必须落在 `devices/<deviceId>/schedules/` 下，否则 `E_VALIDATION`。
 *
 * `summaries/` 属于 App 侧写，PC 侧只读不写（`assertSchedulesScope` 会挡住写入以外的目录）。
 */
import path from 'node:path'
import { SyncError } from '../engine/errors.js'
import { DEVICE_ID_RE } from '../engine/settings.js'

/** 日期键 `YYYY-MM-DD`（设备本地时间日期）。 */
export const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/

/** 设备目录名（与 `engine/settings.ts` 的 deviceId 规则同源）。 */
export { DEVICE_ID_RE }

/** 校验并返回 deviceId；任何 `..`、路径分隔符、大写、超长都会被拒绝。 */
export function assertDeviceId(deviceId: string): string {
  const text = typeof deviceId === 'string' ? deviceId.trim() : ''
  if (!DEVICE_ID_RE.test(text)) {
    throw new SyncError('E_VALIDATION', `deviceId 必须匹配 ^[a-z0-9][a-z0-9-]{0,31}$：${String(deviceId)}`, {
      deviceId: String(deviceId),
    })
  }
  return text
}

/** 校验并返回日期键；同时拒绝不存在的日历日（`2026-02-31`）。 */
export function assertDateKey(date: string): string {
  const text = typeof date === 'string' ? date.trim() : ''
  if (!DATE_KEY_RE.test(text)) {
    throw new SyncError('E_VALIDATION', `日期必须是 YYYY-MM-DD：${String(date)}`, { date: String(date) })
  }
  const year = Number(text.slice(0, 4))
  const month = Number(text.slice(5, 7))
  const day = Number(text.slice(8, 10))
  const utc = new Date(Date.UTC(year, month - 1, day))
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) {
    throw new SyncError('E_VALIDATION', `日期不存在：${text}`, { date: text })
  }
  return text
}

/** 契约路径：`devices/<deviceId>/schedules/<date>.jsonl`（永远用 `/`）。 */
export function scheduleRelPath(deviceId: string, date: string): string {
  return `devices/${assertDeviceId(deviceId)}/schedules/${assertDateKey(date)}.jsonl`
}

/** 本机可写的目录前缀：`devices/<deviceId>/schedules`。 */
export function schedulesScope(deviceId: string): string {
  return `devices/${assertDeviceId(deviceId)}/schedules`
}

/**
 * 把仓库相对路径解析成绝对路径，并保证逃不出仓库根。
 *
 * 用 `path.relative` 判断（而不是 `startsWith`）：Windows 大小写不敏感，
 * 前缀比较会放过 `C:\Repo\..\evil` 这类构造。
 */
export function resolveInsideRepo(repoDir: string, relativePath: string): string {
  const root = path.resolve(repoDir)
  if (typeof relativePath !== 'string' || relativePath.trim() === '') {
    throw new SyncError('E_VALIDATION', '相对路径不能为空')
  }
  if (path.isAbsolute(relativePath)) {
    throw new SyncError('E_VALIDATION', `只接受仓库内相对路径：${relativePath}`)
  }
  const absolute = path.resolve(root, relativePath)
  const inside = path.relative(root, absolute)
  if (inside === '' || inside.startsWith('..') || path.isAbsolute(inside)) {
    throw new SyncError('E_VALIDATION', `路径越界（不在仓库内）：${relativePath}`, { path: relativePath })
  }
  return absolute
}

/**
 * 写入前的最终门禁：路径必须**恰好**落在 `devices/<deviceId>/schedules/` 下。
 *
 * 三条拒绝理由都可测：不是本机设备目录、跑到了 `summaries/`、用 `..` 逃出仓库。
 */
export function assertSchedulesScope(deviceId: string, relativePath: string): void {
  const scope = schedulesScope(deviceId)
  const normalized = relativePath.replace(/\\/g, '/')
  if (normalized.includes('..')) {
    throw new SyncError('E_VALIDATION', `路径不得包含 ..：${relativePath}`, { path: relativePath })
  }
  if (normalized === scope) {
    throw new SyncError('E_VALIDATION', `不允许直接写设备目录：${relativePath}`, { path: relativePath })
  }
  if (!normalized.startsWith(`${scope}/`)) {
    throw new SyncError(
      'E_VALIDATION',
      `只允许写 devices/${deviceId}/schedules/ 下的文件（summaries/ 由平板侧写）：${relativePath}`,
      { path: relativePath, allowed: `${scope}/` },
    )
  }
}
