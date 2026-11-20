# 独立只读评审：`mod-v2-only`

> 对象：未提交 diff（28 个 tracked 变更 + 3 个新增；`git status --porcelain` 33 行）。
> 先读：`项目理解.md`、`DATA-CONTRACT-v2.md` §9/§10/§11、`STATE-OF-PROJECT.md`、全量 diff、
> `model/migrationState.ts`、`tools/test/v2Only.test.mjs`。
> **快照提醒**：评审期间工作树被并发修改——`DATA-CONTRACT-v2.md` 13:34、`RUNBOOK.md` 13:35、
> `STATE-OF-PROJECT.md` 随后变更为 v2-only 口径（旧文移入 `<details>` 历史块）。代码/测试/门闸自 13:31
> 起未变；§7 的文档结论按末次复核书写，若 Designer 继续编辑须重取。

## 1 结论

| 级别 | 数量 | 摘要 |
| --- | --- | --- |
| P0 | 0 | 未发现 v1 数据被删/改名/重写；未发现 force-push、删远端、绕过门禁的新写入。 |
| P1 | 3 | P1-1 AI 汇总仍写 v1 `devices/**`；P1-2 v1 导入仍写 `devices/**` 且无迁移门禁；P1-3 文档 retarget 部分完成，`MODULES.md`/`ROADMAP.md`/契约若干节及本批登记仍缺（且评审期间仍在变动）。 |
| P2 | 5 | 纯决策函数在产物中未被调用；残留注释；构建缓存含已删模块；契约空仓库分支与实现不一致；docs 改动混入无关模块。 |

**提交判定：不可提交（as-is）。** 删除机制与四道零写入门本身成立、门闸全绿，但「v2 成为唯一读写路径 /
`devices/**` 永不写入」这一核心承诺被两条仍可达的 v1 写路径证伪；须先闭合 P1-1/P1-2 或由 Lead 书面收窄口径，
并完成 P1-3 文档 retarget 后再评。

## 2 Findings（file:line）

**P1-1 — AI 汇总仍落 v1 路径。** `services/summaryStore.ets:106-136` 的 `generate()` 末尾
`writeDailySummary(this.io(), scheduleStore.getDeviceId(), draft)`；`io()`（`:139`）= `RepoSummaryIO(<filesDir>/git-repo)`，
路径（`summaryRepoPath()`，`:97`）为 `devices/<id>/summaries/<date>.json`。`pages/Index.ets:773-781` 在已迁移态
无条件调用它读的是 `timelineStore.readDay()` 的 v2 记录，却把汇总写进 v1 目录；展示侧 `Index.ets:734/791`
的 `summaryStore.read()` 同样读 v1 文件。契约 §8 要求 `timeline/<date>/summary.json` 原子替换，
`services/timelineWriteStore.ets:238` 已有 `appendSummary()` 却未接线。UI 的 `unmigrated` 早退
（`Index.ets:743-747`、`1015-1019`）只保证未迁移零写，未迁移**以外**仍破坏 v2-only 与 §8。

**P1-2 — v1 导入无迁移门禁、仍写 `devices/**`。** `pages/Settings.ets:1138-1148`
`handleConfirmImport()` 直接调 `appendImportPlan(plan)`；`services/exportService.ets:497-517/580`
→ `writePlan(reconciled.added, importWriteIo())`，其 `dayFilePath`（`:457`）=`scheduleStore.dayFilePath(date)`，
注释（`:493`）明言「只写 `scheduleStore.dayFilePath(date)`」。该函数仅查 `scheduleStore.isReady()`（`:534`），
不查 `timelineStore.isMigrated()`，也不经 recordWriter/outbox/周期。面板的 v1 节常驻、
v2 节只是追加渲染（`components/ExportImportPanel.ets:902`），故已迁移态仍可点「确认导入」：
记录进入 v1 分片且永不同步，形成与 timeline 真值分叉的静默本地写入，违反 §9「outbox 唯一真值」。

**P1-3 — 文档 retarget 仅部分完成 / 不稳定。** 见 §7：`STATE-OF-PROJECT.md` / `RUNBOOK.md` 已在评审中途
改为 v2-only（旧文折叠存档），但 `MODULES.md` 模块表/依赖图/回滚链、`ROADMAP.md` 交接节、
`DATA-CONTRACT-v2.md` §1/§12/§13/§15 仍是旧激活口径，且 `mod-v2-only` 在模块索引中缺登记。

