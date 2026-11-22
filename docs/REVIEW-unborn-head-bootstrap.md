# Review — mod-empty-remote-unborn-head

Independent read-only review of the uncommitted change set in `apps/arkui-schedule`.
Scope reviewed: `entry/src/main/ets/model/syncCycle.ts`, `entry/src/main/ets/services/syncProtocolStore.ets`,
`entry/src/main/resources/rawfile/git/git-bridge.js`, `tools/test/unbornHeadBootstrap.test.mjs`.
Out-of-scope lanes (`pages/**`, `components/settings/**`, `services/syncStatusStore.ets`, `packages/**`) were
not reviewed and are not assumed correct. No builds, no overlay changes, no git writes, no device commands
were performed by this reviewer; all findings are from static reading plus read-only verification of on-disk
build artifacts and `git diff`/`git status`.

## Verdict

CONDITIONAL PASS — the diagnosis is reproduced through the real vendored git-bridge/isomorphic-git bundles, the
read-boundary fix is sound, the 17 local changes are committed and pushed rather than discarded, and the
compile evidence matches the recorded build byte-for-byte; the only gaps are evidentiary (gate numbers are
executor-reported, not preserved as a run artifact) and release-readiness (no version bump, UI counter lives in
an out-of-scope lane). **Major findings remaining: 0**

Conditions to clear before calling this closed:
1. Re-run the full gate with the output preserved as a file and confirm `3665/3664/0/1` and the targeted
   `165/165` (check 8).
2. Device-accept 1000009 against the nine criteria in check 9; the UI counter criterion is not verifiable from
   this change set alone.
3. Decide whether a version bump to 1000009 is required for the device build; none exists in the worktree.

## Findings

### Blocker

None.

### Major

None.

### Minor

- **M1 — Gate numbers are not independently verifiable from any repo artifact.** `tsc 0`, targeted `165/165`,
  full `3665 / 3664 / 0 / 1`, the "first full run contaminated by concurrent overlay build (25 hard-fails),
  then reran clean" narrative, and "the rerun is the recorded one" are asserted in the brief but appear in no
  file under the repo (grep for `3665|3664|165/165|25 hard-fail` across `itwillclaude` found only unrelated
  base64/JSON noise). The compile artifact, by contrast, is fully verifiable (check 7). This is an evidence
  gap, not evidence of a bad run; I cannot confirm the clean rerun actually produced the recorded numbers.
- **M2 — "Fail on today's code" set is incomplete.** UH-01/UH-02/UH-03 do genuinely fail on the pre-fix model
  code, but so do UH-06 (source shape guard expects a `remote` token in the `readDay` body — absent pre-fix)
  and UH-07 (pre-fix `probeRemoteRefs` returns `{empty:false,heads:[],names:['EOF','HEAD']}` for the HEAD/EOF
  pseudo-refs via `serverRefDisplayNames`, so the deepEqual fails). UH-00 passes on both pre- and post-fix code;
  it is a diagnosis reproduction, not a regression test of the fix. Claiming only UH-01/02/03 fail understates
  the coverage rather than overstating it.
- **M3 — No version bump for the device build.** Worktree `AppScope/app.json5` has `versionCode: 1000008`
  (HEAD is `1000007`), changed by an out-of-scope concurrent lane; this mod adds no bump. If 1000009 is the
  intended test build, nothing currently produces it. This does not affect the correctness of the fix.
- **M4 — UI success criterion is cross-lane.** "「本地改动 17 处」 gone" depends on how the out-of-scope
  `pages/**` + `syncStatusStore.ets` lanes compute and render the dirty count. The model here guarantees a
  clean tree after commit (HEAD==origin/main==working tree), but I cannot verify the display from this scope.

### Nit

- **N1 — Redundant filter clauses in `probeRemoteRefs`.** After `raw.indexOf('refs/') !== 0` (bridge:1633), the
  `raw === 'HEAD'` and `/^EOF\b/i.test(raw)` tests (1633) are unreachable for those exact strings. Harmless;
  keeping them documents intent. Note also that a `refs/**` entry with an **empty** oid passes the filter
  (only `/^0{40}$/` is rejected, 1637); not part of the stated contract, but worth knowing if a malformed
  advertisement ever appears.
