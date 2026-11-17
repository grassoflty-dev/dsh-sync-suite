/**
 * `src/remote/probe.ts` 的单元测试。
 *
 * 铁律：**全部用注入的假 deps**——不真的联网（`connect` 是假的）、不真的跑系统命令
 * （`command` 是假的）、不依赖真实网卡名（`interfaces` 是假的）。
 * 断言只看稳定 check id / level / 是否含敏感串，不看具体网卡名。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { defaultProbeDeps, PROBE_CHECK_IDS, runProbe } from '../dist/remote/probe.js'

/** 契约里的默认设置（每种方式共用一份，按用例 patch）。 */
const BASE_SETTINGS = {
  enabled: true,
  mode: 'lan',
  port: 0,
  lanAddress: '',
  tailscaleHost: '',
  cloudflareHost: '',
  ipv6Address: '',
  manualUrl: '',
}

const settings = (patch = {}) => ({ ...BASE_SETTINGS, ...patch })

/** 造一条 `os.NetworkInterfaceInfo` 形状的记录（字段与 Node 一致）。 */
const iface = (address, family, extra = {}) => ({
  address,
  netmask: family === 'IPv4' ? '255.255.255.0' : 'ffff:ffff:ffff:ffff::',
  family,
  mac: '00:00:00:00:00:00',
  internal: false,
  cidr: null,
  scopeid: 0,
  ...extra,
})

/** 本机公网 v6（真实前缀形状，但值只用作文本，不依赖真实网卡）。 */
const V6_PUBLIC = '2409:8a20:4cad:ba20:d2c0:3d53:7540:763c'
const V6_TEMP = '2409:8a20:4cad:ba20:e9c9:b85:e2eb:e5ec'

/** `netsh interface ipv6 show addresses` 的真实输出形状（Addr Type 在第 1 列，地址在最后）。 */
const V6_TABLE = `
Interface 22: WLAN 3

Addr Type  DAD State   Valid Life Pref. Life Address
---------  ----------- ---------- ---------- ------------------------
Public     Preferred     23h54m7s      54m7s ${V6_PUBLIC}
Temporary  Preferred     23h54m7s      54m7s ${V6_TEMP}
Other      Preferred     infinite   infinite fe80::3395:7156:3ad4:9b96%22
`

/**
 * `netsh advfirewall show currentprofile` 的真实输出形状（默认阻止入站）。
 * 注意：**非控制台（execFile）执行时 netsh 输出是简体中文**，这里按实测原文写。
 */
const FIREWALL_BLOCK = `
专用配置文件 设置: 
----------------------------------------------------------------------
状态                                  启用
防火墙策略                          BlockInbound,AllowOutbound
`

/**
 * 造一套假 deps，并记录 `connect` / `command` 的调用（证明"没有真的联网/没有真的跑命令"）。
 */
function makeDeps(patch = {}) {
  const calls = { connect: [], command: [] }
  const base = {
    now: () => new Date('2026-11-17T12:00:00.000Z'),
    interfaces: () => ({
      WLAN: [iface('192.168.1.6', 'IPv4', { netmask: '255.255.255.0' }), iface('fe80::1', 'IPv6')],
      'vEthernet (Default Switch)': [iface('172.28.0.1', 'IPv4')],
    }),
    connect: async (host, port) => {
      calls.connect.push(`${host}:${port}`)
      return true
    },
    command: async (file, args) => {
      calls.command.push(`${file} ${args.join(' ')}`)
      return null
    },
    dshPort: 3080,
    listenerAddress: '192.168.1.6',
    platform: 'win32',
  }
  return { deps: { ...base, ...patch }, calls }
}

/** 取某条 check（按 id），不存在直接断言失败。 */
function checkOf(result, id) {
  const found = result.checks.find((c) => c.id === id)
  assert.ok(found, `缺少 check ${id}（实际：${result.checks.map((c) => c.id).join(',')}）`)
  return found
}

const idsOf = (result) => result.checks.map((c) => c.id)

test('PROBE_CHECK_IDS 覆盖每种方式的关键 check id', () => {
  for (const id of [
    'dsh-port-known',
    'dsh-loopback-reachable',
    'lan-address',
    'lan-bind',
    'lan-same-subnet',
    'v6-global',
    'v6-stable',
    'dsh-bound-v6',
    'firewall-inbound',
    'external-reachability',
    'tailnet-address',
    'tailscale-host-match',
    'cloudflared-installed',
    'tunnel-host',
    'ws-upgrade',
    'manual-url-parse',
    'manual-url-scheme',
    'uu-unsupported',
  ]) {
    assert.ok(PROBE_CHECK_IDS.includes(id), `PROBE_CHECK_IDS 缺 ${id}`)
  }
  assert.ok(Object.isFrozen(PROBE_CHECK_IDS), 'PROBE_CHECK_IDS 应只读')
})

