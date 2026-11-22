# Review — mod-plugin-client-honesty-tls

## Verdict
CONDITIONAL PASS — All four user-visible panel changes are implemented, byte-consistent in `dist/client.js`, and green under the in-scope panel tests (48/48); the plugin-wide suite/compile counts quoted in the brief are stale because out-of-scope engine/git-auth work landed afterwards (6 failing tests and 1 stale compiled file remain outside this mod). Major findings remaining: 1

## Findings

### Blocker
None.

- The username pre-check is genuinely gone: the old `username.trim() === ''` / `setError({code:'E_VALIDATION', message: tr('error.giteeUsername')})` / `return` block in `SettingsPanel.doSave()` was deleted (`src/client.js:2050-2052`; confirmed in the HEAD diff hunk `@@ -2032,22 +2042,18 @@`). `doSave()` now falls straight through to `rpcCall('saveSettings', …)` at `src/client.js:2052-2053`.
- No other client-side pre-check was found. `error.giteeUsername` occurs only as an unused dictionary key (`src/client.js:136`, `:485`; `locale/zh.json:86`, `locale/en.json:86`) — there is no `tr('error.giteeUsername')` call. The only other `E_VALIDATION` in the client is an unrelated preview-expired hint at `src/client.js:2160` (`preview.expired`), not a save gate.
- The login field cannot open before a host response: `needLogin` initialises to `false` (`src/client.js:4304`) and the only two `setNeedLogin(true)` sites (`:4352` on `saveSettings` failure, `:4384` on `testConnection` failure) are both guarded by `leanIsAuthFailure(result)`. Success paths close it (`:4371`, `:4389`).
- The encrypted line cannot render before `tls` is known: `src/client.js:4720` requires `transports && transports.tls === true`. Name-based Tailscale "recommended" copy is still present in dictionaries only (`:376`, `:725`) and is never referenced by a render path.
- `dist/client.js` has not drifted: 202,889 B, SHA-256 `f90e04ca2e996a710791372c1bcc9fb595493588981d6664883b7c98732ad31f`, identical to `src/client.js` and to a fresh in-memory `renderClientSource()`.

### Major
M1 — **Check-6 gate numbers no longer reproduce; current tree is not all-green.** The executor's tee artifact does exist (`packages/dsh-dots/.tmp/gates-client-honesty.out`, 82,596 B, written 19:18:49) and does record `tests 696 / pass 695 / fail 0 / skipped 1`, so the claim was true at that timestamp. A fresh run at review time gives **713 tests / 706 pass / 6 fail / 1 skip** (an earlier run in the same session gave 705 pass / 7 fail; the extra transient failure was `rollback-ux.test.mjs:147`, which passes 14/14 in isolation). The +17 tests come from two out-of-scope files created *after* the tee run: `test/repo-precheck.test.mjs` (11 tests, 19:24:40, all pass) and `test/git-auth-env.test.mjs` (6 tests, 19:26:28, all fail). All 6 persistent failures are in that new git-auth file: it requires `dist/engine/git.js` to export `gitAuthEnv`, which `src/engine/git.ts:89` defines but the compiled artifact does not. A fresh `tsc -p tsconfig.json --outDir <temp>` exits 0 but compares **68** compiled JS files (not 67) against `dist/**` with **1 mismatch: `dist/engine/git.js`** — the same stale artifact. None of this touches the panel in scope; the targeted panel suite is 48/48 green. **Condition:** owning engine/git-auth lane must refresh `dist/engine/git.js` and clear its 6 tests before the whole plugin can be signed off as green.

### Minor
m1 — **Executor's fail-on-old-code list undercounts (favourably).** Verified empirically by running the current test files against an isolated copy of the HEAD client/locale files (temp dir outside the repo, removed afterwards): **15** new/changed tests fail on pre-change code, not 7, and the named list of 10 is also incomplete.

| Test file | Fails on HEAD code | Guards that pass both sides |
|---|---|---|
| `test/pairing-client-wiring.test.mjs` | 7 — W15 (`:504`), H1, H3, H4, H5, H6, H8 (`:541-648`) | W14 (`:484`), W16 (`:522`), H2 (`:560`), H7 (`:623`) |
| `test/client-gitee-host-decides.test.mjs` | 4 — G1, G2, G3, **G4** (`:179-225`) | none |
| `test/client-git-username.test.mjs` | 4 — C1, C2, C3, C4 (`:175-253`) — omitted from the brief entirely | none |
| `test/client-lean-inventory.test.mjs` | 0 | all 16 |

So the brief's "7 fail" is short by 8, and its 10-name list is short by G4 plus C1–C4. **G1 and G3 — the tests that matter for the user's bug — genuinely fail on the old code** (old gate prevents `saveSettings`; old client guess replaces the host typed error), confirmed both by the HEAD diff and by execution. This erratum makes the test suite stronger than reported; no assertion was weakened to obtain the current green panel result.

