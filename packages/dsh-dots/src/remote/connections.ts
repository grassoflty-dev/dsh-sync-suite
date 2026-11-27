/**
 * mod-plugin-remote-live-connections：「当前连接」的**纯模型**（无 I/O、无 console）。
 *
 * 它取代面板上「谁连进来过」的历史审计视图：只回答"此刻谁还在"，不记日志、不落盘。
 * 全部时间都从注入的 `clock()` 取（测试零时钟依赖），对外只吐可上屏的安全字段：
 *   · `peer` 只可能是规范化后的 IP 字面量或 `已脱敏`，没有端口 / 路径 / 查询串 / token；
 *   · `transport` 复用 `pairingTransport.transportOfBoundAddress` 的既有分类，不另写一套正则；
 *   · `since` / `lastSeen` 是 ISO 时间，不含任何请求内容。
 *
 * 去重（防刷屏）：同一个对端在窗口内的 N 次 HTTP 请求（平板一次开页会突发加载大量静态资源）
 * 只映射到**一条**记录，`id` 不变；只有首次请求决定 `since`。WebSocket 隧道按对端登记一条，
 * 存活期间即使还有 HTTP 请求也保持 `kind: 'tunnel'`，并在面板标记「正在查看」。
 *
 * 存活判据：`openTunnels > 0 || now - lastSeen <= windowMs`，但由本模型统一收口：
 * **一个条目绝不可能在它的 socket 已关闭时还以「正在查看」身份被列出**——隧道租约
 * 归零后要么在下一次推进/读视图被剪掉，要么（仅当窗口内还有 HTTP 证据时）降级为
 * `http`；未转正的预约超过租约也会被模型自行收口，不依赖调用方记得 close。
 * 静默消失（休眠 / Wi-Fi 掉线）的对端同样在下次读视图时按窗口剪掉，绝不留下僵死行。
 */
import { isIPv6 } from 'node:net'
import { transportOfBoundAddress } from './pairingTransport.js'

/** 给面板直接显示的传输分类（复用既有分类结果，只做一次枚举到中文标签的映射）。 */
export type LiveTransport = '局域网' | 'Tailscale' | 'IPv6' | '未知'
export type LiveConnectionKind = 'http' | 'tunnel'

/** 一条当前连接；字段全是面板可安全渲染的值。 */
export interface LiveConnection {
  /** 同一对端存活期内稳定的 id（新的一次出现才换号）。 */
  id: string
  /** 规范化后的对端 IP（或 `已脱敏`）；绝不端口 / URL / 查询串。 */
  peer: string
  transport: LiveTransport
  kind: LiveConnectionKind
  /** 首次出现时刻（ISO）。 */
  since: string
  /** 最近一次活动时刻（ISO）。 */
  lastSeen: string
}

/** 状态视图：`connections` 已按 cap 截断，`count` 是截断前的真实总数（用于「还有 N 个」）。 */
export interface LiveConnectionView {
  connections: LiveConnection[]
  count: number
}

/**
 * 窗口 N = 15 秒（设计取值，仓库内没有对突发静默期做过独立测量）。
 *
 * 用途：浏览器/平板加载一页会并发抓 JS、CSS、字体、图标等；窗口要长到能把这次突发折叠成
 * "一个正在看面板的对端"，又要短到休眠 / Wi-Fi 掉线后面板不再说它"在线"。
 * HTTP 请求是"最近活动"的证据，不是长连接；窗口就是它的存活期。
 */
export const LIVE_CONNECTION_WINDOW_MS = 15_000
/**
 * 面板最多显示 5 行——这是**显示**上限，不是内存条目上限：
 * 内存条目随窗口内不同对端数增长，隧道条目另受 `maxUpgradeTunnels`（默认 16）约束。
 */
export const LIVE_CONNECTION_CAP = 5
/** 预约隧道的租约期；超时未拿到 101 就由模型自行收口，量级与握手兜底一致。 */
export const LIVE_TUNNEL_LEASE_MS = 15_000

