/**
 * `mod-plugin-repo-root`：v2 工作根的**唯一解析点**（PC 自持 clone 为主）。
 *
 * 【为什么改】原共享 clone 模型假设 App 的 `<filesDir>/git-repo` 是唯一工作副本；
 * 但用户规则是「平板不跑原生 DSH」，PC 上的插件永远看不到平板的 filesDir，
 * 所以 `schedule_add` 在没有 `DSH_DOTS_APP_FILES_DIR` 时必然失败。本模块把默认根
 * 改为 PC 自己持有的 `~/.dsh/dots/repos/<repoHash>`，与遗留 `~/.dsh/dots/work/<repoHash>`
 * 明确分开（**绝不复用 work/**）。仓库在工作根内部仍以 `git-repo` 这个目录名落地，
 * 目录名的最终决策点只有 `resolveV2RepoDir`（见 `repoPath.ts`）。
 *
 * 【环境变量优先级（显式、有序）】
 *   1. `DSH_DOTS_REPO_ROOT`——语义「override the v2 work root」，胜出；
 *   2. `DSH_DOTS_APP_FILES_DIR`——**已废弃别名**，效果完全相同，仍可用但必须文档标注废弃；
 *   3. 都没有——默认 `~/.dsh/dots/repos/<repoHash>`。
 * 解析时产出一行结构化日志文本，点名选中的根与原因（env override / deprecated alias /
 * default）；只有注入宿主 logger 时才交它输出，插件源码绝不直接写 stdout。
 *
 * 【两副本拓扑不变式】PC 上的副本与平板上的副本现在**都合法**，二者是对等的两份 clone：
 *   - 不重定基、不强制推送、不改写任何一方的历史；
 *   - fetch 之后做按日并集（union），不是快进覆盖；
 *   - push 被拒只把意图停在仓库外 outbox 并抛 typed 错，绝不报成功；
 *   - 同一 id 同一 ts 的裁决与 App 完全一致：取规范行 UTF-8 字节较大者，败者进
 *     `conflicts.jsonl` 审计；较晚 ts 静默胜出。
 * 克隆新副本时的字节规整属于既有实现细节，不改写提交历史。
 *
 * 【保证的归属】不变基 / 不强制推送的**运行时保证**在 `src/sync/gitPort.ts` 的
 * `buildSafePushArgs`（固定 push argv + 拒绝 hostile 输入）与 `assertSafeGitArgs`
 * （子命令 allowlist + 危险参数拒绝），由 `test/repo-root.test.mjs:R10/R11` 证明；
 * `test/plugin-tools-v2.test.mjs:T10/T10b` 的源码文本扫描只是 heuristic（纵深防御），
 * 不是安全边界，正/负对照只证明 matcher 会命中恶意拼写。
 *
 * 【错误】根无法创建/写入 → typed `E_REPO_ROOT_UNAVAILABLE`（含路径与明确下一步）；
 * 旧的「缺 App filesDir」错码已彻底删除，不再作为用户可见失败存在（有默认值就没有「忘了配」状态）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SyncError, errorMessage } from '../engine/errors.js';
import { dshHome, repoHash } from '../engine/paths.js';
/** 新环境变量：覆盖 v2 工作根（优先）。 */
export const ENV_REPO_ROOT = 'DSH_DOTS_REPO_ROOT';
/** 已废弃别名：与新变量同义，仅为存量配置保留，文档必须标注 deprecated。 */
export const ENV_APP_FILES_DIR = 'DSH_DOTS_APP_FILES_DIR';
/** 仓库在工作根内的目录名；与 App `ROOT_DIR_NAME` 逐字一致。 */
export const SHARED_REPO_DIR_NAME = 'git-repo';
/** 工作根可写性探针（幂等覆写，不删除任何文件）。 */
export const REPO_ROOT_PROBE_FILE = '.repo-root-probe';
/** 根不可用（权限 / 磁盘 / 路径被文件占用）的 typed 码。 */
export const E_REPO_ROOT_UNAVAILABLE = 'E_REPO_ROOT_UNAVAILABLE';
function trimmed(value) {
    return typeof value === 'string' ? value.trim() : '';
}
/** 根不可用的 typed 文案：点名路径、原因与可执行下一步。 */
export function repoRootUnavailableMessage(root, reason) {
    return (`${E_REPO_ROOT_UNAVAILABLE}: v2 工作根 ${root} 无法创建或写入（${reason || '未知 IO 错误'}）。` +
        `下一步：检查该路径父目录的读写权限与磁盘剩余空间，改正后重试；` +
        `或设置 ${ENV_REPO_ROOT} 指向一个可写目录（${ENV_APP_FILES_DIR} 已废弃，不建议继续用）。`);
}
/**
 * 唯一的工作根解析：按 DSH_DOTS_REPO_ROOT → DSH_DOTS_APP_FILES_DIR（废弃别名）→ 默认
 * `~/.dsh/dots/repos/<repoHash>` 的优先级决定 sharedRepoRoot，再拼出 repoDir。
 * 纯字符串决策 + 一行日志，不做任何 IO（可写性由 `ensureRepoRoot` 单独负责）。
 */
export function resolveV2RepoRoot(options = {}) {
    const env = options.env ?? process.env;
    const repoRootOverride = trimmed(env[ENV_REPO_ROOT]);
    const deprecatedAlias = trimmed(options.appFilesDir) || trimmed(env[ENV_APP_FILES_DIR]);
    const hash = repoHash(options.repoUrl ?? '');
    let sharedRepoRoot;
    let source;
    if (repoRootOverride !== '') {
        sharedRepoRoot = path.resolve(repoRootOverride);
        source = 'env override: DSH_DOTS_REPO_ROOT';
    }
    else if (deprecatedAlias !== '') {
        sharedRepoRoot = path.resolve(deprecatedAlias);
        source = 'deprecated alias: DSH_DOTS_APP_FILES_DIR';
    }
    else {
        sharedRepoRoot = path.join(dshHome(options.homeDir), 'dots', 'repos', hash);
        source = 'default';
    }
    const logLine = `[dsh-dots] v2 repo root: ${sharedRepoRoot} (${source}) -> ${path.join(sharedRepoRoot, SHARED_REPO_DIR_NAME)}`;
    // 唯一出口是注入的宿主 logger；没有就静默，logLine 仍随返回值结构化上报。
    const logger = options.logger;
    if (logger !== undefined) {
        try {
            if (typeof logger.info === 'function')
                logger.info(logLine);
            else if (typeof logger.warn === 'function')
                logger.warn(logLine);
        }
        catch {
            // 日志失败不能影响路径解析（与 isolate.ts 的 logFailure 同纪律）。
        }
    }
    return {
        sharedRepoRoot,
        repoDir: path.join(sharedRepoRoot, SHARED_REPO_DIR_NAME),
        repoHash: hash,
        source,
        logLine,
    };
}
/**
 * 确保工作根存在且可写：mkdir + 幂等覆写探针文件（不删除任何东西）。
 * 失败一律 typed `E_REPO_ROOT_UNAVAILABLE`，消息含路径与下一步。
 */
export function ensureRepoRoot(sharedRepoRoot) {
    try {
        mkdirSync(sharedRepoRoot, { recursive: true });
        writeFileSync(path.join(sharedRepoRoot, REPO_ROOT_PROBE_FILE), '', { encoding: 'utf8', flag: 'w' });
    }
    catch (error) {
        throw new SyncError(E_REPO_ROOT_UNAVAILABLE, repoRootUnavailableMessage(sharedRepoRoot, errorMessage(error)), { path: sharedRepoRoot, reason: errorMessage(error) });
    }
}
