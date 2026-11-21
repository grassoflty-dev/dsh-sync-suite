/**
 * dots 按实例 / 按工具授权模型（插件侧，`mod-plugin-remote-tools`）。
 *
 * 镜像 App 侧 `apps/arkui-schedule/entry/src/main/ets/model/instanceGrant.ts` 的语义，
 * 但落在插件宿主（Node）里；契约见 `docs/CLOUD-CHAT-AND-DOTS.md` §4、
 * `docs/REMOTE-INSTANCES.md` §2/§4。
 *
 * 六条不变式：
 *  1. grantKey = (instanceId, principal)：同实例同 principal 只有一条，upsert 按键替换。
 *  2. view 权**永不隐含** command 权：`session.prompt` / `session.create` / `session.lease*`
 *     必须显式列在 tools 里才生效；本模块没有任何从 view 推导 command 的路径。
 *  3. per-instance 隔离：A 实例的授权绝不放行 B 实例。
 *  4. fail-closed 时间语义：仅 `grantedAt <= t < (revokedAt|expiresAt)` 有效；
 *     未生效 / 已吊销 / 已过期 / 时间非法都不授权。
 *  5. typed 拒绝，不抛异常：坏记录 / 坏信封 → 空表 + typed problem（坏信封整表回落空表）。
 *  6. 零凭据：本模型与 store **没有 token 字段、没有日志调用**；信封只写 grantId /
 *     instanceId / principal / tools / 时间，红acted 视图不带自由文本 note。
 *
 * 持久化位置：`~/.dsh/dots/instance-grants.json`（`statePaths().root`），在同步 Git 仓库之外，
 * 与 `remote.json` / `remote-token.json` 同目录、同原子写 + 0600 纪律。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { statePaths } from '../engine/paths.js'

/** dots 的唯一 principal（与设备 principal 区分）。 */
export const PRINCIPAL_DOTS = 'dots'

/* ----------------------------- 工具 id ----------------------------- */

/** 五个 view 工具（read-only，本模块消费前四个；instance.inspect 留作查看详情）。 */
export const TOOL_INSTANCE_LIST = 'instance.list'
export const TOOL_INSTANCE_INSPECT = 'instance.inspect'
export const TOOL_SESSION_LIST = 'session.list'
export const TOOL_SESSION_INFO = 'session.info'
export const TOOL_SESSION_EVENTS = 'session.events'

/** 命令工具（保留 id，**默认拒绝**；本模块不注册任何对应 action）。 */
export const TOOL_SESSION_PROMPT = 'session.prompt'
export const TOOL_SESSION_CREATE = 'session.create'
export const TOOL_LEASE_CLAIM = 'session.lease.claim'
export const TOOL_LEASE_HEARTBEAT = 'session.lease.heartbeat'
export const TOOL_LEASE_RELEASE = 'session.lease.release'

export type GrantTool =
  | typeof TOOL_INSTANCE_LIST
  | typeof TOOL_INSTANCE_INSPECT
  | typeof TOOL_SESSION_LIST
  | typeof TOOL_SESSION_INFO
  | typeof TOOL_SESSION_EVENTS
  | typeof TOOL_SESSION_PROMPT
  | typeof TOOL_SESSION_CREATE
  | typeof TOOL_LEASE_CLAIM
  | typeof TOOL_LEASE_HEARTBEAT
  | typeof TOOL_LEASE_RELEASE

/** 只读 / 查看类工具。顺序即规范化 canonical 顺序。 */
export const VIEW_TOOLS: readonly GrantTool[] = [
  TOOL_INSTANCE_LIST,
  TOOL_INSTANCE_INSPECT,
  TOOL_SESSION_LIST,
  TOOL_SESSION_INFO,
  TOOL_SESSION_EVENTS,
]

/** 命令类工具（保留 id，默认拒绝，任何 view 授权都不会含它们）。 */
export const COMMAND_TOOLS: readonly GrantTool[] = [
  TOOL_SESSION_PROMPT,
  TOOL_SESSION_CREATE,
  TOOL_LEASE_CLAIM,
  TOOL_LEASE_HEARTBEAT,
  TOOL_LEASE_RELEASE,
]

export const ALL_GRANT_TOOLS: readonly GrantTool[] = [...VIEW_TOOLS, ...COMMAND_TOOLS]

