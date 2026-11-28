/**
 * `mod-plugin-behind-fastforward`：把「本地只落后」从**永久报错**改成**一次快进**。
 *
 * 被测对象（只读 import，全部来自已构建的 dist）：
 *   - `dist/sync/syncGate.js`：纯判定 `decideSyncGate({ahead, behind, ours})`（无 git、无 IO）；
 *   - `dist/sync/gitPort.js`：唯一的快进 argv 构造器 / argv 守卫 / 真实端口的快进三态分类；
 *   - `dist/sync/cycle.js`：周期里「fetch 之后、本地写入之前」的那一次快进与脏工作树规则。
 *
 * 四组证据：
 *   A. 纯判定矩阵（含退化输入：负数 / NaN / Infinity / 小数 / 非数 → 一律 refuse，绝不静默 proceed）；
 *   B. argv 安全（固定构造器 + hostile 表；`merge` 不因快进而变成可随便用的子命令）；
 *   C. 内存端口的周期行为（一次快进上限、快进失败文案、分叉拒绝逐字不变、脏工作树兜底）；
 *   D. **真实 git 见证**：裸远端 + 独立 clone（全部在 `packages/dsh-dots/.tmp/` 下），
 *      另一个 clone 先推、本地干净且落后 3 个提交，跑周期后本地 HEAD 变成远端 HEAD、
 *      写入成功、远端树里真有这条记录、argv 里没有任何强制/非快进参数；第二次周期是 no-op。
 *      另加「脏工作树」一对：远端改**别的**路径（快进成功、本地改动保住）与
 *      远端改**同一天同一文件**（本地改动先提交、再走既有分叉处理，绝不丢数据）。
 *
 * 硬约束：无网络（远端是本地裸仓库）、无 sleep、不碰真实 `~/.dsh`、
 * 不在项目仓库里执行任何 git 写命令（所有 git 写只发生在 `.tmp/` 里的一次性夹具）。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  FACTS_INVALID_MESSAGE,
  FF_BLOCKED_PENDING_MESSAGE,
  FF_FAILED_MESSAGE,
  FF_INCOMPLETE_MESSAGE,
  LOCAL_PENDING_MESSAGE,
  NOT_SYNCED_MESSAGE,
  PUSH_ARGS,
  V2_ERROR,
  makeIntentId,
  runV2Cycle,
} from '../dist/sync/cycle.js'
import {
  FAST_FORWARD_ARGS,
  FORBIDDEN_GIT_ARG_PATTERNS,
  GIT_SUBCOMMANDS,
  GitRepoV2Port,
  assertSafeGitArgs,
  buildFastForwardArgs,
  buildSafePushArgs,
  isFastForwardArgs,
} from '../dist/sync/gitPort.js'
import {
  SYNC_GATE_REASON,
  decideSyncGate,
  isSyncFactsValid,
  refuseInvalidFacts,
} from '../dist/sync/syncGate.js'
import {
  FRESH_SCHEMA_TEXT,
  buildRecordsText,
  canonicalRecordLine,
  parseTimelineDay,
} from '../dist/timeline/index.js'
import { SCHEMA_MARKER_PATH, timelineRecordsPath } from '../dist/timeline/paths.js'
import { NodeTimelineFs } from '../dist/timeline/write.js'
import { NodeOutboxPort } from '../dist/sync/outbox.js'
import { newTimelineRecord } from '../dist/schedule/v2Bridge.js'
import { statePaths } from '../dist/engine/paths.js'
import { LocalStateStore } from '../dist/engine/settings.js'

// ---------------------------------------------------------------- 常量与路径卫生

const TMP_BASE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.tmp')
const DAY = '2026-11-23'
const DAY2 = '2026-11-24'
const T1 = `${DAY}T01:00:00.000Z`
const T2 = `${DAY}T02:00:00.000Z`
const T3 = `${DAY}T03:00:00.000Z`
const NOW = new Date(T2)

function isUnder(child, parent) {
  const c = path.resolve(child)
  const p = path.resolve(parent)
  return c === p || c.startsWith(`${p}${path.sep}`)
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

// ================================================================ A. 纯判定矩阵

test('G-A1 纯判定矩阵逐格：behind-only 快进 / 分叉按归属 / 同步直行 / 退化输入拒绝', () => {
  const table = [
    // ahead, behind, ours, action, reason
    [0, 0, false, 'proceed', SYNC_GATE_REASON.IN_SYNC],
    [0, 0, true, 'proceed', SYNC_GATE_REASON.IN_SYNC],
    [0, 1, false, 'fast-forward', SYNC_GATE_REASON.BEHIND_ONLY],
    [0, 3, true, 'fast-forward', SYNC_GATE_REASON.BEHIND_ONLY],
    [0, 47, false, 'fast-forward', SYNC_GATE_REASON.BEHIND_ONLY],
    [1, 0, true, 'recover', SYNC_GATE_REASON.AHEAD_ONLY_OURS],
    [2, 0, true, 'recover', SYNC_GATE_REASON.AHEAD_ONLY_OURS],
    [1, 0, false, 'refuse', SYNC_GATE_REASON.AHEAD_ONLY_FOREIGN],
    [4, 0, false, 'refuse', SYNC_GATE_REASON.AHEAD_ONLY_FOREIGN],
    [1, 1, true, 'recover', SYNC_GATE_REASON.DIVERGED_OURS],
    [3, 2, true, 'recover', SYNC_GATE_REASON.DIVERGED_OURS],
    [1, 1, false, 'refuse', SYNC_GATE_REASON.DIVERGED_FOREIGN],
    [3, 9, false, 'refuse', SYNC_GATE_REASON.DIVERGED_FOREIGN],
  ]
  for (const [ahead, behind, ours, action, reason] of table) {
    const decision = decideSyncGate({ ahead, behind, ours })
    assert.equal(decision.action, action, `ahead=${ahead} behind=${behind} ours=${ours}`)
    assert.equal(decision.reason, reason, `ahead=${ahead} behind=${behind} ours=${ours}`)
  }
})

test('G-A2 退化输入一律 refuse(invalid-facts)，绝不静默 proceed', () => {
  const degenerate = [
    [-1, 0], [0, -1], [-2, -3], [1.5, 0], [0, 0.5],
    [Number.NaN, 0], [0, Number.NaN], [Number.POSITIVE_INFINITY, 0], [0, Number.NEGATIVE_INFINITY],
    ['1', 0], [0, '2'], [null, 0], [0, null], [undefined, 0], [0, undefined], [true, 0],
  ]
  for (const [ahead, behind] of degenerate) {
    for (const ours of [false, true]) {
      const decision = decideSyncGate({ ahead, behind, ours })
      assert.equal(decision.action, 'refuse', `ahead=${String(ahead)} behind=${String(behind)}`)
      assert.equal(decision.reason, SYNC_GATE_REASON.INVALID_FACTS)
    }
  }
  // 总函数：连「没有参数」也不抛，而是 typed 拒绝。
  assert.deepEqual(decideSyncGate(), refuseInvalidFacts())
  assert.deepEqual(decideSyncGate({}), refuseInvalidFacts())
  assert.deepEqual(decideSyncGate({ ahead: 0, behind: 0 }), { action: 'proceed', reason: SYNC_GATE_REASON.IN_SYNC })
  // `ours` 只认 === true：'yes' / 1 都不算「本模块」，于是不会拿到恢复权限。
  assert.equal(decideSyncGate({ ahead: 1, behind: 1, ours: 'yes' }).action, 'refuse')
  assert.equal(decideSyncGate({ ahead: 1, behind: 1, ours: 1 }).action, 'refuse')
  // 形状谓词本身也逐项钉住。
  assert.equal(isSyncFactsValid(0, 0), true)
  assert.equal(isSyncFactsValid(3, 7), true)
  for (const [a, b] of degenerate) assert.equal(isSyncFactsValid(a, b), false, `${String(a)},${String(b)}`)
})

// ================================================================ B. argv 安全

test('G-B1 快进 argv 只有一个固定形态；`merge` 不会因此变成可随便用的子命令', () => {
  assert.deepEqual(FAST_FORWARD_ARGS, ['merge', '--ff-only', 'refs/remotes/origin/main'])
  assert.deepEqual(buildFastForwardArgs(), ['merge', '--ff-only', 'refs/remotes/origin/main'])
  // 构造器每次给新数组：调用方改不动常量。
  const args = buildFastForwardArgs()
  args.push('--no-ff')
  assert.deepEqual(buildFastForwardArgs(), ['merge', '--ff-only', 'refs/remotes/origin/main'])
  assert.equal(isFastForwardArgs(FAST_FORWARD_ARGS), true)
  assert.doesNotThrow(() => assertSafeGitArgs(buildFastForwardArgs()))
  // 子命令白名单**没有**被放开：快进是形态例外，不是白名单新成员。
  for (const sub of ['merge', 'pull', 'reset', 'rebase', 'checkout', 'stash']) {
    assert.equal(GIT_SUBCOMMANDS.has(sub), false, `${sub} 不该进 allowlist`)
  }
})

test('G-B2 hostile argv 表：强制 / 非快进 / 换 ref / 硬丢弃形态全部被拒（E_VALIDATION）', () => {
  const hostile = [
    // 快进形态的冒牌货与变形
    ['merge'],
    ['merge', '--ff-only'],
    ['merge', '--ff-only', 'origin/main'],
    ['merge', '--ff-only', 'refs/remotes/origin/master'],
    ['merge', '--ff-only', 'refs/remotes/origin/main', '--no-ff'],
    ['merge', '--no-ff', 'refs/remotes/origin/main'],
    ['merge', '--ff', 'refs/remotes/origin/main'],
    ['merge', '--ff-only=false', 'refs/remotes/origin/main'],
    ['merge', '--squash', '--ff-only', 'refs/remotes/origin/main'],
    ['merge', '--no-commit', '--ff-only', 'refs/remotes/origin/main'],
    ['merge', '-f', '--ff-only', 'refs/remotes/origin/main'],
    ['merge', '--force', 'refs/remotes/origin/main'],
    ['merge', '--ff-only', 'refs/remotes/origin/main', '+refs/heads/main'],
    // 历史改写 / 拉取 / 删引用：子命令层面就必须拒
    ['reset', '--hard'],
    ['reset', '--hard', 'HEAD'],
    ['rebase', 'refs/remotes/origin/main'],
    ['pull', '--ff-only', 'origin', 'main'],
    ['checkout', '--', 'timeline'],
    ['update-ref', 'refs/heads/main', 'deadbeef'],
    // push 侧既有保证不变
    ['push', '--force', 'origin', 'HEAD:main'],
    ['push', '-f', 'origin', 'HEAD:main'],
    ['push', '--no-ff', 'origin', 'HEAD:main'],
    ['push', '--porcelain', 'origin', '+refs/heads/main:main'],
  ]
  for (const argv of hostile) {
    assert.throws(() => assertSafeGitArgs(argv), (error) => error.code === 'E_VALIDATION', argv.join(' '))
  }
  // 危险参数形态本身逐项钉住（守卫没有被削弱，只增不减）。
  const dangerous = [
    '--force', '--force-with-lease', '-f', '--no-ff', '--ff-only=false', '--ff', '--squash',
    '--no-commit', '--hard', '--delete', '+refs/heads/main', 'push.force=true',
  ]
  for (const arg of dangerous) {
    assert.equal(FORBIDDEN_GIT_ARG_PATTERNS.some((pattern) => pattern.test(arg)), true, `未拒绝 ${arg}`)
  }
  // 正向对照：合法的快进参数不被自己误伤。
  for (const arg of ['--ff-only', 'refs/remotes/origin/main']) {
    assert.equal(FORBIDDEN_GIT_ARG_PATTERNS.some((pattern) => pattern.test(arg)), false, `误伤 ${arg}`)
  }
  assert.deepEqual(buildSafePushArgs({ remote: 'origin', branch: 'main', force: false }),
    ['push', '--porcelain', 'origin', 'HEAD:main'])
})

/** 假执行器：只收 argv，按注入结果回答（用来观测真实端口到底拼了什么）。 */
function scriptedRunner(scripted) {
  const seen = []
  const runner = async (_cwd, argv) => {
    seen.push(argv.slice())
    const answer = scripted(argv[0], argv)
    return answer ?? { code: 0, stdout: '', stderr: '' }
  }
  return { runner, seen }
}

