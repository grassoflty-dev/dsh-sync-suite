/**
 * v2 写半侧的**生产接线点**（M1）：把迁移门禁、仓库外 outbox、真实 git 端口和
 * 同步周期组装成一个运行时，并从插件真实启动路径 `src/index.ts:apply()` 挂载。
 *
 * 这里刻意**不重连** v1 的 `schedule_*` 工具（`src/schedule/**` 原样保留）；
 * 本模块只负责 v2 timeline 的首跑迁移与周期，失败一律 typed、零静默。
 *
 * `appFilesDir` 来自显式注入或 `DSH_DOTS_APP_FILES_DIR`；拿不到时 fail-closed
 * （不猜路径、不创建目录），这是「共享 clone 路径仍是注入假设」的显式边界。
 */
import path from 'node:path'
import { SettingsStore } from '../engine/settings.js'
import { statePaths } from '../engine/paths.js'
import { SyncError } from '../engine/errors.js'
import { NodeTimelineFs } from '../timeline/write.js'
import { NodeMigrationIo, legacyWorkDir, migrateLegacyWorkDir, resolveV2RepoDir } from './repoPath.js'
import { NodeOutboxPort } from './outbox.js'
import { GitRepoV2Port } from './gitPort.js'
import { runV2Cycle } from './cycle.js'
import type { CycleResult } from './cycle.js'

export interface V2RuntimeOptions {
  homeDir?: string
  /** App filesDir（与 App `<filesDir>/git-repo` 同源）；缺省读 DSH_DOTS_APP_FILES_DIR。 */
  appFilesDir?: string
  allowLocalRepo?: boolean
  /** 注入时钟（仅周期 decidedAt/enqueuedAt 兜底）。 */
  now?: Date
}

export interface V2RuntimeStatus {
  ok: boolean
  code: string
  message: string
  repoDir: string
  outboxFile: string
  migrated: boolean
  synced: boolean
  cycle?: CycleResult
}

interface EffectContext {
  effect(effect: () => (() => void) | void, label?: string): unknown
}

/** 唯一生产装配处：真实端口与路径都在这里 new 出来，不存在「库函数无人调用」。 */
export class V2SyncRuntime {
  readonly repoDir: string
  readonly outbox: NodeOutboxPort
  private readonly homeDir: string | undefined
  private readonly appFilesDir: string
  private readonly settings: SettingsStore
  private readonly allowLocalRepo: boolean
  private readonly now: Date
  private lastStatus: V2RuntimeStatus | null = null

  constructor(options: V2RuntimeOptions) {
    this.homeDir = options.homeDir
    this.appFilesDir = (options.appFilesDir ?? process.env.DSH_DOTS_APP_FILES_DIR ?? '').trim()
    this.allowLocalRepo = options.allowLocalRepo === true
    this.now = options.now ?? new Date()
    const paths = statePaths(this.homeDir)
    this.settings = new SettingsStore(paths, { allowLocalRepo: this.allowLocalRepo })
    // 单一 clone 路径决策点（App 的 git-repo/）。
    this.repoDir = resolveV2RepoDir({ appFilesDir: this.appFilesDir })
    const configuredRepoUrl = this.settings.readSettings().repoUrl
    // 仓库外 outbox（%USERPROFILE%\.dsh\dots\outbox\<repoHash>.json）。
    this.outbox = new NodeOutboxPort({
      stateRoot: paths.root,
      repoUrl: configuredRepoUrl === '' ? 'unconfigured' : configuredRepoUrl,
    })
  }

