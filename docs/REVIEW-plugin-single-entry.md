# Review — mod-plugin-single-entry

Scope: uncommitted lane `mod-plugin-single-entry` on top of HEAD `4c5de17`+ (HEAD observed as `ad1d83c`). Read-only review; no builds, no overlay, no git writes, no subagents. Line numbers refer to the current working tree unless prefixed `HEAD:`.

## Verdict

CONDITIONAL PASS — the delivered client registers exactly one `settings.section` (`dots`, order 70, label `DSH-dots`) whose single page stacks both capability groups as default-open `<details>`; all 39 controls and all 11 remote assertions survive, and the guard would fail the old two-section code — but the lane's stated row-source mechanism is only half right, the "one reload" verification claim is not supported by the plugin README, and the full-suite baseline has drifted with a flaky sibling-lane test — Major findings remaining: 0.

## Findings

### Blocker

None. No second section registers, the panel is not tabs/a second view, no remote control vanished, and no assertion was deleted or loosened to make the merge pass.

### Major

None.

### Minor

- **M1 — mechanism narrative is partly wrong (check 1).** In the extracted ASAR, `@deepseek-ai/dsh-client-ui-settings-plugins` registers exactly one `settings.section` (`id:'plugins'`, order 15) and projects **tabs from `settings.plugins.tab`** (`.tmp/asar-single-entry/dsh-client-ui-settings-plugins__lib__client.js:3`, char ~3700 and ~7767); `@deepseek-ai/dsh-client-ui-settings-plugin-inventory` registers the **only** `settings.plugins.tab` entry (`id:'all'`, char ~39900 of `…plugin-inventory__lib__client.js`). The `settings.section` contract in `…dsh-cordis-client-runner__lib__client.js:267747` says "One settings page per list entry … `label` … nav rows". The two rows the user saw therefore came from **two `settings.section` registrations** in `HEAD:src/client.js:4082-4109` (`dots-remote`/order 71/`t('remote.nav')` and `dots`/order 70/`t('nav')`), not from `settings.plugins.tab`. Collapsing to one `settings.section` **is** the correct fix and does address the real row source; only the lane's description of *which* slot produced the rows is inaccurate. No functional impact.
- **M2 — guard-file count mismatch.** `test/client-single-section.test.mjs` has **6** top-level `test()` calls (`:30, :48, :62, :80, :184, :192`), not 7 as the brief states. The six are strong (see check 6); the count is a claim error only.
- **M3 — full-suite baseline drift and one flaky run.** Expected `609 / 608 / 0 / 1`; actual final run `612 / 611 / 0 / 1` (Δ +3 tests from sibling lanes). An earlier full run produced `612 / 608 / 3 / 1`: failures `T10` (`test/plugin-tools-v2.test.mjs:406`), `C15` (`test/plugin-v2-cycle.test.mjs:330`), `R10` (`test/repo-root.test.mjs:312`) — all in **sibling-lane** test files, none in this lane's changed set. Those three files pass 54/54 in isolation and the whole suite passes 0 fail on rerun, so the failures are order/concurrency-dependent flakiness in sibling source-guard tests, not a single-entry regression.
- **M4 — "only one reload" is not proven.** The diff touches no profile, install state, host RPC, or schedule/sync runtime, so no profile edit or reinstall is implied. But `packages/dsh-dots/README.md:35` states that replacing/upgrading an installed package needs a **DSH restart** to load a new client module, and this change edits `dist/client.js`; the extracted ASAR slices do not contain the module-loader host, so evidence that a bare page refresh alone is sufficient is absent. Treat the GUI verification as: one page refresh *after* whatever module load the platform requires.

### Nit

- **N1 — stale README copy (out of scope).** `packages/dsh-dots/README.md:36` still says the settings page shows 「设置 → 配置同步」; it now shows one 「DSH-dots」 row. Not in this lane's doc-debt list, but user-visible.
- **N2 — stale example label.** `BRIEF.md:28` still shows `label:()=>t('nav')` in the API snippet; shipped label is `t('panel.title')`. `BRIEF.md:44` and `docs/CONTRACT.md:263-267` are correct, so the three-namespace note itself is accurate.
- **N3 — "6 options" fixture nuance.** Production mode catalog has 6 access modes (`src/remote/accessMode.ts:42-47`: lan/tailscale/ipv6/cloudflare/manual/uu). My independent render used the test fixture's 5 modes and produced 5 `<option>` nodes; the lane's "6 options" is the production figure, not a defect.

## Checklist

