/**
 * 远程访问域：认证门（URL token → Cookie 会话 + 按 IP 限速）。
 *
 * 纪律（与 `src/remote/types.ts` 同一套）：
 *   1. 本文件只依赖 `node:crypto`；**禁止** import `src/engine/**`（`errors.ts` 这类纯工具也
 *      不必借）、`src/schedule/**`。远程域要能单独被测、单独被审。
 *   2. 一切失败 **fail-closed**：token 缺失 / 不匹配 / 会话缺失 / 会话过期 → 一律 false，
 *      绝不"出错就放行"。
 *   3. **token 明文永不出现在返回值 reason、日志、错误消息里**：reason 只给稳定短语
 *      （`missing-token` / `invalid-token` / …），`maskedToken()` 只暴露前 4 字符 + 长度。
 *   4. 会话**不落盘**：内存 `Map<sessionId, expiresAt>`，进程重启即全部失效（重启要重新
 *      扫一次二维码，这是安全的一侧）。
 *
 * 本机回环免认证（`127.0.0.1` / `::1`）**不在本文件判定后放行**，只提供纯函数
 * `isLoopback(ip)`；是否豁免由调用方（`routes.ts`）显式决定，避免认证门自己"开洞"。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
/** URL 上携带一次性 token 的查询参数名（`?k=…`）。 */
export const TOKEN_PARAM = 'k';
/** 会话 Cookie 名（`HttpOnly`，不可被页面脚本读到）。`routes.ts` 按本常量读写。 */
export const SESSION_COOKIE_NAME = 'dsh_remote_session';
/**
 * 会话 Cookie 的**兼容别名**。`pm` 侧曾按 `dsh-remote-session` 提过一版命名，
 * 两个名字同时认、同时下发（见 `exchangeToken().cookies`），任何一侧的读取都能对上；
 * 下发的规范名仍是 {@link SESSION_COOKIE_NAME}。
 */
export const SESSION_COOKIE_ALIAS = 'dsh-remote-session';
/** 读取会话时依次尝试的名字（规范名在前）。 */
export const SESSION_COOKIE_NAMES = [SESSION_COOKIE_NAME, SESSION_COOKIE_ALIAS];
/** 会话默认存活时间：12 小时（够一次"平板扫一下用半天"，又不至于长期有效）。 */
export const DEFAULT_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
/** 每 IP 每分钟允许的失败次数上限（默认 5；第 6 次起 429）。 */
export const DEFAULT_MAX_FAILURES_PER_MINUTE = 5;
/** 限速滑动窗口长度。 */
export const FAILURE_WINDOW_MS = 60_000;
/** 会话 id 的随机字节数（base64url 后 43 字符）。 */
const SESSION_ID_BYTES = 32;
/**
 * 生成一个 URL 安全的不透明 token：`crypto.randomBytes(bytes)` → base64url（无填充）。
 * 默认 32 字节（256 bit 熵）→ 43 字符。字节数越界直接抛错（不静默降级成弱 token）。
 */
export function generateToken(bytes = 32) {
    const n = Number.isFinite(bytes) ? Math.trunc(bytes) : NaN;
    if (!Number.isFinite(n) || n < 8 || n > 128) {
        throw new RangeError('token 长度必须是 8..128 字节之间的整数');
    }
    return randomBytes(n).toString('base64url');
}
/**
 * token 指纹：`sha256(token)` 十六进制前 8 位。给日志 / `remoteGetState` / 状态栏用——
 * 能确认"是哪一个 token"而**永不暴露明文**（8 hex 仅作标识，不可拿来鉴权）。
 */
export function tokenFingerprint(token) {
    const s = typeof token === 'string' ? token : '';
    if (s.length === 0)
        return '';
    return createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 8);
}
/**
 * 常量时间字符串比较。
 *
 * 实现：两边**先各自 sha256**，摘要长度恒为 32 字节，再 `crypto.timingSafeEqual`。
 * 因此长度不等与内容不等在时间上不可区分（没有 early-return，也不按长度分支），
 * 末位把原始长度差折进 diff 位作双保险。空串与空串视为相等；空串与非空串不等。
 */
