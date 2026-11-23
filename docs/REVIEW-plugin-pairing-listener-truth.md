# Review — mod-plugin-pairing-listener-truth

## Verdict
CONDITIONAL PASS — At code level the P0 is closed (no stopped-state QR/payload, payload derived from the real bound address, typed refusals instead of silent fallback, and a single start control with honest failure reporting), but fresh-build regeneration and real-device/GUI pairing remain unverified under this read-only, no-build review. Major findings remaining: 0

## Findings

### Blocker
None. None of the four catastrophic outcomes in the brief reproduces in the reviewed source:

- A stopped listener cannot yield a QR or copyable pairing payload from the lean panel: `src/remote/pairingProvision.ts:428-434` throws typed `E_LISTENER_NOT_RUNNING` before any payload/text/QR is built at `:469-484`; `src/client.js:4566-4569` refuses `fetchQr` on `running !== true`, and `doCopy` (`:4589-4607`) goes through the same `fetchQr`. Mount never calls `pairingShow` (`src/client.js:4530-4554`, verified by W1/P0-1b). The RPC wrapper does not add a second secret exit: `src/rpc.ts:849-851` returns only `pairingViewOf(...)` (desensitized, `:831-847`) for `pairingProvision` and `pairingRotateToken`; only `pairingShow` returns payload+QR (`:853-855`). State holds `{qr}` only (`:4580`), cleared on stop (`:4647`) and on both failed and successful start (`:4676`, `:4682`).
- The payload cannot come from interface enumeration in `show()`: `src/remote/pairingProvision.ts:448` derives `transport` via `transportOfBoundAddress(live.address)`, and `:469-477` builds it from `live.address` / `live.port` / cert fingerprint. The seam is used only for candidate display and for the availability refusal at `:440-445`, never to pick the bound host.
- A requested transport can no longer be silently substituted: `pairingTransport.ts:84-88` defines `TRANSPORT_REFUSAL`; `pairingProvision.ts:225-232` (provisioning) and `:440-444` (show) throw typed refusal with no LAN fallback; a persisted `mode` that disagrees with the bound address throws `E_TRANSPORT_MISMATCH` at `:452-457` (and `:455-457` for the requested override).
- Start failure cannot look like success: `client.js:4662-4685` handles both `ok:false` (`:4665-4667`) and `ok:true` + `running !== true` + `lastError` (`:4670-4677`), setting `setRunning(false)` and `setShown(null)`, and the `remote-running` row (`:4765-4767`) is driven by `stopped = running !== true` (`:4689`).

### Major
None.

### Minor
1. **Fresh-build claims are unverified in this review.** `dist/client.js` is byte-identical to `src/client.js` (SHA-256 prefix `C1EC6821F83B5C0E`, 205,972 B each), and every new gate is present in the dist TS twins (`dist/remote/pairingProvision.js:271,274,281,286,288,291,294,298,307`; `dist/remote/pairingTransport.js:56-59,69`; `dist/remote/pairingPayload.js:268-286`; `dist/index.js:53-61`), so no drift was detected. However the brief's "fresh render 205,972 B == fresh render" and "fresh `tsc --outDir` 68 files / 0 mismatch" cannot be re-derived without running a build, which this read-only assignment forbids; no tsc artifact exists in `packages/dsh-dots/.tmp/` for this mod.
2. **"No artifact while stopped" is not a global plugin invariant.** Legacy `remoteShowLink` (`src/rpc.ts:784-786`) still returns a token-bearing `RemoteLink` with no listener-running gate. It belongs to the dormant legacy `RemotePanel`, is not reachable from the lean `DotsPanel`, and produces a link (not the enumeration-based pairing QR of the P0), so it does not reintroduce this P0 — but the stronger claim should be scoped to the lean pairing surface.
3. **Tailscale bound-address family lacks an end-to-end bind test.** P0-2 is a real bind + TCP connect, but only for `lan`; P0-4/P0-5 use injected `listenerState`. A Tailscale-mode bind whose `server.address()` is not a `100.64/10` IPv4 (e.g. an IPv6 tailnet address) would be refused with `E_TRANSPORT_HOST_MISMATCH` / `E_TRANSPORT_MISMATCH`. This is fail-closed (no false QR), but it is a real-device-only risk.