test('defaultProbeDeps 给出可用的真实默认实现，且端口/监听默认未知', async () => {
  const deps = defaultProbeDeps()
  assert.equal(typeof deps.now, 'function')
  assert.equal(typeof deps.interfaces, 'function')
  assert.equal(typeof deps.connect, 'function')
  assert.equal(typeof deps.command, 'function')
  assert.equal(deps.dshPort, null)
  assert.equal(deps.listenerAddress, null)
  assert.equal(deps.platform, process.platform)
  assert.ok(deps.now() instanceof Date)
  assert.equal(typeof deps.interfaces(), 'object')
})

test('lan 全绿：level=ok，自动挑非虚拟网卡且 message 里没有通配地址', async () => {
  const { deps, calls } = makeDeps()
  const result = await runProbe('lan', settings(), deps)
  assert.equal(result.mode, 'lan')
  assert.equal(result.level, 'ok')
  assert.equal(result.verdict, '局域网已就绪：平板连同一 Wi-Fi 打开下方地址')
  assert.deepEqual(idsOf(result), [
    'dsh-port-known',
    'dsh-loopback-reachable',
    'lan-address',
    'lan-bind',
    'lan-same-subnet',
  ])
  const lanAddress = checkOf(result, 'lan-address')
  assert.equal(lanAddress.level, 'ok')
  assert.match(lanAddress.message, /192\.168\.1\.6/)
  assert.ok(!lanAddress.message.includes('0.0.0.0'), 'lan-address 不能出现 0.0.0.0')
  assert.ok(!lanAddress.message.includes('172.28.0.1'), '虚拟网卡不能当选')
  assert.equal(checkOf(result, 'lan-bind').level, 'ok')
  assert.equal(checkOf(result, 'lan-same-subnet').level, 'ok')
  // 只碰了本机回环；没有任何真实命令被执行
  assert.deepEqual(calls.connect, ['127.0.0.1:3080'])
  assert.deepEqual(calls.command, [])
  assert.equal(result.at, '2026-11-17T12:00:00.000Z')
})

test('lan：没有非虚拟 IPv4 且设置为空 → lan-address=fail', async () => {
  const { deps } = makeDeps({
    interfaces: () => ({
      'vEthernet (Default Switch)': [iface('172.28.0.1', 'IPv4')],
      WLAN: [iface('169.254.10.20', 'IPv4')],
    }),
    listenerAddress: null,
  })
  const result = await runProbe('lan', settings({ lanAddress: '' }), deps)
  const lanAddress = checkOf(result, 'lan-address')
  assert.equal(lanAddress.level, 'fail')
  assert.match(lanAddress.hint, /虚拟网卡|同一/)
  assert.equal(result.level, 'fail')
})

test('lan：设置里的通配地址 → lan-address=fail，且文案不写通配字面量', async () => {
  const { deps } = makeDeps()
  const result = await runProbe('lan', settings({ lanAddress: '0.0.0.0' }), deps)
  const lanAddress = checkOf(result, 'lan-address')
  assert.equal(lanAddress.level, 'fail')
  assert.match(lanAddress.message, /通配/)
  assert.ok(!JSON.stringify(result).includes('0.0.0.0'), '结果里不该出现通配地址字面量')
})

test('lan：监听未启动 → warn；绑通配 → fail；地址不一致 → warn', async () => {
  const notStarted = await runProbe('lan', settings(), makeDeps({ listenerAddress: null }).deps)
  assert.equal(checkOf(notStarted, 'lan-bind').level, 'warn')
  assert.match(checkOf(notStarted, 'lan-bind').message, /未启动/)
  // 监听没起时没有可比对象，不应编造一条"地址不一致"的 check
  assert.ok(!idsOf(notStarted).includes('lan-same-subnet'))

  const wildcard = await runProbe('lan', settings(), makeDeps({ listenerAddress: '0.0.0.0' }).deps)
  assert.equal(checkOf(wildcard, 'lan-bind').level, 'fail')
  assert.match(checkOf(wildcard, 'lan-bind').message, /通配/)

  const mismatch = await runProbe('lan', settings(), makeDeps({ listenerAddress: '192.168.1.9' }).deps)
  assert.equal(checkOf(mismatch, 'lan-bind').level, 'ok')
  assert.equal(checkOf(mismatch, 'lan-same-subnet').level, 'warn')
  assert.match(checkOf(mismatch, 'lan-same-subnet').message, /192\.168\.1\.9/)
})