/** 实例 id 形状与 App 侧一致：`local` 或 `inst-<16hex>`。 */
export const INSTANCE_ID_PATTERN = /^(local|inst-[0-9a-f]{16})$/

/** 持久化信封版本：只认 1，未来版本 typed 拒绝、不静默迁移。 */
export const GRANT_ENVELOPE_VERSION = 1

/* ----------------------------- typed 问题码 ----------------------------- */

export type GrantProblem =
  | 'ok'
  | 'E_GRANT_SHAPE'
  | 'E_GRANT_ID'
  | 'E_GRANT_INSTANCE_ID'
  | 'E_GRANT_PRINCIPAL'
  | 'E_GRANT_TOOLS_SHAPE'
  | 'E_GRANT_TOOLS_EMPTY'
  | 'E_GRANT_TOOL_UNKNOWN'
  | 'E_GRANT_GRANTED_AT'
  | 'E_GRANT_REVOKED_AT'
  | 'E_GRANT_EXPIRES_AT'
  | 'E_GRANT_NOW'
  | 'E_GRANT_ENVELOPE_EMPTY'
  | 'E_GRANT_ENVELOPE_JSON'
  | 'E_GRANT_ENVELOPE_SHAPE'
  | 'E_GRANT_ENVELOPE_VERSION'
  | 'E_GRANT_ENVELOPE_ITEM'
  | 'E_GRANT_STORAGE_UNAVAILABLE'

/** typed 码 → 中文原因（原因里没有任何凭据值）。 */
export function problemText(problem: GrantProblem): string {
  switch (problem) {
    case 'E_GRANT_SHAPE': return '授权数据不是对象'
    case 'E_GRANT_ID': return '授权 id 不能为空'
    case 'E_GRANT_INSTANCE_ID': return '实例 id 只能是 local 或 inst- 加 16 位十六进制'
    case 'E_GRANT_PRINCIPAL': return '授权对象只能是 dots'
    case 'E_GRANT_TOOLS_SHAPE': return '授权工具列表必须是数组'
    case 'E_GRANT_TOOLS_EMPTY': return '授权工具列表不能为空'
    case 'E_GRANT_TOOL_UNKNOWN': return '授权工具不在允许的工具集合内'
    case 'E_GRANT_GRANTED_AT': return '授权生效时间必须是正整数时间戳'
    case 'E_GRANT_REVOKED_AT': return '授权吊销时间必须是正整数时间戳'
    case 'E_GRANT_EXPIRES_AT': return '授权到期时间必须是正整数时间戳'
    case 'E_GRANT_NOW': return '授权操作时间必须是正整数时间戳'
    case 'E_GRANT_ENVELOPE_EMPTY': return '还没有保存过 dots 授权'
    case 'E_GRANT_ENVELOPE_JSON': return '授权表 JSON 损坏，已回落空表'
    case 'E_GRANT_ENVELOPE_SHAPE': return '授权表结构不正确，已回落空表'
    case 'E_GRANT_ENVELOPE_VERSION': return '授权表版本不认识，已回落空表'
    case 'E_GRANT_ENVELOPE_ITEM': return '授权表中有损坏的记录，已回落空表'
    case 'E_GRANT_STORAGE_UNAVAILABLE': return '本地存储不可用，授权表只在本次运行内有效'
    default: return ''
  }
}

/* ----------------------------- 数据结构 ----------------------------- */

/** 一条授权记录。principal 字面量固定 dots。 */
export interface InstanceGrant {
  grantId: string
  instanceId: string
  principal: typeof PRINCIPAL_DOTS
  tools: GrantTool[]
  grantedAt: number
  revokedAt?: number
  expiresAt?: number
  /** 人写备注；红acted 视图会剥掉，且**不是** secret 字段（禁止写 token）。 */
  note?: string
}

/** 运行时宽松读取（脏 JSON 的数字 / null / 数组不能让归一抛错）。 */
export type LooseValue = string | number | boolean | null | undefined | object

export interface RawGrant {
  grantId?: LooseValue
  instanceId?: LooseValue
  principal?: LooseValue
  tools?: LooseValue
  grantedAt?: LooseValue
  revokedAt?: LooseValue
  expiresAt?: LooseValue
  note?: LooseValue
}

export interface GrantNormalizeResult {
  ok: boolean
  grant: InstanceGrant | null
  problem: GrantProblem
  reason: string
}

