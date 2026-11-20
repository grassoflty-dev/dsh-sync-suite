# 模块索引（模块化自治交付）

> 本文件是「一个模块 = 一个批次 = 一个提交」纪律的唯一索引。
> 每批交付都必须更新本文件；没有登记进来的模块，视同没有交付。
> 用户离开期间由总设计师决策、Lead 统一提交，执行子代理只读/只写被指派的文件。

## 0 模块交付纪律

1. **一个模块 = 一个批次 = 一个提交**。一个提交只交付一个功能特性；两个无关的功能不许塞进同一批。
2. **模块 id 必须出现在提交 subject 的前缀**，形如 `[mod-xxxx] <模块名>: <一句话>`。没有模块前缀的提交不符合本模式。
3. **共享代码触碰必须登记**：凡是改到被多个模块共用的文件（组件、模型、测试工具），必须在本文 §2「跨模块触碰登记」写清批次/模块、文件、必须碰的原因和风险；不许悄悄混在「本模块自己的文件」里。
4. **每个模块自带三件东西**：自己的测试、自己在文档里的章节（或本文索引里指向的章节）、自己的回滚路径。三样缺一不可交付。
5. **每批都更新本文件**：新增模块要登记 id / 目的 / 状态 / 提交哈希 / 回滚方式 / 依赖 / 文档位置；状态变化、哈希补全、回滚路径修正也要同步改这里。
6. **多提交模块逆序回滚**：一个模块若由多次提交累计而成（典型如 `mod-d5-create-date` 的引入 + 收窄），回滚必须按提交时间**从新到旧**逐次 `git revert`；只回滚最后一次会把被收窄掉的行为重新放回来。
7. **能单独回滚就单独回滚**：若某提交把多个模块绑在一起（历史遗留），在回滚方式里写明「不单独回滚」以及只回滚单个模块需要的人工补救；不要把「将来再说」当作回滚路径。
8. **回滚之后必须跑一次全绿全量**（见 §4）；没有绿灯结果不许宣称回滚完成。

## 1 模块索引

