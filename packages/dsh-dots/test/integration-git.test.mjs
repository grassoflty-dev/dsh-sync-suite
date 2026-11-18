import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { createRpcService } from '../dist/rpc.js'
import { parsePatch } from '../dist/engine/patch.js'

const exec = promisify(execFile)

const PATCH_A = `# 设备 A 的 profile patch
# 文件级注释（合并时必须保留本地这份）

# --- dsh-mobile-remote managed (auto-generated; do not edit) ---
- id: webserver
  config:
    host: '0.0.0.0'
    port: !!js ctx.webStartup.port ?? 3080
# --- end dsh-mobile-remote managed ---

- id: llm-pi-ai
  config:
    providers:
      opencode-go:
        models:
        - id: deepseek-v4-pro
          name: DeepSeek V4 Pro (New)

- insert:
    - id: dots
      name: 'dsh-dots'
`

const PATCH_B = `# 设备 B 的 profile patch
# 这份文件头注释不允许被远端覆盖

# --- dsh-mobile-remote managed (auto-generated; do not edit) ---
- id: webserver
  config:
    host: '127.0.0.1'
    port: 3080
# --- end dsh-mobile-remote managed ---

- id: llm-pi-ai
  config:
    providers:
      opencode-go:
        models:
        - id: deepseek-v4-pro
          name: DeepSeek V4 Pro (New)

- id: b-only
  config:
    keep: me
`

