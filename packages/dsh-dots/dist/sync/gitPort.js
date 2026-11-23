/**
 * v2 git 端口的真实适配器：复用 `src/engine/git.ts` 的 `GitRepo`（URL 校验、凭据卫生、
 * fetch、读远端文件），写命令只用 allowlist 的最小集合 add / commit / push。
 *
 * 本文件不含变基 / 硬回退 / 切分支命令；push 实参由 cycle.ts 固定为
 * `{remote:'origin', branch:'main', force:false}`，这里再次断言后执行，绝不拼强制推送参数。
 */
import { execFile } from 'node:child_process';
import { GitRepo, PUSH_TIMEOUT_MS, hasAuthRejectedEvidence, httpStatusCodesOf, httpStatusFailureOf, gitTimeoutMessage, hasTransportEvidence, } from '../engine/git.js';
import { SyncError } from '../engine/errors.js';
import { ASKPASS_NODE_MISSING_CODE } from '../engine/nodePath.js';
const COMMIT_IDENTITY = ['-c', 'user.name=dsh-dots', '-c', 'user.email=sync@localhost'];
/**
 * 底层执行器：execFile，不拼 shell、不拼 token。
 * env 由调用方从 `GitRepo.buildEnv()`（`gitAuthEnv()` 的唯一构造点）传入，
 * 本函数绝不自行构造环境——这是 push 鉴权不再丢失的关键。
 *
 * 预算命中时子进程被杀死（结构信号 `killed`）：这条分支与 stderr 有没有内容、
 * 是什么语言无关，因此一律判成 **timeout**，绝不再冒充「网络不可达」（D1）。
 * 即使 stderr 里恰好含 403 字样，结构信号仍优先（见 `pushFailureReason` 的顺序）。
 *
 * `impl` 默认就是 node:child_process 的 execFile；仅测试注入替身，用来观察
 * 「这次 push 实际用了哪一档预算」，生产路径永远走真实 execFile。
 */
function execGit(cwd, args, env, budget, impl = execFile) {
    return new Promise((resolve, reject) => {
        impl('git', args, {
            cwd, windowsHide: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env,
            ...(budget === null ? {} : { timeout: budget.timeoutMs, killSignal: 'SIGTERM' }),
        }, (error, stdout, stderr) => {
            if (error !== null && error.code === 'ENOENT') {
                reject(new SyncError('E_GIT', '找不到 git 可执行文件，请先安装 git 并加入 PATH'));
                return;
            }
            const killed = error !== null && error.killed === true;
            if (killed && budget !== null) {
                reject(new SyncError('E_GIT', gitTimeoutMessage(args[0] ?? 'push', budget.timeoutMs, budget.firstCall), {
                    reason: 'timeout',
                    network: true,
                    killed: true,
                    timeoutMs: budget.timeoutMs,
                    budgetMs: budget.timeoutMs,
                    firstCall: budget.firstCall,
                }));
                return;
            }
            const code = error === null ? 0 : typeof error.code === 'number'
                ? error.code : 1;
            resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
        });
    });
}
/** 仅这些 git 子命令允许从 v2 层执行（写集合只有 add / commit / push；status 只读）。 */
export const GIT_SUBCOMMANDS = Object.freeze(new Set([
    'rev-parse', 'rev-list', 'show', 'log', 'diff-tree', 'symbolic-ref', 'status',
    'fetch', 'diff', 'add', 'commit', 'push',
]));
/**
 * 危险参数形态（强制 / 删远端 / 改写引用）。这是 **argv 边界的运行时守卫**，
 * 不是源码文本启发式：任何调用方想拼这些参数都会被 `assertSafeGitArgs` 拒绝。
 */
