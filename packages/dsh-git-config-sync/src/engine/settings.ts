/**
 * settings.json / credentials.json / state.json 的读写与校验。
 *
 * 纪律：
 *   - token 只写 credentials.json（0600），绝不写 settings.json，绝不进日志/响应体；
 *   - saveSettings 的 token 语义：undefined/'' 保留旧值，null 清除，字符串覆盖；
 *   - repoUrl 仅 https/ssh/git@，且不得内嵌凭据（`allowLocalRepo` 仅供集成测试放行本地路径）；
 *   - repoUrl 允许保存为空串（初始态/清空仓库地址），由调用方在真正联网前要求非空。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SyncError } from './errors.js'
import { hasEmbeddedCredentials, isSupportedRepoUrl } from './git.js'
import type { StatePaths } from './paths.js'
import type { AuthMode, Platform, SyncScope, SyncSettings } from './types.js'

export const DEVICE_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/

const PLATFORMS: readonly Platform[] = ['github', 'gitee', 'custom']
const AUTH_MODES: readonly AuthMode[] = ['https', 'ssh']
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,128}$/

export const DEFAULT_SCOPE: SyncScope = { config: true, providers: true, plugins: true, mcp: true }

/** 默认 deviceId：主机名小写化并清洗到 DEVICE_ID_RE 允许的字符。 */
export function defaultDeviceId(): string {
  const envHost = process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? ''
  const raw = envHost.trim() === '' ? safeHostname() : envHost.trim()
  let id = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  if (id === '' || !/^[a-z0-9]/.test(id)) id = `device-${id}`.slice(0, 32).replace(/-+$/, '')
  return DEVICE_ID_RE.test(id) ? id : 'device-1'
}

function safeHostname(): string {
  try {
    return os.hostname()
  } catch {
    return 'device'
  }
}

export function defaultSettings(): SyncSettings {
  return {
    repoUrl: '',
    platform: 'github',
    authMode: 'https',
    deviceId: defaultDeviceId(),
    branch: 'main',
    scope: { ...DEFAULT_SCOPE },
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], field: string, fallback: T): T {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new SyncError('E_VALIDATION', `${field} 取值非法：${String(value)}`, { allowed })
  }
  return value as T
}

function pickBoolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new SyncError('E_VALIDATION', `${field} 必须是布尔值`)
  return value
}

function normalizeScope(value: unknown, fallback: SyncScope): SyncScope {
  const record = asRecord(value)
  if (record === null) return { ...fallback }
  return {
    config: pickBoolean(record.config, 'scope.config', fallback.config),
    providers: pickBoolean(record.providers, 'scope.providers', fallback.providers),
    plugins: pickBoolean(record.plugins, 'scope.plugins', fallback.plugins),
    mcp: pickBoolean(record.mcp, 'scope.mcp', fallback.mcp),
  }
}

export interface NormalizeOptions {
  allowLocalRepo?: boolean
}

/** 错误/日志里展示 URL 前先抹掉 userinfo，避免把凭据带进响应体。 */
function scrubRepoUrl(repoUrl: string): string {
  return repoUrl.replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/?#]*@/, '$1***@')
}

/**
 * 把外部输入（UI/RPC）合并到既有设置并校验。
 *
 * - 字段缺省（undefined）→ 沿用 previous；
 * - `repoUrl: ''` → 显式清空（初始态/换仓库），落盘为空串，不是"未提供"。
 *   真正需要仓库地址的动作（push/testConnection/preview/apply）由调用方再校验。
 */
export function normalizeSettings(input: unknown, previous: SyncSettings, options: NormalizeOptions = {}): SyncSettings {
  const record = asRecord(input)
  if (record === null) throw new SyncError('E_VALIDATION', 'settings 必须是对象')
  const next: SyncSettings = {
    repoUrl: previous.repoUrl,
    platform: previous.platform,
    authMode: previous.authMode,
    deviceId: previous.deviceId,
    branch: previous.branch,
    scope: { ...previous.scope },
  }

  if (record.repoUrl !== undefined) {
    if (typeof record.repoUrl !== 'string') throw new SyncError('E_VALIDATION', 'repoUrl 必须是字符串')
    const repoUrl = record.repoUrl.trim()
    if (repoUrl !== '') {
      if (hasEmbeddedCredentials(repoUrl)) {
        throw new SyncError(
          'E_VALIDATION',
          'repoUrl 不能内嵌凭据：请把 Token 填到「访问令牌」字段，SSH 用 git@host:path',
          { repoUrl: scrubRepoUrl(repoUrl) },
        )
      }
      if (!isSupportedRepoUrl(repoUrl, options.allowLocalRepo === true)) {
        throw new SyncError('E_VALIDATION', 'repoUrl 仅支持 https://、ssh://、git@host:path', {
          repoUrl: scrubRepoUrl(repoUrl),
        })
      }
    }
    next.repoUrl = repoUrl
  }

  next.platform = pickEnum(record.platform, PLATFORMS, 'platform', previous.platform)
  next.authMode = pickEnum(record.authMode, AUTH_MODES, 'authMode', previous.authMode)

  if (record.deviceId !== undefined) {
    if (typeof record.deviceId !== 'string') throw new SyncError('E_VALIDATION', 'deviceId 必须是字符串')
    const deviceId = record.deviceId.trim()
    if (!DEVICE_ID_RE.test(deviceId)) {
      throw new SyncError('E_VALIDATION', 'deviceId 必须匹配 ^[a-z0-9][a-z0-9-]{0,31}$', { deviceId })
    }
    next.deviceId = deviceId
  }

  if (record.branch !== undefined) {
    if (typeof record.branch !== 'string') throw new SyncError('E_VALIDATION', 'branch 必须是字符串')
    const branch = record.branch.trim()
    if (!BRANCH_RE.test(branch) || branch.startsWith('-') || branch.endsWith('/') || branch.includes('..')) {
      throw new SyncError('E_VALIDATION', 'branch 名称非法', { branch })
    }
    next.branch = branch
  }

  if (record.scope !== undefined) next.scope = normalizeScope(record.scope, previous.scope)
  return next
}

