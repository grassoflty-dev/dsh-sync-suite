# REVIEW — 三批未提交改动（独立只读评审）

评审对象：HEAD `29e2615` 工作区的三批未提交改动。依据：`项目理解.md`、`docs/DATA-CONTRACT-v2.md` §4/§5/§7/§9/§11/§15、`docs/MODULES.md` §1/§1.1、`docs/REVIEW-export-import-v2.md`。时间 2026-11-20。真机 / 第二设备 / DevEco 不可用，端侧结论一律 `unverified`。本次评审只读（除本报告外未改仓库文件），实际 diff 逐行审读，未采信批次摘要。

## 1. 批处理结论（P0 / P1 / P2 + blocking）

| 批 | 范围 | P0 | P1 | P2 | blocking | 判定 |
| --- | --- | --- | --- | --- | --- | --- |
| A | 导出导入修复：`model/exportImport.ts`、`services/exportService.ets`、`components/ExportImportPanel.ets`、`tools/test/exportImportV2.test.mjs` | 0 | 0 | 2 | 无 | 可以提交 |
| B | 加固：新增 `tools/test/twoDevice.test.mjs`、`model/syncProtocol.ts` tie-break 修复、`tools/test/syncProtocol.test.mjs` | 0 | 0 | 3 | 无 | 可以提交 |
| C | RUNBOOK：`docs/RUNBOOK.md` + `docs/MODULES.md` / `docs/ROADMAP.md` 登记 | 0 | 0 | 1 | 无 | 可以提交 |

前次 `docs/REVIEW-export-import-v2.md` 的 **P1-1（媒体不校 sha256）已由 A 批修复**；该评审的 P2-3（bundle 不含账本）三批均未触及，仍 open。

## 2. Findings（`file:line`）

- **P2-A1（测试强度）**：服务层 `applyV2ImportOnce` 的"预检早于一切写入"与失败零写入，只由源码级正则断言守卫（`tools/test/exportImportV2.test.mjs:583-601`），无 fake-IO 执行测试；媒体搬运失败分支（`services/exportService.ets:1048-1052`）同样只有代码审阅。模型层 `checkV2MediaIntegrity` 的 7 条新测试是真实的（`:459-552`），但服务层未被行为覆盖。非阻塞。
- **P2-A2（登记漂移）**：代码与测试现为**七类**导出导入拒绝（`model/exportImport.ts:1388/1390`，测试 `exportImportV2.test.mjs:419` 已改名"七类"），但 `docs/MODULES.md:38/126` 的 `mod-export-import-v2` 行仍写"五类 typed 拒绝"并只列五个码。非阻塞，建议 Lead 提交前回填。
- **P2-B1（测试打到替身）**：`tools/test/twoDevice.test.mjs:233-265` 的假 `writePort.writeDay` **自行重实现** conflicts 的 `(id,ts,dedupeKey)` 去重（注释自称镜像 shipped `services/syncProtocolStore.ets:310-313`）。因此 S3-c（`:447-466`）与 S8-b（`:783-803`）的"不重复追加"断言实际验证的是测试替身，不是交付代码。模型层 `addConflict` 去重（`syncProtocol.ts:595-604`）仍被测到，故非阻塞。
- **P2-B2（只钉内部）**：S1-c（`:352-363`）断言 `B.ffs===1` / `B.head===aHead` / `head===remote.head`，这些是假 `Remote` 线性提交 DAG 的内部计数；契约 §9 P1-6 只要求 fetch + 语义并集、无 rebase/merge，未规定 fast-forward 次数。属实现 incidental。
- **P2-B3（覆盖缺口）**：未测的契约规则——`R.ts < D.ts` 隐藏（§7:156；S5-b `:650-666` 只测 R==D 与 R>D）、§5 媒体链路 / `媒体待迁移` 占位、§8 summary newer-wins、§6 `opened_at`/`closed_at` 完成耗时、§9 P1-1 `maxAttempts=4` 耗尽→`failed`→手动重试、§11 未知 schema 零写入、§9 push 连续被拒 4 次耗尽。非阻塞。
- **P2-C1（文档行数失实）**：`docs/MODULES.md:39/127` 把 `mod-runbook` 登记为"`docs/RUNBOOK.md` 6 节 126 行"，实际文件为 **6 节 220 行**（LF 计数 220，首字节无 BOM）。节数正确、行数错误；不影响任何命令或门闸。非阻塞。

