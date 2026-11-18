/**
 * 独立审计报告（reports/audit-plugin.md）缺陷的回归测试。
 *
 * 覆盖：
 *   B2  isSecretKey 词边界匹配；maxTokens/apiKeyEnv/max_tokens 不被误伤；
 *       restore 按 entry + key 路径回填，两个 provider 不会错配；
 *   M1  repoUrl 内嵌凭据被拒（https 剥不掉就拒绝），git@/ssh:// 放行；
 *   M2  空 repoUrl 可保存（初始态/清空），push/testConnection/preview 报 E_VALIDATION；
 *   M3  apply 的 entries 为空 / 未知 id / 状态 same → 整单 E_VALIDATION；
 *   M4  lastSyncAt 持久化（新实例可读），conflict 只在双方分叉时为 true；
 *   M5  Windows askpass 不再用 cmd 展开 token（含 & | % < > ^ 也能原样输出）。
 *
 * 全部使用临时目录 + 本地裸仓库，不依赖网络、不碰真实 profile。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { createRpcService } from '../dist/rpc.js'
import { parsePatch } from '../dist/engine/patch.js'
import { repoHash } from '../dist/engine/paths.js'
import { writeAskpassFiles } from '../dist/engine/git.js'
import {
  SECRET_PLACEHOLDER,
  isSecretKey,
  restorePatchSecrets,
  splitKeyWords,
  stripPatchSecrets,
} from '../dist/engine/secrets.js'

const exec = promisify(execFile)

const SETTINGS_BASE = {
  platform: 'custom',
  authMode: 'https',
  branch: 'main',
  scope: { config: true, providers: true, plugins: true, mcp: true },
}

/* -------------------------------------------------------------------------- */
/* B2：secret key 判定                                                        */
/* -------------------------------------------------------------------------- */

test('B2 isSecretKey：词边界匹配，maxTokens/apiKeyEnv/tokens 不算密钥', () => {
  const notSecret = [
    'maxTokens',
    'max_tokens',
    'tokens',
    'tokensUsed',
    'apiKeyEnv',
    'api_key_env',
    'tokenizer',
    'name',
    'baseURL',
    'model',
    'maxOutputTokens',
    'env',
  ]
  for (const key of notSecret) {
    assert.equal(isSecretKey(key), false, `${key} 不得被当成密钥`)
  }

  const secret = [
    'apiKey',
    'api_key',
    'apikey',
    'API_KEY',
    'accessToken',
    'refreshToken',
    'client_secret',
    'clientSecret',
    'Authorization',
    'authorization',
    'bearer',
    'password',
    'dbPassword',
    'token',
    'X-Api-Key',
    'secret',
  ]
  for (const key of secret) {
    assert.equal(isSecretKey(key), true, `${key} 必须被当成密钥`)
  }

  assert.deepEqual(splitKeyWords('maxTokens'), ['max', 'tokens'])
  assert.deepEqual(splitKeyWords('api_key_env'), ['api', 'key', 'env'])
  assert.deepEqual(splitKeyWords('APIKeyEnv'), ['api', 'key', 'env'])
})

test('B2 stripPatchSecrets：真实 profile 的 maxTokens/apiKeyEnv 原样保留，只替换真密钥', () => {
  const patch = `# 真实 profile 形状（含模型 maxTokens / apiKeyEnv）
- id: llm-pi-ai
  config:
    providers:
      opencode-go:
        apiKeyEnv: OPENCODE_GO_API_KEY
        models:
        - id: deepseek-v4-pro
          maxTokens: 384000
          apiKey: fake-key-not-real
          accessToken: fake-access-not-real
          refreshToken: fake-refresh-not-real
          client_secret: fake-client-secret
          Authorization: Bearer fake-bearer
          max_tokens: 8192
`
  const stripped = stripPatchSecrets(patch)
  assert.equal(stripped.text.includes('maxTokens: 384000'), true, 'maxTokens 必须原样保留')
  assert.equal(stripped.text.includes('max_tokens: 8192'), true, 'max_tokens 必须原样保留')
  assert.equal(stripped.text.includes('apiKeyEnv: OPENCODE_GO_API_KEY'), true, 'apiKeyEnv 必须原样保留')
  for (const leaked of ['fake-key-not-real', 'fake-access-not-real', 'fake-refresh-not-real', 'fake-client-secret', 'fake-bearer']) {
    assert.equal(stripped.text.includes(leaked), false, `${leaked} 必须被替换为占位符`)
  }
  assert.equal(stripped.text.split(SECRET_PLACEHOLDER).length - 1, 5, '恰好 5 个密钥值被替换')
})

