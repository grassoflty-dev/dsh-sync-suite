/**
 * 仓库可见性门禁的**插件半侧**（mod-plugin-repo-precheck / mod-repo-privacy-gate）。
 *
 * 【镜像纪律】本文件是 App `apps/arkui-schedule/entry/src/main/ets/model/repoVisibility.ts`
 * 与 `repoVisibilityClient.ts` 的镜像，不是另起一套设计：
 *   - typed 码字符串、逐字中文文案、固定优先级必须与 App 逐字节一致；
 *   - 共享夹具 `test-vectors/repo-visibility/`（SHA256SUMS 钉死）是唯一事实来源；
 *   - 插件独立构建，**不 import apps/****，只复制契约。
 *
 * 固定优先级：host → auth → status → parse → private。
 * - 只有显式 `private: true` 才 ok；缺 `private` 永远不 ok；
 * - 未知 host（自建 / GitLab / 任何白名单外域名）绝不回退成「假定私有」；
 * - 网络错误 / 超时 / 5xx → E_REPO_VISIBILITY_UNKNOWN（未确认私有前不落盘、不 clone）。
 *
 * token 纪律：token 只进 Authorization header；不进 URL、不进日志、不进错误/状态转储。
 */
import { SyncError } from '../engine/errors.js'

/** 成功码（typed，与 App 一致；ok=true 时 message 恒为空串）。 */
export const REPO_VISIBILITY_OK: string = 'OK'

export const E_REPO_PUBLIC: string = 'E_REPO_PUBLIC'
export const E_REPO_AUTH: string = 'E_REPO_AUTH'
export const E_REPO_NOT_FOUND: string = 'E_REPO_NOT_FOUND'
export const E_REPO_HOST_UNSUPPORTED: string = 'E_REPO_HOST_UNSUPPORTED'
export const E_REPO_VISIBILITY_UNKNOWN: string = 'E_REPO_VISIBILITY_UNKNOWN'
export const E_REPO_BAD_RESPONSE: string = 'E_REPO_BAD_RESPONSE'

/** 唯一规则行：同步仓库字段下方的常驻说明（与 App 逐字一致）。 */
export const REPO_PRIVATE_RULE_TEXT: string = '仓库必须是私有仓库（日程、聊天与远程控制配置会提交到这里）'

/** typed 码 → 逐字中文文案（成功是空串：没有拒绝就没有理由）。 */
export const REPO_VISIBILITY_MESSAGES: Record<string, string> = {
  E_REPO_PUBLIC: '仓库是公开的：日程与远程控制配置不允许提交到公开仓库。请把仓库改成私有后重试',
  E_REPO_AUTH: '令牌无权读取该仓库：请确认令牌有效且具备仓库读权限',
  E_REPO_NOT_FOUND: '仓库不存在：请检查地址（owner/repo）后重试',
  E_REPO_HOST_UNSUPPORTED: '不支持自动校验该仓库的可见性。请改用 Gitee 或 GitHub 的私有仓库；本应用不会把无法校验的仓库当作私有',
  E_REPO_VISIBILITY_UNKNOWN: '暂时无法确认仓库可见性：请检查网络后重试（未确认私有前不会提交任何数据）',
  E_REPO_BAD_RESPONSE: '仓库接口返回了非预期内容（可能被代理或登录页拦截）：请检查网络后重试',
}

/** 已取到的响应事实（不传 token / URL，杜绝凭据进入判定层）。 */
export interface RepoVisibilityRequest {
  /** 仓库域名（不含端口）；白名单只有 gitee.com / github.com。 */
  host: string
  /** HTTP 状态码；0 = 没有拿到响应（网络错误 / 超时 / abort）。 */
  status: number
  /** 响应 Content-Type（可含 charset）。 */
  contentType: string
  /** 响应体原文。 */
  body: string
}

/** 判定结果：`ok=false` 时 `code` 必是上面六个 typed 码之一，`message` 必是逐字中文。 */
export interface RepoVisibilityDecision {
  ok: boolean
  code: string
  message: string
}

/** 内部构造：拒绝。 */
function refuse(code: string): RepoVisibilityDecision {
  const message: string | undefined = REPO_VISIBILITY_MESSAGES[code]
  return {
    ok: false,
    code,
    message: typeof message === 'string' ? message : REPO_VISIBILITY_MESSAGES[E_REPO_BAD_RESPONSE]!,
  }
}

/** 内部构造：通过（只有显式 `private: true` 能走到这里）。 */
function accept(): RepoVisibilityDecision {
  return { ok: true, code: REPO_VISIBILITY_OK, message: '' }
}

