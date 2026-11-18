#!/usr/bin/env node
/**
 * 装机前 pre-flight（三条判据，全部机器可读）。
 *
 * 为什么需要它：2026-11-15 的事故是「旧 HAP + 没还原的 overlay + 全绿源码测试」被当成验证通过。
 * 设备不在线（`hdc list targets` = `[Empty]`）时也必须能自检，所以本脚本**不碰设备、不构建**，
 * 只回答三个问题：
 *
 *   1. overlay 已还原？   跑 tools/overlay.mjs status；`applied=true` → FAIL（给出修复命令）。
 *   2. HAP 比源码新？     HAP 的 mtime 必须 > `git log -1 --format=%cI -- entry AppScope packages/`
 *                         的时间；相等也算旧（同一次提交的产物说明没重建）。仓库里没有 HAP → FAIL。
 *                         注意路径集**不含 docs/tools**，否则改一行文档就误报。
 *   3. SHA256 清单核对？  优先 `dist-<时间戳>/SHA256SUMS.txt`（tools/pack-dist.mjs 生成，
 *                         `<sha256>  <bytes>  <mtime ISO>  <path>`），也兼容 `sha256sum` 的
 *                         `<sha256>  <path>`；逐条核对，不符即 FAIL。没有清单 → 打印
 *                         `unverified-sha` 并继续（**不伪造清单、不伪造哈希**，也不因此变红）。
 *
 * 输出契约（每项一行，失败时随后缩进给出修复提示）：
 *   [preflight] overlay=ok applied=false
 *   [preflight] hap-fresh=ok hap=<rel> hapMtime=<ISO> source=<ISO>
 *   [preflight] sha=unverified-sha（没有清单，继续）
 *   [preflight] pass=2 fail=0 unverified=1 → exit 0
 *
 * 退出码：0 = 无 FAIL；1 = 有 FAIL；2 = 参数/环境错误（git 不可用、--manifest 不存在等）。
 *
 * 用法：
 *   node apps/arkui-schedule/tools/preflight.mjs
 *   node apps/arkui-schedule/tools/preflight.mjs --hap <path> --manifest <path>
 *
 * 纯逻辑（compareHapFreshness / verifyShaManifest / gradeChecks ...）全部具名导出，
 * `import` 本模块不跑任何检查（见 docs/PREFLIGHT.md）。
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** `apps/arkui-schedule`。 */
export const APP_ROOT = path.resolve(HERE, '..')
/** 仓库根（`apps/arkui-schedule` 上两级）。 */
export const REPO_ROOT = path.resolve(APP_ROOT, '..', '..')

/**
 * 「源码最后提交时间」的路径集。**故意不含** docs/ 与 tools/：
 * 改文档/工具脚本不会改变产物，算进去只会天天误报「HAP 过期」。
 */
export const SOURCE_PATHS = ['apps/arkui-schedule/entry', 'apps/arkui-schedule/AppScope', 'packages/']

const HAP_SCAN_DIRS = ['apps/arkui-schedule/entry/build', 'apps/arkui-schedule/dist-harmony']
const MANIFEST_NAMES = ['SHA256SUMS.txt', 'SHA256SUMS']
const SKIP_DIRS = new Set(['node_modules', '.git', '.hvigor', '.idea', 'cache', 'oh_modules'])
const BUILD_HARMONY_CMD = 'node apps/arkui-schedule/tools/build-harmony.ps1'
const OVERLAY_RESTORE_CMD = 'node apps/arkui-schedule/tools/overlay.mjs restore'

// ---------------------------------------------------------------- 小工具

const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key)

/** 仓库内绝对路径 → 相对仓库根的 POSIX 路径（已经是相对路径就原样返回）。 */
function toDisplay(repoRoot, file) {
  if (typeof file !== 'string') {
    return String(file)
  }
  const rel = path.isAbsolute(file) ? path.relative(repoRoot, file) : file
  return rel.split(path.sep).join('/')
}

function oneLine(text, limit = 200) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)
}

function iso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : 'unknown'
}

/** 递归收集满足 filter 的文件（跳过构建缓存等目录，深度上限 12）。 */
function walkFiles(dir, filter, out = [], depth = 0) {
  if (depth > 12 || !existsSync(dir)) {
    return out
  }
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        walkFiles(full, filter, out, depth + 1)
      }
    } else if (entry.isFile() && filter(entry.name, full)) {
      out.push(full)
    }
  }
  return out
}

