# 独立只读评审：`mod-v2-dual-write-off`（停写 v1 / 条件翻转 / 失败停放）

> 角色：独立、只读评审执行子代理。未改任何源码、未提交、未推送。
> 阅读基线：`项目理解.md`、`docs/DATA-CONTRACT-v2.md` §7/§9/§11、`docs/MODULES.md` §1.1；
> 被评审对象 = 工作树未提交 diff（9 改 + 3 文档改）+ 5 个新增文件。
> 门闸于 2026-11-20 本机重跑，原始尾部见 §8。真机证据见 §9 / `unverified`。
> 本文行号均指被评审时的当前工作树文件。

---

## 1 结论

| 级别 | 数量 | 判定 |
| --- | --- | --- |
| **P0** | 0 | 无数据损坏 / 无 v1 误删 / 无双写分叉 |
| **P1** | **1** | **F1：v2 已翻开关并落盘，但全仓没有任何同步周期调用点；v2 写入永不 commit/push，且首页状态文案反称「只读」——违反契约 §9「无静默本地未推提交」** |
| **P2** | 4 | F2 缺 `v1ReadFallback` flag；F3 失败语义仅靠源码形状断言、无运行时用例；F4 两个 schema 判定函数重复、无一致性用例；F5 单一 revert 捆绑 3 个兄弟模块的编译修复 |
| **blocking** | **是（对“作为首个触数据模块发布 / 真正启用 v2 写入”）** | 必须先关闭 F1：接线 `syncProtocolStore.runCycle`（或明确决定本批仍保持 v1-only 交付，不翻开关）。当前 v1 默认路径安全，故提交本身可合入；但“已具备 v2 写入能力”这一宣称不可据此发布 |

**一句话最重要发现**：七处写路由、条件翻转、失败停放本身实现正确且门闸全绿，但交付范围遗漏了 ROADMAP 明确写在本模块内的「接线 runCycle」（`docs/ROADMAP.md:595`）。`syncProtocolStore.runCycle` 在整个 app 中零调用点（`grep` 仅命中定义处 `services/syncProtocolStore.ets:119`），因此一旦 `timeline/schema.json` 真正为 2，记录只写进本机 `git-repo/timeline/<date>/records.json`，既不 commit 也不 push；首页还显示「v2 时间线，只读」（`pages/Index.ets:396`）。这与契约 §9 的「绝不允许产生一个停留在本地、从未推送成功却不告知用户的提交」正面冲突，是本次评审唯一阻断项。

**安全性边界（必须写清）**：在默认仓库（无 `timeline/schema.json`）下 `useV2()` 恒为 `false`，全部写入仍走 `scheduleStore.appendRecord`，本批不会改变真实用户行为；F1 只在“仓库已被迁移为 v2”这一条件下触发。因此**代码可合入，v2 路径不可启用**。

---

## 2 Findings（证据 + 引用）

### F1 — P1 / blocking：v2 写路径已激活但无同步消费者

**证据 1：零调用点。** 在 `apps/arkui-schedule/entry/src/main/ets` 全量检索 `runCycle`，只命中定义处：

- `services/syncProtocolStore.ets:119` — `async runCycle(ctx: SyncCycleContext): Promise<CycleResult> {`
- `syncProtocolStore.ets:12-14` 自称「本模块不翻转开关、不接 UI、不写 AppStorage、不写 v1 路径」；
- `model/syncProtocol.ts:6` 自称「落盘 / 提交 / 推送由 services/syncProtocolStore.ets 负责（默认关闭，inert）」。

`pages/Index.ets` 只 import 了 `recordWriter` 与 `timelineModeSwitch`（`:63-64`），**没有** `syncProtocolStore` import；bootstrap（`:347-374`）只做四个 `ensureReady` + `applyMode` + `openIndexStore.reconcile()`，没有周期调度、没有 push 触发点。

**证据 2：写入只落本地文件。** `services/timelineWriteStore.ets:110-123` `append()` → `:122 this.atomicWriteIn(this.dayDir(date), RECORDS_FILE_NAME, plan.text)`；`atomicWriteIn`（`:458-506`）只做 tmp 写 + 回读 + `renameSync`，**全程无 git 命令**。`scheduleDelete`（`:129-138`）→ `appendLedgerLine` → 同样只落盘。

**证据 3：状态文案误导。** `pages/Index.ets:390-396`：

