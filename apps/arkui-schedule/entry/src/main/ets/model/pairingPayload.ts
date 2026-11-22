/**
 * 平板侧「手动配对」载荷解析 + TOFU 钉住（mod-instances-pairing）—— 纯逻辑，零 SDK import，Node 可直接单测。
 *
 * 与电脑插件 `packages/dsh-dots/src/remote/pairingPayload.ts` **共用同一字段语义与同一校验顺序**：
 *   `{v:1,instanceId,transport,host,port,token,tlsFingerprint,announceRef}`
 * 紧凑串 `DSHDOTS1|v|instanceId|transport|host|port|token|fingerprint|announceRef|checksum`
 * 与本文件互相可解析；校验和 FNV-1a 32 位只防手误，不是鉴权。
 *
 * 四条纪律：
 * 1. **token 是 bearer secret**：只允许出现在返回的 `payload.token` 与写进实例信封的内部值里；
 *    所有 typed `reason` 都是固定中文常量，**任何错误路径都不回显 token / host / 指纹的值**。
 * 2. **只认 v:1**：未知版本 `E_PAIRING_VERSION`，绝不猜着兼容。
 * 3. **主机归一**：IPv6 恒输出小写方括号形态（RFC5952 压缩）；IPv4 / 主机名小写、无协议 / 路径 / 端口；
 *    整数端口 1–65535；指纹接受 64 位十六进制或冒号分隔，统一输出 `AA:BB:…`。
 * 4. **只拼一次地址**：scheme/host/port → URL 只调用 `remoteAnnounceRefresh.announcementBaseUrl()`，
 *    本文件绝不写第二份 URL 拼装。
 *
 * 本路径是**手动配对**，与签名公告的两步同意流程（`remoteAnnounceRefresh` / `remoteAnnounceStore`）
 * 完全分开：公告那边的 pin 是 Ed25519 公钥指纹，这里的 pin 是 TLS 证书指纹，互不覆盖。
 */

import type { DsInstance } from './instances';
import { deriveCapabilities, instanceIdFromUrl, pinnedFingerprintPrefix, sortInstances } from './instances';
import { announcementBaseUrl } from './remoteAnnounceRefresh';
import { normalizeRemoteUrl } from './remoteUrl';
import { isIpv6Literal } from './remoteUrl';
import {
  REMOTE_MODE_IPV6,
  REMOTE_MODE_LAN,
  REMOTE_MODE_TAILSCALE
} from './remoteAccess';

/** 配对载荷版本（只认 1）。 */
export const PAIRING_VERSION: number = 1;

/** 紧凑手输串前缀。 */
export const PAIRING_TEXT_PREFIX: string = 'DSHDOTS1|';

/** 支持的传输方式（直连三种；无网关 / 无中继）。 */
export const PAIRING_TRANSPORTS: readonly string[] = ['tailscale', 'lan', 'ipv6'];

/** 规范键序：多一个 / 少一个字段都按 `E_PAIRING_MALFORMED` 拒绝。 */
export const PAIRING_KEYS: readonly string[] = [
  'v', 'instanceId', 'transport', 'host', 'port', 'token', 'tlsFingerprint', 'announceRef'
];

/** typed 错误码（与插件侧同心，另加 TOFU 冲突码）。 */
export type PairingErrorCode =
  | 'E_PAIRING_MALFORMED'
  | 'E_PAIRING_VERSION'
  | 'E_PAIRING_TRANSPORT'
  | 'E_PAIRING_HOST'
  | 'E_PAIRING_PORT'
  | 'E_PAIRING_TOKEN'
  | 'E_PAIRING_FINGERPRINT'
  | 'E_PAIRING_FINGERPRINT_MISMATCH';

/** 成功时 `code='ok'`；失败时 `payload=null` 且 `reason` 为固定中文文案。 */
export interface PairingParseResult {
  ok: boolean;
  payload: PairingPayload | null;
  code: PairingErrorCode | 'ok';
  reason: string;
}

/** 规范载荷（键序即 PAIRING_KEYS）。 */
export interface PairingPayload {
  v: number;
  instanceId: string;
  transport: string;
  host: string;
  port: number;
  token: string;
  tlsFingerprint: string;
  announceRef: string;
}

