/**
 * mod-plugin-session-prompt：DARK 的 sessionPrompt 服务编排（插件侧，零 RPC 实现细节）。
 *
 * 投递端口有两种实现：`createUnavailableDeliveryPort()`（DARK 缺省，拒绝且不读正文）与
 * `createSessionControllerDeliveryPort()`（进程内 `ctx.sessionController.prompt`，同进程 typed 调用，
 * **没有** JSON-RPC 镜像 / 第二个网络面）。生产服务在宿主晚到时才惰性取服务；服务缺席 ⇒
 * `E_SESSION_UNAVAILABLE`。API 只回 `{accepted:true}`，没有 seq / sha —— 我们只回自己的
 * `{accepted, payloadSha256}`（`payloadSha256` 是**我们自己的指纹**：对实际投递的正文逐字节 sha256，
 * 不是 DSH 的字段），并把 `seq` 从所有结果与投影里彻底移除。
 *
 * 调用固定 `mode:'queue'`：绝不 steer、绝不打断正在运行的回合。每次调用新建 AbortController，
 * **不设定时器**（项目纪律）：挂住的调用只阻塞那一个 RPC 请求。调用返回后会再读一次 head，
 * 把漂移记进账本；**没有 CAS**，写入不可描述为原子——调用期间的 head 变化只能事后发现，不能阻止。
 *
 * 幂等策略 = **record-on-success**：只有投递成功（port 返回 ok:true）之后才把 (sessionId,
 * requestId) 写进账本。这样投递失败 / 拒绝不会污染账本，同一请求号可以安全重试；代价是
 * 「已投递成功但账本写失败」这个窗口无法靠重放自动收敛——因此单独返回 `E_SESSION_RECORD_FAILED`
 * 明确要求先刷新会话确认、勿盲目重发。单进程 + 已 HELD 租约把并发在飞窗口压到最小，
 * 但账本写失败时绝不假定「没写入」，这是有意保留的诚实警告而不是静默成功。
 *
 * 操作员标记文件只读：`channel-verified.json` 由操作员在带外写入，载荷
 * `{verifiedAt, instanceId, leafSha256, verifier}`；本服务只 `readFileSync`，从不写它。
 * 通道判定是三态：verified / unverified / leaf-mismatch —— 标记必须绑定到请求实例
 * 且指纹与该实例当前叶证书 pin 完全一致；没有 pin 绝不 TOFU。任何拒绝都发生在
 * 其它依赖被触碰之前。
 *
 * 响应永远只有 `{accepted, payloadSha256}`：指令正文与 lease owner 不进返回体。
 *
 * 新 requestId 策略：某会话一旦有成功账本行，在 10 分钟窗口内用**另一个** requestId 再发会被
 * 显式拒绝 `E_HEAD_MOVED`（我们自己上一次写入已经移动了 head，必须先刷新）。不把它委托给
 * DSH 去重，是因为离线无法证明「去重命中」与「首次写入」的区别；显式拒绝是本地可证明的行为。
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SyncError } from '../engine/errors.js';
import { statePaths } from '../engine/paths.js';
import { defaultDeviceId } from '../engine/settings.js';
import { INSTANCE_ID_PATTERN, TOOL_SESSION_PROMPT } from './grants.js';
import { normalisePairingFingerprint } from './pairingPayload.js';
import { RemoteStore } from './store.js';
import { LEASE_WORDING } from './lease.js';
import { decideSessionPrompt } from './promptGate.js';
import { createLeaseStore } from './leaseStore.js';
import { createPromptLedger } from './promptLedger.js';
import { PROMPT_ERROR_CODES, PROMPT_IDEMPOTENCY_WINDOW_MS, promptRefusal } from './promptWording.js';
const MARKER_FILE = 'channel-verified.json';
const LEASE_FILE = 'session-leases.json';
const LEDGER_FILE = 'prompt-ledger.json';
/**
 * 生产缺省投递端口：没有真实 transport，固定拒绝 E_SESSION_UNAVAILABLE。
 * 刻意不读 request 的任何字段——正文 / owner 不被触碰、不进日志、不进 reason、不回显。
 */
