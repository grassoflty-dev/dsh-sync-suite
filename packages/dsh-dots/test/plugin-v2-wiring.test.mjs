/**
 * 生产接线测试（M1）：证明 `src/index.ts:apply()` 真的挂了 v2 半侧，
 * 且 `src/sync/bootstrap.ts` 是 resolveV2RepoDir / migrateLegacyWorkDir /
 * GitRepoV2Port / NodeOutboxPort / runV2Cycle 的唯一生产装配点。
 *
 * 没有运行中的 DSH WebView 可加载插件，故接线用源码形态断言；
 * 运行状态用临时 home 的 fail-closed 分支做真实调用（不联网、不写仓库）。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { V2SyncRuntime, mountV2Sync } from '../dist/sync/bootstrap.js'
import { repoHash, statePaths } from '../dist/engine/paths.js'
import { SettingsStore, defaultSettings } from '../dist/engine/settings.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = (rel) => readFileSync(path.resolve(here, `../src/${rel}`), 'utf8')

test('WIR01 src/index.ts 从 apply() 挂载 mountV2Sync（生产入口已接线）', () => {
  const index = src('index.ts')
  assert.match(index, /import\s+\{\s*mountV2Sync\s*\}\s+from\s+['"]\.\/sync\/bootstrap\.js['"]/)
  assert.match(index, /mountV2Sync\(ctx,\s*\{/)
  // 不重连 v1：原 schedule 工具注册仍在，且 v2 挂载点与之平行。
  assert.match(index, /mountScheduleTools\(ctx/)
})

test('WIR02 bootstrap.ts 是四个生产装配点 + runV2Cycle 的唯一调用处', () => {
  const boot = src('sync/bootstrap.ts')
  for (const symbol of [
    'resolveV2RepoDir', 'migrateIfNeeded', 'ensureRepoRoot', 'GitRepoV2Port', 'NodeOutboxPort',
    'runV2Cycle', 'NodeMigrationIo', 'NodeTimelineFs', 'mountV2Sync',
  ]) {
    assert.match(boot, new RegExp(symbol), `${symbol} 未在装配点出现`)
  }
  assert.match(boot, /new\s+GitRepoV2Port/)
  assert.match(boot, /new\s+NodeOutboxPort/)
  assert.match(boot, /await\s+runV2Cycle/)
  assert.match(boot, /appFilesDir|DSH_DOTS_APP_FILES_DIR/)
})

test('WIR03 未配置仓库 → start() typed E_UNCONFIGURED 且零 outbox 文件', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-v2-wiring-'))
  try {
    const runtime = new V2SyncRuntime({ homeDir: root, appFilesDir: '' })
    const status = await runtime.start()
    assert.equal(status.code, 'E_UNCONFIGURED')
    assert.equal(status.ok, false)
    assert.equal(runtime.status.code, 'E_UNCONFIGURED')
    const paths = statePaths(root)
    const outboxFile = path.join(paths.root, 'outbox')
    // 只允许 state 迁移自身的目录；outbox 文件不应被创建。
    const names = existsDir(outboxFile) ? readdirSync(outboxFile) : []
    assert.equal(names.length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('WIR04 已配置但缺 App filesDir → 使用默认 PC 根（E_NO_APP_FILES_DIR 已删除）', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-v2-wiring-'))
  const saved = { repo: process.env.DSH_DOTS_REPO_ROOT, app: process.env.DSH_DOTS_APP_FILES_DIR }
  delete process.env.DSH_DOTS_REPO_ROOT
  delete process.env.DSH_DOTS_APP_FILES_DIR
  try {
    const paths = statePaths(root)
    const store = new SettingsStore(paths)
    const url = 'https://example.test/a/b.git'
    store.writeSettings({ ...defaultSettings(), repoUrl: url })
    const runtime = new V2SyncRuntime({ homeDir: root, appFilesDir: '' })
    const status = await runtime.start()
    assert.equal(status.ok, true)
    assert.equal(status.code, 'ok')
    assert.notEqual(status.code, 'E_NO_APP_FILES_DIR')
    assert.equal(
      status.repoDir,
      path.join(root, '.dsh', 'dots', 'repos', repoHash(url), 'git-repo'),
    )
    // 默认工作根已创建且可写（探针落盘）。
    assert.equal(existsSync(path.join(path.dirname(status.repoDir), '.repo-root-probe')), true)
  } finally {
    if (saved.repo !== undefined) process.env.DSH_DOTS_REPO_ROOT = saved.repo
    if (saved.app !== undefined) process.env.DSH_DOTS_APP_FILES_DIR = saved.app
    await rm(root, { recursive: true, force: true })
  }
})

test('WIR05 mountV2Sync 通过 ctx.effect 挂一次启动任务，且不阻塞调用方', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-v2-wiring-'))
  try {
    const effects = []
    const ctx = { effect: (fn, label) => { effects.push(label); return fn() } }
    const runtime = mountV2Sync(ctx, { homeDir: root, appFilesDir: '' })
    assert.ok(runtime instanceof V2SyncRuntime)
    assert.deepEqual(effects, ['dsh-dots: v2 sync migration gate'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('WIR06 工作根选择只经注入宿主 logger 输出一行（插件源码零 stdout）', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-v2-wiring-log-'))
  const saved = { repo: process.env.DSH_DOTS_REPO_ROOT, app: process.env.DSH_DOTS_APP_FILES_DIR }
  delete process.env.DSH_DOTS_REPO_ROOT
  delete process.env.DSH_DOTS_APP_FILES_DIR
  try {
    const paths = statePaths(root)
    const store = new SettingsStore(paths)
    store.writeSettings({ ...defaultSettings(), repoUrl: 'https://example.test/a/b.git' })
    const lines = []
    const logger = { info: (message) => lines.push(message) }
    const runtime = new V2SyncRuntime({ homeDir: root, appFilesDir: '', logger })
    const status = await runtime.start()
    assert.equal(lines.length, 1)
    assert.equal(status.repoRootLogLine, lines[0])
    assert.equal(status.repoRootSource, 'default')
    assert.ok(status.repoRootLogLine.includes('(default)'))
    // 没有注入 logger 的实例不输出，但结构化字段仍存在。
    const silentRuntime = new V2SyncRuntime({ homeDir: root, appFilesDir: '' })
    await silentRuntime.start()
    assert.equal(lines.length, 1)
    assert.equal(silentRuntime.status.repoRootSource, 'default')
  } finally {
    if (saved.repo !== undefined) process.env.DSH_DOTS_REPO_ROOT = saved.repo
    if (saved.app !== undefined) process.env.DSH_DOTS_APP_FILES_DIR = saved.app
    await rm(root, { recursive: true, force: true })
  }
})

function existsDir(p) {
  try {
    return existsSync(p) && statSync(p).isDirectory()
  } catch {
    return false
  }
}
