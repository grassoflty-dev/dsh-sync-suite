/**
 * mod-sync-ui-silence-audit — READ-ONLY cross-side inventory + ONE cross-side guard.
 *
 * POLICY (docs/MODULES.md §1 standing rule, line 209):
 *   "Sync is performed silently by the software: neither side offers retry / test /
 *    status-query controls; the only user action is saving the configuration
 *    (plus pairing / QR)."  The two allowed-control lists below are the single
 *    reviewable place that encodes this policy.  Adding a control on either side
 *    requires editing that list AND this file's inventory; an unlisted control fails.
 *
 * ============================== INVENTORY =============================================
 * Classifications: REMOVE = violates the standing rule; KEEP = allowed, with reason.
 * "Reachable" means the shipped build can actually arrive at the control.
 *
 * | Side   | file:line                              | Control                                  | Reachable?                         | Classification      | Reason |
 * |--------|----------------------------------------|------------------------------------------|------------------------------------|---------------------|--------|
 * | App    | SettingsSync.ets:834                   | Button('保存') → saveSettings()          | YES (route pages/SettingsSync)     | KEEP                | The one allowed user action: writes config only, never fabricates sync success. |
 * | App    | SettingsSync.ets:796 / :935            | Text('关闭') + scrim onClick (help sheet)| YES                                | KEEP                | Sheet dismissal, not a sync/retry/test/status control. |
 * | App    | SettingsSync.ets:413 / :612 / :658     | testConnection() / retryFromStatus() / runAction() methods | NO UI call point (dormant support seams) | KEEP (dormant) | Kept for support troubleshooting; Phase B removed every UI binding (`:13`, `:807`, `:894`). |
 * | App    | SyncSection.ets:167                    | ActionButton('更多') → help sheet        | YES                                | KEEP                | Read-only repository-address help, not a manual sync action. |
 * | App    | SyncSection.ets:297                    | ActionButton('改用 HTTPS 令牌')          | YES (only when saved authMode=ssh) | KEEP                | Auth-mode config toggle; persistence still requires 保存. Not a sync trigger. |
 * | App    | SyncSection.ets:370                    | EmptyState actionLabel '去填仓库地址'     | YES (repoUrl empty)                | KEEP                | Opens the same help sheet; no sync call. |
 * | App    | SyncSection.ets:377                    | Text(this.syncMessage) status row        | YES                                | KEEP                | Read-only status; no onClick. Body is presentational only. |
 * | App    | SyncSection.ets:354 / :435             | LoadingState(onCancel:null) / ErrorState(onRetry:null, onOpenSettings:null) | YES | KEEP | Cancel / retry / settings affordances explicitly removed. |
 * | App    | SyncSection.ets:422                    | Toggle '首页含其他设备'                   | YES                                | KEEP                | Display filter, not a sync control. |
 * | App    | SchedulePane.ets:550                   | '上次同步失败，点重试继续' status text     | YES                                | KEEP (text)         | Message inside the read-only row; not clickable. |
 * | App    | SchedulePane.ets:1723                  | Text(this.syncStatus.text) status row    | YES                                | KEEP                | The single read-only status surface; no onClick / Button. |
 * | App    | SchedulePane.ets:1810 / :1829          | Refresh.onRefreshing → onPullRefresh()   | YES (CompactBody + RightPane)      | KEEP (gesture)      | Pull-to-refresh is a gesture, not a retry/test/status *control*; the silent model may legitimately keep a gesture-only refresh. Same single-flight coordinator as all other triggers. |
 * | App    | SchedulePane.ets:403                   | retrySync() method                       | NO UI call point (dormant)         | KEEP (dormant)      | Phase A removed the 重试同步 control; capability retained for support. |
 * | App    | Home.ets:499 / :610                    | Refresh container → onGlobalPull()       | YES                                | KEEP (gesture)      | One global pull gesture covers all four panes; a gesture, not a button. |
 * | App    | Home.ets:201-216                       | homeStartupSync.configure()/request()    | implicit (cold launch)             | KEEP (named trigger)| Silent automatic trigger; must stay named so "silence" changes fail loudly. |
 * | App    | Home.ets:244-250 / :274-297            | onPageShow → homeStartupSync.request() + maybeForegroundSync() | implicit (foreground) | KEEP (named trigger) | Silent automatic trigger (5-min cooldown), no UI control. |
 * | App    | Home.ets:304-370                       | netCapabilitiesChange → runNetworkCycle()| implicit (network regain)          | KEEP (named trigger)| Silent automatic trigger (2 s debounce), no UI control. |
 * | App    | Home.ets:154 / SchedulePane.ets:356    | globalRefreshCoordinator.configure/runOnce + '[sync-trigger] pull' | implicit | KEEP (named trigger) | Single in-flight gate shared by auto + both gestures. |
 * | App    | recordWriter.ets:116-157               | triggerSync() → runConfiguredCycle()      | implicit (after write)             | KEEP (named trigger)| Silent write-time auto-sync through the one coordinator. |
 * | App    | Index.ets:1652 + :1656                 | Text('重试同步') + onClick → retrySync()  | BY REGISTRATION (pages/Index in main_pages.json:3; EntryAbility loads Home, no in-app navigation) | **REMOVE candidate — FINDING, NOT FIXED** | Violates the standing rule. Already positively pinned by apps/.../tools/test/syncWiring.test.mjs:565 and :676, so removal requires retargeting that App-owned guard. App file set is NOT owned by this module; reported only. |
 * | App    | SettingsHost.ets:965 / :1007 / :1144   | Button('保存'), GroupAnchorChip('同步'), SyncMoreSheet | NO (zero importers; component is unmounted) | KEEP (dormant) | Legacy implementation host, provably unreachable; its sync methods are dead. Deletion owner: the App settings-IA module family, not this audit. |
 * | App    | AiSection.ets:211                      | Button('测试') / '测试中…'                | YES                                | KEEP (out of scope) | AI-provider connectivity test, unrelated to the sync rule. |
 * | Plugin | src/client.js:4440-4445                | Btn tr('lean.actions.save') → doSave() → saveSettings | YES (shipped DotsPanel) | KEEP | The one allowed plugin user action; config save only. |
 * | Plugin | src/client.js:4757-4780                | 5 pairing controls: 显示二维码 / 复制配对串 / 重新生成 / 自检 / 开始或停止接受连接 | YES | KEEP (out of sync rule) | Pairing / QR / listener reachability only; the standing rule explicitly exempts pairing/QR. `自检` is remoteProbe (pairing reachability), not sync testConnection. |
 * | Plugin | src/client.js:4436                     | data-lean='sync-status' status div       | YES                                | KEEP                | Read-only status text; no control. |
 * | Plugin | src/client.js:2711/2716/2721/2727/2730/2736/2745, 3008/3163/3178 | dormant legacy SettingsPanel buttons: 测试连接(doTest) / 推送(doPush) / 拉取预览(doPreview) / 查看差异(doDiff) / 回滚到上次快照 / 执行覆盖(doApply) / 刷新状态 / rollbackPreview / rollback | NO (SettingsPanel never mounted; only a test seam at DotsPanel.SettingsPanel) | KEEP (dormant) / REMOVE-candidate | Not registered by the sole `ctx.slots.register(..., DotsPanel)`. Deletion owner: the lean-panel plugin module family (mod-plugin-lean-panel / mod-plugin-sync-probe-removal follow-up). Internal shapes deliberately NOT asserted here. |
 * | Plugin | src/rpc.ts:1240-1255 (+ impls :478/:498/:554/:598/:632/:741) | RPC-only actions testConnection / push / preview / apply / rollback / listSnapshots / rollbackPreview | server-side only; no shipped control | KEEP (dormant surface) | mod-plugin-sync-probe-removal decided RPC stays internal/dormant because tests and legacy sites call it directly; guard proves no shipped UI reaches it. |
 * | Plugin | locale/zh.json:52/67/87                 | legacy strings 未探测（点击测试连接）/ actions.test / error.retry | NO (shipped tree uses only lean.* keys) | KEEP (dormant copy) | Keep for the dormant panel; guard asserts no shipped node resolves them. |
 *
 * FINDING SUMMARY: the only reachable-rule violation found is the App fallback page
 * `pages/Index.ets:1652`. It is reported, not fixed (App files are out of this module's
 * scope, and an existing App guard pins the control as an accepted exception).
 *
 * Scope discipline: tests only. No src/, dist/, App, docs/**, AppScope/** or device edits.
 * Source shape is proven; rendered pixels / GUI / device gestures are `unverified`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const appEts = path.resolve(pkgDir, '..', '..', 'apps', 'arkui-schedule', 'entry', 'src', 'main', 'ets')
const clientSrcPath = path.join(pkgDir, 'src', 'client.js')
const clientDist = path.join(pkgDir, 'dist', 'client.js')

const read = (rel) => readFileSync(path.join(appEts, rel), 'utf8')

/* ========================================================================== */
/* THE ONE ALLOWED-CONTROL LIST PER SIDE — the only place to add a control.    */
/* ========================================================================== */
const APP_ALLOWED = [
  { file: 'pages/SettingsSync.ets', label: '保存', kind: 'Button → saveSettings() (config save; the only user sync-surface action)' },
  { file: 'components/settings/SyncSection.ets', label: '更多', kind: 'ActionButton → onOpenSyncMore() (read-only help sheet)' },
  { file: 'components/settings/SyncSection.ets', label: '改用 HTTPS 令牌', kind: 'ActionButton → onSwitchToHttpsToken() (auth toggle, conditional)' },
  { file: 'components/settings/SyncSection.ets', label: '去填仓库地址', kind: 'EmptyState actionLabel → onOpenSyncMore() (help sheet, conditional)' },
  { file: 'pages/panes/SchedulePane.ets', label: '(gesture) pull-to-refresh ×2', kind: 'Refresh.onRefreshing → onPullRefresh() (CompactBody + RightPane; gesture, not control)' }
]

