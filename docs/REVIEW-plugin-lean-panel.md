# Review — mod-plugin-lean-panel

Independent read-only review of the uncommitted `packages/dsh-dots` change. No builds, no
install, no git writes, no source edits were performed by this reviewer. Line references are to
the working tree under review.

## Verdict

**FAIL — the panel is structurally lean and the guard is real, but the required QR/copy/token
flow is dead in the shipped panel (it exists only when tests inject a fake `seedLink`), and a
successful save makes the status line falsely report `未配置：缺少访问令牌` while hiding a
blocked state. Major findings remaining: 2**

## Findings

### Blocker

None. No engine behaviour changed; `src/engine/**`, `src/remote/**` and `src/rpc.ts` are
byte-unchanged (`git diff --quiet` over those paths returned exit 0). `dist/client.js` is exactly
what `scripts/build.mjs:renderClientSource()` produces from `src/client.js` (see check 8).

### Major

**M1 — QR code, `复制`, and the remote-token input are non-functional in the real panel; the
"1 QR svg" inventory is test-fixture-only.** `LeanRemoteGroup` obtains its link solely from
`props.seedLink` (`src/client.js:4287`, `:4293`) and its QR from `link.qr` or
`state.status.qr` (`:4364-4369`). The sole registered panel is rendered as `DotsPanel` with the
host's slot props (`:4502-4515`, `:4451-4469`) and nothing supplies `seedLink`. `RemoteStatus`
has no `qr` field at all (`src/remote/types.ts:154-174`), so `state.status.qr` is always
undefined. `QrMatrix` returns `null` when no matrix is present (`src/client.js:3371`). The lean
group never calls `remoteShowLink` (the only call is in the dormant `RemotePanel` at
`src/client.js:3603`), never calls `remoteSaveSettings` (`:3534`, dormant only), and its
`token` React state is write-only: set at `:4292`, `:4346`, `:4423`, read by no action. `doCopy`
(`:4350-4362`) returns immediately because `link` stays null. `doGenerate` (`:4337-4347`) clears
`link` and `token`, so even a host-supplied QR would be destroyed with no way to recreate it.

Independent render of the built `dist/client.js` with **no seed props** (the real host shape)
gave `svg = 0`; with the exact `seedLink` used by the two tests it gave `svg = 1`. Both
`test/client-lean-inventory.test.mjs:131-142` and
`test/client-remote-render.test.mjs:789-799, 848` inject `seedLink`, so the guard and the
retargeted merged test assert a QR users never see. This breaks the user's required
`访问令牌(生成/复制) · 二维码` capability at the UI layer and makes the claimed inventory
untrue for the delivered component. It is not a "UI-dormant" capability — it is a required
capability that is present in markup only under test scaffolding.

**M2 — a successful `保存` fabricates `未配置：缺少访问令牌` and erases the blocked state.**
`doSave` replaces the whole state with the `saveSettings` result (`src/client.js:4209-4212`).
RPC returns `{ settings: SyncSettings, hasToken: boolean }` (`src/rpc.ts:336, 351`), and
`SyncSettings` has no `hasToken` (`src/engine/settings.ts:119-130`). `leanStatusText` reads
`settings.hasToken !== true` (`:4151`) and therefore returns
`未配置：缺少<missing>` (`:4152`) immediately after a save that actually succeeded with a
token. The separate `hasToken` React state (`:4174-4176`, `:4211`) is never read by the render
path. The replacement also discards `state.status`, so `visibilityBlocked` /
`privacyBlocked` / `repoBlocked` (`:4154-4156`) are lost: a configured, blocked device shows
`未配置：缺少访问令牌` instead of `已配置（可见性阻断，禁止推送）` until a later
`testConnection`/reload. Evaluated `leanStatusText` directly against the post-save state shape:
`POST-SAVE settings (no hasToken) + stale lastSyncAt/blocked => UNCONFIGURED:TOKEN`. This is
the exact "blocked rendered as unconfigured" failure the brief warns about. (The inverse is
true: neither save nor test can fabricate `已同步` — see check 4.)

### Minor

