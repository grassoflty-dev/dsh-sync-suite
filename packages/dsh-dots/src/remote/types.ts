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
 *
 * ## 三个"看起来都在说开关"的位（mod-plugin-remote-accepting-surface：禁止互相代用）
 *
 * | 位 | 唯一含义 | 谁写 | 谁读 |
 * | --- | --- | --- | --- |
 * | `enabled` | **上一次保存的偏好**（start/stop 时按监听句柄回声写，进程被强杀后可能过期） | `commitEnabledFlag()`（起成功 / 显式 stop）、`saveSettings` 原样落盘 | 只给人看；**任何情况下不得**被当成"此刻在接"或"下次自动起" |
 * | `autoStart` | **意图**：下次激活时要不要自己起监听 | `start()`（manual 来源置 `true`，失败也置）、`stop()` 清零落盘、`dispose()` 不动 | 激活唯一入口 `service.autoStart()` |
 * | `accepting` | **活真相**：此刻监听句柄是否存在（与 `RemoteStatus.running` **同一个**表达式 `runtime.handle !== null`） | 无人写；每次读状态时派生 | 面板那句「正在接受连接（addr:port）」 |
 *
 * 一句话记法：`enabled` = 上次存了什么偏好，`autoStart` = 下次要不要自己起，
 * `accepting` = **此刻**在不在接。三者不准互相推断，也不准合并成一个字段。
 */
import type { LiveConnectionView } from './connections.js'

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
  /**
   * **来源标记**：这里的 `lanAddress` 是**运维手选的**（mod-plugin-remote-dispose-race）。
   *
   * 为什么需要它：磁盘上的 `lanAddress` 三义——运维手填、`pairingProvision.persistEndpoint()`
   * 的**自动镜像**、旧版本留下的值。旧规则靠"落盘值是否等于冻结启发式的当前输出"来猜来源，
   * 而那条启发式的输出随**网卡集合**变化：机器上一旦出现枚举更靠前的非虚拟网卡，落盘的
   * `192.168.137.1` 就不再等于它 ⇒ 被升格成"可信覆盖" ⇒ `autoStart()` 把虚拟网卡绑回去
   * （评审 P2-10 复现）。**猜来源这件事本身不可靠**，所以改成**记下来源**。
   *
   * 语义（写读各一处，别再加第三个入口）：
   *   - 写 `true` 的唯一入口 = `service.saveSettings()` 收到**非空** `lanAddress`（那次调用本身
   *     就是运维在选地址，**不做任何数值比较**）；清空该字段 = 改回自动挑选，标记一并清掉。
   *   - provisioning / 自愈等**整文件重写**只**保留**已有标记，绝不设置它
   *     （`normalizeRemoteSettings` 只管"记录里有字面布尔就沿用"）。
   *   - 读：只有 `lanAddressChosen === true` 才把 `lanAddress` 当覆盖；否则一律自动选路
   *     （路由 → 候选规则），并在原因行明说「已忽略落盘的 X（未记录为你手选的地址，按自动挑选）」。
   *
   * **可选字段（additive，不做迁移）**：缺键 = 没记录过 = **不是**运维选的。因此旧文件里那个
   * 非空的 `lanAddress`（哪怕当年真是手填的）升级后一律按自动值处理 —— 这是诚实的代价：
   * 无法证明来源时，宁可回到"路由地址"这个今天能证明可用的答案，也不把一台机器钉在
   * 一条历史启发式的输出上。运维若确实要固定地址，在面板里重填一次即可重新盖章。
   */
  lanAddressChosen?: boolean
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
  /**
   * **自动启动意图**（mod-plugin-remote-autostart）：插件每次激活时要不要自己把监听拉起来。
   *
   * 与 `enabled` 是两个概念，绝不再混用：
   *   - `autoStart` = **意图**（"下次激活自动起监听"）。写入口只有两个：
   *     `start()` 被发起时置 `true`（成功、失败都置；失败也留住重试的机会），
   *     用户显式 `stop()` 时清零。`dispose()`（进程退出/插件卸载）**不**改它。
   *   - `enabled` = 句柄回声（"上一次是开着的"），见 `RemoteSettingsView.enabled` 的注释；
   *     挂载路径**不再**读它（旧实现在 `src/index.ts` 用 `enabled` 当意图位，见本模块报告）。
   *
   * **可选字段（additive，不做迁移）**：缺键读作 `false` —— 旧 `remote.json` 升级后
   * 不会凭空多起一个监听（管理过这台机器的人需要再点一次「开始接受连接」）。
   * 为什么声明成可选：`defaultRemoteSettings()` 的**精确形状**（9 个键）被既有断言按
   * 深度相等钉住，本模块不往默认值里加键；真正保证"重建不丢"的是
   * `normalizeRemoteSettings`（mod-plugin-remote-accepting-surface）：记录里有字面布尔就
   * 沿用，所以 `pairingProvision.persistEndpoint()` 那种
   * `normalizeRemoteSettings(raw, defaultRemoteSettings())` 的整文件重写**不会再把它抹掉**。
   * 缺键仍然读作 `false`（`service.ts` 的 `readSettings` 不再单独兜这一层）。
   */
  autoStart?: boolean
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
 *
 * `lanAddressChosen` 与 `token` / `autoStart` 一样**不进视图**：它是落盘的来源标记，不是面板
 * 字段（面板读的是引擎给的原因行）。少了这个键，视图形状对既有读者完全不变。
 */
