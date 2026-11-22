/**
 * mod-plugin-pairing：**唯一**一套自签证书生成方案。
 *
 * 仓库里此前没有 TLS 证书生成器（`src/remote/**` 只有 http 监听与令牌门），
 * 所以这里新增一套最小 DER/X.509 v1 编码器，而不是把"指纹"伪造成哈希串。
 * 运行时只用 `node:crypto`，零 npm 依赖；证书按字节算出 SHA-256 冒号指纹用于 TOFU pin。
 *
 * 纪律：
 *   - 私钥与证书一起落 0600 文件（见 `pairingStore.ts`），但**证书内容永不进日志 / 报告**；
 *   - 只有指纹（可公开的 pin）出现在配对载荷、状态视图与 describePairing() 里；
 *   - 轮换 = 新密钥 + 新证书 + 新指纹，旧载荷立即被 verifyPairingAgainst 拒。
 */
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { pairingFingerprintOf } from './pairingPayload.js';
const TAG_SEQUENCE = 0x30;
const TAG_SET = 0x31;
const TAG_INTEGER = 0x02;
const TAG_BIT_STRING = 0x03;
const TAG_NULL = 0x05;
const TAG_OID = 0x06;
const TAG_PRINTABLE = 0x13;
const TAG_UTC_TIME = 0x17;
function derLength(length) {
    if (length < 0x80)
        return [length];
    const octets = [];
    let remaining = length;
    while (remaining > 0) {
        octets.unshift(remaining & 0xff);
        remaining = Math.floor(remaining / 256);
    }
    return [0x80 | octets.length, ...octets];
}
function tlv(tag, content) {
    return [tag, ...derLength(content.length), ...content];
}
function sequence(...parts) {
    return tlv(TAG_SEQUENCE, parts.flat());
}
function setOf(...parts) {
    return tlv(TAG_SET, parts.flat());
}
function derInteger(value) {
    if (value === 0n)
        return tlv(TAG_INTEGER, [0]);
    let hex = value.toString(16);
    if (hex.length % 2 !== 0)
        hex = `0${hex}`;
    const bytes = [];
    for (let i = 0; i < hex.length; i += 2)
        bytes.push(Number.parseInt(hex.slice(i, i + 2), 16));
    if (bytes[0] >= 0x80)
        bytes.unshift(0);
    return tlv(TAG_INTEGER, bytes);
}
/** OID 的 base-128 编码：每个字节低 7 位，除最后一段外都置第 8 位。 */
function base128(value) {
    const out = [value & 0x7f];
    let remaining = Math.floor(value / 128);
    while (remaining > 0) {
        out.push((remaining & 0x7f) | 0x80);
        remaining = Math.floor(remaining / 128);
    }
    return out.reverse();
}
function derOid(dotted) {
    const arcs = dotted.split('.').map((part) => Number.parseInt(part, 10));
    const head = 40 * arcs[0] + arcs[1];
    return tlv(TAG_OID, [head, ...arcs.slice(2).flatMap(base128)]);
}
function utcTime(date) {
    // X.509 UTCTime 只覆盖 1950..2049；TOFU pin 不依赖真实年份，夹到上界即可。
    const year = Math.min(2049, Math.max(1950, date.getUTCFullYear()));
    const two = String(year).slice(-2);
    const part = (n) => String(n).padStart(2, '0');
    return tlv(TAG_UTC_TIME, Array.from(Buffer.from(`${two}${part(date.getUTCMonth() + 1)}${part(date.getUTCDate())}${part(date.getUTCHours())}${part(date.getUTCMinutes())}${part(date.getUTCSeconds())}Z`, 'ascii')));
}
function printable(value) {
    return tlv(TAG_PRINTABLE, Array.from(Buffer.from(value, 'ascii')));
}
function pem(label, der) {
    const base64 = Buffer.from(der).toString('base64');
    const lines = [];
    for (let i = 0; i < base64.length; i += 64)
        lines.push(base64.slice(i, i + 64));
    return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}
const SHA256_WITH_RSA = '1.2.840.113549.1.1.11';
const COMMON_NAME_OID = '2.5.4.3';
const DEFAULT_COMMON_NAME = 'DSH Dots Pairing';
/** 生成一张自签 X.509 v1 证书（sha256WithRSAEncryption），并给出 TOFU 指纹。 */
export function generatePairingCertificate(options = {}) {
    const now = options.now ?? (() => new Date());
    const modulusLength = options.modulusLength ?? 2048;
    if (!Number.isInteger(modulusLength) || modulusLength < 2048 || modulusLength > 4096) {
        throw new RangeError('证书密钥长度必须在 2048..4096 之间');
    }
    const createdAt = now().toISOString();
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength });
    const name = sequence(setOf(sequence(derOid(COMMON_NAME_OID), printable(options.commonName ?? DEFAULT_COMMON_NAME))));
    const algorithm = sequence(derOid(SHA256_WITH_RSA), tlv(TAG_NULL, []));
    const serial = derInteger(BigInt(`0x${randomBytes(8).toString('hex')}`) & 0x7fffffffffffffffn);
    const validity = sequence(utcTime(now()), utcTime(new Date(now().getTime() + 10 * 365 * 24 * 60 * 60 * 1000)));
    // SPKI 本身已经是 DER SEQUENCE，直接作为 TBSCertificate 的最后一个字段，不能重复包一层。
    const spki = Array.from(publicKey.export({ type: 'spki', format: 'der' }));
    const tbs = sequence(serial, algorithm, name, validity, name, spki);
    // RSA 私钥默认 PKCS#1 v1.5 padding，与 AlgorithmIdentifier 的 sha256WithRSAEncryption 对齐。
    const signature = sign('sha256', Buffer.from(tbs), privateKey);
    const certificate = sequence(tbs, algorithm, tlv(TAG_BIT_STRING, [0, ...Array.from(signature)]));
    const certDer = Buffer.from(certificate);
    return {
        certPem: pem('CERTIFICATE', certDer),
        keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        fingerprint: pairingFingerprintOf(certDer),
        createdAt,
    };
}
/** 对外统一入口：无论输入 PEM 还是 DER，指纹算法只有这一套。 */
export function fingerprintPairingCertificate(cert) {
    return pairingFingerprintOf(cert);
}
