/**
 * tools/preflight.mjs 的单元测试。
 *
 * 硬约束（见 docs/PREFLIGHT.md）：
 *   - 不依赖真机、不依赖真实构建产物：全部用临时目录 + 假 mtime + 假清单文本；
 *   - 不跑 overlay apply、不跑 build-harmony、不跑 git（git 只出现在「环境错误」的注入分支里）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  checkHapFreshness,
  checkOverlay,
  compareHapFreshness,
  findHaps,
  findShaManifest,
  formatSummaryLine,
  gradeChecks,
  newestHap,
  parseOverlayStatus,
  parseShaManifest,
  runPreflight,
  verifyShaManifest,
} from '../preflight.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(HERE, '..', 'preflight.mjs')
const MODULE_URL = pathToFileURL(CLI).href

const T0 = Date.parse('2026-11-18T00:00:00.000Z')
const HOUR = 3600 * 1000

const sha256 = (text) => createHash('sha256').update(text).digest('hex')
const HELLO_SHA = sha256('hello')

/** 临时仓库根（用完删掉）。 */
function makeTempRepo(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'preflight-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

// ---------------------------------------------------------------- a) HAP 新鲜度

test('compareHapFreshness：HAP 比源码新 → ok', () => {
  const result = compareHapFreshness(T0 + HOUR, T0)
  assert.equal(result.ok, true)
  assert.equal(result.reason, 'fresh')
  assert.equal(result.deltaMs, HOUR)
})

test('compareHapFreshness：HAP 比源码旧 → fail 且原因含「需要重新构建」', () => {
  const result = compareHapFreshness(T0 - HOUR, T0)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'stale')
  assert.match(result.message, /需要重新构建/)
  assert.match(result.message, /build-harmony/)
})

test('compareHapFreshness：HAP 与源码同一时刻 → fail（相等不算新）', () => {
  const result = compareHapFreshness(T0, T0)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'stale')
})

test('compareHapFreshness：仓库里没有 HAP → fail 且提示先跑 build-harmony', () => {
  const result = compareHapFreshness(null, T0)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'missing-hap')
  assert.match(result.message, /先跑 build-harmony/)
})

test('checkHapFreshness：旧 HAP 的检查项为 fail，提示里写明需要重新构建', () => {
  const check = checkHapFreshness({ path: 'x.hap', mtimeMs: T0 - HOUR }, { ms: T0, error: null }, '/repo')
  assert.equal(check.status, 'fail')
  assert.match(check.line, /^\[preflight\] hap-fresh=fail hap=x\.hap /)
  assert.ok(check.hints.some((hint) => /需要重新构建/.test(hint)))
})

test('checkHapFreshness：新 HAP 的检查项为 ok，行内带 hap 与 source', () => {
  const check = checkHapFreshness({ path: 'x.hap', mtimeMs: T0 + HOUR }, { ms: T0, error: null }, '/repo')
  assert.equal(check.status, 'ok')
  assert.match(check.line, /^\[preflight\] hap-fresh=ok hap=x\.hap hapMtime=\S+ source=\S+$/)
})

test('checkHapFreshness：没有 HAP → fail 且 hap=none', () => {
  const check = checkHapFreshness(null, { ms: T0, error: null }, '/repo')
  assert.equal(check.status, 'fail')
  assert.match(check.line, /hap-fresh=fail hap=none /)
  assert.match(check.hints.join(' '), /build-harmony/)
})

test('findHaps/newestHap：临时仓库里按 mtime 取最新 HAP（不依赖真实产物）', (t) => {
  const repo = makeTempRepo(t)
  const outDir = path.join(repo, 'apps', 'arkui-schedule', 'entry', 'build', 'default', 'outputs', 'default')
  mkdirSync(outDir, { recursive: true })
  const oldHap = path.join(outDir, 'old.hap')
  const newHap = path.join(outDir, 'new.hap')
  writeFileSync(oldHap, 'old')
  writeFileSync(newHap, 'new')
  utimesSync(oldHap, new Date(T0), new Date(T0))
  utimesSync(newHap, new Date(T0 + 2 * HOUR), new Date(T0 + 2 * HOUR))

  const haps = findHaps(repo)
  assert.equal(haps.length, 2)
  assert.equal(path.basename(haps[0].path), 'new.hap')
  assert.equal(Math.round(haps[0].mtimeMs), T0 + 2 * HOUR)
  assert.equal(path.basename(newestHap(repo).path), 'new.hap')
})

test('findHaps/newestHap：没有产物 → 空数组 / null（交给 FAIL 分支）', (t) => {
  const repo = makeTempRepo(t)
  assert.deepEqual(findHaps(repo), [])
  assert.equal(newestHap(repo), null)
})

// ---------------------------------------------------------------- b) SHA256 清单

