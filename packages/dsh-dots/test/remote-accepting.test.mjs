/**
 * mod-plugin-remote-accepting-surface：把三个"看起来都在说开关"的位**分开**。
 *
 * 这一层要钉死四件事，缺一条就等于本模块没做到：
 *   1. `settings.accepting` / `settings.listen` 是**活真相**：只由监听句柄派生，
 *      与 `status.running` / `status.listen` 同源同值；`enabled`（保存的偏好）说反了也不影响它。
 *   2. 面板那句「正在接受连接（addr:port）」**只在真的在接时**出现；`enabled:true` 但没句柄时
 *      一个字都不许出现（"保存的偏好"不得冒充"此刻在接"）。
 *   3. **clobber 回归**：`pairingProvision.persistEndpoint()` 那种
 *      `normalizeRemoteSettings(raw, defaultRemoteSettings())` 的整文件重写，在监听
 *      **运行中**与**已停止**两种状态下都不许再把 `autoStart` 弄丢（旧的停机态是真丢）。
 *   4. 两个死点已移除：`saveSettings` 不再按 `enabled` 起监听，`getState` 不再有那段空分支。
 *
 * 纪律：**绝不起真实监听**。`startListener` 是注入的假工厂；上游身份来自一个只监听
 * 127.0.0.1 的假 DSH 桩（与 `remote-service.test.mjs` / `remote-autostart.test.mjs` 同一手法）。
 * 面板那一句用真实渲染器（`dist/client.js`）+ fetch 桩验证。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { createRemoteService } from '../dist/remote/service.js'
import { RemoteStore } from '../dist/remote/store.js'
import { createPairingProvisioner } from '../dist/remote/pairingProvision.js'
import { generatePairingCertificate } from '../dist/remote/pairingTls.js'
import { defaultRemoteSettings, normalizeRemoteSettings } from '../dist/remote/accessMode.js'

const LAN = '192.168.1.6'
const ZH = JSON.parse(await readFile(path.join(process.cwd(), 'locale', 'zh.json'), 'utf8'))
const CLIENT_DIST = path.join(process.cwd(), 'dist', 'client.js')

async function makeHome(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'dsh-remote-accept-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  return home
}

/** 起监听的前置条件之一：配对证书（与 `remote-service.test.mjs` 同一套夹具）。 */
function seedCert(home) {
  new RemoteStore({ homeDir: home }).writeCert(generatePairingCertificate())
}

const configFile = (home) => path.join(home, '.dsh', 'dots', 'remote.json')

async function readRaw(home) {
  return JSON.parse(await readFile(configFile(home), 'utf8'))
}

/**
 * 直接写 `remote.json`：模拟"上一次进程留下的文件"。
 * 刻意不经 `saveSettings`——`autoStart` 是意图位，不是用户可保存的表单字段。
 */
async function seedSettings(home, patch) {
  let base = {}
  try { base = await readRaw(home) } catch { base = {} }
  await mkdir(path.dirname(configFile(home)), { recursive: true })
  await writeFile(configFile(home), JSON.stringify({ ...base, ...patch }, null, 2) + '\n', 'utf8')
}

/** 假 DSH：只回一个 `does-not-matter` 的会话 cookie（身份换取的唯一来源）。 */
async function startFakeDsh(t) {
  const server = http.createServer((req, res) => {
    res.writeHead(303, { location: './', 'set-cookie': 'dsh-auth-deadbeef=session-value; Path=/; HttpOnly' })
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(() => resolve())))
  return { server, port: server.address().port }
}

/** 注入式监听工厂：只记录调用与固定入参，绝不开端口。 */
function fakeListener() {
  const calls = []
  const start = async (opts) => {
    calls.push(opts)
    return {
      address: opts.bindAddress,
      port: opts.port,
      close: async () => undefined,
      stats: () => ({ active: 0, total: 0, rejected: 0 }),
      lastError: null,
    }
  }
  return { start, calls }
}

function fakeGate() {
  return {
    exchange: () => ({ ok: true, setCookie: 'dsh-remote-session=abc; Path=/; HttpOnly', reason: '' }),
    valid: () => false,
    fail: () => ({ limited: false, retryAfterSec: 0 }),
    setToken: () => undefined,
  }
}

