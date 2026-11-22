# Review — mod-shell-dots-pane

## Verdict
CONDITIONAL PASS — the pane really is a single-path `chatStore`/`chatList` dots list with preserved props/keep-alive and the five guard retargets are equal-or-stricter, and every cited build/abc number reproduces, but three changed docs files are newer than the build start, so the artifact-evidence gate is formally stale/inverted: Major findings remaining: 1

## Findings

### Blocker
None.

### Major
- **[M1] docs/MODULES.md:315, docs/ROADMAP.md:478, docs/UI-DESIGN.md:610 — artifact evidence is stale under the stipulated rule.** Build start is 2026-11-22 10:59:06 (log filename `build-20261122-105906.log`, cross-checked against `BUILD SUCCESSFUL in 9 min 33 s 573 ms` at `.build-logs/build-20261122-105906.log:1356`, i.e. finish ≈11:08:39). Measured mtimes: `docs/ROADMAP.md` **10:59:45**, `docs/UI-DESIGN.md` **10:59:53** (both during the build), `docs/MODULES.md` **11:14:59** (after the build finished). All three are newer than the build start, so item 7 is inverted per the review rule. Required fix: re-run the clean build after all changed files are final, then re-verify HAP/abc and update the §5/交接节 citations (or record an explicit, reviewed decision that docs are non-compiled inputs and therefore cannot affect the abc — the abc facts themselves do reproduce, see below).

### Minor
- **[m1] DotsPane.ets:241 — intent copy overpromises unimplemented capability.** `Text('dots 可查看实例并对会话发指令，所有操作需你确认。')` asserts the user can view instances and send commands to sessions, but this pane only lists/opens read-only chats; grant/send belongs to `mod-dots-readonly` (pane header comment DotsPane.ets:13-15). The guard `paneLayout.test.mjs:414-416` pins it as a non-clickable subtitle, so nothing pretends to work interactively, but the wording can still be read as a promise. Required fix: reword to describe current capability (e.g. "dots 会话在此只读查看；发指令能力待接入") or mark it explicitly as future intent.

### Nit
- **[n1] .build-logs/build-20261122-105906.log:1358 — "zero UP-TO-DATE" is true only for CompileArkTS.** The build reports `42 tasks in total: 41 executed, 1 up-to-date`; the single UP-TO-DATE task is `:entry:default@PreBuild` (log:12), while `:entry:default@CompileArkTS` at log:1335 is `Finished ... after 5 min 3 s 18 ms` (executed, not up-to-date). Docs are accurate on the specific claim; no action required.

## Checklist

1. **Real list, single data path — PASS.** `DotsPane.ets:28-31` imports only `chatSummaryLine/filterByKind/sortChats` from `model/chatList`, `chatStore` + `ChatListResult` from `services/chatStore`; `PANE_KIND: ChatKind = 'dots'` at :35; `reload()` calls `chatStore.listChats()` at :73 and `sortChats(filterByKind(result.entries, PANE_KIND), 'updated')` at :80; row summary via `chatSummaryLine(item)` at :137; `chatStore.prepare(...)` at :62. No `JSON.parse`/`readTextSync`, no second store, no direct file read (`fileIo` absent). It is a faithful mirror of the reviewed `CloudChatPane.ets:25-29,55-80`.

2. **Rows open read-only detail, no cross-section nav — PASS.** `openDetail()` at `DotsPane.ets:89-94` uses `const params: Record<string, string> = { 'id': id }` and `router.pushUrl({ url: 'pages/ChatDetail', params: params })` — byte-identical to `pages/Chats.ets:201-206`. Guard `indexHeader.test.mjs:259-262` pins DotsPane push inventory `count: 1, literal: ['pages/ChatDetail']`; `shellLayout.test.mjs:344-345` and `structureGuards.test.mjs:431-433` ban `pages/Chats|Home|Settings`.

3. **Still no grant tools / no send; honest disabled action — CONCERN (Minor m1).** `REASON_DOTS: string = 'dots 指令尚未接线'` at `DotsPane.ets:38` is typed and currently true, and is displayed on the disabled action `Text(\`新建对话（${REASON_DOTS}）\`)...enabled(false)` at :229-236. The scaffold input box `输入给 dots 的指令…` is gone from the render tree (only mentioned in the migration comment at :18). No grant/send/service call exists. Copy caveat recorded as m1.

4. **Contract preserved — PASS.** `@Prop deepLinkId: string = ''` / `@Prop active: boolean = true` unchanged (`DotsPane.ets:50-52`); `.visibility(this.active ? Visibility.Visible : Visibility.Hidden)` at :262; single `aboutToAppear()` at :61-64 loads once, no `onPageShow`/timer; four states at :247-255 (error+retry `ErrorBlock` :201-215, loading `LoadingHint` :187-197, list `ChatList` :131-148, empty `EmptyChats` :152-183); no fake rows.

5. **ArkTS soundness — PASS.** `@State chats: ChatIndexEntry[]`, `errorText: string`, `loading: boolean` (`DotsPane.ets:55-59`); `ForEach(this.chats, ...)` with key `(item: ChatIndexEntry) => \`dots-chat-${item.id}\`` at :133-145; four `@Builder`s at :99/:130/:151/:186/:200; no `any`/`unknown`; all 12 imports used. `tsc -p apps/arkui-schedule/tools/tsconfig.json` exit 0, and the build's ArkTS warnings for DotsPane are only deprecation notices (:1172-1179). Code is plausibly what compiled.

