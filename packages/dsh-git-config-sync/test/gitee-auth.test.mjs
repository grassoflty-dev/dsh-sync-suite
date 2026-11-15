/**
 * Gitee HTTPS 认证回归：用户名 + 私人令牌（令牌只作密码）。
 *
 * 旧实现把 askpass 用户名写死为 `x-access-token`（GitHub PAT 约定），Gitee 会
 * 直接 403；这里固化三条规则 + settings.json 存储边界。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { GitRepo, resolveAskpassUser } from '../dist/engine/git.js'
import {
  defaultSettings,
  inferPlatform,
  normalizeSettings,
  SettingsStore,
} from '../dist/engine/settings.js'
import { statePaths } from '../dist/engine/paths.js'

async function tempDir(t, prefix) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  })
  return dir
}

test('resolveAskpassUser：Gitee 留空 → 可读 E_VALIDATION，不能静默用 x-access-token', () => {
  assert.throws(
    () => resolveAskpassUser('gitee', ''),
    (error) => {
      assert.equal(error.code, 'E_VALIDATION')
      assert.match(error.message, /Gitee 需要填写用户名/)
      assert.match(error.message, /私人令牌只作密码/)
      return true
    }
  )
  assert.throws(() => resolveAskpassUser('gitee', '   '), /Gitee 需要填写用户名/)
})

test('resolveAskpassUser：Gitee 用户名 / GitHub 留空 / 自定义留空', () => {
  assert.equal(resolveAskpassUser('gitee', '  alice  '), 'alice')
  assert.equal(resolveAskpassUser('github', ''), 'x-access-token')
  assert.equal(resolveAskpassUser('github', 'octocat'), 'octocat')
  assert.equal(resolveAskpassUser('custom', ''), 'x-access-token')
})

test('GitRepo：Gitee + https + 空用户名时任何 git 命令都先报可读错误（buildEnv 门禁）', async (t) => {
  const dir = await tempDir(t, 'gcs-gitee-')
  const repo = new GitRepo({
    dir,
    repoUrl: 'https://gitee.com/owner/repo.git',
    branch: 'main',
    authMode: 'https',
    platform: 'gitee',
    username: '',
    token: 'private-token',
  })
  await assert.rejects(
    () => repo.status(),
    (error) => {
      assert.equal(error.code, 'E_VALIDATION')
      assert.match(error.message, /Gitee 需要填写用户名/)
      return true
    }
  )
  await repo.dispose()
})

test('GitRepo：Gitee 填了用户名可进入 git 子进程（不再因用户名被拦）', async (t) => {
  const dir = await tempDir(t, 'gcs-gitee-ok-')
  const repo = new GitRepo({
    dir,
    repoUrl: 'https://gitee.com/owner/repo.git',
    branch: 'main',
    authMode: 'https',
    platform: 'gitee',
    username: 'alice',
    token: 'private-token',
  })
  // 目录不是 git 仓库：git 会以非 0 退出，但 status() 使用 allowFailure，不应抛用户名校验错误。
  const status = await repo.status()
  assert.equal(status.branch, 'main')
  await repo.dispose()
})

test('settings：username 默认空、写入时 trim、只存 settings.json', async (t) => {
  assert.equal(defaultSettings().username, '')

  const home = await tempDir(t, 'gcs-settings-')
  const paths = statePaths(home)
  const store = new SettingsStore(paths)
  const next = normalizeSettings(
    {
      repoUrl: 'https://gitee.com/owner/repo.git',
      platform: 'github',
      authMode: 'https',
      username: '  alice  ',
      deviceId: 'pc-a',
      branch: 'main',
      scope: { config: true, providers: true, plugins: true, mcp: true },
    },
    defaultSettings()
  )
  assert.equal(next.username, 'alice')
  // Gitee 地址 + 默认 github → 自动纠正为 gitee
  assert.equal(next.platform, 'gitee')

  store.writeSettings(next)
  store.writeToken('private-token')

  const settingsText = await readFile(paths.settingsFile, 'utf8')
  const credentialsText = await readFile(paths.credentialsFile, 'utf8')
  const settings = JSON.parse(settingsText)
  const credentials = JSON.parse(credentialsText)

  assert.equal(settings.username, 'alice')
  assert.equal(settings.platform, 'gitee')
  assert.ok(!settingsText.includes('private-token'), 'settings.json 不能出现 token 明文')
  assert.deepEqual(credentials, { token: 'private-token' })
  assert.ok(!credentialsText.includes('alice'), 'credentials.json 不能出现用户名')
})

test('inferPlatform：只会纠正默认 github，不覆盖用户明确选择', () => {
  assert.equal(inferPlatform('https://gitee.com/a/b.git', 'github'), 'gitee')
  assert.equal(inferPlatform('https://gitlab.com/a/b.git', 'github'), 'custom')
  assert.equal(inferPlatform('https://github.com/a/b.git', 'github'), 'github')
  assert.equal(inferPlatform('https://gitee.com/a/b.git', 'custom'), 'custom')
  assert.equal(inferPlatform('https://gitee.com/a/b.git', 'gitee'), 'gitee')
})
