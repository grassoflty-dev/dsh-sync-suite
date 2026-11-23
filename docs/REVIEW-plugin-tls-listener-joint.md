# Review — plugin TLS + listener-truth (joint)

Read-only review of the jointly frozen plugin slice at HEAD `1d640ec`. Scope: the two modules that share `src/remote/{listener,service,types,urls}` (+ dist) and the bound-address chain, to be committed as **one commit, two tags** (`mod-remote-tls-termination` + `mod-pairing-listener-truth`). This review supersedes the two single-module reviews for the *joint* bytes: `docs/REVIEW-plugin-pairing-cert.md` covers only the certificate generator, and `docs/REVIEW-plugin-pairing-listener-truth.md` covers listener-truth alone. No builds, no overlay, no git writes, no subagents, no device commands were performed. No token, key, PEM body, or credential value is reproduced below (test PEM-shaped canaries are referenced by line only, never quoted).

## Verdict

CONDITIONAL PASS — In-scope code is fail-closed and internally consistent: HTTPS is the only listener path, the QR payload is sourced from `server.address()` rather than interface enumeration, start failure cannot masquerade as success, and `dist/client.js` is byte-exact to a fresh `renderClientSource()`; the conditions are that the commit contain **exactly** the stage set below (no foreign / docs-backfill / RC-3 hunks) and that tablet pinning stay explicitly out of scope. **Major findings remaining: 0**

## Findings

### Blocker
None. None of the five FAIL conditions reproduces in the staged bytes:
- No foreign hunk inside the proposed set (see *Exact stage set*).
- No plaintext fallback: `listener.ts:795` is the only `https.createServer`; there is no `http.createServer` in the module (grep: only the two comments at `:7`, `:793`).
- No enumeration-sourced payload: `pairingProvision.ts:448` derives transport from the bound address, and `:469-477` builds host/port/fingerprint from `live.address` / `live.port` / cert; the seam is used only for candidate display and typed refusal (`:440-444`), never to pick the payload host.
- No start that can look successful when it failed: `client.js:4670-4677` handles `ok:false` and `ok:true` + `running !== true` + `lastError`, sets `setRunning(false)` + `setShown(null)`; `remote-running` is driven by `stopped = running !== true` (`:4689`, `:4765-4767`).
- No dist/source mismatch: `dist/client.js` and `src/client.js` are byte-identical (SHA-256 prefix `C1EC6821F83B5C0E`, 205,972 B each), and the gate test `dist/client.js 与 build.mjs 新鲜构建输出逐字节一致` passes.

### Major
None. The proposed set contains only TLS-owner, listener-truth-owner, or shared-module hunks. All `apps/**` changes, docs backfill, `docs/REVIEW-*`, and RC-3 files are present **in the working tree but outside the proposed set** and are listed under *Exclusions*; none of them rides in the nine source / nine dist / locale / test files reviewed here.

### Minor
1. **P0-2 gate is environment-flaky, not code-defective.** `.tmp/gates-p0-pairing-tablet-r2-all.out:4672-4678` records one failure: `EADDRNOTAVAIL` on `192.168.137.1` (a non-bindable virtual 192.168.x interface picked by `findLan()` in `p0-pairing-listener-truth.test.mjs:238-249`). The same case passes in the clean joint gate (`gates-p0-pairing-tablet-all.out`, P0-2 `✔ 202.74ms`) and in the latest gate (`gates-rc3.out`, `✔ 202.53ms`). Test-only risk; no product assertion was relaxed.
2. **Fresh `tsc --outDir` was not independently re-run by this reviewer** (no-build constraint). For `dist/**/*.js` parity I rely on build-window evidence: all staged sources were last edited by 19:44, all staged dist twins were regenerated at 19:55, every runtime test imports `dist/**` and passes, and marker strings match one-for-one in each src/dist pair (see checklist 5). `dist/client.js` parity *is* independently re-derived (byte-exact hash above). Byte counts for every staged dist file are reported in checklist 5.
3. **Explicit-override availability is still consulted via the seam.** `pairingProvision.ts:440-444` calls `selectPairingTransport()` to *refuse* an unavailable requested transport; this is an enumeration read but never feeds the payload host (`transport`/`host` come from `live.address` at `:448`, `:458-477`). Noted so the reader does not mistake it for the removed enumeration-sourced payload path.