m2 — `leanIsAuthFailure` (`src/client.js:4238-4243`) treats `/\b(?:401|403)\b/` appearing anywhere in `error.message` as an auth failure (`:4242`). Host HTTP 401/403 arrive with code `E_AUTH` already (`:1213`), so the message fallback is only defensive, but a non-auth host message containing a port number such as 401 or 403 would open the login field prematurely. The "only on a genuine host auth failure" guarantee therefore depends on host error-message hygiene.

### Nit
n1 — Dead locale copy remains: `lean.remote.transport.recommended` (`locale/zh.json:313`, `locale/en.json:313`, embedded at `src/client.js:376`/`:725`) and `error.giteeUsername` (`locale/*.json:86`, embedded at `:136`/`:485`). The brief permits unused keys, but H2/W15/H7 pin the *rendered* path, not the dictionaries, so a future edit could revive the old claim without failing those tests.
n2 — `dist/client.js` mtime (19:19:02) is later than `src/client.js` (19:17:03) because a later out-of-scope build rewrote it; bytes are identical, so this is harmless.

## Checklist

1. **PASS — The gate is really gone and cannot be re-derived.** `src/client.js:2050-2052` removes the entire Gitee empty-username pre-check; `saveSettings` is now unconditional at `:2052-2053`. No `tr('error.giteeUsername')` call exists (grep of `src/client.js`, `dist/client.js`, `locale/*.json`: only dictionary definitions at `:136`/`:485`/locale `:86`). The only surviving `E_VALIDATION` (`:2160`) is a preview-expired hint. There is no残留 (residue) of the old notice on the rendered path; this directly addresses the Lead's reproduced 「插件还是显示需要用户名」 blocker. G1/G2/G3 all fail on HEAD code and pass now.

2. **PASS — Host decides.** `needLogin` starts `false` (`:4304`); it is set only by `leanIsAuthFailure` on a failed `saveSettings` (`:4352`) or `testConnection` (`:4384`), where `leanIsAuthFailure` requires `result.ok === false` plus `E_AUTH`/401/403 (`:4238-4243`). A fresh empty-username save cannot open the field: `doSave` simply sends `{repoUrl, branch:'main'}` plus `username` only if a value is already present (`:4345-4350`). Success closes it and keeps the value in local settings (`:4371`, `:4389`; `persistLogin` at `:4328-4337` writes `settings.username` on blur without resending the token). G4, C2 and C3 verify open-on-auth / close-on-success / no permanent field. Minor caveat m2 applies.

3. **PASS — Honesty block is data-driven and fail-closed.** Three-way branch at `src/client.js:4720-4724`: `transports && transports.tls === true` → `tr('lean.remote.transport.encrypted')`; else `effectiveTransport === 'lan' || 'ipv6'` → `tr('lean.remote.transport.plaintext')` **verbatim**; else `null`. `effectiveTransport` falls back to `view.transport` (`:4648-4650`) so a pending/undefined `transports` still shows the truthful plaintext warning for the transport actually backing the QR (H3 passes). No transport-name-driven claim is rendered; the old `lean.remote.transport.recommended` is a dead key only. New key present in `locale/zh.json:315`, `locale/en.json:315`, `src/client.js:378` (zh) and `:727` (en), and identically in `dist/client.js`. Sticky-`rotated` fix: `running === false ⇒ lean.remote.stopped` precedes `rotated` at `:4656-4659`; `setRotated(false)` in `doStop()` at `:4635` and at the start of the transport `onChange` task at `:4701` (H4/H5/H6 pass).

4. **PASS (with erratum m1) — Tests.** In-scope targeted run: `pairing-client-wiring.test.mjs` + `client-gitee-host-decides.test.mjs` + `client-git-username.test.mjs` + `client-lean-inventory.test.mjs` = **48 tests / 48 pass / 0 fail / 0 skip**. W15 retarget (`:504-520`), H1–H8 (`:541-648`), G1–G4 (`:179-225`), C1–C4 (`:175-253`) all pass. Old-code reproduction (isolated HEAD copy): 15 genuinely fail, guards W14/W16/H2/H7 pass both sides. The brief's 7/10 count is wrong; see m1.

5. **PASS — Lean inventory intact.** `client-lean-inventory.test.mjs:317-354` passes on both old and new code: exactly 2 `<details>` groups (`dots`, `dots-remote`), inputs exactly `['text','password']` plus 1 `<select>`, exactly 7 buttons (`保存`, `测试连接`, `显示二维码`, `复制配对串`, `重新生成`, `自检`, `停止接受连接`), 1 QR after explicit `pairingShow`, unique status line per group. The derived login is a `div` with `role:'note'` / `data-lean:'sync-login-derived'` (`src/client.js:4426-4429`) and the editable field is conditional `needLogin ? … : null` (`:4431-4448`), so no permanent input was added. H7 additionally pins the five-button remote inventory (`:623-640`) and bans all resume wording; grep of `src/client.js`, `dist/client.js` and both locales found no 「重新开始接受」/「重新接受」/「恢复接受」/resume listening variants. Kill switch remains stop-only and terminal (`:4744-4749`, disabled when `running === false`).

