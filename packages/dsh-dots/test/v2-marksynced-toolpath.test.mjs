/**
 * mod-plugin-v2-marksynced-toolpath：schedule_add 真工具路径上的 lastSyncAt 落戳验收。
 *
 * 前置：cd packages/dsh-dots; node scripts/build.mjs
 * 被测对象（只读 import）：
 *   dist/schedule/v2Bridge.js  → withV2ScheduleBridge → V2ScheduleBridge.add（真工具装配 + 真周期）
 *   dist/sync/bootstrap.js     → createDefaultMarkSynced（唯一默认落戳实现）
 *   dist/sync/cycle.js         → 真实 git 同步周期
 *
 * 夹具逐字复用 test/sync-convergence.test.mjs:92-163（真裸远端 + production 端口），
 * 不另造第二套 fixture；全部落盘都在本包 .tmp/ 下，不联网、不碰真实 ~/.dsh、不写项目仓库。
 *
 * 回归背景：add() 直接调 runV2Cycle 后返回，旧实现把 lastSyncAt 漏在 V2SyncRuntime.start() 里，
 * 真保存提交了、state.json 却不动。这里把「成功加 → 戳前进 / 失败、no-op → 戳不动」钉在真工具路径上。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { buildV2Ports, withV2ScheduleBridge } from '../dist/schedule/v2Bridge.js'
import { nowIso } from '../dist/schedule/clock.js'
import { V2_ERROR, makeIntentId } from '../dist/sync/cycle.js'
import { FRESH_SCHEMA_TEXT, parseTimelineDay } from '../dist/timeline/index.js'
import { SCHEMA_MARKER_PATH, timelineRecordsPath } from '../dist/timeline/paths.js'
import { statePaths } from '../dist/engine/paths.js'
import { LocalStateStore, defaultSettings } from '../dist/engine/settings.js'

// ---------------------------------------------------------------- 常量与路径卫生

const TMP_BASE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.tmp')
const DAY = '2026-11-28'
const NOW = new Date('2026-11-28T06:05:00.000Z')
const STAMP_ISO = NOW.toISOString() // 与 v1 rpc.ts markSynced() 同一形状
const OLD_ISO = '2026-11-01T00:00:00.000Z'

function isUnder(child, parent) {
  const c = path.resolve(child)
  const p = path.resolve(parent)
  return c === p || c.startsWith(`${p}${path.sep}`)
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

// ---------------------------------------------------------------- 夹具（照搬 sync-convergence.test.mjs:92-163）

/** 真裸远端 + 一个只含规范 schema 标记的种子提交。 */
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
  git(seed, ['-c', 'user.name=mtp-seed', '-c', 'user.email=seed@localhost', 'commit', '--quiet', '-m', 'seed v2 schema'])
  git(seed, ['push', '--quiet', 'origin', 'main'])
  return { root, bare, seedSha: git(seed, ['rev-parse', 'HEAD']) }
}

/** 一个 endpoint = 自己的 temp home（state/outbox）+ 自己的 clone + 真 production 端口。 */
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
  assert.equal(built.sharedRepoRoot, rootOverride)
  assert.ok(isUnder(built.repoDir, top.root), `${who} repoDir 越界：${built.repoDir}`)
  assert.ok(isUnder(built.ports.outbox.filePath, top.root), `${who} outbox 越界：${built.ports.outbox.filePath}`)
  assert.ok(isUnder(paths.root, top.root), `${who} stateRoot 越界：${paths.root}`)

  git(top.root, ['clone', '--quiet', top.bare, built.repoDir])
  await built.ports.git.prepare()
  git(built.repoDir, ['fetch', '--quiet', 'origin'])
  assert.equal(
    git(built.repoDir, ['rev-parse', 'HEAD']),
    git(built.repoDir, ['rev-parse', 'refs/remotes/origin/main']),
  )
  const ep = {
    who, deviceId: who, home, rootOverride, paths, settings,
    repoDir: built.repoDir, fs: built.ports.fs, git: built.ports.git, outbox: built.ports.outbox,
    dispose: built.dispose,
  }
  t.after(async () => { await ep.dispose() })
  return ep
}

/**
 * 真工具装配：withV2ScheduleBridge 把 paths 透传给桥的默认落戳器，再调用 bridge.add。
 * 端口直接用 makeEndpoint 造出的 production 端口（不塞 spy、不替周期执行器）。
 */
async function addViaTool(ep, input, day = DAY) {
  return await withV2ScheduleBridge({
    paths: ep.paths,
    settings: ep.settings,
    token: null,
    homeDir: ep.home,
    env: { DSH_DOTS_REPO_ROOT: ep.rootOverride },
    allowLocalRepo: true,
    ports: { repoDir: ep.repoDir, fs: ep.fs, git: ep.git, outbox: ep.outbox },
    now: () => NOW,
  }, async (bridge) => await bridge.add(ep.deviceId, day, input))
}

// ================================================================ T1

