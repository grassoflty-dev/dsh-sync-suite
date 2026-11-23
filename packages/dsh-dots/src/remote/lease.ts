/**
 * mod-chat-lease：会话写租约的**纯决策层**（插件侧，零 RPC / 零 IO / 零时钟读取）。
 *
 * 设计依据：`docs/CLOUD-CHAT-AND-DOTS.md` §3/§4 与 `docs/CHAT-SYNC.md` §2.2/§3/§3.1/§4：
 *  - 同一 sessionId 同一时刻最多一个写者；租约是公告，真正的一致性靠 headSha 乐观锁；
 *  - `owner===dots` 且未过期才算本机持有；他人未过期租约 ⇒ OBSERVING，一个字节不写；
 *  - 过期租约可接管（reclaimed），但**绝不**因为持有租约就覆盖并发写入（E_HEAD_MOVED）；
 *  - dots 永不写人正开着的会话：`decidePromptWrite` 对 `owner !== 'dots'` 一律不授予。
 *
 * 本文件是纯叶子：没有 fs / timer / Date.now / console；所有时刻由调用方传入 `nowMs`。
 * `CLAIMING` 是状态机里的瞬时态（乐观锁提交中），纯决策函数不会返回它。
 *
 * 词汇表 `LEASE_WORDING` 是四码中文文案的唯一事实源，逐字对齐 docs 的拒绝文案表；
 * 任何文案都不得含 token / URL / 路径 / 十六进制串。
 */

/* ----------------------------- 常量与词汇 ----------------------------- */

/** 持久化信封版本：只认 1，未来版本 typed 拒绝，不静默迁移。 */
export const LEASE_ENVELOPE_VERSION = 1

/** dots 是本模块唯一可写 principal（设备 human owner 永不从这里获得写权）。 */
export const PRINCIPAL_DOTS = 'dots'

export type LeaseState = 'FREE' | 'CLAIMING' | 'HELD' | 'OBSERVING'

export type LeaseRefusalCode =
  | 'E_LEASE_NOT_HELD'
  | 'E_LEASE_OBSERVING'
  | 'E_LEASE_EXPIRED'
  | 'E_HEAD_MOVED'

/** 四码中文文案（逐字固定；docs 的拒绝表与本对象做逐字节对拍）。 */
export const LEASE_WORDING: Readonly<Record<LeaseRefusalCode, string>> = {
  E_LEASE_NOT_HELD: '未持有该会话的写权限，未写入任何内容',
  E_LEASE_OBSERVING: '该会话正被其他人使用（只读），未写入任何内容',
  E_LEASE_EXPIRED: '会话写权限已过期，请重新确认后重试',
  E_HEAD_MOVED: '会话头已变化（可能来自其他写者，也可能来自你上一次写入），请先刷新再重新确认',
}

/* ----------------------------- typed 问题码 ----------------------------- */

export type LeaseProblem =
  | 'E_LEASE_SHAPE'
  | 'E_LEASE_V'
  | 'E_LEASE_SESSION_ID'
  | 'E_LEASE_INSTANCE_ID'
  | 'E_LEASE_OWNER'
  | 'E_LEASE_TTL_SEC'
  | 'E_LEASE_EXPIRES_AT'
  | 'E_LEASE_HEAD_SHA'
  | 'E_LEASE_UNKNOWN_FIELD'
  | 'E_LEASE_ENVELOPE_EMPTY'
  | 'E_LEASE_ENVELOPE_JSON'
  | 'E_LEASE_ENVELOPE_SHAPE'
  | 'E_LEASE_ENVELOPE_VERSION'
  | 'E_LEASE_ENVELOPE_ITEM'
  | 'E_LEASE_STORAGE_UNAVAILABLE'

/** typed 码 → 中文原因（没有任何 token / 路径 / URL / 十六进制值）。 */
export function problemText(problem: LeaseProblem): string {
  switch (problem) {
    case 'E_LEASE_SHAPE': return '租约数据不是对象'
    case 'E_LEASE_V': return '租约版本不正确'
    case 'E_LEASE_SESSION_ID': return '会话 id 不能为空'
    case 'E_LEASE_INSTANCE_ID': return '实例 id 不能为空'
    case 'E_LEASE_OWNER': return '租约持有者不能为空'
    case 'E_LEASE_TTL_SEC': return '租约有效期必须是正整数'
    case 'E_LEASE_EXPIRES_AT': return '租约到期时间必须是正整数时间戳'
    case 'E_LEASE_HEAD_SHA': return '租约头锚不能为空'
    case 'E_LEASE_UNKNOWN_FIELD': return '租约含未知字段，按损坏处理'
    case 'E_LEASE_ENVELOPE_EMPTY': return '还没有保存过会话租约'
    case 'E_LEASE_ENVELOPE_JSON': return '租约表 JSON 损坏，已回落空表'
    case 'E_LEASE_ENVELOPE_SHAPE': return '租约表结构不正确，已回落空表'
    case 'E_LEASE_ENVELOPE_VERSION': return '租约表版本不认识，已回落空表'
    case 'E_LEASE_ENVELOPE_ITEM': return '租约表中有损坏的记录，已回落空表'
    case 'E_LEASE_STORAGE_UNAVAILABLE': return '本地存储不可用，租约表只在本次运行内有效'
    default: return ''
  }
}

