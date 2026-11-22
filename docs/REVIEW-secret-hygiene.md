# Review — mod-secret-hygiene

## Verdict
FAIL — Scrub completeness, doctrine and blast radius are clean and the exact URL-only regression is covered by tests, but `redact()` still returns short/lowercase credential values unchanged in named common shapes (`aiKey=`, `remoteToken=`, JSON `{"aiKey":...}`, and preferences-XML `key="..."` value/element forms), so the helper is not yet a general credential redactor. Major findings remaining: 1

## Findings

### Blocker
B1 — `tools/redact.mjs:18-19`, `tools/redact.mjs:53-56`, `tools/redact.mjs:68-70` — Semantic key binding is both too narrow and mis-anchored, so values survive in shapes explicitly named in the review scope. `CRED_KEYS` contains `token` and `api[_-]?key` but not `aiKey` or `remoteToken`, and rule 2b anchors with `\b(KEY)\s*[:=]`; a word character before the key segment (`aiKey`, `remoteToken`) defeats `\b`, and preferences XML puts `"` or `">` after the key instead of `:`/`=`, so rule 2b never fires for either `.xml` form. Such values are then protected only by the *shape* heuristics at `:65` (hex >= 24) and `:68-70` (alnum >= 24 that is mixed-case / has a separator / is >= 32 chars). Empirical probe with synthetic fixtures (presence/absence only; no values printed): 8/8 probed shapes leaked the value and produced no placeholder — `aiKey=<v>`, `remoteToken=<v>`, `{"aiKey":"<v>"}`, `{"remoteToken":"<v>"}`, `<string key="aiKey">…</string>` and `<string key="token">…</string>` (element forms), and both `key="<name>" value="<v>"` and `<string key="<name>"><![CDATA[<v>]]></string>` for short/lowercase `<v>`. The probe value was the short synthetic password fixture from `redact.test.mjs:88` (not reproduced here). With a 32-character hex value every one of these shapes is masked by rule 3, so the original incident would not recur — but a non-hex secret in these exact keys would still reach a transcript. Fix: match full key names (including `aiKey`, `remoteToken`, `authorization`, `client_secret`) without a leading word boundary over a partial key, and add a binding for XML `key=['"]...['"]` that masks the following attribute value or element/CDATA body regardless of value shape.

### Minor
M1 — `tools/redact.mjs:79-84` — `redact()`'s `catch { return s; }` is fail-open: if `mask()` ever throws, the original, possibly credential-bearing string is returned to the caller. The regex operations used are standard so this is unlikely, but a safety net should not return unredacted input on failure.
M2 — `apps/arkui-schedule/tools/test/redact.test.mjs:27-116` — All 14 cases are green, but none asserts the shapes that fail in B1 (`aiKey`/`remoteToken` assignment or JSON, XML `key=` value/element bindings, `&quot;`-encoded variants). That coverage hole is why B1 survives a 14/14 suite. Add cases asserting placeholder presence and fixture absence for each.
M3 — Gate retention: `docs/MODULES.md:18` (rule 10) requires every gate run to be `Tee-Object`-captured to `.tmp/gates-<lane>.out`. The single-file deliverable mandate for this review forbade creating a second file, so the gate numbers below come from live tool output and are "uncaptured" by rule 10's own standard.
M4 — The six snapshots use `<![CDATA[<redacted>]]>` for `aiKey`/`token`. This keeps each document well-formed (6/6 parse with root `preferences`) and is sound while they remain gitignored scratch artifacts; no in-repo consumer reads them. If one were ever restored as live preferences the literal string would become the key value, so authentication would fail closed rather than leak — acceptable, but these files must never be reinstalled.

### Nit
N1 — `docs/MODULES.md:19` allows a report to state a length class while the helper deliberately emits none. The two are consistent (rule 11 explicitly says the helper does not carry a length class), but an explicit "helper output is not a report" clause would remove ambiguity.

## Checklist

