/**
 * 远程访问 section 的渲染回归（桩渲染，React 语义与 client-render.test.mjs 一致）。
 *
 * 断言四件事：
 *   1. 注册了**两个独立** section：配置同步（id git-config-sync / order 70）与
 *      远程访问（id git-config-sync-remote / order 71），locale 都复用同一个 NS；
 *   2. `remote.*` 文案在 locale/zh.json 与 locale/en.json 都存在且两侧键集一致；
 *   3. 用「含 uu（unsupported）+ 四种 level 的 checks + qr 矩阵」的假 state 渲染
 *      RemotePanel 不抛异常，且 DOM 里出现「远程访问」「不可用」等文案；
 *   4. 渲染结果里**不包含**任何 token 明文（含属性 / title / aria）。
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

function fakeState() {
  return {
    settings: {
      enabled: true,
      mode: 'lan',
      port: 0,
      lanAddress: '192.168.1.6',
      tailscaleHost: '',
      cloudflareHost: '',
      ipv6Address: '',
      manualUrl: ''
    },
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
          { key: 'lanAddress', label: '局域网地址', placeholder: '192.168.1.6', hint: '留空自动挑选', required: false }
        ],
        steps: ['保存设置', '点启动', '用平板扫码'],
        hostsListener: true
      },
      {
        mode: 'tailscale',
        label: 'Tailscale',
        description: '跨网络访问，走 tailnet。',
        availability: 'needs-setup',
        unavailableReason: '',
        requires: ['安装 Tailscale 客户端', '登录同一 tailnet'],
        fields: [
          { key: 'tailscaleHost', label: 'Tailscale 主机', placeholder: 'pc-a.ts.net', hint: '', required: true }
        ],
        steps: ['安装 Tailscale 客户端', '登录账号', '回到这里保存并自检'],
        hostsListener: true
      },
      {
        mode: 'uu',
        label: '网易 UU',
        description: '游戏加速器的远程能力。',
        availability: 'unsupported',
        unavailableReason: 'UU 的远程端口不对第三方开放，本插件无法接入',
        requires: [],
        fields: [],
        steps: [],
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

test('注册了两个独立 section：id/order/locale/label 正确', async () => {
  const { mod } = await loadClient()
  const sections = renderSections(mod)
  assert.equal(sections.length, 2, '必须注册两个 settings.section')

  const byId = new Map(sections.map((s) => [s.options.id, s]))
  const sync = byId.get('git-config-sync')
  const remote = byId.get('git-config-sync-remote')
  assert.ok(sync, '配置同步 section 必须仍在')
  assert.ok(remote, '远程访问 section 必须注册')
  assert.equal(sync.options.name, 'settings.section')
  assert.equal(remote.options.name, 'settings.section')
  assert.equal(sync.options.order, 70)
  assert.equal(remote.options.order, 71)
  assert.equal(sync.options.locale, 'git-config-sync')
  assert.equal(remote.options.locale, 'git-config-sync', '两个 section 复用同一个 locale NS')
  assert.equal(typeof remote.options.label, 'function')
  assert.equal(remote.options.label(), '远程访问')
  assert.notEqual(remote.component, sync.component, '两个 section 必须是不同组件（状态互不影响）')
})

/* -------------------------------------------------------------------------- */
/* 2) remote.* 文案                                                            */
/* -------------------------------------------------------------------------- */

test('remote.* 键在 zh/en 都存在且两侧键集一致', () => {
  const zhRemote = Object.keys(zh).filter((key) => key.startsWith('remote.')).sort()
  const enRemote = Object.keys(en).filter((key) => key.startsWith('remote.')).sort()
  assert.ok(zhRemote.length >= REMOTE_KEYS.length, `remote.* 至少 ${REMOTE_KEYS.length} 个键，实际 ${zhRemote.length}`)
  assert.deepEqual(zhRemote, enRemote, 'zh/en 的 remote.* 键集必须完全一致')
  for (const key of REMOTE_KEYS) {
    assert.equal(typeof zh[key], 'string', `zh 缺少 ${key}`)
    assert.equal(typeof en[key], 'string', `en 缺少 ${key}`)
    assert.ok(zh[key].trim().length > 0, `zh.${key} 不能为空`)
    assert.ok(en[key].trim().length > 0, `en.${key} 不能为空`)
  }
  assert.match(zh['remote.nav'], /远程访问/)
  assert.match(zh['remote.unsupported'], /不可用/)
  assert.match(zh['remote.needsSetup'], /需先准备/)
  assert.match(zh['remote.qr.hint'], /扫这个码/)
  assert.match(zh['remote.link.hint'], /手动输入下面的地址/)
  assert.match(zh['remote.port.hint'], /同端口/)
})

