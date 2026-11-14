/**
 * 本地采集（只读 profile，绝不写）。
 *
 * 产出四个同步文件 + manifest：
 *   cordis.patch.yml  脱敏后的 profile patch（保留注释/!!js）
 *   providers.json    从含 `providers:` 的 patch 条目提取并递归脱敏
 *   plugins.json      profile package.json 依赖 + node_modules 实际版本 + insert 行 enabled
 *   mcp.json          id/name 含 mcp 的 patch 条目（已脱敏）
 *   manifest.json     sha256/bytes/deviceId/time/scopes/dshVersion
 *
 * providers / mcp 提取需要一个"够用的 YAML 子集解析器"：只为展示与差异对照，
 * 不参与任何写回，因此解析失败只记 warning 并退回文本形态，不阻断同步。
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { entryHasProviders, entryLooksLikeMcp, parsePatch } from './patch.js'
import type { PatchDocument, PatchEntry } from './patch.js'
import { byteLength, detectDshVersion, sha256Hex } from './paths.js'
import {
  splitFlowItems,
  splitYamlComment,
  stripPatchSecrets,
  stripSecretsDeep,
  unquoteYamlScalar,
} from './secrets.js'
import type { DeviceManifest, ManifestFile, PluginEntry, SyncFileName, SyncScope } from './types.js'

export const SYNC_FILE_NAMES: readonly SyncFileName[] = [
  'cordis.patch.yml',
  'providers.json',
  'plugins.json',
  'mcp.json',
]

export interface CollectInput {
  profileDir: string
  homeDir?: string
  deviceId: string
  scopes: SyncScope
  dshVersion?: string
  now?: Date
}

export interface CollectResult {
  files: Record<SyncFileName, string>
  manifest: DeviceManifest
  warnings: string[]
}

/** 只读 profile 的 cordis.patch.yml（缺失按空内容处理）。 */
export function readProfilePatch(profileDir: string): string {
  try {
    return readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8')
  } catch {
    return ''
  }
}

export function isFileInScope(name: SyncFileName, scopes: SyncScope): boolean {
  switch (name) {
    case 'cordis.patch.yml':
      return scopes.config
    case 'providers.json':
      return scopes.providers
    case 'plugins.json':
      return scopes.plugins
    case 'mcp.json':
      return scopes.mcp
    default:
      return false
  }
}

export function serializeManifest(manifest: DeviceManifest): string {
  return JSON.stringify(manifest, null, 2) + '\n'
}

/* -------------------------------------------------------------------------- */
/* YAML 子集解析（仅用于 providers / mcp 的结构化展示）                          */
/* -------------------------------------------------------------------------- */

interface YamlLine {
  indent: number
  text: string
}

function isBlockScalarToken(value: string): boolean {
  return /^[|>][+-]?\d*$/.test(value)
}

function matchKey(text: string): { key: string; rest: string } | null {
  let quote: string | null = null
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!
    if (quote !== null) {
      if (quote === '"' && ch === '\\') {
        i += 1
        continue
      }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === ':') {
      const next = text[i + 1]
      if (next !== undefined && next !== ' ' && next !== '\t') continue
      const keyRaw = text.slice(0, i).trim()
      if (keyRaw === '') return null
      return { key: unquoteYamlScalar(keyRaw), rest: text.slice(i + 1).trim() }
    }
  }
  return null
}