const PLUGIN_ALLOWED = [
  { group: 'dots', file: 'src/client.js', i18n: 'lean.actions.save', label: '保存', kind: 'Btn → doSave() → saveSettings RPC (config save only)' },
  { group: 'dots-remote', file: 'src/client.js', i18n: 'lean.remote.qr.show', label: '显示二维码', kind: 'Btn → doShow() → pairingShow RPC (pairing)' },
  { group: 'dots-remote', file: 'src/client.js', i18n: 'lean.remote.copy', label: '复制配对串', kind: 'Btn → doCopy() → clipboard only (pairing)' },
  { group: 'dots-remote', file: 'src/client.js', i18n: 'lean.remote.generate', label: '重新生成', kind: 'Btn → doGenerate() → pairingRotateToken RPC (pairing)' },
  { group: 'dots-remote', file: 'src/client.js', i18n: 'lean.remote.selfcheck', label: '自检', kind: 'Btn → doSelfCheck() → remoteProbe RPC (pairing reachability, NOT sync testConnection)' },
  { group: 'dots-remote', file: 'src/client.js', i18n: 'lean.remote.start', label: '开始接受连接', variant: true, kind: 'Btn → doStart() → remoteStart RPC (state-dependent listener slot)' },
  { group: 'dots-remote', file: 'src/client.js', i18n: 'lean.remote.stop', label: '停止接受连接', kind: 'Btn → doStop() → remoteStop RPC (default when listener running)' }
]

