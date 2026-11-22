# Review — mod-sync-single-flight

## Verdict

PASS — Both musts are implemented literally in the source and verified by spy assertions: a thrown cycle still performs all four re-reads in `finally` with exactly one status write and zero `commitStatus`, and every live caller (auto-sync, shell pull, pane pull, pane retry) shares the coordinator's single `inFlight` promise. Major findings remaining: 0

## Findings

### Blocker

None.

### Major

None.

### Minor

1. **Two ungated direct cycle calls survive in the dead fallback route.** `entry/src/main/ets/pages/Index.ets:279` (`onPullRefresh`) and `:305` (`retrySync`) still call `syncProtocolStore.runConfiguredCycle()` directly, outside the coordinator. They are **not reachable from any live user path** (EntryAbility loads `pages/Home`; no `pushUrl`/`replaceUrl` targets `pages/Index`), so they cannot double-run a cycle today. They are also deliberately pinned by pre-existing p0a guards (`syncInit.test.mjs:146,153,167`; `fixSyncRetry.test.mjs:121`; `syncWiring.test.mjs:678,822`), which is why the module left them untouched. Latent risk only: if the fallback route is ever re-enabled as a navigation target, those two paths would bypass the gate and could overlap auto-sync → two cycles / two commits.

2. **Full-suite count recorded in the docs is already stale (in the favourable direction).** The docs record `2937 / 2936 / 1` with the single failure at `credentialHygiene.test.mjs:177`; my rerun yields **2937 / 2937 / 0 / 0**. The concurrent plugin lane rewrote `packages/dsh-dots/src/sync/repoRoot.ts` (mtime `2026-11-22 14:13:47`, just before this review) to inject a logger instead of a static `console.log`; grep for `console.(log|info|warn|error)` in that file now returns no match, and `credentialHygiene.test.mjs` alone passes 11/11. The failure is in any case not caused by this module (it owns no `packages/**`); the row was accurate when written but is no longer reproducible.

3. **The four re-reads inside `finally` are not individually exception-shielded** (`model/homeGlobalRefresh.ts:198-213`). If a *reload hook itself* threw, later re-reads would be skipped. This is **not** the stated failure case — a thrown *cycle* is fully handled — and all live hooks are defensive (Home only increments `@State` ticks; `SchedulePane.reload()` at `:529-553` and `loadSummary()` at `:795-807` have internal try/catch). Recorded as robustness residue, not a defect against requirement (i).

### Nit

`docs/MODULES.md` §5 and the `docs/ROADMAP.md` single-flight bullet still name `packages/dsh-dots/src/sync/repoRoot.ts:114` as the failing line; that line reference is obsolete after the concurrent lane's fix (Minor 2).

## Checklist

1. **Catch/finally literal read — PASS.** `model/homeGlobalRefresh.ts:189-214`: `try { result = await hooks.runCycle() }` (L189-190); `catch` (L191-194) contains **no `return`**, only `thrown = true; thrownReason = reasonOf(error)`. All four re-reads live inside `finally` (L195-214): `reloadSchedule` L198-200, `reloadDots` L201-203, `reloadCloudChat` L204-206, status L207-213. `commitStatus` is in the `else` branch of `if (thrown)` (L211-213), so it is unreachable on the throw path; the throw path calls only `reportFailure(thrownReason)` once (L209). No double-report at the ETS layer: `Home.ets:140-143`, `SchedulePane.ets:355-357` and `:388-390`, and the `recordWriter` fallback `homeGlobalRefresh`-supplied hooks at `recordWriter.ets:136-138` each write exactly one `syncStatusStore` surface; the `.catch()` handlers (Home none, `SchedulePane.ets:392-395`, `recordWriter.ets:141-144`) only catch *coordinator-level* errors, which a typed cycle throw never becomes. HGR-11 (`test.mjs:298-313`) adds negative guards: catch must not contain `\breturn\b`, must not contain any reload/report token, and each of `reloadSchedule`/`reloadDots`/`reloadCloudChat`/`reportFailure` must appear exactly once in `finally`.

