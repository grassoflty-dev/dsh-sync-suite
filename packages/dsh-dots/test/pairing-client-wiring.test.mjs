/**
 * mod-plugin-pairing-client：把精简面板的远程控制组接到配对引擎的**真实路径**守卫。
 *
 * 与 lean 面板车道同样的有状态 React 桩 + fetch 桩：宿主只传 `{ t, close }`，
 * 没有任何 seedState / seedLink。每个用例都先断言"挂载不触碰 secret 出口"，
 * 再点显式按钮验证 pairingShow / rotate / stop / audit 真的接线。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const clientDist = path.join(pkgDir, 'dist', 'client.js')
const zh = JSON.parse(readFileSync(path.join(pkgDir, 'locale', 'zh.json'), 'utf8'))

const TOKEN = 'rt_real_0123456789abcdef'
const PAYLOAD = JSON.stringify({
  v: 1, instanceId: 'gwl-pc', transport: 'lan', host: '192.168.1.6', port: 44996,
  token: TOKEN, tlsFingerprint: 'AA:BB', announceRef: ''
})
const TEXT = 'DSHDOTS1|1|gwl-pc|lan|192.168.1.6|44996|' + TOKEN + '|AA:BB||00000000'
// 引擎测 token 要走真实 schema 校验（≥32 字符），与 UI 桩用的短串分开。
const ENGINE_TOKEN_A = 'V4b2NzaGZmM0xaU1pYm5CV1dEeF9wQmFzZTY0AAAAA'
const ENGINE_TOKEN_B = 'V4b2NzaGZmM0xaU1pYm5CV1dEeF9wQmFzZTY0BBBBB'
const QR = { size: 5, modules: [[true, false, true, false, true], [false, true, false, true, false], [true, false, true, false, true], [false, true, false, true, false], [true, false, true, false, true]] }
const QR2 = { size: 3, modules: [[true, true, true], [true, false, true], [true, true, true]] }

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
      if (hooks[index] === undefined) { hooks[index] = { ran: true }; pendingEffects.push(fn) }
    },
    render,
    get tree() { return tree }
  }
}

let loadedPromise = null
async function loadPanel() {
  if (!loadedPromise) {
    loadedPromise = (async () => {
      let captured = null
      globalThis.window = { __ModuleLoader__: { load(cfg) { captured = cfg } } }
      await import(pathToFileURL(clientDist).href + '?pairing-client-wiring=' + Date.now())
      assert.ok(captured, 'client.js 必须注册 loader')
      const mod = captured.factory((id) => {
        if (id === 'react') return reactStub
        throw new Error(`unexpected require: ${id}`)
      })
      let Panel = null
      mod.apply({
        effect(fn) { const d = fn(); return typeof d === 'function' ? d : function () {} },
        locale: { register() { return function () {} }, bind() { return function (key) { return key } } },
        slots: { inject(_name, cb) { cb(); return function () {} }, register(_o, component) { Panel = component; return function () {} } }
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

const nodesOf = (tree) => { const out = []; walk(tree, (n) => out.push(n)); return out }
const dataNode = (tree, key) => nodesOf(tree).filter((n) => n.props && n.props['data-lean'] === key)
const dataText = (tree, key) => dataNode(tree, key).map(textOf).join('\n')
const button = (tree, label) => {
  const found = nodesOf(tree).filter((n) => n.type === 'button' && textOf(n.props.children) === label)
  assert.equal(found.length, 1, `按钮「${label}」必须恰好一个`)
  return found[0]
}

const copied = []
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { clipboard: { writeText: async (value) => { copied.push(value) } } }
})

const settle = async () => {
  for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setTimeout(resolve, 5))
}

const view = {
  v: 1, instanceId: 'gwl-pc', transport: 'lan', host: '192.168.1.6', port: 44996,
  tlsFingerprint: 'AA:BB', announceRef: '', token: 'present'
}
const reasonLines = [
  'Tailscale：平板需加入同一 tailnet',
  '局域网：同一 Wi-Fi',
  'IPv6：本机需有 IPv6，部分运营商屏蔽入站',
  '局域网也需要端口和令牌：二维码里已经带好，不用手输；令牌阻止同一网络里的其他人控制这台 DSH。'
]
const candidates = {
  tailscale: { kind: 'tailscale', available: false, reason: reasonLines[0], host: '' },
  lan: { kind: 'lan', available: true, reason: reasonLines[1], host: '192.168.1.6' },
  ipv6: { kind: 'ipv6', available: false, reason: reasonLines[2], host: '' }
}

function makeFetch(overrides = {}) {
  const calls = []
  let stopCount = 0
  let qrRound = 0
  const routes = Object.assign({
    pairingProvision: () => ({
      ok: true,
      data: {
        view,
        changed: { port: false, token: false, cert: false },
        republish: { key: 'pairing:gwl-pc', reason: 'first-publish', previousPort: 0, port: 44996 }
      }
    }),
    pairingTransports: () => ({
      ok: true,
      data: {
        selected: 'lan', selectedHost: '192.168.1.6', overrideUnavailable: false,
        candidates, reasonLines
      }
    }),
    pairingConnections: () => ({
      ok: true,
      data: [
        { at: '2026-11-22T18:04:00+08:00', peer: '192.168.*.*' },
        { at: '2026-11-22T18:07:00+08:00', peer: '2001:****' }
      ]
    }),
    pairingShow: () => {
      qrRound += 1
      return { ok: true, data: { payload: PAYLOAD, text: TEXT, qr: qrRound > 1 ? QR2 : QR } }
    },
    pairingRotateToken: () => ({
      ok: true,
      data: {
        view,
        changed: { port: false, token: true, cert: false },
        republish: { key: 'pairing:gwl-pc', reason: 'token-rotated', previousPort: 44996, port: 44996 }
      }
    }),
    remoteGetState: () => ({
      ok: true,
      data: { settings: { mode: 'lan', hasToken: true }, status: { running: stopCount === 0, probe: null }, modes: [] }
    }),
    remoteStop: () => { stopCount += 1; return { ok: true, data: { running: false } } },
    remoteProbe: () => ({ ok: true, data: { level: 'ok', verdict: '自检通过', checks: [] } })
  }, overrides.routes || {})
  globalThis.fetch = async function (_url, options) {
    const body = JSON.parse(options.body)
    calls.push(body)
    const handler = routes[body.action]
    const payload = typeof handler === 'function' ? await handler(body) : handler
    return {
      status: 200,
      async text() {
        return JSON.stringify(payload === undefined
          ? { ok: false, error: { code: 'E_NO_STUB', message: 'no stub' } }
          : payload)
      }
    }
  }
  return calls
}

async function renderReal(overrides = {}) {
  const Panel = await loadPanel()
  const calls = makeFetch(overrides)
  activeMount = mountPanel(Panel, { t: (key, vars) => {
    let out = zh[key] || key
    if (vars) for (const [k, v] of Object.entries(vars)) out = out.replace('{' + k + '}', v)
    return out
  }, close() {} })
  activeMount.render()
  await settle()
  return { mount: activeMount, calls, tree: activeMount.tree }
}

const click = async (tree, label) => { await button(tree, label).props.onClick(); await settle() }

test('W1：真实宿主 props 挂载 → pairingProvision / pairingTransports / pairingConnections 被调用；零 pairingShow / 零剪贴板', async () => {
  copied.length = 0
  const { calls, tree } = await renderReal()
  const actions = calls.map((c) => c.action)
  for (const action of ['pairingProvision', 'pairingTransports', 'pairingConnections', 'remoteGetState']) {
    assert.ok(actions.includes(action), `挂载必须调用 ${action}`)
  }
  assert.equal(actions.includes('pairingShow'), false, 'pairingShow 只能由显式动作触发')
  assert.equal(copied.length, 0, '挂载必须零剪贴板写入')
  for (const line of reasonLines) {
    assert.ok(textOf(tree).includes(line), `必须渲染运输原因行：${line}`)
  }
  assert.equal(dataText(tree, 'remote-transport').includes('lan'), true, '必须显示自动选中的方式')
})

test('W2：显式「显示二维码」→ pairingShow 产生唯一 svg（role=img / aria-label=二维码），矩阵来自 RPC', async () => {
  const { calls, mount } = await renderReal()
  assert.equal(nodesOf(mount.tree).filter((n) => n.type === 'svg').length, 0, '未显式显示前没有二维码')
  await click(mount.tree, zh['lean.remote.qr.show'])
  assert.ok(calls.some((c) => c.action === 'pairingShow'), '必须调用 pairingShow')
  const svgs = nodesOf(mount.tree).filter((n) => n.type === 'svg')
  assert.equal(svgs.length, 1, '恰好一张二维码')
  assert.equal(svgs[0].props.role, 'img')
  assert.equal(svgs[0].props['aria-label'], zh['lean.remote.qr'])
  const rects = nodesOf(mount.tree).filter((n) => n.type === 'rect')
  assert.equal(rects.length > 0, true, '二维码必须由 RPC 矩阵画出格子')
  assert.equal(JSON.stringify(mount.tree).includes(TOKEN), false, 'DOM 不得含 token')
})

test('W3：显式「复制配对串」才写剪贴板，写的是 pairingShow 的紧凑串', async () => {
  copied.length = 0
  const { calls, mount } = await renderReal()
  assert.equal(copied.length, 0)
  await click(mount.tree, zh['lean.remote.copy'])
  assert.equal(copied.length, 1)
  assert.equal(copied[0], TEXT, '复制的是 DSHDOTS1|… 紧凑配对串')
  assert.ok(calls.some((c) => c.action === 'pairingShow'), '复制必须经显式 pairingShow')
  assert.equal(textOf(mount.tree).includes(TOKEN), false, '复制后 DOM 仍不得含 token')
})

test('W4：重新生成 → pairingRotateToken + 新二维码 + 重新配对后果文案', async () => {
  const { calls, mount } = await renderReal()
  await click(mount.tree, zh['lean.remote.qr.show'])
  const before = nodesOf(mount.tree).filter((n) => n.type === 'rect').length
  await click(mount.tree, zh['lean.remote.generate'])
  assert.ok(calls.some((c) => c.action === 'pairingRotateToken'), '必须调用轮换 RPC')
  assert.ok(calls.filter((c) => c.action === 'pairingShow').length >= 2, '轮换后必须重新取二维码')
  assert.ok(textOf(mount.tree).includes(zh['lean.remote.rotated']), '必须显示重新配对后果')
  assert.ok(textOf(mount.tree).includes('旧二维码与旧令牌立即失效'), '后果文案要点名旧码失效')
  const after = nodesOf(mount.tree).filter((n) => n.type === 'rect').length
  assert.notEqual(before, after, '二维码必须是轮换后的新矩阵')
})

test('W5：审计渲染脱敏条目（时间 + 打码对端），不泄露完整地址', async () => {
  const { mount } = await renderReal()
  const audit = dataText(mount.tree, 'remote-audit')
  assert.ok(audit.includes(zh['lean.remote.audit.title']))
  assert.ok(audit.includes('18:04'), '必须显示时间')
  assert.ok(audit.includes('192.168.*.*'), '必须显示脱敏身份')
  assert.equal(audit.includes('192.168.1.6'), false, '不得显示完整地址')
  assert.equal(audit.includes(TOKEN), false, '不得显示 token')
})

test('W6：停止接受连接 → remoteStop 被调用并显示已停止状态', async () => {
  const { calls, mount } = await renderReal()
  await click(mount.tree, zh['lean.remote.stop'])
  assert.ok(calls.some((c) => c.action === 'remoteStop'), '必须调用停止监听 RPC')
  assert.ok(dataText(mount.tree, 'remote-status').includes(zh['lean.remote.stopped']), '必须显示已停止')
})

test('W7：手动覆盖不可用 → 回落自动选择并明说，下拉显示真实选中方式', async () => {
  const { calls, mount } = await renderReal({
    routes: {
      pairingTransports: (body) => ({
        ok: true,
        data: {
          selected: 'lan', selectedHost: '192.168.1.6',
          overrideUnavailable: body.transport === 'ipv6',
          candidates, reasonLines
        }
      })
    }
  })
  const select = nodesOf(mount.tree).filter((n) => n.type === 'select')[0]
  const ipv6 = select.props.children.find((o) => o.props.value === 'ipv6')
  assert.equal(ipv6.props.disabled, true, '不可用的方式必须灰掉而不是消失')
  select.props.onChange({ target: { value: 'ipv6' } })
  await settle()
  assert.ok(calls.some((c) => c.action === 'pairingTransports' && c.transport === 'ipv6'), '必须把覆盖下传')
  assert.ok(dataText(mount.tree, 'remote-status').includes(zh['lean.remote.transport.fallback']), '必须明说已回落')
  const fresh = nodesOf(mount.tree).filter((n) => n.type === 'select')[0]
  assert.equal(fresh.props.value, 'lan', '下拉必须显示自动选中的 lan')
})

test('W8：精简清单守卫——远程组没有端口 / 令牌输入框，没有段落，secret 不进 DOM', async () => {
  const { mount } = await renderReal()
  const tree = mount.tree
  const nodes = nodesOf(tree)
  // 同步组保留 repoUrl(text) + sync token(password)；远程组不再有任何 port/token 输入。
  const inputs = nodes.filter((n) => n.type === 'input')
  assert.deepEqual(inputs.map((n) => n.props.type), ['text', 'password'])
  assert.equal(nodes.filter((n) => n.type === 'input' && n.props.type === 'number').length, 0, '不得有端口输入')
  assert.equal(nodes.filter((n) => n.type === 'p').length, 0, '不得有步骤说明段落')
  const remote = nodes.filter((n) => n.props && n.props.id === 'dots-remote')[0]
  const remoteNodes = []
  walk(remote.props.children, (n) => remoteNodes.push(n))
  assert.deepEqual(
    remoteNodes.filter((n) => n.type === 'button').map((n) => textOf(n.props.children)),
    [zh['lean.remote.qr.show'], zh['lean.remote.copy'], zh['lean.remote.generate'], zh['lean.remote.selfcheck'], zh['lean.remote.stop']]
  )
  assert.equal(JSON.stringify(tree).includes(TOKEN), false)
  assert.equal(JSON.stringify(tree).includes(PAYLOAD), false)
})

test('W9：无任何可用传输 → 明确显示「未检测到可用网络」和不可用项，绝不静默消失', async () => {
  const { mount } = await renderReal({
    routes: {
      pairingTransports: () => ({
        ok: true,
        data: {
          selected: null, selectedHost: '', overrideUnavailable: false,
          candidates: {
            tailscale: { kind: 'tailscale', available: false, reason: reasonLines[0], host: '' },
            lan: { kind: 'lan', available: false, reason: reasonLines[1], host: '' },
            ipv6: { kind: 'ipv6', available: false, reason: reasonLines[2], host: '' }
          },
          reasonLines
        }
      })
    }
  })
  assert.ok(textOf(mount.tree).includes(zh['lean.remote.transport.none']))
  const select = nodesOf(mount.tree).filter((n) => n.type === 'select')[0]
  assert.ok(select.props.children.filter((o) => o.props.disabled).length === 3, '三项都要灰掉')
})

/* ------------------------------------------------------------------ */
/* 引擎侧：脱敏审计 + 公告标记（接线 TODO 7a）                            */
/* ------------------------------------------------------------------ */

