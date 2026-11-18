import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  SECRET_PLACEHOLDER,
  collectLocalSecrets,
  containsSecretValue,
  restorePatchSecrets,
  restoreSecretsDeep,
  stripPatchSecrets,
  stripSecretsDeep,
} from '../dist/engine/secrets.js'
import { collectLocal } from '../dist/engine/collect.js'
import { createRpcService } from '../dist/rpc.js'
import { repoHash } from '../dist/engine/paths.js'

const exec = promisify(execFile)
const TOKEN = 'test-token-not-real'

test('stripSecretsDeep / restoreSecretsDeep：递归脱敏与回填', () => {
  const local = {
    providers: {
      'opencode-go': { apiKey: 'sk-real-1', name: 'opencode', nested: { password: 'p@ss', ok: 1 } },
      safe: { name: 'plain' },
    },
    list: [{ token: 'tok-2', label: 'x' }],
    authorization: 'Bearer abc',
    keep: 'visible',
    empty: { token: '' },
  }
  const stripped = stripSecretsDeep(local)
  const value = stripped.value
  assert.equal(value.providers['opencode-go'].apiKey, SECRET_PLACEHOLDER)
  assert.equal(value.providers['opencode-go'].nested.password, SECRET_PLACEHOLDER)
  assert.equal(value.providers['opencode-go'].name, 'opencode')
  assert.equal(value.providers.safe.name, 'plain')
  assert.equal(value.list[0].token, SECRET_PLACEHOLDER)
  assert.equal(value.list[0].label, 'x')
  assert.equal(value.authorization, SECRET_PLACEHOLDER)
  assert.equal(value.keep, 'visible')
  assert.equal(value.empty.token, '')
  assert.deepEqual(stripped.paths.sort(), [
    'authorization',
    'list[0].token',
    'providers.opencode-go.apiKey',
    'providers.opencode-go.nested.password',
  ])

  const restored = restoreSecretsDeep(value, local)
  assert.deepEqual(restored.needsLocal, [])
  assert.equal(restored.value.providers['opencode-go'].apiKey, 'sk-real-1')
  assert.equal(restored.value.providers['opencode-go'].nested.password, 'p@ss')
  assert.equal(restored.value.list[0].token, 'tok-2')

  const missing = restoreSecretsDeep(value, { keep: 'visible' })
  assert.ok(missing.needsLocal.includes('providers.opencode-go.apiKey'))
  assert.ok(missing.needsLocal.includes('list[0].token'))
  assert.equal(missing.value.providers['opencode-go'].apiKey, SECRET_PLACEHOLDER)
})

test('stripPatchSecrets：逐行脱敏保留注释、引号与 !!js 结构', () => {
  const patch = `# 顶层注释不要动
- id: llm
  config:
    apiKey: sk-real-2   # 行内注释
    password: 'p@ss'
    authorization: Bearer xyz
    apiKeyEnv: OPENCODE_GO_API_KEY
    port: !!js ctx.webStartup.port ?? 3080
    model: deepseek-v4-pro
    inline: { token: abc, name: ok }
`
  const stripped = stripPatchSecrets(patch)
  assert.ok(stripped.stripped >= 4, `应至少替换 4 处，实际 ${stripped.stripped}`)
  assert.ok(stripped.text.includes('apiKey: __SECRET__   # 行内注释'), '保留行内注释与空白')
  assert.ok(stripped.text.includes("password: '__SECRET__'"), '保留引号风格')
  assert.ok(stripped.text.includes('port: !!js ctx.webStartup.port ?? 3080'), '非 secret 的 !!js 不动')
  assert.ok(stripped.text.includes('model: deepseek-v4-pro'))
  assert.ok(stripped.text.includes('# 顶层注释不要动'))
  assert.ok(!stripped.text.includes('sk-real-2'))
  assert.ok(!stripped.text.includes('Bearer xyz'))
  assert.ok(!stripped.text.includes('token: abc'))
  assert.ok(stripped.text.includes('inline: { token: __SECRET__, name: ok }'), 'flow map 内的 secret 也脱敏')

  const rawAgain = stripPatchSecrets(stripped.text)
  assert.equal(rawAgain.stripped, 0, '已脱敏的文本不应重复计数')
})

