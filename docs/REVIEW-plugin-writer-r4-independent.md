# Plugin writer review (r4 — final gate)

> 该独立评审在模块提交 `cc146ac` **之后** 才落地；与已提交的 r4 结论在 m1/m2 已闭环、0 Major 上一致，另补了插件套件抖动观察、`%2e%2e` Nit 与 HEAD 引用勘误。

Scope: read-only review of `packages/dsh-dots` (writer half) at working-tree HEAD reported as `cdd2fce`, focused on the two r3 Minors (M-r3-1 path confinement, M-r3-2 HEAD-byte proof) plus cross-cutting regression/scope checks. Repo comments/tests are Chinese; this report is English. No `node scripts/build.mjs`, no overlay, no git writes, no subagents, no repo `dist/` writes. The only file written is this report.

## Verdict

**CONDITIONAL PASS** — both r3 Minors are genuinely repaired in source and pinned by tests that would fail on regression (no path can escape `timeline/`, no dequeue occurs without a HEAD-byte proof), with zero Major findings; the pass is conditioned on the writer explaining one non-reproducible suite run that reported 3 failures (see Minor N-r4-1). Major findings remaining: 0.

## m1 / m2

### m1 — CLOSED

- `isConfinedTimelinePath` (`src/sync/cycle.ts:125-131`) is **not** a bare prefix check: it rejects non-strings/empty (`:126`), any `\`, leading `/` or drive prefix (`:127`), any empty / `.` / `..` segment (`:129`), then requires `parts[0] === 'timeline' && parts.length > 1` (`:130`). This is the r3-recommended "reject `.`/`..` segments" fix, stricter than normalize-then-prefix.
- `isOursCommit` (`:134-139`) ANDs subject shape + exact trimmed body trailer + `paths.length > 0` + `paths.every(isConfinedTimelinePath)`. Direct probe against fresh `dist/sync/cycle.js`: `timeline/../etc/passwd`, `timeline/./x`, `timeline//x`, `timeline\..\secret`, `C:\etc\passwd`, `/etc/passwd` → all `false`; `timeline/2026-11-19/records.json` → `true`; bare `timeline` and `timeline/..` → `false`. The predicate is not vacuous.
- C28 (`test/plugin-v2-cycle.test.mjs:571-592`) supplies a **valid-trailer, valid-subject** ahead commit (`ownCommit()` at `:135-142`, subject `[v2] sync 1 days`, body `v2TrailerLine()`) for each of the six variants, asserts the predicate `false` and `isOursCommit` `false`, then asserts typed `E_NOT_SYNCED` and zero pushes; the positive control is at `:591`.
- The variants reach the recovery gate, not a different early exit: `runV2Cycle` (`cycle.ts:707-717`) sees `head !== origin` → `NOT_SYNCED` → `pendingIsOurs` (`:568-573`) → `isOursCommit` returns false → falls through to `failure(gate.code, …, 0)` at `:718`. The pre-gate at `:687-693` does not short-circuit an empty-schema `MemFs` (`gateOfFacts` at `:271-287` treats empty schema as fresh-start). Zero pushes then holds because recovery is never entered — the guard, not an unrelated exit, is what stops it.
- Regression premise: reverting to prefix-only (`p === 'timeline' || p.startsWith('timeline/')`) makes the direct `isConfinedTimelinePath(p) === false` assertion at `:581` fail for every variant (and `isOursCommit` true), so C28 is a real inverse test. No shipped input can escape `timeline/`.

### m2 — CLOSED

