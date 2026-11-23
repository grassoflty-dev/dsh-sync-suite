/**
 * mod-plugin-session-prompt：DARK action 的 RPC 行为测试（临时目录 + 注入 spy）。
 *
 * 覆盖：action 已注册；标记缺失时每次调用都 E_CHANNEL_UNVERIFIED 且零依赖触碰；
 * 标记在但无 grant ⇒ E_GRANT_DENIED；有假端口的 happy path 只回 {seq,sha256,accepted}；
 * 端口缺席 ⇒ E_SESSION_UNAVAILABLE；标记文件只读；幂等与入参形状。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRpcService } from '../dist/rpc.js'
import { createLeaseStore } from '../dist/remote/leaseStore.js'
import { createPromptLedger } from '../dist/remote/promptLedger.js'
import { createSessionPromptService } from '../dist/remote/sessionPrompt.js'
import { PROMPT_WORDING } from '../dist/remote/promptWording.js'

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP_ROOT = path.join(PKG, '.tmp')
const NOW = 5000
const INSTANCE = 'inst-0123456789abcdef'
const SHA = 'a'.repeat(64)

const VALID_MARKER = {
  verifiedAt: 1000,
  instanceId: INSTANCE,
  leafSha256: 'f'.repeat(64),
  verifier: 'operator',
}

async function setup(t, options = {}) {
  const dir = await mkdtemp(path.join(TMP_ROOT, 'prompt-rpc-'))
  const homeDir = path.join(dir, 'home')
  const profileDir = path.join(dir, 'profile')
  await mkdir(profileDir, { recursive: true })
  const markerPath = path.join(dir, 'channel-verified.json')
  if (options.marker === true) {
    const payload = options.markerPayload ?? {
      ...VALID_MARKER,
      instanceId: options.markerInstance ?? INSTANCE,
    }
    await writeFile(markerPath, JSON.stringify(payload), 'utf8')
  } else if (options.marker === 'bad') {
    await writeFile(markerPath, JSON.stringify({ verifiedAt: 'yesterday' }), 'utf8')
  }

  const calls = {
    channelVerified: 0, instance: 0, grant: 0, leaseLoad: 0, leaseUpsert: 0,
    ledgerLoad: 0, ledgerRecord: 0, delivery: 0, headReader: 0,
  }
  const instances = {
    get: (id) => { calls.instance += 1; return id === INSTANCE ? { id } : null },
  }
  const grants = {
    isGranted: (instanceId, tool) => {
      calls.grant += 1
      assert.equal(tool, 'session.prompt')
      return options.granted === true
    },
  }
  const realLeases = createLeaseStore({ filePath: path.join(dir, 'leases.json'), now: () => NOW })
  const leases = {
    file: realLeases.file,
    load: async () => { calls.leaseLoad += 1; return realLeases.load() },
    upsert: async (lease) => { calls.leaseUpsert += 1; return realLeases.upsert(lease) },
    remove: async (id) => realLeases.remove(id),
    lastProblem: () => realLeases.lastProblem(),
  }
  const realLedger = createPromptLedger({ filePath: path.join(dir, 'ledger.json'), now: () => NOW })
  const ledger = {
    file: realLedger.file,
    load: async () => { calls.ledgerLoad += 1; return realLedger.load() },
    record: async (sessionId, requestId, atMs) => {
      calls.ledgerRecord += 1
      return realLedger.record(sessionId, requestId, atMs)
    },
    lastProblem: () => realLedger.lastProblem(),
  }
  const delivery = options.delivery === false ? null : {
    // 故意多塞 text / leaseOwner 两个字段，证明服务层只回白名单三字段。
    send: async (request) => {
      calls.delivery += 1
      return { seq: 7, sha256: 'c'.repeat(64), accepted: true, text: request.text, leaseOwner: request.leaseOwner }
    },
  }
  const headReader = {
    readHeadSha: async () => { calls.headReader += 1; return options.headSha ?? SHA },
  }
  const service = createSessionPromptService({
    markerPath, instances, grants, leases, ledger, delivery, headReader, now: () => NOW,
    // leaf-binding 后通道闸需要每实例 pin；这里注入与标记一致的假指纹，
    // 保持本文件原有断言不变，也避免读取任何 live 配对状态。
    pins: { lookup: () => ({ fingerprint: options.pinFingerprint ?? VALID_MARKER.leafSha256 }) },
  })
  const prompt = {
    channelVerified: (instanceId) => {
      calls.channelVerified += 1
      return service.channelVerified(instanceId)
    },
    send: (request) => service.send(request),
  }
  const rpc = createRpcService({
    homeDir, profileDir, dshVersion: 'test-1', allowLocalRepo: true,
    now: () => new Date(NOW), prompt,
  })
  t.after(async () => {
    await rpc.dispose()
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  })
  return { rpc, markerPath, calls, dir }
}

const body = (overrides = {}) => ({
  action: 'sessionPrompt',
  sessionId: 's-1',
  instanceId: INSTANCE,
  requestId: 'r-1',
  text: '查一下 pc-b 的会话',
  expectedPrevSha: SHA,
  leaseOwner: 'dots',
  ...overrides,
})

/* ---------------- DARK 证明 ---------------- */

