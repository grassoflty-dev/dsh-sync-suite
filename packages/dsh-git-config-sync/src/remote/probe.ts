/**
 * 远程访问域：连通性自检（`runProbe`）。
 *
 * 设计纪律（与 `src/remote/types.ts`、`docs/RESEARCH-D-ipv6.md` §4 同一套）：
 *   1. **绝不假阳性**：本机无法证明的事一律 `unknown`（例如公网可达性、WebSocket 101、
 *      非 Windows 的防火墙状态）。`unknown` 会让总判定停在"需人工确认"，**永远**不会变成 `ok`。
 *   2. **不吞错**：能读到的读到、读不到就说读不到（`unknown` + 人工核对路径），
 *      不把"没查"写成"已通过"；`command`/`connect` 的实现异常只转成"没拿到证据"，
 *      由对应 check 降级成 `unknown`/`fail`，绝不静默变成 `ok`。
 *   3. **本文件不联网**：`connect()` 只做本机 TCP 连通性（回环/本机网卡地址）；
 *      公网可达性、`wss://…/api/remote.mux` 的 101 只能由外部实测（调用方注入）确认。
 *   4. **token 永不出现在 message/hint**：`settings.manualUrl` 可能带 `?token=…`，
 *      所有文案在返回前统一过 `redactText()`（参数名打码 + 出现过的明文值替换成 `***`）。
 *   5. 零 npm 依赖，只用 `node:` 内置（`node:net` / `node:os` / `node:child_process`）；
 *      **不** import `accessMode.ts`（并行开发中，避免耦合），需要的最小常量在本文件内联。
 *
 * 与 `types.ts` 的关系：只 import 类型契约；不 import 任何运行时实现（`src/remote/**`
 * 其它文件、`src/engine/**`、`src/schedule/**`），保证本模块可单独编译、单独被测。
 */
import { execFile } from 'node:child_process'
import { connect as netConnect } from 'node:net'
import { networkInterfaces } from 'node:os'
import type { NetworkInterfaceInfo } from 'node:os'
import type {
  RemoteAccessMode,
  RemoteCheck,
  RemoteLevel,
  RemoteProbeResult,
  RemoteSettings,
} from './types.js'

/** 各 probe 的超时（毫秒）。回环最快，公网/系统命令给宽一点。 */
const LOOPBACK_TIMEOUT_MS = 1500
const LISTENER_TIMEOUT_MS = 2000
const V6_CONNECT_TIMEOUT_MS = 2500
const COMMAND_TIMEOUT_MS = 4000
const FIREWALL_RULE_TIMEOUT_MS = 12000
const WS_PROBE_TIMEOUT_MS = 8000

/** `wss` 自检路径：与 DSH 的远程复用通道一致（`docs/RESEARCH-E-zero-infra.md` §4.2）。 */
const WS_MUX_PATH = '/api/remote.mux'

/**
 * 自检可注入的探测能力。默认实现见 `defaultProbeDeps()`。
 * 全部可注入 = 测试不联网、不跑系统命令、不依赖真实网卡。
 */
export interface ProbeDeps {
  now(): Date
  /** 可注入，默认 os.networkInterfaces() */
  interfaces(): NodeJS.Dict<NetworkInterfaceInfo[]>
  /** 可注入，默认用 net.connect 探 TCP；超时/拒绝 → false */
  connect(host: string, port: number, timeoutMs: number): Promise<boolean>
  /** 可注入，默认只读执行系统命令（Windows: netsh / PowerShell Get-NetFirewallRule）；读不到返回 null */
  command(file: string, args: string[], timeoutMs: number): Promise<string | null>
  /** DSH 自己的监听端口（ctx.webServer.port），未知为 null */
  dshPort: number | null
  /** 旁挂监听当前绑定的地址（未运行 null） */
  listenerAddress: string | null
  /** 平台，默认 process.platform */
  platform: NodeJS.Platform
}

/** 注入式 WebSocket 实测结果（由调用方真的去发 Upgrade 请求后给出）。 */
export interface ProbeWsUpgradeResult {
  /** HTTP 状态码；101 = 握手成功，null = 没拿到响应（超时/连不上）。 */
  status: number | null
  /** 失败原因等附加说明（会原样进 check，返回前统一打码）。 */
  detail?: string
}

/**
 * 可选的扩展探测能力（不属于 `RemoteProbeResult` 契约必需项）。
 *
 * 为什么单独放一个接口：`runProbe` 的形参仍是 `Partial<ProbeDeps>`，
 * 只有真的需要实测 WS 的调用方才会塞 `wsUpgrade`；probe 本身**从不**联网发 WS 请求
 * （`docs/RESEARCH-E-zero-infra.md` §4.2 的 101 判据必须由真请求得出）。
 */
export interface ProbeExtras {
  wsUpgrade?(host: string, timeoutMs: number): Promise<ProbeWsUpgradeResult>
}

/** 所有**可能**出现的 check id（UI/i18n/测试按 id 断言；单次探测只会出现其中一部分）。 */
export const PROBE_CHECK_IDS: readonly string[] = Object.freeze([
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
  'uu-entry',
  'uu-reachable',
  'uu-ws-upgrade',
  'mode-unknown',
])

/** 认识的方式集合（运行时兜底：形状不对的 mode 一律 fail-closed）。 */
const KNOWN_MODES: readonly RemoteAccessMode[] = ['lan', 'tailscale', 'ipv6', 'cloudflare', 'manual', 'uu']

/** 每个方式"本机就绪"时的总判定句（`verdict` 的 ok 分支）。 */
const MODE_READY: Record<RemoteAccessMode, string> = {
  lan: '局域网已就绪：平板连同一 Wi-Fi 打开下方地址',
  tailscale: 'Tailscale 地址已就绪：平板需先装第三方鸿蒙原生 Tailscale 客户端并连上（卓易通里的 Tailscale 不可用）',
  ipv6: '公网 IPv6 本机条件已就绪，但必须从外网实测一次才能确认',
  cloudflare: 'Cloudflare 隧道域名已配置，但仍需实测 WebSocket 能否返回 101',
  manual: '手动地址格式正确：用平板打开确认即可',
  uu: 'UU 远程（图形化端口映射）：入口与 WS 透传待实测',
}

/** 这些 `unknown` 只意味着"必须从外网/真机确认"，不影响"本机检查通过"的措辞。 */
const EXTERNAL_UNKNOWN_IDS: readonly string[] = ['external-reachability', 'ws-upgrade']

/* ------------------------------------------------------------------ *
 * 默认实现（真实环境）
 * ------------------------------------------------------------------ */

/**
 * 默认 TCP 探针：连上 = true；拒绝/超时/DNS 失败 = false。
 * 只用于本机地址（127.0.0.1、本机网卡地址），不用于外网回探。
 */
function defaultConnect(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (reachable: boolean): void => {
      if (settled) return
      settled = true
      try {
        socket.destroy()
      } catch {
        // socket 已经自己关了；这里只为尽快释放句柄，失败无需上报
      }
      resolve(reachable)
    }
    const socket = netConnect({ host, port })
    socket.setTimeout(Math.max(1, timeoutMs), () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

/**
 * 默认只读命令执行：`execFile` + 超时 + `windowsHide`。
 *
 * 只用于**读**系统状态（netsh / where / which / Get-NetFirewallRule）。
 * 非 0 退出、超时、命令不存在 → null（调用方据此给 `unknown`，不假装 ok）。
 */
function defaultCommand(file: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    execFile(
      file,
      args,
      { timeout: Math.max(1, timeoutMs), windowsHide: true, maxBuffer: 1 << 22, encoding: 'utf8' },
      (error, stdout) => {
        if (error) {
          resolve(null)
          return
        }
        resolve(typeof stdout === 'string' ? stdout : String(stdout ?? ''))
      },
    )
  })
}

