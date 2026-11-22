# mod-sync-ui-silence — Phase A (schedule pane) + Phase B input

Status: Phase A written, not installed, **unverified** on device. Phase B (settings page)
is **not implemented** here — the settings files are locked by another lane this round.
Registration in `docs/MODULES.md` is left to the Lead to avoid a write collision.

## 0. What "silent" means (definition, not an absence)

After the user supplies the only required configuration (repo URL + token), the software
runs the sync cycle itself. The user has no manual sync control and no sync decision to make.
"Silent" is therefore defined by two positive facts:

1. an explicit, auditable list of automatic triggers (§2); and
2. one read-only status surface (`SchedulePane.SyncStatusRow`) that reports the real result
   without inviting a tap. The wording of that surface is owned by the status-honesty lane
   and was **not** changed in this round.

An absent control is not proof of silence; the trigger inventory and its log are.

## 1. Phase A change (schedule page only)

- Removed the failed-state `Text('重试同步').onClick(() => this.retrySync())` control from
  `SchedulePane.SyncStatusRow()` (`pages/panes/SchedulePane.ets`). The status line still
  renders `Text(this.syncStatus.text)` with the failed-state colour; no `.onClick` remains
  on the row. The pull-to-refresh gesture (`RefreshableList` → `onPullRefresh`) is untouched.
- `retrySync()` itself is **kept** (`SchedulePane.ets`, `private async retrySync()`): support
  can still reach the failed-intent reset + real cycle capability (same deterministic
  `bindBridgeRunner` + `runConfiguredCycle(ctx)` path), but the pane has zero call sites
  (`this.retrySync()` occurrences = 0). This satisfies "don't delete diagnostics".
- Added one observability line inside the pull gesture's `runCycle` injection:
  `console.info('[sync-trigger] pull');`. It is inside `globalRefreshCoordinator.runOnce`,
  whose `execute()` calls `runCycle` once for the leader only, so one attempt = one line.
  No payload, no interpolation, no token, no URL, no `hilog`.
  `credentialHygiene.test.mjs` restricts `pages/Settings.ets`, `GitSyncService.ets`,
  `settingsStore.ets`, `scheduleStore.ets`, `deepseek.ets`, `model/types.ts`;
  `SchedulePane.ets` is **not** in that set (it already used `console.info` before this
  change). The new guard `syncUiSilence.test.mjs:S5` re-asserts the restricted set has no
  `[sync-trigger]` literal.
- Guard: `tools/test/syncUiSilence.test.mjs` (8 tests) distinguishes three look-alikes —
  a **button** (literal `Text`/`Button` label plus component-prop `label`/`text`/`title`,
  and any `onClick`/`onTap`/`onAction`/`onSubmit`/`onPress`/`onChange` handler), the **gesture**
  (`Refresh({ refreshing: $$this.refreshing }).onRefreshing(…)`, deliberately excluded from the
  handler-prop scan), and the **text row** (`Text(this.syncStatus.text)`, must stay, no click
  handler). S6–S8 are positive controls: the same assertion functions are fed the pane-native
  `ActionButton` idiom, a regex literal containing `)`, indirect calls, and a mutated real pane,
  and must fail.
- **Artifact identity caveat:** the HAP and `modules.abc` in `entry/build` are **tree-level
  artifacts shared with concurrent lanes**; a later lane build can overwrite them, so their
  hashes are not module-level evidence. The durable module-level evidence is the source diff
  plus the abc **name hit** `[sync-trigger] pull` (exactly once).

## 2. Silent-trigger inventory — Phase B final state

**Phase B update (`mod-sync-silence-phase-b`):** all five triggers below are present, and all
five now emit an observability line. The Phase A "missing" rows are no longer open work.

