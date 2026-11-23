/**
 * `src/remote/listener.ts` 的集成测试（**真起服务**，不 mock 网络）。
 *
 * 覆盖：
 *   - `isBindableLanAddress` 的放行/拒绝表（含 IPv6、保留地址、非法字面量）；
 *   - HTTPS 反代：状态码/正文/`host` 改写/`x-forwarded-*`（外部 https）/POST body/动态上游头；
 *   - G1：`origin` 只在本监听自己同源时改写成上游 authority，外来 Origin 原样保留；
 *   - G2：上游连不上 → 502 typed `E_UPSTREAM_DOWN`；上游接了连接不回响应头 → 504 typed
 *     `E_UPSTREAM_TIMEOUT`（首字节预算，正文不封顶）；
 *   - 空闲预算（F2）：SSE / multipart 不开表；客户端背压期间挂起；普通响应无字节 → 504
 *     typed `E_UPSTREAM_STALLED`；
 *   - 响应侧安全：`set-cookie` 必剥、`location` 用**请求 Host** 改写（可关）；
 *   - 门禁：HTTP 拒绝 401、`intercept` 自有接口不转发、放行后注入上游 cookie；
 *   - WebSocket：101 + 双向 echo；**未授权升级必须 401 且无 101、不建上游隧道**；
 *   - `close()` 后端口真释放（TCP 层 ECONNREFUSED）；绑定失败只抛 RemoteStartError；
 *   - 错误消息/日志里不出现 token 明文。
 *
 * mod-remote-tls-termination：客户端改用 `node:https`（自签证书，rejectUnauthorized:false；
 * pin 校验在 App 侧测）；WS 升级走 `tls.connect`。**明文回落不存在**，见 remote-tls.test.mjs。
 *
 * 客户端为什么用 `node:https` 而不是全局 `fetch`：
 *   本机设了 `NODE_USE_ENV_PROXY=1` + `HTTP_PROXY=http://127.0.0.1:7897`，而 `NO_PROXY`
 *   只含 `localhost,127.0.0.1`；对 `192.168.x.x` 的 `fetch` 会被系统代理接管 —— 实测
 *   TCP 层已经是 ECONNREFUSED，fetch 却报 `UND_ERR_SOCKET`（端口释放断言会误判）。
 *   所以"客户端"统一用 `node:http`（`agent:false`，无连接池、无代理），语义等价且可复现；
 *   另有一条 `fetch` 用例，在本机被代理接管时显式跳过（无代理环境会真跑）。
 *
 * 只依赖 node: 内置模块（仓库不新增 `ws` 依赖：WS 用裸 socket 手写握手）。
 * 绑定地址必须是非回环 IPv4（listener 的设计约束），且要**既能绑定又能自连**；
 * 本机没有这样的地址时相关用例带具名原因跳过（`LAN-E2E-SKIP：…`，绝不静默通过），
 * 并由文件末尾的「LAN 台账」用例把 登记/实跑/跳过 三条数钉死（跳过不可能被当成通过）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import os from 'node:os'
import {
  DEFAULT_UPSTREAM_FIRST_BYTE_TIMEOUT_MS,
  RemoteStartError,
  isBindableLanAddress,
  scrubSecrets,
  startRemoteListener,
} from '../dist/remote/listener.js'
import { generatePairingCertificate } from '../dist/remote/pairingTls.js'

/** DSH 未认证时 index 的**逐字**正文（`browser-auth.ts:385-393`），401 透传用例按它断言。 */
const DSH_UNAUTHORIZED_BODY = 'dsh web authentication required; reopen the URL printed by dsh web.\n'

/** 测试夹具：每张监听都配一张真实生成的证书；PEM 内容永不写进断言输出。 */
const TEST_CERT = generatePairingCertificate()
const TEST_TLS = { cert: TEST_CERT.certPem, key: TEST_CERT.keyPem }

/**
 * LAN 取址探测的两个上限：候选数量有界、自连等待有界（毫秒）。
 *
 * 只证明"绑得上"不够：虚拟网卡 / VPN / Wi-Fi Direct 常常**绑得上却连不通**
 * （门禁里实测出现过一次 `ETIMEDOUT <LAN ip>` 的隧道用例失败）。所以每个候选要过两道：
 *   ① `listen()` 成功（不是 EADDRNOTAVAIL）；② 从本机 `net.connect()` 在 300 ms 内连上。
 * 两道都过才用作 e2e 的绑定地址。
 */
const LAN_PROBE_CONNECT_TIMEOUT_MS = 300
const LAN_PROBE_MAX_CANDIDATES = 8

/** 候选绑定成功后，从本机向它发起一次 `net.connect`，看是否真的可达。 */
function candidateAcceptsConnect(port, address) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: address, port })
    let settled = false
    const finish = (ok) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(ok)
    }
    const timer = setTimeout(() => finish(false), LAN_PROBE_CONNECT_TIMEOUT_MS)
    timer.unref()
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

/**
 * 本机第一块**既能绑定、又能自连**的非回环 IPv4（没有就跳过，并给出**具名**原因）。
 *
 * 只按网卡枚举挑第一个是不够的：本机会同时存在「Wi-Fi Direct / 承载网络」这类
 * 看着合法、`listen()` 却回 EADDRNOTAVAIL 的地址（或睡一觉醒来就没了）；虚拟网卡 / VPN
 * 还可能绑得上却连不通。所以逐个真绑 + 真连一次再决定，候选数量与自连等待都有上限。
 *
 * 返回值带上 `tried`（**真试过**的候选数）：跳过文案必须说清"试了多少个"，否则
 * "本机没有 → skip" 既没法复核，也不像一条可诊断的结论。
 */
async function findBindableLanAddress() {
  let tried = 0
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list ?? []) {
      const family = item.family
      if (family !== 'IPv4' && family !== 4) continue
      if (item.internal === true) continue
      if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(item.address)) continue
      if (item.address.startsWith('169.254.')) continue
      if (!isBindableLanAddress(item.address)) continue
      if (tried >= LAN_PROBE_MAX_CANDIDATES) return { address: null, tried }
      tried += 1
      const probe = net.createServer()
      try {
        await new Promise((resolve, reject) => {
          const onError = (error) => reject(error)
          probe.once('error', onError)
          probe.listen(0, item.address, () => {
            probe.removeListener('error', onError)
            resolve()
          })
        })
        const reachable = await candidateAcceptsConnect(probe.address().port, item.address)
        await new Promise((resolve) => probe.close(resolve))
        if (reachable) return { address: item.address, tried }
      } catch {
        try {
          probe.close()
        } catch {
          /* ignore */
        }
      }
    }
  }
  return { address: null, tried }
}

const LAN_PROBE = await findBindableLanAddress()
const LAN = LAN_PROBE.address

/**
 * 跳过原因的**唯一**文案（一行中文）：缺什么能力、试过多少候选、每次探测多久、
 * 以及"套件其余用例照常执行" —— 跳过必须是一条**可诊断的结论**，不是静默失覆盖。
 *
 * `totalCases` 由台账在**运行时**给出，因此文案里的条数就是本次真正跳过的 `lanTest` 条数。
 */
function lanSkipReason(totalCases) {
  return (
    'LAN-E2E-SKIP：本机无「可绑定且可自连」的非回环 IPv4' +
    `（已试 ${String(LAN_PROBE.tried)} 个候选，每次自连 ≤${String(LAN_PROBE_CONNECT_TIMEOUT_MS)} ms，` +
    `候选上限 ${String(LAN_PROBE_MAX_CANDIDATES)} 个）；` +
    `依赖局域网绑定的 ${String(totalCases)} 条代理用例跳过，套件其余用例照常执行`
  )
}

/**
 * LAN 用例台账（P2-B）：**跳过必须可见，且不可能被当成通过**。
 *
 * 为什么不用静态 `skip` 选项：那会让人无法从测试输出里区分"跑过了"与"压根没跑"。
 * 这里把每条 `lanTest` 都登记进台账，由文件末尾的台账用例断言
 * `ran + skipped === total` 且"只有本机真的缺能力时才允许跳过"，并把具体原因打出来。
 *
 * 跳过时用运行期的 `t.skip(文案)`（而不是注册期的 `skip` 选项），因为只有运行时才知道
 * 本文件一共登记了多少条 `lanTest` —— 文案里的条数必须是真实条数。
 * 用例体本身的断言与行为**一字未改**：跳过时函数体不会执行（与静态 skip 等价）。
 */
const LAN_LEDGER = { total: 0, ran: 0, skipped: 0, reason: '' }

function lanTest(name, fn) {
  LAN_LEDGER.total += 1
  return test(name, async (t) => {
    if (LAN === null) {
      LAN_LEDGER.skipped += 1
      LAN_LEDGER.reason = lanSkipReason(LAN_LEDGER.total)
      t.skip(LAN_LEDGER.reason)
      return
    }
    LAN_LEDGER.ran += 1
    return fn(t)
  })
}


/**
 * 全局 `fetch` 是否会被系统代理接管（被接管时 fetch 的错误码不可用于端口释放断言）。
 * 判断只看环境变量：`NODE_USE_ENV_PROXY=1` + 代理变量存在 + `NO_PROXY` 不覆盖目标 host。
 */
function fetchGoesThroughEnvProxy() {
  if (process.env.NODE_USE_ENV_PROXY !== '1') return false
  const proxy =
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.HTTP_PROXY ??
    process.env.http_proxy ??
    process.env.ALL_PROXY ??
    process.env.all_proxy
  if (proxy === undefined || proxy === '') return false
  const noProxy = (process.env.NO_PROXY ?? process.env.no_proxy ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
  return !noProxy.some((entry) => entry === '*' || entry === LAN)
}

/** 等价于"平板 WebView 发一个请求"：node:https 直连，agent:false（无池化、无环境代理）。
 *  自签证书由测试夹具生成，客户端不校 CA（pin 的校验在 App 侧另测）。 */
function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const request = https.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        method: options.method ?? 'GET',
        headers: options.headers ?? {},
        agent: false,
        rejectUnauthorized: false,
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json = null
          try {
            json = JSON.parse(text)
          } catch {
            json = null
          }
          resolve({ status: response.statusCode, headers: response.headers, text, json })
        })
      },
    )
    request.on('error', reject)
    if (options.body !== undefined) request.write(options.body)
    request.end()
  })
}

