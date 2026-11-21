/**
 * `mod-plugin-git-store`（写半侧）clone 路径统一 + 迁移测试。
 *
 * 用真实 git（temp bare repo + temp work dir）核对「未推提交」；不碰项目仓库本身。
 * 中文注释逐条说明钉住的契约与绑定决策 ③ 的安全底线。
 * 被测对象：dist/sync/repoPath.js（前置：node scripts/build.mjs）。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  E_LEGACY_UNPUSHED,
  E_MIGRATION_TARGET_MISMATCH,
  NodeMigrationIo,
  SHARED_REPO_DIR_NAME,
  legacyUnpushedMessage,
  legacyWorkDir,
  migrateLegacyWorkDir,
  resolveV2RepoDir,
  targetMismatchMessage,
} from '../dist/sync/repoPath.js'
import { repoHash } from '../dist/engine/paths.js'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** 建一个 temp bare 远端 + 一份已克隆并推过 main 的旧工作副本。 */
async function makeScene(extraLocalCommit = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-v2-mig-'))
  const bare = path.join(root, 'remote.git')
  const legacy = path.join(root, 'legacy')
  const target = path.join(root, 'git-repo')
  const marker = path.join(root, 'state', 'migration.json')
  execFileSync('git', ['init', '--bare', '--initial-branch=main', bare], { stdio: 'ignore' })
  execFileSync('git', ['clone', '--quiet', bare, legacy], { stdio: 'ignore' })
  git(legacy, ['config', 'user.email', 'tester@localhost'])
  git(legacy, ['config', 'user.name', 'tester'])
  await writeFile(path.join(legacy, 'README.md'), 'init\n')
  git(legacy, ['add', 'README.md'])
  git(legacy, ['commit', '--quiet', '-m', 'init'])
  git(legacy, ['push', '--quiet', 'origin', 'main'])
  git(legacy, ['fetch', '--quiet', 'origin'])
  if (extraLocalCommit) {
    await writeFile(path.join(legacy, 'LOCAL.md'), 'only-here\n')
    git(legacy, ['add', 'LOCAL.md'])
    git(legacy, ['commit', '--quiet', '-m', 'local-only'])
  }
  return { root, bare, legacy, target, marker, io: new NodeMigrationIo() }
}

// ================================================================ 路径决策

test('M01 v2 唯一 clone 路径是 App 的 git-repo/；旧 work/<repoHash> 仅供迁移检测', async () => {
  const appFiles = path.join(os.tmpdir(), 'app-files')
  assert.equal(resolveV2RepoDir({ appFilesDir: appFiles }), path.join(appFiles, SHARED_REPO_DIR_NAME))
  assert.equal(SHARED_REPO_DIR_NAME, 'git-repo')
  const overridden = resolveV2RepoDir({ appFilesDir: appFiles, overrideDir: path.join(appFiles, 'custom') })
  assert.equal(overridden, path.join(appFiles, 'custom'))
  const workRoot = path.join(os.tmpdir(), 'dots', 'work')
  const url = 'https://example.test/a/b.git'
  assert.equal(legacyWorkDir(workRoot, url), path.join(workRoot, repoHash(url)))
})

// ================================================================ 未推提交 → typed 中止

test('M02 旧副本含未推提交 → E_LEGACY_UNPUSHED，verbatim 文案含旧路径与下一步，什么都没删', async () => {
  const s = await makeScene(true)
  try {
    const beforeHead = git(s.legacy, ['rev-parse', 'HEAD'])
    await assert.rejects(
      async () => await migrateLegacyWorkDir({ legacyDir: s.legacy, targetDir: s.target, markerPath: s.marker, io: s.io }),
      (error) => {
        assert.equal(error.code, E_LEGACY_UNPUSHED)
        assert.equal(error.details.unpushed, 1)
        assert.ok(error.message.includes(s.legacy))
        assert.ok(error.message.includes('git push origin main'))
        assert.ok(error.message.includes('未删除、未移动任何文件'))
        return true
      },
    )
    assert.equal(existsSync(s.legacy), true)
    assert.equal(existsSync(s.target), false)
    assert.equal(existsSync(s.marker), false)
    assert.equal(git(s.legacy, ['rev-parse', 'HEAD']), beforeHead)
    assert.equal(readFileSync(path.join(s.legacy, 'LOCAL.md'), 'utf8'), 'only-here\n')
    // verbatim 文案函数本身可独立核对。
    assert.equal(
      legacyUnpushedMessage(s.legacy, s.target, 1),
      `${E_LEGACY_UNPUSHED}: 旧工作副本 ${s.legacy} 含 1 条尚未推送到远端的本地提交，迁移已中止：未删除、未移动任何文件。下一步：请在该目录手动执行 git push origin main 把所有提交推到远端，确认推送成功后重新运行迁移；本模块绝不丢弃本地提交。目标工作副本：${s.target}`,
    )
  } finally {
    await rm(s.root, { recursive: true, force: true })
  }
})

test('M03 若无 origin/main 引用但有本地提交 → 保守视为未推，同样中止（_UNKNOWN 不视为 0）', async () => {
  const s = await makeScene(false)
  try {
    execFileSync('git', ['update-ref', '-d', 'refs/remotes/origin/main'], { cwd: s.legacy, stdio: 'ignore' })
    await assert.rejects(
      async () => await migrateLegacyWorkDir({ legacyDir: s.legacy, targetDir: s.target, markerPath: s.marker, io: s.io }),
      (error) => error.code === E_LEGACY_UNPUSHED,
    )
    assert.equal(existsSync(s.legacy), true)
  } finally {
    await rm(s.root, { recursive: true, force: true })
  }
})

