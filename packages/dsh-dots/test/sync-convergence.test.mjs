/**
 * `mod-sync-convergence-harness`：真实 git 端到端收敛测试（TESTS/TOOLING ONLY）。
 *
 * 与 `plugin-v2-cycle.test.mjs` 的 FakeGit、`plugin-pending-ownership.test.mjs` 的单克隆
 * 归因不同：本文件每个场景都在 temp 里建 **一个裸远端 + 两个独立 clone（endpoint A/B）**，
 * 两侧各自持有 production 构造的 `GitRepoV2Port` / `NodeTimelineFs` / `NodeOutboxPort`，
 * 直接调用 shipped `runV2Cycle`，全部 git 操作都经过真实进程，没有任何 FakeGit。
 *
 * 硬约束：
 *  - 所有落盘路径（repoDir / outbox / state / bare remote）都在本包 `.tmp/` 下；
 *    显式 homeDir + DSH_DOTS_REPO_ROOT env 注入，绝不使用真实 `~/.dsh`。
 *  - 无网络、无 sleep；git 操作同步断言。
 *  - 不修改产品源码、不构建 dist、不在项目仓库执行任何 git 写命令。
 *  - 「pull」在夹具里 = `git fetch` + `git merge --ff-only origin/main`（快进，不是改写历史）；
 *    这是两个对等 clone 之间追赶远端所必需的运维动作，v2 端口本身没有 pull/rebase 面。
 *
 * 被测对象（只读 import）：dist/sync/cycle.js + dist/sync/gitPort.js +
 *   dist/schedule/v2Bridge.js + dist/timeline/* + dist/engine/*。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  V2_ERROR,
  DEFAULT_V2_INSTANCE_ID,
  describePendingOwnership,
  enqueueIntent,
  isConfinedTimelinePath,
  isOursCommit,
  makeIntentId,
  runV2Cycle,
  syncCommitMessage,
  v2TrailerLine,
} from '../dist/sync/cycle.js'
import { FRESH_SCHEMA_TEXT, buildRecordsText, canonicalRecordLine, parseLedger, parseTimelineDay, visibleRecords } from '../dist/timeline/index.js'
import { SCHEMA_MARKER_PATH, timelineConflictsPath, timelineDeletedPath, timelineRecordsPath, timelineRestorePath } from '../dist/timeline/paths.js'
import { buildV2Ports, newTimelineRecord, V2ScheduleBridge } from '../dist/schedule/v2Bridge.js'
import { statePaths } from '../dist/engine/paths.js'
import { defaultSettings } from '../dist/engine/settings.js'

// ---------------------------------------------------------------- 常量与路径卫生

const TMP_BASE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.tmp')
const DAY = '2026-11-23'
const T1 = `${DAY}T01:30:00.000Z`
const T2 = `${DAY}T02:30:00.000Z`
const T3 = `${DAY}T03:30:00.000Z`
const T0 = `${DAY}T00:30:00.000Z`
const NOW = new Date(T2) // 注入时钟：周期决策不读墙钟，冲突行 decidedAt 由 ts 派生

function isUnder(child, parent) {
  const c = path.resolve(child)
  const p = path.resolve(parent)
  return c === p || c.startsWith(`${p}${path.sep}`)
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}
function gitQuiet(cwd, args) {
  try {
    git(cwd, args)
    return true
  } catch {
    return false
  }
}
function headSha(ep) { return git(ep.repoDir, ['rev-parse', 'HEAD']) }
function originSha(ep) { return git(ep.repoDir, ['rev-parse', 'refs/remotes/origin/main']) }
function remoteSha(top) { return git(top.bare, ['rev-parse', 'refs/heads/main']) }
function commitCount(ep) { return git(ep.repoDir, ['rev-list', '--count', 'HEAD']) }
function treeSha(ep) { return git(ep.repoDir, ['rev-parse', 'HEAD^{tree}']) }

function outboxBytes(ep) {
  try {
    return readFileSync(ep.outbox.filePath, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}
function sha256(text) { return createHash('sha256').update(text, 'utf8').digest('hex') }

// ---------------------------------------------------------------- 夹具

/** 真实裸远端 + 一个种子提交（只含规范 schema 标记），让两个 clone 出生在 HEAD==origin/main。 */
async function makeTopology(t, label) {
  const root = await mkdtemp(path.join(TMP_BASE, `${label}-`))
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  assert.ok(isUnder(root, TMP_BASE), '夹具根必须落在本包 .tmp 下')

  const bare = path.join(root, 'remote.git')
  assert.ok(isUnder(bare, root))
  git(root, ['init', '--bare', '--initial-branch=main', bare])

  const seed = path.join(root, 'seed')
  git(root, ['clone', '--quiet', bare, seed])
  git(seed, ['config', 'core.autocrlf', 'false'])
  git(seed, ['config', 'core.safecrlf', 'false'])
  await mkdir(path.join(seed, 'timeline'), { recursive: true })
  await writeFile(path.join(seed, SCHEMA_MARKER_PATH), FRESH_SCHEMA_TEXT)
  git(seed, ['add', SCHEMA_MARKER_PATH])
  git(seed, ['-c', 'user.name=sc-seed', '-c', 'user.email=seed@localhost', 'commit', '--quiet', '-m', 'seed v2 schema'])
  git(seed, ['push', '--quiet', 'origin', 'main'])
  const seedSha = git(seed, ['rev-parse', 'HEAD'])
  assert.equal(remoteSha({ bare }), seedSha)
  return { root, bare, seedSha }
}

