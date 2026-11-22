# Review — mod-p0a-no-main-probe

Scope: uncommitted lane on HEAD `9fc528e` (base moved to `1b7865f` then `1ed6918` by concurrent sibling lanes during this review — see §Evidence log). Read-only review; no build, no overlay, no git writes. Overlay checked `applied=false` before any test was run.

## Verdict

FAIL — The new probe is correctly ordered inside `ensureRepoInitialised`, but the app's first-run "silent init" still calls the bridge `clone` op directly, so a genuinely empty remote can still clone, still create `.git.clone-failed-*`, and still surface a failure; the regression tests never exercise that path. Major findings remaining: 1

## Findings

### Blocker

**B1 — The direct `clone` bridge op bypasses `probeRemoteRefs` entirely; the originally reported defect is still reachable.**

- `apps/arkui-schedule/entry/src/main/resources/rawfile/git/git-bridge.js:1424-1470` — `opClone()` still does **not** call `ensureRepoInitialised()` / `probeRemoteRefs()`. When `repoInitialized()` is false (`:1429`) it goes straight to `git.clone({ ..., ref: branch, ... })` at `:1441-1450`. Its `catch` at `:1451-1458` calls `quarantineBrokenRepo()` (`:1408-1422`), which `rename`s `.git` to `.git.clone-failed-<ts>`, and `normalizeError()` maps `Could not find main` to the exact reported text 「远端仓库为空，或分支/引用不存在：Could not find main.（已隔离未完成的本地仓库 …）」 (`:378-380`, `:1455-1456`). The diff for `opClone` is only the extracted `CLONE_QUARANTINE_PREFIX` constant — no probe was added.
- Caller: `apps/arkui-schedule/entry/src/main/ets/services/GitSyncService.ets:755-773` — `ensureRepoInitialised()` calls `this.callBridge('clone', this.configArgs())` at `:767`. `configArgs()` (`:2453-2468`) does attach `autoInit:'true'` (`:2465`), but `opClone` ignores that flag; the guard lives only in `ensureRepoInitialised()` (git-bridge.js:1617) and in `opV2Git()`.
- Reachable on a fresh device (no `.git`), before any `v2Git('remoteLayout')` probe:
  - `GitSyncService.ets:937` (`pullLocked()` ← 立即同步/拉取, UI at `pages/SettingsSync.ets:628` → `this.sync.pull()`);
  - `GitSyncService.ets:1032` and `:1269`;
  - `pages/SettingsSync.ets:403` (测试连接 → `this.sync.ensureRepoInitialised()`).
- Consequence: on a genuinely empty remote the very first user action can still clone ⇒ `Could not find main` ⇒ new quarantine ⇒ failure line. `syncError`'s new `no-main` rule (`syncError.ts:267-271`) only relabels it as 「远端缺少 main 分支」; it is still a failure, so "empty remote never surfaces a failure" is false. The stale `.git.clone-failed-*` case (P6) is also undermined: each such attempt creates another quarantine dir.
- Test blind spot: `noMainProbe.test.mjs:154-222` (P2/P5) drives `internals.ensureRepoInitialised` only, and S1 (`:358-384`) inspects only that function's source. No test drives `DshGitBridge.call({op:'clone', ...})` / `OP_HANDLERS.clone` (git-bridge.js:2617-2633). The suite therefore passes while the app path is broken.
- Required fix (not present): make the `clone` op itself probe first (or make the app call a bridged decision op instead of `clone`), and add a test that calls `DshGitBridge.call({op:'clone', args:{autoInit:'true', ...}})` with `[]` advertised refs and asserts clone count 0, init count 1, no quarantine dir.

No other Blocker found; this one covers all three blunt conditions ("still clones", "still fails", "still quarantines").

### Major

None separate — B1 subsumes them.

### Minor

- **M1 — Stale targeted count in docs.** `docs/MODULES.md:344` and the ROADMAP row claim 171/171; measured 172/172 (per file: syncError 33, syncEmptyBootstrap 25, syncWiring 55, fixSyncRetry 6, modSettingsSyncMin 8, settingsCopyGuard 9, noMainProbe 10, git-bridge 26). Full-suite 2905 is exact. All pass; only the documented number is off by one.
- **M2 — "first-run/progress wording" is only weakly evidenced.** `E_REMOTE_EMPTY_MESSAGE` (`syncCycle.ts:66`) is defined and asserted in `syncEmptyBootstrap.test.mjs:276-277` but is not consumed by any user-visible outcome; the empty path returns the resumed cycle from `bootstrapEmptyRemote()` (`syncCycle.ts:467-613`). It is not a failure in the v2 path, but the specific "progress" wording claim is not proven by the added tests.
- **M3 — P6 establishes "no reinstall" only at bridge level.** `noMainProbe.test.mjs:224-240` proves `repoInitialized()` ignores the stale dir and `init` proceeds with a fake git; it is not a device proof, and B1 invalidates it on the v1 clone path.
- **M4 — Check #3 wording needs nuance.** `git-bridge.js` is a changed file and *does* contain `writeRef(..., force:true)` (`:736`, `:1814`, `:1869`, `:1999`, `:2389-2393`), but all are pre-existing A2/v2 code outside the empty/no-main decision slices; no ref-write/adopt/force/rebase line was added by this module (verified in `git diff -U0`).