/** 主机 / 指纹归一的统一结果（失败 reason 永不含输入值）。 */
export interface PairingNormaliseResult {
  ok: boolean;
  value: string;
  reason: string;
}

/** 地址 + 一次性令牌所在实例的新增结果；`items` 为可直接落盘的整表。 */
export interface PairingAddResult {
  ok: boolean;
  items: DsInstance[];
  code: PairingErrorCode | 'ok';
  reason: string;
  /** 'added' = 首次配对并钉住；'updated' = 同 id 同指纹，只改地址 / 端口 / 令牌。 */
  action: string;
}

/**
 * TOFU 冲突的**逐字**上屏文案：点名后果（换机器 / 中间人）与唯一恢复手段（先删旧实例）。
 */
export const PAIRING_FINGERPRINT_MISMATCH_WORDING: string =
  '该实例的证书指纹与已保存的不同，可能是换了机器或中间人；请先在平板上删除旧实例再重新配对';

/** 成功提示（不含地址 / 指纹值 / 令牌）。 */
export const PAIRING_ADDED_WORDING: string = '已添加实例并固定证书指纹';
export const PAIRING_UPDATED_WORDING: string = '证书指纹一致，已更新实例地址';

const INSTANCE_ID_RE: RegExp = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TOKEN_RE: RegExp = /^[A-Za-z0-9+/=_-]{32,512}$/;
const FINGERPRINT_HEX_RE: RegExp = /^[0-9a-f]{64}$/i;
const ANNOUNCE_REF_RE: RegExp = /^[A-Za-z0-9._/-]{0,200}$/;
const TAILSCALE_RE: RegExp = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;
const RFC1918_RE: RegExp = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
const HOSTNAME_RE: RegExp = /^[a-z0-9][a-z0-9.-]*$/;

/** 内部：归一失败（reason 恒为固定文案）。 */
function normaliseFail(reason: string): PairingNormaliseResult {
  return { ok: false, value: '', reason: reason };
}

/** 内部：解析失败（payload 恒 null，reason 恒为固定文案）。 */
function parseFail(code: PairingErrorCode, reason: string): PairingParseResult {
  return { ok: false, payload: null, code: code, reason: reason };
}

/** 内部：内部新增失败（items 恒为空表）。 */
function addFail(code: PairingErrorCode, reason: string): PairingAddResult {
  return { ok: false, items: [], code: code, reason: reason, action: '' };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/** IPv4 文本归一：四段十进制、无前导零、0–255。 */
function normaliseIpv4Text(text: string): string {
  const parts: string[] = text.split('.');
  if (parts.length !== 4) {
    return '';
  }
  const out: string[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) {
      return '';
    }
    const value: number = Number(part);
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      return '';
    }
    out.push(String(value));
  }
  return out.join('.');
}

/**
 * IPv6 压缩为 RFC5952 风格小写形态。入参形态已由 `isIpv6Literal()` 验证；
 * 这里只做「展开 `::` → 去前导零 → 压缩最长零段」，内嵌 IPv4 尾段换成两组十六进制。
 */
