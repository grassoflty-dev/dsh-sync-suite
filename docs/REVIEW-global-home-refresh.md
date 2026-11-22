# Review — mod-home-global-refresh

Independent read-only review. HEAD `56b08ae`; scope = the uncommitted `mod-home-global-refresh` lane only. `packages/dsh-dots/**`, `docs/PLUGIN-GAPS.md`, and the `mod-plugin-tools-v2` rows appended to `docs/MODULES.md` / `docs/ROADMAP.md` are another lane and were not reviewed.

## Verdict

PASS — the two home entry points share one in-flight promise and one `syncProtocolStore.runConfiguredCycle()` call, the four reloads are ordered with status last, the sync failure has a single renderer, all requested gates reproduce exactly, and the L-03 window widening is a legitimate accommodation that does not hide a regression. Major findings remaining: 0

## Findings

### Blocker

None.

### Major

None. Specifically, the three conditions that would have forced FAIL were checked and did not occur:

- Two pulls cannot run two cycles: `inFlight` is set synchronously before the first `await` (`model/homeGlobalRefresh.ts:152-153`), so a second call awaits the same promise (`homeGlobalRefresh.ts:134-137`) — verified by HGR-03 (`tools/test/homeGlobalRefresh.test.mjs:113-133`, `cycleCountOf() === 1`, follower `leader=false`/`cycleInvoked=false`/`ok=true`).
- A pull during an auto-sync cycle is not silently dropped: the coordinator reuses `syncProtocolStore.runConfiguredCycle()` (`Home.ets:112-116`, `SchedulePane.ets:341-345`) and the pull invokes it normally (see Residual risk for the overlapping-cycle caveat).
- Failure cannot render in two places on this path: `SyncStatusRow()` (`SchedulePane.ets:1669-1694`) is the only renderer; both pull paths are toast-free (`Home.ets:168-175`, `SchedulePane.ets:333-359`); HGR-10 (`homeGlobalRefresh.test.mjs:234-256`) and H-7 (`indexHeader.test.mjs:342-358`) pin it.

### Minor

1. **Thrown cycle error skips the three list reloads.** `execute()` returns immediately after `reportFailure()` when `runCycle()` throws (`model/homeGlobalRefresh.ts:168-176`), before `reloadSchedule`/`reloadDots`/`reloadCloudChat`/`commitStatus` (`:177-189`). The status path is still reached, so checklist 2's stated requirement is met, but the old `onPullRefresh` reloaded unconditionally after its `try/catch`, so on an exception path the lists can now stay stale until the next refresh or a successful typed result. Typed failure results do run all four reloads (`commitStatus` receives the failed result). Not a Major because `runWiredCycle()` converts the ordinary failure modes into typed results; only unexpected throws take this branch.

2. **The coordinator's gate is private and does not interlock with app-wide sync.** It owns a fresh `idleRunState()` (`homeGlobalRefresh.ts:89`) rather than sharing the `GitSyncService`/`syncController` run state. A shell pull overlapped with a recordWriter post-save cycle or a startup pull can therefore run two `runConfiguredCycle()` calls concurrently. This is pre-existing (the pane pull had no gate at all before this module) and the module does not claim to gate auto-sync, but "one cycle per pull" should be read as "one cycle across the two home pull entry points", not "one cycle app-wide".

3. **New ids are static source-shape guards, not executable ArkUI tests.** L-26 (`shellLayout.test.mjs:601`), P-28 (`paneLayout.test.mjs:710`), H-7 (`indexHeader.test.mjs:342`), U-S9 (`uiTokens.test.mjs:693`) are real, falsifiable assertions (removing the `Refresh` wrapper, a second toast, or a tick prop makes them fail) but they cannot exercise the gesture, ArkTS compilation, or landscape rendering. The test file discloses this itself (`homeGlobalRefresh.test.mjs:6-7`). Device truth remains `unverified`.

### Nit