**P2-1** `model/migrationState.ts:49-64` 的 `decideMigration()` 仅被 `v2Only.test.mjs` 调用；
生产路径用 `timelineStore.isMigrated()` + 裸常量，纯决策是产物中的死代码，`hasDevices` 输入从未参与判定。
**P2-2** `model/exportImport.ts:1363` 注释仍称「只服务 `timelineStore.useV2()` 分支」——全仓唯一残留的
`useV2` 字样（注释，非代码）。
**P2-3** `entry/build/default/cache/default/default@CompileArkTS/.../` 仍含已删的 `timelineMode.ts` /
`v2Activation.ts` 编译副本；源码与 import 图已干净，但旧产物需清理或标注。
**P2-4** 契约 `:261` 保留「两者都不存在 → 空仓库，按 v2 初始化并写标记」，而
`migrationState.ts:49-63` 对 `schemaVersion=null`（无论 `hasDevices`）一律 `E_NOT_MIGRATED`，
不建 `timeline/`（测试 D2 明确断言），两者不一致。
**P2-5** 未提交的 `docs/MODULES.md:2715/2723/2732`、`docs/ROADMAP.md:2744` 增量是
`mod-remote-instances-design` 登记，与本批无关；`mod-v2-only` 自身反而未在模块表登记。

## 3 无破坏证明（no-destroy）

- 全量 diff 新增行中命中 `devices/` 仅 2 条**注释**：`pages/Index.ets:401`、「v2-only：绝不写 v1 索引」；
  `tools/test/syncWiring.test.mjs:2250`、「无 devices/ 写静态断言」。零新增 `unlinkSync|rmSync|rmdirSync|
  deleteFile|renameSync|migrate(` 调用（grep `^\+` 命中 0）。
- 含 `devices/` 路径常量的被删文件（v2ActivationService、timelineModeSwitch）是**删除**，不是改写；
  新增 `migrationState.ts` 只含 `hasDevices` 字段与文案，`v2Only.test.mjs:95-101` 断言其无
  `Date.now|fs.|AppStorage|unlinkSync|renameSync|migrate(`。
- `v2Only.test.mjs:206-228` 夹具：含 `devices/tablet-1/schedules` 与 `registry.jsonl` 的仓库，
  跑纯判定前后分片逐字节相等、不建 `timeline/`、不写 `schema.json`。
- 变更/新增写文件中的 `unlinkSync` 仅 `services/timelineWriteStore.ets:552`（tmpPath）与 `:611`（sidePath），
  均为 timeline 原子写 tmp/bak；`GitSyncService.ets:1410`、`openIndexStore.ets:172/178`、`draftStore.ets` 的
  `unlinkSync` 是**未触碰的存量 v1/草稿代码**。
- 结论：**本 diff 未破坏 v1 数据**（无删/改名/重写/迁移）；但「`devices/**` 只被读、从不被写」在当前树中
  **不成立**，反例即 P1-1/P1-2。

## 4 零写入追踪（无 `timeline/schema.json`）

| 入口 | 门槛位置 | 判定 |
| --- | --- | --- |
| recordWriter | `services/recordWriter.ets:77-79`：`isMigrated()` 失败即 `throw Error(NOT_MIGRATED_REASON)`，在 `buildIntent`(`:81`)/`enqueue`(`:85`)/`apply`/`triggerSync` 之前 | PASS（W3 逐句顺序断言） |
| timelineWriteStore | `isEnabled()`→`timelineStore.isMigrated()`；`DISABLED_MESSAGE=NOT_MIGRATED_REASON`；`requireEnabled()` 为公开写方法首句（test 27） | PASS |
| syncProtocolStore | `isEnabled()`→`isMigrated()`；`DISABLED_MESSAGE` 同源；`runCycle` 首句 `requireEnabled()` 且早于任何 IO（test 47） | PASS |
| 快捷记录 | `pages/Index.ets:668-675`：`!this.ready \|\| !timelineStore.isMigrated()` → toast `NOT_MIGRATED_REASON` + return，早于 `writeRecord` | PASS（quickRecordUi 守卫断言） |
| AI 汇总 | UI 早退 `Index.ets:743-747`/`1015-1019`；**服务层无门槛**，且已迁移时写 v1（P1-1） | 部分 / FAIL（见 P1-1） |
| v1 导入 | 无门槛（P1-2） | FAIL（见 P1-2） |

