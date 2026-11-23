# Review — mod-plugin-session-prompt-delivery

Independent read-only review of the uncommitted `mod-plugin-session-prompt-delivery` module on top
of `399e8c2`. Sources were read only; no git writes, no device/profile/ArkTS access, no
`scripts/build.mjs`. The reviewer wrote only this file and evidence/log files under
`packages/dsh-dots/.tmp/`. Line references are to the working tree under review.

## Verdict

**PASS — the refusal/attempt boundary, failure taxonomy, record-on-success contract, wording
parity and dist window all hold under independent re-derivation. The known delivered-but-unrecorded
window is real but explicitly disclosed as an accepted risk. Major findings remaining: 0**

Confirmed module stage: **8 modified paths** (`src/remote/sessionPrompt.ts`,
`src/remote/promptWording.ts`, `docs/REFUSAL-WORDING.md`, the three touched `test/*.test.mjs`, and
the two `dist/remote/*.js`) **+ 1 added path** (`test/delivery-seam.test.mjs`). The brief's "8 paths"
matches the 8 `M` entries; the added test is the 9th.

## Findings

### Blocker

None. No engine, RPC, lease-store, ledger-store, grant or pairing source was changed; the touched
surface is the delivery seam, wording tables, doc join and their tests.

### Major

None. The item-3 retry question deserves an explicit answer because it could have been a Major:

**The `E_SESSION_RECORD_FAILED` retry DOES re-deliver (double-write risk), and this is documented as
the accepted risk — not a Major.** Independent two-run drive (`.tmp/review-b6-verify.out`, section
C): first run `port=1, record=1, ledgerRows=0, code=E_SESSION_RECORD_FAILED`; second run with the
same `requestId` `port=2, record=2`, i.e. the session receives the prompt a second time, because
record-on-success left no ledger row to dedupe against. This follows directly from
`packages/dsh-dots/src/remote/sessionPrompt.ts:309-316` (record happens after `delivery.send`) and
`:280-284` (requestId deliberately not written before delivery). It is disclosed verbatim in the
module header at `src/remote/sessionPrompt.ts:7-11` — "已投递成功但账本写失败这个窗口无法靠重放
自动收敛…明确要求先刷新会话确认、勿盲目重发…账本写失败时绝不假定「没写入」，这是有意保留的
诚实警告" — and in the doc at `docs/REFUSAL-WORDING.md:32` ("recordFailed = 投递成功但记录失败…
须先刷新确认，勿盲目重发"), and the typed wording carries the same instruction
(`src/remote/promptWording.ts:83`). The contract never reports success for this state and never
claims the retry is safe; the risk is visible to the caller in-band. Rated accepted/documented,
not a silent regression.

### Minor

- **m1 — the accepted record-failure risk is documented but not machine-enforced.**
  `src/remote/sessionPrompt.ts:309-316` returns `E_SESSION_RECORD_FAILED` and relies entirely on the
  caller honouring "勿盲目重发"; there is no in-band marker (tombstone / poisoned requestId) that
  would turn an automated blind retry into a guarded or no-op outcome. The measured retry re-delivers
  twice (`.tmp/review-b6-verify.out`, section C; predecessor driver
  `packages/dsh-dots/.tmp/review-b6-delivery.out` shows the same `port=2` shape). Acceptable given
  the explicit header disclosure, but the designer should ensure the consumer of this code does not
  auto-retry on non-success codes. No consumer file is in this module's stage, so this is a
  cross-layer integration note, not a defect here.
- **m2 — an uncommitted app-file change exists outside this module's stage.**
  `git status --short` shows `apps/arkui-schedule/AppScope/app.json5` modified
  (`versionCode 1000009 → 1000011`). It is not one of the 9 module paths and is not referenced by
  the other uncommitted module's test (`test/lean-panel-guard.test.mjs` has no `app.json5` /
  `versionCode` match). Its attribution is unverified; it must be attributed before staging so the
  "no app file touched" claim for this batch stays true at commit time. This does not change any
  verdict for the delivery module itself.

