# REVIEW — batch 7: probe removal + sync-ui silence audit

Independent read-only reviewer (`planner-b9/review-b7`). Baseline `e0ce224`; working tree read at 2026-11-23.
No source edits, no builds, no git writes, no device, no `~\.dsh\**`. Two targeted `node --test` runs only.

## Verdict

**PASS — 0 Major, 2 Minor (hygiene doc registration; audit App-1 enumeration), 3 Nit (two stale titles/comments, audit finding note under-specifies retarget).**

The 「测试连接」 removal is real in the shipped panel, the auth-failure login-name flip survives on the **save** path, and the RPC is honestly kept as internal/dormant with proof of UI unreachability. The four retargets preserve or increase strength; the 10-test audit guard is variegation-sensitive and records, rather than blesses, the App `Index.ets` violation. All claimed gate numbers are confirmed. The only items needing Lead attention are bookkeeping/attribution, not code defects.

## Findings (judged 1–7)

**1. Removal real and complete — PASS.** `packages/dsh-dots/src/client.js:4440-4445` renders exactly one Btn in the lean sync group (`tr('lean.actions.save') → doSave`); `doTest()` is deleted (old `:4380-4397` → explanatory comment `:4381-4383`), and `busy === 'test'` is gone from `leanStatusText` (`:4276`). `locale/zh.json` and `locale/en.json` both drop `lean.actions.test`, and both built-in dictionaries in `client.js` drop it too. Repo-wide grep finds `lean.actions.test` **only** in test assertions (`lean-panel-guard.test.mjs:419,421`; `sync-control-audit.test.mjs:131`), never in `src/`, `locale/` or `dist/`. The legacy `actions.test` key is intentionally kept per scope. Shipped `DotsPanel` (`:4803-4821`) mounts only `LeanSyncGroup` + `LeanRemoteGroup`; the legacy `SettingsPanel` with its own `doTest` (`:2076-2094`) is exposed solely as a test seam (`:4827`). No shipped button issues `testConnection`: `lean-panel-guard.test.mjs:433-438` loops every shipped button and asserts no `testConnection` action, and `sync-control-audit.test.mjs:629-645` asserts the whole `BANNED_ACTIONS` set (incl. `testConnection`) absent per button. Both green in my runs.

**2. Nothing needed lost — PASS.** `doSave` (`client.js:4343-4379`) still performs the auth flip at `:4355-4356` (`if (leanIsAuthFailure(result)) setNeedLogin(true)`) on a **save** failure; the behavioural claim is unchanged because the old `doTest` flip was byte-for-byte the same branch. Retargeted `client-git-username.test.mjs:187-241` proves 401/403-on-save expands the login field, exact hint copy, 3 inputs, blur persists `username` without the token, and reload restores it; `lean-panel-guard.test.mjs:364-372` covers the numeric-403 regex branch on save. Status row still renders (`client.js:4436`; asserted at `client-git-username:250`, `client-render:302-306`, audit `PLUGIN-2:624-626`). Save-time private-repo precheck untouched: `src/rpc.ts:433-443` (git diff of `rpc.ts` is comment-only), and G6a/G6b pass. Remote group's five pairing controls and zero-config QR path untouched (`LeanRemoteGroup` not in diff; exact labels pinned at `lean-inventory:354-357`, `lean-panel-guard:411-412`; G7 green).

**3. RPC surface honestly kept — PASS.** `src/rpc.ts:478` implements `testConnection`, `:1240-1241` registers `case 'testConnection'`, and `:474-477` marks it internal/dormant (mirrored in `dist/rpc.js`). It was **not** the button's only caller: dormant legacy `doTest` at `src/client.js:2076-2094` still calls `rpcCall('testConnection')` at `:2078` (reachable only via the `DotsPanel.SettingsPanel` test seam, not the shipped tree), plus the audit inventory (`:43`) records public-RPC tests calling it directly. Hence "keep" is justified. Unreachability is proved by audit `PLUGIN-4:647-662` (exactly one slot injection/one section registration = `DotsPanel`; `DotsPanel` body contains no `SettingsPanel`) together with `PLUGIN-3` and `lean-panel-guard G5:433-438`.

