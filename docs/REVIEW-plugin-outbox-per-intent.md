# Review — mod-plugin-outbox-per-intent

## Verdict
CONDITIONAL PASS — The union-vs-HEAD deadlock is genuinely removed and the honest `E_CORRUPT` path is preserved per intent; the residual items are a deliberately retained byte-mismatch rejection for a fresh intent that collides with an existing id, and the fact that byte-exact fresh compilation could not be proven under a no-build review charter. Major findings remaining: 0

## Findings

### Blocker
None.

### Major
None.

### Minor
1. **A fresh intent can still be reported `absent` when its id already exists in HEAD with different bytes** — `packages/dsh-dots/src/sync/cycle.ts:630-633`. This branch does not consult `isCommittedIntent()`. It is the retained honest check deliberately pinned by C29 (`packages/dsh-dots/test/plugin-v2-cycle.test.mjs:598-618`), so it is not a regression of the reported bug; but it narrows the fix to *new-id* writes. A legitimate update to an already-committed record arriving while a push is parked still hits `E_CORRUPT` and stays deadlocked. PI-01/PI-04 both use distinct new ids (test lines 635, 710), so neither exercises this path.
2. **Retry-budget comment disagrees with the implementation** — `packages/dsh-dots/src/sync/cycle.ts:71-73` claims "2 extra push attempts (3 total including the first)", but the recovery loop at `:799-851` performs at most `MAX_CYCLE_RETRIES = 2` pushes, and `packages/dsh-dots/test/plugin-v2-cycle.test.mjs:456` pins exactly 2. The bound is real and finite; only the prose is wrong.

### Nit
1. The brief's claimed order "apply → commit → backfill `commitSha` → re-verify → push" does not match the source: `applyUnappliedIntents()` verifies against the new HEAD at `packages/dsh-dots/src/sync/cycle.ts:770-788` and returns the sha, and the outbox backfill happens afterwards at `:813-821`. The ordering is still apply → commit → verify → backfill → push, so it is safe; the written claim is imprecise.

## Checklist

1. **Union comparison is really gone — PASS.** Suite-wide grep for `带意图` / `union 字节与 HEAD` returns only two comment lines that state the old comparison is no longer performed (`packages/dsh-dots/src/sync/cycle.ts:655`, `packages/dsh-dots/dist/sync/cycle.js:470`); the old `E_CORRUPT` message string has zero hits. `proveRecoveryState()` (`cycle.ts:661-695`) reads only `git.showHead()` (`:665-667`) and calls `classifyIntentLanding()` per intent (`:680`); no code path builds a union of all pending intents and compares it to HEAD.

2. **Freshness discriminator — CONCERN.** For an id absent from HEAD the discriminator is exactly "no commit marker **and** no matching line": `cycle.ts:625-629` (records) and `:642-644` (ledgers), with `isCommittedIntent()` at `:198-200` defined as non-empty `commitSha` **or** legacy `attempts >= 1`. A brand-new intent (no sha, attempts 0) whose id is absent from HEAD therefore routes to `unapplied`, not `absent` — the reported bug is fixed. However, the same-id/different-bytes branch at `:630-633` returns `absent` unconditionally, so a fresh intent can still be reported `absent` (see Minor 1). This is intentional per C29, not a new defect.

3. **Case (a) stays honest — PASS.** `proveRecoveryState()` throws `E_CORRUPT` at `cycle.ts:681-687` before any push, dequeue, or outbox write; the caller converts it to `failure()` at `:806-808`, and `failure()` (`:857-863`) only returns an outbox slice without saving. B1 shape validation runs on every replayable upsert at `:670-673`, again in `unionDay()` at `:446-448`, and in the normal path at `:938-945`. C17/C18/C24/C29 plus PI-02 assert byte-identical outbox, zero git writes, and unchanged attempts; all pass in the gate log.

4. **Ordering — PASS.** `applyUnappliedIntents()` writes files, `addPaths` + `commit` (`cycle.ts:764-767`), reads `headSha()` (`:768`), then re-verifies against the post-commit HEAD (`:770-788`); `recoverPendingLocalCommit()` backfills `commitSha` / `state:'syncing'` and saves the outbox at `:813-821`, and only calls `pushMain()` at `:830`. Backfill is strictly before push — no orphaned claim via a post-push window. A crash window does exist between commit (`:766`) and outbox save (`:821`), but it is benign: `classifyIntentLanding()` returns `present` whenever the line is in HEAD (`:631-633`, `:641`), independent of the marker, so the next recovery flushes it. Same sequence is present in `dist/sync/cycle.js:581-603, 627-643`.

5. **Retry independence and bound — PASS.** Per-intent proof splits already-landed intents (b) from fresh ones (c) at `cycle.ts:675-694`; fresh intents are applied/committed once at `:811-825` and all verified ids are pushed/dequeued at `:827-847`, so a parked intent no longer blocks a new write (PI-01, PI-04). Bound: `for (retry = 0; retry < MAX_CYCLE_RETRIES; retry++)` at `:799` with `MAX_CYCLE_RETRIES = 2` (`:75`), an early `pendingIsOurs()` break at `:849-850`, and the separate `MAX_ATTEMPTS = 4` replay budget (`:68`, `:243-245`). Terminal state is typed `LOCAL_PENDING` with a "next step" message (`:77-79`, `:852`).