export interface LiveConnectionsOptions {
  /** 窗口长度（毫秒）；缺省 15 秒。 */
  windowMs?: number
  /** 面板行数上限；缺省 5。 */
  cap?: number
  /** 注入的时钟（返回 epoch 毫秒）；缺省 `Date.now`。 */
  clock?: () => number
}

export interface LiveConnections {
  readonly windowMs: number
  readonly cap: number
  /** 记一次活动；同对端在窗口内复用同一条记录与 id。 */
  touch(peer: string, kind: LiveConnectionKind): LiveConnection
  /** 拿到上游 101：确认 socket 确实开着，撤销未转正租约的自动收口。 */
  confirm(id: string): void
  /**
   * 隧道收口（幂等）：多条隧道时先递减；最后一条关闭则标记退役或在有 HTTP 证据时降级，
   * 真正的删除只发生在下一次推进/读视图的 `prune`。
   */
  close(id: string): void
  /** 读视图：先按租约/窗口剪枝，再按首次出现时间倒序 + cap 截断。 */
  view(): LiveConnectionView
  /** 清空（停止监听时调用；空视图由此可以保证）。 */
  clear(): void
}

/** 只收 IP 字面量；任何端口、方括号、zone、路径、查询串、凭据都不可能通过这里。 */
function sanitizePeer(raw: string | undefined): string {
  if (typeof raw !== 'string') return '已脱敏'
  let text = raw.trim()
  if (text.toLowerCase().startsWith('::ffff:')) text = text.slice(7)
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1)
  const zone = text.indexOf('%')
  if (zone >= 0) text = text.slice(0, zone)
  if (isIPv6(text)) return text.toLowerCase()
  const parts = text.split('.')
  if (parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) {
    return text
  }
  return '已脱敏'
}

/** 复用既有分类（100.64/10 → Tailscale、RFC1918 → 局域网、冒号 → IPv6），只翻译成中文标签。 */
function transportLabelOf(peer: string): LiveTransport {
  const kind = transportOfBoundAddress(peer)
  if (kind === 'tailscale') return 'Tailscale'
  if (kind === 'lan') return '局域网'
  if (kind === 'ipv6') return 'IPv6'
  return '未知'
}

interface Entry {
  id: string
  peer: string
  transport: LiveTransport
  kind: LiveConnectionKind
  sinceMs: number
  lastSeenMs: number
  /** 只由 HTTP 请求刷新：判断隧道关闭时该对端是否仍有窗口内的活着证据。 */
  lastHttpMs: number
  openTunnels: number
  /** true = 已收到上游 101、socket 确实开着；false = 只有预约，尚未转正。 */
  confirmed: boolean
  /** 未转正隧道的租约截止时刻；超时由模型自行收口，不依赖调用方记得 close。 */
  leaseExpiresMs: number
  /** 全部隧道租约已归还、等待下一次推进/读视图剪掉。删除只此一个入口。 */
  retired: boolean
}

/**
 * 纯模型工厂：所有时间来自 clock，所有剪枝发生在 `prune`（touch / view 都先走它）。
 *
 * 不变式（结构性保证，不靠每个调用方记得收口）：
 *   1. 只有 `confirmed` 的隧道或窗口内 HTTP 证据能上屏；socket 已关闭的隧道条目
 *      绝不会以 `kind:'tunnel'` 继续列出——它要么被剪掉，要么降级为 `http`。
 *   2. `openTunnels` 归零的隧道条目在**下一次**推进/读视图必定被 `prune` 处理掉；
 *      未转正的预约即使没有调用方 close，租约到期也会被 `prune` 归零并退役。
 */
