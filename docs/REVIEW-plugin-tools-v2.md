# Review — mod-plugin-tools-v2

Scope: `packages/dsh-dots`, HEAD `4c5de17580434fe06292b0ebc5edfb64752d0f83` (verified with `git rev-parse HEAD`). Read-only review of the uncommitted `mod-plugin-tools-v2` lane; the concurrent `repo-root` lane (`src/sync/**`, `dist/sync/**`, `src/client.js`, `dist/client.js`, `scripts/build.mjs`) was not reviewed or modified. No builds, no overlay, no git writes, no subagents. Two permitted commands were run: `node --test`, and `tsc --noEmit` (via the pnpm-store TypeScript 5.9.3 binary).

## Verdict

CONDITIONAL PASS — the four tools are genuinely rewired to the v2 shared timeline, no v1 write path is reachable from them, and the byte-parity claim is independently confirmed character-for-character against the App's own fixtures; Major findings remaining: 0.

Conditions before this can be called a full PASS: (1) live reload/on-device behaviour is still `unverified`; (2) T09 must be extended to cover `schedule_summary` / `dsh_dots` return keys and nested record keys before "return keys unchanged" is fully proven by a test; (3) the documented old→new value mapping is partial and should be completed; (4) the stale suite count in the docs rows should be refreshed.

## Findings

### Blocker

None.

### Major

None. Specifically, none of the three requested hard-fail conditions was found:

- No v1 `devices/**` write survives on any tool path (Check 1).
- The fixture strings are literally the App's bytes, not re-authored approximations (Check 2, appendix).
- `done` cannot be derived from a `done` field on any tool read path, and no force/rebase call can reach the cycle (Checks 3 and 5).

### Minor

- **M1 — T09 proves return-key stability only for two of four tools.** `plugin-tools-v2.test.mjs:323-335` compares parameter keys for all four tools, but return keys only for `schedule_add` (9 keys) and `schedule_list` (6 keys). It never asserts `schedule_summary` output keys, `dsh_dots` output keys, the nested `records[]` item keys, or `timeoutMs`. I independently compared the current definitions with `git show HEAD:.../tools.ts`; the untested keys are in fact unchanged (`schedule_summary`: `date, deviceIds, count, refreshed, note, aiNote, summary, prompt, payload`; `dsh_dots`: `generatedAt, deviceId, note, days, totals, dsh`; list item keys identical). So the *claim* is true, but the *test* does not fully prove it.
- **M2 — documented value mapping is partial.** `docs/MODULES.md:361` and `docs/ROADMAP.md:495` explicitly map only `path`, `rebased`, `deviceIds`, `refreshed` (and `commit`/`files` are named but not mapped); both defer the rest to "详见汇报 old→new 映射", which is not present in the docs. `pushed`, `count`, `done`, and `commit` value semantics are not documented in the rows. Honest and safe for a script that treats values as opaque, but a script that parsed `path` for a device id, or that relied on `count` being per-device, needs an explicit warning.
- **M3 — `pushed: true` on a no-change success path.** `v2Bridge.ts:347-357` sets `pushed: true` whenever `cycle.ok`, even if `cycle.writtenPaths.length === 0` (nothing to push); `renderAdd` (`tools.ts:501`) then prints 已推送. For a *new* record this cannot normally happen (a fresh unique id always creates a write), but the value is semantically "cycle succeeded", not "network push happened". Worth a one-line doc note.
- **M4 — stale suite count in docs.** `docs/MODULES.md:151,361` and `docs/ROADMAP.md:495` quote 585/584/0/1. Current tree runs 609/608/0/1: the `repo-root` lane added 24 tests after that row was written. No failures, but the figure is no longer reproducible.
- **M5 — T10 spans a concurrently edited lane.** `plugin-tools-v2.test.mjs:341-346` scans `src/sync/{repoRoot,repoPath,bootstrap,gitPort}.ts` and their `dist` twins, which belong to the other lane; a concurrent edit can turn this test red for reasons outside `mod-plugin-tools-v2`. It did not do so at review time.

### Nit

