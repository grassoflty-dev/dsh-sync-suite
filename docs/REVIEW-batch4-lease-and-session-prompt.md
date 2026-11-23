# Review — batch 4: chat lease + session prompt (DARK) + refusal wording

## Verdict
CONDITIONAL PASS — DARK holds for absent/invalid markers with zero side effects, no delivery is invented, the precondition order and lease model are code-enforced, and the three-way wording parity gate is mutation-proven. One security defect survives: the operator marker is not bound to the request's `instanceId`, so a marker issued for instance B authorizes a send to instance A. Major findings remaining: 1

## Findings

### Blocker
None.

### Major
1. **Operator marker is not per-instance — `packages/dsh-dots/src/remote/sessionPrompt.ts:88-97,122-140`.** `validChannelMarker()` validates the four-field shape (including `instanceId` and `leafSha256`) but `channelVerified()` returns a bare boolean and `send()` calls it with no instance argument at `:140`. My dist driver (`packages/dsh-dots/.tmp/review-b4-dark.mjs`, capture `.tmp/review-b4-dark.out`) wrote a well-formed marker with `instanceId: B` and called `send()` with `instanceId: A` (both in the allow-list, grant granted): result `ok accepted=true`, with every spy at 1 — `leaseLoad/leaseUpsert/ledgerLoad/ledgerRecord/head/delivery` — i.e. the cross-instance marker reached `delivery.send`. The marker payload exists precisely to assert the verified channel for one instance/leaf certificate; accepting it for another instance defeats per-instance DARK gating. The gate's "channel verified" step is therefore not bound to the target. Fix: compare the marker's `instanceId` to the request's `instanceId` before the gate, e.g. `channelVerified(instanceId)`.

### Minor
None.

### Nit
1. `docs/REFUSAL-WORDING.md:32` states "操作员断言，不是密码学证明" — good; no cryptographic attestation is implied. The wording table at `:9-24` is a join with `—` cells, not a third literal copy; the parity test enforces that (checklist F).

## Checklist

### A. DARK property — CONCERN (Major 1; core property PASS)
- **Absent / invalid marker: PASS.** RPC checks before payload validation (`src/rpc.ts:1190-1195`); service checks before any dependency touch (`sessionPrompt.ts:138-140`). My driver: `absent`, `directory`, `bad-json`, `wrong-shape`, `extra-field` all returned `E_CHANNEL_UNVERIFIED` with every counter `{"instance":0,"grant":0,"leaseLoad":0,"leaseUpsert":0,"ledgerLoad":0,"ledgerRecord":0,"head":0,"delivery":0}` (`.tmp/review-b4-dark.out`). `validChannelMarker` rejects extra fields, missing fields, wrong id, bad hex, zero time, empty verifier and arrays (same capture). No caching: after a successful call, removing the marker made the next call refuse with all counters 0.
- **Marker is read-only: PASS.** `sessionPrompt.ts:13` imports only `readFileSync`; `:122-136` reads/parses; a whole-tree scan for `writeFile…channel-verified` in `src/` and `dist/` found 0 hits. `sync/bootstrap.ts:123` and `sync/repoPath.ts:97-98,136-138` write a *different* migration marker, not `channel-verified.json`. No startup/panel/handshake write path exists.
- **Cross-instance marker: FAIL** (Major 1). No code compares the marker's `instanceId` with `request.instanceId`.

### B. No invented delivery — PASS
`DeliveryPort` is an injected interface only (`sessionPrompt.ts:54-57`); production RPC constructs the service without `delivery` (`src/rpc.ts:236-240`), so `delivery = null`. With marker+grant present and no port, gate step 7 refuses `session.unavailable` (`:120`) before any lease/ledger write — driver `marker-A-no-delivery` shows `leaseUpsert=0, ledgerRecord=0, delivery=0` and `E_SESSION_UNAVAILABLE`. `projectDelivery()` (`:104-109`) cannot synthesize success: `undefined` → `{seq:0,sha256:'',accepted:false}` (`.tmp/review-b4-project.out`). No DSH session API, fake seq or fake `accepted` exists.

### C. Precondition order — PASS
`decideSessionPrompt()` (`promptGate.ts:69-127`) enforces channel (71) → grant (74) → text empty/limit 2000 (78-79) → lease (81-104; dots-only 85-87, OBSERVING 91-93, expired reclaim 96-103) → `expectedPrevSha` vs head (107-111) → idempotency (114-117) → delivery availability (120). Tests O1–O8 pin every precedence pair (`prompt-gate.test.mjs`, capture `.tmp/review-b4-targeted.out`: O6 "头锚不符优先于幂等", O7 "幂等优先于投递可用性"). `owner !== 'dots'` can never return ok (`lease.ts:396-404`, gates at `promptGate.ts:85-87`; tests E6–E8). The service eagerly *reads* lease/ledger/head (`:147-152`) before the gate, but those loads are side-effect-free; the decision order is gate-enforced.

