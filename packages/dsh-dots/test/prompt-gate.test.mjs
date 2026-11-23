/**
 * mod-plugin-session-prompt：纯前置闸的顺序证明与租约 / 幂等语义。
 * 全部从 dist 导入；零 IO、零 live 状态。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  decideSessionPrompt,
} from '../dist/remote/promptGate.js'
import {
  PROMPT_CODE_BY_KEY,
  PROMPT_ERROR_CODES,
  PROMPT_IDEMPOTENCY_WINDOW_MS,
  PROMPT_LEASE_TTL_SEC,
  PROMPT_SEMANTIC_KEYS,
  PROMPT_TEXT_LIMIT,
  PROMPT_WORDING,
} from '../dist/remote/promptWording.js'
import {
  LEASE_WORDING,
  LEASE_ENVELOPE_VERSION,
} from '../dist/remote/lease.js'
import {
  decodeLedger,
  encodeLedger,
  recordSeen,
  seenInWindow,
} from '../dist/remote/promptLedger.js'

const NOW = 5000
const SHA = 'a'.repeat(64)
const OTHER_SHA = 'b'.repeat(64)
const INSTANCE = 'inst-0123456789abcdef'
const LONG_TEXT = '指'.repeat(PROMPT_TEXT_LIMIT)

function lease(overrides = {}) {
  return {
    v: LEASE_ENVELOPE_VERSION,
    sessionId: 's-1',
    instanceId: INSTANCE,
    owner: 'dots',
    ttlSec: PROMPT_LEASE_TTL_SEC,
    expiresAt: NOW + PROMPT_LEASE_TTL_SEC,
    headSha: SHA,
    ...overrides,
  }
}

function input(overrides = {}) {
  return {
    text: '查一下 pc-b 的会话',
    requestId: 'r-1',
    sessionId: 's-1',
    instanceId: INSTANCE,
    expectedPrevSha: SHA,
    actualHeadSha: SHA,
    nowMs: NOW,
    channelVerified: true,
    granted: true,
    lease: lease(),
    ledger: {},
    deliveryAvailable: true,
    ...overrides,
  }
}

function refusal(overrides) {
  const result = decideSessionPrompt(input(overrides))
  assert.equal(result.ok, false)
  assert.equal(typeof result.key, 'string')
  assert.equal(typeof result.code, 'string')
  assert.equal(typeof result.wording, 'string')
  return result
}

/* ---------------- 常量 ---------------- */

test('C0 常量：文本上限 2000 / 幂等窗口 10 分钟 / 租约 TTL 600 秒', () => {
  assert.equal(PROMPT_TEXT_LIMIT, 2000)
  assert.equal(PROMPT_IDEMPOTENCY_WINDOW_MS, 600_000)
  assert.equal(PROMPT_LEASE_TTL_SEC, 600)
  assert.equal(PROMPT_SEMANTIC_KEYS.length, 7)
})

/* ---------------- 顺序证明（表驱动） ---------------- */