- **N1 — `E_CORRUPT` is collapsed at the gate.** `decideFreshStart` distinguishes a malformed `schema.json` (`E_CORRUPT`) from an unknown version, but `gateOfFacts` (`sync/cycle.ts:271-286`) reports `E_SCHEMA_UNKNOWN` for every `fresh.unsupported`. My independent probe (unknown version and malformed JSON, in-memory ports) returned `E_SCHEMA_UNKNOWN` with `outbox.saves=0`, `fs.writes=0` in both cases, so fail-closed behaviour is intact; only the typed label is imprecise.
- **N2 — "旧断言一条未删" is true in spirit, not literally.** `git diff` of the two retargeted tests shows 4 removed `assert` lines replaced by 8 stronger/updated ones (v1 path → v2 path, per-device count → whole-day count). Nothing was silently dropped.
- **N3 — first read may clone.** `withV2ScheduleBridge` calls `gitPort.prepare()` (`v2Bridge.ts:473-474`), which can clone the shared working copy on first use. That is a local working-copy initialisation, not a v1 write and not a timeline write, but a literal "writes nothing" reading of `schedule_list` should be qualified. Injected-port tests bypass it.

## Checklist

1. **No v1 write path remains in the tools — PASS.** Greps of `src/schedule/{tools,v2Bridge,dots}.ts` and `dist/schedule/{tools,v2Bridge,dots}.js` for `devices/`, `schedules/`, `jsonl`, `withScheduleBridge`, `addSchedule(`, `appendFile`, `writeFile`, `pullRebase`, `--rebase`, force/delete forms return only comments (`v2Bridge.ts:5,14`; `tools.ts:343`; `dots.ts:6,541` and their dist twins). `tools.ts:18-21` imports only `V2ScheduleBridge`/`withV2ScheduleBridge` and `dotsSnapshotFromV2`/`emptyDotsSnapshot`; `dist/schedule/tools.js:15-16` mirrors this. The `withScheduleBridge`/`addSchedule`/`appendFile`/`pullRebase` hits in `dist/schedule/bridge.js:185,200,293,313,347` and `jsonl.js` / `paths.js` belong to the untouched v1 bridge, which the tools no longer import. `v2Bridge.ts:284-359` writes only through `canonicalRecordLine` → outbox → `runV2Cycle`; `dots.ts:544-621` is read-only. T01/T03/T08 prove no v1 file is written or read.

2. **Byte parity, independently — PASS.** I opened the App files myself and extracted the literals with a Node script (no files written): `timelineRead.test.mjs:62-63`, `timelineWrite.test.mjs:69-91`, and the copies in `plugin-tools-v2.test.mjs:61-85` and `plugin-timeline-v2.test.mjs:92-116`. All compared strings are identical character-for-character, including `LINE_A`/`LINE_B` at `timelineWrite.test.mjs:79-80`. `canonicalRecordLine(A)`/`(B)` and `buildRecordsText(DAY,[A,B])` from the committed `dist/timeline/index.js` reproduce those exact bytes; a shuffled-key A also canonicalises to the same bytes; the whole-file text ends with exactly one `\n` (608 bytes, `endsWith('\n') && !endsWith('\n\n')`). Full strings in the appendix.

3. **Read rules match the App — PASS.** `isOpenRecord` (`v2Bridge.ts:118-122`) and `v2RecordLike` (`dots.ts:513-530`) test only `closed_at`; `summarizeV2` (`v2Bridge.ts:125-141`) derives `done` from it; `openIdsOf`/`openRecords` (`timeline/records.ts:271-283,840-850`) likewise never read `done`. T03 seeds `done:true` without `closed_at` and asserts `done:false`; T08 does the same for dots; T02 asserts `isOpenRecord(built)===true`. Same-`ts` resolution is by canonical-UTF-8 byte order (`records.ts:563-620`, `byteCompare:216-227`), loser appended via `conflictsLine(id,ts,losingLine,decidedAt)` (`records.ts:873-877`, `conflictRowsFromResolutions:889-912`); T04 seeds winner "Z"/loser "A" at identical ts and checks the *loser's* canonical line, id, ts and decidedAt in `conflicts.jsonl` (not tautological — it would fail if the winner's line were logged). Ledger precedence `R>D` visible, `R=D` and `R<D` deleted is implemented in `deletionState` (`records.ts:793-819`) and exercised with three distinct timestamps in T07.

