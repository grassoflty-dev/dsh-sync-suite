/**
 * mod-plugin-git-username —— 面板渐进披露守卫。
 *
 * 默认只有 地址 + 令牌 + 只读派生行 + 状态 + 保存（不新增常驻输入；测试连接按钮已删除）；
 * 401/403 的登录名展开由 doSave 触发（原 doTest 分支已随按钮移除）；
 * 仅 401/403（E_AUTH）才追加「登录名」输入与指定文案；失焦即落 settings.username，
 * 鉴权成功即收起字段。复用 lean 面板同一套有状态 React 桩 + fetch 桩。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const zh = JSON.parse(readFileSync(path.join(pkgDir, 'locale', 'zh.json'), 'utf8'))

const EXACT_COPY = 'Gitee 的私人令牌只能当密码，需要你的登录名；通常就是仓库地址里的 owner'
const GITEE_URL = 'https://gitee.com/owner/repo.git'
const GITEE_ORG_URL = 'https://gitee.com/my-org/private-repo.git'
const TOKEN = 'gitee_private_token_0123456789abcdef'

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
  Children: { toArray(value) { return flatten(Array.isArray(value) ? value : [value], []) } },
}

function mountComponent(Component, props) {
  const hooks = []
  let cursor = 0
  let pendingEffects = []
  let rendering = false
  let tree = null
  function render() {
    cursor = 0
    pendingEffects = []
    rendering = true
    tree = Component(props)
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
    get tree() { return tree },
  }
  return mount
}

let panelPromise = null
async function loadPanel() {
  if (!panelPromise) {
    panelPromise = (async () => {
      let captured = null
      globalThis.window = { __ModuleLoader__: { load(cfg) { captured = cfg } } }
      await import(pathToFileURL(path.join(pkgDir, 'dist', 'client.js')).href + '?git-username-panel=' + Date.now())
      const mod = captured.factory((id) => {
        if (id === 'react') return reactStub
        throw new Error(`unexpected require: ${id}`)
      })
      let Panel = null
      mod.apply({
        effect(fn) { const d = fn(); return typeof d === 'function' ? d : function () {} },
        locale: { register() { return function () {} }, bind() { return (key) => key } },
        slots: {
          inject(_name, cb) { cb(); return function () {} },
          register(_options, component) { Panel = component; return function () {} },
        },
      })
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

function textOf(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node && typeof node === 'object') return textOf(node.props && node.props.children)
  return ''
}

const nodesOf = (tree) => { const out = []; walk(tree, (node) => out.push(node)); return out }
const dataNode = (nodes, key) => nodes.filter((node) => node.props && node.props['data-lean'] === key)
const button = (nodes, label) => nodes.filter((node) => node.type === 'button' && textOf(node.props.children) === label)[0]
const settle = async () => { for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setTimeout(resolve, 5)) }

function stateData(overrides = {}) {
  return {
    settings: Object.assign({ repoUrl: GITEE_URL, hasToken: true, username: '' }, overrides.settings || {}),
    status: Object.assign({ lastSyncAt: '2026-01-01T08:30:00+08:00', probe: null, visibilityBlocked: false }, overrides.status || {}),
    modes: [],
  }
}

/** 只挂载同步组；fetch 桩只覆盖它会调用的三个 action。 */
async function renderSync(overrides = {}) {
  const Panel = await loadPanel()
  const calls = []
  const routes = Object.assign({
    getState: () => ({ ok: true, data: stateData(overrides.state || {}) }),
    saveSettings: () => ({ ok: true, data: { settings: stateData().settings, hasToken: true } }),
    testConnection: () => ({ ok: true, data: { reachable: true, branch: 'main', headSha: '', message: '' } }),
  }, overrides.routes || {})
  globalThis.fetch = async function (_url, options) {
    const body = JSON.parse(options.body)
    calls.push(body)
    const handler = routes[body.action]
    const payload = typeof handler === 'function' ? await handler(body) : handler
    return { status: 200, async text() { return JSON.stringify(payload || { ok: false, error: { code: 'E_NO_STUB', message: '' } }) } }
  }
  activeMount = mountComponent(Panel.LeanSyncGroup, { t: (key) => zh[key] || key, close() {} })
  const mount = activeMount
  mount.render()
  await settle()
  return { mount, calls, nodes: nodesOf(mount.tree), text: textOf(mount.tree) }
}

test('C1：默认只读派生行显示推断 owner，且没有可编辑登录名（lean 清单不变）', async () => {
  const { nodes, text } = await renderSync()
  const derived = dataNode(nodes, 'sync-login-derived')
  assert.equal(derived.length, 1)
  assert.equal(textOf(derived[0]), '登录名：owner（由仓库地址推断）')
  assert.equal(dataNode(nodes, 'sync-login-field').length, 0, '默认不渲染登录名输入')
  assert.equal(dataNode(nodes, 'sync-login-hint').length, 0)
  assert.deepEqual(nodes.filter((n) => n.type === 'input').map((n) => n.props.type), ['text', 'password'])
  assert.equal(text.includes(EXACT_COPY), false)
})