### Nit
1. `pairingTransport.ts:5` still says an unavailable override "回落到自动选择（绝不给出死地址）"; that is true only for the candidate-display path, while provisioning/show now refuse with typed codes (`:223-232`, `:440-444`). Documentation drift preserved from the single-module review.
2. `client.js:4567` writes `'E_LISTENER_NOT_RUNNING：' + tr('lean.remote.start')` (code + call-to-action) instead of the engine's canonical Chinese reason 「监听器未启动，不能生成配对二维码」; the engine path carries the full reason, so this is cosmetic.
3. `dist/remote/types.js` is intentionally **unchanged**: the `types.ts` delta is a type-only `RemoteStatus.tls` field (`:171-173`), erased at compile time. Do not flag the missing dist twin as drift.

## Exact stage set

Owner key: **TLS** = `mod-remote-tls-termination`; **LT** = `mod-pairing-listener-truth`; **shared** = runtime dependency used by both. "Runtime-required" = must be in the commit for the plugin to run/behave correctly (tests = No; type-only = No at runtime but needed for the build). Dist parity = staged dist twin relationship, with byte count where staged.

| Path | Owner | Runtime-required? | Dist parity |
|---|---|---|---|
| `packages/dsh-dots/src/remote/listener.ts` | TLS | Yes | `dist/remote/listener.js` — markers match; 41,412 B |
| `packages/dsh-dots/src/remote/service.ts` | shared (TLS delta; bound-address chain consumed by LT) | Yes | `dist/remote/service.js` — markers match; 24,038 B |
| `packages/dsh-dots/src/remote/types.ts` | TLS | No — type-only | none — type-only; `dist/remote/types.js` unchanged (1,089 B) is correct |
| `packages/dsh-dots/src/remote/urls.ts` | TLS | Yes | `dist/remote/urls.js` — markers match; 19,737 B |
| `packages/dsh-dots/src/remote/pairingTransport.ts` | LT + TLS | Yes | `dist/remote/pairingTransport.js` — markers match; 7,154 B |
| `packages/dsh-dots/src/remote/pairingPayload.ts` | LT | Yes | `dist/remote/pairingPayload.js` — markers match; 16,875 B |
| `packages/dsh-dots/src/remote/pairingProvision.ts` | LT (with TLS cert/TLS gates) | Yes | `dist/remote/pairingProvision.js` — markers match; 18,683 B |
| `packages/dsh-dots/src/index.ts` | LT | Yes | `dist/index.js` — markers match; 6,133 B |
| `packages/dsh-dots/src/client.js` | LT | Yes (browser half) | byte-identical to `dist/client.js`, SHA-256 prefix `C1EC6821F83B5C0E`, 205,972 B |
| `packages/dsh-dots/dist/remote/listener.js` | TLS | Yes (runtime artifact) | matches staged source (41,412 B); fresh tsc not re-run here |
| `packages/dsh-dots/dist/remote/service.js` | shared | Yes | matches staged source (24,038 B) |
| `packages/dsh-dots/dist/remote/urls.js` | TLS | Yes | matches staged source (19,737 B) |
| `packages/dsh-dots/dist/remote/pairingTransport.js` | LT + TLS | Yes | matches staged source (7,154 B) |
| `packages/dsh-dots/dist/remote/pairingPayload.js` | LT | Yes | matches staged source (16,875 B) |
| `packages/dsh-dots/dist/remote/pairingProvision.js` | LT | Yes | matches staged source (18,683 B) |
| `packages/dsh-dots/dist/index.js` | LT | Yes | matches staged source (6,133 B) |
| `packages/dsh-dots/dist/client.js` | LT | Yes | fresh `renderClientSource()` = byte-exact, 205,972 B |
| `packages/dsh-dots/locale/zh.json` | LT | Yes (UI copy, exported via `package.json`) | n/a |
| `packages/dsh-dots/locale/en.json` | LT | Yes (UI copy) | n/a |
| `packages/dsh-dots/test/pairing-client-wiring.test.mjs` | LT (H7 retarget) | No | n/a |
| `packages/dsh-dots/test/p0-pairing-listener-truth.test.mjs` (new) | LT | No | n/a — 8 cases |
| `packages/dsh-dots/test/remote-tls.test.mjs` (new) | TLS | No | n/a — 5 cases |
| `packages/dsh-dots/test/remote-integration.test.mjs` | TLS (https retarget) | No | n/a |
| `packages/dsh-dots/test/remote-listener.test.mjs` | TLS (https/WS retarget) | No | n/a |
| `packages/dsh-dots/test/remote-model.test.mjs` | TLS (https retarget) | No | n/a |
| `packages/dsh-dots/test/remote-service.test.mjs` | TLS (cert seed + E_NO_TLS_CERT) | No | n/a |
| `docs/DETAIL.md` | neither — existing docs, unmodified at HEAD | No | n/a |

