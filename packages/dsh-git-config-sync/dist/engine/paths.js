/**
 * 状态目录 / profile 目录解析，以及多处复用的 sha256 辅助。
 *
 * 目录约定（CONTRACT §2.1、DATA-CONTRACT §5）：
 *   %USERPROFILE%\.dsh\git-config-sync\{settings.json,credentials.json,work\,plugins.to-install.json}
 *   %USERPROFILE%\.dsh\vet\restore-snapshots\
 *   %USERPROFILE%\.dsh\profiles\web            （profile，默认写目标）
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
/**
 * 解析 DSH 主目录（`~/.dsh`）。
 * `homeDir` 给定时表示"用户主目录"，此时 `.dsh` 是其子目录（测试靠这个隔离）；
 * 未给定时优先 `DSH_HOME`，否则 `os.homedir()`。
 */
export function dshHome(homeDir) {
    if (homeDir !== undefined && homeDir.trim() !== '')
        return path.join(path.resolve(homeDir), '.dsh');
    const envHome = process.env.DSH_HOME;
    if (envHome !== undefined && envHome.trim() !== '')
        return path.resolve(envHome);
    return path.join(os.homedir(), '.dsh');
}
export function statePaths(homeDir) {
    const dsh = dshHome(homeDir);
    const root = path.join(dsh, 'git-config-sync');
    return {
        root,
        settingsFile: path.join(root, 'settings.json'),
        credentialsFile: path.join(root, 'credentials.json'),
        stateFile: path.join(root, 'state.json'),
        workRoot: path.join(root, 'work'),
        snapshotRoot: path.join(dsh, 'vet', 'restore-snapshots'),
        pendingFile: path.join(root, 'plugins.to-install.json'),
    };
}
/** profile 默认 `<.dsh>/profiles/web`，`DSH_PROFILE_DIR` 可覆盖（显式注入优先）。 */
export function resolveProfileDir(options = {}) {
    if (options.profileDir !== undefined && options.profileDir.trim() !== '')
        return path.resolve(options.profileDir);
    const envProfile = process.env.DSH_PROFILE_DIR;
    if (options.homeDir === undefined && envProfile !== undefined && envProfile.trim() !== '')
        return path.resolve(envProfile);
    return path.join(dshHome(options.homeDir), 'profiles', 'web');
}
/** 工作副本目录名：repoUrl 的 sha256 前 16 位。 */
export function repoHash(repoUrl) {
    return createHash('sha256').update(String(repoUrl).trim(), 'utf8').digest('hex').slice(0, 16);
}
export function workDirFor(paths, repoUrl) {
    return path.join(paths.workRoot, repoHash(repoUrl));
}
export function sha256Hex(input) {
    return createHash('sha256').update(input).digest('hex');
}
export function byteLength(input) {
    return Buffer.byteLength(input, 'utf8');
}
/** `YYYYMMDD-HHmmss`（本地时间），快照目录名要用。 */
export function timestampId(date) {
    const pad = (n) => String(n).padStart(2, '0');
    return (String(date.getFullYear()) +
        pad(date.getMonth() + 1) +
        pad(date.getDate()) +
        '-' +
        pad(date.getHours()) +
        pad(date.getMinutes()) +
        pad(date.getSeconds()));
}
/** 采集 manifest 时记录 DSH 版本：显式配置 > DSH_VERSION > safe-launch 状态 > 运行入口 package.json。 */
export function detectDshVersion(homeDir) {
    const envVersion = process.env.DSH_VERSION;
    if (envVersion !== undefined && envVersion.trim() !== '')
        return envVersion.trim();
    try {
        const lastGood = path.join(dshHome(homeDir), 'safe-launch', 'last-good.json');
        if (existsSync(lastGood)) {
            const parsed = JSON.parse(readFileSync(lastGood, 'utf8'));
            if (parsed !== null && typeof parsed === 'object') {
                const version = parsed.dshVersion;
                if (typeof version === 'string' && version !== '')
                    return version;
            }
        }
    }
    catch {
        /* 只读探测失败不影响同步 */
    }
    try {
        const entry = process.argv[1];
        if (entry !== undefined && entry !== '') {
            let dir = path.dirname(path.resolve(entry));
            for (let depth = 0; depth < 6; depth += 1) {
                const pkgFile = path.join(dir, 'package.json');
                if (existsSync(pkgFile)) {
                    const parsed = JSON.parse(readFileSync(pkgFile, 'utf8'));
                    if (parsed !== null && typeof parsed === 'object') {
                        const record = parsed;
                        const name = typeof record.name === 'string' ? record.name : '';
                        const version = typeof record.version === 'string' ? record.version : '';
                        if (version !== '' && /dsh/i.test(name))
                            return version;
                    }
                }
                const parent = path.dirname(dir);
                if (parent === dir)
                    break;
                dir = parent;
            }
        }
    }
    catch {
        /* 同上 */
    }
    return 'unknown';
}
