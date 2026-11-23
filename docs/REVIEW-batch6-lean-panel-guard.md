# REVIEW — batch6 / `mod-plugin-lean-panel-guard`

Scope: one uncommitted test-only file, `packages/dsh-dots/test/lean-panel-guard.test.mjs`
(580 lines, 10 guards G1–G9 + G6a/G6b). Read-only review; no source / dist / device / GUI
touched. Reviewer independently re-ran the targeted test file into
`packages/dsh-dots/.tmp/review-lean-guard-targeted.out` (10/10 pass).

## Verdict

**CONDITIONAL PASS — 0 Majors.** The derived inventory is true, all ten guards are
mutation-sensitive (no vacuous guard found), G7 is honest about listener gating, credential
hygiene holds, and hygiene is clean. One **CONCERN is escalated to the Lead**: the lane
blesses the panel's 「测试连接」 button on the ground that it "writes no sync state", but the
`testConnection` RPC actually persists `reachable` to `state.json`; whether that violates the
user's "no manual sync / retry / test / status buttons" rule is a policy decision, not a test
defect. Three Minors (test-list duplication/drift risk, finite action denylist, transient-
failure attribution) do not block. No rendered pixels, device, or GUI were verified.

## Findings

### F1 — CONCERN (Lead decision; file:line below): 「测试连接」 policy tension

The lane's finding is **factually honest on two of three points**: the button is genuinely in
the shipped panel (`packages/dsh-dots/src/client.js:4465-4469`, `doTest` at `:4383-4402`), and
the pre-existing inventory guard genuinely pins it
(`packages/dsh-dots/test/client-lean-inventory.test.mjs:345-354`, exact 7-button set including
`测试连接`). G5 explicitly documents the carve-out
(`packages/dsh-dots/test/lean-panel-guard.test.mjs:410-412`) and only denies the git-sync
action set (`:404`, `:419-426`), so it is not silently hiding the button from scrutiny.

The **third point is imprecise**: the brief/G5 comment calls it a probe that "writes no sync
state" / "does not write `lastSyncAt`". The latter is true (`src/client.js:4396`; `doTest` calls
`testConnection` then read-only `getState` at `:4388`/`:4397`), but the RPC itself calls
`recordProbe(true/false)` on success/network failure
(`packages/dsh-dots/src/rpc.ts:473-491`, `:486`, `:489`), which writes `state.json.reachable`
(`src/rpc.ts:349-356`, `:384`). So a click **does** persist one piece of sync-adjacent state
(tri-state reachability), just not `lastSyncAt` and no push/fetch/apply/publish.

**My judgement (not a decision):** under a literal reading of the user's rule ("no manual sync
/ retry / **test** / status buttons"), this is a violation the guard blesses. Under a
purposive reading (the App removed three buttons that drive sync state in
`mod-sync-ui-silence` Phase B; the rule targets manual sync/retry/status *triggers*), a pure
connectivity probe with no pipeline mutation is defensible. Genuinely open — Lead decides:

- **Option A — keep as-is, document an explicit carve-out** in MODULES.md / the rule. Cost: the
  literal wording stays violated, plugin and App stay inconsistent, and the "writes no state"
  phrasing must be corrected to "writes only `reachable`, never `lastSyncAt`". Lowest churn.
- **Option B — remove the button** from `LeanSyncGroup` and retarget both the inventory guard
  (`client-lean-inventory.test.mjs:345-354`) and G5 (`:411`) plus G3's 403-via-`testConnection`
  branch (`:367-372`). Cost: touches an existing assertion the acceptance discipline says not
  to delete/loosen (retarget requires explicit approval), needs a source edit + dist rebuild in
  a different lane, and removes a useful offline diagnostic. Highest churn.
- **Option C — reword the policy to "no manual sync/retry/status controls that advance sync
  state"**, explicitly permitting a reachability probe. Cost: needs user/Lead sign-off on the
  wording; if rejected, rework reverts to B. No code churn.

### F2 — Minor: deliberate partial duplication of the inventory test