```ts
if (timelineStore.useV2()) {
  this.records = ... timelineStore.readDay(this.selectedDate);
  this.statusText = ... ? ... : `共 ${this.records.length} 条${...}（v2 时间线，只读）`;
}
```

即“写入实际发生、同步实际未发生”，UI 却说“只读”。

**证据 4：范围遗漏有据可查。** `docs/ROADMAP.md:595` 原文写明下一模块须「接线 runCycle + 翻转 timeline.readMode='v2' + 重定向 7 处写调用点 + 保留 v1ReadFallback 至 2026-12-31」。本批交付了后两项，**遗漏前两项**。

**后果**：迁移后的仓库里，平板在 v2 模式新建/编辑/删除的记录只存在于本机工作副本；另一台设备与 PC 插件永远看不到；一旦用户清理本机目录即彻底丢失。契约 §9 总原则明确禁止这种“静默本地未推”状态。

**建议修法（二选一，必须在启用 v2 前完成）**：
1. 在 `Index` 保存成功路径与启动/下拉刷新/周期性入口挂 `syncProtocolStore.runCycle({ability, git})`，并把 `CycleResult.pending/failed/code` 接进 §9 三态 UI（当前无 UI 接收者）；或
2. 本批明确降级为“纯路由准备”：不写 `setReadMode('v2')`（即不翻开关），待带 runCycle 的模块一起交付。这符合 `docs/REVIEW-v2-sync-protocol.md:21` 对“unwired 安全、 wired 前须修 F1–F3”的口径。

---

### F2 — P2：`v1ReadFallback` flag 未实现（契约 §1/§13/§15 模块口径缺项）

`docs/DATA-CONTRACT-v2.md:13/328` 规定：切换后保留**一个 release** 的 v1 只读兜底展示，flag `v1ReadFallback`，硬截止 2026-12-31；§15 行“模块口径（P1-7）”要求“源码静态断言可测”。`docs/ROADMAP.md:595` 也把它列为本模块范围。

全量检索 `apps/arkui-schedule`：**零命中**（只有日期常量里出现过 `2026-12-31`，与 flag 无关）。当前实现是“v2 模式只读 timeline/，v1 模式读 devices/”的二选一，**没有任何 v1 兜底读路径**。

评价：不实现 dual-read 反而更符合“最终无双读”目标，不构成数据风险；但**契约与索引登记的承诺未兑现**，且没有 Lead/用户书面豁免。修法：要么补 flag + 截止日期静态断言，要么由 Lead 在 `MODULES.md` / 契约 §13 明确记录“本模块选择直接跳到无双读终态，v1ReadFallback 取消”的决策与理由。

---

### F3 — P2：失败语义与停放行为只有源码形状断言，没有运行时用例

`tools/test/dualWriteOff.test.mjs:245-261`（test 14）对 `parkAndThrow` 的验证方式是：

```js
assert.match(body, /E_V2_WRITE_PARKED: v2 写入失败（\$\{reason\}）/);
assert.match(body, /已存入待同步队列/);
assert.doesNotMatch(body, /scheduleStore|appendRecord|timelineWriteStore/);
```

即“字符串出现在函数体里”，不是“抛出的 Error.message 等于什么、`enqueue` 是否真的被调用/去重、停放失败时文案是否如实”。由于 `.ets` 依赖 `@kit.*` 无法在 Node 运行，这是仓库既有口径（`dualWriteOff.test.mjs:4-5`），但意味着：**任何把 `parkAndThrow` 改成静默 return、或把 `outboxStore.enqueue` 改成 no-op 的回归，都不会被 18 个用例发现**。同理 test 16 对 `outboxStore` 的 tmp/回读/rename/去重也全是源码形状断言。

评价：不 blocking（行为代码经人工逐行核对正确，见 §5），但作为“首个触数据模块”的失败路径，建议至少补一个可注入的纯函数级停放用例（把 entry 构造与 message 拼装抽成纯函数后在 Node 断言），并保留源码断言作为接线保护。

---

### F4 — P2：两个 schema 判定函数重复，缺一致性用例

- `model/timelineMode.ts:33-88 decideMode()`（本批新增）
- `model/timeline.ts:688-714 parseSchemaMarker()`（既有，供 `timelineStore.ensureReady` 用）

