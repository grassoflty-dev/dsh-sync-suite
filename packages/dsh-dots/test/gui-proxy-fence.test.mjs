/**
 * mod-plugin-gui-proxy 的**验收测试**：平板 → 旁挂监听 → DSH GUI 这一跳能不能真的过 DSH 的信任栅栏。
 *
 * 为什么单独一个文件：这里的假上游不是"回显 JSON 的哑上游"，而是**照抄 DSH 的栅栏规则**
 * （`@deepseek-ai/dsh-client-connection/src/api-request-trust.ts:121-176` +
 * `browser-auth.ts:371-393`）：
 *   · Host 必须解析到回环（`127.0.0.1` / `localhost` / `::1`）；
 *   · `sec-fetch-site: cross-site` → 403；
 *   · 请求若带 `Origin`，其 authority 必须与 Host 的 authority **逐字相等**，否则 403；
 *   · 必须带门禁注入的那一个 `dsh-auth-*` cookie，否则 401 + DSH 的逐字正文。
 * 于是本文件断言的不是"我们发了某个字符串"，而是"**这条请求在 DSH 眼里是同源且已认证的**"。
 *
 * 实测背景（只记状态码）：`GET /api/state`，`Host: 127.0.0.1:36569` 无 Origin → 401；
 * 加上 `Origin: https://192.168.1.6:3081` → **403 forbidden**；把 Origin 换成
 * `http://127.0.0.1:36569` → 401。⇒ 只改写 Host、不改写 Origin，平板上的 GUI 能渲染但点不动。
 *
 * 依赖只有 `node:` 内置模块；监听必须绑非回环 IPv4（listener 的设计约束），且该地址要
 * **既能绑定又能自连**；本机没有这样的地址时相关用例带具名原因跳过（`LAN-E2E-SKIP：…`），
 * 并由文件末尾的「LAN 台账」用例把 登记/实跑/跳过 三条数钉死（跳过不可能被当成通过）。
 */
import nodeTest from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import os from 'node:os'
import { readFileSync } from 'node:fs'
import { DEFAULT_UPSTREAM_FIRST_BYTE_TIMEOUT_MS, isBindableLanAddress, startRemoteListener } from '../dist/remote/listener.js'
import { generatePairingCertificate } from '../dist/remote/pairingTls.js'

const TEST_CERT = generatePairingCertificate()
const TEST_TLS = { cert: TEST_CERT.certPem, key: TEST_CERT.keyPem }

/** DSH 未认证 index 的逐字正文（`browser-auth.ts:385-393`）。 */
const DSH_UNAUTHORIZED_BODY = 'dsh web authentication required; reopen the URL printed by dsh web.\n'

/** 门禁注入给上游的本机会话 cookie（测试值；真值是内存里的 `dsh-auth-*`）。 */
const INJECTED_COOKIE = 'dsh-auth-3f9c11=v1.UPSTREAM.SIGNATURE'
/** 客户端（平板）自己的会话 cookie：**绝不能**上行到 DSH。 */
const CLIENT_COOKIE = 'dsh-remote-session=CLIENT-SESSION-CANARY'
/** 客户端 URL 里的访问令牌（日志里绝不出现）。 */
const CLIENT_TOKEN = 'TOKEN-CANARY-6b2e'

/**
 * LAN 取址探测的两个上限：候选数量有界、自连等待有界（毫秒）。
 *
 * 只证明"绑得上"不够：虚拟网卡 / VPN / Wi-Fi Direct 常常**绑得上却连不通**
 * （实测出现过一次 `ETIMEDOUT <LAN ip>`）。所以每个候选要过两道：
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
 * 只按枚举取第一个不够：Wi-Fi Direct / 承载网络这类地址看着合法、`listen()` 会回
 * EADDRNOTAVAIL；虚拟网卡 / VPN 则可能绑得上却连不通 —— 两种都会让整套 e2e 随网卡
 * 状态随机关掉。逐个真绑 + 真连一次再决定，候选数量与自连等待都有上限。
 *
 * 返回值带上 `tried`（**真试过**的候选数）：跳过文案必须说清"试了多少个"。
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
 * 以及"套件其余用例照常执行"。
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
 * 唯一注册器（评审 b11b P2-8）：**每一个**用例都必须经这里登记。
 *
 * 旧实现只在 `lanTest()` 里给台账累加，所以直接注册的用例对台账**完全不可见** —— 将来有人
 * 加一条 LAN 用例忘了用 `lanTest()`，台账照样"通过"，那一条永远不在账上（不会假通过，但会
 * 漏账，而漏账比假通过更难发现）。现在两条纪律合起来才是"每个用例都真的被记账"：
 *   ① 结构上：`node:test` 只允许在这个包装器里被调用（nodeTest 标识符），`test()` /
 *      `lanTest()` 都是它的薄封装，所以 **`total` 是本文件全部注册的条数**，不是手抄清单；
 *   ② 运行期：`lanTest()` 注册的用例在**运行期**才知道本机有没有 LAN 能力，缺能力时用
 *      `t.skip(具名原因)` 跳过（不是注册期静态 skip），跳过被 node 的汇总记进 `skipped`
 *      而**不是** `pass`。
 * 文件末尾的台账用例把三条数钉死，并读本文件源码自检「没有绕过包装器的直调」。
 */

/**
 * 台账：`total` = **全部**注册数（harness-wide），`gated` = 其中的 LAN 用例数
 * （只有这部分会因缺能力而跳过），`ran` / `skipped` = 运行期实际结果。
 */
const LAN_LEDGER = {
  total: 0, gated: 0, ran: 0, skipped: 0, staticSkipped: 0, reason: '',
}

/**
 * 台账裁决（**纯函数**，评审 b11b P2-8）：不读环境、不碰网络、不看本机网卡，
 * 因此「缺能力时 `ran === 0 && skipped > 0`」这条分支可以**离线真的执行一遍**。
 */
function lanLedgerVerdict({ total, ran, skipped, missing, gated = total, staticSkipped = 0 }) {
  const problems = []
  if (!Number.isInteger(total) || total <= 0) {
    problems.push(`登记数 ${String(total)} 必须 > 0：0 条说明登记被绕过，这条守卫会恒真`)
    return { ok: false, problems }
  }
  if (!Number.isInteger(ran) || !Number.isInteger(skipped)) {
    problems.push(`实跑/跳过计数必须是整数（ran=${String(ran)} skipped=${String(skipped)}）`)
    return { ok: false, problems }
  }
  if (!Number.isInteger(gated) || gated < 0 || gated > total) {
    problems.push(`LAN 子集 ${String(gated)} 必须是 0..${String(total)} 的整数`)
  }
  const expectedSkipped = (missing ? gated : 0) + staticSkipped
  if (ran + skipped !== total) {
    problems.push(`实跑 ${String(ran)} + 跳过 ${String(skipped)} 必须等于登记 ${String(total)}`)
  }
  if (skipped !== expectedSkipped) {
    problems.push(
      `跳过数 ${String(skipped)} ≠ ${String(expectedSkipped)}`
      + `（缺能力=${String(missing)}；LAN 用例 ${String(gated)} + 注册期跳过 ${String(staticSkipped)}）`,
    )
  }
  if (ran !== total - expectedSkipped) {
    problems.push(`实跑数 ${String(ran)} ≠ ${String(total - expectedSkipped)}（缺能力时一条都不许实跑）`)
  }
  return { ok: problems.length === 0, problems }
}

