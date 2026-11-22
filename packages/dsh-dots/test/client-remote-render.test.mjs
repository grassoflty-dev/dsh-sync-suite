/**
 * 远程访问 section 的渲染回归（桩渲染，React 语义与 client-render.test.mjs 一致）。
 *
 * 断言四件事：
 *   1. 全插件只注册**一个** section（id dots / order 70 / label DSH-dots），
 *      远程控制只是该单页里的折叠分组（内部 id dots-remote），locale 共用同一个 NS；
 *   2. `remote.*` 文案在 locale/zh.json 与 locale/en.json 都存在且两侧键集一致；
 *   3. 用「含 uu（needs-setup：图形化端口映射）+ 四种 level 的 checks + qr 矩阵」的假 state
 *      渲染 RemotePanel 不抛异常，且 DOM 里出现「远程访问」「需先准备」「图形化端口映射」等文案；
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

/** 唯一 section 的单页组件把原 RemotePanel 暴露在 .RemotePanel 上，供本文件单独挂载。 */
function remotePanel(mod) {
  const sections = renderSections(mod)
  assert.equal(sections.length, 1, '只允许一个 settings.section')
  const component = sections[0].component.RemotePanel
  assert.ok(component, '单页组件必须暴露原 RemotePanel')
  return component
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
  assert.ok(section.component.RemotePanel, '远程控制必须作为单页内的分组存在')
  assert.ok(section.component.SettingsPanel, '配置同步必须作为单页内的分组存在')
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

test('RemotePanel：假 state 渲染不抛异常，且出现「远程访问」「需先准备」等文案', async () => {
  const { mod } = await loadClient()
  const remote = remotePanel(mod)

  let tree = null
  assert.doesNotThrow(() => {
    tree = renderRemote(remote, { seedState: fakeState(), seedLink: fakeLink() })
  }, 'RemotePanel 渲染不得抛异常')

  const text = textOf(tree)
  for (const expected of [
    '远程访问', // remote.title / nav
    '需先准备', // uu / ipv6 / tailscale 的 availability 徽章
    '网易 UU', // 方式名
    '图形化端口映射', // uu 的 requires（可用但有前置）
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
  // 旧的（错误）结论文案不得再出现在 UI 里
  assert.equal(text.includes('不对第三方开放'), false, 'uu 不再有"不可用"的理由文案')
  assert.equal(text.includes('画面串流'), false, 'uu 不再是"画面串流不是隧道"的说法')
})

test('RemotePanel：uu（needs-setup）可被选中，显示 requires 与操作提示', async () => {
  const { mod } = await loadClient()
  const remote = remotePanel(mod)
  const tree = renderRemote(remote, { seedState: fakeState('uu') })

  const nodes = nodesOf(tree)
  const options = nodes.filter((node) => node.type === 'option')
  const uu = options.find((node) => node.props.value === 'uu')
  const lan = options.find((node) => node.props.value === 'lan')
  assert.ok(uu, '方式下拉里必须列出 uu')
  assert.notEqual(uu.props.disabled, true, 'needs-setup 的 uu 必须可选（不再是 disabled）')
  assert.ok(lan)
  assert.notEqual(lan.props.disabled, true, '可用方式不得被禁用')
  assert.equal(nodes.filter((node) => node.type === 'select').length, 1, '方式下拉一个')

  const text = textOf(tree)
  // 选中 uu 后的说明区：徽章 + 前置条件 + 操作步骤 + 字段
  assert.ok(text.includes('需先准备'), 'uu 的徽章必须是「需先准备」')
  assert.ok(text.includes('图形化端口映射'), '必须显示 uu 的 requires')
  assert.ok(text.includes('怎么做'), 'uu 必须有可展开的操作步骤')
  assert.ok(text.includes('电脑上启动 DSH'), 'uu 的步骤文案必须渲染出来')
  assert.ok(text.includes('对外入口地址'), 'uu 的 manualUrl 字段 label 必须渲染出来')

  // 字段来自 spec.fields：对外入口（text）+ 访问令牌（password），端口输入仍在
  const inputs = nodes.filter((node) => node.type === 'input')
  assert.ok(
    inputs.some((node) => node.props.type === 'text' && node.props.placeholder.includes('abc.uuyc.com:12345')),
    '对外入口字段必须用 uu 自己的 placeholder'
  )
  assert.equal(inputs.filter((node) => node.props.type === 'password').length, 1, 'uu 有一个可选的访问令牌输入')
  assert.equal(inputs.filter((node) => node.props.type === 'number').length, 1, '端口仍是唯一的数字输入')
})

test('RemotePanel：端口是数字输入，字段来自 spec.fields', async () => {
  const { mod } = await loadClient()
  const remote = remotePanel(mod)
  const tree = renderRemote(remote, { seedState: fakeState() })
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
  const remote = remotePanel(mod)
  const tree = renderRemote(remote, { seedState: fakeState(), seedLink: fakeLink() })
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
  const remote = remotePanel(mod)
  const tree = renderRemote(remote, { seedState: fakeState(), seedLink: fakeLink() })

  assert.ok(!textOf(tree).includes(TOKEN_PLAIN), '可见文案里不得出现 token')
  const dump = serialize(tree)
  assert.ok(!dump.includes(TOKEN_PLAIN), '整棵树的属性（含 title/aria）都不得出现 token')
  // 打码串必须是 status.token.masked 原文
  assert.ok(dump.includes('rt_••••••••'), '令牌只显示打码串')
})

test('RemotePanel：initial state 为 null 时也能渲染（加载态），不抛异常', async () => {
  const { mod } = await loadClient()
  const remote = remotePanel(mod)

  let tree = null
  assert.doesNotThrow(() => {
    tree = renderRemote(remote, {})
  })
  const text = textOf(tree)
  assert.ok(text.includes('远程访问'))
  assert.ok(text.includes('读取中'), '首次挂载必须显示加载态')
  // 没有自己的错误时不许出现 ErrorBox（否则会显得"一进来就红了"）
  assert.equal(nodesOf(tree).filter((node) => node.props.role === 'alert').length, 0)
})

test('RemotePanel：错误隔离——本 section 的 ErrorBox 不来自同步面板', async () => {
  const { mod } = await loadClient()
  const remote = remotePanel(mod)

  const tree = renderRemote(remote, { seedState: fakeState() })
  // 两个 panel 是不同组件实例，远程面板自有 error state（初值为 null）。
  // 这里用「远程 state 里带 lastError」证明：状态里的失败只以中性框出现，不落成 role=alert 的红框。
  assert.equal(nodesOf(tree).filter((node) => node.props.role === 'alert').length, 0)
  assert.ok(textOf(tree).includes('最近错误'), 'lastError 以中性标签展示')
})

/* -------------------------------------------------------------------------- */
/* 4) 「访问令牌（可选）」字段                                                  */
/* -------------------------------------------------------------------------- */

test('RemotePanel：token 字段渲染成 password 输入，初始值为空串，hint 用 remote.field.token.hint', async () => {
  const { mod } = await loadClient()
  const remote = remotePanel(mod)
  const tree = renderRemote(remote, { seedState: fakeState() })
  const nodes = nodesOf(tree)

  const passwords = nodes.filter((node) => node.type === 'input' && node.props.type === 'password')
  assert.equal(passwords.length, 1, 'lan 方式必须恰好一个 password 输入（访问令牌）')
  assert.equal(passwords[0].props.value, '', '表单初始值必须是空串（不能预填任何令牌）')
  assert.equal(passwords[0].props.placeholder, '粘贴电脑上 DSH 地址里的 token')
  assert.equal(passwords[0].props.autoComplete, 'new-password', '不能让浏览器自动填充已保存密码')

  const text = textOf(tree)
  assert.ok(text.includes(zh['remote.field.token']), '标签必须用 remote.field.token')
  assert.ok(text.includes(zh['remote.field.token.hint']), 'hint 必须渲染在字段下面')
  assert.ok(text.includes('访问令牌（可选）'), '中文标签字面量')
  // 未保存令牌时不出现徽章/清除按钮
  assert.equal(text.includes('清除令牌'), false)
})

test('RemotePanel：令牌明文（即使 host 误塞进 settings）绝不进 DOM', async () => {
  const { mod } = await loadClient()
  const remote = remotePanel(mod)
  const tree = renderRemote(remote, {
    // 契约里 settings 是 view（没有 token）；这里故意塞一个明文，验证客户端也不会渲染它。
    seedState: fakeState('lan', { tokenSet: true, tokenMasked: 'rt_p…6789', token: TOKEN_PLAIN }),
    seedLink: fakeLink()
  })
  const dump = serialize(tree)
  assert.equal(dump.includes(TOKEN_PLAIN), false, '整棵树（含属性）都不得出现令牌明文')
  assert.equal(textOf(tree).includes(TOKEN_PLAIN), false)
  // password 输入的值仍然只能是空串（来自表单 state）
  const passports = nodesOf(tree).filter((node) => node.type === 'input' && node.props.type === 'password')
  assert.equal(passports.length, 1)
  assert.equal(passports[0].props.value, '')
  assert.equal(passports[0].props.defaultValue, undefined)
})

test('RemotePanel：已保存令牌显示中性徽章（打码）+「清除令牌」，点击不崩且不泄露明文', async () => {
  const { mod } = await loadClient()
  const remote = remotePanel(mod)
  const tree = renderRemote(remote, {
    seedState: fakeState('lan', { tokenSet: true, tokenMasked: 'rt_p…6789' })
  })

  const text = textOf(tree)
  assert.ok(text.includes('已保存访问令牌（rt_p…6789）'), '必须显示打码徽章')
  assert.ok(text.includes('清除令牌'), '必须有「清除令牌」按钮')

  const clearBtn = nodesOf(tree).find(
    (node) => node.type === 'button' && textOf(node).includes('清除令牌')
  )
  assert.ok(clearBtn, '找不到「清除令牌」按钮')
  assert.equal(typeof clearBtn.props.onClick, 'function')
  assert.doesNotThrow(() => clearBtn.props.onClick(), '点击「清除令牌」只改表单 state，不得抛异常')
  assert.equal(serialize(tree).includes(TOKEN_PLAIN), false)
})

test('RemotePanel：令牌字段出现在 lan/ipv6/tailscale/uu（manual 没有），字段数量随方式变化', async () => {
  const { mod } = await loadClient()
  const remote = remotePanel(mod)

  const inputCount = (tree) => {
    const nodes = nodesOf(tree).filter((node) => node.type === 'input')
    const numbers = nodes.filter((node) => node.props.type === 'number').length
    const texts = nodes.filter((node) => node.props.type === 'text').length
    const passwords = nodes.filter((node) => node.props.type === 'password').length
    // total 只数"字段输入"（不含「允许远程访问」的 checkbox）。
    return {
      total: numbers + texts + passwords,
      numbers,
      texts,
      passwords,
      checkboxes: nodes.filter((node) => node.props.type === 'checkbox').length
    }
  }

  const lan = inputCount(renderRemote(remote, { seedState: fakeState('lan') }))
  assert.deepEqual(lan, { total: 3, numbers: 1, texts: 1, passwords: 1, checkboxes: 1 }, 'lan：局域网地址 + 端口 + 令牌')

  const ipv6 = inputCount(renderRemote(remote, { seedState: fakeState('ipv6') }))
  assert.deepEqual(ipv6, { total: 3, numbers: 1, texts: 1, passwords: 1, checkboxes: 1 }, 'ipv6：IPv6 地址 + 端口 + 令牌')

  const tailscale = inputCount(renderRemote(remote, { seedState: fakeState('tailscale') }))
  assert.deepEqual(tailscale, { total: 3, numbers: 1, texts: 1, passwords: 1, checkboxes: 1 }, 'tailscale：主机 + 端口 + 令牌')

  const manual = inputCount(renderRemote(remote, { seedState: fakeState('manual') }))
  assert.deepEqual(manual, { total: 2, numbers: 1, texts: 1, passwords: 0, checkboxes: 1 }, 'manual：只有完整地址（自带令牌），没有令牌字段')

  // uu：对外入口（text）+ 可选令牌（password）；端口输入仍在（虽然 uu 不起监听）
  const uu = inputCount(renderRemote(remote, { seedState: fakeState('uu') }))
  assert.deepEqual(uu, { total: 3, numbers: 1, texts: 1, passwords: 1, checkboxes: 1 }, 'uu：对外入口 + 可选令牌 + 端口输入')

  const manualText = textOf(renderRemote(remote, { seedState: fakeState('manual') }))
  assert.equal(manualText.includes('访问令牌（可选）'), false, 'manual 不该出现令牌字段')
})

/* -------------------------------------------------------------------------- */
/* 5) 通过合并后的单页（不是第二个 section）证明远程控件仍在                     */
/* -------------------------------------------------------------------------- */

test('merged panel：远程组的二维码/自检/状态/令牌控件仍在同一页内可达', async () => {
  const { mod } = await loadClient()
  const sections = renderSections(mod)
  assert.equal(sections.length, 1, '只有一个 settings.section')
  // 直接挂唯一的合并面板，不绕过它去挂 RemotePanel。
  const tree = sections[0].component({
    t: (key) => (typeof zh[key] === 'string' ? zh[key] : key),
    close() {},
    seedState: fakeState(),
    seedLink: fakeLink()
  })
  const group = groupOf(tree, 'dots-remote')
  const groupNodes = []
  walk(group.props.children, (node) => groupNodes.push(node))

  assert.equal(group.props.open, true, '远程组默认展开，控件首屏可达')
  assert.equal(groupNodes.filter((node) => node.type === 'svg').length, 1, '二维码必须仍由单页渲染')
  assert.equal(groupNodes.filter((node) => node.type === 'select').length, 1, '访问方式下拉仍在')
  assert.equal(groupNodes.filter((node) => node.type === 'button').length, 9, '远程 9 个按钮全部保留')
  const inputs = groupNodes.filter((node) => node.type === 'input')
  assert.deepEqual(
    {
      text: inputs.filter((node) => node.props.type === 'text').length,
      number: inputs.filter((node) => node.props.type === 'number').length,
      password: inputs.filter((node) => node.props.type === 'password').length,
      checkbox: inputs.filter((node) => node.props.type === 'checkbox').length
    },
    { text: 1, number: 1, password: 1, checkbox: 1 },
    '监听地址 / 端口 / 令牌 / 允许开关四个输入仍在'
  )

  const text = textOf(group)
  for (const expected of [
    '远程控制', // 页内分组标题
    '运行中', '绑定地址', '被拒次数', '最近错误', // 状态
    '需先准备', '图形化端口映射', // 访问方式前置说明
    '通过', '注意', '失败', '无法自证', // 自检四档
    '扫码打开', '用平板扫这个码', // 二维码
    'rt_••••••••' // 打码令牌
  ]) {
    assert.ok(text.includes(expected), `合并后远程组缺少「${expected}」`)
  }
  assert.equal(text.includes(TOKEN_PLAIN), false, '合并后仍不得出现令牌明文')
})
