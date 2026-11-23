# Review — batch 2: docs claims + mod-pairing-badge-truth

## Verdict
CONDITIONAL PASS — The docs claims are byte-provable against their single sources, the committed batch-1 hashes/tags/captures all resolve, and the badge module closes review m2 with a fail-closed, one-shot, keep-alive-safe consumer. The certificate-refusal→`fail` mapping is acceptable honesty (the badge says "currently cannot connect", not "address unreachable"); it is recorded as a residual nuance, not a defect. Major findings remaining: 0

## Findings

### Blocker
None.

### Major
None.

### Minor
None.

### Nit
1. Two literal `[待 RC-4]` tokens remain in `docs/SELF-TEST-REMOTE.md:135-136` (the §4 changelog). They are explicitly historical — the legend at `:5` now declares the marker retired — and none is in the §2.3 refusal table (`:106-109`). If "no `[待 RC-4]` may remain" is meant literally across the whole file, these two lines need rewording; they are not unfilled placeholders.
2. Some badge assertions cannot discriminate the change: `remoteOutcome.test.mjs:200-209` (forbidden badge copy absent) and `:250-257` (batch-1 composer/refusal-line regression guards) pass on pre-change code by construction. They are deliberate guards, not defects, but they are not evidence that the badge lane changed anything.
3. The certificate-refusal nuance is real though acceptable: `refusalStatusOf('tls-mismatch')` is `'fail'` (`model/remoteOutcome.ts:132-144`), and the coarse instance `reachable` field cannot say "refused the certificate"; the specific reason stays only in `RemoteControl.loadError`. The rendered copy 「已配对（当前不可连接）」 (`InstancesPane.ets:748-750`) does not claim network unreachability, so no copy defect.

## Checklist

### A. Docs claims (1–7, item 7 = review-file identity)

1. **§2.3 three refusal cells byte-for-byte — PASS.** Programmatic extraction (`node .tmp/review-b2-docs-extract.mjs`, capture `.tmp/review-b2-docs-extract.out`) read the three `export const … WORDING` literals from `model/tlsPin.ts:32,39,46` and the three backticked cells at `docs/SELF-TEST-REMOTE.md:107,108,109`: all three equalities `true`. Row (c) at `:109` carries `fail-closed` and `绝不报成 (a)，也绝不报成成功` (extraction: `C_FAIL_CLOSED=true C_NOT_A=true C_NOT_SUCCESS=true`). No `[待 RC-4]` in the three cells (see Nit 1 for the two historical changelog tokens).

2. **§2.5 pointer and eight codes — PASS.** Extraction output `GATE_CODES=8 … DOC_CODES=8 … CODES_EQUAL=true`; each of the eight `COMMAND_WORDING` keys in `model/remoteCommandGate.ts:41-50` appears in `docs/SELF-TEST-REMOTE.md:117-121`. The "no delivery channel" claim is consistent with `components/RemoteCommandComposer.ets:174-183` (`actionEnabled: false`, empty `onTap`), `model/remoteCommandDraft.ts:27` (`REMOTE_CHANNEL_VERIFIED = false`) and the absence of a `sessionPrompt` RPC (`CLOUD-CHAT-AND-DOTS.md:153-154,164`). Test D5 of the composer file contains no send assertion (`tools/test/remoteCommandComposer.test.mjs:185-198`).

3. **MODULES §1 rows — PASS.** Commits verified via `git show -s`: `3e46bc3` (`mod-remote-command-gate`), `1f57c0a` (`mod-remote-command-wire`), `ce4c70e` (`mod-plugin-local-pending-cause`), `84dd9cf` (archive) all exist with matching subjects. Annotated tag objects `1e1eda7` → `object 1f57c0a…` and `cf59613` → `object ce4c70e…` (`git cat-file -p`). All cited source/test paths exist (`MODULES.md:188-191`), including `tools/test/remoteCommandGate.test.mjs` and both grant tables. `mod-grant-vocab-parity` is recorded as `blocked-on-decision` with no commit (`MODULES.md:191`); the divergence is real — `packages/dsh-dots/src/remote/grants.ts:31-75` defines 5 view + 5 command tools (10), `apps/arkui-schedule/entry/src/main/ets/model/instanceGrant.ts:41-77` defines 4 view + 1 command (5), and neither file is modified in this batch. Rollback paths are executable single reverts (`git revert 1f57c0a` / `ce4c70e`; gate row requires reverting wire first), and none requires an unrelated file.

4. **MODULES §2 rows — PASS.** `MODULES.md:298` names `pages/RemoteControl.ets` as sole claimant and pins the byte-identical refusal line; `git status` shows no other claimant, and the line occurs once in the worktree. `:299` scopes `src/sync/cycle.ts` + one `dist/` window (`dist/sync/cycle.js`), matching the single-plugin-window rule. `:300` records all three contradictions: `PinnedRemoteView.ets` has zero importers (0 abc hits, r1 control), the grant vocabulary divergence (verified above), and the SELF-TEST lag — now closed by item 1.

