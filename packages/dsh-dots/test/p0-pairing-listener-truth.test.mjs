/**
 * mod-pairing-listener-truth：P0 机器验证用例（在"今天的代码"上必须失败）。
 *
 * 覆盖：
 *   P0-1 停止 ⇒ pairingShow typed 拒绝；面板无二维码 / 无可复制配对串、显示「开始接受连接」；
 *         start 失败（RPC ok:true + lastError）时状态行出现 typed code + 中文原因。
 *   P0-2 启动 ⇒ 监听真的 bind（TCP 连接成功），此后才有载荷，且端口是 bound port、
 *         transport / host 族一致。
 *   P0-3 选 IPv6 但无 IPv6 地址 ⇒ typed 拒绝、无载荷、remote.json.mode 不变。
 *   P0-4 选 IPv6 且有地址 ⇒ payload transport=ipv6 + 方括号 host + mode:"ipv6" 落盘。
 *   P0-5 选 Tailscale 但无 tailnet 地址 ⇒ typed 拒绝。
 *   P0-6 源码形状：精简面板有 start 控件，且它自己只调用一次 remoteStart（新路径）。
 *
 * 所有测试零网络出站：监听只绑本机具体 LAN 地址，上游是 127.0.0.1 的微型 DSH 桩。
 */
import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = (p) => path.join(pkgDir, 'dist', p)
const zh = JSON.parse(readFileSync(path.join(pkgDir, 'locale', 'zh.json'), 'utf8'))
const srcClient = readFileSync(path.join(pkgDir, 'src', 'client.js'), 'utf8')
// UI 桩会替换全局 fetch；每个用例后恢复，避免污染随后"真监听"用例的上游身份换取。
const REAL_FETCH = globalThis.fetch
afterEach(() => { globalThis.fetch = REAL_FETCH })

const TOKEN = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const V6 = '2409:8a20:4cad:b960:1c21:492b:c3c8:cd47'
const LAN_IFACES = () => [{ name: 'WLAN', family: 'IPv4', address: '192.168.1.5' }]
const V6_IFACES = () => [...LAN_IFACES(), { name: 'WLAN', family: 'IPv6', address: V6 }]

function home() { return mkdtempSync(path.join(tmpdir(), 'dsh-p0-pairing-')) }
function readRemote(dir) {
  return JSON.parse(readFileSync(path.join(dir, '.dsh', 'dots', 'remote.json'), 'utf8'))
}
function codeOf(error) { return error && typeof error === 'object' ? error.code : '' }
function reasonOf(error) { return error && typeof error === 'object' ? (error.reason || error.message) : '' }

async function pairingService(dir, { interfaces = LAN_IFACES, listenerState } = {}) {
  const mod = await import(pathToFileURL(dist('remote/pairingProvision.js')).href)
  const storeMod = await import(pathToFileURL(dist('remote/store.js')).href)
  const tlsMod = await import(pathToFileURL(dist('remote/pairingTls.js')).href)
  const accessMod = await import(pathToFileURL(dist('remote/accessMode.js')).href)
  const store = new storeMod.RemoteStore({ homeDir: dir })
  store.writeSettings(accessMod.defaultRemoteSettings())
  store.writeToken({ token: TOKEN, createdAt: '2026-01-01T00:00:00.000Z' })
  store.writeCert(tlsMod.generatePairingCertificate())
  const options = {
    homeDir: dir,
    instanceId: 'gwl-pc',
    interfaceSeam: { interfaces },
    isPortFree: () => true,
    generateTokenFn: () => TOKEN,
  }
  if (listenerState !== undefined) options.listenerState = listenerState
  return mod.createPairingService(options)
}

/* ------------------------------------------------------------------ */
/* P0-1 停止态：typed 拒绝 + 面板无 QR / 有 start                        */
/* ------------------------------------------------------------------ */

