/**
 * 远程访问 section 的渲染回归（桩渲染，React 语义与 client-render.test.mjs 一致）。
 *
 * 断言四件事：
 *   1. 全插件只注册**一个** section（id dots / order 70 / label DSH-dots），
 *      远程控制只是该单页里的折叠分组（内部 id dots-remote），locale 共用同一个 NS；
 *   2. `remote.*` 文案在 locale/zh.json 与 locale/en.json 都存在且两侧键集一致；
 *   3. 合并后的 shipped 远程组仍在同一页内可达（无端口 / 令牌输入、二维码只由 RPC 取得），
 *      且渲染结果里**不包含**任何 token 明文（含属性 / title / aria）。
 *   （旧 RemotePanel / remote.* 文案的渲染回归已随 mod-plugin-dormant-panel-removal 删除。）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgDir = path.resolve(here, '..')
const clientDist = path.join(pkgDir, 'dist', 'client.js')
const clientSrc = path.join(pkgDir, 'src', 'client.js')

const zh = JSON.parse(readFileSync(path.join(pkgDir, 'locale', 'zh.json'), 'utf8'))
const en = JSON.parse(readFileSync(path.join(pkgDir, 'locale', 'en.json'), 'utf8'))

/** 只出现在假 RemoteLink.url 里的 token（绝不该出现在渲染结果里）。 */
const TOKEN_PLAIN = 'rt_plain_0123456789abcdef'

const REMOTE_KEYS = [
  'remote.nav',
  'remote.title',
  'remote.subtitle',
  'remote.settings.title',
  'remote.enable',
  'remote.enable.hint',
  'remote.mode',
  'remote.mode.hint',
  'remote.port',
  'remote.port.hint',
  'remote.fields.lanAddress',
  'remote.fields.lanAddress.placeholder',
  'remote.fields.tailscaleHost',
  'remote.fields.tailscaleHost.placeholder',
  'remote.fields.cloudflareHost',
  'remote.fields.cloudflareHost.placeholder',
  'remote.fields.ipv6Address',
  'remote.fields.ipv6Address.placeholder',
  'remote.fields.manualUrl',
  'remote.fields.manualUrl.placeholder',
  // uu 与 manual 共用 manualUrl 槽位，但 方式专属 文案必须单独存在（client.js 先查这两个）
  'remote.fields.uu.manualUrl',
  'remote.fields.uu.manualUrl.placeholder',
  'remote.field.token',
  'remote.field.token.hint',
  'remote.token.saved',
  'remote.token.clear',
  'remote.token.cleared',
  'remote.availability.ready',
  'remote.unsupported',
  'remote.needsSetup',
  'remote.requires',
  'remote.steps',
  'remote.status.title',
  'remote.status.running',
  'remote.status.stopped',
  'remote.status.listen',
  'remote.status.bound',
  'remote.status.bound.hint',
  'remote.status.connections',
  'remote.status.rejected',
  'remote.status.token',
  'remote.status.token.none',
  'remote.status.startedAt',
  'remote.status.lastError',
  'remote.actions.title',
  'remote.actions.save',
  'remote.actions.start',
  'remote.actions.stop',
  'remote.actions.rotate',
  'remote.actions.rotate.confirm',
  'remote.actions.rotate.yes',
  'remote.actions.rotate.cancel',
  'remote.actions.probe',
  'remote.actions.showLink',
  'remote.actions.copy',
  'remote.busy.loading',
  'remote.busy.saving',
  'remote.busy.starting',
  'remote.busy.stopping',
  'remote.busy.rotating',
  'remote.busy.probing',
  'remote.busy.linking',
  'remote.probe.title',
  'remote.probe.ok',
  'remote.probe.warn',
  'remote.probe.fail',
  'remote.probe.unknown',
  'remote.probe.never',
  'remote.probe.at',
  'remote.qr.title',
  'remote.qr.hint',
  'remote.link.hint',
  'remote.notice.saved',
  'remote.notice.started',
  'remote.notice.stopped',
  'remote.notice.rotated',
  'remote.notice.probed',
]

