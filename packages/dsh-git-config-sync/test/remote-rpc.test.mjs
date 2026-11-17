/**
 * 远程访问 RPC（`remote*` action）回归。
 *
 * 用**内存桩** `RemoteServiceLike` 注入 `createRpcService({ remote })`：
 *   1. 8 个 action 的 happy path 与返回形状（只断言契约字段，不依赖 remote 实现）；
 *   2. 未注入 remote → 每个 action 都 `E_INTERNAL`（fail-closed，不允许静默返回空）；
 *   3. 桩里抛错 → `{ok:false,error}`，SyncError 的 code/message 原样透出；
 *   4. `remoteShowLink` 是唯一允许带 token 明文的地方，其它返回体与错误体都不许出现；
 *   5. start/stop 走同一条串行队列（绝不并发）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRpcService } from '../dist/rpc.js'
import { SyncError } from '../dist/engine/errors.js'

const REMOTE_ACTIONS = [
  'remoteGetState',
  'remoteSaveSettings',
  'remoteStart',
  'remoteStop',
  'remoteRotateToken',
  'remoteProbe',
  'remoteShowLink',
  'remoteDetectLan',
]

/** 只出现在 RemoteLink.url 里的假 token（用来断言它不会从别的出口漏出去）。 */
const TOKEN_PLAIN = 'rt_plain_0123456789abcdef'

function modesFixture() {
  return [
    {
      mode: 'lan',
      label: '局域网',
      description: '同一 WiFi 直连',
      availability: 'ready',
      unavailableReason: '',
      requires: [],
      fields: [
        { key: 'lanAddress', label: '局域网地址', placeholder: '192.168.1.6', hint: '', required: false },
      ],
      steps: ['保存设置', '启动监听', '用平板扫码'],
      hostsListener: true,
    },
    {
      mode: 'tailscale',
      label: 'Tailscale',
      description: '走 tailnet',
      availability: 'needs-setup',
      unavailableReason: '',
      requires: ['安装 Tailscale 客户端'],
      fields: [
        { key: 'tailscaleHost', label: 'Tailscale 主机', placeholder: 'pc-a.ts.net', hint: '', required: true },
      ],
      steps: ['安装客户端', '登录账号'],
      hostsListener: true,
    },
    {
      mode: 'uu',
      label: '网易 UU',
      description: '',
      availability: 'unsupported',
      unavailableReason: 'UU 的远程端口不对第三方开放',
      requires: [],
      fields: [],
      steps: [],
      hostsListener: false,
    },
  ]
}

function settingsFixture(overrides) {
  return Object.assign(
    {
      enabled: true,
      mode: 'lan',
      port: 0,
      lanAddress: '192.168.1.6',
      tailscaleHost: '',
      cloudflareHost: '',
      ipv6Address: '',
      manualUrl: '',
    },
    overrides || {},
  )
}

function statusFixture(overrides) {
  return Object.assign(
    {
      running: false,
      listen: null,
      boundAddress: null,
      port: 3080,
      startedAt: null,
      lastError: null,
      connections: { active: 0, total: 0 },
      rejected: 0,
      token: { exists: true, masked: 'rt_••••••••', createdAt: '2026-01-01T00:00:00.000Z' },
      urls: [],
      probe: null,
    },
    overrides || {},
  )
}

function probeFixture(mode) {
  return {
    mode: mode || 'lan',
    level: 'warn',
    checks: [
      { id: 'bind', level: 'ok', message: '监听地址可用', hint: '' },
      { id: 'firewall', level: 'warn', message: '防火墙可能拦截', hint: '在 Windows 防火墙放行该端口' },
      { id: 'tls', level: 'fail', message: '未启用 TLS', hint: '' },
      { id: 'peer', level: 'unknown', message: '无法自证对端可达', hint: '' },
    ],
    verdict: '部分可用：本机能绑上，但对端未证实',
    at: '2026-01-01T00:00:00.000Z',
  }
}

function linkFixture(mode) {
  const size = 5
  const modules = []
  for (let y = 0; y < size; y += 1) {
    const row = []
    for (let x = 0; x < size; x += 1) row.push((x + y) % 2 === 0)
    modules.push(row)
  }
  return {
    url: `http://192.168.1.6:3080/?token=${TOKEN_PLAIN}&mode=${mode || 'lan'}`,
    qr: { size, modules },
    note: '',
  }
}

