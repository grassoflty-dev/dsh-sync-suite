/** `/__dsh_remote/` 前缀：本层独占的命名空间，其余路径全部交给上游。 */
export const REMOTE_PREFIX = '/__dsh_remote/';
const DEFAULT_SESSION_COOKIE = 'dsh-remote-session';
const NO_STORE_HEADERS = {
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-robots-tag': 'noindex',
};
function headerValue(headers, name) {
    const wanted = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === wanted)
            return value;
    }
    return undefined;
}
/** 从 Cookie 头里取出指定名的值；只做最朴素的 `a=b; c=d` 解析（不实现 RFC 全套）。 */
function cookieValue(cookieHeader, name) {
    if (cookieHeader === undefined || cookieHeader === '')
        return undefined;
    for (const segment of cookieHeader.split(';')) {
        const at = segment.indexOf('=');
        if (at === -1)
            continue;
        if (segment.slice(0, at).trim() === name)
            return segment.slice(at + 1).trim();
    }
    return undefined;
}
function htmlHeaders() {
    return { ...NO_STORE_HEADERS, 'content-type': 'text/html; charset=utf-8' };
}
function jsonHeaders() {
    return { ...NO_STORE_HEADERS, 'content-type': 'application/json; charset=utf-8' };
}
/**
 * 401 页面：**静态** HTML（不含任何用户输入，杜绝反射型 XSS）。
 * 表单用 GET 提交到同一路径，因为 authorize 层拿不到请求体（不解析 body）。
 */
