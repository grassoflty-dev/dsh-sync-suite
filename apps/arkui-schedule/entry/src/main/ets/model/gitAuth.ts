/**
 * Git 认证与托管平台（纯逻辑，Node 可测）。
 *
 * 两部分：
 *
 * 1. **HTTPS 用户名解析**。背景（P0 线上问题）：Gitee 的 HTTPS 认证要求「用户名 = Gitee 登录名，
 *    密码 = PAT」。早先三处（ArkTS 的 Basic header、桥的 `onAuth`、设置页的 askpass）都把用户名
 *    **写死成 `x-access-token`**（那是 GitHub 对 PAT 的特殊用户名），对 Gitee 必然 401。
 *    规则（与插件侧一致）：
 *    - 用户填了用户名（trim 后非空）→ 一律用用户的；
 *    - 平台是 Gitee 且没填 → **返回空串，由 `assertHttpsUsername` 报错**，绝不兜底成
 *      `x-access-token`（兜底只会把 401 伪装成「token 无效」，浪费用户排查时间）；
 *    - 其它平台（GitHub / GitLab / 自建）→ `x-access-token`（GitHub 对 PAT 的约定用户名，
 *      GitLab 与 Gitea/Forgejo 的 Basic 认证也接受任意非空用户名 + PAT）。
 *
 * 2. **平台预设与按地址推断**（A1）。平台只影响提示文案、用户名兜底与示例地址，
 *    同步协议完全一致。推断规则：`gitee.com`（含子域）→ gitee、`github.com` → github、
 *    `gitlab.com` → gitlab、其它有域名的主机 → custom（自建 Gitea/Forgejo）；
 *    用户手动选过平台（`platformTouched`）时**以用户为准**，推断只作为提示。
 *
 * 3. **SSH 的可用性结论**（A1 第 3 条）。本应用内置的 isomorphic-git 1.25.3 只有 HTTP(S)
 *    传输层（源码里 `privateKey` / `passphrase` / `ssh://` 出现 0 次，传输表只认 http/https），
 *    `onAuth` 只能回 `{username, password}` / `{cancel}`，没有私钥通道；应用沙箱也读不到
 *    `~/.ssh/id_ed25519`、调不到系统 ssh-agent。因此 **SSH 不可用**，界面必须直说
 *    「当前版本仅支持 HTTPS」，绝不能让用户以为填了私钥路径就能同步。
 */

/** GitHub 用 PAT 时的约定用户名。 */
export const GITHUB_TOKEN_USERNAME: string = 'x-access-token';

/** 平台标识：GitHub（与 `settingsForm.ts` 的 `PLATFORM_GITHUB` 同值）。 */
export const PLATFORM_GITHUB: string = 'github';

/** 平台标识：GitLab（gitlab.com 或自建 GitLab）。 */
export const PLATFORM_GITLAB: string = 'gitlab';

/** 平台标识：自建（Gitea / Forgejo / 其它 Git smart-HTTP 兼容服务）。 */
export const PLATFORM_CUSTOM: string = 'custom';

/** Gitee 平台标识（与 `model/settingsForm.ts` 的 `PLATFORM_GITEE` 同值）。 */
export const GITEE_PLATFORM: string = 'gitee';

/** HTTPS 认证方式标识（与 `settingsForm.ts` 的 `AUTH_HTTPS` 同值）。 */
export const AUTH_MODE_HTTPS: string = 'https';

/** SSH 认证方式标识（与 `settingsForm.ts` 的 `AUTH_SSH` 同值；本版本不可用，见 `SSH_UNSUPPORTED_REASON`）。 */
export const AUTH_MODE_SSH: string = 'ssh';

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

// ---------------------------------------------------------------- 平台预设（A1）

/** 一个托管平台预设：只影响文案/示例/用户名兜底，不影响同步协议。 */
export interface GitPlatformPreset {
  /** 平台标识（持久化值）。 */
  id: string;
  /** 界面上显示的短名。 */
  label: string;
  /** 示例地址用的默认域名。 */
  defaultHost: string;
  /** 该平台「用户名」栏的说明。 */
  usernameHint: string;
  /** 该平台 token 的形态说明。 */
  tokenHint: string;
}

/** 四个平台预设（顺序即界面顺序）。 */
export const GIT_PLATFORM_PRESETS: GitPlatformPreset[] = [
  {
    id: PLATFORM_GITHUB,
    label: 'GitHub',
    defaultHost: 'github.com',
    usernameHint: 'GitHub 可留空：留空时按 x-access-token 认证。',
    tokenHint: 'GitHub：ghp_… / github_pat_…（需 repo 读写权限）。'
  },
  {
    id: GITEE_PLATFORM,
    label: 'Gitee',
    defaultHost: 'gitee.com',
    usernameHint: 'Gitee 的 HTTPS 认证用「登录名 + 私人令牌作密码」，用户名留空必然 401（登录名不是邮箱）。',
    tokenHint: 'Gitee：私人令牌（设置 → 私人令牌，需 projects 读写权限）。'
  },
  {
    id: PLATFORM_GITLAB,
    label: 'GitLab',
    defaultHost: 'gitlab.com',
    usernameHint: 'GitLab：可留空（用 x-access-token），也可填 GitLab 用户名。',
    tokenHint: 'GitLab：glpat-…（scope 至少 write_repository）。'
  },
  {
    id: PLATFORM_CUSTOM,
    label: '自建',
    defaultHost: 'git.example.com',
    usernameHint: '自建（Gitea/Forgejo）：按服务端要求填写，留空则用 x-access-token。',
    tokenHint: '自建：服务端生成的访问令牌（Gitea/Forgejo 的「令牌」页面）。'
  }
];

