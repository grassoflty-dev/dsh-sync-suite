# 独立只读评审 — batch b11：`mod-plugin-v2-marksynced`

- 评审对象：`main` @ `8c824028ffe00a880ec7a88d06867ae3339646d1`；工作树中未提交车道 `mod-plugin-v2-marksynced`，范围 5 条路径：`packages/dsh-dots/src/rpc.ts`、`src/sync/bootstrap.ts`、`test/v2-marksynced.test.mjs`、`dist/rpc.js`、`dist/sync/bootstrap.js`。
- 评审方式：只读 + 自跑门禁 + 自写只读探针；**不运行** `node scripts/build.mjs`（`dist/` 归别的车道），不写 `src/**`/`test/**`/`dist/**`，不执行任何 git 写命令，不联网，不用 `hdc`，不打印任何 token。
- 允许写入的唯一仓库文件：**本文**；所有门禁 / 探针输出只落 gitignored `.tmp/gates-rvms-*.out`。
- 立场：攻击声明本身，不复述车道汇报；(1)–(5) 与 (a)–(f) 逐条给裁定。

---

## 0 结论

- **P0 = 0，P1 = 0，P2 = 5**。裁决：**Freeze-with-fixes**（可冻结，附带 5 条 P2 边界 / 文案 / 测试覆盖修补）。
- 一句话裁决：**核心机制经独立读码与实跑成立**——v2 周期成功确实落戳，所有「没真推」路径零动作且 `lastSyncAt` 原值不动，ISO 形状与既有 `markSynced()` 完全一致，`dist` 与源码新鲜 emit 逐字节一致，FF 模块的三个 `dist/sync` 守卫文件未被任何车道重建。问题集中在「声明比证据多说了一寸」：`attempts: Infinity` 会落戳（P2-1）、「总函数绝不抛」被抛异常 getter / 撤销 Proxy 反例击穿（P2-2）、「两个调用点恰好一戳」只测了「成功 + no-op」，两次成功实测两戳（P2-3）、v1 `push(pushed:false)` 语义被悄悄收窄（P2-4）、写戳失败隔离正确但零测试覆盖（P2-5）。
- 冻结前提：修正 §5 的 P2-1 ~ P2-5；**不要**因为并发车道刚改了 `src/sync/cycle.ts` / `src/sync/syncGate.ts` / `src/chats/**` 导致全树 emit 对不上而回滚本模块（那些改动在评审期间出现，起始 status 中不存在，属别的车道，见 §1.4、§6）。

| # | 级别 | 一句话 | 位置 |
| --- | --- | --- | --- |
| P2-1 | P2 | `attempts: Infinity` 仍满足 `typeof number && > 0` ⇒ 落戳，与「Infinity 不落戳」及测试标题「一切畸形形状全部拒绝」矛盾 | `src/sync/bootstrap.ts:49-50`、`test/v2-marksynced.test.mjs:79-97` |
| P2-2 | P2 | 注释称「总函数，任何输入都返回 boolean，绝不抛」，但抛异常 getter / 撤销 Proxy 会抛出；只是**不会误戳** | `src/sync/bootstrap.ts:32,44-50`、`dist/sync/bootstrap.js:23,35-44` |
| P2-3 | P2 | 「一次 save 恰好一戳（两个调用点共用 seam）」只测了成功 + no-op；两次成功周期实测 **2 戳** | `test/v2-marksynced.test.mjs:153-177`、`src/sync/bootstrap.ts:165-174` |
| P2-4 | P2 | v1 `push()` 由「任何 push 成功都戳」收窄为「仅 `pushed===true` 戳」，`pushed:false` 不再刷新 `lastSyncAt` | `src/rpc.ts:594-595`（diff）、`src/rpc.ts:478-486` |
| P2-5 | P2 | `writeLastSyncAt` 抛错被吞既正确又符合 v1 口径，但全仓无任何测试钉住该失败隔离 | `src/rpc.ts:481-484`、`src/sync/bootstrap.ts:136-142`、`.tmp/gates-rvms-probe.out` P5 |

---

## 1 范围与证据

### 1.1 实际读过的文件

- 本模块 5 条路径全文：`src/rpc.ts`（1475 行）、`src/sync/bootstrap.ts`（290 行）、`test/v2-marksynced.test.mjs`（217 行）、`dist/rpc.js`（关键段 `:287-303,1143`）、`dist/sync/bootstrap.js`（关键段 `:22-55,80-128,196,215`）。
- 依赖 / 参照只读：`src/sync/cycle.ts`（`CycleResult` `:343-356`、`attempts` 产生点 `:1471,1485,1500,1516,1528`）、`src/engine/restore.ts:53-59`（`ApplyResult.verified: true`）、`src/index.ts:244-249`（`mountV2Sync` 生产接线）、`test/audit-fixes.test.mjs:389-578`（v1 `lastSyncAt` 旧语义）、`test/sync-gate-ff.test.mjs:568-570,657-673`（G-D2 直接调 `runV2Cycle`，不经 runtime seam）、`docs/REVIEW-b11-ff-vp.md`（文风与 §1.2 G6 方法）。

### 1.2 门禁复跑（全部 `Tee-Object` 到仓库根 `.tmp/`）

