/**
 * `src/remote/service.ts` + `src/remote/index.ts` 的状态机与装配测试。
 *
 * 这两个文件是"失败隔离"与"token 生命周期"的落点，也是最容易在重构里被悄悄改坏的地方：
 *   - start() 任何失败只能写 `status.lastError`，绝不抛；
 *   - 拿不到上游身份（DSH 会话）必须 fail-closed（不启动监听）；
 *   - token 只经 `showLink` 出口，`getState` 里永远只有打码串；
 *   - 轮换令牌要同时吊销会话（gate.setToken 被调用）。
 *
 * 全部用假 listener / 假 probe / 假 QR，加一个只监听 127.0.0.1 的微型 DSH 桩来提供
 * `set-cookie`（这样不用碰真实 DSH）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createRemoteService, redactUrlForDisplay } from '../dist/remote/service.js'
import { createRemoteModule } from '../dist/remote/index.js'
import { isBindableAddress, isBindableIpv6Address, isBindableLanAddress } from '../dist/remote/listener.js'

const LAN = '192.168.1.6'

async function makeHome(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'dsh-remote-svc-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  return home
}

/** 假 DSH：只回一个 `does-not-matter` 的会话 cookie。 */
async function startFakeDsh(t) {
  const server = http.createServer((req, res) => {
    res.writeHead(303, { location: './', 'set-cookie': 'dsh-auth-deadbeef=session-value; Path=/; HttpOnly' })
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(() => resolve())))
  return { server, port: server.address().port }
}

function fakeGate() {
  const state = { tokens: [], validCalls: 0, failures: 0, setTokenCalls: [] }
  const gate = {
    exchange(token) {
      state.tokens.push(token)
      return token === 'good' ? { ok: true, setCookie: 'dsh-remote-session=abc; Path=/; HttpOnly', reason: '' } : { ok: false, setCookie: '', reason: 'invalid-token' }
    },
    valid() {
      state.validCalls += 1
      return false
    },
    fail() {
      state.failures += 1
      return { limited: false, retryAfterSec: 0 }
    },
    setToken(token) {
      state.setTokenCalls.push(token)
    },
  }
  return { gate, state }
}

function fakeListener() {
  const calls = []
  const start = async (opts) => {
    calls.push(opts)
    // 用哨兵端口模拟"绑定失败"，而不是用非法地址（非法地址会在 normalize 阶段就被拒）。
    if (opts.port === 12345) throw new Error('listen EADDRINUSE: address already in use')
    return {
      address: opts.bindAddress,
      port: opts.port,
      close: async () => undefined,
      stats: () => ({ active: 1, total: 3, rejected: 2 }),
      lastError: null,
    }
  }
  return { start, calls }
}

test('getState：默认关闭、方式为 lan、端口 0、6 种方式齐全', async (t) => {
  const home = await makeHome(t)
  const service = createRemoteService({ homeDir: home })
  const state = await service.getState()
  assert.equal(state.settings.enabled, false)
  assert.equal(state.settings.mode, 'lan')
  assert.equal(state.settings.port, 0)
  assert.equal(state.modes.length, 6)
  assert.equal(state.status.running, false)
  assert.equal(state.status.listen, null)
  assert.equal(state.status.token.exists, false, '没有 token 文件时 exists=false')
  await service.dispose()
})

test('start：没装配 listener → E_NO_LISTENER，且不抛异常', async (t) => {
  const home = await makeHome(t)
  const { gate } = fakeGate()
  const service = createRemoteService({ homeDir: home, createGate: () => gate, webServer: { port: 3080 } })
  const status = await service.start()
  assert.equal(status.running, false)
  assert.equal(status.lastError.code, 'E_NO_LISTENER')
  await service.dispose()
})

