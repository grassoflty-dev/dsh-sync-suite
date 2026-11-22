/**
 * mod-plugin-pairing：端口 / 令牌 / 证书的**自动派生状态**（幂等）+ 重新发布钩子。
 *
 * 三件派生物都落插件状态目录（`~/.dsh/dots/`），不进同步仓库：
 *   - 端口：写回既有 `remote.json` 的 `RemoteSettings.port`（与 DSH 公告、二维码同一事实）；
 *   - 令牌：复用既有 `remote-token.json`（`auth.ts` 的 `generateToken(32)`，与令牌门同一把）；
 *   - 证书：新文件 `remote-pairing-cert.json`（0600，私钥不出本层），指纹进配对载荷。
 *
 * 幂等：重启只读取，不静默重掷。端口"稳定优先，占用才扫描"并记录，跨重启不重掷；
 * 轮换是**显式动作**：新令牌写盘 + 回调通知令牌门 + 触发公告同键重发，旧载荷立刻失效。
 */
import { createServer } from 'node:net'
// engine/settings.ts 的纯默认值函数：没有 I/O、没有第二套 deviceId 词表，仅为复用同一实例 id。
import { defaultDeviceId } from '../engine/settings.js'
import { defaultRemoteSettings, normalizeRemoteSettings } from './accessMode.js'
import { generateToken } from './auth.js'
import {
  buildPairingPayload,
  describePairing,
  formatPairingText,
  normalisePairingHost,
  PairingError,
  serialisePairingPayload,
  type PairingCurrentState,
  type PairingDescription,
  type PairingTransport,
} from './pairingPayload.js'
import { encodeQr } from './qr.js'
import { generatePairingCertificate, type PairingCertificate } from './pairingTls.js'
import {
  selectPairingTransport,
  defaultInterfaceSeam,
  transportReasonLines,
  type InterfaceSeam,
  type TransportSelection,
} from './pairingTransport.js'
import { RemoteStore } from './store.js'

/** 稳定的首选端口；被占用才向上扫描，选中的端口记进 remote.json，跨重启不再重掷。 */
export const PAIRING_PREFERRED_PORT = 44996

/** 默认端口探测：只绑 127.0.0.1 试一下，成功即关；不写日志、不回显端口之外的信息。 */
export function isPortFreeDefault(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      resolve(false)
      return
    }
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true))
    })
  })
}

export type RepublishReason = 'first-publish' | 'port-changed' | 'token-rotated' | 'cert-rotated' | 'transport-changed'

/**
 * 公告"同键重发"事件。key 稳定（`announceRef` 为空时用 `pairing:<instanceId>`），
 * payload 是**新的**规范配对串；公告模块只消费本事件，不做静默 edit。
 * `payload` / `text` 是 bearer secret，本事件只在进程内传递，绝不进日志 / RPC 状态视图。
 */
export interface PairingRepublishEvent {
  type: 'pairing.announce.republish'
  key: string
  announceRef: string
  instanceId: string
  port: number
  previousPort: number
  transport: PairingTransport
  host: string
  tlsFingerprint: string
  reason: RepublishReason
  payload: string
  text: string
}

/** 令牌轮换后让内存里的令牌门同步（否则磁盘换了、门还认旧令牌）。 */
export interface PairingTokenChangedEvent {
  type: 'pairing.token.changed'
  token: string
  reason: 'provision' | 'rotate'
}

export interface PairingProvisionOptions {
  homeDir?: string
  now?: () => Date
  instanceId?: string
  announceRef?: string
  /** 显式方式（设置里的手动覆盖结果）；省略则按 priority 自动选。 */
  transport?: PairingTransport
  /** 显式 host；省略则由网卡 seam 推导。 */
  host?: string
  /** 覆盖网卡来源（测试注入，零网络）。 */
  interfaceSeam?: InterfaceSeam
  preferredPort?: number
  isPortFree?: (port: number) => boolean | Promise<boolean>
  generateTokenFn?: () => string
  generateCertFn?: () => PairingCertificate
  onRepublish?: (event: PairingRepublishEvent) => void | Promise<void>
  onTokenChanged?: (event: PairingTokenChangedEvent) => void | Promise<void>
}

export interface PairingProvisionState extends Omit<PairingCurrentState, 'announceRef'> {
  announceRef: string
  /** 私钥只在内部流转；对外视图（view）永不携带。 */
  cert: PairingCertificate
}

export interface PairingProvisionResult {
  /** 内部完整状态（含 token / 私钥）；只允许 provisioning 自己与显式 QR 出口消费。 */
  state: PairingProvisionState
  /** 唯一可进日志 / 状态 / 报告的脱敏摘要。 */
  view: PairingDescription
  /** 规范 JSON —— bearer secret，只有「显示二维码 / 复制配对串」才交给调用方。 */
  payload: string
  /** 紧凑文本 —— bearer secret，供平板手输。 */
  text: string
  republish: PairingRepublishEvent | null
  changed: { port: boolean; token: boolean; cert: boolean }
}

