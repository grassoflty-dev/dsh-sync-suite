import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { createRpcService } from '../dist/rpc.js'
import { parsePatch } from '../dist/engine/patch.js'

const exec = promisify(execFile)

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

const PATCH_A = `# 设备 A profile patch
- id: webserver
  config:
    host: '0.0.0.0'
    port: 3080

- id: alpha
  config:
    value: from-a
`

const PATCH_B = `# 设备 B profile patch（本地注释必须保留）
- id: webserver
  config:
    host: '127.0.0.1'
    port: 3080

- id: alpha
  config:
    value: from-b

- id: b-only
  config:
    keep: me
`

async function setupWorld(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'gcs-sha-'))
  const bare = path.join(root, 'remote.git')
  await exec('git', ['init', '--bare', '-b', 'main', bare])

  const homeA = path.join(root, 'home-a')
  const homeB = path.join(root, 'home-b')
  const profileA = path.join(root, 'profile-a')
  const profileB = path.join(root, 'profile-b')
  await mkdir(profileA, { recursive: true })
  await mkdir(profileB, { recursive: true })
  await writeFile(path.join(profileA, 'cordis.patch.yml'), PATCH_A, 'utf8')
  await writeFile(path.join(profileB, 'cordis.patch.yml'), PATCH_B, 'utf8')

  const settings = {
    repoUrl: bare,
    platform: 'custom',
    authMode: 'https',
    deviceId: 'pc-a',
    branch: 'main',
    scope: { config: true, providers: true, plugins: true, mcp: true },
  }

  const serviceA = createRpcService({ homeDir: homeA, profileDir: profileA, dshVersion: 'test-1', allowLocalRepo: true })
  t.after(async () => {
    await serviceA.dispose()
  })
  const saved = await serviceA.handleRpc({ action: 'saveSettings', settings })
  assert.equal(saved.ok, true)
  const pushed = await serviceA.handleRpc({ action: 'push' })
  assert.equal(pushed.ok, true, JSON.stringify(pushed))

  return { root, bare, homeA, homeB, profileA, profileB, settings, serviceA }
}

test('apply：写后 SHA-256 校验失败 → 文件回滚为快照原文 + E_SHA_MISMATCH', async (t) => {
  const world = await setupWorld(t)
  const patchFileB = path.join(world.profileB, 'cordis.patch.yml')
  const bytesBefore = await readFile(patchFileB)
  const originalText = bytesBefore.toString('utf8')

  let verifyCalls = 0
  const serviceB = createRpcService({
    homeDir: world.homeB,
    profileDir: world.profileB,
    dshVersion: 'test-1',
    allowLocalRepo: true,
    hooks: {
      verifySha256: async () => {
        verifyCalls += 1
        return false
      },
    },
  })
  t.after(async () => {
    await serviceB.dispose()
    await rm(world.root, { recursive: true, force: true }).catch(() => {})
  })

  const savedB = await serviceB.handleRpc({ action: 'saveSettings', settings: { ...world.settings, deviceId: 'pc-b' } })
  assert.equal(savedB.ok, true)

  const preview = await serviceB.handleRpc({ action: 'preview' })
  assert.equal(preview.ok, true, JSON.stringify(preview))
  assert.equal(preview.data.sources.length, 1)
  const source = preview.data.sources[0]
  assert.equal(source.deviceId, 'pc-a')
  const changed = source.entries.filter((entry) => entry.status === 'changed').map((entry) => entry.id)
  assert.ok(changed.includes('webserver'), `期待 webserver 为 changed，实际 ${JSON.stringify(changed)}`)
  assert.ok(changed.includes('alpha'))

  const applied = await serviceB.handleRpc({
    action: 'apply',
    confirm: true,
    previewId: preview.data.previewId,
    sourceDevice: 'pc-a',
    entries: ['webserver'],
  })
  assert.equal(applied.ok, false, '校验失败必须报错，不能静默成功')
  assert.equal(applied.error.code, 'E_SHA_MISMATCH')
  assert.ok(verifyCalls >= 1, '必须调用注入的 verifySha256')
  assert.ok(applied.error.details.snapshotId, '错误里要带写前快照 id，便于人工回滚')

  const after = await readFile(patchFileB)
  assert.deepEqual(after, bytesBefore, '文件必须回滚为写前原文（字节一致）')
  assert.equal(after.toString('utf8'), originalText)
  assert.ok(after.toString('utf8').includes('# 设备 B profile patch（本地注释必须保留）'))

  // 插件计划应在校验通过后才落盘；校验失败时不得写 pendingFile。
  const pendingFile = path.join(world.homeB, '.dsh', 'git-config-sync', 'plugins.to-install.json')
  assert.equal(existsSync(pendingFile), false, '校验失败不应写插件安装计划')

  // 写前快照存在，且内容就是原始字节。
  const list = await serviceB.handleRpc({ action: 'listSnapshots' })
  assert.equal(list.ok, true)
  assert.equal(list.data.snapshots.length, 1)
  const snapshotId = list.data.snapshots[0].id
  assert.equal(snapshotId, applied.error.details.snapshotId)
  assert.match(list.data.snapshots[0].reason, /^pre-apply:pc-a$/)
  const snapshotFile = path.join(world.homeB, '.dsh', 'vet', 'restore-snapshots', snapshotId, 'files', 'cordis.patch.yml')
  const snapshotBytes = await readFile(snapshotFile)
  assert.deepEqual(snapshotBytes, bytesBefore, '快照必须保存写前原文')
})