- **N2 — UH-02's tree assertion is partly self-referential.** `writePort.writeDay` writes to `port.files`, and
  `commit` snapshots from `port.files`, so "pushed tree == committed tree" is true by construction of the fake.
  What the test genuinely proves is that `unionDay` preserved all 17 titles in the union text (UH-02:282-284),
  which is the meaningful part.

## Checklist

1. **Diagnosis independently reproduced — PASS.** UH-00 (`unbornHeadBootstrap.test.mjs:199-255`) loads the real
   vendored bundles: `isomorphic-git.js` at `:201` from `GIT_BUNDLE_PATH` (`:51` → `entry/src/main/resources/rawfile/git/isomorphic-git.js`) and
   `git-bridge.js` at `:234` from `BRIDGE_SRC` (`:50-52` → the in-scope source file), both via `vm.runInThisContext`.
   It is not a mock of the bridge: `OP_HANDLERS.v2Git = opV2Git` (`git-bridge.js:2698`); `opV2Git`'s `readBlob`
   branch (`:2368-2383`) calls `v2OidOf` (`:2277-2283`) → `git.resolveRef({ref:'origin/main'})` (`:2281`). The only
   stubs are the network advertisement (`listServerRefs`/`getRemoteInfo` Proxy, `:209-217`) and a real-fs-backed
   `dshGitHost` (`:218-232`) — necessary to model an empty remote offline. State is verifiably unborn: real
   `git.init({defaultBranch:'main'})` at `:207`, then `HEAD == 'ref: refs/heads/main'` (`:239`) and empty
   `refs/heads/` (`:240`). Chain matches the device text exactly: real `currentBranch` (bridge `:515-522`)
   returns `main`; `readBlob` throws `NotFoundError`; `normalizeError` (bridge `:378-379`) prepends
   `远端仓库为空，或分支/引用不存在：`; the test asserts the full regex (`:251`) and that
   `classifySyncError(...).kind === 'no-main'` (`:252-253`, backed by `syncError.ts:269-270`). Diagnostic printed
   at `:246`. Earlier Node suites were green because their fakes returned `''` for a missing ref, e.g.
   `syncEmptyBootstrap.test.mjs:174` — confirmed.

2. **Read-boundary fix correct — PASS.** `DayReader` added at `syncCycle.ts:461`; bootstrap signature uses it
   at `:477`; bootstrap's only per-day read is `readDay(date, false)` at `:523`; normal cycle uses
   `readDay(date, true)` at `:711`. All three production `showMain` calls are guarded: `syncProtocolStore.ets:376`,
   `:380`, `:381` use `remote ? ... : ''`. Full bootstrap call tree (`syncCycle.ts:482-620`) was grepped:
   `branchName`, `localSchemaText`, `decideFreshStart`, `bootstrapSchemaGate`, `dayIntegrityError`, `unionDay`,
   `writeDay`, `localTimelinePaths`, `addPaths`, `commit`, `pushMain`, `fetchMain`, then
   `runCyclePure(..., skipBootstrapProbe=true)`. The only other `showMain` in the model is `gateOf`
   (`syncCycle.ts:359`, schema.json) and the normal-cycle fallbacks (`:720`,`:723`); none runs in bootstrap before
   the first commit — the resumed normal cycle at `:620` runs only after push+fetch established `origin/main`.
   No path resolves `origin/main` before commit.

