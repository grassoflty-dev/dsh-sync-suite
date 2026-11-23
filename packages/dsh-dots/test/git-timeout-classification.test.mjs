/**
 * mod-plugin-git-timeout-classification：**超时**与**网络不可达**必须是两种结局。
 *
 * D1（错标）：以前子进程被 8s 预算杀死，会以「网络不可达」的身份到达用户；
 * D2（无预热）：首次网络调用把 askpass/node 冷启动成本算进网络预算。
 *
 * 本文用四种注入面证明（前置：cd packages/dsh-dots && node scripts/build.mjs）：
 *   - 真实回环 TCP 服务（只 accept 不响应）→ 真实 git 子进程被预算杀死；
 *   - `GitRepo(execFileImpl)` 注入 → 结构信号 `killed`，与 stderr 内容/语言无关；
 *   - `GitRepoV2Port(runner)` 注入 → push 失败的五种形状逐条分类；
 *   - `GitRepoV2Port(execFileImpl)` 注入 → 观察 push 实际拿到的预算（120s 专属档，
 *     不是读命令的 8s/20s），并证明「9 秒的慢推送不会被杀」。
 * 所有临时目录都在 os.tmpdir() 下，不碰 ~/.dsh/dots，不跑 live 同步，不写项目仓库。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'

import {
  FIRST_NETWORK_TIMEOUT_MS,
  GIT_TIMEOUT_NEXT_STEP,
  GitRepo,
  NETWORK_TIMEOUT_MS,
  PUSH_TIMEOUT_MS,
  gitAuthEnv,
  gitTimeoutMessage,
  hasTransportEvidence,
  resetNetworkCallBudget,
} from '../dist/engine/git.js'
import {
  ASKPASS_NODE_MISSING_CODE,
  ASKPASS_NODE_MISSING_REASON,
  askpassNodeWarmUp,
  resetAskpassNodeWarmUp,
} from '../dist/engine/nodePath.js'
import { SyncError } from '../dist/engine/errors.js'
import {
  GitRepoV2Port, PUSH_TIMEOUT_REASON_TEMPLATE, pushFailureReason, pushTimeoutReason,
} from '../dist/sync/gitPort.js'
import {
  PUSH_ARGS, PUSH_TIMEOUT_NEXT_STEP, PUSH_UNREACHABLE_NEXT_STEP, V2_ERROR,
  makeIntentId, runV2Cycle,
} from '../dist/sync/cycle.js'
import { FRESH_SCHEMA_TEXT } from '../dist/timeline/index.js'

const DAY = '2026-11-23'
const TS = `${DAY}T01:30:00.000Z`
const TS_LOCAL = `${DAY}T09:30:00+08:00`
const HTTPS = 'https://gitee.com/acme/repo.git'
const FAKE_TOKEN = 'rt_FAKE_TOKEN_0123456789'

/* -------------------------------------------------------------------------- */
/* 夹具                                                                        */
/* -------------------------------------------------------------------------- */

/** push 只用到 runner：authMode=ssh 让 buildEnv 不起 askpass/node（分类与鉴权无关）。 */
function portWithRunner(runner, extra = {}) {
  return new GitRepoV2Port({
    dir: path.join(os.tmpdir(), 'dsh-timeout-class-unused'),
    repoUrl: HTTPS,
    branch: 'main',
    authMode: 'ssh',
    token: null,
    runner,
    ...extra,
  })
}

/** 同上的「不走 runner、走 execFile 注入」版本：用来观察 push 实际拿到的预算。 */
function portWithExec(execFileImpl, extra = {}) {
  return new GitRepoV2Port({
    dir: path.join(os.tmpdir(), 'dsh-timeout-class-unused'),
    repoUrl: HTTPS,
    branch: 'main',
    authMode: 'ssh',
    token: null,
    execFileImpl,
    ...extra,
  })
}

/**
 * 假 execFile：记录每条子进程实际拿到的 `options.timeout`，并按模拟时长给出结局。
 *
 * 时长 > 预算时按 Node 的真实行为回调 `killed: true`（结构信号）；否则按时长成功。
 * 于是「同一份 9 秒输入，只改预算」就能证明预算换了、结局才换了（回归守卫不空转）。
 */