/** Automatic / gesture triggers are allowed, but must stay NAMED (source shape). */
const APP_TRIGGERS = [
  { file: 'pages/Home.ets', token: 'homeStartupSync.request();', meaning: 'cold-start / foreground one-shot silent sync request' },
  { file: 'pages/Home.ets', token: "globalRefreshCoordinator.runOnce(undefined, 'cold-launch')", meaning: 'startup sync cycle via the single-flight coordinator' },
  { file: 'pages/Home.ets', token: "globalRefreshCoordinator.runOnce(undefined, 'foreground')", meaning: 'foreground silent cycle' },
  { file: 'pages/Home.ets', token: "globalRefreshCoordinator.runOnce(undefined, 'network')", meaning: 'network-regain silent cycle' },
  { file: 'pages/Home.ets', token: 'Refresh({ refreshing: $$this.globalRefreshing })', meaning: 'global pull-to-refresh gesture container' },
  { file: 'pages/Home.ets', token: 'globalRefreshCoordinator.configure({', meaning: 'single-flight coordinator with the four read-back hooks' },
  { file: 'pages/panes/SchedulePane.ets', token: "console.info('[sync-trigger] pull')", meaning: 'named pull gesture trigger' },
  { file: 'services/recordWriter.ets', token: 'syncProtocolStore.runConfiguredCycle()', meaning: 'write-time auto-sync' },
  { file: 'services/recordWriter.ets', token: "void globalRefreshCoordinator.runOnce(overrides, 'save')", meaning: 'write-time cycle through the one in-flight gate' }
]