test('stripPatchSecrets / restorePatchSecrets：secret 块续行整体脱敏，回填不足则 needsLocal', () => {
  // 注意：`tokens`（复数）按 B2 的词边界规则不算密钥，这里用真正的密钥 key `password`。
  const patch = `- id: x
  config:
    password:
      first-token
      second-token
    other: 1
`
  const stripped = stripPatchSecrets(patch)
  assert.ok(!stripped.text.includes('first-token'))
  assert.ok(!stripped.text.includes('second-token'))
  assert.equal((stripped.text.match(/__SECRET__/g) ?? []).length, 2)

  const restored = restorePatchSecrets(stripped.text, patch)
  assert.deepEqual(restored.needsLocal, ['password'], '多行 secret 块无法可靠回填 → 必须 fail-closed')
  assert.ok(restored.text.includes('__SECRET__'), '占位符保留，绝不写入半截内容')
})

test('restorePatchSecrets：本地同 key 值回填并保留远端注释与引号', () => {
  const local = `- id: llm
  config:
    apiKey: sk-local-9   # 本地注释
    token: "quoted-local"
    name: local-name
`
  const remote = `- id: llm
  config:
    apiKey: __SECRET__   # 远端注释
    token: '__SECRET__'
    name: remote-name
`
  const restored = restorePatchSecrets(remote, local)
  assert.deepEqual(restored.needsLocal, [])
  assert.ok(restored.text.includes('apiKey: sk-local-9   # 远端注释'), '用本地值回填但保留远端注释')
  assert.ok(restored.text.includes('token: \'quoted-local\''), '按远端引号风格回填')
  assert.ok(restored.text.includes('name: remote-name'), '非 secret 字段保持远端值')

  const missing = restorePatchSecrets(remote, '- id: llm\n  config:\n    name: only-name\n')
  assert.deepEqual(missing.needsLocal.sort(), ['apiKey', 'token'])
  assert.ok(missing.text.includes('__SECRET__'))
})

test('collectLocalSecrets / containsSecretValue 基础语义', () => {
  const secrets = collectLocalSecrets(`a:\n  token: v1\n  password: v2\n  note: n\n  api_key: v3\n`)
  assert.deepEqual(
    secrets.map((item) => item.key),
    ['token', 'password', 'api_key'],
  )
  assert.equal(containsSecretValue('x test-token-not-real y', TOKEN), true)
  assert.equal(containsSecretValue('nothing', TOKEN), false)
  assert.equal(containsSecretValue('x', null), false)
})

test('collectLocal：脱敏后的 patch 与 providers 不含任何 token 明文', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gcs-secret-collect-'))
  t.after(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  })
  const profileDir = path.join(root, 'profile')
  await mkdir(profileDir, { recursive: true })
  const patch = `# profile 头
- id: llm-pi-ai
  config:
    providers:
      opencode-go:
        apiKey: ${TOKEN}
        baseUrl: https://example.invalid/v1
- id: mcp-demo
  name: mcp-demo
  config:
    token: ${TOKEN}
`
  await writeFile(path.join(profileDir, 'cordis.patch.yml'), patch, 'utf8')

  const collected = collectLocal({
    profileDir,
    deviceId: 'pc-a',
    scopes: { config: true, providers: true, plugins: true, mcp: true },
    dshVersion: 'test-1',
  })
  for (const [name, content] of Object.entries(collected.files)) {
    assert.ok(!content.includes(TOKEN), `${name} 不得包含 token 明文`)
  }
  assert.ok(collected.files['cordis.patch.yml'].includes(SECRET_PLACEHOLDER))
  assert.ok(collected.files['providers.json'].includes(SECRET_PLACEHOLDER))
  assert.ok(collected.files['providers.json'].includes('opencode-go'))
  assert.ok(collected.files['mcp.json'].includes('mcp-demo'))
  assert.equal(collected.manifest.files.length, 4)
  for (const file of collected.manifest.files) {
    assert.match(file.sha256, /^[0-9a-f]{64}$/)
    assert.ok(file.bytes > 0)
  }
})