export interface GrantDecodeResult {
  ok: boolean
  items: InstanceGrant[]
  problem: GrantProblem
  reason: string
}

export interface GrantMutationResult {
  ok: boolean
  items: InstanceGrant[]
  problem: GrantProblem
  reason: string
}

/** 渲染 / 导出唯一视图：无自由文本 note，带派生的 active / canPrompt。 */
export interface RedactedGrant {
  grantId: string
  instanceId: string
  principal: typeof PRINCIPAL_DOTS
  tools: GrantTool[]
  grantedAt: number
  revokedAt?: number
  expiresAt?: number
  active: boolean
  canPrompt: boolean
}

/* ----------------------------- 纯模型 ----------------------------- */

export function emptyTools(): GrantTool[] {
  return []
}

function readText(value: LooseValue): string {
  return typeof value === 'string' ? value.trim() : ''
}

function validTime(value: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

export function isKnownTool(raw: string): boolean {
  return typeof raw === 'string' && ALL_GRANT_TOOLS.indexOf(raw as GrantTool) >= 0
}

export function isViewTool(raw: string): boolean {
  return typeof raw === 'string' && VIEW_TOOLS.indexOf(raw as GrantTool) >= 0
}

export function isCommandTool(raw: string): boolean {
  return typeof raw === 'string' && COMMAND_TOOLS.indexOf(raw as GrantTool) >= 0
}

/** canonical 化工具：按合法顺序去重，未知工具直接丢弃（fail-closed）。 */
export function canonicalTools(tools: GrantTool[]): GrantTool[] {
  const out: GrantTool[] = []
  for (const tool of ALL_GRANT_TOOLS) {
    if (tools.indexOf(tool) >= 0) out.push(tool)
  }
  return out
}

/** grantKey 的唯一构造点（`instanceId|principal`）。 */
export function makeGrantKey(instanceId: string, principal: string): string {
  return `${instanceId}|${principal}`
}

export function grantKey(grant: InstanceGrant): string {
  return makeGrantKey(grant.instanceId, grant.principal)
}

/** 深拷贝一条授权（canonical 工具顺序，不共享可变数组给调用方）。 */
export function copyGrant(grant: InstanceGrant): InstanceGrant {
  const copy: InstanceGrant = {
    grantId: grant.grantId,
    instanceId: grant.instanceId,
    principal: PRINCIPAL_DOTS,
    tools: canonicalTools(grant.tools),
    grantedAt: grant.grantedAt,
  }
  if (grant.revokedAt !== undefined) copy.revokedAt = grant.revokedAt
  if (grant.expiresAt !== undefined) copy.expiresAt = grant.expiresAt
  if (grant.note !== undefined) copy.note = grant.note
  return copy
}

function refused(problem: GrantProblem): GrantNormalizeResult {
  return { ok: false, grant: null, problem, reason: problemText(problem) }
}

function accepted(grant: InstanceGrant): GrantNormalizeResult {
  return { ok: true, grant, problem: 'ok', reason: '' }
}

function decodeFailed(problem: GrantProblem): GrantDecodeResult {
  return { ok: false, items: [], problem, reason: problemText(problem) }
}

function mutationRefused(problem: GrantProblem, grants: InstanceGrant[]): GrantMutationResult {
  return { ok: false, items: grants.map(copyGrant), problem, reason: problemText(problem) }
}

function mutationAccepted(items: InstanceGrant[]): GrantMutationResult {
  return { ok: true, items: sortGrants(items), problem: 'ok', reason: '' }
}

/** 校验并归一一条授权（**不抛异常**）。判定顺序见函数体注释。 */
export function normalizeGrant(raw: RawGrant | null | undefined): GrantNormalizeResult {
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) return refused('E_GRANT_SHAPE')
  const grantId = readText(raw.grantId)
  if (grantId === '') return refused('E_GRANT_ID')
  const instanceId = readText(raw.instanceId)
  if (!INSTANCE_ID_PATTERN.test(instanceId)) return refused('E_GRANT_INSTANCE_ID')
  const principal = readText(raw.principal)
  if (principal !== PRINCIPAL_DOTS) return refused('E_GRANT_PRINCIPAL')
  if (!Array.isArray(raw.tools)) return refused('E_GRANT_TOOLS_SHAPE')
  const rawTools = raw.tools as LooseValue[]
  if (rawTools.length === 0) return refused('E_GRANT_TOOLS_EMPTY')
  const tools: GrantTool[] = []
  for (const item of rawTools) {
    const tool = readText(item)
    if (!isKnownTool(tool)) return refused('E_GRANT_TOOL_UNKNOWN')
    tools.push(tool as GrantTool)
  }
  const grantedAt = typeof raw.grantedAt === 'number' ? raw.grantedAt : Number.NaN
  if (!validTime(grantedAt)) return refused('E_GRANT_GRANTED_AT')
  const grant: InstanceGrant = {
    grantId,
    instanceId,
    principal: PRINCIPAL_DOTS,
    tools: canonicalTools(tools),
    grantedAt: Math.trunc(grantedAt),
  }
  if (raw.revokedAt !== undefined && raw.revokedAt !== null) {
    const revokedAt = typeof raw.revokedAt === 'number' ? raw.revokedAt : Number.NaN
    if (!validTime(revokedAt)) return refused('E_GRANT_REVOKED_AT')
    grant.revokedAt = Math.trunc(revokedAt)
  }
  if (raw.expiresAt !== undefined && raw.expiresAt !== null) {
    const expiresAt = typeof raw.expiresAt === 'number' ? raw.expiresAt : Number.NaN
    if (!validTime(expiresAt)) return refused('E_GRANT_EXPIRES_AT')
    grant.expiresAt = Math.trunc(expiresAt)
  }
  const note = readText(raw.note)
  if (note !== '') grant.note = note
  return accepted(grant)
}

