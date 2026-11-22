/**
 * 同步仓库「已配置」判据（mod-settings-configured-state）。
 *
 * 零 SDK 依赖、零 IO、零墙钟：设置页摘要与同步周期入口共用**同一个**判定，
 * 彻底删除「UI 用 repoHostOf 的空串、周期用 config.repoUrl 的空串」这两份散落的 predicate。
 *
 * 三条硬约束：
 * 1. **已配置 ≠ 允许推送**：仓库可见性阻断是另一条 lane（syncStatusStore / repoVisibilityChecker），
 *    这里只回答「配置齐不齐」，阻断的仓库照样是「已配置」（只是不能推）。
 * 2. **缺什么报什么**：不再用笼统的「未配置」糊弄；缺仓库地址 / 访问令牌逐项点名。
 * 3. **信封与扁平键同权**：`readRepoConfigFromPrefs()` 是唯一的合并读口（settingsStore.load 直接用它），
 *    扁平键优先、信封 values 兜底；本模块不关心值来自哪一层，只看值本身。
 */
import { decodeEnvelope } from './configSchema';

/** 判定所需的配置切片（不依赖 ScheduleSettings，便于服务层 / 页面 / 单测复用）。 */
export interface RepoConfigInput {
  repoUrl: string;
  token: string;
  /** 认证方式；ssh 不需要 HTTPS 令牌，但 SSH 在本版本仍被推送路径单独拦住。 */
  authMode?: string;
}

/** 判定结果：configured 是唯一问答；missing / reason 只服务于 UI 点名。 */
export interface RepoConfigState {
  configured: boolean;
  /** 缺失项的中文名（'仓库地址' / '访问令牌'），顺序固定。 */
  missing: string[];
  /** configured=false 时可直接展示的中文；configured=true 时为空串。 */
  reason: string;
}

/** 周期入口的 typed 判定：`start=false` 时不启动周期，绝不与隐私阻断混为一谈。 */
export interface RepoCycleGuardResult {
  start: boolean;
  code: string;
  message: string;
}

export const REPO_MISSING_URL: string = '仓库地址';
export const REPO_MISSING_TOKEN: string = '访问令牌';
export const E_REPO_UNCONFIGURED: string = 'E_UNCONFIGURED';

/** 已配置判据涉及的偏好键（服务层与测试共用，杜绝键名漂移）。 */
export const REPO_KEY_URL: string = 'repoUrl';
export const REPO_KEY_TOKEN: string = 'token';
export const REPO_KEY_AUTH_MODE: string = 'authMode';

/** 设置页 `repoHostOf` 的空主机占位；它不是「未配置」的证据，必须在摘要层拦住。 */
export const REPO_HOST_PLACEHOLDER: string = '未配置';

/** 可注入的偏好读取缝：`load()` 用真 preferences 实现，测试用内存假实现走同一条合并逻辑。 */
export interface RepoConfigPrefsSeam {
  /** 读扁平键；不存在 / 空值返回 ''。 */
  getFlat(key: string): Promise<string>;
  /** 读 `config.schema` 信封原始字节；不存在返回 ''。 */
  getEnvelope(): Promise<string>;
}

