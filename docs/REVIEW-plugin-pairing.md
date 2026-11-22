# Review — mod-plugin-pairing (engine)

Independent, read-only review of the pairing **engine** only. The certificate DER generator's own review (`docs/REVIEW-plugin-pairing-cert.md`) is treated as established and is not re-reviewed here. No token value, private-key material, or full pairing payload is reproduced below — only presence/absence, counts, symbols and line anchors.

Scope note: the source actually lives under `packages/dsh-dots/`; the TODO is tracked at `packages/dsh-dots/docs/PAIRING-CLIENT-TODO.md` (the task text shortened both paths). No files were changed other than this report; gate commands were run because Check 9 explicitly requires it.

## Verdict

CONDITIONAL PASS — The engine is coherent, additive, hygienic and all nine gates are green (build 0, `tsc --noEmit` 0, dist 65/65 byte-identical, targeted 24/24, full 652/651/0/1), but one real transactional defect lets a provisioning failure durably change the recorded port without ever emitting the required republish, and the user-visible feature is honestly still unwired; **Major findings remaining: 1**.

## Findings

### Blocker

None.

### Major

- **M1 — Port is persisted before validation/republish; a failed run permanently suppresses the republish (`packages/dsh-dots/src/remote/pairingProvision.ts:190-262`).** `persistPort(store, chosen.port)` runs at `:196`, but `resolveEndpoint()` (`:220`), `buildPairingPayload()` (`:232`) and the republish event construction (`:245-259`) all run afterwards. If any of those throws — e.g. auto mode with an empty/failed NIC seam (`E_PAIRING_HOST`, `:182-184`), a disk error writing the token/cert (`:204,:215`), or a malformed stored token (`:198-200`) — the **new port is already durable in `remote.json`** while no `port-changed` (or `first-publish`) event is ever emitted. On the next successful `run()`, `settings.port` already equals the new port, so `chosen.changed === false` and the reason expression at `:237-243` yields `null`: the republish **never happens**. Concrete first-publish variant: a fresh install where the first `provision()` fails after `:196` leaves a recorded port with no `first-publish`, and the second (successful) call returns no event either. This breaks the stated invariant "port change ⇒ same-key republish with new payload", leaving the announcement stale with no recovery path. Required fix: resolve endpoint and build the payload first, persist only on the success path, and keep a durable pending-republish marker (or persist the previous port) so the event is retried. Check 2 is therefore CONCERN, not PASS.

### Minor

- **m1 — Rotation is not atomic either (`pairingProvision.ts:276-283`).** `rotateToken()` writes the new token and awaits `onTokenChanged` *before* calling `run('token-rotated')`. If `run()` throws, disk holds the new token while the in-memory gate has been told the new value but no payload/republish was produced. Same transaction-ordering family as M1; lower impact because the failure is surfaced to the caller.
- **m2 — Full internal state still crosses the service API (`pairingProvision.ts:111-122,264-271,312-327`).** `PairingProvisionResult.state` carries the token and `cert.keyPem`; `createPairingService().provision()` returns it. Hygiene currently rests entirely on the RPC projection (`src/rpc.ts:727-742`) plus test H5. Any future direct consumer that serialises `provision()` would leak. This is the cert review's M4, closed only at the RPC boundary.
- **m3 — Port-free probe is loopback-only (`pairingProvision.ts:43-55,51`).** `isPortFreeDefault` binds `127.0.0.1`; a port occupied only on the LAN/tailnet address passes the check and the real listener bind then fails. No typed error is defined for that case.
- **m4 — TODO status sentence is near-verbatim, not verbatim (`packages/dsh-dots/docs/PAIRING-CLIENT-TODO.md:3`).** It says "二维码与自动配置目前不是用户可见功能"; the requested phrase uses "尚不是". `docs/MODULES.md:164` does carry the exact "尚不是用户可见功能" wording. Meaning is identical — recorded for precision, not as an honesty defect.

### Nit