export function createUnavailableDeliveryPort() {
    return {
        async send() {
            return { ok: false, code: 'E_SESSION_UNAVAILABLE', reason: '未接入投递通道' };
        },
    };
}
/**
 * 进程内 `ctx.sessionController.prompt` 投递端口：固定 mode:'queue'，每次新建 AbortController，
 * 无定时器。所有 API 错误（session/not-found、session/agent-busy、gateway/internal、未知码、
 * 非预期返回、abort）统一映射为 E_SESSION_DELIVERY_FAILED；服务缺席 ⇒ E_SESSION_UNAVAILABLE
 * （什么都没尝试）。从不把 prompt / leaseOwner 写进 reason、日志或返回值。
 */
export function createSessionControllerDeliveryPort(options) {
    return {
        async send(request) {
            let controller;
            try {
                controller = options.lookup();
            }
            catch {
                return { ok: false, code: 'E_SESSION_UNAVAILABLE', reason: '会话控制器不可用' };
            }
            if (controller === null || controller === undefined || typeof controller.prompt !== 'function') {
                return { ok: false, code: 'E_SESSION_UNAVAILABLE', reason: '会话控制器未挂载' };
            }
            // 我们自己的指纹：对实际投递的正文逐字节 sha256；不是 DSH 的 seq / sha / messageId。
            const payloadSha256 = createHash('sha256').update(request.text, 'utf8').digest('hex');
            const signal = new AbortController();
            try {
                const value = await controller.prompt({
                    requestId: request.requestId,
                    sessionId: request.sessionId,
                    mode: 'queue',
                    content: [{ type: 'text', text: request.text }],
                }, signal.signal);
                if (value === null || typeof value !== 'object' || value.accepted !== true) {
                    return { ok: false, code: 'E_SESSION_DELIVERY_FAILED' };
                }
                return { ok: true, accepted: true, payloadSha256 };
            }
            catch {
                // 任何声明/未声明的错误与 abort 都收敛到同一 typed 失败，绝不冒原始异常或假成功。
                return { ok: false, code: 'E_SESSION_DELIVERY_FAILED' };
            }
        },
    };
}
/**
 * 生产缺省 pin 源：惰性读取插件自己的配对证书（`remote-pairing-cert.json`），
 * 只针对本机 instanceId；不写、不迁移、不缓存，证书轮换在下一次调用即可被观察到。
 * 测试一律注入 PinLookup，不会碰到任何 live 状态。
 */
