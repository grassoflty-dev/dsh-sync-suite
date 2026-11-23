/**
 * mod-plugin-session-prompt：DARK 的 sessionPrompt 服务编排（插件侧，零 RPC 实现细节）。
 *
 * 本模块**没有投递实现**：`DeliveryPort` 缺省缺席，生产构造下每一步都会诚实拒绝
 * `E_SESSION_UNAVAILABLE`；绝不发明 DSH 会话 API、绝不返回假 seq / 假成功。
 *
 * 操作员标记文件只读：`channel-verified.json` 由操作员在带外写入，载荷
 * `{verifiedAt, instanceId, leafSha256, verifier}`；本服务只 `readFileSync`，从不写它。
 * 缺失 / 坏载荷 / 标记实例与请求实例不符 ⇒ `channelVerified(instanceId): false`，
 * 且 `send()` 在任何其它依赖被触碰之前短路。
 *
 * 响应永远只有 `{seq, sha256, accepted}`：指令正文与 lease owner 不进返回体。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { SyncError } from '../engine/errors.js'
import { statePaths } from '../engine/paths.js'
import { INSTANCE_ID_PATTERN, TOOL_SESSION_PROMPT } from './grants.js'
import { decideSessionPrompt } from './promptGate.js'
import { createLeaseStore } from './leaseStore.js'
import type { LeaseStore } from './leaseStore.js'
import { createPromptLedger } from './promptLedger.js'
import type { PromptLedgerStore } from './promptLedger.js'
import { PROMPT_ERROR_CODES, promptRefusal } from './promptWording.js'

const MARKER_FILE = 'channel-verified.json'
const LEASE_FILE = 'session-leases.json'
const LEDGER_FILE = 'prompt-ledger.json'

/** 注入式的实例查询（生产由 InstanceRegistry 满足；测试可用 spy）。 */
export interface PromptInstanceLookup {
  get(id: string): { id: string } | null
}

/** 注入式的授权查询（只看显式 command 工具）。 */
export interface PromptGrantCheck {
  isGranted(instanceId: string, tool: string, nowMs?: number): boolean
}

export interface PromptSendRequest {
  sessionId: string
  instanceId: string
  requestId: string
  text: string
  expectedPrevSha: string
  leaseOwner: string
}

export interface PromptDeliveryResult {
  seq: number
  sha256: string
  accepted: boolean
}

/** 真实会话写入端口——本轮**缺省不存在**；下一模块才提供实现。 */
export interface DeliveryPort {
  send(request: PromptSendRequest): Promise<PromptDeliveryResult>
}

/** 当前头锚读取端口；缺省时用已保存租约的 headSha，没有租约就是空串（fail-closed）。 */
export interface HeadReaderPort {
  readHeadSha(request: { instanceId: string; sessionId: string }): Promise<string>
}

export interface SessionPromptServiceOptions {
  /** 操作员标记的注入路径（测试指向临时目录；缺省为插件状态目录）。 */
  markerPath?: string
  homeDir?: string
  now?: () => number
  instances?: PromptInstanceLookup
  grants?: PromptGrantCheck
  leases?: LeaseStore
  ledger?: PromptLedgerStore
  /** 本轮生产缺省 undefined ⇒ session.unavailable。 */
  delivery?: DeliveryPort | null
  headReader?: HeadReaderPort | null
}

export interface SessionPromptService {
  readonly markerPath: string
  /**
   * 只读解析操作员标记，并**绑定到请求实例**：任何异常 / 坏载荷 / 空实例 id / 标记实例不符
   * 都当 false，永不写文件。标记(instanceId/leafSha256)只断言那一个实例的通道。
   */
  channelVerified(instanceId: string): boolean
  send(request: PromptSendRequest): Promise<PromptDeliveryResult>
}

const MARKER_FIELDS = ['verifiedAt', 'instanceId', 'leafSha256', 'verifier']

/** 严格校验标记载荷；未知字段 / 坏类型 / 坏形状一律 false。 */
export function validChannelMarker(raw: unknown): boolean {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return false
  const item = raw as Record<string, unknown>
  for (const key of Object.keys(item)) if (MARKER_FIELDS.indexOf(key) < 0) return false
  if (typeof item.verifiedAt !== 'number' || !Number.isFinite(item.verifiedAt) || item.verifiedAt <= 0) return false
  if (typeof item.instanceId !== 'string' || !INSTANCE_ID_PATTERN.test(item.instanceId)) return false
  if (typeof item.leafSha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(item.leafSha256)) return false
  if (typeof item.verifier !== 'string' || item.verifier.trim() === '') return false
  return true
}

