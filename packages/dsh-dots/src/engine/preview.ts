/**
 * 拉取预览（只读，不写任何文件）。
 *
 * 从已 fetch 的远端 ref 读 `devices/<deviceId>/` 快照，与本地采集结果逐条比对：
 *   - 用 manifest.json 的 sha256 校验远端文件（传输校验，fail-closed）；
 *   - patch 条目走 mergePatch（含 manual 判定），本地独有单独列出（永不删）；
 *   - 插件清单走 MERGE-only；provider / MCP 只做 id 级差异展示。
 * 预览结果缓存在内存（TTL 10 分钟，单实例只保留一个 previewId）。
 */
import { randomBytes } from 'node:crypto'
import { readProfilePatch, pluginsOf } from './collect.js'
import { diffText, summarizeFiles } from './diff.js'
import type { DiffSummary, FileDiffStat, UnifiedHunk } from './diff.js'
import { SyncError } from './errors.js'
import type { GitRepo } from './git.js'
import { localOnlyKeys, mergePatch } from './patch.js'
import { mergePluginManifests } from './pluginMerge.js'
import type { PluginMergeResult } from './pluginMerge.js'
import { byteLength, sha256Hex } from './paths.js'
import type { DeviceManifest, PluginEntry, SyncFileName, SyncScope } from './types.js'

export interface PreviewEntry {
  id: string
  name: string
  status: 'added' | 'changed' | 'same' | 'manual'
  localText: string
  remoteText: string
  secretStripped: boolean
}

export interface PreviewFileName {
  name: SyncFileName
  sha256: string
  bytes: number
}

export interface PreviewDiffIds {
  added: string[]
  changed: string[]
  same: string[]
}

export interface PreviewSource {
  deviceId: string
  headSha: string
  files: PreviewFileName[]
  entries: PreviewEntry[]
  plugins: PluginMergeResult
  providers: PreviewDiffIds
  mcp: PreviewDiffIds
  /** 本地独有（远端没有）的 patch 条目 —— 合并时永不删，UI 只做只读展示。 */
  localOnly?: string[]
}

export interface PreviewResult {
  previewId: string
  sources: PreviewSource[]
}

export interface InternalPreviewSource {
  deviceId: string
  headSha: string
  /** 远端该设备快照里的 cordis.patch.yml 原文（已脱敏，含 `__SECRET__`）。 */
  patchRemote: string
  entries: PreviewEntry[]
  files: PreviewFileName[]
  manifest: DeviceManifest | null
  plugins: PluginMergeResult
}

export interface InternalPreview {
  previewId: string
  createdAt: number
  fingerprint: string
  localPatch: string
  sources: InternalPreviewSource[]
}

export interface PreviewDeps {
  git: GitRepo
  profileDir: string
  deviceId: string
  scopes: SyncScope
  fingerprint: string
  now: Date
  /** 本地采集合成结果：用于 provider / 插件差异展示。 */
  localFiles: Record<SyncFileName, string>
  localPlugins: PluginEntry[]
}

const DEFAULT_TTL_MS = 10 * 60 * 1000

export function settingsFingerprint(settings: {
  repoUrl: string
  branch: string
  deviceId: string
  authMode: string
  scope: SyncScope
}): string {
  return sha256Hex(
    JSON.stringify([settings.repoUrl, settings.branch, settings.deviceId, settings.authMode, settings.scope]),
  ).slice(0, 16)
}

function readJsonObject(text: string): Record<string, unknown> | null {
  if (typeof text !== 'string' || text.trim() === '') return null
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
  return `{${entries.join(',')}}`
}

function diffProviders(localText: string, remoteText: string): PreviewDiffIds {
  const local = readJsonObject(localText)?.providers
  const remote = readJsonObject(remoteText)?.providers
  const localMap = local !== null && typeof local === 'object' ? (local as Record<string, unknown>) : {}
  const remoteMap = remote !== null && typeof remote === 'object' ? (remote as Record<string, unknown>) : {}
  const diff: PreviewDiffIds = { added: [], changed: [], same: [] }
  for (const id of Object.keys(remoteMap).sort()) {
    if (!(id in localMap)) diff.added.push(id)
    else if (stableJson(localMap[id]) === stableJson(remoteMap[id])) diff.same.push(id)
    else diff.changed.push(id)
  }
  return diff
}

function diffMcp(localText: string, remoteText: string): PreviewDiffIds {
  const local = readJsonObject(localText)?.entries
  const remote = readJsonObject(remoteText)?.entries
  const index = (value: unknown): Map<string, string> => {
    const map = new Map<string, string>()
    if (!Array.isArray(value)) return map
    for (const item of value) {
      if (item === null || typeof item !== 'object') continue
      const record = item as Record<string, unknown>
      const id = typeof record.id === 'string' ? record.id : ''
      if (id === '' || map.has(id)) continue
      map.set(id, stableJson(record))
    }
    return map
  }
  const localMap = index(local)
  const remoteMap = index(remote)
  const diff: PreviewDiffIds = { added: [], changed: [], same: [] }
  for (const id of Array.from(remoteMap.keys()).sort()) {
    if (!localMap.has(id)) diff.added.push(id)
    else if (localMap.get(id) === remoteMap.get(id)) diff.same.push(id)
    else diff.changed.push(id)
  }
  return diff
}

