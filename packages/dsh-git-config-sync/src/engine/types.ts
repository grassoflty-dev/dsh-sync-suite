/**
 * host 半侧公共类型。
 *
 * 与 docs/CONTRACT.md §2.2、docs/DATA-CONTRACT.md §2/§4 严格一致：
 * 这些形状同时被 RPC 响应、同步载荷和持久化状态复用。
 */

/** 会写入远端 Git 快照的四个数据文件。 */
export type SyncFileName = 'cordis.patch.yml' | 'providers.json' | 'plugins.json' | 'mcp.json'

/** 仓库平台只影响 UI 的 URL 提示，不改变校验规则。 */
export type Platform = 'github' | 'gitee' | 'custom'

/** HTTPS 走临时 GIT_ASKPASS；SSH 走系统 ssh-agent。 */
export type AuthMode = 'https' | 'ssh'

export interface SyncScope {
  config: boolean
  providers: boolean
  plugins: boolean
  mcp: boolean
}

export interface SyncSettings {
  repoUrl: string
  platform: Platform
  authMode: AuthMode
  deviceId: string
  branch: string
  scope: SyncScope
}

export interface HeadInfo {
  sha: string
  message: string
  time: string
}

export interface SnapshotMeta {
  id: string
  time: string
  reason: string
  bytes: number
}

export interface ManifestFile {
  name: SyncFileName
  sha256: string
  bytes: number
}

export interface DeviceManifest {
  deviceId: string
  time: string
  scopes: SyncScope
  dshVersion: string
  files: ManifestFile[]
}

export interface PluginEntry {
  name: string
  version: string
  source: string
  enabled: boolean
}

export interface RpcErrorBody {
  code: string
  message: string
  details?: unknown
}

export type RpcResponse<T = unknown> = { ok: true; data: T } | { ok: false; error: RpcErrorBody }

/** getState.status（CONTRACT §2.3）。 */
export interface SyncStatus {
  reachable: boolean
  branch: string
  headSha: string
  headMessage: string
  headTime: string
  localPending: number
  remotePending: number
  conflict: boolean
  lastSyncAt: string | null
  error?: string
}

/** getState 的 settings 额外带 hasToken（BRIEF §2.4）。 */
export interface GetStateSettings extends SyncSettings {
  hasToken: boolean
}

export interface GetStateData {
  settings: GetStateSettings
  status: SyncStatus
  snapshots: SnapshotMeta[]
}
