/**
 * 差异预览（previewDiff）+ 回滚两步确认（rollbackPreview → rollback）的回归测试。
 *
 * 覆盖三块：
 *   1. RPC 只读性：previewDiff / rollbackPreview 不建快照、不写 profile、不写 state.json；
 *   2. fail-closed：provider 目录缺失 / 快照不存在 / manifest sha 不匹配 → `{ok:false}` + 中文原因，
 *      且 `rollback` 的 confirm 门禁保持原样（回归）；
 *   3. 客户端渲染回归已随 mod-plugin-dormant-panel-removal 删除（它只挂载 dormant SettingsPanel）；
 *      本文件保留的 RPC 只读性 / fail-closed / confirm 门禁断言一字未动。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { repoHash } from '../dist/engine/paths.js'
import { SnapshotStore } from '../dist/engine/snapshot.js'
import { createRpcService } from '../dist/rpc.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgDir = path.resolve(here, '..')
const clientDist = path.join(pkgDir, 'dist', 'client.js')

const PATCH_V1 = `# profile patch
- id: alpha
  config:
    value: 1
- id: beta
  config:
    value: 2
`

const PATCH_V2 = `# profile patch
- id: alpha
  config:
    value: 1
- id: beta
  config:
    value: 22
`

const CHINESE_RE = /[\u4e00-\u9fff]/

function snapshotDirCount(root) {
  if (!existsSync(root)) return 0
  return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length
}

async function setup(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'gcs-rollback-ux-'))
  const homeDir = path.join(root, 'home')
  const profileDir = path.join(root, 'profile')
  await mkdir(profileDir, { recursive: true })
  const patchFile = path.join(profileDir, 'cordis.patch.yml')
  await writeFile(patchFile, options.patch === undefined ? PATCH_V1 : options.patch, 'utf8')
  const service = createRpcService({ homeDir, profileDir, dshVersion: 'test-1', allowLocalRepo: true })
  t.after(async () => {
    await service.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  })
  return { root, homeDir, profileDir, patchFile, service }
}

async function configure(service, profileDir, overrides = {}) {
  const result = await service.handleRpc({
    action: 'saveSettings',
    settings: {
      repoUrl: overrides.repoUrl ?? 'https://example.invalid/u/r.git',
      platform: 'github',
      authMode: 'https',
      deviceId: 'pc-a',
      branch: 'main',
      scope: { config: true, providers: true, plugins: true, mcp: true },
    },
  })
  return result
}

/* -------------------------------------------------------------------------- */
/* 1. previewDiff 的只读性与 fail-closed                                       */
/* -------------------------------------------------------------------------- */

test('previewDiff：未配置仓库 → 中文错误，且不创建任何快照 / 工作副本', async (t) => {
  const { patchFile, service } = await setup(t)
  const before = await readFile(patchFile)
  const result = await service.handleRpc({ action: 'previewDiff' })
  assert.equal(result.ok, false, '未配置仓库时必须失败，不能返回空差异')
  assert.equal(result.error.code, 'E_VALIDATION')
  assert.match(result.error.message, CHINESE_RE)
  assert.match(result.error.message, /尚未配置仓库地址/)
  assert.deepEqual(await readFile(patchFile), before, '只读动作不得改动 profile')
  assert.equal(snapshotDirCount(service.paths.snapshotRoot), 0, '不得创建快照')
  assert.equal(existsSync(service.paths.workRoot), false, '不得创建本地工作副本目录')
})

test('previewDiff：profile 目录不存在 → E_NOT_FOUND 中文错误，快照数不变', async (t) => {
  const { profileDir, service } = await setup(t)
  const saved = await configure(service, profileDir)
  assert.equal(saved.ok, true)
  await rm(profileDir, { recursive: true, force: true })

  const result = await service.handleRpc({ action: 'previewDiff' })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'E_NOT_FOUND')
  assert.match(result.error.message, CHINESE_RE)
  assert.match(result.error.message, /profile 目录不存在/)
  assert.equal(snapshotDirCount(service.paths.snapshotRoot), 0)
})

