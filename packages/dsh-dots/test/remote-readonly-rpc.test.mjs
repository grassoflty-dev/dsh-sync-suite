/**
 * mod-plugin-remote-tools：四个只读 RPC action 的行为测试。
 *
 * 注入假实例表 / 假授权表 / 假 HTTP 层，覆盖 happy path、五类 typed 拒绝、
 * "无命令 action 注册"、caller URL 不可绕过 allow-list、token 不出错误体。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRpcService } from '../dist/rpc.js'
import { GrantStore } from '../dist/remote/grants.js'
import { InstanceRegistry } from '../dist/remote/instances.js'
import { PROJECTED_KEY_SETS, projectReadResult } from '../dist/remote/projection.js'

const INSTANCE = 'inst-0123456789abcdef'
const UNKNOWN = 'inst-aaaaaaaaaaaaaaaa'
const NOW = 5000
const BASE = 'http://127.0.0.1:40596/?token=TOPSECRET123456'

/** 假响应：提供可观测的流读取器与 Content-Length；json() 故意不可用（调用即视为绕过字节上限）。 */
function responseLike(status, body, options = {}) {
  const bytes = Buffer.from(JSON.stringify(body), 'utf8')
  const headers = options.headers ?? {}
  let reads = 0
  let cancelled = false
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    body: {
      getReader() {
        return {
          async read() {
            reads += 1
            return reads === 1 ? { done: false, value: new Uint8Array(bytes) } : { done: true }
          },
          async cancel() { cancelled = true },
          releaseLock() { /* 假实现无需释放 */ },
        }
      },
    },
    arrayBuffer: async () => new Uint8Array(bytes).buffer,
    json: async () => { throw new Error('json() must not be called') },
    __state: { reads: () => reads, cancelled: () => cancelled },
  }
}

function jsonResponse(status, body, options) {
  return responseLike(status, body, options)
}

/** 与 src/rpc.ts 的 REMOTE_RESPONSE_MAX_BYTES 保持一致（4 MiB）。 */
const RESPONSE_CAP = 4 * 1024 * 1024

/** 造一个超大原始响应体；不实现 json()，确保超限时不会被解析。 */
function oversizedResponse(options = {}) {
  const bytes = new Uint8Array(RESPONSE_CAP + 64)
  bytes.fill(0x41) // 'A'，便于断言响应体绝不被回显
  let reads = 0
  let cancelled = false
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => (options.headers ?? {})[name.toLowerCase()] ?? null },
    body: {
      getReader() {
        return {
          async read() {
            reads += 1
            return reads === 1 ? { done: false, value: bytes } : { done: true }
          },
          async cancel() { cancelled = true },
          releaseLock() { /* noop */ },
        }
      },
    },
    arrayBuffer: async () => bytes.buffer,
    json: async () => { throw new Error('json() must not be called') },
    __state: { reads: () => reads, cancelled: () => cancelled },
  }
}

/** 假 HTTP 层默认按 action 给出合法只读载荷。 */
function defaultBody(init) {
  const payload = JSON.parse(init.body)
  if (payload.action === 'sessionList') {
    return { ok: true, data: { items: [{ sessionId: 's1', title: '标题', sha256: 'aaa', lease: null }], nextCursor: '' } }
  }
  if (payload.action === 'sessionInfo') {
    return { ok: true, data: { sessionId: 's1', sha256: 'abc', lease: null, owner: null } }
  }
  return { ok: true, data: { events: [{ seq: 1, type: 'turn/end' }], nextSeq: 2, sha256: 'abc' } }
}

async function setup(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'remote-readonly-'))
  const homeDir = path.join(root, 'home')
  const profileDir = path.join(root, 'profile')
  await mkdir(profileDir, { recursive: true })
  const instances = new InstanceRegistry({ homeDir })
  instances.upsert({ id: INSTANCE, baseUrl: BASE, mode: 'lan', displayName: 'pc-b' })
  const grants = new GrantStore({ homeDir, now: () => new Date(NOW) })
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    if (typeof options.respond === 'function') return options.respond(url, init)
    return jsonResponse(200, defaultBody(init))
  }
  const service = createRpcService({
    homeDir,
    profileDir,
    dshVersion: 'test-1',
    allowLocalRepo: true,
    now: () => new Date(NOW),
    remoteTools: { instances, grants, fetch: fetchImpl },
  })
  t.after(async () => {
    await service.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  })
  return { service, instances, grants, calls, homeDir }
}

/** 给某实例授予一组工具（显式 tools，view 与 command 分开）。 */
function addGrant(grants, tools, instanceId = INSTANCE) {
  const ok = grants.upsert({
    grantId: `g-${tools.join('_')}-${instanceId}`,
    instanceId,
    principal: 'dots',
    tools,
    grantedAt: 1000,
  })
  assert.equal(ok, true)
}

