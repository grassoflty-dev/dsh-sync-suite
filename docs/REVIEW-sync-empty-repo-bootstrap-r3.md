# Re-review — mod-sync-empty-repo-bootstrap (r3, focused)

Independent READ-ONLY focused re-review of the working tree on `main` @ `7b109938b8ae469c1bb699a00d18d77879b31eda`. Overlay verified `applied=false` before any gate. No build, no `tools/overlay.mjs` write, no git write command, no subagent; exactly one file written (this report). Both permitted gates were run first-hand: `tsc -p apps/arkui-schedule/tools/tsconfig.json` → exit 0; `node --test apps/arkui-schedule/tools/test/syncEmptyBootstrap.test.mjs` → tests 25 / pass 25 / fail 0. All other evidence is source, read-only git diff/status, and read-only artifact checks. Scope is the two r2 findings fixed after r2 (M3b-prod, M2b), plus the eight required checks.

## Verdict

CONDITIONAL PASS — both scoped fixes are real, not cosmetic, and honestly pinned; zero Major findings remain. Two Minors persist (stale doc line anchors carried over from r2 Minor 2, and a narrow new `requireReady()` precondition introduced by the one-line production fix), and real-device behaviour remains unverified.

Major findings remaining: 0

## M3b-prod

**CLOSED.** Evidence:

- The call is inside the production `WritePort.writeDay` (`apps/arkui-schedule/entry/src/main/ets/services/syncProtocolStore.ets:320`), as the first statement at `:321`, strictly before the delegation `this.writeDayTexts(date, texts)` at `:322`.
- `git diff --numstat -- .../syncProtocolStore.ets` → `1  0`; the full diff is a single hunk `@@ -318,6 +318,7 @@` containing only that line. The rest of the file is byte-identical to HEAD — the fix is real, not cosmetic.
- `timelineWriteStore` is imported at `syncProtocolStore.ets:33`; the singleton is exported at `timelineWriteStore.ets:709`; `ensureSkeleton(): void` is declared with no access modifier (public) at `timelineWriteStore.ets:116`.
- Anti-regression pin: test 23 (`apps/arkui-schedule/tools/test/syncEmptyBootstrap.test.mjs:648-663`) asserts the whole file contains `ensureSkeleton(` **exactly once** (`:652-653`), locates the `writeDay` signature (`:654-655`) and the `writeDayTexts` delegation (`:656-657`), and requires the skeleton call to lie between them with no `atomicReplaceText`/`appendDedupLines` in that slice (`:658-662`). Deleting or moving the line fails the test.

## M2b

**CLOSED.** Evidence:

- `typedProbeCode()` (`apps/arkui-schedule/entry/src/main/ets/model/syncCycle.ts:411-419`) whitelists `E_SYNC_UNAVAILABLE_CODE` at `:415`; the constant is `'E_SYNC_UNAVAILABLE'` at `:174`.
- `probeFailureOutcome()` (`syncCycle.ts:422-435`) emits the readiness message at `:424-425`: `远端状态探测失败；${E_SYNC_UNAVAILABLE_MESSAGE}（${text}）`. `E_SYNC_UNAVAILABLE_MESSAGE` (`:180-181`) = code + `同步内核或 GitRunner 未就绪` (`:175`) + `下一步：记录已保存在本机，请稍候；页面就绪后会自动重试…` (`:177-178`) — no "检查网络与仓库地址" blame.
- `gitRunner.ets:57-58` throws exactly that message from `requireService()`; `gitRunner.ets:139` invokes it **outside** the parse-only `try` (`:140-149`), so a readiness rejection reaches the typed probe catch rather than the fail-closed parse fallback at `:148`.
- Pin: test 24 (`syncEmptyBootstrap.test.mjs:665-682`) asserts `code === 'E_SYNC_UNAVAILABLE'` (`:673`), message contains `页面就绪后会自动重试` (`:675`), does **not** contain `检查网络与仓库地址` (`:676`), `attempts === 0`, zero commit/push/fetch, outbox intact (`:677-681`).
- No other typed code is mis-mapped in the probe path: `E_AUTH`/`E_IO`/`E_GIT` are preserved by the same whitelist (`:413-416`), and `remoteLayout()` (`gitRunner.ets:137-150`) throws only `E_SYNC_UNAVAILABLE`, `E_AUTH`, `E_IO` or `E_GIT`.