/* -------------------------------------------------------------------------- */
/* React 语义桩（与 client-render.test.mjs 同款）                              */
/* -------------------------------------------------------------------------- */

function flatten(list, out) {
  for (const item of list) {
    if (Array.isArray(item)) flatten(item, out)
    else if (item === null || item === undefined || item === false || item === true) continue
    else out.push(item)
  }
  return out
}

function makeFakeReact() {
  const Fragment = Symbol('Fragment')
  return {
    Fragment,
    createElement(type, props, ...children) {
      const next = Object.assign({}, props)
      const kids = flatten(children, [])
      if (kids.length === 1) next.children = kids[0]
      else if (kids.length > 1) next.children = kids
      return { type, props: next }
    },
    useState(init) {
      return [typeof init === 'function' ? init() : init, function () {}]
    },
    useRef(value) {
      return { current: value }
    },
    useEffect() {},
    useMemo(fn) {
      return fn()
    },
    useCallback(fn) {
      return fn
    },
    Children: {
      toArray(value) {
        return flatten(Array.isArray(value) ? value : [value], [])
      }
    }
  }
}

/** r2：有状态 React 桩，供 merged-panel 测试走真实 RPC 链路（无 seedLink 种子）。 */
function makeStatefulReact() {
  const Fragment = Symbol('Fragment')
  const react = {
    Fragment,
    createElement(type, props, ...children) {
      const next = Object.assign({}, props)
      const kids = flatten(children, [])
      if (kids.length === 1) next.children = kids[0]
      else if (kids.length > 1) next.children = kids
      // 立即展开函数组件，让 hooks / useEffect 在 render() 内登记（真实 React 语义）。
      if (typeof type === 'function') return type(next)
      return { type, props: next }
    },
    useState(init) { return activeLeanMount.useState(init) },
    useRef(value) { return activeLeanMount.useRef(value) },
    useEffect(fn) { activeLeanMount.useEffect(fn) },
    useMemo(fn) { return fn() },
    useCallback(fn) { return fn },
    Children: { toArray(value) { return flatten(Array.isArray(value) ? value : [value], []) } }
  }
  return react
}

let activeLeanMount = null
function mountLean(Panel, props) {
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

let leanLoadedPromise = null
async function loadLeanPanel() {
  if (!leanLoadedPromise) {
    leanLoadedPromise = (async () => {
      let captured = null
      globalThis.window = { __ModuleLoader__: { load(cfg) { captured = cfg } } }
      await import(pathToFileURL(clientDist).href + '?lean-r2=' + Date.now())
      assert.ok(captured, 'client.js 必须调用 window.__ModuleLoader__.load')
      const mod = captured.factory((id) => {
        if (id === 'react') return makeStatefulReact()
        throw new Error(`unexpected require: ${id}`)
      })
      let Panel = null
      const ctx = {
        effect(fn) { const d = fn(); return typeof d === 'function' ? d : function () {} },
        locale: { register() { return function () {} }, bind() { return function (key) { return key } } },
        slots: {
          inject(name, cb) { assert.equal(name, 'settings.section'); cb(); return function () {} },
          register(options, component) { Panel = component; return function () {} }
        }
      }
      mod.apply(ctx)
      assert.ok(Panel, '必须注册 settings.section')
      return Panel
    })()
  }
  return leanLoadedPromise
}

let loadedPromise = null

async function loadClient() {
  if (loadedPromise) return loadedPromise
  loadedPromise = (async () => {
    let captured = null
    globalThis.window = {
      __ModuleLoader__: {
        load(cfg) {
          captured = cfg
        }
      }
    }
    await import(pathToFileURL(clientDist).href)
    assert.ok(captured, 'client.js 必须调用 window.__ModuleLoader__.load')
    const react = makeFakeReact()
    const mod = captured.factory((id) => {
      if (id === 'react') return react
      throw new Error(`unexpected require: ${id}`)
    })
    return { mod, react }
  })()
  return loadedPromise
}

/** 注册全部 settings.section，返回 [{options, component}]（不覆盖、不丢）。 */
function renderSections(mod) {
  const sections = []
  const ctx = {
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : function () {}
    },
    locale: {
      register() {
        return function () {}
      },
      bind() {
        return function (key) {
          return key
        }
      }
    },
    slots: {
      inject(name, cb) {
        assert.equal(name, 'settings.section')
        cb()
        return function () {}
      },
      register(options, component) {
        sections.push({ options, component })
        return function () {}
      }
    }
  }
  mod.apply(ctx)
  return sections
}

