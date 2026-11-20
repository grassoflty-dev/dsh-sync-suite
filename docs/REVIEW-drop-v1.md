# 独立只读评审 — mod-drop-v1（模块 B）

> 对象：未提交工作树中的模块 B；A=`mod-home-filters-2`、C=`mod-instance-list` 仅在共写 `pages/Index.ets` / `pages/Settings.ets` / 文档处纳入观察，不评价其功能。
> 基线：工作目录 `dsh-sync-suite`，HEAD `db8fe39`；评审日期 2026-11-20。方法：read / grep / `git diff` + 复跑四道门闸；未改任何源码。

## 1 结论

**P0 0 / P1 0 / P2 6；可以提交**（P2 非阻断，建议随批修 P2-1、P2-2）。
1. 六项验证：dangling sweep 已逐类上报（§3）；fresh start 写序正确（§4）；新/改代码 `devices/**` 零读写删（§5）；bundle 唯一版本 + typed 拒绝成立（§6）；删除测试确为删除、freshStart 17 例覆盖完整、retarget 非削弱（§7）；文档主口径一致但有残留（§8）。
2. 门闸全绿：全量 2913/2912/0/1、validate 8/8、tsc 0（§9）。
3. 风险均为文档 / 死代码 / 覆盖边缘；无运行时 P0/P1。真机端侧全部 `unverified`（§10）。

## 2 Findings（file:line）

**P2-1 权威契约内部自相矛盾。** `docs/DATA-CONTRACT-v2.md:192,261,285,377` 新增订正注声明迁移态整体废止，但同文件正文 `:13,202,247,249,251,253,257,265,275,281,287,288,340` 仍以现在时写「未迁移 → `E_NOT_MIGRATED` + 一条 banner + 零写入」，`:265` 仍要求四种 (标记, devices/) 组合分支，`:288` 仍写「删标记保留 devices/ → `E_NOT_MIGRATED`」。代码已无该分支；`freshStart.test.mjs:288-295` 的文档断言只查 RUNBOOK / EXPORT-IMPORT。建议把上述行标注「历史存档」或改写为空仓库口径。

**P2-2 文档控制字符。** `docs/EXPORT-IMPORT.md:372,373,377,401` 在 `bundleVersion` 前混入 U+0008（backspace），渲染成 `undleVersion`；F17 因正则 `/不支持/` 仍命中而漏检。改成普通反引号即可。

**P2-3 旧 bundle 死代码 / 过期注释。** `model/exportImport.ts:1182`（`V2_REFUSAL_V1_TARGET`）、`:2035`（`v2PlanNotes`）、`:1204,1234,1689,1736,1883`（「旧 bundle 可缺席 / informational note」注释）与 `services/exportService.ets:44`（仍 import `v2PlanNotes`）在降级分支删除后未清理；`V2TargetState.repoIsV2`（`exportService.ets:805` 恒置 true）也已不参与判定。行为正确，属卫生项。

**P2-4 相邻模块登记过期。** `docs/MODULES.md:179`（`mod-export-json` 交付行）仍写「旧 bundle 无 media.zip 不拒绝 + note，`>2` typed 拒绝」，与 `:50` 的 mod-drop-v1 口径冲突，需加 superseded 注记。`:48,176,207` 的历史行由 `:50` 概括取代，可接受。

**P2-5 覆盖边缘轻微下降。** `exportImportV2.test.mjs` 删除「畸形版本（0 / `"2"`）→ `E_BUNDLE_CORRUPT`」后，新用例只覆盖 `undefined/1/3`；现行为统一 `!==2 → E_BUNDLE_VERSION`（`exportImport.ts:1424-1428`）正确，但畸形值缺显式断言。建议补 0 / `"2"` 两值。

**P2-6 端到端语义边界（未改代码）。** `services/scheduleStore.ets:82,363-364`（本模块未修改）在启动 `ensureReady` 时仍创建 `devices/<id>/schedules` 与 `attachments` 空目录；故「`devices/**` 零写入」只对本次新/改代码成立，端到端未验（§10）。