function parseScalar(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed === '') return null
  if (trimmed.startsWith('!!js')) return trimmed
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return splitFlowItems(trimmed.slice(1, -1))
      .map((item) => item.trim())
      .filter((item) => item !== '')
      .map((item) => parseScalar(item))
  }
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    const out: Record<string, unknown> = {}
    for (const item of splitFlowItems(trimmed.slice(1, -1))) {
      const pair = matchKey(item.trim())
      if (pair === null) continue
      out[pair.key] = pair.rest === '' ? null : parseScalar(pair.rest)
    }
    return out
  }
  if (trimmed.length >= 2) {
    const quote = trimmed[0]
    if ((quote === '"' || quote === "'") && trimmed[trimmed.length - 1] === quote) return unquoteYamlScalar(trimmed)
  }
  const lower = trimmed.toLowerCase()
  if (trimmed === '~' || lower === 'null') return null
  if (lower === 'true') return true
  if (lower === 'false') return false
  if (/^-?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10)
  if (/^-?\d+\.\d+$/.test(trimmed)) return Number.parseFloat(trimmed)
  return trimmed
}

/** 把物理行转成结构化 token：顶层序列项 `- ` 拆成 `-` + 缩进 2 的内容行。 */
function tokenizeYaml(lines: string[]): YamlLine[] {
  const tokens: YamlLine[] = []
  for (const rawLine of lines) {
    const withoutComment = splitYamlComment(rawLine).code.replace(/\r$/, '')
    if (withoutComment.trim() === '') continue
    const indent = withoutComment.length - withoutComment.trimStart().length
    const content = withoutComment.trim()
    if (content === '-' || content.startsWith('- ')) {
      tokens.push({ indent, text: '-' })
      const rest = content === '-' ? '' : content.slice(2).trim()
      if (rest !== '') tokens.push({ indent: indent + 2, text: rest })
      continue
    }
    tokens.push({ indent, text: content })
  }
  return tokens
}

function parseSeq(tokens: YamlLine[], start: number, indent: number): { value: unknown[]; pos: number } {
  const items: unknown[] = []
  let pos = start
  while (pos < tokens.length && tokens[pos]!.indent === indent && tokens[pos]!.text === '-') {
    pos += 1
    const nextToken = tokens[pos]
    if (nextToken !== undefined && nextToken.indent > indent) {
      const child = parseBlock(tokens, pos, nextToken.indent)
      items.push(child.value)
      pos = child.pos
    } else {
      items.push(null)
    }
  }
  return { value: items, pos }
}

function parseMap(tokens: YamlLine[], start: number, indent: number): { value: Record<string, unknown>; pos: number } {
  const out: Record<string, unknown> = {}
  let pos = start
  while (pos < tokens.length && tokens[pos]!.indent === indent && tokens[pos]!.text !== '-') {
    const pair = matchKey(tokens[pos]!.text)
    if (pair === null) break
    pos += 1
    if (pair.rest === '') {
      const nextToken = tokens[pos]
      if (nextToken !== undefined && nextToken.indent > indent) {
        const child = parseBlock(tokens, pos, nextToken.indent)
        out[pair.key] = child.value
        pos = child.pos
      } else {
        out[pair.key] = null
      }
      continue
    }
    if (isBlockScalarToken(pair.rest)) {
      const parts: string[] = []
      while (pos < tokens.length && tokens[pos]!.indent > indent) {
        parts.push(tokens[pos]!.text)
        pos += 1
      }
      out[pair.key] = parts.join(pair.rest.startsWith('>') ? ' ' : '\n')
      continue
    }
    out[pair.key] = parseScalar(pair.rest)
  }
  return { value: out, pos }
}

function parseBlock(tokens: YamlLine[], start: number, indent: number): { value: unknown; pos: number } {
  if (start >= tokens.length) return { value: null, pos: start }
  if (tokens[start]!.text === '-') return parseSeq(tokens, start, indent)
  return parseMap(tokens, start, indent)
}

/** 把原文解析成 JS 值；失败返回 null（调用方退回文本形态）。 */
export function parseYamlSubset(text: string): unknown {
  const tokens = tokenizeYaml(text.split('\n'))
  if (tokens.length === 0) return null
  try {
    return parseBlock(tokens, 0, tokens[0]!.indent).value
  } catch {
    return null
  }
}

