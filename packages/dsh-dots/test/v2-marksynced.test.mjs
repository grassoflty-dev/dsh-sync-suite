/**
 * mod-plugin-v2-marksynced：`state.json.lastSyncAt` 的唯一成功判据与唯一落戳点。
 *
 * 被测对象（前置：packages/dsh-dots 下 `node scripts/build.mjs`）：
 *   dist/sync/bootstrap.js  → shouldMarkSynced / stampIfSynced / V2SyncRuntime
 *   dist/rpc.js             → createRpcService().markSyncedFromCycle
 *
 * 四条硬约束逐条钉住：① 没同步就不宣称；② 一次成功恰好一戳（两个调用点共用 seam）；
 * ③ 面板解析的 ISO 形状不变；④ 失败 / outbox 停放路径零行为变更。
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { shouldMarkSynced, stampIfSynced, V2SyncRuntime } from '../dist/sync/bootstrap.js'
import { NodeOutboxPort } from '../dist/sync/outbox.js'
import { LocalStateStore, SettingsStore, defaultSettings } from '../dist/engine/settings.js'
import { statePaths } from '../dist/engine/paths.js'
import { createRpcService } from '../dist/rpc.js'

const DAY = '2026-11-27'
const TS = `${DAY}T10:00:00+08:00`
const FIXED_DATE = new Date('2026-11-27T06:05:00.000Z')
const FIXED_ISO = '2026-11-27T06:05:00.000Z'
const URL = 'https://example.test/owner/repo.git'
const DIVerged_MESSAGE = '本地 HEAD 与 origin/main 不一致，本层不改写历史'
const exec = promisify(execFile)

function result(overrides = {}) {
  return {
    ok: true, code: 'ok', message: '已同步', days: [DAY], applied: 1, dropped: 0,
    failed: 0, pending: 0, attempts: 1, conflicts: 0,
    writtenPaths: [`timeline/${DAY}/records.json`], outbox: [], ...overrides,
  }
}

function noOp() {
  return result({ attempts: 0, applied: 0, writtenPaths: [], message: 'no-op 周期' })
}

function parked() {
  // 没有任何东西到达远端：attempts===0，意图仍停在 outbox（pending===1）。
  return result({ attempts: 0, pending: 1, writtenPaths: [], message: '仅本地停放' })
}

function diverged() {
  return result({ ok: false, code: 'E_NOT_SYNCED', message: DIVerged_MESSAGE, attempts: 0, writtenPaths: [] })
}

function intent() {
  return {
    intentId: `upsert:${DAY}:a1:seed`, op: 'upsert', date: DAY, id: 'a1', ts: TS,
    line: JSON.stringify({ id: 'a1', ts: TS, title: 't', body: '', author: '我', done: false }),
    enqueuedAt: TS, attempts: 0, state: 'pending', lastError: '',
  }
}

async function configuredRuntime(home, extra = {}) {
  const paths = statePaths(home)
  new SettingsStore(paths, { allowLocalRepo: true }).writeSettings({ ...defaultSettings(), repoUrl: URL })
  await new NodeOutboxPort({ stateRoot: paths.root, repoUrl: URL }).save([intent()])
  return new V2SyncRuntime({
    homeDir: home, appFilesDir: '', allowLocalRepo: true, now: FIXED_DATE, ...extra,
  })
}

async function withEnv(t, home, extra = {}) {
  const saved = { repo: process.env.DSH_DOTS_REPO_ROOT, app: process.env.DSH_DOTS_APP_FILES_DIR }
  delete process.env.DSH_DOTS_REPO_ROOT
  delete process.env.DSH_DOTS_APP_FILES_DIR
  t.after(() => {
    if (saved.repo !== undefined) process.env.DSH_DOTS_REPO_ROOT = saved.repo
    if (saved.app !== undefined) process.env.DSH_DOTS_APP_FILES_DIR = saved.app
  })
  return await configuredRuntime(home, extra)
}

/** v1 push 真链路：临时裸仓库 + 本地 profile，不联网、不碰真实 ~/.dsh。 */
async function localRepoService(t, root) {
  const bare = path.join(root, 'remote.git')
  await exec('git', ['init', '--bare', '-b', 'main', bare])
  const home = path.join(root, 'home')
  const profile = path.join(root, 'profile')
  await mkdir(profile, { recursive: true })
  await writeFile(path.join(profile, 'cordis.patch.yml'), '# local\n', 'utf8')
  const service = createRpcService({
    homeDir: home, profileDir: profile, dshVersion: 'test-1',
    allowLocalRepo: true, now: () => FIXED_DATE,
  })
  t.after(async () => { await service.dispose() })
  const settings = {
    ...defaultSettings(), platform: 'custom', authMode: 'https', branch: 'main',
    scope: { config: true, providers: true, plugins: true, mcp: true },
    repoUrl: bare, deviceId: 'pc-a',
  }
  const saved = await service.handleRpc({ action: 'saveSettings', settings })
  assert.equal(saved.ok, true, JSON.stringify(saved))
  return { service, settings, home }
}