test('G-B3 真实端口 fastForward()：argv 逐项等于固定形态；三态分类不靠 stderr 语言', async () => {
  const cases = [
    {
      name: '成功',
      scripted: () => ({ code: 0, stdout: 'Fast-forward\n', stderr: '' }),
      expected: 'fast-forwarded',
    },
    {
      name: '英文：本地改动会被覆盖',
      scripted: () => ({
        code: 1, stdout: '',
        stderr: 'error: Your local changes to the following files would be overwritten by merge:\n\ttimeline/x/records.json\n',
      }),
      expected: 'blocked-by-local-changes',
    },
    {
      name: '中文：本地修改会被合并覆盖',
      scripted: () => ({ code: 1, stdout: '', stderr: '错误：您对下列文件的本地修改将被合并操作覆盖：timeline/x/records.json\n' }),
      expected: 'blocked-by-local-changes',
    },
    {
      name: '真分叉（不能快进）',
      scripted: () => ({ code: 1, stdout: '', stderr: 'fatal: Not possible to fast-forward, aborting.\n' }),
      expected: 'failed',
    },
    {
      name: '未知失败 + 工作树脏（status 兜底）',
      scripted: (sub) => (sub === 'status'
        ? { code: 0, stdout: ' M timeline/x/records.json\n', stderr: '' }
        : { code: 1, stdout: '', stderr: 'error: unknown failure from a localized git\n' }),
      expected: 'blocked-by-local-changes',
    },
    {
      name: '未知失败 + 工作树干净',
      scripted: (sub) => (sub === 'status'
        ? { code: 0, stdout: '', stderr: '' }
        : { code: 1, stdout: '', stderr: 'error: unknown failure\n' }),
      expected: 'failed',
    },
  ]
  for (const item of cases) {
    const { runner, seen } = scriptedRunner(item.scripted)
    const port = new GitRepoV2Port({
      dir: path.join(TMP_BASE, 'ff-argv-noop'), repoUrl: 'https://example.test/a/b.git',
      branch: 'main', authMode: 'https', runner,
    })
    try {
      const outcome = await port.fastForward()
      assert.equal(outcome.status, item.expected, item.name)
      const ff = seen.filter((argv) => argv[0] === 'merge')
      assert.equal(ff.length, 1, `${item.name}: 快进只发一次`)
      assert.deepEqual(ff[0], ['merge', '--ff-only', 'refs/remotes/origin/main'], item.name)
      for (const argv of seen) {
        assert.equal(argv.some((arg) => ['--force', '-f', '--no-ff', '--ff-only=false', '--hard'].includes(arg)), false,
          `${item.name}: argv 里不许出现危险参数：${argv.join(' ')}`)
      }
    } finally {
      await port.dispose()
    }
  }
})