test('start：uu（可用但不需要本机监听）→ E_NO_BIND_ADDRESS，不再按 unsupported 拒绝', async (t) => {
  // 2026-11-18 订正：uu 从 unsupported 变成 needs-setup。它是"用户自己在 UU 里配端口映射"，插件
  // 不起旁挂监听，所以 start() 走的是"这种方式不需要本机监听"这条 fail-closed 分支
  // （与 manual 一致），而不是 E_MODE_UNSUPPORTED。
  const home = await makeHome(t)
  const fake = await startFakeDsh(t)
  const { gate } = fakeGate()
  const { start, calls } = fakeListener()
  const service = createRemoteService({
    homeDir: home,
    createGate: () => gate,
    startListener: start,
    webServer: { port: fake.port },
    // 上游身份要先拿到才会走到绑定地址那一步（与 happy path 同一套假 DSH）
    connection: { authenticatedUrl: (base) => `${base}?token=launch` },
  })
  await service.saveSettings({ mode: 'uu' })
  const status = await service.start()
  assert.equal(status.running, false)
  assert.equal(status.lastError.code, 'E_NO_BIND_ADDRESS')
  assert.match(status.lastError.message, /不需要本机监听/)
  assert.doesNotMatch(status.lastError.message, /画面串流|不产生端口/)
  assert.equal(calls.length, 0, 'uu 不该起任何监听')
  await service.dispose()
})

test('start：读不到 DSH 端口 → E_NO_DSH_PORT（fail-closed）', async (t) => {
  const home = await makeHome(t)
  const { gate } = fakeGate()
  const { start } = fakeListener()
  const service = createRemoteService({ homeDir: home, createGate: () => gate, startListener: start, webServer: {} })
  const status = await service.start()
  assert.equal(status.lastError.code, 'E_NO_DSH_PORT')
  await service.dispose()
})

test('start：拿不到上游身份（connection 缺 authenticatedUrl）→ E_NO_UPSTREAM_IDENTITY，绝不裸转发', async (t) => {
  const home = await makeHome(t)
  const { gate } = fakeGate()
  const { start, calls } = fakeListener()
  const service = createRemoteService({ homeDir: home, createGate: () => gate, startListener: start, webServer: { port: 3080 }, connection: {} })
  const status = await service.start()
  assert.equal(status.running, false)
  assert.equal(status.lastError.code, 'E_NO_UPSTREAM_IDENTITY')
  assert.equal(calls.length, 0, '身份拿不到时不许起监听')
  await service.dispose()
})

test('start：happy path → running，绑定具体地址，连接数来自 listener', async (t) => {
  const home = await makeHome(t)
  const fake = await startFakeDsh(t)
  const { gate } = fakeGate()
  const { start, calls } = fakeListener()
  const service = createRemoteService({
    homeDir: home,
    createGate: () => gate,
    startListener: start,
    webServer: { port: fake.port },
    connection: { authenticatedUrl: (base) => `${base}?token=launch` },
  })
  await service.saveSettings({ mode: 'lan', lanAddress: LAN, port: 0 })
  const status = await service.start()
  assert.equal(status.running, true)
  assert.equal(status.lastError, null)
  assert.equal(status.boundAddress, LAN)
  assert.equal(status.connections.active, 1)
  assert.equal(status.connections.total, 3)
  assert.equal(status.rejected, 2)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].bindAddress, LAN)
  assert.equal(calls[0].port, fake.port, 'port:0 表示跟随 DSH 端口，由 service 解析后传具体值')
  assert.equal(typeof calls[0].authorize, 'function', 'must pass authorize hook')
  await service.stop()
})

test('start：listener 抛错 → E_LISTEN_FAILED（不冒泡）', async (t) => {
  const home = await makeHome(t)
  const fake = await startFakeDsh(t)
  const { gate } = fakeGate()
  const { start } = fakeListener()
  const service = createRemoteService({
    homeDir: home,
    createGate: () => gate,
    startListener: start,
    webServer: { port: fake.port },
    connection: { authenticatedUrl: (base) => `${base}?token=launch` },
  })
  await service.saveSettings({ mode: 'lan', lanAddress: LAN, port: 12345 })
  const status = await service.start()
  assert.equal(status.running, false)
  assert.equal(status.lastError.code, 'E_LISTEN_FAILED')
  assert.match(status.lastError.message, /监听启动失败/)
  await service.dispose()
})

