/**
 * mod-plugin-pairing-client：「谁连进来过」审计环（内存、有界、脱敏）。
 *
 * 纪律（与 `pairingPayload.ts::describePairing` 同一脱敏风格）：
 *   1. 审计条目只有 `{ at, peer }`——时间 + **脱敏后的对端身份**；
 *      完整地址、端口、token、URL、请求行一律不进环，更不进 RPC 响应 / DOM / 日志。
 *   2. `redactPeer()` 把 IPv4 打到 `192.168.*.*`、IPv6 打到 `2001:****`，
 *      未知形态统一 `已脱敏`。它是**展示用**身份提示，不是可路由地址。
 *   3. 环只活在运行进程里（重启清零），与 RemoteStatus 的"不落盘运行态"一致；
 *      容量固定，写满丢弃最旧，绝不会因为审计而撑爆内存。
 */
import { isIPv6 } from 'node:net';
/** 默认保留最近 20 条；超出丢弃最旧。 */
export const PAIRING_AUDIT_LIMIT = 20;
const REDACTED_UNKNOWN = '已脱敏';
const REDACTED_MISSING = '未知';
/**
 * 对端身份脱敏：只留足以分辨"是不是同一台平板"的前缀。
 * IPv4 → 前两段 + `.*.*`；IPv6 → 第一段 + `::****`；其余 → `已脱敏`。
 */
export function redactPeer(remoteAddress) {
    if (typeof remoteAddress !== 'string')
        return REDACTED_MISSING;
    const raw = remoteAddress.trim();
    if (raw === '')
        return REDACTED_MISSING;
    // IPv4-mapped IPv6 先剥 ::ffff: 前缀，避免把 192.168.1.6 当成 v6 处理。
    const address = raw.toLowerCase().startsWith('::ffff:') ? raw.slice(7) : raw;
    if (!isIPv6(address)) {
        const parts = address.split('.');
        if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part)))
            return REDACTED_UNKNOWN;
        return `${parts[0]}.${parts[1]}.*.*`;
    }
    const head = address.split('::')[0]?.split(':')[0] ?? '';
    return head === '' ? REDACTED_UNKNOWN : `${head}::****`;
}
/** 有界环形审计；无 I/O、无 console（凭据卫生守卫禁止插件源码写控制台）。 */
export function createPairingAudit(limit = PAIRING_AUDIT_LIMIT) {
    const cap = Number.isInteger(limit) && limit > 0 ? limit : PAIRING_AUDIT_LIMIT;
    let items = [];
    return {
        record(remoteAddress, at) {
            const stamp = typeof at === 'string' && at !== '' ? at : new Date().toISOString();
            items.push({ at: stamp, peer: redactPeer(remoteAddress) });
            if (items.length > cap)
                items = items.slice(items.length - cap);
        },
        list() {
            return items.map((item) => ({ at: item.at, peer: item.peer }));
        },
        clear() {
            items = [];
        },
    };
}
