# Review — auth + precheck (joint commit)

Independent **read-only** review of the jointly frozen slice `mod-plugin-git-auth-env` +
`mod-plugin-repo-precheck`. Scope = the exact working-tree bytes that the Lead will commit as one
commit with two tags. No build, no overlay, no git write, no device command was run. No token, key or
PEM value is reproduced anywhere in this report; secret literals in tests are referred to only as
"fake token literals".

## Verdict

**CONDITIONAL PASS — Major findings remaining: 0.** Both lanes are correct in the scoped files
(single env construction point, typed push failure, real outbox-retry proof, pre-check before any
write, byte-for-byte app parity, no-half-clone cleanup, dist == sources); the condition is that the
many **foreign (pairing / TLS / RC / P0) hunks currently sitting in the working tree must be excluded**
from these two tags — staging them wholesale would smuggle another lane's unreviewed change and
would be a Major. Two test-proof gaps are recorded as Minor (P8, app-parity run not captured).

## Findings

### Blocker
None.

### Major
None **inside the scoped slice**. All in-scope files are clean of foreign hunks. The foreign-hunk
risk is entirely in files outside the slice; see **Staging recommendation** — if any of those are
included in this commit, each is a Major.

### Minor
1. **P8 does not discriminate pre-fix code.** `test/repo-precheck.test.mjs:238-256` exercises
   `ensureWorkTree()` with a nonexistent local bare repo. `git clone` of a nonexistent local path
   aborts before creating the target directory, so both P8 assertions
   (`:253` no `<dir>/.git`; `:254-255` no `.git.clone-failed-*`) would also hold on the pre-fix
   implementation, which cloned straight into `this.dir`. No test exercises the post-rename failure
   path (a throw in `configureRepo()` / `reset` / `ensureRemote` / `ensureBranch`), which is exactly
   where the `installed` flag in `src/engine/git.ts:484-504` does real work. Code inspection confirms
   the cleanup (`catch` removes `this.dir` only when `installed`, `finally` always removes the
   quarantine), but the test does not prove it.
2. **No new `tsc` run in this review.** Per the read-only / no-build constraint I did not run a fresh
   `tsc --outDir`; I used the Lead's pre-existing `.tmp/tsc-out` output (generated 2026-11-22
   19:28:53, after every in-scope source mtime). All six target dist files are SHA-256-identical to
   it. Evidence is strong but is not an independently reproduced compile.
3. **App parity test not re-run.** No captured log line `PARITY: plugin model present — 14 fixtures
   compared, 0 mismatch` exists in any `.tmp` gate log (the only committed copy is the `console.log`
   at `apps/arkui-schedule/tools/test/repoPrivacyGate.test.mjs:186`; the older MODULES.md row records
   `D1 pending`). The plugin model now sits at the candidate path the test probes
   (`dist/remote/repoVisibility.js`), and source inspection confirms byte-identical codes/messages
   and equivalent `decideRepoVisibility`, so the test will take the present branch and report 0
   mismatch — but the actual run is `unverified` here.
4. **`docs/MODULES.md` has no row for either module.** The two new module ids
   (`mod-plugin-git-auth-env`, `mod-plugin-repo-precheck`) are not registered there. That file is
   foreign-owned and out of scope, so this is a documentation gap, not a code defect.
5. **`pushFailure` auth-prompt regex is broad.** `src/sync/gitPort.ts:212` matches the bare word
   `askpass`, so a non-auth failure whose text contains that word would be classified `auth-prompt`.
   The emitted message is still one of the four fixed, safe strings — no token/stderr leak — so
   impact is limited to a wrong (but safe) reason label.

### Nit
1. Four of the six auth test names still carry `（今天失败）` although all six now pass.
2. `repoCodeOfError()` (`src/rpc.ts:250-263`) collapses every non-`git-missing` `E_GIT` (including
   purely local failures) to `E_REPO_VISIBILITY_UNKNOWN`; fail-closed by design but the label can be
   imprecise for local corruption.
3. The auth gate log is a full 3,764-test run, not a 6-test targeted run; the six auth tests are at
   lines 4076-4081 of that file.

## Hunk ownership table