// ---------------------------------------------------------------- 判据 1：overlay

/**
 * 解析 `overlay.mjs status` 的输出。
 * @param {string} text 合并后的 stdout
 * @returns {{ applied: boolean|null, status: 'clean'|'applied'|'unknown' }}
 */
export function parseOverlayStatus(text) {
  const body = String(text ?? '')
  if (/\[overlay\]\s+applied=true/.test(body)) {
    return { applied: true, status: 'applied' }
  }
  if (/\[overlay\]\s+applied=false/.test(body)) {
    return { applied: false, status: 'clean' }
  }
  return { applied: null, status: 'unknown' }
}

/**
 * 判据 1：覆盖层必须已还原。
 * `applied=true` → fail；取不到状态（unknown）同样 fail —— 无法证明「已还原」就不算通过。
 * @param {string} statusText `overlay.mjs status` 的 stdout
 * @param {string|null} [error] 调用失败时的错误摘要
 */
export function checkOverlay(statusText, error = null) {
  const parsed = parseOverlayStatus(statusText)
  if (parsed.status === 'clean') {
    return { id: 'overlay', status: 'ok', line: '[preflight] overlay=ok applied=false', hints: [] }
  }
  if (parsed.status === 'applied') {
    return {
      id: 'overlay',
      status: 'fail',
      line: '[preflight] overlay=fail applied=true',
      hints: [
        '覆盖层没有还原：工作区现在是「harmony 覆盖到 main」的污染形态，源码测试会读到错的树。',
        `修复：${OVERLAY_RESTORE_CMD}（然后 status 必须打印 applied=false）`,
      ],
    }
  }
  return {
    id: 'overlay',
    status: 'fail',
    line: '[preflight] overlay=fail applied=unknown',
    hints: [`取不到 overlay 状态${error ? `（${error}）` : ''}：node apps/arkui-schedule/tools/overlay.mjs status 失败`],
  }
}

// ---------------------------------------------------------------- 判据 2：HAP 新鲜度

/**
 * 比较 HAP 的 mtime 与「源码最后提交时间」。
 * 必须**严格新于**源码提交：相等说明产物是同一次提交前后生成的，无法证明它包含该提交。
 * @param {number|null} hapMtimeMs HAP 的 mtime（epoch ms）；null = 仓库里没有 HAP
 * @param {number} sourceCommitMs `git log -1 --format=%cI` 的时间（epoch ms）
 * @returns {{ ok: boolean, reason: 'fresh'|'stale'|'missing-hap', deltaMs: number|null, message?: string }}
 */
export function compareHapFreshness(hapMtimeMs, sourceCommitMs) {
  if (hapMtimeMs === null || hapMtimeMs === undefined || !Number.isFinite(Number(hapMtimeMs))) {
    return {
      ok: false,
      reason: 'missing-hap',
      deltaMs: null,
      message: `仓库里找不到 HAP：先跑 build-harmony（${BUILD_HARMONY_CMD}）`,
    }
  }
  const source = Number(sourceCommitMs)
  if (sourceCommitMs === null || sourceCommitMs === undefined || !Number.isFinite(source)) {
    return { ok: false, reason: 'unknown-source', deltaMs: null, message: '取不到源码最后提交时间，无法判断产物是否过期' }
  }
  const deltaMs = Number(hapMtimeMs) - source
  if (deltaMs > 0) {
    return { ok: true, reason: 'fresh', deltaMs }
  }
  const seconds = Math.max(1, Math.round(-deltaMs / 1000))
  return {
    ok: false,
    reason: 'stale',
    deltaMs,
    message:
      `HAP 比源码最后提交旧 ${seconds}s（产物没跟上源码），需要重新构建：${BUILD_HARMONY_CMD}` +
      `，然后重跑 sign-hap / pack-dist`,
  }
}

/**
 * 判据 2 的组装：产出机器可读行 + 修复提示。
 * @param {{path: string, mtimeMs: number}|null} hap 最新 HAP
 * @param {{ms: number|null, error: string|null}} commit 源码提交时间
 * @param {string} [repoRoot] 用于把 HAP 路径显示成相对路径
 */
