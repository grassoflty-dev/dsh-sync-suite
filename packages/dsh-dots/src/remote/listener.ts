/**
 * 远程访问域（`src/remote/**`）：**旁挂监听 + 反向代理（HTTPS + WSS）**。
 *
 * mod-remote-tls-termination：对外这一跳**始终**是 TLS（自签证书，配对时固定指纹）。
 * 上游仍是 `http://127.0.0.1:<dsh端口>`（同机回环，不经过网卡）。不提供明文开关，
 * 证书/私钥缺失或非法一律 fail-closed（typed `E_REMOTE_TLS_SETUP_FAILED`），
 * **绝不**回落 `http.createServer()` —— 静默降级是 Blocker。
 *
 * 为什么是"旁挂"而不是改 DSH 自己的监听（踩坑记录，来自已安装的
 * `@feiyang666/dsh-mobile-remote@2.0.1` 的 `lib/lanproxy.js` 注释，只读参考、未 import）：
 *   · 新版 DSH 的 webserver 只接受"一块具体网卡的 IPv4 字面量"，`0.0.0.0` 直接抛错退出；
 *   · 真把宿主改绑到 `192.168.x.x`，本机 `127.0.0.1` 的监听随之消失 —— 桌面端窗口、
 *     固定加载 `http://127.0.0.1:<port>` 的官方桌面端会立刻白屏；
 *   · 官方桌面端用 `--port 0` 由系统分配端口，patch 里重述 port 会让端口漂移。
 * 因此本文件**只多开一个独立端口的监听**，DSH 侧监听一个字节都不动。
 *
 * 分层纪律（违反即返工）：
 *   1. 本文件**不** import `src/engine/**`、`src/schedule/**` 的任何实现：远程访问是旁挂件，
 *      起不来只允许影响远程访问，不许连累配置同步与日程。依赖仅限 `node:` 内置模块。
 *   2. 一切失败 **fail-closed**：地址非法 / 绑定失败 / 上游不可达 / 鉴权钩子抛错 /
 *      上游拒绝升级 → 一律当作"不可用"（抛 RemoteStartError 或回 403/502），绝不把
 *      请求放行到别处。
 *   3. **token 明文永不进错误消息与日志**：错误里只出现 scheme//host/path，查询串与
 *      userinfo 一律打码（`safeUrlText` / `scrubSecrets`），日志只写 errno 码（`codeOf`）。
 *   4. **TLS 准入不可降级**（mod-remote-tls-termination）：`tls` 入参必填且必须是可用密钥材料；
 *      失败只抛 typed `RemoteStartError`，不开明文监听、不写 certificate 内容到日志。
 *
 * 认证与路由**不在本文件**：本文件只提供 `authorize` 这一个门禁钩子，**HTTP 请求与
 * WebSocket upgrade 都必须过它**（upgrade 若绕过授权，等于开一条免令牌通道 —— DSH 的
 * `/api/remote.mux` 就是 WS）；自身**不做**任何 token 解析、不认任何特殊路径、不签发
 * 任何 cookie。（安全红线：绝不做"裸 GET / 自动补 token 并下发 cookie"这种事。）
 */
import http, { STATUS_CODES } from 'node:http'
import https from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { isIPv6 } from 'node:net'
import type { Duplex } from 'node:stream'

/** 动态上游头：静态对象，或每次请求都调用的函数（DSH 会话 cookie 会过期，需要可刷新）。 */
export type RemoteUpstreamHeaders =
  | Record<string, string>
  | (() => Record<string, string> | Promise<Record<string, string>>)

/** 反向代理的抽象上游。以后接隧道（Tailscale / Cloudflare）只换实现，不动本文件。 */
export interface RemoteUpstream {
  /** 上游基址：`http://host[:port][/base]`。查询串/userinfo 一律**不使用**。 */
  baseUrl: string
  /** 附加头（如注入本机会话 cookie）。拒绝覆盖 `host` 与 `x-forwarded-*`。 */
  headers?: RemoteUpstreamHeaders
}

/**
 * 门禁钩子的输入。
 *
 * `remoteAddress` 是**必须**带上的：限速是"同 IP"粒度的，拿不到对端 IP 就只能全局限速，
 * 一个攻击者就能把全家锁死。
 */
export interface RemoteAuthorizeInput {
  /** HTTP 方法（原样，通常是 `GET`/`POST`）。 */
  method: string
  /** 原始请求目标（path + query，不做规范化；**可含 token 查询参数，勿原样记日志**）。 */
  url: string
  /** 扁平化后的请求头：键小写，同名多值以 `, ` 连接。 */
  headers: Record<string, string>
  /** 对端 IP：IPv6 为不带方括号的原文；IPv4-mapped 已去掉 `::ffff:`；取不到为空串。 */
  remoteAddress: string
}

/** 钩子能拿到的额外上下文。 */
export interface RemoteAuthorizeContext {
  /** 仅 HTTP 请求有：调用方可以直接写这个响应（写完返回 `{ kind: 'respond' }` 即可）。 */
  res?: ServerResponse
  /** 仅 Upgrade 有裸 socket；**不要**在这里写握手应答（请用 `{ kind: 'respond' }`）。 */
  socket?: Duplex
}

/**
 * 门禁结论。任何不认识的值 = 拒绝（fail-closed）。
 *
 * - `{ kind: 'allow', upstreamHeaders? }` → 转发上游；`upstreamHeaders` 给**上游**补头
 *   （如刷新后的本机会话 cookie），不参与 `host` / `x-forwarded-*` 改写。
 * - `{ kind: 'respond', status?, headers?, body? }` → 由本监听直接回一个最小应答
 *   （默认 401），**不建上游连接**。调用方若已经自己写完了 `res`（`/__dsh_remote/*`
 *   这类自有接口），返回 `{ kind: 'respond' }` 即可，本监听不会重复写。
 */
export type RemoteAuthorizeDecision =
  | { kind: 'allow'; upstreamHeaders?: Record<string, string> }
  | {
      kind: 'respond'
      /** 状态码；缺省 401。 */
      status?: number
      /** 额外响应头（逐跳头与 content-length 由本监听决定，传了也不生效）。 */
      headers?: Record<string, string>
      /** 正文；缺省 `unauthorized\n`。 */
      body?: string
    }

/** 门禁钩子：HTTP 与 Upgrade 共用；可同步也可异步。抛错 = 拒绝。 */
export type RemoteAuthorize = (
  input: RemoteAuthorizeInput,
  context: RemoteAuthorizeContext,
) => RemoteAuthorizeDecision | boolean | Promise<RemoteAuthorizeDecision | boolean>

/**
 * 起监听所需的最小参数（调用方决定端口与具体网卡）。
 *
 * **端口语义**：`port` 为 `0` 时由操作系统随机分配（测试/一次性场景），实际端口以
 * 句柄的 `port` 为准。"跟随 DSH 端口"不在这里推断 —— 由调用方解析出具体端口值再传入。
 */
