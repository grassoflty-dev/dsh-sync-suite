/**
 * mod-plugin-remote-hints-mode-keyed：远程控制「方式提示」按方式唯一。
 *
 * 复用 pairing-client-wiring.test.mjs / client-remote-render.test.mjs 同款有状态 React 桩 +
 * fetch 桩（宿主只传 { t, close }，无种子），不另造渲染器。钉住四件事：
 *   1. select 的四个可选项各自只渲染自己的一句提示；
 *   2. 渲染出的提示不得包含别的方式的整句要求；
 *   3. none = 唯一推荐动作，fallback = 中性兜底，二者都不拼接多种方式的前提；
 *   4. 新增 key 在 client.js 内置 zh/en 与 locale/{zh,en}.json 四处都在且逐字一致。
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

/* -------------------------------------------------------------------------- */
/* 有状态 React 桩（与 pairing-client-wiring.test.mjs 同款）                    */
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
      await import(pathToFileURL(clientDist).href + '?remote-hints-mode-keyed=' + Date.now())
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
const dataText = (tree, key) => nodesOf(tree).filter((n) => n.props && n.props['data-lean'] === key).map(textOf).join('\n')
const settle = async () => { for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setTimeout(resolve, 5)) }

const translate = (key, vars) => {
  let out = zh[key] || key
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.replace('{' + k + '}', v)
  return out
}

/** selected 原样注入 pairingTransports，覆盖 auto / 四方式 / none / 未知值。 */
async function renderWithSelected(selected) {
  const Panel = await loadPanel()
  globalThis.fetch = async function (_url, options) {
    const body = JSON.parse(options.body)
    const data = body.action === 'pairingProvision'
      ? {
          view: { v: 1, instanceId: 'gwl-pc', transport: 'lan', host: '192.168.1.6', port: 44996, tlsFingerprint: 'AA:BB', announceRef: '', token: 'present' },
          changed: { port: false, token: false, cert: false }, republish: null
        }
      : body.action === 'pairingTransports'
        ? { selected, selectedHost: '', overrideUnavailable: false, candidates: {}, reasonLines: [], tls: false }
        : body.action === 'pairingConnections'
          ? []
          : { settings: { mode: 'lan' }, status: { running: false, probe: null }, modes: [] }
    return { status: 200, async text() { return JSON.stringify({ ok: true, data }) } }
  }
  activeMount = mountPanel(Panel, { t: translate, close() {} })
  activeMount.render()
  await settle()
  return activeMount.tree
}

/* -------------------------------------------------------------------------- */
/* 期望值：表条目 → 字典 key（与 src/client.js 的 LEAN_MODE_HINT_KEYS 对拍）      */
/* -------------------------------------------------------------------------- */

const MODES = {
  auto: 'lean.remote.hint.auto',
  tailscale: 'lean.remote.hint.tailscale',
  lan: 'lean.remote.hint.lan',
  ipv6: 'lean.remote.hint.ipv6',
  none: 'lean.remote.transport.none',
  fallback: 'lean.remote.hint.fallback'
}
const MODE_KEYS = Object.keys(MODES)
const zhSentence = (mode) => zh[MODES[mode]]
const enSentence = (mode) => en[MODES[mode]]

function assertNoForeignSentences(text, ownMode, dict = zh) {
  for (const other of MODE_KEYS) {
    if (other === ownMode) continue
    const foreign = dict[MODES[other]]
    assert.equal(text.includes(foreign), false, `「${ownMode}」提示不得包含「${other}」的整句要求：${foreign}`)
  }
}

/* -------------------------------------------------------------------------- */
/* 1) 纯查表接缝                                                                */
/* -------------------------------------------------------------------------- */

