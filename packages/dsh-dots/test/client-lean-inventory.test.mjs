/**
 * mod-plugin-lean-panel r2 — 精简面板的**精确清单守卫** + 真实链路回归。
 *
 * 钉住用户定版：一页 = 2 个折叠组；控件恰好 4 个 input + 1 个 select = 5 个
 * （规范里「五个控件 / 6 inputs/selects」的自相矛盾按实现实数 5 收敛，逐项列名）；
 * 按钮恰好 6 个（2 个动作 保存 / 自检 + 远程令牌上的 4 个按钮式
 * affordance 显示二维码 / 复制 / 重新生成 / 停止接受连接，明确计入）；「测试连接」已按 Lead 决定删除；
 * 二维码恰好 1 个。
 *
 * review M1 修正：**本文件不再注入 seedLink**。二维码 / 复制 / 令牌只能由真实 RPC
 * (`remoteShowLink` / `remoteSaveSettings` / `remoteRotateToken`) 产生；这里用有状态的
 * React 桩 + fetch 桩，按宿主的真实 props（`{ t, close }`）挂载唯一 section，等副作用
 * 跑完再断言。若二维码只靠测试种子喂进来，本文件立刻失败。
 *
 * review M2 修正：保存后的状态行按 host 权威返回体归一——令牌存在性取 `hasToken`
 * 的真实位置（getState 在 settings 上、saveSettings 在顶层），blocked / lastSyncAt
 * 原样保留；这里逐项钉住「保存后不得假报缺令牌 / 不得丢阻断」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const clientDist = path.join(pkgDir, 'dist', 'client.js')
const zh = JSON.parse(readFileSync(path.join(pkgDir, 'locale', 'zh.json'), 'utf8'))

// mod-plugin-remote-hints-mode-keyed：none 只给唯一推荐动作；旧并列文案作为反例钉死。
const NONE_HINT_ZH = '未检测到可用网络：推荐先登录 Tailscale，让平板加入同一 tailnet。'
const OLD_NONE_HINT_ZH = '请先连同一 Wi-Fi，或登录 Tailscale 让平板加入同一 tailnet'

function flatten(list, out) {
  for (const item of list) {
    if (Array.isArray(item)) flatten(item, out)
    else if (item !== null && item !== undefined && item !== false && item !== true) out.push(item)
  }
  return out
}

/* 有状态 React 桩：useState 真的重渲染，useEffect 在每次渲染后只跑一次。 */
let activeMount = null
const reactStub = {
  Fragment: Symbol('Fragment'),
  createElement(type, props, ...children) {
    const next = Object.assign({}, props || {})
    const kids = flatten(children, [])
    if (kids.length === 1) next.children = kids[0]
    else if (kids.length > 1) next.children = kids
    // 真实 React 会在渲染时调用函数组件；这里必须同样立即展开，否则含 hooks 的
    // Lean*Group 直到 walk 才被执行，useEffect 永远进不了本帧的 effect 队列。
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
      if (hooks[index] === undefined) {
        hooks[index] = { ran: true }
        pendingEffects.push(fn)
      }
    },
    render,
    get tree() { return tree }
  }
  return mount
}