test('rotateToken：写盘 + 通知 gate 吊销会话，状态里只有打码串', async (t) => {
  const home = await makeHome(t)
  const { gate, state } = fakeGate()
  const service = createRemoteService({ homeDir: home, createGate: () => gate, generateToken: () => 'T'.repeat(43) })
  const status = await service.rotateToken()
  assert.equal(status.token.exists, true)
  assert.equal(status.token.masked.includes('T'.repeat(43)), false, '打码串不得含明文')
  assert.deepEqual(state.setTokenCalls, ['T'.repeat(43)], '轮换必须通知 gate')
  const raw = JSON.parse(await readFile(path.join(home, '.dsh', 'git-config-sync', 'remote-token.json'), 'utf8'))
  assert.equal(raw.token, 'T'.repeat(43))
  assert.equal(raw.createdAt.length > 10, true)
  await service.dispose()
})

test('saveSettings：非法值抛 E_VALIDATION；改方式会停掉旧监听', async (t) => {
  const home = await makeHome(t)
  const fake = await startFakeDsh(t)
  const { gate } = fakeGate()
  const { start } = fakeListener()
  const service = createRemoteService({
    homeDir: home,
    createGate: () => gate,
    startListener: start,
    webServer: { port: fake.port },
    connection: { authenticatedUrl: (base) => `${base}?token=launch` },
  })
  await service.saveSettings({ mode: 'lan', lanAddress: LAN, enabled: false })
  await service.start()
  assert.equal((await service.getState()).status.running, true)

  await assert.rejects(() => service.saveSettings({ mode: 'nope' }), /方式|mode/i)
  await service.saveSettings({ mode: 'manual', manualUrl: 'http://127.0.0.1:3080/' })
  assert.equal((await service.getState()).status.running, false, '换方式后旧监听必须停掉')
  await service.dispose()
})

test('probe：没有注入自检时给 unknown（不假装 ok）', async (t) => {
  const home = await makeHome(t)
  const service = createRemoteService({ homeDir: home })
  const result = await service.probe()
  assert.equal(result.level, 'unknown')
  assert.equal(result.checks.length > 0, true)
  assert.match(result.verdict, /暂不能自检/)
  await service.dispose()
})

test('showLink：没有 token 时拒绝；有 token 时是唯一带明文的出口', async (t) => {
  const home = await makeHome(t)
  const service = createRemoteService({
    homeDir: home,
    webServer: { port: 3080 },
    generateToken: () => 'K'.repeat(43),
    encodeQr: () => ({ size: 1, modules: [[true]] }),
  })
  await assert.rejects(() => service.showLink(), /令牌/)
  await service.rotateToken()
  const link = await service.showLink()
  assert.match(link.url, /token=K{43}/)
  assert.equal(link.qr.size, 1)
  // 反证：getState 里没有明文
  const state = await service.getState()
  assert.equal(JSON.stringify(state).includes('K'.repeat(43)), false)
  await service.dispose()
})

test('detectLan：返回网卡候选，且不含通配地址', async (t) => {
  const home = await makeHome(t)
  const service = createRemoteService({ homeDir: home })
  const list = service.detectLan()
  assert.equal(Array.isArray(list), true)
  for (const item of list) {
    assert.notEqual(item.address, '0.0.0.0')
    assert.notEqual(item.address, '::')
    assert.equal(['IPv4', 'IPv6'].includes(item.family), true)
  }
  await service.dispose()
})

test('index.createRemoteModule：首次装配即落盘 token，二次装配复用同一把', async (t) => {
  const home = await makeHome(t)
  const first = createRemoteModule({ homeDir: home })
  const firstState = await first.service.getState()
  assert.equal(firstState.status.token.exists, true, '首次装配必须自动生成 token')
  const tokenFile = first.paths.tokenFile
  const raw = JSON.parse(await readFile(tokenFile, 'utf8'))
  assert.equal(raw.token.length >= 32, true)
  assert.equal(raw.token.length <= 64, true)
  await first.service.dispose()

  const second = createRemoteModule({ homeDir: home })
  const secondState = await second.service.getState()
  assert.equal(secondState.status.token.masked, firstState.status.token.masked, '重启后 token 不变，二维码不失效')
  await second.service.dispose()
})