- **m1 — stale remote status copy points at a button that no longer exists.** With no probe the
  remote status line renders `remote.probe.never` = `尚未自检；点「重新自检」确认这台机器到底
  能不能被访问。` (`src/client.js:4382`; `locale/zh.json`), but the lean panel has only `自检`,
  not `重新自检`. Confirmed in the no-seed render.
- **m2 — docs overstate what is retained.** `docs/MODULES.md` and `docs/ROADMAP.md` describe
  `二维码` / `复制` as live in the lean panel and list the dormant capabilities, but omit that
  link acquisition (`remoteShowLink`) and QR generation are themselves now unreachable. The
  dormant list otherwise matches the code: no checkbox, no platform/auth/device/branch input,
  no preview/apply/push/rollback/snapshot, no MERGE plan, no step paragraphs, no listener
  address/enable/start/stop/runtime status is mounted by `DotsPanel`.
- **m3 — interrupted sync evidence after save.** For the same reason as M2, a previously synced
  device drops `lastSyncAt` on save and shows `尚未同步` rather than the real last sync time.
  Conservative (never invents success), but not honest about known state.

### Nit

- `test/client-lean-inventory.test.mjs:4-5` and the docs repeat the spec's "5 controls /
  6 inputs+selects" contradiction; the implementation resolves it to 5 and names the controls,
  which is acceptable. No missing-key placeholders were found in the lean labels.
- The guard reads `dist/client.js`, not `src/client.js`; drift is covered by the separate
  src===dist assertion at `test/client-remote-render.test.mjs:479-485`.

## Checklist

1. **Inventory is exactly as claimed — FAIL.** No deleted control renders (0 checkbox, 0 `<p>`,
   no extra input/button), but the claimed **1 QR svg is not in the shipped panel**: real
   no-seed render has `svg=0`; only the seeded fixture render has `svg=1`. See M1 and the
   inventory section below.
2. **Guard is real — PASS** (with the scope limitation of M1). `test/client-lean-inventory.test.mjs`
   asserts exact sets, not subsets: input types `['text','password','number','password']` plus
   exactly 1 select with `['lan','tailscale','ipv6']` and total `=== 5` (`:157-175`); buttons
   deep-equal `['保存','测试连接','生成','复制','自检']` (`:177-186`); exactly 1 `svg` with
   `role=img` and the `lean.remote.qr` label (`:188-194`); exactly 1 `data-lean=sync-status`
   with `已同步 · 08:30` (`:196-201`); details ids `['dots','dots-remote']` (`:149-155`).
   `DELETED_LABELS` (`:144-147`) are checked against `textOf(tree)` (`:203-213`), where `walk`
   (`:86-94`) expands function components — i.e. **rendered markup, not a source-string scan**.
   Mutation proof is sound by inspection: re-adding one checkbox breaks test at `:162-166`
   (types array), `:173` (total 6≠5), `:174` and `:209` (checkbox assertions) — at least 2
   guard tests fail, as claimed.
3. **Capability preservation — PASS.** `git diff --quiet -- packages/dsh-dots/src/engine
   packages/dsh-dots/src/remote packages/dsh-dots/src/rpc.ts` exit 0; `git diff --name-only`
   lists none of them. `buildSafePushArgs`/`assertSafeGitArgs`, grants default-deny and the
   privacy preconditions are untouched; no engine behaviour changed. Dormant list matches code
   (with the omission noted in m2).
4. **Status line honesty — FAIL.** Success fabrication is absent (`doSave` :4201-4216 writes no
   `lastSyncAt`; `testConnection` only records `reachable` per `src/rpc.ts:354-355`; `doTest`
   :4229-4231 re-reads real `getState`). But post-save false `未配置` and hidden `blocked` occur
   per M2. Precedence in `leanStatusText` is otherwise correct: with complete config a blocked
   state returns `BLOCKED`, with complete config + `lastSyncAt` it returns `SYNCED:08:30`.
5. **Required fields are two — PASS.** The sync group renders only text URL + password token
   (`src/client.js:4244-4263`). `doSave` hardcodes `branch: 'main'` (`:4200-4204`). Platform is
   derived by `inferPlatform` (`src/engine/settings.ts:67-71, :153`), deviceId and branch fall
   back to defaults (`:51-55`, `:122-130`). No branch/device/platform input exists in either
   lean group.