- `SchedulePane.ets:320` still contains a pre-existing `同步失败：${outcome.message}` toast in `onBridgeReady()` (startup pull). It is untouched by this diff and is not on the global-refresh failure path; noted only because a text search for a "second failure surface" will hit it.
- `docs/MODULES.md` / `docs/ROADMAP.md` also gained `mod-plugin-tools-v2` rows in the same working tree; those belong to the other lane. This module's rows were pure additions — no existing row was edited.

## Checklist

1. **Exactly one cycle per pull — PASS.** Reused entry: `Home.ets:112-116` and `SchedulePane.ets:341-345` both call `syncProtocolStore.runConfiguredCycle()`; no sync service, gate, union, outbox, or writer file is in the diff (`git diff --stat` touches only the four UI files, five test files, and three docs). Single flight: `runOnce` checks `inFlight` first (`homeGlobalRefresh.ts:133-137`), then `beginExclusive` before any `await` (`:139`, HGR-06 at `homeGlobalRefresh.test.mjs:160-175`), sets `inFlight = execute(hooks)` (`:152-153`), and clears gate + promise in `finally` (`:154-159`). Deadlock/stuck gate: none — followers only `await` the shared promise and never re-acquire the gate; `runOnce`'s `finally` releases on success, typed failure, throw, or a throwing reload/commit hook; `endExclusive(this.run, GLOBAL_REFRESH_ACTION)` matches the normalized owner in `syncGuard.ts:274-285`. Follower is not a silent no-op (HGR-03).

2. **Four reloads in order, same result — PASS (Minor 1 caveat).** `execute()` order `markSyncing → runCycle → reloadSchedule → reloadDots → reloadCloudChat → commitStatus` (`homeGlobalRefresh.ts:163-189`), exactly pinned by HGR-02 (`homeGlobalRefresh.test.mjs:106-111`). Each reload is a disk/store re-read: `reload()` + `loadSummary()` in SchedulePane (`:346-349`, `:402-405`), `reload()` from chatStore in Dots/Cloud (`:92-95`, `:66-70`); no hook calls a network/sync API (HGR-09 at `:217-232`, P-28). Status is last in both entry paths (Home commitStatus bumps only `statusRefreshTick`, `Home.ets:130-136`; pane commitStatus writes its local mirror, `SchedulePane.ets:350-357`). A typed failure result still reaches `commitStatus` (HGR-04, `:135-146`); a thrown error reaches `reportFailure` (HGR-05, `:148-158`).

3. **One failure surface — PASS.** `SyncStatusRow()` renders `Text(this.syncStatus.text)` and gates the failed state on `this.syncStatus.state === 'failed'` (`SchedulePane.ets:1671-1689`); its data comes only from `syncStatusStore`. No `showToast`/`promptAction` or `失败：${...}` in `onGlobalPull`, `onPullRefresh`, `onRefreshing`, the watchers, or the pure model. HGR-10 (`homeGlobalRefresh.test.mjs:234-256`), HGR-04 (`:135-146`), and H-7 (`indexHeader.test.mjs:342-358`) pin the row, the toast-free paths, and the absence of a copied row in Home; p0a `syncWiring.test.mjs:866-883` (62b) still pins the same row. The only other `同步失败：` toast is the untouched startup-pull path (Nit above).

4. **Pane pull kept, same guard — PASS.** `SchedulePane.onPullRefresh` now calls `globalRefreshCoordinator.runOnce({...})` (`SchedulePane.ets:333-359`) instead of its own cycle; HGR-10 and P-28 pin it. `syncWiring.test.mjs` is unmodified in `git status`, and its 62-body probe still finds `setSyncing`, `await syncProtocolStore.runConfiguredCycle()`, `fromCycle`, `reload`, `loadSummary`, no `syncController.pullNow` inside `onPullRefresh` (`syncWiring.test.mjs:814-864`) because those calls now live in the injected hooks. Sync tests were not edited.

