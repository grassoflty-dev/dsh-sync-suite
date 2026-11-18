/**
 * 远程访问域（`src/remote/**`）的**唯一**类型契约。
 *
 * 纪律（PRD/评审共守）：
 *   1. 本域**禁止** import `src/engine/**`（`engine/errors.ts` 这类纯工具除外）与
 *      `src/schedule/**` 的实现：远程监听起不来不能连累同步，反之亦然。
 *   2. 一切失败 fail-closed：不认识的 mode / 缺字段 / 探测未证实 → 一律不给出"可用"结论。
 *   3. token 明文永不进入 `RemoteStatus`、日志、错误消息；只允许出现在
 *      `RemoteLink`（用户显式点「显示链接」时）与二维码矩阵里。
 *
 * 与 App（`apps/arkui-schedule/entry/src/main/ets/model/remoteAccess.ts`）共享同一套
 * 字段语义：字段名、枚举值、必填规则必须逐字一致，见 `docs/REMOTE-ACCESS-OPTIONS.md`。
 */

/**
 * 访问方式。`manual` = 用户自填完整地址（不代管监听）；
 * `uu` = 网易 UU 远程（**可用，需准备**：它自带「图形化端口映射」，免费版包含；
 * 用户把映射生成的对外入口粘进来即可。第 5 轮订正了上一版「UU 不可用」的错误结论，
 * 依据见 `docs/REMOTE-ACCESS-OPTIONS.md` §2.6 与 §7 的官方 blog 链接）。
 */
export type RemoteAccessMode = 'lan' | 'tailscale' | 'ipv6' | 'cloudflare' | 'manual' | 'uu'

/** 旁挂监听要绑到哪一类具体地址（永不落到通配地址）。 */
export type RemoteBindKind = 'lan' | 'ipv6' | 'tailnet' | 'loopback' | 'none'

/** 该方式在当前实现里的落地状态。`unsupported` 的项 UI 必须显式标注原因，不许做假开关。 */
export type RemoteModeAvailability = 'ready' | 'needs-setup' | 'unsupported'

/** 探测单条结论的等级。`unknown` 表示"本机无法自证"，绝不可降级成 ok。 */
export type RemoteLevel = 'ok' | 'warn' | 'fail' | 'unknown'

/** 持久化设置（`~/.dsh/dots/remote.json`）。 */
export interface RemoteSettings {
  /** 总开关；默认 false（默认关闭是本轮硬约束）。 */
  enabled: boolean
  /** 当前访问方式；默认 lan。 */
  mode: RemoteAccessMode
  /**
   * 旁挂监听端口。`0` = 跟随 DSH 自己的监听端口（默认，用户体验最好：地址只差主机名）；
   * 正整数 = 固定端口。**永不**用来表达通配绑定。
   */
  port: number
  /** 局域网方式要绑的**具体** IPv4；空串 = 自动挑选（绝不落到 0.0.0.0）。 */
  lanAddress: string
  /** Tailscale 方式的 MagicDNS 名或 100.64.0.0/10 地址。 */
  tailscaleHost: string
  /** Cloudflare 隧道方式的公网主机（`xxx.trycloudflare.com` 或自有域名）。 */
  cloudflareHost: string
  /** IPv6 方式的地址字面量（不带方括号）。 */
  ipv6Address: string
  /** 手动方式的完整地址（含协议；可含 token）。 */
  manualUrl: string
  /**
   * 「访问令牌（可选）」：用户在 `lan` / `ipv6` / `tailscale` 下粘贴的令牌。
   *
   * 语义（两端逐字共用，见 `docs/REMOTE-ACCESS-OPTIONS.md` §3）：
   *   - 空串 = 不往地址里追加任何令牌参数（地址原样打开）；
   *   - 非空 = 拼成 `?token=<值>`（与令牌门解析的 `token` 参数一致；`?k=` 是等价别名）。
   *
   * **保密**：它是 secret——永不进日志/错误消息，**也不进 `remoteGetState`**；
   * 状态里只给 `RemoteSettingsView.tokenSet` / `tokenMasked`，明文只允许出现在
   * `remoteShowLink` 的返回里（与自动生成的令牌同一出口规则）。
   */
  token: string
}

/** 设置项的字段名（RPC 归一、App 侧、UI 表单三处共用）。 */
export const REMOTE_SETTING_KEYS = [
  'enabled',
  'mode',
  'port',
  'lanAddress',
  'tailscaleHost',
  'cloudflareHost',
  'ipv6Address',
  'manualUrl',
  'token',
] as const

/**
 * 对外暴露的设置视图（`remoteGetState` 用）：把 `token` 抽成"是否存在 + 打码"，
 * 保证状态响应里不可能出现令牌明文。
 */
export interface RemoteSettingsView extends Omit<RemoteSettings, 'token'> {
  /** 是否已保存访问令牌（只给布尔，不给值）。 */
  tokenSet: boolean
  /** 打码串（如 `abcd…wxyz`）；未保存为空串。 */
  tokenMasked: string
}

export type RemoteSettingKey = (typeof REMOTE_SETTING_KEYS)[number]