function devicesInTree(paths: string[]): string[] {
  const devices = new Set<string>()
  for (const item of paths) {
    const match = /^devices\/([^/]+)\//.exec(item)
    if (match !== null) devices.add(match[1]!)
  }
  return Array.from(devices).sort()
}

function normalizeManifest(text: string | null): DeviceManifest | null {
  if (text === null) return null
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object') return null
    const record = parsed as Record<string, unknown>
    if (!Array.isArray(record.files)) return null
    const files = record.files
      .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
      .map((item) => {
        const name = typeof item.name === 'string' ? item.name : ''
        return {
          name: name as SyncFileName,
          sha256: typeof item.sha256 === 'string' ? item.sha256 : '',
          bytes: typeof item.bytes === 'number' ? item.bytes : 0,
        }
      })
      .filter((item) => (item.name as string) !== '')
    return {
      deviceId: typeof record.deviceId === 'string' ? record.deviceId : '',
      time: typeof record.time === 'string' ? record.time : '',
      scopes: typeof record.scopes === 'object' && record.scopes !== null ? (record.scopes as SyncScope) : {
        config: true,
        providers: true,
        plugins: true,
        mcp: true,
      },
      dshVersion: typeof record.dshVersion === 'string' ? record.dshVersion : '',
      files,
    }
  } catch {
    return null
  }
}

/** 校验远端快照并读出四个文件；manifest 与内容不一致立即失败（fail-closed）。 */
async function readRemoteSnapshot(
  git: GitRepo,
  headSha: string,
  deviceId: string,
): Promise<{ manifest: DeviceManifest | null; files: Record<SyncFileName, string>; sizes: PreviewFileName[] }> {
  const prefix = `devices/${deviceId}/`
  const manifestText = await git.showFile(headSha, `${prefix}manifest.json`)
  const manifest = normalizeManifest(manifestText)
  const names: SyncFileName[] = ['cordis.patch.yml', 'providers.json', 'plugins.json', 'mcp.json']
  const files = {} as Record<SyncFileName, string>
  const sizes: PreviewFileName[] = []

  for (const name of names) {
    const text = await git.showFile(headSha, `${prefix}${name}`)
    const content = text ?? ''
    files[name] = content
    const sha256 = sha256Hex(content)
    const bytes = byteLength(content)
    const declared = manifest?.files.find((file) => file.name === name)
    if (declared !== undefined) {
      if (text === null) {
        throw new SyncError('E_SHA_MISMATCH', `远端快照 ${deviceId} 缺少 manifest 声明的文件 ${name}`, {
          deviceId,
          file: name,
        })
      }
      if (declared.sha256 !== '' && declared.sha256 !== sha256) {
        throw new SyncError('E_SHA_MISMATCH', `远端快照 ${deviceId} 的 ${name} 与 manifest 不一致`, {
          deviceId,
          file: name,
          declared: declared.sha256,
          actual: sha256,
        })
      }
    }
    sizes.push({ name, sha256, bytes })
  }

  if (manifest !== null && manifest.deviceId !== '' && manifest.deviceId !== deviceId) {
    throw new SyncError('E_SHA_MISMATCH', `远端快照目录 ${deviceId} 与 manifest 的 deviceId 不一致`, {
      dirDeviceId: deviceId,
      manifestDeviceId: manifest.deviceId,
    })
  }

  return { manifest, files, sizes }
}

export async function buildPreview(
  deps: PreviewDeps,
): Promise<{ result: PreviewResult; internal: InternalPreview; reachable: boolean }> {
  const { git } = deps
  await git.ensureWorkTree()
  const fetched = await git.fetch()
  const headSha = fetched.headSha
  const localPatch = readProfilePatch(deps.profileDir)

  const tree = headSha === '' ? [] : await git.listTree(headSha)
  const deviceIds = devicesInTree(tree).filter((deviceId) => deviceId !== deps.deviceId)

  const sources: PreviewSource[] = []
  const internalSources: InternalPreviewSource[] = []

  for (const deviceId of deviceIds) {
    const snapshot = await readRemoteSnapshot(git, headSha, deviceId)
    const remotePatch = snapshot.files['cordis.patch.yml']
    const merged = mergePatch(localPatch, remotePatch)
    const entries: PreviewEntry[] = merged.entries.map((entry) => ({
      id: entry.key,
      name: entry.name,
      status: entry.status,
      localText: entry.localText,
      remoteText: entry.remoteText,
      secretStripped: entry.secretStripped,
    }))
    const remotePlugins = pluginsOf(snapshot.files['plugins.json'])
    const plugins = mergePluginManifests(deps.localPlugins, remotePlugins)
    const source: PreviewSource = {
      deviceId,
      headSha,
      files: snapshot.sizes,
      entries,
      plugins,
      providers: diffProviders(deps.localFiles['providers.json'], snapshot.files['providers.json']),
      mcp: diffMcp(deps.localFiles['mcp.json'], snapshot.files['mcp.json']),
      localOnly: localOnlyKeys(localPatch, remotePatch),
    }
    sources.push(source)
    internalSources.push({
      deviceId,
      headSha,
      patchRemote: remotePatch,
      entries,
      files: snapshot.sizes,
      manifest: snapshot.manifest,
      plugins,
    })
  }

  const previewId = randomBytes(12).toString('hex')
  const internal: InternalPreview = {
    previewId,
    createdAt: deps.now.getTime(),
    fingerprint: deps.fingerprint,
    localPatch,
    sources: internalSources,
  }
  return { result: { previewId, sources }, internal, reachable: fetched.reachable }
}