| # | Trigger | Status today | Evidence / where | Gap to schedule |
|---|---------|--------------|------------------|-----------------|
| 1 | Cold launch | **present** | `pages/Home.ets:127-203` `aboutToAppear()` → `homeStartupSync.configure()` + `request()`; `Home.ets:240-252` `onBridgeReady()` → `homeStartupSync.onBridgeReady()`; `Home.ets:208` `runOnce(undefined,'cold-launch')`; `model/homeStartupSync.ts:83-160` (one quota per process, deferred until bridge ready) | none |
| 2 | After a successful save | **present** | `services/recordWriter.ets:100,105` → `triggerSync()` → `globalRefreshCoordinator.runOnce(overrides,'save')` at `:153` (single-flight, not a direct `runConfiguredCycle`) | none |
| 3 | Returning to foreground | **present (Phase B)** | `Home.onPageShow()` (`pages/Home.ets:244-250`) → `maybeForegroundSync()` (`:274-297`): configured gate + 5-minute cooldown (`model/syncTriggerPolicy.ts:14,35-50`) + coordinator single-flight. Chose `Home.onPageShow` over `EntryAbility.onForeground` because Home owns the coordinator hooks. | none |
| 4 | Network regain | **present (Phase B, foreground-only guarantee)** | `Home.ets:304-371` subscribes `connection.createNetConnection().on('netCapabilitiesChange')` + `netLost`, 2 s debounce, same-type / in-flight filters, `unregister` at `:373-386`; `entry/src/main/module.json5` declares `ohos.permission.GET_NETWORK_INFO`. Limitation below. | background delivery not guaranteed |
| 5 | Home pull-to-refresh | **present** | `Home.ets:425` global pull → `runOnce(undefined,'pull')`; pane gesture `SchedulePane.onPullRefresh()` → coordinator with Phase A's own log at `:363`; both share the single-flight coordinator | none |

Observability coverage (Phase B): **all five triggers emit exactly one line per attempt** —
`[sync-trigger] cold-launch`, `[sync-trigger] save`, `[sync-trigger] pull`,
`[sync-trigger] foreground`, `[sync-trigger] network`. The names are literals in
`model/homeGlobalRefresh.ts:34-40`; the line is emitted in the coordinator's leader-only
cycle callback (`:269-275`); the ETS host installs `console.info` at `Home.ets:148-150`.
The Phase A pane `pull` line stays at `SchedulePane.ets:363`, so that path is logged once, not
twice. No interpolation / payload / token / URL; `credentialHygiene` restricted files contain
no `[sync-trigger]` text (`tools/test/syncTriggerMatrix.test.mjs:T9`). The closed set (no
silently added sixth name) is asserted in T1 with a positive control in T1b.

**Network-regain limitation (explicit, not a claim of background sync):** regain detection
works **while the page/ability is alive**; HarmonyOS does **not** guarantee
`netCapabilitiesChange` delivery when suspended, and permission denial / net-service failure
makes `register()` a no-op ⇒ the app degrades to the **foreground** trigger;
**background sync is not claimed**.

## 3. Phase B input — privacy gate loses its "test" button (analysis only)

The status-honesty lane is answering the same questions independently; reconcile if the
conclusions differ.

**Q1 — Does save still verify and block on public/unknown before persisting?**
Yes. `pages/SettingsSync.ets:302-321` runs `repoVisibilityChecker.checkNow(target, token)`
when the repo URL is non-empty; on `!verdict.ok` it sets `saveHint` and `return`s at `:319`.
`settingsStore.save(patch, context)` is later, at `:332`, so a rejected repo is never
persisted. `checkNow` is force (`services/repoVisibilityChecker.ets:79-82`), so the 60 s
dedupe window is bypassed on save.

**Q2 — Can a user whose repo was public at save time recover once it becomes private,
with no test button, via the pre-push live check clearing the block?**
Only conditionally. Two cases:

- If the block came from a *save* attempt, that save was rejected before persisting, so the
  user must re-open settings and save again after making the repo private. The 保存 (save)
  button remains after Phase B (it is configuration, not a sync control), and its force
  check clears the block via `RepoVisibilityChecker.runCheck()` →
  `syncStatusStore.clearRepoBlock()` (`repoVisibilityChecker.ets:118-128`,
  `syncStatusStore.ets:242-251`). Recovery exists, but needs that save action.
