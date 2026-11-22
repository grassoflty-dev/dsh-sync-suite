/**
 * mod-plugin-repo-precheck 验收（Node，全部离线；token 是假字面量，绝不打印）。
 *
 * 覆盖：保存前门禁（成功私有才落盘 / 6 个 typed 码 / 字节级不写 settings / 不 clone）、
 * App 与插件逐夹具 parity、token 卫生、失败 clone 无半份工作副本、status 暴露 typed 码。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRpcService } from '../dist/rpc.js'
import { GitRepo } from '../dist/engine/git.js'
import { repoHash } from '../dist/engine/paths.js'
import { decideRepoVisibility, repoTargetFromUrl, providerEndpoint, visibilityHeaders, E_REPO_AUTH, E_REPO_VISIBILITY_UNKNOWN } from '../dist/remote/repoVisibility.js'

const VECTORS = fileURLToPath(new URL('../../../test-vectors/repo-visibility/', import.meta.url))
const EXPECTED_NAMES = [
  'empty-body.txt', 'enterprise-unsupported.json', 'forbidden.json',
  'gitee-private-extra-fields.json', 'gitee-private.json', 'gitee-public.json',
  'github-private.json', 'github-public.json', 'html-instead-of-json.html',
  'malformed-json.json', 'not-found.json', 'private-missing-field.json',
  'public-missing-but-500.json', 'unauthorized.json',
]
const MESSAGES = {
  E_REPO_PUBLIC: '仓库是公开的：日程与远程控制配置不允许提交到公开仓库。请把仓库改成私有后重试',
  E_REPO_AUTH: '令牌无权读取该仓库：请确认令牌有效且具备仓库读权限',
  E_REPO_NOT_FOUND: '仓库不存在：请检查地址（owner/repo）后重试',
  E_REPO_HOST_UNSUPPORTED: '不支持自动校验该仓库的可见性。请改用 Gitee 或 GitHub 的私有仓库；本应用不会把无法校验的仓库当作私有',
  E_REPO_VISIBILITY_UNKNOWN: '暂时无法确认仓库可见性：请检查网络后重试（未确认私有前不会提交任何数据）',
  E_REPO_BAD_RESPONSE: '仓库接口返回了非预期内容（可能被代理或登录页拦截）：请检查网络后重试',
}

const TOKEN = 'gitee_fake_token_DO_NOT_LEAK_3f8a'
const GITEE_URL = 'https://gitee.com/ding_haoran/dsh-mobile-remote.git'
const SETTINGS = {
  repoUrl: GITEE_URL,
  platform: 'gitee',
  authMode: 'https',
  username: 'ding_haoran',
  deviceId: 'pc-a',
  branch: 'main',
  scope: { config: true, providers: true, plugins: true, mcp: true },
}

function fixture(name) {
  return JSON.parse(readFileSync(path.join(VECTORS, name), 'utf8'))
}

function reply(status, body, contentType = 'application/json; charset=utf-8') {
  return { status, contentType, body: typeof body === 'string' ? body : JSON.stringify(body) }
}

/** 假 fetch：记录每次调用；responder 可返回响应对象或抛错（模拟网络失败）。 */
function fakeFetch(responder) {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url, init })
    return await responder(url, init)
  }
  fn.calls = calls
  return fn
}

async function setup(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-repo-precheck-'))
  const homeDir = path.join(root, 'home')
  const profileDir = path.join(root, 'profile')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '# empty\n', 'utf8')
  const service = createRpcService({
    homeDir,
    profileDir,
    dshVersion: 'test-1',
    repoPrecheckFetch: options.fetch ?? fakeFetch(async () => reply(200, { id: 1, private: true })),
    ...(options.allowLocalRepo === true ? { allowLocalRepo: true } : {}),
  })
  t.after(async () => {
    await service.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => undefined)
  })
  return {
    root,
    homeDir,
    service,
    settingsFile: path.join(homeDir, '.dsh', 'dots', 'settings.json'),
    stateFile: path.join(homeDir, '.dsh', 'dots', 'state.json'),
    credentialsFile: path.join(homeDir, '.dsh', 'dots', 'credentials.json'),
  }
}

/** 先写一份「空仓库」旧配置，使失败时的 settings.json 字节比较有真实基准。 */
async function seedPrevious(world) {
  const saved = await world.service.handleRpc({
    action: 'saveSettings',
    settings: { ...SETTINGS, repoUrl: '' },
    token: null,
  })
  assert.equal(saved.ok, true, JSON.stringify(saved))
  return readFileSync(world.settingsFile, 'utf8')
}

function workDirsOf(world, repoUrl) {
  const hash = repoHash(repoUrl)
  return [
    path.join(world.homeDir, '.dsh', 'dots', 'work', hash),
    path.join(world.homeDir, '.dsh', 'dots', 'repos', hash),
  ]
}