export interface RemoteListenerOptions {
  /** 对外端口；0 = 由 OS 分配（实际值见句柄 `port`）。 */
  port: number
  /** 必须是**具体**单播地址：局域网 IPv4（见 `isBindableLanAddress`），或公网 IPv6（见 `isBindableIpv6Address`）。 */
  bindAddress: string
  /** 转发目标（同机回环 HTTP）。 */
  upstream: RemoteUpstream
  /**
   * mod-remote-tls-termination：**必填**的 TLS 密钥材料（PEM 文本，来自
   * `pairingTls.generatePairingCertificate` → `store.readCert`，私钥不出装配层）。
   * 缺失 / 空串 / 非法 → typed `E_REMOTE_TLS_SETUP_FAILED`；本监听**没有**明文分支。
   */
  tls: { cert: string; key: string }
  /**
   * 鉴权/路由门禁，**HTTP 与 WebSocket upgrade 都必须过这里**。
   * 不传 = 不设门（仅测试/本机自用）；生产调用方必须传。
   */
  authorize?: RemoteAuthorize
  /**
   * 是否把上游 `location` 里的回环地址改写成外部 authority（默认 **true**）。
   * 不改写的话，平板会被 302 到它自己的 `127.0.0.1`，等于页面打不开。
   */
  rewriteRedirects?: boolean
  /**
   * **响应头预算**（毫秒，默认 `DEFAULT_UPSTREAM_RESPONSE_HEADER_TIMEOUT_MS` = 15000）：
   * 只给"上游响应头到达"计时，`'response'` 一到立刻清掉。`firstByteTimeoutMs` 是它的旧名
   * （两者等价，传入哪个都行；`firstByteTimeoutMs` 优先，保持早期调用方不变）。
   *
   * 为什么只卡首字节、不卡整个响应：DSH 的 `/api` 与资产里既有 chunked 长流，也有长轮询，
   * 给正文总量计时会误杀正常连接。上游挂死时平板会无限等待（实测缺陷 G2），所以必须有界；
   * 但界只画在"多久还没开始回话"这一处。到期 → 504 + typed `E_UPSTREAM_TIMEOUT`。
   * 非法值（非有限数/≤0）回落默认值：宁可用默认预算，也不许变成"没有预算"。
   */
  firstByteTimeoutMs?: number
  /** 响应头预算的规范名（`firstByteTimeoutMs` 是它的别名）。 */
  responseHeaderTimeoutMs?: number
  /**
   * **连接预算**（毫秒，默认 5000）：TCP 还没建起来（含 DNS 解析）时的上限。
   * 到期 → 504 + typed `E_UPSTREAM_TIMEOUT`（与"连接被拒"区分：拒连是 502 `E_UPSTREAM_DOWN`，
   * 因为那说明端口上确实没人听，而不是网线那头沉默）。
   */
  connectTimeoutMs?: number
  /**
   * **空闲预算**（毫秒，默认 120000）：响应已经开始流式回传后，**两个方向都没有进展**
   * 持续这么久才算卡死。
   *
   * "有进展"的口径就是本文件实际的实现：
   *   · 上游又给了一块正文数据（下行字节）；**或**
   *   · 客户端把积压读走了（`res` 的 `drain`，本监听随即 `resume()` 上游）。
   * 背压期间预算**挂起**：`res.write()` 返回 false 后上游被 `pause()`，本来就不会再有
   * data 事件；此时到点掐断会把"健康但客户端读得慢"的传输截成半包 —— 那是对端慢，
   * 不是上游卡死。
   *
   * **豁免**：`content-type` 为 `text/event-stream`（SSE，如 DSH 的 `/plugins/events`）
   * 或 `multipart/x-mixed-replace` 的响应**根本不起空闲预算** —— 安静是这类长连接的正常
   * 状态，不是停滞；它们的死活由客户端按事件节奏自己判断。连接预算与响应头预算照旧生效。
   *
   * 到期行为：**一个字节都还没回给客户端**时回 504 + typed `E_UPSTREAM_STALLED`；
   * 已经开始回传则只掐断连接，绝不往半个响应里塞错误页。
   */
  idleTimeoutMs?: number
  /**
   * **并发实时隧道上限**（默认 16）：每条 WebSocket 占一条独立上游连接，不封顶就会被
   * 一个页面/一台设备把本机端口和上游连接数吃光。到顶后的新升级请求回 503 +
   * typed `E_UPGRADE_TUNNELS_FULL`，并计入 `stats().rejected`（不是静默丢弃）。
   */
  maxUpgradeTunnels?: number
  /**
   * 上游回了 401（本机注入的会话已失效）时调用：**清掉缓存的会话并重新换一次身份**，
   * 返回给上游的新头（通常是新的 `cookie`），返回 `null` 表示换不到。
   *
   * 只重试**一次**，且仅当请求体可重放（无 body 或 `content-length` 不超过
   * `REPLAY_BODY_LIMIT`）时重试。安全性依据：DSH 的 `admit()` 在 RPC handler 之前就拒绝
   * （`rpc-host.ts:129-137`），401 的请求没有执行过任何副作用。
   * 不传 = 不重试，直接把 401 换成中文错误页 / typed JSON。
   */
  onUpstreamUnauthorized?: () =>
    | Record<string, string>
    | null
    | Promise<Record<string, string> | null>
  /** 诊断日志（**不要**在这里塞 token；本文件写日志前还会再脱敏一次）。 */
  log?: (message: string) => void
  /**
   * 入站连接钩子（mod-plugin-pairing-client 的脱敏审计）：每个新 socket 触发一次。
   * 这里只交原始 IP（调用方负责脱敏）；token / 请求行 / 端口一律不传。
   */
  onConnect?: (info: { at: string; remoteAddress: string }) => void
}

/** 监听句柄。`port`/`address` 是**实际**绑定值（`port: 0` 时尤其重要）。 */
export interface RemoteListenerHandle {
  port: number
  address: string
  /** 释放端口：关闭 server 并断掉所有活动 socket（含已升级的隧道）。幂等。 */
  close(): Promise<void>
  /** 运行计数（不含任何敏感信息）。 */
  stats(): { active: number; total: number; rejected: number }
  /** 最近一次运行期错误（上游不可达/握手失败等）；错误消息已脱敏，不含 token。 */
  readonly lastError: { code: string; message: string } | null
}

export type RemoteStartErrorCode =
  | 'E_REMOTE_INVALID_OPTIONS'
  | 'E_REMOTE_INVALID_PORT'
  | 'E_REMOTE_INVALID_ADDRESS'
  | 'E_REMOTE_INVALID_UPSTREAM'
  | 'E_REMOTE_TLS_SETUP_FAILED'
  | 'E_REMOTE_BIND_FAILED'

/**
 * 启动失败。调用方必须 catch 后降级（"远程访问不可用"），不许让它冒到插件启动路径。
 * 消息已保证不含 token 明文与查询串。
 */
export class RemoteStartError extends Error {
  readonly code: RemoteStartErrorCode
  readonly address: string
  readonly port: number
  /** 底层 errno 码（如 `EADDRINUSE`）；无则空串。 */
  readonly detail: string

  constructor(
    code: RemoteStartErrorCode,
    message: string,
    info: { address?: string; port?: number; detail?: string } = {},
  ) {
    super(message)
    this.name = 'RemoteStartError'
    this.code = code
    this.address = info.address ?? ''
    this.port = info.port ?? 0
    this.detail = info.detail ?? ''
  }
}

/** 上游**响应头预算**的默认值（毫秒）：见 `RemoteListenerOptions.responseHeaderTimeoutMs`。 */
export const DEFAULT_UPSTREAM_RESPONSE_HEADER_TIMEOUT_MS = 15_000
/** 旧名（等价于 `DEFAULT_UPSTREAM_RESPONSE_HEADER_TIMEOUT_MS`，保留以免破坏既有调用方/测试）。 */
export const DEFAULT_UPSTREAM_FIRST_BYTE_TIMEOUT_MS = DEFAULT_UPSTREAM_RESPONSE_HEADER_TIMEOUT_MS
/** 上游**连接预算**默认值（毫秒）。 */
export const DEFAULT_UPSTREAM_CONNECT_TIMEOUT_MS = 5_000
/** 上游**空闲预算**默认值（毫秒）：响应开始后多久没有新字节算卡死。 */
export const DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS = 120_000
/**
 * **开放式流**的 `content-type`：`text/event-stream`（SSE，DSH 的 `/plugins/events`）与
 * `multipart/x-mixed-replace`（长连推流）。这类响应"安静"是正常状态，**不起空闲预算**。
 */
const OPEN_ENDED_STREAM_RE = /^(?:text\/event-stream|multipart\/x-mixed-replace)\b/i
/** **并发实时隧道**默认上限。 */
export const DEFAULT_MAX_UPGRADE_TUNNELS = 16
/**
 * 可重放请求体的上限（字节）：401 重试需要把请求体重放一次，所以只对不超过此值的
 * `content-length` 缓冲；更大的（上传类）直接流式转发、不重试。**永不缓存上游响应体**。
 */
const REPLAY_BODY_LIMIT = 512 * 1024

/** IPv4 点分四段解析：拒绝前导零、非数字、越界（`192.168.1.256` 必须假）。 */
function parseIpv4(addr: string): [number, number, number, number] | null {
  const parts = addr.split('.')
  if (parts.length !== 4) return null
  const octets: number[] = []
  for (const part of parts) {
    // 只允许十进制且无前导零（避免 `010` 被当成八进制这类歧义）
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null
    const value = Number(part)
    if (value > 255) return null
    octets.push(value)
  }
  return [octets[0]!, octets[1]!, octets[2]!, octets[3]!]
}

/**
 * 纯函数：该地址能不能作为**局域网旁挂监听**的绑定地址。
 *
 * 通过 = 具体、单播、非回环、非链路本地、非"任意地址"的 IPv4。
 * 拒绝：
 *   · 非 IPv4 文本（`::1`、`::ffff:192.168.1.6`、`localhost`、空串、带空白/端口/掩码）；
 *   · 非法字面量（`abc`、`192.168.1.256`、`192.168.01.6`）；
 *   · `0.0.0.0` 与 `0.0.0.0/8`（"任意地址"，等于把 DSH 摊到所有网卡）；
 *   · `127.0.0.0/8`（回环：旁挂监听绑回环没有意义，且会与 DSH 自己的监听打架）；
 *   · `169.254.0.0/16`（链路本地/APIPA：地址不稳定，绑上也会随时失效）；
 *   · `224.0.0.0/4` 组播、`240.0.0.0/4` 保留、`255.255.255.255` 广播。
 *
 * 故意**不**限制在 RFC1918 私网：`100.64.0.0/10`（Tailscale/CGNAT）与部分企业网段
 * 也是合法可绑的单播地址，收紧会造成"地址正常却绑不上"的假故障。
 */
export function isBindableLanAddress(addr: string): boolean {
  if (typeof addr !== 'string' || addr === '') return false
  const parsed = parseIpv4(addr)
  if (parsed === null) return false
  const [a, b] = parsed
  if (a === 0) return false // 0.0.0.0/8：任意地址
  if (a === 127) return false // 回环
  if (a === 169 && b === 254) return false // 链路本地 / APIPA
  if (a >= 224) return false // 组播 + 保留 + 广播
  return true
}

/**
 * 纯函数：该地址能不能作为**公网 IPv6 直连**的绑定地址。
 *
 * 为什么需要它：`ipv6` 访问方式要把监听直接绑在具体的公网 v6 字面量上（不需要 DNS、
 * 不需要 trustedHosts）。listener 原来只认局域网 IPv4，会让 `ipv6` 方式永远起不来
 * （独立评审 M1）。这里补齐 v6 的判定，规则与 `isBindableLanAddress` 同构：
 *
 * 拒绝：带方括号 / 带 `%zone` / 空串 / 非 v6 文本 / `::`（未指定）/ `::1`（回环）/
 *       `fe80::/10`（链路本地，换网就失效）/ `ff00::/8`（组播）/ IPv4 映射写法。
 * 允许：`2000::/3` 全局单播（公网直连的主场景）与 `fc00::/7` ULA（内网 v6 也合法可绑）。
 */