- **n1 — Scope path shorthand.** The brief says `docs/PAIRING-CLIENT-TODO.md`; the real tracked/staged path is `packages/dsh-dots/docs/PAIRING-CLIENT-TODO.md`, which is the path `docs/MODULES.md` references.
- **n2 — Misleading IPv6 classifier comment (`pairingTransport.ts:93-100,97`).** The comment enumerates `fe80 / fc00..fdff / ff00`, but the code tests first hex digit `/^[89ab]/`; those prefixes start with `f`. The net result is still correct because only `/^[2-3]/` returns true (`2000::/3`), but the comment does not describe the code.
- **n3 — Gate capture discipline.** Per the one-deliverable-file constraint, gate outputs are retained in this review's tool transcript rather than in `.tmp/gates-plugin-pairing-*.out` as `docs/MODULES.md` §0 rule 10 asks. Results are point-nameable (see Evidence log) but not in the prescribed log files.

## Checklist

1. **Payload contract — PASS.** Canonical key order `v,instanceId,transport,host,port,token,tlsFingerprint,announceRef` is declared at `pairingPayload.ts:25-27`, rebuilt explicitly at `:207-217`, and emitted by `serialisePairingPayload` at `:221-233`; round-trip is asserted byte-for-byte in test P1. Compact `DSHDOTS1|…` form at `:245-253` / `:255-273` parses back to the same object (P2). Six independent typed errors (`:51-58`, raised at `:185-205`) with value-free reasons; P3 also proves a bad version carrying a real token still yields no token in the error. IPv6 normalisation delegates to `urls.ts:104-176` (RFC 5952, lowercase, first-longest-run tie-break); my own mixed-case/expanded probes produced `[2408:820:7:1234::1]` and `[2001:db8::1:0:0:1]` (first of two equal zero-runs compressed) with bracketed output; P4 pins the expanded-input case.
2. **Provisioning idempotence — CONCERN (M1).** Happy path is proven: V1 (two `run()` calls ⇒ same port/token/cert/payload, second has `republish === null`, one `first-publish` event) and V2 (port written to `remote.json`, occupied port ⇒ `port-changed`, `previousPort` carried, same key, new payload, `onRepublish` awaited at `pairingProvision.ts:261` before return at `:264`). M1 describes the failure-window hole that suppresses the event permanently.
3. **Rotation semantics — PASS.** `rotateToken()`/`rotateCert()` at `pairingProvision.ts:276-288`; V3 and V4 prove old payloads fail `verifyPairingAgainst` with `E_PAIRING_TOKEN_MISMATCH` / `E_PAIRING_FINGERPRINT_MISMATCH`, new payloads still verify, and `onTokenChanged` receives the new value with reason `rotate` (`:279-281`). Constant-time token compare and value-free reasons at `pairingPayload.ts:399-404`.
4. **Transport selection — PASS.** Priority array and override fallback at `pairingTransport.ts:71,146-176`; typed candidates `{kind,available,reason,host}` at `:73-80,120-139`; T1–T5 cover priority, three reasons, override fallback, empty-seam null and non-routable addresses. `TAILSCALE_RE` (`:30`) covers second octet 64–127 = 100.64/10 and `RFC1918_RE` (`:31`) covers 10/8, 192.168/16 and 172.16–31 — both correct. Copy is centralised at `:59-69` and test-pinned in T2/T4; the LAN explanation (port+token already in the QR, nothing typed, token blocks others on the Wi-Fi) is `lanNeedsSecret` at `:67`, surfaced by `transportReasonLines()` at `:182` and asserted in T2. No separate "approved copy" document exists in the repo beyond this source/test pair — treated as the approved source of truth.
5. **Secret hygiene — PASS.** No `console.*` / `hilog` / logger call anywhere in `src/remote/**` (grep: only an unrelated UI hint in `probe.ts:1543`). `describePairing()` returns `token: 'present'` only (`pairingPayload.ts:312-348`, P6); all error reasons and status views are value-free. RPC projections return only `{view,changed,republish:{key,reason,previousPort,port}}` (`rpc.ts:727-742`); H4/H5 prove no token, payload, `keyPem` or private-key bytes on any `pairing*` response. `pairingShow` appears only as an RPC action and no client call site exists (`src/client.js` grep: 0 matches), so nothing auto-calls it on mount or schedule; H1–H3 pin zero clipboard writes on mount, no token in the render tree, and copy only on explicit click. The token's remaining outlets are the in-process `PairingTokenChangedEvent` (`:80-84`) and internal `state` (m2), neither of which reaches logs/UI/RPC.
6. **TODO honest and actionable — PASS (with n1/m4).** Tracked/staged at `packages/dsh-dots/docs/PAIRING-CLIENT-TODO.md`; it is a checkbox checklist with symbol+line anchors. All anchors were re-checked against the current `src/client.js`: `DotsPanel:4569`, `LeanRemoteGroup:4326`, `loadLink:4342`, `persist:4400`, `doGenerate:4436`, `doCopy:4452`, `doSelfCheck:4423`, plus the cited ranges (mount `4356-4382`, status `4479-4480`, Select `4492-4511`, port `4513-4528`, token `4530-4542`, copy button `4548`) — all resolve to the described symbols. Status "引擎完成 / 客户端未接线 / 面板待接线" and the not-user-visible statement are both present (`:3`).
7. **No behaviour change to existing remote control — PASS.** `git diff` of the four modified source files is additive only: `service.ts` adds `adoptToken` and one field to the returned object; `store.ts` adds `certFile`, `readCert`, `writeCert`, `clearCert`; `types.ts` adds optional `adoptToken?`; `rpc.ts` adds one option, one type import, helper functions and six action cases. No existing exported function body was altered — no listener, grant, gate or existing RPC semantics changed. `dist/client.js` is unmodified.
8. **Docs — PASS.** `docs/MODULES.md:164` records the cert boundaries verbatim: 2050+ clamped to 2049 / no GeneralizedTime, no SAN/keyUsage/EKU by design, the TOFU threat model in English, and the library recommendation ("recommended if dependency policy allows"). It states "引擎完成 / 客户端未接线 / 面板待接线" and that QR/auto-config is "尚不是用户可见功能"; the cross-module registration and rollback path are present (`:251,:396`).
9. **Gates — PASS.** All five run in this review, exit/count details in Evidence log: build 0; `tsc --noEmit` 0; fresh `tsc --outDir` 0 with 65 JS files, 0 hash mismatches and 0 missing/extra vs `dist` (and `dist/client.js` equals `src/client.js`); targeted pairing tests 24/24/0/0; full plugin suite 652/651/0/1.