const UNAUTHORIZED_HTML = [
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>需要访问令牌</title>',
    '<style>body{font:16px/1.6 system-ui,sans-serif;margin:0;padding:24px;background:#fff;color:#111}',
    'form{margin-top:16px}input{font-size:16px;padding:10px;width:100%;box-sizing:border-box;border:1px solid #ccc}',
    'button{font-size:16px;padding:10px 16px;margin-top:12px;width:100%}',
    'p{color:#444}</style></head><body>',
    '<h1>需要访问令牌</h1>',
    '<p>这个地址需要电脑上生成的访问令牌。在电脑的 DSH 设置页「远程访问」里扫码，或把令牌填到下面。</p>',
    '<form method="get" action="/__dsh_remote/login">',
    '<input name="token" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="访问令牌">',
    '<button type="submit">进入</button></form>',
    '<p>令牌只存在你的浏览器里，不会写进日志。</p>',
    '</body></html>',
].join('');
function unauthorized(status, extraHeaders) {
    return {
        kind: 'respond',
        status,
        headers: { ...htmlHeaders(), ...(extraHeaders ?? {}) },
        body: status === 429 ? UNAUTHORIZED_HTML.replace('<h1>需要访问令牌</h1>', '<h1>尝试过多，请稍后再试</h1>') : UNAUTHORIZED_HTML,
    };
}
function jsonError(status, code, extraHeaders) {
    return {
        kind: 'respond',
        status,
        headers: { ...jsonHeaders(), ...(extraHeaders ?? {}) },
        body: JSON.stringify({ ok: false, error: { code } }),
    };
}
export function createRemoteAuthorizer(options) {
    const sessionName = options.sessionCookieName ?? DEFAULT_SESSION_COOKIE;
    const now = options.now ?? (() => Date.now());
    return function authorize(input) {
        const method = (input.method ?? 'GET').toUpperCase();
        let url;
        try {
            url = new URL(typeof input.url === 'string' && input.url !== '' ? input.url : '/', 'http://dsh.invalid');
        }
        catch {
            return jsonError(400, 'E_BAD_REQUEST');
        }
        const path = url.pathname;
        const headers = input.headers ?? {};
        const headersCookie = headerValue(headers, 'cookie');
        const ip = input.remoteAddress !== undefined && input.remoteAddress !== '' ? input.remoteAddress : 'unknown';
        // ---------------------------------------------------------------- 健康检查
        // 给隧道/反向代理做存活探测用：不带任何秘密，也不需要令牌（cloudflared 的健康检查拿不到令牌）。
        if (path === `${REMOTE_PREFIX}health`) {
            if (method !== 'GET' && method !== 'HEAD')
                return jsonError(405, 'E_METHOD');
            const version = options.version === undefined ? 'unknown' : options.version();
            return {
                kind: 'respond',
                status: 200,
                headers: jsonHeaders(),
                body: JSON.stringify({ ok: true, app: 'dsh-remote', mode: options.mode(), version }),
            };
        }
        // ---------------------------------------------------------------- 令牌入口
        // `?token=` 一律在本层消化：换 cookie + 303 到干净地址，**绝不**转发上游。
        // 同时接受 `?k=`：`auth.ts` 的 `TOKEN_PARAM` 是 `k`（短链更好扫），两个名字等价；
        // 同时出现两个（甚至多个）视为歧义输入，直接拒绝。
        const tokens = [...url.searchParams.getAll('token'), ...url.searchParams.getAll('k')];
        if (tokens.length > 1) {
            const verdict = options.gate.fail(ip, now());
            return verdict.limited ? unauthorized(429, { 'retry-after': String(verdict.retryAfterSec) }) : unauthorized(401);
        }
        if (tokens.length === 1) {
            const token = tokens[0] ?? '';
            const exchanged = options.gate.exchange(token, now());
            if (exchanged.ok && exchanged.setCookie !== '') {
                // 去掉 token 参数，保留其它 query 与路径；`/__dsh_remote/login` 回到首页。
                const clean = new URL(url.href);
                clean.searchParams.delete('token');
                clean.searchParams.delete('k');
                const target = path === `${REMOTE_PREFIX}login` ? '/' : `${clean.pathname}${clean.search}${clean.hash}`;
                return {
                    kind: 'respond',
                    status: 303,
                    headers: {
                        ...NO_STORE_HEADERS,
                        location: target === '' ? '/' : target,
                        'set-cookie': exchanged.setCookie,
                    },
                    body: '',
                };
            }
            const verdict = options.gate.fail(ip, now());
            if (verdict.limited) {
                return unauthorized(429, { 'retry-after': String(verdict.retryAfterSec) });
            }
            return unauthorized(401);
        }
        // ---------------------------------------------------------------- 本层命名空间的其它路径
        if (path.startsWith(REMOTE_PREFIX)) {
            // `/__dsh_remote/login` 无 token 时给登录页（不消耗失败计数：用户只是打开了表单）。
            if (path === `${REMOTE_PREFIX}login` && (method === 'GET' || method === 'HEAD')) {
                return unauthorized(401);
            }
            return jsonError(404, 'E_NOT_FOUND');
        }
        // ---------------------------------------------------------------- 会话校验
        const cookie = cookieValue(headersCookie, sessionName);
        if (cookie === undefined || !options.gate.valid(headersCookie, now())) {
            const verdict = options.gate.fail(ip, now());
            if (verdict.limited) {
                return unauthorized(429, { 'retry-after': String(verdict.retryAfterSec) });
            }
            // `/api/*` 是 Web/WS 客户端：给 JSON，别塞一整页 HTML。
            if (path === '/api' || path.startsWith('/api/'))
                return jsonError(401, 'E_UNAUTHORIZED');
            return unauthorized(401);
        }
        // ---------------------------------------------------------------- 放行
        const upstream = options.upstreamCookie();
        if (upstream === null || upstream === '') {
            // 上游身份拿不到（DSH 会话换取失败）：宁可 503，也不要把未认证请求怼给上游。
            return jsonError(503, 'E_UPSTREAM_IDENTITY');
        }
        // 只把上游自己的 cookie 交给上游：客户端带来的其余 cookie（含我们的会话值）不下行转发。
        return { kind: 'allow', upstreamHeaders: { cookie: upstream } };
    };
}
/** 供测试 / 诊断用：把 URL 里的 `token` / `k` 参数抹掉（不改变其它部分）。 */
export function stripTokenFromUrl(rawUrl) {
    try {
        const url = new URL(rawUrl, 'http://dsh.invalid');
        url.searchParams.delete('token');
        url.searchParams.delete('k');
        return `${url.pathname}${url.search}${url.hash}`;
    }
    catch {
        return '/';
    }
}
