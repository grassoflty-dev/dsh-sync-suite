# 独立只读评审：`mod-v2-sync-wiring`（同步周期接线 + 显式激活 + 三态 UI）

> 评审者：独立只读执行子代理（review-sync-wiring）。评审时间：2026-11-20（Asia/Shanghai）。
> 评审对象：工作树未提交的 `mod-v2-sync-wiring`（6 新增 + 5 改 + 2 跨模块改，另 3 个 docs 改）。
> 依据：`项目理解.md`、`docs/DATA-CONTRACT-v2.md` §9/§10/§11、`docs/MODULES.md` §1.1；
> 源码 `model/syncCycle.ts`、`model/v2Activation.ts`、`services/{gitRunner,syncStatusStore,v2ActivationService}.ets`、
> `tools/test/syncWiring.test.mjs`，以及 `services/{syncProtocolStore,recordWriter}.ets`、`pages/{Index,Settings}.ets`、
> `components/settings/SyncSection.ets`、`services/GitSyncService.ets`、`resources/rawfile/git/git-bridge.js` 的未提交 diff。
> 五道门闸由本评审**亲自复跑**（尾部原文见 §8）。本文件之外未改动任何源码或配置。

---

## 1. 结论（P0 / P1 / P2 + blocking）

| 等级 | 数量 | 概要 |
| --- | --- | --- |
| **P0** | **0** | 未发现 force-push / 改写远端历史 / 删远端文件 / shell exec / 写 `devices/**` / v1 回落 / 无确认自动激活。硬禁令全部成立。 |
| **P1** | **5** | ①停放意图的日期未被纳入周期 days → 可永久滞留（真正的「静默本地未提交」缺口）；②failed 意图**没有任何 UI 重试入口**，违反 §9 P1-1；③`attempts` 未做到「每次推送前 +1 落盘」，跨会话累计口径未落地；④远端坏文件被当作空日 → 可能用本地覆盖远端，且无 `E_CORRUPT`；⑤激活/并存裁决/读模式均只写内存 `AppStorage`，无 `PersistentStorage`，重启即回退 v1（真机重启未验证，静态证据强）。 |
| **P2** | **6** | typed 状态在 `outcomeToResult`/`fromCycle` 被收窄或错分；一切 push 失败统一按拒推 + reset + 烧 4 次预算；门禁只按「每轮一次」重查而非 P1-3(a) 的「每条重放前」；日期不符目录名不报 `E_CORRUPT`；无启动/手动周期触发，outbox 不在启动时排空；8/44 为静态源码形状断言且 fake GitPort 未绑定真实 isomorphic-git。 |

**Verdict / blocking：不作为「可发布的激活模块」放行。** 五道门闸全绿（44/44、2670/2669/0/1、validate 8/8、tsc 0、overlay applied=false），纯决策层的七阶段编排与三条硬禁令质量不错，设备截图也证明了三态行可见；但 P1-①~④ 使契约 §9「outbox 是周期之间唯一本地真值、不得产生静默本地未推提交」的核心保证在服务接线层**没有真正兑现**，P1-⑤ 使「显式激活」不具跨重启持久性。建议：修复 P1-①~④ 并补对应 Node 用例；P1-⑤ 要么补 `PersistentStorage` 绑定并在真机做「激活→重启→仍 v2」验证，要么在交付说明中明确把它列为已知限制并阻断发布口径。P2 可在同一批或下一批处理。

> 备注：P1-③/④ 的缺陷代码位于已提交的 `syncProtocol.ts`（`e6c202b`），但本模块首次把它接到真实 git 与真实磁盘，**使其从「未接线的纯逻辑」变成「真机会触发的行为」**，故在本模块评审中按现役问题登记。

---

## 2. Findings（file:line + 原文引用）

### P1-1 停放意图的日期未纳入周期 days → 可永久滞留（静默本地未提交）

- `services/syncProtocolStore.ets:248`

  ```ts
  const days: string[] = this.mergeDates(this.localDates(), remoteDays);
  ```

  `localDates()`（`:619-621`）只列**本地已有 `records.json` 的日目录**，`remoteDays` 来自 `listRemoteDays()`（远端有 records 的日）。**outbox 意图自身的 `date` 完全没进 `days`**。
- `services/recordWriter.ets:123-146` `parkAndThrow()` 把失败写入停放为 `state:'pending'` 意图后 `throw`（`never`），因此在 `:52-54` 处 `this.triggerSync()` 根本不会执行；意图不会立刻被任何周期排空。
- 后果链：一条**新日期**的 upsert 首次写盘即失败（`E_TS_SHAPE` / 目录创建或原子替换 IO 错误）→ 本地无该日 `records.json`、远端也无 → 下次任意成功写入触发周期时 `days` 仍不含该日 → `entriesForDate()`（`model/syncCycle.ts:116-125`）永远取不到它 → 意图无限期停在 outbox。用户只看到一次 `E_V2_WRITE_PARKED` toast，三态行不会变成「N 条待同步」（见 P2-1），构成 §9 明令禁止的「停留在本地、从未推送成功却不告知用户」的最终态。
- `tools/test/syncWiring.test.mjs:213-215` 的 `run()` 直接把 `days=[DAY]` 硬编码传给 `runCyclePure`，绕过了服务层的日期派生，因此 44 例**全部无法发现此问题**。