/* -------------------------------------------------------------------------- */
/* 3) 渲染                                                                     */
/* -------------------------------------------------------------------------- */

test('RemotePanel：假 state 渲染不抛异常，且出现「远程访问」「不可用」等文案', async () => {
  const { mod } = await loadClient()
  const sections = renderSections(mod)
  const remote = sections.find((s) => s.options.id === 'git-config-sync-remote')

  let tree = null
  assert.doesNotThrow(() => {
    tree = renderRemote(remote.component, { seedState: fakeState(), seedLink: fakeLink() })
  }, 'RemotePanel 渲染不得抛异常')

  const text = textOf(tree)
  for (const expected of [
    '远程访问', // remote.title / nav
    '不可用', // uu 的 availability 徽章
    '需先准备', // tailscale 的 availability 徽章
    '网易 UU', // 方式名
    'UU 的远程端口不对第三方开放', // unavailableReason（中性色文案）
    '安装 Tailscale 客户端', // requires 列表
    '怎么做', // steps 折叠
    '运行中',
    '绑定地址',
    '只绑这一个具体地址', // 明确"不是 0.0.0.0"
    '2/9', // 连接数 active/total
    '被拒次数',
    'rt_••••••••', // 打码 token
    '最近错误',
    '上一次绑定失败：端口被占用',
    '通过', // checks: ok
    '注意', // checks: warn
    '失败', // checks: fail
    '无法自证', // checks: unknown
    '部分可用：本机能绑上，平板可达未证实', // verdict 大字
    '在 Windows 防火墙放行该端口', // check hint
    '扫码打开',
    '用平板扫这个码' // qr.hint
  ]) {
    assert.ok(text.includes(expected), `渲染结果里缺少文案「${expected}」`)
  }
  assert.ok(text.includes('http://192.168.1.6:3080/'), '链接区应显示不含令牌的地址')
})

test('RemotePanel：uu（unsupported）在下拉里被禁用，lan 不被禁用', async () => {
  const { mod } = await loadClient()
  const sections = renderSections(mod)
  const remote = sections.find((s) => s.options.id === 'git-config-sync-remote')
  const tree = renderRemote(remote.component, { seedState: fakeState() })

  const nodes = nodesOf(tree)
  const options = nodes.filter((node) => node.type === 'option')
  const uu = options.find((node) => node.props.value === 'uu')
  const lan = options.find((node) => node.props.value === 'lan')
  assert.ok(uu, '方式下拉里必须仍列出 uu（让用户看到原因，而不是消失）')
  assert.equal(uu.props.disabled, true, 'unsupported 的项必须禁用')
  assert.ok(lan)
  assert.notEqual(lan.props.disabled, true, '可用方式不得被禁用')
  assert.equal(nodes.filter((node) => node.type === 'select').length, 1, '方式下拉一个')
})

test('RemotePanel：端口是数字输入，字段来自 spec.fields', async () => {
  const { mod } = await loadClient()
  const sections = renderSections(mod)
  const remote = sections.find((s) => s.options.id === 'git-config-sync-remote')
  const tree = renderRemote(remote.component, { seedState: fakeState() })
  const nodes = nodesOf(tree)

  const numbers = nodes.filter((node) => node.type === 'input' && node.props.type === 'number')
  assert.equal(numbers.length, 1, '端口必须是唯一的数字输入')
  assert.equal(numbers[0].props.value, '0', '端口默认值来自 settings（0 = 跟 DSH 同端口）')
  const texts = nodes.filter((node) => node.type === 'input' && node.props.type === 'text')
  assert.ok(texts.some((node) => node.props.value === '192.168.1.6'), 'lanAddress 的值必须来自 settings')
  assert.ok(
    texts.some((node) => node.props.placeholder === zh['remote.fields.lanAddress.placeholder']),
    '占位符优先用 remote.fields.*.placeholder'
  )
  const labels = nodes.filter((node) => node.type === 'label').map((node) => textOf(node))
  assert.ok(labels.some((label) => label.includes('局域网地址')), '字段 label 必须本地化')
})