/**
 * 一条用例的运行期记账（**唯一**记账点）：注册器与离线探针共用同一份代码。
 * 缺能力的 LAN 用例 ⇒ 记一次跳过 + `t.skip(具名原因)`，**用例体不执行**。
 */
async function runGatedCase(t, { fn, gated = true, missing = LAN === null, ledger = LAN_LEDGER } = {}) {
  if (gated && missing) {
    ledger.skipped += 1
    ledger.reason = lanSkipReason(ledger.gated)
    t.skip(ledger.reason)
    return undefined
  }
  ledger.ran += 1
  return await fn(t)
}

/** `test(name, fn)` / `test(name, options, fn)` 两种写法都收（`node:test` 的原样签名）。 */
function splitTestArgs(optionsOrFn, maybeFn) {
  if (typeof optionsOrFn === 'function') return { options: {}, fn: optionsOrFn }
  return { options: optionsOrFn ?? {}, fn: maybeFn }
}

/** 唯一注册器：`node:test` **只**在这里被调用（末尾自检就查这一点）。 */
function register(name, options, fn, gated) {
  LAN_LEDGER.total += 1
  if (gated) LAN_LEDGER.gated += 1
  const staticSkip = options.skip !== undefined && options.skip !== false && options.skip !== ''
  if (staticSkip) {
    LAN_LEDGER.skipped += 1
    LAN_LEDGER.staticSkipped += 1
  }
  return nodeTest(name, options, async (t) => {
    if (staticSkip) return undefined
    return await runGatedCase(t, { fn, gated })
  })
}

/** 普通用例：不因缺 LAN 能力而跳过。 */
function test(name, optionsOrFn, maybeFn) {
  const { options, fn } = splitTestArgs(optionsOrFn, maybeFn)
  return register(name, options, fn, false)
}

/** LAN 用例：本机缺能力时以具名原因跳过，并进台账。 */
function lanTest(name, fn) {
  return register(name, {}, fn, true)
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

/**
 * 发一个请求（`agent:false` = 无连接池、无环境代理），返回状态/头/原始字节。
 * 走 `node:http(s)` 而不是全局 `fetch`：本机 `NODE_USE_ENV_PROXY=1` 的代理会接管对
 * `192.168.x.x` 的 fetch（见 remote-listener.test.mjs 文件头说明）。
 */
function requestOver(transport, url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const request = transport.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        method: options.method ?? 'GET',
        headers: options.headers ?? {},
        agent: false,
        ...(transport === https ? { rejectUnauthorized: false } : {}),
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          const buffer = Buffer.concat(chunks)
          const text = buffer.toString('utf8')
          let json = null
          try {
            json = JSON.parse(text)
          } catch {
            json = null
          }
          resolve({ status: response.statusCode, headers: response.headers, buffer, text, json })
        })
      },
    )
    request.on('error', reject)
    if (options.body !== undefined) request.write(options.body)
    request.end()
  })
}

/** 平板视角：HTTPS 打旁挂监听（自签证书，pin 校验在 App 侧另测）。 */
function proxyRequest(url, options = {}) {
  return requestOver(https, url, options)
}

/** 浏览器之外的本机直连：用来单独验证"假上游的栅栏真的会拒"。 */
function directRequest(url, options = {}) {
  return requestOver(http, url, options)
}

/** Host 是否解析到回环（DSH 栅栏的第一条）。 */
function isLoopbackAuthority(hostHeader) {
  if (typeof hostHeader !== 'string' || hostHeader.trim() === '') return false
  const hostname = hostHeader
    .trim()
    .replace(/:\d+$/, '')
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
}

/**
 * 照抄 DSH 的栅栏：返回 `{ status, body }`。
 * 规则顺序与 `api-request-trust.ts` 一致：Host → sec-fetch-site → Origin → 认证 cookie。
 */
function dshFence(req, { cookie }) {
  const host = req.headers.host
  if (!isLoopbackAuthority(host)) return { status: 403, body: 'forbidden\n' }
  if (req.headers['sec-fetch-site'] === 'cross-site') return { status: 403, body: 'forbidden\n' }
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin !== '') {
    let parsed
    try {
      parsed = new URL(origin)
    } catch {
      return { status: 403, body: 'forbidden\n' }
    }
    // Origin 的 authority 必须与 Host 逐字相等（大小写不敏感）——这就是平板真实形态栽的地方
    if (parsed.host.toLowerCase() !== String(host).toLowerCase()) return { status: 403, body: 'forbidden\n' }
  }
  // 认证：DSH 只认它自己签发的那个 dsh-auth-* cookie（本文件的"注入值"）
  const presented = req.headers.cookie
  if (typeof presented !== 'string' || presented !== cookie) {
    return { status: 401, body: DSH_UNAUTHORIZED_BODY }
  }
  return { status: 200, body: '' }
}

/**
 * 「栅栏忠实」的假上游：先按 DSH 规则判定，通过后才吐 200 JSON。
 * `state.requests` 记录每条请求，用于断言"上游到底看到了什么"。
 */
