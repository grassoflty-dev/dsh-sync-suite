/**
 * 远程访问方式的**纯逻辑模型**：方式元数据表 + 设置归一。
 *
 * 职责：
 *   - 六种方式的展示文案、可用性判定、要填的字段、用户操作步骤（UI/文档/RPC 同源）；
 *   - `RemoteSettings` 的缺省/清空/校验归一（`remote.json` 落盘前必须过这一关）。
 *
 * 不变式：
 *   1. 元数据是**唯一真相**：UI、RPC、文档都从这里读，别处不许再写一份同义文案。
 *   2. 归一一律 fail-closed：字段缺省才沿用 `previous`，显式 `''` 才清空，其余非法
 *      一律抛 `SyncError('E_VALIDATION')`；绝不把坏值悄悄吞成默认值（否则用户会
 *      以为保存成功，实际监听/建链必然失败）。
 *   3. 错误 `details` 里的值可原样给出（这些字段不含 secret），唯一例外是 `manualUrl`：
 *      含 `token=` 时先把值打码再放进 details。
 *   4. 本文件只 import `engine/errors.ts`（`types.ts` 纪律 1 允许的纯工具），不碰同步实现。
 *
 * 可用性来自本轮调研，**结论不许在此推翻**：
 *   - uu：网易 UU 远程是画面串流，不产生端口/虚拟网卡 → unsupported；
 *   - tailscale：平板必须装**鸿蒙原生**客户端（HarmoTail 等，需侧载 HAP），
 *     卓易通里的安卓 Tailscale 只作用于容器内的 App → needs-setup；
 *   - ipv6 / cloudflare：技术上可行，但要用户先做环境准备 → needs-setup；
 *   - lan / manual：本仓库可直接落地 → ready。
 */
import { SyncError } from '../engine/errors.js'
import type {
  RemoteAccessMode,
  RemoteBindKind,
  RemoteModeField,
  RemoteModeSpec,
  RemoteSettingKey,
  RemoteSettings,
} from './types.js'
import { normalizeHostname, normalizeIpv4, normalizeIpv6 } from './urls.js'

/** 方式顺序 = UI 下拉框顺序：从最可能可用到最不推荐（uu 恒排末尾）。 */
export const REMOTE_MODE_ORDER: readonly RemoteAccessMode[] = [
  'lan',
  'tailscale',
  'ipv6',
  'cloudflare',
  'manual',
  'uu',
]

/**
 * 元数据 + 绑定点类型。
 *
 * `types.ts` 已定稿，`RemoteModeSpec` 里没有 `bindKind`（那属于监听实现），但可用性表
 * 要求每条方式说明"绑到哪类具体地址"。这里用交叉类型在对象上补齐，**不另立同义类型**、
 * 也不改 `types.ts`：`RemoteModeInfo` 仍是 `RemoteModeSpec` 的子类型，所有按契约声明的
 * 消费方（`RemoteModeSpec[]`）都不受影响。
 */
export type RemoteModeInfo = RemoteModeSpec & { readonly bindKind: RemoteBindKind }

/** 字段名 → 给用户看的短标签（错误消息与表单标题共用，避免两套叫法）。 */
const FIELD_LABELS: Record<RemoteSettingKey, string> = {
  enabled: '总开关',
  mode: '访问方式',
  port: '端口',
  lanAddress: '局域网地址',
  tailscaleHost: 'Tailscale 地址',
  cloudflareHost: '隧道域名',
  ipv6Address: 'IPv6 地址',
  manualUrl: '完整地址',
}

/** 端口字段在所有"要起监听"的方式里都是必填项（0 = 跟 DSH 同端口，所以恒有值）。 */
function portField(): RemoteModeField {
  return {
    key: 'port',
    label: FIELD_LABELS.port,
    placeholder: '0',
    hint: '0 = 跟 DSH 同端口',
    required: true,
  }
}

