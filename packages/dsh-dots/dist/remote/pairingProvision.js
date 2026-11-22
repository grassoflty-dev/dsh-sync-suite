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
import { createPairingAudit, } from './pairingAudit.js';
// engine/settings.ts 的纯默认值函数：没有 I/O、没有第二套 deviceId 词表，仅为复用同一实例 id。
import { defaultDeviceId } from '../engine/settings.js';
import { defaultRemoteSettings, normalizeRemoteSettings } from './accessMode.js';
import { generateToken } from './auth.js';
import { assertPairingTransportHostFamily, buildPairingPayload, describePairing, formatPairingText, normalisePairingHost, PairingError, serialisePairingPayload, } from './pairingPayload.js';
import { encodeQr } from './qr.js';
import { generatePairingCertificate } from './pairingTls.js';
import { selectPairingTransport, defaultInterfaceSeam, transportReasonLines, TRANSPORT_REFUSAL, transportOfBoundAddress, } from './pairingTransport.js';
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
/**
 * 把**选中的方式 + 绑定地址 + 端口**一起写回既有 remote.json；其它字段逐字保留。
 *
 * mod-pairing-listener-truth：方式是 UI 显示与监听绑定的唯一真相，必须跟着选择一起落盘。
 * 以前只写 port、mode 永远是默认 `lan`，于是 UI 说 IPv6、磁盘写 lan，用户扫码拿到 LAN 地址
 * 还以为"自动选了 IPv6"。写盘前过 `normalizeRemoteSettings` 校验：非法地址一律 typed 失败，
 * 绝不留下"mode 变了、地址没变"的半套状态。失败选择不写盘（调用点在所有步骤成功之后）。
 */
function fieldOf(transport) {
    return transport === 'ipv6' ? 'ipv6Address' : transport === 'tailscale' ? 'tailscaleHost' : 'lanAddress';
}
function persistEndpoint(store, port, transport, host) {
    const raw = store.readRawSettings();
    const base = defaultRemoteSettings();
    const previous = raw === null ? base : normalizeRemoteSettings(raw, base);
    const address = host.replace(/^\[|\]$/g, '');
    const next = normalizeRemoteSettings({ ...previous, port, mode: transport, [fieldOf(transport)]: address }, previous);
    store.writeSettings(next);
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
        // 显式 transport + host（直连调用/测试夹具）：只校验地址与族，不经网卡枚举。
        if (options.transport !== undefined && options.host !== undefined) {
            const host = normalisePairingHost(options.host, options.transport);
            if (!host.ok)
                throw new PairingError('E_PAIRING_HOST', host.reason);
            return { transport: options.transport, host: host.value, auto: false };
        }
        const selection = selectPairingTransport(seam, { override: options.transport });
        // mod-pairing-listener-truth：显式选择不可用 ⇒ typed 拒绝，**绝不**回落到自动选择再 QR 一个
        // LAN 地址。selectPairingTransport 仍保留自动回落给"候选展示"用，但 provisioning 不消费它。
        if (options.transport !== undefined) {
            const candidate = selection.candidates[options.transport];
            if (candidate === undefined || candidate.available !== true) {
                const refusal = TRANSPORT_REFUSAL[options.transport];
                if (refusal === undefined)
                    throw new PairingError('E_PAIRING_TRANSPORT', '不支持的传输方式');
                throw new PairingError(refusal.code, refusal.reason);
            }
        }
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
        // 接线 TODO 7a：没有真正接上公告钩子时，"已公告"标记不能凭空宣称已发布。
        // 每次 run（面板 attach 必经）先清标记 → 下面必然产出一次 forced republish；
        // 只有 onRepublish 真的 resolve 才在末尾写回 announcedPort。
        const canAnnounce = options.onRepublish !== undefined;
        if (!canAnnounce)
            store.clearPairingAnnouncement();
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
            if (canAnnounce) {
                await options.onRepublish(event);
                // 钩子 resolve 之后才标记"已发布"；若它抛错，标记不动，下次 run 重发同一 key。
                store.writePairingAnnouncement({
                    v: 1,
                    announcedPort: chosen.port,
                    announceRef: state.announceRef,
                    key: event.key,
                });
            }
            // 无钩子时标记已被清成 announcedPort:null，下次 run 仍会 forced republish，
            // 绝不留下"没有证据却说已公告"的假状态。
        }
        // 5) 最后写盘：不变量 = 被记录的端口要么已发布，要么下次 run 由 marker 重发修复。
        //    方式 + 地址与端口同一事务写入；任何一步失败（含上面的 typed 拒绝）都不会走到这里。
        if (chosen.changed || settings.mode !== endpoint.transport || settings[fieldOf(endpoint.transport)] !== endpoint.host.replace(/^\[|\]$/g, '')) {
            persistEndpoint(store, chosen.port, endpoint.transport, endpoint.host);
        }
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
 * 装配层：把 provisioning + QR 编码 + 脱敏审计拼成 RPC 可用的 `PairingServiceLike`。
 * `show()` 之外没有任何出口返回 token 或完整载荷。
 */
