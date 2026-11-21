# Plugin writer re-review (r2, focused)

Scope: DSH plugin package `packages/dsh-dots` at HEAD `b756001` (`b7560010b4fef8760b9804beb5f5a2cb44d21b11`). Read-only pass over the 1 Blocker + 6 Majors of `docs/REVIEW-plugin-writer.md`, verified in source and in tests (author prose not trusted). Repo comments/docs are Chinese; this report is English.

## Verdict

**FAIL** — five of the seven items are closed, but the post-rejection recovery path never calls the B1 validator and dequeues parked intents as "applied" without re-applying them, and the `[v2] ` subject heuristic cannot distinguish this module's commits from the ArkTS app's (the app emits the identical subject), so an intent can be silently dropped and a peer's commit misclassified as ours. Major findings remaining: 2.

## B1

**STILL OPEN** (the data-destruction path itself is closed; the parking invariant is not universal).

Verified as claimed in the normal cycle:

- `assertUpsertIntent` exists at `packages/dsh-dots/src/sync/cycle.ts:242-258` and checks, in order, `isValidTsShape(entry.ts)` (`:243`), `parseRecordLine(entry.line) !== null` (`:246-249`), `(id, ts)` payload/line equality (`:250-252`), and the shared `planUpsert(date, null, record)` with `!plan.ok || plan.text === ''` (`:254-257`) — typed `E_CORRUPT` on every branch. `planUpsert`'s `buildRecordsText` self-check is real (`src/timeline/write.ts:341-359`, empty text → `failPlan` at `:356-357`), so `title:123` / bad media are refused.
- Called before any byte at `cycle.ts:381-385`: the whole `replay` list is validated up front, before the ledger/deletion loops (`:386-400`) and before the replay loop (`:407-447`). (Claim quoted `:354-356`; the actual guard is at `:381-385` — line drift only.)
- Empty-text sentinel is fatal at `cycle.ts:456-460`: `recordsTextOf(date, …)` (→ `buildRecordsText`, `write.ts:377-379`) returning `''` throws `E_CORRUPT`.
- Read-only union pre-pass exists at `cycle.ts:642-667`: all `unionDay` results are computed before the first write handle (schema marker `:671-678`, records `:689`, ledgers `:696/:704`, conflicts `:721`). Any `E_CORRUPT` from `unionDay` is caught at `:662-667` and returned via `failure(...)` **before** `outbox.save`/`addPaths`/`commit`/`pushMain` (`:739-755`), so normal-cycle zero-write is genuine.
- Inverse test is real, not a happy path: `test/plugin-v2-cycle.test.mjs:353-375` seeds a valid `records.json`, injects a `title:123` upsert, and asserts `ok=false`, code `E_CORRUPT`, SHA-256 unchanged, outbox snapshot unchanged, `attempts===0`, `outbox.saves===0`, `git.writes()===[]`, plus a direct `assert.throws` on `unionDay`. Removing the guard makes this test fail (the original review reproduced `recordsText === ''` with `applied:[intentId]` against `dist`). `C18` at `:377-393` adds malformed-ts and id/ts-drift variants; `C17` also pins that `outbox.saves===0`, i.e. the bad intent is retained on disk, not dropped.

Gap that keeps B1 open (see New findings F1): the recovery path `recoverPendingLocalCommit` (`cycle.ts:547-576`) pushes at `:554` and dequeues every replayable intent at `:561-564` **without ever calling `assertUpsertIntent` or `unionDay(..., all, ...)`**. `unionMatchesLocal` (`:523-544`) calls `unionDay` with an empty entry list (`:536`). So a malformed/parse-broken intent parked in the outbox can coexist with an ahead-only local commit, be pushed past, and be dequeued as `applied` without validation — the invariant "no path reaches a push with an invalid intent" and "intent stays parked" both fail there.

## M1

**CLOSED.**

