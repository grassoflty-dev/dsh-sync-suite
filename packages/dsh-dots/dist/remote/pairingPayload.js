/**
 * mod-plugin-pairing：**唯一的配对载荷 schema**（二维码与手动输入共用）。
 *
 * 纪律：
 *   1. 载荷是 bearer secret：token 只允许出现在本文件的 `serialisePairingPayload` /
 *      `formatPairingText` 返回值，以及 `authorizationHeaderForPairing` 的返回值里。
 *      `describePairing` / 所有错误消息 / 所有状态视图都只有 `token: 'present'`。
 *   2. 两端（电脑插件 / 平板 App）共用同一字段语义与同一校验顺序；版本 `v:1`，
 *      未知版本一律 `E_PAIRING_VERSION` typed 拒绝，绝不"猜着兼容"。
 *   3. 严格校验：**只给原因、绝不回显值**（原因里不含 host/token/指纹的具体内容），
 *      所以错误进日志也不会泄露配对材料。
 *   4. 主机归一：IPv6 必须写成 `[2001:db8::1]`，无协议 / 无路径 / 无端口；IPv4 与主机名小写。
 *   5. 紧凑文本用于手动输入（用户说"也可以把配对信息手输到平板"）：位置式 + 4 位校验和，
 *      与规范 JSON 互相可解析；校验和只防手误，**不是**鉴权。
 */
import { createHash } from 'node:crypto';
import { timingSafeEqualText } from './auth.js';
import { normalizeHostname, normalizeIpv4, normalizeIpv6 } from './urls.js';
export const PAIRING_TRANSPORTS = ['tailscale', 'lan', 'ipv6'];
/** 规范键序：JSON.stringify 按这个顺序构造对象，保证往返逐字节稳定。 */
export const PAIRING_KEYS = [
    'v', 'instanceId', 'transport', 'host', 'port', 'token', 'tlsFingerprint', 'announceRef',
];
/**
 * 配对 typed 错误：`code` 稳定可判，`reason` 只描述"哪一类错了"，**绝不含任何值**。
 * `details` 刻意不设——一旦加上就容易有人把原样输入塞进去。
 */
export class PairingError extends Error {
    code;
    reason;
    constructor(code, reason) {
        super(reason);
        this.name = 'PairingError';
        this.code = code;
        this.reason = reason;
    }
}
function fail(code, reason) {
    throw new PairingError(code, reason);
}
export function isPairingError(error) {
    return error instanceof PairingError;
}
/** 紧凑文本前缀 + 分隔符；字段值统一禁含 `|`，所以按位置切分无歧义。 */
export const PAIRING_TEXT_PREFIX = 'DSHDOTS1|';
const INSTANCE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TOKEN_RE = /^[A-Za-z0-9+/=_-]{32,512}$/;
const FINGERPRINT_HEX_RE = /^[0-9a-f]{64}$/i;
const ANNOUNCE_REF_RE = /^[A-Za-z0-9._/-]{0,200}$/;
const TAILSCALE_RE = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;
const RFC1918_RE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
function hostFail(reason) {
    return { ok: false, value: '', reason };
}
/**
 * 主机归一 + 传输一致性校验。
 *
 * - IPv6：允许 `[…]` 或裸 `…`，输出恒为 `[RFC5952 压缩小写]`；
 * - IPv4 / 主机名：拒绝协议、路径、端口、空白、方括号；输出小写；
 * - `tailscale` 必须是 100.64/10 或 MagicDNS 主机名；`lan` 必须是 RFC1918 IPv4；
 *   `ipv6` 必须是 IPv6。失败 reason 不含输入值。
 */