| # | 命令（工作目录） | 结果 / tail | 留存 |
| --- | --- | --- | --- |
| G1 | `node --test packages/dsh-dots/test/v2-marksynced.test.mjs`（根） | **tests 7 / pass 7 / fail 0 / skipped 0 / duration_ms 179.5351**，exit 0；MS-01…MS-07 全绿 | `.tmp/gates-rvms-test-targeted.out` |
| G2 | `node ../../node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`（`packages/dsh-dots`） | 无诊断，`TSC_EXIT=0`；本次未复现 `docs/REVIEW-b11-ff-vp.md` G1 的 `listener.ts` TS2741（该车道已自愈） | `.tmp/gates-rvms-tsc-plugin.out` |
| G3 | `node --test "test/*.test.mjs"`（`packages/dsh-dots`） | **tests 1102 / pass 1100 / fail 0 / skipped 2 / duration_ms 81541.5917**，exit 0；注册数比 FF 评审登记的 1083 多 19，来自并发车道新增用例 | `.tmp/gates-rvms-test-plugin-pkg.out` |
| G4 | 只读运行时探针（`node --input-type=module -`，直接 import `dist/**`） | 27 组谓词形状 + 落戳/失败隔离/双成功/ISO 形状，见 §2–§3 | `.tmp/gates-rvms-probe.out` |
| G5 | 内存新鲜 emit 比对（TS 5.9.3 `transpileModule`，`target ES2022 / module ESNext / esModuleInterop`，默认 newline；先用未改动的 `src/sync/outbox.ts → dist/sync/outbox.js` 校准得 `match`） | 目标 `rpc.ts` / `sync/bootstrap.ts` **match**；全树 `tsFiles=79 match=74 mismatch=4 missing=1`，mismatch 为 `chats/{exportChats,index}.ts`、`sync/{cycle,syncGate}.ts`，missing 为并发新增 `chats/foldChatIndex.ts`——**全部属并发车道漂移，非本模块**（见 §1.4） | `.tmp/gates-rvms-distcheck.out` |

- 未运行 `node scripts/build.mjs`；未对 `dist/` 写入任何字节；未执行 git 写命令。

### 1.3 起始 / 结束哈希、`git status`、dist 结论

- 分支 / HEAD 起止相同：`main` / `8c824028ffe00a880ec7a88d06867ae3339646d1`；评审全程无 git 写命令。
- 五个指定路径的 SHA-256（**起始 = 结束**，逐字节未变，证明评审期间无人重建本模块文件）：

| 文件 | SHA-256（起始 = 结束） |
| --- | --- |
| `src/rpc.ts` | `8EBBE5CC7C3B5BC6AA69A58FEA40F9393A945A1E5EF66C4227E693F9ECBE0947` |
| `src/sync/bootstrap.ts` | `672073CD66220EA482D92BAF76E634BE9978A82C5E22546EC74713B2D1C58E2F` |
| `test/v2-marksynced.test.mjs` | `71707A780508552CB1ECE013058BA53CBB81019FBB5A5427F1C3B6B9E84B95F4` |
| `dist/rpc.js` | `9B5B743831C88864DE4F71CA14DEEBE4CAE4AAF62E307248EE331A3E6D93B70F` |
| `dist/sync/bootstrap.js` | `12247B1E08E20758A6D156BD8E7E63D257330D37CF769C59CE1E43DE0B69EBAE` |

- **dist 结论**：`dist/rpc.js` 与 `dist/sync/bootstrap.js` 相对源码新鲜 emit 逐字节一致（G5 `TARGET rpc.ts => match` / `TARGET sync/bootstrap.ts => match`，校准文件 `outbox.ts` 亦 match）。本模块 dist 无漂移、无第二格式。

### 1.4 并发车道漂移（记录，不计入本模块 P2）

- 起始 `git status` 中 `src/sync/{cycle,syncGate}.ts`、`src/chats/**`、`src/remote/**`、`src/client.js`、`locale/**` 不存在；评审中途出现。结束全树 `git diff --stat` 为 45 files / 1271 insertions / 272 deletions，远大于本模块的 5 条路径。
- 模块定向 `git diff --stat` 恰为：`dist/rpc.js`、`dist/sync/bootstrap.js`、`src/rpc.ts`、`src/sync/bootstrap.ts`（4 files, 214 insertions, 37 deletions），加 1 条 `?? test/v2-marksynced.test.mjs`；与「三源/测 + 两 dist」声明一致（详见 §3(d)）。

### 1.5 (f) dist/sync 守卫结论

- 以 `git hash-object <path>` 对比 `git rev-parse HEAD:<path>`（起止各一次，均相同）：

| 文件 | 工作树 blob | HEAD blob | 结论 |
| --- | --- | --- | --- |
| `dist/sync/cycle.js` | `4446ce1c85b3c0cfe5b75979dc3bac8957f68dd7` | 同 | **byte-identical** |
| `dist/sync/gitPort.js` | `e2910b35b0264fa7790c25aca9f1b3d01562372c` | 同 | **byte-identical** |
| `dist/sync/syncGate.js` | `8a501d0d1094fe85815476bf6d5495b49ae4700a` | 同 | **byte-identical** |

- **（f）= no finding**：没有任何车道重建 FF 模块的三个 `dist/sync` 文件，无 P0。注意并发车道改了对应的 `src/sync/{cycle,syncGate}.ts` 却没重建 dist（G5 mismatch），这是**源侧漂移**，需 Lead 单独追踪，不属于本模块，也不改变「dist 守卫未被触碰」的结论。

---

## 2 逐条验证 1–5

### 1 谓词对 `unknown` 的全覆盖 — **1 finding（P2-1、P2-2），其余成立**

判据位于 `src/sync/bootstrap.ts:44-51`（dist `:35-44`）。实跑（`.tmp/gates-rvms-probe.out`）逐项：