## 3. 四个焦点问题（含证据）

### 3.1 媒体预检 / TOCTOU —— 达成 fail closed before any write

调用顺序（逐字，`services/exportService.ets`）：`:973` `v2TargetState()` 门禁复查 → `:989` `checkV2MediaIntegrity(plan, {...})` → `:997` `if (!mediaCheck.ok) { return v2ApplyFailure(mediaCheck.code, mediaCheck.reason); }` → `:1001` `for (const day of plan.days)` → `:1023` `timelineWriteStore.append(...)` → `:1047` `v2WriteBinary(dest, item.bytes)` → `:1058` `timelineWriteStore.appendSummary(...)`。预检严格早于 records / media / summary **三类写入**，且 `applyV2ImportOnce` 是唯一 v2 导入落盘路径（v1 `appendImportPlan` 未改）。

字节同源：`:995` `readSource` 读入 → `model/exportImport.ts:2000-2076` 产出 `verified[].bytes`（就是已校 sha256 的那一份）→ `:1047` `v2WriteBinary(dest, item.bytes)` 直接写内存字节，**无二次读源文件**；`dest` 由同一 plan item 的 `date`/`file` 派生（`:1034/1039`），无路径换。`:724-735` 的 `v2WriteBinary` 用 `READ_WRITE|CREATE`（非 TRUNC），写后再 `:1040` 守一次 `fileExists` 不覆盖。

类型码与零写入（全在 `model/exportImport.ts:2000-2076`）：篡改 / 源读不出 / 目标读不出 / 计划有媒体但 manifest 无 sha256 条目 → `E_MEDIA_CORRUPT`（`:2055/:2062/:2038/:2028`）；manifest 同 `(date,file)` 双 sha / 目标同名异容 → `E_MEDIA_COLLISION`（`:2013/:2044`）。所有失败分支 `verified: []`，服务层 `:997` 立即返回，**一个字节都不写**。代价：把校验读到的字节交给写入（已实现），不做逐日回滚——记录/汇总是原子替换、媒体是另一批文件，无跨文件事务，选择合理。

### 3.2 同 `(id,ts)` 裁决分支 —— 顺序无关、败者恒真

`model/syncProtocol.ts:708-738` 四支：identical → `:712` 早退无冲突；`delta>0`（既有更晚）→ `:717-720` 保既有、静默；`delta===0` → `:726` 先 `addConflict(id, ts, loserLine(existing, incomingLine))`，再 `:727` `byteCompare(incomingLine,existing)<=0` 决定保既有（incoming 为败者，`continue`）或落入 `:735` 替换（incoming 为胜者、计入 `added`）；`delta<0`（incoming 更晚）自然落入同一 `:735` 替换。败者由 `loserLine()`（`:409-411`，返回字节较小者）与 `byteCompare()`（`:268-278`，与 `Buffer.compare(...,'utf8')` 等价）决定，**与哪个是 existing / incoming、到达顺序无关**。`dedupeKey=sha256(规范 losingLine)`（`:383`），去重键 `(id,ts,dedupeKey)`（`:595-604`），与契约 §4 逐字一致。

非重放的 remote∪local 路径（`:613-648`）用同一 `byteCompare` 选字节大者、仅 `delta===0` 记败者（`:639-642`），与 replay 分支一致。证据：`tools/test/syncProtocol.test.mjs:814+` 的 test 72 双向断言（incoming 大→替换且 `added=1`，incoming 小→保既有且 `added=0`，两向 losingLine 均为较小行）；`twoDevice.test.mjs` S3-a/c/d/e/f/g 覆盖双向交错、三方 a/b/z、UTF-16 vs UTF-8 陷阱与 `dedupeKey` 双端一致。边界（未阻塞）：`delta===0` 用的是时刻比较，若两行 `ts` 同瞬间但字节不同，冲突行 `ts` 取 `record.ts` 而非败者自身 `ts`；正常路径 `ts` 字节恒同，不触发。