/**
 * 一个 endpoint = 自己的 temp home（state/outbox）+ 自己的 clone + 真实 production 端口。
 * 路径解析走 production 的 resolveV2RepoRoot（env override），并断言解析结果在 temp 下。
 */
async function makeEndpoint(t, top, who) {
  const home = path.join(top.root, `${who}-home`)
  const rootOverride = path.join(top.root, `${who}-root`)
  const paths = statePaths(home)
  const settings = {
    ...defaultSettings(),
    repoUrl: top.bare,
    platform: 'custom',
    authMode: 'https',
    username: '',
    deviceId: who,
  }
  const built = buildV2Ports({
    paths, settings, token: null, homeDir: home,
    env: { DSH_DOTS_REPO_ROOT: rootOverride },
    allowLocalRepo: true,
  })
  // 路径卫生：工作根来自 env override（temp），仓库与 outbox 都必须落在夹具根内。
  assert.equal(built.sharedRepoRoot, rootOverride)
  assert.ok(isUnder(built.repoDir, top.root), `${who} repoDir 越界：${built.repoDir}`)
  assert.ok(isUnder(built.ports.outbox.filePath, top.root), `${who} outbox 越界：${built.ports.outbox.filePath}`)
  assert.ok(isUnder(paths.root, top.root), `${who} stateRoot 越界：${paths.root}`)

  git(top.root, ['clone', '--quiet', top.bare, built.repoDir])
  // prepare() 复用 production 的 GitRepo.ensureWorkTree：已存在工作副本时只核对 remote + 关 CRLF 转换，
  // 不产生任何历史改写；随后显式 fetch 让 origin/main 可见。
  await built.ports.git.prepare()
  git(built.repoDir, ['fetch', '--quiet', 'origin'])
  assert.equal(headSha({ repoDir: built.repoDir }), originSha({ repoDir: built.repoDir }))

  const ep = {
    who,
    deviceId: who,
    home,
    stateRoot: paths.root,
    repoDir: built.repoDir,
    bare: top.bare,
    ...built.ports,
    dispose: built.dispose,
    bridge: new V2ScheduleBridge({ ports: built.ports, deviceId: who, now: () => NOW }),
  }
  t.after(async () => { await ep.dispose() })
  return ep
}

/** 对等 clone 的「pull」= fetch + 只快进合并，绝不 rebase / reset。 */
function ffPull(ep) {
  git(ep.repoDir, ['fetch', '--quiet', 'origin'])
  git(ep.repoDir, ['merge', '--ff-only', 'origin/main'])
}

function record({ id, ts, title, body = '', author = 'sc' }) {
  return newTimelineRecord(id, ts, { title, body, author })
}