/** 真实默认依赖。`dshPort` / `listenerAddress` 由调用方覆盖成运行时真值。 */
export function defaultProbeDeps(): ProbeDeps {
  return {
    now: () => new Date(),
    interfaces: () => networkInterfaces(),
    connect: defaultConnect,
    command: defaultCommand,
    dshPort: null,
    listenerAddress: null,
    platform: process.platform,
  }
}

/* ------------------------------------------------------------------ *
 * 小工具：地址判定（不引第三方 ip 库）
 * ------------------------------------------------------------------ */

const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/

interface IfaceAddress {
  iface: string
  address: string
  family: 'IPv4' | 'IPv6'
  internal: boolean
}

/** 只取设置/命令里能拿到的字符串，别让 undefined 变成 "undefined" 出现在文案里。 */
function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 去掉 `[]` 包裹与 `%接口序号` 这类 URL 里不能出现的装饰。 */
function bareAddress(value: string): string {
  let out = str(value).trim()
  if (out.startsWith('[') && out.endsWith(']')) out = out.slice(1, -1)
  const pct = out.indexOf('%')
  if (pct > 0) out = out.slice(0, pct)
  return out.trim()
}

/** 通配绑定地址：DSH 明确拒绝，永远不能当成"选中的地址"。 */
function isWildcard(host: string): boolean {
  const v = host.trim()
  return v === '' || v === '*' || v === '0.0.0.0' || v === '::' || v === '0:0:0:0:0:0:0:0'
}

function isIPv4(host: string): boolean {
  return IPV4_RE.test(host)
}

function isIPv6(host: string): boolean {
  return host.includes(':')
}

/** 169.254.0.0/16：没拿到 DHCP 的链路本地地址，平板连不上。 */
function isLinkLocalV4(host: string): boolean {
  if (!isIPv4(host)) return false
  const parts = host.split('.')
  return parts[0] === '169' && parts[1] === '254'
}

/** 100.64.0.0/10：CGNAT（Tailscale 用的就是这个段）。 */
function isCgnatV4(host: string): boolean {
  if (!isIPv4(host)) return false
  const parts = host.split('.').map((x) => Number(x))
  return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127
}

/** 把任意 IPv6 文本展开成 8 个 16 位整数；非法返回 null（绝不抛）。 */
function expandV6(input: string): number[] | null {
  let s = bareAddress(input).toLowerCase()
  if (!s.includes(':')) return null
  const v4Tail = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s)
  if (v4Tail) {
    const octets = v4Tail[1].split('.').map((x) => Number(x))
    if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
    const hi = ((octets[0] << 8) | octets[1]).toString(16)
    const lo = ((octets[2] << 8) | octets[3]).toString(16)
    s = s.slice(0, s.length - v4Tail[1].length) + hi + ':' + lo
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  let groups: string[]
  if (halves.length === 2) {
    const total = head.length + tail.length
    // "::" 至少要代表 1 组 0，否则是非法写法
    if (total > 7) return null
    groups = [...head, ...new Array<string>(8 - total).fill('0'), ...tail]
  } else {
    if (head.length !== 8) return null
    groups = head
  }
  const out: number[] = []
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null
    out.push(parseInt(g, 16))
  }
  return out
}

/** 判定 `addr` 是否落在 `prefix/len` 内（非法输入一律 false，不猜）。 */
function inV6Prefix(addr: string, prefix: string, len: number): boolean {
  const a = expandV6(addr)
  const p = expandV6(prefix)
  if (!a || !p) return false
  let remaining = len
  for (let i = 0; i < 8; i++) {
    const bits = Math.min(16, Math.max(0, remaining))
    const mask = bits === 0 ? 0 : (0xffff << (16 - bits)) & 0xffff
    if ((a[i] & mask) !== (p[i] & mask)) return false
    remaining -= 16
  }
  return true
}

/**
 * 公网单播 v6：`2000::/3` 且**不是** `2001:db8::/32`（文档示例前缀）。
 * 只排除文档前缀这一条"明显不可能是真地址"的情况；隧道/NAT64 前缀的降级判定
 * 留给后续 routability 检查（本文件只回答"有没有全局地址"）。
 */
function isGlobalV6(addr: string): boolean {
  return inV6Prefix(addr, '2000::', 3) && !inV6Prefix(addr, '2001:db8::', 32)
}

/** 虚拟网卡（自动挑选局域网地址时要跳过）。 */
const VIRTUAL_IFACE_RE =
  /(vethernet|hyper-?v|vmware|virtualbox|vbox|docker|wsl|default switch|loopback|teredo|isatap|npcap|veth|utun|tailscale|zerotail|zerotier|wi-?fi\s*direct|本地连接\*|蓝牙|bluetooth|虚拟)/i

function isVirtualIface(name: string): boolean {
  return VIRTUAL_IFACE_RE.test(name)
}

/** 把 `interfaces()` 摊平成好判定的列表（family 既有 'IPv4' 字符串也有 4/6 数字）。 */
function listAddresses(deps: ProbeDeps): IfaceAddress[] {
  const table = deps.interfaces() ?? {}
  const out: IfaceAddress[] = []
  for (const [iface, infos] of Object.entries(table)) {
    if (!infos) continue
    for (const info of infos) {
      const fam = String(info.family)
      const family: 'IPv4' | 'IPv6' | null =
        fam === 'IPv6' || fam === '6' ? 'IPv6' : fam === 'IPv4' || fam === '4' ? 'IPv4' : null
      if (!family) continue
      const address = bareAddress(info.address)
      if (!address) continue
      out.push({ iface, address, family, internal: info.internal === true })
    }
  }
  return out
}

/** 局域网候选：非回环、非链路本地、非 CGNAT（Tailscale）、非虚拟网卡。 */
function collectLanV4(addresses: readonly IfaceAddress[]): IfaceAddress[] {
  return addresses.filter(
    (a) =>
      a.family === 'IPv4' &&
      !a.internal &&
      !isLinkLocalV4(a.address) &&
      !isCgnatV4(a.address) &&
      !isVirtualIface(a.iface),
  )
}

/** 全局 v6 候选（回环/链路本地/ULA/v4-mapped 都由 `isGlobalV6` 挡掉）。 */
function collectGlobalV6(addresses: readonly IfaceAddress[]): IfaceAddress[] {
  return addresses.filter((a) => a.family === 'IPv6' && !a.internal && isGlobalV6(a.address))
}

/** tailnet 地址：CGNAT 100.64/10，或 Tailscale 的 v6 ULA 前缀 `fd7a:115c:a1e0::/48`。 */
function collectTailnet(addresses: readonly IfaceAddress[]): string[] {
  const out: string[] = []
  for (const a of addresses) {
    if (a.internal) continue
    if (a.family === 'IPv4' && isCgnatV4(a.address)) out.push(a.address)
    else if (a.family === 'IPv6' && inV6Prefix(a.address, 'fd7a:115c:a1e0::', 48)) out.push(a.address)
  }
  return out
}

/** 只取正整数字面量端口（`0` 在契约里表示"跟随 DSH 端口"，不能当端口用）。 */
function positivePort(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65535 ? value : null
}

/** 第一条非空行（`where` 可能输出多行）。 */
function firstLine(text: string): string {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line) return line
  }
  return ''
}

/** 文案里列地址时最多列 3 个，避免长到没法读。 */
function joinSome(items: readonly string[], max = 3): string {
  const head = items.slice(0, max).join('、')
  return items.length > max ? `${head} 等 ${items.length} 个` : head
}