### 3.3 `twoDevice.test.mjs` 是否断言契约 —— 主要是契约，有内部 incidental

真实断言契约：S3-a/b/e/f/g（`:404-561`）字节大者胜、败者唯一且双端同 `dedupeKey`、UTF-8 字节序、三方收敛；S4-a/b/c/d（`:565-630`）删除账本胜、旧/晚 upsert 都丢弃（`droppedDeleted`）、P2-13 保行只过滤；S5-a/b（`:634-666`）`D.ts<R.ts` 可见、`R==D` 隐藏；S6-a（`:670-690`）outbox 排空 `pending=0` / `resultOutbox=[]`；S7-b（`:743-757`）push 被拒→`resets=1`→replay→`attempts=2`→`A.head==remote.head`（无 force-push，假端口本身无 force 能力）。测试跑的是 shipped `.build` 纯模型，非桩。

只钉内部：S1-c（`:352-363`，见 P2-B2）；S6-b `:700` 的 `days==[ONLY]` 是 review P1-1 回归，半内部。未测规则见 P2-B3。总体以契约为锚（文件头 `:9-12` 明列 §4/§7/§9/§15 条款），可接受。

### 3.4 RUNBOOK 准确性 —— 引用全部命中，`unverified` 未被自相矛盾抵销

逐项核对均存在且语义一致：`tools/migrate-v1-to-v2.mjs`（`--repo/--dry-run/--apply/--out/--force`、exit 0/1/2/3、`plan days=`/`[migrate] day`/`dry-run: 未写入任何文件`/`verify ok`/`保留现场`/`目标 timeline/ 已存在`：工具 `:48-53/:502/:504/:508/:765/:778/:783`，`EXIT` `:30`）；`tools/migrate-media-v1-to-v2.mjs`（`--repo/--dry-run/--apply`、dry-run 不需 schema、apply 需 `schemaVersion=2`、ZIP64/加密 exit 3、`E_MEDIA_SHA16_COLLISION`：工具 `:76-80/:31/:37/:633/:737-747`）；`overlay.mjs` / `validate-app.mjs` / `tools/tsconfig.json` / `node_modules/typescript/bin/tsc` 均存在并实跑；RUNBOOK §3 引用的 10 个 `module/mod-*` tag 全部存在（`git tag -l`，另 3 个未引用）；hdc 路径 `D:\A-DevEco\DevEco Studio\sdk\default\openharmony\toolchains\hdc.exe` 与 `docs/VERIFICATION.md:941` 逐字一致，§14.8（`:1042`）/§14.9（`:1072`）存在；`Settings.ets:544` `toggleV2Write`、`:572/578` 并存弹层、`SyncSection.ets:660/666` 开关与 RUNBOOK 行号一致；§4 五类拒绝与 `model/v2Activation.ts:75-79` 的码与中文原因一致。

`unverified` 自洽：RUNBOOK §6（`:209-220`）与 `docs/VERIFICATION.md §14.8` 的 STILL UNVERIFIED（`:1067`「与真实第二设备 / PC 的同步」）以及 `docs/REVIEW-sync-wiring.md` §9（`:252-257`）同口径；§2:119、§5:201 还显式重申"仍 unverified / 现场核对不是引用已有通过结论"，全文无"已验证 / BUILD SUCCESSFUL / PASS"式端侧声称。唯一失实是 P2-C1 的行数登记。

## 4. 门闸 tail（复现，逐字）

```
# node apps/arkui-schedule/tools/overlay.mjs status
覆盖层：未应用（工作区为「共享源码 + 平台目录」的原始形态）
[overlay] applied=false
# node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
TSC_EXIT=0
# node --test exportImportV2 + twoDevice + syncProtocol
ℹ tests 132
ℹ suites 8
ℹ pass 132
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 169.0755
# node --test 全量（packages/dsh-dots/test/*.test.mjs + apps/arkui-schedule/tools/test/*.test.mjs）
ℹ tests 2746
ℹ suites 320
ℹ pass 2745
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 27527.7462
# node apps/arkui-schedule/tools/validate-app.mjs
✅ 全部通过：8/8 条规则（JSON5/JSON 70 个、相对 import 424 条、main 静态 import 545 条、页面 7 个、rawfile/git 2 个文件）
```

