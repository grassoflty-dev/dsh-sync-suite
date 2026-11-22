/**
 * `mod-plugin-repo-root`：PC 自持 clone 工作根解析 + 迁移门禁验收。
 *
 * 前置：`cd packages/dsh-dots; node scripts/build.mjs`。
 * 被测对象：dist/sync/{repoRoot,repoPath,bootstrap}.js、dist/schedule/v2Bridge.js。
 * 中文注释钉住契约：env 优先级、默认根布局、typed 错误、迁移零二义性与零移动。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  E_REPO_ROOT_UNAVAILABLE,
  ENV_APP_FILES_DIR,
  ENV_REPO_ROOT,
  SHARED_REPO_DIR_NAME,
  ensureRepoRoot,
  repoRootUnavailableMessage,
  resolveV2RepoRoot,
} from '../dist/sync/repoRoot.js'
import {
  E_LEGACY_UNPUSHED,
  legacyWorkDir,
  migrateIfNeeded,
  resolveV2RepoDir,
  resolveV2RepoDirDetailed,
} from '../dist/sync/repoPath.js'
import { repoHash, statePaths } from '../dist/engine/paths.js'
import { buildV2Ports, withV2ScheduleBridge } from '../dist/schedule/v2Bridge.js'
import {
  GIT_SUBCOMMANDS,
  GitRepoV2Port,
  assertSafeGitArgs,
  buildSafePushArgs,
} from '../dist/sync/gitPort.js'
import { SettingsStore, defaultSettings } from '../dist/engine/settings.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = (rel) => readFile(path.resolve(here, `../${rel}`), 'utf8')
const REPO_URL = 'https://example.test/a/b.git'

/** 记录所有 IO 的假端口：move / backup 次数是「零移动」证明的核心证据。 */
class RecordingIo {
  constructor({ existing = [], files = {}, git = {} } = {}) {
    this.existing = new Set(existing.map((p) => path.resolve(p)))
    this.files = new Map(Object.entries(files))
    this.git = git
    this.calls = { exists: [], backup: [], move: [], readMarker: [], writeMarker: [], gitRead: [] }
  }
  async exists(p) { this.calls.exists.push(p); return this.existing.has(path.resolve(p)) }
  async backup(from, to) { this.calls.backup.push([from, to]); this.existing.add(path.resolve(to)) }
  async move(from, to) {
    this.calls.move.push([from, to])
    this.existing.delete(path.resolve(from))
    this.existing.add(path.resolve(to))
  }
  async readMarker(p) { this.calls.readMarker.push(p); return this.files.get(p) ?? null }
  async writeMarker(p, text) { this.calls.writeMarker.push([p, text]); this.files.set(p, text) }
  async gitRead(_dir, args) {
    this.calls.gitRead.push(args.slice())
    return this.git[args.join(' ')] ?? ''
  }
}

// ================================================================ 根解析优先级

test('R01 DSH_DOTS_REPO_ROOT 胜出；已废弃别名仍可用；一行经注入 logger，内容点名原因', () => {
  const env = { [ENV_REPO_ROOT]: 'C:\\override\\work-root', [ENV_APP_FILES_DIR]: 'C:\\legacy\\app-files' }
  const opts = { homeDir: 'C:\\home', repoUrl: REPO_URL, env }
  const winner = resolveV2RepoRoot(opts)
  assert.equal(winner.sharedRepoRoot, path.resolve('C:\\override\\work-root'))
  assert.equal(winner.source, 'env override: DSH_DOTS_REPO_ROOT')
  assert.equal(winner.logLine.includes('env override: DSH_DOTS_REPO_ROOT'), true)

  const alias = resolveV2RepoRoot({ ...opts, env: { [ENV_APP_FILES_DIR]: 'C:\\legacy\\app-files' } })
  assert.equal(alias.sharedRepoRoot, path.resolve('C:\\legacy\\app-files'))
  assert.equal(alias.source, 'deprecated alias: DSH_DOTS_APP_FILES_DIR')

  const fallback = resolveV2RepoRoot({ ...opts, env: {} })
  assert.equal(fallback.source, 'default')

  // 唯一日志出口 = 注入的宿主 logger；恰好一行，文本与结构化 logLine 一致。
  const lines = []
  const logger = { info: (message) => lines.push(message) }
  const logged = resolveV2RepoRoot({ ...opts, env: {}, logger })
  assert.equal(lines.length, 1)
  assert.equal(lines[0], logged.logLine)
  assert.equal(logged.logLine.includes('(default)'), true)
  // 没注入 logger 时零输出，但 logLine 仍在返回值里（不是靠静音开关绕守卫）。
  const quiet = resolveV2RepoRoot({ ...opts, env: {} })
  assert.equal(lines.length, 1)
  assert.equal(quiet.logLine.includes('(default)'), true)
})