- `V2SyncRuntime` at `src/sync/bootstrap.ts:47-158`; `mountV2Sync` at `:164-181`; import and call in `src/index.ts:25-26` and `:176-181`. The call chain `apply() → mountV2Sync(ctx, {...}, false) → runtime.start() → migrateLegacyWorkDir + runV2Cycle` is reachable (bootstrap `:97-140`).
- `registerEffect=false` branch at `bootstrap.ts:175-179` starts fire-and-forget with no `ctx.effect` and no cleanup function. No new obligation relative to the `true` branch (whose cleanup is also `() => undefined`, `:171-174`). The effect-count contract is pinned by an independent real call to `index.apply()` in `test/schedule-bridge.test.mjs:492,502,512` (9/5/5), which would break if the `false` were dropped. (Caveat: a shared, pre-existing askpass temp-dir leak is noted under Minor M-1; it is not introduced by `registerEffect=false`.)
- `git diff HEAD -- packages/dsh-dots/src/index.ts` = 9 insertions, 0 deletions: only the import (`:25-26`) and the call (`:176-181`). Nothing else in `src/index.ts` changed.
- Wiring test pins real things: `test/plugin-v2-wiring.test.mjs:24-30` (WIR01 source shape), `:32-44` (WIR02 assembly points), `:46-77` (WIR03/04 real fail-closed runtime branches `E_UNCONFIGURED` / `E_NO_APP_FILES_DIR`), `:79-90` (WIR05 one effect on the default `true` branch). Note WIR01's regex `/mountV2Sync\(ctx,\s*\{/` does **not** pin the third argument `false`; the `false` is pinned by `schedule-bridge.test.mjs`, not by the wiring test.

## M2

**CLOSED.**

- `outboxPathFor` at `src/sync/outbox.ts:16-18` builds `path.join(stateRoot, 'outbox', <repoHash>.json)`; `bootstrap.ts:62-71` passes `paths.root` from `statePaths`, so the default path is `~\.dsh\dots\outbox\<repoHash>.json`, outside the working clone. `O01` (`test/plugin-v2-outbox.test.mjs:64-76`) asserts the exact path, the `outbox/` prefix and no `.git` segment.
- `NodeOutboxPort` (`:28-73`): `load()` returns `[]` for a missing file and throws typed `E_CORRUPT` for bad JSON / non-array / missing `intentId` (`:48-67`); `save()` delegates to `atomicReplace` (`:70-73`), which is the verified discipline tmp → byte-for-byte read-back (`write.ts:139-150,156-165`) → same-dir rename, with backup/restore fallback (`:166-184`). Empty array serialises to `[]\n`.
- Real restart simulation: `O02` (`:78-97`) and `O04` (`:113-143`) construct a **new** `NodeOutboxPort` instance (`outbox2`, `:126`; `drained`, `:138`) after a rejected push; `O04` asserts `attempts===1`, then a successful cycle and a file byte-equal to `'[]\n'` (`:137`). Not the same object reused.
- Residual scope note (not an M2 failure): no production code calls `enqueueIntent`; the port is wired for reading/parking/dequeuing only (`grep` over `src/` finds `enqueueIntent` at `cycle.ts:172` and in tests alone). The file-backed port and its persistence contract are nonetheless implemented as claimed.

## M3

**STILL OPEN** (permanent wedge removed, but the ownership heuristic is not authorship-proof — see New findings F2).

