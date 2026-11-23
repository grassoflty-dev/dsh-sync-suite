# Independent read-only review — batch 9 (grant vocabulary parity + session-prompt transport design)

- Baseline: `ed65ac1` (HEAD); reviewed working-tree diff only. No source edits, no builds, no git writes, no device, no `~\.dsh\...` writes.
- Evidence written only here and under `.tmp\` (including mutated parity copies under `.tmp\review-b9-parity2\`).
- Method: source read + 3 targeted `node --test` invocations (one of which bundled four test files).

## Verdict

**PASS with one non-behavioural hygiene CONCERN. No Majors.**

The App vocabulary is now byte-for-byte aligned with the plugin's canonical 10-tool table, the composer's send authority was *not* widened (the only functional edit is the import/call switch to the narrow `isPromptTool`), the retired-tool migration is fail-closed and visibly typed (never silently widened or silently dropped), the parity gate was proven to exit non-zero on a divergent table, and all five spot-checked design-doc claims match the cited installed DSH definitions. The single concern is that `AppScope/app.json5` rode into the batch with a versionCode bump, contrary to the stated hygiene criterion.

## Findings

### F1 — CONCERN (hygiene): `app.json5` rode with a version bump
`apps/arkui-schedule/AppScope/app.json5:5` changes `versionCode: 1000009 → 1000011` (the last commit touching this file, `55595dd`, carried 1000009; 1000011 is uncommitted). This contradicts the criterion "only the two modules' files + the doc are new/changed". The change is metadata-only — no logic, no vocabulary, no gate — and `.tmp\build-1000011.out` / `.tmp\build-mod-app-1000011.log` show it was used for the artifact build, so there is no behaviour or security impact. Recommendation: revert this hunk before final commit, or record the bump explicitly in the batch manifest. Not a Major.

### F2 — Accepted trade-off (migration semantic), not a finding
Whole-envelope fail-closed on a stored `session.read` renders *all* grants inert, including otherwise-valid rows in the same envelope. That is a real usability cost, but it is the honest choice here: (a) it never maps the retired id to `session.info`/`session.events` (which would silently widen view authority); (b) it never silently drops the bad row into an otherwise-active table; (c) the failure is visible — `decodeGrants()` returns `problem:'E_GRANT_TOOL_RETIRED'`, `problemText()` names `session.read`, `instanceGrantStore.ets:86` propagates `this.problem = decoded.problem`, `lastProblem()` (`:111-115`) exposes it, and `DotsPane.ets:102-106` renders the Chinese reason inline. Valid envelopes are byte-identical (E-09). Verdict: acceptable; a partial-row drop would have been less disruptive but would hide a corrupted authorization table. Per the judge rule, not a Major (nothing silently widens or silently drops).

## Checklist (PASS / CONCERN / FAIL)

1. **Vocabulary parity exact — PASS.** `instanceGrant.ts:49-59` (GrantTool union), `:61-73` (10 constants), `:82-97` (VIEW/COMMAND), `:103-114` (ALL, canonical order) vs `packages/dsh-dots/src/remote/grants.ts:32-43,45-55,58-75`. Both are `[instance.list, instance.inspect, session.list, session.info, session.events] | [session.prompt, session.create, session.lease.claim, session.lease.heartbeat, session.lease.release]`; no extra/missing ids, same order, same view/command classification. `session.read` is gone from the App vocabulary and survives only as the legacy marker `LEGACY_TOOL_SESSION_READ` (`:79`) / `isRetiredTool()` (`:161-163`). Plugin side genuinely unchanged: `git status` shows no `packages/**` or `dist/**` modification; `grants.ts` has no retired id, no `E_GRANT_TOOL_RETIRED`, no `isPromptTool`.

2. **No authority widening — PASS.** `isCommandTool` now covers all 5 mutating tools (`instanceGrant.ts:140-146`, asserted by `instanceGrant.test.mjs` T-02/G-10); the composer uses the narrow `isPromptTool` (`:148-158`, `PROMPT_TOOLS` at `:100`). `remoteCommandGate.ts` diff is two comment lines + the import (`:13-15`) and one call (`:102`); decision order (`:94-126`) and `COMMAND_WORDING` (`:43-52`) are untouched — behaviour-preserving. Gate still refuses `session.create` and all three `session.lease.*` with `E_COMMAND_TOOL_NOT_ALLOWED` and accepts only `session.prompt` (verified by `remoteCommandGate.test.mjs:71-88` A5, which asserts `isKnownTool=true`, `isCommandTool=true`, `isPromptTool=false`, the refusal code *and* unchanged wording, plus the `session.prompt` control). Not a "function exists" test.

3. **Migration semantic honest — PASS.** `normalizeGrant` returns `E_GRANT_TOOL_RETIRED` before the unknown-tool check (`instanceGrant.ts:451-456`); `decodeGrants` propagates that code to a whole-envelope empty result (`:773-777`); `problemText` names the old id (`:281-282`); store needed zero changes (`instanceGrantStore.ets:86` unchanged, pinned by `instanceGrant.test.mjs:620` E-08 regex). See F2 for the trade-off verdict.

4. **Parity gate can fail — PASS.** `grantVocabParity.test.mjs:19-23` reads both sources from disk (no import), `:26-33` accumulates mismatches, `:96-98` asserts zero. As committed it passes (RUN1, exit 0). FAIL path exercised by duplicating the three sources plus the test at the correct depth under `.tmp\review-b9-parity2\` and adding `TOOL_SESSION_PROMPT` to the *plugin* `VIEW_TOOLS`: the committed test then reported `PARITY: 4 mismatch` and `AssertionError … 4 mismatch` at test line 98, whole invocation exit 1 (RUN3). Repo files were never mutated.

5. **Two Nits closed without collateral — PASS.** `SyncSection.ets:236-238` diff is comment text only (no layout/ behavioural tokens changed). `syncWiring.test.mjs:679-698` (40c) injects `更多`/`详情`/`帮助` as innocuous labels whose `onClick` calls `this.runConfiguredCycle()` and asserts the absence guard throws via `/sync capability/`, then asserts the same labels with `this.openHelp()` stay legal — attribution to the capability, not the label. `40b` (`:654-673`) is untouched in the diff.

6. **Design doc honesty — PASS (5/5 spot-checks).** Verified against the cited installed definitions (all resolve to the npm-cache junction, corroborating C17):
   - signature `prompt(request: SessionPromptRequest, signal: AbortSignal): Promise<SessionPromptValue>` — `dsh-api-session-controller/lib/types/index.d.ts:138` ✔
   - service key `super(ctx, 'sessionController', { namespace: 'session' })` — `lib/types/index.js:193` ✔
   - request fields `{requestId, sessionId, mode, content, clientTimeZone?}` — `lib/types/types.d.ts:292-300` ✔
   - result `{accepted: true}` only — `lib/types/types.d.ts:301-304` ✔
   - `requestId` idempotency: early `if (hasPromptRequest(agent, requestId)) return {accepted:true}` — `lib/types/commands.js:292-293`, with `hasPromptRequest` scanning inbox nextTurn/nextStep and durable `user/message` events by `source.rpcId` — `:526-539` ✔
   - Corroborating: `gateway/bad-request` at `commands.js:283`, `throwIfAborted()` at `index.js:392-394`, `ApiSessionAgentError` at `agent.d.ts:32`.
   Ledger `SESSION-PROMPT-TRANSPORT.md:43-74` marks exactly 3 unverified (C14, C27, C29) + 1 mixed (C30, "verified for default … authority: unverified"); every verified row carries a file:line source cite, and §1/§2 disclaim runtime claims. No wrong or unsourced claim found in the spot-check.

7. **Hygiene — CONCERN (F1); otherwise PASS.** `app.json5` bumped (see F1). All other changed/new paths are exactly the A/B files plus `docs/SESSION-PROMPT-TRANSPORT.md`; no `dist/` or plugin source touched. `.tmp\gates-planner-b9-batch9.out`: tests 4012 / pass 4010 / fail 0 / skipped 2; dedicated logs confirm app 3158 (3158 pass, 0 skip) + plugin 854 (852 pass, 2 skip); 3158+854=4012 and 4010+2=4012 ✔. `apps\arkui-schedule\.build-logs\build-20261123-182523.log`: one `Finished :entry:default@CompileArkTS... after 3 s 418 ms` (EXECUTED), zero `UP-TO-DATE … CompileArkTS`, `BUILD SUCCESSFUL in 5 s 417 ms`. `.tmp\modules-grant-parity.abc` contains all six new ids (`session.events`, `session.prompt`, `session.create`, three `session.lease.*`) plus `session.info`, `isPromptTool` and `E_COMMAND_TOOL_NOT_ALLOWED`; `session.read` also appears, expectedly, from the retained legacy marker.

### Test runs (3 invocations)
- RUN1 `node --test tools/test/grantVocabParity.test.mjs` → 1 pass / 0 fail, exit 0.
- RUN2 first copy attempt placed the test only 2 levels below its copy root; the test's fixed 4-level-up `REPO` resolution read the real repo, so it passed — this did **not** exercise the FAIL path and is recorded here for transparency.
- RUN3 (corrected tree) `node --test <mutated-copy-parity> instanceGrant remoteCommandGate syncWiring` → 121 tests, 120 pass, 1 fail (only the mutated parity copy), exit 1; the three committed suites all passed in the same run. No builds were run.

## Residual & unverified

- No device / real-runtime verification performed; the doc's C14 (service mounted in the running profile), C27 (no undo path outside the searched types), C29 (failure→typed mapping) remain `unverified` and C30's head-reader authority remains `unverified` in the doc — correctly marked there.
- C16/C17/C18 filesystem probes (asar size/bytes, junction targets, absent lockfile) were not independently re-derived; the junction observation is corroborated by the read paths resolving under `…\_npx\1e7f6d9597241db0\…`.
- Per-module suite split was verified from the dedicated `.tmp\gates-grant-parity{,-plugin}.out` logs; the combined log itself reports only totals.
- Build log and `.abc` are provided artifacts; I did not rebuild (read-only constraint). `app.json5` hygiene resolution (revert vs document) is left to the lead.