/** 内存预览缓存：TTL 10 分钟，单实例只保留一个 previewId。 */
export class PreviewCache {
  private current: InternalPreview | null = null
  private readonly ttlMs: number

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs
  }

  set(preview: InternalPreview): void {
    this.current = preview
  }

  get(previewId: string, nowMs: number = Date.now()): InternalPreview | null {
    if (this.current === null) return null
    if (typeof previewId !== 'string' || previewId === '' || this.current.previewId !== previewId) return null
    if (nowMs - this.current.createdAt > this.ttlMs) {
      this.current = null
      return null
    }
    return this.current
  }

  peek(): InternalPreview | null {
    return this.current
  }

  clear(): void {
    this.current = null
  }
}

/* -------------------------------------------------------------------------- */
/* 文件级差异（previewDiff 用；纯展示，不改变 buildPreview 的任何行为）            */
/* -------------------------------------------------------------------------- */

export interface PreviewDiffBlock {
  deviceId: string
  files: FileDiffStat[]
  summary: DiffSummary
  hunks: UnifiedHunk[]
  /** 该设备下**还有 hunk 没展示**（预算用尽 / 单 hunk 被裁，见 diff.ts 的 M1）。 */
  truncated: boolean
}

export interface PreviewFileDiff {
  files: FileDiffStat[]
  summary: DiffSummary
  hunks: UnifiedHunk[]
  /** 所有设备聚合后的"还有差异没展示"标记（`previewDiff` 会原样透给 UI）。 */
  truncated: boolean
  sources: PreviewDiffBlock[]
}

export interface PreviewDiffOptions {
  contextLines?: number
  maxLines?: number
}

/**
 * 把 `buildPreview` 的 **entry 级**差异转成文件级 `DiffSummary`。
 *
 * 远端快照只有脱敏后的四个文件，apply 真正改写的是 patch 里的条目，所以路径用
 * `devices/<deviceId>/cordis.patch.yml#<entryId>` 这种伪文件形式：一行对应一个条目，
 * 用户仍然能按「新增 / 修改 / 删除」分组并把差异展开成 hunk 文本。
 * providers / plugins / mcp 的 id 级差异仍由既有 `preview` 的 DiffList 展示，不在这里重复。
 */
export function fileDiffOfPreview(internal: InternalPreview, options: PreviewDiffOptions = {}): PreviewFileDiff {
  const blocks: PreviewDiffBlock[] = []
  const allFiles: FileDiffStat[] = []
  const allHunks: UnifiedHunk[] = []
  let truncated = false

  for (const source of Array.isArray(internal?.sources) ? internal.sources : []) {
    const files: FileDiffStat[] = []
    const hunks: UnifiedHunk[] = []
    let blockTruncated = false
    for (const entry of Array.isArray(source.entries) ? source.entries : []) {
      const path = `devices/${source.deviceId}/cordis.patch.yml#${entry.id}`
      // added → 远端新增；same → 一致；changed / manual → 会被改写（manual 需本地补值）。
      const kind: FileDiffStat['kind'] =
        entry.status === 'added' ? 'added' : entry.status === 'same' ? 'same' : 'modified'
      const localText = typeof entry.localText === 'string' ? entry.localText : ''
      const remoteText = typeof entry.remoteText === 'string' ? entry.remoteText : ''
      const stat: FileDiffStat = {
        path,
        kind,
        addedLines: 0,
        removedLines: 0,
        beforeBytes: byteLength(localText),
        afterBytes: byteLength(remoteText),
      }
      if (kind !== 'same') {
        const result = diffText(localText, remoteText, { ...options, path })
        stat.addedLines = result.addedLines
        stat.removedLines = result.removedLines
        for (const hunk of result.hunks) hunks.push(hunk)
        // 单条 entry 的 hunk 被预算截断 / 整段被丢弃 → 这一块就算"还有差异没展示"。
        if (result.truncated) blockTruncated = true
      }
      files.push(stat)
    }
    const block: PreviewDiffBlock = {
      deviceId: source.deviceId,
      files,
      summary: summarizeFiles(files),
      hunks,
      truncated: blockTruncated,
    }
    blocks.push(block)
    for (const file of files) allFiles.push(file)
    for (const hunk of hunks) allHunks.push(hunk)
    if (blockTruncated) truncated = true
  }

  return { files: allFiles, summary: summarizeFiles(allFiles), hunks: allHunks, truncated, sources: blocks }
}