test('previewDiff（本机）：真文件级差异，且只读（快照数 / profile 字节都不变）', async (t) => {
  const { profileDir, patchFile, service } = await setup(t, { patch: PATCH_V2 })
  const repoUrl = 'C:\\fake-local-repo\\dsh.git'
  const saved = await configure(service, profileDir, { repoUrl })
  assert.equal(saved.ok, true)

  const deviceDir = path.join(service.paths.workRoot, repoHash(repoUrl), 'devices', 'pc-a')
  await mkdir(deviceDir, { recursive: true })
  await writeFile(path.join(deviceDir, 'cordis.patch.yml'), PATCH_V1, 'utf8')
  await writeFile(path.join(deviceDir, 'providers.json'), '{"providers":{}}\n', 'utf8')
  await writeFile(path.join(deviceDir, 'plugins.json'), '', 'utf8')
  await writeFile(path.join(deviceDir, 'mcp.json'), '', 'utf8')

  const beforeBytes = readFileSync(patchFile)
  const snapshotsBefore = snapshotDirCount(service.paths.snapshotRoot)

  const result = await service.handleRpc({ action: 'previewDiff' })
  assert.equal(result.ok, true)
  assert.equal(result.data.local, true, '缺省 sourceDevice 表示本机')
  assert.equal(result.data.sourceDevice, 'pc-a')
  assert.equal(result.data.summary.totals.modified >= 1, true, '当前 patch 与工作副本不同 → 至少一个文件 modified')
  const patchStat = result.data.summary.files.find((file) => file.path === 'cordis.patch.yml')
  assert.ok(patchStat !== undefined, '必须报告 cordis.patch.yml 的差异')
  assert.equal(patchStat.kind, 'modified')
  assert.equal(patchStat.addedLines, 1, 'value: 2 → value: 22 是一行替换')
  assert.equal(patchStat.removedLines, 1)
  assert.ok(result.data.hunks.length >= 1, '修改过的文件必须给出 hunk')
  assert.equal(result.data.hunks[0].path, 'cordis.patch.yml')
  assert.ok(result.data.hunks[0].lines.some((line) => line.startsWith('+')), 'hunk 必须包含新增行')
  assert.ok(result.data.hunks[0].lines.some((line) => line.startsWith('-')), 'hunk 必须包含删除行')

  assert.deepEqual(readFileSync(patchFile), beforeBytes, 'previewDiff 不得写 profile')
  assert.equal(snapshotDirCount(service.paths.snapshotRoot), snapshotsBefore, 'previewDiff 不得创建快照')
})

test('previewDiff：给了不存在的远端设备 → E_NOT_FOUND 中文错误且不写 state.json', async (t) => {
  const { profileDir, service } = await setup(t)
  await configure(service, profileDir, { repoUrl: 'https://example.invalid/u/r.git' })
  const stateFile = service.paths.stateFile
  const before = existsSync(stateFile) ? readFileSync(stateFile) : null

  const result = await service.handleRpc({ action: 'previewDiff', sourceDevice: 'pc-z' })
  assert.equal(result.ok, false, '远端不可达 / 无快照时必须失败')
  assert.equal(result.error.code, 'E_GIT', `远端读取失败应为 E_GIT，实际 ${result.error.code}: ${result.error.message}`)
  assert.match(result.error.message, CHINESE_RE)
  assert.equal(snapshotDirCount(service.paths.snapshotRoot), 0)
  const after = existsSync(stateFile) ? readFileSync(stateFile) : null
  assert.deepEqual(after, before, '不存在的设备不得写 state.json（不记录探测结果）')
})

/* -------------------------------------------------------------------------- */
/* 2. rollbackPreview：fail-closed 与文件级分类                                 */
/* -------------------------------------------------------------------------- */

test('rollbackPreview：快照不存在 → E_NOT_FOUND；id 非法 → E_VALIDATION', async (t) => {
  const { service } = await setup(t)
  const missing = await service.handleRpc({ action: 'rollbackPreview', snapshotId: '20260101-000000' })
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'E_NOT_FOUND')
  assert.match(missing.error.message, CHINESE_RE)
  assert.equal(missing.error.details.snapshotId, '20260101-000000')

  const invalid = await service.handleRpc({ action: 'rollbackPreview', snapshotId: '../etc/passwd' })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.error.code, 'E_VALIDATION')

  const empty = await service.handleRpc({ action: 'rollbackPreview' })
  assert.equal(empty.ok, false)
  assert.equal(empty.error.code, 'E_VALIDATION')
})

