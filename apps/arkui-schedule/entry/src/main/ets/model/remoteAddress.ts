/**
 * mod-remote-page-webview（App 远程页）：地址归一 + 传输分类，唯一纯函数事实来源。
 *
 * 零 SDK import、零 UI import，Node 可直接单测（tools/tsconfig.json 编译 model/**）。
 * 页面/组件里**不许**再做字符串嗅探或写分类文案：一律调用本文件的函数取结果。
 *
 * 归一规则（normalizeHostPort）：
 * - 入参可以是 host（DNS / IPv4 / 裸 IPv6 / 带方括号 IPv6）、host:port、或完整 http(s) URL；
 *   也接受 `{ host, port, scheme? }` / `{ url, scheme? }` 这类配对载荷字段形态。
 * - **IPv6 内部存无括号小写十六进制**（`fd7a:115c:a1e0::1`），只在打印 URL 时加方括号
 *   （`https://[fd7a:115c:a1e0::1]:44996`）；大写十六进制按大小写不敏感归一为小写。
 * - DNS 名去掉**一个**结尾点（`foo.ts.net.` → `foo.ts.net`）并转小写；IPv6/zone-id 不去点。
 * - **zone-id（`%eth0` / `%25eth0`）一律拒绝**：不同网卡的同址不是同一个可达目标，猜等于谎报。
 * - 端口必填且必须在 1..65535；空 host、非 http(s) scheme、内嵌 `user:pass@` 一律拒绝。
 * - 输出 `url` 是**不含 path/query/token 的 origin**（`scheme://host:port`），供 pin 预检、
 *   allowance 键与断言使用；页面是否保留原有 query token 由页面自己决定，本函数永不携带凭证。
 * - IPv6 形态校验复用 `model/remoteUrl.ts` 的 `isIpv6Literal()`（那份规则已含拒绝 zone-id），
 *   不在这里写第二份解析。
 *
 * 分类 precedence（classifyTransport，纯、有序、互斥）：
 *   1. tailscale —— Tailscale IPv4 100.64.0.0/10（含两端 100.64.0.0 与 100.127.255.255）、
 *      Tailscale IPv6 fd7a:115c:a1e0::/48、以及 *.ts.net 名字；
 *   2. manual    —— 回环 ::1 / 127.0.0.0/8（选 manual：回环不是对端 LAN 设备，标成局域网会夸大）；
 *   3. ipv6      —— 其它一切 IPv6 字面量；
 *   4. lan       —— RFC1918 10/8、172.16/12、192.168/16，加 link-local 169.254/16
 *                  （选 lan：同链路自动地址确实属于本地网络，不是手工公网入口）；
 *   5. manual    —— 其余（公网 IPv4、普通域名、UU/Cloudflare 入口等）。
 *   Tailscale 优先级最高：100.x 也是私网段的一种，但它是 tailnet 语义，不能再叫「局域网」。
 */

import { isIpv6Literal } from './remoteUrl';

/** 传输类别（互斥，恰好四个值）。 */
export type TransportKind = 'lan' | 'ipv6' | 'tailscale' | 'manual';

/** 允许的 scheme（只有 http / https；大小写不敏感，输出小写）。 */
export type AddressScheme = 'http' | 'https';

/** normalizeHostPort 的成功/失败统一结果。失败时 host/port/scheme/url 全为空。 */
export interface HostPortCheck {
  ok: boolean;
  /** IPv6 存无括号小写；DNS 小写且去尾部点。失败为空串。 */
  host: string;
  /** 1..65535；失败为 0。 */
  port: number;
  /** 'http' | 'https'；失败为空串。 */
  scheme: string;
  /** `scheme://[ipv6]:port` 或 `scheme://dns:port`；不含 path/query/token。失败为空串。 */
  url: string;
  /** 可直接上屏的中文原因；成功为空串。 */
  reason: string;
}

/** 配对载荷 / 手工输入可能给出的字段形态；字符串形态直接当 host[:port] 或完整 URL。 */
export interface HostPortInput {
  host?: string;
  port?: number | string;
  scheme?: string;
  url?: string;
}

/** 输入联合类型：纯字符串或字段对象。 */
export type HostPortSource = string | HostPortInput | null | undefined;

/** 内部：host 是不是 IPv6 字面量（无方括号）。 */
function isIpv6(host: string): boolean {
  return host.indexOf(':') >= 0 && isIpv6Literal(host);
}

/** 内部：IPv6 打印形态。 */
function printHost(host: string): string {
  return isIpv6(host) ? `[${host}]` : host;
}