5. **MODULES §5 rows + 订正 — PASS.** `3788/3787/0/1` is present in `.tmp/gates-plugin-outbox-per-intent.out` (captured), and the note at `MODULES.md:465-468` correctly re-labels it as a combined run; plugin-only `735/734/0/1` exists in both `packages/dsh-dots/.tmp/gates-plugin-pending-r3.out` and `.tmp/gates-lead-plugin-batch1.out`. The HAP note (2,381,264 B / 15 entries release, no `ets/sourceMaps.map`, vs 5.1–5.4 MB debug) matches the r1 release-HAP entry list. The note explicitly says in-flight `mod-pairing-badge-truth` is **not shipped**: `git log --all --grep=badge-truth` returns no commit. All capture paths are exact, including the plugin ones under `packages/dsh-dots/.tmp/`.

6. **UI-DESIGN §12 / ROADMAP handover — PASS.** `docs/UI-DESIGN.md:629` describes the composer honestly (permanently disabled, gate wording, no in-flight/success, `REMOTE_CHANNEL_VERIFIED=false`) and explicitly defers badge description to the other lane. `docs/ROADMAP.md:789` records both commits/tags, the review's r1→r2→r3 history (`MAJOR CLOSED / survivors 0/38`), `sessionPrompt` deferred pending `mod-chat-lease` + device gate, the `blocked-on-decision` grant item, the trailer-less "not ours" decision, and badge as in-flight/unshipped. No statement contradicts `MODULES.md`.

7. **Review-file identity — PASS.** My tool (`Get-FileHash -Algorithm SHA256`) reproduces `b4db3d553a1d19a6818f3d88f7499bbf3cfae81c58bf8dce3c84f4a82389bae0` for the batch-1 review file (mtime 14:14:29, unchanged). I cannot reproduce the docs lane's `6f3f197f…` value with this tool; the `b4db3d5…` hash is the one my own tool returns.

### B. Badge module (8–15)

8. **Honesty of cert-refusal→fail mapping — CONCERN (acceptable, not a Major).** `remoteOutcome.ts:132-144` maps all six refusal kinds (incl. `tls-mismatch`, `chain-unverifiable`) to `'fail'`; `InstancesPane.ets:168-186` writes that to `instanceStore.markReachable`, and `:748-750` renders 「已配对（当前不可连接）」. This does not silently assert "address unreachable": the badge is a coarse three-state, the wording says *cannot connect now*, and the precise reason remains in `RemoteControl.loadError` (`:336-341`). Recording as residual nuance per the executor's report (Nit 3), not a Major copy defect.

9. **Keep-alive proof — PASS.** `Home.ets:531-534` passes only `deepLinkId` and `active` to `InstancesPane` (no `Tick`/`tick`/`lastOutcome`/`REMOTE_OUTCOME`: D3 capture). The pane's only consumption path is the `@StorageLink(REMOTE_OUTCOME_KEY) @Watch('onRemoteOutcome') lastOutcome` declaration at `InstancesPane.ets:132` and the `onRemoteOutcome()` body at `:168-186`; grep of `lastOutcome|decodeRemoteOutcome|shouldApplyOutcome|markReachable` returns only the import (`:49-52`), the binding (`:132`), that watcher (`:173,177,178`), the old navigation-failure write (`:355`) and two comments (`:339,745`). `onPageShow()` does not consume the marker.

10. **Removed ok-on-navigation / U-05 — PASS.** `git show HEAD:…InstancesPane.ets` contains `instanceStore.markReachable(view.id, 'ok', Date.now());` at HEAD `:314`; the worktree does not, and the `@StorageLink` binding is present. U-05 (`tools/test/instanceList.test.mjs:366-375`) was strengthened, not weakened: it asserts `doesNotMatch` of the ok-call, retains the `fail` branch assertion, and adds the binding assertion — all three fail on pre-change code.

11. **One write per attempt + strict codec — PASS.** `RemoteControl.ets:119-125` guards with `outcomeWritten`; the single write site is `writeOutcome()` (`:235-244`) with one `setOrCreate`, reset in `applyAddress` (`:184`) and in the reloading `refresh` path (`:384-388`). `decodeRemoteOutcome()` (`remoteOutcome.ts:85-125`) rejects empty/oversize/bad-JSON/array/wrong-version/bad-id/bad-status/bad-time with `null`, and `shouldApplyOutcome()` (`:180-215`) rejects bad id, clock rollback and stale (>120 s) markers. A3/A4/C1–C3 pin these (`remoteOutcome.test.mjs:68-92,123-152`).