test('rollbackPreview：快照里的文件 vs 当前文件 → added / modified / deleted / same 标注正确', async (t) => {
  const { profileDir, patchFile, service } = await setup(t, { patch: PATCH_V2 })
  // 当前 profile：cordis.patch.yml（会被改）、plugins.json（同快照）、mcp.json（快照没有）
  const plugins = '{"plugins":[]}\n'
  const mcp = '{"entries":[]}\n'
  const pluginsFile = path.join(profileDir, 'plugins.json')
  const mcpFile = path.join(profileDir, 'mcp.json')
  await writeFile(pluginsFile, plugins, 'utf8')
  await writeFile(mcpFile, mcp, 'utf8')

  const store = new SnapshotStore(service.paths.snapshotRoot)
  const meta = store.create(
    'pre-apply:pc-b',
    {
      'cordis.patch.yml': PATCH_V1,
      'providers.json': '{"providers":{"p1":{}}}\n',
      'plugins.json': plugins,
    },
    { note: 'unit-test' },
  )

  const beforeBytes = {
    patch: readFileSync(patchFile),
    plugins: readFileSync(pluginsFile),
    mcp: readFileSync(mcpFile),
  }
  const snapshotsBefore = snapshotDirCount(service.paths.snapshotRoot)

  const result = await service.handleRpc({ action: 'rollbackPreview', snapshotId: meta.id })
  assert.equal(result.ok, true)
  assert.equal(result.data.snapshotId, meta.id)
  assert.equal(result.data.reason, 'pre-apply:pc-b')
  assert.equal(typeof result.data.createdAt, 'string')
  assert.ok(!Number.isNaN(Date.parse(result.data.createdAt)), 'createdAt 必须是可解析的时间')

  const kinds = Object.fromEntries(result.data.files.map((file) => [file.path, file.kind]))
  assert.equal(kinds['cordis.patch.yml'], 'modified', '两侧都有且内容不同 → modified')
  assert.equal(kinds['providers.json'], 'added', '快照有、当前没有 → added')
  assert.equal(kinds['plugins.json'], 'same', '内容一致 → same')
  assert.equal(kinds['mcp.json'], 'deleted', '当前有、快照没有 → deleted')
  assert.equal(result.data.summary.totals.added, 1)
  assert.equal(result.data.summary.totals.modified, 1)
  assert.equal(result.data.summary.totals.deleted, 1)
  assert.equal(result.data.summary.totals.same, 1)
  assert.deepEqual(result.data.willRestore, [path.join(profileDir, 'cordis.patch.yml')], '回滚只写 profile patch')

  // 逐字节比较：预览后 profile 一个字都没改。
  assert.deepEqual(readFileSync(patchFile), beforeBytes.patch)
  assert.deepEqual(readFileSync(pluginsFile), beforeBytes.plugins)
  assert.deepEqual(readFileSync(mcpFile), beforeBytes.mcp)
  assert.equal(snapshotDirCount(service.paths.snapshotRoot), snapshotsBefore, 'rollbackPreview 不得创建快照')
  const patched = result.data.files.find((file) => file.path === 'cordis.patch.yml')
  assert.equal(patched.addedLines, 1)
  assert.equal(patched.removedLines, 1)
  assert.ok(patched.beforeBytes > 0 && patched.afterBytes > 0)
})

test('rollbackPreview：manifest sha256 与快照文件不一致 → E_SHA_MISMATCH，不写 profile', async (t) => {
  const { profileDir, patchFile, service } = await setup(t, { patch: PATCH_V2 })
  const store = new SnapshotStore(service.paths.snapshotRoot)
  const meta = store.create('pre-apply:pc-b', { 'cordis.patch.yml': PATCH_V1 })
  // 篡改快照文件内容（manifest 里的 sha256 仍是旧的）→ 必须 fail-closed。
  writeFileSync(path.join(service.paths.snapshotRoot, meta.id, 'files', 'cordis.patch.yml'), '# tampered\n', 'utf8')

  const before = readFileSync(patchFile)
  const result = await service.handleRpc({ action: 'rollbackPreview', snapshotId: meta.id })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'E_SHA_MISMATCH')
  assert.match(result.error.message, CHINESE_RE)
  assert.deepEqual(readFileSync(patchFile), before, '校验失败不得写任何文件')
  assert.equal(snapshotDirCount(service.paths.snapshotRoot), 1)
  assert.ok(existsSync(path.join(profileDir, 'cordis.patch.yml')))
})

/* -------------------------------------------------------------------------- */
/* 3. rollback 门禁回归 + 两步流程端到端                                        */
/* -------------------------------------------------------------------------- */