/* ----------------------------- 数据结构 ----------------------------- */

export interface SessionLease {
  v: number
  sessionId: string
  instanceId: string
  owner: string
  ttlSec: number
  expiresAt: number
  headSha: string
}

/** 运行时宽松读取（脏 JSON 的数字 / null / 数组不能让归一抛错）。 */
export type LooseValue = string | number | boolean | null | undefined | object

const LEASE_FIELDS: readonly string[] = [
  'v', 'sessionId', 'instanceId', 'owner', 'ttlSec', 'expiresAt', 'headSha',
]

export interface RawLease {
  v?: LooseValue
  sessionId?: LooseValue
  instanceId?: LooseValue
  owner?: LooseValue
  ttlSec?: LooseValue
  expiresAt?: LooseValue
  headSha?: LooseValue
}

export interface LeaseNormalizeResult {
  ok: boolean
  lease: SessionLease | null
  problem: LeaseProblem | null
  reason: string
}

export interface LeaseDecodeResult {
  ok: boolean
  leases: SessionLease[]
  problem: LeaseProblem | null
  reason: string
}

export interface LeaseSingleDecodeResult {
  ok: boolean
  lease: SessionLease | null
  problem: LeaseProblem | null
  reason: string
}

/* ----------------------------- 决策结果 ----------------------------- */

export interface ClaimRequest {
  sessionId: string
  instanceId: string
  owner: string
  ttlSec: number
  headSha: string
  nowMs: number
}

export interface ClaimOk {
  ok: true
  lease: SessionLease
  reclaimed: boolean
}

export interface ClaimRefused {
  ok: false
  code: LeaseRefusalCode
  wording: string
}

export type ClaimResult = ClaimOk | ClaimRefused

export interface HeartbeatOk {
  ok: true
  lease: SessionLease
}

export interface HeartbeatRefused {
  ok: false
  code: LeaseRefusalCode
  wording: string
}

export type HeartbeatResult = HeartbeatOk | HeartbeatRefused

export interface ReleaseOk {
  ok: true
  lease: SessionLease | null
}

export interface ReleaseRefused {
  ok: false
  code: LeaseRefusalCode
  wording: string
}

export type ReleaseResult = ReleaseOk | ReleaseRefused

export interface PromptWriteRequest {
  owner: string
  expectedPrevSha: string
  actualHeadSha: string
  nowMs: number
}

export interface PromptWriteOk {
  ok: true
}

export interface PromptWriteRefused {
  ok: false
  code: LeaseRefusalCode
  wording: string
}

export type PromptWriteResult = PromptWriteOk | PromptWriteRefused

/* ----------------------------- 纯归一与校验 ----------------------------- */

function readText(value: LooseValue): string {
  return typeof value === 'string' ? value.trim() : ''
}