function walk(node, visit) {
  if (node === null || node === undefined || node === false || node === true) return
  if (Array.isArray(node)) {
    node.forEach((item) => walk(item, visit))
    return
  }
  if (typeof node !== 'object') return
  if (typeof node.type === 'function') {
    walk(node.type(node.props), visit)
    return
  }
  if (typeof node.type === 'symbol') {
    walk(node.props.children, visit)
    return
  }
  visit(node)
  walk(node.props.children, visit)
}

function collectText(node, out) {
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return
  }
  if (Array.isArray(node)) {
    node.forEach((item) => collectText(item, out))
    return
  }
  if (node === null || node === undefined || typeof node !== 'object') return
  if (typeof node.type === 'function') {
    collectText(node.type(node.props), out)
    return
  }
  if (typeof node.type === 'symbol') {
    collectText(node.props.children, out)
    return
  }
  collectText(node.props && node.props.children, out)
}

function textOf(tree) {
  const out = []
  collectText(tree, out)
  return out.join('\n')
}

function serialize(tree) {
  return JSON.stringify(tree, function (key, value) {
    if (typeof value === 'function') return '[fn]'
    return value
  })
}

function nodesOf(tree) {
  const nodes = []
  walk(tree, (node) => nodes.push(node))
  return nodes
}

/** 从合并后的单页里取出指定 id 的折叠分组（不绕过 merged panel 直接挂子面板）。 */
function groupOf(tree, id) {
  const group = nodesOf(tree).find((node) => node.type === 'details' && node.props.id === id)
  assert.ok(group, `单页里必须存在 id=${id} 的折叠分组`)
  return group
}

/* -------------------------------------------------------------------------- */
/* 假 RemoteStateData / RemoteLink                                             */
/* -------------------------------------------------------------------------- */

function fakeProbe() {
  return {
    mode: 'lan',
    level: 'warn',
    checks: [
      { id: 'bind', level: 'ok', message: '本机可以绑到 192.168.1.6', hint: '' },
      { id: 'firewall', level: 'warn', message: '防火墙可能拦截入站', hint: '在 Windows 防火墙放行该端口' },
      { id: 'tls', level: 'fail', message: '未启用 TLS', hint: '远程访问建议只用内网或隧道' },
      { id: 'peer', level: 'unknown', message: '平板是否同网段无法自证', hint: '' }
    ],
    verdict: '部分可用：本机能绑上，平板可达未证实',
    at: '2026-01-01T00:00:00.000Z'
  }
}