## Required checks (PASS / CONCERN / FAIL)

1. **M3b-prod real — PASS.** Single-line diff at `syncProtocolStore.ets:321`, inside `writeDay` (`:320`), before `writeDayTexts` (`:322`); import `:33`; public `ensureSkeleton()` at `timelineWriteStore.ets:116`. Full detail above.
2. **Canonical/atomic/no-op skeleton — PASS.** `freshStart.ts:13` fixes the one contract spelling `FRESH_SCHEMA_TEXT = '{"schemaVersion":2}\n'`; `timelineWriteStore.ets:68` fixes `SCHEMA_FILE_NAME = 'schema.json'`. `ensureSkeleton()` (`:116-125`) calls `requireReady()` (`:117`), `timelineRoot()` (`:118`), `ensureDirSync(root)` (`:119`), reads the marker (`:120-121`) and writes only under `if (decideFreshStart(markerText).needSchema)` (`:122-123`). `decideFreshStart` (`freshStart.ts:32-41`) sets `needSchema=false` for any present text, v2 or not, so a present non-v2 marker is **not** overwritten here; it is refused by `bootstrapSchemaGate` (`syncCycle.ts:361-369`) → `gateFailure` (`:479-486`) → `E_SCHEMA_UNKNOWN`. `atomicWriteIn` (`:509-557`) writes a same-dir tmp (`:518`), read-back verifies length+content byte-for-byte (`:519`, `:560-569`), then renames (`:523`) with backup/restore fallback (`:528-555`). Tests 15/21 pin the refusal and byte preservation (`syncEmptyBootstrap.test.mjs:505-520,616-629`).
3. **Bootstrap chain end-to-end — PASS, no hole found.** Gate admits `needSchema` **with** a writer but refuses without one (`syncCycle.ts:478-487`, notably `:479`); stage 1 calls `write.writeDay` (`:503-508`), which in production materialises the marker via `syncProtocolStore.ets:321`; the model re-reads `localSchemaText()` and re-validates at `syncCycle.ts:540-553`, **before** `addPaths` (`:569`) and `commit` (`:570`). `readDay` (`syncProtocolStore.ets:308-318`) and `unionDay` are read/pure — no timeline write precedes the gate. Corrupt day mid-stage-1 refuses safely with `corruptOutcome` + outbox persistence and zero commit/push (`syncCycle.ts:495-499`); a marker created by an earlier date is then harmless (no commit). No-writer preview (`syncCycle.ts:479`) and absent `localSchemaText` port (`:470-477,479-480`) stay fail-closed. Tests 19–22 (`syncEmptyBootstrap.test.mjs:584-644`) exercise each of these branches.
4. **M2b — PASS.** Detail above.
5. **Tests pin it honestly — PASS.** 25 cases, 25/25 first-hand (r2 had 23). Test 23 (`:648-663`) is a genuine source-shape guard for the production one-liner, not a fake-based proxy. Test 24 (`:665-682`) pins `E_SYNC_UNAVAILABLE` end to end. The earlier fake-based tests 19–22 remain meaningful: they pin pure-model gate/re-read/fail-closed behaviour that the production fix does not replace, and the fake writer (`syncEmptyBootstrap.test.mjs:227-245`, schema self-supplied at `:233-235`) is now *more* faithful to production, not less — r2's fidelity gap is closed. No assertion weakened: the test file is untracked (`git status --short` → `?? apps/arkui-schedule/tools/test/syncEmptyBootstrap.test.mjs`), so no HEAD diff exists; compared with r2's checklist, all earlier assertions (tests 1–22 incl. `:417`, `:518`, `:627`, `:640`) are still present, and the only delta is two additive cases (23, 24).
6. **Build artifacts — PASS (verified first-hand).** `apps/arkui-schedule/.build-logs/build-20261121-191210.log`: `BUILD SUCCESSFUL` ×1, `Finished :entry:default@CompileArkTS... after 1 min 13 s 209 ms` (EXECUTED, with duration), `UP-TO-DATE :entry:default@CompileArkTS` = **0**, `Finished :entry:default@PackageHap... after 15 s 20 ms`, `42 tasks in total: 41 executed, 1 up-to-date`. `.tmp/build-bootstrap-m3bprod.out`: `✓ 产物验收通过` ×1 and `[overlay] applied=false` ×1. HAP `entry-default-unsigned.hap` = **4,927,347 B**, whole-file SHA-256 `d4aa33b2738d807cbd49880f027818700ef4e2222217dd387befb3553e5c46f6`, 16 entries; `ets/modules.abc` = **2,831,264 B**, SHA-256 `5b26166197c4263587204c02f2d516f91ab49d92458bcb1034b7932a1e3c46b6`; `resources/rawfile/git/git-bridge.js` = **91,493 B** with `op === 'remoteLayout'` ×1, `op === 'listLocalTimeline'` ×1, `op === 'readLocalTimelineSchema'` ×1, `git.getRemoteInfo(` ×1, `allNames.length === 0` ×1, `force: false` ×2. The docs were concurrently patched to these final numbers: `docs/MODULES.md:272` and `docs/ROADMAP.md:671` now show 25/25, 4,927,347 B, 3164, `build-20261121-191210.log`; a grep for `185728` / `23 例` / `3162` / `4,926,900` across `docs/` hits only the historic r2 review (`:43,:49`) and an unrelated file (`REVIEW-v2-read-service.md:5`, about `timelineService.test.mjs`) — the live docs settled, no re-read discrepancy.
7. **Docs state the new truth — CONCERN (one carried-over Minor only).** Module registered consistently in §1 (`docs/MODULES.md:90`), §2 (`:169`), §5 (`:272`), §6 (`:377`) and `docs/ROADMAP.md:671`. No surviving "一个字未改"/"byte-identical" claim about `syncProtocolStore.ets`: both docs explicitly say "1 insertion, 其余字节不变" (`MODULES.md:90,169,377`; `ROADMAP.md:671`). The "普通周期…一字未改" wording is scoped to `syncCycle.ts` normal-path logic and is immediately corrected with the `E_PULL_FAILED` typed branch (`MODULES.md:272`, `ROADMAP.md:671`), so it is not a byte-identity claim about the touched file. The only defect is stale line anchors — see Minor 1.
8. **Regression surface — CONCERN (one narrow new precondition only).** `remoteLayout` absent → probe block skipped (`syncCycle.ts:612`), fetch/gate/union/commit unchanged (`:632-751`); `hasMain=true` → `remoteStateDecision` = `normal` (`:623-626`), no bootstrap; fetch failure → `E_PULL_FAILED` (`:637`); probe failure → `E_AUTH`/`E_IO`/`E_GIT`/`E_SYNC_UNAVAILABLE` (`:422-435`); non-empty-no-main → `E_GIT`, zero writes (`:383-391`, `:627-629`). `writeDay` **does** run on the normal path (`syncCycle.ts:711-716`), so `ensureSkeleton()` executes there too; because the gate at `:639-642` guarantees a valid v2 marker, `decideFreshStart` returns `needSchema=false` and the call is an idempotent marker read + `ensureDirSync` — **no new bytes, no new write on the normal path**. The residual delta is the `requireReady()` precondition — see Minor 2.