两者当前判定口径逐项一致（对象非数组 / `hasOwnProperty('schemaVersion')` / `typeof === 'number' && Number.isFinite` / `=== 2`）。但 `timelineModeSwitch.applyMode` 用前者决定是否 `setReadMode('v2')`，`timelineStore.useV2()` 用后者的结果决定 `isV2()`——两个真相来源。今天不会漂移；将来任一侧放宽（例如接受字符串 `"2"`）就会出现“开关已翻 v2 但 `useV2()` 仍 false（安全降级）”或反向的不一致。18 个用例中没有对同一组输入同时跑两个函数并断言结果一致的用例。建议补一条交叉断言（低成本、可立刻防漂移）。

---

### F5 — P2：单一 revert 捆绑兄弟模块的编译修复，回滚语义需警惕

`docs/MODULES.md:74` 已登记：`services/timelineStore.ets`、`timelineWriteStore.ets`、`syncProtocolStore.ets` 的 ArkTS 严格类型修复属于本批，但文件所有权属于 `mod-v2-read-service` / `mod-v2-write-service` / `mod-v2-sync-protocol`。`MODULES.md:36` 的回滚方式写的是 `git revert <hash>`（5 新增 + 3 UI + 3 服务修复）。

后果：将来若单独 `git revert` 本模块提交，**会一并撤销那 3 个编译修复**，而兄弟模块仍在树中 → 再次 ArkTS 编译失败。登记里已写“单独回滚那些模块前必须先回滚本模块”，方向正确；但 `MODULES.md:36` 的回滚描述没有把这条约束前置到该行本身。建议在该行回滚列直接写“逆序：先本模块，再 read/write/sync service；单独 revert 会破坏编译”，避免执行者只看 §1 表。

---

### 通过项（逐条对应 7 个检查）

#### 检查 1 — 条件翻转：通过

- 唯一翻转条件：`model/timelineMode.ts:72-88`——`typeof version !== 'number' || !Number.isFinite(version)` → v1；`version !== 2` → v1；仅 `version === 2` 返回 `{mode:'v2',code:'ok',reason:''}`（`:88`）。数字 `2` 严格相等；`"2"`、缺失、垃圾 JSON、非对象、数组、`3`、`null` 全部 v1（test 1–4 覆盖）。
- `timelineModeSwitch.ets:53-58`：`if (decision.mode === 'v2') { timelineStore.setReadMode('v2'); ... }`；v1 分支 `:60-61` 只 `return {mode:'v1', code, reason}`，**不写 AppStorage、不迁移、不删 v1**。
- **唯一** `setReadMode(` 调用点：全仓检索只有 `timelineModeSwitch.ets:55`（运行时）与测试字符串；`timelineStore.ets:112-117` 的 setter 本身只在 `:116` 写一次 `AppStorage.setOrCreate`，且只在被 `:55` 调用时触发。无默认写入（`:104` 注释 + `timelineService.test.mjs:248-250` 守卫）。
- 无隐式迁移：四个新文件均无 `migrate` / 建目录 / 写 schema 标记。
- **flip 矩阵见 §3。**

#### 检查 2 — v1 数据未触碰：通过

对 `git diff` + 5 个新增文件全量正则扫描：