2. **Single gate — PASS (with Minor 1).** Every real call site of `syncProtocolStore.runConfiguredCycle()` in `entry/src/main/ets/**` was enumerated (full table below). Four are gated via a `runCycle` override passed to `globalRefreshCoordinator.runOnce(...)`: `recordWriter.ets:122`, `Home.ets:121`, `SchedulePane.ets:344`, `SchedulePane.ets:381`. Two are ungated: `Index.ets:279`, `Index.ets:305`. Reachability check: both `main_pages.json` files register `pages/Index` (`main/resources/base/profile/main_pages.json:3`, `harmony/resources/base/profile/main_pages.json:3`), but `EntryAbility.ets:108` calls `windowStage.loadContent('pages/Home', ...)`, and a repo-wide grep of `pushUrl|replaceUrl` finds **zero** targets of `pages/Index` (all targets are `pages/Edit`, `Detail`, `Settings`, `SettingsSync`, `Chats`, `ChatDetail`, `Instances`, `RemoteControl`, `routeToRemote()`). Therefore `pages/Index` is a registered-but-unlinked fallback and **cannot double-run a cycle in any real user path**. Judgment: acceptable as-is; re-enabling that route later would reintroduce a genuine second gate.

3. **Auto-sync routing — PASS.** `git diff` on `recordWriter.ets` confirms the only functional change is inside `triggerSync()` (L115-145); `writeRecord`/`deleteRecord`/`restoreRecord` and `writeV2()` L78-105 are byte-identical: park via `outboxStore.enqueue()` before `apply()`, `outboxStore.remove()` on success, `triggerSync()` on both success and failure, `E_V2_WRITE_PARKED` retained. `triggerSync` remains private; public API unchanged. The old `syncProtocolStore.runConfiguredCycle().then(...)` chain is gone — the cycle now sits in a `runCycle` async override (L121-123) and the only chain is `void globalRefreshCoordinator.runOnce(overrides).catch(...)` (L140-144). HGR-12 asserts no `.then` (`test.mjs:350-351`). Pre-`Home.aboutToAppear` fallback (L125-139) merely fills `markSyncing`/`commitStatus`/`reportFailure` when `isConfigured()` is false; `isConfigured()` (homeGlobalRefresh.ts:113-115) only reads `configured !== null` and adds no second gate.

4. **Follower semantics — PASS.** A mid-cycle caller takes the shared-promise branch `homeGlobalRefresh.ts:146-149`, awaits `this.inFlight`, and returns `leader:false, cycleInvoked:false` with the leader's `ok`/`reason`; the three reloads plus status happen exactly once inside the leader's `execute()`. HGR-12 (`test.mjs:316-354`) holds a real promise gate, calls `runOnce` twice, and asserts via spy `cycleCountOf()===1`, `commits.length===1`, `log === ['syncing','cycle','schedule','dots','cloudChat','status']`, `pullOut.leader===false`, `pullOut.cycleInvoked===false`, `pullOut.ok===true`, plus a loop asserting all four entry points contain `globalRefreshCoordinator.runOnce(`. Gate release on throw: `runOnce` L166-171 `try { return await task } finally { this.inFlight = null; endExclusive(this.run, GLOBAL_REFRESH_ACTION) }`; the `hooksOf()` throw path also calls `endExclusive` at L160-163 before `inFlight` is ever set. HGR-05 L170 and HGR-11 L295 assert `isRefreshing()===false` after a thrown cycle — no deadlock.

5. **No new failure surfaces — PASS.** No `showToast`/`promptAction` was added anywhere in this module's diff. The pure model contains neither token (grep; asserted by HGR-04 L158, HGR-10 L268, HGR-11 L296, HGR-12 L352-353). HGR-07 L210-213 pins the shell pull and spinner-reset paths, HGR-10 L251-268 pins both pull paths and the model. HGR-11 L277-314 asserts on a thrown cycle: `log` order `syncing, cycle, schedule, dots, cloudChat, failure`, each of the four hooks exactly once (L287-289), `failures.length===1` (L290), `commits.length===0` (L292), `ok===false`, `reason` verbatim. Only `syncStatusStore` renders failure.

