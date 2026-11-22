// 首页冷启动自动同步守卫（mod-home-startup-sync）。
//
// 两层证据：
//   ① **真 spy**：`model/homeStartupSync.ts` 与 `model/homeGlobalRefresh.ts` 编译成 `.build/model/*.js`
//      后在 Node 里跑一遍完整链路（一次性编排 → 真协调器 → 注入的周期钩子），断言 coordinator 入口
//      与 runConfiguredCycle 各恰好一次；未配置 / 隐私阻断 / 就绪晚于首帧 / 失败各一条用例。
//   ② **源码形状**：ArkUI 不能进 Node，Home 的 GitBridgeHost + ensureStarted + 单闸入口 +
//      「没有直接 runConfiguredCycle(」只能静态钉住。
// 前置：node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { readEts, stripComments, matchBrace } from './helpers/etsSource.mjs'
import { requireOverlayRestored } from './guard.mjs'

requireOverlayRestored('homeStartupSync.test.mjs')

// tsc 产物里的相对 import 不带 .js（与 homeGlobalRefresh.test.mjs 同款口径）。
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (error !== null && typeof error === 'object' &&
          error.code === 'ERR_MODULE_NOT_FOUND' &&
          specifier.startsWith('.') && !specifier.endsWith('.js')) {
        return nextResolve(`${specifier}.js`, context)
      }
      throw error
    }
  }
})

const {
  HomeStartupSync,
  BRIDGE_NOT_READY_REASON,
  E_STARTUP_SYNC_UNAVAILABLE,
  homeStartupSync
} = await import('../.build/model/homeStartupSync.js')
const { GlobalRefreshCoordinator } = await import('../.build/model/homeGlobalRefresh.js')
const {
  isRepoConfigured, repoConfigStateOf, repoRowSummary, E_REPO_UNCONFIGURED
} = await import('../.build/model/repoConfigured.js')

const HOME = stripComments(readEts('main/ets/pages/Home.ets'))
const INDEX = stripComments(readEts('main/ets/pages/Index.ets'))
const PURE = stripComments(readEts('main/ets/model/homeStartupSync.ts'))
const CYCLE_STORE = stripComments(readEts('main/ets/services/syncProtocolStore.ets'))

/** 取 `name(...) { … }` 方法体（容忍 private / async / public 前缀）。 */
function memberBody(source, name) {
  const found = new RegExp(`\\n  (?:private |public |async )*${name}\\(`).exec(source)
  assert.ok(found !== null, `找不到方法 ${name}`)
  const [start, end] = matchBrace(source, source.indexOf('{', found.index))
  return source.slice(start + 1, end - 1)
}

// 形状占位，不是任何真实凭据（沿用 configuredState.test.mjs 的口径）。
const REPO = 'https://gitee.example/dsh-dots-test.git'
const TOKEN = 'x'.repeat(32)
const CONFIGURED = { repoUrl: REPO, token: TOKEN, authMode: 'https' }
const UNCONFIGURED = { repoUrl: '', token: '' }

function okResult() {
  return { ok: true, code: 'ok', message: '已同步', days: 1, conflicts: 0, added: 0,
    dropped: [], pending: 0, failed: 0, attempts: 1 }
}

function blockedResult() {
  return { ok: false, code: 'E_REPO_PUBLIC', message: '仓库已变为公开，已停止上传',
    days: 0, conflicts: 0, added: 0, dropped: [], pending: 0, failed: 0, attempts: 0 }
}

/**
 * 一条完整链路的 spy 台：HomeStartupSync（一次性编排）→ 真 GlobalRefreshCoordinator
 * → 注入的周期钩子（模拟 syncProtocolStore.runConfiguredCycle）。
 * options.blocked = true 时模拟隐私门禁：可以进周期，但 guardPush 拒绝 ⇒ push 计数 0。
 */