6. **Locale — PASS.** 22 `lean.*` keys in each of `locale/zh.json` and `locale/en.json`; key
   sets are identical; the embedded `const zh` / `const en` dictionaries in `src/client.js`
   (`:42-700`) parse to byte-equal copies of the JSON files. Spot-check of retained keys still
   referenced: `remote.probe.never` (`:4382`), `remote.field.token` / `remote.field.token.hint`
   (`:3278`, dormant RemotePanel), `remote.probe.warn` via `tr('remote.probe.'+probeLevel)`
   (`:4374`). `makeT` (`:754-767`) falls back to the bundled dictionary when the host `t`
   returns the key, so no raw-key placeholder is produced for lean labels.
7. **Remote assertions — CONCERN.** The 11 RemotePanel tests (`client-remote-render.test.mjs`
   lines before 789) are byte-unchanged; the diff touches only the 12th merged-panel test, which
   was retargeted and *strengthened* (exact button labels, exact input mix, negative dead-label
   guards at `:843-847`). It does prove QR/self-check/token/status inside the one
   `dots-remote` group — but only with injected `seedLink`, so it cannot catch M1.
   `client-render.test.mjs`'s merged sync test was likewise retargeted (select 0, input 2,
   buttons `['T:lean.actions.save','T:lean.actions.test']`, one status node, dead-key guards).
8. **Build + dist — PASS.** `src/client.js` and `dist/client.js` are byte-identical: both
   184,060 B, 4,236 lines, SHA-256 `F8794D82DE9018A08E2CC0DF15052F5A790F3069A781084704FD570F3EC51837`.
   `scripts/build.mjs:24-42` rewrites only the loader id to `package.json.name` (`dsh-dots`),
   which equals the source literal, so `renderClientSource()` is an identity transform here.
   The other 61 dist files vs a fresh `tsc` were **not** re-verified by this reviewer (no-build
   constraint); the executor's "61 files, 0 mismatches" claim is recorded but unverified here.
9. **Gates — PASS.** `node --test "test/*.test.mjs"` in `packages/dsh-dots` (exit 0):
   `tests 618 / pass 617 / fail 0 / skipped 1`, duration ~27.7 s. No named failures; matches the
   executor's 618 / 617 / 0 / 1 exactly.

## Actual inventory (counts + labels you counted yourself)

Measured by loading the built `dist/client.js` with a React stub, expanding function components,
and counting the element tree. Two renders: "real" = only `{t, close}` props (the host shape);
"seeded" = additionally `seedState` + `seedLink` as the tests supply.

| Element | Real (no seeds) | With test seeds | Claim |
|---|---|---|---|
| `<details>` | 2 (`dots`, `dots-remote`), both `open` | 2, both `open` | 2 ✅ |
| `<summary>` | 2 (`配置同步`, `远程控制`) | 2 | 2 ✅ |
| `<input>` total | 4 | 4 | 4 ✅ |
| `input[type=text]` | 1 (`lean.repo.url` → `仓库地址`) | 1 | 1 ✅ |
| `input[type=password]` | 2 (`lean.repo.token` → `访问令牌`; `lean.remote.token` → `访问令牌`) | 2 | 2 ✅ |
| `input[type=number]` | 1 (`lean.remote.port` → `端口`) | 1 | 1 ✅ |
| `<select>` | 1 (`lean.remote.mode` → `访问方式`), options `lan / tailscale / ipv6` | 1, same | 1 ✅ |
| `<button>` | 5 — `保存`, `测试连接`, `生成`, `复制`, `自检` | 5, same | 5 ✅ |
| QR `<svg role=img aria-label="二维码">` | **0** | **1** | claimed 1 ❌ in real panel |
| status divs | 2 — `data-lean=sync-status` = `未配置：缺少仓库地址、访问令牌`; `data-lean=remote-status` = `尚未自检；点「重新自检」…` | 2 — `已同步 · 08:30`; `通过 · pass` | 2 ✅ |
| `<p>` | 0 | 0 | 0 ✅ |
| `input[type=checkbox]` | 0 | 0 | 0 ✅ |
| forbidden labels present | none of `同步范围 / 分支 / 设备标识 / 平台 / 认证方式 / 预览 / 应用 / 回滚 / 快照 / MERGE` | none | none ✅ |