export function createPairingService(options = {}) {
    const seam = options.interfaceSeam ?? defaultInterfaceSeam;
    const audit = createPairingAudit();
    const asOverride = (override) => override === undefined || override === 'auto' ? options.transport : override;
    const provisionerFor = (override) => createPairingProvisioner({ ...options, transport: asOverride(override) });
    return {
        provision: (override) => provisionerFor(override).provision(),
        async show(override) {
            // mod-pairing-listener-truth：先证明监听在跑。没有接缝 / 未运行 / 没有真实绑定地址 ⇒
            // typed E_LISTENER_NOT_RUNNING，绝不生成任何 QR 或可复制配对串。
            const requested = override === undefined || override === 'auto' ? undefined : override;
            let live = null;
            if (typeof options.listenerState === 'function') {
                try {
                    live = await options.listenerState();
                }
                catch {
                    live = null;
                }
            }
            if (live === null || live.running !== true ||
                typeof live.address !== 'string' || live.address.trim() === '' ||
                !Number.isInteger(live.port) || live.port < 1 || live.port > 65535) {
                throw new PairingError('E_LISTENER_NOT_RUNNING', '监听器未启动，不能生成配对二维码；请先点击「开始接受连接」');
            }
            if (live.tls !== true) {
                throw new PairingError('E_LISTENER_TLS_NOT_READY', '监听未启用 TLS，已拒绝生成配对载荷');
            }
            // 显式覆盖若不可用 ⇒ typed 拒绝；若与绑定地址族不一致也拒绝。绝不把"用户选了 IPv6"
            // 变成一张 LAN 二维码。"监听未启动"优先，所以这段放在上面的 running 门禁之后。
            if (requested !== undefined) {
                const candidate = selectPairingTransport(seam, { override: requested }).candidates[requested];
                if (candidate === undefined || candidate.available !== true) {
                    throw new PairingError(TRANSPORT_REFUSAL[requested].code, TRANSPORT_REFUSAL[requested].reason);
                }
            }
            // 方式来自绑定地址族（IPv6 / tailnet / LAN），不是网卡枚举；再与持久化的 mode 交叉核对，
            // 不一致就 typed 拒绝，绝不把"UI 说 IPv6、磁盘写 lan"的旧病态重新画成二维码。
            const transport = transportOfBoundAddress(live.address);
            if (transport === null) {
                throw new PairingError('E_TRANSPORT_HOST_MISMATCH', '监听绑定地址不是可配对的局域网 / tailnet / IPv6 地址');
            }
            if (live.mode !== null && live.mode !== transport) {
                throw new PairingError('E_TRANSPORT_MISMATCH', '访问方式与监听绑定地址不一致，请停止后重新启动监听');
            }
            if (requested !== undefined && requested !== transport) {
                throw new PairingError('E_TRANSPORT_MISMATCH', '所选方式与监听绑定地址不一致，请停止后重新启动监听');
            }
            const host = normalisePairingHost(live.address, transport);
            if (!host.ok)
                throw new PairingError('E_TRANSPORT_HOST_MISMATCH', host.reason);
            assertPairingTransportHostFamily(transport, host.value);
            const store = new RemoteStore({ homeDir: options.homeDir });
            const tokenRecord = store.readToken();
            if (tokenRecord === null || tokenRecord.token === '') {
                throw new PairingError('E_PAIRING_TOKEN', '配对令牌缺失，请先完成配置');
            }
            const cert = store.readCert();
            if (cert === null)
                throw new PairingError('E_NO_TLS_CERT', '配对证书缺失，已拒绝生成载荷');
            const payload = buildPairingPayload({
                instanceId: options.instanceId ?? defaultDeviceId(),
                transport,
                host: host.value,
                port: live.port,
                token: tokenRecord.token,
                tlsFingerprint: cert.fingerprint,
                announceRef: options.announceRef ?? '',
            });
            const canonical = serialisePairingPayload(payload);
            const text = formatPairingText(payload);
            try {
                return {
                    payload: canonical,
                    text,
                    qr: encodeQr(text, 'M'),
                    transport,
                    host: payload.host,
                    port: payload.port,
                    tls: live.tls,
                };
            }
            catch {
                // 二维码编码失败只给原因：RangeError 消息里只有字节数，但统一转成 typed 码更安全。
                throw new PairingError('E_PAIRING_MALFORMED', '配对串过长，无法生成二维码');
            }
        },
        rotateToken: (override) => provisionerFor(override).rotateToken(),
        rotateCert: (override) => provisionerFor(override).rotateCert(),
        async transports(override) {
            const selection = selectPairingTransport(seam, { override: asOverride(override) ?? 'auto' });
            return { ...selection, reasonLines: transportReasonLines(selection) };
        },
        async connections() { return audit.list(); },
        recordConnection(remoteAddress, at) { audit.record(remoteAddress, at); },
    };
}