// ================================================================ C. 内存端口的周期行为

class MemFs {
  constructor(seed = {}) { this.files = new Map(Object.entries(seed)); this.calls = [] }
  async read(rel) { return this.files.has(rel) ? this.files.get(rel) : null }
  async writeTemp(rel, text) { const t = `${rel}.tmp`; this.files.set(t, text); return t }
  async readTemp(t) { return this.files.get(t) ?? '' }
  async rename(t, rel) { this.files.set(rel, this.files.get(t)); this.files.delete(t) }
  async backupIfExists() { return false }
  async append(rel, text) { this.calls.push(['append', rel]); this.files.set(rel, (this.files.get(rel) ?? '') + text) }
  async exists(rel) { return this.files.has(rel) }
  writes() { return this.calls }
}

class MemOutbox {
  constructor(entries = []) { this.entries = entries.slice(); this.saves = 0 }
  async load() { return this.entries.slice() }
  async save(entries) { this.saves += 1; this.entries = entries.slice() }
}

function rec(overrides = {}) {
  return {
    id: 'a1', ts: T1, title: 't', body: '', author: '我', done: false,
    media: [], ai_processed: false, opened_at: T1, ...overrides,
  }
}

/** 可编排的 FakeGit：`facts` 每次调用都重新取，用来模拟「快进前/快进后」的事实变化。 */
class FakeGit {
  constructor(opts = {}) {
    this.branch = 'main'
    this.head = opts.head ?? 'head-1'
    this.origin = opts.origin ?? 'head-1'
    this.remote = opts.remote ?? {}
    this.headFiles = opts.headFiles ?? {}
    this.facts = opts.facts ?? { ahead: 0, behind: 0 }
    this.aheadCommitList = opts.aheadCommits ?? []
    this.ffOutcome = opts.ffOutcome ?? { status: 'fast-forwarded' }
    this.ffAfter = opts.ffAfter ?? null
    this.calls = []
  }
  async branchName() { return this.branch }
  async fetchMain() { this.calls.push(['fetch']) }
  async headSha() { return this.head }
  async originMainSha() { return this.origin }
  async showRemote(rel) { return this.remote[rel] ?? '' }
  async showHead(rel) { return this.headFiles[rel] ?? '' }
  async addPaths(paths) { this.calls.push(['add', paths.slice()]) }
  async commit(message, body) { this.calls.push(['commit', message, body]) }
  async pushMain(args) { this.calls.push(['push', args]) }
  async aheadBehind() { return this.facts }
  async aheadCommits() { return this.aheadCommitList.slice() }
  async fastForward() {
    this.calls.push(['fastForward'])
    if (this.ffAfter !== null) {
      this.head = this.ffAfter.head
      this.origin = this.ffAfter.origin
      this.facts = this.ffAfter.facts
    }
    return this.ffOutcome
  }
  writes() { return this.calls.filter((c) => ['add', 'commit', 'push'].includes(c[0])) }
  ffCalls() { return this.calls.filter((c) => c[0] === 'fastForward').length }
}