test('R02 默认根布局 = ~/.dsh/dots/repos/<repoHash>/git-repo；哈希与 legacy work 同一个函数', () => {
  const home = 'C:\\home'
  const hash = repoHash(REPO_URL)
  const res = resolveV2RepoRoot({ homeDir: home, repoUrl: REPO_URL, env: {} })
  const expectedRoot = path.join(home, '.dsh', 'dots', 'repos', hash)
  assert.equal(res.sharedRepoRoot, expectedRoot)
  assert.equal(res.repoDir, path.join(expectedRoot, SHARED_REPO_DIR_NAME))
  assert.equal(SHARED_REPO_DIR_NAME, 'git-repo')
  assert.equal(res.repoHash, hash)
  // 绝不与 legacy work/<repoHash> 重合；两者是兄弟目录。
  assert.equal(path.dirname(res.sharedRepoRoot), path.join(home, '.dsh', 'dots', 'repos'))
  const legacy = legacyWorkDir(statePaths(home).workRoot, REPO_URL)
  assert.equal(legacy, path.join(home, '.dsh', 'dots', 'work', hash))
  assert.notEqual(res.sharedRepoRoot, path.dirname(legacy))
  // resolveV2RepoDir 仍是单一目录决策点（兼容签名）。
  assert.equal(resolveV2RepoDir({ homeDir: home, repoUrl: REPO_URL, env: {} }), res.repoDir)
  assert.equal(
    resolveV2RepoDirDetailed({ overrideDir: 'C:\\explicit\\repo', env: {} }).repoDir,
    path.resolve('C:\\explicit\\repo'),
  )
})

test('R03 根可写性：创建 + 探针幂等；不可写 -> E_REPO_ROOT_UNAVAILABLE（路径 + 下一步）', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'dsh-repo-root-'))
  try {
    const root = path.join(tmp, 'repos', repoHash(REPO_URL))
    ensureRepoRoot(root)
    ensureRepoRoot(root) // 幂等
    assert.equal(existsSync(path.join(root, '.repo-root-probe')), true)

    const blocked = path.join(tmp, 'blocked')
    await writeFile(blocked, 'not a directory', 'utf8')
    assert.throws(
      () => ensureRepoRoot(path.join(blocked, 'sub')),
      (error) => {
        assert.equal(error.code, E_REPO_ROOT_UNAVAILABLE)
        assert.ok(error.message.includes(path.join(blocked, 'sub')))
        assert.ok(error.message.includes('下一步'))
        assert.ok(error.message.includes(ENV_REPO_ROOT))
        return true
      },
    )
    assert.ok(repoRootUnavailableMessage('/x', 'EACCES').includes('/x'))
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})

// ================================================================ 迁移门禁（零二义 / 零移动）

