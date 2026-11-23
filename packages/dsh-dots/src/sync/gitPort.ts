/**
 * v2 git 端口的真实适配器：复用 `src/engine/git.ts` 的 `GitRepo`（URL 校验、凭据卫生、
 * fetch、读远端文件），写命令只用 allowlist 的最小集合 add / commit / push。
 *
 * 本文件不含变基 / 硬回退 / 切分支命令；push 实参由 cycle.ts 固定为
 * `{remote:'origin', branch:'main', force:false}`，这里再次断言后执行，绝不拼强制推送参数。
 */
import { execFile } from 'node:child_process'
import { GitRepo } from '../engine/git.js'
import { SyncError } from '../engine/errors.js'
import { ASKPASS_NODE_MISSING_CODE } from '../engine/nodePath.js'
import type { GitRepoOptions } from '../engine/git.js'
import type { AheadCommit, PushArgs, V2GitPort } from './cycle.js'

const COMMIT_IDENTITY = ['-c', 'user.name=dsh-dots', '-c', 'user.email=sync@localhost']

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * 底层执行器：execFile，不拼 shell、不拼 token。
 * env 由调用方从 `GitRepo.buildEnv()`（`gitAuthEnv()` 的唯一构造点）传入，
 * 本函数绝不自行构造环境——这是 push 鉴权不再丢失的关键。
 */
function execGit(cwd: string, args: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env },
      (error, stdout, stderr) => {
        if (error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new SyncError('E_GIT', '找不到 git 可执行文件，请先安装 git 并加入 PATH'))
          return
        }
        const code = error === null ? 0 : typeof (error as { code?: unknown }).code === 'number'
          ? (error as { code: number }).code : 1
        resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' })
      })
  })
}

/** 仅这些 git 子命令允许从 v2 层执行（写集合只有 add / commit / push；status 只读）。 */
export const GIT_SUBCOMMANDS: ReadonlySet<string> = Object.freeze(new Set([
  'rev-parse', 'rev-list', 'show', 'log', 'diff-tree', 'symbolic-ref', 'status',
  'fetch', 'diff', 'add', 'commit', 'push',
]))

/**
 * 危险参数形态（强制 / 删远端 / 改写引用）。这是 **argv 边界的运行时守卫**，
 * 不是源码文本启发式：任何调用方想拼这些参数都会被 `assertSafeGitArgs` 拒绝。
 */