/** Reachable settings/pane source files (SettingsHost excluded: zero importers, dormant). */
const APP_REACHABLE_SETTINGS_FILES = [
  'pages/Settings.ets',
  'pages/SettingsSync.ets',
  'pages/SettingsExportImport.ets',
  'pages/SettingsApi.ets',
  'components/settings/SettingsBits.ets',
  'components/settings/SyncSection.ets',
  'components/settings/AiSection.ets',
  'components/settings/DataSection.ets',
  'components/settings/AboutSection.ets',
  'components/ExportImportPanel.ets',
  'pages/panes/SchedulePane.ets'
]

/** Exact-match banned control labels (both sides). Do not substring-match: '同步仓库' is a title, not a control. */
const BANNED_LABELS = [
  '重试', '重试同步', '测试连接', '查看状态', '立即同步', '同步',
  '推送', '拉取预览', '执行覆盖', '回滚到上次快照', '刷新状态', '查看差异', '快照'
]
/** Sync-capability methods no clickable UI handler may reach on the App side. */
const BANNED_HANDLER_CALLS = [
  'runAction(', 'retryFromStatus(', 'testConnection(', 'retrySync(',
  'runConfiguredCycle(', 'ensureRepoInitialised('
]
/** Banned plugin RPC actions — no shipped button may cause any of these. */
const BANNED_ACTIONS = [
  'push', 'testConnection', 'preview', 'apply', 'rollback', 'listSnapshots', 'rollbackPreview'
]
/** Banned plugin i18n keys — kept in locale for the dormant panel, never resolved in shipped UI. */
const BANNED_I18N_KEYS = [
  'lean.actions.test', 'actions.test', 'actions.push', 'actions.preview',
  'actions.apply', 'actions.rollbackLatest', 'actions.refresh', 'error.retry', 'status.unprobed'
]

/* ------------------------------ source helpers ----------------------------- */

/** Blank comments, preserve strings (so URLs / Chinese copy survive). */
function stripComments(src) {
  let out = ''
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === '/' && src[i + 1] === '/') {
      out += '  '
      i += 2
      while (i < src.length && src[i] !== '\n') { out += ' '; i += 1 }
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      out += '  '
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' '
        i += 1
      }
      out += '  '
      i += 2
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c
      out += c
      i += 1
      while (i < src.length) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] ?? ''); i += 2; continue }
        out += src[i]
        if (src[i] === quote) { i += 1; break }
        i += 1
      }
      continue
    }
    out += c
    i += 1
  }
  return out
}

/** All string literal values in a snippet (strings preserved by stripComments). */
function literals(code) {
  const out = []
  let i = 0
  while (i < code.length) {
    const c = code[i]
    if (c === "'" || c === '"' || c === '`') {
      const quote = c
      let value = ''
      i += 1
      while (i < code.length) {
        if (code[i] === '\\') { value += code[i + 1] ?? ''; i += 2; continue }
        if (code[i] === quote) { i += 1; break }
        value += code[i]
        i += 1
      }
      out.push(value)
      continue
    }
    i += 1
  }
  return out
}