4. **Gates before write — PASS.** `v2Bridge.ts:293-297` calls `gateOfFacts(schemaText, branch, '', '')` and throws typed errors for schema-unknown/branch-mismatch *before* title validation, id generation and outbox enqueue. T05 asserts `fs.writeCalls()===[]`, `git.writes()===[]`, `outbox.saves===0` for schema 99, and exactly one idempotent `FRESH_SCHEMA_TEXT` write for a missing marker; `runV2Cycle` (`cycle.ts:747-756`) re-checks freshness before writing the marker. My independent probe also confirmed zero outbox/fs writes for malformed JSON. Push rejection parks the intent with `attempts+1` and throws `E_PUSH_REJECTED` (`cycle.ts:822-830`; `v2Bridge.ts:343-346`); T06 asserts the typed code, a 下一步 message, `state:'pending'`, `attempts:1`, `lastError~/E_PUSH_REJECTED/`, and no success return; T11 pins the parked intent payload.

5. **No-force — PASS (Minor M5).** T10 (`plugin-tools-v2.test.mjs:338-360`) scans both `src/**` and `dist/**` for `v2Bridge`, `tools`, `dots` — including both new `v2Bridge` files — plus the repo-root lane's `src/sync/{repoRoot,repoPath,bootstrap,gitPort}` and dist twins, for `pullRebase(`, `pull --rebase`, `pushWithRebase(`, `--force`, `force:true`, `reset --hard`, `unlink(`, `rmSync(`, `rm -r`; it also asserts `PUSH_ARGS === {remote:'origin',branch:'main',force:false}`. The spellings named in the brief all match. Beyond the scan, `sync/cycle.ts` uses only `PUSH_ARGS` and has no history-rewriting port, and `gitPort.ts:39-42` allowlists git subcommands without `reset`/`rebase`/`pull`/`merge` and re-asserts `force:false` at `:152-157`. Residual: a computed method name or `fs.rm(path,{recursive:true})` would evade the regex heuristic, but no such code exists in the paths reviewed.

6. **Signature stability — CONCERN.** T09 compares exactly: `schedule_add` parameter keys `[author,body,date,title]` + `required:['title']`; `schedule_list` and `schedule_summary` parameter keys `[date,deviceId]`; `dsh_dots` parameter keys `[days]`; `schedule_add` return keys `[commit,date,deviceId,files,id,path,pushed,rebased,ts]`; `schedule_list` return keys `[date,deviceIds,errors,note,records,refreshed]`; `clampDays(0)===1`. Tool names are checked implicitly via `byName()` lookups. I verified against `git show HEAD:.../tools.ts` that these sets match v1 and that the untested keys are also unchanged. Documented value changes: `path` → `timeline/<date>/records.json`; `commit` → HEAD SHA only when a write occurred, else `''`; `pushed` → cycle success; `rebased` → always `false`; `files` → `cycle.writtenPaths`; `deviceIds` → one shared id; `refreshed` → always `false` on read; `done` → from `closed_at`, not the record's `done`; `count` → whole shared day. These are honest and key-stable (no script shape break), but see M2/M3: the mapping is thin in docs and `pushed` has the no-change edge.

7. **Tests/gates — PASS.** `node --test "test/plugin-tools-v2.test.mjs"`: **13 tests / 13 pass / 0 fail / 0 skipped / 0 cancelled** (T01–T13 all green). Full suite `node --test "test/*.test.mjs"` in `packages/dsh-dots`: **609 tests / 608 pass / 0 fail / 1 skipped / 0 cancelled**, 41.4 s; the single skip is the pre-existing proxy-environment-variable case in `remote-listener.test.mjs`. No failures in the concurrent `repo-root` lane tests (`plugin-v2-cycle`, `plugin-v2-wiring`, `plugin-v2-migration`, `repo-root`) — they are green in this tree. `tsc --noEmit -p tsconfig.json` (TypeScript 5.9.3) exits 0. No build script was run.

8. **Docs — PASS (Minor M2/M4).** `docs/PLUGIN-GAPS.md:4-7,15,22-23`, `docs/MODULES.md:151,361` and `docs/ROADMAP.md:495` state the four tool→v2 line mappings, the rule that v1 `devices/**` is ignored/not migrated/not deleted, the tool-name/param/return-key stability claim, and **未安装验证 / 待 reload 验证** with "插件以 `link:` 接入 live profile，Lead 批准后才 reload/GUI 检查". No device install or app build is claimed. The rows do claim plugin-local `node scripts/build.mjs` exit 0, `tsc --noEmit` 0 and dist freshness as evidence — those are the docs owner's claims and were not independently re-run here (builds forbidden); I independently re-ran only `tsc --noEmit`. The full old→new value mapping is deferred to an unstated report (M2) and the suite count is stale (M4).

