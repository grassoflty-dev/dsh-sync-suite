/**
 * P1-1 回归：getState 只读本地、reachable 三态、网络动作显式化。
 *
 * 覆盖：
 *   1. 未 clone 时 getState 不联网：reachable=null、pending=null、无 error、不创建工作副本
 *      （即使 repoUrl 指向不存在的路径也不报 E_GIT）；
 *   2. testConnection 成功 → 探测结果持久化，新 service 实例的 getState 读到 reachable:true；
 *   3. testConnection 指向不存在路径 → reachable:false，且 getState 不再报错；
 *   4. 换仓库地址 → 旧探测结果作废，reachable 回到 null；
 *   5. 本地 ahead/behind：无 upstream → null；有 upstream 时用本地引用计算，
 *      getState 自身不 fetch（显式 fetch 之后才看到远端新提交）；
 *   6. lsRemote 等网络命令有超时上限，超时映射 E_GIT 且消息说明超时。
 *
 * 全部使用临时目录 + 本地裸仓库 / 本机回环 TCP，不依赖外部网络、不碰真实 profile。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { createRpcService } from '../dist/rpc.js'
import { GitRepo, NETWORK_TIMEOUT_MS } from '../dist/engine/git.js'
import { repoHash } from '../dist/engine/paths.js'

const exec = promisify(execFile)

const SETTINGS_BASE = {
  platform: 'custom',
  authMode: 'https',
  branch: 'main',
  scope: { config: true, providers: true, plugins: true, mcp: true },
}

const PATCH = `# profile patch
- id: alpha
  config:
    value: 1
`

async function makeWorld(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), options.prefix ?? 'gcs-state-'))
  t.after(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  })
  return { root }
}

async function makeService(t, root, name, options = {}) {
  const homeDir = path.join(root, `home-${name}`)
  const profileDir = path.join(root, `profile-${name}`)
  await mkdir(profileDir, { recursive: true })
  await writeFile(path.join(profileDir, 'cordis.patch.yml'), options.patch ?? PATCH, 'utf8')
  const service = createRpcService({
    homeDir,
    profileDir,
    dshVersion: 'test-1',
    allowLocalRepo: true,
    ...(options.networkTimeoutMs !== undefined ? { networkTimeoutMs: options.networkTimeoutMs } : {}),
  })
  t.after(async () => {
    await service.dispose()
  })
  return { homeDir, profileDir, service }
}

function workDirOf(homeDir, repoUrl) {
  return path.join(homeDir, '.dsh', 'dots', 'work', repoHash(repoUrl))
}

function stateFileOf(homeDir) {
  return path.join(homeDir, '.dsh', 'dots', 'state.json')
}

/* -------------------------------------------------------------------------- */
/* 1 + 2：未 clone 不联网；探测结果持久化                                      */
/* -------------------------------------------------------------------------- */

test('P1-1 getState 不联网：未 clone 时 reachable/pending 为 null、无 error、不创建工作副本', async (t) => {
  const { root } = await makeWorld(t)
  const bare = path.join(root, 'remote.git')
  await exec('git', ['init', '--bare', '-b', 'main', bare])
  const { homeDir, service } = await makeService(t, root, 'a')

  const saved = await service.handleRpc({
    action: 'saveSettings',
    settings: { ...SETTINGS_BASE, repoUrl: bare, deviceId: 'pc-a' },
  })
  assert.equal(saved.ok, true, JSON.stringify(saved))
  const stateBefore = await readFile(stateFileOf(homeDir), 'utf8')

  const state = await service.handleRpc({ action: 'getState' })
  assert.equal(state.ok, true, 'getState 必须成功（不得因未探测/未 clone 失败）')
  const status = state.data.status
  assert.equal(status.reachable, null, '从未探测 → reachable 必须是 null（不是 false）')
  assert.equal(status.branch, 'main', '未 clone 时 branch 用 settings.branch')
  assert.equal(status.headSha, '')
  assert.equal(status.localPending, null, '没有 upstream 引用 → localPending 为 null，不 fetch')
  assert.equal(status.remotePending, null, '没有 upstream 引用 → remotePending 为 null，不 fetch')
  assert.equal(status.conflict, false)
  assert.equal(status.lastSyncAt, null)
  assert.equal(status.error, undefined, '未探测/未 clone 不是错误（不得出现 E_GIT）')
  assert.equal(existsSync(workDirOf(homeDir, bare)), false, 'getState 不得 clone/创建工作副本')
  // getState 只读：状态文件内容（saveSettings 写的 reachable:null）一字不变。
  assert.equal(await readFile(stateFileOf(homeDir), 'utf8'), stateBefore, '只读的 getState 不得改写状态文件')
})

