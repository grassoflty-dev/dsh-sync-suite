# Review — batch 11: `mod-composer-hard-disable` + `mod-pairing-badge-pin-guard`

- **Role / mode**: independent read-only reviewer (`planner-b9/review-b11`). No source edits, no builds, no git writes, no device commands, no `~\.dsh\**` writes. Artifacts written only to this file and `.tmp/review-b11-*.out`.
- **Base**: `32ca899` (HEAD at review start); `7988565` is an ancestor (Lead version bump), not part of the two stage sets.
- **Stage sets**: C1 = 11 paths (5 App source + 6 retargeted tests), C2 = 5 paths (new `pairingBadge.ts`, `InstancesPane.ets`, new `pairingBadge.test.mjs`, `pairingReachability.test.mjs`, `remoteOutcome.test.mjs`). Zero overlap (verified from `git status`, archived `.tmp/git-status-app-device-defects.out`, mtimes).
- **Targeted tests run by reviewer (3)**: `remoteCommandComposer.test.mjs` 23/23; `pairingBadge.test.mjs` 7/7; `pairingReachability.test.mjs`+`remoteOutcome.test.mjs` 32/32. Logs: `.tmp/review-b11-composer.out`, `.tmp/review-b11-badge.out`, `.tmp/review-b11-guards.out`.

## Verdict

**PASS — 0 Major.** All three device-found defects are genuinely fixed in code, the new string has no second copy, the two builds are independently green with `CompileArkTS` executed and no `UP-TO-DATE … CompileArkTS`, and the abc artifacts discriminate #1/#2 as claimed. Device assertions are **not** verified here (no device commands were permitted); they remain `unverified` and need a post-reinstall `uitest dumpLayout` pass. One CONCERN is raised on the mechanical-check wording (assertion #5 needs row scoping). No guard was loosened; several were tightened.

## Findings

### 1. D1 — 「发送指令」 truly disabled, default unchanged — PASS

- `ActionButton.ets:57` adds additive `@Prop hardDisabled: boolean = false`; `:67` forwards it as the 4th arg; `:144` and `:160` apply real ArkUI `.enabled(!this.hardDisabled)` in **both** builders; `:110-112` short-circuits `handleClick()` first.
- `actionButton.ts:64-65` adds optional 4th param `hardDisabled = false`; `:73-80` returns `{tappable:false, busy:false, opacity:0.4}` when true. With false the condition is byte-equivalent to the old `if (!isEnabled)`; all other branches unchanged.
- `RemoteCommandComposer.ets:177-187` sets `hardDisabled: true` on the single 「发送指令」 button; reason still passed via `disabledReason` and still rendered by the always-present `Text(this.reason)` at `:190-198`.
- **Call-site sweep**: grep found exactly one `hardDisabled:` consumer call site (composer `:184`). All other ActionButton invocations (Index ~20, SchedulePane ~16, InstancesPane 11, plus ExportImportPanel/Chats/ChatDetail/RecordEditorView/Dots/CloudChat/EmptyState/ErrorState/SyncSection) omit it → default false → unchanged. `resolveButton` has one production 4-arg caller (ActionButton) and 3-arg model tests using the default. No ancestor of any ActionButton uses `.enabled(false)` (the other `.enabled(...)` calls are on standalone Buttons/controls), so the new explicit `.enabled(true)` cannot re-enable anything. no other control's clickability changed.
- **uitest expectation**: from code, the send Button's ArkUI `enabled` attribute is now false, so `dumpLayout` would report `enabled:"false"`; `clickable:"false"` is the standard co-varying value seen in the prior dump, but this is a static inference here, not device-observed.

### 2. D2 — reason visible without a tap, no stale copy — PASS

- `DotsPane.ets:326` renders `Text(\`发指令（${this.refusalReason}）\`)` with `:332 .enabled(false)` — visible, on a Text, not a log. `refusalReason` is computed at `:141-163` and `:88` from `placeholderRefusalReason`.
- `remoteCommandDraft.ts:165-175` maps **no target → `E_COMMAND_TARGET_MISSING`, target but not granted → `E_COMMAND_NOT_GRANTED`, granted but unverified → `E_COMMAND_REMOTE_UNVERIFIED`**, else `''`. Every branch returns `COMMAND_WORDING[code]` (`remoteCommandGate.ts:43-52`); no literal reason is duplicated in the model or pane.
- `REASON_DOTS` deleted; the two 「指令确认闸尚未接线」 comments removed (diff of `DotsPane.ets` header + constant comment). Source-wide grep: 0 hits for the stale string in `.ets`/`.ts` (only negative guards in tests). The surviving line-22 historical note says 「dots 尚未接线」, a different, pre-existing migration anchor, not a rendered claim.
- Wording is embedded verbatim inside the `发指令（…）` label; that is presentation wrapping, not a second copy.

### 3. D2 guard retargeting — PASS, no weakening