test('rollback：没有 confirm:true 仍然 E_CONFIRM_REQUIRED（门禁未放宽）', async (t) => {
  const { patchFile, service } = await setup(t, { patch: PATCH_V2 })
  const store = new SnapshotStore(service.paths.snapshotRoot)
  const meta = store.create('pre-apply:pc-b', { 'cordis.patch.yml': PATCH_V1 })
  const before = readFileSync(patchFile)

  for (const extra of [{}, { confirm: false }, { confirm: 'true' }, { confirm: 1 }]) {
    const result = await service.handleRpc({ action: 'rollback', snapshotId: meta.id, ...extra })
    assert.equal(result.ok, false, JSON.stringify(extra))
    assert.equal(result.error.code, 'E_CONFIRM_REQUIRED', JSON.stringify(extra))
    assert.equal(result.error.details.action, 'rollback')
  }
  assert.deepEqual(readFileSync(patchFile), before, '门禁失败不得写文件')
  assert.equal(snapshotDirCount(service.paths.snapshotRoot), 1, '门禁失败不得创建回滚前快照')

  // 预览不受 confirm 门禁影响（只读）。
  const preview = await service.handleRpc({ action: 'rollbackPreview', snapshotId: meta.id })
  assert.equal(preview.ok, true)
  assert.deepEqual(readFileSync(patchFile), before)
})

test('两步流程：rollbackPreview → rollback {confirm:true}，写入内容与快照一致', async (t) => {
  const { patchFile, service } = await setup(t, { patch: PATCH_V2 })
  const store = new SnapshotStore(service.paths.snapshotRoot)
  const meta = store.create('pre-apply:pc-b', { 'cordis.patch.yml': PATCH_V1 })

  const preview = await service.handleRpc({ action: 'rollbackPreview', snapshotId: meta.id })
  assert.equal(preview.ok, true)
  assert.equal(preview.data.files[0].kind, 'modified')
  assert.deepEqual(readFileSync(patchFile), Buffer.from(PATCH_V2, 'utf8'), '预览后仍是当前内容')

  const applied = await service.handleRpc({ action: 'rollback', snapshotId: meta.id, confirm: true })
  assert.equal(applied.ok, true)
  assert.equal(applied.data.verified, true)
  assert.deepEqual(readFileSync(patchFile), Buffer.from(PATCH_V1, 'utf8'), '回滚后内容等于快照内容')
  assert.equal(snapshotDirCount(service.paths.snapshotRoot), 2, '回滚本身也会写一份回滚前快照')

  const list = await service.handleRpc({ action: 'listSnapshots' })
  assert.equal(list.ok, true)
  assert.ok(list.data.snapshots.some((item) => item.reason.startsWith('pre-rollback:')), '应能看到回滚前快照')
})

/* -------------------------------------------------------------------------- */
/* 4. 客户端渲染：新按钮 / 空差异 / hunk 展开 / 两步确认                         */
/* -------------------------------------------------------------------------- */

function flatten(list, out) {
  for (const item of list) {
    if (Array.isArray(item)) flatten(item, out)
    else if (item === null || item === undefined || item === false || item === true) continue
    else out.push(item)
  }
  return out
}

/** 迷你 React 桩：真的维护 useState/useRef/useEffect，setState 同步重渲染（Panel 以外无 hooks）。 */
let activeMount = null
const reactStub = {
  Fragment: Symbol('Fragment'),
  createElement(type, props, ...children) {
    const next = Object.assign({}, props)
    const kids = flatten(children, [])
    if (kids.length === 1) next.children = kids[0]
    else if (kids.length > 1) next.children = kids
    return { type, props: next }
  },
  useState(init) {
    return activeMount.useState(init)
  },
  useRef(value) {
    return activeMount.useRef(value)
  },
  useEffect(fn) {
    activeMount.useEffect(fn)
  },
  useMemo(fn) {
    return fn()
  },
  useCallback(fn) {
    return fn
  },
  Children: {
    toArray(value) {
      return flatten(Array.isArray(value) ? value : [value], [])
    },
  },
}

function mountPanel(Panel) {
  const hooks = []
  let cursor = 0
  let pendingEffects = []
  let rendering = false
  let tree = null

  function render() {
    cursor = 0
    pendingEffects = []
    rendering = true
    tree = Panel({ t: (key) => 'T:' + key, close: function () {} })
    rendering = false
    const effects = pendingEffects
    pendingEffects = []
    for (const effect of effects) {
      const cleanup = effect()
      if (typeof cleanup === 'function') cleanup
    }
    return tree
  }

  const mount = {
    useState(init) {
      const index = cursor++
      if (hooks[index] === undefined) {
        hooks[index] = { value: typeof init === 'function' ? init() : init }
      }
      const hook = hooks[index]
      return [
        hook.value,
        function setValue(next) {
          const value = typeof next === 'function' ? next(hook.value) : next
          if (value === hook.value) return
          hook.value = value
          if (!rendering) render()
        },
      ]
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
    get tree() {
      return tree
    },
  }
  return mount
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
        },
      },
    }
    await import(pathToFileURL(clientDist).href)
    assert.ok(captured, 'client.js 必须调用 window.__ModuleLoader__.load')
    return captured.factory((id) => {
      if (id === 'react') return reactStub
      throw new Error(`unexpected require: ${id}`)
    })
  })()
  return loadedPromise
}