| 模块 id | 一句话目的 | 状态 | 提交 | 回滚方式 | 依赖 / 被依赖 | 文档位置 |
| --- | --- | --- | --- | --- | --- | --- |
| `mod-d5-create-date` | 新建记录可选任意日期，已有记录日期固定（收窄后） | 已交付（`14b181a` 引入、`d6a6b69` 收窄） | `d6a6b69` | 回滚需**逆序**回滚两次：`git revert d6a6b69 14b181a`（注意：单独 revert `d6a6b69` 会把「改期」机制恢复回来，与产品决定相反） | 依赖 `mod-arkts-first-build`（可编译） | `docs/UX-STEPS.md` §4.4 |
| `mod-d7-month-calendar` | 首页日期条改用月视图日历并与编辑器复用同一组件 | 已交付（`14b181a`；组件名 `MonthCalendar` 由 `cec3c93` 改名） | `14b181a` | `git revert 14b181a` 会同时回滚 D5/B3-P2-1，故**不单独回滚**；如需只回滚 D7，须手工改回 `Index.DateBlock` | 依赖 `mod-arkts-first-build` | `docs/UX-STEPS.md` §4.4 |
| `mod-b3-saved-row-relax` | 首页保存行对账判据放宽为「同 id 且 ts 不早于标记」 | 已交付（`14b181a`） | `14b181a` | 同 D7：与 D5 同提交，**不单独回滚** | — | `docs/REVIEW-b4-batch.md` §4 |
| `mod-arkts-first-build` | 首次真实 ArkTS 编译修复（ActionButton 属性重名、`CalendarPicker` 撞内置→`MonthCalendar`、非法 `lineHeight`） | 已交付 `cec3c93` | `cec3c93` | **不可单独回滚**（回滚后无法编译）；如确需回滚，必须同时给出替代修法 | 被所有 app 模块依赖 | `docs/VERIFICATION.md` |
| `mod-v2-contract` | 单时间线数据契约 v2 草案（两轮：初稿 + 按评审 P0/P1 修订） | 已提交 | 77df67a | 未提交前回滚 = 删除该文件；提交后 `git revert <hash>`（纯文档） | 被 `mod-v2-migration`/`mod-v2-media-migration`/`mod-v2-dual-write-off` 依赖 | `docs/DATA-CONTRACT-v2.md`（359 行，v2-draft-2）、评审 `docs/REVIEW-v2-contract.md`（276 行，P0 2 / P1 7 / P2 11；draft-2 已全部解决 P0/P1） |
| `mod-v2-migration` | v1→v2 迁移工具（记录/摘要/删除账本；媒体另立模块） | 已提交（含评审修复） | 28b8592 | `git revert <hash>`；工具只读 v1、不删 v1 | 依赖 `mod-v2-contract`；被 `mod-v2-dual-write-off` 依赖 | `tools/migrate-v1-to-v2.mjs`（804 行）、测试 `apps/arkui-schedule/tools/test/v2Migration.test.mjs`（41 例，30→39→41）；评审 `docs/REVIEW-v2-migration-and-insert-page.md`（P0 1 / P1 4 / P2 3 已全部修复）；revert path 不变 |
| `mod-v2-read-timeline` | v2 单时间线只读解析核心（纯模型，未接线） | 已提交 | 4377b19 | `git revert <hash>`（仅 2 个新文件，未接线，零运行时影响） | 依赖 `mod-v2-contract`；被下一模块（v2 读服务接线）依赖 | `apps/arkui-schedule/entry/src/main/ets/model/timeline.ts`（779 行）、测试 `timelineRead.test.mjs`（42 例）；模块规格写在该文件头注释 |
| mod-settings-lean | 设置只留仓库地址 + 令牌（移除平台/分支/访问方式控件；引擎行为不变） | 已提交 | 4176654 | git revert <hash>（6 个文件，无 store/引擎改动） | 独立；remote-access 设置留给后续模块 | docs/REVIEW-settings-lean.mddocs/REVIEW-settings-lean.md（P0 0 / P1 1 / P2 3 已修复） |
| `mod-insert-page-count` | 修复真机「插入页 2/3 而非 2/2」：新建记录手写板草稿键串号 | 已提交（真机已验证 PASS） | 96d4435 | `git revert <hash>`（仅 `RecordEditorView.ets` + 1 个测试） | 跨模块触碰 `RecordEditorView.ets`（见 §2） | `docs/VERIFICATION.md` §14 更新段；真机 `device-accept` **15 PASS / 0 FAIL / 6 SKIP（exit 3 = 仅未覆盖）**；回归测试 `apps/arkui-schedule/tools/test/handwritingToolbar.test.mjs` |
| mod-quick-record | 首页底部快捷记录（不跳编辑页，路径 1 5→3） | 已提交 | ff1560f | git revert <hash>（4 个新增文件：2 代码 + 2 测试；Index.ets 增量，页头未动） | 依赖 mod-d5-create-date（日期语义） | docs/UX-STEPS.md §4.5；测试 quickRecord.test.mjs（16）/ quickRecordUi.test.mjs（14） |
| `mod-v2-media-migration` | v1 按天 zip → v2 `timeline/<date>/media/`（Node 内建 ZIP 读取，无新依赖） | 已提交 | 2f32752 | `git revert <hash>`（2 个新文件；不碰 devices/、不删 v1） | 依赖 `mod-v2-contract`、`mod-v2-migration`（需先有 `timeline/schema.json`） | `tools/migrate-media-v1-to-v2.mjs`（765 行）、测试 `v2MediaMigration.test.mjs`（34 例） |
| mod-v2-read-service | v2 单时间线只读服务（timelineStore），开关控制、默认 v1、不写 v2 | 已写完，已提交 | c6f2935 | git revert <hash>（2 新增 + Index.ets 14 行；默认 v1，无持久状态） | 依赖 mod-v2-read-timeline、mod-v2-contract；被 mod-v2-dual-write-off 依赖 | services/timelineStore.ets（278 行）、测试 timelineService.test.mjs（26 例） |
| mod-v2-write-service | v2 写入核心（原子替换 records.json + 追加式账本；开关关闭即抛错，默认不启用） | 已写完，已提交 | c5dc58c | git revert <hash>（3 个新文件；未接线，默认 v1） | 依赖 mod-v2-read-service、mod-v2-contract；被 mod-v2-dual-write-off 依赖 | model/timelineWrite.ts（302 行）、services/timelineWriteStore.ets（613 行）、测试 timelineWrite.test.mjs（639 行，51 例） |
| mod-v2-sync-protocol | §9/§11 同步协议核心（assertWritable 门槛 + fetch→union→replay→commit→push + outbox；不 force-push、不改写远端历史） | 已写完，已提交 | e6c202b | git revert <hash>（3 个新文件；未接线，默认 v1） | 依赖 mod-v2-write-service、mod-v2-contract；被 mod-v2-dual-write-off 依赖 | model/syncProtocol.ts（887 行）、services/syncProtocolStore.ets（642 行）、测试 syncProtocol.test.mjs（814 行，71 例） |
| mod-v2-dual-write-off | 停写 v1：schema=v2 **且**显式激活位 `timeline.v2WriteEnabled` 为真时才把 readMode 翻到 v2；七处写入经 recordWriter 分流；失败停放 outbox 并抛 typed 错 | 已写完，已提交 | 241bab5 | git revert <hash>（5 新增 + 3 UI + 3 服务编译修复；v1 数据未删） | 依赖 mod-v2-write-service、mod-v2-sync-protocol；被 export/import v2 依赖 | model/timelineMode.ts（89 行）、services/{outboxStore,recordWriter,timelineModeSwitch}.ets、测试 dualWriteOff.test.mjs（18 例） |
| mod-v2-sync-wiring | 接线 v2 同步周期（真实 GitRunner + outbox + 三态 UI）与**显式**激活开关；两库并存需显式确认 | 已写完，已提交 | 634da60 | git revert <hash>（6 新增 + 5 改 + 2 跨模块；v1 数据未删） | 依赖 mod-v2-sync-protocol、mod-v2-dual-write-off；被 mod-export-import-v2 依赖 | model/syncCycle.ts（322）、model/v2Activation.ts（74）、services/{gitRunner,syncStatusStore,v2ActivationService}.ets、测试 syncWiring.test.mjs（44 例） |
| `mod-export-import-v2` | v2 导出/导入：v2 bundle（manifest + 按天 records/summary/media）+ 五类 typed 拒绝 + 只经原子写入落地；v1 导出/导入不动 | 已写完，已提交 | 18a692e | git revert <hash>（1 新增 + 4 改；v1 未删、media add-only、不写 `devices/**`）；**须先回滚本模块，再回滚 `mod-v2-sync-wiring`，最后 `mod-v2-dual-write-off`**（见 §1.1） | 依赖 `mod-v2-sync-wiring`、`mod-v2-dual-write-off`；无下游 | `docs/REVIEW-export-import-v2.md`（评审后填）；测试 `tools/test/exportImportV2.test.mjs`（445 行，26 例） |
| `mod-runbook` | 运维手册：v1→v2 迁移、激活/关闭、按 tag 从右往左回滚、七类拒绝与 outbox 处置、激活后验收、未验证边界 | 已提交 | 9904161 | 提交前回滚 = 删除 `docs/RUNBOOK.md`；提交后 `git revert <hash>`（纯文档，另需撤销本文件 §1/§5 与 `docs/ROADMAP.md` 交接节的三处登记） | 无代码依赖（只读既有模块文档）；引用 `mod-v2-*` 模块 | `docs/RUNBOOK.md`（6 节，126 行） |
| `mod-state-summary` | 项目现状一页纸：今天做什么/默认开关、模块与哈希表、v2 默认行为、保证与不保证、未验证、下一步 | 已提交 | 2a475e0 | 提交前回滚 = 删除 `docs/STATE-OF-PROJECT.md`；提交后 `git revert <hash>`（纯文档，另需撤销本文件 §1/§5 与 `docs/ROADMAP.md` 交接节的三处登记） | 无代码依赖（只读既有模块文档）；引用 `mod-v2-*` 与 §1/§5 哈希 | `docs/STATE-OF-PROJECT.md`（6 节，一页） |
| `mod-v2-contract-tests` | 契约缺口测试（假 IO 媒体预检、shipped dedupe、R<D/摘要/maxAttempts/未知 schema/4× 推送拒绝） | 已提交 | 58caeb2 | `git revert <hash>`（仅新增 1 个测试文件） | 独立；覆盖 mod-v2-export-import-v2 / mod-v2-hardening 的已记录 P2 | `tools/test/contractGaps.test.mjs`（520 行，25 例） |
| `mod-push-detail` | 修复 `typedPushError` 丢细节：带细节的 `E_PUSH_REJECTED` 逐字保真进 message + lastError；裸码 / 非 E_ 传输错误仍折叠成通用中文文案 | 已提交（`ea7b603`，tag `module/mod-push-detail`） | ea7b603 | `git revert ea7b603`（独立叶子；只改纯模型 + 两个测试文件，不进依赖回滚链） | **独立叶子，无被依赖**；只改纯模型 + 测试，不进依赖回滚链 | `docs/REVIEW-contract-tests.md` §3（P2 缺陷）；`tools/test/contractGaps.test.mjs`（C12 修正 + C14/C15/C16，共 28 例） |
| `mod-v2-media-gc` | v2 散图垃圾回收：**默认只读**列未引用 `timeline/<date>/media/*.jpg`（按 §5/§7 可见记录口径），`--delete` 需打印的 plan hash 确认，只删计划内文件 | 已提交 | 915a416 | 提交前回滚 = 删除 2 个新增文件并撤销本文 §1/§2/§5/§6 登记；提交后 `git revert <hash>` | 依赖 `mod-v2-contract`（§5 媒体 / §7 账本语义）、`mod-v2-media-migration`（产出散图）；独立叶子、无下游，不进回滚链 | `tools/media-gc-v2.mjs`（约 400 行，模块头注明「默认只读；--delete 需 plan hash 确认」）、测试 `apps/arkui-schedule/tools/test/mediaGcV2.test.mjs`（22 例） |
| `mod-v2-doctor` | READ-ONLY 仓库体检 CLI：schema / 布局 / 每日 records / 账本 / 媒体 / v1 侧 / 冲突审计的 typed 诊断，零写入、零修复 | 已提交 | 7fc5b9f | 提交前回滚 = 删除 `tools/doctor-v2.mjs` + `apps/arkui-schedule/tools/test/doctorV2.test.mjs` 两个新增文件并撤销本文 §1/§2/§5/§6 登记；提交后 `git revert <hash>` | 独立叶子，无代码依赖、无下游，不进回滚链；只读 v1/v2 仓库布局与 `docs/DATA-CONTRACT-v2.md` §2/§3/§4/§5/§6/§7/§9/§11 | `tools/doctor-v2.mjs`（自包含、仅 `node:` 内建）、测试 `apps/arkui-schedule/tools/test/doctorV2.test.mjs`（39 例；含 `I_LEDGER_RETAINED`/`W_LEDGER_ORPHAN`/`W_MEDIA_NOT_MIGRATED` 新码；每次运行前后整棵 repo 逐字节快照相等） |
| `mod-export-v2-ledgers` | v2 bundle 增 `bundleVersion:2` + 三本按日账本（逐字节搬运 + 并集导入 + 旧 bundle note + 未来版本 typed 拒绝） | 已提交 | 25fd0f2 | 提交前回滚 = 撤销 `model/exportImport.ts` / `services/exportService.ets` / `tools/test/exportImportV2.test.mjs` 三处增量 + `docs/EXPORT-IMPORT.md` §7 + 本文 §1/§2/§5/§6 登记；提交后 `git revert <hash>`（v1 导出导入与媒体预检不变，旧 bundle 仍可导入） | 依赖 `mod-export-import-v2`（在其 v2 bundle 上追加字段，不删既有内容）；独立叶子、无下游，不进回滚链 | `docs/EXPORT-IMPORT.md` §7（bundle/version 兼容规则 verbatim）；测试 `tools/test/exportImportV2.test.mjs` |
| `mod-doctor-media-window` | 修 doctor 迁移窗口假阳性（N-1）：`media/` 不存在或为空且当日引用全缺也降为 `W_MEDIA_NOT_MIGRATED`，仅非空目录仍缺引用才 `E_MEDIA_MISSING` | 已提交 | df917ff | 提交前回滚 = 撤销 `tools/doctor-v2.mjs` 的 `checkMedia` 规则改动与 `apps/arkui-schedule/tools/test/doctorV2.test.mjs` 的测试 28/40/41 增量，并撤销本文 §1/§5/§6 登记；提交后 `git revert <hash>` | 独立叶子，无下游；在 `mod-v2-doctor` 的只读 CLI 上做语义修正，不进 v2 回滚链；只读契约 `docs/DATA-CONTRACT-v2.md` §5 | `tools/doctor-v2.mjs`（`checkMedia` ~:616-629 + 头注释）；测试 `apps/arkui-schedule/tools/test/doctorV2.test.mjs`（41 例） |