function compressIpv6(text: string): string {
  let expanded: string = text.toLowerCase();
  const lastColon: number = expanded.lastIndexOf(':');
  if (lastColon >= 0 && expanded.slice(lastColon + 1).indexOf('.') >= 0) {
    const octets: string[] = expanded.slice(lastColon + 1).split('.');
    if (octets.length !== 4) {
      return '';
    }
    const values: number[] = [];
    for (const octet of octets) {
      const value: number = Number(octet);
      if (!/^(0|[1-9][0-9]{0,2})$/.test(octet) || !Number.isInteger(value) || value > 255) {
        return '';
      }
      values.push(value);
    }
    const high: string = ((values[0] << 8) | values[1]).toString(16).padStart(4, '0');
    const low: string = ((values[2] << 8) | values[3]).toString(16).padStart(4, '0');
    expanded = `${expanded.slice(0, lastColon)}:${high}:${low}`;
  }

  const double: number = expanded.indexOf('::');
  let parts: string[];
  if (double >= 0) {
    const head: string = expanded.slice(0, double);
    const tail: string = expanded.slice(double + 2);
    const headParts: string[] = head.length === 0 ? [] : head.split(':');
    const tailParts: string[] = tail.length === 0 ? [] : tail.split(':');
    const missing: number = 8 - (headParts.length + tailParts.length);
    if (missing < 1) {
      return '';
    }
    const zeros: string[] = [];
    for (let i = 0; i < missing; i += 1) {
      zeros.push('0');
    }
    parts = headParts.concat(zeros, tailParts);
  } else {
    parts = expanded.split(':');
  }
  if (parts.length !== 8) {
    return '';
  }

  const groups: string[] = [];
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) {
      return '';
    }
    groups.push(part.replace(/^0+(?=[0-9a-f])/, ''));
  }
  let bestStart: number = -1;
  let bestLength: number = 0;
  let curStart: number = -1;
  let curLength: number = 0;
  for (let i = 0; i < groups.length; i += 1) {
    if (groups[i] === '0') {
      if (curStart < 0) {
        curStart = i;
        curLength = 0;
      }
      curLength += 1;
      if (curLength > bestLength) {
        bestLength = curLength;
        bestStart = curStart;
      }
    } else {
      curStart = -1;
      curLength = 0;
    }
  }
  if (bestLength >= 2) {
    return `${groups.slice(0, bestStart).join(':')}::${groups.slice(bestStart + bestLength).join(':')}`;
  }
  return groups.join(':');
}

/**
 * 主机归一 + 传输一致性校验。失败 reason 不含输入值。
 * - IPv6：允许 `[…]` 或裸写，输出恒为 `[小写压缩]`；
 * - IPv4 / 主机名：拒绝协议、路径、端口、空白、网卡名，输出小写；
 * - tailscale 必须 100.64/10 或魔法域名；lan 必须 RFC1918 IPv4；ipv6 必须 IPv6。
 */