/* ------------------------------------------------------------------ *
 * 打码：token 绝不进 message/hint
 * ------------------------------------------------------------------ */

/** 形如 `token=…` / `k=…` / `secret=…` 的查询参数：整体替换成 `token=***`。 */
const SECRET_PARAM_RE =
  /(^|[?&#;\s])([a-z0-9_.-]*(?:token|secret|passwd|password|pwd|apikey|api_key|key|auth)|k|t)=([^&#\s"'<>]*)/gi

/** 从 settings 里收集"出现过的秘密值"，用于逐字替换（防 token 藏在非查询串位置）。 */
function collectSecrets(settings: RemoteSettings): string[] {
  const found = new Set<string>()
  const raw = str(settings.manualUrl)
  if (raw) {
    for (const m of raw.matchAll(SECRET_PARAM_RE)) {
      const value = m[3]
      if (value) found.add(value)
    }
    try {
      const parsed = new URL(raw)
      for (const [name, value] of parsed.searchParams) {
        if (value && /token|secret|pass|key|auth|^k$|^t$/i.test(name)) found.add(value)
      }
    } catch {
      // 非法 URL 由 `manual-url-parse` 自己报 fail；这里只负责打码，不重复报错。
    }
  }
  return [...found].filter((s) => s.length > 0)
}

/** 统一打码：先按参数名打码，再把已知明文值逐字替换成 `***`。 */
function redactText(text: string, secrets: readonly string[]): string {
  let out = text.replace(
    SECRET_PARAM_RE,
    (_match: string, lead: string, name: string) => `${lead}${name}=***`,
  )
  for (const secret of secrets) {
    // 太短的值容易被误伤正常文案（例如 token="ok"），但会先被参数名规则覆盖
    if (secret.length < 4) continue
    out = out.split(secret).join('***')
  }
  return out
}

/* ------------------------------------------------------------------ *
 * 系统输出解析
 * ------------------------------------------------------------------ */

interface V6AddressTable {
  temporary: Set<string>
  deprecated: Set<string>
}

/**
 * 解析 `netsh interface ipv6 show addresses` 的地址表。
 *
 * 真实输出形如（Windows 11，列：Addr Type / DAD State / Valid Life / Pref. Life / Address）：
 *   Public     Preferred     23h54m7s      54m7s 2409:8a20:...:7540:763c
 *   Temporary  Preferred     23h54m7s      54m7s 2409:8a20:...:e5ec
 * 地址取该行最后一个像 v6 的 token（可能带 `%接口序号`）。
 * 一行都没解析出来 → null（调用方据此给 `unknown`，绝不猜稳定）。
 */
function parseV6AddressTable(text: string): V6AddressTable | null {
  const temporary = new Set<string>()
  const deprecated = new Set<string>()
  let rows = 0
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('-')) continue
    const tokens = line.split(/\s+/)
    if (tokens.length < 2) continue
    const kind = tokens[0].toLowerCase()
    const isTemp = /^(temporary|临时)/.test(kind)
    const isDeprecated = /^(deprecated|已弃用|弃用)/.test(kind)
    const isPublic = /^(public|公用|公共)/.test(kind)
    if (!isTemp && !isDeprecated && !isPublic) continue
    let addr = ''
    for (let i = tokens.length - 1; i >= 0; i--) {
      const candidate = bareAddress(tokens[i])
      if (isIPv6(candidate) && expandV6(candidate)) {
        addr = candidate.toLowerCase()
        break
      }
    }
    if (!addr) continue
    rows++
    if (isTemp) temporary.add(addr)
    else if (isDeprecated) deprecated.add(addr)
  }
  return rows > 0 ? { temporary, deprecated } : null
}

interface FirewallProfile {
  state: 'on' | 'off' | 'unknown'
  /** true = 默认阻止入站；false = 默认允许入站；null = 输出里没有策略行。 */
  blockInbound: boolean | null
  /** 当前生效的配置文件（domain/private/public）；用于核对放行规则是否真的适用。 */
  profiles: string[]
}

/**
 * 解析 `netsh advfirewall show currentprofile`。
 *
 * 注意真实输出有两个坑（本机 2026-11-17 实测）：
 *   1. **可能同时打印多个配置文件段**（`Private Profile Settings:` + `Public Profile Settings:`）；
 *   2. **非控制台执行时输出是简体中文**（`专用配置文件 设置:` / `状态 启用`），而策略值仍是
 *      `BlockInbound,AllowOutbound`。所以这里同时认中英文标签，并把"专用/公用/域"归一成
 *      `private` / `public` / `domain`，否则规则比对会永远对不上。
 * 多段之间只要有一段默认阻止入站，就按"阻止"处理（保守方向）。
 */
function parseFirewallProfile(text: string): FirewallProfile {
  const states: Array<'on' | 'off'> = []
  const profiles = new Set<string>()
  let blockInbound: boolean | null = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    const header = /^(.+?)\s*(?:Profile\s+Settings|配置文件\s*设置)\s*[:：]?$/i.exec(line)
    if (header) {
      profiles.add(normalizeProfileName(header[1]))
      continue
    }
    const stateMatch = /^(?:State|状态)\s*[:：]?\s*(ON|OFF|启用|已启用|关闭|已关闭)$/i.exec(line)
    if (stateMatch) {
      const value = stateMatch[1].toLowerCase()
      states.push(value === 'on' || value.startsWith('启') ? 'on' : 'off')
      continue
    }
    const policyMatch = /^(?:Firewall Policy|防火墙策略)\s*[:：]?\s*(.+)$/i.exec(line)
    if (policyMatch) {
      const value = policyMatch[1].toLowerCase()
      if (value.includes('blockinbound') || value.includes('阻止入站')) blockInbound = true
      else if (value.includes('allowinbound') && blockInbound !== true) blockInbound = false
    }
  }
  const state: FirewallProfile['state'] =
    states.length === 0 ? 'unknown' : states.every((s) => s === 'off') ? 'off' : 'on'
  return { state, blockInbound, profiles: [...profiles] }
}

/** 配置文件名的中英归一（`专用`/`private` → `private`），规则比对必须两边同一套写法。 */
function normalizeProfileName(value: string): string {
  const v = value.trim().toLowerCase()
  if (v === '域' || v === 'domain') return 'domain'
  if (v === '专用' || v === '私有' || v === 'private') return 'private'
  if (v === '公用' || v === '公共' || v === 'public') return 'public'
  return v
}

interface FirewallAllowRule {
  name: string
  enabled: boolean
  action: string
  profiles: string
  protocol: string
  ports: string[]
  program: string
}

/**
 * 读入站规则用 `netsh advfirewall firewall show rule dir=in verbose`：
 * 一次原生调用 ~0.4s 就能拿到全部入站规则；改用 `Get-NetFirewallRule` + 逐条
 * `Get-NetFirewallPortFilter` 在本机实测要 10s 以上（每规则一次 WMI 查询），
 * 冷启动时还会超时 → 只能给 unknown。**只读**：show 命令不改任何规则。
 */
const FIREWALL_RULE_ARGS: readonly string[] = [
  'advfirewall',
  'firewall',
  'show',
  'rule',
  'name=all',
  'dir=in',
  'verbose',
]

/** netsh 规则块的标签（键已去空格小写）：中英文都认。 */
const FIREWALL_LABELS: Readonly<Record<string, string>> = {
  rulename: 'name',
  规则名称: 'name',
  enabled: 'enabled',
  已启用: 'enabled',
  action: 'action',
  操作: 'action',
  profiles: 'profiles',
  配置文件: 'profiles',
  protocol: 'protocol',
  协议: 'protocol',
  localport: 'localport',
  本地端口: 'localport',
  program: 'program',
  程序: 'program',
}

