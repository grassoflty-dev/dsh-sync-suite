/**
 * 设置页表单的纯逻辑：平台/认证方式枚举、示例文案、设备标识与作者名校验。
 *
 * 不 import 任何 SDK，可在 Node 直接跑（`tools/test/repoUrl.test.mjs` 覆盖）。
 * 这里只决定「界面上写什么字」和「保存前拦什么」，不改变同步逻辑。
 */

/** 平台：GitHub（只影响提示文案与示例，同步逻辑完全一致）。 */
export const PLATFORM_GITHUB: string = 'github';
/** 平台：Gitee。 */
export const PLATFORM_GITEE: string = 'gitee';
/** 认证方式：HTTPS + Personal Access Token。 */
export const AUTH_HTTPS: string = 'https';
/** 认证方式：SSH（依赖系统 ssh-agent，App 不保存私钥）。 */
export const AUTH_SSH: string = 'ssh';

/** 设备标识最短长度（设置页要求，比存储层的 1 位更严格，避免 `a` 这种易撞目录名）。 */
export const MIN_DEVICE_ID_LENGTH: number = 3;

/** 平台默认值（读取到未知值时回退）。 */
export function normalizePlatform(value: string): string {
  const text: string = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return text === PLATFORM_GITEE ? PLATFORM_GITEE : PLATFORM_GITHUB;
}

/** 认证方式默认值（读取到未知值时回退 HTTPS）。 */
export function normalizeAuthMode(value: string): string {
  const text: string = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return text === AUTH_SSH ? AUTH_SSH : AUTH_HTTPS;
}

/** 仓库地址输入框的占位提示（随平台/认证方式变化）。 */
export function repoUrlPlaceholder(platform: string, authMode: string): string {
  const host: string = normalizePlatform(platform) === PLATFORM_GITEE ? 'gitee.com' : 'github.com';
  if (normalizeAuthMode(authMode) === AUTH_SSH) {
    return `git@${host}:<用户名>/<仓库名>.git`;
  }
  return `https://${host}/<用户名>/<仓库名>.git`;
}

/** 仓库地址示例（HTTPS 与 SSH 各给一条，随平台变化）。 */
export function repoUrlExamples(platform: string, authMode: string): string {
  const host: string = normalizePlatform(platform) === PLATFORM_GITEE ? 'gitee.com' : 'github.com';
  if (normalizeAuthMode(authMode) === AUTH_SSH) {
    return `示例：git@${host}:user/repo.git（也可写 ssh://git@${host}/user/repo.git）。` +
      '依赖系统 ssh-agent，App 不保存私钥。';
  }
  return `示例：https://${host}/user/repo.git（末尾 .git 可有可无）。` +
    'token 只用于本机 HTTPS 认证。';
}

/** 认证方式下方的说明文案。 */
export function authHint(authMode: string): string {
  if (normalizeAuthMode(authMode) === AUTH_SSH) {
    return 'SSH 方式依赖系统 ssh-agent，App 不保存私钥，token 可以留空；' +
      '注意应用内的同步内核目前只实现 HTTPS，真正同步前请切回 HTTPS(PAT)。';
  }
  return 'HTTPS 方式必须填写 token（GitHub / Gitee 的 Personal Access Token，需要 repo 读写权限）。';
}

/** 设备标识是否含空白（含全角空格）。 */
export function hasInnerSpace(value: string): boolean {
  return /[\s\u3000]/.test(value);
}

/**
 * 校验设备标识（设置页口径）：非空、长度 ≥3、不含空白与斜杠、匹配存储层格式。
 * 返回空串表示通过，否则返回中文原因。
 */
export function validateDeviceIdText(raw: string): string {
  const text: string = typeof raw === 'string' ? raw.trim() : '';
  if (text.length === 0) {
    return '设备标识不能为空（它决定 devices/<设备标识>/ 目录）';
  }
  if (text.length < MIN_DEVICE_ID_LENGTH) {
    return `设备标识至少 ${MIN_DEVICE_ID_LENGTH} 个字符（例如 phone-a）`;
  }
  if (text.length > 32) {
    return '设备标识最长 32 个字符';
  }
  if (hasInnerSpace(text)) {
    return '设备标识不能包含空格或制表符';
  }
  if (text.indexOf('/') >= 0 || text.indexOf('\\') >= 0) {
    return '设备标识不能包含斜杠（它会成为目录名）';
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(text)) {
    return '设备标识只能用小写字母、数字与「-」，且必须以字母或数字开头';
  }
  return '';
}

/** 校验作者名：去空白后非空即可（会写入日程的 author 字段）。 */
export function validateAuthorName(raw: string): string {
  const text: string = typeof raw === 'string' ? raw.trim() : '';
  if (text.length === 0) {
    return '作者名不能为空（会写入日程的 author 字段）';
  }
  if (text.length > 32) {
    return '作者名最长 32 个字符';
  }
  return '';
}

/**
 * 保存前的 token 校验：HTTPS 必填，SSH 可空。
 * 返回空串表示通过，否则返回中文原因。
 */
export function validateToken(authMode: string, rawToken: string): string {
  if (normalizeAuthMode(authMode) === AUTH_SSH) {
    return '';
  }
  const text: string = typeof rawToken === 'string' ? rawToken.trim() : '';
  if (text.length === 0) {
    return 'HTTPS 认证需要 token';
  }
  if (hasInnerSpace(text)) {
    return 'token 不能包含空格（复制时可能带入了换行或空格）';
  }
  return '';
}