## Residual risk & unverified

- **The user's actual request is not yet delivered.** Client wiring is deliberately out of scope: `src/client.js` still renders editable port and token inputs (`:4513-4542`) and calls `loadLink` on mount (`:4378`); the TODO's §1–§4 items are all unchecked. "No port/token fields in the panel" is a post-wiring requirement, not a current fact. This is documented honestly, so it is a condition on the verdict rather than a review FAIL.
- No real GUI/reload, tablet scan, or device verification was performed; `docs/MODULES.md` marks these `unverified`. Announcement module has no real `onRepublish` consumer yet, so M1's stale-announcement impact is latent until wiring.
- m1 (loopback-only port probe), m2 (full state at service boundary), m3 (loopback probe edge), m4 (wording) remain unfixed.
- Tablet-side TLS/TOFU behaviour and Windows 0600 ACL semantics are outside this review (see cert review Residual risk).
- The transport reason copy has no standalone approval record; its approval is inferred from being the single centralised, test-pinned source.
- Gate outputs were captured in tool output, not the prescribed `.tmp` logs (n3).

## Evidence log

| Check | Source | Observation |
|---|---|---|
| 1 | `pairingPayload.ts:25-27,207-233,245-296`; `urls.ts:104-176`; `test/pairing-payload.test.mjs:49-145`; direct probe | Fixed key order, byte-stable round-trip, compact-text round-trip, six typed errors with no echoed values; mixed-case/expanded IPv6 → bracketed RFC 5952 lowercase with correct tie-break |
| 2 | `pairingProvision.ts:124-158,190-271`; `test/pairing-provision.test.mjs:56-106` | V1/V2 prove idempotence, recorded port, `port-changed` with `previousPort`, same key/new payload, awaited hook; M1 identifies the persist-before-validate hole |
| 3 | `pairingProvision.ts:276-288`; `pairingPayload.ts:399-404`; `test/pairing-provision.test.mjs:108-154` | Stale payload → token/fingerprint mismatch typed errors; token-changed event carries new value; V3/V4 green |
| 4 | `pairingTransport.ts:30-31,59-91,146-184`; `test/pairing-transport.test.mjs:21-83` | Priority/override fallback/candidates correct; 100.64/10 and RFC1918 classification correct; LAN explanation present and asserted |
| 5 | grep `console./hilog` in `src/remote`; `pairingPayload.ts:312-348`; `rpc.ts:727-742`; `src/client.js` grep; `test/pairing-hygiene.test.mjs:176-307` | Zero logging calls; `token: 'present'`; redacted RPC views; zero client call sites for `pairingShow`; H1–H5 green |
| 6 | `packages/dsh-dots/docs/PAIRING-CLIENT-TODO.md:1-96`; `git status --short`; `src/client.js:4326,4342,4400,4436,4452,4569` | Staged/tracked checklist; every cited symbol+line anchor resolves; required status sentence present |
| 7 | `git diff -- src/remote/service.ts src/remote/store.ts src/remote/types.ts src/rpc.ts` | Additions only; no existing exported function body changed; `dist/client.js` untouched |
| 8 | `docs/MODULES.md:164,251,396` | Cert boundaries, wiring status and not-user-visible statement all present |
| 9 | Gate runs in `packages/dsh-dots` | `node scripts/build.mjs` exit 0; `tsc --noEmit -p tsconfig.json` exit 0; fresh `tsc --outDir <temp>` exit 0, FRESH_JS_COUNT=65, MISMATCH=0, MISSING=0, EXTRA=0, `dist/client.js` equals `src/client.js`; `node --test test/pairing-*.test.mjs` tests 24 / pass 24 / fail 0 / skipped 0; `node --test test/*.test.mjs` tests 652 / pass 651 / fail 0 / skipped 1 (exit 0) |