横幅：`model/migrationState.ts:37-46` 逐字文案 + `NOT_MIGRATED_NEXT_STEP`；
`pages/Index.ets:1641-1655` 唯一 `@Builder`，在 compact/wide 两布局各挂一次（`:1813`/`:1858`，B1 断言计数=2）。
按钮仅 `showToast(NOT_MIGRATED_NEXT_STEP)`，不执行迁移、不伪造成功；同步态改为 `syncStatusStore.setError()`
+ `label='错误'`（`services/syncStatusStore.ets:1227/1246`），不再有「只读」态。

## 5 删除与悬空引用

- 已删且磁盘确认不存在（S3 断言）：`model/{v2Activation,timelineMode,persistentSettings}.ts`、
  `services/{v2ActivationService,timelineModeSwitch}.ets`、`tools/test/dualWriteOff.test.mjs`。
- 生产代码：`useV2()/readMode()/setReadMode()/v2WriteEnabled/v1Retained/setReadOnly` **零命中**
  （仅 `model/exportImport.ts:1363` 注释残留，P2-2）；测试中的同名出现全部是 `doesNotMatch`/禁止清单。
- `entryability/EntryAbility.ets` 已无 `PersistentStorage|persistProp|bindPersistentSettings` 与三键绑定
  （diff + S2 断言），仅保留 `scheduleStore.ensureReady`。
- 文档侧悬空仍在：§7。

## 6 测试 retarget 判定（未削弱）

| 文件 | 变更性质 | 判定 |
| --- | --- | --- |
| `b3Batch.test.mjs` | `reconcileIfDue`→`reload`，新增 `doesNotMatch(reconcileIfDue)` | 有意行为变更 + 加强 |
| `exportImportV2.test.mjs` | `useV2()`→`isMigrated()`，新增禁止 `useV2` | 加强 |
| `quickRecordUi.test.mjs` | `isReady()`→`isMigrated()`，新增 typed 原因与守卫顺序 | 加强 |
| `syncProtocol.test.mjs` | 文案 + `DISABLED_MESSAGE`/`isEnabled` 改源，新增禁止旧开关 | retarget |
| `syncWiring.test.mjs` | 删 26–36（decideActivation 已删）、47–49（persistentSettings 已删）；37/38/40/41/42 反转为「不得残留」；test 43 保留 `E_V2_WRITE_PARKED`+enqueue/updateLastError/remove | 有意；仍属契约的失败语义未丢（`:576-586`） |
| `timelineService.test.mjs` | 删 readMode/setReadMode/useV2 断言（API 已删），改 `isMigrated` 唯一门槛 | 有意 |
| `timelineWrite.test.mjs` | `DISABLED_MESSAGE` 与 `isEnabled` 同源 + typed 文案逐字 | 加强 |
| `uiTokens.test.mjs` | `HOME_INCLUDE_OTHER_KEY` 由 must→must-not（v1 过滤开关删除） | 有意 |
| 新增 `v2Only.test.mjs` | 15 例：M1–M3/W1–W5/B1–B2/D1–D2/S1–S4 | 覆盖良好，但未覆盖 P1-1/P1-2 |
| 删除 `dualWriteOff.test.mjs` | decideMode/decideActivation 用例随模型删除而 N/A；七调用点→W2、无 v1 回落→W1、零 devices 写→D1/D2、IO 前拒绝→W3、无新依赖→S4；outbox 路径/tmp/rename→`syncProtocol.test.mjs:543`，停放/抛错/双路径触发→`syncWiring.test.mjs:576-586` | 仍属契约的保证均已迁走，无净损失 |

## 7 文档漂移清单（待 Designer 分配 retarget）