12. **Badge copy unchanged / forbidden strings absent — PASS.** `InstancesPane.ets:748-750` still selects among `PAIRING_REACHABLE_WORDING` / 「已配对（当前不可连接）」 / 「已配对（尚未探测地址可达性）」; `pairingPayload.ts` / `remoteAnnounceRefresh.ts` are unmodified. Source-wide scan of all `.ets`/`.ts`: 0 hits for 「已配对（已校验可连接）」「防中间人」「已验证身份」. abc `.tmp/modules-badge-truth.abc` (1,830,540 B) UTF-8 hits: `onRemoteOutcome`×2, `shouldApplyOutcome`×2, `REMOTE_OUTCOME_KEY`×1, forbidden strings ×0, `已配对（当前不可连接）`×1.

13. **Compile evidence (rule 9) — PASS.** `apps/arkui-schedule/.build-logs/build-20261123-142634.log:1386` `Finished :entry:default@CompileArkTS... after 1 min 15 s 602 ms` (EXECUTED); `:1409` `BUILD SUCCESSFUL in 1 min 45 s 783 ms`; `:1411` `42 tasks in total: 23 executed, 19 up-to-date`; count of `UP-TO-DATE … CompileArkTS` = 0. Console `.tmp/build-badge-truth.out` contains `[overlay] applied=false` and `✓ 产物验收通过`.

14. **Frozen files — PASS.** `git hash-object` = HEAD for `model/remoteCommandGate.ts` (`08fafb06cfa52133800a9bbb25b4d5d86db6da6c`), `model/pairingPayload.ts`, `model/instances.ts`, `pages/Home.ets`; `git status --porcelain` is empty for `entry/src/main/ets/services/**` and `entry/src/main/resources/**` (incl. both `main_pages.json`). No hidden write by the badge lane.

15. **Gates re-run by reviewer — PASS.** Captured with `Tee-Object`: `.tmp/review-b2-tsc.out` EXIT=0; `.tmp/review-b2-app-suite.out` `3148/3148/0/0`; `.tmp/review-b2-validate.out` 8/8 (70 JSON5 / 607 relative imports / 837 main imports / 12 pages / 2 rawfile); `.tmp/review-b2-overlay.out` `[overlay] applied=false`. All match the reported numbers.

## Stage sets confirmed
- **Docs commit (5 paths):** `M docs/MODULES.md`, `M docs/SELF-TEST-REMOTE.md`, `M docs/UI-DESIGN.md`, `M docs/ROADMAP.md`, `A docs/REVIEW-rc4-wiring-and-pending-cause.md` (byte-frozen, hash above). Currently unstaged (`git diff --cached` empty) — must be staged as exactly these five.
- **Code commit (5 app paths):** `M apps/arkui-schedule/entry/src/main/ets/pages/panes/InstancesPane.ets`, `M apps/arkui-schedule/entry/src/main/ets/pages/RemoteControl.ets`, `A apps/arkui-schedule/entry/src/main/ets/model/remoteOutcome.ts`, `A apps/arkui-schedule/tools/test/remoteOutcome.test.mjs`, `M apps/arkui-schedule/tools/test/instanceList.test.mjs`.
- **Must NOT ride:** `M apps/arkui-schedule/AppScope/app.json5` (versionCode bump), this review file, and any unrelated untracked review docs.

## Residual risk & unverified
- **Device behaviour — unverified:** no `hdc`/device run; actual badge transition, `@StorageLink/@Watch` firing, ArkUI rendering and one-shot AppStorage clearing on a real device are unobserved.
- **Real connectivity — unverified:** no live listener / TLS refusal / web-load failure was exercised; the `fail` mapping is proven only in model tests and source shape.
- **Real delivery — unverified:** `sessionPrompt` remains unimplemented; nothing is sent from the composer.
- **Reviewer did not rebuild ArkTS** (charter forbids): rule-9 evidence is the retained build log + source diff; abc/HAP bytes are tree-level corroboration only.
- **Concurrent docs edit:** `docs/SELF-TEST-REMOTE.md` changed twice during this review; findings cite the final state at mtime 14:42:09, sha `7cd7ae780a0c…`. Any further edit requires re-verification of A1/A2.
- Batch-1 commits (`1f57c0a`, `ce4c70e`) were not re-litigated; only contradictions introduced by batch 2 were checked (none found).

## Evidence log
- Programmatic: `.tmp/review-b2-docs-extract.mjs` / `.out` (literal extraction, 8-code equality, placeholder count), `.tmp/review-b2-final-placeholders.out`.
- Read-only git: status, `diff`, `numstat`, `show -s`, `cat-file -p`, `log --grep=badge-truth`, `hash-object`, `rev-parse HEAD:<path>`.
- Read-only pwsh: file hashes/mtimes, build log line scan, abc UTF-8 name scan, source-wide forbidden-string scan, capture-existence checks, frozen-path status.
- Gates re-run with `Tee-Object`: `.tmp/review-b2-{tsc,app-suite,validate,overlay}.out`.
- No source edits, no ArkTS build, no `hdc`, no git write, no live `~/.dsh/dots` access; temp artefacts only under `.tmp/`.