const orderCases = [
  {
    name: 'O1 通道标记永远第一（同时缺 grant / 空正文 / 他人租约 / sha 错 / 重复 / 无投递）',
    overrides: {
      channelVerified: false, granted: false, text: '', lease: lease({ owner: 'pc-a' }),
      expectedPrevSha: OTHER_SHA, ledger: { 's-1': [{ requestId: 'r-1', atMs: NOW - 1 }] },
      deliveryAvailable: false,
    },
    key: 'channel.desktop.unverified',
    code: PROMPT_ERROR_CODES.CHANNEL_UNVERIFIED,
  },
  {
    name: 'O2 通道通过但没显式 command 授权 ⇒ grant.denied（早于正文）',
    overrides: { granted: false, text: '' },
    key: 'prompt.grant.denied',
    code: PROMPT_ERROR_CODES.GRANT_DENIED,
  },
  {
    name: 'O3 空正文（trim 后）⇒ text.empty',
    overrides: { text: '   \n  ' },
    key: 'prompt.text.empty',
    code: PROMPT_ERROR_CODES.VALIDATION,
  },
  {
    name: 'O4 超长正文 ⇒ text.tooLong',
    overrides: { text: '指'.repeat(PROMPT_TEXT_LIMIT + 1) },
    key: 'prompt.text.tooLong',
    code: PROMPT_ERROR_CODES.VALIDATION,
  },
  {
    name: 'O5 他人未过期租约 ⇒ lease.observing（绝不 takeover）',
    overrides: { lease: lease({ owner: 'pc-a', headSha: SHA }) },
    key: 'lease.observing',
    code: 'E_LEASE_OBSERVING',
  },
  {
    name: 'O6 头锚不符优先于幂等（重复 id + sha 错 ⇒ E_HEAD_MOVED）',
    overrides: {
      expectedPrevSha: OTHER_SHA,
      ledger: { 's-1': [{ requestId: 'r-1', atMs: NOW - 1 }] },
    },
    key: 'head.moved',
    code: 'E_HEAD_MOVED',
  },
  {
    name: 'O7 幂等优先于投递可用性（重复 id + 无端口 ⇒ prompt.duplicate）',
    overrides: {
      deliveryAvailable: false,
      ledger: { 's-1': [{ requestId: 'r-1', atMs: NOW - 1 }] },
    },
    key: 'prompt.duplicate',
    code: PROMPT_ERROR_CODES.PROMPT_DUPLICATE,
  },
  {
    name: 'O8 一切通过但投递端口缺席 ⇒ session.unavailable',
    overrides: { deliveryAvailable: false },
    key: 'session.unavailable',
    code: PROMPT_ERROR_CODES.SESSION_UNAVAILABLE,
  },
]

for (const item of orderCases) {
  test(item.name, () => {
    const result = refusal(item.overrides)
    assert.equal(result.key, item.key)
    assert.equal(result.code, item.code)
    const expectedWording = item.key.startsWith('lease.') || item.key === 'head.moved'
      ? LEASE_WORDING[item.code]
      : PROMPT_WORDING[item.key]
    assert.equal(result.wording, expectedWording)
  })
}

/* ---------------- 正文边界 ---------------- */

test('B1 恰好 2000 字放行（不误伤上限）', () => {
  const result = decideSessionPrompt(input({ text: LONG_TEXT }))
  assert.equal(result.ok, true)
  assert.equal(Object.keys(result).sort().join(','), 'claim,ok,requestId')
})

test('B2 非字符串正文按空串拒绝，文案为逐字 prompt.text.empty', () => {
  const result = refusal({ text: undefined })
  assert.equal(result.wording, '请先输入要发送的指令')
})

/* ---------------- 租约 ---------------- */

test('L1 已由 dots 持有 ⇒ 幂等使用，reclaimed=false，租约字节不变', () => {
  const held = lease()
  const result = decideSessionPrompt(input({ lease: held }))
  assert.equal(result.ok, true)
  assert.equal(result.claim.reclaimed, false)
  assert.deepEqual(result.claim.lease, held)
})

test('L2 无租约（FREE）⇒ 自动 claim，reclaimed=false，到期 = now+TTL', () => {
  const result = decideSessionPrompt(input({ lease: null }))
  assert.equal(result.ok, true)
  assert.equal(result.claim.reclaimed, false)
  assert.equal(result.claim.lease.owner, 'dots')
  assert.equal(result.claim.lease.expiresAt, NOW + PROMPT_LEASE_TTL_SEC)
  assert.equal(result.claim.lease.sessionId, 's-1')
})

test('L3 过期租约（本人 / 他人）⇒ 接管并报 reclaimed=true', () => {
  for (const owner of ['dots', 'pc-a']) {
    const result = decideSessionPrompt(input({ lease: lease({ owner, expiresAt: NOW - 1 }) }))
    assert.equal(result.ok, true, owner)
    assert.equal(result.claim.reclaimed, true, owner)
  }
})

