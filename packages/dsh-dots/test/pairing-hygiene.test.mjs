/**
 * mod-plugin-pairing / secret 卫生的**真实面板**守卫：
 *   - 挂载 / 接线过程零剪贴板写入（只有显式「复制」按钮才碰 clipboard）；
 *   - 渲染树里任何字符串都不含 token / 完整配对串（二维码矩阵 + 复制，绝不纯文本）；
 *   - typed 错误只给 reason 不给值；RPC 的 provision 视图不回 secret，只有 show 回。
 *
 * 与 lean 面板车道使用同一种有状态 React 桩 + fetch 桩技术，**不修改**其任何文件。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const clientDist = path.join(pkgDir, 'dist', 'client.js')
const zh = JSON.parse(readFileSync(path.join(pkgDir, 'locale', 'zh.json'), 'utf8'))

const TOKEN = 'rt_real_0123456789abcdef'
const LINK = {
  url: 'http://192.168.1.6:44996/?token=' + TOKEN,
  qr: { size: 3, modules: [[true, false, true], [false, true, false], [true, false, true]] },
  note: ''
}
const PAYLOAD = JSON.stringify({
  v: 1, instanceId: 'gwl-pc', transport: 'lan', host: '192.168.1.6', port: 44996,
  token: TOKEN, tlsFingerprint: 'AA:BB', announceRef: ''
})

function flatten(list, out) {
  for (const item of list) {
    if (Array.isArray(item)) flatten(item, out)
    else if (item !== null && item !== undefined && item !== false && item !== true) out.push(item)
  }
  return out
}

let activeMount = null
const reactStub = {
  Fragment: Symbol('Fragment'),
  createElement(type, props, ...children) {
    const next = Object.assign({}, props || {})
    const kids = flatten(children, [])
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
  Children: { toArray(value) { return flatten(Array.isArray(value) ? value : [value], []) } }
}

function mountPanel(Panel, props) {
  const hooks = []
  let cursor = 0
  let pendingEffects = []
  let rendering = false
  let tree = null
  function render() {
    cursor = 0
    pendingEffects = []
    rendering = true
    tree = Panel(props)
    rendering = false
    const effects = pendingEffects
    pendingEffects = []
    for (const effect of effects) effect()
    return tree
  }
  const mount = {
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
      if (hooks[index] === undefined) { hooks[index] = { ran: true }; pendingEffects.push(fn) }
    },
    render,
    get tree() { return tree }
  }
  return mount
}

let loadedPromise = null
async function loadPanel() {
  if (!loadedPromise) {
    loadedPromise = (async () => {
      let captured = null
      globalThis.window = { __ModuleLoader__: { load(cfg) { captured = cfg } } }
      await import(pathToFileURL(clientDist).href + '?pairing-hygiene=' + Date.now())
      assert.ok(captured, 'client.js 必须注册 loader')
      const mod = captured.factory((id) => {
        if (id === 'react') return reactStub
        throw new Error(`unexpected require: ${id}`)
      })
      let Panel = null
      mod.apply({
        effect(fn) { const d = fn(); return typeof d === 'function' ? d : function () {} },
        locale: { register() { return function () {} }, bind() { return function (key) { return key } } },
        slots: {
          inject(_name, cb) { cb(); return function () {} },
          register(_options, component) { Panel = component; return function () {} }
        }
      })
      assert.ok(Panel)
      return Panel
    })()
  }
  return loadedPromise
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

function textOf(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node && typeof node === 'object') return textOf(node.props && node.props.children)
  return ''
}

const copied = []
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { clipboard: { writeText: async (value) => { copied.push(value) } } }
})

const settle = async () => {
  for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setTimeout(resolve, 5))
}

async function renderReal() {
  const Panel = await loadPanel()
  globalThis.fetch = async function (_url, options) {
    const body = JSON.parse(options.body)
    const data = {
      getState: { settings: { repoUrl: 'https://github.com/u/r.git', mode: 'lan', port: 44996, hasToken: true }, status: {}, modes: [] },
      remoteGetState: { settings: { repoUrl: 'https://github.com/u/r.git', mode: 'lan', port: 44996, hasToken: true }, status: {}, modes: [] },
      remoteShowLink: LINK,
      remoteProbe: { level: 'ok', verdict: '自检通过', checks: [] }
    }[body.action]
    return { status: 200, async text() { return JSON.stringify(data === undefined ? { ok: false, error: { code: 'E_NO_STUB', message: 'no stub' } } : { ok: true, data }) } }
  }
  activeMount = mountPanel(Panel, { t: (key) => zh[key] || key, close() {} })
  activeMount.render()
  await settle()
  return activeMount
}

test('H1：挂载 / 接线过程零剪贴板写入（只有显式「复制」按钮可以写）', async () => {
  copied.length = 0
  await renderReal()
  assert.equal(copied.length, 0, 'mount 不得自动复制含令牌的地址')
})

test('H2：渲染树里没有 token、完整载荷或含 token 的 URL（QR + 复制，绝不纯文本）', async () => {
  const mount = await renderReal()
  const strings = []
  walk(mount.tree, (node) => {
    strings.push(textOf(node.props.children))
    for (const [key, value] of Object.entries(node.props)) {
      if (typeof value === 'string') strings.push(value)
      if (key === 'value' && typeof value === 'string') strings.push(value)
    }
  })
  const all = strings.join('\n')
  assert.equal(all.includes(TOKEN), false, 'DOM 文本不得出现 token')
  assert.equal(all.includes(PAYLOAD), false, 'DOM 文本不得出现完整配对载荷')
  assert.equal(all.includes(LINK.url), false, 'DOM 文本不得出现含 token 的链接')
  const nodes = []
  walk(mount.tree, (node) => nodes.push(node))
  assert.equal(nodes.filter((n) => n.type === 'button').length >= 1, true)
})

test('H3：显式点「复制」才写剪贴板，且复制后 DOM 仍无 token', async () => {
  copied.length = 0
  const mount = await renderReal()
  const nodes = []
  walk(mount.tree, (node) => nodes.push(node))
  const copyButton = nodes.find((n) => n.type === 'button' && textOf(n.props.children) === zh['lean.remote.copy'])
  assert.ok(copyButton, '必须存在显式「复制」按钮')
  await copyButton.props.onClick()
  await settle()
  assert.equal(copied.length, 1)
  assert.equal(copied[0], LINK.url)
  assert.equal(textOf(mount.tree).includes(TOKEN), false)
})

test('H4：RPC pairingProvision 只有脱敏视图；pairingShow 才是显式 secret 出口', async () => {
  const { createRpcService } = await import('../dist/rpc.js')
  const { PairingError } = await import('../dist/remote/pairingPayload.js')
  const { describePairing } = await import('../dist/remote/pairingPayload.js')
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-pairing-rpc-'))
  try {
    const token = 'V4b2NzaGZmM0xaU1pYm5CV1dEeF9wQmFzZTY0dXJsMTIzNDU2Nzg'
    const FP = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99'
    const view = describePairing({
      v: 1, instanceId: 'gwl-pc', transport: 'lan', host: '192.168.1.6', port: 44996,
      token, tlsFingerprint: FP, announceRef: ''
    })
    const service = createRpcService({
      homeDir: dir,
      pairing: {
        provision: async () => ({ view, changed: { port: false, token: false, cert: false }, republish: null }),
        show: async () => ({ payload: PAYLOAD, text: 'DSHDOTS1|...', qr: { size: 1, modules: [[true]] } }),
        rotateToken: async () => ({ view, changed: { port: false, token: true, cert: false }, republish: null }),
        rotateCert: async () => ({ view, changed: { port: false, token: false, cert: true }, republish: null }),
        transports: async () => ({ selected: 'lan', selectedHost: '192.168.1.6', overrideUnavailable: false, candidates: {}, reasonLines: [] }),
      },
    })
    const provisioned = await service.handleRpc({ action: 'pairingProvision' })
    assert.equal(provisioned.ok, true)
    assert.equal(JSON.stringify(provisioned).includes(TOKEN), false)
    assert.equal(JSON.stringify(provisioned).includes(PAYLOAD), false)
    const shown = await service.handleRpc({ action: 'pairingShow' })
    assert.equal(shown.ok, true)
    assert.equal(shown.data.payload, PAYLOAD)
    const error = new PairingError('E_PAIRING_TOKEN', 'token 长度或字符集合不合法')
    assert.equal(JSON.stringify(error).includes(token), false)
    await service.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('H5：所有配对 RPC 响应都不含私钥材料（state.cert.keyPem 被投影彻底剥离）', async () => {
  const { createRpcService } = await import('../dist/rpc.js')
  const { describePairing } = await import('../dist/remote/pairingPayload.js')
  const { generatePairingCertificate } = await import('../dist/remote/pairingTls.js')
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-pairing-keyproj-'))
  try {
    const cert = generatePairingCertificate({ now: () => new Date('2026-01-01T00:00:00.000Z') })
    const keyNeedle = cert.keyPem.split('\n').find((line) => line.length > 20).slice(0, 24)
    const token = 'V4b2NzaGZmM0xaU1pYm5CV1dEeF9wQmFzZTY0dXJsMTIzNDU2Nzg'
    const payload = JSON.stringify({
      v: 1, instanceId: 'gwl-pc', transport: 'lan', host: '192.168.1.6', port: 44996,
      token, tlsFingerprint: cert.fingerprint, announceRef: '',
    })
    const view = describePairing(JSON.parse(payload))
    // 模拟"内部完整状态"：state 里带真实私钥 PEM + 私钥首字节；它绝不能跨 RPC 边界。
    const full = {
      state: {
        instanceId: 'gwl-pc', transport: 'lan', host: '192.168.1.6', port: 44996,
        token, tlsFingerprint: cert.fingerprint, announceRef: '', cert,
      },
      view,
      payload,
      text: 'DSHDOTS1|1|gwl-pc|lan|192.168.1.6|44996|token|fp||00000000',
      republish: {
        type: 'pairing.announce.republish', key: 'pairing:gwl-pc', reason: 'port-changed',
        previousPort: 44995, port: 44996, payload, text: 'DSHDOTS1|...',
      },
      changed: { port: true, token: false, cert: false },
    }
    const service = createRpcService({
      homeDir: dir,
      pairing: {
        provision: async () => full,
        rotateToken: async () => full,
        rotateCert: async () => full,
        show: async () => ({ payload: full.payload, text: full.text, qr: { size: 1, modules: [[true]] } }),
        transports: async () => ({ selected: 'lan', selectedHost: '192.168.1.6', overrideUnavailable: false, candidates: {}, reasonLines: [] }),
      },
    })
    for (const action of ['pairingProvision', 'pairingRotateToken', 'pairingRotateCert', 'pairingTransports', 'pairingShow']) {
      const response = await service.handleRpc({ action })
      assert.equal(response.ok, true, `${action} 应当成功`)
      const text = JSON.stringify(response)
      assert.equal(text.includes('PRIVATE KEY'), false, `${action} 不得泄露 PEM 私钥`)
      assert.equal(text.includes('keyPem'), false, `${action} 不得回传 keyPem 字段`)
      assert.equal(text.includes(keyNeedle), false, `${action} 不得回传私钥首字节`)
      if (action !== 'pairingShow') {
        assert.equal(text.includes(token), false, `${action} 不是显式 secret 出口`)
        assert.equal(text.includes(payload), false, `${action} 不得回传完整配对载荷`)
      }
    }
    await service.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
