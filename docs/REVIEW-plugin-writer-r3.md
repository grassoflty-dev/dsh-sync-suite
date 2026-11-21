# Plugin writer re-review (r3, focused on F1/F2)

Scope: DSH plugin package `packages/dsh-dots` at HEAD `b756001` (`b7560010b4fef8760b9804beb5f5a2cb44d21b11`). Read-only pass over the two remaining r2 findings (F1, F2), with a spot-check that r1/r2 items did not regress. Repo comments and test names are Chinese; this report is English. No `node scripts/build.mjs`, no overlay, no git writes, no subagents, no repo `dist/` writes; the only file written is this report.

## Verdict

**CONDITIONAL PASS** — both r2 Majors are genuinely repaired in source and pinned by inverse tests (no unproven dequeue, no push-before-validation, no fallback to subject-only authorship), with zero Major findings remaining; the pass is conditioned on accepting the two defense-in-depth gaps below as Minors rather than blockers. Major findings remaining: 0.

## F1 / F2

### F1 — CLOSED

Every claimed link verified in source:

- `proveRecoveryState` (`src/sync/cycle.ts:568-595`) takes `replay = replayable(ctx.all)` at `:569` and passes the **real** per-day intents to `unionDay` at `:583`. `unionDay` re-filters at `:417` and calls `assertUpsertIntent` for every replayable upsert at `:419-421`. `assertUpsertIntent` is at `:281-294` (claim said `:280-296`, drift only) and now throws with `{ intentId, code }` in the `SyncError` details at `:283-285`, so each rejected intent is identifiable.
- Byte proof is real: `:584-591` requires `union.recordsText === local.records`, `union.deletedText === local.deleted`, `union.restoreText === local.restore`, **and** `union.conflictRows.length === 0`; any mismatch throws typed `E_CORRUPT`. (The extra conflict-row condition is stricter than the claim, not weaker.)
- Order is correct: `recoverPendingLocalCommit` (`:601-639`) calls `proveRecoveryState` at `:609` **inside a try**, and `pushMain(PUSH_ARGS)` only at `:616`. A proof failure returns `failure(E_CORRUPT, …, all, 0)` at `:610-613`; `failure()` (`:643-649`) is a pure result constructor — zero push, zero dequeue, zero `outbox.save`. A push rejection is a different path (`:618-624`) and parks with attempts as designed.
- `appliedIds` comes from proof, not from "all replayable": `:592` copies only `union.applied`; success dequeues exactly `proven.appliedIds` at `:627` and saves at `:628`. No "dequeue everything replayable" remains in the recovery path.
- **C24 is a true inverse test**, not a happy path (`test/plugin-v2-cycle.test.mjs:498-518`): it seeds a committed local `records.json`, injects a `title:123` malformed upsert, and supplies a valid ahead-only own commit so `pendingIsOurs` is true; it asserts `E_CORRUPT`, unchanged SHA-256, byte-identical outbox, `attempts === 0`, `outbox.saves === 0`, zero `push`/`add`/`commit`. Mutation premise checked in memory: substituting `[]` for the real replay makes `unionDay` return bytes identical to the committed file, 0 conflicts, `applied = []`; the proof would pass, push would fire, and C24 would fail on `ok`, `code` and push count. Restoring push-before-validation also fails its push-count assertion. C19 (`:411-428`) still proves a valid intent drains via recovery with exactly one push (no add/commit) and an empty outbox.
- Answer to "can any dequeue happen for an intent not proven present in the pushed tree?": **not through the dequeue set or the call order**; one narrow caveat remains (Minor 2 below) because the proof reads working-tree bytes rather than HEAD bytes.

### F2 — CLOSED