async function listenOnce(server, port, host) {
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.removeListener('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

async function freePortOn(host) {
  const probe = net.createServer()
  await listenOnce(probe, 0, host)
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  return port
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 轮询等一个异步状态到位（默认 2 s 上限）。
 *
 * 为什么要它：槽位归还、"第 N 条真的拨到上游"这类事情发生在事件循环里，固定 `sleep`
 * 要么白等要么不够；轮询到条件成立就立刻返回，超时则**点名**是哪条断言没等到。
 */
async function waitFor(check, label, timeoutMs = 2_000) {
  const startedAt = Date.now()
  for (;;) {
    if (check()) return
    if (Date.now() - startedAt > timeoutMs) {
      assert.fail(`等待超时（${String(timeoutMs)} ms）：${label}`)
    }
    await delay(10)
  }
}

/**
 * 假上游：HTTP 返回请求的回显 JSON（含关键头），`/redirect` 返回回环 302，
 * `/dsh-401` 回 DSH index 的逐字 401 正文，Upgrade 回 101 + 原始字节 echo（不新增 ws 依赖）。
 */
async function startFakeUpstream() {
  const state = { requests: [], upgrades: [], upgradeSockets: new Set() }
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      state.requests.push({ method: req.method, url: req.url, headers: req.headers, body })
      if (req.url === '/dsh-401') {
        // DSH 未认证 index 的真实形态（`browser-auth.ts:385-393`）：状态码 + 正文必须逐字透传
        res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(DSH_UNAUTHORIZED_BODY)
        return
      }
      if (typeof req.url === 'string' && req.url.startsWith('/redirect')) {
        // 上游只知道自己是 127.0.0.1:<port>，于是生成回环 location（典型的坑）
        const port = server.address().port
        res.writeHead(302, { location: `http://127.0.0.1:${port}/after-login?from=upstream` })
        res.end()
        return
      }
      const payload = {
        ok: true,
        method: req.method,
        url: req.url,
        host: req.headers.host ?? null,
        xff: req.headers['x-forwarded-for'] ?? null,
        xfh: req.headers['x-forwarded-host'] ?? null,
        xfp: req.headers['x-forwarded-proto'] ?? null,
        cookie: req.headers.cookie ?? null,
        origin: req.headers.origin ?? null,
        secFetchSite: req.headers['sec-fetch-site'] ?? null,
        injected: req.headers['x-injected'] ?? null,
        dyn: req.headers['x-dyn'] ?? null,
        body,
      }
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-fake-upstream': 'yes',
        // 本机 owner 身份 cookie：listener **必须**剥掉，绝不漏给平板
        'set-cookie': 'dsh_session=OWNER-SECRET-9f3a; Path=/; HttpOnly',
      })
      res.end(JSON.stringify(payload))
    })
  })
  server.on('upgrade', (req, socket) => {
    state.upgrades.push({ url: req.url, headers: req.headers })
    state.upgradeSockets.add(socket)
    // server 侧 upgrade socket 的 allowHalfOpen 是 true：对端 FIN 只会得到 'end'，
    // 'close' 要等本端也收尾。收到 'end' 就主动 destroy，否则 fake.close() 会一直等它。
    socket.on('end', () => {
      state.upgradeSockets.delete(socket)
      socket.destroy()
    })
    socket.on('close', () => state.upgradeSockets.delete(socket))
    socket.on('error', () => state.upgradeSockets.delete(socket))
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: fake-accept==\r\n\r\n',
    )
    // 原始字节 echo：够证明双向隧道打通（不解析 WebSocket 帧）
    socket.on('data', (chunk) => {
      try {
        socket.write(chunk)
      } catch {
        /* ignore */
      }
    })
  })
  await listenOnce(server, 0, '127.0.0.1')
  const port = server.address().port
  return {
    server,
    state,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      for (const socket of state.upgradeSockets) {
        try {
          socket.destroy()
        } catch {
          /* ignore */
        }
      }
      state.upgradeSockets.clear()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/**
 * "哑上游"：接受 TCP 连接、**一个字节都不回**。
 *
 * 它模拟的是最坏的那种挂死：端口在听（不是 ECONNREFUSED），但对端进程卡住/被挂起，
 * 于是监听侧如果不设首字节预算，平板就会无限等（G2 的原始缺陷形态）。
 */
async function startSilentUpstream() {
  const state = { connections: 0, sockets: new Set() }
  const server = net.createServer((socket) => {
    state.connections += 1
    state.sockets.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => state.sockets.delete(socket))
  })
  await listenOnce(server, 0, '127.0.0.1')
  const port = server.address().port
  return {
    state,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      for (const socket of state.sockets) {
        try {
          socket.destroy()
        } catch {
          /* ignore */
        }
      }
      state.sockets.clear()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/** 起一对"哑上游 + 旁挂监听"，测试结束自动清理。 */
async function setupSilent(t, config = {}) {
  const silent = await startSilentUpstream()
  const handle = await startRemoteListener({
    port: 0,
    bindAddress: LAN,
    upstream: { baseUrl: silent.baseUrl },
    tls: TEST_TLS,
    ...(config.listener ?? {}),
  })
  t.after(async () => {
    await handle.close()
    await silent.close()
  })
  return { silent, handle, base: `https://${LAN}:${handle.port}` }
}

/** 起一对"假上游 + 旁挂监听"，测试结束自动清理。 */
async function setup(t, config = {}) {
  const fake = await startFakeUpstream()
  const handle = await startRemoteListener({
    port: 0,
    bindAddress: LAN,
    upstream: { baseUrl: fake.baseUrl, ...(config.upstream ?? {}) },
    tls: TEST_TLS,
    ...(config.listener ?? {}),
  })
  t.after(async () => {
    await handle.close()
    await fake.close()
  })
  return { fake, handle, base: `https://${LAN}:${handle.port}` }
}

/** 裸 socket 读取器：支持"等到 header 结束"与"等到 N 字节"。 */
class SocketReader {
  constructor(socket) {
    this.socket = socket
    this.buffer = Buffer.alloc(0)
    this.waiters = []
    this.failure = null
    this.ended = false
    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk])
      this.pump()
    })
    socket.on('error', (error) => {
      this.failure = error
      this.pump()
    })
    socket.on('close', () => {
      this.ended = true
      this.pump()
    })
  }

  pump() {
    while (this.waiters.length > 0) {
      const waiter = this.waiters[0]
      let value
      try {
        value = waiter.check()
      } catch (error) {
        this.waiters.shift()
        clearTimeout(waiter.timer)
        waiter.reject(error)
        continue
      }
      if (value === undefined) {
        if (this.failure !== null) {
          this.waiters.shift()
          clearTimeout(waiter.timer)
          waiter.reject(this.failure)
        } else if (this.ended) {
          this.waiters.shift()
          clearTimeout(waiter.timer)
          waiter.reject(new Error('socket 已关闭，期待的数据没来'))
        }
        return
      }
      this.waiters.shift()
      clearTimeout(waiter.timer)
      waiter.resolve(value)
    }
  }

  wait(check, label) {
    return new Promise((resolve, reject) => {
      const waiter = { check, resolve, reject, timer: null }
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((item) => item !== waiter)
        reject(new Error(`等待超时：${label}`))
      }, 5_000)
      waiter.timer.unref()
      this.waiters.push(waiter)
      this.pump()
    })
  }

  /** 读到 `\r\n\r\n` 为止，返回状态行 + 头（不含空行）。 */
  readHead() {
    return this.wait(() => {
      const index = this.buffer.indexOf('\r\n\r\n')
      if (index < 0) return undefined
      const text = this.buffer.subarray(0, index).toString('latin1')
      this.buffer = this.buffer.subarray(index + 4)
      return text
    }, 'HTTP 应答头')
  }

  readAtLeast(size) {
    return this.wait(() => {
      if (this.buffer.length < size) return undefined
      const out = this.buffer.subarray(0, size)
      this.buffer = this.buffer.subarray(size)
      return out
    }, `${size} 字节`)
  }
}

/** WSS 握手：TLS 之上写原始 Upgrade 字节。 */
async function openWs(port, host, { path = '/ws', extraHeaders = {} } = {}) {
  const socket = tls.connect({ port, host, rejectUnauthorized: false, servername: host })
  socket.setNoDelay(true)
  await new Promise((resolve, reject) => {
    socket.once('secureConnect', resolve)
    socket.once('error', reject)
  })
  const reader = new SocketReader(socket)
  const extra = Object.entries(extraHeaders)
    .map(([key, value]) => `${key}: ${value}\r\n`)
    .join('')
  socket.write(
    `GET ${path} HTTP/1.1\r\n` +
      `Host: ${host}:${port}\r\n` +
      'Connection: Upgrade\r\n' +
      'Upgrade: websocket\r\n' +
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
      'Sec-WebSocket-Version: 13\r\n' +
      extra +
      '\r\n',
  )
  return { socket, reader }
}

// ---------------------------------------------------------------------------
// 1. 纯函数：绑定地址过滤
// ---------------------------------------------------------------------------

test('isBindableLanAddress：放行具体局域网 IPv4', () => {
  for (const address of ['192.168.1.6', '10.0.0.5', '172.16.3.4', '100.64.0.7']) {
    assert.equal(isBindableLanAddress(address), true, `${address} 应可绑定`)
  }
})