Count: 28 candidate paths. Every one is either TLS, LT, or shared-plugin; none is foreign. Note the candidate set is complete with respect to the modified plugin files — no other `packages/dsh-dots/**` source/dist/test/locale file is dirty at HEAD.

## Exclusions (must not ride)

Present in the working tree but **foreign to this commit**; stage none of them:

1. **All `apps/**`** — including `apps/arkui-schedule/AppScope/app.json5`, the deleted `entry/.test/**/intermediates/**` files, `model/pairingPayload.ts`, `model/remoteAnnounceRefresh.ts`, `pages/RemoteControl.ets`, `pages/panes/InstancesPane.ets`, `services/instanceStore.ets`, and all untracked `apps/...` additions. This is the tablet/app slice, not plugin bytes.
2. **RC-3 files** — `pages/RemoteControl.ets` (M), `components/PinnedRemoteView.ets`, `model/remotePinnedClient.ts`, `model/tlsPin.ts`, `tools/test/tlsPin.test.mjs`, plus `model/pairingProbe.ts`, `services/pairingProbeService.ets`, `services/remotePinnedClient.ets`, `tools/test/remotePinnedClient.test.mjs`, `tools/test/pairingReachability.test.mjs`. The pinned-client design is **not written into this commit**.
3. **Docs backfill (separate commit)** — `docs/MODULES.md`, `docs/ROADMAP.md`, `docs/SELF-TEST-REMOTE.md`. In particular `docs/MODULES.md:172` (the `mod-pairing-listener-truth` row, which already records "CONDITIONAL PASS / 0 Majors" and "unverified" status) belongs to the docs commit, not this one.
4. **`docs/REVIEW-*`** — every review document, including the two prior single-module reviews and this report.
5. `packages/dsh-dots/.tmp/**` gate logs are local evidence only, not stage material.

## Checklist