test('P1-1 getState 指向不存在的远端也不报错（离线不当作错误）', async (t) => {
  const { root } = await makeWorld(t)
  const missing = path.join(root, 'does-not-exist.git')
  const { service } = await makeService(t, root, 'a')
  await service.handleRpc({
    action: 'saveSettings',
    settings: { ...SETTINGS_BASE, repoUrl: missing, deviceId: 'pc-a' },
  })

  const state = await service.handleRpc({ action: 'getState' })
  assert.equal(state.ok, true)
  assert.equal(state.data.status.reachable, null)
  assert.equal(state.data.status.error, undefined)
  assert.equal(JSON.stringify(state).includes('E_GIT'), false, '响应里不得出现 E_GIT')
})

test('P1-1 testConnection 成功 → reachable 持久化为 true（新 service 实例可读）', async (t) => {
  const { root } = await makeWorld(t)
  const bare = path.join(root, 'remote.git')
  await exec('git', ['init', '--bare', '-b', 'main', bare])
  const { homeDir, service } = await makeService(t, root, 'a')
  await service.handleRpc({
    action: 'saveSettings',
    settings: { ...SETTINGS_BASE, repoUrl: bare, deviceId: 'pc-a' },
  })

  const before = await service.handleRpc({ action: 'getState' })
  assert.equal(before.data.status.reachable, null, '探测前是 null')

  const conn = await service.handleRpc({ action: 'testConnection' })
  assert.equal(conn.ok, true, JSON.stringify(conn))
  assert.equal(conn.data.reachable, true)

  const after = await service.handleRpc({ action: 'getState' })
  assert.equal(after.data.status.reachable, true, '同一实例回读状态文件')
  assert.equal(existsSync(workDirOf(homeDir, bare)), false, 'testConnection 只 ls-remote，不 clone')

  // 新实例（新进程语义）同样能读到持久化的探测结果
  const fresh = createRpcService({ homeDir, profileDir: path.join(root, 'profile-a'), dshVersion: 'test-1', allowLocalRepo: true })
  t.after(async () => {
    await fresh.dispose()
  })
  const freshState = await fresh.handleRpc({ action: 'getState' })
  assert.equal(freshState.data.status.reachable, true, '探测结果必须持久化（新 service 实例可读）')
})

test('P1-1 testConnection 失败 → reachable 变 false，且 getState 不再报错', async (t) => {
  const { root } = await makeWorld(t)
  const missing = path.join(root, 'nope.git')
  const { service } = await makeService(t, root, 'a')
  await service.handleRpc({
    action: 'saveSettings',
    settings: { ...SETTINGS_BASE, repoUrl: missing, deviceId: 'pc-a' },
  })

  const conn = await service.handleRpc({ action: 'testConnection' })
  assert.equal(conn.ok, false, '不可达时 testConnection 仍要报错（显式网络动作）')
  assert.ok(['E_GIT', 'E_AUTH'].includes(conn.error.code), JSON.stringify(conn.error))

  const state = await service.handleRpc({ action: 'getState' })
  assert.equal(state.ok, true)
  assert.equal(state.data.status.reachable, false, '网络失败的探测结果持久化为 false')
  assert.equal(state.data.status.error, undefined, '不可达不是 getState 的本地错误')
})

