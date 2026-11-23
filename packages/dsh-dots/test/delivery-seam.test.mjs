/**
 * mod-plugin-session-prompt-delivery：投递端口顺序 / 失败分类 / record-on-success 测试。
 * 全部注入到包内 `.tmp/` 临时目录；零 live 状态、零 console、零真实 transport。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRpcService } from '../dist/rpc.js'
import {
  createSessionPromptService,
  createUnavailableDeliveryPort,
} from '../dist/remote/sessionPrompt.js'
import { createPromptLedger } from '../dist/remote/promptLedger.js'
import { createLeaseStore } from '../dist/remote/leaseStore.js'
import {
  PROMPT_CODE_BY_KEY,
  PROMPT_WORDING,
} from '../dist/remote/promptWording.js'

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP_ROOT = path.join(PKG, '.tmp')
const NOW = 5000
const INSTANCE = 'inst-0123456789abcdef'
const SHA = 'a'.repeat(64)
const LEAF = 'AB'.repeat(32)
const PROMPT = 'SECRET-PROMPT-BODY-DO-NOT-ECHO'
const OWNER = 'dots'

function port(behavior) {
  const calls = []
  return {
    calls,
    async send(request) {
      calls.push({ ...request })
      const step = typeof behavior === 'function' ? behavior(request, calls.length) : behavior
      if (step === 'throw') throw new Error(`port failed for ${PROMPT}`)
      return step
    },
  }
}

const SUCCESS = { ok: true, accepted: true, payloadSha256: 'c'.repeat(64) }

async function setup(t, options = {}) {
  const dir = await mkdtemp(path.join(TMP_ROOT, 'delivery-'))
  const markerDir = path.join(dir, 'marker')
  await mkdir(markerDir, { recursive: true })
  const markerPath = path.join(markerDir, 'channel-verified.json')
  if (options.marker !== false) {
    await writeFile(markerPath, JSON.stringify({
      verifiedAt: 1000,
      instanceId: options.markerInstance ?? INSTANCE,
      leafSha256: LEAF,
      verifier: 'operator',
    }), 'utf8')
  }
  const calls = { instance: 0, grant: 0, leaseLoad: 0, leaseUpsert: 0, ledgerLoad: 0, ledgerRecord: 0, headReader: 0 }
  const realLedger = createPromptLedger({ filePath: path.join(dir, 'ledger.json'), now: () => NOW })
  const realLeases = createLeaseStore({ filePath: path.join(dir, 'leases.json'), now: () => NOW })
  const ledger = {
    file: realLedger.file,
    load: async () => { calls.ledgerLoad += 1; return realLedger.load() },
    record: async (s, r, at) => {
      calls.ledgerRecord += 1
      if (options.recordFails === true) return { ok: false, view: {}, problem: 'E_LEDGER_STORAGE_UNAVAILABLE' }
      if (options.recordThrows === true) throw new Error('ledger down')
      return realLedger.record(s, r, at)
    },
    lastProblem: () => realLedger.lastProblem(),
  }
  const leases = {
    file: realLeases.file,
    load: async () => { calls.leaseLoad += 1; return realLeases.load() },
    upsert: async (lease) => { calls.leaseUpsert += 1; return realLeases.upsert(lease) },
    remove: async (id) => realLeases.remove(id),
    lastProblem: () => realLeases.lastProblem(),
  }
  const instances = { get: (id) => { calls.instance += 1; return id === INSTANCE ? { id } : null } }
  const grants = {
    isGranted: (id, tool) => { calls.grant += 1; return options.granted === false ? false : true },
  }
  const headReader = {
    readHeadSha: async () => { calls.headReader += 1; return options.head ?? SHA },
  }
  const deliveryPort = port(options.behavior === undefined ? SUCCESS : options.behavior)
  const delivery = options.noPort === true ? null : (options.unavailablePort === true
    ? { calls: [], send: async () => { calls.unavailablePortCall = (calls.unavailablePortCall ?? 0) + 1; return createUnavailableDeliveryPort().send() } }
    : deliveryPort)
  const service = createSessionPromptService({
    markerPath,
    pins: { lookup: () => ({ fingerprint: options.pin ?? LEAF }) },
    instances, grants, leases, ledger, headReader,
    delivery: options.noPort === true ? null : delivery,
    now: () => options.nowMs ?? NOW,
  })
  const rpc = createRpcService({
    homeDir: path.join(dir, 'home'), dshVersion: 'test-delivery', allowLocalRepo: true,
    now: () => new Date(NOW),
    prompt: {
      channelState: (id) => service.channelState(id),
      channelVerified: (id) => service.channelVerified(id),
      send: (req) => service.send(req),
    },
  })
  t.after(async () => {
    await rpc.dispose()
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  })
  return {
    dir, service, rpc, calls, deliveryPort, delivery, ledger, realLedger, leases, realLeases,
    setBehavior: (b) => { options.behavior = b },
    request: (overrides = {}) => ({
      action: 'sessionPrompt', sessionId: 's-1', instanceId: INSTANCE, requestId: 'r-1',
      text: PROMPT, expectedPrevSha: SHA, leaseOwner: OWNER, ...overrides,
    }),
  }
}

function assertNoPortCalls(portSpy, label) {
  assert.deepEqual(portSpy.calls, [], `${label}: 端口必须零调用`)
}

/* ---------------- 顺序：八种拒绝一律不碰端口 ---------------- */