test('isBindableLanAddress：拒绝回环/链路本地/任意地址/IPv6/非法字面量', () => {
  const rejected = [
    '127.0.0.1',
    '127.1.2.3',
    '169.254.1.1',
    '0.0.0.0',
    '0.1.2.3',
    '255.255.255.255',
    '224.0.0.1',
    '::1',
    '::ffff:192.168.1.6',
    'fe80::1',
    '',
    '   ',
    'abc',
    'localhost',
    '192.168.1.256',
    '192.168.01.6',
    '192.168.1',
    '192.168.1.6:3081',
    '192.168.1.6 ',
  ]
  for (const address of rejected) {
    assert.equal(isBindableLanAddress(address), false, `${JSON.stringify(address)} 必须被拒`)
  }
})

test('scrubSecrets：打码查询参数与 userinfo，不泄漏 token 明文', () => {
  const text = 'http://user:pw@127.0.0.1:1/x?token=SECRET-9f3a&keep=1'
  const scrubbed = scrubSecrets(text)
  assert.ok(!scrubbed.includes('SECRET-9f3a'), scrubbed)
  assert.ok(!scrubbed.includes('user:pw@'), scrubbed)
  assert.ok(scrubbed.includes('keep=1'), scrubbed)
})

// ---------------------------------------------------------------------------
// 2. HTTP 反代（真起服务）
// ---------------------------------------------------------------------------

lanTest('HTTP 反代：状态码/正文/host 改写/x-forwarded-* 注入', async (t) => {
  const { fake, handle, base } = await setup(t)
  assert.ok(handle.port > 0, 'port: 0 必须由 OS 分配出真实端口')
  assert.equal(handle.address, LAN)

  const response = await httpRequest(`${base}/x?a=1&b=2`, { headers: { 'x-client-mark': 'test' } })
  assert.equal(response.status, 200)
  assert.equal(response.headers['x-fake-upstream'], 'yes')
  const payload = response.json

  assert.equal(payload.ok, true)
  assert.equal(payload.url, '/x?a=1&b=2', 'path + query 必须原样转发')
  assert.equal(payload.host, `127.0.0.1:${fake.port}`, 'host 必须改写成上游 host')
  assert.ok(typeof payload.xff === 'string' && payload.xff !== '', 'x-forwarded-for 必须存在')
  assert.equal(payload.xfp, 'https', '外部这一跳是 HTTPS，上游仍是 http')
  assert.equal(payload.xfh, `${LAN}:${handle.port}`, 'x-forwarded-host 是客户端原始 Host')

  // 上游确实收到了那条请求
  assert.equal(fake.state.requests.length, 1)
  assert.equal(fake.state.requests[0].headers['x-client-mark'], 'test', '自定义头必须透传')
})

test(
  'fetch 直连时：真实 fetch 断言状态码/正文/x-forwarded-for',
  {
    skip:
      LAN === null
        ? '本机没有可绑定的非回环 IPv4'
        : fetchGoesThroughEnvProxy()
          ? '本机 NODE_USE_ENV_PROXY+HTTP_PROXY 生效且 NO_PROXY 不含局域网地址，fetch 被系统代理接管'
          : false,
  },
  async (t) => {
    // 自签证书：全局 fetch 不提供"只信这张 pin"的入参，测试里临时关 CA 校验（仅此用例）。
    const previousTlsEnv = process.env.NODE_TLS_REJECT_UNAUTHORIZED
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
    t.after(() => {
      if (previousTlsEnv === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTlsEnv
    })
    const { handle, base } = await setup(t)
    const response = await fetch(`${base}/x?a=1`)
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.url, '/x?a=1')
    assert.ok(typeof payload.xff === 'string' && payload.xff !== '')
    assert.equal(payload.xfh, `${LAN}:${handle.port}`)
  },
)

lanTest('HTTP 反代：POST body 原样转发', async (t) => {
  const { base } = await setup(t)
  const body = JSON.stringify({ hello: '平板', n: 42 })
  const response = await httpRequest(`${base}/api/echo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
  assert.equal(response.status, 200)
  assert.equal(response.json.method, 'POST')
  assert.equal(response.json.body, body)
})

// ---------------------------------------------------------------------------
// 2.1 请求头改写（G1）：Host / 注入 cookie / Origin 同源与否
// ---------------------------------------------------------------------------

lanTest('请求头改写：Host 改写 + 注入 cookie 覆盖客户端 cookie + 同源 Origin 改写', async (t) => {
  const INJECTED_COOKIE = 'dsh-auth-9c1f0d=v1.INJECTED.SIGNATURE'
  const CLIENT_COOKIE = 'dsh-remote-session=CLIENT-SESSION-CANARY'
  const { fake, handle, base } = await setup(t, {
    listener: {
      authorize: () => ({ kind: 'allow', upstreamHeaders: { cookie: INJECTED_COOKIE, 'x-injected': 'yes' } }),
    },
  })
  const own = `${LAN}:${handle.port}`

  // (1) 平板浏览器的真实形态：Origin 就是它自己看到的 authority（同源），还带自己的会话 cookie
  const same = await httpRequest(`${base}/api/state`, {
    headers: { origin: `https://${own}`, 'sec-fetch-site': 'same-origin', cookie: CLIENT_COOKIE },
  })
  assert.equal(same.status, 200)
  const seen = fake.state.requests[0].headers
  assert.equal(seen.host, `127.0.0.1:${fake.port}`, 'Host 必须改写上游 hostHeader')
  assert.equal(seen.cookie, INJECTED_COOKIE, '上游只许看到门禁注入的那一个 cookie')
  assert.ok(!String(seen.cookie).includes('CLIENT-SESSION-CANARY'), '客户端自己的 cookie 不能上行')
  assert.equal(seen['x-forwarded-host'], own, 'x-forwarded-host 是客户端原始 Host')
  assert.equal(seen['x-forwarded-proto'], 'https', '外部这一跳是 HTTPS')
  assert.equal(
    seen.origin,
    `http://127.0.0.1:${fake.port}`,
    '同源 Origin 必须改写成上游 authority（否则 DSH 栅栏 403）',
  )
  assert.equal(seen['sec-fetch-site'], 'same-origin', '其余请求头原样透传')

  // (2) 同一个 authority 但 scheme 不同（http）：authority 相等即算同源，仍要改写
  await httpRequest(`${base}/api/state`, { headers: { origin: `http://${own}` } })
  assert.equal(
    fake.state.requests[1].headers.origin,
    `http://127.0.0.1:${fake.port}`,
    'authority 比较不看 scheme',
  )

  // (3) 外来 Origin：**原样保留**，交给 DSH 自己的栅栏拒（绝不替它放宽）
  await httpRequest(`${base}/api/state`, { headers: { origin: 'https://evil.example' } })
  assert.equal(fake.state.requests[2].headers.origin, 'https://evil.example', '外来 Origin 必须不改写')

  // (4) 不能解析的 Origin（可被某些客户端发成字面量 null）：同样原样保留
  await httpRequest(`${base}/api/state`, { headers: { origin: 'null' } })
  assert.equal(fake.state.requests[3].headers.origin, 'null', '不可解析的 Origin 不许被改写')

  // (5) Origin 缺失：上游看不到 origin 头（与改写无关）
  await httpRequest(`${base}/api/state`)
  assert.equal(fake.state.requests[4].headers.origin, undefined, '没有 Origin 就不该凭空造一个')
})

lanTest('响应侧安全：剥 set-cookie，location 用请求 Host 改写', async (t) => {
  const { handle, base } = await setup(t)

  const normal = await httpRequest(`${base}/safe`)
  assert.equal(normal.status, 200)
  assert.equal(normal.headers['set-cookie'], undefined, '上游 owner cookie 绝不能漏给客户端')
  assert.equal(normal.json.ok, true)

  const redirect = await httpRequest(`${base}/redirect`)
  assert.equal(redirect.status, 302)
  assert.equal(
    redirect.headers.location,
    `https://${LAN}:${handle.port}/after-login?from=upstream`,
    'location 必须用请求里的 Host（外部 authority）改写且保持 https',
  )
})

lanTest('响应侧安全：请求没有 Host（HTTP/1.0）时 location 保留上游原值', async (t) => {
  const { fake, handle } = await setup(t)
  const socket = tls.connect({ port: handle.port, host: LAN, rejectUnauthorized: false, servername: LAN })
  await new Promise((resolve, reject) => {
    socket.once('secureConnect', resolve)
    socket.once('error', reject)
  })
  const reader = new SocketReader(socket)
  // HTTP/1.0 不要求 Host：这条路径才能覆盖"Host 缺失 → 不改写"
  socket.write('GET /redirect HTTP/1.0\r\n\r\n')
  try {
    const head = await reader.readHead()
    assert.match(head, /^HTTP\/1\.1 302 /, head)
    const match = /(?:^|\n)location:\s*(\S+)/i.exec(head)
    assert.ok(match !== null, head)
    assert.equal(match[1], `http://127.0.0.1:${fake.port}/after-login?from=upstream`, '没有 Host 时不得改写 location')
  } finally {
    socket.destroy()
  }
})

lanTest('响应侧安全：rewriteRedirects=false 时 location 保持上游原值', async (t) => {
  const { fake, base } = await setup(t, { listener: { rewriteRedirects: false } })
  const redirect = await httpRequest(`${base}/redirect`)
  assert.equal(redirect.status, 302)
  assert.equal(redirect.headers.location, `http://127.0.0.1:${fake.port}/after-login?from=upstream`)
})

// ---------------------------------------------------------------------------
// 3. 门禁钩子
// ---------------------------------------------------------------------------

