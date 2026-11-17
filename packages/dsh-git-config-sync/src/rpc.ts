/**
 * RPC 服务：`POST /dsh-git-config-sync/rpc`，body `{action, ...}`。
 *
 * 响应恒 HTTP 200 + `{ok:true,data}` / `{ok:false,error:{code,message,details?}}`
 * （只有鉴权失败由 connection 返回 401/403）。所有写操作串行队列；
 * 未知 action → E_UNKNOWN_ACTION；参数非法 → E_VALIDATION。
 */
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { collectLocal, isFileInScope, pluginsOf, serializeManifest, SYNC_FILE_NAMES } from './engine/collect.js'
import type { CollectResult } from './engine/collect.js'
import { SyncError, errorMessage, isSyncError, toRpcError } from './engine/errors.js'
import { GitRepo } from './engine/git.js'
import type { StatePaths } from './engine/paths.js'
import { detectDshVersion, repoHash, resolveProfileDir, statePaths } from './engine/paths.js'
import type { InternalPreview, PreviewResult } from './engine/preview.js'
import { PreviewCache, buildPreview, settingsFingerprint } from './engine/preview.js'
import { applySelected, rollbackSnapshot } from './engine/restore.js'
import type { ApplyResult, RpcHooks } from './engine/restore.js'
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
}

export interface RpcService {
  paths: StatePaths
  handleRpc(body: unknown): Promise<RpcResponse>
  dispose(): Promise<void>
}

export interface ConnectionLike {
  requestRejection(req: unknown): number | null | undefined
}

const MAX_BODY_BYTES = 10 * 1024 * 1024

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

        const message = `dsh-git-config-sync: snapshot ${settings.deviceId} ${now().toISOString()}`
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
