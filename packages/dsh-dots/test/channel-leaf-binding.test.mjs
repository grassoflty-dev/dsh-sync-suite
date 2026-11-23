/**
 * mod-plugin-session-prompt-leaf-binding：通道三态 + 叶证书 pin 绑定测试。
 *
 * 零 live 状态：marker / pin / 所有 store 路径都注入到包内 `.tmp/` 的临时目录。
 * 覆盖 match / 大小写冒号归一 / mismatch / 坏标记 / 无 pin 不 TOFU / 轮换 / 跨实例 /
 * 以及 DARK 拒绝期间零持久化文件。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRpcService } from '../dist/rpc.js'
import { createSessionPromptService, bareFingerprint } from '../dist/remote/sessionPrompt.js'
import { statePaths } from '../dist/engine/paths.js'
import { PROMPT_WORDING, PROMPT_CODE_BY_KEY } from '../dist/remote/promptWording.js'

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP_ROOT = path.join(PKG, '.tmp')
const NOW = 5000
const INSTANCE = 'inst-0123456789abcdef'
const OTHER = 'inst-aaaaaaaaaaaaaaaa'
const P1 = 'AB'.repeat(32)          // 64 hex，大写裸值
const P2 = 'CD'.repeat(32)
const SHA = 'a'.repeat(64)

const SPYS = [
  'instance', 'grant', 'leaseLoad', 'leaseUpsert', 'ledgerLoad', 'ledgerRecord', 'delivery', 'headReader',
]
function assertZeroSpys(calls) {
  for (const key of SPYS) assert.equal(calls[key], 0, `${key} 必须零调用`)
}

/** L8/L9 共用：DARK 拒绝后状态树里不得出现租约 / 账本 / 标记文件。 */
async function assertNoDarkFiles(homeDir) {
  const forbidden = new Set(['prompt-ledger.json', 'session-leases.json', 'channel-verified.json'])
  const found = []
  async function scan(current) {
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (forbidden.has(entry.name)) found.push(path.join(current, entry.name))
      if (entry.isDirectory()) await scan(path.join(current, entry.name))
    }
  }
  await scan(homeDir)
  assert.deepEqual(found, [], 'DARK 拒绝不得创建租约 / 账本 / 标记文件')
  const root = statePaths(homeDir).root
  try {
    if ((await stat(root)).isDirectory()) assert.deepEqual((await readdir(root)).sort(), [])
  } catch {
    /* 状态目录尚未创建也是合格结果 */
  }
}

function colon(value) {
  return (value.match(/.{2}/g) ?? []).join(':')
}

