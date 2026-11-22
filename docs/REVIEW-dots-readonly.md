# Review — mod-dots-readonly

## Verdict

PASS — the module's central claim is reproduced at artifact level (abc 2,962,696 B = 2,933,704 B + 28,992 B, with `instanceGrantStore`×4 / `E_GRANT_`×17 / `session.prompt`×1), the pane is genuinely read-only and fail-closed, all four new guards are real, and every gate reproduces exactly as documented; only out-of-scope and residual minors remain. Major findings remaining: 0

## Findings

### Blocker

None.

### Major

None.

### Minor

1. **Sibling over-promising dots copy is still compiled (out of declared scope).** `apps/arkui-schedule/entry/src/main/ets/pages/Chats.ets:62` still renders 「从首页「与 dots 对话」进入本页；dots 可查看实例并对会话发指令，所有操作需你确认，当前为只读预览」; this distinct string is UTF-8-present once in `ets/modules.abc` at byte offset 605253. The exact old subtitle targeted by this module is gone (0 hits), so check 5 passes, but app-level copy honesty about dots commands is not complete. `Chats.ets` is not in this module's changed-file set.
2. **Another module's doc row was edited.** `docs/MODULES.md:106` and `docs/MODULES.md:318` alter the pre-existing `mod-shell-dots-pane` rows: the dependency cell gains 「被 `mod-dots-readonly` 消费（在其真列表上加只读授权行）」. The cross-reference is factually accurate and no status/hash/number cell of that module changed, but this literally violates the stated "no other module's row altered" constraint.
3. **Workspace changed concurrently during the review.** Unrelated `mod-ai-models-fetch` work began modifying compiled inputs while this review ran: `apps/arkui-schedule/entry/src/main/ets/model/aiProvider.ts` at 2026-11-22T11:52:35+08:00 (a comment-only addition about `kind`/cache helpers) and `apps/arkui-schedule/entry/src/main/ets/services/settingsStore.ets` shortly afterwards. Neither is part of `mod-dots-readonly`, and both postdate the 11:31:29 build, so they do not invalidate the HAP/abc evidence; the working tree is nevertheless no longer the exact snapshot the gates were run against.

### Nit

1. Fail-closed is established by source shape plus the store/model decode tests, not by a runtime test that injects a corrupt envelope through `DotsPane`; the actual two-line wrapping/ellipsis of the rendered grant row remains `unverified` on device, as the module's own docs state.

## Checklist

1. **First compile really achieved (artifact-level) — PASS.** Reopened `apps/arkui-schedule/entry/build/default/outputs/default/entry-default-unsigned.hap` as a zip (16 entries) and read `ets/modules.abc` directly: uncompressed size **2,962,696 B**, SHA-256 `e4c1dda1e2a49b3a36f403e84c4bdc4a093e0a0ccb829eaba1097f1ba266c8a1`, delta vs the 2,933,704 B baseline exactly **+28,992 B** (expected ≈ +28,992). UTF-8 name-level hits: `instanceGrantStore`×4, `instanceGrant`×7, `GrantProblem`×1, `E_GRANT_`×17 (incl. `E_GRANT_STORAGE_UNAVAILABLE`, `E_GRANT_ENVELOPE_JSON`, `E_GRANT_TOOL_UNKNOWN`), `lastProblem`×2, `redactGrant`×2, `canonicalTools`×2, `VIEW_TOOLS`×1, `session.prompt`×1, `instance-grants.json`×1. New copy strings also present: `命令工具未授予，指令确认闸尚未接线`×1, `dots 权限（只读）：`×1, `未授权 / 未知`×2, `dots 只读查看会话，暂不能发指令。`×1. HAP itself 5,154,431 B / SHA-256 `136c57e64bd472fa13482320bf5a4f73d7de35f79a15d9d781e73d08a5a02f65`. This is artifact proof, not just a green build.

2. **Read-only means read-only — PASS.** `DotsPane.ets:91` calls `instanceGrantStore.lastProblem()`, `:97` calls `instanceGrantStore.redacted(nowMs)`, and `:100-120` uses only pure model helpers (`isViewTool`, `VIEW_TOOLS`, `problemText`). A grep for `upsert|revoke|upsertGrant(|revokeGrant(|session.prompt(|sessionPrompt(` in the pane returns only two **comment** lines (`:14`, `:86`, both negative "不调 upsert / revoke" statements); zero executable mutation calls, zero `console.*`. The mutation ban is real, not vacuous: P-26 (`paneLayout.test.mjs:654`), H-6 (`indexHeader.test.mjs:320`), L-24 (`shellLayout.test.mjs:562`), U-S8 (`uiTokens.test.mjs:667`) and SG-S7 (`structureGuards.test.mjs:399`) all evaluate comment-stripped source (`stripComments`/`stripNotes`) and assert absence of six named mutation APIs; SG-S7 additionally checks rendered `@State` use. Limitation: a renamed/aliased mutation call would evade a literal-string ban — acceptable for a source-shape guard.

