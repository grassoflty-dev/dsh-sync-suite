# mod-v2-import-v1 独立只读评审（数据丢失 / 可重跑）

- 基线：HEAD `d186118`，未提交增量 = 5 改（`Index.ets` +175、`timelineWriteStore.ets` +160、3 份 docs）+ 4 新（`importV1.ts` 1208、`importV1Service.ets` 523、`importV1Reader.ets` 64、`importV1.test.mjs` 674/32 例）。任务书给的 1192/510/61/670 为近似值，实际行数已核对。
- 先读：`项目理解.md`、`DATA-CONTRACT-v2.md` §3/§5/§7/§10/§11；再读上述新文件与两份 diff。

## 1. 结论

**P0 = 0，P1 = 0，P2 = 6。可以提交**（P2 均非阻断；建议列入后续模块修复）。
三条主保障成立：`devices/**` 只读、schema 严格最后、部分运行可幂等重跑。门禁全绿。

## 2. Findings（均为 P2，非阻断）

| ID | file:line | 问题与证据 |
| --- | --- | --- |
| P2-1 | `model/importV1.ts:1133-1137`、`decideImportRefusal` | **E_PARTIAL_STATE 提前 return 短路了后续阻断检查**。部分态（timeline 日目录已存在、schema 缺失）下 `strictMode=true` + 坏行 或 空间不足 均不再触发 `E_CORRUPT_V1`/`E_NO_SPACE`，`blocks=false` 直接续跑。实测：`decideImportRefusal({timelineDayDirs:[DAY],strictMode:true,corruptRows:5,plannedBytes:1000,availableBytes:1}) → E_PARTIAL_STATE,false`。这是「重跑」路径本身，坏行被跳过进 v2（v1 原样保留且逐行报告），但严格模式承诺失真。建议：部分态改为不阻断的**独立状态消息**，阻断检查继续按序判定。 |
| P2-2 | `model/importV1.ts:932-985` vs `715-811` | **同一 (id,ts) 两版本附件不同 → 媒体计划与记录 media[] 选用不同版本**。折叠用 §4 字节裁决（胜者 = 规范行字节较大者），媒体计划却用 `latest`（`compareTs>0`，并列取先到者）。实测：两行同 ts，body `aaa`+sha `ab…` / body `zzz`+sha `cd…` → 记录胜者 `zzz`、media[].sha16=`cdcd…`，但写入计划文件=`abab…jpg`。记录指向的图不会被本次写入；`cd` 内容仍在 v1 zip（media 迁移模块可补救），属媒体索引错配而非记录丢失。建议媒体来源改用 `foldDay` 的胜者行。 |
| P2-3 | `services/importV1Service.ets:460-482`、`services/timelineWriteStore.ets:257-264` | **门禁声明不实**。store 注释称「门禁（schema + 分支 + HEAD）仍由迁移服务在计划阶段与落标记前显式判定」，但服务只 `readSchemaVersion()`（仅用于 E_ALREADY_MIGRATED / isMigratedNow），全文件无 `assertWritable` / 分支 / HEAD 检查（grep 仅命中注释与 `migrationAvailableBytes`）。§11 例外仅豁免标记写入动作。建议：要么补 branch=main / HEAD==origin/main 断言，要么改注释为「迁移为 bootstrap，分支门禁由调用方保证」。 |
| P2-4 | `model/importV1.ts:1128`、`services/importV1Service.ets:177-183` | **未知 schemaVersion 标记会被覆盖**。仅 `===2` 判 E_ALREADY_MIGRATED；schema=99 时 `decideImportRefusal → null`（实测），apply 最后 `migrationWriteSchema` 原子覆盖标记为 2。§10 要求「标记存在但版本不认识 → 只读 E_SCHEMA_UNKNOWN，零写入」。建议：schema 标记存在且 ≠2 → 阻断并报未知版本。记录字节本身不被删除，但标记被静默降级。 |
| P2-5 | `model/importV1.ts:458-483`、`965-983` | **畸形附件引用与 sha16 前缀碰撞被静默丢弃**。附件缺合法 sha256 / entry / `.zip` 后缀时 `continue` 且无 `skipReasons`；同日两个不同完整 sha 共享前 16 位时按 file 名去重，第二个不写、也不报 `E_MEDIA_SHA16_COLLISION`（§5 / §14 开放项 1）。v1 源数据不丢，但 v2 媒体索引缺项/错指。建议逐条上报跳过原因并延长前缀至唯一。 |
| P2-6 | `services/importV1Service.ets:121-149`、`services/timelineWriteStore.ets:275-291` | **事后校验与空间探测口径不完整**。§10 要求「写完回读、重新规范化后比对字节与 sha256、核对记录总数无丢失并产出报告」；实际 `atomicWriteIn`/`migrationWriteMedia` 只校验「落盘字节 == 生成文本/tmp sha」，未做全局记录数复算报告；`migrationAvailableBytes()` 读 `stat.space`（其是否为可用空间在本运行时 `unverified`），若为总容量则 E_NO_SPACE 几乎不触发——文案自称「当前可用」属 best-effort 估计，需在报告明确。 |