function lanFixture() {
  return [
    { address: '192.168.1.6', iface: 'WLAN', family: 'IPv4', virtual: false },
    { address: '172.17.0.1', iface: 'vEthernet (WSL)', family: 'IPv4', virtual: true },
  ]
}

/**
 * 内存桩：所有方法都记一条调用流水（`calls`），返回值来自 fixture。
 * `overrides` 用来把某个方法换成抛错/阻塞实现。
 */
function makeFakeRemote(overrides) {
  const calls = []
  const remote = {
    calls,
    async getState() {
      calls.push({ method: 'getState' })
      return { settings: settingsFixture(), status: statusFixture(), modes: modesFixture() }
    },
    async saveSettings(input) {
      calls.push({ method: 'saveSettings', input })
      const next = input && typeof input === 'object' ? input : {}
      return {
        settings: settingsFixture(next),
        status: statusFixture({ port: Number(next.port) || 0 }),
        modes: modesFixture(),
      }
    },
    async start() {
      calls.push({ method: 'start' })
      return statusFixture({
        running: true,
        listen: '192.168.1.6:3080',
        boundAddress: '192.168.1.6',
        startedAt: '2026-01-01T00:00:00.000Z',
      })
    },
    async stop() {
      calls.push({ method: 'stop' })
      return statusFixture({ running: false, listen: null, boundAddress: null })
    },
    async rotateToken() {
      calls.push({ method: 'rotateToken' })
      return statusFixture({
        running: true,
        listen: '192.168.1.6:3080',
        boundAddress: '192.168.1.6',
        token: { exists: true, masked: 'rt_••••••••NEW', createdAt: '2026-02-02T00:00:00.000Z' },
      })
    },
    async probe(mode) {
      calls.push({ method: 'probe', mode })
      return probeFixture(mode)
    },
    async showLink(mode) {
      calls.push({ method: 'showLink', mode })
      return linkFixture(mode)
    },
    detectLan() {
      calls.push({ method: 'detectLan' })
      return lanFixture()
    },
    async dispose() {
      calls.push({ method: 'dispose' })
    },
  }
  return Object.assign(remote, overrides || {})
}

async function setup(t, remote) {
  const homeDir = await mkdtemp(path.join(tmpdir(), 'gcs-remote-rpc-'))
  const service = createRpcService({
    homeDir,
    dshVersion: 'test-1',
    ...(remote === undefined ? {} : { remote }),
  })
  t.after(async () => {
    await service.dispose()
    await rm(homeDir, { recursive: true, force: true }).catch(() => {})
  })
  return service
}

/* -------------------------------------------------------------------------- */
/* 1) 未注入 remote：全部 fail-closed                                          */
/* -------------------------------------------------------------------------- */

test('未注入 remote：8 个 action 全部 E_INTERNAL（fail-closed，不静默返回空）', async (t) => {
  const service = await setup(t, undefined)
  for (const action of REMOTE_ACTIONS) {
    const result = await service.handleRpc({ action })
    assert.equal(result.ok, false, `${action} 必须失败`)
    assert.equal(result.error.code, 'E_INTERNAL', `${action} 必须 E_INTERNAL`)
    assert.match(result.error.message, /远程访问服务未挂载/, `${action} 必须说明服务未挂载`)
    assert.equal(result.data, undefined, `${action} 不得返回 data`)
  }
})

/* -------------------------------------------------------------------------- */
/* 2) happy path：8 个 action 的返回形状                                       */
/* -------------------------------------------------------------------------- */

test('remoteGetState：返回 settings/status/modes（RemoteStateData）', async (t) => {
  const remote = makeFakeRemote()
  const service = await setup(t, remote)
  const result = await service.handleRpc({ action: 'remoteGetState' })
  assert.equal(result.ok, true)
  assert.equal(result.data.settings.mode, 'lan')
  assert.equal(result.data.settings.port, 0)
  assert.equal(result.data.modes.length, 3)
  assert.equal(result.data.modes[2].mode, 'uu')
  assert.equal(result.data.modes[2].availability, 'unsupported')
  assert.equal(result.data.status.running, false)
  assert.deepEqual(
    remote.calls.map((c) => c.method),
    ['getState'],
    '只应调用一次 getState',
  )
})

