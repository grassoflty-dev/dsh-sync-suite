/**
 * mod-plugin-dispose-hygiene-residuals / item 1：`accepting` 的**监听失败通道**。
 *
 * 背景（评审 §5.1 P2-8）：`accepting` 只由 `runtime.handle !== null` 派生，句柄在就报"在接"。
 * 监听在 start 之后死掉（bind 丢失 / OS 关掉 socket / server 级 error）时，句柄还挂着，
 * 面板于是继续显示「正在接受连接（addr:port）」——一句已经不符合事实的话。
 *
 * 本文件的判据（全部只用注入的假监听，绝不开真实端口）：
 *   1. 句柄的 `lastError` 出现**监听级**错误（listener.ts 在 `server.on('error')` 里把 scope
 *      写成「监听 <addr>:<port>」；业务级错误是「代理请求/上游/鉴权」等别的 scope）⇒
 *      `accepting=false`、`listen=null`、状态里出现 typed `listenerFailure`，并且句柄被关闭一次
 *      （不能让死句柄继续占着端口）；落盘 `enabled` 同步成 false（回声 = 事实）。
 *   2. **业务级** `lastError` 绝不能冒充监听死亡（负向对照：`accepting` 仍为 true、不关句柄）。
 *   3. 面板必须把那句话用中文说出来并给下一步（不是只加一个 typed 字段）。
 *   4. 源码守卫：listener.ts 仍然用「监听 …」这个 scope 记录 server 级错误 —— 否则本层的判据
 *      会在没人发现的情况下变成死代码（这与 `accepting` 当年变成第二口径是同一类事故）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { createRemoteService } from '../dist/remote/service.js'
import { RemoteStore } from '../dist/remote/store.js'
import { generatePairingCertificate } from '../dist/remote/pairingTls.js'

const LAN = '192.168.1.6'
const ZH = JSON.parse(await readFile(path.join(process.cwd(), 'locale', 'zh.json'), 'utf8'))
const CLIENT_DIST = path.join(process.cwd(), 'dist', 'client.js')

async function makeHome(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'dsh-listener-failure-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  return home
}

function seedCert(home) {
  new RemoteStore({ homeDir: home }).writeCert(generatePairingCertificate())
}

const configFile = (home) => path.join(home, '.dsh', 'dots', 'remote.json')

async function startFakeDsh(t) {
  const server = http.createServer((req, res) => {
    res.writeHead(303, { location: './', 'set-cookie': 'dsh-auth-deadbeef=session-value; Path=/; HttpOnly' })
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(() => resolve())))
  return { server, port: server.address().port }
}

/** 注入式监听工厂：句柄的 `lastError` 是可写的（真实 listener 用 getter 暴露同一个位）。 */
function fakeListener() {
  const calls = []
  const handles = []
  let closes = 0
  const start = async (opts) => {
    calls.push(opts)
    const handle = {
      address: opts.bindAddress,
      port: opts.port,
      close: async () => { closes += 1 },
      stats: () => ({ active: 0, total: 0, rejected: 0 }),
      lastError: null,
    }
    handles.push(handle)
    return handle
  }
  return { start, calls, handles, closes: () => closes }
}

function fakeGate() {
  return {
    exchange: () => ({ ok: true, setCookie: 'dsh-remote-session=abc; Path=/; HttpOnly', reason: '' }),
    valid: () => false,
    fail: () => ({ limited: false, retryAfterSec: 0 }),
    setToken: () => undefined,
  }
}

async function makeService(t) {
  const home = await makeHome(t)
  seedCert(home)
  const fake = await startFakeDsh(t)
  const listener = fakeListener()
  const service = createRemoteService({
    homeDir: home,
    createGate: () => fakeGate(),
    startListener: listener.start,
    webServer: { port: fake.port },
    connection: { authenticatedUrl: (base) => `${base}?token=launch` },
    interfaces: () => [{ address: LAN, iface: 'WLAN', family: 'IPv4', virtual: false }],
    routeProbeAddress: () => LAN,
  })
  t.after(() => service.dispose())
  await service.saveSettings({ mode: 'lan', lanAddress: LAN, port: 0 })
  return { home, service, listener }
}

/* ------------------------------------------------- 1) 监听级错误 ⇒ 不再自称"在接" */