The text/units/QR helper counts match the claimed 2+2+5+5+2+1 shape **except** the QR in the
real render. No deleted control was found anywhere in the rendered tree.

## Residual risk & unverified

- **GUI / reload / device install unverified** (docs correctly mark it so). All findings here are
  from source and stub-render evidence; no live DSH panel was opened.
- The 61 non-client dist files vs a fresh `tsc` were not regenerated (no-build instruction).
- `saveSettings` was inspected at the RPC boundary, not executed against a real token store;
  M2's state shape follows directly from `src/rpc.ts:336,351` and `src/engine/settings.ts:119-130`
  and was confirmed by direct evaluation of `leanStatusText`, not by a click-through in the GUI.
- Test fixtures inject `seedState`/`seedLink`; the real slot host's prop shape was assumed from
  `ctx.slots.register(...)` usage (`src/client.js:4502-4515`) and the absence of any other
  `seedLink` producer in the tree (grep across `packages/dsh-dots`).
- Out-of-scope uncommitted `apps/**` changes and the new `docs/REVIEW-settings-configured-state.md`
  were observed in `git status` but not reviewed.

## Evidence log

- `git status --short` / `git diff --stat` in `dsh-sync-suite`: 11 modified files + 4 untracked;
  `packages/dsh-dots/dist/client.js` and `src/client.js` each `415 +++++`, locales `25 +-`,
  two client tests `34 +-` / `30 +-`; no `src/engine/**`, `src/remote/**`, `src/rpc.ts` rows.
- `git diff --quiet -- packages/dsh-dots/src/engine packages/dsh-dots/src/remote packages/dsh-dots/src/rpc.ts` → exit 0.
- `Get-FileHash` (SHA-256): `src/client.js` = `dist/client.js` = `F8794D82…570F3EC51837`, 184,060 B, 4,236 lines each.
- Node stub render of `dist/client.js`: counts tabulated above; real render `svg=0`, seeded render `svg=1`.
- Direct evaluation of extracted `asText`/`fmtClock`/`leanStatusText`: `configured + blocked => BLOCKED`,
  `configured + synced => SYNCED:08:30`, `POST-SAVE settings (no hasToken) + stale lastSyncAt/blocked => UNCONFIGURED:TOKEN`.
- Locale script: embedded `zh`/`en` dictionaries equal `locale/*.json` (0 differing keys);
  22 `lean.*` keys per locale; no zh/en missing keys.
- `node --test "test/*.test.mjs"` in `packages/dsh-dots`: `tests 618 / suites 0 / pass 617 /
  fail 0 / skipped 1 / cancelled 0 / todo 0`, exit 0.
- Reviewed files: `packages/dsh-dots/src/client.js`, `dist/client.js`, `scripts/build.mjs`,
  `locale/{zh,en}.json`, `test/client-lean-inventory.test.mjs`, `test/client-render.test.mjs`,
  `test/client-remote-render.test.mjs`, `src/rpc.ts`, `src/remote/types.ts`,
  `src/engine/settings.ts`, `docs/{MODULES,ROADMAP}.md`.

## Delta (r2)

Delta verdict: **PASS — Major findings remaining: 0.** Both r1 Majors are closed on the
**real host path** (`{t, close}` only, no seed): the QR / 复制 / remote-token controls are now
driven by real RPCs, and the status line reads only authoritative token/blocked/sync facts.
r1 above is left intact as the historical record; this section supersedes its M1/M2 findings.
Two new **Minor** defects were found in the delta (d1, d2). Read-only delta review: no builds,
no source edits, no git writes.

### Delta checks (1–7)