test('拿不到 DSH 端口 → dsh-port-known=warn，且不会去 connect', async () => {
  const { deps, calls } = makeDeps({ dshPort: null })
  const result = await runProbe('lan', settings(), deps)
  const portCheck = checkOf(result, 'dsh-port-known')
  assert.equal(portCheck.level, 'warn')
  assert.match(portCheck.message, /拿不到 DSH 监听端口/)
  assert.equal(checkOf(result, 'dsh-loopback-reachable').level, 'unknown')
  assert.deepEqual(calls.connect, [])
  assert.equal(result.level, 'unknown')
})

test('本机连不上 DSH 端口 → dsh-loopback-reachable=fail', async () => {
  const { deps } = makeDeps({ connect: async () => false })
  const result = await runProbe('lan', settings(), deps)
  const loop = checkOf(result, 'dsh-loopback-reachable')
  assert.equal(loop.level, 'fail')
  assert.match(loop.message, /127\.0\.0\.1:3080/)
  assert.equal(result.level, 'fail')
  assert.match(result.verdict, /先解决 1 个失败项/)
})

test('lan：两个失败项 → level=fail 且 verdict 报数量', async () => {
  const { deps } = makeDeps({
    interfaces: () => ({ 'vEthernet (Default Switch)': [iface('172.28.0.1', 'IPv4')] }),
    listenerAddress: '0.0.0.0',
  })
  const result = await runProbe('lan', settings({ lanAddress: '' }), deps)
  assert.equal(result.level, 'fail')
  assert.match(result.verdict, /先解决 2 个失败项/)
})

/** 一块 `netsh advfirewall firewall show rule dir=in verbose` 的规则文本（中文标签，与实测同形）。 */
function ruleBlock({
  name = 'DSH Remote',
  profiles = '专用',
  protocol = 'TCP',
  localPort = '3080',
  program = '',
  action = '允许',
  enabled = '是',
} = {}) {
  return [
    `规则名称:                             ${name}`,
    '----------------------------------------------------------------------',
    `已启用:                               ${enabled}`,
    '方向:                                 入',
    `配置文件:                             ${profiles}`,
    '本地 IP:                              任何',
    '远程 IP:                              任何',
    `协议:                                 ${protocol}`,
    `本地端口:                             ${localPort}`,
    '远程端口:                             任何',
    `程序:                                 ${program}`,
    `操作:                                 ${action}`,
    '',
  ].join('\n')
}

/**
 * 统一的假 `command` 路由（只认三类只读命令；`rules: null` 表示"读不到规则列表"）。
 * `netRule` 的第三个参数区分 `advfirewall show`（当前配置）与 `advfirewall firewall show rule`。
 */
function firewallCommand({ profile = FIREWALL_BLOCK, rules = '', v6Table = V6_TABLE, where = null } = {}) {
  return async (file, args) => {
    if (file === 'netsh' && args[0] === 'interface') return v6Table
    if (file === 'netsh' && args[0] === 'advfirewall' && args[1] === 'show') return profile
    if (file === 'netsh' && args[0] === 'advfirewall' && args[1] === 'firewall') {
      return rules === null ? null : rules
    }
    if (file === 'where' || file === 'which') return where
    return null
  }
}

test('ipv6：选中临时地址 → v6-stable=fail（并指出稳定地址）', async () => {
  const { deps, calls } = makeDeps({
    interfaces: () => ({
      WLAN: [iface(V6_PUBLIC, 'IPv6'), iface(V6_TEMP, 'IPv6'), iface('fe80::1', 'IPv6')],
    }),
    listenerAddress: V6_TEMP,
    command: async (file, args) => {
      calls.command.push(`${file} ${args.join(' ')}`)
      return firewallCommand()(file, args)
    },
  })
  const result = await runProbe('ipv6', settings({ ipv6Address: V6_TEMP }), deps)
  assert.equal(checkOf(result, 'v6-global').level, 'ok')
  const stable = checkOf(result, 'v6-stable')
  assert.equal(stable.level, 'fail')
  assert.match(stable.message, /临时地址/)
  assert.match(stable.hint, new RegExp(V6_PUBLIC))
  assert.ok(calls.command.includes('netsh interface ipv6 show addresses'))
  assert.equal(result.level, 'fail')
})