/** Balanced call bodies: callBodies(code, 'onClick') → every `onClick(<body>)`. */
function callBodies(code, name) {
  const out = []
  const re = new RegExp('(?:\\.|^|[^\\w$.])' + name + '\\s*\\(', 'g')
  let m
  while ((m = re.exec(code))) {
    const open = m.index + m[0].length - 1
    let i = open + 1
    let depth = 1
    while (i < code.length && depth > 0) {
      const c = code[i]
      if (c === "'" || c === '"' || c === '`') {
        const quote = c
        i += 1
        while (i < code.length) {
          if (code[i] === '\\') { i += 2; continue }
          if (code[i] === quote) { i += 1; break }
          i += 1
        }
        continue
      }
      if (c === '(') depth += 1
      else if (c === ')') depth -= 1
      i += 1
    }
    out.push(code.slice(open + 1, i - 1))
  }
  return out
}

/** Resolve `const NAME: string = 'literal'`; null for TS type annotations / dynamic values. */
function resolveStringConstant(code, name) {
  const m = new RegExp("const\\s+" + name + "\\s*:\\s*string\\s*=\\s*'([^']*)'").exec(code)
  return m ? m[1] : null
}

/** Control labels from ArkUI `Button(...)`, `ActionButton({label:...})`, state `actionLabel/retryLabel`. */
function controlLabels(code) {
  const out = []
  for (const body of callBodies(code, 'Button')) out.push(...literals(body))
  const labelRe = /\b(?:label|actionLabel|retryLabel)\s*:\s*(?:('([^']*)')|([A-Za-z_$][\w$]*))/g
  let m
  while ((m = labelRe.exec(code))) {
    if (m[2] !== undefined) out.push(m[2])
    else {
      const resolved = resolveStringConstant(code, m[3])
      if (resolved !== null) out.push(resolved)
    }
  }
  return out
}

/** Slice a named `@Builder`/function body up to the next top-level declaration/comment anchor. */
function sliceRegion(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker)
  assert.ok(start >= 0, `missing region start: ${startMarker}`)
  const end = src.indexOf(endMarker, start + startMarker.length)
  assert.ok(end > start, `missing region end: ${endMarker}`)
  return src.slice(start, end)
}

function lineOf(src, index) {
  return src.slice(0, index).split('\n').length
}

function listSourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) listSourceFiles(full, out)
    else if (/\.(js|ts)$/.test(entry.name)) out.push(full)
  }
  return out
}

/* ========================== React stub (copied from client-lean-inventory.test.mjs / lean-panel-guard.test.mjs) ========================== */
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
      await import(pathToFileURL(clientDist).href + '?sync-control-audit=' + Date.now())
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

function buttonLabels(nodes) {
  return nodes.filter((n) => n.type === 'button').map((n) => textOf(n.props.children))
}

function button(nodes, label) {
  const found = nodes.filter((n) => n.type === 'button' && textOf(n.props.children) === label)
  assert.equal(found.length, 1, `按钮「${label}」必须恰好一个`)
  return found[0]
}

