/**
 * Git 传输层：只用 `node:child_process.execFile('git', ...)`，不拼 shell。
 *
 * 安全约束：
 *   - 提交身份用 `-c user.name/user.email` 临时注入，不依赖也不修改全局配置；
 *   - HTTPS token 只走环境变量 `DSH_GIT_SYNC_TOKEN` + 临时 GIT_ASKPASS 脚本（0600），
 *     绝不进 argv / 配置文件 / 日志（错误消息会 scrub）；
 *   - `GIT_TERMINAL_PROMPT=0`，避免 git 卡在交互提示上；
 *   - 非 fast-forward 先 fetch + rebase 再 push，最多 2 次，**永不 force**；
 *   - `allowLocalRepo` 仅供集成测试放行本地路径 / file://。
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SyncError } from './errors.js'
import { GITEE_USERNAME_REQUIRED, resolveGitUsername, scrubAuthValue } from './gitUsername.js'
import { warmAskpassNode, type NodePathInputs } from './nodePath.js'
import type { HeadInfo, Platform } from './types.js'

export interface GitRepoOptions {
  dir: string
  repoUrl: string
  branch: string
  authMode: 'https' | 'ssh'
  token?: string | null
  /** 仓库平台：决定 HTTPS 用户名的默认值（Gitee 必须显式用户名）。 */
  platform?: Platform
  /** HTTPS 用户名；GitHub 可留空（默认 x-access-token），Gitee 必填登录名。 */
  username?: string
  allowLocalRepo?: boolean
  env?: NodeJS.ProcessEnv
  /** 仅测试注入的 node 解析输入；生产不传，由 nodePath.ts 走真实探测。 */
  nodePath?: NodePathInputs
  /**
   * 单次**读类**网络命令（ls-remote / fetch / clone）超时（毫秒），默认 8000（≤8s）。
   * 测试可注入更小值。push 不受它影响：push 恒用 `PUSH_TIMEOUT_MS`（见 `pushBudget()`）。
   */
  networkTimeoutMs?: number
  /** 仅测试注入的 execFile 实现；生产不传，永远走 node:child_process。 */
  execFileImpl?: typeof execFile
}

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

interface RunOptions {
  allowFailure?: boolean
  network?: boolean
  cwd?: string
  /** 超时（毫秒）：超时杀死子进程并映射成 E_GIT（消息说明超时，来源是 timeout 而不是网络）。 */
  timeoutMs?: number
  /** 本次调用是否用掉的是「本进程第一次网络调用」的放宽预算（只进 typed 详情与文案）。 */
  firstCall?: boolean
}

/**
 * **读类**网络命令（ls-remote / fetch / clone）的单次超时上限。
 *
 * 离线或仓库无响应时不能把设置页挂死：超时后 kill 子进程并报 E_GIT（含"超时"字样）。
 * push 不在这一档：它上传对象，耗时与本地工作量成正比，见 `PUSH_TIMEOUT_MS`。
 */
export const NETWORK_TIMEOUT_MS = 8000

/**
 * push 的单次超时上限（毫秒）：**只给 push 用，绝不与读命令共用**。
 *
 * 推送要把本地对象上传到远端，耗时与本地新增的工作量成正比（本仓库含手写页截图与
 * 附件 zip，几 MB 的数据在家用上行链路上完全可能超过 8 秒）。把读命令的 8 秒预算套到
 * push 上，会把「慢但健康」的推送判成超时——超时会累加同步周期的尝试次数，
 * 一次慢推送就可能把意图停放掉。所以 push 单独用 120 秒这一档；
 * 它已经远大于 askpass / node 的冷启动成本，因此 push **不申请**首次调用放宽
 * （见 `GitRepo.pushBudget()`）。
 */
export const PUSH_TIMEOUT_MS = 120_000

/**
 * 本机**第一次**网络**读命令**（ls-remote / fetch / clone）使用的预算（毫秒）。
 *
 * D2：首次调用要在 git 子进程里启动 askpass 的 node 解释器（冷启动可能数秒），
 * 这段成本不应算进 8s 网络预算，否则健康的远端会在第一次探测/拉取被判成超时。
 * 只有调用方**没有**显式配置 `networkTimeoutMs` 时才会放宽到这个值；
 * 真正用掉的数字会出现在超时错误里（`details.budgetMs` + 文案）。
 * push 不吃这一档：`PUSH_TIMEOUT_MS` 本身已经远大于冷启动（见 `pushBudget()`）。
 */
export const FIRST_NETWORK_TIMEOUT_MS = 20_000

/** 超时的下一步：先怀疑耗时（预热/远端慢），再怀疑链路。 */
export const GIT_TIMEOUT_NEXT_STEP = '下一步：稍后重试；连续超时先检查网络与代理是否可用'

/** 网络不可达的下一步：只有解析 / 连接到远端失败才用这一条。 */
export const GIT_UNREACHABLE_NEXT_STEP = '下一步：检查网络、代理或防火墙，确认远端地址可访问后重试'

/** 超时文案：预算数字一律来自当次实际使用的预算，不写死。 */
export function gitTimeoutMessage(command: string, budgetMs: number, firstCall: boolean): string {
  const warm = firstCall ? '，本机首次调用可能包含预热耗时' : ''
  return `git ${command} 超时（>${budgetMs} 毫秒未完成${warm}）；${GIT_TIMEOUT_NEXT_STEP}`
}

/**
 * 传输层失败的**正面证据**：只有这些字样才算「网络不可达」。
 * `timed out` / `timeout` **不在**此列——超时由结构信号（子进程被预算杀死）判定，
 * 绝不靠对外文文本的宽泛猜测。
 */