const refusalCases = [
  { name: 'channel.desktop.unverified', options: { marker: false }, request: {} },
  { name: 'channel.desktop.leafMismatch', options: { pin: 'CD'.repeat(32) }, request: {} },
  { name: 'prompt.grant.denied', options: { granted: false }, request: {} },
  { name: 'prompt.text.empty', options: {}, request: { text: '' } },
  { name: 'E_LEASE_OBSERVING', options: { head: 'b'.repeat(64) }, request: {}, headMoved: true },
  { name: 'E_HEAD_MOVED', options: { head: 'b'.repeat(64) }, request: {} },
  { name: 'prompt.duplicate', options: { duplicate: true }, request: {} },
  { name: 'session.unavailable (no port)', options: { noPort: true }, request: {} },
]

for (const item of refusalCases) {
  test(`D0 拒绝 ${item.name} ⇒ 投递端口零调用`, async (t) => {
    const s = await setup(t, item.options)
    if (item.headMoved) {
      // 用他人未过期租约制造 OBSERVING。
      await s.realLeases.upsert({
        v: 1, sessionId: 's-1', instanceId: INSTANCE, owner: 'pc-a',
        ttlSec: 600, expiresAt: NOW + 600, headSha: SHA,
      })
    }
    if (item.options?.duplicate) await s.realLedger.record('s-1', 'r-1', NOW)
    const res = await s.rpc.handleRpc(s.request(item.request))
    assert.equal(res.ok, false, item.name)
    assertNoPortCalls(s.deliveryPort)
  })
}

/* ---------------- 成功与失败分类 ---------------- */

test('D1 成功 ⇒ {accepted:true,payloadSha256}（无 seq），正文 / owner 不回显', async (t) => {
  const s = await setup(t)
  const res = await s.rpc.handleRpc(s.request())
  assert.equal(res.ok, true)
  assert.deepEqual(Object.keys(res.data).sort(), ['accepted', 'payloadSha256'])
  assert.deepEqual(res.data, { accepted: true, payloadSha256: 'c'.repeat(64) })
  assert.equal('seq' in res.data, false, 'seq 已从结果里彻底移除')
  assert.equal(JSON.stringify(res).includes(PROMPT), false)
  assert.equal(JSON.stringify(res).includes(OWNER), false)
  assert.equal(s.deliveryPort.calls.length, 1)
})

test('D2 真实缺省端口 ⇒ E_SESSION_UNAVAILABLE（逐字文案，无 transport）', async (t) => {
  const s = await setup(t, { unavailablePort: true })
  const res = await s.rpc.handleRpc(s.request())
  assert.equal(res.ok, false)
  assert.equal(res.error.code, 'E_SESSION_UNAVAILABLE')
  assert.equal(res.error.message, PROMPT_WORDING['session.unavailable'])
  assert.equal(JSON.stringify(res).includes(PROMPT), false)
})

test('D3 port ok:false E_SESSION_DELIVERY_FAILED ⇒ typed 拒绝，不回显正文', async (t) => {
  const s = await setup(t, { behavior: { ok: false, code: 'E_SESSION_DELIVERY_FAILED', reason: PROMPT } })
  const res = await s.rpc.handleRpc(s.request())
  assert.equal(res.error.code, 'E_SESSION_DELIVERY_FAILED')
  assert.equal(res.error.message, PROMPT_WORDING['session.deliveryFailed'])
  assert.equal(JSON.stringify(res).includes(PROMPT), false)
  assert.equal(s.deliveryPort.calls.length, 1)
})

