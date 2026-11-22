# Review — mod-plugin-repo-root

## Verdict
CONDITIONAL PASS — The PC-owned default root, removal of `E_NO_APP_FILES_DIR`, migration safety, first-use self-clone, byte parity and all measured gates hold; the only substantive defect is that the T10 no-force scan is a coarse regex list that can be bypassed by alternative spellings, so the "cannot be bypassed by spelling" claim is false. Major findings remaining: 1

Scope note: reviewed at repo HEAD `ad1d83c` (one commit past the stated `4c5de17`; the extra commit is the out-of-scope tablet-side `mod-repo-privacy-gate`). Out-of-scope sibling-lane files (`src/client.js`, `dist/client.js`, `scripts/build.mjs`, `client-*.test.mjs`) were not modified or reviewed except where a gate necessarily includes them.

## Findings

### Blocker
None.

### Major
1. **T10 no-force scan can be bypassed by spelling — claim 5 overstates the guard.** `test/plugin-tools-v2.test.mjs:348-352` forbids only `/--force\b/`, `/force\s*:\s*true/`, `/pull\s+--rebase/`, `/reset\s+--hard/`, and delete calls. I evaluated the pattern set against concrete force-push spellings: `git push … -f`, `git push origin +main`, and `git -c push.force=true push` all return **BYPASS** (not matched), while `--force-with-lease` and `reset --hard` are caught. The scan is also an explicit file list (`:341-346`), so a new source file is not covered. The reviewed code itself is clean (`gitPort.ts:152-158` validates `{remote:'origin',branch:'main',force:false}` and issues a fixed `['push','--porcelain','origin','HEAD:main']`), so this is a false-assurance / guard-robustness defect, not a present force-push. Correct the documentation claim or extend the guard (e.g. reject any push whose args contain `-f`, a `+`-prefixed refspec, or `push.force=true`, and scan the whole changed set) before the Lead relies on it as a guarantee.

### Minor
1. **R09's seeded-`main` branch does not assert union preservation.** `test/repo-root.test.mjs:265-297` seeds a tablet record (`平板已有`) and verifies clone→write→commit→push and remote `main` advance, but never asserts the seed record survives the union. Union correctness is covered separately by `plugin-v2-cycle.test.mjs` C-series (C07/C19/etc., all passing in the full suite), so the invariant is not unverified overall — but the first-use e2e should assert it directly.
2. **Documentation drift in the lane's own rows.** `docs/ROADMAP.md:767` says "定向 34/34" while the lane's `.tmp/gates-plugin-repo-root-targeted.out` and my run both show **36/36**; `docs/MODULES.md:483` cites `repo-root.test.mjs` as "R01–R08" while the file contains **R01–R09** (R09 is the first-use bare-remote e2e).
3. **Build gate not independently re-run.** Per the read-only / no-build review constraint I did not execute `node scripts/build.mjs`. Equivalence is established by `tsc --noEmit` exit 0 and a fresh `tsc --outDir <temp>` compile (61 files, exit 0) whose outputs are byte-identical to every changed `dist` file; the build script only adds `dist/client.js` (sibling lane, out of scope).

### Nit
1. The brief cites `repoRoot.ts:123` for the log line; the actual `logLine` construction is at `repoRoot.ts:124` (off by one).
2. `gitPort.ts:69-70` contains a duplicated comment fragment ("但 ensureBranch 已" repeated).
3. `src/schedule/tools.ts:66` still describes the old shared-clone root (`<appFilesDir>/git-repo`); this file is unchanged by this lane, so it is pre-existing drift, not a regression introduced here.

## Checklist