test('P0-1a：stopped ⇒ pairingShow typed E_LISTENER_NOT_RUNNING（没有接缝也一样拒绝，无载荷）', async () => {
  const dir = home()
  try {
    const service = await pairingService(dir)
    for (const override of [undefined, 'lan', 'ipv6']) {
      await assert.rejects(service.show(override), (error) => {
        assert.equal(codeOf(error), 'E_LISTENER_NOT_RUNNING')
        assert.match(reasonOf(error), /监听器未启动/)
        return true
      })
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

/** 精简 React 桩：宿主只给 { t, close }，无 seedState / seedLink。 */
let activeMount = null
const reactStub = {
  Fragment: Symbol('Fragment'),
  createElement(type, props, ...children) {
    const next = Object.assign({}, props || {})
    const kids = []
    const flatten = (list) => { for (const v of list) Array.isArray(v) ? flatten(v) : kids.push(v) }
    flatten(children)
    if (kids.length === 1) next.children = kids[0]
    else if (kids.length > 1) next.children = kids
    if (typeof type === 'function') return type(next)
    return { type, props: next }
  },
  useState(init) { return activeMount.useState(init) },
  useRef(value) { return activeMount.useRef(value) },
  useEffect(fn) { activeMount.useEffect(fn) },
  useMemo(fn) { return fn() },
  useCallback(fn) { return fn },
  Children: { toArray(v) { return Array.isArray(v) ? v : [v] } }
}
function mountPanel(Panel, props) {
  const hooks = []
  let cursor = 0
  let pending = []
  let rendering = false
  let tree = null
  const render = () => {
    cursor = 0; pending = []; rendering = true
    tree = Panel(props)
    rendering = false
    const effects = pending; pending = []
    for (const fn of effects) fn()
    return tree
  }
  return {
    useState(init) {
      const i = cursor++
      if (hooks[i] === undefined) hooks[i] = { value: typeof init === 'function' ? init() : init }
      const hook = hooks[i]
      return [hook.value, (next) => {
        const value = typeof next === 'function' ? next(hook.value) : next
        if (value === hook.value) return
        hook.value = value
        if (!rendering) render()
      }]
    },
    useRef(value) { const i = cursor++; if (hooks[i] === undefined) hooks[i] = { current: value }; return hooks[i] },
    useEffect(fn) { const i = cursor++; if (hooks[i] === undefined) { hooks[i] = { ran: true }; pending.push(fn) } },
    render,
    get tree() { return tree }
  }
}
let loadPromise = null
async function loadPanel() {
  if (!loadPromise) loadPromise = (async () => {
    let captured = null
    globalThis.window = { __ModuleLoader__: { load(cfg) { captured = cfg } } }
    await import(pathToFileURL(dist('client.js')).href + '?p0-truth=' + Date.now())
    assert.ok(captured)
    const mod = captured.factory((id) => {
      if (id === 'react') return reactStub
      throw new Error('unexpected require ' + id)
    })
    let Panel = null
    mod.apply({
      effect(fn) { const d = fn(); return typeof d === 'function' ? d : function () {} },
      locale: { register() { return function () {} }, bind() { return function (key) { return key } } },
      slots: { inject(_n, cb) { cb(); return function () {} }, register(_o, component) { Panel = component; return function () {} } }
    })
    return Panel
  })()
  return loadPromise
}
function walk(node, visit) {
  if (node === null || node === undefined || node === false || node === true) return
  if (Array.isArray(node)) { node.forEach((n) => walk(n, visit)); return }
  if (typeof node !== 'object') return
  if (typeof node.type === 'function') { walk(node.type(node.props), visit); return }
  if (typeof node.type === 'symbol') { walk(node.props.children, visit); return }
  visit(node); walk(node.props.children, visit)
}
const textOf = (n) => {
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(textOf).join('')
  if (n && typeof n === 'object') return textOf(n.props && n.props.children)
  return ''
}
const nodesOf = (tree) => { const out = []; walk(tree, (n) => out.push(n)); return out }
const dataText = (tree, key) => nodesOf(tree).filter((n) => n.props && n.props['data-lean'] === key).map(textOf).join('\n')
const button = (tree, label) => {
  const found = nodesOf(tree).filter((n) => n.type === 'button' && textOf(n.props.children) === label)
  assert.equal(found.length, 1, `按钮「${label}」必须恰好一个`)
  return found[0]
}
const settle = async () => { for (let i = 0; i < 12; i += 1) await new Promise((r) => setTimeout(r, 5)) }

async function renderStopped(routes = {}) {
  const calls = []
  const base = {
    pairingProvision: () => ({ ok: true, data: { view: { transport: 'lan', port: 44996 }, changed: {}, republish: null } }),
    pairingTransports: () => ({ ok: true, data: { selected: 'lan', selectedHost: '192.168.1.5', overrideUnavailable: false, candidates: {}, reasonLines: [], tls: true } }),
    pairingConnections: () => ({ ok: true, data: [] }),
    remoteGetState: () => ({ ok: true, data: { settings: { mode: 'lan' }, status: { running: false, lastError: null, probe: null }, modes: [] } }),
    pairingShow: () => { calls.push('show'); return { ok: false, error: { code: 'E_LISTENER_NOT_RUNNING', message: '监听器未启动' } } },
    ...routes,
  }
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body)
    calls.push(body.action)
    const handler = base[body.action]
    const payload = typeof handler === 'function' ? await handler(body) : handler
    return { status: 200, async text() { return JSON.stringify(payload === undefined ? { ok: false, error: { code: 'E_NO_STUB' } } : payload) } }
  }
  const Panel = await loadPanel()
  activeMount = mountPanel(Panel, { t: (key, vars) => {
    let out = zh[key] || key
    if (vars) for (const [k, v] of Object.entries(vars)) out = out.replace('{' + k + '}', v)
    return out
  }, close() {} })
  activeMount.render()
  await settle()
  return { calls, mount: activeMount }
}

test('P0-1b：停止面板显示「未启动」+「开始接受连接」，没有二维码与复制入口，也不触碰 pairingShow', async () => {
  const { calls, mount } = await renderStopped()
  assert.equal(dataText(mount.tree, 'remote-running'), zh['lean.remote.stopped'], '运行状态行必须讲真话：未启动')
  assert.equal(button(mount.tree, zh['lean.remote.start']).type, 'button', '必须有开始接受连接控件')
  const labels = nodesOf(mount.tree).filter((n) => n.type === 'button').map((n) => textOf(n.props.children))
  assert.equal(labels.includes(zh['lean.remote.qr.show']), false, '停止时不得渲染二维码入口')
  assert.equal(labels.includes(zh['lean.remote.copy']), false, '停止时不得渲染可复制配对串入口')
  assert.equal(nodesOf(mount.tree).filter((n) => n.type === 'svg').length, 0, '停止时不得有二维码')
  assert.equal(calls.includes('pairingShow'), false, '挂载绝不调用 pairingShow')
})

test('P0-1c：启动失败（ok:true + lastError）⇒ 状态行出现 typed code + 中文原因，不冒充已启动', async () => {
  const { calls, mount } = await renderStopped({
    remoteStart: () => ({ ok: true, data: { running: false, lastError: { code: 'E_NO_BIND_ADDRESS', message: '没找到可用的局域网 IPv4，请先连上 Wi-Fi' } } })
  })
  await button(mount.tree, zh['lean.remote.start']).props.onClick()
  await settle()
  assert.ok(calls.includes('remoteStart'), '必须走既有 remoteStart 路径')
  const status = dataText(mount.tree, 'remote-status')
  assert.match(status, /E_NO_BIND_ADDRESS/, '状态行必须带 typed code')
  assert.match(status, /没找到可用的局域网 IPv4/, '状态行必须带中文原因')
  assert.equal(dataText(mount.tree, 'remote-running'), zh['lean.remote.stopped'], '失败后仍是未启动')
  assert.equal(nodesOf(mount.tree).filter((n) => n.type === 'svg').length, 0)
})

/* ------------------------------------------------------------------ */
/* P0-2 真监听：bind 成功 + TCP 可连 + 载荷来自 bound state              */
/* ------------------------------------------------------------------ */

/**
 * 选一个**真的能绑**的非回环 IPv4：网卡枚举会列出 Windows ICS / VM switch 这类"存在但
 * EADDRNOTAVAIL"的地址（伤疤：192.168.137.1:6869 让 P0-2 变红）。所以逐候选试绑一次，
 * 由内核判定能否绑定；同时拿到该地址上的空闲端口，避免"127.0.0.1 上空闲、目标网卡上被占"。
 */
function tryBind(address) {
  return new Promise((resolve) => {
    const server = net.createServer()
    let settled = false
    const done = (value) => { if (!settled) { settled = true; resolve(value) } }
    server.once('error', () => { try { server.close() } catch { /* 未监听 */ } done(false) })
    server.listen(0, address, () => {
      const port = server.address().port
      server.close(() => done(port))
    })
  })
}
async function findBindableLan() {
  const { isBindableLanAddress } = await import(pathToFileURL(dist('remote/listener.js')).href)
  const seen = new Set()
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list ?? []) {
      const family = item.family
      if (family !== 'IPv4' && family !== 4) continue
      if (item.internal === true) continue
      const address = item.address
      if (seen.has(address)) continue
      seen.add(address)
      if (!isBindableLanAddress(address)) continue
      const port = await tryBind(address)
      if (port !== false) return { address, port }
    }
  }
  return null
}
function canConnect(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    const done = (ok) => { socket.destroy(); resolve(ok) }
    socket.setTimeout(2000, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

test('P0-2：start 真的 bind（TCP 连接成功）后才有载荷，端口=bound port 且 transport/host 同族', async (t) => {
  const endpoint = await findBindableLan()
  if (endpoint === null) {
    // 没有可绑地址时绝不"静默通过"： loudly 标成 UNPROVEN，避免有人把红色当成环境噪音忽略。
    console.log('!!! P0-2 SKIPPED — NO BINDABLE ADDRESS (UNPROVEN) !!!')
    t.skip('没有可实际绑定的非回环 IPv4；P0-2 未证明监听 bind（UNPROVEN）')
    return
  }
  const { address: LAN, port } = endpoint
  const dir = home()
  const dsh = http.createServer((_req, res) => {
    res.writeHead(303, { location: './', 'set-cookie': 'dsh-auth-p0=session; Path=/; HttpOnly' })
    res.end()
  })
  try {
    await new Promise((resolve) => dsh.listen(0, '127.0.0.1', resolve))
    const { createRemoteModule } = await import(pathToFileURL(dist('remote/index.js')).href)
    const { parsePairingPayload } = await import(pathToFileURL(dist('remote/pairingPayload.js')).href)
    const remote = createRemoteModule({
      homeDir: dir,
      connection: { authenticatedUrl: (base) => `${base}?token=launch` },
      webServer: { port: dsh.address().port, protocol: 'http:' },
    })
    t.after(async () => { await remote.service.dispose(); await new Promise((r) => dsh.close(() => r())) })
    // pairingService 先落 token / 证书与默认设置；随后 saveSettings 在同一份 remote.json 上叠加
    // mode / 绑定地址 / 端口（调用顺序反了会把设置冲回默认值）。
    const pairing = await pairingService(dir, {
      listenerState: async () => {
        const state = await remote.service.getState()
        return {
          running: state.status.running === true,
          address: state.status.boundAddress,
          port: state.status.port,
          mode: state.settings.mode,
          tls: state.status.tls === true,
        }
      },
    })
    await remote.service.saveSettings({ mode: 'lan', lanAddress: LAN, port })
    assert.equal((await remote.service.getState()).status.running, false)
    await assert.rejects(pairing.show(), (e) => codeOf(e) === 'E_LISTENER_NOT_RUNNING')

    const status = await remote.service.start()
    assert.equal(status.running, true, `start 必须真的起来；lastError=${JSON.stringify(status.lastError)} listen=${status.listen}`)
    assert.equal(status.boundAddress, LAN)
    assert.equal(status.port, port, '载荷端口必须是 server.address() 的真值')
    assert.equal(await canConnect(LAN, port), true, '端口必须真的接受 TCP 连接')

    const shown = await pairing.show()
    const payload = parsePairingPayload(shown.payload)
    assert.equal(payload.port, port)
    assert.equal(payload.transport, 'lan')
    assert.equal(payload.host, LAN, 'host 来自绑定地址而非枚举')
    assert.equal(shown.tls, true, '载荷对应的通道确实由监听终结 TLS')
    assert.equal(shown.transport, payload.transport)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

/* ------------------------------------------------------------------ */
/* P0-3 / P0-4 / P0-5 选择必须兑现或 typed 拒绝                          */
/* ------------------------------------------------------------------ */

test('P0-3：选 ipv6 但本机无 IPv6 ⇒ typed 拒绝、无载荷、mode 不变（绝不 QR LAN）', async () => {
  const dir = home()
  try {
    const service = await pairingService(dir, {
      listenerState: async () => ({ running: true, address: '192.168.1.5', port: 44996, mode: 'lan', tls: true }),
    })
    const before = readRemote(dir).mode
    await assert.rejects(service.provision('ipv6'), (error) => {
      assert.equal(codeOf(error), 'E_NO_IPV6_ADDRESS')
      assert.equal(reasonOf(error), '本机未检测到公网 IPv6 地址')
      return true
    })
    await assert.rejects(service.show('ipv6'), (error) => codeOf(error) === 'E_NO_IPV6_ADDRESS')
    assert.equal(readRemote(dir).mode, before, '失败选择不得静默把 mode 写成 lan 或其它值')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('P0-4：选 ipv6 且有地址 ⇒ transport=ipv6 + 方括号 host + mode:"ipv6" 落盘', async () => {
  const dir = home()
  try {
    const service = await pairingService(dir, {
      interfaces: V6_IFACES,
      listenerState: async () => ({ running: true, address: V6, port: 44996, mode: 'ipv6', tls: true }),
    })
    const result = await service.provision('ipv6')
    assert.equal(result.view.transport, 'ipv6')
    const stored = readRemote(dir)
    assert.equal(stored.mode, 'ipv6', 'remote.json.mode 必须等于 UI 显示的方式')
    assert.equal(stored.ipv6Address, V6)
    const { parsePairingPayload } = await import(pathToFileURL(dist('remote/pairingPayload.js')).href)
    const shown = await service.show('ipv6')
    const payload = parsePairingPayload(shown.payload)
    assert.equal(payload.transport, 'ipv6')
    assert.match(payload.host, /^\[2409:/, 'IPv6 host 必须带方括号')
    assert.equal(payload.port, 44996)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('P0-5：选 tailscale 但无 tailnet 地址 ⇒ typed 拒绝，mode 不变', async () => {
  const dir = home()
  try {
    const service = await pairingService(dir, {
      listenerState: async () => ({ running: true, address: '192.168.1.5', port: 44996, mode: 'lan', tls: true }),
    })
    const before = readRemote(dir).mode
    await assert.rejects(service.provision('tailscale'), (error) => {
      assert.equal(codeOf(error), 'E_NO_TAILSCALE_ADDRESS')
      assert.equal(reasonOf(error), '本机未检测到 Tailscale 地址')
      return true
    })
    assert.equal(readRemote(dir).mode, before)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

/* ------------------------------------------------------------------ */
/* P0-6 源码形状                                                        */
/* ------------------------------------------------------------------ */

test('P0-6：精简面板有 start 控件，且它唯一的 remoteStart 调用就在新 doStart 里', () => {
  const leanStart = srcClient.indexOf('function LeanRemoteGroup(')
  const leanEnd = srcClient.indexOf('function DotsPanel(', leanStart)
  assert.ok(leanStart > 0 && leanEnd > leanStart, '必须能定位精简面板函数体')
  const lean = srcClient.slice(leanStart, leanEnd)
  assert.match(lean, /tr\('lean\.remote\.start'\)/, '精简面板必须有「开始接受连接」控件')
  assert.equal((lean.match(/rpcCall\('remoteStart'/g) || []).length, 1, '精简面板只能有一处 remoteStart 调用')
  assert.ok(/function doStart\(\)[\s\S]*rpcCall\('remoteStart'/.test(lean), '唯一的 remoteStart 调用必须在新 doStart 内')
  const distClient = readFileSync(dist('client.js'), 'utf8')
  const distLean = distClient.slice(distClient.indexOf('function LeanRemoteGroup('), distClient.indexOf('function DotsPanel('))
  assert.match(distLean, /tr\('lean\.remote\.start'\)/, '交付产物 dist/client.js 也必须带 start 控件')
  assert.equal((distLean.match(/rpcCall\('remoteStart'/g) || []).length, 1)
})