5. **Orientation / wrapper — PASS.** Exactly one `Refresh({ refreshing: $$this.globalRefreshing })` at `Home.ets:253`, wrapping the root Stack and closing at `:348-359`; both `if (!this.isCompact())` wide rail (`:258`) and `if (this.isCompact())` drawer rail (`:329`) are inside it, as are both content Stack markers. No new fixed-height or `layoutWeight` wrapper: only one `layoutWeight(1)` remains (`:297`), no numeric `.height(N)` in Home. Pinned by HGR-07, L-26, U-S9.

6. **Guards equal-or-stricter — PASS.**
   - **L-03 widening 900 → 1600 (`shellLayout.test.mjs:174-188`): legitimate.** L-03 asserts (a) no `Column(` between the root `Row() {` and the content `Stack({ alignContent: Alignment.TopStart })` (`:180-181`), (b) that content Stack has `.height('100%')` (`:186`), (c) no fixed vp `.height(N)` in the scanned region (`:187`). Measured against the stripped `build()` body, the content Stack's own `.height('100%')` sat at offset **685** at HEAD but is at offset **908** now; the old 900-char window ended 8 characters short and would have failed. The +223 shift is exactly the four new prop lines in the panel instantiation block (`Home.ets:273-293`: `globalRefreshTick: this.dotsRefreshTick`, `globalRefreshTick: this.scheduleRefreshTick`, `statusRefreshTick: this.statusRefreshTick`, `globalRefreshTick: this.cloudChatRefreshTick`). The `Refresh` wrapper sits *before* the anchor and the compact drawer sits after the target, so neither caused the shift. The window is still **anchored** to a specific marker — `stackAt`, the content Stack located after `Row() {` — not to the file start. Falsifiability is retained and partly strengthened: (a) and (c) still fail on a Column wrapper or a fixed vp height, and (c) now scans 700 additional characters. The one localized looseness is that (b)'s regex could be satisfied by the Row's `.height('100%')` at 984 or the scrim's at 1108 if the content Stack lost its own — but that build fails **L-02's anchored exact chain** at `shellLayout.test.mjs:147-155` (`CloudChatPane({…}) } → .width('100%') → .height('100%') → .layoutWeight(1)`), and the old 900 window already included the analogous sites (761/885) at HEAD, so no new weakness is introduced. L-03 does not and never did pin the Refresh wrapper; that contract is pinned by anchored assertions in L-26 (`shellLayout.test.mjs:601`, `^\s*Refresh...` at build start) and U-S9 (`uiTokens.test.mjs:693`), which fail if the wrapper is removed or moved. Suite-level verdict: equal-or-stricter; not a Major.
   - **SG-S4 / SG-S7 — PASS.** SG-S4 (`structureGuards.test.mjs:348-380`) still asserts all four panes exist, are instantiated, and carry `active` + `deepLinkId`; the expected key sets now *add* keys (Schedule 3→5, Dots/Cloud 2→3, Instances unchanged at 2) and the old `showTick` @Watch/onPageShow assertions remain at `:372-378`. SG-S7 (`:415-450`) retains the exact four-`@State` set, all read/render-site assertions, `deepLinkId`, `active`, Hidden keep-alive, single `aboutToAppear`, no `onPageShow`, and only extends the DotsPane assembly keys from `['active','deepLinkId']` to `['active','deepLinkId','globalRefreshTick']` (`:437-440`). No prop assertion became a subset.
   - **New ids — PASS (static, real).** L-26, P-28, H-7, U-S9 each fail on removal of the thing they pin; they are not tautologies, but they are source-shape only (Minor 3).

7. **No behaviour regressions — PASS.** No sync service/gate/union/outbox/writer/filter file is modified; `bindBridgeRunner` is idempotent (`gitRunner.ets:204-211`) so invoking it on every pull is the documented pattern. Pane `reload()`/`refreshQuery()`/filter code is untouched (diffs add only @Prop/@Watch hooks and swap the body of `onPullRefresh`). No timers or polling were added; auto-sync timing, record write path, and filter semantics are unchanged. No per-pane sync storm: watchers call `reload()` only, and each tick is bumped once per settled cycle.

