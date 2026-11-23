# Review — batch 3: pinned-view removal + docs rows

## Verdict
CONDITIONAL PASS — The dead renderer is provably byte-irrelevant (both abc artefacts are byte-identical), the clean-build log proves a genuine `CompileArkTS` recompile, both test retargets are at least as discriminating as before (two mutants each kill the intended branch), and every hash/tag/capture/number cited in the uncommitted docs rows resolves. The only defect found is an off-by-one in a test comment (24 vs 25 zero-importer files). Major findings remaining: 0

## Findings

### Blocker
None.

### Major
None.

### Minor
1. **Zero-importer count differs between code comment and docs/evidence.** `apps/arkui-schedule/tools/test/remoteCommandComposer.test.mjs:271` says "当前树有 25 个合法零 importer 源文件", while `docs/MODULES.md:308` says 24 and the lane's own enumeration prints `ZERO_IMPORTER_COUNT=24` (`.tmp/review-b3-zero-importers.out`, from `.tmp/enumerate-zero-importers.mjs`: `TOTAL_SOURCES=153`). The docs figure is correct; the code comment is off by one. No assertion depends on the number, so this is a comment/consistency defect only.

### Nit
1. The docs-lane self-check `.tmp/gates-docs-removal.out` reports `RESULT: ALL PASS` but is not cited by the new rows; harmless, but the evidence log for the docs lane is otherwise only implicit in `MODULES.md`.

## Checklist

### A. The removal (1–5)

1. **Honest framing / byte identity — PASS.** HEAD blob of the deleted file is `95717264551a54fd8e657aadbef7d883c0cd99e0` (`git rev-parse HEAD:…PinnedRemoteView.ets`); `git diff --numstat` = `0 61`. Both abc artefacts are 1,830,540 B with the same SHA-256 `92D31CC5617DE6372AD2019C4102B074DD98E029121CCCEE2D2E9726123D999D` (`.tmp/modules-badge-truth.abc`, `.tmp/modules-pinned-removal.abc`). UTF-8 scans: `PinnedRemoteView` = 0 in both, `onRemoteOutcome` = 2 in both, `安全连接尚未启用，未向电脑发送凭据。` = 1 in both, `PIN-ATTACK-01` = 0 in both. The lane nowhere claims a size win — `MODULES.md:193` says explicitly "删除既不会回归行为、也不会省体积".

2. **Clean-build integrity (rule 9) — PASS.** `apps/arkui-schedule/.build-logs/build-20261123-145302.log:1386` `Finished :entry:default@CompileArkTS... after 2 min 46 s 403 ms` (EXECUTED), `:1409` `BUILD SUCCESSFUL in 3 min 18 s 659 ms`, `:1411` `42 tasks in total: 41 executed, 1 up-to-date`; count of `UP-TO-DATE … CompileArkTS` = 0. Contrast the badge build (23 executed / 19 up-to-date): the 41/42 executed ratio is consistent with a cleaned incremental state. Console `.tmp/build-pinned-removal.out` contains `[overlay] applied=false` and `✓ 产物验收通过`. Note: neither the log nor the capture explicitly records the `entry\build` / `build` wipe command, so the wipe itself is not directly evidenced — but the recompile is.

