/**
 * mod-build-restore-timeout — post-build overlay restore must never hang silently.
 *
 * Two kinds of checks, both dependency-free and both runnable with plain `node --test`:
 *   1. Static guards on overlay-restore.ps1 / build-harmony.ps1 / docs (no PowerShell executed).
 *   2. Unit tests for the shared pure decision helper overlay-restore-status.mjs, plus one
 *      tiny CLI round-trip through `node` (used by the wrapper itself).
 *
 * Background: 2026-11-21, hvigor finished at 14:00:55 but the restore never came back;
 * `overlay.mjs status` stayed applied=true until a human ran `node tools/overlay.mjs restore`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyStatus, needsRestore, isRestored } from '../overlay-restore-status.mjs'

const toolsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(toolsDir, '..', '..', '..')
const wrapperPath = join(toolsDir, 'overlay-restore.ps1')
const buildPath = join(toolsDir, 'build-harmony.ps1')
const deciderPath = join(toolsDir, 'overlay-restore-status.mjs')
const BOM = Buffer.from([0xef, 0xbb, 0xbf])

const wrapperBytes = readFileSync(wrapperPath)
const wrapper = wrapperBytes.toString('utf8').replace(/^\uFEFF/, '')
const build = readFileSync(buildPath, 'utf8').replace(/^\uFEFF/, '')

/** Only the finalizer body — so a stray restore elsewhere in the script cannot fake a pass. */
function finalizerBody() {
  const start = build.indexOf('function Invoke-OverlayRestoreFinal')
  assert.ok(start >= 0, 'build-harmony.ps1 lost Invoke-OverlayRestoreFinal')
  const end = build.indexOf('\nfunction Exit-Build', start)
  assert.ok(end > start, 'cannot find the end of Invoke-OverlayRestoreFinal')
  return build.slice(start, end)
}

// --- static guards ---------------------------------------------------------

