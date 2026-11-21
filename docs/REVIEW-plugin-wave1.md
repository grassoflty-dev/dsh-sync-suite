# Plugin wave 1 review — mod-plugin-git-store + mod-plugin-remote-tools

Scope: DSH plugin package only (`packages/dsh-dots`), HEAD `73a63a7983af1a0ac27abe34643a2f53fafc34c4`. Read-only review; no build, no overlay, no git writes, no subagents. All line numbers are `file:line` relative to the repo root unless stated.

## Verdict

CONDITIONAL PASS — both modules are genuine, default-deny, byte-faithful and cleanly scoped (test budget exactly 505/504/0/1, dist byte-identical to fresh `tsc`), but three Minors remain, of which the unbounded remote response body is the only condition worth fixing before module registration. **Major findings remaining: 0**

## Findings

### Blocker

None.

### Major

None.

### Minor

- **[M1] `packages/dsh-dots/src/rpc.ts:826-831` — "bounded body size" HTTP discipline is not implemented.** The remote response is consumed by bare `await response.json()`; there is no `content-length` check, streaming byte cap, or size guard anywhere in `remoteRead()` (`rpc.ts:776-841`). The only bound is the 8 s `AbortSignal.timeout` at `rpc.ts:809`, which is a *time* bound, not a *size* bound; a fast allow-listed peer can still force unbounded memory growth. This is one of the four explicit items in check 9. **Required fix:** reject oversized bodies before `response.json()` (e.g. inspect `content-length` and/or read via a byte-capped stream), mapping the violation to `E_REMOTE_BAD_RESPONSE` through the existing `remoteToolError()` path; add one test that feeds a >limit body to the injected fetch.

- **[M2] `packages/dsh-dots/src/rpc.ts:840` (with `withInstanceId()` at `:749-767`) — remote response data is not whitelist-projected.** The local branch deliberately projects to a fixed field set (`packages/dsh-dots/src/remote/localRead.ts:8-10`, `:73-81`, `:96-102`, `:124-129`) so that no absolute path, raw tool argument or token can leave the adapter. The remote branch instead spreads the peer's entire `rpc.data` object via `{...record, items: record.items.map(...)}` and returns it unchanged. Under the documented trust model the peer is our own plugin and is safe, but a compromised/older allow-listed instance can inject arbitrary fields, defeating the stated output discipline. **Required fix:** pass remote `data` through the same whitelist projection used by `localRead` before returning (keep `withInstanceId`'s `instanceId` override as the anti-spoofing step).

- **[M3] `packages/dsh-dots/src/timeline/records.ts:883-894` — `conflictRowsFromResolutions()` takes a single `decidedAt` for every resolution.** The App derives `decidedAt` per conflict row from that row's own ts (`apps/arkui-schedule/entry/src/main/ets/model/syncProtocol.ts:595-596`, `decidedAtOf()` at `:294-300`), and the plugin's own comment at `records.ts:881` says the caller should use `decidedAtFromTs(res.ts)` — but the signature cannot express a per-resolution value. For a day with conflicts at several distinct ts values, every row would carry the same `decidedAt` (row key order and `dedupeKey` remain correct, so this is an audit-data accuracy issue, not a security one). **Required fix:** accept a `(ts: string) => string` mapper (or call `decidedAtFromTs(resolution.ts)` internally), preserving no-wall-clock behaviour.

### Nit

- **[N1] `packages/dsh-dots/src/remote/instances.ts:54`, test `remote-grants.test.mjs:196` — `sanitizeBaseUrl()` rejects userinfo rather than "stripping" it.** A URL with `user:pass@` returns `''` (fail-closed) instead of a userinfo-free base. The security property is *stronger* than the brief's wording, and the test honestly asserts rejection; no fix needed, but the registration doc should say "rejects userinfo" rather than "strips userinfo".

- **[N2] `packages/dsh-dots/test/plugin-timeline-v2.test.mjs:487-548` — the four v1→v2 divergence tests hardcode the v1 shape instead of reading the live v1 source.** They genuinely fail if the new module regresses to v1 behaviour (verified below), but they would not detect drift in `src/schedule/**` itself. Acceptable because v1 is frozen and untouched; note it as a scope limit.

