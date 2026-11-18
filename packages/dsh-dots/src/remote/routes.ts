/**
 * 旁挂监听的**鉴权 / 路由层**（`/__dsh_remote/*`）——本域唯一决定「放不放行」的地方。
 *
 * 为什么这一层必须自己写、不能复用 DSH 的 `connection.requestRejection`：
 *   1. 旁挂监听是**独立 http.Server**，请求不经过 DSH 的 connection 服务；
 *   2. 即便复用，DSH 的浏览器会话是绑定 authority 的 cookie，外部 authority（局域网 IP、
 *      隧道域名）拿不到它；而我们要让平板用**我们自己的令牌**进场。
 *
 * 设计约束（安全边界，改动前先读 `docs/RESEARCH-A-mobile-remote.md` §7）：
 *   - **禁止**「裸 `GET /` 自动补 DSH `?token=` 下发 cookie」——参考插件就是这么把 LAN 变成无鉴权的；
 *   - 令牌只认三种入口：URL 的 `?token=`、`x-dsh-remote-token` 头、会话 cookie；
 *     命中 `?token=` 时**绝不**把该请求转发给上游（否则 DSH 会拿错误的 token 直接 401），
 *     而是 303 重定向到去掉 token 的同一路径，并下发我们自己的会话 cookie；
 *   - 上游身份（`dsh-auth-*` cookie）由调用方注入，**只出现在请求头里**，不下发给客户端
 *     （listener 默认剥 `set-cookie`，本层再做一次白名单式构造）；
 *   - 令牌明文与上游 cookie 明文都不出现在任何响应体 / 错误消息里；
 *   - 失败按对端 IP 限速；没有 IP 时退化为 `unknown` 桶（不能因此放行）。
 *
 * 本模块是**同步纯函数**（无 I/O、无定时器），因此可以在 `node:test` 里穷举分支；
 * 取上游 cookie 的回调也要求同步（由 `service.ts` 在后台刷新缓存），避免 authorize 变异步。
 */
import type { RemoteAccessMode } from './types.js'

/** listener 传给 authorize 的请求摘要（与 `listener.ts` 的结构化契约，不 import 它的实现）。 */
export interface RemoteAuthorizeInput {
  method: string
  /** 原始请求目标（`/path?query`），可能不含 scheme。 */
  url: string
  /** 请求头（键名大小写不敏感，取用方自己归一）。 */
  headers: Record<string, string>
  /** 对端地址（IPv6 不带方括号）；取不到时为空串。 */
  remoteAddress?: string
}

/** 放行（可附带注入给上游的请求头）或就地响应（不转发上游）。 */
export type RemoteAuthorizeResult =
  | { kind: 'allow'; upstreamHeaders?: Record<string, string> }
  | { kind: 'respond'; status: number; headers?: Record<string, string>; body?: string }

/** 令牌门的结构化契约；`service.ts` 用适配器包住 `auth.ts` 的 `RemoteAuth`。 */
export interface RemoteGate {
  /** 用令牌换会话 cookie。`setCookie` 是**完整的** Set-Cookie 头值。 */
  exchange(token: string, nowMs: number): { ok: boolean; setCookie: string; reason: string }
  /** 校验我们自己的会话 cookie 头。 */
  valid(cookieHeader: string | undefined, nowMs: number): boolean
  /** 记一次鉴权失败；返回是否已被限速。 */
  fail(ip: string, nowMs: number): { limited: boolean; retryAfterSec: number }
  /** 轮换令牌（可选）：实现方应同时吊销所有已签发会话。 */
  setToken?(token: string): void
}

export interface RemoteAuthorizerOptions {
  gate: RemoteGate
  /** 当前访问方式（只用于 `/health` 展示）。 */
  mode: () => RemoteAccessMode
  /** 插件版本（只用于 `/health` 展示）。 */
  version?: () => string
  /**
   * 上游 DSH 会话 cookie（形如 `dsh-auth-xxxx=<value>`）；返回 null 表示上游身份不可用，
   * 此时一律 503 —— **fail-closed**，绝不允许"没身份也转发"。
   */
  upstreamCookie: () => string | null
  /** 我们自己的会话 cookie 名（默认 `dsh-remote-session`）。 */
  sessionCookieName?: string
  now?: () => number
}

/** `/__dsh_remote/` 前缀：本层独占的命名空间，其余路径全部交给上游。 */
export const REMOTE_PREFIX = '/__dsh_remote/'

const DEFAULT_SESSION_COOKIE = 'dsh-remote-session'

const NO_STORE_HEADERS: Record<string, string> = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex',
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value
  }
  return undefined
}

/** 从 Cookie 头里取出指定名的值；只做最朴素的 `a=b; c=d` 解析（不实现 RFC 全套）。 */
function cookieValue(cookieHeader: string | undefined, name: string): string | undefined {
  if (cookieHeader === undefined || cookieHeader === '') return undefined
  for (const segment of cookieHeader.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1) continue
    if (segment.slice(0, at).trim() === name) return segment.slice(at + 1).trim()
  }
  return undefined
}

function htmlHeaders(): Record<string, string> {
  return { ...NO_STORE_HEADERS, 'content-type': 'text/html; charset=utf-8' }
}

function jsonHeaders(): Record<string, string> {
  return { ...NO_STORE_HEADERS, 'content-type': 'application/json; charset=utf-8' }
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
].join('')

function unauthorized(status: number, extraHeaders?: Record<string, string>): RemoteAuthorizeResult {
  return {
    kind: 'respond',
    status,
    headers: { ...htmlHeaders(), ...(extraHeaders ?? {}) },
    body: status === 429 ? UNAUTHORIZED_HTML.replace('<h1>需要访问令牌</h1>', '<h1>尝试过多，请稍后再试</h1>') : UNAUTHORIZED_HTML,
  }
}

