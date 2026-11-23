# Review — batch 10: `mod-plugin-session-prompt-transport`

Baseline `ba4fe08` · reviewer `planner-b9/review-b10` · read-only · 2026-11-23

## Verdict

**CONDITIONAL PASS — 0 Major, 1 Minor, 3 Concerns.** All five Lead rulings are implemented in code, not merely paraphrased; the DARK/error-map/idempotency/honesty seams hold under adversarial probing. The one copy defect I was asked to judge — `E_HEAD_MOVED` blaming "其他人" when our own earlier write moved the head — is a **Minor**, not a Major: the safety instruction (refresh before re-confirming) is correct and no false success/atomicity claim is made, but the attribution is false in the very case this policy handles. Minimal fix below. Residual concerns are doc staleness (`SESSION-PROMPT-TRANSPORT.md` still describes the pre-implementation state) and the out-of-scope `app.json5` version bump that must not ride the commit.

## Findings

### Minor — M1: `E_HEAD_MOVED` copy misattributes a self-inflicted head move
`src/remote/sessionPrompt.ts:29-31` and `:334-340` state explicitly that the head moved because **our own earlier successful write** ("我们自己上一次写入已经移动了 head"), yet the emitted wording is `LEASE_WORDING.E_HEAD_MOVED` = 「会话已被其他人写入，请先刷新再重新确认」 (`src/remote/lease.ts:38`, `docs/REFUSAL-WORDING.md:22`). An operator is told a third party wrote the session when in fact the plugin did. Confirmed empirically: `E_HEAD_MOVED` is the code returned for a new `requestId` after a recorded success (T5; probe). Not Major because the actionable half (刷新再重新确认) is correct, no blind-retry is invited, and no false "delivered/not-delivered/atomic" claim is made.

**Minimal fix (judgement):** neutral reword of the **existing** row, no new row, no new code — e.g. 「会话头已变化（可能是本机上一次写入），请先刷新再重新确认」 (or simply 「会话头已变化，请先刷新再重新确认」). Keep code `E_HEAD_MOVED`, keep the 19-row table. This is honest for both producers of the row: the genuine `decidePromptWrite` head mismatch (`src/remote/lease.ts:410-414`) and the self-write retry path (`src/remote/sessionPrompt.ts:336-341`). A dedicated new code (e.g. `E_SESSION_RETRY_NEEDS_REFRESH`) would be more precise but adds a 20th row (breaks ruling 4), a new semantic key and extra wiring — **not minimal**. Touch points for the reword: `src/remote/lease.ts:38`, `dist/remote/lease.js:26`, `docs/REFUSAL-WORDING.md:22`, and the hardcoded mirror `test/lease-state.test.mjs:426`. Caveat: this expands the current five-file `dist/` window by `dist/remote/lease.js` and adds one source + one test file — do it in a fresh single build window and re-run dist-freshness/parity. `docs/MODULES.md:196` already carries a reconciliation marker for exactly this review; update it when the fix lands.