function makeExec({ seen, durationMs = 0, stdout = '', stderr = '' }) {
  const impl = (file, args, options, callback) => {
    seen.push({ file, args, options })
    const timeout = typeof options.timeout === 'number' ? options.timeout : null
    setImmediate(() => {
      if (timeout !== null && durationMs > timeout) {
        callback(Object.assign(new Error('Command failed'), { killed: true, code: 'ETIMEDOUT' }), '', '')
        return
      }
      callback(null, stdout, stderr)
    })
  }
  return { impl }
}

/** 直接驱动一次假 execFile（阳性对照用：给旧预算，看同一时长是否被杀）。 */
function runFake(impl, args, timeoutMs) {
  return new Promise((resolve) => {
    impl('git', args, { timeout: timeoutMs, killSignal: 'SIGTERM' }, (error) => {
      resolve({ killed: error !== null && error.killed === true })
    })
  })
}

function okRunner(calls) {
  return async (cwd, args) => {
    calls?.push(args)
    return { code: 0, stdout: '', stderr: '' }
  }
}

function failRunner(stderr, code = 128) {
  return async () => ({ code, stdout: '', stderr })
}

/** 捕获 typed 错误对象（assert.rejects 的校验函数不便复用细节断言）。 */
async function captureRejection(fn) {
  try {
    await fn()
  } catch (error) {
    return error
  }
  assert.fail('预期抛出 typed 错误，实际成功了')
}

class MemFs {
  constructor(seed = {}) { this.files = new Map(Object.entries(seed)) }
  async read(rel) { return this.files.has(rel) ? this.files.get(rel) : null }
  async writeTemp(rel, text) { const tmp = `${rel}.tmp`; this.files.set(tmp, text); return tmp }
  async readTemp(tmp) { return this.files.get(tmp) ?? '' }
  async rename(tmp, rel) { this.files.set(rel, this.files.get(tmp)); this.files.delete(tmp) }
  async backupIfExists() { return false }
  async append(rel, text) { this.files.set(rel, (this.files.get(rel) ?? '') + text) }
  async exists(rel) { return this.files.has(rel) }
}

class MemOutbox {
  constructor(entries) { this.entries = entries.slice() }
  async load() { return this.entries.slice() }
  async save(entries) { this.entries = entries.slice() }
}

/** 主路径周期：一条可重放意图 + 正常端口，只有 push 抛 typed 错。 */
class PushFailPort {
  constructor(error) { this.error = error }
  async branchName() { return 'main' }
  async fetchMain() {}
  async headSha() { return 'a'.repeat(40) }
  async originMainSha() { return 'a'.repeat(40) }
  async showRemote() { return '' }
  async showHead() { return '' }
  async aheadBehind() { return { ahead: 0, behind: 0 } }
  async aheadCommits() { return [] }
  async addPaths() {}
  async commit() {}
  async pushMain() { throw this.error }
}

function pendingIntent() {
  return {
    intentId: makeIntentId(DAY, 'a1', TS, 'upsert'),
    op: 'upsert', date: DAY, id: 'a1', ts: TS,
    line: JSON.stringify({
      id: 'a1', ts: TS, title: 't', body: '', author: '我', done: false,
      media: [], ai_processed: false, opened_at: TS,
    }),
    enqueuedAt: TS_LOCAL, attempts: 0, state: 'pending', lastError: '',
  }
}

async function cycleWithPushError(error) {
  const outbox = new MemOutbox([pendingIntent()])
  const result = await runV2Cycle({
    days: [DAY], git: new PushFailPort(error), fs: new MemFs({ 'timeline/schema.json': FRESH_SCHEMA_TEXT }),
    outbox, now: new Date(TS_LOCAL),
  })
  return { result, outbox }
}

/* -------------------------------------------------------------------------- */
/* (a) 真实 kill：进程内第一次带预算的网络调用 + 回环服务不响应                 */
/* -------------------------------------------------------------------------- */