function validTime(value: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function refused(code: LeaseRefusalCode): { ok: false; code: LeaseRefusalCode; wording: string } {
  return { ok: false, code, wording: LEASE_WORDING[code] }
}

function normalizeFailed(problem: LeaseProblem): LeaseNormalizeResult {
  return { ok: false, lease: null, problem, reason: problemText(problem) }
}

function decodeFailed(problem: LeaseProblem): LeaseDecodeResult {
  return { ok: false, leases: [], problem, reason: problemText(problem) }
}

function singleDecodeFailed(problem: LeaseProblem): LeaseSingleDecodeResult {
  return { ok: false, lease: null, problem, reason: problemText(problem) }
}

/** 严格归一一条租约：键白名单、版本、类型、正数时刻；不抛异常。 */
export function normalizeLease(raw: RawLease | null | undefined): LeaseNormalizeResult {
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    return normalizeFailed('E_LEASE_SHAPE')
  }
  for (const key of Object.keys(raw)) {
    if (LEASE_FIELDS.indexOf(key) < 0) return normalizeFailed('E_LEASE_UNKNOWN_FIELD')
  }
  if (typeof raw.v !== 'number' || raw.v !== LEASE_ENVELOPE_VERSION) return normalizeFailed('E_LEASE_V')
  const sessionId = readText(raw.sessionId)
  if (sessionId === '') return normalizeFailed('E_LEASE_SESSION_ID')
  const instanceId = readText(raw.instanceId)
  if (instanceId === '') return normalizeFailed('E_LEASE_INSTANCE_ID')
  const owner = readText(raw.owner)
  if (owner === '') return normalizeFailed('E_LEASE_OWNER')
  const ttlSec = typeof raw.ttlSec === 'number' ? raw.ttlSec : Number.NaN
  if (!validTime(ttlSec)) return normalizeFailed('E_LEASE_TTL_SEC')
  const expiresAt = typeof raw.expiresAt === 'number' ? raw.expiresAt : Number.NaN
  if (!validTime(expiresAt)) return normalizeFailed('E_LEASE_EXPIRES_AT')
  const headSha = readText(raw.headSha)
  if (headSha === '') return normalizeFailed('E_LEASE_HEAD_SHA')
  // 固定键顺序返回，杜绝调用方拿到共享可变引用或额外字段。
  return {
    ok: true,
    lease: {
      v: LEASE_ENVELOPE_VERSION,
      sessionId,
      instanceId,
      owner,
      ttlSec: Math.trunc(ttlSec),
      expiresAt: Math.trunc(expiresAt),
      headSha,
    },
    problem: null,
    reason: '',
  }
}

/** 一条租约是否结构合法（坏字段 / 未知字段 / 错版本都视为无租约）。 */
export function leaseIsValid(lease: SessionLease | null | undefined): boolean {
  return normalizeLease(lease as RawLease | null | undefined).ok
}

/** 合法租约在 nowMs 是否过期；非法 nowMs 按「无法证明未过期」处理（调用方据此只读）。 */
export function leaseIsExpired(lease: SessionLease, nowMs: number): boolean {
  return !validTime(nowMs) || nowMs >= lease.expiresAt
}

/** 过期且属于 caller 的租约才是「可宣告回收的那一条」（用于单元断言）。 */
export function expiredReclaimable(
  lease: SessionLease | null | undefined,
  owner: string,
  nowMs: number,
): boolean {
  if (!leaseIsValid(lease) || lease === null || lease === undefined) return false
  if (lease.owner !== owner) return false
  return validTime(nowMs) && nowMs >= lease.expiresAt
}

/** 深拷贝（固定键顺序，不共享引用）。 */
export function copyLease(lease: SessionLease): SessionLease {
  return {
    v: LEASE_ENVELOPE_VERSION,
    sessionId: lease.sessionId,
    instanceId: lease.instanceId,
    owner: lease.owner,
    ttlSec: lease.ttlSec,
    expiresAt: lease.expiresAt,
    headSha: lease.headSha,
  }
}

/* ----------------------------- 纯决策 ----------------------------- */

/**
 * 租约分类：坏租约 / 过期 ⇒ FREE（过期仍可由 claim 报 reclaimed）；
 * 他人未过期 ⇒ OBSERVING；本人未过期 ⇒ HELD。CLAIMING 是提交瞬时态，不在此返回。
 */
export function classifyLease(
  lease: SessionLease | null | undefined,
  owner: string,
  nowMs: number,
): LeaseState {
  if (!leaseIsValid(lease) || lease === null || lease === undefined) return 'FREE'
  // 无法证明已过期时按 OBSERVING（只读），绝不因为时钟非法而抢租约。
  if (!validTime(nowMs)) return 'OBSERVING'
  if (nowMs >= lease.expiresAt) return 'FREE'
  return lease.owner === owner ? 'HELD' : 'OBSERVING'
}

/** 只考虑同一 sessionId 的租约（store 以 sessionId 为键）。 */
function relevantLease(lease: SessionLease | null | undefined, sessionId: string): SessionLease | null {
  if (!leaseIsValid(lease) || lease === null || lease === undefined) return null
  return lease.sessionId === sessionId ? lease : null
}

/**
 * 抢租约：FREE 可抢、过期可接管（reclaimed=true）、OBSERVING 绝不能抢；
 * 同 owner 未过期时是幂等 no-op（返回原租约，不借机续期——续期只走 heartbeat）。
 */