export function normalisePairingHost(raw, transport) {
    if (typeof raw !== 'string')
        return hostFail('host 必须是字符串');
    const text = raw.trim();
    if (text === '')
        return hostFail('host 不能为空');
    if (text.includes('://'))
        return hostFail('host 不能带 http:// 或 https://');
    if (/[/\\?#\s%]/.test(text))
        return hostFail('host 不能带路径、参数、空白或网卡名');
    const bracketed = text.startsWith('[') && text.endsWith(']');
    if (bracketed || text.includes(':')) {
        if (transport !== 'ipv6')
            return hostFail('该传输方式要求 IPv4 或主机名，不能用 IPv6 地址');
        const inner = bracketed ? text.slice(1, -1) : text;
        const v6 = normalizeIpv6(inner);
        if (!v6.ok)
            return hostFail('IPv6 主机格式不合法');
        return { ok: true, value: `[${v6.value}]`, reason: '' };
    }
    if (/^[0-9.]+$/.test(text)) {
        const v4 = normalizeIpv4(text);
        if (!v4.ok)
            return hostFail('IPv4 主机格式不合法');
        if (transport === 'tailscale' && !TAILSCALE_RE.test(v4.value)) {
            return hostFail('Tailscale 主机必须是 100.64/10 段地址');
        }
        if (transport === 'lan' && !RFC1918_RE.test(v4.value)) {
            return hostFail('局域网主机必须是 RFC1918 私网地址');
        }
        if (transport === 'ipv6')
            return hostFail('IPv6 方式需要 IPv6 地址');
        return { ok: true, value: v4.value, reason: '' };
    }
    if (transport === 'ipv6')
        return hostFail('IPv6 方式需要 IPv6 地址');
    if (transport === 'lan')
        return hostFail('局域网主机必须是 RFC1918 私网地址');
    const host = normalizeHostname(text);
    if (!host.ok)
        return hostFail('主机名格式不合法');
    return { ok: true, value: host.value, reason: '' };
}
/** 指纹归一：接受带/不带冒号、大小写混合；输出 32 段大写冒号分隔 SHA-256。 */
export function normalisePairingFingerprint(raw) {
    if (typeof raw !== 'string')
        return hostFail('tlsFingerprint 必须是字符串');
    const trimmed = raw.trim();
    if (trimmed === '')
        return hostFail('tlsFingerprint 不能为空');
    const hex = trimmed.includes(':') ? trimmed.replace(/:/g, '') : trimmed;
    if (!FINGERPRINT_HEX_RE.test(hex))
        return hostFail('tlsFingerprint 必须是 SHA-256 的 64 位十六进制');
    const upper = hex.toUpperCase();
    return { ok: true, value: (upper.match(/.{2}/g) ?? []).join(':'), reason: '' };
}
/** 从证书 PEM / DER 计算 TOFU 指纹（与 `pairingTls.ts` 同一算法，不另立第二套）。 */
export function pairingFingerprintOf(cert) {
    const der = typeof cert === 'string'
        ? Buffer.from(cert.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, ''), 'base64')
        : Buffer.from(cert);
    const hex = createHash('sha256').update(der).digest('hex').toUpperCase();
    return (hex.match(/.{2}/g) ?? []).join(':');
}
function asRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : null;
}
/** 校验 + 归一，返回**规范键序**的新对象；只抛 PairingError。 */
function validateAndNormalise(input) {
    const record = asRecord(input);
    if (record === null)
        fail('E_PAIRING_MALFORMED', '配对载荷必须是 JSON 对象');
    for (const key of PAIRING_KEYS) {
        if (!(key in record))
            fail('E_PAIRING_MALFORMED', '配对载荷缺少必填字段');
    }
    for (const key of Object.keys(record)) {
        if (!PAIRING_KEYS.includes(key))
            fail('E_PAIRING_MALFORMED', '配对载荷含未知字段');
    }
    if (record.v !== 1)
        fail('E_PAIRING_VERSION', '不支持的配对版本，只接受 v:1');
    if (typeof record.instanceId !== 'string' || !INSTANCE_ID_RE.test(record.instanceId)) {
        fail('E_PAIRING_MALFORMED', 'instanceId 格式不合法');
    }
    if (typeof record.transport !== 'string' || !PAIRING_TRANSPORTS.includes(record.transport)) {
        fail('E_PAIRING_TRANSPORT', 'transport 必须是 tailscale / lan / ipv6 之一');
    }
    const transport = record.transport;
    const host = normalisePairingHost(record.host, transport);
    if (!host.ok)
        fail('E_PAIRING_HOST', host.reason);
    if (typeof record.port !== 'number' || !Number.isInteger(record.port) || record.port < 1 || record.port > 65535) {
        fail('E_PAIRING_PORT', 'port 必须是 1..65535 的整数');
    }
    if (typeof record.token !== 'string' || !TOKEN_RE.test(record.token)) {
        fail('E_PAIRING_TOKEN', 'token 长度或字符集合不合法');
    }
    const fingerprint = normalisePairingFingerprint(record.tlsFingerprint);
    if (!fingerprint.ok)
        fail('E_PAIRING_FINGERPRINT', fingerprint.reason);
    if (typeof record.announceRef !== 'string' || !ANNOUNCE_REF_RE.test(record.announceRef)) {
        fail('E_PAIRING_MALFORMED', 'announceRef 格式不合法');
    }
    // 显式构造：键序即 PAIRING_KEYS，JSON.stringify 后逐字节稳定。
    return {
        v: 1,
        instanceId: record.instanceId.toLowerCase(),
        transport,
        host: host.value,
        port: record.port,
        token: record.token,
        tlsFingerprint: fingerprint.value,
        announceRef: record.announceRef,
    };
}
/** 规范 JSON（紧凑、无空白、固定键序）——二维码与 RPC 的唯一 full-fidelity 表示。 */
export function serialisePairingPayload(obj) {
    const payload = validateAndNormalise(obj);
    return JSON.stringify({
        v: payload.v,
        instanceId: payload.instanceId,
        transport: payload.transport,
        host: payload.host,
        port: payload.port,
        token: payload.token,
        tlsFingerprint: payload.tlsFingerprint,
        announceRef: payload.announceRef,
    });
}
/** FNV-1a 32 位，取 8 位十六进制；只用于手输串的**手误检测**，不是鉴权。 */
export function pairingChecksum(body) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < body.length; i += 1) {
        hash ^= body.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}