async function startFenceUpstream({ cookie = INJECTED_COOKIE } = {}) {
  const state = { requests: [] }
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      state.requests.push({ method: req.method, url: req.url, headers: req.headers })
      const verdict = dshFence(req, { cookie })
      if (verdict.status !== 200) {
        res.writeHead(verdict.status, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(verdict.body)
        return
      }
      const payload = {
        ok: true,
        sawHost: req.headers.host ?? null,
        sawOrigin: req.headers.origin ?? null,
        sawCookie: req.headers.cookie ?? null,
        sawFetchSite: req.headers['sec-fetch-site'] ?? null,
        sawForwardedHost: req.headers['x-forwarded-host'] ?? null,
      }
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'x-fence-passed': 'yes',
        // owner 身份 cookie 绝不回传：监听必须剥掉
        'set-cookie': 'dsh-auth-3f9c11=LEAK-CANARY; Path=/; HttpOnly',
      })
      res.end(JSON.stringify(payload))
    })
  })
  await listenOnce(server, 0, '127.0.0.1')
  const port = server.address().port
  return {
    state,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/** 起一对"栅栏假上游 + 旁挂监听"，测试结束自动清理。 */
async function setup(t, config = {}) {
  const fake = await startFenceUpstream(config.upstream ?? {})
  const logs = []
  const handle = await startRemoteListener({
    port: 0,
    bindAddress: LAN,
    upstream: { baseUrl: fake.baseUrl },
    tls: TEST_TLS,
    log: (message) => logs.push(message),
    ...(config.listener ?? {}),
  })
  t.after(async () => {
    await handle.close()
    await fake.close()
  })
  return { fake, logs, handle, base: `https://${LAN}:${handle.port}` }
}

/** 放行的门禁：注入本机会话 cookie（与 `routes.ts` 的 allow 分支同形）。 */
function allowWithInjectedCookie() {
  return () => ({ kind: 'allow', upstreamHeaders: { cookie: INJECTED_COOKIE } })
}

// ---------------------------------------------------------------------------
// 1. 上游 401（U1）：平板永远看不到 DSH 的英文正文
// ---------------------------------------------------------------------------

lanTest('上游 401：/api 得 typed JSON，导航得中文 HTML 页，英文正文一个字都不外泄', async (t) => {
  let hits = 0
  const unauthorized = http.createServer((_req, res) => {
    hits += 1
    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(DSH_UNAUTHORIZED_BODY)
  })
  await listenOnce(unauthorized, 0, '127.0.0.1')
  const handle = await startRemoteListener({
    port: 0,
    bindAddress: LAN,
    upstream: { baseUrl: `http://127.0.0.1:${unauthorized.address().port}` },
    tls: TEST_TLS,
  })
  t.after(async () => {
    await handle.close()
    await new Promise((resolve) => unauthorized.close(resolve))
  })

  // (1) 接口类请求（不带 Accept: text/html）→ typed JSON，状态码保持 401
  const api = await proxyRequest(`https://${LAN}:${handle.port}/api/state`)
  assert.equal(api.status, 401, '状态码保持 401（不许改成 200/502）')
  assert.equal(api.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(api.text, '{"ok":false,"error":{"code":"E_UPSTREAM_SESSION"}}')
  assert.equal(api.text.includes('dsh web authentication required'), false, 'DSH 英文正文绝不外泄')

  // (2) 导航请求（Accept: text/html）→ 中文 HTML 错误页，带下一步
  const page = await proxyRequest(`https://${LAN}:${handle.port}/`, { headers: { accept: 'text/html,*/*' } })
  assert.equal(page.status, 401)
  assert.match(String(page.headers['content-type']), /^text\/html; charset=utf-8$/)
  assert.match(page.text, /<html lang="zh-CN">/)
  assert.match(page.text, /DSH 会话已失效/, '中文标题要说清原因')
  assert.match(page.text, /重启 DSH/, '中文页要给下一步动作')
  assert.match(page.text, /E_UPSTREAM_SESSION/)
  assert.equal(page.text.includes('dsh web authentication required'), false, '英文正文不进页面')
  assert.equal(page.text.includes('<script'), false, '错误页不带脚本')
  assert.ok(hits >= 2, '两次请求都应打到上游（401 才被包装）')
})

lanTest('上游 401 后换会话重试：恰好重试一次，第二次带新 cookie ⇒ 200', async (t) => {
  const NEW_COOKIE = 'dsh-auth-3f9c11=v1.REFRESHED.SIGNATURE'
  let refreshCalls = 0
  const seenCookies = []
  const upstream = http.createServer((req, res) => {
    const cookies = req.headers.cookie ?? ''
    seenCookies.push(cookies)
    if (cookies !== NEW_COOKIE) {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(DSH_UNAUTHORIZED_BODY)
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, cookie: cookies }))
  })
  await listenOnce(upstream, 0, '127.0.0.1')
  const handle = await startRemoteListener({
    port: 0,
    bindAddress: LAN,
    upstream: { baseUrl: `http://127.0.0.1:${upstream.address().port}` },
    tls: TEST_TLS,
    authorize: () => ({ kind: 'allow', upstreamHeaders: { cookie: INJECTED_COOKIE } }),
    onUpstreamUnauthorized: async () => {
      refreshCalls += 1
      return { cookie: NEW_COOKIE }
    },
  })
  t.after(async () => {
    await handle.close()
    await new Promise((resolve) => upstream.close(resolve))
  })

  const response = await proxyRequest(`https://${LAN}:${handle.port}/api/state`)
  assert.equal(response.status, 200, '重试必须成功（否则平板会看到 401）')
  assert.equal(response.json?.cookie, NEW_COOKIE)
  assert.equal(refreshCalls, 1, '只换一次身份')
  assert.equal(seenCookies.length, 2, '恰好两次上游请求（原始 + 重试一次）')
  assert.equal(seenCookies[0], INJECTED_COOKIE)
  assert.equal(seenCookies[1], NEW_COOKIE, '重试必须带刷新后的 cookie')
})

lanTest('上游 401 重试后仍然 401：只重试一次，然后给中文页/typed JSON', async (t) => {
  let upstreamHits = 0
  let refreshCalls = 0
  const upstream = http.createServer((_req, res) => {
    upstreamHits += 1
    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(DSH_UNAUTHORIZED_BODY)
  })
  await listenOnce(upstream, 0, '127.0.0.1')
  const handle = await startRemoteListener({
    port: 0,
    bindAddress: LAN,
    upstream: { baseUrl: `http://127.0.0.1:${upstream.address().port}` },
    tls: TEST_TLS,
    onUpstreamUnauthorized: async () => {
      refreshCalls += 1
      return { cookie: 'dsh-auth-3f9c11=v1.STILL.BAD' }
    },
  })
  t.after(async () => {
    await handle.close()
    await new Promise((resolve) => upstream.close(resolve))
  })

  const response = await proxyRequest(`https://${LAN}:${handle.port}/api/state`)
  assert.equal(response.status, 401)
  assert.equal(response.json?.error?.code, 'E_UPSTREAM_SESSION')
  assert.equal(refreshCalls, 1, '最多换一次身份')
  assert.equal(upstreamHits, 2, '最多两次上游请求（不循环重试）')
})

// ---------------------------------------------------------------------------
// 2. 200 透传：状态、字节、自定义响应头
// ---------------------------------------------------------------------------

