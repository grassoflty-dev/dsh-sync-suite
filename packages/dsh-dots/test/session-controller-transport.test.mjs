/**
 * mod-plugin-session-prompt-transport：进程内 sessionController.prompt 投递端口测试。
 * 假控制器 + 注入路径，零 live DSH / 零设备 / 零 console。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRpcService } from '../dist/rpc.js'
import { createSessionPromptService } from '../dist/remote/sessionPrompt.js'
import { createPromptLedger } from '../dist/remote/promptLedger.js'
import { PROMPT_WORDING } from '../dist/remote/promptWording.js'

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP_ROOT = path.join(PKG, '.tmp')
const NOW = 5000
const INSTANCE = 'inst-0123456789abcdef'
const LEAF = 'AB'.repeat(32)
const SHA = 'a'.repeat(64)
const OTHER_SHA = 'b'.repeat(64)
const PROMPT = '查一下 pc-b 的会话'
const EXPECTED_SHA = createHash('sha256').update(PROMPT, 'utf8').digest('hex')

async function setup(t, options = {}) {
  const dir = await mkdtemp(path.join(TMP_ROOT, 'transport-'))
  const markerDir = path.join(dir, 'marker')
  await mkdir(markerDir, { recursive: true })
  const markerPath = path.join(markerDir, 'channel-verified.json')
  if (options.marker !== false) {
    await writeFile(markerPath, JSON.stringify({
      verifiedAt: 1000, instanceId: INSTANCE, leafSha256: LEAF, verifier: 'operator',
    }), 'utf8')
  }
  const calls = { lookup: 0, prompt: 0, headReader: 0, ledgerRecord: 0 }
  const argLog = []
  let behavior = options.behavior === undefined ? (() => ({ accepted: true })) : options.behavior
  const controller = {
    async prompt(request, signal) {
      calls.prompt += 1
      argLog.push({ request, abortedAtCall: signal.aborted })
      const next = typeof behavior === 'function' ? behavior(request, calls.prompt, signal) : behavior
      if (next === 'throw') throw new Error(`boom ${PROMPT}`)
      if (next === 'abort') {
        if (typeof signal.throwIfAborted === 'function') signal.throwIfAborted()
        throw new Error('aborted')
      }
      return next
    },
  }
  const heads = [...(options.heads ?? [SHA, SHA])]
  const headReader = {
    async readHeadSha() {
      calls.headReader += 1
      return heads.length > 1 ? (heads.shift() ?? SHA) : (heads[0] ?? SHA)
    },
  }
  const realLedger = createPromptLedger({ filePath: path.join(dir, 'ledger.json'), now: () => NOW })
  const ledger = {
    file: realLedger.file,
    load: () => realLedger.load(),
    record: async (s, r, at, meta) => {
      calls.ledgerRecord += 1
      if (options.recordFails === true) return { ok: false, view: {}, problem: 'E_LEDGER_STORAGE_UNAVAILABLE' }
      return realLedger.record(s, r, at, meta)
    },
    lastProblem: () => realLedger.lastProblem(),
  }
  const service = createSessionPromptService({
    homeDir: dir, markerPath, ledger, headReader, now: () => NOW,
    pins: { lookup: () => ({ fingerprint: LEAF }) },
    instances: { get: () => ({ id: INSTANCE }) },
    grants: { isGranted: () => options.granted !== false },
    sessionControllerLookup: () => {
      calls.lookup += 1
      return options.controllerMissing === true ? null : controller
    },
  })
  const rpc = createRpcService({
    homeDir: dir, dshVersion: 'test-transport', allowLocalRepo: true,
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
    dir, service, rpc, calls, argLog, ledger, realLedger, controller,
    setBehavior: (next) => { behavior = next },
    request: (overrides = {}) => ({
      action: 'sessionPrompt', sessionId: 's-1', instanceId: INSTANCE, requestId: 'req-1',
      text: PROMPT, expectedPrevSha: SHA, leaseOwner: 'dots', ...overrides,
    }),
  }
}

/* ---------------- 1. accepted ---------------- */

test('T1 accepted ⇒ {accepted:true,payloadSha256} = 我们自己的 sha(正文)，无 seq', async (t) => {
  const s = await setup(t)
  const res = await s.rpc.handleRpc(s.request())
  assert.equal(res.ok, true)
  assert.deepEqual(Object.keys(res.data).sort(), ['accepted', 'payloadSha256'])
  assert.equal(res.data.accepted, true)
  assert.equal(res.data.payloadSha256, EXPECTED_SHA)
  assert.equal('seq' in res.data, false)
  assert.equal(JSON.stringify(res).includes(PROMPT), false)
  // 进程内调用固定 mode:'queue'，requestId 原样传给 DSH。
  assert.equal(s.argLog.length, 1)
  assert.equal(s.argLog[0].request.mode, 'queue')
  assert.equal(s.argLog[0].request.requestId, 'req-1')
  assert.deepEqual(s.argLog[0].request.content, [{ type: 'text', text: PROMPT }])
})

/* ---------------- 2/3. 失败分类 ---------------- */