**4. Retarget strength — PASS (0 weakened).**
- `client-git-username.test.mjs`: C2/C3 trigger moved `testConnection` → `saveSettings` 401/403; every downstream assertion (copy, field count, username persistence, reload) intact. C4 count `['保存','测试连接'] → ['保存']` is coupled with an exact-array assertion, so a re-added button fails. Unchanged strength.
- `client-lean-inventory.test.mjs`: 7 → 6 **with** explicit absence assertion `labels.includes('测试连接') === false` (`:357`) — not a silent count weakening; header corrected to match reality.
- `client-render.test.mjs`: exact two-label array → single label (`:297`); strength preserved. **Nit**: test title at `:283` still says 「两动作」 (stale).
- `lean-panel-guard.test.mjs`: G3 retargeted; G5 **strengthened** with whole-tree absence, locale-key absence, source no-key, RPC-presence and per-button no-`testConnection` assertions (`:411-438`). Net stronger.
- **Nit**: `src/client.js:4293` doc comment still says 「保存 / 测试连接」 (cosmetic only).

**5. Audit guard real — PASS (1 Minor).** The allowed lists are in one place: `APP_ALLOWED :69-75`, `PLUGIN_ALLOWED :77-85`, `APP_TRIGGERS :88-98`. Each of the 10 tests fails on a plausible regression: APP-1 unlisted/changed control in the three enumerated files; APP-2 `Text('重试同步')` on a reachable file; APP-3 `retrySync()`/`runAction()` bound to a click; APP-4 clickable status row; APP-5 mounting `SettingsHost` or a manual-sync label in its sheet; APP-6 removal of a named auto/gesture trigger; PLUGIN-1 re-added probe or remote-group drift; PLUGIN-2 unlisted i18n key / banned label / button status row; PLUGIN-3 any shipped button issuing a banned RPC action; PLUGIN-4 registering a second section or the dormant panel. App scope is reachable settings/panes (`APP_REACHABLE_SETTINGS_FILES :101-113`), excluding dormant `SettingsHost`. The `Index.ets` violation is recorded at `:36` and `:46-48`, and `Index.ets` is **not** in the reachable list — the finding is reported, not blessed. **Minor**: APP-1's 「unlisted control fails」 is exact only for `SettingsSync.ets`/`SyncSection.ets`; `SchedulePane.ets` is covered by a `Refresh`-count check (`:520-523`), so a new *non-banned, non-sync* control there would not fail APP-1 (APP-2/3 catch sync-capability ones).

**6. Index.ets finding genuine and correctly unfixed — PASS (1 Nit).** `apps/arkui-schedule/entry/src/main/ets/pages/Index.ets:1652` has `Text('重试同步')` with `.onClick(() => { this.retrySync(); })` at `:1656-1658` — a clickable manual retry, a genuine violation of the standing rule. Route `pages/Index` is registered at `main_pages.json:3`, but `EntryAbility.ets:108` loads `pages/Home` and repo-wide grep finds **no** `router.pushUrl` to `pages/Index` (only comments calling it a fallback route deliberately kept). Verdict: **violation genuine, NOT in-app reachable** (only direct/deep-link route launch or a future navigation would expose it). Positively pinned by `syncWiring.test.mjs:565` (`/Text\('重试同步'\)/`) and `:676-679` (also `outboxStore.retry(entry.intentId)`, `syncProtocolStore.wiredContext`, `runConfiguredCycle(ctx)`). **Nit**: the audit note at `:36` names only `:565/:676`; a removal must also retarget the companion wiring assertions at `:677-679` (and the `retrySync()` method). Correctly left unfixed: App files are out of this lane's scope.