| File (path relative to `dsh-sync-suite/`) | Owner | Evidence |
|---|---|---|
| `packages/dsh-dots/src/engine/git.ts` | **auth (+ shared no-half-clone)** | `gitAuthEnv():89`, `usesGitAskpass():81`, `buildEnv():351`, `ensureWorkTree()` quarantine `:468-505`; preamble of this slice names git.ts as shared |
| `packages/dsh-dots/src/sync/gitPort.ts` | **auth** | `execGit(cwd,args,env):27`, `run():106-109` → `buildEnv()`, `pushFailure():210-226`, `pushMain():228-237` |
| `packages/dsh-dots/dist/engine/git.js` | **auth** | SHA-256 == `.tmp/tsc-out/engine/git.js`; diff mirrors git.ts only |
| `packages/dsh-dots/dist/sync/gitPort.js` | **auth** | SHA-256 == `.tmp/tsc-out/sync/gitPort.js` |
| `packages/dsh-dots/test/git-auth-env.test.mjs` (new) | **auth** | 6 tests, all named for auth-env root cause |
| `packages/dsh-dots/src/engine/settings.ts` | **precheck** | `repoError` field + `readRepoError()/writeRepoError()`; diff is precheck-only |
| `packages/dsh-dots/src/engine/types.ts` | **precheck** | `SyncStatus.repoBlockCode` (type-only) |
| `packages/dsh-dots/src/rpc.ts` | **precheck** | `repoCodeOfError():250`, `withRepo():265-307`, status `:371`, `:394`, save block `:411-449`, `:703` |
| `packages/dsh-dots/src/remote/repoVisibility.ts` (new) | **precheck** | plugin mirror of App model; codes/messages `:20-40` |
| `packages/dsh-dots/dist/engine/settings.js` | **precheck** | SHA-256 == fresh tsc |
| `packages/dsh-dots/dist/engine/types.js` | **precheck (no emitted change)** | interface-only addition is erased; file is byte-unchanged vs HEAD and == fresh tsc |
| `packages/dsh-dots/dist/rpc.js` | **precheck** | SHA-256 == fresh tsc; diff mirrors rpc.ts only |
| `packages/dsh-dots/dist/remote/repoVisibility.js` (new) | **precheck** | SHA-256 == fresh tsc and == `.tmp/repo-precheck-dist/...` |
| `packages/dsh-dots/test/repo-precheck.test.mjs` (new) | **precheck** | 11 tests P0/P0b/P1-P9 |
| `packages/dsh-dots/docs/DETAIL.md` | **precheck** | only §4.5 "Save-time repository precheck" added |
| `packages/dsh-dots/docs/DETAIL.zh.md` | — | not touched (confirmed absent from git status) |
| `packages/dsh-dots/src/client.js` | **foreign** | `mod-pairing-listener-truth` UI (start/stop, QR gating) |
| `packages/dsh-dots/dist/client.js` | **foreign** | same pairing-listener hunks; **not produced by this slice** |
| `packages/dsh-dots/src/index.ts` / `dist/index.js` | **foreign** | `mod-pairing-listener-truth` `listenerState` wiring |
| `packages/dsh-dots/src/remote/listener.ts` / `dist/remote/listener.js` | **foreign** | `mod-remote-tls-termination` (HTTPS server, TLS gate) |
| `packages/dsh-dots/src/remote/service.ts` / `dist/remote/service.js` | **foreign** | TLS cert prerequisite + `tls: handle!==null` |
| `packages/dsh-dots/src/remote/types.ts` / `dist/remote/types.js` | **foreign** | `RemoteStatus.tls` |
| `packages/dsh-dots/src/remote/urls.ts` / `dist/remote/urls.js` | **foreign** | `buildHttpsUrlWithPort`, HTTPS in `urlForMode` |
| `packages/dsh-dots/src/remote/pairingPayload.ts` / `dist/...` | **foreign** | `mod-pairing-listener-truth` codes + host-family guard |
| `packages/dsh-dots/src/remote/pairingProvision.ts` / `dist/...` | **foreign** | pairing lane |
| `packages/dsh-dots/src/remote/pairingTransport.ts` / `dist/...` | **foreign** | pairing lane |
| `packages/dsh-dots/test/remote-{integration,listener,model,service}.test.mjs` | **foreign** | TLS/HTTPS retarget (`http://` → `https://`) |
| `packages/dsh-dots/test/remote-tls.test.mjs` (new) | **foreign** | TLS lane |
| `packages/dsh-dots/locale/{en,zh}.json` | **foreign** | `lean.remote.start*` strings |
| `docs/MODULES.md` | **foreign** | rows for sync-single-flight / lean-panel / pairing / etc. |
| `apps/arkui-schedule/**` (all modified + untracked) | **foreign** | pairing/TLS app lanes; `model/repoVisibility.ts` untouched |