test('R1 action 已注册：标记缺失返回 E_CHANNEL_UNVERIFIED（不是 E_UNKNOWN_ACTION）', async (t) => {
  const { rpc } = await setup(t)
  const res = await rpc.handleRpc(body())
  assert.equal(res.ok, false)
  assert.equal(res.error.code, 'E_CHANNEL_UNVERIFIED')
  assert.equal(res.error.message, PROMPT_WORDING['channel.desktop.unverified'])
})

test('R2 标记缺失：每种入参都一律拒绝，且 lease / ledger / port / 实例 / grant 全部零触碰', async (t) => {
  const { rpc, calls, markerPath } = await setup(t)
  const variants = [
    body(),
    body({ text: '' }),
    body({ sessionId: '', requestId: '', instanceId: '' }),
    body({ text: 42, expectedPrevSha: null }),
    { action: 'sessionPrompt' },
  ]
  for (const payload of variants) {
    const res = await rpc.handleRpc(payload)
    assert.equal(res.ok, false)
    assert.equal(res.error.code, 'E_CHANNEL_UNVERIFIED')
  }
  assert.equal(calls.instance, 0)
  assert.equal(calls.grant, 0)
  assert.equal(calls.leaseLoad, 0)
  assert.equal(calls.leaseUpsert, 0)
  assert.equal(calls.ledgerLoad, 0)
  assert.equal(calls.ledgerRecord, 0)
  assert.equal(calls.delivery, 0)
  assert.equal(calls.headReader, 0)
  assert.ok(calls.channelVerified >= variants.length)
  // 缺失时不创建标记文件（只读纪律）。
  await assert.rejects(() => readFile(markerPath))
})

test('R3 坏标记载荷与标记缺失等价（不记忆上次、不回退）', async (t) => {
  const { rpc, calls } = await setup(t, { marker: 'bad' })
  const res = await rpc.handleRpc(body())
  assert.equal(res.error.code, 'E_CHANNEL_UNVERIFIED')
  assert.equal(calls.leaseLoad, 0)
  assert.equal(calls.delivery, 0)
})

test('R4 标记文件只读：多次调用后逐字节不变', async (t) => {
  const { rpc, markerPath } = await setup(t, { marker: true, granted: false })
  const before = await readFile(markerPath, 'utf8')
  await rpc.handleRpc(body())
  await rpc.handleRpc(body({ requestId: 'r-2' }))
  assert.equal(await readFile(markerPath, 'utf8'), before)
})

/* ---------------- 授权与 happy path ---------------- */

test('R5 标记在但无显式 grant ⇒ E_GRANT_DENIED（端口零调用）', async (t) => {
  const { rpc, calls } = await setup(t, { marker: true, granted: false })
  const res = await rpc.handleRpc(body())
  assert.equal(res.ok, false)
  assert.equal(res.error.code, 'E_GRANT_DENIED')
  assert.equal(res.error.message, PROMPT_WORDING['prompt.grant.denied'])
  assert.equal(calls.delivery, 0)
})

test('R6 标记绑定该实例后，未知实例 ⇒ E_INSTANCE_UNKNOWN（逐字文案）', async (t) => {
  const { rpc } = await setup(t, { marker: true, markerInstance: 'inst-aaaaaaaaaaaaaaaa', granted: true })
  const res = await rpc.handleRpc(body({ instanceId: 'inst-aaaaaaaaaaaaaaaa' }))
  assert.equal(res.error.code, 'E_INSTANCE_UNKNOWN')
  assert.equal(res.error.message, PROMPT_WORDING['instance.unknown'])
})

test('R7 happy path：只回 {seq,sha256,accepted}，正文与 lease owner 不回显', async (t) => {
  const { rpc, calls } = await setup(t, { marker: true, granted: true })
  const res = await rpc.handleRpc(body())
  assert.equal(res.ok, true)
  assert.deepEqual(Object.keys(res.data).sort(), ['accepted', 'seq', 'sha256'])
  assert.equal(res.data.seq, 7)
  assert.equal(res.data.accepted, true)
  const text = JSON.stringify(res.data)
  assert.equal(text.includes('查一下 pc-b 的会话'), false)
  assert.equal(text.includes('dots'), false)
  assert.equal(calls.delivery, 1)
  assert.equal(calls.leaseUpsert, 1)
  assert.equal(calls.ledgerRecord, 1)
})