function makeRig(options = {}) {
  const state = {
    coordinatorEntries: 0,
    cycleCalls: 0,
    pushes: 0,
    commits: 0,
    failures: [],
    toasts: 0,
    log: [],
    lastResult: null
  }
  const coordinator = new GlobalRefreshCoordinator()
  coordinator.configure({
    runCycle: async () => {
      state.cycleCalls++
      state.log.push('cycle')
      if (options.blocked) {
        state.log.push('guardPushDenied')
        state.lastResult = blockedResult()
        return state.lastResult
      }
      if (!options.allowPush) {
        // 正常周期里唯一 push 点；blocked 时根本走不到这里。
        state.pushes++
      }
      return okResult()
    },
    markSyncing: () => { state.log.push('syncing') },
    reloadSchedule: () => { state.log.push('schedule') },
    reloadDots: () => { state.log.push('dots') },
    reloadCloudChat: () => { state.log.push('cloudChat') },
    commitStatus: (result) => {
      state.commits++
      state.lastResult = result
      state.log.push('status')
    },
    reportFailure: (reason) => { state.failures.push(`coordinator:${reason}`) }
  })

  let ready = options.ready === true
  const startup = new HomeStartupSync()
  startup.configure({
    isBridgeReady: () => { state.log.push('readyCheck'); return ready },
    isConfigured: async () => {
      state.log.push('configRead')
      return options.unconfigured ? false : isRepoConfigured(options.config ?? CONFIGURED)
    },
    runOnce: async () => {
      if (options.throwInRunOnce !== undefined) {
        state.log.push('coordinatorThrow')
        throw new Error(options.throwInRunOnce)
      }
      state.coordinatorEntries++
      state.log.push('coordinatorEntry')
      await coordinator.runOnce()
    },
    reportFailure: (reason) => { state.failures.push(`startup:${reason}`) }
  })

  return {
    state, startup,
    setReady(value) { ready = value },
    snapshot: () => startup.snapshot()
  }
}

// ---------------------------------------------------------------- 真 spy：五条冷启动用例

test('HSS-01 冷启动 + 已配置 ⇒ 恰好一个协调器入口 + 一次 runConfiguredCycle，不是第二直接调用', async () => {
  const rig = makeRig({ ready: true })
  rig.startup.request()
  await rig.startup.settled()

  assert.equal(rig.state.coordinatorEntries, 1, '启动只能进一次 globalRefreshCoordinator.runOnce')
  assert.equal(rig.state.cycleCalls, 1, '一个启动请求只能跑一个周期（runConfiguredCycle）')
  assert.equal(rig.state.pushes, 1, '正常已配置仓库照常走唯一 push 点')
  assert.equal(rig.state.commits, 1, '只有一次状态落点')
  assert.deepEqual(rig.state.failures, [])
  assert.equal(rig.snapshot().cycleLaunched, true)
  assert.ok(rig.state.log.indexOf('coordinatorEntry') < rig.state.log.indexOf('cycle'),
    '周期必须由协调器入口触发，而不是绕过它')
  assert.deepEqual(rig.state.log.filter((item) => item === 'cycle'), ['cycle'])
})

test('HSS-02 冷启动 + 未配置（E_UNCONFIGURED）⇒ 零周期、零状态写入、零 toast', async () => {
  assert.equal(E_REPO_UNCONFIGURED, 'E_UNCONFIGURED')
  assert.equal(isRepoConfigured(UNCONFIGURED), false, '未配置判据来自 repoConfigured 单一来源')

  const rig = makeRig({ ready: true, unconfigured: true })
  rig.startup.request()
  await rig.startup.settled()

  assert.equal(rig.state.coordinatorEntries, 0, '未配置绝不能进协调器')
  assert.equal(rig.state.cycleCalls, 0, '未配置零周期')
  assert.equal(rig.state.pushes, 0)
  assert.equal(rig.state.commits, 0, '中性配置行原样保留，不写失败态')
  assert.deepEqual(rig.state.failures, [], '未配置不是失败，不写 scary 原因')
  assert.equal(rig.state.toasts, 0)
  assert.equal(rig.snapshot().cycleLaunched, false)
  assert.equal(rig.snapshot().attempted, true, '一次性配额已消费，后续 show 不得再试')
})

