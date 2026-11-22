/**
 * RPC 服务：`POST /dsh-dots/rpc`，body `{action, ...}`。
 *
 * 响应恒 HTTP 200 + `{ok:true,data}` / `{ok:false,error:{code,message,details?}}`
 * （只有鉴权失败由 connection 返回 401/403）。所有写操作串行队列；
 * 未知 action → E_UNKNOWN_ACTION；参数非法 → E_VALIDATION。
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { chatPresetInfo } from './chatPreset/index.js'
import type { ChatExportOutcome, ChatExportStatus } from './chats/index.js'
import { exportChatsToRepo, normalizeLimit, readChatExportStatus } from './chats/index.js'
import { collectLocal, isFileInScope, pluginsOf, serializeManifest, SYNC_FILE_NAMES } from './engine/collect.js'
import type { CollectResult } from './engine/collect.js'
import { diffFiles, diffText } from './engine/diff.js'
import type { DiffSummary, UnifiedHunk } from './engine/diff.js'
import { SyncError, errorMessage, isSyncError, toRpcError } from './engine/errors.js'
import { GitRepo } from './engine/git.js'
import type { StatePaths } from './engine/paths.js'
import { detectDshVersion, repoHash, resolveProfileDir, statePaths } from './engine/paths.js'
import type { InternalPreview, PreviewResult } from './engine/preview.js'
import { PreviewCache, buildPreview, fileDiffOfPreview, settingsFingerprint } from './engine/preview.js'
import { applySelected, previewRollback, rollbackSnapshot } from './engine/restore.js'
import type { ApplyResult, RollbackPreview, RpcHooks } from './engine/restore.js'
import { containsSecretValue } from './engine/secrets.js'
import { SettingsStore, LocalStateStore, normalizeSettings, resolveToken } from './engine/settings.js'
import { SnapshotStore } from './engine/snapshot.js'
import type {
  GetStateData,
  PluginEntry,
  RpcResponse,
  SnapshotMeta,
  SyncSettings,
  SyncStatus,
} from './engine/types.js'
// 只 import 远程访问域的**类型**契约（不 import remote/index.ts）：
// RPC 层与远程运行时编译解耦，也避免两边并行开发时互相拖死构建。
import type {
  LanCandidate,
  RemoteAccessMode,
  RemoteLink,
  RemoteProbeResult,
  RemoteServiceLike,
  RemoteStateData,
  RemoteStatus,
} from './remote/types.js'
// mod-plugin-remote-tools：只读远程工具。四个 action 只接受 instanceId 走 allow-list，
// 不接调用方 URL；grant 表与实例清单都落在插件状态目录（同步仓库之外）。
import { GrantStore } from './remote/grants.js'
import type { GrantTool } from './remote/grants.js'
import { InstanceRegistry, redactInstanceUrl } from './remote/instances.js'
import type { RemoteInstance } from './remote/instances.js'
import { localSessionEvents, localSessionInfo, localSessionList } from './remote/localRead.js'
import { projectInstanceList, projectReadResult, type RemoteReadAction } from './remote/projection.js'
import { mapRemoteCode, remoteToolError, REMOTE_TOOL_ERROR_CODES } from './remote/toolErrors.js'
// mod-plugin-pairing：RPC 只依赖配对服务的结构类型，不 import 证书 / QR / 监听实现。
import type {
  PairingOverride,
  PairingProvisionResult,
  PairingServiceLike,
} from './remote/pairingProvision.js'

/** 注入的远端响应头（只需 get，便于测试塞假实现）。 */
export interface RemoteFetchHeadersLike {
  get(name: string): string | null
}

/** 注入的响应流读取器：用分块读取做字节级硬上限，不能只信 Content-Length。 */
export interface RemoteFetchBodyReaderLike {
  read(): Promise<{ done: boolean; value?: Uint8Array }>
  cancel(reason?: unknown): Promise<void>
}

export interface RemoteFetchBodyLike {
  getReader(): RemoteFetchBodyReaderLike
}

/**
 * 注入的远端 HTTP 响应。
 * `json()` 保留给兼容旧假实现，但本模块**不再调用它**——必须先按字节封顶再自行解析。
 */
export interface RemoteFetchResponseLike {
  ok: boolean
  status: number
  headers?: RemoteFetchHeadersLike
  body?: RemoteFetchBodyLike | null
  arrayBuffer(): Promise<ArrayBuffer>
  json(): Promise<unknown>
}

/** 注入的 HTTP 入参；`signal` 用 unknown 是为了让假实现不必依赖 DOM 类型。 */
export interface RemoteFetchInitLike {
  method: string
  headers: Record<string, string>
  body: string
  signal: unknown
}

export type RemoteFetchLike = (url: string, init: RemoteFetchInitLike) => Promise<RemoteFetchResponseLike>

/** 只读远程工具的可替换依赖（测试注入假实例表 / 假授权表 / 假 HTTP 层）。 */
export interface RemoteToolsOptions {
  instances?: InstanceRegistry
  grants?: GrantStore
  fetch?: RemoteFetchLike
}

export interface RpcServiceOptions {
  homeDir?: string
  profileDir?: string
  dshVersion?: string
  allowLocalRepo?: boolean
  now?: () => Date
  hooks?: RpcHooks
  /** 单次网络命令超时（毫秒，默认 ≤8000）；测试可注入更小值。 */
  networkTimeoutMs?: number
  /**
   * 远程访问服务（可选）。未注入时所有 `remote*` action 一律 fail-closed，
   * 返回 `E_INTERNAL 远程访问服务未挂载`，绝不静默返回空状态
   * （否则 UI 会把"没装服务"误显示成"未启用"）。
   */
  remote?: RemoteServiceLike
  /**
   * 只读远程工具依赖（可注入假实现）。未注入时按 `homeDir` 自建实例 allow-list 与 grant 表，
   * HTTP 走全局 fetch（与 `remote/service.ts` 同一套，不新建 fetch stack）。
   */
  remoteTools?: RemoteToolsOptions
  /**
   * mod-plugin-pairing 服务（可选）。未注入时所有 `pairing*` action 一律 fail-closed，
   * 返回 `E_INTERNAL 配对服务未挂载`，绝不返回空 payload 让 UI 画出假二维码。
   */
  pairing?: PairingServiceLike
}

export interface RpcService {
  paths: StatePaths
  handleRpc(body: unknown): Promise<RpcResponse>
  dispose(): Promise<void>
}

