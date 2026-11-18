/**
 * 状态目录 / profile 目录解析，以及多处复用的 sha256 辅助。
 *
 * 目录约定（CONTRACT §2.1、DATA-CONTRACT §5）：
 *   %USERPROFILE%\.dsh\dots\{settings.json,credentials.json,work\,plugins.to-install.json}
 *   %USERPROFILE%\.dsh\vet\restore-snapshots\
 *   %USERPROFILE%\.dsh\profiles\web            （profile，默认写目标）
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface StatePaths {
  root: string
  settingsFile: string
  credentialsFile: string
  /** 本地运行状态（最近一次成功同步时间等），不含任何 secret。 */
  stateFile: string
  workRoot: string
  snapshotRoot: string
  pendingFile: string
}

/**
 * 解析 DSH 主目录（`~/.dsh`）。
 * `homeDir` 给定时表示"用户主目录"，此时 `.dsh` 是其子目录（测试靠这个隔离）；
 * 未给定时优先 `DSH_HOME`，否则 `os.homedir()`。
 */
export function dshHome(homeDir?: string): string {
  if (homeDir !== undefined && homeDir.trim() !== '') return path.join(path.resolve(homeDir), '.dsh')
  const envHome = process.env.DSH_HOME
  if (envHome !== undefined && envHome.trim() !== '') return path.resolve(envHome)
  return path.join(os.homedir(), '.dsh')
}

/** 临时兼容：旧配置目录名，迁移完成后可删除。 */
export const LEGACY_STATE_DIR_NAME = 'git-config-sync'
/** 迁移完成标记，写在目标目录内。 */
export const MIGRATION_MARKER_FILE = `.migrated-from-${LEGACY_STATE_DIR_NAME}.json`
/**
 * 迁移进行中标记，写在 `<dshHome>` 根目录、**在 mkdir 目标目录之前**落盘。
 * 作用：区分"用户自建了 dots 目录"（无标记 → 跳过，不覆盖）与
 * "上次迁移写到一半中断"（有标记 → 补齐重试，绝不跳过）。没有它，
 * 中途失败后目标目录已存在但无完成标记，下次会被永久 skip，token 永久丢。
 */
export const MIGRATION_PENDING_FILE = `.migration-pending-${LEGACY_STATE_DIR_NAME}.json`
/** 目标目录已存在且无任何迁移痕迹时的跳过标记，避免每次启动重复判断。 */
export const MIGRATION_SKIP_FILE = `.migration-skipped-${LEGACY_STATE_DIR_NAME}.json`

export type StateMigrationStatus = 'no-op' | 'migrated' | 'repaired' | 'complete' | 'skipped' | 'failed'

export interface StateMigrationResult {
  status: StateMigrationStatus
  from: string
  to: string
  /** 本次实际搬动的条目名。 */
  moved: string[]
  /** 失败/跳过原因（便于日志排查，不抛异常）。 */
  reason?: string
}

interface LegacyEntry {
  name: string
  isDir: boolean
  size: number
}

function writeMigrationMarker(file: string, from: string, to: string): void {
  writeFileSync(file, `${JSON.stringify({ from, to, at: new Date().toISOString() }, null, 2)}\n`, 'utf8')
}

function removePending(pendingFile: string): void {
  try {
    unlinkSync(pendingFile)
  } catch {
    /* 清理失败不影响数据正确性：完成标记存在时不会进入迁移路径 */
  }
}

/**
 * 校验：清单每个条目在目标目录存在且类型一致；旧目录只剩"目标已有同名条目"的重复项。
 * `duplicates` 里的条目是用户新目录里本来就有的，目标内容为权威，故不校验大小、不覆盖。
 */
function verifyMigrated(
  from: string,
  to: string,
  manifest: LegacyEntry[],
  duplicates: Set<string>,
): string | undefined {
  try {
    const rest = readdirSync(from).filter((name) => !duplicates.has(name))
    if (rest.length > 0) return `legacy-not-empty:${rest.join(',')}`
    for (const item of manifest) {
      const dst = path.join(to, item.name)
      if (!existsSync(dst)) return `missing:${item.name}`
      const st = statSync(dst)
      if (st.isDirectory() !== item.isDir) return `type-mismatch:${item.name}`
      if (!duplicates.has(item.name) && item.size >= 0 && st.size !== item.size) return `size-mismatch:${item.name}`
    }
    return undefined
  } catch (err) {
    return `verify:${String(err)}`
  }
}