async function makeService(t, options = {}) {
  const home = options.home ?? (await makeHome(t))
  const fake = await startFakeDsh(t)
  const listener = fakeListener()
  const service = createRemoteService({
    homeDir: home,
    createGate: () => fakeGate(),
    startListener: listener.start,
    webServer: { port: fake.port },
    connection: { authenticatedUrl: (base) => `${base}?token=launch` },
    // 选路全部注入：不依赖本机 NIC，也不碰 provisioning 的自动镜像逻辑。
    interfaces: () => [{ address: LAN, iface: 'WLAN', family: 'IPv4', virtual: false }],
    routeProbeAddress: () => LAN,
    provisionedLanAddress: () => null,
    ...options.service,
  })
  t.after(() => service.dispose())
  return { home, service, listener }
}

/**
 * 模拟"打开配对面板"那一步：`pairingProvision.persistEndpoint()` 用
 * `normalizeRemoteSettings(raw, defaultRemoteSettings())` 重建设置再整文件写回。
 * 这里调的是**真的** provisioner（零网络：端口探测与网卡都封成注入值），
 * 且用例保证既有地址与目标 host 不一致，确保真的走到 `persistEndpoint` 那条写盘路径。
 */
async function rebuildByProvision(home) {
  const provisioner = createPairingProvisioner({
    homeDir: home,
    transport: 'lan',
    host: LAN,
    preferredPort: 44996,
    isPortFree: () => true,
  })
  return provisioner.provision()
}

/* ---------------------------------------------------------- 1) 活真相 vs 保存的偏好 */

test('ACC-1 句柄在 ⇒ accepting=true、listen=host:port，即使保存的偏好 enabled=false', async (t) => {
  const home = await makeHome(t)
  seedCert(home)
  const { service, listener } = await makeService(t, { home })

  // 保存的偏好：明确关着（enabled=false）。起监听**不**读它，起成功后只改 `enabled` 的句柄回声。
  await service.saveSettings({ mode: 'lan', lanAddress: LAN, port: 0, enabled: false })
  const started = await service.start()
  assert.equal(started.running, true, JSON.stringify(started.lastError))

  const state = await service.getState()
  assert.equal(state.settings.accepting, true, '会话句柄在就是"此刻在接"，跟保存的偏好无关')
  assert.equal(state.settings.listen, `${LAN}:${String(listener.calls[0].port)}`, 'listen 必须与句柄同源')
  assert.equal(state.status.listen, state.settings.listen, '设置视图与状态必须是同一个 host:port')
  assert.equal(state.status.running, state.settings.accepting, 'accepting 与 status.running 必须同源')
  assert.equal(state.settings.enabled, true, '起成功会写句柄回声（旧行为保留，不是本模块的判断依据）')
})

test('ACC-2 反向：enabled=true 但没句柄 ⇒ accepting=false、listen=null（偏好不得冒充活真相）', async (t) => {
  const home = await makeHome(t)
  seedCert(home)
  // 崩溃残留形态：文件写着 enabled=true（上次是开着的），本进程没有任何句柄。
  await seedSettings(home, { enabled: true, mode: 'lan', lanAddress: LAN, port: 0 })
  const { service, listener } = await makeService(t, { home })

  const state = await service.getState()
  assert.equal(state.settings.enabled, true, '偏好仍然如实回报')
  assert.equal(state.settings.accepting, false, '没有句柄就不许说在接（这正是旧实现分不清的两件事）')
  assert.equal(state.settings.listen, null)
  assert.equal(state.status.running, false)
  assert.equal(state.status.listen, null)
  assert.equal(listener.calls.length, 0, '读状态绝不许顺手起监听')

  // 停止态下再存一次设置：accepting 仍然必须是 false（保存动作不是"起监听"）。
  const saved = await service.saveSettings({ mode: 'lan', port: 4488 })
  assert.equal(saved.settings.accepting, false)
  assert.equal(saved.settings.listen, null)
  assert.equal(listener.calls.length, 0, 'saveSettings 已不许按 enabled 起监听')
})

/* ------------------------------------------------------------------ 2) clobber 回归 */

