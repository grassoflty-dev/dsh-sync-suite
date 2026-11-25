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
 *   1. **运维手选**（设置里的 `lanAddress` + 落盘标记 `lanAddressChosen === true`）→ 用它并说明
 *      "这是你手填的"；这个地址若**已不在本机网卡上** ⇒ typed/可见失败，**绝不静默改绑**别的地址；
 *   2. 默认路由地址（`probeRouteAddress`）→ 用它；**没有标记的落盘值一律按自动值**，原因行说明
 *      它被忽略（`已忽略落盘的 X（未记录为你手选的地址，按自动挑选）`）；
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
  resolveLanSelection,
} from '../dist/remote/service.js'
import { isBindableIpv6Address, isBindableLanAddress } from '../dist/remote/listener.js'
import { defaultRemoteSettings, normalizeRemoteSettings } from '../dist/remote/accessMode.js'
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

/* --------------------------------- 落盘值的来源：手选标记 vs 自动镜像（L-15…L-20） */

/**
 * L-15（retarget：原判据「落盘值 == provisioning 自动镜像 ⇒ 按自动值」已删除，改成「没有来源标记
 * ⇒ 按自动值」，语义**更严**：不再拿落盘值去和任何启发式的输出比较）。
 *
 * 真机缺陷回归：`remote.json` 里躺着 `192.168.137.1`（虚拟网卡）且**没有手选标记** ⇒ 绑定与广播
 * 都必须是默认路由地址，并且原因行必须点名"落盘的那个值被忽略了、为什么"。
 */
test('L-15 落盘值没有手选标记 ⇒ 一律按自动值：默认路由优先，且原因行点名忽略（真机缺陷回归）', async (t) => {
  const home = await makeHome(t)
  seedCert(home)
  const configFile = path.join(home, '.dsh', 'dots', 'remote.json')
  await mkdir(path.dirname(configFile), { recursive: true })
  await writeFile(
    configFile,
    JSON.stringify({ ...defaultRemoteSettings(), mode: 'lan', lanAddress: '192.168.137.1', port: 0 }),
    'utf8',
  )
  // 前提：这份文件确实**没有**来源标记（旧文件 / provisioning 自动镜像的形状）。
  assert.equal('lanAddressChosen' in JSON.parse(await readFile(configFile, 'utf8')), false)
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
  })
  t.after(async () => {
    await service.dispose()
  })

  const status = await service.start()
  assert.equal(status.running, true, JSON.stringify(status.lastError))
  assert.equal(listener.calls[0].bindAddress, '192.168.1.5', '没有标记的落盘值不得把监听钉在虚拟网卡上')
  assert.equal(status.boundAddress, '192.168.1.5')
  assert.equal(status.urls[0].url.startsWith('https://192.168.1.5:'), true, '广播地址必须与绑定地址一致')
  assert.match(status.urls[0].note, /已忽略落盘的 192\.168\.137\.1/, '忽略必须写在状态行里，不许静默')
  assert.match(status.urls[0].note, /未记录为你手选的地址，按自动挑选/, '必须说明"为什么"忽略（没有来源标记）')
  assert.equal(/你手填的/.test(status.urls[0].note), false, '没有标记就不许说成"你手填的"')
})

test('L-16 本进程显式保存过 ⇒ 落盘打上来源标记，并按覆盖处理（运维意图优先）', async (t) => {
  const listener = fakeListener()
  const { home, service } = await makeService(t, {
    startListener: listener.start,
    interfaces: REAL_MACHINE_ORDER,
    routeProbeAddress: () => '192.168.1.5',
  })
  const configFile = path.join(home, '.dsh', 'dots', 'remote.json')
  await service.saveSettings({ mode: 'lan', lanAddress: '192.168.137.1', port: 0 })
  // 新规则的核心：这次保存**就是**运维在选地址，标记必须落盘（不比任何数值）。
  assert.equal(JSON.parse(await readFile(configFile, 'utf8')).lanAddressChosen, true,
    '非空 lanAddress 的保存必须留下来源标记')
  // 只改别的字段（没带 lanAddress 键）不许把标记弄丢，也不许把它降级成自动值。
  await service.saveSettings({ token: '' })
  assert.equal(JSON.parse(await readFile(configFile, 'utf8')).lanAddressChosen, true,
    '不带 lanAddress 的保存必须保留已有的手选标记')
  // 标记只是**落盘来源**，不进 RPC 视图：设置视图的形状对既有读者必须完全不变（additive）。
  assert.equal('lanAddressChosen' in (await service.getState()).settings, false,
    '来源标记不进 remoteGetState（面板读的是原因行，不是这个键）')

  const status = await service.start()
  assert.equal(status.running, true, JSON.stringify(status.lastError))
  assert.equal(listener.calls[0].bindAddress, '192.168.137.1', '显式保存过的地址必须被尊重')
  assert.match(status.urls[0].note, /你手填的局域网地址/)
  assert.match(status.urls[0].note, /192\.168\.1\.5/, '同时必须点名真正的默认路由地址')
})

