# Review — plugin pairing certificate generator (security)

Scope: `packages/dsh-dots/src/remote/pairingTls.ts` (DER/X.509 generator + fingerprint), `packages/dsh-dots/src/remote/store.ts` (`readCert`/`writeCert`), `packages/dsh-dots/src/remote/pairingProvision.ts` (creation/rotation + fingerprint into payload). Read-only review; no builds, tests executed, git writes, or device commands were performed. No key material, tokens, or private-key bytes are reproduced below.

## Verdict

CONDITIONAL PASS — The hand-rolled DER encoder is structurally correct and its SHA-256-over-DER fingerprint independently matches Node/OpenSSL's `fingerprint256`, with no Blocker or Major structural defect; the conditions are a missing cryptographic signature re-verification test, an absent GeneralizedTime path (year clamped to 2049), and unverified tablet-side TLS/hostname behavior. Major findings remaining: 0

## Findings

### Blocker
None.

### Major
None.

The four classic silent-TOFU-breakers were specifically checked and not found:
- No wrong SAN GeneralName tag is emitted — there is no SAN at all (see Checklist 5).
- The inner/outer signature AlgorithmIdentifiers are the *same array object*, so they cannot mismatch (Checklist 3).
- No 2050+ year is ever encoded as UTCTime; years ≥ 2050 are clamped to 2049 instead (Checklist 4 — non-conformant but not the named Major condition).
- The fingerprint is computed over the emitted DER, not PEM or a re-serialisation, and equals an independent OpenSSL computation (Checklist 8).
- The signature is taken over the exact `tbs` byte array that is embedded into the certificate (Checklist 7).

