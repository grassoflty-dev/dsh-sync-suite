/**
 * 远程访问域的**装配层**：把 store / gate / routes / listener / probe / qr 拼成
 * `RemoteServiceLike`（`rpc.ts` 只认这个结构）。
 *
 * 三条硬纪律：
 *   1. **失败隔离**——`start()` 失败只写 `status.lastError`，绝不把异常抛给插件启动路径；
 *      `dispose()` 幂等且吞掉关闭错误。远程挂了，配置同步照常。
 *   2. **fail-closed**——拿不到上游身份、拿不到 DSH 端口、绑不到具体地址时一律不起监听，
 *      并在状态里给出人类可读原因；不降级到通配地址、不降级到无鉴权。
 *   3. **不落盘运行态**——监听地址/连接数/最近错误/最近自检只在内存（重启清零），
 *      避免状态文件变成第二事实来源（`docs/DATA-CONTRACT.md` 的约定）。
 *
 * 依赖全部**注入**（listener / gate / qr / probe 都是回调），因此本文件不 import
 * `listener.ts` / `auth.ts` / `qr.ts` / `probe.ts`：并行开发时不会互相卡编译，
 * 单测也能用假实现把状态机跑满。
 *
 * 唯一例外（mod-plugin-lan-address-selection）：从 `listener.ts` 引入**两个纯谓词**
 * `isBindableLanAddress` / `isBindableIpv6Address`。理由：选路结果必须与监听的真实准入门槛
 * 用**同一套判定**，否则会出现"自动挑中了却绑不上"的假故障；这两个函数是纯函数，不读盘、
 * 不起监听、不产生任何副作用，因此不会破坏上面的并行开发/注入解耦。
 */
import dgram from 'node:dgram'
import os from 'node:os'
import { isBindableIpv6Address, isBindableLanAddress } from './listener.js'
import { RemoteStore } from './store.js'
import { createRemoteAuthorizer } from './routes.js'
import type { RemoteAuthorizeInput, RemoteAuthorizeResult, RemoteGate } from './routes.js'
import { defaultRemoteSettings, listModes, normalizeRemoteSettings } from './accessMode.js'
import { appendAccessToken, maskToken, urlForMode } from './urls.js'
import type {
  LanCandidate,
  RemoteAccessMode,
  RemoteLink,
  RemoteProbeResult,
  RemoteServiceLike,
  RemoteSettings,
  RemoteSettingsView,
  RemoteStateData,
  RemoteStatus,
} from './types.js'

/** listener 句柄（与 `listener.ts` 的结构化契约）。 */
export interface RemoteListenerHandle {
  address: string
  port: number
  stats(): { active: number; total: number; rejected: number }
  lastError?: { code: string; message: string } | null
  close(): Promise<void>
}

/** 起监听需要的入参（与 `listener.ts` 的结构化契约）。 */
export interface RemoteListenerStartOptions {
  port: number
  bindAddress: string
  upstream: { baseUrl: string; headers?: Record<string, string> | (() => Record<string, string>) }
  /** mod-remote-tls-termination：配对证书 + 私钥；缺失时本层就 fail-closed，绝不退化成明文。 */
  tls: { cert: string; key: string }
  authorize?: (input: RemoteAuthorizeInput) => RemoteAuthorizeResult
  /** 入站连接审计钩子（由装配层接到配对服务的脱敏环）。 */
  onConnect?: (info: { at: string; remoteAddress: string }) => void
  /**
   * 上游**首字节预算**（毫秒，透传给 listener 的 `firstByteTimeoutMs`）。
   * 不传 = 用 listener 的默认值（15000）；上游挂死时平板最多等这么久，不会有别的上限。
   */
  firstByteTimeoutMs?: number
  /** 上游**连接预算**（毫秒，透传 listener 的 `connectTimeoutMs`；默认 5000）。 */
  connectTimeoutMs?: number
  /** 上游**空闲预算**（毫秒，透传 listener 的 `idleTimeoutMs`；默认 120000）。 */
  idleTimeoutMs?: number
  /** 并发实时隧道上限（透传 listener 的 `maxUpgradeTunnels`；默认 16）。 */
  maxUpgradeTunnels?: number
  /**
   * 上游回 401 时的**重新登录**回调（透传 listener 的 `onUpstreamUnauthorized`）：
   * 换一次身份（single-flight）并返回新头；换不到时返回**旧 cookie**（缓存绝不清空），
   * 连旧值都没有才返回 null。
   */
  onUpstreamUnauthorized?: () =>
    | Record<string, string>
    | null
    | Promise<Record<string, string> | null>
}

export interface RemoteServiceOptions {
  /** 覆盖 `~`（测试隔离）。 */
  homeDir?: string
  /** DSH 的 connection 服务（取上游身份的唯一来源）；缺 `authenticatedUrl` 时远程访问 fail-closed。 */
  connection?: { authenticatedUrl?(baseUrl: string): string }
  /** DSH 的 webServer（读 `port`/`protocol`）。 */
  webServer?: { port?: number; protocol?: string }
  /** 注入的起监听函数（默认由 `index.ts` 传 `listener.startRemoteListener`）。 */
  startListener?: (options: RemoteListenerStartOptions) => Promise<RemoteListenerHandle>
  /** 注入的令牌门工厂（`index.ts` 用 `auth.ts` 适配）。 */
  createGate?: (deps: { token: () => string | null; sessionCookieName: string }) => RemoteGate
  /** 注入的二维码编码（`qr.ts` 的 `encodeQr`）。 */
  encodeQr?: (text: string) => { size: number; modules: boolean[][] }
  /** 注入的自检（`probe.ts` 的 `runProbe`）。 */
  runProbe?: (mode: RemoteAccessMode, settings: RemoteSettings, deps: { dshPort: number | null; listenerAddress: string | null }) => Promise<RemoteProbeResult>
  /** 注入的「生成新令牌」（默认用 node:crypto，测试可覆盖）。 */
  generateToken?: () => string
  /** 会话 cookie 名（默认 `dsh-remote-session`；与 `auth.ts` 的规范名保持一致由 index.ts 传）。 */
  sessionCookieName?: string
  /** 入站连接审计钩子（装配层传入，只交 IP + 时刻）。 */
  onConnect?: (info: { at: string; remoteAddress: string }) => void
  /** 上游身份后台刷新间隔（毫秒，默认 6 小时）。 */
  upstreamRefreshMs?: number
  now?: () => Date
  /** 上游身份换取超时（毫秒，默认 3000）。 */
  upstreamTimeoutMs?: number
  /**
   * 上游首字节预算（毫秒，默认交给 listener 的 15000）。只影响"上游多久还没回响应头"，
   * 不限制响应正文；上游挂死时反代回 504 typed `E_UPSTREAM_TIMEOUT`，连不上回 502
   * typed `E_UPSTREAM_DOWN`（见 `listener.ts`）。测试注入小值用。
   */
  upstreamFirstByteTimeoutMs?: number
  /** 上游连接预算（毫秒，默认交给 listener 的 5000）。 */
  upstreamConnectTimeoutMs?: number
  /** 上游空闲预算（毫秒，默认交给 listener 的 120000）。 */
  upstreamIdleTimeoutMs?: number
  /** 并发实时隧道上限（默认交给 listener 的 16）。 */
  upstreamMaxTunnels?: number
  /**
   * 默认路由探测（**测试注入**）。默认实现 `probeRouteAddress('IPv4')`：UDP `connect` 只查路由、
   * 不发包、有界（≤200 ms）；返回 null = 无默认路由 / 探测失败（此时走候选规则兜底）。
   * 注入函数可以是同步的，也可以是 `Promise`（服务内部统一 await，绝不会挂住事件循环）。
   */
  routeProbeAddress?: () => string | null | Promise<string | null>
  /**
   * 网卡表注入（**测试**用假网卡，不依赖本机 NIC）。默认 `listLanCandidates()`
   * （`os.networkInterfaces()` + 名字启发式）。抛出时按"没有候选"处理，绝不冒泡。
   */
  interfaces?: () => LanCandidate[]
  /**
   * provisioning 自动镜像值（**测试注入**）。默认 `provisionedMirrorLanAddress()`：
   * 用来判断磁盘上的 `lanAddress` 是不是"自动写进去的"，而不是运维手填的。
   */
  provisionedLanAddress?: () => string | null
}

export const REMOTE_SESSION_COOKIE = 'dsh-remote-session'

const DEFAULT_PORT_CANDIDATE = 0