## Byte-parity appendix

Compared character-by-character by extracting the literals directly from the App source files (not from the plugin's copies), then from both plugin test files, then round-tripping through `dist/timeline/index.js`.

**Fixture A — App `apps/arkui-schedule/tools/test/timelineRead.test.mjs:62` (also `timelineWrite.test.mjs:79` `LINE_A`; plugin copies at `plugin-tools-v2.test.mjs:61`, `plugin-timeline-v2.test.mjs:92`):**

```
{"id":"m9x2k1-3fk","ts":"2026-11-19T09:30:00+08:00","title":"周会","body":"讨论同步方案","author":"我","done":false,"media":[],"ai_processed":false,"opened_at":"2026-11-19T09:30:00+08:00"}
```

**Fixture B — App `timelineRead.test.mjs:63` (also `timelineWrite.test.mjs:80` `LINE_B`; plugin copies at `plugin-tools-v2.test.mjs:62`, `plugin-timeline-v2.test.mjs:93`):**

```
{"id":"n0y3l2-8ab","ts":"2026-11-19T14:00:00+08:00","title":"体检","body":"","author":"我","done":true,"media":[{"file":"ab12cd34ef567890.jpg","sha256":"ab12cd34ef567890abcdef0123456789abcdef0123456789abcdef0123456789","pageIndex":0}],"ocr_text":"体检单","ai_processed":true,"opened_at":"2026-11-19T14:00:00+08:00","closed_at":"2026-11-19T15:20:00+08:00"}
```

**Fixture C — whole-file text — App `timelineWrite.test.mjs:81-91` (`EXAMPLE_TEXT`); plugin copies at `plugin-tools-v2.test.mjs:75-85` (`WRITE_EXAMPLE_TEXT`) and `plugin-timeline-v2.test.mjs:106-116`. The final line is followed by exactly one `\n`:**

```
{
  "date": "2026-11-19",
  "open": ["m9x2k1-3fk"],
  "records": [
  {"id":"m9x2k1-3fk","ts":"2026-11-19T09:30:00+08:00","title":"周会","body":"讨论同步方案","author":"我","done":false,"media":[],"ai_processed":false,"opened_at":"2026-11-19T09:30:00+08:00"},
  {"id":"n0y3l2-8ab","ts":"2026-11-19T14:00:00+08:00","title":"体检","body":"","author":"我","done":true,"media":[{"file":"ab12cd34ef567890.jpg","sha256":"ab12cd34ef567890abcdef0123456789abcdef0123456789abcdef0123456789","pageIndex":0}],"ocr_text":"体检单","ai_processed":true,"opened_at":"2026-11-19T14:00:00+08:00","closed_at":"2026-11-19T15:20:00+08:00"}
  ]
}
```

**Verdict: MATCH.** A_app === A_plug === A_plugTL === LINE_A; B_app === B_plug === B_plugTL === LINE_B; C_app === C_plug === C_plugTL. `canonicalRecordLine(A) === A_app`, `canonicalRecordLine(B) === B_app` (also for a key-shuffled A), and `buildRecordsText('2026-11-19', [A,B]) === C_app` with 608 bytes and exactly one trailing `\n`. T01 additionally proves the file written by `schedule_add` equals `buildRecordsText` over its own parsed records and has exactly one trailing newline.

## Residual risk & unverified

- Plugin not installed / no live reload or GUI check: on-device behaviour, real clone/commit/push against the user's repository, and coexistence with the App writer in the same shared clone remain `unverified`. T01–T13 use injected in-memory ports.
- `dist/schedule/{tools,dots,v2Bridge}.js` were reviewed as committed artifacts; I did not rebuild them, so dist↔src freshness is the docs owner's claim (checked here only via `tsc --noEmit`).
- The concurrent `repo-root` lane is still editing `src/sync/**` and `client.js`; those files are green now but could change after this review. T10's dependency on them is M5.
- `commit` identity in the shared clone relies on the `dsh-dots-v2:` body trailer (a previously reviewed writer-half concern); this review did not re-audit that module.
- No test injects a record with a stale `done` field *and* a present `closed_at`; by code inspection `closed_at` wins (`isOpenRecord`), but that exact combination is not asserted.

## Evidence log

- `git rev-parse HEAD` → `4c5de17580434fe06292b0ebc5edfb64752d0f83`; `git status --short` → in-scope modified/untracked files identified alongside the concurrent lane.
- Read: `src/schedule/{tools,v2Bridge,dots}.ts`, `dist/schedule/tools.js`, `src/timeline/records.ts`, `src/sync/{cycle,gitPort}.ts`, `test/plugin-tools-v2.test.mjs`, `test/plugin-timeline-v2.test.mjs:80-139`, App `timelineRead.test.mjs:40-89` and `timelineWrite.test.mjs:1-120`, `docs/{PLUGIN-GAPS,MODULES,ROADMAP}.md`.
- Grep: `devices/|schedules/|jsonl|withScheduleBridge|addSchedule\(|appendFile|writeFile|pullRebase|--rebase|unlink\(|rmSync\(|reset --hard|--force|force\s*:\s*true` over the three source files and `dist/schedule/*.js`.
- `git show HEAD:packages/dsh-dots/src/schedule/tools.ts` (list tool lines 147-205, add 207-260, summary 261-323) for the v1 signature comparison; `git diff HEAD` on the two retargeted test files (4 removed / 10 added assert lines).
- Two Node stdin scripts (no files written): App-vs-plugin fixture extraction and canonical serialiser round-trip; corrupt-schema/unknown-schema in-memory port probe (`outbox.saves=0`, `fs.writes=0` both).
- Commands: `node --test "test/plugin-tools-v2.test.mjs"` → 13/13; `node --test "test/*.test.mjs"` → 609/608/0/1; `tsc -p tsconfig.json --noEmit` → exit 0.

## Delta (r2)

Delta verdict: **CONDITIONAL PASS — Major findings remaining: 0.** Both conditions from r1 are genuinely closed: T09 now covers all four tools on every axis the brief named (except one narrow `required`-absence gap noted below), and the old→new value mapping is complete and accurate against the code. The cross-lane `v2Bridge` half-state concern is also closed (fresh-compile identity, hash matches). What remains is Minor: the delta's quoted gate figures are stale, and the full suite was intermittently red while the sibling `repo-root` lane was recompiling (all red observations were in sibling-lane files, never in tools-v2's own files).