3. **No weakened assertion — PASS (mutation-proven).** Baseline copy of the retargeted test: 21/21 pass (`.tmp/review-b3-mutants/baseline.out`). Mutant A — re-add `import { PinnedRemoteView } …` to the copied `RemoteControl.ets`: G4 fails at test `:300` with `删除后不得有任何文件仍 import PinnedRemoteView（悬空 import）` (`.tmp/review-b3-mutants/dangling-import.out`). Mutant B — restore the deleted file: G4 fails at `:295` with `PinnedRemoteView.ets 必须已删除` (`file-restored.out`). The single-composer-importer positive control is unchanged from batch 1. `remotePinnedClient.test.mjs:193-202` retains every security assertion: no `handleConfirm(`, no `loadUrl(` with SYNTH, exactly one `http.createHttp()`, exactly one `.request(url, httpOptions)`, `maxRedirects: 0`, no `getEncoded(`. The deleted view has **zero** hits for all of those tokens (`git show HEAD:…PinnedRemoteView.ets` scan), so removing it from `all = adapter + model` loses no coverage. The RC-3 anchor is real: `tools/check-rc3-release-exclusion.mjs:15` defines `PIN-ATTACK-01`, `:23` defaults `expect` to `absent`, `:43-44` asserts `count === 0`; `.tmp/rc3-exclusion-pinned-removal.out` reports `sentinel=PIN-ATTACK-01 expect=absent hits=0 PASS`, `exit=0`.

4. **Rejected global invariant — PASS (not an excuse).** The enumeration is plausible: 24 of 153 sources are legitimately zero-importer, including `@Entry` pages (`ChatDetail.ets`, `Chats.ets`, `Home.ets`, `Instances.ets`, `Settings.ets`, …), `EntryAbility.ets`, harness/stub files (`rc3GateHarness.ts`, `remotePinnedClient.ets`) and pure helpers (`pageBook.ts`, `tableOcr.ts`, `toolbarMetrics.ts`). A global "every source has ≥1 importer" rule would false-positive on all 24; declining it is sound. G4 still pins absence + composer's single importer + no dangling import, so the dead-code class is not left unwatched. The off-by-one comment is Minor 1, not a rationale defect.

5. **No scope creep — PASS.** `git status --porcelain` for this lane: exactly `D …components/PinnedRemoteView.ets`, `M …tools/test/remoteCommandComposer.test.mjs`, `M …tools/test/remotePinnedClient.test.mjs` (plus the independent `M docs/MODULES.md` and the pre-existing `M AppScope/app.json5`). No `docs/**` in the code stage set; `app.json5` is the earlier versionCode bump and must not ride. `model/remoteCommandGate.ts` still hashes `08fafb06cfa52133800a9bbb25b4d5d86db6da6c` (worktree = HEAD).

### B. Docs rows (i–v)

(i) **Hashes/tags — PASS.** `git show -s` confirms `8f851ca` = `fix(app): mod-pairing-badge-truth…`; annotated tag `92b567a` → `object 8f851ca1bacfdf53262b2b41ce973dc413ce0a37`. `eec319c`, `132f576` exist with the stated docs subjects. The removal row legitimately leaves `（Lead 填）` pre-commit. Cited source commit `9db7228` exists (earlier verified).

(ii) **Captures exist at exact paths — PASS.** New rows cite `.tmp/gates-badge-truth.out`, `.tmp/gates-planner-b9-batch2-final.out`, `.tmp/build-badge-truth.out`, `.tmp/modules-badge-truth.abc`, `.tmp/tsc-pinned-removal.out`, `.tmp/gates-pinned-removal-targeted.out`, `.tmp/gates-pinned-removal.out`, `.tmp/validate-pinned-removal.out`, `.tmp/rc3-exclusion-pinned-removal.out`, `.tmp/build-pinned-removal.out`, `.tmp/modules-pinned-removal.abc` and the build log — all exist. `.tmp/gates-docs-badge.out` does **not** exist, and a repo-wide grep shows `MODULES.md` never cites it (the badge row uses `gates-badge-truth.out`). No false citation.

(iii) **No install/device over-claim — PASS.** Badge row (`MODULES.md:192`) says 未装机 / unverified for badge transition, `@StorageLink/@Watch` firing and real connectivity; removal row (`:193`) says 未装机 / 设备行为不变且 unverified; §5 rows (`:474-475`) repeat the same boundaries. HAP 2,386,116 B / 15 entries and validate 606 rel / 836 main imports are exact.

(iv) **24-file enumeration — PASS with Minor 1.** Docs `:308` says 24; the lane script prints 24; the test comment says 25 (Minor 1). No functional assertion uses the count.