1. **No seed on the real path — PASS.** `seedLink` grep over `packages/dsh-dots/**/*.mjs` gave
   9 hits: three are comments in `test/client-lean-inventory.test.mjs:9,247,317`; the only four
   *actual* `seedLink:` arguments are `test/client-remote-render.test.mjs:633,724,747,812`, all
   inside dormant `RemotePanel` tests (e.g. the one at `:806`). The retargeted merged test at
   `:887-957` mounts with `{t, close}` only and stubs `globalThis.fetch` instead; the lean guard's
   `renderReal()` (`:247-259`) also passes only `{t, close}`. `src/client.js` has no `seedLink`
   in either lean component (the two remaining reads at `:3425,:3435` belong to the dormant
   `RemotePanel`). Mutation proofs: in-memory removal of the mount-time `loadLink(...)` call
   changed `remoteShowLink` calls 1→0 and `<svg>` 1→0; by assertion inspection that fails at
   least the guard tests at `client-lean-inventory.test.mjs:319-321`, `:336`, `:354` (claim
   "2 failures" is conservative). Re-adding a checkbox would fail at least `:291-295`, `:302`,
   `:303` and `:368` (also ≥2). No files were mutated on disk.
2. **RPC names / payloads, engine untouched — PASS.** `git diff --quiet -- src/engine
   src/remote src/rpc.ts` exit 0 (still byte-unchanged; I changed nothing). `src/rpc.ts:664`
   `remoteSaveSettings(payload)` forwards `payload.settings` (`:666`); `:678` `remoteRotateToken()`
   takes no arg; `:686-687` `remoteShowLink(payload)` forwards `asRemoteMode(payload.mode)`;
   dispatch rows at `:1028,:1034,:1038`. Client calls match: `remoteShowLink {mode}`
   (`src/client.js:4340`), `remoteSaveSettings {settings:{mode,port,token}}` (`:4389-4391`),
   `remoteRotateToken {}` (`:4426`), `remoteProbe {mode}` (`:4415`).
3. **QR is real, not a stub — PASS.** `link.qr` is taken only from `remoteShowLink`'s return
   (`src/client.js:4339-4350`, `:4460`); the phantom `RemoteStatus.qr` fallback is gone.
   `QrMatrix` (`:3371`) draws the RPC matrix via `<rect>`s. Independent no-seed render of the
   built `dist/client.js` produced `showLinkCalls=1`, `svg=1`, `rect=3` for a 2×2 RPC matrix,
   and `复制` wrote the exact token-bearing RPC URL to the clipboard. Guard at
   `client-lean-inventory.test.mjs:317-326` asserts the real RPC call, exactly one
   `svg[role=img][aria-label=二维码]` and no plaintext token in the rendered tree; the merged
   test does the same at `client-remote-render.test.mjs:908,914,939`. (They do not assert
   per-cell matrix fidelity — minor residual, but no stub path exists.)
4. **M2 truth table — PASS.** Direct evaluation of the extracted `leanStateView` /
   `leanStatusText` (`src/client.js:4153,4169`) plus the stateful guard tests gave:

   | Case | Result |
   |---|---|
   | getState full + `lastSyncAt` | `已同步 · 08:30` |
   | post-save, `settings` lacks `hasToken`, top-level `hasToken:true` + preserved blocked | `已配置（可见性阻断，禁止推送）` |
   | post-save `hasToken:true`, `lastSyncAt:null` | `尚未同步` (no fabricated sync) |
   | post-save top-level `hasToken:false` | `未配置：缺少访问令牌` |
   | genuinely no token from getState | `未配置：缺少访问令牌` |
   | `testConnection` success (only `reachable`, no `lastSyncAt`) | `尚未同步` |

   `doSave` merges `{settings: result.data.settings}` into previous state and preserves
   `status` (`:4237-4244`), so blocked flags and the real `lastSyncAt` survive. The source
   guard at `client-lean-inventory.test.mjs:414-421` asserts `SyncSettings` has no `hasToken`
   and that `leanStatusText` never reads `cfg.hasToken`.
5. **Tests / integrity — PASS.** The lean guard has **13** cases (r1 had 6; +7 for M1/M2).
   The 11 dormant `RemotePanel` tests are unchanged — `git diff` on
   `client-remote-render.test.mjs` touches only added r2 harness helpers and the single
   merged-panel test. The merged test is retargeted to the **real RPC path** (`:887-908`),
   still proving QR / self-check / token input / status inside the one `dots-remote` group.