1. `docs/STATE-OF-PROJECT.md`——**已 retarget**（`:9/:46/:48/:53-61`，旧文入 `<details>` 历史块）；残留 §4 `:71` 的「激活后不产生…」措辞，属表述遗留。
2. `docs/RUNBOOK.md`——**已 retarget**（`:100/:114/:135/:234-235` 的「v2-only 订正」覆盖旧激活节）；旧文作为历史保留，可接受。
3. `docs/DATA-CONTRACT-v2.md:13,245,255,321,334,372`——§1/§9/§12/§13/§15 仍写 `mod-v2-dual-write-off`、`v1ReadFallback`、截止 2026-12-31、「只读」三态；§11/§10 已在本批改写，`:261` 与实现冲突（P2-4）。
4. `docs/MODULES.md:26-27,33-39,49,61,71,89-96,115,138-145`——模块表/依赖图/回滚顺序仍围绕激活模块；本批未登记 `mod-v2-only`，反而登记了无关的 `mod-remote-instances-design`（P2-5）。
5. `docs/ROADMAP.md:493,595-601`——交接节仍写「下一模块=双写关闭/激活」「保留 v1ReadFallback」。
6. 历史评审 `docs/REVIEW-{dual-write-off,sync-wiring,v2-read-service,v2-write-service,v2-sync-protocol,contract-tests,three-batches}.md`——建议标为历史归档而非改写（由 Designer 定）。
7. `model/exportImport.ts:1363` 代码注释（P2-2）。

## 8 门闸 tail（末次复核，工作树同 §2 快照）

```
$ node apps/arkui-schedule/tools/overlay.mjs status
覆盖层：未应用（工作区为「共享源码 + 平台目录」的原始形态）
[overlay] applied=false

$ node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
（无输出） TSC_EXIT=0

$ node --test "packages/dsh-dots/test/*.test.mjs" "apps/arkui-schedule/tools/test/*.test.mjs"
ℹ tests 2831      ℹ suites 325      ℹ pass 2830      ℹ fail 0
ℹ cancelled 0     ℹ skipped 1       ℹ todo 0         ℹ duration_ms 30122.9777

$ node apps/arkui-schedule/tools/validate-app.mjs
✅ 全部通过：8/8 条规则（JSON5/JSON 70 个、相对 import 410 条、main 静态 import 525 条、页面 7 个、rawfile/git 2 个文件）
```
期望 2831/2830/0/1、validate 8/8、tsc 0、overlay false —— **全部吻合**。
ArkTS 卫生：新增行无对象字面量当类型、无 `unknown`、无 `in`（grep `^\+` 命中 0）；`migrationState.ts:17-34` 全为显式 `interface`。
本批**无新构建证据**：`BUILD SUCCESSFUL` 仅见于历史文档（`REVIEW-dual-write-off.md:284`、`REVIEW-sync-wiring.md:248`、`VERIFICATION.md`），不能证明本树可编译。

## 9 unverified

- 真机 / 第二设备 / 真 git 并发 / push 全链路 / 迁移后 banner 实机渲染：全部 `unverified`（无设备，沿用项目既有口径）。
- 本批 hvigor `BUILD SUCCESSFUL`、签名/HAP 产物与 overlay 恢复后的真机行为：`unverified`（无新日志）。
- P1-1/P1-2 的运行时写盘仅由源码 + 既有 fake-IO 契约推断，未在真机 FS 上抓到实际字节；需执行确认。
- 评审期间文档并发编辑的最终内容、Lead 是否已提交、§7 漂移项是否又被 retarget：`unverified`（以本文件写出时的 `git status` 为准）。

## 复审（2026-11-20，P1-1/P1-2 修复）

> 只读复查；较 §8 快照新增未跟踪 `v2SummaryImport.test.mjs`（+11 例）。门闸：overlay false / tsc 0 / node --test **2837、2836 pass、0 fail、1 skip** / validate **8/8**。

**P1-1 — CLOSED。** `services/summaryStore.ets` 已重写为薄 v2 适配器：`generate()` 首句 `if (!timelineStore.isMigrated()) throw new Error(NOT_MIGRATED_REASON)`（:75-77），排在 AI 调用 `await summarize(`（:86）与唯一落盘口 `timelineWriteStore.appendSummary(date, text)`（:100）之前——未迁移零 IO、零 AI（E_NOT_MIGRATED）。`read()`（:49-54）只经 `timelineStore.readSummaryText()`，未迁移返回 null。`appendSummary`（timelineWriteStore.ets:238-247）`requireEnabled()`→`isNewerSummaryText`（timelineWrite.ts:103-113：generatedAt 严格更大胜，相等/坏候选保留现有字节）→`atomicWriteIn(dir,'summary.json',text)`，路径钉死 `git-repo/timeline/<date>/summary.json`。汇总路径无 `devices/**`、无 `RepoSummaryIO`/`writeDailySummary`（测试 S1–S6 源码级 + 夹具逐字节验证）；`Index.ets:747-750/773-782` UI 早退与 v2 读源保留。

