/**
 * 「远程访问方式」配置模型 —— 纯逻辑，零 SDK import，Node 可直接单测。
 *
 * 与插件侧 `packages/dsh-dots/src/remote/accessMode.ts` **共用同一套字段语义**
 * （`docs/REMOTE-ACCESS-OPTIONS.md` §3 是唯一事实来源）：方式枚举值、字段名、
 * 可用性判定（`ready` / `needs-setup` / `unsupported`）、字段标签 / 占位符 / 提示逐字对齐。
 * 改这里必须同时看那张表，别在页面里另写一份同义文案。
 *
 * 三条不变式：
 * 1. **能做才给入口，做不到不做假开关**：`needs-setup` 方式（`tailscale` / `ipv6` /
 *    `cloudflare` / `uu`）在用户按 `requires` 填齐字段前，`buildRemoteAccessUrl` 只给中文的
 *    失败原因，绝不产出一个「看起来能用」的地址；`unsupported` 方式（目前没有）恒 `ok:false`
 *    + 原样展示 `unavailableReason`。
 * 2. **失败一律 fail-closed**：`RemoteAccessUrlResult.ok=false` 时 `url` 恒为空串，
 *    调用方拿到空串就不会去打开一个注定打不开的内嵌 Web。
 * 3. **归一不抛异常**：`normalizeRemoteAccessConfig` 吃坏 JSON / 未知 mode / 负端口时回落默认值
 *    （App 的设置读盘路径，抛异常会把设置页整页搞崩）；插件侧落盘校验更严格是刻意的差异。
 *
 * `uu` 的**结论订正**（2026-11）：网易 UU 远程官方 blog
 * （`https://uuyc.163.com/blog/20261117dewhjg.html`，2026-11-10）明确它面向开发者提供
 * **图形化端口映射**、**免费版包含**：用户在界面上把「内部服务端口」与「对外入口」对上，
 * 再把生成的入口发给对方即可。上一版「UU 是画面串流、不产生端口/虚拟网卡、App 打不开网址」
 * 的结论**是错的**，已改为 `needs-setup`（要用户先在 UU 远程里建映射），`unavailableReason` 清空。
 *
 * 与插件侧的**刻意差异**（都在 §3 的「补充约定」里有据）：
 * - 插件侧 `port: 0` = 由服务层解析 `ctx.webServer.port` 后传具体值；App 侧**拿不到** DSH 的端口，
 *   所以在 `lan` / `ipv6` / `tailscale` 下端口是**必填**，`port: 0` 直接给「请先填端口」的失败结论
 *   （省略端口只会打开 80，等于给一个注定打不开的地址）；
 * - 插件侧 `urlForMode` 要做 IPv4 / 主机名的**严格**判定；App 侧只拼地址，最终仍会过一遍
 *   `model/remoteUrl.ts` 的 `normalizeRemoteUrl`（`manual` 方式直接复用它）。
 */

import { normalizeRemoteUrl } from './remoteUrl';
import type { RemoteUrlCheck } from './remoteUrl';

/** 局域网直连（默认方式）：平板与电脑同一 Wi-Fi，零安装。 */
export const REMOTE_MODE_LAN: string = 'lan';
/** Tailscale 组网：平板侧必须有鸿蒙原生客户端（卓易通里的安卓版不生效）。 */
export const REMOTE_MODE_TAILSCALE: string = 'tailscale';
/** 公网 IPv6 直连：要公网 v6 + 路由器放行入站。 */
export const REMOTE_MODE_IPV6: string = 'ipv6';
/** Cloudflare 隧道（Quick Tunnel / 命名隧道），对外恒 https。 */
export const REMOTE_MODE_CLOUDFLARE: string = 'cloudflare';
/** 手动填完整地址：App 只做归一与保存，不代管监听。 */
export const REMOTE_MODE_MANUAL: string = 'manual';
/**
 * 网易 UU 远程：**可用（需准备）** —— 官方「图形化端口映射」（免费版含）把本机 DSH 端口
 * 映射成对外入口，用户在 App 里粘那个入口即可。
 */
export const REMOTE_MODE_UU: string = 'uu';

/** 可用：本仓库可直接落地。 */
export const REMOTE_AVAILABILITY_READY: string = 'ready';
/** 需准备：技术上可行，但要用户先装客户端 / 开账号 / 放行防火墙。 */
export const REMOTE_AVAILABILITY_NEEDS_SETUP: string = 'needs-setup';
/** 不可用：至少一条硬条件不满足，UI 必须原样显示原因（`unavailableReason`）。 */
export const REMOTE_AVAILABILITY_UNSUPPORTED: string = 'unsupported';

/** 端口上限（与插件侧 `RemoteSettings.port` 的合法区间一致）。 */
export const REMOTE_PORT_MAX: number = 65535;

/** 端口字段的键名（唯一「不必填」的字段：0 是合法值，见文件头差异说明）。 */
const KEY_PORT: string = 'port';