6. **CONCERN — Build/dist numbers are partly stale (see M1).** Dist freshness itself is **PASS**, independently re-verified at review time with an in-memory, no-write check: `src/client.js` = `dist/client.js` = fresh `renderClientSource()` = **202,889 B**, all SHA-256 `f90e04ca…f31f`. `tsc --noEmit -p tsconfig.json` exits 0. The executor's tee artifact (19:18:49) records `696 / 695 / 0 / 1`; a fresh full run now records `713 / 706 / 6 / 1 skip` (skip = the pre-existing proxy case in `remote-listener.test.mjs`), and a fresh `tsc --outDir <temp>` finds 68 files / 1 mismatch (`dist/engine/git.js`). Both deltas are caused by out-of-scope work that landed after 19:18:49, not by this mod; in-scope gates are green.

## Residual risk & unverified

- No real-device or GUI verification was performed (read-only review, no device commands). All UI claims rest on the React/fetch stub harnesses in the tests and on source inspection.
- Host-side behaviour (`saveSettings` inferring the login name from the repo URL, typed `E_VALIDATION`/`E_AUTH` responses) is out of scope and was not read or executed here. This review establishes only that the panel no longer pre-empts it and reacts correctly to its responses.
- If neither `pairingTransports` nor `pairingProvision` has resolved, `effectiveTransport` is `''` and the honesty line is `null` — no claim at all. That is still fail-closed (it never claims encryption) and no QR is rendered in that state, but the plaintext warning appears only once provision lands (H3's scenario).
- The 6 failing `git-auth-env.test.mjs` cases and the stale `dist/engine/git.js` are live red gates in the current tree; they belong to another lane and must be cleared before whole-plugin promotion.
- I did not run `scripts/build.mjs` and did not write the tee artifact; per the one-file/read-only constraint I used in-memory `renderClientSource()` comparison, `tsc --noEmit`, a temp-dir `tsc --outDir` comparison (temp removed), and captured test output directly. The only file authored by this review is this report.

## Evidence log

- `git status --short` — scope files modified/untracked as expected; `test/client-gitee-host-decides.test.mjs` and `test/client-git-username.test.mjs` are new; `git diff -U8 -- packages/dsh-dots/src/client.js` shows the removed pre-check hunk `@@ -2032,22 +2042,18 @@`, the honesty branch swap `effectiveTransport === 'tailscale' → transports.tls === true`, the status-line reorder (`running === false` before `rotated`), the two `setRotated(false)` additions, and the new `leanInferLogin`/`needLogin` block.
- `grep` of `src/client.js` / `dist/client.js` / `locale/{zh,en}.json` — key anchors: honesty `:4720-4724`, `effectiveTransport :4650`, status `:4656-4664`, `doStop :4635`, `onChange :4701`, gate removal `:2050-2052`, `leanIsAuthFailure :4238-4243`, open `:4352/:4384`, close `:4371/:4389`, derived `div :4426-4429`, conditional field `:4431-4448`, dictionaries `:378/:727` and locale `:315`; no gate call, no resume wording, no rendered "recommended".
- In-memory Node check (`renderClientSource()` + SHA-256): `{"srcBytes":202889,"distBytes":202889,"freshBytes":202889,"freshEqualsDist":true,"freshEqualsSrc":true,"sha":"f90e04ca2e996a710791372c1bcc9fb595493588981d6664883b7c98732ad31f"}`.
- `node ../../node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` → `EXIT=0`.
- `node --test` on the four in-scope panel test files → `tests 48 / pass 48 / fail 0 / skipped 0`, `EXIT=0`.
- Fresh `node --test test/*.test.mjs` → latest `tests 713 / pass 706 / fail 6 / skipped 1`, `EXIT=1`; all 6 failures in `test/git-auth-env.test.mjs` ("dist/engine/git.js 必须导出 gitAuthEnv"). `test/git-auth-env.test.mjs` alone: 6/6 fail; `test/repo-precheck.test.mjs` alone: 11/11 pass; `test/rollback-ux.test.mjs` alone: 14/14 pass.
- Fresh `tsc -p tsconfig.json --outDir <temp>` + SHA-256 compare (temp removed) → `tscExit=0 compared=68 mismatch=1 missing=0`, the single mismatch being `engine\git.js`.
- Pre-change reproduction: HEAD blobs of `src/client.js`, `dist/client.js`, `locale/{zh,en}.json` written into a temp package copy (outside the repo, removed afterwards); current test files run against them → `pairing-client-wiring` 7 fails (W15, H1, H3, H4, H5, H6, H8), `client-gitee-host-decides` 4 fails (G1–G4), `client-git-username` 4 fails (C1–C4), `client-lean-inventory` 16/16 pass.
- Executor artifact read (not written by this review): `.tmp/gates-client-honesty.out`, 19:18:49, `tests 696 / pass 695 / fail 0 / skipped 1`. New out-of-scope test files postdate it by 6 and 8 minutes.