- If the block came from a *pre-push* check on an already-saved repo, the next automatic
  cycle does a live check and clears the block — but `guardPush()` calls
  `runCheck(force=false)` (`repoVisibilityChecker.ets:84,103`) and
  `shouldRunRepoVisibilityCheck()` reuses the cached verdict for 60 s
  (`model/repoVisibilityGate.ts:51-61`). Sticky semantics (`repoVisibilityGate.ts:67-82`)
  mean only a *passing live check* clears. Therefore: if no further trigger fires, or the
  next cycle lands inside the 60 s window and is the last one, the status line stays
  "已停止上传" indefinitely. Since triggers #3 and #4 are missing (§2), there is no
  background event guaranteed to produce that later cycle.

**Minimal fix for Phase B (do NOT implement in Phase A):** make the blocked state bypass
the dedupe window — i.e. in `RepoVisibilityChecker.guardPush()` pass
`force = this.state.blocked` (or equivalently make `shouldRunRepoVisibilityCheck` return
`true` whenever `state.blocked`) so the *next* automatic cycle re-checks live even inside
60 s. Sticky is preserved: the block still lifts only on a passing live check, and
`clearRepoBlock()` still does not fabricate a sync success. Add a test:
`blocked → repo becomes private → next cycle < 60 s → decision.ok && status no longer blocked`.

## 4. Phase B — ready-to-execute anchors (settings page; locked this round)

No Phase B edit was made. Exact anchors, verified by read:

| Item | File / anchor | Action |
|------|---------------|--------|
| 「查看状态」 control | `pages/SettingsSync.ets:805-816` inside `SyncMoreSheet()` (`:783-862`) | Delete the `Text('查看状态')…onClick(() => this.runAction('status'))` block. Keep `lastSyncAction` state if `canRetrySync` still consumes it; otherwise prune together with 重试. |
| 「测试连接」 control | `pages/SettingsSync.ets:817-828` | Delete the `Text('测试连接')…onClick(() => this.testConnection())` block. `testConnection()` at `:412` then becomes support-only (keep the function; do not delete the diagnostic capability). |
| 「重试」 control | `pages/SettingsSync.ets:829-841` (`if (canRetrySync(...))`) | Delete the conditional `Text('重试')` block. `retryFromStatus()` (`:611`) and `runAction()` (`:657`) remain as support/diagnostic capability with no UI trigger. |
| Sheet entry | `components/settings/SyncSection.ets:169` (`label: '更多'`) and `SettingsSync.ets:978` (single `SyncMoreSheet()` render; builder at `:784`) | After removing the three rows, decide whether the sheet keeps only help/hints (`:846-857`) or is removed entirely; keep exactly one help entry if retained. Re-anchor at Phase B time — the settings lane is still editing these files. |
| local-changes line | `model/syncError.ts:688` `parts.push(\`本地改动 ${view.changedCount} 处\`)` inside `describeSyncStatus()` (`:672-696`); rendered via `SyncSection.ets:395-415` diagnostic block and `SettingsSync.ets:515` | If the Lead wants the local-changes line gone, drop that `parts.push` plus its example text at `:670` and any guard that pins it. It is read-only diagnostic text, not a sync control; keep the rest of the diagnostic region. |
| Guards to retarget | `tools/test/fixSyncRetry.test.mjs:143-159` (R4 pins all three actions in `SyncMoreSheet`), `settingsMenu.test.mjs`, `settingsCopyGuard.test.mjs`, `modSettingsSyncMin.test.mjs`, `remoteSettings.test.mjs` | Replace presence assertions with "sheet contains no manual sync control" + positive pins for the read-only status line; do not simply delete assertions. Re-run `credentialHygiene` (no console/hilog in banned files) and the full suite. |
| Privacy fix | `services/repoVisibilityChecker.ets:84-103`, `model/repoVisibilityGate.ts:51-61` | Apply §3 minimal fix and add the `<60 s` recovery test, or accept the documented strand window. |

## 5. Unverified

Real-device behaviour (gesture feel, status line rendering after removal) is **unverified**.
Phase B is **not implemented**; the privacy recovery gap in §3 is **analysis only**.