## Staging recommendation

Commit **one** commit containing exactly the following paths, then attach both tags
(`mod-plugin-git-auth-env`, `mod-plugin-repo-precheck`):

Auth tag file set:
- `packages/dsh-dots/src/engine/git.ts`
- `packages/dsh-dots/src/sync/gitPort.ts`
- `packages/dsh-dots/dist/engine/git.js`
- `packages/dsh-dots/dist/sync/gitPort.js`
- `packages/dsh-dots/test/git-auth-env.test.mjs`

Precheck tag file set:
- `packages/dsh-dots/src/engine/settings.ts`
- `packages/dsh-dots/src/engine/types.ts`
- `packages/dsh-dots/src/rpc.ts`
- `packages/dsh-dots/src/remote/repoVisibility.ts`
- `packages/dsh-dots/dist/engine/settings.js`
- `packages/dsh-dots/dist/engine/types.js` (no content change — include only if the commit convention requires listing it)
- `packages/dsh-dots/dist/rpc.js`
- `packages/dsh-dots/dist/remote/repoVisibility.js`
- `packages/dsh-dots/test/repo-precheck.test.mjs`
- `packages/dsh-dots/docs/DETAIL.md`

**Exclude** everything in the "foreign" rows of the table above, in particular
`dist/client.js`, `src/client.js`, `src/index.ts`, `dist/index.js`, all of `src/remote/**` except
`repoVisibility.ts`, all of `dist/remote/**` except `repoVisibility.js`, `locale/{en,zh}.json`,
`test/remote-*.test.mjs`, `docs/MODULES.md`, and all `apps/arkui-schedule/**` changes. Do **not**
add `.tmp/**` artifacts. `dist/engine/types.js` is unchanged by this slice, so it is not a new hunk.

## Checklist

1. **Single env construction point — PASS.** Grep of `src/**` finds the only *assignments* of
   `GIT_ASKPASS` / `GIT_TERMINAL_PROMPT` / `SSH_ASKPASS_REQUIRE` / `DSH_GIT_SYNC_TOKEN` at
   `src/engine/git.ts:93,97,98,102`, inside `gitAuthEnv():89`; other hits are comments. Every
   `GitRepo` network call goes through `run():387` which calls `buildEnv()` at `:389`; clone `:487`,
   lsRemote `:524`, fetch `:558`, pushOnce `:694`, pullRebase `:621-623`. The old env-less runner is
   **gone, not merely unused**: `execGit()` at `src/sync/gitPort.ts:27` now requires an `env`
   argument and the class `run():106-109` is the only caller (`git():115`, `commit():202`); grep
   finds no `execFile('git'` without `env` in gitPort.ts. `src/sync/repoPath.ts:141-161` `gitRead()`
   is local-only: its allowlist at `:143-145` is `rev-parse` / `rev-list` / `config --get`, no
   fetch/push/clone and no credential env (file is unmodified).

2. **Typed failure — PASS.** `src/sync/gitPort.ts:210-226`: four whitelisted reasons
   (`auth-prompt`, `non-fast-forward`, `network`, `git-failed`) each map to a fixed Chinese string;
   unknown text falls back to `git-failed` safely. `pushMain():228-237` discards the original
   `E_GIT` error and throws `new SyncError('E_PUSH_REJECTED', message, { reason })`. The auth-prompt
   branch explicitly covers `User cancelled dialog`, `/dev/tty`, `could not read Username/Password`,
   `terminal prompts disabled`, `Authentication failed`, `prompt script`, `askpass`. No stderr,
   tty text, askpass body or token is echoed. Auth test at `test/git-auth-env.test.mjs:205-235`
   asserts all of these (`:224-227`).