## Delta (r2)

Delta scope: only the claimed closure of r1 Major M1 by the **(a) persist-last + (b) durable `announcedPort` marker** combination, plus the reset of r1 Minor m4 and the six gates. The certificate, payload, transport, RPC and client-wiring conclusions from r1 are unchanged and are not re-litigated here.

**Delta verdict: PASS — M1 is genuinely closed in both failure windows; Major findings remaining: 0.** The overall review remains CONDITIONAL PASS for the unwired-client condition and the carried r1 Minors, but the blocking engine defect is resolved.

### Invariant holds in both windows

Read `run()` end-to-end (`pairingProvision.ts:190-288`):

- **No path persists a port before a completed republish.** `persistPort()` exists only at `:278`, after `await options.onRepublish(event)` at `:267` and after `store.writePairingAnnouncement(...)` at `:269-274`. The r1 top-of-run persist is gone (`:191-196` only reads/settings and chooses). If the hook throws, execution unwinds at `:267`: neither the marker nor `remote.json` moves, so the next run re-derives the same chosen port and, because `announcedPort` is still the old value (`:197,:240-248`), re-emits the same-key event. Verified by V8 and by an independent probe (`hook-throws: rejected=true, portAfter=44996, markerAfter=44996, events unchanged`; retry emitted `port-changed`, `previousPort=44996`, same key, port/marker both 44997).
- **The reverse window is repaired, not papered over.** With the marker ahead of `remote.json` (hook succeeded, persist threw), the marker says `announcedPort = chosen.port` while the record still holds the old port. Next run: if the new port is still the chosen one, `needsPortPublish` is false and `persistPort()` at `:278` simply records it; if the port has reverted to the recorded one, `announcedPort !== chosen.port` forces a `port-changed` event with `previousPort` taken from the marker and the marker is advanced. Both branches converge. V9 proves the second branch from real on-disk state (`:297-306`); the first branch follows directly from `:241` + `:278`.
- Republish decisions now come from the durable marker (`:240-248,258`), not from `settings.port`, which is exactly what makes the repair independent of which file lost the race. `previousPort = announcedPort ?? settings.port` (`:258`) is correct for both first-publish and repair.
- Corrupt/missing marker bytes ⇒ `readPairingAnnouncement()` returns `null` (`store.ts:170-181`) ⇒ `neverPublished` ⇒ a forced `first-publish` republish. Probe confirmed `reason: "first-publish"`; `previousPort` correctly falls back to the recorded `settings.port` rather than being fabricated.