`mod-v2-dual-read` 已被 `mod-v2-dual-write-off` 取代，见契约 §13。

说明：「提交」列记的是该模块**最后一个**提交；`mod-d5-create-date` 的完整回滚要连同索引里写明的较早提交一起做。
哈希已由 Lead 于 2026-11-19 提交后回填；执行子代理不得猜测或编造哈希。
「待建」表示模块尚未开始，文档位置在交付时补上。

### 1.1 依赖图（回滚时看这里）

```
mod-v2-contract
 ├─ mod-v2-migration ─ mod-v2-media-migration
 ├─ mod-v2-read-timeline ─ mod-v2-read-service ──┐
 ├─ mod-v2-write-service ────────────────────────┼─ mod-v2-dual-write-off ─ mod-v2-sync-wiring ─ mod-export-import-v2
 └─ mod-v2-sync-protocol ────────────────────────┘
```

`mod-push-detail` 是**独立叶子**（无被依赖、无下游），不在上面的回滚链里：只改 `model/syncCycle.ts` 的 `typedPushError` 及两个测试文件（`contractGaps.test.mjs` / `syncWiring.test.mjs`），回滚独立、不影响任何 v2 模块。

`mod-v2-media-gc` 同为**独立叶子**：离线 CLI + 测试两个新增文件，不接线、不改 app / 插件 / 写路径；不进上面的回滚链，回滚只需删这两个文件（或 `git revert <hash>`）。

`mod-v2-doctor` 也是**独立叶子**：纯只读离线 CLI + 测试两个新增文件，不接线、不改 app / 插件 / 任何写路径，也不创建临时文件；不进上面的回滚链，回滚只需删这两个文件（或 `git revert <hash>`）。它与 `mod-v2-media-gc` 互不依赖：前者只观察、后者可删除，二者可各自单独回滚。