| 输入 | 实测 | 与声明 |
| --- | --- | --- |
| `null` / `undefined` / `0` / `1` / `'ok'` / `''` / `true` / `Symbol` / `[]` / `{}` | 全部 `false` | 支持 |
| 普通 `Proxy({}, {})` | `false` | 支持 |
| 撤销 Proxy (`Proxy.revocable` 后 `revoke`) | **THREW `TypeError: Cannot perform 'IsArray' on a proxy that has been revoked`** | 与「绝不抛」矛盾 ⇒ P2-2 |
| `get` trap 抛错 / `pushed`/`verified`/`attempts` getter 抛错 | **THREW `Error: boom:pushed` 等**；`stampIfSynced` 的 mark 调用数 = 0 | 不会误戳（支持），但「总函数」不成立 ⇒ P2-2 |
| `attempts` 缺失 / `undefined` / `0` / `-1` / `NaN` / `'1'` | 全部 `false` | 支持（fail-closed） |
| **`attempts: Infinity`** | **`true`** | **与「Infinity ⇒ 不落戳」矛盾 ⇒ P2-1** |
| `attempts: -Infinity` | `false` | 支持 |
| `pushed: false` 且 `ok:true/code:'ok'/attempts:1` | `false`（`pushed` 分支短路优先） | 支持 |
| `verified: false` 单独 | `false` | 支持 |
| `verified: false` 且 `ok:true/code:'ok'/attempts:1` | `true`（按设计回落到 v2 判据） | 见 §4 诚实性说明 |
| `pushed:true` / `verified:true` 且 `attempts:0` | `true`（v1 分支短路，`attempts` 无关） | 支持（ probe (b)） |

- `attempts` 的真实生产者只有 `runV2Cycle`：`cycle.ts:1471` 初始化 0，`:1485` 在 commit 成功后置 1，`:1500/:1516` 失败返回 `ok:false`，`:1528` 成功返回。**没有真实路径产生 `Infinity`**，故 P2-1 today 不可被真实周期触发，但声明被反例击穿。

### 2 说谎路径不落戳且 `lastSyncAt` 不被清空 — **no finding**

- 代码：`stampIfSynced` 在 `shouldMarkSynced` 为假时直接 `return false`（`bootstrap.ts:60-64`），根本不进 mark 回调，因此不可能清空既有值。
- 测试：MS-06（diverged/refused，`test:179-196`）、MS-07（outbox 停放，`test:198-217`）、MS-01 的 `noOp()`/`parked()`/`diverged()`/`E_PUSH_REJECTED`/`E_LOCAL_PENDING` 拒绝表（`test:79-101`）。
- 独立探针（G4 P2）：先写入 `PRIOR='2026-01-01T00:00:00.000Z'`，再经 `service.markSyncedFromCycle()` 依次送入 6 条说谎结果，全部返回 `UNTOUCHED`；随后送成功结果才改为 `FIXED_ISO`。与「未触碰（不是清空）」一致。

### 3 成功恰好一次，含两个调用点 — **1 finding（P2-3）**

- 结构上只有一个落戳 seam：`V2SyncRuntime.runCycle()`（`bootstrap.ts:165-174`）内 `if (stampIfSynced(...)) this.stampCount += 1`；`start()`（`:239`）和 `syncNow()`（`:257`）都调它，没有第二处 `markSynced`、`writeLastSyncAt` 或内部重跑周期。
- MS-03 钉住 `stampIfSynced` 每次调用恰好 mark 一次（`test:117-130`）；MS-05 钉住 `start()` 成功 + `syncNow()` 返回 no-op 时 spy 只有 1 次（`test:153-177`）。
- **但** MS-05 的 `cycleRunner` 第二次返回 `noOp()`（`:162`），没有覆盖「两个调用点都成功」。独立探针（G4 P3）令两次都返回成功结果：`cycles=2 stampCalls=2 syncedStampCount=2`。即「恰好一戳」只在**每个成功周期**层面成立，不是「每个 save 无论几个成功周期都只戳一次」。今日 `syncNow()` **无生产调用方**（grep：仅 `v2-marksynced.test.mjs` 调用；`index.ts:246` 只接线 `mountV2Sync`），所以现网不会双戳；标题仍过强 ⇒ P2-3。

### 4 面板可解析的 ISO 形状 — **no finding**

- v1 `rpc.ts:481`、v2 缺省落戳器 `bootstrap.ts:138` 均为 `now().toISOString()` / `this.now.toISOString()`，只有这一种格式；dist `:295` / `:87` 相同。
- MS-04（`test:132-151`）经 `markSyncedFromCycle` 断言固定值 `2026-11-27T06:05:00.000Z`、正则 `^\d{4}-...\.\d{3}Z$`、`Date.parse` 有限、`new Date()` 的 `getHours/getMinutes` 可格式化。独立探针（G4 P4）确认**生产实际使用的 runtime 缺省落戳器**写入同一固定值且 `match=true, parseable=true`，不存在第二格式。

### 5 dist 与 src 一致 — **no finding（限本模块）**

- 方法：`ts.transpileModule`（TS 5.9.3），`target ES2022 / module ESNext / esModuleInterop:true`，先用未改动 `src/sync/outbox.ts → dist/sync/outbox.js` 校准得 `match`，再比目标与全树（G5 / `.tmp/gates-rvms-distcheck.out`）。
- 目标：`TARGET rpc.ts => match`、`TARGET sync/bootstrap.ts => match`。起止哈希未变，故不存在「中途重建 dist」。
- 全树 79 个 `.ts` 中 4 mismatch + 1 missing，逐项归属：`chats/exportChats.ts`、`chats/index.ts`、`chats/foldChatIndex.ts`（并发车道新增/改写）、`sync/cycle.ts`、`sync/syncGate.ts`（评审中途被另一车道改写，dist 守卫文件仍停在 HEAD）。**均非本模块 5 条路径**，不构成对 claim 5 的反例。