/** 平台标识 → 预设（未知值回落 GitHub，与 settingsStore 的归一一致）。 */
export function findPlatformPreset(platform: string): GitPlatformPreset {
  const id: string = normalizeGitPlatform(platform);
  for (let index = 0; index < GIT_PLATFORM_PRESETS.length; index++) {
    if (GIT_PLATFORM_PRESETS[index].id === id) {
      return GIT_PLATFORM_PRESETS[index];
    }
  }
  return GIT_PLATFORM_PRESETS[0];
}

/** 平台标识归一：只认 github / gitee / gitlab / custom，其它一律 github。 */
export function normalizeGitPlatform(value: string): string {
  const text: string = normalize(value).toLowerCase();
  if (text === GITEE_PLATFORM) {
    return GITEE_PLATFORM;
  }
  if (text === PLATFORM_GITLAB) {
    return PLATFORM_GITLAB;
  }
  if (text === PLATFORM_CUSTOM) {
    return PLATFORM_CUSTOM;
  }
  return PLATFORM_GITHUB;
}

/** 平台短名（界面 chip / 提示文案用）。 */
export function platformLabel(platform: string): string {
  return findPlatformPreset(platform).label;
}

/** 平台示例域名（自建给 `git.example.com` 占位）。 */
export function defaultHostOf(platform: string): string {
  return findPlatformPreset(platform).defaultHost;
}

/**
 * 从仓库地址里取主机名（小写、去端口、去 userinfo）。
 *
 * 支持三种写法：`https://host/owner/repo.git`、`ssh://git@host/owner/repo.git`、
 * scp 风格 `git@host:owner/repo.git`；无法识别时返回空串。
 */
export function hostFromRepoUrl(rawUrl: string): string {
  const text: string = normalize(rawUrl);
  if (text.length === 0) {
    return '';
  }
  const scp = /^[A-Za-z0-9._-]+@([^:/]+):/.exec(text);
  if (scp !== null) {
    return scp[1].toLowerCase();
  }
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/.exec(text);
  if (scheme !== null) {
    let authority: string = scheme[1];
    const at: number = authority.lastIndexOf('@');
    if (at >= 0) {
      authority = authority.slice(at + 1);
    }
    const colon: number = authority.indexOf(':');
    if (colon >= 0) {
      authority = authority.slice(0, colon);
    }
    return authority.toLowerCase();
  }
  const bare = /^([A-Za-z0-9.-]+\.[A-Za-z]{2,})(?:[/:]|$)/.exec(text);
  if (bare !== null) {
    return bare[1].toLowerCase();
  }
  return '';
}

/**
 * 按仓库地址推断平台。
 *
 * - `gitee.com`（含子域）→ gitee；
 * - `github.com`（含子域）→ github；
 * - `gitlab.com`（含子域）→ gitlab；
 * - 其它有域名的主机 → custom（自建 Gitea/Forgejo/私有 GitLab 都归到这里）；
 * - 地址为空/认不出主机 → 空串（表示「无法推断」，调用方保留原值）。
 */
export function inferPlatformFromUrl(rawUrl: string): string {
  const host: string = hostFromRepoUrl(rawUrl);
  if (host.length === 0) {
    return '';
  }
  if (host === 'gitee.com' || host.endsWith('.gitee.com')) {
    return GITEE_PLATFORM;
  }
  if (host === 'github.com' || host.endsWith('.github.com')) {
    return PLATFORM_GITHUB;
  }
  if (host === 'gitlab.com' || host.endsWith('.gitlab.com')) {
    return PLATFORM_GITLAB;
  }
  return PLATFORM_CUSTOM;
}

/** 一次「保存平台」的结论（纯值，便于单测与界面提示）。 */
export interface PlatformResolution {
  /** 最终要保存的平台。 */
  platform: string;
  /** 按地址推断出的平台（无法推断为空串）。 */
  inferred: string;
  /** 是否采用了推断值（`platform !== 原选择`）。 */
  applied: boolean;
  /** 给用户看的一行中文提示（无需提示时为空串）。 */
  notice: string;
}

/**
 * 决定保存哪个平台：用户手动改过则**以用户为准**，否则按地址推断。
 *
 * @param rawUrl 仓库地址
 * @param selected 界面当前选择的平台
 * @param platformTouched 用户是否手动点过平台 chip（点过即锁定用户选择）
 */