test('dispose：幂等，重复调用不抛', async (t) => {
  const home = await makeHome(t)
  const service = createRemoteService({ homeDir: home })
  await service.dispose()
  await service.dispose()
})

/* ------------------------------------------------------------------ 评审修复 */

test('ipv6 方式：service 把具体 v6 字面量交给 listener（评审 M1 的 service 侧）', async (t) => {
  const home = await makeHome(t)
  const fake = await startFakeDsh(t)
  const { gate } = fakeGate()
  const { start, calls } = fakeListener()
  const V6 = '2409:8a20:4cad:ba20:1234:5678:9abc:def0'
  const service = createRemoteService({
    homeDir: home,
    createGate: () => gate,
    startListener: start,
    webServer: { port: fake.port },
    connection: { authenticatedUrl: (base) => `${base}?token=launch` },
  })
  await service.saveSettings({ mode: 'ipv6', ipv6Address: V6, port: 3099 })
  const status = await service.start()
  assert.equal(status.running, true, JSON.stringify(status.lastError))
  assert.equal(status.boundAddress, V6)
  assert.equal(calls[0].bindAddress, V6)
  assert.equal(calls[0].port, 3099)
  await service.dispose()
})

test('isBindableIpv6Address / isBindableAddress：只放行具体单播 v6', () => {
  const allowed = [
    '2409:8a20:4cad:ba20:1234:5678:9abc:def0',
    '2001:db8::1',
    'fd00::1',
  ]
  for (const address of allowed) {
    assert.equal(isBindableIpv6Address(address), true, `${address} 应可绑定`)
    assert.equal(isBindableAddress(address), true)
    assert.equal(isBindableLanAddress(address), false, 'IPv4 判定不应接受 v6')
  }
  const rejected = [
    '',
    '::',
    '::1',
    'fe80::1',
    'ff02::1',
    '::ffff:192.168.1.6',
    '[2409:8a20::1]',
    '2409:8a20::1%eth0',
    '192.168.1.6',
    'not-an-ip',
  ]
  for (const address of rejected) {
    assert.equal(isBindableIpv6Address(address), false, `${JSON.stringify(address)} 必须被拒`)
  }
  // IPv4 局域网地址仍然走 v4 判定
  assert.equal(isBindableAddress('192.168.1.6'), true)
  assert.equal(isBindableAddress('0.0.0.0'), false)
  assert.equal(isBindableAddress('127.0.0.1'), false)
})

test('redactUrlForDisplay：展示用 URL 抹掉 token 类参数（评审 M3）', () => {
  assert.equal(redactUrlForDisplay('http://192.168.1.6:3080/?token=sekret'), 'http://192.168.1.6:3080/?token=***')
  assert.equal(redactUrlForDisplay('https://x.trycloudflare.com/?k=abc&tab=2'), 'https://x.trycloudflare.com/?k=***&tab=2')
  assert.equal(redactUrlForDisplay('http://192.168.1.6:3080/path'), 'http://192.168.1.6:3080/path')
  assert.equal(redactUrlForDisplay('不是地址'), '')
})

test('manualUrl 自带 token 时，getState 里的 url 已脱敏（评审 M3 的端到端表现）', async (t) => {
  const home = await makeHome(t)
  const service = createRemoteService({ homeDir: home, webServer: { port: 3080 } })
  await service.saveSettings({ mode: 'manual', manualUrl: 'http://192.168.1.6:3080/?token=leaked-token' })
  const state = await service.getState()
  assert.equal(state.status.urls.length, 1)
  assert.equal(state.status.urls[0].url.includes('leaked-token'), false, '状态响应里不许出现 token 明文')
  assert.match(state.status.urls[0].url, /token=\*\*\*/)
  await service.dispose()
})

/* --------------------------------------------------- 「访问令牌（可选）」 */

/** 用户粘贴的令牌（与自动令牌不同，便于区分出口）。 */
const PASTED = 'PastedToken-0123456789'