### D. Idempotency scope & response — PASS
Ledger key is `(sessionId, requestId)` (`promptLedger.ts:1-5,169-183`); `seenInWindow` uses `nowMs - atMs < windowMs` so exactly 10 min is retryable, 1 ms less is duplicate (test I2), future stamps fail closed (I3); different session is accepted (I1). Response type is exactly `{seq, sha256, accepted}` (`sessionPrompt.ts:48-52`); test R7 asserts no prompt text / lease owner echo, and gate results carry only key/code/wording (`promptGate.ts:48-54`, W1/W2).

### E. Lease model — PASS
Four states (`lease.ts:25`), claim only FREE/expired with `reclaimed` reported (`:328-350`, B1–B6), owner-only heartbeat/release (`:356-386`, C1–D4), `E_HEAD_MOVED` even with a valid HELD lease (`:410-414`, E5/E9), dots-only hard gate (`:396-415`, E6–E8). Fail-closed decode of bad envelope ⇒ empty table + typed problem (`lease.ts:477-506`, F5/F6/F12; `promptLedger.ts:140-162`). Atomic write leaves no temp residue (F4) and POSIX 0600 where applicable (F10 skipped on Windows — unverified there). `lease.ts` has no executable `Date.now()` (only a comment at `:10`); zero `console.` in all four pure modules. Zero write-before-delivery on refusal (checklist B).

### F. Canonical wording + parity — PASS
`docs/REFUSAL-WORDING.md:9-24` has 16 rows with the exact key set; parity test `refusal-wording-parity.test.mjs:26-43,100-148` compares 19 pairs, substitutes `${COMMAND_TEXT_LIMIT}` from the App constant (`:79-95`), and checks hygiene. Mutation proof on copies under `.tmp/review-b4-parity-mutants/` (baseline 1/1 pass): doc cell changed → `PARITY: 3 mismatch`, test fails at `:148`; plugin string changed → `PARITY: 2 mismatch`, fails; App string changed → `PARITY: 2 mismatch`, fails. Threat-model paragraph (`:30-32`) says "操作员断言，不是密码学证明" — no attestation claim.

### G. Retargeted pre-existing test — PASS
`remote-readonly-rpc.test.mjs` diff: `sessionPrompt` removed from the `E_UNKNOWN_ACTION` list, but `sessionCreate`, `sessionLeaseClaim/Heartbeat/Release`, `grantList/Upsert/Revoke` (7 actions) still assert `E_UNKNOWN_ACTION`; a positive DARK assertion was added (`E_CHANNEL_UNVERIFIED` with marker absent). No other assertion deleted — the lock changed shape, strength not reduced.

### H. Scope / hygiene — PASS with a count discrepancy
`apps/**` untouched this batch (only the pre-existing `M AppScope/app.json5`); `model/remoteCommandGate.ts` still `08fafb06cfa52133800a9bbb25b4d5d86db6da6c`. `src/rpc.ts` diff is additive: imports/options/service construction + one action case; no existing action reordered. Worktree dist window is **7** paths (M `dist/rpc.js`; A `dist/remote/{lease,leaseStore,promptGate,promptLedger,promptWording,sessionPrompt}.js`), not the brief's "5" — all seven are attributable to the two modules, but the stated count is wrong (Nit-level). No `.tmp-*` at repo roots. Plugin suite 813/811/0/2, targeted 78/77/0/1, tsc exit 0, credential hygiene 11/11, independent dist freshness 74 files/0 mismatch (`.tmp/review-b4-{plugin-suite,targeted,tsc,credential,distcheck}.out`).

## Stage sets confirmed
- **Lease (5 paths):** `A packages/dsh-dots/src/remote/lease.ts`, `A .../leaseStore.ts`, `A packages/dsh-dots/test/lease-state.test.mjs`, `A packages/dsh-dots/dist/remote/lease.js`, `A .../leaseStore.js`.
- **Prompt (14 paths):** `M packages/dsh-dots/src/rpc.ts`, `M packages/dsh-dots/dist/rpc.js`, `A src/remote/{promptWording,promptGate,promptLedger,sessionPrompt}.ts` (4), `A dist/remote/{promptWording,promptGate,promptLedger,sessionPrompt}.js` (4), `A test/{prompt-gate,session-prompt-rpc,refusal-wording-parity}.test.mjs` (3 new), `M test/remote-readonly-rpc.test.mjs` (retarget). The brief's "4 tests" is true only if the retarget is counted; there are 3 *new* prompt tests.
- **Doc (1 path):** `A docs/REFUSAL-WORDING.md`.
- **Must NOT ride:** `M apps/arkui-schedule/AppScope/app.json5` and all already-committed review files.

