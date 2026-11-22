/**
 * mod-plugin-git-username —— 引擎侧纯函数 + 接线 + 卫生守卫。
 *
 * G01: 浏览器只读派生与 engine 推断逐条对拍（两个运行时不能漂移；引擎是唯一事实源）。
 * G02: URL 推断 / 显式覆盖 / 环境变量覆盖 / Gitee 推不出才报错。
 * G03: GitHub 行为不变（留空 x-access-token，显式值照旧透传，绝不发 owner）。
 * G04: 卫生——登录名与令牌都不进配对载荷序列化、不进日志/错误文本。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const {
  GITHUB_TOKEN_USERNAME,
  GITEE_USERNAME_REQUIRED,
  inferGitUsername,
  resolveGitUsername,
  scrubAuthValue,
} = await import(pathToFileURL(path.join(pkgDir, 'dist', 'engine', 'gitUsername.js')).href)
const { GitRepo, resolveAskpassUser } = await import(pathToFileURL(path.join(pkgDir, 'dist', 'engine', 'git.js')).href)
const { buildPairingPayload, serialisePairingPayload, describePairing } =
  await import(pathToFileURL(path.join(pkgDir, 'dist', 'remote', 'pairingPayload.js')).href)

async function tempDir(t, prefix) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix))
  t.after(async () => { await rm(dir, { recursive: true, force: true }).catch(() => {}) })
  return dir
}

/** 从交付后的 dist/client.js 取纯展示推断（不渲染，stub 只需 createElement）。 */
let panelPromise = null
async function loadPanel() {
  if (!panelPromise) {
    panelPromise = (async () => {
      let captured = null
      globalThis.window = { __ModuleLoader__: { load(cfg) { captured = cfg } } }
      await import(pathToFileURL(path.join(pkgDir, 'dist', 'client.js')).href + '?git-username-g01=' + Date.now())
      assert.ok(captured, 'client.js 必须注册 loader')
      const mod = captured.factory((id) => {
        if (id === 'react') return { Fragment: Symbol('Fragment'), createElement() {} }
        throw new Error(`unexpected require: ${id}`)
      })
      let Panel = null
      mod.apply({
        effect(fn) { fn() },
        locale: { register() { return function () {} }, bind() { return (key) => key } },
        slots: {
          inject(_name, cb) { cb(); return function () {} },
          register(_options, component) { Panel = component; return function () {} },
        },
      })
      assert.ok(typeof Panel?.leanInferLogin === 'function', 'client 必须暴露 leanInferLogin 供对拍')
      return Panel
    })()
  }
  return panelPromise
}

const OWNER = 'gitee-login-name'
const TOKEN = 'gitee_private_token_0123456789abcdef'
const FP = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99'

test('G01：浏览器只读派生与 engine::inferGitUsername 逐条一致（Gitee owner 推断单源）', async () => {
  const panel = await loadPanel()
  const cases = [
    ['https://gitee.com/owner/repo.git', 'owner'],
    ['https://gitee.com/my-org/private-repo.git', 'my-org'],
    ['https://gitee.com/owner/repo', 'owner'],
    ['https://gitee.com/owner/repo.git/', 'owner'],
    ['https://gitee.com/owner/repo.git?x=1#y', 'owner'],
    ['https://gitee.com/Team_1/repo.git', 'Team_1'],
    ['git@gitee.com:owner/repo.git', 'owner'],
    ['ssh://git@gitee.com/owner/repo.git', 'owner'],
    ['gitee.com/owner/repo.git', 'owner'],
    ['https://gitee.com/', ''],
    ['https://gitee.com/only-one-segment', ''],
    ['https://github.com/octocat/hello.git', ''],
    ['https://gitlab.com/owner/repo.git', ''],
    ['', ''],
  ]
  for (const [url, expected] of cases) {
    assert.equal(inferGitUsername(url), expected, `engine 推断 ${url}`)
    assert.equal(panel.leanInferLogin(url), expected, `client 展示推断 ${url}`)
  }
})