/** 一条授权在时刻 t 是否有效（未生效 / 已吊销 / 已过期 / 时间非法均 false）。 */
export function grantActive(grant: InstanceGrant, nowMs: number): boolean {
  if (!validTime(nowMs)) return false
  if (grant.principal !== PRINCIPAL_DOTS) return false
  if (!validTime(grant.grantedAt) || nowMs < grant.grantedAt) return false
  if (grant.revokedAt !== undefined && nowMs >= grant.revokedAt) return false
  if (grant.expiresAt !== undefined && nowMs >= grant.expiresAt) return false
  return true
}

/** 精确实例 + 精确工具 + 有效期内才授权；view 永不推导出 command。 */
export function isGranted(grants: InstanceGrant[], instanceId: string, tool: GrantTool | string, nowMs: number): boolean {
  if (!isKnownTool(tool) || !validTime(nowMs)) return false
  for (const grant of grants) {
    if (grant.instanceId !== instanceId) continue
    if (!grantActive(grant, nowMs)) continue
    if (grant.tools.indexOf(tool as GrantTool) >= 0) return true
  }
  return false
}

/** 该实例当前有效的工具并集（canonical 顺序）；不补入任何未显式授予的工具。 */
export function grantedTools(grants: InstanceGrant[], instanceId: string, nowMs: number): GrantTool[] {
  if (!validTime(nowMs)) return emptyTools()
  const found: GrantTool[] = []
  for (const grant of grants) {
    if (grant.instanceId !== instanceId || !grantActive(grant, nowMs)) continue
    for (const tool of grant.tools) if (found.indexOf(tool) < 0) found.push(tool)
  }
  return canonicalTools(found)
}

/** 是否显式授予命令工具（本模块恒不消费，只供门禁实现参考）。 */
export function canPrompt(grants: InstanceGrant[], instanceId: string, nowMs: number): boolean {
  return isGranted(grants, instanceId, TOOL_SESSION_PROMPT, nowMs)
}

export function findGrant(grants: InstanceGrant[], grantId: string): InstanceGrant | null {
  for (const grant of grants) if (grant.grantId === grantId) return grant
  return null
}

/** 确定性排序（不用 localeCompare，免得随系统 locale 变）。 */
export function sortGrants(list: InstanceGrant[]): InstanceGrant[] {
  return list.slice().sort((a, b) => {
    const keyA = grantKey(a)
    const keyB = grantKey(b)
    if (keyA < keyB) return -1
    if (keyA > keyB) return 1
    if (a.grantId < b.grantId) return -1
    if (a.grantId > b.grantId) return 1
    return 0
  })
}