test('B2 restorePatchSecrets：同一 entry 内两个 provider 各取回自己的本地值（不错配）', () => {
  const remote = `- id: llm
  config:
    providers:
      model-a:
        apiKey: __SECRET__
        maxTokens: 1111
      model-b:
        apiKey: __SECRET__
        maxTokens: 2222
`
  // 本地顺序与远端相反（审计报告里正是这个场景导致按出现顺序错配）
  const local = `- id: llm
  config:
    providers:
      model-b:
        apiKey: fake-local-b
        maxTokens: 2222
      model-a:
        apiKey: fake-local-a
        maxTokens: 1111
`
  const restored = restorePatchSecrets(remote, local)
  assert.deepEqual(restored.needsLocal, [], '两个本地值都在 → 不应有 needsLocal')
  const modelA = restored.text.slice(restored.text.indexOf('model-a:'), restored.text.indexOf('model-b:'))
  const modelB = restored.text.slice(restored.text.indexOf('model-b:'))
  assert.ok(modelA.includes('apiKey: fake-local-a'), `model-a 必须拿回自己的值，实际：\n${restored.text}`)
  assert.ok(modelB.includes('apiKey: fake-local-b'), `model-b 必须拿回自己的值，实际：\n${restored.text}`)
  assert.equal(restored.text.includes(SECRET_PLACEHOLDER), false)
  assert.ok(restored.text.includes('maxTokens: 1111'), '非密钥字段原样保留')
  assert.ok(restored.text.includes('maxTokens: 2222'), '非密钥字段原样保留')

  // 本地缺少 model-b 的密钥：只有真正缺失的 key 进 needsLocal，且绝不串用 model-a 的值
  const partial = restorePatchSecrets(
    remote,
    `- id: llm
  config:
    providers:
      model-a:
        apiKey: only-local-a
        maxTokens: 1111
`,
  )
  assert.deepEqual(partial.needsLocal, ['apiKey'], '只有真正缺失的项进 needsLocal')
  assert.ok(partial.text.includes('apiKey: only-local-a'), '存在的项仍按路径回填')
  assert.ok(partial.text.includes(SECRET_PLACEHOLDER), '缺失项保留占位符（调用方据此跳过该条目）')
})

test('B2 restorePatchSecrets：整份 patch 按 entry 对齐，不同 entry 的同名 key 不互相串值', () => {
  const remote = `# 远端文件头
- id: one
  config:
    password: __SECRET__
- id: two
  config:
    password: __SECRET__
`
  const local = `# 本地文件头
- id: two
  config:
    password: local-two
- id: one
  config:
    password: local-one
`
  const restored = restorePatchSecrets(remote, local)
  assert.deepEqual(restored.needsLocal, [])
  const one = restored.text.slice(restored.text.indexOf('- id: one'), restored.text.indexOf('- id: two'))
  const two = restored.text.slice(restored.text.indexOf('- id: two'))
  assert.ok(one.includes('password: local-one'))
  assert.ok(two.includes('password: local-two'))
  assert.ok(restored.text.startsWith('# 远端文件头'), '远端文件头保留')
})

/* -------------------------------------------------------------------------- */
/* M5：Windows askpass 不经 cmd 展开 token                                     */
/* -------------------------------------------------------------------------- */

