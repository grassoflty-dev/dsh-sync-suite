/**
 * mod-chat-lease：租约状态机 + 单键持久化测试（全部从 dist 导入，构建窗口打开后再跑）。
 *
 * 分组：A classify / B claim / C heartbeat / D release / E decidePromptWrite /
 *       F store（临时目录只在 packages/dsh-dots/.tmp 下，时钟注入）/ G 文案硬守卫 /
 *       H 全程零 console 输出。
 *
 * 零设备、零 live 插件状态：本文件不读不写任何插件 live 状态目录。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  LEASE_ENVELOPE_VERSION,
  LEASE_WORDING,
  claim,
  classifyLease,
  decodeLease,
  decodeLeases,
  decidePromptWrite,
  encodeLease,
  encodeLeases,
  expiredReclaimable,
  heartbeat,
  problemText,
  release,
} from '../dist/remote/lease.js'
import { createLeaseStore } from '../dist/remote/leaseStore.js'

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP_ROOT = path.join(PKG, '.tmp')
const NOW = 5000
const TTL = 600
const SHA = 'a'.repeat(64)
const OTHER_SHA = 'b'.repeat(64)

function makeLease(overrides = {}) {
  return {
    v: LEASE_ENVELOPE_VERSION,
    sessionId: 's-1',
    instanceId: 'inst-0123456789abcdef',
    owner: 'dots',
    ttlSec: TTL,
    expiresAt: NOW + TTL,
    headSha: SHA,
    ...overrides,
  }
}

async function tempDir(t) {
  await mkdir(TMP_ROOT, { recursive: true })
  const dir = await mkdtemp(path.join(TMP_ROOT, 'lease-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  })
  return dir
}

function makeStore(dir, overrides = {}) {
  let clock = NOW
  const store = createLeaseStore({
    filePath: path.join(dir, 'leases.json'),
    now: () => clock,
    ...overrides,
  })
  return { store, setClock: (value) => { clock = value } }
}

/* 全程捕获 console（模块级 patch，文件末尾的 H1 断言零命中）。 */
const consoleKeys = ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'table']
const savedConsole = {}
const consoleHits = []
for (const key of consoleKeys) {
  savedConsole[key] = console[key]
  console[key] = (...args) => {
    consoleHits.push({ key, args: args.map((item) => String(item)) })
  }
}
after(() => {
  for (const key of consoleKeys) console[key] = savedConsole[key]
})

/* ------------------------ A. classifyLease ------------------------ */

test('A1 classify: 无租约 ⇒ FREE', () => {
  assert.equal(classifyLease(null, 'dots', NOW), 'FREE')
  assert.equal(classifyLease(undefined, 'dots', NOW), 'FREE')
})

test('A2 classify: 坏租约（缺字段 / 错版本 / 未知字段）⇒ FREE', () => {
  assert.equal(classifyLease({ ...makeLease(), headSha: '' }, 'dots', NOW), 'FREE')
  assert.equal(classifyLease({ ...makeLease(), v: 99 }, 'dots', NOW), 'FREE')
  assert.equal(classifyLease({ ...makeLease(), token: 'x' }, 'dots', NOW), 'FREE')
  assert.equal(classifyLease('not-an-object', 'dots', NOW), 'FREE')
})

test('A3 classify: 本人未过期 ⇒ HELD', () => {
  assert.equal(classifyLease(makeLease(), 'dots', NOW), 'HELD')
  assert.equal(classifyLease(makeLease(), 'dots', NOW + TTL - 1), 'HELD')
})

test('A4 classify: 他人未过期 ⇒ OBSERVING', () => {
  assert.equal(classifyLease(makeLease({ owner: 'pc-a' }), 'dots', NOW), 'OBSERVING')
})

test('A5 classify: 过期（本人 / 他人）⇒ FREE，回收标记只给本人', () => {
  const at = NOW + TTL
  assert.equal(classifyLease(makeLease(), 'dots', at), 'FREE')
  assert.equal(classifyLease(makeLease({ owner: 'pc-a' }), 'dots', at), 'FREE')
  assert.equal(expiredReclaimable(makeLease(), 'dots', at), true)
  assert.equal(expiredReclaimable(makeLease({ owner: 'pc-a' }), 'dots', at), false)
  assert.equal(expiredReclaimable(makeLease(), 'dots', at - 1), false)
})