---

## 3 探针 (a)–(d)

### (a) 调用方能否在无真实推送下落戳？— **no finding（不可从不可信面到达）**

1. `markSyncedFromCycle` 挂在 `RpcService` 返回对象上（`rpc.ts:218,489,1386`），但它**不在 `handleRpc` 的 switch**（`rpc.ts:1293-1372`）里，没有对应 action；HTTP `POST /dsh-dots/rpc` 的不可信调用方无法传一个 `CycleResult` 给它。`createHttpHandler`（`:1430-1475`）只调 `service.handleRpc`。
2. 能喂 `CycleResult` 的入口全是进程内：`cycleRunner` 注入（`bootstrap.ts:82,133,169`，注释明确「测试注入」）、`V2RuntimeOptions.markSynced` 注入（`:80`）、导出的 `stampIfSynced`/`shouldMarkSynced`（`:44,60`）、以及持有 `RpcService` 对象的进程内代码。它们可以构造 `{pushed:true}` 或 `{ok:true,code:'ok',attempts:1}` 触发落戳——但能拿到这些对象的代码已经在进程内，本就有 `LocalStateStore` 的等价权限，不构成权限提升。
3. 生产路径中 `markSyncedFromCycle` 实际**未被接线**：`index.ts:246-249` 的 `mountV2Sync()` 只传 `homeDir` / `allowLocalRepo`，不传 `markSynced: service.markSyncedFromCycle`；v2 落戳走 runtime 自己的缺省 `LocalStateStore` 回调。该 seam 今天是测试口（与 `:76` 注释一致），不是隐藏的第二落戳通道。
4. `push()` / `apply()` 传给判据的是内部产生的 `pushResult.pushed` / `ApplyResult`（后者 `verified: true` 由 `restore.ts:53-59` 保证），调用方 payload 无法注入这两个分支的值。`CycleResult.attempts` 由 `cycle.ts` 内部计数产生（§2.1）。**结论：不可从不可信 HTTP/RPC 面到达。**

### (b) 是否改变 v1 行为？— **1 finding（P2-4）**

- `apply()`：`markSynced(applied)`（`rpc.ts:686`），`ApplyResult.verified` 类型是字面量 `true`，所以判据第二分支必然命中；旧代码是无条件 `markSynced()`。**条件等价**，且 `attempts` 与 `ok`/`code` 均不参与（短路）——无回归。
- `push()`：旧代码 `pushWithRebase()` 成功后**无条件**调用 `markSynced()`（diff `-        // push 成功（含"远端已是最新"）即视为一次成功同步；…` / `-        markSynced()`），包括 `pushed:false`；新代码 `markSynced({ pushed: pushResult.pushed })`（`rpc.ts:595`）只在 `pushed===true` 落戳。因此 **`pushed:false` 不再刷新 `lastSyncAt`**。这是源码注释明说的有意收窄（`rpc.ts:594`），但与「v1 仍按原条件原样落戳」的声明不符；`audit-fixes.test.mjs:432-441` 只覆盖成功推送，无测试钉住 `pushed:false` 的新语义。⇒ P2-4。
- `attempts` 在 v1 两分支完全无关：探针 `{pushed:true,attempts:0}=>true`、`{verified:true,attempts:0}=>true`（§2.1 表）。

### (c) 失败隔离 — **行为 no finding，覆盖 P2-5**

- 两处写戳都在 `try/catch` 中且吞掉异常：`rpc.ts:480-484`、`bootstrap.ts:136-142`，与 v1 及 `withRepo`/`recordProbe`/`saveSettings` 对 `state.json` 的统一口径一致（UI 展示事实不应让已成功的同步变失败）。
- 独立探针（G4 P5）monkeypatch `LocalStateStore.prototype.writeLastSyncAt` 抛 `EACCES simulated disk full`：RPC seam 调用「swallowed OK」、随后 `handleRpc({action:'getState'})` 仍 `ok=true`、runtime `start()` 「swallowed OK; ok=true code=ok stampCount=1」。**吞掉是正确的**；但全仓 grep `writeLastSyncAt` 的测试只断言值，没有任何用例注入抛错 ⇒ P2-5（覆盖缺口）。

### (d) 断言纪律 — **no finding**

- `test/v2-marksynced.test.mjs` 在 `git status` 中为 `??`，`git ls-files --error-unmatch` 报「did not match any file(s) known to git」⇒ **全新文件，无 retarget、无可删旧断言**；7 条用例 MS-01…MS-07 均为新增。
- 模块定向 `git diff --stat` 恰为 4 条 tracked（`src/rpc.ts`、`src/sync/bootstrap.ts`、`dist/rpc.js`、`dist/sync/bootstrap.js`）+ 1 条 untracked 新测试，与声明「三源/测 + 两 dist」完全一致；其余 40+ 条全树改动是评审中途出现的并发车道（§1.4），不是本车道 retarget。
- 附带确认：`test/sync-gate-ff.test.mjs:657-673` 的 G-D2 仍断言「v2 周期成功不写 lastSyncAt」，其 `runCycle()`（`:568-570`）直接调 `runV2Cycle`，绕过 runtime seam，因此新模块不必也不应改它；该文件未被本车道触碰。

---

## 4 诚实性 (e)

