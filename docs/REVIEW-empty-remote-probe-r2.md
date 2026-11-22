# Re-review (r2) — opClone guard

Scope: focused, read-only pass on the single Blocker (B1) from `docs/REVIEW-empty-remote-probe.md`. Target `HEAD 1b7865f` was stated in the brief; the tree I reviewed is at `1ed6918` (r1 already recorded the mid-review move `9fc528e → 1b7865f → 1ed6918`). No build, no overlay apply/restore, no git writes, no subagents. `overlay.mjs status` → `applied=false` before any test was run. Verdict is from source + tests, not from prose.

## Verdict

PASS — B1 is genuinely closed: the only `git.clone` in the bridge is now downstream of a `probeRemoteRefs` decision on every app-reachable route, handler-level tests drive the literal dispatch target and fail on the old code, and all gates are green. Major findings remaining: 0

## The Blocker

**CLOSED.** Evidence (all in `apps/arkui-schedule/entry/src/main/resources/rawfile/git/git-bridge.js` unless noted):

- `opClone(args, skipProbe)` at `:1432`. The probe gate is `:1448` (`skipProbe !== true && args && args.autoInit === 'true'`), `probeRemoteRefs(git, config, url)` is called at `:1449`, and the sole `git.clone({...})` is at `:1473` — strictly after the decision, inside the `try` at `:1472`.
- `probe.empty` ⇒ `:1450-1459`: `git.init` (`:1451`) + `ensureRemote` (`:1452`), returns a resolved first-run result `{ cloned:false, initialized:true, emptyRemote:true, message:'远端仓库为空（首次同步的正常起点），正在初始化 main 时间线', ... }` (`:1454-1458`). No clone, no `quarantineBrokenRepo` (whose only call site is `:1484`, inside the clone `catch`).
- refs without `main` ⇒ `:1460-1470`: typed `E_GIT` naming the actual refs (`probe.heads.join('、')` / `probe.names.join('、')`) plus 缺少 main and the rename/empty-repo next step. No clone / init / ref creation.
- Indeterminate probe ⇒ `probeRemoteRefs` throws typed `E_GIT` at `:1593` / `:1600`; never falls through to clone.
- The facade still calls `callBridge('clone', configArgs())` (`GitSyncService.ets:767`), and `configArgs()` always sets `'autoInit': 'true'` (`GitSyncService.ets:2465`). Bridge dispatch `call()` resolves `OP_HANDLERS[op]` (`:2688`) and invokes `handler(args)` (`:2695`); `OP_HANDLERS.clone = opClone` (`:2652`). So the facade lands in `opClone` with `autoInit:'true'`, `skipProbe` undefined ⇒ the probe runs.
- There is exactly one `git.clone(` in the file (`:1473`) and no `v2Git('clone')` / second clone path anywhere in the source tree.

## Findings

### Blocker

None remaining. B1 (direct `clone` bridge op bypassing the probe) is fixed at the op itself, not only in the helper.

### Major

None.

### Minor

- **M1 — stale full-suite numbers in docs.** `docs/MODULES.md:344` and `docs/ROADMAP.md:491` still record full suite `2911 / 2908 pass / 3 fail / 0 skip` with the 3 failures attributed to the concurrent `mod-home-global-refresh`. The current tree is green (2924/2924/0/0; the concurrent files now pass 26/26). The 3-fail note is now stale — not a sync-module failure then or now, just an outdated gate snapshot.
- **M2 — `noMainProbe.test.mjs（10 例）` in `docs/MODULES.md:146` is stale.** The file now contains 15 tests (P1–P8, H1–H4, S1–S3); the per-file count `noMainProbe 15` is correct in the gate rows at `:344` / ROADMAP `:491`.
- **M3 — the bridge's empty-branch `message` is not consumed by the facade.** `ensureRepoInitialised()` (`GitSyncService.ets:767-769`) awaits the clone result and discards it, returning a generic `{ ok:true, message: syncedTextNow() }`. The user does **not** see 「失败」 (no throw), but the specific 首次同步 wording is rendered by the v2 cycle (`syncCycle.ts:66` `E_REMOTE_EMPTY_MESSAGE` → `:644` `bootstrapEmptyRemote`), not by this `message` field. Same nuance as r1 M2; harmless duplication, not a failure.
- **M4 — H1's quarantine-directory assertion is weak in isolation.** `quarantineNames(root)` (`noMainProbe.test.mjs:374`) is trivially `[]` because `fakeHost.rename()` is a no-op (`noMainProbe.test.mjs:56`). It is nonetheless logically covered: `quarantineBrokenRepo` is only reachable from clone's `catch` (git-bridge.js:1484), and H1 asserts `calls.clone === 0` (`:373`).