lanTest('authorize 拒绝：回 401、不碰上游、rejected 计数 +1', async (t) => {
  const seen = []
  const { fake, handle, base } = await setup(t, {
    listener: {
      authorize: (input) => {
        seen.push(input)
        assert.equal(input.method, 'GET')
        assert.equal(input.url, '/guarded?token=nope')
        assert.ok(/^\d+\.\d+\.\d+\.\d+$/.test(input.remoteAddress), 'remoteAddress 必须是 IPv4')
        assert.equal(typeof input.headers.host, 'string')
        return { kind: 'respond', status: 401, body: 'unauthorized\n' }
      },
    },
  })

  const response = await httpRequest(`${base}/guarded?token=nope`)
  assert.equal(response.status, 401)
  assert.equal(response.text, 'unauthorized\n')
  assert.equal(fake.state.requests.length, 0, '被拒请求绝不能打到上游')
  assert.equal(handle.stats().rejected, 1)
  assert.equal(seen.length, 1)
})

lanTest('authorize intercept：/__dsh_remote/* 由调用方响应，不转发上游', async (t) => {
  const { fake, base } = await setup(t, {
    listener: {
      authorize: (input, context) => {
        if (!input.url.startsWith('/__dsh_remote/')) return { kind: 'allow' }
        const res = context.res
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ handled: input.url, remote: input.remoteAddress }))
        return { kind: 'respond' }
      },
    },
  })

  const response = await httpRequest(`${base}/__dsh_remote/state`)
  assert.equal(response.status, 200)
  assert.equal(response.json.handled, '/__dsh_remote/state')
  assert.ok(/^\d+\.\d+\.\d+\.\d+$/.test(response.json.remote))
  assert.equal(fake.state.requests.length, 0, '自有接口不能被转发到 DSH 上游')

  // 放行的普通请求照常走上游
  const proxied = await httpRequest(`${base}/normal`)
  assert.equal(proxied.status, 200)
  assert.equal(fake.state.requests.length, 1)
})

lanTest('authorize 放行：upstreamHeaders 注入上游 cookie', async (t) => {
  const { base } = await setup(t, {
    listener: {
      authorize: () => ({
        kind: 'allow',
        upstreamHeaders: { cookie: 'dsh_local_session=LOCAL-OWNER', 'x-injected': 'yes' },
      }),
    },
  })

  const response = await httpRequest(`${base}/injected`)
  assert.equal(response.status, 200)
  assert.equal(response.json.cookie, 'dsh_local_session=LOCAL-OWNER')
  assert.equal(response.json.injected, 'yes')
  assert.equal(response.headers['set-cookie'], undefined, '注入请求 cookie 不等于允许回传 cookie')
})

lanTest('authorize 抛错：fail-closed 回 403（不泄漏异常文本）', async (t) => {
  const { base, handle } = await setup(t, {
    listener: {
      authorize: () => {
        throw new Error('boom token=SECRET-9f3a')
      },
    },
  })
  const response = await httpRequest(`${base}/x`)
  assert.equal(response.status, 403)
  assert.ok(!response.text.includes('SECRET-9f3a'), response.text)
  assert.equal(handle.stats().rejected, 1)
})

// ---------------------------------------------------------------------------
// 4. 动态上游头
// ---------------------------------------------------------------------------

lanTest('上游动态头：函数形式每次请求重新计算（cookie 可刷新）', async (t) => {
  let issued = 0
  const { base } = await setup(t, {
    upstream: {
      headers: () => {
        issued += 1
        return { 'x-dyn': `v${issued}` }
      },
    },
  })

  const first = await httpRequest(`${base}/a`)
  const second = await httpRequest(`${base}/b`)
  assert.equal(first.json.dyn, 'v1')
  assert.equal(second.json.dyn, 'v2', '每次请求都要重新调用 headers()')
  assert.equal(issued, 2)
})

// ---------------------------------------------------------------------------
// 4.5 上游失败（G2）：首字节预算 + typed 上游错误
// ---------------------------------------------------------------------------

test('默认首字节预算是 15000ms（导出常量，可被注入覆盖）', () => {
  assert.equal(DEFAULT_UPSTREAM_FIRST_BYTE_TIMEOUT_MS, 15_000)
})

lanTest('上游接了连接却不回响应头：504 + typed E_UPSTREAM_TIMEOUT（首字节预算）', async (t) => {
  const budget = 150
  const { silent, base } = await setupSilent(t, { listener: { firstByteTimeoutMs: budget } })
  const startedAt = Date.now()
  const response = await httpRequest(`${base}/api/state`)
  const elapsed = Date.now() - startedAt

  assert.equal(response.status, 504, `期望 504，实际 ${String(response.status)}`)
  assert.equal(response.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.match(String(response.text), /^\{.*\}$/, '正文必须是 JSON（不是明文 502 那句话）')
  assert.equal(response.json?.ok, false)
  assert.equal(response.json?.error?.code, 'E_UPSTREAM_TIMEOUT')
  assert.equal(
    response.text,
    '{"ok":false,"error":{"code":"E_UPSTREAM_TIMEOUT"}}',
    'typed 正文逐字节稳定',
  )
  assert.ok(silent.state.connections >= 1, '确实连上了哑上游（不是 ECONNREFUSED）')
  assert.ok(elapsed >= budget - 20, `不该早于预算就报超时（实际 ${String(elapsed)}ms）`)
  assert.ok(elapsed < 5_000, `必须在预算到期后立刻返回，不许挂住（实际 ${String(elapsed)}ms）`)
})

lanTest('首字节预算只卡响应头：慢一点但会回话的上游照旧 200', async (t) => {
  const slow = http.createServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'x-slow': 'yes' })
      res.end('慢但活着')
    }, 120)
  })
  await listenOnce(slow, 0, '127.0.0.1')
  t.after(async () => {
    await new Promise((resolve) => slow.close(resolve))
  })
  const handle = await startRemoteListener({
    port: 0,
    bindAddress: LAN,
    upstream: { baseUrl: `http://127.0.0.1:${slow.address().port}` },
    tls: TEST_TLS,
    // 预算比上游延迟大：正文与响应头都要活着
    firstByteTimeoutMs: 2_000,
  })
  t.after(async () => {
    await handle.close()
  })

  const response = await httpRequest(`https://${LAN}:${handle.port}/slow`)
  assert.equal(response.status, 200)
  assert.equal(response.text, '慢但活着')
  assert.equal(response.headers['x-slow'], 'yes')
})

// --- 空闲预算（S1 / F2）：什么时候算"没有进展" ---------------------------------------

lanTest('空闲预算（S1）：SSE 静默超过预算不算停滞（两段事件都到客户端）', async (t) => {
  const GAP_MS = 450
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' })
    res.write('data: first\n\n')
    setTimeout(() => {
      res.write('data: second\n\n')
      res.end()
    }, GAP_MS)
  })
  await listenOnce(upstream, 0, '127.0.0.1')
  const handle = await startRemoteListener({
    port: 0,
    bindAddress: LAN,
    upstream: { baseUrl: `http://127.0.0.1:${upstream.address().port}` },
    tls: TEST_TLS,
    // 预算远小于两段事件之间的静默：安静是 SSE 的正常状态，不是停滞
    idleTimeoutMs: 120,
  })
  t.after(async () => {
    await handle.close()
    await new Promise((resolve) => upstream.close(resolve))
  })

  const startedAt = Date.now()
  const response = await httpRequest(`https://${LAN}:${handle.port}/plugins/events`)
  const elapsed = Date.now() - startedAt
  assert.equal(response.status, 200, '安静的 SSE 不许被空闲预算杀掉')
  assert.equal(response.headers['content-type'], 'text/event-stream; charset=utf-8')
  assert.ok(response.text.includes('data: first'), response.text)
  assert.ok(response.text.includes('data: second'), '静默跨过预算之后写的事件也必须到达')
  assert.ok(elapsed >= GAP_MS - 50, `本用例必须真的跨过空闲预算（实际 ${String(elapsed)}ms）`)
})

lanTest('空闲预算（S1）：客户端背压超过预算不算停滞（续读后字节完整）', async (t) => {
  // 4 MiB 足够撑满回环两端的 socket 缓冲，逼出 `res.write() === false` 的背压分支
  const TOTAL = 4 * 1024 * 1024
  const CHUNK = Buffer.alloc(64 * 1024, 0x61)
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(TOTAL) })
    let sent = 0
    const pump = () => {
      while (sent < TOTAL) {
        sent += CHUNK.length
        if (!res.write(CHUNK)) {
          res.once('drain', pump)
          return
        }
      }
      res.end()
    }
    pump()
  })
  await listenOnce(upstream, 0, '127.0.0.1')
  const handle = await startRemoteListener({
    port: 0,
    bindAddress: LAN,
    upstream: { baseUrl: `http://127.0.0.1:${upstream.address().port}` },
    tls: TEST_TLS,
    idleTimeoutMs: 120,
  })
  t.after(async () => {
    await handle.close()
    await new Promise((resolve) => upstream.close(resolve))
  })

  const PAUSE_MS = 350 // 远大于空闲预算：老实现会在这里把健康的传输截成半包
  const startedAt = Date.now()
  const result = await new Promise((resolve, reject) => {
    const parsed = new URL(`https://${LAN}:${handle.port}/download`)
    const request = https.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: 'GET',
        headers: {},
        agent: false,
        rejectUnauthorized: false,
      },
      (response) => {
        let bytes = 0
        response.on('data', (chunk) => {
          bytes += chunk.length
        })
        response.on('end', () => resolve({ status: response.statusCode, bytes }))
        response.on('error', reject)
        // 故意不读：上游会被 res.write() 的背压 pause 住，此间没有任何 data 事件
        response.pause()
        setTimeout(() => response.resume(), PAUSE_MS)
      },
    )
    request.on('error', reject)
    request.end()
  })
  const elapsed = Date.now() - startedAt
  assert.equal(result.status, 200)
  assert.equal(result.bytes, TOTAL, '背压过后必须把整包传完（不许截断）')
  assert.ok(elapsed >= PAUSE_MS - 50, `本用例必须真的跨过空闲预算（实际 ${String(elapsed)}ms）`)
})