function upsertIntent(ep, spec) {
  const date = spec.date ?? DAY
  const rec = record(spec)
  const line = canonicalRecordLine(rec)
  return {
    intentId: makeIntentId(date, spec.id, spec.ts, 'upsert'),
    op: 'upsert', date, id: spec.id, ts: spec.ts, line,
    enqueuedAt: spec.ts, attempts: 0, state: 'pending', lastError: '',
  }
}
function deleteIntent(ep, spec) {
  const date = spec.date ?? DAY
  return {
    intentId: makeIntentId(date, spec.id, spec.ts, 'delete'),
    op: 'delete', date, id: spec.id, ts: spec.ts, line: '',
    enqueuedAt: spec.ts, attempts: 0, state: 'pending', lastError: '',
  }
}
async function stage(ep, intent) {
  await ep.outbox.save(enqueueIntent(await ep.outbox.load(), intent))
  return intent
}
function runCycle(ep, opts = {}) {
  return runV2Cycle({
    days: opts.days ?? [DAY],
    git: ep.git, fs: ep.fs, outbox: ep.outbox, now: NOW,
    ...(opts.instanceId !== undefined ? { instanceId: opts.instanceId } : {}),
  })
}
async function recordsText(ep, date = DAY) { return (await ep.fs.read(timelineRecordsPath(date))) ?? '' }
function visibleIds(ep, text) {
  const parsed = parseTimelineDay(text, DAY)
  return parsed.day.allRecords.map((r) => r.id).sort()
}
function conflictRows(ep) {
  return readFileSync(path.join(ep.repoDir, ...timelineConflictsPath(DAY).split('/')), 'utf8')
}

/** 直接用真实 git 造一个本地提交（subject/body/路径由调用方指定），用于模拟外部 writer。 */
function commitDirect(ep, files, subject, body = '') {
  for (const [rel, text] of files) {
    const full = path.join(ep.repoDir, ...rel.split('/'))
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, text, 'utf8')
  }
  git(ep.repoDir, ['add', '-A'])
  const args = ['-c', 'user.name=sc-direct', '-c', 'user.email=direct@localhost', 'commit', '--quiet', '-m', subject]
  if (body !== '') args.push('-m', body)
  git(ep.repoDir, args)
}

/** 两个 writer 交错：first 提交并推，second 快进追赶后提交并推，first 再追赶。 */
async function twoWriters(t, label, first, second) {
  const top = await makeTopology(t, label)
  const A = await makeEndpoint(t, top, 'A')
  const B = await makeEndpoint(t, top, 'B')
  const eps = { A, B }
  const w1 = eps[first.who]
  const w2 = eps[second.who]
  await stage(w1, upsertIntent(w1, first))
  const r1 = await runCycle(w1)
  assert.equal(r1.ok, true, `first cycle failed: ${r1.message}`)
  ffPull(w2)
  await stage(w2, upsertIntent(w2, second))
  const r2 = await runCycle(w2)
  assert.equal(r2.ok, true, `second cycle failed: ${r2.message}`)
  ffPull(w1)
  return { top, A, B }
}

// ================================================================ SC-01

test('SC-01 convergence after interleaved writes: both clones byte-identical, HEAD==origin/main', async (t) => {
  const top = await makeTopology(t, 'sc01')
  const A = await makeEndpoint(t, top, 'A')
  const B = await makeEndpoint(t, top, 'B')

  // A 走 production 工具写路径（V2ScheduleBridge.add → outbox → runV2Cycle）。
  const x = await A.bridge.add(A.deviceId, DAY, { title: 'X-from-A', body: 'x-body', author: 'alice' })
  assert.equal(x.pushed, true)
  assert.match(x.path, /^timeline\/\d{4}-\d{2}-\d{2}\/records\.json$/)
  // B 快进追赶后写 Y；两步都是真实 git push。
  ffPull(B)
  const y = await B.bridge.add(B.deviceId, DAY, { title: 'Y-from-B', body: 'y-body', author: 'bob' })
  assert.equal(y.pushed, true)
  ffPull(A)
  const idle = await runCycle(A)
  assert.equal(idle.ok, true, idle.message)
  assert.equal(idle.writtenPaths.length, 0)

  const ta = await recordsText(A)
  const tb = await recordsText(B)
  assert.equal(ta, tb)
  assert.deepEqual(visibleIds(A, ta), [x.id, y.id].sort())
  assert.ok(ta.includes('X-from-A') && ta.includes('Y-from-B'))
  // 提交树字节也相同（不仅工作树）。
  assert.equal(git(A.repoDir, ['show', 'HEAD:timeline/' + DAY + '/records.json']),
    git(B.repoDir, ['show', 'HEAD:timeline/' + DAY + '/records.json']))
  for (const ep of [A, B]) {
    assert.equal(headSha(ep), originSha(ep))
    assert.equal(headSha(ep), remoteSha(top))
    assert.deepEqual(await ep.outbox.load(), [])
    assert.equal(ep.outbox.filePath.startsWith(top.root), true)
  }
})