- **[N3] `packages/dsh-dots/src/timeline/records.ts:770-772` — `E_CORRUPT` vs `E_SCHEMA_UNKNOWN` is chosen by substring-matching the Chinese reason text** (`marker.reason.includes('不是合法 JSON')`). Deterministic today and covered by `plugin-timeline-v2.test.mjs:402-408`, but brittle if the reason wording in `parseSchemaMarker()` (`:723-749`) ever changes. Prefer a structured reason code.

## Checklist

1. **Byte parity is real — PASS.** Fixture-by-fixture:
   - §3 example A: app `apps/arkui-schedule/tools/test/timelineRead.test.mjs:62` (`EXAMPLE_A`) → plugin `packages/dsh-dots/test/plugin-timeline-v2.test.mjs:92` (`APP_EXAMPLE_A`) — **identical** (same id/ts/title/body/author/done/media/ai_processed/opened_at, one-line JSON).
   - §3 example B: app `timelineRead.test.mjs:63` (`EXAMPLE_B`) → plugin `plugin-timeline-v2.test.mjs:93` (`APP_EXAMPLE_B`) — **identical** (includes the 16-hex media filename, full 64-hex SHA, `ocr_text`, `closed_at`).
   - Same two literals as `LINE_A`/`LINE_B`: app `apps/arkui-schedule/tools/test/timelineWrite.test.mjs:79-80` → plugin `plugin-timeline-v2.test.mjs:121-124` and `:130-136` — **identical**.
   - Whole-file container: app `timelineWrite.test.mjs:81-91` (`EXAMPLE_TEXT`) → plugin `plugin-timeline-v2.test.mjs:106-116` (`WRITE_EXAMPLE_TEXT`) — **identical** (including the final `''` element that produces exactly one trailing `\n`).
   - SHA constant: app `timelineWrite.test.mjs:59` → plugin `plugin-timeline-v2.test.mjs:51` — **identical** (`ab12cd34…5678`).
   - Empty-day + schema bytes: app `apps/arkui-schedule/entry/src/main/ets/model/freshStart.ts:13,16-18` → plugin `records.ts:131,752-754` and test `:171-173` — **identical**.
   - Test helper `dayFile` / `dayFileRaw`: app `timelineRead.test.mjs:34-46,49-59` → plugin test `:62-74,77-87` — **identical** byte-building logic.
   No fixture was invented by the plugin author; each is copied from the app's own tests or model source.

2. **Semantic parity with the reference — PASS** (no semantic divergence found):
   - Key order / optional omission: `records.ts:134-138,235-249` vs `apps/arkui-schedule/entry/src/main/ets/model/timeline.ts:137-141,239-253` — same 13-key `KEY_ORDER`, `hasOwn` gate, unknown keys appended in insertion order.
   - Escaping: `JSON.stringify` on both sides (`records.ts:248` / `timeline.ts:252`).
   - Whole-file container + exactly one trailing `\n`: `records.ts:290-313` vs `timelineWrite.ts:142-165` (same line assembly, indent, trailing comma rule and read-back self-check).
   - `open` derivation: `records.ts:271-283` vs `timelineWrite.ts:124-136`; `records.ts:841-850` vs `timeline.ts:768-778` — open iff `closed_at` absent/empty/whitespace/null; `done` and `day.open` never consulted.
   - Same-ts tie-break + audit row: `records.ts:563-620,217-227` vs `timeline.ts:528-586,221-231` — later ts wins, equal ts resolved by canonical-line UTF-8 byte order, identical lines collapsed; `conflictsLine` `records.ts:873-877` vs `syncProtocol.ts:381-385` — key order `id,ts,losingLine,decidedAt,dedupeKey`, `dedupeKey = sha256(losingLine)`. (Per-row `decidedAt` caveat: M3.)
   - `parseTimelineDay` rejection/drop: `records.ts:626-674,318-409,416-500` vs `timeline.ts:591-639,279-373,381-465` — directory date authoritative, fail-soft errors, bad elements/media dropped and counted, non-object top level → `day:null`.
   - Schema marker / fresh start vs `E_SCHEMA_UNKNOWN`: `records.ts:723-749,761-787` vs `timeline.ts:688-714` and `freshStart.ts:13,32-41` — only version 2 accepted; missing marker = fresh start; unknown version → `E_SCHEMA_UNKNOWN`, malformed JSON → `E_CORRUPT` (typed wrapper is plugin-side, behaviour documented at `records.ts:756-774`). The same-instant `compareTs` tie-break is the App's own documented "intentional superset" (`timeline.ts:28-31`), not a divergence.

