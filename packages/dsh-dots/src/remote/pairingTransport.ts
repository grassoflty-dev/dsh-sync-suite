/**
 * mod-plugin-pairing：传输**自动选择**与可解释的 `{available, reason}`。
 *
 * 优先级固定 `Tailscale(100.64/10) > 局域网(RFC1918) > 公网 IPv6`，由注入的网卡 seam 判断，
 * 不联网、不猜。用户可在设置里手动覆盖；覆盖项不可用时**回落到自动选择**（绝不给出死地址）。
 *
 * 三条给人看的理由同时回答了用户的两个疑问：
 *   - Tailscale：平板要加入同一 tailnet（用户已确认平板能加入，这是真实传输）；
 *   - 局域网：同一 Wi-Fi **也要端口和令牌**——端口与令牌都在二维码里，用户不用手输；
 *     令牌正是阻止同一网络里其他人控制这台 DSH 的那道门；
 *   - IPv6：本机得有 IPv6，且部分运营商屏蔽入站，所以排在最后。
 */
import os from 'node:os'
import type { PairingTransport } from './pairingPayload.js'

/** 网卡 seam：测试注入假网卡，生产用 `os.networkInterfaces()`。 */
export interface NetworkInterfaceLike {
  name: string
  family: 'IPv4' | 'IPv6'
  address: string
  internal?: boolean
  virtual?: boolean
}

export interface InterfaceSeam {
  interfaces(): NetworkInterfaceLike[]
}

const VIRTUAL_IFACE_RE = /(vEthernet|VMware|VirtualBox|Hyper-V|Loopback|Teredo|isatap|docker|veth|br-|WSL)/i
const TAILSCALE_RE = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./
const RFC1918_RE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/

export const defaultInterfaceSeam: InterfaceSeam = {
  interfaces() {
    const out: NetworkInterfaceLike[] = []
    let table: NodeJS.Dict<os.NetworkInterfaceInfo[]>
    try {
      table = os.networkInterfaces()
    } catch {
      return out
    }
    for (const [name, infos] of Object.entries(table)) {
      if (infos === undefined) continue
      for (const info of infos) {
        out.push({
          name,
          family: info.family === 'IPv4' ? 'IPv4' : 'IPv6',
          address: info.address,
          internal: info.internal,
          virtual: VIRTUAL_IFACE_RE.test(name),
        })
      }
    }
    return out
  },
}

/** 中文文案集中一处：UI / 文档 / 测试同一事实来源。 */
export const TRANSPORT_REASON_COPY = {
  tailscaleOff: 'Tailscale：平板需加入同一 tailnet',
  lanOff: '局域网：同一 Wi-Fi',
  ipv6Off: 'IPv6：本机需有 IPv6，部分运营商屏蔽入站',
  // 可用时沿用同一句前置条件文案：available 布尔量已经表达"能不能用"，文案不必变形。
  tailscaleOn: 'Tailscale：平板需加入同一 tailnet',
  lanOn: '局域网：同一 Wi-Fi',
  ipv6On: 'IPv6：本机需有 IPv6，部分运营商屏蔽入站',
  lanNeedsSecret: '局域网也需要端口和令牌：二维码里已经带好，不用手输；令牌阻止同一网络里的其他人控制这台 DSH。',
  none: '未检测到可用网络：请先连同一 Wi-Fi，或登录 Tailscale 让平板加入同一 tailnet',
} as const

export const TRANSPORT_PRIORITY: readonly PairingTransport[] = ['tailscale', 'lan', 'ipv6']

/**
 * mod-pairing-listener-truth：显式选择某方式但该方式不可用时，**typed 拒绝**的词表。
 *
 * 绝不"静默回落到自动选择再 QR 一个 LAN 地址"——用户选了 IPv6 却发现二维码里是 192.168.x，
 * 正是本次 P0 的欺骗性来源。三条原因与 typed code 集中一处，UI / RPC / 测试同一事实来源。
 */
export interface TransportRefusal {
  code: 'E_NO_IPV6_ADDRESS' | 'E_NO_TAILSCALE_ADDRESS' | 'E_NO_LAN_ADDRESS'
  reason: string
}

export const TRANSPORT_REFUSAL: Readonly<Record<PairingTransport, TransportRefusal>> = {
  tailscale: { code: 'E_NO_TAILSCALE_ADDRESS', reason: '本机未检测到 Tailscale 地址' },
  lan: { code: 'E_NO_LAN_ADDRESS', reason: '本机未检测到局域网地址' },
  ipv6: { code: 'E_NO_IPV6_ADDRESS', reason: '本机未检测到公网 IPv6 地址' },
}

/**
 * 从**正在监听的绑定地址**反推传输方式（不是从网卡枚举猜）。
 *
 * - 带冒号（含方括号写法）→ `ipv6`；
 * - `100.64.0.0/10` → `tailscale`；
 * - RFC1918 IPv4 → `lan`；
 * - 其它（通配 / 回环 / 公网 IPv4 / 非法文本）→ null，调用方 typed 拒绝。
 */