### P1-2 failed 终态没有任何「重试」入口（§9 P1-1 Normative 未实现）

- `docs/DATA-CONTRACT-v2.md:223`：「**只有用户在 UI 点「重试」**才原子地 `attempts = 0, state = pending` 重新入队」。
- 全仓 `entry/src/main/ets` 搜索：`attempts = 0` 仅出现在 `services/syncProtocolStore.ets:181`（旧 `runCycle` 的局部变量），`outboxStore.ets` 无 retry/requeue/reset 方法，`SyncSection.ets` 的「重试」(`:61/:365/:683`) 属 v1 `pull/push/status` 动作，`services/syncProtocolStore.ets:138` 的 `runCycle(ctx)` 在 App 中**零调用点**。
- 结论：意图一旦在 `syncCycle.ts:334-346` 进入 `failed`，本机没有任何代码路径能把它复位重排；只能手改 outbox 文件。这是 Normative 条款的直接缺失，非措辞差异。

### P1-3 `attempts` 未做到「每次进入阶段 3 前 +1 并落盘」

- `model/syncCycle.ts:329-330` 注释：`// 跨会话累计 attempts：每次进入推送前 +1 落盘（outbox 由调用方原子写回）`，代码为 `current = bumpAttempts(current);` —— **只在内存副本上 +1**。
- `services/syncProtocolStore.ets:243-267`：`const outbox = this.readOutbox();`（`:246`）→ `await runCyclePure(...)`（`:265`）→ `this.writeOutbox(outcome.resultOutbox);`（`:266`）——**整个周期只在返回后落盘一次**。
- 若进程在第 2/3 次推送尝试之间崩溃（或 `writeDayTexts`/`addPaths`/`commit` 抛错使 `runCyclePure` 提前 reject），磁盘 outbox 仍是旧的 `attempts=0`，重启后预算被重置，与 §9 P1-1「新会话 / 重新启动 / pull 成功都不重置」相反。
- `tools/test/syncWiring.test.mjs:292-298`（test 8）只断言内存返回的 `resultOutbox[0].attempts === MAX_ATTEMPTS`，没有断言任何一次磁盘落盘。

### P1-4 远端坏文件被当空日、可能用本地覆盖远端（无 `E_CORRUPT`）

- `model/syncProtocol.ts:431-440`：

  ```ts
  const parsed = parseTimelineDay(text, date);
  if (parsed.day === null) {
    return out;   // 空 Map，无 typed 错误
  }
  ```

- `model/timeline.ts:622-625`：顶层不是合法 JSON 对象时 `return { day: null, ... }`。
- 因此 `model/syncCycle.ts:259` 的 `unionDay(...)` 会把「远端 records.json 损坏」静默解释为「远端这天没有记录」；随后 `:298-300` add+commit、`:305` push 把本地并集推上去，**远端原文件被覆盖**。§9 阶段 1 要求「任一侧不可解析 → `E_CORRUPT`，整日不动、意图留 outbox；注入不可解析的远端日文件 → 该日字节未变」，当前无实现、无测试（`syncWiring.test.mjs` 无 E_CORRUPT 用例）。
- 注：同一 `parseTimelineDay` 在 `date` 字段与目录名不符时（`:607-612`）只 push 一条 error 并继续用目录日期，也不满足 §9 的 `E_CORRUPT` + 「整日不动」（见 P2-4）。

### P1-5 激活与并存裁决不跨重启（静态强证据；真机重启 `unverified`）

- 三个键全部是 ArkUI 内存 `AppStorage`：
  - `services/timelineModeSwitch.ets:31` `V2_WRITE_ENABLED_KEY='timeline.v2WriteEnabled'`；`:80-82` `writeActivated()` 只读 `AppStorage.get<boolean>`。
  - `model/v2Activation.ts:31` `V1_RETAINED_KEY='timeline.v1Retained'`；`services/v2ActivationService.ets:41-43` `v1RetentionConfirmed()` 只读 `AppStorage.get<string> === '1'`。
  - `services/timelineStore.ets:42/106-121` `timeline.readMode` 同样只在 AppStorage（`:104` 注释明确「缺省值不落 AppStorage」）。
- 全仓 `entry/src/main/ets` **无任何 `PersistentStorage` / `persistProp` 绑定**（grep 结果为空）。
- 启动链 `pages/Index.ets:365` `timelineModeSwitch.applyMode()` → `timelineModeSwitch.ets:60-67`：`decision.mode==='v2' && !this.writeActivated()` 时返回 `E_V2_WRITE_NOT_ACTIVATED`，保持 v1。故进程重启后用户上次的激活消失、readMode 回 v1、并存裁决被重新询问、三态行回到 `只读·v2 写入未启用…`（截图正是这一态）。
- 这是「显式激活模块」的发布级缺口；真机「激活→杀进程→重启→仍 v2」未执行（任务书列为 unverified），故标 `unverified on device`，但静态代码已足以判定缺少持久层。