**7. Hygiene — CONCERN (2 Minor, attribution only).**
- Dist window exactly `dist/client.js` + `dist/rpc.js` — PASS (`git diff --stat`). `dist/client.js` byte-parity: git blob hashes are identical to `src/client.js` (`383cb1e..28b4907`) and `client-loader-id.test.mjs:62-70` was green in my run; `distcheck-probe-removal.out` = 74 files / 0 mismatch (its `DIST-EXTRA-FILES: client.js` line is constant in all historical distchecks — benign). No `.tmp-*` at repo root — PASS.
- No App **source** (`entry/src/main/ets/**`) changed — PASS. However `apps/arkui-schedule/AppScope/app.json5:5` has an uncommitted `versionCode` bump 1000009 → 1000011; this is outside both modules' declared file sets and needs Lead attribution to another lane.
- **Minor**: `docs/MODULES.md` has +11 lines that ARE this batch's registration (the `mod-plugin-sync-probe-removal` row, the 2026-11-23 standing-rule paragraph, cross-touch rows and log rows cited by `sync-control-audit.test.mjs:4-9`). So 「no docs/** from these lanes」 does not hold at working-tree level. This is bookkeeping, not code, but should be explicitly acknowledged/attributed by the Lead.

**Numbers cross-check — all confirmed.** `gates-silence-audit.out` 870/868/0/2; `targeted-probe-removal.out` 45/45; `gates-silence-audit-targeted.out` 10/10; `.tmp/gates-planner-b9-batch7.out` 4018 total / 4016 pass / 0 fail / 2 skip; both credential logs 11/11. My own runs: retargeted four + byte-parity file = 41/41; audit file = 10/10.

## Checklist

| # | Check | Result | Evidence |
|---|-------|--------|----------|
| 1 | Removal complete in shipped panel; no `lean.actions.test`, sync group `['保存']`, no shipped button calls `testConnection` | **PASS** | `src/client.js:4440-4445`,`:4276`; `locale/*`; `lean-panel-guard:411-438`; audit `PLUGIN-3:629-645` |
| 2 | Auth flip on save; status row; precheck; remote 5 + QR untouched | **PASS** | `client.js:4355-4356`,`:4436`; `rpc.ts:433-443`; G6a/G6b/G7 green |
| 3 | RPC implemented/registered/dormant, not button's only caller, UI-unreachable | **PASS** | `rpc.ts:478`,`:1240-1241`,`:474-477`; `client.js:2076-2094`,`:4827`; audit `PLUGIN-4:647-662` |
| 4 | Four retargets preserve strength | **PASS** (3 Nit) | `client-git-username:187-250`; `client-lean-inventory:354-357`; `client-render:283,297`; `lean-panel-guard:364-438` |
| 5 | Audit guard real; finding recorded not blessed | **PASS** (1 Minor) | audit `:69-98`,`:505-662`, finding `:36`,`:46-48` |
| 6 | Index.ets violation genuine, not in-app reachable, unfixed, pinned | **PASS** (1 Nit) | `Index.ets:1652-1658`; `main_pages.json:3`; `EntryAbility.ets:108`; `syncWiring:565,676-679` |
| 7 | Hygiene | **CONCERN** (2 Minor) | `docs/MODULES.md` diff; `AppScope/app.json5:5`; distcheck/byte-parity green |
| — | Gate numbers | **PASS** | five `.tmp` logs + two own `node --test` runs |

## Residual & unverified

- **unverified**: no device / GUI / real network run; all claims are source- and test-level. Byte parity is proven against the in-repo build renderer, not a fresh `build.mjs` invocation by this reviewer (no builds permitted).
- **unverified**: no mutation testing was performed (read-only constraint); "each assertion fails on regression" is argued from assertion shape, not by injecting faults.
- **attribution required (Lead)**: `docs/MODULES.md` (+11) carries this batch's registration despite the "no docs" hygiene expectation; `AppScope/app.json5` versionCode bump is outside both file sets.
- **residual risk**: dormant legacy `SettingsPanel.doTest` (`client.js:2076-2094`) and RPC actions remain in the shipped bundle (unreachable). Deleting them later is a separate lean-panel lane; the audit intentionally does not pin their internals.
- **residual risk**: `Index.ets` remains reachable by direct route launch; a future removal must retarget `syncWiring.test.mjs:565` and `:676-679` together.
