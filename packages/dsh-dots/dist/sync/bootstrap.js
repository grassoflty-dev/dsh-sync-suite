/**
 * v2 写半侧的**生产接线点**（M1）：把迁移门禁、仓库外 outbox、真实 git 端口和
 * 同步周期组装成一个运行时，并从插件真实启动路径 `src/index.ts:apply()` 挂载。
 *
 * 这里刻意**不重连** v1 的 `schedule_*` 工具（`src/schedule/**` 原样保留）；
 * 本模块只负责 v2 timeline 的首跑迁移与周期，失败一律 typed、零静默。
 *
 * 工作根由 `src/sync/repoRoot.ts` 按 `DSH_DOTS_REPO_ROOT` → `DSH_DOTS_APP_FILES_DIR`
 * （已废弃别名）→ 默认 `~/.dsh/dots/repos/<repoHash>` 的优先级解析；没有 env 也照样工作，
 * 旧的「缺 App filesDir」fail-closed 分支已删除。根不可创建/写入时 typed `E_REPO_ROOT_UNAVAILABLE`。
 * 迁移只在「旧 work 目录存在且新 repos 根不存在」时发生，先备份再移动且幂等。
 */
import path from 'node:path';
import { SettingsStore, LocalStateStore } from '../engine/settings.js';
import { statePaths } from '../engine/paths.js';
import { SyncError } from '../engine/errors.js';
import { NodeTimelineFs } from '../timeline/write.js';
import { NodeMigrationIo, ensureRepoRoot, legacyWorkDir, migrateIfNeeded, resolveV2RepoDirDetailed, } from './repoPath.js';
import { NodeOutboxPort } from './outbox.js';
import { GitRepoV2Port } from './gitPort.js';
import { runV2Cycle } from './cycle.js';
/**
 * mod-plugin-v2-marksynced：唯一成功判据（**总函数**，任何输入都返回 boolean，绝不抛）。
 *
 * 只认「确实发生过同步」的三种结果形状，按优先级互斥判定：
 *  1. v1 `push()` 结果 `{ pushed }`：只要 `pushed` 是 boolean 就以它为准，
 *     `false` = 本次没有任何东西到达远端，拒绝；
 *  2. v1 `apply()` 结果（带 `verified: true`）：写回本地成功，接受（既有语义不变）；
 *  3. v2 `CycleResult`：只有 `ok === true && code === 'ok'`
 *     且 `attempts` 有限并为正数，才证明至少一次真实 push 成功返回。`attempts === 0` 的纯快进 / 无写入周期、
 *     outbox 只停放（nothing reached remote）以及 `ok === false` 的
 *     diverged / refused / push-rejected 周期一律拒绝。
 * 其余形状（null / 数组 / 缺字段 / 类型不符）fail-closed。
 */
export function shouldMarkSynced(result) {
    // P2-2：「永不抛」必须是代码事实——被撤销的 Proxy / 抛异常的 getter 也只返回 false。
    try {
        if (result === null || typeof result !== 'object' || Array.isArray(result))
            return false;
        const record = result;
        if (typeof record.pushed === 'boolean')
            return record.pushed === true;
        if (record.verified === true)
            return true;
        // P2-1：只有有限且为正的 attempts 才算真实推送的正面证据；Infinity / NaN 不算。
        const attempts = record.attempts;
        return record.ok === true && record.code === 'ok' &&
            Number.isFinite(attempts) && attempts > 0;
    }
    catch {
        return false;
    }
}
/**
 * v2 唯一落戳动作：判据为假时零动作；为真时**恰好调用一次** mark。
 * 保证口径是「每个成功周期恰好盖一次」——不是「一个 save 总共只能盖一次」：
 * 两个成功周期就是两戳，成功 + no-op 仍只有一戳。v1 push/apply 保持既有语义，不走这里。
 */
