/**
 * Git HTTPS 认证的用户名解析（纯逻辑，Node 可测）。
 *
 * 背景（P0 线上问题）：Gitee 的 HTTPS 认证要求「用户名 = Gitee 登录名，密码 = PAT」。
 * 早先三处（ArkTS 的 Basic header、桥的 `onAuth`、设置页的 askpass）都把用户名**写死成
 * `x-access-token`**（那是 GitHub 对 PAT 的特殊用户名），对 Gitee 必然 401。
 *
 * 规则（与插件侧一致）：
 * - 用户填了用户名（trim 后非空）→ 一律用用户的；
 * - 平台是 Gitee 且没填 → **返回空串，由 `assertHttpsUsername` 报错**，绝不兜底成
 *   `x-access-token`（兜底只会把 401 伪装成「token 无效」，浪费用户排查时间）；
 * - 其它平台（GitHub 等）→ `x-access-token`（GitHub 对 PAT 的约定用户名）。
 */

/** GitHub 用 PAT 时的约定用户名。 */
export const GITHUB_TOKEN_USERNAME: string = 'x-access-token';

/** Gitee 平台标识（与 `model/settingsForm.ts` 的 `PLATFORM_GITEE` 同值）。 */
export const GITEE_PLATFORM: string = 'gitee';

/** HTTPS 认证方式标识（与 `settingsForm.ts` 的 `AUTH_HTTPS` 同值）。 */
export const AUTH_MODE_HTTPS: string = 'https';

/** Gitee 缺用户名时的中文错误（设置页与同步入口共用）。 */
export const GITEE_USERNAME_REQUIRED: string =
  'Gitee 需要填写用户名（登录名）：token 只作密码';

function normalize(value: string): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 解析 HTTPS 认证用的用户名。
 *
 * @param platform 平台标识（`github` | `gitee` | 其它）
 * @param gitUsername 用户填写的登录名（可为空）
 * @returns 用于 Basic 认证/askpass 的用户名；Gitee 且未填写时返回**空串**（调用方须报错）
 */
export function resolveGitUsername(platform: string, gitUsername: string): string {
  const filled: string = normalize(gitUsername);
  if (filled.length > 0) {
    return filled;
  }
  if (normalize(platform).toLowerCase() === GITEE_PLATFORM) {
    // 不兜底：让上层用 assertHttpsUsername 给出可读错误
    return '';
  }
  return GITHUB_TOKEN_USERNAME;
}

/**
 * 校验「能否用当前配置走 HTTPS 认证」。
 *
 * @returns 中文错误（可展示）；配置可用时返回 `null`
 */
export function assertHttpsUsername(platform: string, authMode: string, gitUsername: string): string | null {
  const mode: string = normalize(authMode).toLowerCase();
  const isHttps: boolean = mode.length === 0 || mode === AUTH_MODE_HTTPS;
  if (!isHttps) {
    return null; // SSH 不支持，另有校验负责，这里不重复报错
  }
  if (normalize(platform).toLowerCase() !== GITEE_PLATFORM) {
    return null;
  }
  return normalize(gitUsername).length === 0 ? GITEE_USERNAME_REQUIRED : null;
}

/**
 * 给日志/界面用的脱敏展示：用户名可以直接显示（不是秘密），token 一律不出现。
 * 纯函数，单测里用来断言「token 不出现在任何日志字符串」。
 */
export function describeAuthForLog(platform: string, gitUsername: string, hasToken: boolean): string {
  const user: string = resolveGitUsername(platform, gitUsername);
  const who: string = user.length === 0 ? '(未填写用户名)' : user;
  return `platform=${normalize(platform).toLowerCase()} username=${who} token=${hasToken ? '***' : '(空)'}`;
}