lanTest('空闲预算（S1）：普通响应一个字节都没有且超过预算 ⇒ 504 typed E_UPSTREAM_STALLED', async (t) => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.flushHeaders()
    // 之后一个字节都不写：TCP 还活着，但上游卡住（普通响应没有豁免）
  })
  await listenOnce(upstream, 0, '127.0.0.1')
  const handle = await startRemoteListener({
    port: 0,
    bindAddress: LAN,
    upstream: { baseUrl: `http://127.0.0.1:${upstream.address().port}` },
    tls: TEST_TLS,
    idleTimeoutMs: 120,
  })
  t.after(async () => {
    await handle.close()
    await new Promise((resolve) => upstream.close(resolve))
  })

  const startedAt = Date.now()
  const response = await httpRequest(`https://${LAN}:${handle.port}/api/state`)
  const elapsed = Date.now() - startedAt
  assert.equal(response.status, 504, '普通响应不许被豁免空闲预算')
  assert.equal(response.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(response.json?.error?.code, 'E_UPSTREAM_STALLED')
  assert.equal(response.text, '{"ok":false,"error":{"code":"E_UPSTREAM_STALLED"}}')
  assert.ok(elapsed >= 100, `不该早于预算就收口（实际 ${String(elapsed)}ms）`)
  assert.ok(elapsed < 5_000, `预算到期后要立刻收口（实际 ${String(elapsed)}ms）`)
})

// ---------------------------------------------------------------------------
// 5. WebSocket 反代
// ---------------------------------------------------------------------------

lanTest('WebSocket 反代：101 + 双向 echo（不新增 ws 依赖）', async (t) => {
  const inputs = []
  const { fake, handle } = await setup(t, {
    listener: {
      authorize: (input) => {
        inputs.push(input)
        return { kind: 'allow' }
      },
    },
  })

  const { socket, reader } = await openWs(handle.port, LAN, { path: '/api/remote.mux?session=1' })
  try {
    const head = await reader.readHead()
    assert.match(head, /^HTTP\/1\.1 101 /, head)
    assert.match(head, /sec-websocket-accept: fake-accept==/i, head)

    const payload = Buffer.from('PING-BYTES')
    socket.write(payload)
    const echoed = await reader.readAtLeast(payload.length)
    assert.deepEqual(Buffer.from(echoed), payload, '客户端应收到上游 echo 的原始字节')

    assert.equal(fake.state.upgrades.length, 1)
    assert.equal(fake.state.upgrades[0].url, '/api/remote.mux?session=1', 'upgrade 的 path/query 必须透传')
    assert.equal(inputs.length, 1, 'upgrade 也必须过 authorize')
    assert.equal(inputs[0].method, 'GET')
    assert.ok(/^\d+\.\d+\.\d+\.\d+$/.test(inputs[0].remoteAddress), 'upgrade 门禁必须拿到对端 IP')
    assert.equal(inputs[0].headers.upgrade, 'websocket')
  } finally {
    socket.destroy()
  }
})

lanTest('WebSocket 未授权：401 且没有 101，不建上游隧道', async (t) => {
  const { fake, handle } = await setup(t, {
    listener: {
      authorize: (input) =>
        input.headers['x-remote-token'] === 'ok' ? { kind: 'allow' } : { kind: 'respond', status: 401 },
    },
  })

  const denied = await openWs(handle.port, LAN, { path: '/api/remote.mux' })
  try {
    const head = await denied.reader.readHead()
    assert.match(head, /^HTTP\/1\.1 401 /, head)
    assert.doesNotMatch(head, /101/, '未授权升级绝不能出现 101')
  } finally {
    denied.socket.destroy()
  }
  await delay(50)
  assert.equal(fake.state.upgrades.length, 0, '未授权升级不能连到上游')

  // 带上令牌才放行
  const allowed = await openWs(handle.port, LAN, {
    path: '/api/remote.mux',
    extraHeaders: { 'x-remote-token': 'ok' },
  })
  try {
    const head = await allowed.reader.readHead()
    assert.match(head, /^HTTP\/1\.1 101 /, head)
  } finally {
    allowed.socket.destroy()
  }
  assert.equal(fake.state.upgrades.length, 1)
})

lanTest('WebSocket 101 隧道：上游看到 Host 改写 + 注入 cookie + 同源 Origin 改写', async (t) => {
  const INJECTED_COOKIE = 'dsh-auth-9c1f0d=v1.UPGRADE.SIGNATURE'
  const { fake, handle } = await setup(t, {
    listener: {
      authorize: () => ({ kind: 'allow', upstreamHeaders: { cookie: INJECTED_COOKIE } }),
    },
  })
  const own = `${LAN}:${handle.port}`

  const { socket, reader } = await openWs(handle.port, LAN, {
    path: '/api/remote.mux',
    extraHeaders: { Origin: `https://${own}`, Cookie: 'dsh-remote-session=CLIENT-SESSION-CANARY' },
  })
  try {
    const head = await reader.readHead()
    assert.match(head, /^HTTP\/1\.1 101 /, head)
  } finally {
    socket.destroy()
  }

  assert.equal(fake.state.upgrades.length, 1)
  const seen = fake.state.upgrades[0].headers
  assert.equal(seen.host, `127.0.0.1:${fake.port}`, 'WS 握手同样必须改写 Host')
  assert.equal(seen.cookie, INJECTED_COOKIE, 'WS 握手必须带门禁注入的 cookie')
  assert.ok(!String(seen.cookie).includes('CLIENT-SESSION-CANARY'), '客户端 cookie 不能上行')
  assert.equal(seen.origin, `http://127.0.0.1:${fake.port}`, 'WS 握手的同源 Origin 也要改写')
})

lanTest('WebSocket 上游没同意升级（回 200）：502 拒绝升级，不把 body 当隧道', async (t) => {
  const refusedBody = 'no upgrade for you\n'
  const upstream = http.createServer((_req, res) => {
    res.writeHead(404)
    res.end()
  })
  upstream.on('upgrade', (_req, socket) => {
    // 明确回一个非 101 应答：这是"上游拒绝升级"的确定形态
    socket.end(`HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: ${String(Buffer.byteLength(refusedBody))}\r\n\r\n${refusedBody}`)
  })
  await listenOnce(upstream, 0, '127.0.0.1')
  t.after(async () => {
    await new Promise((resolve) => upstream.close(resolve))
  })
  const handle = await startRemoteListener({
    port: 0,
    bindAddress: LAN,
    upstream: { baseUrl: `http://127.0.0.1:${upstream.address().port}` },
    tls: TEST_TLS,
  })
  t.after(async () => {
    await handle.close()
  })

  const { socket, reader } = await openWs(handle.port, LAN, { path: '/api/remote.mux' })
  try {
    const head = await reader.readHead()
    assert.match(head, /^HTTP\/1\.1 502 /, head)
    assert.doesNotMatch(head, /101/, '上游没同意升级时绝不能回 101')
    const expected = Buffer.from('remote upstream refused upgrade\n')
    const body = await reader.readAtLeast(expected.length)
    assert.deepEqual(Buffer.from(body), expected, '必须是 fail-closed 的固定正文')
  } finally {
    socket.destroy()
  }
})

// ---------------------------------------------------------------------------
// 6. 生命周期：关闭释放端口 / 绑定失败
// ---------------------------------------------------------------------------

lanTest('close() 后端口真释放：再连必须 ECONNREFUSED', async (t) => {
  const fake = await startFakeUpstream()
  const handle = await startRemoteListener({
    port: 0,
    bindAddress: LAN,
    upstream: { baseUrl: fake.baseUrl },
    tls: TEST_TLS,
  })
  const { port } = handle
  // 关闭前是通的（node:http 直连，避免 undici keep-alive 池干扰后面的"端口释放"判定）
  const alive = await httpRequest(`https://${LAN}:${port}/x`)
  assert.equal(alive.status, 200)

  await handle.close()
  await handle.close() // 幂等
  await fake.close()

  // TCP 层：必须连不上
  await new Promise((resolve, reject) => {
    const probe = net.connect(port, LAN)
    probe.once('connect', () => {
      probe.destroy()
      reject(new Error('端口仍可连接，close() 没释放端口'))
    })
    probe.once('error', (error) => {
      try {
        assert.equal(error.code, 'ECONNREFUSED')
        resolve()
      } catch (failure) {
        reject(failure)
      }
    })
  })

  // HTTP 客户端：必须是 ECONNREFUSED（不是超时、不是 5xx）
  await assert.rejects(
    async () => {
      await httpRequest(`https://${LAN}:${port}/x`)
    },
    (error) => {
      assert.equal(error.code, 'ECONNREFUSED', `期望 ECONNREFUSED，实际 ${String(error.code)}`)
      return true
    },
  )

  // 无系统代理干扰时，再补一条 fetch 断言（本机 fetch 被代理接管，见文件头说明）
  if (!fetchGoesThroughEnvProxy()) {
    await assert.rejects(
      async () => {
        await fetch(`https://${LAN}:${port}/x`)
      },
      (error) => {
        const code = error?.cause?.code ?? error?.code
        assert.equal(code, 'ECONNREFUSED', `fetch 期望 ECONNREFUSED，实际 ${String(code)}`)
        return true
      },
    )
  }
})