## 3. 数据丢失分析（逐路径枚举）

**可能丢记录的每条路径及为何不会（或在何条件下会）**：
1. 坏 v1 行：`parseV1RecordLine:431-514` 返回中文原因；宽松模式跳过并写入 `skipReasons` / `summarizePlan:1098-1115` 逐行可见（契约 §3 fail-soft）；严格模式 `E_CORRUPT_V1` 阻断。**例外**：P2-1 的部分态严格模式短路 → 坏行被跳过（已上报，v1 原样保留）。
2. 墓碑胜出：`foldDay:792-797` 物理移除版本行 + 写 `deleted.jsonl`（§10 step 5），是删除意图而非丢失；败者版本按 later-ts 折叠（§4）。
3. 同 ts 字节裁决败者：`addConflict:826-835` 原样进 `conflicts.jsonl`，按 `(id,ts,dedupeKey)` 去重（§4 P0-1），不丢。
4. 已有 v2 更晚版本：`foldDay:782-791` 保留既有版本、丢弃 v1 旧版本；v2 编辑不被覆盖，v1 源文件不动。
5. 已存在但 v1 无的 id：`foldDay:812-816` 原样保留进 remain（断点续跑不删）。
6. 坏的日目录 / 坏已有日文件：`readExistingDays:282-284` 整日跳过，不把不可信字节当已有记录；重跑从 v1 重建并原子覆盖。
7. 附件缺失（zip 条目不存在）：`planV1Import:973-977` 记 `mediaMissing` + 原因，记录仍迁移（§5 P1-5 / `媒体待迁移` 占位），不丢记录。
8. 汇总旧 / 相等：`planV1Import:988-996` newer-wins，保留现有字节（§8）。
9. 跨日同 id：`rowsByDay` 按文件名日期分组，无跨日检测；v1 合法数据不应出现，若出现会生成两条记录（重复而非丢失）——契约 §6 判 E_CORRUPT，迁移侧未覆盖（P3/未测）。

**可能重复的路径及为何不会**：日文件按 id 分组每 id 仅 1 个胜者（`:723-811`）；账本 `addLedgerLine:838-851` 整行去重 + `appendLedgerLine:579-595` 再按 `(id,ts)` 去重且旧字节为严格前缀；媒体同日按 sha16 去重（`:966-971`）+ sink 只增不覆盖（`timelineWriteStore:330-380`）；重跑幂等由测试 #26/#27/#28 证实。

## 4. schema-last 证明

`nextWriteSteps:1084-1095` 对每天按 `records → summary → media → ledgers` 入表，循环后仅一次 `{kind:'schema'}` 收尾。`applyV1Plan:1157-1203` 顺序执行；`writeSchema` 唯一调用点 `:1166`（`step.kind==='schema'`）；`migrationWriteSchema` 全仓唯一被调用处为 `importV1Service.ets:448`（sink 回调）。grep 确认无第二处 schema 写。测试 #22 断言步骤数组末项为 schema；#24 在 ledgers 注入失败 → schema 不存在、records 已落；#25 从该中断点重跑到 schema 最后落地。结论：**不存在任何先写 schema 的路径**。

## 5. 可重跑性证明

部分运行（无 schema）→ `decideImportRefusal` 返回 `E_PARTIAL_STATE`（`stateCode='E_PARTIAL_MIGRATION'`，`blocks=false`，`:1118-1119/1133-1136`）→ 服务 `plan.ok=true` 继续。重读已有 timeline（`readExistingDays:270-307`）→ 按 id 合并较晚 ts / 同 ts 字节裁决（`:782-791`）、已有独有 id 保留（`:812-816`）、媒体只增（`:966-971` + store `:330-380`）、账本去重追加（`:838-851` + store `:579-595`）。测试 #25（中断续跑完成）、#26（更晚 v2 版本不被覆盖）、#27（媒体 already-present）、#28（冲突行不追加第二份）逐项证实。`E_PARTIAL_MIGRATION` 文案与实际状态一致（有 timeline 日目录且无 schema），truthful。