回滚必须从右往左（先回滚依赖方）；单独回滚 `mod-v2-read-service` 而保留 `mod-v2-dual-write-off` 会让已迁移仓库没有读取方（见 ROADMAP 的排序风险）。`mod-v2-sync-wiring` 是激活环节，**单独回滚它只让应用回到「v2 写入未激活」状态（安全，v1 数据未删）**；但若先回滚 `mod-v2-dual-write-off` 而保留 sync-wiring，接线会悬空（`runCycle`/激活闸失去分流基础），故二者必须按此顺序回滚。新增 `mod-export-import-v2` 位于依赖链最右端（依赖 sync-wiring）；**回滚顺序固定为：先回滚 `mod-export-import-v2`（导出/导入），再回滚 `mod-v2-sync-wiring`，最后回滚 `mod-v2-dual-write-off`**，不可颠倒——先回滚下游会让仍在线的导出/导入失去分流基础。

## 2 跨模块触碰登记

> 共享文件不属于任何单一模块。改到这里必须在对应批次里登记，并提醒该文件的其他owner串行改。

| 批次/模块 | 触碰的共享文件 | 为什么必须碰 | 风险 |
| --- | --- | --- | --- |
| `mod-arkts-first-build`（`cec3c93`） | 21 个 `.ets` + 6 个测试文件 | 首次真实 ArkTS 编译暴露的硬错误是全仓性的：ActionButton 属性重名、`CalendarPicker` 撞内置类型（改为 `MonthCalendar`）、非法 `lineHeight` 调用；只能通过属性/方法/结构名的全局改名与调用点修正解决 | 跨全仓改名，任何一处漏改都会再次编译失败；这些文件被所有 app 模块共用，并行改动必须串行并在提交后重跑全量门闸 |
| `mod-d5-create-date`（`d6a6b69`） | `components/RecordEditorView.ets` | 收窄后编辑器保存路径改走 `resolveSaveTs`，日期行对已有记录只读且仅在新建时展开 `CalendarPicker`，必须改这个共享组件本身 | 同一文件还承载 D7 的日历接线与 B3 的一次性保存标记；与 `mod-d7-month-calendar` 共写，撞文件必须串行、不可双人同时改 |
| `mod-insert-page-count` | `components/RecordEditorView.ets` | 修复真机插入页串号：新增 `writingDraftKey()`（新建记录按编辑器实例生成 `new-<timestamp>` 草稿键）并新增路由参数 `draftKey`，必须改这个共享组件本身 | 同一文件也被 `mod-d5-create-date`/`mod-d7-month-calendar` 触碰，必须串行、不可双人同时改 |
| `mod-v2-read-timeline` | 无共享文件（全部新增） | 纯模型 `model/timeline.ts` 与测试 `tools/test/timelineRead.test.mjs` 均为新增，未改 `.ets`/service/UI/写路径，未触碰任何被其他模块共用的文件 | 无跨模块撞文件风险；未接线、零运行时影响；回滚 = 提交后 `git revert <hash>`（未提交前删除这两个新增文件） |
| `mod-v2-migration`（含评审修复） | 无共享文件（全部新增） | 迁移工具 `tools/migrate-v1-to-v2.mjs` 与测试 `apps/arkui-schedule/tools/test/v2Migration.test.mjs` 均为新增文件，评审修复也只改这两个文件，未触碰任何被其他模块共用的文件 | 无跨模块撞文件风险；回滚 = 提交后 `git revert <hash>`（未提交前删除这两个新增文件），不影响其他模块 |
| `mod-settings-lean` | `pages/Settings.ets` + `components/settings/SyncSection.ets` | 设置主表单精简为「仓库地址 + 令牌」，需移除平台/分支/访问方式控件并改同步区组件，必须改设置页及其同步区组件本身 | 设置页是共享文件，与 D1-P2/D6 锚点同文件，必须串行；本次未改锚点与组顺序 |
| `mod-quick-record` | `pages/Index.ets`（:48–49 / :60 / :75 imports、:137–138 `@State quickBusy`、:494–541 `defaultAuthorOrMe` + `submitQuickRecord`、:1220–1227 `@Builder QuickRecordRow()`、:1722 `CompactBody`、:1756 `WideBody`） | 首页底部快捷记录条要在列表区加一行 + 一个 builder + 一个 submit 方法，必须改首页本身；日期语义复用 `mod-d5-create-date` 的 `tsForDate` | 只加列表区一行 + 一个 builder + 一个 submit 方法；`PageLayout`/页头、`DateBlock`（D7）、`onPageShow` 保存标记消费（B3）**均未触碰**；与 `mod-d7-month-calendar`（`Index.DateBlock`）和 `mod-d5-create-date`（编辑页）串行 |
| `mod-v2-media-migration` | 无共享文件（全部新增） | 迁移工具 `tools/migrate-media-v1-to-v2.mjs` 与测试 `apps/arkui-schedule/tools/test/v2MediaMigration.test.mjs` 均为新增文件，未触碰任何被其他模块共用的文件 | 无跨模块撞文件风险；回滚 = 提交后 `git revert <hash>`（未提交前删除这两个新增文件），v1 zip 不删不改，不影响其他模块 |
| `mod-v2-media-gc` | 无共享文件（全部新增） | 工具 `tools/media-gc-v2.mjs` 与测试 `apps/arkui-schedule/tools/test/mediaGcV2.test.mjs` 均为新增，未改 app / 插件 / 任何既有 `.ets`、服务或写路径 | 无跨模块撞文件风险；回滚 = 提交后 `git revert <hash>`（未提交前删除这两个新增文件），默认只读、删除需显式 planHash 确认，不影响任何 v2 模块 |
| `mod-v2-doctor` | 无共享文件（全部新增） | 工具 `tools/doctor-v2.mjs` 与测试 `apps/arkui-schedule/tools/test/doctorV2.test.mjs` 均为新增，未改 app / 插件 / 任何既有 `.ets`、服务或写路径；工具只用 `node:fs` 的 exists/stat/readdir/read 四类只读 API | 无跨模块撞文件风险；回滚 = 提交后 `git revert <hash>`（未提交前删除这两个新增文件），工具绝不写盘、不做修复、不建 tmp，不影响任何 v2 模块 |
| `mod-v2-read-service` | `pages/Index.ets`（:62 import、:349–350 bootstrap `ensureReady`、:375–385 `reload` 的 useV2 分支） | v2 只读服务接线：首页引入 timelineStore、启动时 `ensureReady`、`reload` 增加 `useV2` 只读分支，必须改首页本身；未触碰 `DateBlock`(D7)、`onPageShow`/`reconcileSavedRow` 保存标记消费(B3)、quick-record 的 submit | 同文件还承载 `mod-d7-month-calendar` / `mod-b3-saved-row-relax` / `mod-quick-record` 的接线，撞文件必须串行、不可双人同时改；默认 `timeline.readMode='v1'` 使 v2 分支惰性，无 timeline/ → v1 原路，v2 路径不写、不碰 `openIndexStore` |
| `mod-v2-write-service` | 无共享文件（全部新增，未接线） | 纯写入核心 `model/timelineWrite.ts`、flag-gated 服务 `services/timelineWriteStore.ets` 与测试 `tools/test/timelineWrite.test.mjs` 均为新增；未改任何既有 `.ets`/service/UI/写路径，不写 `AppStorage`、不写 `devices/**`；开关 `timelineStore.useV2()` 默认 `'v1'` 且无人翻转，零运行时影响 | 无跨模块撞文件风险；回滚 = 提交后 `git revert <hash>`（未提交前删除这三个新增文件），默认 v1、零运行时影响 |
| `mod-v2-sync-protocol` | 无共享文件（全部新增，未接线） | 同步协议核心 `model/syncProtocol.ts`（纯逻辑）、flag-gated 服务 `services/syncProtocolStore.ets` 与测试 `tools/test/syncProtocol.test.mjs` 均为新增；未改任何既有 `.ets`/service/UI/写路径；outbox 落在 `<filesDir>/sync-outbox.json`（`git-repo/` 之外），未接线、零运行时影响 | 无跨模块撞文件风险；回滚 = 提交后 `git revert <hash>`（未提交前删除这三个新增文件），默认 v1、零运行时影响；不 force-push、不改写远端历史 |
| `mod-v2-dual-write-off` | `pages/Index.ets`（:63-64 imports、:357-365 bootstrap、:556/:834/:934/:966/:1105 写入）、`components/RecordEditorView.ets`（:42 import、:665）、`components/RecordDetailView.ets`（:20 import、:194） | 停写 v1 必须把七处写调用点改经 `recordWriter` 分流，并在启动时按 `timeline/schema.json` 的 schemaVersion 翻转 `timeline.readMode`，因此必须改首页与编辑/详情组件本身 | 与 D5/D7/B3/quick-record 同文件，串行 |
| `mod-v2-dual-write-off`（ArkTS 编译修复） | `services/timelineStore.ets`、`services/timelineWriteStore.ets`、`services/syncProtocolStore.ets` | 真机 ArkTS 严格类型编译暴露的硬错误（typed interface 化、去掉 `unknown`/`in`、`writeTextSync`→`writeTextToFile` 助手），不改这三个服务无法编译通过 | 这三处属于 read-service / write-service / sync-protocol 模块，单独回滚那些模块前必须先回滚本模块 |
| `mod-v2-sync-wiring` | `pages/Index.ets` / `pages/Settings.ets` / `components/settings/SyncSection.ets` | 三态同步状态行（已同步 / N 条待同步 / 只读）要显示在首页，显式激活开关与两库并存专用确认对话框要落在设置页及其同步区组件，必须改这三个文件本身 | 与 D1-P2/D6/settings-lean 同文件（Index/Settings/SyncSection），撞文件必须串行、不可双人同时改 |
| `mod-v2-sync-wiring`（跨模块） | `services/GitSyncService.ets` + `resources/rawfile/git/git-bridge.js` | 真实同步周期需要一个 git runner 执行 fetch→union→commit→push：在 `GitSyncService` 增 `v2Git()`，并在共享 git 桥 `git-bridge.js` 增 `opV2Git`（isomorphic-git 1.25.3，`force:false`，`fastForwardOnly:true`） | git 桥属于多模块共享设施，回滚本模块前不得回滚桥；跨模块触碰，与其他用户串行 |
| `mod-export-import-v2` | `pages/Settings.ets` / `components/settings/DataSection.ets` / `components/ExportImportPanel.ets` / `services/exportService.ets` / `model/exportImport.ts` | v2 导出/导入的 UI 走 Settings → DataSection → panel 的 flag-gated（`useV2()`）接线，导出/导入逻辑复用 `exportService` / `exportImport` 模型并追加 v2 helper，必须改这五个共享文件本身；section 无「尚未接入」文案、拒绝时显示 typed 错误行 | 这五个文件同时被 `mod-settings-lean`、D4（导出区间 chip）、D6（设置页组锚点）触碰，撞文件**必须串行、不可双人同时改**；v1 导出/导入行为与 `exportImport.test.mjs`（69 例）不变，两导出测试文件共 110 例 |
| `mod-export-v2-ledgers` | `model/exportImport.ts` / `services/exportService.ets` / `tools/test/exportImportV2.test.mjs` | 在 v2 bundle 上追加 `bundleVersion` 与三本按日账本：manifest/校验/并集合并/拒绝类型全部落在纯模型，文件 IO 落在服务层，测试文件为本模块自带；三文件均已被 `mod-export-import-v2` 触碰，必须改同一文件 | 与 `mod-export-import-v2` 共写三文件，撞文件必须串行；只做 additive 追加，v1 导出/导入与已交付的媒体 sha256 预检字节不变，旧 bundle（缺字段/1）仍可导入 |