test('T1 真实子进程被预算杀死 → timeout（不是网络不可达），文案带真实预算数字', async (t) => {
  const sockets = new Set()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => sockets.delete(socket))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-timeout-class-'))
  t.after(async () => {
    for (const socket of sockets) {
      try { socket.destroy() } catch { /* 清理失败不影响断言 */ }
    }
    await new Promise((resolve) => server.close(resolve))
    await rm(root, { recursive: true, force: true }).catch(() => {})
  })

  // 显式预算：接口约定「显式配置不放宽」（否则首次调用会被抬到 FIRST_NETWORK_TIMEOUT_MS）。
  const repo = new GitRepo({
    dir: path.join(root, 'work'),
    repoUrl: `https://127.0.0.1:${port}/repo.git`,
    branch: 'main',
    authMode: 'ssh',
    networkTimeoutMs: 400,
  })
  const error = await captureRejection(() => repo.lsRemote())
  assert.equal(error.code, 'E_GIT')
  assert.equal(error.details.reason, 'timeout', 'killed 子进程必须归类 timeout')
  assert.equal(error.details.budgetMs, 400, 'details 必须带当次实际预算')
  assert.equal(error.details.firstCall, false, '显式预算不放宽，firstCall 为 false')
  assert.match(error.message, /超时/)
  assert.match(error.message, />400 毫秒/)
  assert.equal(/网络不可达/.test(error.message), false, '超时文案不得声称网络不可达')
  assert.match(error.message, /下一步/)
  assert.equal(error.details.network, true, '仍是网络命令失败（调用方据此记 reachable）')
  await repo.dispose()
})

/* -------------------------------------------------------------------------- */
/* (a2) 结构信号：killed + 空 stderr，与语言无关；且首次调用用放宽预算           */
/* -------------------------------------------------------------------------- */

test('T2 killed 子进程 + 空 stderr → timeout；首次调用报告放宽后的预算（D2）', async () => {
  resetNetworkCallBudget()
  const killedExec = (file, args, options, callback) => {
    // 模拟 execFile 超时：Node 给的是 killed=true，stderr 可能完全为空。
    callback(Object.assign(new Error('Command failed'), { killed: true, code: 'ETIMEDOUT' }), '', '')
  }
  const repo = new GitRepo({
    dir: path.join(os.tmpdir(), 'dsh-timeout-class-work'),
    repoUrl: HTTPS,
    branch: 'main',
    authMode: 'ssh',
    execFileImpl: killedExec,
  })

  const first = await captureRejection(() => repo.lsRemote())
  assert.equal(first.details.reason, 'timeout')
  assert.equal(first.details.firstCall, true)
  assert.equal(first.details.budgetMs, FIRST_NETWORK_TIMEOUT_MS)
  assert.equal(first.message.includes(`>${FIRST_NETWORK_TIMEOUT_MS} 毫秒`), true)
  assert.equal(first.message.includes('本机首次调用可能包含预热耗时'), true)

  const second = await captureRejection(() => repo.lsRemote())
  assert.equal(second.details.firstCall, false)
  assert.equal(second.details.budgetMs, NETWORK_TIMEOUT_MS)
  assert.equal(second.message.includes(`>${NETWORK_TIMEOUT_MS} 毫秒`), true)
  assert.equal(second.message.includes('本机首次调用可能包含预热耗时'), false)

  // 文案本身也要钉住：数字来自参数，不是写死的散文。
  assert.equal(gitTimeoutMessage('push', 1234, false), `git push 超时（>1234 毫秒未完成）；${GIT_TIMEOUT_NEXT_STEP}`)
  await repo.dispose()
})

/* -------------------------------------------------------------------------- */
/* (b)(c)(d)(e) pushMain 的五种形状各自分类，互不吞并                           */
/* -------------------------------------------------------------------------- */