| 句子 / 声明 | 证据是否支持 | 裁定 |
| --- | --- | --- |
| 「唯一成功判据（**总函数**，任何输入都返回 boolean，绝不抛）」（`bootstrap.ts:32`） | 普通 unknown 形状支持；撤销 Proxy / 抛异常 getter 会抛出 | **过度 ⇒ P2-2** |
| 测试头「pushed:false / 仅 outbox 停放 / diverged-refused 及**一切畸形形状**全部拒绝」（`test:79`） | 拒绝表覆盖 25+ 形状，但漏 `Infinity`（实测落戳）、漏抛异常 getter/proxy（实测抛） | **过度 ⇒ P2-1 / P2-2** |
| 「只有 `ok===true && code==='ok' && attempts>0` 才证明至少一次真实 push」（`bootstrap.ts:38-41`） | `cycle.ts:1485` 的 `attempts=1` 在 push 之前置位，`:1500/:1516` 失败返回 `ok:false`，`:1528` 成功才返回；证明链成立 | 支持（但 `Infinity` 落在判据缝里，P2-1） |
| 「`attempts` 是唯一的正向证据；schema 若把它变成可选必须 fail-closed」 | 实测 `attempts` 缺失 / `undefined` → `false`，正确 fail-closed；但 `Infinity` 这个非有限值没有挡住 | **部分支持 ⇒ P2-1** |
| 「唯一落戳动作…判据为真时**恰好调用一次 mark**」（`bootstrap.ts:57-58`） | 单次 `stampIfSynced` 调用层面成立（MS-03）；两个成功周期会各戳一次 | **需限定 ⇒ P2-3** |
| 测试头「②一次成功恰好一戳（两个调用点共用 seam）」/ MS-05 标题（`test:8,153`） | 测的是「成功 + no-op」，非「两个成功」 | **过度 ⇒ P2-3** |
| 「`pushed:false` / 仅 outbox 停放 / diverged-refused 一律零动作」（`rpc.ts:476`） | 探针 P2 六条说谎路径全部 UNTOUCHED | 支持 |
| 「ISO 形状与既有 `markSynced()` 相同，面板可解析」 | MS-04 + G4 P4 双通道均 `Date.toISOString()` 且可解析 | 支持 |
| 「应用仍按原条件落戳」（`bootstrap.ts:37` / `rpc.ts:685`） | `ApplyResult.verified` 是字面量 `true`，短路命中，`attempts` 无关 | 支持 |
| 「push 仍按原条件落戳」 | 旧无条件（含 `pushed:false`）→ 新仅 `pushed:true` | **与「原样」不符 ⇒ P2-4** |
| 「state.json 写失败不影响同步结果」 | 两处 try/catch + G4 P5 实测吞掉 | 支持（但未测，P2-5） |
| `test/sync-gate-ff.test.mjs:668-670`「v2 写作路径不经过 rpc.ts 的 markSynced()，lastSyncAt 仍为 null」 | 该测试直调 `runV2Cycle`，确实绕开 seam；生产接线 `mountV2Sync` 经 runtime 自行落戳，两者不矛盾 | 支持（措辞限于 cycle 层，准确） |

- 补充：`verified:false` + 完整合法 v2 结果会落戳（G4 `verified-false-plus-ok => true`）。这是判据的**既定优先级**（`verified` 不是 `=== true` 就继续走 v2 分支），不是漏洞；但任务口径「`verified:false` 且 `ok:true` 不落戳」只在 `attempts` 缺失/非法时成立，应写成「`verified:false` 单独出现不落戳」。

---

## 5 发现清单

| 级别 | 位置 | 证据 | 影响 | 建议 |
| --- | --- | --- | --- | --- |
| P2-1 | `packages/dsh-dots/src/sync/bootstrap.ts:49-50`；`test/v2-marksynced.test.mjs:79-97` | `.tmp/gates-rvms-probe.out`：`PRED attempts-infinity => true`；MS-01 拒绝表无 `Infinity`/`-Infinity` | 声明的 `Infinity ⇒ 不落戳` 不成立；真实 `cycle.ts` 只产生 0/1，today 不可触发，但 schema 若改成非有限算术就会误宣称同步 | 判据加 `Number.isFinite(record.attempts)`（或 `Number.isSafeInteger`）；MS-01 拒绝表补 `Infinity` / `-Infinity` |
| P2-2 | `packages/dsh-dots/src/sync/bootstrap.ts:32,44-50`；`dist/sync/bootstrap.js:23,35-44`；`test/v2-marksynced.test.mjs:79` | G4：`revokedProxy => THREW TypeError`、`throwingGetProxy => THREW Error: boom:pushed`；但 `STAMP calls=0` | 「总函数绝不抛」与「一切畸形形状全部拒绝」过强；安全性质（不误戳）未破；真实 `CycleResult` 是对象字面量，不可由周期产生 | 加 `try { … } catch { return false }` 包住属性读取；或把注释/标题限定为「对 null/标量/数组/普通对象/普通 Proxy 总返回 boolean；抛异常 getter / 撤销 Proxy 会抛出但不落戳」 |
| P2-3 | `packages/dsh-dots/test/v2-marksynced.test.mjs:153-177`（尤其 `:162`）；`src/sync/bootstrap.ts:165-174` | G4 P3：`cycles=2 stampCalls=2 syncedStampCount=2`；MS-05 第二次返回 `noOp()` | 标题「两个调用点恰好一戳」未被证明；`syncNow()` 现无生产调用方，故无现网双戳；未来接线后同一个 save 两次成功会戳两次（同字段覆盖，无数据错） | 改标题为「一次成功周期恰好一戳；后续 no-op 周期不再落戳」，并注明两次成功周期各戳一次是设计；若业务要求「每 save 唯一戳」，需在 runCycle 外增加 save 级去重 |
| P2-4 | `packages/dsh-dots/src/rpc.ts:594-595`（`git diff` 旧 `:592 markSynced()`）；`src/rpc.ts:478-486` | diff 显示旧代码无条件戳（注释「含远端已是最新」），新代码 `markSynced({pushed:pushResult.pushed})`；G4 §2.1 `{pushed:false}=>false` | `pushed:false` 不再刷新 `lastSyncAt`：语义收窄虽被注释认可，但「v1 行为原样」声明不成立；无测试钉住 | 若要求原样则恢复无条件戳；否则在提交说明/文档中标为**有意收窄**并补一条 `pushed:false` 用例 |
| P2-5 | `packages/dsh-dots/src/rpc.ts:480-484`；`src/sync/bootstrap.ts:136-142` | G4 P5 注入 `writeLastSyncAt` 抛错：RPC seam / runtime 均 swallowed，host `getState` 仍 ok；grep 全仓无抛错注入用例 | 行为正确但零回归保护：将来有人把 try/catch 挪走，全量套件仍绿 | 新增一条用例：临时替换 `LocalStateStore.prototype.writeLastSyncAt` 抛错，断言 mark 不冒泡、周期结果原样、`stampCount` 仍 +1 |