6. **Guard integrity — PASS.** `git diff` on `homeGlobalRefresh.test.mjs` shows HGR-01..10 IDs unchanged and no existing assertion deleted or weakened. HGR-02 was *strengthened* at L112-123 to pin the ordered list `['reloadSchedule','reloadDots','reloadCloudChat','commitStatus']` inside `execute()`'s `finally`; HGR-06 was *strengthened* at L188-191 to pin exactly one `private inFlight:` and one `Promise<GlobalRefreshOutcome> | null`. HGR-11/HGR-12 are additions. Verified by rerun: 195/195 targeted pass, including all HGR tests.

7. **Gates — PASS.** `overlay.mjs status` was checked first: `applied=false`. `tsc -p apps/arkui-schedule/tools/tsconfig.json` → exit 0. Targeted 7 files (`homeGlobalRefresh`, `shellLayout`, `paneLayout`, `indexHeader`, `uiTokens`, `structureGuards`, `syncWiring`) → **195 tests / 8 suites / 195 pass / 0 fail / 0 skipped**. Full suite → **2937 tests / 409 suites / 2937 pass / 0 fail / 0 skipped** (better than the expected `2937/2936/1`; see Minor 2 — the formerly failing `credentialHygiene.test.mjs:177` now passes because the concurrent plugin lane removed its `console.log`). `validate-app` → **8/8** (JSON5/JSON 70, relative imports 551, main static imports 751, pages 12, rawfile/git 2). All figures are from fresh reruns in this review, not copied from the docs.

8. **Docs — CONCERN.** `docs/MODULES.md` §1/§2/§5, `docs/ROADMAP.md` and `docs/UI-DESIGN.md:627` contain only **added** rows/lines in `git diff` — no existing row altered. Every new single-flight row carries a concrete revert path, `未装机 / unverified`, `安装版 1000006`, `设备检查随 1000007`, and `syncProtocolStore / GitSyncService / syncStatusStore / SettingsSync / repoVisibility* / test-vectors/** / packages/**` strict no-touch. `UI-DESIGN` gained **exactly one** honest sentence (`:627` "刷新失败时列表仍会被重新读取，失败只在状态行显示一次。"), consistent with the code. Concern limited to Minor 2: the full-suite `2937/2936/1` figure and the `repoRoot.ts:114` line reference in those rows are no longer reproducible in the current tree (external lane change, favourable direction).

## Every call site of runConfiguredCycle (table)

| file:line | gated? | reachable in a live path? |
| --- | --- | --- |
| `entry/src/main/ets/services/recordWriter.ets:122` (`triggerSync` → `runCycle` override → `coordinator.runOnce`) | **Yes** — coordinator's single `inFlight` | **Yes** — every `writeRecord`/`deleteRecord`/`restoreRecord` triggers post-write auto-sync |
| `entry/src/main/ets/pages/Home.ets:121` (`configure` → `runCycle`, consumed by `onGlobalPull` at `:179` via `runOnce`) | **Yes** | **Yes** — shell pull; Home is the `loadContent` entry page |
| `entry/src/main/ets/pages/panes/SchedulePane.ets:344` (`onPullRefresh` → `runCycle` override → `runOnce`) | **Yes** | **Yes** — pane pull-down gesture |
| `entry/src/main/ets/pages/panes/SchedulePane.ets:381` (`retrySync` → `runCycle` override with `ctx` → `runOnce`) | **Yes** | **Yes** — failed-outbox "重试同步" from the status row |
| `entry/src/main/ets/pages/Index.ets:279` (`onPullRefresh`, direct await) | **No** — bypasses coordinator | **No** — fallback page registered in both `main_pages.json` but never a `pushUrl`/`replaceUrl` target; `loadContent` is `pages/Home` |
| `entry/src/main/ets/pages/Index.ets:305` (`retrySync`, direct await with `ctx`) | **No** — bypasses coordinator | **No** — same fallback-only route; also pinned by p0a guards |