### Nit

- `remoteHasNoRefs()` / `isCloneQuarantineDir()` remain exported (`:2722-2724`) as historical predicates; dead in the live decision path, harmless.
- A v2 sync cycle can probe more than once (`v2Git('remoteLayout')` at `:2304`, then `ensureRepoInitialised` at `:1655` on the following op). Read-only and harmless; the within-decision double probe is avoided via `skipProbe`.
- Brief said `HEAD 1b7865f`; actual HEAD is `1ed6918`. Findings apply to the current working tree.

## Checklist

1. **The Blocker is closed — PASS.** Probe `:1448-1449` precedes clone `:1473`; single `git.clone` in file. Complete caller list into `opClone` found: (a) `OP_HANDLERS.clone` (`:2652`) via `call()` (`:2688/:2695`) ← the facade's `callBridge('clone', configArgs())` (`GitSyncService.ets:767`) — `skipProbe` undefined, autoInit `'true'`, so probe runs; (b) `ensureRepoInitialised()` `:1677` `opClone(args, true)` — preceded by its own probe at `:1655`; (c) `opPull()` `:1716` `opClone(args, true)` — after `ensureRepoInitialised(args)` at `:1712`, unreachable on the app path (autoInit ⇒ repo initialized or typed throw), reachable only on the legacy no-autoInit path; (d) `internals.opClone` export `:2729` — test/debug surface only, not app-reachable. All nine repo-needing ops funnel through `ensureRepoInitialised` (pinned by `syncWiring.test.mjs:928-929`). No app-reachable route clones before probing.
2. **`skipProbe` cannot be abused — PASS.** Only two internal call sites pass `true` (`:1677`, `:1716`), each after a probe/decision on the app path. `call()` invokes `handler(args)` with **one** argument (`:2695`), so a crafted bridge request cannot set the `skipProbe` parameter; `opClone` gates on `args.autoInit`, which the facade always sets (`GitSyncService.ets:2465`). Double probe within a decision is avoided (helper passes `skipProbe=true`); cross-op probes are read-only/harmless.
3. **Empty result semantics — PASS (M3 note).** Empty branch returns a resolved success shape with `emptyRemote:true` and first-run wording (`:1454-1458`), no throw ⇒ facade returns `{ok:true}` ⇒ user sees success, not 「失败」. Bootstrap wording is produced by `syncCycle.ts:66/644` on the v2 path; the bridge `message` itself is discarded by the facade.
4. **Handler tests are real — PASS (M4 note).** `callCloneHandler` calls `bridge.internals.opHandlers.clone(ARGS)` (`noMainProbe.test.mjs:354`); `opHandlers` is `OP_HANDLERS` (git-bridge.js:2730) whose `clone` is `opClone` (`:2652`) — the literal dispatch target, not a re-implementation. `loadBridge` swaps `globalThis.git` for a counting fake (`:71`) and restores it (`:72`), and `fakeHost.httpRequest()` throws (`:58`) ⇒ no silent fallthrough to a real clone/network; an unintended clone increments `calls.clone` (`:80`). H1 asserts `calls.clone === 0` (`:373`) and no `.git.clone-failed-*` (`:374`); H2–H4 cover typed master / normal clone / probe-throw.
5. **Source-shape pins — PASS (nuance).** S1 (`noMainProbe.test.mjs:435-443`) extracts `opClone`'s body and asserts `probeAt > 0 && cloneAt > probeAt` (`:438`), `git.init` present and no `quarantineBrokenRepo` in the decision slice (`:440-441`), and exactly two `await opClone(args, true);` (`:442`). `probeAt === -1` on the old code ⇒ S1 fails, so it is a real regression detector. S3 (`:482-496`) pins one `callBridge('clone'` (`:494`), no `v2Git('clone')`/`opClone`/`git.clone` in the facade, and `configArgs` `'autoInit': 'true'`; S3 does **not** distinguish old from new (the facade structure is unchanged) — it is a drift guard. The behavioral gates that fail on old code are H1 and P2.
6. **Legacy non-app callers — PASS (does not matter for the app).** Direct `clone` without `autoInit:'true'` keeps the old unguarded clone (`opPull` no-autoInit fallback `:1716`; direct `internals` calls), preserving old E_GIT test invariants. The only facade clone call is `GitSyncService.ets:767` with `configArgs()` (always `autoInit:'true'`); no other `callBridge('clone'` or `v2Git('clone')` exists. Not a hole for any real app path; it would only matter to a future non-app caller that omitted `autoInit`.
7. **Docs — PASS (M1/M2 nits).** Targeted 177 corrected in `MODULES.md:344` and `ROADMAP.md:491` (measured 177/177). B1 fix recorded (`MODULES.md:146/:344`, `ROADMAP.md:491`). 未装机 / unverified（安装版 `1000006`；设备检查随 `1000007`）present at `MODULES.md:146/:344` and `ROADMAP.md:491`. Force-wording narrowed: pre-existing `writeRef`/`resetHard` explicitly excluded as untouched (`MODULES.md:216`) and S1's ban scoped to decision slices (`noMainProbe.test.mjs:445-452`). `git diff docs/MODULES.md docs/ROADMAP.md` adds only this module's rows; no other module's row altered by this module. Stale 10-例 and 3-fail notes = M1/M2.
8. **Gates — PASS (with note).** `node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json` → exit 0. Targeted 8 files → **177 tests / 19 suites / 177 pass / 0 fail / 0 skipped**, matching 177. Full suite → **2924 tests / 409 suites / 2924 pass / 0 fail / 0 skipped**, exit 0 — no failures anywhere, including `homeGlobalRefresh.test.mjs` and `structureGuards` (those two files pass 26/26 when run alone); nothing failing in the sync files under review. `overlay.mjs status` → `applied=false`. `validate-app` 8/8 is per docs (`MODULES.md:344` / `ROADMAP.md:491`); not re-run here because it is outside the permitted `tsc`/`node --test` scope.