test('ipv6：本机全绿时 external-reachability 恒 unknown 并压制 verdict', async () => {
  const { deps, calls } = makeDeps({
    interfaces: () => ({ WLAN: [iface(V6_PUBLIC, 'IPv6')] }),
    listenerAddress: V6_PUBLIC,
    command: async (file, args) => {
      calls.command.push(`${file} ${args.join(' ')}`)
      if (file === 'netsh' && args[0] === 'interface') return V6_TABLE
      // 防火墙当前配置文件默认允许入站 → 有正证据，不再 unknown
      if (file === 'netsh' && args[0] === 'advfirewall') {
        return 'Private Profile Settings:\nState                                 ON\nFirewall Policy                       AllowInbound,BlockOutbound\n'
      }
      return null
    },
  })
  const result = await runProbe('ipv6', settings({ ipv6Address: V6_PUBLIC }), deps)
  assert.equal(result.level, 'unknown')
  assert.equal(result.verdict, '本机检查通过，但公网可达性必须从外网确认')
  const external = checkOf(result, 'external-reachability')
  assert.equal(external.level, 'unknown')
  assert.match(external.message, /本机无法自证公网可达/)
  assert.match(external.hint, /蜂窝数据/)
  assert.ok(!external.message.includes('已通过'))
  assert.equal(checkOf(result, 'firewall-inbound').level, 'ok')
  assert.equal(checkOf(result, 'dsh-bound-v6').level, 'ok')
  assert.deepEqual(calls.connect, ['127.0.0.1:3080', `${V6_PUBLIC}:3080`])
})

test('ipv6：没有全局地址 → v6-global/v6-stable 都 fail', async () => {
  const { deps } = makeDeps({
    interfaces: () => ({ WLAN: [iface('fe80::1', 'IPv6')] }),
    listenerAddress: null,
  })
  const result = await runProbe('ipv6', settings(), deps)
  assert.equal(checkOf(result, 'v6-global').level, 'fail')
  assert.match(checkOf(result, 'v6-global').message, /没有拿到任何全局 IPv6/)
  assert.equal(checkOf(result, 'v6-stable').level, 'fail')
  assert.equal(result.level, 'fail')
})

test('ipv6：读不到 netsh 地址表 → v6-global/v6-stable=unknown（不猜）', async () => {
  const { deps } = makeDeps({
    interfaces: () => ({ WLAN: [iface(V6_PUBLIC, 'IPv6')] }),
    listenerAddress: null,
    command: async () => null,
  })
  const result = await runProbe('ipv6', settings(), deps)
  assert.equal(checkOf(result, 'v6-global').level, 'unknown')
  assert.match(checkOf(result, 'v6-global').message, /无法区分临时\/稳定/)
  assert.equal(checkOf(result, 'v6-stable').level, 'unknown')
  assert.equal(result.level, 'unknown')
})

test('ipv6：非 Windows 不跑任何命令，防火墙判 unknown', async () => {
  const { deps, calls } = makeDeps({
    platform: 'linux',
    interfaces: () => ({ eth0: [iface(V6_PUBLIC, 'IPv6')] }),
    listenerAddress: null,
  })
  const result = await runProbe('ipv6', settings(), deps)
  assert.equal(checkOf(result, 'firewall-inbound').level, 'unknown')
  assert.match(checkOf(result, 'firewall-inbound').message, /非 Windows/)
  assert.deepEqual(calls.command, [], '非 Windows 不该跑 netsh/PowerShell')
})

test('ipv6：监听没起 → dsh-bound-v6=warn；监听在 v4 → fail', async () => {
  const { deps } = makeDeps({
    interfaces: () => ({ WLAN: [iface(V6_PUBLIC, 'IPv6')] }),
    listenerAddress: null,
    command: async (file, args) =>
      file === 'netsh' && args[0] === 'interface' ? V6_TABLE : null,
  })
  const notStarted = await runProbe('ipv6', settings({ ipv6Address: V6_PUBLIC }), deps)
  assert.equal(checkOf(notStarted, 'dsh-bound-v6').level, 'warn')

  const v4Listener = await runProbe(
    'ipv6',
    settings({ ipv6Address: V6_PUBLIC }),
    makeDeps({
      interfaces: () => ({ WLAN: [iface(V6_PUBLIC, 'IPv6')] }),
      listenerAddress: '192.168.1.6',
      command: async (file, args) => (file === 'netsh' && args[0] === 'interface' ? V6_TABLE : null),
    }).deps,
  )
  assert.equal(checkOf(v4Listener, 'dsh-bound-v6').level, 'fail')
  assert.match(checkOf(v4Listener, 'dsh-bound-v6').message, /IPv4/)
})