3. **Disabled reason is user-visible copy, not a log — PASS.** `DotsPane.ets:45` defines `REASON_DOTS = '命令工具未授予，指令确认闸尚未接线'`; `DotsPane.ets:284` renders `Text(\`发指令（${REASON_DOTS}）\`)` and the same modifier chain carries `.enabled(false)` at `:290` (6 lines later). No `console.*` exists in the pane. The Lead's "provable" requirement is pinned by adjacency regexes `Text(\`发指令（\$\{REASON_DOTS\}）\`)[\s\S]{0,400}\.enabled\(false\)` in P-26, U-S8 and the retargeted H-2 (`indexHeader:240`), P-16/P-17, L-11/L-12, plus SG-S7's `Text(...)` rendered-site check.

4. **Fail-closed on a bad envelope — PASS.** `buildGrantLine` (`DotsPane.ets:90-121`): `problem !== 'ok'` → `未授权 / 未知（${problemText(problem)}）` (`:93-95`); healthy decode but zero active instances or zero view tools → `未授权 / 未知` (`:111-113`). The command conclusion `；命令工具 session.prompt 未授予。` (`:52`) is appended unconditionally, so no path can claim command permission; `canPrompt` is never read. Store semantics back this: `instanceGrantStore.ets:111-115` triggers lazy load and returns the typed problem, `instanceGrant.ts:669-728` (`decodeGrants`) returns empty items plus typed problem for empty/corrupt/wrong-version/bad-item envelopes, and `:602-619` derives `active`/`canPrompt` fail-closed. Assertion: `paneLayout.test.mjs:660-663` pins the exact `未授权 / 未知（${problemText(problem)}）` form; P-26/H-6/L-24/U-S8/SG-S7 pin `未授权 / 未知`.

5. **Copy honesty — PASS.** The old subtitle 「dots 可查看实例并对会话发指令，所有操作需你确认。」 no longer exists in the pane source (replaced by `DOTS_SUBTITLE` at `DotsPane.ets:48`, rendered at `:296`) and has **0** UTF-8 and 0 UTF-16 hits in `ets/modules.abc`; the old reason `dots 指令尚未接线` and old action string `新建对话（` are also 0 hits in abc, while `发指令（` is ×1 and the new subtitle is ×1. The old string's absence is asserted in H-6, P-26, L-24, U-S8 (source, including comments for H-6/L-24). Caveat: the distinct still-shipped sibling line at `Chats.ets:62` (Minor 1) keeps a similar over-claim elsewhere.

6. **Contract intact — PASS.** `@Prop deepLinkId` (`DotsPane.ets:64`) and `@Prop active` (`:66`) unchanged; keep-alive via `.visibility(this.active ? Visibility.Visible : Visibility.Hidden)` (`:325`); exactly one `aboutToAppear` (`:77-81`); real list from `chatStore.prepare/listChats` (`:78`, `:128`) + `chatList` helpers with `PANE_KIND = 'dots'` (`:42`, `:135`); row → `pages/ChatDetail` with id-only params (`:143-149`, called at `:179-181`); four states at `:310-318` (error / loading / list / empty); no cross-section navigation (guards P-18, P-22, L-21, SG-S6 pass).

7. **Guards equal-or-stricter — PASS.** `git diff` sampling of all retargets: H-1/H-2 (`indexHeader:181/211`), P-16/P-17/P-21 (`paneLayout:388/409/523`), L-11/L-12/L-20 (`shellLayout:278/323/460`), U-S2 (`uiTokens:508`) change only literal anchors (`REASON_DOTS` value, `新建对话`→`发指令`) and assertion messages; no assertion was deleted. Two are stricter: P-16/P-17 replace "old subtitle must be present" with "old subtitle absent + new subtitle const present + `Text(DOTS_SUBTITLE)` rendered", and SG-S7 goes from three to four `@State` fields plus new store/rendering/no-console/no-mutation pins. `paneLayout`'s former blanket `grant` substring ban was narrowed to an explicit mutation list, but compensated by positive read-API pins (`GRANT_READ_APIS`) — not a net weakening. The four new ids P-26, H-6, L-24, U-S8 are **real**, falsifiable source-shape assertions (import present, both read APIs called, `Text(this.grantLine)` rendered, fail-closed copy, reason adjacent to `.enabled(false)`, no `console.`, no mutation APIs, old copy absent, new copy rendered); none is tautological.