const SETTINGS_BASE = {
  platform: 'custom',
  authMode: 'https',
  branch: 'main',
  scope: { config: true, providers: true, plugins: true, mcp: true },
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

async function gitShow(bare, spec) {
  const { stdout } = await exec('git', ['--git-dir', bare, 'show', spec])
  return stdout
}

test('integration：真实 git 全链路 push → pull → preview → apply → rollback（+ 非快进 rebase）', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gcs-integration-'))
  const bare = path.join(root, 'remote.git')
  await exec('git', ['init', '--bare', '-b', 'main', bare])

  const homeA = path.join(root, 'home-a')
  const homeB = path.join(root, 'home-b')
  const profileA = path.join(root, 'profile-a')
  const profileB = path.join(root, 'profile-b')
  for (const dir of [profileA, profileB]) await mkdir(dir, { recursive: true })

  const patchFileA = path.join(profileA, 'cordis.patch.yml')
  const patchFileB = path.join(profileB, 'cordis.patch.yml')
  await writeFile(patchFileA, PATCH_A, 'utf8')
  await writeFile(patchFileB, PATCH_B, 'utf8')
  await writeFile(
    path.join(profileA, 'package.json'),
    JSON.stringify({ dependencies: { 'dsh-foo': '^1.2.3', 'dsh-shared': '^2.0.0' } }, null, 2),
    'utf8',
  )
  await writeFile(
    path.join(profileB, 'package.json'),
    JSON.stringify({ dependencies: { 'dsh-shared': '^2.0.0', 'dsh-bar': '^1.0.0' } }, null, 2),
    'utf8',
  )

  const serviceA = createRpcService({ homeDir: homeA, profileDir: profileA, dshVersion: 'test-1', allowLocalRepo: true })
  const serviceB = createRpcService({ homeDir: homeB, profileDir: profileB, dshVersion: 'test-1', allowLocalRepo: true })
  t.after(async () => {
    await serviceA.dispose()
    await serviceB.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  })

  // ---------- 设备 A：保存设置并推送首个快照 ----------
  const savedA = await serviceA.handleRpc({
    action: 'saveSettings',
    settings: { ...SETTINGS_BASE, repoUrl: bare, deviceId: 'pc-a' },
  })
  assert.equal(savedA.ok, true, JSON.stringify(savedA))
  assert.equal(savedA.data.settings.deviceId, 'pc-a')

  const pushA1 = await serviceA.handleRpc({ action: 'push' })
  assert.equal(pushA1.ok, true, JSON.stringify(pushA1))
  assert.equal(pushA1.data.pushed, true)
  assert.equal(pushA1.data.branch, 'main')
  assert.deepEqual(pushA1.data.files.sort(), ['cordis.patch.yml', 'manifest.json', 'mcp.json', 'plugins.json', 'providers.json'])
  assert.match(pushA1.data.commit, /^[0-9a-f]{40}$/)

  // 远端确实有 devices/pc-a/*，且 manifest 的 sha256 与内容一致
  const remotePatchA = await gitShow(bare, 'main:devices/pc-a/cordis.patch.yml')
  assert.ok(remotePatchA.includes('# 设备 A 的 profile patch'))
  assert.ok(remotePatchA.includes('!!js ctx.webStartup.port ?? 3080'), '远端快照保留 !!js')
  const remoteManifestA = JSON.parse(await gitShow(bare, 'main:devices/pc-a/manifest.json'))
  assert.equal(remoteManifestA.deviceId, 'pc-a')
  assert.equal(remoteManifestA.dshVersion, 'test-1')
  assert.equal(remoteManifestA.files.length, 4)
  for (const file of remoteManifestA.files) {
    const content = await gitShow(bare, `main:devices/pc-a/${file.name}`)
    assert.equal(file.sha256, sha256(content), `manifest sha 应与 ${file.name} 一致`)
  }

  // ---------- 设备 B：状态 / 连接测试 / 预览 ----------
  const savedB = await serviceB.handleRpc({
    action: 'saveSettings',
    settings: { ...SETTINGS_BASE, repoUrl: bare, deviceId: 'pc-b' },
  })
  assert.equal(savedB.ok, true)

  const testConn = await serviceB.handleRpc({ action: 'testConnection' })
  assert.equal(testConn.ok, true, JSON.stringify(testConn))
  assert.equal(testConn.data.reachable, true)
  assert.equal(testConn.data.branch, 'main')
  assert.equal(testConn.data.headSha, pushA1.data.commit)

  const stateB = await serviceB.handleRpc({ action: 'getState' })
  assert.equal(stateB.ok, true)
  // testConnection 刚成功 → 状态文件记住 reachable:true，getState 只回读、不联网。
  assert.equal(stateB.data.status.reachable, true, 'testConnection 成功后 reachable 应为 true（持久化回读）')
  assert.equal(stateB.data.status.branch, 'main')
  // 还没有工作副本：无 origin/main 引用 → pending 为 null，且不报错（getState 绝不 clone）。
  assert.equal(stateB.data.status.localPending, null)
  assert.equal(stateB.data.status.remotePending, null)
  assert.equal(stateB.data.status.conflict, false)
  assert.equal(stateB.data.status.error, undefined, '未 clone / 未探测不是错误')
  assert.equal(stateB.data.settings.hasToken, false)
  assert.deepEqual(stateB.data.snapshots, [])

  const previewB = await serviceB.handleRpc({ action: 'preview' })
  assert.equal(previewB.ok, true, JSON.stringify(previewB))
  assert.equal(previewB.data.sources.length, 1, '只应有远端设备 pc-a 一个来源')
  const sourceA = previewB.data.sources[0]
  assert.equal(sourceA.deviceId, 'pc-a')
  assert.equal(sourceA.headSha, pushA1.data.commit)

  // preview 已把工作副本 clone 下来并 fetch：此时才有 upstream 引用，pending 是数字。
  const stateBAfterPreview = await serviceB.handleRpc({ action: 'getState' })
  assert.equal(stateBAfterPreview.ok, true)
  assert.equal(stateBAfterPreview.data.status.localPending, 0)
  assert.equal(stateBAfterPreview.data.status.remotePending, 0)
  assert.match(stateBAfterPreview.data.status.headSha, /^[0-9a-f]{40}$/, 'clone+fetch 后应有本地 HEAD')
  const statusOf = Object.fromEntries(sourceA.entries.map((entry) => [entry.id, entry.status]))
  assert.equal(statusOf.webserver, 'changed')
  assert.equal(statusOf['llm-pi-ai'], 'same')
  assert.equal(statusOf['insert:dots'], 'added')
  assert.deepEqual(sourceA.localOnly.sort(), ['b-only'])
  assert.deepEqual(sourceA.plugins.install.map((item) => item.name), ['dsh-foo'])
  assert.deepEqual(sourceA.plugins.keep.map((item) => item.name).sort(), ['dsh-bar', 'dsh-shared'])
  assert.ok(sourceA.providers.same.includes('opencode-go'))

  // ---------- 设备 B：apply 勾选 webserver 一条 ----------
  const bytesBeforeB = await readFile(patchFileB)
  const beforeDoc = parsePatch(bytesBeforeB.toString('utf8'))

  const applyB = await serviceB.handleRpc({
    action: 'apply',
    confirm: true,
    previewId: previewB.data.previewId,
    sourceDevice: 'pc-a',
    entries: ['webserver'],
  })
  assert.equal(applyB.ok, true, JSON.stringify(applyB))
  assert.equal(applyB.data.verified, true)
  assert.deepEqual(applyB.data.applied.map((item) => item.id), ['webserver'])
  assert.equal(applyB.data.applied[0].path, pathFileResolved(patchFileB))
  // P1-2：applied 区分"写后整文件 SHA"与"该条目块 SHA"，旧的误导字段 sha256 已删除。
  assert.match(applyB.data.applied[0].fileSha256, /^[0-9a-f]{64}$/)
  assert.match(applyB.data.applied[0].blockSha256, /^[0-9a-f]{64}$/)
  assert.equal('sha256' in applyB.data.applied[0], false, 'applied[] 不得再有语义误导的 sha256 字段')

  const afterTextB = await readFile(patchFileB, 'utf8')
  const afterDoc = parsePatch(afterTextB)
  assert.equal(afterDoc.preamble.join('\n'), beforeDoc.preamble.join('\n'), '文件头注释必须逐字节保留')
  assert.ok(afterTextB.includes('# 这份文件头注释不允许被远端覆盖'))
  assert.ok(afterTextB.includes('# --- dsh-mobile-remote managed'), '条目前置注释保留')
  assert.ok(afterTextB.includes("    host: '0.0.0.0'"), 'webserver 采纳远端值')
  assert.ok(afterTextB.includes('!!js ctx.webStartup.port ?? 3080'), '采纳远端后 !!js 保留')

  // 只有 webserver 变了：逐条对比其它条目
  const beforeMap = new Map(beforeDoc.entries.map((entry) => [entry.key, entry.raw]))
  const afterMap = new Map(afterDoc.entries.map((entry) => [entry.key, entry.raw]))
  for (const key of beforeMap.keys()) {
    if (key === 'webserver') continue
    assert.equal(afterMap.get(key), beforeMap.get(key), `未勾选条目 ${key} 必须字节不变`)
  }
  assert.equal(afterMap.get('webserver'), parsePatch(PATCH_A).entries.find((e) => e.key === 'webserver').raw)
  assert.ok(!afterMap.has('insert:dots'), '未勾选的远端新增条目不写入')
  assert.ok(afterTextB.endsWith('\n') && !afterTextB.endsWith('\n\n'))

  // ---------- 设备 B：rollback 还原原始字节 ----------
  const snapshotsB = await serviceB.handleRpc({ action: 'listSnapshots' })
  assert.equal(snapshotsB.ok, true)
  assert.equal(snapshotsB.data.snapshots.length, 1)
  assert.equal(snapshotsB.data.snapshots[0].id, applyB.data.snapshotId)
  const rollbackB = await serviceB.handleRpc({
    action: 'rollback',
    confirm: true,
    snapshotId: applyB.data.snapshotId,
  })
  assert.equal(rollbackB.ok, true, JSON.stringify(rollbackB))
  assert.equal(rollbackB.data.verified, true)
  assert.deepEqual(await readFile(patchFileB), bytesBeforeB, 'rollback 必须逐字节还原')

  // ---------- 设备 B 推送自己的快照，随后 A 的推送必须走 rebase ----------
  const pushB = await serviceB.handleRpc({ action: 'push' })
  assert.equal(pushB.ok, true, JSON.stringify(pushB))
  assert.equal(pushB.data.pushed, true)
  const remotePatchB = await gitShow(bare, 'main:devices/pc-b/cordis.patch.yml')
  assert.ok(remotePatchB.includes('# 设备 B 的 profile patch'))

  // A 本地又改了一处配置
  await writeFile(patchFileA, PATCH_A.replace("    host: '0.0.0.0'", "    host: '0.0.0.0'\n    note: a-second-push"), 'utf8')
  const pushA2 = await serviceA.handleRpc({ action: 'push' })
  assert.equal(pushA2.ok, true, JSON.stringify(pushA2))
  assert.equal(pushA2.data.pushed, true)
  assert.equal(pushA2.data.rebased, true, '远端已被 B 推进，A 必须先 rebase 再 push')

  const log = await exec('git', ['--git-dir', bare, 'log', '--format=%H %s'])
  const logLines = log.stdout.trim().split('\n')
  assert.ok(logLines.length >= 3, `应有至少 3 个提交（B 的不能被覆盖），实际：\n${log.stdout}`)
  assert.ok(log.stdout.includes(pushB.data.commit), 'B 的提交必须仍在历史里（永不 force push）')
  const remoteHead = (await exec('git', ['--git-dir', bare, 'rev-parse', 'main'])).stdout.trim()
  assert.equal(remoteHead, pushA2.data.commit, 'A 的本地 HEAD 应等于远端 HEAD')

  const remotePatchA2 = await gitShow(bare, 'main:devices/pc-a/cordis.patch.yml')
  assert.ok(remotePatchA2.includes('note: a-second-push'))

  // A 的第二次快照仍保留 B 的设备目录
  const remoteTree = await exec('git', ['--git-dir', bare, 'ls-tree', '-r', '--name-only', 'main', '--', 'devices/'])
  for (const name of ['cordis.patch.yml', 'providers.json', 'plugins.json', 'mcp.json', 'manifest.json']) {
    assert.ok(remoteTree.stdout.includes(`devices/pc-a/${name}`), `远端缺少 devices/pc-a/${name}`)
    assert.ok(remoteTree.stdout.includes(`devices/pc-b/${name}`), `远端缺少 devices/pc-b/${name}`)
  }

  // 预览仍然只列对方设备（自己目录被排除）
  const previewAgain = await serviceA.handleRpc({ action: 'preview' })
  assert.equal(previewAgain.ok, true)
  assert.deepEqual(previewAgain.data.sources.map((item) => item.deviceId), ['pc-b'])
  assert.equal(previewAgain.data.sources[0].entries.find((entry) => entry.id === 'webserver').status, 'changed')
})

function pathFileResolved(file) {
  return path.resolve(file)
}