export function stampIfSynced(result, mark) {
    if (!shouldMarkSynced(result))
        return false;
    mark(result);
    return true;
}
/** 唯一生产装配处：真实端口与路径都在这里 new 出来，不存在「库函数无人调用」。 */
export class V2SyncRuntime {
    repoDir;
    outbox;
    repoRootSource;
    repoRootLogLine;
    homeDir;
    appFilesDir;
    settings;
    stateStore;
    allowLocalRepo;
    now;
    markSynced;
    cycleRunner;
    /** 本运行时实际落戳次数（供测试断言每个成功周期恰好 +1）。 */
    stampCount = 0;
    lastStatus = null;
    constructor(options) {
        this.homeDir = options.homeDir;
        this.appFilesDir = (options.appFilesDir ?? process.env.DSH_DOTS_APP_FILES_DIR ?? '').trim();
        this.allowLocalRepo = options.allowLocalRepo === true;
        this.now = options.now ?? new Date();
        const paths = statePaths(this.homeDir);
        this.settings = new SettingsStore(paths, { allowLocalRepo: this.allowLocalRepo });
        this.stateStore = new LocalStateStore(paths);
        // 保留字面的 `await runV2Cycle(...)`（WIR02 生产装配点守卫逐字钉住），注入只作测试覆盖。
        this.cycleRunner = options.cycleRunner;
        // 缺省落戳器与 rpc.ts 的 markSynced() 共用同一 ISO 形状：Date.toISOString()。
        // state.json 写失败只影响展示，绝不让已成功的同步变成失败（与 v1 markSynced 同口径）。
        this.markSynced = options.markSynced ?? (() => {
            try {
                this.stateStore.writeLastSyncAt(this.now.toISOString());
            }
            catch {
                /* state.json 只是 UI 展示用的运行事实 */
            }
        });
        // 单一仓库目录决策点：env 优先级 + 默认 ~/.dsh/dots/repos/<repoHash>/git-repo。
        const resolved = resolveV2RepoDirDetailed({
            appFilesDir: this.appFilesDir,
            repoUrl: this.settings.readSettings().repoUrl,
            homeDir: this.homeDir,
            logger: options.logger,
        });
        this.repoDir = resolved.repoDir;
        this.repoRootSource = resolved.source;
        this.repoRootLogLine = resolved.logLine;
        const configuredRepoUrl = this.settings.readSettings().repoUrl;
        // 仓库外 outbox（%USERPROFILE%\.dsh\dots\outbox\<repoHash>.json）。
        this.outbox = new NodeOutboxPort({
            stateRoot: paths.root,
            repoUrl: configuredRepoUrl === '' ? 'unconfigured' : configuredRepoUrl,
        });
    }
    /**
     * 唯一周期 + 唯一落戳点：start() 与 syncNow() 两个调用点都经这里。
     * 每个成功周期恰好盖一次；失败路径零写入、结果原样上报。
     * 诚实边界：`syncNow()` 目前**没有生产调用者**，这条接缝在生产中只经 start() 跑；
     * 测试用 cycleRunner 覆盖 syncNow，只为钉住「两个调用点共用同一落戳点」。
     */
    async runCycle(days, git) {
        const options = {
            days, git, fs: new NodeTimelineFs(this.repoDir), outbox: this.outbox, now: this.now,
        };
        const cycle = this.cycleRunner !== undefined
            ? await this.cycleRunner(options)
            : await runV2Cycle(options);
        try {
            if (stampIfSynced(cycle, this.markSynced))
                this.stampCount += 1;
        }
        catch {
            /* P2-5：落戳失败只影响 UI 展示，绝不改变周期结果 / 让宿主保存失败 */
        }
        return cycle;
    }
    /** 本运行时已落戳次数；两个调用点都只经 runCycle，每个成功周期 +1。 */
    get syncedStampCount() {
        return this.stampCount;
    }
    /** 首跑迁移 + 有待同步意图时跑一次周期；任何 typed 中止都原样上报，绝不吞。 */
    async start() {
        const config = this.settings.readSettings();
        const base = {
            ok: false, code: 'E_UNCONFIGURED', message: '尚未配置仓库地址，v2 同步未启动',
            repoDir: this.repoDir, repoRootSource: this.repoRootSource, repoRootLogLine: this.repoRootLogLine,
            outboxFile: this.outbox.filePath, migrated: false, synced: false,
        };
        if (config.repoUrl.trim() === '') {
            this.lastStatus = base;
            return base;
        }
        const paths = statePaths(this.homeDir);
        const legacy = legacyWorkDir(paths.workRoot, config.repoUrl);
        const marker = path.join(paths.root, 'v2-migration.json');
        let migrated = false;
        try {
            // 迁移无二义：仅 legacy 在、新 repos 根不在时搬运；其余情况零触碰。
            await migrateIfNeeded({
                legacyDir: legacy,
                newRoot: path.dirname(this.repoDir),
                targetDir: this.repoDir,
                markerPath: marker,
                io: new NodeMigrationIo(),
            });
            // 新根不存在时创建并验证可写（迁移已搬入时为幂等 no-op）。
            ensureRepoRoot(path.dirname(this.repoDir));
            migrated = true;
        }
        catch (error) {
            const code = error instanceof SyncError ? error.code : 'E_IO';
            const status = {
                ...base, ok: false, code,
                message: error instanceof Error ? error.message : String(error), migrated: false,
            };
            this.lastStatus = status;
            return status; // E_LEGACY_UNPUSHED / E_REPO_ROOT_UNAVAILABLE 原样可见，零写入
        }
        // 真实 git 端口：复用 engine/git.ts 的 GitRepo（URL 校验 / 凭据卫生 / fetch）。
        const git = new GitRepoV2Port({
            dir: this.repoDir,
            repoUrl: config.repoUrl,
            branch: 'main',
            authMode: config.authMode,
            token: this.settings.readToken(),
            platform: config.platform,
            username: config.username,
            allowLocalRepo: this.allowLocalRepo,
        });
        const entries = await this.outbox.load();
        const days = [...new Set(entries.map((entry) => entry.date))].sort();
        if (days.length === 0) {
            const status = {
                ...base, ok: true, code: 'ok', message: '迁移门禁通过，暂无待同步意图', migrated: true, synced: true,
            };
            this.lastStatus = status;
            return status;
        }
        const cycle = await this.runCycle(days, git);
        const status = {
            ...base, ok: cycle.ok, code: cycle.code, message: cycle.message,
            migrated: true, synced: cycle.ok, cycle,
        };
        this.lastStatus = status;
        return status;
    }
    /** 供运维 / 后续 RPC 显式触发周期（本模块不注册新工具，接线留给下一模块）。 */
    async syncNow(days) {
        const config = this.settings.readSettings();
        if (config.repoUrl.trim() === '')
            throw new SyncError('E_UNCONFIGURED', '尚未配置仓库地址');
        const git = new GitRepoV2Port({
            dir: this.repoDir, repoUrl: config.repoUrl, branch: 'main', authMode: config.authMode,
            token: this.settings.readToken(), platform: config.platform, username: config.username,
            allowLocalRepo: this.allowLocalRepo,
        });
        return await this.runCycle(days, git);
    }
    get status() {
        return this.lastStatus;
    }
}
/**
 * 从 `apply()` 调用的挂载函数：fire-and-forget，失败只写 lastStatus，
 * 绝不让 v2 半侧影响配置同步 RPC 与 v1 日程工具的启动。
 */
export function mountV2Sync(ctx, options = {}, registerEffect = true) {
    // 宿主 logger 可选：工作根那一行只交给它，绝不直接写 stdout（凭据卫生守卫）。
    const runtime = new V2SyncRuntime({
        ...options,
        logger: options.logger ?? ctx.logger,
    });
    if (registerEffect) {
        ctx.effect(() => {
            void runtime.start().catch(() => undefined);
            return () => undefined;
        }, 'dsh-dots: v2 sync migration gate');
    }
    else {
        // 运行时不持有任何需要卸载的句柄：直接异步启动，不新增 ctx.effect，
        // 保持插件既有的 effect 数量契约（既有测试钉死 5/9），startup 失败只写 lastStatus。
        void runtime.start().catch(() => undefined);
    }
    return runtime;
}