test('T1：纯查表接缝存在，表恰好 6 行（四可选项 + none + fallback），无 uu / manual', async () => {
  const Panel = await loadPanel()
  assert.equal(typeof Panel.leanModeHint, 'function')
  assert.equal(typeof Panel.leanModeHintKey, 'function')
  assert.deepEqual(Object.keys(Panel.LEAN_MODE_HINT_KEYS).sort(), ['auto', 'fallback', 'ipv6', 'lan', 'none', 'tailscale'])
  for (const dead of ['uu', 'manual', 'cloudflare']) {
    assert.equal(Object.hasOwn(Panel.LEAN_MODE_HINT_KEYS, dead), false, `表不得虚构 ${dead} 方式`)
  }
  assert.deepEqual(Panel.LEAN_MODE_HINT_KEYS, MODES)
})

test('T2：查表命中唯一一行；空串→none，未知值→fallback，原型键也走 fallback', async () => {
  const Panel = await loadPanel()
  for (const mode of MODE_KEYS) {
    assert.equal(Panel.leanModeHintKey(mode), MODES[mode], `${mode} 必须命中自己的 key`)
    assert.equal(Panel.leanModeHint(mode, translate), zhSentence(mode), `${mode} 必须返回自己的一句文案`)
  }
  assert.equal(Panel.leanModeHintKey(''), MODES.none, '未检测到传输 = none')
  for (const unknown of ['bogus', 'constructor', '__proto__', 'UU', undefined, null, 42]) {
    assert.equal(Panel.leanModeHintKey(unknown), MODES.fallback, `未知值 ${String(unknown)} 必须走 fallback`)
  }
})

test('T3：任意两行互不把对方整句要求当子串（zh + en）', () => {
  for (const dict of [zh, en]) {
    const pick = (mode) => dict[MODES[mode]]
    for (const a of MODE_KEYS) {
      for (const b of MODE_KEYS) {
        if (a === b) continue
        assert.equal(pick(a).includes(pick(b)), false, `${a} 不得包含 ${b} 的整句：${pick(b)}`)
      }
    }
  }
})

/* -------------------------------------------------------------------------- */
/* 2) 渲染：每个 selectable 方式只显示自己的句子                                  */
/* -------------------------------------------------------------------------- */

test('R1：四个可选项各自渲染自己的句子，且不含别的方式的整句要求', async () => {
  for (const mode of ['auto', 'tailscale', 'lan', 'ipv6']) {
    const tree = await renderWithSelected(mode)
    const text = dataText(tree, 'remote-transport')
    assert.equal(text, zhSentence(mode), `${mode} 的 remote-transport 必须恰好是自己的一句`)
    assertNoForeignSentences(text, mode)
    // 下拉真实集合不引入 uu / manual。
    const select = nodesOf(tree).find((n) => n.type === 'select')
    assert.deepEqual(select.props.children.map((o) => o.props.value), ['auto', 'tailscale', 'lan', 'ipv6'])
  }
})

test('R2：未知方式值 → 中性 fallback，不拼接任何模式句子', async () => {
  const tree = await renderWithSelected('unknown-mode')
  const text = dataText(tree, 'remote-transport')
  assert.equal(text, zhSentence('fallback'), '未知值必须显示中性兜底句')
  assertNoForeignSentences(text, 'fallback')
  for (const mode of ['auto', 'tailscale', 'lan', 'ipv6', 'none']) {
    assert.equal(text.includes(zhSentence(mode)), false, `fallback 不得含 ${mode} 的整句`)
  }
})

test('R3：none → 只给唯一推荐动作（Tailscale），不含任何方式的整句要求', async () => {
  const tree = await renderWithSelected(null)
  const text = dataText(tree, 'remote-transport')
  assert.equal(text, zhSentence('none'))
  assertNoForeignSentences(text, 'none')
  assert.equal(text.includes('推荐先登录 Tailscale'), true, '唯一推荐动作 = Tailscale')
  assert.equal(text.includes('Wi-Fi'), false, '不得再并列 Wi-Fi 前提')
  assert.equal((text.match(/Tailscale/g) || []).length, 1, 'Tailscale 只出现一次（单一动作）')
  assert.equal(text.includes('请先连同一 Wi-Fi，或登录 Tailscale'), false, '旧并列句必须消失')
})

