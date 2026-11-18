#!/usr/bin/env node
/**
 * 重启 DSH 之后的一键自检（**只读**，不改配置、不重启任何东西）。
 *
 * 用途：确认「本插件真的进了运行链路」，并验证远程访问的核心链路。
 *
 *   1. 端口发现 + DSH 指纹（无令牌也能跑）
 *   2. 登录换 cookie（需要 --token，来自 `dsh web` 打印的地址里的 ?token=）
 *   3. 插件在链路里：POST /dsh-dots/rpc {action:'remoteGetState'}
 *   4. 同步域仍健康（失败隔离的反证）
 *   5. 旁挂监听（若在运行）：/__dsh_remote/health 200、令牌换 cookie 303、
 *      WS /api/remote.mux 带 cookie 101、无 cookie 必须不是 101
 *
 * 用法：
 *   node packages/dsh-dots/tools/post-restart-check.mjs --token <launch token>
 *   node ... --port 40596 --token <token>
 *   node ... --token <token> --lan 192.168.1.6
 *   node ... --token <token> --no-ws
 *
 * 退出码：0 全通过；1 有失败项；2 参数/环境问题（找不到端口、缺 token/换不到 cookie）。
 */
import http from 'node:http'
import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
function arg(name, fallback = '') {
  const at = args.indexOf(`--${name}`)
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback
}
const flag = (name) => args.includes(`--${name}`)

const token = arg('token', process.env.DSH_TOKEN ?? '')
const explicitPort = Number.parseInt(arg('port', '0'), 10)
const lanHint = arg('lan', '')
const skipWs = flag('no-ws')

const results = []
function record(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  ${detail}`}`)
}
function info(text) {
  console.log(`      ${text}`)
}

function requestOn(host, port, path, options = {}) {
  const { method = 'GET', headers = {}, body } = options
  return new Promise((resolve) => {
    const req = http.request({ host, port, path, method, headers }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.setTimeout(5000, () => req.destroy(new Error('timeout')))
    req.on('error', (error) => resolve({ status: 0, headers: {}, body: '', error: error.message }))
    if (body !== undefined) req.write(body)
    req.end()
  })
}

function listeningPorts() {
  try {
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', 'Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort | Sort-Object -Unique'],
      { encoding: 'utf8', timeout: 25000 },
    )
    return out
      .split(/\r?\n/)
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((n) => Number.isInteger(n) && n > 0)
  } catch {
    return []
  }
}

async function findDshPort() {
  if (Number.isInteger(explicitPort) && explicitPort > 0) return explicitPort
  const candidates = listeningPorts()
  info(`scanning ${candidates.length} local listening ports...`)
  for (const port of candidates) {
    const res = await requestOn('127.0.0.1', port, '/')
    if (res.error !== undefined) continue
    if (res.status === 401 && /dsh web authentication required/i.test(res.body ?? '')) return port
    if (res.status === 200 && /DeepSeek Harness/i.test(res.body ?? '')) return port
  }
  return 0
}

function upgradeWs(host, port, path, cookie) {
  return new Promise((resolve) => {
    const req = http.request({
      host,
      port,
      path,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        ...(cookie === '' ? {} : { cookie }),
      },
    })
    const timer = setTimeout(() => resolve({ ok: false, detail: 'timeout' }), 6000)
    req.on('upgrade', (res, socket) => {
      clearTimeout(timer)
      socket.destroy()
      resolve({ ok: res.statusCode === 101, detail: `status=${res.statusCode}` })
    })
    req.on('response', (res) => {
      clearTimeout(timer)
      res.resume()
      resolve({ ok: false, detail: `no-upgrade status=${res.statusCode}` })
    })
    req.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, detail: `error=${error.message}` })
    })
    req.end()
  })
}

function rpc(port, cookie, payload) {
  return requestOn('127.0.0.1', port, '/dsh-dots/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie === '' ? {} : { cookie }) },
    body: JSON.stringify(payload),
  })
}

const port = await findDshPort()
if (port === 0) {
  console.error('no DSH listening port found; pass --port <port> (the one in the dsh web URL)')
  process.exit(2)
}
record('dsh-port', true, `127.0.0.1:${port}`)