function fakeState(mode = 'lan', settingsOverrides = {}) {
  return {
    settings: Object.assign(
      {
        enabled: true,
        mode,
        port: 0,
        lanAddress: '192.168.1.6',
        tailscaleHost: '100.101.102.103',
        cloudflareHost: 'xxx.trycloudflare.com',
        ipv6Address: '2409:8a20:4cad:ba20::1',
        manualUrl: 'https://example.com/dsh',
        // 设置视图：只有 tokenSet/tokenMasked（契约里没有 token 明文）。
        tokenSet: false,
        tokenMasked: ''
      },
      settingsOverrides
    ),
    status: {
      running: true,
      listen: '192.168.1.6:3080',
      boundAddress: '192.168.1.6',
      port: 3080,
      startedAt: '2026-01-01T00:00:00.000Z',
      lastError: { code: 'E_ADDR_IN_USE', message: '上一次绑定失败：端口被占用' },
      connections: { active: 2, total: 9 },
      rejected: 3,
      token: { exists: true, masked: 'rt_••••••••', createdAt: '2026-01-01T00:00:00.000Z' },
      urls: [
        { mode: 'lan', url: 'http://192.168.1.6:3080/', label: '局域网', note: '需同一 WiFi', withToken: false }
      ],
      probe: fakeProbe()
    },
    modes: [
      {
        mode: 'lan',
        label: '局域网',
        description: '平板与本机连同一个 WiFi 时最省事。',
        availability: 'ready',
        unavailableReason: '',
        requires: [],
        fields: [
          { key: 'lanAddress', label: '局域网地址', placeholder: '192.168.1.6', hint: '留空自动挑选', required: false },
          { key: 'port', label: '端口', placeholder: '0', hint: '0 = 跟 DSH 同端口', required: true },
          {
            key: 'token',
            label: '访问令牌（可选）',
            placeholder: '粘贴电脑上 DSH 地址里的 token',
            hint: '留空则不带令牌；填了会在链接里追加 ?token=…',
            required: false
          }
        ],
        steps: ['保存设置', '点启动', '用平板扫码'],
        hostsListener: true
      },
      {
        mode: 'ipv6',
        label: '公网 IPv6',
        description: '平板用流量也能直连。',
        availability: 'needs-setup',
        unavailableReason: '',
        requires: ['家里宽带已开通公网 IPv6'],
        fields: [
          { key: 'ipv6Address', label: 'IPv6 地址', placeholder: '2409:8a20::1', hint: '不要带方括号', required: true },
          { key: 'port', label: '端口', placeholder: '0', hint: '0 = 跟 DSH 同端口', required: true },
          {
            key: 'token',
            label: '访问令牌（可选）',
            placeholder: '粘贴电脑上 DSH 地址里的 token',
            hint: '留空则不带令牌；填了会在链接里追加 ?token=…',
            required: false
          }
        ],
        steps: ['查到公网 IPv6', '填进来', '用流量试'],
        hostsListener: true
      },
      {
        mode: 'manual',
        label: '手动填地址',
        description: '你自己已有的可用地址。',
        availability: 'ready',
        unavailableReason: '',
        requires: [],
        // manual 的完整地址自带令牌 → 没有 token 字段。
        fields: [
          { key: 'manualUrl', label: '完整地址', placeholder: 'https://example.com/', hint: '必须带 http://', required: true }
        ],
        steps: ['填地址', '保存后测试'],
        hostsListener: false
      },
      {
        mode: 'tailscale',
        label: 'Tailscale',
        description: '跨网络访问，走 tailnet。',
        availability: 'needs-setup',
        unavailableReason: '',
        requires: ['安装 Tailscale 客户端', '登录同一 tailnet'],
        fields: [
          { key: 'tailscaleHost', label: 'Tailscale 主机', placeholder: 'pc-a.ts.net', hint: '', required: true },
          {
            key: 'token',
            label: '访问令牌（可选）',
            placeholder: '粘贴电脑上 DSH 地址里的 token',
            hint: '留空则不带令牌；填了会在链接里追加 ?token=…',
            required: false
          }
        ],
        steps: ['安装 Tailscale 客户端', '登录账号', '回到这里保存并自检'],
        hostsListener: true
      },
      {
        mode: 'uu',
        label: '网易 UU',
        description: '图形化端口映射，免费版包含。',
        availability: 'needs-setup',
        unavailableReason: '',
        requires: ['电脑装 UU 远程并登录（免费版含端口映射）', '在 UU 远程 →「图形化端口映射」里把内部端口设为 DSH 端口'],
        fields: [
          {
            key: 'manualUrl',
            label: '对外入口地址',
            placeholder: '从 UU 远程复制，如 abc.uuyc.com:12345 或 https://…',
            hint: 'UU远程 → 图形化端口映射 → 内部端口填 DSH 端口 → 复制生成的对外入口',
            required: true
          },
          {
            key: 'token',
            label: '访问令牌（可选）',
            placeholder: '粘贴电脑上 DSH 地址里的 token',
            hint: '留空则不带令牌；填了会追加 ?token=…',
            required: false
          }
        ],
        steps: ['电脑上启动 DSH', '打开 UU 远程 → 图形化端口映射', '复制生成的对外入口', '粘到「对外入口地址」'],
        hostsListener: false
      }
    ]
  }
}