export function createPairingPinLookup(options = {}) {
    return {
        lookup(instanceId) {
            if (typeof instanceId !== 'string' || instanceId.trim() === '')
                return null;
            if (instanceId !== defaultDeviceId())
                return null;
            try {
                const cert = new RemoteStore({ homeDir: options.homeDir }).readCert();
                if (cert === null || typeof cert.fingerprint !== 'string')
                    return null;
                return { fingerprint: cert.fingerprint };
            }
            catch {
                return null;
            }
        },
    };
}
const MARKER_FIELDS = ['verifiedAt', 'instanceId', 'leafSha256', 'verifier'];
/** 严格校验标记载荷；未知字段 / 坏类型 / 坏形状一律 false。 */
export function validChannelMarker(raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
        return false;
    const item = raw;
    for (const key of Object.keys(item))
        if (MARKER_FIELDS.indexOf(key) < 0)
            return false;
    if (typeof item.verifiedAt !== 'number' || !Number.isFinite(item.verifiedAt) || item.verifiedAt <= 0)
        return false;
    if (typeof item.instanceId !== 'string' || !INSTANCE_ID_PATTERN.test(item.instanceId))
        return false;
    // 指纹形状：接受大小写与冒号分隔，走与配对载荷同一个归一函数（不另造第二套）。
    if (!normalisePairingFingerprint(item.leafSha256).ok)
        return false;
    if (typeof item.verifier !== 'string' || item.verifier.trim() === '')
        return false;
    return true;
}
/** 归一为裸大写 hex（无冒号）；非法输入返回空串，调用方按「无可用 pin / 坏标记」处理。 */
export function bareFingerprint(raw) {
    const result = normalisePairingFingerprint(raw);
    return result.ok ? result.value.replace(/:/g, '') : '';
}
function refusal(key) {
    const typed = promptRefusal(key);
    return new SyncError(typed.code, typed.wording, { key: typed.key });
}
/** 成功结果白名单投影：只取 accepted / 我们自己的 payloadSha256，绝不回显正文或 owner。 */
function projectDelivery(raw) {
    const payloadSha256 = typeof raw.payloadSha256 === 'string' && /^[0-9a-f]{64}$/i.test(raw.payloadSha256)
        ? raw.payloadSha256
        : '';
    return { accepted: raw.accepted === true && payloadSha256 !== '', payloadSha256 };
}
export function createSessionPromptService(options = {}) {
    const root = statePaths(options.homeDir).root;
    const markerPath = options.markerPath ?? path.join(root, MARKER_FILE);
    const now = options.now ?? (() => Date.now());
    const instances = options.instances ?? { get: () => null };
    const grants = options.grants ?? { isGranted: () => false };
    const pins = options.pins ?? createPairingPinLookup({ homeDir: options.homeDir });
    const leases = options.leases ?? createLeaseStore({ filePath: path.join(root, LEASE_FILE), now });
    const ledger = options.ledger ?? createPromptLedger({ filePath: path.join(root, LEDGER_FILE), now });
    // undefined ⇒ 有宿主控制器查找就走进程内端口，否则缺省「无通道」端口；显式 null 才表示未挂载。
    const delivery = options.delivery === undefined
        ? (options.sessionControllerLookup !== undefined
            ? createSessionControllerDeliveryPort({ lookup: options.sessionControllerLookup })
            : createUnavailableDeliveryPort())
        : options.delivery;
    const headReader = options.headReader ?? null;
    function channelState(instanceId) {
        // 没有可用实例 id ⇒ 连文件都不读，直接按通道未验证拒绝（绝不走形状错误路径）。
        if (typeof instanceId !== 'string' || instanceId.trim() === '')
            return 'unverified';
        let text;
        try {
            text = readFileSync(markerPath, 'utf8');
        }
        catch {
            return 'unverified';
        }
        let parsed;
        try {
            parsed = JSON.parse(text);
        }
        catch {
            return 'unverified';
        }
        if (!validChannelMarker(parsed))
            return 'unverified';
        const marker = parsed;
        // 精确字符串比较：为实例 B 写的标记绝不授权实例 A。
        if (marker.instanceId !== instanceId.trim())
            return 'unverified';
        // 没有该实例的 pin ⇒ 从未验证（绝不 TOFU 把标记里的指纹当作 pin）。
        // pin 源可能抛（注入的实现 / 存储故障）：通道判定必须全函数，任何异常都只是
        // 「无法证明已验证」⇒ unverified，绝不冒出第五种状态或假 verified。
        let pinHex = '';
        try {
            const pin = pins.lookup(instanceId.trim());
            pinHex = bareFingerprint(pin?.fingerprint);
        }
        catch {
            return 'unverified';
        }
        if (pinHex === '')
            return 'unverified';
        return bareFingerprint(marker.leafSha256) === pinHex ? 'verified' : 'leaf-mismatch';
    }
    function channelVerified(instanceId) {
        return channelState(instanceId) === 'verified';
    }
    async function send(request) {
        const instanceId = typeof request.instanceId === 'string' ? request.instanceId.trim() : '';
        // 三态通道闸在任何其它依赖（实例查询 / grant / 租约 / 账本 / 端口）被触碰之前短路。
        const state = channelState(instanceId);
        if (state === 'leaf-mismatch')
            throw refusal('channel.desktop.leafMismatch');
        if (state !== 'verified')
            throw refusal('channel.desktop.unverified');
        const nowMs = now();
        if (instances.get(instanceId) === null)
            throw refusal('instance.unknown');
        const granted = grants.isGranted(instanceId, TOOL_SESSION_PROMPT, nowMs);
        const leaseState = await leases.load();
        const lease = leaseState.leases.find((item) => item.sessionId === request.sessionId) ?? null;
        const ledgerState = await ledger.load();
        // 新 requestId 策略：本会话在窗口内已有成功账本行 ⇒ 自己上一次写入已移动 head，
        // 显式拒绝 E_HEAD_MOVED 要求刷新；不把「首次写入 vs DSH 去重命中」留给离线猜测。
        const prior = (ledgerState.view[request.sessionId] ?? []).filter((entry) => entry.requestId !== request.requestId);
        if (prior.some((entry) => nowMs - entry.atMs < PROMPT_IDEMPOTENCY_WINDOW_MS)) {
            throw new SyncError('E_HEAD_MOVED', LEASE_WORDING.E_HEAD_MOVED, { key: 'head.moved' });
        }
        const head = headReader !== null
            ? await headReader.readHeadSha({ instanceId, sessionId: request.sessionId })
            : (lease?.headSha ?? '');
        const decision = decideSessionPrompt({
            text: request.text,
            requestId: request.requestId,
            sessionId: request.sessionId,
            instanceId,
            expectedPrevSha: request.expectedPrevSha,
            actualHeadSha: head,
            nowMs,
            channelVerified: true,
            granted,
            lease,
            ledger: ledgerState.view,
            deliveryAvailable: delivery !== null,
            declaredLeaseOwner: request.leaseOwner,
        });
        if (!decision.ok) {
            throw new SyncError(decision.code, decision.wording, { key: decision.key });
        }
        // 投递前只持久化租约（本地写者身份）；requestId **刻意不写账本**（record-on-success）。
        await leases.upsert(decision.claim.lease);
        // 双保险：gate 已检查过，这里再挡一次，避免端口晚卸载时假成功。
        if (delivery === null)
            throw refusal('session.unavailable');
        let outcome;
        try {
            outcome = await delivery.send({
                sessionId: request.sessionId,
                instanceId,
                requestId: request.requestId,
                text: request.text,
                expectedPrevSha: request.expectedPrevSha,
                leaseOwner: request.leaseOwner,
            });
        }
        catch {
            // 端口抛错 ⇒ 已尝试投递但失败；绝不原样冒出，也绝不误判成前置拒绝或成功。
            throw refusal('session.deliveryFailed');
        }
        if (outcome === null || typeof outcome !== 'object' || outcome.ok !== true) {
            const code = outcome !== null && typeof outcome === 'object' ? outcome.code : undefined;
            if (code === 'E_SESSION_UNAVAILABLE')
                throw refusal('session.unavailable');
            // 任何其它 code（含自由文本 / 未知码 / 空值）一律 fail-closed 到 deliveryFailed。
            throw refusal('session.deliveryFailed');
        }
        const result = projectDelivery(outcome);
        if (!result.accepted)
            throw refusal('session.deliveryFailed');
        // 调用返回后再读一次 head：没有 CAS，不能阻止漂移，只能事后记录。
        // 读取失败按「未观察到漂移」处理（不让辅助观测破坏已确认的投递结果）。
        let headDrift = false;
        let observedHeadSha = '';
        try {
            observedHeadSha = headReader !== null
                ? await headReader.readHeadSha({ instanceId, sessionId: request.sessionId })
                : (lease?.headSha ?? '');
            headDrift = observedHeadSha !== '' && head !== '' && observedHeadSha !== head;
        }
        catch {
            headDrift = false;
        }
        // record-on-success：只在投递成功后落账；写失败是独立的 typed 警告，不静默。
        try {
            const recorded = await ledger.record(request.sessionId, request.requestId, nowMs, {
                payloadSha256: result.payloadSha256,
                headDrift,
                observedHeadSha,
            });
            if (!recorded.ok)
                throw refusal('session.recordFailed');
        }
        catch (error) {
            if (error instanceof SyncError && error.code === 'E_SESSION_RECORD_FAILED')
                throw error;
            throw refusal('session.recordFailed');
        }
        return result;
    }
    return { markerPath, channelState, channelVerified, send };
}
/** 供 RPC 层做入参形状检查时复用（DARK 纪律：码与文案不另造）。 */
export const DARK_MARKER_CODE = PROMPT_ERROR_CODES.CHANNEL_UNVERIFIED;