## New findings

### Blocker
None. No path force-pushes, rebases, rewrites remote history, or touches `devices/**`; the single added line only creates an idempotent local marker.

### Major
None. M3b-prod and M2b are both closed with production-side and static evidence.

### Minor
1. **Stale line anchors (r2 Minor 2, not fixed).** `docs/MODULES.md:272` / `docs/ROADMAP.md:671` still cite `syncCycle.ts:511-517` for the `fetchMain()` failure catch (actual `:632-637`), `bootstrapSchemaGate (syncCycle.ts:361-371)` (actual `:361-369`), pre-write gate `:456-482` (actual `:462-487`) and post-stage-1 re-read `:530-547` (actual `:540-553`). Content is correct; only the anchors drifted. Carried over from r2, not introduced by this fix.
2. **New `requireReady()` precondition on the normal path.** `ensureSkeleton()` calls `this.requireReady()` (`apps/arkui-schedule/entry/src/main/ets/services/timelineWriteStore.ets:117`), which throws at `:307-311` if `ensureReady` never ran. Since `writeDay` runs on the normal cycle (`syncCycle.ts:711-716`), a sync reached through `recordWriter.triggerSync()`'s failure branch (`recordWriter.ets:95-115`, which binds only `syncProtocolStore` via `gitRunner.ets:209-211`) before any page bootstrap can now throw where `writeDayTexts` previously worked. All page-driven entries do initialise the store first (`Index.ets:394`, `SchedulePane.ets:431` → `summaryStore.ets:38`), so this is narrow and bounded; not a Major. It is also not pinned by a test (test 23 checks source shape, not runtime readiness).