/**
 * `previewDiff` 的返回体（docs/PLUGIN-DIFF.md §2）。
 *
 * `local: true`  = 本机：本地工作副本（上次推送的快照）vs 当前 profile 采集结果，真文件级差异；
 * `local: false` = 远端设备：复用 `buildPreview` 的 entry 级差异，路径为
 *                  `devices/<deviceId>/cordis.patch.yml#<entryId>` 的伪文件形式。
 */
export interface PreviewDiffData {
  sourceDevice: string
  local: boolean
  summary: DiffSummary
  hunks: UnifiedHunk[]
  /**
   * **还有差异没展示**（M1）：某个文件的 hunk 因预算被裁，或后续 hunk 被整段丢弃。
   * 不能只看 `hunks[].truncated`——预算恰好用完时后续 hunk 根本没产出。
   */
  truncated: boolean
}

export interface ConnectionLike {
  requestRejection(req: unknown): number | null | undefined
}

const MAX_BODY_BYTES = 10 * 1024 * 1024

/**
 * 远端只读响应的字节硬上限 4 MiB（4 * 1024 * 1024）。
 * 取值依据：本工具一次最多投影 500 条事件，每条正文在白名单里截到 2000 字符；
 * 中文按 UTF-8 最坏 3 字节/字符 ≈ 500 * 2000 * 3 = 3 MB，再加 JSON 键与转义余量，
 * 4 MiB 覆盖合法上限且仍把恶意 peer 的内存占用钉死在一个量级。
 * 注意：8 秒 AbortSignal 只是**时间**上限；没有这个字节上限，peer 可以在 8 秒内
 * 推任意大体量，解析前就把进程内存吃光。
 */
const REMOTE_RESPONSE_MAX_BYTES = 4 * 1024 * 1024

function ok<T>(data: T): RpcResponse<T> {
  return { ok: true, data }
}