## Residual risk & unverified
- **No delivery / no device:** production has no `DeliveryPort`; nothing is ever sent. No `hdc`/device run; real DSH session writes, cross-machine lease behaviour and real `sessionPrompt` RPC delivery are unverified.
- **Dark action:** only exercised via injected services and temp marker files; the real operator who writes `channel-verified.json` was not simulated.
- **Operator assertion not cryptographic:** marker possession is same-trust-domain assertion (`REFUSAL-WORDING.md:32`), not attestation; it also is not per-instance (Major 1).
- **Delivery-failure idempotency:** lease + ledger are recorded before `delivery.send()` (`sessionPrompt.ts:173-186`); a failing future port leaves the requestId consumed (`.tmp/review-b4-project.out`: 1 upsert + 1 record even when send throws). Harmless today (no port), CONCERN when a real port lands.
- **POSIX 0600** lease store test skipped on Windows; not verified here.
- Reviewer did not run an ArkTS build (none needed; forbidden), and no git writes.

## Evidence log
- Read-only git: status, `diff` (rpc/retarget), `numstat`, `hash-object`, `rev-parse HEAD:<path>`.
- Read-only pwsh/pwsh-run Node: marker-write scan, `Date.now`/console scans, gate captures above, independent fresh-tsc dist comparison.
- Drivers/mutants: `.tmp/review-b4-dark.mjs`/`.out`, `.tmp/review-b4-project.out`, `.tmp/review-b4-parity-mutants/{make.mjs,baseline.out,doc-cell.out,plugin-string.out,app-string.out}`.

## r2 delta

**MAJOR CLOSED.** — The r1 Major (marker not bound to instance) is fixed by construction: `channelVerified(instanceId: string)` (`src/remote/sessionPrompt.ts:85,126-144`) rejects non-string/blank ids before IO (`:128`), keeps the strict marker shape (`:132-141`), and compares `marker.instanceId === instanceId.trim()` exactly (`:143`); `send()` short-circuits at `:150` before instance/grant/lease/ledger/head/delivery. RPC passes the trimmed instance id and checks DARK before shape validation (`src/rpc.ts:127-129,1198-1202`). No survivor reached `delivery.send` with a non-matching instance.

### Driver matrix (`.tmp/review-b4-r2-dark.out`, rebuilt dist)
| Case | Result | Spies |
| --- | --- | --- |
| marker B / request A (r1 survivor) | `E_CHANNEL_UNVERIFIED` | all 0 |
| marker A / request A | `ok accepted=true` | all 1 |
| marker A / request A, grant denied | `E_GRANT_DENIED` | instance/grant/leaseLoad/ledgerLoad/head = 1; upsert/record/delivery = 0 |
| marker instance upper-case / whitespace-padded | `E_CHANNEL_UNVERIFIED` (shape invalid) | all 0 |
| request instance padded | `ok` after trim (intended normalization) | all 1 |
| marker with unrelated valid 64-hex leaf | `ok` — leaf not checked (deferred, below) | all 1 |
| marker file renamed away / is a directory | `E_CHANNEL_UNVERIFIED` | all 0 |
| request instance object / array / number / blank | `E_CHANNEL_UNVERIFIED` (no IO) | all 0 |
| success then marker removed | second call `E_CHANNEL_UNVERIFIED` | all 0 (no caching) |
| RPC malformed payload (`text:42`, `sessionId:[]`, missing id) | `E_CHANNEL_UNVERIFIED`; spy saw `['inst-a1…','inst-0011…','']` | DARK before shape validation |

### Canonical wording / order / regressions
Refusal still goes through `promptRefusal('channel.desktop.unverified')` → `PROMPT_WORDING` (`sessionPrompt.ts:103-105,150`), not a hand-written string; parity re-run 0 mismatch (`.tmp/review-b4-r2-parity.out`). Order remains channel → grant → text → lease → sha → idempotency → delivery (`promptGate.ts:69-127`), with O1–O8 unchanged. Plugin suite 816/814/0/2 (`packages/dsh-dots/.tmp/gates-session-prompt-r2.out`), targeted 37/37 (`packages/dsh-dots/.tmp/targeted-session-prompt-r2.out` — under the plugin `.tmp`, not repo root), dist freshness 74/0 (`packages/dsh-dots/.tmp/distcheck-session-prompt-r2.out`). Dist r2 window is exactly `dist/remote/sessionPrompt.js` (6,817 B) and `dist/rpc.js` (57,638 B); the other five dist files retain their r1 sizes/timestamps. Stage sets unchanged from r1.

### New Minor
1. **Leaf-binding deferral rationale is too absolute.** `src/remote/pairingPayload.ts:26-47,159-170` carries a per-instance `tlsFingerprint` with a normalizer (colon/case-insensitive 64-hex) and `pairingProvision.ts:284,475` derives it from the certificate — a plausible injectable source for comparing `marker.leafSha256` to the pairing leaf. Whether it is the *same* leaf the operator asserts is unverified, so deferral remains defensible; but "no injectable source" is not strictly true for the remote instance. Nit: the deferral id `mod-plugin-session-prompt-leaf-binding` has no occurrence anywhere in the repo, so it is not registered in `MODULES.md` as a deferred module.

### Residual (unchanged)
No delivery port, no device run, DARK only via injected services/temp markers, operator assertion not cryptographic, delivery-failure idempotency deferred, leaf binding deferred.