// ================================================================ SC-02

test('SC-02 same id later-ts wins; direction swap yields the same winner', async (t) => {
  const early = { id: 'Z', ts: T1, title: 'early-ts' }
  const late = { id: 'Z', ts: T2, title: 'late-ts' }
  const p1 = await twoWriters(t, 'sc02a', { who: 'A', ...early }, { who: 'B', ...late })
  const p2 = await twoWriters(t, 'sc02b', { who: 'B', ...early }, { who: 'A', ...late })

  const winners = []
  for (const p of [p1, p2]) {
    const ta = await recordsText(p.A)
    const tb = await recordsText(p.B)
    assert.equal(ta, tb)
    const recs = parseTimelineDay(ta, DAY).day.allRecords
    assert.equal(recs.length, 1)
    assert.equal(recs[0].id, 'Z')
    assert.equal(recs[0].ts, T2)
    assert.equal(recs[0].title, 'late-ts')
    // 不同 ts 是静默折叠：没有冲突审计行。
    assert.equal(existsSync(path.join(p.A.repoDir, ...timelineConflictsPath(DAY).split('/'))), false)
    assert.equal(existsSync(path.join(p.B.repoDir, ...timelineConflictsPath(DAY).split('/'))), false)
    for (const ep of [p.A, p.B]) {
      assert.equal(headSha(ep), originSha(ep))
      assert.equal(headSha(ep), remoteSha(p.top))
    }
    winners.push(canonicalRecordLine(recs[0]))
  }
  // 对称性：不管哪一侧先写 early、哪一侧后写 late，胜者逐字节相同。
  assert.equal(winners[0], winners[1])
})

// ================================================================ SC-03

test('SC-03 same id + same ts different bytes: deterministic tie-break, exactly one identical conflict row', async (t) => {
  const a = { id: 'K', ts: T1, title: 'tie-A' }
  const b = { id: 'K', ts: T1, title: 'tie-B' }
  const p1 = await twoWriters(t, 'sc03a', { who: 'A', ...a }, { who: 'B', ...b })
  // 方向互换：B 先写 tie-B，A 后写 tie-A；赢家仍应是 tie-B。
  const p2 = await twoWriters(t, 'sc03b', { who: 'B', ...b }, { who: 'A', ...a })

  const winnerLines = []
  const conflictRowsSeen = []
  for (const p of [p1, p2]) {
    const ta = await recordsText(p.A)
    const tb = await recordsText(p.B)
    assert.equal(ta, tb)
    const recs = parseTimelineDay(ta, DAY).day.allRecords
    assert.equal(recs.length, 1)
    assert.equal(recs[0].title, 'tie-B') // 规范整行 UTF-8 字节较大者胜
    winnerLines.push(canonicalRecordLine(recs[0]))
    for (const ep of [p.A, p.B]) {
      const rows = conflictRows(ep).split(/\r?\n/).filter((r) => r.length > 0)
      assert.equal(rows.length, 1)
      const row = JSON.parse(rows[0])
      assert.equal(row.id, 'K')
      assert.equal(row.ts, T1)
      assert.equal(JSON.parse(row.losingLine).title, 'tie-A')
      assert.match(row.dedupeKey, /^[0-9a-f]{64}$/)
      conflictRowsSeen.push(rows[0])
      assert.equal(headSha(ep), originSha(ep))
      assert.equal(headSha(ep), remoteSha(p.top))
    }
  }
  // 两端的冲突行逐字节一致；两个方向的冲突行也逐字节一致。
  assert.equal(new Set(conflictRowsSeen).size, 1)
  assert.equal(winnerLines[0], winnerLines[1])
})

// ================================================================ SC-04