/** 「访问令牌（可选）」字段的键名（与插件侧 `RemoteSettings.token` 同名，见 §3 表）。 */
const KEY_TOKEN: string = 'token';

/**
 * 访问令牌的合法字符集与长度（与插件侧 `RemoteSettings.token` 的落盘校验逐字一致）。
 *
 * 只允许 URL 安全的一小撮字符：字母数字 + `+ / = _ -`（base64 / base64url / hex 都能覆盖），
 * 长度 8–512。**不放宽**：令牌会被 `encodeURIComponent` 后拼进地址，允许空格/引号/`&`/`#`
 * 只会让「地址看起来对、实际被截断」，不如在这里明确拒绝。
 */
export const REMOTE_TOKEN_PATTERN: RegExp = /^[A-Za-z0-9+/=_-]{8,512}$/;

/** 令牌不合法时的中文原因（**只描述规则，永不回显令牌值**）。 */
export const REMOTE_TOKEN_INVALID_REASON: string =
  '访问令牌只允许字母数字与 + / = _ -，长度 8–512';

/** 一个方式需要用户填的字段（`key` 与插件侧 `RemoteSettingKey` 同名）。 */
export interface RemoteModeField {
  /** 字段名，与 `RemoteAccessConfig` 的属性同名。 */
  key: string;
  /** 给用户看的短标签（表单标题）。 */
  label: string;
  /** 输入框占位符（示例值）。 */
  placeholder: string;
  /** 一行提示（填什么 / 别填什么）。 */
  hint: string;
}

/** 一种访问方式的元数据（UI 渲染 + 文档表格同源）。 */
export interface RemoteModeSpec {
  /** 方式枚举值（`REMOTE_MODE_*`）。 */
  mode: string;
  /** 方式名（下拉框里显示这一项）。 */
  label: string;
  /** 一句话说明（下拉框下方）。 */
  description: string;
  /** 可用性：`ready` / `needs-setup` / `unsupported`。 */
  availability: string;
  /** `unsupported` 时给用户看的中文原因；其余方式为空串。 */
  unavailableReason: string;
  /** 用户要准备的前提（客户端 / 账号 / 系统设置），UI 至少显示第一条。 */
  requires: string[];
  /** 该方式要填的字段（顺序即 UI 顺序）。 */
  fields: RemoteModeField[];
  /** 用户侧操作步骤。 */
  steps: string[];
}

/** 方式顺序 = 下拉框顺序：从最可能可用到最不推荐（`uu` 恒排末尾，与插件侧一致）。 */
export const REMOTE_MODE_ORDER: string[] = [
  REMOTE_MODE_LAN,
  REMOTE_MODE_TAILSCALE,
  REMOTE_MODE_IPV6,
  REMOTE_MODE_CLOUDFLARE,
  REMOTE_MODE_MANUAL,
  REMOTE_MODE_UU
];

/** 端口字段（所有要起监听的方式共用，文案与插件侧一致）。 */
function portField(): RemoteModeField {
  const field: RemoteModeField = {
    key: KEY_PORT,
    label: '端口',
    placeholder: '3080',
    // 端口在 lan/ipv6/tailscale 下是必填（App 拿不到电脑上的 DSH 端口），所以这里不能再说
    // 「0 = 跟 DSH 同端口」——真机验收时用户看到那句话会留空，然后按钮变灰（2026-11-17 实测）。
    hint: '电脑上 DSH 设置 → 远程访问 里显示的那个端口（如 3080）'
  };
  return field;
}

/**
 * 「访问令牌（可选）」字段：出现在 `lan` / `ipv6` / `tailscale` / `uu` 的字段表里（地址之后）。
 *
 * 与插件侧 `RemoteSettings.token` 同一套语义：空串 = 不追加任何参数；非空 = 地址后追加
 * `?token=<值>`。`cloudflare` / `manual` **没有**这个字段（隧道域名/完整地址自带参数，
 * 用户手填的完整地址里通常已经带好了 token），所以不给它们画一个"填了也没用"的输入框。
 * `uu` 复用同一个 `token` 字段：映射出来的对外入口可能仍要过 DSH 的令牌校验。
 */
function tokenField(): RemoteModeField {
  const field: RemoteModeField = {
    key: KEY_TOKEN,
    label: '访问令牌（可选）',
    placeholder: '粘贴电脑上 DSH 地址里的 token',
    hint: '留空则不带令牌；填了会在链接里追加 ?token=…'
  };
  return field;
}