test('M5 askpass：token 只从环境变量读，含 & | < > % ^ 也能原样输出（不经 cmd 展开）', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gcs-askpass-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  })
  const token = 'fake-token&|<>%^suffix' // 明显假值；全是 cmd 的语法字符
  const user = 'x-access-token'
  const files = await writeAskpassFiles(dir)
  const env = {
    ...process.env,
    DSH_GIT_SYNC_TOKEN: token,
    DSH_GIT_SYNC_USER: user,
    DSH_GIT_SYNC_NODE: process.execPath,
    DSH_GIT_SYNC_ASKPASS_COUNTER: files.counter,
  }

  for (const file of [files.sh, files.cmd, files.js]) {
    assert.equal(existsSync(file), true, `${path.basename(file)} 必须生成`)
    const text = await readFile(file, 'utf8')
    assert.equal(text.includes(token), false, `${path.basename(file)} 不得包含 token`)
  }
  // Windows 的 .cmd 只调 node（不再 echo %TOKEN%）
  const cmdText = await readFile(files.cmd, 'utf8')
  assert.equal(/%DSH_GIT_SYNC_TOKEN%/.test(cmdText), false, '.cmd 不得直接展开 token 变量')
  assert.match(cmdText, /askpass\.mjs/)

  // node 脚本：按 git 的提示文本决定输出用户名还是 token
  const passwordCall = await exec(process.execPath, [files.js, "Password for 'https://x-access-token@example.invalid':"], { env })
  assert.equal(passwordCall.stdout.replace(/\r?\n$/, ''), token, 'token 必须逐字符原样输出')
  const usernameCall = await exec(process.execPath, [files.js, "Username for 'https://example.invalid':"], { env })
  assert.equal(usernameCall.stdout.replace(/\r?\n$/, ''), user)

  if (process.platform !== 'win32') return

  // Windows 下真正跑一遍 .cmd：第一次调用给用户名，之后给 token（提示文本不经 cmd 转义）
  const first = await exec('cmd.exe', ['/d', '/c', files.cmd], { cwd: dir, env })
  assert.equal(first.stdout.replace(/\r?\n$/, ''), user)
  const second = await exec('cmd.exe', ['/d', '/c', files.cmd], { cwd: dir, env })
  assert.equal(second.stdout.replace(/\r?\n$/, ''), token, 'cmd → node 路径必须原样输出含特殊字符的 token')
})

/* -------------------------------------------------------------------------- */
/* M1 / M2：repoUrl 校验与空值语义                                             */
/* -------------------------------------------------------------------------- */

async function makeLocalService(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'gcs-settings-'))
  const homeDir = path.join(root, 'home')
  const profileDir = path.join(root, 'profile')
  await mkdir(profileDir, { recursive: true })
  await writeFile(path.join(profileDir, 'cordis.patch.yml'), '- id: a\n  config:\n    k: v\n', 'utf8')
  const service = createRpcService({ homeDir, profileDir, dshVersion: 'test-1', allowLocalRepo: true })
  t.after(async () => {
    await service.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  })
  const settingsFile = path.join(homeDir, '.dsh', 'dots', 'settings.json')
  return { root, homeDir, profileDir, service, settingsFile }
}