### Nit
1. `src/client.js:4567` writes `'E_LISTENER_NOT_RUNNING：' + tr('lean.remote.start')` — a code plus call-to-action rather than the engine's canonical Chinese reason 「监听器未启动，不能生成配对二维码；请先点击「开始接受连接」」. Harmless; the engine path carries the full reason.
2. `src/remote/pairingTransport.ts:5` comment still says an unavailable override "回落到自动选择（绝不给出死地址）". That is true only for the candidate-display path; provisioning now refuses (`:223-232`). Documentation drift, not behaviour.

## Checklist

1. **Stopped ⇒ no artifact — PASS.** `pairingProvision.ts:428-434` typed gate before any QR/text is built (`:469-484`); `rpc.ts:853-855` routes `pairingShow` through it; `client.js:4566-4569` gates `fetchQr`, `:4589-4607` gates copy, `:4647/:4676/:4682` clear cached QR; `rpc.ts:831-847` desensitizes `pairingProvision`/`pairingRotateToken` so no payload/text crosses to the client. P0-1a/b/c and W1 pass in the gate log.

2. **Running ⇒ truth — PASS.** `pairingProvision.ts:448` bound-address→transport, `:452-457` cross-check persisted `mode` and requested override, `:458-479` payload from bound host/port/fingerprint; family pinned at `:460` and inside `buildPairingPayload` (`pairingPayload.ts:316-335`); `persistEndpoint` (`:191-198`) writes mode+address+port in one transaction only after success (`:337-341`). Bound chain: `listener.ts:1164` (`server.address()`) → `:1179-1180` → `service.ts:320-323` → `index.ts:118-130` lazy projector → `pairingProvision.ts:448-476`.

3. **Refusal instead of substitution — PASS.** `pairingTransport.ts:84-88` (`E_NO_IPV6_ADDRESS`, `E_NO_TAILSCALE_ADDRESS`, `E_NO_LAN_ADDRESS`); override availability refused at `pairingProvision.ts:225-232` and `:440-444`; mismatch ⇒ `E_TRANSPORT_MISMATCH` at `:452-457`; persist happens only after all steps succeed (`:337-341`). P0-3/P0-5 assert the typed code and unchanged `remote.json.mode`.

4. **Start path — PASS.** `client.js:4662-4685` is the single `remoteStart` call in the lean slice (`:4664`); P0-6 (`p0-pairing-listener-truth.test.mjs:385-397`) and H7 (`pairing-client-wiring.test.mjs:652-654`) assert exactly one; failure writes typed code + Chinese reason (`:4670-4677`) and `setRunning(false)`/`setShown(null)`; `remote-running` row at `:4765-4767` cannot say 已启动 when `running !== true`.

5. **Tests — PASS.** Eight cases exist: P0-1a/1b/1c, P0-2, P0-3, P0-4, P0-5, P0-6 (`p0-pairing-listener-truth.test.mjs:70,209,220,270,327,344,365,385`). All eight **ran and passed** in the gate log (P0-2 real bind 243.4 ms — it was not the skipped case). Each is counterfactual-failing on the baseline: no `listenerState`/gate, no start control, enumeration QR, silent override fallback, port-only persistence. H7 is a positive guard (`pairing-client-wiring.test.mjs:623-655`: stopped has start/no QR, running has stop). Grep of `test/*.mjs` found no other test asserting the old ban; the only skip is an unrelated proxy-dependent fetch test (`NODE_USE_ENV_PROXY` / `HTTP_PROXY`).

6. **Lean inventory — PASS.** `client.js:4833-4844` still has exactly two `<details>` groups (`dots`, `dots-remote`); the remote group renders 方式 (`:4736-4759`), 二维码+复制 only when running (`:4778-4783`), 自检 (`:4788`), 开始或停止 (`:4793-4805`), audit (`:4809-4817`); no `input` in the remote group (W8 and `client-remote-render.test.mjs:943-963`); derived login line is a `div` at `:4433-4434`.

