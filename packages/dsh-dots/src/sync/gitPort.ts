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
import type { GitRepoOptions } from '../engine/git.js'
import type { AheadCommit, PushArgs, V2GitPort } from './cycle.js'

const COMMIT_IDENTITY = ['-c', 'user.name=dsh-dots', '-c', 'user.email=sync@localhost']

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

/** 统一执行器：execFile，不拼 shell、不拼 token。 */
function run(cwd: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
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

/** 仅这些 git 子命令允许从 v2 层执行（写集合只有 add / commit / push）。 */
const ALLOWED = new Set(['rev-parse', 'rev-list', 'show', 'log', 'diff-tree', 'fetch', 'diff', 'add', 'commit', 'push'])

export class GitRepoV2Port implements V2GitPort {
  private readonly repo: GitRepo

  constructor(options: GitRepoOptions) {
    // v2 固定 main：这里只固定 config 值，不执行任何改分支命令。
    this.repo = new GitRepo({ ...options, branch: 'main' })
  }

  /** args 的第一个元素必须是 allowlist 内的子命令（identity 的 -c 由调用方另外拼）。 */
  private async git(args: string[], allowFailure = false): Promise<RunResult> {
    const sub = args[0] ?? ''
    if (!ALLOWED.has(sub)) {
      throw new SyncError('E_VALIDATION', `v2 git 端口拒绝子命令：${sub}`)
    }
    const result = await run(this.repo.dir, args)
    if (result.code !== 0 && !allowFailure) {
      throw new SyncError('E_GIT', `git ${sub} 失败：${(result.stderr || result.stdout).trim().slice(0, 300)}`)
    }
    return result
  }

  async branchName(): Promise<string> {
    const result = await this.git(['rev-parse', '--abbrev-ref', 'HEAD'], true)
    return result.code === 0 ? result.stdout.trim() : ''
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
    await run(this.repo.dir, args).then((result) => {
      if (result.code !== 0) {
        throw new SyncError('E_GIT', `git commit 失败：${(result.stderr || result.stdout).trim().slice(0, 300)}`)
      }
    })
  }

  async pushMain(args: PushArgs): Promise<void> {
    if (args.remote !== 'origin' || args.branch !== 'main' || args.force !== false) {
      throw new SyncError('E_VALIDATION', 'v2 push 参数必须是 origin/main 且 force:false')
    }
    // 无强制推送参数、无 refspec 改写，只有快进推送。
    await this.git(['push', '--porcelain', 'origin', 'HEAD:main'])
  }

  async dispose(): Promise<void> {
    await this.repo.dispose()
  }
}