export function normalisePairingHost(raw: unknown, transport: string): PairingNormaliseResult {
  if (typeof raw !== 'string') {
    return normaliseFail('host 必须是字符串');
  }
  const text: string = raw.trim();
  if (text.length === 0) {
    return normaliseFail('host 不能为空');
  }
  if (text.indexOf('://') >= 0) {
    return normaliseFail('host 不能带 http:// 或 https://');
  }
  if (/[/\\?#\s%]/.test(text)) {
    return normaliseFail('host 不能带路径、参数、空白或网卡名');
  }

  const bracketed: boolean = text.startsWith('[') && text.endsWith(']');
  if (bracketed || text.indexOf(':') >= 0) {
    if (transport !== 'ipv6') {
      return normaliseFail('该传输方式要求 IPv4 或主机名，不能用 IPv6 地址');
    }
    const inner: string = bracketed ? text.slice(1, text.length - 1) : text;
    if (!isIpv6Literal(inner)) {
      return normaliseFail('IPv6 主机格式不合法');
    }
    const compressed: string = compressIpv6(inner);
    if (compressed.length === 0) {
      return normaliseFail('IPv6 主机格式不合法');
    }
    return { ok: true, value: `[${compressed}]`, reason: '' };
  }

  if (/^[0-9.]+$/.test(text)) {
    const ipv4: string = normaliseIpv4Text(text);
    if (ipv4.length === 0) {
      return normaliseFail('IPv4 主机格式不合法');
    }
    if (transport === 'tailscale' && !TAILSCALE_RE.test(ipv4)) {
      return normaliseFail('Tailscale 主机必须是 100.64/10 段地址');
    }
    if (transport === 'lan' && !RFC1918_RE.test(ipv4)) {
      return normaliseFail('局域网主机必须是 RFC1918 私网地址');
    }
    if (transport === 'ipv6') {
      return normaliseFail('IPv6 方式需要 IPv6 地址');
    }
    return { ok: true, value: ipv4, reason: '' };
  }

  if (transport === 'ipv6') {
    return normaliseFail('IPv6 方式需要 IPv6 地址');
  }
  if (transport === 'lan') {
    return normaliseFail('局域网主机必须是 RFC1918 私网地址');
  }
  const host: string = text.toLowerCase();
  if (!HOSTNAME_RE.test(host)) {
    return normaliseFail('主机名格式不合法');
  }
  return { ok: true, value: host, reason: '' };
}

/** 指纹归一：接受 64 位十六进制（可带冒号），输出 32 段大写冒号分隔。 */
export function normalisePairingFingerprint(raw: unknown): PairingNormaliseResult {
  if (typeof raw !== 'string') {
    return normaliseFail('tlsFingerprint 必须是字符串');
  }
  const trimmed: string = raw.trim();
  if (trimmed.length === 0) {
    return normaliseFail('tlsFingerprint 不能为空');
  }
  const hex: string = trimmed.indexOf(':') >= 0 ? trimmed.replace(/:/g, '') : trimmed;
  if (!FINGERPRINT_HEX_RE.test(hex)) {
    return normaliseFail('tlsFingerprint 必须是 SHA-256 的 64 位十六进制');
  }
  const upper: string = hex.toUpperCase();
  const groups: string[] = [];
  for (let i = 0; i < upper.length; i += 2) {
    groups.push(upper.slice(i, i + 2));
  }
  return { ok: true, value: groups.join(':'), reason: '' };
}

/** 指纹比对键：去冒号 + 大写，大小写 / 分隔符差异不算 TOFU 冲突。 */
export function fingerprintKey(value: unknown): string {
  const text: string = typeof value === 'string' ? value.trim() : '';
  return text.replace(/:/g, '').toUpperCase();
}

/** 给展示层的安全前缀：只取前 6 组，例如 `AA:BB:CC:DD:EE:FF…`（与实例视图共用一份）。 */
export function fingerprintPrefix(value: unknown): string {
  return pinnedFingerprintPrefix(typeof value === 'string' ? value : '');
}

/** FNV-1a 32 位，取 8 位十六进制；只用于手输串手误检测。 */
export function pairingChecksum(body: string): string {
  let hash: number = 0x811c9dc5;
  for (let i = 0; i < body.length; i += 1) {
    hash ^= body.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** 紧凑串解析的中间结果：失败带 typed result，成功带原始对象。 */
interface CompactParseResult {
  ok: boolean;
  raw: unknown;
  failure: PairingParseResult | null;
}

/** 与插件侧同构的紧凑串生成（测试夹具 / 手输提示用，不进任何 URL）。 */
export function formatPairingText(obj: unknown): string {
  const parsed: PairingParseResult = validateAndNormalise(obj);
  if (!parsed.ok || parsed.payload === null) {
    return '';
  }
  const payload: PairingPayload = parsed.payload;
  const body: string = [
    '1', payload.instanceId, payload.transport, payload.host, String(payload.port),
    payload.token, payload.tlsFingerprint, payload.announceRef
  ].join('|');
  return `${PAIRING_TEXT_PREFIX}${body}|${pairingChecksum(body)}`;
}

/** 紧凑串 → 原始对象（校验和必过；字段数错 / 校验和错都是 MALFORMED）。 */
function parseCompact(text: string): CompactParseResult {
  const parts: string[] = text.slice(PAIRING_TEXT_PREFIX.length).split('|');
  if (parts.length !== 9) {
    return { ok: false, raw: null, failure: parseFail('E_PAIRING_MALFORMED', '配对串字段数不对') };
  }
  const checksum: string = parts[8] === undefined ? '' : parts[8];
  const body: string = parts.slice(0, 8).join('|');
  if (!/^[0-9a-f]{8}$/i.test(checksum) || pairingChecksum(body) !== checksum.toLowerCase()) {
    return {
      ok: false, raw: null,
      failure: parseFail('E_PAIRING_MALFORMED', '配对串校验和不对，请重新扫描或逐字核对')
    };
  }
  return {
    ok: true,
    raw: {
      v: Number(parts[0]),
      instanceId: parts[1],
      transport: parts[2],
      host: parts[3],
      port: Number(parts[4]),
      token: parts[5],
      tlsFingerprint: parts[6],
      announceRef: parts[7] === undefined ? '' : parts[7]
    },
    failure: null
  };
}

/** 校验 + 归一；reason 恒为固定中文，永不含 token / host / 指纹的值。 */
function validateAndNormalise(input: unknown): PairingParseResult {
  const record: Record<string, unknown> | null = asRecord(input);
  if (record === null) {
    return parseFail('E_PAIRING_MALFORMED', '配对载荷必须是 JSON 对象');
  }
  for (const key of PAIRING_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      return parseFail('E_PAIRING_MALFORMED', '配对载荷缺少必填字段');
    }
  }
  for (const key of Object.keys(record)) {
    if (PAIRING_KEYS.indexOf(key) < 0) {
      return parseFail('E_PAIRING_MALFORMED', '配对载荷含未知字段');
    }
  }
  if (record['v'] !== PAIRING_VERSION) {
    return parseFail('E_PAIRING_VERSION', '不支持的配对版本，只接受 v:1');
  }
  const instanceId: unknown = record['instanceId'];
  if (typeof instanceId !== 'string' || !INSTANCE_ID_RE.test(instanceId)) {
    return parseFail('E_PAIRING_MALFORMED', 'instanceId 格式不合法');
  }
  const transport: unknown = record['transport'];
  if (typeof transport !== 'string' || PAIRING_TRANSPORTS.indexOf(transport) < 0) {
    return parseFail('E_PAIRING_TRANSPORT', 'transport 必须是 tailscale / lan / ipv6 之一');
  }
  const host: PairingNormaliseResult = normalisePairingHost(record['host'], transport);
  if (!host.ok) {
    return parseFail('E_PAIRING_HOST', host.reason);
  }
  const port: unknown = record['port'];
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    return parseFail('E_PAIRING_PORT', 'port 必须是 1..65535 的整数');
  }
  const token: unknown = record['token'];
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) {
    return parseFail('E_PAIRING_TOKEN', 'token 长度或字符集合不合法');
  }
  const fingerprint: PairingNormaliseResult = normalisePairingFingerprint(record['tlsFingerprint']);
  if (!fingerprint.ok) {
    return parseFail('E_PAIRING_FINGERPRINT', fingerprint.reason);
  }
  const announceRef: unknown = record['announceRef'];
  if (typeof announceRef !== 'string' || !ANNOUNCE_REF_RE.test(announceRef)) {
    return parseFail('E_PAIRING_MALFORMED', 'announceRef 格式不合法');
  }

  const payload: PairingPayload = {
    v: PAIRING_VERSION,
    instanceId: instanceId.toLowerCase(),
    transport: transport,
    host: host.value,
    port: port,
    token: token,
    tlsFingerprint: fingerprint.value,
    announceRef: announceRef
  };
  return { ok: true, payload: payload, code: 'ok', reason: '' };
}