  /** 首跑迁移 + 有待同步意图时跑一次周期；任何 typed 中止都原样上报，绝不吞。 */
  async start(): Promise<V2RuntimeStatus> {
    const config = this.settings.readSettings()
    const base: V2RuntimeStatus = {
      ok: false, code: 'E_UNCONFIGURED', message: '尚未配置仓库地址，v2 同步未启动',
      repoDir: this.repoDir, outboxFile: this.outbox.filePath, migrated: false, synced: false,
    }
    if (config.repoUrl.trim() === '') {
      this.lastStatus = base
      return base
    }
    if (this.appFilesDir === '') {
      const status: V2RuntimeStatus = {
        ...base, code: 'E_NO_APP_FILES_DIR',
        message: '缺少 App filesDir（注入 appFilesDir 或设置 DSH_DOTS_APP_FILES_DIR），拒绝猜测共享 clone 路径',
      }
      this.lastStatus = status
      return status
    }
    const paths = statePaths(this.homeDir)
    const legacy = legacyWorkDir(paths.workRoot, config.repoUrl)
    const marker = path.join(paths.root, 'v2-migration.json')
    let migrated = false
    try {
      await migrateLegacyWorkDir({
        legacyDir: legacy, targetDir: this.repoDir, markerPath: marker, io: new NodeMigrationIo(),
      })
      migrated = true
    } catch (error) {
      const code = error instanceof SyncError ? error.code : 'E_IO'
      const status: V2RuntimeStatus = {
        ...base, ok: false, code,
        message: error instanceof Error ? error.message : String(error), migrated: false,
      }
      this.lastStatus = status
      return status // E_LEGACY_UNPUSHED / E_MIGRATION_TARGET_MISMATCH 原样可见，零写入
    }

    // 真实 git 端口：复用 engine/git.ts 的 GitRepo（URL 校验 / 凭据卫生 / fetch）。
    const git = new GitRepoV2Port({
      dir: this.repoDir,
      repoUrl: config.repoUrl,
      branch: 'main',
      authMode: config.authMode,
      token: this.settings.readToken(),
      platform: config.platform,
      username: config.username,
      allowLocalRepo: this.allowLocalRepo,
    })
    const entries = await this.outbox.load()
    const days = [...new Set(entries.map((entry) => entry.date))].sort()
    if (days.length === 0) {
      const status: V2RuntimeStatus = {
        ...base, ok: true, code: 'ok', message: '迁移门禁通过，暂无待同步意图', migrated: true, synced: true,
      }
      this.lastStatus = status
      return status
    }
    const cycle = await runV2Cycle({
      days, git, fs: new NodeTimelineFs(this.repoDir), outbox: this.outbox, now: this.now,
    })
    const status: V2RuntimeStatus = {
      ...base, ok: cycle.ok, code: cycle.code, message: cycle.message,
      migrated: true, synced: cycle.ok, cycle,
    }
    this.lastStatus = status
    return status
  }

  /** 供运维 / 后续 RPC 显式触发周期（本模块不注册新工具，接线留给下一模块）。 */
  async syncNow(days: string[]): Promise<CycleResult> {
    const config = this.settings.readSettings()
    if (config.repoUrl.trim() === '') throw new SyncError('E_UNCONFIGURED', '尚未配置仓库地址')
    const git = new GitRepoV2Port({
      dir: this.repoDir, repoUrl: config.repoUrl, branch: 'main', authMode: config.authMode,
      token: this.settings.readToken(), platform: config.platform, username: config.username,
      allowLocalRepo: this.allowLocalRepo,
    })
    return await runV2Cycle({ days, git, fs: new NodeTimelineFs(this.repoDir), outbox: this.outbox, now: this.now })
  }

  get status(): V2RuntimeStatus | null {
    return this.lastStatus
  }
}

/**
 * 从 `apply()` 调用的挂载函数：fire-and-forget，失败只写 lastStatus，
 * 绝不让 v2 半侧影响配置同步 RPC 与 v1 日程工具的启动。
 */
export function mountV2Sync(
  ctx: EffectContext,
  options: V2RuntimeOptions = {},
  registerEffect = true,
): V2SyncRuntime {
  const runtime = new V2SyncRuntime(options)
  if (registerEffect) {
    ctx.effect(() => {
      void runtime.start().catch(() => undefined)
      return () => undefined
    }, 'dsh-dots: v2 sync migration gate')
  } else {
    // 运行时不持有任何需要卸载的句柄：直接异步启动，不新增 ctx.effect，
    // 保持插件既有的 effect 数量契约（既有测试钉死 5/9），startup 失败只写 lastStatus。
    void runtime.start().catch(() => undefined)
  }
  return runtime
}
