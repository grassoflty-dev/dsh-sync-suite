# Review — mod-pairing-reachability

## Verdict
CONDITIONAL PASS — the pair-time gate is genuine and fail-closed (no paired row without a successful probe, no store-byte change on failure), but the failure copy states 「连接被拒绝」 for DNS/name-resolution failures that the executor admits it cannot discriminate, so commit is conditional on a neutral-copy fix. Major findings remaining: 1

## Findings

### Blocker
None. A paired row cannot be written through the manual-pairing path without a successful probe, and a failed probe cannot change the persisted envelope.

### Major

**M1 — DNS failure is mislabelled as 「连接被拒绝」 (copy honesty, check #3).** `pairingProbeService.ets:83-86` collapses *every* `client.connect()` rejection — `ECONNREFUSED`, DNS/NXDOMAIN, network-unreachable, abort — into `settle('refused')`; `pairingProbe.ts:59-65` then renders `refused` as 「无法连接到该地址：连接被拒绝（<port>）」. This is a confident causal claim the code has no evidence for. Tailscale magic-DNS names are an explicitly supported transport (`pairingPayload.ts:48`), so an unresolved hostname is a realistic case: the user is told the PC listener refused the connection and is sent to check the port, when the actual fault is name resolution. That is the same "confident but wrong status" family as the P0 lie being deleted. **Decision: not acceptable — keep `E_PAIRING_UNREACHABLE` but change the generic branch to the neutral 「无法连接（<port>）」, or discriminate socket error codes in the transport so 'refused' is emitted only on a real refusal. Needs fixing before commit.** The R2 wording assertion (`pairingReachability.test.mjs:117`) must be retargeted to the neutral string, not deleted or weakened.

### Minor

**m1 — "zero writes" tests exercise a hand-written store replica, not `InstanceStore` (checks #2/#6).** `storeSeam()` (`pairingReachability.test.mjs:63-82`) re-implements the "only write on `result.ok`" rule; R2–R6 compare *its* `bytes`. The real guard at `instanceStore.ets:148-151` is only checked textually by R7-1. I read the real store and it is correct (`commit` at `:96-107` is called solely inside `if (result.ok)`; `load()` is read-only), so behaviour is fine — but the strongest byte-identity claim is not exercised end-to-end. Add one integration case against `instanceStore.addByPairing` with an in-memory AppStorage stub, or label R2–R6 as model-level only.

**m2 — later-unreachable degradation is wired to router navigation, not to remote reachability (check #5).** The three-state display is real (`instanceSeed.ts:136-144`; `InstancesPane.ets:707-710` maps `ok` → 「已配对（已验证可连接）」, `fail` → 「已配对（当前不可连接）」, `unknown` → 「已配对（尚未验证可连接）」), and pair-time success uses the same `applyReachability` (`pairingPayload.ts:658`; `instances.ts:561-607`, `:596-599` advances `lastSeen` only on `ok`) as `markReachable` (`instanceStore.ets:163-165`) — so **no new state machine was invented**, claim confirmed. However, the only `markReachable('fail')` call in the whole tree is `InstancesPane.ets:318`, fired on `router.pushUrl()` rejection. Web-load / connection failure is explicitly delegated to `RemoteControl`'s own error card (`InstancesPane.ets:299`), and no path from there calls back into `markReachable`. In the P0 scenario (listener stopped after pairing) the row can therefore keep showing 「已配对（已验证可连接）」 until the user acts, despite the `relativeLastSeen` line at `:688` giving temporal context. Follow-up lane should wire the Web failure signal back to `markReachable`.

**m3 — the named durable log does not contain the claimed console markers (check #7).** `.tmp/build-mod-pairing-reachability.out` is byte-identical (SHA-256 `DC7BF2D1…FED`) to `apps/arkui-schedule/.build-logs/build-20261122-200417.log` and contains only hvigor output: neither `✓ 产物验收通过` nor `[overlay] applied=false`. Those two lines exist in `.tmp/build-p0-pairing-tablet.out` (`:17`, `:68`) — the wrapper console for the *same* build (`Log: …build-20261122-200417.log`). Compile evidence is real but misfiled; the handover should point to the wrapper `.out`, not the log copy. Also note `✓ 产物验收通过` there validates the overlay's Handwriting/OCR symbols, not the pairing symbols.

**m4 — "0 UP-TO-DATE" is true only for CompileArkTS (check #7).** Log `:1386` shows `Finished :entry:default@CompileArkTS... after 2 min 31 s 426 ms` (EXECUTED) and there is no `UP-TO-DATE :entry:default@CompileArkTS`; but `:1409` says `42 tasks in total: 40 executed, 2 up-to-date` (`:entry:default@PreBuild` and `::ProcessProjectPrivacyProfile`). Quote the scoped form, not a global "0 up-to-date".

**m5 — `tsc 0` has no lane-specific durable artifact (check #8).** No tsc output file for this lane exists among the 20:03–20:16 artifacts; the exit code is executor-reported only. The three `node --test` tails do exist and match the claims exactly.

### Nit

**n1 — "added" success copy is unused on this path.** `pairingPayload.ts:666` forces `PAIRING_VERIFIED_WORDING` for both `built.action === 'added'` and `'updated'`, so 「已添加实例并固定证书指纹」 / 「证书指纹一致，已更新实例地址」 (`:113-114`) are no longer reachable from the UI; harmless, but the badge is identical for first pair and re-pair.

**n2 — TCP-only probe accepts any listener.** `tcpConnectProbe` proves `host:port` accepts a connection, not that it is the DSH HTTPS listener; any service on that port passes. Accepted by the stated TLS-lane split, listed as residual risk below.

## Checklist

1. **Probe really gates persistence — PASS.** `addPairedInstanceWithProbe` (`pairingPayload.ts:623`) awaits `probePairingTarget` at `:638` *before* `addPairedInstance` at `:648`; failure returns `addFail()` (`:641-647`, `items: []` via `:141-143`). `instanceStore.addByPairing` (`:147-153`) awaits it at `:148` and calls `commit` only under `if (result.ok)` at `:149-150`; the UI awaits at `InstancesPane.ets:428`. The manual URL form (`submitForm`, `:363-405`) uses `instanceStore.upsert` but never claims 「配对成功」; the signed-announcement path (`remoteAnnounceRefresh.ets:108-131`) has its own explicit-consent flow and is out of scope. No paired row can be written without a successful probe, including on retry.

2. **Zero writes on failure — PASS.** Model-level: `addFail` returns empty `items` (`pairingPayload.ts:141-143`), all failure branches (bad payload `:630-635`, probe failure `:641-647`, TOFU conflict `:649-651`) return before any row is built; `encodeInstances` input is untouched (the function only slices/copies, `:546`). Store-level: `commit` is skipped on failure, so the envelope string is unchanged; `load()` performs no write. Paste text preserved: `InstancesPane.ets:429-433` returns before `this.pairingText = ''` at `:434`. No pin written: `tlsFingerprint` is only assigned on the success path (`:574`, `:599`). Caveat: byte-identity is tested on the replica — see m1.

3. **Timeout/refusal honesty — FAIL.** 3 s hard limit and async-only are sound (`pairingProbe.ts:22`, `:97-100`; `pairingProbeService.ets:34-37`, `:71-78` watchdog + SDK timeout, Promise at `:43`). Classification is not: all non-timeout socket errors become `refused` (`:83-86`) and print 「连接被拒绝」 (`pairingProbe.ts:64`), including DNS failure. Misleading; neutral copy or error-code discrimination required before commit (M1).

4. **TLS gap stated, not hidden — PASS.** `PAIRING_PROBE_MODE = 'tcp'` (`pairingProbe.ts:28`), `void expectedFingerprint` and `fingerprintVerified = false` (`:118-119`); `E_PAIRING_TLS_MISMATCH` is reachable only from a fake transport status (`.test.mjs:142-152`), never from the real socket. The badge says 「已配对（已验证可连接）」 — the qualifier is *connectability*, not identity — and the adjacent line says 「指纹 … · 已固定指纹」 (`InstancesPane.ets:719`), i.e. pinned, not verified. No identity-verification claim is made; residual reading risk noted in checklist 5/residual section, not a Major.

5. **Later-unreachable — CONCERN.** Three states exist and degrade (`instanceSeed.ts:136-144`, `InstancesPane.ets:707-710`); pair-time success sets `ok`/`lastSeen` through the same `applyReachability` (`pairingPayload.ts:658`, `instances.ts:596-599`) used by `markReachable` (`instanceStore.ets:163-165`). No new state machine — confirmed. But the `fail` trigger is `router.pushUrl` rejection (`InstancesPane.ets:311-320`), not an actual connection failure; see m2. No proactive re-probe, as stated.

6. **Tests — CONCERN.** 12 cases: R1–R6 (`.test.mjs:86-177`) are behavioural (import compiled `.build` JS at `:34-36`, drive `addPairedInstanceWithProbe` and `pairingUnreachableWording`); R7-1–R7-5 (`:188-237`) are source-shape regex/position checks; R7-6 (`:239-252`) mixes source-shape with two behavioural wording assertions. Pre-change run: 1 file / 0 pass / 1 fail with `ERR_MODULE_NOT_FOUND` for `pairingProbe.js` (`.tmp/pairing-reachability-before.out`) — novelty, not behaviour. As written, no assertion would pass on old code (import fails first); but the source-shape ones would pass on code that merely contains the strings, and R2–R6 prove byte-identity on a replica (m1).

7. **Compile evidence — CONCERN.** `build-20261122-200417.log:1386` CompileArkTS EXECUTED (2 min 31 s 426 ms), `:1407` BUILD SUCCESSFUL (2 min 56 s 805 ms), `:1409` 40 executed / 2 up-to-date. `✓ 产物验收通过` + `[overlay] applied=false` are in `.tmp/build-p0-pairing-tablet.out:68`/`:17`, not in the named `.out` (m3/m4). Artifact on disk: `entry/build/default/intermediates/loader_out/default/ets/modules.abc` = **3,154,900 B**; direct UTF-8 byte scan hits `pairingProbe`×6, `probePairingTarget`×2, `tcpConnectProbe`×2, `addPairedInstanceWithProbe`×2, `E_PAIRING_UNREACHABLE`×1, `E_PAIRING_TLS_MISMATCH`×1, and Chinese copy 「已验证可连接」×1, 「无法连接到该地址」×2, 「证书指纹不匹配」×2 — the new code is really in the artifact. `git status` shows no `D entry/.test/**` (deletions restored). Working-tree `versionCode` is 1000009→1000011, attributed by `docs/MODULES.md:21/179/180` to earlier lanes (`mod-sync-ui-silence` / `mod-pairing-id-pin`); this lane's diff touches no `app.json5`, so no bump by this lane (shared-tree attribution caveat).

8. **Gates — CONCERN.** Targeted **29/29 / 0 fail** (`.tmp/gates-p0-pairing-tablet-targeted.out`), app **3063/3063 / 0 fail** (`.tmp/gates-p0-pairing-tablet.out`), whole-repo **3788 tests / 3787 pass / 0 fail / 1 skipped** (`.tmp/gates-p0-pairing-tablet-all.out`) — all match; no failing test to assign an owner, the single skip is the long-standing baseline skip. `tsc 0` is executor-reported with no durable lane log (m5).

## Residual risk & unverified

- No device/on-tablet verification: no real `socket.constructTCPSocketInstance()` run, no firewall/NAT/Tailscale case, no measurement that the watchdog really returns the button in ≤3 s. All on-device behaviour `unverified`.
- TLS handshake and leaf-fingerprint comparison are not implemented by design; 「已固定指纹」 means stored, not checked. If a user reads 「已配对」 as identity assurance, the copy still invites conflation — revisit when the TLS lane lands.
- The `fail` state may be practically unreachable (m2); no proactive re-probe means a stale 「已验证可连接」 badge can outlive the listener.
- Every non-refusal network error shares one typed code (M1); fixing the copy does not add diagnosis detail, only removes a false cause.
- Source-shape tests (R7) are brittle to harmless refactors and do not prove runtime ordering; integration coverage is model-seam only.
- Compile/abc evidence was checked by reading existing files and byte-scanning the artifact; no build, install, or device command was run by this review.

## Evidence log

- Read: `apps/arkui-schedule/entry/src/main/ets/model/pairingProbe.ts` (1–142); `services/pairingProbeService.ets` (1–88); `model/pairingPayload.ts` (1–135, 470–669); `services/instanceStore.ets` (1–179); `pages/panes/InstancesPane.ets` (295–320, 360–489, 690–729, 840–860); `model/instances.ts` (540–649); `model/instanceSeed.ts` (120–144); `services/remoteAnnounceRefresh.ets` (95–144); `apps/arkui-schedule/tools/test/pairingReachability.test.mjs` (1–253).
- Logs read: `.tmp/build-mod-pairing-reachability.out` (1–14, 1375–1413); `apps/arkui-schedule/.build-logs/build-20261122-200417.log` (hash comparison); `.tmp/build-p0-pairing-tablet.out` (header + tail, UTF-8); `.tmp/gates-p0-pairing-tablet-targeted.out`, `.tmp/gates-p0-pairing-tablet.out`, `.tmp/gates-p0-pairing-tablet-all.out` (tails); `.tmp/pairing-reachability-before.out` (full tail).
- Read-only commands: `Get-FileHash` (two logs identical), `Get-ChildItem`/`Get-Item` (abc size, artifact timestamps), UTF-8 byte scan of `modules.abc`, `git status --porcelain`, `git diff --stat`, `git diff -- AppScope/app.json5`, `Test-Path`. No writes except this report; no builds, overlay operations, git writes, subagents, or device commands.

## Delta (r2)

**Delta verdict: PASS — Major findings remaining: 0.** M1 is closed in source, in tests, and in the compiled artifact. No assertion was deleted or weakened; the copy changes go beyond the minimum without introducing a new over-claim.

### M1 closure — verified in source, not from the summary

- `pairingProbe.ts:38` now declares `PairingProbeStatus = 'ok' | 'unreachable' | 'timeout' | 'tls-mismatch'`; `:114`, `:118`, `:121-125` fail closed to `unreachable` on unknown status, throw, or abort. No `refused` literal remains in either probe file (R7-5 asserts `settle('refused')` absent at `pairingReachability.test.mjs:253`).
- `pairingProbeService.ets:85-89` settles `'unreachable'` on every SDK rejection; the comment at `:86-87` explicitly refuses to assert ECONNREFUSED. `settle('timeout')` exists **only** in the watchdog at `:73-75`, so timeout remains a warranted, watchdog-only claim.
- `pairingProbe.ts:73` keeps 「无法连接到该地址：连接超时（<port>）」; `:75` uses the neutral 「无法连接到该地址（<port>）：连接被拒绝或地址不可达」 — a disjunction of possibilities, not a refusal assertion. R2 (`:123-126`), R3 (`:145-147`) and R7-6 (`:265-270`) pin both strings and their byte-distinctness. Remaining `连接被拒绝（` hits in the abc come from the out-of-scope `RemoteControl.ets:331`, where it is gated on a real Chromium `-102` error code — legitimate.
- Axis documented: `pairingProbe.ts:16-22` states 可达性（TCP）≠ 配对真实性（TLS 指纹）, that authenticity is TLS-module-gated, and that any pre-TLS success copy may only say 「地址可达，尚未校验证书」; `pairingProbeService.ets:10-12` mirrors it. R7-4 (`:241-243`) asserts both phrases in the probe source.

### Badge honesty against the Lead's rule

- `pairingPayload.ts:122` renames the constant to `PAIRING_REACHABLE_WORDING = '已配对（地址可达，尚未校验证书）'`; `:668` returns it; `InstancesPane.ets:46/711` consumes it. The old constant and both legacy badges are gone from all `.ets`/`.ts` and from the abc (`PAIRING_VERIFIED_WORDING` ×0, 「已配对（已验证可连接）」 ×0, 「尚未验证可连接」 ×0). R1 (`:97-101`), R7-3 (`:230-232`), R7-6 (`:271-272`) assert no bare 「已验证」.
- **No wording still implies authenticity.** The badge explicitly says 「尚未校验证书」 and the adjacent line says 「已固定指纹」 (stored, not checked); `fingerprintVerified` is still hard-false (`pairingProbe.ts:130-131`). The "TCP-only success must not be labelled authenticated" rule is satisfied.
- **「已配对」 read alone:** I judge it acceptable, not a new Major — in this app pairing is the local act of persisting the pasted pairing row, which really happened, and the parenthetical bounds the claim to transport reachability. It does not say the PC accepted the tablet or that the peer is the claimed machine. Under a strictly literal reading of "a bound port is not pairing acceptance", a lay user could still hear 「已配对」 as mutual acceptance; if the Lead wants that reading enforced, a non-blocking follow-up rename to 「已记录（地址可达，尚未校验证书）」 would remove the last ambiguity. Not blocking this delta.

### Gate tails (r2)

- `tsc`: `.tmp/tsc-p0-pairing-tablet-r2.out` — `exit: 0`, empty stdout/stderr. **Closes r1 m5.**
- Targeted: `.tmp/gates-p0-pairing-tablet-r2-targeted.out` — `tests 29 / pass 29 / fail 0 / skipped 0`.
- App: `.tmp/gates-p0-pairing-tablet-r2.out` — `tests 3063 / pass 3063 / fail 0 / skipped 0`.
- Whole repo (checked though not claimed): `.tmp/gates-p0-pairing-tablet-r2-all.out` — `tests 3788 / pass 3786 / fail 1 / skipped 1`. **The one failure is not this lane:** `P0-2：start 真的 bind（TCP 连接成功）后才有载荷…` at `packages/dsh-dots/test/p0-pairing-listener-truth.test.mjs:308`, `E_LISTEN_FAILED` / `EADDRNOTAVAIL` binding `192.168.137.1:6869` — owner = plugin `mod-plugin-pairing-listener-truth` lane, environment-dependent local bind, out of scope here. It is not caused by the copy change.
- Build: `apps/arkui-schedule/.build-logs/build-20261122-202337.log:1386` `CompileArkTS` EXECUTED 6 min 4 s 864 ms (no `UP-TO-DATE :entry:default@CompileArkTS`); `:1407` `BUILD SUCCESSFUL in 7 min 15 s 281 ms`; `:1409` 40 executed / 2 up-to-date (r1 m4 wording caveat still applies). Console markers are in `.tmp/build-p0-pairing-tablet-r2.out:3` (`applied=false`), `:31` (`[overlay] applied=false`), tail `✓ 产物验收通过`. The named `.tmp/build-mod-pairing-reachability-r2.out` is byte-identical (SHA-256 `8B0CFB18…50C9`) to the hvigor log and contains neither console marker — r1 m3 pattern persists in the new filename (Minor evidence-hygiene only).
- Artifact: `modules.abc` = **3,154,960 B**; UTF-8 byte scan: `PAIRING_REACHABLE_WORDING` ×1, `E_PAIRING_UNREACHABLE` ×1, `E_PAIRING_TLS_MISMATCH` ×1, 「已配对（地址可达，尚未校验证书）」 ×1, 「连接被拒绝或地址不可达」 ×1, 「无法连接到该地址：连接超时」 ×1, old constant ×0, old badge ×0. File mtime is 20:34:12 because a later out-of-scope lane rebuilt it (`build-mod-remote-pinned-client.out`); the same working tree still contains all r2 changes.
- `git status`: no `D entry/.test/**`; `versionCode` still 1000009→1000011 from earlier lanes, no bump attributable to this delta.

### Residual after delta

m1 (byte-identity tested on a replica), m2 (`fail` state driven by router navigation), n1 (unused legacy success wording), n2 (TCP accepts any listener), m3 (evidence mislabelled) and m4 (global up-to-date count) remain as previously recorded; m5 and the Major M1 are closed. No on-device/TLS verification was performed by this delta review.

### Evidence added in this round

Read: updated `model/pairingProbe.ts` (1–154), `services/pairingProbeService.ets` (1–91), `model/pairingPayload.ts` (108–127), `pages/panes/InstancesPane.ets` (700–727), `tools/test/pairingReachability.test.mjs` (1–278); logs `.tmp/tsc-p0-pairing-tablet-r2.out`, `.tmp/gates-p0-pairing-tablet-r2-targeted.out`, `.tmp/gates-p0-pairing-tablet-r2.out`, `.tmp/gates-p0-pairing-tablet-r2-all.out`, `.tmp/build-p0-pairing-tablet-r2.out`, `.tmp/build-mod-pairing-reachability-r2.out`, `build-20261122-202337.log`. Read-only commands only: `Get-FileHash`, `Get-Item`/`Get-ChildItem`, UTF-8 byte scan of `modules.abc`, `git status --porcelain`. No builds, device commands, git writes, or subagents; the only write is this appended section.