test('R8 投递端口缺席 ⇒ E_SESSION_UNAVAILABLE，且不写租约 / 账本', async (t) => {
  const { rpc, calls } = await setup(t, { marker: true, granted: true, delivery: false })
  const res = await rpc.handleRpc(body())
  assert.equal(res.ok, false)
  assert.equal(res.error.code, 'E_SESSION_UNAVAILABLE')
  assert.equal(res.error.message, PROMPT_WORDING['session.unavailable'])
  assert.equal(calls.delivery, 0)
  assert.equal(calls.leaseUpsert, 0)
  assert.equal(calls.ledgerRecord, 0)
})

test('R9 同一 requestId 第二次被拒（账本按会话落盘）', async (t) => {
  const { rpc } = await setup(t, { marker: true, granted: true })
  const first = await rpc.handleRpc(body())
  const second = await rpc.handleRpc(body())
  assert.equal(first.ok, true)
  assert.equal(second.ok, false)
  assert.equal(second.error.code, 'E_PROMPT_DUPLICATE')
  assert.equal(second.error.message, PROMPT_WORDING['prompt.duplicate'])
})

test('R10 入参形状：缺字段 ⇒ E_VALIDATION；空正文 ⇒ 逐字 prompt.text.empty', async (t) => {
  const { rpc } = await setup(t, { marker: true, granted: true })
  const missing = await rpc.handleRpc(body({ sessionId: '' }))
  assert.equal(missing.error.code, 'E_VALIDATION')
  const emptyText = await rpc.handleRpc(body({ requestId: 'r-2', text: '' }))
  assert.equal(emptyText.error.code, 'E_VALIDATION')
  assert.equal(emptyText.error.message, PROMPT_WORDING['prompt.text.empty'])
})

test('R11 头锚不符 ⇒ E_HEAD_MOVED（租约不构成覆盖许可）', async (t) => {
  const { rpc, calls } = await setup(t, { marker: true, granted: true, headSha: SHA })
  const res = await rpc.handleRpc(body({ requestId: 'r-9', expectedPrevSha: 'b'.repeat(64) }))
  assert.equal(res.error.code, 'E_HEAD_MOVED')
  assert.equal(calls.delivery, 0)
})

/* ---------------- Major 回归：标记按实例绑定 ---------------- */

const SIDE_EFFECT_SPYS = [
  'instance', 'grant', 'leaseLoad', 'leaseUpsert', 'ledgerLoad', 'ledgerRecord', 'delivery', 'headReader',
]

function assertZeroSideEffects(calls) {
  for (const key of SIDE_EFFECT_SPYS) assert.equal(calls[key], 0, `${key} 必须零调用`)
}

test('R12 回归（reviewer 场景）：标记为实例 B 写、请求实例 A ⇒ E_CHANNEL_UNVERIFIED 且 8 个 spy 全为 0', async (t) => {
  const OTHER = 'inst-aaaaaaaaaaaaaaaa'
  const { rpc, calls, markerPath } = await setup(t, { marker: true, markerInstance: OTHER, granted: true })
  // 标记确实存在且合法——只是属于实例 B。
  assert.match(await readFile(markerPath, 'utf8'), /inst-aaaaaaaaaaaaaaaa/)
  const res = await rpc.handleRpc(body({ instanceId: INSTANCE }))
  assert.equal(res.ok, false)
  assert.equal(res.error.code, 'E_CHANNEL_UNVERIFIED')
  assert.equal(res.error.message, PROMPT_WORDING['channel.desktop.unverified'])
  assertZeroSideEffects(calls)
})

test('R13 标记实例与请求匹配才越过通道闸（落在 grant 拒绝）', async (t) => {
  const { rpc, calls } = await setup(t, { marker: true, granted: false })
  const res = await rpc.handleRpc(body())
  assert.equal(res.error.code, 'E_GRANT_DENIED')
  assert.equal(calls.instance, 1)
  assert.equal(calls.grant, 1)
  // 服务在 gate 之前读租约 / 账本（只读），但 gate 拒绝后没有任何写或投递。
  assert.equal(calls.leaseLoad, 1)
  assert.equal(calls.ledgerLoad, 1)
  assert.equal(calls.leaseUpsert, 0)
  assert.equal(calls.ledgerRecord, 0)
  assert.equal(calls.delivery, 0)
})

test('R14 缺失 / 空白 / 非字符串 instanceId ⇒ E_CHANNEL_UNVERIFIED 且零副作用', async (t) => {
  const { rpc, calls } = await setup(t, { marker: true, granted: true })
  for (const bad of [undefined, '', '   ', 42]) {
    const res = await rpc.handleRpc(body({ instanceId: bad }))
    assert.equal(res.ok, false, String(bad))
    assert.equal(res.error.code, 'E_CHANNEL_UNVERIFIED', String(bad))
    assert.equal(res.error.message, PROMPT_WORDING['channel.desktop.unverified'])
  }
  assertZeroSideEffects(calls)
})