/** host 归一：trim + 小写 + 去可选端口；拿不到就是空串（→ 不支持）。 */
function normalizeHost(raw: string): string {
  const text: string = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (text.length === 0) return ''
  const colon: number = text.indexOf(':')
  return colon > 0 ? text.slice(0, colon) : text
}

/** 受支持的托管域名（白名单；自建 / GitLab / 其它域名一律不支持）。 */
const SUPPORTED_HOSTS: readonly string[] = ['gitee.com', 'github.com']

/** JSON 里足以证明「这确实是一个仓库对象」的身份键（缺全部 = 200 但没有仓库身份）。 */
const REPO_IDENTITY_KEYS: readonly string[] = [
  'id', 'full_name', 'name', 'path', 'html_url', 'clone_url', 'ssh_url',
]

/** 从 typed 码重建拒绝结果（保存失败后 status 复用上次判定，不再发请求）。 */
export function decisionForRepoCode(code: string): RepoVisibilityDecision {
  return code === REPO_VISIBILITY_OK ? accept() : refuse(code)
}

/**
 * 纯判定：固定优先级 host → auth → status → parse → private。
 *
 * - status 401/403 在 host 之后判（未知 host 即使返回 401 也先报「不支持」）；
 * - 200 JSON 里没有身份键报 NOT_FOUND，有身份键却没有 boolean `private` 报 BAD_RESPONSE。
 */
export function decideRepoVisibility(request: RepoVisibilityRequest): RepoVisibilityDecision {
  const facts: RepoVisibilityRequest =
    request === null || request === undefined
      ? { host: '', status: 0, contentType: '', body: '' }
      : request
  const host: string = normalizeHost(facts.host)
  const status: number = facts.status
  const contentType: string = typeof facts.contentType === 'string' ? facts.contentType.toLowerCase() : ''
  const body: string = typeof facts.body === 'string' ? facts.body : ''

  // 1) host：白名单优先，未知 host 绝不假定私有（即使后面 200 + private:false）。
  if (!SUPPORTED_HOSTS.includes(host)) return refuse(E_REPO_HOST_UNSUPPORTED)

  // 2) auth：令牌无权读取。
  if (status === 401 || status === 403) return refuse(E_REPO_AUTH)

  // 3) status：不存在 / 网络与服务端异常 / 其它非 200。
  if (status === 404) return refuse(E_REPO_NOT_FOUND)
  if (status === 0 || status >= 500) return refuse(E_REPO_VISIBILITY_UNKNOWN)
  if (status !== 200) return refuse(E_REPO_BAD_RESPONSE)

  // 4) parse：HTML / 空体 / 不可解析 / 非对象 / 没有仓库身份。
  if (contentType.includes('html')) return refuse(E_REPO_BAD_RESPONSE)
  const text: string = body.trim()
  if (text.length === 0 || text.charAt(0) === '<') return refuse(E_REPO_BAD_RESPONSE)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return refuse(E_REPO_BAD_RESPONSE)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return refuse(E_REPO_BAD_RESPONSE)
  const obj = parsed as Record<string, unknown>
  const keys: string[] = Object.keys(obj)
  if (!REPO_IDENTITY_KEYS.some((key) => keys.includes(key))) return refuse(E_REPO_NOT_FOUND)

  // 5) private：只认显式 boolean true；false = 公开；缺字段 / 非 boolean = 非预期响应。
  if (!keys.includes('private')) return refuse(E_REPO_BAD_RESPONSE)
  const visibility: unknown = obj.private
  if (typeof visibility !== 'boolean') return refuse(E_REPO_BAD_RESPONSE)
  if (visibility !== true) return refuse(E_REPO_PUBLIC)
  return accept()
}

/** 硬超时上限（毫秒）：≤5s，与 App 的 `REPO_VISIBILITY_TIMEOUT_MS` 一致。 */
export const REPO_VISIBILITY_TIMEOUT_MS: number = 5000

/** 从仓库地址解析出的目标（只有域名 + owner/repo，绝不含 token）。 */
export interface RepoVisibilityTarget {
  host: string
  owner: string
  repo: string
}

/** transport 返回的响应事实（与纯模型的四元组同形）。 */
export interface RepoVisibilityTransportResponse {
  status: number
  contentType: string
  body: string
}

/** transport：真实插件用全局 fetch 适配；测试注入假实现。 */
export type RepoVisibilityTransport = (
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
) => Promise<RepoVisibilityTransportResponse>