6. **Guards retargeted, not weakened — PASS.** All five retargets are equal-or-stricter and id-stable: `indexHeader` H-1/H-2 (+H-5), `paneLayout` P-15/P-16/P-17 (+P-25), `shellLayout` L-11/L-12/L-13 (+L-23), `structureGuards` SG-S7 (+comment), `uiTokens` U-S2/U-S4 (+U-S7). Scaffold pins were *replaced*, not dropped: `REASON_DOTS` exact typed literal, disabled-point count 2→1, DotsPane pushUrl 0→1 (ChatDetail only), old reason/input banned, blanket `ForEach(` ban replaced by `ForEach([`/`ForEach({` **plus** a real positive `ForEach(\s*this.chats` + `chatSummaryLine(item)`. Positives are substantive, not tautological: they run on comment-stripped source (`indexHeader.test.mjs:52`, `paneLayout.test.mjs:143-144`, `uiTokens.test.mjs:45-46`) and SG-S7 uses real field-analysis helpers with self-tests (`structureGuards.test.mjs:181-218,400-431`). Cloud-pane assertions (`PANE_CODES[1]` etc.) are untouched.

7. **Artifact evidence — FAIL (inverted by M1); raw facts reproduce.** Independently re-read from the HAP in memory: HAP `entry-default-unsigned.hap` **5,101,969 B**, sha256 `b9d588b1de9782acfa6dc7028d5bf870d9601636956afe95417aa6bcaa9a5945` — both match; ZIP entry `ets/modules.abc` **2,933,704 B** (= 2,916,952 + **16,752**) — matches; UTF-8 byte-string scan of that in-HAP abc: 「还没有 dots 对话」 **True**, 「dots 指令尚未接线」 **True**, 「dots 尚未接线」 **False**. Build log: `BUILD SUCCESSFUL in 9 min 33 s 573 ms` (:1356), `Finished :entry:default@CompileArkTS... after 5 min 3 s 18 ms` (:1335, executed), `Build completed successfully` (:1361). Staleness M1 formally inverts this item.

8. **Staleness check — FAIL (M1).** See Major M1 for exact mtimes. Three of nine changed files postdate the 10:59:06 build start; `docs/MODULES.md` even postdates the build finish. The compiled input `DotsPane.ets` mtime 10:51:40 predates the build, so the abc genuinely reflects the reviewed code — but the stipulated rule still marks the artifact stale.

9. **Gates — PASS.** `node --test "apps/arkui-schedule/tools/test/*.test.mjs"` → **2808 tests / 390 suites / 2808 pass / 0 fail / 0 skipped / 0 cancelled**, exit 0 (matches docs). `node apps/arkui-schedule/tools/validate-app.mjs` → **8/8** (JSON5/JSON 70, relative import 525, main static import 702, pages 12, rawfile/git 2), exit 0. Also `tsc` exit 0 and the five targeted guards **118/118/0/0**, exit 0.

10. **Docs — PASS.** New rows cite the real numbers (build-20261122-105906.log, HAP 5,101,969 B / sha b9d588b1…, abc 2,933,704 B / +16,752, abc name hits) and all state **未装机 / unverified（安装版 `1000005`；设备检查随 `1000006`）** (`docs/MODULES.md:106` and :315, `docs/ROADMAP.md:478`, `docs/UI-DESIGN.md:610`). Git diff shows only additive rows/paragraphs for this module — no other module's row altered; `§15.19` lives in `docs/VERIFICATION.md:1959`, which is unchanged.

## Residual risk & unverified
- Real-device rendering, keep-alive behaviour across section switches, and dots sessions actually arriving via the sync repo are **unverified** (installed build 1000005; device check deferred to 1000006).
- The stale-mtime issue (M1) is a process/evidence-hygiene defect; it does not contradict the reproduced abc bytes, but the submitted evidence package is formally not final.
- Minor m1 copy wording may overstate current capability to users.
- No build/overlay/git write was performed by this reviewer; `overlay.mjs status` returned `applied=false`.

## Evidence log
- `node apps/arkui-schedule/tools/overlay.mjs status` → `[overlay] applied=false` (precondition checked first).
- `git rev-parse HEAD` → `8c4ddb63934ff84d51a87818a0008ebd8d9c02bc`; `git status --short` → exactly the 9 in-scope modified files.
- Read: `DotsPane.ets` (264 lines), `CloudChatPane.ets`, `chatStore.ets`, `model/chatList.ts`, `Chats.ets:195-209`, all five guard diffs + current source, three docs diffs.
- Build log `.build-logs/build-20261122-105906.log:1335,1356,1358,1361`.
- `Get-FileHash -Algorithm SHA256` + `Get-Item` on HAP: 5,101,969 B / `b9d588b1…a5945`; `System.IO.Compression.ZipFile` in-memory read of `ets/modules.abc`: 2,933,704 B, UTF-8 containment for the three probe strings as recorded in item 7 (no files written).
- `Get-Item LastWriteTime` on all 9 changed files + build log + HAP + abc, as recorded in items 7/8.
- `node --test` (full suite and five guards), `node tools/validate-app.mjs`, `node node_modules/typescript/bin/tsc -p tools/tsconfig.json` — numbers in item 9.