const TRANSPORT_EVIDENCE_RE =
  /could not resolve host|could not resolve proxy|failed to connect|couldn'?t connect|unable to access|network is unreachable|no route to host|connection refused|connection reset|connect to [^\s]+ port [^\s]+ failed/i

/** 文本里是否有传输失败的正面证据（结构性判定的唯一入口，供 gitPort 复用）。 */
export function hasTransportEvidence(text: string): boolean {
  return typeof text === 'string' && TRANSPORT_EVIDENCE_RE.test(text)
}

/** 进程内已经发起过多少次带预算的网络 git 调用（第一次调用据此放宽预算）。 */
let networkCallsThisProcess = 0

/** 仅测试：把「本进程第一次网络调用」复位，便于观察首次预算。 */
export function resetNetworkCallBudget(): void {
  networkCallsThisProcess = 0
}

/**
 * git 鉴权环境的**唯一构造点**（mod-plugin-git-auth-env）。
 *
 * 所有出网 git 子进程（clone / ls-remote / fetch / push / pull 相关）都必须从这里取 env，
 * 调用方一律不得自行拼 `GIT_ASKPASS` / `GIT_TERMINAL_PROMPT`。
 * token 只以环境变量交给临时 askpass 脚本，绝不进 argv、配置或日志；
 * `GIT_TERMINAL_PROMPT=0` 让缺 askpass 时快速失败，而不是弹 tty 对话框。
 */
export interface GitAuthEnvConfig {
  authMode: 'https' | 'ssh'
  repoUrl: string
  /** 已解析好的 askpass 用户名（Gitee 登录名 / GitHub x-access-token）。 */
  username: string
  token: string | null
  /** 临时 askpass 脚本路径（https + token + https 仓库时必填）。 */
  askpassPath?: string | null
  /** askpass 调用计数文件（提示文本缺失时区分用户名 / 口令）。 */
  askpassCounter?: string | null
  /** 调用方额外注入的环境（例如测试里的假 git 控制变量）。 */
  extraEnv?: NodeJS.ProcessEnv
  /** 仅测试注入的 node 解析输入；生产不传，由 nodePath.ts 走真实探测。 */
  nodePath?: NodePathInputs
}

/** 是否需要走临时 askpass：仅 https 仓库 + https 模式 + 有 token。 */
export function usesGitAskpass(config: Pick<GitAuthEnvConfig, 'authMode' | 'repoUrl' | 'token'>): boolean {
  return config.authMode === 'https' && config.token !== null && /^https:\/\//i.test(config.repoUrl)
}

/**
 * 构造一条 git 子进程的环境。返回值是可直接交给 execFile 的完整 env；
 * 同一配置多次调用得到逐字节相同的结果（clone / fetch / push 因此完全一致）。
 */
export function gitAuthEnv(config: GitAuthEnvConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...config.extraEnv,
    GIT_TERMINAL_PROMPT: '0',
    GIT_MERGE_AUTOEDIT: 'no',
  }
  if (usesGitAskpass(config)) {
    // 不变量：探针环境 = 真实 askpass 环境 —— 两边都在「启动 node 的那一刻」用同一份规则清掉
    // NODE_OPTIONS / NODE_PATH（askpass.cmd 的 set / nodePath.ts 的 sanitizeNodeEnv），
    // git 子进程本身保留原 env，避免改变 git 自身的行为。
    // 禁用本机 credential.helper（如 Git Credential Manager 的缓存）：唯一凭据来源 = askpass + token。
    // 走 env 而非 argv，gitPort 的固定 push argv 不必改，clone/fetch/ls-remote/push 全部一致生效。
    env.GIT_CONFIG_COUNT = '1'
    env.GIT_CONFIG_KEY_0 = 'credential.helper'
    env.GIT_CONFIG_VALUE_0 = ''
    env.GCM_INTERACTIVE = 'Never'
    env.GIT_ASKPASS = config.askpassPath ?? undefined
    env.DSH_GIT_SYNC_TOKEN = config.token ?? undefined
    env.DSH_GIT_SYNC_USER = config.username
    // node 解释器必须经解析 + 探针验证，不能直接用 process.execPath（DSH 里它是应用二进制）。
    // 解析失败在这里 typed 抛出，早于任何 git 子进程；不涉及 token，也不退化成 auth-prompt。
    // 走 warmAskpassNode：每进程只解析 / 探测一次（冷启动成本在带预算的网络调用之前付掉）。
    const node = warmAskpassNode({ ...config.nodePath, env: config.nodePath?.env ?? env })
    env.DSH_GIT_SYNC_NODE = node.path
    // ELECTRON_RUN_AS_NODE 只在真正使用应用二进制时出现；真实 node.exe 必须没有这个 Electron 变量。
    if (node.electronRunAsNode) env.ELECTRON_RUN_AS_NODE = '1'
    else delete env.ELECTRON_RUN_AS_NODE
    env.DSH_GIT_SYNC_ASKPASS_COUNTER = config.askpassCounter ?? undefined
    env.SSH_ASKPASS_REQUIRE = 'never'
  }
  return env
}

/** 临时提交身份，避免要求用户配置全局 user.name。 */
const IDENTITY_ARGS = ['-c', 'user.name=dsh-dots', '-c', 'user.email=sync@localhost']

/**
 * GIT_ASKPASS 脚本（POSIX）。token 从环境变量读取，脚本本身与 argv 都不含 token。
 * 用户名同样由环境变量提供：GitHub 可留空（默认 x-access-token），
 * Gitee 必须是登录名（私人令牌只作密码）。
 */
