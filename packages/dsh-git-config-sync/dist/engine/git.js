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
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SyncError } from './errors.js';
/** 临时提交身份，避免要求用户配置全局 user.name。 */
const IDENTITY_ARGS = ['-c', 'user.name=dsh-git-config-sync', '-c', 'user.email=sync@localhost'];
/**
 * GIT_ASKPASS 脚本（POSIX）。token 从环境变量读取，脚本本身与 argv 都不含 token。
 * 用户名同样由环境变量提供（GitHub/Gitee 的 PAT 用任意非空用户名均可）。
 */
const ASKPASS_SH = [
    '#!/bin/sh',
    'case "$1" in',
    '  *sername*) printf \'%s\\n\' "${DSH_GIT_SYNC_USER:-x-access-token}" ;;',
    '  *) printf \'%s\\n\' "${DSH_GIT_SYNC_TOKEN:-}" ;;',
    'esac',
    '',
].join('\n');
/** Windows 版 askpass：转交给 node 执行 askpass.mjs，不在 cmd 里展开 token。 */
const ASKPASS_CMD = [
    '@echo off',
    'rem token 只由 node 从环境变量读取；本文件不含 token，也不做 %VAR% 展开（& | < > % 都安全）。',
    '"%DSH_GIT_SYNC_NODE%" "%~dp0askpass.mjs"',
    'exit /b %ERRORLEVEL%',
    '',
].join('\r\n');
/**
 * node 版 askpass：直接写 stdout，token 只从环境变量读。
 *
 * Windows 上 cmd 的 `echo %VAR%` 会把 `& | < > %` 当成语法，含这些字符的 token 会被
 * 截断/当命令执行；所以 .cmd 只负责调 node，值由 node 原样输出（审计 M5）。
 * 提示文本由 git 作为 argv 传给 askpass，但这条转发路径不经过 cmd 的变量展开。
 * 若拿不到提示文本（例如 .cmd 未转发参数），按调用顺序：第一次给用户名，之后给 token。
 */
const ASKPASS_MJS = [
    '// 由 dsh-git-config-sync 生成：token 只从环境变量读，直接写 stdout。',
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
].join('\n');
/**
 * 写出临时 askpass 文件（0600）。token 从不写入这些文件，只经子进程环境变量传递，
 * 因此不会出现在 argv / 配置文件 / 日志里（BRIEF §2.3、审计 M5）。
 */
export async function writeAskpassFiles(dir) {
    const shPath = path.join(dir, 'askpass.sh');
    const cmdPath = path.join(dir, 'askpass.cmd');
    const jsPath = path.join(dir, 'askpass.mjs');
    const counterPath = path.join(dir, 'askpass.count');
    await writeFile(shPath, ASKPASS_SH, { encoding: 'utf8', mode: 0o600 });
    await writeFile(cmdPath, ASKPASS_CMD, { encoding: 'utf8', mode: 0o600 });
    await writeFile(jsPath, ASKPASS_MJS, { encoding: 'utf8', mode: 0o600 });
    try {
        await chmod(shPath, 0o600);
        await chmod(cmdPath, 0o600);
        await chmod(jsPath, 0o600);
    }
    catch {
        /* Windows 上 chmod 语义有限；这些文件本身不含 token */
    }
    return {
        dir,
        sh: shPath,
        cmd: cmdPath,
        js: jsPath,
        counter: counterPath,
        path: process.platform === 'win32' ? cmdPath : shPath,
    };
}
const LOCAL_PATH_RE = /^(?:[A-Za-z]:[\\/]|\\\\|\/|\.{1,2}[\\/])/;
const GIT_SSH_URL_RE = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[^\s]+$/;
/**
 * URL 里是否内嵌凭据（`https://user:pass@host` / `https://token@host`）。
 *
 * HTTPS 的 token 必须走临时 GIT_ASKPASS（BRIEF §2.3：不进 argv / 配置文件），
 * 所以带 userinfo 的 https 地址一律拒绝。`ssh://git@host/...` 的 `git@` 是正常的
 * SSH 用户名，不算凭据（只有 `ssh://user:pass@...` 这种带密码的才拒绝）。
 */