function fakeOpts({
  fs = new MemFs({ 'timeline/schema.json': FRESH_SCHEMA_TEXT }),
  git,
  outbox = new MemOutbox(),
  days = [DAY],
} = {}) {
  return { fs, git, outbox, days, now: NOW }
}

test('G-C1 behind-only：一次快进后同一周期继续，推送成功，用户看不到新错误', async () => {
  const git = new FakeGit({
    head: 'local-1', origin: 'remote-3',
    facts: { ahead: 0, behind: 3 },
    ffAfter: { head: 'remote-3', origin: 'remote-3', facts: { ahead: 0, behind: 0 } },
  })
  const outbox = new MemOutbox([])
  const result = await runV2Cycle(fakeOpts({ git, outbox }))
  assert.equal(result.ok, true, result.message)
  assert.equal(result.code, V2_ERROR.OK)
  assert.equal(result.message, '已同步')
  assert.equal(git.ffCalls(), 1)
  assert.deepEqual(git.calls.find((c) => c[0] === 'push')[1], PUSH_ARGS)
  // 快进发生在任何本地写之前。
  const order = git.calls.map((c) => c[0])
  assert.ok(order.indexOf('fetch') < order.indexOf('fastForward'), 'fetch 必须先于快进')
})

test('G-C2 快进失败（不是本地改动）→ E_PULL_FAILED + 自己的文案，零写入、只试一次', async () => {
  const git = new FakeGit({
    head: 'local-1', origin: 'remote-3', facts: { ahead: 0, behind: 3 },
    ffOutcome: { status: 'failed', message: 'git 判定不能快进' },
  })
  const fs = new MemFs({
    'timeline/schema.json': FRESH_SCHEMA_TEXT,
    [timelineRecordsPath(DAY)]: buildRecordsText(DAY, [rec()]),
  })
  const outbox = new MemOutbox([])
  const result = await runV2Cycle(fakeOpts({ git, fs, outbox }))
  assert.equal(result.ok, false)
  assert.equal(result.code, V2_ERROR.PULL_FAILED)
  assert.equal(result.message, FF_FAILED_MESSAGE)
  assert.notEqual(result.message, NOT_SYNCED_MESSAGE, '绝不能借用「分叉」的措辞')
  assert.equal(git.ffCalls(), 1)
  assert.deepEqual(git.writes(), [])
  assert.deepEqual(fs.calls, [])
})

test('G-C3 快进「成功」但事实仍落后 → typed 拒绝且绝不循环（FF 只被调用一次）', async () => {
  const git = new FakeGit({
    head: 'local-1', origin: 'remote-3', facts: { ahead: 0, behind: 3 },
    // 端口说谎：快进返回成功，但 HEAD/origin 与计数都没变。
    ffOutcome: { status: 'fast-forwarded' },
    ffAfter: { head: 'local-1', origin: 'remote-3', facts: { ahead: 0, behind: 3 } },
  })
  const result = await runV2Cycle(fakeOpts({ git }))
  assert.equal(result.ok, false)
  assert.equal(result.code, V2_ERROR.NOT_SYNCED)
  assert.equal(result.message, FF_INCOMPLETE_MESSAGE)
  assert.equal(git.ffCalls(), 1, '同一周期绝不第二次快进')
  assert.deepEqual(git.writes(), [])
})

test('G-C4 真分叉且领先提交非本模块 → 拒绝文案逐字不变，零快进零写入', async () => {
  const git = new FakeGit({
    head: 'local-1', origin: 'remote-1', facts: { ahead: 1, behind: 1 },
    aheadCommits: [{ subject: 'manual local commit', body: '', paths: ['timeline/x'] }],
  })
  const outbox = new MemOutbox([])
  const result = await runV2Cycle(fakeOpts({ git, outbox }))
  assert.equal(result.ok, false)
  assert.equal(result.code, V2_ERROR.NOT_SYNCED)
  assert.equal(result.message, NOT_SYNCED_MESSAGE)
  assert.equal(git.ffCalls(), 0, '分叉不是快进能解决的事')
  assert.deepEqual(git.writes(), [])
  assert.equal(outbox.saves, 0)
})

test('G-C5 事实自相矛盾（HEAD≠origin 但计数 0/0）→ fail-closed，不写不做快进', async () => {
  const git = new FakeGit({ head: 'local-1', origin: 'remote-1', facts: { ahead: 0, behind: 0 } })
  const fs = new MemFs({ 'timeline/schema.json': FRESH_SCHEMA_TEXT })
  const result = await runV2Cycle(fakeOpts({ git, fs }))
  assert.equal(result.ok, false)
  assert.equal(result.code, V2_ERROR.NOT_SYNCED)
  assert.equal(result.message, FACTS_INVALID_MESSAGE)
  assert.equal(git.ffCalls(), 0)
  assert.deepEqual(git.writes(), [])
  assert.deepEqual(fs.calls, [])
})