test('R4：honesty 行保留且独立于方式提示（tls=false 的 lan 仍显示明文警告）', async () => {
  const tree = await renderWithSelected('lan')
  const honesty = dataText(tree, 'remote-transport-honesty')
  assert.equal(honesty, zh['lean.remote.transport.plaintext'], '明文警告不被方式表吞掉')
  assert.equal(honesty.includes(zhSentence('lan')), false, 'honesty 与方式提示是两种不同事实')
})

/* -------------------------------------------------------------------------- */
/* 3) zh / en 字典四处 parity                                                    */
/* -------------------------------------------------------------------------- */

/** 与 locale.test.mjs 同款括号配平扫描，取 client.js 内置字典字面量。 */
function readClientDicts(source) {
  const pick = (name) => {
    const start = source.indexOf(`const ${name} = {`)
    assert.ok(start >= 0, `找不到 const ${name} = {`)
    const open = source.indexOf('{', start)
    let depth = 0
    let i = open
    let inString = false
    let quote = ''
    for (; i < source.length; i += 1) {
      const ch = source[i]
      if (inString) {
        if (ch === '\\') { i += 1; continue }
        if (ch === quote) inString = false
        continue
      }
      if (ch === '"' || ch === "'" || ch === '`') { inString = true; quote = ch; continue }
      if (ch === '{') depth += 1
      else if (ch === '}') {
        depth -= 1
        if (depth === 0) { i += 1; break }
      }
    }
    return new Function(`return (${source.slice(open, i)})`)()
  }
  return { zh: pick('zh'), en: pick('en') }
}

test('P1：每个新增 key 在 client.js 内置 zh/en 与 locale/zh.json / locale/en.json 四处逐字一致', () => {
  const client = readClientDicts(readFileSync(clientSrc, 'utf8'))
  const shipped = [client.zh, client.en, zh, en]
  const newKeys = ['lean.remote.hint.auto', 'lean.remote.hint.tailscale', 'lean.remote.hint.lan', 'lean.remote.hint.ipv6', 'lean.remote.hint.fallback']
  for (const key of newKeys) {
    for (const dict of shipped) {
      assert.equal(typeof dict[key], 'string', `缺少 key ${key}`)
      assert.ok(dict[key].trim().length > 0, `${key} 不得为空`)
    }
    assert.equal(client.zh[key], zh[key], `client.zh.${key} 与 locale/zh.json 不一致`)
    assert.equal(client.en[key], en[key], `client.en.${key} 与 locale/en.json 不一致`)
  }
  // none 是改值而非加 key：zh 两处同值、en 两处同值。
  assert.equal(client.zh['lean.remote.transport.none'], zh['lean.remote.transport.none'])
  assert.equal(client.en['lean.remote.transport.none'], en['lean.remote.transport.none'])
  assert.notEqual(zh['lean.remote.transport.none'], en['lean.remote.transport.none'])
})

test('P2：zh 句子是中文、en 句子是英文，且 none/fallback 在中英两侧都是单句', () => {
  for (const mode of MODE_KEYS) {
    assert.match(zhSentence(mode), /[\u4e00-\u9fff]/, `${mode} 的 zh 文案必须是中文`)
    assert.match(enSentence(mode), /^[A-Za-z0-9\[\]:.,;/()' -]+$/, `${mode} 的 en 文案必须是英文`)
    assert.notEqual(zhSentence(mode), enSentence(mode))
  }
  for (const dict of [zh, en]) {
    for (const mode of ['none', 'fallback']) {
      assert.equal(dict[MODES[mode]].endsWith('。') || dict[MODES[mode]].endsWith('.'), true, `${mode} 必须是一句完整句子`)
    }
  }
})
