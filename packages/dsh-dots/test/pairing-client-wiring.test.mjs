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

// mod-plugin-remote-hints-mode-keyed：none 只给唯一推荐动作；旧并列文案作为反例钉死。
const NONE_HINT_ZH = '未检测到可用网络：推荐先登录 Tailscale，让平板加入同一 tailnet。'
const OLD_NONE_HINT_ZH = '请先连同一 Wi-Fi，或登录 Tailscale 让平板加入同一 tailnet'

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
    // retarget（mod-plugin-remote-live-connections）：当前连接走 status.liveConnections，
    // 不再是 pairingConnections 的历史审计；这里给两条活对端（HTTP + 隧道）。
    remoteGetState: () => ({
      ok: true,
      data: {
        settings: { mode: 'lan', hasToken: true },
        status: {
          running: stopCount === 0,
          probe: null,
          liveConnections: {
            connections: [
              {
                id: 'lc-1', peer: '192.168.1.11', transport: '局域网', kind: 'http',
                since: new Date(Date.now() - 3 * 60_000).toISOString(),
                lastSeen: new Date().toISOString(),
              },
              {
                id: 'lc-2', peer: '100.64.0.2', transport: 'Tailscale', kind: 'tunnel',
                since: new Date(Date.now() - 5 * 60_000).toISOString(),
                lastSeen: new Date().toISOString(),
              },
            ],
            count: 2,
          },
        },
        modes: []
      }
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

// retarget（mod-plugin-remote-live-connections，pairing-client-wiring.test.mjs:260）：
// 历史审计 RPC 从挂载路径移除；当前连接改由 remoteGetState 的状态给出，断言改为"绝不调用旧 RPC"。
test('W1：真实宿主 props 挂载 → pairingProvision / pairingTransports / remoteGetState 被调用；零 pairingConnections / 零 pairingShow / 零剪贴板', async () => {
  copied.length = 0
  const { calls, tree } = await renderReal()
  const actions = calls.map((c) => c.action)
  for (const action of ['pairingProvision', 'pairingTransports', 'remoteGetState']) {
    assert.ok(actions.includes(action), `挂载必须调用 ${action}`)
  }
  assert.equal(actions.includes('pairingConnections'), false, '历史审计 RPC 不得再被调用')
  assert.equal(actions.includes('pairingShow'), false, 'pairingShow 只能由显式动作触发')
  assert.equal(copied.length, 0, '挂载必须零剪贴板写入')
  for (const line of reasonLines) {
    assert.ok(textOf(tree).includes(line), `必须渲染运输原因行：${line}`)
  }
  // retarget（mod-plugin-remote-hints-mode-keyed）：方式行只显示 lan 自己的提示，不再显示「自动选中：lan」。
  assert.equal(dataText(tree, 'remote-transport'), zh['lean.remote.hint.lan'], '只显示 lan 方式自己的一句提示')
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

// retarget（mod-plugin-remote-live-connections，pairing-client-wiring.test.mjs:314）：
// 旧的"历史审计 + 打码身份"断言换成"当前连接：IP · 传输 · 已连接 N 分钟 + 隧道标记"；
// 脱敏纪律不放宽：token / 查询串 / URL 依旧逐项断言不存在。
test('W5：当前连接渲染活条目（IP · 传输 · 已连接 N 分钟；隧道标「正在查看」），不泄露 token / ?', async () => {
  const { mount } = await renderReal()
  const audit = dataText(mount.tree, 'remote-audit')
  assert.ok(audit.includes(zh['lean.remote.audit.title']))
  assert.equal(audit.includes('谁连进来过'), false, '历史文案不得复活')
  assert.equal(dataNode(mount.tree, 'remote-live-connection').length, 2, '每个活对端恰好一行')
  assert.ok(audit.includes('192.168.1.11 · 局域网 · 已连接 3 分钟'), 'HTTP 行格式必须是 IP · 传输 · 已连接 N 分钟')
  assert.ok(audit.includes('100.64.0.2 · Tailscale · 已连接 5 分钟 · 正在查看'), '隧道行必须额外标「正在查看」')
  assert.equal(audit.includes('192.168.*.*'), false, '脱敏历史身份不得再上屏')
  assert.equal(audit.includes('18:04'), false, '历史审计时间不得再上屏')
  assert.equal(audit.includes(TOKEN), false, '不得显示 token')
  assert.equal(audit.includes('?'), false, '不得显示查询串')
  assert.equal(audit.includes('://'), false, '不得显示 URL')
})

test('W5b：当前连接为空 → 显示「当前没有设备连接」而不是空框或历史条目', async () => {
  const { mount } = await renderReal({
    routes: {
      remoteGetState: () => ({
        ok: true,
        data: { settings: { mode: 'lan', hasToken: true }, status: { running: true, probe: null, liveConnections: { connections: [], count: 0 } }, modes: [] }
      })
    }
  })
  const audit = dataText(mount.tree, 'remote-audit')
  assert.ok(audit.includes(zh['lean.remote.audit.empty']))
  assert.equal(dataNode(mount.tree, 'remote-live-connection').length, 0)
  assert.equal(dataNode(mount.tree, 'remote-live-empty').length, 1)
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
  // retarget（mod-plugin-remote-hints-mode-keyed）：旧「同一 Wi-Fi 或 Tailscale」并列句 → 单一推荐动作句。
  assert.ok(textOf(mount.tree).includes(NONE_HINT_ZH), '必须显示新的单一推荐动作句')
  assert.equal(textOf(mount.tree).includes(OLD_NONE_HINT_ZH), false, '不得再并列多种方式的前提')
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
// mod-remote-tls-termination：加密说明由 transports.tls 数据驱动，不按方式名推断。
const ENCRYPTED_COPY = '已加密（自签名证书，按配对指纹校验）'
const ENCRYPTED_COPY_EN = 'Encrypted (self-signed certificate, verified against the pairing fingerprint)'

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

test('W15：tls=true 的 Tailscale 显示数据驱动的加密说明，且不显示明文警告', async () => {
  const { mount } = await renderReal({
    routes: {
      pairingTransports: () => ({
        ok: true,
        data: {
          tls: true, selected: 'tailscale', selectedHost: '100.64.0.2', overrideUnavailable: false,
          candidates, reasonLines
        }
      })
    }
  })
  const honesty = dataText(mount.tree, 'remote-transport-honesty')
  assert.ok(honesty.includes(ENCRYPTED_COPY), `tls=true 必须显示：${ENCRYPTED_COPY}`)
  assert.equal(honesty.includes(PLAINTEXT_COPY), false, 'tls=true 时不显示明文警告')
  assert.equal(honesty.includes(RECOMMENDED_COPY), false, '加密说明来自数据，不按方式名承诺')
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

/* ------------------------------------------------------------------ */
/* 客户端诚实性 / stopped 状态（TLS 车道规格：数据驱动，不按方式名）      */
/* ------------------------------------------------------------------ */

test('H1：transports.tls === true ⇒ 加密说明；任意方式名都不渲染明文警告', async () => {
  for (const selected of ['lan', 'ipv6', 'tailscale']) {
    const { mount } = await renderReal({
      routes: {
        pairingTransports: () => ({
          ok: true,
          data: {
            tls: true, selected, selectedHost: '192.168.1.6', overrideUnavailable: false,
            candidates, reasonLines
          }
        })
      }
    })
    const honesty = dataText(mount.tree, 'remote-transport-honesty')
    assert.equal(honesty, ENCRYPTED_COPY, `${selected} + tls=true 必须只显示加密说明`)
    assert.equal(honesty.includes(PLAINTEXT_COPY), false, `${selected} + tls=true 不得显示明文警告`)
  }
})

test('H2：tls=false / tls 缺省 + lan|ipv6 ⇒ 逐字明文警告（不放宽原句）', async () => {
  for (const tls of [false, undefined]) {
    for (const selected of ['lan', 'ipv6']) {
      const { mount } = await renderReal({
        routes: {
          pairingTransports: () => ({
            ok: true,
            data: { tls, selected, selectedHost: '192.168.1.6', overrideUnavailable: false, candidates, reasonLines }
          })
        }
      })
      const honesty = dataText(mount.tree, 'remote-transport-honesty')
      assert.equal(honesty, PLAINTEXT_COPY, `${selected} + tls=${String(tls)} 必须逐字显示原明文警告`)
      assert.equal(honesty.includes(ENCRYPTED_COPY), false, '未确认加密时不得显示加密说明')
    }
  }
})

test('H3：transports 尚未 resolve ⇒ fail-closed 明文警告，绝不提前显示加密说明', async () => {
  const { mount, calls } = await renderReal({
    routes: { pairingTransports: () => new Promise(() => {}) }
  })
  assert.ok(calls.some((c) => c.action === 'pairingTransports'), '仍须发出 transports 请求')
  const honesty = dataText(mount.tree, 'remote-transport-honesty')
  assert.equal(honesty, PLAINTEXT_COPY, 'transports 未落地前按二维码实际传输方式给明文警告')
  assert.equal(honesty.includes(ENCRYPTED_COPY), false, 'transports 未落地前绝不显示加密说明')
})

test('H4：轮换 → 停止 ⇒ 状态是「已停止接受连接」，不再被 rotated 文案遮住', async () => {
  const { mount } = await renderReal()
  await click(mount.tree, zh['lean.remote.generate'])
  assert.ok(dataText(mount.tree, 'remote-status').includes(zh['lean.remote.rotated']), '轮换后先出现 rotated 文案')
  await click(mount.tree, zh['lean.remote.stop'])
  const status = dataText(mount.tree, 'remote-status')
  assert.equal(status, zh['lean.remote.stopped'], 'running === false 必须先于 rotated 判定')
  assert.equal(status.includes(zh['lean.remote.rotated']), false, '停止后不得残留轮换文案')
})

test('H5：轮换 → 切换传输 ⇒ rotated 旗标清零，不再遮蔽真实状态', async () => {
  const { mount, calls } = await renderReal()
  await click(mount.tree, zh['lean.remote.generate'])
  assert.ok(dataText(mount.tree, 'remote-status').includes(zh['lean.remote.rotated']))
  const select = nodesOf(mount.tree).filter((n) => n.type === 'select')[0]
  select.props.onChange({ target: { value: 'lan' } })
  await settle()
  assert.ok(calls.some((c) => c.action === 'pairingTransports' && c.transport === 'lan'), '切换必须下传覆盖')
  const status = dataText(mount.tree, 'remote-status')
  assert.equal(status.includes(zh['lean.remote.rotated']), false, 'onChange 开始处必须 setRotated(false)')
  assert.equal(status, zh['lean.remote.announce.pending'], '真实状态必须重新浮现')
})

test('H6：轮换 → 停止 → 切换传输 ⇒ 已停止状态仍不被遮住', async () => {
  const { mount } = await renderReal()
  await click(mount.tree, zh['lean.remote.generate'])
  await click(mount.tree, zh['lean.remote.stop'])
  const select = nodesOf(mount.tree).filter((n) => n.type === 'select')[0]
  select.props.onChange({ target: { value: 'lan' } })
  await settle()
  const status = dataText(mount.tree, 'remote-status')
  assert.equal(status, zh['lean.remote.stopped'], '后续传输变化也不能掩盖停止状态')
  assert.equal(status.includes(zh['lean.remote.rotated']), false)
})

test('H7（决定已逆转）：停止态有「开始接受连接」且没有二维码/复制；运行中才显示停止', async () => {
  // 早先的「单向 kill switch」决定已被 mod-pairing-listener-truth 逆转：fresh install
  // enabled:false 且没有 start 控件时配对永远不可能工作。这里改成正向守卫。
  const stopped = await renderReal({
    routes: {
      remoteGetState: () => ({
        ok: true,
        data: { settings: { mode: 'lan' }, status: { running: false, probe: null }, modes: [] }
      })
    }
  })
  const remote = nodesOf(stopped.mount.tree).filter((n) => n.props && n.props.id === 'dots-remote')[0]
  const remoteNodes = []
  walk(remote.props.children, (n) => remoteNodes.push(n))
  const buttons = remoteNodes.filter((n) => n.type === 'button').map((n) => textOf(n.props.children))
  assert.deepEqual(buttons, [
    zh['lean.remote.generate'], zh['lean.remote.selfcheck'], zh['lean.remote.start']
  ], '停止态只有自检/生成 + 开始接受；没有二维码与复制入口')
  assert.equal(dataText(stopped.mount.tree, 'remote-running'), zh['lean.remote.stopped'])

  const running = await renderReal()
  const runningRemote = nodesOf(running.mount.tree).filter((n) => n.props && n.props.id === 'dots-remote')[0]
  const runningNodes = []
  walk(runningRemote.props.children, (n) => runningNodes.push(n))
  const runningButtons = runningNodes.filter((n) => n.type === 'button').map((n) => textOf(n.props.children))
  assert.ok(runningButtons.includes(zh['lean.remote.stop']), '运行中必须显示停止控件')
  assert.equal(runningButtons.includes(zh['lean.remote.start']), false)
  assert.equal(dataText(running.mount.tree, 'remote-running'), zh['lean.remote.started'])

  const src = readFileSync(path.join(pkgDir, 'src', 'client.js'), 'utf8')
  const lean = src.slice(src.indexOf('function LeanRemoteGroup('), src.indexOf('function DotsPanel('))
  assert.equal((lean.match(/rpcCall\('remoteStart'/g) || []).length, 1, '精简面板恰好一处 remoteStart')
})

test('H8：加密说明逐字存在于三处字典（zh.json / en.json / client 内置）', () => {
  const client = readFileSync(path.join(pkgDir, 'src', 'client.js'), 'utf8')
  assert.equal(client.includes(ENCRYPTED_COPY), true, 'client 内置 zh 缺少加密说明')
  assert.equal(client.includes(ENCRYPTED_COPY_EN), true, 'client 内置 en 缺少加密说明')
  assert.equal(zhSrc().includes(ENCRYPTED_COPY), true, 'zh.json 缺少加密说明')
  assert.equal(enSrc().includes(ENCRYPTED_COPY_EN), true, 'en.json 缺少 encrypted copy')
})

function zhSrc() { return readFileSync(path.join(pkgDir, 'locale', 'zh.json'), 'utf8') }
function enSrc() { return readFileSync(path.join(pkgDir, 'locale', 'en.json'), 'utf8') }
