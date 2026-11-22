/**
 * 仓库可见性门禁的**纯决策模型**（mod-repo-privacy-gate）。
 *
 * 零 SDK import / 零 IO：入参是「已经取到的响应事实」，输出 typed 码 + 逐字中文文案。
 * App 与插件共用同一份码与文案（test-vectors/repo-visibility 是唯一事实来源）。
 *
 * 固定优先级：host → auth → status → parse → private。
 * - 只有显式 `private: true` 才 ok；缺 `private` 永远不 ok；
 * - 未知 host（自建 / GitLab / 任何白名单外域名）**绝不**回退成「假定私有」；
 * - 网络错误 / 超时 / 5xx → E_REPO_VISIBILITY_UNKNOWN（未确认私有前不提交任何数据）。
 *
 * 需求原文里的 `**私有**` 是 Markdown 强调，用户可见文案取渲染后的「私有」二字。
 */

/** 成功码（typed，与插件一致；ok=true 时 message 恒为空串）。 */
export const REPO_VISIBILITY_OK: string = 'OK';

export const E_REPO_PUBLIC: string = 'E_REPO_PUBLIC';
export const E_REPO_AUTH: string = 'E_REPO_AUTH';
export const E_REPO_NOT_FOUND: string = 'E_REPO_NOT_FOUND';
export const E_REPO_HOST_UNSUPPORTED: string = 'E_REPO_HOST_UNSUPPORTED';
export const E_REPO_VISIBILITY_UNKNOWN: string = 'E_REPO_VISIBILITY_UNKNOWN';
export const E_REPO_BAD_RESPONSE: string = 'E_REPO_BAD_RESPONSE';

/** 唯一规则行：同步仓库字段下方的常驻说明。 */
export const REPO_PRIVATE_RULE_TEXT: string = '仓库必须是私有仓库（日程、聊天与远程控制配置会提交到这里）';

/** 推送被拒后的两条**独立**状态文案（时间由调用方拼在括号里）。 */
export const REPO_PUBLIC_STATUS_TEXT: string = '仓库已变为公开，已停止上传';
export const REPO_UNKNOWN_STATUS_TEXT: string = '无法确认仓库可见性，已停止上传';

/** typed 码 → 逐字中文文案（成功是空串：没有拒绝就没有理由）。 */
export const REPO_VISIBILITY_MESSAGES: Record<string, string> = {
  E_REPO_PUBLIC: '仓库是公开的：日程与远程控制配置不允许提交到公开仓库。请把仓库改成私有后重试',
  E_REPO_AUTH: '令牌无权读取该仓库：请确认令牌有效且具备仓库读权限',
  E_REPO_NOT_FOUND: '仓库不存在：请检查地址（owner/repo）后重试',
  E_REPO_HOST_UNSUPPORTED: '不支持自动校验该仓库的可见性。请改用 Gitee 或 GitHub 的私有仓库；本应用不会把无法校验的仓库当作私有',
  E_REPO_VISIBILITY_UNKNOWN: '暂时无法确认仓库可见性：请检查网络后重试（未确认私有前不会提交任何数据）',
  E_REPO_BAD_RESPONSE: '仓库接口返回了非预期内容（可能被代理或登录页拦截）：请检查网络后重试'
};

/** 已取到的响应事实（不传 token / URL，杜绝凭据进入判定层）。 */
export interface RepoVisibilityRequest {
  /** 仓库域名（不含端口）；白名单只有 gitee.com / github.com。 */
  host: string;
  /** HTTP 状态码；0 = 没有拿到响应（网络错误 / 超时 / abort）。 */
  status: number;
  /** 响应 Content-Type（可含 charset）。 */
  contentType: string;
  /** 响应体原文。 */
  body: string;
}

/** 判定结果：`ok=false` 时 `code` 必是上面六个 typed 码之一，`message` 必是逐字中文。 */
export interface RepoVisibilityDecision {
  ok: boolean;
  code: string;
  message: string;
}

/** 内部构造：拒绝。 */
function refuse(code: string): RepoVisibilityDecision {
  const message: string = REPO_VISIBILITY_MESSAGES[code];
  const decision: RepoVisibilityDecision = {
    ok: false, code: code, message: typeof message === 'string' ? message : REPO_VISIBILITY_MESSAGES[E_REPO_BAD_RESPONSE]
  };
  return decision;
}

/** 内部构造：通过（只有显式 `private: true` 能走到这里）。 */
function accept(): RepoVisibilityDecision {
  const decision: RepoVisibilityDecision = { ok: true, code: REPO_VISIBILITY_OK, message: '' };
  return decision;
}