/** 六种方式的元数据表（键 = 方式枚举值）。 */
export const REMOTE_MODES: Record<string, RemoteModeSpec> = {
  'lan': {
    mode: REMOTE_MODE_LAN,
    label: '局域网直连',
    description: '平板和电脑连同一个 Wi-Fi，直接用局域网地址打开。',
    availability: REMOTE_AVAILABILITY_READY,
    unavailableReason: '',
    requires: ['平板和电脑在同一 Wi-Fi 或局域网里'],
    fields: [
      {
        key: 'lanAddress',
        label: '局域网地址',
        placeholder: '192.168.1.6',
        hint: '电脑在局域网里的 IPv4，可在「设置 → 网络」里看'
      },
      portField(),
      tokenField()
    ],
    steps: [
      '在电脑「设置 → 网络」里查看当前 Wi-Fi 的 IPv4 地址。',
      '把地址填进「局域网地址」；端口留 0 就是跟 DSH 同端口。',
      '平板连同一个 Wi-Fi，再回 App 点「打开远程控制」。'
    ]
  },
  'tailscale': {
    mode: REMOTE_MODE_TAILSCALE,
    label: 'Tailscale 组网',
    description:
      '电脑和装了 Tailscale 的平板组成虚拟内网，走 100.x 地址；卓易通里装的安卓 Tailscale 不能给本机 App 用。',
    availability: REMOTE_AVAILABILITY_NEEDS_SETUP,
    unavailableReason: '',
    requires: [
      '平板需装鸿蒙原生 Tailscale 客户端（如 HarmoTail，需侧载）',
      '电脑装 Tailscale 并登录同一账号',
      '卓易通里装的安卓 Tailscale 不能给本机 App 用'
    ],
    fields: [
      {
        key: 'tailscaleHost',
        label: 'Tailscale 地址',
        placeholder: '100.101.102.103',
        hint: '电脑在 Tailscale 里的 100.x 地址或 MagicDNS 名'
      },
      portField(),
      tokenField()
    ],
    steps: [
      '电脑上安装 Tailscale 客户端并登录同一个账号。',
      '平板侧载安装鸿蒙原生客户端（例如 HarmoTail）。',
      '在 Tailscale 后台「设备」列表里复制电脑的 100.x 地址。',
      '把 100.x 地址填进「Tailscale 地址」，端口留 0。',
      '平板能打开这个 100.x 地址后，再回 App 打开链接。'
    ]
  },
  'ipv6': {
    mode: REMOTE_MODE_IPV6,
    label: '公网 IPv6 直连',
    description: '家里宽带有公网 IPv6 时，平板用流量也能直接连到电脑。',
    availability: REMOTE_AVAILABILITY_NEEDS_SETUP,
    unavailableReason: '',
    requires: [
      '家里宽带已开通公网 IPv6（多数新装宽带默认有）',
      '光猫或路由器放行该端口的入站访问',
      '平板所在网络（Wi-Fi 或流量）也支持 IPv6'
    ],
    fields: [
      {
        key: 'ipv6Address',
        label: 'IPv6 地址',
        placeholder: '2409:8a20:4cad:ba20:1234:5678:9abc:def0',
        hint: '只填地址，不要带 [ ] 方括号'
      },
      portField(),
      tokenField()
    ],
    steps: [
      '电脑上运行 ipconfig，找「IPv6 地址」里不带「临时」的那条。',
      '它要以 2 或 3 开头；fe80 开头的是内网地址，不能用。',
      '把地址去掉方括号后填进「IPv6 地址」字段。',
      '在光猫或路由器上给这个端口放行入站 IPv6。',
      '平板用手机流量打开链接测试；打不开多半是运营商没给 IPv6。'
    ]
  },
  'cloudflare': {
    mode: REMOTE_MODE_CLOUDFLARE,
    label: 'Cloudflare 隧道',
    description: '电脑上跑 cloudflared，得到一个 https 网址，平板不用装东西。',
    availability: REMOTE_AVAILABILITY_NEEDS_SETUP,
    unavailableReason: '',
    requires: [
      '电脑上装 cloudflared（Cloudflare 官方命令行工具）',
      '用 quick tunnel 试，或有自有域名时配命名隧道（更稳定）'
    ],
    // 隧道对外只有 443，端口设置不参与（写进地址反而打不开），因此这里没有端口字段。
    fields: [
      {
        key: 'cloudflareHost',
        label: '隧道域名',
        placeholder: 'xxx.trycloudflare.com',
        hint: 'cloudflared 打印的域名，不带 https:// 和路径'
      }
    ],
    steps: [
      '电脑上装 cloudflared（官网下载 exe，或用 winget 安装）。',
      '运行 cloudflared tunnel --url http://127.0.0.1:40596。',
      '命令行会打印 https://xxx.trycloudflare.com，复制这个域名。',
      '把域名填进「隧道域名」，不要带 https:// 和路径。',
      'quick tunnel 每次重启域名都会变；长期用请配命名隧道。'
    ]
  },
  'manual': {
    mode: REMOTE_MODE_MANUAL,
    label: '手动填地址',
    description: '你自己已有一条能访问这台电脑的地址，App 只负责保存与归一。',
    availability: REMOTE_AVAILABILITY_READY,
    unavailableReason: '',
    requires: ['你自己已有的可用地址（如反向代理、花生壳）'],
    fields: [
      {
        key: 'manualUrl',
        label: '完整地址',
        placeholder: 'https://example.com/?token=…',
        hint: '必须带 http:// 或 https://；可以带 ?token= 参数'
      }
    ],
    steps: [
      '把能访问这台电脑的完整地址（含 http:// 或 https://）填进来。',
      '点「打开远程控制」，能打开 DSH 页面就说明可用。'
    ]
  },
  'uu': {
    mode: REMOTE_MODE_UU,
    label: '网易 UU 远程',
    description: '用 UU 远程的图形化端口映射把本机 DSH 端口映射成对外入口，平板打开那个入口。',
    availability: REMOTE_AVAILABILITY_NEEDS_SETUP,
    // 可用（需准备）：官方 blog 明确「图形化端口映射」免费版包含，故不再有不可用原因。
    unavailableReason: '',
    requires: [
      '电脑装 UU 远程并登录（免费版含端口映射）',
      '在 UU 远程 →「图形化端口映射」里把内部端口设为 DSH 端口'
    ],
    // 复用既有字段：对外入口地址（`manualUrl`）+ 可选令牌（`token`），不新增存储字段。
    fields: [
      {
        key: 'manualUrl',
        label: '对外入口地址',
        placeholder: '从 UU 远程复制，如 abc.uuyc.com:12345 或 https://…',
        hint: 'UU远程 → 图形化端口映射 → 内部端口填 DSH 端口 → 复制生成的对外入口'
      },
      tokenField()
    ],
    steps: [
      '在电脑上启动 DSH，记下「设置 → 远程访问」里显示的端口（如 3080）。',
      '打开 UU 远程 →「图形化端口映射」，新增一条映射，内部端口填上面那个 DSH 端口。',
      '映射生效后，复制 UU 远程生成的对外入口地址。',
      '把入口粘到「对外入口地址」；带不带 https:// 都可以，入口形态以实测为准。',
      '平板打开这个入口；打不开时回 UU 远程确认映射还在生效。'
    ]
  }
};