### P2-1 typed 状态在结果转换处丢失/错分

- `services/syncProtocolStore.ets:301-313` `outcomeToResult()`：

  ```ts
  let code: WriteGateCode | 'E_PUSH_REJECTED' = 'E_PUSH_REJECTED';
  if (outcome.code === 'ok' || outcome.code === 'E_SCHEMA_UNKNOWN' ||
      outcome.code === 'E_BRANCH_MISMATCH' || outcome.code === 'E_NOT_SYNCED') {
    code = outcome.code;
  }
  ```

  `E_MIGRATION_REQUIRED` / `E_CORRUPT` / `E_IO` / `E_AUTH` / `E_DELETED_REMOTELY` 等全部塌缩为 `E_PUSH_REJECTED`。
- `services/syncStatusStore.ets:47-56` `fromCycle()` **完全不看 `code`**：`pending>0 || failed>0` → `setPending(count, message)`；否则 `ok` → `setSynced`；否则 `setPending(0, message)`。门禁失败（例如 schema=3）时 `gateFailure()` 带回 `pending=replayable(outbox).length`，若 outbox 有意图，UI 渲染成 `N 条待同步·最近失败：只读（仓库结构版本不认识，见 §11）`（理由文案来自 `model/syncProtocol.ts:67`），与 §9「只读（仓库结构版本不认识）」自相矛盾。
- `model/syncProtocol.ts:42` 的 `WriteGateCode` 只有 4 个值，`assertWritable()`（`:98-109`）永远不产生 `E_MIGRATION_REQUIRED` / `E_LOCAL_PENDING`，与 §9/§11 的 typed 词汇表不一致（缺 schema+devices → 现报 `E_SCHEMA_UNKNOWN`；本地 ahead → 现报 `E_NOT_SYNCED`）。

### P2-2 一切 push 失败都走拒推路径并烧预算

- `model/syncCycle.ts:318-321`：

  ```ts
  } catch (error) {
    await port.resetHardOrigin();
    if (attempts >= MAX_ATTEMPTS) { break; }
  ```

  `pushMain()` 因鉴权/网络/服务端 5xx 抛错时同样 `resetHardOrigin()` 并重试，最终统一 `code:'E_PUSH_REJECTED'`（`:341`），无法给出 §9 要求的 `E_AUTH` / `E_IO` 类型化原因。非快进拒推与传输失败在纯决策层不可区分（fake 也只注入 `new Error('E_PUSH_REJECTED: ...')`，`syncWiring.test.mjs:153`）。数据不丢（真值在 outbox），但预算与文案误导。

### P2-3 门禁重查粒度低于 P1-3(a) 字面要求

- §9 P1-3(a)（契约 `:239`）要求「重放前**重新**调用 `assertWritable()`，不是只查一次」；§11 清单第 8 项「每条意图重放前重查门禁」。
- 实现只在三处重查：`syncCycle.ts:207`（fetch 后）、`:220`（behind 快进后）、`:325`（拒推 reset 后整轮重查），**不是每条意图前**。对同一周期共享一个 `timeline/schema.json` 的实际情况而言近似等价，但字面条款未满足，且无「gate 通过→重放中途 schema 被远端改版」的注入测试。

### P2-4 日期不符目录名不报 `E_CORRUPT`

- `model/timeline.ts:607-612` 仅记录 `errors.push({ message: 'date 字段 … 与目录日期 … 不符，按目录日期处理' })`，之后继续解析；`recordsByLine()` 因此仍返回非空 Map。§9 阶段 1 明确「`date` 与目录名不符 → `E_CORRUPT`，整日不动、意图留 outbox」。本模块没有在其上层补判 `parsed.errors`。

### P2-5 无启动/手动周期触发，outbox 不在启动时排空

- `services/syncProtocolStore.ets:138` `runCycle(ctx)` 在 `entry/src/main/ets` 零调用点；生产唯一触发是 `services/recordWriter.ets:95` 的 `runConfiguredCycle()`（仅写成功后）。
- `pages/Index.ets:372-380` bootstrap 只 `setRunner` + `ensureReadyForBootstrap` + 读快照 + `setReadOnly`，**不读 outbox 数量、不跑周期**；设置页 `runAction('pull'/'push')` 走 v1 `syncController`，与新周期无关。
- 结果：带残留 outbox 重启后，既不排空也不显示「N 条待同步」；与 P1-1/P1-5 叠加放大。

### P2-6 测试构成的Credibility 限制

- 44 例中 **36 例可执行行为断言 + 8 例静态源码形状断言**（test 37~44，`syncWiring.test.mjs:560-657`）。fake GitPort（`:91-185`）是内存 Map，**从不调用 `GitSyncService.v2Git` / `opV2Git` / isomorphic-git**；`gitRunner.ets`→`git-bridge.js` 真实链路仅靠 test 41/42 的字符串断言覆盖（`:613-641`）。真实 push/ff/reset/addCommit 的 `unverified`。
- test 41（`:613-630`）的 `files` 数组把 `services/gitRunner.ets` 写了两遍（由 `Set` 去重，无害）；`const noComment = code;` 冗余（`src()` 已 `stripComments`）。
- 正向证据：`assert.ok(bridge.includes("remote: 'origin', ref: 'main', force: false"))`（`:628`）与 bridge 实际 push 代码逐字对应，静态断言本身有效。