export function isBindableIpv6Address(addr: string): boolean {
  if (typeof addr !== 'string' || addr === '') return false
  if (addr.startsWith('[') || addr.endsWith(']')) return false
  if (addr.includes('%')) return false
  if (!isIPv6(addr)) return false
  const lower = addr.toLowerCase()
  if (lower === '::' || lower === '::1') return false
  // IPv4 映射（::ffff:a.b.c.d）在 URL/Host 语义上歧义，不作为绑定目标
  if (lower.startsWith('::ffff:')) return false
  const first = lower.split(':')[0] ?? ''
  const hextet = first === '' ? 0 : Number.parseInt(first.padEnd(4, '0'), 16)
  // ff00::/8 组播
  if ((hextet & 0xff00) === 0xff00) return false
  // fe80::/10 链路本地
  if ((hextet & 0xffc0) === 0xfe80) return false
  // 只放行 2000::/3（全局单播）与 fc00::/7（ULA）
  if ((hextet & 0xe000) === 0x2000) return true
  if ((hextet & 0xfe00) === 0xfc00) return true
  return false
}

/** 通用判定：具体、单播、非回环、非通配的 IPv4 或 IPv6（listener 的实际门槛）。 */
export function isBindableAddress(addr: string): boolean {
  return isBindableLanAddress(addr) || isBindableIpv6Address(addr)
}

/**
 * 会被打码的查询参数名（错误/日志出口统一复用）。
 * 写成数组是为了只有一处词表：新增敏感名不用改正则。
 */
const SECRET_QUERY_KEYS = [
  'token',
  'secret',
  'password',
  'passwd',
  'pwd',
  'cookie',
  'session',
  'auth',
  'ticket',
  'access_token',
  'refresh_token',
  'apikey',
  'api_key',
]

const SECRET_QUERY_PATTERN = new RegExp(`([?&](?:${SECRET_QUERY_KEYS.join('|')})=)[^&\\s"'#]+`, 'gi')

/** 把文本里的 token 类查询参数与 URL userinfo 打码（错误/日志出口统一走这里）。 */
export function scrubSecrets(text: string): string {
  return String(text ?? '')
    .replace(SECRET_QUERY_PATTERN, '$1***')
    .replace(/(\/\/)[^/@\s]+@/g, '$1***@')
}

/** 只保留 `scheme//host/path`，剔除查询串与 userinfo —— 永不回显 token。 */
function safeUrlText(raw: string): string {
  try {
    const url = new URL(raw)
    const auth = url.username !== '' || url.password !== '' ? '***@' : ''
    return `${url.protocol}//${auth}${url.host}${url.pathname}${url.search !== '' ? '?…' : ''}`
  } catch {
    return '<非法地址>'
  }
}

/** 绑定地址在错误消息里的安全写法（截断 + 去空白，避免把畸形输入整段回显）。 */
function describeAddress(addr: unknown): string {
  if (typeof addr !== 'string') return '（非字符串）'
  const clipped = addr.slice(0, 64).replace(/\s+/g, ' ')
  return clipped === '' ? '（空串）' : clipped
}

/** 只取 errno 码；日志里绝不带原始 message（message 可能夹带 URL/凭据）。 */
function codeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const code = (error as NodeJS.ErrnoException).code
    if (typeof code === 'string' && code !== '') return code
    const name = (error as { name?: unknown }).name
    if (typeof name === 'string' && name !== '') return name
  }
  return 'E_REMOTE'
}

function normalizeIp(ip: string | undefined): string {
  const text = typeof ip === 'string' ? ip.replace(/^::ffff:/, '') : ''
  return text === '0:0:0:0:0:0:0:1' ? '::1' : text
}

/** 逐跳头：不转发（由我们自己这一跳重新决定）。 */
const REQUEST_HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'expect',
  'proxy-authenticate',
  'proxy-authorization',
])

/**
 * 回传客户端时**必须**剔除的响应头。
 *
 * - `set-*`：上游 cookie 就是本机 owner 身份，漏给平板等于把 owner 权限交出去；
 *   本监听永远不代发上游 cookie。
 * - 其余是逐跳头，由我们这一跳重新决定。
 */
const RESPONSE_STRIP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'set-cookie',
  'set-cookie2',
])

/** 101 应答只剔 cookie；Connection/Upgrade/Sec-WebSocket-Accept 必须原样保留。 */
const UPGRADE_RESPONSE_STRIP = new Set(['set-cookie', 'set-cookie2'])

interface UpstreamTarget {
  hostname: string
  port: number
  /** 上游 url 的 pathname（`/` 视为空前缀）。 */
  basePath: string
  /** Host 头（`host[:port]`）。 */
  hostHeader: string
  headers?: RemoteUpstreamHeaders
}

/** 解析并校验 `RemoteUpstream.baseUrl`；不合法一律 RemoteStartError。 */
function parseUpstream(upstream: RemoteUpstream): UpstreamTarget {
  if (upstream === null || typeof upstream !== 'object') {
    throw new RemoteStartError('E_REMOTE_INVALID_UPSTREAM', '缺少上游地址（RemoteUpstream.baseUrl）')
  }
  const raw = upstream.baseUrl
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new RemoteStartError('E_REMOTE_INVALID_UPSTREAM', '上游地址为空')
  }
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new RemoteStartError('E_REMOTE_INVALID_UPSTREAM', `上游地址非法：${safeUrlText(raw)}`)
  }
  if (url.protocol !== 'http:') {
    throw new RemoteStartError(
      'E_REMOTE_INVALID_UPSTREAM',
      `上游只支持 http://（本监听用 node:http 直连本机）；收到：${safeUrlText(raw)}`,
    )
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  if (hostname === '') {
    throw new RemoteStartError('E_REMOTE_INVALID_UPSTREAM', `上游地址缺少主机：${safeUrlText(raw)}`)
  }
  const port = url.port !== '' ? Number(url.port) : 80
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new RemoteStartError('E_REMOTE_INVALID_UPSTREAM', `上游端口非法：${String(url.port)}`)
  }
  return {
    hostname,
    port,
    basePath: url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, ''),
    hostHeader: url.host,
    headers: upstream.headers,
  }
}

/** 把客户端 path+query 拼到上游 basePath 之后（保留原样，不做规范化）。 */
function upstreamPath(basePath: string, requestUrl: string | undefined): string {
  const raw = typeof requestUrl === 'string' && requestUrl !== '' ? requestUrl : '/'
  const withSlash = raw.startsWith('/') ? raw : `/${raw}`
  return `${basePath}${withSlash}`
}

/** 解析动态上游头（可异步）；只保留字符串值，拒绝 host / x-forwarded-*。 */
async function resolveUpstreamHeaders(target: UpstreamTarget): Promise<Record<string, string>> {
  const source = target.headers
  if (source === undefined) return {}
  const value = typeof source === 'function' ? await source() : source
  if (value === null || typeof value !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== 'string') continue
    const lower = key.toLowerCase()
    if (lower === 'host' || lower.startsWith('x-forwarded-')) continue
    out[lower] = raw
  }
  return out
}

/**
 * 解析一个预算值：只接受有限正数，其余回落默认值（绝不把预算变成"无预算"）。
 */
function resolveBudget(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback
  return Math.max(1, Math.floor(value))
}

/**
 * G1：**同源 Origin 才改写**成上游 authority（实测 403 的修法）。
 *
 * 背景（实测，只记状态码）：对上真的 DSH GUI（`127.0.0.1:36569`）发
 * `GET /api/state`，`Host: 127.0.0.1:36569` 且不带 Origin → **401**（栅栏通过，只是未认证）；
 * 同一个请求加上 `Origin: https://192.168.1.6:3081` → **403 forbidden**；
 * 把 Origin 换成 `http://127.0.0.1:36569` 又回到 401。DSH 的信任栅栏
 * （`@deepseek-ai/dsh-client-connection/src/api-request-trust.ts:121-176`）要求
 * Host 是回环/绑定/受信主机，**且**请求若带 Origin，其 authority 必须与 Host 的 authority 相同。
 *
 * 本监听把 Host 改写成了上游回环地址，却原样转发 Origin —— 于是平板浏览器
 * （页面在 `https://<平板可见 authority>` 上）带来的 Origin 与改写后的 Host 不同源，
 * 上游对**每个 `/api` POST 与每条 WebSocket 握手**都回 403：页面能渲染，但一点就废。
 *
 * 判定口径（只认"这确实是本监听自己的同源请求"）：
 *   · 入站 `Origin` 与入站 `Host` 的 authority（`URL.host`，scheme 不参与比较，大小写不敏感）
 *     完全相同 → 改写成 `http://<target.hostHeader>`（上游只有 http）；
 *   · 其它任何情况（Origin 缺失 / 外来 authority / 不能解析，如 `null`）→ **原样保留**，
 *     让 DSH 自己的栅栏拒掉。这里**绝不**替 DSH 放宽栅栏：外来 Origin 被改写成回环，
 *     等于把跨站请求洗成同源请求，那是安全缺陷而不是修复。
 *
 * @returns 改写后的 Origin；不需要改写时返回 `undefined`（调用方保持原值）。
 */
function rewriteSameOrigin(value: string | undefined, inboundHost: string | undefined, upstreamHost: string): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined
  if (typeof inboundHost !== 'string' || inboundHost.trim() === '') return undefined
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return undefined // 不能解析（如 `null`）：原样保留
  }
  if (parsed.host === '') return undefined
  if (parsed.host.toLowerCase() !== inboundHost.trim().toLowerCase()) return undefined // 外来 Origin：不碰
  return `http://${upstreamHost}`
}