test('ACC-4 clobber 回归（运行中）：provisioning 整文件重写后 autoStart 仍是 true', async (t) => {
  const home = await makeHome(t)
  seedCert(home)
  // 上一次进程留下的形态：意图为真、地址还是空的（自动挑选）。
  await seedSettings(home, { enabled: false, mode: 'lan', lanAddress: '', port: 0, autoStart: true })
  const { service, listener } = await makeService(t, { home })

  const started = await service.start()
  assert.equal(started.running, true, JSON.stringify(started.lastError))
  assert.equal(listener.calls.length, 1)
  assert.equal((await readRaw(home)).autoStart, true, '前提：起监听后意图在盘上为真')

  // 「打开配对面板」= 归一层重建设置 + 整文件写回（地址从 '' 变成 LAN ⇒ 必然走 persistEndpoint）。
  const rebuilt = await rebuildByProvision(home)
  assert.equal(rebuilt.changed.port, true, '前提：这次重建真的写了盘（否则用例什么也没证明）')

  const after = await readRaw(home)
  assert.equal(after.autoStart, true, '重建不许把意图丢掉（旧实现会；运行中曾靠进程内自愈代偿）')
  assert.equal(after.lanAddress, LAN, '重建照常把地址写进去')

  // 运行中的监听不受影响：重建只改配置，不碰句柄。
  const state = await service.getState()
  assert.equal(state.status.running, true)
  assert.equal(state.settings.accepting, true)
  assert.equal(state.settings.listen, state.status.listen)
  assert.equal(listener.calls.length, 1, '重建不得重起一个监听')
})

test('ACC-5 clobber 回归（已停止）：重建后 autoStart 仍是 true，下一次激活照样自动恢复', async (t) => {
  const home = await makeHome(t)
  // 停机态：没有进程、没有句柄 —— 这一条正是旧实现**必然丢意图**的状态（自愈根本帮不上）。
  await seedSettings(home, { enabled: false, mode: 'lan', lanAddress: '', port: 0, autoStart: true })

  const rebuilt = await rebuildByProvision(home)
  assert.equal(rebuilt.changed.port, true, '前提：这次重建真的写了盘')

  const after = await readRaw(home)
  assert.equal(after.autoStart, true, '停机态重建也不许丢意图（旧的停机态 clobber 已被根因修复）')

  // 端到端：重建之后再"重启一次 DSH"，激活路径仍然会自己把监听拉起来。
  const { service, listener } = await makeService(t, { home })
  const status = await service.autoStart()
  assert.equal(status.running, true, JSON.stringify(status.lastError))
  assert.equal(status.startedBy, 'auto')
  assert.equal(listener.calls.length, 1)
  assert.equal((await service.getState()).settings.accepting, true)
})

test('ACC-6 归一化保真双向：显式 false 不复活；缺键/坏值不凭空造键（也不抛 E_VALIDATION）', () => {
  const base = defaultRemoteSettings()

  // 重建表达式与 `pairingProvision.persistEndpoint()` 逐字一致。
  const on = normalizeRemoteSettings({ ...base, autoStart: true }, base)
  assert.equal(on.autoStart, true, '记录里有字面 true 就必须带出来（否则整文件重写会丢）')
  assert.equal(normalizeRemoteSettings(on, base).autoStart, true, '归一化必须幂等')

  const off = normalizeRemoteSettings({ ...base, autoStart: false }, base)
  assert.equal(off.autoStart, false, '显式 false 是"用户点了停止"的合法结果，不许被复活')

  // 缺键：字段**不出现**（不是 undefined 值），旧文件升级路径行为不变。
  const missing = normalizeRemoteSettings({ ...base }, base)
  assert.equal(Object.prototype.hasOwnProperty.call(missing, 'autoStart'), false, '缺键不凭空造键')

  // 坏值：不抛、不采纳、不污染其它字段（坏一个键不该让整份设置读不出来）。
  for (const bad of [null, 'true', 1, {}, []]) {
    const cleaned = normalizeRemoteSettings({ ...base, autoStart: bad }, base)
    assert.equal(Object.prototype.hasOwnProperty.call(cleaned, 'autoStart'), false, `坏值 ${String(bad)} 不许被接受`)
    assert.equal(cleaned.mode, base.mode, '坏值不许连累其它字段')
  }
})

/* --------------------------------------------------------------- 3) 两个死点已移除 */

test('ACC-7 死点清理：saveSettings 不再按 enabled 起监听（enabled 只是保存的偏好）', async (t) => {
  const home = await makeHome(t)
  seedCert(home)
  const { service, listener } = await makeService(t, { home })

  const saved = await service.saveSettings({ enabled: true, mode: 'lan', lanAddress: LAN, port: 0 })
  assert.equal(saved.settings.enabled, true, 'enabled 仍然如实落盘（保存的偏好语义不变）')
  assert.equal(saved.settings.accepting, false, '保存不是"起监听"：没有句柄就是没在接')
  assert.equal(saved.settings.listen, null)
  assert.equal(listener.calls.length, 0, '死点已删：saveSettings 不许再按 enabled 触发 start()')

  const state = await service.getState()
  assert.equal(state.status.running, false, 'getState 也不许隐式起监听')
  assert.equal(listener.calls.length, 0)

  // 真要起监听只有两条显式路径：面板 remoteStart（= start()）与激活时的 autoStart()。
  const manual = await service.start()
  assert.equal(manual.running, true, JSON.stringify(manual.lastError))
  assert.equal(listener.calls.length, 1)
})