test('ipv6：该 v6 地址上连不上 → dsh-bound-v6=fail', async () => {
  const { deps } = makeDeps({
    interfaces: () => ({ WLAN: [iface(V6_PUBLIC, 'IPv6')] }),
    listenerAddress: V6_PUBLIC,
    connect: async (host) => host === '127.0.0.1',
    command: async (file, args) => (file === 'netsh' && args[0] === 'interface' ? V6_TABLE : null),
  })
  const result = await runProbe('ipv6', settings({ ipv6Address: V6_PUBLIC }), deps)
  assert.equal(checkOf(result, 'dsh-bound-v6').level, 'fail')
  assert.match(checkOf(result, 'dsh-bound-v6').message, /没有监听/)
})

test('防火墙：默认阻止且找不到放行规则 → warn（不是 ok）', async () => {
  const { deps, calls } = makeDeps({
    interfaces: () => ({ WLAN: [iface(V6_PUBLIC, 'IPv6')] }),
    listenerAddress: V6_PUBLIC,
    command: async (file, args) => {
      calls.command.push(`${file} ${args.join(' ')}`)
      return firewallCommand({ rules: ruleBlock({ name: '无关规则', localPort: '9999' }) })(file, args)
    },
  })
  const result = await runProbe('ipv6', settings({ ipv6Address: V6_PUBLIC }), deps)
  const firewall = checkOf(result, 'firewall-inbound')
  assert.equal(firewall.level, 'warn')
  assert.match(firewall.message, /默认阻止入站/)
  assert.match(firewall.hint, /wf\.msc/)
  assert.ok(
    calls.command.some((c) => c.startsWith('netsh advfirewall firewall show rule')),
    '应只读枚举过入站规则',
  )
})

test('防火墙：枚举到覆盖端口的放行规则 → ok，并写出规则名', async () => {
  const { deps } = makeDeps({
    interfaces: () => ({ WLAN: [iface(V6_PUBLIC, 'IPv6')] }),
    listenerAddress: V6_PUBLIC,
    command: firewallCommand({ rules: ruleBlock({ name: 'DSH Remote (TCP 3080)', localPort: '3080' }) }),
  })
  const result = await runProbe('ipv6', settings({ ipv6Address: V6_PUBLIC }), deps)
  const firewall = checkOf(result, 'firewall-inbound')
  assert.equal(firewall.level, 'ok')
  assert.match(firewall.message, /DSH Remote/)
})

test('防火墙：英文标签的 netsh 输出也能解析（中文系统之外）', async () => {
  const englishProfile =
    'Private Profile Settings:\nState                                 ON\nFirewall Policy                       BlockInbound,AllowOutbound\n'
  const englishRule = [
    'Rule Name:                            DSH Remote (TCP 3080)',
    '----------------------------------------------------------------------',
    'Enabled:                              Yes',
    'Direction:                            In',
    'Profiles:                             Private',
    'Protocol:                             TCP',
    'LocalPort:                            3080',
    'Program:                              Any',
    'Action:                               Allow',
    '',
  ].join('\n')
  const { deps } = makeDeps({
    interfaces: () => ({ WLAN: [iface(V6_PUBLIC, 'IPv6')] }),
    listenerAddress: V6_PUBLIC,
    command: firewallCommand({ profile: englishProfile, rules: englishRule }),
  })
  const result = await runProbe('ipv6', settings({ ipv6Address: V6_PUBLIC }), deps)
  const firewall = checkOf(result, 'firewall-inbound')
  assert.equal(firewall.level, 'ok')
  assert.match(firewall.message, /DSH Remote/)
})

test('防火墙：LocalPort=Any 但只放行别的程序 → 不算覆盖（防假阳性）', async () => {
  const { deps } = makeDeps({
    interfaces: () => ({ WLAN: [iface(V6_PUBLIC, 'IPv6')] }),
    listenerAddress: V6_PUBLIC,
    // 真实机器上就有这类规则（程序是 svchost，端口 Any，配置文件命中当前）
    command: firewallCommand({
      rules: ruleBlock({
        name: 'Wi-Fi Direct 调试服务(入站)',
        localPort: 'Any',
        program: 'C:\\WINDOWS\\System32\\svchost.exe',
      }),
    }),
  })
  const result = await runProbe('ipv6', settings({ ipv6Address: V6_PUBLIC }), deps)
  const firewall = checkOf(result, 'firewall-inbound')
  assert.equal(firewall.level, 'warn', '程序受限的 Any 端口规则不能当成"端口已放行"')
  assert.match(firewall.message, /没找到覆盖端口 3080/)
})