7. **Build/dist — CONCERN.** Gate tail verified: `ℹ tests 725 / pass 724 / fail 0 / skipped 1` in `.tmp/gates-p0-pairing-plugin.out` (matches 725/724/0/1; baseline 713/706/6/1 per `docs/MODULES.md:175`); `dist/client.js` = 205,972 B = `src/client.js` byte-for-byte; dist TS twins carry all new logic. Fresh-render equality and fresh `tsc` 68-file/0-mismatch are not re-verifiable under the no-build constraint (see Minor 1).

8. **Copy audit — PASS.** All new Chinese strings are generic (typed codes at `pairingProvision.ts:433,436,450,453,456,459,468` and `pairingTransport.ts:85-87`; `pairingPayload.ts:318,325,328`); none interpolate a host, token, PEM or path value. Direct scan of the 7 scope files for 防中间人 / 中间人 / MITM / man-in-the-middle / 防嗅探 / 防窃听 returned zero hits; W16 (`pairing-client-wiring.test.mjs:522-535`) passes.

## Residual risk & unverified

- **No device/GUI verification.** `docs/MODULES.md:172` itself marks the mod "未装机 / GUI + 真机配对 unverified". No tablet scan, real 44996 bind on the user's machine, or reload-based GUI confirmation was observed; the P0-2 real bind is a harness loopback/LAN test only.
- **No fresh build.** All dist claims are inferred from checked-in artifacts and source/dist byte comparison; a fresh `tsc --outDir` (68 files / 0 mismatch) and fresh render were not run because this assignment forbids builds.
- **Tailscale/IPv6 bound family** on a real device (Minor 3) and the `remote.json.enabled` persistence semantics of `remoteStart` (service/lifecycle code is out of scope) were not independently inspected.
- The legacy `remoteShowLink` token-bearing exit (Minor 2) remains on the dormant panel; if a future change re-exposes that panel, a stopped-state artifact could reappear outside the lean surface.
- Counterfactual "all 8 fail on the pre-change tree" is reasoned from the baseline behaviour described in the brief (no start, unchecked `pairingShow`, enumeration QR, silent override fallback, port-only persistence), not executed against a baseline checkout.

## Evidence log

- Read-only source review: `src/client.js:4530-4818` (fetchQr, doStop, doStart, rows, buttons), `src/index.ts:109-140`, `src/rpc.ts:748-797,804-872`, `src/remote/pairingProvision.ts:191-198,215-239,241-351,371-504`, `src/remote/pairingTransport.ts:73-107,184-227`, `src/remote/pairingPayload.ts:308-346`, `src/remote/listener.ts:1140-1187`, `src/remote/service.ts:308-334`.
- Tests read: `test/p0-pairing-listener-truth.test.mjs` (full, 8 cases), `test/pairing-client-wiring.test.mjs` (H7 at 623-655, W16 at 522-535), `test/client-remote-render.test.mjs:938-972`, grep over `test/*.mjs` for the old-ban wording (none found).
- Copy/record: `locale/zh.json:296-328`, `locale/en.json:296-328`, `docs/MODULES.md:172` (decision row).
- Gate evidence: `packages/dsh-dots/.tmp/gates-p0-pairing-plugin.out` tail (`tests 725 / pass 724 / fail 0 / skipped 1`, all eight P0 lines ✔, skip = unrelated proxy fetch test).
- Artifact checks (read-only PowerShell): `[System.IO.File]::ReadAllLines` → 4,898 lines and 205,972 B for both client.js copies; `Get-FileHash` → identical `C1EC6821F83B5C0E…` for both; grep of dist TS twins for all new typed codes and gates; MITM-term scan of 7 scope files → no hits.
- No files were created, modified or deleted other than this report; no build, overlay, git write, subagent or device command was issued.