export interface RemoteSettingsView extends Omit<RemoteSettings, 'token' | 'autoStart' | 'lanAddressChosen'> {
  /** 是否已保存访问令牌（只给布尔，不给值）。 */
  tokenSet: boolean
  /** 打码串（如 `abcd…wxyz`）；未保存为空串。 */
  tokenMasked: string
  /**
   * 自动启动意图（mod-plugin-remote-autostart）：**恒为布尔**，缺键/坏值一律 `false`。
   * 归一后的设置里它是可选的，视图里必须给出确定答案，面板才不用自己猜 `undefined`。
   */
  autoStart: boolean
  /**
   * **此刻是不是真的有监听句柄在接连接**（mod-plugin-remote-accepting-surface）。
   *
   * 与 `RemoteStatus.running` 是**同一个**表达式（`runtime.handle !== null`），不是第二份判断；
   * 与 `RemoteSettings.enabled`（保存的偏好 / 句柄回声）**没有任何关系**——崩溃后文件可能停在
   * `enabled:true` 而这里必须是 `false`，反过来也一样。面板据此决定那句「正在接受连接」。
   */
  accepting: boolean
  /**
   * 与 `accepting` 同源同值的 `host:port`：就是 `RemoteStatus.listen`（未在接 ⇒ `null`）。
   *
   * 为什么选 `listen` 而不是 `boundAddress`：面板那一句要一次说完「哪个地址、哪个端口」，
   * `listen` 已经是引擎拼好的唯一字符串（`${handle.address}:${String(handle.port)}`）；
   * 同时再暴露 `boundAddress` 只会给前端第二种拼法，正是本模块要消灭的"两处口径"。
   */
  listen: string | null
}

/**
 * **活真相快照**：`toSettingsView()` 的第二参数，唯一来源是监听句柄（`runtime.handle`）。
 *
 * 单独成型而不是让调用方自己传两个布尔/字符串，是为了让"同一时刻"这件事在类型上不可拆：
 * `accepting` 与 `listen` 必须来自同一次句柄读取，否则面板可能显示"在接但没地址"。
 */