- `MAX_CYCLE_RETRIES=2` at `cycle.ts:75`; typed terminal `LOCAL_PENDING` code `:59` and message `:78-79`; detection at `:629-639` (gate failure + `pendingIsOurs`), `pendingIsOurs` at `:515-520`, `unionMatchesLocal` at `:523-544`, recovery at `:547-576`. On failure the loop ends with `failure(V2_ERROR.LOCAL_PENDING, …)` (`:575`) — a typed, visible dead-end with manual-reconciliation instructions, not a silent wedge. No `reset`/`rebase`/`checkout`/force in `gitPort.ts:38-39,50-60,115-121`; push is fixed `{origin, main, force:false}` with runtime re-assertion (`:115-118`). No history rewrite in recovery: only `pushMain` + `fetchMain` (`:554,:571`) and outbox saves (`:559,:564`).
- Bounded retries are real and pinned: `C19` (`test/plugin-v2-cycle.test.mjs:397-414`) shows a second cycle recovering with exactly one write (`push` only); `C20` (`:416-433`) asserts `E_LOCAL_PENDING`, exactly `MAX_CYCLE_RETRIES` pushes, no `add`/`commit`, and attempts accumulated; `C21` (`:435-441`) asserts an unrelated ahead commit still returns `E_NOT_SYNCED` with zero pushes.
- Heuristic defect: `isV2CommitSubject` (`cycle.ts:90-92`) is `/^\[v2\] (sync \d+ days|bootstrap main)$/` — subject text only, no author/identity check. The app emits the **identical** subject: `apps/arkui-schedule/entry/src/main/ets/services/syncProtocolStore.ets:98` `COMMIT_PREFIX = '[v2] sync '` and `:552` `git(['commit','-m', \`${COMMIT_PREFIX}${empty.days} days\`])`. The shared-clone design (`repoPath.ts:64-65`, `resolveV2RepoDir` → app's `git-repo/`) puts both writers in one clone, so an app-authored local commit with `behind=0, ahead>0` is classified as "ours" and handed to recovery. Mitigating factors (worth reporting, not sufficient to prove authorship): `pendingIsOurs` requires `behind===0` (`:517`), so a peer commit that arrived via `origin/main` is excluded; after a failed push the loop re-fetches and re-derives the union (`:571-573`); retry is bounded at 2. But the classification itself is demonstrably wrong, and the consequence (F1/F2) is silent intent dequeuing.

## M4

**CLOSED.**

`sortConflictRows` at `cycle.ts:305-323`, applied at `:463`, matches the app reference line by line:

| app `syncProtocol.ts:769-784` | plugin `cycle.ts:305-323` |
|---|---|
| `asObject(left/right)` (`:771-772`, def `:388-398`) | try/catch `JSON.parse` + non-null object/non-array check (`:309-316`) |
| `a===null\|\|b===null → byteCompare(left,right)` (`:773-775`) | `byteCompare(left,right)` (`:317`) |
| `compareTs(String(a.ts), String(b.ts))` (`:776-779`) | `tsCompare(String(a.ts), String(b.ts))` (`:318-319`) |
| `String(a.id) < String(b.id)` (`:780-782`) | identical (`:320`) |
| `byteCompare(String(a.dedupeKey), String(b.dedupeKey))` (`:783`) | identical (`:321`) |

`compareTs` semantics also match: app `Date.parse` fallback (`syncProtocol.ts:281-288`) vs plugin `tsMillis` (`records.ts:163-166`) → `tsCompare` (`cycle.ts:279-284`). Key order is `(ts, id, dedupeKey)` in both. `C23` (`test/plugin-v2-cycle.test.mjs:461-480`) uses three conflict rows, asserts swapped-sides byte equality, explicit `[(early,c3),(T0930,a1),(T0930,b2)]` order and re-sort idempotence.

## M5

**CLOSED.**

- `E_MIGRATION_TARGET_MISMATCH` at `src/sync/repoPath.ts:25`; verification at `:206-219`: reads `remote.origin.url` from legacy (`:209`) and target (`:210`) plus `rev-parse --is-inside-work-tree` (`:211`), and requires `legacyOrigin !== ''`, `targetOrigin !== ''`, `legacyOrigin === targetOrigin`, `targetIsWorkTree === 'true'` (`:212`). Two empty strings cannot satisfy the condition because of the two explicit `=== ''` rejections.
- Mismatch throws at `:213-216` **before** `writeMarker` (`:217`/`:221`) and before `move` (`:220`); abort path (unpushed > 0) throws at `:200-204` after only `readMarker`/`exists`/`gitRead` (`:171-190`) — no move, delete or marker write. `gitRead` allows only `rev-parse`/`rev-list`/`config --get` (`:108-113`).
- Tests: `M07` (`test/plugin-v2-migration.test.mjs:170-196`) — foreign remote → typed mismatch, marker absent, both dirs intact; `M05` (`:139-155`) — same remote → repoint, legacy retained, idempotent; `M06` (`:157-168`) — write git subcommands rejected at the port; `M08` (`:198-212`) — HEAD unresolvable with `.git` present → fail-closed `E_LEGACY_UNPUSHED`, nothing touched (m3 addressed). `M02` (`:72-100`) still proves the `E_LEGACY_UNPUSHED` abort preserves bytes.

## M6

**CLOSED.**

- `C15` (`test/plugin-v2-cycle.test.mjs:312-331`) lists **six** sources (`:314-321` — `write.ts`, `cycle.ts`, `gitPort.ts`, `repoPath.ts`, `outbox.ts`, `bootstrap.ts`) and **every** `dist/sync/*.js` via `readdirSync` (`:322-323`), with a guard `compiled.length >= 5` (`:330`). Regex at `:325`: `/resetHard|reset[A-Z]|\breset\b|rebase|checkout|--force|force\s*:\s*true|pullRebase|pushWithRebase/i`.
- `C16` (`:333-349`) scans all compiled `dist/sync/*.js` (`:336-341`) and pins the compiled runtime assertions in `gitPort.js`: `args.remote !== "origin"` / `args.branch !== "main"` / `args.force !== false` (`:344-348`), plus `force: false` in `cycle.js` (`:342-343`).
- Regex probe (exact patterns, `node`): `resetHard`, `resetToOrigin`, `git reset --hard`, `reset --hard`, `--force`, `force: true`, `rebase`, `checkout`, `pullRebase`, `pushWithRebase` → C15 `true` for all; C16 catches `resetHard`/`force: true`/`rebase`/`checkout`/`pullRebase`/`pushWithRebase` but not `resetToOrigin`/`--force`/`reset --hard` — those are covered by C15's broader pattern over the same compiled files. Because both tests read files from disk at test time, a hand-edit to any `dist/sync/*.js` adding those tokens, or removing the `gitPort.js` assertions, fails the suite. (Full suite indeed passes with the current artifacts.)

## New findings

### Blocker

None.

### Major

- **F1 — B1 validation/parking bypassed by the recovery path.** `cycle.ts:547-576`: on ahead-only commits, `pushMain` (`:554`) happens with no `assertUpsertIntent` pass; on success every replayable intent is dequeued (`:562-564`) and reported as `applied` (`:567`) although no `unionDay` replay occurred. `C19` (`test/plugin-v2-cycle.test.mjs:397-414`) demonstrates this exact shape with a parked intent and "only push, no add/commit" (`:410-411`). A malformed intent, or one whose effect was never committed, is silently dropped instead of parked `E_CORRUPT`. Fix: run the same validate-and-union gate (or at minimum `assertUpsertIntent` over all replayable intents) before any recovery push/dequeue, and keep invalid intents parked.
- **F2 — `[v2] ` owner heuristic misclassifies the app's commits.** `cycle.ts:90-92` + `:515-520`; app at `syncProtocolStore.ets:98,552` emits the identical subject into the same shared clone (`repoPath.ts:64-65`). A local, unpushed app commit is treated as this module's own and pushed; combined with F1, parked intents are dequeued as applied. `behind===0` (`:517`) and `unionMatchesLocal` (`:571-573`) bound the damage but do not establish authorship. Fix: require the plugin's commit identity (`dsh-dots <sync@localhost>`, `gitPort.ts:14`) in `aheadSubjects`, or carry a module-specific trailer/subject token the app does not emit.

### Minor

- **M-1 — askpass temp-dir leak on every authenticated start.** `bootstrap.ts:113-122` builds a `GitRepoV2Port` inside `start()` (and `:147-151` in `syncNow()`) but never calls its `dispose()` (`gitPort.ts:123-125` → `engine/git.ts:690-702`). With HTTPS+token auth, `GitRepo.run()` → `buildEnv()` → `ensureAskpass()` (`git.ts:284-314,337`) creates `dsh-gcs-askpass-*` via `mkdtemp`; nothing removes it. Both `registerEffect` branches share this, so M1's "no new obligation" claim holds, but the comment at `bootstrap.ts:176` ("no handles needing unload") is not strictly true.
- **M-2 — no production outbox producer.** `enqueueIntent` (`cycle.ts:172`) has no `src/` caller; only tests populate the outbox. The file-backed port is correct, but until a writer enqueues, `runV2Cycle` sees an empty outbox in production and the parked-intent contract is exercised only by tests.
- **M-3 — `outbox.ts` `filePath` override is unguarded.** `outbox.ts:33-35` accepts any explicit path; the comment "still must be outside the work tree" (`:24`) is not enforced in code. Default construction is repo-external; only the override can violate that.

### Nit

- **N-1 — recovery retry-count comment is off by one.** `cycle.ts:71-74` says "2 extra pushes, 3 total including the first"; the loop at `:550` makes exactly 2 push attempts, as `C20` (`test/plugin-v2-cycle.test.mjs:430`) pins.
- **N-2 — WIR01 does not pin `registerEffect=false`.** `test/plugin-v2-wiring.test.mjs:27` matches only `mountV2Sync(ctx, {`; the `false` is protected by `test/schedule-bridge.test.mjs:492,502` instead.

## Checklist

7. **Suite — PASS, exact expected numbers.** `node --test "test/*.test.mjs"` in `packages/dsh-dots` → `ℹ tests 566 / pass 565 / fail 0 / skipped 1 / cancelled 0 / duration_ms ≈31266`. No named failure; the single skip is the suite's pre-existing skipped test (the same one reported as 1 skipped in r1).

8. **dist freshness — PASS, author's number reproduced.** `npx --no-install tsc -p tsconfig.json --noEmit` exit 0. Fresh `tsc --outDir <TEMP>` exit 0; **59 emitted `.js` files, 59 exact SHA-256 matches, 0 mismatch, 0 missing**. `dist/` holds 60 `.js` files; the one with no TS source is `dist/client.js` (copied by build.mjs). Targeted comparison of every file under `dist/sync/` (5 files) + `dist/timeline/write.js` + `dist/index.js` → **7/7 match**. Temp dirs removed; repo `dist/` not written; `node scripts/build.mjs` not run.

9. **Scope discipline — PASS.** `git diff HEAD -- packages/dsh-dots/src/schedule packages/dsh-dots/src/rpc.ts packages/dsh-dots/src/remote packages/dsh-dots/cordis.patch.yml packages/dsh-dots/package.json` is empty. `git diff HEAD -- packages/dsh-dots/src/index.ts` is 9 insertions / 0 deletions (import `:25-26`, call `:176-181`) — M1 only. Plugin-package tracked modifications are exactly `src/index.ts` and `dist/index.js`; the remaining untracked plugin paths are the reviewed `src/sync/**`, `src/timeline/write.ts`, `dist/sync/**`, `dist/timeline/write.js` and five `test/plugin-v2-*.test.mjs`. Working-tree `apps/**` edits (`GitSyncService.ets`, `syncStatusStore.ets`, `git-bridge.js`) and `docs/REMOTE-DISCOVERY.md` / `docs/REVIEW-plugin-writer.md` belong to other lanes and are untouched by this module.

10. **Docs — NOT YET WRITTEN (deliberate, a docs pass follows).** The registration MUST say: (a) **scope** = writer + cycle + migration — atomic replace/read-back/rename, append-only ledgers, schema gate, fetch+union+replay, typed refusals, no force-push/no rebase; (b) the **refuse-and-park invariant** — a shape-invalid replayed upsert or empty-`recordsText` sentinel raises `E_CORRUPT` with zero writes/zero commit/zero push and the intent retained in the outbox (and must be extended to the recovery path per F1); (c) **bounded retry** — `MAX_CYCLE_RETRIES=2`, exhausted recovery ends in typed `E_LOCAL_PENDING` with manual reconciliation and no history rewrite; (d) **outbox file path** — `~\.dsh\dots\outbox\<repoHash>.json`, repo-external, atomic, attempts persist across sessions; (e) **migration identity check** — both `remote.origin.url` values non-empty and equal plus `--is-inside-work-tree === true`, else `E_MIGRATION_TARGET_MISMATCH` touching nothing; unpushed legacy commits still give `E_LEGACY_UNPUSHED`; (f) the **unverified** list verbatim in scope: real remote auth/push, real two-device union, live DSH session, app lock contention on the shared clone, real-git non-fast-forward recovery.

## Residual risk & unverified

- **Real remote auth / push:** no network test; `GitRepoV2Port` never exercised against a real Gitee/GitHub endpoint; token hygiene inherited from `engine/git.ts` and now also subject to the M-1 temp-dir leak.
- **Real two-device union:** C07/C08/C23 compare plugin-to-plugin and hard-coded expectations, not the app's compiled `unionDay`; no cross-runtime byte diff.
- **Live DSH session:** plugin not installed on a device; `mountV2Sync` effect counts verified only via `index.apply()` in unit tests; `start()` fail-closed branches verified with a temp home, not a real profile.
- **App lock contention on the shared clone:** plugin and ArkTS app share `git-repo/`; no lock, no arbitration, no test.
- **Real-git non-fast-forward recovery:** C19/C20/C21 use `FakeGit`; `aheadBehind`/`aheadSubjects` against a real repo with a genuine rejected push are unverified — exactly where F1/F2 live.
- **Outbox producer absent (M-2):** attempts persistence is proven, but end-to-end enqueue→park→replay with a real writer is not.
- **B1 recovery bypass (F1) and peer-commit misclassification (F2):** open; see New findings.
- **Injected path assumption:** `appFilesDir` / `overrideDir` are never reconciled with the app's `GitSyncService.getRepoRoot()` at runtime.
- **Snapshot nature:** all findings verified against the working tree at HEAD `b756001`; the other lanes' `apps/**` edits were changing during the pass and were deliberately not reviewed.

## Evidence log

- HEAD `b7560010b4fef8760b9804beb5f5a2cb44d21b11`; `git status --short` as recorded in Checklist 9.
- Sources read in full: `src/sync/{cycle,outbox,repoPath,gitPort,bootstrap}.ts`, `src/index.ts` (`:18-31`, `:150-182`), `src/timeline/write.ts` (`:130-199`, `:298-387`), `src/timeline/records.ts` (`:155-173`), `src/engine/git.ts` (`:265-319`, `:483-496`, `:680-703`).
- Tests read in full: `test/plugin-v2-{cycle,outbox,migration,wiring}.test.mjs`; targeted reads of `test/schedule-bridge.test.mjs:485-513` and `test/plugin-v2-write.test.mjs` (r1 baseline).
- App references: `apps/arkui-schedule/entry/src/main/ets/model/syncProtocol.ts:275-299,386-398,760-793`; `services/syncProtocolStore.ets:90-107,538-558`; `services/gitRunner.ets:174-187`.
- Commands: `node --test "test/*.test.mjs"` (566/565/0/1); `npx --no-install tsc -p tsconfig.json --noEmit` (exit 0); `npx --no-install tsc -p tsconfig.json --outDir <TEMP>` (exit 0, 59/59/0/0, `client.js` no-source, temp removed); `git diff HEAD -- <protected paths>` (empty); `git diff HEAD -- src/index.ts` (9 insertions); `git rev-parse HEAD`.
- Node regex probe of the exact C15/C16 patterns against 12 forbidden/benign tokens (results tabulated in M6).
- No `node scripts/build.mjs`, no overlay, no git writes, no subagents, no repo `dist/` writes; the only file written by this review is `docs/REVIEW-plugin-writer-r2.md`.