test('A6 classify: nowMs 非法 ⇒ OBSERVING（无法证明过期，绝不抢）', () => {
  assert.equal(classifyLease(makeLease(), 'dots', Number.NaN), 'OBSERVING')
  assert.equal(classifyLease(null, 'dots', Number.NaN), 'FREE')
})

/* ------------------------ B. claim ------------------------ */

test('B1 claim: 空表可抢，写入请求字段与到期时刻', () => {
  const result = claim(null, {
    sessionId: 's-1', instanceId: 'inst-0123456789abcdef', owner: 'dots',
    ttlSec: TTL, headSha: SHA, nowMs: NOW,
  })
  assert.equal(result.ok, true)
  assert.equal(result.reclaimed, false)
  assert.deepEqual(result.lease, makeLease())
})

test('B2 claim: 过期租约可接管且 reclaimed=true（含他人租约）', () => {
  const stale = makeLease({ owner: 'pc-a', expiresAt: NOW - 1 })
  const result = claim(stale, {
    sessionId: 's-1', instanceId: 'inst-0123456789abcdef', owner: 'dots',
    ttlSec: TTL, headSha: OTHER_SHA, nowMs: NOW,
  })
  assert.equal(result.ok, true)
  assert.equal(result.reclaimed, true)
  assert.equal(result.lease.owner, 'dots')
  assert.equal(result.lease.expiresAt, NOW + TTL)
})

test('B3 claim: 他人未过期（OBSERVING）绝不抢', () => {
  const result = claim(makeLease({ owner: 'pc-a' }), {
    sessionId: 's-1', instanceId: 'inst-0123456789abcdef', owner: 'dots',
    ttlSec: TTL, headSha: SHA, nowMs: NOW,
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'E_LEASE_OBSERVING')
  assert.equal(result.wording, LEASE_WORDING.E_LEASE_OBSERVING)
})

test('B4 claim: 同 owner 未过期是幂等 no-op（不借机续期）', () => {
  const held = makeLease()
  const req = {
    sessionId: 's-1', instanceId: 'inst-0123456789abcdef', owner: 'dots',
    ttlSec: TTL, headSha: OTHER_SHA, nowMs: NOW + 100,
  }
  const first = claim(held, req)
  const second = claim(first.lease, req)
  assert.equal(first.ok, true)
  assert.equal(first.reclaimed, false)
  assert.deepEqual(first.lease, held)
  assert.deepEqual(second, first)
})

test('B5 claim: 非法请求（ttlSec=0 / nowMs 非法）typed 拒绝', () => {
  const req = {
    sessionId: 's-1', instanceId: 'inst-0123456789abcdef', owner: 'dots',
    ttlSec: 0, headSha: SHA, nowMs: NOW,
  }
  assert.equal(claim(null, req).code, 'E_LEASE_NOT_HELD')
  assert.equal(claim(null, { ...req, ttlSec: TTL, nowMs: Number.NaN }).code, 'E_LEASE_NOT_HELD')
})

test('B6 claim: sessionId 不匹配视为无本会话租约（不误报 reclaimed）', () => {
  const result = claim(makeLease({ sessionId: 's-other', expiresAt: 1 }), {
    sessionId: 's-1', instanceId: 'inst-0123456789abcdef', owner: 'dots',
    ttlSec: TTL, headSha: SHA, nowMs: NOW,
  })
  assert.equal(result.ok, true)
  assert.equal(result.reclaimed, false)
})

/* ------------------------ C. heartbeat ------------------------ */

test('C1 heartbeat: owner（dots）未过期可续期，headSha 不变', () => {
  const result = heartbeat(makeLease(), NOW + 100, TTL)
  assert.equal(result.ok, true)
  assert.equal(result.lease.expiresAt, NOW + 100 + TTL)
  assert.equal(result.lease.headSha, SHA)
  assert.equal(result.lease.owner, 'dots')
})

test('C2 heartbeat: 他人租约被拒（未过期 OBSERVING）', () => {
  const result = heartbeat(makeLease({ owner: 'pc-a' }), NOW, TTL)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'E_LEASE_OBSERVING')
})

