# Review — mod-sync-ui-silence (Phase A)

Independent read-only review. Scope: `pages/panes/SchedulePane.ets`, `tools/test/{syncInit,syncWiring,homeGlobalRefresh}.test.mjs`, `tools/test/syncUiSilence.test.mjs`, `apps/arkui-schedule/docs/MOD-SYNC-UI-SILENCE.md`. Settings-page files, `model/syncCycle.ts`, `services/syncProtocolStore.ets`, `resources/rawfile/git/git-bridge.js` and `packages/**` are out of scope. No build, overlay, git write, subagent or device command was performed.

## Verdict

**FAIL** — the failed-state control really is gone, the pull gesture and the leader-only trigger log are intact and present in the built artifact, and the three retargeted guards were strengthened; but the new S2/S3 epic guard can be bypassed (an `ActionButton.onTap` sync control and a regex-literal/`this['retrySync']()` call evade every one of the five cases), and the reported HAP hash does not match the artifact — Major findings remaining: 3

## Findings

### Blocker

None. No sync-triggering control remains in `SchedulePane.ets`, and the pull gesture is not broken.

### Major

**M1 — S2/S3 do not see the pane's own control idiom (`ActionButton` + `onTap`).** `tools/test/syncUiSilence.test.mjs:101` only matches `Text('literal')` / `Button('literal')`; `:39-82` (`clickHandlerBodies`) only scans the literal marker `.onClick(`. This pane uses `ActionButton({ label: …, onTap: … })` for its primary actions (`SchedulePane.ets:1280,1518,2099`). Probe on `ActionButton({ label: '重试同步', onTap: (): void => { this.retrySync(); } })`: S2 label hits = `[]`, S3 `.onClick` markers = `0`, so all five cases pass while a real manual sync control is rendered. A regression that re-adds the tap-to-retry via the idiom already used in this file is invisible to this guard. (`S1` only inspects `SyncStatusRow()`; `S4` checks the gesture and status-row render sites; `S5` checks the log.)

**M2 — S3's balanced-paren scan is foolable, and `SYNC_CALL` misses indirect call forms.** `syncUiSilence.test.mjs:52-77` tracks `'`/`"`/backtick quotes and paren depth but treats `/…/` as ordinary characters; `SYNC_CALL` at `:27` only matches `name(` after a word boundary. Probes against the exact copied scanner: nested paren and nested string containing `)` are handled correctly (`detected=true`), but `.onClick(() => { const r = /a)b/; this.retrySync(); })` yields body `(() => { const r = /a)` with `detected=false`, and `this['retrySync']()` (plus `const f = this.retrySync; f()`) yields `detected=false`. Therefore "no sync trigger reachable from a UI click handler" is not established for those forms. The prompt's specific example (nested paren/string with `)`) is **not** a blind spot; the regex-literal and bracket/alias forms are.

**M3 — the reported HAP hash `11c2a802…` is false.** `entry/build/default/outputs/default/app/entry-default.hap` and `entry-default-unsigned.hap` are both 5,397,719 B (size matches), but SHA-256 is `f4f17f6fcda937ae271c95a6efe667bcbb4f9c94f82763db85f3697adebd8181` (MD5 `d8e8a059…`, SHA-1 `d94f0bd5…`). The string `11c2a802` occurs nowhere in the repository. The abc claim is accurate (3,094,992 B, SHA-256 `b9b4693ad2cdd26b66aa2f0bee72c4fc3cb6bb4c38ab58ba23c9a51bd20d9ccf`). The identity of the compiled HAP is therefore misreported in the evidence supplied with this batch.

### Minor

**m1 — `no bump` is contradicted by the working tree.** `AppScope/app.json5` is modified: `versionCode 1000007 → 1000008`. This file belongs to another lane, so it is not a Phase A defect, but the "overlay false, no bump" compile claim cannot be affirmed from the current tree.