function assertRefused(world, before, result, code) {
  assert.equal(result.ok, false, JSON.stringify(result))
  assert.equal(result.error.code, code, JSON.stringify(result))
  assert.equal(result.error.message, MESSAGES[code], '文案必须与 App 逐字一致')
  assert.equal(readFileSync(world.settingsFile, 'utf8'), before, 'settings.json 必须逐字节不变')
  for (const dir of workDirsOf(world, SETTINGS.repoUrl)) {
    assert.equal(existsSync(dir), false, '失败保存不得创建任何 clone 目录')
  }
  return result
}

/* -------------------------------------------------------------------------- */
/* 1. 与 App 的码 / 文案 / 14 份共享夹具逐字 parity                            */
/* -------------------------------------------------------------------------- */

test('P0：插件纯模型与 App 的 14 份夹具逐字一致（code / 中文文案 / ok）', () => {
  assert.deepEqual(EXPECTED_NAMES, readdirSync(VECTORS).filter((n) => n !== 'SHA256SUMS').sort())
  for (const name of EXPECTED_NAMES) {
    const item = fixture(name)
    const decision = decideRepoVisibility(item.request)
    assert.deepEqual(
      { ok: decision.ok, code: decision.code, message: decision.message },
      {
        ok: item.expected.ok,
        code: item.expected.code,
        message: item.expected.ok ? '' : MESSAGES[item.expected.code],
      },
      `${name} 插件 / App 判定不一致`,
    )
  }
})

test('P0b：URL → vendor 端点与 Authorization 只暴露在 header，token 不进 URL', () => {
  assert.deepEqual(repoTargetFromUrl(GITEE_URL), { host: 'gitee.com', owner: 'ding_haoran', repo: 'dsh-mobile-remote' })
  assert.deepEqual(repoTargetFromUrl('git@github.com:alice/repo.git'), { host: 'github.com', owner: 'alice', repo: 'repo' })
  assert.equal(providerEndpoint(repoTargetFromUrl(GITEE_URL)), 'https://gitee.com/api/v5/repos/ding_haoran/dsh-mobile-remote')
  assert.equal(providerEndpoint(repoTargetFromUrl('https://github.com/alice/repo.git')), 'https://api.github.com/repos/alice/repo')
  const headers = visibilityHeaders({ host: 'gitee.com', owner: 'a', repo: 'r' }, TOKEN)
  assert.equal(headers.Authorization, `token ${TOKEN}`)
  assert.equal(Object.keys(headers).filter((k) => JSON.stringify(headers[k]).includes(TOKEN)).join(','), 'Authorization')
})

/* -------------------------------------------------------------------------- */
/* 2. 保存前门禁：通过才落盘，失败一律 typed 且零写入                          */
/* -------------------------------------------------------------------------- */

test('P1：probe 成功 + 显式 private:true ⇒ 保存成功并落盘', async (t) => {
  const world = await setup(t)
  const before = await seedPrevious(world)
  assert.notEqual(before, '')
  const saved = await world.service.handleRpc({ action: 'saveSettings', settings: SETTINGS, token: TOKEN })
  assert.equal(saved.ok, true, JSON.stringify(saved))
  assert.equal(saved.data.settings.repoUrl, GITEE_URL)
  assert.equal(saved.data.hasToken, true)
  assert.equal(existsSync(world.settingsFile), true)
  assert.equal(readFileSync(world.settingsFile, 'utf8').includes(GITEE_URL), true)
  assert.equal(readFileSync(world.stateFile, 'utf8').includes(TOKEN), false, 'state.json 不得含 token')
  const state = await world.service.handleRpc({ action: 'getState' })
  assert.equal(state.data.status.repoBlockCode, null)
})

test('P2：403 / 401 ⇒ E_REPO_AUTH，settings.json 字节不变，无 clone 目录', async (t) => {
  for (const status of [403, 401]) {
    const fetch = fakeFetch(async () => reply(status, '{"message":"The token is not authorized to access this project"}'))
    const world = await setup(t, { fetch })
    const before = await seedPrevious(world)
    const result = await world.service.handleRpc({ action: 'saveSettings', settings: SETTINGS, token: TOKEN })
    assertRefused(world, before, result, E_REPO_AUTH)
    assert.equal(fetch.calls.length, 1)
    assert.equal(fetch.calls[0].url.includes(TOKEN), false, 'URL 不得带 token')
    assert.equal(fetch.calls[0].init.headers.Authorization, `token ${TOKEN}`, 'token 唯一落点 Authorization')
    assert.equal(JSON.stringify(result).includes(TOKEN), false)
    assert.equal(readFileSync(world.stateFile, 'utf8').includes(TOKEN), false)
    assert.equal(readFileSync(world.settingsFile, 'utf8').includes(TOKEN), false)
  }
})

test('P3：404 ⇒ E_REPO_NOT_FOUND（文案与 App 逐字一致）', async (t) => {
  const world = await setup(t, { fetch: fakeFetch(async () => reply(404, fixture('not-found.json').request.body)) })
  const before = await seedPrevious(world)
  assertRefused(world, before, await world.service.handleRpc({ action: 'saveSettings', settings: SETTINGS, token: TOKEN }), 'E_REPO_NOT_FOUND')
})

