/**
 * mod-plugin-git-username（面板侧收尾）：Gitee 登录名必须由**宿主**裁决。
 *
 * 旧代码在 SettingsPanel.doSave 里凭 `username.trim() === ''` 自己发一个
 * E_VALIDATION 并 return，saveSettings 永远走不到，宿主的推断／403 事实没有机会出现。
 * 本文件钉死：空登录名照样调用 saveSettings；字段只由宿主 E_AUTH/401/403 打开。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const zh = JSON.parse(readFileSync(path.join(pkgDir, 'locale', 'zh.json'), 'utf8'))

const DERIVABLE_URL = 'https://gitee.com/owner/repo.git'
const NO_OWNER_URL = 'https://gitee.com'
const HOST_USERNAME_ERROR = 'Gitee 需要填写用户名（Gitee 登录名），私人令牌只作密码'
const EXACT_FIELD_COPY = 'Gitee 的私人令牌只能当密码，需要你的登录名；通常就是仓库地址里的 owner'

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
    get tree() { return tree },
  }
}

let panelPromise = null
async function loadPanel() {
  if (!panelPromise) {
    panelPromise = (async () => {
      let captured = null
      globalThis.window = { __ModuleLoader__: { load(cfg) { captured = cfg } } }
      await import(pathToFileURL(path.join(pkgDir, 'dist', 'client.js')).href + '?gitee-host-decides=' + Date.now())
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
const dataNode = (tree, key) => nodesOf(tree).filter((node) => node.props && node.props['data-lean'] === key)
const button = (tree, label) => {
  const found = nodesOf(tree).filter((node) => node.type === 'button' && textOf(node.props.children) === label)
  assert.equal(found.length, 1, `按钮「${label}」必须恰好一个`)
  return found[0]
}
const settle = async () => { for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setTimeout(resolve, 5)) }

function stateData(repoUrl, username = '') {
  return {
    settings: {
      repoUrl, platform: 'gitee', authMode: 'https', username,
      hasToken: true, branch: 'main', deviceId: 'gwl-pc', scope: {},
    },
    status: { lastSyncAt: null, probe: null, visibilityBlocked: false },
    modes: [],
  }
}

async function renderComponent(which, repoUrl, routes = {}, username = '') {
  const Panel = await loadPanel()
  const calls = []
  const defaultRoutes = {
    getState: () => ({ ok: true, data: stateData(repoUrl, username) }),
    saveSettings: () => ({ ok: true, data: { settings: stateData(repoUrl).settings, hasToken: true } }),
    testConnection: () => ({ ok: true, data: { reachable: true, branch: 'main', headSha: '', message: '' } }),
  }
  const merged = Object.assign(defaultRoutes, routes)
  globalThis.fetch = async function (_url, options) {
    const body = JSON.parse(options.body)
    calls.push(body)
    const handler = merged[body.action]
    const payload = typeof handler === 'function' ? await handler(body) : handler
    return { status: 200, async text() { return JSON.stringify(payload || { ok: false, error: { code: 'E_NO_STUB', message: '' } }) } }
  }
  activeMount = mountComponent(Panel[which], { t: (key) => zh[key] || key, close() {} })
  activeMount.render()
  await settle()
  return { mount: activeMount, calls, tree: activeMount.tree }
}

const click = async (tree, label) => { await button(tree, label).props.onClick(); await settle() }

test('G1：Gitee 空登录名 + 可推断 owner ⇒ saveSettings 被调用，客户端不再自造 E_VALIDATION', async () => {
  // retarget（mod-plugin-dormant-panel-removal）：旧 SettingsPanel 已删，改为挂载 shipped LeanSyncGroup，
  // 断言同一条策略——登录名只由宿主裁决，客户端不得预填/预检。
  const { mount, calls } = await renderComponent('LeanSyncGroup', DERIVABLE_URL)
  await click(mount.tree, zh['lean.actions.save'])
  const saved = calls.filter((c) => c.action === 'saveSettings')
  assert.equal(saved.length, 1, '空登录名也必须调用 saveSettings，让宿主推断')
  assert.equal(saved[0].settings.username, undefined, '客户端不得替用户猜一个登录名（请求不带 username）')
  assert.equal(textOf(mount.tree).includes('Gitee 需要填写用户名（Gitee 登录名）。私人令牌只作密码，不能代替用户名。'), false, '客户端不得再报旧的预检文案')
})

test('G2：源码守卫——不存在 username.trim() 预检，也没有 tr(error.giteeUsername) 调用', () => {
  const client = readFileSync(path.join(pkgDir, 'src', 'client.js'), 'utf8')
  assert.equal(client.includes("next.username.trim() === ''"), false, '不得保留客户端预检')
  assert.equal(client.includes("tr('error.giteeUsername')"), false, '不得由客户端发出该 E_VALIDATION')
})

test('G3：不可推断 owner ⇒ 显示宿主返回的 typed 错误，而不是客户端预检文案', async () => {
  // retarget（mod-plugin-dormant-panel-removal）：同上，改挂 shipped LeanSyncGroup。
  const { mount, calls } = await renderComponent('LeanSyncGroup', NO_OWNER_URL, {
    saveSettings: () => ({ ok: false, error: { code: 'E_VALIDATION', message: HOST_USERNAME_ERROR } }),
  })
  await click(mount.tree, zh['lean.actions.save'])
  assert.equal(calls.filter((c) => c.action === 'saveSettings').length, 1, '先让宿主裁决')
  assert.ok(textOf(mount.tree).includes(HOST_USERNAME_ERROR), '必须显示宿主的 typed 错误')
  assert.equal(textOf(mount.tree).includes('Gitee 需要填写用户名（Gitee 登录名）。私人令牌只作密码，不能代替用户名。'), false, '不得被客户端旧文案顶掉')
})

test('G4：宿主 E_AUTH 才展开登录名字段（逐字文案），保存成功后收起', async () => {
  let round = 0
  const { mount } = await renderComponent('LeanSyncGroup', DERIVABLE_URL, {
    saveSettings: (body) => {
      round += 1
      if (round === 1) return { ok: false, error: { code: 'E_AUTH', message: 'HTTP 403' } }
      return { ok: true, data: { settings: stateData(DERIVABLE_URL, body.settings.username).settings, hasToken: true } }
    },
  })
  assert.equal(dataNode(mount.tree, 'sync-login-field').length, 0, '保存前不得有常驻登录名输入')
  await click(mount.tree, zh['lean.actions.save'])
  const opened = nodesOf(mount.tree)
  assert.equal(dataNode(mount.tree, 'sync-login-field').length, 1, '宿主 E_AUTH 后才展开')
  assert.equal(textOf(dataNode(mount.tree, 'sync-login-hint')[0]), EXACT_FIELD_COPY)
  assert.equal(zh['lean.sync.login.required'], EXACT_FIELD_COPY)
  const input = opened.filter((n) => n.type === 'input' && n.props['data-lean'] === undefined).pop()
  assert.ok(input, '字段里必须有可编辑登录名输入')
  input.props.onChange({ target: { value: 'my-login' } })
  await click(mount.tree, zh['lean.actions.save'])
  assert.equal(dataNode(mount.tree, 'sync-login-field').length, 0, '宿主保存成功后字段收起')
  assert.equal(dataNode(mount.tree, 'sync-login-derived').length, 1, '回到只读派生行')
})