---

## 3. 周期轨迹（§9 七阶段，逐阶段对应测试）

| # | 阶段 | 实现位置 | 证明用例（`syncWiring.test.mjs`） | 覆盖判定 |
| --- | --- | --- | --- | --- |
| 0 | 门禁 `assertWritable()`（fetch 只读在前） | `syncCycle.ts:205-210`、`:165-180`（`gateOf`） | test 16 schema=3 → `E_SCHEMA_UNKNOWN`（`:369`）；17 缺标记（`:377`）；18 branch≠main → `E_BRANCH_MISMATCH`（`:384`）；14 ahead（`:352`）；15 diverged（`:362`）；25 fetch 先于门禁（`:457`）；12/13 behind→ff 与 ff 失败（`:333`/`:342`） | ✓（但 typed 词汇缺 `E_MIGRATION_REQUIRED`/`E_LOCAL_PENDING`，见 P2-1） |
| 1 | union（fetch 后按日并集 + 账本 + conflicts） | `syncCycle.ts:244-291`（`:259` `unionDay`） | test 19 远端+本地不同 id 并存（`:393`）；20 later-ts 静默胜（`:403`）；21 同 id 同 ts 字节裁决 + conflicts 行（`:413`）；22 删除账本本地字节严格前缀（`:426`） | ✓（坏文件/日期不符无用例，见 P1-4/P2-4） |
| 2 | replay（outbox FIFO 意图叠加） | `syncCycle.ts:259`（`entriesForDate` 注入 `unionDay`）；`syncProtocol.ts:563` 注释 | test 9 远端删 + 陈旧 upsert → dropped 出队（`:300`）；10 dropped 不 bump attempts（`:314`）；11 远端 restore 后 upsert 重新应用（`:323`）；23 added 只计重放（`:438`）；24 failed 终态不再重放（`:447`） | ✓（服务层 days 覆盖缺口见 P1-1） |
| 3 | 落盘（WritePort） | `syncCycle.ts:261-266`；`syncProtocolStore.ets:250-265`（`writeDayTexts` 原子替换 + 前缀守卫） | test 2 `writes=1` 且并集文本已写入工作副本（`:236`）；test 3 远端拿到本地日文件（`:245`） | ✓（fake 的 writeDay 是内存 Map，真实原子写仅静态） |
| 4 | commit `[v2] sync <n> days`（仅受影响日） | `syncCycle.ts:293-301`；`COMMIT_PREFIX` `:104` | test 1 `commitCount=1`、`commits[0]==='[v2] sync 1 days'`（`:219`）；test 44 静态提交串（`:653`）；test 3 addPaths 仅 `timeline/**`（fake `:138-143` 断言） | ✓ |
| 5 | push `force:false` | `syncCycle.ts:303-318`；`gitRunner.ets:114-117`；`git-bridge.js` push op | test 1 `pushCount=1`、成功路径 `resetCount=0`（`:231`）；test 4 无改动仍一次 push（`:252`）；test 41 静态 `force: false`（`:628`） | ✓（真实 isomorphic-git 未测） |
| 6 | 拒推 → `resetHardOrigin()` → 重放 → 重试 ≤4 | `syncCycle.ts:318-331`（reset `:320`、重查门禁 `:325`、bump `:330`） | test 5 拒一次 → reset→成功、attempts=2（`:261`）；6 reset 后 HEAD==origin、无 force（`:272`）；7 全拒 → `E_PUSH_REJECTED`、attempts=MAX、failed=1（`:279`）；8 耗尽留在 outbox（`:292`） | ✓（attempts 落盘缺失见 P1-3；失败类型区分见 P2-2） |
| 7 | 出队 + 三态计数 | `syncCycle.ts:310`（成功出队）、`:334-346`（failed 终态）；`syncStatusStore.ets:47-56` | test 1 `resultOutbox.length=0`、`pending=0/failed=0`（`:225-233`）；7 failed=1/pending=0（`:286-287`）；9 droppedIds（`:308`）；24 failed 仍在库（`:454`） | ✓（服务层 UI 联动缺手动重试，见 P1-2/P2-5） |

**7 阶段结论**：纯决策层 `runCyclePure` 的编排与 §9 表格**逐行对应**，三条硬禁令（只 `pushMain`、只 `fastForward()`、只 `resetHardOrigin()`）在代码里可逐字验证；失败注入覆盖 gate/ff/push 三类。**不足全部集中在"端口之外的接线层"**（days 派生、outbox 落盘时机、typed 映射、 corrupts）。

---

## 4. 激活决策表（`model/v2Activation.ts:82-118`，逐字文案 `:67-79`）

