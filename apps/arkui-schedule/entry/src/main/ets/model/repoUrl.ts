/**
 * 仓库地址校验与连通性探测的纯逻辑（不 import 任何 SDK，可在 Node 直接跑）。
 *
 * 契约（设置页 P1-3 / P1-4）：
 * - 接受 `https://…`、`http://…`、`ssh://…`、`git@host:path`（scp 形式）四类地址；
 * - 只做 `trim` + 校验，**保存时保留用户原文**（末尾 `.git` 有无都接受，不擅自增删）；
 * - 空串、内部空白、缺 host、`https://` 后面没东西、带账号密码等明显非法输入给中文错误；
 * - `repoProbeUrl()` 只对 http(s) 给出 Git smart-HTTP 探测地址（`ssh` 无法在 App 内探测）。
 */

/** `git@host:path` 的 scp 形式（唯一允许不带 `://` 的形态）。 */
const SCP_RE: RegExp = /^git@([^:/\\\s]+):(.+)$/;

/** `scheme://[user@]host[:port]/path` 的通用形态。 */
const SCHEME_RE: RegExp = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(.*)$/;

/** 允许的协议（小写）。 */
const ALLOWED_SCHEMES: string[] = ['https', 'http', 'ssh'];

/** host 部分：域名/主机名 + 可选端口，不允许再带 `@`、`/`、空白。 */
const HOST_RE: RegExp = /^([A-Za-z0-9][A-Za-z0-9.-]*)(?::(\d{1,5}))?$/;

/** 内部空白（含全角空格与制表符）。 */
const INNER_SPACE_RE: RegExp = /[\s\u3000]/;

/** 校验结果（`ok=false` 时只有 `error` 有意义）。 */
export interface RepoUrlCheck {
  /** 是否通过校验。 */
  ok: boolean;
  /** 规范化后的地址：通过时为 `trim` 后的原文，失败为空串。 */
  url: string;
  /** 协议/形态：`https` | `http` | `ssh` | `scp`；失败为空串。 */
  scheme: string;
  /** 域名（小写，不含端口）；失败为空串。 */
  host: string;
  /** 仓库路径（去掉 `#` 之后的内容与首尾 `/`，**不含** `.git` 后缀）；失败为空串。 */
  repoPath: string;
  /** 校验失败的中文原因；通过为空串。 */
  error: string;
}

/** 内部构造：失败结果。 */
function failed(reason: string): RepoUrlCheck {
  const result: RepoUrlCheck = { ok: false, url: '', scheme: '', host: '', repoPath: '', error: reason };
  return result;
}

/** 内部构造：成功结果。 */
function passed(url: string, scheme: string, host: string, repoPath: string): RepoUrlCheck {
  const result: RepoUrlCheck = { ok: true, url: url, scheme: scheme, host: host, repoPath: repoPath, error: '' };
  return result;
}

/**
 * 把 `user/repo.git` 归一成 `user/repo`（只用于展示与探测，不影响保存的原文）。
 * 空路径返回空串。
 */
function normalizeRepoPath(rawPath: string): string {
  let text: string = rawPath;
  const hash = text.indexOf('#');
  if (hash >= 0) {
    text = text.slice(0, hash);
  }
  const query = text.indexOf('?');
  if (query >= 0) {
    text = text.slice(0, query);
  }
  while (text.startsWith('/')) {
    text = text.slice(1);
  }
  while (text.endsWith('/')) {
    text = text.slice(0, text.length - 1);
  }
  if (text.toLowerCase().endsWith('.git')) {
    text = text.slice(0, text.length - 4);
  }
  return text;
}

/** host 是否可接受：`localhost` 或至少含一个 `.` 的域名。 */
function hostLooksUsable(host: string): boolean {
  if (host === 'localhost') {
    return true;
  }
  return host.indexOf('.') > 0 && !host.startsWith('.') && !host.endsWith('.');
}

/**
 * 校验仓库地址。
 *
 * 幂等、无副作用：`validateRepoUrl(x).ok === true` 时 `validateRepoUrl(url).url === x.trim()`。
 */