/**
 * 解析 netsh 的规则块（`Rule Name:` / `规则名称:` 为分隔，键值行是 `标签: 值`）。
 *
 * 只管"读出来"，判定在 `ruleCoversPort` 里做；一块都没解析出来 → 空数组
 * （调用方会据此给 warn"没找到覆盖端口的规则"）——所以标签必须两种语言都认，
 * 否则中文环境下会误报"没有规则"。
 */
function parseNetshFirewallRules(text: string): FirewallAllowRule[] {
  const rules: FirewallAllowRule[] = []
  let current: Map<string, string> | null = null
  const flush = (): void => {
    if (!current) return
    const name = current.get('name') ?? ''
    if (name !== '') {
      rules.push({
        name,
        enabled: /^(yes|是|true)$/i.test(current.get('enabled') ?? ''),
        action: current.get('action') ?? '',
        profiles: current.get('profiles') ?? '',
        protocol: current.get('protocol') ?? '',
        ports: (current.get('localport') ?? '')
          .split(',')
          .map((p) => p.trim())
          .filter((p) => p !== ''),
        program: (current.get('program') ?? '').replace(/^"|"$/g, '').trim(),
      })
    }
    current = null
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('-')) continue
    const sep = line.indexOf(':')
    if (sep <= 0) continue
    const rawKey = line.slice(0, sep).trim().toLowerCase().replace(/\s+/g, '')
    const field = FIREWALL_LABELS[rawKey]
    if (!field) continue
    const value = line.slice(sep + 1).trim()
    if (field === 'name') {
      flush()
      current = new Map<string, string>()
      current.set(field, value)
      continue
    }
    if (!current) continue
    // netsh 会把同名规则分块打印（同名不同协议）；每块里同名键只取第一次
    if (!current.has(field)) current.set(field, value)
  }
  flush()
  return rules
}

/**
 * 这条规则是否**真的覆盖**该端口。
 *
 * 关键防假阳性：`LocalPort=Any`（中文输出是「任何」）的入站放行规则很多（本机实测有
 * Wi-Fi Direct 的两条、只放行 svchost），它们只对特定程序生效，**不代表**我们的端口被放行。所以：
 *   - 端口精确命中 → 覆盖（规则是冲这个端口来的）；
 *   - 端口是 Any → 还要求"程序不限"或"程序就是本进程的可执行文件"。
 * 另外规则的配置文件必须包含当前生效的配置文件（或 Any），否则它在当前网络下不生效。
 */