function collectProviders(node: unknown, out: Record<string, unknown>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectProviders(item, out)
    return
  }
  if (node === null || typeof node !== 'object') return
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'providers' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [id, definition] of Object.entries(value as Record<string, unknown>)) {
        if (!(id in out)) out[id] = definition
      }
      continue
    }
    collectProviders(value, out)
  }
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortKeysDeep(item))
  if (value === null || typeof value !== 'object') return value
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key])
  }
  return sorted
}

/* -------------------------------------------------------------------------- */
/* 四个文件的提取                                                              */
/* -------------------------------------------------------------------------- */

function buildProvidersFile(patchText: string, warnings: string[]): string {
  const doc: PatchDocument = parsePatch(patchText)
  const providers: Record<string, unknown> = {}
  for (const entry of doc.entries) {
    if (!entryHasProviders(entry)) continue
    const parsed = parseYamlSubset(entry.raw)
    if (parsed === null) {
      warnings.push(`provider 条目 ${entry.id ?? entry.key} 无法结构化解析，已跳过该条目的 provider 提取`)
      continue
    }
    collectProviders(parsed, providers)
  }
  const sanitized = stripSecretsDeep(sortKeysDeep(providers)).value
  return JSON.stringify({ providers: sanitized }, null, 2) + '\n'
}

function buildMcpFile(patchText: string): string {
  const doc = parsePatch(patchText)
  const entries = doc.entries
    .filter((entry) => entryLooksLikeMcp(entry))
    .map((entry) => ({ id: entry.id ?? entry.key, text: entry.raw }))
  const sanitized = stripSecretsDeep(entries).value
  return JSON.stringify({ entries: sanitized }, null, 2) + '\n'
}

