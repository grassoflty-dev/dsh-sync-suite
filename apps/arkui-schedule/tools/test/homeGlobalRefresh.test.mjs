// 首页全局下拉刷新守卫（mod-home-global-refresh / P1-D）。
//
// 两层证据：
//   ① **单元（真 spy）**：`model/homeGlobalRefresh.ts` 编译成 `.build/model/homeGlobalRefresh.js` 后
//      注入 spy 钩子，直接断言 call count / 顺序 / 共享 Promise / 单一失败落点——不是 prose。
//   ② **源码形状**：ArkUI 不能进 Node，外壳 Refresh 容器、@Prop tick、保活、状态行单点、
//      两种朝向只能静态钉住；这里明确标出哪些是静态的。
// 不碰 p0a lane 的 syncWiring / syncInit / fixSyncRetry 等测试（它们继续钉原周期路径）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { readEts, stripComments, matchBrace } from './helpers/etsSource.mjs'
import { requireOverlayRestored } from './guard.mjs'

requireOverlayRestored('homeGlobalRefresh.test.mjs')

// tsc 产物里的相对 import 不带 .js（与 syncWiring.test.mjs 同款口径），用标准 loader 补后缀。
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

const { GlobalRefreshCoordinator, GLOBAL_REFRESH_ACTION } =
  await import('../.build/model/homeGlobalRefresh.js')

const HOME = stripComments(readEts('main/ets/pages/Home.ets'))
const SCHEDULE = stripComments(readEts('main/ets/pages/panes/SchedulePane.ets'))
const DOTS = stripComments(readEts('main/ets/pages/panes/DotsPane.ets'))
const CLOUD = stripComments(readEts('main/ets/pages/panes/CloudChatPane.ets'))
const MODEL = stripComments(readEts('main/ets/model/homeGlobalRefresh.ts'))

/** 取 `name(...) { … }` 方法体（容忍 private / async 前缀，source-shape 用，保留换行）。 */
function memberBody(source, name) {
  const found = new RegExp(`\\n  (?:private |public |async )*${name}\\(`).exec(source)
  assert.ok(found !== null, `找不到方法 ${name}`)
  const [start, end] = matchBrace(source, source.indexOf('{', found.index))
  return source.slice(start + 1, end - 1)
}

/** 一个成功结果（字段与真实 CycleResult 同形）。 */
function okResult() {
  return { ok: true, code: 'ok', message: '已同步', days: 1, conflicts: 0, added: 0,
    dropped: [], pending: 0, failed: 0, attempts: 1 }
}

/** 一个 typed 失败结果。 */
function badResult(reason) {
  return { ok: false, code: 'E_AUTH', message: reason, days: 0, conflicts: 0, added: 0,
    dropped: [], pending: 0, failed: 1, attempts: 1 }
}

/**
 * 注入 spy 钩子：把每次副作用写进 log，并单独计 cycle 次数。
 * options.result / options.throwError / options.gate 控制周期返回形态。
 */
function makeHooks(log, options = {}) {
  let cycleCount = 0
  const commits = []
  const failures = []
  const hooks = {
    runCycle: async () => {
      cycleCount++
      log.push('cycle')
      if (options.gate !== undefined) {
        await options.gate
      }
      if (options.throwError !== undefined) {
        throw options.throwError
      }
      return options.result === undefined ? okResult() : options.result
    },
    markSyncing: () => { log.push('syncing') },
    reloadSchedule: () => { log.push('schedule') },
    reloadDots: () => { log.push('dots') },
    reloadCloudChat: () => { log.push('cloudChat') },
    commitStatus: (result) => { log.push('status'); commits.push(result) },
    reportFailure: (reason) => { log.push('failure'); failures.push(reason) }
  }
  return { hooks, cycleCountOf: () => cycleCount, commits, failures }
}

// ---------------------------------------------------------------- 单元：真 spy 调用计数 / 顺序

