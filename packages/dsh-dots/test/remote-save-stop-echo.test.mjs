/**
 * mod-plugin-dispose-hygiene-residuals / item 4：`saveSettings` 触发停止时的 `enabled` 回声。
 *
 * 探测到的矛盾（评审 §3.3 的旁支）：监听正在跑（落盘 `enabled:true`）→ 运维在设置里改
 * 「方式/端口/局域网地址」→ `saveSettings()` 先停掉旧监听（`running:false`），但那条路径
 * 刻意 `stopInternal(false)`，于是磁盘停在 `enabled:true`。文件读起来像"还开着"，与事实相反。
 *
 * 语义（本模块定案）：`enabled` 是**句柄回声**（"上一次读到的句柄是否存在"），不再是自动启动
 * 意图位——意图在 `autoStart`（`persistIntent`）。因此任何**真的摘掉了句柄**的停止都该把回声
 * 写成 false；唯一例外仍是 `dispose()`（进程退出不是一次操作，且对象会被丢弃）。写回声**不会**
 * 清掉落盘的 `autoStart`：旧的"不写"理由（怕改端口把自动启动偏好清掉）在意图搬家之后已不成立。
 *
 * 纪律：注入假监听，绝不开真实端口；只断言落盘文件与状态，不碰网络。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createRemoteService } from '../dist/remote/service.js'
import { RemoteStore } from '../dist/remote/store.js'
import { generatePairingCertificate } from '../dist/remote/pairingTls.js'

const LAN = '192.168.1.6'

async function makeHome(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'dsh-save-stop-echo-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  return home
}

async function startFakeDsh(t) {
  const server = http.createServer((req, res) => {
    res.writeHead(303, { location: './', 'set-cookie': 'dsh-auth-deadbeef=session-value; Path=/; HttpOnly' })
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(() => resolve())))
  return { server, port: server.address().port }
}

function fakeListener() {
  const calls = []
  const start = async (opts) => {
    calls.push(opts)
    return {
      address: opts.bindAddress,
      port: opts.port,
      close: async () => undefined,
      stats: () => ({ active: 0, total: 0, rejected: 0 }),
      lastError: null,
    }
  }
  return { start, calls }
}

function fakeGate() {
  return {
    exchange: () => ({ ok: true, setCookie: 'dsh-remote-session=abc; Path=/; HttpOnly', reason: '' }),
    valid: () => false,
    fail: () => ({ limited: false, retryAfterSec: 0 }),
    setToken: () => undefined,
  }
}

async function makeService(t) {
  const home = await makeHome(t)
  new RemoteStore({ homeDir: home }).writeCert(generatePairingCertificate())
  const fake = await startFakeDsh(t)
  const listener = fakeListener()
  const service = createRemoteService({
    homeDir: home,
    createGate: () => fakeGate(),
    startListener: listener.start,
    webServer: { port: fake.port },
    connection: { authenticatedUrl: (base) => `${base}?token=launch` },
    interfaces: () => [{ address: LAN, iface: 'WLAN', family: 'IPv4', virtual: false }],
    routeProbeAddress: () => LAN,
  })
  t.after(() => service.dispose())
  return { home, service, listener }
}

const configFile = (home) => path.join(home, '.dsh', 'dots', 'remote.json')
const readRaw = async (home) => JSON.parse(await readFile(configFile(home), 'utf8'))

test('SS-1 saveSettings 换方式停掉监听 ⇒ enabled 回声写成 false（磁盘不再与 running 相反），autoStart 不被清', async (t) => {
  const { home, service, listener } = await makeService(t)
  await service.saveSettings({ mode: 'lan', lanAddress: LAN, port: 0 })
  const started = await service.start()
  assert.equal(started.running, true, JSON.stringify(started.lastError))
  const before = await readRaw(home)
  assert.equal(before.enabled, true, '起成功后 enabled 必须是 true')
  assert.equal(before.autoStart, true, '手动启动先记意图：autoStart=true')

  // 运维在设置里换一种访问方式：旧监听被停掉（这是真发生的事实）。
  const saved = await service.saveSettings({ mode: 'manual', manualUrl: 'http://127.0.0.1:3080/' })
  assert.equal(saved.status.running, false, '换方式后旧监听必须停掉')
  assert.equal(saved.settings.accepting, false)

  const after = await readRaw(home)
  assert.equal(after.enabled, false, 'enabled 是句柄回声：句柄被摘掉后磁盘必须是 false（修前停在 true）')
  assert.equal(after.autoStart, true, '写回声不得清掉自动启动意图（意图在 autoStart，不在 enabled）')
  assert.equal((await service.getState()).settings.enabled, false)
  assert.equal((await service.getState()).status.running, false)
  assert.equal(listener.calls.length, 1, '换方式只停旧监听，不偷偷再起一个')
})