const ASKPASS_SH = [
  '#!/bin/sh',
  'case "$1" in',
  '  *sername*) printf \'%s\\n\' "${DSH_GIT_SYNC_USER:-x-access-token}" ;;',
  '  *) printf \'%s\\n\' "${DSH_GIT_SYNC_TOKEN:-}" ;;',
  'esac',
  '',
].join('\n')

/** Windows 版 askpass：转交给 node 执行 askpass.mjs，不在 cmd 里展开 token。 */
const ASKPASS_CMD = [
  '@echo off',
  'rem token 只由 node 从环境变量读取；本文件不含 token，也不做 %VAR% 展开（& | < > % 都安全）。',
  'rem 探针也按同一份规则清掉这两项：探针环境 = 真实 askpass 环境。',
  'set NODE_OPTIONS=',
  'set NODE_PATH=',
  '"%DSH_GIT_SYNC_NODE%" "%~dp0askpass.mjs"',
  'exit /b %ERRORLEVEL%',
  '',
].join('\r\n')

/**
 * node 版 askpass：直接写 stdout，token 只从环境变量读。
 *
 * Windows 上 cmd 的 `echo %VAR%` 会把 `& | < > %` 当成语法，含这些字符的 token 会被
 * 截断/当命令执行；所以 .cmd 只负责调 node，值由 node 原样输出（审计 M5）。
 * 提示文本由 git 作为 argv 传给 askpass，但这条转发路径不经过 cmd 的变量展开。
 * 若拿不到提示文本（例如 .cmd 未转发参数），按调用顺序：第一次给用户名，之后给 token。
 */
const ASKPASS_MJS = [
  '// 由 dsh-dots 生成：token 只从环境变量读，直接写 stdout。',
  "import { readFileSync, writeFileSync } from 'node:fs'",
  '',
  "const token = process.env.DSH_GIT_SYNC_TOKEN ?? ''",
  "const user = process.env.DSH_GIT_SYNC_USER ?? 'x-access-token'",
  "const prompt = process.argv.slice(2).join(' ')",
  '',
  'const emit = (value) => {',
  '  process.stdout.write(`${value}\\n`)',
  '  process.exit(0)',
  '}',
  '',
  "if (/sername/i.test(prompt)) emit(user)",
  "if (/assword|assphrase/i.test(prompt)) emit(token)",
  '',
  "const counterFile = process.env.DSH_GIT_SYNC_ASKPASS_COUNTER ?? ''",
  'let count = 0',
  "if (counterFile !== '') {",
  "  try { count = Number.parseInt(readFileSync(counterFile, 'utf8'), 10) || 0 } catch { count = 0 }",
  '  try { writeFileSync(counterFile, String(count + 1)) } catch { /* 计数失败不影响输出 */ }',
  '}',
  'emit(count === 0 ? user : token)',
  '',
].join('\n')

export interface AskpassFiles {
  dir: string
  /** POSIX `#!/bin/sh` 脚本。 */
  sh: string
  /** Windows 批处理（只调 node，不含 token）。 */
  cmd: string
  /** node 脚本（token 从环境变量读）。 */
  js: string
  /** 调用计数文件（拿不到提示文本时区分用户名/口令）。 */
  counter: string
  /** 当前平台应交给 GIT_ASKPASS 的路径。 */
  path: string
}

/**
 * 写出临时 askpass 文件（0600）。token 从不写入这些文件，只经子进程环境变量传递，
 * 因此不会出现在 argv / 配置文件 / 日志里（BRIEF §2.3、审计 M5）。
 */
export async function writeAskpassFiles(dir: string): Promise<AskpassFiles> {
  const shPath = path.join(dir, 'askpass.sh')
  const cmdPath = path.join(dir, 'askpass.cmd')
  const jsPath = path.join(dir, 'askpass.mjs')
  const counterPath = path.join(dir, 'askpass.count')
  await writeFile(shPath, ASKPASS_SH, { encoding: 'utf8', mode: 0o600 })
  await writeFile(cmdPath, ASKPASS_CMD, { encoding: 'utf8', mode: 0o600 })
  await writeFile(jsPath, ASKPASS_MJS, { encoding: 'utf8', mode: 0o600 })
  try {
    await chmod(shPath, 0o600)
    await chmod(cmdPath, 0o600)
    await chmod(jsPath, 0o600)
  } catch {
    /* Windows 上 chmod 语义有限；这些文件本身不含 token */
  }
  return {
    dir,
    sh: shPath,
    cmd: cmdPath,
    js: jsPath,
    counter: counterPath,
    path: process.platform === 'win32' ? cmdPath : shPath,
  }
}

const LOCAL_PATH_RE = /^(?:[A-Za-z]:[\\/]|\\\\|\/|\.{1,2}[\\/])/
const GIT_SSH_URL_RE = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[^\s]+$/

/**
 * URL 里是否内嵌凭据（`https://user:pass@host` / `https://token@host`）。
 *
 * HTTPS 的 token 必须走临时 GIT_ASKPASS（BRIEF §2.3：不进 argv / 配置文件），
 * 所以带 userinfo 的 https 地址一律拒绝。`ssh://git@host/...` 的 `git@` 是正常的
 * SSH 用户名，不算凭据（只有 `ssh://user:pass@...` 这种带密码的才拒绝）。
 */
export function hasEmbeddedCredentials(repoUrl: string): boolean {
  if (typeof repoUrl !== 'string') return false
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)/.exec(repoUrl.trim())
  if (match === null) return false
  const scheme = (match[1] ?? '').toLowerCase()
  const authority = match[2] ?? ''
  const at = authority.lastIndexOf('@')
  if (at <= 0) return false
  const userinfo = authority.slice(0, at)
  if (userinfo === '') return false
  if (scheme === 'ssh') return userinfo.includes(':')
  return true
}