Excluded from the table: `services/syncProtocolStore.ets:267` is the method *declaration*, not a call site; matches in `homeGlobalRefresh.ts:16,51`, `recordWriter.ets:111`, `SchedulePane.ets:15,330,363`, `Index.ets:272,293` are comments.

## Residual risk & unverified

- **Ungated fallback route (Minor 1):** no live path today, but `pages/Index` remains registered in both `main_pages.json` files. Re-enabling it as a navigation target would create a second, concurrent cycle path against auto-sync. Two cycles / two commits would then be possible; not a current defect.
- **Re-read hook throwing:** `finally` L198-213 is not individually guarded; a throwing reload would skip later reads. Not triggered by a thrown *cycle*; current hooks are defensive.
- **Early auto-sync before `Home.aboutToAppear`:** the fallback only supplies status hooks (no three-list reload) because those panels do not exist yet. The single gate still holds; the four-surface guarantee applies to the configured path.
- **Unverified by construction (per module scope):** no build, no overlay application, no device install. ArkTS compile/gesture behaviour and the 1000007 device check remain `unverified`; only TypeScript/Node-level gates were rerun here. `overlay applied=false` confirmed before any test.
- **Source-only checks:** HGR-02/HGR-06/HGR-07..HGR-12 partly pin ArkUI source shape with regex, not runtime; that limitation is declared in the test file header and is unchanged by this module.

## Evidence log

- `node tools/overlay.mjs status` (from `apps/arkui-schedule`) → `覆盖层：未应用…` / `[overlay] applied=false` — checked **first**, before any test.
- `git diff --stat` / `git status --short` — confirms the 8 in-scope modified files plus concurrent plugin/repo-privacy lanes; no writes performed by this review.
- `read` of `model/homeGlobalRefresh.ts` (L1-225), `services/recordWriter.ets` (L1-186), `pages/panes/SchedulePane.ets` (L1-1151), `pages/Home.ets` (L90-169, L172-201), `pages/Index.ets` (L255-324), `tools/test/homeGlobalRefresh.test.mjs` (L1-354).
- `git diff -- <the 4 scoped source/test files>` — used for the literal catch/finally and call-routing review, guard-integrity comparison and no-touch verification.
- `grep runConfiguredCycle` over `entry/src` — 15 matches; 6 real call sites classified in the table above.
- `read` of both `main_pages.json` files; `grep pushUrl|replaceUrl|pages/Index` over `entry/src/main/ets` and `entry/src` — no navigation target of `pages/Index`; `grep loadContent` in `EntryAbility.ets` → `pages/Home` at L108.
- `node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json` → `TSC_EXIT=0`.
- `node --test` on the 7 targeted files → `tests 195 / suites 8 / pass 195 / fail 0 / skipped 0`, `TARGETED_EXIT=0`.
- `node --test "apps/arkui-schedule/tools/test/*.test.mjs"` → `tests 2937 / suites 409 / pass 2937 / fail 0 / skipped 0`, `FULL_EXIT=0`.
- `node --test apps/arkui-schedule/tools/test/credentialHygiene.test.mjs` → `tests 11 / pass 11 / fail 0`; `grep console.(log|info|warn|error)` on `packages/dsh-dots/src/sync/repoRoot.ts` → no matches; file mtime `2026/11/22 14:13:47`.
- `node apps/arkui-schedule/tools/validate-app.mjs` → `✅ 全部通过：8/8 条规则…`, `VALIDATE_EXIT=0`.
- `git diff -- docs/MODULES.md docs/ROADMAP.md docs/UI-DESIGN.md` and `read` of `docs/UI-DESIGN.md:620-627` — docs verification; exactly one new UI-DESIGN sentence at `:627`.
- Only file written by this review: `C:\Users\GWL\Desktop\itwillclaude\dsh-sync-suite\docs\REVIEW-sync-single-flight.md`.