| 条件（按 `decideActivation` 判断顺序） | code | ok / needsConfirm | 中文 reason（逐字） | nextStep（逐字） | 证明用例 |
| --- | --- | --- | --- | --- | --- |
| `schemaVersion === null` | `E_SCHEMA_MISSING` | false / false | `仓库缺少 timeline/schema.json（或无法解析），不能启用 v2 写入` | `下一步：先运行 v1→v2 迁移生成 timeline/schema.json，再回来开启` | 28（`:488`） |
| `schemaVersion !== 2` | `E_SCHEMA_UNKNOWN` | false / false | `仓库结构版本不是 2（不认识），不能启用 v2 写入` | 同上 `NEXT_SCHEMA` | 27（`:480`）、35 优先级（`:542`） |
| 两者并存 && `timelineDays < 1` | `E_MIGRATION_EMPTY` | false / false | `仓库同时存在 devices/ 与 timeline/，但 timeline/ 没有有效日程数据（迁移未完成），拒绝启用` | `下一步：先运行单向迁移，让 timeline/ 产生有效日程数据，再回来开启` | 30（`:501`）、34 优先于缺周期（`:535`） |
| 两者并存 && 有数据 && 未确认 | `E_NEEDS_EXPLICIT_RESOLUTION` | false / **true** | `检测到 v1（devices/）与 v2（timeline/）数据并存：确认以 timeline/ 为权威并停用 v1 写入？v1 文件不会被删除。`（`:34-35`） | `下一步：在弹层确认以 timeline/ 为权威并停用 v1 写入（v1 文件保留）` | 31（`:510`）、BOTH_TEXT `:470` |
| 上述均过 && `!cycleAvailable` | `E_SYNC_UNAVAILABLE` | false / false | `同步周期不可用（未绑定 GitRunner 或同步内核未就绪），启用后记录只会留在本地，拒绝启用` | `下一步：先进入设置页让同步内核就绪，再回来开启` | 29（`:494`）、33（`:527`） |
| 单态（无 devices/ / 或已确认）&& 周期可用 | `ok` | true / false | `可以启用 v2 时间线写入` | 空 | 26（`:472`）、32 确认后（`:520`）、36 空仓库（`:550`） |

**显式性判定：PASS（进程内）。** 全仓仅 `v2ActivationService.activate()`（`:97`）写 `true`、`deactivate()`（`:104`）写 `false`；两者唯一调用点是 `Settings.toggleV2Write()`（`:518`/`:561-562`），且开启前必经 `decide()` 预检 + `promptAction.showDialog()` 确认（`:534-560`）；并存态专用文案与按钮文案「确认以 timeline/ 为权威」与单态「确认启用」不同（`:546`）。`dualWriteOff.test.mjs:320` 的既有断言仍保证 `timelineModeSwitch.ets` 不写激活位。`deactivate()` 只清激活位与 readMode，**不清 `timeline.v1Retained`**（`:102-106`），符合契约；但持久性见 P1-5。

> 微瑕疵：`Settings.ets:548-550` 里专用确认取消时会恢复 `precheck.reason/nextStep`，单态取消则不恢复错误行——但两者取消都返回且不激活，无安全问题。

---

## 5. 三态文案表（`services/syncStatusStore.ets:99-111`；数据源 = 该 store 的 4 个 AppStorage 键）

| state | label | detail 形成 | 完整 `text` 示例 | 更新时机 | 证据 |
| --- | --- | --- | --- | --- | --- |
| `synced` | `已同步` | `lastAt`（`HH:MM`，本地时间 `:41-43`），缺省 `刚刚` | `已同步·14:23` | 周期 `ok` 且 `pending=failed=0`（`:51-52`） | `Index.ets:1636-1664` `SyncStatusRow()`；静态 test 40（`:601`） |
| `pending` | `${pending} 条待同步` | reason 非空 → `最近失败：${reason}`；否则 `等待重试` | `1 条待同步·最近失败：<SYNC_RETRY_ERROR>` | 周期带 pending/failed（`:48-50`）或 fire-and-forget catch（`:101-103`） | 同上 |
| `readonly` | `只读` | reason 非空取 reason；否则 `v2 写入未启用，当前使用 v1 日程路径` | `只读·v2 写入未启用，当前使用 v1 日程路径（在设置页显式开启）` | bootstrap 未激活（`Index.ets:378`）、关闭 v2（`Settings.ets:522`）、`setReadOnly` | 截图 `.tmp/device-shots/sync-wiring-home.jpeg` 逐字可见 |

- **旧误导文案已删除**：`pages/Index.ets:413` 现为 `共 N 条…（v2 时间线，自动同步）`；全仓 `entry/src/main/ets` 仅此一处含「v2 时间线」，无「v2 时间线，只读」残留。
- **是否随周期/失败更新**：成功周期与 fire-and-forget 失败会更新（见上表）；**停放写失败不会更新**（P1-1），**启动时不从 outbox 播种**（P2-5），**门禁失败被错分为 pending**（P2-1）。

---

## 6. Safety check