---

## 6 `unverified`

1. **真机 / 宿主**：桌面插件保存后平板面板是否真的从「从未同步」变为有 `lastSyncAt`、以及 `state.json` 在真实磁盘满/权限错误下的 catch 表现，均未真机验证；本评审只验证到 `dist` 层的读写与 ISO 形状。
2. **`syncNow()` 的生产接线**：目前无调用方（仅测试），因此「一次 save 两个成功调用点」只是探针构造的场景，不是现网观测到的双戳；未来模块接线后需重新验收 P2-3。
3. **并发车道漂移的归属**：评审中途出现的 `src/sync/{cycle,syncGate}.ts`、`src/chats/**`、`src/remote/**`、`src/client.js`、`locale/**` 改动未做归属审计；G5 报告的 4 mismatch + 1 missing 是这些改动的直接结果，本评审不声称它们已自洽。
4. **全量套件基线**：G3 为 1102/1100/0/2，与 FF 评审登记的 1083 不同（并发新增用例）；本评审不把注册数增长归因于本模块。
5. **`tsc --noEmit` 与 emit 的关系**：G2 全绿、G5 目标文件 match，但 G5 用的是 `transpileModule`（不做类型检查），两者结合只证明「目标文件类型正确且字节一致」，不等价于完整 `tsc -p` 构建产物比对；本次未运行 `node scripts/build.mjs`（按指令）。
6. **`verified:false` 的 schema 前提**：`ApplyResult.verified` 是类型层面的 `true`（`restore.ts:57`），探针用的是手工对象；若未来类型放宽，v1 apply 分支的「短路保证」需重新验证。

---

## 7 冻结建议

- **裁决：Freeze-with-fixes。** 本模块可以进入提交队列；冻结前请 Lead 要求原车道做五处最小修补：① 判据加 `Number.isFinite(attempts)` 并把 `Infinity` 进拒绝表（P2-1）；② 给 `shouldMarkSynced` 属性读取加 try/catch 或收窄「总函数」文案（P2-2）；③ 改 MS-05 标题并说明两次成功周期各戳一次（P2-3）；④ 把 v1 `pushed:false` 语义收窄写进提交说明并补测（P2-4）；⑤ 补一条 `writeLastSyncAt` 抛错的回归用例（P2-5）。
- **（f）守卫通过**：`dist/sync/{cycle,gitPort,syncGate}.js` 起止均与 HEAD `8c82402` 逐字节相同，FF 模块 dist 未被触碰；但并发车道改了对应 `src` 未重建 dist，请 Lead 单独派单，不要并入本模块，也不要据此回滚本模块。
- **不得**把并发车道的全树 emit mismatch、注册数增长或 `syncNow()` 未来接线的风险算作本批缺陷；冻结批次本身仍应在并发车道自愈后取一次新的全量绿证据。
- 本评审未修改任何源、测试、dist 或 git 状态；唯一仓库文件写入是本文，其余输出仅在 gitignored `.tmp/gates-rvms-*.out`。

---

## 9 追加复核（2026-11-27，仅五个修复项）

- 范围：**只验 P2-1 / P2-4 / P2-2 / P2-3 / P2-5 五项修复 + 五路径与守卫确认**；§0–§7 已 clearing 的结论（说谎路径不落戳、ISO 形状、不可信面不可达、断言纪律）保持不变，不重审。
- 环境变化：HEAD 由 `8c82402` 前进到 `e1690fe1d7718ceeb7faad2751ba6de5cbc10412`（另一条 live-connections 车道提交，18 files，**不含本模块**）；(f) 守卫仍按基线 `8c82402` 逐 blob 比对。
- 车道留存（只读，`packages/dsh-dots/.tmp/`）：`gates-ms2-tsc.out` 13 B `TSC_EXIT=0`；`gates-ms2-build.out` 65 B `BUILD_EXIT=0`；`gates-ms2-suite-1.out` 115,423 B `tests 1106 / pass 1104 / fail 0 / skipped 2 / SUITE_EXIT=0`；`gates-ms2-suite-2.out` 115,411 B 同尾；`gates-ms2-distcheck.out` 171 B `78 files, 0 mismatch`、window 2 = `dist/rpc.js` 60,828 B + `dist/sync/bootstrap.js` 11,854 B。
- **`gates-ms2-app.out` 诚实说明**：当前盘上为 **475,504 B**（`tests 3379 / pass 3379 / fail 0 / skipped 0 / suites 477 / duration_ms 20677.0406`），是 planner 本人重跑后覆盖车道原 359,915 B 捕获的结果；**车道原文件未存活**，两次计数与 exit 0 一致。此处不声称保留了车道原件。
- 本评审自跑（只落 `.tmp/gates-rvms-ms2-*.out`）：`node --test packages/dsh-dots/test/v2-marksynced.test.mjs` → **tests 11 / pass 11 / fail 0 / skipped 0 / duration_ms 2834.7488**（`.tmp/gates-rvms-ms2-targeted.out`）；只读探针 10 组 attempts 形状 + 7 组 hostile 对象（`.tmp/gates-rvms-ms2-probe.out`）。