---

## Delta (r2)

**Scope of this round:** only the precedence delta in `apps/arkui-schedule/entry/src/main/ets/model/homeGlobalRefresh.ts`, `tools/test/homeGlobalRefresh.test.mjs`, and the hook wiring in `pages/Home.ets` / `services/recordWriter.ets`. The r1 review above is not rewritten; the gate figures below supersede r1's now-obsolete `195`/`2937` numbers.

### Delta verdict

**PASS — Major findings remaining: 0**

The rule is implemented literally and no privacy-lane import was introduced. Every thrown cycle still performs the four ordered re-reads, and the failure step (`homeGlobalRefresh.ts:250-267`) is exactly the claimed three-way exclusive dispatch: privacy code ⇒ `reportRepoBlocked(code)` only; already-blocked + generic throw ⇒ **no status write**; plain throw ⇒ `reportFailure(reason)` once. `markSyncing` is skipped only for the already-blocked case (`:225-228`). The delta builds cleanly against the committed privacy contract `ad1d83c`.

### HGR-13 assessment — PASS

`homeGlobalRefresh.test.mjs:359-411` executes all three cases with spies, not prose:

- **(a) `:364-381`** — `isRepoBlocked: () => true` + `E_IO` throw ⇒ `status.writes === []` (`:379`), `status.text === PRIVACY_TEXT` (`:380`), filtered log `['cycle','schedule','dots','cloudChat']` (`:378`). `markSyncing` is proven skipped: it would have pushed `'syncing'` into `writes` and set `'同步中…'`.
- **(b) `:383-398`** — thrown `E_REPO_PUBLIC`, `isRepoBlocked: () => false` ⇒ `privacyWrites === ['E_REPO_PUBLIC']` (`:396`), `reportFailure` never called (it would have pushed `generic:…`), privacy text present (`:397`), three reloads intact (`:398`).
- **(c) `:400-405`** — inverse plain throw without privacy state ⇒ `plain.failures === ['E_IO: 网络不可达']`, `commits.length === 0`.
- `:407-410` statically pin the real wiring in `Home.ets:145-149` and `recordWriter.ets:140-143`; both were verified present in source.

The "four re-reads still always run" part is independently held by HGR-11 (`test.mjs:286-289`) and HGR-12 (`:338`) for the success path.

### HGR-11 strictness — PASS, not weakened

The only edit to HGR-11 is a legitimate retarget for the new second, mutually exclusive failure site. All original runtime guarantees remain verbatim: ordered log including exactly one `'failure'` (`:286-289`), `probe.failures.length === 1` (`:290`), `commits.length === 0` (`:292`), no `return` in `catch` (`:305`), and `reportFailure` still forbidden inside `catch` (`:306-308`). The structural check at `:310-313` now pins the three reload hooks exactly once each (dropping `reportFailure` from that list), and `:314-316` replaces it with an **exact count of two** `hooks.reportFailure(` call sites plus a comment that only one can execute per run. This is a precise pin, not a loosening: a third site or removal of either branch would fail it, and single-write-per-cycle is asserted at runtime by HGR-11 `:290` and HGR-13 `:379/:396/:404`. No assertion was deleted without an equal-or-stronger replacement.

### Getter read-only / no second source of truth — PASS

`isRepoBlockedStatus` (`homeGlobalRefresh.ts:79-84`) reads only `snapshot.state`, accepts `RepoBlockSnapshotLike | null | undefined`, returns `false` on absent data, and writes nothing. It imports nothing from the privacy lane (only `syncGuard` at `:21-22`). `repoBlocked(hooks)` (`:117-119`) merely invokes the injected hook; Home (`:145`) and the recordWriter fallback (`:140`) both inject `isRepoBlockedStatus(syncStatusStore.snapshot())`, and `syncStatusStore.snapshot()` is documented read-only (`syncStatusStore.ets:277`). `blockedAtStart` is a local per-invocation boolean — never cached on the coordinator. The two literal codes at `homeGlobalRefresh.ts:87-88` match `repoVisibility.ts:18,22` exactly and are used only to *classify* thrown strings (`:91-99`), never to write state. No second source of truth was created.