/** 是否为本插件允许的仓库地址。 */
export function isSupportedRepoUrl(repoUrl: string, allowLocalRepo = false): boolean {
  if (typeof repoUrl !== 'string') return false
  const trimmed = repoUrl.trim()
  if (trimmed === '' || /\s/.test(trimmed)) return false
  if (/^https:\/\/\S+$/i.test(trimmed)) return !hasEmbeddedCredentials(trimmed)
  if (/^ssh:\/\/\S+$/i.test(trimmed)) return !hasEmbeddedCredentials(trimmed)
  if (GIT_SSH_URL_RE.test(trimmed)) return true
  if (allowLocalRepo) {
    if (/^file:\/\/\S+$/i.test(trimmed)) return true
    if (LOCAL_PATH_RE.test(trimmed)) return true
  }
  return false
}

export function assertRepoUrl(repoUrl: string, allowLocalRepo = false): void {
  if (!isSupportedRepoUrl(repoUrl, allowLocalRepo)) {
    throw new SyncError('E_VALIDATION', 'repoUrl 仅支持 https://、ssh://、git@host:path', {
      repoUrl: String(repoUrl).replace(/\/\/[^@/]+@/, '//***@'),
    })
  }
}

function isNonFastForward(text: string): boolean {
  return /non-fast-forward|\[rejected\]|fetch first|Updates were rejected|stale info|failed to push some refs/i.test(text)
}

function isAuthFailure(text: string): boolean {
  return /Authentication failed|could not read Username|could not read Password|Permission denied \(publickey\)|fatal: Authentication|Invalid username or password|terminal prompts disabled|Repository not found|access denied|403 Forbidden/i.test(
    text,
  )
}

/**
 * HTTPS askpass 用户名门闸（薄包装，规则只在 `gitUsername.ts` 一份）：
 *   - 显式 username（界面手填 / `DSH_DOTS_GIT_USERNAME`）优先；
 *   - Gitee 留空 → 按仓库地址推断 owner；推不出来才报可读错误；
 *   - GitHub / 自定义留空 → `x-access-token`（GitHub PAT 约定，历史行为不变）。
 */
export function resolveAskpassUser(platform: Platform, username: string, repoUrl = ''): string {
  const resolved = resolveGitUsername(platform, username, repoUrl)
  if (resolved === '') throw new SyncError('E_VALIDATION', GITEE_USERNAME_REQUIRED)
  return resolved
}

export class GitRepo {
  readonly dir: string
  readonly repoUrl: string
  readonly branch: string
  readonly authMode: 'https' | 'ssh'
  readonly platform: Platform
  readonly username: string

  private readonly token: string | null
  private readonly allowLocalRepo: boolean
  private readonly extraEnv: NodeJS.ProcessEnv
  private readonly nodePath: NodePathInputs | undefined
  private readonly networkTimeoutMs: number
  /** 调用方是否显式给了 networkTimeoutMs（显式预算绝不放宽：测试与自定义上限的口径不变）。 */
  private readonly configuredTimeout: boolean
  private readonly execFileImpl: typeof execFile | undefined
  private askpassDir: string | null = null
  private askpassPath: string | null = null
  private askpassCounter: string | null = null

  constructor(options: GitRepoOptions) {
    assertRepoUrl(options.repoUrl, options.allowLocalRepo === true)
    if (typeof options.branch !== 'string' || options.branch.trim() === '') {
      throw new SyncError('E_VALIDATION', 'branch 不能为空')
    }
    if (typeof options.dir !== 'string' || options.dir.trim() === '') {
      throw new SyncError('E_VALIDATION', '工作副本目录不能为空')
    }
    this.dir = path.resolve(options.dir)
    this.repoUrl = options.repoUrl.trim()
    this.branch = options.branch.trim()
    this.authMode = options.authMode
    this.platform = options.platform ?? 'custom'
    // 显式 username（面板手填）优先；否则读本机环境变量 DSH_DOTS_GIT_USERNAME。
    // 两者都为空时才走 gitUsername.ts 的地址推断（Gitee owner / GitHub x-access-token）。
    const explicitUser = typeof options.username === 'string' ? options.username.trim() : ''
    const envUserRaw = options.env?.DSH_DOTS_GIT_USERNAME ?? process.env.DSH_DOTS_GIT_USERNAME
    const envUser = typeof envUserRaw === 'string' ? envUserRaw.trim() : ''
    this.username = explicitUser !== '' ? explicitUser : envUser
    this.token = options.token !== undefined && options.token !== null && options.token !== '' ? options.token : null
    this.allowLocalRepo = options.allowLocalRepo === true
    this.extraEnv = options.env ?? {}
    this.nodePath = options.nodePath
    this.execFileImpl = options.execFileImpl
    const configured = options.networkTimeoutMs
    this.configuredTimeout =
      typeof configured === 'number' && Number.isFinite(configured) && configured > 0
    this.networkTimeoutMs = this.configuredTimeout
      ? Math.min(configured as number, NETWORK_TIMEOUT_MS)
      : NETWORK_TIMEOUT_MS
  }