function registerPanel(mod) {
  let Panel = null
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
      },
    },
    slots: {
      inject(name, cb) {
        cb()
        return function () {}
      },
      register(options, component) {
        if (options.id === 'dots') Panel = component
        return function () {}
      },
    },
  }
  mod.apply(ctx)
  assert.ok(Panel, '必须注册 id=dots 的 settings.section 组件')
  // 旧 dormant 面板已删除：只返回注册的 shipped DotsPanel。
  return Panel
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

function treeText(tree) {
  let out = ''
  walk(tree, (node) => {
    const kids = node.props && node.props.children
    const texts = flatten(Array.isArray(kids) ? kids : [kids], []).filter(
      (kid) => typeof kid === 'string' || typeof kid === 'number',
    )
    if (texts.length) out += ' ' + texts.join('')
  })
  return out
}

function buttonsOf(tree) {
  const list = []
  walk(tree, (node) => {
    if (node.type === 'button') list.push({ label: textOf(node.props.children), props: node.props })
  })
  return list
}

function click(tree, label) {
  const button = buttonsOf(tree).find((item) => item.label === label)
  assert.ok(button !== undefined, `找不到按钮 ${label}（现有：${buttonsOf(tree).map((item) => item.label).join(' | ')}）`)
  assert.equal(typeof button.props.onClick, 'function', `按钮 ${label} 必须可点击`)
  button.props.onClick()
}