test('SC-04 delete vs upsert: tombstone wins, no resurrection on a later cycle', async (t) => {
  const top = await makeTopology(t, 'sc04')
  const A = await makeEndpoint(t, top, 'A')
  const B = await makeEndpoint(t, top, 'B')

  await stage(A, upsertIntent(A, { id: 'W', ts: T1, title: 'W-created' }))
  assert.equal((await runCycle(A)).ok, true)
  ffPull(B)

  // B 同时携带一条更晚的 upsert 与一条 tombstone；deletionState 必须让删除胜出。
  await stage(B, upsertIntent(B, { id: 'W', ts: T2, title: 'W-later-upsert' }))
  await stage(B, deleteIntent(B, { id: 'W', ts: T3 }))
  const r = await runCycle(B)
  assert.equal(r.ok, true, r.message)
  ffPull(A)

  for (const ep of [A, B]) {
    const text = await recordsText(ep)
    const parsed = parseTimelineDay(text, DAY)
    const dels = parseLedger((await ep.fs.read(timelineDeletedPath(DAY))) ?? '').entries
    const rest = parseLedger((await ep.fs.read(timelineRestorePath(DAY))) ?? '').entries
    const visible = visibleRecords(parsed.day, dels, rest)
    assert.equal(visible.some((rec) => rec.id === 'W'), false)
    assert.equal(dels.some((e) => e.id === 'W' && e.ts === T3), true)
    assert.equal(headSha(ep), originSha(ep))
    assert.equal(headSha(ep), remoteSha(top))
  }
  assert.equal(await recordsText(A), await recordsText(B))

  // 之后再来一条「陈旧 writer」的旧 ts upsert：必须被丢弃出队，绝不复活 W。
  await stage(A, upsertIntent(A, { id: 'W', ts: T0, title: 'W-stale-resurrect' }))
  const later = await runCycle(A)
  assert.equal(later.ok, true, later.message)
  assert.equal(later.dropped, 1)
  assert.deepEqual(await A.outbox.load(), [])
  const ta = await recordsText(A)
  const dels = parseLedger((await A.fs.read(timelineDeletedPath(DAY))) ?? '').entries
  assert.equal(visibleRecords(parseTimelineDay(ta, DAY).day, dels, []).some((rec) => rec.id === 'W'), false)
})

// ================================================================ SC-05

test('SC-05 parked intent (one rejected push) drains to zero after remote is restored', async (t) => {
  const top = await makeTopology(t, 'sc05')
  const A = await makeEndpoint(t, top, 'A')
  const B = await makeEndpoint(t, top, 'B')

  await stage(A, upsertIntent(A, { id: 'P', ts: T1, title: 'A-ok' }))
  assert.equal((await runCycle(A)).ok, true)
  ffPull(B)

  await stage(B, upsertIntent(B, { id: 'Q', ts: T2, title: 'B-parked' }))
  const hooks = path.join(top.bare, 'hooks')
  await mkdir(hooks, { recursive: true })
  const hook = path.join(hooks, 'pre-receive')
  await writeFile(hook, '#!/bin/sh\necho rejected-by-sc05 >&2\nexit 1\n')

  const first = await runCycle(B)
  assert.equal(first.ok, false)
  assert.equal(first.code, V2_ERROR.PUSH_REJECTED)
  const parked = (await B.outbox.load())[0]
  assert.equal(parked.attempts, 1)
  assert.equal(parked.state, 'pending')
  const remoteAfterFail = remoteSha(top)
  const headAfterFail = headSha(B)
  assert.notEqual(remoteAfterFail, headAfterFail) // 本地已提交，远端没有 → 绝不当成功

  // 恢复远端（移除拒收 hook），下一周期进入 shipped 的有界恢复通道。
  await rm(hook, { force: true })
  const second = await runCycle(B)
  assert.equal(second.ok, true, second.message)
  assert.equal(second.pending, 0)
  assert.equal(second.failed, 0)
  assert.deepEqual(await B.outbox.load(), [])
  assert.equal(outboxBytes(B).trim(), '[]')
  assert.equal(headSha(B), originSha(B))
  assert.equal(remoteSha(top), headSha(B))
  // 每条意图真的落在被推送的提交树里（读远端 main 的 blob，不读工作树）。
  const pushedTree = git(top.bare, ['show', `main:timeline/${DAY}/records.json`])
  assert.ok(pushedTree.includes('B-parked'))
  assert.ok(pushedTree.includes('A-ok'))

  ffPull(A)
  const idle = await runCycle(A)
  assert.equal(idle.ok, true, idle.message)
  assert.deepEqual(await A.outbox.load(), [])
  const aBytes = outboxBytes(A)
  assert.ok(aBytes === null || aBytes.trim() === '[]')
  assert.equal(idle.pending, 0)
  assert.equal(idle.failed, 0)
  assert.equal(headSha(A), originSha(A))
  assert.equal(headSha(A), remoteSha(top))
  assert.equal(remoteSha(top) === remoteAfterFail, false) // 远端确实前进了
})