const REMOTE_TOKEN = 'rt_real_0123456789abcdef'
const REMOTE_LINK = {
  url: 'http://192.168.1.6:3080/?token=' + REMOTE_TOKEN,
  qr: { size: 3, modules: [[true, false, true], [false, true, false], [true, false, true]] },
  note: ''
}
const PAIR_VIEW = {
  v: 1, instanceId: 'gwl-pc', transport: 'lan', host: '192.168.1.6', port: 44996,
  tlsFingerprint: 'AA:BB', announceRef: '', token: 'present'
}
const PAIR_TEXT = 'DSHDOTS1|1|gwl-pc|lan|192.168.1.6|44996|' + REMOTE_TOKEN + '|AA:BB||00000000'
function pairCandidates() {
  return {
    tailscale: { kind: 'tailscale', available: false, reason: 'tailnet', host: '' },
    lan: { kind: 'lan', available: true, reason: 'same wifi', host: '192.168.1.6' },
    ipv6: { kind: 'ipv6', available: false, reason: 'no ipv6', host: '' }
  }
}
function stateData() {
  return {
    settings: { repoUrl: 'https://gitee.com/u/r.git', hasToken: true, mode: 'lan', port: 0 },
    status: { lastSyncAt: '2026-01-01T08:30:00+08:00', running: true, probe: null, visibilityBlocked: false },
    modes: []
  }
}
function makeFetch() {
  const calls = []
  const routes = {
    getState: () => ({ ok: true, data: stateData() }),
    saveSettings: () => ({ ok: true, data: { settings: { repoUrl: 'https://gitee.com/u/r.git' }, hasToken: true } }),
    remoteGetState: () => ({ ok: true, data: stateData() }),
    pairingProvision: () => ({ ok: true, data: { view: PAIR_VIEW, changed: { port: false, token: false, cert: false }, republish: null } }),
    pairingTransports: () => ({ ok: true, data: { selected: 'lan', selectedHost: '192.168.1.6', overrideUnavailable: false, candidates: pairCandidates(), reasonLines: [] } }),
    pairingConnections: () => ({ ok: true, data: [] }),
    pairingShow: () => ({ ok: true, data: { payload: '{}', text: PAIR_TEXT, qr: REMOTE_LINK.qr } }),
    pairingRotateToken: () => ({ ok: true, data: { view: PAIR_VIEW, changed: { port: false, token: true, cert: false }, republish: null } }),
    remoteStop: () => ({ ok: true, data: { running: false } }),
    remoteStart: () => ({ ok: true, data: { running: true } }),
    remoteProbe: () => ({ ok: true, data: { level: 'ok', verdict: 'probe ok' } }),
    testConnection: () => ({ ok: true, data: { reachable: true } })
  }
  globalThis.fetch = async function (_url, options) {
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

Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { clipboard: { writeText: async () => {} } }
})

/** Microtask-only flush — no sleeps, no timers, no network. */
const settle = async () => { for (let i = 0; i < 40; i += 1) await Promise.resolve() }

async function renderReal() {
  const { Panel } = await loadPanel()
  const calls = makeFetch()
  activeMount = mountPanel(Panel, { t: (key) => key, close() {} })
  const mount = activeMount
  mount.render()
  await settle()
  return { mount, calls, nodes: nodesOf(mount.tree) }
}

async function click(mount, label) {
  const target = button(nodesOf(mount.tree), label)
  await target.props.onClick()
  await settle()
}

/* ========================================================================== */
/* APP ASSERTIONS                                                              */
/* ========================================================================== */