G4 re-declares the forbidden-label list verbatim and extends it
(`lean-panel-guard.test.mjs:380-385` vs `client-lean-inventory.test.mjs:312-315`); G2/G5/G8
re-assert exact input/button/clipboard sets already pinned at
`client-lean-inventory.test.mjs:325-354`, `:356-379`. No assertion is loosened, and the new
guards add distinct policy layers (per-group partition, trigger actions, conditional fields,
credential-source checks), so the file is not a redundant copy. Cost/risk: two copies drift;
if the inventory list changes, G4 silently keeps the old set. Consider importing the恒定 part
or adding a parity note. **Not a Major.**

### F3 — Minor: G5's sync-action denylist is finite

`SYNC_TRIGGER_ACTIONS` (`lean-panel-guard.test.mjs:404`) enumerates eight names. A regression
that keeps an existing button label but renames its RPC (e.g. `manualPush`, `triggerSync2`)
would evade the `:419-423` action check. Mitigation already present: the exact per-group label
sets at `:411-412` still fail any added/renamed button, and `probeFrom` at `:426` pins
`remoteProbe`. Residual gap is narrow (existing label + novel action name only). **Minor.**

### F4 — Minor: transient-failure explanation is credible but only circumstantial

Cross-check: targeted `packages/dsh-dots/.tmp/gates-lean-guard-targeted.out` = 10/10 (also
independently reproduced); full `…/gates-lean-guard.out` = 860 / 858 pass / 0 fail / 2 skipped;
first run `…/gates-lean-guard.first.out` = 860 / 856 pass / **2 fail** / 2 skipped, both in
`test/delivery-seam.test.mjs` (D5 `TypeError … reading 'code'` at `:197`; D10 boundary assertion
at `:247`); combined `.tmp/gates-planner-b9-batch6.out` = 4008 / 4006 pass / 0 fail / 2 skipped.
The two failures are outside this lane's file, and the passing reruns used the **same**
`lean-panel-guard.test.mjs` (mtime 16:36:19, earlier than both full runs), so they are credibly
external and transient. However, mtimes show the "other lane's dist rebuild" finished at
16:36:23 — ~63 s *before* the failing 16:37:26 run — while `delivery-seam.test.mjs` was itself
modified at 16:37:42, 16 s *after* that run, and its assertion line shifted (247 in the log vs
248 now). So the proximate cause was more likely that lane's in-flight test-file edit (and/or
freshly rebuilt dist modules it imports at `delivery-seam.test.mjs:10-20`), not a rebuild
literally overlapping the run. Conclusion "not this module, transient" holds; the precise
mechanism is unverified. **Minor / informational.**

## Checklist