test('instanceList：只列有授权的实例，地址打码、能力来自 grant', async (t) => {
  const { service, grants } = await setup(t)
  addGrant(grants, ['instance.list'])
  addGrant(grants, ['instance.list', 'session.list'], 'local')
  const result = await service.handleRpc({ action: 'instanceList' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.data.instances.map((i) => i.id), ['local', INSTANCE])
  const remote = result.data.instances.find((i) => i.id === INSTANCE)
  assert.equal(remote.capabilities.includes('sessionList'), false, '只有 session.list 授权不该出现在 instance.list 结果的能力外')
  assert.equal(remote.urlMasked.includes('TOPSECRET123456'), false, '返回体不得含 token')
  assert.equal(remote.urlMasked.startsWith('http://12'), true, '主机被打码')
  const local = result.data.instances.find((i) => i.id === 'local')
  assert.deepEqual(local.capabilities, ['sessionList'])
})

test('instanceList：无授权的实例完全不出现在列表里（fail-closed）', async (t) => {
  const { service, grants } = await setup(t)
  addGrant(grants, ['instance.list'], 'local')
  const result = await service.handleRpc({ action: 'instanceList' })
  assert.deepEqual(result.data.instances.map((i) => i.id), ['local'])
})

test('sessionList happy path：走假 HTTP 层，结果带来源 instanceId', async (t) => {
  const { service, grants, calls } = await setup(t)
  addGrant(grants, ['session.list'])
  const result = await service.handleRpc({ action: 'sessionList', instanceId: INSTANCE, limit: 5 })
  assert.equal(result.ok, true)
  assert.equal(result.data.items[0].instanceId, INSTANCE)
  assert.equal(result.data.items[0].sessionId, 's1')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'http://127.0.0.1:40596/dsh-dots/rpc')
  const sent = JSON.parse(calls[0].init.body)
  assert.equal(sent.action, 'sessionList')
  assert.equal(sent.instanceId, 'local', '对端只读自己的 local，避免递归')
  assert.equal(sent.limit, 5)
})

test('sessionInfo happy path：sessionId 转发，响应带 instanceId', async (t) => {
  const { service, grants, calls } = await setup(t)
  addGrant(grants, ['session.info'])
  const result = await service.handleRpc({ action: 'sessionInfo', instanceId: INSTANCE, sessionId: 's1' })
  assert.equal(result.ok, true)
  assert.equal(result.data.instanceId, INSTANCE)
  assert.equal(result.data.sha256, 'abc')
  assert.equal(JSON.parse(calls[0].init.body).sessionId, 's1')
})

test('sessionEvents happy path：fromSeq / limit 转发，事件按白名单投影', async (t) => {
  const { service, grants, calls } = await setup(t)
  addGrant(grants, ['session.events'])
  const result = await service.handleRpc({ action: 'sessionEvents', instanceId: INSTANCE, sessionId: 's1', fromSeq: 3, limit: 20 })
  assert.equal(result.ok, true)
  assert.equal(result.data.instanceId, INSTANCE)
  assert.equal(result.data.nextSeq, 2)
  const sent = JSON.parse(calls[0].init.body)
  assert.equal(sent.fromSeq, 3)
  assert.equal(sent.limit, 20)
})

test('拒绝① 未知实例 → E_INSTANCE_UNKNOWN（与未授权可区分）', async (t) => {
  const { service } = await setup(t)
  const result = await service.handleRpc({ action: 'sessionList', instanceId: UNKNOWN })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'E_INSTANCE_UNKNOWN')
  assert.equal(result.error.details.instanceId, UNKNOWN)
})

test('拒绝② 未授权 → E_GRANT_DENIED（带工具 id）', async (t) => {
  const { service } = await setup(t)
  const result = await service.handleRpc({ action: 'sessionList', instanceId: INSTANCE })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'E_GRANT_DENIED')
  assert.equal(result.error.details.tool, 'session.list')
})

test('拒绝③ 不可达 / 超时 → E_REMOTE_UNREACHABLE', async (t) => {
  const { service, grants } = await setup(t, { respond: async () => { throw new Error('ECONNRESET') } })
  addGrant(grants, ['session.list'])
  const result = await service.handleRpc({ action: 'sessionList', instanceId: INSTANCE })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'E_REMOTE_UNREACHABLE')
})

test('拒绝④ 鉴权被拒（401/403）→ E_REMOTE_AUTH_REJECTED', async (t) => {
  const { service, grants } = await setup(t, { respond: async () => jsonResponse(403, {}) })
  addGrant(grants, ['session.list'])
  const result = await service.handleRpc({ action: 'sessionList', instanceId: INSTANCE })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'E_REMOTE_AUTH_REJECTED')
  assert.equal(result.error.details.status, 403)
})

