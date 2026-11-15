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
  /**
   * HTTPS 认证用户名（Gitee 必填：登录名 + 私人令牌作密码；GitHub 可留空，
   * 默认 `x-access-token`）。只存 settings.json，**不进** credentials.json。
   */
  username?: string
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

/**
 * getState.status（CONTRACT §2.3）。
 *
 * `reachable` 是三态：true = 最近一次探测（testConnection/push/preview）成功，
 * false = 最近一次探测是网络错误，null = 从未探测（或换了仓库地址，旧结果作废）。
 * `getState` 本身**绝不联网**，所以不会把"没探测"当成错误。
 */
export interface SyncStatus {
  reachable: boolean | null
  branch: string
  headSha: string
  headMessage: string
  headTime: string
  /** 本地相对 origin/<branch> 领先的提交数；没有 upstream 引用时为 null（不 fetch）。 */
  localPending: number | null
  /** 本地相对 origin/<branch> 落后的提交数；没有 upstream 引用时为 null（不 fetch）。 */
  remotePending: number | null
  conflict: boolean
  lastSyncAt: string | null
  /** 只填本地读取错误（工作副本损坏等）；网络不可达不算错误。 */
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