test('RemotePanel：二维码画成 SVG（模块 ≥3px、白底、四周留白）', async () => {
  const { mod } = await loadClient()
  const sections = renderSections(mod)
  const remote = sections.find((s) => s.options.id === 'git-config-sync-remote')
  const tree = renderRemote(remote.component, { seedState: fakeState(), seedLink: fakeLink() })
  const nodes = nodesOf(tree)

  const svgs = nodes.filter((node) => node.type === 'svg')
  assert.equal(svgs.length, 1, '二维码必须且只画一个 svg')
  const svg = svgs[0]
  const rects = nodes.filter((node) => node.type === 'rect')
  assert.ok(rects.length > 1, '二维码必须有底色 + 黑格 rect')
  assert.equal(rects[0].props.fill, '#ffffff', '第一层必须是白底')
  const cells = rects.slice(1)
  for (const cell of cells) {
    assert.equal(cell.props.fill, '#000000')
    assert.ok(cell.props.width >= 3, `模块尺寸必须 ≥3px，实际 ${cell.props.width}`)
    assert.ok(cell.props.x >= 12, '四周必须留白（静区）')
    assert.ok(cell.props.y >= 12, '四周必须留白（静区）')
  }
  assert.equal(svg.props.width, 52, '5 模块 × 4px + 静区 = 52px')
  assert.equal(svg.props.width, svg.props.height)
})

test('RemotePanel：渲染结果里没有任何 token 明文（含属性 / title / aria）', async () => {
  const { mod } = await loadClient()
  const sections = renderSections(mod)
  const remote = sections.find((s) => s.options.id === 'git-config-sync-remote')
  const tree = renderRemote(remote.component, { seedState: fakeState(), seedLink: fakeLink() })

  assert.ok(!textOf(tree).includes(TOKEN_PLAIN), '可见文案里不得出现 token')
  const dump = serialize(tree)
  assert.ok(!dump.includes(TOKEN_PLAIN), '整棵树的属性（含 title/aria）都不得出现 token')
  // 打码串必须是 status.token.masked 原文
  assert.ok(dump.includes('rt_••••••••'), '令牌只显示打码串')
})

test('RemotePanel：initial state 为 null 时也能渲染（加载态），不抛异常', async () => {
  const { mod } = await loadClient()
  const sections = renderSections(mod)
  const remote = sections.find((s) => s.options.id === 'git-config-sync-remote')

  let tree = null
  assert.doesNotThrow(() => {
    tree = renderRemote(remote.component, {})
  })
  const text = textOf(tree)
  assert.ok(text.includes('远程访问'))
  assert.ok(text.includes('读取中'), '首次挂载必须显示加载态')
  // 没有自己的错误时不许出现 ErrorBox（否则会显得"一进来就红了"）
  assert.equal(nodesOf(tree).filter((node) => node.props.role === 'alert').length, 0)
})

test('RemotePanel：错误隔离——本 section 的 ErrorBox 不来自同步面板', async () => {
  const { mod } = await loadClient()
  const sections = renderSections(mod)
  const remote = sections.find((s) => s.options.id === 'git-config-sync-remote')

  const tree = renderRemote(remote.component, { seedState: fakeState() })
  // 两个 panel 是不同组件实例，远程面板自有 error state（初值为 null）。
  // 这里用「远程 state 里带 lastError」证明：状态里的失败只以中性框出现，不落成 role=alert 的红框。
  assert.equal(nodesOf(tree).filter((node) => node.props.role === 'alert').length, 0)
  assert.ok(textOf(tree).includes('最近错误'), 'lastError 以中性标签展示')
})