test('G-C6 本地改动挡住快进 + 本周期无写入 → typed 拒绝（绝不报成功、绝不丢改动）', async () => {
  const git = new FakeGit({
    head: 'local-1', origin: 'remote-3', facts: { ahead: 0, behind: 3 },
    ffOutcome: { status: 'blocked-by-local-changes' },
  })
  const fs = new MemFs({ 'timeline/schema.json': FRESH_SCHEMA_TEXT })
  const result = await runV2Cycle(fakeOpts({ git, fs, days: [] }))
  assert.equal(result.ok, false)
  assert.equal(result.code, V2_ERROR.NOT_SYNCED)
  assert.equal(result.message, FF_BLOCKED_PENDING_MESSAGE)
  assert.equal(git.ffCalls(), 1)
  assert.deepEqual(git.writes(), [])
})

// ================================================================ D. 真实 git 见证

function capturingRunner(sink, mergeResults = null) {
  return async (cwd, args, env) => {
    sink.push(args.slice())
    let answer
    try {
      const stdout = execFileSync('git', args, {
        cwd, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'],
      })
      answer = { code: 0, stdout, stderr: '' }
    } catch (error) {
      answer = {
        code: typeof error.status === 'number' ? error.status : 1,
        stdout: typeof error.stdout === 'string' ? error.stdout : '',
        stderr: typeof error.stderr === 'string' ? error.stderr : '',
      }
    }
    if (mergeResults !== null && args[0] === 'merge') mergeResults.push({ argv: args.slice(), ...answer })
    return answer
  }
}

/**
 * 克隆一律带 `-c core.autocrlf=false`：夹具字节必须与提交树逐字节一致，
 * 不受本机 git 配置（Windows 常见 autocrlf=true）影响，否则「干净工作副本」会被误判成脏。
 */
function cloneInto(from, to) {
  git(path.dirname(to), ['-c', 'core.autocrlf=false', 'clone', '--quiet', from, to])
  git(to, ['config', 'core.autocrlf', 'false'])
  git(to, ['config', 'core.safecrlf', 'false'])
}

/** 裸远端 + 一条 schema 种子提交（clone 都出生在 HEAD === origin/main）。 */
async function makeTopology(t, label) {
  const root = await mkdtemp(path.join(TMP_BASE, `${label}-`))
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  assert.ok(isUnder(root, TMP_BASE), '夹具根必须落在本包 .tmp 下')
  const bare = path.join(root, 'remote.git')
  git(root, ['init', '--bare', '--initial-branch=main', bare])
  const seed = path.join(root, 'seed')
  cloneInto(bare, seed)
  await mkdir(path.join(seed, 'timeline'), { recursive: true })
  await writeFile(path.join(seed, SCHEMA_MARKER_PATH), FRESH_SCHEMA_TEXT)
  git(seed, ['add', SCHEMA_MARKER_PATH])
  git(seed, ['-c', 'user.name=seed', '-c', 'user.email=seed@localhost', 'commit', '--quiet', '-m', 'seed v2 schema'])
  git(seed, ['push', '--quiet', 'origin', 'main'])
  return { root, bare, seedSha: git(seed, ['rev-parse', 'HEAD']) }
}

/** 一个 clone = 自己的 temp home + 真实 v2 端口（argv 全部经过 capturingRunner）。 */
async function makeEndpoint(t, top, who) {
  const home = path.join(top.root, `${who}-home`)
  const repoDir = path.join(top.root, `${who}-repo`)
  const argv = []
  const mergeResults = []
  const ffOutcomes = []
  const gitPort = new GitRepoV2Port({
    dir: repoDir, repoUrl: top.bare, branch: 'main', authMode: 'https',
    token: null, username: '', platform: 'custom', allowLocalRepo: true,
    runner: capturingRunner(argv, mergeResults),
  })
  t.after(async () => { await gitPort.dispose() })
  cloneInto(top.bare, repoDir)
  // 记录每次快进的三态（证据用；不改变端口行为）。
  const originalFastForward = gitPort.fastForward.bind(gitPort)
  gitPort.fastForward = async () => {
    const outcome = await originalFastForward()
    ffOutcomes.push(outcome.status)
    return outcome
  }
  const outbox = new NodeOutboxPort({ stateRoot: path.join(top.root, `${who}-state`), repoUrl: top.bare })
  assert.ok(isUnder(outbox.filePath, top.root), `${who} outbox 越界`)
  return {
    who, home, repoDir, bare: top.bare, argv, mergeResults, ffOutcomes,
    git: gitPort, fs: new NodeTimelineFs(repoDir), outbox,
    head: () => git(repoDir, ['rev-parse', 'HEAD']),
    origin: () => git(repoDir, ['rev-parse', 'refs/remotes/origin/main']),
    remote: () => git(top.bare, ['rev-parse', 'refs/heads/main']),
    behind: () => Number(git(repoDir, ['rev-list', '--count', 'HEAD..refs/remotes/origin/main'])),
    ahead: () => Number(git(repoDir, ['rev-list', '--count', 'refs/remotes/origin/main..HEAD'])),
    remoteFile: (rel) => {
      try {
        return git(top.bare, ['show', `main:${rel}`])
      } catch {
        return null
      }
    },
    localFile: (rel) => {
      const full = path.join(repoDir, ...rel.split('/'))
      return existsSync(full) ? readFileSync(full, 'utf8') : null
    },
    headFile: (rel) => {
      try {
        return git(repoDir, ['show', `HEAD:${rel}`])
      } catch {
        return null
      }
    },
    ffArgv: () => argv.filter((a) => a[0] === 'merge'),
    dangerousArgv: () => argv.filter((a) => a.some((arg) =>
      ['--force', '--force-with-lease', '-f', '--no-ff', '--ff-only=false', '--hard', '--squash'].includes(arg))),
  }
}