export function checkHapFreshness(hap, commit, repoRoot = REPO_ROOT) {
  const commitMs = commit === null || commit === undefined ? null : commit.ms
  if (commitMs === null || commitMs === undefined || !Number.isFinite(commitMs)) {
    return {
      id: 'hap-fresh',
      status: 'error',
      line: '[preflight] hap-fresh=error source=unknown',
      hints: [`无法取源码最后提交时间（${oneLine(commit?.error ?? 'git 不可用或该路径没有提交')}）`],
    }
  }
  const sourceIso = iso(commitMs)
  const verdict = compareHapFreshness(hap === null || hap === undefined ? null : hap.mtimeMs, commitMs)
  if (hap === null || hap === undefined) {
    return {
      id: 'hap-fresh',
      status: 'fail',
      line: `[preflight] hap-fresh=fail hap=none source=${sourceIso}`,
      hints: [verdict.message],
    }
  }
  const shown = toDisplay(repoRoot, hap.path)
  const head = `hap=${shown} hapMtime=${iso(hap.mtimeMs)} source=${sourceIso}`
  if (verdict.ok) {
    return { id: 'hap-fresh', status: 'ok', line: `[preflight] hap-fresh=ok ${head}`, hints: [] }
  }
  return { id: 'hap-fresh', status: 'fail', line: `[preflight] hap-fresh=fail ${head}`, hints: [verdict.message] }
}

/** 收集仓库里所有候选 HAP（构建产物 / dist-harmony / dist-* 交付包），按 mtime 降序。 */
export function findHaps(repoRoot = REPO_ROOT) {
  const files = []
  for (const rel of HAP_SCAN_DIRS) {
    walkFiles(path.join(repoRoot, rel), (name) => name.toLowerCase().endsWith('.hap'), files)
  }
  let rootEntries = []
  try {
    rootEntries = readdirSync(repoRoot, { withFileTypes: true })
  } catch {
    rootEntries = []
  }
  for (const entry of rootEntries) {
    if (entry.isDirectory() && /^dist-/.test(entry.name)) {
      walkFiles(path.join(repoRoot, entry.name), (name) => name.toLowerCase().endsWith('.hap'), files, 1)
    }
  }
  const haps = []
  for (const file of new Set(files)) {
    try {
      const stat = statSync(file)
      // depth 只用于「mtime 相同时」的稳定排序：浅路径优先（outputs/ 根上的包比 app/ 子包更像装机对象）
      haps.push({ path: file, mtimeMs: stat.mtimeMs, size: stat.size, depth: file.split(path.sep).length })
    } catch {
      // 读不到就跳过：不存在比读不到更明确
    }
  }
  return haps.sort((a, b) => b.mtimeMs - a.mtimeMs || a.depth - b.depth || a.path.localeCompare(b.path))
}

/** 仓库里最新的 HAP（= 最可能被装机的那份）；没有则 null。 */
export function newestHap(repoRoot = REPO_ROOT) {
  return findHaps(repoRoot)[0] ?? null
}

// ---------------------------------------------------------------- 判据 3：SHA256 清单

/**
 * 解析 SHA256 清单。兼容两种行格式：
 *   `<sha256>  <path>`                       —— `sha256sum` 原生格式
 *   `<sha256>  <bytes>  <mtime ISO>  <path>`  —— tools/pack-dist.mjs 的 dist-<时间戳>/SHA256SUMS.txt
 * 空行与 `#` 注释被忽略；无法识别的行进 skipped（不参与判定）。
 * @param {string} manifestText
 * @returns {Array<{name: string, expected: string, bytes: number|null, mtime: string|null}>}
 */