test('拒绝⑤ 不支持的动作（404 / 远端 E_UNKNOWN_ACTION）→ E_REMOTE_UNSUPPORTED', async (t) => {
  const a = await setup(t, { respond: async () => jsonResponse(404, {}) })
  addGrant(a.grants, ['session.list'])
  const r1 = await a.service.handleRpc({ action: 'sessionList', instanceId: INSTANCE })
  assert.equal(r1.error.code, 'E_REMOTE_UNSUPPORTED')

  const b = await setup(t, { respond: async () => jsonResponse(200, { ok: false, error: { code: 'E_UNKNOWN_ACTION' } }) })
  addGrant(b.grants, ['session.list'])
  const r2 = await b.service.handleRpc({ action: 'sessionList', instanceId: INSTANCE })
  assert.equal(r2.error.code, 'E_REMOTE_UNSUPPORTED')
})

test('显式测试：prompt / create / lease / grant 写动作一个都没注册', async (t) => {
  const { service } = await setup(t)
  const commandActions = [
    'sessionPrompt', 'sessionCreate', 'sessionLeaseClaim', 'sessionLeaseHeartbeat',
    'sessionLeaseRelease', 'grantList', 'grantUpsert', 'grantRevoke',
  ]
  for (const action of commandActions) {
    const result = await service.handleRpc({ action, instanceId: INSTANCE, sessionId: 's1' })
    assert.equal(result.ok, false, `${action} 不应注册`)
    assert.equal(result.error.code, 'E_UNKNOWN_ACTION', action)
  }
})

test('caller 提供的 URL 无法绕过 allow-list：出网目标只来自实例清单', async (t) => {
  const { service, grants, calls } = await setup(t)
  addGrant(grants, ['session.list'])
  const result = await service.handleRpc({
    action: 'sessionList',
    instanceId: INSTANCE,
    url: 'http://attacker.example/steal',
    baseUrl: 'http://attacker.example/steal',
  })
  assert.equal(result.ok, true)
  assert.equal(calls[0].url, 'http://127.0.0.1:40596/dsh-dots/rpc')
  assert.equal(calls[0].init.body.includes('attacker.example'), false)
})

test('token 不出现在任何错误体 / details / 出网请求里', async (t) => {
  const { service, grants, calls } = await setup(t, {
    respond: async () => ({ ok: false, status: 403, json: async () => ({ ok: false, error: { code: 'E_REMOTE_AUTH_REJECTED', message: 'token=TOPSECRET123456' } }) }),
  })
  addGrant(grants, ['session.info'])
  const result = await service.handleRpc({ action: 'sessionInfo', instanceId: INSTANCE, sessionId: 's1' })
  assert.equal(result.error.code, 'E_REMOTE_AUTH_REJECTED')
  assert.equal(JSON.stringify(result.error).includes('TOPSECRET123456'), false)
  assert.equal(calls[0].init.body.includes('TOPSECRET123456'), false)
  assert.equal(calls[0].init.headers['content-type'], 'application/json')
})

test('坏响应体 → E_REMOTE_BAD_RESPONSE（与不可达 / 鉴权拒绝区分）', async (t) => {
  const { service, grants } = await setup(t, { respond: async () => jsonResponse(200, { nonsense: true }) })
  addGrant(grants, ['session.list'])
  const result = await service.handleRpc({ action: 'sessionList', instanceId: INSTANCE })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'E_REMOTE_BAD_RESPONSE')
})

/* ---------------- M1：响应体字节上限 ---------------- */

test('M1：正确 Content-Length 超上限 → E_REMOTE_TOO_LARGE，零读取 / 不解析 / 不回显', async (t) => {
  const resp = oversizedResponse({ headers: { 'content-length': String(RESPONSE_CAP + 64) } })
  const { service, grants } = await setup(t, { respond: async () => resp })
  addGrant(grants, ['session.list'])
  const result = await service.handleRpc({ action: 'sessionList', instanceId: INSTANCE })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'E_REMOTE_TOO_LARGE')
  assert.equal(result.error.details.limit, RESPONSE_CAP)
  assert.equal(resp.__state.reads(), 0, 'Content-Length 超限时一字节都不该读')
  assert.equal(JSON.stringify(result.error).includes('AAAA'), false, '响应体绝不回显')
})

test('M1：缺失或撒谎的 Content-Length → 分块累计真实字节后 typed 拒绝并 cancel', async (t) => {
  for (const headers of [{}, { 'content-length': '16' }]) {
    const resp = oversizedResponse({ headers })
    const { service, grants } = await setup(t, { respond: async () => resp })
    addGrant(grants, ['session.list'])
    const result = await service.handleRpc({ action: 'sessionList', instanceId: INSTANCE })
    assert.equal(result.error.code, 'E_REMOTE_TOO_LARGE', JSON.stringify(headers))
    assert.equal(resp.__state.reads(), 1, '第一块就越界，应立即停')
    assert.equal(resp.__state.cancelled(), true, '越界必须 cancel 响应流')
    assert.equal(JSON.stringify(result.error).includes('AAAA'), false)
  }
})