test('L4 请求声明的 leaseOwner 非 dots ⇒ NOT_HELD（永不授予 human owner）', () => {
  const result = refusal({ declaredLeaseOwner: 'pc-a' })
  assert.equal(result.key, 'lease.notHeld')
  assert.equal(result.code, 'E_LEASE_NOT_HELD')
  assert.equal(result.wording, LEASE_WORDING.E_LEASE_NOT_HELD)
})

test('L5 坏租约按无租约处理；nowMs 非法 ⇒ NOT_HELD（无法证明写权限）', () => {
  assert.equal(decideSessionPrompt(input({ lease: { ...lease(), v: 99 } })).ok, true)
  assert.equal(refusal({ nowMs: Number.NaN }).key, 'lease.notHeld')
})

/* ---------------- 幂等账本 ---------------- */

test('I1 同 requestId 在另一 sessionId 不算重复（账本按 session 分桶）', () => {
  const ledger = { 's-2': [{ requestId: 'r-1', atMs: NOW - 1 }] }
  assert.equal(decideSessionPrompt(input({ ledger })).ok, true)
})

test('I2 10 分钟窗口边界：恰好 10 分钟可重试，差 1ms 仍重复', () => {
  const at = NOW - PROMPT_IDEMPOTENCY_WINDOW_MS
  const expired = { 's-1': [{ requestId: 'r-1', atMs: at }] }
  const live = { 's-1': [{ requestId: 'r-1', atMs: at + 1 }] }
  assert.equal(decideSessionPrompt(input({ ledger: expired })).ok, true)
  assert.equal(refusal({ ledger: live }).key, 'prompt.duplicate')
})

test('I3 seenInWindow 纯函数：未见过 / 未来时刻（时钟回拨）', () => {
  assert.equal(seenInWindow({}, 's-1', 'r-1', NOW, PROMPT_IDEMPOTENCY_WINDOW_MS), false)
  assert.equal(seenInWindow({ 's-1': [{ requestId: 'r-1', atMs: NOW + 10_000 }] },
    's-1', 'r-1', NOW, PROMPT_IDEMPOTENCY_WINDOW_MS), true)
})

test('I4 recordSeen 不改入参；encode/decode 逐字节往返', () => {
  const before = { 's-1': [{ requestId: 'r-1', atMs: 1000 }] }
  const after = recordSeen(before, 's-1', 'r-2', 2000)
  assert.deepEqual(before, { 's-1': [{ requestId: 'r-1', atMs: 1000 }] })
  assert.equal(after['s-1'].length, 2)
  const encoded = encodeLedger(after)
  assert.deepEqual(decodeLedger(encoded).view, after)
  assert.equal(decodeLedger('{bad').problem, 'E_LEDGER_ENVELOPE_JSON')
  assert.equal(decodeLedger(JSON.stringify({ v: 9, items: [] })).problem, 'E_LEDGER_ENVELOPE_VERSION')
})

/* ---------------- 文案不泄漏 ---------------- */

test('W1 拒绝结果只含 key/code/wording，正文与 dots owner 不进文案', () => {
  const text = 'SECRET-PROMPT-BODY'
  const result = refusal({ text, channelVerified: false })
  assert.deepEqual(Object.keys(result).sort(), ['code', 'key', 'ok', 'wording'])
  assert.equal(JSON.stringify(result).includes(text), false)
  assert.equal(result.wording.includes('dots'), false)
  for (const key of Object.keys(result)) {
    assert.equal(/token|Bearer|https?:|\/|[0-9a-f]{16,}/i.test(String(result[key])), false)
  }
})

test('W2 成功结果不含正文字段；四个 PROMPT_WORDING 码语义键齐全', () => {
  const result = decideSessionPrompt(input({ text: 'SECRET-PROMPT-BODY' }))
  assert.equal(result.ok, true)
  assert.equal(JSON.stringify(result).includes('SECRET-PROMPT-BODY'), false)
  for (const key of PROMPT_SEMANTIC_KEYS) {
    assert.equal(typeof PROMPT_WORDING[key], 'string')
    assert.equal(typeof PROMPT_CODE_BY_KEY[key], 'string')
  }
})