function ruleCoversPort(
  rule: FirewallAllowRule,
  port: number,
  activeProfiles: readonly string[],
  exePath: string,
): boolean {
  if (!rule.enabled) return false
  if (!/^(allow|允许)$/i.test(rule.action)) return false
  if (!/^(tcp|any|任何)$/i.test(rule.protocol)) return false

  const ruleProfiles = rule.profiles
    .toLowerCase()
    .split(/[,，]/)
    .map((p) => normalizeProfileName(p))
    .filter((p) => p !== '')
  const profileOk =
    ruleProfiles.length === 0 ||
    ruleProfiles.includes('any') ||
    ruleProfiles.includes('任何') ||
    activeProfiles.some((p) => ruleProfiles.includes(p))
  if (!profileOk) return false

  if (rule.ports.some((p) => p === String(port))) return true
  if (!rule.ports.some((p) => /^(any|任何)$/i.test(p))) return false

  const program = rule.program.toLowerCase()
  if (program === '' || program === 'any' || program === '任何' || program === 'n/a') return true
  if (!exePath) return false
  const exe = exePath.toLowerCase()
  if (program === exe) return true
  const base = exe.slice(exe.lastIndexOf('\\') + 1)
  return base !== '' && (program.endsWith(`\\${base}`) || program.endsWith(`/${base}`))
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

function chk(id: string, level: RemoteLevel, message: string, hint: string): RemoteCheck {
  return { id, level, message, hint }
}

/** 注入实现的异常 → "没拿到证据"，由调用方给出 unknown/fail（绝不变成 ok）。 */
async function safeConnect(deps: ProbeDeps, host: string, port: number, timeoutMs: number): Promise<boolean> {
  try {
    return await deps.connect(host, port, timeoutMs)
  } catch {
    return false
  }
}

async function safeCommand(
  deps: ProbeDeps,
  file: string,
  args: string[],
  timeoutMs: number,
): Promise<string | null> {
  try {
    const out = await deps.command(file, args, timeoutMs)
    return typeof out === 'string' ? out : null
  } catch {
    return null
  }
}

function isoAt(now: () => Date): string {
  try {
    const value = now()
    if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString()
  } catch {
    // 注入的 now() 抛错不该让自检整个失败；退回系统时间（只影响展示）
  }
  return new Date().toISOString()
}

function aggregateLevel(checks: readonly RemoteCheck[]): RemoteLevel {
  if (checks.some((c) => c.level === 'fail')) return 'fail'
  if (checks.some((c) => c.level === 'unknown')) return 'unknown'
  if (checks.some((c) => c.level === 'warn')) return 'warn'
  return 'ok'
}

/**
 * 总判定句（人话）。
 *
 * 关键不变量：只要有 `unknown`，**不会**说"已就绪"；只有 `external-reachability` /
 * `ws-upgrade` 这类"必须从外网实测"的 unknown 才允许说"本机检查通过"。
 */
function buildVerdict(mode: RemoteAccessMode, checks: readonly RemoteCheck[], level: RemoteLevel): string {
  const fails = checks.filter((c) => c.level === 'fail').length
  const unknowns = checks.filter((c) => c.level === 'unknown')
  const warns = checks.filter((c) => c.level === 'warn').length
  if (level === 'fail') return `还不能用：先解决 ${fails} 个失败项（见下方「失败」条目）`
  if (level === 'unknown') {
    if (unknowns.every((c) => EXTERNAL_UNKNOWN_IDS.includes(c.id))) {
      return '本机检查通过，但公网可达性必须从外网确认'
    }
    return `本机检查未完成：${unknowns.length} 项无法在本机自证，见下方「未知」条目`
  }
  if (level === 'warn') return `${MODE_READY[mode]}（另有 ${warns} 项提醒，按需处理）`
  return MODE_READY[mode]
}

/** 通用检查（所有 mode 都跑）：端口已知 + 本机回环连通。 */
async function runCommonChecks(
  deps: ProbeDeps,
  dshPort: number | null,
  add: (check: RemoteCheck) => void,
): Promise<void> {
  if (dshPort === null) {
    add(
      chk(
        'dsh-port-known',
        'warn',
        '拿不到 DSH 监听端口，无法自检',
        '重启 DSH（端口来自 ctx.webServer.port）后再点一次「重新自检」；若一直拿不到，说明 DSH 的 Web 服务没起来。',
      ),
    )
  } else {
    add(chk('dsh-port-known', 'ok', `DSH 监听端口：${dshPort}`, ''))
  }

  if (dshPort === null) {
    add(
      chk(
        'dsh-loopback-reachable',
        'unknown',
        '端口未知，没法测本机回环连通性',
        '先让 DSH 报出监听端口（重启 DSH），或在设置里把远程端口填成固定值 1024–65535 后重新自检。',
      ),
    )
    return
  }
  const loopbackOk = await safeConnect(deps, '127.0.0.1', dshPort, LOOPBACK_TIMEOUT_MS)
  if (loopbackOk) {
    add(chk('dsh-loopback-reachable', 'ok', `本机能连上 127.0.0.1:${dshPort}`, ''))
  } else {
    add(
      chk(
        'dsh-loopback-reachable',
        'fail',
        `本机连不上 DSH 自己的端口（127.0.0.1:${dshPort}）`,
        '确认 DSH 已启动、该端口没被别的程序占用；重启 DSH 后再自检一次。',
      ),
    )
  }
}

/** 局域网方式：选具体网卡地址 + 检查旁挂监听绑定。 */
function runLanChecks(
  deps: ProbeDeps,
  settings: RemoteSettings,
  listenerPort: number | null,
  add: (check: RemoteCheck) => void,
): void {
  const addresses = listAddresses(deps)
  const candidates = collectLanV4(addresses)
  const configured = bareAddress(str(settings.lanAddress))
  let chosen = ''

  if (configured && isWildcard(configured)) {
    add(
      chk(
        'lan-address',
        'fail',
        '设置里的局域网地址是通配地址（不是具体网卡地址），DSH 会拒绝绑定',
        candidates.length > 0
          ? `把局域网地址改成 ${candidates[0].address}（${candidates[0].iface}），或留空让插件自动挑。`
          : '把它留空让插件自动挑，或先连上一个真实的 Wi-Fi/网线。',
      ),
    )
  } else if (configured) {
    chosen = configured
    add(chk('lan-address', 'ok', `使用设置里的局域网地址 ${chosen}`, ''))
  } else if (candidates.length === 0) {
    add(
      chk(
        'lan-address',
        'fail',
        '没找到可用的局域网 IPv4 地址',
        '让平板和电脑连到同一个 Wi-Fi/路由器；如果只剩 Hyper-V / VMware / WSL 这类虚拟网卡，先停用它们再自检。',
      ),
    )
  } else {
    chosen = candidates[0].address
    add(
      chk(
        'lan-address',
        'ok',
        `已自动选中局域网地址 ${chosen}（网卡：${candidates[0].iface}）`,
        candidates.length > 1 ? `其它候选：${joinSome(candidates.slice(1).map((a) => a.address))}；选错了就在设置里手动指定。` : '',
      ),
    )
  }

  const listener = deps.listenerAddress === null ? '' : bareAddress(deps.listenerAddress)
  if (!listener) {
    add(
      chk(
        'lan-bind',
        'warn',
        '旁挂监听未启动',
        `在插件里点「启动远程访问」，让它绑到 ${chosen || '具体网卡地址'}:${listenerPort ?? '<端口>'}；若启动失败，看状态里的 lastError。`,
      ),
    )
  } else if (isWildcard(listener)) {
    add(
      chk(
        'lan-bind',
        'fail',
        '绑到了通配地址，DSH 会拒绝',
        `把绑定地址改成具体网卡地址 ${chosen || '<局域网地址>'} 后重启监听。`,
      ),
    )
  } else {
    add(chk('lan-bind', 'ok', `旁挂监听已绑定 ${listener}（不是通配地址）`, ''))
  }

  // 只有"监听已起且拿到具体地址"时才有可比对象；没数据就不编一条 check。
  if (listener && !isWildcard(listener) && chosen) {
    if (listener.toLowerCase() !== chosen.toLowerCase()) {
      add(
        chk(
          'lan-same-subnet',
          'warn',
          `监听地址 ${listener} 与设置里的局域网地址 ${chosen} 不一致`,
          `把设置里的局域网地址改成 ${listener}，或重启监听让它按设置重新绑定；否则平板上要填 ${listener}。`,
        ),
      )
    } else {
      add(chk('lan-same-subnet', 'ok', `监听地址与局域网地址一致：${listener}`, ''))
    }
  }
}

/** IPv6 方式：全局地址 / 临时地址 / 监听是否真在该 v6 上 / 防火墙 / 外网可达。 */
async function runIpv6Checks(
  deps: ProbeDeps,
  settings: RemoteSettings,
  listenerPort: number | null,
  add: (check: RemoteCheck) => void,
): Promise<void> {
  const addresses = listAddresses(deps)
  const globals = collectGlobalV6(addresses)

  // 地址表只在 Windows 上有（netsh）；读不到就是 unknown，不猜。
  let table: V6AddressTable | null = null
  if (globals.length > 0 && deps.platform === 'win32') {
    const text = await safeCommand(deps, 'netsh', ['interface', 'ipv6', 'show', 'addresses'], COMMAND_TIMEOUT_MS)
    table = text ? parseV6AddressTable(text) : null
  }
  const tbl = table
  const stableGlobals = tbl
    ? globals.filter((a) => {
        const key = a.address.toLowerCase()
        return !tbl.temporary.has(key) && !tbl.deprecated.has(key)
      })
    : globals

  if (globals.length === 0) {
    add(
      chk(
        'v6-global',
        'fail',
        '本机没有拿到任何全局 IPv6 地址，公网 v6 直连不成立',
        '在路由器上打开 IPv6/双栈（RA/DHCPv6），或联系宽带客服开通 IPv6；改完重启路由器再自检。',
      ),
    )
  } else if (!table) {
    add(
      chk(
        'v6-global',
        'unknown',
        `本机有 ${globals.length} 个全局 IPv6 地址，但无法区分临时/稳定地址`,
        '在管理员命令提示符里跑 netsh interface ipv6 show addresses，确认有一条 Addr Type 为 Public（公用）的稳定地址。',
      ),
    )
  } else if (stableGlobals.length === 0) {
    add(
      chk(
        'v6-global',
        'fail',
        '只有临时（Temporary）隐私地址，没有稳定地址；临时地址约每小时轮换，外网会突然失联',
        '在网卡属性里关掉「临时 IPv6 地址」/改用稳定隐私地址，让 netsh 里出现 Public 那条后再自检。',
      ),
    )
  } else {
    add(
      chk(
        'v6-global',
        'ok',
        `找到 ${stableGlobals.length} 个稳定的全局 IPv6 地址：${joinSome(stableGlobals.map((a) => a.address))}`,
        '',
      ),
    )
  }

  const configuredV6 = bareAddress(str(settings.ipv6Address))
  const chosen = configuredV6 || (stableGlobals[0] ?? globals[0])?.address || ''
  const auto = configuredV6 === '' && chosen !== ''

  if (!chosen) {
    add(
      chk(
        'v6-stable',
        'fail',
        '没有可绑定的全局 IPv6 地址',
        '先在路由器/宽带侧开通 IPv6，让本机出现 Public 的全局地址；本机现在没有能绑的地址。',
      ),
    )
  } else if (table?.temporary.has(chosen.toLowerCase())) {
    add(
      chk(
        'v6-stable',
        'fail',
        `选的是临时地址，重启就变：${chosen}`,
        `改用稳定地址 ${stableGlobals[0]?.address ?? '（netsh 里 Addr Type 为 Public 的那条）'}；临时地址约每小时轮换，外网会周期性连不上。`,
      ),
    )
  } else if (table?.deprecated.has(chosen.toLowerCase())) {
    add(
      chk(
        'v6-stable',
        'fail',
        `选中的地址已被系统标记为已弃用（Deprecated）：${chosen}`,
        '改用 netsh 里 Addr Type 为 Public 且 DAD State 为 Preferred 的地址。',
      ),
    )
  } else if (table) {
    add(
      chk(
        'v6-stable',
        'ok',
        `${auto ? '已自动选中稳定地址' : '地址稳定'}：${chosen}（不是临时隐私地址）`,
        auto ? '想固定下来就在设置里把 IPv6 地址填成这个值。' : '',
      ),
    )
  } else {
    add(
      chk(
        'v6-stable',
        'unknown',
        `无法区分临时/稳定地址，没法确认 ${chosen} 重启后是否还在`,
        `在管理员命令提示符跑 netsh interface ipv6 show addresses，确认 ${chosen} 的 Addr Type 是 Public 而不是 Temporary。`,
      ),
    )
  }

  const listener = deps.listenerAddress === null ? '' : bareAddress(deps.listenerAddress)
  if (!listener) {
    add(
      chk(
        'dsh-bound-v6',
        'warn',
        '旁挂监听未启动，该 v6 地址上没有监听',
        `在插件里点「启动远程访问」，让它绑到 ${chosen || '具体 v6 地址'}:${listenerPort ?? '<端口>'}。`,
      ),
    )
  } else if (isWildcard(listener)) {
    add(
      chk(
        'dsh-bound-v6',
        'fail',
        '旁挂监听绑在通配地址上，DSH 会拒绝，也无法自证具体 v6 地址可达',
        `改成具体 v6 地址 ${chosen || '<本机全局 v6>'} 后重启监听。`,
      ),
    )
  } else if (!isIPv6(listener)) {
    add(
      chk(
        'dsh-bound-v6',
        'fail',
        `旁挂监听在 IPv4 地址上（${listener}），IPv6 方式下平板连不到`,
        `把监听地址改成 ${chosen || '本机的全局 v6 地址'} 再重启监听。`,
      ),
    )
  } else if (listenerPort === null) {
    add(
      chk(
        'dsh-bound-v6',
        'unknown',
        `监听地址是 ${listener}，但拿不到端口，没法测有没有监听`,
        '重启 DSH 让它报出端口，或在设置里填一个固定端口后重新自检。',
      ),
    )
  } else {
    const bound = await safeConnect(deps, listener, listenerPort, V6_CONNECT_TIMEOUT_MS)
    if (!bound) {
      add(
        chk(
          'dsh-bound-v6',
          'fail',
          `该 v6 地址上没有监听（${listener}:${listenerPort} 连不上）`,
          `把 DSH/旁挂监听的绑定地址改成 ${listener}、端口 ${listenerPort} 后重启；也确认该端口没被别的程序占用。`,
        ),
      )
    } else if (chosen && listener.toLowerCase() !== chosen.toLowerCase()) {
      add(
        chk(
          'dsh-bound-v6',
          'warn',
          `能连上 ${listener}:${listenerPort}，但与设置里的 v6 地址 ${chosen} 不一致`,
          `把设置里的 IPv6 地址改成 ${listener}，否则平板上填的地址会连不上。`,
        ),
      )
    } else {
      add(chk('dsh-bound-v6', 'ok', `能连上 [${listener}]:${listenerPort}（本机自连）`, ''))
    }
  }

  await runFirewallCheck(deps, listenerPort, chosen, add)

  // 外网可达性：本机永远无法自证——恒 unknown，且压住"已就绪"的结论。
  const probeTarget = chosen || listener
  const probeUrl = probeTarget ? `http://[${probeTarget}]${listenerPort ? `:${listenerPort}` : ''}/` : ''
  add(
    chk(
      'external-reachability',
      'unknown',
      '本机无法自证公网可达；请用平板在外网打开下面的地址确认',
      `平板关掉 Wi-Fi、改用蜂窝数据（或换到不在你家的网络），打开 ${probeUrl || 'http://[本机全局IPv6]:端口/'}；能打开才算通过。打不开先查路由器的 IPv6 防火墙是否放行入站 ${listenerPort ?? '<端口>'}。`,
    ),
  )
}

/** Windows 防火墙入站：读不到 = unknown；读到了但没证据 = warn（绝不假装 ok）。 */
async function runFirewallCheck(
  deps: ProbeDeps,
  port: number | null,
  chosenV6: string,
  add: (check: RemoteCheck) => void,
): Promise<void> {
  if (deps.platform !== 'win32') {
    add(
      chk(
        'firewall-inbound',
        'unknown',
        '非 Windows，本机无法读取防火墙入站规则',
        '在系统防火墙里确认已放行该端口的入站 TCP（这一步只能你人工确认）。',
      ),
    )
    return
  }

  const profileText = await safeCommand(deps, 'netsh', ['advfirewall', 'show', 'currentprofile'], COMMAND_TIMEOUT_MS)
  if (!profileText) {
    add(
      chk(
        'firewall-inbound',
        'unknown',
        '读不到防火墙状态（权限不足或 netsh 不可用）',
        '用管理员身份打开 PowerShell 跑 Get-NetFirewallProfile，或直接在 wf.msc 里核对入站规则。',
      ),
    )
    return
  }

  const profile = parseFirewallProfile(profileText)
  if (profile.state === 'off') {
    add(
      chk(
        'firewall-inbound',
        'warn',
        'Windows 防火墙当前是关闭状态，入站不被拦，等于把整台机器暴露出去',
        '打开防火墙，并只为 DSH 端口加一条入站允许规则（配置文件至少包含「公用」）。',
      ),
    )
    return
  }
  if (profile.state === 'unknown') {
    add(
      chk(
        'firewall-inbound',
        'unknown',
        '防火墙状态读不出来（netsh 输出里没有 State/状态 一行）',
        '用管理员 PowerShell 跑 Get-NetFirewallProfile 人工确认当前配置文件的入站策略。',
      ),
    )
    return
  }
  if (profile.blockInbound === false) {
    add(
      chk(
        'firewall-inbound',
        'ok',
        'Windows 防火墙当前配置文件默认允许入站（策略 AllowInbound）',
        '入站没被拦，但建议改成默认阻止、只为 DSH 端口放行。',
      ),
    )
    return
  }

  // 默认阻止入站（或策略行读不出来）：只有真的枚举到"覆盖该端口"的放行规则才算 ok。
  if (port === null) {
    add(
      chk(
        'firewall-inbound',
        'unknown',
        '端口未知，无法核对防火墙有没有放行该端口',
        '重启 DSH 让它报出监听端口（或在设置里固定端口）后再自检。',
      ),
    )
    return
  }

  const ruleText = await safeCommand(deps, 'netsh', [...FIREWALL_RULE_ARGS], FIREWALL_RULE_TIMEOUT_MS)
  if (ruleText === null) {
    // "没查到"和"查完了确实没有"是两件事，不能混成 warn 文案。
    add(
      chk(
        'firewall-inbound',
        'unknown',
        '没能读取入站放行规则列表（netsh 不可用或超时）',
        '在管理员命令提示符里跑 netsh advfirewall firewall show rule name=all dir=in verbose，找 Action 为 Allow 且 LocalPort 覆盖该端口的规则。',
      ),
    )
    return
  }

  const rules = parseNetshFirewallRules(ruleText)
  const hit = rules.find((rule) => ruleCoversPort(rule, port, profile.profiles, process.execPath))
  if (hit) {
    add(
      chk(
        'firewall-inbound',
        'ok',
        `已找到入站放行规则：${hit.name}（配置文件：${hit.profiles || '未标注'}，端口：${hit.ports.join(',') || '未知'}）`,
        `确认这条规则只覆盖端口 ${port} 或只覆盖 DSH 程序本身；「任意端口 + 任意程序」等于全开。`,
      ),
    )
    return
  }
  add(
    chk(
      'firewall-inbound',
      'warn',
      `Windows 防火墙默认阻止入站，没找到覆盖端口 ${port} 的放行规则（当前配置文件：${
        profile.profiles.length > 0 ? profile.profiles.join('、') : '未知'
      }）`,
      `在 wf.msc 新增入站规则：程序选 DSH 的可执行文件，协议 TCP，本地端口 ${port}，配置文件至少勾「公用」。${
        chosenV6 ? '' : '（当前没有选中的 v6 地址，规则做好也未必有地址可绑。）'
      }`,
    ),
  )
}

/** Tailscale 方式：本机是否有 tailnet 地址 + 设置里的主机名是否对得上。 */
function runTailscaleChecks(
  deps: ProbeDeps,
  settings: RemoteSettings,
  listenerPort: number | null,
  add: (check: RemoteCheck) => void,
): void {
  const addresses = listAddresses(deps)
  const tailnet = collectTailnet(addresses)
  const host = str(settings.tailscaleHost).trim()

  if (tailnet.length > 0) {
    add(
      chk(
        'tailnet-address',
        'ok',
        `本机 Tailscale 地址：${joinSome(tailnet)}`,
        '平板必须装第三方鸿蒙原生 Tailscale 客户端（如 HarmoTail）并在「设置 → VPN」里连上；卓易通里的 Tailscale 只覆盖兼容层内的 App，对本应用无效。',
      ),
    )
  } else {
    add(
      chk(
        'tailnet-address',
        'warn',
        '本机没有 Tailscale 地址，Tailscale 可能未登录/未启动',
        '先装 Tailscale 并登录、确认托盘里显示已连接；连上后本机会多出一个 100.64.0.0/10 段的地址，再自检。',
      ),
    )
  }

  if (!host) {
    add(
      chk(
        'tailscale-host-match',
        'warn',
        '还没填 Tailscale 主机名',
        '填 MagicDNS 名（形如 设备名.tailnet-xxxx.ts.net）或本机的 100.x 地址。',
      ),
    )
    return
  }
  if (tailnet.length === 0) {
    add(
      chk(
        'tailscale-host-match',
        'warn',
        `设置里填了 ${host}，但本机没有 Tailscale 地址，无法核对`,
        '先让 Tailscale 登录并连上；本机出现 100.x 地址后再自检。',
      ),
    )
    return
  }
  const literal = bareAddress(host)
  if (isIPv4(literal) || isIPv6(literal)) {
    if (tailnet.some((a) => a.toLowerCase() === literal.toLowerCase())) {
      add(chk('tailscale-host-match', 'ok', `设置的主机名与本机地址一致：${literal}`, ''))
    } else {
      add(
        chk(
          'tailscale-host-match',
          'warn',
          `设置里的 ${literal} 与本机发现的 tailnet 地址（${joinSome(tailnet)}）不一致`,
          `把设置改成 ${tailnet[0]}，或确认 Tailscale 登录的是同一个账号/同一台机器。`,
        ),
      )
    }
    return
  }

  // MagicDNS 名：本机不联网解析，无法核对它指向哪个地址 → 诚实给 unknown。
  add(
    chk(
      'tailscale-host-match',
      'unknown',
      `「${host}」是域名（MagicDNS），本机不联网解析，无法核对它指向哪个地址`,
      `在电脑上 ping ${host}，或打开 http://${host}:${listenerPort ?? '<端口>'}/ 确认它解析到 ${tailnet[0]}；MagicDNS 要求两端都登录同一 tailnet。`,
    ),
  )
}

/** 主机名归一：去掉协议、路径、端口、方括号，只留主机名。 */
function normalizeHostInput(raw: string): string {
  let host = raw.trim()
  const schemeAt = host.indexOf('://')
  if (schemeAt >= 0) host = host.slice(schemeAt + 3)
  const slash = host.search(/[/?#]/)
  if (slash >= 0) host = host.slice(0, slash)
  const at = host.lastIndexOf('@')
  if (at >= 0) host = host.slice(at + 1)
  if (host.startsWith('[')) {
    const close = host.indexOf(']')
    if (close > 0) host = host.slice(1, close)
  } else {
    const colon = host.lastIndexOf(':')
    if (colon > 0 && /^\d+$/.test(host.slice(colon + 1))) host = host.slice(0, colon)
  }
  return host.replace(/\.+$/, '').toLowerCase()
}

/** 合法 FQDN（隧道域名必须有域名点，不接受 localhost/纯 IP 之外的胡写）。 */
const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i

/** Cloudflare 方式：cloudflared 是否安装 + 域名形态 + WS 101 实测（只认注入结果）。 */
async function runCloudflareChecks(
  deps: ProbeDeps,
  settings: RemoteSettings,
  listenerPort: number | null,
  wsProbe: ProbeExtras['wsUpgrade'],
  add: (check: RemoteCheck) => void,
): Promise<void> {
  const finder = deps.platform === 'win32' ? 'where' : 'which'
  const found = await safeCommand(deps, finder, ['cloudflared'], COMMAND_TIMEOUT_MS)
  const cloudflaredPath = found ? firstLine(found) : ''
  if (cloudflaredPath) {
    add(chk('cloudflared-installed', 'ok', `已找到 cloudflared：${cloudflaredPath}`, ''))
  } else {
    add(
      chk(
        'cloudflared-installed',
        'warn',
        '本机没装 cloudflared',
        deps.platform === 'win32'
          ? '从 Cloudflare 官方下载 cloudflared.exe 放到 PATH 里（或记住完整路径再手动跑）；装好后再自检。'
          : '用系统包管理器装 cloudflared（或用官方二进制），装好后再自检。',
      ),
    )
  }

  const rawHost = str(settings.cloudflareHost).trim()
  const host = normalizeHostInput(rawHost)
  if (!rawHost) {
    add(
      chk(
        'tunnel-host',
        'fail',
        '还没填 Cloudflare 隧道域名',
        `先跑 cloudflared tunnel --url http://127.0.0.1:${listenerPort ?? '<DSH端口>'}，把它输出的 https://xxx.trycloudflare.com 里的域名粘到这里。`,
      ),
    )
  } else if (!HOSTNAME_RE.test(host)) {
    add(
      chk(
        'tunnel-host',
        'fail',
        '隧道域名看起来不是合法主机名',
        '只填主机名，例如 abc-def-ghi.trycloudflare.com（不要协议、不要路径、不要空格）。',
      ),
    )
  } else if (host !== rawHost.toLowerCase()) {
    add(
      chk(
        'tunnel-host',
        'warn',
        `只填主机名就行，已按 ${host} 判定`,
        '去掉 https:// 、端口与路径，只留域名。',
      ),
    )
  } else if (/\.trycloudflare\.com$/i.test(host)) {
    add(
      chk(
        'tunnel-host',
        'warn',
        'quick tunnel 域名每次重启都会变',
        'cloudflared 每次重启都会换域名，平板要重新扫码/粘地址；想固定域名请建命名隧道（cloudflared tunnel create + 绑定自有域）。',
      ),
    )
  } else {
    add(chk('tunnel-host', 'ok', `隧道域名：${host}`, ''))
  }

  const wsTarget = host || rawHost
  if (typeof wsProbe !== 'function') {
    add(
      chk(
        'ws-upgrade',
        'unknown',
        `需实测 wss://${wsTarget || '<host>'}${WS_MUX_PATH} 能否 101（本机没做这次实测）`,
        `在电脑上跑：curl.exe -sS -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" "https://${wsTarget || '<host>'}${WS_MUX_PATH}"，看到 101 Switching Protocols 才算通；200/302 登录页都不算。`,
      ),
    )
    return
  }

  try {
    const result = await wsProbe(wsTarget, WS_PROBE_TIMEOUT_MS)
    const status = result && typeof result.status === 'number' ? result.status : null
    const detail = result && typeof result.detail === 'string' ? result.detail : ''
    if (status === 101) {
      add(chk('ws-upgrade', 'ok', `wss://${wsTarget}${WS_MUX_PATH} 握手成功（101）`, ''))
    } else if (status !== null) {
      add(
        chk(
          'ws-upgrade',
          'fail',
          `WebSocket 握手返回 ${status}，不是 101，隧道没把 WS 透传过去${detail ? `（${detail}）` : ''}`,
          '换一个支持 WS 的隧道（命名隧道/自建反代），或检查隧道有没有改写 Upgrade/Connection 头。',
        ),
      )
    } else {
      add(
        chk(
          'ws-upgrade',
          'unknown',
          `WebSocket 实测没拿到状态码（超时或连不上）${detail ? `：${detail}` : ''}`,
          `确认隧道在跑、域名能解析，然后重跑一次实测：curl 打开 https://${wsTarget}${WS_MUX_PATH}，看有没有 101。`,
        ),
      )
    }
  } catch {
    // 注入的实测实现自己崩了：说明"没拿到证据"，不等于隧道可用。
    add(
      chk(
        'ws-upgrade',
        'unknown',
        'WebSocket 实测过程出错，没有拿到 101 证据',
        `手动实测：curl -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" https://${wsTarget}${WS_MUX_PATH}，看到 101 才算通。`,
      ),
    )
  }
}

/** 手动方式：URL 语法 + 明文 http 提醒（message 只用 origin+pathname，天然不带 token）。 */
function runManualChecks(settings: RemoteSettings, add: (check: RemoteCheck) => void): void {
  const rawUrl = str(settings.manualUrl).trim()
  if (!rawUrl) {
    add(
      chk(
        'manual-url-parse',
        'fail',
        '还没填手动地址',
        '填完整地址，例如 https://dsh.example.com/（token 不用自己拼，插件会带上）。',
      ),
    )
    return
  }

  let parsed: URL | null = null
  try {
    parsed = new URL(rawUrl)
  } catch {
    parsed = null
  }
  if (!parsed) {
    add(
      chk(
        'manual-url-parse',
        'fail',
        '手动地址格式不对，平板打不开',
        '要写完整地址：协议 + 主机（带端口时写 :端口），例如 https://dsh.example.com/ 或 http://[2409:8a20::1]:3080/。',
      ),
    )
    return
  }

  const shown = `${parsed.protocol}//${parsed.host}${parsed.pathname}`
  add(chk('manual-url-parse', 'ok', `地址格式正确：${shown}`, ''))
  if (parsed.protocol === 'https:') {
    add(chk('manual-url-scheme', 'ok', '已用 https', '自签证书需要平板手动信任一次。'))
  } else if (parsed.protocol === 'http:') {
    add(
      chk(
        'manual-url-scheme',
        'warn',
        '明文 http，仅限可信网络',
        '公网访问请改用带证书的 https（或 Cloudflare 隧道），否则 token 与会话内容会被中间人抓走。',
      ),
    )
  } else {
    add(
      chk(
        'manual-url-scheme',
        'warn',
        `协议是 ${parsed.protocol.replace(':', '')}，平板浏览器多半打不开`,
        '改用 http/https 的完整地址。',
      ),
    )
  }
}

/**
 * 跑一次连通性自检。
 *
 * @param mode 访问方式；只对认识的方式做检查，不认识的一律 fail-closed。
 * @param settings 持久化设置（只读；本函数不写任何东西）。
 * @param deps 可注入依赖（测试用假实现；真机由 `src/remote/service.ts` 注入运行时真值）。
 */
export async function runProbe(
  mode: RemoteAccessMode,
  settings: RemoteSettings,
  deps: Partial<ProbeDeps> = {},
): Promise<RemoteProbeResult> {
  const base = defaultProbeDeps()
  const resolved: ProbeDeps = {
    now: typeof deps.now === 'function' ? deps.now : base.now,
    interfaces: typeof deps.interfaces === 'function' ? deps.interfaces : base.interfaces,
    connect: typeof deps.connect === 'function' ? deps.connect : base.connect,
    command: typeof deps.command === 'function' ? deps.command : base.command,
    dshPort: deps.dshPort === undefined ? base.dshPort : deps.dshPort,
    listenerAddress: deps.listenerAddress === undefined ? base.listenerAddress : deps.listenerAddress,
    platform: typeof deps.platform === 'string' ? deps.platform : base.platform,
  }
  // 只读扩展能力（`wsUpgrade`），不做类型断言之外的任何副作用
  const extras = deps as Partial<ProbeDeps> & ProbeExtras

  const checks: RemoteCheck[] = []
  const add = (check: RemoteCheck): void => {
    checks.push(check)
  }

  if (!KNOWN_MODES.includes(mode)) {
    add(
      chk(
        'mode-unknown',
        'fail',
        `不认识的访问方式「${String(mode)}」，无法自检`,
        '在设置里重新选一个访问方式（局域网 / Tailscale / IPv6 / Cloudflare / 手动），再自检。',
      ),
    )
  } else {
    const dshPort = positivePort(resolved.dshPort)
    const listenerPort = positivePort(settings.port) ?? dshPort

    await runCommonChecks(resolved, dshPort, add)

    switch (mode) {
      case 'lan':
        runLanChecks(resolved, settings, listenerPort, add)
        break
      case 'ipv6':
        await runIpv6Checks(resolved, settings, listenerPort, add)
        break
      case 'tailscale':
        runTailscaleChecks(resolved, settings, listenerPort, add)
        break
      case 'cloudflare':
        await runCloudflareChecks(resolved, settings, listenerPort, extras.wsUpgrade, add)
        break
      case 'manual':
        runManualChecks(settings, add)
        break
      case 'uu': {
        // 第 5 轮订正：UU 远程**确实**有「图形化端口映射」（免费版含），不再判「不可用」。
        // 本机能判的只有两件事：入口填没填、形态像不像；入口能否从外网打开、WS 能否透传
        // 都只能实测，所以那两条一律 unknown（不假阳性）。
        const entry = (settings.manualUrl ?? '').trim()
        if (entry === '') {
          add(
            chk(
              'uu-entry',
              'fail',
              '还没填 UU 远程生成的对外入口',
              'UU远程 → 图形化端口映射 → 内部端口填 DSH 端口 → 复制生成的对外入口，粘到「对外入口地址」。',
            ),
          )
        } else {
          add(chk('uu-entry', 'ok', `已填对外入口：${entry.length} 个字符`, ''))
          add(
            chk(
              'uu-reachable',
              'unknown',
              '本机无法自证这个入口在外网可打开',
              '用平板（关掉 Wi-Fi、走流量）打开该入口确认；打不开就回 UU 客户端看映射是否在线。',
            ),
          )
          add(
            chk(
              'uu-ws-upgrade',
              'unknown',
              '端口映射是否放行 WebSocket upgrade 只能实测',
              '在内嵌页看是否出现「连接异常，刷新重试」，或抓 hilog 的 ERR_WS_UPGRADE。',
            ),
          )
        }
        break
      }
    }
  }

  // 统一打码后才返回：任何分支拼进去的 URL 都不会把 token 带出去。
  const secrets = collectSecrets(settings)
  const redacted: RemoteCheck[] = checks.map((check) => ({
    id: check.id,
    level: check.level,
    message: redactText(check.message, secrets),
    hint: redactText(check.hint, secrets),
  }))
  const level = aggregateLevel(redacted)
  const verdict =
    redacted.length > 0 && redacted.every((c) => c.id === 'mode-unknown')
      ? '还不能用：访问方式不认识，先回设置里重新选'
      : buildVerdict(mode, redacted, level)

  return {
    mode,
    level,
    checks: redacted,
    verdict: redactText(verdict, secrets),
    at: isoAt(resolved.now),
  }
}