### T09 coverage judgment (per tool / axis)

Current test: `test/plugin-tools-v2.test.mjs:325-380`. The inline `V1` literal (`:326-361`) is indexed by tool name, and the loop at `:366-378` drives every assertion from it.

| Tool | name + registration order | parameter keys | `required` | return keys | nested keys | `timeoutMs` |
|---|---|---|---|---|---|---|
| `schedule_list` | yes (`:365`) | yes (`:369`) | not asserted (v1 had none) | yes (`:370`) | `records[]` 11 keys (`:330-331`, `:376`) | yes (`:332`, `:371`) |
| `schedule_add` | yes | yes | yes (`:336`, `:372-374`) | yes | n/a (empty `nested`, `:338`) | yes |
| `schedule_summary` | yes | yes | not asserted (v1 had none) | yes | `payload` 2 keys + `payload.records[]` 3 keys (`:345-346`) | yes |
| `dsh_dots` | yes | yes | not asserted (v1 had none) | yes | `days[]` 5 keys + `totals` 5 keys + `dsh` 8 keys (`:354-357`) | yes |

(a) All four tools are covered on name, registration order, parameter keys, return keys, nested keys and `timeoutMs`. Registration order is pinned by `assert.deepEqual(registered.map(tool => tool.name), Object.keys(V1))` at `:365`; the object literal's insertion order is list → add → summary → dots, matching `buildScheduleTools` (`tools.ts:439-446`). One residual gap: `required` is only asserted where v1 had one (`schedule_add`); the loop is guarded by `if (v1.required !== undefined)` (`:372`), so a newly-added `required` on the other three tools would not fail T09. Minor, not a regression today.