interface RuntimeState {
  handle: RemoteListenerHandle | null
  startedAt: string | null
  lastError: { code: string; message: string } | null
  probe: RemoteProbeResult | null
  rejected: number
  /**
   * 这次监听是谁拉起来的（mod-plugin-remote-autostart）：激活时自动恢复 = `'auto'`，
   * 用户点「开始接受连接」= `'manual'`。与 `handle` 同生同灭，绝不单独落盘。
   */
  startedBy: 'auto' | 'manual' | null
}

/** 一次已解析的上游身份。`cookie` 是 `name=value` 形态，只在内存里。 */
interface UpstreamIdentity {
  cookie: string
  expiresAt: number
}

function safeMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** 原始 JSON 记录 → 普通对象；数组 / 标量 / null 一律 `null`（与 store / accessMode 同一判据）。 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/**
 * 展示用脱敏：把 URL 里 token 类参数的值换成 `***`。
 *
 * `manualUrl` 是用户手填的完整地址，可能自带 token；`status.urls` 会被设置页渲染进 DOM，
 * 所以入口处就抹掉（评审 M3）。执行/打开仍用原始值（`showLink` 是唯一明文出口）。
 */
export function redactUrlForDisplay(raw: string): string {
  try {
    const url = new URL(raw)
    for (const key of Array.from(url.searchParams.keys())) {
      if (/^(token|k|access_token|secret|password|pwd|ticket)$/i.test(key)) url.searchParams.set(key, '***')
    }
    return url.toString()
  } catch {
    return ''
  }
}

/**
 * 设置 → 对外视图：把 `token` 明文抽成"是否存在 + 打码"。
 *
 * `remoteGetState` / `remoteSaveSettings` 的响应都会被设置页渲染进 DOM 并可能被日志记录，
 * 所以出口处只留 `tokenSet` / `tokenMasked`；明文唯一的出口是 `showLink()`。
 */
export function toSettingsView(settings: RemoteSettings): RemoteSettingsView {
  const { token, autoStart, ...rest } = settings
  return {
    ...rest,
    tokenSet: token !== '',
    tokenMasked: token === '' ? '' : maskToken(token),
    // 视图里恒为布尔：缺键（旧 remote.json）与坏值都读作 false。
    autoStart: autoStart === true,
  }
}

/* ------------------------------------------------------------------ 局域网选路 */
/**
 * 虚拟网卡识别（**次级**启发式）。主判据是**默认路由地址**，见 `resolveLanSelection`。
 *
 * 为什么主判据是路由而不是名字：虚拟网卡（Hyper-V / Wi-Fi Direct / VMware / 容器桥）几乎
 * 永远不会持有默认路由，所以"内核说默认路由走哪个源地址"本身就足以把这类网卡排到最后；
 * 名字只是第二道保险，覆盖路由判断不了的两件事：① 本机根本没有默认路由；② 需要把
 * "不是路由地址"这件事在状态行里标出来。
 *
 * 真实伤疤（本模块的成因）：中文版 Windows 上 Hyper-V / Wi-Fi Direct 的虚拟适配器名字是
 * `本地连接* 16`，而旧正则只认 `vEthernet` 这类英文名，`VIRTUAL_IFACE_RE.test(name)` 判不出来
 * → 虚拟网卡被当成真网卡 → 按枚举顺序取第一个私网地址 → 广播了 `192.168.137.1`，
 * 而平板在 `192.168.1.0/24` 上，永远路由不到它（表现为"连接失败超时"）。
 *
 * **这条规则识别不了什么**（如实列出，别指望它兜住）：
 *   · 被人手工改名成 `WLAN 3` 这种正常名字的虚拟网卡（名字里一点线索都没有）；
 *   · 没有默认路由时，一台机器上"真实但与默认路由无关"的第二块物理网卡；
 *   · 能绑上却根本不可达的地址（例如手工配的 Wi-Fi Direct 网段）：名字不带线索、绑定也会成功，
 *     只能靠"它不是默认路由地址"这一点由状态行如实标注（`LanSelection.reason`）。
 *
 * 为什么**不**去调 `Get-NetAdapter` / `netsh` 拿平台元数据：那要 spawn 子进程（几百毫秒、
 * 可能被安全软件拦、可能被策略禁、输出还随系统语言变化），而 `service.ts` 位于插件启动与
 * 每次状态刷新路径上，任何一次阻塞都会连累配置同步；失败时也只能 fail-open 回退到同一套
 * 名字启发式。收益（极少数被改名的虚拟网卡）远小于"启动路径上多一个可变阻塞点"的代价。
 */
const VIRTUAL_IFACE_RE =
  /(vEthernet|VMware|VirtualBox|Hyper-V|VMnet|Loopback|Teredo|isatap|docker|veth|br-|WSL|Tailscale|ZeroTier|OpenVPN|WireGuard|Npcap|虚拟|环回|隧道)/i
/**
 * 中文版 Windows 的 Wi-Fi Direct 虚拟适配器名形如 `本地连接* 16` / `本地连接* 1`。
 * 注意**必须带 `*`**：不带 `*` 的「本地连接」是老系统上物理以太网的正常名字，不能误伤。
 */
const LOCAL_CONNECTION_VIRTUAL_RE = /^本地连接\s*\*/
/** RFC1918 IPv4 私网：候选规则里排在最前（与旧行为一致）。 */
const RFC1918_RE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/
/** 链路本地 IPv6（fe80::/10）：换网就失效，不能广播。 */
const IPV6_LINK_LOCAL_RE = /^fe80:/i
/** Teredo（2001:0::/32）与 6to4（2002::/16）：隧道地址，不是本机可直连地址。 */
const IPV6_TUNNEL_RE = /^(2001:0:|2002:|2001:0000:)/i

/** 网卡名 → 是否虚拟网卡（纯名字启发式；不认识的名字一律当真实网卡，不猜）。 */
export function isVirtualIfaceName(name: unknown): boolean {
  const text = typeof name === 'string' ? name.trim() : ''
  if (text === '') return false
  return VIRTUAL_IFACE_RE.test(text) || LOCAL_CONNECTION_VIRTUAL_RE.test(text)
}

/**
 * 网卡枚举（跳过 `internal`）。`table` 只为测试注入：生产一律 `os.networkInterfaces()`。
 * 枚举失败返回空数组（绝不抛），调用方按"没有候选"处理。
 */
export function listLanCandidates(table?: NodeJS.Dict<os.NetworkInterfaceInfo[]>): LanCandidate[] {
  const out: LanCandidate[] = []
  let source: NodeJS.Dict<os.NetworkInterfaceInfo[]>
  try {
    source = table ?? os.networkInterfaces()
  } catch {
    return out
  }
  for (const [name, infos] of Object.entries(source)) {
    if (infos === undefined) continue
    for (const info of infos) {
      if (info.internal) continue
      const family = info.family === 'IPv4' ? 'IPv4' : 'IPv6'
      out.push({ address: info.address, iface: name, family, virtual: isVirtualIfaceName(name) })
    }
  }
  return out
}

/** 路由探测预算（毫秒）：整个探测不超过它；超时一律当作"没有默认路由"。 */
export const ROUTE_PROBE_TIMEOUT_MS = 200
/** 轮询步长（毫秒）：隐式 bind 完成前 `address()` 会抛 EBADF，只能小步等待。 */
const ROUTE_PROBE_POLL_MS = 5
/**
 * 路由地址缓存时长（毫秒）。为什么需要缓存：探测是异步的，而 `status()` 是同步的；
 * 5 s 足够覆盖"一次用户动作里连出好几个状态"（start 内部会多次取状态），
 * 又短到换网后下一次动作就能拿到新地址。
 */
const ROUTE_CACHE_TTL_MS = 5000
/**
 * 探测目标：公共字面量，只用来让内核查路由表选源地址。
 * **不发任何包**：UDP `connect()` 只做本地路由查找与隐式绑定，不会产生报文。
 */
const ROUTE_PROBE_TARGET_V4 = '223.5.5.5'
const ROUTE_PROBE_TARGET_V6 = '2400:3200::1'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** 探测回来的源地址是否可用（通配 / 回环都不算"路由选出的本机地址"）。 */
function usableRouteSource(address: string): boolean {
  if (address === '' || address === '0.0.0.0' || address === '::' || address === '::1') return false
  if (/^127\./.test(address)) return false
  return true
}

