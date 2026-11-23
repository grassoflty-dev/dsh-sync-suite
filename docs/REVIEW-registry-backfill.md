# Review — registry backfill

Scope reviewed: uncommitted lane `mod-registry-backfill` (docs only) — `docs/MODULES.md`, `docs/ROADMAP.md`, `docs/SELF-TEST-REMOTE.md`, and the one-token comment `scheme 固定 http` → `https` in `apps/arkui-schedule/entry/src/main/ets/model/remoteAnnounceRefresh.ts`. All checks are read-only (git log/tag/diff, gate logs, file bytes). No builds, no device commands, no git writes were performed by this review.

## Verdict

PASS — every required §1/§2/§5 row is present, all ten hashes and their tags verify against `git log`/`git tag`, all cited gate numbers match the retained logs, the two policy statements appear exactly once, §0 rule 9 is not duplicated, the §2.1 pre-flight is runnable, and no device result is over-claimed; only two non-blocking Minor issues remain (a stale gate-log path pointer and unrelated concurrent-lane changes in the shared working tree). **Major findings remaining: 0**

## Findings

### Blocker

None.

### Major

None. Specifically:

- No wrong hash: all ten claimed hashes resolve to real commits with the stated subjects.
- No fabricated tag: each `module/...` tag returned by `git tag --points-at <hash>` matches the documented tag exactly.
- The reported correction is genuine: Phase A is tagged `module/mod-sync-ui-silence-a` (not `module/mod-sync-ui-silence`), and the docs use the corrected form at MODULES L179/L436 and ROADMAP L782.
- No over-claimed device result: every in-scope row reads `待 Lead 实测` / `unverified` / `未装机` except (a) the `1000011` layout check for `mod-sync-ui-silence` and (b) `1000009` for `mod-empty-remote-unborn-head` via §15.21 (confirmed to exist at `docs/VERIFICATION.md:2179`). The `1000011` HAP provenance sentence for `mod-pairing-id-pin` is explicitly marked "built before commit, do not claim post-commit testing", so it is not an over-claim.
- No duplicated policy statement: each of the two statements occurs once (MODULES L21 and L23 respectively) across all of `docs/`.
- §0 rule 9 (MODULES L17) is untouched; the tree-level-artifacts line at L23 is a one-line pointer that explicitly says "规则 9 已有完整门槛、此处不重复".

### Minor

1. **Stale gate-log path for `mod-plugin-repo-precheck`.** Both the §1 row (MODULES L175) and the §5 row (L432) cite `packages/dsh-dots/.tmp/gates-plugin-repo-precheck.out`, but the retained log actually lives at repo-root `.tmp/gates-plugin-repo-precheck.out` (97,344 B). The cited numbers **713 / 706 / 6 / 1** are correct (verified from the file), so this is a pointer-location typo only. For contrast, `gates-plugin-git-auth-env.out` genuinely is under `packages/dsh-dots/.tmp/`, and `gates-plugin-outbox-per-intent.out` is correctly cited as root `.tmp/`.
2. **Out-of-scope changes exist in the shared working tree** (flagged as instructed). Beyond the four in-scope files, `git status` shows modified app/plugin source files, six deleted `apps/arkui-schedule/entry/.test/default/intermediates/**` files, and untracked `docs/REVIEW-*.md` plus test files. These correspond to other concurrent lanes (pairing/listener-truth, git-auth, reachability) and are not modifications made by this docs-only backfill; the diff of the four in-scope files is consistent with the declared scope. No tracked `docs/VERIFICATION.md` or `docs/REVIEW-*` file is modified by this lane.

### Nit

- Three pre-existing table rows fail a naive pipe count but were **not** introduced by this lane (all present at HEAD): §1 L160 `mod-repo-privacy-gate` (6 columns instead of 7), §1 L168 `mod-plugin-pairing-client` and §5 L364 `mod-cleanup-quickrecord` (pipes inside inline code such as `DSHDOTS1|…` inflate the count). Every row added by the backfill has the correct column count. No existing row was renumbered.

## Hash/tag audit table