/** 组装转发给上游的请求头（host 改写 + Origin 同源改写 + x-forwarded-* 追加 + 静态/门禁头）。 */
function outboundHeaders(
  req: IncomingMessage,
  target: UpstreamTarget,
  extraHeaders?: Record<string, string>,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    if (REQUEST_HOP_BY_HOP.has(key)) continue
    out[key] = value
  }
  const ip = normalizeIp(req.socket?.remoteAddress)
  if (ip !== '') {
    const prev = req.headers['x-forwarded-for']
    const prevText = Array.isArray(prev) ? prev.join(', ') : prev
    out['x-forwarded-for'] = typeof prevText === 'string' && prevText !== '' ? `${prevText}, ${ip}` : ip
  }
  // 外部这一跳已被本监听终结为 HTTPS；上游（同机回环）仍是 http。
  out['x-forwarded-proto'] = 'https'
  const originalHost = req.headers.host
  if (typeof originalHost === 'string' && originalHost !== '') out['x-forwarded-host'] = originalHost
  if (extraHeaders !== undefined) {
    for (const [key, value] of Object.entries(extraHeaders)) {
      const lower = key.toLowerCase()
      // host 与 x-forwarded-* 由本监听决定，调用方也不许覆盖（防伪造）
      if (lower === 'host' || lower.startsWith('x-forwarded-')) continue
      out[lower] = value
    }
  }
  out.host = target.hostHeader
  // G1：Host 已改写，同源 Origin 必须跟着改写到同一 authority，否则上游一律 403（见上面实测）。
  const origin = rewriteSameOrigin(req.headers.origin, originalHost, target.hostHeader)
  if (origin !== undefined) out.origin = origin
  return out
}

/** 回环 authority 判定（``127.0.0.1[:port]`` / `localhost[:port]` / `[::1][:port]`）。 */
function isLoopbackHost(hostname: string): boolean {
  const lower = hostname.toLowerCase()
  return lower === '127.0.0.1' || lower === 'localhost' || lower === '::1' || lower === '[::1]' || lower === '0.0.0.0'
}

/**
 * 把 `location` 里的本机地址改写为**外部** authority（默认开启）。
 *
 * 上游看清楚平板访问的是 `192.168.1.6:3081`，但它自己生成的 302 只会写
 * `http://127.0.0.1:<上游端口>/…`；不改写平板就会跳到它自己的 localhost。
 * 改写后的 scheme 必须是 `https`（本监听对外终结 TLS），否则平板会拿明文去连 TLS 端口。
 * 相对 `location` 不动（浏览器按外部 origin 解析，本来就是对的）。
 */
function rewriteLocation(value: string, externalAuthority: string, upstreamHost: string): string {
  if (typeof value !== 'string' || value === '' || externalAuthority === '') return value
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return value // 相对 location：无需改写
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return value
  const host = parsed.hostname.toLowerCase()
  const isUpstream = host === upstreamHost.toLowerCase()
  if (!isUpstream && !isLoopbackHost(host)) return value
  return `https://${externalAuthority}${parsed.pathname}${parsed.search}${parsed.hash}`
}

/** 组装回传给客户端的响应头（剔 cookie/逐跳头，按需改写 location，保留多值）。 */
function inboundHeaders(
  up: IncomingMessage,
  externalAuthority: string,
  upstreamHost: string,
  rewrite: boolean,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (let i = 0; i < up.rawHeaders.length; i += 2) {
    const key = up.rawHeaders[i]
    if (key === undefined) continue
    const lower = key.toLowerCase()
    if (RESPONSE_STRIP.has(lower)) continue
    let value = up.rawHeaders[i + 1] ?? ''
    if (rewrite && lower === 'location') value = rewriteLocation(value, externalAuthority, upstreamHost)
    const prev = out[lower]
    if (prev === undefined) out[lower] = value
    else if (Array.isArray(prev)) prev.push(value)
    else out[lower] = [prev, value]
  }
  return out
}

/** 把上游的 101 应答原样序列化成字节（rawHeaders 逐条保留，只剔 cookie）。 */
function serializeResponseHead(res: IncomingMessage): string {
  const status = res.statusCode ?? 101
  const reason =
    res.statusMessage !== undefined && res.statusMessage !== ''
      ? res.statusMessage
      : STATUS_CODES[status] ?? 'Switching Protocols'
  const lines = [`HTTP/1.1 ${String(status)} ${reason}`]
  for (let i = 0; i < res.rawHeaders.length; i += 2) {
    const key = res.rawHeaders[i]
    if (key === undefined) continue
    if (UPGRADE_RESPONSE_STRIP.has(key.toLowerCase())) continue
    lines.push(`${key}: ${res.rawHeaders[i + 1] ?? ''}`)
  }
  return `${lines.join('\r\n')}\r\n\r\n`
}

/** 任何"能被销毁"的流（socket / ClientRequest / IncomingMessage / ServerResponse）。 */
interface Destroyable {
  destroy?: () => void
}

function destroyQuietly(target: Destroyable | null | undefined): void {
  if (target === null || target === undefined) return
  try {
    if (typeof target.destroy === 'function') target.destroy()
  } catch {
    /* 已经断了 */
  }
}

function enableNoDelay(socket: Duplex): void {
  const maybe = socket as Partial<Socket>
  if (typeof maybe.setNoDelay === 'function') {
    try {
      maybe.setNoDelay(true)
    } catch {
      /* 非 TCP socket 忽略 */
    }
  }
}

/** 这些头在最小应答里由本监听自己决定，调用方传了也不生效。 */
const PLAIN_RESPONSE_RESERVED = new Set(['content-length', 'connection', 'transfer-encoding', 'keep-alive'])

/** 普通 HTTP 应答（fail-closed 专用；正文里绝不出现上游地址或 token）。 */
function respondPlain(
  res: ServerResponse,
  status: number,
  text: string,
  close = false,
  extraHeaders?: Record<string, string>,
): void {
  if (res.headersSent || res.writableEnded) {
    destroyQuietly(res)
    return
  }
  const body = Buffer.from(text, 'utf8')
  const headers: Record<string, string> = {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(body.length),
  }
  if (close) headers.connection = 'close'
  if (extraHeaders !== undefined) {
    for (const [key, value] of Object.entries(extraHeaders)) {
      const lower = key.toLowerCase()
      if (PLAIN_RESPONSE_RESERVED.has(lower)) continue
      headers[lower] = value
    }
  }
  try {
    res.writeHead(status, headers)
    res.end(body)
  } catch {
    destroyQuietly(res)
  }
}

/**
 * 上游各类 typed 失败的**固定正文**（逐字节稳定，测试与平板端都按它断言/解析）。
 *
 * 纪律：正文只有码，绝不含凭据、URL、查询串、上游地址或 errno 原文 —— 平板侧只要能区分
 * 失败种类，不需要更多信息。`content-type` 固定 `application/json; charset=utf-8`，
 * `cache-control: no-store`（错误不许被任何中间层缓存）。
 */
const UPSTREAM_ERROR_BODIES = {
  /** 连接级失败（上游没接上 / 被重置 / 域名解析失败）：502。 */
  E_UPSTREAM_DOWN: '{"ok":false,"error":{"code":"E_UPSTREAM_DOWN"}}',
  /** 连接预算或响应头预算到期（上游一直不开始回话）：504。 */
  E_UPSTREAM_TIMEOUT: '{"ok":false,"error":{"code":"E_UPSTREAM_TIMEOUT"}}',
  /** 响应已经开始，但中途长时间没有新字节（空闲预算到期）：504。 */
  E_UPSTREAM_STALLED: '{"ok":false,"error":{"code":"E_UPSTREAM_STALLED"}}',
  /** 上游回了一个解析不了的响应（`HPE_*` 一类协议错误）：502。 */
  E_UPSTREAM_PROTOCOL: '{"ok":false,"error":{"code":"E_UPSTREAM_PROTOCOL"}}',
  /** 上游拒绝本机会话（401；换过一次身份仍被拒）：401。 */
  E_UPSTREAM_SESSION: '{"ok":false,"error":{"code":"E_UPSTREAM_SESSION"}}',
  /** 实时隧道数量到顶（见 `maxUpgradeTunnels`）：503。 */
  E_UPGRADE_TUNNELS_FULL: '{"ok":false,"error":{"code":"E_UPGRADE_TUNNELS_FULL"}}',
} as const

type UpstreamErrorCode = keyof typeof UPSTREAM_ERROR_BODIES

/** 每个 typed 码对应的状态码（**不许**漂移：平板端按码分类，测试按码 + 状态码断言）。 */
const UPSTREAM_ERROR_STATUS: Record<UpstreamErrorCode, number> = {
  E_UPSTREAM_DOWN: 502,
  E_UPSTREAM_TIMEOUT: 504,
  E_UPSTREAM_STALLED: 504,
  E_UPSTREAM_PROTOCOL: 502,
  E_UPSTREAM_SESSION: 401,
  E_UPGRADE_TUNNELS_FULL: 503,
}

/**
 * 给**人**看的中文说明（U1：平板侧永远不许看到上游的英文正文或堆栈）。
 * 每种原因一套文案：说清"哪里坏了"与"下一步做什么"。
 */
