/**
 * mod-plugin-lean-panel-guard — POLICY layer for the lean settings panel.
 *
 * This file deliberately does NOT re-test what existing guards already own:
 *   - `client-lean-inventory.test.mjs`: exact flat inventory (2 details groups,
 *     2 inputs + 1 select, exact 6-button label set), QR/copy/rotate RPC paths,
 *     d1/d2 transport selection, forbidden-word list `DELETED_LABELS`, M2 status truth.
 *   - `pairing-client-wiring.test.mjs`: real pairing RPC wiring (QR from pairingShow,
 *     rotate, redacted audit, stop/start, announce marker) and engine-level token schema.
 *   - `repo-precheck.test.mjs`: full 14-vector plugin/App parity, all six typed codes,
 *     clone quarantine, state.repoBlockCode. (Only the save-order + one targeted
 *     byte-unchanged refusal are re-checked here, as this module's brief requires.)
 *   - `git-username.test.mjs` / `client-git-username.test.mjs`: the G01 inference table.
 *
 * What this file adds is the POLICY layer: one registration, conditional field
 * mechanism, no advanced section, no manual git-sync triggers, save-time precheck
 * ordering on BOTH sides, zero-config pairing, credential hygiene, one view only.
 *
 * Source-level guards prove source shape, not rendered pixels. No device / GUI run.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const clientDist = path.join(pkgDir, 'dist', 'client.js')
const clientSrcPath = path.join(pkgDir, 'src', 'client.js')
const rpcSrcPath = path.join(pkgDir, 'src', 'rpc.ts')
const pluginVisibilitySrcPath = path.join(pkgDir, 'src', 'remote', 'repoVisibility.ts')
const appRoot = path.resolve(pkgDir, '..', '..', 'apps', 'arkui-schedule', 'entry', 'src', 'main', 'ets')
const appSettingsSrcPath = path.join(appRoot, 'pages', 'SettingsSync.ets')
const appVisibilitySrcPath = path.join(appRoot, 'model', 'repoVisibility.ts')
const zh = JSON.parse(readFileSync(path.join(pkgDir, 'locale', 'zh.json'), 'utf8'))

/* -------------------------------------------------------------------------- */
/* Minimal React stub + host props, copied from the existing client-*.test.mjs  */
/* -------------------------------------------------------------------------- */
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
      await import(pathToFileURL(clientDist).href + '?lean-panel-guard=' + Date.now())
      assert.ok(captured, 'client.js 必须调用 window.__ModuleLoader__.load')
      const mod = captured.factory((id) => {
        if (id === 'react') return reactStub
        throw new Error(`unexpected require: ${id}`)
      })
      const injects = []
      const registers = []
      mod.apply({
        effect(fn) { const d = fn(); return typeof d === 'function' ? d : function () {} },
        locale: { register() { return function () {} }, bind() { return function (key) { return key } } },
        slots: {
          inject(name, cb) { injects.push(name); cb(); return function () {} },
          register(options, component) { registers.push({ options, component }); return function () {} }
        }
      })
      assert.equal(registers.length, 1, 'loader 必须恰好注册一个 settings.section 组件')
      return { Panel: registers[0].component, injects, registers }
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
  const out = []
  walk(tree, (node) => out.push(node))
  return out
}
function nodesBelow(root) {
  const out = []
  walk(root, (node) => out.push(node))
  return out
}
function detailsOf(nodes, id) {
  const found = nodes.filter((n) => n.type === 'details' && n.props.id === id)
  assert.equal(found.length, 1, `details#${id} 必须恰好一个`)
  return found[0]
}
function marked(nodes, key) {
  return nodes.filter((n) => n.props && n.props['data-lean'] === key)
}
function buttonsOf(nodes) {
  return nodes.filter((n) => n.type === 'button')
}
function inputsOf(nodes) {
  return nodes.filter((n) => n.type === 'input')
}
function button(nodes, label) {
  const found = buttonsOf(nodes).filter((n) => textOf(n.props.children) === label)
  assert.equal(found.length, 1, `按钮「${label}」必须恰好一个`)
  return found[0]
}