test('C3 heartbeat: 已过期租约 typed 拒绝，必须重新 claim', () => {
  const result = heartbeat(makeLease(), NOW + TTL, TTL)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'E_LEASE_EXPIRED')
  assert.equal(result.wording, LEASE_WORDING.E_LEASE_EXPIRED)
})

test('C4 heartbeat: 坏租约 / 非法 nowMs 拒绝', () => {
  assert.equal(heartbeat({ ...makeLease(), headSha: '' }, NOW, TTL).code, 'E_LEASE_NOT_HELD')
  assert.equal(heartbeat(makeLease(), Number.NaN, TTL).code, 'E_LEASE_EXPIRED')
})

/* ------------------------ D. release ------------------------ */

test('D1 release: owner 释放 ⇒ ok + null', () => {
  assert.deepEqual(release(makeLease(), 'dots'), { ok: true, lease: null })
})

test('D2 release: 他人 / 非 dots principal 均被拒', () => {
  assert.equal(release(makeLease(), 'pc-a').ok, false)
  assert.equal(release(makeLease(), 'pc-a').code, 'E_LEASE_NOT_HELD')
  assert.equal(release(makeLease({ owner: 'pc-a' }), 'pc-a').ok, false)
})

test('D3 release: 空租约与空释放幂等', () => {
  assert.deepEqual(release(null, 'dots'), { ok: true, lease: null })
  assert.deepEqual(release(undefined, 'dots'), { ok: true, lease: null })
})

test('D4 release: 坏租约 typed 拒绝', () => {
  assert.equal(release({ ...makeLease(), v: 2 }, 'dots').ok, false)
})

/* ------------------------ E. decidePromptWrite ------------------------ */

const promptReq = (overrides = {}) => ({
  owner: 'dots', expectedPrevSha: SHA, actualHeadSha: SHA, nowMs: NOW, ...overrides,
})

test('E1 decide: HELD + 头锚一致 ⇒ ok', () => {
  assert.deepEqual(decidePromptWrite(makeLease(), promptReq()), { ok: true })
})

test('E2 decide: 无租约 / 坏租约 ⇒ E_LEASE_NOT_HELD', () => {
  assert.equal(decidePromptWrite(null, promptReq()).code, 'E_LEASE_NOT_HELD')
  assert.equal(decidePromptWrite({ ...makeLease(), v: 2 }, promptReq()).code, 'E_LEASE_NOT_HELD')
})

test('E3 decide: 他人未过期 ⇒ E_LEASE_OBSERVING（一个字节不写）', () => {
  const result = decidePromptWrite(makeLease({ owner: 'pc-a' }), promptReq())
  assert.equal(result.code, 'E_LEASE_OBSERVING')
  assert.equal(result.wording, LEASE_WORDING.E_LEASE_OBSERVING)
})

test('E4 decide: 本人租约已过期 ⇒ E_LEASE_EXPIRED', () => {
  const result = decidePromptWrite(makeLease({ expiresAt: NOW - 1 }), promptReq())
  assert.equal(result.code, 'E_LEASE_EXPIRED')
})

test('E5 decide: 租约有效但头锚不符 ⇒ E_HEAD_MOVED（绝不覆盖并发写入）', () => {
  const result = decidePromptWrite(makeLease(), promptReq({ actualHeadSha: OTHER_SHA }))
  assert.equal(result.code, 'E_HEAD_MOVED')
  assert.equal(result.wording, LEASE_WORDING.E_HEAD_MOVED)
})

test('E6 decide: owner !== dots（human owner，租约匹配）永不授予', () => {
  const liveHumanLease = makeLease({ owner: 'pc-a', expiresAt: NOW + TTL })
  const result = decidePromptWrite(liveHumanLease, promptReq({ owner: 'pc-a' }))
  assert.equal(result.ok, false)
  assert.equal(result.code, 'E_LEASE_OBSERVING')
  // 即使人已过期，也不允许 dots 以 human principal 身份续写。
  assert.equal(decidePromptWrite(makeLease({ owner: 'pc-a', expiresAt: 1 }),
    promptReq({ owner: 'pc-a' })).ok, false)
})

test('E7 decide: owner !== dots 且无租约 ⇒ E_LEASE_NOT_HELD', () => {
  assert.equal(decidePromptWrite(null, promptReq({ owner: 'pc-a' })).code, 'E_LEASE_NOT_HELD')
})