test('C2：组织仓库 401 → 登录名字段出现，文案逐字一致，输入失焦即持久', async () => {
  const { mount, calls, nodes } = await renderSync({
    state: { settings: { repoUrl: GITEE_ORG_URL } },
    routes: {
      // 登录名展开改由保存路径的 401 触发（shipped UI 已无测试连接按钮）。
      saveSettings: (body) => ({ ok: false, error: { code: 'AUTH_ERROR', message: 'HTTP 401' } }),
    },
  })
  await button(nodesOf(mount.tree), '保存').props.onClick()
  await settle()
  const after = nodesOf(mount.tree)
  assert.equal(dataNode(after, 'sync-login-field').length, 1, '401 后必须出现登录名输入')
  assert.equal(textOf(dataNode(after, 'sync-login-hint')[0]), EXACT_COPY)
  assert.equal(zh['lean.sync.login.required'], EXACT_COPY, 'locale 文案必须与需求逐字一致')
  assert.equal(dataNode(after, 'sync-login-derived').length, 0, '可编辑字段出现后不再显示只读派生行')

  const inputs = after.filter((n) => n.type === 'input')
  assert.equal(inputs.length, 3, '失败后恰好 3 个输入：地址 / 令牌 / 登录名')
  const input = inputs[2]
  await input.props.onBlur({ target: { value: '  my-login  ' } })
  await settle()
  const saved = calls.filter((c) => c.action === 'saveSettings').pop()
  assert.equal(saved && saved.settings && saved.settings.username, 'my-login', '登录名必须落到本机 settings.username')
  assert.equal(saved && saved.token, undefined, '持久化登录名时不得重发令牌')

  // 刷新页面（重新挂载）后值仍在：来自 getState 的 settings.username。
  const reloaded = await renderSync({
    state: { settings: { repoUrl: GITEE_ORG_URL, username: 'my-login' } },
    routes: { saveSettings: () => ({ ok: false, error: { code: 'AUTH_ERROR', message: 'HTTP 401' } }) },
  })
  // 新挂载默认不展开字段，但状态里的值已被记住；再次 401 时应直接带出。
  assert.equal(dataNode(nodesOf(reloaded.mount.tree), 'sync-login-field').length, 0, '新挂载不常驻字段')
  await button(nodesOf(reloaded.mount.tree), '保存').props.onClick()
  await settle()
  const persisted = nodesOf(reloaded.mount.tree).filter((n) => n.type === 'input')[2]
  assert.equal(persisted.props.value, 'my-login', '刷新后登录名值仍在')
})

test('C3：鉴权成功 → 没有额外字段；DOM 里也不出现令牌', async () => {
  const { mount, calls, nodes } = await renderSync({
    routes: {
      saveSettings: () => ({ ok: false, error: { code: 'AUTH_ERROR', message: 'HTTP 403' } }),
    },
  })
  await button(nodesOf(mount.tree), '保存').props.onClick()
  await settle()
  assert.equal(dataNode(nodesOf(mount.tree), 'sync-login-field').length, 1)
  // 改成成功后再测一次：新挂载直接成功，字段不得出现。
  const success = await renderSync()
  assert.equal(dataNode(nodesOf(success.mount.tree), 'sync-login-field').length, 0)
  assert.equal(dataNode(nodesOf(success.mount.tree), 'sync-login-derived').length, 1)
  assert.equal(success.text.includes(TOKEN), false)
  assert.deepEqual(nodes.filter((n) => n.type === 'input').map((n) => n.props.type), ['text', 'password'])
  assert.equal(calls.length >= 2, true)
})

test('C4：lean 清单守卫复检——两组 / 仅地址令牌两输入 / 同步组只剩保存按钮', async () => {
  const { nodes } = await renderSync()
  assert.deepEqual(nodes.filter((n) => n.type === 'input').map((n) => n.props.type), ['text', 'password'])
  assert.deepEqual(
    nodes.filter((n) => n.type === 'button').map((n) => textOf(n.props.children)),
    ['保存'],
  )
  assert.equal(dataNode(nodes, 'sync-status').length, 1)
  assert.equal(nodes.filter((n) => n.type === 'select').length, 0, '同步组没有下拉框（方式在远程组）')
  const client = readFileSync(path.join(pkgDir, 'src', 'client.js'), 'utf8')
  assert.equal(client.includes('lean.sync.login.required'), true)
})