test('ACC-8 源码守卫：dist 里不再出现"按 enabled 起监听"与 getState 的空分支', async () => {
  const source = await readFile(path.join(process.cwd(), 'dist', 'remote', 'service.js'), 'utf8')
  // 只对**代码**下判断：tsc 会把注释一起带进 dist，注释里提到旧行是文档、不是死点。
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.equal(/next\.enabled\s*&&\s*runtime\.handle\s*===\s*null/.test(code), false, 'saveSettings 的死点必须删掉')
  assert.equal(/settings\.enabled\s*&&\s*runtime\.handle\s*===\s*null/.test(code), false, 'getState 的死点必须删掉')
  // 正向：活真相只有一个取值口，且 status 与设置视图都从它拿。
  assert.match(code, /function listenerLive\(\)/, '活真相必须有唯一取值口')
  assert.match(code, /running: live\.accepting/, 'status.running 必须与 accepting 同源')
  assert.match(code, /accepting: live\.accepting/, '设置视图必须从同一份活真相派生')
})

/* ----------------------------------------------------- 4) 面板那句只在真的在接时出现 */

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
      await import(pathToFileURL(CLIENT_DIST).href + '?remote-accepting=' + Date.now())
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

/**
 * 只桩住远程组挂载时会调的那四个只读入口。
 * `settings` 原样交给用例——活真相与 `enabled` 的**每一种组合**都由用例点名。
 */
function stubFetch(settings, startedBy) {
  const routes = {
    pairingProvision: () => ({ ok: true, data: { view: { v: 1, transport: 'lan', host: LAN, port: 44996, token: 'present' }, changed: {}, republish: null } }),
    pairingTransports: () => ({ ok: true, data: { selected: 'lan', selectedHost: LAN, overrideUnavailable: false, candidates: {}, reasonLines: [] } }),
    pairingConnections: () => ({ ok: true, data: [] }),
    remoteGetState: () => ({
      ok: true,
      data: {
        settings,
        status: { running: settings.accepting === true, startedBy, probe: null, urls: [] },
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

async function renderPanel(settings, startedBy = null) {
  const Panel = await loadPanel()
  stubFetch(settings, startedBy)
  activeMount = mountPanel(Panel, { t: (key) => (ZH[key] || key), close() {} })
  activeMount.render()
  await settle()
  return activeMount.tree
}

test('ACC-3 面板只在真的在接时渲染「正在接受连接（addr:port）」', async (t) => {
  // ① 在接（accepting=true, listen 有值），但保存的偏好写着 false ⇒ 仍然要出现那一句。
  const live = await renderPanel(
    { mode: 'lan', enabled: false, autoStart: false, accepting: true, listen: '192.168.1.6:44996' },
    'manual',
  )
  const clause = dataText(live, 'remote-accepting')
  assert.equal(
    clause,
    ZH['lean.remote.accepting'].replace('{addr}', '192.168.1.6:44996'),
    '在接时必须说出「正在接受连接（addr:port）」，地址端口来自引擎的 listen',
  )
  assert.equal(dataText(live, 'remote-running'), ZH['lean.remote.started'], '原有的「已启动」行照旧')

  // ② 没在接（accepting=false），即使保存的偏好写着 true ⇒ 一个字都不许出现。
  const stale = await renderPanel(
    { mode: 'lan', enabled: true, autoStart: true, accepting: false, listen: null },
    null,
  )
  assert.equal(dataNodes(stale, 'remote-accepting').length, 0, 'enabled=true 不得冒充活真相')
  assert.equal(dataText(stale, 'remote-running'), ZH['lean.remote.stopped'])
  assert.equal(textOf(stale).includes('正在接受连接'), false, '整块文案里都不许出现这一句')

  // ③ accepting=true 但没有可用 listen ⇒ fail-closed，不渲染（说"在接"却给不出地址端口是假话）。
  const noAddress = await renderPanel(
    { mode: 'lan', enabled: true, autoStart: true, accepting: true, listen: null },
    'auto',
  )
  assert.equal(dataNodes(noAddress, 'remote-accepting').length, 0, '没有 addr:port 就不许渲染这一句')
  assert.equal(dataText(noAddress, 'remote-running'), ZH['lean.remote.started'], '「已启动」仍按 status 讲真话')
  assert.equal(dataNodes(noAddress, 'remote-autostart').length, 1, '自动恢复那一句不受影响')
})