test('防火墙：LocalPort=Any 且放行的是本进程 → 算覆盖', async () => {
  const { deps } = makeDeps({
    interfaces: () => ({ WLAN: [iface(V6_PUBLIC, 'IPv6')] }),
    listenerAddress: V6_PUBLIC,
    command: firewallCommand({
      rules: ruleBlock({ name: 'Node.js 入站', localPort: 'Any', program: process.execPath }),
    }),
  })
  const result = await runProbe('ipv6', settings({ ipv6Address: V6_PUBLIC }), deps)
  assert.equal(checkOf(result, 'firewall-inbound').level, 'ok')
})

test('防火墙：枚举不到规则列表（超时/无权限）→ unknown，不说是"没有规则"', async () => {
  const { deps } = makeDeps({
    interfaces: () => ({ WLAN: [iface(V6_PUBLIC, 'IPv6')] }),
    listenerAddress: V6_PUBLIC,
    command: firewallCommand({ rules: null }),
  })
  const result = await runProbe('ipv6', settings({ ipv6Address: V6_PUBLIC }), deps)
  const firewall = checkOf(result, 'firewall-inbound')
  assert.equal(firewall.level, 'unknown')
  assert.match(firewall.message, /没能读取入站放行规则列表/)
  assert.ok(!firewall.message.includes('没找到覆盖端口'))
})

test('防火墙：读不到状态 → unknown（绝不假装放行）', async () => {
  const { deps } = makeDeps({
    interfaces: () => ({ WLAN: [iface(V6_PUBLIC, 'IPv6')] }),
    listenerAddress: V6_PUBLIC,
    command: async (file, args) => {
      if (file === 'netsh' && args[0] === 'interface') return V6_TABLE
      return null
    },
  })
  const result = await runProbe('ipv6', settings({ ipv6Address: V6_PUBLIC }), deps)
  assert.equal(checkOf(result, 'firewall-inbound').level, 'unknown')
  assert.match(checkOf(result, 'firewall-inbound').message, /读不到防火墙状态/)
})

test('tailscale：有 100.64/10 地址 → ok，host 对得上也是 ok', async () => {
  const { deps } = makeDeps({
    interfaces: () => ({
      WLAN: [iface('192.168.1.6', 'IPv4')],
      Tailscale: [iface('100.101.102.103', 'IPv4')],
    }),
    listenerAddress: '100.101.102.103',
  })
  const result = await runProbe('tailscale', settings({ tailscaleHost: '100.101.102.103' }), deps)
  assert.equal(checkOf(result, 'tailnet-address').level, 'ok')
  assert.match(checkOf(result, 'tailnet-address').message, /100\.101\.102\.103/)
  assert.match(checkOf(result, 'tailnet-address').hint, /卓易通/)
  assert.equal(checkOf(result, 'tailscale-host-match').level, 'ok')
  assert.equal(result.level, 'ok')
  assert.match(result.verdict, /Tailscale/)
})

test('tailscale：没有 tailnet 地址 → warn；host 不一致 → warn', async () => {
  const noTailnet = await runProbe(
    'tailscale',
    settings({ tailscaleHost: '100.101.102.103' }),
    makeDeps({ listenerAddress: null }).deps,
  )
  assert.equal(checkOf(noTailnet, 'tailnet-address').level, 'warn')
  assert.match(checkOf(noTailnet, 'tailnet-address').message, /没有 Tailscale 地址/)
  assert.equal(checkOf(noTailnet, 'tailscale-host-match').level, 'warn')

  const mismatch = await runProbe(
    'tailscale',
    settings({ tailscaleHost: '100.101.102.200' }),
    makeDeps({
      interfaces: () => ({ Tailscale: [iface('100.101.102.103', 'IPv4')] }),
      listenerAddress: '100.101.102.103',
    }).deps,
  )
  assert.equal(checkOf(mismatch, 'tailscale-host-match').level, 'warn')
  assert.match(checkOf(mismatch, 'tailscale-host-match').message, /不一致/)
})

test('tailscale：MagicDNS 域名本机不解析 → unknown（不猜）', async () => {
  const { deps } = makeDeps({
    interfaces: () => ({ Tailscale: [iface('100.101.102.103', 'IPv4')] }),
    listenerAddress: '100.101.102.103',
  })
  const result = await runProbe('tailscale', settings({ tailscaleHost: 'my-pc.tailnet-abc.ts.net' }), deps)
  const match = checkOf(result, 'tailscale-host-match')
  assert.equal(match.level, 'unknown')
  assert.match(match.message, /MagicDNS/)
  assert.equal(result.level, 'unknown')
})