/** 按 UI 顺序列出方式元数据（返回新数组，调用方乱改不会污染常量表）。 */
export function listRemoteModes(): RemoteModeSpec[] {
  const modes: RemoteModeSpec[] = [];
  for (const mode of REMOTE_MODE_ORDER) {
    const spec: RemoteModeSpec | undefined = REMOTE_MODES[mode];
    if (spec !== undefined) {
      modes.push(spec);
    }
  }
  return modes;
}

/**
 * 按枚举值取方式元数据；未知/空/非字符串返回 `null`。
 *
 * 只认**精确**枚举值（不 trim、不做大小写容错）：App 下拉框、插件 UI、RPC 共用同一套枚举，
 * 多出来的宽容只会掩盖「前端传了错值」这类 bug。
 */
export function findRemoteMode(raw: string): RemoteModeSpec | null {
  if (typeof raw !== 'string') {
    return null;
  }
  if (REMOTE_MODE_ORDER.indexOf(raw) < 0) {
    return null;
  }
  const spec: RemoteModeSpec | undefined = REMOTE_MODES[raw];
  return spec === undefined ? null : spec;
}

/** 归一方式枚举：未知/空一律回落 `lan`（默认方式，也是唯一零安装可用的）。 */
export function normalizeRemoteMode(raw: string): string {
  const text: string = typeof raw === 'string' ? raw.trim() : '';
  const spec: RemoteModeSpec | null = findRemoteMode(text);
  return spec === null ? REMOTE_MODE_LAN : spec.mode;
}

/**
 * 该方式能不能真的打开一个地址。
 *
 * `unsupported`（目前**没有**方式是这个值）一律 `false`；未知方式也 `false`（fail-closed，不猜）。
 * 注意 `needs-setup` 是 `true`：用户按 `requires` 做完准备就能用（`uu` 也在这一类），
 * 不该被本函数挡死。
 */
export function remoteModeUsable(mode: string): boolean {
  const spec: RemoteModeSpec | null = findRemoteMode(mode);
  if (spec === null) {
    return false;
  }
  return spec.availability !== REMOTE_AVAILABILITY_UNSUPPORTED;
}

/** 一次远程访问的完整配置（字段名与插件侧 `RemoteSettings` 同名，见 §3 表）。 */
export interface RemoteAccessConfig {
  /** 访问方式（`REMOTE_MODE_*`）。 */
  mode: string;
  /** 局域网方式要填的具体 IPv4（空串 = 未填）。 */
  lanAddress: string;
  /** 旁挂监听端口；`0` = App 侧不写端口段（跟 DSH 同端口）。 */
  port: number;
  /** Tailscale 方式要填的 100.x 地址或 MagicDNS 名。 */
  tailscaleHost: string;
  /** Cloudflare 隧道域名（不带 `https://`、不带路径）。 */
  cloudflareHost: string;
  /** 公网 IPv6 地址（**不带**方括号）。 */
  ipv6Address: string;
  /** 手动方式的完整地址（可含 `?token=`）。 */
  manualUrl: string;
  /**
   * 「访问令牌（可选）」（与插件侧 `RemoteSettings.token` 同名同义）。
   *
   * 空串 = 不往地址里追加任何令牌参数；非空 = 拼成 `?token=<值>`（已有 query 时用 `&`）。
   * 对 `lan` / `ipv6` / `tailscale` / `uu` 生效（`cloudflare` / `manual` 没有这个字段）。
   * 它是 secret：**永不**出现在失败原因 / 日志里（`validateRemoteToken` 的原因只描述规则）。
   */
  token: string;
}