export function parseShaManifest(manifestText) {
  const entries = []
  for (const rawLine of String(manifestText ?? '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) {
      continue
    }
    const match = /^([0-9a-fA-F]{64})(?:\s+(.*))?$/.exec(line)
    if (match === null) {
      continue
    }
    let rest = (match[2] ?? '').trim()
    if (rest === '') {
      continue
    }
    let bytes = null
    let mtime = null
    const meta = /^(\d+)\s+(\d{4}-\d{2}-\d{2}T[0-9:.]+Z?)\s+(.+)$/.exec(rest)
    if (meta !== null) {
      bytes = Number(meta[1])
      mtime = meta[2]
      rest = meta[3]
    }
    const name = rest.replace(/^\*/, '').replace(/^\.\//, '').trim()
    if (name === '') {
      continue
    }
    entries.push({ name, expected: match[1].toLowerCase(), bytes, mtime })
  }
  return entries
}

/**
 * 逐条核对清单。
 * `manifestText` 为空/null → `unverified`（不伪造清单、也不因此判 FAIL）。
 * @param {string|null|undefined} manifestText
 * @param {(name: string) => Buffer|string|null} readFile 读取清单同目录下的文件；缺失返回 null
 * @returns {{ status: 'ok'|'fail'|'unverified', entries: Array<object>, mismatches: Array<object>, reason?: string }}
 */
export function verifyShaManifest(manifestText, readFile) {
  if (typeof readFile !== 'function') {
    throw new TypeError('verifyShaManifest 需要 readFile 回调（name => Buffer|string|null）')
  }
  const text = manifestText === null || manifestText === undefined ? '' : String(manifestText)
  const entries = parseShaManifest(text)
  if (text.trim() === '' || entries.length === 0) {
    return {
      status: 'unverified',
      entries: [],
      mismatches: [],
      reason: text.trim() === '' ? 'no-manifest' : 'no-entries',
    }
  }
  const results = []
  const mismatches = []
  for (const entry of entries) {
    let data = null
    let readError = null
    try {
      data = readFile(entry.name)
    } catch (error) {
      readError = oneLine(error?.message ?? error)
    }
    if (data === null || data === undefined) {
      const item = {
        name: entry.name,
        expected: entry.expected,
        actual: null,
        ok: false,
        reason: readError === null ? 'missing' : 'unreadable',
        error: readError,
      }
      results.push(item)
      mismatches.push(item)
      continue
    }
    const actual = createHash('sha256').update(data).digest('hex')
    const ok = actual === entry.expected
    const item = { name: entry.name, expected: entry.expected, actual, ok, reason: ok ? 'match' : 'hash' }
    results.push(item)
    if (!ok) {
      mismatches.push(item)
    }
  }
  return { status: mismatches.length === 0 ? 'ok' : 'fail', entries: results, mismatches }
}

/**
 * 判据 3 的组装。
 * @param {{path: string, text: string}|null} manifest 清单（path 用于展示）
 * @param {(name: string) => Buffer|string|null} readFile
 */
export function checkSha(manifest, readFile) {
  if (manifest === null || manifest === undefined) {
    return {
      id: 'sha',
      status: 'unverified',
      line: '[preflight] sha=unverified-sha（没有清单，继续）',
      hints: [],
    }
  }
  const result = verifyShaManifest(manifest.text, readFile)
  const shown = manifest.path ?? '(inline)'
  if (result.status === 'unverified') {
    return {
      id: 'sha',
      status: 'unverified',
      line: `[preflight] sha=unverified-sha（清单 ${shown} 里没有可核对条目，继续）`,
      hints: [],
    }
  }
  if (result.status === 'ok') {
    return {
      id: 'sha',
      status: 'ok',
      line: `[preflight] sha=ok manifest=${shown} entries=${result.entries.length}`,
      hints: [],
    }
  }
  const names = result.mismatches.map((item) => item.name)
  const shownNames = names.length <= 3 ? names.join(',') : `${names.slice(0, 3).join(',')},+${names.length - 3}`
  return {
    id: 'sha',
    status: 'fail',
    line: `[preflight] sha=fail manifest=${shown} mismatch=${result.mismatches.length} files=${shownNames}`,
    hints: result.mismatches.map((item) =>
      item.reason === 'missing'
        ? `清单条目缺失：${item.name}（清单目录下没有这个文件）`
        : item.reason === 'unreadable'
          ? `清单条目读不了：${item.name}（${item.error}）`
          : `哈希不符：${item.name} 期望 ${item.expected} 实际 ${item.actual}`
    ),
  }
}

/** 找现有清单：最新 `dist-<时间戳>/SHA256SUMS.txt` 优先，其次 dist-harmony，最后构建产物目录。 */
export function findShaManifest(repoRoot = REPO_ROOT) {
  const candidates = []
  let rootEntries = []
  try {
    rootEntries = readdirSync(repoRoot, { withFileTypes: true })
  } catch {
    rootEntries = []
  }
  const distDirs = rootEntries
    .filter((entry) => entry.isDirectory() && /^dist-/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse()
  for (const dir of distDirs) {
    for (const name of MANIFEST_NAMES) {
      candidates.push(path.join(repoRoot, dir, name))
    }
  }
  for (const name of MANIFEST_NAMES) {
    candidates.push(path.join(repoRoot, 'apps/arkui-schedule/dist-harmony', name))
  }
  candidates.push(
    ...walkFiles(
      path.join(repoRoot, 'apps/arkui-schedule/entry/build'),
      (name) => MANIFEST_NAMES.includes(name)
    )
  )
  return candidates.find((file) => existsSync(file)) ?? null
}

/** 读取清单为 `{ path, text }`（path 相对仓库根）；没有则 null。 */
export function loadShaManifest(repoRoot = REPO_ROOT) {
  const file = findShaManifest(repoRoot)
  if (file === null) {
    return null
  }
  try {
    return { path: toDisplay(repoRoot, file), text: readFileSync(file, 'utf8'), dir: path.dirname(file) }
  } catch {
    return null
  }
}

/** 清单同目录的文件读取器（缺失 → null）。 */
function manifestReader(dir) {
  return (name) => {
    const file = path.resolve(dir, name)
    if (!existsSync(file)) {
      return null
    }
    try {
      return readFileSync(file)
    } catch {
      return null
    }
  }
}

// ---------------------------------------------------------------- 汇总 / 退出码

/**
 * 汇总三条检查 → pass/fail/unverified 计数 + 退出码。
 * 退出码优先级：环境错误(2) > 有 FAIL(1) > 0。
 * @param {Array<{status: string}>} results
 * @returns {{ pass: number, fail: number, unverified: number, error: number, total: number, exitCode: number }}
 */
export function gradeChecks(results) {
  const list = Array.isArray(results) ? results : []
  let pass = 0
  let fail = 0
  let unverified = 0
  let error = 0
  for (const item of list) {
    const status = item === null || item === undefined ? undefined : item.status
    if (status === 'ok') {
      pass++
    } else if (status === 'unverified') {
      unverified++
    } else if (status === 'error') {
      error++
    } else {
      fail++
    }
  }
  const exitCode = error > 0 ? 2 : fail > 0 ? 1 : 0
  return { pass, fail, unverified, error, total: list.length, exitCode }
}

/** `[preflight] pass=2 fail=0 unverified=1 → exit 0` */
export function formatSummaryLine(grade) {
  return `[preflight] pass=${grade.pass} fail=${grade.fail} unverified=${grade.unverified} → exit ${grade.exitCode}`
}

// ---------------------------------------------------------------- 真实数据源

/** 跑 `overlay.mjs status`（只读；绝不 apply）。返回 { text, error }，不抛异常。 */
export function readOverlayStatusText(appRoot = APP_ROOT) {
  const tool = path.join(appRoot, 'tools', 'overlay.mjs')
  if (!existsSync(tool)) {
    return { text: '', error: `找不到 ${toDisplay(REPO_ROOT, tool)}` }
  }
  try {
    const text = execFileSync(process.execPath, [tool, 'status'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000,
    })
    return { text, error: null }
  } catch (error) {
    const stderr = typeof error?.stderr === 'string' ? error.stderr : ''
    return { text: '', error: oneLine(stderr || error?.message || error) }
  }
}

/**
 * `git log -1 --format=%cI -- <SOURCE_PATHS>` → 源码最后提交时间。
 * 返回 { ms, error }，不抛异常（git 不可用 = 环境错误 → 退出码 2）。
 */
export function readSourceCommitMs(repoRoot = REPO_ROOT, paths = SOURCE_PATHS) {
  try {
    const out = execFileSync('git', ['-C', repoRoot, 'log', '-1', '--format=%cI', '--', ...paths], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000,
    }).trim()
    if (out === '') {
      return { ms: null, error: 'no-source-commit（该路径集没有任何提交）' }
    }
    const ms = Date.parse(out)
    if (!Number.isFinite(ms)) {
      return { ms: null, error: `无法解析提交时间：${oneLine(out)}` }
    }
    return { ms, error: null, iso: out }
  } catch (error) {
    const stderr = typeof error?.stderr === 'string' ? error.stderr : ''
    return { ms: null, error: `git 不可用：${oneLine(stderr || error?.message || error)}` }
  }
}

// ---------------------------------------------------------------- 编排

/**
 * 跑三条检查并生成完整输出。
 *
 * 可注入（测试用，全部可选）：`repoRoot`、`appRoot`、`overlayStatusText`、`sourceCommitMs`、
 * `hap`（`{path, mtimeMs}` 或 null）、`manifest`（`{path, text, dir?}` 或 null）、`readFile`。
 * 未注入的项走真实数据源（读 fs / 跑 git / 跑 overlay status）。
 *
 * @returns {{ checks: Array<object>, grade: object, lines: string[] }}
 */
export function runPreflight(options = {}) {
  const repoRoot = options.repoRoot ?? REPO_ROOT
  const appRoot = options.appRoot ?? path.join(repoRoot, 'apps', 'arkui-schedule')

  const overlay = has(options, 'overlayStatusText')
    ? checkOverlay(options.overlayStatusText, options.overlayStatusError ?? null)
    : (() => {
        const status = readOverlayStatusText(appRoot)
        return checkOverlay(status.text, status.error)
      })()

  const commit = has(options, 'sourceCommitMs')
    ? { ms: options.sourceCommitMs, error: options.sourceCommitError ?? null }
    : readSourceCommitMs(repoRoot)
  const hap = has(options, 'hap') ? options.hap : newestHap(repoRoot)
  const hapFresh = checkHapFreshness(hap, commit, repoRoot)

  const manifest = has(options, 'manifest') ? options.manifest : loadShaManifest(repoRoot)
  const readFile =
    options.readFile ?? (manifest === null || manifest === undefined ? () => null : manifestReader(manifest.dir ?? path.dirname(manifest.path)))
  const sha = checkSha(manifest, readFile)

  const checks = [overlay, hapFresh, sha]
  const grade = gradeChecks(checks)
  const lines = []
  for (const check of checks) {
    lines.push(check.line)
    for (const hint of check.hints ?? []) {
      lines.push(`[preflight]   ${hint}`)
    }
  }
  lines.push(formatSummaryLine(grade))
  return { checks, grade, lines }
}

// ---------------------------------------------------------------- CLI

const USAGE = [
  '用法：node apps/arkui-schedule/tools/preflight.mjs [--hap <path>] [--manifest <path>] [--root <dir>]',
  '',
  '  --hap <path>       指定要判定的 HAP（默认：仓库里 mtime 最新的 HAP）',
  '  --manifest <path>  指定 SHA256 清单（默认：最新 dist-*/SHA256SUMS.txt）',
  '  --root <dir>       仓库根（默认：本文件上两级）',
  '',
  '退出码：0 无 FAIL / 1 有 FAIL / 2 参数或环境错误',
].join('\n')

function parseArgs(argv) {
  const options = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${arg} 需要一个参数`)
      }
      i++
      return value
    }
    if (arg === '--hap') {
      const file = path.resolve(next())
      if (!existsSync(file)) {
        throw new Error(`--hap 指向的文件不存在：${file}`)
      }
      const stat = statSync(file)
      options.hap = { path: file, mtimeMs: stat.mtimeMs, size: stat.size }
    } else if (arg.startsWith('--hap=')) {
      const file = path.resolve(arg.slice('--hap='.length))
      if (!existsSync(file)) {
        throw new Error(`--hap 指向的文件不存在：${file}`)
      }
      options.hap = { path: file, mtimeMs: statSync(file).mtimeMs }
    } else if (arg === '--manifest') {
      const file = path.resolve(next())
      if (!existsSync(file)) {
        throw new Error(`--manifest 指向的文件不存在：${file}`)
      }
      options.manifest = { path: file, text: readFileSync(file, 'utf8'), dir: path.dirname(file) }
    } else if (arg.startsWith('--manifest=')) {
      const file = path.resolve(arg.slice('--manifest='.length))
      if (!existsSync(file)) {
        throw new Error(`--manifest 指向的文件不存在：${file}`)
      }
      options.manifest = { path: file, text: readFileSync(file, 'utf8'), dir: path.dirname(file) }
    } else if (arg === '--root') {
      options.repoRoot = path.resolve(next())
    } else if (arg.startsWith('--root=')) {
      options.repoRoot = path.resolve(arg.slice('--root='.length))
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else {
      throw new Error(`未知参数：${arg}`)
    }
  }
  return options
}

/** CLI 主体：返回退出码（不直接 process.exit，方便测试）。 */
export function main(argv = process.argv.slice(2)) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    console.error(`[preflight] error=bad-args（${oneLine(error?.message ?? error)}）`)
    return 2
  }
  if (options.help) {
    console.log(USAGE)
    return 0
  }
  const report = runPreflight(options)
  for (const line of report.lines) {
    console.log(line)
  }
  return report.grade.exitCode
}

const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url

if (invokedDirectly) {
  process.exitCode = main()
}