test('remoteSaveSettings：只透传 payload.settings，返回 RemoteStateData', async (t) => {
  const remote = makeFakeRemote()
  const service = await setup(t, remote)
  const settings = settingsFixture({ enabled: true, mode: 'tailscale', port: 3081, tailscaleHost: 'pc-a.ts.net' })
  const result = await service.handleRpc({ action: 'remoteSaveSettings', settings })
  assert.equal(result.ok, true)
  const saved = remote.calls.filter((c) => c.method === 'saveSettings')
  assert.equal(saved.length, 1)
  assert.deepEqual(saved[0].input, settings, 'settings 必须原样透传给远程域')
  assert.equal(result.data.settings.mode, 'tailscale')
  assert.equal(result.data.settings.port, 3081)
  assert.ok(Array.isArray(result.data.modes))
})

test('remoteStart / remoteStop：返回 RemoteStatus，running 与 listen 互斥', async (t) => {
  const remote = makeFakeRemote()
  const service = await setup(t, remote)

  const started = await service.handleRpc({ action: 'remoteStart' })
  assert.equal(started.ok, true)
  assert.equal(started.data.running, true)
  assert.equal(started.data.listen, '192.168.1.6:3080')
  assert.equal(started.data.boundAddress, '192.168.1.6', '绑定地址必须是具体地址，不是通配')

  const stopped = await service.handleRpc({ action: 'remoteStop' })
  assert.equal(stopped.ok, true)
  assert.equal(stopped.data.running, false)
  assert.equal(stopped.data.listen, null)
  assert.equal(stopped.data.boundAddress, null)
  assert.deepEqual(
    remote.calls.map((c) => c.method),
    ['start', 'stop'],
  )
})

test('remoteRotateToken：只返回打码 token，返回体里没有明文', async (t) => {
  const remote = makeFakeRemote()
  const service = await setup(t, remote)
  const result = await service.handleRpc({ action: 'remoteRotateToken' })
  assert.equal(result.ok, true)
  assert.equal(result.data.running, true)
  assert.equal(result.data.token.exists, true)
  assert.match(result.data.token.masked, /•/)
  assert.equal(result.data.token.masked.includes(TOKEN_PLAIN), false)
  assert.equal(JSON.stringify(result.data).includes(TOKEN_PLAIN), false)
})

test('remoteProbe：把 payload.mode 下传，返回 4 种 level 的 checks', async (t) => {
  const remote = makeFakeRemote()
  const service = await setup(t, remote)
  const result = await service.handleRpc({ action: 'remoteProbe', mode: 'tailscale' })
  assert.equal(result.ok, true)
  assert.equal(result.data.mode, 'tailscale')
  assert.equal(result.data.checks.length, 4)
  assert.deepEqual(
    result.data.checks.map((c) => c.level),
    ['ok', 'warn', 'fail', 'unknown'],
  )
  const calls = remote.calls.filter((c) => c.method === 'probe')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].mode, 'tailscale', '合法 mode 必须原样下传')
})

test('remoteProbe：非法/缺失 mode 归一成 undefined（不猜成 lan）', async (t) => {
  const remote = makeFakeRemote()
  const service = await setup(t, remote)
  const bogus = await service.handleRpc({ action: 'remoteProbe', mode: 'bogus' })
  assert.equal(bogus.ok, true)
  const missing = await service.handleRpc({ action: 'remoteProbe' })
  assert.equal(missing.ok, true)
  const calls = remote.calls.filter((c) => c.method === 'probe')
  assert.equal(calls.length, 2)
  assert.equal(calls[0].mode, undefined)
  assert.equal(calls[1].mode, undefined)
})

test('remoteShowLink：唯一允许带 token 的出口（url），qr 矩阵形状正确', async (t) => {
  const remote = makeFakeRemote()
  const service = await setup(t, remote)
  const result = await service.handleRpc({ action: 'remoteShowLink', mode: 'lan' })
  assert.equal(result.ok, true)
  assert.equal(typeof result.data.url, 'string')
  assert.ok(result.data.url.includes(TOKEN_PLAIN), 'RemoteLink.url 是唯一允许带 token 的地方')
  assert.equal(result.data.qr.size, 5)
  assert.equal(result.data.qr.modules.length, result.data.qr.size)
  assert.equal(result.data.qr.modules[0].length, result.data.qr.size)
  const calls = remote.calls.filter((c) => c.method === 'showLink')
  assert.equal(calls[0].mode, 'lan')

  // 除了 url，返回体里任何字段都不许再出现明文 token。
  const withoutUrl = Object.assign({}, result.data, { url: '' })
  assert.equal(JSON.stringify(withoutUrl).includes(TOKEN_PLAIN), false)
})