V8 (`test/pairing-provision.test.mjs:236-277`) and V9 (`:279-311`) assertions are real: both read `remote.json` / the marker back through `RemoteStore` or `readFileSync` (V8 `:260`, V9 `:297-306`) rather than trusting an in-memory variable, and both pin the same key and `previousPort`, then assert a third idempotent run.

### Can the marker claim "announced" without evidence?

**Yes, in one specific sense — and it should be stated plainly.** `onRepublish` is optional (`pairingProvision.ts:101`), and the marker is written at `:269-274` whenever `reason !== null` even when no hook is injected. In the current engine-only, client-unwired configuration that is the normal case: the event is only returned in the result, nothing is published, yet the marker records an announced port. With a hook injected, "the hook resolved" is the only available evidence; a hook that resolves without actually publishing would likewise set the marker. A callback seam cannot verify the external side effect, so this is inherent to the design, not a code bug — but the field name "announced" overclaims what is proven.

This does **not** break the stated consistency invariant (recorded ⇔ announced, with next-run repair), which is what V8/V9 test and what the ordering enforces. Practical consequence to watch at wiring time: if any provision runs before the announcement module is attached, its marker will suppress the first-publish event when the module later attaches. Recommend the wiring module either clear `remote-pairing-state.json` on first attach or always call `pairingRotate*` once to force a fresh republish. Recorded as a residual risk, not a Major.

### Delta findings

- **D-Minor 1 — marker semantics above** (no hook ⇒ "announced" with no publish evidence; hook resolution is unverifiable). Residual at wiring time.
- **D-Minor 2 — the hook-throws path has no automated test.** V8 injects the failure at `resolveEndpoint()` (`:246,258-259`), i.e. before the event/hook; V9 simulates the reverse window by manually rolling the marker back. Neither exercises `onRepublish` actually throwing. Code inspection plus the ad-hoc probe confirm the behavior, but a V10 asserting hook-throws ⇒ no marker/no record/no second event would make the central claim regression-proof.
- **Carried from r1, unchanged:** m2 (full `state` still crosses the service API), m3 (loopback-only port probe), n3 (gate output in transcript, not `.tmp` logs) still stand. r1 **m4 is closed**: `PAIRING-CLIENT-TODO.md:3` now reads 「引擎完成 / 客户端未接线 / 面板待接线。二维码与自动配置尚不是用户可见功能。」
- Docs verified: `docs/MODULES.md:164` records 「最后写盘 + durable announcedPort 标记，失败窗口可自愈」 and `:396` records the (a)+(b) choice with V8/V9 and the invariant wording; status/未接线 wording remains intact.
- Marker hygiene: `writePairingAnnouncement()` (`store.ts:183-191`) writes only `v / announcedPort / announceRef / key` through `writeFilePrivate()` with `mode: 0o600`; probe confirmed exactly those four keys and no token or private-key material. `stat` showed mode `666` on Windows — the known POSIX-mode caveat (also acknowledged at `store.ts:53` and in the cert review), not a new defect: the same applies to the token and cert files.

### Gate tails (r2, all run in `packages/dsh-dots`)

```
node scripts/build.mjs                              -> [plugin] dist/index.js + dist/client.js 已生成 ; BUILD_EXIT=0
tsc --noEmit -p tsconfig.json                       -> TSC_NOEMIT_EXIT=0
fresh tsc --outDir <temp>                           -> FRESH_TSC_EXIT=0
                                                       FRESH_JS_COUNT=65  DIST_JS_EXCL_CLIENT=65
                                                       MISMATCH=0  MISSING_IN_DIST=0  EXTRA_IN_DIST=0
node --test test/pairing-*.test.mjs                 -> tests 26 / pass 26 / fail 0 / skipped 0 ; exit 0
node --test test/*.test.mjs                         -> tests 654 / pass 653 / fail 0 / skipped 1 ; exit 0
```

Ad-hoc probe (temp dirs, cleaned up; no token/key values reproduced): hook-throws left port and marker at the pre-change value with no extra event; retry emitted same-key `port-changed` from that marker value; corrupt marker forced `first-publish`; marker file contained only the four metadata keys and no secret material.