export type TokenInput = string | null | undefined

/** saveSettings 的 token 语义：undefined/'' 保留，null 清除，字符串覆盖。 */
export function resolveToken(input: TokenInput, existing: string | null): string | null {
  if (input === undefined) return existing
  if (input === null) return null
  if (typeof input !== 'string') throw new SyncError('E_VALIDATION', 'token 必须是字符串或 null')
  const trimmed = input.trim()
  if (trimmed === '') return existing
  return trimmed
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
}

function writeFilePrivate(file: string, content: string): void {
  ensureDir(path.dirname(file))
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 })
  try {
    renameSync(tmp, file)
  } catch {
    writeFileSync(file, content, { encoding: 'utf8', mode: 0o600 })
    try {
      unlinkSync(tmp)
    } catch {
      /* 临时文件清理失败不影响结果 */
    }
  }
}

function readJsonFile(file: string): unknown {
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

export class SettingsStore {
  private readonly paths: StatePaths
  private readonly allowLocalRepo: boolean

  constructor(paths: StatePaths, options: { allowLocalRepo?: boolean } = {}) {
    this.paths = paths
    this.allowLocalRepo = options.allowLocalRepo === true
  }

  readSettings(): SyncSettings {
    const stored = readJsonFile(this.paths.settingsFile)
    const base = defaultSettings()
    if (stored === null) return base
    const record = asRecord(stored)
    if (record === null) return base
    // 存储层已校验过；读取时容错，避免手工改坏文件导致插件整体不可用。
    try {
      const merged = normalizeSettings(record, base, { allowLocalRepo: this.allowLocalRepo })
      // deviceId 若是历史脏数据，退回默认值。
      if (!DEVICE_ID_RE.test(merged.deviceId)) merged.deviceId = base.deviceId
      return merged
    } catch {
      return base
    }
  }

  writeSettings(settings: SyncSettings): void {
    const body = JSON.stringify(settings, null, 2) + '\n'
    writeFilePrivate(this.paths.settingsFile, body)
  }

  /** 只读 token 是否存在，不返回 token 本身给上层 UI。 */
  hasToken(): boolean {
    return this.readToken() !== null
  }

  readToken(): string | null {
    const stored = readJsonFile(this.paths.credentialsFile)
    const record = asRecord(stored)
    if (record === null) return null
    const token = record.token
    if (typeof token !== 'string') return null
    const trimmed = token.trim()
    return trimmed === '' ? null : trimmed
  }

  writeToken(token: string | null): void {
    if (token === null) {
      writeFilePrivate(this.paths.credentialsFile, JSON.stringify({}, null, 2) + '\n')
      return
    }
    writeFilePrivate(this.paths.credentialsFile, JSON.stringify({ token }, null, 2) + '\n')
  }
}

/** 本地运行状态（state.json）：不含任何 secret，仅记录同步时间等运行事实。 */
export interface LocalState {
  /** 最近一次成功 push / pull / apply 的 ISO 时间；从未同步为 null。 */
  lastSyncAt?: string | null
}

function normalizeIsoTime(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return null
  return new Date(parsed).toISOString()
}

/**
 * state.json 的读写。独立于 settings.json：settings 是用户配置，state 是运行事实，
 * 清空/迁移配置不应抹掉"最近同步时间"，新进程/新 RPC 实例也能读到。
 */
export class LocalStateStore {
  private readonly paths: StatePaths

  constructor(paths: StatePaths) {
    this.paths = paths
  }

  read(): LocalState {
    const stored = asRecord(readJsonFile(this.paths.stateFile))
    if (stored === null) return {}
    return { lastSyncAt: normalizeIsoTime(stored.lastSyncAt) }
  }

  readLastSyncAt(): string | null {
    return this.read().lastSyncAt ?? null
  }

  writeLastSyncAt(iso: string): void {
    const normalized = normalizeIsoTime(iso)
    if (normalized === null) return
    const state: LocalState = { ...this.read(), lastSyncAt: normalized }
    writeFilePrivate(this.paths.stateFile, JSON.stringify(state, null, 2) + '\n')
  }
}