### Stale "syncing" risk — PASS

`syncProtocolStore.ets` contains **no** `setSyncing` call (grep: no matches), so the injected cycle cannot write "同步中…" by itself. The only sync-flow writers of `setSyncing` are Home's `markSyncing` (`Home.ets:123-125`) and the recordWriter fallback (`recordWriter.ets:128-130`), both gated by `!blockedAtStart` (`homeGlobalRefresh.ts:226`). If state were `syncing`, `isRepoBlockedStatus` would be false, so `markSyncing` would run and a generic throw would still write `reportFailure` — no stale syncing can survive. With a blocked state, nothing writes "同步中…" and the throw path writes nothing (`:259-261`), so the privacy rendering from `syncStatusStore.snapshot()` (`syncStatusStore.ets:315-325`) remains. The pull spinner is independent and reset on both branches (`Home.ets:355-364`). Residual only: `repoBlocked()` is evaluated at `:225` outside `try`; a throwing `isRepoBlocked` hook would skip the four re-reads, but the injected implementation is a documented never-throwing snapshot read.

### Is the privacy string provably the only writer? — YES (within the shipped contract)

`syncStatusStore.setRepoBlocked` (`syncStatusStore.ets:222-230`) is the sole writer of `KEY_STATE='repo_public'|'repo_unknown'` and `KEY_REPO_BLOCK_AT`; the "已停止上传" text is derived from those keys by the snapshot renderer (`:315-325`). `fromCycle` delegates privacy codes to the same setter (`:209-210`). The delta's `reportRepoBlocked` hooks (`Home.ets:146-149`, `recordWriter.ets:141-143`) call only that setter and introduce no new string literal; HGR-13's `PRIVACY_TEXT` is a test fixture. **Qualifier (pre-existing, not introduced by this delta):** on a *non-thrown* generic result, `commitStatus` → `fromCycle` → `setFailed` (`:212-213`, `:241-248`) can overwrite a blocked state. The concrete case is `syncProtocolStore.ets:268-272`: an `E_SYNC_UNAVAILABLE` result is returned *before* `guardPush()` at `:276`, so a persisted block plus an early unavailable cycle would render a generic failure. This lives in the committed privacy lane / store, is outside the delta bytes, and is not covered by HGR-13; recorded as residual risk, not a delta defect.

### Builds against committed contract — PASS

`git log` shows `ad1d83c` (privacy gate) committed and its files no longer dirty. The delta adds no import from that lane, and its duplicated code literals match the committed constants exactly. `tsc` 0, `validate-app` 8/8 and the full suite green confirm the dependency surface is coherent.

### Delta gate tails (fresh reruns)

- `overlay.mjs status` → `[overlay] applied=false` — checked first.
- `tsc -p apps/arkui-schedule/tools/tsconfig.json` → `TSC_EXIT=0`.
- Targeted 7 files → `tests 196 / suites 8 / pass 196 / fail 0 / skipped 0`, `TARGETED_EXIT=0` (expected 196/196).
- Full suite → `tests 2938 / suites 409 / pass 2938 / fail 0 / skipped 0`, `FULL_EXIT=0` (expected 2938/2938/0/0).
- `validate-app` → `✅ 全部通过：8/8 条规则…`, `VALIDATE_EXIT=0`.

### Delta residual risk

- The pre-guard `E_SYNC_UNAVAILABLE` overwrite path described above (committed lane, not delta bytes).
- HGR-13's case (a) proves the coordinator writes nothing; it does not exercise the real `syncStatusStore` instance end-to-end (ArkUI cannot run in Node). The store-level evidence is source inspection of `:222-230` and `:315-325`.
- All ArkTS/真机 behaviour remains `unverified`; no build, no overlay application, no device install in this round.

---

## Delta (r3)