lanTest('绑定已被占用端口：抛 RemoteStartError，且没有未捕获异常', async (t) => {
  const occupied = http.createServer((_req, res) => res.end('occupied'))
  await listenOnce(occupied, 0, LAN)
  const port = occupied.address().port
  const uncaught = []
  const onUncaught = (error) => uncaught.push(error)
  process.on('uncaughtException', onUncaught)
  process.on('unhandledRejection', onUncaught)
  t.after(async () => {
    process.removeListener('uncaughtException', onUncaught)
    process.removeListener('unhandledRejection', onUncaught)
    await new Promise((resolve) => occupied.close(resolve))
  })

  let failure = null
  try {
    await startRemoteListener({ port, bindAddress: LAN, upstream: { baseUrl: 'http://127.0.0.1:1' }, tls: TEST_TLS })
  } catch (error) {
    failure = error
  }
  assert.ok(failure instanceof RemoteStartError, `应抛 RemoteStartError，实际 ${String(failure)}`)
  assert.equal(failure.code, 'E_REMOTE_BIND_FAILED')
  assert.equal(failure.detail, 'EADDRINUSE')
  assert.equal(failure.address, LAN)
  assert.equal(failure.port, port)

  await delay(50)
  assert.deepEqual(uncaught, [], '绑定失败不许产生未捕获异常')
})

lanTest('绑定不可用地址：抛 RemoteStartError（EADDRNOTAVAIL），照样不崩', async () => {
  // 10.255.255.1 是合法局域网 IPv4 形态，但本机几乎不可能真配了它 → 绑定必然失败
  let failure = null
  try {
    await startRemoteListener({ port: 0, bindAddress: '10.255.255.1', upstream: { baseUrl: 'http://127.0.0.1:1' }, tls: TEST_TLS })
  } catch (error) {
    failure = error
  }
  assert.ok(failure instanceof RemoteStartError, `应抛 RemoteStartError，实际 ${String(failure)}`)
  assert.equal(failure.code, 'E_REMOTE_BIND_FAILED')
  assert.ok(['EADDRNOTAVAIL', 'ENETUNREACH', 'EPERM', 'EACCES'].includes(failure.detail), failure.detail)
})

test('非法绑定地址/上游：RemoteStartError 且消息里没有 token 明文', async () => {
  const invalidAddress = await startRemoteListener({
    port: 0,
    bindAddress: '0.0.0.0',
    upstream: { baseUrl: 'http://127.0.0.1:1' },
    tls: TEST_TLS,
  }).then(
    () => null,
    (error) => error,
  )
  assert.ok(invalidAddress instanceof RemoteStartError)
  assert.equal(invalidAddress.code, 'E_REMOTE_INVALID_ADDRESS')

  const invalidUpstream = await startRemoteListener({
    port: 0,
    bindAddress: LAN ?? '192.168.1.6',
    upstream: { baseUrl: 'https://user:PASSWORD-CANARY@example.invalid/x?token=TOKEN-CANARY-9f3a' },
    tls: TEST_TLS,
  }).then(
    () => null,
    (error) => error,
  )
  assert.ok(invalidUpstream instanceof RemoteStartError)
  assert.equal(invalidUpstream.code, 'E_REMOTE_INVALID_UPSTREAM')
  assert.ok(!invalidUpstream.message.includes('TOKEN-CANARY-9f3a'), invalidUpstream.message)
  assert.ok(!invalidUpstream.message.includes('PASSWORD-CANARY'), invalidUpstream.message)
})