test('E8 decide: owner !== dots 即使 lease.owner === dots 也不授予', () => {
  const result = decidePromptWrite(makeLease(), promptReq({ owner: 'pc-a' }))
  assert.equal(result.ok, false)
  assert.equal(result.code, 'E_LEASE_OBSERVING')
})

test('E9 decide: 头锚缺失 ⇒ E_HEAD_MOVED（无法证明未被覆盖）', () => {
  assert.equal(decidePromptWrite(makeLease(), promptReq({ expectedPrevSha: '' })).code, 'E_HEAD_MOVED')
  assert.equal(decidePromptWrite(makeLease(), promptReq({ actualHeadSha: undefined })).code, 'E_HEAD_MOVED')
})

/* ------------------------ F. store ------------------------ */

test('F1 encode/decode 单条：固定键顺序，逐字节往返', () => {
  const lease = makeLease()
  const encoded = encodeLease(lease)
  assert.equal(encoded, JSON.stringify(lease))
  assert.deepEqual(decodeLease(encoded), { ok: true, lease, problem: null, reason: '' })
  assert.equal(decodeLease(null).problem, 'E_LEASE_ENVELOPE_EMPTY')
})

test('F2 encode/decode 整表：{v:1,items} 确定性排序 + 逐字节往返', () => {
  const a = makeLease({ sessionId: 's-2', headSha: 'c'.repeat(64) })
  const b = makeLease({ sessionId: 's-1', headSha: SHA })
  const encoded = encodeLeases([a, b])
  assert.equal(encoded, JSON.stringify({ v: 1, items: [b, a] }))
  const decoded = decodeLeases(encoded)
  assert.equal(decoded.ok, true)
  assert.deepEqual(decoded.leases, [b, a])
})

test('F3 store: save → load 往返，lastProblem 归零', async (t) => {
  const dir = await tempDir(t)
  const { store } = makeStore(dir)
  await store.save([makeLease(), makeLease({ sessionId: 's-2' })])
  const loaded = await store.load()
  assert.equal(loaded.ok, true)
  assert.deepEqual(loaded.leases, [makeLease(), makeLease({ sessionId: 's-2' })])
  assert.equal(loaded.problem, null)
  assert.equal(store.lastProblem(), null)
})

test('F4 store: 原子写不留临时文件', async (t) => {
  const dir = await tempDir(t)
  const { store } = makeStore(dir)
  await store.save([makeLease()])
  assert.deepEqual((await readdir(dir)).sort(), ['leases.json'])
  const onDisk = await readFile(store.file, 'utf8')
  assert.equal(onDisk, encodeLeases([makeLease()]))
})

test('F5 store: 坏 JSON ⇒ 空表 + typed problem（不抛）', async (t) => {
  const dir = await tempDir(t)
  const { store } = makeStore(dir)
  await writeFile(store.file, '{oops', 'utf8')
  const loaded = await store.load()
  assert.equal(loaded.ok, false)
  assert.deepEqual(loaded.leases, [])
  assert.equal(loaded.problem, 'E_LEASE_ENVELOPE_JSON')
})

test('F6 store: 错版本 / 未知字段 ⇒ 空表 + typed problem', async (t) => {
  const dir = await tempDir(t)
  const { store } = makeStore(dir)
  await writeFile(store.file, JSON.stringify({ v: 2, items: [] }), 'utf8')
  assert.equal((await store.load()).problem, 'E_LEASE_ENVELOPE_VERSION')
  await writeFile(store.file, JSON.stringify({
    v: 1, items: [{ ...makeLease(), surprise: 1 }],
  }), 'utf8')
  const loaded = await store.load()
  assert.equal(loaded.problem, 'E_LEASE_ENVELOPE_ITEM')
  assert.deepEqual(loaded.leases, [])
})

test('F7 store: upsert 按 sessionId 替换，remove 删除，空表幂等', async (t) => {
  const dir = await tempDir(t)
  const { store } = makeStore(dir)
  const first = await store.upsert(makeLease())
  assert.equal(first.ok, true)
  assert.equal(first.leases.length, 1)
  const updated = await store.upsert(makeLease({ headSha: OTHER_SHA, expiresAt: 9999 }))
  assert.equal(updated.leases.length, 1)
  assert.equal(updated.leases[0].headSha, OTHER_SHA)
  const added = await store.upsert(makeLease({ sessionId: 's-2' }))
  assert.equal(added.leases.length, 2)
  const removed = await store.remove('s-1')
  assert.deepEqual(removed.leases.map((item) => item.sessionId), ['s-2'])
  assert.equal((await store.remove('missing')).ok, true)
})