/* -------------------------------------------------------------------------- */
/* fetch / clipboard stubs — real host props { t, close }, no seed seam        */
/* -------------------------------------------------------------------------- */
const GITEE_URL = 'https://gitee.com/ding_haoran/dsh-mobile-remote.git'
const REMOTE_TOKEN = 'rt_real_0123456789abcdef'
const PAIR_TEXT = 'DSHDOTS1|1|gwl-pc|lan|192.168.1.6|44996|' + REMOTE_TOKEN + '|AA:BB||00000000'
const PAIR_VIEW = {
  v: 1, instanceId: 'gwl-pc', transport: 'lan', host: '192.168.1.6', port: 44996,
  tlsFingerprint: 'AA:BB', announceRef: '', token: 'present'
}
const QR = {
  size: 3,
  modules: [[true, false, true], [false, true, false], [true, false, true]]
}

function stateData(overrides = {}) {
  return {
    settings: Object.assign(
      { repoUrl: GITEE_URL, hasToken: true, mode: 'lan', port: 0 },
      overrides.settings || {}
    ),
    status: Object.assign(
      { lastSyncAt: '2026-01-01T08:30:00+08:00', running: true, probe: null, visibilityBlocked: false },
      overrides.status || {}
    ),
    modes: []
  }
}
function savedData(tokenPresent) {
  return { settings: { repoUrl: GITEE_URL, branch: 'main', platform: 'gitee' }, hasToken: tokenPresent }
}
function pairCandidates() {
  return {
    tailscale: { kind: 'tailscale', available: false, reason: 'tailnet', host: '' },
    lan: { kind: 'lan', available: true, reason: 'same wifi', host: '192.168.1.6' },
    ipv6: { kind: 'ipv6', available: false, reason: 'no ipv6', host: '' }
  }
}

const clipboardWrites = []
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { clipboard: { writeText: async (value) => { clipboardWrites.push(value) } } }
})