1. **PC-owned default root — PASS.** `resolveV2RepoRoot()` (`repoRoot.ts:105-142`) uses `DSH_DOTS_REPO_ROOT` → deprecated `DSH_DOTS_APP_FILES_DIR` → default `~/.dsh/dots/repos/<repoHash>`; `logLine` (`:124`) is emitted only via injected `logger.info/warn` (`:126-134`), retained as `RepoRootResolution.logLine` and `V2RuntimeStatus.repoRootLogLine` (`bootstrap.ts:50,68,92,106`). Grep found **zero** `console.*` in `packages/dsh-dots/src`. On a PC with no env the default root wins (R01/R08/T13/WIR04 pass), so the old tablet-filesDir path cannot be used by default.
2. **Old error gone / new typed error — PASS.** `E_NO_APP_FILES_DIR` appears only as assertion strings in tests, never in `src/` or `dist/` (grep + R08). `E_REPO_ROOT_UNAVAILABLE` is thrown on mkdir/write failure (`repoRoot.ts:148-158`) with path, "下一步", "set DSH_DOTS_REPO_ROOT 指向一个可写目录" and "DSH_DOTS_APP_FILES_DIR 已废弃" (`:92-98`). Both fail-closed branches are absent.
3. **Layout / identity — PASS.** Default final path `~/.dsh/dots/repos/<hash>/git-repo` vs legacy `~/.dsh/dots/work/<hash>`; siblings under `~/.dsh/dots`, never equal (R02, repoRoot.ts:120, repoPath.ts:45-47). `repoHash` is imported from `engine/paths.ts` (`paths.ts:272-274`, sha256[:16] of trimmed URL) and used identically by `workDirFor` and `legacyWorkDir`.
4. **Migration unambiguous / non-destructive — PASS.** `migrateIfNeeded` (`:266-282`) acts only when legacy exists AND new root absent; otherwise zero IO. `migrateLegacyWorkDir` fails closed on unpushed work (`:218-237`, E_LEGACY_UNPUSHED, zero moves), backs up to `<legacy>.dsh-backup` before `move` (`:253-258`), is idempotent via marker (`:204-216`), and additionally checks target-origin equality (M5, `:239-251`). R04 asserts move/backup/writeMarker all `0` on a fresh root; R05/R06/R07 and M01–M08 pass.
5. **Two-clone invariants + no-force scan — FAIL.** Invariants are stated in `repoRoot.ts:18-24` and `PLUGIN-GAPS.md:48` (no rebase/force/history rewrite, union on fetch, outbox park on push rejection, same-`ts` UTF-8 byte-order tie-break with App). T10 was extended to all eight new src/dist files (`:341-346`) and passes, but the regex set is bypassable as detailed in Major 1.
6. **First-use self-clone — PASS.** `schedule_add` → `withBridgeForTool` (`tools.ts:94-114`) → `withV2ScheduleBridge` (`v2Bridge.ts:454-484`) calls `buildV2Ports` + `gitPort.prepare()` → `GitRepoV2Port.prepare()` (`gitPort.ts:80-82`) → `GitRepo.ensureWorkTree()` (`git.ts:416-434`), which clones when `.git` is absent, then writes/enqueues/commits/pushes. On an empty remote, `ensureBranch` runs `checkout -B main` (`git.ts:404-414`), so the unborn HEAD resolves via `branchName()`'s `symbolic-ref --short HEAD` fallback (`gitPort.ts:65-74`) to `main`; `gateOfFacts` (`cycle.ts:271-286`) therefore does not raise `E_BRANCH_MISMATCH`. **R09 is a real bare-remote test for both empty and seeded-`main` remotes and passed (4.5s)**, with `.git` created, `pushed:true`, non-empty commit, `timeline/schema.json` on the empty case, and remote `main` advanced to the new commit. No wrong-branch outcome was observed.
7. **Byte parity — PASS.** T01/T02 still assert canonical `timeline/**` bytes (`canonicalRecordLine` / `buildRecordsText` against the copied App fixtures) and pass unchanged in both targeted and full runs.
8. **Gates — PASS (with caveat 3).** `tsc --noEmit` exit 0; targeted 36/36 pass / 0 fail / 0 skip; credential hygiene `apps/arkui-schedule/tools/test/credentialHygiene.test.mjs` from repo root = 11/11 pass. Full plugin suite as run now: **609 tests / 608 pass / 0 fail / 1 skip** (skip = pre-existing proxy-env case at `remote-listener.test.mjs:420-438`, `NODE_USE_ENV_PROXY` + `HTTP_PROXY`). The lane's captured `.tmp/gates-plugin-repo-root.out` shows 607/606/0/1; the +2 reflects concurrent sibling-lane test additions after that snapshot. No failure in either run. The credential guard was **not** weakened or allowlisted: `credentialHygiene.test.mjs` is unmodified, still asserts no `console.*` in any plugin `.ts` (`:177-184`) and an exact-whitelisted single AI log line with `allowed === 1` (`:63-82`).
9. **Dist freshness — PASS.** Fresh `tsc -p tsconfig.json --outDir <temp>` produced 61 files, exit 0; `sync/{repoRoot,repoPath,bootstrap,gitPort}.js` and `schedule/v2Bridge.js` are SHA256-identical to the committed dist twins, and all 61 compiled JS files match with 0 diffs. `dist/client.js` is generated by `build.mjs` (out of scope), not by tsc.
10. **Docs — PASS (with Minor 2).** `PLUGIN-GAPS.md` §7 (`:42-49`) records the tablet-filesDir leak, the fix, the env precedence, and `DSH_DOTS_APP_FILES_DIR` as "已废弃别名"; it states 未装机 / 未 reload / `unverified` and makes no live-GUI claim. `MODULES.md:483` and `ROADMAP.md:767` likewise mark 未装机 / 未 reload / unverified (they report gate results, not an App build or GUI verification).