/** 解析规范 JSON 或紧凑串；未知格式 / 坏 JSON 都是 MALFORMED。 */
export function parsePairingPayload(text: unknown): PairingParseResult {
  if (typeof text !== 'string') {
    return parseFail('E_PAIRING_MALFORMED', '配对载荷必须是字符串');
  }
  const trimmed: string = text.trim();
  if (trimmed.length === 0) {
    return parseFail('E_PAIRING_MALFORMED', '配对载荷不能为空');
  }
  if (trimmed.startsWith('{')) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      return parseFail('E_PAIRING_MALFORMED', '配对载荷不是合法 JSON');
    }
    return validateAndNormalise(parsed);
  }
  if (trimmed.startsWith(PAIRING_TEXT_PREFIX)) {
    const compact: CompactParseResult = parseCompact(trimmed);
    if (!compact.ok || compact.failure !== null) {
      return compact.failure === null
        ? parseFail('E_PAIRING_MALFORMED', '配对串无法解析')
        : compact.failure;
    }
    return validateAndNormalise(compact.raw);
  }
  return parseFail('E_PAIRING_MALFORMED', '不认识的配对串格式');
}

/** transport → 实例方式枚举（只映射直连三种，绝不产生网关 / 中继方式）。 */
function modeForTransport(transport: string): string {
  if (transport === 'tailscale') {
    return REMOTE_MODE_TAILSCALE;
  }
  if (transport === 'ipv6') {
    return REMOTE_MODE_IPV6;
  }
  return REMOTE_MODE_LAN;
}

