/**
 * mod-sign-hap-pass — self-check for tools/sign-hap.ps1.
 *
 * Static assertions (PowerShell cannot be unit-imported by Node) + pure helpers
 * that mirror the script's password/keystore rules. Every dummy value below is
 * deliberately fake; the real signing/pass.txt content must never appear here.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const SCRIPT = fileURLToPath(new URL('../sign-hap.ps1', import.meta.url))
const PASS_FILE = fileURLToPath(new URL('../../signing/pass.txt', import.meta.url))
const RUNBOOK = fileURLToPath(new URL('../../../../docs/RUNBOOK.md', import.meta.url))
const MODULES = fileURLToPath(new URL('../../../../docs/MODULES.md', import.meta.url))
const ROADMAP = fileURLToPath(new URL('../../../../docs/ROADMAP.md', import.meta.url))

const scriptText = readFileSync(SCRIPT, 'utf8')
const scriptLines = scriptText.split(/\r?\n/)
// The header comment shows an -StorePass $env:SIGN_PASS example; scope ordering
// assertions to executable code so documentation cannot confuse them.
const codeText = scriptText.slice(scriptText.indexOf('[CmdletBinding()]'))
const codeIdx = (needle) => codeText.indexOf(needle)

/** Pure mirror of Read-PassFileText: strip U+FEFF, then ONLY trailing CR/LF. */
function trimPasswordText(raw) {
  let text = String(raw)
  if (text.length > 0 && text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  return text.replace(/[\r\n]+$/, '')
}

/** Pure mirror of the store-password resolution order. */
function resolveStorePassword({ explicit, env, file, fileExists }) {
  if (explicit !== undefined && explicit !== null) return { value: String(explicit), source: 'parameter' }
  if (env) return { value: String(env), source: 'env' }
  if (fileExists) return { value: trimPasswordText(file), source: 'file' }
  return { value: '', source: 'none' }
}

/** Pure mirror of the key-password resolution order. */
function resolveKeyPassword({ explicit, env, store }) {
  if (explicit !== undefined && explicit !== null) return String(explicit)
  if (env) return String(env)
  return String(store)
}

/** Pure mirror of the v2-required / v1-opt-in material decision. */
function classifySigningMaterial({ v2Complete, allowLegacy }) {
  if (v2Complete) return { mode: 'v2', refused: false }
  if (allowLegacy) return { mode: 'v1', refused: false }
  return { mode: 'refuse', refused: true }
}

describe('pure password helpers', () => {
  test('plain password is returned unchanged (no over-trimming)', () => {
    assert.equal(trimPasswordText('DUMMY-PLAIN-PASS'), 'DUMMY-PLAIN-PASS')
  })

  test('leading UTF-8 BOM (U+FEFF) is stripped', () => {
    assert.equal(trimPasswordText('\ufeffDUMMY-BOM'), 'DUMMY-BOM')
  })

  test('single trailing LF is trimmed', () => {
    assert.equal(trimPasswordText('DUMMY-LF\n'), 'DUMMY-LF')
  })

  test('single trailing CRLF is trimmed', () => {
    assert.equal(trimPasswordText('DUMMY-CRLF\r\n'), 'DUMMY-CRLF')
  })

  test('multiple trailing CRLF line endings are trimmed', () => {
    assert.equal(trimPasswordText('DUMMY-MULTI\r\n\r\n\n'), 'DUMMY-MULTI')
  })

  test('trailing CR-only (old Mac) is trimmed', () => {
    assert.equal(trimPasswordText('DUMMY-CR\r'), 'DUMMY-CR')
  })

  test('leading spaces are preserved (only line endings are trimmed)', () => {
    assert.equal(trimPasswordText('  DUMMY-LEAD'), '  DUMMY-LEAD')
  })

  test('trailing spaces/tabs are preserved (Trim() would corrupt the password)', () => {
    assert.equal(trimPasswordText('DUMMY-TRAIL \t'), 'DUMMY-TRAIL \t')
  })

  test('BOM + CRLF + trailing newline are all handled together', () => {
    assert.equal(trimPasswordText('\ufeffDUMMY-ALL\r\n\n'), 'DUMMY-ALL')
  })

  test('empty input stays empty', () => {
    assert.equal(trimPasswordText(''), '')
  })

  test('BOM-only input becomes empty', () => {
    assert.equal(trimPasswordText('\ufeff'), '')
  })

  test('interior newline is preserved (trim is anchored at the tail only)', () => {
    assert.equal(trimPasswordText('DUMMY-A\r\nDUMMY-B\n'), 'DUMMY-A\r\nDUMMY-B')
  })
})

describe('pure resolution-order helpers', () => {
  test('explicit -StorePass wins over env and file', () => {
    const r = resolveStorePassword({
      explicit: 'DUMMY-PARAM', env: 'DUMMY-ENV', file: 'DUMMY-FILE', fileExists: true
    })
    assert.deepEqual(r, { value: 'DUMMY-PARAM', source: 'parameter' })
  })

  test('explicit empty string is still the explicit source', () => {
    const r = resolveStorePassword({ explicit: '', env: 'DUMMY-ENV', file: 'x', fileExists: true })
    assert.deepEqual(r, { value: '', source: 'parameter' })
  })

  test('env SIGN_PASS wins over pass.txt when no explicit param', () => {
    const r = resolveStorePassword({
      explicit: undefined, env: 'DUMMY-ENV', file: 'DUMMY-FILE', fileExists: true
    })
    assert.deepEqual(r, { value: 'DUMMY-ENV', source: 'env' })
  })

  test('pass.txt is used with BOM/CRLF trimmed when nothing else is set', () => {
    const r = resolveStorePassword({
      explicit: undefined, env: '', file: '\ufeffDUMMY-FILE\r\n', fileExists: true
    })
    assert.deepEqual(r, { value: 'DUMMY-FILE', source: 'file' })
  })

  test('no source yields empty value and source=none', () => {
    const r = resolveStorePassword({ explicit: undefined, env: '', file: '', fileExists: false })
    assert.deepEqual(r, { value: '', source: 'none' })
  })

  test('explicit -KeyPass wins over SIGN_KEY_PASS and store password', () => {
    assert.equal(resolveKeyPassword({ explicit: 'DUMMY-KEYPARAM', env: 'DUMMY-KEYENV', store: 'DUMMY-STORE' }), 'DUMMY-KEYPARAM')
  })

  test('SIGN_KEY_PASS wins over the store password', () => {
    assert.equal(resolveKeyPassword({ explicit: undefined, env: 'DUMMY-KEYENV', store: 'DUMMY-STORE' }), 'DUMMY-KEYENV')
  })

  test('key password falls back to the resolved store password', () => {
    assert.equal(resolveKeyPassword({ explicit: undefined, env: '', store: 'DUMMY-STORE' }), 'DUMMY-STORE')
  })
})

describe('pure key-material decision', () => {
  test('complete v2 material selects v2 even when the legacy switch is present', () => {
    assert.deepEqual(classifySigningMaterial({ v2Complete: true, allowLegacy: true }), { mode: 'v2', refused: false })
  })

  test('incomplete v2 material + explicit switch selects v1', () => {
    assert.deepEqual(classifySigningMaterial({ v2Complete: false, allowLegacy: true }), { mode: 'v1', refused: false })
  })

  test('incomplete v2 material without switch refuses (default)', () => {
    assert.deepEqual(classifySigningMaterial({ v2Complete: false, allowLegacy: false }), { mode: 'refuse', refused: true })
  })
})

describe('static: sign-hap.ps1 implements the contract', () => {
  const idx = (needle) => scriptText.indexOf(needle)

  test('script is UTF-8 with BOM (PS5.1 parses Chinese messages correctly)', () => {
    const bytes = readFileSync(SCRIPT)
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf])
  })

  test('store-password order is param -> env SIGN_PASS -> pass.txt, in that source order', () => {
    assert.ok(codeIdx("$PSBoundParameters.ContainsKey('StorePass')") >= 0, 'explicit -StorePass branch missing')
    assert.ok(codeIdx('$env:SIGN_PASS') >= 0, 'SIGN_PASS env branch missing')
    assert.ok(codeIdx('Read-PassFileText -Path $passFile') >= 0, 'pass.txt branch missing')
    assert.ok(
      codeIdx("$PSBoundParameters.ContainsKey('StorePass')") < codeIdx('$env:SIGN_PASS') &&
      codeIdx('$env:SIGN_PASS') < codeIdx('Read-PassFileText -Path $passFile'),
      'resolution order in source is not param -> env -> file'
    )
  })

  test('key-password order is param -> SIGN_KEY_PASS -> store password', () => {
    assert.ok(codeIdx("$PSBoundParameters.ContainsKey('KeyPass')") >= 0)
    assert.ok(codeIdx('$env:SIGN_KEY_PASS') >= 0)
    assert.ok(codeIdx("$PSBoundParameters.ContainsKey('KeyPass')") < codeIdx('$env:SIGN_KEY_PASS'))
    assert.ok(codeIdx('$KeyPass = $StorePass') >= 0, 'store-password fallback missing')
  })

  test('pass.txt helper strips BOM and only CR/LF; no blanket Trim()', () => {
    assert.match(scriptText, /function Read-PassFileText/)
    assert.match(scriptText, /0xFEFF/)
    assert.match(scriptText, /TrimEnd\(\[char\]0x0D, \[char\]0x0A\)/)
    assert.equal(/\.Trim\(\)/.test(scriptText), false, 'blanket Trim() would corrupt a password with spaces')
  })

  test('early keystore validation runs before any sign-app attempt', () => {
    assert.ok(idx('keytool -list') >= 0, 'keytool -list validation missing')
    assert.ok(idx('-jar\', $tool, \'sign-app') >= 0 || idx("'sign-app'") >= 0, 'sign-app path missing')
    assert.ok(idx('keytool -list') < idx('$signArgs'), 'validation must precede the sign argument list')
    assert.match(scriptText, /\$keytoolExit -ne 0/, 'keytool exit code is not checked')
  })

  test('wrong password fails with the exact clear message (no raw 11014003)', () => {
    assert.ok(idx('[sign-hap] 密码无法打开 keystore：检查 -StorePass / signing/pass.txt（不要打印密码）') >= 0)
  })

  test('-AllowLegacyV1Key switch is declared', () => {
    assert.match(scriptText, /\[switch\]\$AllowLegacyV1Key/)
  })

  test('v1 refusal message is greppable and names the leaked-key risk', () => {
    assert.ok(idx("[sign-hap] REFUSING LEAKED V1 KEY") >= 0, 'refusal message missing')
    const refusalLine = scriptLines.find((line) => line.includes('REFUSING LEAKED V1 KEY')) ?? ''
    assert.match(refusalLine, /LEAKED V1 KEY/, 'risk not named in refusal')
    assert.match(refusalLine, /AllowLegacyV1Key/, 'remedy switch not named in refusal')
  })

  test('legacy warning exists exactly once, is switch-gated, and is loud', () => {
    const warnings = scriptLines.filter((line) => line.includes('Write-Warning'))
    assert.equal(warnings.length, 1, 'there must be exactly one v1 warning and no unconditional fallback warning')
    const warning = warnings[0]
    assert.match(warning, /AllowLegacyV1Key/)
    assert.match(warning, /LEAKED v1 signing key/)
    assert.ok(idx('elseif ($AllowLegacyV1Key)') >= 0 && idx('elseif ($AllowLegacyV1Key)') < idx(warning))
  })

  test('the old silent fallback phrase is gone', () => {
    assert.equal(scriptText.includes('falling back to v1'), false)
  })

  test('script never echoes the password via Write-Host/echo', () => {
    for (const line of scriptLines) {
      if (!/Write-Host|\becho\b/i.test(line)) continue
      assert.equal(line.includes('$StorePass'), false, `Write-Host leaks StorePass: ${line}`)
      assert.equal(line.includes('$KeyPass'), false, `Write-Host leaks KeyPass: ${line}`)
      assert.equal(line.includes('$env:SIGN_PASS'), false, `Write-Host leaks SIGN_PASS: ${line}`)
      assert.equal(line.includes('$passFile'), false, `Write-Host leaks pass file path: ${line}`)
    }
  })

  test('no secret literal from signing/pass.txt appears in script or this test', () => {
    if (!existsSync(PASS_FILE)) return
    const secret = trimPasswordText(readFileSync(PASS_FILE, 'utf8'))
    assert.ok(secret.length > 0, 'pass.txt must not be empty')
    const self = readFileSync(fileURLToPath(import.meta.url), 'utf8')
    assert.equal(scriptText.includes(secret), false, 'real password leaked into sign-hap.ps1')
    assert.equal(self.includes(secret), false, 'real password leaked into signHapPass.test.mjs')
  })
})

describe('static: documentation registered', () => {
  test('RUNBOOK build/sign line states password order and refusal behaviour', () => {
    const doc = readFileSync(RUNBOOK, 'utf8')
    assert.match(doc, /SIGN_PASS/)
    assert.match(doc, /signing\/pass\.txt/)
    assert.match(doc, /密码无法打开 keystore/)
    assert.match(doc, /-AllowLegacyV1Key/)
  })

  test('MODULES.md registers mod-sign-hap-pass in §1/§5/§6 with Lead-filled hash', () => {
    const doc = readFileSync(MODULES, 'utf8')
    const occurrences = [...doc.matchAll(/mod-sign-hap-pass/g)]
    assert.ok(occurrences.length >= 3, `expected §1/§5/§6 registrations, found ${occurrences.length}`)
    assert.match(doc, /（Lead 填）/)
  })

  test('ROADMAP has a mod-sign-hap-pass bullet', () => {
    const doc = readFileSync(ROADMAP, 'utf8')
    assert.match(doc, /mod-sign-hap-pass/)
  })
})