## 6. 拒绝码表（优先级自上而下，`decideImportRefusal:1127-1154`）

| # | code | blocks | 中文原因要点 | 下一步 |
| --- | --- | --- | --- | --- |
| 1 | E_ALREADY_MIGRATED | 是 | schemaVersion=2，无需重复迁移 | 只读体检，勿重复写 timeline |
| 2 | E_PARTIAL_STATE / E_PARTIAL_MIGRATION | 否 | 上次未完成，可继续，幂等续跑 | 点「确认迁移」，schema 最后写 |
| 3 | E_NO_V1_DATA | 是 | 未发现 devices/ 日程 | 确认仓库路径与 schedules |
| 4 | E_CORRUPT_V1 | 是 | 严格模式 N 行无法解析，未写任何文件 | 修正数据或关严格模式看逐行报告 |
| 5 | E_NO_SPACE | 是 | 预估 N 字节 > 可用 M 字节，未写任何文件 | 释放空间 / 换设备 / 重算 dry-run |

五码均有中文 reason + nextStep（测试 #17–#21）；孤立优先级正确，组合优先级见 P2-1/P2-4。E_NO_SPACE 为 best-effort（`availableBytes=null` 跳过，测试 #21），不谎称已探测。

## 7. 显式动作 / 测试质量

- UI（`Index.ets` 602-680、1732-1765、2315-2324）：横幅按钮 → `openMigrationSheet()`（只读 plan）→ 面板「确认迁移」→ `confirmMigrationPlan()` 二次对话框 → 仅 `index===1` 调 `applyMigration()`；无一键 apply；取消 / 遮罩点击只关面板（`closeMigrationSheet` 且 `!migrationBusy`），零副作用。测试 #30/#31/#32 为静态接线断言。
- 32 例是真契约检查：#06–#16 折叠/账本/汇总/媒体、#17–#21 拒绝、#22–#28 写序与幂等，坏实现会失败；#05 确定性、#23/#24 的 `snapshot(devices/)` 递归 sha256 比较整棵 v1 树（不是仅比记录）。**局限**：假 sink 写到独立 `out/` 根，devices 不变由构造+测试 #31 静态断言共同保证，未用真实 store 反证；#31 未扫 `importV1Reader.ets`（该文件经逐行阅读确无任何写 API，仅 `listNames/readText/filePath` + `devices/` 前缀白名单）。
- 缺失的数据丢失用例（建议补）：① 部分态 + 严格模式坏行应阻断（P2-1）；② 同 ts 不同附件的记录/媒体来源一致（P2-2）；③ schema=99 应拒绝（P2-4）；④ 畸形附件与 sha16 碰撞上报（P2-5）；⑤ 删除账本/恢复账本重跑去重（现仅 #28 覆盖 conflicts）；⑥ 跨日同 id 检测；⑦ 媒体写入到一半失败后续跑；⑧ 写后记录总数复算报告。
- 既有断言未削弱：本次未修改任何既有测试文件（`git diff --stat` 仅 2 个 .ets + 3 docs；4 新文件），全套件 2869 例保持。

## 8. 门禁 tail（本机复现）

```
overlay: [overlay] applied=false
tsc:     (no output, exit 0)
importV1: ℹ tests 32 / ℹ pass 32 / ℹ fail 0 / ℹ cancelled 0 / ℹ skipped 0
full:     ℹ tests 2869 / ℹ suites 324 / ℹ pass 2868 / ℹ fail 0 / ℹ cancelled 0 / ℹ skipped 1 / ℹ duration_ms 30437
validate: ✅ 全部通过：8/8 条规则（JSON5/JSON 70 个、相对 import 425 条、main 静态 import 545 条、页面 7 个、rawfile/git 2 个文件）
```
与期望一致（32/32、2869/2868/0/1、8/8、tsc 0、overlay false）。

## 9. unverified

- 真机 ArkTS 编译与设备行为（无 DevEco/SDK，`hdc list targets` 为空）；UI 流程仅静态断言 + Node 纯逻辑。
- `GitSyncService.zipList/zipRead` 在真机对 v1 zip 的只读行为、异步预取失败时的实际返回。
- `stat.space` 是否表示可用空间（P2-6）；分支 / HEAD 门禁是否由上层保证（P2-3）。
- 双端并发、媒体迁移模块（`mod-v2-media-migration`）与本模块占位文件的实际衔接。
