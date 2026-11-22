/**
 * HTTPS 用户名解析（纯函数，零依赖，Node 可直接单测）—— mod-plugin-git-username。
 *
 * 背景：Gitee 的 HTTPS 认证要求「用户名 = Gitee 登录名，密码 = 私人令牌」；
 * 把 GitHub 的 `x-access-token` 套到 Gitee 必然 401。精简面板只留地址 + 令牌，
 * 登录名由仓库地址静默推断；推不出来（组织仓库 / 自建）才在鉴权失败后要求手填。
 *
 * 本文件是**唯一**的推断/解析实现：引擎 `git.ts` 消费这里的结果，浏览器半侧的
 * 只读展示由 `client.js::leanInferLogin` 用同一规则镜像，并由 G01 逐字对拍守卫钉住。
 *
 * 规则：
 *   1. 显式值（界面手填 / `DSH_DOTS_GIT_USERNAME`）优先，trim 后非空就用它；
 *   2. Gitee 且没有显式值 → 从地址取 owner（`https://gitee.com/<owner>/<repo>.git`）；
 *   3. 仍为空 → 返回空串，由调用方报可读错误（绝不静默兜底成 x-access-token）；
 *   4. GitHub / 自定义留空 → `x-access-token`（GitHub PAT 约定，历史行为不变）。
 *
 * 纪律：用户名只用于本机 HTTPS 鉴权，绝不进配对载荷 / 同步仓库 / 日志。
 */
/** GitHub PAT 的约定用户名（本插件的历史默认，Gitee 不可套用）。 */
export const GITHUB_TOKEN_USERNAME = 'x-access-token';
/** Gitee 缺用户名且地址也推不出来时的中文错误（askpass 门禁用）。 */
export const GITEE_USERNAME_REQUIRED = 'Gitee 需要填写用户名（Gitee 登录名），私人令牌只作密码';
/** 账号名 / 组织名允许的形态（与 App 侧 `gitAuth.ts::OWNER_RE` 一致）。 */
const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
function text(value) {
    return typeof value === 'string' ? value.trim() : '';
}
/** 拆出 host 与 path；支持 https/ssh scheme、scp 风格与省略协议写法。 */
function splitRepoUrl(rawUrl) {
    const url = text(rawUrl);
    if (url === '')
        return { host: '', path: '' };
    const scp = /^[A-Za-z0-9._-]+@([^:/\\]+):(.*)$/.exec(url);
    if (scp !== null)
        return { host: (scp[1] ?? '').toLowerCase(), path: scp[2] ?? '' };
    const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)(\/[^?#]*)?/.exec(url);
    if (scheme !== null) {
        let authority = scheme[1] ?? '';
        const at = authority.lastIndexOf('@');
        if (at >= 0)
            authority = authority.slice(at + 1);
        const colon = authority.indexOf(':');
        if (colon >= 0 && authority.indexOf(']') < 0)
            authority = authority.slice(0, colon);
        return { host: authority.toLowerCase(), path: scheme[2] ?? '' };
    }
    const bare = /^([A-Za-z0-9.-]+\.[A-Za-z]{2,})(\/[^?#]*)?$/.exec(url);
    if (bare !== null)
        return { host: (bare[1] ?? '').toLowerCase(), path: bare[2] ?? '' };
    return { host: '', path: '' };
}
function isGiteeHost(host) {
    return host === 'gitee.com' || host.endsWith('.gitee.com');
}
/**
 * 从仓库地址推断 Gitee 登录名（owner）。
 *
 * `https://gitee.com/<owner>/<repo>[.git]` → `<owner>`；也接受 `ssh://git@gitee.com/...`、
 * `git@gitee.com:<owner>/<repo>.git` 与省略 `https://` 的写法；容忍尾斜杠 / query / hash。
 * 非 Gitee 主机、段数不足、owner 含非法字符 → 空串（表示「推不出来」）。
 */
export function inferGitUsername(repoUrl) {
    const { host, path } = splitRepoUrl(repoUrl);
    if (!isGiteeHost(host))
        return '';
    const segments = path.split('/').map((segment) => segment.trim()).filter((segment) => segment !== '');
    // 与 App `ownerFromRepoUrl` 一致：至少 owner + repo 两段，只有一段不算仓库地址。
    if (segments.length < 2)
        return '';
    const owner = segments[0] ?? '';
    return OWNER_RE.test(owner) ? owner : '';
}
/**
 * 解析 HTTPS 用户名：手填 / 环境变量优先；Gitee 空值按地址推断；
 * GitHub / 自定义空值保持历史默认 `x-access-token`。
 *
 * 返回空串只可能是「Gitee 且既没显式值也推不出 owner」——调用方须报 `GITEE_USERNAME_REQUIRED`，
 * 不能把空串交给 askpass（那会把 401 伪装成「token 无效」）。
 */
export function resolveGitUsername(platform, override, repoUrl) {
    const explicit = text(override);
    if (explicit !== '')
        return explicit;
    if (text(platform).toLowerCase() === 'gitee')
        return inferGitUsername(repoUrl);
    return GITHUB_TOKEN_USERNAME;
}
/**
 * 错误 / 日志文本的凭据打码：把值整段换成 `***`（空值或过短值不动，避免误伤文案）。
 *
 * token 沿用旧的 ≥4 字符门槛；用户名也按非空即打码，保证任何失败消息里都看不到登录名。
 */
export function scrubAuthValue(value, secret) {
    const out = typeof value === 'string' ? value : String(value);
    const needle = text(secret);
    return needle === '' ? out : out.split(needle).join('***');
}
