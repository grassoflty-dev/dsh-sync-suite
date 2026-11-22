/**
 * 仓库可见性 Provider 适配器（mod-repo-privacy-gate，app 侧薄层）。
 *
 * - Gitee：GET https://gitee.com/api/v5/repos/{owner}/{repo}，Authorization: token <token>
 * - GitHub：GET https://api.github.com/repos/{owner}/{repo}，Authorization: Bearer <token>
 *
 * 硬超时上限 5 s（由注入的 transport 落实；Node 测试里是假 transport），超时 / abort /
 * 任何异常都收敛成 status=0 的响应事实 → E_REPO_VISIBILITY_UNKNOWN。
 *
 * **token 只进 Authorization header**：不进 URL、不进日志、不进持久化设置回显。
 * 本文件零 SDK import，可直接被 tsc 编译进 `.build` 供 Node 测试驱动。
 */
import { validateRepoUrl } from './repoUrl';
import { decideRepoVisibility } from './repoVisibility';
import type { RepoVisibilityDecision } from './repoVisibility';

/** 硬超时上限（毫秒）：≤ 5 s。 */
export const REPO_VISIBILITY_TIMEOUT_MS: number = 5000;

/** 从仓库地址解析出的目标（只有域名 + owner/repo，绝不含 token）。 */
export interface RepoVisibilityTarget {
  host: string;
  owner: string;
  repo: string;
}

/** transport 返回的响应事实（与纯模型的四元组同形）。 */
export interface RepoVisibilityTransportResponse {
  status: number;
  contentType: string;
  body: string;
}

/** 注入的传输函数：真实 app 侧由 services/repoVisibilityChecker.ets 绑定 @kit.NetworkKit。 */
export type RepoVisibilityTransport = (
  url: string,
  headers: Record<string, string>,
  timeoutMs: number
) => Promise<RepoVisibilityTransportResponse>;

/** Gitee / GitHub 的仓库 API 端点；未知 host 返回空串（不发请求，纯模型判 E_REPO_HOST_UNSUPPORTED）。 */
export function providerEndpoint(target: RepoVisibilityTarget): string {
  if (target === null || target === undefined) {
    return '';
  }
  if (target.host === 'gitee.com') {
    return `https://gitee.com/api/v5/repos/${target.owner}/${target.repo}`;
  }
  if (target.host === 'github.com') {
    return `https://api.github.com/repos/${target.owner}/${target.repo}`;
  }
  return '';
}

/**
 * 请求头：token 唯一落点是 Authorization。
 * 同一行里绝不出现 repoUrl 与 token（凭据静态卫生守卫的硬约束）。
 */
export function visibilityHeaders(target: RepoVisibilityTarget, token: string): Record<string, string> {
  const scheme: string = target !== null && target !== undefined && target.host === 'gitee.com' ? 'token' : 'Bearer';
  const headers: Record<string, string> = {
    'User-Agent': 'dsh-arkui-schedule',
    'Accept': 'application/json',
    'Authorization': `${scheme} ${token}`
  };
  return headers;
}

/** 仓库地址 → 目标；非法地址 / 非 owner/repo 形态返回 null（调用方给中文下一步）。 */
export function repoTargetFromUrl(rawUrl: string): RepoVisibilityTarget | null {
  const check = validateRepoUrl(rawUrl);
  if (!check.ok) {
    return null;
  }
  const parts: string[] = check.repoPath.split('/');
  if (parts.length < 2 || parts[0].length === 0 || parts[1].length === 0) {
    return null;
  }
  const target: RepoVisibilityTarget = { host: check.host, owner: parts[0], repo: parts[1] };
  return target;
}

/**
 * 取一次响应并判定。transport 抛错 / abort / 超时一律当 status=0（→ 未知），
 * 绝不把「没查到」当私有、也不把 token 写进任何返回值。
 */
export async function fetchRepoVisibility(
  target: RepoVisibilityTarget,
  token: string,
  transport: RepoVisibilityTransport
): Promise<RepoVisibilityDecision> {
  const url: string = providerEndpoint(target);
  if (url.length === 0) {
    const facts = { host: target === null || target === undefined ? '' : target.host, status: 0, contentType: '', body: '' };
    return decideRepoVisibility(facts);
  }
  try {
    const headers: Record<string, string> = visibilityHeaders(target, token);
    const response: RepoVisibilityTransportResponse = await transport(url, headers, REPO_VISIBILITY_TIMEOUT_MS);
    const facts = {
      host: target.host,
      status: response.status,
      contentType: response.contentType,
      body: response.body
    };
    return decideRepoVisibility(facts);
  } catch (error) {
    void error;
    const facts = { host: target.host, status: 0, contentType: '', body: '' };
    return decideRepoVisibility(facts);
  }
}