test('LF-1 监听级 lastError ⇒ accepting=false、typed listenerFailure、句柄关闭一次、enabled 回声同步', async (t) => {
  const { home, service, listener } = await makeService(t)
  const started = await service.start()
  assert.equal(started.running, true, JSON.stringify(started.lastError))
  const handle = listener.handles[0]
  assert.equal(handle.lastError, null)

  // 监听在 start 之后死掉：真实 listener 在 server.on('error') 里这样记录（scope = 「监听 addr:port」）。
  handle.lastError = { code: 'EIO', message: `监听 ${LAN}:${String(started.port)}失败（EIO）` }

  const state = await service.getState()
  assert.deepEqual(state.status.listenerFailure, handle.lastError, 'typed 失败必须出现在状态里')
  assert.equal(state.settings.accepting, false, '死监听不许再自称"正在接受连接"')
  assert.equal(state.settings.listen, null)
  assert.equal(state.status.running, false)
  assert.equal(state.status.startedBy, null)
  assert.equal(state.status.tls, false, '没在接就不许冒充加密')
  assert.equal(listener.closes(), 1, '死句柄必须被关掉一次（否则端口还被占着）')

  const disk = JSON.parse(await readFile(configFile(home), 'utf8'))
  assert.equal(disk.enabled, false, 'enabled 是句柄回声：死监听被摘掉后必须落盘 false')

  // 失败可见之后，用户点「开始接受连接」应当真的能重起（死句柄不该把新启动挡在门外）。
  const restarted = await service.start()
  assert.equal(restarted.running, true, JSON.stringify(restarted.lastError))
  assert.equal(restarted.listenerFailure, null, '成功重起必须清掉上一次的失败')
  assert.equal(listener.calls.length, 2)
})

/* ------------------------------------------------- 2) 业务级错误不得冒充监听死亡 */

test('LF-2 负向对照：业务级 lastError（代理/上游失败）不得翻转 accepting、不得关句柄', async (t) => {
  const { service, listener } = await makeService(t)
  const started = await service.start()
  assert.equal(started.running, true, JSON.stringify(started.lastError))
  const handle = listener.handles[0]

  handle.lastError = { code: 'ECONNRESET', message: '代理请求失败（ECONNRESET）' }
  const state = await service.getState()
  assert.equal(state.settings.accepting, true, '业务级错误不等于监听死亡：仍然在接')
  assert.equal(state.status.listenerFailure, null)
  assert.equal(state.status.running, true)
  assert.equal(listener.closes(), 0, '业务级错误不许把还在工作的监听关掉')
})

/* ------------------------------------------------- 3) 面板用中文说出下一步 */

let activeMount = null
const reactStub = {
  Fragment: Symbol('Fragment'),
  createElement(type, props, ...children) {
    const next = Object.assign({}, props || {})
    const kids = children.flat(Infinity).filter((kid) => kid !== null && kid !== undefined && kid !== false && kid !== true)
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
  Children: { toArray(value) { return Array.isArray(value) ? value.flat(Infinity) : [value] } },
}

function mountPanel(Panel, props) {
  const hooks = []
  let cursor = 0
  let pending = []
  let rendering = false
  let tree = null
  function render() {
    cursor = 0
    pending = []
    rendering = true
    tree = Panel(props)
    rendering = false
    const effects = pending
    pending = []
    for (const effect of effects) effect()
    return tree
  }
  return {
    useState(init) {
      const index = cursor++
      if (hooks[index] === undefined) hooks[index] = { value: typeof init === 'function' ? init() : init }
      const hook = hooks[index]
      return [hook.value, function (next) {
        const value = typeof next === 'function' ? next(hook.value) : next
        if (value === hook.value) return
        hook.value = value
        if (!rendering) render()
      }]
    },
    useRef(value) {
      const index = cursor++
      if (hooks[index] === undefined) hooks[index] = { current: value }
      return hooks[index]
    },
    useEffect(fn) {
      const index = cursor++
      if (hooks[index] === undefined) { hooks[index] = { ran: true }; pending.push(fn) }
    },
    render,
    get tree() { return tree },
  }
}

let panelPromise = null
async function loadPanel() {
  if (!panelPromise) {
    panelPromise = (async () => {
      let captured = null
      globalThis.window = { __ModuleLoader__: { load(cfg) { captured = cfg } } }
      await import(pathToFileURL(CLIENT_DIST).href + '?listener-failure=' + Date.now())
      assert.ok(captured, 'client.js 必须注册 loader')
      const mod = captured.factory((id) => {
        if (id === 'react') return reactStub
        throw new Error(`unexpected require: ${id}`)
      })
      let Panel = null
      mod.apply({
        effect(fn) { const d = fn(); return typeof d === 'function' ? d : function () {} },
        locale: { register() { return function () {} }, bind() { return function (key) { return key } } },
        slots: { inject(_name, cb) { cb(); return function () {} }, register(_o, component) { Panel = component; return function () {} } },
      })
      assert.ok(Panel)
      return Panel
    })()
  }
  return panelPromise
}

function walk(node, visit) {
  if (node === null || node === undefined || node === false || node === true) return
  if (Array.isArray(node)) { node.forEach((item) => walk(item, visit)); return }
  if (typeof node !== 'object') return
  if (typeof node.type === 'function') { walk(node.type(node.props), visit); return }
  if (typeof node.type === 'symbol') { walk(node.props.children, visit); return }
  visit(node)
  walk(node.props.children, visit)
}
const textOf = (node) => {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node && typeof node === 'object') return textOf(node.props && node.props.children)
  return ''
}
const nodesOf = (tree) => { const out = []; walk(tree, (n) => out.push(n)); return out }
const dataNodes = (tree, key) => nodesOf(tree).filter((n) => n.props && n.props['data-lean'] === key)
const dataText = (tree, key) => dataNodes(tree, key).map(textOf).join('\n')
const settle = async () => { for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setTimeout(resolve, 5)) }