export const REMOTE_MODES: Readonly<Record<RemoteAccessMode, RemoteModeInfo>> = {
  lan: {
    mode: 'lan',
    label: '局域网直连',
    description: '平板和电脑连同一个 Wi-Fi，直接用局域网地址打开。',
    availability: 'ready',
    unavailableReason: '',
    requires: ['平板和电脑在同一 Wi-Fi 或局域网里'],
    fields: [
      {
        key: 'lanAddress',
        label: FIELD_LABELS.lanAddress,
        placeholder: '192.168.1.6',
        hint: '电脑在局域网里的 IPv4，可在「设置 → 网络」里看',
        required: true,
      },
      portField(),
    ],
    steps: [
      '在电脑「设置 → 网络」里查看当前 Wi-Fi 的 IPv4 地址。',
      '把地址填进「局域网地址」；端口留 0 就是跟 DSH 同端口。',
      '平板连同一个 Wi-Fi，用 App 里显示的链接打开。',
    ],
    hostsListener: true,
    bindKind: 'lan',
  },
  tailscale: {
    mode: 'tailscale',
    label: 'Tailscale 组网',
    description: '电脑和装了 Tailscale 的平板组成虚拟内网，走 100.x 地址。',
    availability: 'needs-setup',
    unavailableReason: '',
    requires: [
      '电脑装 Tailscale 并登录同一账号',
      '平板要装鸿蒙原生客户端（如 HarmoTail，需侧载 HAP）',
      '卓易通里装的安卓 Tailscale 不能让本机 App 走它',
    ],
    fields: [
      {
        key: 'tailscaleHost',
        label: FIELD_LABELS.tailscaleHost,
        placeholder: '100.101.102.103',
        hint: '电脑在 Tailscale 里的 100.x 地址或 MagicDNS 名',
        required: true,
      },
      portField(),
    ],
    steps: [
      '电脑上安装 Tailscale 客户端并登录同一个账号。',
      '平板侧载安装鸿蒙原生客户端（例如 HarmoTail）。',
      '在 Tailscale 后台「设备」列表里复制电脑的 100.x 地址。',
      '把 100.x 地址填进「Tailscale 地址」，端口留 0。',
      '平板能打开这个 100.x 地址后，再回 App 打开链接。',
    ],
    hostsListener: true,
    bindKind: 'tailnet',
  },
  ipv6: {
    mode: 'ipv6',
    label: '公网 IPv6 直连',
    description: '家里宽带有公网 IPv6 时，平板用流量也能直接连到电脑。',
    availability: 'needs-setup',
    unavailableReason: '',
    requires: [
      '家里宽带已开通公网 IPv6（多数新装宽带默认有）',
      '光猫或路由器放行该端口的入站访问',
      '平板所在网络（Wi-Fi 或流量）也支持 IPv6',
    ],
    fields: [
      {
        key: 'ipv6Address',
        label: FIELD_LABELS.ipv6Address,
        placeholder: '2409:8a20:4cad:ba20:1234:5678:9abc:def0',
        hint: '只填地址，不要带 [ ] 方括号',
        required: true,
      },
      portField(),
    ],
    steps: [
      '电脑上运行 ipconfig，找「IPv6 地址」里不带「临时」的那条。',
      '它要以 2 或 3 开头；fe80 开头的是内网地址，不能用。',
      '把地址去掉方括号后填进「IPv6 地址」字段。',
      '在光猫或路由器上给这个端口放行入站 IPv6。',
      '平板用手机流量打开链接测试；打不开多半是运营商没给 IPv6。',
    ],
    hostsListener: true,
    bindKind: 'ipv6',
  },
  cloudflare: {
    mode: 'cloudflare',
    label: 'Cloudflare 隧道',
    description: '电脑上跑 cloudflared，得到一个 https 网址，平板不用装东西。',
    availability: 'needs-setup',
    unavailableReason: '',
    requires: [
      '电脑上装 cloudflared（Cloudflare 官方命令行工具）',
      '用 quick tunnel 试，或有自有域名时配命名隧道（更稳定）',
    ],
    fields: [
      {
        key: 'cloudflareHost',
        label: FIELD_LABELS.cloudflareHost,
        placeholder: 'xxx.trycloudflare.com',
        hint: 'cloudflared 打印的域名，不带 https:// 和路径',
        required: true,
      },
      portField(),
    ],
    steps: [
      '电脑上装 cloudflared（官网下载 exe 或用 winget）。',
      '运行 cloudflared tunnel --url http://127.0.0.1:40596。',
      '命令行会打印 https://xxx.trycloudflare.com，复制域名。',
      '把域名填进「隧道域名」，不要带 https:// 和路径。',
      'quick tunnel 每次重启域名都会变；长期用请配命名隧道。',
    ],
    hostsListener: true,
    bindKind: 'loopback',
  },
  manual: {
    mode: 'manual',
    label: '手动填地址',
    description: '你自己已有一条能访问这台电脑的地址，插件只负责保存。',
    availability: 'ready',
    unavailableReason: '',
    requires: ['你自己已有的可用地址（如反向代理、花生壳）'],
    fields: [
      {
        key: 'manualUrl',
        label: FIELD_LABELS.manualUrl,
        placeholder: 'https://example.com/?token=…',
        hint: '必须带 http:// 或 https://；可以带 ?token= 参数',
        required: true,
      },
    ],
    steps: [
      '把能访问这台电脑的完整地址（含 http:// 或 https://）填进来。',
      '保存后点「测试连接」，能打开 DSH 页面就说明可用。',
    ],
    hostsListener: false,
    bindKind: 'none',
  },
  uu: {
    mode: 'uu',
    label: '网易 UU 远程',
    description: '网易 UU 远程是画面串流，没法让 App 直接打开一个网址。',
    availability: 'unsupported',
    // 判定浓缩：调研 B 的核心结论，UI 必须原样展示，不许改写或软化。
    unavailableReason:
      '网易 UU 远程是画面串流（远程桌面），不产生端口或虚拟网卡，没法让 App 打开一个网址；官方功能与帮助中心都没有端口映射。',
    requires: ['无；该方式在原理上不可行'],
    fields: [],
    steps: [],
    hostsListener: false,
    bindKind: 'none',
  },
}