const UPSTREAM_ERROR_COPY: Record<UpstreamErrorCode, { title: string; detail: string; next: string }> = {
  E_UPSTREAM_DOWN: {
    title: '电脑上的 DSH 页面没在运行',
    detail: '代理连不上电脑上的 DSH 服务（连接被拒绝）。',
    next: '请在电脑上打开 DSH 并确认服务在运行，然后重试。',
  },
  E_UPSTREAM_TIMEOUT: {
    title: '电脑上的 DSH 响应超时',
    detail: '代理等了一段时间，DSH 一直没有开始回应。',
    next: '请确认电脑没有休眠、DSH 窗口还在运行，然后重试。',
  },
  E_UPSTREAM_STALLED: {
    title: '电脑上的 DSH 传输中断',
    detail: 'DSH 已经回应，但中途长时间没有新数据。',
    next: '请重试；若反复出现，请检查电脑网络并重启 DSH。',
  },
  E_UPSTREAM_PROTOCOL: {
    title: '电脑上的 DSH 回应不合法',
    detail: 'DSH 返回的响应无法解析（版本不匹配或被中间件改写）。',
    next: '请重启电脑上的 DSH 后重试。',
  },
  E_UPSTREAM_SESSION: {
    title: '电脑上的 DSH 会话已失效',
    detail: 'DSH 拒绝了这个会话（自动重新登录一次后仍被拒）。',
    next: '请在电脑上重启 DSH；重启后代理会自动重新登录。',
  },
  E_UPGRADE_TUNNELS_FULL: {
    title: '实时连接数已满',
    detail: '同时打开的实时通道太多（每条标签页占一条）。',
    next: '请关掉部分标签页或稍等片刻再重试。',
  },
}

/**
 * 连接级 / 超时类 errno：只有它们走 typed 502；其余意外失败仍走原来的明文 502
 * （`remote upstream unavailable\n`），不改变既有排查口径。
 */
const UPSTREAM_DOWN_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'NETUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
])

/** 判断一个上游错误是否属于"连接级失败"（响应头一个字节都没到）。 */
function isUpstreamDownError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const code = (error as NodeJS.ErrnoException).code
  return typeof code === 'string' && UPSTREAM_DOWN_CODES.has(code)
}

/** `HPE_*` 是 Node 的 HTTP 解析错误：上游回的东西根本不是合法 HTTP。 */
function isUpstreamProtocolError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const code = (error as NodeJS.ErrnoException).code
  return typeof code === 'string' && code.startsWith('HPE_')
}

/** 回 typed 上游错误（JSON 正文；`content-type` 由 `respondPlain` 的额外头覆盖）。 */
function respondUpstreamError(res: ServerResponse, code: UpstreamErrorCode): void {
  respondPlain(res, UPSTREAM_ERROR_STATUS[code], UPSTREAM_ERROR_BODIES[code], true, {
    'content-type': 'application/json; charset=utf-8',
  })
}

/** 导航请求（浏览器地址栏/内嵌 WebView 的主文档）才配 HTML 错误页。 */
function wantsHtml(req: IncomingMessage): boolean {
  const accept = req.headers.accept
  return typeof accept === 'string' && accept.includes('text/html')
}

/** 极小的中文 HTML 错误页（无外链、无脚本、无上游正文；纯常量插值，无注入面）。 */
function renderErrorPage(code: UpstreamErrorCode, status: number): string {
  const copy = UPSTREAM_ERROR_COPY[code]
  return [
    '<!doctype html>',
    '<html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${copy.title}</title>`,
    '<style>body{font:16px/1.7 -apple-system,"HarmonyOS Sans",sans-serif;margin:0;padding:32px;color:#1f1f1f;background:#fafafa}',
    'main{max-width:32rem;margin:0 auto;background:#fff;border-radius:12px;padding:24px;box-shadow:0 1px 4px rgba(0,0,0,.08)}',
    'h1{font-size:1.25rem;margin:0 0 .75rem}p{margin:.4rem 0}.code{color:#8a8a8a;font-size:.8rem;margin-top:1rem}</style>',
    '</head><body><main>',
    `<h1>${copy.title}</h1>`,
    `<p>${copy.detail}</p>`,
    `<p>${copy.next}</p>`,
    `<p class="code">错误码 ${code} · HTTP ${String(status)}</p>`,
    '</main></body></html>',
    '',
  ].join('\n')
}

/**
 * 失败出口（U1）：导航请求给中文 HTML 页，其余给 typed JSON。
 * 状态码保持与该失败种类一致（502/504/401/503），绝不改成 200。
 */
function respondUpstreamFailure(req: IncomingMessage, res: ServerResponse, code: UpstreamErrorCode): void {
  const status = UPSTREAM_ERROR_STATUS[code]
  if (!wantsHtml(req)) {
    respondUpstreamError(res, code)
    return
  }
  respondPlain(res, status, renderErrorPage(code, status), true, { 'content-type': 'text/html; charset=utf-8' })
}

/** 直接往裸 socket 写一个应答（Upgrade 通道没有 ServerResponse 可用）。 */
function writeRawResponse(socket: Duplex, status: number, text: string, extraHeaders?: Record<string, string>): void {
  const body = Buffer.from(text, 'utf8')
  const headers: Record<string, string> = {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(body.length),
  }
  if (extraHeaders !== undefined) {
    for (const [key, value] of Object.entries(extraHeaders)) {
      const lower = key.toLowerCase()
      if (PLAIN_RESPONSE_RESERVED.has(lower)) continue
      headers[lower] = value // 门禁给的 content-type 等覆盖默认值（不写重名头）
    }
  }
  headers.connection = 'close'
  let head = `HTTP/1.1 ${String(status)} ${STATUS_CODES[status] ?? 'Error'}\r\n`
  for (const [key, value] of Object.entries(headers)) head += `${key}: ${value}\r\n`
  head += '\r\n'
  try {
    socket.write(head)
    socket.write(body)
    socket.end()
  } catch {
    destroyQuietly(socket)
  }
  // 给 flush 一点时间再断，避免客户端只看到 RST
  setTimeout(() => destroyQuietly(socket), 50).unref()
}

/** 门禁结论的内部归一化形态（`status`/`body` 只在 respond 时有意义）。 */
interface NormalizedGate {
  kind: 'allow' | 'respond'
  status: number
  headers: Record<string, string>
  body: string
  upstreamHeaders: Record<string, string>
}

const RESPOND_DEFAULT_STATUS = 401
const RESPOND_DEFAULT_BODY = 'unauthorized\n'

function collectStringRecord(source: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (source === null || source === undefined || typeof source !== 'object') return out
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    if (typeof value === 'string') out[key.toLowerCase()] = value
  }
  return out
}

function normalizeStatus(value: unknown): number {
  return Number.isInteger(value) && (value as number) >= 100 && (value as number) <= 599
    ? (value as number)
    : RESPOND_DEFAULT_STATUS
}

/**
 * 归一化门禁钩子的返回值：任何不认识的东西 = 拒绝（fail-closed）。
 *
 * 兼容三种写法：布尔、`{ kind: 'allow' | 'respond', … }`（推荐）、
 * 以及早期的 `{ allow: boolean, intercept?: boolean }`（等价于 allow/respond）。
 */
function normalizeDecision(raw: unknown): NormalizedGate {
  const denied: NormalizedGate = {
    kind: 'respond',
    status: RESPOND_DEFAULT_STATUS,
    headers: {},
    body: RESPOND_DEFAULT_BODY,
    upstreamHeaders: {},
  }
  if (raw === true) return { ...denied, kind: 'allow' }
  if (raw === false || raw === undefined || raw === null) return denied
  if (typeof raw !== 'object') return denied
  const value = raw as {
    kind?: unknown
    allow?: unknown
    intercept?: unknown
    status?: unknown
    headers?: unknown
    body?: unknown
    upstreamHeaders?: unknown
  }
  const upstreamHeaders = collectStringRecord(value.upstreamHeaders)
  const allowed = value.kind === 'allow' || (value.kind === undefined && value.allow === true)
  if (allowed) {
    return { ...denied, kind: 'allow', upstreamHeaders }
  }
  return {
    kind: 'respond',
    status: normalizeStatus(value.status),
    headers: collectStringRecord(value.headers),
    body: typeof value.body === 'string' ? value.body : RESPOND_DEFAULT_BODY,
    upstreamHeaders: {},
  }
}

/** 由请求构造门禁输入（对端 IP 必须带上，限速按同 IP 粒度）。 */
function buildAuthorizeInput(req: IncomingMessage): RemoteAuthorizeInput {
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    headers[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value)
  }
  return {
    method: req.method ?? 'GET',
    url: typeof req.url === 'string' && req.url !== '' ? req.url : '/',
    headers,
    remoteAddress: normalizeIp(req.socket?.remoteAddress),
  }
}

/**
 * 起旁挂监听：只 bind `opts.bindAddress`，把 HTTP 与 WebSocket 转发到 `opts.upstream`。
 *
 * 失败一律抛 `RemoteStartError`（调用方 catch 后降级）；**不会**产生未捕获异常，
 * 也不会留下半开的监听（失败路径会 close server 并销毁已接受的 socket）。
 */
