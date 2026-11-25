/**
 * mod-plugin-lan-address-selection：局域网**选路**的定向测试。
 *
 * 背景（真机实测的缺陷）：旁挂监听绑到了 `192.168.137.1`（`本地连接* 16`，Hyper-V / Wi-Fi Direct
 * 虚拟适配器，手动配置），而本机默认路由在 `WLAN 3`（`192.168.1.5`）；平板在 `192.168.1.0/24`，
 * 永远路由不到 `192.168.137.1` —— 表现就是用户长期的"连接失败超时"。
 * 机械成因：旧代码只用**网卡名正则**判虚拟网卡（中文名 `本地连接* 16` 匹配不到 `vEthernet`），
 * 然后按**枚举顺序**取第一个私网地址。
 *
 * 本文件钉住的规则（顺序即优先级）：
 *   1. 显式覆盖（设置里的 `lanAddress`）→ 用它并说明"这是你手填的"；
 *   2. 默认路由地址（`probeRouteAddress`）→ 用它；
 *   3. 候选规则（排除回环 / APIPA / 链路本地 / 隧道 / 虚拟网卡，RFC1918 优先）；
 *   4. 没有可用地址 → typed/可见失败，**绝不**给 `0.0.0.0`。
 *
 * 全部用**注入的网卡表与路由值**，不依赖这台机器真实的 NIC；只有一条"探测本身不抛且有时界"
 * 的用例读真机（无网卡时同样成立）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  createRemoteService,
  isVirtualIfaceName,
  listLanCandidates,
  pickLanAddress,
  probeRouteAddress,
  provisionedMirrorLanAddress,
  resolveLanSelection,
} from '../dist/remote/service.js'
import { isBindableIpv6Address, isBindableLanAddress } from '../dist/remote/listener.js'
import { defaultRemoteSettings } from '../dist/remote/accessMode.js'
import { RemoteStore } from '../dist/remote/store.js'
import { generatePairingCertificate } from '../dist/remote/pairingTls.js'

/* ------------------------------------------------------------------ 假网卡表 */

const NIC = (address, family = 'IPv4', iface = 'WLAN 3', virtual = false) => ({ address, iface, family, virtual })

/** 真机上的形态：虚拟网卡**排第一**，真实默认路由地址排第二。 */
const REAL_MACHINE_ORDER = () => [
  NIC('192.168.137.1', 'IPv4', '本地连接* 16', true),
  NIC('192.168.1.5', 'IPv4', 'WLAN 3', false),
]

const V6_GLOBAL = '2409:8a20:4caa:220:96bd:f9db:6bb7:af27'

/* -------------------------------------------------------------- 纯规则（L-01…） */

test('L-01 回归：默认路由地址胜出，即使它不在枚举顺序的第一位', () => {
  const selection = resolveLanSelection({ candidates: REAL_MACHINE_ORDER(), routeAddress: '192.168.1.5' })
  assert.equal(selection.address, '192.168.1.5', '必须按路由选，不能按枚举顺序')
  assert.equal(selection.source, 'route')
  assert.equal(selection.routeAddress, '192.168.1.5')
  // 反证（缺陷成因）：枚举顺序里第一个 IPv4 正是那个虚拟地址，
  // 而**旧**的虚拟网卡正则对中文名完全失效 —— 于是一路被当成真网卡选中。
  assert.equal(REAL_MACHINE_ORDER().filter((item) => item.family === 'IPv4')[0].address, '192.168.137.1')
  const LEGACY_VIRTUAL_RE = /(vEthernet|VMware|VirtualBox|Hyper-V|Loopback|Teredo|isatap|docker|veth|br-|WSL|Tailscale)/i
  assert.equal(LEGACY_VIRTUAL_RE.test('本地连接* 16'), false, '旧正则看不见中文虚拟适配器，这就是缺陷本身')
  assert.equal(isVirtualIfaceName('本地连接* 16'), true, '新规则必须能看见它')
})