/** 面板挂载只调那四个只读入口；这里只桩它们，并把监听失败放进 status（引擎的真实位置）。 */
function stubFetch(settings, listenerFailure) {
  const routes = {
    pairingProvision: () => ({ ok: true, data: { view: { v: 1, transport: 'lan', host: LAN, port: 44996, token: 'present' }, changed: {}, republish: null } }),
    pairingTransports: () => ({ ok: true, data: { selected: 'lan', selectedHost: LAN, overrideUnavailable: false, candidates: {}, reasonLines: [] } }),
    pairingConnections: () => ({ ok: true, data: [] }),
    remoteGetState: () => ({
      ok: true,
      data: {
        settings,
        status: {
          running: settings.accepting === true,
          listen: settings.listen,
          startedBy: null,
          probe: null,
          urls: [],
          listenerFailure,
        },
        modes: [],
      },
    }),
  }
  globalThis.fetch = async function (_url, options) {
    const body = JSON.parse(options.body)
    const handler = routes[body.action]
    const payload = typeof handler === 'function' ? await handler() : { ok: false, error: { code: 'E_NO_STUB', message: 'no stub' } }
    return { status: 200, async text() { return JSON.stringify(payload) } }
  }
}

async function renderPanel(settings, listenerFailure) {
  const Panel = await loadPanel()
  stubFetch(settings, listenerFailure)
  activeMount = mountPanel(Panel, { t: (key) => (ZH[key] || key), close() {} })
  activeMount.render()
  await settle()
  return activeMount.tree
}

test('LF-3 面板渲染中文失败行（含 typed code 与下一步），且失败态不再显示「正在接受连接」', async (t) => {
  const failure = { code: 'EIO', message: `监听 ${LAN}:44996失败（EIO）` }
  const tree = await renderPanel({ mode: 'lan', enabled: false, autoStart: true, accepting: false, listen: null }, failure)
  const expected = ZH['lean.remote.listener-failed']
    .replace('{code}', failure.code)
    .replace('{message}', failure.message)
  assert.equal(dataText(tree, 'remote-listener-failed'), expected, '必须有一句中文失败说明（带 code、原因与下一步）')
  assert.equal(expected.includes('停止接受连接'), true, '这句话必须告诉运维下一步点哪里')
  assert.equal(dataNodes(tree, 'remote-accepting').length, 0, '失败态不许再出现「正在接受连接」')
  assert.equal(dataText(tree, 'remote-running'), ZH['lean.remote.stopped'])

  // 没有失败时一个失败节点都不许出现（不许常驻告警）。
  const healthy = await renderPanel({ mode: 'lan', enabled: true, autoStart: true, accepting: true, listen: `${LAN}:44996` }, null)
  assert.equal(dataNodes(healthy, 'remote-listener-failed').length, 0)
  assert.equal(dataText(healthy, 'remote-accepting'), ZH['lean.remote.accepting'].replace('{addr}', `${LAN}:44996`))
})

/* ------------------------------------------------- 4) 判据不能变成死代码 */

test('LF-4 源码守卫：listener.ts 仍用「监听 <addr>:<port>」scope 记录 server 级错误', async (t) => {
  const source = await readFile(path.join(process.cwd(), 'src', 'remote', 'listener.ts'), 'utf8')
  const at = source.indexOf("server.on('error'")
  assert.ok(at >= 0, 'listener.ts 必须仍然订阅 server 级 error')
  const block = source.slice(at, at + 400)
  assert.match(block, /noteFailure\(`监听 \$\{address\}:\$\{String\(info\.port\)\}`, error\)/,
    'server 级错误必须继续以「监听 <addr>:<port>」为 scope：service 的失败通道按这个 scope 判定')
})