### Minor
- **M1 — No signature re-verification test (Checklist 7, `test/pairing-provision.test.mjs:177-186`).** Test V6 parses the PEM with `new X509Certificate(...)`, asserts `subject === 'CN=DSH Dots Pairing'`, compares `parsed.fingerprint256` to the pin, checks the fingerprint regex and that `keyPem` contains `PRIVATE KEY`. It never calls `parsed.checkIssued(parsed)` or `parsed.verify(...)` against the emitted public key. Parsing a certificate does **not** validate its signature — a certificate carrying a garbage signature would still parse and still produce a matching fingerprint. The emitted DER is therefore proven *parseable* and *pinnable*, but **not proven to cryptographically verify**. Static analysis says it should verify (correct TBS bytes, PKCS#1 v1.5, matching OID), but per the review's own standard "it produced bytes" is not evidence. Add a round-trip test that re-verifies the signature from `parsed.raw` / `parsed.publicKey` before claiming this property.
- **M2 — No GeneralizedTime path; year silently clamped (Checklist 4, `pairingTls.ts:77-86,131`).** `utcTime()` clamps to `[1950, 2049]` and always emits tag `0x17` (UTCTime); there is no switch to GeneralizedTime (tag `0x18`) for years ≥ 2050. NotBefore/notAfter are `now` and `now + 10y` (`pairingTls.ts:131`), so with the current 2026 clock the window is 2026→2036 and both timestamps are correctly UTCTime. From ~2040 onward notAfter would cross 2050 and be back-dated to 2049, producing a structurally valid but factually wrong (possibly zero/negative) validity window. RFC 5280 requires GeneralizedTime for 2050+. Does not affect TOFU pinning, but is a latent correctness defect and should be fixed if the artifact is meant to remain conformant.
- **M3 — SAN / keyUsage / extKeyUsage all absent (Checklists 5 & 6).** Consistent with an X.509 **v1** certificate (v1 cannot carry extensions) and with a fingerprint-pinned trust model, but modern TLS stacks that require SAN and ignore CN will reject a CN-only certificate during hostname verification. Whether the tablet performs standard hostname verification or pure fingerprint pinning is out of scope (`apps/**`) and **unverified** — see Residual risk.
- **M4 — Full state (incl. private key) crosses the internal API boundary (`pairingProvision.ts:105-109,111-122,264-271,312-327`).** `PairingProvisionResult.state` carries `cert: PairingCertificate` including `keyPem`, and `createPairingService().provision()` returns that result to its caller. The sanitized `view` (`describePairing`) and the payload/text/QR are clean, and no `console.*` exists anywhere in `src/remote/**` (grep: no matches), but any RPC layer that serializes the whole `provision()` result would leak the private key. Confirm the out-of-scope RPC binding only consumes `view`/`payload`/`text`, never `state`/`cert`.

### Nit
- **N1 — Threat-model wording (`pairingTls.ts:1-12`).** The header states "自签证书" (self-signed) and "SHA-256 冒号指纹用于 TOFU pin" and that only the fingerprint appears in the payload, but it never says plainly "for TOFU pinning, **not** CA trust; because it is self-signed the fingerprint is the **sole** authenticity signal." The implication is clear; stating it explicitly would satisfy Checklist 11 without ambiguity.
- **N2 — Hand-roll justification is present but terse (`pairingTls.ts:4-6`).** "No prior generator / zero npm deps / only `node:crypto`" is a stated reason (Checklist 10), though it does not weigh the alternative of a maintained library.

## Checklist

**1. DER length encodings — PASS.** `derLength()` (`pairingTls.ts:27-36`) implements the long form correctly: for `length >= 0x80` it emits big-endian content octets via `unshift` and prefixes `0x80 | octetCount` (e.g. 128 → `0x81 0x80`; 256 → `0x82 0x01 0x00`). Lengths are computed bottom-up: `tlv()` derives the length from `content.length` (`:38-40`), and `sequence()`/`setOf()` flatten children before wrapping (`:42-48`), so nested SEQUENCE lengths (TBS, certificate, SPKI passthrough at `:132-134`) are all computed, never assumed. No post-hoc length patching exists anywhere in the module. Note `:132-133` explicitly avoids double-wrapping the already-DER SPKI — correct.

**2. INTEGER / serial — PASS.** `serial = derInteger(BigInt('0x' + randomBytes(8).hex) & 0x7fffffffffffffffn)` (`pairingTls.ts:130`) masks the top bit, yielding a 63-bit non-negative value from 8 CSPRNG bytes — positive, non-zero except with ~2⁻⁶³ probability, and reasonably random. `derInteger()` (`:50-58`) prepends `0x00` whenever the first content byte has bit 7 set, so the general positivity rule is implemented even though the mask makes it unnecessary here.

**3. AlgorithmIdentifier OIDs — PASS.** `SHA256_WITH_RSA = '1.2.840.113549.1.1.11'` (`:115`) is correct. A single `algorithm` array (`:129` = `SEQUENCE { OID sha256WithRSAEncryption, NULL }`) is referenced in both the TBS `signature` field and the outer `signatureAlgorithm` (`:134,137`), so they are byte-identical by construction — the classic inner/outer mismatch is impossible. `derOid()`/`base128()` (`:60-75`) produce the correct encoding (`06 09 2A 86 48 86 F7 0D 01 01 0B`). The SPKI is exported by `publicKey.export({type:'spki',format:'der'})` (`:133`), whose internal AlgorithmIdentifier is `rsaEncryption` (1.2.840.113549.1.1.1) — correct for SPKI, distinct from the signature OID.

**4. Validity encoding — CONCERN.** UTCTime format `YYMMDDHHMMSSZ` (`:77-86`) is correct for the current era. notBefore = `now`, notAfter = `now + 10*365d` (`:131`) — correct ordering, sane window. However there is **no** GeneralizedTime branch: `year = clamp(1950..2049)` and tag `0x17` is always used. A date in 2050+ is back-dated to 2049 rather than switched to GeneralizedTime — non-conformant with RFC 5280 and a latent wrong-date defect, but not the named "encode 2050+ as UTCTime" Major, and immaterial to fingerprint pinning today. See M2.

**5. SubjectAltName — PASS (absent by design).** The generated certificate has **no** SAN extension. `generatePairingCertificate()` accepts only `now`, `commonName`, `modulusLength` (`pairingTls.ts:108-113`); it never receives a host. The bracketed IPv6 text form `[2001:db8::1]` exists only in the pairing payload via `normalisePairingHost()` (`pairingPayload.ts:119-125`) and never reaches the certificate, so there is zero risk of brackets or a text-form IPv6 being encoded into an IP SAN. No `dNSName` (tag 2) / `iPAddress` (tag 7) GeneralName encoding exists to get wrong. Subject is a single `CN=DSH Dots Pairing` RDN (`pairingTls.ts:128`). Deployment caveat in M3.

**6. keyUsage / extKeyUsage — CONCERN (explicitly absent).** Both are absent. This is structurally mandated by the choice of X.509 **v1** (TBSCertificate at `pairingTls.ts:134` omits version and all `[3] EXPLICIT` extensions), so no contradictory/mis-set bits can be emitted, and "absent = unconstrained" is acceptable for a pinned self-signed cert. It is not, however, accompanied by a stated rationale in the module header (the "or explicitly absent with a stated reason" clause is only partly met). No Major; see M3 for the strict-validator caveat.

**7. Signature actually verifies — CONCERN (code correct, test gap).** `signature = sign('sha256', Buffer.from(tbs), privateKey)` (`:136`) signs the **exact** `tbs` array that is embedded unchanged in `sequence(tbs, algorithm, ...)` (`:137`); `Buffer.from()` copies those bytes and `sequence().flat()` copies the same numeric values without re-encoding — no sign/emit divergence. The BIT_STRING content `[0, ...signature]` (`:137`) has the correct zero-unused-bits prefix. `sign()` with an RSA key uses RSASSA-PKCS1-v1_5, matching the `sha256WithRSAEncryption` OID. **But** the only test (`test/pairing-provision.test.mjs:177-186`) stops at parse + subject + `fingerprint256`; it never re-verifies the signature (`checkIssued`/`verify` absent from the whole repo — grep: no matches). Parse success is not signature verification. See M1.

**8. Fingerprint — PASS.** `fingerprint: pairingFingerprintOf(certDer)` (`pairingTls.ts:138,142`) hashes the emitted DER `Buffer`, not the PEM and not a re-serialisation. `pairingFingerprintOf()` (`pairingPayload.ts:159-166`) computes `createHash('sha256').update(der).digest('hex')`, upper-cases, and formats as 32 colon-separated octets; the PEM branch base64-decodes back to DER so both input forms converge. The same value enters the payload via `tlsFingerprint: cert.fingerprint` (`pairingProvision.ts:227`), is validated/normalised by `normalisePairingFingerprint()` (`pairingPayload.ts:148-157,201-215`), and is checked in `verifyPairingAgainst()` (`:402-404`). Crucially, test V6 asserts `parsed.fingerprint256 === cert.fingerprint` (`pairing-provision.test.mjs:182`) — an **independent** OpenSSL/Node computation over the parsed DER equals the TOFU pin. `store.readCert()` enforces the `^[0-9A-F]{2}(:[0-9A-F]{2}){31}$` form (`store.ts:132`). Strong PASS.

**9. Key storage — PASS (one interface caveat).** Cert + private key are written through `writeFilePrivate()` with `mode: 0o600` and atomic tmp+rename, directories `0o700` (`store.ts:33-57`); the file is `remote-pairing-cert.json` (`:78-85,137-145`). Windows ignores POSIX mode (comment at `:41` acknowledges this). No `console.*` anywhere in `src/remote/**` (grep: no matches). The sanitized `view`/`describePairing` exposes only the fingerprint and `token: 'present'` (`pairingPayload.ts:312-348`), the QR is built from `text` only (`pairingProvision.ts:317-325`), and errors are typed with reasons that never echo values (`pairingPayload.ts:60-78,373-406`). Caveat M4: the private key is present in the internal `state` returned by `provision()`.

**10. Library vs hand-roll — PASS (justification stated).** No cert/asn1 library is available: root `package.json` has only `@types/node` and `typescript`; `node_modules/.package-map.json` lists only `@types/node`, `typescript`, `undici-types`; no `node-forge`, `selfsigned`, `pkijs`, `asn1js`, or `@peculiar/x509` anywhere (grep: no matches), and `dsh-dots/package.json` declares zero dependencies. `crypto.X509Certificate` is parse-only and cannot generate. The hand-roll justification is stated at `pairingTls.ts:4-6` (no prior generator, zero npm deps, only `node:crypto`). A maintained library (`node-forge`, `@peculiar/x509`, or `selfsigned`) could replace the ~150-line encoder with materially less ASN.1 risk *if* dependency policy allows; given the bounded TOFU threat model and the encoder's demonstrated structural correctness, replacement is recommended only to close the test/format-drift surface, not because a concrete defect was found. See Final answer.

**11. Threat model written down — PASS (could be more explicit).** `pairingTls.ts:1-12` states this is the sole self-signed ("自签") certificate scheme, that the SHA-256 colon fingerprint is for the "TOFU pin", that only the fingerprint appears in the pairing payload/status/describe, and that rotation invalidates old payloads. It conveys TOFU-not-CA intent, but does not spell out "self-signed ⇒ fingerprint is the only authenticity signal" (N1).

## Threat model assessment

The module's trust model is sound and internally consistent: a self-signed RSA-2048 certificate whose only security-relevant output is a SHA-256-over-DER pin absorbed into the v1 pairing payload; the tablet is expected to trust-on-first-use the fingerprint, and rotation deliberately invalidates old pins (`pairingProvision.ts:284-288`, `pairingPayload.ts:402-404`). Under this model the certificate's validity window, SAN, and extension bits are not authenticity signals, which is why their absence/degradation is rated CONCERN rather than Major. What matters absolutely — fingerprint input bytes, inner/outer OID identity, and signature-over-emitted-TBS — was verified structurally correct. The residual gap is *evidence*: no test cryptographically re-verifies the emitted signature, so the "verifiable artifact" property rests on static analysis plus the fact that OpenSSL parses the DER and agrees on the fingerprint.

## Residual risk & unverified

- **Signature verification not executed.** No build/test run (per task constraints). The signature's validity is asserted from code structure only; a `checkIssued`/`verify` round-trip test is absent (M1). This is the single largest unverified claim.
- **Tablet-side behavior out of scope.** Whether the tablet pins by fingerprint *and* skips hostname verification, or uses a standard TLS stack that requires SAN/EKU, is unknown (`apps/**` excluded). A CN-only v1 cert with no SAN will fail strict hostname verification (M3).
- **0600 on Windows.** POSIX mode bits do not actually restrict ACLs on Windows (`store.ts:41`); real file confidentiality on the deployment host was not verified.
- **Serial zero probability.** ~2⁻⁶³ (non-zero not strictly guaranteed); immaterial.
- **2040+ validity.** GeneralizedTime switch absent; would back-date a future notAfter (M2). Not exercised by the current 2026 clock.
- **RPC binding.** Whether any out-of-scope caller serializes `PairingProvisionResult.state` (private key) into logs/RPC was not inspected (M4).

## Evidence log

| Item | Source (file:line) | Observation |
|---|---|---|
| Long-form DER length | `pairingTls.ts:27-40` | Correct big-endian long form; lengths computed bottom-up; no post-hoc patching |
| Nested SEQUENCE / SPKI | `pairingTls.ts:42-48,132-137` | `flat()` before wrapping; SPKI passed through, not double-wrapped |
| Serial | `pairingTls.ts:50-58,130` | `randomBytes(8) & 0x7fff…`; positive 63-bit; leading-zero rule implemented in `derInteger` |
| OIDs | `pairingTls.ts:60-75,115,129,134,137` | `1.2.840.113549.1.1.11` correct; one `algorithm` array used twice; SPKI from Node export |
| Validity | `pairingTls.ts:77-86,131` | UTCTime only; year clamped to 2049; no GeneralizedTime; ordering/window correct |
| SAN | `pairingTls.ts:108-113,128,134`; `pairingPayload.ts:119-125` | No SAN emitted; generator takes no host; bracketed IPv6 lives only in payload |
| keyUsage/EKU | `pairingTls.ts:134` | v1 TBS — no extensions; absent with implicit (not explicit) rationale |
| Signature bind | `pairingTls.ts:136-137` | `sign()` over exact `tbs` array embedded in certificate; `BIT_STRING [0, …sig]` |
| Signature test | `test/pairing-provision.test.mjs:177-186` | Parses + checks subject/fingerprint only; no `checkIssued`/`verify` |
| Fingerprint | `pairingTls.ts:138,142`; `pairingPayload.ts:159-166`; `test/pairing-provision.test.mjs:182`; `store.ts:132` | SHA-256 over DER; matches independent `parsed.fingerprint256`; correct format; enters payload |
| Key hygiene | `store.ts:33-57,78-85,137-145`; `pairingPayload.ts:312-348`; grep `console.` | 0600/0700 atomic writes; view sanitized; no console prints in `src/remote/**` |
| Dependencies | root `package.json`, `node_modules/.package-map.json`, `dsh-dots/package.json`, grep for forge/selfsigned/etc. | Only `@types/node`, `typescript`, `undici-types`; no cert library; hand-roll reason stated at `pairingTls.ts:4-6` |
| Threat model | `pairingTls.ts:1-12` | TOFU pin + self-signed + fingerprint-only exposure stated; "not CA trust / sole signal" implied, not explicit |
