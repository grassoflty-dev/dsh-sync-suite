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
 */
import os from 'node:os'
import { RemoteStore } from './store.js'
import { createRemoteAuthorizer } from './routes.js'
import type { RemoteAuthorizeInput, RemoteAuthorizeResult, RemoteGate } from './routes.js'
import { defaultRemoteSettings, listModes, normalizeRemoteSettings } from './accessMode.js'
import { maskToken, urlForMode, withToken } from './urls.js'
import type {
  LanCandidate,
  RemoteAccessMode,
  RemoteLink,
  RemoteProbeResult,
  RemoteServiceLike,
  RemoteSettings,
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
  authorize?: (input: RemoteAuthorizeInput) => RemoteAuthorizeResult
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
  /** 上游身份后台刷新间隔（毫秒，默认 6 小时）。 */
  upstreamRefreshMs?: number
  now?: () => Date
  /** 上游身份换取超时（毫秒，默认 3000）。 */
  upstreamTimeoutMs?: number
}

export const REMOTE_SESSION_COOKIE = 'dsh-remote-session'

const DEFAULT_PORT_CANDIDATE = 0

interface RuntimeState {
  handle: RemoteListenerHandle | null
  startedAt: string | null
  lastError: { code: string; message: string } | null
  probe: RemoteProbeResult | null
  rejected: number
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

/** 网卡枚举：虚拟网卡（Hyper-V/VMware/WSL/容器/Teredo）在自动挑选时跳过。 */
const VIRTUAL_IFACE_RE = /(vEthernet|VMware|VirtualBox|Hyper-V|Loopback|Teredo|isatap|docker|veth|br-|WSL|Tailscale)/i

export function listLanCandidates(): LanCandidate[] {
  const out: LanCandidate[] = []
  let table: NodeJS.Dict<os.NetworkInterfaceInfo[]>
  try {
    table = os.networkInterfaces()
  } catch {
    return out
  }
  for (const [name, infos] of Object.entries(table)) {
    if (infos === undefined) continue
    for (const info of infos) {
      if (info.internal) continue
      const family = info.family === 'IPv4' ? 'IPv4' : 'IPv6'
      out.push({ address: info.address, iface: name, family, virtual: VIRTUAL_IFACE_RE.test(name) })
    }
  }
  return out
}

/** 优先挑真实（非虚拟）IPv4；私网段优先，其余兜底。没有就返回 null（不许回落 0.0.0.0）。 */
export function pickLanAddress(candidates: LanCandidate[]): string | null {
  const v4 = candidates.filter((item) => item.family === 'IPv4' && !item.virtual)
  const preferred = v4.filter((item) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(item.address))
  const chosen = preferred[0] ?? v4[0]
  return chosen === undefined ? null : chosen.address
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
  const runtime: RuntimeState = { handle: null, startedAt: null, lastError: null, probe: null, rejected: 0 }
  let upstream: UpstreamIdentity | null = null
  let starting = false
  let refreshTimer: ReturnType<typeof setInterval> | null = null

  function readSettings(): RemoteSettings {
    const raw = store.readRawSettings()
    const base = defaultRemoteSettings()
    if (raw === null) return base
    try {
      return normalizeRemoteSettings(raw, base)
    } catch {
      // 手工改坏的文件当作默认值：远程访问起不来，不影响配置同步。
      return base
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

  /** 当前方式下应当绑定的**具体**地址；返回 null 表示"这种方式不需要/不能起监听"。 */
  function resolveBindAddress(mode: RemoteAccessMode, settings: RemoteSettings): { ok: boolean; address: string; reason: string } {
    if (mode === 'lan') {
      const explicit = settings.lanAddress.trim()
      if (explicit !== '') {
        if (!isIPv4(explicit) || explicit === '0.0.0.0' || /^127\./.test(explicit)) {
          return { ok: false, address: '', reason: '局域网地址必须是具体的私网 IPv4（不能是 0.0.0.0 或 127.x）' }
        }
        return { ok: true, address: explicit, reason: '' }
      }
      const picked = pickLanAddress(listLanCandidates())
      if (picked === null) return { ok: false, address: '', reason: '没找到可用的局域网 IPv4，请先连上 Wi-Fi 或手动填地址' }
      return { ok: true, address: picked, reason: '' }
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
      const explicit = settings.lanAddress.trim()
      if (explicit !== '') {
        if (!isIPv4(explicit) || explicit === '0.0.0.0' || /^127\./.test(explicit)) {
          return { ok: false, address: '', reason: '局域网地址必须是具体的私网 IPv4（不能是 0.0.0.0 或 127.x）' }
        }
        return { ok: true, address: explicit, reason: '' }
      }
      const picked = pickLanAddress(listLanCandidates())
      if (picked === null) return { ok: false, address: '', reason: '没找到可用的局域网 IPv4，隧道客户端无法回源' }
      return { ok: true, address: picked, reason: '' }
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

  async function upstreamCookie(): Promise<string | null> {
    const current = upstream
    if (current !== null && current.expiresAt > now().getTime()) return current.cookie
    const refreshed = await refreshUpstreamIdentity()
    upstream = refreshed
    return refreshed === null ? null : refreshed.cookie
  }

  function status(): RemoteStatus {
    const settings = readSettings()
    const tokenRecord = store.readToken()
    const handle = runtime.handle
    const stats = handle === null ? { active: 0, total: 0, rejected: 0 } : handle.stats()
    const token = readTokenValue()
    const urls = []
    const built = urlForMode(settings.mode, settings, { lanAddress: pickLanAddress(listLanCandidates()), dshPort: dshPort() ?? 0 })
    if (built.ok) {
      urls.push({ mode: settings.mode, url: redactUrlForDisplay(built.url), label: labelOfMode(settings.mode), note: '', withToken: false })
    }
    return {
      running: handle !== null,
      listen: handle === null ? null : `${handle.address}:${String(handle.port)}`,
      boundAddress: handle === null ? null : handle.address,
      port: handle === null ? (settings.port > 0 ? settings.port : dshPort() ?? 0) : handle.port,
      startedAt: runtime.startedAt,
      lastError: runtime.lastError,
      connections: { active: stats.active, total: stats.total },
      rejected: runtime.rejected + stats.rejected,
      token: { exists: token !== null, masked: token === null ? '' : maskToken(token), createdAt: tokenRecord?.createdAt ?? null },
      urls,
      probe: runtime.probe,
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
          upstreamCookie: () => (upstream === null || upstream.expiresAt <= now().getTime() ? null : upstream.cookie),
          sessionCookieName,
        })

  async function stop(): Promise<RemoteStatus> {
    const handle = runtime.handle
    runtime.handle = null
    runtime.startedAt = null
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
    return status()
  }

  async function start(): Promise<RemoteStatus> {
    if (starting) return status()
    if (runtime.handle !== null) return status()
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
      const bind = resolveBindAddress(settings.mode, settings)
      if (!bind.ok) {
        runtime.lastError = { code: 'E_NO_BIND_ADDRESS', message: bind.reason }
        return status()
      }
      const listenPort = settings.port > 0 ? settings.port : port
      let handle: RemoteListenerHandle
      try {
        handle = await options.startListener({
          port: listenPort,
          bindAddress: bind.address,
          upstream: { baseUrl: `http://127.0.0.1:${String(port)}` },
          authorize: authorizer,
        })
      } catch (error) {
        runtime.lastError = { code: 'E_LISTEN_FAILED', message: `监听启动失败：${safeMessage(error)}` }
        return status()
      }
      runtime.handle = handle
      runtime.startedAt = now().toISOString()
      runtime.lastError = null
      // 上游会话 cookie 有 TTL：后台定期刷新，避免"某天突然全 401"。
      if (refreshTimer !== null) clearInterval(refreshTimer)
      const interval = options.upstreamRefreshMs ?? 6 * 60 * 60 * 1000
      refreshTimer = setInterval(() => {
        void refreshUpstreamIdentity().then((fresh) => {
          if (fresh !== null) upstream = fresh
        })
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

  async function getState(): Promise<RemoteStateData> {
    const settings = readSettings()
    // 开关是"下次启动 DSH 时是否自动起监听"，不在这里隐式拉起，避免 UI 刷新触发网络动作。
    if (settings.enabled && runtime.handle === null) {
      // no-op：自动启动由 index.ts 在插件挂载时调用一次 start()
    }
    return { settings, status: status(), modes: listModes() }
  }

  async function saveSettings(input: unknown): Promise<RemoteStateData> {
    const previous = readSettings()
    const raw = input !== null && typeof input === 'object' ? input : {}
    const next = normalizeRemoteSettings(raw, previous)
    store.writeSettings(next)
    // 换方式/换端口：先停掉旧监听，避免出现"状态显示 A、实际监听 B"。
    const modeChanged = next.mode !== previous.mode || next.port !== previous.port || next.lanAddress !== previous.lanAddress
    if (modeChanged && runtime.handle !== null) await stop()
    if (modeChanged) runtime.probe = null
    if (next.enabled && runtime.handle === null) await start()
    return { settings: next, status: status(), modes: listModes() }
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

  async function showLink(mode?: RemoteAccessMode): Promise<RemoteLink> {
    const settings = readSettings()
    const target = mode ?? settings.mode
    const token = readTokenValue()
    if (token === null) throw new Error('还没有访问令牌，请先生成')
    const built = urlForMode(target, settings, { lanAddress: pickLanAddress(listLanCandidates()), dshPort: dshPort() ?? 0 })
    if (!built.ok) throw new Error(built.reason === '' ? '这种方式暂时生成不出可用地址' : built.reason)
    const url = withToken(built.url, token)
    const qr = options.encodeQr === undefined ? { size: 0, modules: [] as boolean[][] } : options.encodeQr(url)
    return { url, qr, note: '' }
  }

  function detectLan(): LanCandidate[] {
    return listLanCandidates()
  }

  async function dispose(): Promise<void> {
    await stop().catch(() => undefined)
  }

  return { getState, saveSettings, start, stop, rotateToken, probe, showLink, detectLan, dispose, paths: { configFile: store.configFile, tokenFile: store.tokenFile } }
}

/** 默认令牌长度（字节）——与 `auth.ts` 的 `crypto.randomBytes(32)` 对齐。 */
export const REMOTE_TOKEN_BYTES = 32

/** 默认端口候选（0 = 跟随 DSH 端口）。 */
export const REMOTE_DEFAULT_PORT = DEFAULT_PORT_CANDIDATE
