/**
 * v2 仓库路径决策（PC 自持 clone 为主，`mod-plugin-repo-root`）+ 存量迁移（绑定决策 ③）。
 *
 * 【唯一路径决策】工作根由 `src/sync/repoRoot.ts` 的 `resolveV2RepoRoot` 按 env 优先级
 * 解析；本文件的 `resolveV2RepoDir` 仍是「工作根 + 目录名 = 仓库目录」的**单一决策点**：
 * 默认 `~/.dsh/dots/repos/<repoHash>/git-repo`，与遗留 `~/.dsh/dots/work/<repoHash>` 分开。
 * 平板不跑 DSH，插件不再依赖 App 的 filesDir；该 env 仅作已废弃别名保留。
 *
 * 【安全底线】迁移只在「旧 work 目录存在 且 新 repos 根不存在」时发生（`migrateIfNeeded`）；
 * 核账发现未推提交立刻 typed 中止——不删除、不移动、不覆盖任何文件；移动前先备份，
 * 写标记后幂等。本文件只用只读 git 子命令（rev-parse / rev-list / config --get）核账，
 * 没有任何变基 / 强制推送 / 历史改写命令。
 */
import { execFile } from 'node:child_process'
import { cp, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { SyncError } from '../engine/errors.js'
import { repoHash } from '../engine/paths.js'
import {
  SHARED_REPO_DIR_NAME,
  resolveV2RepoRoot,
} from './repoRoot.js'
import type { RepoRootLogger, RepoRootResolution } from './repoRoot.js'

export { SHARED_REPO_DIR_NAME } from './repoRoot.js'
export { E_REPO_ROOT_UNAVAILABLE, ensureRepoRoot } from './repoRoot.js'

/** 迁移中止码（typed；不是泛化的 E_IO）。 */
export const E_LEGACY_UNPUSHED = 'E_LEGACY_UNPUSHED'

/** M5：目标 clone 不属于同一仓库时的 typed 中止码。 */
export const E_MIGRATION_TARGET_MISMATCH = 'E_MIGRATION_TARGET_MISMATCH'

/** M5 中止文案：点名两边 remote URL 与目标路径，要求运维核对后重试。 */
export function targetMismatchMessage(
  legacyDir: string,
  targetDir: string,
  legacyOrigin: string,
  targetOrigin: string,
): string {
  return `${E_MIGRATION_TARGET_MISMATCH}: 迁移目标 ${targetDir} 的 origin（${targetOrigin || '无'}）与旧工作副本 ${legacyDir} 的 origin（${legacyOrigin || '无'}）不一致，或目标不是有效 git 工作副本。已中止：未写迁移标记、未移动、未删除任何文件。下一步：请核对 App 的 git-repo/ 是否为同一远端仓库，纠正后再重新运行迁移。`
}

/** 旧工作副本路径：state 的 workRoot + repoHash（只用于检测，绝不作为 v2 写入目标）。 */
export function legacyWorkDir(workRoot: string, repoUrl: string): string {
  return path.join(workRoot, repoHash(repoUrl))
}

export interface RepoPathOptions {
  /** 已废弃别名（等价于 DSH_DOTS_APP_FILES_DIR）；新 env DSH_DOTS_REPO_ROOT 优先。 */
  appFilesDir?: string
  /** 默认根哈希所用仓库地址；caller 总是传 settings.repoUrl。 */
  repoUrl?: string
  homeDir?: string
  env?: NodeJS.ProcessEnv
  /** 宿主 logger；不注入时只把 logLine 留在结果里，不写 stdout。 */
  logger?: RepoRootLogger
  /** 显式整目录覆盖（集成测试用，给出时直接返回，不再拼 git-repo）。 */
  overrideDir?: string
}

/**
 * v2 层唯一的仓库目录决策点：工作根来自 `resolveV2RepoRoot`，目录名固定 `git-repo`。
 * `overrideDir` 是历史集成测试通道，给出时原样返回（它本身已经是完整仓库目录）。
 */
export function resolveV2RepoDirDetailed(options: RepoPathOptions = {}): RepoRootResolution {
  const resolution = resolveV2RepoRoot({
    ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
    ...(options.repoUrl !== undefined ? { repoUrl: options.repoUrl } : {}),
    ...(options.appFilesDir !== undefined ? { appFilesDir: options.appFilesDir } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  })
  if (typeof options.overrideDir === 'string' && options.overrideDir.trim() !== '') {
    const repoDir = path.resolve(options.overrideDir)
    return { ...resolution, repoDir, logLine: `${resolution.logLine}; explicit overrideDir -> ${repoDir}` }
  }
  return resolution
}

/** 兼容旧调用签名：只取仓库目录字符串。 */
export function resolveV2RepoDir(options: RepoPathOptions = {}): string {
  return resolveV2RepoDirDetailed(options).repoDir
}

/** 迁移中止文案（verbatim）：包含旧路径、未推提交数、下一步与「绝不丢提交」承诺。 */
export function legacyUnpushedMessage(legacyDir: string, targetDir: string, count: number): string {
  return `${E_LEGACY_UNPUSHED}: 旧工作副本 ${legacyDir} 含 ${count} 条尚未推送到远端的本地提交，迁移已中止：未删除、未移动任何文件。下一步：请在该目录手动执行 git push origin main 把所有提交推到远端，确认推送成功后重新运行迁移；本模块绝不丢弃本地提交。目标工作副本：${targetDir}`
}

/** 迁移 IO 端口；git 侧只读，backup / move 只在核账通过后调用。 */
export interface MigrationIo {
  exists(p: string): Promise<boolean>
  /** 移动前整目录备份（同卷 rename 之外的安全网）。 */
  backup(from: string, to: string): Promise<void>
  move(from: string, to: string): Promise<void>
  readMarker(markerPath: string): Promise<string | null>
  writeMarker(markerPath: string, text: string): Promise<void>
  /** 只读 git 命令；非 allowlist 子命令一律拒绝。 */
  gitRead(dir: string, args: string[]): Promise<string>
}

/** 真实 IO 适配器：git 只读白名单；move 是同卷 rename，不做复制删除。 */
export class NodeMigrationIo implements MigrationIo {
  async exists(p: string): Promise<boolean> {
    try {
      // 用 stat（而非 readFile）：目录也必须算「存在」，否则会把旧 work 目录误判为缺失。
      await stat(p)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  async backup(from: string, to: string): Promise<void> {
    await mkdir(path.dirname(to), { recursive: true })
    // 整目录复制：即便后续 move 中途失败，旧副本仍有一份逐字节备份可人工恢复。
    await cp(from, to, { recursive: true, force: false, errorOnExist: true })
  }

  async move(from: string, to: string): Promise<void> {
    await mkdir(path.dirname(to), { recursive: true })
    await rename(from, to)
  }

  async readMarker(markerPath: string): Promise<string | null> {
    try {
      return await readFile(markerPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async writeMarker(markerPath: string, text: string): Promise<void> {
    await mkdir(path.dirname(markerPath), { recursive: true })
    await writeFile(markerPath, text, { encoding: 'utf8', flag: 'w' })
  }

  async gitRead(dir: string, args: string[]): Promise<string> {
    const sub = args[0] ?? ''
    const readOnly = sub === 'rev-parse' || sub === 'rev-list' ||
      (sub === 'config' && args[1] === '--get')
    if (!readOnly) {
      throw new SyncError('E_VALIDATION', `迁移核账只接受只读 git 命令，拒绝：${sub}`)
    }
    const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
      execFile('git', args, { cwd: dir, windowsHide: true, encoding: 'utf8' }, (error, stdout, stderr) => {
        if (error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new SyncError('E_GIT', '找不到 git 可执行文件'))
          return
        }
        const code = error === null ? 0 : typeof (error as { code?: unknown }).code === 'number'
          ? (error as { code: number }).code : 1
        resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' })
      })
    })
    if (result.code !== 0) return ''
    return result.stdout.trim()
  }
}

export interface MigrationResult {
  ok: boolean
  code: string
  message: string
  from: string
  to: string
  action: 'none' | 'moved' | 'repointed'
  unpushed: number
}

function markerText(from: string, to: string): string {
  return `${JSON.stringify({ legacy: from, target: to })}\n`
}

/** 解析迁移标记并比较目标路径（JSON 会转义 Windows 反斜杠，不能做裸字符串 contains）。 */
function markerTargets(marker: string | null, target: string): boolean {
  if (marker === null) return false
  try {
    const obj = JSON.parse(marker) as Record<string, unknown>
    if (typeof obj.target !== 'string') return false
    return path.resolve(obj.target) === path.resolve(target)
  } catch {
    return false
  }
}

/**
 * 核账 + 迁移（幂等）：
 * - 旧目录不存在 → 若标记已指向目标则 no-op；不新建任何目录。
 * - 旧目录含未推提交 → 抛 `E_LEGACY_UNPUSHED`，什么也不动（verbatim 文案见 legacyUnpushedMessage）。
 * - 旧目录干净 → 目标不存在则先整目录备份再移动，目标已存在则只重指向；写标记。
 * 重复运行第二次：旧目录已不在（或标记已存在）→ `action:'none'`，状态不变。
 */
export async function migrateLegacyWorkDir(options: {
  legacyDir: string
  targetDir: string
  markerPath: string
  io: MigrationIo
}): Promise<MigrationResult> {
  const { legacyDir, targetDir, markerPath, io } = options
  const marker = await io.readMarker(markerPath)
  const alreadyMigrated = markerTargets(marker, targetDir)
  const exists = await io.exists(legacyDir)
  if (!exists) {
    if (alreadyMigrated) {
      return { ok: true, code: '', message: '已迁移（幂等 no-op）', from: legacyDir, to: targetDir, action: 'none', unpushed: 0 }
    }
    return { ok: true, code: '', message: '无旧工作副本，无需迁移', from: legacyDir, to: targetDir, action: 'none', unpushed: 0 }
  }
  // 已写过迁移标记：重复运行不再搬运/改写任何文件（重指向场景下旧目录可能仍在，纯属运维残留）。
  if (alreadyMigrated) {
    return { ok: true, code: '', message: '已迁移（幂等 no-op）', from: legacyDir, to: targetDir, action: 'none', unpushed: 0 }
  }

  // 核账：origin/main..HEAD 的提交数就是远端没有的本地提交；取不到引用时保守视为未知（不视为 0）。
  const origin = await io.gitRead(legacyDir, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main'])
  const head = await io.gitRead(legacyDir, ['rev-parse', '--verify', '--quiet', 'HEAD'])
  let unpushed = 0
  if (origin !== '' && head !== '') {
    const count = await io.gitRead(legacyDir, ['rev-list', '--count', `${origin}..HEAD`])
    const value = Number.parseInt(count, 10)
    unpushed = Number.isFinite(value) ? value : 1
  } else if (head !== '') {
    // 旧副本有提交但拿不到 origin/main：无法证明干净，按「未知 = 有风险」处理。
    unpushed = 1
  } else if (await io.exists(path.join(legacyDir, '.git'))) {
    // m3：看起来是 git 仓库但 HEAD 都解析不出来（损坏 / 瞬时故障）→ fail-closed。
    unpushed = 1
  }
  if (unpushed > 0) {
    throw new SyncError(E_LEGACY_UNPUSHED, legacyUnpushedMessage(legacyDir, targetDir, unpushed), {
      from: legacyDir, to: targetDir, unpushed,
    })
  }

  const targetExists = await io.exists(targetDir)
  if (targetExists) {
    // M5：重指向前必须确认目标就是同一个远端仓库的有效工作副本；不一致则零触碰。
    const legacyOrigin = await io.gitRead(legacyDir, ['config', '--get', 'remote.origin.url'])
    const targetOrigin = await io.gitRead(targetDir, ['config', '--get', 'remote.origin.url'])
    const targetIsWorkTree = await io.gitRead(targetDir, ['rev-parse', '--is-inside-work-tree'])
    if (legacyOrigin === '' || targetOrigin === '' || legacyOrigin !== targetOrigin || targetIsWorkTree !== 'true') {
      throw new SyncError(E_MIGRATION_TARGET_MISMATCH,
        targetMismatchMessage(legacyDir, targetDir, legacyOrigin, targetOrigin),
        { from: legacyDir, to: targetDir, legacyOrigin, targetOrigin, targetIsWorkTree })
    }
    await io.writeMarker(markerPath, markerText(legacyDir, targetDir))
    return { ok: true, code: '', message: '旧副本已核对干净，重指向共享 clone', from: legacyDir, to: targetDir, action: 'repointed', unpushed: 0 }
  }
  // 备份先于移动：备份目录存在则视为上次已备份，避免重复覆盖安全网。
  const backupDir = `${legacyDir}.dsh-backup`
  if (!await io.exists(backupDir)) await io.backup(legacyDir, backupDir)
  await io.move(legacyDir, targetDir)
  await io.writeMarker(markerPath, markerText(legacyDir, targetDir))
  return { ok: true, code: '', message: '旧副本已核对干净，已备份并移动到新工作根', from: legacyDir, to: targetDir, action: 'moved', unpushed: 0 }
}

/**
 * 生产迁移门禁（`mod-plugin-repo-root`）：**只有**旧 `work/<repoHash>` 存在且新
 * `repos/<repoHash>` 不存在时才调用底层迁移；其余情况零 IO、零文件搬运，语义无二义。
 * 新工作根已经存在（哪怕为空）就绝不搬旧目录——两份副本都合法，由运维决定如何合并。
 */
export async function migrateIfNeeded(options: {
  legacyDir: string
  newRoot: string
  targetDir: string
  markerPath: string
  io: MigrationIo
}): Promise<MigrationResult> {
  const { legacyDir, newRoot, targetDir, markerPath, io } = options
  const [legacyExists, newRootExists] = await Promise.all([io.exists(legacyDir), io.exists(newRoot)])
  if (!legacyExists || newRootExists) {
    return {
      ok: true, code: '', message: '迁移门禁未触发（旧副本不存在或新工作根已存在）',
      from: legacyDir, to: targetDir, action: 'none', unpushed: 0,
    }
  }
  return await migrateLegacyWorkDir({ legacyDir, targetDir, markerPath, io })
}
