/**
 * askpass 临时目录的**有界、尽力**清理（mod-plugin-askpass-temp-hygiene）。
 *
 * 背景：`GitRepo.ensureAskpass()` 用 `mkdtemp(path.join(os.tmpdir(), 'dsh-gcs-askpass-'))`
 * 建一个临时目录放 `askpass.{sh,cmd,mjs}`；`dispose()` 只删自己那一个。进程被杀、崩溃、
 * 断电、宿主强退都会留下一个 `%TEMP%\dsh-gcs-askpass-XXXXXX`。本机实测（2026-11-25）
 * 已累积 26 个（2026-11-22…25），而且还在增长。本模块只做一件事：**插件启动时**顺手把
 * 「超龄」的自家目录清掉。
 *
 * 【年龄阈值 = 1 小时，为什么是这个数】
 * 我方最长的 git 预算是 push 的 120 s（`PUSH_TIMEOUT_MS`），读命令 8 s、本进程首次读 20 s
 * （`FIRST_NETWORK_TIMEOUT_MS`）；再叠加 askpass / node 解释器冷启动（探针 2 s）与 Windows
 * 上"杀了 git 父进程、孙进程还多活几秒"的水位，单个 git 调用端到端最多也就几分钟量级。
 * 1 小时比这个量级大一个数量级以上，因此**任何活着的 git 子进程正在用的目录都不可能在
 * 删除窗口内**；反过来 1 小时又远小于"用户下次打开 DSH"的间隔，所以清理依然有效。
 * 不选更小的窗口（5/10 分钟）的原因：省不下多少磁盘，却会把"机器休眠后恢复的长时间推送"
 * 纳入删除范围，把一个安全的下界换成一个需要论证的下界，不划算。
 *
 * 【安全性质（每条都有用例，见 test/askpass-temp-hygiene.test.mjs）】
 *   1. 只认 basename 以本模块前缀 `dsh-gcs-askpass-` 开头的条目：其它前缀、以及 `%TEMP%`
 *      里的普通文件一律不动；
 *   2. 只删目录：`lstat` 判定不是目录（普通文件 / 其它类型）就跳过；
 *   3. 不跟随链接：`lstat().isSymbolicLink()` 为真的条目一律跳过（Windows 的 junction 在
 *      lstat 里同样表现为符号链接），因此绝不会顺着链接删到别处；
 *   4. 失败**静默但计数**：唯一出口是返回值 `{scanned, removed, failed}`，不 throw、
 *      不打日志（插件激活期不许有噪声，也不许因为一个删不掉的目录影响同步）；
 *   5. `%TEMP%` 不存在 / 不可读时零工作量（直接返回全 0，不 mkdir、不探测）。
 *
 * 【干跑（dry-run）：只测量，不删除】
 *   - 代码：`sweepStaleAskpassDirs({ dryRun: true })`，返回里 `wouldRemove` = "本会删除几个"，
 *     `removed` 恒为 0；
 *   - 插件：环境变量 `DSH_DOTS_ASKPASS_SWEEP=dry` 让插件启动时的清理只统计不删除；
 *     `DSH_DOTS_ASKPASS_SWEEP=off`（也接受 `0` / `false` / `no`）彻底关闭，排障用；
 *     缺省 = 真删。
 *
 * 【测试进程保护】
 * `node --test` 会给每个测试子进程设置 `NODE_TEST_CONTEXT`。存在该变量时插件启动清理一律
 * 跳过：测试纪律要求删除只发生在 `.tmp/` 夹具里，绝不允许跑一次测试就把用户真实 `%TEMP%`
 * 里的东西删掉。判定集中在 `askpassStartupSweepPlan()` 里，可单测；`sweepStaleAskpassDirs()`
 * 本身不读环境变量，所以测量与单测永远能精确控制输入。
 */