(v) **No contradiction with batch-2 review — PASS.** Batch-2 verdict was CONDITIONAL PASS / 0 Major with two Nits; `MODULES.md:192` and `:474` record exactly that and explicitly carry both Nits (historical `[待 RC-4]` tokens; cert-refusal→`fail` copy as accepted honesty). The §2 correction (`MODULES.md:311`) voids the earlier "no other claimant" note for `RemoteControl.ets` without rewriting history, consistent with the two-claimant fact. The `> 订正` at `:195` states the old pinned-client row implied a shipped native rendering path that never compiled, while the pinned client half is unchanged and still unverified — consistent with abc evidence.

### Additional checks

6. **Commit-split question — one docs commit is defensible.** The three hunks (`+192,4`, `+305,6`, `+474,2`) interleave badge and removal lines within the same tables; a file-level split is impossible, and line-level staging would risk committing half a table row. Repo precedent `d9c015c` is explicitly `feat(app): 两模块合并——…(instances-pane) + …(dedupe)`, i.e. one commit carrying two module ids. Recommendation: **single docs commit** with both ids in the subject (e.g. `[mod-pairing-badge-truth][mod-pinned-view-removal] docs: …`), keeping the 3-path code commit separate. No split required.

7. **Reviewer re-ran gates — PASS.** Captured with `Tee-Object`: `.tmp/review-b3-tsc.out` EXIT=0; `.tmp/review-b3-app-suite.out` `3148/3148/0/0`; `.tmp/review-b3-validate.out` 8/8 (70 JSON5 / 606 relative imports / 836 main imports / 12 pages / 2 rawfile — one less each than batch 2, matching the deletion); `.tmp/review-b3-overlay.out` `[overlay] applied=false`.

## Stage sets confirmed
- **Code commit (3 paths):** `D apps/arkui-schedule/entry/src/main/ets/components/PinnedRemoteView.ets`; `M apps/arkui-schedule/tools/test/remoteCommandComposer.test.mjs`; `M apps/arkui-schedule/tools/test/remotePinnedClient.test.mjs`.
- **Docs commit (1 path):** `M docs/MODULES.md`.
- **Must NOT ride:** `M apps/arkui-schedule/AppScope/app.json5` (earlier versionCode bump), and both already-committed review files (batch-1 and batch-2).

## Residual risk & unverified
- **Device behaviour — unverified:** no `hdc`/device run; badge transition, `@StorageLink/@Watch` firing, real TLS refusal and real connectivity remain unobserved.
- **Build wipe — unverified as a recorded action:** the log proves a genuine recompile (41/42 tasks executed, CompileArkTS EXECUTED, zero UP-TO-DATE for it) but does not record the `entry\build` / `build` deletion command itself.
- **No ArkTS rebuild by the reviewer** (charter forbids): rule-9 evidence rests on the retained log + source diff; abc/HAP bytes are tree-level corroboration.
- **Committed batches 1–2 not re-litigated**; only contradictions introduced by batch 2/3 rows were checked (none).
- **Zero-importer comment drift** (Minor 1) may confuse future readers even though docs and evidence agree on 24.

## Evidence log
- Read-only git: status, `diff`, `numstat`, `show -s`, `cat-file -p`, `rev-parse HEAD:<path>`, `hash-object`, `log --grep`, `show HEAD:<deleted file>`.
- Read-only pwsh: abc byte/SHA comparison and UTF-8 name scans, build log line scan, HAP size, capture-existence sweep, zero-importer enumeration, frozen-path status.
- Mutation harness: `.tmp/review-b3-mutants/{make.mjs,baseline.out,dangling-import.out,file-restored.out}`.
- Gates re-run with `Tee-Object`: `.tmp/review-b3-{tsc,app-suite,validate,overlay}.out`.
- No source edits, no ArkTS build, no `hdc`, no git write; temp artefacts only under `.tmp/`.