1. **HTTPS-only listener, fail closed — PASS.** `listener.ts:123` makes `tls:{cert,key}` required; `:745-750` rejects missing/empty material, `:758-767` rejects non-PEM shape, all with typed `E_REMOTE_TLS_SETUP_FAILED` (`:160`), before `listen()` at `:1146`; `:791-803` wraps the only `https.createServer` (`:795`) and typed-fails on bad key material — no `http.createServer` exists. `x-forwarded-proto` is rewritten to `https` at `:456` (verified `:452-460`) and absolute `location` to `https` at `:497` (`:479-497`), so the tablet is never 302'd to plaintext. `service.ts:415-421` sets typed `E_NO_TLS_CERT` and returns before `startListener` when `readCert()` is null; `status.tls` is true only when `handle !== null` (`:331-332`).
2. **Bound-address truth end-to-end — PASS.** Chain is real: `listener.ts:1164 server.address()` → `:1179-1180` handle `{port,address}` → `service.ts:320-323 {running,boundAddress,port}` → `index.ts:118-130` lazy `listenerState` with `address: status.boundAddress` at `:125` → `pairingProvision.ts:448-476`. No stale enumeration path in `show()`: transport comes from `transportOfBoundAddress(live.address)` (`:448`), host/port/fingerprint from `live.address`/`live.port`/cert (`:458-477`); `show()` refuses `E_LISTENER_NOT_RUNNING` at `:428-434` **before** building any payload/text/QR (`:469-484`), also refuses `E_LISTENER_TLS_NOT_READY` at `:435-437`; family is validated inside `buildPairingPayload` via `assertPairingTransportHostFamily` (`pairingPayload.ts:316-335`). Mode+address+port persist once after success via `persistEndpoint` (`pairingProvision.ts:191-198`, called at `:337-341`). `TRANSPORT_REFUSAL` (`pairingTransport.ts:84-88`) drives typed refusal at `pairingProvision.ts:225-232` and `:440-444`; `E_TRANSPORT_MISMATCH` at `:452-457`.
3. **Start/stop truth — PASS.** Exactly one `remoteStart` in the lean slice (`client.js:4664`; the other occurrence at `:3610` is the pre-existing non-lean panel). Failure sets typed code + Chinese reason, `setRunning(false)`, `setShown(null)` (`:4670-4677`); `remote-running` row honest (`:4765-4767`); stop clears QR (`setShown(null)` at `:4647`); stopped state renders no QR/copy and shows 「开始接受连接」 (`:4777-4805`).
4. **TLS plugin-side only; tablet pinning NOT in this commit — PASS (scope).** Proven here: the server serves HTTPS with the generated cert and the leaf SHA-256 fingerprint equals the pairing pin (`remote-tls.test.mjs:176-194`); plaintext HTTP/raw bytes cannot get a 200 from the TLS port (`:196-224`); cert-swap is detected at the model level as `E_PAIRING_FINGERPRINT_MISMATCH` (`:245-258`). Unverified and out of scope: the tablet's `onSslErrorEventReceive` path (lives only in `apps/arkui-schedule/entry/src/main/ets/pages/RemoteControl.ets:220,517`, excluded) and the RC-3 pinned-client design (`remotePinnedClient.ts` / `tlsPin.ts` / `PinnedRemoteView.ets`), which is not written yet. No slice file claims device verification.
5. **Dist parity — PASS with stated evidence.** `dist/client.js` = fresh `renderClientSource()` byte-for-byte: SHA-256 prefix `C1EC6821F83B5C0E`, 205,972 B for both `src/client.js` and `dist/client.js`; gate test `dist/client.js 与 build.mjs 新鲜构建输出逐字节一致` passes (`gates-p0-pairing-tablet-all.out`). This reviewer did **not** run `build.mjs` (no-build constraint); parity for the compiled twins is taken from the build window (last src edit 19:44, dist regenerated 19:55), one-for-one marker parity in every staged src/dist pair, and passing runtime tests that import `dist/**`. Staged dist byte counts: listener.js 41,412; service.js 24,038; urls.js 19,737; pairingTransport.js 7,154; pairingPayload.js 16,875; pairingProvision.js 18,683; index.js 6,133; client.js 205,972. `dist/remote/types.js` unchanged (1,089 B) is correct for a type-only source delta.
6. **Tests (plugin-only) — PASS.** `remote-tls.test.mjs`: 5 cases (`:176,196,226,245,260`); `p0-pairing-listener-truth.test.mjs`: 8 cases (`:70,209,220,270,327,344,365,385`). Retargeted `remote-{integration,listener,model,service}.test.mjs` and `pairing-client-wiring.test.mjs` H7 are plugin-side (all imports `../dist/...`, no `apps/**`). Gate counts read (not re-run): clean joint gate `gates-p0-pairing-tablet-all.out` — 3,788 tests / 3,787 pass / 0 fail / 1 skipped, with P0-1a, P0-2 (real bind, 202.74 ms), P0-6, all five TLS cases, H7 and the `dist/client.js` parity test all `✔`; TLS-only gate `gates-plugin-only-tls.out` — 684 / 683 / 0 / 1 skipped; latest `gates-rc3.out` — 3,808 / 3,806 / 1 fail, the single failure being an app-side `exportJson.test.mjs` determinism test (excluded), with all in-slice cases `✔`. The app suite was not run by this review.
7. **No app-side claim — PASS.** No claim of device verification exists in any staged plugin source, dist, locale, or test file; the only 「真机」 mentions in the plugin tree are pre-existing comments that require confirmation *from* a real device (`probe.ts:120,1458`, `urls.ts:284`). `docs/MODULES.md:172` (listener-truth row) is explicitly assigned to the docs commit, not this one.