3. **No collateral damage (Module A) — PASS.** `git status --porcelain` shows Module A artifacts only as untracked: `src/timeline/{paths,records,index}.ts`, `dist/timeline/*`, `test/plugin-timeline-v2.test.mjs`. No tracked file was modified by this module. `src/schedule/**`, `src/index.ts`, `cordis.patch.yml`, `package.json` have zero diff; the four tools remain registered and v1 at `src/schedule/tools.ts:149,209,263,326`.

4. **Purity — PASS.** `src/timeline/*` imports only `node:crypto` (`records.ts:23`) and local modules (`records.ts:24`, `paths.ts:21`); no fs, no network, no `console.*`, no module-level side effects. Grep for `Date.now|new Date()|readFile|writeFile|fetch(|process.` over `src/timeline` returned only the invariant comment at `records.ts:21`. `Date.parse`/`new Date(ms)` at `:163,861-865` operate solely on input strings.

5. **Test quality — PASS (25 cases).** Cases are comparisons, not tautologies: e.g. `:119-143` compares output to app-copied literals; `:487-501` asserts exact v2 key order and `notDeepEqual` to the v1 order; `:505-519` requires `buildRecordsText` to return `''` for a v1-shaped row lacking `media`; `:522-530` requires `done:true` without `closed_at` to be open and `done:false` with `closed_at` not to be open; `:534-548` requires a v1 JSONL file to be rejected at the top level and a v2 container accepted. All four divergence tests would fail under a v1 regression. Minor reservation N2.

6. **Default-deny is real — PASS.** `grants.ts:314-348` (`grantActive` = `grantedAt <= t < min(revokedAt, expiresAt)`, `isGranted` requires exact instance + exact tool, `canPrompt` only checks explicit `TOOL_SESSION_PROMPT`); `:450-475` bad envelope (JSON/shape/version/any bad record) → `items:[]` + typed problem, never throws; `:525-539` bad file → empty table. Tests: `remote-grants.test.mjs:55-80` (view allowed, command denied, no view→command derivation), `:82-102` (revocation/expiry boundaries), `:104-122` (all bad-envelope classes), `:124-129` (per-instance isolation), `:141-148` (redacted view, `canPrompt === false`). Note `canPrompt` can be true only when a grant *explicitly* lists the command tool (`remote-grants.test.mjs:77-80`), and no RPC action consumes it.

7. **No write action registered — PASS.** Full new switch block `rpc.ts:956-964`: exactly `instanceList`, `sessionList`, `sessionInfo`, `sessionEvents`; default at `:964` raises `E_UNKNOWN_ACTION`. `sessionPrompt`/`sessionCreate`/`sessionLease*`/`grant*` are absent from the whole diff. The test asserts this for real: `remote-readonly-rpc.test.mjs:182-193` loops over eight write/grant action ids and checks `result.ok === false` and `result.error.code === 'E_UNKNOWN_ACTION'` for each.

8. **Security — PASS (with M2 defense-in-depth caveat).** Grants at `<home>/.dsh/dots/instance-grants.json` via `grants.ts:520-521` + `engine/paths.ts:247-251`; test `remote-grants.test.mjs:155-160` pins the exact path, different-home inequality and `/\.dsh\/dots\/instance-grants\.json$/`, and forbids `work`. Mode 0600 file / 0700 dir at `grants.ts:479-492` and `instances.ts:77-95` (POSIX; Windows limitation honestly documented at `grants.ts:483`). No token field in envelope or serialisation (`grants.ts:435-444`, `instances.ts:97-100,181-184`), test asserts raw file lacks `token` at `remote-grants.test.mjs:163`. No `console.*` / `JSON.stringify(config)` in any new file (grep); typed messages carry only `instanceId?`, `tool?`, `status?` (`toolErrors.ts:31-45`). `sanitizeBaseUrl` deletes token-class query params and drops fragments/path (`instances.ts:43-61`); userinfo is rejected (N1). Allow-list cannot be bypassed: `resolveInstance` uses only the registry (`rpc.ts:736-743`), the outbound URL is rebuilt from `instance.baseUrl` with path/query/hash overwritten (`rpc.ts:790-797`), and the body forwards only whitelisted args with `instanceId:'local'` (`rpc.ts:808`; test `remote-readonly-rpc.test.mjs:195-207`). `localRead` takes no path at all — it matches `sessionId` by equality against scanner results and reads only `session.file` from that scanner (`localRead.ts:63-132`), so path traversal is structurally impossible.