test('G02：显式值优先 > 地址推断 > 报错；DSH_DOTS_GIT_USERNAME 作为环境变量覆盖', async (t) => {
  const url = 'https://gitee.com/owner/repo.git'
  assert.equal(resolveGitUsername('gitee', 'alice', url), 'alice')
  assert.equal(resolveGitUsername('gitee', '   alice   ', url), 'alice')
  assert.equal(resolveGitUsername('gitee', '', url), 'owner')
  assert.equal(resolveGitUsername('gitee', null, url), 'owner')
  assert.equal(resolveGitUsername('gitee', '', 'https://gitee.com/'), '')
  assert.throws(
    () => resolveAskpassUser('gitee', '', 'https://gitee.com/'),
    (error) => error.code === 'E_VALIDATION' && error.message === GITEE_USERNAME_REQUIRED
  )

  const dir = await tempDir(t, 'gcs-username-env-')
  const envRepo = new GitRepo({
    dir, repoUrl: url, branch: 'main', authMode: 'https', platform: 'gitee',
    username: '', token: TOKEN, env: { DSH_DOTS_GIT_USERNAME: 'env-login' },
  })
  assert.equal(envRepo.username, 'env-login', '环境变量覆盖必须进入 askpass 用户名')
  const explicitRepo = new GitRepo({
    dir, repoUrl: url, branch: 'main', authMode: 'https', platform: 'gitee',
    username: 'alice', token: TOKEN, env: { DSH_DOTS_GIT_USERNAME: 'env-login' },
  })
  assert.equal(explicitRepo.username, 'alice', '手填值优先于环境变量')
  await envRepo.dispose()
  await explicitRepo.dispose()
})

test('G03：GitHub 行为不变——留空 x-access-token、显式值照旧透传、绝不发送 URL owner', () => {
  assert.equal(GITHUB_TOKEN_USERNAME, 'x-access-token')
  const ghUrl = 'https://github.com/octocat/hello.git'
  assert.equal(resolveGitUsername('github', '', ghUrl), 'x-access-token')
  assert.equal(resolveGitUsername('github', 'octocat', ghUrl), 'octocat')
  assert.equal(resolveGitUsername('custom', '', ghUrl), 'x-access-token')
  assert.equal(resolveAskpassUser('github', '', ghUrl), 'x-access-token')
  assert.equal(resolveAskpassUser('github', 'octocat', ghUrl), 'octocat')
  // Gitee 之前留空会直接报 E_VALIDATION；现在按地址推断出 owner，不再拦。
  assert.equal(resolveAskpassUser('gitee', '', 'https://gitee.com/owner/repo.git'), 'owner')
})

test('G04：卫生——登录名/令牌都不进配对载荷序列化，也不进日志或错误文本', () => {
  const current = {
    instanceId: 'gwl-pc', transport: 'lan', host: '192.168.1.6', port: 44996,
    token: TOKEN, tlsFingerprint: FP, announceRef: '',
  }
  // 即便上游对象里混进 gitUsername，规范载荷也只取 PAIRING_KEYS。
  const withLogin = Object.assign({}, current, { gitUsername: OWNER })
  const built = buildPairingPayload(withLogin)
  const serialised = serialisePairingPayload(built)
  const described = describePairing(withLogin)
  for (const text of [JSON.stringify(built), serialised, JSON.stringify(described)]) {
    assert.equal(text.includes(OWNER), false, '配对载荷/视图不得含登录名')
  }
  assert.equal(serialised.includes(TOKEN), true, '配对串里的 token 是 bearer secret（只在此出口）')
  assert.equal(JSON.stringify(described).includes(TOKEN), false, '脱敏视图不得含 token')

  const dirtyLog = `git ls-remote failed for user=${OWNER} token=${TOKEN} (401)`
  const clean = scrubAuthValue(scrubAuthValue(dirtyLog, TOKEN), OWNER)
  assert.equal(clean.includes(OWNER), false, '日志/错误文本不得含登录名')
  assert.equal(clean.includes(TOKEN), false, '日志/错误文本不得含令牌')
  assert.equal(clean.includes('401'), true, '打码不得吞掉可诊断的状态码')
})