// 2026-11-23 retarget（mod-plugin-gui-proxy / G2）：这条用例原来断言上游不可达时的
// **明文** 502（`remote upstream unavailable\n`）。现在"连不上"有 typed 码
// `E_UPSTREAM_DOWN`，断言改成 JSON 正文 + 同一个状态码 502；`lastError` 的 errno 断言一字未动。
lanTest('上游不可达：502 + typed E_UPSTREAM_DOWN + lastError 带 errno 码（不含地址/凭据）', async (t) => {
  const deadPort = await freePortOn('127.0.0.1')
  const handle = await startRemoteListener({
    port: 0,
    bindAddress: LAN,
    upstream: { baseUrl: `http://127.0.0.1:${deadPort}` },
    tls: TEST_TLS,
  })
  t.after(async () => {
    await handle.close()
  })

  const response = await httpRequest(`https://${LAN}:${handle.port}/x`)
  assert.equal(response.status, 502)
  assert.equal(response.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.equal(
    response.text,
    '{"ok":false,"error":{"code":"E_UPSTREAM_DOWN"}}',
    '连不上必须是 typed 正文（逐字节稳定），不是明文',
  )
  assert.equal(response.json?.ok, false)
  assert.equal(response.json?.error?.code, 'E_UPSTREAM_DOWN')
  assert.ok(!response.text.includes('remote upstream unavailable'), '旧明文只保留给"其它意外失败"')
  assert.ok(handle.lastError !== null)
  assert.equal(handle.lastError.code, 'ECONNREFUSED')
  assert.ok(!handle.lastError.message.includes('token'), handle.lastError.message)
  assert.ok(handle.stats().total >= 1)
})

// ---------------------------------------------------------------------------
// 7. 上游 5xx 透传 / 隧道纪律（S3）
// ---------------------------------------------------------------------------

lanTest('上游 500 原样透传：状态码与上游正文都保留（不换成我们的话）', async (t) => {
  const body = 'upstream exploded\n'
  const upstream = http.createServer((_req, res) => {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8', 'x-upstream-error': 'yes' })
    res.end(body)
  })
  await listenOnce(upstream, 0, '127.0.0.1')
  const handle = await startRemoteListener({
    port: 0,
    bindAddress: LAN,
    upstream: { baseUrl: `http://127.0.0.1:${upstream.address().port}` },
    tls: TEST_TLS,
  })
  t.after(async () => {
    await handle.close()
    await new Promise((resolve) => upstream.close(resolve))
  })

  const response = await httpRequest(`https://${LAN}:${handle.port}/api/state`)
  assert.equal(response.status, 500, '5xx 是上游的语义，原样透传')
  assert.equal(response.text, body, '上游正文不许被替换成我们的错误页')
  assert.equal(response.headers['x-upstream-error'], 'yes')
})

lanTest('隧道纪律（S3）：客户端关闭 ⇒ 上游 socket 也被关（不留半开）', async (t) => {
  const { fake, handle } = await setup(t, { listener: { authorize: () => ({ kind: 'allow' }) } })
  const { socket, reader } = await openWs(handle.port, LAN, { path: '/api/remote.mux' })
  const head = await reader.readHead()
  assert.match(head, /^HTTP\/1\.1 101 /, head)
  assert.equal(fake.state.upgrades.length, 1)
  assert.equal(fake.state.upgradeSockets.size, 1)

  socket.destroy()
  // 等上游那一侧真的被断开（listener 的 teardown 是双向的）
  for (let i = 0; i < 50; i += 1) {
    if (fake.state.upgradeSockets.size === 0) break
    await delay(20)
  }
  assert.equal(fake.state.upgradeSockets.size, 0, '客户端走了，上游 socket 必须一起断')
})

lanTest('隧道纪律（S3）：上游关闭 ⇒ 客户端 socket 也被关（消息不静默丢）', async (t) => {
  const { fake, handle } = await setup(t, { listener: { authorize: () => ({ kind: 'allow' }) } })
  const { socket, reader } = await openWs(handle.port, LAN, { path: '/api/remote.mux' })
  const head = await reader.readHead()
  assert.match(head, /^HTTP\/1\.1 101 /, head)
  const [upstreamSocket] = Array.from(fake.state.upgradeSockets)
  assert.ok(upstreamSocket !== undefined)
  upstreamSocket.destroy()
  await reader.wait(() => (reader.ended ? true : undefined), '客户端 socket 关闭')
  assert.equal(reader.ended, true)
  socket.destroy()
})

lanTest('隧道纪律（S3）：并发隧道到顶 ⇒ 503 typed E_UPGRADE_TUNNELS_FULL + rejected 计数', async (t) => {
  const { fake, handle } = await setup(t, {
    listener: { authorize: () => ({ kind: 'allow' }), maxUpgradeTunnels: 2 },
  })
  const opened = []
  try {
    for (let i = 0; i < 2; i += 1) {
      const tunnel = await openWs(handle.port, LAN, { path: `/api/remote.mux?i=${String(i)}` })
      const head = await tunnel.reader.readHead()
      assert.match(head, /^HTTP\/1\.1 101 /, head)
      opened.push(tunnel)
    }
    assert.equal(fake.state.upgrades.length, 2)

    const third = await openWs(handle.port, LAN, { path: '/api/remote.mux?i=2' })
    try {
      const head = await third.reader.readHead()
      assert.match(head, /^HTTP\/1\.1 503 /, head)
      assert.match(head, /content-type: application\/json/i, head)
      const expected = Buffer.from('{"ok":false,"error":{"code":"E_UPGRADE_TUNNELS_FULL"}}')
      const body = await third.reader.readAtLeast(expected.length)
      assert.deepEqual(Buffer.from(body), expected, '到顶必须是 typed 正文')
    } finally {
      third.socket.destroy()
    }
    assert.equal(fake.state.upgrades.length, 2, '被拒的升级绝不能打到上游')
    assert.ok(handle.stats().rejected >= 1, '拒绝必须计入 rejected（不是静默丢弃）')
  } finally {
    for (const tunnel of opened) tunnel.socket.destroy()
  }
})

lanTest('隧道上限（P2-A）：上限按「已建立 + 已预约」计，半开握手最多占到上限', async (t) => {
  // 哑上游：接受 TCP 连接、一个字节都不回 ⇒ 握手永远到不了 101（= 半开握手）。
  const silent = await startSilentUpstream()
  const handle = await startRemoteListener({
    port: 0,
    bindAddress: LAN,
    upstream: { baseUrl: silent.baseUrl },
    tls: TEST_TLS,
    authorize: () => ({ kind: 'allow' }),
    maxUpgradeTunnels: 2,
  })
  const opened = []
  let fourth = null
  try {
    // 前两条半开握手：它们永远收不到 101，但**必须**各自占掉一个槽位
    opened.push(await openWs(handle.port, LAN, { path: '/api/remote.mux?half=0' }))
    opened.push(await openWs(handle.port, LAN, { path: '/api/remote.mux?half=1' }))
    await waitFor(
      () => handle.stats().reservedTunnels === 2 && silent.state.connections === 2,
      '两条半开握手必须先各占一个预约槽，并且真的拨到上游',
    )

    // 第 3 条：上限 2 已满 ⇒ 503 typed，且**绝不**再打上游
    const third = await openWs(handle.port, LAN, { path: '/api/remote.mux?half=2' })
    try {
      const head = await third.reader.readHead()
      assert.match(head, /^HTTP\/1\.1 503 /, head)
      assert.match(head, /content-type: application\/json/i, head)
      const expected = Buffer.from('{"ok":false,"error":{"code":"E_UPGRADE_TUNNELS_FULL"}}')
      const body = await third.reader.readAtLeast(expected.length)
      assert.deepEqual(Buffer.from(body), expected, '到顶必须是 typed 正文')
    } finally {
      third.socket.destroy()
    }
    await delay(50)
    assert.equal(silent.state.connections, 2, '第 3 条被拒的握手绝不能打到上游（上游最多见过 2 条尝试）')
    assert.equal(handle.stats().tunnels, 0, '没有一条握手转正，已建立隧道必须是 0')
    assert.equal(handle.stats().reservedTunnels, 2, '占用只看「已建立 + 已预约」：这里 2 个预约')
    assert.equal(handle.stats().rejected, 1, '到顶拒绝必须计入 stats().rejected')

    // 掐掉前两条 ⇒ 槽位归还（幂等释放，不会多扣也不会不扣）
    for (const item of opened) item.socket.destroy()
    await waitFor(() => handle.stats().reservedTunnels === 0, '半开握手断开后预约必须归零（槽位不泄漏）')

    // 第 4 条必须被放行，并且真的拨到上游（连接数 2 → 3）
    fourth = await openWs(handle.port, LAN, { path: '/api/remote.mux?half=3' })
    await waitFor(() => handle.stats().reservedTunnels === 1, '第 4 条必须重新占到一个预约槽')
    await waitFor(() => silent.state.connections === 3, '第 4 条必须真的拨到上游')
    assert.equal(fourth.reader.buffer.length, 0, '上游沉默，此时客户端不应收到任何字节（既非 503 也非 101）')
    assert.equal(fourth.reader.ended, false, '第 4 条是放行后的半开握手，连接必须还开着')

    // close() 必须**同步**把还在握手中的预约清零（不依赖客户端 socket 的 close 事件）
    await handle.close()
    assert.equal(handle.stats().reservedTunnels, 0, 'close() 之后 reserved 必须是 0')
    assert.equal(handle.stats().tunnels, 0, 'close() 之后已建立隧道必须是 0')
  } finally {
    if (fourth !== null) fourth.socket.destroy()
    for (const item of opened) item.socket.destroy()
    await handle.close()
    await silent.close()
  }
})

lanTest('隧道上限（P2-A）：close() 归还握手中的预约，同上限的新监听立刻可用', async (t) => {
  const silent = await startSilentUpstream()
  const fake = await startFakeUpstream()
  let first = null
  let second = null
  const halfOpen = []
  try {
    // 第一个监听：2 条半开握手挂着，然后**直接 close()**（握手还在飞）
    first = await startRemoteListener({
      port: 0,
      bindAddress: LAN,
      upstream: { baseUrl: silent.baseUrl },
      tls: TEST_TLS,
      authorize: () => ({ kind: 'allow' }),
      maxUpgradeTunnels: 2,
    })
    halfOpen.push(await openWs(first.port, LAN, { path: '/api/remote.mux?half=0' }))
    halfOpen.push(await openWs(first.port, LAN, { path: '/api/remote.mux?half=1' }))
    await waitFor(() => first.stats().reservedTunnels === 2, '两条半开握手必须先各占一个预约槽')
    await first.close()
    assert.equal(first.stats().reservedTunnels, 0, 'close() 时握手中的预约必须同步归还')
    assert.equal(first.stats().tunnels, 0)

    // 第二个监听：同一上限、正常上游 ⇒ 第一条升级必须 101（说明没有跨监听遗留的占用）
    second = await startRemoteListener({
      port: 0,
      bindAddress: LAN,
      upstream: { baseUrl: fake.baseUrl },
      tls: TEST_TLS,
      authorize: () => ({ kind: 'allow' }),
      maxUpgradeTunnels: 2,
    })
    const tunnel = await openWs(second.port, LAN, { path: '/api/remote.mux' })
    try {
      const head = await tunnel.reader.readHead()
      assert.match(head, /^HTTP\/1\.1 101 /, head)
      assert.equal(second.stats().tunnels, 1, '101 到手即为已建立隧道')
      assert.equal(second.stats().reservedTunnels, 0, '101 到达后预约必须转正（不许滞留在预约里）')
      assert.equal(second.stats().rejected, 0, '新监听一开始不该有拒绝')
    } finally {
      tunnel.socket.destroy()
    }
  } finally {
    for (const item of halfOpen) item.socket.destroy()
    if (second !== null) await second.close()
    if (first !== null) await first.close()
    await silent.close()
    await fake.close()
  }
})

lanTest('隧道上限（P2-5）：close() 时正卡在异步门禁 / 上游头解析里的握手，不得再占槽或拨上游', async (t) => {
  /*
   * b11b P2-5：`runUpgrade` 以前只在**入口**查 `closed`，`await options.authorize()` 与
   * `await resolveUpstreamHeaders()` 之后都不再查，`reserveTunnelSlot()` 也不看 `closed`。
   * 公开类型允许这两个钩子返回 Promise（`RemoteAuthorize` 与 `RemoteUpstreamHeaders`），
   * 所以「握手悬着时 close()」是可达路径：恢复执行后会新占一个槽并 http.request，
   * 于是 `close()` 返回后 `reservedTunnels` 变成 1、还多一条活到 15 s 的上游连接。
   *
   * 本用例把两个 await 点都真的悬起来：① 悬在 `await authorize`；② 悬在 `await headers()`。
   */
  const phases = ['authorize', 'headers']
  for (const phase of phases) {
    const silent = await startSilentUpstream()
    let releaseGate = () => {}
    let entered = false
    const suspended = new Promise((resolve) => {
      releaseGate = resolve
    })
    const gate = async () => {
      entered = true
      await suspended
    }
    const listenerOptions = {
      port: 0,
      bindAddress: LAN,
      upstream: { baseUrl: silent.baseUrl },
      tls: TEST_TLS,
    }
    if (phase === 'authorize') {
      // 异步门禁：握手停在 `await options.authorize(...)` 上
      listenerOptions.authorize = async () => {
        await gate()
        return { kind: 'allow' }
      }
    } else {
      // 同步门禁 + 异步上游头：握手停在 `await resolveUpstreamHeaders(...)` 上
      listenerOptions.authorize = () => ({ kind: 'allow' })
      listenerOptions.upstream = {
        baseUrl: silent.baseUrl,
        headers: async () => {
          await gate()
          return { 'x-dyn': '1' }
        },
      }
    }
    const handle = await startRemoteListener(listenerOptions)
    let client = null
    try {
      client = await openWs(handle.port, LAN, { path: `/api/remote.mux?async=${phase}` })
      await waitFor(() => entered, `${phase}：钩子必须已经被调用（握手真的停在 await 上）`)
      // 前提：还没走到预约，也没有拨上游 —— 这两条让后面的断言不是空转。
      assert.equal(handle.stats().reservedTunnels, 0, `${phase}：门禁未过时不该有预约`)
      assert.equal(silent.state.connections, 0, `${phase}：门禁未过之前绝不许拨上游`)

      // 握手悬着的时候关监听
      await handle.close()
      assert.equal(handle.stats().reservedTunnels, 0, `${phase}：close() 之后预约必须是 0`)

      // 放行：runUpgrade 从 await 恢复，必须发现已关闭并立刻收口
      releaseGate()
      await waitFor(() => client.reader.ended === true, `${phase}：close() 之后恢复的握手必须干净收口客户端`)
      await delay(100)
      assert.equal(handle.stats().reservedTunnels, 0, `${phase}：close() 之后恢复的握手不许再占槽（P2-5）`)
      assert.equal(handle.stats().tunnels, 0, `${phase}：不许凭空转正出一条隧道`)
      assert.equal(silent.state.connections, 0, `${phase}：close() 之后恢复的握手绝不能拨上游`)
      const received = client.reader.buffer.toString('latin1')
      assert.equal(/HTTP\/1\.1 101/.test(received), false, `${phase}：不许出现 101（那意味着真的建了隧道）`)
      assert.equal(received.length, 0, `${phase}：监听已关闭，客户端只能看到连接被断开（干净收口，不是半个应答）`)
    } finally {
      if (client !== null) client.socket.destroy()
      await handle.close()
      await silent.close()
    }
  }
})

lanTest('隧道上限（P2-A）：握手失败的两条路径都恰好归还一次（上游不可达 / 上游拒绝升级）', async (t) => {
  // 路径 1：上游端口没人听（`upstreamReq.on('error')` ⇒ 502）
  const deadPort = await freePortOn('127.0.0.1')
  const dead = await startRemoteListener({
    port: 0,
    bindAddress: LAN,
    upstream: { baseUrl: `http://127.0.0.1:${deadPort}` },
    tls: TEST_TLS,
    authorize: () => ({ kind: 'allow' }),
    maxUpgradeTunnels: 1,
  })
  // 路径 2：上游用**普通响应**拒绝升级（`upstreamReq.on('response')` ⇒ 502）
  const refuser = http.createServer((_req, res) => {
    res.writeHead(404)
    res.end()
  })
  refuser.on('upgrade', (_req, socket) => {
    socket.on('error', () => {})
    socket.end('HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n')
  })
  await listenOnce(refuser, 0, '127.0.0.1')
  const refused = await startRemoteListener({
    port: 0,
    bindAddress: LAN,
    upstream: { baseUrl: `http://127.0.0.1:${refuser.address().port}` },
    tls: TEST_TLS,
    authorize: () => ({ kind: 'allow' }),
    maxUpgradeTunnels: 1,
  })
  try {
    // 上限只有 1：若失败路径漏还槽位，第 2 次就会变成 503 而不是 502
    for (let i = 0; i < 3; i += 1) {
      const tunnel = await openWs(dead.port, LAN, { path: '/api/remote.mux' })
      try {
        const head = await tunnel.reader.readHead()
        assert.match(head, /^HTTP\/1\.1 502 /, `第 ${String(i + 1)} 次必须 502 收口（不是被上限拒成 503）：${head}`)
      } finally {
        tunnel.socket.destroy()
      }
      await waitFor(() => dead.stats().reservedTunnels === 0, '上游不可达后预约必须归还')
    }
    assert.equal(dead.stats().rejected, 0, '失败的握手不是"到顶拒绝"，不许计入 rejected')

    for (let i = 0; i < 3; i += 1) {
      const tunnel = await openWs(refused.port, LAN, { path: '/api/remote.mux' })
      try {
        const head = await tunnel.reader.readHead()
        assert.match(head, /^HTTP\/1\.1 502 /, `上游拒绝升级也必须 502 收口：${head}`)
      } finally {
        tunnel.socket.destroy()
      }
      await waitFor(() => refused.stats().reservedTunnels === 0, '上游拒绝升级后预约必须归还')
    }
    assert.equal(refused.stats().rejected, 0, '上游拒绝升级不算"到顶拒绝"')
  } finally {
    await dead.close()
    await refused.close()
    await new Promise((resolve) => refuser.close(resolve))
  }
})

lanTest('隧道纪律（S3）：监听 close() 时所有隧道两侧都被销毁', async (t) => {
  const fake = await startFakeUpstream()
  const handle = await startRemoteListener({
    port: 0,
    bindAddress: LAN,
    upstream: { baseUrl: fake.baseUrl },
    tls: TEST_TLS,
    authorize: () => ({ kind: 'allow' }),
  })
  const tunnels = []
  for (let i = 0; i < 3; i += 1) {
    const tunnel = await openWs(handle.port, LAN, { path: `/api/remote.mux?i=${String(i)}` })
    const head = await tunnel.reader.readHead()
    assert.match(head, /^HTTP\/1\.1 101 /, head)
    tunnels.push(tunnel)
  }
  assert.equal(fake.state.upgradeSockets.size, 3)

  const closed = tunnels.map((tunnel) => tunnel.reader.wait(() => (tunnel.reader.ended ? true : undefined), '隧道关闭'))
  await handle.close()
  await Promise.all(closed)
  for (const tunnel of tunnels) {
    assert.equal(tunnel.reader.ended, true, 'close() 必须断开客户端一侧')
    tunnel.socket.destroy()
  }
  for (let i = 0; i < 50; i += 1) {
    if (fake.state.upgradeSockets.size === 0) break
    await delay(20)
  }
  assert.equal(fake.state.upgradeSockets.size, 0, 'close() 必须断开上游一侧（否则句柄泄漏）')
  await fake.close()
})

lanTest('隧道纪律（S3）：上游重启后，下一次升级直接可用（每次升级都是新连接）', async (t) => {
  const port = await freePortOn('127.0.0.1')
  const makeUpstream = async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(404)
      res.end()
    })
    const sockets = new Set()
    server.on('upgrade', (req, socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      socket.on('error', () => {})
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          'Sec-WebSocket-Accept: restart-accept==\r\n\r\n',
      )
    })
    await listenOnce(server, port, '127.0.0.1')
    return {
      server,
      sockets,
      async close() {
        for (const socket of sockets) socket.destroy()
        sockets.clear()
        await new Promise((resolve) => server.close(resolve))
      },
    }
  }

  let upstream = await makeUpstream()
  const handle = await startRemoteListener({
    port: 0,
    bindAddress: LAN,
    upstream: { baseUrl: `http://127.0.0.1:${port}` },
    tls: TEST_TLS,
    authorize: () => ({ kind: 'allow' }),
  })
  t.after(async () => {
    await handle.close()
    await upstream.close()
  })

  const first = await openWs(handle.port, LAN, { path: '/api/remote.mux' })
  const firstHead = await first.reader.readHead()
  assert.match(firstHead, /^HTTP\/1\.1 101 /, firstHead)
  first.socket.destroy()

  await upstream.close()
  await delay(50)

  // 上游停了：这次升级必须 502（fail-closed），而不是挂住
  const second = await openWs(handle.port, LAN, { path: '/api/remote.mux' })
  const secondHead = await second.reader.readHead()
  assert.match(secondHead, /^HTTP\/1\.1 502 /, secondHead)
  second.socket.destroy()

  // 上游在同一端口重启：下一次升级必须自己好起来（没有缓存死连接）
  upstream = await makeUpstream()
  const third = await openWs(handle.port, LAN, { path: '/api/remote.mux' })
  const thirdHead = await third.reader.readHead()
  assert.match(thirdHead, /^HTTP\/1\.1 101 /, thirdHead)
  assert.match(thirdHead, /sec-websocket-accept: restart-accept==/i, thirdHead)
  third.socket.destroy()
})