/** 紧凑文本（可手输）：`DSHDOTS1|v|instanceId|transport|host|port|token|fingerprint|announceRef|checksum`。 */
export function formatPairingText(obj) {
    const payload = validateAndNormalise(obj);
    const body = [
        '1', payload.instanceId, payload.transport, payload.host, String(payload.port),
        payload.token, payload.tlsFingerprint, payload.announceRef,
    ].join('|');
    return `${PAIRING_TEXT_PREFIX}${body}|${pairingChecksum(body)}`;
}
function parseCompact(text) {
    const parts = text.slice(PAIRING_TEXT_PREFIX.length).split('|');
    if (parts.length !== 9)
        fail('E_PAIRING_MALFORMED', '配对串字段数不对');
    const checksum = parts[8] ?? '';
    const body = parts.slice(0, 8).join('|');
    if (!/^[0-9a-f]{8}$/i.test(checksum) || pairingChecksum(body) !== checksum.toLowerCase()) {
        fail('E_PAIRING_MALFORMED', '配对串校验和不对，请重新扫描或逐字核对');
    }
    return {
        v: Number(parts[0]),
        instanceId: parts[1],
        transport: parts[2],
        host: parts[3],
        port: Number(parts[4]),
        token: parts[5],
        tlsFingerprint: parts[6],
        announceRef: parts[7] ?? '',
    };
}
/**
 * 解析 + 严格校验；同时接受规范 JSON 与紧凑文本（两端同一 schema）。
 * 未知版本 → `E_PAIRING_VERSION`，其余失败各有 typed 码，reason 永不含值。
 */
export function parsePairingPayload(text) {
    if (typeof text !== 'string')
        fail('E_PAIRING_MALFORMED', '配对载荷必须是字符串');
    const trimmed = text.trim();
    if (trimmed === '')
        fail('E_PAIRING_MALFORMED', '配对载荷不能为空');
    let raw;
    if (trimmed.startsWith('{')) {
        try {
            raw = JSON.parse(trimmed);
        }
        catch {
            fail('E_PAIRING_MALFORMED', '配对载荷不是合法 JSON');
        }
    }
    else if (trimmed.startsWith(PAIRING_TEXT_PREFIX)) {
        raw = parseCompact(trimmed);
    }
    else {
        fail('E_PAIRING_MALFORMED', '不认识的配对串格式');
    }
    return validateAndNormalise(raw);
}
/**
 * mod-pairing-listener-truth：**载荷构造处**的 transport/host 族一致性门禁。
 *
 * `normalisePairingHost()` 已经在 schema 校验里按 transport 检查过主机，但那是"解析输入"的
 * 兜底；这里再钉一道显式门禁，保证任何从运行态拼出来的载荷都不可能带错族的地址（例如
 * `transport: 'lan'` 却塞一个 IPv6 host，或 `transport: 'ipv6'` 却塞局域网 IPv4）。
 * 失败只给 typed 码 + 不含值的中文原因，绝不把不一致的载荷交给 QR / 公告。
 */