3. **Working-tree preservation — PASS.** `syncCycle.ts:584-600`: `localTimelinePaths()` → `addPaths(paths)` →
   `commit(BOOTSTRAP_COMMIT_MESSAGE)` → `pushMain()` → `fetchMain()` (`:617`). Bridge v2 `addCommit`
   (`git-bridge.js:2419-2441`) only `git.add`s `timeline/**`; v2 `push` (`:2443-2450`) is force=false. No
   `reset --hard` / `checkout -- .` / `clean -fd` in this path (`resetHard` exists at bridge `:2452-2465` but is
   never called by bootstrap). UH-02 (`:275-288`) asserts all 17 titles are in the initial commit's records text,
   that `timeline/schema.json` is present, that pushed records text equals committed records text, and
   `resetCount === 0`.

4. **No data deletion — PASS.** `git diff -U0` over the three files shows removed lines only for the old
   `readDay` signatures/calls and the two `serverRef...` calls; nothing removes quarantine/device handling.
   `CLONE_QUARANTINE_PREFIX`/`isCloneQuarantineDir` remain in `git-bridge.js:1522-1526` and are still exported at
   `:2759-2760`; `freshStart.ts:8` still documents "旧 devices/** … 不读、不写、不删"; `syncEmptyBootstrap.test.mjs`
   static guards remain intact. The 18 device-side `.git.clone-failed-*` dirs and `devices/` remnants are neither
   referenced for deletion nor cleaned on this path.

5. **Ref filtering — PASS.** `probeRemoteRefs` (`git-bridge.js:1602-1661`): original literal
   `if (serverRefs.length === 0)` preserved verbatim at `:1622` (pinned by `syncEmptyBootstrap.test.mjs:442`);
   new `realRefs` filter at `:1628-1641` rejects non-`refs/**` (which covers HEAD and EOF), explicit `HEAD`/EOF
   (`:1633`), and all-zero oid (`:1637`); `if (realRefs.length === 0)` at `:1642-1644` returns `{empty:true,...}`;
   `heads`/`names` now derive from `realRefs` (`:1645-1646`). UH-07 (`:324-348`) feeds `{ref:'HEAD',oid:0*40}` and
   `{ref:'EOF',oid:''}` through the real bridge and asserts `{empty:true,heads:[],names:[]}`.

6. **Four regressions — PASS (with M2 noted).** UH-03 (`:290-298`): `unborn:false` + empty remote still
   bootstraps, one commit, push ≥1. UH-04 (`:300-311`): remote with main goes normal cycle, no bootstrap commit,
   all commits start `[v2] sync `, `layoutProbes === 1`. UH-05 (`:313-322`): `probeError:'E_AUTH...'` ⇒
   `ok:false`, `code:'E_AUTH'`, zero commit/push/fetch. Genuine baseline failures: UH-01/02/03 yes; also UH-06
   and UH-07 yes (M2); UH-00 no (diagnosis-only); UH-04/05 no (pre-existing invariants).

7. **Compile evidence — PASS.** `.build-logs/build-20261122-165906.log:550` shows
   `Finished :entry:default@CompileArkTS... after 26 s 297 ms` (executed; the only `UP-TO-DATE` is
   `:entry:default@PreBuild` at `:10`; summary at `:573` = 41 executed / 1 up-to-date); `:571` =
   `BUILD SUCCESSFUL in 36 s 485 ms`. On-disk verification matches the claim exactly:
   `entry/build/default/outputs/default/app/entry-default.hap` = **5,397,719 B**, SHA-256 prefix **f4f17f6f**;
   `entry/build/default/intermediates/loader_out/default/ets/modules.abc` = **3,094,992 B**, prefix **b9b4693a**.
   Overlay is restored (no `.platform-overlay/manifest.json`), and `requireOverlayRestored` is active in the new
   test (`unbornHeadBootstrap.test.mjs:25-27`). No version bump attributable to this mod (M3).

8. **Gates — CONCERN.** No gate output file exists in the repo to confirm `tsc 0`, targeted `165/165`, or full
   `3665 / 3664 / 0 / 1`; the numbers are only in the brief (M1). Their internal arithmetic is consistent
   (3665 = 3664 pass + 0 fail + 1 skip) and a clean rerun after the contaminated first run is plausible, but
   "the rerun is the recorded one" cannot be independently established from artifacts. I did not re-run the
   suite (read-only scope). `tools/.build/model/syncCycle.js` does contain the fix (`readDay(date,false)` at
   `:345`, `readDay(date,true)` at `:523`), so the compiled test target is not stale.