| Row (module, section) | Hash claimed | `git log --oneline -1` resolves? | Tag claimed | `git tag --points-at` matches? |
| --- | --- | --- | --- | --- |
| `mod-plugin-git-auth-env` (§1/§2/§5) | `aba2a7a` | YES — `fix(plugin): unify Git auth and require private repos before saving` | `module/mod-plugin-git-auth-env` | YES |
| `mod-plugin-repo-precheck` (§1/§2/§5) | `aba2a7a` | YES — same commit as auth (both tags point at it) | `module/mod-plugin-repo-precheck` | YES |
| `mod-crash-settings-sync` (§1/§2/§5) | `1b063d7` | YES — `fix(app): ...设置→同步仓库不再闪退...` | `module/mod-crash-settings-sync` | YES |
| `mod-empty-remote-unborn-head` (§1/§2/§5) | `d4ba0f3` | YES — `fix(sync): ...未出生 HEAD...` | `module/mod-empty-remote-unborn-head` | YES |
| `mod-status-honesty-regression` (§1/§2/§5) | `e31fc49` | YES — `fix(app): ...单一总数函数...` | `module/mod-status-honesty-regression` | YES |
| `mod-sync-ui-silence` Phase A (§1/§2/§5) | `55595dd` | YES — `feat(app): ...Phase A...versionCode 1000009` | `module/mod-sync-ui-silence-a` | YES (correction verified; no `-silence` tag used) |
| `mod-sync-ui-silence` Phase B (§1/§2/§5) | `dfab5a2` | YES — `feat(app): mod-sync-silence-phase-b...` | `module/mod-sync-silence-phase-b` | YES |
| `mod-pairing-id-pin` (§1/§2/§5) | `60b8619` | YES — `fix(app): ...配对更新保留原实例 id...` | `module/mod-pairing-id-pin` | YES |
| `mod-plugin-outbox-per-intent` (§1/§2/§5) | `1d640ec` | YES — `fix(plugin): verify parked sync intents individually` (current HEAD) | `module/mod-plugin-outbox-per-intent` | YES |
| `mod-plugin-lean-panel` (merged row §1/§5) | `cd78008` | YES — `feat(plugin): mod-plugin-lean-panel...` | `module/mod-plugin-lean-panel` | YES |

No hash or tag failed verification.

## Checklist