| 检查项 | 结论 | 证据 |
| --- | --- | --- |
| `recordWriter` 停放+抛错、无 v1 回落 | **PASS** | `recordWriter.ets:123-146` `parkAndThrow(...): never`，先 `outboxStore.enqueue` 再 `throw new Error('E_V2_WRITE_PARKED: …')`；`:49`/`:119-121` 注释与 `:50/66/81` 三处 catch；v1 `scheduleStore.appendRecord` 只在 `!useV2()` 的三条末尾（`:57/72/87`）。test 43（`:643-651`）断言 `parkAndThrow` 出现 4 次（3 catch + 1 定义）。 |
| 失败面 typed state | **PARTIAL** | 周期结果有 typed code，但 `outcomeToResult` 收窄、`fromCycle` 弃用 code（P2-1）；push 失败无 E_AUTH/E_IO（P2-2）。 |
| 无 `devices/**` 写/删 | **PASS** | test 42（`:632-641`）静态断言新文件无 `devices/`；`git-bridge.js` addCommit 白名单 `paths[i].indexOf('timeline/') !== 0 || … '..' …` 即拒；`opV2Git` 内无 unlink/rm。 |
| 无 force-push / 历史改写 | **PASS** | `git-bridge.js` push 为 `remote:'origin', ref:'main', force:false`；唯一 ff 是 `git.merge({ fastForwardOnly:true })`；resetHard 仅本地 `writeRef(force:true)` + `checkout(force:true)` 指回 origin/main，不删远端；无 rebase/amend/clean/pull --rebase。`syncCycle.ts:12-15` 三条禁令与 test 41（`:613-630`）一致。 |
| 无 shell exec | **PASS** | 全链路为 `v2Git(op,args)` → `opV2Git` → isomorphic-git 异步 API；grep `exec(/spawn/child_process` 在新代码中为 0。 |
| 激活显式性 | **PASS（进程内）** / 持久性 FAIL（P1-5） | 见 §4。 |

---

## 7. Test quality

- **44 例真实存在**：`test(` 计数 44，`node --test syncWiring.test.mjs` 输出 `ℹ tests 44 / pass 44 / fail 0`（§8）。其中 36 例跑真代码（fake GitPort + 纯模型），8 例（37~44）是 `.ets` 源码形状静态断言。
- **既有断言未被削弱**：`git status --short -- '*test*'` 仅新增 `syncWiring.test.mjs`；`git diff --name-only` 无任何既有测试文件。全量相对前基线 +44 完全来自新文件，符合 `docs/MODULES.md:95` 的 +44 记账。
- **缺失的规范性用例（点名）**：
  1. 坏远端 `records.json`（非 JSON 对象）→ `E_CORRUPT` 且该日字节不变（§9 阶段 1）→ 暴露 P1-4。
  2. `records.json.date` 与目录名不符 → `E_CORRUPT`（§9 阶段 1）→ 暴露 P2-4。
  3. 停放意图的日期不在 local/remote days（服务层 `runWiredCycle` 的 days 派生）→ 意图必须仍被重放 → 暴露 P1-1。
  4. 两次 push 失败之间模拟崩溃/重启，`attempts` 必须从磁盘续算（§9 P1-1）→ 暴露 P1-3。
  5. failed 终态的 UI「重试」：断言点击后 `attempts=0,state=pending`（§9 P1-1）→ 暴露 P1-2（当前无 UI 也无断言）。
  6. `E_MIGRATION_REQUIRED`（缺 schema + devices/ 并存）与 `E_LOCAL_PENDING`（ahead）两个 §9/§11 typed 码（现分别为 `E_SCHEMA_UNKNOWN`/`E_NOT_SYNCED`）→ 暴露 P2-1。
  7. 鉴权/网络失败注入 → `E_AUTH` / `E_IO`，且不应 reset/烧预算（§9 typed 列表）→ 暴露 P2-2。
  8. 门禁通过→重放中途 schema 升到 v3（P1-3(a) 的「重放前重查」）→ 暴露 P2-3。
  9. 服务层「带残留 outbox 启动」应显示 N 条待同步并排空（§9 outbox 跨会话）→ 暴露 P2-5。
  10. 真实 `opV2Git` 的 fetch/ff/push/reset/addCommit 冒烟（哪怕用本地裸仓库），当前仅静态字符串断言 → 暴露 P2-6 的 unverified。
  11. `purgeRows` 意图幂等与 `E_DELETED_REMOTELY`/`droppedDeleted` 的 UI 文案（§9 op 表 + P1-3(c)）。

---

## 8. 门闸尾部（本评审亲自复跑；工作目录 `dsh-sync-suite`）

```
$ node apps/arkui-schedule/tools/overlay.mjs status
覆盖层：未应用（工作区为「共享源码 + 平台目录」的原始形态）
[overlay] applied=false

$ node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
EXIT=0

$ node --test apps/arkui-schedule/tools/test/syncWiring.test.mjs
✔ 43 static: recordWriter triggers fire-and-forget sync and surfaces typed result (0.223ms)
✔ 44 static: commit message is exactly [v2] sync <n> days (0.2115ms)
ℹ tests 44
ℹ suites 0
ℹ pass 44
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0

$ node --test "packages/dsh-dots/test/*.test.mjs" "apps/arkui-schedule/tools/test/*.test.mjs"
ℹ tests 2670
ℹ suites 312
ℹ pass 2669
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0

$ node apps/arkui-schedule/tools/validate-app.mjs
🔍 校验 ArkUI-X 工程：…\apps\arkui-schedule
✅ 全部通过：8/8 条规则（JSON5/JSON 70 个、相对 import 411 条、main 静态 import 530 条、页面 7 个、rawfile/git 2 个文件）
EXITCODE=0
```