test('T1 成功 add：state.json.lastSyncAt 前进，记录进 timeline/<day>/records.json', async (t) => {
  const top = await makeTopology(t, 'mtp-t1')
  const ep = await makeEndpoint(t, top, 'A')
  const store = new LocalStateStore(ep.paths)
  store.writeLastSyncAt(OLD_ISO)
  const before = store.readLastSyncAt()
  assert.equal(before, OLD_ISO, '调用前旧戳就位')

  const added = await addViaTool(ep, { title: '真工具路径新建', body: '来自 schedule_add' })
  assert.equal(added.pushed, true, '工具返回值契约不变')
  assert.equal(added.path, timelineRecordsPath(DAY))

  const after = new LocalStateStore(ep.paths).readLastSyncAt()
  assert.equal(after, STAMP_ISO, '成功周期用注入时钟落戳')
  assert.ok(Date.parse(after) > Date.parse(before), 'lastSyncAt 必须前进（不是停在启动周期）')

  // 读真 git 工作副本上的日文件，确认这条记录真的同步到了 timeline/<day>/records.json。
  const text = readFileSync(path.join(ep.repoDir, ...timelineRecordsPath(DAY).split('/')), 'utf8')
  const parsed = parseTimelineDay(text, DAY)
  assert.equal(parsed.errors.length, 0)
  assert.ok(parsed.day.allRecords.some((r) => r.id === added.id), '记录落在当天日文件')
  assert.equal(
    git(ep.repoDir, ['rev-parse', 'HEAD']),
    git(ep.repoDir, ['rev-parse', 'refs/remotes/origin/main']),
    '成功周期确实提交并推送',
  )
})

// ================================================================ T2

test('T2 push 失败：typed 错误照旧抛出，lastSyncAt 一字不动', async (t) => {
  const top = await makeTopology(t, 'mtp-t2')
  const ep = await makeEndpoint(t, top, 'A')
  const store = new LocalStateStore(ep.paths)
  store.writeLastSyncAt(OLD_ISO)
  const bytesBefore = readFileSync(ep.paths.stateFile, 'utf8')

  // 真远端拒收：pre-receive 钩子，周期必然 E_PUSH_REJECTED。
  const hooks = path.join(top.bare, 'hooks')
  await mkdir(hooks, { recursive: true })
  const hook = path.join(hooks, 'pre-receive')
  await writeFile(hook, '#!/bin/sh\necho rejected-by-mtp-t2 >&2\nexit 1\n')
  chmodSync(hook, 0o755)

  await assert.rejects(
    () => addViaTool(ep, { title: '推不上去' }),
    (error) => {
      assert.equal(error.code, V2_ERROR.PUSH_REJECTED, '失败仍是同一个 typed 错码')
      assert.match(error.message, /下一步/)
      return true
    },
  )
  assert.equal(readFileSync(ep.paths.stateFile, 'utf8'), bytesBefore, '失败分支零落戳：state.json 逐字节不变')
  assert.equal(store.readLastSyncAt(), OLD_ISO)
})

// ================================================================ T3

test('T3 no-op 周期（writtenPaths 为空）：lastSyncAt 不变 —— attempts 在 writtenPaths 为空时保持 0（cycle.ts:1472），"没写入" 不算一次同步', async (t) => {
  const top = await makeTopology(t, 'mtp-t3')
  const ep = await makeEndpoint(t, top, 'A')
  /*
   * 造一个真 no-op 周期：先成功 add 一次让 timeline/<day>/records.json 收敛（否则空日容器本身
   * 就是一次写入，不算 no-op）；再预放一条 intentId 与第二次 add 将生成的意图完全相同、但 date
   * 落在别日的 outbox 项。enqueueIntent 按 intentId 去重 ⇒ 当天没有可重放意图 ⇒ 周期零写入。
   * 钉死 Math.random 只为算出该 intentId（newRecordId 的随机后缀固定为 0），不改产品代码。
   */
  const randomBefore = Math.random
  try {
    Math.random = () => 0
    const base = `${NOW.getTime().toString(36)}-0`
    await addViaTool(ep, { title: '先落一条基线' })

    // 第二次 add 会避让已用的 base，生成 `${base}-1`；预置同 intentId 的别日项让它被去重。
    const id = `${base}-1`
    const ts = nowIso(NOW)
    await ep.outbox.save([{
      intentId: makeIntentId(DAY, id, ts, 'upsert'),
      op: 'upsert', date: '1999-01-01', id, ts, line: '',
      enqueuedAt: ts, attempts: 0, state: 'pending', lastError: '',
    }])

    const afterFirst = new LocalStateStore(ep.paths).readLastSyncAt()
    assert.equal(afterFirst, STAMP_ISO, '第一次成功 add 应该落戳')
    const bytesBefore = readFileSync(ep.paths.stateFile, 'utf8')
    const added = await addViaTool(ep, { title: 'no-op 不应落戳' })
    assert.deepEqual(added.files, [], 'writtenPaths 为空 ⇒ 工具 files 为空')
    assert.equal(added.commit, '', '没有提交就没有 commit')
    assert.equal(readFileSync(ep.paths.stateFile, 'utf8'), bytesBefore, 'no-op 零落戳：state.json 逐字节不变')
    assert.equal(new LocalStateStore(ep.paths).readLastSyncAt(), afterFirst, 'attempts 为 0 的周期不得推进「最近同步」')
  } finally {
    Math.random = randomBefore
  }
})

// ================================================================ T4

test('T4 落戳 ISO 形状与 v1 一致：Date.toISOString() 可被面板解析', async (t) => {
  const top = await makeTopology(t, 'mtp-t4')
  const ep = await makeEndpoint(t, top, 'A')
  await addViaTool(ep, { title: 'ISO 形状' })

  const written = new LocalStateStore(ep.paths).readLastSyncAt()
  assert.equal(written, NOW.toISOString(), '与 v1 markSynced() 同一 toISOString() 形状')
  assert.match(written, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  assert.ok(Number.isFinite(Date.parse(written)))
  const d = new Date(written) // client.js fmtClock 的解析方式
  assert.equal(Number.isNaN(d.getTime()), false)
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  assert.match(hhmm, /^\d{2}:\d{2}$/)
})