test('HSS-03 冷启动 + 隐私阻断 ⇒ 周期可进但零 push，状态是「已配置（可见性阻断，禁止推送）」', async () => {
  // 阻断的仓库仍是「已配置」：这是 sibling lane 的单一 predicate，本模块不复制第二份判据。
  assert.equal(isRepoConfigured(CONFIGURED), true)
  const summary = repoRowSummary('gitee.com', '未同步', repoConfigStateOf(CONFIGURED), true)
  assert.match(summary, /已配置（可见性阻断，禁止推送）/)
  assert.equal(summary.includes('未配置'), false, '阻断绝不能被说成未配置')

  const rig = makeRig({ ready: true, blocked: true })
  rig.startup.request()
  await rig.startup.settled()

  assert.equal(rig.state.coordinatorEntries, 1, '已配置（即便被阻断）仍进一次周期')
  assert.equal(rig.state.cycleCalls, 1)
  assert.equal(rig.state.pushes, 0, '隐私门禁权威：被挡时一次 push 都不许发生')
  assert.equal(rig.state.lastResult.code, 'E_REPO_PUBLIC')
  assert.equal(rig.state.lastResult.ok, false)
  assert.equal(rig.state.lastResult.message.includes('已同步'), false, '绝不伪造成功')
  assert.deepEqual(rig.state.failures, [], '隐私态由既有门禁落点呈现，不走通用失败第二条')
  // 生产门禁仍在 syncProtocolStore（只读核对，不修改 sibling lane 文件）。
  assert.match(CYCLE_STORE, /repoVisibilityChecker\.guardPush\(\)/)
  assert.match(CYCLE_STORE, /if \(!guard\.allowed\)/)
})

test('HSS-04 桥晚于首帧就绪（ready-after-paint）⇒ 仍恰好一个周期，重复 show / 重复 ready 不加码', async () => {
  const rig = makeRig({ ready: false })
  rig.startup.request() // aboutToAppear：桥未就绪 ⇒ 挂在就绪回调上
  await rig.startup.settled()
  assert.equal(rig.snapshot().deferred, true, '未就绪必须 deferred，不能静默丢弃')
  assert.equal(rig.state.cycleCalls, 0, '桥没好不许先跑周期')

  rig.startup.request() // 第一次 onPageShow
  rig.setReady(true)
  rig.startup.onBridgeReady() // GitBridgeHost.onReady + ensureStarted 之后
  rig.startup.onBridgeReady() // 重复就绪回调
  rig.startup.request() // 第二次 onPageShow
  await rig.startup.settled()

  assert.equal(rig.state.coordinatorEntries, 1, '晚就绪仍只有一个协调器入口')
  assert.equal(rig.state.cycleCalls, 1, '不得因为「先 deferred 再 ready」跑出第二个周期')
  assert.equal(rig.state.commits, 1)
  assert.equal(rig.state.log.filter((item) => item === 'cycle').length, 1)
})

test('HSS-05 启动失败 ⇒ 恰好一条 typed 失败进唯一落点，零 toast；就绪永不到达也不静默', async () => {
  assert.equal(BRIDGE_NOT_READY_REASON, '同步内核未就绪，稍后重试')
  assert.equal(E_STARTUP_SYNC_UNAVAILABLE, 'E_SYNC_UNAVAILABLE')

  // (a) 协调器自身抛错：只有启动侧 reportFailure 一条，周期内部落点不重复。
  const throwing = makeRig({ ready: true, throwInRunOnce: 'E_IO: 启动周期不可用' })
  throwing.startup.request()
  await throwing.startup.settled()
  assert.deepEqual(throwing.state.failures, ['startup:E_IO: 启动周期不可用'])
  assert.equal(throwing.state.commits, 0)
  assert.equal(throwing.state.cycleCalls, 0)
  assert.equal(throwing.state.toasts, 0)

  // (b) 桥永未就绪：onBridgeFail 写一条 typed 原因；后续 ready 也不补跑，不产生第二次失败。
  const stuck = makeRig({ ready: false })
  stuck.startup.request()
  await stuck.startup.settled()
  stuck.startup.onBridgeFail()
  assert.deepEqual(stuck.state.failures, [`startup:${BRIDGE_NOT_READY_REASON}`])
  stuck.setReady(true)
  stuck.startup.onBridgeReady()
  await stuck.startup.settled()
  assert.equal(stuck.state.coordinatorEntries, 0, '失败后不得再跑周期（无重试循环）')
  assert.equal(stuck.state.failures.length, 1, '同一启动只留一条失败')
  assert.equal(stuck.state.toasts, 0)
})