function jsonError(status: number, code: string, extraHeaders?: Record<string, string>): RemoteAuthorizeResult {
  return {
    kind: 'respond',
    status,
    headers: { ...jsonHeaders(), ...(extraHeaders ?? {}) },
    body: JSON.stringify({ ok: false, error: { code } }),
  }
}

export function createRemoteAuthorizer(options: RemoteAuthorizerOptions): (input: RemoteAuthorizeInput) => RemoteAuthorizeResult {
  const sessionName = options.sessionCookieName ?? DEFAULT_SESSION_COOKIE
  const now = options.now ?? ((): number => Date.now())

  return function authorize(input: RemoteAuthorizeInput): RemoteAuthorizeResult {
    const method = (input.method ?? 'GET').toUpperCase()
    let url: URL
    try {
      url = new URL(typeof input.url === 'string' && input.url !== '' ? input.url : '/', 'http://dsh.invalid')
    } catch {
      return jsonError(400, 'E_BAD_REQUEST')
    }
    const path = url.pathname
    const headers = input.headers ?? {}
    const headersCookie = headerValue(headers, 'cookie')
    const ip = input.remoteAddress !== undefined && input.remoteAddress !== '' ? input.remoteAddress : 'unknown'

    // ---------------------------------------------------------------- 健康检查
    // 给隧道/反向代理做存活探测用：不带任何秘密，也不需要令牌（cloudflared 的健康检查拿不到令牌）。
    if (path === `${REMOTE_PREFIX}health`) {
      if (method !== 'GET' && method !== 'HEAD') return jsonError(405, 'E_METHOD')
      const version = options.version === undefined ? 'unknown' : options.version()
      return {
        kind: 'respond',
        status: 200,
        headers: jsonHeaders(),
        body: JSON.stringify({ ok: true, app: 'dsh-remote', mode: options.mode(), version }),
      }
    }

    // ---------------------------------------------------------------- 令牌入口
    // `?token=` 一律在本层消化：换 cookie + 303 到干净地址，**绝不**转发上游。
    // 同时接受 `?k=`：`auth.ts` 的 `TOKEN_PARAM` 是 `k`（短链更好扫），两个名字等价；
    // 同时出现两个（甚至多个）视为歧义输入，直接拒绝。
    const tokens = [...url.searchParams.getAll('token'), ...url.searchParams.getAll('k')]
    if (tokens.length > 1) {
      const verdict = options.gate.fail(ip, now())
      return verdict.limited ? unauthorized(429, { 'retry-after': String(verdict.retryAfterSec) }) : unauthorized(401)
    }
    if (tokens.length === 1) {
      const token = tokens[0] ?? ''
      const exchanged = options.gate.exchange(token, now())
      if (exchanged.ok && exchanged.setCookie !== '') {
        // 去掉 token 参数，保留其它 query 与路径；`/__dsh_remote/login` 回到首页。
        const clean = new URL(url.href)
        clean.searchParams.delete('token')
        clean.searchParams.delete('k')
        const target = path === `${REMOTE_PREFIX}login` ? '/' : `${clean.pathname}${clean.search}${clean.hash}`
        return {
          kind: 'respond',
          status: 303,
          headers: {
            ...NO_STORE_HEADERS,
            location: target === '' ? '/' : target,
            'set-cookie': exchanged.setCookie,
          },
          body: '',
        }
      }
      const verdict = options.gate.fail(ip, now())
      if (verdict.limited) {
        return unauthorized(429, { 'retry-after': String(verdict.retryAfterSec) })
      }
      return unauthorized(401)
    }

    // ---------------------------------------------------------------- 本层命名空间的其它路径
    if (path.startsWith(REMOTE_PREFIX)) {
      // `/__dsh_remote/login` 无 token 时给登录页（不消耗失败计数：用户只是打开了表单）。
      if (path === `${REMOTE_PREFIX}login` && (method === 'GET' || method === 'HEAD')) {
        return unauthorized(401)
      }
      return jsonError(404, 'E_NOT_FOUND')
    }

    // ---------------------------------------------------------------- 会话校验
    const cookie = cookieValue(headersCookie, sessionName)
    if (cookie === undefined || !options.gate.valid(headersCookie, now())) {
      const verdict = options.gate.fail(ip, now())
      if (verdict.limited) {
        return unauthorized(429, { 'retry-after': String(verdict.retryAfterSec) })
      }
      // `/api/*` 是 Web/WS 客户端：给 JSON，别塞一整页 HTML。
      if (path === '/api' || path.startsWith('/api/')) return jsonError(401, 'E_UNAUTHORIZED')
      return unauthorized(401)
    }

    // ---------------------------------------------------------------- 放行
    const upstream = options.upstreamCookie()
    if (upstream === null || upstream === '') {
      // 上游身份拿不到（DSH 会话换取失败）：宁可 503，也不要把未认证请求怼给上游。
      return jsonError(503, 'E_UPSTREAM_IDENTITY')
    }
    // 只把上游自己的 cookie 交给上游：客户端带来的其余 cookie（含我们的会话值）不下行转发。
    return { kind: 'allow', upstreamHeaders: { cookie: upstream } }
  }
}

/** 供测试 / 诊断用：把 URL 里的 `token` / `k` 参数抹掉（不改变其它部分）。 */
export function stripTokenFromUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl, 'http://dsh.invalid')
    url.searchParams.delete('token')
    url.searchParams.delete('k')
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    return '/'
  }
}