/* ---------------- M2：本地 / 远端共用白名单投影 ---------------- */

test('M2：peer 多塞的字段被剥掉（sessionList 精确键集）', async (t) => {
  const payload = { ok: true, data: {
    items: [{
      sessionId: 's1', title: 't', updatedAt: 'u', messageCount: 1, sha256: 'h', lease: null,
      token: 'PEER_TOKEN', apiKey: 'K', path: '../../etc/passwd', extra: [1, 2],
    }],
    nextCursor: 'c', token: 'TOP', extraArray: [1, 2, 3],
  } }
  const { service, grants } = await setup(t, { respond: async () => jsonResponse(200, payload) })
  addGrant(grants, ['session.list'])
  const result = await service.handleRpc({ action: 'sessionList', instanceId: INSTANCE })
  assert.equal(result.ok, true)
  assert.deepEqual(Object.keys(result.data).sort(), [...PROJECTED_KEY_SETS.sessionList].sort())
  assert.deepEqual(Object.keys(result.data.items[0]).sort(), [
    'instanceId', 'lease', 'messageCount', 'sessionId', 'sha256', 'title', 'updatedAt',
  ])
  const text = JSON.stringify(result.data)
  for (const bad of ['PEER_TOKEN', 'TOP', '../../etc/passwd', 'apiKey', 'extraArray', 'extra']) {
    assert.equal(text.includes(bad), false, `不应出现的字段：${bad}`)
  }
  assert.equal(result.data.items[0].instanceId, INSTANCE, '来源由本地强制覆盖，不信 peer 自报')
})

test('M2：sessionInfo / sessionEvents 精确键集，peer 附加字段与嵌套对象全丢', async (t) => {
  const a = await setup(t, { respond: async () => jsonResponse(200, { ok: true, data: {
    instanceId: 'peer-lie', sessionId: 's1', sha256: 'h',
    lease: { owner: 'bad', token: 'x' }, owner: 'peer', token: 'T', path: '../..',
  } }) })
  addGrant(a.grants, ['session.info'])
  const info = await a.service.handleRpc({ action: 'sessionInfo', instanceId: INSTANCE, sessionId: 's1' })
  assert.equal(info.ok, true)
  assert.deepEqual(Object.keys(info.data).sort(), [...PROJECTED_KEY_SETS.sessionInfo].sort())
  assert.equal(info.data.instanceId, INSTANCE)
  assert.equal(info.data.lease, null, '嵌套 lease 不可信，强制 null')
  assert.equal(info.data.owner, null)
  assert.equal(JSON.stringify(info.data).includes('peer-lie'), false)

  const b = await setup(t, { respond: async () => jsonResponse(200, { ok: true, data: {
    instanceId: 'peer-lie', nextSeq: 2, sha256: 'h', extra: [1],
    events: [{ seq: 1, time: 't', type: 'x', text: 'hello', token: 'T', data: { cwd: '/etc' } }],
  } }) })
  addGrant(b.grants, ['session.events'])
  const events = await b.service.handleRpc({ action: 'sessionEvents', instanceId: INSTANCE, sessionId: 's1' })
  assert.equal(events.ok, true)
  assert.deepEqual(Object.keys(events.data).sort(), [...PROJECTED_KEY_SETS.sessionEvents].sort())
  assert.deepEqual(Object.keys(events.data.events[0]).sort(), ['seq', 'text', 'time', 'type'])
  assert.equal(JSON.stringify(events.data).includes('/etc'), false)
})

test('M2：本机与远端同一逻辑载荷经同一投影函数 → 结构同形', () => {
  const facts = {
    items: [{ sessionId: 's1', title: 't', updatedAt: 'u', messageCount: 1, sha256: 'h', instanceId: 'local', lease: null }],
    nextCursor: 'c',
  }
  const localShape = projectReadResult('sessionList', facts, 'local')
  const remoteShape = projectReadResult('sessionList', facts, INSTANCE)
  assert.deepEqual(Object.keys(localShape).sort(), Object.keys(remoteShape).sort())
  assert.deepEqual(Object.keys(localShape.items[0]).sort(), Object.keys(remoteShape.items[0]).sort())
  assert.deepEqual(Object.keys(localShape).sort(), [...PROJECTED_KEY_SETS.sessionList].sort())
  assert.equal(remoteShape.items[0].instanceId, INSTANCE)
})