/** 默认配置：`lan` + 端口 0 + 所有地址留空（与插件侧 `defaultRemoteSettings` 的字段默认值一致）。 */
export function defaultRemoteAccessConfig(): RemoteAccessConfig {
  const config: RemoteAccessConfig = {
    mode: REMOTE_MODE_LAN,
    lanAddress: '',
    port: 0,
    tailscaleHost: '',
    cloudflareHost: '',
    ipv6Address: '',
    manualUrl: '',
    token: ''
  };
  return config;
}

/** 归一端口：非数/NaN/负数 → 0；超过 65535 → 65535；小数取整。 */
export function normalizeRemotePort(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }
  const whole: number = Math.trunc(value);
  if (whole <= 0) {
    return 0;
  }
  return whole > REMOTE_PORT_MAX ? REMOTE_PORT_MAX : whole;
}

/** 读一个持久化字段：非字符串 → 空串；字符串去首尾空白（地址里的空白没有意义）。 */
function readText(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** `JSON.parse` 的落点（全部可选：缺字段 = 用默认值，旧数据/手改文件都能读）。 */
interface RawRemoteAccess {
  mode?: string;
  lanAddress?: string;
  port?: number;
  tailscaleHost?: string;
  cloudflareHost?: string;
  ipv6Address?: string;
  manualUrl?: string;
  token?: string;
}

/**
 * 反序列化 + 归一配置（**不抛异常**）。
 *
 * 空串、坏 JSON、数组、`null`、未知 mode、负端口、非字符串字段全部回落默认值/空串：
 * 这条路径在设置页启动时跑，任何异常都会让整页设置打不开，而坏配置本身并不致命。
 */
export function normalizeRemoteAccessConfig(raw: string): RemoteAccessConfig {
  const fallback: RemoteAccessConfig = defaultRemoteAccessConfig();
  const text: string = typeof raw === 'string' ? raw.trim() : '';
  if (text.length === 0) {
    return fallback;
  }
  let parsed: RawRemoteAccess | null = null;
  try {
    parsed = JSON.parse(text) as RawRemoteAccess;
  } catch {
    return fallback;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return fallback;
  }
  const config: RemoteAccessConfig = {
    mode: normalizeRemoteMode(readText(parsed.mode)),
    lanAddress: readText(parsed.lanAddress),
    port: normalizeRemotePort(parsed.port === undefined ? 0 : parsed.port),
    tailscaleHost: readText(parsed.tailscaleHost),
    cloudflareHost: readText(parsed.cloudflareHost),
    ipv6Address: readText(parsed.ipv6Address),
    manualUrl: readText(parsed.manualUrl),
    // 旧数据没有 token 字段 → 空串（= 不带令牌，行为与升级前一致）；非字符串同样按空串
    token: readText(parsed.token)
  };
  return config;
}

/**
 * 序列化配置（固定键顺序 + 先归一）。
 *
 * 幂等：`serialize(normalize(serialize(x))) === serialize(x)` —— preferences 里不会因为
 * 一次读写来回而变形成第二个版本，diff 也就不会噪声化。
 */
export function serializeRemoteAccessConfig(config: RemoteAccessConfig): string {
  const plain: RawRemoteAccess = {
    mode: normalizeRemoteMode(config.mode),
    lanAddress: readText(config.lanAddress),
    port: normalizeRemotePort(config.port),
    tailscaleHost: readText(config.tailscaleHost),
    cloudflareHost: readText(config.cloudflareHost),
    ipv6Address: readText(config.ipv6Address),
    manualUrl: readText(config.manualUrl),
    token: readText(config.token)
  };
  return JSON.stringify(plain);
}

/** 按字段名取配置里的字符串值（ArkTS 不允许用字符串下标取接口属性，故用 switch）。 */
function fieldValue(config: RemoteAccessConfig, key: string): string {
  switch (key) {
    case 'port':
      return String(normalizeRemotePort(config.port));
    case 'lanAddress':
      return readText(config.lanAddress);
    case 'tailscaleHost':
      return readText(config.tailscaleHost);
    case 'cloudflareHost':
      return readText(config.cloudflareHost);
    case 'ipv6Address':
      return readText(config.ipv6Address);
    case 'manualUrl':
      return readText(config.manualUrl);
    case 'token':
      return readText(config.token);
    default:
      return '';
  }
}

/**
 * 当前方式还缺哪些必填字段（UI 用它给字段飘红 / 提示「还差什么」）。
 *
 * 端口在 `lan` / `ipv6` / `tailscale` 下算**必填**：App 拿不到电脑上的 DSH 端口，
 * 省略端口只会打开 80，等于给一个注定打不开的地址（这比"报缺字段"更让人困惑）。
 * `cloudflare` / `manual` / `uu` 不看端口（隧道恒 443、手动方式与 UU 对外入口自带端口）。
 * 未知方式按 `normalizeRemoteMode` 归一成 `lan`，不会出现「不认识的 mode 缺 0 个字段」的假象。
 */
export function missingFields(mode: string, config: RemoteAccessConfig): string[] {
  const missing: string[] = [];
  const spec: RemoteModeSpec | null = findRemoteMode(normalizeRemoteMode(mode));
  if (spec === null) {
    return missing;
  }
  let usesPort: boolean = false;
  for (const field of spec.fields) {
    if (field.key === KEY_PORT) {
      usesPort = true;
      continue;
    }
    if (field.key === KEY_TOKEN) {
      // 令牌是**可选**字段：空 = 不带令牌（合法），不能算「缺字段」，否则按钮永远飘红
      continue;
    }
    if (fieldValue(config, field.key).length === 0) {
      missing.push(field.key);
    }
  }
  if (usesPort && normalizeRemotePort(config.port) <= 0) {
    missing.push(KEY_PORT);
  }
  return missing;
}

/**
 * 校验「访问令牌（可选）」（与插件侧 `RemoteSettings.token` 的规则逐字一致）。
 *
 * 返回空串 = 合法（**含空串**：不填令牌是合法状态）；否则返回可直接展示的中文原因。
 * 原因里**绝不能**带令牌值——它是 secret，会随红字/日志/截图外泄（插件侧同一条纪律）。
 * 这里只 `trim()`（粘贴时常见的换行/空格不算令牌的一部分），中间有空格会被正则挡下。
 */
export function validateRemoteToken(raw: string): string {
  const text: string = typeof raw === 'string' ? raw.trim() : '';
  if (text.length === 0) {
    return '';
  }
  if (REMOTE_TOKEN_PATTERN.test(text)) {
    return '';
  }
  return REMOTE_TOKEN_INVALID_REASON;
}

/**
 * 令牌打码（供 UI 显示「已保存」，形如 `abcd…wxyz`）。
 *
 * 太短的令牌（< 12）整串打码成 `***`：留 8 个字符的短令牌只剩 4 位可见，
 * 遮不住也认不出，不如一律 `***`。打码串**只**用于展示，永远不会被当成令牌使用。
 */
export function maskRemoteToken(token: string): string {
  const text: string = typeof token === 'string' ? token.trim() : '';
  if (text.length < 12) {
    return '***';
  }
  return `${text.slice(0, 4)}…${text.slice(text.length - 4)}`;
}

/** 一条「能打开」的地址判定结果；失败时 `url` 恒为空串。 */
export interface RemoteAccessUrlResult {
  ok: boolean;
  url: string;
  reason: string;
}

/** 内部构造：成功。 */
function urlPassed(url: string): RemoteAccessUrlResult {
  const result: RemoteAccessUrlResult = { ok: true, url: url, reason: '' };
  return result;
}

/** 内部构造：失败（`url` 恒为空串，调用方拿到空串就不会去打开）。 */
function urlFailed(reason: string): RemoteAccessUrlResult {
  const result: RemoteAccessUrlResult = { ok: false, url: '', reason: reason };
  return result;
}

/** `:端口` 段；`port <= 0` 表示不写端口（交给地址自身决定）。 */
function portSuffix(port: number): string {
  return port > 0 ? `:${port}` : '';
}

/**
 * 把令牌追加到已拼好的地址上：`?token=<encodeURIComponent(令牌)>`。
 *
 * 两条容易踩的细节：
 * 1. **已有 query 时用 `&`**（例如地址本身带参数），否则会拼出两个 `?`；
 * 2. **必须落在 fragment（`#`）之前**，否则 `#` 后的内容会被浏览器当成片段，令牌根本不发出去。
 *
 * 独立导出是刻意为之：`buildRemoteAccessUrl` 目前只产出不带 query 的地址（`lan`/`ipv6`/
 * `tailscale` 都是 `http://host:port/`），但这两条规则必须能被单测直接验证。
 */
export function appendRemoteToken(url: string, token: string): string {
  const pair: string = `token=${encodeURIComponent(token)}`;
  const hashIndex: number = url.indexOf('#');
  const head: string = hashIndex < 0 ? url : url.slice(0, hashIndex);
  const tail: string = hashIndex < 0 ? '' : url.slice(hashIndex);
  const separator: string = head.indexOf('?') >= 0 ? '&' : '?';
  return `${head}${separator}${pair}${tail}`;
}

/**
 * 给一种方式的地址收尾：空令牌原样返回，非空令牌先校验再追加。
 *
 * 令牌非法时 `ok:false` + 中文原因（原因里没有令牌值）——宁可让用户改令牌，
 * 也不拼一条「令牌被截断、打开后 401」的地址。
 */
function withRemoteToken(url: string, config: RemoteAccessConfig): RemoteAccessUrlResult {
  const token: string = readText(config.token);
  if (token.length === 0) {
    return urlPassed(url);
  }
  const problem: string = validateRemoteToken(token);
  if (problem.length > 0) {
    return urlFailed(problem);
  }
  return urlPassed(appendRemoteToken(url, token));
}

/**
 * 端口必填校验（`lan` / `ipv6` / `tailscale`）。
 *
 * 为什么不允许省略：省略端口 = 浏览器按 80 打开，而 DSH 几乎不会在 80 上。
 * 与其给一条「看起来合法、实际打不开」的地址，不如直接要求用户填端口。
 */
function portProblem(port: number): string {
  if (port > 0) {
    return '';
  }
  return '请先填端口（电脑上 DSH 设置 → 远程访问 里显示的那个端口）';
}

/**
 * 主机名 / IP 字面量的「裸值」检查（方式字段不是完整 URL）。
 *
 * 返回空串 = 通过；否则是可直接展示的中文原因。这里只挡「形状明显不对」的输入
 * （带协议 / 路径 / 参数 / 账号密码 / 空格），真正的合法性由拼好的地址再过一遍
 * `normalizeRemoteUrl` 保证。
 */
function bareHostProblem(text: string): string {
  if (text === '*') {
    return '不能用通配地址（*），请填具体的主机名或 IP';
  }
  if (/[\s\u3000]/.test(text)) {
    return '不能有空格';
  }
  if (text.indexOf('://') >= 0) {
    return '不要带 http:// 或 https://';
  }
  if (text.indexOf('/') >= 0) {
    return '不要带路径';
  }
  if (text.indexOf('?') >= 0 || text.indexOf('#') >= 0) {
    return '不要带参数';
  }
  if (text.indexOf('@') >= 0) {
    return '不要带账号密码';
  }
  return '';
}

/** IPv4/主机名形态的地址：不允许冒号（否则「地址里有端口」会拼出双端口）。 */
function addressFieldProblem(text: string): string {
  const base: string = bareHostProblem(text);
  if (base.length > 0) {
    return base;
  }
  if (text.indexOf(':') >= 0) {
    return '不要带端口，端口填在下面';
  }
  return '';
}

/** 去掉用户可能手输的方括号（§3：IPv6 字段**不接受**方括号，但粘贴时要容错）。 */
function stripBrackets(text: string): string {
  let out: string = text;
  if (out.startsWith('[')) {
    out = out.slice(1);
  }
  if (out.endsWith(']')) {
    out = out.slice(0, out.length - 1);
  }
  return out.trim();
}

/**
 * 给 UU 远程生成的「对外入口」补默认协议（**入口形态待实测**，理由见 `buildRemoteAccessUrl` 的 uu 分支）。
 *
 * 判定顺序：
 * 1. 空串 → 空串（调用方自己给「还没填」的原因）；
 * 2. 已写 `scheme://` → **原样**返回，交给 `normalizeRemoteUrl` 判是不是 http(s)（`ftp://` 会被它拒）；
 * 3. 没写协议但含 `/`（`abc.uuyc.com/dsh` 这类带路径的入口）→ 补 `https://`（像域名入口，默认走 TLS）；
 * 4. 其余（`abc.uuyc.com:12345` 这类 host:port）→ 补 `http://`（映射出来的端口通常直接是明文 HTTP）。
 *
 * 这是**临时默认**：实测出 UU 入口的真实形态后，只改这里与 uu 分支，别在页面里另写一份同义规则。
 */
function uuEntranceWithScheme(text: string): string {
  if (text.length === 0) {
    return '';
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(text)) {
    return text;
  }
  if (text.indexOf('/') >= 0) {
    return `https://${text}`;
  }
  return `http://${text}`;
}

/**
 * 按当前配置拼出一条可打开的地址。
 *
 * 各方式的期望产物（与 `docs/REMOTE-ACCESS-OPTIONS.md` §2 逐条对应）：
 * - `lan`        → `http://<lanAddress>:<port>/`（端口必填，`port<=0` 直接失败）；
 * - `ipv6`       → `http://[<ipv6Address>]:<port>/`（**保留方括号**，IPv6 在 URL 里必须裹起来）；
 * - `tailscale`  → `http://<tailscaleHost>:<port>/`；
 * - `cloudflare` → `https://<cloudflareHost>/`（隧道对外恒 443，端口不参与）；
 * - `manual`     → 复用 `normalizeRemoteUrl`（补 `http://`、校验 scheme/host/端口、识别 token）；
 * - `uu`         → 复用 `manualUrl`（UU 远程生成的对外入口），按 `uuEntranceWithScheme` 补默认协议
 *                  后再过 `normalizeRemoteUrl`；空入口 → `ok:false` +「还没填 UU 远程生成的对外入口」。
 *
 * 令牌（`config.token`，可选）对 `lan` / `ipv6` / `tailscale` / `uu` 生效：非空时在拼好的地址后
 * 追加 `?token=<encodeURIComponent(值)>`（已有 query 用 `&`，且落在 `#` 之前）；空串不加任何参数。
 * `cloudflare` / `manual` 没有这个字段（地址自带参数），`token` 一律不参与——
 * 这样「切到 manual 后残留的 token」不会污染用户手填的完整地址。
 *
 * 未知 mode 已由 `normalizeRemoteMode` 回落 `lan`，因此不会走到「不认识的方式」分支。
 */
export function buildRemoteAccessUrl(config: RemoteAccessConfig): RemoteAccessUrlResult {
  const mode: string = normalizeRemoteMode(config.mode);
  const port: number = normalizeRemotePort(config.port);

  if (mode === REMOTE_MODE_UU) {
    // UU 远程：用户在「图形化端口映射」里把内部 DSH 端口映射成对外入口，再把入口粘进来。
    // **入口形态待实测**：官方只说「复制生成的对外入口」，没写死一定带协议，所以这里按形状补
    // 默认协议（含 `/` → https，纯 host:port → http，已带协议则原样交给 normalizeRemoteUrl）。
    // 实测后只改 `uuEntranceWithScheme` 这一处（入口形态的规则只存在于那里）。
    const entrance: string = readText(config.manualUrl);
    if (entrance.length === 0) {
      return urlFailed('还没填 UU 远程生成的对外入口');
    }
    const check: RemoteUrlCheck = normalizeRemoteUrl(uuEntranceWithScheme(entrance));
    if (!check.ok) {
      return urlFailed(`对外入口不可用：${check.reason}`);
    }
    return withRemoteToken(check.url, config);
  }

  if (mode === REMOTE_MODE_MANUAL) {
    const check: RemoteUrlCheck = normalizeRemoteUrl(readText(config.manualUrl));
    const manual: RemoteAccessUrlResult = { ok: check.ok, url: check.url, reason: check.reason };
    return manual;
  }

  if (mode === REMOTE_MODE_CLOUDFLARE) {
    const host: string = readText(config.cloudflareHost);
    if (host.length === 0) {
      return urlFailed('还没有填写隧道域名，请填 cloudflared 打印出的那个域名');
    }
    const problem: string = bareHostProblem(host);
    if (problem.length > 0) {
      return urlFailed(`隧道域名不可用：${problem}`);
    }
    if (host.indexOf(':') >= 0) {
      return urlFailed('隧道域名不可用：不要带端口，隧道对外恒 443');
    }
    return urlPassed(`https://${host}/`);
  }

  if (mode === REMOTE_MODE_IPV6) {
    const portIssue: string = portProblem(port);
    if (portIssue.length > 0) {
      return urlFailed(portIssue);
    }
    const address: string = stripBrackets(readText(config.ipv6Address));
    if (address.length === 0) {
      return urlFailed('还没有填写 IPv6 地址，请先在电脑上查到本机公网 IPv6');
    }
    if (address.indexOf(':') < 0) {
      return urlFailed('IPv6 地址不可用：请填完整的 IPv6 地址（形如 2409:8a20:…），它必须带冒号');
    }
    const problem: string = bareHostProblem(address);
    if (problem.length > 0) {
      return urlFailed(`IPv6 地址不可用：${problem}`);
    }
    if (address === '::') {
      // 与 §3 表一致：未指定地址 `::` 不能当访问地址（它只是「任意网卡」的写法）
      return urlFailed('IPv6 地址不可用：不能用未指定地址（::），请填网卡上的具体 IPv6');
    }
    return withRemoteToken(`http://[${address}]${portSuffix(port)}/`, config);
  }

  if (mode === REMOTE_MODE_TAILSCALE) {
    const portIssue: string = portProblem(port);
    if (portIssue.length > 0) {
      return urlFailed(portIssue);
    }
    const host: string = readText(config.tailscaleHost);
    if (host.length === 0) {
      return urlFailed('还没有填写 Tailscale 地址，请填电脑在 Tailscale 里的 100.x 地址');
    }
    const problem: string = addressFieldProblem(host);
    if (problem.length > 0) {
      return urlFailed(`Tailscale 地址不可用：${problem}`);
    }
    return withRemoteToken(`http://${host}${portSuffix(port)}/`, config);
  }

  // 剩下就是 lan（默认方式）
  const lanPortIssue: string = portProblem(port);
  if (lanPortIssue.length > 0) {
    return urlFailed(lanPortIssue);
  }
  const address: string = readText(config.lanAddress);
  if (address.length === 0) {
    return urlFailed('还没有填写局域网地址，请填电脑在局域网里的 IPv4');
  }
  const problem: string = addressFieldProblem(address);
  if (problem.length > 0) {
    return urlFailed(`局域网地址不可用：${problem}`);
  }
  if (address === '0.0.0.0' || address === '::') {
    // 与 §3 表一致：通配地址是「所有网卡」，不是能打开的地址
    return urlFailed('局域网地址不可用：不能用通配地址（0.0.0.0 / ::），请填网卡上的具体 IPv4');
  }
  return withRemoteToken(`http://${address}${portSuffix(port)}/`, config);
}