## Residual risk & unverified
- No live plugin install, DSH reload, or GUI verification was performed (docs correctly mark this `unverified`); first-use behaviour is proven by a local bare-remote test, not by a hosted Gitee/GitHub account.
- The empty-remote path is sound in the tested topology; a remote with a non-`main` default branch would still be forced to `main` by design, and a hosted remote that rejects the initial `HEAD:main` push is only covered by the generic push-rejection (outbox-park) tests.
- Migration backup uses recursive `cp` then `rename`; crash-recovery between backup and move is reasoned about but not exercised against real IO beyond `RecordingIo`.
- Full-suite counts drift while sibling lanes add tests; report the numbers observed at review time, not a fixed total.

## Evidence log
- `git -C …/dsh-sync-suite rev-parse HEAD` → `ad1d83c…`; `git log --oneline` → `4c5de17` is parent; `git show --stat HEAD` → privacy-gate commit is out of scope.
- Read: `src/sync/{repoRoot,repoPath,bootstrap,gitPort}.ts`, `src/schedule/v2Bridge.ts`, `src/engine/paths.ts:247-278`, `src/sync/cycle.ts:271-286`, `src/engine/git.ts:404-434`, `src/schedule/tools.ts:94-114,217-259`.
- Grep: no `console.*` in `packages/dsh-dots/src`; `E_NO_APP_FILES_DIR` only in three test files; env-var references confined to the new/deprecated channel.
- `node …/typescript/bin/tsc -p …/tsconfig.json --noEmit` → exit 0, no diagnostics.
- `node …/typescript/bin/tsc -p …/tsconfig.json --outDir C:\Users\GWL\AppData\Local\Temp\dsh-review-fresh-tsc` → exit 0, 61 files; SHA256 comparison → 5/5 changed dist files identical, 0 diffs among compiled JS.
- `node --test test/{repo-root,plugin-tools-v2,plugin-v2-migration,plugin-v2-wiring}.test.mjs` (cwd `packages/dsh-dots`) → 36 tests, 36 pass, 0 fail, 0 skip; R09 real bare-remote e2e passed for `seedMain=false/true`.
- `node --test <43 explicit test files>` (cwd `packages/dsh-dots`) → 609 tests, 608 pass, 0 fail, 1 skip, exit 0; skip identified as `remote-listener.test.mjs:420-438` proxy-env case.
- `node --test apps/arkui-schedule/tools/test/credentialHygiene.test.mjs` (repo root) → 11 tests, 11 pass, 0 fail.
- Regex-bypass probe with the exact T10 forbidden patterns → `-f`, `+main`, `push.force=true` = BYPASS; `--force-with-lease`, `reset --hard` = CAUGHT.
- `git status --short` before and after review → 42 entries, unchanged; this review wrote no repo file other than this report.