export function hasEmbeddedCredentials(repoUrl) {
    if (typeof repoUrl !== 'string')
        return false;
    const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)/.exec(repoUrl.trim());
    if (match === null)
        return false;
    const scheme = (match[1] ?? '').toLowerCase();
    const authority = match[2] ?? '';
    const at = authority.lastIndexOf('@');
    if (at <= 0)
        return false;
    const userinfo = authority.slice(0, at);
    if (userinfo === '')
        return false;
    if (scheme === 'ssh')
        return userinfo.includes(':');
    return true;
}
/** 是否为本插件允许的仓库地址。 */
export function isSupportedRepoUrl(repoUrl, allowLocalRepo = false) {
    if (typeof repoUrl !== 'string')
        return false;
    const trimmed = repoUrl.trim();
    if (trimmed === '' || /\s/.test(trimmed))
        return false;
    if (/^https:\/\/\S+$/i.test(trimmed))
        return !hasEmbeddedCredentials(trimmed);
    if (/^ssh:\/\/\S+$/i.test(trimmed))
        return !hasEmbeddedCredentials(trimmed);
    if (GIT_SSH_URL_RE.test(trimmed))
        return true;
    if (allowLocalRepo) {
        if (/^file:\/\/\S+$/i.test(trimmed))
            return true;
        if (LOCAL_PATH_RE.test(trimmed))
            return true;
    }
    return false;
}
export function assertRepoUrl(repoUrl, allowLocalRepo = false) {
    if (!isSupportedRepoUrl(repoUrl, allowLocalRepo)) {
        throw new SyncError('E_VALIDATION', 'repoUrl 仅支持 https://、ssh://、git@host:path', {
            repoUrl: String(repoUrl).replace(/\/\/[^@/]+@/, '//***@'),
        });
    }
}
function isNonFastForward(text) {
    return /non-fast-forward|\[rejected\]|fetch first|Updates were rejected|stale info|failed to push some refs/i.test(text);
}
function isAuthFailure(text) {
    return /Authentication failed|could not read Username|could not read Password|Permission denied \(publickey\)|fatal: Authentication|Invalid username or password|terminal prompts disabled|Repository not found|access denied|403 Forbidden/i.test(text);
}
export class GitRepo {
    dir;
    repoUrl;
    branch;
    authMode;
    token;
    allowLocalRepo;
    extraEnv;
    askpassDir = null;
    askpassPath = null;
    askpassCounter = null;
    constructor(options) {
        assertRepoUrl(options.repoUrl, options.allowLocalRepo === true);
        if (typeof options.branch !== 'string' || options.branch.trim() === '') {
            throw new SyncError('E_VALIDATION', 'branch 不能为空');
        }
        if (typeof options.dir !== 'string' || options.dir.trim() === '') {
            throw new SyncError('E_VALIDATION', '工作副本目录不能为空');
        }
        this.dir = path.resolve(options.dir);
        this.repoUrl = options.repoUrl.trim();
        this.branch = options.branch.trim();
        this.authMode = options.authMode;
        this.token = options.token !== undefined && options.token !== null && options.token !== '' ? options.token : null;
        this.allowLocalRepo = options.allowLocalRepo === true;
        this.extraEnv = options.env ?? {};
    }
    usesAskpass() {
        return this.authMode === 'https' && this.token !== null && /^https:\/\//i.test(this.repoUrl);
    }
    /** 把可能出现在文本里的 token / URL 凭据抹掉，保证错误消息可安全上报。 */
    scrub(text) {
        let out = typeof text === 'string' ? text : String(text);
        if (this.token !== null && this.token.length >= 4)
            out = out.split(this.token).join('***');
        out = out.replace(/(\bhttps?:\/\/)[^@/\s]+@/gi, '$1***@');
        return out;
    }
    async ensureAskpass() {
        if (!this.usesAskpass() || this.askpassPath !== null)
            return;
        const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-gcs-askpass-'));
        const files = await writeAskpassFiles(dir);
        this.askpassDir = dir;
        this.askpassPath = files.path;
        this.askpassCounter = files.counter;
    }
    async buildEnv() {
        const env = {
            ...process.env,
            ...this.extraEnv,
            GIT_TERMINAL_PROMPT: '0',
            GIT_MERGE_AUTOEDIT: 'no',
        };
        if (this.usesAskpass()) {
            await this.ensureAskpass();
            env.GIT_ASKPASS = this.askpassPath ?? undefined;
            env.DSH_GIT_SYNC_TOKEN = this.token ?? undefined;
            env.DSH_GIT_SYNC_USER = 'x-access-token';
            env.DSH_GIT_SYNC_NODE = process.execPath;
            env.DSH_GIT_SYNC_ASKPASS_COUNTER = this.askpassCounter ?? undefined;
            env.SSH_ASKPASS_REQUIRE = 'never';
        }
        return env;
    }
    failure(args, result) {
        const text = `${result.stderr}\n${result.stdout}`.trim();
        const summary = text
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line !== '')
            .slice(0, 4)
            .join(' | ') || `exit ${result.code}`;
        const code = isAuthFailure(text) ? 'E_AUTH' : 'E_GIT';
        return new SyncError(code, `git ${args[0] ?? ''} 失败：${this.scrub(summary)}`, {
            command: args.map((arg) => this.scrub(arg)),
            exitCode: result.code,
        });
    }
    async run(args, options = {}) {
        const cwd = options.cwd ?? (existsSync(this.dir) ? this.dir : os.tmpdir());
        const env = await this.buildEnv();
        const networkFlags = options.network === true && this.usesAskpass() ? ['-c', 'credential.helper='] : [];
        const fullArgs = [...IDENTITY_ARGS, ...networkFlags, ...args];
        const result = await new Promise((resolve, reject) => {
            execFile('git', fullArgs, { cwd, env, windowsHide: true, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
                const errno = error === null ? null : error.code;
                if (errno === 'ENOENT') {
                    reject(new SyncError('E_GIT', '找不到 git 可执行文件，请先安装 git 并加入 PATH'));
                    return;
                }
                const numeric = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
                resolve({ code: numeric, stdout: stdout ?? '', stderr: stderr ?? '' });
            });
        });
        if (result.code !== 0 && options.allowFailure !== true)
            throw this.failure(args, result);
        return result;
    }
    /** 让 git 保持字节原样：禁用 CRLF 转换（Windows 上默认 core.autocrlf=true 会破坏 patch 字节）。 */
    async configureRepo() {
        await this.run(['config', 'core.autocrlf', 'false'], { allowFailure: true });
        await this.run(['config', 'core.safecrlf', 'false'], { allowFailure: true });
        await this.run(['config', 'core.quotepath', 'false'], { allowFailure: true });
    }
    async ensureRemote() {
        const current = await this.run(['remote', 'get-url', 'origin'], { allowFailure: true });
        if (current.code !== 0) {
            await this.run(['remote', 'add', 'origin', this.repoUrl]);
            return;
        }
        if (current.stdout.trim() !== this.repoUrl) {
            await this.run(['remote', 'set-url', 'origin', this.repoUrl]);
        }
    }
    async ensureBranch() {
        const remoteBranch = await this.run(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${this.branch}`], {
            allowFailure: true,
        });
        if (remoteBranch.code === 0) {
            await this.run(['checkout', '-B', this.branch, `origin/${this.branch}`]);
            return;
        }
        // 空仓库（或远端还没有该分支）：直接建同名本地分支，等首次 commit/push 建立远端分支。
        await this.run(['checkout', '-B', this.branch]);
    }
    async ensureWorkTree() {
        if (existsSync(path.join(this.dir, '.git'))) {
            await this.ensureRemote();
            await this.configureRepo();
            return { cloned: false };
        }
        await mkdir(path.dirname(this.dir), { recursive: true });
        const parent = path.dirname(this.dir);
        const cloneArgs = ['clone', '--quiet', this.repoUrl, this.dir];
        const cloned = await this.run(cloneArgs, { allowFailure: true, network: true, cwd: parent });
        if (cloned.code !== 0)
            throw this.failure(cloneArgs, cloned);
        await this.configureRepo();
        // clone 时的 checkout 受全局 core.autocrlf 影响，可能把 LF 改成 CRLF；
        // 关掉转换后按索引重写一遍，保证工作树字节 == blob 字节（否则会把别人的设备文件改脏）。
        await this.run(['reset', '--hard'], { allowFailure: true });
        await this.ensureRemote();
        await this.ensureBranch();
        return { cloned: true };
    }
    async headSha() {
        const result = await this.run(['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFailure: true });
        return result.code === 0 ? result.stdout.trim() : '';
    }
    async head() {
        const sha = await this.headSha();
        if (sha === '')
            return { sha: '', message: '', time: '' };
        const result = await this.run(['log', '-1', '--format=%cI%x09%s'], { allowFailure: true });
        if (result.code !== 0)
            return { sha, message: '', time: '' };
        const line = result.stdout.replace(/\r?\n$/, '');
        const tab = line.indexOf('\t');
        if (tab < 0)
            return { sha, message: line, time: '' };
        return { sha, message: line.slice(tab + 1), time: line.slice(0, tab) };
    }
    async lsRemote() {
        const result = await this.run(['ls-remote', '--heads', this.repoUrl], { allowFailure: true, network: true });
        if (result.code !== 0)
            throw this.failure(['ls-remote', this.repoUrl], result);
        let headSha = '';
        for (const line of result.stdout.split('\n')) {
            const match = /^([0-9a-f]{40,64})\s+refs\/heads\/(.+)$/.exec(line.trim());
            if (match === null)
                continue;
            if (match[2] === this.branch) {
                headSha = match[1];
                break;
            }
        }
        let message = '';
        if (headSha !== '' && existsSync(path.join(this.dir, '.git'))) {
            const exists = await this.run(['cat-file', '-e', headSha], { allowFailure: true });
            if (exists.code === 0) {
                const subject = await this.run(['log', '-1', '--format=%s', headSha], { allowFailure: true });
                message = subject.code === 0 ? subject.stdout.replace(/\r?\n$/, '') : '';
            }
        }
        return { reachable: true, branch: this.branch, headSha, message };
    }
    /** fetch 远端分支，返回远端分支 sha（远端还没有该分支时为空串）。 */
    async fetch() {
        await this.ensureRemote();
        const fetched = await this.run(['fetch', '--quiet', 'origin', this.branch], { allowFailure: true, network: true });
        if (fetched.code !== 0)
            return { headSha: '' };
        const head = await this.run(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${this.branch}`], {
            allowFailure: true,
        });
        return { headSha: head.code === 0 ? head.stdout.trim() : '' };
    }
    async status() {
        const branchResult = await this.run(['rev-parse', '--abbrev-ref', 'HEAD'], { allowFailure: true });
        const branch = branchResult.code === 0 && branchResult.stdout.trim() !== '' ? branchResult.stdout.trim() : this.branch;
        const statusResult = await this.run(['status', '--porcelain'], { allowFailure: true });
        const changed = statusResult.code === 0
            ? statusResult.stdout
                .split('\n')
                .map((line) => line.slice(3).trim())
                .filter((line) => line !== '')
            : [];
        let ahead = 0;
        let behind = 0;
        const counts = await this.run(['rev-list', '--left-right', '--count', `HEAD...refs/remotes/origin/${this.branch}`], { allowFailure: true });
        if (counts.code === 0) {
            const parts = counts.stdout.trim().split(/\s+/);
            ahead = Number.parseInt(parts[0] ?? '0', 10);
            behind = Number.parseInt(parts[1] ?? '0', 10);
            if (!Number.isFinite(ahead))
                ahead = 0;
            if (!Number.isFinite(behind))
                behind = 0;
        }
        return { branch, clean: changed.length === 0, changed, ahead, behind };
    }
    async pullRebase() {
        const before = await this.headSha();
        const fetched = await this.fetch();
        if (fetched.headSha === '')
            return { rebased: false };
        const result = await this.run(['rebase', '--quiet', `refs/remotes/origin/${this.branch}`], { allowFailure: true });
        if (result.code !== 0) {
            const text = `${result.stderr}\n${result.stdout}`;
            await this.run(['rebase', '--abort'], { allowFailure: true });
            if (/conflict|CONFLICT|could not apply|needs merge|Resolve all conflicts/i.test(text)) {
                const summary = this.scrub(text
                    .split('\n')
                    .map((line) => line.trim())
                    .filter((line) => line !== '')
                    .slice(0, 4)
                    .join(' | '));
                throw new SyncError('E_CONFLICT', `rebase 发生冲突，已 abort，请在本地手动处理后重试（本插件永不 force push）：${summary}`);
            }
            throw this.failure(['rebase'], result);
        }
        const after = await this.headSha();
        return { rebased: before !== after };
    }
    /**
     * 丢弃指定目录之外的本地改动。
     *
     * 工作副本只用于同步，`devices/<other>/` 属于别的设备，绝不能被本机提交
     * （例如 clone 时 CRLF 转换、或缺省 checkout 造成的差异）。
     */
    async discardChangesOutside(onlyPath) {
        const prefix = onlyPath.endsWith('/') ? onlyPath : `${onlyPath}/`;
        const status = await this.run(['status', '--porcelain'], { allowFailure: true });
        if (status.code !== 0)
            return [];
        const paths = [];
        for (const line of status.stdout.split('\n')) {
            const trimmed = line.trim();
            if (trimmed === '')
                continue;
            const rest = trimmed.slice(2).trim();
            const arrow = rest.indexOf(' -> ');
            const raw = (arrow >= 0 ? rest.slice(arrow + 4) : rest).replace(/^"|"$/g, '');
            if (raw !== '' && raw !== onlyPath && !raw.startsWith(prefix))
                paths.push(raw);
        }
        for (const file of paths) {
            const tracked = await this.run(['ls-files', '--error-unmatch', '--', file], { allowFailure: true });
            if (tracked.code === 0)
                await this.run(['checkout', '--', file], { allowFailure: true });
            else
                await this.run(['clean', '-fd', '--', file], { allowFailure: true });
        }
        return paths;
    }
    async commitAll(message, options = {}) {
        if (options.onlyPath !== undefined && options.onlyPath !== '') {
            await this.run(['add', '-A', '--', options.onlyPath]);
            // 自己的目录之外不留改动，避免把别的设备文件带进提交、也避免 rebase 因脏树失败。
            await this.discardChangesOutside(options.onlyPath);
        }
        else {
            await this.run(['add', '-A']);
        }
        const status = await this.run(['status', '--porcelain']);
        const changed = status.stdout
            .split('\n')
            .map((line) => line.slice(3).trim())
            .filter((line) => line !== '');
        if (changed.length === 0) {
            const head = await this.head();
            return { commit: head.sha, files: [] };
        }
        await this.run(['commit', '--quiet', '--no-gpg-sign', '-m', message]);
        const head = await this.head();
        return { commit: head.sha, files: changed };
    }
    async pushOnce() {
        const result = await this.run(['push', '--porcelain', 'origin', `HEAD:${this.branch}`], {
            allowFailure: true,
            network: true,
        });
        const text = `${result.stdout}\n${result.stderr}`;
        if (result.code === 0) {
            const upToDate = /Everything up-to-date|\[up to date\]/i.test(text);
            return { pushed: !upToDate, upToDate, nonFastForward: false };
        }
        if (isNonFastForward(text))
            return { pushed: false, upToDate: false, nonFastForward: true };
        throw this.failure(['push'], result);
    }
    /** 单次推送（不做 rebase），供 pushWithRebase 内部使用。 */
    async push() {
        return await this.pushWithRebase();
    }
    /** 非 fast-forward 先 fetch+rebase 再 push，最多 2 次；永不 force。 */
    async pushWithRebase() {
        let rebased = false;
        for (let attempt = 1; attempt <= 2; attempt += 1) {
            const result = await this.pushOnce();
            if (result.pushed)
                return { pushed: true, rebased };
            if (!result.nonFastForward)
                return { pushed: false, rebased };
            if (attempt === 2)
                break;
            const pulled = await this.pullRebase();
            rebased = rebased || pulled.rebased;
        }
        throw new SyncError('E_CONFLICT', '远端分支已分叉，rebase 后仍无法快进推送（本插件永不 force push），请人工处理', {
            attempts: 2,
        });
    }
    async log(limit) {
        const count = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 10;
        const result = await this.run(['log', `-n${count}`, '--format=%H%x09%cI%x09%s'], { allowFailure: true });
        if (result.code !== 0)
            return [];
        const out = [];
        for (const line of result.stdout.split('\n')) {
            if (line.trim() === '')
                continue;
            const [sha, time, ...rest] = line.split('\t');
            if (sha === undefined || time === undefined)
                continue;
            out.push({ sha, time, message: rest.join('\t') });
        }
        return out;
    }
    /** 列出某个 revision 下 `devices/` 的所有文件路径（预览只读取远端 ref，不动工作树）。 */
    async listTree(rev, prefix = 'devices/') {
        if (typeof rev !== 'string' || rev === '')
            return [];
        const result = await this.run(['ls-tree', '-r', '--name-only', rev, '--', prefix], { allowFailure: true });
        if (result.code !== 0)
            return [];
        return result.stdout
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line !== '');
    }
    /** 读某个 revision 下的文件内容；不存在返回 null。 */
    async showFile(rev, relativePath) {
        if (typeof rev !== 'string' || rev === '')
            return null;
        const result = await this.run(['show', `${rev}:${relativePath}`], { allowFailure: true });
        return result.code === 0 ? result.stdout : null;
    }
    async dispose() {
        if (this.askpassDir !== null) {
            const dir = this.askpassDir;
            this.askpassDir = null;
            this.askpassPath = null;
            this.askpassCounter = null;
            try {
                await rm(dir, { recursive: true, force: true });
            }
            catch {
                /* 临时目录清理失败不影响同步结果 */
            }
        }
    }
}