/** host 归一：trim + 小写 + 去可选端口；拿不到就是空串（→ 不支持）。 */
function normalizeHost(raw: string): string {
  const text: string = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (text.length === 0) {
    return '';
  }
  const colon: number = text.indexOf(':');
  return colon > 0 ? text.slice(0, colon) : text;
}

/** 受支持的托管域名（白名单；自建 / GitLab / 其它域名一律不支持）。 */
const SUPPORTED_HOSTS: string[] = ['gitee.com', 'github.com'];

/** JSON 里足以证明「这确实是一个仓库对象」的身份键（缺全部 = 200 但没有仓库身份）。 */
const REPO_IDENTITY_KEYS: string[] = [
  'id', 'full_name', 'name', 'path', 'html_url', 'clone_url', 'ssh_url'
];

/** 从 typed 码重建拒绝结果（60s 去重窗口内复用上次判定，不再发请求）。 */
export function decisionForRepoCode(code: string): RepoVisibilityDecision {
  if (code === REPO_VISIBILITY_OK) {
    return accept();
  }
  return refuse(code);
}

/**
 * 纯判定：固定优先级 host → auth → status → parse → private。
 *
 * 注意：status 401/403 在 host 之后判（未知 host 即使返回 401 也先报「不支持」）；
 * 200 JSON 里没有身份键报 NOT_FOUND，有身份键却没有 boolean `private` 报 BAD_RESPONSE。
 */
export function decideRepoVisibility(request: RepoVisibilityRequest): RepoVisibilityDecision {
  const facts: RepoVisibilityRequest = request === null || request === undefined
    ? { host: '', status: 0, contentType: '', body: '' }
    : request;
  const host: string = normalizeHost(facts.host);
  const status: number = facts.status;
  const contentType: string = typeof facts.contentType === 'string' ? facts.contentType.toLowerCase() : '';
  const body: string = typeof facts.body === 'string' ? facts.body : '';

  // 1) host：白名单优先，未知 host 绝不假定私有（即使后面 200 + private:false）。
  if (SUPPORTED_HOSTS.indexOf(host) < 0) {
    return refuse(E_REPO_HOST_UNSUPPORTED);
  }

  // 2) auth：令牌无权读取。
  if (status === 401 || status === 403) {
    return refuse(E_REPO_AUTH);
  }

  // 3) status：不存在 / 网络与服务端异常 / 其它非 200。
  if (status === 404) {
    return refuse(E_REPO_NOT_FOUND);
  }
  if (status === 0 || status >= 500) {
    return refuse(E_REPO_VISIBILITY_UNKNOWN);
  }
  if (status !== 200) {
    return refuse(E_REPO_BAD_RESPONSE);
  }

  // 4) parse：HTML / 空体 / 不可解析 / 非对象 / 没有仓库身份。
  if (contentType.indexOf('html') >= 0) {
    return refuse(E_REPO_BAD_RESPONSE);
  }
  const text: string = body.trim();
  if (text.length === 0 || text.charAt(0) === '<') {
    return refuse(E_REPO_BAD_RESPONSE);
  }
  let parsed: Object | null = null;
  try {
    parsed = JSON.parse(text) as Object;
  } catch (error) {
    void error;
    return refuse(E_REPO_BAD_RESPONSE);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return refuse(E_REPO_BAD_RESPONSE);
  }
  const obj: Record<string, Object> = parsed as Record<string, Object>;
  const keys: string[] = Object.keys(obj);
  let hasIdentity: boolean = false;
  for (const key of REPO_IDENTITY_KEYS) {
    if (keys.indexOf(key) >= 0) {
      hasIdentity = true;
      break;
    }
  }
  if (!hasIdentity) {
    return refuse(E_REPO_NOT_FOUND);
  }

  // 5) private：只认显式 boolean true；false = 公开；缺字段 / 非 boolean = 非预期响应。
  if (keys.indexOf('private') < 0) {
    return refuse(E_REPO_BAD_RESPONSE);
  }
  const visibility: Object = obj['private'];
  if (typeof visibility !== 'boolean') {
    return refuse(E_REPO_BAD_RESPONSE);
  }
  if (visibility !== true) {
    return refuse(E_REPO_PUBLIC);
  }
  return accept();
}

/** 推送阻塞态渲染（唯一状态行）；`at` 是最近一次尝试的本地 HH:MM。 */
export function repoBlockStatusText(code: string, at: string): string {
  const clock: string = typeof at === 'string' ? at : '';
  const base: string = code === E_REPO_PUBLIC ? REPO_PUBLIC_STATUS_TEXT
    : (code === E_REPO_VISIBILITY_UNKNOWN ? REPO_UNKNOWN_STATUS_TEXT : '');
  if (base.length === 0) {
    return '';
  }
  return clock.length > 0 ? `${base}（最近尝试 ${clock}）` : base;
}