3. **Outbox retry proof — PASS.** `src/sync/cycle.ts:628-665`
   `recoverPendingLocalCommit()` calls `ctx.git.pushMain(PUSH_ARGS)` at `:643`; with production
   wiring `ctx.git` is `GitRepoV2Port`, so the retry reaches `gitAuthEnv()` via
   `pushMain → git → run → buildEnv`. The test `test/git-auth-env.test.mjs:267-312` is dynamic:
   first real `runV2Cycle` parks the intent with `E_PUSH_REJECTED` (`:280-287`), second cycle
   re-pushes and empties the outbox (`:304-306`), and both pushes' full-env SHA-256 hashes are
   equal (`:307-310`). Only the `git` executable is faked (PATH); env construction is real.

4. **Precheck semantics — PASS.** `src/rpc.ts:411-449`: normalization and token resolution are
   in-memory; the vendor-API gate at `:420-430` runs **before** `store.writeSettings(next)` (`:433`)
   and `store.writeToken(token)` (`:434`). On failure only `stateStore.writeRepoError(decision.code)`
   is written (`:424`) and `repoPrecheckError()` is thrown (`:428`) — typed SyncError with no token
   and empty details (`src/remote/repoVisibility.ts:247-250`); no clone can occur. On success
   `writeRepoError(null)` clears it (`:436`). Read-only paths opt out via `recordRepoError:false`
   (`getState` local status `:394`, `previewDiffRemote` `:703`), preventing the read-only-path
   regression. Priority host→auth→status→parse→private is literal in
   `decideRepoVisibility():103-145`; unknown host returns before any transport call
   (`fetchRepoVisibility():230-233`) — test P6 asserts `fetch.calls.length === 0`.

5. **App parity — CONCERN (logical PASS, run unverified).** All six codes, the success code `OK`,
   `REPO_PRIVATE_RULE_TEXT` and all six `REPO_VISIBILITY_MESSAGES` are byte-for-byte identical
   between `packages/dsh-dots/src/remote/repoVisibility.ts:20-40` and
   `apps/arkui-schedule/entry/src/main/ets/model/repoVisibility.ts:16-40`; `decideRepoVisibility`
   logic is equivalent. Plugin test P0 passes all 14 fixtures (auth gate log line 4553 area;
   `P0` in both gate logs). The app test at
   `apps/arkui-schedule/tools/test/repoPrivacyGate.test.mjs:159-187` probes
   `dist/remote/repoVisibility.js` (now present) and would report 0 mismatch, but no captured run
   line proves it. See Minor 3.

6. **No-half-clone — PASS (code) / CONCERN (test).** `src/engine/git.ts:468-505`: clone targets an
   isolated sibling `.git.clone-failed-<pid>-<ts>-<rand>` (`:480-483`), installs via
   `rename(quarantine, this.dir)` (`:490`), `catch` removes `this.dir` iff installed (`:499-501`)
   and `finally` always removes the quarantine (`:502-504`). On a throw in config the `installed`
   flag guarantees both are cleaned. P8 (`test/repo-precheck.test.mjs:238-256`) asserts both
   invariants (`:253`, `:254-255`) and passes in both gate logs, but only for the clone-failure
   path (see Minor 1).

7. **Tests — PASS.** Auth: exactly 6 tests (`test/git-auth-env.test.mjs:178,192,205,237,254,267`);
   captured pre-fix evidence is the precheck gate log lines 174-179 (all six failing with
   `E_GIT` / `E_BRANCH_MISMATCH` / source-shape mismatch), and the later auth gate log lines
   4076-4081 show all six passing. Precheck: exactly 11 tests P0, P0b, P1-P9
   (`test/repo-precheck.test.mjs:128,145,159,174,190,196,202,208,224,238,258`), all passing in both
   logs. P2 (`test/repo-precheck.test.mjs:174-188`, helper `:113-122`) genuinely asserts
   byte-identical `settings.json` (`:117`) and zero clone dirs under both `work/` and `repos/`
   (`:118-120`), with a seeded prior config (`:95-103`); it would fail on old code.

8. **Gate logs — PASS.** Auth log real path
   `C:\Users\GWL\Desktop\itwillclaude\dsh-sync-suite\packages\dsh-dots\.tmp\gates-plugin-git-auth-env.out`
   (392,944 B, 4,640 lines): `tests 3764 / pass 3763 / fail 0 / skipped 1`, duration 32,471.9 ms.
   Precheck log real path
   `C:\Users\GWL\Desktop\itwillclaude\dsh-sync-suite\.tmp\gates-plugin-repo-precheck.out`
   (97,344 B, 860 lines): `tests 713 / pass 706 / fail 6 / skipped 1`, duration 25,195.5 ms;
   the 6 failures are exactly the auth-env tests (lines 174-179, repeated 743-849). The Lead's
   "could not find the auth log" is because it is under `packages/dsh-dots/.tmp/`, not the repo-root
   `.tmp/`. Those 6 auth failures now pass (auth log 4076-4081, fail 0).