export function validateRepoUrl(rawUrl: string): RepoUrlCheck {
  const text: string = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (text.length === 0) {
    return failed('仓库地址不能为空：请填写 https://github.com/<用户>/<仓库>.git 或 git@github.com:<用户>/<仓库>.git');
  }
  if (INNER_SPACE_RE.test(text)) {
    return failed('仓库地址不能包含空格：请删除中间的空格（首尾空白会自动去掉）');
  }
  // 带账号密码/token 的地址：既不安全也容易泄露，直接拒绝
  if (/:\/\/[^/]*@/.test(text) && !text.startsWith('ssh://git@')) {
    return failed('仓库地址里不要写用户名、密码或 token：认证信息请填在下面的 token 输入框');
  }

  let scheme: string = '';
  let authority: string = '';
  let rawPath: string = '';

  if (text.startsWith('git@') || SCP_RE.test(text)) {
    const scp = SCP_RE.exec(text);
    if (scp === null) {
      return failed('git@ 形式的仓库地址必须写成 git@<域名>:<用户>/<仓库>.git（域名后是冒号）');
    }
    scheme = 'scp';
    const host = scp[1].toLowerCase();
    if (!HOST_RE.test(host)) {
      return failed(`仓库地址里的域名不合法：${scp[1]}`);
    }
    if (!hostLooksUsable(host)) {
      return failed(`仓库地址缺少有效域名（需要形如 github.com）：${scp[1]}`);
    }
    const repoPath = normalizeRepoPath(scp[2]);
    if (repoPath.length === 0) {
      return failed('仓库地址缺少仓库路径：请写成 git@github.com:<用户>/<仓库>.git');
    }
    return passed(text, scheme, host, repoPath);
  }

  const matched = SCHEME_RE.exec(text);
  if (matched === null) {
    return failed('仓库地址必须以 https://、http://、ssh:// 或 git@ 开头（例如 https://github.com/user/repo.git）');
  }
  scheme = matched[1].toLowerCase();
  if (ALLOWED_SCHEMES.indexOf(scheme) < 0) {
    return failed(`不支持的协议 ${matched[1]}：只支持 https、http、ssh`);
  }
  const rest: string = matched[2];
  const slash = rest.indexOf('/');
  if (slash < 0) {
    authority = rest;
    rawPath = '';
  } else {
    authority = rest.slice(0, slash);
    rawPath = rest.slice(slash + 1);
  }
  if (authority.length === 0) {
    return failed(`${scheme}:// 后面缺少域名：请填写完整仓库地址（例如 https://github.com/user/repo.git）`);
  }
  // ssh://git@host/path 允许带用户名；https 的用户名由上面的账号密码检查拦下
  let hostPart: string = authority;
  const at = hostPart.lastIndexOf('@');
  if (at >= 0) {
    hostPart = hostPart.slice(at + 1);
  }
  const hostMatched = HOST_RE.exec(hostPart);
  if (hostMatched === null) {
    return failed(`仓库地址里的域名不合法：${hostPart}`);
  }
  const host = hostMatched[1].toLowerCase();
  if (!hostLooksUsable(host)) {
    return failed(`仓库地址缺少有效域名（需要形如 github.com）：${hostPart}`);
  }
  const repoPath = normalizeRepoPath(rawPath);
  if (repoPath.length === 0) {
    return failed(`仓库地址缺少路径：请在域名后补上 /<用户>/<仓库>（当前 ${scheme}://${hostPart} 后面没有内容）`);
  }
  return passed(text, scheme, host, repoPath);
}

/**
 * Git smart-HTTP 探测地址：`<仓库地址>/info/refs?service=git-upload-pack`。
 *
 * 只有 http(s) 地址能这样探测；`ssh://` / `git@host:path` 依赖系统 ssh-agent，返回空串
 * （调用方应提示用户改用 `git ls-remote` 在本机验证）。地址非法时也返回空串。
 */
export function repoProbeUrl(rawUrl: string): string {
  const check = validateRepoUrl(rawUrl);
  if (!check.ok || (check.scheme !== 'https' && check.scheme !== 'http')) {
    return '';
  }
  // 保留用户原文（含 .git）再拼探测路径，与 GitSyncService.probeRemote 的语义一致
  let base: string = check.url;
  while (base.endsWith('/')) {
    base = base.slice(0, base.length - 1);
  }
  return `${base}/info/refs?service=git-upload-pack`;
}

/** 探测结果的可读文案（`statusCode` 为 0 表示没拿到响应）。 */
export function describeRepoProbe(statusCode: number, errorText: string): string {
  const reason: string = typeof errorText === 'string' ? errorText.trim() : '';
  if (statusCode === 200) {
    return '✅ 可达：HTTP 200（域名与仓库路径都存在，网络可连）';
  }
  if (statusCode === 301 || statusCode === 302 || statusCode === 307 || statusCode === 308) {
    return `⚠️ 可达但被重定向：HTTP ${statusCode}（请把仓库地址改成最终地址，避免同步时反复跳转）`;
  }
  if (statusCode === 401 || statusCode === 403) {
    return `⚠️ 可达但认证失败：HTTP ${statusCode}（域名可连，请检查 token 是否有效、是否有该仓库的读写权限）`;
  }
  if (statusCode === 404) {
    return '❌ 不可达：HTTP 404（仓库不存在或无权访问；GitHub 的私有仓库在无凭据时也返回 404）';
  }
  if (statusCode === 0) {
    return `❌ 不可达：${reason.length > 0 ? reason : '没有拿到 HTTP 响应（请检查网络或域名）'}`;
  }
  if (statusCode >= 500) {
    return `❌ 不可达：HTTP ${statusCode}（远端服务异常，请稍后重试）`;
  }
  return `❌ 不可达：HTTP ${statusCode}${reason.length > 0 ? `（${reason}）` : ''}`;
}