test('cloudflare：空 host → tunnel-host=fail，level=fail', async () => {
  const { deps } = makeDeps({
    listenerAddress: null,
    command: async () => null,
  })
  const result = await runProbe('cloudflare', settings({ cloudflareHost: '' }), deps)
  assert.equal(checkOf(result, 'cloudflared-installed').level, 'warn')
  assert.equal(checkOf(result, 'tunnel-host').level, 'fail')
  assert.match(checkOf(result, 'tunnel-host').message, /还没填/)
  assert.equal(result.level, 'fail')
  assert.match(result.verdict, /先解决 1 个失败项/)
})

test('cloudflare：trycloudflare 域名 → warn（每次重启都会变）', async () => {
  const { deps } = makeDeps({
    listenerAddress: null,
    command: async (file) => (file === 'where' ? 'C:\\tools\\cloudflared.exe\n' : null),
  })
  const result = await runProbe('cloudflare', settings({ cloudflareHost: 'abc-def-ghi.trycloudflare.com' }), deps)
  assert.equal(checkOf(result, 'cloudflared-installed').level, 'ok')
  const tunnel = checkOf(result, 'tunnel-host')
  assert.equal(tunnel.level, 'warn')
  assert.match(tunnel.message, /每次重启都会变/)
  assert.equal(result.level, 'unknown') // ws-upgrade 仍是 unknown
})

test('cloudflare：合法自有域名 → tunnel-host=ok；ws-upgrade 未实测 → unknown 且给出 101 判据', async () => {
  const { deps, calls } = makeDeps({ listenerAddress: null })
  const fakeDeps = {
    ...deps,
    command: async (file, args) => {
      calls.command.push(`${file} ${args.join(' ')}`)
      return file === 'where' ? 'C:\\tools\\cloudflared.exe\n' : null
    },
  }
  const result = await runProbe('cloudflare', settings({ cloudflareHost: 'dsh.example.com' }), fakeDeps)
  assert.equal(checkOf(result, 'tunnel-host').level, 'ok')
  const ws = checkOf(result, 'ws-upgrade')
  assert.equal(ws.level, 'unknown')
  assert.match(ws.message, /api\/remote\.mux/)
  assert.match(ws.hint, /101/)
  assert.equal(result.verdict, '本机检查通过，但公网可达性必须从外网确认')
  assert.deepEqual(calls.command, ['where cloudflared'])
})

test('cloudflare：注入 WS 实测 → 101 判 ok，非 101 判 fail，抛错判 unknown', async () => {
  const okDeps = makeDeps({
    listenerAddress: null,
    command: async () => null,
    wsUpgrade: async (host) => ({ status: host === 'dsh.example.com' ? 101 : null }),
  }).deps
  const okResult = await runProbe('cloudflare', settings({ cloudflareHost: 'dsh.example.com' }), okDeps)
  assert.equal(checkOf(okResult, 'ws-upgrade').level, 'ok')
  assert.match(checkOf(okResult, 'ws-upgrade').message, /101/)

  const failDeps = makeDeps({
    listenerAddress: null,
    command: async () => null,
    wsUpgrade: async () => ({ status: 302, detail: '登录页' }),
  }).deps
  const failResult = await runProbe('cloudflare', settings({ cloudflareHost: 'dsh.example.com' }), failDeps)
  assert.equal(checkOf(failResult, 'ws-upgrade').level, 'fail')
  assert.match(checkOf(failResult, 'ws-upgrade').message, /302/)

  const boomDeps = makeDeps({
    listenerAddress: null,
    command: async () => null,
    wsUpgrade: async () => {
      throw new Error('boom')
    },
  }).deps
  const boomResult = await runProbe('cloudflare', settings({ cloudflareHost: 'dsh.example.com' }), boomDeps)
  assert.equal(checkOf(boomResult, 'ws-upgrade').level, 'unknown')
  assert.match(checkOf(boomResult, 'ws-upgrade').message, /没有拿到 101 证据/)
})

test('manual：https 合法 → ok；http → warn；非法/为空 → fail', async () => {
  const { deps } = makeDeps({ listenerAddress: null })
  const https = await runProbe('manual', settings({ manualUrl: 'https://dsh.example.com/' }), deps)
  assert.equal(checkOf(https, 'manual-url-parse').level, 'ok')
  assert.equal(checkOf(https, 'manual-url-scheme').level, 'ok')
  assert.match(checkOf(https, 'manual-url-scheme').message, /https/)

  const http = await runProbe('manual', settings({ manualUrl: 'http://192.168.1.6:3080/' }), deps)
  assert.equal(checkOf(http, 'manual-url-parse').level, 'ok')
  assert.equal(checkOf(http, 'manual-url-scheme').level, 'warn')
  assert.match(checkOf(http, 'manual-url-scheme').message, /明文 http/)

  const invalid = await runProbe('manual', settings({ manualUrl: 'dsh.example.com' }), deps)
  assert.equal(checkOf(invalid, 'manual-url-parse').level, 'fail')
  assert.equal(invalid.level, 'fail')

  const empty = await runProbe('manual', settings({ manualUrl: '   ' }), deps)
  assert.equal(checkOf(empty, 'manual-url-parse').level, 'fail')
})