function readJson(file: string): unknown {
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function insertNamesOf(doc: PatchDocument): Set<string> {
  const names = new Set<string>()
  for (const entry of doc.entries) {
    if (entry.kind !== 'insert') continue
    for (const line of entry.raw.split('\n')) {
      const match = /^\s*(?:-\s+)?(?:id|name)\s*:\s*(.*)$/.exec(line)
      if (match === null) continue
      const value = unquoteYamlScalar(splitYamlComment(match[1]!).code.trim())
      if (value !== '') names.add(value)
    }
  }
  return names
}

function installedVersion(profileDir: string, name: string): string | null {
  const pkgFile = path.join(profileDir, 'node_modules', ...name.split('/'), 'package.json')
  const parsed = readJson(pkgFile)
  if (parsed === null || typeof parsed !== 'object') return null
  const version = (parsed as Record<string, unknown>).version
  return typeof version === 'string' && version.trim() !== '' ? version.trim() : null
}

function declaredVersion(spec: string): string {
  const trimmed = typeof spec === 'string' ? spec.trim() : ''
  const match = /^[~^=v]?\s*(\d[^\s|]*)$/.exec(trimmed)
  return match === null ? trimmed : match[1]!.trim()
}

function buildPluginsFile(profileDir: string, patchText: string, warnings: string[]): string {
  const pkg = readJson(path.join(profileDir, 'package.json'))
  const dependencies: Record<string, unknown> = {}
  if (pkg === null || typeof pkg !== 'object') {
    warnings.push('profile package.json 缺失或无法解析，plugins.json 按空清单处理')
  } else {
    const deps = (pkg as Record<string, unknown>).dependencies
    if (deps !== null && typeof deps === 'object' && !Array.isArray(deps)) {
      Object.assign(dependencies, deps as Record<string, unknown>)
    }
  }
  const insertNames = insertNamesOf(parsePatch(patchText))
  const plugins: PluginEntry[] = []
  for (const name of Object.keys(dependencies).sort()) {
    const spec = dependencies[name]
    const source = typeof spec === 'string' ? spec : ''
    const version = installedVersion(profileDir, name) ?? declaredVersion(source)
    if (installedVersion(profileDir, name) === null) {
      warnings.push(`插件 ${name} 未安装到 node_modules，使用声明版本 ${version}`)
    }
    const shortName = name.startsWith('@') ? name.split('/')[1] ?? name : name
    const enabled = insertNames.has(name) || insertNames.has(shortName)
    plugins.push({ name, version, source, enabled })
  }
  return JSON.stringify({ plugins }, null, 2) + '\n'
}

/* -------------------------------------------------------------------------- */
/* 入口                                                                        */
/* -------------------------------------------------------------------------- */

export function collectLocal(input: CollectInput): CollectResult {
  const profileDir = path.resolve(input.profileDir)
  const warnings: string[] = []
  const scopes: SyncScope = { ...input.scopes }
  const now = input.now ?? new Date()
  const dshVersion = input.dshVersion ?? detectDshVersion(input.homeDir)

  const rawPatch = readProfilePatch(profileDir)
  if (rawPatch === '') warnings.push(`profile patch 不存在或为空：${path.join(profileDir, 'cordis.patch.yml')}`)

  const strippedPatch = stripPatchSecrets(rawPatch)
  const patchOut = scopes.config ? strippedPatch.text : ''

  const files: Record<SyncFileName, string> = {
    'cordis.patch.yml': patchOut,
    'providers.json': scopes.providers ? buildProvidersFile(strippedPatch.text, warnings) : '',
    'plugins.json': scopes.plugins ? buildPluginsFile(profileDir, strippedPatch.text, warnings) : '',
    'mcp.json': scopes.mcp ? buildMcpFile(strippedPatch.text) : '',
  }

  // 采集期最后一道闸：任何文件都不应残留本地已知 secret（strip 已处理，这里只做形状校验）。
  for (const name of SYNC_FILE_NAMES) {
    if (typeof files[name] !== 'string') files[name] = ''
  }

  const manifestFiles: ManifestFile[] = SYNC_FILE_NAMES.map((name) => ({
    name,
    sha256: sha256Hex(files[name]),
    bytes: byteLength(files[name]),
  }))

  const manifest: DeviceManifest = {
    deviceId: input.deviceId,
    time: now.toISOString(),
    scopes,
    dshVersion,
    files: manifestFiles,
  }

  return { files, manifest, warnings }
}

/** 供预览/对比使用的 provider id 集合。 */
export function providerIdsOf(providersFileText: string): string[] {
  const parsed = parseJsonObject(providersFileText)
  const providers = parsed?.providers
  if (providers === null || typeof providers !== 'object' || Array.isArray(providers)) return []
  return Object.keys(providers as Record<string, unknown>).sort()
}

export function mcpIdsOf(mcpFileText: string): string[] {
  const parsed = parseJsonObject(mcpFileText)
  const entries = parsed?.entries
  if (!Array.isArray(entries)) return []
  const ids: string[] = []
  for (const entry of entries) {
    if (entry !== null && typeof entry === 'object') {
      const id = (entry as Record<string, unknown>).id
      if (typeof id === 'string' && id !== '') ids.push(id)
    }
  }
  return ids.sort()
}

export function pluginsOf(pluginsFileText: string): PluginEntry[] {
  const parsed = parseJsonObject(pluginsFileText)
  const plugins = parsed?.plugins
  if (!Array.isArray(plugins)) return []
  const out: PluginEntry[] = []
  for (const item of plugins) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (typeof record.name !== 'string' || record.name === '') continue
    out.push({
      name: record.name,
      version: typeof record.version === 'string' ? record.version : '',
      source: typeof record.source === 'string' ? record.source : '',
      enabled: record.enabled === true,
    })
  }
  return out
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  if (typeof text !== 'string' || text.trim() === '') return null
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** 提取某个 patch entry 的原始块（apply 时按 key 取远端块用）。 */
export function entryByKeyText(doc: PatchDocument, key: string): PatchEntry | null {
  for (const entry of doc.entries) if (entry.key === key) return entry
  return null
}