test('MS-01 shouldMarkSynced 总函数：pushed:false / 仅 outbox 停放 / diverged-refused 及一切畸形形状全部拒绝', () => {
  const rejects = [
    null, undefined, 0, 1, 'ok', '', [], {},
    { pushed: false }, { pushed: undefined }, { pushed: 0 }, { pushed: 'true' },
    { pushed: false, verified: true }, { pushed: false, ok: true, code: 'ok', attempts: 1 },
    { verified: false }, { verified: 'true' },
    noOp(), parked(), diverged(),
    result({ ok: false, code: 'E_PUSH_REJECTED', attempts: 1 }),
    result({ ok: true, code: 'E_LOCAL_PENDING', attempts: 2 }),
    // 真·缺字段必须用 delete 造（result() 默认带齐 ok/code/attempts，覆盖不等于删除）。
    // attempts 整体缺失 / undefined 的 schema 变更必须被挡住（只钉 attempts:0 不够）。
    (() => { const r = result(); delete r.ok; return r })(),
    (() => { const r = result(); delete r.code; return r })(),
    (() => { const r = result(); delete r.attempts; return r })(),
    (() => { const r = result(); r.attempts = undefined; return r })(),
    result({ ok: true, code: 'ok', attempts: 0 }),
    result({ ok: true, code: 'ok', attempts: -1 }), result({ ok: true, code: 'ok', attempts: NaN }),
    result({ ok: true, code: 'ok', attempts: Infinity }),
    result({ ok: true, code: 'ok', attempts: -Infinity }),
    result({ ok: true, code: 'ok', attempts: '1' }), result({ ok: 1, code: 'ok', attempts: 1 }),
  ]
  for (const value of rejects) {
    assert.equal(shouldMarkSynced(value), false, `不应落戳：${JSON.stringify(value)}`)
  }
})

test('MS-02 shouldMarkSynced 接受：v1 push(pushed:true) / v1 apply(verified:true) / v2 真实推送周期', () => {
  const accepts = [
    { pushed: true },
    { pushed: true, commit: 'sha' },
    { applied: [], skipped: [], snapshotId: 's', verified: true },
    result(),
    result({ days: [], writtenPaths: [], attempts: 2, message: '已同步（本地未推提交已恢复）' }),
    result({ pending: 2, message: '另有不相关停放意图' }),
    result({ attempts: Number.MAX_VALUE }), // 有限正数仍是正面证据
  ]
  for (const value of accepts) {
    assert.equal(shouldMarkSynced(value), true, `应当落戳：${JSON.stringify(value)}`)
  }
})

test('MS-03 stampIfSynced：判据为假零调用，判据为真每次恰好一次 mark', () => {
  const calls = []
  const mark = (r) => calls.push(r)
  assert.equal(stampIfSynced(parked(), mark), false)
  assert.equal(stampIfSynced(diverged(), mark), false)
  assert.equal(stampIfSynced({ pushed: false }, mark), false)
  assert.equal(calls.length, 0)
  assert.equal(stampIfSynced(result(), mark), true)
  assert.equal(calls.length, 1)
  assert.equal(stampIfSynced(noOp(), mark), false)
  assert.equal(calls.length, 1)
  assert.equal(stampIfSynced({ pushed: true }, mark), true)
  assert.equal(calls.length, 2)
})

