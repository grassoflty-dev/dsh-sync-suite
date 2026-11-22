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
import { createServer } from 'node:net';
// engine/settings.ts 的纯默认值函数：没有 I/O、没有第二套 deviceId 词表，仅为复用同一实例 id。
import { defaultDeviceId } from '../engine/settings.js';
import { defaultRemoteSettings, normalizeRemoteSettings } from './accessMode.js';
import { generateToken } from './auth.js';
import { buildPairingPayload, describePairing, formatPairingText, normalisePairingHost, PairingError, serialisePairingPayload, } from './pairingPayload.js';
import { encodeQr } from './qr.js';
import { generatePairingCertificate } from './pairingTls.js';
import { selectPairingTransport, defaultInterfaceSeam, transportReasonLines, } from './pairingTransport.js';
import { RemoteStore } from './store.js';
/** 稳定的首选端口；被占用才向上扫描，选中的端口记进 remote.json，跨重启不再重掷。 */
export const PAIRING_PREFERRED_PORT = 44996;
/** 默认端口探测：只绑 127.0.0.1 试一下，成功即关；不写日志、不回显端口之外的信息。 */
export function isPortFreeDefault(port) {
    return new Promise((resolve) => {
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            resolve(false);
            return;
        }
        const server = createServer();
        server.once('error', () => resolve(false));
        server.listen(port, '127.0.0.1', () => {
            server.close(() => resolve(true));
        });
    });
}
async function choosePort(previous, preferred, free) {
    // 惰性扫描：先沿用已记录端口（跨重启不重掷），再试稳定首选，最后从首选向上绕回 1。
    const seen = new Set();
    const tryPort = async (port) => {
        if (port < 1 || port > 65535 || seen.has(port))
            return null;
        seen.add(port);
        if (await free(port))
            return { port, changed: port !== previous };
        return null;
    };
    const first = await tryPort(previous);
    if (first !== null)
        return first;
    const second = await tryPort(preferred);
    if (second !== null)
        return second;
    for (let port = preferred + 1; port <= 65535; port += 1) {
        const found = await tryPort(port);
        if (found !== null)
            return found;
    }
    for (let port = 1; port < preferred; port += 1) {
        const found = await tryPort(port);
        if (found !== null)
            return found;
    }
    throw new PairingError('E_PAIRING_PORT', '没有可用端口，请释放一个本机端口后重试');
}
/** 把端口写回既有 remote.json；其它字段逐字保留（不新造第二份设置）。 */
function persistPort(store, port) {
    const raw = store.readRawSettings();
    const base = defaultRemoteSettings();
    const previous = raw === null ? base : normalizeRemoteSettings(raw, base);
    store.writeSettings({ ...previous, port });
}
export function createPairingProvisioner(options = {}) {
    const now = options.now ?? (() => new Date());
    const store = new RemoteStore({ homeDir: options.homeDir });
    const seam = options.interfaceSeam ?? defaultInterfaceSeam;
    const preferred = options.preferredPort ?? PAIRING_PREFERRED_PORT;
    const free = options.isPortFree ?? isPortFreeDefault;
    const makeToken = options.generateTokenFn ?? (() => generateToken(32));
    const makeCert = options.generateCertFn ?? (() => generatePairingCertificate({ now }));
    function resolveEndpoint() {
        if (options.transport !== undefined && options.host !== undefined) {
            const host = normalisePairingHost(options.host, options.transport);
            if (!host.ok)
                throw new PairingError('E_PAIRING_HOST', host.reason);
            return { transport: options.transport, host: host.value, auto: false };
        }
        const selection = selectPairingTransport(seam, { override: options.transport });
        if (selection.selected === null || selection.selectedHost === '') {
            throw new PairingError('E_PAIRING_HOST', '未检测到可用网络，请先连同一 Wi-Fi 或登录 Tailscale');
        }
        const host = normalisePairingHost(selection.selectedHost, selection.selected);
        if (!host.ok)
            throw new PairingError('E_PAIRING_HOST', host.reason);
        return { transport: selection.selected, host: host.value, auto: true };
    }
    async function run(forceReason) {
        // 1) 端口：已记录且空闲就沿用；否则扫描。**这里先不落盘**——
        //    只有"算完载荷 + 重发成功"整步都成功，才在最后写回 remote.json。
        const raw = store.readRawSettings();
        const base = defaultRemoteSettings();
        const settings = raw === null ? base : normalizeRemoteSettings(raw, base);
        const chosen = await choosePort(settings.port, preferred, free);
        const announcedPort = store.readPairingAnnouncement()?.announcedPort ?? null;
        // 2) 令牌 / 证书：存在即复用；只在缺失时自动生成（不静默轮换）。
        const existingToken = store.readToken();
        let tokenChanged = false;
        let token = existingToken?.token ?? '';
        if (existingToken === null) {
            token = makeToken();
            store.writeToken({ token, createdAt: now().toISOString() });
            tokenChanged = true;
            if (options.onTokenChanged !== undefined) {
                await options.onTokenChanged({ type: 'pairing.token.changed', token, reason: 'provision' });
            }
        }
        const existingCert = store.readCert();
        let certChanged = false;
        let cert = existingCert;
        if (cert === null) {
            cert = makeCert();
            store.writeCert(cert);
            certChanged = true;
        }
        // 3) 拼规范载荷；instanceId 复用同步侧的 deviceId 词表（纯默认值）。
        const endpoint = resolveEndpoint();
        const state = {
            instanceId: options.instanceId ?? defaultDeviceId(),
            transport: endpoint.transport,
            host: endpoint.host,
            port: chosen.port,
            token,
            tlsFingerprint: cert.fingerprint,
            announceRef: options.announceRef ?? '',
            cert,
        };
        const payload = buildPairingPayload(state);
        const canonical = serialisePairingPayload(payload);
        const text = formatPairingText(payload);
        const view = describePairing(payload);
        // 4) 重发判定以"公告已经发布的端口"为准，而不是刚读到的 remote.json::port：
        //    这样即使上次在"写盘成功 / 重发失败"或反向窗口中断，下一次 run 也会自我修复。
        const neverPublished = announcedPort === null;
        const needsPortPublish = neverPublished || announcedPort !== chosen.port;
        const reason = forceReason ?? (needsPortPublish
            ? (neverPublished ? 'first-publish' : 'port-changed')
            : tokenChanged ? 'token-rotated'
                : certChanged ? 'cert-rotated'
                    : null);
        let republish = null;
        if (reason !== null) {
            const event = {
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
            };
            republish = event;
            if (options.onRepublish !== undefined)
                await options.onRepublish(event);
            // 钩子 resolve 之后才标记"已发布"；若它抛错，标记不动，下次 run 重发同一 key。
            store.writePairingAnnouncement({
                v: 1,
                announcedPort: chosen.port,
                announceRef: state.announceRef,
                key: event.key,
            });
        }
        // 5) 最后写盘：不变量 = 被记录的端口要么已发布，要么下次 run 由 marker 重发修复。
        if (chosen.changed)
            persistPort(store, chosen.port);
        return {
            state,
            view,
            payload: canonical,
            text,
            republish,
            changed: { port: chosen.changed, token: tokenChanged, cert: certChanged },
        };
    }
    return {
        provision: () => run(),
        async rotateToken() {
            const token = makeToken();
            store.writeToken({ token, createdAt: now().toISOString() });
            if (options.onTokenChanged !== undefined) {
                await options.onTokenChanged({ type: 'pairing.token.changed', token, reason: 'rotate' });
            }
            return run('token-rotated');
        },
        async rotateCert() {
            const cert = makeCert();
            store.writeCert(cert);
            return run('cert-rotated');
        },
    };
}
/**
 * 装配层：把 provisioning + QR 编码拼成 RPC 可用的 `PairingServiceLike`。
 * `show()` 之外没有任何出口返回 token 或完整载荷。
 */
export function createPairingService(options = {}) {
    const provisioner = createPairingProvisioner(options);
    const seam = options.interfaceSeam ?? defaultInterfaceSeam;
    return {
        provision: () => provisioner.provision(),
        async show() {
            const result = await provisioner.provision();
            try {
                return { payload: result.payload, text: result.text, qr: encodeQr(result.text, 'M') };
            }
            catch {
                // 二维码编码失败只给原因：RangeError 消息里只有字节数，但统一转成 typed 码更安全。
                throw new PairingError('E_PAIRING_MALFORMED', '配对串过长，无法生成二维码');
            }
        },
        rotateToken: () => provisioner.rotateToken(),
        rotateCert: () => provisioner.rotateCert(),
        async transports() {
            const selection = selectPairingTransport(seam, { override: options.transport });
            return { ...selection, reasonLines: transportReasonLines(selection) };
        },
    };
}