/** 内部：构造成功结果。 */
function passed(host: string, port: number, scheme: AddressScheme): HostPortCheck {
  const result: HostPortCheck = {
    ok: true,
    host: host,
    port: port,
    scheme: scheme,
    url: `${scheme}://${printHost(host)}:${port}`,
    reason: ''
  };
  return result;
}

/** 内部：构造失败结果（fail-closed：不给半截值去连）。 */
function failed(reason: string): HostPortCheck {
  const result: HostPortCheck = {
    ok: false, host: '', port: 0, scheme: '', url: '', reason: reason
  };
  return result;
}

/** 失败文案（固定，集中定义）。 */
const REASON_EMPTY: string = '地址缺少主机或端口';
const REASON_PORT: string = '端口必须是 1..65535 之间的数字';
const REASON_SCHEME: string = '地址只支持 http 或 https';
const REASON_IPV6: string = 'IPv6 地址格式不正确';
const REASON_ZONE: string = 'IPv6 地址不能带网卡后缀（%zone），请去掉后重试';
const REASON_HOST: string = '地址主机不合法（不能带账号密码或空格）';

/** 端口字符串形态只接受纯十进制 1..5 位。 */
const PORT_TEXT_RE: RegExp = /^[0-9]{1,5}$/;

/** DNS / IPv4 允许的字符集（不含 `%`、`@`、`:`、`/`、空白）。 */
const DNS_RE: RegExp = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** 协议前缀（只取 scheme 名）。 */
const SCHEME_RE: RegExp = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//i;

/** 解析端口字段；非法返回 0。 */
function parsePort(raw: number | string | undefined): number {
  if (typeof raw === 'number') {
    if (!Number.isInteger(raw) || raw < 1 || raw > 65535) {
      return 0;
    }
    return raw;
  }
  if (typeof raw !== 'string' || !PORT_TEXT_RE.test(raw)) {
    return 0;
  }
  const port: number = Number(raw);
  return port >= 1 && port <= 65535 ? port : 0;
}

/**
 * 把 host 字段归一：IPv6 去方括号转小写；DNS 去一个尾部点并转小写。
 * 任何 zone-id / userinfo / 空白都在这里拒绝（不猜、不放行）。
 */
function normalizeHostField(raw: string): string {
  const text: string = typeof raw === 'string' ? raw.trim() : '';
  if (text.length === 0) {
    return '';
  }
  if (text.indexOf('%') >= 0 || text.indexOf('@') >= 0 || /[\s\u3000]/.test(text)) {
    return '';
  }
  if (text.startsWith('[')) {
    const close: number = text.indexOf(']');
    if (close < 0 || close !== text.length - 1) {
      return '';
    }
    const inner: string = text.slice(1, close).toLowerCase();
    return isIpv6Literal(inner) ? inner : '';
  }
  if (text.indexOf(':') >= 0) {
    const lower: string = text.toLowerCase();
    return isIpv6Literal(lower) ? lower : '';
  }
  let host: string = text;
  if (host.endsWith('.')) {
    host = host.slice(0, host.length - 1);
  }
  if (host.length === 0 || !DNS_RE.test(host)) {
    return '';
  }
  return host.toLowerCase();
}

/** 从 `scheme://authority/rest` 里拆出 scheme 与 authority（authority 不含 path/query/fragment）。 */
function splitUrl(text: string): { scheme: string; authority: string; hasScheme: boolean } | null {
  const matched: RegExpExecArray | null = SCHEME_RE.exec(text);
  if (matched === null) {
    let end: number = text.length;
    for (const mark of ['/', '?', '#']) {
      const at: number = text.indexOf(mark);
      if (at >= 0 && at < end) {
        end = at;
      }
    }
    return { scheme: '', authority: text.slice(0, end), hasScheme: false };
  }
  const scheme: string = matched[1].toLowerCase();
  const rest: string = text.slice(matched[0].length);
  let end: number = rest.length;
  for (const mark of ['/', '?', '#']) {
    const at: number = rest.indexOf(mark);
    if (at >= 0 && at < end) {
      end = at;
    }
  }
  return { scheme: scheme, authority: rest.slice(0, end), hasScheme: true };
}