test('MS-04 markSyncedFromCycle 落戳形状：复用 now().toISOString()，面板可解析', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-marksynced-iso-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const service = createRpcService({ homeDir: home, allowLocalRepo: true, now: () => FIXED_DATE })
  t.after(async () => { await service.dispose() })
  assert.equal(typeof service.markSyncedFromCycle, 'function')

  service.markSyncedFromCycle(diverged())
  assert.equal(new LocalStateStore(statePaths(home)).readLastSyncAt(), null, '失败路径绝不落戳')

  service.markSyncedFromCycle(result())
  const written = new LocalStateStore(statePaths(home)).readLastSyncAt()
  assert.equal(written, FIXED_ISO)
  assert.match(written, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  assert.ok(Number.isFinite(Date.parse(written)))
  const d = new Date(written) // client.js fmtClock 的解析方式
  assert.equal(Number.isNaN(d.getTime()), false)
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  assert.match(hhmm, /^\d{2}:\d{2}$/)
})

test('MS-05 两个调用点共用一次落戳：start() + syncNow() 后 spy 恰好一次', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-marksynced-once-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const stamps = []
  let cycles = 0
  const runtime = await withEnv(t, home, {
    markSynced: (r) => stamps.push(r),
    cycleRunner: async () => {
      cycles += 1
      return cycles === 1 ? result() : noOp()
    },
  })

  const status = await runtime.start()
  assert.equal(status.ok, true, status.message)
  assert.equal(cycles, 1)
  assert.equal(stamps.length, 1)
  assert.equal(runtime.syncedStampCount, 1)

  const second = await runtime.syncNow([DAY])
  assert.equal(second.ok, true)
  assert.equal(cycles, 2)
  assert.equal(stamps.length, 1, '第二个调用点的 no-op 周期不得再落戳')
  assert.equal(runtime.syncedStampCount, 1)
})

test('MS-06 失败路径零行为变更：diverged/refused 周期仍返回 typed 错误且 lastSyncAt 不动', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-marksynced-refuse-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const stamps = []
  const runtime = await withEnv(t, home, {
    markSynced: (r) => stamps.push(r),
    cycleRunner: async () => diverged(),
  })

  const status = await runtime.start()
  assert.equal(status.ok, false)
  assert.equal(status.code, 'E_NOT_SYNCED')
  assert.equal(status.message, DIVerged_MESSAGE)
  assert.equal(status.cycle.ok, false)
  assert.equal(runtime.syncedStampCount, 0)
  assert.equal(stamps.length, 0)
  assert.equal(new LocalStateStore(statePaths(home)).readLastSyncAt(), null)
})

test('MS-07 outbox 停放路径：pending 意图仍在、零落戳', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-marksynced-outbox-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const stamps = []
  const runtime = await withEnv(t, home, {
    markSynced: (r) => stamps.push(r),
    cycleRunner: async () => parked(),
  })

  const cycle = await runtime.syncNow([DAY])
  assert.equal(cycle.ok, true)
  assert.equal(cycle.attempts, 0, '本周期没有任何推送')
  assert.equal(cycle.pending, 1)
  assert.equal(stamps.length, 0, '仅本地写入停放时绝不宣称同步')
  assert.equal(runtime.syncedStampCount, 0)
  const entries = await runtime.outbox.load()
  assert.equal(entries.length, 1)
  assert.equal(entries[0].intentId, intent().intentId)
  assert.equal(new LocalStateStore(statePaths(home)).readLastSyncAt(), null)
})

