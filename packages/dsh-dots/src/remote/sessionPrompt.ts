/**
 * mod-plugin-session-prompt：DARK 的 sessionPrompt 服务编排（插件侧，零 RPC 实现细节）。
 *
 * 本轮仍**没有真实投递通道**：生产缺省挂载 `createUnavailableDeliveryPort()`，它会拒绝
 * `E_SESSION_UNAVAILABLE` 且完全不读请求正文 / owner；绝不发明 DSH 会话 API、绝不返回假成功。
 *
 * 幂等策略 = **record-on-success**：只有投递成功（port 返回 ok:true）之后才把 (sessionId,
 * requestId) 写进账本。这样投递失败 / 拒绝不会污染账本，同一请求号可以安全重试；代价是
 * 「已投递成功但账本写失败」这个窗口无法靠重放自动收敛——因此单独返回 `E_SESSION_RECORD_FAILED`
 * 明确要求先刷新会话确认、勿盲目重发。单进程 + 已 HELD 租约把并发在飞窗口压到最小，
 * 但账本写失败时绝不假定「没写入」，这是有意保留的诚实警告而不是静默成功。
 *
 * 操作员标记文件只读：`channel-verified.json` 由操作员在带外写入，载荷
 * `{verifiedAt, instanceId, leafSha256, verifier}`；本服务只 `readFileSync`，从不写它。
 * 通道判定是三态：verified / unverified / leaf-mismatch —— 标记必须绑定到请求实例
 * 且指纹与该实例当前叶证书 pin 完全一致；没有 pin 绝不 TOFU。任何拒绝都发生在
 * 其它依赖被触碰之前。
 *
 * 响应永远只有 `{seq, sha256, accepted}`：指令正文与 lease owner 不进返回体。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { SyncError } from '../engine/errors.js'
import { statePaths } from '../engine/paths.js'
import { defaultDeviceId } from '../engine/settings.js'
import { INSTANCE_ID_PATTERN, TOOL_SESSION_PROMPT } from './grants.js'
import { normalisePairingFingerprint } from './pairingPayload.js'
import { RemoteStore } from './store.js'
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

/**
 * 端口的可判别结果：成功只给 seq/sha256；失败只给两个 typed 码与可选原因，
 * **没有任何 prompt / leaseOwner 字段可从类型上进结果**。
 */
export type DeliveryOutcome =
  | { ok: true; seq: number; sha256: string }
  | { ok: false; code: 'E_SESSION_UNAVAILABLE' | 'E_SESSION_DELIVERY_FAILED'; reason?: string }

/** 真实会话写入端口（本轮生产缺省为「无通道」实现）。 */
export interface DeliveryPort {
  send(request: PromptSendRequest): Promise<DeliveryOutcome>
}

/**
 * 生产缺省投递端口：没有真实 transport，固定拒绝 E_SESSION_UNAVAILABLE。
 * 刻意不读 request 的任何字段——正文 / owner 不被触碰、不进日志、不进 reason、不回显。
 */
export function createUnavailableDeliveryPort(): DeliveryPort {
  return {
    async send(): Promise<DeliveryOutcome> {
      return { ok: false, code: 'E_SESSION_UNAVAILABLE', reason: '未接入投递通道' }
    },
  }
}

/** 当前头锚读取端口；缺省时用已保存租约的 headSha，没有租约就是空串（fail-closed）。 */
export interface HeadReaderPort {
  readHeadSha(request: { instanceId: string; sessionId: string }): Promise<string>
}

/** 通道三态：verified / unverified（从未验证或无 pin 可绑）/ leaf-mismatch（验证过但证书已换）。 */
export type ChannelState = 'verified' | 'unverified' | 'leaf-mismatch'

/** 每实例当前叶证书指纹来源（注入；绝不 TOFU 补 pin）。 */
export interface PinLookup {
  lookup(instanceId: string): { fingerprint: string } | null
}

/**
 * 生产缺省 pin 源：惰性读取插件自己的配对证书（`remote-pairing-cert.json`），
 * 只针对本机 instanceId；不写、不迁移、不缓存，证书轮换在下一次调用即可被观察到。
 * 测试一律注入 PinLookup，不会碰到任何 live 状态。
 */