test('HGR-01 一次下拉 ⇒ 唯一周期入口恰好调用一次（spy call count）', async () => {
  const log = []
  const probe = makeHooks(log)
  const coordinator = new GlobalRefreshCoordinator()
  const out = await coordinator.runOnce(probe.hooks)
  assert.equal(probe.cycleCountOf(), 1, '周期只能调用一次')
  assert.equal(out.cycleInvoked, true)
  assert.equal(out.leader, true)
  assert.equal(out.ok, true)
  assert.equal(coordinator.isRefreshing(), false, '结束后必须放闸')
})

test('HGR-02 四个读回按固定顺序：周期 → 日程 → dots → 云端 → 状态存储（最后）', async () => {
  const log = []
  const probe = makeHooks(log)
  await new GlobalRefreshCoordinator().runOnce(probe.hooks)
  assert.deepEqual(log, ['syncing', 'cycle', 'schedule', 'dots', 'cloudChat', 'status'])
})

test('HGR-03 两次并发下拉：周期一次、读回一次，第二个 caller 仍 await 到完成结果', async () => {
  const log = []
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const probe = makeHooks(log, { gate })
  const coordinator = new GlobalRefreshCoordinator()

  const first = coordinator.runOnce(probe.hooks)
  assert.equal(coordinator.isRefreshing(), true, '第一个下拉已占闸')
  const second = coordinator.runOnce(probe.hooks)
  assert.equal(coordinator.isRefreshing(), true, '第二个下拉不得另起周期')

  release()
  const [a, b] = await Promise.all([first, second])
  assert.equal(probe.cycleCountOf(), 1, '两个手势只跑一个周期')
  assert.equal(a.leader, true)
  assert.equal(b.leader, false, '第二个是跟随者')
  assert.equal(b.cycleInvoked, false)
  assert.equal(b.ok, true, '跟随者也拿到已完成的结果（不是静默跳过）')
  assert.deepEqual(log, ['syncing', 'cycle', 'schedule', 'dots', 'cloudChat', 'status'])
})

test('HGR-04 失败结果 ⇒ 单一 typed 失败落点：commitStatus 一次、零 toast、零 pane 级错误副本', async () => {
  const log = []
  const probe = makeHooks(log, { result: badResult('E_AUTH: 令牌无效（可重试）') })
  const out = await new GlobalRefreshCoordinator().runOnce(probe.hooks)
  assert.equal(probe.cycleCountOf(), 1)
  assert.equal(probe.commits.length, 1, '只有状态存储一次落点')
  assert.equal(probe.commits[0].message, 'E_AUTH: 令牌无效（可重试）', 'typed 原因逐字透传')
  assert.equal(probe.failures.length, 0, '失败结果不再走第二处 reportFailure')
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'E_AUTH: 令牌无效（可重试）')
  assert.equal(log.filter((item) => item === 'failure' || item === 'toast').length, 0)
})

test('HGR-05 周期抛错 ⇒ reportFailure 恰好一次，闸正常释放，零第二落点', async () => {
  const log = []
  const probe = makeHooks(log, { throwError: new Error('E_IO: 网络不可达') })
  const coordinator = new GlobalRefreshCoordinator()
  const out = await coordinator.runOnce(probe.hooks)
  assert.equal(probe.failures.length, 1)
  assert.equal(probe.failures[0], 'E_IO: 网络不可达')
  assert.equal(probe.commits.length, 0, '抛错与失败结果互斥，恰好一条')
  assert.equal(out.ok, false)
  assert.equal(coordinator.isRefreshing(), false, '异常路径也必须放闸')
})