  /**
   * 本次网络调用实际要用的预算。
   *
   * - 本进程第一次带预算的网络调用，且调用方没有显式配置 → 放宽到 FIRST_NETWORK_TIMEOUT_MS，
   *   让首次 askpass/node 冷启动不至于把健康远端判成超时；
   * - 其余情况仍然是调用方的预算（默认 NETWORK_TIMEOUT_MS）。
   *
   * 返回值会被写进超时错误的 `details`，用户看到的就是"这次实际用掉的那个数"。
   */
  networkBudget(): { timeoutMs: number; firstCall: boolean } {
    const firstNetworkCall = networkCallsThisProcess === 0
    networkCallsThisProcess += 1
    // firstCall 的语义 = 「这次真的用上了放宽后的首次预算」，不是「这是第几次调用」：
    // 显式配置预算的调用方永远拿到自己给的数字，文案里也不会出现「首次调用」的解释。
    if (!firstNetworkCall || this.configuredTimeout) return { timeoutMs: this.networkTimeoutMs, firstCall: false }
    return { timeoutMs: Math.max(this.networkTimeoutMs, FIRST_NETWORK_TIMEOUT_MS), firstCall: true }
  }

  /**
   * push 的预算（见 `PUSH_TIMEOUT_MS`）：**独立一档，不与读命令共用**。
   *
   * - 恒为 120 秒，**不读** `networkTimeoutMs`：读命令的预算配置不得反向缩小推送；
   * - 恒为 `firstCall: false`：120 秒已远大于 askpass / node 冷启动，不需要再放宽，
   *   文案里也不会出现「首次调用预热」这种用于读命令的解释；
   * - **不推进**进程级网络调用计数：push 抢不走 ls-remote / fetch 的首次放宽。
   */
  pushBudget(): { timeoutMs: number; firstCall: boolean } {
    return { timeoutMs: PUSH_TIMEOUT_MS, firstCall: false }
  }

  private usesAskpass(): boolean {
    return usesGitAskpass({ authMode: this.authMode, repoUrl: this.repoUrl, token: this.token })
  }

  /** 把可能出现在文本里的 token / 用户名 / URL 凭据抹掉，保证错误消息可安全上报。 */
  private scrub(text: string): string {
    let out = typeof text === 'string' ? text : String(text)
    if (this.token !== null && this.token.length >= 4) out = scrubAuthValue(out, this.token)
    // 登录名不是秘密，但也不该进日志/错误串（只用于本机 HTTPS 鉴权）。
    out = scrubAuthValue(out, this.username)
    out = out.replace(/(\bhttps?:\/\/)[^@/\s]+@/gi, '$1***@')
    return out
  }

  private async ensureAskpass(): Promise<void> {
    if (!this.usesAskpass() || this.askpassPath !== null) return
    const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-gcs-askpass-'))
    const files = await writeAskpassFiles(dir)
    this.askpassDir = dir
    this.askpassPath = files.path
    this.askpassCounter = files.counter
  }

  /**
   * 本实例的鉴权环境。所有 git 命令（含 v2 端口的 push）都从这里取 env，
   * 构造细节只在 `gitAuthEnv()` 一份。公开给 sync/gitPort.ts 复用。
   */
  async buildEnv(): Promise<NodeJS.ProcessEnv> {
    if (this.usesAskpass()) await this.ensureAskpass()
    // Gitee 的 HTTPS 规则是「用户名（登录名）+ 私人令牌作密码」；x-access-token 只适用于
    // GitHub PAT。登录名优先手填 / DSH_DOTS_GIT_USERNAME，否则按仓库地址推断 owner；
    // 只有 Gitee 且两者都拿不到时才报可读错误（规则只在 gitUsername.ts 一份）。
    const askpassUser =
      this.authMode === 'https' ? resolveAskpassUser(this.platform, this.username, this.repoUrl) : ''
    return gitAuthEnv({
      authMode: this.authMode,
      repoUrl: this.repoUrl,
      username: askpassUser,
      token: this.token,
      askpassPath: this.askpassPath,
      askpassCounter: this.askpassCounter,
      extraEnv: this.extraEnv,
      nodePath: this.nodePath,
    })
  }

  /**
   * 非零退出的统一解释（D1）：**类别靠结构 + 正面证据**，不靠宽泛外文猜测。
   *
   * - 鉴权失败 → E_AUTH（文案与 details 与历史逐字一致，只多一个 `reason`）；
   * - 传输层失败的正面证据（解析不到主机 / 连接失败 / 无法访问）→ E_GIT + `reason:'unreachable'`，
   *   文案显式写「网络不可达」，并给链路排查的下一步；
   * - 其它 → E_GIT + `reason:'git-failed'`，文案逐字保持历史行为。
   *
   * 注意：**超时不会走到这里**——超时由子进程被预算杀死（结构信号）在 `run()` 里单独判定。
   */
  private failure(args: string[], result: RunResult, network = false): SyncError {
    const text = `${result.stderr}\n${result.stdout}`.trim()
    const summary =
      text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .slice(0, 4)
        .join(' | ') || `exit ${result.code}`
    const auth = isAuthFailure(text)
    const unreachable = !auth && hasTransportEvidence(text)
    const code = auth ? 'E_AUTH' : 'E_GIT'
    const reason = auth ? 'auth-prompt' : unreachable ? 'unreachable' : 'git-failed'
    const raw = `git ${args[0] ?? ''} 失败：${this.scrub(summary)}`
    const message = unreachable
      ? `网络不可达（无法解析或连接到远端）：${raw}；${GIT_UNREACHABLE_NEXT_STEP}`
      : raw
    return new SyncError(code, message, {
      command: args.map((arg) => this.scrub(arg)),
      exitCode: result.code,
      // 调用方据此判断"是否网络类失败"（网络失败才写 reachable:false）；字段名与语义不变。
      network,
      reason,
    })
  }