- `indexHeader.test.mjs:181-193,241,282,329`; `paneLayout.test.mjs:37-41,387-401,410-422,674-683`; `shellLayout.test.mjs:285-291,332-341,576-579`; `structureGuards.test.mjs:416-435,451-457`; `uiTokens.test.mjs:508-519,669-678`.
- Each old assertion that pinned the literal `REASON_DOTS` string was replaced by (a) a **new negative** stale-string check, (b) a positive derivation check (`placeholderRefusalReason({`), and (c) the same `Text(…)` + `.enabled(false)` + no-`console.` checks. `structureGuards` expanded the @State set from 4 to 5 and added render-site checks for `refusalReason`. `remoteCommandComposer.test.mjs:86-100` (A3) pins the exact three-way `COMMAND_WORDING` mapping; `:224-256` (F4) adds source-shape + model short-circuit + a mutation negative control. Intent preserved or tightened; no assertion deleted or relaxed.

### 4. D3 — badge pin guard — PASS

- `pairingBadge.ts:65-83` implements all 9 cells (pin × ok/fail/unknown, unpinned × ok/fail/unknown) plus the http defence; `canShowFingerprint:53-59` with `isHttpUrl:36-39` forces http rows to the unpinned branch even with a stored pin; dirty reachability fails closed to `unknown` (`:42-47`). `badgeOf` reuses `canShowFingerprint`, so fingerprint line and badge cannot drift.
- `InstancesPane.ets:231-240` routes every row through `badgeOf(full)` / `canShowFingerprint(full)`; the inline ternary and `PAIRING_REACHABLE_WORDING` import are gone; fingerprint `Text` is gated at `:768`.
- **Pinned copy**: `pairingBadge.ts:16` imports `PAIRING_REACHABLE_WORDING` (the only pre-existing shared constant) — not retyped, exactly one literal in `pairingPayload.ts:122`. The other two pinned strings (`pairingBadge.ts:21,24`) are byte-identical to their HEAD inline literals; they were never exported constants, so there was nothing to import — now one copy each, centralized. Unpinned copy at `:27,30,33`. Source-wide count: one copy of each pinned literal (tests' expectation strings aside).
- **Grep of whole pane + model**: no 「已配对」 literal in `InstancesPane.ets`; the only sources are the pinned branch in `pairingBadge.ts`, `pairingPayload.ts:122` (paired-flow toast after a pin is written), and `remoteCommandGate.ts:44` 「请先选择一个已配对的实例」 (a gate instruction rendered in DotsPane, not a row badge). No path lets an unpinned or http row print a pairing claim as a badge.
- **Copy honesty**: 「地址可达（未配对）」 asserts only the app's transport-level `reachable` flag and explicitly denies pairing/certificate claims — honest for a manually typed row, and strictly better than the previous false 「已配对…尚未校验证书」. Residual nuance: `submitForm` preserves `existing.reachable` while dropping `tlsFingerprint` (`InstancesPane.ets:434`), so an edited row can inherit a stale `ok`; the badge then says "reachable" — but that same flag is already rendered by `reachabilityLabel` at `:728`, so no new claim is introduced.

### 5. Two-build evidence — PASS (one precision note)

- C1 source mtimes 19:16:59–19:22:48; C2 19:25:12–19:27:36; build #2 log 19:27:50; HAP 19:28:01. Archived git status (19:30:06) equals current status for all 16 stage-set paths → commit-1 files were not touched before/after build #2. (A later Lead-only edit to `docs/MODULES.md` at 19:34:51 is outside both stage sets.)
- Both logs show `Finished :entry:default@CompileArkTS` (17 s 987 ms / 4 s 420 ms), `BUILD SUCCESSFUL`, `42 tasks: 23 executed, 19 up-to-date`, and **0** `UP-TO-DATE … CompileArkTS` lines.
- abc UTF-8 scan: stale string 0/0; `hardDisabled` 4/4; unpinned strings and `badgeOf`/`canShowFingerprint` 0 in #1 vs 1–2 in #2; `placeholderRefusalReason` 2/2. **Note**: the three *pinned* strings appear in both HAPs, because HEAD's inline ternary already shipped them; the invariant "badge strings only in #2" holds for the **new** badge copy, not literally for pre-existing pinned strings.

### 6. Mechanical device assertions — CONCERN (scoping, not code)

- Button `enabled:"false"` / `clickable:"false"`: unambiguous from a dump (directly set attribute); device-unverified.
- reason `Text` with one of three `COMMAND_WORDING` sentences: mechanical for the **DotsPane** reason; do not apply the three-sentence set to the composer, whose reason is any gate `wording` (e.g. `请先输入要发送的指令`).
- stale sentence absent: mechanical, but only meaningful if dots pane is actually mounted/visible in that dump.
- manual http row 「地址可达（未配对）」: mechanical only if that row's `reachable` is still `ok`; otherwise the correct text is one of the other two unpinned strings.
- **"no unpinned row 已配对"**: **not** unambiguous as a global dump text search — it would also hit `发指令（请先选择一个已配对的实例）` (`remoteCommandGate.ts:44`) or a pairing toast. Must be scoped to row/badge `Text` nodes.

### 7. Hygiene — PASS

- Neither stage set contains `docs/**` or `AppScope/app.json5`: all 16 paths are under `apps/arkui-schedule/entry/src/main/ets/` or `apps/arkui-schedule/tools/test/`.
- `.tmp/gates-app-device-defects.out` = 3,167/3,167/0/0; `.tmp/gates-app-device-defects-plugin.out` = 868/866/0/2; `.tmp/validate-app-device-defects.out` = 8/8; `.tmp/gates-planner-b9-batch11.out` = 4,035 tests / 4,033 pass / 0 fail / 2 skip. All match the stated numbers.

## Checklist

| # | Item | Status | Evidence (file:line / artifact) |
|---|---|---|---|
| 1 | D1 real `.enabled(!hardDisabled)`, both builders; early return | PASS | `ActionButton.ets:57,67,110-112,144,160` |
| 1 | D1 model short-circuit; default 3-arg behaviour unchanged | PASS | `actionButton.ts:64-65,73-80`; `remoteCommandComposer.test.mjs:224-256` |
| 1 | Only composer sets the flag; no other control's clickability changed | PASS | single `hardDisabled: true` at `RemoteCommandComposer.ets:184`; call-site grep (all others omit it) |
| 2 | Reason on visible `Text`, no tap, exact gate wording, no second copy | PASS | `DotsPane.ets:326,332,141-163`; `remoteCommandDraft.ts:165-175`; `remoteCommandGate.ts:43-52` |
| 3 | `REASON_DOTS` + two stale comments gone | PASS | diff `DotsPane.ets` header/constant; source grep 0 hits |
| 3 | Three-way mapping correct | PASS | `remoteCommandDraft.ts:165-175`; `remoteCommandComposer.test.mjs:86-100` |
| 3 | Five guards kept intent; no weakening | PASS | `indexHeader:181,241,282,329`; `paneLayout:387,410,674`; `shellLayout:285,332,576`; `structureGuards:416,451`; `uiTokens:508,669` |
| 4 | 9-cell `badgeOf`, http forced unpinned, fingerprint gated | PASS | `pairingBadge.ts:36-39,53-59,65-83`; `InstancesPane.ets:231-240,755-778` |
| 4 | Pinned strings byte-identical / un-duplicated; imported where shared | PASS (nuance) | `pairingBadge.ts:16,21,24`; `pairingPayload.ts:122`; `pairingBadge.test.mjs:105-120` |
| 4 | No unpinned/http path prints 「已配对」; copy honest | PASS (nuance) | pane+model grep; `InstancesPane.ets:434,728`; `pairingBadge.ts:27,30,33` |
| 5 | Disjoint stage sets; C1 untouched across build #2 | PASS | `git status` + archived status + mtimes |
| 5 | Both logs: CompileArkTS executed, 0 UP-TO-DATE CompileArkTS | PASS | `build-20261123-192311.log`, `build-20261123-192750.log` |
| 5 | abc stale 0/0, hardDisabled 4/4, new badge copy only in #2 | PASS (nuance) | `.tmp/modules-*-hard-disable.abc`, `.tmp/modules-*-pin-guard.abc` |
| 6 | All dump expectations mechanically unambiguous | **CONCERN** | no unpinned-row 已配对 needs row scoping (`remoteCommandGate.ts:44`); other four need pane/state conditions |
| 7 | Hygiene + all gate counts | PASS | see §7; `.tmp/gates-*.out`, `.tmp/validate-*.out` |

## Residual & unverified

- **unverified** — no device command was run: `uitest dumpLayout` `enabled:"false"`/`clickable:"false"` on 「发送指令」, the three DotsPane reason sentences, absence of the stale sentence, the manual http row copy, and absence of a row-level 「已配对」 all remain unobserved on hardware.
- **unverified** — ArkUI runtime semantics of `.enabled(true)` being a perfect no-op for default call sites is inferred from code and call-site sweep, not measured; no control outside the composer passes the flag.
- **nuance** — pinned strings exist in both HAP abc files because HEAD already shipped them inline; only the new unpinned copy discriminates #2.
- **nuance** — `submitForm` can preserve a stale `ok` reachability while dropping the pin; badge copy inherits the flag already shown elsewhere in the row.
- **nuance** — `pairingBadge.test.mjs:123` uses `\b已配对\b` (Chinese chars are non-word in JS), a weak standalone regex; B2's literal checks and `remoteOutcome.test.mjs:208` restore the coverage.
- **informational** — `docs/MODULES.md` was edited by the Lead after the gates (19:34:51) to register these modules; it is not in either stage set.