**m2 — stale line numbers in the doc / Phase B anchor table.** `MOD-SYNC-UI-SILENCE.md:52` cites the pane gesture at `SchedulePane.ets:334-368`; the actual `onPullRefresh()` is `:352-389` after the Phase A comment/log insertion. `:108` cites `SyncSection.ets:238` for `label: '更多'` (actual `:169`) and `:966` for the single `SyncMoreSheet()` render (actual `:978`; `:966` is a comment). The settings lane is still editing these files, so re-anchor before Phase B.

**m3 — the user-visible "no manual sync control" is not true app-wide.** `pages/Index.ets:1652` still renders `Text('重试同步')` (the legacy fallback route). It is out of Phase A scope and deliberately pinned by `syncWiring.test.mjs:565,676`, so this is a scope/residual note, not a Phase A FAIL — but the user's requirement is only half met until Phase B / a fallback decision lands.

### Nit

`build-20261122-165534.log:1401` says `42 tasks in total: 41 executed, 1 up-to-date`; "0 UP-TO-DATE" is correct only for `CompileArkTS`, not for the build as a whole (`:entry:default@PreBuild` is UP-TO-DATE at line 10).

## Checklist

1. **The control is gone — PASS.** `git diff` shows deletion of the whole failed-state block (`Text('重试同步') … .onClick(() => { this.retrySync(); })`) from `SyncStatusRow()`. Current `SchedulePane.ets:1721-1736` contains only `Text(this.syncStatus.text)` (`:1723`) with the three-state `.fontColor` (`:1726-1728`); no `.onClick` and no `Button(` anywhere in the builder; grep finds `重试同步` only in explanatory comments (`:394,1718`).
2. **Gesture intact / not disguised — PASS.** `Refresh({ refreshing: $$this.refreshing })` at `:1810` → `.onRefreshing` → `this.onPullRefresh()` at `:1815`; the right pane's `Refresh` at `:1829` also routes to `onPullRefresh()` at `:1868`. `onPullRefresh()` at `:352` contains exactly one `globalRefreshCoordinator.runOnce({` (`:356`) and `runConfiguredCycle()` (`:366`). S2's disguise check (`syncUiSilence.test.mjs:110-112`) rejects a `Refresh(` followed within 120 chars by `.onClick(`; coverage limitation recorded in M1.
3. **Epic guard quality — FAIL.** S1/S2/S3/S5 each fail on the pre-change file (status row had `Text('重试同步')` + `.onClick`; S3 sees `retrySync(`; S5 sees zero `[sync-trigger]` lines); S4 is intentionally anti-over-removal and passes both before and after (asserts `Refresh`, `onPullRefresh`, one `runOnce`, `runConfiguredCycle`, and `SyncStatusRow()` in both `CompactBody` and `WideBody`). `node --test tools/test/syncUiSilence.test.mjs` = 5/5. S5's leader-only reasoning is sound (`homeGlobalRefresh.ts:186-213`, `execute()` calls `hooks.runCycle()` at `:233`, followers return at `:187-190`). But M1/M2 are real blind spots, so per the review rule this check is FAIL.
4. **Retry capability preserved — PASS.** `private async retrySync(): Promise<void>` at `SchedulePane.ets:403`; `git diff` shows the body (bindBridgeRunner → failed-intent `outboxStore.retry` → `wiredContext` → `runOnce(runCycle: runConfiguredCycle(ctx))` → commit/failure) is byte-identical, only comments changed. Grep finds no `this.retrySync()` call site in the pane; all six `.onClick` handlers (`:1276,1378,1391,1507,2095,2216`) are date-picker/new/AI-panel actions.
5. **Retargeted guards strengthened — PASS.** `syncInit.test.mjs:170-179`: `assert.match(row, /Text\('重试同步'\)/)` and `/this\.retrySync\(\)/` → `doesNotMatch` for all four manual words, for `.onClick(`, and for `this.retrySync()` pane-wide; positive `this.syncStatus.text` pin added. `syncWiring.test.mjs:867-885`: same conversion, both colour-state pins and both `CompactBody`/`WideBody` pins retained. `homeGlobalRefresh.test.mjs:251-275`: `assert.match(row, /重试同步/)` → four-word `doesNotMatch` + `.onClick` absence, with all original toast/single-gate assertions intact. No assertion was dropped.
6. **Trigger table honest — PASS.** Present: cold launch (`Home.ets:127-203` configure+`request()`, `:240-252` `onBridgeReady()`, `homeStartupSync.ts:83-160` one quota); after-save (`recordWriter.ets:100,105` → `triggerSync()` `:116-123` → `runConfiguredCycle()`); home pull (`Home.ets:267-269` `onGlobalPull()` → `runOnce()`; pane gesture as in #2). Missing: foreground (`Home.ets:227-231` only bumps `scheduleShowTick` + re-calls `request()`, which no-ops at `homeStartupSync.ts:83-89`; `EntryAbility.ets:121-122` only `hilog.info`); network regain (all `@kit.NetworkKit` imports are `http` clients — `SettingsSync.ets:20`, `GitSyncService.ets:29`, `deepseek.ets:25`, `repoVisibilityChecker.ets:10`, `aiFallbackRunner.ets:18`, `SettingsHost.ets:47`; no `NetConnection`/`netAvailable` listener). No non-existent trigger is claimed; only the line numbers in m2 are stale.
7. **`[sync-trigger]` log — PASS.** Exactly one `console.info('[sync-trigger] pull')` in the pane at `:363`, inside the `runCycle` injection of the leader-only `runOnce`; no interpolation/token/URL/`hilog`. S5's restricted set matches `credentialHygiene.test.mjs:30-35` and passes. Built artifact: `entry/build/default/intermediates/loader_out/default/ets/modules.abc` contains the literal exactly once; ZIP entry `ets/modules.abc` inside `entry-default.hap` (3,094,992 B) also contains it exactly once.
8. **Compile evidence — CONCERN.** `build-20261122-165534.log:1378` `Finished :entry:default@CompileArkTS... after 1 min 10 s 318 ms` (executed, not UP-TO-DATE); `:1399` `BUILD SUCCESSFUL in 1 min 24 s 525 ms`; `:1401` 41 executed / 1 up-to-date. HAP size 5,397,719 B and abc size/hash `b9b4693a…` verified; HAP hash claim `11c2a802…` is false (M3). Overlay state: `.platform-overlay/manifest.json` and `.building` both absent (`applied=false` equivalent); "no bump" see m1. A later successful build log `165906` also exists, so the on-disk artifact may be from either run; both compiled successfully.
9. **Gates — CONCERN.** Targeted `node --test tools/test/syncUiSilence.test.mjs`: **5 pass / 0 fail, exit 0** (reproduced by this reviewer). Executor-reported: `tsc` exit 0; full suite **3013 / 3013 / 0 / 0** — not independently reproduced here: `tools/tsconfig.json:22` has `outDir: .build` with no `noEmit`, so running `tsc` would write files beyond the single permitted deliverable, and the full suite was not re-run under that constraint. No failure can be named from the available evidence.

## Phase B anchor sanity (are the anchors real?)

Mostly real, but re-anchor before execution because the settings lane is still editing these files.

- Real: `SettingsSync.ets:805-816` `Text('查看状态')…runAction('status')`; `:817-828` `Text('测试连接')…testConnection()`; `:829-841` `if (canRetrySync(...)) Text('重试')…runAction(...)`; `SyncMoreSheet()` at `:784`; `testConnection()` at `:412`; `fixSyncRetry.test.mjs:143-159` R4 pins all three actions (currently a presence assertion to be inverted).
- Real (privacy analysis §3): `SettingsSync.ets:312` `checkNow`, `:332` `settingsStore.save`; `repoVisibilityChecker.ets:80-81` force `checkNow`, `:85-103` `guardPush(force=false)`, `:127` `clearRepoBlock`; `repoVisibilityGate.ts:51-61` dedupe, `:65-84` sticky; `syncStatusStore.ets:242` `clearRepoBlock`; `syncError.ts:688` `本地改动 …` inside `describeSyncStatus()` at `:672`; `SyncSection.ets:395` diagnostic region.
- Stale line numbers: doc `:108` `SyncSection.ets:238` → actual `:169`; doc `:108` `SettingsSync.ets:966` (single `SyncMoreSheet()` render) → actual `:978`. The three control anchors at doc `:105-107` are still exact.
- Not registered: `docs/MODULES.md` staged diff contains only plugin-lane rows; `mod-sync-ui-silence` is not registered yet, consistent with the doc's own note.

## Residual risk & unverified

- Real-device gesture feel and the status line after removal: **unverified** (no device command run).
- Guard evasion M1/M2 is demonstrated against copied scanner code, not by mutating the repo (read-only constraint).
- `tsc` 0 and full-suite 3013/3013/0/0 are executor claims, not reproduced here; no failure owner can be named.
- Which of the two successful builds (`165534`, `165906`) produced the current HAP is unresolved; the HAP hash claim does not identify it.
- `Index.ets:1652` fallback retry control and the three settings-page manual controls remain by design/scope; the user's "no manual sync" goal is not yet app-wide.
- `stripComments()` (`helpers/etsSource.mjs:29-33`) and `matchBrace()` (`:57-71`) are naive about string contents; a literal containing `//`, `{` or `}` could distort all source-scanning guards, not just this module's.

## Evidence log

- `read` / `grep` on `SchedulePane.ets` (2,249 lines by reader numbering), `syncUiSilence.test.mjs`, `MOD-SYNC-UI-SILENCE.md`, `build-20261122-165534.log`, `build-20261122-165906.log`, the three retargeted test files, `Home.ets`, `homeStartupSync.ts`, `recordWriter.ets`, `homeGlobalRefresh.ts`, `EntryAbility.ets`, `helpers/etsSource.mjs`, `credentialHygiene.test.mjs`, `indexHeader.test.mjs`, `SettingsSync.ets`, `syncError.ts`, `repoVisibilityChecker.ets`, `repoVisibilityGate.ts`.
- `git diff` (read-only): SchedulePane deletion of the retry block + one log line; three guard diffs presence→absence; `app.json5` version bump; staged `docs/MODULES.md` (plugin lanes only); `git status --short` (new: `syncUiSilence.test.mjs`, `MOD-SYNC-UI-SILENCE.md`).
- `node --test tools/test/syncUiSilence.test.mjs` → 5 pass / 0 fail / exit 0.
- `node --input-type=module -e` inline probes (no files written): S3 scanner on plain / nested-string / nested-paren / template-interpolation / regex-literal / bracket-call handlers; S2 label regex + `.onClick` count on an `ActionButton({label:'重试同步', onTap:…})` control.
- `Get-FileHash` / `Get-Item` on the two HAPs and three `modules.abc` copies; `ZipFile.OpenRead` in-memory read of `entry-default.hap::ets/modules.abc` for the literal count (no extraction, no file write).
- `.platform-overlay` manifest/marker existence check; repository-wide grep for `11c2a802` (zero hits).

## Delta (r2)

**Delta verdict: PASS — Major findings remaining: 0.** Test/doc-only round; `SchedulePane.ets` has the same six Phase A diff hunks as round 1 (no new `.ets` change), so the prior `CompileArkTS` green still covers the production source and no rebuild was required. M1 and M2 are closed with positive controls; M3 is retracted with an accurate tree-level artifact caveat.

**M1 closed.** `controlLabels()` (`syncUiSilence.test.mjs:196-205`) now collects positional `Text('…')`/`Button('…')` literals *and* `label:`/`text:`/`title:` component props with `'`/`"`/backtick quoting; `assertNoManualControl()` (`:239-256`) feeds those labels into the same word list. S6 (`:321-330`) asserts `['重试同步']` for the exact probe that previously returned `[]`, plus a `'新建'` negative control. I reproduced 8/8 locally: the positive control is now flagged. A tap-control regression written in the pane's own `ActionButton({label,onTap})` idiom can no longer pass S2.

**M2 closed.** `maskLiterals()` (`:42-125`) blanks strings, templates, line/block comments and regex literals length-preservingly; `regexCanStart()` (`:127-136`) uses the prev-significant-char/keyword heuristic, so `/a)b/` no longer truncates a handler. `handlerRegions()` (`:164-193`) balances on the masked text and widens handler props to `onClick/onTap/onAction/onSubmit/onPress/onChange`; `syncTriggered()` (`:208-225`) covers direct, `['name'](`, bare `onX: this.name`, `void this.name()`, and alias (`const f = this.runConfiguredCycle; f()`). S7 (`:332-353`) proves `console.info('tail')` stays inside the `/a)b/` handler body, flags all four indirect probes, and passes a benign `goToday()` handler; S8 (`:355-369`) injects the real idiom into a mutated copy of the actual pane and requires both `assertNoManualControl` and `assertNoSyncHandler` to throw. I reproduced 8/8: these are real positive controls, not vacuous guards. The round-1 nested-paren/nested-string case remains handled (S7's negative control).

**S4 untouched.** `syncUiSilence.test.mjs:279-292` is byte-for-byte the round-1 anti-over-removal assertion: both `CompactBody` and `WideBody` still render `SyncStatusRow()`, `RefreshableList` still has `Refresh({ refreshing: $$this.refreshing })` and `this.onPullRefresh()`, and `onPullRefresh()` still has exactly one `globalRefreshCoordinator.runOnce({` plus `syncProtocolStore.runConfiguredCycle()`.

**`.onRefreshing` exclusion — bounded, not a re-opened Major.** In ArkUI `.onRefreshing` is a `Refresh`-only attribute, so it cannot disguise a tap button (the forbidden control class); the gesture remains the sanctioned trigger and S4 pins its canonical path. Strictly, the exclusion is not airtight against a sync *call* inside a gesture body: an in-memory probe of `Refresh({…}).onRefreshing(() => { this.retrySync(); })` yields 0 handler markers, and no guard asserts every `onRefreshing` body routes through `onPullRefresh()`. That is a residual single-gate-observability note, not the original "button that does nothing" defect, so it does not re-open M1/M2.

**M3 statement is accurate.** `MOD-SYNC-UI-SILENCE.md:47-50` now states plainly that the HAP and `modules.abc` under `entry/build` are tree-level artifacts shared with concurrent lanes, their hashes are not module-level evidence, and the durable module evidence is the source diff plus the abc **name hit** `[sync-trigger] pull` exactly once. No hash string appears in that report (grep for `11c2a802|f4f17f6f|b00a7091|b9b4693a` hits no line there), and the round-1 M3 hash claim is explicitly superseded by this delta. The observed instability of the HAP SHA-256 at constant 5,397,719 B across lane builds is consistent with this caveat.

**Gate tails (this round).**
- Targeted: `node --test tools/test/syncUiSilence.test.mjs` → **8 tests / 8 pass / 0 fail / 0 skipped, exit 0** (S1–S8; reproduced by this reviewer).
- `tsc`: `.tmp/tsc-sync-ui-silence-a.out` is empty (executor reports exit 0; I did not re-run it because `tools/tsconfig.json:22` emits to `tools/.build`).
- Full suite: `.tmp/gates-sync-ui-silence-a.out:3854-3861` → **3016 tests / 3016 pass / 0 fail / 0 cancelled / 0 skipped / 0 todo** (Δ+3 = S6/S7/S8 over the round-1 3013). Verified from the retained log.
- Transient note: the "26 failures at 17:13 from a concurrent overlay build, clean after restore at 17:16:44" narrative is honest but **not persisted** in any repo artifact (searched `.tmp/*`, both review/module docs and `docs/MODULES.md`; no `17:13`, `17:16:44` or `26 fail` hit). The clean 3016 run is the one captured; this is an evidence-retention Minor, not a contradiction, and no failure owner can be named from a retained log.

**Delta residual risk:** real-device gesture feel and status rendering remain `unverified`; the transient-failure narrative is unrecorded; the `onRefreshing` body is outside the handler scan; `docs/MODULES.md` still has no `mod-sync-ui-silence` registration.
