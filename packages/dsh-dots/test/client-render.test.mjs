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

function renderPanel(mod, which) {
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
  // 只挂载注册的 shipped DotsPanel（旧 dormant 面板已删除）。
  const target = which && Panel[which] ? Panel[which] : Panel
  return { tree: target({ t: (key) => 'T:' + key, close: function () {} }), registered }
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

/** 从合并后的单页里取出指定 id 的折叠分组（证明控件在同一页内，而不是第二个 section）。 */
function groupOf(tree, id) {
  const found = []
  walk(tree, (node) => {
    if (node.type === 'details' && node.props.id === id) found.push(node)
  })
  assert.equal(found.length, 1, `单页里必须恰好有一个 id=${id} 的折叠分组`)
  return found[0]
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


test('merged panel：同步组精简为地址/令牌/状态/一个动作（旧断言 retarget，旧能力 UI-dormant）', async () => {
  const { mod } = await loadClient()
  const { tree, registered } = renderPanel(mod)
  assert.equal(registered.length, 1, '只允许一个 settings.section')
  const group = groupOf(tree, 'dots')
  assert.equal(group.props.open, true, '同步组默认展开')
  assert.ok(textOf(group.props.children).includes('T:group.sync'), '页内分组标题必须取 group.sync（配置同步）')

  const { counts, labels, buttonLabels, inputs } = collect(group.props.children)
  // retarget：原「2 个下拉 / 9 个输入 / 4 个复选框 / ≥8 按钮」改为精简面板的精确上限。
  assert.equal(counts.select || 0, 0, '同步组不再有平台 / 认证方式下拉')
  assert.equal(counts.input, 2, '同步组只有仓库地址 + 访问令牌两个输入')
  assert.deepEqual(inputs.map((p) => p.type), ['text', 'password'])
  assert.equal(inputs.filter((p) => p.type === 'checkbox').length, 0, '同步范围复选框已删除入口')
  assert.deepEqual(buttonLabels, ['T:lean.actions.save'], '只剩 保存（测试连接按钮已按 Lead 决定删除）')

  for (const key of ['lean.repo.url', 'lean.repo.token']) {
    assert.ok(labels.some((label) => label.includes(`T:${key}`)), `合并后缺少字段 ${key}`)
  }
  const statusNodes = []
  walk(group.props.children, (node) => {
    if (node.props && node.props['data-lean'] === 'sync-status') statusNodes.push(node)
  })
  assert.equal(statusNodes.length, 1, '合并后同步组只有一条状态行')

  // 被删控件一个都不许回来（旧断言逐项 retarget 成负向守卫，不是删掉）。
  // 本桩的 t 返回 T:<key>，所以用「标签 + 按钮 + 输入类型」做精确判据。
  const rendered = labels.concat(buttonLabels).join('|')
  for (const dead of ['T:scope.', 'T:repo.platform', 'T:repo.auth', 'T:repo.branch', 'T:repo.device',
    'T:actions.preview', 'T:actions.apply', 'T:actions.rollbackLatest', 'T:plugins.', 'T:snapshots.']) {
    assert.equal(rendered.includes(dead), false, `已删除入口「${dead}」不得复现`)
  }
  // 远程组必须和同步组同处一个面板，而不是另一个 section。
  assert.ok(groupOf(tree, 'dots-remote'), '远程控制分组必须在同一个单页内')
})