/**
 * 手动配对落表（TOFU）：
 * - 同一个 `instanceId` 已有不同指纹 ⇒ 冲突拒绝、整表字节不变（换机器 / 中间人只能先删旧实例）；
 * - 同一个 `instanceId` 指纹一致 ⇒ 只更新地址 / 端口 / 令牌，保留名称、可达态、id 语义与 pin；
 * - 首次出现 ⇒ 新建实例并钉住证书指纹。
 *
 * 地址由 `announcementBaseUrl()` **唯一**拼装（去掉 parser 已经加好的 IPv6 方括号再交给它，
 * 由它按 scheme/host/port 规则统一加回），再过 `normalizeRemoteUrl()` fail-closed 校验。
 */
export function addPairedInstance(list: DsInstance[], text: string): PairingAddResult {
  const parsed: PairingParseResult = parsePairingPayload(text);
  if (!parsed.ok || parsed.payload === null) {
    const code: PairingErrorCode = parsed.code === 'ok' ? 'E_PAIRING_MALFORMED' : parsed.code;
    return addFail(code, parsed.reason);
  }
  const payload: PairingPayload = parsed.payload;
  const innerHost: string = payload.host.startsWith('[') && payload.host.endsWith(']')
    ? payload.host.slice(1, payload.host.length - 1)
    : payload.host;
  // 直连 DSH 的 Web 面板由插件的 node:http 监听器提供（无网关 / 无 TLS 终结反代），
  // 所以配对路径固定 http；证书只用于 TOFU pin，不改scheme决定权。
  const base: string = announcementBaseUrl({ scheme: 'http', host: innerHost, port: payload.port });
  const check = normalizeRemoteUrl(base);
  if (!check.ok) {
    return addFail('E_PAIRING_MALFORMED', '配对地址不可用，请重新复制配对串');
  }

  const id: string = instanceIdFromUrl(check.url);
  if (id.length === 0) {
    return addFail('E_PAIRING_MALFORMED', '配对地址不可用，请重新复制配对串');
  }
  const items: DsInstance[] = Array.isArray(list) ? list.slice() : [];
  const incomingKey: string = fingerprintKey(payload.tlsFingerprint);
  let existingIndex: number = -1;
  for (let i = 0; i < items.length; i += 1) {
    if (items[i].pairingInstanceId === payload.instanceId) {
      existingIndex = i;
      break;
    }
  }

  if (existingIndex >= 0) {
    const existing: DsInstance = items[existingIndex];
    const storedKey: string = fingerprintKey(existing.tlsFingerprint === undefined ? '' : existing.tlsFingerprint);
    if (storedKey.length === 0 || storedKey !== incomingKey) {
      // 冲突：不写 pin、不改地址、不产出新行；文案点名后果与唯一恢复手段。
      return addFail('E_PAIRING_FINGERPRINT_MISMATCH', PAIRING_FINGERPRINT_MISMATCH_WORDING);
    }
    const updated: DsInstance = {
      id: id,
      name: existing.name,
      url: check.url,
      mode: modeForTransport(payload.transport),
      token: payload.token,
      reachable: existing.reachable,
      capabilities: deriveCapabilities(id),
      pairingInstanceId: payload.instanceId,
      tlsFingerprint: existing.tlsFingerprint === undefined ? '' : existing.tlsFingerprint
    };
    if (existing.lastSeen !== undefined && existing.lastSeen > 0) {
      updated.lastSeen = existing.lastSeen;
    }
    items[existingIndex] = updated;
    const result: PairingAddResult = {
      ok: true,
      items: sortInstances(items),
      code: 'ok',
      reason: PAIRING_UPDATED_WORDING,
      action: 'updated'
    };
    return result;
  }

  const created: DsInstance = {
    id: id,
    name: payload.instanceId,
    url: check.url,
    mode: modeForTransport(payload.transport),
    token: payload.token,
    reachable: 'unknown',
    capabilities: deriveCapabilities(id),
    pairingInstanceId: payload.instanceId,
    tlsFingerprint: payload.tlsFingerprint
  };
  items.push(created);
  const added: PairingAddResult = {
    ok: true,
    items: sortInstances(items),
    code: 'ok',
    reason: PAIRING_ADDED_WORDING,
    action: 'added'
  };
  return added;
}