function migrationPaths(home, targetRoot) {
  const hash = repoHash(REPO_URL)
  return {
    legacyDir: path.join(home, '.dsh', 'dots', 'work', hash),
    newRoot: targetRoot ?? path.join(home, '.dsh', 'dots', 'repos', hash),
    targetDir: path.join(targetRoot ?? path.join(home, '.dsh', 'dots', 'repos', hash), 'git-repo'),
    markerPath: path.join(home, '.dsh', 'dots', 'v2-migration.json'),
  }
}

test('R04 全新默认根 → 迁移门禁零移动（记录 IO 的 move / backup / writeMarker 全为 0）', async () => {
  const home = 'C:\\home-fresh'
  const p = migrationPaths(home)
  // 旧 work 不存在、新 repos 根也不存在：这是绝大多数用户的首跑。
  const io = new RecordingIo({ existing: [] })
  const result = await migrateIfNeeded({ ...p, io })
  assert.equal(result.action, 'none')
  assert.equal(result.ok, true)
  assert.deepEqual(io.calls.move, [], '零移动')
  assert.deepEqual(io.calls.backup, [], '零备份（没有东西可搬）')
  assert.deepEqual(io.calls.writeMarker, [], '零标记写入')
})

test('R05 门禁只在 legacy 在且新根不在时触发：备份先于移动，第二次运行幂等', async () => {
  const home = 'C:\\home-legacy'
  const p = migrationPaths(home)
  const io = new RecordingIo({ existing: [p.legacyDir] }) // 新 repos 根不存在
  const first = await migrateIfNeeded({ ...p, io })
  assert.equal(first.action, 'moved')
  assert.equal(io.calls.move.length, 1)
  assert.equal(io.calls.backup.length, 1)
  assert.ok(io.calls.backup[0][0] === p.legacyDir)
  const markerBefore = io.files.get(p.markerPath)
  assert.ok(typeof markerBefore === 'string')

  // 第二次：旧目录已被移走 → no-op，不再备份/移动/改标记。
  const second = await migrateIfNeeded({ ...p, io })
  assert.equal(second.action, 'none')
  assert.equal(io.calls.move.length, 1)
  assert.equal(io.calls.backup.length, 1)
  assert.equal(io.files.get(p.markerPath), markerBefore)
})

test('R06 新根已存在则绝不搬旧目录（两副本都合法，运维自行合并）', async () => {
  const home = 'C:\\home-both'
  const p = migrationPaths(home)
  const io = new RecordingIo({ existing: [p.legacyDir, p.newRoot] })
  const result = await migrateIfNeeded({ ...p, io })
  assert.equal(result.action, 'none')
  assert.deepEqual(io.calls.move, [])
  assert.deepEqual(io.calls.backup, [])
  assert.equal(io.existing.has(path.resolve(p.legacyDir)), true, '旧目录原样留在原地')
  assert.equal(io.existing.has(path.resolve(p.newRoot)), true, '新根原样留在原地')
})

test('R07 未推提交 → E_LEGACY_UNPUSHED，备份/移动/标记一个都没发生', async () => {
  const home = 'C:\\home-unpushed'
  const p = migrationPaths(home)
  const io = new RecordingIo({
    existing: [p.legacyDir],
    git: {
      'rev-parse --verify --quiet refs/remotes/origin/main': 'sha-origin',
      'rev-parse --verify --quiet HEAD': 'sha-head',
      'rev-list --count sha-origin..HEAD': '2',
    },
  })
  await assert.rejects(
    async () => await migrateIfNeeded({ ...p, io }),
    (error) => {
      assert.equal(error.code, E_LEGACY_UNPUSHED)
      assert.equal(error.details.unpushed, 2)
      assert.ok(error.message.includes('未删除、未移动任何文件'))
      return true
    },
  )
  assert.deepEqual(io.calls.move, [])
  assert.deepEqual(io.calls.backup, [])
  assert.deepEqual(io.calls.writeMarker, [])
})

// ================================================================ 旧错码消失 + 装配接线

