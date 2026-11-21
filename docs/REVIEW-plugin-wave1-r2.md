# Plugin wave 1 re-review (r2, focused)

Scope: independent READ-ONLY re-review of the DSH plugin package (`packages/dsh-dots`) only. Verdict of r1 (`docs/REVIEW-plugin-wave1.md:5-7`) was CONDITIONAL PASS / 0 Major / 3 Minor; this pass verifies only the three fixes plus checks 4–8 from the brief. HEAD `0f48c37e237f09b558bfdba0cf76d081bb2ccc40`; the plugin wave is still uncommitted. No build script run, no overlay, no git writes, no subagents, no repo `dist/` write. All citations are `file:line` relative to the repo root.

## Verdict

PASS — all three Minors from r1 are genuinely closed (bounded body by real bytes, one shared whitelist projection on every returning path, per-row `decidedAt` from each loser's own ts), with the full suite at 511/510/0/1 and all nine shipped `dist` files byte-identical to a fresh `tsc`; no cap bypass or whitelist leak found. **Major findings remaining: 0**

## M1 / M2 / M3

### M1 — bounded response body size: CLOSED

Evidence, claim by claim:

- **(a) cap constant + early `Content-Length` reject.** `src/rpc.ts:165` declares `REMOTE_RESPONSE_MAX_BYTES = 4 * 1024 * 1024`; `src/rpc.ts:801-805` reads `headers.get('content-length')` and throws `tooLarge()` when `Number.isFinite(announced) && announced > cap`, before any body read.
- **(a2) typed error, detail shape.** `src/rpc.ts:786-793` `tooLarge()` calls `remoteToolError(REMOTE_TOOL_ERROR_CODES.REMOTE_TOO_LARGE, …, { instanceId, tool, limit: REMOTE_RESPONSE_MAX_BYTES })` — only those three numeric/string fields; the code is defined at `src/remote/toolErrors.ts:28`, the detail type forbids url/token/body at `src/remote/toolErrors.ts:33-40`, and `E_REMOTE_TOO_LARGE` is in the inbound-code whitelist at `src/remote/toolErrors.ts:59`.
- **(b) header not trusted; real bytes counted and cancelled.** `src/rpc.ts:808-838` obtains `response.body.getReader()`; `src/rpc.ts:814-825` accumulates `value.byteLength` into `total`, and the instant `total > cap` calls `reader.cancel('response-too-large')` (`:820`) then throws; `src/rpc.ts:828-838` releases the lock in `finally`. A lying or absent `Content-Length` cannot short-circuit this path — the early check at `:804` only *adds* a rejection, it never permits extra bytes.
- **(c) fallback still re-checks real bytes.** `src/rpc.ts:845-855`: when no reader exists, `response.arrayBuffer()` is awaited and `buffer.byteLength > cap` throws at `:853` before parsing.
- **(d) parse only after bounding; no `response.json()` anywhere.** The single call site is `src/rpc.ts:923` → `readCappedBody()`; `JSON.parse` occurs only at `src/rpc.ts:859` on the assembled, bounded `bytes`. `json()` remains declared on the injectable interface at `src/rpc.ts:78-85` purely for fake compatibility (comment at `:76`), but a grep for `.json()` / `response.json` over `src/rpc.ts` returns **no matches**. The only other `JSON.parse` in `rpc.ts` is `:1149`, on the inbound HTTP request body already capped by `MAX_BODY_BYTES` (`src/rpc.ts:155`, read loop `src/rpc.ts:1080-1107`). No path parses unbounded bytes.
- **Tests genuinely exercise lying/missing header with a truly oversized body.** `test/remote-readonly-rpc.test.mjs:58-83` `oversizedResponse()` allocates `RESPONSE_CAP + 64` real bytes at `:59` and returns them as the first stream chunk at `:70-73`; `json()` throws if ever called (`:80`). Test `test/remote-readonly-rpc.test.mjs:291-301` uses an over-cap header and asserts 0 reads; test `test/remote-readonly-rpc.test.mjs:303-314` loops `[{}, { 'content-length': '16' }]` — missing header and a header that *lies small* — and asserts `E_REMOTE_TOO_LARGE`, exactly 1 read (`:310`) and `cancel()` called (`:311`). So the body is really larger than the cap in every case; the tests would fail against a header-only implementation.

### M2 — shared whitelist projection: CLOSED

- **One projector per action + dispatcher:** `src/remote/projection.ts:91-105` (`projectInstanceList`), `:108-127` (`projectSessionList`), `:130-139` (`projectSessionInfo`), `:142-159` (`projectSessionEvents`), dispatch at `:162-173`, action union at `:15`, `PROJECTED_KEY_SETS` exported at `:176-181`.
- **Both paths for all four actions:** `sessionList`/`sessionInfo`/`sessionEvents` are projected on the local branch at `src/rpc.ts:884` and on the peer branch at `src/rpc.ts:933`; `instanceList` has no remote transport by design and is projected on its only (local) path at `src/rpc.ts:962`. Hence every returning path projects.
- **Injected fields cannot survive:** each projector builds a fresh object from named fields only — e.g. `src/remote/projection.ts:114-124`, `:132-138`, `:149-155`. `instanceId` is force-overridden at `:120`, `:133`, `:146`; `lease`/`owner` forced `null` at `:122`, `:136-137`; nested objects are discarded because `asRecord` + `asSafeString`/`asSafeInt` (`:72-84`) coerce to primitives, and `capabilities` filters to strings (`:100-102`). `token`/`apiKey`/`path`/nested `data` have no output slot. The old wholesale `withInstanceId()` spread flagged in r1 (`rpc.ts:749-767` at the time) is gone — grep for `withInstanceId`, `...record`, `...data` over `src/rpc.ts` returns no matches.
- **Truncation/cap is inside projection, before return, and cannot bypass the whitelist:** `safeText()` slices to `MAX_PROJECTED_TEXT_CHARS = 2000` (`src/remote/projection.ts:67-68`, `:86-88`), applied at `:116`, `:152-153`; array caps of 500 at `:70`, `:93`, `:101`, `:112`, `:147`. These are value transforms on already-whitelisted keys; they add no key and cannot reintroduce a dropped field.
- **Tests assert exact key sets, not just absence:** `test/remote-readonly-rpc.test.mjs:318-339` compares `Object.keys(result.data).sort()` to `PROJECTED_KEY_SETS.sessionList` (`:330`) and the item keys to a literal array (`:331-333`), then separately asserts the injected strings are absent (`:334-337`) and `instanceId` overridden (`:338`). `test/remote-readonly-rpc.test.mjs:341-365` does the same for `sessionInfo`/`sessionEvents` (`:349`, `:362`, `:363`) including nested `lease`/`data` objects. `test/remote-readonly-rpc.test.mjs:367-378` proves local and remote shapes are identical through `projectReadResult` (`:372-376`).

### M3 — per-row `decidedAt`: CLOSED

- **Port matches the app conversion and fallback:** `src/timeline/records.ts:889-912` derives `loserTs` per losing row from that row's own canonical line (`:896` default to `resolution.ts`, `:898-904` extract `.ts`, `:908` emit) and passes `decidedAtFromTs(loserTs)`; `decidedAtFromTs` at `src/timeline/records.ts:859-866` is byte-for-byte the app's `decidedAtOf`: `Date.parse(ts)` → `new Date(ms).toISOString()` if valid, **verbatim `ts` otherwise**, no wall clock. App reference: `apps/arkui-schedule/entry/src/main/ets/model/syncProtocol.ts:294-300` (`decidedAtOf`), `:595-596` (`conflictsLine(..., decidedAtOf(ts, now))`), `:641` (`addConflict(id, loser.ts, ...)` — loser's own ts). The plugin must parse the canonical line only because it holds the line rather than the record object; the documented fallback to `resolution.ts` (`src/timeline/records.ts:885-886`, `:905-907`) preserves no-clock behaviour.
- **Test pins exact values and would fail a batch stamp:** `test/plugin-timeline-v2.test.mjs:556-589` builds three ties at three distinct ts (`:558-562`), pins expected `{ts, decidedAt}` triples at `:570-574`, compares each whole row byte-for-byte to `conflictsLine(...)` at `:577`, asserts `obj.decidedAt` exactly at `:581`, and deep-equals the three decided values `[ '2026-11-19T01:30:00.000Z', '2026-11-19T06:00:00.000Z', 'not-a-ts' ]` at `:583-586`. A single batch-stamped value cannot satisfy three distinct exact strings, so the regression is caught. The unparsable fallback is separately pinned at `test/plugin-timeline-v2.test.mjs:423` and `:573`/`:585`.

## New findings

### Blocker

None.

### Major

None.

### Minor

None.

### Nit

- **[N1] Truncation covers only the designated text fields, not every scalar.** `safeText()` is applied to `title` (`src/remote/projection.ts:116`), `type` and `text` (`:152-153`), but not to `nextCursor` (`:125`), `sha256` (`:119`, `:135`, `:157`), `sessionId`/`updatedAt`/`id`/`displayName`/`mode`/`urlMasked`/`time`. The r2 claim "text truncated 2000 chars" is true for the three text slots, and the module comment at `src/remote/projection.ts:12` describes the intent as "each text truncated, each array capped"; a hostile peer can still place a large string in a whitelisted scalar. This is **not** a whitelist leak and **not** a cap bypass — every scalar is still bounded by the 4 MiB response cap at `src/rpc.ts:165`/`:818-825`, and no extra key is added. Recorded for precision only.
- **[N2] Test 26 cannot distinguish "loser's own ts" from "resolution.ts".** By construction `TimelineResolution.ts` is the winner's ts and every equal-ts loser carries that same ts (`src/timeline/records.ts:587`, `:609`), so `test/plugin-timeline-v2.test.mjs:556-589` — which uses one loser per resolution — would also pass a `decidedAtFromTs(resolution.ts)` implementation. It still rejects the actual r1 defect (one value for the whole batch) and the shipped source does derive from each loser line (`src/timeline/records.ts:896-908`), so M3 is closed; this is a test-strength note, not a defect.

## Checklist

**4. Suite — PASS.** `node --test "packages/dsh-dots/test/*.test.mjs"` → `tests 511 / suites 0 / pass 510 / fail 0 / cancelled 0 / skipped 1 / todo 0`, exit 0, `duration_ms 37369.7956`. Exactly the expected `511 / 510 / 0 / 1` (+6 over r1's 505: 2 M1 + 3 M2 in `test/remote-readonly-rpc.test.mjs:291-314,318-378`, 1 M3 in `test/plugin-timeline-v2.test.mjs:556-589`). The single skip is the pre-existing proxy-environment case: re-running `test/remote-listener.test.mjs` alone gives `21 / 20 / 0 / 1`, skipped case "fetch 直连时：真实 fetch 断言状态码/正文/x-forwarded-for" with reason `NODE_USE_ENV_PROXY+HTTP_PROXY` set and `NO_PROXY` lacking the LAN address — unchanged from r1 (`docs/REVIEW-plugin-wave1.md:74`).

**5. dist freshness — PASS.** Fresh compile of current `src` with `node <repo>/node_modules/typescript/bin/tsc -p tsconfig.json --outDir <temp>` from `packages/dsh-dots` gave `TSC_EXIT=0`; SHA-256 comparison (first 12 hex) to the shipped files:

| file | temp | dist | len | result |
|---|---|---|---|---|
| `dist/rpc.js` | 0E8EDA01C54A | 0E8EDA01C54A | 47136 | SAME |
| `dist/remote/grants.js` | AAD13BF99230 | AAD13BF99230 | 20085 | SAME |
| `dist/remote/instances.js` | 2A902FA2B95F | 2A902FA2B95F | 7597 | SAME |
| `dist/remote/localRead.js` | 763078B59CD2 | 763078B59CD2 | 4112 | SAME |
| `dist/remote/projection.js` | D833FD9EFA19 | D833FD9EFA19 | 4347 | SAME |
| `dist/remote/toolErrors.js` | 27BF029235D2 | 27BF029235D2 | 2703 | SAME |
| `dist/timeline/index.js` | D0D0D9EAD6B6 | D0D0D9EAD6B6 | 428 | SAME |
| `dist/timeline/paths.js` | 800ED970E549 | 800ED970E549 | 4485 | SAME |
| `dist/timeline/records.js` | A85FAC84BCD2 | A85FAC84BCD2 | 30108 | SAME |

9/9 SAME; temp dir removed; repo `dist/` not written. The compiled fix is present in the shipped artifact — `dist/timeline/records.js:751-764` contains `loserTs` and `decidedAtFromTs(loserTs)`.

**6. No weakening — PASS.** Per-file counts are exactly `remote-grants.test.mjs` 12, `remote-readonly-rpc.test.mjs` 19, `plugin-timeline-v2.test.mjs` 26; the six added tests are purely additive. All r1-cited assertions remain intact: default-deny and no view→command derivation (`test/remote-grants.test.mjs:66-80`), revocation/expiry (`:82-102`), bad-envelope → empty table + typed problem (`:104-122`), per-instance isolation (`:124-129`), redacted view with `canPrompt === false` (`:141-148`), exact store path / no token / bad-file fallback (`:150-173`), userinfo rejection (`:196`); `E_UNKNOWN_ACTION` for all eight command/grant ids (`test/remote-readonly-rpc.test.mjs:242-253`), no token in error body or outbound request (`:269-279`), caller-URL allow-list (`:255-267`); byte-parity fixtures and v1→v2 divergence cases (`test/plugin-timeline-v2.test.mjs:92-93`, `:106-136`, `:171-172`, `:414-430`, `:487-548`). The M2 tests only *add* exact-key assertions; nothing was relaxed to make them pass.

**7. Scope — CONCERN (not attributable to this wave).** `git diff --name-only -- packages/dsh-dots/src/schedule packages/dsh-dots/src/index.ts packages/dsh-dots/cordis.patch.yml packages/dsh-dots/package.json` is **empty** — all four protected paths untouched. The plugin wave's own changed/new set is confined to `packages/dsh-dots`: `M src/rpc.ts`, `M dist/rpc.js`, five new `src/remote/{grants,instances,localRead,projection,toolErrors}.ts` with matching `dist/remote/*.js`, new `src/timeline/{paths,records,index}.ts` with `dist/timeline/*`, and three new tests. **However**, `git status` also shows `apps/arkui-schedule/.../model/instances.ts`, `pages/Index.ets`, `tools/test/{indexHeader,uiTokens}.test.mjs` modified — these are concurrent, unrelated module work (`mod-instances-drop-local` removes the app-side `local` row; the others are cloud-chat-pane/IA retargets), the same attribution r1 made at `docs/REVIEW-plugin-wave1.md:72`. The plugin wave itself touches no `apps/**` file; I did not review those concurrent diffs.

**8. Docs — PASS.** Registration has settled during this pass: `docs/MODULES.md` now carries the plugin-build/dist-freshness peer clause in §0 item 9, both rows in §1 (`mod-plugin-git-store`, `mod-plugin-remote-tools`), shared-file rows in §2, and verification rows in §5; `docs/ROADMAP.md` handover section has matching entries. Every claim the brief cares about is present and accurate: reader-only git-store ("只读半区 … 不写盘、不迁移、不重接线（无 writer / 原子替换 / v1→v2 路径迁移 / 工具重接线（`schedule_*` / `dsh_dots` 仍 v1）…）", `docs/MODULES.md` §1/§5); read-only remote-tools (four view actions, no `sessionPrompt`/`sessionCreate`/`session.lease.*`/`grant*`, `E_UNKNOWN_ACTION` default); compile evidence = plugin `node scripts/build.mjs` exit 0 **plus** committed `dist/` byte-identical to a fresh `tsc`, with stale `dist` treated as build failure; and both rows say explicitly "插件**未安装在任何设备上** / on-device `unverified`", repeated in §2/§5 and `docs/ROADMAP.md`. The docs' suite figure 511/510/0/1 matches my independent run. The `build exit 0` half is asserted by the docs owner and was **not** independently re-run here (forbidden); the dist-freshness half was independently verified (check 5).

## Residual risk & unverified

- No on-device / real DSH plugin installation exercised; static source review plus injected-`fetch` Node tests only, consistent with "未安装/unverified" in the docs.
- `node scripts/build.mjs` was not run (forbidden). Dist freshness was independently proven with a fresh `tsc` to a temp `--outDir` for all nine shipped files; the separate "build exit 0" claim in `docs/MODULES.md` was not re-verified.
- No live second-instance HTTP integration test: all RPC transport tests inject a fake `fetch`, so the streaming cap is validated against the fake reader in `test/remote-readonly-rpc.test.mjs:58-83` rather than a real `ReadableStream`.
- `readCappedBody`'s fallback (`src/rpc.ts:845-855`) buffers the whole `arrayBuffer()` before checking `byteLength`; it enforces the cap but cannot prevent a large allocation on that path. Real global `fetch` always exposes a body stream (`src/rpc.ts:193-195`), and both M1 tests inject `getReader()`, so the fallback is not the shipped path and does not permit a parse of unbounded bytes.
- Nit N1: non-text scalar fields are not 2000-char truncated; safety there rests on the 4 MiB cap.
- Nit N2: test 26 does not separate loser-ts from resolution-ts derivation; source review confirms the loser-line derivation is correct.
- The concurrent `apps/**` diffs were observed but not reviewed; they are outside this scope.
- Byte parity beyond the fixed fixtures remains inferred from source identity, as in r1 (`docs/REVIEW-plugin-wave1.md:84`); no differential fuzz was run.

## Evidence log

| # | Evidence | Result |
|---|---|---|
| E1 | `git rev-parse HEAD` | `0f48c37e237f09b558bfdba0cf76d081bb2ccc40` |
| E2 | Read `docs/REVIEW-plugin-wave1.md` in full | r1 verdict CONDITIONAL PASS, 0 Major, Minors M1/M2/M3 at `:21-25` |
| E3 | Read `src/rpc.ts` (1162 lines), `src/remote/projection.ts`, `src/remote/toolErrors.ts` | M1 (a)-(d) and M2 projector/dispatcher/wiring verified |
| E4 | `grep '\.json()\|withInstanceId\|\.\.\.record'` over `src/rpc.ts` | No matches — no bypass parse path, no wholesale spread |
| E5 | Read `test/remote-readonly-rpc.test.mjs` (378 lines) | M1 tests `:291-314` use `RESPONSE_CAP+64` real bytes + lying/missing header; M2 tests `:318-378` assert exact key sets |
| E6 | Read `src/timeline/records.ts:850-912`, app `syncProtocol.ts:288-300,585-649`, test `:405-431,550-589` | M3 per-loser derivation matches app `decidedAtOf` incl. verbatim fallback; exact-string test |
| E7 | `node --test "packages/dsh-dots/test/*.test.mjs"` | `511 / 510 / 0 / 1`, exit 0, 37369.7956 ms |
| E8 | `node --test remote-listener.test.mjs` filtered | skip is the pre-existing proxy-env LAN-fetch case |
| E9 | temp `tsc -p tsconfig.json --outDir <tmp>` + per-file SHA-256 | `TSC_EXIT=0`; 9/9 SAME; temp removed; repo `dist/` untouched |
| E10 | per-file `^test(` count | 12 / 19 / 26 = +6 over r1's 505 |
| E11 | `git status --porcelain`, `git diff --stat`, protected-path `git diff --name-only` | plugin set confined to `packages/dsh-dots`; four protected paths clean; concurrent `apps/**` and docs diffs present |
| E12 | `git diff -- docs/MODULES.md docs/ROADMAP.md` + purity grep over `src/timeline` | both registrations settled with required claims; no writer/fs/network/clock in timeline reader |