export const FORBIDDEN_GIT_ARG_PATTERNS: readonly RegExp[] = [
  // 用 [e] 拆开字面量，避免本文件自己的正则文本被源码启发式误报（见 T10）。
  /--forc[e](?:-with-lease|-if-includes)?\b/i,
  /(?:^|[\s"'`])-f(?=[\s"'`\]},]|$)/,
  /(?:^|[:\s"'`])\+(?:refs\/heads\/[A-Za-z0-9_.\/*-]+|[A-Za-z0-9_][A-Za-z0-9_.-]*)(?=[\s"'`\]},:/]|$)/,
  /\bpush\.force\s*[=:]/i,
  /--delet[e]\b/i,
]

/** 断言一条 git argv 可以通过：子命令在 allowlist 内且不含任何危险参数。 */
export function assertSafeGitArgs(args: readonly string[]): void {
  const sub = args[0] ?? ''
  if (!GIT_SUBCOMMANDS.has(sub)) {
    throw new SyncError('E_VALIDATION', `v2 git 端口拒绝子命令：${sub}`)
  }
  for (const arg of args.slice(1)) {
    if (FORBIDDEN_GIT_ARG_PATTERNS.some((pattern) => pattern.test(arg))) {
      throw new SyncError('E_VALIDATION', `v2 git 端口拒绝危险参数：${arg}`)
    }
  }
}

/**
 * push argv 的**唯一构造器**（生产 `pushMain` 实际调用它）：先钉死 origin/main/force:false，
 * 再拒绝任何调用方试图附加的强制参数，最后返回固定 argv——不把调用方字符串带进命令。
 * `extra` 只存在于测试 hostile-input 表；生产调用不传，因此永远只有安全的一条路径。
 */
export function buildSafePushArgs(args: PushArgs, extra: readonly string[] = []): string[] {
  if (args.remote !== 'origin' || args.branch !== 'main' || args.force !== false) {
    throw new SyncError('E_VALIDATION', 'v2 push 参数必须是 origin/main 且 force:false')
  }
  assertSafeGitArgs(['push', ...extra])
  return ['push', '--porcelain', 'origin', 'HEAD:main']
}

export interface GitRepoV2PortOptions extends GitRepoOptions {
  /** 注入执行器（仅测试）：拿到的一定是通过 assertSafeGitArgs 的 argv，含同一份鉴权 env。 */
  runner?: (cwd: string, args: string[], env: NodeJS.ProcessEnv) => Promise<RunResult>
}

export class GitRepoV2Port implements V2GitPort {
  private readonly repo: GitRepo
  private readonly runner: ((cwd: string, args: string[], env: NodeJS.ProcessEnv) => Promise<RunResult>) | null

  constructor(options: GitRepoV2PortOptions) {
    // v2 固定 main：这里只固定 config 值，不执行任何改分支命令。
    this.repo = new GitRepo({ ...options, branch: 'main' })
    this.runner = options.runner ?? null
  }

  /**
   * 所有 git 子进程的统一入口：env 只来自 `GitRepo.buildEnv()` → `gitAuthEnv()`。
   * 与 clone / fetch 共用同一份构造逻辑，保证 push 不再丢失 askpass / 用户名 / 禁提示设置。
   */
  private async run(cwd: string, args: string[]): Promise<RunResult> {
    const env = await this.repo.buildEnv()
    if (this.runner !== null) return await this.runner(cwd, args, env)
    return await execGit(cwd, args, env)
  }

  /** 每条命令都过 argv 守卫；identity 的 -c 由 commit() 单独拼，不经此口。 */
  private async git(args: string[], allowFailure = false): Promise<RunResult> {
    assertSafeGitArgs(args)
    const result = await this.run(this.repo.dir, args)
    if (result.code !== 0 && !allowFailure) {
      throw new SyncError('E_GIT', `git ${args[0] ?? ''} 失败：${(result.stderr || result.stdout).trim().slice(0, 300)}`)
    }
    return result
  }

  async branchName(): Promise<string> {
    const result = await this.git(['rev-parse', '--abbrev-ref', 'HEAD'], true)
    const branch = result.code === 0 ? result.stdout.trim() : ''
    if (branch !== '' && branch !== 'HEAD') return branch
    // 空远端首次 clone 后 HEAD 尚未出生（rev-parse 给 HEAD / 失败），但 ensureBranch 已
    // 把意图分支设为 main（尚未出生）；用只读 symbolic-ref 读出它，
    // 避免首条日程被 E_BRANCH_MISMATCH 挡住。
    const symbolic = await this.git(['symbolic-ref', '--short', 'HEAD'], true)
    return symbolic.code === 0 ? symbolic.stdout.trim() : branch
  }

  /**
   * 首次使用前确保 PC 自持工作副本存在（缺则 clone，已有则只核对 remote）。
   * 只转发既有 GitRepo 的实现；本端口仍不暴露任何变基 / 强制推送 / 历史改写动作。
   */
  async prepare(): Promise<{ cloned: boolean }> {
    return await this.repo.ensureWorkTree()
  }

  async fetchMain(): Promise<void> {
    await this.repo.fetch()
  }

  async headSha(): Promise<string> {
    return await this.repo.headSha()
  }

  async originMainSha(): Promise<string> {
    const result = await this.git(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main'], true)
    return result.code === 0 ? result.stdout.trim() : ''
  }

  async showRemote(rel: string): Promise<string> {
    return (await this.repo.showFile('refs/remotes/origin/main', rel)) ?? ''
  }

  async showHead(rel: string): Promise<string> {
    // 只读提交树字节（m2）：不读工作树，避免把未提交的外部改动当作已推送事实。
    return (await this.repo.showFile('HEAD', rel)) ?? ''
  }

  async aheadBehind(): Promise<{ ahead: number; behind: number }> {
    const result = await this.git(['rev-list', '--left-right', '--count', 'HEAD...refs/remotes/origin/main'], true)
    if (result.code !== 0) return { ahead: 0, behind: 0 }
    const parts = result.stdout.trim().split(/\s+/)
    const ahead = Number.parseInt(parts[0] ?? '', 10)
    const behind = Number.parseInt(parts[1] ?? '', 10)
    return { ahead: Number.isFinite(ahead) ? ahead : 0, behind: Number.isFinite(behind) ? behind : 0 }
  }

  async aheadCommits(): Promise<AheadCommit[]> {
    const shas = await this.git(['log', '--format=%H', 'refs/remotes/origin/main..HEAD'], true)
    if (shas.code !== 0) return []
    const out: AheadCommit[] = []
    for (const sha of shas.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')) {
      const message = await this.git(['show', '-s', '--format=%B', sha], true)
      if (message.code !== 0) continue
      const lines = message.stdout.replace(/\r?\n$/, '').split('\n')
      const subject = (lines[0] ?? '').trim()
      const body = lines.slice(1).join('\n')
      const changed = await this.git(['diff-tree', '--no-commit-id', '--name-only', '-r', sha], true)
      const paths = changed.code === 0
        ? changed.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')
        : []
      out.push({ subject, body, paths })
    }
    return out
  }

  async addPaths(paths: string[]): Promise<void> {
    if (paths.length === 0) return
    await this.git(['add', '--', ...paths])
  }

  async commit(message: string, body?: string): Promise<void> {
    const staged = await this.git(['diff', '--cached', '--quiet'], true)
    if (staged.code === 0) return // 没有实际变化：幂等 no-op，不产生空提交
    // 两个 -m：第一段 subject，第二段 body；尾注落在 body，不会被 App 的 `-m subject` 误造。
    const args = [...COMMIT_IDENTITY, 'commit', '--quiet', '--no-gpg-sign', '-m', message]
    if (typeof body === 'string' && body !== '') args.push('-m', body)
    await this.run(this.repo.dir, args).then((result) => {
      if (result.code !== 0) {
        throw new SyncError('E_GIT', `git commit 失败：${(result.stderr || result.stdout).trim().slice(0, 300)}`)
      }
    })
  }

  /**
   * push 失败的稳定原因分类：只输出白名单短语，绝不回显 git stderr / askpass 正文 / token。
   *
   * 注意：node 解释器缺失是 buildEnv() 阶段的 typed 配置错误，由 pushMain() 在调用本函数前
   * 原样抛出；本函数下面的 auth-prompt 分类只处理真正的 git 鉴权失败，语义保持不变。
   */
  private pushFailure(text: string): SyncError {
    let reason: 'auth-prompt' | 'non-fast-forward' | 'network' | 'git-failed' = 'git-failed'
    if (/User cancelled dialog|\/dev\/tty|could not read (Username|Password)|terminal prompts disabled|Authentication failed|prompt script|askpass/i.test(text)) {
      reason = 'auth-prompt'
    } else if (/non-fast-forward|\[rejected\]|fetch first|stale info|failed to push some refs/i.test(text)) {
      reason = 'non-fast-forward'
    } else if (/Could not resolve host|timed? ?out|unable to access|network|connection/i.test(text)) {
      reason = 'network'
    }
    const message = {
      'auth-prompt': '推送失败：HTTPS 鉴权无法通过（git 已禁用交互提示，askpass／用户名或令牌不可用）；请检查鉴权配置后重试',
      'non-fast-forward': '推送失败：远端分支已前进，下一次同步会做有界重试',
      network: '推送失败：网络不可达或远端响应超时，请稍后重试',
      'git-failed': '推送失败：git 拒绝了本次推送，请检查远端状态后重试',
    }[reason]
    return new SyncError('E_PUSH_REJECTED', message, { reason })
  }

  async pushMain(args: PushArgs): Promise<void> {
    // 唯一 push 构造口：固定 argv，无强制参数、无 refspec 改写、无远端删除。
    const pushArgs = buildSafePushArgs(args)
    try {
      await this.git(pushArgs)
    } catch (error) {
      // node 解释器缺失在 git 执行之前就被 fail-closed：保留 typed 码与固定中文文案，
      // 绝不经过 pushFailure() 的 auth-prompt 分类（那会把配置问题误报成鉴权问题）。
      if (error instanceof SyncError && error.code === ASKPASS_NODE_MISSING_CODE) throw error
      // typed 错误 + 固定文案：原文可能含 tty 对话框堆栈、askpass 正文甚至 token，一律不带出。
      throw this.pushFailure(error instanceof Error ? error.message : String(error))
    }
  }

  async dispose(): Promise<void> {
    await this.repo.dispose()
  }
}