test('verifyShaManifest：清单命中 → ok', () => {
  const manifest = `${HELLO_SHA}  a.hap\n`
  const result = verifyShaManifest(manifest, (name) => (name === 'a.hap' ? Buffer.from('hello') : null))
  assert.equal(result.status, 'ok')
  assert.equal(result.entries.length, 1)
  assert.equal(result.entries[0].name, 'a.hap')
  assert.equal(result.mismatches.length, 0)
})

test('verifyShaManifest：一条哈希不符 → fail 且指出文件名', () => {
  const manifest = `${HELLO_SHA}  a.hap\n${'0'.repeat(64)}  b.hap\n`
  const result = verifyShaManifest(manifest, () => Buffer.from('hello'))
  assert.equal(result.status, 'fail')
  assert.equal(result.mismatches.length, 1)
  assert.equal(result.mismatches[0].name, 'b.hap')
  assert.match(result.mismatches[0].expected, /^0{64}$/)
  assert.equal(result.mismatches[0].actual, HELLO_SHA)
})

test('verifyShaManifest：清单条目在磁盘上缺失 → fail（reason=missing）', () => {
  const result = verifyShaManifest(`${HELLO_SHA}  gone.hap\n`, () => null)
  assert.equal(result.status, 'fail')
  assert.equal(result.mismatches[0].reason, 'missing')
})

test('verifyShaManifest：readFile 抛异常 → fail（reason=unreadable，不崩）', () => {
  const result = verifyShaManifest(`${HELLO_SHA}  locked.hap\n`, () => {
    throw new Error('EBUSY')
  })
  assert.equal(result.status, 'fail')
  assert.equal(result.mismatches[0].reason, 'unreadable')
})

test('verifyShaManifest：没有清单 → unverified（不伪造、不判 fail）', () => {
  for (const empty of [null, undefined, '', '   \n# only comments\n']) {
    const result = verifyShaManifest(empty, () => {
      throw new Error('不应该读文件')
    })
    assert.equal(result.status, 'unverified')
    assert.equal(result.mismatches.length, 0)
  }
})

test('parseShaManifest：兼容 pack-dist（bytes+mtime）与 sha256sum（纯 path）两种格式', () => {
  const text = [
    '# 注释行被忽略',
    `${HELLO_SHA}       22112  2026-11-17T23:15:58.104Z  REMOTE-ACCESS-OPTIONS.md`,
    `${'a'.repeat(64)}  entry-default-unsigned.hap`,
    `${'b'.repeat(64)} *signed.hap`,
    '不是清单的一行',
    '',
  ].join('\n')
  const entries = parseShaManifest(text)
  assert.equal(entries.length, 3)
  assert.equal(entries[0].name, 'REMOTE-ACCESS-OPTIONS.md')
  assert.equal(entries[0].bytes, 22112)
  assert.equal(entries[0].mtime, '2026-11-17T23:15:58.104Z')
  assert.equal(entries[1].name, 'entry-default-unsigned.hap')
  assert.equal(entries[1].bytes, null)
  assert.equal(entries[2].name, 'signed.hap')
})

test('checkSha：无清单 → unverified-sha 且不计入 fail', () => {
  const check = checkHapFreshness({ path: 'x.hap', mtimeMs: T0 + HOUR }, { ms: T0, error: null }, '/repo')
  const shaCheck = runPreflight({
    overlayStatusText: '[overlay] applied=false',
    sourceCommitMs: T0,
    hap: { path: 'x.hap', mtimeMs: T0 + HOUR },
    manifest: null,
  }).checks[2]
  assert.equal(check.status, 'ok')
  assert.equal(shaCheck.status, 'unverified')
  assert.equal(shaCheck.line, '[preflight] sha=unverified-sha（没有清单，继续）')
})

test('findShaManifest：临时仓库里能找到 dist-*/SHA256SUMS.txt', (t) => {
  const repo = makeTempRepo(t)
  assert.equal(findShaManifest(repo), null)
  const distDir = path.join(repo, 'dist-20261118-0836')
  mkdirSync(distDir, { recursive: true })
  const manifest = path.join(distDir, 'SHA256SUMS.txt')
  writeFileSync(manifest, `${HELLO_SHA}  a.hap\n`)
  assert.equal(findShaManifest(repo), manifest)
})

// ---------------------------------------------------------------- c) 退出码分级

test('gradeChecks：全 ok → exit 0', () => {
  const grade = gradeChecks([{ status: 'ok' }, { status: 'ok' }, { status: 'ok' }])
  assert.deepEqual(grade, { pass: 3, fail: 0, unverified: 0, error: 0, total: 3, exitCode: 0 })
})

test('gradeChecks：有 fail → exit 1', () => {
  const grade = gradeChecks([{ status: 'ok' }, { status: 'fail' }, { status: 'ok' }])
  assert.equal(grade.fail, 1)
  assert.equal(grade.exitCode, 1)
})