9. **HTTP discipline — CONCERN.** Global `fetch` only (`rpc.ts:161-163`) with `AbortSignal.timeout(options.networkTimeoutMs ?? 8000)` (`:809`); no new dependency (`package.json` untouched); non-2xx → typed errors with no remote text (`:815-823`, only numeric `status` in details; test `remote-readonly-rpc.test.mjs:209-219` proves a remote `message` containing a token never reaches the error body). **Unmet:** bounded body size (M1) and the related remote projection gap (M2).

10. **dist freshness — PASS.** Compiled current source to a fresh temp outDir with `node ../../node_modules/typescript/bin/tsc -p tsconfig.json --outDir <tmp>` (exit 0), compared SHA-256 to repo `dist/`: `rpc.js` `D7BB3AE8…` SAME, `remote/grants.js` `AAD13BF9…` SAME, plus `remote/instances.js` `2A902FA2…`, `remote/localRead.js` `763078B5…`, `remote/toolErrors.js` `854E9A78…`, `timeline/records.js` `91F002D6…`, `timeline/paths.js` `800ED970…`, `timeline/index.js` `D0D0D9EA…` — all SAME. Repo `dist/` was not written; temp dir removed.

11. **No collateral damage (Module B) — PASS.** Plugin-package changes are exactly `M src/rpc.ts`, `M dist/rpc.js`, four new `src/remote/{grants,instances,localRead,toolErrors}.ts`, four new matching `dist/remote/*.js`, and two new tests. `src/schedule/**`, `src/timeline/**`, `cordis.patch.yml`, `package.json` are untouched. The `apps/**` and `docs/{MODULES,ROADMAP,UI-DESIGN}.md` diffs present in `git status` are attributable to other waves (`mod-shell-cloud-chat-pane`, `mod-settings-ia-guards`, per their registration rows in `docs/MODULES.md`), not to these two modules.

12. **Test budget — PASS.** `node --test "packages/dsh-dots/test/*.test.mjs"` → `tests 505 / suites 0 / pass 504 / fail 0 / cancelled 0 / skipped 1 / todo 0`, exit 0, duration ≈33.9 s — exactly the required `505 / 504 / 0 / 1`, +51 = 25 + 12 + 14 (counts confirmed per file). The single skip is pre-existing: `packages/dsh-dots/test/remote-listener.test.mjs:423-427` ("fetch 直连时：真实 fetch 断言状态码/正文/x-forwarded-for"), skipped by `lanTest`/`fetchGoesThroughEnvProxy` (`:52-76`) because `NODE_USE_ENV_PROXY=1` and `HTTP_PROXY=http://127.0.0.1:7897` are set while `NO_PROXY` lacks the LAN address; unrelated to both modules.

13. **Earlier failure stays fixed — PASS.** `test/remote-grants.test.mjs:150-173` contains the strengthened assertions: exact `store.file === <home>/.dsh/dots/instance-grants.json` (`:155-156`), different-home inequality (`:157-158`), regex + `work` exclusions (`:159-160`), no `token` in raw envelope (`:163`), and bad-file → `deepEqual(list(), [])` + `E_GRANT_ENVELOPE_JSON` + no grant (`:168-172`). No assertion was deleted or relaxed.