test('T3 只有超时字样 / 被 kill / typed timeout → timeout（不是不可达）', async () => {
  // 3a：外文 stderr 里只有 timed out，没有任何传输失败证据。
  const textOnly = portWithRunner(failRunner('fatal: the remote end hung up (timed out)'))
  const a = await captureRejection(() => textOnly.pushMain(PUSH_ARGS))
  assert.equal(a.code, V2_ERROR.PUSH_REJECTED)
  assert.equal(a.details.reason, 'timeout')
  // 回落值必须是 **push 自己的**上限（120s），不能是读命令的 8s：
  // 否则一条没有 typed 预算的超时会把读预算说成推送预算（retarget，语义更严格）。
  assert.equal(a.message, pushTimeoutReason(PUSH_TIMEOUT_MS))
  assert.equal(a.message.includes('>120000 毫秒'), true, '未带预算的错误回落到 push 自己的 120s 上限')
  assert.equal(a.details.budgetMs, PUSH_TIMEOUT_MS)

  // 3b：runner 抛结构信号 killed（没有 details.reason，也没进 details）。
  const killedRunner = portWithRunner(async () => {
    throw Object.assign(new Error(''), { killed: true })
  })
  const b = await captureRejection(() => killedRunner.pushMain(PUSH_ARGS))
  assert.equal(b.details.reason, 'timeout')

  // 3c：engine 的 typed timeout（details.reason='timeout' + budgetMs）原样透传预算数字。
  const typedRunner = portWithRunner(async () => {
    throw new SyncError('E_GIT', 'git push 超时（>20000 毫秒未完成）', {
      reason: 'timeout', budgetMs: 20_000, timeoutMs: 20_000, network: true,
    })
  })
  const c = await captureRejection(() => typedRunner.pushMain(PUSH_ARGS))
  assert.equal(c.details.reason, 'timeout')
  assert.equal(c.message.includes('>20000 毫秒'), true)

  // 3d：纯函数面同样成立（分类不依赖是否有 message 类）。
  assert.equal(pushFailureReason(Object.assign(new Error(''), { killed: true })), 'timeout')
  assert.equal(pushFailureReason(new SyncError('E_GIT', 'x', { reason: 'timeout' })), 'timeout')

  // 3e：旧实现里这条会被 /timed? ?out|network|connection/ 判成 network（D1 的吞并）。
  //     先原样复现旧判定的命中，再断言新分类器给的是 timeout —— 这就是「能不吞」的证据。
  const oldNetworkRegex = /Could not resolve host|timed? ?out|unable to access|network|connection/i
  assert.equal(oldNetworkRegex.test('fatal: the connection timed out during push'), true,
    '旧正则会把它判成 network（因此同一段文本既可能是超时也可能被说成不可达）')
  assert.equal(pushFailureReason(new Error('fatal: the connection timed out during push')), 'timeout')
  assert.equal(oldNetworkRegex.test('fatal: network error while pushing: timed out'), true)
  assert.equal(pushFailureReason(new Error('fatal: network error while pushing: timed out')), 'timeout')

  await textOnly.dispose()
  await killedRunner.dispose()
  await typedRunner.dispose()
})

test('T4 传输失败的正面证据 → unreachable；文案与下一步都与超时不同', async () => {
  for (const stderr of [
    "fatal: unable to access 'https://gitee.com/acme/repo.git/': Could not resolve host: gitee.com",
    "fatal: unable to access 'https://gitee.com/acme/repo.git/': Failed to connect to gitee.com port 443",
  ]) {
    const port = portWithRunner(failRunner(stderr))
    const error = await captureRejection(() => port.pushMain(PUSH_ARGS))
    assert.equal(error.code, V2_ERROR.PUSH_REJECTED)
    assert.equal(error.details.reason, 'unreachable')
    assert.equal(error.message, '推送失败：网络不可达（无法解析或连接到远端）')
    assert.equal(/超时/.test(error.message), false)
    await port.dispose()
  }
  // 正面证据只认传输失败字样；timed out 本身不算。
  assert.equal(hasTransportEvidence('fatal: the remote end hung up'), false)
  assert.equal(hasTransportEvidence('Could not resolve host: gitee.com'), true)
})

test('T5 鉴权失败 → 既有 auth-prompt 文案逐字节不变', async () => {
  const port = portWithRunner(failRunner("fatal: Authentication failed for 'https://gitee.com/acme/repo.git/'"))
  const error = await captureRejection(() => port.pushMain(PUSH_ARGS))
  assert.equal(error.code, V2_ERROR.PUSH_REJECTED)
  assert.equal(error.details.reason, 'auth-prompt')
  assert.equal(error.message,
    '推送失败：HTTPS 鉴权无法通过（git 已禁用交互提示，askpass／用户名或令牌不可用）；请检查鉴权配置后重试')
  await port.dispose()
})