function text(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** SSH 不需要 HTTPS 令牌；缺省按 HTTPS 处理（令牌必填）。 */
function tokenRequired(input: RepoConfigInput): boolean {
  return text(input.authMode).toLowerCase() !== 'ssh';
}

/**
 * 已配置字段的**唯一合并读口**（M2）：扁平键优先、信封 values 兜底。
 *
 * 生产 `settingsStore.load()` 用真 preferences 实现这个 seam；测试注入「扁平键全缺、只有信封」
 * 的假 seam，走的是**同一个函数**，因此「迁移后冷启动仍已配置」是可执行证明，而非源码正则。
 * 只读：seam 没有写方法；坏字节 / 未知版本由 decodeEnvelope fail-closed 成空表，零写入。
 */
export async function readRepoConfigFromPrefs(seam: RepoConfigPrefsSeam): Promise<RepoConfigInput> {
  const flatUrl: string = await seam.getFlat(REPO_KEY_URL);
  const flatToken: string = await seam.getFlat(REPO_KEY_TOKEN);
  const flatAuth: string = await seam.getFlat(REPO_KEY_AUTH_MODE);
  let repoUrl: string = typeof flatUrl === 'string' ? flatUrl.trim() : '';
  let token: string = typeof flatToken === 'string' ? flatToken.trim() : '';
  let authMode: string = typeof flatAuth === 'string' ? flatAuth.trim() : '';

  const raw: string = await seam.getEnvelope();
  if (typeof raw === 'string' && raw.trim().length > 0) {
    const decoded = decodeEnvelope(raw);
    if (decoded.state === 'ok' || decoded.state === 'legacy') {
      const values = decoded.values;
      if (repoUrl.length === 0 && typeof values[REPO_KEY_URL] === 'string') {
        repoUrl = String(values[REPO_KEY_URL]).trim();
      }
      if (token.length === 0 && typeof values[REPO_KEY_TOKEN] === 'string') {
        token = String(values[REPO_KEY_TOKEN]).trim();
      }
      if (authMode.length === 0 && typeof values[REPO_KEY_AUTH_MODE] === 'string') {
        authMode = String(values[REPO_KEY_AUTH_MODE]).trim();
      }
    }
  }
  const result: RepoConfigInput = { repoUrl: repoUrl, token: token, authMode: authMode };
  return result;
}

/**
 * 唯一已配置判据：`repoUrl` 非空，且 HTTPS 下 `token` 非空。
 * 除这两项外没有隐藏的第三项必需字段；将来真新增必需字段时在这里追加并自动进 missing 文案。
 */
export function repoConfigStateOf(input: RepoConfigInput): RepoConfigState {
  const missing: string[] = [];
  if (text(input.repoUrl).length === 0) {
    missing.push(REPO_MISSING_URL);
  }
  if (tokenRequired(input) && text(input.token).length === 0) {
    missing.push(REPO_MISSING_TOKEN);
  }
  const configured: boolean = missing.length === 0;
  const reason: string = configured ? '' : `未配置：缺少${missing.join('、')}`;
  const state: RepoConfigState = { configured: configured, missing: missing, reason: reason };
  return state;
}

/** 布尔便捷封装：与 repoConfigStateOf 同源，杜绝第二个 predicate。 */
export function isRepoConfigured(input: RepoConfigInput): boolean {
  return repoConfigStateOf(input).configured;
}

/** 周期入口判定：只回答「能不能开始」，推送许可由隐私门禁另行回答。 */
export function repoCycleGuard(input: RepoConfigInput): RepoCycleGuardResult {
  const state: RepoConfigState = repoConfigStateOf(input);
  const result: RepoCycleGuardResult = state.configured
    ? { start: true, code: '', message: '' }
    : { start: false, code: E_REPO_UNCONFIGURED, message: state.reason };
  return result;
}

/**
 * 设置页「同步仓库」行摘要。
 *
 * - 未配置：直接点名缺项（`未配置：缺少访问令牌`），绝不因为设置了 host 仍显示主机；
 * - 已配置但被隐私阻断：`已配置 · 可见性阻断，禁止推送` —— 与「未配置」严格分开；
 * - 已配置且未被阻断：沿用既有的 `主机 · 同步状态`。
 */
export function repoRowSummary(
  host: string,
  timeSummary: string,
  state: RepoConfigState,
  blocked: boolean
): string {
  if (!state.configured) {
    return state.reason;
  }
  const hostText: string = text(host);
  // M1：`repoHostOf` 对无主机 URL 返回字面量「未配置」。配置判据说「已配置」时，
  // 绝不能把这个占位串透传成旧缺陷文案「未配置 · 未同步」；改为点名真正的格式问题。
  if (hostText.length === 0 || hostText === REPO_HOST_PLACEHOLDER) {
    return `未配置：仓库地址格式不正确`;
  }
  const head: string = hostText;
  if (blocked) {
    return `${head} · 已配置（可见性阻断，禁止推送）`;
  }
  return `${head} · ${text(timeSummary)}`;
}