## 3 提交与标签约定

- **subject 格式**：`[mod-<id>] <模块名>: <一句话>`。例：`[mod-d5-create-date] 新建记录可选日期: 已有记录日期固定，移除改期路径`。模块 id 必须是 §1 索引里的真实 id。
- **body 必写两样**：① 本批次改动的**文件清单**（含跨模块触碰的文件，并标注 §2 登记）；② 跑过的**门闸**及结果（见 §4，贴命令与关键输出，不要只写「通过」）。
- **一个模块一个提交**；回滚提交同样带模块 id 前缀，例如 `[mod-d5-create-date] revert: 逐次回滚收窄与引入`。
- **可选 git tag**：标签名 `mod-<id>`，只在该模块稳定后打；标签不是提交门槛，没打标签不影响模块已交付的认定。
- **权限**：只有 Lead 提交与打标签；总设计师与执行子代理一律不 commit、不 push、不改 `.git`，也不改 DSH profile。

## 4 回滚演练清单

回滚不是「跑一条 `git revert`」，而是一次要走完门闸的小交付。按 §1 登记的回滚方式执行，并逐项打勾：

1. **确认回滚边界**：回读本文 §1 的回滚方式与 §2 的跨模块触碰登记；若该模块由多次提交累计，按提交时间**从新到旧逆序** revert（D5 的写法见 §1）。若登记为「不单独回滚」，先准备好该条里写明的人工补救，否则不许开始。
2. **执行 revert**：一次只回滚一个模块；同一提交捆绑多个模块时，按登记的补救方案处理，不拿 `git revert <hash>` 一把梭。
3. **跑门闸并记录原始输出**（工作目录 `dsh-sync-suite`）：
   - `node tools/overlay.mjs status` → 期望 `applied=false`；
   - `node --test "packages/dsh-dots/test/*.test.mjs" "apps/arkui-schedule/tools/test/*.test.mjs"` → 当前基线 **2848 例 / 2847 pass / 0 fail / 1 skip**（最终状态：+22 `mod-v2-media-gc` / +35 `mod-v2-doctor` / +13 `mod-export-v2-ledgers` / +4 doctor 评审修复；此前 +3 = `mod-push-detail` 的 `contractGaps.test.mjs` C14/C15/C16，contractGaps 28/28；相对 2771 的 +25 = `mod-v2-contract-tests`；此前 +26 = `mod-export-import-v2` 的 `exportImportV2.test.mjs` 26；相对 2670 基线的 **+44 = `mod-v2-sync-wiring` 的 `syncWiring.test.mjs` 44**；相对 2607 基线的 **+18 = `mod-v2-dual-write-off` 的 `dualWriteOff.test.mjs` 18**；相对 2536 基线的 **+56 = `mod-v2-sync-protocol` 的 `syncProtocol.test.mjs` 56**；相对 2485 基线的 **+51 = `mod-v2-write-service` 的 `timelineWrite.test.mjs` 32**；相对 2459 基线的 **+23 = `mod-v2-read-service` 的 `timelineService.test.mjs` 23**；相对 2425 基线的 **+34 = `mod-v2-media-migration` 的 `v2MediaMigration.test.mjs` 31**；相对 2391 基线的 **+30 = `mod-quick-record` 的 `quickRecord.test.mjs` 16 + `quickRecordUi.test.mjs` 14**；`mod-settings-lean` 原地改测 4 个既有测试文件、用例数不变，delta 0，基线不动；相对 2348 基线：`mod-v2-read-timeline` **+42**；再往前相对 2306 基线：`mod-v2-migration` **+39 = +30 初版 +9 评审修复**、`mod-insert-page-count` **+1**；`cec3c93` 之后；数字随模块加入而变动；回滚 D5 相关模块时，因删除的旧用例被恢复，数字会变化，须在批次记录里写明变化原因）；
   - `node apps/arkui-schedule/tools/validate-app.mjs` → **8/8**；
   - `node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json` → **exit 0**。
