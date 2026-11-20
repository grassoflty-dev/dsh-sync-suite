/**
 * 设置页表单的纯逻辑：平台/认证方式枚举、示例文案、设备标识与作者名校验、
 * 以及**保存前的整表校验**（`checkSettingsFields`）。
 *
 * 不 import 任何 SDK，可在 Node 直接跑（`tools/test/settingsFormValidation.test.mjs` 覆盖）。
 * 这里只决定「界面上写什么字」和「保存前拦什么」，不改变同步逻辑。
 */
import type { RepoUrlCheck } from './repoUrl';
import { isValidBaseURL } from './aiProvider';

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

// ---------------------------------------------------------------- 整表校验（保存前）

/**
 * 输入框里的 token 留空时沿用已保存的 token。
 *
 * 语义：用户「不改 token」就不该被拦，也不该在保存时把已有 token 清空。
 */
export function effectiveToken(rawToken: string, savedToken: string): string {
  const typed: string = typeof rawToken === 'string' ? rawToken.trim() : '';
  if (typed.length > 0) {
    return typed;
  }
  return typeof savedToken === 'string' ? savedToken.trim() : '';
}

/**
 * 按仓库地址自动纠正托管平台：含 `gitee.com` → gitee，含 `github.com` → github，其余保持原值。
 *
 * 平台只影响示例/提示文案，纠正它能让用户少一次手动切换（也避免「URL 是 gitee、平台还是 github」）。
 */
export function platformForRepoUrl(platform: string, rawUrl: string): string {
  const url: string = typeof rawUrl === 'string' ? rawUrl.toLowerCase() : '';
  if (url.indexOf('gitee.com') >= 0) {
    return PLATFORM_GITEE;
  }
  if (url.indexOf('github.com') >= 0) {
    return PLATFORM_GITHUB;
  }
  return normalizePlatform(platform);
}

/** 字段标识（用于把红字挂到对应输入框并滚动定位）。 */
export const FIELD_DEVICE_ID: string = 'deviceId';
export const FIELD_AUTHOR: string = 'author';
export const FIELD_REPO_URL: string = 'repoUrl';
export const FIELD_TOKEN: string = 'token';
export const FIELD_AI_MODEL: string = 'aiModel';
export const FIELD_AI_BASE_URL: string = 'aiBaseURL';
/** HTTPS 认证用户名（Gitee 必填；GitHub 可留空）。 */
export const FIELD_GIT_USERNAME: string = 'gitUsername';

/** 字段标识 → 中文名（顶部汇总横幅用）。 */
export function settingsFieldLabel(field: string): string {
  if (field === FIELD_DEVICE_ID) {
    return '设备标识';
  }
  if (field === FIELD_AUTHOR) {
    return '作者名';
  }
  if (field === FIELD_REPO_URL) {
    return '仓库地址';
  }
  if (field === FIELD_TOKEN) {
    return 'token';
  }
  if (field === FIELD_AI_MODEL) {
    return 'AI 模型名';
  }
  if (field === FIELD_AI_BASE_URL) {
    return 'AI 接口地址';
  }
  if (field === FIELD_GIT_USERNAME) {
    return '用户名';
  }
  return field;
}

/** 一条校验问题：`field` 决定红字挂哪个输入框，`message` 是给用户看的中文。 */
export interface SettingsFieldIssue {
  field: string;
  message: string;
}

/** 一次保存校验的输入（全部显式字段，便于纯单测）。 */
export interface SettingsFormInput {
  deviceId: string;
  author: string;
  repoUrl: string;
  token: string;
  authMode: string;
  savedToken: string;
  /** 当前 AI 源是否是「自定义」（自定义源必须手动给模型名与接口地址）。 */
  customProvider: boolean;
  aiModel: string;
  aiBaseURL: string;
}

/**
 * 保存前的整表校验：返回**全部**问题（不再只报第一条），供页面逐字段标红 + 汇总。
 *
 * 规则（与用户实测 bug 直接相关）：
 * - 仓库地址允许为空（首次使用不该被卡住）；为空时**不校验 token**；
 * - token 输入框留空但已有保存值 → 合法（沿用旧 token）；
 * - 只校验**可见**字段：`customProvider` 之外的 AI 字段不参与（预设源的地址/模型由预设表决定）。
 */
export function checkSettingsFields(input: SettingsFormInput, repoCheck: RepoUrlCheck): SettingsFieldIssue[] {
  const issues: SettingsFieldIssue[] = [];
  const repoEmpty: boolean = typeof input.repoUrl === 'string' ? input.repoUrl.trim().length === 0 : true;

  if (!repoEmpty && !repoCheck.ok) {
    issues.push({ field: FIELD_REPO_URL, message: repoCheck.error });
  }

  // token：留空沿用已保存值；仓库地址为空时不要求 token
  if (!repoEmpty) {
    const tokenProblem: string = validateToken(input.authMode, effectiveToken(input.token, input.savedToken));
    if (tokenProblem.length > 0) {
      issues.push({ field: FIELD_TOKEN, message: tokenProblem });
    }
  }

  const deviceProblem: string = validateDeviceIdText(input.deviceId);
  if (deviceProblem.length > 0) {
    issues.push({ field: FIELD_DEVICE_ID, message: deviceProblem });
  }

  const authorProblem: string = validateAuthorName(input.author);
  if (authorProblem.length > 0) {
    issues.push({ field: FIELD_AUTHOR, message: authorProblem });
  }

  // AI：模型只能从预设「模型」下拉选择（含自定义源的 custom-model），没有手输路径，
  // 因此不再校验 aiModel；只有自定义源仍需用户填接口地址（预设源由预设表提供）。
  if (input.customProvider) {
    const rawBase: string = typeof input.aiBaseURL === 'string' ? input.aiBaseURL.trim() : '';
    if (rawBase.length === 0) {
      issues.push({ field: FIELD_AI_BASE_URL, message: '自定义源必须填写接口地址（如 https://api.example.com/v1）' });
    } else if (!isValidBaseURL(rawBase)) {
      issues.push({ field: FIELD_AI_BASE_URL, message: '接口地址格式不正确：需要形如 https://api.example.com/v1' });
    }
  }

  return issues;
}

/** 问题列表 → 顶部汇总文案（空列表返回空串）。 */
export function describeIssues(issues: SettingsFieldIssue[]): string {
  if (issues === null || issues === undefined || issues.length === 0) {
    return '';
  }
  const names: string[] = [];
  for (const issue of issues) {
    const label: string = settingsFieldLabel(issue.field);
    if (names.indexOf(label) < 0) {
      names.push(label);
    }
  }
  return `还有 ${issues.length} 项需要处理：${names.join('、')}`;
}

/**
 * 第一条问题的「字段名 · 原因」。
 *
 * 用途：横幅第二行。字段的红字可能被滚出视野，把第一条原因也写进横幅，
 * 用户即使不滚动也能知道要改什么（避免「只看到还有 N 项、看不到红字」）。
 */
export function describeFirstIssue(issues: SettingsFieldIssue[]): string {
  if (issues === null || issues === undefined || issues.length === 0) {
    return '';
  }
  const issue: SettingsFieldIssue = issues[0];
  return `${settingsFieldLabel(issue.field)} · ${issue.message}`;
}