if (token === '') {
  console.error('missing --token; pass the ?token= value from the dsh web URL (this script never prints it)')
  process.exit(2)
}

const login = await requestOn('127.0.0.1', port, `/?token=${encodeURIComponent(token)}`)
const setCookie = (login.headers['set-cookie'] ?? []).map((line) => line.split(';')[0]).join('; ')
record('login-token-exchange', login.status === 303 && setCookie !== '', `status=${login.status}`)
if (setCookie === '') {
  console.error('could not exchange the launch token for a session cookie (token expired? DSH rotates it on restart)')
  process.exit(2)
}

const stateRes = await rpc(port, setCookie, { action: 'remoteGetState' })
let state = null
try {
  state = JSON.parse(stateRes.body ?? '')
} catch {
  state = null
}
const pluginOk = stateRes.status === 200 && state?.ok === true && Array.isArray(state?.data?.modes) && state.data.modes.length === 6
record('plugin-in-path', pluginOk, pluginOk ? `modes=${state.data.modes.length}` : `status=${stateRes.status} body=${(stateRes.body ?? '').slice(0, 120)}`)
if (pluginOk) {
  const settings = state.data.settings
  info(`settings: enabled=${settings.enabled} mode=${settings.mode} port=${settings.port} lan=${settings.lanAddress === '' ? '(auto)' : settings.lanAddress} tokenSet=${settings.tokenSet}`)
  info(`status: running=${state.data.status.running} listen=${state.data.status.listen ?? '(none)'}`)
}

const syncRes = await rpc(port, setCookie, { action: 'getState' })
let syncOk = false
try {
  syncOk = syncRes.status === 200 && JSON.parse(syncRes.body ?? '{}').ok === true
} catch {
  syncOk = false
}
record('sync-domain-healthy', syncOk, `status=${syncRes.status}`)

const listen = pluginOk ? state.data.status.listen : null
if (listen === null || listen === undefined) {
  info('sidecar not running: start it in the settings page (or RPC remoteStart), then rerun to check /__dsh_remote/*.')
} else {
  const cut = listen.lastIndexOf(':')
  const host = listen.slice(0, cut)
  const listenPort = Number.parseInt(listen.slice(cut + 1), 10)
  const health = await requestOn(host, listenPort, '/__dsh_remote/health')
  record('sidecar-health', health.status === 200 && /"ok":true/.test(health.body ?? ''), `${listen} status=${health.status}`)

  if (!skipWs) {
    const linkRes = await rpc(port, setCookie, { action: 'remoteShowLink' })
    let remoteUrl = ''
    try {
      remoteUrl = JSON.parse(linkRes.body ?? '{}').data.url ?? ''
    } catch {
      remoteUrl = ''
    }
    if (remoteUrl === '') {
      record('sidecar-ws-101', false, 'remoteShowLink returned no url (no token?)')
    } else {
      const remoteToken = new URL(remoteUrl).searchParams.get('token') ?? ''
      const exchange = await requestOn(host, listenPort, `/?token=${encodeURIComponent(remoteToken)}`)
      const remoteCookie = (exchange.headers['set-cookie'] ?? []).map((line) => line.split(';')[0]).join('; ')
      record('sidecar-token-exchange', exchange.status === 303 && remoteCookie !== '', `status=${exchange.status}`)
      const ws = await upgradeWs(host, listenPort, '/api/remote.mux', remoteCookie)
      record('sidecar-ws-101', ws.ok, ws.detail)
      const wsNoCookie = await upgradeWs(host, listenPort, '/api/remote.mux', '')
      record('sidecar-ws-needs-auth', !wsNoCookie.ok, wsNoCookie.detail)
    }
  }

  if (lanHint !== '') info(`for the app: http://${lanHint}:${listenPort}/`)
}

const failed = results.filter((item) => !item.ok)
console.log(`\nSUMMARY ${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) {
  console.log(`FAILED: ${failed.map((item) => `${item.name}(${item.detail})`).join(', ')}`)
  process.exit(1)
}