4. **判定「回滚干净」**：0 fail、skip 数未异常增加、8/8、tsc exit 0、`overlay applied=false` 五项同时成立；任何一项不满足即为未回滚干净，不许在 §1 把状态改回「已回滚」。
5. **必做收尾**：回滚之后**必须再跑一次全绿全量**（第 3 步的完整命令），把原始输出尾部贴进批次汇报；没有这次绿灯，回滚不算完成。
6. **回填本文件**：把该模块状态改为「已回滚」，在「提交」列记下 revert 提交哈希（Lead 提交后填），并在 §2 标注哪些跨模块触碰被一并撤销、哪些仍需人工清理。

> 真机相关项（`device-accept.mjs` 等）的详情见 `docs/VERIFICATION.md`；本清单只负责可复现的本地门闸与「回滚后全量必须全绿」这条硬规则。

## 5 批次记录

> 追加式（append-only）：每批交付在表尾加一行，不改写历史行。本表各行的提交哈希已于 2026-11-19 由 Lead 提交后回填。

| 日期 | 模块 | 结果 | 门闸 | 评审 | 备注 |
| --- | --- | --- | --- | --- | --- |
| 2026-11-19 | `mod-doc-verify` | 已提交 | 首次真机全链路：编译 / 签名 / 安装 / 启动 / `device-accept`（详见 `docs/VERIFICATION.md` §14） | — | `docs/VERIFICATION.md` §14（首次真机全链路）；提交：5a1cd91 |
| 2026-11-19 | `mod-module-doctrine` | 已提交 | 文档一致性回读（无代码门闸） | — | `docs/MODULES.md` + `docs/ROADMAP.md` + `项目理解.md` §7；提交：a95ecaa |
| 2026-11-19 | `mod-v2-contract` | 已提交（draft-2） | 文档门闸（无代码门闸；359 行） | `docs/REVIEW-v2-contract.md`（276 行，P0 2 / P1 7 / P2 11；draft-2 已全部解决 P0/P1） | `docs/DATA-CONTRACT-v2.md`（359 行，v2-draft-2）；提交：77df67a |
| 2026-11-19 | `mod-v2-migration` + `mod-insert-page-count` | 已提交（含评审修复） | 全量 **2348 / 2347 / 0 / 1**；`validate-app` 8/8；`tsc` exit 0；`overlay applied=false`；真机 `device-accept` **15 PASS / 0 FAIL / 6 SKIP（exit 3 = 仅未覆盖）** | `docs/REVIEW-v2-migration-and-insert-page.md`（304 行，P0 1 / P1 4 / P2 3 已全部修复） | 迁移 **41 例**（30→39，含 +9 评审修复）/ 真机 **15P0F6S**；两个模块各自一笔提交，提交：28b8592 / 96d4435 |
| 2026-11-19 | mod-v2-read-timeline | 已提交 | 全量 2386/2385/0/1；validate 8/8；tsc 0 | docs/REVIEW-v2-read-timeline.md（P0 0 / P1 2 / P2 5 已修复） | 未接线，零运行时影响 |
| 2026-11-19 | `mod-settings-lean` | 已提交 | 全量 2391/2390/0/1（+1）；validate 8/8；tsc 0 | docs/REVIEW-settings-lean.md（P0 0 / P1 1 / P2 3 已修复） | 主表单=仓库地址+令牌；平台/分支/访问方式控件移除 |
| 2026-11-19 | mod-quick-record | 已提交 | 全量 2421/2420/0/1；validate 8/8；tsc 0 | （评审后填） | 路径 1 5→3；页头零改动 |
| 2026-11-20 | mod-v2-media-migration | 已提交 | 全量 2456/2455/0/1；validate 8/8；tsc 0 | （评审后填） | 无新依赖；v1 zip 不删不改；ZIP64/加密拒绝 |
| 2026-11-20 | mod-v2-read-service | 已完成，已提交 | 全量 2482/2481/0/1；validate 8/8；tsc 0 | （评审后填） | 开关 timeline.readMode 默认 v1；无 timeline/ → v1 原路；v2 读不写 |
| 2026-11-20 | mod-v2-write-service | 已完成，已提交 | 全量 2517/2516/0/1；validate 8/8；tsc 0 | （评审后填） | 关闭即抛错、无 IO；原子替换 + 追加账本；未接线；后续 `mod-v2-dual-write-off` 需路由的 v1 写调用点：`pages/Index.ets:544/822/918/950/1093`、`components/RecordEditorView.ets:663`、`components/RecordDetailView.ets:193`、`services/exportService.ets:456`、`services/summaryStore.ets`（RepoSummaryIO 写入）、`model/undoDelete.ts` `schedule()`、插件 `packages/dsh-dots` `bridge.ts` `ScheduleBridge.add` 及其余 `schedule_*` |
| 2026-11-20 | mod-v2-sync-protocol | 已完成，已提交 | 全量 2592/2591/0/1；validate 8/8；tsc 0 | （评审后填） | 门槛= schema v2 + main + HEAD==origin/main；拒绝即零写入；不 force-push |
| 2026-11-20 | mod-v2-dual-write-off | 已完成，已提交 | 全量 2626/2625/0/1；validate 8/8；tsc 0；真机 BUILD SUCCESSFUL + 安装启动通过 | （评审后填） | 翻转条件=schema v2 + 显式激活（默认未激活，F1 同步周期未接线）；失败停放 outbox；v1 未删 |
| 2026-11-20 | mod-v2-sync-wiring | 已完成，已提交 | 全量 2670/2669/0/1；validate 8/8；tsc 0；真机 BUILD SUCCESSFUL + 安装启动，三态行可见 | （评审后填） | 显式激活；两库并存需确认；不 force-push |
| 2026-11-20 | `mod-export-import-v2` | 已完成，已提交 | 全量 **2711/2710/0/1（+26）**；validate-app 8/8；tsc 0；真机 `BUILD SUCCESSFUL in 4 s 653 ms`（✓ 产物验收通过） | `docs/REVIEW-export-import-v2.md`（评审后填） | v2 导出/导入 + 五类 typed 拒绝（`E_SCHEMA_UNKNOWN`/`E_BUNDLE_CORRUPT`/`E_MEDIA_MISSING`/`E_V1_TARGET`/`E_TARGET_BUSY`）；dry-run 默认、显式确认、只经原子写入、media add-only、不写 `devices/**`；v1 未删（`exportImport.test.mjs` 69 例未改，两导出测试文件共 110 例）；真机未验（无设备连接） |
| 2026-11-20 | `mod-runbook` | 已完成并提交 | 文档门闸（无代码门闸；`docs/RUNBOOK.md` 6 节 220 行） | — | 运维手册：迁移 / 激活关闭 / 按 `module/mod-*` tag 右→左回滚 / 七类拒绝与 outbox 处置 / 激活后验收 / 未验证边界；§1 与 ROADMAP 交接节各加一行登记；提交：9904161 |
| 2026-11-20 | `mod-state-summary` | 已完成并提交 | 文档门闸（无代码门闸；`docs/STATE-OF-PROJECT.md` 6 节，一页） | — | 一页现状：默认 v1 / v2 显式激活 / 模块与哈希（含 `1b79790`/`1447b0f`/`9904161`/`c41c3c5`）/ 保证与不保证 / unverified / 下一步；§1 与 ROADMAP 交接节各加一行登记；提交：2a475e0 |