### Nit

- **n1 — stale test title.** `test/refusal-wording-parity.test.mjs:103` still says "16 行" while the
  assertion at `:108` correctly pins `19`. Cosmetic only; the guard itself is correct.
- **n2 — predecessor driver artefact, not a product defect.** `packages/dsh-dots/.tmp/review-b6-delivery.mjs`
  used `opts.behavior ?? SUCCESS` (`:19`), so the `[null]` case actually ran with SUCCESS and printed
  `ok=true`; it overwrote the public `svc.channelState` (`:54-56`) while `send()` calls the closed-over
  internal function (`src/remote/sessionPrompt.ts:246`), so `[channel-leaf-mismatch]` printed `ok=true`;
  and it called `svc.send` directly, bypassing `dist/rpc.js:979-984`'s empty-requestId `E_VALIDATION`,
  so `[empty-request-id]` printed `ok=true`. All three were re-derived correctly against the public
  surface (checks 1–3 below). No source change is implied.

## Checklist

1. **Refusal vs attempt — PASS (all eight, independently re-derived).** Drove `rpc.handleRpc` for
   every D0 case through the shipped `dist`; each returned the expected typed code with
   `port=0, record=0` and no prompt/owner leak:
   `channel.desktop.unverified` → `E_CHANNEL_UNVERIFIED` (`src/remote/sessionPrompt.ts:246-248`);
   `channel.desktop.leafMismatch` → `E_CHANNEL_LEAF_MISMATCH` (`:247`);
   `prompt.grant.denied` → `E_GRANT_DENIED` (`promptGate.js:29-30`); `prompt.text.empty` →
   `E_VALIDATION` (`promptGate.js:32-34`); `E_LEASE_OBSERVING` → `E_LEASE_OBSERVING`
   (`promptGate.js:48-50`); `E_HEAD_MOVED` → `E_HEAD_MOVED` (`promptGate.js:64-68`);
   `prompt.duplicate` → `E_PROMPT_DUPLICATE` (`promptGate.js:69-73`); no-port →
   `E_SESSION_UNAVAILABLE` (`promptGate.js:74-76`, double-check at
   `src/remote/sessionPrompt.ts:283-284`). Test mirror: `test/delivery-seam.test.mjs:127-153`.

2. **Failure taxonomy is airtight — PASS.** `src/remote/sessionPrompt.ts:286-305`: the `send` call is
   wrapped in `try/catch ⇒ deliveryFailed`; any outcome that is not `null`-free object with
   `ok === true` falls through to `code === 'E_SESSION_UNAVAILABLE' ? unavailable : deliveryFailed`;
   `projectDelivery` (`:184-189`) rejects malformed `seq`/`sha256` via `accepted=false ⇒
   deliveryFailed` (`:306-307`). Re-derived through `rpc.handleRpc`: `ok:false`+DELIVERY_FAILED →
   `E_SESSION_DELIVERY_FAILED`; `ok:false`+UNAVAILABLE → `E_SESSION_UNAVAILABLE`; unknown code,
   real `null`, real `undefined`, `{}`, `{ok:true}` (no `seq`) and a throwing port → all
   `E_SESSION_DELIVERY_FAILED`, none `ok=true`. This **refutes** the predecessor's `[null] ok=true`
   line and confirms the designer's null-port drive (`.tmp/drive-planner-b9-null-port.out`).
   The default production port also refuses `E_SESSION_UNAVAILABLE` with zero ledger writes
   (`.tmp/drive-planner-b9-noport.out`, re-derived `port=1, record=0` through the wrapper).
   Port `reason` is never copied to the error: `refusal()` (`:176-182`) uses only `promptRefusal`.