### Nit

- `remoteHasNoRefs()` (git-bridge.js:1485-1498) is retained and exported (`:2691`) purely as a historical predicate; harmless but now dead in decisions.

## Checklist

1. **Ordering — PASS.** `probeRemoteRefs()` (git-bridge.js:1553-1592) calls `git.listServerRefs` first at `:1556`, inside try/catch; `[]` ⇒ `{empty:true, heads:[], names:[]}` at `:1573-1575`; non-array ⇒ typed "无法确认远端状态" at `:1567-1572`; throw ⇒ typed "无法确认远端状态（探测失败）" + sanitized underlying text at `:1559-1566` (not "empty", not clone). `getRemoteInfo()` is called only after a non-empty array, only to supplement head names, inside its own try/catch (`:1579-1590`).

2. **No clone before a positive decision — FAIL (B1).** Inside `ensureRepoInitialised()` the order is correct: probe at `:1623`, `[]` ⇒ `git.init` + `ensureRemote` at `:1624-1631` with no `git.clone`; indeterminate ⇒ typed throw at `:1561-1572`/`:1637-1642` with no clone; refs-without-main ⇒ typed message at `:1633-1643` and no clone/init/ref creation; refs-with-main ⇒ `return await opClone(args)` at `:1644`. But `opClone()` (`:1424-1470`) is also an entry point and clones with no decision at all; the app calls it first (B1).

3. **No adopt hatch — PASS (with M4 nuance).** No `adopt*`, `createMainFrom`, `createRef(`, `branch -D`, rebase, or `*--force` line added in the diff; S1 (noMainProbe.test.mjs:366-383) bans these in the decision/remoteLayout source slices and in the model/page/service files; `docs/MODULES.md:218` records the amendment as 已整体撤回、未实现、未登记为现行契约 with the exact boundary 「不克隆、不建引用、不 force、不删除、不改写任何远端历史」.

4. **Message honesty — PASS for classification; practically undermined by B1.** `syncError.ts:267-276` adds `no-main` (fatal) and `remote-indeterminate` (retry) **before** the generic network fallback (`:371-384`) and the §9 fallback that produces 「未知错误…原始信息：」 (`:386-393`); both use `info(..., raw, ...)` directly, not `withRaw`, so no nested wrapper. `syncError.test.mjs` new describe + S2 assert this, and `noMainMessage()` (syncCycle.ts:75-87) names actual branches and gives the rename/empty-repo next step. Truly-empty classification is asserted not to be `no-main`. However B1 means the empty case can still fail before these honest messages are used.

5. **Quarantine — CONCERN.** Decision is ignore, not delete: `quarantineBrokenRepo()` uses `hostCall('rename', ...)` (git-bridge.js:1415); no delete API is used. `repoInitialized()` checks exactly `pathJoin(session.repoRoot, '.git')` (`:497-506`), so a `.git.clone-failed-*` can never be treated as a repo. P6 (noMainProbe.test.mjs:224-240) genuinely asserts `repoInitializedOf()===false` with a stale dir present, then `init===1`, `clone===0`, stale dir still present. "User needs no reinstall/data-clear" is thereby established only at bridge-logic level, not on-device, and is contradicted by B1 on the v1 clone path.

6. **Byte-level test P8 is real — PASS.** `noMainProbe.test.mjs:265-339` loads the vendored UMD at `entry/src/main/resources/rawfile/git/isomorphic-git.js` via `createRequire` (`:267-275`), asserts `realGit.version() === '1.25.3'` (`:276`), builds real pkt-line advertisements with a `pkt()` encoder plus `0000` flush and protocol-v2 discovery (`:277-286`, `:316-318`), and calls the real `realGit.listServerRefs()` (`:299-301`, `:319-321`) with a stub HTTP adapter (necessary; the library and byte parsing are genuine). It then feeds the real arrays through the bridge's `serverRefHeadNames` / `probeRemoteRefs` helpers. It is **not** a mock of the library. It passed in this environment.