let loadedPromise = null
async function loadMergedPanel() {
  if (!loadedPromise) {
    loadedPromise = (async () => {
      let captured = null
      globalThis.window = { __ModuleLoader__: { load(cfg) { captured = cfg } } }
      await import(pathToFileURL(clientDist).href + '?lean-inventory-r2=' + Date.now())
      assert.ok(captured, 'client.js 必须调用 window.__ModuleLoader__.load')
      const mod = captured.factory((id) => {
        if (id === 'react') return reactStub
        throw new Error(`unexpected require: ${id}`)
      })
      let Panel = null
      const ctx = {
        effect(fn) { const d = fn(); return typeof d === 'function' ? d : function () {} },
        locale: {
          register() { return function () {} },
          bind() { return function (key) { return key } }
        },
        slots: {
          inject(name, cb) {
            assert.equal(name, 'settings.section')
            cb()
            return function () {}
          },
          register(options, component) { Panel = component; return function () {} }
        }
      }
      mod.apply(ctx)
      assert.ok(Panel, '必须注册 settings.section 组件')
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

function nodesOf(tree) {
  const nodes = []
  walk(tree, (node) => nodes.push(node))
  return nodes
}

const REMOTE_TOKEN = 'rt_real_0123456789abcdef'
const REMOTE_LINK = {
  url: 'http://192.168.1.6:3080/?token=' + REMOTE_TOKEN,
  qr: {
    size: 5,
    modules: [
      [true, false, true, false, true],
      [false, true, false, true, false],
      [true, false, true, false, true],
      [false, true, false, true, false],
      [true, false, true, false, true]
    ]
  },
  note: ''
}

/** pairing-client：qr / 复制串只由显式 pairingShow 给出；token 明文不进 DOM。 */
const PAIR_VIEW = {
  v: 1, instanceId: 'gwl-pc', transport: 'lan', host: '192.168.1.6', port: 44996,
  tlsFingerprint: 'AA:BB', announceRef: '', token: 'present'
}
const PAIR_TEXT = 'DSHDOTS1|1|gwl-pc|lan|192.168.1.6|44996|' + REMOTE_TOKEN + '|AA:BB||00000000'
const PAIR_REASONS = [
  'Tailscale：平板需加入同一 tailnet', '局域网：同一 Wi-Fi',
  'IPv6：本机需有 IPv6，部分运营商屏蔽入站',
  '局域网也需要端口和令牌：二维码里已经带好，不用手输；令牌阻止同一网络里的其他人控制这台 DSH。'
]
function pairCandidates(overrides = {}) {
  return Object.assign({
    tailscale: { kind: 'tailscale', available: false, reason: PAIR_REASONS[0], host: '' },
    lan: { kind: 'lan', available: true, reason: PAIR_REASONS[1], host: '192.168.1.6' },
    ipv6: { kind: 'ipv6', available: false, reason: PAIR_REASONS[2], host: '' }
  }, overrides)
}

/** 权威 getState 视图：hasToken 挂在 settings 上；status 带 blocked / lastSyncAt。 */
function stateData(overrides = {}) {
  return {
    settings: Object.assign(
      { repoUrl: 'https://github.com/u/r.git', hasToken: true, mode: 'lan', port: 0 },
      overrides.settings || {}
    ),
    status: Object.assign(
      {
        lastSyncAt: '2026-01-01T08:30:00+08:00',
        probe: { level: 'ok', verdict: '连通性自检通过', checks: [] },
        visibilityBlocked: false,
        running: true
      },
      overrides.status || {}
    ),
    modes: []
  }
}

/** saveSettings 的真实返回体：**settings 里没有 hasToken**，hasToken 在顶层。 */
function savedData(tokenPresent) {
  return {
    settings: { repoUrl: 'https://github.com/u/r.git', branch: 'main', platform: 'github' },
    hasToken: tokenPresent
  }
}

function makeFetch(overrides = {}) {
  const calls = []
  const routes = Object.assign({
    getState: () => ({ ok: true, data: stateData(overrides.state || {}) }),
    saveSettings: () => ({ ok: true, data: savedData(true) }),
    remoteGetState: () => ({ ok: true, data: stateData(overrides.state || {}) }),
    remoteShowLink: () => ({ ok: true, data: REMOTE_LINK }),
    remoteSaveSettings: (body) => ({ ok: true, data: stateData(overrides.state || { body }) }),
    remoteRotateToken: (body) => ({ ok: true, data: ({ mode: 'lan', probe: null, body }) }),
    remoteProbe: () => ({ ok: true, data: { level: 'ok', verdict: '自检通过', checks: [] } }),
    pairingProvision: () => ({
      ok: true,
      data: { view: PAIR_VIEW, changed: { port: false, token: false, cert: false }, republish: null }
    }),
    pairingTransports: (body) => ({
      ok: true,
      data: {
        selected: 'lan', selectedHost: '192.168.1.6',
        overrideUnavailable: body.transport === 'ipv6',
        candidates: pairCandidates(), reasonLines: PAIR_REASONS
      }
    }),
    pairingConnections: () => ({ ok: true, data: [] }),
    pairingShow: () => ({ ok: true, data: { payload: '{}', text: PAIR_TEXT, qr: REMOTE_LINK.qr } }),
    pairingRotateToken: () => ({
      ok: true,
      data: { view: PAIR_VIEW, changed: { port: false, token: true, cert: false }, republish: { key: 'pairing:gwl-pc', reason: 'token-rotated', previousPort: 44996, port: 44996 } }
    }),
    remoteStop: () => ({ ok: true, data: { running: false } }),
    testConnection: () => ({ ok: true, data: { reachable: true } })
  }, overrides.routes || {})
  globalThis.fetch = async function (url, options) {
    const body = JSON.parse(options.body)
    calls.push(body)
    const handler = routes[body.action]
    const payload = typeof handler === 'function' ? await handler(body) : handler
    return {
      status: 200,
      async text() {
        return JSON.stringify(payload === undefined ? { ok: false, error: { code: 'E_UNKNOWN', message: 'no stub' } } : payload)
      }
    }
  }
  return calls
}

const copied = []
// Node 的 navigator 是只读 getter，用 defineProperty 覆盖（configurable: true）。
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { clipboard: { writeText: async (value) => { copied.push(value) } } }
})

const settle = async () => {
  for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setTimeout(resolve, 5))
}

/** 真实宿主 props，没有任何 seedLink / seedState。 */
async function renderReal(overrides = {}) {
  const Panel = await loadMergedPanel()
  const calls = makeFetch(overrides)
  activeMount = mountPanel(Panel, {
    t: (key) => zh[key] || key,
    close() {}
  })
  const mount = activeMount
  mount.render()
  await settle()
  return { mount, calls, nodes: nodesOf(mount.tree), text: textOf(mount.tree) }
}

const statusLine = (nodes, key) => {
  const found = nodes.filter((node) => node.props && node.props['data-lean'] === key)
  assert.equal(found.length, 1, `${key} 必须恰好一条`)
  return textOf(found[0])
}

const button = (nodes, label) => {
  const found = nodes.filter((node) => node.type === 'button' && textOf(node.props.children) === label)
  assert.equal(found.length, 1, `按钮「${label}」必须恰好一个`)
  return found[0]
}

const DELETED_LABELS = [
  '同步范围', '分支', '设备标识', '平台', '认证方式',
  '预览', '应用', '回滚', '快照', 'MERGE'
]

test('清单：恰好 2 个组（dots / dots-remote），默认展开，无第三个 details', async () => {
  const { nodes } = await renderReal()
  const groups = nodes.filter((node) => node.type === 'details')
  assert.deepEqual(groups.map((g) => g.props.id), ['dots', 'dots-remote'])
  assert.ok(groups.every((g) => g.props.open === true), '两组必须默认展开')
  assert.equal(nodes.filter((node) => node.type === 'summary').length, 2, '只有两个组标题')
})

test('清单：pairing-client 后恰好 2 input + 1 select（远程组没有端口 / 令牌输入）', async () => {
  const { nodes } = await renderReal()
  const inputs = nodes.filter((node) => node.type === 'input')
  const selects = nodes.filter((node) => node.type === 'select')

  assert.deepEqual(
    inputs.map((node) => node.props.type),
    ['text', 'password'],
    '只剩同步组的仓库地址(text) / 同步令牌(password)；远程组的端口 / 令牌输入已删'
  )
  assert.equal(selects.length, 1, '唯一 select 是「方式（自动选中，可覆盖）」')
  assert.deepEqual(
    selects[0].props.children.map((option) => option.props.value),
    ['auto', 'tailscale', 'lan', 'ipv6'],
    '自动 + 三项传输；不可选项灰掉而不是消失'
  )
  assert.equal(inputs.filter((node) => node.props.type === 'number').length, 0, '端口输入不得复活')
  assert.equal(inputs.filter((node) => node.props.type === 'checkbox').length, 0, '同步范围复选框不得复活')
})

test('清单：按钮恰好 6 个 = 同步 1 + 远程 5（显示二维码 / 复制 / 重新生成 / 自检 / 停止接受）', async () => {
  const { nodes } = await renderReal()
  const labels = nodes.filter((node) => node.type === 'button').map((node) => textOf(node.props.children))
  assert.deepEqual(
    labels,
    ['保存', '显示二维码', '复制配对串', '重新生成', '自检', '停止接受连接'],
    '同步组只剩 保存；远程组二维码 / 复制 / 重新生成 / 自检 / 停止接受仍在，没有端口 / 令牌输入'
  )
  assert.equal(labels.length, 6)
  assert.equal(labels.includes('测试连接'), false, 'DARK：shipped 面板不得有测试连接按钮')
})

test('M1：真实 props（无 seedLink）下二维码由显式 pairingShow 产生，恰好 1 个', async () => {
  const { mount, calls } = await renderReal()
  assert.equal(calls.some((c) => c.action === 'pairingShow'), false, '挂载不得触碰 pairingShow')
  assert.equal(nodesOf(mount.tree).filter((node) => node.type === 'svg').length, 0, '未点显示前无二维码')
  await button(nodesOf(mount.tree), '显示二维码').props.onClick()
  await settle()
  assert.ok(calls.some((c) => c.action === 'pairingShow'), '显示二维码必须调用 pairingShow')
  const svgs = nodesOf(mount.tree).filter((node) => node.type === 'svg')
  assert.equal(svgs.length, 1, '恰好一张二维码（不接受测试种子）')
  assert.equal(svgs[0].props.role, 'img')
  assert.equal(svgs[0].props['aria-label'], zh['lean.remote.qr'])
  assert.equal(JSON.stringify(svgs).includes(REMOTE_TOKEN), false, '二维码树里不得含令牌明文')
})

test('M1：复制按钮只写 pairingShow 的紧凑配对串（不是空操作、不是 URL）', async () => {
  const { mount, calls } = await renderReal()
  const before = copied.length
  const copy = button(nodesOf(mount.tree), '复制配对串')
  await copy.props.onClick()
  await settle()
  assert.equal(copied.length, before + 1, '点「复制配对串」必须写一次剪贴板')
  assert.equal(copied[copied.length - 1], PAIR_TEXT, '复制的必须是引擎的 DSHDOTS1|… 串')
  assert.ok(calls.some((c) => c.action === 'pairingShow'))
})

test('M1：重新生成走 pairingRotateToken，轮换后重新取二维码并提示重新配对', async () => {
  const { mount, calls } = await renderReal()
  await button(nodesOf(mount.tree), '重新生成').props.onClick()
  await settle()
  assert.ok(calls.some((c) => c.action === 'pairingRotateToken'), '「重新生成」必须调用轮换 RPC')
  assert.ok(calls.filter((c) => c.action === 'pairingShow').length >= 1, '轮换后必须重新取二维码')
  assert.ok(textOf(mount.tree).includes('旧二维码与旧令牌立即失效'), '必须显示重新配对后果')
})

test('d1：挂载走 automatic 选路（transport=auto），下拉显示引擎选中的 tailscale', async () => {
  const { calls, nodes } = await renderReal({
    routes: {
      pairingTransports: () => ({
        ok: true,
        data: {
          selected: 'tailscale', selectedHost: '100.64.0.2', overrideUnavailable: false,
          candidates: pairCandidates(), reasonLines: PAIR_REASONS
        }
      })
    }
  })
  assert.deepEqual(
    calls.filter((c) => c.action === 'pairingTransports').map((c) => c.transport),
    ['auto'],
    '挂载必须走自动选路，不得硬编码 lan'
  )
  assert.equal(calls.some((c) => c.action === 'pairingShow'), false, '挂载不得取二维码')
  const select = nodes.filter((node) => node.type === 'select')[0]
  assert.equal(select.props.value, 'tailscale', '下拉初值就是引擎自动选中的方式')
})

test('d1：没有任何可用方式 → 明确显示未检测到网络，不画误导性二维码', async () => {
  const { calls, nodes } = await renderReal({
    routes: {
      pairingTransports: () => ({
        ok: true,
        data: {
          selected: null, selectedHost: '', overrideUnavailable: false,
          candidates: pairCandidates({
            tailscale: { kind: 'tailscale', available: false, reason: PAIR_REASONS[0], host: '' },
            lan: { kind: 'lan', available: false, reason: PAIR_REASONS[1], host: '' },
            ipv6: { kind: 'ipv6', available: false, reason: PAIR_REASONS[2], host: '' }
          }),
          reasonLines: PAIR_REASONS
        }
      })
    }
  })
  assert.equal(calls.some((c) => c.action === 'pairingShow'), false)
  // retarget（mod-plugin-remote-hints-mode-keyed）：旧「同一 Wi-Fi 或 Tailscale」并列句 → 单一推荐动作句。
  assert.ok(textOf(nodes).includes(NONE_HINT_ZH), '必须显示新的单一推荐动作句')
  assert.equal(textOf(nodes).includes(OLD_NONE_HINT_ZH), false, '不得再并列多种方式的前提')
  assert.equal(nodes.filter((node) => node.type === 'svg').length, 0)
})

test('d2：手动覆盖不可用 → 回落自动并明说；下拉回到真实选中方式', async () => {
  const { mount, calls } = await renderReal()
  const callStart = calls.length
  const select = nodesOf(mount.tree).filter((node) => node.type === 'select')[0]
  select.props.onChange({ target: { value: 'ipv6' } })
  await settle()
  const after = calls.slice(callStart)
  const transportCalls = after.filter((c) => c.action === 'pairingTransports')
  assert.ok(transportCalls.some((c) => c.transport === 'ipv6'), '覆盖值必须下传引擎')
  assert.ok(statusLine(nodesOf(mount.tree), 'remote-status').includes(zh['lean.remote.transport.fallback']))
  assert.equal(nodesOf(mount.tree).filter((node) => node.type === 'select')[0].props.value, 'lan')
  assert.equal(after.some((c) => c.action === 'remoteSaveSettings'), false, '精简面板不再写端口 / 令牌设置')
})

test('清单：状态行是唯一状态面，用 App 语义（已同步 · HH:MM）', async () => {
  const { nodes } = await renderReal()
  assert.equal(statusLine(nodes, 'sync-status'), '已同步 · 08:30', '复用 App 的「已同步 · HH:MM」')
})

test('反向守卫：任何高级控件复现即失败（禁词 + 结构）', async () => {
  const { nodes, text } = await renderReal()
  for (const label of DELETED_LABELS) {
    assert.equal(text.includes(label), false, `已删除的高级控件文案「${label}」不得出现在面板里`)
  }
  assert.equal(nodes.filter((node) => node.type === 'p').length, 0, '不得渲染任何步骤说明 / 提示段落')
  assert.equal(nodes.filter((node) => node.type === 'input' && node.props.type === 'checkbox').length, 0)
  assert.equal(text.includes('插件清单（MERGE-only）'), false)
  assert.equal(text.includes('重新自检'), false, '精简面板只有「自检」，不得残留旧按钮文案')
})

test('M2：保存成功（saveSettings 的 settings 无 hasToken）不得假报「缺少访问令牌」', async () => {
  const { mount } = await renderReal({ routes: { saveSettings: () => ({ ok: true, data: savedData(true) }) } })
  await button(nodesOf(mount.tree), '保存').props.onClick()
  await settle()
  assert.equal(
    statusLine(nodesOf(mount.tree), 'sync-status').includes('未配置：缺少访问令牌'),
    false,
    'saveSettings 顶层 hasToken=true 是权威事实，不得因 settings 上没有该字段而误报缺令牌'
  )
})

test('M2：保存后阻断态不丢——仍是「已配置（可见性阻断，禁止推送）」', async () => {
  const { mount } = await renderReal({ state: { status: { visibilityBlocked: true, lastSyncAt: null, probe: null } } })
  assert.equal(statusLine(nodesOf(mount.tree), 'sync-status'), zh['lean.status.blocked'])
  await button(nodesOf(mount.tree), '保存').props.onClick()
  await settle()
  assert.equal(
    statusLine(nodesOf(mount.tree), 'sync-status'),
    zh['lean.status.blocked'],
    '保存动作无权清空 status 里的隐私闸标记'
  )
})

test('M2：保存后没有真实同步时刻也不得伪造「已同步」，只能「尚未同步」', async () => {
  const { mount } = await renderReal({ state: { status: { visibilityBlocked: false, lastSyncAt: null, probe: null } } })
  await button(nodesOf(mount.tree), '保存').props.onClick()
  await settle()
  assert.equal(statusLine(nodesOf(mount.tree), 'sync-status'), zh['lean.status.never'])
})

test('M2：确实没令牌时必须点名「访问令牌」', async () => {
  const { mount } = await renderReal({
    state: { settings: { hasToken: false } },
    routes: { saveSettings: () => ({ ok: true, data: savedData(false) }) }
  })
  assert.equal(statusLine(nodesOf(mount.tree), 'sync-status'), '未配置：缺少访问令牌')
  await button(nodesOf(mount.tree), '保存').props.onClick()
  await settle()
  assert.equal(statusLine(nodesOf(mount.tree), 'sync-status'), '未配置：缺少访问令牌', '无令牌是真实缺失，必须点名')
})

test('M2：令牌判据不读不存在的持久化字段（源码守卫 + 运行时归一）', () => {
  const settingsSrc = readFileSync(path.join(pkgDir, 'src', 'engine', 'settings.ts'), 'utf8')
  const iface = settingsSrc.slice(settingsSrc.indexOf('export interface SyncSettings'), settingsSrc.indexOf('export function defaultDeviceId'))
  assert.equal(iface.includes('hasToken'), false, 'SyncSettings 持久化形状没有 hasToken，状态行不得依赖它')
  const client = readFileSync(path.join(pkgDir, 'src', 'client.js'), 'utf8')
  assert.match(client, /function leanStateView\(/, '必须存在权威归一函数')
  assert.equal(/function leanStatusText[\s\S]{0,900}\bcfg\.hasToken\b/.test(client), false,
    'leanStatusText 不得直接读 settings.hasToken；只能读归一后的 tokenPresent')
})