- `V2_TRAILER_PREFIX` (`cycle.ts:94`), `v2TrailerLine` (`:98-100`), `hasV2Trailer` (`:103-106`, exact trimmed line), `isV2CommitSubject` (`:109-111`) and `isOursCommit` (`:122-127`) are present as claimed. The three conditions are **ANDed** at `:123-126`: subject shape && body trailer && `paths.length > 0` && every path under `timeline/**`. `AheadCommit` (`:114-119`) and `V2GitPort.aheadCommits` (`:151-152`) are structured subject+body+paths; `pendingIsOurs` (`:555-560`) consumes all three and requires `behind === 0 && ahead > 0`.
- The trailer is written where claimed: `cycle.ts:806` calls `git.commit(syncCommitMessage(touchedDays), v2TrailerLine(instanceId))`; `src/sync/gitPort.ts:117-128` emits two `-m` flags (`-m message`, then `-m body`) with fixed commit identity (`:14`), so the trailer lands in the body. The app emits only a single `-m` subject (`apps/.../services/syncProtocolStore.ets:552`; `git-bridge.js:2266-2269`), so the token cannot be produced by the app's normal path.
- `aheadCommits` really reads body and paths (`gitPort.ts:93-109`): `show -s --format=%B <sha>` at `:98` (subject = first line, body = remainder), `diff-tree --no-commit-id --name-only -r <sha>` at `:103`; both `show` and `diff-tree` are in `ALLOWED` at `:39` alongside the read set `rev-parse/rev-list/log/diff/fetch` and the write set `add/commit/push`. No history-rewrite subcommand is allowed, and C15/C16 guard source + all compiled `dist/sync/*.js`.
- C25/C26 are real inverse tests: with subject-only authorship both would enter recovery, the empty/empty union proof would pass (`buildRecordsText(day, [])` is a valid 61-byte document, no conflict), the push would succeed and the result code would be `ok` — contradicting their `E_NOT_SYNCED` assertions. C25 (`:520-531`) uses the app-identical subject with empty body and also asserts the message names `dsh-dots-v2`; C26 (`:533-543`) uses a valid trailer plus a `chats/…` path; C27 (`:545-558`) pins the exact trailer line, `hasV2Trailer` true/false and `isOursCommit(ownCommit()) === true` (the false cases are in C25/C26, so the "true/false matrix" is spread across the three tests).
- Caveat: the path confinement is prefix-only and admits `timeline/../…` at the predicate level (Minor 1). Authorship still cannot degrade to subject-only.

## New findings

### Blocker

None.

### Major

None.

### Minor

- **M-r3-1 — `isOursCommit` path confinement accepts `timeline/../…`.** `cycle.ts:126` checks `p === 'timeline' || p.startsWith('timeline/')` with no segment validation. Direct probe against `dist/sync/cycle.js`: `paths: ['timeline/../.git/config']` and `['timeline/../../secret']` both yield `isOursCommit === true` (subject+trailer valid); an absolute `/etc/passwd` yields `false`. Therefore the explicit verification point "a subject+trailer commit with a `timeline/../` path cannot slip through" is **false at the predicate level**. It is not exploitable through the shipped adapter — real git cannot store `..` path components, and the app bridge already rejects them (`git-bridge.js:2259-2261`) — so this is defense-in-depth, not a re-opening of F2. Fix: reject `.`/`..` segments or require `path.posix.normalize(p)` to round-trip under `timeline/`.
- **M-r3-2 — recovery proof validates working-tree bytes, not committed-tree bytes.** `cycle.ts:577-581` reads `local` via `ctx.fs.read(...)`, which in production is `NodeTimelineFs` rooted at the shared clone (`bootstrap.ts:133`), while the pushed object is local HEAD. A concurrent/uncommitted edit (app or user; the clone is shared and unlocked) that places an intent's exact record in the working tree but not in HEAD could satisfy `:584-591` and lead to dequeue at `:627` of an intent absent from the pushed commit. Not reachable from the plugin's own write → commit → push flow (which leaves a clean tree) and requiring an exact-record external edit; Minor, not a re-opening of F1. Fix: read HEAD tree bytes through the git port (`show <HEAD>:<path>`) for the equality check.

### Nit

- **N-r3-1 — citation drift only (no behaviour):** r2 cites `assertUpsertIntent` at `:242-258` (now `:281-294`) and `recoverPendingLocalCommit` at `:601-650` (actual body `:601-639`, with `failure` at `:643-649`). The r3 prompt's "C27 true/false matrix" is in fact C27's true case plus C25/C26's false cases.
- **N-r3-2 — no port-level test of the real adapter's second `-m`.** C27 inspects `FakeGit.commit(message, body)`; `gitPort.ts:121-123` was verified by source read only. A regression that dropped the body flag would not be caught by the suite (it would, however, break C25/C26/C27 through lost authorship).

## Mechanical checks