async function setup(t, options = {}) {
  const dir = await mkdtemp(path.join(TMP_ROOT, 'leaf-'))
  const markerDir = path.join(dir, 'marker')
  await mkdir(markerDir, { recursive: true })
  const markerPath = path.join(markerDir, 'channel-verified.json')
  const marker = {
    verifiedAt: 1000,
    instanceId: options.markerInstance ?? INSTANCE,
    leafSha256: options.markerLeaf ?? P1,
    verifier: 'operator',
  }
  if (options.writeMarker !== false) await writeFile(markerPath, JSON.stringify(marker), 'utf8')

  const calls = {
    pinLookup: 0, instance: 0, grant: 0, leaseLoad: 0, leaseUpsert: 0,
    ledgerLoad: 0, ledgerRecord: 0, delivery: 0, headReader: 0,
  }
  let pin = options.pin === undefined ? P1 : options.pin
  const pins = {
    lookup: (instanceId) => {
      calls.pinLookup += 1
      if (typeof pin !== 'string' || pin === '' || pin === 'invalid') return null
      return { fingerprint: pin }
    },
  }
  const instances = { get: (id) => { calls.instance += 1; return id === INSTANCE ? { id } : null } }
  const grants = {
    isGranted: (id, tool) => { calls.grant += 1; assert.equal(tool, 'session.prompt'); return options.granted === true },
  }
  const leases = {
    load: async () => { calls.leaseLoad += 1; return { ok: true, leases: [], problem: null } },
    upsert: async () => { calls.leaseUpsert += 1; return { ok: true, leases: [], problem: null } },
    remove: async () => ({ ok: true, leases: [], problem: null }),
    lastProblem: () => null,
  }
  const ledger = {
    load: async () => { calls.ledgerLoad += 1; return { ok: true, view: {}, problem: null } },
    record: async () => { calls.ledgerRecord += 1; return { ok: true, view: {}, problem: null } },
    lastProblem: () => null,
  }
  const delivery = {
    send: async (req) => {
      calls.delivery += 1
      return { seq: 1, sha256: SHA, accepted: true, text: req.text }
    },
  }
  const headReader = { readHeadSha: async () => { calls.headReader += 1; return SHA } }
  const serviceOptions = {
    markerPath, pins, instances, grants, leases, ledger, delivery, headReader, now: () => NOW,
  }
  const service = createSessionPromptService(serviceOptions)
  const rpc = createRpcService({
    homeDir: path.join(dir, 'home'), dshVersion: 'test-leaf', allowLocalRepo: true,
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
    dir, markerPath, service, rpc, calls, marker,
    setPin: (value) => { pin = value },
    setOptions: (patch) => Object.assign(serviceOptions, patch),
    rebuild: () => createSessionPromptService(serviceOptions),
  }
}

const request = (overrides = {}) => ({
  action: 'sessionPrompt', sessionId: 's-1', instanceId: INSTANCE, requestId: 'r-1',
  text: '查一下 pc-b 的会话', expectedPrevSha: SHA, leaseOwner: 'dots', ...overrides,
})

/* ---------------- 1. match ---------------- */

test('L1 pin 与标记一致 ⇒ verified，越过通道闸落在 grant 拒绝', async (t) => {
  const { service, calls } = await setup(t)
  assert.equal(service.channelState(INSTANCE), 'verified')
  assert.equal(service.channelVerified(INSTANCE), true)
  await assert.rejects(() => service.send(request()), (error) => error.code === 'E_GRANT_DENIED')
  assert.equal(calls.grant, 1)
  assert.equal(calls.delivery, 0)
})

/* ---------------- 2. 归一 ---------------- */

test('L2 大小写与冒号差异不影响判定（两个方向都 verified）', async (t) => {
  const upperColon = colon(P1)
  const { service, markerPath, setPin } = await setup(t, { markerLeaf: upperColon, pin: P1.toLowerCase() })
  assert.equal(service.channelState(INSTANCE), 'verified', 'marker 冒号大写 / pin 裸小写')
  // 反向：标记小写裸值 / pin 大写冒号。
  const lower = P1.toLowerCase()
  await writeFile(markerPath, JSON.stringify({
    verifiedAt: 1000, instanceId: INSTANCE, leafSha256: lower, verifier: 'operator',
  }), 'utf8')
  setPin(colon(P1))
  assert.equal(service.channelState(INSTANCE), 'verified', 'marker 裸小写 / pin 冒号大写')
  assert.equal(bareFingerprint(upperColon), P1)
})

/* ---------------- 3. mismatch ---------------- */

test('L3 pin 与标记不同 ⇒ E_CHANNEL_LEAF_MISMATCH（逐字文案）+ 8 个 spy 全 0', async (t) => {
  const { service, rpc, calls } = await setup(t, { pin: P2 })
  assert.equal(service.channelState(INSTANCE), 'leaf-mismatch')
  await assert.rejects(
    () => service.send(request()),
    (error) => error.code === 'E_CHANNEL_LEAF_MISMATCH'
      && error.message === PROMPT_WORDING['channel.desktop.leafMismatch'],
  )
  assertZeroSpys(calls)
  // RPC 层也走三态映射，拒绝文案来自 PROMPT_WORDING。
  const res = await rpc.handleRpc(request())
  assert.equal(res.ok, false)
  assert.equal(res.error.code, 'E_CHANNEL_LEAF_MISMATCH')
  assert.equal(res.error.message, PROMPT_WORDING['channel.desktop.leafMismatch'])
  assert.equal(PROMPT_CODE_BY_KEY['channel.desktop.leafMismatch'], 'E_CHANNEL_LEAF_MISMATCH')
  assertZeroSpys(calls)
})

/* ---------------- 4. 坏标记 ---------------- */

test('L4 标记 leaf 缺失 / 空白 / 非法 ⇒ E_CHANNEL_UNVERIFIED，spy 全 0', async (t) => {
  const { service, markerPath, calls } = await setup(t)
  const base = { verifiedAt: 1000, instanceId: INSTANCE, verifier: 'operator' }
  for (const leaf of [undefined, '', '   ', 'not-hex', 'zz'.repeat(32)]) {
    await writeFile(markerPath, JSON.stringify(leaf === undefined ? base : { ...base, leafSha256: leaf }), 'utf8')
    assert.equal(service.channelState(INSTANCE), 'unverified', String(leaf))
    await assert.rejects(() => service.send(request()), (error) => error.code === 'E_CHANNEL_UNVERIFIED')
    assertZeroSpys(calls)
  }
})

/* ---------------- 5. 无 pin 不 TOFU ---------------- */

test('L5 无 pin（null / 空 / 非法）⇒ E_CHANNEL_UNVERIFIED，绝不把标记指纹当 pin', async (t) => {
  for (const pin of [null, '', 'invalid']) {
    const { service, markerPath, calls } = await setup(t, { pin })
    assert.equal(service.channelState(INSTANCE), 'unverified', String(pin))
    await assert.rejects(() => service.send(request()), (error) => error.code === 'E_CHANNEL_UNVERIFIED')
    assertZeroSpys(calls)
    assert.ok(calls.pinLookup > 0)
    // 标记文件没被自动补成 pin（没有写任何东西）。
    assert.match(await readFile(markerPath, 'utf8'), /leafSha256/)
  }
})

/* ---------------- 6. 轮换 ---------------- */

test('L6 pin 轮换后再次调用 ⇒ leaf-mismatch（不缓存上次成功）', async (t) => {
  const { service, setPin } = await setup(t, { pin: P1 })
  assert.equal(service.channelState(INSTANCE), 'verified')
  assert.equal(service.channelState(INSTANCE), 'verified')
  setPin(P2)
  assert.equal(service.channelState(INSTANCE), 'leaf-mismatch')
  await assert.rejects(() => service.send(request()), (error) => error.code === 'E_CHANNEL_LEAF_MISMATCH')
})

/* ---------------- 7. 跨实例 ---------------- */

test('L7 标记为实例 B 写、请求实例 A ⇒ E_CHANNEL_UNVERIFIED，spy 全 0', async (t) => {
  const { service, rpc, calls } = await setup(t, { markerInstance: OTHER })
  assert.equal(service.channelState(INSTANCE), 'unverified')
  await assert.rejects(() => service.send(request()), (error) => error.code === 'E_CHANNEL_UNVERIFIED')
  assertZeroSpys(calls)
  const res = await rpc.handleRpc(request())
  assert.equal(res.error.code, 'E_CHANNEL_UNVERIFIED')
  assertZeroSpys(calls)
})

/* ---------------- 8. 拒绝期间零文件 ---------------- */

test('L8 DARK 拒绝期间：真实默认 ledger/lease store 也不写任何文件', async (t) => {
  const dir = await mkdtemp(path.join(TMP_ROOT, 'leaf-dark-files-'))
  const homeDir = path.join(dir, 'home')
  const markerDir = path.join(dir, 'marker')
  await mkdir(markerDir, { recursive: true })
  const markerPath = path.join(markerDir, 'channel-verified.json')
  await writeFile(markerPath, JSON.stringify({
    verifiedAt: 1000, instanceId: INSTANCE, leafSha256: P1, verifier: 'operator',
  }), 'utf8')
  let pin = P2 // 先制造 leaf-mismatch
  const pins = { lookup: () => ({ fingerprint: pin }) }
  // 故意不注入 leases / ledger：走服务默认构造（指向 homeDir 下状态目录）。
  const service = createSessionPromptService({
    homeDir, markerPath, pins,
    instances: { get: () => ({ id: INSTANCE }) },
    grants: { isGranted: () => true },
    now: () => NOW,
  })
  const req = request()
  await assert.rejects(() => service.send(req), (error) => error.code === 'E_CHANNEL_LEAF_MISMATCH')
  pin = null // 再制造 unverified（无 pin）
  await assert.rejects(() => service.send(req), (error) => error.code === 'E_CHANNEL_UNVERIFIED')

  await assertNoDarkFiles(homeDir)
  await rm(dir, { recursive: true, force: true }).catch(() => {})
})

/* ---------------- 9. pin 源抛错也必须全函数 ---------------- */

test('L9 pin lookup 抛异常 ⇒ unverified（三态全函数），spy 全 0 且零文件', async (t) => {
  const dir = await mkdtemp(path.join(TMP_ROOT, 'leaf-throw-'))
  const homeDir = path.join(dir, 'home')
  const markerDir = path.join(dir, 'marker')
  await mkdir(markerDir, { recursive: true })
  const markerPath = path.join(markerDir, 'channel-verified.json')
  await writeFile(markerPath, JSON.stringify({
    verifiedAt: 1000, instanceId: INSTANCE, leafSha256: P1, verifier: 'operator',
  }), 'utf8')
  const calls = {
    pinLookup: 0, instance: 0, grant: 0, leaseLoad: 0, leaseUpsert: 0,
    ledgerLoad: 0, ledgerRecord: 0, delivery: 0, headReader: 0,
  }
  const pins = {
    lookup: () => {
      calls.pinLookup += 1
      throw new Error('pin-store-down')
    },
  }
  const service = createSessionPromptService({
    homeDir, markerPath, pins,
    instances: { get: () => { calls.instance += 1; return { id: INSTANCE } } },
    grants: { isGranted: () => { calls.grant += 1; return true } },
    now: () => NOW,
  })
  assert.equal(service.channelState(INSTANCE), 'unverified')
  assert.equal(service.channelVerified(INSTANCE), false)
  await assert.rejects(
    () => service.send(request()),
    (error) => error.code === 'E_CHANNEL_UNVERIFIED'
      && error.message === PROMPT_WORDING['channel.desktop.unverified'],
  )
  assert.ok(calls.pinLookup >= 2)
  assertZeroSpys(calls)
  await assertNoDarkFiles(homeDir)
  await rm(dir, { recursive: true, force: true }).catch(() => {})
})