## Delta (r2)

**Delta verdict: PASS — Major findings remaining: 0.** The r1 Major is resolved: the no-force guarantee now lives in production argv construction plus a runtime argv-boundary assertion, not in a test-side source-text regex. Review was limited to the listed delta; r1 above is left intact.

### Delta findings

No blocking finding. Residuals are advisory:

- **Minor (advisory) — `commit()` and `fetchMain()` do not pass through `git()`/`assertSafeGitArgs`.** `commit()` (`gitPort.ts:182-193`) calls `run()` directly with caller `message`/`body` as `-m` values; they are discrete `execFile` argv values, so a hostile string cannot become a separate option. `fetchMain()` (`:127-129`) calls `GitRepo.fetch()`, whose argv is fixed `['fetch','--quiet','origin','main']` (`engine/git.ts:485-491`). Neither can carry a hostile flag today, but neither is covered by the runtime assertion; a future change that injects caller strings as separate tokens on those paths would not be caught. Not a current bypass.
- **Minor (advisory) — "hostile fetch flags rejected at the argv boundary" is guard capability, not a live check on the fetch path.** R11 proves `assertSafeGitArgs(['fetch','--prune','--force'])` throws, but production fetch never calls that assertion; its safety comes from the fixed engine argv. The carve-out is still defensible (checklist 4).
- **Nit — r1 minors were not in this delta and remain open:** R09 still does not assert the seeded tablet record survived the union (union is covered separately by `plugin-v2-cycle.test.mjs` C-series), and doc counts have moved to 39/39 while `MODULES.md:483` still cited R01–R08. Neither blocks this delta.

### Delta checklist

1. **Real argv builder, not a test shim — PASS.** `buildSafePushArgs()` (`src/sync/gitPort.ts:75-81`) validates `{remote:'origin',branch:'main',force:false}`, calls `assertSafeGitArgs(['push', ...extra])`, then returns the **fixed** `['push','--porcelain','origin','HEAD:main']`; `extra` never appears in the return value. Production `pushMain()` (`:195-198`) is `await this.git(buildSafePushArgs(args))` — it calls the builder, and grep found no second inline push argv in `src/sync` or its dist twin (only the allowlist entry at `:41`, the guard seed at `:79`, and the fixed return at `:80`). A hostile `remote`/`branch`/`force` throws before any argv is produced; a hostile `extra` is rejected and, even if a pattern were missed, cannot influence the returned command. Guarantee is structural, not spelling-based.
2. **Runtime argv assertion before the runner — PASS.** `GitRepoV2PortOptions.runner` (`:83-86`) is consumed only by `git()` (`:99-106`), which calls `assertSafeGitArgs(args)` at `:100` **before** `this.runner(...)` at `:101`. `assertSafeGitArgs()` (`:58-68`) checks `args[0]` against exported `GIT_SUBCOMMANDS` (`:39-42`) and each later token against exported `FORBIDDEN_GIT_ARG_PATTERNS` (`:48-55`). Default runner remains `run`/`execFile` (`:23-36`, `:95`).
3. **R10 hostile table — PASS.** `test/repo-root.test.mjs:312-342` imports the real exports (`:35-40`), captures the real `pushMain` argv via injected `runner` and asserts it equals the fixed safe argv; all ten hostile forms (`-f`, `--force`, `--force-with-lease`, `--force-if-includes`, `+main`, `+refs/heads/*`, `--delete`, `-c push.force=true`, `--config push.force=true`, `{force:true}` via `force:true`) are rejected with `E_VALIDATION` **by `buildSafePushArgs` → `assertSafeGitArgs` in production code**, not by test-side string assertions; the captured argv is unchanged after all attempts. Rejections occur at the builder/argv boundary (argv-token regex is the mechanism, as it must be for string argv), not by scanning source text.
4. **R11 allowlist + fetch carve-out — PASS (defensible).** `test/repo-root.test.mjs:344-363` denies `reset --hard`, `rebase`, `pull`, `merge`, `fetch --prune --force`, `branch -D`, `update-ref refs/heads/main x` and accepts `status`, `add -- timeline/a`, `commit -m x`, `push --porcelain origin HEAD:main`; also pins `GIT_SUBCOMMANDS` without `reset`/`pull`. `fetch` staying allowed is defensible: it is the sanctioned union transport, its production argv is fixed with branch pinned to `main`, and hostile fetch flags are rejected by `assertSafeGitArgs` if any caller tries to construct them through `git()`. Residual as noted above: production `fetchMain()` bypasses that assertion, so safety is by fixed argv rather than by live enforcement on that path.
5. **Heuristic demoted, not deleted — PASS.** `plugin-tools-v2.test.mjs:382-385` explicitly says the guarantee is in `gitPort.ts` R10/R11 and that text scanning is heuristic only; T10 (`:406-420`) now enumerates `src/sync/*.ts` + `dist/sync/*.js` dynamically via `readdirSync` (import at `:13`) with extended patterns (`:386-399`: `--force*`, short `-f`, `+refspec`, `push.force=`, `--delete`, `force:true`, `reset --hard`, `unlink(`, `rmSync(`, recursive `rm`); T10b (`:422-446`) is a working positive control — 10 hostile lines hit, 3 benign lines pass. Docs match: `PLUGIN-GAPS.md:48` and `ROADMAP.md:767` now name R10/R11 as the runtime guarantee and call T10/T10b "heuristic（纵深防御，不是保证）".
6. **Gate/compile sanity — PASS.** All numbers independently reproduced (tails below). The reported transient C15/C16 trip is consistent with a self-comment: C15 (`plugin-v2-cycle.test.mjs:343`) and C16 (`:355`) still contain literal `rebase|checkout|--force` in their forbidding regexes, `grep -i rebase src/sync` now returns no matches, and `gitPort.ts:49-54` deliberately splits `--forc[e]` / `--delet[e]` to avoid self-triggering. The guard was **not** loosened; only a comment was reworded.