期望值全部吻合：44/44、2670/2669/0 fail/1 skip、validate 8/8、tsc 0、overlay applied=false。

**设备证据复核**：`entry/build/default/outputs/default/entry-default-unsigned.hap` = **4,528,776 B**，`entry-default-unsigned-signed.hap` 与 `dist-harmony/arkui-schedule-harmony-debug-signed.hap` = **4,591,222 B**（mtime 2026-11-20 05:02:54 / 05:03:13）；`apps/arkui-schedule/final-build.out` 尾部 `> hvigor BUILD SUCCESSFUL in 2 s 414 ms`。`.tmp/device-shots/sync-wiring-home.jpeg`（1600×2560，05:03 截屏）逐字显示 `只读 · v2 写入未启用，当前使用 v1 日程路径（在设置页显式开启）`，证明已安装启动且新三态行渲染成功；未找到单独记录 `hdc install` 文本的本批次日志文件，安装/启动以截图与应用正在运行为证据。

---

## 9. unverified（设备/端到端，本评审未执行）

1. **设备上激活对话框**：单态「启用 v2 时间线写入 / 确认启用」与并存专用「v1 / v2 数据并存：需要显式裁决 / 确认以 timeline/ 为权威」两个弹层的实际弹出、取消、确认后开关翻转与 toast（仅静态断言 + 模拟器不可得的源码形状）。
2. **真实 push / outbox**：`opV2Git` 通过 isomorphic-git 对真远端执行 fetch→addCommit→push→拒推 resetHard→重放的全链路；fake 只证明纯决策，桥接层仅静态字符串断言。
3. **重启持久化**：激活→杀进程→重启后 `timeline.v2WriteEnabled` / `timeline.v1Retained` / `timeline.readMode` 是否仍生效（见 P1-5，静态代码预判为"否"）。
4. **两设备**：同日各建记录、同 id 不同 ts、A 删+B 编辑、媒体占位等 §15 双端场景全部 `unverified`（与项目既有基线一致）。
5. **真机建记录→写 timeline/→自动同步→三态行变「已同步·HH:MM」**：未做；截图仅覆盖 unactivated 的只读态。
6. **failed 终态 UI**：4 次拒推后「N 条待同步·最近失败」在真机上的文案与可点性（且当前无重试实现，见 P1-2）。

---

## 10. 交付建议（ cheapest-to-reverse ）

1. **必须**：`runWiredCycle` 的 days 并入 `outbox.map(e => e.date)`；failed 意图补 UI「重试」入口（原子 `attempts=0,state=pending`）；`attempts` 在每次 push 前调 `writeOutbox` 落盘。三项都补 §7 所列 Node 用例。
2. **必须**：union 前对两侧 `parseTimelineDay` 的 `day===null` 与 `date` 不符做 typed `E_CORRUPT`、整日不动（可复用既有 `syncProtocol` 错误常量或新增），并补注入测试。
3. **必须或明确阻断**：补 `PersistentStorage` 绑定（至少三个键）并在真机验证重启；否则发布说明中把「激活不跨重启」列为已知阻断项，不得以「已可发布激活模块」口径交付。
4. **建议**：`outcomeToResult`/`fromCycle` 按 code 分流门禁失败到 `readonly`；区分 push 错误类型；bootstrap 播种 outbox 计数与周期；把 test 41 的重复文件名去掉。
5. **回滚路径**（与 `docs/MODULES.md:37/55/76-77` 一致）：单独 revert 本模块只回到「v2 写入未激活」的安全态（v1 未删）；但**必须先于** `mod-v2-dual-write-off` 回滚，否则接线悬空。回滚后按 §4 全绿全量复跑。

---

## 复审（2026-11-20，P1-1…P1-5 修复）

> 独立只读复核同一批未提交工作树，源码/测试取当前树；§8 五门本人复跑。本节之外未改任何源码。