**P1-2 — CLOSED。** `services/exportService.ets:415-423/527-529` 的 dry-run 与 `applyImportPlanOnce` 均先过 `isMigrated()`→`failed(NOT_MIGRATED_REASON)`，早于 `timelineStore.readAll()`（:550）与任何写盘；`writePlan`+`scheduleStore.dayFilePath()` 分支整体删除，逐条经 `timelineWriteStore.append(record,date)`（:583）落盘，writer 内 `planUpsert` 二次去重（id/更晚 ts）、`mediaOf`（:384）映射 v1 attachments→media。`ExportImportPanel.ets:231-233` `importDisabledReason()` 未迁移返回 NOT_MIGRATED_REASON（含 E_NOT_MIGRATED），选择/确认/取消三按钮 `actionEnabled` 均过闸（:834/:885/:903，测试 I2 断言 ≥3 处）；`Settings.ets:1102-1105/1151-1154` 双重闸 + typed 原因。新测试 I1–I5 覆盖门禁顺序、零 devices 写与双击去重夹具。

**P1-3 — PARTIAL（仅剩措辞残留）。** §9–§11 + RUNBOOK + STATE-OF-PROJECT + MODULES 的 retarget 一致：`mod-v2-only` 已登记于模块表（MODULES.md:48/184）、依赖图（:65）、回滚顺序（:77）；契约 §9:247/249、§10:277、§11:301 均有 2026-11-20 v2-only 订正。仍残留 stale activation/fallback wording（精确行）：
- `DATA-CONTRACT-v2.md:13`（§1）：`mod-v2-dual-write-off` + flag `v1ReadFallback` + 硬截止 2026-12-31 +「只读兜底展示」。
- `DATA-CONTRACT-v2.md:321`（§12）：`mod-v2-dual-write-off` 一 release 只读兜底（截止 2026-12-31）。
- `DATA-CONTRACT-v2.md:334`（§13）：替代模块 `mod-v2-dual-write-off` + `v1ReadFallback` 硬截止 2026-12-31。
- `DATA-CONTRACT-v2.md:351`（§14 开放项 4）：「另起清理提交删除旧 `devices/` 日程数据」——与 §9:249/§10:277「`devices/**` 永不删除 / 任何情况下都不删除」直接矛盾（最需清理）。
- `DATA-CONTRACT-v2.md:372`（§15）：`mod-v2-dual-write-off` 一 release 只读兜底（截止 2026-12-31）。
（`:3`「尚未进入实现」、`:261`「空仓库按 v2 初始化并写标记」与实现不一致属存量 P2-4，非本次新增。）

**无削弱 / 无新缺陷。** `dailySummary.test.mjs` 的「AI 先、写盘后」改指向 `appendSummary` 并加未迁移顺序断言（加强）；`exportImport.test.mjs` 删除的 `writePlan` fake-IO 组是已移除的 v1 写路径本体测试，保证由 `reconcileBeforeAppend` 纯测 + 新文件承接；`exportImportV2.test.mjs` 用 `isMigrated()` 并新增禁止 `useV2`（加强）。283 条新增行无 `unknown` / 对象字面量当类型 / `in` 运算符，无新增 `unlinkSync|renameSync|writeTextSync|TRUNC|writeFileSync` 调用；`devices/` 在新增行仅 9 处「绝不写 devices/」注释。存量 `scheduleStore.appendRecord`（:308-323）仍写 v1 分片，但不在汇总/导入路径上，非本批引入。

**门闸 tail。**
```
overlay.mjs status            → 覆盖层：未应用 / [overlay] applied=false
tsc -p tools/tsconfig.json    → （无输出） exit 0
node --test ...               → ℹ tests 2837 / ℹ pass 2836 / ℹ fail 0 / ℹ skipped 1 / ℹ duration_ms 29966.83
validate-app.mjs              → ✅ 全部通过：8/8（JSON5/JSON 70、相对 import 415、main 静态 import 529、页面 7、rawfile/git 2）
```
期望 2837/2836/0/1、validate 8/8、tsc 0、overlay false —— 全部吻合。

**整体：代码可提交（P1-1/P1-2 已闭合，门闸全绿）；仅余 P1-3 文档措辞残留，建议提交前清理上述 5 行（尤其 §14 与「永不删除」的矛盾），否则按原判定仍不可提交。**