/**
 * 问操作系统："去默认路由，你会用本机哪个地址？"——依赖为零、不发包、有界。
 *
 * 做法：`dgram.createSocket('udp4')` → `connect(53, <公共字面量>)` → `address().address` → `close()`。
 * UDP 的 `connect` 不握手、不发包，只让内核按路由表选定本地源地址，正是我们要的"路由权威"。
 *
 * **为什么是异步的（实测教训）**：`connect()` 触发的隐式 bind 在 libuv 里是**异步**的，
 * Windows 上紧接着调 `address()` 会抛 `EBADF`；必须小步等到绑定完成，`getsockname` 才给
 * 路由选出的源地址（本机实测：5 ms 内返回 `192.168.1.5`，而 IPv6 返回链路外的全局地址）。
 * 若绑定完成后拿到的仍是 `0.0.0.0`（内核没按路由选源），一律当作探测失败。
 *
 * 三种失败都返回 null（绝不抛、绝不阻塞事件循环、总时长 ≤ 预算）：
 *   · 没有默认路由 → 内核回 ENETUNREACH/ECONNREFUSED（已挂 `error` 监听，避免未捕获异常）；
 *   · 该地址族不可用 / 创建 socket 失败；
 *   · 探测回来的地址是通配或回环。
 */
export async function probeRouteAddress(
  family: 'IPv4' | 'IPv6' = 'IPv4',
  options: { timeoutMs?: number; target?: string } = {},
): Promise<string | null> {
  const budget =
    typeof options.timeoutMs === 'number' && options.timeoutMs > 0 ? options.timeoutMs : ROUTE_PROBE_TIMEOUT_MS
  const target = typeof options.target === 'string' && options.target !== ''
    ? options.target
    : family === 'IPv6' ? ROUTE_PROBE_TARGET_V6 : ROUTE_PROBE_TARGET_V4
  const deadline = Date.now() + budget
  let socket: dgram.Socket
  try {
    socket = dgram.createSocket(family === 'IPv6' ? 'udp6' : 'udp4')
  } catch {
    return null
  }
  let failed = false
  const onError = (): void => {
    failed = true
  }
  socket.on('error', onError)
  try {
    socket.connect(53, target)
  } catch {
    socket.removeListener('error', onError)
    try {
      socket.close()
    } catch {
      /* 未绑定：忽略 */
    }
    return null
  }
  try {
    while (Date.now() < deadline) {
      if (failed) return null
      try {
        const local = socket.address()
        const raw = typeof local.address === 'string' ? local.address.trim() : ''
        // link-local 的 `%zone` 后缀对 URL 无意义，去掉再判。
        const address = raw.split('%')[0] ?? ''
        return usableRouteSource(address) ? address : null
      } catch {
        // 还没绑完（EBADF）：等一小步再看。
        await sleep(ROUTE_PROBE_POLL_MS)
      }
    }
    return null
  } finally {
    socket.removeListener('error', onError)
    try {
      socket.close()
    } catch {
      /* 已关闭：忽略 */
    }
  }
}

/** 一个候选的排查视图（候选表 + 为什么被排除）；`LanCandidate` 本身不动（对外契约保持）。 */
export interface LanCandidateReport extends LanCandidate {
  /** 该地址就是默认路由所在地址。 */
  route: boolean
  /** 被排除的中文原因（空串 = 可选）。 */
  rejected: string
}

/** 一次局域网选路的**完整结论**：一个地址 + 一行中文原因 + 排查用的候选表。 */
export interface LanSelection {
  /** 最终要绑定并广播的地址；null = 没有可用地址（typed 失败，绝不回落 0.0.0.0）。 */
  address: string | null
  /** 来源：override（设置里手填）/ route（默认路由）/ fallback（候选规则）/ none（无可用）。 */
  source: 'override' | 'route' | 'fallback' | 'none'
  /** 一行中文原因：广播哪个地址、为什么、跳过了什么。状态行直接展示。 */
  reason: string
  /**
   * 原因短语（不含「广播 <地址>」前缀）：给"设置选中的地址 ≠ 监听句柄实际绑定的地址"
   * 那种不一致场景复用，避免同一行里出现两个自相矛盾的「广播 X」。
   */
  explain: string
  /** 路由探测到的本机地址（null = 无默认路由或探测失败）。 */
  routeAddress: string | null
  /** 候选表（含路由标记与被排除原因）：干跑脚本与排查用。 */
  candidates: LanCandidateReport[]
}

export interface LanSelectionInput {
  candidates: LanCandidate[]
  /** 默认路由探测结果（null/省略 = 无默认路由或探测失败）。 */
  routeAddress?: string | null
  /** 设置里的「局域网地址」= 运维**显式覆盖**；空串/省略 = 自动选路。 */
  override?: string
  /**
   * 这个覆盖值是否可信（默认 `true`）。
   *
   * `false` 只用于一种情形：`lanAddress` 与 **provisioning 自动镜像写入**的值逐字节相同，
   * 因而无法证明是运维手填的（见 `provisionedMirrorLanAddress` 的注释）。此时把它当"自动值"，
   * 让默认路由地址优先；原因行会明说"已忽略落盘的 X"。绝不静默忽略。
   */
  overrideTrusted?: boolean
}

/** 单个候选的排除原因（纯函数）。IPv4 用监听同一套 `isBindableLanAddress`，保证"选中即可绑"。 */
function rejectionOf(item: LanCandidate): string {
  if (item.family === 'IPv4') {
    if (!isBindableLanAddress(item.address)) {
      if (/^169\.254\./.test(item.address)) return 'APIPA 链路本地'
      if (/^127\./.test(item.address)) return '回环地址'
      if (/^0\./.test(item.address)) return '通配地址'
      return '不是可绑定的单播 IPv4'
    }
    return item.virtual === true ? '虚拟网卡' : ''
  }
  if (IPV6_LINK_LOCAL_RE.test(item.address)) return '链路本地 IPv6'
  if (IPV6_TUNNEL_RE.test(item.address)) return 'Teredo/6to4 隧道'
  if (!isBindableIpv6Address(item.address)) return '不是可绑定的全局 IPv6'
  return item.virtual === true ? '虚拟网卡' : ''
}

/** 被跳过候选的**计数摘要**（同因合并，保持一行短句）。 */
function summarizeRejected(items: LanCandidateReport[]): string {
  if (items.length === 0) return ''
  const counts = new Map<string, number>()
  for (const item of items) counts.set(item.rejected, (counts.get(item.rejected) ?? 0) + 1)
  const parts: string[] = []
  for (const [why, count] of counts) parts.push(count > 1 ? `${why} ${String(count)}` : why)
  return `；已跳过 ${String(items.length)} 个候选（${parts.join('、')}）`
}

/**
 * 纯函数：**唯一**的局域网选路规则。优先级（高 → 低）：
 *
 *   1. **显式覆盖**：设置里的 `lanAddress` 非空且可绑定 → 用它并说明"这是你手填的"。
 *      这是运维唯一的逃生舱（例如机器多网卡、要固定绑第二块网卡）。
 *      若它与默认路由地址不一致，就在原因行里**明说**平板可能连不上，并给出清空办法。
 *   2. **默认路由地址**：探测到且确实在本机网卡表里 → 用它（这是本模块的核心修复：
 *      先问路由，不按枚举顺序猜）。
 *   3. **候选规则兜底**（没有默认路由 / 探测失败）：排除回环、APIPA `169.254/16`、
 *      链路本地 IPv6 `fe80::/10`、Teredo/6to4 隧道、虚拟网卡；私网 RFC1918 优先。
 *   4. **没有可用地址** → `address:null` + 明确中文原因（**绝不**回落 `0.0.0.0`，
 *      也绝不广播一个已知不可达的地址）。
 *
 * 局域网方式只选 IPv4：绑到 IPv6 会被 `transportOfBoundAddress` 判成 `ipv6` 传输，
 * 与 `mode:lan` 的载荷语义冲突（配对会 typed 拒绝），所以这里不跨族兜底。
 */