## Residual risk & unverified

- Tablet TLS acceptance (`onSslErrorEventReceive`, fingerprint pin enforcement on the device) is **unverified** here and deliberately outside this commit; the plugin proves only what it can observe locally (HTTPS served with the generated cert, no plaintext 200, model-level cert-swap detection).
- RC-3 pinned-client design is not written; no claim about it is made.
- Fresh `tsc --outDir` byte equality for the compiled twins was not re-derived by this reviewer; evidence is the build-window regeneration + marker parity + passing runtime imports. `dist/client.js` parity is independently proven.
- P0-2 depends on a bindable `192.168.x` interface; one historical gate log shows an environment-only `EADDRNOTAVAIL` failure that later passes.
- Legacy `remoteShowLink` (outside the candidate set) still has no listener-running gate; that is a dormant legacy surface, not the lean pairing path, and is unchanged by this commit.

## Evidence log

- `git rev-parse HEAD` → `1d640ec0258b52494295471e0175c181ba3ebd56`; `git status --short` → dirty tree with the plugin slice plus the foreign/RC-3/docs changes listed under *Exclusions*; `git diff --stat HEAD -- <plugin paths>` → 24 modified files, 849 insertions / 116 deletions, plus 2 new test files.
- Source diffs read in full: `listener.ts`, `service.ts`, `types.ts`, `urls.ts`, `pairingTransport.ts`, `pairingPayload.ts`, `pairingProvision.ts`, `index.ts`, `client.js`, `locale/{zh,en}.json`, and all seven modified/new tests — no foreign hunk found.
- Line-level checks: `listener.ts:123,745-767,791-803,795,1146,1164`; `service.ts:320-323,331-332,415-421`; `index.ts:118-130`; `pairingProvision.ts:191-198,225-232,337-341,428-444,448-477`; `pairingTransport.ts:84-88`; `pairingPayload.ts:316-335`; `client.js:4564-4569,4647,4662-4685,4765-4767,4777-4805`.
- `grep` confirmations: only `https.createServer` in `listener.ts` (`:795`); `rpcCall('remoteStart')` once in the lean slice (`client.js:4664`); `onSslErrorEventReceive` only under `apps/**`; no device-verification claims in staged plugin files.
- Dist checks: SHA-256 prefix + byte count for `src/client.js` / `dist/client.js`; marker-string presence in each staged src/dist pair; dist mtimes 19:55 vs source mtimes ≤19:44; gate test `dist/client.js 与 build.mjs 新鲜构建输出逐字节一致` passing.
- Gate logs read (not executed): `.tmp/gates-plugin-only-tls.out`, `.tmp/gates-plugin-tls.out`, `.tmp/gates-p0-pairing-tablet-all.out`, `.tmp/gates-p0-pairing-tablet-r2-all.out`, `.tmp/gates-rc3.out`.