/**
 * 把 `<dshHome>/git-config-sync/` 的条目搬到 `<dshHome>/dots/`（settings/credentials/state/
 * work/plugins.to-install/remote.json/remote-token.json 以及任何未知条目）。
 *
 * 顺序铁律：**先全部搬运 → 校验完整 → 最后才写完成标记**。
 *  - 旧目录不存在 → no-op；
 *  - 目标目录已存在且无标记 → 不覆盖任何文件，写跳过标记（不碰旧目录）；
 *  - 标记已存在但目标不全（上次中断）→ 修复模式：从旧目录补齐缺失条目，
 *    绝不因"有标记"就跳过；旧目录保持到校验通过后才视为完成；
 *  - 任何一步失败 → 不写标记、保留旧目录剩余条目，下次启动自动重试。
 *
 * 所有异常都转成 `status: 'failed'` 返回，不抛到插件启动路径；失败时旧目录仍在，
 * 因此不会静默丢数据。
 */
export function migrateLegacyStateDir(homeDir?: string): StateMigrationResult {
  const dsh = dshHome(homeDir)
  const from = path.join(dsh, LEGACY_STATE_DIR_NAME)
  const to = path.join(dsh, 'dots')
  const pendingFile = path.join(dsh, MIGRATION_PENDING_FILE)
  const base: StateMigrationResult = { status: 'no-op', from, to, moved: [] }

  // 1) 旧目录不存在 → no-op（最常见路径，零副作用）；顺手清掉可能的 pending 残留。
  let names: string[]
  try {
    if (!existsSync(from)) {
      removePending(pendingFile)
      return base
    }
    names = readdirSync(from)
  } catch (err) {
    return { ...base, status: 'failed', reason: `read-legacy:${String(err)}` }
  }

  // 2) 记录搬运前清单，供搬运后逐条校验（大小/类型一致）。
  let manifest: LegacyEntry[]
  try {
    manifest = names.map((name) => {
      const st = statSync(path.join(from, name))
      return { name, isDir: st.isDirectory(), size: st.isFile() ? st.size : -1 }
    })
  } catch (err) {
    return { ...base, status: 'failed', reason: `stat-legacy:${String(err)}` }
  }

  const markerFile = path.join(to, MIGRATION_MARKER_FILE)
  const markerExists = existsSync(markerFile)
  const pendingExists = existsSync(pendingFile)

  // 3) 有完成标记 OR 进行中标记 → 补齐模式：绝不因为"有标记/目标已存在"就跳过。
  //    进行中标记是评审 M1 的修复：中途失败时目标已建但无完成标记，仍必须回来补齐。
  if (markerExists || pendingExists) {
    try {
      mkdirSync(to, { recursive: true })
    } catch (err) {
      return { ...base, status: 'failed', reason: `mkdir-target:${String(err)}` }
    }
    if (names.length === 0) {
      if (pendingExists) {
        try {
          writeMigrationMarker(markerFile, from, to)
        } catch {
          /* 数据已完整，标记写失败不影响正确性 */
        }
        removePending(pendingFile)
        return { ...base, status: 'repaired' }
      }
      return { ...base, status: 'complete' }
    }
    const result: StateMigrationResult = { ...base, status: 'repaired', moved: [] }
    const duplicates = new Set<string>()
    for (const item of manifest) {
      // 目标已有同名条目：不覆盖（用户新目录为权威），记为重复项，旧目录同名条目保留。
      if (existsSync(path.join(to, item.name))) {
        duplicates.add(item.name)
        continue
      }
      try {
        renameSync(path.join(from, item.name), path.join(to, item.name))
        result.moved.push(item.name)
      } catch (err) {
        return { ...result, status: 'failed', reason: `backfill:${item.name}:${String(err)}` }
      }
    }
    const problem = verifyMigrated(from, to, manifest, duplicates)
    if (problem !== undefined) return { ...result, status: 'failed', reason: problem }
    try {
      writeMigrationMarker(markerFile, from, to)
    } catch {
      /* 数据已完整，标记只是幂等提示 */
    }
    removePending(pendingFile)
    // 没有任何条目被搬动（全是目标已有的重复项）→ 实际状态就是"已完成"，便于幂等判断。
    if (result.moved.length === 0) return { ...result, status: 'complete' }
    return result
  }

  // 4) 无任何迁移标记 + 目标已存在 → 用户自建新目录：整体跳过，不覆盖任何内容。
  if (existsSync(to)) {
    try {
      writeMigrationMarker(path.join(to, MIGRATION_SKIP_FILE), from, to)
    } catch {
      /* 跳过标记写失败不影响数据 */
    }
    return { ...base, status: 'skipped', reason: 'target-exists' }
  }

  // 5) 全新迁移：先写 pending 标记（在 mkdir 之前！）→ mkdir → 逐个 rename → 校验 → 完成标记。
  try {
    mkdirSync(dsh, { recursive: true })
    writeMigrationMarker(pendingFile, from, to)
  } catch (err) {
    return { ...base, status: 'failed', reason: `pending:${String(err)}` }
  }
  try {
    mkdirSync(to, { recursive: true })
  } catch (err) {
    return { ...base, status: 'failed', reason: `mkdir-target:${String(err)}` }
  }
  const result: StateMigrationResult = { ...base, status: 'migrated', moved: [] }
  for (const item of manifest) {
    try {
      renameSync(path.join(from, item.name), path.join(to, item.name))
      result.moved.push(item.name)
    } catch (err) {
      // 中途失败：pending 标记保留、旧目录保留剩余条目，下次进入补齐模式而不是 skip。
      return { ...result, status: 'failed', reason: `move:${item.name}:${String(err)}` }
    }
  }
  const problem = verifyMigrated(from, to, manifest, new Set())
  if (problem !== undefined) return { ...result, status: 'failed', reason: problem }
  try {
    writeMigrationMarker(markerFile, from, to)
  } catch {
    /* 数据已完整；pending 仍在，下次会补齐并补写完成标记 */
    return { ...result, status: 'repaired', reason: 'marker-write-failed' }
  }
  removePending(pendingFile)
  return result
}

