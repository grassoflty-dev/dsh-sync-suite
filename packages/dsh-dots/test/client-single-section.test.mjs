/**
 * 「内置插件只有一个条目」护栏测试（中文注释）。
 *
 * 失败背景：client.js 曾注册两个 settings.section（dots / dots-remote），
 * 「内置插件」因此列出「配置同步」「远程控制」两行。现在全插件只注册一个
 * settings.section（label = DSH-dots），两种能力作为同一页内的两个折叠分组存在。
 *
 * 本文件同时守住四套命名空间，防止有人"顺手改名"：
 *   loader id = dsh-dots（来自 package.json.name）
 *   唯一 section slot id = dots；页内分组 id = dots-remote（不得再注册 section）
 *   locale NS = dots；RPC 路径 = /dsh-dots/rpc
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distPath = path.join(pkgDir, 'dist', 'client.js')
const builtText = readFileSync(distPath, 'utf8')
const zh = JSON.parse(readFileSync(path.join(pkgDir, 'locale', 'zh.json'), 'utf8'))

const matches = (text, re) => (text.match(re) || []).length

/* ------------------------------------------------------------------ */
/* 静态断言：构建产物里的注册数量与文案                                  */
/* ------------------------------------------------------------------ */

test('dist/client.js 只注册一个 settings.section', () => {
  assert.equal(
    matches(builtText, /ctx\.slots\.inject\('settings\.section'/g),
    1,
    'ctx.slots.inject(settings.section) 必须恰好一次'
  )
  assert.equal(
    matches(builtText, /name:\s*'settings\.section'/g),
    1,
    "name: 'settings.section' 必须恰好一次"
  )
  assert.match(
    builtText,
    /name:\s*'settings\.section',\s*\n\s*id:\s*'dots',\s*\n\s*order:\s*70/,
    '唯一 section 必须是 id=dots / order=70'
  )
})

test('单一条目标题 DSH-dots 与两个页内分组标题都在', () => {
  assert.match(builtText, /"panel\.title": "DSH-dots"/, '内置：`panel.title` 必须是 DSH-dots')
  assert.equal(zh['panel.title'], 'DSH-dots', 'locale/zh.json 的单一条目名必须是 DSH-dots')
  assert.match(builtText, /"group\.sync": "配置同步"/, '必须保留「配置同步」分组标题')
  assert.match(builtText, /"group\.remote": "远程控制"/, '必须保留「远程控制」分组标题')
  assert.equal(zh['group.sync'], '配置同步')
  assert.equal(zh['group.remote'], '远程控制')
  assert.match(
    builtText,
    /label: function \(\) \{\s*\n\s*return t\('panel\.title'\)/,
    'section label 必须取单一条目名，不得取 nav / remote.nav'
  )
})

test('dots-remote 不再是 section 注册，只保留为页内折叠分组 id', () => {
  assert.doesNotMatch(
    builtText,
    /name:\s*'settings\.section',\s*\n\s*id:\s*'dots-remote'/,
    'dots-remote 绝不能再注册 settings.section'
  )
  assert.equal(
    matches(builtText, /id:\s*'dots-remote'/g),
    1,
    "id: 'dots-remote' 只能出现一次（页内分组）"
  )
  assert.match(
    builtText,
    /'details',\s*\n\s*\{\s*id:\s*'dots-remote',\s*open:\s*true/,
    'dots-remote 必须只作为同一页内默认展开的 details 分组 id'
  )
})

test('loader id 仍是 dsh-dots（与包名一致）', () => {
  assert.match(
    builtText,
    /\bwindow\.__ModuleLoader__\.load\(\{\s*\n\s*id:\s*'dsh-dots'/,
    'loader id 必须仍是 dsh-dots'
  )
  assert.match(builtText, /const RPC_PATH = '\/dsh-dots\/rpc'/, 'RPC 路径不得改名')
  assert.match(builtText, /const NS = 'dots'/, 'locale NS 不得改名')
})

/* ------------------------------------------------------------------ */
/* 运行时断言：apply(ctx) 的注册结果 + 单页结构                          */
/* ------------------------------------------------------------------ */

function flatten(list, out) {
  for (const item of list) {
    if (Array.isArray(item)) flatten(item, out)
    else if (item !== null && item !== undefined && item !== false && item !== true) out.push(item)
  }
  return out
}

function makeFakeReact() {
  const Fragment = Symbol('Fragment')
  return {
    Fragment,
    createElement(type, props, ...children) {
      const next = Object.assign({}, props || {})
      const kids = flatten(children, [])
      if (kids.length === 1) next.children = kids[0]
      else if (kids.length > 1) next.children = kids
      return { type, props: next }
    },
    useState(init) { return [typeof init === 'function' ? init() : init, function () {}] },
    useRef(value) { return { current: value } },
    useEffect() {},
    useMemo(fn) { return fn() },
    useCallback(fn) { return fn },
    Children: { toArray(value) { return flatten(Array.isArray(value) ? value : [value], []) } }
  }
}

let loadedPromise = null
async function loadClient() {
  if (!loadedPromise) {
    loadedPromise = (async () => {
      let captured = null
      globalThis.window = {
        __ModuleLoader__: { load(cfg) { captured = cfg } }
      }
      await import(pathToFileURL(distPath).href + '?single-section=' + Date.now())
      assert.ok(captured, 'client.js 必须调用 window.__ModuleLoader__.load')
      const react = makeFakeReact()
      const mod = captured.factory((id) => {
        if (id === 'react') return react
        throw new Error(`unexpected require: ${id}`)
      })
      return mod
    })()
  }
  return loadedPromise
}

function applyAndCapture(mod) {
  const sections = []
  const ctx = {
    effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : function () {} },
    locale: {
      register() { return function () {} },
      bind() { return function (key) { return key } }
    },
    slots: {
      inject(name, cb) {
        assert.equal(name, 'settings.section', '本插件只注入 settings.section 一个 slot')
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

test('运行时：只注册一个 section，label 为 DSH-dots', async () => {
  const mod = await loadClient()
  const sections = applyAndCapture(mod)
  assert.equal(sections.length, 1, '运行时必须只有一个 settings.section')
  assert.equal(sections[0].options.id, 'dots')
  assert.equal(sections[0].options.label(), 'DSH-dots')
})

test('运行时：单页里两组都在，dots-remote 只是页内分组 id', async () => {
  const mod = await loadClient()
  const [section] = applyAndCapture(mod)
  const tree = section.component({ t: (key) => zh[key] || key, close() {} })

  const groups = []
  const summaries = []
  const sectionIds = []
  walk(tree, (node) => {
    if (node.type === 'details') groups.push(node)
    if (node.type === 'summary') summaries.push(textOf(node))
    if (node.type === 'button') sectionIds.push(node.props.id)
  })
  assert.deepEqual(
    groups.map((node) => node.props.id),
    ['dots', 'dots-remote'],
    '一页内两个分组：dots 与 dots-remote'
  )
  assert.ok(groups.every((node) => node.props.open === true), '两组默认展开，控件首屏可达')
  assert.ok(summaries.includes('配置同步'), '缺少「配置同步」分组标题')
  assert.ok(summaries.includes('远程控制'), '缺少「远程控制」分组标题')
  assert.equal(sectionIds.filter(Boolean).length, 0, '不得出现第二个 section 的 UI 入口')
  assert.ok(section.component.SettingsPanel, '同步面板必须仍可单独挂载')
  assert.ok(section.component.RemotePanel, '远程面板必须仍可单独挂载')
})