/** 从 `[ipv6]:port` / `dns:port` / `ipv6` 里拆出 host 与端口原文。 */
function splitAuthority(authority: string): { host: string; portText: string | undefined } | null {
  if (authority.length === 0) {
    return null;
  }
  if (authority.startsWith('[')) {
    const close: number = authority.indexOf(']');
    if (close < 0) {
      return null;
    }
    const after: string = authority.slice(close + 1);
    if (after.length === 0) {
      return { host: authority.slice(0, close + 1), portText: undefined };
    }
    if (!after.startsWith(':')) {
      return null;
    }
    return { host: authority.slice(0, close + 1), portText: after.slice(1) };
  }
  const firstColon: number = authority.indexOf(':');
  if (firstColon < 0) {
    return { host: authority, portText: undefined };
  }
  // 带冒号但不含方括号：只可能是裸 IPv6（端口必须由字段对象单独给）。
  if (authority.indexOf(':', firstColon + 1) >= 0) {
    return { host: authority, portText: undefined };
  }
  return { host: authority.slice(0, firstColon), portText: authority.slice(firstColon + 1) };
}

/** 把 scheme 文本归一成 AddressScheme；空串 = 默认 http；其它 = 拒绝。 */
function normalizeScheme(raw: string | undefined, fallback: string): AddressScheme | null {
  const text: string = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  const chosen: string = text.length === 0 ? fallback : text;
  return chosen === 'http' || chosen === 'https' ? chosen : null;
}

/**
 * 归一 host/port/scheme/URL。见文件头的完整规则说明。
 *
 * 入参为字符串时支持 `host`、`host:port`、`[ipv6]:port`、`http(s)://…`；
 * 入参为对象时优先取 `url`，否则取 `host` + `port`，`scheme` 可缺省（默认 http）。
 */
export function normalizeHostPort(input: HostPortSource): HostPortCheck {
  let rawUrl: string = '';
  let rawHost: string = '';
  let rawPort: number | string | undefined;
  let rawScheme: string | undefined;

  if (typeof input === 'string') {
    rawUrl = input.trim();
  } else if (input !== null && input !== undefined && typeof input === 'object') {
    rawUrl = typeof input.url === 'string' ? input.url.trim() : '';
    rawHost = typeof input.host === 'string' ? input.host.trim() : '';
    rawPort = input.port;
    rawScheme = input.scheme;
  }
  if (rawUrl.length === 0 && rawHost.length === 0) {
    return failed(REASON_EMPTY);
  }

  let authority: string = '';
  let scheme: AddressScheme | null = null;
  if (rawUrl.length > 0) {
    const split = splitUrl(rawUrl);
    if (split === null) {
      return failed(REASON_HOST);
    }
    scheme = normalizeScheme(split.hasScheme ? split.scheme : rawScheme, 'http');
    if (scheme === null) {
      return failed(REASON_SCHEME);
    }
    authority = split.authority;
    const parts = splitAuthority(authority);
    if (parts === null) {
      return failed(REASON_EMPTY);
    }
    rawHost = parts.host;
    if (parts.portText !== undefined) {
      rawPort = parts.portText;
    }
  } else {
    scheme = normalizeScheme(rawScheme, 'http');
    if (scheme === null) {
      return failed(REASON_SCHEME);
    }
    // 对象形态的 host 字段可能自带 `[ipv6]:port`（配对载荷常见）。
    const parts = splitAuthority(rawHost);
    if (parts === null) {
      return failed(REASON_EMPTY);
    }
    rawHost = parts.host;
    if (parts.portText !== undefined) {
      rawPort = parts.portText;
    }
  }

  if (rawHost.indexOf('%') >= 0) {
    return failed(REASON_ZONE);
  }
  const host: string = normalizeHostField(rawHost);
  if (host.length === 0) {
    return failed(hostReason(rawHost));
  }
  const port: number = parsePort(rawPort);
  if (port === 0) {
    return failed(REASON_PORT);
  }
  return passed(host, port, scheme);
}

/** 内部：按 host 形态选失败文案（IPv6 形态错 vs DNS 形态错）。 */
function hostReason(rawHost: string): string {
  if (rawHost.indexOf('@') >= 0) {
    return REASON_HOST;
  }
  return rawHost.indexOf(':') >= 0 || rawHost.startsWith('[') ? REASON_IPV6 : REASON_HOST;
}

/** 地址键：allowance 绑定用。IPv6 打印成 `[host]:port`，DNS/IPv4 为 `host:port`。 */
export function hostPortKey(host: string, port: number): string {
  const text: string = typeof host === 'string' ? host.trim().toLowerCase() : '';
  if (text.length === 0 || !Number.isInteger(port) || port < 1 || port > 65535) {
    return '';
  }
  return `${printHost(text)}:${port}`;
}

// ------------------------------------------------------------------ 传输分类

/** IPv4 点分十进制 → 4 个字节；非纯 IPv4 返回 null。 */
function ipv4Bytes(host: string): number[] | null {
  const parts: string[] = host.split('.');
  if (parts.length !== 4) {
    return null;
  }
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])$/.test(part)) {
      return null;
    }
    bytes.push(Number(part));
  }
  return bytes;
}