// ---------------------------------------------------------------- 源码形状：静态钉住

test('HSS-06 Home 拥有 proven pages/Index 桥接线：GitBridgeHost + ensureStarted + 单闸入口', () => {
  // proven pattern 本身：Index 的隐藏桥就是 GitBridgeHost + ensureStarted；Home 必须同形。
  assert.match(INDEX, /GitBridgeHost\(\{[\s\S]{0,200}onReady/)
  assert.match(INDEX, /syncController\.ensureStarted\(controller\)/)
  for (const needle of ['GitBridgeHost({', 'syncController.ensureStarted(controller)',
    'syncController.isReady()', 'syncController.markBridgeFailed(message)']) {
    assert.ok(HOME.includes(needle), `Home 缺少 proven Index 桥接线的 ${needle}`)
  }
  const build = memberBody(HOME, 'build')
  assert.match(build, /GitBridgeHost\(\{/, '桥宿主必须挂在真入口页的渲染树里')
  assert.match(build, /onReady: \(controller: webview\.WebviewController\) => \{/)
  assert.match(build, /this\.onBridgeReady\(controller\)/)
  assert.match(build, /onFail: \(message: string\) => \{/)
  assert.match(build, /this\.onBridgeFail\(message\)/)
  // 与 Index 相同的不可见 1×1 挂法：不占布局、不参与交互。
  assert.match(build, /\.width\(BRIDGE_HOST_SIZE\)[\s\S]{0,120}\.height\(BRIDGE_HOST_SIZE\)[\s\S]{0,120}\.opacity\(0\)/)
  assert.match(build, /\.hitTestBehavior\(HitTestMode\.None\)/)

  const ready = memberBody(HOME, 'onBridgeReady')
  assert.ok(ready.indexOf('syncController.ensureStarted(controller)') < ready.indexOf('homeStartupSync.onBridgeReady()'),
    '必须先把内核建好，再放行启动周期（就绪顺序）')
  assert.match(ready, /homeStartupSync\.onBridgeFail\(BRIDGE_NOT_READY_REASON\)/)
  const fail = memberBody(HOME, 'onBridgeFail')
  assert.match(fail, /syncController\.markBridgeFailed\(message\)/)
  assert.match(fail, /homeStartupSync\.onBridgeFail\(BRIDGE_NOT_READY_REASON\)/)
  for (const [name, body] of [['onBridgeReady', ready], ['onBridgeFail', fail]]) {
    assert.doesNotMatch(body, /promptAction|showToast/, `${name} 不弹第二错误面`)
    assert.doesNotMatch(body, /setInterval|setTimeout/, `${name} 无定时器 / 轮询`)
  }
})

test('HSS-07 单闸证据：Home 只经 globalRefreshCoordinator.runOnce，没有直接 runConfiguredCycle(', () => {
  // 负向：真入口页不得出现**第二**直接周期入口。Home 早已在协调器 runCycle 钩子里注入
  // 唯一周期（mod-home-global-refresh 既有实现），本模块不得在启动路径上再写一处。
  const allCycleCalls = HOME.match(/runConfiguredCycle\s*\(/g) ?? []
  assert.equal(allCycleCalls.length, 1, 'Home 全页只能有协调器 runCycle 钩子里的那一处周期入口')
  assert.doesNotMatch(HOME, /syncController\.pullOnStartup\s*\(/, 'Home 不得走 legacy pull 旁路')
  assert.doesNotMatch(HOME, /syncController\.pullNow\s*\(/, 'Home 不得走 legacy pull 旁路')
  const appear = memberBody(HOME, 'aboutToAppear')
  const hookAt = appear.indexOf('runCycle: async')
  const nextHookAt = appear.indexOf('\n      markSyncing:', hookAt)
  assert.ok(hookAt >= 0 && nextHookAt > hookAt, '协调器必须仍有唯一 runCycle 钩子')
  assert.match(appear.slice(hookAt, nextHookAt), /syncProtocolStore\.runConfiguredCycle\(\)/,
    '那一处周期入口必须仍在协调器的 runCycle 钩子里')
  const outsideCycleHook = appear.slice(0, hookAt) + appear.slice(nextHookAt)
  assert.doesNotMatch(outsideCycleHook, /runConfiguredCycle\s*\(/, '启动路径不得直接调用 runConfiguredCycle(')
  const startupHooks = appear.slice(appear.indexOf('homeStartupSync.configure('))
  assert.doesNotMatch(startupHooks, /runConfiguredCycle\s*\(/, '启动钩子不得直连周期')
  assert.match(appear, /homeStartupSync\.configure\(\{/, 'Home 登记一次性启动钩子')
  assert.match(appear, /homeStartupSync\.request\(\)/, '冷启动提出一次请求')
  // mod-sync-silence-phase-b：仍是唯一协调器入口，只是多带一个触发名给 leader 日志。
  assert.match(appear, /globalRefreshCoordinator\.runOnce\(undefined, 'cold-launch'\)/,
    '唯一周期入口是协调器（冷启动名）')
  // mod-sync-silence-phase-b：判据抽成 Home.isSyncConfigured()，供冷启动 / 前台 / 网络共用。
  assert.match(HOME, /private async isSyncConfigured\(\): Promise<boolean>/, '判据单一来源方法仍在');
  assert.match(HOME, /isRepoConfigured\(input\)/, '已配置判据复用 repoConfigured 单一来源');
  assert.match(HOME, /settingsStore\.load\(ctx\)/, '配置冷读，不用过期缓存');
  assert.match(appear, /isConfigured: async \(\): Promise<boolean> => this\.isSyncConfigured\(\)/,
    '启动钩子复用同一判据');
  assert.doesNotMatch(appear, /promptAction|showToast/, '启动路径零 toast')
  const show = memberBody(HOME, 'onPageShow')
  assert.match(show, /homeStartupSync\.request\(\)/, '每次 show 都问一次，但进程内只消费一次')
  assert.doesNotMatch(show, /setInterval|setTimeout|requestAnimationFrame/, 'show 无定时器 / 轮询')
  assert.doesNotMatch(show, /runConfiguredCycle\s*\(|globalRefreshCoordinator/, 'show 不直接跑周期')

  // 纯模型只持有一个进程级单例；页面不得自行 new 另一份状态。
  assert.match(PURE, /export const homeStartupSync: HomeStartupSync = new HomeStartupSync\(\)/)
  assert.equal((PURE.match(/export const homeStartupSync/g) ?? []).length, 1)
  assert.doesNotMatch(HOME, /new HomeStartupSync\(/, 'Home 必须用单例，不另起一份「一次」状态')
  assert.equal(typeof homeStartupSync.request, 'function')

  // 一次性/延迟/失败三个不变量都住在纯模型里，可由真 spy 用例覆盖。
  assert.match(PURE, /if \(this\.requested\) \{[\s\S]{0,80}return;/, '一次配额同步抢占')
  assert.match(PURE, /if \(!hooks\.isBridgeReady\(\)\) \{[\s\S]{0,80}this\.deferred = true;/)
  assert.match(PURE, /await hooks\.runOnce\(\)/)
  assert.doesNotMatch(PURE, /runConfiguredCycle|setInterval|setTimeout|showToast|promptAction/)
})