test('apply：校验通过时正常写入，且写前快照可用于 rollback 还原字节', async (t) => {
  const world = await setupWorld(t)
  const patchFileB = path.join(world.profileB, 'cordis.patch.yml')
  const bytesBefore = await readFile(patchFileB)

  const serviceB = createRpcService({
    homeDir: world.homeB,
    profileDir: world.profileB,
    dshVersion: 'test-1',
    allowLocalRepo: true,
  })
  t.after(async () => {
    await serviceB.dispose()
    await rm(world.root, { recursive: true, force: true }).catch(() => {})
  })
  await serviceB.handleRpc({ action: 'saveSettings', settings: { ...world.settings, deviceId: 'pc-b' } })
  const preview = await serviceB.handleRpc({ action: 'preview' })
  assert.equal(preview.ok, true)
  const previewId = preview.data.previewId

  const okApply = await serviceB.handleRpc({
    action: 'apply',
    confirm: true,
    previewId,
    sourceDevice: 'pc-a',
    entries: ['webserver', 'alpha'],
  })
  assert.equal(okApply.ok, true, JSON.stringify(okApply))
  assert.equal(okApply.data.verified, true)
  assert.deepEqual(
    okApply.data.applied.map((item) => item.id).sort(),
    ['alpha', 'webserver'],
  )
  for (const item of okApply.data.applied) {
    assert.match(item.fileSha256, /^[0-9a-f]{64}$/, 'fileSha256 必须是 64 位十六进制')
    assert.match(item.blockSha256, /^[0-9a-f]{64}$/, 'blockSha256 必须是 64 位十六进制')
    assert.equal(item.path, patchFileB)
    assert.equal('sha256' in item, false, '不得保留语义误导的 sha256 字段')
  }
  const changedText = await readFile(patchFileB, 'utf8')
  // 同一文件的多条 applied：fileSha256 相同（就是落盘文件校验和），blockSha256 不同。
  const fileShas = new Set(okApply.data.applied.map((item) => item.fileSha256))
  assert.equal(fileShas.size, 1, '同一文件的 applied 必须共享同一个 fileSha256')
  assert.equal([...fileShas][0], sha256(changedText), 'fileSha256 必须等于写后 profile patch 整文件 SHA-256')
  const blockShas = new Set(okApply.data.applied.map((item) => item.blockSha256))
  assert.equal(blockShas.size, 2, '不同条目的 blockSha256 必须不同')
  const appliedDoc = parsePatch(changedText)
  for (const item of okApply.data.applied) {
    const entry = appliedDoc.entries.find((candidate) => candidate.key === item.id)
    assert.ok(entry !== undefined, `写后文件里应有条目 ${item.id}`)
    assert.equal(item.blockSha256, sha256(entry.raw), `blockSha256 必须等于条目 ${item.id} 合并后文本的 SHA-256`)
  }
  assert.ok(changedText.includes("    host: '0.0.0.0'"), 'webserver 采纳远端')
  assert.ok(changedText.includes('value: from-a'), 'alpha 采纳远端')
  assert.ok(changedText.includes('- id: b-only'), '本地独有保留')
  assert.ok(changedText.includes('# 设备 B profile patch（本地注释必须保留）'))

  const rollback = await serviceB.handleRpc({
    action: 'rollback',
    confirm: true,
    snapshotId: okApply.data.snapshotId,
  })
  assert.equal(rollback.ok, true, JSON.stringify(rollback))
  assert.equal(rollback.data.verified, true)
  assert.deepEqual(await readFile(patchFileB), bytesBefore, 'rollback 必须逐字节还原')

  // 不存在的快照 → E_NOT_FOUND，且不写文件
  const afterRollbackBytes = await readFile(patchFileB)
  const missing = await serviceB.handleRpc({ action: 'rollback', confirm: true, snapshotId: '20200101-000000' })
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'E_NOT_FOUND')
  assert.deepEqual(await readFile(patchFileB), afterRollbackBytes)
})

test('testConnection：不可达仓库 → E_GIT / reachable 三态（不依赖网络）', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gcs-unreachable-'))
  const homeDir = path.join(root, 'home')
  const profileDir = path.join(root, 'profile')
  await mkdir(profileDir, { recursive: true })
  await writeFile(path.join(profileDir, 'cordis.patch.yml'), '- id: a\n  config: {}\n', 'utf8')
  const service = createRpcService({ homeDir, profileDir, dshVersion: 'test-1', allowLocalRepo: true })
  t.after(async () => {
    await service.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  })
  const settings = {
    repoUrl: path.join(root, 'does-not-exist.git'),
    platform: 'custom',
    authMode: 'https',
    deviceId: 'pc-a',
    branch: 'main',
    scope: { config: true, providers: true, plugins: true, mcp: true },
  }
  assert.equal((await service.handleRpc({ action: 'saveSettings', settings })).ok, true)
  const conn = await service.handleRpc({ action: 'testConnection' })
  assert.equal(conn.ok, false)
  assert.ok(['E_GIT', 'E_AUTH'].includes(conn.error.code), JSON.stringify(conn.error))

  const state = await service.handleRpc({ action: 'getState' })
  assert.equal(state.ok, true, 'getState 不因仓库不可达而整体失败')
  assert.equal(state.data.status.reachable, false, 'testConnection 网络失败后 reachable 持久化为 false')
  assert.equal(state.data.status.error, undefined, '不可达只是"最近探测失败"，不是 getState 的本地错误')
  assert.equal(state.data.status.headSha, '', '没有工作副本就没有本地 HEAD')
})