test('T6 非快进拒推 → 既有 non-fast-forward 文案逐字节不变', async () => {
  const port = portWithRunner(failRunner(
    '! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to origin'))
  const error = await captureRejection(() => port.pushMain(PUSH_ARGS))
  assert.equal(error.details.reason, 'non-fast-forward')
  assert.equal(error.message, '推送失败：远端分支已前进，下一次同步会做有界重试')
  await port.dispose()
})

test('T7 成功推送不再产生任何错误，argv 仍是固定安全形', async () => {
  const calls = []
  const port = portWithRunner(okRunner(calls))
  await port.pushMain(PUSH_ARGS)
  assert.deepEqual(calls, [['push', '--porcelain', 'origin', 'HEAD:main']])
  await port.dispose()
})

/* -------------------------------------------------------------------------- */
/* 预热：每进程只解析 / 探测一次，配置错误不被缓存（fail-closed）                */
/* -------------------------------------------------------------------------- */

function baseEnvConfig(nodePathInputs) {
  return {
    authMode: 'https',
    repoUrl: HTTPS,
    username: 'acme',
    token: FAKE_TOKEN,
    askpassPath: path.join(os.tmpdir(), 'fake-askpass.cmd'),
    nodePath: nodePathInputs,
  }
}

function winInputs(probe) {
  const nodeExe = 'C:\\Program Files\\nodejs\\node.exe'
  return {
    env: { Path: 'C:\\Program Files\\nodejs', PATHEXT: '.EXE' },
    execPath: 'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe',
    electronVersion: '30.0.0',
    platform: 'win32',
    pathDelimiter: ';',
    fileExists: (p) => p.toLowerCase() === nodeExe.toLowerCase(),
    probe,
  }
}

test('T8 gitAuthEnv 每进程只探测一次；README 的预算/状态可观测', () => {
  resetAskpassNodeWarmUp()
  let probes = 0
  const probe = () => { probes += 1; return true }
  const config = baseEnvConfig(winInputs(probe))

  const first = gitAuthEnv(config)
  const second = gitAuthEnv(config)
  assert.equal(probes, 1, '第二次调用必须命中进程内缓存，不再起探针进程')
  assert.equal(first.DSH_GIT_SYNC_NODE, second.DSH_GIT_SYNC_NODE)
  const warm = askpassNodeWarmUp()
  assert.equal(warm.warmed, true)
  assert.equal(warm.path, first.DSH_GIT_SYNC_NODE)
  assert.equal(Number.isInteger(warm.elapsedMs) && warm.elapsedMs >= 0, true)

  // 配置错误（解释器缺失）绝不缓存：每次都 typed 抛出，绝不静默降级。
  resetAskpassNodeWarmUp()
  let failedProbes = 0
  const failing = winInputs(() => { failedProbes += 1; return false })
  for (let i = 0; i < 2; i += 1) {
    assert.throws(
      () => gitAuthEnv(baseEnvConfig({ ...failing, env: {}, fileExists: () => false })),
      (error) => {
        assert.equal(error.code, ASKPASS_NODE_MISSING_CODE)
        assert.equal(error.message, ASKPASS_NODE_MISSING_REASON)
        return true
      },
    )
  }
  assert.equal(failedProbes, 2, '失败不得被当作已预热缓存下来')
  assert.equal(askpassNodeWarmUp().warmed, false, '失败后仍应报告未预热')
})

/* -------------------------------------------------------------------------- */
/* cycle：超时 / 不可达的下一步与终态原因各自成立                                */
/* -------------------------------------------------------------------------- */