1. **Suite — PASS, exact expected numbers.** `node --test "packages/dsh-dots/test/*.test.mjs"` from repo root → `ℹ tests 570 / ℹ pass 569 / ℹ fail 0 / ℹ cancelled 0 / ℹ skipped 1`, `duration_ms ≈30496`. Expected 570/569/0/1 reproduced; no named failure, one pre-existing skip.
2. **dist freshness — PASS, 59/59 MATCH.** `npx --no-install tsc -p tsconfig.json --noEmit` exit 0; fresh `npx --no-install tsc -p tsconfig.json --outDir <TEMP>` exit 0. 59 emitted `.js`, **59 exact SHA-256 matches, 0 mismatch, 0 missing**; repo `dist/` has 60 `.js`, the sole extra being `dist/client.js` (copied by `scripts/build.mjs`, no TS source). Targeted `sync/cycle.js`, `sync/gitPort.js`, `sync/outbox.js`, `sync/repoPath.js`, `sync/bootstrap.js`, `timeline/write.js`, `index.js` → **7/7 MATCH**. Temp dir removed; no `node scripts/build.mjs`, no repo `dist/` write.
3. **Protected paths / scope — PASS.** `git diff HEAD -- packages/dsh-dots/src/schedule packages/dsh-dots/src/rpc.ts packages/dsh-dots/src/remote packages/dsh-dots/cordis.patch.yml packages/dsh-dots/package.json` is empty. `git diff HEAD -- packages/dsh-dots/src/index.ts` = 9 insertions / 0 deletions: the import (`@:25-26`) and `mountV2Sync(ctx, …, false)` call (`:176-181`) only — previously approved M1 wiring. Working-tree inventory otherwise matches r2's record.
4. **r1/r2 regression spot-check — PASS.** Normal-path refuse-and-park intact (`assertUpsertIntent` at `:281-294`, empty-`recordsText` sentinel at `:492-496`, all unions before the first write at `:724-731`; C17/C18 green). Outbox path/atomicity unchanged (`outbox.ts:16-18,48-72` → `outbox/<repoHash>.json` under state root, `atomicReplace` read-back + rename). Migration identity abort intact (`repoPath.ts:206-219`: both origins non-empty and equal plus `--is-inside-work-tree === 'true'`, else `E_MIGRATION_TARGET_MISMATCH` before marker/move; unpushed abort `:200-204`). Conflict-row sort intact (`cycle.ts:341-359`, C23 green). M6 guard coverage intact (C15 regex over six sources + every `dist/sync/*.js`, C16 runtime assertions on compiled `gitPort.js`, both green).

## Residual risk & unverified

- All r2 residual items stand: real remote auth/push, real two-device union against the app's compiled code, live DSH session/plugin install, app lock contention on the shared clone, real-git non-fast-forward recovery, absent production outbox producer (`enqueueIntent` has no `src/` caller), and the injected `appFilesDir` assumption.
- The two Minors above (predicate path traversal; working-tree vs HEAD proof) are unverified in a real-git non-fast-forward scenario — only source-level and in-memory probes were possible here.
- Mutation evidence for C24/C25/C26 is source reasoning plus in-memory `unionDay` probes (`[]` replay → proof passes; empty/empty union → valid 61-byte document); no repo file was patched to run a live mutation suite.
- Out-of-scope observation (not counted as a finding, not in r1/r2): `unionDay` marks `applied` only for upserts and `purgeRows` (`cycle.ts:443-490`), so `delete`/`restore` op intents are merged into ledgers but never dequeued, and no test covers those ops. Pre-existing and outside this review's F1/F2 scope.

## Evidence log

- HEAD `b7560010b4fef8760b9804beb5f5a2cb44d21b11`; `git status --short` inventory matches r2 (tracked plugin edits `dist/index.js`, `src/index.ts`; untracked `src/sync/**`, `src/timeline/write.ts`, `dist/sync/**`, `dist/timeline/write.js`, five `test/plugin-v2-*.test.mjs`; other-lane `apps/**` and docs untouched).
- Sources read in full this pass: `src/sync/cycle.ts` (836 lines), `src/sync/gitPort.ts` (141), `src/sync/outbox.ts` (74), `src/sync/bootstrap.ts` (181), `src/sync/repoPath.ts:190-223`, `test/plugin-v2-cycle.test.mjs` (558), `packages/dsh-dots/tsconfig.json`, `scripts/build.mjs`; targeted app reads: `syncProtocolStore.ets:98,552`, `git-bridge.js:2254-2276`.
- Node probes against `dist/sync/cycle.js` + `dist/timeline/index.js`: `isOursCommit` matrix (baseline true; `timeline/../.git/config` true; `timeline/../../secret` true; `/etc/passwd` false; mixed `chats/secret.json` false; no-trailer false; wrong-subject false; empty-paths false); C24 mutation premise (`unionDay(..., [])` equals committed bytes, 0 conflicts, `applied=[]`); C25/C26 mutation premise (`buildRecordsText(DAY, [])` length 61, empty/empty union non-fatal).
- Commands: `node --test "packages/dsh-dots/test/*.test.mjs"` (570/569/0/1); `npx --no-install tsc -p tsconfig.json --noEmit` (exit 0); `npx --no-install tsc -p tsconfig.json --outDir <TEMP>` (exit 0; 59/59/0/0; temp removed); `git diff HEAD -- <protected paths>` (empty); `git diff HEAD -- src/index.ts` (9 insertions); `git rev-parse HEAD`.
