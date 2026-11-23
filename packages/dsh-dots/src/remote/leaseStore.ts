/**
 * mod-chat-lease：租约表的持久化适配器（插件侧；纯 store，零 RPC / 零定时器 / 零后台心跳）。
 *
 * 路径由调用方注入（测试只写包内 `.tmp/`，**绝不**碰插件 live 状态目录），时钟也由调用方注入；
 * 单键 `{v:1,items}` JSON 表，写盘 = 写临时文件 + rename 的原子替换，POSIX 上 0600。
 *
 * 失败纪律：坏 JSON / 错版本 / 未知字段 / 任一坏记录 ⇒ 空表 + typed LeaseProblem，
 * 不抛给 load/upsert/remove 的调用方，也绝不返回半张表；只有显式 save 的 IO 失败才抛 typed
 * SyncError（不静默吞掉写失败）。零 console 调用。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { SyncError } from '../engine/errors.js'
import {
  decodeLeases,
  encodeLeases,
  normalizeLease,
  problemText,
  sortLeases,
} from './lease.js'
import type { LeaseProblem, SessionLease } from './lease.js'

export interface LeaseStoreOptions {
  /** 租约表文件绝对路径（调用方注入；测试指向临时目录）。 */
  filePath: string
  /** 注入时钟（毫秒）；用于临时文件名与可审计时间戳，不用于租约决策。 */
  now?: () => number
}

export interface LeaseStoreResult {
  ok: boolean
  leases: SessionLease[]
  problem: LeaseProblem | null
}

export interface LeaseStore {
  readonly file: string
  load(): Promise<LeaseStoreResult>
  save(leases: SessionLease[]): Promise<void>
  upsert(lease: SessionLease): Promise<LeaseStoreResult>
  remove(sessionId: string): Promise<LeaseStoreResult>
  /** 最近一次操作的 typed 问题码；null = 无问题。 */
  lastProblem(): LeaseProblem | null
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
}

export function createLeaseStore(options: LeaseStoreOptions): LeaseStore {
  const file = options.filePath
  const now = options.now ?? ((): number => Date.now())
  let problem: LeaseProblem | null = null
  let tempSeq = 0

  /** 原子写：临时文件 → rename；失败清走临时文件，绝不留下半张表。 */
  function writeFilePrivate(target: string, content: string): void {
    ensureDir(path.dirname(target))
    tempSeq += 1
    const stamp = Number.isFinite(now()) ? Math.trunc(now()) : 0
    const tmp = `${target}.${process.pid}.${stamp}.${tempSeq}.tmp`
    writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 })
    try {
      renameSync(tmp, target)
    } catch (error) {
      try {
        unlinkSync(tmp)
      } catch {
        /* 临时文件清理失败不改变「本次写入失败」的事实 */
      }
      throw error
    }
    if (process.platform !== 'win32') {
      try {
        chmodSync(target, 0o600)
      } catch {
        /* POSIX 上 chmod 失败不改变已原子落盘的内容 */
      }
    }
  }

  function okResult(leases: SessionLease[]): LeaseStoreResult {
    return { ok: true, leases: leases.map((lease) => ({ ...lease })), problem: null }
  }

  function badResult(code: LeaseProblem): LeaseStoreResult {
    return { ok: false, leases: [], problem: code }
  }

  /** 内部整表提交：先逐条归一，任一条坏就整表拒绝，绝不写部分内容。 */
  function commit(list: SessionLease[]): LeaseStoreResult {
    if (!Array.isArray(list)) {
      problem = 'E_LEASE_ENVELOPE_SHAPE'
      return badResult(problem)
    }
    const items: SessionLease[] = []
    for (const item of list) {
      const normalized = normalizeLease(item)
      if (!normalized.ok || normalized.lease === null) {
        problem = normalized.problem ?? 'E_LEASE_ENVELOPE_ITEM'
        return badResult(problem)
      }
      items.push(normalized.lease)
    }
    const sorted = sortLeases(items)
    try {
      writeFilePrivate(file, encodeLeases(sorted))
      problem = null
      return okResult(sorted)
    } catch {
      problem = 'E_LEASE_STORAGE_UNAVAILABLE'
      return badResult(problem)
    }
  }

  async function load(): Promise<LeaseStoreResult> {
    let raw = ''
    try {
      if (!existsSync(file)) {
        problem = null
        return okResult([])
      }
      raw = readFileSync(file, 'utf8')
    } catch {
      problem = 'E_LEASE_STORAGE_UNAVAILABLE'
      return badResult(problem)
    }
    const decoded = decodeLeases(raw)
    problem = decoded.problem
    return { ok: decoded.ok, leases: decoded.leases, problem: decoded.problem }
  }

  async function save(leases: SessionLease[]): Promise<void> {
    const result = commit(leases)
    if (!result.ok) {
      const code = result.problem ?? 'E_LEASE_STORAGE_UNAVAILABLE'
      throw new SyncError(code, problemText(code))
    }
  }

  async function upsert(lease: SessionLease): Promise<LeaseStoreResult> {
    const current = await load()
    // 坏信封不覆写（否则会把损坏证据换成一张只有一条的表）；显式 save 才允许重建。
    if (!current.ok) return badResult(current.problem ?? 'E_LEASE_STORAGE_UNAVAILABLE')
    const next: SessionLease[] = []
    let replaced = false
    for (const item of current.leases) {
      if (item.sessionId === lease.sessionId) {
        next.push({ ...lease })
        replaced = true
      } else {
        next.push({ ...item })
      }
    }
    if (!replaced) next.push({ ...lease })
    return commit(next)
  }

  async function remove(sessionId: string): Promise<LeaseStoreResult> {
    const current = await load()
    if (!current.ok) return badResult(current.problem ?? 'E_LEASE_STORAGE_UNAVAILABLE')
    return commit(current.leases.filter((item) => item.sessionId !== sessionId))
  }

  return {
    file,
    load,
    save,
    upsert,
    remove,
    lastProblem: (): LeaseProblem | null => problem,
  }
}