/** 插入或按 grantKey 替换；坏授权 typed 拒绝 + 原表副本，绝不落盘会被归一拒绝的记录。 */
export function upsertGrant(grants: InstanceGrant[], grant: InstanceGrant): GrantMutationResult {
  const normalized = normalizeGrant(grant)
  if (!normalized.ok || normalized.grant === null) return mutationRefused(normalized.problem, grants)
  const key = grantKey(normalized.grant)
  const next: InstanceGrant[] = []
  let replaced = false
  for (const item of grants) {
    if (grantKey(item) === key) {
      next.push(normalized.grant)
      replaced = true
    } else {
      next.push(copyGrant(item))
    }
  }
  if (!replaced) next.push(normalized.grant)
  return mutationAccepted(next)
}

/**
 * 吊销：按 grantId 写 revokedAt = nowMs；已是吊销态保留更早的 revokedAt
 * （重复吊销不延长授权窗口）。非法 nowMs → typed 拒绝 + 原表不动。
 */
export function revokeGrant(grants: InstanceGrant[], grantId: string, nowMs: number): GrantMutationResult {
  if (!validTime(nowMs)) return mutationRefused('E_GRANT_NOW', grants)
  if (findGrant(grants, grantId) === null) return mutationAccepted(grants)
  const at = Math.trunc(nowMs)
  const next: InstanceGrant[] = []
  for (const item of grants) {
    if (item.grantId !== grantId) {
      next.push(copyGrant(item))
      continue
    }
    const revoked = copyGrant(item)
    if (item.revokedAt !== undefined) {
      if (!validTime(item.revokedAt)) return mutationRefused('E_GRANT_REVOKED_AT', grants)
      revoked.revokedAt = Math.min(item.revokedAt, at)
    } else {
      revoked.revokedAt = at
    }
    next.push(revoked)
  }
  return mutationAccepted(next)
}

/** 红acted 视图：剥掉 note，只给派生的 active / canPrompt（view 永不使 canPrompt 为 true）。 */
export function redactGrant(grant: InstanceGrant, nowMs: number): RedactedGrant {
  const view: RedactedGrant = {
    grantId: grant.grantId,
    instanceId: grant.instanceId,
    principal: PRINCIPAL_DOTS,
    tools: canonicalTools(grant.tools),
    grantedAt: grant.grantedAt,
    active: grantActive(grant, nowMs),
    canPrompt: isGranted([grant], grant.instanceId, TOOL_SESSION_PROMPT, nowMs),
  }
  if (grant.revokedAt !== undefined) view.revokedAt = grant.revokedAt
  if (grant.expiresAt !== undefined) view.expiresAt = grant.expiresAt
  return view
}

/** 重复 grantKey 的决胜规则：grantedAt 更大者胜，同刻 grantId 字典序更大者胜。 */
function winsDuplicate(candidate: InstanceGrant, kept: InstanceGrant): boolean {
  if (candidate.grantedAt !== kept.grantedAt) return candidate.grantedAt > kept.grantedAt
  return candidate.grantId > kept.grantId
}

interface GrantEnvelope {
  v: number
  items: InstanceGrant[]
}

/** 序列化整表（固定键顺序；无任何凭据字段）。 */
export function encodeGrants(list: InstanceGrant[]): string {
  const envelope: GrantEnvelope = { v: GRANT_ENVELOPE_VERSION, items: sortGrants(list).map(copyGrant) }
  return JSON.stringify(envelope)
}

/**
 * 反序列化整表：空串 / 坏 JSON / 结构错 / 版本错 / 任一记录坏 → 空表 + typed reason。
 * 合法记录按 grantKey 去重（最新 grantedAt 胜，同刻 grantId 大者胜）。不抛异常。
 */
export function decodeGrants(raw: string | null | undefined): GrantDecodeResult {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') return decodeFailed('E_GRANT_ENVELOPE_EMPTY')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return decodeFailed('E_GRANT_ENVELOPE_JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return decodeFailed('E_GRANT_ENVELOPE_SHAPE')
  const envelope = parsed as Partial<GrantEnvelope>
  if (typeof envelope.v !== 'number' || !Number.isFinite(envelope.v)) return decodeFailed('E_GRANT_ENVELOPE_SHAPE')
  if (envelope.v !== GRANT_ENVELOPE_VERSION) return decodeFailed('E_GRANT_ENVELOPE_VERSION')
  if (!Array.isArray(envelope.items)) return decodeFailed('E_GRANT_ENVELOPE_SHAPE')
  const items: InstanceGrant[] = []
  for (const rawItem of envelope.items as LooseValue[]) {
    const result = normalizeGrant(rawItem as RawGrant)
    if (!result.ok || result.grant === null) return decodeFailed('E_GRANT_ENVELOPE_ITEM')
    const winner = result.grant
    const key = grantKey(winner)
    const at = items.findIndex((item) => grantKey(item) === key)
    if (at < 0) items.push(winner)
    else if (winsDuplicate(winner, items[at]!)) items[at] = winner
  }
  return { ok: true, items: sortGrants(items), problem: 'ok', reason: '' }
}