export function createPairingPinLookup(options: { homeDir?: string } = {}): PinLookup {
  return {
    lookup(instanceId: string): { fingerprint: string } | null {
      if (typeof instanceId !== 'string' || instanceId.trim() === '') return null
      if (instanceId !== defaultDeviceId()) return null
      try {
        const cert = new RemoteStore({ homeDir: options.homeDir }).readCert()
        if (cert === null || typeof cert.fingerprint !== 'string') return null
        return { fingerprint: cert.fingerprint }
      } catch {
        return null
      }
    },
  }
}

export interface SessionPromptServiceOptions {
  /** 每实例叶证书指纹来源（测试注入；缺省为惰性读取本机配对证书）。 */
  pins?: PinLookup
  /** 操作员标记的注入路径（测试指向临时目录；缺省为插件状态目录）。 */
  markerPath?: string
  homeDir?: string
  now?: () => number
  instances?: PromptInstanceLookup
  grants?: PromptGrantCheck
  leases?: LeaseStore
  ledger?: PromptLedgerStore
  /**
   * 投递端口；undefined ⇒ 生产缺省 `createUnavailableDeliveryPort()`，
   * 显式 null ⇒ 连端口都没挂（gate 的 session.unavailable）。
   */
  delivery?: DeliveryPort | null
  headReader?: HeadReaderPort | null
}

export interface SessionPromptService {
  readonly markerPath: string
  /**
   * 三态通道判定：标记坏 / 空实例 / 跨实例 / 没有该实例的 pin 都返回 'unverified'；
   * pin 存在但与标记指纹不同返回 'leaf-mismatch'；完全相同才 'verified'。绝不 TOFU 补 pin。
   */
  channelState(instanceId: string): ChannelState
  /** 兼容旧调用的薄封装：仅 'verified' 为真。 */
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
  // 指纹形状：接受大小写与冒号分隔，走与配对载荷同一个归一函数（不另造第二套）。
  if (!normalisePairingFingerprint(item.leafSha256).ok) return false
  if (typeof item.verifier !== 'string' || item.verifier.trim() === '') return false
  return true
}

/** 归一为裸大写 hex（无冒号）；非法输入返回空串，调用方按「无可用 pin / 坏标记」处理。 */
export function bareFingerprint(raw: unknown): string {
  const result = normalisePairingFingerprint(raw)
  return result.ok ? result.value.replace(/:/g, '') : ''
}

function refusal(
  key: 'channel.desktop.unverified' | 'channel.desktop.leafMismatch' | 'instance.unknown'
    | 'session.unavailable' | 'session.deliveryFailed' | 'session.recordFailed',
): SyncError {
  const typed = promptRefusal(key)
  return new SyncError(typed.code, typed.wording, { key: typed.key })
}

/** 成功结果白名单投影：只取 seq / sha256，accepted 恒 true，绝不回显正文或 owner。 */
function projectDelivery(raw: Extract<DeliveryOutcome, { ok: true }>): PromptDeliveryResult {
  const seq = typeof raw.seq === 'number' && Number.isFinite(raw.seq) && raw.seq >= 0 ? Math.trunc(raw.seq) : -1
  const sha256 = typeof raw.sha256 === 'string' && raw.sha256.trim() !== '' ? raw.sha256 : ''
  return { seq, sha256, accepted: seq >= 0 && sha256 !== '' }
}