test('P1-1 换仓库地址 → 旧探测结果作废（reachable 回到 null）', async (t) => {
  const { root } = await makeWorld(t)
  const bare = path.join(root, 'remote.git')
  await exec('git', ['init', '--bare', '-b', 'main', bare])
  const other = path.join(root, 'other.git')
  await exec('git', ['init', '--bare', '-b', 'main', other])
  const { service } = await makeService(t, root, 'a')
  await service.handleRpc({
    action: 'saveSettings',
    settings: { ...SETTINGS_BASE, repoUrl: bare, deviceId: 'pc-a' },
  })
  assert.equal((await service.handleRpc({ action: 'testConnection' })).ok, true)
  assert.equal((await service.handleRpc({ action: 'getState' })).data.status.reachable, true)

  await service.handleRpc({
    action: 'saveSettings',
    settings: { ...SETTINGS_BASE, repoUrl: other, deviceId: 'pc-a' },
  })
  const state = await service.handleRpc({ action: 'getState' })
  assert.equal(state.data.status.reachable, null, '换了仓库地址 → 上次探测结果不再代表当前目标')
})

/* -------------------------------------------------------------------------- */
/* 5：本地 ahead/behind 计算（不 fetch）                                       */
/* -------------------------------------------------------------------------- */

test('P1-1 ahead/behind：无 upstream → null；getState 不 fetch，显式 fetch 后才看到远端提交', async (t) => {
  const { root } = await makeWorld(t)
  const bare = path.join(root, 'remote.git')
  await exec('git', ['init', '--bare', '-b', 'main', bare])

  const a = await makeService(t, root, 'a')
  const b = await makeService(t, root, 'b', { patch: '# 设备 B\n- id: beta\n  config:\n    value: 2\n' })

  await a.service.handleRpc({
    action: 'saveSettings',
    settings: { ...SETTINGS_BASE, repoUrl: bare, deviceId: 'pc-a' },
  })
  const pushA = await a.service.handleRpc({ action: 'push' })
  assert.equal(pushA.ok, true, JSON.stringify(pushA))

  await b.service.handleRpc({
    action: 'saveSettings',
    settings: { ...SETTINGS_BASE, repoUrl: bare, deviceId: 'pc-b' },
  })
  const beforeClone = await b.service.handleRpc({ action: 'getState' })
  assert.equal(beforeClone.data.status.remotePending, null, '未 clone → 没有 origin/main 引用 → null')
  assert.equal(beforeClone.data.status.localPending, null)

  // preview 是显式网络动作：clone + fetch，之后才有 upstream 引用
  const previewB = await b.service.handleRpc({ action: 'preview' })
  assert.equal(previewB.ok, true, JSON.stringify(previewB))
  const afterPreview = await b.service.handleRpc({ action: 'getState' })
  assert.equal(afterPreview.data.status.reachable, true, 'preview 成功也记一次探测 true')
  assert.equal(afterPreview.data.status.localPending, 0)
  assert.equal(afterPreview.data.status.remotePending, 0)
  assert.equal(afterPreview.data.status.conflict, false)

  // A 再推一次 → B 的本地 origin/main 引用陈旧；getState 不得自己 fetch
  await writeFile(path.join(a.profileDir, 'cordis.patch.yml'), `${PATCH}- id: alpha-2\n  config:\n    value: 2\n`, 'utf8')
  const pushA2 = await a.service.handleRpc({ action: 'push' })
  assert.equal(pushA2.ok, true, JSON.stringify(pushA2))

  const stale = await b.service.handleRpc({ action: 'getState' })
  assert.equal(stale.data.status.remotePending, 0, 'getState 不联网：仍看不到 A 的新提交')
  assert.equal(stale.data.status.conflict, false)

  // 测试里显式 fetch（等价于用户点测试连接/预览后的引用更新）→ 才看到落后 1 个提交
  await exec('git', ['-C', workDirOf(b.homeDir, bare), 'fetch', '--quiet', 'origin', 'main'])
  const fresh = await b.service.handleRpc({ action: 'getState' })
  assert.equal(fresh.data.status.localPending, 0)
  assert.equal(fresh.data.status.remotePending, 1, '显式 fetch 后 remotePending 必须是 1')
  assert.equal(fresh.data.status.conflict, false, '只落后不是冲突')
})