// ================================================================ SC-06

test('SC-06 no-trailer foreign commit blocks; ownership verdict is named and nothing is pushed', async (t) => {
  const top = await makeTopology(t, 'sc06')
  const A = await makeEndpoint(t, top, 'A')
  const B = await makeEndpoint(t, top, 'B')

  // 先让 outbox 有真实持久化字节，周期失败时这些字节必须一字不动。
  await stage(A, upsertIntent(A, { id: 'F', ts: T1, title: 'foreign-owner' }))
  const bytesBefore = outboxBytes(A)
  assert.ok(bytesBefore && bytesBefore.length > 2)

  // 注入「外部 writer」提交：触碰 timeline/**，subject 是 v2 形状，但没有 dsh-dots-v2: 尾注。
  commitDirect(A, [
    [`timeline/${DAY}/records.json`, buildRecordsText(DAY, [record({ id: 'F', ts: T1, title: 'foreign-owner' })])],
  ], syncCommitMessage(1), '')
  const foreignSha = headSha(A)
  const remoteBefore = remoteSha(top)

  const result = await runCycle(A)
  assert.equal(result.ok, false)
  assert.ok(
    result.code === V2_ERROR.NOT_SYNCED || result.code === V2_ERROR.LOCAL_PENDING,
    `unexpected code: ${result.code}`,
  )
  // 什么都没推：远端 sha 不变，另一个 clone 根本看不到这笔提交。
  assert.equal(remoteSha(top), remoteBefore)
  assert.equal(gitQuiet(B.repoDir, ['cat-file', '-e', foreignSha]), false)
  // 外部提交仍在本地，没有被回退/改写。
  assert.equal(headSha(A), foreignSha)
  assert.equal(git(A.repoDir, ['cat-file', '-t', foreignSha]), 'commit')
  // 停放的 outbox 字节不变（零出队、零 attempts 增加）。
  assert.equal(outboxBytes(A), bytesBefore)

  // 终态归因：真实 aheadCommits() → describePendingOwnership 点名「非本模块 / 尾注缺失」。
  const commits = await A.git.aheadCommits()
  assert.equal(commits.length, 1)
  const verdict = describePendingOwnership(commits)
  assert.equal(verdict.ours, false)
  assert.equal(verdict.verdicts[0].verdict, 'foreign')
  assert.equal(verdict.verdicts[0].trailer, false)
  assert.match(verdict.verdicts[0].reason, /尾注缺失/)
  assert.match(verdict.summary, /第 1 条 非本模块（尾注缺失）/)
  assert.equal(isOursCommit(commits[0]), false)
  // shipped 的 E_NOT_SYNCED 文案本身点名尾注要求（不含尾注就拒绝）。
  assert.match(result.message, /dsh-dots-v2/)
  assert.match(result.message, /尾注/)

  // 「改宽 isConfinedTimelinePath 就会失败的断言」：严格收容谓词的负/正对照。
  assert.equal(isConfinedTimelinePath('timelineX/x.json'), false)
  assert.equal(isConfinedTimelinePath('timeline/../chats/x.json'), false)
  assert.equal(isConfinedTimelinePath('timeline//x.json'), false)
  assert.equal(isConfinedTimelinePath(`timeline/${DAY}/records.json`), true)
  const outside = {
    subject: syncCommitMessage(1), body: v2TrailerLine(),
    paths: [`timeline/${DAY}/records.json`, 'chats/leak.json'],
  }
  assert.equal(isOursCommit(outside), false)
  assert.equal(describePendingOwnership([outside]).verdicts[0].verdict, 'untrusted')
  assert.equal(describePendingOwnership([outside]).verdicts[0].outsideScopePaths, 1)

  // shipped E_LOCAL_PENDING 终态确实把 describePendingOwnership 的 verdict 逐字写进消息：
  // 用一笔真实「本模块」领先提交 + 拒收 hook 走有界恢复通道（与 foreign 拒绝是两条分支）。
  const top2 = await makeTopology(t, 'sc06b')
  const C = await makeEndpoint(t, top2, 'C')
  const ours = record({ id: 'O', ts: T1, title: 'ours-pending' })
  commitDirect(C, [
    [SCHEMA_MARKER_PATH, FRESH_SCHEMA_TEXT],
    [`timeline/${DAY}/records.json`, buildRecordsText(DAY, [ours])],
  ], syncCommitMessage(1), v2TrailerLine())
  await mkdir(path.join(top2.bare, 'hooks'), { recursive: true })
  await writeFile(path.join(top2.bare, 'hooks', 'pre-receive'), '#!/bin/sh\necho rejected-by-sc06 >&2\nexit 1\n')
  await stage(C, upsertIntent(C, { id: 'O', ts: T1, title: 'ours-pending' }))
  const pending = await runCycle(C)
  assert.equal(pending.code, V2_ERROR.LOCAL_PENDING)
  const ownVerdict = describePendingOwnership(await C.git.aheadCommits())
  assert.equal(ownVerdict.ours, true)
  assert.match(ownVerdict.summary, /第 1 条 本模块/)
  assert.ok(pending.message.includes(ownVerdict.summary), '终态消息必须逐字带出 describePendingOwnership 的 verdict')
  assert.equal(pending.message.includes(DEFAULT_V2_INSTANCE_ID), false) // 不漏实例标识原文
})