## Residual risk & unverified

- Not installed on-device: 1000006 is historical evidence; device recheck is 1000007. All evidence here is source inspection plus fake-git tests; P8 adds a real vendored isomorphic-git 1.25.3 byte-level check of an empty advertisement, but there is no real Gitee round-trip. `tsc` covers the `.ts` models; no HAP build (per scope).
- Concurrent `mod-home-global-refresh` is still in the tree; full-suite counts are a moving target (docs' 2911 vs measured 2924), though the suite is currently fully green.
- The no-`autoInit` legacy clone path is intentionally unguarded and is not reachable from the app; it remains a latent trap only for a future non-app caller.
- Bridge empty-branch `message` is observability-only for this path (M3); no user-visible regression because no failure is returned.

## Evidence log

- `node apps/arkui-schedule/tools/overlay.mjs status` → `[overlay] applied=false`.
- `git rev-parse HEAD` → `1ed691833bb55d13412a49bfc29e52c94888d3e3`; `git status --short` shows the uncommitted p0a lane plus concurrent modules.
- Source reads: `git-bridge.js` :60-84, :462-506, :1400-1689, :1690-1760, :1760-1785, :1925-1950, :2178-2372, :2630-2705, :2710-2749; `GitSyncService.ets` :750-774, :2448-2476; `noMainProbe.test.mjs` :1-496; `syncWiring.test.mjs` :920-944; `syncCycle.ts` :630-654, :66.
- Grep: single `git.clone(` occurrence (`:1473`); `git.clone` callers = `opClone` only; `CLONE_QUARANTINE_PREFIX` call site = `:1484` only; single `this.callBridge('clone'` (`GitSyncService.ets:767`); no `v2Git('clone'` in source; `autoInit` only at gate `:1448`, `:1649`, and `GitSyncService.ets:2465`.
- `node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json` → exit 0.
- `node --test <8 targeted files>` → 177/19/177/0/0/0 (ℹ tests 177 / suites 19 / pass 177 / fail 0).
- `node --test "apps/arkui-schedule/tools/test/*.test.mjs"` → 2924/409/2924/0/0/0, exit 0.
- `node --test homeGlobalRefresh.test.mjs structureGuards.test.mjs` → 26/2/26/0/0/0.
- `git diff -- docs/MODULES.md docs/ROADMAP.md` → additions only for `mod-p0a-no-main-probe` rows; no other module's row changed by this lane.
