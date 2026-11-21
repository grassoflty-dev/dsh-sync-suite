# Plugin writer review (r4 — final gate)

> **Provenance:** dispatched to an independent read-only reviewer; it overran its 5-minute time-box without writing a file, so the Designer executed this checklist directly (Lead-authorised). Every claim below was verified against the current tree by reading the source and running the gates; the independent reviewer's separate file for this round does not exist.

## Verdict

**PASS — Major findings remaining: 0.** Both r3 Minors are closed, and the two properties that make this module safe to commit are now proven at the level they failed before: **no push happens before the proof**, and **no dequeue happens for an intent that is not proven present in the pushed bytes**.

## m1 — path confinement: CLOSED

- `isConfinedTimelinePath` (`packages/dsh-dots/src/sync/cycle.ts:125`) rejects, in order: non-strings/empty, any `\`, a leading `/`, a drive-letter prefix (`/^[A-Za-z]:/`), and any empty / `.` / `..` segment; then requires `parts[0] === 'timeline'` **and** `parts.length > 1`. Prefix matching alone is explicitly not relied on.
- `isOursCommit` (`:134`) **ANDs** four conditions: subject shape, body trailer, `paths.length > 0`, and `paths.every(isConfinedTimelinePath)`.
- **C28** (`test/plugin-v2-cycle.test.mjs:571`) covers `timeline/../etc/passwd`, `timeline/./x`, `timeline//x`, `timeline\..\secret`, a drive-letter path and an absolute path, drives each through recovery as a valid-trailer ahead commit, and asserts typed `E_NOT_SYNCED` with **zero pushes**; a positive control (`timeline/<date>/records.json`) still passes, so the predicate is not vacuous.

## m2 — HEAD-bytes proof: CLOSED

- `proveRecoveryState` (`:581-608`) reads the **committed** bytes via `ctx.git.showHead(...)` for `records`/`deleted`/`restore` (`:590-596`, comment 「工作树可能被别的写入者改脏」) and compares the re-derived union text against those HEAD bytes; any divergence throws typed `E_CORRUPT` before anything is pushed.
- Port + implementation: `showHead` on the port interface (`:158`) and `repo.showFile('HEAD', rel)` (`src/sync/gitPort.ts:84`).
- **Order verified independently**: `proveRecoveryState` at `:623` → `pushMain` at `:630` → `dequeueIntents(..., proven.appliedIds)` at `:641`. The push cannot precede the proof, and the dequeue can only use proven ids.
- **C29** (`:594`) holds the intent's record in the working tree while HEAD holds different bytes, and asserts typed `E_CORRUPT` naming HEAD, unchanged outbox, `saves===0`, zero pushes — i.e. it fails if the proof reverts to working-tree bytes.
- Fakes were taught `showHead` (`FakeGit` `:99` backed by a real `headFiles` map), and C19/C20/C24 were seeded with matching HEAD bytes (`:425,:445,:516`) so they still pass for the right reason; the outbox-seam fake returns `''` (no recovery path there).

## Mechanical checks

1. **Suite** — `node --test "packages/dsh-dots/test/*.test.mjs"` → **572 / 571 / 0 / 1** (the single skip is the pre-existing proxy-env listener test). Zero failures.
2. **dist freshness** — fresh `tsc -p tsconfig.json --outDir <temp>` compiled clean and every emitted file was SHA-256 compared against the committed `dist/`: **59 match / 0 mismatch**. `dist/` is not stale; the module can ship as committed.
3. **No regression of r1–r3** — normal-path refuse-and-park (`E_CORRUPT`, zero write) intact at `assertUpsertIntent`; outbox file-backed atomicity unchanged; migration identity abort unchanged; conflict-row sort unchanged; M6 guards scan both source and `dist/sync/*.js`; trailer authorship remains subject + body + timeline-only diff.
4. **Scope** — only `packages/dsh-dots/**` changed for this module (`src/sync/**`, `src/timeline/write.ts`, `src/index.ts` + `dist` twins, 5 new test files). `src/schedule/**`, `src/rpc.ts`, `src/remote/**`, `cordis.patch.yml`, `package.json` untouched; no `apps/**` or docs touched by this module.

## Residual risk & unverified

- **Real remote auth/push** against Gitee/GitHub — never exercised; `GitRepoV2Port` was tested with fake git ports only.
- **Real two-device union** against the app's compiled `unionDay` — plugin-to-plugin byte checks only, no cross-runtime run.
- **Live DSH session** — no installed plugin/WebView boot; `mountV2Sync` wiring is proven by source-shape plus fail-closed runtime statuses.
- **App lock contention on the shared clone** — no lock or arbitration exists; `appFilesDir` is injected and never reconciled with `GitSyncService.getRepoRoot()` at runtime.
- **Real-git non-fast-forward recovery** — C19/C20/C21 use fakes; `aheadCommits`/`showHead`/`diff-tree` against a genuinely rejected push are unverified.
- **Trailer convention not adopted by the app** — app commits carry the identical subject but no `dsh-dots-v2:` body line, so they are correctly refused as "not ours"; cross-writer recovery stays a manual-operator path until the app adopts it.

## Evidence log

- Read `src/sync/cycle.ts` around `:120-140` (m1 predicates), `:575-650` (proof → push → dequeue), `src/sync/gitPort.ts:84`; `test/plugin-v2-cycle.test.mjs:571,594` plus the `FakeGit` `showHead` at `:99`.
- Ran the full plugin suite (572/571/0/1) and the temp-compile + SHA-256 dist comparison (59/59) myself, from `packages/dsh-dots`.
- `git status` filtered to `packages/dsh-dots` matches the executor's list: `src/index.ts` + `dist/index.js` modified, new `src/sync/**`, `src/timeline/write.ts`, `dist/sync/**`, `dist/timeline/write.js`, five `test/plugin-v2-*.test.mjs`.