export async function startRemoteListener(options: RemoteListenerOptions): Promise<RemoteListenerHandle> {
  if (!options || typeof options !== 'object') {
    throw new RemoteStartError('E_REMOTE_INVALID_OPTIONS', '缺少启动参数')
  }
  const port: unknown = options.port
  if (!Number.isInteger(port) || (port as number) < 0 || (port as number) > 65535) {
    throw new RemoteStartError('E_REMOTE_INVALID_PORT', `监听端口必须是 0..65535 的整数，收到 ${String(port)}`, {
      port: Number.isInteger(port) ? (port as number) : 0,
    })
  }
  const listenPort = port as number
  const bindAddress: unknown = options.bindAddress
  if (!isBindableAddress(bindAddress as string)) {
    throw new RemoteStartError(
      'E_REMOTE_INVALID_ADDRESS',
      `绑定地址必须是具体的 IPv4 或 IPv6 单播地址（排除 127/8、169.254/16、0.0.0.0、::、回环、链路本地、多播）：${describeAddress(bindAddress)}`,
      { address: typeof bindAddress === 'string' ? bindAddress.slice(0, 64) : '', port: listenPort },
    )
  }
  const address = bindAddress as string
  const target = parseUpstream(options.upstream)
  const rewriteRedirects = options.rewriteRedirects !== false
  // 三条独立预算（连接 / 响应头 / 空闲）：见 `RemoteListenerOptions`。旧名 `firstByteTimeoutMs`
  // 与 `responseHeaderTimeoutMs` 等价，前者优先（保持既有调用方语义不变）。
  const responseHeaderTimeoutMs = resolveBudget(
    options.firstByteTimeoutMs ?? options.responseHeaderTimeoutMs,
    DEFAULT_UPSTREAM_RESPONSE_HEADER_TIMEOUT_MS,
  )
  const connectTimeoutMs = resolveBudget(options.connectTimeoutMs, DEFAULT_UPSTREAM_CONNECT_TIMEOUT_MS)
  const idleTimeoutMs = resolveBudget(options.idleTimeoutMs, DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS)
  const maxUpgradeTunnels = resolveBudget(options.maxUpgradeTunnels, DEFAULT_MAX_UPGRADE_TUNNELS)

  // TLS 准入：只认非空 PEM 字符串；缺一即 fail-closed。错误里只写字段名与 errno 码，
  // 绝不回显证书/私钥内容（token hygiene 的同一条纪律也适用于密钥材料）。
  const tlsInput = options.tls
  if (
    tlsInput === null || typeof tlsInput !== 'object' ||
    typeof tlsInput.cert !== 'string' || tlsInput.cert.trim() === '' ||
    typeof tlsInput.key !== 'string' || tlsInput.key.trim() === ''
  ) {
    throw new RemoteStartError(
      'E_REMOTE_TLS_SETUP_FAILED',
      'TLS 证书或私钥缺失，已拒绝启动监听（不会回落明文 HTTP）',
      { address, port: listenPort },
    )
  }
  // 形状检查保证"坏密钥材料"在绑定端口之前就 typed 失败（不依赖 Node 版本何时抛）。
  if (
    !/-----BEGIN CERTIFICATE-----/.test(tlsInput.cert) ||
    !/-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----/.test(tlsInput.key)
  ) {
    throw new RemoteStartError(
      'E_REMOTE_TLS_SETUP_FAILED',
      'TLS 密钥材料格式非法，已拒绝启动监听（不会回落明文 HTTP）',
      { address, port: listenPort },
    )
  }

  const log = (message: string): void => {
    if (typeof options.log !== 'function') return
    try {
      options.log(scrubSecrets(message))
    } catch {
      /* 日志永远不许影响服务 */
    }
  }

  const sockets = new Set<Socket>()
  /**
   * 已建立的实时隧道（客户端 socket ↔ 上游 socket）。
   *
   * 为什么单独登记：客户端 socket 本来就在 `sockets` 里（server 'connection' 时加入），
   * 但**上游** socket 是 `agent:false` 拨出去的另一条连接，server 的集合里没有它。
   * 监听关闭时必须两侧都断，否则会留下半开的上游连接（端口/句柄泄漏）。
   */
  const tunnels = new Set<{ client: Duplex; upstream: Duplex }>()
  let total = 0
  let rejected = 0
  let closed = false
  let lastError: { code: string; message: string } | null = null

  /** 记录运行期失败：只留 errno 码 + 固定短语，绝不带 URL/头/凭据。 */
  const noteFailure = (scope: string, error: unknown): void => {
    const code = codeOf(error)
    lastError = { code, message: `${scope}失败（${code}）` }
    log(`[remote] ${lastError.message}`)
  }

  let server: https.Server
  try {
    // 唯一的服务端构造器：没有 http.createServer()，也就没有明文回落路径。
    // rsa 自签证书由 pairingTls.ts 生成，指纹在配对时固定；这里只做 TLS 终结。
    server = https.createServer({ cert: tlsInput.cert, key: tlsInput.key })
  } catch (error) {
    // 坏密钥材料（PEM 损坏/不匹配/不支持的曲线等）：typed 失败，绝不退化成明文。
    throw new RemoteStartError(
      'E_REMOTE_TLS_SETUP_FAILED',
      `TLS 密钥材料不可用，已拒绝启动监听（${codeOf(error)}）`,
      { address, port: listenPort, detail: codeOf(error) },
    )
  }
  // 长连接（SSE / WebSocket）不能被默认 keep-alive 超时误杀
  server.keepAliveTimeout = 65_000
  server.headersTimeout = 70_000

  /** 释放端口：关 server + 断所有活动 socket（含已升级隧道），幂等。 */
  const shutdown = async (): Promise<void> => {
    if (closed) return
    closed = true
    const drained = new Promise<void>((resolve) => {
      try {
        server.close(() => resolve())
      } catch {
        resolve()
      }
    })
    for (const socket of sockets) destroyQuietly(socket)
    sockets.clear()
    // 实时隧道：两侧都断（上游 socket 不在 sockets 里，必须单独收）
    for (const tunnel of tunnels) {
      destroyQuietly(tunnel.upstream)
      destroyQuietly(tunnel.client)
    }
    tunnels.clear()
    await new Promise<void>((resolve) => {
      // 兜底：close 回调在极端情况下可能不来，2s 后强制返回（socket 已在上面断掉）
      const timer = setTimeout(() => resolve(), 2_000)
      timer.unref()
      let settled = false
      const done = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      }
      drained.then(done, done)
    })
  }

  /**
   * 客户端看到的 authority（**只取请求的 `Host` 头**；云隧道下就是
   * `xxx.trycloudflare.com`）。Host 缺失/为空返回空串 → location 保持原值不改写。
   */
  const externalAuthority = (req: IncomingMessage): string => {
    const host = req.headers.host
    return typeof host === 'string' ? host : ''
  }

  /** HTTP 反向代理：method/path/query/headers/body 透传，状态码/头/正文回传。 */
  const runRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // 门禁可能是异步的：先暂停入站流，避免决策期间把 body 全缓冲进内存
    req.pause()
    try {
      if (closed) {
        rejected += 1
        respondPlain(res, 503, 'remote listener closed\n', true)
        return
      }
      if (typeof options.authorize !== 'function') {
        await forwardRequest(req, res, undefined)
        return
      }
      let gate: NormalizedGate
      try {
        gate = normalizeDecision(await options.authorize(buildAuthorizeInput(req), { res }))
      } catch (error) {
        rejected += 1
        noteFailure('鉴权钩子', error)
        respondPlain(res, 403, 'forbidden\n', true)
        return
      }
      if (gate.kind === 'respond') {
        // 调用方可能已经自己写完了响应（/__dsh_remote/* 自有接口）：不重复写、不转发
        if (res.headersSent || res.writableEnded) return
        if (gate.status >= 400) {
          rejected += 1
          log(`[remote] 拒绝请求：HTTP ${String(gate.status)}`)
        }
        respondPlain(res, gate.status, gate.body, true, gate.headers)
        return
      }
      await forwardRequest(req, res, gate.upstreamHeaders)
    } catch (error) {
      noteFailure('代理请求', error)
      respondPlain(res, 502, 'remote upstream unavailable\n', true)
    }
  }

  /**
   * 读请求体，判断这次请求能不能在 401 后**重放**。
   *
   * - 无 body（无 `content-length`）→ 空 Buffer，可重放；
   * - `content-length` ≤ `REPLAY_BODY_LIMIT` → 缓冲后返回，可重放；
   * - chunked 或超过上限（上传类）→ `body: null`，按流式转发、不重试。
   *
   * **只缓冲请求体，永不缓冲上游响应体**（响应体一律走流式管道）。
   */
  const collectReplayBody = async (
    req: IncomingMessage,
  ): Promise<{ replayable: boolean; body: Buffer | null }> => {
    const encoding = req.headers['transfer-encoding']
    if (typeof encoding === 'string' && encoding !== '') return { replayable: false, body: null }
    const declaredRaw = req.headers['content-length']
    if (declaredRaw === undefined) return { replayable: true, body: Buffer.alloc(0) }
    const declared = Number(declaredRaw)
    if (!Number.isFinite(declared) || declared < 0) return { replayable: false, body: null }
    if (declared === 0) return { replayable: true, body: Buffer.alloc(0) }
    if (declared > REPLAY_BODY_LIMIT) return { replayable: false, body: null }
    const chunks: Buffer[] = []
    let total = 0
    try {
      for await (const chunk of req) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
        chunks.push(buf)
        total += buf.length
        // HTTP 解析器保证不会超过 content-length；真超了只说明连接坏，放弃重试但仍按原样转发
        if (total > declared) return { replayable: false, body: Buffer.concat(chunks) }
      }
    } catch {
      return { replayable: false, body: null }
    }
    return { replayable: total === declared, body: Buffer.concat(chunks) }
  }

  /** 放行之后真正转发（含动态上游头解析 + 三条预算 + 401 换会话重试一次）。 */
  const forwardRequest = async (
    req: IncomingMessage,
    res: ServerResponse,
    gateHeaders: Record<string, string> | undefined,
  ): Promise<void> => {
    let staticHeaders: Record<string, string>
    try {
      staticHeaders = await resolveUpstreamHeaders(target)
    } catch (error) {
      noteFailure('上游头解析', error)
      respondPlain(res, 502, 'remote upstream unavailable\n', true)
      return
    }
    const replay = await collectReplayBody(req)
    const authority = externalAuthority(req)
    const method = req.method ?? 'GET'
    const requestPath = upstreamPath(target.basePath, req.url)
    const baseExtra: Record<string, string> = { ...staticHeaders, ...(gateHeaders ?? {}) }

    /**
     * 派发一次上游请求。`attempt` 只用来把"401 后换身份重试"限制成**恰好一次**。
     */
    const dispatch = (extra: Record<string, string>, attempt: number): void => {
      let upstreamReq: http.ClientRequest
      try {
        upstreamReq = http.request({
          protocol: 'http:',
          hostname: target.hostname,
          port: target.port,
          method,
          path: requestPath,
          headers: outboundHeaders(req, target, extra),
          // agent:false → 每个请求独占一条上游连接，close() 之后不会留下池化 socket
          agent: false,
        })
      } catch (error) {
        noteFailure('代理请求', error)
        respondPlain(res, 502, 'remote upstream unavailable\n', true)
        return
      }

      /** 这次派发是否已有结论（避免超时/错误/应答三个出口各写一次）。 */
      let concluded = false
      let connectTimer: ReturnType<typeof setTimeout> | null = null
      let headerTimer: ReturnType<typeof setTimeout> | null = null
      let idleTimer: ReturnType<typeof setTimeout> | null = null

      const clearTimers = (): void => {
        if (connectTimer !== null) {
          clearTimeout(connectTimer)
          connectTimer = null
        }
        if (headerTimer !== null) {
          clearTimeout(headerTimer)
          headerTimer = null
        }
        if (idleTimer !== null) {
          clearTimeout(idleTimer)
          idleTimer = null
        }
      }

      /** typed 失败收口：标记结论、撤掉所有预算、掐上游、回中文页/typed JSON。 */
      const fail = (code: UpstreamErrorCode): void => {
        if (concluded) return
        concluded = true
        clearTimers()
        destroyQuietly(upstreamReq)
        respondUpstreamFailure(req, res, code)
      }

      // 预算 1/3：**连接预算**（TCP 还没建起来）。'connect' 一到就撤表。
      connectTimer = setTimeout(() => {
        connectTimer = null
        noteFailure('上游连接', { name: 'ETIMEDOUT' })
        fail('E_UPSTREAM_TIMEOUT')
      }, connectTimeoutMs)
      connectTimer.unref()
      upstreamReq.on('socket', (socket) => {
        const onConnect = (): void => {
          if (connectTimer !== null) {
            clearTimeout(connectTimer)
            connectTimer = null
          }
        }
        socket.once('connect', onConnect)
        socket.once('secureConnect', onConnect)
        if (socket.connecting === false) onConnect()
        socket.once('close', onConnect)
      })

      // 预算 2/3：**响应头预算**（上游多久还没开始回话）。'response' 一到就撤表。
      headerTimer = setTimeout(() => {
        headerTimer = null
        noteFailure('上游首字节', { name: 'ETIMEDOUT' })
        fail('E_UPSTREAM_TIMEOUT')
      }, responseHeaderTimeoutMs)
      headerTimer.unref()

      /** 401 后换一次身份再试；换不到 / 再 401 才把失败交给客户端。 */
      const refreshAndRetry = async (): Promise<void> => {
        let fresh: Record<string, string> | null = null
        try {
          fresh = await options.onUpstreamUnauthorized!()
        } catch (error) {
          noteFailure('上游会话刷新', error)
          fresh = null
        }
        if (res.writableEnded || res.headersSent) return
        if (fresh === null || fresh === undefined) {
          noteFailure('上游会话', { name: 'E_UPSTREAM_SESSION' })
          respondUpstreamFailure(req, res, 'E_UPSTREAM_SESSION')
          return
        }
        // 新头覆盖旧的会话头（cookie 在 fresh 里），静态头与门的其它头保留
        dispatch({ ...baseExtra, ...fresh }, attempt + 1)
      }

      /** 响应开始后的**流式**管道：懒发响应头，逐块转发，空闲预算看门。 */
      const pipeUpstream = (up: IncomingMessage): void => {
        let headFlushed = false
        let bodyBytes = 0
        /** 已经用"错误页/typed 应答"替换掉这个响应：此后上游的收尾事件不许再动 res。 */
        let replaced = false
        /** 上游是否因为**客户端背压**被暂停：暂停期间空闲预算挂起（见 `armIdle`）。 */
        let backpressured = false
        /** 开放式流（SSE / multipart 长推流）：静默是正常状态，整个豁免空闲预算。 */
        const openEnded = OPEN_ENDED_STREAM_RE.test(
          typeof up.headers['content-type'] === 'string' ? up.headers['content-type'] : '',
        )

        const flushHead = (): boolean => {
          if (headFlushed) return true
          try {
            res.writeHead(up.statusCode ?? 502, inboundHeaders(up, authority, target.hostname, rewriteRedirects))
          } catch (error) {
            noteFailure('上游应答', error)
            destroyQuietly(up)
            destroyQuietly(upstreamReq)
            respondPlain(res, 502, 'remote upstream unavailable\n', true)
            return false
          }
          headFlushed = true
          return true
        }

        // 预算 3/3：**空闲预算**（响应开始后"两个方向都没有进展"的时长）。
        // 重置点有两处：① 上游 data 块（下行字节）；② `res` 的 `drain`（客户端把积压读走）。
        // 只在 ① 上重置会把"健康但客户端读得慢"的背压误判成停滞：`res.write()` 返回 false
        // 后上游被 `pause()`，本来就不会再有 data 事件。
        // 背压期间预算直接挂起（不重新起表）；开放式流（SSE / multipart）整个不起表。
        const armIdle = (): void => {
          if (openEnded || backpressured || res.writableEnded) return
          if (idleTimer !== null) clearTimeout(idleTimer)
          idleTimer = setTimeout(() => {
            idleTimer = null
            noteFailure('上游空闲', { name: 'E_UPSTREAM_STALLED' })
            if (bodyBytes === 0) {
              // 一个字节都还没回给客户端（响应头也还没出去）：可以干净地换成 504 typed 页。
              // 必须先写应答再掐上游 —— 否则 up 的 'aborted'/'error' 会把刚写的应答一起收掉。
              replaced = true
              respondUpstreamFailure(req, res, 'E_UPSTREAM_STALLED')
              destroyQuietly(up)
              destroyQuietly(upstreamReq)
              return
            }
            // 已经开始回传：只截断，别在半个响应里塞错误页（浏览器/客户端会看到流中断）
            replaced = true
            destroyQuietly(up)
            destroyQuietly(upstreamReq)
            destroyQuietly(res)
          }, idleTimeoutMs)
          idleTimer.unref()
        }
        armIdle()

        up.on('data', (chunk: Buffer) => {
          if (replaced) return
          if (!flushHead()) return
          bodyBytes += chunk.length
          if (!res.write(chunk)) {
            // 客户端读得比上游写得慢：先暂停上游，并**挂起空闲预算** —— 背压不是停滞。
            // （此时上游不再有 data 事件；对端是否还活着由客户端连接自己的生命周期决定，
            //   客户端断开时 `res` 的 'close' 会掐掉上游。）
            up.pause()
            backpressured = true
            if (idleTimer !== null) {
              clearTimeout(idleTimer)
              idleTimer = null
            }
            return
          }
          armIdle()
        })
        res.on('drain', () => {
          if (replaced) return
          // 客户端又读得动了：这属于"客户端侧进展"，预算重新起表后再恢复上游。
          backpressured = false
          armIdle()
          up.resume()
        })
        up.on('end', () => {
          if (idleTimer !== null) {
            clearTimeout(idleTimer)
            idleTimer = null
          }
          if (replaced) return
          if (!flushHead()) return
          res.end()
        })
        up.on('error', () => {
          if (idleTimer !== null) {
            clearTimeout(idleTimer)
            idleTimer = null
          }
          if (replaced) return
          destroyQuietly(res)
        })
        up.on('aborted', () => {
          if (replaced) return
          destroyQuietly(res)
        })
        up.on('close', () => {
          if (idleTimer !== null) {
            clearTimeout(idleTimer)
            idleTimer = null
          }
        })
      }

      upstreamReq.on('response', (up) => {
        if (headerTimer !== null) {
          clearTimeout(headerTimer)
          headerTimer = null
        }
        if (concluded) {
          destroyQuietly(up)
          return
        }
        if (closed) {
          concluded = true
          clearTimers()
          destroyQuietly(up)
          destroyQuietly(upstreamReq)
          rejected += 1
          respondPlain(res, 503, 'remote listener closed\n', true)
          return
        }
        const status = up.statusCode ?? 502
        if (status === 401) {
          // U1：上游 401 = 本机注入的会话失效。DSH 的 admit() 在 RPC handler 之前就拒绝
          // （rpc-host.ts:129-137），这次请求没有副作用 ⇒ 换一次身份后**只重试一次**。
          concluded = true
          clearTimers()
          try {
            up.resume() // 丢掉 401 的正文，避免占住连接
          } catch {
            /* ignore */
          }
          destroyQuietly(upstreamReq)
          if (attempt === 0 && replay.replayable && typeof options.onUpstreamUnauthorized === 'function') {
            void refreshAndRetry()
            return
          }
          noteFailure('上游会话', { name: 'E_UPSTREAM_SESSION' })
          respondUpstreamFailure(req, res, 'E_UPSTREAM_SESSION')
          return
        }
        concluded = true
        pipeUpstream(up)
      })

      upstreamReq.on('error', (error) => {
        if (concluded) return
        noteFailure('代理请求', error)
        if (isUpstreamProtocolError(error)) {
          // 上游回的东西不是合法 HTTP（HPE_* 解析错误）：502 typed，保留原文排查用
          fail('E_UPSTREAM_PROTOCOL')
          return
        }
        if (isUpstreamDownError(error)) {
          fail('E_UPSTREAM_DOWN')
          return
        }
        concluded = true
        clearTimers()
        respondPlain(res, 502, 'remote upstream unavailable\n', true)
      })

      // 客户端先断（关页面/关 App）→ 立刻掐掉上游，避免悬挂连接
      res.on('close', () => {
        clearTimers()
        if (!res.writableFinished) destroyQuietly(upstreamReq)
      })
      req.on('error', () => destroyQuietly(upstreamReq))

      if (replay.body === null) {
        req.pipe(upstreamReq)
      } else {
        upstreamReq.end(replay.body)
      }
    }

    dispatch(baseExtra, 0)
  }

  /**
   * WebSocket（以及任何 Upgrade 协议）隧道：
   * 用 `http.request({ headers: { Connection: 'Upgrade', Upgrade: … } })` 打到上游，
   * 等到 `upgrade` 事件拿到上游 socket，再把 101 原样回给客户端并双向 pipe 原始字节。
   */
  const runUpgrade = async (req: IncomingMessage, rawSocket: Duplex, head: Buffer): Promise<void> => {
    const socket = rawSocket
    socket.pause()
    if (closed) {
      rejected += 1
      destroyQuietly(socket)
      return
    }
    let upstreamHeaders: Record<string, string> = {}
    if (typeof options.authorize === 'function') {
      let gate: NormalizedGate
      try {
        gate = normalizeDecision(await options.authorize(buildAuthorizeInput(req), { socket }))
      } catch (error) {
        rejected += 1
        noteFailure('鉴权钩子', error)
        writeRawResponse(socket, 403, 'forbidden\n')
        return
      }
      if (gate.kind === 'respond') {
        // WS 握手必须被门禁挡住：回最小应答后立刻断开，**绝不**建上游隧道
        if (gate.status >= 400) {
          rejected += 1
          log(`[remote] 拒绝升级请求：HTTP ${String(gate.status)}`)
        }
        writeRawResponse(socket, gate.status, gate.body, gate.headers)
        return
      }
      upstreamHeaders = gate.upstreamHeaders
    }
    let staticHeaders: Record<string, string>
    try {
      staticHeaders = await resolveUpstreamHeaders(target)
    } catch (error) {
      noteFailure('上游头解析', error)
      writeRawResponse(socket, 502, 'remote upstream unavailable\n')
      return
    }
    // S3：并发隧道上限。每条 WS 占一条独立上游连接，不封顶就能被一个页面吃光；
    // 到顶后明确拒绝（503 + typed JSON），并计入 rejected —— 不是静默丢弃。
    if (tunnels.size >= maxUpgradeTunnels) {
      rejected += 1
      log(`[remote] 拒绝升级请求：实时隧道已达上限 ${String(maxUpgradeTunnels)}`)
      writeRawResponse(socket, 503, UPSTREAM_ERROR_BODIES.E_UPGRADE_TUNNELS_FULL, {
        'content-type': 'application/json; charset=utf-8',
      })
      return
    }
    const extra: Record<string, string> = { ...staticHeaders, ...upstreamHeaders }
    const upgradeValue = req.headers.upgrade
    const headers = outboundHeaders(req, target, extra)
    headers.connection = 'Upgrade'
    headers.upgrade = typeof upgradeValue === 'string' && upgradeValue !== '' ? upgradeValue : 'websocket'

    let upstreamReq: http.ClientRequest
    try {
      upstreamReq = http.request({
        protocol: 'http:',
        hostname: target.hostname,
        port: target.port,
        method: req.method ?? 'GET',
        path: upstreamPath(target.basePath, req.url),
        headers,
        agent: false,
      })
    } catch (error) {
      noteFailure('升级握手', error)
      writeRawResponse(socket, 502, 'remote upstream unavailable\n')
      return
    }
    // 握手兜底超时：上游既不升级也不应答时，不让 socket 无限挂着
    upstreamReq.setTimeout(15_000, () => {
      upstreamReq.destroy(new Error('upgrade handshake timeout'))
    })
    upstreamReq.on('upgrade', (upRes, rawUpSocket, upHead) => {
      const upSocket = rawUpSocket as Duplex
      enableNoDelay(socket)
      enableNoDelay(upSocket)
      // 1) 先回 101（原样字节，保留 Sec-WebSocket-Accept 等）
      try {
        socket.write(serializeResponseHead(upRes))
      } catch {
        destroyQuietly(upSocket)
        destroyQuietly(socket)
        return
      }
      // 2) 握手期已读到的残留字节：上游→客户端 与 客户端→上游 各自先冲出去
      if (upHead !== undefined && upHead.length > 0) {
        try {
          socket.write(upHead)
        } catch {
          destroyQuietly(upSocket)
          destroyQuietly(socket)
          return
        }
      }
      if (head !== undefined && head.length > 0) {
        try {
          upSocket.write(head)
        } catch {
          destroyQuietly(upSocket)
          destroyQuietly(socket)
          return
        }
      }
      // 3) 双向裸字节隧道 + 登记（监听 close 时两侧要一起断）
      const tunnel = { client: socket, upstream: upSocket }
      tunnels.add(tunnel)
      socket.pipe(upSocket)
      upSocket.pipe(socket)
      socket.resume()
      // 4) 任一侧结束/错误/关闭 → 两侧都销毁，避免半开连接与端口残留。
      //
      // **必须同时监听 'end'**：server 侧 upgrade socket 的 `allowHalfOpen` 是 true，
      // 对端发 FIN 时只会得到 'end'，'close' 要等本端也结束才来。只听 'close' 的话，
      // 平板关页面后上游那条连接会一直半开着（S3 要求：不存在半开隧道）。
      const teardown = (): void => {
        tunnels.delete(tunnel)
        destroyQuietly(upSocket)
        destroyQuietly(socket)
      }
      upSocket.on('error', teardown)
      socket.on('error', teardown)
      upSocket.on('end', teardown)
      socket.on('end', teardown)
      upSocket.on('close', teardown)
      socket.on('close', teardown)
    })
    // 上游没同意升级（200/4xx…）：fail-closed，不把 body 当隧道数据转发
    upstreamReq.on('response', (upRes) => {
      noteFailure('升级握手', { name: `HTTP_${String(upRes.statusCode)}` })
      try {
        upRes.resume()
      } catch {
        /* ignore */
      }
      writeRawResponse(socket, 502, 'remote upstream refused upgrade\n')
    })
    upstreamReq.on('error', (error) => {
      noteFailure('升级握手', error)
      writeRawResponse(socket, 502, 'remote upstream unavailable\n')
    })
    socket.on('error', () => {
      destroyQuietly(upstreamReq)
    })
    upstreamReq.end()
  }

  server.on('request', (req, res) => {
    void runRequest(req, res).catch(() => {
      destroyQuietly(res)
    })
  })
  server.on('upgrade', (req, socket, head) => {
    const stream = socket as unknown as Duplex
    void runUpgrade(req, stream, head).catch(() => {
      destroyQuietly(stream)
    })
  })
  server.on('connection', (socket: Socket) => {
    total += 1
    sockets.add(socket)
    enableNoDelay(socket)
    // 审计钩子：只交脱敏所需的原始 IP + 时刻；任何 token / 请求内容都不经此路。
    if (options.onConnect !== undefined) {
      try {
        options.onConnect({ at: new Date().toISOString(), remoteAddress: normalizeIp(socket.remoteAddress) })
      } catch {
        /* 审计失败绝不影响监听本身 */
      }
    }
    socket.on('close', () => {
      sockets.delete(socket)
    })
  })
  server.on('clientError', (_error, socket) => {
    const stream = socket as unknown as Duplex
    try {
      stream.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n')
    } catch {
      destroyQuietly(stream)
    }
  })

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException): void => {
        server.removeListener('listening', onListening)
        reject(
          new RemoteStartError(
            'E_REMOTE_BIND_FAILED',
            `监听 ${address}:${String(listenPort)} 失败：${codeOf(error)}`,
            { address, port: listenPort, detail: codeOf(error) },
          ),
        )
      }
      const onListening = (): void => {
        server.removeListener('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      try {
        server.listen(listenPort, address)
      } catch (error) {
        server.removeListener('error', onError)
        server.removeListener('listening', onListening)
        reject(
          new RemoteStartError(
            'E_REMOTE_BIND_FAILED',
            `监听 ${address}:${String(listenPort)} 失败：${codeOf(error)}`,
            { address, port: listenPort, detail: codeOf(error) },
          ),
        )
      }
    })
  } catch (error) {
    await shutdown() // 不留半开监听
    throw error
  }

  const bound = server.address()
  if (bound === null || typeof bound === 'string') {
    await shutdown()
    throw new RemoteStartError('E_REMOTE_BIND_FAILED', `监听 ${address}:${String(listenPort)} 未返回具体地址`, {
      address,
      port: listenPort,
    })
  }
  const info = bound as AddressInfo
  // 监听成功之后的运行时错误只记日志（不能让进程因未处理 'error' 崩溃）
  server.on('error', (error: NodeJS.ErrnoException) => {
    noteFailure(`监听 ${address}:${String(info.port)}`, error)
  })

  return {
    port: info.port,
    address: info.address,
    close: shutdown,
    stats: () => ({ active: sockets.size, total, rejected }),
    get lastError() {
      return lastError
    },
  }
}