| # | Item | Status | Evidence (file:line) |
|---|------|--------|----------------------|
| 1 | Exactly one `settings.section` registration | PASS | `packages/dsh-dots/src/client.js:4880-4893`; guard G1 `packages/dsh-dots/test/lean-panel-guard.test.mjs:300-313` (runtime + source counts) |
| 2 | `DotsPanel` renders exactly two `<details>` | PASS | `src/client.js:4827-4845` (`dots`, `dots-remote`); G4 `:389`, G9 `:579` |
| 3 | `LeanSyncGroup`: 2 always-on fields (text + password), read-only derived-login note, status row, exactly 2 buttons | PASS | `src/client.js:4296-4472` (inputs `:4414-4429`, derived note `:4432-4435`, status `:4455`, buttons `:4459-4469`); G2 `:318-334`, G5 `:411`; `Input` default `text` at `src/client.js:1580-1598` |
| 4 | Conditional login field only on auth failure (`E_AUTH`/401/403) via `leanIsAuthFailure`; collapses on success | PASS | `src/client.js:4244-4249`, set at `:4358`/`:4390`, reset `:4377`/`:4395`, render `:4432-4454`; G3 `:339-373` (real state transitions + E_NETWORK negative + regex branch) |
| 5 | `LeanRemoteGroup`: one mode `<select>`, zero inputs, five buttons; QR gated on running listener | PASS | `src/client.js:4484-4819` (select `:4736-4760`, no `Input`, buttons `:4781-4806`, QR/copy gate `:4778-4783`, running gate `:4566-4569`); G5 `:412`, G7 `:523-529` |
| 6 | No duplication of `client-lean-inventory.test.mjs` guards | PASS (F2) | inventory `:312-354`, `:356-379`; new file `:318-334`, `:406-427`, `:541-556` add policy-only assertions |
| 7 | All 10 guards mutation-sensitive; none vacuous | PASS | G1 `:300`, G2 `:318`, G3 `:339`, G4 `:378`, G5 `:406`, G6a `:432`, G6b `:489`, G7 `:513`, G8 `:541`, G9 `:561`; exact sets / byte identity / call order / real transitions throughout (F3 narrow gap) |
| 7a | Save-order + byte-unchanged refusal (G6a) | PASS | `src/rpc.ts` slice + index ordering `:433-442`; real service refusal `:454-483` (byte comparison at `:483`, probe count `:482`) |
| 7b | App save-order (G6b) | PASS (source-shape) | `apps/.../SettingsSync.ets` slice + ordering `:490-505`; `model/repoVisibility.ts` regex `:506-507` |
| 8 | 「测试连接」 policy tension | **CONCERN** | G5 carve-out `:404-412`, `:426`; `src/client.js:4383-4402`; `src/rpc.ts:473-491`, `:349-356`; inventory `:345-354` — Lead decision F1 |
| 9 | G7 zero-config pairing honest; no QR claim while stopped | PASS | G7 `:513-536`: empty settings + `running:true`; select/5 buttons/inputs `:523-529`; mount zero `pairingShow` `:530` / zero clipboard `:531`; explicit action `:534-535`. Shipped stop-gate at `src/client.js:4566-4569`, `:4778-4783` |
| 10 | No credential leakage in guard surface | PASS | G8 `:541-556`: tree/JSON token scan `:543-544`, exact compact clipboard `:545-548`, post-copy scan `:549`, no `console.*` in `src/client.js` (grep: 0 matches), `setShown({qr:…})` only at `src/client.js:4580` / `:4598-4605`; `QrMatrix` renders modules only `src/client.js:3430-3468` |
| 11 | Hygiene: only one file added by this lane; no product source/dist change | PASS | `git status --porcelain`: `?? packages/dsh-dots/test/lean-panel-guard.test.mjs`; `src/client.js` and `dist/client.js` unmodified. Other lanes' changes (`dist/remote/{promptWording,sessionPrompt}.js`, `delivery-seam.test.mjs`, refusal-wording tests) are not this module's |
| 12 | `dist/client.js` parity covered by existing test | PASS | `packages/dsh-dots/test/client-loader-id.test.mjs` — "client.js 与 dist/client.js 必须保持同一份内容", "dist/client.js 与 build.mjs 新鲜构建输出逐字节一致", "dist/client.js 只注册一个 settings.section"; all ✔ in `.tmp/gates-planner-b9-batch6.out` |
| 13 | Cross-check numbers + transient explanation | PASS (F4) | targeted 10/10 (reproduced at `packages/dsh-dots/.tmp/review-lean-guard-targeted.out`); full 860/858/0/2; first 860/856/2fail/2skip; combined 4008/4006/0/2 |

## Residual & unverified

- **Rendered pixels / GUI / device:** not inspected. All DOM-shape claims are source-level
  (React stub + source regex), per the file's own caveat at
  `packages/dsh-dots/test/lean-panel-guard.test.mjs:19`. `unverified`.
- **Mutation testing:** not executed by this reviewer (read-only rule forbids editing source).
  Sensitivity above is analytical reasoning from assertion shape; the lane's own prior
  mutation evidence is not attached to this file. `unverified`.
- **App runtime (G6b):** source-ordering only; no device/App execution. `unverified`.
- **Transient failure cause (F4):** attribution to external in-flight work is circumstantial
  (mtimes + stable passing reruns), not proven by timestamps or a captured rebuild log.
  `unverified`.
- **「测试连接」 compatibility with the user rule:** deliberately left to the Lead (F1).
  `unverified` — no policy sign-off exists in the reviewed surface.
- Not run: full plugin suite (already logged by the lane), any build script, git writes.