- `proveRecoveryState` (`cycle.ts:581-609`) builds `local` **only** from `ctx.git.showHead(...)` at `:592-594` and compares the replayed union bytes against those HEAD bytes at `:598-605`, throwing typed `E_CORRUPT` whose message explicitly says `HEAD 已提交文件不一致（工作树不算证据）` (`:602`). It is genuinely HEAD-vs-intent, not working-tree-vs-intent.
- Port: `showHead(rel)` declared at `cycle.ts:157-158`; implemented at `src/sync/gitPort.ts:84-87` as `repo.showFile('HEAD', rel)`. `GitRepo.showFile` (`src/engine/git.ts:684-688`) runs `git show <rev>:<path>` — the **committed blob**, not the working copy (`:686`). So `showHead` cannot be satisfied by an uncommitted edit.
- Order: `recoverPendingLocalCommit` (`:615-653`) awaits `proveRecoveryState` at `:623` **before** `pushMain` at `:630`; any proof failure returns `failure(E_CORRUPT, …, all, 0)` at `:626` (pure constructor, `:657-663`: zero push, zero save, zero dequeue). Dequeue at `:641` consumes only `proven.appliedIds` returned by the proof (`:606-608`). Therefore no dequeue can happen without HEAD proof.
- C29 (`test/plugin-v2-cycle.test.mjs:594-614`) seeds working tree with body `X` matching the intent (`fs` at `:599`, intent at `:600`) and HEAD with body `Y` (`headFiles` at `:605`), then asserts `E_CORRUPT`, message `/HEAD/`, unchanged outbox, `saves === 0`, `push === 0`. Mutation premise: if `proveRecoveryState` reverted to `fs.read`, `local` would be working-tree `X` and the `X` intent would replay idempotently to identical bytes with no conflicts, so the proof would pass, push would fire, and C29 would fail on `ok`, `code`, `saves` and push count. C29 is a real inverse test.
- Fake `showHead` risk checked: the cycle-test fake (`test/plugin-v2-cycle.test.mjs:99`) reads `headFiles`; the seeding at `:425` (C19), `:445` (C20) and `:516` (C24) is **real** — each seeds the same `buildRecordsText(DAY, [rec()])` / `committed` bytes that the intent replays to, so those tests pass because the HEAD proof genuinely succeeds, not because an empty stub was tolerated. The outbox test's `async showHead() { return '' }` (`test/plugin-v2-outbox.test.mjs:52`) is harmless: that suite never exercises recovery.

## New findings

### Blocker

None.

### Major

None.

### Minor

- **N-r4-1 — one non-reproducible suite run with 3 failures.** The first `node --test "packages/dsh-dots/test/*.test.mjs"` invocation reported `572 / 568 pass / 3 fail / 1 skipped` (exit 1); three subsequent identical invocations reported `572 / 571 pass / 0 fail / 1 skipped`. The failing test names were not captured before the reruns, so the cause (likely transient: the first run was piped through `Select-String`, later runs buffered with `Out-String`) is unresolved. Not counted as Major because it is not reproducible and C28/C29 were observed green, but it is a real commit-gate caveat.

### Nit

- **N-r4-2 — `%2e%2e` segment accepted by the predicate.** Probe: `timeline/%2e%2e/etc` → `isConfinedTimelinePath === true`. This is not an escape — git stores `%2e%2e` as a literal directory name and never interprets it as `..` — but it shows the guard is segment-literal, not percent-decoding. No reachable path traversal exists.
- **N-r4-3 — HEAD hash drift.** Prompt states HEAD `cdd2fce`; actual `git rev-parse HEAD` is `5ab478e8…` (with `cdd2fce` at HEAD~2). The reviewed plugin files are the untracked/modified working-tree copies; the review is of that content.

## Mechanical checks