test('R08 E_NO_APP_FILES_DIR 从源码与 dist 中消失；装配点使用默认根', async () => {
  const files = [
    'src/sync/repoRoot.ts', 'src/sync/repoPath.ts', 'src/sync/bootstrap.ts', 'src/schedule/v2Bridge.ts',
    'dist/sync/repoRoot.js', 'dist/sync/repoPath.js', 'dist/sync/bootstrap.js', 'dist/schedule/v2Bridge.js',
  ]
  for (const rel of files) {
    const text = await src(rel)
    assert.equal(text.includes('E_NO_APP_FILES_DIR'), false, `${rel} 仍残留旧错码`)
  }
  // buildV2Ports 不注入 appFilesDir/repoDir 时解析到默认根，且不再抛旧错码。
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'dsh-repo-root-assembly-'))
  try {
    const paths = statePaths(tmp)
    const built = buildV2Ports({
      paths,
      settings: { ...defaultSettings(), repoUrl: REPO_URL, deviceId: 'pc-a' },
      token: null,
      env: { [ENV_REPO_ROOT]: '', [ENV_APP_FILES_DIR]: '' },
    })
    const expected = path.join(tmp, '.dsh', 'dots', 'repos', repoHash(REPO_URL), 'git-repo')
    assert.equal(built.repoDir, expected)
    assert.equal(built.sharedRepoRoot, path.dirname(expected))
    assert.equal(existsSync(path.join(built.sharedRepoRoot, '.repo-root-probe')), true)
    await built.dispose()
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})

// ================================================================ 首次使用端到端（本地 bare 远端）