lanTest('200 透传：状态码 / 正文原始字节 / 自定义响应头都活下来', async (t) => {
  // 正文故意带多字节中文、NUL 与 0xFF：证明走的是字节管道，不是"再编码一次"
  const body = Buffer.concat([
    Buffer.from('{"ok":true,"zh":"平板能看见","tail":', 'utf8'),
    Buffer.from([0x00, 0xff]),
    Buffer.from('}', 'utf8'),
  ])
  const upstream = http.createServer((_req, res) => {
    res.writeHead(201, {
      'content-type': 'application/octet-stream',
      'x-custom-upstream': 'survives',
      'cache-control': 'no-cache',
      'content-length': String(body.length),
    })
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

  const response = await proxyRequest(`https://${LAN}:${handle.port}/asset.js`)
  assert.equal(response.status, 201)
  assert.deepEqual(response.buffer, body, '正文必须逐字节相同')
  assert.equal(response.headers['x-custom-upstream'], 'survives')
  assert.equal(response.headers['cache-control'], 'no-cache', '上游 cache-control 不得被改')
  assert.equal(response.headers['content-type'], 'application/octet-stream')
})

// ---------------------------------------------------------------------------
// 3. 栅栏忠实上游（本模块的验收断言）
// ---------------------------------------------------------------------------

lanTest('栅栏验收：平板的同源 Origin 经代理后被改写成上游 authority ⇒ 假 DSH 回 200', async (t) => {
  const { fake, handle, base, logs } = await setup(t, { listener: { authorize: allowWithInjectedCookie() } })
  const own = `${LAN}:${handle.port}`

  // 先证明这个假上游**真的**会拒（不经代理、直接打它）：外来 Origin → 403
  const directForeign = await directRequest(`${fake.baseUrl}/api/state`, {
    headers: {
      host: `127.0.0.1:${fake.port}`,
      origin: 'https://tablet.elsewhere.example',
      'sec-fetch-site': 'same-origin',
      cookie: INJECTED_COOKIE,
    },
  })
  assert.equal(directForeign.status, 403, '假上游必须自己就会拒外来 Origin（否则本用例没有证明力）')
  fake.state.requests.length = 0

  // 平板真实形态：页面在 https://<own>，POST /api，带自己的会话 cookie
  const proxied = await proxyRequest(`${base}/api/state`, {
    method: 'POST',
    headers: {
      origin: `https://${own}`,
      'sec-fetch-site': 'same-origin',
      cookie: CLIENT_COOKIE,
      'content-type': 'application/json',
    },
    body: '{"q":1}',
  })
  assert.equal(proxied.status, 200, `经代理必须过栅栏（实际 ${String(proxied.status)}）`)
  assert.equal(proxied.headers['x-fence-passed'], 'yes')
  assert.equal(proxied.headers['set-cookie'], undefined, 'owner cookie 绝不能回传平板')
  assert.equal(proxied.json?.ok, true)

  const seen = fake.state.requests[0].headers
  assert.equal(seen.host, `127.0.0.1:${fake.port}`, '上游看到的 Host 是回环（栅栏第一条）')
  assert.equal(seen.origin, `http://127.0.0.1:${fake.port}`, 'Origin 改写成同一 authority（栅栏第三条）')
  assert.equal(seen.cookie, INJECTED_COOKIE, '上游只看到门禁注入的 cookie')
  assert.equal(proxied.json?.sawFetchSite, 'same-origin')

  // 对照组：**未改写**形态（外来 Origin 原样转发）必须仍被同一个假上游 403
  const control = await proxyRequest(`${base}/api/state`, {
    method: 'POST',
    headers: { origin: 'https://tablet.elsewhere.example', 'sec-fetch-site': 'same-origin', cookie: CLIENT_COOKIE },
    body: '{"q":2}',
  })
  assert.equal(control.status, 403, '外来 Origin 必须由 DSH 自己拒（本监听不许替它放宽栅栏）')
  assert.equal(control.text, 'forbidden\n')
  assert.equal(fake.state.requests[1].headers.origin, 'https://tablet.elsewhere.example', '外来 Origin 原样保留')

  // 这条用例一旦有人删掉 Origin 改写，第一条断言就会变成 403 → 立刻失败。
  assert.equal(
    logs.join('\n').includes(INJECTED_COOKIE),
    false,
    '日志里不许出现注入的 cookie 值',
  )
})

lanTest('栅栏验收：cookie 不对 ⇒ 假 DSH 回 401（说明注入的是真身份，不是"发了个 cookie"）', async (t) => {
  const { handle, base } = await setup(t, {
    // 故意注错值：栅栏必须拒绝，证明这条通路不是靠"带 cookie 就放行"
    listener: { authorize: () => ({ kind: 'allow', upstreamHeaders: { cookie: 'dsh-auth-3f9c11=v1.WRONG.SIGNATURE' } }) },
  })
  const response = await proxyRequest(`${base}/api/state`, {
    headers: { origin: `https://${LAN}:${handle.port}`, 'sec-fetch-site': 'same-origin', cookie: CLIENT_COOKIE },
  })
  // 401 被 U1 包装成 typed JSON（平板看不到 DSH 的英文），但状态码仍如实是 401
  assert.equal(response.status, 401)
  assert.equal(response.text, '{"ok":false,"error":{"code":"E_UPSTREAM_SESSION"}}')
  assert.equal(response.text.includes(DSH_UNAUTHORIZED_BODY), false)
})

// ---------------------------------------------------------------------------
// 4. 日志卫生：cookie 与令牌绝不进 log 回调
// ---------------------------------------------------------------------------

lanTest('日志卫生：上游 cookie 与客户端令牌都不出现在 listener 日志里', async (t) => {
  const logs = []
  const { handle, base } = await setup(t, {
    listener: { authorize: allowWithInjectedCookie(), log: (message) => logs.push(message) },
  })
  const own = `${LAN}:${handle.port}`

  // 正常放行 + 带令牌查询串（日志打码必须覆盖它）
  const ok = await proxyRequest(`${base}/api/state?token=${CLIENT_TOKEN}`, {
    headers: { origin: `https://${own}`, cookie: CLIENT_COOKIE },
  })
  assert.equal(ok.status, 200)
  // 上游 403（外来 Origin）：这条路会写诊断日志
  const denied = await proxyRequest(`${base}/api/state?token=${CLIENT_TOKEN}`, {
    headers: { origin: 'https://tablet.elsewhere.example' },
  })
  assert.equal(denied.status, 403)

  // 上游连不上：typed 502 的那条日志
  const deadPort = await freePortOn('127.0.0.1')
  const deadHandle = await startRemoteListener({
    port: 0,
    bindAddress: LAN,
    upstream: { baseUrl: `http://127.0.0.1:${deadPort}` },
    tls: TEST_TLS,
    log: (message) => logs.push(message),
  })
  t.after(async () => {
    await deadHandle.close()
  })
  const down = await proxyRequest(`https://${LAN}:${deadHandle.port}/api/state?token=${CLIENT_TOKEN}`)
  assert.equal(down.status, 502)

  // 上游静默：响应头预算到期的那条日志
  const silentSockets = new Set()
  const silent = net.createServer((socket) => {
    silentSockets.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => silentSockets.delete(socket))
  })
  await listenOnce(silent, 0, '127.0.0.1')
  const silentHandle = await startRemoteListener({
    port: 0,
    bindAddress: LAN,
    upstream: { baseUrl: `http://127.0.0.1:${silent.address().port}` },
    tls: TEST_TLS,
    firstByteTimeoutMs: 120,
    log: (message) => logs.push(message),
  })
  t.after(async () => {
    await silentHandle.close()
    for (const socket of silentSockets) socket.destroy()
    silentSockets.clear()
    await new Promise((resolve) => silent.close(resolve))
  })
  const timedOut = await proxyRequest(`https://${LAN}:${silentHandle.port}/api/state?token=${CLIENT_TOKEN}`)
  assert.equal(timedOut.status, 504)
  assert.equal(timedOut.json?.error?.code, 'E_UPSTREAM_TIMEOUT')
  assert.ok(DEFAULT_UPSTREAM_FIRST_BYTE_TIMEOUT_MS === 15_000)

  const joined = logs.join('\n')
  assert.ok(logs.length > 0, '至少要有诊断日志（否则本用例没覆盖到日志出口）')
  assert.equal(joined.includes(INJECTED_COOKIE), false, '日志不许含注入的 cookie 全值')
  assert.equal(joined.includes('v1.UPSTREAM.SIGNATURE'), false, '日志不许含 cookie 的签名段')
  assert.equal(joined.includes(CLIENT_TOKEN), false, '日志不许含客户端令牌明文')
  assert.equal(joined.includes(CLIENT_COOKIE), false, '日志不许含客户端自己的 cookie')
})

// ---------------------------------------------------------------------------
// 5. 流式（S2）与空闲预算（S1）
// ---------------------------------------------------------------------------

/** 极简裸 TLS 读取器：只按"等到某个字节数/谓词"取值，用来证明流式而不是整包。 */
class RawTlsClient {
  constructor(socket) {
    this.socket = socket
    this.buffer = Buffer.alloc(0)
    this.ended = false
    this.failure = null
    this.waiters = []
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
          waiter.reject(new Error('连接已关闭，期待的数据没来'))
        }
        return
      }
      this.waiters.shift()
      clearTimeout(waiter.timer)
      waiter.resolve(value)
    }
  }

  wait(check, label, timeoutMs = 5_000) {
    return new Promise((resolve, reject) => {
      const waiter = { check, resolve, reject, timer: null }
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((item) => item !== waiter)
        reject(new Error(`等待超时：${label}`))
      }, timeoutMs)
      waiter.timer.unref()
      this.waiters.push(waiter)
      this.pump()
    })
  }

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

  /** 等到缓冲里出现这段文本（跳过 chunked 分块框架，只关心载荷是否已到）。 */
  waitText(needle, label = needle) {
    return this.wait(() => (this.buffer.includes(needle) ? true : undefined), `文本 ${label}`)
  }

  waitClosed(timeoutMs = 5_000) {
    return this.wait(() => (this.ended || this.failure !== null ? true : undefined), '连接关闭', timeoutMs)
  }
}

