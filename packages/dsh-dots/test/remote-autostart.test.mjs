/**
 * mod-plugin-remote-autostart：**自动恢复**远程监听（"重启后不用再点一次开始接受连接"）。
 *
 * 这一层要钉死三件事，缺一条就等于本模块没做到：
 *   1. **意图位是 `remote.json` 的 `autoStart`**，不是 `enabled`（后者是句柄回声）；
 *   2. 激活入口 `autoStart()` 是唯一的自动启动路径：意图为真才起，已有句柄不起，
 *      失败只留 typed `lastError` 且**不清意图**（下次激活再试一次）；
 *   3. 显式 `stop()` 必须把意图清掉落盘——否则下次重启会把用户刻意关掉的监听"复活"。
 *
 * 纪律：**绝不**起真实监听。`startListener` 是注入的假工厂（只记录入参），上游身份来自
 * 一个只监听 127.0.0.1 的假 DSH 桩（与 `remote-service.test.mjs` 同一手法）。
 * 面板一句「已在启动时自动恢复」用真实渲染器（`dist/client.js`）验证。
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
import { generatePairingCertificate } from '../dist/remote/pairingTls.js'

const LAN = '192.168.1.6'
const ZH = JSON.parse(await readFile(path.join(process.cwd(), 'locale', 'zh.json'), 'utf8'))
const CLIENT_DIST = path.join(process.cwd(), 'dist', 'client.js')

async function makeHome(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'dsh-remote-auto-'))
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
 * 刻意不经 `saveSettings`——RPC 归一不认 `autoStart`（那是意图位，不是用户可保存的表单字段），
 * 只有"重启后的读"才该看到它。
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

/** 注入式监听工厂：只记录调用，绝不开端口。 */
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

/** 一份"上次跑过并且是开着的"设置（不含意图键——意图由每个用例自己决定）。 */
const BASE_SETTINGS = { enabled: true, mode: 'lan', lanAddress: LAN, port: 0, token: '' }

/* ------------------------------------------------------------------ 激活语义 */

test('A1：意图为真 ⇒ 激活时自动起监听，恰好一次，并标出 startedBy=auto', async (t) => {
  const home = await makeHome(t)
  seedCert(home)
  await seedSettings(home, { ...BASE_SETTINGS, autoStart: true })
  const { service, listener } = await makeService(t, { home })

  const status = await service.autoStart()
  assert.equal(status.running, true, JSON.stringify(status.lastError))
  assert.equal(listener.calls.length, 1, '激活只许起一次监听')
  assert.equal(listener.calls[0].bindAddress, LAN)
  assert.equal(status.startedBy, 'auto', '面板要能说出"这是启动时自动恢复的"')
  assert.equal(status.lastError, null)
  // 意图仍然落盘为真（重启后的下一次还要自动恢复）。
  assert.equal((await readRaw(home)).autoStart, true)
})

test('A2：意图缺键（旧文件）⇒ 一次监听都不起，即使 enabled 写着 true', async (t) => {
  const home = await makeHome(t)
  seedCert(home)
  // 旧 remote.json：没有 autoStart 键，但 enabled=true（历史句柄回声）。
  await seedSettings(home, { enabled: true, mode: 'lan', lanAddress: LAN, port: 0 })
  const { service, listener } = await makeService(t, { home })

  const state = await service.getState()
  assert.equal(state.settings.autoStart, false, '缺键读作 false（旧文件不改变行为）')
  assert.equal(state.settings.enabled, true, 'enabled 仍在文件里，只是不再驱动自动启动')
  const status = await service.autoStart()
  assert.equal(status.running, false)
  assert.equal(listener.calls.length, 0, 'intent=off ⇒ 激活绝不碰监听工厂')
  assert.equal(status.startedBy, null)
})

test('A3：显式 stop() 清意图并落盘 ⇒ 下次激活不再自动恢复', async (t) => {
  const home = await makeHome(t)
  seedCert(home)
  await seedSettings(home, { ...BASE_SETTINGS, autoStart: true })
  const first = await makeService(t, { home })
  assert.equal((await first.service.autoStart()).running, true)
  assert.equal(first.listener.calls.length, 1)

  const stopped = await first.service.stop()
  assert.equal(stopped.running, false)
  assert.equal(stopped.startedBy, null, '停止后必须回到 null（与 running 同源）')
  assert.equal((await readRaw(home)).autoStart, false, '显式停止必须把意图落盘清零')
  await first.service.dispose()

  // "下一次 DSH 重启"：同一份 home 上新建服务，意图已是 false。
  const second = await makeService(t, { home })
  const status = await second.service.autoStart()
  assert.equal(status.running, false)
  assert.equal(second.listener.calls.length, 0, '用户刻意关掉的监听不许被复活')
})

test('A4：启动失败 ⇒ 激活照样 resolve，typed 原因可见，意图保留，下次激活重试一次', async (t) => {
  const home = await makeHome(t)
  // 故意不写证书：start() 必须在 TLS 材料缺失处 fail-closed。
  await seedSettings(home, { ...BASE_SETTINGS, autoStart: true })
  const { service, listener } = await makeService(t, { home })

  const failed = await service.autoStart() // 不抛 = 激活路径不受影响
  assert.equal(failed.running, false)
  assert.equal(failed.lastError.code, 'E_NO_TLS_CERT', 'typed 原因必须给面板')
  assert.equal(listener.calls.length, 0, '没有证书就不许起任何监听')
  assert.equal((await readRaw(home)).autoStart, true, '失败不许清意图（否则再也不会重试）')

  // 前提补齐后再激活一次 ⇒ 这一次真的起来（且只起一次）。
  seedCert(home)
  const retried = await service.autoStart()
  assert.equal(retried.running, true, JSON.stringify(retried.lastError))
  assert.equal(retried.lastError, null, '成功后必须清掉上次的失败原因')
  assert.equal(listener.calls.length, 1)
  assert.equal(retried.startedBy, 'auto')
})