import type { Stats } from 'node:fs'
import { lstat, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** `mkdtemp` 用的前缀，也是本模块**唯一**认领的条目前缀。改动它必须同步 `engine/git.ts`。 */
export const ASKPASS_TEMP_PREFIX = 'dsh-gcs-askpass-'

/** 超龄阈值：1 小时（理由见文件头；必须大于任何可想象的 git 调用时长）。 */
export const ASKPASS_TEMP_MAX_AGE_MS = 60 * 60 * 1000

/** 插件启动清理的开关变量：缺省真删 / `dry` 只统计 / `off` 关闭。 */
export const ASKPASS_SWEEP_ENV = 'DSH_DOTS_ASKPASS_SWEEP'

/** 插件启动时到底做什么（`skip` 也包含"这是测试进程"）。 */
export type AskpassStartupSweepPlan = 'live' | 'dry' | 'skip'

/**
 * 一次清理的结果。字段语义（口径固定，测试逐字断言）：
 *   - `scanned`：**前缀匹配**到的条目数（不是 `%TEMP%` 里的总条目数）；
 *   - `removed`：真正删掉的目录数；
 *   - `failed`：`lstat` 或删除失败的条目数（静默计数，不抛错）；
 *   - `wouldRemove`：mtime 超龄的目录数（干跑与真删都填，干跑时 `removed` 恒为 0）；
 *   - `oldestMtimeMs` / `newestMtimeMs`：被检查的**目录**里最旧 / 最新的 mtime（没有则 null）。
 */
export interface AskpassSweepResult {
  scanned: number
  removed: number
  failed: number
  wouldRemove: number
  dryRun: boolean
  oldestMtimeMs: number | null
  newestMtimeMs: number | null
}

export interface AskpassSweepOptions {
  /** true = 只统计不删除（测量用）。 */
  dryRun?: boolean
  /** 默认 `os.tmpdir()`；测试注入 `.tmp/` 夹具目录。 */
  tmpDir?: string
  /** 默认 `ASKPASS_TEMP_MAX_AGE_MS`（1 小时）；仅测试注入更小的值。 */
  maxAgeMs?: number
  /** 默认 `Date.now()`；仅测试注入固定时刻。 */
  now?: number
  /** 仅测试：替换删除实现，用来验证"失败静默但计数"。 */
  removeImpl?: (target: string) => Promise<void>
}

/**
 * 插件启动清理的计划：
 *   - `off` / `0` / `false` / `no` → `skip`（排障开关）；
 *   - `dry` → `dry`（只统计，配合汇报里的实测数字）；
 *   - 其它（含缺省）→ `live`；
 *   - 但**测试进程**（`NODE_TEST_CONTEXT` 非空）一律 `skip`：见文件头的测试进程保护。
 */
export function askpassStartupSweepPlan(env: NodeJS.ProcessEnv = process.env): AskpassStartupSweepPlan {
  const raw = typeof env[ASKPASS_SWEEP_ENV] === 'string' ? env[ASKPASS_SWEEP_ENV].trim().toLowerCase() : ''
  if (raw === 'off' || raw === '0' || raw === 'false' || raw === 'no') return 'skip'
  const testContext = typeof env.NODE_TEST_CONTEXT === 'string' ? env.NODE_TEST_CONTEXT.trim() : ''
  if (testContext !== '') return 'skip'
  if (raw === 'dry') return 'dry'
  return 'live'
}

/**
 * 扫一遍 `tmpDir`，删掉「前缀匹配 + 是目录 + 不是链接 + mtime 早于 maxAgeMs」的条目。
 *
 * 永不 throw：任何单个条目的失败只让 `failed + 1`；`tmpDir` 不存在/不可读直接返回全 0。
 * `await` 它不是必须的（调用方 fire-and-forget 也能拿到结果），但返回结果永远可用。
 */
export async function sweepStaleAskpassDirs(options: AskpassSweepOptions = {}): Promise<AskpassSweepResult> {
  const dryRun = options.dryRun === true
  const tmpDir = typeof options.tmpDir === 'string' && options.tmpDir !== '' ? options.tmpDir : os.tmpdir()
  const maxAgeMs =
    typeof options.maxAgeMs === 'number' && Number.isFinite(options.maxAgeMs) && options.maxAgeMs > 0
      ? options.maxAgeMs
      : ASKPASS_TEMP_MAX_AGE_MS
  const now = typeof options.now === 'number' && Number.isFinite(options.now) ? options.now : Date.now()
  const removeDir =
    options.removeImpl ??
    ((target: string): Promise<void> => rm(target, { recursive: true, force: true, maxRetries: 0 }))

  const result: AskpassSweepResult = {
    scanned: 0,
    removed: 0,
    failed: 0,
    wouldRemove: 0,
    dryRun,
    oldestMtimeMs: null,
    newestMtimeMs: null,
  }

  let names: string[]
  try {
    names = await readdir(tmpDir)
  } catch {
    // 目录不存在 / 无权限：零工作量，静默（安全性质 5）。
    return result
  }

  for (const name of names) {
    // 安全性质 1：只认自家前缀，别的什么名字都不看。
    if (!name.startsWith(ASKPASS_TEMP_PREFIX)) continue
    result.scanned += 1
    const full = path.join(tmpDir, name)
    let stats: Stats
    try {
      // lstat 不跟随链接：拿到的永远是条目本身（安全性质 3 的前半）。
      stats = await lstat(full)
    } catch {
      result.failed += 1
      continue
    }
    if (stats.isSymbolicLink()) continue
    if (!stats.isDirectory()) continue
    const mtimeMs = stats.mtimeMs
    if (result.oldestMtimeMs === null || mtimeMs < result.oldestMtimeMs) result.oldestMtimeMs = mtimeMs
    if (result.newestMtimeMs === null || mtimeMs > result.newestMtimeMs) result.newestMtimeMs = mtimeMs
    if (now - mtimeMs <= maxAgeMs) continue
    result.wouldRemove += 1
    if (dryRun) continue
    try {
      await removeDir(full)
      result.removed += 1
    } catch {
      // 安全性质 4：删不掉不算错误，只记账（比如被另一进程占着、权限不足）。
      result.failed += 1
    }
  }
  return result
}

/** 插件启动用的一行封装：按计划真删 / 干跑 / 跳过，返回结果（跳过时全 0 且 `dryRun:true`）。 */
export async function sweepAskpassDirsAtStartup(
  env: NodeJS.ProcessEnv = process.env,
): Promise<AskpassSweepResult> {
  const plan = askpassStartupSweepPlan(env)
  if (plan === 'skip') {
    return {
      scanned: 0,
      removed: 0,
      failed: 0,
      wouldRemove: 0,
      dryRun: true,
      oldestMtimeMs: null,
      newestMtimeMs: null,
    }
  }
  return sweepStaleAskpassDirs({ dryRun: plan === 'dry' })
}