9. **Dist — PASS.** Fresh-tsc comparison used the pre-existing `packages/dsh-dots/.tmp/tsc-out`
   (all 6 target files, generated 19:28:53 after the latest source mtime 19:28:35): SHA-256 of
   `dist/engine/git.js`, `dist/sync/gitPort.js`, `dist/rpc.js`, `dist/engine/settings.js`,
   `dist/engine/types.js`, `dist/remote/repoVisibility.js` each equals its `.tmp/tsc-out` twin —
   0 mismatches. `dist/remote/repoVisibility.js` also equals `.tmp/repo-precheck-dist/...`.
   `dist/engine/types.js` has no emitted change (interface-only), which is consistent with its
   source. `dist/client.js` is **not unchanged in the working tree, but is unchanged by this
   slice**: its diff is entirely `mod-pairing-listener-truth` pairing-lane copy, and both modules
   skipped `build.mjs` because `client.js` was mid-window.

## Residual risk & unverified

- No fresh `tsc` was run by this reviewer (no-build constraint); parity rests on the Lead's
  `.tmp/tsc-out` artifact + source-mtime ordering + hash equality.
- The App parity test was not executed; no captured `PARITY: plugin model present … 0 mismatch`
  line exists. Equivalence is asserted by source inspection and plugin P0, not by an App run.
- P8 does not cover the post-rename/config-throw cleanup path; no test would catch a regression
  that left a `.git` after `configureRepo()` throws.
- No device / GUI / reload verification; no plugin installation was touched.
- `.tmp/**` artifacts (`.tmp/tsc-out`, gate logs, `repo-precheck-dist`, `fresh-tsc-*`) are
  untracked and must not be staged.

## Evidence log

- `git status --porcelain=v1` and `git diff --stat` in `dsh-sync-suite` — full modified/untracked set and hunk sizes.
- `git diff` on `src/engine/git.ts`, `src/sync/gitPort.ts`, `src/engine/settings.ts`, `src/engine/types.ts`, `src/rpc.ts`, `src/remote/{types,urls,service,listener,pairingPayload,pairingProvision}.ts`, `src/client.js`, `dist/client.js`, `dist/index.js`, `docs/MODULES.md`, `packages/dsh-dots/docs/DETAIL.md`, `locale/{en,zh}.json`, `test/remote-integration.test.mjs`.
- Full reads: `src/engine/git.ts` (774 lines), `src/sync/gitPort.ts` (242), `src/sync/repoPath.ts` (282), `src/remote/repoVisibility.ts` (277), `src/rpc.ts` (360-449, 240-329), `apps/.../model/repoVisibility.ts` (192), `apps/.../tools/test/repoPrivacyGate.test.mjs` (1-107, 108-192), `test/git-auth-env.test.mjs` (312), `test/repo-precheck.test.mjs` (282).
- Grep: `GIT_ASKPASS|GIT_TERMINAL_PROMPT|SSH_ASKPASS_REQUIRE|DSH_GIT_SYNC_TOKEN` and `execFile('git'` across `packages/dsh-dots/src` → only `engine/git.ts:93,97,98,102` assign auth env; `gitPort.ts:27` and `repoPath.ts:149` are the only execFile sites.
- `src/sync/cycle.ts:624-666` — `recoverPendingLocalCommit()` → `pushMain()` at `:643`.
- Gate logs: auth 392,944 B (4,640 lines; tests 3764 / pass 3763 / fail 0 / skip 1; auth tests at 4076-4081); precheck 97,344 B (860 lines; tests 713 / pass 706 / fail 6 / skip 1; failures at 174-179 and 743-849).
- SHA-256 comparison `dist/*` vs `packages/dsh-dots/.tmp/tsc-out/*` → all six targets equal (0 mismatches); `dist/remote/repoVisibility.js` also equals `.tmp/repo-precheck-dist/remote/repoVisibility.js`.