**Scope:** only `apps/arkui-schedule/entry/src/main/ets/services/syncStatusStore.ets` and `services/repoVisibilityChecker.ets`, plus the new HGR-14 in `tools/test/homeGlobalRefresh.test.mjs`. Baseline is the committed privacy lane `ad1d83c`; `git status` confirms just those three files dirty and `repoPrivacyGate.test.mjs` untouched. Earlier sections are not rewritten. The r3 store fix closes the residual risk recorded at the end of Delta (r2).

### Delta verdict

**PASS — Major findings remaining: 0**

Enforcement now lives in the store, so every failure writer is covered regardless of route. Block clearing requires a fresh passing check, never fabricates a success, and is exercised by HGR-14 against the real production class body.

### 1. Store-level guard — PASS

- `repoBlockedNow()` (`syncStatusStore.ets:199-202`) reads only the safe `stateOf()` view and matches `repo_public`/`repo_unknown`; `repoBlockCodeOf()` (`:205-216`) recognises the exact privacy codes or a `CODE:` prefix.
- `fromCycle()` guard at **`:255-257`** sits inside the failure branch, after the privacy-code branch (`:250-251`) and before the generic `setFailed` call (`:259`): already blocked + non-privacy failure (including the `E_SYNC_UNAVAILABLE` early return from `syncProtocolStore.ets:268-272`) returns `this.snapshot()` unchanged — text, state and `KEY_REPO_BLOCK_AT` all untouched. Privacy codes still refresh via `setRepoBlocked` (`:251`); success still goes to `setSynced` (`:261`). Reachable and correctly ordered.
- `setFailed()` guard at **`:295-301`**: privacy code ⇒ `setRepoBlocked` refresh; already blocked + generic ⇒ bare `return this.snapshot()` with no write; otherwise normal write. The generic branch never references `KEY_REPO_BLOCK_AT` (asserted by HGR-14 `:513`).
- **Every enumerated direct caller is covered** (grep-verified): `syncStatusStore.ets:259` (inside the already-guarded `fromCycle`, doubly covered), `:325` (`setPending` → `setFailed`), `:330` (`setError` → `setFailed`); `recordWriter.ets:137` (`setFailed`), `:148` (`setPending`); `Home.ets:141` (`setFailed`); `Index.ets:284` (`setFailed`), `:312`, `:403` (`setPending`); `SchedulePane.ets:356`, `:389` (`setFailed`), `:393`, `:508` (`setPending`). All funnel through the guarded `setFailed` at `:294`; none writes the status keys directly.

### 2. Sticky against time only; clear on fresh evidence — PASS

- `clearRepoBlock()` (`:224-233`) is a no-op unless blocked, then clears `KEY_STATE`, `KEY_REASON`, `KEY_REPO_BLOCK_AT`, sets `live=false`, and returns `snapshot()`. With `live=false`, `snapshot()` (`:337-347`) falls back to `bootSurface(this.restore(), stateOf()==='syncing')` — the persisted last real result or 「尚未同步」. It never calls `setSynced`, never calls `commit`, and never writes `KEY_LAST_AT` (`:318` is the only writer of that key, inside `setSynced`). HGR-14 `:514` pins both absences.
- `repoVisibilityChecker.ets` `runCheck` **returns early on a cached hit** (`:114-117` → `cachedRepoVisibilityDecision`) before any store call. `clearRepoBlock()` is reached only at `:127`, after a real `fetchRepoVisibility` (`:118`) and `applyRepoVisibilityDecision` (`:123`) and only when `decision.ok` (`:124`). A cached or merely aged verdict therefore **cannot** clear a block; only fresh passing evidence can. Time alone never writes the store.
- Clearing cannot fake 「已同步」: HGR-14 (d) asserts `TEXT_NEVER`, no 「已同步」, `lastAt` sentinel `'09:17'` unchanged and block stamp `''`. If a genuine earlier success was persisted, the fallback shows that old real `HH:MM` — truthful, not fabricated.

### 3. HGR-14 — PASS (runs production code; two directions are regression guards)