export function resolveLanSelection(input: LanSelectionInput): LanSelection {
  const rawRoute = typeof input.routeAddress === 'string' ? input.routeAddress.trim() : ''
  const routeAddress = rawRoute === '' ? null : rawRoute
  const candidates: LanCandidateReport[] = (Array.isArray(input.candidates) ? input.candidates : []).map((item) => ({
    address: item.address,
    iface: item.iface,
    family: item.family,
    virtual: item.virtual === true,
    route: routeAddress !== null && item.address === routeAddress,
    rejected: rejectionOf(item),
  }))
  const skipped = candidates.filter((item) => item.rejected !== '')
  const skipTail = summarizeRejected(skipped)
  const override = typeof input.override === 'string' ? input.override.trim() : ''
  /** overrideTrusted=false ⇒ 这个值是 provisioning 自动镜像写入的，不能当运维覆盖。 */
  const overrideTrusted = input.overrideTrusted !== false
  const mirrorTail = !overrideTrusted && override !== ''
    ? `；已忽略落盘的 ${override}（与自动挑选结果相同，按自动值处理）`
    : ''

  if (override !== '' && overrideTrusted) {
    if (!isBindableLanAddress(override)) {
      const explain = '「局域网地址」不是可绑定的具体私网 IPv4（不能是 0.0.0.0 / 127.x / 169.254.x）；请改成电脑网卡上的地址'
      return { address: null, source: 'none', reason: explain, explain, routeAddress, candidates }
    }
    if (routeAddress === override) {
      const explain = `你手填的局域网地址，与默认路由一致${skipTail}`
      return { address: override, source: 'override', reason: `广播 ${override}（${explain}）`, explain, routeAddress, candidates }
    }
    if (routeAddress !== null) {
      const explain =
        `你手填的局域网地址；本机默认路由是 ${routeAddress}，平板多半连不上它，` +
        '清空「局域网地址」就会自动改用路由地址'
      return { address: override, source: 'override', reason: `广播 ${override}（${explain}）`, explain, routeAddress, candidates }
    }
    const explain = `你手填的局域网地址；没探测到默认路由，无法印证平板是否可达${skipTail}`
    return { address: override, source: 'override', reason: `广播 ${override}（${explain}）`, explain, routeAddress, candidates }
  }

  if (routeAddress !== null && candidates.some((item) => item.address === routeAddress && item.family === 'IPv4')) {
    const explain = `本机默认路由所在地址${skipTail}${mirrorTail}`
    return { address: routeAddress, source: 'route', reason: `广播 ${routeAddress}（${explain}）`, explain, routeAddress, candidates }
  }

  const usable = candidates.filter((item) => item.family === 'IPv4' && item.rejected === '')
  const preferred = usable.filter((item) => RFC1918_RE.test(item.address))
  const chosen = preferred[0] ?? usable[0]
  if (chosen !== undefined) {
    const why =
      routeAddress === null
        ? '没探测到默认路由，按候选规则选'
        : `默认路由地址 ${routeAddress} 不在本机网卡表里，按候选规则选`
    const explain = `${why}${skipTail}${mirrorTail}`
    return { address: chosen.address, source: 'fallback', reason: `广播 ${chosen.address}（${explain}）`, explain, routeAddress, candidates }
  }

  const detail = skipped.length === 0 ? '本机没有非回环网卡' : `只找到 ${String(skipped.length)} 个不可用候选`
  const explain = `没找到可用的局域网 IPv4：${detail}${skipTail}${mirrorTail}；请先连上 Wi-Fi，或在设置里手动填「局域网地址」`
  return { address: null, source: 'none', reason: explain, explain, routeAddress, candidates }
}

/**
 * 兼容旧调用点：只看候选表（不探测路由）时的挑选结果。
 * 语义与 `resolveLanSelection({ candidates })` 完全一致，避免出现第二套规则。
 */
export function pickLanAddress(candidates: LanCandidate[]): string | null {
  return resolveLanSelection({ candidates }).address
}

/**
 * 与 `createRemoteService().lanSelectionFor` **同一条规则**的可复用入口（干跑/排查用）。
 *
 * 存在的唯一理由：不允许出现"服务里一套、脚本里另一套"的判断 —— 尤其是
 * "落盘值是不是 provisioning 自动镜像"这条最容易两边写成不同结论的规则。
 */
export function resolveLanSelectionForSettings(input: {
  candidates: LanCandidate[]
  routeAddress: string | null
  lanAddress: string
  /** 本进程里被 `saveSettings` 显式保存过 ⇒ 无条件当覆盖。 */
  explicitSave?: boolean
  /** provisioning 自动镜像值（省略则现算）。 */
  provisionedAddress?: string | null
}): LanSelection {
  const override = typeof input.lanAddress === 'string' ? input.lanAddress.trim() : ''
  let auto: string | null = null
  if (input.provisionedAddress !== undefined) {
    auto = input.provisionedAddress
  } else {
    try {
      auto = provisionedMirrorLanAddress()
    } catch {
      auto = null
    }
  }
  const trusted =
    input.explicitSave === true || override === '' || auto === null || auto === undefined || auto.trim() !== override
  return resolveLanSelection({ candidates: input.candidates, routeAddress: input.routeAddress, override, overrideTrusted: trusted })
}

/**
 * provisioning 落盘时用的**旧启发式**（冻结在此，故意不随本文件的新规则演进）。
 *
 * 为什么需要它：`pairingProvision.persistEndpoint()` 会把自动挑选结果**镜像**写进
 * `remote.json` 的 `lanAddress`，所以磁盘上的值天然分不清"运维手填"与"自动镜像"。
 * 本机就是这样把 `192.168.137.1`（`本地连接* 16`）写进设置、又按"显式覆盖"绑了上去。
 *
 * 这份实现逐字对齐当时的规则（名字正则 + 枚举顺序取第一个**非虚拟** RFC1918），
 * 用途只有一个：回答"这个落盘值是不是当初那条自动写进去的？"。
 * **不能**跟着新规则一起改：provisioning 将来若改成路由选路，历史镜像值就不会再等于
 * 新规则的输出，那时把旧值误判成"手填"会重新引入本模块要修的缺陷。
 */
const PROVISIONED_VIRTUAL_RE = /(vEthernet|VMware|VirtualBox|Hyper-V|Loopback|Teredo|isatap|docker|veth|br-|WSL|Tailscale)/i

export function provisionedMirrorLanAddress(table?: NodeJS.Dict<os.NetworkInterfaceInfo[]>): string | null {
  let source: NodeJS.Dict<os.NetworkInterfaceInfo[]>
  try {
    source = table ?? os.networkInterfaces()
  } catch {
    return null
  }
  for (const [name, infos] of Object.entries(source)) {
    if (infos === undefined) continue
    for (const info of infos) {
      if (info.internal) continue
      if (info.family !== 'IPv4') continue
      if (PROVISIONED_VIRTUAL_RE.test(name)) continue
      if (!RFC1918_RE.test(info.address)) continue
      return info.address
    }
  }
  return null
}

