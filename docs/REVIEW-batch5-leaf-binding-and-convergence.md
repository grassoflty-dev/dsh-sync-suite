# Review — batch 5: leaf binding + sync convergence harness

## Verdict
CONDITIONAL PASS — Leaf↔pin binding is real, normalised, non-TOFU, rotation-observing, and produces two distinct canonical refusals with zero dependencies and zero files while dark. The convergence harness uses real git end-to-end on temp-isolated dual clones and its SC-06 directly kills both a path-confinement loosening and a dropped trailer requirement. No Major; one Minor: an injected `PinLookup` that throws escapes as an untyped error instead of a three-state refusal. Major findings remaining: 0

## Findings

### Blocker
None.

### Major
None.

### Minor
1. **A throwing injected pin source escapes the three-state contract — `packages/dsh-dots/src/remote/sessionPrompt.ts:191-194`.** `pins.lookup()` is called outside a `try/catch`; my driver (`packages/dsh-dots/.tmp/review-b5-leaf.mjs`, capture `.tmp/review-b5-leaf.out`) with a lookup that throws produced `state=THROW:pin-store-down` and `send=THROW:pin-store-down` (not `E_CHANNEL_UNVERIFIED`/`E_CHANNEL_LEAF_MISMATCH`) — though all 8 dependency spies stayed 0 and no file was written. The shipped default `createPairingPinLookup()` catches internally (`:87-93`), so no production path triggers this; it only affects injected ports. Still, `channelState()` is documented to return one of three states, so the contract is broken for a failing port.

### Nit
1. `refusal-wording-parity.test.mjs` test title still says "16 行" although it now asserts 17 rows (`:100-106`); cosmetic.
2. The brief describes the harness as 532 lines; the file is 573 lines. No functional impact.
3. The expected captures cited at repo-root `.tmp/` actually live under `packages/dsh-dots/.tmp/` (`gates-convergence-targeted.out`, `targeted-leaf-binding.out`, `tsc-leaf-binding.out`, `distcheck-leaf-binding.out`); all exist at the plugin location.

## Checklist

### A. Leaf binding real and safe — PASS (with Minor 1)
`channelState()` (`sessionPrompt.ts:171-195`) returns `unverified` for blank ids before IO (`:173`), missing/bad/extra-field markers (`:174-186`) and cross-instance markers (`:189`); it looks up the pin (`:191`), returns `unverified` when none (`:193`), and compares `bareFingerprint(marker.leafSha256)` to `bareFingerprint(pin.fingerprint)` (`:194`). No TOFU: the marker's own hex is never installed as a pin. Driver matrix (`.tmp/review-b5-leaf.out`): baseline lower-case → `verified`; marker colon+upper / pin lower → `verified`; marker spaces around hex → `verified`; pin different case → `verified`; marker `0x`-prefix → `unverified` + `E_CHANNEL_UNVERIFIED`; 64-hex of a *different* instance → `leaf-mismatch` + `E_CHANNEL_LEAF_MISMATCH`; marker for B/request A → `unverified` + `E_CHANNEL_UNVERIFIED`; no pin → `unverified`; rotation verified→verified→`leaf-mismatch` (no caching); all refusal cases had all 8 spies 0. With real default ledger/lease stores and a temp home, both refusals produced `files-under-home=[]` (no ledger/lease/marker files). Production default pin source is local-only (`sessionPrompt.ts:86` `instanceId !== defaultDeviceId()` ⇒ null), so remote instances stay `unverified` — honest fail-closed, but a scope limit (unverified for remote release use).

### B. Distinct code and canonical wording — PASS
`E_CHANNEL_LEAF_MISMATCH` is emitted only at `sessionPrompt.ts:205` when `state === 'leaf-mismatch'`; all other dark failures still throw `channel.desktop.unverified` (`:206`); no substitution. RPC maps both keys through `PROMPT_CODE_BY_KEY` / `PROMPT_WORDING` with no inline literal (`src/rpc.ts:1202-1212`), using optional `channelState` with boolean fallback (`:1205-1208`). `docs/REFUSAL-WORDING.md:18` carries the 17th row; parity test asserts `row count 17`, the exact key set including `channel.desktop.leafMismatch`, and `plugin row count 12` (`test/refusal-wording-parity.test.mjs:36,106-107,137`). Mutation proof on copies (`.tmp/review-b5-parity-mutants/`): baseline 17/17 0 mismatch; doc cell changed → 3 mismatches; plugin string → 2; App constant → 2; each fails at `:149`.

### C. "No file while dark" is permanent — PASS
`channel-leaf-binding.test.mjs:214-252` (L8) deliberately omits `leases`/`ledger` from `createSessionPromptService` (`:225-231`), scans the whole temp `homeDir` after an `E_CHANNEL_LEAF_MISMATCH` and then an `E_CHANNEL_UNVERIFIED` (`:223,233-235`), and asserts no `prompt-ledger.json`, `session-leases.json` or `channel-verified.json` anywhere plus an empty state root (`:237-258`). My independent default-store driver reproduced `files-under-home=[]`.

