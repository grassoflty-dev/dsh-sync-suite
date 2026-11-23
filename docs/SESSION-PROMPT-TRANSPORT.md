# Session prompt transport — design only

## 1. Question & scope
The current `sessionPrompt` path is dark: it has a channel gate, a lease, a record-on-success ledger, and a delivery port whose production default refuses 【C1】. Question: **which exact DSH API carries a prompt into a session, and what are its failure modes?** **This is design only — no code, no tests, no builds, and no runtime claim**; every statement below is tagged 【Cn】 and resolved in §7.

## 2. Candidate API
**Found (host/Cordis path):** `SessionController.prompt(request: SessionPromptRequest, signal: AbortSignal): Promise<SessionPromptValue>` — async 【C2】【C3】, exposed as the Cordis service `sessionController` (wire namespace `session`) 【C4】.
- `request` = `{ requestId, sessionId, mode: 'queue' | 'steer', content: readonly PromptContentPart[], clientTimeZone? }`; text part = `{ type: 'text', text }` 【C5】【C6】. Our `text` maps to one text part; mode choice is a Lead decision (§8). The `signal` argument is required and calls `throwIfAborted()` 【C9】.
- **Return:** `{ accepted: true }` and nothing else — no seq, no sha, no message id 【C7】. Our seam expects `{ seq, sha256, accepted }` 【C20】, so those two fields have no identified DSH source 【C20】.
- **Thrown failures:** `gateway/bad-request` (empty content), `session/invalid-time-zone`, `session/model-unavailable`, `session/attachment-invalid`, `session/not-found`, `session/agent-busy`, `gateway/internal` 【C8】【C10】. Direct host calls throw; the generated Remote face instead folds carrier failures into `{ ok:false, error }` (`RemoteResult`) 【C11】.
- **Reachability:** our plugin already uses `ctx.inject([...], scope => ...)` and `ctx.tools` 【C13】; `Context.sessionController` is declared by module augmentation 【C4】. Whether this service is actually mounted in the running profile is **unverified** — no readable registration site 【C14】.
- **Idempotency in DSH itself:** before admitting, `prompt()` checks `hasPromptRequest(agent, requestId)` across inbox items and durable `user/message` events, and returns `{accepted:true}` without re-adding 【C12】.
- **Other faces seen, not selected:** client contract `ISession.prompt(content, mode, signal?, requestId?)` 【C15】 and SDK JSON-RPC `'session/prompt'` → `{messageId}` 【C15】. Neither is the host-plugin port.
- **Source coverage:** the named checkout `…\app.asar\dsh\` is **not a directory**; `app.asar` is a 209 MB file; `app.asar.unpacked\dsh\` contains only native node_modules 【C16】. Readable source was the profile's installed `@deepseek-ai` copy (junctions into the npm `_npx` cache) 【C17】; those packages ship `lib/types/*.js|*.d.ts` but no `package.json`, and there is no profile lockfile, so the DSH version is **unverified** 【C18】.

## 3. Failure-mode mapping
Rule: a rejection before/inside the call is *attempted and failed*; only an absent service/port means *nothing took the request*; unknown or undeclared errors never become success 【C29】.

| API failure | Our typed code | Basis |
|---|---|---|
| `sessionController` absent/unmounted, no delivery port (DARK default) | `E_SESSION_UNAVAILABLE` | 【C1】【C14】 |
| Any `RemoteError` from `prompt()` (all codes in §2), aborted `signal`, malformed/undeclared error or result | `E_SESSION_DELIVERY_FAILED` | 【C8】【C9】【C29】 |
| `{accepted:true}` returned but ledger write fails/absent | `E_SESSION_RECORD_FAILED` | 【C21】 |
| Precondition refusals (channel/grant/text/lease/duplicate) | their own codes, not these three | 【C22】【C23】 |

## 4. Idempotency when the API is not idempotent
We keep record-on-success honest: the ledger is keyed by `(sessionId, requestId)` and written **only after** `ok:true` 【C21】; a 10-minute same-session dedupe window blocks naive repeats 【C22】. The port plugs in at `DeliveryPort.send` / `createRpcService`'s `options.prompt` seam — no other change is proposed here 【C21】.
What we can prove locally: ledger rows, lease rows, our own gate decisions 【C21】【C23】【C24】. What we cannot: (a) the delivered-but-unrecorded window, because DSH returns no seq/sha/messageId to bind the row to 【C7】【C20】; (b) whether a later `{accepted:true}` was a first delivery or DSH's dedupe short-circuit 【C12】; (c) that `followup()` had committed a durable event when it returned (it is typed `void`) 【C28】.
Refusal copy must carry the existing operational instruction, verbatim: `会话已写入但请求记录未落盘，请先刷新会话确认，勿盲目重发` for `E_SESSION_RECORD_FAILED`; delivery failure says `已尝试投递但失败（会话未写入），可用同一请求号重试` — the latter's "not written" claim is not provable for an ambiguous throw and is a Lead decision (§8) 【C22】.

## 5. Lease guarantee immediately before the write
Gate order is channel → grant → text → lease → head → idempotency → delivery availability 【C23】. At the instant of the call: lease valid, `owner === 'dots'`, `nowMs < expiresAt`, and `expectedPrevSha === actualHeadSha` (empty head ⇒ `E_HEAD_MOVED`) must all hold; the claim is persisted before `send()` 【C23】【C24】【C30】. The head is read through `HeadReaderPort`; today it defaults to the lease's own `headSha` (fail-closed), whose authority as a DSH head is **unverified** 【C30】.
After the call: the honest position is that no head re-check exists in the current service — it returns the projected delivery and writes the ledger directly 【C25】. The API has no CAS/`expectedPrevSha` parameter 【C26】; if the head moves during the call, our prompt and the other writer can both be admitted, and no message-delete/undo path was found in the readable DSH types 【C27】. Detection after the fact would require a trustworthy head reader; rollback cannot be promised 【C27】【C30】.

## 6. What a DSH restart would let us observe
Evidence to capture after a real restart with the port enabled:
1. A real `user/message` event in the target session with `source.rpcId === requestId`, followed by a turn (admission proof) 【C12】【C28】.
2. The ledger row keyed `(sessionId, requestId)` with `atMs` 【C21】.
3. The lease row with `owner=dots`, `expiresAt`, `headSha` 【C24】.
4. The direct response `{accepted:true}`, or the concrete `RemoteError` code; note our seam still demands `{seq,sha256,accepted}` 【C7】【C20】.
Still unverifiable even then: that the model actually processed the turn (acceptance is inbox admission) 【C28】, first delivery vs dedupe replay 【C12】, and that the head reader reflects the real DSH head 【C30】.

## 7. Verification ledger
| id | claim | status |
|---|---|---|
| C1 | dark seam, default port refuses, ledger+lease exist | verified: `packages/dsh-dots/src/remote/sessionPrompt.ts:4-11,82-88,201-203`; `src/rpc.ts:1199-1227` |
| C2 | `SessionController.prompt(request, signal)` signature | verified: `~/.dsh/profiles/node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/index.d.ts:138` |
| C3 | async `Promise<SessionPromptValue>` | verified: same file:138 |
| C4 | service key `sessionController`, namespace `session`, Context augmentation | verified: `…/dsh-api-session-controller/lib/types/index.js:193`; `…/lib/types/index.d.ts:14-19` |
| C5 | request fields incl. `requestId`/`mode`/`content`/`clientTimeZone` | verified: `…/dsh-api-session-controller/lib/types/types.d.ts:292-300` |
| C6 | text content part shape | verified: same file:64-75 |
| C7 | success value is `{accepted:true}` only | verified: same file:301-304 |
| C8 | prompt error codes thrown | verified: `…/dsh-api-session-controller/lib/types/commands.js:283,289,296,319,340,342`; `…/lib/types/agent.d.ts:32`; `…/lib/types/index.js:199-200` |
| C9 | `signal` required; `throwIfAborted()` | verified: `…/lib/types/index.d.ts:138`; `…/lib/types/index.js:392-394` |
| C10 | declared `RemoteError` code vocabulary | verified: `…/dsh-api-session-controller/lib/types/types.d.ts:164-194`; `…/dsh-typert-protocol/lib/types/types.d.ts:39-48` |
| C11 | `RemoteResult` error branch on generated face | verified: `…/dsh-typert-protocol/lib/types/types.d.ts:59-71` |
| C12 | dedupe by `rpcId` across inbox + durable events | verified: `…/dsh-api-session-controller/lib/types/commands.js:292-293,526-539` |
| C13 | plugin inject pattern and `tools` service | verified: `packages/dsh-dots/src/index.ts:64-65,98-106`; `src/schedule/tools.ts:43-46` |
| C14 | service mounted in this running profile | unverified: no readable registration/bundle source; type augmentation only |
| C15 | client `ISession.prompt` and SDK `'session/prompt'` shapes | verified: `…/dsh-api-session-controller/lib/types/client/contract/session.d.ts:81-83`; `…/dsh-sdk-protocol/lib/types/types.d.ts:51-55,104-112` |
| C16 | named asar checkout absent; unpacked tree native-only | verified: filesystem probe `…\app.asar\dsh\` Test-Path=False, `app.asar` 209021953 B, `app.asar.unpacked\dsh\` has only `node_modules` |
| C17 | readable installed packages are junctions into npm cache | verified: `Get-Item` Target for `~/.dsh/profiles/node_modules/@deepseek-ai/dsh` → `_npx\1e7f6d9597241db0\…`; all cited `lib/types` files read there |
| C18 | no package.json/lock for these packages; version unknown | verified: `…/@deepseek-ai/dsh*/package.json` Test-Path=False; `~/.dsh/profiles/{pnpm-lock.yaml,package-lock.json}` False; bundles at `~/.dsh/profiles/desktop/package.json:6-15` |
| C20 | our seam result shape vs DSH return | verified: `packages/dsh-dots/src/remote/sessionPrompt.ts:59-63,184-189`; same as C7 |
| C21 | record-on-success, ledger key `(sessionId,requestId)`, port seam | verified: `…/remote/sessionPrompt.ts:7-11,73-76,201-203,309-317`; `…/remote/promptLedger.ts:4,186-195`; `src/rpc.ts:241-244` |
| C22 | 10-min window and exact refusal wording | verified: `…/remote/promptGate.ts:113-117`; `…/remote/promptWording.ts:20,82-83` |
| C23 | gate order, dots-only lease, head comparisons | verified: `…/remote/promptGate.ts:69-120`; `…/remote/lease.ts:396-415` |
| C24 | lease persisted before delivery | verified: `…/remote/sessionPrompt.ts:280-281` |
| C25 | no post-call head re-check | verified: `…/remote/sessionPrompt.ts:286-317` |
| C26 | no CAS/`expectedPrevSha` in DSH request | verified: `…/dsh-api-session-controller/lib/types/types.d.ts:292-300` |
| C27 | no undo/delete path in readable types | unverified: absence only within `…/dsh-api-session-controller/lib/types/index.d.ts:59-177`; other packages not exhaustively searched |
| C28 | acceptance = inbox admission; `followup()` is void | verified: `…/dsh-api-session-controller/lib/types/types.d.ts:301-304`; `…/dsh-agent/lib/types/runtime-types.d.ts:186-192` |
| C29 | failure→typed mapping, unknown→deliveryFailed | unverified: design decision; no runtime observation |
| C30 | head reader defaults to lease head; authority unknown | verified for default: `…/remote/sessionPrompt.ts:90-93,257-259`; authority: unverified, no DSH head API read |

## 8. Open questions for the Lead
1. Approve `ctx.sessionController.prompt` as the port target, or require the SDK JSON-RPC face instead?
2. Keep `{accepted:true}` as sufficient success, or require a seq/sha source before the ledger write?
3. Accept DSH `requestId` dedupe as the recovery path for delivered-but-unrecorded, or confirm-only?
4. Keep the verbatim "会话未写入" wording for `E_SESSION_DELIVERY_FAILED`, or make it ambiguity-safe?
5. Choose `queue` always, and is a post-call head re-check required even though it cannot roll back?