8. **Gates — PASS, all reproduced.** `tsc -p apps/arkui-schedule/tools/tsconfig.json` exit 0. Targeted 8 files (homeGlobalRefresh + shellLayout + paneLayout + indexHeader + uiTokens + syncWiring + syncInit + fixSyncRetry): **189 tests / 6 suites / 189 pass / 0 fail / 0 skipped**. Full `node --test "apps/arkui-schedule/tools/test/*.test.mjs"`: **2924 tests / 409 suites / 2924 pass / 0 fail / 0 skipped** (`not ok` count 0). `validate-app`: **8/8** (JSON5/JSON 70, relative imports 538, main static imports 728, pages 12, rawfile/git 2). `node tools/overlay.mjs status` (run from `apps/arkui-schedule` before any work): **applied=false** (`覆盖层：未应用`). No failure was averaged away.

9. **Docs — PASS.** MODULES.md §1/§2/§5 adds one `mod-home-global-refresh` row with the full revert path (delete the two new files; unwind Home/pane hooks, L-26/P-28/H-7/U-S9/SG-S4·SG-S7 and the L-03 window; `git revert` after commit) and **未装机 / unverified（安装版 1000006；设备检查随 1000007）**. ROADMAP.md adds one handoff block with the same figures and status. UI-DESIGN.md §12 adds the contract: one pull covers the four git-dependent surfaces, one cycle, shared in-flight promise, fixed reload order, failure in one place. All cited numbers (189, 2924, 8/8, overlay false) match the rerun above. No pre-existing row was altered by this module.

## Residual risk & unverified

- **Unverified:** ArkTS compilation, real gesture handling of a root-level `Refresh` wrapping the shell, nested-pull interaction with the panes' own `Refresh` widgets, and portrait/landscape/compact rendering. Installed build `1000006`; device check deferred to `1000007`. Only static assertions and the pure Node model were executed.
- **Overlapping cycles (Minor 2)** can still occur between a manual pull and an auto-sync cycle; no data-corruption evidence, but not proven safe on device.
- **Thrown-error path (Minor 1)** leaves all three lists un-reloaded until a later successful/typed result; status text is still correct.
- Out-of-scope dirty paths were left untouched; the shared docs files contain the other lane's added rows, which were not reviewed or altered by this review.

## Evidence log

- `node tools/overlay.mjs status` @ `apps/arkui-schedule` → `applied=false` (preflight).
- `git rev-parse HEAD` → `56b08aeaf70d19e1b90b149cc9492f501f7c7947`; `git status --short` → in-scope files as listed in the scope statement, plus the other lane's dirty paths.
- `git diff` on `Home.ets`, the three panes, the five guard tests, and `docs/{MODULES,ROADMAP,UI-DESIGN}.md`; full reads of `homeGlobalRefresh.ts` (197 lines), `homeGlobalRefresh.test.mjs` (256 lines), `Home.ets:240-359`, `SchedulePane.ets:290-410,1655-1699`, `syncGuard.ts:108-152,246-285`, `syncProtocolStore.ets:255-304`, `gitRunner.ets:200-211`, `syncWiring.test.mjs:810-889`, `structureGuards.test.mjs:346-450`.
- L-03 measurement (read-only Node, same `stripComments`/`matchBrace` helpers as the test): HEAD content-Stack `.height('100%')` offset **685**, all three sites 685/761/885; working copy offset **908**, sites 908/984/1108; `build` length 3070; no numeric `.height(N)` in the tail. Difference +223 = the four added tick-prop lines.
- Gates: `tsc` exit 0; targeted 189/189/0/0; full 2924/2924/0/0 (0 `not ok`); `validate-app` 8/8; overlay `applied=false`.
- Only this file was written.