lanTest('连接预算（S1）：目标是黑洞地址时不会挂 21s，预算到期即 typed 收口', async (t) => {
  // 203.0.113.0/24 是 TEST-NET-3（不可路由）：SYN 要么被丢弃、要么立刻 EHOSTUNREACH。
  // 注意：Node 的 `req.setTimeout()` 管不到"还没连上"的阶段（实测 1.2s 的设置仍然挂到 21s），
  // 所以这里必须由 listener 自己的连接预算收口。
  const handle = await startRemoteListener({
    port: 0,
    bindAddress: LAN,
    upstream: { baseUrl: 'http://203.0.113.1:81' },
    tls: TEST_TLS,
    connectTimeoutMs: 300,
  })
  t.after(async () => {
    await handle.close()
  })
  const startedAt = Date.now()
  const response = await httpRequest(`https://${LAN}:${handle.port}/api/state`)
  const elapsed = Date.now() - startedAt
  assert.ok(['E_UPSTREAM_TIMEOUT', 'E_UPSTREAM_DOWN'].includes(response.json?.error?.code), response.text)
  assert.ok(elapsed < 5_000, `连接预算必须在大约 300ms 收口（实际 ${String(elapsed)}ms）`)
})

lanTest('协议错误（S1）：上游回的不是 HTTP ⇒ 502 typed E_UPSTREAM_PROTOCOL', async (t) => {
  const garbageSockets = new Set()
  const garbage = net.createServer((socket) => {
    garbageSockets.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => garbageSockets.delete(socket))
    socket.end('NOT-HTTP-AT-ALL\r\n\r\n')
  })
  await listenOnce(garbage, 0, '127.0.0.1')
  const handle = await startRemoteListener({
    port: 0,
    bindAddress: LAN,
    upstream: { baseUrl: `http://127.0.0.1:${garbage.address().port}` },
    tls: TEST_TLS,
  })
  t.after(async () => {
    await handle.close()
    // 半开的裸 socket 要自己收（否则 garbage.close() 会一直等它）
    for (const socket of garbageSockets) socket.destroy()
    garbageSockets.clear()
    await new Promise((resolve) => garbage.close(resolve))
  })

  const response = await httpRequest(`https://${LAN}:${handle.port}/api/state`)
  assert.equal(response.status, 502)
  assert.equal(response.json?.error?.code, 'E_UPSTREAM_PROTOCOL')
  assert.equal(response.text, '{"ok":false,"error":{"code":"E_UPSTREAM_PROTOCOL"}}')
})

// ---------------------------------------------------------------------------
// 5. LAN 台账（P2-B）：跳过必须可见，且不可能被当成通过
// ---------------------------------------------------------------------------

/**
 * 台账守卫：`lanTest` 的 登记数 / 实跑数 / 跳过数 必须自洽，且"跳过"只允许出现在
 * 本机**真的缺能力**的时候。本用例在所有 `lanTest` 之后注册，因此运行时三条数已经定稿。
 *
 * 不真空的三条保证：
 *   · `total > 0`：一条 `lanTest` 都没登记时本用例直接失败（否则它什么也没证明）；
 *   · `ran + skipped === total`：跳过与实跑都不许"消失"；
 *   · `skipped === 缺能力 ? total : 0`：有能力时一条都不许跳过，缺能力时**每一条**
 *     都要以跳过出现在台账里（不可能有哪条悄悄算成通过）。
 */
test('LAN 台账（P2-B）：登记数 = 实跑数 + 跳过数，且跳过只能发生在能力缺失时', (t) => {
  const { total, ran, skipped } = LAN_LEDGER
  const capabilityMissing = LAN === null
  assert.ok(total > 0, '台账里必须有 >= 1 条 LAN 用例：0 条说明登记被绕过，这条守卫就失去意义')
  assert.equal(ran + skipped, total, `实跑 ${String(ran)} + 跳过 ${String(skipped)} 必须等于登记 ${String(total)}`)
  assert.equal(
    skipped,
    capabilityMissing ? total : 0,
    `跳过数 ${String(skipped)} 与本机能力（缺失=${String(capabilityMissing)}）不一致：有能力时一条都不许跳过`,
  )
  assert.equal(
    ran,
    capabilityMissing ? 0 : total,
    `实跑数 ${String(ran)} 与本机能力（缺失=${String(capabilityMissing)}）不一致：缺能力时一条都不许实跑`,
  )
  const reason = capabilityMissing
    ? lanSkipReason(total)
    : `能力存在：可绑定且可自连的 ${String(LAN)}（${String(total)} 条 LAN 用例全部实跑，0 跳过）`
  t.diagnostic(reason)
  console.log(`[LAN-LEDGER] total=${String(total)} ran=${String(ran)} skipped=${String(skipped)} | ${reason}`)
})

