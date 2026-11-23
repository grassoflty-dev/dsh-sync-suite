/**
 * mod-plugin-session-prompt：发指令前置条件的**唯一纯判定层**（零 IO / 零时钟读取 / 零日志）。
 *
 * 固定顺序（每一步都必须在前一步通过后才执行）：
 *   1 通道标记 → 2 显式 command 授权 → 3 正文边界 → 4 租约（绝不 takeover，FREE/过期才 claim）
 *   → 5 头锚乐观锁 → 6 会话内 requestId 幂等 → 7 投递通道可用 → 8 放行。
 * 任一失败返回 `{ok:false,key,code,wording}`（typed，无自由文本）；成功只回 claim 与 requestId，
 * **绝不回显指令正文或 lease owner**。
 */
import { PRINCIPAL_DOTS, claim, leaseIsValid } from './lease.js'
import type { SessionLease } from './lease.js'
import { seenInWindow } from './promptLedger.js'
import type { PromptLedgerView } from './promptLedger.js'
import {
  PROMPT_IDEMPOTENCY_WINDOW_MS,
  PROMPT_LEASE_TTL_SEC,
  PROMPT_TEXT_LIMIT,
  leaseRefusal,
  promptRefusal,
} from './promptWording.js'
import type { PromptRefusal, PromptRefusalKey } from './promptWording.js'

export interface SessionPromptGateInput {
  text: string
  requestId: string
  sessionId: string
  instanceId: string
  expectedPrevSha: string
  actualHeadSha: string
  nowMs: number
  /** 操作员标记文件存在且载荷合法（服务层只读解析，绝不写）。 */
  channelVerified: boolean
  /** 该实例显式授予 session.prompt（view 权永不隐含）。 */
  granted: boolean
  lease: SessionLease | null | undefined
  ledger: PromptLedgerView
  /** 本轮投递端口是否挂载；生产默认 false。 */
  deliveryAvailable: boolean
  /** 请求里声明的 lease owner；缺省不校验，非 dots 一律 NOT_HELD。 */
  declaredLeaseOwner?: string
}

export interface PromptGateClaim {
  lease: SessionLease
  reclaimed: boolean
}

export interface SessionPromptGateOk {
  ok: true
  requestId: string
  claim: PromptGateClaim
}

export type SessionPromptGateResult = SessionPromptGateOk | PromptRefusal

/** 拒绝结果的类型守卫（供服务层把 key 也带进 typed 错误 details）。 */
export function refusalKeyOf(result: SessionPromptGateResult): PromptRefusalKey | null {
  return result.ok ? null : result.key
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * 唯一判定入口。顺序即安全：通道标记永远第一，投递可用性永远倒数第二；
 * 头锚在幂等之前，所以「重复 id + sha 不符」必须报 E_HEAD_MOVED。
 */
export function decideSessionPrompt(input: SessionPromptGateInput): SessionPromptGateResult {
  // 1. 操作员通道标记：缺失 / 非法 ⇒ 一律拒绝，无回退、不记忆上次。
  if (input.channelVerified !== true) return promptRefusal('channel.desktop.unverified')

  // 2. 显式 command 授权；view 权不算。
  if (input.granted !== true) return promptRefusal('prompt.grant.denied')

  // 3. 正文边界（trim 判空，原始长度判上限；与 App 的 2000 字口径一致）。
  const text = textOf(input.text)
  if (text.trim() === '') return promptRefusal('prompt.text.empty')
  if (text.length > PROMPT_TEXT_LIMIT) return promptRefusal('prompt.text.tooLong')

  // 4. 租约：本模块只认 dots principal；未过期他人租约 ⇒ OBSERVING，绝不 takeover。
  //    无租约 / 过期 ⇒ claim（过期接管须把 reclaimed 报给调用方）。
  const nowMs = input.nowMs
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs) || nowMs <= 0) return leaseRefusal('E_LEASE_NOT_HELD')
  if (input.declaredLeaseOwner !== undefined && input.declaredLeaseOwner !== PRINCIPAL_DOTS) {
    return leaseRefusal('E_LEASE_NOT_HELD')
  }
  const current: SessionLease | null = leaseIsValid(input.lease) && input.lease !== null && input.lease !== undefined
    ? input.lease
    : null
  if (current !== null && current.owner !== PRINCIPAL_DOTS && nowMs < current.expiresAt) {
    return leaseRefusal('E_LEASE_OBSERVING')
  }
  // claim 的头锚参数只用于租约结构完整性；真值判定在下一步（含空头锚 ⇒ E_HEAD_MOVED）。
  const headForClaim = textOf(input.actualHeadSha) || 'head-unknown'
  const claimed = claim(current, {
    sessionId: textOf(input.sessionId),
    instanceId: textOf(input.instanceId),
    owner: PRINCIPAL_DOTS,
    ttlSec: PROMPT_LEASE_TTL_SEC,
    headSha: headForClaim,
    nowMs,
  })
  if (!claimed.ok) return leaseRefusal(claimed.code)

  // 5. 乐观锁：租约本身不构成覆盖并发写入的许可。
  const expectedPrevSha = textOf(input.expectedPrevSha).trim()
  const actualHeadSha = textOf(input.actualHeadSha).trim()
  if (expectedPrevSha === '' || actualHeadSha === '' || expectedPrevSha !== actualHeadSha) {
    return leaseRefusal('E_HEAD_MOVED')
  }

  // 6. 幂等：账本按 sessionId 分桶；同 id 在别会话里不算重复。
  const requestId = textOf(input.requestId)
  if (seenInWindow(input.ledger ?? {}, textOf(input.sessionId), requestId, nowMs, PROMPT_IDEMPOTENCY_WINDOW_MS)) {
    return promptRefusal('prompt.duplicate')
  }

  // 7. 投递端口缺席就是缺席（DARK）：给诚实拒绝，绝不冒充成功。
  if (input.deliveryAvailable !== true) return promptRefusal('session.unavailable')

  // 8. 放行：只给 claim 与 requestId；正文 / owner 不进结果。
  return {
    ok: true,
    requestId,
    claim: { lease: claimed.lease, reclaimed: claimed.reclaimed },
  }
}