export interface RemoteLiveListener {
  accepting: boolean
  listen: string | null
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
  /**
   * 这次监听是谁拉起来的（mod-plugin-remote-autostart）：`auto` = 插件激活时按
   * `settings.autoStart` 自己恢复的；`manual` = 用户点了「开始接受连接」；`null` = 没在跑。
   *
   * 为什么要有它：自动恢复若一声不响，面板上的「已启动」看起来就像"我什么时候点的？"。
   * 面板据此补一句「已在启动时自动恢复」。可卸载/停止后必须回到 `null`（与 `running` 同源）。
   */
  startedBy: 'auto' | 'manual' | null
  /** 启动失败原因（fail-closed 后保留给 UI 显示，不抛给插件启动）。 */
  lastError: { code: string; message: string } | null
  /**
   * **监听在 start 之后失效**的 typed 原因（mod-plugin-dispose-hygiene-residuals item 1）。
   *
   * 与 `lastError` 分开：`lastError` 讲"这次启动为什么没起来"或最近一次错误，
   * 而本字段只表示"句柄已经不可信，`running`/`accepting` 必须为 false"。
   * 触发条件：注入的监听句柄报出 **server 级**错误（listener 以「监听 <addr>:<port>」为 scope
   * 记录的那一条）；业务级错误（代理/上游/鉴权）不会出现在这里。
   * 面板必须为它渲染一句中文（含 code、原因与下一步），否则就是"有 typed 状态却没有可执行信息"。
   */
  listenerFailure: { code: string; message: string } | null
  connections: { active: number; total: number }
  /**
   * **当前连接（additive）**：面板把「谁连进来过」换成「当前连接」用的活视图。
   *
   * 与上面的历史计数 `connections` 完全无关，那个字段口径不动。这里每条只有
   * `{ id, peer, transport, kind, since, lastSeen }`：peer 是规范化 IP / `已脱敏`，
   * 没有 token、URL、查询串或请求行；`count` 是剪枝后、cap 截断前的真实总数。
   * 监听停止时句柄为空 ⇒ 这里是 `{ connections: [], count: 0 }`，绝不是旧数据。
   */
  liveConnections: LiveConnectionView
  /** 被限速/鉴权拒绝的累计次数。 */
  rejected: number
  /** 令牌存在性与打码展示（永不返回明文）。 */
  token: { exists: boolean; masked: string; createdAt: string | null }
  /** 当前方式下可打开的地址（不含 token）。 */
  urls: RemoteUrlEntry[]
  /** 最近一次自检结果（可为 null = 从未探测）。 */
  probe: RemoteProbeResult | null
  /** mod-remote-tls-termination：当前旁挂监听是否用 TLS 对外（未运行时为 false）。 */
  tls: boolean
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
  /**
   * **激活入口**（mod-plugin-remote-autostart）：插件挂载时调**恰好一次**的自动启动。
   *
   * 语义（唯一的一条自动启动路径）：
   *   - `settings.autoStart !== true` ⇒ 直接返回当前状态，**绝不**起监听；
   *   - 已经有句柄 ⇒ 直接返回，绝不重复起（幂等）；
   *   - 满足前提（TLS 材料 + 可绑定地址；仓库/令牌都不是前提）⇒ 起监听；
   *   - 起不来 ⇒ 只写 `status.lastError`（typed），**绝不抛**，由下次激活再试一次。
   *
   * 刻意不 await 在启动路径上（`index.ts` fire-and-forget）：远程访问起不来不许拖慢或
   * 阻断插件激活。
   */
  autoStart(): Promise<RemoteStatus>
  rotateToken(): Promise<RemoteStatus>
  /**
   * mod-plugin-pairing 可选接缝：让磁盘上已生成的配对令牌与内存令牌门同步。
   * 返回值只有 `{ok}`，**绝不回显 token**；未装配时 RPC 侧 fail-closed。
   */
  adoptToken?(token: string): { ok: boolean }
  probe(mode?: RemoteAccessMode): Promise<RemoteProbeResult>
  showLink(mode?: RemoteAccessMode): Promise<RemoteLink>
  detectLan(): LanCandidate[]
  dispose(): Promise<void>
}