/* ------------------------------------------------------------ 新增四条（L-17…L-20） */

test('L-17 手选的地址跨重启存活：标记落盘，新服务实例（重新读盘）仍按覆盖绑定', async (t) => {
  const home = await makeHome(t)
  seedCert(home)
  const fakeDsh = await startFakeDsh(t)
  const configFile = path.join(home, '.dsh', 'dots', 'remote.json')
  const common = {
    homeDir: home,
    createGate: () => fakeGate(),
    webServer: { port: fakeDsh.port },
    connection: { authenticatedUrl: (base) => `${base}?token=launch` },
    interfaces: REAL_MACHINE_ORDER,
    routeProbeAddress: () => '192.168.1.5',
  }

  // "上一次运行"：运维在设置里手填了 192.168.137.1（与默认路由不同）并保存。
  const firstListener = fakeListener()
  const first = createRemoteService({ ...common, startListener: firstListener.start })
  await first.saveSettings({ mode: 'lan', lanAddress: '192.168.137.1', port: 0 })
  await first.dispose()

  const disk = JSON.parse(await readFile(configFile, 'utf8'))
  assert.equal(disk.lanAddress, '192.168.137.1')
  assert.equal(disk.lanAddressChosen, true, '标记必须真的在文件里（否则"跨重启"只是本进程的内存）')

  // "重启"：新服务、新监听工厂，只靠磁盘。
  const secondListener = fakeListener()
  const second = createRemoteService({ ...common, startListener: secondListener.start })
  t.after(() => second.dispose())
  const status = await second.start()
  assert.equal(status.running, true, JSON.stringify(status.lastError))
  assert.equal(secondListener.calls[0].bindAddress, '192.168.137.1', '重启后必须还用运维手选的那个地址')
  assert.match(status.urls[0].note, /你手填的局域网地址/, '原因行也要承认这是手选的')
  assert.equal(status.urls[0].url.startsWith('https://192.168.137.1:'), true, '广播地址 = 绑定地址')
})

test('L-18 运维从未手选（非空落盘值 + 无标记）⇒ 自动选路永远赢，原因行说明被忽略', async (t) => {
  const home = await makeHome(t)
  seedCert(home)
  const configFile = path.join(home, '.dsh', 'dots', 'remote.json')
  await mkdir(path.dirname(configFile), { recursive: true })
  // 关键：值本身完全合法、可绑定、且**不等于**任何自动候选 —— 唯一缺的是来源标记。
  await writeFile(
    configFile,
    JSON.stringify({ ...defaultRemoteSettings(), mode: 'lan', lanAddress: '192.168.1.9', port: 0 }),
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
  })
  t.after(() => service.dispose())

  const status = await service.start()
  assert.equal(status.running, true, JSON.stringify(status.lastError))
  assert.equal(listener.calls[0].bindAddress, '192.168.1.5', '没有标记 ⇒ 覆盖不生效，路由地址胜出')
  const note = status.urls[0].note
  assert.match(note, /已忽略落盘的 192\.168\.1\.9/, '必须点名被忽略的落盘值')
  assert.match(note, /未记录为你手选的地址，按自动挑选/, '必须说明原因（没有来源标记）')
  // 不许自相矛盾：同一行里宣告广播的地址就是路由地址，不是被忽略的那个。
  assert.equal(status.urls[0].url.startsWith('https://192.168.1.5:'), true)
  assert.equal(note.includes('广播 192.168.1.9'), false, '原因行不许出现"广播 <被忽略的地址>"这种自相矛盾')
})