/* ----------------------------- 持久化 store ----------------------------- */

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
}

/** 原子写 + 0600（与 `remote/store.ts` 同款；Windows 上 POSIX mode 不生效，Linux/macOS 生效）。 */
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

export interface GrantStoreOptions {
  /** 覆盖 `~`（测试隔离）；语义同 `engine/paths.ts` 的 `homeDir`。 */
  homeDir?: string
  /** 文件名（默认 `instance-grants.json`）。 */
  fileName?: string
  /** 可注入时钟（缺省 new Date）；吊销默认时刻用它。 */
  now?: () => Date
}

/**
 * 授权表持久化：单文件整表原子替换，坏信封回落空表。
 * 文件路径在插件状态目录（同步仓库之外），**没有任何日志调用**。
 */
export class GrantStore {
  readonly file: string
  private items: InstanceGrant[] | null = null
  private problem: GrantProblem = 'ok'
  private readonly now: () => Date

  constructor(options: GrantStoreOptions = {}) {
    const root = statePaths(options.homeDir).root
    this.file = path.join(root, options.fileName ?? 'instance-grants.json')
    this.now = options.now ?? ((): Date => new Date())
  }

  private load(): InstanceGrant[] {
    if (this.items !== null) return this.items
    let raw = ''
    try {
      raw = existsSync(this.file) ? readFileSync(this.file, 'utf8') : ''
    } catch {
      this.problem = 'E_GRANT_STORAGE_UNAVAILABLE'
      this.items = []
      return this.items
    }
    const decoded = decodeGrants(raw)
    this.problem = decoded.problem
    this.items = decoded.items
    return this.items
  }

  private commit(items: InstanceGrant[]): InstanceGrant[] {
    const sorted = sortGrants(items)
    const json = encodeGrants(sorted)
    try {
      writeFilePrivate(this.file, json)
      this.problem = 'ok'
    } catch {
      this.problem = 'E_GRANT_STORAGE_UNAVAILABLE'
    }
    this.items = sorted
    return sorted.map(copyGrant)
  }

  /** 当前授权表（返回副本，确定性排序）。 */
  list(): InstanceGrant[] {
    return this.load().map(copyGrant)
  }

  /** typed 问题码：坏信封 / 存储不可用；会触发一次懒加载。 */
  lastProblem(): GrantProblem {
    this.load()
    return this.problem
  }

  /** 插入或按 grantKey 替换；坏授权只标 typed problem，不写回。 */
  upsert(grant: InstanceGrant): boolean {
    const result = upsertGrant(this.load(), grant)
    if (!result.ok) {
      this.problem = result.problem
      return false
    }
    this.commit(result.items)
    return true
  }

  /** 按 grantId 吊销（缺省时刻取注入时钟）；nowMs 非法时不写回。 */
  revoke(grantId: string, nowMs?: number): boolean {
    const at = typeof nowMs === 'number' ? nowMs : this.now().getTime()
    const result = revokeGrant(this.load(), grantId, at)
    if (!result.ok) {
      this.problem = result.problem
      return false
    }
    this.commit(result.items)
    return true
  }

  /** 本模块的门禁入口：精确实例 + 精确工具 + 有效期。 */
  isGranted(instanceId: string, tool: GrantTool | string, nowMs?: number): boolean {
    const at = typeof nowMs === 'number' ? nowMs : this.now().getTime()
    return isGranted(this.load(), instanceId, tool, at)
  }

  /** 红acted 视图（无 note、带派生 active / canPrompt）。 */
  redacted(nowMs?: number): RedactedGrant[] {
    const at = typeof nowMs === 'number' ? nowMs : this.now().getTime()
    return this.load().map((item) => redactGrant(item, at))
  }
}
