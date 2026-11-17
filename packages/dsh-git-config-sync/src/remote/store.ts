/**
 * 远程访问域的**持久化层**：`remote.json`（用户配置）与 `remote-token.json`（令牌）。
 *
 * 为什么单独两个文件、而不是复用 `engine` 的 `settings.json`：
 *   1. **失败隔离**——远程访问配置写坏/写失败，不许影响配置同步（反之亦然）；
 *   2. 令牌与 Git Token 是两套凭据、两条生命周期，混在一个文件里迟早会互相覆盖；
 *   3. 同步载荷（`devices/<id>/**`）与这两个文件**零交集**，令牌永不进仓库。
 *
 * 只做 I/O，不做语义校验：归一化归 `accessMode.normalizeRemoteSettings`，
 * 这样单测可以分别钉住"落盘原子性"与"字段规则"。
 *
 * 路径解析用 `engine/paths.ts`（纯路径计算，无副作用）——它是本域唯一允许共用的
 * engine 工具之一，规则见 `src/remote/types.ts` 文件头。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { statePaths } from '../engine/paths.js'
import type { RemoteSettings } from './types.js'

/** 令牌记录：明文只在这一层与 `auth` 内部流转，永不进 RPC 状态响应。 */
export interface StoredToken {
  token: string
  /** ISO 时间；用于设置页显示「令牌创建于」。 */
  createdAt: string
}

export interface RemoteStoreOptions {
  /** 覆盖 `~`（测试用）；语义同 `engine/paths.ts` 的 `homeDir`。 */
  homeDir?: string
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
}

/**
 * 原子写 + 0600。
 *
 * 与 `engine/settings.ts` 的 `writeFilePrivate` 同款：先写 tmp 再 rename，rename 失败退回直写。
 * Windows 上 POSIX mode 不生效，但同一份代码在 Linux/macOS 上是真正收紧的。
 */
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

function readJson(file: string): unknown {
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    // 手工改坏 / 半截文件：当作"没配置"，由上层回落默认值（不能让插件起不来）。
    return null
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

export class RemoteStore {
  /** `~/.dsh/git-config-sync/remote.json` */
  readonly configFile: string
  /** `~/.dsh/git-config-sync/remote-token.json` */
  readonly tokenFile: string

  constructor(options: RemoteStoreOptions = {}) {
    const root = statePaths(options.homeDir).root
    this.configFile = path.join(root, 'remote.json')
    this.tokenFile = path.join(root, 'remote-token.json')
  }

  /** 原始配置（未归一）；文件缺失或损坏 → null（调用方回落默认值）。 */
  readRawSettings(): unknown {
    return readJson(this.configFile)
  }

  writeSettings(settings: RemoteSettings): void {
    writeFilePrivate(this.configFile, JSON.stringify(settings, null, 2) + '\n')
  }

  /** 读令牌；文件缺失/损坏/字段非法 → null（fail-closed：没有令牌就没人能通过令牌门）。 */
  readToken(): StoredToken | null {
    const record = asRecord(readJson(this.tokenFile))
    if (record === null) return null
    const token = record.token
    if (typeof token !== 'string') return null
    const trimmed = token.trim()
    // 长度下限与 `crypto.randomBytes(32)` 的 base64url 形态对得上；更短的视为损坏数据。
    if (trimmed.length < 32) return null
    const createdAt = typeof record.createdAt === 'string' ? record.createdAt : ''
    return { token: trimmed, createdAt }
  }

  writeToken(record: StoredToken): void {
    writeFilePrivate(this.tokenFile, JSON.stringify({ token: record.token, createdAt: record.createdAt }, null, 2) + '\n')
  }

  /** 删除令牌文件（轮换时先写新值，不调用本方法；本方法只给"清空令牌"用）。 */
  clearToken(): void {
    try {
      if (existsSync(this.tokenFile)) unlinkSync(this.tokenFile)
    } catch {
      /* 删除失败不应抛给调用方；下次读取会因为字段缺失返回 null */
    }
  }
}