test('remoteDetectLan：把同步方法包成 { candidates }', async (t) => {
  const remote = makeFakeRemote()
  const service = await setup(t, remote)
  const result = await service.handleRpc({ action: 'remoteDetectLan' })
  assert.equal(result.ok, true)
  assert.equal(result.data.candidates.length, 2)
  assert.equal(result.data.candidates[0].address, '192.168.1.6')
  assert.equal(result.data.candidates[0].virtual, false)
  assert.equal(result.data.candidates[1].virtual, true, '虚拟网卡必须被标记，自动挑选时跳过')
})

/* -------------------------------------------------------------------------- */
/* 3) 错误路径                                                                 */
/* -------------------------------------------------------------------------- */

test('桩里抛 SyncError → code/message 原样透出（不包一层）', async (t) => {
  const remote = makeFakeRemote({
    async start() {
      throw new SyncError('E_VALIDATION', '端口 3080 已被占用')
    },
  })
  const service = await setup(t, remote)
  const result = await service.handleRpc({ action: 'remoteStart' })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'E_VALIDATION')
  assert.equal(result.error.message, '端口 3080 已被占用')
  assert.equal(result.data, undefined)
})

test('桩里抛普通 Error → E_INTERNAL，且错误体里没有 token 明文', async (t) => {
  const remote = makeFakeRemote({
    async showLink() {
      throw new Error('boom')
    },
  })
  const service = await setup(t, remote)
  const result = await service.handleRpc({ action: 'remoteShowLink' })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'E_INTERNAL')
  assert.equal(result.error.message, 'boom')
  assert.equal(JSON.stringify(result.error).includes(TOKEN_PLAIN), false)
})

test('单个 action 失败不影响后续 action（队列不中毒）', async (t) => {
  let failNext = true
  const remote = makeFakeRemote({
    async probe(mode) {
      if (failNext) {
        failNext = false
        throw new SyncError('E_IO', '网卡枚举失败')
      }
      return probeFixture(mode)
    },
  })
  const service = await setup(t, remote)
  const failed = await service.handleRpc({ action: 'remoteProbe', mode: 'lan' })
  assert.equal(failed.ok, false)
  assert.equal(failed.error.code, 'E_IO')
  const ok = await service.handleRpc({ action: 'remoteProbe', mode: 'lan' })
  assert.equal(ok.ok, true)
  assert.equal(ok.data.level, 'warn')
})

/* -------------------------------------------------------------------------- */
/* 4) 串行队列                                                                 */
/* -------------------------------------------------------------------------- */

test('remoteStart / remoteStop 共用串行队列：stop 必须等 start 结束', async (t) => {
  const order = []
  let releaseStart = null
  const gate = new Promise((resolve) => {
    releaseStart = resolve
  })
  const remote = makeFakeRemote({
    async start() {
      order.push('start:enter')
      await gate
      order.push('start:exit')
      return statusFixture({ running: true, listen: '192.168.1.6:3080', boundAddress: '192.168.1.6' })
    },
    async stop() {
      order.push('stop:enter')
      return statusFixture({ running: false })
    },
  })
  const service = await setup(t, remote)

  const starting = service.handleRpc({ action: 'remoteStart' })
  const stopping = service.handleRpc({ action: 'remoteStop' })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.deepEqual(order, ['start:enter'], 'start 未结束时 stop 不得开始（否则会并发监听）')

  releaseStart()
  const [started, stopped] = await Promise.all([starting, stopping])
  assert.deepEqual(order, ['start:enter', 'start:exit', 'stop:enter'])
  assert.equal(started.ok, true)
  assert.equal(started.data.running, true)
  assert.equal(stopped.ok, true)
  assert.equal(stopped.data.running, false)
})

/* -------------------------------------------------------------------------- */
/* 5) 现有同步 action 不退化                                                    */
/* -------------------------------------------------------------------------- */

test('注入 remote 后，原有同步 action 行为不变', async (t) => {
  const remote = makeFakeRemote()
  const service = await setup(t, remote)

  const state = await service.handleRpc({ action: 'getState' })
  assert.equal(state.ok, true)
  assert.equal(state.data.settings.repoUrl, '')
  assert.equal(typeof state.data.status, 'object')
  assert.ok(Array.isArray(state.data.snapshots))
  assert.equal(remote.calls.length, 0, '同步 action 不得顺带调用远程服务')

  const unknown = await service.handleRpc({ action: 'nope' })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.error.code, 'E_UNKNOWN_ACTION')

  const missing = await service.handleRpc({})
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'E_VALIDATION')
})