test('M1 repoUrl：内嵌凭据被拒（E_VALIDATION），git@host:path 与 ssh:// 放行', async (t) => {
  const { service, settingsFile } = await makeLocalService(t)
  const rejected = [
    'https://user:pass@example.invalid/u/r.git',
    'https://ghp_fake_token_not_real@example.invalid/u/r.git',
    'ssh://user:pass@example.invalid/u/r.git',
  ]
  for (const repoUrl of rejected) {
    const result = await service.handleRpc({
      action: 'saveSettings',
      settings: { ...SETTINGS_BASE, repoUrl, deviceId: 'pc-a' },
    })
    assert.equal(result.ok, false, `${repoUrl} 必须被拒绝`)
    assert.equal(result.error.code, 'E_VALIDATION', JSON.stringify(result.error))
    assert.equal(JSON.stringify(result.error).includes('ghp_fake_token_not_real'), false, '错误体不得回显凭据')
    assert.equal(JSON.stringify(result.error).includes('pass@example.invalid'), false, '错误体不得回显凭据')
  }
  // 被拒的输入不落盘
  if (existsSync(settingsFile)) {
    const text = await readFile(settingsFile, 'utf8')
    assert.equal(text.includes('ghp_fake_token_not_real'), false)
    assert.equal(text.includes('user:pass'), false)
  }

  const https = await service.handleRpc({
    action: 'saveSettings',
    settings: { ...SETTINGS_BASE, repoUrl: 'https://example.invalid/u/r.git', deviceId: 'pc-a' },
  })
  assert.equal(https.ok, true, JSON.stringify(https))

  const scp = await service.handleRpc({
    action: 'saveSettings',
    settings: { ...SETTINGS_BASE, authMode: 'ssh', repoUrl: 'git@github.com:u/r.git' },
  })
  assert.equal(scp.ok, true, JSON.stringify(scp))
  assert.equal(scp.data.settings.repoUrl, 'git@github.com:u/r.git')

  const sshUrl = await service.handleRpc({
    action: 'saveSettings',
    settings: { ...SETTINGS_BASE, authMode: 'ssh', repoUrl: 'ssh://git@github.com/u/r.git' },
  })
  assert.equal(sshUrl.ok, true, 'ssh://git@host 是正常 SSH 远程，必须放行')
  assert.equal(sshUrl.data.settings.repoUrl, 'ssh://git@github.com/u/r.git')
})

test('M2 repoUrl：空串可保存（清空），但 push/testConnection/preview 报 E_VALIDATION', async (t) => {
  const { service, settingsFile } = await makeLocalService(t)
  const saved = await service.handleRpc({
    action: 'saveSettings',
    settings: { ...SETTINGS_BASE, repoUrl: 'https://example.invalid/u/r.git', deviceId: 'pc-a' },
  })
  assert.equal(saved.ok, true)

  // 显式空串 = 清空，而不是"未提供"（旧实现会保留旧值 → 假成功）
  const cleared = await service.handleRpc({
    action: 'saveSettings',
    settings: { ...SETTINGS_BASE, repoUrl: '', deviceId: 'pc-a' },
  })
  assert.equal(cleared.ok, true, JSON.stringify(cleared))
  assert.equal(cleared.data.settings.repoUrl, '', '返回值必须真的是空')
  assert.equal(JSON.parse(await readFile(settingsFile, 'utf8')).repoUrl, '', 'settings.json 必须落盘为空串')

  const state = await service.handleRpc({ action: 'getState' })
  assert.equal(state.ok, true)
  assert.equal(state.data.settings.repoUrl, '')
  assert.equal(state.data.status.lastSyncAt, null, '从未同步 → lastSyncAt 为 null')
  assert.equal(state.data.status.reachable, null, '未配置/未探测 → reachable 为 null')
  assert.equal(state.data.status.error, undefined, '未配置仓库地址不是"本地读取错误"，不填 error')

  for (const action of ['push', 'testConnection', 'preview']) {
    const result = await service.handleRpc({ action })
    assert.equal(result.ok, false, `${action} 在空 repoUrl 时必须失败，不能假成功`)
    assert.equal(result.error.code, 'E_VALIDATION', `${action}: ${JSON.stringify(result.error)}`)
  }

  // 字段缺省（不传 repoUrl）仍然保留已有值，不会被误清空
  await service.handleRpc({
    action: 'saveSettings',
    settings: { ...SETTINGS_BASE, repoUrl: 'https://example.invalid/u/r.git', deviceId: 'pc-a' },
  })
  const omitted = await service.handleRpc({
    action: 'saveSettings',
    settings: { platform: 'custom', authMode: 'https', deviceId: 'pc-a', branch: 'main' },
  })
  assert.equal(omitted.ok, true)
  assert.equal(omitted.data.settings.repoUrl, 'https://example.invalid/u/r.git', '缺省字段必须保留')
})

