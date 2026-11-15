/**
 * 组件级渲染回归：用「符合 React 语义」的桩渲染设置面板。
 *
 * 关键点：React 只通过 `props.children` 传 children，绝不会把 children 作为
 * 额外实参传给函数组件。旧实现用 `arguments` 取 children，导致 Card/Field
 * 的子节点全部丢失（面板只剩标题、没有任何输入控件），而当时的冒烟脚本用
 * 了非标准桩（把 children 当实参传入）所以没发现。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { defaultSettings } from '../dist/engine/settings.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgDir = path.resolve(here, '..')
const clientDist = path.join(pkgDir, 'dist', 'client.js')
const clientSrc = path.join(pkgDir, 'src', 'client.js')

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
  // 动态 import() 对同一 URL 只执行一次，所以捕获到的 ModuleLoader 配置要缓存复用。
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

function renderPanel(mod) {
  let Panel = null
  const registered = []
  const ctx = {
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : function () {}
    },
    locale: {
      register() {
        return function () {}
      },
      // 真实 DSH locale 服务是 LocaleFace：bind(ns) + getSnapshot/subscribe。
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
        registered.push(options)
        Panel = component
        return function () {}
      }
    }
  }
  mod.apply(ctx)
  assert.ok(Panel, '必须注册 settings.section 组件')
  return { tree: Panel({ t: (key) => 'T:' + key, close: function () {} }), registered }
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
  // React.Fragment 在桩里是 Symbol('Fragment')，避免和真实 React 的类型冲突。
  if (typeof node.type === 'symbol' && String(node.type).includes('Fragment')) {
    walk(node.props.children, visit)
    return
  }
  visit(node)
  walk(node.props.children, visit)
}

function textOf(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node && typeof node === 'object') return textOf(node.props && node.props.children)
  return ''
}

function collect(tree) {
  const counts = Object.create(null)
  const labels = []
  const buttonLabels = []
  const inputs = []
  const selects = []
  walk(tree, (node) => {
    counts[node.type] = (counts[node.type] || 0) + 1
    if (node.type === 'input') inputs.push(node.props)
    if (node.type === 'select') selects.push(node.props)
    if (node.type === 'label') labels.push(textOf(node.props.children))
    if (node.type === 'button') buttonLabels.push(textOf(node.props.children))
  })
  return { counts, labels, buttonLabels, inputs, selects }
}

test('client.js 与 dist/client.js 必须保持同一份内容', () => {
  assert.equal(
    readFileSync(clientDist, 'utf8'),
    readFileSync(clientSrc, 'utf8'),
    '改了 src/client.js 必须同步 dist/client.js'
  )
})

test('Card/Field 不得再用 arguments 取 children（React 不会这样传）', () => {
  const source = readFileSync(clientDist, 'utf8')
  assert.ok(
    !/Array\.prototype\.slice\.call\(arguments/.test(source),
    'Card/Field 必须读 props.children，不能用 arguments'
  )
  assert.match(source, /React\.Children\.toArray\(/)
})

test('设置面板真实渲染出仓库表单、同步范围与操作按钮', async () => {
  const { mod } = await loadClient()
  const { tree, registered } = renderPanel(mod)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, 'settings.section')
  assert.equal(registered[0].id, 'git-config-sync')
  assert.equal(registered[0].order, 70)
  assert.equal(registered[0].locale, 'git-config-sync')
  assert.equal(typeof registered[0].label, 'function')

  const { counts, labels, buttonLabels, inputs, selects } = collect(tree)

  // Card/Field 的子节点必须真的渲染出来，而不是只剩标题。
  assert.equal(counts.select, 2, '平台与认证方式两个下拉框必须渲染')
  assert.equal(counts.input, 9, '5 个文本/密码输入（含用户名） + 4 个 scope 勾选框')
  assert.equal(inputs.filter((p) => p.type === 'checkbox').length, 4, '同步范围 4 个勾选框')
  assert.equal(inputs.filter((p) => p.type === 'password').length, 1, 'Token 必须是 password')
  assert.ok(counts.button >= 8, `操作按钮至少 8 个，实际 ${counts.button}`)

  for (const key of [
    'repo.platform',
    'repo.auth',
    'repo.username',
    'repo.url',
    'repo.device',
    'repo.branch',
    'repo.token',
    'scope.config',
    'scope.providers',
    'scope.plugins',
    'scope.mcp'
  ]) {
    assert.ok(
      labels.some((label) => label.includes(`T:${key}`)),
      `缺少字段标签 ${key}（labels: ${labels.join('|')}）`
    )
  }
  for (const key of [
    'repo.save',
    'actions.test',
    'actions.push',
    'actions.preview',
    'actions.apply',
    'actions.refresh'
  ]) {
    assert.ok(
      buttonLabels.some((label) => label.includes(`T:${key}`)),
      `缺少按钮 ${key}（buttons: ${buttonLabels.join('|')}）`
    )
  }

  // 下拉选项来自 host 枚举：平台 3 项、认证方式 2 项。
  const optionCounts = selects
    .map((select) => {
      const kids = Array.isArray(select.children) ? select.children : [select.children]
      return kids.filter((kid) => kid && kid.type === 'option').length
    })
    .sort()
  assert.deepEqual(optionCounts, [2, 3], '认证方式 2 项、平台 3 项')
})

test('卡片字段默认值与 host settings 定义一致（平台/认证/分支/范围）', async () => {
  const host = defaultSettings()
  const { mod } = await loadClient()
  const { tree } = renderPanel(mod)
  const { inputs, selects } = collect(tree)

  const selected = selects.map((select) => select.value).sort()
  assert.deepEqual(selected, [host.authMode, host.platform].sort(), '平台/认证默认值必须与 host 一致')

  const textValues = inputs.filter((input) => input.type !== 'checkbox').map((input) => input.value)
  assert.ok(textValues.includes(host.repoUrl), 'repoUrl 默认值必须与 host 一致（空串）')
  assert.ok(textValues.includes(host.branch), 'branch 默认值必须与 host 一致（main）')

  const checked = inputs.filter((input) => input.type === 'checkbox').map((input) => input.checked)
  assert.deepEqual(checked, [true, true, true, true], 'scope 四项默认全选')
  assert.deepEqual(
    Object.keys(host.scope).sort(),
    ['config', 'mcp', 'plugins', 'providers'],
    'host scope 字段必须与卡片四个勾选框一一对应'
  )
})