export function statePaths(homeDir?: string): StatePaths {
  // 所有路径解析（createRpcService / RemoteStore 都经由此处）共享同一次迁移结果。
  migrateLegacyStateDir(homeDir)
  const dsh = dshHome(homeDir)
  const root = path.join(dsh, 'dots')
  return {
    root,
    settingsFile: path.join(root, 'settings.json'),
    credentialsFile: path.join(root, 'credentials.json'),
    stateFile: path.join(root, 'state.json'),
    workRoot: path.join(root, 'work'),
    snapshotRoot: path.join(dsh, 'vet', 'restore-snapshots'),
    pendingFile: path.join(root, 'plugins.to-install.json'),
  }
}

/** profile 默认 `<.dsh>/profiles/web`，`DSH_PROFILE_DIR` 可覆盖（显式注入优先）。 */
export function resolveProfileDir(options: { homeDir?: string; profileDir?: string } = {}): string {
  if (options.profileDir !== undefined && options.profileDir.trim() !== '') return path.resolve(options.profileDir)
  const envProfile = process.env.DSH_PROFILE_DIR
  if (options.homeDir === undefined && envProfile !== undefined && envProfile.trim() !== '') return path.resolve(envProfile)
  return path.join(dshHome(options.homeDir), 'profiles', 'web')
}

/** 工作副本目录名：repoUrl 的 sha256 前 16 位。 */
export function repoHash(repoUrl: string): string {
  return createHash('sha256').update(String(repoUrl).trim(), 'utf8').digest('hex').slice(0, 16)
}

export function workDirFor(paths: StatePaths, repoUrl: string): string {
  return path.join(paths.workRoot, repoHash(repoUrl))
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex')
}

export function byteLength(input: string): number {
  return Buffer.byteLength(input, 'utf8')
}

/** `YYYYMMDD-HHmmss`（本地时间），快照目录名要用。 */
export function timestampId(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    String(date.getFullYear()) +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    '-' +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds())
  )
}

/** 采集 manifest 时记录 DSH 版本：显式配置 > DSH_VERSION > safe-launch 状态 > 运行入口 package.json。 */
export function detectDshVersion(homeDir?: string): string {
  const envVersion = process.env.DSH_VERSION
  if (envVersion !== undefined && envVersion.trim() !== '') return envVersion.trim()
  try {
    const lastGood = path.join(dshHome(homeDir), 'safe-launch', 'last-good.json')
    if (existsSync(lastGood)) {
      const parsed: unknown = JSON.parse(readFileSync(lastGood, 'utf8'))
      if (parsed !== null && typeof parsed === 'object') {
        const version = (parsed as Record<string, unknown>).dshVersion
        if (typeof version === 'string' && version !== '') return version
      }
    }
  } catch {
    /* 只读探测失败不影响同步 */
  }
  try {
    const entry = process.argv[1]
    if (entry !== undefined && entry !== '') {
      let dir = path.dirname(path.resolve(entry))
      for (let depth = 0; depth < 6; depth += 1) {
        const pkgFile = path.join(dir, 'package.json')
        if (existsSync(pkgFile)) {
          const parsed: unknown = JSON.parse(readFileSync(pkgFile, 'utf8'))
          if (parsed !== null && typeof parsed === 'object') {
            const record = parsed as Record<string, unknown>
            const name = typeof record.name === 'string' ? record.name : ''
            const version = typeof record.version === 'string' ? record.version : ''
            if (version !== '' && /dsh/i.test(name)) return version
          }
        }
        const parent = path.dirname(dir)
        if (parent === dir) break
        dir = parent
      }
    }
  } catch {
    /* 同上 */
  }
  return 'unknown'
}