test('APP-1: sync surface is exactly the APP_ALLOWED control set (unlisted control fails)', () => {
  const observed = []
  const saveCode = stripComments(read('pages/SettingsSync.ets'))
  const saveLabels = controlLabels(saveCode)
  assert.deepEqual(saveLabels, ['保存'], `SettingsSync.ets 只能有「保存」控件，实际 ${saveLabels.join(',')}`)
  for (const label of saveLabels) observed.push({ file: 'pages/SettingsSync.ets', label })

  const sectionCode = stripComments(read('components/settings/SyncSection.ets'))
  const sectionLabels = controlLabels(sectionCode)
  assert.deepEqual(
    sectionLabels, ['更多', '改用 HTTPS 令牌', '去填仓库地址'],
    `SyncSection.ets 控件集合漂移：${sectionLabels.join(',')}`
  )
  for (const label of sectionLabels) observed.push({ file: 'components/settings/SyncSection.ets', label })

  const paneCode = stripComments(read('pages/panes/SchedulePane.ets'))
  const refreshCount = (paneCode.match(/\bRefresh\s*\(/g) || []).length
  assert.equal(refreshCount, 2, '日程面板必须恰好两处 Refresh（CompactBody + RightPane）')
  observed.push({ file: 'pages/panes/SchedulePane.ets', label: '(gesture) pull-to-refresh ×2' })

  assert.deepEqual(observed, APP_ALLOWED.map(({ file, label }) => ({ file, label })))
})

test('APP-2: no banned label on any reachable settings/pane control', () => {
  for (const file of APP_REACHABLE_SETTINGS_FILES) {
    const code = stripComments(read(file))
    const hits = controlLabels(code).filter((label) => BANNED_LABELS.includes(label))
    assert.deepEqual(hits, [], `${file} 出现被禁控件文案：${hits.join(' | ')}`)
    // A clickable Text (e.g. Text('重试同步').onClick) is still a control.
    for (const banned of BANNED_LABELS) {
      // Leading boundary avoids the `loadingText('同步')` false positive.
      const re = new RegExp("(?:^|[^\\w$.])Text\\(\\s*['\"]" + banned + "['\"]")
      assert.doesNotMatch(code, re, `${file} 不得把「${banned}」做成可点 Text`)
    }
  }
})

test('APP-3: no clickable handler reaches a sync-capability method', () => {
  for (const file of APP_REACHABLE_SETTINGS_FILES) {
    const code = stripComments(read(file))
    for (const handler of ['onClick', 'onTap', 'onAction', 'onRetry', 'onRefreshing']) {
      for (const body of callBodies(code, handler)) {
        for (const call of BANNED_HANDLER_CALLS) {
          assert.ok(
            !body.includes(call),
            `${file}:${handler} 不得调用同步能力 ${call}（静默模型下只有保存是用户动作）`
          )
        }
      }
    }
  }
})

test('APP-4: sync status rows are read-only Text, not interactive controls', () => {
  const pane = read('pages/panes/SchedulePane.ets')
  const row = sliceRegion(pane, 'SyncStatusRow() {', '\n  }')
  assert.match(row, /Text\(this\.syncStatus\.text\)/, '状态行必须是 Text')
  assert.doesNotMatch(row, /\.onClick\s*\(|Button\s*\(|ActionButton\s*\(/, '状态行不得挂任何点击/按钮控件')

  const section = read('components/settings/SyncSection.ets')
  const at = section.indexOf('Text(this.syncMessage)')
  assert.ok(at >= 0, 'SyncSection 必须有一行只读状态 Text')
  const window = section.slice(at, at + 480)
  assert.doesNotMatch(window, /\.onClick\s*\(|Button\s*\(|ActionButton\s*\(/, '设置同步状态行不得可点')
  assert.match(section, /onRetry:\s*null/, '错误态不得提供重试按钮')
})

test('APP-5: dormant legacy SettingsHost is not instantiated and mounts no manual sync sheet controls', () => {
  for (const file of APP_REACHABLE_SETTINGS_FILES) {
    assert.doesNotMatch(read(file), /SettingsHost\s*\(/, `${file} 不得实例化 dormnat SettingsHost`)
  }
  const host = read('components/settings/SettingsHost.ets')
  const sheet = sliceRegion(host, 'SyncMoreSheet() {', '/** `?` 帮助弹层')
  assert.doesNotMatch(sheet, /查看状态|测试连接|重试|runAction\s*\(|testConnection\s*\(/, '即使是 dormant 宿主也不得渲染手动同步控件')
})

test('APP-6: named automatic / gesture triggers are still present (silence must not remove them)', () => {
  for (const trigger of APP_TRIGGERS) {
    const code = read(trigger.file)
    const at = code.indexOf(trigger.token)
    assert.ok(
      at >= 0,
      `${trigger.file}:${at < 0 ? '?' : lineOf(code, at)} 缺少触发「${trigger.token}」(${trigger.meaning})`
    )
  }
})

/* ========================================================================== */
/* PLUGIN ASSERTIONS                                                           */
/* ========================================================================== */

test('PLUGIN-1: shipped sync group is exactly the allowed single 保存 button', async () => {
  const { nodes } = await renderReal()
  const syncLabels = buttonLabels(nodesBelow(detailsOf(nodes, 'dots')))
  const allowedSync = PLUGIN_ALLOWED.filter((c) => !c.variant && c.group === 'dots').map((c) => c.label)
  assert.deepEqual(syncLabels, allowedSync, '同步组必须恰好只有 APP_ALLOWED 列出的按钮（「测试连接」回归即失败）')

  const remoteLabels = buttonLabels(nodesBelow(detailsOf(nodes, 'dots-remote')))
  const allowedRemote = PLUGIN_ALLOWED.filter((c) => !c.variant && c.group === 'dots-remote').map((c) => c.label)
  assert.deepEqual(remoteLabels, allowedRemote, '远程组五个配对控件必须与 PLUGIN_ALLOWED 一致')
  assert.equal(remoteLabels.length, 5, '远程组恰好 5 个控件')
})

test('PLUGIN-2: no banned i18n key or banned label resolves anywhere in the shipped panel tree', async () => {
  const { nodes } = await renderReal()
  const labels = buttonLabels(nodes)
  for (const label of labels) {
    assert.ok(!BANNED_LABELS.includes(label), `shipped 面板出现被禁按钮文案「${label}」`)
  }

  const src = readFileSync(clientSrcPath, 'utf8')
  const leanRegion = sliceRegion(src, 'function LeanSyncGroup(', 'function DotsPanel(')
  const keys = [...leanRegion.matchAll(/h\(Btn,\s*\{\s*label:\s*tr\('([^']+)'\)/g)].map((m) => m[1])
  const allowedKeys = PLUGIN_ALLOWED.map((c) => c.i18n)
  assert.deepEqual(keys, allowedKeys, 'shipped Btn 的 i18n key 集合必须与 PLUGIN_ALLOWED 逐项一致（新增控件必须登记）')
  for (const key of BANNED_I18N_KEYS) {
    assert.ok(!keys.includes(key), `shipped Btn 不得解析被禁 i18n key ${key}`)
  }
  // status row stays a read-only node, never a button.
  const status = nodes.filter((n) => n.props && n.props['data-lean'] === 'sync-status')
  assert.equal(status.length, 1, '同步状态行必须恰好一条')
  assert.equal(status[0].type, 'div', '状态行是只读 div，不是 button')
})

test('PLUGIN-3: clicking EVERY shipped button issues no banned sync RPC action', async () => {
  const { nodes } = await renderReal()
  const labels = buttonLabels(nodes)
  assert.deepEqual(labels, PLUGIN_ALLOWED.filter((c) => !c.variant).map((c) => c.label))
  for (const label of labels) {
    const { mount, calls } = await renderReal()
    calls.length = 0 // isolate this click from mount-time reads
    await click(mount, label)
    const actions = calls.map((c) => c.action)
    for (const banned of BANNED_ACTIONS) {
      assert.ok(
        !actions.includes(banned),
        `按钮「${label}」触发了被禁 RPC action ${banned}（实际 ${actions.join(',') || 'none'}）`
      )
    }
  }
})

test('PLUGIN-4: dormant legacy SettingsPanel is not registered (its controls are provably unreachable)', () => {
  const src = readFileSync(clientSrcPath, 'utf8')
  assert.equal((src.match(/ctx\.slots\.inject\s*\(/g) || []).length, 1, '只能有一个 slot 注入')
  assert.equal((src.match(/ctx\.slots\.register\s*\(/g) || []).length, 1, '只能有一个 settings.section 注册')
  const registration = sliceRegion(src, 'ctx.slots.register(', 'return { inject: inject, apply: apply }')
  assert.match(registration, /\bDotsPanel\b/, '唯一注册的组件必须是 DotsPanel')
  assert.doesNotMatch(registration, /SettingsPanel|RemotePanel/, 'dormant 旧面板不得出现在注册处')
  const dotsBody = sliceRegion(src, 'function DotsPanel(props) {', '// 内部测试接缝')
  assert.doesNotMatch(dotsBody, /SettingsPanel|RemotePanel/, 'DotsPanel body 不得挂载 dormant 旧面板')

  const allSrc = listSourceFiles(path.join(pkgDir, 'src'))
  const registerHits = allSrc.filter((file) => /\bctx\.slots\.register\s*\(/.test(readFileSync(file, 'utf8')))
  assert.deepEqual(registerHits, [clientSrcPath], '全 src 树只允许 client.js 一处 settings.section 注册')
  // NOTE: dormant internals (doTest/push/preview/apply/rollback buttons, zh.actions.* keys)
  // are deliberately NOT asserted here. Their deletion belongs to the lean-panel plugin
  // module family; this guard only proves no shipped registration can reach them.
})
