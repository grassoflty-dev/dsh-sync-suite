import { lstat, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
/** `mkdtemp` 用的前缀，也是本模块**唯一**认领的条目前缀。改动它必须同步 `engine/git.ts`。 */
export const ASKPASS_TEMP_PREFIX = 'dsh-gcs-askpass-';
/** 超龄阈值：1 小时（理由见文件头；必须大于任何可想象的 git 调用时长）。 */
export const ASKPASS_TEMP_MAX_AGE_MS = 60 * 60 * 1000;
/** 插件启动清理的开关变量：缺省真删 / `dry` 只统计 / `off` 关闭。 */
export const ASKPASS_SWEEP_ENV = 'DSH_DOTS_ASKPASS_SWEEP';
/**
 * 插件启动清理的计划：
 *   - `off` / `0` / `false` / `no` → `skip`（排障开关）；
 *   - `dry` → `dry`（只统计，配合汇报里的实测数字）；
 *   - 其它（含缺省）→ `live`；
 *   - 但**测试进程**（`NODE_TEST_CONTEXT` 非空）一律 `skip`：见文件头的测试进程保护。
 */
export function askpassStartupSweepPlan(env = process.env) {
    const raw = typeof env[ASKPASS_SWEEP_ENV] === 'string' ? env[ASKPASS_SWEEP_ENV].trim().toLowerCase() : '';
    if (raw === 'off' || raw === '0' || raw === 'false' || raw === 'no')
        return 'skip';
    const testContext = typeof env.NODE_TEST_CONTEXT === 'string' ? env.NODE_TEST_CONTEXT.trim() : '';
    if (testContext !== '')
        return 'skip';
    if (raw === 'dry')
        return 'dry';
    return 'live';
}
/**
 * 扫一遍 `tmpDir`，删掉「前缀匹配 + 是目录 + 不是链接 + mtime 早于 maxAgeMs」的条目。
 *
 * 永不 throw：任何单个条目的失败只让 `failed + 1`；`tmpDir` 不存在/不可读直接返回全 0。
 * `await` 它不是必须的（调用方 fire-and-forget 也能拿到结果），但返回结果永远可用。
 */
export async function sweepStaleAskpassDirs(options = {}) {
    const dryRun = options.dryRun === true;
    const tmpDir = typeof options.tmpDir === 'string' && options.tmpDir !== '' ? options.tmpDir : os.tmpdir();
    const maxAgeMs = typeof options.maxAgeMs === 'number' && Number.isFinite(options.maxAgeMs) && options.maxAgeMs > 0
        ? options.maxAgeMs
        : ASKPASS_TEMP_MAX_AGE_MS;
    const now = typeof options.now === 'number' && Number.isFinite(options.now) ? options.now : Date.now();
    const removeDir = options.removeImpl ??
        ((target) => rm(target, { recursive: true, force: true, maxRetries: 0 }));
    const result = {
        scanned: 0,
        removed: 0,
        failed: 0,
        wouldRemove: 0,
        dryRun,
        oldestMtimeMs: null,
        newestMtimeMs: null,
    };
    let names;
    try {
        names = await readdir(tmpDir);
    }
    catch {
        // 目录不存在 / 无权限：零工作量，静默（安全性质 5）。
        return result;
    }
    for (const name of names) {
        // 安全性质 1：只认自家前缀，别的什么名字都不看。
        if (!name.startsWith(ASKPASS_TEMP_PREFIX))
            continue;
        result.scanned += 1;
        const full = path.join(tmpDir, name);
        let stats;
        try {
            // lstat 不跟随链接：拿到的永远是条目本身（安全性质 3 的前半）。
            stats = await lstat(full);
        }
        catch {
            result.failed += 1;
            continue;
        }
        if (stats.isSymbolicLink())
            continue;
        if (!stats.isDirectory())
            continue;
        const mtimeMs = stats.mtimeMs;
        if (result.oldestMtimeMs === null || mtimeMs < result.oldestMtimeMs)
            result.oldestMtimeMs = mtimeMs;
        if (result.newestMtimeMs === null || mtimeMs > result.newestMtimeMs)
            result.newestMtimeMs = mtimeMs;
        if (now - mtimeMs <= maxAgeMs)
            continue;
        result.wouldRemove += 1;
        if (dryRun)
            continue;
        try {
            await removeDir(full);
            result.removed += 1;
        }
        catch {
            // 安全性质 4：删不掉不算错误，只记账（比如被另一进程占着、权限不足）。
            result.failed += 1;
        }
    }
    return result;
}
/** 插件启动用的一行封装：按计划真删 / 干跑 / 跳过，返回结果（跳过时全 0 且 `dryRun:true`）。 */
export async function sweepAskpassDirsAtStartup(env = process.env) {
    const plan = askpassStartupSweepPlan(env);
    if (plan === 'skip') {
        return {
            scanned: 0,
            removed: 0,
            failed: 0,
            wouldRemove: 0,
            dryRun: true,
            oldestMtimeMs: null,
            newestMtimeMs: null,
        };
    }
    return sweepStaleAskpassDirs({ dryRun: plan === 'dry' });
}