test('L-02 虚拟网卡排第一时被跳过，且候选表如实标注原因', () => {
  const selection = resolveLanSelection({ candidates: REAL_MACHINE_ORDER(), routeAddress: '192.168.1.5' })
  const virtualOne = selection.candidates.find((item) => item.address === '192.168.137.1')
  assert.ok(virtualOne !== undefined)
  assert.equal(virtualOne.virtual, true)
  assert.equal(virtualOne.rejected, '虚拟网卡')
  assert.equal(virtualOne.route, false)
  const real = selection.candidates.find((item) => item.address === '192.168.1.5')
  assert.equal(real.route, true)
  assert.equal(real.rejected, '')
  assert.match(selection.reason, /192\.168\.1\.5/)
  assert.match(selection.reason, /已跳过 1 个候选（虚拟网卡）/, '跳过必须可见，不许静默')
})

test('L-03 APIPA、链路本地 IPv6、Teredo/6to4 隧道都被排除', () => {
  const selection = resolveLanSelection({
    candidates: [
      NIC('169.254.10.20', 'IPv4', '以太网 2'),
      NIC('fe80::215b:b8fd:6849:fdd1', 'IPv6', 'WLAN 3'),
      NIC('2001:0:2841:2f0c:1c21:492b:c3c8:cd47', 'IPv6', 'Teredo Tunneling Pseudo-Interface'),
      NIC('2002:c0a8:105::1', 'IPv6', 'WLAN 3'),
      NIC('192.168.1.5', 'IPv4', 'WLAN 3'),
    ],
    routeAddress: null,
  })
  assert.equal(selection.address, '192.168.1.5')
  assert.equal(selection.source, 'fallback')
  const byAddress = (needle) => selection.candidates.find((item) => item.address === needle)
  assert.equal(byAddress('169.254.10.20').rejected, 'APIPA 链路本地')
  assert.equal(byAddress('fe80::215b:b8fd:6849:fdd1').rejected, '链路本地 IPv6')
  assert.equal(byAddress('2001:0:2841:2f0c:1c21:492b:c3c8:cd47').rejected, 'Teredo/6to4 隧道')
  assert.equal(byAddress('2002:c0a8:105::1').rejected, 'Teredo/6to4 隧道')
  assert.match(selection.reason, /没探测到默认路由/)
})

test('L-04 显式覆盖优先，并如实说明"这是你手填的"（含与路由不一致的告警）', () => {
  const sameAsRoute = resolveLanSelection({
    candidates: REAL_MACHINE_ORDER(),
    routeAddress: '192.168.1.5',
    override: '192.168.1.5',
  })
  assert.equal(sameAsRoute.address, '192.168.1.5')
  assert.equal(sameAsRoute.source, 'override')
  assert.match(sameAsRoute.reason, /你手填的局域网地址/)
  assert.match(sameAsRoute.reason, /与默认路由一致/)

  const different = resolveLanSelection({
    candidates: REAL_MACHINE_ORDER(),
    routeAddress: '192.168.1.5',
    override: '192.168.137.1',
  })
  assert.equal(different.address, '192.168.137.1', '覆盖必须赢（运维的逃生舱）')
  assert.equal(different.source, 'override')
  assert.match(different.reason, /192\.168\.1\.5/, '必须点名真正的默认路由地址')
  assert.match(different.reason, /清空「局域网地址」/, '必须给出可见的下一步')

  const invalid = resolveLanSelection({ candidates: REAL_MACHINE_ORDER(), routeAddress: '192.168.1.5', override: '0.0.0.0' })
  assert.equal(invalid.address, null, '通配覆盖必须 typed 拒绝，不许回落')
  assert.match(invalid.reason, /不是可绑定的具体私网 IPv4/)
})