async function openRawTls(port, host, { path = '/', headers = {} } = {}) {
  const socket = tls.connect({ port, host, rejectUnauthorized: false, servername: host })
  socket.setNoDelay(true)
  await new Promise((resolve, reject) => {
    socket.once('secureConnect', resolve)
    socket.once('error', reject)
  })
  const client = new RawTlsClient(socket)
  const head = Object.entries(headers)
    .map(([key, value]) => `${key}: ${value}\r\n`)
    .join('')
  socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}:${port}\r\nConnection: close\r\n${head}\r\n`)
  return { socket, client }
}

lanTest('流式（S2）：上游先给一块、等一会再给第二块 ⇒ 客户端在结束前就收到第一块', async (t) => {
  /** 上游写第二块前的**注入**等待：断言相对它表达，不用绝对墙钟（负载高时两边一起漂）。 */
  const SECOND_DELAY_MS = 350
  const secondWritten = { at: null }
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.write('FIRST-CHUNK')
    setTimeout(() => {
      secondWritten.at = Date.now()
      res.write('SECOND-CHUNK')
      res.end()
    }, SECOND_DELAY_MS)
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

  const startedAt = Date.now()
  const { socket, client } = await openRawTls(handle.port, LAN, { path: '/stream' })
  try {
    const head = await client.readHead()
    assert.match(head, /HTTP\/1\.1 200 /, head)
    await client.waitText('FIRST-CHUNK')
    const firstAt = Date.now()
    const secondWrittenAtFirstChunk = secondWritten.at
    await client.waitText('SECOND-CHUNK')
    const secondAt = Date.now()
    // 关键断言（**负载不敏感**）：第一块到达时，上游**还没有**开始写第二块。
    // 这比任何墙钟上限都强：整包缓冲的实现只会在 flush 时一起到达，那时 secondWritten.at 已非空。
    assert.equal(
      secondWrittenAtFirstChunk,
      null,
      `第一块必须在上游写第二块之前到达（第一块 ${String(firstAt - startedAt)}ms 到，第二块在 ${String(
        (secondWritten.at ?? 0) - startedAt,
      )}ms 才写）`,
    )
    // 保留一条相对注入延迟的界（不再是原来的绝对 250 ms）：证明第一块不是等到上游结束才吐。
    assert.ok(
      firstAt - startedAt < SECOND_DELAY_MS,
      `第一块必须在注入延迟 ${String(SECOND_DELAY_MS)}ms 内到达（实际 ${String(firstAt - startedAt)}ms）`,
    )
    assert.ok(
      secondAt - firstAt >= SECOND_DELAY_MS / 2,
      `第二块要等上游那 ${String(SECOND_DELAY_MS)}ms 之后才到（实际间隔 ${String(secondAt - firstAt)}ms）`,
    )
  } finally {
    socket.destroy()
  }
})

lanTest('空闲预算（S1）：响应头到了但一个正文字节都没有 ⇒ 504 typed E_UPSTREAM_STALLED', async (t) => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.flushHeaders()
    // 之后一个字节都不写：模拟"TCP 还活着但上游卡住"
  })
  await listenOnce(upstream, 0, '127.0.0.1')
  const handle = await startRemoteListener({
    port: 0,
    bindAddress: LAN,
    upstream: { baseUrl: `http://127.0.0.1:${upstream.address().port}` },
    tls: TEST_TLS,
    idleTimeoutMs: 150,
  })
  t.after(async () => {
    await handle.close()
    await new Promise((resolve) => upstream.close(resolve))
  })

  const startedAt = Date.now()
  const response = await proxyRequest(`https://${LAN}:${handle.port}/api/state`)
  const elapsed = Date.now() - startedAt
  assert.equal(response.status, 504)
  assert.equal(response.json?.error?.code, 'E_UPSTREAM_STALLED')
  assert.ok(elapsed < 5_000, `空闲预算到期后要立刻收口（实际 ${String(elapsed)}ms）`)
})

lanTest('空闲预算（S1）：已经开始回传后卡住 ⇒ 连接被截断，不注入错误页', async (t) => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.write('PARTIAL')
    // 之后不再写、也不 end
  })
  await listenOnce(upstream, 0, '127.0.0.1')
  const handle = await startRemoteListener({
    port: 0,
    bindAddress: LAN,
    upstream: { baseUrl: `http://127.0.0.1:${upstream.address().port}` },
    tls: TEST_TLS,
    idleTimeoutMs: 150,
  })
  t.after(async () => {
    await handle.close()
    await new Promise((resolve) => upstream.close(resolve))
  })

  const { socket, client } = await openRawTls(handle.port, LAN, { path: '/partial' })
  try {
    const head = await client.readHead()
    assert.match(head, /HTTP\/1\.1 200 /, head)
    await client.waitText('PARTIAL')
    // 已经在回传：只能截断，绝不把 HTML/JSON 错误塞进半个正文
    await client.waitClosed(5_000)
    assert.equal(client.buffer.includes('E_UPSTREAM_STALLED'), false)
  } finally {
    socket.destroy()
  }
})

// ---------------------------------------------------------------------------
// 6. 失败隔离（U2）与"加载期绝不抛"（S4）
// ---------------------------------------------------------------------------