/** IPv4 是否落在 CIDR 内（前缀位 0..32，边界含）。 */
function inIpv4Cidr(bytes: number[], base: number[], prefixBits: number): boolean {
  const value: number =
    (((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0);
  const network: number =
    (((base[0] << 24) | (base[1] << 16) | (base[2] << 8) | base[3]) >>> 0);
  if (prefixBits === 0) {
    return true;
  }
  const mask: number = prefixBits === 32 ? 0xffffffff : (0xffffffff << (32 - prefixBits)) >>> 0;
  return (value & mask) === (network & mask);
}

/** IPv6 展开成 8 个 16 位组；坏值返回 null。只处理合法形态（调用方已过 isIpv6Literal）。 */
function ipv6Groups(host: string): number[] | null {
  const text: string = host.toLowerCase();
  if (text.indexOf('%') >= 0) {
    return null;
  }
  const halves: string[] = text.split('::');
  if (halves.length > 2) {
    return null;
  }
  const parseHalf = (half: string): number[] => {
    if (half.length === 0) {
      return [];
    }
    const out: number[] = [];
    for (const group of half.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) {
        return [];
      }
      out.push(parseInt(group, 16));
    }
    return out;
  };
  const head: number[] = parseHalf(halves[0]);
  if (halves.length === 1) {
    return head.length === 8 ? head : null;
  }
  const tail: number[] = parseHalf(halves[1]);
  const zeros: number = 8 - head.length - tail.length;
  if (zeros < 1) {
    return null;
  }
  const groups: number[] = head.concat(new Array<number>(zeros).fill(0), tail);
  return groups.length === 8 ? groups : null;
}

/** Tailscale IPv6：fd7a:115c:a1e0::/48（前三个 16 位组固定）。 */
function isTailscaleIpv6(host: string): boolean {
  const groups: number[] | null = ipv6Groups(host);
  if (groups === null) {
    return false;
  }
  return groups[0] === 0xfd7a && groups[1] === 0x115c && groups[2] === 0xa1e0;
}

/**
 * 纯分类，precedence 见文件头。入参应是 normalizeHostPort 的结果；
 * 传脏值时不猜：不在任何白名单里 → 'manual'。
 */
export function classifyTransport(host: string, port: number): TransportKind {
  void port; // 分类只由 host 决定；保留 port 形参使调用方签名明确，未来按端口分叉也不改调用点
  const text: string = typeof host === 'string' ? host.trim().toLowerCase() : '';
  if (text.length === 0) {
    return 'manual';
  }

  // 1) Tailscale（最高优先级）。
  if (text === 'ts.net' || text.endsWith('.ts.net')) {
    return 'tailscale';
  }
  const v4: number[] | null = ipv4Bytes(text);
  if (v4 !== null && inIpv4Cidr(v4, [100, 64, 0, 0], 10)) {
    return 'tailscale';
  }
  if (isIpv6(text) && isTailscaleIpv6(text)) {
    return 'tailscale';
  }

  // 2) 回环选 manual（见文件头理由）。
  if (text === '::1' || (v4 !== null && inIpv4Cidr(v4, [127, 0, 0, 0], 8))) {
    return 'manual';
  }

  // 3) 其它 IPv6。
  if (isIpv6(text)) {
    return 'ipv6';
  }

  // 4) 局域网 IPv4（RFC1918 + link-local）。
  if (v4 !== null) {
    if (inIpv4Cidr(v4, [10, 0, 0, 0], 8) ||
        inIpv4Cidr(v4, [172, 16, 0, 0], 12) ||
        inIpv4Cidr(v4, [192, 168, 0, 0], 16) ||
        inIpv4Cidr(v4, [169, 254, 0, 0], 16)) {
      return 'lan';
    }
  }

  // 5) 其余。
  return 'manual';
}

/** 分类 → 中文短标签（chip）。文案只有这一份，组件不得内联。 */
export const TRANSPORT_LABELS: Readonly<Record<TransportKind, string>> = Object.freeze({
  'lan': '局域网',
  'ipv6': 'IPv6',
  'tailscale': 'Tailscale',
  'manual': '手动'
});

/** 取分类 chip 文案；未知值回落「手动」（fail-closed，不编造新类别）。 */
export function transportChip(kind: string): string {
  const text: string = typeof kind === 'string' ? kind : '';
  if (text === 'lan' || text === 'ipv6' || text === 'tailscale') {
    return TRANSPORT_LABELS[text];
  }
  return TRANSPORT_LABELS['manual'];
}