function refusal(key: 'channel.desktop.unverified' | 'instance.unknown' | 'session.unavailable'): SyncError {
  const typed = promptRefusal(key)
  return new SyncError(typed.code, typed.wording, { key: typed.key })
}

function projectDelivery(raw: PromptDeliveryResult | null | undefined): PromptDeliveryResult {
  const item = raw as Partial<PromptDeliveryResult> | null | undefined
  const seq = typeof item?.seq === 'number' && Number.isFinite(item.seq) && item.seq >= 0 ? Math.trunc(item.seq) : 0
  const sha256 = typeof item?.sha256 === 'string' ? item.sha256 : ''
  return { seq, sha256, accepted: item?.accepted === true }
}

export function createSessionPromptService(options: SessionPromptServiceOptions = {}): SessionPromptService {
  const root = statePaths(options.homeDir).root
  const markerPath = options.markerPath ?? path.join(root, MARKER_FILE)
  const now = options.now ?? ((): number => Date.now())
  const instances = options.instances ?? { get: (): null => null }
  const grants = options.grants ?? { isGranted: (): boolean => false }
  const leases = options.leases ?? createLeaseStore({ filePath: path.join(root, LEASE_FILE), now })
  const ledger = options.ledger ?? createPromptLedger({ filePath: path.join(root, LEDGER_FILE), now })
  const delivery = options.delivery ?? null
  const headReader = options.headReader ?? null

  function channelVerified(instanceId: string): boolean {
    // 没有可用实例 id ⇒ 连文件都不读，直接按通道未验证拒绝（绝不走形状错误路径）。
    if (typeof instanceId !== 'string' || instanceId.trim() === '') return false
    let text: string
    try {
      text = readFileSync(markerPath, 'utf8')
    } catch {
      return false
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return false
    }
    if (!validChannelMarker(parsed)) return false
    // 精确字符串比较：为实例 B 写的标记绝不授权实例 A。
    return (parsed as { instanceId: string }).instanceId === instanceId.trim()
  }

  async function send(request: PromptSendRequest): Promise<PromptDeliveryResult> {
    const instanceId = typeof request.instanceId === 'string' ? request.instanceId.trim() : ''
    // 标记缺失 / 绑定实例不符 / 空实例 id ⇒ 在任何其它依赖（grant / 租约 / 账本 / 端口）
    // 被触碰之前拒绝，且保持 E_CHANNEL_UNVERIFIED（不泄漏形状信息）。
    if (!channelVerified(instanceId)) throw refusal('channel.desktop.unverified')

    const nowMs = now()
    if (instances.get(instanceId) === null) throw refusal('instance.unknown')

    const granted = grants.isGranted(instanceId, TOOL_SESSION_PROMPT, nowMs)
    const leaseState = await leases.load()
    const lease = leaseState.leases.find((item) => item.sessionId === request.sessionId) ?? null
    const ledgerState = await ledger.load()
    const head = headReader !== null
      ? await headReader.readHeadSha({ instanceId, sessionId: request.sessionId })
      : (lease?.headSha ?? '')

    const decision = decideSessionPrompt({
      text: request.text,
      requestId: request.requestId,
      sessionId: request.sessionId,
      instanceId,
      expectedPrevSha: request.expectedPrevSha,
      actualHeadSha: head,
      nowMs,
      channelVerified: true,
      granted,
      lease,
      ledger: ledgerState.view,
      deliveryAvailable: delivery !== null,
      declaredLeaseOwner: request.leaseOwner,
    })
    if (!decision.ok) {
      throw new SyncError(decision.code, decision.wording, { key: decision.key })
    }

    // 先持久化租约与 requestId，再调用端口（幂等账本在端口调用前记录）。
    await leases.upsert(decision.claim.lease)
    await ledger.record(request.sessionId, request.requestId, nowMs)

    // 双保险：gate 已检查过，这里再挡一次，避免端口晚卸载时假成功。
    if (delivery === null) throw refusal('session.unavailable')
    const delivered = await delivery.send({
      sessionId: request.sessionId,
      instanceId,
      requestId: request.requestId,
      text: request.text,
      expectedPrevSha: request.expectedPrevSha,
      leaseOwner: request.leaseOwner,
    })
    return projectDelivery(delivered)
  }

  return { markerPath, channelVerified, send }
}

/** 供 RPC 层做入参形状检查时复用（DARK 纪律：码与文案不另造）。 */
export const DARK_MARKER_CODE = PROMPT_ERROR_CODES.CHANNEL_UNVERIFIED