test('MS-08 谓词永不抛：抛异常的 getter / 被撤销的 Proxy 只返回 false', () => {
  const throwing = new Proxy({}, { get() { throw new Error('getter boom') } })
  assert.equal(shouldMarkSynced(throwing), false)
  const revoked = Proxy.revocable({ ok: true, code: 'ok', attempts: 1 }, {})
  revoked.revoke()
  assert.equal(shouldMarkSynced(revoked.proxy), false)
  assert.equal(stampIfSynced(revoked.proxy, () => { throw new Error('不得被调用') }), false)
})

test('MS-09 每个成功周期恰好盖一次：连续两次成功 ⇒ 每周期各一戳（不是总共一戳）', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-marksynced-twosuccess-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const stamps = []
  // 诚实边界：syncNow() 今天没有生产调用者；这里用它只是钉住两调用点共用的同一落戳点。
  const runtime = await withEnv(t, home, {
    markSynced: (r) => stamps.push(r),
    cycleRunner: async () => result(),
  })

  const first = await runtime.syncNow([DAY])
  assert.equal(first.ok, true)
  assert.equal(stamps.length, 1, '第 1 个成功周期恰好一戳')
  assert.equal(runtime.syncedStampCount, 1)
  const second = await runtime.syncNow([DAY])
  assert.equal(second.ok, true)
  assert.equal(stamps.length, 2, '第 2 个成功周期再盖一戳')
  assert.equal(runtime.syncedStampCount, 2)
})

test('MS-10 v1 既有语义：push 返回 pushed:false 仍落戳；push 抛错不落戳', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-marksynced-v1-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { service, settings, home } = await localRepoService(t, root)

  const first = await service.handleRpc({ action: 'push' })
  assert.equal(first.ok, true, JSON.stringify(first))
  assert.equal(first.data.pushed, true)
  assert.equal(new LocalStateStore(statePaths(home)).readLastSyncAt(), FIXED_ISO)

  const second = await service.handleRpc({ action: 'push' })
  assert.equal(second.ok, true, JSON.stringify(second))
  assert.equal(second.data.pushed, false, '没有新提交时 git 报 up-to-date')
  assert.equal(new LocalStateStore(statePaths(home)).readLastSyncAt(), FIXED_ISO, 'v1 pushed:false 照旧落戳')

  const broken = path.join(root, 'missing.git')
  const savedBroken = await service.handleRpc({ action: 'saveSettings', settings: { ...settings, repoUrl: broken } })
  assert.equal(savedBroken.ok, true)
  const failed = await service.handleRpc({ action: 'push' })
  assert.equal(failed.ok, false, 'clone 不存在的本地仓库必须 typed 失败')
  assert.equal(new LocalStateStore(statePaths(home)).readLastSyncAt(), FIXED_ISO, '抛错路径不写新戳')
})

test('MS-11 落戳失败隔离：writeLastSyncAt 抛错被吞，宿主保存仍成功且周期结果不变', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-marksynced-isolation-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const original = LocalStateStore.prototype.writeLastSyncAt
  LocalStateStore.prototype.writeLastSyncAt = function () { throw new Error('state.json read-only') }
  t.after(() => { LocalStateStore.prototype.writeLastSyncAt = original })

  const { service, home } = await localRepoService(t, root)
  service.markSyncedFromCycle(result()) // 不抛
  const state = await service.handleRpc({ action: 'getState' })
  assert.equal(state.ok, true, '落戳失败不改变 RPC 读')
  const pushed = await service.handleRpc({ action: 'push' })
  assert.equal(pushed.ok, true, JSON.stringify(pushed)) // 宿主保存/推送仍成功
  assert.equal(new LocalStateStore(statePaths(home)).readLastSyncAt(), null, '写入抛错时没有半成品状态')

  const expected = result()
  const runtime = await withEnv(t, path.join(root, 'runtime-home'), {
    markSynced: () => { throw new Error('stamp boom') },
    cycleRunner: async () => expected,
  })
  const cycle = await runtime.syncNow([DAY])
  assert.deepEqual(cycle, expected, '落戳失败不改变周期结果')
  assert.equal(runtime.syncedStampCount, 0)
})
