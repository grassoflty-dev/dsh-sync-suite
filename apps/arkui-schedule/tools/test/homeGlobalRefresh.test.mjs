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
const WRITER = stripComments(readEts('main/ets/services/recordWriter.ets'))

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
  // 顺序现在钉在 execute() 的 finally（成功 / 抛错共用同一段读回）：防止有人把读回挪回 catch 或提前 return。
  const execute = memberBody(MODEL, 'execute')
  const finallyAt = execute.indexOf('finally {')
  assert.ok(finallyAt > 0, 'execute 必须有 finally 读回块')
  const finallyBody = execute.slice(finallyAt)
  const pinned = ['reloadSchedule', 'reloadDots', 'reloadCloudChat', 'commitStatus']
  let previous = -1
  for (const key of pinned) {
    const at = finallyBody.indexOf(key)
    assert.ok(at > previous, `finally 读回顺序错乱 / 缺失：${key}`)
    previous = at
  }
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
  // mod-sync-single-flight：全 App 只保留这一条在飞 Promise（第二份 = 第二把闸）
  assert.equal((MODEL.match(/private inFlight:/g) ?? []).length, 1, '协调器只能有一条 inFlight')
  assert.equal((MODEL.match(/Promise<GlobalRefreshOutcome> \| null/g) ?? []).length, 1,
    '不得再出现第二条同形在飞 Promise')
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
  // mod-sync-ui-silence PHASE A：状态行只读，不再有「重试同步」点击出口。
  assert.doesNotMatch(row, /重试同步|立即同步|查看状态|测试连接/)
  assert.doesNotMatch(row, /\.onClick\s*\(/, '状态行不挂任何点击 handler')
  // 两个下拉入口本身都零 toast；失败全部经 syncStatusStore → 状态行
  assert.doesNotMatch(memberBody(SCHEDULE, 'onPullRefresh'), /promptAction|showToast/,
    '面板下拉失败不弹 toast')
  assert.doesNotMatch(MODEL, /showToast|promptAction/, '纯层零 toast')
  // 面板自己的下拉也走同一个协调器（不是第二条周期路径）
  assert.match(memberBody(SCHEDULE, 'onPullRefresh'), /globalRefreshCoordinator\.runOnce\(\{/,
    '面板下拉必须经同一把单飞闸')
  assert.doesNotMatch(memberBody(SCHEDULE, 'onPullRefresh'), /syncController\.pullNow/)
})

// ---------------------------------------------------------------- P1-D 两处 gap 的回归守卫

test('HGR-11 抛错也走 finally 的四个读回：schedule → dots → cloudChat → 状态面，失败只落一次', async () => {
  const log = []
  const reason = 'E_IO: 网络不可达'
  const probe = makeHooks(log, { throwError: new Error(reason) })
  const coordinator = new GlobalRefreshCoordinator()
  const out = await coordinator.runOnce(probe.hooks)

  assert.equal(probe.cycleCountOf(), 1)
  // 第四个（状态）步骤在抛错路径由 reportFailure 独占：commitStatus 不被调用（HGR-05 仍成立）。
  assert.deepEqual(log, ['syncing', 'cycle', 'schedule', 'dots', 'cloudChat', 'failure'])
  for (const hook of ['schedule', 'dots', 'cloudChat', 'failure']) {
    assert.equal(log.filter((item) => item === hook).length, 1, `${hook} 必须恰好一次`)
  }
  assert.equal(probe.failures.length, 1, 'typed 失败只记一次')
  assert.equal(probe.failures[0], reason)
  assert.equal(probe.commits.length, 0, '抛错路径不得再写一份 commitStatus')
  assert.equal(out.ok, false)
  assert.equal(out.reason, reason)
  assert.equal(coordinator.isRefreshing(), false)
  assert.doesNotMatch(MODEL, /showToast|promptAction/, '抛错路径同样零 toast')

  // 负向守卫：catch 不得 return / 不得自己读回，四个读回只能出现在 finally 里。
  const execute = memberBody(MODEL, 'execute')
  const tryAt = execute.indexOf('try {')
  const catchAt = execute.indexOf('} catch (error) {')
  const finallyAt = execute.indexOf('} finally {')
  assert.ok(tryAt >= 0 && catchAt > tryAt && finallyAt > catchAt, 'try/catch/finally 必须连成一段')
  const catchBody = execute.slice(catchAt, finallyAt)
  assert.doesNotMatch(catchBody, /\breturn\b/, 'catch 里的 return 会绕过 finally 的四个读回')
  assert.doesNotMatch(catchBody,
    /reloadSchedule|reloadDots|reloadCloudChat|commitStatus|reportFailure/,
    'catch 不得自行读回 / 写状态（唯一落点在 finally 的最后一步）')
  const finallyBody = execute.slice(finallyAt)
  for (const key of ['reloadSchedule', 'reloadDots', 'reloadCloudChat']) {
    assert.equal((finallyBody.match(new RegExp(`hooks\\.${key}\\(`, 'g')) ?? []).length, 1,
      `${key} 只能在 finally 调用一次`)
  }
  // 失败路径两处 reportFailure 调用点：隐私码无隐私落点时的兜底 + 普通错误；每次运行只走一条（HGR-13 钉）。
  assert.equal((finallyBody.match(/hooks\.reportFailure\(/g) ?? []).length, 2,
    'reportFailure 只能有隐私码兜底与普通失败两个互斥调用点')
})

test('HGR-12 自动同步 + 面板下拉共用单闸：一次周期 / 一次提交 / 四个读回一次，跟随者拿到完成结果', async () => {
  const log = []
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const probe = makeHooks(log, { gate }) // cycle 卡在 gate 上 = 自动同步在飞
  const coordinator = new GlobalRefreshCoordinator()
  coordinator.configure(probe.hooks) // Home 登记的完整四读回（与真机一致）

  // ① 写后自动同步（recordWriter.triggerSync 的形状）：只覆盖 runCycle，继承 Home 的四读回。
  const auto = coordinator.runOnce({ runCycle: probe.hooks.runCycle })
  assert.equal(coordinator.isRefreshing(), true, '自动同步已占闸')
  // ② 用户立即下拉：第二个入口必须共享同一 Promise，而不是另起周期。
  const pull = coordinator.runOnce()
  assert.equal(coordinator.isRefreshing(), true, '下拉不得另起周期')

  release()
  const [autoOut, pullOut] = await Promise.all([auto, pull])
  assert.equal(probe.cycleCountOf(), 1, '自动同步 + 下拉只能调用一次 runConfiguredCycle')
  assert.equal(probe.commits.length, 1, '因此只有一次 commitStatus / 一次仓库提交')
  assert.deepEqual(log, ['syncing', 'cycle', 'schedule', 'dots', 'cloudChat', 'status'])
  assert.equal(autoOut.leader, true)
  assert.equal(pullOut.leader, false)
  assert.equal(pullOut.cycleInvoked, false)
  assert.equal(pullOut.ok, true, '下拉调用方仍观察到已完成的结果（不是被静默跳过）')

  // 单闸覆盖四个入口：写后自动同步、外壳下拉、面板下拉、面板「重试同步」。
  for (const [name, body] of [
    ['recordWriter.triggerSync', memberBody(WRITER, 'triggerSync')],
    ['Home.onGlobalPull', memberBody(HOME, 'onGlobalPull')],
    ['SchedulePane.onPullRefresh', memberBody(SCHEDULE, 'onPullRefresh')],
    ['SchedulePane.retrySync', memberBody(SCHEDULE, 'retrySync')]
  ]) {
    assert.match(body, /globalRefreshCoordinator\.runOnce\(/, `${name} 必须经同一把单飞闸`)
  }
  assert.doesNotMatch(memberBody(WRITER, 'triggerSync'), /syncProtocolStore\.runConfiguredCycle\(\)\s*\.then/,
    '自动同步不得绕开协调器自行 .then 一个周期')
  assert.doesNotMatch(memberBody(WRITER, 'triggerSync'), /showToast|promptAction/,
    '自动同步路径零 toast')
})

test('HGR-13 一个失败周期一条状态：已仓库阻塞优先，隐私码走隐私落点，普通错误才走通用失败', async () => {
  const PRIVACY_TEXT = '仓库已变为公开，已停止上传（最近尝试 12:34）'
  const log = []
  const status = { text: PRIVACY_TEXT, writes: [] }
  let cycles = 0
  const blockedHooks = {
    runCycle: async () => { cycles++; log.push('cycle'); throw new Error('E_IO: 网络不可达') },
    markSyncing: () => { log.push('syncing'); status.writes.push('syncing'); status.text = '同步中…' },
    reloadSchedule: () => { log.push('schedule') },
    reloadDots: () => { log.push('dots') },
    reloadCloudChat: () => { log.push('cloudChat') },
    commitStatus: () => { log.push('status'); status.writes.push('status') },
    reportFailure: (reason) => { log.push('failure'); status.writes.push('failure'); status.text = `失败：${reason}` },
    isRepoBlocked: () => { log.push('blockCheck'); return true },
    reportRepoBlocked: (code) => { log.push('repoBlocked'); status.writes.push('repoBlocked'); status.text = code }
  }
  const out = await new GlobalRefreshCoordinator().runOnce(blockedHooks)
  assert.equal(cycles, 1)
  // 四个读回仍在；连「同步中…」都被跳过，状态面一次都没写 ⇒ 隐私文案原样保留。
  assert.deepEqual(log.filter((item) => item !== 'blockCheck'), ['cycle', 'schedule', 'dots', 'cloudChat'])
  assert.deepEqual(status.writes, [], '失败不得覆盖仓库阻塞态')
  assert.equal(status.text, PRIVACY_TEXT, '只有一个状态字符串，且是隐私那一条')
  assert.equal(out.ok, false)

  // 抛错本身就带隐私码：只走隐私落点，不写通用「失败：」。
  const privacyLog = []
  const privacyWrites = []
  let privacyText = ''
  await new GlobalRefreshCoordinator().runOnce({
    runCycle: async () => { throw new Error('E_REPO_PUBLIC: 仓库是公开的') },
    reloadSchedule: () => { privacyLog.push('schedule') },
    reloadDots: () => { privacyLog.push('dots') },
    reloadCloudChat: () => { privacyLog.push('cloudChat') },
    isRepoBlocked: () => false,
    reportRepoBlocked: (code) => { privacyWrites.push(code); privacyText = '仓库已变为公开，已停止上传（最近尝试 12:35）' },
    reportFailure: (reason) => { privacyWrites.push(`generic:${reason}`) }
  })
  assert.deepEqual(privacyWrites, ['E_REPO_PUBLIC'], '隐私码只落一次隐私路径')
  assert.match(privacyText, /已停止上传/)
  assert.deepEqual(privacyLog, ['schedule', 'dots', 'cloudChat'], '四个读回不受影响')

  // 反向：无隐私态的普通抛错仍走通用 typed 失败恰好一次（HGR-11 继续成立）。
  const plainLog = []
  const plain = makeHooks(plainLog, { throwError: new Error('E_IO: 网络不可达') })
  await new GlobalRefreshCoordinator().runOnce(plain.hooks)
  assert.deepEqual(plain.failures, ['E_IO: 网络不可达'])
  assert.equal(plain.commits.length, 0)

  // 真机接线：Home 登记只读判定 + 隐私落点，自动同步在 Home 未登记时也有同形兜底。
  assert.match(memberBody(HOME, 'aboutToAppear'), /isRepoBlocked: \(\)(:\s*boolean)? => isRepoBlockedStatus\(syncStatusStore\.snapshot\(\)\)/)
  assert.match(memberBody(HOME, 'aboutToAppear'), /reportRepoBlocked: \(code: string\): void => \{/)
  assert.match(memberBody(WRITER, 'triggerSync'), /overrides\.isRepoBlocked = \(\)(:\s*boolean)? => isRepoBlockedStatus\(syncStatusStore\.snapshot\(\)\)/)
})

test('HGR-14 存储层守卫：早退失败不覆盖阻塞与戳，隐私码刷新，成功 / 实时复核通过两条出口', async () => {
  const ts = (await import('typescript')).default
  const persist = await import('../.build/model/syncStatusPersist.js')
  const visibility = await import('../.build/model/repoVisibility.js')
  const STORE = stripComments(readEts('main/ets/services/syncStatusStore.ets'))
  const CHECKER = stripComments(readEts('main/ets/services/repoVisibilityChecker.ets'))

  // 从真实 .ets 截出 SyncStatusStore 类 + 键常量，tsc 转译后在假 AppStorage 上执行生产方法本体。
  const classAt = STORE.indexOf('export class SyncStatusStore')
  assert.ok(classAt >= 0, '找不到 SyncStatusStore')
  const [clsStart, clsEnd] = matchBrace(STORE, STORE.indexOf('{', classAt))
  const classSrc = STORE.slice(classAt, clsEnd).replace(/^export\s+/, '')
  const consts = /const KEY_STATE[\s\S]*?const UNKNOWN_REASON: string = '[^']*';/.exec(STORE)
  assert.ok(consts !== null, '找不到状态键常量段')
  const helpers = /function two\([\s\S]*?\n\}\s*function hhmm\([\s\S]*?\n\}/.exec(STORE)
  assert.ok(helpers !== null, '找不到 HH:MM 纯函数')
  const js = ts.transpileModule(`${consts[0]}\n${helpers[0]}\n${classSrc}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.None }
  }).outputText

  function newStore() {
    const map = new Map()
    const AppStorageStub = {
      get: (key) => map.has(key) ? map.get(key) : undefined,
      setOrCreate: (key, value) => { map.set(key, value) }
    }
    const Factory = new Function(
      'AppStorage', 'E_REPO_PUBLIC', 'E_REPO_VISIBILITY_UNKNOWN', 'repoBlockStatusText',
      'TEXT_NEVER', 'bootSurface', 'commitStatus', 'readStatus', 'SYNC_STATUS_KEY',
      `${js}\nreturn SyncStatusStore;`
    )
    const Store = Factory(
      AppStorageStub,
      visibility.E_REPO_PUBLIC, visibility.E_REPO_VISIBILITY_UNKNOWN, visibility.repoBlockStatusText,
      persist.TEXT_NEVER, persist.bootSurface, persist.commitStatus, persist.readStatus, persist.SYNC_STATUS_KEY
    )
    const store = new Store()
    let raw = ''
    store.storage = { read: () => raw, write: (next) => { raw = next } }
    return { store, map }
  }

  // (a) 已阻塞 + E_SYNC_UNAVAILABLE 早退 ⇒ 阻塞文案与原「最近尝试」戳都不变，零「失败：」。
  {
    const { store, map } = newStore()
    const blocked = store.setRepoBlocked(visibility.E_REPO_PUBLIC, new Date('2026-11-22T12:34:00Z'))
    const stamp = map.get('timeline.sync.repoBlockAt')
    const early = { ...badResult('E_SYNC_UNAVAILABLE: 同步内核尚未就绪'), code: 'E_SYNC_UNAVAILABLE' }
    const after = store.fromCycle(early, new Date('2026-11-22T14:00:00Z'))
    assert.equal(after.state, 'repo_public')
    assert.equal(after.text, blocked.text)
    assert.equal(after.lastAt, stamp, '无关失败不得重盖最近尝试时刻')
    assert.equal(map.get('timeline.sync.repoBlockAt'), stamp)
    assert.equal(after.text.includes('失败：'), false)
    // setFailed 是唯一失败写入口：其它调用点直接写也必须被同一道闸拦住。
    const direct = store.setFailed('E_IO: 网络不可达')
    assert.equal(direct.text, blocked.text)
    assert.equal(map.get('timeline.sync.repoBlockAt'), stamp)
  }

  // (b) 已阻塞 + 隐私码 ⇒ 刷新阻塞态（这次是真尝试，戳允许更新）。
  {
    const { store, map } = newStore()
    store.setRepoBlocked(visibility.E_REPO_PUBLIC, new Date('2026-11-22T12:34:00Z'))
    const stamp = map.get('timeline.sync.repoBlockAt')
    const refreshed = store.fromCycle(
      { ...badResult('公开仓库'), code: visibility.E_REPO_PUBLIC },
      new Date('2026-11-22T13:45:00Z')
    )
    assert.equal(refreshed.state, 'repo_public')
    assert.match(refreshed.text, /已停止上传/)
    assert.notEqual(map.get('timeline.sync.repoBlockAt'), stamp, '隐私重试应当更新戳')
  }

  // (c) 已阻塞 + 成功周期 ⇒ 唯一合法出口：正常「已同步 · HH:MM」。
  {
    const { store } = newStore()
    store.setRepoBlocked(visibility.E_REPO_PUBLIC, new Date('2026-11-22T12:34:00Z'))
    const synced = store.fromCycle(okResult(), new Date('2026-11-22T14:00:00Z'))
    assert.equal(synced.state, 'synced')
    assert.match(synced.text, /^已同步 · /)
  }

  // (d) 实时复核通过 ⇒ 立刻解除，回到真实中性面；不伪造同步，不动上次成功时刻。
  {
    const { store, map } = newStore()
    map.set('timeline.sync.lastAt', '09:17') // 上一次真实成功的时刻（哨兵）
    store.setRepoBlocked(visibility.E_REPO_VISIBILITY_UNKNOWN, new Date('2026-11-22T12:34:00Z'))
    const cleared = store.clearRepoBlock()
    assert.notEqual(cleared.state, 'repo_public')
    assert.notEqual(cleared.state, 'repo_unknown')
    assert.equal(cleared.text, persist.TEXT_NEVER, '盘上没有真实结果 ⇒ 尚未同步')
    assert.equal(cleared.text.includes('已同步'), false)
    assert.equal(map.get('timeline.sync.lastAt'), '09:17', '解除阻塞不得改写 lastSyncAt')
    assert.equal(map.get('timeline.sync.repoBlockAt'), '', '戳已重置')
  }

  // 守卫位置与绕过面：setFailed 有 fromCycle 之外的直接调用点，所以不变量必须在 store。
  assert.match(memberBody(STORE, 'fromCycle'), /repoBlockedNow\(\)/)
  assert.match(memberBody(STORE, 'setFailed'), /repoBlockedNow\(\)/)
  assert.doesNotMatch(memberBody(STORE, 'setFailed'), /KEY_REPO_BLOCK_AT/, '失败写入不重盖尝试戳')
  assert.doesNotMatch(memberBody(STORE, 'clearRepoBlock'), /setSynced|this\.commit/, '解除阻塞不是同步、不落盘')
  assert.match(CHECKER, /syncStatusStore\.clearRepoBlock\(\)/, '复核通过由校验器触发、store 执行')
  const HOME_SRC = stripComments(readEts('main/ets/pages/Home.ets'))
  assert.match(memberBody(HOME_SRC, 'aboutToAppear'), /syncStatusStore\.setFailed\(reason\)/,
    '确有绕过 fromCycle 的直接调用点 ⇒ 守卫必须在 setFailed')
})