function makeIntent({ date = DAY, id, ts, title, body = '' }) {
  const record = newTimelineRecord(id, ts, { title, body, author: 'ff' })
  return {
    intentId: makeIntentId(date, id, ts, 'upsert'),
    op: 'upsert', date, id, ts, line: canonicalRecordLine(record),
    enqueuedAt: ts, attempts: 0, state: 'pending', lastError: '',
  }
}

async function stage(ep, intent) {
  await ep.outbox.save([...(await ep.outbox.load()), intent])
  return intent
}

function runCycle(ep, days = [DAY]) {
  return runV2Cycle({ days, git: ep.git, fs: ep.fs, outbox: ep.outbox, now: NOW })
}

/** 另一个 clone 直接推一个提交（模拟「平板先同步」）。 */
function pushFromPeer(top, files, subject) {
  const peer = path.join(top.root, `peer-${Math.random().toString(36).slice(2)}`)
  cloneInto(top.bare, peer)
  for (const [rel, text] of files) {
    const full = path.join(peer, ...rel.split('/'))
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, text, 'utf8')
  }
  git(peer, ['add', '-A'])
  git(peer, ['-c', 'user.name=peer', '-c', 'user.email=peer@localhost', 'commit', '--quiet', '-m', subject])
  git(peer, ['push', '--quiet', 'origin', 'main'])
  return git(peer, ['rev-parse', 'HEAD'])
}

test('G-D1 见证：干净工作副本落后 3 个提交 → 周期内快进到远端 HEAD、写入成功、argv 无强制参数', async (t) => {
  const top = await makeTopology(t, 'ff-d1')
  const A = await makeEndpoint(t, top, 'A')
  const B = await makeEndpoint(t, top, 'B')
  // B 先写三次（逐次累积），A 保持干净 → A 落后 3 个提交。
  let remoteHead = ''
  const peerRecords = []
  for (const [index, title] of ['b-one', 'b-two', 'b-three'].entries()) {
    peerRecords.push(rec({ id: `b${index}`, ts: `2026-11-23T0${index + 4}:00:00.000Z`, title }))
    remoteHead = pushFromPeer(top, [[timelineRecordsPath(DAY), buildRecordsText(DAY, peerRecords.slice())]],
      '[v2] sync 1 days')
  }
  // A 侧先 fetch，把「落后 3 个提交」变成可读事实。
  git(A.repoDir, ['fetch', '--quiet', 'origin'])
  assert.equal(A.behind(), 3, 'A 必须落后 3 个提交')
  assert.equal(A.ahead(), 0)
  const headBefore = A.head()
  assert.notEqual(headBefore, remoteHead)
  assert.equal(existsSync(path.join(A.repoDir, ...timelineRecordsPath(DAY).split('/'))), false)
  assert.equal(git(A.repoDir, ['status', '--porcelain']), '', '快进前工作副本必须干净')

  await stage(A, makeIntent({ id: 'own-1', ts: T1, title: 'a-own' }))
  const result = await runCycle(A)
  assert.equal(result.ok, true, `${result.message} | ff=${A.ffOutcomes.join(',')} | merge=${JSON.stringify(A.mergeResults)}`)
  assert.equal(result.code, V2_ERROR.OK)
  assert.equal(result.applied, 1)

  // (a) 本地 HEAD 经过快进真的到了远端提交，再叠上本周期的新提交。
  assert.equal(A.ffArgv().length, 1, '一次快进')
  assert.deepEqual(A.ffArgv()[0], ['merge', '--ff-only', 'refs/remotes/origin/main'])
  assert.deepEqual(A.ffOutcomes, ['fast-forwarded'])
  assert.notEqual(A.head(), headBefore)
  git(A.repoDir, ['merge-base', '--is-ancestor', remoteHead, 'HEAD']) // 不抛 = 是祖先
  assert.equal(git(A.repoDir, ['rev-list', '--count', `${headBefore}..${remoteHead}`]), '3')
  assert.equal(A.head(), A.remote(), '推送成功后本地与远端同一个提交')
  // 历史保持线性：没有合并提交（快进不造合并）。
  assert.equal(git(A.repoDir, ['rev-list', '--count', '--merges', 'HEAD']), '0')
  // (b) 写入成功：远端 main 的树里真有四条记录（B 的三条 + 本机这条）。
  const pushed = A.remoteFile(timelineRecordsPath(DAY))
  const ids = parseTimelineDay(pushed, DAY).day.allRecords.map((item) => item.id).sort()
  assert.deepEqual(ids, ['b0', 'b1', 'b2', 'own-1'])
  assert.ok(pushed.includes('a-own'))
  assert.deepEqual(await A.outbox.load(), [])
  assert.equal(readFileSync(A.outbox.filePath, 'utf8').trim(), '[]')
  // (c) 任何 argv 都没有强制/非快进参数；push 实参仍是固定安全值。
  assert.deepEqual(A.dangerousArgv(), [])
  const pushArgv = A.argv.filter((a) => a[0] === 'push')
  assert.equal(pushArgv.length, 1)
  assert.deepEqual(pushArgv[0], ['push', '--porcelain', 'origin', 'HEAD:main'])

  // (e) 第二次周期是 no-op：没有新的提交 / 推送 / 快进。
  const headAfter = A.head()
  const remoteAfter = A.remote()
  const argvBefore = A.argv.length
  const second = await runCycle(A)
  assert.equal(second.ok, true, `${second.message} | ff=${A.ffOutcomes.join(',')}`)
  assert.equal(second.writtenPaths.length, 0)
  assert.equal(second.attempts, 0)
  assert.equal(A.head(), headAfter)
  assert.equal(A.remote(), remoteAfter)
  assert.equal(A.ffArgv().length, 1, 'no-op 周期不再快进')
  const tail = A.argv.slice(argvBefore)
  assert.equal(tail.some((a) => ['merge', 'push', 'commit', 'add'].includes(a[0])), false,
    `no-op 周期不该有写/推送命令：${JSON.stringify(tail)}`)

  // (B 侧对照) 另一台设备快进后看到的字节与本机一致。
  git(B.repoDir, ['fetch', '--quiet', 'origin'])
  assert.equal(git(B.repoDir, ['rev-parse', 'refs/remotes/origin/main']), A.head())
})

