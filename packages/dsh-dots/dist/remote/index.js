/**
 * 远程访问域的**薄壳装配**（唯一入口）。
 *
 * 装配顺序（每一步都可失败，失败只体现在 `RemoteStatus.lastError`，绝不影响插件启动）：
 *   store（remote.json / remote-token.json）
 *     → auth（令牌门状态机，种子来自 store）
 *     → gate 适配器（把 `RemoteAuth` 收窄成 `routes.ts` 认的 `RemoteGate`）
 *     → service（状态机：settings / 启停 / 自检 / 二维码）
 *     → listener（真正监听并反代）
 *
 * 为什么 token 由 store 管、而不是让 `RemoteAuth` 自己生成：
 *   `RemoteAuth` 的 token 只在内存里，进程重启就换一把 —— 那用户桌上的二维码第二天就失效。
 *   持久化后重启仍能用同一把，轮换是一次显式动作（`remoteRotateToken`）。
 */
import { RemoteAuth, SESSION_COOKIE_NAME, generateToken } from './auth.js';
import { startRemoteListener } from './listener.js';
import { encodeQr } from './qr.js';
import { runProbe } from './probe.js';
import { createRemoteService } from './service.js';
import { RemoteStore } from './store.js';
/**
 * 确保磁盘上有一把 token；没有就用 `crypto.randomBytes(32)` 生成并落盘（0600）。
 * 返回明文 token（只在装配期用一次，之后由 `RemoteAuth` 持有）。
 */
export function ensureToken(store) {
    const existing = store.readToken();
    if (existing !== null)
        return existing.token;
    const token = generateToken(32);
    store.writeToken({ token, createdAt: new Date().toISOString() });
    return token;
}
/** 把 `RemoteAuth` 适配成 `routes.ts` 的 `RemoteGate`（只暴露最小面）。 */
export function createGateFromAuth(auth) {
    return {
        exchange(token, nowMs) {
            const result = auth.exchangeToken(token, nowMs);
            if (!result.ok)
                return { ok: false, setCookie: '', reason: result.reason ?? 'invalid-token' };
            // 只下发**规范名**那一个 cookie：listener 的 respond 头是 `Record<string,string>`，
            // 塞不下多条 Set-Cookie；兼容别名留给老客户端没有意义（我们自己就是唯一客户端）。
            return { ok: true, setCookie: result.cookie ?? '', reason: '' };
        },
        valid(cookieHeader, nowMs) {
            return auth.checkCookie(cookieHeader, nowMs);
        },
        fail(ip, nowMs) {
            const result = auth.registerFailure(ip, nowMs);
            return { limited: result.limited, retryAfterSec: result.retryAfterSec ?? 0 };
        },
        setToken(token) {
            auth.setToken(token);
        },
    };
}
export function createRemoteModule(options = {}) {
    const store = new RemoteStore({ homeDir: options.homeDir });
    const token = ensureToken(store);
    const auth = new RemoteAuth();
    auth.setToken(token);
    const service = createRemoteService({
        homeDir: options.homeDir,
        connection: options.connection,
        webServer: options.webServer,
        startListener: startRemoteListener,
        createGate: () => createGateFromAuth(auth),
        encodeQr: (text) => encodeQr(text, 'M'),
        runProbe: (mode, settings, deps) => runProbe(mode, settings, { dshPort: deps.dshPort, listenerAddress: deps.listenerAddress }),
        generateToken: () => generateToken(32),
        sessionCookieName: SESSION_COOKIE_NAME,
        ...(options.now === undefined ? {} : { now: options.now }),
    });
    return { service, paths: { configFile: store.configFile, tokenFile: store.tokenFile } };
}
export { createRemoteService } from './service.js';