export function timingSafeEqualText(a, b) {
    const left = typeof a === 'string' ? a : '';
    const right = typeof b === 'string' ? b : '';
    const digestLeft = createHash('sha256').update(left, 'utf8').digest();
    const digestRight = createHash('sha256').update(right, 'utf8').digest();
    let diff = left.length ^ right.length;
    if (!timingSafeEqual(digestLeft, digestRight))
        diff |= 1;
    return diff === 0;
}
/**
 * 解析 `Cookie` 请求头。
 *
 * 规则（写死以免各调用方各自解释）：
 *   - 按 `;` 切段，段首尾空白丢弃，空段忽略；
 *   - 段内按**第一个** `=` 切名/值（值里可以再含 `=`，例如 base64 填充）；
 *   - 无 `=` 的段、名字为空的段 = 坏格式，**跳过**（不抛错，也不猜）；
 *   - 值两侧成对的双引号会剥掉（RFC 6265 引号值）；
 *   - 值含 `%` 时尝试 `decodeURIComponent`，解码失败保留原样（坏编码不致命）；
 *   - **重复键后者覆盖前者**（与 Node 生态 `cookie.parse` 一致）；`__proto__` 直接忽略。
 */
export function parseCookieHeader(header) {
    const jar = {};
    if (typeof header !== 'string' || header.length === 0)
        return jar;
    for (const part of header.split(';')) {
        const seg = part.trim();
        if (seg.length === 0)
            continue;
        const eq = seg.indexOf('=');
        if (eq <= 0)
            continue;
        const name = seg.slice(0, eq).trim();
        if (name.length === 0 || name === '__proto__')
            continue;
        let value = seg.slice(eq + 1).trim();
        if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
            value = value.slice(1, -1);
        }
        jar[name] = decodeCookieValue(value);
    }
    return jar;
}
/** Cookie 值解码：只在含 `%` 时尝试，失败保留字面量（损坏的百分号编码不该 500）。 */
function decodeCookieValue(value) {
    if (value.indexOf('%') < 0)
        return value;
    try {
        return decodeURIComponent(value);
    }
    catch {
        return value;
    }
}
/**
 * 组装会话 `Set-Cookie` 头：`HttpOnly; SameSite=Lax; Path=/; Max-Age=<秒>`。
 *
 * 不加 `Secure`：局域网通常是 http（加了浏览器就不回传，等于认证失效）；
 * 公网/隧道方式要 https 时由调用方另加（本插件默认不假设 TLS）。
 * 值里出现非法字符时走 `encodeURIComponent`，避免拼头注入。
 */