14. **Docs — PASS (registration not yet done, as expected).** The two module ids appear only in `docs/PLUGIN-GAPS.md:15-16`, not in `docs/MODULES.md`. The later registration MUST state honestly: **reader-only** (canonical serialiser + in-memory views; no writer — no atomic replace, ledger append, outbox/union/replay, `assertWritable` IO); **no path migration** (v1 `devices/**` and `src/schedule/**` untouched); **no tool rewiring** (`schedule_list`, `schedule_add`, `schedule_summary`, `dsh_dots` remain v1); **no command actions** (exactly four view actions; prompt/create/lease/grant ids absent and yield `E_UNKNOWN_ACTION`; view grants never imply `canPrompt`); grants/instance allow-list are local state files outside the sync repo; and **the plugin is never installed on a device** (on-device behaviour `unverified`). It should also carry forward M1/M2/M3 as open items if registration happens before they are fixed.

## Residual risk & unverified

- No on-device / real DSH plugin installation was exercised; this is a static-plus-Node-test review, and the plugin is not installed on a device (per the brief).
- `node scripts/build.mjs` was not run (forbidden); tests ran against checked-in `dist/`, which I independently verified byte-for-byte against a fresh `tsc` of current source for all eight changed/new compiled files.
- Byte parity was verified by comparing fixture literals and by line-by-line comparison of the implementation against `timeline.ts` / `timelineWrite.ts` / `syncProtocol.ts` / `freshStart.ts`. I did **not** run a differential fuzz between the plugin's compiled serializer and the App's compiled serializer; parity beyond the fixed fixtures is inferred from source identity, not proven by execution.
- No live second-instance HTTP integration test: all RPC transport tests inject a fake `fetch`. Network failure/status mapping is verified only through the injected layer.
- `localRead` path-traversal safety is argued structurally (no caller-supplied path, equality match only); adversarial `sessionId` fuzzing against `listLocalSessions()` was not performed.
- The `apps/**` / docs modifications in the working tree were attributed to other modules from their own registration text; I did not review those modules.

## Evidence log

| # | Evidence | Result |
|---|---|---|
| E1 | `git rev-parse HEAD` | `73a63a7983af1a0ac27abe34643a2f53fafc34c4` (main) |
| E2 | `git status --porcelain`, `git diff --stat`, `git diff --numstat` | Module A = new/untracked only; Module B = 2 modified + 6 new plugin files + 2 tests; protected paths clean |
| E3 | `git diff -- docs/MODULES.md docs/ROADMAP.md docs/UI-DESIGN.md` | Only `mod-settings-ia-guards` / `mod-shell-cloud-chat-pane` registered; our two ids absent |
| E4 | `grep mod-plugin-git-store|mod-plugin-remote-tools docs/*.md` | Hits only `PLUGIN-GAPS.md:15-16` |
| E5 | Read `timelineRead.test.mjs:30-74`, `timelineWrite.test.mjs:1-130`, `freshStart.ts`, `timelineWrite.ts:115-189`, `syncProtocol.ts:194-205,290-389`, `timeline.ts:1-778` | Reference literals and semantics captured |
| E6 | Read `src/timeline/{paths,records,index}.ts` (894 + 115 + 9 lines) | Full port reviewed; purity grep clean |
| E7 | Read `src/remote/{grants,instances,localRead,toolErrors}.ts` and `git diff src/rpc.ts` | Grants/allow-list/transport/switch reviewed |
| E8 | `grep console./JSON.stringify(config)/token/...` over new remote code and `rpc.ts` | No logging, no URL/token in errors; only `SENSITIVE_PARAM` regex and comments |
| E9 | temp `tsc -p tsconfig.json --outDir <tmp>` + per-file `Get-FileHash` | 8/8 SAME; `TSC_EXIT=0`; temp removed |
| E10 | `node --test "packages/dsh-dots/test/*.test.mjs"` | `505 / 504 / 0 / 1`, exit 0, ≈33.9 s |
| E11 | env check + `node --test remote-listener.test.mjs` filtered | `NODE_USE_ENV_PROXY=1`, `HTTP_PROXY=…:7897`; skip reason = proxy-env LAN fetch test |
| E12 | per-file `^test\(` count | 25 / 12 / 14 = +51 |
| E13 | Read `remote-grants.test.mjs:150-197`, `remote-readonly-rpc.test.mjs:182-227` | Strengthened path/security assertions and E_UNKNOWN_ACTION loop present |