3. **Record-on-success / dangerous window — PASS.** First `deliveryFailed` leaves the ledger empty
   and the same `requestId` retries successfully (`port=2, ledgerRows=1`); a success followed by the
   same `requestId` gives `E_PROMPT_DUPLICATE` with `port=1`; ledger `record` returning `{ok:false}`
   or throwing both converge to `E_SESSION_RECORD_FAILED` (`src/remote/sessionPrompt.ts:309-316`),
   with `record=1`, `ledgerRows=0`, and no prompt/owner in the message. Retry-after-record-failure
   re-delivers (`port=2`) — see Major section for the documented-risk ruling. Test mirror:
   `test/delivery-seam.test.mjs:204-240`; 10-minute/session-bucket behaviour at `:242-253`.

4. **No prompt/owner leakage — PASS.** No `console.*` in either touched `src/remote` file or in
   `dist/remote/{sessionPrompt,promptWording}.js` (grep zero hits). `createUnavailableDeliveryPort`
   (`:82-88`) never reads the request; its `reason` is the fixed literal `未接入投递通道`. The success
   projection is a three-field whitelist (`:184-189`); typed messages come only from
   `PROMPT_WORDING` (`src/remote/promptWording.ts:73-84`). The independent drive monkeypatched
   `console.log/warn/error/info/debug` around every call and scanned response + captured console:
   `leak=false` on all 21 driven cases. `test/delivery-seam.test.mjs` uses a canary prompt
   (`SECRET-PROMPT-BODY-DO-NOT-ECHO`) and asserts it absent from every response (`:157-234`);
   `test/session-prompt-rpc.test.mjs:197-210` additionally tests a port that returns extra
   `text`/`leaseOwner` fields. Both new wordings pass the wording hygiene regex
   (`test/refusal-wording-parity.test.mjs:141-147`).

5. **Doc + parity — PASS.** `docs/REFUSAL-WORDING.md` has exactly **19** data rows (`:9-27`), with
   `session.deliveryFailed` (`:26`) and `session.recordFailed` (`:27`) added immediately after the
   pre-existing `session.unavailable` (`:25`); their Chinese text is byte-equal to
   `src/remote/promptWording.ts:82-83`. The three-way note is present at `:32` and states the exact
   distinction (unavailable = not attempted / deliveryFailed = attempted and failed /
   recordFailed = delivered but unrecorded, do not blind-retry). `PROMPT_ERROR_CODES` has the two new
   codes (`src/remote/promptWording.ts:32-34`), and `PROMPT_CODE_BY_KEY` maps both new keys
   (`:68-69`). Parity test asserts 19 rows and the full key set
   (`test/refusal-wording-parity.test.mjs:26-46`, `:108-109`) and pins plugin code/key/wording at
   `:123-136`. Mutation proof on isolated `.tmp` shadow copies (repo untouched): baseline
   `EXIT=0, 0 mismatch, 19 rows`; doc wording mutation `EXIT=1, 2 mismatches`; plugin-table wording
   mutation `EXIT=1, 2 mismatches`; App `COMMAND_WORDING` mutation `EXIT=1, 2 mismatches`; doc row
   removed `EXIT=1, 4 mismatches, 18 rows`.

6. **Scope / hygiene — CONCERN (m2 only).** `git diff --stat` over the module shows exactly the 8
   modified paths; `dist/rpc.js` is byte-unchanged (`git status --short -- .../dist/rpc.js` empty),
   so the dist window is exactly `promptWording.js` + `sessionPrompt.js`. No `.tmp-*` directory at
   the repo root or package root. No arkts build or `scripts/build.mjs` was invoked. The only hygiene
   blemish is the out-of-stage `app.json5` version bump (m2); attribution is pending, not a module
   defect. Captured dist check: `74 files, 0 mismatch`; fresh `tsc` exit 0
   (`packages/dsh-dots/.tmp/distcheck-delivery.out`, `tsc-delivery.out`).