| 项 | 裁定 | 证据 |
| --- | --- | --- |
| P2-1 `Number.isFinite` | **no finding** | `src/sync/bootstrap.ts:52-54`；MS-01 `:122-123` 明文拒绝 `Infinity` / `-Infinity`，MS-02 `:139` 明文接受 `Number.MAX_VALUE`；探针 `Infinity/-Infinity/NaN/'1'/absent/undefined/0/-1 => false`、`MAX_VALUE/1 => true` |
| P2-4 v1 无条件恢复 | **no finding** | `src/rpc.ts:477-483` 无参 `markSynced()`、`:596-597` push 与 `:688` apply 均无条件调用，仅 `:489-491` 的 `markSyncedFromCycle` 走判据；与 HEAD `8c82402` 的 `:464` 旧体同条件（正常返回即戳）；MS-10 `:277-298` 真本地裸仓库证明首推 `pushed:true` 戳、次推 `pushed:false` 仍戳、坏仓库抛错不戳 |
| P2-2 try/catch  totality | **no finding** | `src/sync/bootstrap.ts:45-57` 整段包 try/catch → false；MS-08 `:248-255` + 探针：throwing getProxy / pushed / verified / ok / code / attempts getter / 撤销 Proxy 全部 `false`，`stampIfSynced` 调用数 0；「永不抛」注释 `:32` 现为代码事实 |
| P2-3 每周期口径 | **no finding** | `src/sync/bootstrap.ts:63-67`（「每个成功周期恰好盖一次——不是『一个 save 总共只能盖一次』」）、`:169-173`（`syncNow()` 今天无生产调用者）；MS-09 `:257-275` 连续两次成功 `stamps.length` 依次 1、2、`syncedStampCount` 依次 1、2，钉住 per-cycle 而非 once-ever |
| P2-5 落戳失败隔离 | **no finding** | `src/sync/bootstrap.ts:182-186` 包住 `stampIfSynced(...)` 与计数；MS-11 `:300-323`：patch `writeLastSyncAt` 抛错时 RPC seam 不抛、host push 仍 ok、无半成品状态；注入 `markSynced` 抛错时 `deepEqual(cycle, expected)`、结果为原对象 |

- **五路径确认**：相对当前 HEAD，`git diff --stat` 恰为 `src/rpc.ts`、`src/sync/bootstrap.ts`、`dist/rpc.js`、`dist/sync/bootstrap.js`（4 files, 231 insertions, 20 deletions）+ 未跟踪新文件 `?? test/v2-marksynced.test.mjs`；**无第六个模块路径**（另有本报告 `?? docs/REVIEW-b11-marksynced.md`，属本评审允许写入，非车道产物）。车道 `.tmp/**` 由 `.gitignore:30` 忽略。
- **(f) 守卫（对 `8c82402`）**：`dist/sync/cycle.js` `4446ce…`、`gitPort.js` `e2910b…`、`syncGate.js` `8a501d…` 工作树 blob 与基线逐字节相同，**no finding**，无 P0。
- **裁定：Freeze（五项全部 no finding），本模块今晚可提交**（五路径齐全、守卫未被触碰、双向测试与独立探针均绿）。按 Lead 规则，本轮范围外若发现新问题留待明日处理，本追加段不扩范围。

---

## 10 追加复核（2026-11-28，`mod-plugin-v2-marksynced-toolpath`）

- 范围：**仅 item 1–6**；本文 §0–§9 对前一模块的 clearing 不重审。新缺陷背景：落戳原只在 `V2Runtime.runCycle`（`src/sync/bootstrap.ts:189-202`），其生产调用方只有 `start()`；真保存走 `schedule_add → v2Bridge.add() → runV2Cycle()` 直调（旧 `:336`），从不落戳。
- 环境：HEAD = `484b44f5106261830cff238d6ad1a6b495b0f54c`（前一模块已提交）；守卫基线同为 `484b44f`。
- 车道留存（只读，`packages/dsh-dots/.tmp/`）：`gates-mt-tsc.out` 26 B `TSC_EXIT=0`；`gates-mt-build.out` 130 B `BUILD_GATE_EXIT=0`；`gates-mt-distcheck.out` 378 B `DIST-FRESHNESS: 78 files, 0 mismatch`、window 2 = `dist/schedule/v2Bridge.js` 19,506 B + `dist/sync/bootstrap.js` 12,445 B；`gates-mt-suite-3.out` 148,920 B `tests 1110 / pass 1108 / fail 0 / skipped 2`。两份红留存 `gates-mt-suite-1.out`（1111/1108/1，`SUITE1_EXIT=1`）与 `gates-mt-suite-2.out`（`SUITE2_EXIT=1`）唯一失败为**外来** `test/outbox-purge-failed.test.mjs:13` 模块加载 `SyntaxError: … does not provide an export named 'PURGE_FAILED_AFTER_MS'`；该文件现已移出树，故与 suite-3 绿不矛盾——两红一绿均留档。
- 本评审自跑：`node --test packages/dsh-dots/test/v2-marksynced-toolpath.test.mjs` → **tests 4 / pass 4 / fail 0 / skipped 0 / duration_ms 8867.8837**（`.tmp/gates-rvms-mt-targeted.out`）；新鲜 emit 比对（TS 5.9.3 `transpileModule`，target ES2022 / module ESNext / esModuleInterop，先用未改的 `sync/cycle.ts`、`sync/gitPort.ts` 校准均 match）→ 两个目标均 match（`.tmp/gates-rvms-mt-distcheck.out`）。