export function buildSessionCookie(value, ttlMs) {
    const raw = typeof value === 'string' ? value : String(value ?? '');
    const safe = /^[A-Za-z0-9._~-]{1,256}$/.test(raw) ? raw : encodeURIComponent(raw);
    const ttl = Number.isFinite(ttlMs) ? Math.max(0, Math.trunc(ttlMs)) : 0;
    const maxAge = Math.floor(ttl / 1000);
    return `${SESSION_COOKIE_NAME}=${safe}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}
/**
 * 是否回环地址（`127.0.0.0/8`、`::1`、IPv4-mapped `::ffff:127.x.x.x`）。
 *
 * 只做**地址字面量**判断：`localhost` 这类名字不算（可能被 hosts 改写），
 * 也不做 DNS 反解（反解可被伪造，正是要避免的洞）。空串/未知名一律 false（fail-closed）。
 */
export function isLoopback(ip) {
    if (typeof ip !== 'string')
        return false;
    let s = ip.trim().toLowerCase();
    if (s.length === 0)
        return false;
    if (s.startsWith('[') && s.endsWith(']'))
        s = s.slice(1, -1);
    const zone = s.indexOf('%');
    if (zone >= 0)
        s = s.slice(0, zone);
    if (s.startsWith('::ffff:'))
        s = s.slice('::ffff:'.length);
    if (s === '::1' || s === '0:0:0:0:0:0:0:1')
        return true;
    const parts = s.split('.');
    if (parts.length !== 4)
        return false;
    const nums = [];
    for (const p of parts) {
        if (!/^\d{1,3}$/.test(p))
            return false;
        const n = Number(p);
        if (n > 255)
            return false;
        nums.push(n);
    }
    return nums[0] === 127;
}
/**
 * 认证门状态机：token（可轮换）→ 一次性签发会话 Cookie → 后续请求校验 Cookie → 按 IP 限速。
 *
 * 所有方法都接受可注入的 `now`（毫秒），测试不需要 sleep。
 */
export class RemoteAuth {
    token = '';
    tokenCreatedAtMs = 0;
    tokenTtlMs;
    maxFailuresPerMinute;
    /** sessionId → 过期时刻（毫秒）。不落盘；过期即删。 */
    sessions = new Map();
    /** ip → 窗口内的失败时刻（升序）。 */
    failures = new Map();
    constructor(opts = {}) {
        const ttl = opts && Number.isFinite(opts.tokenTtlMs) ? Math.trunc(opts.tokenTtlMs) : 0;
        this.tokenTtlMs = ttl > 0 ? ttl : DEFAULT_TOKEN_TTL_MS;
        const max = opts && Number.isFinite(opts.maxFailuresPerMinute)
            ? Math.trunc(opts.maxFailuresPerMinute)
            : 0;
        this.maxFailuresPerMinute = max > 0 ? max : DEFAULT_MAX_FAILURES_PER_MINUTE;
        this.setToken();
    }
    /**
     * 轮换当前 token（不传则新生成），并**立即吊销所有已签发会话**。
     *
     * 为什么连会话一起吊销：轮换的唯一动机就是"旧链接可能泄露了"，此时还留着旧链接换来的
     * 会话等于没轮换。返回新 token 明文，供调用方拼出 `RemoteLink` / 二维码（唯一合法出口）。
     */
    setToken(token) {
        const next = typeof token === 'string' && token.length > 0 ? token : generateToken();
        this.token = next;
        this.tokenCreatedAtMs = Date.now();
        this.sessions.clear();
        return next;
    }
    /** 当前 token 是否存在（从不返回明文）。 */
    hasToken() {
        return this.token.length > 0;
    }
    /**
     * 取当前 token 明文——**本域唯一的明文出口**，等价于 `types.ts` 里 `RemoteLink.url` 的那条例外。
     *
     * 只允许两个调用点用它：① 拼 `RemoteLink`（用户显式点「显示链接」）；② 生成二维码。
     * 严禁写进日志、错误消息、`RemoteStatus` 或任何 RPC 返回值（除 `RemoteLink` 外）。
     */
    getToken() {
        return this.token;
    }
    /** 打码展示：前 4 字符 + 长度，例如 `a1b2…(43 chars)`。永不多于 4 字符明文。 */
    maskedToken() {
        if (this.token.length === 0)
            return '';
        return `${this.token.slice(0, 4)}…(${this.token.length} chars)`;
    }
    /** token 生成时刻（ISO）；无 token 时 null。 */
    tokenCreatedAt() {
        return this.token.length > 0 ? new Date(this.tokenCreatedAtMs).toISOString() : null;
    }
    /**
     * 当前 token 的指纹（见 {@link tokenFingerprint}，sha256 前 8 位）。
     * 轮换后指纹必变，可用于确认"扫码用的还是不是现在这把"。
     */
    currentTokenFingerprint() {
        return tokenFingerprint(this.token);
    }
    /**
     * 用 URL token 换会话 Cookie。
     *
     * 失败一律 `ok:false` + 稳定 `reason`：`missing-token`（空/非字符串）、`no-token`
     * （服务端尚未持有 token，fail-closed）、`invalid-token`（不匹配）。成功则签发新会话 id
     * （32 字节随机，不可预测）并返回完整 `Set-Cookie` 值。
     */
    exchangeToken(token, now) {
        const at = this.now(now);
        this.pruneSessions(at);
        if (typeof token !== 'string' || token.length === 0)
            return { ok: false, reason: 'missing-token' };
        if (this.token.length === 0)
            return { ok: false, reason: 'no-token' };
        if (!timingSafeEqualText(token, this.token))
            return { ok: false, reason: 'invalid-token' };
        const sessionId = generateToken(SESSION_ID_BYTES);
        this.sessions.set(sessionId, at + this.tokenTtlMs);
        const cookie = buildSessionCookie(sessionId, this.tokenTtlMs);
        const aliasCookie = `${SESSION_COOKIE_ALIAS}=${sessionId}; Path=/; HttpOnly; SameSite=Lax; ` +
            `Max-Age=${Math.floor(this.tokenTtlMs / 1000)}`;
        return { ok: true, cookie, cookies: [cookie, aliasCookie] };
    }
    /**
     * 校验 `Cookie` 头里的会话并给出**可区分的**原因（`routes.ts` 据此决定 401 文案/日志）：
     * `missing` = 没带 Cookie 或没有会话键；`expired` = 有过但已过期（顺手删除）；
     * `invalid` = 带了但不在本进程会话表里（伪造 / 重启前的旧会话）。
     */
    inspectCookie(cookieHeader, now) {
        const at = this.now(now);
        // 注意顺序：先按 id 查一次再清理过期项，否则"过期"会被清理成"不存在"，诊断就退化成 invalid
        const jar = parseCookieHeader(cookieHeader);
        let sessionId = '';
        for (const name of SESSION_COOKIE_NAMES) {
            const value = jar[name];
            if (typeof value === 'string' && value.length > 0) {
                sessionId = value;
                break;
            }
        }
        if (sessionId.length === 0) {
            this.pruneSessions(at);
            return { ok: false, reason: 'missing' };
        }
        const expiresAt = this.sessions.get(sessionId);
        if (expiresAt === undefined) {
            this.pruneSessions(at);
            return { ok: false, reason: 'invalid' };
        }
        if (!(at < expiresAt)) {
            this.sessions.delete(sessionId);
            this.pruneSessions(at);
            return { ok: false, reason: 'expired' };
        }
        this.pruneSessions(at);
        return { ok: true, reason: 'ok' };
    }
    /**
     * 校验 `Cookie` 头里的会话。无 Cookie / 无此会话 / 已过期 → false（过期项顺手删掉）。
     * 注意：会话**不滑动续期**（签发的 TTL 就是硬上限，到期必须重扫二维码）。
     */
    checkCookie(cookieHeader, now) {
        return this.inspectCookie(cookieHeader, now).ok;
    }
    /**
     * 记一次失败（按 IP）。滑动 60s 窗口内**超过** `maxFailuresPerMinute` 才 `limited`：
     * 上限 5 时第 5 次仍不限，第 6 次起限速。`retryAfterSec` = 最早那次失败滑出窗口还需几秒
     * （至少 1，向上取整）。
     */
    registerFailure(ip, now) {
        const at = this.now(now);
        const key = typeof ip === 'string' && ip.length > 0 ? ip : 'unknown';
        let times = this.failures.get(key);
        if (times === undefined) {
            times = [];
            this.failures.set(key, times);
        }
        const cutoff = at - FAILURE_WINDOW_MS;
        let drop = 0;
        while (drop < times.length && times[drop] <= cutoff)
            drop++;
        if (drop > 0)
            times.splice(0, drop);
        times.push(at);
        if (times.length <= this.maxFailuresPerMinute)
            return { limited: false };
        const oldest = times[0];
        const retryAfterSec = Math.max(1, Math.ceil((oldest + FAILURE_WINDOW_MS - at) / 1000));
        return { limited: true, retryAfterSec };
    }
    /**
     * 清零失败计数：给定 IP 只清该 IP，省略则清全部。
     * 成功认证（换到会话 / 校验通过）后调用，避免正常用户被自己之前的输错连累。
     */
    resetFailures(ip) {
        if (typeof ip === 'string' && ip.length > 0)
            this.failures.delete(ip);
        else
            this.failures.clear();
    }
    /** 清空会话与失败计数（token 保留；换 token 请用 `setToken`）。 */
    reset(now) {
        void now;
        this.sessions.clear();
        this.failures.clear();
    }
    /** 当前有效会话数（先按当前时刻清掉过期项）。 */
    sessionCount() {
        this.pruneSessions(Date.now());
        return this.sessions.size;
    }
    /** 清掉过期会话（`checkCookie` / `exchangeToken` 每次都会先调用，避免无界增长）。 */
    pruneSessions(now) {
        const at = this.now(now);
        let removed = 0;
        for (const [id, expiresAt] of this.sessions) {
            if (!(at < expiresAt)) {
                this.sessions.delete(id);
                removed++;
            }
        }
        return removed;
    }
    now(now) {
        return typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
    }
}