function asRecord(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function createRpcService(options: RpcServiceOptions = {}): RpcService {
  const now = options.now ?? ((): Date => new Date())
  const dshVersion = options.dshVersion ?? detectDshVersion(options.homeDir)
  const paths = statePaths(options.homeDir)
  const profileDir = resolveProfileDir({ homeDir: options.homeDir, profileDir: options.profileDir })
  const store = new SettingsStore(paths, { allowLocalRepo: options.allowLocalRepo === true })
  const stateStore = new LocalStateStore(paths)
  const snapshots = new SnapshotStore(paths.snapshotRoot)
  const cache = new PreviewCache()
  const hooks = options.hooks

  // 只读工具的依赖：默认落插件状态目录；HTTP 默认走全局 fetch（无新依赖、无 token 日志）。
  const instances = options.remoteTools?.instances ?? new InstanceRegistry({ homeDir: options.homeDir })
  const grants = options.remoteTools?.grants ?? new GrantStore({ homeDir: options.homeDir, now })
  const remoteFetch: RemoteFetchLike =
    options.remoteTools?.fetch ??
    ((url, init) => fetch(url, init as RequestInit) as unknown as Promise<RemoteFetchResponseLike>)

  let queue: Promise<unknown> = Promise.resolve()
  let disposed = false

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task)
    queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  function requireConfigured(): SyncSettings {
    const settings = store.readSettings()
    if (settings.repoUrl === '') throw new SyncError('E_VALIDATION', '尚未配置仓库地址')
    return settings
  }

  async function withRepo<T>(settings: SyncSettings, task: (repo: GitRepo, token: string | null) => Promise<T>): Promise<T> {
    const token = store.readToken()
    const repo = new GitRepo({
      dir: workDirOf(settings),
      repoUrl: settings.repoUrl,
      branch: settings.branch,
      authMode: settings.authMode,
      platform: settings.platform,
      username: settings.username ?? '',
      token,
      allowLocalRepo: options.allowLocalRepo === true,
      ...(options.networkTimeoutMs !== undefined ? { networkTimeoutMs: options.networkTimeoutMs } : {}),
    })
    try {
      return await task(repo, token)
    } finally {
      await repo.dispose()
    }
  }

  function workDirOf(settings: SyncSettings): string {
    return path.join(paths.workRoot, repoHash(settings.repoUrl))
  }

  /** 网络类失败（只有这类才把 reachable 记成 false；本地 git 错误不算"不可达"）。 */
  function isNetworkFailure(error: unknown): boolean {
    if (!isSyncError(error)) return false
    if (error.code === 'E_AUTH') return true
    if (error.code !== 'E_GIT') return false
    const details = error.details
    if (details !== null && typeof details === 'object') {
      const record = details as Record<string, unknown>
      if (record.network === true) return true
      if (record.reason === 'git-missing') return false
    }
    return false
  }

  /** 记录最近一次网络探测结果；状态文件只是 UI 事实，写失败不影响主流程。 */
  function recordProbe(reachable: boolean): void {
    try {
      stateStore.writeReachable(reachable)
    } catch {
      /* state.json 写失败不应让已经成功的同步变成失败 */
    }
  }

  function assertNoTokenInPayload(collected: CollectResult, token: string | null): void {
    if (token === null) return
    for (const name of SYNC_FILE_NAMES) {
      if (containsSecretValue(collected.files[name], token)) {
        throw new SyncError('E_VALIDATION', `同步载荷 ${name} 里检测到 token 明文，已中止推送`, { file: name })
      }
    }
    if (containsSecretValue(serializeManifest(collected.manifest), token)) {
      throw new SyncError('E_VALIDATION', 'manifest 里检测到 token 明文，已中止推送')
    }
  }

  /**
   * getState：**绝不联网**，只读本地工作副本 + 状态文件。
   *
   * - `branch`：本地工作副本当前分支；未 clone 时用 settings.branch；
   * - `head*`：本地 HEAD（`git log -1`，纯本地命令）；
   * - `localPending`/`remotePending`：相对本地 `origin/<branch>` 引用计算，无该引用 → null（不 fetch）；
   * - `conflict`：ahead>0 && behind>0；
   * - `reachable`：状态文件里最近一次 testConnection/push/preview 的探测结果（三态）；
   * - `lastSyncAt`：状态文件里的最近一次成功同步时间；
   * - `error`：只填本地读取错误（工作副本损坏等）。网络不可达**不是**错误。
   */
  async function getState(): Promise<GetStateData> {
    const settings = store.readSettings()
    const status: SyncStatus = {
      reachable: stateStore.readReachable(),
      branch: settings.branch,
      headSha: '',
      headMessage: '',
      headTime: '',
      localPending: null,
      remotePending: null,
      conflict: false,
      lastSyncAt: stateStore.readLastSyncAt(),
    }
    const snapshotList: SnapshotMeta[] = snapshots.list()
    if (settings.repoUrl === '') {
      // 未配置仓库地址不是"读取失败"：UI 从 settings.repoUrl 就能看出来，error 只留给本地读取错误。
      return { settings: { ...settings, hasToken: store.hasToken() }, status, snapshots: snapshotList }
    }
    // 没有工作副本 → 没有本地 HEAD，也没有 origin/<branch> 引用；直接返回本地事实，不 clone、不 fetch。
    if (!existsSync(path.join(workDirOf(settings), '.git'))) {
      return { settings: { ...settings, hasToken: store.hasToken() }, status, snapshots: snapshotList }
    }
    try {
      await withRepo(settings, async (repo) => {
        const head = await repo.head()
        const local = await repo.status()
        status.branch = local.branch
        status.headSha = head.sha
        status.headMessage = head.message
        status.headTime = head.time
        status.localPending = local.ahead
        status.remotePending = local.behind
        // 只有"双方各有对方没有的提交"才算分叉冲突；单纯落后（可直接快进/自动 rebase）不是冲突。
        status.conflict = local.ahead !== null && local.behind !== null && local.ahead > 0 && local.behind > 0
      })
    } catch (error) {
      // 只有本地读取失败（工作副本损坏、git 不可用等）才进 error。
      status.error = errorMessage(error)
    }
    return { settings: { ...settings, hasToken: store.hasToken() }, status, snapshots: snapshotList }
  }

  /** 记录最近一次成功同步的时间；状态文件写失败不应让已成功的同步变成失败。 */
  function markSynced(): void {
    try {
      stateStore.writeLastSyncAt(now().toISOString())
    } catch {
      /* state.json 只是 UI 展示用的运行事实，写失败不影响同步结果 */
    }
  }

  async function saveSettings(payload: Record<string, unknown>): Promise<{ settings: SyncSettings; hasToken: boolean }> {
    const previous = store.readSettings()
    const next = normalizeSettings(payload.settings, previous, { allowLocalRepo: options.allowLocalRepo === true })
    const token = resolveToken(payload.token as string | null | undefined, store.readToken())
    // 先把两个值都校验完再落盘，避免 settings 已写、token 校验失败留下半套配置。
    store.writeSettings(next)
    store.writeToken(token)
    if (next.repoUrl !== previous.repoUrl) {
      // 换了仓库地址：上一次探测结果不再代表当前目标，回到"未探测"三态。
      try {
        stateStore.writeReachable(null)
      } catch {
        /* 状态文件只是 UI 事实，写失败不影响保存设置 */
      }
    }
    return { settings: next, hasToken: store.hasToken() }
  }

  /** testConnection 是"显式网络动作"：成功记 true，网络失败记 false（并继续向上抛错）。 */
  async function testConnection(): Promise<{ reachable: boolean; branch: string; headSha: string; message: string }> {
    const settings = requireConfigured()
    try {
      const result = await withRepo(settings, async (repo) => {
        const remote = await repo.lsRemote()
        return {
          reachable: remote.reachable,
          branch: remote.branch,
          headSha: remote.headSha,
          message: remote.message,
        }
      })
      recordProbe(true)
      return result
    } catch (error) {
      if (isNetworkFailure(error)) recordProbe(false)
      throw error
    }
  }

  async function push(): Promise<{
    pushed: boolean
    commit: string
    branch: string
    files: string[]
    rebased: boolean
  }> {
    const settings = requireConfigured()
    try {
      const result = await withRepo(settings, async (repo, token) => {
        await repo.ensureWorkTree()
        const collected = collectLocal({
          profileDir,
          homeDir: options.homeDir,
          deviceId: settings.deviceId,
          scopes: settings.scope,
          dshVersion,
          now: now(),
        })
        assertNoTokenInPayload(collected, token)

        const deviceDir = path.join(repo.dir, 'devices', settings.deviceId)
        await mkdir(deviceDir, { recursive: true })
        const written: string[] = []
        for (const name of SYNC_FILE_NAMES) {
          // 未勾选的范围写空内容：保持 devices/<id>/ 布局稳定，manifest 的 sha256 才始终可校验。
          await writeFile(path.join(deviceDir, name), collected.files[name], { encoding: 'utf8' })
          if (isFileInScope(name, settings.scope)) written.push(name)
        }
        await writeFile(path.join(deviceDir, 'manifest.json'), serializeManifest(collected.manifest), {
          encoding: 'utf8',
        })
        written.push('manifest.json')

        const message = `dsh-dots: snapshot ${settings.deviceId} ${now().toISOString()}`
        const commit = await repo.commitAll(message, { onlyPath: `devices/${settings.deviceId}` })
        const pushResult = await repo.pushWithRebase()
        const head = await repo.head()
        // push 成功（含"远端已是最新"）即视为一次成功同步；内部若发生 pull --rebase 也已覆盖。
        markSynced()
        return {
          pushed: pushResult.pushed,
          commit: head.sha !== '' ? head.sha : commit.commit,
          branch: settings.branch,
          files: written,
          rebased: pushResult.rebased,
        }
      })
      recordProbe(true)
      return result
    } catch (error) {
      if (isNetworkFailure(error)) recordProbe(false)
      throw error
    }
  }

  async function preview(): Promise<PreviewResult> {
    const settings = requireConfigured()
    try {
      const result = await withRepo(settings, async (repo) => {
        const collected = collectLocal({
          profileDir,
          homeDir: options.homeDir,
          deviceId: settings.deviceId,
          scopes: settings.scope,
          dshVersion,
          now: now(),
        })
        const localPlugins: PluginEntry[] = pluginsOf(collected.files['plugins.json'])
        const built = await buildPreview({
          git: repo,
          profileDir,
          deviceId: settings.deviceId,
          scopes: settings.scope,
          fingerprint: settingsFingerprint(settings),
          now: now(),
          localFiles: collected.files,
          localPlugins,
        })
        cache.set(built.internal)
        recordProbe(built.reachable)
        return { previewId: built.result.previewId, sources: built.result.sources }
      })
      return result
    } catch (error) {
      if (isNetworkFailure(error)) recordProbe(false)
      throw error
    }
  }

  function restoreContext(): {
    profileDir: string
    paths: StatePaths
    snapshots: SnapshotStore
    hooks?: RpcHooks
    now: () => Date
  } {
    return { profileDir, paths, snapshots, hooks, now }
  }

  async function apply(payload: Record<string, unknown>): Promise<ApplyResult> {
    // confirm 门禁在任何其它动作之前。
    if (payload.confirm !== true) {
      throw new SyncError('E_CONFIRM_REQUIRED', '执行覆盖需要确认：请传 confirm: true', { action: 'apply' })
    }
    const previewId = asString(payload.previewId)
    if (previewId === '') throw new SyncError('E_VALIDATION', 'previewId 不能为空')
    const sourceDevice = asString(payload.sourceDevice)
    if (sourceDevice === '') throw new SyncError('E_VALIDATION', 'sourceDevice 不能为空')
    if (!Array.isArray(payload.entries)) throw new SyncError('E_VALIDATION', 'entries 必须是字符串数组')
    const entries = payload.entries.filter((item): item is string => typeof item === 'string' && item !== '')
    if (entries.length === 0) throw new SyncError('E_VALIDATION', 'entries 不能为空')

    const cached: InternalPreview | null = cache.get(previewId, now().getTime())
    if (cached === null) {
      throw new SyncError('E_NOT_FOUND', '预览不存在或已过期（有效期 10 分钟），请重新预览', { previewId })
    }
    const settings = requireConfigured()
    if (cached.fingerprint !== settingsFingerprint(settings)) {
      throw new SyncError('E_VALIDATION', '设置已变更，请重新预览后再执行覆盖')
    }

    const applied = await applySelected(restoreContext(), {
      confirm: payload.confirm,
      previewId,
      sourceDevice,
      entries,
      preview: cached,
    })
    // apply 是一次成功的"写回本地"同步动作，同样更新 lastSyncAt。
    markSynced()
    return applied
  }

  async function rollback(payload: Record<string, unknown>): Promise<{ restored: string[]; verified: true }> {
    if (payload.confirm !== true) {
      throw new SyncError('E_CONFIRM_REQUIRED', '历史回滚需要确认：请传 confirm: true', { action: 'rollback' })
    }
    const snapshotId = asString(payload.snapshotId)
    if (snapshotId === '') throw new SyncError('E_VALIDATION', 'snapshotId 不能为空')
    return await rollbackSnapshot(restoreContext(), { confirm: payload.confirm, snapshotId })
  }

  /* ------------------------------------------------------------------ */
  /* 差异预览 / 回滚预览（两个都是**只读** action：不建快照、不写 profile、       */
  /* 不写 state.json、不写 pendingFile。失败一律 SyncError + 中文原因）           */
  /* ------------------------------------------------------------------ */

  /**
   * 本机差异：本地工作副本 `work/<repoHash>/devices/<deviceId>/`（上次 push 的内容）
   * vs 当前 profile 的采集结果。工作副本不存在时 fail-closed，绝不"假装没有差异"。
   */
  async function previewDiffLocal(settings: SyncSettings): Promise<PreviewDiffData> {
    if (!existsSync(profileDir)) {
      throw new SyncError('E_NOT_FOUND', `当前 profile 目录不存在，无法对比差异：${profileDir}`, { profileDir })
    }
    const deviceDir = path.join(workDirOf(settings), 'devices', settings.deviceId)
    if (!existsSync(deviceDir)) {
      throw new SyncError(
        'E_NOT_FOUND',
        `本地工作副本里还没有本机快照目录 devices/${settings.deviceId}，请先推送一次后再查看差异`,
        { deviceId: settings.deviceId, deviceDir },
      )
    }

    // collectLocal 只读 profile（不写任何文件）。
    const collected = collectLocal({
      profileDir,
      homeDir: options.homeDir,
      deviceId: settings.deviceId,
      scopes: settings.scope,
      dshVersion,
      now: now(),
    })

    const before: Record<string, string> = {}
    const after: Record<string, string> = {}
    for (const name of SYNC_FILE_NAMES) {
      const file = path.join(deviceDir, name)
      before[name] = existsSync(file) ? await readFile(file, 'utf8') : ''
      after[name] = collected.files[name]
    }

    const summary = diffFiles(before, after)
    const hunks: UnifiedHunk[] = []
    let truncated = false
    for (const stat of summary.files) {
      // 二进制 / >512KB：file 级 `truncated` 已经明说"只给统计"，不产出 hunk。
      if (stat.kind === 'same' || stat.truncated === true) continue
      const result = diffText(before[stat.path] ?? '', after[stat.path] ?? '', { path: stat.path })
      for (const hunk of result.hunks) hunks.push(hunk)
      if (result.truncated) truncated = true
    }
    return { sourceDevice: settings.deviceId, local: true, summary, hunks, truncated }
  }

  /**
   * 远端设备差异：复用 `buildPreview` 的远端读取与校验路径（含 manifest sha256 校验），
   * 把 entry 级差异转成文件级 `DiffSummary`。**不写预览缓存、不写 state.json、不建快照。**
   */
  async function previewDiffRemote(settings: SyncSettings, sourceDevice: string): Promise<PreviewDiffData> {
    return await withRepo(settings, async (repo) => {
      const collected = collectLocal({
        profileDir,
        homeDir: options.homeDir,
        deviceId: settings.deviceId,
        scopes: settings.scope,
        dshVersion,
        now: now(),
      })
      const built = await buildPreview({
        git: repo,
        profileDir,
        deviceId: settings.deviceId,
        scopes: settings.scope,
        fingerprint: settingsFingerprint(settings),
        now: now(),
        localFiles: collected.files,
        localPlugins: pluginsOf(collected.files['plugins.json']),
      })
      const available = built.internal.sources.map((item) => item.deviceId)
      if (!available.includes(sourceDevice)) {
        throw new SyncError('E_NOT_FOUND', `远端没有设备 ${sourceDevice} 的快照`, { sourceDevice, available })
      }
      const filtered: InternalPreview = {
        ...built.internal,
        sources: built.internal.sources.filter((item) => item.deviceId === sourceDevice),
      }
      const diff = fileDiffOfPreview(filtered)
      return { sourceDevice, local: false, summary: diff.summary, hunks: diff.hunks, truncated: diff.truncated }
    })
  }

  /** `previewDiff`：`sourceDevice` 缺省（或等于本机 deviceId）→ 本机；否则按远端设备比对。 */
  async function previewDiff(payload: Record<string, unknown>): Promise<PreviewDiffData> {
    const settings = requireConfigured()
    const sourceDevice = asString(payload.sourceDevice).trim()
    if (sourceDevice === '' || sourceDevice === settings.deviceId) return await previewDiffLocal(settings)
    return await previewDiffRemote(settings, sourceDevice)
  }

  /** `rollbackPreview`：只读；`rollback` 的 confirm 门禁不在这里，也不放宽。 */
  async function rollbackPreview(payload: Record<string, unknown>): Promise<RollbackPreview> {
    const snapshotId = asString(payload.snapshotId)
    if (snapshotId === '') throw new SyncError('E_VALIDATION', 'snapshotId 不能为空')
    return await previewRollback(restoreContext(), { snapshotId })
  }

  /* ------------------------------------------------------------------ */
  /* 远程访问（remote.* action）                                          */
  /* ------------------------------------------------------------------ */

  /**
   * 取远程访问服务。未注入即抛 E_INTERNAL（fail-closed），不做"看起来没开"的空返回。
   */
  function requireRemote(): RemoteServiceLike {
    const remote = options.remote
    if (remote === undefined) throw new SyncError('E_INTERNAL', '远程访问服务未挂载')
    return remote
  }

  /**
   * 归一 `payload.mode`：只认契约里的 6 个值，其余（含缺省/非字符串/拼错）一律 undefined，
   * 交给远程域按"当前设置的方式"处理。这里不猜、不兜底成 lan。
   */
  function asRemoteMode(value: unknown): RemoteAccessMode | undefined {
    switch (value) {
      case 'lan':
      case 'tailscale':
      case 'ipv6':
      case 'cloudflare':
      case 'manual':
      case 'uu':
        return value
      default:
        return undefined
    }
  }

  /**
   * token 纪律（契约）：明文 token 只允许出现在 `remoteShowLink` 的返回体里
   * （用户显式点「显示二维码与链接」时的唯一出口）。因此本文件所有 remote 动作
   * 构建错误时**不得**回显入参（尤其 `settings.manualUrl`，它可含 token），
   * 下面的实现只透传远程域自己抛出的错误，不自己拼任何含载荷的 message。
   */
  async function remoteGetState(): Promise<RemoteStateData> {
    return await requireRemote().getState()
  }

  async function remoteSaveSettings(payload: Record<string, unknown>): Promise<RemoteStateData> {
    // 只把 `payload.settings` 原样交给远程域（字段归一与校验由它负责，RPC 层不重复实现）。
    return await requireRemote().saveSettings(payload.settings)
  }

  async function remoteStart(): Promise<RemoteStatus> {
    // start/stop 与现有写操作同一串行队列：两个监听动作绝不会并发。
    return await requireRemote().start()
  }

  async function remoteStop(): Promise<RemoteStatus> {
    return await requireRemote().stop()
  }

  async function remoteRotateToken(): Promise<RemoteStatus> {
    return await requireRemote().rotateToken()
  }

  async function remoteProbe(payload: Record<string, unknown>): Promise<RemoteProbeResult> {
    return await requireRemote().probe(asRemoteMode(payload.mode))
  }

  async function remoteShowLink(payload: Record<string, unknown>): Promise<RemoteLink> {
    return await requireRemote().showLink(asRemoteMode(payload.mode))
  }

  async function remoteDetectLan(): Promise<{ candidates: LanCandidate[] }> {
    return { candidates: requireRemote().detectLan() }
  }

  /**
   * 采用 provisioning 已生成的令牌并同步令牌门；返回体只有 ok，token 不进 RPC 响应。
   */
  async function remoteAdoptToken(payload: Record<string, unknown>): Promise<{ ok: boolean }> {
    const remote = requireRemote()
    if (typeof remote.adoptToken !== 'function') throw new SyncError('E_INTERNAL', '令牌同步接缝未装配')
    const token = asString(payload.token)
    const result = remote.adoptToken(token)
    if (!result.ok) throw new SyncError('E_VALIDATION', '配对令牌格式不合法')
    return { ok: true }
  }

  /* ------------------------------------------------------------------ */
  /* mod-plugin-pairing：一机一码配对                                     */
  /*                                                                    */
  /* 硬纪律：`pairingProvision` / `pairingRotate*` / `pairingTransports`   */
  /* 只返回脱敏视图；**只有**显式 `pairingShow` 才返回规范载荷 + 二维码。  */
  /* ------------------------------------------------------------------ */

  function requirePairing(): PairingServiceLike {
    const pairing = options.pairing
    if (pairing === undefined) throw new SyncError('E_INTERNAL', '配对服务未挂载')
    return pairing
  }

  /** 面板手动覆盖的方式：只认三个具体值或 'auto'；其余一律当自动（不猜、不给死地址）。 */
  function asPairingOverride(payload: Record<string, unknown>): PairingOverride {
    switch (payload.transport) {
      case 'tailscale':
      case 'lan':
      case 'ipv6':
        return payload.transport
      case 'auto':
        return 'auto'
      default:
        return undefined
    }
  }

  /** 内部完整状态（含 token / 私钥）绝不跨这个边界；重发信息只给 key / reason / port。 */
  function pairingViewOf(result: PairingProvisionResult): {
    view: PairingProvisionResult['view']
    changed: PairingProvisionResult['changed']
    republish: { key: string; reason: string; previousPort: number; port: number } | null
  } {
    return {
      view: result.view,
      changed: result.changed,
      republish: result.republish === null ? null : {
        key: result.republish.key,
        reason: result.republish.reason,
        previousPort: result.republish.previousPort,
        port: result.republish.port,
      },
    }
  }

  async function pairingProvision(payload: Record<string, unknown>): Promise<ReturnType<typeof pairingViewOf>> {
    return pairingViewOf(await requirePairing().provision(asPairingOverride(payload)))
  }

  async function pairingShow(payload: Record<string, unknown>): Promise<Awaited<ReturnType<PairingServiceLike['show']>>> {
    return await requirePairing().show(asPairingOverride(payload))
  }

  async function pairingRotateToken(payload: Record<string, unknown>): Promise<ReturnType<typeof pairingViewOf>> {
    return pairingViewOf(await requirePairing().rotateToken(asPairingOverride(payload)))
  }

  async function pairingRotateCert(payload: Record<string, unknown>): Promise<ReturnType<typeof pairingViewOf>> {
    return pairingViewOf(await requirePairing().rotateCert(asPairingOverride(payload)))
  }

  async function pairingTransports(payload: Record<string, unknown>): Promise<Awaited<ReturnType<PairingServiceLike['transports']>>> {
    return await requirePairing().transports(asPairingOverride(payload))
  }

  /** 只有脱敏的 {at, peer}；不回地址、token 或 URL。 */
  async function pairingConnections(): Promise<Awaited<ReturnType<PairingServiceLike['connections']>>> {
    return await requirePairing().connections()
  }

  /* ------------------------------------------------------------------ */
  /* 云端对话模式 P1：会话导出（chats/ 共享命名空间）                      */
  /*                                                                    */
  /* 三个 action 只读/写 `chats/`，不碰 `devices/`、不碰 `~/.dsh/sessions`   */
  /* 本身（只读那层）。日志与错误里永不出现会话正文、token 或绝对路径：     */
  /* 逐会话原因统一走 `sanitizeChatReason()`（打码 + 路径替换 + 截断）。    */
  /* ------------------------------------------------------------------ */

  /** 会话根 `<.dsh>/sessions`（RPC 内部用；`homeDir` 注入时指向测试目录）。 */
  async function chatExportStatus(): Promise<ChatExportStatus> {
    const settings = store.readSettings()
    // 未配置仓库时不给空工作副本路径（否则会去读一个不存在的目录），只报本机事实。
    const workDir = settings.repoUrl === '' ? '' : workDirOf(settings)
    return await readChatExportStatus({
      workDir,
      ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
    })
  }

  /** 导出全部（按 mtime 降序取最近 `limit` 个；默认 50，硬上限 200）。 */
  async function chatExportAll(payload: Record<string, unknown>): Promise<ChatExportOutcome> {
    const settings = requireConfigured()
    const limit = normalizeLimit(payload.limit)
    return await withRepo(settings, async (repo) =>
      exportChatsToRepo({
        repo,
        deviceId: settings.deviceId,
        limit,
        ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
      }),
    )
  }

  /** 导出单个会话；本机没有这个 id 一律 E_NOT_FOUND（不回显任何路径）。 */
  async function chatExportOne(payload: Record<string, unknown>): Promise<ChatExportOutcome> {
    const settings = requireConfigured()
    const sessionId = asString(payload.sessionId).trim()
    if (sessionId === '') throw new SyncError('E_VALIDATION', 'sessionId 不能为空')
    const outcome = await withRepo(settings, async (repo) =>
      exportChatsToRepo({
        repo,
        deviceId: settings.deviceId,
        sessionIds: [sessionId],
        ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
      }),
    )
    const item = outcome.results[0]
    if (item !== undefined && !item.ok && item.reason === 'not-found') {
      throw new SyncError('E_NOT_FOUND', '本机没有这个会话（可能已被删除或不在当前会话目录）', { sessionId })
    }
    return outcome
  }

  /* ------------------------------------------------------------------ */
  /* mod-plugin-remote-tools：只读远程工具                                 */
  /*                                                                    */
  /* 硬纪律：                                                             */
  /*   - 只认 instanceId（从 allow-list 解析），绝不接调用方 URL；           */
  /*   - 每个动作先过 grant 再出网；出网目标只能是清单里登记的 token-free base；*/
  /*   - 只有四个读 action；prompt / create / lease 写动作一律不注册。       */
  /* ------------------------------------------------------------------ */

  /** 三个会话读 action（instanceList 不走远端传输，故从投影类型里排除）。 */
  type RemoteSessionReadAction = Exclude<RemoteReadAction, 'instanceList'>

  /** action → grant 工具 id（view 子集）。 */
  function readToolOf(action: RemoteSessionReadAction): GrantTool {
    switch (action) {
      case 'sessionList': return 'session.list'
      case 'sessionInfo': return 'session.info'
      case 'sessionEvents': return 'session.events'
    }
  }

  /** 唯一的实例解析入口：id 非法 / 不在清单 → E_INSTANCE_UNKNOWN。 */
  function resolveInstance(payload: Record<string, unknown>): RemoteInstance {
    const id = asString(payload.instanceId).trim()
    if (id === '') throw remoteToolError('E_VALIDATION', 'instanceId 不能为空')
    const instance = instances.get(id)
    if (instance === null) {
      throw remoteToolError(REMOTE_TOOL_ERROR_CODES.INSTANCE_UNKNOWN, '未知实例（不在允许清单里）', { instanceId: id })
    }
    return instance
  }

  /** 门禁：精确实例 + 精确工具 + 有效期；拒绝码与"未知实例"可区分。 */
  function assertGrant(instanceId: string, tool: GrantTool): void {
    if (!grants.isGranted(instanceId, tool)) {
      throw remoteToolError(REMOTE_TOOL_ERROR_CODES.GRANT_DENIED, '没有该实例的工具授权', { instanceId, tool })
    }
  }

  /** 超上限：独立 typed 码，details 只有数字上限，绝不回显响应体。 */
  function tooLarge(instanceId: string, tool: GrantTool): SyncError {
    return remoteToolError(REMOTE_TOOL_ERROR_CODES.REMOTE_TOO_LARGE, '目标实例的响应体超过字节上限', {
      instanceId,
      tool,
      limit: REMOTE_RESPONSE_MAX_BYTES,
    })
  }

  /**
   * 字节级封顶读取：先看 Content-Length（当它>上限直接拒，不再读一字节），
   * 但**绝不信任它**——无论它缺失、撒谎说很小、还是和实际不符，都按流分块累计真实字节，
   * 一旦越过上限立即 cancel() 并抛 typed 错误；最后才对已封顶的字节做 JSON.parse。
   */
  async function readCappedBody(response: RemoteFetchResponseLike, instanceId: string, tool: GrantTool): Promise<unknown> {
    const declared = response.headers?.get('content-length')
    if (declared !== null && declared !== undefined) {
      const announced = Number(declared)
      if (Number.isFinite(announced) && announced > REMOTE_RESPONSE_MAX_BYTES) throw tooLarge(instanceId, tool)
    }

    let bytes: Uint8Array
    const reader = response.body?.getReader()
    if (reader !== undefined && reader !== null) {
      const chunks: Uint8Array[] = []
      let total = 0
      try {
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done === true) break
          const value = chunk.value ?? new Uint8Array(0)
          total += value.byteLength
          if (total > REMOTE_RESPONSE_MAX_BYTES) {
            try {
              await reader.cancel('response-too-large')
            } catch {
              /* 取消失败不改变"已拒绝"这一事实 */
            }
            throw tooLarge(instanceId, tool)
          }
          chunks.push(value)
        }
      } finally {
        // 正常读完也释放锁；异常路径的 cancel 已在上面处理。
        const release = (reader as { releaseLock?: () => void }).releaseLock
        if (typeof release === 'function') {
          try {
            release.call(reader)
          } catch {
            /* 释放失败不影响结果 */
          }
        }
      }
      bytes = new Uint8Array(total)
      let at = 0
      for (const chunk of chunks) {
        bytes.set(chunk, at)
        at += chunk.byteLength
      }
    } else {
      // 没有流接口的假实现/老运行时：至少在拿到完整 buffer 后按真实字节再封一次。
      let buffer: ArrayBuffer
      try {
        buffer = await response.arrayBuffer()
      } catch {
        throw remoteToolError(REMOTE_TOOL_ERROR_CODES.REMOTE_BAD_RESPONSE, '目标实例返回了无法解析的响应', { instanceId, tool })
      }
      if (buffer.byteLength > REMOTE_RESPONSE_MAX_BYTES) throw tooLarge(instanceId, tool)
      bytes = new Uint8Array(buffer)
    }

    // 到这里字节已被钉死在上限内；解析失败也只给 typed 错误，不回显任何正文。
    try {
      return JSON.parse(Buffer.from(bytes).toString('utf8'))
    } catch {
      throw remoteToolError(REMOTE_TOOL_ERROR_CODES.REMOTE_BAD_RESPONSE, '目标实例返回了无法解析的响应', { instanceId, tool })
    }
  }

  /**
   * 统一只读传输：
   *   - 本机（baseUrl 为空）→ 直接读本地会话，避免 local→HTTP→local 递归；
   *   - 远程 → 只向清单登记的 base URL 的 `/dsh-dots/rpc` POST 同名只读 action。
   * 请求体里 instanceId 恒为 `local`（让对端读它自己），调用方给的 url 字段被忽略。
   */
  async function remoteRead<T>(
    instance: RemoteInstance,
    action: RemoteSessionReadAction,
    tool: GrantTool,
    args: Record<string, unknown>,
  ): Promise<T> {
    if (instance.baseUrl === '') {
      let local: unknown
      if (action === 'sessionList') local = await localSessionList(args, options.homeDir)
      else if (action === 'sessionInfo') local = await localSessionInfo(args, options.homeDir)
      else local = await localSessionEvents(args, options.homeDir)
      if (local === null) throw new SyncError('E_NOT_FOUND', '本机没有这个会话')
      // 本机路径与远端路径共用同一投影函数，结构按构造同形。
      return projectReadResult(action, local, instance.id) as T
    }

    let url: string
    try {
      const parsed = new URL(instance.baseUrl)
      parsed.pathname = '/dsh-dots/rpc'
      parsed.search = ''
      parsed.hash = ''
      url = parsed.toString()
    } catch {
      throw remoteToolError(REMOTE_TOOL_ERROR_CODES.REMOTE_UNSUPPORTED, '实例地址不可用', { instanceId: instance.id, tool })
    }

    let response: RemoteFetchResponseLike
    try {
      response = await remoteFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // 注意：绝不把调用方 payload 里的 url / baseUrl 拼进来（allow-list 不可绕过）。
        body: JSON.stringify({ action, ...args, instanceId: 'local' }),
        signal: AbortSignal.timeout(options.networkTimeoutMs ?? 8000),
      })
    } catch {
      throw remoteToolError(REMOTE_TOOL_ERROR_CODES.REMOTE_UNREACHABLE, '目标实例不可达（网络失败或超时）', { instanceId: instance.id, tool })
    }

    const status = response.status
    if (status === 401 || status === 403) {
      throw remoteToolError(REMOTE_TOOL_ERROR_CODES.REMOTE_AUTH_REJECTED, '目标实例拒绝了访问令牌', { instanceId: instance.id, tool, status })
    }
    if (status === 404) {
      throw remoteToolError(REMOTE_TOOL_ERROR_CODES.REMOTE_UNSUPPORTED, '目标实例不支持该只读动作', { instanceId: instance.id, tool, status })
    }
    if (!response.ok) {
      throw remoteToolError(REMOTE_TOOL_ERROR_CODES.REMOTE_UNREACHABLE, '目标实例返回异常状态', { instanceId: instance.id, tool, status })
    }

    // 先按字节封顶再解析；json() 不再被调用（响应体绝不会被无界读入内存）。
    const body = await readCappedBody(response, instance.id, tool)
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw remoteToolError(REMOTE_TOOL_ERROR_CODES.REMOTE_BAD_RESPONSE, '目标实例返回了异常的响应结构', { instanceId: instance.id, tool })
    }
    const rpc = body as { ok?: unknown; data?: unknown; error?: { code?: unknown } }
    if (rpc.ok !== true) {
      // 只映射白名单 code，且 details 里没有远端文案（可能含凭据）。
      throw remoteToolError(mapRemoteCode(rpc.error?.code), '目标实例拒绝了这次读取', { instanceId: instance.id, tool })
    }
    // 只把 peer 数据按白名单投影后交给调用方，未知字段（token/path/额外数组）一律不进结果。
    return projectReadResult(action, rpc.data, instance.id) as T
  }

  /** 当前实例已经 granted 的 view 能力（给 UI 渲染徽章，不泄漏未授权实例）。 */
  function grantedCaps(instanceId: string): string[] {
    const caps: string[] = []
    if (grants.isGranted(instanceId, 'session.list')) caps.push('sessionList')
    if (grants.isGranted(instanceId, 'session.info')) caps.push('sessionInfo')
    if (grants.isGranted(instanceId, 'session.events')) caps.push('sessionEvents')
    return caps
  }

  /** 列实例：无 instance.list 授权的实例根本不出现在结果里（fail-closed）。 */
  async function instanceList(): Promise<{
    instances: Array<{ id: string; displayName: string; mode: string; urlMasked: string; capabilities: string[] }>
  }> {
    const out: Array<{ id: string; displayName: string; mode: string; urlMasked: string; capabilities: string[] }> = []
    for (const instance of instances.list()) {
      if (!grants.isGranted(instance.id, 'instance.list')) continue
      // 只回打码地址；真身 base 与任何 token 都不出这个边界。
      out.push({
        id: instance.id,
        displayName: instance.displayName,
        mode: instance.mode,
        urlMasked: redactInstanceUrl(instance.baseUrl),
        capabilities: grantedCaps(instance.id),
      })
    }
    // 和远端路径同款白名单投影；本地构造也不允许意外多字段。
    return { instances: projectInstanceList(out) }
  }

  async function sessionList(payload: Record<string, unknown>): Promise<unknown> {
    const instance = resolveInstance(payload)
    const tool = readToolOf('sessionList')
    assertGrant(instance.id, tool)
    return await remoteRead(instance, 'sessionList', tool, { limit: payload.limit, cursor: payload.cursor })
  }

  async function sessionInfo(payload: Record<string, unknown>): Promise<unknown> {
    const instance = resolveInstance(payload)
    const tool = readToolOf('sessionInfo')
    assertGrant(instance.id, tool)
    if (asString(payload.sessionId).trim() === '') throw remoteToolError('E_VALIDATION', 'sessionId 不能为空')
    return await remoteRead(instance, 'sessionInfo', tool, { sessionId: asString(payload.sessionId).trim() })
  }

  async function sessionEvents(payload: Record<string, unknown>): Promise<unknown> {
    const instance = resolveInstance(payload)
    const tool = readToolOf('sessionEvents')
    assertGrant(instance.id, tool)
    if (asString(payload.sessionId).trim() === '') throw remoteToolError('E_VALIDATION', 'sessionId 不能为空')
    return await remoteRead(instance, 'sessionEvents', tool, {
      sessionId: asString(payload.sessionId).trim(),
      fromSeq: payload.fromSeq,
      limit: payload.limit,
    })
  }

  async function handleRpc(body: unknown): Promise<RpcResponse> {
    try {
      if (disposed) throw new SyncError('E_INTERNAL', 'RPC 服务已释放')
      const payload = asRecord(body)
      const action = asString(payload.action)
      if (action === '') throw new SyncError('E_VALIDATION', '缺少 action')
      switch (action) {
        case 'getState':
          return ok(await enqueue(getState))
        case 'saveSettings':
          return ok(await enqueue(() => saveSettings(payload)))
        case 'testConnection':
          return ok(await enqueue(testConnection))
        case 'push':
          return ok(await enqueue(push))
        case 'preview':
          return ok(await enqueue(preview))
        case 'apply':
          return ok(await enqueue(() => apply(payload)))
        case 'listSnapshots':
          return ok(await enqueue(async () => ({ snapshots: snapshots.list() })))
        case 'rollback':
          return ok(await enqueue(() => rollback(payload)))
        // ---- 差异预览 / 回滚预览：只读，与写操作同一条串行队列（不会读到写一半的内容） ----
        case 'previewDiff':
          return ok(await enqueue(() => previewDiff(payload)))
        case 'rollbackPreview':
          return ok(await enqueue(() => rollbackPreview(payload)))
        // ---- 云端对话模式（P3）：只读自检，不需要鉴权之外的额外权限 ----
        // 返回 { presetId, allow, rationale }（运行期不传注册表，故不带 registeredCount/denyCount）。
        // **不再**返回静态 deny 名单：deny 是 `已注册工具 − 白名单` 的运行期反算结果。
        case 'chatPresetInfo':
          return ok(await enqueue(async () => chatPresetInfo()))
        // ---- 远程访问：与同步动作同一条串行队列（start/stop 不许并发） ----
        case 'remoteGetState':
          return ok(await enqueue(remoteGetState))
        case 'remoteSaveSettings':
          return ok(await enqueue(() => remoteSaveSettings(payload)))
        case 'remoteStart':
          return ok(await enqueue(remoteStart))
        case 'remoteStop':
          return ok(await enqueue(remoteStop))
        case 'remoteRotateToken':
          return ok(await enqueue(remoteRotateToken))
        case 'remoteProbe':
          return ok(await enqueue(() => remoteProbe(payload)))
        case 'remoteShowLink':
          return ok(await enqueue(() => remoteShowLink(payload)))
        case 'remoteDetectLan':
          return ok(await enqueue(remoteDetectLan))
        case 'remoteAdoptToken':
          return ok(await enqueue(() => remoteAdoptToken(payload)))
        // ---- mod-plugin-pairing：自动配置只读视图 + 显式二维码出口 ----
        case 'pairingProvision':
          return ok(await enqueue(() => pairingProvision(payload)))
        case 'pairingShow':
          return ok(await enqueue(() => pairingShow(payload)))
        case 'pairingRotateToken':
          return ok(await enqueue(() => pairingRotateToken(payload)))
        case 'pairingRotateCert':
          return ok(await enqueue(() => pairingRotateCert(payload)))
        case 'pairingTransports':
          return ok(await enqueue(() => pairingTransports(payload)))
        case 'pairingConnections':
          return ok(await enqueue(pairingConnections))
        // ---- 云端对话模式 P1：会话导出（chats/ 共享命名空间，与同步动作同一条串行队列） ----
        case 'chatExportStatus':
          return ok(await enqueue(chatExportStatus))
        case 'chatExportAll':
          return ok(await enqueue(() => chatExportAll(payload)))
        case 'chatExportOne':
          return ok(await enqueue(() => chatExportOne(payload)))
        // ---- mod-plugin-remote-tools：只读远程工具（无 prompt / create / lease 写动作） ----
        case 'instanceList':
          return ok(await enqueue(instanceList))
        case 'sessionList':
          return ok(await enqueue(() => sessionList(payload)))
        case 'sessionInfo':
          return ok(await enqueue(() => sessionInfo(payload)))
        case 'sessionEvents':
          return ok(await enqueue(() => sessionEvents(payload)))
        default:
          throw new SyncError('E_UNKNOWN_ACTION', `未知 action：${action}`, { action })
      }
    } catch (error) {
      return { ok: false, error: toRpcError(error) }
    }
  }

  async function dispose(): Promise<void> {
    if (disposed) return
    disposed = true
    cache.clear()
    await queue.catch(() => undefined)
  }

  return { paths, handleRpc, dispose }
}