1. **Mechanism — CONCERN.** ASAR read as detailed in M1. Two `settings.section` registrations at `HEAD:src/client.js:4082-4109` were the row source; `settings.plugins.tab` has a single occupant (`all`). Collapse to one `settings.section` is correct and addresses what the user saw; lane's phrase "内置插件 page enumerates settings.plugins.tab entries … our two settings.section registrations produced the rows" conflates two slots. Old labels were `nav`="配置同步" and `remote.nav`="远程访问" (the user's 「远程控制」 is the new in-page group title `group.remote`).
2. **Exactly one registration — PASS.** `src/client.js:4131-4144`: one `ctx.slots.inject('settings.section')`, one `ctx.slots.register({name:'settings.section', id:'dots', order:70, label:()=>t('panel.title')})`; no `dots-remote` section. Byte-identical `dist/client.js:4131-4144`. Regex counts in both files: `slots.register(` = 1, `name:'settings.section'` = 1, `inject('settings.section')` = 1.
3. **The shape — PASS.** `src/client.js:4081-4100` `DotsPanel` = one `div` → `h2` `panel.title` ("DSH-dots", `:4086`) + two `<details open:true>` (`:4089` id `dots` summary `group.sync`=配置同步; `:4095` id `dots-remote` summary `group.remote`=远程控制), each wrapping the original `SettingsPanel`/`RemotePanel`. No tab state, no second view, no second section. Independent render confirmed titles `["DSH-dots","配置同步","Git 配置同步","远程控制",…]` and `open===true` for both groups. `dist/client.js` identical.
4. **Control inventory / assertions — PASS.** `test/client-remote-render.test.mjs`: HEAD had 14 tests / 93 assertions, now 15 / 101; all 11 `RemotePanel：…` render tests keep their original titles and assertion bodies (diff only reroutes the mount point to `remotePanel()`). New `merged panel` test at `:789-832` mounts **only** the merged section (`:795-799`), asserts `open===true`, one `<svg>` QR (`:805`), one `<select>` (`:806`), 9 buttons (`:807`), inputs `{text:1,number:1,password:1,checkbox:1}` (`:808-817`), and in-panel text including status (运行中/绑定地址/被拒次数/最近错误), check levels (通过/注意/失败/无法自证), QR (扫码打开/用平板扫这个码) and masked token (`rt_••••••••`), plus no `TOKEN_PLAIN` (`:819-832`). No dropped/loosened assertion found.
5. **No renames — PASS.** Loader id `dsh-dots` (`src/client.js:36`, derived from `package.json.name` via `scripts/build.mjs:24-41`), RPC `/dsh-dots/rpc` (`:42`), locale NS `dots` (`:41`), roster row `id: dots` / `name: 'dsh-dots'` (`cordis.patch.yml:4-6`). `dots-remote` survives only as the in-page group id (`src/client.js:4095`); guard asserts it appears once.
6. **Guard quality — PASS (with M2).** `client-single-section.test.mjs` assertions that **fail on old two-section code**: `:31-40` inject/name counts (=1 vs 2); `:49-59` `panel.title`/`group.*` absent in old bundle and `label()` was `t('nav')`; `:63-67` old `name:'settings.section', id:'dots-remote'` present; `:187-189` sections.length 2 and label "配置同步"; `:205-215` old tree has no two `<details id=dots|dots-remote>` in one panel. `:80-87` (loader id/RPC/NS) passes on old code by design (rename guard). `client-loader-id.test.mjs` was **strengthened**: previous positive assertion `name:'settings.section', id:'dots-remote'` replaced with `assert.doesNotMatch(...)` plus `details id:'dots-remote'` assertion. `rollback-ux.test.mjs:457-462` only retargets `Panel` → `Panel.SettingsPanel || Panel`; `client-render.test.mjs` keeps every original field/button/option-count assertion and adds a merged-panel test at `:283-305`.
7. **Locale — PASS.** Node JSON parse: zh/en each 277 keys with identical key sets; `panel.title="DSH-dots"`, `group.sync="配置同步"/"Config sync"`, `group.remote="远程控制"/"Remote control"`. No `ja.json`, no `ja.*` key.
8. **Doc debt — PASS.** `git diff HEAD` shows `BRIEF.md` loader example changed `id:'dots'` → `id:'dsh-dots'` and `docs/CONTRACT.md:263-267` likewise; both now state loader id = package name `dsh-dots`, slot id `dots` (with `dots-remote` in-page only), RPC `/dsh-dots/rpc`, locale NS `dots`. See N2 for a harmless stale example label.
9. **Gates — CONCERN.** `tsc -p tsconfig.json --noEmit` → exit 0. Targeted 5 files → **46 / 46 / 0 / 0**, exit 0. Full suite → **612 / 611 / 0 / 1**, exit 0 (one earlier run 612/608/3/1, see M3; skip is the environment-dependent LAN/proxy case at `test/remote-listener.test.mjs:52`). `dist/client.js` == `src/client.js` == fresh `renderClientSource()` byte-for-byte: **169,145 B**, SHA-256 **`5e2e2cbba619712c4ba5ac9c68c16316564210ed82c73cab14be073c3160ef41`**. `pnpm build` was **not** run (builds forbidden for this review); dist freshness was verified without writing.
10. **Reload — CONCERN.** No profile edit, reinstall, host/RPC change or schedule/sync edit is implied — only client module, tests, locale and docs. User's exact words (from the requirement): 「为什么是两个插件，我要一个」; the mandated shape: one row `DSH-dots` with the two capabilities as stacked sections (配置同步 then 远程控制) on that one page, not tabs. Verification instruction implied by the lane is a single GUI refresh; see M4 — the plugin README says a DSH restart is normally required to load a new client module, so "one refresh, no restart" is unverified.