const failures = [
  ['session/not-found', { code: 'session/not-found' }],
  ['session/agent-busy', { code: 'session/agent-busy' }],
  ['gateway/internal', { code: 'gateway/internal' }],
  ['unknown code', { code: 'weird/unknown' }],
  ['malformed result', null],
  ['thrown', 'throw'],
  ['aborted signal', 'abort'],
]

for (const [label, behavior] of failures) {
  test(`T2/T3 ${label} ⇒ E_SESSION_DELIVERY_FAILED（逐字文案，绝不成功）`, async (t) => {
    const s = await setup(t, { behavior })
    const res = await s.rpc.handleRpc(s.request())
    assert.equal(res.ok, false)
    assert.equal(res.error.code, 'E_SESSION_DELIVERY_FAILED')
    assert.equal(res.error.message, PROMPT_WORDING['session.deliveryFailed'])
    assert.equal(JSON.stringify(res).includes(PROMPT), false)
    assert.equal(s.calls.prompt, 1)
  })
}

/* ---------------- 4. 同 requestId 重试 ---------------- */

test('T4 投递失败后账本为空；同 requestId 重试再次调用控制器，成功后恰好一行', async (t) => {
  const s = await setup(t, { behavior: (req, n) => (n === 1 ? { code: 'session/not-found' } : { accepted: true }) })
  const failed = await s.rpc.handleRpc(s.request())
  assert.equal(failed.error.code, 'E_SESSION_DELIVERY_FAILED')
  assert.deepEqual((await s.realLedger.load()).view, {})
  const retried = await s.rpc.handleRpc(s.request())
  assert.equal(retried.ok, true)
  assert.equal(s.calls.prompt, 2)
  assert.equal(s.argLog[0].request.requestId, s.argLog[1].request.requestId)
  assert.equal((await s.realLedger.load()).view['s-1'].length, 1)
})

/* ---------------- 5. 成功后新 requestId ---------------- */

test('T5 已有成功账本行时用新 requestId ⇒ E_HEAD_MOVED（显式策略，控制器零调用）', async (t) => {
  const s = await setup(t)
  const first = await s.rpc.handleRpc(s.request())
  assert.equal(first.ok, true)
  const second = await s.rpc.handleRpc(s.request({ requestId: 'req-2' }))
  assert.equal(second.ok, false)
  assert.equal(second.error.code, 'E_HEAD_MOVED')
  assert.equal(s.calls.prompt, 1, '第二个 requestId 根本不委托给 DSH')
})

/* ---------------- 6. 记录失败 ---------------- */

test('T6 投递成功后账本写失败 ⇒ E_SESSION_RECORD_FAILED，响应无正文', async (t) => {
  const s = await setup(t, { recordFails: true })
  const res = await s.rpc.handleRpc(s.request())
  assert.equal(res.error.code, 'E_SESSION_RECORD_FAILED')
  assert.equal(JSON.stringify(res).includes(PROMPT), false)
  assert.equal(JSON.stringify(res).includes('dots'), false)
})

/* ---------------- 7. head 漂移 ---------------- */

test('T7 调用后 head 漂移记进账本；响应仍 accepted 且无原子性宣称', async (t) => {
  const s = await setup(t, { heads: [SHA, OTHER_SHA] })
  const res = await s.rpc.handleRpc(s.request())
  assert.equal(res.ok, true)
  assert.equal(res.data.accepted, true)
  const row = (await s.realLedger.load()).view['s-1'][0]
  assert.equal(row.headDrift, true)
  assert.equal(row.observedHeadSha, OTHER_SHA)
  assert.equal(row.payloadSha256, EXPECTED_SHA)
  assert.equal('text' in row, false, '账本不得含 prompt 正文')
  assert.equal(PROMPT_WORDING['session.deliveryFailed'].includes('原子'), false)
})

/* ---------------- 8. DARK 且服务在场 ---------------- */

test('T8 标记缺失（服务在场）⇒ E_CHANNEL_UNVERIFIED，控制器 spy 零调用且不建账本', async (t) => {
  const s = await setup(t, { marker: false })
  const res = await s.rpc.handleRpc(s.request())
  assert.equal(res.error.code, 'E_CHANNEL_UNVERIFIED')
  assert.equal(s.calls.lookup, 0, '通道闸在服务查找之前')
  assert.equal(s.calls.prompt, 0)
  assert.equal(s.calls.ledgerRecord, 0)
  await assert.rejects(() => import('node:fs').then((fs) => fs.promises.stat(s.ledger.file)))
})

/* ---------------- 9. 服务缺席 ---------------- */

test('T9 服务缺席（标记/grant/租约均正常）⇒ E_SESSION_UNAVAILABLE，控制器零调用', async (t) => {
  const s = await setup(t, { controllerMissing: true })
  const res = await s.rpc.handleRpc(s.request())
  assert.equal(res.ok, false)
  assert.equal(res.error.code, 'E_SESSION_UNAVAILABLE')
  assert.equal(s.calls.lookup, 1)
  assert.equal(s.calls.prompt, 0)
  assert.deepEqual((await s.realLedger.load()).view, {})
})