7. **Tests fail on old behaviour — PASS.** P2 asserts `fake.calls.listServerRefs === 1` (noMainProbe.test.mjs:162); the old getRemoteInfo/fallthrough code never calls it, so P2 fails even in the variant where a nested empty shape would still lead to `init`. S1 fails on old code because `ensure.indexOf('if (probe.empty)')` is -1 and `assert.match(BRIDGE_SRC, /git\.listServerRefs\(/)` fails (`:360-365`). P5 and P4/P7 add further coverage.

8. **Gates — CONCERN (one count mismatch; concurrent HEAD move).** `tsc -p apps/arkui-schedule/tools/tsconfig.json` exit 0. Targeted eight files: **172 tests / 19 suites / 172 pass / 0 fail / 0 skipped** (expected 171; see M1). Full suite: **2905 / 409 suites / 2905 pass / 0 fail / 0 skipped** — matches expected 2905/2905/0/0. `validate-app` **8/8**. `overlay.mjs status` → `applied=false`. Concurrent lane activity: HEAD was `9fc528e` at review start and moved to `1b7865f` (mod-home-list-instant-refresh commit) and `1ed6918` (VERIFICATION docs) during the review; test-file counts were not altered by those commits, so totals are reported as measured, not averaged.

9. **Docs — PASS with M1 caveat.** `MODULES.md:146` and `:216` give the root cause (nested `getRemoteInfo().refs` shape misclassifies Gitee empty repo; fallthrough to `git.clone({ref:'main'})` ⇒ `Could not find main` + quarantine) and a concrete revert path; `:218` records the withdrawn amendment; `:344` and the ROADMAP row carry 未装机 / unverified（安装版 `1000006`；设备检查随 `1000007`）. No other module's row was altered by this module (diff of `9fc528e..HEAD` touches only MODULES/ROADMAP for this lane; the sibling module's rows are separate commits). Stale 171 number = M1.

## Residual risk & unverified

- **Empty remote can still clone and still fail (B1).** Until the `clone` op is gated by the probe, 测试连接 and 立即同步 on a fresh install can reproduce the exact 1000006 symptom; the v2 auto-cycle path (`syncProtocolStore.runConfiguredCycle()` → `gitRunner.remoteLayout()` → `v2Git('remoteLayout')`, git-bridge.js:2264-2277) is correctly probed.
- Not installed on-device: 1000006 evidence is historical; device recheck is 1000007. All bridge tests are fake-git/`vm.runInThisContext` level except the byte-level P8; no real Gitee round-trip in this review.
- `tsc` covers the `.ets` model sources; no HAP build/装机 was performed (per scope).
- HEAD changed mid-review due to sibling commits; findings refer to the p0a working-tree diff, which those commits did not touch.

## Evidence log

- `node apps/arkui-schedule/tools/overlay.mjs status` → `[overlay] applied=false`.
- `git status --short` / `git rev-parse HEAD` → `9fc528ef...` initially; later `1b7865f` + `1ed6918` (sibling commits: `fix(home): mod-home-list-instant-refresh`, `docs(verify): §15.20 ...`).
- `git diff -- <git-bridge.js>` → old `ensureRepoInitialised` used `getRemoteInfo` + "探测不到引用不算空仓库（fail-closed）：交给 clone 抛 typed 传输/认证错误" fallthrough; new code uses `probeRemoteRefs`; `opClone` unchanged except quarantine-prefix constant.
- `node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json` → exit 0 (`.tmp/review-p0a-tsc.out`).
- `node --test` targeted 8 files → 172/172 (`.tmp/review-p0a-targeted.out`); per-file counts from individual runs.
- `node --test "apps/arkui-schedule/tools/test/*.test.mjs"` → 2905/2905/0/0 (`.tmp/review-p0a-full.out`).
- `node apps/arkui-schedule/tools/validate-app.mjs` → 8/8 (`.tmp/review-p0a-validate.out`).
- Source reads: git-bridge.js:497-506, 1408-1478, 1553-1645, 2264-2277, 2617-2633, 2676-2745; syncCycle.ts:65-87, 440-455, 467-613, 620-649; syncError.ts:102-110, 141-161, 267-276, 371-393; GitSyncService.ets:755-773, 927-942, 1355-1374, 2453-2468; SettingsSync.ets:390-414, 616-628; noMainProbe.test.mjs:1-401; MODULES.md:146, 216, 218, 344; ROADMAP.md p0a row.