8. **Staleness — PASS (at build time).** Newest compiled input at build time was `DotsPane.ets` with mtime 2026-11-22T11:26:16.927+08:00, earlier than build start 2026-11-22T11:31:29+08:00; next newest compiled input was `InstancesPane.ets` at 10:40:35.642. (The concurrent post-build edits in Minor 3 are unrelated to this module.) Build log `apps/arkui-schedule/.build-logs/build-20261122-113130.log`: `Finished :entry:default@CompileArkTS... after 6 min 22 s 905 ms` (line 1335, EXECUTED), `UP-TO-DATE :entry:default@CompileArkTS` = 0, `42 tasks in total: 41 executed, 1 up-to-date` (line 1358), `BUILD SUCCESSFUL in 11 min 36 s 423 ms` (line 1356), `Build completed successfully` (line 1362); HAP mtime 11:43:45 is consistent with the build ending ~11:43:05. Test/doc writes after the build are irrelevant per MODULES §0 rule 10. The concurrent `aiProvider.ts` change (Minor 3) postdates the build and is comment-only.

9. **Gates — PASS.** `overlay.mjs status` → `[overlay] applied=false`. `node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json` → exit 0. Targeted five guards → **122 tests / 8 suites / 122 pass / 0 fail / 0 skipped**, exit 0. Full `node --test "apps/arkui-schedule/tools/test/*.test.mjs"` → **2812 tests / 390 suites / 2812 pass / 0 fail / 0 skipped**, exit 0. `node apps/arkui-schedule/tools/validate-app.mjs` → **8/8** (JSON5/JSON 70, relative imports 527, main static imports 705, pages 12, rawfile/git 2). All reproduce the documented numbers exactly.

10. **Docs — CONCERN (minor only).** `docs/MODULES.md:108` (module row), `:177` (scope row), `:319` (batch row), `docs/ROADMAP.md:480` and `docs/UI-DESIGN.md:613` cite the verified build (`build-20261122-113130.log`, 6 min 22 s 905 ms, 41/1), HAP 5,154,431 B / sha `136c57e6…02f65`, abc 2,962,696 B / sha `e4c1dda1…6c8a1`, +28,992 B, and all name-level hits; each new row carries 「未装机 / unverified（安装版 `1000005`；设备检查随 `1000006`）」. `docs/VERIFICATION.md:1959` §15.19 is untouched (file absent from `git status`). Deviation: Minor 2 (two `mod-shell-dots-pane` cells edited).

## Residual risk & unverified

- No installation or on-device rendering check: installed build `1000005`, device check deferred to `1000006`; the grant line's real two-line wrapping/ellipsis and the disabled `Text` tap behaviour are `unverified`.
- Fail-closed is verified statically and at model level, not by injecting a corrupt envelope through the pane at runtime.
- Mutation ban is literal-string based; a renamed or aliased mutation API would not be caught.
- Out-of-scope sibling copy at `Chats.ets:62` still promises dots command capability in the shipped abc.
- Concurrent unrelated `aiProvider.ts` / `settingsStore.ets` edits mean the tree has moved since the build; re-run gates if the Lead commits that module on top.
- No builds, overlays, git writes, or subagents were performed by this review; only `tsc` and `node --test`/`validate-app` were executed.

## Evidence log

- `node .../tools/overlay.mjs status` → `[overlay] applied=false`.
- `git rev-parse HEAD` → `ae8a42ce7dc280d6bc03d728886af5b26831dd5f`; initial `git status --short` → exactly 1 pane + 5 guards + 3 docs modified.
- PowerShell `ZipArchive` read of `entry-default-unsigned.hap` → 16 entries; `ets/modules.abc` 2,962,696 B, sha256 `e4c1dda1…6c8a1`; HAP 5,154,431 B, sha256 `136c57e6…02f65`; UTF-8 byte-scan counts as listed in check 1 (search cap raised to exact counts; `E_GRANT_` = 17).
- Byte-context dump at abc offset 605253 identified the only old-copy substring as the unrelated `Chats.ets:62` string.
- `Get-ChildItem ... entry/src/main -Recurse` mtime sort → newest compiled input `DotsPane.ets` 11:26:16.927; build log lines 1335/1356/1358/1362 as quoted in check 8.
- `git diff` on all 9 changed files for checks 2–8 and 10; `git status --short` re-checked after gates revealed concurrent `aiProvider.ts` (11:52:35, comment-only) and `settingsStore.ets` modifications from an unrelated module.
- Gates: `tsc` exit 0; targeted five guards 122/122/0/0; full suite 2812/2812/0/0 (390 suites); `validate-app` 8/8 (70/527/705/12/2).
- Docs-cited evidence files all exist: `.tmp/artifact-proof-dots-readonly.ps1`, `.tmp/modules-abc-dots-readonly.abc` (2,962,696 B), `.tmp/artifact-proof-dots-readonly.out`, `.tmp/gates-dots-readonly-guards.out`, `.tmp/gates-dots-readonly.out`, `.tmp/validate-dots-readonly.out`.