async function choosePort(
  previous: number,
  preferred: number,
  free: (port: number) => boolean | Promise<boolean>,
): Promise<{ port: number; changed: boolean }> {
  // 惰性扫描：先沿用已记录端口（跨重启不重掷），再试稳定首选，最后从首选向上绕回 1。
  const seen = new Set<number>()
  const tryPort = async (port: number): Promise<{ port: number; changed: boolean } | null> => {
    if (port < 1 || port > 65535 || seen.has(port)) return null
    seen.add(port)
    if (await free(port)) return { port, changed: port !== previous }
    return null
  }
  const first = await tryPort(previous)
  if (first !== null) return first
  const second = await tryPort(preferred)
  if (second !== null) return second
  for (let port = preferred + 1; port <= 65535; port += 1) {
    const found = await tryPort(port)
    if (found !== null) return found
  }
  for (let port = 1; port < preferred; port += 1) {
    const found = await tryPort(port)
    if (found !== null) return found
  }
  throw new PairingError('E_PAIRING_PORT', '没有可用端口，请释放一个本机端口后重试')
}

/** 把端口写回既有 remote.json；其它字段逐字保留（不新造第二份设置）。 */
function persistPort(store: RemoteStore, port: number): void {
  const raw = store.readRawSettings()
  const base = defaultRemoteSettings()
  const previous = raw === null ? base : normalizeRemoteSettings(raw, base)
  store.writeSettings({ ...previous, port })
}

export interface PairingProvisioner {
  provision(): Promise<PairingProvisionResult>
  rotateToken(): Promise<PairingProvisionResult>
  rotateCert(): Promise<PairingProvisionResult>
}