test('A5：已有句柄 ⇒ 激活不重复起，startedBy 仍是 manual', async (t) => {
  const home = await makeHome(t)
  seedCert(home)
  await seedSettings(home, { enabled: false, mode: 'lan', lanAddress: LAN, port: 0 })
  const { service, listener } = await makeService(t, { home })

  const manual = await service.start()
  assert.equal(manual.running, true, JSON.stringify(manual.lastError))
  assert.equal(manual.startedBy, 'manual')
  assert.equal(listener.calls.length, 1)

  const again = await service.autoStart()
  assert.equal(again.running, true)
  assert.equal(listener.calls.length, 1, '已经有句柄时绝不再起一个监听')
  assert.equal(again.startedBy, 'manual', '谁是这次监听的主人，不许被后来的激活改写')
})

test('A6：手动启动失败也记住意图 ⇒ 重启后的激活会补起监听（不再静默丢意图）', async (t) => {
  const home = await makeHome(t)
  seedCert(home) // 证书先备好，失败原因换成"缺可绑定地址"
  await seedSettings(home, { enabled: false, mode: 'lan', lanAddress: '', port: 0 })
  const first = await makeService(t, {
    home,
    service: { interfaces: () => [], routeProbeAddress: () => null }, // 选不出地址 ⇒ E_NO_BIND_ADDRESS
  })

  const failed = await first.service.start()
  assert.equal(failed.running, false)
  assert.equal(failed.lastError.code, 'E_NO_BIND_ADDRESS')
  assert.equal((await readRaw(home)).autoStart, true, '用户点了开始 = 表达过"我要它开着"，失败也留住')
  await first.service.dispose()

  // "重启"：这次网卡回来了。
  const second = await makeService(t, { home })
  const status = await second.service.autoStart()
  assert.equal(status.running, true, JSON.stringify(status.lastError))
  assert.equal(second.listener.calls.length, 1)
  assert.equal(status.startedBy, 'auto')
})

/* ------------------------------------------------------------------ 意图被外部写入者抹掉 */

test('A8：外部写入把 autoStart 整个键丢掉时，运行中的下一次读会补写回 true；显式 false 不动', async (t) => {
  const home = await makeHome(t)
  seedCert(home)
  await seedSettings(home, { ...BASE_SETTINGS, autoStart: true })
  const { service, listener } = await makeService(t, { home })
  assert.equal((await service.autoStart()).running, true)
  assert.equal(listener.calls.length, 1)

  // 模拟 `pairingProvision.persistEndpoint()`：用归一后的设置整文件重写，键被静默丢掉。
  const foreign = await readRaw(home)
  delete foreign.autoStart
  await writeFile(configFile(home), JSON.stringify(foreign, null, 2) + '\n', 'utf8')
  assert.equal('autoStart' in (await readRaw(home)), false, '前提：键确实被外部写入者抹掉了')

  await service.getState()
  assert.equal((await readRaw(home)).autoStart, true, '运行中的句柄就是意图为真的证据，必须补写回去')
  assert.equal(listener.calls.length, 1, '补写只是恢复意图，不许因此再起一个监听')

  // 反向：外部写入显式写成 false（等价于"用户点了停止"的合法结果）→ 只读路径不许覆盖它。
  await seedSettings(home, { autoStart: false })
  await service.getState()
  assert.equal((await readRaw(home)).autoStart, false, '显式 false 是合法状态，自愈不得把它改回 true')
})

/* ------------------------------------------------------------------ 面板那一句 */

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
      await import(pathToFileURL(CLIENT_DIST).href + '?remote-autostart=' + Date.now())
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

/** 只桩住远程组挂载时会调的那四个只读入口；`startedBy` 由用例给。 */
function stubFetch(startedBy) {
  const routes = {
    pairingProvision: () => ({ ok: true, data: { view: { v: 1, transport: 'lan', host: LAN, port: 44996, token: 'present' }, changed: {}, republish: null } }),
    pairingTransports: () => ({ ok: true, data: { selected: 'lan', selectedHost: LAN, overrideUnavailable: false, candidates: {}, reasonLines: [] } }),
    pairingConnections: () => ({ ok: true, data: [] }),
    remoteGetState: () => ({
      ok: true,
      data: {
        settings: { mode: 'lan', enabled: true, autoStart: startedBy === 'auto', accepting: startedBy !== null },
        status: { running: startedBy !== null, startedBy, probe: null, urls: [] },
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

async function renderPanel(startedBy) {
  const Panel = await loadPanel()
  stubFetch(startedBy)
  activeMount = mountPanel(Panel, { t: (key) => (ZH[key] || key), close() {} })
  activeMount.render()
  await settle()
  return activeMount.tree
}

test('A7：面板给自动恢复的那一次一句「已在启动时自动恢复」（手动启动/停止时不出现）', async (t) => {
  const auto = await renderPanel('auto')
  assert.equal(dataText(auto, 'remote-autostart'), ZH['lean.remote.autostarted'], '自动恢复必须留一句说明')
  assert.equal(dataText(auto, 'remote-running'), ZH['lean.remote.started'], '「已启动」这一行本身不许被改写')

  const manual = await renderPanel('manual')
  assert.equal(dataNodes(manual, 'remote-autostart').length, 0, '手动启动不显示自动恢复的说明')

  const idle = await renderPanel(null)
  assert.equal(dataNodes(idle, 'remote-autostart').length, 0, '未启动时不显示')
  assert.equal(dataText(idle, 'remote-running'), ZH['lean.remote.stopped'])
})