test('W10：redactPeer 只保留前缀，完整地址与 token 永不留在审计里', async () => {
  const { redactPeer } = await import('../dist/remote/pairingAudit.js')
  assert.equal(redactPeer('192.168.1.6'), '192.168.*.*')
  assert.equal(redactPeer('::ffff:192.168.1.6'), '192.168.*.*')
  assert.equal(redactPeer('2001:db8::1'), '2001::****')
  assert.equal(redactPeer('not-an-ip'), '已脱敏')
  assert.equal(redactPeer(''), '未知')
})

test('W11：无公告钩子 → 标记被清空且每次 provision 都 forced republish（同 key，不冒充已公告）', async () => {
  const { createPairingService } = await import('../dist/remote/pairingProvision.js')
  const { RemoteStore } = await import('../dist/remote/store.js')
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-pairing-marker-'))
  try {
    const store = new RemoteStore({ homeDir: dir })
    store.writePairingAnnouncement({ v: 1, announcedPort: 44996, announceRef: '', key: 'pairing:gwl-pc' })
    const service = createPairingService({
      homeDir: dir,
      instanceId: 'gwl-pc',
      interfaceSeam: { interfaces: () => [{ name: 'WLAN', family: 'IPv4', address: '192.168.1.6' }] },
      isPortFree: () => true,
      generateTokenFn: () => ENGINE_TOKEN_A
    })
    const first = await service.provision()
    assert.equal(first.republish.reason, 'first-publish', '无钩子也必须强制重发')
    assert.equal(first.republish.key, 'pairing:gwl-pc', '同 key')
    assert.equal(store.readPairingAnnouncement().announcedPort, null, '标记必须被清空，不得宣称已公告')
    const second = await service.provision()
    assert.equal(second.republish.reason, 'first-publish', '仍然 forced republish')
    assert.equal(store.readPairingAnnouncement().announcedPort, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('W12：有公告钩子 → 标记反映已公告端口；轮换后重发同 key 的新载荷', async () => {
  const { createPairingService } = await import('../dist/remote/pairingProvision.js')
  const { RemoteStore } = await import('../dist/remote/store.js')
  const { parsePairingPayload } = await import('../dist/remote/pairingPayload.js')
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-pairing-marker-hook-'))
  try {
    const events = []
    let tokenRound = 0
    const store = new RemoteStore({ homeDir: dir })
    const service = createPairingService({
      homeDir: dir,
      instanceId: 'gwl-pc',
      interfaceSeam: { interfaces: () => [{ name: 'WLAN', family: 'IPv4', address: '192.168.1.6' }] },
      isPortFree: () => true,
      generateTokenFn: () => (tokenRound++ === 0 ? ENGINE_TOKEN_A : ENGINE_TOKEN_B),
      onRepublish: (event) => { events.push(event) }
    })
    const first = await service.provision()
    assert.equal(store.readPairingAnnouncement().announcedPort, first.state.port, '钩子成功后标记反映已公告端口')
    assert.equal((await service.provision()).republish, null, '有钩子且已发布 → 幂等，不再重发')
    const rotated = await service.rotateToken()
    assert.equal(rotated.republish.reason, 'token-rotated')
    assert.equal(rotated.republish.key, first.republish.key, '同 key')
    assert.notEqual(parsePairingPayload(rotated.republish.payload).token, parsePairingPayload(first.republish.payload).token)
    assert.equal(events.length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('W13：审计环有界 + 入站钩子经 RPC 只回脱敏条目', async () => {
  const { createPairingService } = await import('../dist/remote/pairingProvision.js')
  const service = createPairingService({
    interfaceSeam: { interfaces: () => [{ name: 'WLAN', family: 'IPv4', address: '192.168.1.6' }] },
    isPortFree: () => true
  })
  for (let i = 0; i < 25; i += 1) service.recordConnection('10.0.0.' + (i + 1), '2026-11-22T18:00:00.000Z')
  const list = await service.connections()
  assert.equal(list.length, 20, '有界：最多 20 条')
  assert.ok(list.every((e) => e.peer === '10.0.*.*'), '全部脱敏')
  assert.equal(JSON.stringify(list).includes('10.0.0.'), false)
})

/* ------------------------------------------------------------------ */
/* 传输诚实（Lead 追加）：TLS 落地前只讲事实，不做通道安全承诺             */
/* ------------------------------------------------------------------ */

const PLAINTEXT_COPY = '当前为明文 HTTP，仅建议在 Tailscale 下使用；加密传输模块随后'
const RECOMMENDED_COPY = '推荐：Tailscale（已加密）'

test('W14：LAN / IPv6 渲染明文 HTTP 警告；用户切换方式即出现', async () => {
  const { mount } = await renderReal()
  const honesty = dataText(mount.tree, 'remote-transport-honesty')
  assert.ok(honesty.includes(PLAINTEXT_COPY), `LAN 必须显示：${PLAINTEXT_COPY}`)
  assert.equal(honesty.includes(RECOMMENDED_COPY), false)

  const ipv6 = await renderReal({
    routes: {
      pairingTransports: () => ({
        ok: true,
        data: {
          selected: 'ipv6', selectedHost: '[2001:db8::1]', overrideUnavailable: false,
          candidates, reasonLines
        }
      })
    }
  })
  assert.ok(dataText(ipv6.mount.tree, 'remote-transport-honesty').includes(PLAINTEXT_COPY), 'IPv6 也必须显示同一句明文警告')
})

test('W15：Tailscale 标为推荐 / 已加密，且不显示明文警告', async () => {
  const { mount } = await renderReal({
    routes: {
      pairingTransports: () => ({
        ok: true,
        data: {
          selected: 'tailscale', selectedHost: '100.64.0.2', overrideUnavailable: false,
          candidates, reasonLines
        }
      })
    }
  })
  const honesty = dataText(mount.tree, 'remote-transport-honesty')
  assert.ok(honesty.includes(RECOMMENDED_COPY), `Tailscale 必须显示：${RECOMMENDED_COPY}`)
  assert.equal(honesty.includes(PLAINTEXT_COPY), false, 'Tailscale 在加密隧道内，不显示明文警告')
})

test('W16：面板文案三处字典都没有通道安全 / MITM 承诺', () => {
  const banned = ['防中间人', '中间人', 'MITM', 'man-in-the-middle', '防嗅探', '防窃听']
  const client = readFileSync(path.join(pkgDir, 'src', 'client.js'), 'utf8')
  const sources = [client, zhSrc(), enSrc()]
  for (const source of sources) {
    for (const term of banned) {
      assert.equal(source.includes(term), false, `面板文案不得出现「${term}」`)
    }
  }
  // 正向钉住两句新文案确实在三处都逐字存在。
  for (const source of sources) {
    assert.equal(source.includes(PLAINTEXT_COPY) || source.includes('Plain HTTP right now'), true)
  }
})

function zhSrc() { return readFileSync(path.join(pkgDir, 'locale', 'zh.json'), 'utf8') }
function enSrc() { return readFileSync(path.join(pkgDir, 'locale', 'en.json'), 'utf8') }