test('P1-1 远端整体消失后 getState 仍只读本地成功；此时 push 才把 reachable 记成 false', async (t) => {
  const { root } = await makeWorld(t)
  const bare = path.join(root, 'remote.git')
  const moved = path.join(root, 'remote-moved.git')
  await exec('git', ['init', '--bare', '-b', 'main', bare])

  const a = await makeService(t, root, 'a')
  const b = await makeService(t, root, 'b', { patch: '# 设备 B\n- id: beta\n  config:\n    value: 2\n' })
  await a.service.handleRpc({
    action: 'saveSettings',
    settings: { ...SETTINGS_BASE, repoUrl: bare, deviceId: 'pc-a' },
  })
  assert.equal((await a.service.handleRpc({ action: 'push' })).ok, true)
  await b.service.handleRpc({
    action: 'saveSettings',
    settings: { ...SETTINGS_BASE, repoUrl: bare, deviceId: 'pc-b' },
  })
  assert.equal((await b.service.handleRpc({ action: 'preview' })).ok, true)
  const workB = workDirOf(b.homeDir, bare)
  assert.equal(existsSync(path.join(workB, '.git')), true, 'preview 之后应有工作副本')

  // 远端整个消失（模拟断网/仓库被删）：getState 只读本地，必须照常成功且不报错。
  await rename(bare, moved)
  const offline = await b.service.handleRpc({ action: 'getState' })
  assert.equal(offline.ok, true, 'getState 不得联网，因此远端消失也不影响')
  assert.match(offline.data.status.headSha, /^[0-9a-f]{40}$/, '本地 HEAD 仍可读')
  assert.equal(offline.data.status.localPending, 0)
  assert.equal(offline.data.status.remotePending, 0, '仍是本地 origin/main 引用的陈旧值')
  assert.equal(offline.data.status.reachable, true, '最近一次探测（preview）成功仍为 true')
  assert.equal(offline.data.status.error, undefined, '远端不可达不是 getState 的错误')

  // 显式网络动作 push 失败 → 探测结果变 false，但 getState 依旧不报错。
  const pushB = await b.service.handleRpc({ action: 'push' })
  assert.equal(pushB.ok, false, 'push 必须报告真实失败')
  assert.ok(['E_GIT', 'E_AUTH'].includes(pushB.error.code), JSON.stringify(pushB.error))
  const afterFailedPush = await b.service.handleRpc({ action: 'getState' })
  assert.equal(afterFailedPush.ok, true)
  assert.equal(afterFailedPush.data.status.reachable, false, 'push 的网络失败要写进状态文件')
  assert.equal(afterFailedPush.data.status.error, undefined)
})

/* -------------------------------------------------------------------------- */
/* 6：网络命令超时                                                             */
/* -------------------------------------------------------------------------- */
test('P1-1 lsRemote 超时 → E_GIT（消息说明超时），网络命令有 ≤8s 上限', async (t) => {
  assert.equal(NETWORK_TIMEOUT_MS, 8000, '网络命令单次超时上限必须是 8s')

  // 本机回环 TCP 服务：接受连接但永不响应，让 git 的 HTTP 传输卡住。
  const sockets = new Set()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => sockets.delete(socket))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const root = await mkdtemp(path.join(tmpdir(), 'gcs-timeout-'))
  t.after(async () => {
    for (const socket of sockets) {
      try {
        socket.destroy()
      } catch {
        /* 清理失败不影响断言 */
      }
    }
    await new Promise((resolve) => server.close(resolve))
    await rm(root, { recursive: true, force: true }).catch(() => {})
  })

  const repo = new GitRepo({
    dir: path.join(root, 'work'),
    // https 是允许的仓库协议；本机回环服务只 accept 不响应 TLS 握手 → git 卡在传输层等超时。
    repoUrl: `https://127.0.0.1:${port}/repo.git`,
    branch: 'main',
    authMode: 'ssh',
    networkTimeoutMs: 400,
  })
  const started = Date.now()
  await assert.rejects(
    () => repo.lsRemote(),
    (error) => {
      assert.equal(error.code, 'E_GIT', `超时必须映射 E_GIT，实际：${JSON.stringify(error)}`)
      assert.match(error.message, /超时/)
      assert.equal(error.details.network, true, 'details.network 让调用方能记 reachable:false')
      return true
    },
  )
  assert.ok(Date.now() - started < 6000, '超时必须真的打断命令，不能一直挂着')
  await repo.dispose()
})