test('T9 cycle 主路径：超时与不可达的文案 + 下一步互不相同，且各自点名', async () => {
  const timedOut = pushTimeoutReason(20_000)
  const timeout = await cycleWithPushError(
    new SyncError(V2_ERROR.PUSH_REJECTED, timedOut, { reason: 'timeout' }))
  assert.equal(timeout.result.code, V2_ERROR.PUSH_REJECTED)
  assert.equal(timeout.result.message.includes(timedOut), true)
  assert.equal(timeout.result.message.includes(PUSH_TIMEOUT_NEXT_STEP), true)
  assert.equal(timeout.result.message.includes('其他设备推进'), false, '超时不得复用远端分叉建议')

  const unreachableReason = '推送失败：网络不可达（无法解析或连接到远端）'
  const unreachable = await cycleWithPushError(
    new SyncError(V2_ERROR.PUSH_REJECTED, unreachableReason, { reason: 'unreachable' }))
  assert.equal(unreachable.result.message.includes(unreachableReason), true)
  assert.equal(unreachable.result.message.includes(PUSH_UNREACHABLE_NEXT_STEP), true)
  assert.notEqual(timeout.result.message, unreachable.result.message, '两种结局的文案必须不同')

  // 停放语义不变：意图 attempts+1 留在 outbox，绝不报成功。
  assert.equal(timeout.result.ok, false)
  assert.equal(timeout.outbox.entries[0].state, 'pending')
  assert.equal(timeout.outbox.entries[0].attempts, 1)
  assert.equal(timeout.outbox.entries[0].lastError.includes('E_PUSH_REJECTED'), true)
})

test('T10 终态原因：带真实预算数字的超时短语不被白名单打码', () => {
  // 白名单按 `>N 毫秒` 归一后精确匹配，输出仍是带真实数字的原文。
  const reason = pushTimeoutReason(20_000)
  assert.equal(PUSH_TIMEOUT_REASON_TEMPLATE.includes('>N 毫秒'), true)
  assert.equal(reason.includes('>20000 毫秒'), true)
  assert.equal(reason, PUSH_TIMEOUT_REASON_TEMPLATE.replace('>N 毫秒', '>20000 毫秒'))
  // 变量只允许纯数字：换成别的内容仍会被折叠成固定短语（fail-closed 不放宽）。
  assert.equal(/^推送失败：推送超时（>\d{1,6} 毫秒未完成，推送需上传本地对象，上传量大或远端响应慢）$/.test(reason), true)
})

/* -------------------------------------------------------------------------- */
/* push 专属预算：120 秒一档，与读命令的 8s / 首次 20s 彻底分开                    */
/* -------------------------------------------------------------------------- */

test('T11 push 用 PUSH_TIMEOUT_MS（120s），不吃读命令的 8s，也不吃首次调用放宽', async () => {
  // 1）常量身份：push 的 120s 与读命令的 8s 是两档，且数字位数能进终态白名单（>\d{1,6}）。
  assert.equal(PUSH_TIMEOUT_MS, 120_000)
  assert.notEqual(PUSH_TIMEOUT_MS, NETWORK_TIMEOUT_MS)
  assert.equal(String(PUSH_TIMEOUT_MS).length <= 6, true, '预算位数必须能被 >\\d{1,6} 归一')

  // 2）预算分配：pushBudget 恒 120s/firstCall=false，且不推进进程级网络调用计数。
  resetNetworkCallBudget()
  const repo = new GitRepo({
    dir: path.join(os.tmpdir(), 'dsh-timeout-budget-work'),
    repoUrl: HTTPS,
    branch: 'main',
    authMode: 'ssh',
  })
  assert.deepEqual(repo.pushBudget(), { timeoutMs: PUSH_TIMEOUT_MS, firstCall: false })
  assert.deepEqual(repo.pushBudget(), { timeoutMs: PUSH_TIMEOUT_MS, firstCall: false })
  // push 没抢走「本进程第一次网络调用」：读命令仍然先拿 20s，再回到 8s。
  assert.deepEqual(repo.networkBudget(), { timeoutMs: FIRST_NETWORK_TIMEOUT_MS, firstCall: true })
  assert.deepEqual(repo.networkBudget(), { timeoutMs: NETWORK_TIMEOUT_MS, firstCall: false })

  // 3）子进程层：push 真的把 120s 交给 execFile；非 push 命令一律不带预算。
  const seen = []
  const port = portWithExec(makeExec({ seen }).impl)
  await port.pushMain(PUSH_ARGS)
  const pushCall = seen.find((call) => call.args[0] === 'push')
  assert.notEqual(pushCall, undefined)
  assert.equal(pushCall.options.timeout, PUSH_TIMEOUT_MS)
  assert.equal(pushCall.options.timeout === NETWORK_TIMEOUT_MS, false, 'push 不得再用读命令的 8s')
  assert.equal(pushCall.options.killSignal, 'SIGTERM')
  await port.branchName()
  const readCall = seen.find((call) => call.args.includes('rev-parse'))
  assert.notEqual(readCall, undefined)
  assert.equal(readCall.options.timeout, undefined, '非 push 命令一律不带预算')
  await port.dispose()

  // 4）读命令不受影响：ls-remote 首次 20s，随后的 fetch 回到 8s（数字真的进了子进程）。
  resetNetworkCallBudget()
  const readSeen = []
  const readRepo = new GitRepo({
    dir: path.join(os.tmpdir(), 'dsh-timeout-budget-read'),
    repoUrl: HTTPS,
    branch: 'main',
    authMode: 'ssh',
    execFileImpl: makeExec({ seen: readSeen }).impl,
  })
  await readRepo.lsRemote()
  await readRepo.fetch()
  const lsCall = readSeen.find((call) => call.args.includes('ls-remote'))
  const fetchCall = readSeen.find((call) => call.args.includes('fetch'))
  assert.notEqual(lsCall, undefined)
  assert.notEqual(fetchCall, undefined)
  assert.equal(lsCall.options.timeout, FIRST_NETWORK_TIMEOUT_MS, '首次读命令仍是 20s')
  assert.equal(fetchCall.options.timeout, NETWORK_TIMEOUT_MS, '非首次读命令仍是 8s')
  await readRepo.dispose()
})