test('G-D2 state.json：v2 周期成功不写 lastSyncAt（现状钉住；接线点在 rpc.ts 之外的范围）', async (t) => {
  const top = await makeTopology(t, 'ff-d2')
  const A = await makeEndpoint(t, top, 'A')
  pushFromPeer(top, [[timelineRecordsPath(DAY), buildRecordsText(DAY, [rec({ id: 'peer1', ts: T1, title: 'peer' })])]],
    '[v2] sync 1 days')
  git(A.repoDir, ['fetch', '--quiet', 'origin'])
  const store = new LocalStateStore(statePaths(A.home))
  assert.equal(store.readLastSyncAt(), null)
  await stage(A, makeIntent({ id: 'own-2', ts: T2, title: 'a-own-2' }))
  const result = await runCycle(A)
  assert.equal(result.ok, true, result.message)
  // 事实：v2 写作路径（timeline_add → runV2Cycle）不经过 rpc.ts 的 markSynced()，
  // 因此 state.json 的 lastSyncAt 仍为 null —— 这是**既有事实**，不是本模块引入的。
  // 要让 state.json 反映 v2 同步，需要改 src/rpc.ts 或 src/sync/bootstrap.ts（不在本模块文件范围）。
  assert.equal(store.readLastSyncAt(), null)
  assert.equal(store.readRepoError(), null)
})

test('G-D3 脏工作树（远端改别的路径）：快进成功，本地改动与远端记录都保住', async (t) => {
  const top = await makeTopology(t, 'ff-d3')
  const A = await makeEndpoint(t, top, 'A')
  // 远端前进：B 改了 DAY（不是我们要写的那天）。
  pushFromPeer(top, [[timelineRecordsPath(DAY), buildRecordsText(DAY, [rec({ id: 'peer-day', ts: T1, title: 'peer-day' })])]],
    '[v2] sync 1 days')
  git(A.repoDir, ['fetch', '--quiet', 'origin'])
  assert.equal(A.behind(), 1)
  // 本地工作树脏：DAY2 有一个**未提交**的本地记录（模拟 recordWriter 先落盘再触发同步）。
  const day2Path = path.join(A.repoDir, ...timelineRecordsPath(DAY2).split('/'))
  mkdirSync(path.dirname(day2Path), { recursive: true })
  writeFileSync(day2Path, buildRecordsText(DAY2, [
    newTimelineRecord('local-day2', `${DAY2}T01:00:00.000Z`, { title: 'local-day2', body: '', author: 'ff' }),
  ]), 'utf8')
  const untracked = git(A.repoDir, ['ls-files', '--others', '--exclude-standard'])
  assert.ok(untracked.includes(timelineRecordsPath(DAY2)), `未跟踪文件里应有 DAY2：${untracked}`)

  await stage(A, makeIntent({ date: DAY2, id: 'own-day2', ts: `${DAY2}T02:00:00.000Z`, title: 'own-day2' }))
  const result = await runCycle(A, [DAY2])
  assert.equal(result.ok, true, `脏工作树不该让「只落后」失败：${result.message} | ff=${A.ffOutcomes.join(',')}`)
  assert.deepEqual(A.ffOutcomes, ['fast-forwarded'])
  assert.equal(A.ffArgv().length, 1, '快进确实发生')
  assert.equal(A.behind(), 0)
  // 本地未提交的改动没有被丢弃：它被并进提交并推到远端。
  const pushedDay2 = A.remoteFile(timelineRecordsPath(DAY2))
  assert.ok(pushedDay2 !== null)
  const ids = parseTimelineDay(pushedDay2, DAY2).day.allRecords.map((item) => item.id).sort()
  assert.deepEqual(ids, ['local-day2', 'own-day2'])
  // 远端那天（DAY）也在（快进带下来的），本地工作树同样有。
  assert.ok(A.remoteFile(timelineRecordsPath(DAY)).includes('peer-day'))
  assert.ok(A.localFile(timelineRecordsPath(DAY)).includes('peer-day'))
  assert.deepEqual(A.dangerousArgv(), [])
})