function fakeLink() {
  const size = 5
  const modules = []
  for (let y = 0; y < size; y += 1) {
    const row = []
    for (let x = 0; x < size; x += 1) row.push((x * y) % 3 !== 0)
    modules.push(row)
  }
  return {
    url: `http://192.168.1.6:3080/?token=${TOKEN_PLAIN}`,
    qr: { size, modules },
    note: ''
  }
}

function renderRemote(component, extra) {
  return component(
    Object.assign(
      {
        t: (key) => (typeof zh[key] === 'string' ? zh[key] : key),
        close: function () {}
      },
      extra || {}
    )
  )
}

/* -------------------------------------------------------------------------- */
/* 1) 两个 section                                                             */
/* -------------------------------------------------------------------------- */

test('client.js 与 dist/client.js 必须保持同一份内容', () => {
  assert.equal(
    readFileSync(clientDist, 'utf8'),
    readFileSync(clientSrc, 'utf8'),
    '改了 src/client.js 必须同步 dist/client.js'
  )
})

test('只注册一个 section：id/order/locale/label 正确', async () => {
  const { mod } = await loadClient()
  const sections = renderSections(mod)
  assert.equal(sections.length, 1, '只允许一个 settings.section')
  const section = sections[0]
  assert.equal(section.options.id, 'dots', '唯一 section 的 id 必须仍是 dots')
  assert.equal(section.options.name, 'settings.section')
  assert.equal(section.options.order, 70)
  assert.equal(section.options.locale, 'dots')
  assert.equal(typeof section.options.label, 'function')
  assert.equal(section.options.label(), 'DSH-dots', '单一条目的名称必须是 DSH-dots')
  assert.equal(section.component.RemotePanel, undefined, 'dormant RemotePanel 接缝必须已删除')
  assert.equal(section.component.SettingsPanel, undefined, 'dormant SettingsPanel 接缝必须已删除')
  assert.equal(typeof section.component.LeanSyncGroup, 'function', 'shipped 同步组接缝仍在')
  assert.equal(typeof section.component.LeanRemoteGroup, 'function', 'shipped 远程组接缝仍在')
})


/* -------------------------------------------------------------------------- */
/* 5) 通过合并后的单页（不是第二个 section）证明远程控件仍在                     */
/* -------------------------------------------------------------------------- */