// ================================================================ 干净 → 幂等迁移

test('M04 干净旧副本 → 移动到共享 clone 并写标记；第二次运行幂等 no-op', async () => {
  const s = await makeScene(false)
  try {
    const first = await migrateLegacyWorkDir({ legacyDir: s.legacy, targetDir: s.target, markerPath: s.marker, io: s.io })
    assert.equal(first.ok, true)
    assert.equal(first.action, 'moved')
    assert.equal(first.unpushed, 0)
    assert.equal(existsSync(s.legacy), false)
    assert.equal(existsSync(path.join(s.target, '.git')), true)
    const markerBefore = await readFile(s.marker, 'utf8')
    assert.equal(path.resolve(JSON.parse(markerBefore).target), path.resolve(s.target))
    const headBefore = git(s.target, ['rev-parse', 'HEAD'])
    const second = await migrateLegacyWorkDir({ legacyDir: s.legacy, targetDir: s.target, markerPath: s.marker, io: s.io })
    assert.equal(second.action, 'none')
    assert.equal(await readFile(s.marker, 'utf8'), markerBefore)
    assert.equal(git(s.target, ['rev-parse', 'HEAD']), headBefore)
  } finally {
    await rm(s.root, { recursive: true, force: true })
  }
})

test('M05 目标已存在且属于同一远端 → 只重指向、不删除；第二次运行不改任何字节', async () => {
  const s = await makeScene(false)
  try {
    // M5：目标必须是同一远端的有效工作副本，空目录现在会被拒绝（见 M07）。
    execFileSync('git', ['clone', '--quiet', s.bare, s.target], { stdio: 'ignore' })
    const first = await migrateLegacyWorkDir({ legacyDir: s.legacy, targetDir: s.target, markerPath: s.marker, io: s.io })
    assert.equal(first.action, 'repointed')
    assert.equal(existsSync(s.legacy), true) // 重指向不删旧目录，交由运维处理
    const markerBefore = await readFile(s.marker, 'utf8')
    const second = await migrateLegacyWorkDir({ legacyDir: s.legacy, targetDir: s.target, markerPath: s.marker, io: s.io })
    assert.equal(second.action, 'none')
    assert.equal(await readFile(s.marker, 'utf8'), markerBefore)
    assert.equal(existsSync(s.legacy), true)
  } finally {
    await rm(s.root, { recursive: true, force: true })
  }
})

test('M06 迁移 IO 只接受只读 git 子命令（写命令在端口层被拒）', async () => {
  const io = new NodeMigrationIo()
  await assert.rejects(
    async () => await io.gitRead(process.cwd(), ['push', 'origin', 'main']),
    (error) => error.code === 'E_VALIDATION' && error.message.includes('只读 git 命令'),
  )
  // config --get 是只读例外；config --unset（写）必须被拒。
  await assert.rejects(
    async () => await io.gitRead(process.cwd(), ['config', '--unset', 'remote.origin.url']),
    (error) => error.code === 'E_VALIDATION',
  )
})

test('M07 M5 目标 clone 属于别的远端 → typed 中止，标记未写、目录未动', async () => {
  const s = await makeScene(false)
  try {
    const otherBare = path.join(s.root, 'other.git')
    execFileSync('git', ['init', '--bare', '--initial-branch=main', otherBare], { stdio: 'ignore' })
    const otherWork = path.join(s.root, 'other-work')
    execFileSync('git', ['clone', '--quiet', otherBare, otherWork], { stdio: 'ignore' })
    execFileSync('git', ['clone', '--quiet', otherBare, s.target], { stdio: 'ignore' })
    await assert.rejects(
      async () => await migrateLegacyWorkDir({ legacyDir: s.legacy, targetDir: s.target, markerPath: s.marker, io: s.io }),
      (error) => {
        assert.equal(error.code, E_MIGRATION_TARGET_MISMATCH)
        assert.ok(error.message.includes(s.target))
        assert.ok(error.message.includes('下一步'))
        return true
      },
    )
    assert.equal(existsSync(s.marker), false)
    assert.equal(existsSync(s.legacy), true)
    assert.equal(existsSync(s.target), true)
    // verbatim 文案可独立核对（两个 URL 都在里面）。
    const message = targetMismatchMessage(s.legacy, s.target, s.bare, otherBare)
    assert.ok(message.includes(s.bare) && message.includes(otherBare))
  } finally {
    await rm(s.root, { recursive: true, force: true })
  }
})

test('M08 m3 HEAD 不可解析但 .git 存在 → fail-closed 中止，不把损坏仓库当干净', async () => {
  const s = await makeScene(false)
  try {
    // 用无效 HEAD 让 rev-parse 失败（gitRead 返回 ''），.git 目录仍在。
    await writeFile(path.join(s.legacy, '.git', 'HEAD'), 'ref: refs/heads/does-not-exist\n')
    await assert.rejects(
      async () => await migrateLegacyWorkDir({ legacyDir: s.legacy, targetDir: s.target, markerPath: s.marker, io: s.io }),
      (error) => error.code === E_LEGACY_UNPUSHED,
    )
    assert.equal(existsSync(s.marker), false)
    assert.equal(existsSync(s.target), false)
  } finally {
    await rm(s.root, { recursive: true, force: true })
  }
})