- **P1-1 — CLOSED**。`recordWriter.writeV2():93-120` 先 `outboxStore.enqueue(entry)` 再 `apply()`（test 43 静态锚定 `enqueue < apply()`）；失败分支 `updateLastError`→`triggerSync()`→抛 `E_V2_WRITE_PARKED`，成功分支 `remove`→`triggerSync()`。`syncProtocolStore.runWiredCycle():269-277` 由 `outbox[].date` 得 `parkedDays` 并入 `days`（test 46）；`days=[DAY]` 硬编码已删（`run()` 默认 `deriveDays(fake,outbox)`，`:221-241`）；test 45 用「仅停放意图才存在的 2026-12-07」证明该日被 union→commit→push 并出队。
- **P1-5 — CLOSED（静态+编译证据；真机重启仍 unverified）**。新增 `model/persistentSettings.ts` 三键/默认值唯一真值；`EntryAbility.onCreate():42`→`bindPersistentSettings():90-94` 在 `loadContent`（`:115`）前用全局 `PersistentStorage.persistProp` 绑定三键（无 `@kit.ArkUI` import）。三 reader 读同名 `AppStorage` 键（`timelineStore:111-114`、`timelineModeSwitch:85-87`、`v2ActivationService:36-42`），`deactivate():107-110` 显式写 false/`'v1'`；test 47-49 覆盖键/默认/绑定/回读/关闭。编译证据：05:30:24 构建因 `import {PersistentStorage} from '@kit.ArkUI'` 失败（10311006），05:31:31 改为全局类后 `BUILD SUCCESSFUL in 4 s 466 ms`，HAP mtime 05:31:37（EntryAbility mtime 05:31:18）。**仍 unverified**：设备「已激活/已裁决→杀进程→重启仍生效」本批无仓库/真机证据。
- **P1-2 — CLOSED**。`resetForRetry()`（`syncProtocol.ts:357-362`）复位 `attempts=0/state=pending/lastError=''`，payload 不变；`outboxStore.retry():79-97` 原子落盘、id 不见则零写；`Index.retrySync():283-301` 复位全部 failed 后 `wiredContext()`→`runConfiguredCycle(ctx)`→`runCycle(ctx)`（`syncProtocolStore:254-262`）；UI「重试同步」在 `SyncStatusRow():1696-1705`，启动残留 outbox 播种 pending（`:408-415`）。test 50（行为）+51（静态）。
- **P1-3 — CLOSED**。`syncCycle.ts` 拒推 catch 内 `:418-419` 为 `bumpAttempts`→`await persistOutbox` 紧邻语句，终态 `:431` 再落盘；`WritePort.writeOutbox?` 声明于 `:58`，`syncProtocolStore:294-296` 绑定。test 52 的 `diskSnapshots` 断言逐次 `[[1],[2],[3],[4]]`（非周期末一次写），test 53 锚定相邻语句。
- **P1-4 — CLOSED**。`dayIntegrityError()`（`syncCycle.ts:121-140`）在 union 前查两侧：`day===null`（顶层非对象，`timeline.ts:622-624`）或 errors 含「与目录日期」（`timeline.ts:607-612`）→`corruptOutcome():143-151` 零写/零 commit/意图原样留库；`outcomeToResult():334-342` 不再收窄 code（test 57）。test 54（坏远端字节不变）、55（date≠目录名）、56（空日≠坏日）。
- **Cheap extras — PASS**：`typedPushError():157-163` 保留 `E_AUTH` 等 typed 码与原文（test 58）；无 `E_` 前缀的传输错误仍塌缩为通用 `E_PUSH_REJECTED`（信息项，非新缺陷）。每条重放前重过 `gateOf(port)`（`syncCycle.ts:335-341`，test 59）。
- **No new defect — PASS**：无 force-push/历史改写/远端删文件（v2 push `force:false`、唯一 ff-only merge、reset 仅本地；git-bridge.js:2101-2126 只收 `timeline/**`）；无 `devices/**` 写（test 42）；无自动激活（唯一 `activate()` 调用点在 `Settings.ets:561-562`，`applyMode()` 不写激活位）；v2 分支无 v1 回落（三入口的 `scheduleStore.appendRecord` 仅在 `!useV2()`）。
- **既有测试仅按行为变更重定位**：`dualWriteOff.test.mjs` test 14（`parkAndThrow`→`writeV2` 顺序/双路径）、test 17b 与 `timelineService.test.mjs`「读模式键名…」（键字面量收敛到 `persistentSettings.ts`）。test 14 删去了「停放函数不含 `timelineWriteStore`」的断言（writeV2 必经 apply 闭包，无法保留），但 `scheduleStore.appendRecord` 无回落仍由 test 13 与本节 no-fallback 覆盖，**未实质削弱**；其余断言只增未减。**新发现：无。**

**门闸尾部（本人复跑；工作目录 dsh-sync-suite）**
```
$ node apps/arkui-schedule/tools/overlay.mjs status
覆盖层：未应用（工作区为「共享源码 + 平台目录」的原始形态）
[overlay] applied=false
$ node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
EXIT=0
$ node --test apps/arkui-schedule/tools/test/syncWiring.test.mjs
ℹ tests 59 / pass 59 / fail 0
$ node --test "packages/dsh-dots/test/*.test.mjs" "apps/arkui-schedule/tools/test/*.test.mjs"
ℹ tests 2685 / suites 312 / pass 2684 / fail 0 / skipped 1
$ node apps/arkui-schedule/tools/validate-app.mjs
✅ 全部通过：8/8 条规则（JSON5/JSON 70 个、相对 import 416 条、main 静态 import 536 条、页面 7 个、rawfile/git 2 个文件）
EXITCODE=0
```
期望值全吻合（59/59；2685/2684/0/1；validate 8/8；tsc 0；overlay applied=false）。

**总结**：五项 P1 全部 CLOSED、无新缺陷，可作为「激活模块」提交；唯一保留口径是「已激活/已裁决后真机重启仍生效」仍未验证（任务书亦列 unverified），发布说明须如实标注，不得写成已验证。P2-1/P2-2/P2-6 等非本轮范围项维持原判。