test('saveSettings：token 落盘，getState 只给 tokenSet/tokenMasked，响应 JSON 无明文', async (t) => {
  const home = await makeHome(t)
  const service = createRemoteService({ homeDir: home, webServer: { port: 3080 } })

  const saved = await service.saveSettings({ mode: 'lan', lanAddress: LAN, token: PASTED })
  assert.equal(saved.settings.tokenSet, true)
  assert.ok(saved.settings.tokenMasked.length > 0, 'tokenMasked 必须有值')
  assert.equal('token' in saved.settings, false, '设置视图里不允许出现 token 键')
  assert.equal(JSON.stringify(saved).includes(PASTED), false, 'saveSettings 响应里不许有令牌明文')

  const state = await service.getState()
  assert.equal(state.settings.tokenSet, true)
  assert.equal(state.settings.tokenMasked, saved.settings.tokenMasked, '两次读到的打码串必须一致')
  assert.ok(!state.settings.tokenMasked.includes(PASTED), '打码串不得含明文')
  assert.equal(JSON.stringify(state).includes(PASTED), false, 'getState 响应里不许有令牌明文')

  const raw = JSON.parse(await readFile(path.join(home, '.dsh', 'git-config-sync', 'remote.json'), 'utf8'))
  assert.equal(raw.token, PASTED, '令牌必须落盘（重启后仍然生效）')
  await service.dispose()
})

test('showLink：优先用粘贴的令牌；清除后回落到自动令牌', async (t) => {
  const home = await makeHome(t)
  const auto = 'K'.repeat(43)
  const service = createRemoteService({
    homeDir: home,
    webServer: { port: 3080 },
    generateToken: () => auto,
    encodeQr: () => ({ size: 1, modules: [[true]] }),
  })
  await service.rotateToken()
  await service.saveSettings({ mode: 'lan', lanAddress: LAN, port: 3080, token: PASTED })

  const pastedLink = await service.showLink()
  assert.equal(pastedLink.url, `http://${LAN}:3080/?token=${PASTED}`, '链接里必须是粘贴的那个令牌')
  assert.equal(pastedLink.url.includes(auto), false, '有粘贴令牌时不得混入自动令牌')

  // 手动方式也能用上粘贴的令牌（其余方式不展示该字段，但归一后仍按同一出口规则走）
  await service.saveSettings({ token: '' })
  const stateAfterClear = await service.getState()
  assert.equal(stateAfterClear.settings.tokenSet, false, '清除后 tokenSet 必须回到 false')
  assert.equal(stateAfterClear.settings.tokenMasked, '')

  const fallbackLink = await service.showLink()
  assert.match(fallbackLink.url, /token=K{43}/, '清除粘贴令牌后回落到自动令牌')
  await service.dispose()
})

test('showLink：粘贴令牌与自动令牌都为空 → 抛中文「还没有访问令牌，请先生成」', async (t) => {
  const home = await makeHome(t)
  const service = createRemoteService({ homeDir: home, webServer: { port: 3080 } })
  await service.saveSettings({ mode: 'lan', lanAddress: LAN, port: 3080, token: '' })
  await assert.rejects(() => service.showLink(), /还没有访问令牌，请先生成/)
  await service.dispose()
})

test('令牌非法时：错误详情只有长度，message 里没有令牌', async (t) => {
  const home = await makeHome(t)
  const service = createRemoteService({ homeDir: home, webServer: { port: 3080 } })
  const bad = 'bad!token!with!symbols'
  const error = await service.saveSettings({ token: bad }).then(
    () => assert.fail('非法令牌必须被拒绝'),
    (e) => e,
  )
  assert.equal(error.code, 'E_VALIDATION')
  assert.equal(error.details.field, 'token')
  assert.equal(error.details.length, bad.length)
  assert.deepEqual(Object.keys(error.details).sort(), ['field', 'length'])
  assert.equal(JSON.stringify(error.details).includes(bad), false)
  assert.equal(error.message.includes(bad), false)
  await service.dispose()
})