## 3 Dangling sweep

`grep -R 'importV1|migrationState|E_NOT_MIGRATED|查看迁移步骤'` = 91 命中，逐类：
- **合法（否定注释 / 历史）**：`timelineStore.ets:9`、`recordWriter.ets:6`、`freshStart.test.mjs:5,194,200,203-214`、6 份 `REVIEW-*.md`、`VERIFICATION.md:1128`（已标历史）、`MODULES.md:48,49,50`、`ROADMAP.md:460,496,610,611`、`RUNBOOK.md:13,15,34`。
- **已上报**：`DATA-CONTRACT-v2.md` 13 处（P2-1），不属合法历史，需修。
- **构建缓存（非源码、git 未跟踪）**：`entry/build/.../migrationState.ts`、`importV1Service.ts`、`importV1Reader.ts`（`git ls-files` 对 `entry/build/` 命中 0）；清理/重建即可，不阻断。
- **源码零命中**：无 `importV1.ts` / `importV1Service` / `importV1Reader` 的实现引用；`E_NOT_MIGRATED` 常量定义已随 `model/migrationState.ts` 删除。

## 4 Fresh-start trace（写序与安全）

1. 启动：`Index.ets:369-392` bootstrap → `summaryStore.ensureReady`（内部拉起 `timelineWriteStore.ensureReady`）→ `timelineWriteStore.ets:100-105` `ensureSkeleton()`（`:116-125`）写 `<filesDir>/git-repo/timeline/schema.json` = `FRESH_SCHEMA_TEXT`（`freshStart.ts:13`）。读侧 `timelineStore.ets:69-88` 用 `decideFreshStart()`（`freshStart.ts:32-41`）判缺标记 = 空仓库 → 空列表、无 banner、无拒绝。
2. 首条写：`recordWriter.ets:68+` 先 `buildIntent` + `outboxStore.enqueue`（仓库外真值），再 `timelineWriteStore.append()`（`:142+`）：`requireReady` → `requireSchema()`（`:283-289`，先 `schemaProblemText()` 拒绝未知版本，再幂等 `ensureSkeleton()`）→ `ensureDay(date)`（`:128-139`，校验真实日历日，建 `timeline/<date>/` 并写 `freshDayText()` 空骨架）→ `requireTs` → `visibleOf()` 基线 → `planUpsert` → `atomicWriteIn()`（tmp + rename）落记录。
3. **写序**：schema 标记 → 日空骨架 → 记录原子替换。安全理由：未知版本门禁在任何 `timeline/**` 写句柄之前；空骨架先落地使「骨架后、记录前」崩溃仍是合法空日；outbox 先停放使写盘中崩溃可重放；tmp+rename 防半文件。F1–F8、F11、F14 覆盖；真机端侧 `unverified`。

## 5 devices/** proof

新/改代码零真实引用：`devices/` 仅出现在否定注释（`timelineStore.ets:16`、`summaryStore.ets:9`、`recordWriter.ets:21`、`freshStart.ts:8`、`Index.ets:389`、`exportService.ets:12,16,21,203,450,544,590`）。`freshStart.test.mjs:233-239`（F13）静态断言 8 个文件无 `devices/` 字面量、无删文件 API；F6/F14 夹具对旧目录整棵（含 `open.jsonl`）逐字节前后比对相等。构建缓存例外见 §3。

## 6 Bundle-compat verdict

**PASS。** `exportImport.ts:1153` 唯一 `V2_BUNDLE_VERSION=2`；`:1424-1428` 对 `!==2`（缺失 / 1 / >2 / 畸形）返回 `V2_REFUSAL_BUNDLE_VERSION` + 中文原因「不支持的 v2 bundle 版本（…），本机只支持 bundleVersion=2；请用当前版本工具重新导出」；`planV2Import` 零计划零写入。`V2_BUNDLE_VERSION_LEGACY`、`V2_NOTE_*`、`bundleVersion>=2` 条件分支已删；`EXPORT-IMPORT.md:370-382` 声明旧 bundle 不支持。F15/F16 + `exportImportV2.test.mjs` retarget 钉死；残留死注释见 P2-3。