export const FORBIDDEN_GIT_ARG_PATTERNS = [
    // 用 [e] 拆开字面量，避免本文件自己的正则文本被源码启发式误报（见 T10）。
    /--forc[e](?:-with-lease|-if-includes)?\b/i,
    /(?:^|[\s"'`])-f(?=[\s"'`\]},]|$)/,
    /(?:^|[:\s"'`])\+(?:refs\/heads\/[A-Za-z0-9_.\/*-]+|[A-Za-z0-9_][A-Za-z0-9_.-]*)(?=[\s"'`\]},:/]|$)/,
    /\bpush\.force\s*[=:]/i,
    /--delet[e]\b/i,
];
/** 断言一条 git argv 可以通过：子命令在 allowlist 内且不含任何危险参数。 */
export function assertSafeGitArgs(args) {
    const sub = args[0] ?? '';
    if (!GIT_SUBCOMMANDS.has(sub)) {
        throw new SyncError('E_VALIDATION', `v2 git 端口拒绝子命令：${sub}`);
    }
    for (const arg of args.slice(1)) {
        if (FORBIDDEN_GIT_ARG_PATTERNS.some((pattern) => pattern.test(arg))) {
            throw new SyncError('E_VALIDATION', `v2 git 端口拒绝危险参数：${arg}`);
        }
    }
}
/**
 * push argv 的**唯一构造器**（生产 `pushMain` 实际调用它）：先钉死 origin/main/force:false，
 * 再拒绝任何调用方试图附加的强制参数，最后返回固定 argv——不把调用方字符串带进命令。
 * `extra` 只存在于测试 hostile-input 表；生产调用不传，因此永远只有安全的一条路径。
 */
export function buildSafePushArgs(args, extra = []) {
    if (args.remote !== 'origin' || args.branch !== 'main' || args.force !== false) {
        throw new SyncError('E_VALIDATION', 'v2 push 参数必须是 origin/main 且 force:false');
    }
    assertSafeGitArgs(['push', ...extra]);
    return ['push', '--porcelain', 'origin', 'HEAD:main'];
}
const PUSH_REASONS = Object.freeze([
    'auth-prompt', 'auth-rejected', 'proxy-auth', 'rate-limited', 'remote-error', 'not-found',
    'non-fast-forward', 'timeout', 'unreachable', 'git-failed',
]);
/**
 * 只有这几个原因可以带 `details.status`：它们本来就是「远端回了一个状态码」。
 * timeout / unreachable / auth-prompt 即便正文里恰好有 403 字样也不掺状态码——
 * 被预算杀死的进程没有等到远端的回答，给它挂一个 403 就是在编故事。
 */
const STATUS_REASONS = Object.freeze([
    'auth-rejected', 'proxy-auth', 'rate-limited', 'remote-error', 'not-found',
]);
/**
 * 超时短语模板：唯一可变量是预算数字（`>N 毫秒`）；终态白名单按这份模板精确匹配。
 *
 * 文案只描述**推送**的耗时来源（要上传本地对象，上传量大或远端响应慢），
 * 不再写「本机首次调用预热」——push 不吃首次调用放宽，那个原因对推送不成立。
 */
export const PUSH_TIMEOUT_REASON_TEMPLATE = '推送失败：推送超时（>N 毫秒未完成，推送需上传本地对象，上传量大或远端响应慢）';
/** 用当次**实际预算**填充超时短语：数字永远来自真实调用，不写死散文。 */
export function pushTimeoutReason(budgetMs) {
    return PUSH_TIMEOUT_REASON_TEMPLATE.replace('>N 毫秒', `>${budgetMs} 毫秒`);
}
/**
 * 从 typed 详情取当次预算；拿不到就退回 push 自己的上限 `PUSH_TIMEOUT_MS`。
 * 退回值也必须是**推送**的预算：这里若退回读命令的 8 秒，文案会把读预算说成推送预算。
 */
function timeoutBudgetOf(error) {
    const details = error?.details;
    for (const value of [details?.budgetMs, details?.timeoutMs]) {
        if (typeof value === 'number' && Number.isFinite(value) && value > 0)
            return Math.floor(value);
    }
    return PUSH_TIMEOUT_MS;
}
/** typed 详情里的 reason（结构信号）；只认白名单里的值，别的值一律忽略。 */
function typedReasonOf(error) {
    const raw = error?.details?.reason;
    const mapped = raw === 'network' ? 'unreachable' : raw; // 旧字段兼容：network = unreachable
    return typeof mapped === 'string' && PUSH_REASONS.includes(mapped)
        ? mapped
        : null;
}
/** typed 详情里的 HTTP 状态码：只认 100..599 的整数，其它（含字符串）一律当没有。 */
function statusOf(error) {
    const raw = error?.details?.status;
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 100 || raw > 599)
        return undefined;
    return raw;
}
/** 子进程被预算杀死 / 明确的超时 errno：与 stderr 语言无关的结构信号。 */
function killedTimeout(error) {
    const record = error;
    return record?.killed === true
        || record?.details?.killed === true
        || record?.code === 'ETIMEDOUT'
        || (error instanceof Error && error.name === 'TimeoutError');
}
function errorTextOf(error) {
    return error instanceof Error ? error.message : String(error);
}
/**
 * 拿不出凭据（本机鉴权环境）：git **没有**把凭据送出去 ⇒ `auth-prompt`。
 * `Authentication failed` / `HTTP Basic: Access denied` 一类**不在**这里：那两句是
 * 「凭据已送出、远端拒绝」，由 `hasAuthRejectedEvidence()`（`engine/git.ts` 的同一张表）
 * 判成 `auth-rejected`（评审 b11b P2-2：被拒绝 ≠ 不可用，两句话不能共用）。
 */
const AUTH_TEXT_RE = /User cancelled dialog|\/dev\/tty|could not read (Username|Password)|terminal prompts disabled|prompt script|askpass/i;
const NON_FAST_FORWARD_TEXT_RE = /non-fast-forward|\[rejected\]|fetch first|stale info|failed to push some refs/i;
const TIMEOUT_TEXT_RE = /timed? ?out|timeout|ETIMEDOUT/i;
/**
 * 分类顺序（D1 的核心 + 评审 b11b 的 P2-1 / P2-4 收口）：
 *   1. 结构：typed `details.reason`（engine 的 timeout / unreachable / 状态码原因原样透传）；
 *   2. 结构：`killed` / ETIMEDOUT / TimeoutError → **timeout**，哪怕 stderr 为空、是外文，
 *      甚至恰好含 403 字样（被预算杀死的进程没有「远端拒绝」这件事）；
 *   3. **硬传输证据** → unreachable：`Could not resolve host` / `Failed to connect` 一类是真的
 *      链路没通；此时同一段 stderr 里那串 HTTP 文本只是回显，**硬证据优先于状态码**
 *      （评审 b11b P2-4：`remote: … HTTP 403 …` 与 DNS 失败同时出现时必须判不可达）；
 *   4. 状态码：401/403 → auth-rejected，404 → not-found，407 → proxy-auth，429 → rate-limited，
 *      5xx → remote-error（**先于一切文本匹配**：Gitee 的 403 正文里不含硬证据，所以不会被打断）；
 *   5. 认出了状态码却没映射（3xx / 400 / 405 / 422 …）→ **git-failed**，不落回「不可达」；
 *   6. 文本：拿不出凭据 → auth-prompt；凭据被拒（`Authentication failed` 一类）→ auth-rejected；
 *      non-fast-forward；只有超时字样、没有传输证据 → timeout；
 *   7. 其它 → git-failed（既有文案）。
 */
function textFailureOf(text) {
    // 硬传输证据先跑：链路没通的时候，状态码只是被回显出来的数字。
    if (hasTransportEvidence(text))
        return { reason: 'unreachable' };
    // 状态码只从 git 自己的输出里取，且只认 git 会打印的形状（见 engine/git.ts）。
    const byStatus = httpStatusFailureOf(text);
    if (byStatus !== null)
        return { reason: byStatus.reason, status: byStatus.status };
    // 认出了状态码但没映射（3xx / 400 / 405 / 422 …）：远端回过话，不是网络问题，也不是凭据问题。
    if (httpStatusCodesOf(text).length > 0)
        return { reason: 'git-failed' };
    if (AUTH_TEXT_RE.test(text))
        return { reason: 'auth-prompt' };
    // 凭据已送出但被拒（没有数字状态码）：说成「拿不到凭据」会让用户去改本机鉴权配置，
    // 而真相是令牌过期/被吊销 —— 直接判 auth-rejected，与 401/403 同一句文案（不带 status 数字）。
    if (hasAuthRejectedEvidence(text))
        return { reason: 'auth-rejected' };
    if (NON_FAST_FORWARD_TEXT_RE.test(text))
        return { reason: 'non-fast-forward' };
    if (TIMEOUT_TEXT_RE.test(text))
        return { reason: 'timeout' };
    return { reason: 'git-failed' };
}
/** push 失败的原因分类（导出给测试与调用方；只产类别，不产文案）。 */
export function pushFailureReason(error) {
    const typed = typedReasonOf(error);
    if (typed !== null)
        return typed;
    if (killedTimeout(error))
        return 'timeout';
    return textFailureOf(errorTextOf(error)).reason;
}
export class GitRepoV2Port {
    repo;
    runner;
    execFileImpl;
    constructor(options) {
        // v2 固定 main：这里只固定 config 值，不执行任何改分支命令。
        this.repo = new GitRepo({ ...options, branch: 'main' });
        this.runner = options.runner ?? null;
        // 仅测试注入：用来观察 push 实际拿到的 `timeout` 选项；生产不传，走真实 execFile。
        this.execFileImpl = options.execFileImpl ?? null;
    }
    /**
     * 所有 git 子进程的统一入口：env 只来自 `GitRepo.buildEnv()` → `gitAuthEnv()`。
     * 与 clone / fetch 共用同一份构造逻辑，保证 push 不再丢失 askpass / 用户名 / 禁提示设置。
     *
     * **只有 push 带预算，且用的是 push 自己的一档 `PUSH_TIMEOUT_MS`（120 秒）**：
     * 推送上传对象，耗时与本地工作量成正比，读命令的 8 秒预算会把慢但健康的推送杀掉；
     * push 也不吃首次调用放宽（120 秒已远大于冷启动）。其余命令一律不带预算。
     */
    async run(cwd, args) {
        const env = await this.repo.buildEnv();
        // 注入的 runner 是测试替身，不消耗进程级预算，也不经过真实 execFile。
        if (this.runner !== null)
            return await this.runner(cwd, args, env);
        const budget = args[0] === 'push' ? this.repo.pushBudget() : null;
        return await execGit(cwd, args, env, budget, this.execFileImpl ?? execFile);
    }
    /** 每条命令都过 argv 守卫；identity 的 -c 由 commit() 单独拼，不经此口。 */
    async git(args, allowFailure = false) {
        assertSafeGitArgs(args);
        const result = await this.run(this.repo.dir, args);
        if (result.code !== 0 && !allowFailure) {
            const text = (result.stderr || result.stdout).trim();
            const outcome = textFailureOf(text);
            throw new SyncError('E_GIT', `git ${args[0] ?? ''} 失败：${text.slice(0, 300)}`, {
                // 只带**类别**（与状态码数字）进详情，结构化分类用；正文仍按既有口径截断进 message。
                // 状态码是纯数字，不含凭据；`auth-rejected` 之类的判定因此能一路传到 pushFailure()。
                reason: outcome.reason,
                ...(outcome.status === undefined ? {} : { status: outcome.status }),
                exitCode: result.code,
            });
        }
        return result;
    }
    async branchName() {
        const result = await this.git(['rev-parse', '--abbrev-ref', 'HEAD'], true);
        const branch = result.code === 0 ? result.stdout.trim() : '';
        if (branch !== '' && branch !== 'HEAD')
            return branch;
        // 空远端首次 clone 后 HEAD 尚未出生（rev-parse 给 HEAD / 失败），但 ensureBranch 已
        // 把意图分支设为 main（尚未出生）；用只读 symbolic-ref 读出它，
        // 避免首条日程被 E_BRANCH_MISMATCH 挡住。
        const symbolic = await this.git(['symbolic-ref', '--short', 'HEAD'], true);
        return symbolic.code === 0 ? symbolic.stdout.trim() : branch;
    }
    /**
     * 首次使用前确保 PC 自持工作副本存在（缺则 clone，已有则只核对 remote）。
     * 只转发既有 GitRepo 的实现；本端口仍不暴露任何变基 / 强制推送 / 历史改写动作。
     */
    async prepare() {
        return await this.repo.ensureWorkTree();
    }
    async fetchMain() {
        await this.repo.fetch();
    }
    async headSha() {
        return await this.repo.headSha();
    }
    async originMainSha() {
        const result = await this.git(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main'], true);
        return result.code === 0 ? result.stdout.trim() : '';
    }
    async showRemote(rel) {
        return (await this.repo.showFile('refs/remotes/origin/main', rel)) ?? '';
    }
    async showHead(rel) {
        // 只读提交树字节（m2）：不读工作树，避免把未提交的外部改动当作已推送事实。
        return (await this.repo.showFile('HEAD', rel)) ?? '';
    }
    async aheadBehind() {
        const result = await this.git(['rev-list', '--left-right', '--count', 'HEAD...refs/remotes/origin/main'], true);
        if (result.code !== 0)
            return { ahead: 0, behind: 0 };
        const parts = result.stdout.trim().split(/\s+/);
        const ahead = Number.parseInt(parts[0] ?? '', 10);
        const behind = Number.parseInt(parts[1] ?? '', 10);
        return { ahead: Number.isFinite(ahead) ? ahead : 0, behind: Number.isFinite(behind) ? behind : 0 };
    }
    async aheadCommits() {
        const shas = await this.git(['log', '--format=%H', 'refs/remotes/origin/main..HEAD'], true);
        if (shas.code !== 0)
            return [];
        const out = [];
        for (const sha of shas.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')) {
            const message = await this.git(['show', '-s', '--format=%B', sha], true);
            if (message.code !== 0)
                continue;
            const lines = message.stdout.replace(/\r?\n$/, '').split('\n');
            const subject = (lines[0] ?? '').trim();
            const body = lines.slice(1).join('\n');
            const changed = await this.git(['diff-tree', '--no-commit-id', '--name-only', '-r', sha], true);
            const paths = changed.code === 0
                ? changed.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')
                : [];
            out.push({ subject, body, paths });
        }
        return out;
    }
    async addPaths(paths) {
        if (paths.length === 0)
            return;
        await this.git(['add', '--', ...paths]);
    }
    async commit(message, body) {
        const staged = await this.git(['diff', '--cached', '--quiet'], true);
        if (staged.code === 0)
            return; // 没有实际变化：幂等 no-op，不产生空提交
        // 两个 -m：第一段 subject，第二段 body；尾注落在 body，不会被 App 的 `-m subject` 误造。
        const args = [...COMMIT_IDENTITY, 'commit', '--quiet', '--no-gpg-sign', '-m', message];
        if (typeof body === 'string' && body !== '')
            args.push('-m', body);
        await this.run(this.repo.dir, args).then((result) => {
            if (result.code !== 0) {
                throw new SyncError('E_GIT', `git commit 失败：${(result.stderr || result.stdout).trim().slice(0, 300)}`);
            }
        });
    }
    /**
     * push 失败的稳定原因分类：只输出白名单短语，绝不回显 git stderr / askpass 正文 / token。
     *
     * 注意：node 解释器缺失是 buildEnv() 阶段的 typed 配置错误，由 pushMain() 在调用本函数前
     * 原样抛出；本函数下面的 auth-prompt 分类只处理真正的「拿不到凭据」，语义保持不变。
     *
     * 五个状态码原因（b11 P2-6 + b11b P2-1）：`auth-rejected` / `not-found` / `proxy-auth` /
     * `rate-limited` / `remote-error`
     * 的短语都以「推送失败：」开头、单行、只说原因，动作由 `sync/cycle.ts` 的 `nextStepOf()`
     * 按 `details.reason` 补一条对应的下一步；`details` 只带 `reason` 与 `status`（数字），
     * 永远不带 URL / 用户名 / 令牌。
     *
     * `auth-rejected` 也覆盖**没有数字状态码**的凭据被拒文本（`Authentication failed` /
     * `HTTP Basic: Access denied`，b11b P2-2）：那时 `details.status` 不掺数字（没看见数字就
     * 不编），但原因句与下一步照样是「改登录名/令牌」，不会退回本机鉴权配置。
     */
    pushFailure(error) {
        const reason = pushFailureReason(error);
        const budgetMs = timeoutBudgetOf(error);
        // 状态码优先取 typed 详情（git() 已带出）；详情没有就再从不含凭据的错误文本里认一次。
        const status = statusOf(error) ?? httpStatusFailureOf(errorTextOf(error))?.status;
        // 文案表：十条短语都以「推送失败：」开头，终态白名单（cycle.ts）用同一批短语做精确匹配。
        // 措辞必须与 `engine/git.ts` 的 HTTP_STATUS_CAUSE_ZH 说的是同一件事（见测试的措辞一致性断言）。
        const message = {
            'auth-prompt': '推送失败：HTTPS 鉴权无法通过（git 已禁用交互提示，askpass／用户名或令牌不可用）；请检查鉴权配置后重试',
            // 凭据已送出但被远端拒绝：与 auth-prompt（拿不出凭据）是两件事，不许合并。
            'auth-rejected': '推送失败：远端拒绝了这个用户名或令牌（HTTP 401/403），凭据需要重新核对',
            // 404：仓库不存在 / 改名 / 当前凭据看不到它——不是网络问题（b11b P2-1）。
            'not-found': '推送失败：远端返回 404，仓库不存在或当前凭据看不到它',
            'proxy-auth': '推送失败：代理要求它自己的鉴权（HTTP 407），不是仓库凭据的问题',
            'rate-limited': '推送失败：远端限流（HTTP 429），稍后再推',
            // 5xx 不单方面归因给仓库：代理/网关回 502 时 git 的文案与仓库自己回 502 完全相同（b11b P2-3）。
            'remote-error': '推送失败：远端或代理返回 HTTP 5xx，本地改动与令牌都没有问题',
            'non-fast-forward': '推送失败：远端分支已前进，下一次同步会做有界重试',
            timeout: pushTimeoutReason(budgetMs),
            unreachable: '推送失败：网络不可达（无法解析或连接到远端）',
            'git-failed': '推送失败：git 拒绝了本次推送，请检查远端状态后重试',
        }[reason];
        // 超时把当次预算一并带进 typed 详情（`budgetMs`）：调用方能直接看到「这次用掉的是 push 的
        // 120 秒档」，不必从文案里解析；状态码原因带 `status`（纯数字），其它原因与预算无关。
        const details = { reason };
        if (reason === 'timeout')
            details.budgetMs = budgetMs;
        if (status !== undefined && STATUS_REASONS.includes(reason)) {
            details.status = status;
        }
        return new SyncError('E_PUSH_REJECTED', message, details);
    }
    async pushMain(args) {
        // 唯一 push 构造口：固定 argv，无强制参数、无 refspec 改写、无远端删除。
        const pushArgs = buildSafePushArgs(args);
        try {
            await this.git(pushArgs);
        }
        catch (error) {
            // node 解释器缺失在 git 执行之前就被 fail-closed：保留 typed 码与固定中文文案，
            // 绝不经过 pushFailure() 的 auth-prompt 分类（那会把配置问题误报成鉴权问题）。
            if (error instanceof SyncError && error.code === ASKPASS_NODE_MISSING_CODE)
                throw error;
            // typed 错误 + 固定文案：原文可能含 tty 对话框堆栈、askpass 正文甚至 token，一律不带出。
            // 传错误对象而不是 message：结构信号（killed / details.reason）必须能到达分类器。
            throw this.pushFailure(error);
        }
    }
    async dispose() {
        await this.repo.dispose();
    }
}