test('F8 store: 坏信封上 upsert/remove 拒绝且不覆写原字节', async (t) => {
  const dir = await tempDir(t)
  const { store } = makeStore(dir)
  const corrupt = JSON.stringify({ v: 9, items: [] })
  await writeFile(store.file, corrupt, 'utf8')
  assert.equal((await store.upsert(makeLease())).ok, false)
  assert.equal((await store.remove('s-1')).ok, false)
  assert.equal(await readFile(store.file, 'utf8'), corrupt)
})

test('F9 store: save 拒绝坏记录且不写盘（显式 typed 错误）', async (t) => {
  const dir = await tempDir(t)
  const { store } = makeStore(dir)
  await assert.rejects(
    () => store.save([{ ...makeLease(), headSha: '' }]),
    (error) => error.code === 'E_LEASE_HEAD_SHA',
  )
  assert.equal((await store.load()).leases.length, 0)
})

test('F10 store: 0600 权限（POSIX；Windows 不适用则跳过）', async (t) => {
  if (process.platform === 'win32') return t.skip('Windows 无 POSIX 0600 语义')
  const dir = await tempDir(t)
  const { store } = makeStore(dir)
  await store.save([makeLease()])
  const { mode } = await import('node:fs').then((fs) => fs.promises.stat(store.file))
  assert.equal(mode & 0o777, 0o600)
})

test('F11 store: 注入时钟只影响临时文件名，不参与决策', async (t) => {
  const dir = await tempDir(t)
  const { store, setClock } = makeStore(dir)
  setClock(12345678)
  await store.save([makeLease()])
  assert.deepEqual((await readdir(dir)).sort(), ['leases.json'])
  // 决策仍用显式 nowMs：过期判定不受 store 时钟影响。
  assert.equal(classifyLease(makeLease(), 'dots', NOW), 'HELD')
})

test('F12 decodeLeases: 空串 / 数组 / 非对象信封 fail-closed', () => {
  assert.equal(decodeLeases('').problem, 'E_LEASE_ENVELOPE_EMPTY')
  assert.equal(decodeLeases('[]').problem, 'E_LEASE_ENVELOPE_SHAPE')
  assert.equal(decodeLeases('null').problem, 'E_LEASE_ENVELOPE_SHAPE')
  assert.equal(decodeLeases(JSON.stringify({ v: 1 })).problem, 'E_LEASE_ENVELOPE_SHAPE')
})

/* ------------------------ G. 文案守卫 ------------------------ */

test('G1 LEASE_WORDING 四码逐字固定', () => {
  assert.deepEqual({ ...LEASE_WORDING }, {
    E_LEASE_NOT_HELD: '未持有该会话的写权限，未写入任何内容',
    E_LEASE_OBSERVING: '该会话正被其他人使用（只读），未写入任何内容',
    E_LEASE_EXPIRED: '会话写权限已过期，请重新确认后重试',
    E_HEAD_MOVED: '会话头已变化（可能来自其他写者，也可能来自你上一次写入），请先刷新再重新确认',
  })
})

test('G2 所有文案无 token / URL / 路径 / 16 位以上 hex', () => {
  const texts = [...Object.values(LEASE_WORDING)]
  for (const code of ['E_LEASE_SHAPE', 'E_LEASE_ENVELOPE_JSON', 'E_LEASE_STORAGE_UNAVAILABLE']) {
    texts.push(problemText(code))
  }
  for (const text of texts) {
    assert.equal(text.includes('/'), false, text)
    assert.equal(text.includes('\\'), false, text)
    assert.equal(text.toLowerCase().includes('token'), false, text)
    assert.equal(text.toLowerCase().includes('bearer'), false, text)
    assert.equal(/[0-9a-f]{16,}/i.test(text), false, text)
  }
})

/* ------------------------ H. 零 console ------------------------ */

test('H1 整个套件零 console 输出（模块与 store 均不打印）', () => {
  assert.deepEqual(consoleHits, [])
})