test('gradeChecks：unverified 不算 fail（exit 仍为 0）', () => {
  const grade = gradeChecks([{ status: 'ok' }, { status: 'ok' }, { status: 'unverified' }])
  assert.deepEqual(grade, { pass: 2, fail: 0, unverified: 1, error: 0, total: 3, exitCode: 0 })
  assert.equal(formatSummaryLine(grade), '[preflight] pass=2 fail=0 unverified=1 → exit 0')
})

test('gradeChecks：环境错误 → exit 2（优先于 fail）', () => {
  assert.equal(gradeChecks([{ status: 'error' }, { status: 'ok' }]).exitCode, 2)
  assert.equal(gradeChecks([{ status: 'error' }, { status: 'fail' }]).exitCode, 2)
})

test('runPreflight：全 ok + 无清单 → pass=2 fail=0 unverified=1 → exit 0', () => {
  const report = runPreflight({
    overlayStatusText: '[overlay] applied=false',
    sourceCommitMs: T0,
    hap: { path: 'x.hap', mtimeMs: T0 + HOUR },
    manifest: null,
  })
  assert.equal(report.grade.exitCode, 0)
  assert.equal(report.lines.at(-1), '[preflight] pass=2 fail=0 unverified=1 → exit 0')
  assert.deepEqual(report.lines.slice(0, 3), [
    '[preflight] overlay=ok applied=false',
    `[preflight] hap-fresh=ok hap=x.hap hapMtime=${new Date(T0 + HOUR).toISOString()} source=${new Date(T0).toISOString()}`,
    '[preflight] sha=unverified-sha（没有清单，继续）',
  ])
})

test('runPreflight：overlay applied=true → fail 且给出还原命令', () => {
  const report = runPreflight({
    overlayStatusText: '覆盖层：已应用\n[overlay] applied=true',
    sourceCommitMs: T0,
    hap: { path: 'x.hap', mtimeMs: T0 + HOUR },
    manifest: null,
  })
  assert.equal(report.grade.exitCode, 1)
  assert.equal(report.checks[0].status, 'fail')
  assert.match(report.checks[0].line, /overlay=fail applied=true/)
  assert.ok(report.checks[0].hints.some((hint) => /overlay\.mjs restore/.test(hint)))
})

test('runPreflight：overlay 取不到状态 → fail（不许当通过）', () => {
  const check = checkOverlay('', 'node 崩了')
  assert.equal(check.status, 'fail')
  assert.match(check.line, /applied=unknown/)
  assert.equal(parseOverlayStatus('[overlay] applied=false').status, 'clean')
  assert.equal(parseOverlayStatus('[overlay] applied=true').status, 'applied')
  assert.equal(parseOverlayStatus('覆盖层：未应用').status, 'unknown')
})

test('runPreflight：git 不可用 → 环境错误 exit 2', () => {
  const report = runPreflight({
    overlayStatusText: '[overlay] applied=false',
    sourceCommitMs: null,
    sourceCommitError: 'git 不可用：spawn git ENOENT',
    hap: { path: 'x.hap', mtimeMs: T0 + HOUR },
    manifest: null,
  })
  assert.equal(report.checks[1].status, 'error')
  assert.equal(report.grade.exitCode, 2)
  assert.equal(report.lines.at(-1), '[preflight] pass=1 fail=0 unverified=1 → exit 2')
})

test('runPreflight：清单哈希不符 → fail 且行内含文件名', () => {
  const report = runPreflight({
    overlayStatusText: '[overlay] applied=false',
    sourceCommitMs: T0,
    hap: { path: 'x.hap', mtimeMs: T0 + HOUR },
    manifest: { path: 'dist-x/SHA256SUMS.txt', text: `${'0'.repeat(64)}  bad.hap\n` },
    readFile: () => Buffer.from('hello'),
  })
  assert.equal(report.grade.exitCode, 1)
  const shaCheck = report.checks[2]
  assert.equal(shaCheck.status, 'fail')
  assert.match(shaCheck.line, /sha=fail /)
  assert.match(shaCheck.line, /bad\.hap/)
  assert.ok(shaCheck.hints.some((hint) => /哈希不符：bad\.hap/.test(hint)))
})

// ---------------------------------------------------------------- d) import 无副作用

test('import 本模块不跑任何检查（子进程 stdout 只有自己的标记）', () => {
  const child = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(MODULE_URL)}); console.log('imported-ok')`],
    { encoding: 'utf8' }
  )
  assert.equal(child.status, 0, child.stderr)
  assert.equal(child.stdout.trim(), 'imported-ok')
  assert.equal(child.stderr.trim(), '')
})

test('CLI 参数错误 → exit 2，且不跑任何检查', () => {
  const child = spawnSync(process.execPath, [CLI, '--nope'], { encoding: 'utf8' })
  assert.equal(child.status, 2)
  assert.equal(child.stdout.trim(), '')
  assert.match(child.stderr, /bad-args/)
})