| 2026-11-20 | `mod-v2-contract-tests` | 已提交 | 全量 2771/2770/0/1；validate 8/8；tsc 0 | `docs/REVIEW-contract-tests.md`（P1 登记已补，P2 记录） | 契约缺口 25 例；发现 typedPushError 细节丢失（P2，未修） |
| 2026-11-20 | `mod-push-detail` | 已提交 | 全量 **2774/2773/0/1**（+3，contractGaps **28/28**）；validate 8/8；tsc 0 | `docs/REVIEW-contract-tests.md` §3（P2 缺陷已修）；`syncWiring.test.mjs` 旧断言同步更新 | 闭合上一行记录的 P2：带细节的 `E_PUSH_REJECTED` 逐字保真进 message + lastError；C12 保真断言不再恒真 + C14/C15/C16；裸码 / 非 E_ 传输错误仍通用 |
| 2026-11-20 | `mod-v2-media-gc` | 已提交 | 全量 **2796/2795/0/1**（+22 = `mediaGcV2.test.mjs` 22/22）；`validate-app` 8/8；`tsc` exit 0；`--repo <本仓>` 只读 no-op exit 0 | （评审后填） | 默认只读、零写入；planHash = sha256(排序路径列表以 `\n` 相连 + 尾换行) 前 12 位；`--delete` 缺/错 token 或空计划 → exit 2 + 零写入；只 unlink 计划内 `timeline/*/media/*.jpg`，逐条记日志，不碰 devices/、账本、记录；提交哈希915a416 |
| 2026-11-20 | `mod-v2-doctor` | 已提交 | 全量 **2848/2847/0/1**（+4 = 评审修复新增 4 例；`doctorV2.test.mjs` 39/39）；`validate-app` 8/8；`tsc` exit 0；`--repo <本仓>` 只读 v1 no-op exit 0 | （评审后填） | READ-ONLY 体检：schema / 布局 / records / 账本 / 媒体 / v1 侧 / 冲突审计的 typed code；评审修复后新增 `I_LEDGER_RETAINED`(info，已删清行后保留账本) / `W_LEDGER_ORPHAN`(warning，无佐证孤儿账本) / `W_MEDIA_NOT_MIGRATED`(warning，媒体迁移未运行)，三者均不计入 problems / 不 exit 2；`E_MEDIA_MISSING` 仅保留于 media/ 目录存在但文件缺失；`perDay[].conflicts` 按 conflicts.jsonl 行数计；四套临时仓库（v1-only / v2-only / mixed / corrupt），39 例每次运行前后整棵 repo 逐字节快照相等；只 `node:` 内建、无 tmp、无修复；提交哈希7fc5b9f |
| 2026-11-20 | `mod-export-v2-ledgers` | 已提交 | 全量 / 导出两文件 / `validate-app` / `tsc` 结果见本模块批次汇报与 `docs/EXPORT-IMPORT.md` §7.2；v1 导出测试 84 例不动 | （评审后填） | v2 bundle 追加 `bundleVersion:2` + 三本按日账本逐字节搬运；旧 bundle 缺字段/1 不拒绝且返回 informational note；并集导入按 (id,ts)/(id,ts,dedupeKey) 去重、目标字节不截断；未来版本 `E_BUNDLE_VERSION` typed 拒绝；提交哈希25fd0f2 |