test('W1: wrapper exists, is UTF-8 with BOM, and targets PowerShell 5.1', () => {
  assert.ok(wrapperBytes.length > BOM.length)
  assert.ok(wrapperBytes.subarray(0, 3).equals(BOM), 'new .ps1 must follow the repo BOM convention')
  assert.match(wrapper, /^#requires -Version 5\.1/m)
})

test('W2: wrapper accepts -TimeoutSec with a 120 s default', () => {
  assert.match(wrapper, /\[ValidateRange\(1, 3600\)\]\[int\]\$TimeoutSec = 120/)
  assert.match(wrapper, /\$timeoutMs = \$TimeoutSec \* 1000/)
})

test('W3: wrapper has a real deadline + process-tree kill (not just a sleep)', () => {
  assert.match(wrapper, /\$proc\.WaitForExit\(\$timeoutMs\)/, 'must wait with a deadline')
  assert.match(wrapper, /taskkill\s+\/T \/F \/PID \$proc\.Id/, 'must kill hung children too')
  assert.match(wrapper, /\$timedOut = \$true/, 'must distinguish timeout from a bad exit code')
})

test('W4: timeout error is greppable and names the manual recovery command', () => {
  const line = "[overlay-restore] TIMEOUT after {0}s; overlay still applied — run 'node tools/overlay.mjs restore' manually"
  assert.ok(wrapper.includes(line), 'exact greppable TIMEOUT line must be present')
  assert.ok(line.includes("node tools/overlay.mjs restore"), 'error must name the manual recovery command')
  assert.match(wrapper, /exit 2/, 'timeout must exit non-zero')
})

test('W5: failure/assert paths are greppable and also name the recovery command', () => {
  const failed = wrapper.split('\n').filter((l) => l.includes('[overlay-restore] FAILED'))
  assert.equal(failed.length, 2, 'need one FAILED line for bad exit code and one for a bad assert')
  for (const line of failed) {
    assert.ok(line.includes('node tools/overlay.mjs restore'), line)
  }
  assert.match(wrapper, /exit 3/, 'assert failure must exit non-zero')
})

test('W6: wrapper runs overlay.mjs restore then verifies applied=false via status', () => {
  assert.match(wrapper, /\$overlay = Join-Path \$toolsDir 'overlay\.mjs'/)
  assert.match(wrapper, /\/c node "\{0\}" restore/, 'must actually run the real restore')
  assert.match(wrapper, /\$after = Get-OverlayStatus/, 'must re-read status after restore')
  assert.match(wrapper, /applied=false/, 'assert must look for the ASCII marker')
  const restoreAt = wrapper.indexOf('$psi = New-Object System.Diagnostics.ProcessStartInfo')
  const assertAt = wrapper.indexOf('$after = Get-OverlayStatus')
  assert.ok(restoreAt > 0 && assertAt > restoreAt, 'verification must come after the restore attempt')
})

test('W7: wrapper is idempotent (already restored is a no-op success)', () => {
  assert.ok(wrapper.includes('[overlay-restore] already restored (applied=false); nothing to do'))
  const noop = wrapper.indexOf('already restored')
  const restore = wrapper.indexOf('$psi = New-Object System.Diagnostics.ProcessStartInfo')
  assert.ok(noop > 0 && noop < restore, 'idempotent early exit must precede any restore')
})

test('B1: build-harmony.ps1 routes both finalizer restore calls through the wrapper', () => {
  const fn = finalizerBody()
  assert.ok(build.includes("$overlayRestore = Join-Path $projectRoot 'tools\\overlay-restore.ps1'"))
  assert.equal((fn.match(/& \$overlayRestore 2>&1/g) ?? []).length, 2, 'primary + retry must both use the wrapper')
  assert.equal(/& node \$overlay restore/.test(fn), false, 'no direct restore left in the finalizer')
})

test('B2: finalizer placement and exit-code propagation are unchanged', () => {
  assert.match(build, /Invoke-OverlayRestoreFinal 'trap'/)
  assert.match(build, /Invoke-OverlayRestoreFinal 'finally'/)
  assert.match(build, /Invoke-OverlayRestoreFinal 'exit'/)
  assert.match(build, /\$restoreCode = \$LASTEXITCODE/)
  assert.match(build, /Exit-Build \$code/)
  assert.match(build, /exit 3/, 'overlay-still-applied path must still exit 3')
})

test('D1: docs register the module and the recovery runbook line', () => {
  const modules = readFileSync(join(repoRoot, 'docs', 'MODULES.md'), 'utf8')
  const roadmap = readFileSync(join(repoRoot, 'docs', 'ROADMAP.md'), 'utf8')
  const runbook = readFileSync(join(repoRoot, 'docs', 'RUNBOOK.md'), 'utf8')
  assert.ok(modules.includes('mod-build-restore-timeout'))
  assert.ok(roadmap.includes('mod-build-restore-timeout'))
  assert.ok(runbook.includes('node tools/overlay.mjs restore'))
  assert.ok(runbook.includes('TIMEOUT') || runbook.includes('超时'))
})

// --- pure helper unit tests (applied / not-applied / unknown) ---------------

const APPLIED = '覆盖层：已应用（覆盖 3 / 新建 1，时间 2026-11-21T14:00:00.000Z）\n[overlay] applied=true'
const CLEAN = '覆盖层：未应用（工作区为「共享源码 + 平台目录」的原始形态）\n[overlay] applied=false'

test('H1: classifyStatus reads the real overlay.mjs status strings', () => {
  assert.equal(classifyStatus(APPLIED), 'applied')
  assert.equal(classifyStatus(CLEAN), 'not-applied')
})

test('H2: unknown inputs fail closed (empty, null, wrong type, garbled output)', () => {
  for (const input of ['', '   ', null, undefined, 42, {}, '[overlay] applied=?', 'node crashed']) {
    assert.equal(classifyStatus(input), 'unknown', `input=${JSON.stringify(input)}`)
    assert.equal(needsRestore(input), true, `input=${JSON.stringify(input)}`)
    assert.equal(isRestored(input), false, `input=${JSON.stringify(input)}`)
  }
})

test('H3: needsRestore only skips on an explicit applied=false', () => {
  assert.equal(needsRestore(APPLIED), true)
  assert.equal(needsRestore(CLEAN), false)
  assert.equal(isRestored(APPLIED), false)
  assert.equal(isRestored(CLEAN), true)
})

test('H4: applied=true wins when both markers appear (fail-closed ordering)', () => {
  const both = `${APPLIED}\n[overlay] applied=false`
  assert.equal(classifyStatus(both), 'applied')
  assert.equal(needsRestore(both), true)
  assert.equal(isRestored(both), false)
})

test('H5: helper CLI (used by the wrapper) answers yes/no from stdin', () => {
  const ask = (input) => execFileSync(process.execPath, [deciderPath, '--needs-restore'], { input, encoding: 'utf8' }).trim()
  assert.equal(ask(CLEAN), 'no')
  assert.equal(ask(APPLIED), 'yes')
  assert.equal(ask('nonsense'), 'yes')
})