6. **Tests — PASS.** Reading the assertions: PI-01 (`test/plugin-v2-cycle.test.mjs:625-656`) asserts parked + new both appear in the pushed HEAD tree, outbox empty, code not `CORRUPT`; PI-04 (`:698-729`) asserts the same for two parked + one new, with exactly one commit and one push. Both would throw `E_CORRUPT` on the pre-fix union-vs-HEAD check, so the executor's claim that they fail pre-fix is consistent. PI-02 (`:658-677`) checks `absent ⇒ E_CORRUPT`, zero push/add/commit, byte-identical outbox; PI-03 (`:679-696`) checks `present ⇒ push, empty outbox, head == origin`. Both describe behavior the buggy version also satisfies, so they pass on both versions — as claimed. Gate log marks all four `✔`.

7. **Dist — CONCERN.** No fresh `tsc --outDir` was run (the review charter forbids builds), so byte-exact equality is unverified. Static comparison of every changed region shows source and `dist/sync/cycle.js` agree: `classifyIntentLanding` dist `:438-468` vs src `:614-645`; `proveRecoveryState` dist `:476-509` vs src `:661-695`; `applyUnappliedIntents` dist `:517-604` vs src `:704-790`; `recoverPendingLocalCommit` dist `:609-668` vs src `:796-853`; normal-path sha backfill dist `:839-844` vs src `:1021-1026`. PI tests import `dist` and pass. Read-only `git status` shows `dist/client.js` modified vs HEAD, but its diff content is entirely `mod-pairing-listener-truth` copy/UI changes (`lean.remote.start*`, `doStart`, `fetchQr` guard) matching the separately modified `src/client.js`, with nothing from this lane's cycle change; the in-suite test `dist/client.js 与 build.mjs 新鲜构建输出逐字节一致` (`test/client-loader-id.test.mjs:62-70`) passed in the cited gate run, so the file matches current source. Because the shared build rewrote all dist files at the same timestamp (19:55:00–19:55:01), "this lane never wrote `dist/client.js`" is plausible but not strictly provable from artifacts.

8. **Gates — PASS.** Tail of `.tmp/gates-plugin-outbox-per-intent.out`: `ℹ tests 3788`, `ℹ suites 421`, `ℹ pass 3787`, `ℹ fail 0`, `ℹ cancelled 0`, `ℹ skipped 1`, `ℹ todo 0`, `ℹ duration_ms 33679.7363` — matches the executor's 3788 / 3787 / 0 / 1. All four PI tests appear as `✔`; a search for failure markers returned nothing. There is no failing test, hence no owner to name. The earlier 27-failure overlay-contaminated run is not recorded in this file and was not inspected.

## Residual risk & unverified
- Same-id updates during a parked-push recovery still return `absent` → `E_CORRUPT` (`cycle.ts:630-633`); covered by C29 by design but not by PI-01/PI-04. If the Lead's live "new write" was an edit to an existing record rather than a new record, the deadlock remains for that case.
- Byte-for-byte equivalence of `dist/sync/cycle.js` to a fresh `tsc --outDir` output was not executed; only line-by-line structural equivalence was checked.
- No real-device verification: all evidence uses in-memory ports; the commit/push byte flow is simulated in tests via `onCommit` / `onPush` hooks (`test/plugin-v2-cycle.test.mjs:644-646, 718-719`).
- The 27-failure prior run attributed to a concurrent `.platform-overlay` app build was not opened; the cited file contains zero failures.
- Out-of-scope files (`src/client.js`, `src/remote/**`, `src/engine/**`, `apps/**`) were not reviewed; `dist/client.js` and several `dist/remote/*.js` are modified in the working tree by another lane.

## Evidence log
- Read: `packages/dsh-dots/src/sync/cycle.ts` (1056 lines); `packages/dsh-dots/dist/sync/cycle.js` (873 lines); `packages/dsh-dots/test/plugin-v2-cycle.test.mjs` (729 lines); `packages/dsh-dots/test/client-loader-id.test.mjs:43-70`.
- Grep: `带意图|union 字节|unionBytes|compareUnion|proveRecovery|allPending|showHead|showWorktree|读工作树` over `packages/dsh-dots/**/*.{ts,js,mjs}`; `带意图|union 字节与 HEAD|全量 union 对 HEAD` over the whole suite.
- Read-only PowerShell: decoded `.tmp/gates-plugin-outbox-per-intent.out` as UTF-16 and extracted tail, PI lines, failure markers, and summary counts; also read `.tmp/gates-plugin-outbox-per-intent-plugin-only.out` summary (tests 725 / pass 724 / fail 0 / skipped 1).
- Read-only git: `git status --porcelain` and `git diff --stat` scoped to `packages/dsh-dots/{dist,src/sync/cycle.ts,test/plugin-v2-cycle.test.mjs}`, plus `git diff -- packages/dsh-dots/dist/client.js` to attribute its changes.
- No builds, no overlay, no git writes, no device commands, and no subagents were used in this review.