test('T12 9 秒的慢推送不被杀（回归守卫：旧 8s 预算会把它判成超时）', async () => {
  const seen = []
  const fake = makeExec({ seen, durationMs: 9_000 })
  const port = portWithExec(fake.impl)
  // 不抛错 = 没被预算杀死；这正是「健康但慢的推送」必须存活的证据。
  await port.pushMain(PUSH_ARGS)
  assert.equal(seen[0].args[0], 'push')
  assert.equal(seen[0].options.timeout, PUSH_TIMEOUT_MS)
  assert.equal(9_000 > NETWORK_TIMEOUT_MS, true, '9s 确实超过读命令的 8s 预算')

  // 阳性对照：同一份 9 秒输入，只把预算换回旧的 8s 就会被杀 —— 本用例不是空转。
  const old = await runFake(fake.impl, PUSH_ARGS, NETWORK_TIMEOUT_MS)
  assert.equal(old.killed, true, '旧 8s 预算下 9s 推送会被杀（这就是被修掉的失败模式）')
  await port.dispose()
})

test('T13 超过 120 秒的推送 → reason=timeout 且 budgetMs=120000，文案带这个数字且过白名单', async () => {
  const seen = []
  const port = portWithExec(makeExec({ seen, durationMs: PUSH_TIMEOUT_MS + 1 }).impl)
  const error = await captureRejection(() => port.pushMain(PUSH_ARGS))
  assert.equal(error.code, V2_ERROR.PUSH_REJECTED)
  assert.equal(error.details.reason, 'timeout')
  assert.equal(error.details.budgetMs, 120_000)
  assert.equal(error.details.budgetMs, PUSH_TIMEOUT_MS)
  assert.equal(error.message, pushTimeoutReason(PUSH_TIMEOUT_MS))
  assert.equal(error.message, PUSH_TIMEOUT_REASON_TEMPLATE.replace('>N 毫秒', '>120000 毫秒'))
  assert.equal(error.message.includes('>120000 毫秒'), true, '文案里的数字就是当次预算')
  assert.equal(/网络不可达/.test(error.message), false, '超时不得冒充网络不可达')
  await port.dispose()

  // 端到端：带 120000 的短语原样穿过 cycle 的终态白名单（不被折叠成「原因类别未识别」）。
  const reason = pushTimeoutReason(PUSH_TIMEOUT_MS)
  const cycled = await cycleWithPushError(
    new SyncError(V2_ERROR.PUSH_REJECTED, reason, { reason: 'timeout', budgetMs: PUSH_TIMEOUT_MS }))
  assert.equal(cycled.result.message.includes(reason), true)
  assert.equal(cycled.result.message.includes('原因类别未识别'), false)
  assert.equal(cycled.outbox.entries[0].attempts, 1, '超时只累加一次尝试，不报成功')
})