`homeGlobalRefresh.test.mjs:413-519` executes the **real production method bodies**, not a re-implementation:

- It reads the actual `.ets` sources (`:417-418`), cuts the literal `SyncStatusStore` class by brace matching (`:421-424`), the real key-constant block (`:425-426`) and the real `two`/`hhmm` helpers (`:427-428`), then transpiles that exact text with `ts.transpileModule` (`:429-431`).
- Dependencies injected into `new Function` (`:439-448`) are the **real compiled production modules** `.build/model/syncStatusPersist.js` and `repoVisibility.js` (`TEXT_NEVER`, `bootSurface`, `commitStatus`, `readStatus`, `SYNC_STATUS_KEY`, both codes, `repoBlockStatusText`); only the platform `AppStorage` and storage IO are faked (`:434-452`). Any drift in the extraction anchors fails the test loudly.
- **(a) `:456-471`** — blocked + `E_SYNC_UNAVAILABLE` fromCycle leaves state/text/stamp identical, no 「失败：」, and a direct `setFailed('E_IO…')` is also refused with the same stamp. **Fails on pre-fix behaviour** (no guard at `:255` or `:295`).
- **(b) `:474-485`** — blocked + `E_REPO_PUBLIC` refreshes the stamp; **(c) `:488-494`** — blocked + success still yields 「已同步 · HH:MM」. These two **already passed on baseline**; they are deliberate regression guards pinning the carve-outs so the new guards do not over-block, not discriminators of the fix. The claim that *every* direction fails pre-fix is therefore too strong, but this is not a defect.
- **(d) `:497-508`** — `clearRepoBlock()` ⇒ `TEXT_NEVER`, no 「已同步」, `lastAt` sentinel unchanged, stamp `''`. **Fails on pre-fix behaviour** (method absent ⇒ TypeError). `:511-518` additionally pin the guard locations and the existence of bypassing direct callers.

### 4. No loosening — PASS

`git diff` against `ad1d83c` shows only additions in `homeGlobalRefresh.test.mjs`; HGR-11 (`:298-317`) and HGR-13 (`:359-411`) are byte-identical to their r2 versions. `repoPrivacyGate.test.mjs` is not dirty and still passes **11/11** (fresh rerun). No privacy-lane assertion was deleted or weakened.

### 5. Gate tails (fresh reruns; overlay checked first at `applied=false`)

- `tsc -p apps/arkui-schedule/tools/tsconfig.json` → `TSC_EXIT=0`.
- Targeted 7 files → `tests 197 / suites 8 / pass 197 / fail 0 / skipped 0`, `TARGETED_EXIT=0` (expected 197/197).
- `repoPrivacyGate.test.mjs` → `tests 11 / pass 11 / fail 0 / skipped 0`, `PRIVACY_EXIT=0`.
- Full suite → `tests 2939 / suites 409 / pass 2939 / fail 0 / skipped 0`, `FULL_EXIT=0` (expected 2939/2939/0/0).
- `validate-app` → `✅ 全部通过：8/8 条规则…` (relative imports 552, main static imports 752 — +1 each from the new checker import), `VALIDATE_EXIT=0`.

### Delta (r3) residual risk

- `setSyncing()` and `setSynced()` themselves carry no block guard. Live paths are protected because their callers are `markSyncing` hooks skipped by the coordinator when blocked (`homeGlobalRefresh.ts:226`); the one remaining direct caller, `Index.ets:278`, is on the dead fallback route documented in the r1 review. If that route is ever re-enabled, it could overwrite a block with 「同步中…」.
- HGR-14 transpiles the real source but runs against a fake `AppStorage`; real ArkTS/device storage behaviour remains `unverified`. No build, overlay application or device install in this round.
- The store's `repoBlockCodeOf` matches exact code or `CODE:` prefix, while the pure coordinator's helper matches the code anywhere in the reason; no live path relies on the divergent case, and the privacy-code fallback passes the bare code, so this is a harmless classification difference.
