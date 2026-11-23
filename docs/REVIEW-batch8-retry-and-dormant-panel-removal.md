# REVIEW — batch 8: retry-control removal + dormant-panel removal

- **Reviewer role:** independent read-only reviewer (`planner-b9/review-b8`)
- **Baseline:** committed `43d7277`; reviewed the 21 uncommitted modifications listed by `git status`
- **Date:** 2026-11-23 (Asia/Shanghai)
- **Constraints honoured:** no source edits, no builds, no git writes, no device, no `~\.dsh\**`, no subagents. Only this review file and logs under `.tmp\` / `packages\dsh-dots\.tmp\` were written. Three targeted `node --test` invocations were run (cap = 3).

## Verdict

**CONDITIONAL PASS — one Major hygiene exception blocks a clean commit.**

Both removals are real, scoped and well-guarded: the App's reachable/shipped surface has no manual retry control, the route decision is documented and defensible, the build/ABC artifact proof verifies independently, the plugin deletion is provably dormant-only with byte-identical shipped shape, and the shared audit file is coherent and green. The single hard finding is **M1**: `apps/arkui-schedule/AppScope/app.json5` rides a `versionCode` bump (1000009 → 1000011) that the batch scope explicitly forbids. The retarget guard is sound but has a self-test coverage/locale-scope gap (C1); the fallback route is registered but has no in-app navigation (C2).

Recommendation: exclude/revert `AppScope/app.json5` from this batch, then ship. No code change is required for the two modules themselves.

## Findings

### M1 — `AppScope/app.json5` rides an undeclared version bump (hygiene FAIL)
`apps/arkui-schedule/AppScope/app.json5:5` changes `"versionCode": 1000009` → `1000011`. The scope states "AppScope\app.json5 must not ride". It is uncommitted and would be included with the batch. No other `docs/**` or `AppScope/**` file is touched. This is scope contamination rather than a functional defect, but it is a direct violation of an explicit hygiene gate.

### C1 — retarget guard gap (defence in depth, not a current defect)
`assertNoManualSyncRetryControl` (`apps/arkui-schedule/tools/test/syncWiring.test.mjs:107`) does fail for all three required re-add shapes (see Checklist 3), but:
- its self-test (`syncWiring.test.mjs:654`) mutates only cases (a) and (b); the benign-label + sync-capability branch (c) is implemented but **never mutation-tested**;
- `SYNC_CAPABILITY` (`syncWiring.test.mjs:70`) only matches direct textual names (`retrySync|runConfiguredCycle|runAction(|retryFromStatus(|testConnection(|runOnce(`). An indirect handler (`onClick(() => this.startSync())` where `startSync` later calls `runConfiguredCycle`) is not caught;
- `SCHEDULE_SURFACE` (`syncWiring.test.mjs:67`) is limited to two files. A control re-added to `Home.ets` or a new component is not seen by this helper (the shared audit scans a broader reachable set, so this is a layers-of-defence gap, not a hole in the aggregate suite).

### C2 — fallback route is registered but has no in-app navigation
`pages/Index` is registered in both `main_pages.json` files (`.../src/main/.../main_pages.json:3`, `.../src/harmony/...`) and documented as a fallback (`pages/Index.ets:1`, `EntryAbility.ets:15-16`), but the audit's own row records "no in-app navigation" and `EntryAbility.ets:108` loads `pages/Home`. Keeping it is defensible (it is a live ~1,890-line schedule surface and the proven reference for `SchedulePane`), but its fallback status is documentary/registration-level only.

## Checklist

### 1. App removal is real and total in the reachable/shipped surface — **PASS**
- `重试同步` is absent from `Index.ets` and `SchedulePane.ets` (byte grep over all `entry/src/main/ets`).
- `Index.retrySync()` deleted (diff `Index.ets`, former lines 289-315); no other caller — `retrySync` in `Index.ets` is zero hits. `this.retrySync(` appears only as the declaration in `SchedulePane.ets:403`; zero UI callers.
- Shipped `SyncStatusRow` (`SchedulePane.ets:1721-1732`) is a pure read-only `Text(this.syncStatus.text)` with no `onClick`/`Button`; fallback `SyncStatusRow` (`Index.ets:1614-1629`) likewise after the diff removed the `Text('重试同步')` + `onClick` pair.
- Both pull-to-refresh gestures survive: `Index.ets:1696` + `:1769`; `SchedulePane.ets:1810` + `:1829`, all wired to `onPullRefresh()`. Automatic/gesture/named triggers remain (APP-6 in the shared audit; `Home.ets`, `recordWriter.ets` untouched).
- `syncCycle.ts:194-198, 418, 445` copy no longer names the deleted control.

### 2. Route decision is honest — **PASS** (defensible; C2 noted)
`EntryAbility.ets:108` → `loadContent('pages/Home', ...)`; `pages/Index` stays registered in both source `main_pages.json` files (`:3`) with a written reason at `pages/Index.ets:1` and `EntryAbility.ets:15-16`. The page is not a stub: 1,889 lines with full schedule UI, two `Refresh` wrappers and a read-only status row. A registered page whose one removed control was a manual-retry affordance is **not** a dead route; it remains the documented fallback/reference surface. No dead-route verdict.

### 3. Retargets catch re-adds; copy honest; four retargets assert new wording — **CONCERN** (C1)
- (a) same label re-added → `raw.includes('重试同步')` at `syncWiring.test.mjs:110`; self-test `:654-663` proves the throw.
- (b) renamed `立即同步`/`同步` label wired to a sync handler → `RETRY_WORDS` (`:68`) + capability scan; self-test `:665-669` proves the throw.
- (c) innocuous `Button` label whose `onClick` calls `runConfiguredCycle`/`retrySync` → `handlerBodies` + `SYNC_CAPABILITY` over `onClick|onTap|onAction|onRetry` (`:117-127`). By inspection it fails, but **no self-test mutation covers this branch** — the named gap.
- `syncCycle.ts` copy is honest: next step now says "页面就绪后会自动重试…请下拉刷新" / "稍后会自动重试或下拉刷新" and never promises a control. Four retargets **assert new wording**, not just delete old assertions: `fixSyncRetry.test.mjs:85-91` (`doesNotMatch` + `match(/自动重试|下拉刷新/)`), `syncInit.test.mjs:104-107`, `syncEmptyBootstrap.test.mjs:491-494`, `syncWiring.test.mjs:638-645` + `:768-779`.
- My targeted run: `syncWiring.test.mjs` 56/56, exit 0, including the `40b` self-test.

### 4. Artifact proof — **PASS** (independently verified)
`apps/arkui-schedule/.build-logs/build-20261123-175756.log`: `> hvigor Finished :entry:default@CompileArkTS... after 1 min 30 s 891 ms` (executed); **zero** `UP-TO-DATE … CompileArkTS` lines (19 other UP-TO-DATE tasks, none CompileArkTS); `BUILD SUCCESSFUL in 1 min 57 s 160 ms`. `.tmp/modules-app-retry-removal.abc` = **1,828,944 B**; `重试同步` = **0** hits in both UTF-8 and UTF-16LE; positive controls present (UTF-8: `同步中` 2, `已同步` 2, `下拉刷新` 7, `失败` 187, `syncStatus` 18, `pages/Index` 5, and `retrySync` 2 — the last is the intentionally retained dormant method).

### 5. Plugin deletion is safe — **PASS** (independently verified)
- Reachability (`packages\dsh-dots\.tmp\reach-dormant.mjs` / `.out`, pre-edit): roots `apply, DotsPanel`; 48 dormant declarations incl. `SettingsPanel`/`RemotePanel` + ~44 helpers/constants; sole registration is `ctx.slots.register(..., DotsPanel)` (`phase1-registration.txt`); RPC layer UI/React hits: **NONE**.
- Current `src/client.js` and `dist/client.js`: all deleted symbols absent; the only `SettingsPanel`/`RemotePanel` occurrences are two removal-note comments each (`:15`, `:824`).
- Shipped shape: I rebuilt the comparison from `shipped-shape-{before,after}-dormant.json` — `registration` **identical**, `tree` **identical** (3,058 chars both); only `seams` shrank by the two dead test seams (`RemotePanel`, `SettingsPanel`).
- i18n: reach script listed **246** dormant-only keys; `zh.json`/`en.json` 324 → **78** keys each, sets identical; `locale.test.mjs:119-131` pins 16 shipped keys non-empty, 5 dormant keys absent, exact count 78; general parity test (`:132-141`) passes.
- No shipped assertion weakened: `client-module`, `client-single-section`, `lean-panel-guard` G9, `locale`, `client-gitee-host-decides`, `client-remote-render` retargets replace dead-panel mounts with shipped `LeanSyncGroup`/`LeanRemoteGroup`/seam-absence pins, mostly stronger.
- 16 deleted tests, all dead-panel-only: `client-remote-render.test.mjs` (11: 10 `RemotePanel:*` + the `remote.*` locale-parity test), `client-render.test.mjs` (2: both mount `'SettingsPanel'`), `rollback-ux.test.mjs` (3: all mount `Panel.SettingsPanel || Panel`). Their subjects were exclusively the deleted panel's render/diff/rollback UI. Registration coverage survives in `lean-panel-guard` G9 / `client-single-section`; general locale parity survives in `locale.test.mjs`. No shipped coverage lost.
- My targeted run: 6 plugin files (locale, lean-panel-guard, client-single-section, client-render, client-remote-render, client-module) 34/34, exit 0.

### 6. Shared file coherence — **PASS**
`packages\dsh-dots\test\sync-control-audit.test.mjs` carries both intents without contradiction: APP-7 added (`:602-610`: raw literal absent, no `retrySync` declaration/call, read-only row), the Index table row closed as "CLOSED by mod-app-retry-removal" (`:36`), `pages/Index.ets` added to `APP_REACHABLE_SETTINGS_FILES` (`:106-108`) while deliberately absent from `APP_ALLOWED` (`:72-74`), and the dormant-panel rows/PLUGIN-4 note rewritten to "REMOVED by mod-plugin-dormant-panel-removal" (`:43-45`, `:681-684`). No stale "FINDING, NOT FIXED" or "KEEP (dormant)" statement remains for either subject. My targeted run: 11/11, exit 0.

### 7. Hygiene — **FAIL** (M1 only; all other items PASS)
- `docs/**`: no changes from either lane (this review file is the only docs write, explicitly permitted).
- `AppScope\app.json5`: **riding** — M1.
- Plugin dist window: exactly one `dist/*.js` differs from HEAD (`distcheck-dormant-panel.out`: "DIST-WINDOW: 1 dist/*.js differ"); `git status` confirms only `dist/client.js`.
- `client.js` ↔ `dist/client.js` parity: test green; both 67,407 B, identical content.
- Combined suite `.tmp\gates-planner-b9-batch8.out`: **tests 4003 / pass 4001 / fail 0 / skipped 2**. Arithmetic consistent: 3149 (app) + 854 (plugin) = 4003; 4001 + 2 skips = 4003. Count drop explained: prior plugin suite `gates-silence-audit.out` = 870 → 854 after deletion, a drop of **16** = exactly the 16 deleted dormant tests above.
- Cross-check logs all confirmed: app 3149/3149/0/0; app targeted 130/130; plugin 854/852/0/2; plugin targeted 37/37; validate 8/8; credential 11/11.
- No `.tmp-*` created at repo roots by this batch. The pre-existing gitignored `apps\arkui-schedule\.tmp-accept` is not uncommitted and is not part of the batch.

## Residual & unverified

- **Device / real GUI / rendered pixels:** unverified. All UI claims are source-shape or React-stub snapshot proofs; no real-device gesture, launch, or visual check was performed (consistent with the audit's own scope note).
- **ArkTS compile:** not re-run by this reviewer (no builds permitted). Trust is placed in the lane's `build-20261123-175756.log`, which I verified as a real executed CompileArkTS + BUILD SUCCESSFUL, plus the compiled ABC inspection.
- **C1 self-test gap:** case (c) branch is code-correct but mutation-unproven; indirect wrapper calls and resource-based labels are outside the textual guard.
- **C2 route reachability:** no in-app navigation to `pages/Index` was found; "fallback" is a documented registration state, not a exercised navigation path in this review.
- **Measurement note:** `dist/client.js` baseline measured 205,255 UTF-8 bytes via `git show` (the stated 205,256 differs by one trailing-newline byte); current size is exactly 67,407 B. Immaterial to the finding.
- **Deleted `remote.*` wording pins** (e.g. `remote.unsupported` /需先准备/) went away with the dead panel; generic non-empty + dict/JSON parity coverage remains, but the exact legacy wording is no longer asserted.