export function transportOfBoundAddress(address: unknown): PairingTransport | null {
  if (typeof address !== 'string') return null
  const text = address.trim()
  if (text === '') return null
  const inner = text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text
  if (inner.includes(':')) return 'ipv6'
  if (TAILSCALE_RE.test(inner)) return 'tailscale'
  if (RFC1918_RE.test(inner)) return 'lan'
  return null
}

export interface TransportCandidate {
  kind: PairingTransport
  available: boolean
  /** 给人看的中文理由（可用时是确认句，不可用时是前置条件句）。 */
  reason: string
  /** 可用时的规范 host（IPv6 已带方括号）；不可用时为空串。 */
  host: string
}

export interface TransportSelection {
  /**
   * mod-remote-tls-termination：三种直连传输**现在都**由自签证书 + 配对指纹保护。
   * 面板据此把「明文 HTTP」警告换成「已加密（自签名证书，按配对指纹校验）」，
   * 而不是按 transport 名硬编码判断；未加密的传输（cloudflare/uu/manual 的旧路径）不带此布尔量。
   */
  tls: boolean
  /** 用户在设置里的请求值；`auto` = 全自动。 */
  requested: PairingTransport | 'auto'
  /** 最终选中的方式；没有任何可用网卡时为 null（UI 必须灰掉并展示 reason）。 */
  selected: PairingTransport | null
  selectedHost: string
  /** 覆盖了但不可用 → true，此时已回落到自动选择，绝不给死地址。 */
  overrideUnavailable: boolean
  candidates: Record<PairingTransport, TransportCandidate>
}

function isGlobalIPv6(address: string): boolean {
  const head = address.split(':')[0]?.toLowerCase() ?? ''
  const first = head[0]
  if (first === undefined) return false
  if (/^[89ab]/.test(first)) return false // link-local fe80 / ULA fc00..fdff / multicast ff00
  if (/^[2-3]/.test(first)) return true   // 2000::/3 全局单播
  return false
}

function detect(seam: InterfaceSeam): Record<PairingTransport, TransportCandidate> {
  const infos = seam.interfaces()
  const usable = infos.filter((item) => item.internal !== true)
  let tailscale = ''
  let lan = ''
  let ipv6 = ''
  for (const item of usable) {
    const address = item.address.trim()
    if (item.family === 'IPv4') {
      if (TAILSCALE_RE.test(address)) {
        if (tailscale === '') tailscale = address
      } else if (item.virtual !== true && RFC1918_RE.test(address)) {
        if (lan === '') lan = address
      }
    } else if (item.virtual !== true && isGlobalIPv6(address)) {
      if (ipv6 === '') ipv6 = `[${address.toLowerCase()}]`
    }
  }
  return {
    tailscale: {
      kind: 'tailscale',
      available: tailscale !== '',
      host: tailscale,
      reason: tailscale === '' ? TRANSPORT_REASON_COPY.tailscaleOff : TRANSPORT_REASON_COPY.tailscaleOn,
    },
    lan: {
      kind: 'lan',
      available: lan !== '',
      host: lan,
      reason: lan === '' ? TRANSPORT_REASON_COPY.lanOff : TRANSPORT_REASON_COPY.lanOn,
    },
    ipv6: {
      kind: 'ipv6',
      available: ipv6 !== '',
      host: ipv6,
      reason: ipv6 === '' ? TRANSPORT_REASON_COPY.ipv6Off : TRANSPORT_REASON_COPY.ipv6On,
    },
  }
}

/**
 * 选路。注入 seam 的调用方式：
 * `selectPairingTransport({ interfaces: () => [{name:'WLAN',family:'IPv4',address:'192.168.1.6'}] })`
 */
export function selectPairingTransport(
  seam: InterfaceSeam,
  options: { override?: PairingTransport | 'auto' } = {},
): TransportSelection {
  const candidates = detect(seam)
  const requested = options.override ?? 'auto'
  let selected: PairingTransport | null = null
  let selectedHost = ''
  let overrideUnavailable = false

  if (requested !== 'auto') {
    const candidate = candidates[requested]
    if (candidate?.available) {
      selected = requested
      selectedHost = candidate.host
    } else {
      overrideUnavailable = true
    }
  }
  if (selected === null) {
    for (const kind of TRANSPORT_PRIORITY) {
      const candidate = candidates[kind]
      if (candidate.available) {
        selected = kind
        selectedHost = candidate.host
        break
      }
    }
  }
  // 直连三方式统一走 HTTPS（listener 对外终结 TLS）；布尔量随视图出给面板做数据驱动文案。
  return { tls: true, requested, selected, selectedHost, overrideUnavailable, candidates }
}

/** UI 用的三行理由（顺序固定 Tailscale / 局域网 / IPv6），另附局域网"也要令牌"的说明。 */
export function transportReasonLines(selection: TransportSelection): string[] {
  return [
    ...TRANSPORT_PRIORITY.map((kind) => selection.candidates[kind].reason),
    TRANSPORT_REASON_COPY.lanNeedsSecret,
  ]
}
