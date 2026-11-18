/**
 * 写前恢复快照（fail-closed 第三层）。
 *
 * 目录：`<root>/<YYYYMMDD-HHmmss>[-n]/`
 *   files/<name>      被覆盖前的文件原文
 *   manifest.json     { id, time, reason, files:[{name,sha256,bytes}], ...meta }
 * 只保留最近 10 份（prune）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { SyncError } from './errors.js'
import { byteLength, sha256Hex, timestampId } from './paths.js'
import type { SnapshotMeta } from './types.js'

export interface RestoreSnapshot {
  id: string
  time: string
  reason: string
  files: Record<string, string>
  meta: Record<string, unknown>
}

interface SnapshotManifestFile {
  name: string
  sha256: string
  bytes: number
}

interface SnapshotManifest {
  id: string
  time: string
  reason: string
  files: SnapshotManifestFile[]
  meta?: Record<string, unknown>
}

const SAFE_NAME_RE = /^[A-Za-z0-9._-]+$/
const ID_RE = /^\d{8}-\d{6}(?:-\d+)?$/

export class SnapshotStore {
  readonly root: string

  constructor(root: string) {
    this.root = path.resolve(root)
  }

  private ensureRoot(): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
  }

  private allocateId(now: Date): string {
    const base = timestampId(now)
    let candidate = base
    let suffix = 1
    while (existsSync(path.join(this.root, candidate))) {
      candidate = `${base}-${suffix}`
      suffix += 1
    }
    return candidate
  }

  create(reason: string, files: Record<string, string>, meta: Record<string, unknown> = {}): SnapshotMeta {
    this.ensureRoot()
    const now = new Date()
    const id = this.allocateId(now)
    const dir = path.join(this.root, id)
    const filesDir = path.join(dir, 'files')
    mkdirSync(filesDir, { recursive: true, mode: 0o700 })

    const manifestFiles: SnapshotManifestFile[] = []
    for (const [name, content] of Object.entries(files)) {
      if (!SAFE_NAME_RE.test(name)) throw new SyncError('E_VALIDATION', `快照文件名非法：${name}`)
      const text = typeof content === 'string' ? content : String(content)
      writeFileSync(path.join(filesDir, name), text, { encoding: 'utf8', mode: 0o600 })
      manifestFiles.push({ name, sha256: sha256Hex(text), bytes: byteLength(text) })
    }

    const manifest: SnapshotManifest = {
      id,
      time: now.toISOString(),
      reason: typeof reason === 'string' ? reason : '',
      files: manifestFiles,
      meta,
    }
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {
      encoding: 'utf8',
      mode: 0o600,
    })

    const bytes = manifestFiles.reduce((sum, file) => sum + file.bytes, 0)
    return { id, time: manifest.time, reason: manifest.reason, bytes }
  }

  private readManifest(id: string): SnapshotManifest | null {
    const file = path.join(this.root, id, 'manifest.json')
    if (!existsSync(file)) return null
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
      if (parsed === null || typeof parsed !== 'object') return null
      const candidate = parsed as Partial<SnapshotManifest>
      if (typeof candidate.id !== 'string' || !Array.isArray(candidate.files)) return null
      return {
        id: candidate.id,
        time: typeof candidate.time === 'string' ? candidate.time : '',
        reason: typeof candidate.reason === 'string' ? candidate.reason : '',
        files: candidate.files.filter(
          (item): item is SnapshotManifestFile =>
            item !== null &&
            typeof item === 'object' &&
            typeof (item as SnapshotManifestFile).name === 'string' &&
            typeof (item as SnapshotManifestFile).sha256 === 'string',
        ),
        meta: candidate.meta !== null && typeof candidate.meta === 'object' ? candidate.meta : {},
      }
    } catch {
      return null
    }
  }

  /** 按 id 倒序（同一秒内的 `-n` 后缀按数字比较）。 */
  list(): SnapshotMeta[] {
    if (!existsSync(this.root)) return []
    const entries = readdirSync(this.root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && ID_RE.test(entry.name))
      .map((entry) => entry.name)
    entries.sort((a, b) => compareIds(b, a))
    const metas: SnapshotMeta[] = []
    for (const id of entries) {
      const manifest = this.readManifest(id)
      if (manifest === null) continue
      const bytes = manifest.files.reduce((sum, file) => sum + (Number.isFinite(file.bytes) ? file.bytes : 0), 0)
      metas.push({ id: manifest.id, time: manifest.time, reason: manifest.reason, bytes })
    }
    return metas
  }

  get(id: string): RestoreSnapshot {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new SyncError('E_VALIDATION', `快照 id 非法：${String(id)}`)
    const manifest = this.readManifest(id)
    if (manifest === null) throw new SyncError('E_NOT_FOUND', `快照不存在：${id}`, { snapshotId: id })
    const files: Record<string, string> = {}
    for (const file of manifest.files) {
      if (!SAFE_NAME_RE.test(file.name)) throw new SyncError('E_NOT_FOUND', `快照 ${id} 的文件名非法：${file.name}`)
      const filePath = path.join(this.root, id, 'files', file.name)
      if (!existsSync(filePath)) throw new SyncError('E_NOT_FOUND', `快照 ${id} 缺少文件：${file.name}`)
      const text = readFileSync(filePath, 'utf8')
      if (file.sha256 !== '' && sha256Hex(text) !== file.sha256) {
        throw new SyncError('E_SHA_MISMATCH', `快照 ${id} 的文件 ${file.name} 校验失败`, {
          snapshotId: id,
          file: file.name,
        })
      }
      files[file.name] = text
    }
    return {
      id: manifest.id,
      time: manifest.time,
      reason: manifest.reason,
      files,
      meta: manifest.meta ?? {},
    }
  }

  /** 只保留最近 keep 份，返回被删除的元数据。 */
  prune(keep = 10): SnapshotMeta[] {
    const limit = Number.isFinite(keep) && keep > 0 ? Math.floor(keep) : 10
    const all = this.list()
    const removed = all.slice(limit)
    for (const meta of removed) {
      const dir = path.join(this.root, meta.id)
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* 删除失败不影响主流程；下次 prune 再试 */
      }
    }
    return removed
  }
}

function compareIds(a: string, b: string): number {
  if (a === b) return 0
  const [aBase, aSuffix] = splitId(a)
  const [bBase, bSuffix] = splitId(b)
  if (aBase !== bBase) return aBase < bBase ? -1 : 1
  return aSuffix - bSuffix
}

function splitId(id: string): [string, number] {
  const match = /^(\d{8}-\d{6})(?:-(\d+))?$/.exec(id)
  if (match === null) return [id, 0]
  return [match[1]!, match[2] === undefined ? 0 : Number.parseInt(match[2], 10)]
}