  /**
   * 起一个 git 子进程。`timeoutMs` 命中时**子进程被杀死**（结构信号 `error.killed`），
   * 这条分支与 stderr 是否有内容、是什么语言无关，因此结果确定：timeout，而不是网络不可达。
   */
  private async run(args: string[], options: RunOptions = {}): Promise<RunResult> {
    const cwd = options.cwd ?? (existsSync(this.dir) ? this.dir : os.tmpdir())
    const env = await this.buildEnv()
    const networkFlags = options.network === true && this.usesAskpass() ? ['-c', 'credential.helper='] : []
    const fullArgs = [...IDENTITY_ARGS, ...networkFlags, ...args]
    const timeoutMs = options.timeoutMs
    const exec = this.execFileImpl ?? execFile

    const result = await new Promise<RunResult>((resolve, reject) => {
      exec(
        'git',
        fullArgs,
        {
          cwd,
          env,
          windowsHide: true,
          maxBuffer: 32 * 1024 * 1024,
          encoding: 'utf8',
          ...(timeoutMs !== undefined ? { timeout: timeoutMs, killSignal: 'SIGTERM' as const } : {}),
        },
        (error, stdout, stderr) => {
          const errno = error === null ? null : (error as NodeJS.ErrnoException).code
          if (errno === 'ENOENT') {
            reject(new SyncError('E_GIT', '找不到 git 可执行文件，请先安装 git 并加入 PATH', { reason: 'git-missing' }))
            return
          }
          const killed = error !== null && (error as unknown as { killed?: unknown }).killed === true
          if (killed && timeoutMs !== undefined) {
            reject(
              new SyncError('E_GIT', gitTimeoutMessage(args[0] ?? '', timeoutMs, options.firstCall === true), {
                command: args.map((arg) => this.scrub(arg)),
                timeoutMs,
                budgetMs: timeoutMs,
                firstCall: options.firstCall === true,
                network: options.network === true,
                reason: 'timeout',
              }),
            )
            return
          }
          const numeric = error === null ? 0 : typeof (error as unknown as { code?: unknown }).code === 'number' ? (error as unknown as { code: number }).code : 1
          resolve({ code: numeric, stdout: stdout ?? '', stderr: stderr ?? '' })
        },
      )
    })

    if (result.code !== 0 && options.allowFailure !== true) throw this.failure(args, result, options.network === true)
    return result
  }

  /** 让 git 保持字节原样：禁用 CRLF 转换（Windows 上默认 core.autocrlf=true 会破坏 patch 字节）。 */
  private async configureRepo(): Promise<void> {
    await this.run(['config', 'core.autocrlf', 'false'], { allowFailure: true })
    await this.run(['config', 'core.safecrlf', 'false'], { allowFailure: true })
    await this.run(['config', 'core.quotepath', 'false'], { allowFailure: true })
  }

  private async ensureRemote(): Promise<void> {
    const current = await this.run(['remote', 'get-url', 'origin'], { allowFailure: true })
    if (current.code !== 0) {
      await this.run(['remote', 'add', 'origin', this.repoUrl])
      return
    }
    if (current.stdout.trim() !== this.repoUrl) {
      await this.run(['remote', 'set-url', 'origin', this.repoUrl])
    }
  }