test('G-D4 脏工作树（远端改同一天同一文件）：本地写入先提交，再走既有分叉处理，数据零丢失', async (t) => {
  const top = await makeTopology(t, 'ff-d4')
  const A = await makeEndpoint(t, top, 'A')
  // 远端前进：B 在 DAY 写入 peer-same。
  pushFromPeer(top, [[timelineRecordsPath(DAY), buildRecordsText(DAY, [rec({ id: 'peer-same', ts: T1, title: 'peer-same' })])]],
    '[v2] sync 1 days')
  git(A.repoDir, ['fetch', '--quiet', 'origin'])
  assert.equal(A.behind(), 1)
  // 本地工作树脏且与远端**同一个文件**：A 已有一条未提交的本地记录。
  const dayPath = path.join(A.repoDir, ...timelineRecordsPath(DAY).split('/'))
  mkdirSync(path.dirname(dayPath), { recursive: true })
  writeFileSync(dayPath, buildRecordsText(DAY, [
    newTimelineRecord('local-same', T2, { title: 'local-same', body: '', author: 'ff' }),
  ]), 'utf8')
  // 该日文件在种子提交里不存在，所以本地写入是「未跟踪文件」——用 ls-files 列单个文件，
  // 不用 `status --porcelain`（它会把未跟踪目录折叠成一行目录名）。
  const untrackedDay = git(A.repoDir, ['ls-files', '--others', '--exclude-standard'])
  assert.ok(untrackedDay.includes(timelineRecordsPath(DAY)), `本地改动必须在工作树里：${untrackedDay}`)

  await stage(A, makeIntent({ id: 'own-same', ts: T3, title: 'own-same' }))
  const result = await runCycle(A)
  // 快进被本地改动挡住：本层不改写历史，于是走既有分叉处理（本模块提交 → 有界恢复 → 终态）。
  assert.equal(result.ok, false)
  assert.ok([V2_ERROR.LOCAL_PENDING, V2_ERROR.NOT_SYNCED].includes(result.code), `unexpected code: ${result.code}`)
  assert.deepEqual(A.ffOutcomes, ['blocked-by-local-changes'], 'FF 只尝试一次且被本地改动挡住')
  // 关键：本地记录被**提交进本地历史**（不丢），远端记录也并进来了。
  const committed = A.headFile(timelineRecordsPath(DAY))
  assert.ok(committed !== null, '本地写入必须先提交（安全提交路径）')
  const committedIds = parseTimelineDay(committed, DAY).day.allRecords.map((item) => item.id).sort()
  assert.deepEqual(committedIds, ['local-same', 'own-same', 'peer-same'])
  // 本地记录仍在工作树里。
  const onDisk = readFileSync(dayPath, 'utf8')
  assert.ok(onDisk.includes('local-same'))
  assert.ok(onDisk.includes('peer-same'))
  // 没有任何强制/丢弃形态的 argv。
  assert.deepEqual(A.dangerousArgv(), [])
  // 终态文案诚实：不是「已同步」，也没有把本地提交报成功。
  assert.notEqual(result.message, '已同步')
  assert.ok(result.message.length > 0)
})

test('G-D5 拒绝分支保持原样：真分叉 + 非本模块提交 → 同一句文案、零写入、零快进', async (t) => {
  const top = await makeTopology(t, 'ff-d5')
  const A = await makeEndpoint(t, top, 'A')
  // A 本地造一条「外部 writer」提交（无 dsh-dots-v2 尾注，只动 timeline/**）。
  const dayPath = path.join(A.repoDir, ...timelineRecordsPath(DAY).split('/'))
  mkdirSync(path.dirname(dayPath), { recursive: true })
  writeFileSync(dayPath, buildRecordsText(DAY, [rec({ id: 'foreign', ts: T1, title: 'foreign' })]), 'utf8')
  git(A.repoDir, ['add', '-A'])
  git(A.repoDir, ['-c', 'user.name=foreign', '-c', 'user.email=f@localhost', 'commit', '--quiet', '-m', '[v2] sync 1 days'])
  const foreignHead = A.head()
  // 远端同时也前进：双方各有对方没有的提交 = 真分叉。
  const remoteHead = pushFromPeer(top, [[timelineRecordsPath(DAY2), buildRecordsText(DAY2, [
    rec({ id: 'peer2', ts: `${DAY2}T01:00:00.000Z`, title: 'peer2' }),
  ])]], '[v2] sync 1 days')
  git(A.repoDir, ['fetch', '--quiet', 'origin'])
  assert.equal(A.ahead(), 1)
  assert.equal(A.behind(), 1)

  await stage(A, makeIntent({ id: 'never', ts: T2, title: 'never' }))
  const outboxBefore = readFileSync(A.outbox.filePath, 'utf8')
  const result = await runCycle(A)
  assert.equal(result.ok, false)
  assert.equal(result.code, V2_ERROR.NOT_SYNCED)
  assert.equal(result.message, NOT_SYNCED_MESSAGE, '分叉文案逐字不变')
  assert.equal(A.ffArgv().length, 0, '分叉不做快进')
  assert.equal(A.head(), foreignHead, '本地外部提交一字不动')
  assert.equal(A.remote(), remoteHead, '远端没有被推任何东西')
  assert.equal(readFileSync(A.outbox.filePath, 'utf8'), outboxBefore, 'outbox 字节不变（零出队、零 attempts）')
})

test('G-D6 不变量：本地领先且属本模块时的有界恢复仍在（快进不吞掉 M3 通道）', async (t) => {
  const top = await makeTopology(t, 'ff-d6')
  const A = await makeEndpoint(t, top, 'A')
  // 本机提交带尾注只改 timeline/** → 领先 1、落后 0；远端拒收 → 有界恢复 → E_LOCAL_PENDING。
  const dayPath = path.join(A.repoDir, ...timelineRecordsPath(DAY).split('/'))
  mkdirSync(path.dirname(dayPath), { recursive: true })
  writeFileSync(dayPath, buildRecordsText(DAY, [rec({ id: 'ours', ts: T1, title: 'ours' })]), 'utf8')
  git(A.repoDir, ['add', '-A'])
  git(A.repoDir, ['-c', 'user.name=dsh-dots', '-c', 'user.email=sync@localhost', 'commit', '--quiet',
    '-m', '[v2] sync 1 days', '-m', 'dsh-dots-v2: plugin-git-store'])
  assert.equal(A.ahead(), 1)
  assert.equal(A.behind(), 0)
  await mkdir(path.join(top.bare, 'hooks'), { recursive: true })
  await writeFile(path.join(top.bare, 'hooks', 'pre-receive'), '#!/bin/sh\necho rejected-by-ff-d6 >&2\nexit 1\n')
  const result = await runCycle(A)
  assert.equal(result.code, V2_ERROR.LOCAL_PENDING)
  assert.ok(result.message.startsWith(LOCAL_PENDING_MESSAGE))
  assert.equal(A.ffArgv().length, 0, '领先-only 不需要快进')
  assert.deepEqual(A.dangerousArgv(), [])
})