test('merged panel：pairing-client 接线后远程组仍在同一页内可达（retarget：无端口 / 令牌输入）', async () => {
  const Panel = await loadLeanPanel()
  const calls = []
  // 真实宿主只传 { t, close }；二维码 / 自检结果必须靠 RPC 自己拿。
  globalThis.fetch = async function (url, options) {
    const body = JSON.parse(options.body)
    calls.push(body.action)
    const data = body.action === 'remoteShowLink'
      ? fakeLink()
      : body.action === 'remoteProbe'
        ? fakeProbe()
        : body.action === 'pairingProvision'
          ? {
              view: { v: 1, instanceId: 'gwl-pc', transport: 'lan', host: '192.168.1.6', port: 44996, tlsFingerprint: 'AA:BB', announceRef: '', token: 'present' },
              changed: { port: false, token: false, cert: false }, republish: null
            }
          : body.action === 'pairingTransports'
            ? {
                selected: 'lan', selectedHost: '192.168.1.6', overrideUnavailable: false,
                candidates: {
                  tailscale: { kind: 'tailscale', available: false, reason: 'Tailscale：平板需加入同一 tailnet', host: '' },
                  lan: { kind: 'lan', available: true, reason: '局域网：同一 Wi-Fi', host: '192.168.1.6' },
                  ipv6: { kind: 'ipv6', available: false, reason: 'IPv6：本机需有 IPv6，部分运营商屏蔽入站', host: '' }
                },
                reasonLines: [
                  'Tailscale：平板需加入同一 tailnet', '局域网：同一 Wi-Fi',
                  'IPv6：本机需有 IPv6，部分运营商屏蔽入站',
                  '局域网也需要端口和令牌：二维码里已经带好，不用手输；令牌阻止同一网络里的其他人控制这台 DSH。'
                ]
              }
            : body.action === 'pairingConnections'
              ? []
              : body.action === 'pairingShow'
                ? { payload: '{}', text: 'DSHDOTS1|...', qr: fakeLink().qr }
                : body.action === 'remoteGetState'
                  ? fakeState()
                  : fakeState()
    return { status: 200, async text() { return JSON.stringify({ ok: true, data }) } }
  }
  activeLeanMount = mountLean(Panel, {
    t: (key) => (typeof zh[key] === 'string' ? zh[key] : key),
    close() {}
  })
  activeLeanMount.render()
  for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setTimeout(resolve, 5))
  const tree = activeLeanMount.tree
  assert.ok(calls.includes('pairingProvision'), '真实面板必须自己调用 pairingProvision')
  assert.ok(calls.includes('pairingTransports'), '真实面板必须自己调用 pairingTransports')
  assert.equal(calls.includes('pairingShow'), false, '挂载不得触碰 pairingShow')
  const group = groupOf(tree, 'dots-remote')
  const groupNodes = []
  walk(group.props.children, (node) => groupNodes.push(node))

  assert.equal(group.props.open, true, '远程组默认展开，控件首屏可达')
  assert.equal(groupNodes.filter((node) => node.type === 'svg').length, 0, '未显式显示前没有二维码')
  assert.equal(groupNodes.filter((node) => node.type === 'select').length, 1, '方式下拉仍在')
  assert.deepEqual(
    groupNodes.filter((node) => node.type === 'select')[0].props.children.map((o) => o.props.value),
    ['auto', 'tailscale', 'lan', 'ipv6'],
    '自动 + 三项传输，不可选项灰掉'
  )
  assert.deepEqual(
    groupNodes.filter((node) => node.type === 'button').map((node) => textOf(node.props.children)),
    ['显示二维码', '复制配对串', '重新生成', '自检', '停止接受连接'],
    '远程组只有 二维码 / 复制 / 重新生成 / 自检 / 停止接受'
  )
  const inputs = groupNodes.filter((node) => node.type === 'input')
  assert.deepEqual(
    {
      text: inputs.filter((node) => node.props.type === 'text').length,
      number: inputs.filter((node) => node.props.type === 'number').length,
      password: inputs.filter((node) => node.props.type === 'password').length,
      checkbox: inputs.filter((node) => node.props.type === 'checkbox').length
    },
    { text: 0, number: 0, password: 0, checkbox: 0 },
    '端口 / 令牌输入全部移除，没有新建任何输入'
  )

  const text = textOf(group)
  for (const expected of [
    '远程控制', // 页内分组标题
    zh['lean.remote.mode.hint'], '自动选中：lan', // 方式 + 自动选中原因
    'Tailscale：平板需加入同一 tailnet', '局域网：同一 Wi-Fi',
    '局域网也需要端口和令牌：二维码里已经带好，不用手输；令牌阻止同一网络里的其他人控制这台 DSH。',
    '显示二维码', '复制配对串', '重新生成', '自检', '停止接受连接',
    '谁连进来过' // 脱敏审计
  ]) {
    assert.ok(text.includes(expected), `合并后远程组缺少「${expected}」`)
  }
  for (const dead of ['运行中', '绑定地址', '被拒次数', '最近错误', '需先准备', '图形化端口映射', '怎么做', '用平板扫这个码']) {
    assert.equal(text.includes(dead), false, `已删入口「${dead}」不得在精简远程组复现`)
  }
  assert.equal(groupNodes.filter((node) => node.type === 'p').length, 0, '不得有步骤说明段落')
  assert.equal(text.includes(TOKEN_PLAIN), false, '合并后仍不得出现令牌明文')
})