/* -------------------------------------------------------------------------- */
/* M3 / M4 / B2（端到端）：apply 严格校验 + lastSyncAt + conflict              */
/* -------------------------------------------------------------------------- */

const PATCH_A = `# 设备 A profile patch
- id: shared
  config:
    value: same
- id: changed
  config:
    value: from-a
- id: llm
  config:
    providers:
      model-a:
        apiKey: fake-remote-a
        maxTokens: 1111
      model-b:
        apiKey: fake-remote-b
        maxTokens: 2222
`

const PATCH_B = `# 设备 B profile patch
- id: shared
  config:
    value: same
- id: changed
  config:
    value: from-b
- id: llm
  config:
    providers:
      model-b:
        apiKey: fake-local-b
        maxTokens: 2222
      model-a:
        apiKey: fake-local-a
        maxTokens: 1111
`

const FIXED_NOW = '2026-01-02T03:04:05.000Z'

test('M3/M4 + B2 端到端：apply 严格 entries、lastSyncAt 持久化、conflict 语义、双 provider 不错配', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gcs-auditfix-'))
  const bare = path.join(root, 'remote.git')
  await exec('git', ['init', '--bare', '-b', 'main', bare])

  const homeA = path.join(root, 'home-a')
  const homeB = path.join(root, 'home-b')
  const profileA = path.join(root, 'profile-a')
  const profileB = path.join(root, 'profile-b')
  for (const dir of [profileA, profileB]) await mkdir(dir, { recursive: true })
  const patchFileB = path.join(profileB, 'cordis.patch.yml')
  await writeFile(path.join(profileA, 'cordis.patch.yml'), PATCH_A, 'utf8')
  await writeFile(patchFileB, PATCH_B, 'utf8')

  const fixedNow = () => new Date(FIXED_NOW)
  const serviceA = createRpcService({
    homeDir: homeA,
    profileDir: profileA,
    dshVersion: 'test-1',
    allowLocalRepo: true,
    now: fixedNow,
  })
  const serviceB = createRpcService({
    homeDir: homeB,
    profileDir: profileB,
    dshVersion: 'test-1',
    allowLocalRepo: true,
    now: fixedNow,
  })
  t.after(async () => {
    await serviceA.dispose()
    await serviceB.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  })

  // ---------- 初始化：A 保存设置并推送；B 只保存设置（尚未同步） ----------
  const savedA = await serviceA.handleRpc({
    action: 'saveSettings',
    settings: { ...SETTINGS_BASE, repoUrl: bare, deviceId: 'pc-a' },
  })
  assert.equal(savedA.ok, true, JSON.stringify(savedA))
  const stateBeforePush = await serviceA.handleRpc({ action: 'getState' })
  assert.equal(stateBeforePush.ok, true)
  assert.equal(stateBeforePush.data.status.lastSyncAt, null, '推送前 lastSyncAt 必须为 null')

  const pushA = await serviceA.handleRpc({ action: 'push' })
  assert.equal(pushA.ok, true, JSON.stringify(pushA))
  assert.equal(pushA.data.pushed, true)

  // ---------- M4：lastSyncAt 是"最近一次成功同步"的 ISO 时间，且可被新实例读到 ----------
  const stateA = await serviceA.handleRpc({ action: 'getState' })
  assert.equal(stateA.ok, true)
  assert.equal(stateA.data.status.lastSyncAt, FIXED_NOW, 'lastSyncAt 必须来自持久化的同步时间，不是 HEAD 提交时间')
  assert.equal(stateA.data.status.conflict, false, '只领先远端时不是冲突')
  assert.equal(stateA.data.status.localPending, 0)
  assert.equal(stateA.data.status.remotePending, 0)

  const serviceA2 = createRpcService({
    homeDir: homeA,
    profileDir: profileA,
    dshVersion: 'test-1',
    allowLocalRepo: true,
    now: fixedNow,
  })
  t.after(async () => {
    await serviceA2.dispose()
  })
  const stateA2 = await serviceA2.handleRpc({ action: 'getState' })
  assert.equal(stateA2.ok, true)
  assert.equal(stateA2.data.status.lastSyncAt, FIXED_NOW, '新的 createRpcService 实例必须能读到 lastSyncAt')

  // ---------- B：预览 ----------
  const savedB = await serviceB.handleRpc({
    action: 'saveSettings',
    settings: { ...SETTINGS_BASE, repoUrl: bare, deviceId: 'pc-b' },
  })
  assert.equal(savedB.ok, true, JSON.stringify(savedB))

  const stateB = await serviceB.handleRpc({ action: 'getState' })
  assert.equal(stateB.ok, true)
  assert.equal(stateB.data.status.conflict, false, '只落后远端（可快进/rebase）不是冲突')
  assert.equal(stateB.data.status.reachable, null, '从未探测 → reachable 必须是 null（不是 false）')
  assert.equal(stateB.data.status.localPending, null, '未 clone 时没有 origin/main 引用 → localPending 为 null（不联网）')
  assert.equal(stateB.data.status.remotePending, null, '未 clone 时没有 origin/main 引用 → remotePending 为 null（不联网）')
  assert.equal(stateB.data.status.error, undefined, '未探测/未 clone 不是错误')
  assert.equal(stateB.data.status.lastSyncAt, null, 'B 从未同步 → lastSyncAt 仍为 null')

  const preview = await serviceB.handleRpc({ action: 'preview' })
  assert.equal(preview.ok, true, JSON.stringify(preview))
  const source = preview.data.sources.find((item) => item.deviceId === 'pc-a')
  assert.ok(source !== undefined, JSON.stringify(preview.data.sources.map((item) => item.deviceId)))
  const statusOf = Object.fromEntries(source.entries.map((entry) => [entry.id, entry.status]))
  assert.equal(statusOf.shared, 'same')
  assert.equal(statusOf.changed, 'changed')
  assert.equal(statusOf.llm, 'manual', '含占位符的远端块与本地不同 → manual')

  // ---------- M3：entries 为空 / 未知 id / 状态 same 的 id → 整单 E_VALIDATION ----------
  const bytesBefore = await readFile(patchFileB)
  const baseApply = {
    action: 'apply',
    confirm: true,
    previewId: preview.data.previewId,
    sourceDevice: 'pc-a',
  }
  const empty = await serviceB.handleRpc({ ...baseApply, entries: [] })
  assert.equal(empty.ok, false, '空 entries 必须拒绝')
  assert.equal(empty.error.code, 'E_VALIDATION')

  const unknown = await serviceB.handleRpc({ ...baseApply, entries: ['nope-not-in-preview'] })
  assert.equal(unknown.ok, false, '未知 id 必须整单拒绝，不能部分 skip')
  assert.equal(unknown.error.code, 'E_VALIDATION')
  assert.deepEqual(unknown.error.details.rejected, [{ id: 'nope-not-in-preview', reason: 'not-in-preview' }])

  const sameOnly = await serviceB.handleRpc({ ...baseApply, entries: ['shared'] })
  assert.equal(sameOnly.ok, false, '状态为 same 的 id 必须拒绝')
  assert.equal(sameOnly.error.code, 'E_VALIDATION')
  assert.deepEqual(sameOnly.error.details.rejected, [{ id: 'shared', reason: 'unchanged' }])

  const mixed = await serviceB.handleRpc({ ...baseApply, entries: ['changed', 'shared'] })
  assert.equal(mixed.ok, false, '只要有非法项就整单拒绝（不得写入合法项）')
  assert.equal(mixed.error.code, 'E_VALIDATION')
  assert.deepEqual(await readFile(patchFileB), bytesBefore, '被拒绝的 apply 不得写文件')

  // ---------- B2 端到端：manual 条目按 provider 路径回填，取值不错配 ----------
  const applied = await serviceB.handleRpc({ ...baseApply, entries: ['llm'] })
  assert.equal(applied.ok, true, JSON.stringify(applied))
  assert.deepEqual(applied.data.applied.map((item) => item.id), ['llm'])
  const textB = await readFile(patchFileB, 'utf8')
  assert.equal(textB.includes(SECRET_PLACEHOLDER), false, 'apply 后不得残留占位符')
  const idxA = textB.indexOf('model-a:')
  const idxB = textB.indexOf('model-b:')
  assert.ok(idxA >= 0 && idxB > idxA, `provider 顺序异常：\n${textB}`)
  const modelA = textB.slice(idxA, idxB)
  const modelB = textB.slice(idxB)
  assert.ok(modelA.includes('apiKey: fake-local-a'), `model-a 必须用本地 B 的值（不得错配）：\n${modelA}`)
  assert.ok(modelB.includes('apiKey: fake-local-b'), `model-b 必须用本地 B 的值（不得错配）：\n${modelB}`)
  assert.ok(modelA.includes('maxTokens: 1111'), 'maxTokens 不是密钥，必须原样带过来')
  assert.ok(modelB.includes('maxTokens: 2222'))
  assert.equal(textB.includes('fake-remote-a'), false, '远端密钥绝不应出现在本地（已脱敏为占位符）')
  // 未勾选条目字节不变
  const afterDoc = parsePatch(textB)
  const beforeDoc = parsePatch(PATCH_B)
  for (const key of ['shared', 'changed']) {
    assert.equal(
      afterDoc.entries.find((entry) => entry.key === key)?.raw,
      beforeDoc.entries.find((entry) => entry.key === key)?.raw,
      `${key} 未勾选，必须字节不变`,
    )
  }
  assert.ok(textB.startsWith('# 设备 B profile patch'))

  // apply 也是一次成功同步 → lastSyncAt 更新
  const stateBAfter = await serviceB.handleRpc({ action: 'getState' })
  assert.equal(stateBAfter.data.status.lastSyncAt, FIXED_NOW, 'apply 成功也应记录 lastSyncAt')

  // ---------- M4：真正分叉（本地有远端没有的提交 + 远端有本地没有的提交）→ conflict true ----------
  const pushB = await serviceB.handleRpc({ action: 'push' })
  assert.equal(pushB.ok, true, JSON.stringify(pushB))

  const workA = path.join(homeA, '.dsh', 'dots', 'work', repoHash(bare))
  await writeFile(path.join(workA, 'devices', 'pc-a', 'local-note.txt'), 'local only commit\n', 'utf8')
  await exec('git', ['-C', workA, '-c', 'user.name=test', '-c', 'user.email=test@localhost', 'add', '-A'])
  await exec('git', [
    '-C',
    workA,
    '-c',
    'user.name=test',
    '-c',
    'user.email=test@localhost',
    'commit',
    '--quiet',
    '--no-gpg-sign',
    '-m',
    'local only commit',
  ])

  // getState 不联网：本地 origin/main 引用还停在 push 那一刻，看不到 B 刚推的提交。
  const stale = await serviceA.handleRpc({ action: 'getState' })
  assert.equal(stale.ok, true)
  assert.equal(stale.data.status.remotePending, 0, 'getState 不得自己 fetch（否则会看到 B 的新提交）')
  assert.equal(stale.data.status.conflict, false)

  // 测试里显式 fetch（模拟"用户点测试连接/预览"之后的本地引用更新）→ 再 getState 才看到分叉。
  await exec('git', ['-C', workA, 'fetch', '--quiet', 'origin', 'main'])
  const diverged = await serviceA.handleRpc({ action: 'getState' })
  assert.equal(diverged.ok, true)
  assert.equal(diverged.data.status.localPending, 1, JSON.stringify(diverged.data.status))
  assert.equal(diverged.data.status.remotePending, 1)
  assert.equal(diverged.data.status.conflict, true, '双方各有对方没有的提交 → 必须报冲突')
  assert.equal(diverged.data.status.lastSyncAt, FIXED_NOW, 'getState 不应改写 lastSyncAt')
})