export function createPairingProvisioner(options: PairingProvisionOptions = {}): PairingProvisioner {
  const now = options.now ?? ((): Date => new Date())
  const store = new RemoteStore({ homeDir: options.homeDir })
  const seam = options.interfaceSeam ?? defaultInterfaceSeam
  const preferred = options.preferredPort ?? PAIRING_PREFERRED_PORT
  const free = options.isPortFree ?? isPortFreeDefault
  const makeToken = options.generateTokenFn ?? ((): string => generateToken(32))
  const makeCert = options.generateCertFn ?? ((): PairingCertificate => generatePairingCertificate({ now }))

  function resolveEndpoint(): { transport: PairingTransport; host: string; auto: boolean } {
    if (options.transport !== undefined && options.host !== undefined) {
      const host = normalisePairingHost(options.host, options.transport)
      if (!host.ok) throw new PairingError('E_PAIRING_HOST', host.reason)
      return { transport: options.transport, host: host.value, auto: false }
    }
    const selection = selectPairingTransport(seam, { override: options.transport })
    if (selection.selected === null || selection.selectedHost === '') {
      throw new PairingError('E_PAIRING_HOST', '未检测到可用网络，请先连同一 Wi-Fi 或登录 Tailscale')
    }
    const host = normalisePairingHost(selection.selectedHost, selection.selected)
    if (!host.ok) throw new PairingError('E_PAIRING_HOST', host.reason)
    return { transport: selection.selected, host: host.value, auto: true }
  }

  async function run(forceReason?: RepublishReason): Promise<PairingProvisionResult> {
    // 1) 端口：已记录且空闲就沿用；否则扫描。**这里先不落盘**——
    //    只有"算完载荷 + 重发成功"整步都成功，才在最后写回 remote.json。
    const raw = store.readRawSettings()
    const base = defaultRemoteSettings()
    const settings = raw === null ? base : normalizeRemoteSettings(raw, base)
    const chosen = await choosePort(settings.port, preferred, free)
    const announcedPort = store.readPairingAnnouncement()?.announcedPort ?? null

    // 2) 令牌 / 证书：存在即复用；只在缺失时自动生成（不静默轮换）。
    const existingToken = store.readToken()
    let tokenChanged = false
    let token = existingToken?.token ?? ''
    if (existingToken === null) {
      token = makeToken()
      store.writeToken({ token, createdAt: now().toISOString() })
      tokenChanged = true
      if (options.onTokenChanged !== undefined) {
        await options.onTokenChanged({ type: 'pairing.token.changed', token, reason: 'provision' })
      }
    }
    const existingCert = store.readCert()
    let certChanged = false
    let cert = existingCert
    if (cert === null) {
      cert = makeCert()
      store.writeCert(cert)
      certChanged = true
    }

    // 3) 拼规范载荷；instanceId 复用同步侧的 deviceId 词表（纯默认值）。
    const endpoint = resolveEndpoint()
    const state: PairingProvisionState = {
      instanceId: options.instanceId ?? defaultDeviceId(),
      transport: endpoint.transport,
      host: endpoint.host,
      port: chosen.port,
      token,
      tlsFingerprint: cert.fingerprint,
      announceRef: options.announceRef ?? '',
      cert,
    }

    const payload = buildPairingPayload(state)
    const canonical = serialisePairingPayload(payload)
    const text = formatPairingText(payload)
    const view = describePairing(payload)

    // 4) 重发判定以"公告已经发布的端口"为准，而不是刚读到的 remote.json::port：
    //    这样即使上次在"写盘成功 / 重发失败"或反向窗口中断，下一次 run 也会自我修复。
    const neverPublished = announcedPort === null
    const needsPortPublish = neverPublished || announcedPort !== chosen.port
    const reason: RepublishReason | null = forceReason ?? (
      needsPortPublish
        ? (neverPublished ? 'first-publish' : 'port-changed')
        : tokenChanged ? 'token-rotated'
          : certChanged ? 'cert-rotated'
            : null
    )
    let republish: PairingRepublishEvent | null = null
    if (reason !== null) {
      const event: PairingRepublishEvent = {
        type: 'pairing.announce.republish',
        key: state.announceRef === '' ? `pairing:${state.instanceId}` : state.announceRef,
        announceRef: state.announceRef,
        instanceId: state.instanceId,
        port: state.port,
        // 公告当前携带的端口；首次发布时是 remote.json 里的缺省 0。
        previousPort: announcedPort ?? settings.port,
        transport: state.transport,
        host: state.host,
        tlsFingerprint: state.tlsFingerprint,
        reason,
        payload: canonical,
        text,
      }
      republish = event
      if (options.onRepublish !== undefined) await options.onRepublish(event)
      // 钩子 resolve 之后才标记"已发布"；若它抛错，标记不动，下次 run 重发同一 key。
      store.writePairingAnnouncement({
        v: 1,
        announcedPort: chosen.port,
        announceRef: state.announceRef,
        key: event.key,
      })
    }

    // 5) 最后写盘：不变量 = 被记录的端口要么已发布，要么下次 run 由 marker 重发修复。
    if (chosen.changed) persistPort(store, chosen.port)

    return {
      state,
      view,
      payload: canonical,
      text,
      republish,
      changed: { port: chosen.changed, token: tokenChanged, cert: certChanged },
    }
  }

  return {
    provision: () => run(),
    async rotateToken() {
      const token = makeToken()
      store.writeToken({ token, createdAt: now().toISOString() })
      if (options.onTokenChanged !== undefined) {
        await options.onTokenChanged({ type: 'pairing.token.changed', token, reason: 'rotate' })
      }
      return run('token-rotated')
    },
    async rotateCert() {
      const cert = makeCert()
      store.writeCert(cert)
      return run('cert-rotated')
    },
  }
}

/** `show()` 的返回：唯一同时含规范载荷与二维码的出口（用户显式点「显示二维码 / 复制」）。 */
export interface PairingShowResult {
  payload: string
  text: string
  qr: { size: number; modules: boolean[][] }
}

/** RPC 注入的配对服务结构（只依赖本文件的类型，RPC 层不 import 监听 / probe 实现）。 */
export interface PairingServiceLike {
  provision(): Promise<PairingProvisionResult>
  show(): Promise<PairingShowResult>
  rotateToken(): Promise<PairingProvisionResult>
  rotateCert(): Promise<PairingProvisionResult>
  transports(): Promise<TransportSelection & { reasonLines: string[] }>
}

/**
 * 装配层：把 provisioning + QR 编码拼成 RPC 可用的 `PairingServiceLike`。
 * `show()` 之外没有任何出口返回 token 或完整载荷。
 */
export function createPairingService(options: PairingProvisionOptions = {}): PairingServiceLike {
  const provisioner = createPairingProvisioner(options)
  const seam = options.interfaceSeam ?? defaultInterfaceSeam
  return {
    provision: () => provisioner.provision(),
    async show() {
      const result = await provisioner.provision()
      try {
        return { payload: result.payload, text: result.text, qr: encodeQr(result.text, 'M') }
      } catch {
        // 二维码编码失败只给原因：RangeError 消息里只有字节数，但统一转成 typed 码更安全。
        throw new PairingError('E_PAIRING_MALFORMED', '配对串过长，无法生成二维码')
      }
    },
    rotateToken: () => provisioner.rotateToken(),
    rotateCert: () => provisioner.rotateCert(),
    async transports() {
      const selection = selectPairingTransport(seam, { override: options.transport })
      return { ...selection, reasonLines: transportReasonLines(selection) }
    },
  }
}