### Nit
None.

## Residual risk & unverified

- Real-device behaviour remains `unverified`: two-device first sync against a genuinely empty HTTPS remote, `getRemoteInfo` advertisement/auth on the actual endpoint, HAP WebView bridge round-trip, and whether a virgin install can reach bootstrap with `timeline/schema.json` actually absent (startup `ensureReady` pre-creates it — `Index.ets:394`, `summaryStore.ets:38`, `timelineWriteStore.ets:104`).
- Full-suite numbers in the docs (`3164 tests`, `validate-app 8/8`) were not reproduced here; only `tsc` exit 0 and the targeted 25/25 were run first-hand. Compile evidence rests on the verified artifacts in check 6, not a new build in this review. HAP is documented as 未装机 (`MODULES.md:272`).
- Bridge JS cannot execute in the node harness (needs host `fileExists`/`readFileBase64`/`getRepoRoot`); M1's all-ref-category computation is source-verified and statically pinned only (`syncEmptyBootstrap.test.mjs:436-437`).
- Working tree also contains out-of-scope changes not reviewed or modified: `apps/arkui-schedule/AppScope/app.json5` and `docs/UI-DESIGN.md`. Untracked files: the test file, `REVIEW-sync-empty-repo-bootstrap.md`, `REVIEW-sync-empty-repo-bootstrap-r2.md`.

## Evidence log

- `node apps/arkui-schedule/tools/overlay.mjs status` → `[overlay] applied=false` (gate precondition).
- `git rev-parse HEAD` → `7b109938b8ae469c1bb699a00d18d77879b31eda`; `git branch --show-current` → `main`; `git status --short` → 8 modified + 3 untracked.
- `git --no-pager diff` + `--numstat` on `syncProtocolStore.ets` → one hunk, `1 0`; on `syncEmptyBootstrap.test.mjs` → empty (untracked).
- `node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json` → exit 0; `node --test "apps/arkui-schedule/tools/test/syncEmptyBootstrap.test.mjs"` → tests 25 / pass 25 / fail 0 (cases 1–11, 7b, 12–24).
- `read`: r2 review (60 lines); `syncProtocolStore.ets:1-50,128-224,300-369,380-419`; `syncCycle.ts:160-259,350-589,590-807`; `freshStart.ts:1-41`; `timelineWriteStore.ets:1-140,260-329,500-579,709`; `gitRunner.ets:40-159,195-211`; `recordWriter.ets:1-115`; `summaryStore.ets:29-40`; `syncEmptyBootstrap.test.mjs:222-251,645-682`; `MODULES.md:86-93,268-275`; `ROADMAP.md:671`; `Index.ets:382-403`; `SchedulePane.ets:426-435`.
- `grep`: `E_SYNC_UNAVAILABLE_*` in `syncCycle.ts` (`:174,180-181,238-240,415,424-425`); `atomicWriteIn`/`SCHEMA_FILE_NAME` in `timelineWriteStore.ets`; `ensureReady`/`timelineWriteStore` across `*.ets`; stale numbers and "一字未改"/"其余字节不变" across `docs/`.
- Read-only artifact checks (PowerShell 5.1, `Add-Type -AssemblyName System.IO.Compression[.FileSystem]`): regex counts on the build log and `.tmp` tail; `[System.IO.File]::OpenRead` + `SHA256` over the whole HAP; `ZipFile::OpenRead` + per-entry `MemoryStream` hashes and UTF-8 needle counts on the packaged bridge (numbers in check 6).