/* -------------------------------------------------------------------------- */
/* HTTP 层                                                                     */
/* -------------------------------------------------------------------------- */

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    req.on('data', (chunk: Buffer | string) => {
      if (settled) return
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
      size += buffer.length
      if (size > MAX_BODY_BYTES) {
        settled = true
        reject(new SyncError('E_VALIDATION', '请求体超过 10 MB 上限'))
        return
      }
      chunks.push(buffer)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', (error: Error) => {
      if (settled) return
      settled = true
      reject(error)
    })
  })
}

function respond(res: ServerResponse, statusCode: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.statusCode = statusCode
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(text)
}

export function createHttpHandler(
  service: RpcService,
  connection?: ConnectionLike,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      try {
        // 鉴权：Host/Origin fence + 浏览器登录态，全部交给 connection 判定。
        if (connection !== undefined) {
          const rejection = connection.requestRejection(req)
          if (rejection !== undefined && rejection !== null) {
            res.statusCode = rejection
            res.end()
            return
          }
        }
        const method = (req.method ?? 'GET').toUpperCase()
        if (method !== 'POST') {
          res.setHeader('allow', 'POST')
          respond(res, 405, { ok: false, error: { code: 'E_VALIDATION', message: '仅支持 POST' } })
          return
        }
        let raw = ''
        try {
          raw = await readBody(req)
        } catch (error) {
          respond(res, 200, { ok: false, error: toRpcError(error) })
          return
        }
        let payload: unknown = {}
        if (raw.trim() !== '') {
          try {
            payload = JSON.parse(raw)
          } catch {
            respond(res, 200, { ok: false, error: { code: 'E_VALIDATION', message: '请求体不是合法 JSON' } })
            return
          }
        }
        const result = await service.handleRpc(payload)
        respond(res, 200, result)
      } catch (error) {
        respond(res, 200, { ok: false, error: toRpcError(error) })
      }
    })()
  }
}
