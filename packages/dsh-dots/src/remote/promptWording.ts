/**
 * mod-plugin-session-prompt：发指令拒绝文案的**语义键表**（插件侧唯一事实源）。
 *
 * 逐字来源：`docs/REFUSAL-WORDING.md`（19 行 join 表）。`PROMPT_SEMANTIC_KEYS` 只列 gate 层的
 * 7 个键；通道指纹状态键与两个投递结果键由 `PromptSemanticKey` 联合类型显式补入。
 * 租约四码继续用 `lease.ts` 的 `LEASE_WORDING`，**绝不**在这里复制第二份。
 *
 * 为什么按语义键而不是按错误码索引：同一个 E_VALIDATION 要承载 text.empty 与 text.tooLong
 * 两条不同文案；按码索引会丢信息。码由 `PROMPT_CODE_BY_KEY` 单一映射给出。
 *
 * 纪律：文案不含 token / URL / 路径 / 十六进制串；没有 console，没有 IO。
 */
import { LEASE_WORDING } from './lease.js'
import type { LeaseRefusalCode } from './lease.js'

/** 指令正文上限（字符）；与 App `COMMAND_TEXT_LIMIT` 逐字对齐（2000）。 */
export const PROMPT_TEXT_LIMIT = 2000

/** 幂等去重窗口：同一 sessionId 内同一个 requestId 10 分钟内只处理一次。 */
export const PROMPT_IDEMPOTENCY_WINDOW_MS = 10 * 60 * 1000

/** 本模块默认租约 TTL（秒）：与 CHAT-SYNC §2.2 的 10 分钟一致。 */
export const PROMPT_LEASE_TTL_SEC = 600

export const PROMPT_ERROR_CODES = {
  VALIDATION: 'E_VALIDATION',
  GRANT_DENIED: 'E_GRANT_DENIED',
  CHANNEL_UNVERIFIED: 'E_CHANNEL_UNVERIFIED',
  CHANNEL_LEAF_MISMATCH: 'E_CHANNEL_LEAF_MISMATCH',
  PROMPT_DUPLICATE: 'E_PROMPT_DUPLICATE',
  INSTANCE_UNKNOWN: 'E_INSTANCE_UNKNOWN',
  SESSION_UNAVAILABLE: 'E_SESSION_UNAVAILABLE',
  SESSION_DELIVERY_FAILED: 'E_SESSION_DELIVERY_FAILED',
  SESSION_RECORD_FAILED: 'E_SESSION_RECORD_FAILED',
} as const

/** gate 层级拒绝的语义键（不含通道指纹状态键，后者由 pin 绑定层单独产生）。 */
export const PROMPT_SEMANTIC_KEYS = [
  'prompt.text.empty',
  'prompt.text.tooLong',
  'prompt.grant.denied',
  'channel.desktop.unverified',
  'prompt.duplicate',
  'instance.unknown',
  'session.unavailable',
] as const

export type PromptSemanticKey =
  | (typeof PROMPT_SEMANTIC_KEYS)[number]
  | 'channel.desktop.leafMismatch'
  | 'session.deliveryFailed'
  | 'session.recordFailed'

export type LeaseSemanticKey = 'lease.notHeld' | 'lease.observing' | 'lease.expired' | 'head.moved'

export type PromptRefusalKey = PromptSemanticKey | LeaseSemanticKey

/** 语义键 → typed 错误码（唯一映射点）。 */
export const PROMPT_CODE_BY_KEY: Readonly<Record<PromptSemanticKey, string>> = {
  'prompt.text.empty': PROMPT_ERROR_CODES.VALIDATION,
  'prompt.text.tooLong': PROMPT_ERROR_CODES.VALIDATION,
  'prompt.grant.denied': PROMPT_ERROR_CODES.GRANT_DENIED,
  'channel.desktop.unverified': PROMPT_ERROR_CODES.CHANNEL_UNVERIFIED,
  'channel.desktop.leafMismatch': PROMPT_ERROR_CODES.CHANNEL_LEAF_MISMATCH,
  'prompt.duplicate': PROMPT_ERROR_CODES.PROMPT_DUPLICATE,
  'instance.unknown': PROMPT_ERROR_CODES.INSTANCE_UNKNOWN,
  'session.unavailable': PROMPT_ERROR_CODES.SESSION_UNAVAILABLE,
  'session.deliveryFailed': PROMPT_ERROR_CODES.SESSION_DELIVERY_FAILED,
  'session.recordFailed': PROMPT_ERROR_CODES.SESSION_RECORD_FAILED,
}

/** 语义键 → 逐字中文（与 REFUSAL-WORDING.md 的插件列逐字节一致）。 */
export const PROMPT_WORDING: Readonly<Record<PromptSemanticKey, string>> = {
  'prompt.text.empty': '请先输入要发送的指令',
  'prompt.text.tooLong': `指令过长（上限 ${PROMPT_TEXT_LIMIT} 字）`,
  'prompt.grant.denied': '该实例未授予发指令权限（查看权限不包含发指令）',
  'channel.desktop.unverified': '该电脑尚未标记安全通道已验证，未发送任何内容',
  'channel.desktop.leafMismatch': '该实例当前证书与标记时的指纹不同（证书已更换），未发送任何内容',
  'prompt.duplicate': '同一条指令已经处理过，未重复写入',
  'instance.unknown': '找不到该实例，请重新配对',
  'session.unavailable': '该会话暂时不可写入（投递通道未接入）',
  'session.deliveryFailed': '投递结果未确认（可能已写入，也可能没有）；用同一请求号重试是安全的（DSH 按请求号去重）',
  'session.recordFailed': '会话已写入但请求记录未落盘，请先刷新会话确认，勿盲目重发',
}

/** 租约四码 → 文档语义键（文案仍取自 LEASE_WORDING，不在本表复制）。 */
export const LEASE_SEMANTIC_KEY_BY_CODE: Readonly<Record<LeaseRefusalCode, LeaseSemanticKey>> = {
  E_LEASE_NOT_HELD: 'lease.notHeld',
  E_LEASE_OBSERVING: 'lease.observing',
  E_LEASE_EXPIRED: 'lease.expired',
  E_HEAD_MOVED: 'head.moved',
}

export interface PromptRefusal {
  ok: false
  key: PromptRefusalKey
  code: string
  wording: string
}

export function promptRefusal(key: PromptSemanticKey): PromptRefusal {
  return { ok: false, key, code: PROMPT_CODE_BY_KEY[key], wording: PROMPT_WORDING[key] }
}

export function leaseRefusal(code: LeaseRefusalCode): PromptRefusal {
  return { ok: false, key: LEASE_SEMANTIC_KEY_BY_CODE[code], code, wording: LEASE_WORDING[code] }
}