7. **Gates — PASS.** Captured evidence is consistent and was spot-re-derived: plugin suite
   `860/858 pass/0 fail/2 skip` (`packages/dsh-dots/.tmp/gates-delivery.out`); targeted `55/55`
   (`targeted-delivery.out`); combined `4008/4006 pass/0 fail/2 skip`
   (`.tmp/gates-planner-b9-batch6.out`). Re-ran the four delivery-relevant test files directly:
   `delivery-seam 18/18`, `channel-leaf-binding 9/9`, `refusal-wording-parity 1/1`,
   `session-prompt-rpc 14/14` — 42/42, exit 0 each. (Note: the added file has **18** tests — D0×8
   plus D1–D10 — not 10 as the brief's parenthetical says; no test was removed to reach that count.)

8. **Predecessor evidence cross-check — PASS.** The ambiguous `[null]` line was a `??` harness bug
   (n2), not a product result; real `null` refuses `E_SESSION_DELIVERY_FAILED`. The designer's three
   drives were all reproduced: failed-then-retry records once and the third call is a duplicate;
   no-port/default port refuse with no ledger; all malformed outcomes refuse. `leak=false` on every
   case was independently confirmed with a console-capturing spy.

## Residual risk & unverified

- **No real DSH session transport exists.** `createUnavailableDeliveryPort` is the production
  default; success paths were exercised only through injected fake ports. Whether a future real
  port honours the `DeliveryOutcome` contract (notably not echoing prompt into `sha256`, which
  `projectDelivery` copies verbatim at `src/remote/sessionPrompt.ts:186-187`) is unverified.
- **Callers of `E_SESSION_RECORD_FAILED` were not reviewed.** The double-delivery on blind retry is
  confirmed and documented here (Major section / m1), but no real consumer was inspected to confirm
  it stops instead of retrying; that integration check is out of this module's stage and is
  `unverified`.
- **Full plugin suite / tsc / dist freshness were not re-run end-to-end by this reviewer**; the
  captured `.tmp` outputs were read and the four targeted test files plus the parity mutation matrix
  were re-run. The full-suite numbers above are inherited evidence, not a fresh execution here.
- **`app.json5` attribution (m2) is unverified**; no blame/inspection of other sessions was done.
- **Live/device behaviour, ArkTS panel rendering and `~/.dsh/**` state were not touched** by this
  review, by design. The 2 skips in the full suite were not individually named.
- The driver `packages/dsh-dots/.tmp/review-b6-verify.mjs` and its output
  `.tmp/review-b6-verify.out` are the only evidence files written by this reviewer; the shadow
  parity tree under `.tmp/parity-shadow` was created, exercised and removed within the same run.

## Evidence log

- `git status --short`, `git diff --stat`, `git diff -- apps/arkui-schedule/AppScope/app.json5` in
  `dsh-sync-suite`: 9 module paths + 2 out-of-stage paths; `versionCode 1000009 → 1000011`;
  `dist/rpc.js` absent from status; no root `.tmp-*`.
- Independent public-surface driver `packages/dsh-dots/.tmp/review-b6-verify.mjs` →
  `packages/dsh-dots/.tmp/review-b6-verify.out`: section A (8 refusals, `port=0`), section B
  (8 outcomes + default port, none `ok=true`), section C (record-on-success, duplicate,
  record-failed ×2 with retries showing `port=2`), all `leak=false`.
- Parity mutation proof on `.tmp/parity-shadow` copies: baseline and four mutations with exit codes
  and mismatch counts recorded in check 5; shadow removed afterwards.
- Direct re-run of `node --test` on the four delivery test files: 18/9/1/14 pass, 0 fail, exit 0.
- Sources read in full: `src/remote/sessionPrompt.ts`, `src/remote/promptWording.ts`,
  `dist/remote/{sessionPrompt,promptWording,promptGate,rpc}.js`,
  `test/{delivery-seam,refusal-wording-parity,session-prompt-rpc,channel-leaf-binding}.test.mjs`,
  `docs/REFUSAL-WORDING.md`, plus the predecessor driver and its output and the three designer
  drive logs.