test('L-19 自动镜像写入（provisioning 重建）永不设置标记；也不会抹掉已有的标记', async (t) => {
  const home = await makeHome(t)
  seedCert(home)
  const configFile = path.join(home, '.dsh', 'dots', 'remote.json')
  await mkdir(path.dirname(configFile), { recursive: true })
  const store = new RemoteStore({ homeDir: home })
  const fakeDsh = await startFakeDsh(t)

  /** 与 `pairingProvision.persistEndpoint()` 逐字同一手法：整文件重写。 */
  const mirrorRewrite = async (address) => {
    const raw = JSON.parse(await readFile(configFile, 'utf8'))
    const base = defaultRemoteSettings()
    const previous = normalizeRemoteSettings(raw, base)
    const next = normalizeRemoteSettings({ ...previous, mode: 'lan', lanAddress: address, port: 0 }, previous)
    store.writeSettings(next)
    return next
  }

  // 第一半：文件里没有标记 ⇒ 镜像写入之后仍然没有标记（绝不"因为 lanAddress 非空"就盖章）。
  await writeFile(configFile, JSON.stringify({ ...defaultRemoteSettings(), mode: 'lan', lanAddress: '', port: 0 }), 'utf8')
  const mirrored = await mirrorRewrite('192.168.137.1')
  assert.equal('lanAddressChosen' in mirrored, false, '归一化不许凭空造出来源标记')
  assert.equal('lanAddressChosen' in JSON.parse(await readFile(configFile, 'utf8')), false, '落盘文件里也不许有')
  const listenerA = fakeListener()
  const serviceA = createRemoteService({
    homeDir: home,
    createGate: () => fakeGate(),
    startListener: listenerA.start,
    webServer: { port: fakeDsh.port },
    connection: { authenticatedUrl: (base) => `${base}?token=launch` },
    interfaces: REAL_MACHINE_ORDER,
    routeProbeAddress: () => '192.168.1.5',
  })
  t.after(() => serviceA.dispose())
  const statusA = await serviceA.start()
  assert.equal(listenerA.calls[0].bindAddress, '192.168.1.5', '镜像写进去的地址不得压过默认路由')
  assert.match(statusA.urls[0].note, /未记录为你手选的地址/)

  // 第二半：文件里**已有**手选标记 ⇒ 镜像写入必须原样保留（否则运维的选择会被自动写回抹掉）。
  const chosen = { ...defaultRemoteSettings(), mode: 'lan', lanAddress: '192.168.137.1', port: 0, lanAddressChosen: true }
  await writeFile(configFile, JSON.stringify(chosen), 'utf8')
  const kept = await mirrorRewrite('192.168.137.1')
  assert.equal(kept.lanAddressChosen, true, '镜像写入只许保留标记，不许清零')
  assert.equal(JSON.parse(await readFile(configFile, 'utf8')).lanAddressChosen, true)
  const listenerB = fakeListener()
  const serviceB = createRemoteService({
    homeDir: home,
    createGate: () => fakeGate(),
    startListener: listenerB.start,
    webServer: { port: fakeDsh.port },
    connection: { authenticatedUrl: (base) => `${base}?token=launch` },
    interfaces: REAL_MACHINE_ORDER,
    routeProbeAddress: () => '192.168.1.5',
  })
  t.after(() => serviceB.dispose())
  const statusB = await serviceB.start()
  assert.equal(listenerB.calls[0].bindAddress, '192.168.137.1', '保留的标记必须继续生效')
  assert.match(statusB.urls[0].note, /你手填的局域网地址/)
})

test('L-20 手选地址已不在本机网卡上 ⇒ 仍绑它（绝不静默改绑），但 typed/可见地失败并说明为什么', async (t) => {
  const home = await makeHome(t)
  seedCert(home)
  const configFile = path.join(home, '.dsh', 'dots', 'remote.json')
  await mkdir(path.dirname(configFile), { recursive: true })
  // 运维明确选过 192.168.137.1（带标记），但这次网卡表里已经没有它（虚拟适配器被移除）。
  await writeFile(
    configFile,
    JSON.stringify({ ...defaultRemoteSettings(), mode: 'lan', lanAddress: '192.168.137.1', port: 0, lanAddressChosen: true }),
    'utf8',
  )
  const fakeDsh = await startFakeDsh(t)
  const calls = []
  // 真实监听的形状：地址不在本机 ⇒ bind 抛 EADDRNOTAVAIL，service 折成 typed E_LISTEN_FAILED。
  const failingListener = {
    calls,
    start: async (options) => {
      calls.push(options)
      throw new Error(`bind EADDRNOTAVAIL ${options.bindAddress}`)
    },
  }
  const service = createRemoteService({
    homeDir: home,
    createGate: () => fakeGate(),
    startListener: failingListener.start,
    webServer: { port: fakeDsh.port },
    connection: { authenticatedUrl: (base) => `${base}?token=launch` },
    interfaces: () => [NIC('192.168.1.5', 'IPv4', 'WLAN 3')],
    routeProbeAddress: () => '192.168.1.5',
  })
  t.after(() => service.dispose())

  const status = await service.start()
  assert.equal(status.running, false)
  assert.equal(status.lastError.code, 'E_LISTEN_FAILED', '必须是 typed 失败，不是"悄悄换一个地址"')
  assert.match(status.lastError.message, /192\.168\.137\.1|EADDRNOTAVAIL/, '失败原因必须能追到那个地址')
  assert.equal(calls.length, 1, '必须**试过**运维选的那个地址（不是绕开它）')
  assert.equal(calls[0].bindAddress, '192.168.137.1', '绝不静默改绑默认路由地址')

  const state = await service.getState()
  assert.equal(state.status.running, false)
  assert.equal(state.settings.accepting, false, '没起来就不许自称"正在接受连接"')
  // 状态行的原因必须在明面上说"地址不在了"（typed 错误之外的第二条可见通道）。
  assert.equal(state.status.urls.length, 1)
  assert.match(state.status.urls[0].note, /已不在本机网卡上/, '状态行的 note 必须说清"为什么绑不上"')
  assert.match(state.status.urls[0].note, /清空这一项|填当前网卡上的地址/, '必须给出可执行的下一步')
  // 失败不许把运维的选择吞掉：标记与值都还在盘上，修好网卡后下次启动就能用。
  const disk = JSON.parse(await readFile(configFile, 'utf8'))
  assert.equal(disk.lanAddress, '192.168.137.1')
  assert.equal(disk.lanAddressChosen, true, '启动失败不得清掉来源标记（否则运维的选择被静默降级）')
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