6. **Dist — PASS (client equality).** `src/client.js` and `dist/client.js` are byte-identical:
   189,376 B, 4,317 lines each, SHA-256 `C703D82505015AEFCC7FE898F1F76AB7750E23EC0F3A5D87DC4F930DE6AC6EF9`
   (matches the claimed prefix). The "61 files / 0 tsc mismatch" claim remains **unverified by
   this reviewer** (no-build delta constraint).
7. **Gates — PASS.** Targeted `node --test "test/client-*.test.mjs" "test/locale.test.mjs"`:
   `tests 57 / pass 57 / fail 0 / skipped 0`, exit 0. Full `node --test "test/*.test.mjs"`:
   `tests 625 / pass 624 / fail 0 / skipped 1 / cancelled 0 / todo 0`, exit 0 (~43.6 s). Both
   match the executor's claim; no named failure.

### New Minor findings in the delta

- **d1 — initial QR is fetched for the wrong mode.** The mount-time call at
  `src/client.js:4370` uses `asText(seedSettings.mode) || 'lan'`, i.e. always `'lan'` in the
  real path, even after `remoteGetState` has set `mode` from the host. Independent render with
  host mode `tailscale` produced select value `tailscale` but the first `remoteShowLink` payload
  `mode:'lan'`; same for host mode `ipv6`. A mode change later corrects it, but the first
  QR/link can be for the wrong access mode.
- **d2 — mode change persists the stale previous mode.** `src/client.js:4489-4492` calls
  `persist('')` inside the select handler; `persist` reads `mode` from the enclosing render's
  closure (`:4389`), not the new `value`. Verified: changing `tailscale → ipv6` sent
  `remoteSaveSettings {settings:{mode:'tailscale',port:0}}` while `remoteShowLink` used `ipv6`.
  Host-side mode and the displayed QR can therefore disagree after a switch.
- **d3 — guard does not assert QR matrix fidelity** (svg/aria/token-absence only). No stub QR
  source remains, so this is a hardening nit, not a live defect.

### Delta gate tails

```
targeted: tests 57 / suites 0 / pass 57 / fail 0 / cancelled 0 / skipped 0 / todo 0  (exit 0)
full:     tests 625 / suites 0 / pass 624 / fail 0 / cancelled 0 / skipped 1 / todo 0  (exit 0)
```

### Delta residual risk & unverified

GUI/reload/device install still unverified (both rounds); all conclusions are source + stub-render
evidence. The 61 non-client dist files were not regenerated. In-memory mutation of `dist/client.js`
was performed only in a Node string (data: URL), never on disk. Out-of-scope uncommitted
`apps/**` and other-lane files were observed but not reviewed.

## Delta (r3)

r3 verdict: **PASS — Major findings remaining: 0.** Both r2 Minors (d1 hardcoded LAN on mount,
d2 stale-mode persist) are closed by real behaviour changes in the built client. r1 and r2 are
left intact. No new Minor or Major found; two caveats are recorded below. Read-only review —
no source edits, no builds, no git writes.

### d1 verification (mode comes only from the host)

- Grep for `lan` in `src/client.js` returned 8 hits; **none is a lean-group default**: `:3202`
  (dormant `REMOTE_MODES`), `:3274` (dormant `remoteSettingsOf` fallback), `:4499` (the legitimate
  `<option value="lan">` in the select), `:360/:362/:685/:687` (locale keys). The r2 fallback
  `asText(seedSettings.mode) || 'lan'` (old `:4332`) and mount call `loadLink(asText(seedSettings.mode)
  || 'lan')` (old `:4370`) are **gone**: new `:4332` is `React.useState(asText(seedSettings.mode))`,
  and `:4361/:4369` read `hostMode` from `remoteGetState().settings.mode`, with
  `if (hostMode === '') return` at `:4376` before `await loadLink(hostMode)` at `:4378`.
- Neutral copy `lean.remote.mode.unselected` = `尚未选择访问方式` exists in both
  `locale/zh.json:300` and `locale/en.json:300` and is rendered at `src/client.js:4479-4480`.