export function createSessionPromptService(options: SessionPromptServiceOptions = {}): SessionPromptService {
  const root = statePaths(options.homeDir).root
  const markerPath = options.markerPath ?? path.join(root, MARKER_FILE)
  const now = options.now ?? ((): number => Date.now())
  const instances = options.instances ?? { get: (): null => null }
  const grants = options.grants ?? { isGranted: (): boolean => false }
  const pins = options.pins ?? createPairingPinLookup({ homeDir: options.homeDir })
  const leases = options.leases ?? createLeaseStore({ filePath: path.join(root, LEASE_FILE), now })
  const ledger = options.ledger ?? createPromptLedger({ filePath: path.join(root, LEDGER_FILE), now })
  // undefined ⇒ 生产缺省「无通道」端口；显式 null 才表示连端口都未挂载。
  const delivery: DeliveryPort | null = options.delivery === undefined
    ? createUnavailableDeliveryPort()
    : options.delivery
  const headReader = options.headReader ?? null

  function channelState(instanceId: string): ChannelState {
    // 没有可用实例 id ⇒ 连文件都不读，直接按通道未验证拒绝（绝不走形状错误路径）。
    if (typeof instanceId !== 'string' || instanceId.trim() === '') return 'unverified'
    let text: string
    try {
      text = readFileSync(markerPath, 'utf8')
    } catch {
      return 'unverified'
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return 'unverified'
    }
    if (!validChannelMarker(parsed)) return 'unverified'
    const marker = parsed as { instanceId: string; leafSha256: string }
    // 精确字符串比较：为实例 B 写的标记绝不授权实例 A。
    if (marker.instanceId !== instanceId.trim()) return 'unverified'
    // 没有该实例的 pin ⇒ 从未验证（绝不 TOFU 把标记里的指纹当作 pin）。
    // pin 源可能抛（注入的实现 / 存储故障）：通道判定必须全函数，任何异常都只是
    // 「无法证明已验证」⇒ unverified，绝不冒出第五种状态或假 verified。
    let pinHex = ''
    try {
      const pin = pins.lookup(instanceId.trim())
      pinHex = bareFingerprint(pin?.fingerprint)
    } catch {
      return 'unverified'
    }
    if (pinHex === '') return 'unverified'
    return bareFingerprint(marker.leafSha256) === pinHex ? 'verified' : 'leaf-mismatch'
  }

  function channelVerified(instanceId: string): boolean {
    return channelState(instanceId) === 'verified'
  }

  async function send(request: PromptSendRequest): Promise<PromptDeliveryResult> {
    const instanceId = typeof request.instanceId === 'string' ? request.instanceId.trim() : ''
    // 三态通道闸在任何其它依赖（实例查询 / grant / 租约 / 账本 / 端口）被触碰之前短路。
    const state = channelState(instanceId)
    if (state === 'leaf-mismatch') throw refusal('channel.desktop.leafMismatch')
    if (state !== 'verified') throw refusal('channel.desktop.unverified')

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

    // 投递前只持久化租约（本地写者身份）；requestId **刻意不写账本**（record-on-success）。
    await leases.upsert(decision.claim.lease)

    // 双保险：gate 已检查过，这里再挡一次，避免端口晚卸载时假成功。
    if (delivery === null) throw refusal('session.unavailable')

    let outcome: DeliveryOutcome
    try {
      outcome = await delivery.send({
        sessionId: request.sessionId,
        instanceId,
        requestId: request.requestId,
        text: request.text,
        expectedPrevSha: request.expectedPrevSha,
        leaseOwner: request.leaseOwner,
      })
    } catch {
      // 端口抛错 ⇒ 已尝试投递但失败；绝不原样冒出，也绝不误判成前置拒绝或成功。
      throw refusal('session.deliveryFailed')
    }
    if (outcome === null || typeof outcome !== 'object' || outcome.ok !== true) {
      const code = outcome !== null && typeof outcome === 'object' ? (outcome as { code?: unknown }).code : undefined
      if (code === 'E_SESSION_UNAVAILABLE') throw refusal('session.unavailable')
      // 任何其它 code（含自由文本 / 未知码 / 空值）一律 fail-closed 到 deliveryFailed。
      throw refusal('session.deliveryFailed')
    }
    const result = projectDelivery(outcome)
    if (!result.accepted) throw refusal('session.deliveryFailed')

    // record-on-success：只在投递成功后落账；写失败是独立的 typed 警告，不静默。
    try {
      const recorded = await ledger.record(request.sessionId, request.requestId, nowMs)
      if (!recorded.ok) throw refusal('session.recordFailed')
    } catch (error) {
      if (error instanceof SyncError && error.code === 'E_SESSION_RECORD_FAILED') throw error
      throw refusal('session.recordFailed')
    }
    return result
  }

  return { markerPath, channelState, channelVerified, send }
}

/** 供 RPC 层做入参形状检查时复用（DARK 纪律：码与文案不另造）。 */
export const DARK_MARKER_CODE = PROMPT_ERROR_CODES.CHANNEL_UNVERIFIED