全量 **2746 / 2745 pass / 0 fail / 1 skip**、validate **8/8**、tsc **0**、overlay **false**，全部符合预期。用例增量可精确对账：`exportImportV2` 26→34（+8）、`twoDevice` 新增 26、`syncProtocol` 71→72（+1），合计 +35 = 2711→2746，**无静默删用例**。

## 5. 未削弱 / 无范围漂移 / ArkTS hygiene

- 既有测试文件仅两个被改且均为**增强**：`exportImportV2.test.mjs`（新增 7 条媒体预检 + 1 条接线断言，五类→七类，"V2_NOT_WIRED 保留"改为"不得残留"是为配合 A 批面板修复）；`syncProtocol.test.mjs`（仅追加 test 72）。无既有断言被放宽；`exportImport.test.mjs`（v1 84 例）逐字节未动（不在 changed 列表）。
- 代码侧均为追加式：`exportImport.ts` +`sha256Hex` import + 两个 typed 码 + 新函数 + 两个 next 文案；`exportService.ets` +import + `v2ReadBinary`/`v2WriteBinary` + 预检调用 + 写源改为已校字节；`ExportImportPanel.ets` 只删不可达的 `V2_NOT_WIRED` 分支（修前次评审 P2-2）；`syncProtocol.ts` 只改 replay 分支。v1 函数体零修改。
- 无 `devices/**` 写/删：媒体落点 `V2_REPO_RELATIVE='git-repo/timeline'`（`exportService.ets:600`），`devices/**` 仅出现在注释（`:14/:578`）；`twoDevice.test.mjs:168` 断言 commit 路径以 `timeline/` 开头。无 force-push / 历史改写 / 远端删除：本批未碰 git 桥，RUNBOOK §1.6 明令禁止；`git-bridge.js` 的 `opV2Git`（`:2010`）push `force:false`（`:2127`）、`fastForwardOnly:true`（`:1523/1580/1766`）。
- ArkTS hygiene：新增 `.ets` 段用显式 interface / `Map<string,string>` / `Uint8Array` / typed `V2MediaCheckResult`，无 `unknown` 新用、`in`、对象字面量当类型；`sha256Hex` 在 `model/sha256.ts:170` 接受 `Uint8Array`。tsc exit 0 + validate 8/8 为构建证据。

## 6. unverified（必须保持开放）

- 真机 / 第二设备 / DevEco：`hdc list targets` 空、无 SDK。A 批服务级 IO（`applyV2ImportOnce` / `v2ReadBinary` / `v2WriteBinary`）无 fake-IO 执行；B 批双端收敛只在内存模拟远端验证，真实 git 并发、fetch 耗时、仓库体积影响未验；C 批 §6 三条（设备激活弹层 / 双端并发 / PersistentStorage 重启）均保持 `unverified`。
- 前次评审 `docs/REVIEW-export-import-v2.md` §2 的 **P2-3**（bundle 不含 `deleted/restore/conflicts.jsonl`，跨端删除/撤销语义差异）三批未处理，须继续 open；P2-5 服务级测试缺口部分由 A 批改善但仍未完全覆盖。
- 本评审 P2-A1 / P2-A2 / P2-B1 / P2-B2 / P2-B3 / P2-C1 为 follow-up，不构成本次 blocking；不得在提交说明中写成"已验证"。

## 7. 最终判定

- **A：可以提交**（P0 0 / P1 0 / P2 2，无 blocking；P1-1 已闭合）。
- **B：可以提交**（P0 0 / P1 0 / P2 3，无 blocking；tie-break 修复正确且双端测试到位）。
- **C：可以提交**（P0 0 / P1 0 / P2 1，无 blocking；行数登记建议提交前一并改正）。