### Residual risk & unverified (delta)

- `commit()` / `fetchMain()` are outside the argv assertion but safe by construction today (advisory above); no live hosted-remote test added in this delta.
- R10's hostile coverage is the ten stated spellings; exotic git spellings (e.g. short-option bundles) are not enumerated, but they cannot reach the executed push argv because the builder ignores `extra` in its return value.
- r1's unverified items (no install/reload/GUI) are unchanged.

### Delta evidence log

- Read: `src/sync/gitPort.ts` (full), `test/repo-root.test.mjs:1-45,300-363`, `test/plugin-tools-v2.test.mjs:378-446`, `test/plugin-v2-cycle.test.mjs:325-367`, `src/engine/git.ts:483-502`; grep of `src/sync` for `rebase` → none, of `src` for push argv → only builder/engine v1.
- `node --test test/{repo-root,plugin-tools-v2,plugin-v2-migration,plugin-v2-wiring}.test.mjs` → **39 tests / 39 pass / 0 fail / 0 skip**, exit 0.
- `node --test` over 43 `test/*.test.mjs` → **612 tests / 611 pass / 0 fail / 1 skip**, exit 0 (skip = pre-existing proxy-env listener case).
- `tsc -p …/tsconfig.json --noEmit` → exit 0, no output.
- `node --test apps/arkui-schedule/tools/test/credentialHygiene.test.mjs` (repo root) → **11 tests / 11 pass / 0 fail / 0 skip**.
- Fresh `tsc … --outDir C:\Users\GWL\AppData\Local\Temp\dsh-review-r2-tsc` → exit 0, **61 files**; SHA256 compare vs `dist/**/*.js` → **0 diffs** among compiled JS (`client.js` excluded as build-generated); `dist/sync/gitPort.js` = **8,617 B**, SHA256 `9313F2A15563EFEE…`.
- Lane gate tails in `.tmp/gates-plugin-repo-root-targeted.out` (39/39), `-full` `gates-plugin-repo-root.out` (612/611/0/1), `-credential.out` (11/11) match the independent runs.
- Only this report file was written; the r1 section above was not modified.