- 所有 `devices/` 命中均为**注释/文档/测试断言**（如 `Index.ets:365` 既有注释、`outboxStore.ets:11` “不碰 devices/**”、test 15 的 `doesNotMatch`、文档描述），**没有一行新增代码把 devices/ 当写/删目标**。
- `unlinkSync/rmSync/deleteFile` 命中全部是测试断言串或注释；生产代码中唯一的 `unlinkSync` 是 `timelineWriteStore.ets:550` 的 `cleanupTemp()`，只删自己的 tmp/backup 侧文件（既有逻辑，本批未改），**不删 v1**。
- `renameSync` 命中均为 outbox / timeline 的 tmp→正式文件（`outboxStore.ets:112`、`syncProtocolStore.ets:455`、`timelineWriteStore.ets:472/481/488`），**无一条作用于 devices/ 路径**。
- `appendFile` / `appendFileSync`：**0 命中**。
- v1 文件保持可读：`recordWriter.ets:52/66/80` 的 v1 分支仍调用 `scheduleStore.appendRecord`，`scheduleStore.ets:308-326` 原样保留；`openIndexStore.reconcile()` 仅由 `!useV2()` 守护（`Index.ets:366`）。

#### 检查 3 — 七调用点：通过

| # | 原调用点 | 现调用点 | 方法 |
| --- | --- | --- | --- |
| 1 | `Index.ets:544` 快捷记录 | `pages/Index.ets:556` | `recordWriter.writeRecord(record)` |
| 2 | `Index.ets:822` 勾选完成 | `pages/Index.ets:834` | `recordWriter.writeRecord(next)` |
| 3 | `Index.ets:918` 删除 | `pages/Index.ets:930` | `recordWriter.deleteRecord(tombstone)` |
| 4 | `Index.ets:950` 撤销删除 | `pages/Index.ets:962` | `recordWriter.restoreRecord(restored)` |
| 5 | `Index.ets:1093` AI 回写 | `pages/Index.ets:1105` | `recordWriter.writeRecord(record)` |
| 6 | `RecordEditorView.ets:663` 保存 | `components/RecordEditorView.ets:665` | `recordWriter.writeRecord(record)` |
| 7 | `RecordDetailView.ets:193` AI 回写 | `components/RecordDetailView.ets:194` | `recordWriter.writeRecord(next)` |

- 全仓 `grep '\.appendRecord\('` 只命中 `recordWriter.ets:52/66/80` 三处（v1 翻转前路径）与 `scheduleStore.ets:308` 定义；三个 UI 文件 **0 命中**，无局部别名（`.tmp/fix-dualwriteoff-test.mjs` 显示早期曾用别名，现已移除，test 11 显式断言 `doesNotMatch(/const scheduleStore:\s*\{/)`）。
- `recordWriter.useV2()`（`:36-38`）直接委托 `timelineStore.useV2()`，是唯一判定源。

#### 检查 4 — 失败语义：通过

逐行 trace 见 §5。要点：

- `recordWriter.ets:42-49/57-64/71-78`：三个 v2 分支 `try` 写 `timelineWriteStore`，`catch` 一律 `this.parkAndThrow(...)`，分支内**零** `scheduleStore.appendRecord`（test 13 以花括号切分断言）。
- `parkAndThrow`（`:100-123`）顺序：`:104 makeIntentId(date,id,ts,op)` → `:103-114` 构造 `OutboxEntry`（`line` 为 `JSON.stringify(record)` 或账本行，`enqueuedAt = record.ts` 入队即固定，`state:'pending'`, `attempts:0`）→ `:117 outboxStore.enqueue(entry)` → `:122 throw new Error('E_V2_WRITE_PARKED: v2 写入失败（...），已存入待同步队列')`。
- 停放失败 `:118-120`：`parkNote = '待同步队列写入失败（...），请检查本机存储'`，随后**照样抛类型化错**；不会静默成功。
- 调用点用 `describeError(error)`（`scheduleStore.ets:46-51` 直接返回 `error.message`），toast 形如 `保存失败：E_V2_WRITE_PARKED: v2 写入失败（<原因>），已存入待同步队列`（中文原因 + 停放状态均可见）。

#### 检查 5 — 集成测试：基本通过，有缺口（见 F3/F4）

- **确实跑了 decision→write→read-back**：test 6（`dualWriteOff.test.mjs:143-155`）用 `decideMode('{"schemaVersion":2}')` → `planUpsert` → `buildRecordsText` → `parseTimelineDay` → `visibleRecords` 读回同一条记录并断言 id/ts/title；test 7（`:157-163`）断言两次序列化逐字节一致。
- **确实证明 v1 决策不产出 v2 文本**：test 8（`:165-171`）对版本 3 / 垃圾 / 缺标记三种输入断言 `text === ''`；test 9（`:173-184`）源码层断言非 v2 分支不含任何写函数调用。
- **未覆盖的重要项**：① 运行时执行 `recordWriter` / `parkAndThrow` / `outboxStore.enqueue`（只做源码形状断言，F3）；② `decideMode` 与 `parseSchemaMarker` 一致性（F4）；③ “停放失败”分支的文案；④ v2 写成功后是否触发同步（F1 的根源——测试完全没把 runCycle 纳入契约）。

#### 检查 6 — 编译修复未削弱语义：通过

| 文件 | 改动 | 语义核对 |
| --- | --- | --- |
| `timelineStore.ets:44-52,280-294` | 内联对象类型 → `interface LoadedDay` | 字段与顺序不变；`:292` 先构造 `loaded` 再 return，等价 |
| `timelineStore.ets:296-303` | `record as unknown as ScheduleRecord` → `return record` | `TimelineRecord` 结构上兼容 `ScheduleRecord`（同名同类型 + 额外字段），仍是**同一对象引用**，未知字段原样带出；无拷贝、无裁剪 |
| `timelineWriteStore.ets:44-60,304-410` | `Record<string,unknown>` + `in` → `IncomingRecord extends ScheduleRecord`（可选 `opened_at/closed_at/media`）+ `Set` 字段名集合 | `writtenFieldNames()`（`:352-376`）列出的必写/可选字段与实际写入 `out` 的字段逐一对应；未知字段尾随循环（`:341-347`）仍遍历同一对象 `record as TimelineRecord` 的 `Object.keys`。差异：原 `key in out` 会因原型链把 `toString` 等误判“已写”，新 `written.has()` 不会——**对未知字段保留更正确**，非行为回退。`mediaOf`（`:382-410`）入参改为具名 `incomingMedia`/`attachments`，`typeof`/`Array.isArray` 收窄保留 |
| `timelineWriteStore.ets:435-450` | ledgerKey 去 `unknown` → `LedgerRowShape` | `null`/数组/缺字段仍返回 null（`:441-446` 的守卫保留），坏行退化整行比较的语义不变 |
| `syncProtocolStore.ets:98-103,537-546` | conflictKey 去 `unknown`/`in` → `ConflictRowShape` | 去掉 `obj!==null && typeof==='object' && !Array.isArray` 前置守卫；但 `row.id` 对 null/原始值/数组取值为 `undefined` → `typeof !== 'string'` → 仍落到“整行比较”兜底，语义等价 |
| `syncProtocolStore.ets:396-398,430-436` | `unknown` + `as` → 直接声明 `ScheduleRecord` / `OutboxEntry[]` | 纯类型视图，JSON.parse 返回值不变 |
| `syncProtocolStore.ets:447-455,590-597`；`outboxStore.ets:104-132`；`timelineWriteStore.ets:532-544` | `fs.writeTextSync` → `openSync(READ_WRITE\|CREATE\|TRUNC)+writeSync+closeSync` 助手 | ① **截断**：`TRUNC` 在 open 即截断，等价旧 API 的覆盖写；② **关闭**：`try/finally { closeSync(file) }`（outbox/timelineWrite 还有 catch 包错），open 抛错时无 fd 可关、write 抛错时 finally 必关；③ **部分写**：`writeSync` 可能少于全文，但三处调用点均在 rename 前读回校验（`timelineWriteStore.verifyTmp` `:509-519` 长度+内容双校验；outbox `:109`；syncProtocol `:452`），不一致即抛错并保留 tmp，原子性与不丢旧文件均不受影响 |

**append-only / 原子写 / dedupe / disabled-throws-before-IO 均未削弱**：`timelineWriteStore.appendLedgerLine`（`:417-433`）仍“读旧 → 按 `(id,ts)` 去重 → 旧字节 + 新行原子替换”，旧内容恒为新内容严格前缀（契约 §7 P2-3 允许）；`atomicWriteIn`（`:458-506`）保留 tmp→回读→覆盖 rename→失败 backup 回退；`requireEnabled()`（`:250-254`）在 `append`/`scheduleDelete`/`restore`/`purgeRows`/`appendSummary` 的**第一句**，早于任何 `ensureDir`/`readText`（`:111-112/130-131/146-147/179-180/237-238`），默认 v1 时零 IO；`outboxStore.enqueue`（`:41-51`）按 `intentId` 去重、不刷新已有条目。

#### 检查 7 — 真机证据：部分验证（见 §9 `unverified`）

---

## 3 Flip 矩阵（schema 状态 × 仓库是否配置）

> `applyMode` 在每次 bootstrap 调用（`Index.ets:357`），读 `<filesDir>/git-repo/timeline/schema.json`；"仓库已配置"按 `settingsStore.cached()?.repoUrl.trim().length > 0` 判定（`Index.ets:359-360`），只影响**是否弹提示**，不影响翻转决策本身。

| schema.json 状态 | 仓库已配置 | `decideMode` 结果 | `timeline.readMode` 写入 | `useV2()` 实际 | 用户看到 |
| --- | --- | --- | --- | --- | --- |
| 合法且 `schemaVersion:2`（数字） | 是 | `v2 / ok` | `setReadMode('v2')`（唯一写点） | `true`（`isV2()` 也为 true） | 无 toast；列表改读 timeline/；状态文案「v2 时间线，只读」（**文案不准，见 F1**）；写入落本地 timeline/，**不推送** |
| 合法且 `schemaVersion:2` | 否（但本地残留 schema 文件） | `v2 / ok` | 同样翻 v2 | `true` | 无 toast；同上。注：判定只看文件，不看设置，**残留标记会让未配置仓库也进 v2** |
| `schemaVersion:3` / `"2"` / 浮点 / 无字段 / 非对象 / 坏 JSON | 是 | `v1 / E_SCHEMA_UNKNOWN` + 中文原因 | 不写（保持缺省 v1） | `false` | 启动弹**一条** reason toast，例如「不支持的 schemaVersion：3（仅支持 2），继续使用 v1 日程路径」 |
| 同上 | 否 | 同左 | 不写 | `false` | 不弹 toast（避免打扰新用户），静默走 v1 |
| 文件缺失 / 空 / 纯空白（含“未配置仓库”“已配置但未迁移”） | 是 | `v1 / E_SCHEMA_MISSING` | 不写 | `false` | 一条 toast「缺少 timeline/schema.json，继续使用 v1 日程路径（未改动任何数据）」。**注：契约 §10 在“缺标记 + devices/ 存在”时要求 `E_MIGRATION_REQUIRED`，本模块统一报 `E_SCHEMA_MISSING` 且未给“先迁移”的下一步动作——P2 文案改进点** |
| 同上 | 否 | 同左 | 不写 | `false` | 不弹 toast，静默 v1 |

补充：读文件异常（`fs.readTextSync` 抛错）在 `timelineModeSwitch.ets:45-50` 被吞成空串 → 走 E_SCHEMA_MISSING → v1，安全降级。`timelineStore.ensureReady`（`:72-89`）独立用 `parseSchemaMarker` 得出 `isV2()`；两者当前口径一致（F4）。

---

## 4 Failure-path trace（v2 写失败 → 停放 → 类型化抛出）

```
调用点（7 处之一，如 Index.ets:556 quick record）
  └─ recordWriter.writeRecord(record)                       [recordWriter.ets:41]
      └─ useV2()==true                                     [:36-38 → timelineStore.useV2() :120-122]
      └─ try timelineWriteStore.append(record, dateOf(ts))  [:44]
          └─ requireEnabled/requireReady/requireTs          [timelineWriteStore.ets:111-114]
          └─ planUpsert / atomicWriteIn                      [:118-122]
              ✗ throw（如 E_TS_SHAPE / E_ATOMIC_WRITE / 写入失败 …）
      └─ catch(error) → parkAndThrow('upsert', record, error)  [recordWriter.ets:45-47]
          ├─ reason = error.message                          [:101]
          ├─ entry.intentId = makeIntentId(date, id, ts, op)  [:104 → syncProtocol.ts:337]
          ├─ entry.line = JSON.stringify(record)             [:93,109]
          ├─ entry.enqueuedAt = record.ts（入队即固定）       [:110]
          ├─ entry.state='pending', attempts=0, lastError=reason  [:111-113]
          ├─ try outboxStore.enqueue(entry)                  [:117]
          │   └─ outboxStore.list() 去重 by intentId          [outboxStore.ets:43-50]
          │       └─ writeOutbox → tmp 写 + 回读校验 + rename [outboxStore.ets:104-113]
          │   ↳ 若 enqueue 抛错：parkNote = '待同步队列写入失败（…），请检查本机存储'  [:118-120]
          └─ throw new Error('E_V2_WRITE_PARKED: v2 写入失败（' + reason + '），' + parkNote)  [:122]
  └─ 调用点 catch → promptAction.showToast('保存失败：' + describeError(error))  [如 Index.ets:557-560]
      → 用户看到：保存失败：E_V2_WRITE_PARKED: v2 写入失败（<原因>），已存入待同步队列
```

**关键保证**：v2 分支内没有任何 `scheduleStore.appendRecord`（test 13 花括号级断言）；停放失败也照样抛，不存在“以为成功”的静默路径；`enqueuedAt` 用入队时 ts，与契约 §9「payload 入队不可变、重放不重新生成」一致。`delete`/`restore` 走同一 `parkAndThrow`，只是 `line` 换成 `ledgerDeleteLine` / `ledgerRestoreLine`（`:86-94`）。

**仍未闭合**：停放后的意图何时被消费——`syncProtocolStore.runCycle` 零调用点（F1）。停放是“暂存”而非“已同步”，UI 文案「已存入待同步队列」准确，但没有任何机制把队列排空。

---

## 5 Compile-fix semantics check（逐项，结论见检查 6）

已在上文检查 6 表格逐文件给出。补充两点：

1. **`writeTextSync` 替换与部分写**：三处助手都用 `TRUNC` + `finally closeSync`；调用方都在 rename 前读回比对全文（`timelineWriteStore.ets:509-519` 还比对 `length`），所以即使 `writeSync` 短写也会被拦下，不会把半截内容 rename 成正式文件。tmp 文件名含 `instanceTag + Date.now() + 单调序号`（`:521-525`、`outboxStore.ets:106`、`syncProtocolStore.ets:448`），并发 tmp 不碰撞。
2. **unknown 字段尾随**：`timelineWriteStore.ets:341-347` 用 `writtenFieldNames(out)` 的 `Set` 替代 `key in out`。`writtenFieldNames`（`:352-376`）列出的字段与 `toTimelineRecord` 实际写入的字段完全一致（含 4 个条件可选字段），因此不会漏写已知字段、不会把已知字段重复放进尾部；对原型链上的 `toString` 等不再误判，属正确性微增。

---

## 6 Test quality（18 例）

- **组织**：`tools/test/dualWriteOff.test.mjs` 315 行，18 例；前置 `requireOverlayRestored`（:20）与 ESM 后缀补丁（:30-43）；纯模型从 `../.build` 导入（:45-47）。
- **真实执行的部分**（可信）：test 1–5 决策四分支 + 纯函数性；test 6–8 decision→planUpsert→parseTimelineDay→visibleRecords 往返与“v1 决策零 v2 文本”；test 10–12 七调用点计数、import 与 bootstrap 单 toast；test 15 四新文件零 devices/ 写删；test 18 无新依赖。
- **仅源码形状断言的部分**（脆弱，见 F3）：test 9、13、14、16、17 全部是 `stripComments` + 正则 / 花括号切片。它们保护“接线没被改掉”，但不验证运行时行为。
- **缺口**：停放失败文案、outbox 真去重/decision 与 parseSchemaMarker 一致性、runCycle 接线——见 F1/F3/F4。
- **门闸实测**：18/18 通过（§8）。

---

## 7 Gate tails（2026-11-20 本机重跑）

```
# 1 overlay status
覆盖层：未应用（工作区为「共享源码 + 平台目录」的原始形态）
[overlay] applied=false
EXIT=0

# 2 tsc
TSC_EXIT=0                      （无任何 stdout/stderr）

# 3 dualWriteOff.test.mjs  (tail)
✔ 15 四个新文件零 devices/** 写入 / 删除 / 迁移（v1 数据物理保留）
✔ 16 outboxStore：路径在 git-repo 之外 + tmp 写/回读/rename + intentId 去重
✔ 17 timelineModeSwitch：仅 v2 决策后才 setReadMode("v2")，且全文件只有这一处
✔ 18 无新依赖：四个新文件只 import @kit 内置与仓内相对模块
ℹ tests 18
ℹ pass 18
ℹ fail 0
ℹ skipped 0
EXIT=0

# 4 全量  (tail)
ℹ tests 2625
ℹ suites 312
ℹ pass 2624
ℹ fail 0
ℹ skipped 1
ℹ duration_ms 27353.8371
SUITE_EXIT=0                    （= 期望 2625 / 2624 pass / 0 fail / 1 skip）

# 5 validate-app
🔍 校验 ArkUI-X 工程：…\apps\arkui-schedule
✅ 全部通过：8/8 条规则（JSON5/JSON 70 个、相对 import 392 条、main 静态 import 504 条、页面 7 个、rawfile/git 2 个文件）
VALIDATE_EXIT=0
```

**五门全绿，与批次登记数字一致**（`MODULES.md:92/118`、`ROADMAP.md:554`）。注：`validate-app` 的 import 计数由模块加入前的 355/448 增至 392/504，与新增 import 数量相符，无异常。

---

## 8 真机证据与 `unverified`

### 已验证（证据可复现）

- **编译**：最终成功日志 `apps/arkui-schedule/.build-logs/build-20261120-040917.log` 尾部 `> hvigor BUILD SUCCESSFUL in 6 s 236 ms`（此前 `build-20261120-035634.log` / `-040839.log` 是两次失败尝试，分别暴露 `outboxStore.ets:107 writeTextSync` 不存在、`timelineWriteStore.ets:343` 原型赋值/Function.apply 违规；均已由编译修复关闭）。
- **产物**：`entry-default-unsigned.hap` = **4,371,029 B**（04:09:25）；`entry-default-unsigned-signed.hap` 与 `dist-harmony/arkui-schedule-harmony-debug-signed.hap` = **4,430,324 B**（04:14:08）——与批次声称一致。
- **安装 / 启动 / 首页渲染**：`.tmp/device-shots/dual-write-off-home.jpeg`（1600×2560，126,812 B，状态栏 04:14）显示首页含日期条、`今日待办`、`✨今日汇总 今天还没有日程`，**底部快捷记录行「快速记一条：标题，点『保存』」+ 保存按钮 + 新建按钮**均在。签名/装机/启机由截图时间与产物时间相邻 + 批次登记 `MODULES.md:118` 佐证；仓库内未留存独立的 `install bundle successfully` / `start ability successfully` 命令日志，**该项属“有截图与产物、无命令日志”的弱证据**。

### `unverified`（真实设备 / 第二设备相关，按契约 §15 一律标 unverified）

1. **建记录 → 重启 → 仍在**（最关键的`数据落地`验证）：本次真机只做到“启动后首页渲染”，**没有任何写入动作被注入或观察**。`docs/VERIFICATION.md:1034` 已记录本环境“需要点按注入的交互流程仍未验证，`uitest uiInput click` 返回 No Error 但页面无变化”，因此快捷记录/新建/勾选均无法自动化。→ `unverified`。
2. **`timeline/` 目录布局变化**：未在任何设备上 `hdc shell ls .../git-repo/timeline/`，无法证明 schema=2 时 `records.json` / `deleted.jsonl` / `restore.jsonl` 真的按 `timeline/<date>/` 生成，也无法证明 `devices/**` 日程路径零新增写入。→ `unverified`（源码与纯逻辑只能保证“代码会这么写”，不能保证“设备上真的这么写”）。
3. **v2 模式端到端**：没有“已迁移的 v2 仓库”真机， flips 到 v2 后的读回、删除/撤销账本、失败停放 outbox 的**实际文件效果**全部 `unverified`；F1 的“永不 push”后果也因此**未在真机暴露**，但代码路径已确定。
4. **跨设备 / 双端并发**：两设备同日记录、同 id 同/异 ts、删除+编辑并发、push 被拒重试——契约 §15 全表仍 `unverified`，本模块未新增证据。
5. **回滚演练**：`git revert` 后的全绿全量（`MODULES.md` §4 第 5 步）未执行（只读评审，且模块尚未提交，无可 revert 哈希）。
6. **真机 ArkTS 编译的范围**：`BUILD SUCCESSFUL` 证明当前工作树可编译，但**不能**证明“v2 翻转后的运行时行为”——ArkTS 类型正确 ≠ 语义正确（F1 即反例）。

---

## 9 交付建议（给 Lead / 下一模块）

1. **Blocking（启用 v2 前必须）**：关闭 F1。二选一：(a) 在本批补 `syncProtocolStore.runCycle` 接线 + 三态 UI；(b) 本批不翻开关，把翻转推迟到带 runCycle 的批次。若选 (a)，须同时补“GitRunner 绑定 / outbox 入队 API / 三态 UI”——`docs/REVIEW-v2-sync-protocol.md:443` 早就将其列为 `mod-v2-dual-write-off` 的验收门。
2. **提交前（非阻断但应处理）**：F2 明确 `v1ReadFallback` 的取舍并同步契约/索引；F5 把“逆序回滚”写进 `MODULES.md:36` 该行本身；F4 补一条 decideMode/parseSchemaMarker 一致性用例；F3 至少把 `parkAndThrow` 的 message 构造抽成纯函数做运行时断言。
3. **作为“首个触数据模块”是否可安全发布**：在默认 v1 仓库上**可以**——七路由与失败语义正确、门闸全绿、v1 文件零改动、回滚可静态规划。但“已具备 v2 数据能力”**不可以**对外宣称：F1 使 v2 写入变成无同步的本地孤岛，F2 使契约承诺缺项，真机也未验证任何写入。下一模块（export/import v2）启动前，请先关闭 F1/F2，否则会在一个不完整的 v2 基础设施上继续叠加写入方。
4. **下一步验证（真机恢复后）**：配置已迁移仓库 → 运行 App → 确认 flip toast 不出现、状态文案不再称“只读” → 快捷记录一条 → 查 `timeline/<date>/records.json` 与 git 提交/推送 → 杀进程重启确认记录仍在 → 第二设备确认同步到达。

---

*评审文件结束。只读评审，未修改任何被评审代码。*