lanTest('失败隔离（U2）：上游全挂时 /__dsh_remote/health 仍然 200，面板接口照样回', async (t) => {
  const deadPort = await freePortOn('127.0.0.1')
  const handle = await startRemoteListener({
    port: 0,
    bindAddress: LAN,
    upstream: { baseUrl: `http://127.0.0.1:${deadPort}` },
    tls: TEST_TLS,
    authorize: (input, context) => {
      if (!input.url.startsWith('/__dsh_remote/')) return { kind: 'allow' }
      const res = context.res
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, health: 'up', upstream: 'down' }))
      return { kind: 'respond' }
    },
  })
  t.after(async () => {
    await handle.close()
  })

  const health = await proxyRequest(`https://${LAN}:${handle.port}/__dsh_remote/health`)
  assert.equal(health.status, 200, '上游挂了也不许影响插件自有接口')
  assert.equal(health.json?.ok, true)

  const proxied = await proxyRequest(`https://${LAN}:${handle.port}/api/state`)
  assert.equal(proxied.status, 502, '转发路径才失败（typed）')
  assert.equal(proxied.json?.error?.code, 'E_UPSTREAM_DOWN')
})

test('加载期（S4）：没有 webServer / connection 也不抛，失败只落到 status.lastError', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const path = await import('node:path')
  const { createRemoteService } = await import('../dist/remote/service.js')
  const home = mkdtempSync(path.join(os.tmpdir(), 'dsh-gui-proxy-'))
  const service = createRemoteService({ homeDir: home })
  try {
    // 装配（≈ 插件 load/apply）不许抛
    const state = await service.getState()
    assert.equal(typeof state.status.running, 'boolean')
    assert.equal(state.status.running, false)
    // 起监听也不许抛：缺 webServer/connection/listener 时只给 typed lastError
    const status = await service.start()
    assert.equal(status.running, false)
    assert.ok(status.lastError !== null, '必须给出可读的失败原因')
    assert.match(status.lastError.code, /^E_/)
    await service.dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

lanTest('401 重试会重放请求体：POST 的 body 原样送到上游两次（第一次 401，第二次 200）', async (t) => {
  const NEW_COOKIE = 'dsh-auth-3f9c11=v1.POST.REFRESHED'
  const bodies = []
  const upstream = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      bodies.push(Buffer.concat(chunks).toString('utf8'))
      if (req.headers.cookie !== NEW_COOKIE) {
        res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(DSH_UNAUTHORIZED_BODY)
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, echo: Buffer.concat(chunks).toString('utf8') }))
    })
  })
  await listenOnce(upstream, 0, '127.0.0.1')
  const handle = await startRemoteListener({
    port: 0,
    bindAddress: LAN,
    upstream: { baseUrl: `http://127.0.0.1:${upstream.address().port}` },
    tls: TEST_TLS,
    authorize: () => ({ kind: 'allow', upstreamHeaders: { cookie: INJECTED_COOKIE } }),
    onUpstreamUnauthorized: async () => ({ cookie: NEW_COOKIE }),
  })
  t.after(async () => {
    await handle.close()
    await new Promise((resolve) => upstream.close(resolve))
  })

  const payload = JSON.stringify({ method: 'session.prompt', params: { text: '你好' } })
  const response = await proxyRequest(`https://${LAN}:${handle.port}/api/remote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) },
    body: payload,
  })
  assert.equal(response.status, 200, '重试后必须成功')
  assert.equal(bodies.length, 2, '两次上游请求都要带 body')
  assert.equal(bodies[0], payload)
  assert.equal(bodies[1], payload, '重放的 body 必须与第一次逐字相同')
  assert.equal(response.json?.echo, payload)
})

lanTest('401 不改 chunked 请求体：不可重放的请求只报 typed 会话错误，不缓冲整包', async (t) => {
  let upstreamHits = 0
  const upstream = http.createServer((req, res) => {
    upstreamHits += 1
    req.resume()
    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(DSH_UNAUTHORIZED_BODY)
  })
  await listenOnce(upstream, 0, '127.0.0.1')
  const handle = await startRemoteListener({
    port: 0,
    bindAddress: LAN,
    upstream: { baseUrl: `http://127.0.0.1:${upstream.address().port}` },
    tls: TEST_TLS,
    onUpstreamUnauthorized: async () => ({ cookie: 'dsh-auth-3f9c11=v1.NEVER.USED' }),
  })
  t.after(async () => {
    await handle.close()
    await new Promise((resolve) => upstream.close(resolve))
  })

  const response = await new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: LAN,
        port: handle.port,
        path: '/api/upload',
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'transfer-encoding': 'chunked' },
        agent: false,
        rejectUnauthorized: false,
      },
      (res2) => {
        const chunks = []
        res2.on('data', (chunk) => chunks.push(chunk))
        res2.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json = null
          try {
            json = JSON.parse(text)
          } catch {
            json = null
          }
          resolve({ status: res2.statusCode, text, json })
        })
      },
    )
    request.on('error', reject)
    request.write('chunk-one')
    request.end()
  })

  assert.equal(response.status, 401)
  assert.equal(response.json?.error?.code, 'E_UPSTREAM_SESSION')
  assert.equal(upstreamHits, 1, '不可重放的 chunked 请求不许重试（否则就是整包缓冲）')
})

// ---------------------------------------------------------------------------
// 7. 上游身份缓存（F1 / REVIEW-b11 P2-2）：失败不清缓存、single-flight、门禁自愈
// ---------------------------------------------------------------------------

/**
 * 假 DSH 的**身份兑换口**：成功回 303 + `set-cookie: dsh-auth-*`，失败回 500。
 * `state.hits` 是"到底换了几次身份"的可观测证据（single-flight 的断言依据）。
 */
async function startFakeIdentityExchange(t) {
  const state = { mode: 'ok', hits: 0, cookie: 'dsh-auth-3f9c11=v1.MINT-1', delayMs: 0 }
  const server = http.createServer((_req, res) => {
    state.hits += 1
    const reply = () => {
      if (state.mode !== 'ok') {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('mint failed')
        return
      }
      res.writeHead(303, { location: './', 'set-cookie': `${state.cookie}; Path=/; HttpOnly` })
      res.end()
    }
    if (state.delayMs > 0) setTimeout(reply, state.delayMs)
    else reply()
  })
  await listenOnce(server, 0, '127.0.0.1')
  t.after(() => new Promise((resolve) => server.close(resolve)))
  return { state, port: server.address().port }
}

/**
 * 用**注入的假 listener** 装配一个真 service：不绑端口、不起 TLS，但
 * `authorize` / `onUpstreamUnauthorized` 是真实装配层交下来的那两个回调 ——
 * 被评审点名的正是这条代码路径（`service.ts` 的缓存 + `routes.ts` 的门禁）。
 */