9. **Device-derived success criteria — PARTIAL/CONCERN.** From the code as written: **yes**, one bootstrap commit
   (`[v2] bootstrap main`) containing `timeline/schema.json` + all local timeline files; **yes**, `pushMain()`
   pushes that tree and `fetchMain()` establishes the tracking ref, so `refs/remotes/origin/main` should exist and
   `timeline/**` should be on the remote; **yes**, the resumed normal cycle is idempotent on an already-pushed
   tree, so no second root commit; **yes**, working tree becomes clean, so a dirty-file-based counter should read
   zero; **yes**, the bootstrap path never calls `git.clone`, so no new `.git.clone-failed-*` should appear
   (`git-bridge.js:1668-1673` documents this). Caveats: (a) the UI counter is in an out-of-scope lane (M4);
   (b) `refs/remotes/origin/main` creation relies on isomorphic-git's default fetch refspec with
   `remote:'origin', ref:'main', singleBranch:true` (bridge `:2300-2303`), which is not asserted by a real-bridge
   test here; (c) no version bump for an installable 1000009 (M3). These are device-test items, not code defects
   I can resolve statically.

## Residual risk & unverified

- Full/targeted gate numbers and the contamination→rerun sequence (M1): unverified, no artifact.
- Real-device behaviour of `git.fetch` creating `refs/remotes/origin/main` on the freshly pushed empty remote:
  reasoned from isomorphic-git semantics, not executed.
- UI rendering of 「本地改动 17 处」 after the tree is clean: out of scope (M4).
- Existing 18 `.git.clone-failed-*` dirs and `devices/` remnants are device-side; I verified the diff does not
  delete their handling, but did not inspect a device filesystem (no device commands per scope).
- Version stamp for the 1000009 test build (M3).
- Concurrent lanes in the same worktree (`pages/**`, `components/settings/**`, `syncStatusStore.ets`,
  `packages/**`) may themselves be mid-flight; this review assumes they are independent of the model fix.

## Evidence log

- `git status --porcelain=v1 -uall` — confirmed the four in-scope paths and numerous concurrent-lane changes.
- `git diff` / `git diff -U0` on the three scope files — full change set and deletion-only listing reviewed.
- `read` of `tools/test/unbornHeadBootstrap.test.mjs` (all 363 lines) — UH-00/01/02/03/04/05/06/07 reviewed.
- `read` of `syncCycle.ts:200-239, 330-439, 440-739`; `syncProtocolStore.ets:364-395` (via diff + grep);
  `git-bridge.js:360-399, 468-522, 1598-1669, 2250-2394, 2419-2466, 2730-2823`; `gitRunner.ets:70-99`;
  `syncError.ts:267-270`; `guard.mjs`; `freshStart.ts:8` (via grep); `package.json`.
- `grep` of all `runCyclePure(`/`readDay(`/`showMain(`/`bootstrapEmptyRemote(` call sites under
  `apps/arkui-schedule` (83 matches) — bootstrap call tree closed.
- `grep` for `probeRemoteRefs`, `internals`, `OP_HANDLERS`, `CLONE_QUARANTINE_PREFIX`, `devices/` — bridge wiring
  and preservation of quarantine/device handling confirmed.
- `Get-Item` + `Get-FileHash -Algorithm SHA256` on the built HAP and `modules.abc` — sizes/hashes match the brief.
- `read` of `.build-logs/build-20261122-165906.log:1-30, 540-577` — compile/build evidence.
- `glob` of `apps/arkui-schedule/.platform-overlay/**` — empty, overlay restored.
- `grep` for `3665|3664|165/165|no bump|1000009` across `itwillclaude` and `apps/arkui-schedule/docs` — no gate
  record found; `git diff` of `AppScope/app.json5` — versionCode 1000007→1000008 (out-of-scope lane).