function makeFetch(routes) {
  const calls = []
  globalThis.fetch = async function (url, options) {
    const body = JSON.parse(options.body)
    calls.push(body)
    const handler = routes[body.action]
    const payload = typeof handler === 'function' ? handler(body) : handler
    return {
      status: 200,
      async text() {
        return JSON.stringify(payload === undefined ? { ok: false, error: { code: 'E_UNKNOWN', message: 'no stub' } } : payload)
      },
    }
  }
  return calls
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

const SNAPSHOT = {
  id: '20260101-000000',
  time: '2026-01-01T00:00:00.000Z',
  reason: 'pre-apply:pc-b',
  bytes: 128,
}

const STATE_DATA = {
  settings: {
    repoUrl: 'https://example.invalid/u/r.git',
    platform: 'github',
    authMode: 'https',
    username: '',
    deviceId: 'pc-a',
    branch: 'main',
    scope: { config: true, providers: true, plugins: true, mcp: true },
    hasToken: false,
  },
  status: {
    reachable: null,
    branch: 'main',
    headSha: '',
    headMessage: '',
    headTime: '',
    localPending: null,
    remotePending: null,
    conflict: false,
    lastSyncAt: null,
  },
  snapshots: [SNAPSHOT],
}

const EMPTY_DIFF = {
  sourceDevice: 'pc-a',
  local: true,
  summary: {
    files: [{ path: 'cordis.patch.yml', kind: 'same', addedLines: 0, removedLines: 0, beforeBytes: 10, afterBytes: 10 }],
    totals: { added: 0, modified: 0, deleted: 0, same: 1, addedLines: 0, removedLines: 0 },
  },
  hunks: [],
}

const CHANGED_DIFF = {
  sourceDevice: 'pc-a',
  local: true,
  summary: {
    files: [
      { path: 'cordis.patch.yml', kind: 'modified', addedLines: 1, removedLines: 1, beforeBytes: 30, afterBytes: 32 },
      { path: 'providers.json', kind: 'added', addedLines: 2, removedLines: 0, beforeBytes: 0, afterBytes: 24 },
      { path: 'mcp.json', kind: 'deleted', addedLines: 0, removedLines: 1, beforeBytes: 12, afterBytes: 0 },
    ],
    totals: { added: 1, modified: 1, deleted: 1, same: 0, addedLines: 3, removedLines: 2 },
  },
  hunks: [
    { path: 'cordis.patch.yml', header: '@@ -1,3 +1,3 @@', lines: [' # patch', '-  value: 2', '+  value: 22', ' # end'], truncated: false },
    { path: 'cordis.patch.yml', header: '@@ -10,2 +10,2 @@', lines: [' ctx', '-old', '+new'], truncated: true },
  ],
}

const ROLLBACK_PLAN = {
  snapshotId: SNAPSHOT.id,
  createdAt: SNAPSHOT.time,
  reason: SNAPSHOT.reason,
  files: [{ path: 'cordis.patch.yml', kind: 'modified', addedLines: 1, removedLines: 1, beforeBytes: 32, afterBytes: 30 }],
  summary: {
    files: [{ path: 'cordis.patch.yml', kind: 'modified', addedLines: 1, removedLines: 1, beforeBytes: 32, afterBytes: 30 }],
    totals: { added: 0, modified: 1, deleted: 0, same: 0, addedLines: 1, removedLines: 1 },
  },
  willRestore: ['C:\\tmp\\profile\\cordis.patch.yml'],
}


test('rollbackPreview（M4）：文本文件给出内容级 hunk，且与 files 统计同方向（当前 → 快照）', async (t) => {
  const { profileDir, patchFile, service } = await setup(t, { patch: PATCH_V2 })
  const store = new SnapshotStore(service.paths.snapshotRoot)
  const meta = store.create('pre-apply:pc-b', { 'cordis.patch.yml': PATCH_V1 })

  const beforeBytes = readFileSync(patchFile)
  const snapshotsBefore = snapshotDirCount(service.paths.snapshotRoot)

  const result = await service.handleRpc({ action: 'rollbackPreview', snapshotId: meta.id })
  assert.equal(result.ok, true)
  assert.equal(result.data.truncated, false, '差异很小，预算充足')
  assert.ok(Array.isArray(result.data.hunks), 'rollbackPreview 必须带 hunks 字段')
  assert.ok(result.data.hunks.length >= 1, '文本文件必须给出可展开的内容差异')
  assert.equal(result.data.hunks[0].path, 'cordis.patch.yml')
  const lines = result.data.hunks[0].lines
  assert.ok(
    lines.some((line) => line === '-    value: 22'),
    `当前内容（会被换掉）应标 -：${lines.join('|')}`,
  )
  assert.ok(
    lines.some((line) => line === '+    value: 2'),
    `快照内容（回滚写入）应标 +：${lines.join('|')}`,
  )
  const patched = result.data.files.find((file) => file.path === 'cordis.patch.yml')
  assert.ok(patched.addedLines > 0 && patched.removedLines > 0, 'hunk 与 +X/-Y 统计必须都非零')

  // 仍然只读：profile 一个字节没改，快照数不变。
  assert.deepEqual(readFileSync(patchFile), beforeBytes, 'rollbackPreview 不得写 profile')
  assert.equal(snapshotDirCount(service.paths.snapshotRoot), snapshotsBefore, 'rollbackPreview 不得创建快照')
})

test('rollbackPreview（M4）：hunk 预算不足（正文 > 200 行）时 truncated 为 true', async (t) => {
  // 当前 300 行 vs 快照 300 行全不同 → 单个 hunk 600 行，超过 200 行预算。
  const currentText = Array.from({ length: 300 }, (_, i) => `current-${i}`).join('\n') + '\n'
  const snapshotText = Array.from({ length: 300 }, (_, i) => `snapshot-${i}`).join('\n') + '\n'
  const { patchFile, service } = await setup(t, { patch: currentText })
  const store = new SnapshotStore(service.paths.snapshotRoot)
  const meta = store.create('pre-apply:pc-b', { 'cordis.patch.yml': snapshotText })

  const beforeBytes = readFileSync(patchFile)
  const result = await service.handleRpc({ action: 'rollbackPreview', snapshotId: meta.id })
  assert.equal(result.ok, true)
  assert.equal(result.data.truncated, true, '正文被预算裁掉 → 必须标记"还有更多"')
  const totalLines = result.data.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0)
  assert.ok(totalLines <= 200, `hunk 正文不得超过 200 行，实际 ${totalLines}`)
  const last = result.data.hunks[result.data.hunks.length - 1]
  assert.equal(last.truncated, true, '被裁的那一段自身也要带标记')
  const patched = result.data.files.find((file) => file.path === 'cordis.patch.yml')
  assert.equal(patched.addedLines, 300, '行数统计不截断')
  assert.equal(patched.removedLines, 300)
  assert.deepEqual(readFileSync(patchFile), beforeBytes, '只读：不得写 profile')
})