1. **Suite — PASS with caveat (see N-r4-1).** Expected `572 / 571 / 0 / 1` reproduced in 3 of 4 runs; final two runs exactly `ℹ tests 572 / ℹ pass 571 / ℹ fail 0 / ℹ skipped 1`. C17–C20, C23–C29 observed green. The single pre-existing skip is unchanged. No named failure identified.
2. **dist freshness — PASS, 59/59 MATCH.** `npx --no-install tsc -p tsconfig.json --noEmit` exit 0; fresh `npx --no-install tsc -p tsconfig.json --outDir <TEMP>` exit 0; 59 emitted `.js` vs repo `dist`, **59 exact SHA-256 matches, 0 mismatch, 0 missing**. Targeted `sync/cycle.js`, `sync/gitPort.js`, `sync/outbox.js`, `sync/repoPath.js`, `sync/bootstrap.js`, `timeline/write.js`, `index.js` → **7/7 MATCH**. Temp dir removed; no repo `dist/` write, no build script.
3. **No regression — PASS (source spot-check).** Normal-path refuse-and-park intact (`assertUpsertIntent` at `cycle.ts:295-299`, all unions before first write at `:738-745`, `failure()` zero-write at `:657-663`; C17/C18 green). Recovery proof before push intact (`:623` before `:630`, dequeue only proven ids at `:641`). M6 guards intact (C15 source + all `dist/sync/*.js`, C16 runtime force assertion, both green). Conflict-row sort intact (C23 green). Migration identity abort and outbox atomicity were **not re-read in this pass** (r3 evidence stands; marked reviewer-unverified below). Trailer authorship intact: `V2_TRAILER_PREFIX`/`v2TrailerLine`/`hasV2Trailer` (`:94-106`), `isOursCommit` three-way AND (`:134-139`), two-`-m` commit body write (`gitPort.ts:122-133`), timeline-only diff gate (`:138`); C25/C26/C27 green.
4. **Scope — PASS.** `git diff HEAD -- packages/dsh-dots/src/schedule packages/dsh-dots/src/rpc.ts packages/dsh-dots/src/remote packages/dsh-dots/cordis.patch.yml packages/dsh-dots/package.json` is empty. Working-tree inventory from `git status --short` matches r3: tracked `dist/index.js` + `src/index.ts`, untracked `src/sync/**`, `src/timeline/write.ts`, `dist/sync/**`, `dist/timeline/write.js`, and five `test/plugin-v2-*.test.mjs`; other-lane `apps/**` and docs files are pre-existing and untouched by this module. No `apps/**` change by this writer.

## Residual risk & unverified

- N-r4-1's 3-failure run is unexplained and unreproduced; the writer should confirm a clean run at commit time.
- No live mutation run was performed: C28/C29/C24 failure premises are source reasoning plus direct predicate probes and the passing inverse tests; no repo file was patched.
- `GitRepo.showFile('HEAD', …)` was verified by source read (`git.ts:684-688`), not against a real non-fast-forward commit; the fakes' `headFiles` are in-memory.
- r3 residual items stand unchanged (real remote auth/push, two-device union against app code, live DSH install, app lock contention, real-git non-fast-forward, absent production `enqueueIntent` caller, injected `appFilesDir`).
- Migration identity abort (`repoPath.ts`) and outbox file-backed atomicity (`outbox.ts`) were not re-inspected this pass; r3's findings are carried forward, not re-verified.
- HEAD hash differs from the prompt (N-r4-3); if the writer intends a different commit, re-run this gate against that tree.

## Evidence log

- `git rev-parse HEAD` → `5ab478e8b26eb3eb370101ab11185bf37a746c6c`; `git log --oneline -8` shows `cdd2fce` at HEAD~2; `git status --short` inventory recorded above.
- Files read this pass: `docs/REVIEW-plugin-writer-r3.md`; `src/sync/cycle.ts:90-179, 240-299, 560-669, 669-769`; `src/sync/gitPort.ts` (full, 146 lines); `src/engine/git.ts:678-703`; `test/plugin-v2-cycle.test.mjs:1-146, 411-614`; `test/plugin-v2-outbox.test.mjs:52` (grep).
- Node probe against fresh `dist/sync/cycle.js`: six bad paths + `timeline/..`, `timeline`, `%2e%2e`, positive control as listed under m1.
- Commands: `node --test "packages/dsh-dots/test/*.test.mjs"` ×4 (first 572/568/3/1, then three × 572/571/0/1); `npx --no-install tsc -p tsconfig.json --noEmit` (exit 0); `npx --no-install tsc -p tsconfig.json --outDir <TEMP>` (exit 0; 59/59/0/0; targeted 7/7; temp removed); `git diff HEAD -- <protected paths>` (empty); `git diff HEAD --numstat -- src/index.ts` (empty in this checkout).