async function startIdentityService(t, exchange, extra = {}) {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const pathModule = await import('node:path')
  const { createRemoteService } = await import('../dist/remote/service.js')
  const { RemoteStore } = await import('../dist/remote/store.js')
  const home = mkdtempSync(pathModule.join(os.tmpdir(), 'dsh-gui-proxy-identity-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  // 起监听的前置条件：配对证书（本用例不会真的用私钥，只是装配层的 fail-closed 门槛）
  new RemoteStore({ homeDir: home }).writeCert(generatePairingCertificate())
  const captured = []
  const service = createRemoteService({
    homeDir: home,
    createGate: () => ({
      exchange: () => ({ ok: false, setCookie: '', reason: 'invalid-token' }),
      // 客户端自己的会话一律视为有效：本用例只考察"上游身份"那一层
      valid: () => true,
      fail: () => ({ limited: false, retryAfterSec: 0 }),
    }),
    startListener: async (options) => {
      captured.push(options)
      return {
        address: options.bindAddress,
        port: options.port,
        close: async () => undefined,
        stats: () => ({ active: 0, total: 0, rejected: 0 }),
        lastError: null,
      }
    },
    webServer: { port: exchange.port },
    connection: { authenticatedUrl: (base) => `${base}?token=launch` },
    ...extra,
  })
  t.after(() => service.dispose())
  // 具体私网 IPv4 字面量：装配层的地址校验与真网卡无关（本用例不会真绑）
  await service.saveSettings({ mode: 'lan', lanAddress: '192.168.1.6', port: 0 })
  return { service, captured, home }
}

/** 走一次真实门禁回调：成功 = allow + 上游 cookie；失败 = 503 typed。 */
function callAuthorize(captured) {
  const options = captured[0]
  return options.authorize({
    method: 'GET',
    url: '/api/state',
    headers: { cookie: 'dsh-remote-session=CLIENT-SESSION-CANARY' },
    remoteAddress: '127.0.0.1',
  })
}

test('F1 上游身份：401 重换失败时旧 cookie 仍可用，门禁不会因此变 503', async (t) => {
  const exchange = await startFakeIdentityExchange(t)
  const { service, captured } = await startIdentityService(t, exchange)
  const started = await service.start()
  assert.equal(started.running, true)
  assert.equal(exchange.state.hits, 1, '启动时换一次身份')
  assert.equal(callAuthorize(captured).kind, 'allow', '有身份时门禁放行')

  // 上游回 401 ⇒ listener 调这个回调；此时假 DSH 兑换口故障（500）
  exchange.state.mode = 'fail'
  const refreshed = await captured[0].onUpstreamUnauthorized()
  assert.deepEqual(
    refreshed,
    { cookie: 'dsh-auth-3f9c11=v1.MINT-1' },
    '换不到身份时把**旧 cookie**交回去，缓存绝不清空',
  )

  // 旧实现（先 `upstream = null`）在这里会连后续请求一起打成 503 E_UPSTREAM_IDENTITY
  const after = callAuthorize(captured)
  assert.equal(after.kind, 'allow', '失败的重换不许把门禁变成 503')
  assert.equal(after.upstreamHeaders.cookie, 'dsh-auth-3f9c11=v1.MINT-1', '仍用那份没被清掉的旧身份')
})

test('F1 上游身份：两个并发 401 只换一次身份（single-flight）', async (t) => {
  const exchange = await startFakeIdentityExchange(t)
  const { service, captured } = await startIdentityService(t, exchange)
  await service.start()
  const before = exchange.state.hits
  exchange.state.delayMs = 80 // 让两次换身份真重叠（否则 single-flight 的证据不成立）
  exchange.state.cookie = 'dsh-auth-3f9c11=v1.MINT-2'

  const results = await Promise.all([
    captured[0].onUpstreamUnauthorized(),
    captured[0].onUpstreamUnauthorized(),
  ])
  assert.equal(exchange.state.hits - before, 1, '两个并发 401 只允许一次换身份')
  assert.deepEqual(results[0], { cookie: 'dsh-auth-3f9c11=v1.MINT-2' })
  assert.deepEqual(results[1], { cookie: 'dsh-auth-3f9c11=v1.MINT-2' }, '两个调用方共享同一个结果')
})

test('F1 上游身份：缓存过期时门禁触发一次后台自愈，下一个请求就有身份', async (t) => {
  const exchange = await startFakeIdentityExchange(t)
  let clock = Date.parse('2026-11-23T00:00:00.000Z')
  const { service, captured } = await startIdentityService(t, exchange, { now: () => new Date(clock) })
  await service.start()
  assert.equal(exchange.state.hits, 1)

  // 让 12 小时 TTL 过期（不重启、不调 start）：这一次只能 fail-closed 503
  clock += 13 * 60 * 60 * 1000
  const stale = callAuthorize(captured)
  assert.equal(stale.kind, 'respond')
  assert.equal(stale.status, 503)
  assert.equal(JSON.parse(stale.body).error.code, 'E_UPSTREAM_IDENTITY')

  // 自愈是 fire-and-forget：轮询门禁等它落地（期间反复问，single-flight 不会多换）
  const deadline = Date.now() + 3_000
  let current = stale
  while (current.kind !== 'allow' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    current = callAuthorize(captured)
  }
  assert.equal(current.kind, 'allow', '下一个请求必须已经有身份（不必等 6 小时定时器）')
  assert.equal(current.upstreamHeaders.cookie, 'dsh-auth-3f9c11=v1.MINT-1')
  assert.equal(exchange.state.hits, 2, '空/过期缓存只触发**一次**后台换身份')
})

// ---------------------------------------------------------------------------
// LAN 台账（P2-B + P2-8）：跳过必须可见，且不可能被当成通过
// ---------------------------------------------------------------------------

/**
 * 缺能力分支的**离线**执行（评审 b11b P2-8 的第三点）：本机有 LAN 地址，所以真实台账的
 * `skipped` 永远是 0，那条断言当次**没跑过**。这里用同一份 `runGatedCase` / `lanLedgerVerdict`，
 * 只把 `missing` 注入成 `true`，把「跳过」跑一遍（不依赖任何环境、不碰网卡）。
 */
test('LAN 台账自检（P2-8）：缺能力分支离线真跑一遍（注入 missing，用例体必须一次都不执行）', async () => {
  const ledger = { total: 0, gated: 0, ran: 0, skipped: 0, staticSkipped: 0, reason: '' }
  const executed = []
  const skips = []
  const fakeT = { skip: (text) => skips.push(text) }
  for (let index = 0; index < 3; index += 1) {
    ledger.total += 1
    ledger.gated += 1
    await runGatedCase(fakeT, {
      fn: () => executed.push(index), gated: true, missing: true, ledger,
    })
  }
  assert.deepEqual(executed, [], '缺能力时用例体一次都不许执行（跳过 ≠ 通过）')
  assert.equal(skips.length, 3, '每一条都要以具名原因跳过')
  assert.match(skips[0], /^LAN-E2E-SKIP：/, '跳过文案必须可诊断（不是静默）')
  assert.equal(ledger.skipped, 3)
  assert.equal(ledger.ran, 0)
  assert.deepEqual(
    lanLedgerVerdict({ total: 3, ran: 0, skipped: 3, missing: true, gated: 3 }).problems, [],
    'ran=0 且 skipped>0 在缺能力时是**合法**结论',
  )

  // 对照组：能力存在时同一份代码必须实跑、0 跳过（否则"注入 missing"就没有证明力）。
  const okLedger = { total: 0, gated: 0, ran: 0, skipped: 0, staticSkipped: 0, reason: '' }
  const okExecuted = []
  for (let index = 0; index < 3; index += 1) {
    okLedger.total += 1
    okLedger.gated += 1
    await runGatedCase(fakeT, { fn: () => okExecuted.push(index), gated: true, missing: false, ledger: okLedger })
  }
  assert.deepEqual(okExecuted, [0, 1, 2], '有能力时必须实跑')
  assert.equal(okLedger.skipped, 0)
  assert.deepEqual(
    lanLedgerVerdict({ total: 3, ran: 3, skipped: 0, missing: false, gated: 3 }).problems, [],
  )
})

/**
 * 裁决函数的边界（P2-8）：每条不变式都要能**单独**被判红，否则"永不失败的函数"没有意义。
 * 这些是纯函数调用，缺能力分支因此在本机（有 LAN 地址）也真的执行过。
 */
test('LAN 台账纯函数（P2-8）：lanLedgerVerdict 的不变式逐条可判红', () => {
  const verdictOf = (input) => lanLedgerVerdict(input)
  // 缺能力：ran=0 / skipped=total（这就是本机跑不到的那条分支）。
  assert.deepEqual(verdictOf({ total: 5, ran: 0, skipped: 5, missing: true }).problems, [])
  // 缺能力却有一条实跑 ⇒ 红。
  assert.equal(verdictOf({ total: 5, ran: 1, skipped: 4, missing: true }).problems.length > 0, true)
  // 缺能力却一条都没跳 ⇒ 红。
  assert.equal(verdictOf({ total: 5, ran: 5, skipped: 0, missing: true }).problems.length > 0, true)
  // 有能力：必须全部实跑、0 跳过。
  assert.deepEqual(verdictOf({ total: 5, ran: 5, skipped: 0, missing: false }).problems, [])
  assert.equal(verdictOf({ total: 5, ran: 4, skipped: 1, missing: false }).problems.length > 0, true)
  // 有注册期跳过时，两种能力状态的期望值都还是精确数。
  assert.deepEqual(verdictOf({ total: 6, ran: 5, skipped: 1, missing: false, gated: 5, staticSkipped: 1 }).problems, [])
  assert.deepEqual(verdictOf({ total: 6, ran: 0, skipped: 6, missing: true, gated: 5, staticSkipped: 1 }).problems, [])
  // 用例"消失"（ran + skipped ≠ total）⇒ 红。
  assert.equal(verdictOf({ total: 5, ran: 2, skipped: 2, missing: false }).problems.length > 0, true)
  // 空账本 / 坏输入 ⇒ 红（守卫不许因为没有登记而恒真）。
  assert.equal(verdictOf({ total: 0, ran: 0, skipped: 0, missing: true }).problems.length > 0, true)
  assert.equal(verdictOf({ total: -1, ran: 0, skipped: 0, missing: false }).problems.length > 0, true)
  assert.equal(verdictOf({ total: 5, ran: 0, skipped: 5, missing: true, gated: 9 }).problems.length > 0, true)
})

/**
 * 台账守卫（评审 b11b P2-8 收口）：`total` 是**本文件全部注册**的条数（登记器唯一入口），
 * `gated` 是其中会因缺 LAN 能力而跳过的子集，`ran` / `skipped` 是运行期实际结果。
 *
 * 本用例注册在所有 `test` / `lanTest` **之后**（含上面两条自检），运行时三条数已经定稿：
 *   · `total > 0` 且 `total > gated`：一条都没登记、或登记器只覆盖 LAN 用例、或有人绕过
 *     登记器，本用例都会失败（旧实现只统计 `lanTest`，这正是缺陷本身）；
 *   · `ran + skipped === total`：跳过与实跑都不许"消失"；
 *   · 缺能力时 `skipped === gated + staticSkipped`、`ran === total - 它`：每一条 LAN 用例都必须
 *     以跳过出现（不可能有哪条悄悄算成通过），非 LAN 用例照常实跑；
 *   · **源码自检**：nodeTest 的直调（带括号）只允许出现一次（唯一包装器里）——这是"每个用例
 *     都经过登记器"的构造性证明，而不是靠人记得用 `lanTest`。
 */
test('LAN 台账（P2-B / P2-8）：登记数 = 实跑数 + 跳过数，且跳过只能发生在能力缺失时', (t) => {
  const { total, gated, ran, skipped, staticSkipped } = LAN_LEDGER
  const capabilityMissing = LAN === null
  const verdict = lanLedgerVerdict({ total, ran, skipped, missing: capabilityMissing, gated, staticSkipped })
  assert.deepEqual(verdict.problems, [], `台账不自洽：${verdict.problems.join('；')}`)

  assert.ok(total > 0, '台账里必须有 >= 1 条用例：0 条说明登记被绕过，这条守卫就失去意义')
  assert.ok(gated > 0, '本文件必须至少有一条 LAN 用例（否则台账没有意义）')
  // 旧台账只统计 `lanTest`；现在 total 必须**多于** LAN 子集，才证明它真的是全量登记数。
  assert.ok(total > gated, `登记总数 ${String(total)} 必须多于 LAN 子集 ${String(gated)}（本文件有非 LAN 用例）`)
  assert.equal(ran + skipped, total, `实跑 ${String(ran)} + 跳过 ${String(skipped)} 必须等于登记 ${String(total)}`)
  const expectedSkipped = (capabilityMissing ? gated : 0) + staticSkipped
  assert.equal(
    skipped,
    expectedSkipped,
    `跳过数 ${String(skipped)} 与本机能力（缺失=${String(capabilityMissing)}）不一致：有能力时一条 LAN 用例都不许跳过`,
  )
  assert.equal(
    ran,
    total - expectedSkipped,
    `实跑数 ${String(ran)} 与本机能力（缺失=${String(capabilityMissing)}）不一致：缺能力时 LAN 用例一条都不许实跑`,
  )

  // 源码自检：node:test 只允许在唯一包装器里被调用一次。用拼接构造针，避免这段源码自己命中。
  const source = readFileSync(new URL(import.meta.url), 'utf8')
  const needle = `node${'Test'}(`
  const hits = source.split(needle).length - 1
  assert.equal(hits, 1, `node:test 直调必须恰好 1 处（唯一包装器里），实际 ${String(hits)} 处`)

  const reason = capabilityMissing
    ? lanSkipReason(gated)
    : `能力存在：可绑定且可自连的 ${String(LAN)}（${String(gated)} 条 LAN 用例全部实跑，0 跳过）`
  t.diagnostic(reason)
  console.log(
    `[LAN-LEDGER] registered=${String(total)} gated=${String(gated)}`
    + ` ran=${String(ran)} skipped=${String(skipped)} | ${reason}`,
  )
})