function makeFetch(overrides = {}) {
  const calls = []
  const routes = Object.assign({
    getState: () => ({ ok: true, data: stateData(overrides.state || {}) }),
    saveSettings: () => ({ ok: true, data: savedData(true) }),
    remoteGetState: () => ({ ok: true, data: stateData(overrides.state || {}) }),
    pairingProvision: () => ({
      ok: true,
      data: { view: PAIR_VIEW, changed: { port: false, token: false, cert: false }, republish: null }
    }),
    pairingTransports: (body) => ({
      ok: true,
      data: {
        selected: 'lan', selectedHost: '192.168.1.6',
        overrideUnavailable: body.transport === 'ipv6',
        candidates: pairCandidates(), reasonLines: []
      }
    }),
    pairingConnections: () => ({ ok: true, data: [] }),
    pairingShow: () => ({ ok: true, data: { payload: '{}', text: PAIR_TEXT, qr: QR } }),
    pairingRotateToken: () => ({
      ok: true,
      data: { view: PAIR_VIEW, changed: { port: false, token: true, cert: false }, republish: null }
    }),
    remoteStop: () => ({ ok: true, data: { running: false } }),
    remoteStart: () => ({ ok: true, data: { running: true } }),
    remoteProbe: () => ({ ok: true, data: { level: 'ok', verdict: 'probe ok' } }),
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

/** Promise flush used by the existing client-*.test.mjs harness (not a retry). */
const settle = async () => {
  for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setTimeout(resolve, 5))
}

async function renderReal(overrides = {}) {
  const { Panel } = await loadPanel()
  const calls = makeFetch(overrides)
  clipboardWrites.length = 0
  activeMount = mountPanel(Panel, { t: (key) => zh[key] || key, close() {} })
  const mount = activeMount
  mount.render()
  await settle()
  return { mount, calls, nodes: nodesOf(mount.tree), text: textOf(mount.tree), clipboardWrites }
}

async function click(mount, label) {
  const target = button(nodesOf(mount.tree), label)
  await target.props.onClick()
  await settle()
}

/* ========================================================================== */
/* G1 — one plugin row only                                                    */
/* ========================================================================== */
test('G1: exactly one settings.section registration with the exact shipped id/label/order', async () => {
  const { injects, registers } = await loadPanel()
  assert.deepEqual(injects, ['settings.section'], '插件只能注入一个 slot，且必须是 settings.section')
  assert.equal(registers.length, 1, '插件只能注册一个条目（「内置插件」因此只有一行）')
  const reg = registers[0]
  assert.deepEqual(
    { name: reg.options.name, id: reg.options.id, order: reg.options.order, locale: reg.options.locale },
    { name: 'settings.section', id: 'dots', order: 70, locale: 'dots' }
  )
  assert.equal(reg.options.label(), zh['panel.title'], '标题必须是面板 shipped 文案')
  const src = readFileSync(clientSrcPath, 'utf8')
  assert.equal((src.match(/ctx\.slots\.inject\s*\(/g) || []).length, 1)
  assert.equal((src.match(/ctx\.slots\.register\s*\(/g) || []).length, 1)
})

/* ========================================================================== */
/* G2 — two always-on fields; login name is derived, not a third input         */
/* ========================================================================== */
test('G2: fresh good-token mount has only the two shipped config fields; login is a derived note', async () => {
  const { nodes, text } = await renderReal({ state: { settings: { repoUrl: GITEE_URL, hasToken: true } } })
  const sync = nodesBelow(detailsOf(nodes, 'dots'))
  const remote = nodesBelow(detailsOf(nodes, 'dots-remote'))

  // The conditional field's real mechanism is `needLogin` -> data-lean marker.
  assert.equal(marked(sync, 'sync-login-field').length, 0, 'fresh mount 不得出现可编辑登录名')
  assert.equal(marked(sync, 'sync-login-hint').length, 0)
  const derived = marked(sync, 'sync-login-derived')
  assert.equal(derived.length, 1, 'Gitee 地址应显示只读派生行')
  assert.equal(derived[0].type, 'div', '派生行是只读 note，不是第三个输入框')
  assert.equal(derived[0].props.role, 'note')
  assert.ok(text.includes(zh['lean.sync.login.inferred'].replace('{name}', 'ding_haoran')))

  assert.deepEqual(inputsOf(sync).map((n) => n.props.type), ['text', 'password'], '常驻字段恰好仓库地址 + 令牌')
  assert.equal(inputsOf(remote).length, 0, '远程组没有任何配置输入')
})

/* ========================================================================== */
/* G3 — conditional login field follows the REAL auth-failure mechanism        */
/* ========================================================================== */
test('G3: login field appears only on E_AUTH / 401 / 403 and collapses on success', async () => {
  let mode = 'auth'
  const { mount } = await renderReal({
    state: { settings: { repoUrl: GITEE_URL, hasToken: true } },
    routes: {
      saveSettings: () => mode === 'auth'
        ? { ok: false, error: { code: 'E_AUTH', message: 'HTTP 403' } }
        : { ok: true, data: savedData(true) }
    }
  })
  assert.equal(marked(nodesOf(mount.tree), 'sync-login-field').length, 0)
  await click(mount, '保存')
  assert.equal(marked(nodesOf(mount.tree), 'sync-login-field').length, 1, 'E_AUTH 必须展开登录名')
  assert.equal(marked(nodesOf(mount.tree), 'sync-login-derived').length, 0, '展开后可编辑字段取代只读派生行')
  assert.equal(marked(nodesOf(mount.tree), 'sync-login-hint').length, 1)
  assert.deepEqual(inputsOf(nodesOf(mount.tree)).map((n) => n.props.type), ['text', 'password', 'text'], '此时恰好第三个输入')

  mode = 'ok'
  await click(mount, '保存')
  assert.equal(marked(nodesOf(mount.tree), 'sync-login-field').length, 0, '鉴权成功后条件字段收起')

  // Non-auth failure must NOT reveal the field (pins leanIsAuthFailure's predicate).
  const b = await renderReal({
    routes: { saveSettings: () => ({ ok: false, error: { code: 'E_NETWORK', message: 'offline' } }) }
  })
  await click(b.mount, '保存')
  assert.equal(marked(nodesOf(b.mount.tree), 'sync-login-field').length, 0, '网络失败不是鉴权失败')

  // Numeric 403 on the save path (regex branch) also reveals it; the shipped
  // UI has no testConnection button after mod-plugin-sync-probe-removal.
  const c = await renderReal({
    routes: { saveSettings: () => ({ ok: false, error: { code: 'E_UNKNOWN', message: 'HTTP 403' } }) }
  })
  await click(c.mount, '保存')
  assert.equal(marked(nodesOf(c.mount.tree), 'sync-login-field').length, 1, '403 文案分支也必须展开')
})

/* ========================================================================== */
/* G4 — no advanced section / no third field class                             */
/* ========================================================================== */
test('G4: no advanced toggle or third field class anywhere in the lean panel tree', async () => {
  const { nodes, text } = await renderReal()
  // Re-declared verbatim from client-lean-inventory.test.mjs::DELETED_LABELS,
  // extended (never loosened) with 高级 / advanced.
  const FORBIDDEN = [
    '同步范围', '分支', '设备标识', '平台', '认证方式',
    '预览', '应用', '回滚', '快照', 'MERGE', '高级', 'advanced'
  ]
  for (const label of FORBIDDEN) {
    assert.equal(text.toLowerCase().includes(label.toLowerCase()), false, `已删除/高级控件文案「${label}」不得出现`)
  }
  assert.equal(nodes.filter((n) => n.type === 'details').length, 2, '复现第三分组即失败')
  assert.equal(inputsOf(nodes).filter((n) => n.props.type === 'checkbox').length, 0)
  assert.equal(inputsOf(nodes).filter((n) => n.props.type === 'number').length, 0)
  assert.equal(nodes.filter((n) => n.type === 'p').length, 0, '无步骤说明 / 前置条件段落')

  const src = readFileSync(clientSrcPath, 'utf8')
  const leanRegion = src.slice(src.indexOf('function leanInferLogin('), src.indexOf('function DotsPanel('))
  assert.ok(leanRegion.length > 1000, '找不到 lean 组件区域')
  assert.equal(leanRegion.includes('高级'), false)
  assert.equal(/advanced/i.test(leanRegion), false)
})

/* ========================================================================== */
/* G5 — no manual git-sync controls; pairing self-check stays in remote group  */
/* ========================================================================== */
const SYNC_TRIGGER_ACTIONS = ['push', 'retrySync', 'sync', 'syncNow', 'syncOnce', 'startSync', 'runSync', 'forcePush']

test('G5: exact per-group button sets; no button triggers a git sync; remoteProbe only from 自检', async () => {
  const first = await renderReal()
  const syncLabels = buttonsOf(nodesBelow(detailsOf(first.nodes, 'dots'))).map((n) => textOf(n.props.children))
  const remoteLabels = buttonsOf(nodesBelow(detailsOf(first.nodes, 'dots-remote'))).map((n) => textOf(n.props.children))
  // DARK absence guard (mod-plugin-sync-probe-removal): shipped 同步组只剩 保存。
  assert.deepEqual(syncLabels, ['保存'], '同步组恰好只有一个 保存 按钮；「测试连接」回归即失败')
  assert.deepEqual(remoteLabels, ['显示二维码', '复制配对串', '重新生成', '自检', '停止接受连接'])
  assert.equal(
    buttonsOf(first.nodes).map((n) => textOf(n.props.children)).includes('测试连接'),
    false,
    '面板树任何位置都不得再渲染「测试连接」按钮'
  )
  assert.equal(zh['lean.actions.test'], undefined, '已删除的文案键不得仍留在 locale')
  const clientSrc = readFileSync(clientSrcPath, 'utf8')
  assert.equal(clientSrc.includes('lean.actions.test'), false, 'shipped 客户端不得再引用已删文案键')
  // RPC 仍是 public/dormant action（内部可达，UI 不可达）。
  const rpcSrc = readFileSync(rpcSrcPath, 'utf8')
  assert.ok(rpcSrc.includes('async function testConnection('), '服务端 testConnection 实现仍保留')
  assert.ok(rpcSrc.includes("case 'testConnection':"), 'testConnection 仍注册为 RPC action')

  const probeFrom = []
  for (const label of [...syncLabels, ...remoteLabels]) {
    const { mount, calls } = await renderReal()
    await click(mount, label)
    const actions = calls.map((c) => c.action)
    assert.equal(
      actions.some((a) => SYNC_TRIGGER_ACTIONS.includes(a)),
      false,
      `按钮「${label}」触发了手动同步动作：${actions.join(',')}`
    )
    assert.equal(
      actions.includes('testConnection'),
      false,
      `shipped UI 控件「${label}」不得触达 dormant RPC testConnection`
    )
    if (actions.includes('remoteProbe')) probeFrom.push(label)
  }
  assert.deepEqual(probeFrom, ['自检'], 'remoteProbe 只能由远程组的「自检」触发，不得从同步组可达')
})

/* ========================================================================== */
/* G6a — plugin save-time precheck ordering + byte-unchanged refusal           */
/* ========================================================================== */
test('G6a: plugin prechecks before persisting; a refusal leaves settings bytes unchanged', async (t) => {
  const rpcSrc = readFileSync(rpcSrcPath, 'utf8')
  const saveBody = rpcSrc.slice(
    rpcSrc.indexOf('async function saveSettings('),
    rpcSrc.indexOf('async function testConnection(')
  )
  assert.ok(saveBody.length > 100, '找不到 saveSettings 实现')
  const preIdx = saveBody.indexOf('fetchRepoVisibility(')
  const setIdx = saveBody.indexOf('store.writeSettings(')
  const tokIdx = saveBody.indexOf('store.writeToken(')
  assert.ok(preIdx >= 0 && setIdx > preIdx && tokIdx > preIdx, '仓库可见性门禁必须先于任何落盘')
  const visibilitySrc = readFileSync(pluginVisibilitySrcPath, 'utf8')
  assert.match(visibilitySrc, /if \(visibility !== true\)\s*(?:\{\s*)?return refuse\(E_REPO_PUBLIC\)/, '只认显式 private:true')

  // One targeted runtime refusal (parity/14 vectors belong to repo-precheck.test.mjs).
  const tmpRoot = path.join(pkgDir, '.tmp')
  mkdirSync(tmpRoot, { recursive: true })
  const root = mkdtempSync(path.join(tmpRoot, 'lean-guard-precheck-'))
  const homeDir = path.join(root, 'home')
  const profileDir = path.join(root, 'profile')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '# empty\n', 'utf8')
  const { createRpcService } = await import('../dist/rpc.js')
  let probeCalls = 0
  const service = createRpcService({
    homeDir,
    profileDir,
    dshVersion: 'test-1',
    repoPrecheckFetch: async () => {
      probeCalls += 1
      return { status: 403, contentType: 'application/json', body: '{"message":"no access"}' }
    }
  })
  t.after(async () => {
    await service.dispose()
    rmSync(root, { recursive: true, force: true })
  })
  const SETTINGS = {
    repoUrl: '', platform: 'gitee', authMode: 'https', username: 'ding_haoran',
    deviceId: 'pc-a', branch: 'main', scope: { config: true, providers: true, plugins: true, mcp: true }
  }
  const settingsFile = path.join(homeDir, '.dsh', 'dots', 'settings.json')
  const seeded = await service.handleRpc({ action: 'saveSettings', settings: SETTINGS, token: null })
  assert.equal(seeded.ok, true, JSON.stringify(seeded))
  const before = readFileSync(settingsFile, 'utf8')
  const refused = await service.handleRpc({
    action: 'saveSettings', settings: { ...SETTINGS, repoUrl: GITEE_URL }, token: 'gitee_fake_token_lean_guard'
  })
  assert.equal(refused.ok, false)
  assert.equal(refused.error.code, 'E_REPO_AUTH')
  assert.equal(probeCalls, 1, '必须真的发出门禁探测')
  assert.equal(readFileSync(settingsFile, 'utf8'), before, '拒绝后 settings.json 逐字节不变')
})

/* ========================================================================== */
/* G6b — App save-side precheck ordering                                       */
/* ========================================================================== */
test('G6b: app SettingsSync checks visibility before save and never marks configured on refusal', () => {
  const src = readFileSync(appSettingsSrcPath, 'utf8')
  const saveBody = src.slice(
    src.indexOf('private async saveSettings()'),
    src.indexOf('private authBlocker()')
  )
  assert.ok(saveBody.length > 100, '找不到 SettingsSync.saveSettings')
  const checkIdx = saveBody.indexOf('repoVisibilityChecker.checkNow(')
  const saveIdx = saveBody.indexOf('settingsStore.save(')
  const configureIdx = saveBody.indexOf('this.configure()')
  assert.ok(checkIdx >= 0 && saveIdx > checkIdx, 'App 也必须先校验可见性再落盘')
  assert.ok(configureIdx > saveIdx, '只有保存成功才标记已配置')
  assert.equal(
    /if \(!verdict\.ok\)[\s\S]{0,300}?return;/.test(saveBody.slice(checkIdx, saveIdx)),
    true,
    '校验失败必须在 save 之前 return'
  )
  const model = readFileSync(appVisibilitySrcPath, 'utf8')
  assert.match(model, /if \(visibility !== true\) \{\s*return refuse\(E_REPO_PUBLIC\)/, 'App 模型仍是显式私有门槛')
})

/* ========================================================================== */
/* G7 — zero-config pairing still reachable                                    */
/* ========================================================================== */
test('G7: pairing path renders with no repo config; pairingShow only on explicit action', async () => {
  const empty = {
    settings: { repoUrl: '', hasToken: false },
    status: { running: true, probe: null, visibilityBlocked: false, lastSyncAt: null }
  }
  const { mount, calls, nodes, text, clipboardWrites: clip } = await renderReal({ state: empty })
  assert.ok(text.includes(zh['lean.status.unconfigured'].split('{')[0]), '同步组诚实显示未配置')
  assert.ok(text.includes(zh['lean.missing.url']) && text.includes(zh['lean.missing.token']))

  const remote = nodesBelow(detailsOf(nodes, 'dots-remote'))
  const selects = remote.filter((n) => n.type === 'select')
  assert.equal(selects.length, 1, '远程组方式选择不依赖仓库配置')
  assert.deepEqual(selects[0].props.children.map((o) => o.props.value), ['auto', 'tailscale', 'lan', 'ipv6'])
  assert.deepEqual(buttonsOf(remote).map((n) => textOf(n.props.children)), [
    '显示二维码', '复制配对串', '重新生成', '自检', '停止接受连接'
  ])
  assert.equal(inputsOf(remote).length, 0, '配对路径不要求先填仓库地址 / 令牌')
  assert.equal(calls.some((c) => c.action === 'pairingShow'), false, '挂载绝不触碰 pairingShow')
  assert.equal(clip.length, 0, '挂载绝不写剪贴板')
  assert.equal(/请先配置仓库|configure the repo first/i.test(text), false)

  await click(mount, '显示二维码')
  assert.ok(calls.some((c) => c.action === 'pairingShow'), '显式动作仍可取二维码')
})

/* ========================================================================== */
/* G8 — credential hygiene                                                     */
/* ========================================================================== */
test('G8: no token plaintext in tree or console; copy writes only compact DSHDOTS1 string', async () => {
  const { mount, nodes } = await renderReal()
  assert.equal(textOf(nodes).includes(REMOTE_TOKEN), false)
  assert.equal(JSON.stringify(nodes).includes(REMOTE_TOKEN), false, '任何 props 都不得含令牌明文')
  await click(mount, '复制配对串')
  assert.equal(clipboardWrites.length, 1, '复制只写一次剪贴板')
  assert.equal(clipboardWrites[0], PAIR_TEXT, '写入的是引擎的紧凑配对串')
  assert.match(clipboardWrites[0], /^DSHDOTS1\|/, '必须是 DSHDOTS1|… 格式，不是含令牌 URL / JSON')
  assert.equal(textOf(nodesOf(mount.tree)).includes(REMOTE_TOKEN), false, '复制后树仍无明文')

  const src = readFileSync(clientSrcPath, 'utf8')
  assert.equal(/\bconsole\s*\./.test(src), false, 'src/client.js 不得有任何 console 调用')
  assert.match(src, /setShown\(\{\s*qr:\s*data\.qr\s*\}/, '只保留 qr，不落地 payload / text')
  assert.equal(/setShown\(\{[^}]*\btext\b/.test(src), false)
  assert.equal(/setShown\(\{[^}]*\bpayload\b/.test(src), false)
})

/* ========================================================================== */
/* G9 — one DSH-dots entry, no second settings view                             */
/* ========================================================================== */
test('G9: single registered view; dormant SettingsPanel/RemotePanel deleted (never mountable)', async () => {
  const { registers } = await loadPanel()
  assert.equal(registers.length, 1)
  const Comp = registers[0].component
  // retarget（mod-plugin-dormant-panel-removal）：旧面板接缝连同组件已删除；shipped 接缝原样保留。
  for (const key of ['LeanSyncGroup', 'LeanRemoteGroup', 'leanInferLogin']) {
    assert.equal(typeof Comp[key], 'function', `DotsPanel.${key} 测试接缝应存在`)
  }
  assert.equal(Comp.SettingsPanel, undefined, 'dormant SettingsPanel 接缝不得复活')
  assert.equal(Comp.RemotePanel, undefined, 'dormant RemotePanel 接缝不得复活')
  const src = readFileSync(clientSrcPath, 'utf8')
  const dotsBody = src.slice(
    src.indexOf('function DotsPanel(props) {'),
    src.indexOf('// 内部测试接缝')
  )
  assert.ok(dotsBody.length > 100, '找不到 DotsPanel 实现')
  assert.match(dotsBody, /h\(LeanSyncGroup, props\)/)
  assert.match(dotsBody, /h\(LeanRemoteGroup, props\)/)
  assert.equal(/\bSettingsPanel\b/.test(dotsBody), false, 'dormant SettingsPanel 不得挂进当前视图')
  assert.equal(/\bRemotePanel\b/.test(dotsBody), false, 'dormant RemotePanel 不得挂进当前视图')
  const { nodes } = await renderReal()
  assert.equal(nodes.filter((n) => n.type === 'details').length, 2, '只有一页两组，没有第二个视图')
})