test('HGR-06 单飞闸复用 model/syncGuard 原语（不是第二把锁）', () => {
  assert.equal(GLOBAL_REFRESH_ACTION, 'globalRefresh')
  assert.match(MODEL, /from '\.\/syncGuard'/)
  assert.match(MODEL, /beginExclusive\(this\.run, GLOBAL_REFRESH_ACTION\)/)
  assert.match(MODEL, /endExclusive\(this\.run, GLOBAL_REFRESH_ACTION\)/)
  // 抢闸必须在第一个 await 之前（否则并发两跳会漏闸）
  const atMethod = MODEL.indexOf('async runOnce(')
  assert.notEqual(atMethod, -1)
  const [start, end] = matchBrace(MODEL, MODEL.indexOf('{', atMethod))
  const runOnce = MODEL.slice(start + 1, end - 1)
  const atBegin = runOnce.indexOf('beginExclusive(')
  const atExecute = runOnce.indexOf('this.execute(')
  assert.ok(atBegin >= 0 && atExecute > atBegin, '抢闸早于 execute（execute 内才有第一个 await）')
  // 抢闸与 execute 之间只允许同步的 hooksOf / Promise 构造，不得插入 await
  assert.doesNotMatch(runOnce.slice(atBegin, atExecute), /await\s/)
})

// ---------------------------------------------------------------- 源码形状：静态钉住（ArkUI 不可执行）