/** 按 UI 顺序列出方式元数据（返回新数组，调用方乱改不会污染常量表）。 */
export function listModes(): RemoteModeInfo[] {
  return REMOTE_MODE_ORDER.map((mode) => REMOTE_MODES[mode])
}

/**
 * 把外部输入解析成方式元数据。
 *
 * 只认枚举里的**精确**字符串：不做 trim/大小写容错，因为 App 侧、RPC 侧、UI 下拉框
 * 共用同一套枚举值，多出来的宽容只会掩盖前端 bug。
 */
export function findMode(raw: unknown): RemoteModeInfo | null {
  if (typeof raw !== 'string') return null
  return REMOTE_MODE_ORDER.includes(raw as RemoteAccessMode) ? REMOTE_MODES[raw as RemoteAccessMode] : null
}

/** 默认设置：默认关闭，方式 lan，端口跟随 DSH，所有地址留空（由用户在设置页选/填）。 */
export function defaultRemoteSettings(): RemoteSettings {
  return {
    enabled: false,
    mode: 'lan',
    port: 0,
    lanAddress: '',
    tailscaleHost: '',
    cloudflareHost: '',
    ipv6Address: '',
    manualUrl: '',
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** 错误 details 里展示的值：manualUrl 可能含 token，先打码；其余字段不含 secret，原样给出。 */
function detailValue(field: RemoteSettingKey, raw: unknown): unknown {
  if (field === 'manualUrl' && typeof raw === 'string') return maskTokenInUrl(raw)
  if (typeof raw === 'string') return raw
  if (raw === null || raw === undefined) return raw
  return typeof raw === 'object' ? '[object]' : String(raw)
}

/** 只用于错误展示：把 `?token=…` / `&token=…` 后面那段换成 ***。 */
function maskTokenInUrl(text: string): string {
  return text.replace(/([?&;]token=)[^&#\s]*/gi, '$1***')
}

/**
 * 手动地址的**持久化**校验：必须是带协议的 http/https 完整地址。
 *
 * 与 `urls.urlForMode('manual', …)` 的容错（缺协议自动补 http://）刻意不同：
 * 落盘时严格，免得把 `example.com` 这种半成品存进去；渲染时容错，是为了兼容用户
 * 在别处粘贴的短地址。两处的判定理由都写在这里，避免以后被当成 bug 改掉。
 */
function checkManualUrl(value: string): string {
  if (!/^https?:\/\//i.test(value)) return '必须以 http:// 或 https:// 开头'
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return '地址解析失败，请检查是否拼错'
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '只支持 http:// 或 https://'
  if (parsed.hostname === '') return '地址里缺少主机名'
  return ''
}

/** 校验并归一一个字符串字段；`reason` 为空串表示通过。 */
function checkField(field: RemoteSettingKey, value: string): { value: string; reason: string } {
  if (value === '') return { value: '', reason: '' }
  switch (field) {
    case 'lanAddress': {
      const v4 = normalizeIpv4(value)
      return { value: v4.ok ? v4.value : value, reason: v4.ok ? '' : v4.reason }
    }
    case 'ipv6Address': {
      const v6 = normalizeIpv6(value)
      return { value: v6.ok ? v6.value : value, reason: v6.ok ? '' : v6.reason }
    }
    case 'tailscaleHost':
    case 'cloudflareHost': {
      const host = normalizeHostname(value)
      return { value: host.ok ? host.value : value, reason: host.ok ? '' : host.reason }
    }
    case 'manualUrl':
      return { value, reason: checkManualUrl(value) }
    default:
      // enabled/mode/port 不在这里处理（各有专门规则）。
      return { value, reason: '' }
  }
}

/** 需要按"字符串 + 地址语义"校验的字段（顺序即报错优先级）。窄成字面量联合，赋值时才不会退化成 never。 */
type AddressSettingKey = 'lanAddress' | 'tailscaleHost' | 'cloudflareHost' | 'ipv6Address' | 'manualUrl'

const STRING_FIELDS: readonly AddressSettingKey[] = [
  'lanAddress',
  'tailscaleHost',
  'cloudflareHost',
  'ipv6Address',
  'manualUrl',
]

/**
 * 把外部输入（UI/RPC）合并到既有设置并校验。
 *
 * - 缺省（undefined）→ 沿用 `previous`；
 * - 显式 `''` → 清空该字段（用户主动清掉主机名是合法操作）；
 * - 其余非法 → `SyncError('E_VALIDATION')`，message 直接可展示。
 *
 * `mode` 允许存成 `uu`：UI 需要能"选中看一下为什么不行"，但监听/建链那侧会按
 * `availability` fail-closed（见 `isModeUsable` 与 `urlForMode`）。
 */
export function normalizeRemoteSettings(input: unknown, previous: RemoteSettings): RemoteSettings {
  const record = asRecord(input)
  if (record === null) throw new SyncError('E_VALIDATION', '远程访问设置必须是对象')

  const next: RemoteSettings = { ...previous }

  if (record.enabled !== undefined) {
    if (typeof record.enabled !== 'boolean') {
      throw new SyncError('E_VALIDATION', '总开关 enabled 必须是布尔值 true/false', {
        field: 'enabled',
        value: detailValue('enabled', record.enabled),
      })
    }
    next.enabled = record.enabled
  }

  if (record.mode !== undefined) {
    if (typeof record.mode !== 'string' || !REMOTE_MODE_ORDER.includes(record.mode as RemoteAccessMode)) {
      throw new SyncError('E_VALIDATION', `访问方式 mode 取值非法，只支持：${REMOTE_MODE_ORDER.join('、')}`, {
        field: 'mode',
        value: detailValue('mode', record.mode),
        allowed: [...REMOTE_MODE_ORDER],
      })
    }
    next.mode = record.mode as RemoteAccessMode
  }

  if (record.port !== undefined) {
    const raw = record.port
    const allowed = { min: 0, max: 65535 }
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < allowed.min || raw > allowed.max) {
      throw new SyncError('E_VALIDATION', '端口 port 必须是 0–65535 之间的整数（0 = 跟 DSH 同端口）', {
        field: 'port',
        value: detailValue('port', raw),
        allowed,
      })
    }
    next.port = raw
  }

  for (const field of STRING_FIELDS) {
    const raw = record[field]
    if (raw === undefined) continue
    if (typeof raw !== 'string') {
      throw new SyncError('E_VALIDATION', `${FIELD_LABELS[field]}必须是字符串`, {
        field,
        value: detailValue(field, raw),
      })
    }
    const trimmed = raw.trim()
    const checked = checkField(field, trimmed)
    if (checked.reason !== '') {
      throw new SyncError('E_VALIDATION', `${FIELD_LABELS[field]}不可用：${checked.reason}`, {
        field,
        value: detailValue(field, trimmed),
      })
    }
    next[field] = checked.value
  }

  return next
}

/**
 * 当前方式还缺哪些必填字段（UI 用它禁用「启动」并在字段下面飘红）。
 *
 * `port` 永远不算缺失：它的有效值包含 `0`（跟 DSH 同端口），"没填"与"填 0"无法区分，
 * 也无法更安全地拒绝——真正的端口可用性由监听侧探测。
 */
export function missingRequiredFields(mode: RemoteAccessMode, settings: RemoteSettings): RemoteSettingKey[] {
  const spec = REMOTE_MODES[mode]
  if (spec === undefined) return []
  const missing: RemoteSettingKey[] = []
  for (const field of spec.fields) {
    if (!field.required) continue
    if (field.key === 'port') continue
    const value = settings[field.key]
    if (typeof value === 'string' && value.trim() === '') missing.push(field.key)
  }
  return missing
}

/** 该方式在本轮实现里是否可落地（`unsupported` 一律 false，UI 必须显示原因而不是假开关）。 */
export function isModeUsable(mode: RemoteAccessMode): boolean {
  const spec = REMOTE_MODES[mode]
  // 运行时可能收到旧配置里的未知 mode → fail-closed。
  return spec !== undefined && spec.availability !== 'unsupported'
}