export function claim(lease: SessionLease | null | undefined, req: ClaimRequest): ClaimResult {
  if (!req || !validTime(req.nowMs) || !validTime(req.ttlSec)) return refused('E_LEASE_NOT_HELD')
  const current = relevantLease(lease, req.sessionId)
  const requested: SessionLease = {
    v: LEASE_ENVELOPE_VERSION,
    sessionId: req.sessionId,
    instanceId: req.instanceId,
    owner: req.owner,
    ttlSec: Math.trunc(req.ttlSec),
    expiresAt: Math.trunc(req.nowMs) + Math.trunc(req.ttlSec),
    headSha: req.headSha,
  }
  const normalized = normalizeLease(requested)
  if (!normalized.ok || normalized.lease === null) return refused('E_LEASE_NOT_HELD')

  const state = classifyLease(current, req.owner, req.nowMs)
  if (state === 'OBSERVING' || state === 'CLAIMING') return refused('E_LEASE_OBSERVING')
  if (state === 'HELD' && current !== null) {
    return { ok: true, lease: copyLease(current), reclaimed: false }
  }
  const reclaimed = current !== null && leaseIsExpired(current, req.nowMs)
  return { ok: true, lease: normalized.lease, reclaimed }
}

/**
 * 心跳：本模块隐含的调用方就是 dots，因此只有 `lease.owner === 'dots'` 才能续期；
 * 他人租约一律拒绝（未过期 OBSERVING，已过期 NOT_HELD），过期租约必须重新 claim。
 */
export function heartbeat(
  lease: SessionLease | null | undefined,
  nowMs: number,
  ttlSec: number,
): HeartbeatResult {
  if (!leaseIsValid(lease) || lease === null || lease === undefined) return refused('E_LEASE_NOT_HELD')
  if (lease.owner !== PRINCIPAL_DOTS) {
    return refused(validTime(nowMs) && nowMs < lease.expiresAt ? 'E_LEASE_OBSERVING' : 'E_LEASE_NOT_HELD')
  }
  if (!validTime(nowMs) || nowMs >= lease.expiresAt) return refused('E_LEASE_EXPIRED')
  if (!validTime(ttlSec)) return refused('E_LEASE_NOT_HELD')
  const beat: SessionLease = copyLease(lease)
  beat.ttlSec = Math.trunc(ttlSec)
  beat.expiresAt = Math.trunc(nowMs) + Math.trunc(ttlSec)
  return { ok: true, lease: beat }
}

/**
 * 释放：只有 owner 本人（且本模块只处理 dots 租约）能释放；结果 null = 已无租约。
 * 空租约释放是幂等 no-op；他人 / 坏租约 typed 拒绝。
 */
export function release(
  lease: SessionLease | null | undefined,
  owner: string,
): ReleaseResult {
  if (lease === null || lease === undefined) return { ok: true, lease: null }
  if (!leaseIsValid(lease)) return refused('E_LEASE_NOT_HELD')
  // release 没有 nowMs 入参，无法判断他人租约是否过期；一律按「非本人持有」拒绝。
  if (owner !== PRINCIPAL_DOTS || lease.owner !== owner) return refused('E_LEASE_NOT_HELD')
  return { ok: true, lease: null }
}

/**
 * 发布 prompt 前的最后一道闸：顺序 = 无租约/非本人 → NOT_HELD；他人未过期 → OBSERVING；
 * 本人已过期 → EXPIRED；头锚不符 → HEAD_MOVED；否则 ok。
 *
 * **dots-only 硬闸**：`owner !== 'dots'` 时无论租约怎样都不授予（永远 OBSERVING 或 NOT_HELD），
 * 因为 dots 绝不写人正开着的会话。即使拿到了租约，头锚不符仍必须 fail-closed 拒绝，
 * 租约本身不构成覆盖并发写入的许可。
 */
export function decidePromptWrite(
  lease: SessionLease | null | undefined,
  req: PromptWriteRequest,
): PromptWriteResult {
  if (!req || req.owner !== PRINCIPAL_DOTS) {
    const live = !!req && leaseIsValid(lease) && lease !== null && lease !== undefined
      && validTime(req.nowMs) && req.nowMs < lease.expiresAt
    return refused(live ? 'E_LEASE_OBSERVING' : 'E_LEASE_NOT_HELD')
  }
  if (!leaseIsValid(lease) || lease === null || lease === undefined) return refused('E_LEASE_NOT_HELD')
  if (lease.owner !== req.owner) {
    return refused(validTime(req.nowMs) && req.nowMs < lease.expiresAt ? 'E_LEASE_OBSERVING' : 'E_LEASE_NOT_HELD')
  }
  if (!validTime(req.nowMs) || req.nowMs >= lease.expiresAt) return refused('E_LEASE_EXPIRED')
  if (typeof req.expectedPrevSha !== 'string' || req.expectedPrevSha === ''
      || typeof req.actualHeadSha !== 'string' || req.actualHeadSha === ''
      || req.expectedPrevSha !== req.actualHeadSha) {
    return refused('E_HEAD_MOVED')
  }
  return { ok: true }
}