### D. Convergence harness — PASS
Real `GitRepoV2Port`/`NodeTimelineFs`/`NodeOutboxPort` via `buildV2Ports` (`:132-137`), real `runV2Cycle` (`:197-203`), one bare remote + two independent clones with separate temp homes/state roots (`makeTopology` `:93-114`, `makeEndpoint` `:120-163`). All paths are temp-injected and asserted under `top.root` (`:96,138-141`); `statePaths(home)` resolves `<temp>/home/.dsh/dots` and `env: { DSH_DOTS_REPO_ROOT: rootOverride }` (`:123-134`) — no `~\.dsh\**` access; every topology has `t.after(rm)` (`:95`), and no `sc*`/`leaf-*` temp dirs remained after the run.
- **SC-01** (`:247-279`): byte-equal records and `git show HEAD:timeline/.../records.json` equality (`:271-272`), `HEAD==origin/main==remote` — HEAD blobs, not just work tree.
- **SC-02** (`:283-310`): later ts wins, winner bytes equal across swapped directions (`:309`), no conflict rows.
- **SC-03** (`:314-347`): deterministic tie-break, exactly one identical conflict row per side and per direction (`:333-345`).
- **SC-04** (`:351-389`): tombstone at T3 beats later upsert, stale T0 upsert dropped (`dropped=1`), no resurrection.
- **SC-05** (`:393-444`): rejected push → `attempts=1`/`pending`; next cycle `pending=0/failed=0`, outbox `[]`, and the parked intent is in the **pushed** tree (`git bare show main:...` at `:429-431`).
- **SC-06** (`:448-526`): foreign no-trailer commit → nothing pushed, outbox bytes identical, named verdict `foreign`/`尾注缺失` (`:484-488`), message cites `dsh-dots-v2` and `尾注` (`:491-492`); separate ours-commit path shows the verdict is written verbatim into the terminal message (`:519-525`).
- **SC-07** (`:530-573`): converged re-run `attempts===0`, no writes/commit/push, full snapshots and commit-subject lists unchanged.
- **Would SC-06 catch loosening? YES.** Loosening `isConfinedTimelinePath` to accept `timelineX/…`, `timeline/../chats/…` or `timeline//x` fails the three direct `=== false` assertions at `:495-497`; dropping the trailer requirement fails `verdicts[0].trailer === false` (`:486`), `verdict.ours === false` (`:484`), `isOursCommit(...) === false` (`:489`) and the `/尾注/` message assertion (`:492`). A widened path predicate also breaks `outside`-commit `untrusted` (`:503-505`).
- **Cannot prove:** the fixture performs its own `git fetch` + `merge --ff-only` between cycles (`:165-169`), so it does **not** prove behind-state auto-recovery in the shipped cycle; no real DSH session/agent, no network/auth, no tablet writer.

### E. Scope / hygiene — PASS
Only the 9 leaf-module paths + 1 doc + 1 harness test are uncommitted; no product source changed by the harness and no dist/build for it. Plugin dist window = exactly `dist/remote/promptWording.js`, `dist/remote/sessionPrompt.js`, `dist/rpc.js`. App tree untouched this batch except the pre-existing `M AppScope/app.json5`; `remoteCommandGate.ts` still `08fafb06cfa52133800a9bbb25b4d5d86db6da6c`. No `.tmp-*` at repo roots. Re-ran with captures: plugin suite 831/829/0/2 (`.tmp/review-b5-plugin-suite.out`, matching both lane captures), targeted 16/16 (`.tmp/review-b5-targeted.out`), tsc 0 (`.tmp/review-b5-tsc.out`), credential hygiene 11/11 (`.tmp/review-b5-credential.out`).

## Stage sets confirmed
- **Leaf module (9 paths):** `M src/remote/{sessionPrompt,promptWording}.ts`, `M src/rpc.ts`, `M test/{refusal-wording-parity,session-prompt-rpc}.test.mjs`, `A test/channel-leaf-binding.test.mjs`, `M dist/remote/{sessionPrompt,promptWording}.js`, `M dist/rpc.js` (all under `packages/dsh-dots/`).
- **Harness (1 path):** `A packages/dsh-dots/test/sync-convergence.test.mjs`.
- **Doc (1 path):** `M docs/REFUSAL-WORDING.md`.
- **Must NOT ride:** `M apps/arkui-schedule/AppScope/app.json5`, all committed review files.

## Residual risk & unverified
No delivery port exists (nothing is ever sent); no device/`hdc` run; dark action tested only via injected pins/markers in temp dirs; the operator marker remains a same-trust-domain assertion, not cryptographic proof; production pin source covers only the local device id; injected pin source that throws is untyped (Minor 1); harness does not prove behind-state auto-recovery, real DSH/network/auth or tablet writes; POSIX 0600 store test skipped on Windows.