1. Scrub completeness — **PASS**. Six scrubbed snapshots identified (exactly six `.bin` preference files in `.tmp/` containing the placeholder): `install-1000006-after-schedule_settings.bin`, `install-1000006-before-schedule_settings.bin`, `install-1000006-third-schedule_settings.bin`, `prefs-1000007b.bin`, `prefs-before-schedule_settings.bin`, `prefs-now-schedule_settings.bin`. Per file, counts only: XML parses 6/6 (root `preferences`); 0 hex runs >= 24 in all 6; `aiKey` and `token` hold a placeholder in all 6 (2 credential placeholders/file); `aiFallbackKey` and `remoteToken` are empty in all 6; 0 non-placeholder credential fields and 0 non-placeholder query values in all 6. Literal placeholders 2 or 4 per file and `&lt;redacted&gt;`-encoded placeholders 2 or 4 per file, matching the expected `aiKey`/`token`/`remoteUrl` sites. A broader sweep over every key matching `(key|token|pass|secret|cred|auth|api|pwd)` found only `authMode` (value length 5) and `author` (value length 1) besides the placeholders/empties — benign, non-credential values. CDATA replacement verdict: well-formed and safe for these scratch XML files; see M4.

2. Helper correctness — **FAIL** (B1). Confirmed present and correct: pattern-based masking of userinfo (`:41`), all query values (`:42-44`), `&quot;`-encoded JSON/XML key-values (`:48-51`), `token=`/`api_key=`/`password`/`secret`/`storepass`/`keypass` (`:18-19`, `:53-56`), `Authorization`/`Bearer`/`Basic` with prefix preserved (`:58-62`), bare hex >= 24 to a single `<redacted-hex>` with no length class (`:65`), mixed-case/long alnum runs (`:68-70`), idempotency (verified true for all probed shapes), no hex length-class leakage (24/40/64 all map to one placeholder), no throw on `null`/`undefined`/`Object.create(null)`/hostile `toString`/unicode/200k input, and a guarded CLI so importing does not read stdin (`:90-98`). Confirmed broken: `aiKey`, `remoteToken`, and raw XML key bindings for short/lowercase values (B1); fail-open catch (M1).

3. Test quality — **PASS** (with M2). 14 cases R01-R14. Each substantive case asserts both placeholder presence and fixture absence (R01-R10, R14); R03/R04 pin the no-length-class property for hex, R11 pins idempotency across mixed shapes, R12 pins hostile `toString` and nullish inputs, R13 pins unicode plus a 200k-character input, R08/R09 pin query values and userinfo. The fixture is synthetic and reproducible (LCG at `redact.test.mjs:9-22`), not a real credential, and tests never echo it. Regression coverage: reverting to URL-only masking would fail R01, R03, R05, R06, R10 and others, so the incident-causing regression is genuinely covered. The coverage gap is for the *newly found* B1 shapes, not for the incident regression.

4. Doctrine — **PASS**. `docs/MODULES.md:19` is numbered item 11 inside the `## 0 模块交付纪律` list (`:7-19`), placed after rule 10 and consistent with rules 1-10. It contains all four required elements: (i) any output that may contain credentials must pass through `tools/redact.mjs` before entering a transcript/log/report; (ii) URL-only masking explicitly "does not count as redaction"; (iii) reports state only presence/absence plus length class and never a value or recoverable fragment; (iv) the scar is recorded as "a 32-character hexadecimal token in six untracked `.tmp` snapshots, cleaned in place, none found in history or source" with no value. It is labelled a hygiene rule rather than a feature, matching rule 4's "each module brings its own tests/docs/rollback" framing.