1. **Required §1 rows — PASS.** All nine required rows present at MODULES L164 (`mod-plugin-lean-panel` merged), L174 (`git-auth-env`), L175 (`repo-precheck`), L176 (`crash-settings-sync`), L177 (`empty-remote-unborn-head`), L178 (`status-honesty-regression`), L179 (`sync-ui-silence` A+B), L180 (`pairing-id-pin`), L182 (`outbox-per-intent`). Each has 7 columns; `aba2a7a` rows carry their own tags and the 「同提交，不单独 revert」 note; `55595dd`/`dfab5a2` row states reverse-order revert (`git revert dfab5a2` → `git revert 55595dd`) and claims only the `1000011` layout check; `60b8619` row carries the HAP-built-before-commit provenance; `1d640ec` row carries 33/33 cycle rerun and the lean row keeps three iterations in §5.
2. **Hashes/tags real — PASS.** See audit table; `git log --oneline -1` and `git tag --points-at` agree for all ten; Phase-A tag correction confirmed.
3. **§2 rows — PASS.** All nine modules have §2 rows at L265/L273–L279/L281, each with 4 columns and naming shared files plus the concrete risk (e.g. shared `git.ts`/`gitPort.ts` + single `dist/` window for the `aba2a7a` pair; `syncCycle.ts` + git bridge for `d4ba0f3`; reverse-order rollback for `55595dd`/`dfab5a2`).
4. **§5 gate numbers — PASS.** §5 rows L431–L439 (6 columns each). Verified from retained logs: `gates-plugin-git-auth-env.out` = 3764 tests / 3763 pass / 0 fail / 1 skipped; `gates-plugin-repo-precheck.out` = 713 / 706 / 6 / 1; `gates-plugin-outbox-per-intent.out` = 3788 / 3787 / 0 / 1; lean iterations 618/617/0/1, 625/624/0/1, 628/627/0/1; `gates-outbox-lead.out` = 33 tests / 33 pass / 0 fail (the cited 33/33 cycle rerun); build log `build-20261122-161216.log` exists with `BUILD SUCCESSFUL` and `CompileArkTS` Finished after 26 s 349 ms. All numbers match; only the repo-precheck path is mis-typed (Minor 1).
5. **Policy statements once — PASS.** Version-gap note at MODULES L21 ("`1000008` 与 `1000010` 从未作为提交存在", consistent with git history: commit `c075bc4` only mentions them as gaps, no version-bump commit); tree-level-artifacts pointer at L23, one line, explicitly deferring to §0 rule 9; rule 9 itself at L17 unchanged (diff hunk `@@ -20,0 +21,4 @@` only adds the four pointer lines).
6. **SELF-TEST-REMOTE §2.1 pre-flight — PASS.** Added block (L71–L76) requires `enabled === true` and a successful TCP connect before any pairing test, with a runnable Node probe: `node -e "require('net').connect({port:44996,host:'127.0.0.1'}).on('connect',()=>{console.log('OPEN');process.exit(0)}).on('error',e=>{console.log('CLOSED',e.code);process.exit(0)})"`; `OPEN` is the success signal, with a note to substitute the actual scanned port.
7. **Honesty — PASS.** No device claim beyond the `1000011` layout check (`查看状态=false / 测试连接=false / 重试=false / 保存=true`) and `1000009` via §15.21 (`docs/VERIFICATION.md:2179`). All other in-scope rows read `待 Lead 实测` / `unverified` / `未装机`. No in-scope row contains a `（Lead 填）` that was filled in; the five `（Lead 填）` occurrences in added lines belong to other lanes' rows (`mod-sync-single-flight`, `mod-plugin-pairing`, `mod-pairing-listener-truth`, §5 lean panel) and remain unfilled.
8. **Structure — PASS.** Column counts preserved for every added row (§1=7, §2=4, §5=6; verified by pipe counting). UTF-8 no BOM (first bytes `23 20 E6` / `23 20 52` / `23 20 E8` for the three docs — `# `, no EF BB BF). No renumbering of existing rows; diff hunks are pure insertions (`+N,0`) plus one replacement hunk (`-160,2 +166`). Exactly 2 deletions in MODULES.md (the superseded `mod-plugin-lean-panel-r2` row and its trailing blank line); numstat: MODULES 48+/2−, ROADMAP 12+/0−, SELF-TEST-REMOTE 7+/0−, TS 1+/1− (comment token only).
9. **§15.x untouched — PASS.** `git diff --name-only` contains no `VERIFICATION.md` or `REVIEW-*` path; `docs/VERIFICATION.md` is absent from `git status`; the four existing `docs/REVIEW-*.md` files are untracked (created by other lanes), not modified by this lane. Out-of-scope working-tree changes are flagged under Minor 2.

## Residual risk

- The mis-cited `gates-plugin-repo-precheck.out` path (Minor 1) could send a future reader to the wrong `.tmp` directory; the numbers themselves are trustworthy and the log is retained at repo root.
- The shared working tree contains many concurrent-lane changes; a Lead performing the final freeze must attribute them lane-by-lane and re-verify build artifacts (tree-level facts are not module evidence per §0 rule 9). This review did not attempt to validate those changes.
- `1000011` layout-check evidence and `1000009` §15.21 evidence were accepted as cited by the docs (permitted by the review brief); their underlying device logs were not re-opened here.

## Evidence log

- `git status --short`, `git diff --numstat`, `git diff --unified=0/1` on the four in-scope files (branch `main`, HEAD `1d640ec`).
- `git log --oneline -1 <hash>` and `git tag --points-at <hash>` for all ten hashes.
- `git diff` full hunks for MODULES.md / ROADMAP.md / SELF-TEST-REMOTE.md / remoteAnnounceRefresh.ts.
- Gate logs read: `packages/dsh-dots/.tmp/gates-plugin-git-auth-env.out`, `packages/dsh-dots/.tmp/gates-plugin-{lean-panel,lean-panel-r2,lean-panel-d1d2,pairing}.out`, repo-root `.tmp/gates-plugin-{repo-precheck,outbox-per-intent}.out`, `.tmp/gates-outbox-lead.out`.
- Build log read: `apps/arkui-schedule/.build-logs/build-20261122-161216.log` (plus existence of `build-20261122-154124.log`, `build-20261122-154949.log`).
- Byte-level BOM check and CRLF/LF count on the three docs; pipe-count audit of §1/§2/§5 rows; cross-reference `docs/VERIFICATION.md:2179` (§15.21).
- `git log --all --grep=1000008|1000010` and `git show --stat c075bc4` for the version-gap statement.