| 2026-11-20 | `mod-doctor-media-window` | 已提交（哈希由 Lead 回填） | 全量 **2850/2849/0/1**（+2 = `doctorV2.test.mjs` 41/41）；`validate-app` 8/8；`tsc` exit 0；`--repo <本仓>` 只读 no-op exit 0 | （评审后填） | 闭合 `REVIEW-hardening.md` §复审 N-1：`media/` 不存在或为空且当日引用媒体全缺 → `W_MEDIA_NOT_MIGRATED` warning/exit 0；非空 `media/` 仍缺引用 → `E_MEDIA_MISSING` error/exit 2；`E_MEDIA_NAME`/`E_MEDIA_COLLISION`/`W_MEDIA_UNREFERENCED` 不变；测试 28 由「空目录缺文件=error」调整为「已填充目录缺文件=error」，新增 40（空目录全缺）/41（部分到位） |

## 6. 追加批次（2026-11-20 之后，Lead 提交时登记）

| 模块 | 内容 | 状态 | 提交 | 回滚 |
| --- | --- | --- | --- | --- |
| mod-v2-hardening | 双设备收敛模拟 26 例；并修出 syncProtocol.ts 重放决胜的顺序依赖（真 P1） | 已提交 | 1447b0f | git revert 1447b0f（与 mod-v2-sync-protocol 同链，逆序回滚） |
| mod-export-import-v2（修复批次） | 导入媒体 sha256 完整性 preflight（E_MEDIA_CORRUPT）、sha16 撞名拒绝（E_MEDIA_COLLISION）、删死路径 V2_NOT_WIRED | 已提交 | 1b79790 | git revert 1b79790（纯增量） |
| mod-runbook | docs/RUNBOOK.md 运维手册（迁移/激活/按 tag 逆序回滚/故障处置/验收/unverified 边界） | 已提交 | 9904161 | git revert 9904161（纯文档） |
| mod-push-detail | 修 `typedPushError` 丢细节（P2）：带细节的 `E_PUSH_REJECTED` 逐字保真进 message + lastError；C12 改非空断言 + C14/C15/C16 | 已提交（tag `module/mod-push-detail`） | ea7b603 | `git revert ea7b603`（叶子，无下游） |

> 三批的独立只读评审见 docs/REVIEW-three-batches.md（A/B/C 均判「可以提交」，P0 0）。

> 追加登记：mod-v2-contract-tests = 58caeb2（仅测试，25 例）；mod-state-summary = 2a475e0（文档）；两批评审见 docs/REVIEW-contract-tests.md（A 判可以提交 P1 已修、B 判可以提交）。

> 追加登记：mod-push-detail = ea7b603（推送被拒保留原始细节；评审 GO，P0 0 / P1 0 / P2 3）。

| mod-v2-media-gc | 默认只读散图 GC：列未引用 `timeline/*/media/*.jpg` + planHash；`--delete` 需 planHash 确认，只删计划内文件并逐条记日志 | 已提交 | 915a416 | 提交前回滚 = 删除 `tools/media-gc-v2.mjs` + `apps/arkui-schedule/tools/test/mediaGcV2.test.mjs` 并撤销 §1/§2/§5 登记；提交后 `git revert <hash>`（独立叶子，无下游） |
| mod-v2-doctor | READ-ONLY 仓库体检 CLI：typed code + 中文原因/下一步，v1/v2/mixed/corrupt 四套夹具，零写入 | 已提交 | 7fc5b9f | 提交前回滚 = 删除 `tools/doctor-v2.mjs` + `apps/arkui-schedule/tools/test/doctorV2.test.mjs` 并撤销 §1/§2/§5 登记；提交后 `git revert <hash>`（独立叶子，无下游） |
| mod-export-v2-ledgers | v2 bundle 加 `bundleVersion:2` 与三本按日账本（逐字节搬运 / 并集去重 / 旧 bundle note / 未来版本 typed 拒绝），旧 bundle 仍可导入 | 已提交 | 25fd0f2 | 提交前回滚 = 撤销 `model/exportImport.ts` / `services/exportService.ets` / `tools/test/exportImportV2.test.mjs` 三处增量 + `docs/EXPORT-IMPORT.md` §7 + 本文 §1/§2/§5/§6 登记；提交后 `git revert <hash>`（独立叶子，无下游，不进 v2 回滚链） |
| mod-doctor-media-window | 修 doctor 迁移窗口假阳性（N-1）：`media/` 不存在或为空且当日引用全缺 → `W_MEDIA_NOT_MIGRATED` warning/exit 0；非空 `media/` 仍缺引用 → `E_MEDIA_MISSING` error/exit 2；其余 media code 不变 | 已提交 | df917ff | 提交前回滚 = 撤销 `tools/doctor-v2.mjs` 的 `checkMedia` 规则改动与 `apps/arkui-schedule/tools/test/doctorV2.test.mjs` 的测试 28/40/41 增量，并撤销本文 §1/§5/§6 登记；提交后 `git revert <hash>`（独立叶子，无下游，不进回滚链） |

> 追加登记：mod-v2-doctor = 7fc5b9f；mod-v2-media-gc = 915a416；mod-export-v2-ledgers = 25fd0f2（评审见 docs/REVIEW-hardening.md；doctor 的 P1 复审已落盘（`docs/REVIEW-hardening.md` §复审：P1-1 CLOSED / P2-2 PARTIAL + N-1））。
> 追加登记：mod-doctor-media-window = df917ff：闭合上述 N-1（`docs/REVIEW-hardening.md` §复审新发现），哈希待 Lead 提交后回填。

> 追加登记：mod-doctor-media-window = df917ff（迁移窗口空 media/ 不误报；评审追加判可提交，P0 0 / P1 0 / P2 1，N-2 已登记）。此后按要求硬停。