export function assertPairingTransportHostFamily(transport, host) {
    if (typeof host !== 'string' || host.trim() === '') {
        fail('E_TRANSPORT_HOST_MISMATCH', '配对主机为空，无法确认传输方式');
    }
    const text = host.trim();
    const inner = text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text;
    // 只有真正的 IPv6 字面量才算 v6；`http://…` 也含冒号，不能被误判成 IPv6。
    const isV6 = inner.includes(':') && !inner.includes('://') && !inner.includes('/');
    if (transport === 'ipv6' && !isV6) {
        fail('E_TRANSPORT_HOST_MISMATCH', 'IPv6 方式必须配 IPv6 主机地址');
    }
    if (transport !== 'ipv6' && isV6) {
        fail('E_TRANSPORT_HOST_MISMATCH', '局域网 / Tailscale 方式不能配 IPv6 主机地址');
    }
}
/** 从当前设置构造规范载荷（QR / 复制串只走这里）。 */
export function buildPairingPayload(current) {
    // 先钉族一致性，再做 schema 校验；两步都 fail-closed，错误里不带主机/令牌的值。
    assertPairingTransportHostFamily(current.transport, current.host);
    return validateAndNormalise({
        v: 1,
        instanceId: current.instanceId,
        transport: current.transport,
        host: current.host,
        port: current.port,
        token: current.token,
        tlsFingerprint: current.tlsFingerprint,
        announceRef: current.announceRef ?? '',
    });
}
export function describePairing(input) {
    const payload = input instanceof PairingError
        ? fail('E_PAIRING_MALFORMED', '不能描述一个错误对象')
        : isPairingPayloadLike(input)
            ? buildPairingPayload({
                instanceId: input.instanceId,
                transport: input.transport,
                host: input.host,
                port: input.port,
                token: input.token,
                tlsFingerprint: input.tlsFingerprint,
                announceRef: input.announceRef ?? '',
            })
            : parsePairingPayload(input);
    return {
        v: 1,
        instanceId: payload.instanceId,
        transport: payload.transport,
        host: payload.host,
        port: payload.port,
        tlsFingerprint: payload.tlsFingerprint,
        announceRef: payload.announceRef,
        token: 'present',
    };
}
function isPairingPayloadLike(value) {
    const record = asRecord(value);
    return record !== null && record.token !== undefined && typeof record.token === 'string';
}
/**
 * 载荷 vs 当前设置核对（轮换后旧载荷必然失败）。
 * token 用常量时间比较；所有 reason 只说"哪一项不一致"，绝不回显两侧的值。
 */
export function verifyPairingAgainst(payloadInput, current) {
    let payload;
    try {
        payload = typeof payloadInput === 'string' ? parsePairingPayload(payloadInput) : validateAndNormalise(payloadInput);
    }
    catch (error) {
        if (isPairingError(error)) {
            return { ok: false, code: 'E_PAIRING_MALFORMED', field: '', reason: error.reason };
        }
        return { ok: false, code: 'E_PAIRING_MALFORMED', field: '', reason: '配对载荷无法解析' };
    }
    const mismatch = (code, field, reason) => ({ ok: false, code, field, reason });
    if (payload.v !== 1)
        return mismatch('E_PAIRING_VERSION_MISMATCH', 'v', '配对版本不受支持');
    if (payload.transport !== current.transport) {
        return mismatch('E_PAIRING_TRANSPORT_MISMATCH', 'transport', '配对方式与当前设置不一致');
    }
    const host = normalisePairingHost(current.host, current.transport);
    if (!host.ok || payload.host !== host.value) {
        return mismatch('E_PAIRING_HOST_MISMATCH', 'host', '配对地址与当前设置不一致');
    }
    if (payload.port !== current.port)
        return mismatch('E_PAIRING_PORT_MISMATCH', 'port', '配对端口与当前设置不一致');
    if (!timingSafeEqualText(payload.token, current.token)) {
        return mismatch('E_PAIRING_TOKEN_MISMATCH', 'token', '配对令牌已轮换，请重新扫码');
    }
    if (payload.tlsFingerprint !== normalisePairingFingerprint(current.tlsFingerprint).value) {
        return mismatch('E_PAIRING_FINGERPRINT_MISMATCH', 'tlsFingerprint', '证书指纹已更新，请重新扫码');
    }
    return { ok: true, field: '', reason: '' };
}
/**
 * token 的第二个也是最后一个合法出口：`Authorization: Bearer …`。
 * 除本函数与 `serialisePairingPayload` / `formatPairingText` 外，任何导出面都不返回 token。
 */
export function authorizationHeaderForPairing(token) {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) {
        fail('E_PAIRING_TOKEN', 'token 长度或字符集合不合法');
    }
    return `Bearer ${token}`;
}