| 项 | 裁定 | 证据 |
| --- | --- | --- |
| 1 单规则、无第三份 | **no finding** | `src/sync/bootstrap.ts:45` `shouldMarkSynced`、`:69` `stampIfSynced`、`:81` `createDefaultMarkSynced` 各 **1 份定义**；`Number.isFinite(attempts)` `:55`、`verified === true` `:51` 各 **1 处**；`src/schedule/v2Bridge.ts:48` 只 import、`:205` 复用工厂、`:367` 复用判据，无重实现。`writeLastSyncAt(` 共 3 处 = `engine/settings.ts:338` 方法定义 + `bootstrap.ts:88` 共享工厂 + `rpc.ts:479` 既有 v1「正常返回即同步」调用（`git diff HEAD -- src/rpc.ts` 为空），**不是第二份「何时算同步」判据** |
| 2 三种周期结局 | **no finding** | 成功：`v2Bridge.ts:351` `runV2Cycle` → `:367` 唯一一次 `stampIfSynced`，T1 断言戳从 `OLD_ISO` 前进到 `STAMP_ISO`；失败：`:358-362` 在落戳前 `throw new SyncError(cycle.code, …)`，T2 断言 `state.json` 逐字节不变；no-op：`:365` 明写「writtenPaths 为空 ⇒ attempts 保持 0 ⇒ 判据拒绝，没写入不算一次同步」，`cycle.ts:1472` 是唯一 `attempts=0` 来源，T3 断言字节与 `lastSyncAt` 均不变。`add()` 内 grep 仅 1 个 stamp 调用点，无重试/第二通道 |
| 3 测试走真工具路径 | **no finding** | `test/v2-marksynced-toolpath.test.mjs:117-128` 经 `withV2ScheduleBridge`（生产装配 `:478-512`，`paths` 在 `:491/:506` 透传）+ `buildV2Ports` 真端口 + 真裸 git（`:53-111`），不塞 `markSynced`、不替 `cycleRunner`；`:144-146` 直接读 `state.json` 断言前进。修复前 `add()` 不戳 ⇒ `after` 仍 `OLD_ISO`，T1 必红；`STAMP_ISO` 精确等于注入时钟 ISO 且要求 `Date.parse(after) > before`，足以捕获未来回退；T2/T3 的逐字节断言覆盖失败/no-op 误戳 |
| 4 dist vs src | **no finding** | 校准文件 `sync/cycle.ts`、`sync/gitPort.ts` 均 match；`TARGET src/schedule/v2Bridge.ts => match`、`TARGET src/sync/bootstrap.ts => match`。五路径起止 SHA-256 相同：`src/sync/bootstrap.ts` `B42B2EFA…`、`src/schedule/v2Bridge.ts` `7D95D680…`、`test/v2-marksynced-toolpath.test.mjs` `03277DD5…`、`dist/schedule/v2Bridge.js` `8F4ACB40…`、`dist/sync/bootstrap.js` `EC491D7D…` |
| 5 范围纪律 | **no finding** | 相对 HEAD 恰为 4 tracked（`src/sync/bootstrap.ts`、`src/schedule/v2Bridge.ts`、`dist/schedule/v2Bridge.js`、`dist/sync/bootstrap.js`；91 insertions / 19 deletions）+ 1 untracked `?? test/v2-marksynced-toolpath.test.mjs`，**无第六个模块路径**；全树其余改动属别的车道（`apps/arkui-schedule/**`、`docs/MODULES.md`、`docs/CHAT-DELETE-DESIGN.md`、`docs/REVIEW-b11-*.md`——含本报告，属本评审允许写入） |
| 6 诚实性 | **no finding** | `bootstrap.ts:186-187` 明写 `syncNow()` **没有生产调用者**、测试用它只为钉住同一落戳点；`:105` `markSyncedFromCycle` 注明「测试可塞 spy」；`v2Bridge.ts:96` 同样注明 spy 注入，`v2Bridge.ts:364-365` 只声称与 runtime 共用判据和 no-op 拒绝；测试 `:115` 明写「不塞 spy、不替周期执行器」。无「seam 在生产被走」或「syncNow 是活调用方」的措辞 |

- **(f) 守卫（对 `484b44f`）**：`dist/sync/cycle.js` `4446ce1c…`、`gitPort.js` `e2910b35…`、`syncGate.js` `8a501d0d…` 工作树 blob 起止均与基线逐字节相同，**no finding**，无 P0。
- **裁定：Freeze-green（1–6 全 no finding）；本模块今晚可提交。** 本轮未发现任何级别 finding；按 Lead 规则，范围外新问题是明日工作，本段不扩范围。

