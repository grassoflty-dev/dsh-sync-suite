/**
 * `src/remote/listener.ts` 的集成测试（**真起服务**，不 mock 网络）。
 *
 * 覆盖：
 *   - `isBindableLanAddress` 的放行/拒绝表（含 IPv6、保留地址、非法字面量）；
 *   - HTTPS 反代：状态码/正文/`host` 改写/`x-forwarded-*`（外部 https）/POST body/动态上游头；
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
 * 绑定地址必须是非回环 IPv4（listener 的设计约束），本机没有局域网 IPv4 时相关用例跳过。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import os from 'node:os'
import {
  RemoteStartError,
  isBindableLanAddress,
  scrubSecrets,
  startRemoteListener,
} from '../dist/remote/listener.js'
import { generatePairingCertificate } from '../dist/remote/pairingTls.js'

/** 测试夹具：每张监听都配一张真实生成的证书；PEM 内容永不写进断言输出。 */
const TEST_CERT = generatePairingCertificate()
const TEST_TLS = { cert: TEST_CERT.certPem, key: TEST_CERT.keyPem }

/** 本机第一块非回环 IPv4（没有就跳过关联网用例）。 */
function findLanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list ?? []) {
      const family = item.family
      if (family !== 'IPv4' && family !== 4) continue
      if (item.internal === true) continue
      if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(item.address)) continue
      if (item.address.startsWith('169.254.')) continue
      if (!isBindableLanAddress(item.address)) continue
      return item.address
    }
  }
  return null
}

const LAN = findLanAddress()
const SKIP = LAN === null ? '本机没有可绑定的非回环 IPv4' : false

function lanTest(name, fn) {
  return test(name, { skip: SKIP }, fn)
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
 * 假上游：HTTP 返回请求的回显 JSON（含关键头），`/redirect` 返回回环 302，
 * Upgrade 回 101 + 原始字节 echo（不新增 ws 依赖）。
 */
async function startFakeUpstream() {
  const state = { requests: [], upgrades: [], upgradeSockets: new Set() }
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      state.requests.push({ method: req.method, url: req.url, headers: req.headers, body })
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
    socket.on('close', () => state.upgradeSockets.delete(socket))
    socket.on('error', () => {})
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

lanTest('上游不可达：502 + lastError 带 errno 码（不含地址/凭据）', async (t) => {
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
  assert.equal(response.text, 'remote upstream unavailable\n')
  assert.ok(handle.lastError !== null)
  assert.equal(handle.lastError.code, 'ECONNREFUSED')
  assert.ok(!handle.lastError.message.includes('token'), handle.lastError.message)
  assert.ok(handle.stats().total >= 1)
})