test('L-05 只有虚拟 / APIPA 候选 ⇒ typed/可见结果，绝不广播 0.0.0.0 或虚拟地址', () => {
  const selection = resolveLanSelection({
    candidates: [NIC('192.168.137.1', 'IPv4', '本地连接* 16', true), NIC('169.254.3.4', 'IPv4', '以太网 2')],
    routeAddress: null,
  })
  assert.equal(selection.address, null)
  assert.equal(selection.source, 'none')
  assert.match(selection.reason, /没找到可用的局域网 IPv4/)
  assert.match(selection.reason, /虚拟网卡/)
  assert.match(selection.reason, /APIPA/)
  assert.equal(selection.reason.includes('0.0.0.0'), false, '原因行里不许把通配地址当答案')
})

test('L-06 中文虚拟网卡名与常见英文族都判得出（名字启发式，次级判据）', () => {
  const virtual = [
    '本地连接* 16', '本地连接* 1', 'vEthernet (Default Switch)', 'VMware Network Adapter VMnet8',
    'VirtualBox Host-Only Network', 'Hyper-V Virtual Ethernet Adapter', 'Loopback Pseudo-Interface 1',
    'Teredo Tunneling Pseudo-Interface', 'isatap.example.com', 'docker0', 'veth1234', 'br-9f2a1c',
    'WSL', 'Tailscale', '以太网 2 虚拟网卡',
  ]
  for (const name of virtual) assert.equal(isVirtualIfaceName(name), true, `${name} 应判为虚拟`)
  const real = ['WLAN', 'WLAN 3', '以太网', '以太网 2', '本地连接', 'Ethernet 2', 'Wi-Fi']
  for (const name of real) assert.equal(isVirtualIfaceName(name), false, `${name} 是真实网卡，不许误伤`)
})

test('L-06b listLanCandidates：注入表时保留中文虚拟网卡标记，并跳过 internal', () => {
  const list = listLanCandidates({
    '本地连接* 16': [
      { address: '192.168.137.1', netmask: '255.255.255.0', family: 'IPv4', mac: '', internal: false, cidr: null },
    ],
    'WLAN 3': [
      { address: '192.168.1.5', netmask: '255.255.255.0', family: 'IPv4', mac: '', internal: false, cidr: null },
      { address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '', internal: true, cidr: null },
    ],
  })
  assert.equal(list.length, 2, 'internal（回环）必须被跳过')
  const virtualOne = list.find((item) => item.address === '192.168.137.1')
  const realOne = list.find((item) => item.address === '192.168.1.5')
  assert.equal(virtualOne.virtual, true)
  assert.equal(realOne.virtual, false)
  // pickLanAddress 是旧调用点的兼容出口：只看候选表时不该选虚拟网卡。
  assert.equal(pickLanAddress(list), '192.168.1.5')
})