(b) **The inline v1 expectations match `git show HEAD:packages/dsh-dots/src/schedule/tools.ts` (147-411), which I opened myself.** Verified field by field: list params `[date, deviceId]`, returns `date/deviceIds/refreshed/note/errors/records`, `records[]` = `id, ts, date, deviceId, title, author, done, bodyPreview, bodyLength, hasAttachments, aiProcessed`, 60_000; add params `date/title/body/author` + `required:['title']`, returns `id/ts/date/deviceId/path/commit/pushed/rebased/files`, 60_000; summary params `[date, deviceId]`, returns `date/deviceIds/count/refreshed/note/aiNote/summary/prompt/payload`, `payload` = `date, records`, `payload.records[]` = `id, ocr_time, text`, 90_000; dots params `[days]`, returns `generatedAt/deviceId/note/days/totals/dsh`, `days[]` = `dateKey, total, open, done, topTitles` (no `devices` in the schema), `totals` = `days, records, open, done, skipped`, `dsh` = `reachable, mode, sessionCount, activeSessionTitle, busy, lastActivityAt, version, detail` (no `webUrl`/`observedAt` in the schema), 90_000. Zero mismatches; the arrays are order-insensitive because both sides are sorted at `:369/:370/:376`.

(c) **The `additionalProperties` filter cannot mask a real key change.** `keys()` at `:363` filters only that one name from the compared `properties` maps. I inspected all four definitions built from the current `dist/schedule/tools.js`: none of `parameters.properties`, `output.schema.properties`, or any nested `properties` map contains an `additionalProperties` key — `sealToolSchema` adds it to *object schema nodes* (as a sibling of `properties`), not into the property-name maps. The filter is therefore a defensive no-op here. It could only hide a literal property actually named `additionalProperties`, which no v1 definition ever declared.

(d) **A removed return key fails at `:370`.** Concretely, deleting `count` from `schedule_summary`'s `output.schema.properties` makes `assert.deepEqual(keys(tool.output.schema.properties), v1.returns.slice().sort(), 'schedule_summary 返回键')` (`:370`) throw; I verified this mutation in memory. Deleting a nested key such as `totals.skipped` fails the `assert.deepEqual(keys(getNode(tool)), expectedKeys.slice().sort(), ...)` at `:376`. Both were confirmed with negative runs, so these are live assertions, not decorative ones.

### Docs mapping + counts

`docs/MODULES.md:361` and `docs/ROADMAP.md:495` now carry the complete nine-field old→new mapping. **Accuracy verdict: PASS** — checked against code, not merely present: `path` → `timelineRecordsPath(day)` (`v2Bridge.ts:353`); `commit` → `headSha()` when `cycle.writtenPaths.length > 0`, else `''` (`:347`); `pushed` → `true` on cycle success, typed throw on failure (`:355`, `:343-346`); `rebased` → literal `false` (`:356`); `files` → `cycle.writtenPaths.slice()` (`:357`); `deviceIds` → `[this.deviceId]` (`:218`); `done` → `!isOpenRecord(record)` (`:135`, `:151`; `dots.ts:523`); `refreshed` → literal `false` (`:220`); `count` → `payload.records.length` over the whole visible shared day (`:252`). The r1 M3 caveat (`pushed: true` even with no write handle) is now explicitly documented in both rows, which resolves that concern honestly.

On the narrow "no row silently adopts the later total" question: **PASS** — both rows register 585/584/0/1 as the module freeze tree and name 609/608/0/1 explicitly as the sibling-lane-augmented current tree with wording ("本行仍登记本模块冻结树的 585，不静默采用后续总数" / "本行不静默采用后续总数"). They did not quietly overwrite the module's own figure.

However, both quoted figures and the targeted figure `13/13/0/0` are now stale at review time. Measured: targeted `plugin-tools-v2.test.mjs` is **14 tests** (T10b was added in this delta), and the current tree is **612 / 611 / 0 / 1**. The +3 over 609 = +1 from T10b in this module plus +2 from the sibling lane's new `R10`/`R11` in `test/plugin-v2-cycle.test.mjs:312,344`. The rows were presumably accurate when written; they are not reproducible now. This reopens r1 M4 in a milder form → Minor.

### Shared `dist/schedule/v2Bridge.js` consistency