test('D4 port 抛错 ⇒ E_SESSION_DELIVERY_FAILED（不冒原始异常、不报成功）', async (t) => {
  const s = await setup(t, { behavior: 'throw' })
  const res = await s.rpc.handleRpc(s.request())
  assert.equal(res.error.code, 'E_SESSION_DELIVERY_FAILED')
  assert.equal(JSON.stringify(res).includes(PROMPT), false)
})

test('D5 自由文本 / 未知失败码 ⇒ E_SESSION_DELIVERY_FAILED（fail-closed）', async (t) => {
  for (const bad of [{ ok: false, code: 'WHATEVER', reason: PROMPT }, { ok: false }, null]) {
    const s = await setup(t, { behavior: bad })
    const res = await s.rpc.handleRpc(s.request())
    assert.equal(res.error.code, 'E_SESSION_DELIVERY_FAILED')
    assert.equal(JSON.stringify(res).includes(PROMPT), false)
  }
})

/* ---------------- record-on-success ---------------- */

test('D6 首次 deliveryFailed ⇒ 账本空 ⇒ 同 requestId 可重试并成功记录一次', async (t) => {
  const s = await setup(t, { behavior: (req, n) => (n === 1 ? { ok: false, code: 'E_SESSION_DELIVERY_FAILED' } : SUCCESS) })
  const first = await s.rpc.handleRpc(s.request())
  assert.equal(first.error.code, 'E_SESSION_DELIVERY_FAILED')
  assert.deepEqual((await s.realLedger.load()).view, {})
  const second = await s.rpc.handleRpc(s.request())
  assert.equal(second.ok, true)
  assert.equal(s.deliveryPort.calls.length, 2, '同一请求号被再次投递')
  const view = (await s.realLedger.load()).view
  assert.equal(view['s-1'].length, 1)
  assert.equal(view['s-1'][0].requestId, 'r-1')
})

test('D7 首次成功 ⇒ 同 requestId 重复 ⇒ E_PROMPT_DUPLICATE，端口仅一次', async (t) => {
  const s = await setup(t)
  const first = await s.rpc.handleRpc(s.request())
  const second = await s.rpc.handleRpc(s.request())
  assert.equal(first.ok, true)
  assert.equal(second.error.code, 'E_PROMPT_DUPLICATE')
  assert.equal(s.deliveryPort.calls.length, 1)
})

test('D8 投递成功但账本写失败 ⇒ E_SESSION_RECORD_FAILED（不回显正文 / owner）', async (t) => {
  const s = await setup(t, { recordFails: true })
  const res = await s.rpc.handleRpc(s.request())
  assert.equal(res.error.code, 'E_SESSION_RECORD_FAILED')
  assert.equal(res.error.message, '会话已写入但请求记录未落盘，请先刷新会话确认，勿盲目重发')
  assert.equal(JSON.stringify(res).includes(PROMPT), false)
  assert.equal(JSON.stringify(res).includes(OWNER), false)
  assert.equal(s.deliveryPort.calls.length, 1)
})

test('D9 账本 record 抛错也收敛到 E_SESSION_RECORD_FAILED', async (t) => {
  const s = await setup(t, { recordThrows: true })
  const res = await s.rpc.handleRpc(s.request())
  assert.equal(res.error.code, 'E_SESSION_RECORD_FAILED')
})

test('D10 10 分钟边界与按 sessionId 分桶在 record-on-success 下仍成立', async (t) => {
  const clock = 1_000_000
  const s = await setup(t, { nowMs: clock })
  await s.realLedger.record('s-1', 'r-old', clock - 600_000)
  await s.realLedger.record('s-3', 'r-1', clock - 1)
  const atBoundary = await s.rpc.handleRpc(s.request({ requestId: 'r-old' }))
  assert.equal(atBoundary.ok, true, '恰好 10 分钟视为过期')
  const otherSession = await s.rpc.handleRpc(s.request({ sessionId: 's-2' }))
  assert.equal(otherSession.ok, true, '同 requestId 在别的会话不算重复')
  assert.equal(s.deliveryPort.calls.length, 2)
  assert.equal(PROMPT_CODE_BY_KEY['session.recordFailed'], 'E_SESSION_RECORD_FAILED')
})