test('R09 首次 schedule_add：默认根缺失 → clone → 写 schema/records → commit → push（空远端与已有 main 都可）', async () => {
  for (const seedMain of [false, true]) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-repo-root-e2e-'))
    try {
      const home = path.join(root, 'home')
      const remote = path.join(root, 'remote.git')
      const url = remote
      execFileSync('git', ['init', '--bare', '--initial-branch=main', remote], { stdio: 'ignore' })
      if (seedMain) {
        const seed = path.join(root, 'seed')
        execFileSync('git', ['clone', '--quiet', remote, seed], { stdio: 'ignore' })
        execFileSync('git', ['config', 'user.email', 'seed@localhost'], { cwd: seed, stdio: 'ignore' })
        execFileSync('git', ['config', 'user.name', 'seed'], { cwd: seed, stdio: 'ignore' })
        await mkdir(path.join(seed, 'timeline', '2026-11-19'), { recursive: true })
        await writeFile(path.join(seed, 'timeline', 'schema.json'), '{"schemaVersion":2}\n')
        await writeFile(path.join(seed, 'timeline', '2026-11-19', 'records.json'),
          '{\n  "date": "2026-11-19",\n  "open": ["seed-1"],\n  "records": [\n  {"id":"seed-1","ts":"2026-11-19T08:00:00+08:00","title":"平板已有","body":"","author":"平板","done":false,"media":[],"ai_processed":false,"opened_at":"2026-11-19T08:00:00+08:00"}\n  ]\n}\n')
        execFileSync('git', ['add', '-A'], { cwd: seed, stdio: 'ignore' })
        execFileSync('git', ['commit', '--quiet', '-m', 'seed main'], { cwd: seed, stdio: 'ignore' })
        execFileSync('git', ['push', '--quiet', 'origin', 'main'], { cwd: seed, stdio: 'ignore' })
      }
      const paths = statePaths(home)
      const store = new SettingsStore(paths, { allowLocalRepo: true })
      store.writeSettings({ ...defaultSettings(), repoUrl: url, deviceId: 'pc-a' })
      const repoDir = path.join(home, '.dsh', 'dots', 'repos', repoHash(url), 'git-repo')
      assert.equal(existsSync(repoDir), false, '首跑前默认根不存在')
      const added = await withV2ScheduleBridge(
        {
          paths, settings: store.readSettings(), token: null, allowLocalRepo: true,
          env: { [ENV_REPO_ROOT]: '', [ENV_APP_FILES_DIR]: '' },
          now: () => new Date('2026-11-19T21:00:00+08:00'),
        },
        async (bridge) => await bridge.add(bridge.deviceId, '2026-11-19', { title: 'PC 首条' }),
      )
      assert.equal(existsSync(path.join(repoDir, '.git')), true, '默认根已 clone')
      assert.equal(added.pushed, true)
      assert.ok(added.commit !== '')
      assert.ok(added.files.includes('timeline/2026-11-19/records.json'))
      if (!seedMain) assert.ok(added.files.includes('timeline/schema.json'), '空远端首跑建 schema')
      const remoteMain = execFileSync('git', ['rev-parse', '--verify', 'main'], { cwd: remote, encoding: 'utf8' }).trim()
      assert.equal(remoteMain.startsWith(added.commit.slice(0, 12)), true, '远端 main 已前进到本次提交')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

// ================================================================ 权威保证：argv 构造器 + allowlist

test('R10 push argv 是构造器产出的固定值；真实路径 argv 捕获 + 九种 hostile 拼写全在构造器被拒', async () => {
  const safe = ['push', '--porcelain', 'origin', 'HEAD:main']
  const ok = { remote: 'origin', branch: 'main', force: false }
  assert.deepEqual(buildSafePushArgs(ok), safe)

  // 真实代码路径 pushMain → buildSafePushArgs → assertSafeGitArgs → runner（假执行器只收 argv）。
  const captured = []
  const port = new GitRepoV2Port({
    dir: path.join(os.tmpdir(), 'dsh-argv-capture'),
    repoUrl: 'https://example.test/a/b.git', branch: 'main', authMode: 'https',
    runner: async (_cwd, argv) => { captured.push(argv.slice()); return { code: 0, stdout: '', stderr: '' } },
  })
  await port.pushMain(ok)
  assert.equal(captured.length, 1)
  assert.deepEqual(captured[0], safe, '真实 push 的 argv 逐项等于固定安全值')

  const hostile = [
    ['-f'], ['--force'], ['--force-with-lease'], ['--force-if-includes'],
    ['+main'], ['+refs/heads/*'], ['--delete'],
    ['-c', 'push.force=true'], ['--config', 'push.force=true'],
  ]
  for (const extra of hostile) {
    assert.throws(
      () => buildSafePushArgs(ok, extra),
      (error) => error.code === 'E_VALIDATION',
      `构造器未拒绝：${extra.join(' ')}`,
    )
  }
  assert.throws(() => buildSafePushArgs({ ...ok, force: true }), (error) => error.code === 'E_VALIDATION')
  assert.deepEqual(captured[0], safe, 'hostile 输入没有污染任何真实 argv')
})

test('R11 git 子命令 allowlist 的运行时证明：改写/删引用全拒，只读与写集合放行', () => {
  const denied = [
    ['reset', '--hard'], ['rebase'], ['pull'], ['merge'],
    ['fetch', '--prune', '--force'], ['branch', '-D'], ['update-ref', 'refs/heads/main', 'x'],
  ]
  for (const argv of denied) {
    assert.throws(
      () => assertSafeGitArgs(argv),
      (error) => error.code === 'E_VALIDATION',
      `allowlist 未拒绝：${argv.join(' ')}`,
    )
  }
  const allowed = [
    ['status'], ['add', '--', 'timeline/a'], ['commit', '-m', 'x'],
    ['push', '--porcelain', 'origin', 'HEAD:main'],
  ]
  for (const argv of allowed) assert.doesNotThrow(() => assertSafeGitArgs(argv))
  assert.equal(GIT_SUBCOMMANDS.has('reset'), false)
  assert.equal(GIT_SUBCOMMANDS.has('pull'), false)
})