The sibling lane's `prepare()` addition is present in `src/schedule/v2Bridge.ts:471-474` and in `dist/schedule/v2Bridge.js:332-336`. I fresh-compiled `src/**` with TypeScript 5.9.3 to an OS temp directory (`tsc -p tsconfig.json --outDir <temp>`; repo `dist/` untouched) and compared all three deliverables: `tools.js` 23,007 B SHA-256 `3630eb3b…`, `dots.js` 19,048 B `456b6518…`, `v2Bridge.js` 18,084 B `423e6f21…` — **0 diffs, all IDENTICAL**, and the `v2Bridge` hash matches the claimed `423e6f21…` prefix exactly. No half-state in the shared file.

T10 still covers it: `plugin-tools-v2.test.mjs:406-420` scans the explicit schedule trio including `src/schedule/v2Bridge.ts` and `dist/schedule/v2Bridge.js` (`:411-412`), plus `readdirSync` enumeration of `src/sync` and `dist/sync` (`:413`), through `textForceHit` (`:386-403`). The delta also added T10b (`:422-446`) with positive/negative controls, so the matcher is proven to fire on hostile spellings (`-f`, `--force-with-lease`, `+main`, `push.force=true`, `--delete`) while allowing `force:false` and the fixed `HEAD:main` push. Note that T10b raises the file to 14 tests and is itself a heuristic control, not a guarantee; the real guarantee remains the git-port allowlist / runtime assertion (as T10's own comment at `:383` says).

### Gate tails (observed this round)

- Targeted `node --test "test/plugin-tools-v2.test.mjs"`: **14 tests / 14 pass / 0 fail / 0 skipped** (final two runs). The claimed `13/13` is stale.
- Full `node --test "test/*.test.mjs"`: **612 tests / 611 pass / 0 fail / 1 skipped** (final run; skip = pre-existing proxy-env case). The claimed `609/608/0/1` is stale.
- `tsc -p tsconfig.json --noEmit` (TypeScript 5.9.3): exit 0.
- Reconfirmed dist freshness after the sibling lane's recompiles: same three SHA-256 values, 0 diffs.

**Transient instability (Minor, cross-lane, out of tools-v2 scope).** During this review I also observed one targeted run at 14/13/1 where T10 failed on `dist/sync/gitPort.js` ("force flag", `:417`), and two full-suite runs at 612/609/2 where sibling tests C15/C16 (`plugin-v2-cycle.test.mjs:330,351`) failed on `dist/sync/repoRoot.js` containing a banned fragment. Each time, an immediate rerun was green (T10 14/14; `plugin-v2-cycle.test.mjs` 29/29) and a direct grep of the cited file found no banned text. All red observations were in the sibling lane's in-flight `dist/sync/**` files, not in `src/schedule/**` or `dist/schedule/**`. The tools-v2 delta itself had no failing test at any point.

### Delta residual risk & unverified

- Live reload / on-device behaviour unchanged from r1: `unverified`; T01–T13 use injected in-memory ports.
- `required`-absence for `schedule_list` / `schedule_summary` / `dsh_dots` is not pinned by T09 (Minor).
- Suite counts in the docs rows will drift again if either lane adds tests before the Lead's final gate run; the Lead should re-run and re-register counts from one settled tree.
- No build script was run in this review; only `tsc --noEmit`, `tsc --outDir <temp>` (outside the repo), and `node --test`.

### Delta evidence log

- `git show HEAD:packages/dsh-dots/src/schedule/tools.ts` lines 147-411 opened and compared to the inline `V1` literal at `test/plugin-tools-v2.test.mjs:326-361`.
- Read `test/plugin-tools-v2.test.mjs:318-499` (T09, T10, T10b, T11), `docs/MODULES.md:361`, `docs/ROADMAP.md:495`, `test/plugin-v2-cycle.test.mjs:328-367`.
- In-memory inspection of `buildScheduleTools({})` definitions (no `additionalProperties` in compared maps; `required` only on `schedule_add`; `timeoutMs` 60/60/90/90) plus two mutation runs (remove `count`, remove `totals.skipped`).
- Fresh-compile SHA-256 comparison of the three dist files; `v2Bridge.js` 18,084 B `423e6f21229909bb04e224b9e1a9be55537644bafd3c43a7f42fbe60a14b2077` identical to fresh output.
- Commands: targeted test (14/14 final), full suite (612/611/0/1 final), `plugin-v2-cycle.test.mjs` (29/29), `tsc --noEmit` (exit 0).