  private async ensureBranch(): Promise<void> {
    const remoteBranch = await this.run(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${this.branch}`], {
      allowFailure: true,
    })
    if (remoteBranch.code === 0) {
      await this.run(['checkout', '-B', this.branch, `origin/${this.branch}`])
      return
    }
    // 空仓库（或远端还没有该分支）：直接建同名本地分支，等首次 commit/push 建立远端分支。
    await this.run(['checkout', '-B', this.branch])
  }

  async ensureWorkTree(): Promise<{ cloned: boolean }> {
    if (existsSync(path.join(this.dir, '.git'))) {
      await this.ensureRemote()
      await this.configureRepo()
      return { cloned: false }
    }
    const parent = path.dirname(this.dir)
    await mkdir(parent, { recursive: true })
    // 首次 clone 走隔离目录：git 失败时它自己往往留下半个目录 / 半个 .git。
    // 只有 clone 成功且后续初始化全部成功，才原子改名为最终工作副本。
    // 任何失败都在 finally 里清掉隔离目录，并且（若已改名）清掉最终目录——
    // 绝不留 `.git`，也不留 `.git.clone-failed-*`（测试直接断言这两个不变式）。
    const quarantine = path.join(
      parent,
      `.git.clone-failed-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    )
    let installed = false
    try {
      const cloneArgs = ['clone', '--quiet', this.repoUrl, quarantine]
      const cloned = await this.run(cloneArgs, { allowFailure: true, network: true, cwd: parent })
      if (cloned.code !== 0) throw this.failure(cloneArgs, cloned, true)
      if (existsSync(this.dir)) await rm(this.dir, { recursive: true, force: true })
      await rename(quarantine, this.dir)
      installed = true
      await this.configureRepo()
      // clone 时的 checkout 受全局 core.autocrlf 影响，可能把 LF 改成 CRLF；
      // 关掉转换后按索引重写一遍，保证工作树字节 == blob 字节（否则会把别人的设备文件改脏）。
      await this.run(['reset', '--hard'], { allowFailure: true })
      await this.ensureRemote()
      await this.ensureBranch()
      return { cloned: true }
    } catch (error) {
      if (installed) await rm(this.dir, { recursive: true, force: true }).catch(() => undefined)
      throw error
    } finally {
      await rm(quarantine, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  async headSha(): Promise<string> {
    const result = await this.run(['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFailure: true })
    return result.code === 0 ? result.stdout.trim() : ''
  }

  async head(): Promise<HeadInfo> {
    const sha = await this.headSha()
    if (sha === '') return { sha: '', message: '', time: '' }
    const result = await this.run(['log', '-1', '--format=%cI%x09%s'], { allowFailure: true })
    if (result.code !== 0) return { sha, message: '', time: '' }
    const line = result.stdout.replace(/\r?\n$/, '')
    const tab = line.indexOf('\t')
    if (tab < 0) return { sha, message: line, time: '' }
    return { sha, message: line.slice(tab + 1), time: line.slice(0, tab) }
  }

  async lsRemote(): Promise<{ reachable: boolean; branch: string; headSha: string; message: string }> {
    const budget = this.networkBudget()
    const result = await this.run(['ls-remote', '--heads', this.repoUrl], {
      allowFailure: true,
      network: true,
      timeoutMs: budget.timeoutMs,
      firstCall: budget.firstCall,
    })
    if (result.code !== 0) throw this.failure(['ls-remote', this.repoUrl], result, true)
    let headSha = ''
    for (const line of result.stdout.split('\n')) {
      const match = /^([0-9a-f]{40,64})\s+refs\/heads\/(.+)$/.exec(line.trim())
      if (match === null) continue
      if (match[2] === this.branch) {
        headSha = match[1]!
        break
      }
    }
    let message = ''
    if (headSha !== '' && existsSync(path.join(this.dir, '.git'))) {
      const exists = await this.run(['cat-file', '-e', headSha], { allowFailure: true })
      if (exists.code === 0) {
        const subject = await this.run(['log', '-1', '--format=%s', headSha], { allowFailure: true })
        message = subject.code === 0 ? subject.stdout.replace(/\r?\n$/, '') : ''
      }
    }
    return { reachable: true, branch: this.branch, headSha, message }
  }

  /**
   * fetch 远端分支，返回远端分支 sha（远端还没有该分支时为空串）。
   *
   * `reachable` 只用于"最近一次探测结果"：fetch 本身不抛错（远端分支不存在是正常情况），
   * 只有到达远端但拿不到该 ref 时仍算可达。
   */
  async fetch(): Promise<{ headSha: string; reachable: boolean }> {
    await this.ensureRemote()
    const budget = this.networkBudget()
    const fetched = await this.run(['fetch', '--quiet', 'origin', this.branch], {
      allowFailure: true,
      network: true,
      timeoutMs: budget.timeoutMs,
      firstCall: budget.firstCall,
    })
    if (fetched.code !== 0) {
      const text = `${fetched.stderr}\n${fetched.stdout}`
      // 远端根本没有该分支（空仓库/新分支）→ 网络是通的。
      const branchMissing = /couldn't find remote ref|no such remote ref|could not read from remote repository.*not found|remote branch .* not found/i.test(text)
      return { headSha: '', reachable: branchMissing }
    }
    const head = await this.run(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${this.branch}`], {
      allowFailure: true,
    })
    return { headSha: head.code === 0 ? head.stdout.trim() : '', reachable: true }
  }

  /**
   * 本地状态（**不联网**）：分支、脏文件、相对 `origin/<branch>` 的领先/落后提交数。
   *
   * ahead/behind 只在本地存在 `refs/remotes/origin/<branch>` 时给出数字，否则为 null ——
   * 不做 fetch，也不把"没有远端引用"当成 0。
   */
  async status(): Promise<{
    branch: string
    clean: boolean
    changed: string[]
    ahead: number | null
    behind: number | null
  }> {
    const branchResult = await this.run(['rev-parse', '--abbrev-ref', 'HEAD'], { allowFailure: true })
    const branch = branchResult.code === 0 && branchResult.stdout.trim() !== '' ? branchResult.stdout.trim() : this.branch
    const statusResult = await this.run(['status', '--porcelain'], { allowFailure: true })
    const changed =
      statusResult.code === 0
        ? statusResult.stdout
            .split('\n')
            .map((line) => line.slice(3).trim())
            .filter((line) => line !== '')
        : []
    let ahead: number | null = null
    let behind: number | null = null
    const upstream = `refs/remotes/origin/${this.branch}`
    const upstreamRef = await this.run(['rev-parse', '--verify', '--quiet', upstream], { allowFailure: true })
    if (upstreamRef.code === 0) {
      const counts = await this.run(['rev-list', '--left-right', '--count', `HEAD...${upstream}`], {
        allowFailure: true,
      })
      if (counts.code === 0) {
        const parts = counts.stdout.trim().split(/\s+/)
        const a = Number.parseInt(parts[0] ?? '', 10)
        const b = Number.parseInt(parts[1] ?? '', 10)
        if (Number.isFinite(a) && Number.isFinite(b)) {
          ahead = a
          behind = b
        }
      }
    }
    return { branch, clean: changed.length === 0, changed, ahead, behind }
  }

  async pullRebase(): Promise<{ rebased: boolean }> {
    const before = await this.headSha()
    const fetched = await this.fetch()
    if (fetched.headSha === '') return { rebased: false }
    const result = await this.run(['rebase', '--quiet', `refs/remotes/origin/${this.branch}`], { allowFailure: true })
    if (result.code !== 0) {
      const text = `${result.stderr}\n${result.stdout}`
      await this.run(['rebase', '--abort'], { allowFailure: true })
      if (/conflict|CONFLICT|could not apply|needs merge|Resolve all conflicts/i.test(text)) {
        const summary = this.scrub(
          text
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line !== '')
            .slice(0, 4)
            .join(' | '),
        )
        throw new SyncError('E_CONFLICT', `rebase 发生冲突，已 abort，请在本地手动处理后重试（本插件永不 force push）：${summary}`)
      }
      throw this.failure(['rebase'], result)
    }
    const after = await this.headSha()
    return { rebased: before !== after }
  }

  /**
   * 丢弃指定目录之外的本地改动。
   *
   * 工作副本只用于同步，`devices/<other>/` 属于别的设备，绝不能被本机提交
   * （例如 clone 时 CRLF 转换、或缺省 checkout 造成的差异）。
   */
  private async discardChangesOutside(onlyPath: string): Promise<string[]> {
    const prefix = onlyPath.endsWith('/') ? onlyPath : `${onlyPath}/`
    const status = await this.run(['status', '--porcelain'], { allowFailure: true })
    if (status.code !== 0) return []
    const paths: string[] = []
    for (const line of status.stdout.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      const rest = trimmed.slice(2).trim()
      const arrow = rest.indexOf(' -> ')
      const raw = (arrow >= 0 ? rest.slice(arrow + 4) : rest).replace(/^"|"$/g, '')
      if (raw !== '' && raw !== onlyPath && !raw.startsWith(prefix)) paths.push(raw)
    }
    for (const file of paths) {
      const tracked = await this.run(['ls-files', '--error-unmatch', '--', file], { allowFailure: true })
      if (tracked.code === 0) await this.run(['checkout', '--', file], { allowFailure: true })
      else await this.run(['clean', '-fd', '--', file], { allowFailure: true })
    }
    return paths
  }

  async commitAll(message: string, options: { onlyPath?: string } = {}): Promise<{ commit: string; files: string[] }> {
    if (options.onlyPath !== undefined && options.onlyPath !== '') {
      await this.run(['add', '-A', '--', options.onlyPath])
      // 自己的目录之外不留改动，避免把别的设备文件带进提交、也避免 rebase 因脏树失败。
      await this.discardChangesOutside(options.onlyPath)
    } else {
      await this.run(['add', '-A'])
    }
    const status = await this.run(['status', '--porcelain'])
    const changed = status.stdout
      .split('\n')
      .map((line) => line.slice(3).trim())
      .filter((line) => line !== '')
    if (changed.length === 0) {
      const head = await this.head()
      return { commit: head.sha, files: [] }
    }
    await this.run(['commit', '--quiet', '--no-gpg-sign', '-m', message])
    const head = await this.head()
    return { commit: head.sha, files: changed }
  }

  private async pushOnce(): Promise<{ pushed: boolean; upToDate: boolean; nonFastForward: boolean }> {
    // push 用自己的一档（PUSH_TIMEOUT_MS），不走读命令的 networkBudget()：
    // 推送上传对象的耗时与本地工作量成正比，8 秒预算会把慢但健康的推送判成超时。
    const budget = this.pushBudget()
    const result = await this.run(['push', '--porcelain', 'origin', `HEAD:${this.branch}`], {
      allowFailure: true,
      network: true,
      timeoutMs: budget.timeoutMs,
      firstCall: budget.firstCall,
    })
    const text = `${result.stdout}\n${result.stderr}`
    if (result.code === 0) {
      const upToDate = /Everything up-to-date|\[up to date\]/i.test(text)
      return { pushed: !upToDate, upToDate, nonFastForward: false }
    }
    if (isNonFastForward(text)) return { pushed: false, upToDate: false, nonFastForward: true }
    throw this.failure(['push'], result, true)
  }

  /** 单次推送（不做 rebase），供 pushWithRebase 内部使用。 */
  async push(): Promise<{ pushed: boolean; rebased: boolean }> {
    return await this.pushWithRebase()
  }

  /** 非 fast-forward 先 fetch+rebase 再 push，最多 2 次；永不 force。 */
  async pushWithRebase(): Promise<{ pushed: boolean; rebased: boolean }> {
    let rebased = false
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const result = await this.pushOnce()
      if (result.pushed) return { pushed: true, rebased }
      if (!result.nonFastForward) return { pushed: false, rebased }
      if (attempt === 2) break
      const pulled = await this.pullRebase()
      rebased = rebased || pulled.rebased
    }
    throw new SyncError('E_CONFLICT', '远端分支已分叉，rebase 后仍无法快进推送（本插件永不 force push），请人工处理', {
      attempts: 2,
    })
  }

  async log(limit: number): Promise<Array<{ sha: string; message: string; time: string }>> {
    const count = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 10
    const result = await this.run(['log', `-n${count}`, '--format=%H%x09%cI%x09%s'], { allowFailure: true })
    if (result.code !== 0) return []
    const out: Array<{ sha: string; message: string; time: string }> = []
    for (const line of result.stdout.split('\n')) {
      if (line.trim() === '') continue
      const [sha, time, ...rest] = line.split('\t')
      if (sha === undefined || time === undefined) continue
      out.push({ sha, time, message: rest.join('\t') })
    }
    return out
  }

  /** 列出某个 revision 下 `devices/` 的所有文件路径（预览只读取远端 ref，不动工作树）。 */
  async listTree(rev: string, prefix = 'devices/'): Promise<string[]> {
    if (typeof rev !== 'string' || rev === '') return []
    const result = await this.run(['ls-tree', '-r', '--name-only', rev, '--', prefix], { allowFailure: true })
    if (result.code !== 0) return []
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
  }

  /** 读某个 revision 下的文件内容；不存在返回 null。 */
  async showFile(rev: string, relativePath: string): Promise<string | null> {
    if (typeof rev !== 'string' || rev === '') return null
    const result = await this.run(['show', `${rev}:${relativePath}`], { allowFailure: true })
    return result.code === 0 ? result.stdout : null
  }

  async dispose(): Promise<void> {
    if (this.askpassDir !== null) {
      const dir = this.askpassDir
      this.askpassDir = null
      this.askpassPath = null
      this.askpassCounter = null
      try {
        await rm(dir, { recursive: true, force: true })
      } catch {
        /* 临时目录清理失败不影响同步结果 */
      }
    }
  }
}
