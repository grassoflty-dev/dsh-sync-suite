/**
 * 涓€娆℃€ч獙璇侊紙涓嶈繘浠撳簱锛夛細`ipv6` 鏂瑰紡鑳藉惁鐪熺殑缁戜笂鏈満鍏綉 v6 骞跺澶栨湇鍔°€? * 鐢ㄦ硶锛欴SH_UPSTREAM_TOKEN=<token> V6=<鏈満鍏綉 v6> node .tmp/e2e-ipv6.mjs
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const UPSTREAM_PORT = 3080
const LISTEN_PORT = 3098
const token = process.env.DSH_UPSTREAM_TOKEN ?? ''
const v6 = process.env.V6 ?? ''
if (token === '' || v6 === '') {
  console.error('missing DSH_UPSTREAM_TOKEN / V6')
  process.exit(2)
}

const { createRemoteModule } = await import('../dist/remote/index.js')
const home = await mkdtemp(path.join(tmpdir(), 'dsh-e2e6-'))
const mod = createRemoteModule({
  homeDir: home,
  webServer: { port: UPSTREAM_PORT },
  connection: { authenticatedUrl: (base) => `${base}?token=${token}` },
})

await mod.service.saveSettings({ enabled: true, mode: 'ipv6', ipv6Address: v6, port: LISTEN_PORT })
const status = await mod.service.start()
console.log('start:', JSON.stringify({ running: status.running, listen: status.listen, err: status.lastError }))
if (!status.running) process.exit(1)

const base = `http://[${v6}]:${LISTEN_PORT}`
const health = await fetch(`${base}/__dsh_remote/health`)
const body = await health.text()
console.log('health over v6:', health.status, body.slice(0, 100))

const denied = await fetch(`${base}/`, { redirect: 'manual' })
console.log('root without token:', denied.status)

const link = await mod.service.showLink()
const url = new URL(link.url)
const exchange = await fetch(url.href, { redirect: 'manual' })
const cookie = (exchange.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('')
console.log('token exchange:', exchange.status, 'cookie-set:', cookie !== '')

const authorized = await fetch(`${base}/`, { headers: { cookie }, redirect: 'manual' })
const html = await authorized.text()
console.log('authorized root:', authorized.status, 'bytes:', html.length)

const probe = await mod.service.probe('ipv6')
console.log('probe:', probe.level, probe.verdict)
for (const check of probe.checks) console.log(`  ${check.level.padEnd(7)} ${check.id.padEnd(22)} ${check.message}`)

await mod.service.dispose()
const ok = health.status === 200 && denied.status === 401 && authorized.status === 200
console.log(ok ? 'IPV6-E2E PASS' : 'IPV6-E2E FAIL')
process.exit(ok ? 0 : 1)