test('manual：URL 带 token 时结果里绝不含 token 明文', async () => {
  const token = 's3cr3t-T0KEN-value-9f2a'
  const { deps } = makeDeps({ listenerAddress: null })
  const result = await runProbe(
    'manual',
    settings({ manualUrl: `https://dsh.example.com/?k=${token}&x=1` }),
    deps,
  )
  const serialized = JSON.stringify(result)
  assert.ok(!serialized.includes(token), 'token 不能出现在返回结果里')
  assert.ok(!checkOf(result, 'manual-url-parse').message.includes(token))
  assert.ok(!checkOf(result, 'manual-url-parse').hint.includes(token))
  assert.ok(!result.verdict.includes(token))
  assert.match(checkOf(result, 'manual-url-parse').message, /dsh\.example\.com/)
})

test('uu：单条 fail，hint 指向别的访问方式', async () => {
  const { deps } = makeDeps()
  const result = await runProbe('uu', settings({ mode: 'uu' }), deps)
  const uu = checkOf(result, 'uu-unsupported')
  assert.equal(uu.level, 'fail')
  assert.match(uu.message, /画面串流/)
  assert.match(uu.hint, /Cloudflare|局域网/)
  assert.equal(result.level, 'fail')
  assert.match(result.verdict, /还不能用/)
  assert.equal(idsOf(result).filter((id) => id === 'uu-unsupported').length, 1)
})

test('聚合顺序：fail 压过 unknown；unknown 压过 warn', async () => {
  // fail + unknown 同时存在
  const failing = await runProbe('cloudflare', settings({ cloudflareHost: '' }), makeDeps({ listenerAddress: null }).deps)
  assert.equal(failing.level, 'fail')
  assert.ok(idsOf(failing).includes('ws-upgrade'))

  // 只有 warn + unknown
  const warnUnknown = await runProbe(
    'tailscale',
    settings({ tailscaleHost: '100.101.102.200' }),
    makeDeps({
      interfaces: () => ({ Tailscale: [iface('100.101.102.103', 'IPv4')] }),
      listenerAddress: '100.101.102.103',
    }).deps,
  )
  assert.equal(warnUnknown.level, 'warn')
  assert.match(warnUnknown.verdict, /提醒/)
})

test('不认识的 mode → fail-closed（mode-unknown=fail）', async () => {
  const { deps } = makeDeps()
  const result = await runProbe('smb', settings(), deps)
  assert.equal(result.level, 'fail')
  assert.equal(checkOf(result, 'mode-unknown').level, 'fail')
  assert.match(result.verdict, /访问方式/)
})

test('每条 check 的结构都合法（稳定 id / 合法 level / 中文 message 非空）', async () => {
  const modes = ['lan', 'tailscale', 'ipv6', 'cloudflare', 'manual', 'uu']
  for (const mode of modes) {
    const { deps } = makeDeps({
      interfaces: () => ({
        WLAN: [iface('192.168.1.6', 'IPv4'), iface(V6_PUBLIC, 'IPv6')],
        Tailscale: [iface('100.101.102.103', 'IPv4')],
      }),
      listenerAddress: '192.168.1.6',
      command: async () => null,
    })
    const result = await runProbe(mode, settings({ mode }), deps)
    assert.equal(result.mode, mode)
    assert.ok(['ok', 'warn', 'fail', 'unknown'].includes(result.level), `${mode} 的 level 非法`)
    assert.ok(result.checks.length > 0)
    assert.ok(typeof result.verdict === 'string' && result.verdict.length > 0)
    for (const check of result.checks) {
      assert.equal(typeof check.id, 'string')
      assert.ok(PROBE_CHECK_IDS.includes(check.id), `${mode} 出现未登记的 id ${check.id}`)
      assert.ok(['ok', 'warn', 'fail', 'unknown'].includes(check.level))
      assert.ok(typeof check.message === 'string' && check.message.length > 0)
      assert.equal(typeof check.hint, 'string')
      assert.equal(Object.keys(check).length, 4)
    }
  }
})
