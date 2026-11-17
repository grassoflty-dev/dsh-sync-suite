/**
 * 绔埌绔獙璇侊紙涓€娆℃€ц剼鏈紝涓嶈繘浠撳簱锛夛細鎶婅繙绋嬭闂煙鎺ュ埌**鐪熷疄杩愯涓殑 DSH web 瀹炰緥**
 * 锛?27.0.0.1:3080锛寃eb profile锛変笂锛岄獙璇侊細
 *   1) 浠ょ墝闂紙鏃犱护鐗?401銆佹湁浠ょ墝 303 鎹?cookie锛? *   2) 甯︿笂 cookie 鍚庤兘鐪熸鎷垮埌涓婃父棣栭〉锛?00 HTML锛? *   3) /api/* 鏈巿鏉冭蛋 JSON 401
 *   4) WebSocket upgrade 鑳借蛋閫氾紙/api/remote.mux 101锛? *   5) /__dsh_remote/health 鏃犵瀵? *
 * 鐢ㄦ硶锛欴SH_UPSTREAM_TOKEN=<launch token> node .tmp/e2e-remote.mjs
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import http from 'node:http'

const UPSTREAM_PORT = 3080
const LAN = '192.168.1.6'
const LISTEN_PORT = 3099
const token = process.env.DSH_UPSTREAM_TOKEN ?? ''
if (token === '') {
  console.error('missing DSH_UPSTREAM_TOKEN')
  process.exit(2)
}

const { createRemoteModule } = await import('../dist/remote/index.js')
const home = await mkdtemp(path.join(tmpdir(), 'dsh-e2e-'))
const mod = createRemoteModule({
  homeDir: home,
  webServer: { port: UPSTREAM_PORT },
  connection: { authenticatedUrl: (base) => `${base}?token=${token}` },
})

const results = []
function record(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail ?? ''}`)
}

await mod.service.saveSettings({ enabled: true, mode: 'lan', lanAddress: LAN, port: LISTEN_PORT })
const status = await mod.service.start()
record('start', status.running === true, JSON.stringify({ lastError: status.lastError, listen: status.listen }))
if (!status.running) {
  console.log('ABORT: listener not running')
  process.exit(1)
}

const base = `http://${LAN}:${LISTEN_PORT}`

// 1) health锛堟棤浠ょ墝锛?const health = await fetch(`${base}/__dsh_remote/health`)
const healthBody = await health.text()
record('health-200', health.status === 200, healthBody.slice(0, 120))
record('health-no-secret', !healthBody.includes(token) && !healthBody.includes('dsh-auth-'), '')

// 2) 鏃犱护鐗岄椤?鈫?401
const denied = await fetch(`${base}/`, { redirect: 'manual' })
record('root-401', denied.status === 401, `status=${denied.status}`)

// 3) 鏈巿鏉?/api 鈫?JSON 401
const apiDenied = await fetch(`${base}/api/sessions`, { redirect: 'manual' })
record('api-401-json', apiDenied.status === 401 && (apiDenied.headers.get('content-type') ?? '').includes('json'), `status=${apiDenied.status}`)

// 4) 鎷块摼鎺ワ紙鍞竴甯?token 鐨勫嚭鍙ｏ級鈫?鐢?token 鎹?cookie
const link = await mod.service.showLink()
const linkUrl = new URL(link.url)
record('showLink-has-token', linkUrl.searchParams.get('token') !== null && link.qr.size > 0, `qr=${link.qr.size}`)
const exchange = await fetch(`${base}/?token=${encodeURIComponent(linkUrl.searchParams.get('token'))}`, { redirect: 'manual' })
const setCookie = exchange.headers.getSetCookie?.() ?? []
const sessionCookie = setCookie.map((c) => c.split(';')[0]).find((c) => c !== undefined) ?? ''
record('token-303', exchange.status === 303, `status=${exchange.status} set-cookie=${setCookie.length}`)
record('cookie-not-upstream', setCookie.every((c) => !c.startsWith('dsh-auth-')), 'no dsh-auth-* leaked')

// 5) 甯?cookie 璁块棶棣栭〉 鈫?200 HTML锛堢湡姝ｆ墦閫氶毀閬擄級
const authorized = await fetch(`${base}/`, { headers: { cookie: sessionCookie }, redirect: 'manual' })
const html = await authorized.text()
record('root-200-proxied', authorized.status === 200 && html.includes('<'), `status=${authorized.status} bytes=${html.length}`)
record('no-upstream-cookie-leak', setCookie.every((c) => !c.toLowerCase().includes('dsh-auth')), '')

// 6) WebSocket upgrade 璧伴€氾紙/api/remote.mux锛?const wsResult = await new Promise((resolve) => {
  const req = http.request({
    host: LAN,
    port: LISTEN_PORT,
    path: '/api/remote.mux',
    headers: {
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-version': '13',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      cookie: sessionCookie,
    },
  })
  const timer = setTimeout(() => resolve({ ok: false, detail: 'timeout' }), 8000)
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
record('ws-101', wsResult.ok, wsResult.detail)

// 7) 閿欒浠ょ墝 鈫?401锛屼笖鍝嶅簲浣撲笉鍚?token
const bad = await fetch(`${base}/?token=definitely-wrong-token-value`, { redirect: 'manual' })
const badBody = await bad.text()
record('bad-token-401', bad.status === 401, `status=${bad.status}`)
record('bad-token-not-echoed', !badBody.includes('definitely-wrong-token-value'), '')

await mod.service.dispose()

const failed = results.filter((r) => !r.ok)
console.log(`\nSUMMARY ${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) {
  console.log('FAILED:', failed.map((f) => `${f.name}(${f.detail})`).join(', '))
  process.exit(1)
}