- **Independent stub render (no writes, built dist):** host `tailscale` → `remoteShowLink` modes
  `['tailscale']` (zero `lan` calls), select value `tailscale`, 1 SVG. Host mode `''` → zero
  `remoteShowLink` calls, select value `''`, 0 SVG, remote status `尚未选择访问方式`. Host mode
  absent → identical neutral result. So d1 is behavioural, not test-shaped.

### d2 verification (explicit mode, correct order)

- `persist(nextToken, nextMode)` at `:4400-4403` builds `settings.mode` from the explicit
  `nextMode === undefined ? mode : nextMode`. The r2 signature `persist(nextToken)` reading the
  closed-over `mode` is gone. The select handler at `:4503-4509` now does
  `if (await loadLink(value)) await persist('', value)`; the old `await persist(''); await loadLink(value)`
  (which wrote the stale closure mode) is gone. Port/token blur persistence remains at
  `:4525-4527` / `:4539-4541` and correctly omits `nextMode`.
- **Independent stub render:** switching `lan → ipv6` produced saves `['ipv6']` (no `lan` save)
  and call order `remoteShowLink(ipv6)` at index 0, `remoteSaveSettings(ipv6)` at index 1.
  d2 is behavioural.

### "No mode ⇒ no QR" UX assessment

Acceptable and clear, not a blank panel: the select (3 real options), 端口, 访问令牌, 生成/复制/自检
buttons and both status lines still render; the remote status explicitly says `尚未选择访问方式`,
which names the next step. Two caveats: (a) `<select value="">` has no matching empty option, so a
real browser may visually show the first option (`局域网`) while state is empty — the status copy
disambiguates; (b) `生成`/`复制` before choosing a mode still call `loadLink('')`, which the host
turns into `undefined` via `asRemoteMode` (`src/rpc.ts:640-649`) and never guesses LAN. Neither is
a correctness failure.

### Regression checks

- Lean guard now has **16** cases (13 unchanged r2 cases + 3 new d1/d2 cases at
  `test/client-lean-inventory.test.mjs:357-397`). The 13 original inventory/M2 cases are unchanged
  and green. Remote-render still has 15 cases; the 11 dormant `RemotePanel` tests remain untouched.
- M2 truth table re-evaluated: post-save `hasToken:true` + preserved blocked ⇒ `已配置（可见性阻断，
  禁止推送）`; no sync time ⇒ `尚未同步`; genuinely no token ⇒ `未配置：缺少访问令牌`; testConnection
  success never fabricates `已同步`. Unchanged from r2.
- Mutation proof still holds: in-memory removal of the mount-time `await loadLink(hostMode)`
  changed `remoteShowLink` calls 1→0 and SVG 1→0 (≥2 guard failures); re-adding a checkbox still
  trips the exact-inventory and checkbox assertions (`:291-295`, `:302`, `:303`, `:410`). No files
  were mutated on disk.
- `git diff --quiet -- packages/dsh-dots/src/engine packages/dsh-dots/src/remote
  packages/dsh-dots/src/rpc.ts` exit 0 — still byte-unchanged; no RPC/engine edits were needed.
- `src/client.js` == `dist/client.js`: 190,586 B, 4,331 lines, SHA-256
  `D025BF1A3563960C86AFBCC4E826BFBC3FF7D4E900C1EA459FA96E6FDD51000F` — matches the claim.
  The 61-file fresh-`tsc` comparison remains unverified by this reviewer (no-build constraint).

### Gate tails

```
targeted: tests 60 / suites 0 / pass 60 / fail 0 / cancelled 0 / skipped 0 / todo 0  (exit 0)
full:     tests 628 / suites 0 / pass 627 / fail 0 / cancelled 0 / skipped 1 / todo 0  (exit 0, ~27.7 s)
```

### Residual risk

GUI/reload/device install still unverified across all rounds; conclusions are source +
stub-render evidence only. The 61 non-client dist files were not regenerated. Out-of-scope
uncommitted `apps/**` and other-lane files were observed but not reviewed.