export function createLiveConnections(options: LiveConnectionsOptions = {}): LiveConnections {
  const windowMs =
    typeof options.windowMs === 'number' && Number.isFinite(options.windowMs) && options.windowMs > 0
      ? options.windowMs
      : LIVE_CONNECTION_WINDOW_MS
  const cap =
    typeof options.cap === 'number' && Number.isInteger(options.cap) && options.cap > 0
      ? options.cap
      : LIVE_CONNECTION_CAP
  const clock = typeof options.clock === 'function' ? options.clock : Date.now
  let seq = 0
  let entries: Entry[] = []

  const prune = (now: number): void => {
    for (const entry of entries) {
      // 未转正的预约超过租约即自动归零退役：幽灵行不能靠"没人记得 close"永久存活。
      if (entry.kind === 'tunnel' && !entry.confirmed && entry.openTunnels > 0 && now > entry.leaseExpiresMs) {
        entry.openTunnels = 0
        entry.retired = true
      }
    }
    // 唯一删除入口：退役条目 + 窗口外 HTTP 条目 + 隧道归零且窗口外条目。
    entries = entries.filter((entry) => {
      if (entry.retired) return false
      if (entry.kind === 'tunnel') return entry.openTunnels > 0 || now - entry.lastSeenMs <= windowMs
      return now - entry.lastSeenMs <= windowMs
    })
  }
  const present = (entry: Entry): LiveConnection => ({
    id: entry.id,
    peer: entry.peer,
    transport: entry.transport,
    kind: entry.kind,
    since: new Date(entry.sinceMs).toISOString(),
    lastSeen: new Date(entry.lastSeenMs).toISOString(),
  })

  return {
    windowMs,
    cap,
    touch(peerInput, kind) {
      const now = clock()
      prune(now)
      const peer = sanitizePeer(peerInput)
      const found = entries.find((entry) => entry.peer === peer)
      if (found !== undefined) {
        found.lastSeenMs = now
        if (kind === 'http') {
          found.lastHttpMs = now
          // 窗口内的 HTTP 证据让尚未转正的预约再活一个租约期；不会把隧道降级。
          if (!found.confirmed) found.leaseExpiresMs = now + LIVE_TUNNEL_LEASE_MS
          if (found.openTunnels === 0) found.kind = 'http'
        } else {
          found.kind = 'tunnel'
          found.openTunnels += 1
          if (!found.confirmed) found.leaseExpiresMs = now + LIVE_TUNNEL_LEASE_MS
        }
        return present(found)
      }
      const entry: Entry = {
        id: `lc-${String(++seq)}`,
        peer,
        transport: transportLabelOf(peer),
        kind,
        sinceMs: now,
        lastSeenMs: now,
        lastHttpMs: kind === 'http' ? now : Number.NEGATIVE_INFINITY,
        openTunnels: kind === 'tunnel' ? 1 : 0,
        confirmed: false,
        leaseExpiresMs: kind === 'tunnel' ? now + LIVE_TUNNEL_LEASE_MS : 0,
        retired: false,
      }
      entries.push(entry)
      return present(entry)
    },
    confirm(id) {
      const found = entries.find((entry) => entry.id === id && entry.kind === 'tunnel' && entry.openTunnels > 0)
      if (found === undefined) return
      // 101 已到手：socket 确实开着，撤销自动收口，隧道可长期保活直到 close。
      found.confirmed = true
      found.leaseExpiresMs = Number.POSITIVE_INFINITY
      found.lastSeenMs = clock()
    },
    close(id) {
      const found = entries.find((entry) => entry.id === id && !entry.retired)
      if (found === undefined) return
      if (found.openTunnels > 1) {
        found.openTunnels -= 1
        found.lastSeenMs = clock()
        return
      }
      if (found.openTunnels === 0) return // 已收口：幂等
      const now = clock()
      found.openTunnels = 0
      found.confirmed = false
      found.leaseExpiresMs = 0
      found.lastSeenMs = now
      if (now - found.lastHttpMs <= windowMs) {
        // 隧道期间仍有 HTTP 活动：降级为 http 保留到窗口到期，不抹掉活跃对端。
        found.kind = 'http'
        return
      }
      // 不在此直接删；只标记退役，由下一次 advance / view 的 prune 统一剪掉。
      found.retired = true
    },
    view() {
      const now = clock()
      prune(now)
      const ordered = [...entries].sort(
        (a, b) => b.sinceMs - a.sinceMs || b.lastSeenMs - a.lastSeenMs || Number(b.id.slice(3)) - Number(a.id.slice(3)),
      )
      return { connections: ordered.slice(0, cap).map(present), count: ordered.length }
    },
    clear() {
      entries = []
    },
  }
}