test('push 载荷（真实 git 提交）里不出现 token 明文', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gcs-secret-push-'))
  t.after(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  })
  const bare = path.join(root, 'remote.git')
  await exec('git', ['init', '--bare', '-b', 'main', bare])

  const homeDir = path.join(root, 'home')
  const profileDir = path.join(root, 'profile')
  await mkdir(profileDir, { recursive: true })
  const patch = `# profile 头
- id: llm-pi-ai
  config:
    apiKey: ${TOKEN}   # 本地密钥
    providers:
      opencode-go:
        apiKey: ${TOKEN}
        models:
        - id: deepseek-v4-pro
          name: DeepSeek V4 Pro
- id: mcp-demo
  name: mcp-demo
  config:
    token: ${TOKEN}
`
  await writeFile(path.join(profileDir, 'cordis.patch.yml'), patch, 'utf8')
  await writeFile(
    path.join(profileDir, 'package.json'),
    JSON.stringify({ dependencies: { 'dsh-demo': '^1.0.0' } }, null, 2),
    'utf8',
  )

  const service = createRpcService({
    homeDir,
    profileDir,
    dshVersion: 'test-1',
    allowLocalRepo: true,
  })
  t.after(async () => {
    await service.dispose()
  })

  const settings = {
    repoUrl: bare,
    platform: 'custom',
    authMode: 'https',
    deviceId: 'pc-a',
    branch: 'main',
    scope: { config: true, providers: true, plugins: true, mcp: true },
  }
  const saved = await service.handleRpc({ action: 'saveSettings', settings, token: TOKEN })
  assert.equal(saved.ok, true)
  assert.equal(saved.data.hasToken, true)

  const pushed = await service.handleRpc({ action: 'push' })
  assert.equal(pushed.ok, true, JSON.stringify(pushed))
  assert.equal(pushed.data.pushed, true)
  assert.ok(!JSON.stringify(pushed).includes(TOKEN), 'push 响应不得回显 token')

  const files = ['cordis.patch.yml', 'providers.json', 'plugins.json', 'mcp.json', 'manifest.json']
  for (const name of files) {
    const shown = await exec('git', ['--git-dir', bare, 'show', `main:devices/pc-a/${name}`])
    assert.ok(!shown.stdout.includes(TOKEN), `远端 ${name} 不得包含 token 明文`)
  }
  const shownPatch = await exec('git', ['--git-dir', bare, 'show', 'main:devices/pc-a/cordis.patch.yml'])
  assert.ok(shownPatch.stdout.includes(SECRET_PLACEHOLDER), '远端 patch 应使用占位符')

  // 工作副本里也不应残留明文
  const workPatch = path.join(homeDir, '.dsh', 'dots', 'work', repoHash(bare), 'devices', 'pc-a', 'cordis.patch.yml')
  const workText = await readFile(workPatch, 'utf8')
  assert.ok(!workText.includes(TOKEN))
  assert.ok(workText.includes(SECRET_PLACEHOLDER))

  // 本地状态：token 只在 credentials.json，settings.json 不含
  const settingsText = await readFile(path.join(homeDir, '.dsh', 'dots', 'settings.json'), 'utf8')
  const credentialsText = await readFile(path.join(homeDir, '.dsh', 'dots', 'credentials.json'), 'utf8')
  assert.ok(!settingsText.includes(TOKEN))
  assert.ok(credentialsText.includes(TOKEN))

  // getState 不得回显 token
  const state = await service.handleRpc({ action: 'getState' })
  assert.equal(state.ok, true)
  assert.ok(!JSON.stringify(state).includes(TOKEN))
})