/* ----------------------------- 信封编解码 ----------------------------- */

interface LeaseEnvelope {
  v: number
  items: SessionLease[]
}

/** 确定性排序（不用 localeCompare，免得随系统 locale 变）。 */
export function sortLeases(list: SessionLease[]): SessionLease[] {
  return list.slice().sort((a, b) => {
    if (a.sessionId < b.sessionId) return -1
    if (a.sessionId > b.sessionId) return 1
    if (a.instanceId < b.instanceId) return -1
    if (a.instanceId > b.instanceId) return 1
    if (a.owner < b.owner) return -1
    if (a.owner > b.owner) return 1
    return 0
  })
}

/** 单条租约序列化（固定键顺序）；坏输入抛 typed 错，不静默产出脏字节。 */
export function encodeLease(lease: SessionLease): string {
  const result = normalizeLease(lease)
  if (!result.ok || result.lease === null) throw new Error(`[lease] ${result.problem}: ${result.reason}`)
  return JSON.stringify(result.lease)
}

/** 整表序列化（{v:1,items}，固定键顺序 + 确定性排序）；任一坏记录即拒绝。 */
export function encodeLeases(list: SessionLease[]): string {
  if (!Array.isArray(list)) throw new Error(`[lease] ${problemText('E_LEASE_ENVELOPE_SHAPE')}`)
  const items: SessionLease[] = []
  for (const item of list) {
    const result = normalizeLease(item)
    if (!result.ok || result.lease === null) throw new Error(`[lease] ${result.problem}: ${result.reason}`)
    items.push(result.lease)
  }
  const envelope: LeaseEnvelope = { v: LEASE_ENVELOPE_VERSION, items: sortLeases(items) }
  return JSON.stringify(envelope)
}

/** 单条租约反序列化：坏 JSON / 坏记录 ⇒ null + typed problem，不抛。 */
export function decodeLease(raw: string | null | undefined): LeaseSingleDecodeResult {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') return singleDecodeFailed('E_LEASE_ENVELOPE_EMPTY')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return singleDecodeFailed('E_LEASE_ENVELOPE_JSON')
  }
  const result = normalizeLease(parsed as RawLease)
  if (!result.ok || result.lease === null) return singleDecodeFailed(result.problem ?? 'E_LEASE_SHAPE')
  return { ok: true, lease: result.lease, problem: null, reason: '' }
}

/**
 * 整表反序列化：空串 / 坏 JSON / 结构错 / 版本错 / 任一记录坏 ⇒ 空表 + typed problem。
 * 合法记录按 sessionId 去重（expiresAt 更大者胜，同刻 headSha 字典序大者胜）。不抛异常。
 */
export function decodeLeases(raw: string | null | undefined): LeaseDecodeResult {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') return decodeFailed('E_LEASE_ENVELOPE_EMPTY')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return decodeFailed('E_LEASE_ENVELOPE_JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return decodeFailed('E_LEASE_ENVELOPE_SHAPE')
  }
  const envelope = parsed as Partial<LeaseEnvelope>
  if (typeof envelope.v !== 'number' || !Number.isFinite(envelope.v)) return decodeFailed('E_LEASE_ENVELOPE_SHAPE')
  if (envelope.v !== LEASE_ENVELOPE_VERSION) return decodeFailed('E_LEASE_ENVELOPE_VERSION')
  if (!Array.isArray(envelope.items)) return decodeFailed('E_LEASE_ENVELOPE_SHAPE')
  const items: SessionLease[] = []
  for (const rawItem of envelope.items as LooseValue[]) {
    const result = normalizeLease(rawItem as RawLease)
    if (!result.ok || result.lease === null) return decodeFailed('E_LEASE_ENVELOPE_ITEM')
    const winner = result.lease
    const at = items.findIndex((item) => item.sessionId === winner.sessionId)
    if (at < 0) {
      items.push(winner)
    } else if (winner.expiresAt > items[at]!.expiresAt
      || (winner.expiresAt === items[at]!.expiresAt && winner.headSha > items[at]!.headSha)) {
      items[at] = winner
    }
  }
  return { ok: true, leases: sortLeases(items), problem: null, reason: '' }
}