/** Gitee / GitHub 的仓库 API 端点；未知 host 返回空串（不发请求，纯模型判 E_REPO_HOST_UNSUPPORTED）。 */
export function providerEndpoint(target: RepoVisibilityTarget | null | undefined): string {
  if (target === null || target === undefined) return ''
  if (target.host === 'gitee.com') return `https://gitee.com/api/v5/repos/${target.owner}/${target.repo}`
  if (target.host === 'github.com') return `https://api.github.com/repos/${target.owner}/${target.repo}`
  return ''
}

/**
 * 请求头：token 唯一落点是 Authorization（Gitee 用 `token`，GitHub 用 `Bearer`）。
 * 同一行里绝不出现 repoUrl 与 token。
 */
export function visibilityHeaders(target: RepoVisibilityTarget, token: string): Record<string, string> {
  const scheme: string = target !== null && target !== undefined && target.host === 'gitee.com' ? 'token' : 'Bearer'
  return {
    'User-Agent': 'dsh-dots',
    Accept: 'application/json',
    Authorization: `${scheme} ${token}`,
  }
}

/**
 * 仓库地址 → 目标；只取域名 + owner/repo，兼容 https/ssh/scp，去掉 `.git` / query / hash。
 * 非法地址返回 null（调用方交给纯模型判 E_REPO_HOST_UNSUPPORTED，不发任何请求）。
 */
export function repoTargetFromUrl(rawUrl: string): RepoVisibilityTarget | null {
  const text: string = typeof rawUrl === 'string' ? rawUrl.trim() : ''
  if (text === '' || /[\s\u3000]/.test(text)) return null
  let host = ''
  let rawPath = ''
  const scp = /^git@([^:/\\\s]+):(.+)$/.exec(text)
  if (scp !== null) {
    host = scp[1] ?? ''
    rawPath = scp[2] ?? ''
  } else {
    const matched = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)([^?#]*)/.exec(text)
    if (matched === null) return null
    const authority = matched[1] ?? ''
    const at = authority.lastIndexOf('@')
    host = at >= 0 ? authority.slice(at + 1) : authority
    rawPath = matched[2] ?? ''
  }
  host = host.toLowerCase().replace(/:\d+$/, '')
  let path = rawPath.replace(/^\/+|\/+$/g, '')
  if (path.toLowerCase().endsWith('.git')) path = path.slice(0, -4)
  const parts = path.split('/').filter((part) => part !== '')
  if (parts.length < 2 || (parts[0] ?? '') === '' || (parts[1] ?? '') === '') return null
  return { host, owner: parts[0]!, repo: parts[1]! }
}

/**
 * 取一次响应并判定。transport 抛错 / abort / 超时一律当 status=0（→ 未知），
 * 绝不把「没查到」当私有，也不把 token 写进任何返回值。
 */
export async function fetchRepoVisibility(
  target: RepoVisibilityTarget | null,
  token: string,
  transport: RepoVisibilityTransport,
): Promise<RepoVisibilityDecision> {
  const url: string = providerEndpoint(target)
  if (url === '') {
    return decideRepoVisibility({ host: target === null ? '' : target.host, status: 0, contentType: '', body: '' })
  }
  try {
    const response = await transport(url, visibilityHeaders(target!, token), REPO_VISIBILITY_TIMEOUT_MS)
    return decideRepoVisibility({
      host: target!.host,
      status: response.status,
      contentType: response.contentType,
      body: response.body,
    })
  } catch {
    return decideRepoVisibility({ host: target!.host, status: 0, contentType: '', body: '' })
  }
}

/** 把拒绝判定转成 typed SyncError；message 是固定中文文案，details 恒为空（无 token / URL）。 */
export function repoPrecheckError(decision: RepoVisibilityDecision): SyncError {
  return new SyncError(decision.code, decision.message)
}

/** 只注入 `fetch` 的最小响应形状（真实 Response 或有同名字段的假对象都可用）。 */
export interface RepoPrecheckFetchResponseLike {
  status: number
  contentType?: string
  body?: string
  headers?: { get(name: string): string | null } | null
  text?: () => Promise<string>
}

export type RepoPrecheckFetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; signal: unknown },
) => Promise<RepoPrecheckFetchResponseLike>

/** 全局 fetch 适配成 transport：超时用 AbortSignal，token 只在 header。 */
export function createFetchTransport(fetchImpl: RepoPrecheckFetchLike): RepoVisibilityTransport {
  return async (url, headers, timeoutMs) => {
    const response = await fetchImpl(url, { method: 'GET', headers, signal: AbortSignal.timeout(timeoutMs) })
    const contentType =
      typeof response.contentType === 'string'
        ? response.contentType
        : (response.headers?.get('content-type') ?? '')
    const body = typeof response.body === 'string' ? response.body : ((await response.text?.()) ?? '')
    return { status: response.status, contentType, body }
  }
}