## Control inventory verdict

**39 before / 39 after — confirmed.** I independently loaded the built module with a fake React and the test fixture's `fakeState`/`fakeLink`, rendered the single section component, walked both `<details>` groups and counted interactive elements: sync group `dots` = **14 buttons + 9 inputs + 2 selects = 25**; remote group `dots-remote` = **9 buttons + 4 inputs + 1 select = 14**; total **39**. Additionally: 1 `<svg>` QR (10 `<rect>` modules) inside the remote group, and `<option>` nodes from the mode catalog (5 in the 5-mode test fixture; 6 modes in production `src/remote/accessMode.ts:42-47`). Only the two panel wrappers were merged; no control was removed. This agrees with the test-level evidence: `client-render.test.mjs:213-217` (select 2, input 9, buttons ≥8) and `:622-633` (QR SVG, 9 buttons, 4 inputs in the merged remote group); 93 → 101 assertions across the remote test file.

## Residual risk & unverified

- Live DSH/GUI behavior is **unverified**: no install, restart, refresh or screenshot was performed (read-only review). Whether a bare page refresh loads the new client module is unproven (M4).
- `pnpm build` was not executed (forbidden); "build 0" is reported as unverified, with `tsc --noEmit` 0 and src==dist==fresh-render as the available substitutes.
- Full-suite numbers are unstable in this tree: the final passing run was 612/611/0/1, an earlier run 612/608/3/1 due to flaky sibling-lane source-guard tests; the lane's expected 609/608/0/1 no longer matches the tree (sibling lanes added tests).
- Mechanism attribution in M1 is a documentation/analysis error only; it does not change the fix's correctness.
- README copy drift (N1) and the stale BRIEF example label (N2) are outside the lane's declared doc-debt files.

## Evidence log

- `read` `src/client.js` (1-4149), `dist/client.js` registration grep, `scripts/build.mjs:24-41`, `package.json`, `cordis.patch.yml:1-6`.
- PowerShell regex counts + `Get-FileHash`: src/dist each 169,145 B, `slots.register=1`, `name:'settings.section'=1`; `BYTE_IDENTICAL=True`.
- `node --input-type=module -e` importing `renderClientSource()`: `freshEqualsDist=true`, `freshEqualsSrc=true`, sha `5e2e2cbb…` for all three.
- PowerShell extraction of `.tmp/asar-single-entry/dsh-client-ui-settings-plugins__lib__client.js` (chars 3700/6700/6900/7700) and `…plugin-inventory__lib__client.js` (chars 39400/39900/40300), plus `…dsh-cordis-client-runner__lib__client.js:267747` slot contract.
- `git show HEAD:packages/dsh-dots/src/client.js` lines 4078-4112 (two `settings.section` registrations with labels `t('remote.nav')` and `t('nav')`).
- `git diff HEAD --` on the five in-scope test files, `BRIEF.md`, `docs/CONTRACT.md`; `node --test` targeted 5 files (46/46/0/0) and full glob (final 612/611/0/1; earlier 612/608/3/1); `tsc --noEmit` exit 0.
- `node --input-type=module -e` UTF-8 locale parse: 277 keys each, sets equal, no `ja`.
- `node --input-type=module -e` independent merged-panel render + walk (counts above), and locale-safe JSON verify.