## 7 Test-deletion verdict

- `tools/test/importV1.test.mjs` 状态 `D`（已删除），非 skip；全仓测试无 `.skip(` / `.todo(`；唯一 skip 来自未改的 `packages/dsh-dots/test/remote-listener.test.mjs:55` 条件跳过。
- `freshStart.test.mjs` 17 例：F1–F4 纯决策 / 规范字节，F5–F8 空仓库 → 首用骨架 → 首条记录 → 重启读回，F9–F14 无 banner / 无迁移入口 / 源码无旧目录 / 夹具字节不变，F15–F17 bundle 与文档口径。
- **Retargets（非削弱）**：`exportImport.test.mjs` 迁移门禁 → 无门槛且保留 read→reconcile→write 顺序断言；`exportImportV2.test.mjs` 旧包 note / 旧媒体降级 → `E_BUNDLE_VERSION` + 零计划 / 零记录，删 `E_V1_TARGET` 用例（空仓库已成合法目标）；`dailySummary` / `syncProtocol.test.mjs` 删未迁移拒绝用例（特性已删）；`timelineWrite.test.mjs` 未迁移拒绝 → 首用骨架；`timelineService` / `v2Only` / `v2SummaryImport.test.mjs` 的 `isMigrated()` 期望 → 空仓库口径；`exportJson.test.mjs` 随 bundle 唯一版本 retarget。唯一缺口 P2-5。

## 8 Docs verdict

`RUNBOOK.md:11-29` 迁移章已替换为 “Start fresh”（空列表 / 首用 schema / 首条 records.json / 忽略旧目录）；`STATE-OF-PROJECT.md:9,62,95,101`、`ROADMAP.md:460`、`VERIFICATION.md:1128` 与主口径一致；`MODULES.md:49` 标记 `mod-v2-import-v1` superseded、`:50` 登记 `mod-drop-v1`。`EXPORT-IMPORT.md:370-382` 声明旧 bundle 不支持（但有 P2-2）。**不一致**：`DATA-CONTRACT-v2.md` 正文（P2-1）、`MODULES.md:179`（P2-4）。

## 9 Gate tails（原样）

```text
G1 node --test freshStart.test.mjs exportJson.test.mjs
   ℹ tests 24 / suites 2 / pass 24 / fail 0 / skipped 0 / duration_ms 334.83
G2 node --test "packages/dsh-dots/test/*.test.mjs" "apps/arkui-schedule/tools/test/*.test.mjs"
   ℹ tests 2913 / suites 337 / pass 2912 / fail 0 / skipped 1 / duration_ms 63103.58
G3 node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
   （无输出）tsc exit=0
G4 node apps/arkui-schedule/tools/validate-app.mjs
   ✅ 全部通过：8/8 条规则（JSON5/JSON 70 个、相对 import 428 条、main 静态 import 548 条、页面 8 个、rawfile/git 2 个文件）  validate exit=0
```
（同树含 A/C 未提交改动，门闸覆盖整棵树；期望值 2913/2912/0/1、8/8、tsc 0 均吻合。）

## 10 unverified

- 真机空仓库启动 → 空列表 → 首条写落 schema/records.json → 重启读回 → push；`hdc list targets` 为空（§4、RUNBOOK §6）。
- 汇总链路 `summaryStore.generate()` 触发首用骨架（纯逻辑未覆盖）与 typed 文案在真机三态行的呈现。
- 双端 timeline / bundle 并集、旧设备目录在真实仓库的残留处置；模块 B 未做真机 ArkTS 编译（仅 `validate-app` + 源码形状断言）。
- P2-6：未改的 `scheduleStore` 启动建 `devices/` 空目录的端到端行为，不计入模块 B 提交门槛。