function isIPv4(value: string): boolean {
  const parts = value.split('.')
  if (parts.length !== 4) return false
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

export function createRemoteService(options: RemoteServiceOptions = {}): RemoteServiceLike & { paths: { configFile: string; tokenFile: string } } {
  const now = options.now ?? ((): Date => new Date())
  const sessionCookieName = options.sessionCookieName ?? REMOTE_SESSION_COOKIE
  const store = new RemoteStore({ homeDir: options.homeDir })
  const runtime: RuntimeState = { handle: null, startedAt: null, lastError: null, probe: null, rejected: 0, startedBy: null }
  let upstream: UpstreamIdentity | null = null
  /** 正在进行的换身份 Promise（single-flight）：并发调用共享同一个，绝不并行换两次。 */
  let minting: Promise<UpstreamIdentity | null> | null = null
  let starting = false
  let refreshTimer: ReturnType<typeof setInterval> | null = null
  /**
   * 本进程里**显式保存过**的「局域网地址」取值（没有就是 null）。
   *
   * 为什么需要：磁盘上的 `lanAddress` 既可能是运维手填，也可能是 provisioning 自动镜像
   * （`remote.json` 没有来源标记）。`saveSettings` 是唯一的显式入口，因此"本进程刚被
   * 显式保存过的那个值"可以无条件当成覆盖；从磁盘读到、且恰好等于自动镜像值的，按自动值处理。
   * 只记住**值**而不是布尔量：之后 provisioning 改写成别的地址时，旧值不会再被误当覆盖。
   */
  let explicitLanSave: string | null = null

  /**
   * 本次进程是否已经补写过被外部写入者丢掉的意图位（见 `healClobberedIntent`）。
   * 每个进程最多补一次：失败也别每读一次状态就写一次盘。
   */
  let healedIntent = false

  /** 这个落盘值是否等于本进程显式保存过的那个值。 */
  function isExplicitLanSave(value: string): boolean {
    const trimmed = typeof value === 'string' ? value.trim() : ''
    return explicitLanSave !== null && trimmed !== '' && trimmed === explicitLanSave
  }

  function readSettings(): RemoteSettings {
    const raw = store.readRawSettings()
    const base = defaultRemoteSettings()
    if (raw === null) return base
    try {
      const normalized = normalizeRemoteSettings(raw, base)
      const intent = readIntent(raw)
      healClobberedIntent(raw, { ...normalized, autoStart: intent })
      // mod-plugin-remote-autostart：`autoStart` 是**加法字段**，归一层（accessMode.ts，
      // 本模块不改它）不认这个键，所以每次读都从原始记录里重新挂上；否则任何一次
      // "归一后再写盘"都会把意图抹掉。缺键 → false（旧文件不改变行为）。
      return { ...normalized, autoStart: intent }
    } catch {
      // 手工改坏的文件当作默认值：远程访问起不来，不影响配置同步。
      return base
    }
  }

  /** 从原始 `remote.json` 记录里取意图：只有字面 `true` 才算开（缺键/坏值 → false）。 */
  function readIntent(raw: unknown): boolean {
    const record = asRecord(raw)
    return record !== null && record.autoStart === true
  }

  /**
   * 落盘意图（唯一写入口）。值没变就不写盘：`getState` 这类读路径不该产生写动作。
   *
   * 写盘失败只影响"下次激活能不能自动恢复"，绝不影响本次监听：远程访问已经起来了，
   * 不能因为写配置文件把它拆掉。
   */
  function persistIntent(on: boolean): void {
    try {
      const current = readSettings()
      if ((current.autoStart === true) === on) return
      store.writeSettings({ ...current, autoStart: on })
    } catch {
      /* 写盘失败只影响下一次自动启动 */
    }
  }

  /**
   * 自愈：`remote.json` 里**整个键都不见了**，但此刻确实有句柄在接连接。
   *
   * 为什么会发生：`pairingProvision.persistEndpoint()`（配对面板每次 attach 都会走
   * `provision`）用 `normalizeRemoteSettings(raw, defaultRemoteSettings())` 重建设置再整文件
   * 写回——归一层不认的键会被静默丢掉。也就是说"打开配对面板"这一步就能把意图抹掉，
   * 下一次重启就不再自动恢复。
   *
   * 判据刻意只认「键缺失」而不是「值为 false」：显式 `false` 是用户点了停止的合法结果，
   * 不许被自愈覆盖。每个进程最多补写一次，且只在有句柄时才补——"正在接连接"本身就是
   * 意图为真的证据。
   */
  function healClobberedIntent(raw: unknown, settings: RemoteSettings): void {
    if (healedIntent || runtime.handle === null) return
    const record = asRecord(raw)
    if (record === null) return
    if (Object.prototype.hasOwnProperty.call(record, 'autoStart')) return
    healedIntent = true
    try {
      store.writeSettings({ ...settings, autoStart: true })
    } catch {
      /* 本进程不再重试补写：写盘失败只影响下次激活能否自动恢复，不影响本次监听 */
    }
  }

  function readTokenValue(): string | null {
    const record = store.readToken()
    return record === null ? null : record.token
  }

  const gate: RemoteGate | null =
    options.createGate === undefined
      ? null
      : options.createGate({ token: readTokenValue, sessionCookieName })

  function maskedToken(): string {
    const token = readTokenValue()
    return token === null ? '' : maskToken(token)
  }

  function dshPort(): number | null {
    const port = options.webServer?.port
    return typeof port === 'number' && Number.isInteger(port) && port > 0 ? port : null
  }

  /**
   * 网卡表与默认路由探测的**唯一取值口**（都可注入，且都绝不抛）。
   * 选路、状态行、`detectLan`、URL 拼接全部经这里 —— 一处取值，不允许出现第二份规则。
   */
  function listCandidatesNow(): LanCandidate[] {
    const source = options.interfaces
    if (source === undefined) return listLanCandidates()
    try {
      const injected = source()
      return Array.isArray(injected) ? injected : []
    } catch {
      return []
    }
  }

  /**
   * 路由探测是**异步**的（见 `probeRouteAddress` 的注释），而 `status()` 是同步的：
   * 因此这里保留一份**短期缓存 + single-flight 探测**，异步入口（getState/saveSettings/
   * start/probe/showLink）先 await 一次再出状态，同步出口只读缓存，绝不阻塞。
   */
  let routeCache: { at: number; address: string | null } | null = null
  let routeInflight: Promise<string | null> | null = null

  function probeRouteNow(): Promise<string | null> {
    const injected = options.routeProbeAddress
    if (injected === undefined) return probeRouteAddress('IPv4')
    try {
      return Promise.resolve(injected())
        .then((value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null))
        .catch(() => null)
    } catch {
      return Promise.resolve(null)
    }
  }

  /** 刷新一次（并发调用共享同一次探测 → 一次状态刷新最多一个 UDP socket）。 */
  function refreshRouteAddress(): Promise<string | null> {
    const inflight = routeInflight
    if (inflight !== null) return inflight
    const task = probeRouteNow()
      .catch(() => null)
      .then((address) => {
        routeCache = { at: Date.now(), address }
        routeInflight = null
        return address
      })
    routeInflight = task
    return task
  }

  /** 解析绑定地址前先拿一次路由地址（TTL 内复用缓存，避免每次 RPC 都探测）。 */
  async function routeAddressForResolution(): Promise<string | null> {
    const cached = routeCache
    if (cached !== null && Date.now() - cached.at < ROUTE_CACHE_TTL_MS) return cached.address
    return refreshRouteAddress()
  }

  /** 同步出口读到的路由地址（可能为 null：首次探测还没回来 / 确实没有默认路由）。 */
  function routeAddressCached(): string | null {
    return routeCache === null ? null : routeCache.address
  }

  /** 当前设置下的局域网选路结论（一个地址 + 一行原因 + 候选表）。 */
  function lanSelectionFor(settings: RemoteSettings, routeAddress: string | null): LanSelection {
    return resolveLanSelectionForSettings({
      candidates: listCandidatesNow(),
      routeAddress,
      lanAddress: settings.lanAddress,
      explicitSave: isExplicitLanSave(settings.lanAddress),
      provisionedAddress: provisionedNow(),
    })
  }

  /** provisioning 自动镜像值（可注入；任何时候都不抛）。 */
  function provisionedNow(): string | null {
    const source = options.provisionedLanAddress
    if (source === undefined) return provisionedMirrorLanAddress()
    try {
      const value = source()
      return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
    } catch {
      return null
    }
  }

  /**
   * 当前方式下应当绑定的**具体**地址；返回 null 表示"这种方式不需要/不能起监听"。
   * `routeAddress` 由调用方现取（异步入口 await 过），保证"绑定地址"与"状态行原因"同源。
   */
  function resolveBindAddress(
    mode: RemoteAccessMode,
    settings: RemoteSettings,
    routeAddress: string | null,
  ): { ok: boolean; address: string; reason: string } {
    if (mode === 'lan') {
      // 一条规则：显式覆盖 > 默认路由地址 > 候选规则 > typed 失败（见 `resolveLanSelection`）。
      const selection = lanSelectionFor(settings, routeAddress)
      if (selection.address === null) return { ok: false, address: '', reason: selection.reason }
      return { ok: true, address: selection.address, reason: selection.reason }
    }
    if (mode === 'ipv6') {
      const address = settings.ipv6Address.trim()
      if (address === '') return { ok: false, address: '', reason: '还没填公网 IPv6 地址' }
      if (address.startsWith('[') || address.endsWith(']')) {
        return { ok: false, address: '', reason: 'IPv6 地址不要带方括号' }
      }
      if (!address.includes(':')) return { ok: false, address: '', reason: '这不是 IPv6 地址' }
      return { ok: true, address, reason: '' }
    }
    if (mode === 'tailscale') {
      const host = settings.tailscaleHost.trim()
      if (host === '') {
        const tailnet = listLanCandidates().find((item) => item.family === 'IPv4' && /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(item.address))
        if (tailnet === undefined) return { ok: false, address: '', reason: '没找到 Tailscale 地址（100.64/10），请先登录 Tailscale 或手动填地址' }
        return { ok: true, address: tailnet.address, reason: '' }
      }
      if (!isIPv4(host)) {
        return { ok: false, address: '', reason: 'Tailscale 方式请填 100.x 地址（MagicDNS 名称无法用来绑定监听）' }
      }
      return { ok: true, address: host, reason: '' }
    }
    if (mode === 'cloudflare') {
      // 隧道客户端与 DSH 同机运行：用**局域网地址**做回源。
      // 为什么不用 127.0.0.1：listener 的门禁要求绑定具体局域网单播地址（拒绝回环，
      // 回环会与 DSH 自己的监听撞车）；绑局域网地址同样只在本机可达范围内，且令牌门仍在前面。
      const selection = lanSelectionFor(settings, routeAddress)
      if (selection.address === null) {
        return { ok: false, address: '', reason: `${selection.reason}（隧道客户端无法回源）` }
      }
      return { ok: true, address: selection.address, reason: selection.reason }
    }
    return { ok: false, address: '', reason: '这种方式不需要本机监听' }
  }

  /**
   * 用 `connection.authenticatedUrl()` 换一次上游 DSH 的浏览器会话 cookie。
   *
   * 这不是"绕过鉴权"：`authenticatedUrl` 是 DSH 自己给的**本进程 owner 令牌**，
   * 我们只是替远端客户端完成一次本地登录，并把 cookie 留在服务端。
   * 拿不到就返回 null → routes 层回 503（fail-closed）。
   */
  async function refreshUpstreamIdentity(): Promise<UpstreamIdentity | null> {
    const port = dshPort()
    const auth = options.connection
    if (port === null || auth === undefined || typeof auth.authenticatedUrl !== 'function') return null
    let authenticated: string
    try {
      authenticated = auth.authenticatedUrl(`http://127.0.0.1:${String(port)}/`)
    } catch {
      return null
    }
    const timeout = options.upstreamTimeoutMs ?? 3000
    try {
      const response = await fetch(authenticated, { redirect: 'manual', signal: AbortSignal.timeout(timeout) })
      const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
      const session = cookies.map((item) => item.split(';')[0] ?? '').find((item) => item.startsWith('dsh-auth-'))
      if (session === undefined || session === '') return null
      // 上游 cookie 的 Max-Age 是 30 天；保守按 12 小时刷新一次，避免整天 401。
      return { cookie: session, expiresAt: now().getTime() + 12 * 60 * 60 * 1000 }
    } catch {
      return null
    }
  }

  /**
   * **换一次身份的唯一入口（single-flight）**：同一时刻最多只有一个在飞的 `fetch`；
   * 并发的调用方（两个同时撞上 401 的请求、门禁自愈与 6 小时定时器撞车）**共享同一个
   * Promise**，因此上游只会被访问一次。
   *
   * 缓存纪律：**成功才替换槽位**。失败时 `upstream` 保持原值 —— 旧 cookie 可能仍然可用，
   * 而且清空槽位会让门禁对**所有**请求回 503 `E_UPSTREAM_IDENTITY`（旧实现正是这样把一次
   * 瞬时失败放大成"最长 6 小时远程访问不可用"）。失败只返回 `null`，由调用方决定应对。
   */
  function mintOnce(): Promise<UpstreamIdentity | null> {
    const inflight = minting
    if (inflight !== null) return inflight
    const attempt = (async (): Promise<UpstreamIdentity | null> => {
      try {
        return await refreshUpstreamIdentity()
      } catch {
        return null
      }
    })()
    const tracked = attempt.then((fresh) => {
      if (fresh !== null) upstream = fresh
      minting = null
      return fresh
    })
    minting = tracked
    return tracked
  }

  /**
   * 门禁发现缓存空/过期时的**自愈**：立刻在后台补一次身份。
   *
   * fire-and-forget（调用方是同步门禁回调，不能等）、single-flight（`mintOnce` 自带，
   * 已在飞就不再开第二个）、错误一律吞掉（自愈失败最多让本次请求照旧 503，不许冒到
   * 请求路径上）。这样**下一个**请求就有身份，不必等 6 小时定时器或重启进程。
   */
  function kickIdentityRefresh(): void {
    if (minting !== null) return
    void mintOnce().catch(() => {
      /* 自愈失败不改变本次请求的结论：本次仍按"没有身份"回 503（fail-closed） */
    })
  }

  /**
   * 取一个可用的上游会话 cookie（异步版：缓存过期时现换一次）。
   *
   * 换失败**不清缓存**：旧值还留在槽里，本次返回旧 cookie，让请求还能再试一次
   * （旧值真失效时，上游会再回 401，由 listener 侧 typed 化成 `E_UPSTREAM_SESSION`）。
   */
  async function upstreamCookie(): Promise<string | null> {
    const current = upstream
    if (current !== null && current.expiresAt > now().getTime()) return current.cookie
    const fresh = await mintOnce()
    if (fresh !== null) return fresh.cookie
    const previous = upstream
    return previous === null ? null : previous.cookie
  }

  /**
   * 上游回 401 时由 listener 回调（U1）：**重新换一次身份**（single-flight）。
   *
   * 只换一次（"重试恰好一次"由 listener 侧限制）；换不到时**不碰缓存**，把旧 cookie
   * 交回去让本次重试还能走一次（再 401 就由 listener 收口成中文错误页 / typed JSON，
   * 绝不把上游的英文 401 正文丢给平板）。只有确实没有任何旧值时才返回 null。
   * 身份来源与平时完全一致：`connection.authenticatedUrl()`（见 `refreshUpstreamIdentity`）。
   *
   * 内存纪律（S5）：这里只有**一个** `upstream` 槽位（覆盖式赋值），没有按请求增长的
   * map/list；TTL 到期或 401 都只会替换这一份。
   */
  async function refreshUpstreamAfter401(): Promise<Record<string, string> | null> {
    const fresh = await mintOnce()
    if (fresh !== null) return { cookie: fresh.cookie }
    const previous = upstream
    return previous === null ? null : { cookie: previous.cookie }
  }

  /**
   * 运行中的**广播地址**：唯一来源是监听句柄的 `address`（`server.address()` 的真值）。
   *
   * 为什么不在运行时重新挑一次：`start()` 与 `status()`/`showLink()` 是两个时刻，
   * 机器可能已经换网（Wi-Fi 切到有线、VPN 起来），重新挑会得到**另一个**地址，
   * 于是"绑的是 A、二维码里是 B"——平板照样连不上。绑什么就广播什么。
   */
  function advertisedLanAddress(handle: RemoteListenerHandle | null, selection: LanSelection): string | null {
    return handle !== null ? handle.address : selection.address
  }

  /** 把面板要显示的一行中文原因：广播哪个地址、为什么、跳过了什么。 */
  function lanNote(selection: LanSelection, handle: RemoteListenerHandle | null): string {
    if (handle === null) return selection.reason
    if (selection.address === handle.address) return `${selection.reason}；已按该地址绑定并广播`
    // 只在"设置选出来的地址"与"句柄真实绑定地址"不一致时出现：以句柄为准，并说清设置那边选了什么。
    const expected = selection.address === null ? '（当前设置选不出可用地址）' : selection.address
    return `实际绑定并广播的是 ${handle.address}（以监听句柄为准）；设置那边选出的是 ${expected}：${selection.explain}`
  }

  function status(): RemoteStatus {
    const settings = readSettings()
    const tokenRecord = store.readToken()
    const handle = runtime.handle
    const stats = handle === null ? { active: 0, total: 0, rejected: 0 } : handle.stats()
    const token = readTokenValue()
    const urls = []
    // 只有 lan 需要"挑地址"；其余方式的地址来自设置里的具体字段（隧道域名 / v6 字面量 …）。
    const selection = settings.mode === 'lan' ? lanSelectionFor(settings, routeAddressCached()) : null
    const lanAddress = selection === null ? null : advertisedLanAddress(handle, selection)
    // 运行中：URL 的 host 必须是被绑定的那个地址（覆盖 settings.lanAddress 里可能过期的值）。
    const urlSettings = handle !== null && settings.mode === 'lan' ? { ...settings, lanAddress: handle.address } : settings
    const built = urlForMode(settings.mode, urlSettings, { lanAddress, dshPort: dshPort() ?? 0 })
    if (built.ok) {
      urls.push({
        mode: settings.mode,
        url: redactUrlForDisplay(built.url),
        label: labelOfMode(settings.mode),
        note: selection === null ? '' : lanNote(selection, handle),
        withToken: false,
      })
    }
    return {
      running: handle !== null,
      listen: handle === null ? null : `${handle.address}:${String(handle.port)}`,
      boundAddress: handle === null ? null : handle.address,
      port: handle === null ? (settings.port > 0 ? settings.port : dshPort() ?? 0) : handle.port,
      startedAt: runtime.startedAt,
      startedBy: handle === null ? null : runtime.startedBy,
      lastError: runtime.lastError,
      connections: { active: stats.active, total: stats.total },
      rejected: runtime.rejected + stats.rejected,
      token: { exists: token !== null, masked: token === null ? '' : maskToken(token), createdAt: tokenRecord?.createdAt ?? null },
      urls,
      probe: runtime.probe,
      // 只有真的起了监听才说"已加密"；未运行/启动失败一律 false（不冒充加密）。
      tls: handle !== null,
    }
  }

  function labelOfMode(mode: RemoteAccessMode): string {
    const spec = listModes().find((item) => item.mode === mode)
    return spec === undefined ? mode : spec.label
  }

  const authorizer =
    gate === null
      ? null
      : createRemoteAuthorizer({
          gate,
          mode: () => readSettings().mode,
          // 上游会话可能已过期：过期就当"没有身份"，让 routes 回 503（fail-closed），
          // 而不是把过期 cookie 直送上游、让客户端收到一个看不懂的 401（评审 M2）。
          // 同时**自愈**：缓存空/过期就在后台补一次（fire-and-forget、single-flight、吞错），
          // 下一个请求就有身份 —— 不必等 6 小时定时器或重启进程。
          upstreamCookie: () => {
            const current = upstream
            if (current !== null && current.expiresAt > now().getTime()) return current.cookie
            kickIdentityRefresh()
            return null
          },
          sessionCookieName,
        })

  /**
   * 把 `remote.json` 里的 `enabled` 与**监听句柄的真实状态**对齐（单一事实来源 = `runtime.handle`）。
   *
   * 为什么需要它（Lead 的活体证据，21:16）：`remote.json` 写着 `enabled=false`，而
   * `Get-NetTCPConnection -State Listen` 明明是 `192.168.137.1:44996`。旧实现里
   * `remoteStart` 从不写这个位，于是文件读起来像"没有在接连接"，与事实相反 —— 同一类"报告说谎"。
   *
   * 语义（**mod-plugin-remote-autostart 之后**）：`enabled` 是**句柄回声**（"上一次是开着的"），
   * 不再是自动启动意图位 —— 意图搬到了 `autoStart`（见 `persistIntent`），挂载路径只读意图。
   * 因此它不会再和刚发生的用户动作相矛盾，也不再被任何启动路径当成"要不要自动起监听"的证据。
   * 真正"此刻在接连接"的事实仍然是 `status().running` / `status().listen` / `status().boundAddress`
   * 与 `settings.accepting`（mod-plugin-remote-accepting-surface）。
   * 进程被强杀时文件会停在 `true`，那只是回声，不再驱动任何自动行为。
   *
   * 写盘失败不影响监听与状态面（监听已经起来了，不能因为写配置文件把它拆掉）。
   */
  function commitEnabledFlag(): void {
    try {
      const current = readSettings()
      const live = runtime.handle !== null
      if (current.enabled === live) return
      store.writeSettings({ ...current, enabled: live })
    } catch {
      /* 写盘失败只影响下一次自动启动，不影响本次监听 */
    }
  }

  /** 停监听：`persistEnabled=false` 用于 `dispose()`（进程退出不是"用户点了停止"）。 */
  async function stopInternal(persistEnabled: boolean): Promise<RemoteStatus> {
    const handle = runtime.handle
    runtime.handle = null
    runtime.startedAt = null
    runtime.startedBy = null
    upstream = null
    if (refreshTimer !== null) {
      clearInterval(refreshTimer)
      refreshTimer = null
    }
    if (handle !== null) {
      try {
        await handle.close()
      } catch {
        /* 关闭失败不改变"已停止"这一事实：句柄已摘除 */
      }
    }
    if (persistEnabled && handle !== null) commitEnabledFlag()
    return status()
  }

  async function stop(): Promise<RemoteStatus> {
    // 显式停止 = 用户明确不要它了：意图必须一起清掉并落盘，否则下一次激活会把一个
    // 用户刻意关掉的监听"复活"（本模块的诚实半边）。`dispose()` 不走这里。
    persistIntent(false)
    return stopInternal(true)
  }

  /**
   * 起监听。`origin` 只决定 `status.startedBy` 与"要不要记意图"：
   *   - `manual`（用户点「开始接受连接」，默认）：把意图置 `true` 并落盘——**失败也置**
   *     （理由见下，这是本模块对"启动失败"的决定）；
   *   - `auto`（激活时按意图自动恢复）：意图本来就为真，不再写盘。
   *
   * 失败语义（**决定并记录在案**）：任何 fail-closed 分支只写 `status.lastError` 并返回，
   * **不清意图**。于是"启动失败"不会像旧实现那样留下一个读起来像"用户关掉了"的文件：
   * 意图仍是 `true`，下一次激活会（且只会）再自动试一次。
   */
  async function start(origin: 'auto' | 'manual' = 'manual'): Promise<RemoteStatus> {
    if (starting) return status()
    if (runtime.handle !== null) return status()
    // 手动发起 = 用户在表达"我要它开着"：先记意图再起，起不来也不抹掉这份表达。
    if (origin === 'manual') persistIntent(true)
    starting = true
    try {
      const settings = readSettings()
      const spec = listModes().find((item) => item.mode === settings.mode)
      if (spec === undefined) {
        runtime.lastError = { code: 'E_MODE_UNKNOWN', message: '访问方式未知，请重新选择' }
        return status()
      }
      if (spec.availability === 'unsupported') {
        runtime.lastError = { code: 'E_MODE_UNSUPPORTED', message: spec.unavailableReason }
        return status()
      }
      if (options.startListener === undefined) {
        runtime.lastError = { code: 'E_NO_LISTENER', message: '监听模块未装配（插件内部错误）' }
        return status()
      }
      if (authorizer === null) {
        runtime.lastError = { code: 'E_NO_GATE', message: '令牌门未装配（插件内部错误）' }
        return status()
      }
      const port = dshPort()
      if (port === null) {
        runtime.lastError = { code: 'E_NO_DSH_PORT', message: '读不到 DSH 自己的监听端口，无法启动远程访问' }
        return status()
      }
      // 先尝试换一次上游身份：换不到就不起监听（避免起了个全 503 的端口）。
      const identity = await upstreamCookie()
      if (identity === null) {
        runtime.lastError = { code: 'E_NO_UPSTREAM_IDENTITY', message: '拿不到 DSH 的本机会话（DSH 版本不支持或会话换取失败），远程访问已拒绝启动' }
        return status()
      }
      const bind = resolveBindAddress(settings.mode, settings, await routeAddressForResolution())
      if (!bind.ok) {
        runtime.lastError = { code: 'E_NO_BIND_ADDRESS', message: bind.reason }
        return status()
      }
      const listenPort = settings.port > 0 ? settings.port : port
      // mod-remote-tls-termination：密钥材料是启动前置条件，不是可选项。
      // 读不到就拒绝起监听（fail-closed）——宁可"远程访问不可用"，也绝不开一个明文端口。
      // 证书由 pairingProvision 生成并落 store（readCert 已校验指纹格式），私钥只在此处流转。
      const cert = store.readCert()
      if (cert === null) {
        runtime.lastError = {
          code: 'E_NO_TLS_CERT',
          message: '配对证书缺失或已损坏，已拒绝启动远程监听（不会回落明文 HTTP）；请先在设置里完成配对',
        }
        return status()
      }
      let handle: RemoteListenerHandle
      try {
        handle = await options.startListener({
          port: listenPort,
          bindAddress: bind.address,
          upstream: { baseUrl: `http://127.0.0.1:${String(port)}` },
          tls: { cert: cert.certPem, key: cert.keyPem },
          authorize: authorizer,
          ...(options.upstreamFirstByteTimeoutMs === undefined
            ? {}
            : { firstByteTimeoutMs: options.upstreamFirstByteTimeoutMs }),
          ...(options.upstreamConnectTimeoutMs === undefined
            ? {}
            : { connectTimeoutMs: options.upstreamConnectTimeoutMs }),
          ...(options.upstreamIdleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.upstreamIdleTimeoutMs }),
          ...(options.upstreamMaxTunnels === undefined ? {} : { maxUpgradeTunnels: options.upstreamMaxTunnels }),
          // U1：上游 401 时重新登录一次（listener 侧保证只重试一次）
          onUpstreamUnauthorized: refreshUpstreamAfter401,
          ...(options.onConnect === undefined ? {} : { onConnect: options.onConnect }),
        })
      } catch (error) {
        runtime.lastError = { code: 'E_LISTEN_FAILED', message: `监听启动失败：${safeMessage(error)}` }
        return status()
      }
      runtime.handle = handle
      runtime.startedAt = now().toISOString()
      runtime.startedBy = origin
      runtime.lastError = null
      // `enabled` 是句柄回声：起成功就写 true，文件不再出现"写着 false 其实在接连接"。
      commitEnabledFlag()
      // 上游会话 cookie 有 TTL：后台定期刷新，避免"某天突然全 401"。
      // 走 `mintOnce()`：与 401 重换、门禁自愈共用一个 single-flight，且**成功才替换**
      // （定时刷新失败绝不会把还在用的旧 cookie 清掉）。
      if (refreshTimer !== null) clearInterval(refreshTimer)
      const interval = options.upstreamRefreshMs ?? 6 * 60 * 60 * 1000
      refreshTimer = setInterval(() => {
        void mintOnce()
      }, interval)
      if (typeof refreshTimer === 'object' && refreshTimer !== null && 'unref' in refreshTimer) {
        ;(refreshTimer as { unref(): void }).unref()
      }
      return status()
    } catch (error) {
      runtime.lastError = { code: 'E_INTERNAL', message: safeMessage(error) }
      return status()
    } finally {
      starting = false
    }
  }

  /**
   * **激活入口**（mod-plugin-remote-autostart）：插件挂载时调用**恰好一次**。
   *
   * 这是整个包里唯一的自动启动路径（旧实现是 `src/index.ts` 读 `settings.enabled` 再调
   * `start()`，那个消费点已删除）。三条判据，一条都不能省：
   *   1. 意图不为真 ⇒ 什么都不做（`autoStart` 缺键 = false，旧文件行为不变）；
   *   2. 已经有句柄 ⇒ 直接返回，绝不重复起（幂等，"双击/重入"不会多出一个监听）；
   *   3. 前提（TLS 材料 + 可绑定地址）由 `start()` 自己 fail-closed 判定，这里不预检、
   *      也不因为仓库/令牌没配就跳过——仓库与令牌**不是**起监听的前提。
   *
   * 失败 = 只留 typed `status.lastError`，不抛：激活路径不许因为远程访问起不来而失败，
   * 下一次激活会再试一次（每次都只尝试一次，不做进程内重试）。
   */
  async function autoStart(): Promise<RemoteStatus> {
    if (runtime.handle !== null) return status()
    const settings = readSettings()
    if (settings.autoStart !== true) return status()
    return start('auto')
  }

  async function getState(): Promise<RemoteStateData> {
    const settings = readSettings()
    // 开关是"下次启动 DSH 时是否自动起监听"，不在这里隐式拉起，避免 UI 刷新触发网络动作。
    if (settings.enabled && runtime.handle === null) {
      // no-op：自动启动由 index.ts 在插件挂载时调用一次 start()
    }
    // 先让路由缓存落地，状态行才可能给出"默认路由地址"这一真因（同步出口只读缓存）。
    await routeAddressForResolution()
    return { settings: toSettingsView(settings), status: status(), modes: listModes() }
  }

  async function saveSettings(input: unknown): Promise<RemoteStateData> {
    const previous = readSettings()
    const raw = input !== null && typeof input === 'object' ? input : {}
    const next = normalizeRemoteSettings(raw, previous)
    // 显式入口：只有调用方**自己带了 `lanAddress` 键**且定为非空值，才算运维覆盖。
    // 只改端口/令牌的保存不会把磁盘上的自动镜像值"升格"成覆盖。
    const saidLanAddress =
      input !== null && typeof input === 'object' && Object.prototype.hasOwnProperty.call(input, 'lanAddress')
    if (saidLanAddress) {
      const trimmed = next.lanAddress.trim()
      explicitLanSave = trimmed === '' ? null : trimmed
    } else if (next.lanAddress.trim() === '') {
      explicitLanSave = null
    }
    store.writeSettings(next)
    // 换方式/换端口：先停掉旧监听，避免出现"状态显示 A、实际监听 B"。
    const modeChanged = next.mode !== previous.mode || next.port !== previous.port || next.lanAddress !== previous.lanAddress
    // 这里不是"用户点了停止"：不写 `enabled`，否则改个端口就会把自动启动偏好清掉。
    if (modeChanged && runtime.handle !== null) await stopInternal(false)
    if (modeChanged) runtime.probe = null
    if (next.enabled && runtime.handle === null) await start()
    return { settings: toSettingsView(next), status: status(), modes: listModes() }
  }

  async function rotateToken(): Promise<RemoteStatus> {
    const generate = options.generateToken ?? ((): string => {
      // 延迟 require，避免测试环境不装 crypto（node 内置，必然可用）。
      const { randomBytes } = require('node:crypto') as typeof import('node:crypto')
      return randomBytes(32).toString('base64url')
    })
    const token = generate()
    store.writeToken({ token, createdAt: now().toISOString() })
    // 令牌门持有的是内存里的 token：必须同步轮换，并让它吊销所有已签发会话。
    // 不重启监听：端口/绑定地址没变，重启只会制造一次无谓的断链。
    if (gate !== null && typeof gate.setToken === 'function') gate.setToken(token)
    return status()
  }

  /**
   * mod-plugin-pairing：采用 provisioning 已写入 `remote-token.json` 的令牌并同步内存门。
   * 只在结构合法时写盘；返回体只有 ok，绝不回显 token（token hygiene）。
   */
  function adoptToken(token: string): { ok: boolean } {
    if (typeof token !== 'string' || !/^[A-Za-z0-9+/=_-]{32,512}$/.test(token)) return { ok: false }
    store.writeToken({ token, createdAt: now().toISOString() })
    if (gate !== null && typeof gate.setToken === 'function') gate.setToken(token)
    return { ok: true }
  }

  async function probe(mode?: RemoteAccessMode): Promise<RemoteProbeResult> {
    const settings = readSettings()
    const target = mode ?? settings.mode
    if (options.runProbe === undefined) {
      const fallback: RemoteProbeResult = {
        mode: target,
        level: 'unknown',
        checks: [{ id: 'probe-unavailable', level: 'unknown', message: '自检模块未装配', hint: '' }],
        verdict: '暂不能自检',
        at: now().toISOString(),
      }
      runtime.probe = fallback
      return fallback
    }
    const result = await options.runProbe(target, settings, {
      dshPort: dshPort(),
      listenerAddress: runtime.handle === null ? null : runtime.handle.address,
    })
    runtime.probe = result
    return result
  }

  /**
   * 生成一条**含令牌**的可打开地址（唯一明文出口）。
   *
   * 令牌优先级：设置里用户粘贴的 `settings.token`（`lan`/`ipv6`/`tailscale` 的
   * 「访问令牌（可选）」）→ 回落到 `remote-token.json` 里的自动令牌。两者都空则拒绝：
   * 不生成"看起来能用、其实进不去"的地址。
   *
   * 错误消息里只描述"缺令牌"，绝不回显令牌值。
   */
  async function showLink(mode?: RemoteAccessMode): Promise<RemoteLink> {
    const settings = readSettings()
    const target = mode ?? settings.mode
    const pasted = settings.token.trim()
    const fallback = readTokenValue()
    const token = pasted !== '' ? pasted : fallback === null ? '' : fallback
    if (token === '') throw new Error('还没有访问令牌，请先生成')
    const handle = runtime.handle
    const selection = target === 'lan' ? lanSelectionFor(settings, await routeAddressForResolution()) : null
    // 与 `status()` 同一条纪律：运行中一律用监听句柄的实际地址（绑什么就广播什么）。
    const lanAddress = handle !== null ? handle.address : selection === null ? null : selection.address
    const urlSettings = handle !== null && target === 'lan' ? { ...settings, lanAddress: handle.address } : settings
    const built = urlForMode(target, urlSettings, { lanAddress, dshPort: dshPort() ?? 0 })
    if (!built.ok) throw new Error(built.reason === '' ? '这种方式暂时生成不出可用地址' : built.reason)
    // 非空令牌却拼不进去（地址非法）→ 空串 → 明确报错，不返回无令牌的假链接。
    const url = appendAccessToken(built.url, token)
    if (url === '') throw new Error('这种方式暂时生成不出可用地址')
    const qr = options.encodeQr === undefined ? { size: 0, modules: [] as boolean[][] } : options.encodeQr(url)
    return { url, qr, note: '' }
  }

  function detectLan(): LanCandidate[] {
    return listCandidatesNow()
  }

  async function dispose(): Promise<void> {
    // 进程退出/插件卸载不是"用户点了停止"：**不**改写 `enabled`、也**不**清 `autoStart`——
    // 否则每次关 DSH 都会把下次激活要用的自动启动意图清掉。
    await stopInternal(false).catch(() => undefined)
  }

  // 装配完成时后台预热一次路由探测（异步、有界、失败静默）：面板首个 getState 就能拿到真因。
  void refreshRouteAddress()

  return { getState, saveSettings, start, stop, autoStart, rotateToken, adoptToken, probe, showLink, detectLan, dispose, paths: { configFile: store.configFile, tokenFile: store.tokenFile } }
}

/** 默认令牌长度（字节）——与 `auth.ts` 的 `crypto.randomBytes(32)` 对齐。 */
export const REMOTE_TOKEN_BYTES = 32

/** 默认端口候选（0 = 跟随 DSH 端口）。 */
export const REMOTE_DEFAULT_PORT = DEFAULT_PORT_CANDIDATE