/** 每种方式需要用户填的字段（顺序即 UI 顺序）。 */
export interface RemoteModeField {
  key: RemoteSettingKey
  label: string
  placeholder: string
  hint: string
  required: boolean
}

/** 方式说明（UI 渲染 + 文档表格同源）。 */
export interface RemoteModeSpec {
  mode: RemoteAccessMode
  label: string
  /** 一句话说明（出现在设置页选项下方）。 */
  description: string
  availability: RemoteModeAvailability
  /** `unsupported` 时为给用户看的中文原因；其余为空串。 */
  unavailableReason: string
  /** 该方式需要用户准备的前提（账号/客户端/系统设置），UI 用小字列出。 */
  requires: string[]
  /** 该方式要填的字段。 */
  fields: RemoteModeField[]
  /** 用户侧操作步骤（≤6 步，App 的"怎么做"弹层复用）。 */
  steps: string[]
  /** 该方式是否会由本插件起旁挂监听（false = 只做地址归一与自检）。 */
  hostsListener: boolean
}

/** 一条自检结论。 */
export interface RemoteCheck {
  /** 稳定 id（测试与文档按 id 断言）。 */
  id: string
  level: RemoteLevel
  /** 给人看的一句话结论（中文，不含 token）。 */
  message: string
  /** 给下一步怎么做的建议；无则空串。 */
  hint: string
}

/** 连通性自检结果。`verdict` 是给人看的总判定句。 */
export interface RemoteProbeResult {
  mode: RemoteAccessMode
  level: RemoteLevel
  checks: RemoteCheck[]
  verdict: string
  /** 探测时间（ISO）。 */
  at: string
}

/** 一条可打开的地址。 */
export interface RemoteUrlEntry {
  mode: RemoteAccessMode
  /** 完整可打开地址；`withToken=true` 时才允许含 token。 */
  url: string
  /** 给人看的标签（如「局域网（192.168.1.6）」）。 */
  label: string
  /** 备注（如「需平板先连同一 WiFi」）。 */
  note: string
  withToken: boolean
}

/** 运行状态（不含任何 secret）。 */
export interface RemoteStatus {
  running: boolean
  /** 实际监听地址 `host:port`；未运行为 null。 */
  listen: string | null
  /** 绑定的具体地址（用于 UI 展示"不是 0.0.0.0"这一事实）；未运行/null。 */
  boundAddress: string | null
  port: number
  startedAt: string | null
  /** 启动失败原因（fail-closed 后保留给 UI 显示，不抛给插件启动）。 */
  lastError: { code: string; message: string } | null
  connections: { active: number; total: number }
  /** 被限速/鉴权拒绝的累计次数。 */
  rejected: number
  /** 令牌存在性与打码展示（永不返回明文）。 */
  token: { exists: boolean; masked: string; createdAt: string | null }
  /** 当前方式下可打开的地址（不含 token）。 */
  urls: RemoteUrlEntry[]
  /** 最近一次自检结果（可为 null = 从未探测）。 */
  probe: RemoteProbeResult | null
}

/** `remoteGetState` 返回体。 */
export interface RemoteStateData {
  /** 设置视图：**不含** `token` 明文（只有 `tokenSet` / `tokenMasked`）。 */
  settings: RemoteSettingsView
  status: RemoteStatus
  /** 方式元数据（UI 直接渲染，避免前端再写一份语义）。 */
  modes: RemoteModeSpec[]
}

/** 显式「显示链接」的返回体：唯一允许带 token 的出口。 */
export interface RemoteLink {
  /** 含 token 的完整地址。 */
  url: string
  /** 二维码矩阵（true = 黑格），行优先；客户端自行渲染。 */
  qr: { size: number; modules: boolean[][] }
  /** 该地址的到期/失效提示（目前恒为空串，留位）。 */
  note: string
}

/** 旁挂监听的运行句柄。 */
export interface RemoteListener {
  /** 实际监听地址。 */
  address: string
  port: number
  close(): Promise<void>
}

/** 本机网卡候选（`lanAddress` 自动挑选与 UI 下拉框共用）。 */
export interface LanCandidate {
  address: string
  /** 网卡名（Windows 上是「以太网」「WLAN」这类）。 */
  iface: string
  family: 'IPv4' | 'IPv6'
  /** 虚拟网卡（Hyper-V / VMware / WSL / Teredo / 容器桥）→ true，自动挑选时跳过。 */
  virtual: boolean
}

/**
 * `rpc.ts` 只依赖这个结构（结构化类型），不 import `remote/index.ts`，
 * 保证 RPC 层与远程运行时的编译解耦。
 */
export interface RemoteServiceLike {
  getState(): Promise<RemoteStateData>
  saveSettings(input: unknown): Promise<RemoteStateData>
  start(): Promise<RemoteStatus>
  stop(): Promise<RemoteStatus>
  rotateToken(): Promise<RemoteStatus>
  probe(mode?: RemoteAccessMode): Promise<RemoteProbeResult>
  showLink(mode?: RemoteAccessMode): Promise<RemoteLink>
  detectLan(): LanCandidate[]
  dispose(): Promise<void>
}