export function resolvePlatformSelection(
  rawUrl: string,
  selected: string,
  platformTouched: boolean
): PlatformResolution {
  const current: string = normalizeGitPlatform(selected);
  const inferred: string = inferPlatformFromUrl(rawUrl);
  if (inferred.length === 0) {
    return { platform: current, inferred: '', applied: false, notice: '' };
  }
  if (platformTouched) {
    const notice: string =
      inferred === current
        ? `平台已按你的选择固定为 ${platformLabel(current)}`
        : `地址看起来是 ${platformLabel(inferred)}，已保留你手动选择的 ${platformLabel(current)}`;
    return { platform: current, inferred: inferred, applied: false, notice: notice };
  }
  if (inferred === current) {
    return {
      platform: current,
      inferred: inferred,
      applied: false,
      notice: `已按地址识别平台为 ${platformLabel(inferred)}`
    };
  }
  return {
    platform: inferred,
    inferred: inferred,
    applied: true,
    notice: `已按地址推断平台为 ${platformLabel(inferred)}`
  };
}

// ---------------------------------------------------------------- 认证方式与文案

/** SSH 不可用给用户看的短句（状态行/按钮说明）。 */
export const SSH_UNSUPPORTED_SHORT: string = '当前版本仅支持 HTTPS';

/**
 * SSH 不可用的完整原因（设置页原文展示，报告里也引用同一份）。
 *
 * 结论来自代码事实，不是「暂未实现」的托词：
 * - 内置 isomorphic-git 1.25.3 只有 http/https 传输，`onAuth` 只回 `{username,password}`；
 * - 应用沙箱没有 `~/.ssh`（HarmonyOS/Android 沙箱都没有用户 home），读不到默认私钥；
 * - 系统 ssh-agent 也无法从 WebView/ArkTS 侧调用。
 */
export const SSH_UNSUPPORTED_REASON: string =
  '当前版本仅支持 HTTPS：内置同步内核 isomorphic-git 1.25.3 只有 HTTP(S) 传输层，' +
  'onAuth 只接受用户名 + 令牌，没有 SSH 私钥通道；应用沙箱也读不到 ~/.ssh/id_ed25519、' +
  '调不到系统 ssh-agent。所以 SSH 私钥路径/口令不会被使用，也不会发起任何连接——' +
  '请把认证方式切回 HTTPS(PAT)，用用户名 + 令牌同步。';

/** 认证方式是否为 SSH（大小写/空白容错）。 */
export function isSshAuthMode(authMode: string): boolean {
  return normalize(authMode).toLowerCase() === AUTH_MODE_SSH;
}

/**
 * 当前认证方式的阻塞原因（空串 = 可以用）；界面据此禁用同步按钮并给出原因。
 *
 * 目前只有 SSH 会被拦（本版本没有 SSH 传输层）。HTTPS 的完整性校验在
 * `assertHttpsUsername`（Gitee 用户名必填）与同步层的 token 校验里。
 */
export function describeAuthModeBlocker(authMode: string): string {
  return isSshAuthMode(authMode) ? SSH_UNSUPPORTED_REASON : '';
}

/** 仓库地址输入框占位（随平台 + 认证方式变化）。 */
export function repoUrlPlaceholderFor(platform: string, authMode: string): string {
  const host: string = defaultHostOf(platform);
  if (isSshAuthMode(authMode)) {
    return `git@${host}:<用户名>/<仓库名>.git`;
  }
  return `https://${host}/<用户名>/<仓库名>.git`;
}

/** 仓库地址说明（`?` 弹层）。 */
export function repoUrlExamplesFor(platform: string, authMode: string): string {
  const host: string = defaultHostOf(platform);
  if (isSshAuthMode(authMode)) {
    return `示例：git@${host}:user/repo.git（也接受 ssh://git@${host}/user/repo.git）。` +
      '注意：本版本同步内核只用 HTTPS，SSH 地址不会被使用。';
  }
  return `示例：https://${host}/user/repo.git（末尾 .git 可有可无）。token 只用于本机 HTTPS 认证。`;
}

/** token 输入框占位（按平台的令牌形态）。 */
export function tokenPlaceholderFor(platform: string): string {
  return findPlatformPreset(platform).tokenHint;
}

/** 用户名输入框占位（按平台）。 */
export function gitUsernamePlaceholderFor(platform: string): string {
  if (normalizeGitPlatform(platform) === GITEE_PLATFORM) {
    return '必填：Gitee 登录名';
  }
  if (normalizeGitPlatform(platform) === PLATFORM_GITHUB) {
    return '可留空（默认 x-access-token）';
  }
  return '可选（留空用 x-access-token）';
}

/** 用户名下方的一行说明（按平台）。 */
export function gitUsernameHintFor(platform: string): string {
  return findPlatformPreset(platform).usernameHint;
}

/** 认证方式说明（按平台 + 认证方式）。 */
export function authHintFor(platform: string, authMode: string): string {
  if (isSshAuthMode(authMode)) {
    return SSH_UNSUPPORTED_SHORT + '：SSH 依赖系统 ssh-agent，而应用内同步内核只实现 HTTPS。';
  }
  return 'HTTPS 方式必须填写 token（' + findPlatformPreset(platform).tokenHint + '）';
}