test('P4：private:false ⇒ E_REPO_PUBLIC（绝不假定私有）', async (t) => {
  const world = await setup(t, { fetch: fakeFetch(async () => reply(200, fixture('gitee-public.json').request.body)) })
  const before = await seedPrevious(world)
  assertRefused(world, before, await world.service.handleRpc({ action: 'saveSettings', settings: SETTINGS, token: TOKEN }), 'E_REPO_PUBLIC')
})

test('P5：200 缺 private ⇒ E_REPO_BAD_RESPONSE', async (t) => {
  const world = await setup(t, { fetch: fakeFetch(async () => reply(200, fixture('private-missing-field.json').request.body)) })
  const before = await seedPrevious(world)
  assertRefused(world, before, await world.service.handleRpc({ action: 'saveSettings', settings: SETTINGS, token: TOKEN }), 'E_REPO_BAD_RESPONSE')
})

test('P6：未知 host ⇒ E_REPO_HOST_UNSUPPORTED，且一个请求都不发', async (t) => {
  const fetch = fakeFetch(async () => reply(200, { id: 1, private: true }))
  const world = await setup(t, { fetch })
  const before = await seedPrevious(world)
  const result = await world.service.handleRpc({
    action: 'saveSettings',
    settings: { ...SETTINGS, repoUrl: 'https://git.example.com/team/private.git', platform: 'custom' },
    token: TOKEN,
  })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'E_REPO_HOST_UNSUPPORTED')
  assert.equal(result.error.message, MESSAGES.E_REPO_HOST_UNSUPPORTED)
  assert.equal(readFileSync(world.settingsFile, 'utf8'), before)
  assert.equal(fetch.calls.length, 0, '未知 host 不得发任何 vendor API 请求')
})

test('P7：网络错误 / 超时 ⇒ E_REPO_VISIBILITY_UNKNOWN（可重试文案，fail closed）', async (t) => {
  const fetch = fakeFetch(async () => { throw new Error('simulated network failure') })
  const world = await setup(t, { fetch })
  const before = await seedPrevious(world)
  const result = await world.service.handleRpc({ action: 'saveSettings', settings: SETTINGS, token: TOKEN })
  assertRefused(world, before, result, E_REPO_VISIBILITY_UNKNOWN)
  assert.match(result.error.message, /重试/, '必须给出可重试的下一步')
  assert.equal(readFileSync(world.stateFile, 'utf8').includes(E_REPO_VISIBILITY_UNKNOWN), true, 'typed 码进 state 供 status 显示')
})

/* -------------------------------------------------------------------------- */
/* 3. 失败 clone 不留半份工作副本；status 不谎报健康                           */
/* -------------------------------------------------------------------------- */

test('P8：clone 失败后没有 .git，也没有 .git.clone-failed-* 残留', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-repo-clone-fail-'))
  t.after(async () => { await rm(root, { recursive: true, force: true }).catch(() => undefined) })
  const parent = path.join(root, 'work')
  const dir = path.join(parent, 'target')
  const missingLocalRepo = path.join(root, 'missing.git')
  const repo = new GitRepo({
    dir,
    repoUrl: missingLocalRepo,
    branch: 'main',
    authMode: 'https',
    platform: 'custom',
    allowLocalRepo: true,
  })
  await assert.rejects(() => repo.ensureWorkTree(), /git clone/, '不存在的本地仓库必须 clone 失败')
  assert.equal(existsSync(path.join(dir, '.git')), false, '失败不得留下 .git')
  const quarantines = readdirSync(parent).filter((name) => name.startsWith('.git.clone-failed-'))
  assert.deepEqual(quarantines, [], '失败不得留下隔离目录')
})

test('P9：clone 失败后 status.repoBlockCode 显示 typed 码，不再声称配置健康', async (t) => {
  const broken = path.join(await mkdtemp(path.join(tmpdir(), 'dsh-repo-status-')), 'missing.git')
  t.after(async () => { await rm(path.dirname(broken), { recursive: true, force: true }).catch(() => undefined) })
  const world = await setup(t, { allowLocalRepo: true })
  const saved = await world.service.handleRpc({
    action: 'saveSettings',
    settings: { ...SETTINGS, repoUrl: broken, platform: 'custom' },
    token: null,
  })
  assert.equal(saved.ok, true, JSON.stringify(saved))
  const pushed = await world.service.handleRpc({ action: 'push' })
  assert.equal(pushed.ok, false, '不存在的仓库必须 push/clone 失败')
  const state = await world.service.handleRpc({ action: 'getState' })
  assert.equal(typeof state.data.status.repoBlockCode, 'string', JSON.stringify(state.data.status))
  assert.match(state.data.status.repoBlockCode, /^E_REPO_/, '必须是 App 同词汇的 typed 码')

  const cleared = await world.service.handleRpc({
    action: 'saveSettings',
    settings: { ...SETTINGS, repoUrl: '' },
    token: null,
  })
  assert.equal(cleared.ok, true)
  const after = await world.service.handleRpc({ action: 'getState' })
  assert.equal(after.data.status.repoBlockCode, null, '清空配置后阻断码必须复位')
})