### Concern — C1: `SESSION-PROMPT-TRANSPORT.md` still describes the pre-implementation state
The `seq` removal was applied correctly (`docs/SESSION-PROMPT-TRANSPORT.md:9,40,64`; no verified count inflated — C20's status is unchanged), but two earlier statements were not retired:
- `:29` still says, in present tense, that delivery failure copy is `已尝试投递但失败（会话未写入），可用同一请求号重试`; the shipped copy is the exact ruling-4 text (`:26` of REFUSAL-WORDING, `src/remote/promptWording.ts:82`). Line 29 frames it as a rejected/Lead-decision option, so no shipped value asserts 会话未写入, but an operator reading the design doc can be misled.
- `:33` and ledger row `C25` (`:69`) still say "no head re-check exists in the current service" and cite stale line numbers; the implementation now re-reads the head and records drift (`src/remote/sessionPrompt.ts:394-405`). C1/C21/C24 line references (`:46,65,68`) are likewise stale against the 426-line module.

Recommend a small doc-only follow-up pass (status tags unchanged) so the design record matches the code. No code/contract defect.

### Concern — C2: `AppScope/app.json5` out-of-scope modification present in the tree
`apps/arkui-schedule/AppScope/app.json5:5` is modified (`versionCode 1000009 → 1000012`). It is unrelated to this plugin batch and appears to be a pre-existing version bump (the prior batch review already carried the same "must not ride" note). It must be excluded from any staging/commit of this batch. No source edit by this reviewer.

### Concern — C3: no-CAS limitation not stated at the wording's own row
The no-CAS / cannot-prevent / no-atomicity limitation is stated where the behavior is emitted (`src/remote/sessionPrompt.ts:12-13`, `docs/MODULES.md:194`) and in design doc `:33` / C26 (`:70`), and is asserted negatively by T7 (`test/session-controller-transport.test.mjs:193`). It is **not** adjacent to the `E_HEAD_MOVED` wording itself (`docs/REFUSAL-WORDING.md:22`, `src/remote/lease.ts:33-39`), and note `:32` covers only the three `session.*` codes. Suggest folding a short no-CAS note into the M1 reword so the copy's own row carries the limitation.

## Checklist

### Lead rulings
| # | Ruling | Result | Evidence |
|---|---|---|---|
| 1 | In-process `ctx.sessionController.prompt` only; no JSON-RPC mirror, no second network face | **PASS** | `src/remote/sessionPrompt.ts:105-115,128-159` typed in-process port calling `controller.prompt()` directly (`:144-149`); lazy wiring `src/index.ts:66-69,175` and `src/rpc.ts:164-168,246-252`; no new wire action beyond existing `sessionPrompt` (`src/rpc.ts:1319-1320`); design doc `:13` records SDK JSON-RPC face as "not selected" |
| 2 | `{accepted,payloadSha256}`; `seq` gone; ours-only hash; no fabricated DSH value; no consumer | **PASS** | contract `:73-77`, projection `:259-264`, hash of exact delivered text `:141`; RPC pass-through `src/rpc.ts:1212-1235`; modified tests `test/delivery-seam.test.mjs:44,157-163`, `test/session-prompt-rpc.test.mjs:84-85,197-203`, `test/channel-leaf-binding.test.mjs:107`, T1/T2 T4 `:105-118`; hash documented as not-a-DSH-field `docs/SESSION-PROMPT-TRANSPORT.md:9,64`; no App consumer found (grep: only comments/tests mention `sessionPrompt`/`payloadSha256` under `apps/`) |
| 3 | Retries reuse `requestId`; ledger answers "delivered?" without prompt text; still `unverified` | **PASS** | record-on-success `:365,407-419`; `seenInWindow`/`recordSeen` `src/remote/promptLedger.ts:200-236`; T4 reuses id with `prompt==2` and one ledger row `:147-157`; T7 `'text' in row === false` `:192`; live claim still unverified `docs/SESSION-PROMPT-TRANSPORT.md:59,73`, `docs/MODULES.md:194,530` |
| 4 | Exact delivery-failure copy; no 会话未写入; dedupe half pending live proof; 19 rows | **PASS (with C1/C3 doc caveats)** | `src/remote/promptWording.ts:82` byte-identical to `docs/REFUSAL-WORDING.md:26` (docs gate confirms byte equality); doc note `:32` marks dedupe half pending; 19 data rows confirmed (`:9-27`, `:46`, gate `RESULT: ALL PASS`) |
| 5 | Always `mode:'queue'`; post-call head drift recorded; no atomicity claim | **PASS** | `:147` fixed queue + no timer, T1 asserts `mode==='queue'` `:116`; post-call re-read + `headDrift` `:394-405`, T7 `:183-193`; explicit no-CAS/no-atomicity `:12-13`, `docs/MODULES.md:194`; no atomicity assertion found in shipped copy (T7 negative assertion) |

### A — Dark unchanged
| Check | Result | Evidence |
|---|---|---|
| Marker absent ⇒ `E_CHANNEL_UNVERIFIED` before lookup/call, no ledger file | **PASS** | gate short-circuit `src/rpc.ts:1215-1222` + `src/remote/sessionPrompt.ts:321-325`; T8 spy lookup=0, prompt=0, ledgerRecord=0, file absent `:198-206` |
| Service absent ⇒ `E_SESSION_UNAVAILABLE`, prompt=0 | **PASS** | lazy lookup null branch `:131-139`; T9 lookup=1/prompt=0 `:210-218` |
| No silent fallback on throwing lookup | **PASS** | `try/catch` at `:132-136` maps throw → `E_SESSION_UNAVAILABLE`; PROBE-A passed (throwing lookup → typed UNAVAILABLE, no crash). `index.ts:175` is a plain optional-property read |

### B — Error mapping
| Check | Result | Evidence |
|---|---|---|
| `session/not-found`, `session/agent-busy`, `gateway/internal`, abort, unknown throw, malformed `{accepted}` ⇒ `E_SESSION_DELIVERY_FAILED` | **PASS** | catch-all at `:150-157`; seven T2/T3 cases `:123-143` (all pass); service-level re-map `:381-392`; PROBE-A/B paths green |
| None can become success | **PASS** | `projectDelivery` `:259-264` + `if (!result.accepted)` `:392`; failing tests assert `res.ok===false` |
| `E_SESSION_RECORD_FAILED` distinct | **PASS** | `:408-418` preserves the typed SyncError, T6 `:173-179` |

### C — Idempotency honesty
| Check | Result | Evidence |
|---|---|---|
| `E_HEAD_MOVED` copy honest when we wrote the head | **CONCERN → Minor M1** | false "其他人" attribution at `src/remote/lease.ts:38` / `docs/REFUSAL-WORDING.md:22`, used at `src/remote/sessionPrompt.ts:340`; judgement + minimal fix above |
| Ledger still answers "delivered?" without prompt text | **PASS** | `src/remote/promptLedger.ts:200-236`; T7 `'text' in row === false` `:192`; PROBE-E confirms new meta fields round-trip and no text |
| T5 proves what it claims (controller called exactly once) | **PASS (naming nit)** | T5 `:161-169` asserts `s.calls.prompt === 1` after two requests, i.e. the rejected new-id request adds zero calls. The name's parenthetical "控制器零调用" reads as total-zero; the assertion message "第二个 requestId 根本不委托给 DSH" is the accurate reading. Nit only; no false proof |

### D — Head drift
| Check | Result | Evidence |
|---|---|---|
| Post-call re-read recorded as drift in ledger | **PASS** | `:394-405` + meta `:409-413`; T7 `headDrift===true`, `observedHeadSha===OTHER_SHA` `:189-191` |
| No atomicity/prevention implication in code/copy | **PASS** | `:12-13` explicit "没有 CAS … 不能阻止"; no atomicity in copy (T7 negative check `:193`); `promptLedger.ts:8` "原子写" refers to local file write only |
| Lease no-CAS limitation stated where the copy lives | **CONCERN → C3** | stated in emitting module `src/remote/sessionPrompt.ts:12-13` and design doc `:33`/C26, but not at `docs/REFUSAL-WORDING.md:22` / `src/remote/lease.ts:33-39` |

### E — Ledger
| Check | Result | Evidence |
|---|---|---|
| Optional fields are hashes/booleans/heads, never prompt text | **PASS** | `src/remote/promptLedger.ts:13-27,98,113-130`; flatten whitelist `:138-161` |
| Strict normalisation fail-closed | **PASS** | unknown-field + bad-type branches `:99-130`; PROBE-E rejects bad `payloadSha256`/`headDrift`/`observedHeadSha` types |
| Round-trip tested; old shape decodes | **PASS** | new fields: T7 via real store `:188-192` + PROBE-E; old shape: `test/prompt-gate.test.mjs:233-241` (I4 old-shape encode/decode) + PROBE-E |

### F — Offline/online honesty boundary
| Check | Result | Evidence |
|---|---|---|
| Tests do not imply DSH dedupe was proved | **PASS** | T4 name/assertions are about local ledger row count and calling the controller twice `:147-157`; T5 explicit local policy `:161-169`; no test named as proving DSH dedupe |
| Design doc updated for `seq` removal without inflating verified count | **PASS** | `:9,40,64` updated; C20 status unchanged; verified/unverified ledger `:44-74` untouched otherwise; "design only / no runtime claim" still at `:4` |
| Report's "exactly once not provable offline" preserved | **PASS** | `docs/MODULES.md:194,530` verbatim boundary; unverified tags intact in design doc |

### G — Hygiene
| Check | Result | Evidence |
|---|---|---|
| No app changes for this batch; no ArkTS build expected | **CONCERN → C2** | only out-of-scope `apps/arkui-schedule/AppScope/app.json5:5` version bump present; no other `apps/**` change in `git status`; no build artifact created by this review |
| Plugin `dist` window exactly 5 files, not `client.js` | **PASS** | `git status --short`: only `dist/index.js`, `dist/rpc.js`, `dist/remote/{sessionPrompt,promptWording,promptLedger}.js`; `distcheck-transport.out`: `DIST-FRESHNESS: 74 files, 0 mismatch`, `DIST-EXTRA-FILES: client.js` (copy, unmodified) |
| `client.js` ↔ `dist/client.js` parity green | **PASS** | `test/client-loader-id.test.mjs` green in targeted run (69/69 across 5 files); build script template rule `scripts/build.mjs:24-42,51` |
| Suite gate numbers | **PASS** | combined `dsh-sync-suite\.tmp\gates-planner-b9-batch10.out` absent (docs gate explicitly does not use it); `packages\dsh-dots\.tmp\gates-transport.out`: **868 tests / 866 pass / 0 fail / 2 skipped**; new file `targeted-transport-new.out`: **14/14**; `targeted-transport.out`: **64/64** |
| `AppScope\app.json5` must not ride | **CONCERN → C2** | same as above — pending exclusion at staging |
| No `~\.dsh\...\**` writes, no device, no DSH restart | **PASS** | reviewer touched only `.tmp/review-b10-probe.test.mjs`, `.tmp/` logs, and this review file |

### Verification runs (3 targeted `node --test`, as permitted)
1. `packages/dsh-dots`: `node --test test/session-controller-transport.test.mjs` → **14/14 pass**.
2. `packages/dsh-dots`: `node --test test/prompt-gate.test.mjs test/delivery-seam.test.mjs test/session-prompt-rpc.test.mjs test/channel-leaf-binding.test.mjs test/client-loader-id.test.mjs` → **69/69 pass**.
3. repo root: `node --test .tmp/review-b10-probe.test.mjs` → 2 pass, 1 fail. **The failure is my probe's own assertion bug**: it checked `err.wording` but `new SyncError(code, message, …)` (`src/engine/errors.ts:35-39`) puts the copy in `err.message`. The important assertions *before* it passed — `err.code === 'E_HEAD_MOVED'` on a new request id, throwing lookup → `E_SESSION_UNAVAILABLE` (PROBE-A), strict ledger fail-closed + old-shape decode (PROBE-E). The exact `E_HEAD_MOVED` message is confirmed statically at `src/remote/lease.ts:38` via `src/remote/sessionPrompt.ts:340`; I did not spend a fourth run on the corrected assertion.

## Residual & unverified

- **Live DSH, all of it:** whether `ctx.sessionController` is actually mounted in the running profile (`SESSION-PROMPT-TRANSPORT.md:59`, C14); whether DSH's `requestId` dedupe behaves as typed (`:57`, C12); that a real `user/message` event and turn occur (`:37-41`); that the head reader reflects the real DSH head (`:74`, C30); installed `@deepseek-ai` package version (`:63`, C18); no undo/delete path beyond readable types (`:71`, C27). None upgraded in code or docs.
- **"Delivered exactly once" is not provable offline** — only one controller call per successful send and same-id retry are locally provable. No test claims otherwise.
- **Record-on-success window**: delivered-but-unrecorded cannot converge automatically; surfaced as `E_SESSION_RECORD_FAILED` (`:407-418`), not silently swallowed.
- **M1 copy fix not applied here** (read-only review); needs the neutral reword and a re-run of dist-freshness/parity if accepted.
- **C1 doc staleness and C2 app.json5 exclusion** remain for the Lead to action before commit.
- No device, no live session, no ArkTS build, no DSH restart were performed by this reviewer.