test('L-07 候选分类与监听准入门槛同源：可选中 ⇒ 可绑定（反之亦不让不可绑定的混进来）', () => {
  const addresses = ['192.168.1.5', '10.1.2.3', '172.20.0.9', '100.64.0.7', '169.254.1.1', '127.0.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '8.8.8.8']
  for (const address of addresses) {
    const selection = resolveLanSelection({ candidates: [NIC(address)], routeAddress: null })
    const selectable = selection.address !== null
    assert.equal(selectable, isBindableLanAddress(address), `${address}：选中与否必须与 isBindableLanAddress 一致`)
  }
})

/* ------------------------------------------------------- IPv6 路径保持原样（L-08） */

test('L-08 IPv6 直连判定与既有行为一致（不因本模块收紧或放宽）', () => {
  assert.equal(isBindableIpv6Address(V6_GLOBAL), true)
  assert.equal(isBindableIpv6Address('fd00::1'), true)
  for (const rejected of ['', '::', '::1', 'fe80::1', 'ff02::1', '::ffff:192.168.1.6', `[${V6_GLOBAL}]`, `${V6_GLOBAL}%eth0`]) {
    assert.equal(isBindableIpv6Address(rejected), false, `${JSON.stringify(rejected)} 必须被拒`)
  }
  // 候选表里链路本地 v6 不会被当成"可选"
  const selection = resolveLanSelection({ candidates: [NIC('fe80::1', 'IPv6'), NIC(V6_GLOBAL, 'IPv6')], routeAddress: null })
  assert.equal(selection.candidates.find((item) => item.address === V6_GLOBAL).rejected, '')
  assert.equal(selection.candidates.find((item) => item.address === 'fe80::1').rejected, '链路本地 IPv6')
  // 局域网方式不跨族兜底（绑定 v6 会让载荷语义变成 ipv6 传输）
  assert.equal(selection.address, null)
})

/* ------------------------------------------------------ 服务级：绑定 == 广播（L-09） */

async function makeHome(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'dsh-lan-sel-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  return home
}

function seedCert(home) {
  new RemoteStore({ homeDir: home }).writeCert(generatePairingCertificate())
}

async function startFakeDsh(t) {
  const server = http.createServer((_req, res) => {
    res.writeHead(303, { location: './', 'set-cookie': 'dsh-auth-deadbeef=session-value; Path=/; HttpOnly' })
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(() => resolve())))
  return { server, port: server.address().port }
}

function fakeGate() {
  return {
    exchange: () => ({ ok: false, setCookie: '', reason: 'invalid-token' }),
    valid: () => false,
    fail: () => ({ limited: false, retryAfterSec: 0 }),
    setToken: () => undefined,
  }
}

/** 假 listener：记录入参并回报一个**由调用方指定**的绑定地址。 */
function fakeListener(boundAddress) {
  const calls = []
  return {
    calls,
    start: async (options) => {
      calls.push(options)
      return {
        address: boundAddress ?? options.bindAddress,
        port: options.port,
        close: async () => undefined,
        stats: () => ({ active: 0, total: 0, rejected: 0 }),
        lastError: null,
      }
    },
  }
}

async function makeService(t, options = {}) {
  const home = await makeHome(t)
  seedCert(home)
  const fake = await startFakeDsh(t)
  const service = createRemoteService({
    homeDir: home,
    createGate: () => fakeGate(),
    startListener: options.startListener,
    webServer: { port: fake.port },
    connection: { authenticatedUrl: (base) => `${base}?token=launch` },
    ...(options.interfaces === undefined ? {} : { interfaces: options.interfaces }),
    ...(options.routeProbeAddress === undefined ? {} : { routeProbeAddress: options.routeProbeAddress }),
    ...(options.provisionedLanAddress === undefined ? {} : { provisionedLanAddress: options.provisionedLanAddress }),
  })
  t.after(async () => {
    await service.dispose()
  })
  return { home, service }
}

test('L-09 回归：广播地址恒等于监听句柄的绑定地址（不是重新挑选的结果）', async (t) => {
  // 假 listener 故意回报一个与请求不同的地址（真实监听不会这样）：用来证明 URL/状态取自**句柄**。
  const listener = fakeListener('192.168.1.77')
  const { service } = await makeService(t, {
    startListener: listener.start,
    interfaces: REAL_MACHINE_ORDER,
    routeProbeAddress: () => '192.168.1.5',
  })
  await service.saveSettings({ mode: 'lan', lanAddress: '', port: 0 })
  const status = await service.start()

  assert.equal(status.running, true, JSON.stringify(status.lastError))
  assert.equal(listener.calls.length, 1)
  assert.equal(listener.calls[0].bindAddress, '192.168.1.5', '必须先按默认路由解析出绑定地址')
  assert.equal(status.boundAddress, '192.168.1.77', '状态里的绑定地址必须来自句柄')
  assert.equal(status.listen, `192.168.1.77:${String(listener.calls[0].port)}`)
  assert.equal(status.urls.length, 1)
  assert.match(status.urls[0].url, /^https:\/\/192\.168\.1\.77:/, 'URL 必须用句柄地址，不是重新挑的地址')
  assert.match(status.urls[0].note, /实际绑定并广播的是 192\.168\.1\.77/, '不一致时状态行必须如实点名')

  // 再取一次状态：仍然只认句柄（过程中换网/换网卡都不会让广播地址漂移）。
  const again = await service.getState()
  assert.equal(again.status.urls[0].url, status.urls[0].url)
  assert.equal(again.status.boundAddress, '192.168.1.77')
})

test('L-10 无候选时 start() typed 拒绝（E_NO_BIND_ADDRESS），错误里不含 0.0.0.0', async (t) => {
  const listener = fakeListener()
  const { service } = await makeService(t, {
    startListener: listener.start,
    interfaces: () => [NIC('192.168.137.1', 'IPv4', '本地连接* 16', true), NIC('169.254.3.4', 'IPv4', '以太网 2')],
    routeProbeAddress: () => null,
  })
  await service.saveSettings({ mode: 'lan', lanAddress: '', port: 0 })
  const status = await service.start()
  assert.equal(status.running, false)
  assert.equal(status.lastError.code, 'E_NO_BIND_ADDRESS')
  assert.match(status.lastError.message, /没找到可用的局域网 IPv4/)
  assert.match(status.lastError.message, /虚拟网卡/)
  assert.equal(status.lastError.message.includes('0.0.0.0'), false)
  assert.equal(listener.calls.length, 0, '没有可用地址就不许起监听')
})

test('L-11 只找到虚拟网卡时状态行明说，而不是广播不可达地址', async (t) => {
  const listener = fakeListener()
  const { service } = await makeService(t, {
    startListener: listener.start,
    interfaces: () => [NIC('192.168.137.1', 'IPv4', '本地连接* 16', true)],
    routeProbeAddress: () => null,
  })
  await service.saveSettings({ mode: 'lan', lanAddress: '', port: 0 })
  const state = await service.getState()
  assert.equal(state.status.urls.length, 0, '没有地址就不产出可打开地址（不许半成品）')
  // 可见性落在 typed 失败上：start() 的 lastError 带原因与下一步。
  const status = await service.start()
  assert.equal(status.lastError.code, 'E_NO_BIND_ADDRESS')
  assert.match(status.lastError.message, /请先连上 Wi-Fi|手动填「局域网地址」/)
})

test('L-12 enabled 跟随监听句柄：运行中 true、停止后 false（单一事实来源 = handle）', async (t) => {
  const listener = fakeListener()
  const { home, service } = await makeService(t, {
    startListener: listener.start,
    interfaces: REAL_MACHINE_ORDER,
    routeProbeAddress: () => '192.168.1.5',
  })
  const configFile = path.join(home, '.dsh', 'dots', 'remote.json')
  const readEnabled = async () => JSON.parse(await readFile(configFile, 'utf8')).enabled

  await service.saveSettings({ mode: 'lan', lanAddress: '', port: 0 })
  assert.equal(await readEnabled(), false, '未启动时 enabled=false')

  const started = await service.start()
  assert.equal(started.running, true, JSON.stringify(started.lastError))
  assert.equal(await readEnabled(), true, '起成功后落盘的 enabled 必须是 true（不再与事实相反）')
  assert.equal((await service.getState()).settings.enabled, true)

  const stopped = await service.stop()
  assert.equal(stopped.running, false)
  assert.equal(await readEnabled(), false, '停止后 enabled 必须是 false')
  assert.equal((await service.getState()).settings.enabled, false)

  // dispose()（进程退出/插件卸载）不是"用户点了停止"，不得篡改意图位。
  await service.start()
  assert.equal(await readEnabled(), true)
  await service.dispose()
  assert.equal(await readEnabled(), true, 'dispose 不许清掉自动启动意图')
})

/* ------------------------------------------------------------ 面板接线（真实渲染器） */

test('L-14 面板把引擎那一行 `urls[].note` 渲染出来（前端不自己拼地址判断）', async () => {
  const source = await readFile(path.join(process.cwd(), 'dist', 'client.js'), 'utf8')
  assert.match(source, /data-lean': 'remote-address-note'/, '必须有一个专用节点承载这条说明')
  assert.match(source, /Array\.isArray\(status\.urls\)/, '说明必须来自引擎状态')
  assert.match(source, /status\.urls\[0\]/, '取的是第一条地址条目的 note')
  assert.match(source, /first\.note/, '读的字段必须是 note')
  assert.match(source, /applyRemoteStatus\(/, 'running / probe / 地址说明必须走同一个落地口')
  // 反证：不许出现"前端自己读 lanAddress 拼一句地址"的分叉逻辑。
  assert.equal(/setAddressNote\([^)]*lanAddress/.test(source), false, '前端不得自行推导地址')
})

/* ------------------------------------------- 落盘值是"自动镜像"还是"运维手填"（L-15/L-16） */

test('L-15 落盘值等于 provisioning 自动镜像值时不算覆盖：默认路由优先（真机缺陷回归）', async (t) => {
  const home = await makeHome(t)
  seedCert(home)
  await mkdir(path.join(home, '.dsh', 'dots'), { recursive: true })
  await writeFile(
    path.join(home, '.dsh', 'dots', 'remote.json'),
    JSON.stringify({ ...defaultRemoteSettings(), mode: 'lan', lanAddress: '192.168.137.1', port: 0 }),
    'utf8',
  )
  const fakeDsh = await startFakeDsh(t)
  const listener = fakeListener()
  const service = createRemoteService({
    homeDir: home,
    createGate: () => fakeGate(),
    startListener: listener.start,
    webServer: { port: fakeDsh.port },
    connection: { authenticatedUrl: (base) => `${base}?token=launch` },
    interfaces: REAL_MACHINE_ORDER,
    routeProbeAddress: () => '192.168.1.5',
    provisionedLanAddress: () => '192.168.137.1',
  })
  t.after(async () => {
    await service.dispose()
  })

  const status = await service.start()
  assert.equal(status.running, true, JSON.stringify(status.lastError))
  assert.equal(listener.calls[0].bindAddress, '192.168.1.5', '自动镜像的落盘值不得把监听钉在虚拟网卡上')
  assert.equal(status.boundAddress, '192.168.1.5')
  assert.equal(status.urls[0].url.startsWith('https://192.168.1.5:'), true, '广播地址必须与绑定地址一致')
  assert.match(status.urls[0].note, /已忽略落盘的 192\.168\.137\.1/, '忽略必须写在状态行里，不许静默')
})

test('L-16 本进程显式保存过 ⇒ 同一个值按覆盖处理（运维意图优先）', async (t) => {
  const listener = fakeListener()
  const { service } = await makeService(t, {
    startListener: listener.start,
    interfaces: REAL_MACHINE_ORDER,
    routeProbeAddress: () => '192.168.1.5',
    provisionedLanAddress: () => '192.168.137.1',
  })
  await service.saveSettings({ mode: 'lan', lanAddress: '192.168.137.1', port: 0 })
  const status = await service.start()
  assert.equal(status.running, true, JSON.stringify(status.lastError))
  assert.equal(listener.calls[0].bindAddress, '192.168.137.1', '显式保存过的地址必须被尊重')
  assert.match(status.urls[0].note, /你手填的局域网地址/)
  assert.match(status.urls[0].note, /192\.168\.1\.5/, '同时必须点名真正的默认路由地址')
})

/* ------------------------------------------------------------ 真机探测（只读、有时界） */
test('L-13 probeRouteAddress：不抛、有时界、返回的要么是具体的本机单播地址要么是 null', async () => {
  const startedAt = Date.now()
  const address = await probeRouteAddress('IPv4')
  const elapsed = Date.now() - startedAt
  assert.ok(elapsed < 1000, `探测必须有界（实际 ${String(elapsed)}ms）`)
  if (address !== null) {
    assert.equal(/^127\./.test(address), false, '回环不是路由选出的对外地址')
    assert.equal(address.startsWith('169.254.'), false, 'APIPA 不是路由选出的对外地址')
    assert.equal(isBindableLanAddress(address), true, `${address} 必须能作为绑定地址`)
  }
  // 第二证：探测结果若存在，必须能在候选表里找到（否则不会有人用它绑定）。
  if (address !== null) {
    const selection = resolveLanSelection({ candidates: listLanCandidates(), routeAddress: address })
    assert.equal(selection.source, 'route')
    assert.equal(selection.address, address)
  }
})