5. Blast radius — **PASS**. `.tmp/` is gitignored (`.gitignore:30` -> `.tmp/prefs-1000007b.bin`) and `git ls-files .tmp` returns 0 entries. Byte scan of 1174 files (all tracked files plus `dist-harmony/**` and both build artifact trees): 0 runs of exactly 32 hex characters, 0 hex runs of >= 24 characters within 60 characters of `(token|secret|password|api_key|authorization|bearer)`, and 55 files containing other hex runs (572 total, length classes 24/40/45/64 — hash/UUID artifacts, none 32). Caveat: the exact literal cannot be re-derived locally because all six snapshots are scrubbed (the repo's own `.tmp/scan-secret.mjs:7-8` would now report TOKEN-NOT-FOUND), so this is a pattern-level rather than byte-identity confirmation; the brief's 241-commit `git grep -f` sweep found 0 commits and this scan found no 32-hex run in scope.

6. Gates — **CONCERN**.
   - Targeted: `node --test apps/arkui-schedule/tools/test/redact.test.mjs` -> 14 tests / 1 suite / 14 pass / 0 fail / 0 skipped. PASS.
   - Full: `node --test "apps/arkui-schedule/tools/test/*.test.mjs"` -> 2960 tests / 410 suites / 2959 pass / 1 fail / 0 skipped / exit 1. The single failure is `apps/arkui-schedule/tools/test/configuredState.test.mjs:43` ("C2 只在 config.schema 信封里有值 ⇒ 已配置（迁移装机态）"), which asserts `/decodeEnvelope\(raw\)/` against the `settingsStore.ets` source. Owner: the concurrent, explicitly out-of-scope `settingsStore.ets` / `repoConfigured.ts` lane — not `mod-secret-hygiene`. No `redact` test failed. Count is above the expected ~2953 because concurrent lanes added files. See M3 for the capture caveat.

## Residual risk
- B1 is the live risk: a short or lowercase-only `aiKey`/`remoteToken` value, or any value in preferences-XML `key="..."` form, is still emitted verbatim. It does not recreate the 32-hex incident, but it breaks the general promise of rule 11.
- The literal incident value is not locally reproducible after scrubbing, so no one can byte-compare future scans against it; protected instead by the absence of any 32-hex run in tracked/artifact trees.
- The full-suite failure sits in another lane; if that lane lands before this module is committed, the global gate will stay red and must be attributed there, not "fixed" here.
- Gate logs were not written to `.tmp/` (M3), so no one can point to a retained failure log for this review's own runs.

## Evidence log
- `git rev-parse --short HEAD` -> `a31daa1`; `git status --porcelain=v1` -> scope files modified/untracked as described, plus the concurrent lane files.
- Six `.tmp` snapshots enumerated by `<redacted>` scan; gate logs containing that literal in test names were excluded from the snapshot set.
- Counts-only PowerShell `[xml]` + regex pass over the six files: `xml=True` 6/6, `root=preferences` 6/6, `hex24=0` 6/6, `cred_NONPLACEHOLDER=0` 6/6, `badQuery=0` 6/6, placeholder counts 2-4 per file; broader credential-key sweep returned only `authMode:VALUE_len=5` and `author:VALUE_len=1`.
- Synthetic-fixture probes of `redact()` in Bearer, JSON (`token`, `access_token`, `api_key`), `&quot;`-encoded, query, userinfo, XML attribute/CDATA, hex 24/40/64 and alnum forms: 10/10 masked with no fixture in output and idempotent; a second probe of `aiKey`/`remoteToken`/XML short-value forms: 8/8 leaked with no placeholder printed.
- `git check-ignore -v .tmp/prefs-1000007b.bin` -> `.gitignore:30:.tmp/`; `git ls-files .tmp` -> 0; `dist-harmony/` -> four signed HAP files; byte scan -> 1174 files, 0 32-hex runs, 0 credential-context hex runs.
- Gate outputs as reported in Checklist 6; no credential value appears in this report.

## Delta (r2)

**Delta verdict: PASS — Major findings remaining: 0.** B1 (the r1 Blocker) and M1 are closed; M2 is closed by R15-R25. M3 (gate logs not retained, because the deliverable permits only this file), M4 (scrub snapshots must never be reinstalled as live preferences) and N1 stand unchanged. r1 above is preserved verbatim and is not rewritten; this section supersedes only the findings it explicitly names.

### Backreference re-derivation — bug class genuinely gone
`tools/redact.mjs:87` is `/(["'])([^"'\n]{1,200})\1(\s*[:=]\s*)(["'])([^"'\n]{0,512})\4/g`. Because `\1` is a backreference and does not create a capture group, the five groups are: g1 opening quote, g2 key name, g3 separator, g4 value quote, g5 value. The terminal `\4` therefore closes on the **value quote** (g4), not on the value (g5). Independently executed on a synthetic JSON pair, group classification came back `g1=QUOTE, g2=NAME, g3=SEP, g4=QUOTE, g5=VALUE`; a deliberately buggy `\5` variant of the same regex produced a value-group length of 0 while the real value remained — exactly the r2-reported failure mode — which confirms the corrected `\4` is not merely cosmetically different. The `&quot;` rule at `:90-92` uses `\1` consistently for all three quote positions (only one capture group before the value group), so it does not carry the same defect. `maskedValue()` at `:27-35` recognises plain, XML-escaped and CDATA placeholders, giving idempotency for the new shapes.

### Full-key capture cannot be defeated by prefix/suffix
Rule 5 at `:95-103` captures `[A-Za-z_$][\w.$\-\[\]]*` in its entirety and applies `isCredentialKey()` (`:23-25`) as a case-insensitive substring test over `token|key|secret|pass|pwd|credential|authorization`; the leading `\b` now sits before the whole key, not inside a fixed word. Independent probes: `prefixRemoteTokenSuffix`, `x-aiKey`, `MY_API_KEY` and `not_a_secret` were all masked (4/4, placeholder present), while `aiBaseURL` was deliberately left unmasked by name (endpoint, not credential) with its query value still masked by rule 1 — matching R27. The `key`/`value` marker exclusion and auth-scheme exclusion at `:100` are explicit, so XML marker names are not over-masked and `Bearer`/`Basic` prefixes survive.

### Independent 8-shape probe (own synthetic fixture; presence/absence only)
Fixture: a fresh 16-character lowercase-only string, no digits, length < 24, so neither the hex rule nor the alnum-shape heuristic can contribute; any mask must come from semantic key binding. No value is printed.

| # | Shape | Placeholder present | Fixture absent | Idempotent | Result |
| --- | --- | --- | --- | --- | --- |
| 1 | `aiKey=` | yes | yes | yes | PASS |
| 2 | `remoteToken=` | yes | yes | yes | PASS |
| 3 | JSON `{"aiKey":...}` | yes | yes | yes | PASS |
| 4 | JSON `{"remoteToken":...}` | yes | yes | yes | PASS |
| 5 | XML element `<string key="aiKey">...` | yes | yes | yes | PASS |
| 6 | XML element `<string key="token">...` | yes | yes | yes | PASS |
| 7 | XML attribute `key="token" value="..."` | yes | yes | yes | PASS |
| 8 | XML CDATA body | yes | yes | yes | PASS |

TOTAL 8/8. Every row asserts both halves independently (placeholder present AND fixture absent); no row relies on the fixture's shape.

### Tests R15-R27
27 declarations (static grep 27/27, node reports 27 tests), R01-R27 contiguous. `assertMasked()` at `redact.test.mjs:29-32` asserts placeholder presence and fixture absence together; R15-R25 invoke it, R15-R18/R23/R26 add exact-output pins, R25 pins idempotency of all new shapes, R27 pins the endpoint exception. Not tautological: `SHORT_FIXTURE` at `:25` is lowercase-only with no digits and under the shape threshold, so a regression to shape-only masking would fail R15-R22. Both r1 findings about tests are therefore closed.

### Snapshots and doctrine unchanged
Six snapshots re-counted only: all 6 still parse as XML, `hex24=0` in all 6, placeholders present in all 6 (2/2/4/2/4/4 literal and 2/2/4/2/4/4 `&lt;redacted&gt;`-encoded, matching r1). Doctrine line 19 still contains all required phrases (mandatory pass through the helper, URL-only masking not counting as redaction, never printing a value, scar recorded without the value). No drift.

### Gate tails (delta)
- Targeted: `node --test apps/arkui-schedule/tools/test/redact.test.mjs` -> 27 tests / 1 suite / 27 pass / 0 fail / 0 skipped / todo 0.
- Full: `node --test "apps/arkui-schedule/tools/test/*.test.mjs"` -> 2973 tests / 410 suites / 2973 pass / 0 fail / 0 cancelled / 0 skipped / todo 0 / exit 0. The r1 failure at `configuredState.test.mjs:43` no longer reproduces; its owner was the concurrent `settingsStore.ets`/`repoConfigured.ts` lane, not this module. No failure to name in this delta.
- Retention caveat M3 still applies: no `.tmp/gates-*.out` was created for these runs, because the delta instruction allows appending to this file only.