// ================================================================ SC-07

test('SC-07 idempotence: converged tree re-run performs no commit and no push', async (t) => {
  const top = await makeTopology(t, 'sc07')
  const A = await makeEndpoint(t, top, 'A')
  const B = await makeEndpoint(t, top, 'B')

  await stage(A, upsertIntent(A, { id: 'I', ts: T1, title: 'written-once' }))
  const first = await runCycle(A)
  assert.equal(first.ok, true, first.message)
  ffPull(B)
  // B 再跑一次空周期，确保两侧都处在收敛态。
  const warm = await runCycle(B)
  assert.equal(warm.ok, true, warm.message)
  assert.equal(warm.writtenPaths.length, 0)

  const snap = (ep) => ({
    head: headSha(ep),
    origin: originSha(ep),
    remote: remoteSha(top),
    count: commitCount(ep),
    tree: treeSha(ep),
    records: sha256(readFileSync(path.join(ep.repoDir, ...timelineRecordsPath(DAY).split('/')), 'utf8')),
    schema: sha256(readFileSync(path.join(ep.repoDir, ...SCHEMA_MARKER_PATH.split('/')), 'utf8')),
  })
  const beforeA = snap(A)
  const beforeB = snap(B)

  const againA = await runCycle(A)
  const againB = await runCycle(B)
  for (const r of [againA, againB]) {
    assert.equal(r.ok, true, r.message)
    assert.equal(r.code, V2_ERROR.OK)
    assert.equal(r.writtenPaths.length, 0)
    assert.equal(r.applied, 0)
    assert.equal(r.attempts, 0) // 没有任何 push 被尝试
  }
  assert.deepEqual(snap(A), beforeA)
  assert.deepEqual(snap(B), beforeB)
  // 没有凭空多出 [v2] 提交，也没有重复根提交。
  const subjectsA = git(A.repoDir, ['log', '--format=%s']).split(/\r?\n/).filter(Boolean)
  assert.equal(subjectsA.filter((s) => s === 'seed v2 schema').length, 1)
  assert.equal(subjectsA.filter((s) => /^\[v2\] sync /.test(s)).length, 1)
  const subjectsB = git(B.repoDir, ['log', '--format=%s']).split(/\r?\n/).filter(Boolean)
  assert.deepEqual(subjectsB, subjectsA)
})