test('HGR-07 外壳 owns 唯一 Refresh 容器，包住整个外壳（竖屏 / 横屏共用），失败不弹 toast', () => {
  assert.equal((HOME.match(/Refresh\(\{ refreshing: \$\$this\.globalRefreshing \}\)/g) ?? []).length, 1,
    '外壳只有一个全局 Refresh 容器')
  const build = memberBody(HOME, 'build')
  assert.match(build, /^\s*Refresh\(\{ refreshing: \$\$this\.globalRefreshing \}\)/,
    'Refresh 是 build() 最外层容器')
  assert.match(build, /\.onRefreshing\(\(\) => \{/, '外壳接住下拉手势')
  assert.match(build, /this\.onGlobalPull\(\)/, '下拉只转交协调器')
  // 两种朝向都还在同一个 Refresh 里（宽屏常驻轨 + compact 抽屉本体 + 内容 Stack）
  assert.match(build, /if \(!this\.isCompact\(\)\) \{[\s\S]*?ShellRail\(\{/, '横屏 / 宽屏常驻轨在 Refresh 内')
  assert.match(build, /if \(this\.isCompact\(\)\) \{[\s\S]*?ShellRail\(\{/, 'compact 抽屉轨在 Refresh 内')
  assert.equal((build.match(/Stack\(\{ alignContent: Alignment\.TopStart \}\)/g) ?? []).length, 2,
    'root 覆盖层 Stack + 内容面板 Stack 仍在唯一 Refresh 内')
  // 外壳的下拉路径零 toast：typed 失败只由状态行渲染
  const pull = memberBody(HOME, 'onGlobalPull')
  assert.doesNotMatch(pull, /promptAction|showToast|失败：/, '外壳下拉路径不得弹第二处失败提示')
  const onRefreshing = build.slice(build.indexOf('.onRefreshing('))
  assert.doesNotMatch(onRefreshing, /promptAction|showToast/, '转圈复位路径零 toast')
})

test('HGR-08 四个读回钩子在 Home 登记，tick 传给三个保活面板；布局纪律不变', () => {
  const appear = memberBody(HOME, 'aboutToAppear')
  assert.match(appear, /globalRefreshCoordinator\.configure\(\{/, 'Home 登记完整钩子')
  const order = ['runCycle', 'markSyncing', 'reloadSchedule', 'reloadDots', 'reloadCloudChat', 'commitStatus']
  let previous = -1
  for (const key of order) {
    const at = appear.indexOf(`${key}:`)
    assert.ok(at > previous, `Home 钩子 ${key} 顺序错乱 / 缺失`)
    previous = at
  }
  assert.match(HOME, /DotsPane\(\{[\s\S]{0,260}globalRefreshTick: this\.dotsRefreshTick/)
  assert.match(HOME, /CloudChatPane\(\{[\s\S]{0,260}globalRefreshTick: this\.cloudChatRefreshTick/)
  assert.match(HOME, /SchedulePane\(\{[\s\S]{0,300}globalRefreshTick: this\.scheduleRefreshTick/)
  assert.match(HOME, /SchedulePane\(\{[\s\S]{0,320}statusRefreshTick: this\.statusRefreshTick/)
  // 唯一 flex 切分不变：Refresh 包在外层，不新增 layoutWeight / 固定高度 Column
  assert.equal((HOME.match(/layoutWeight\(1\)/g) ?? []).length, 1, '仍只有一处结构性 flex 切分')
})

test('HGR-09 三个保活面板暴露 tick 读回钩子；只读盘、零第二周期、零 toast', () => {
  for (const [name, source] of [['DotsPane', DOTS], ['CloudChatPane', CLOUD], ['SchedulePane', SCHEDULE]]) {
    assert.match(source, new RegExp(`@Prop @Watch\\('onGlobalRefreshTick'\\) globalRefreshTick: number = 0;`),
      `${name} 必须暴露全局读回 tick`)
    const watcher = memberBody(source, 'onGlobalRefreshTick')
    assert.match(watcher, /this\.reload\(\)/, `${name} 的读回只重读本面板数据源`)
    assert.doesNotMatch(watcher, /runConfiguredCycle|syncController|pullNow|promptAction|showToast/,
      `${name} 读回不得重跑周期或弹 toast`)
    assert.match(source, /@Prop active: boolean = true;/, `${name} 保活 prop 不变`)
    assert.match(source, /\.visibility\(this\.active \? Visibility\.Visible : Visibility\.Hidden\)/,
      `${name} 仍用 Hidden 保活`)
    assert.equal((source.match(/aboutToAppear\(/g) ?? []).length, 1, `${name} 仍只有一个 aboutToAppear`)
  }
  assert.match(SCHEDULE, /@Prop @Watch\('onStatusRefreshTick'\) statusRefreshTick: number = 0;/)
  assert.match(memberBody(SCHEDULE, 'onStatusRefreshTick'), /this\.syncStatus = syncStatusStore\.snapshot\(\)/)
})

test('HGR-10 失败只有一个渲染面：状态行；下拉路径零 toast、零第二处「失败：」插值', () => {
  // 第二个 typed 失败插值只能出现在「刷新失败路径」；面板自身的本地读失败文案不属于这条路径。
  for (const [name, body] of [
    ['Home.onGlobalPull', memberBody(HOME, 'onGlobalPull')],
    ['SchedulePane.onPullRefresh', memberBody(SCHEDULE, 'onPullRefresh')],
    ['pure model', MODEL]
  ]) {
    assert.doesNotMatch(body, /失败：\$\{|showToast|promptAction/, `${name} 不得再拼第二处 typed 失败文案 / toast`)
  }
  // 唯一渲染点仍是日程面板的 SyncStatusRow（p0a 的 syncWiring 62b 也钉它）
  const row = memberBody(SCHEDULE, 'SyncStatusRow')
  assert.match(row, /Text\(this\.syncStatus\.text\)/, '状态行是唯一 typed 失败渲染点')
  assert.match(row, /this\.syncStatus\.state === 'failed'/)
  assert.match(row, /重试同步/)
  // 两个下拉入口本身都零 toast；失败全部经 syncStatusStore → 状态行
  assert.doesNotMatch(memberBody(SCHEDULE, 'onPullRefresh'), /promptAction|showToast/,
    '面板下拉失败不弹 toast')
  assert.doesNotMatch(MODEL, /showToast|promptAction/, '纯层零 toast')
  // 面板自己的下拉也走同一个协调器（不是第二条周期路径）
  assert.match(memberBody(SCHEDULE, 'onPullRefresh'), /globalRefreshCoordinator\.runOnce\(\{/,
    '面板下拉必须经同一把单飞闸')
  assert.doesNotMatch(memberBody(SCHEDULE, 'onPullRefresh'), /syncController\.pullNow/)
})
