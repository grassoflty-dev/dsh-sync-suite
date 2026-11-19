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
| `mod-insert-page-count` | 修复真机「插入页 2/3 而非 2/2」：新建记录手写板草稿键串号 | 已提交（真机已验证 PASS） | 96d4435 | `git revert <hash>`（仅 `RecordEditorView.ets` + 1 个测试） | 跨模块触碰 `RecordEditorView.ets`（见 §2） | `docs/VERIFICATION.md` §14 更新段；真机 `device-accept` **15 PASS / 0 FAIL / 6 SKIP（exit 3 = 仅未覆盖）**；回归测试 `apps/arkui-schedule/tools/test/handwritingToolbar.test.mjs` |
| `mod-v2-media-migration` | v1 按天 zip → v2 `timeline/<date>/media/` 松散压缩图（尚未开始） | 待开始 | — | — | 依赖 `mod-v2-contract`、`mod-v2-migration` | 待建 |
| `mod-v2-dual-write-off` | 停止写 v1、保留一个 release 的只读回退（由 `mod-v2-dual-read` 改名而来） | 待开始 | — | — | 依赖 `mod-v2-contract`、`mod-v2-migration` | `docs/DATA-CONTRACT-v2.md` §10/§13 |
| `mod-settings-lean` | 设置只留仓库地址 + 令牌 | 待开始 | — | `git revert <hash>` | 独立 | 待建 |
| `mod-quick-record` | 首页底部快捷记录（不跳编辑页） | 待开始 | — | `git revert <hash>` | 依赖 `mod-d5-create-date` | 待建 |

`mod-v2-dual-read` 已被 `mod-v2-dual-write-off` 取代，见契约 §13。

说明：「提交」列记的是该模块**最后一个**提交；`mod-d5-create-date` 的完整回滚要连同索引里写明的较早提交一起做。
哈希已由 Lead 于 2026-11-19 提交后回填；执行子代理不得猜测或编造哈希。
「待建」表示模块尚未开始，文档位置在交付时补上。

## 2 跨模块触碰登记

> 共享文件不属于任何单一模块。改到这里必须在对应批次里登记，并提醒该文件的其他owner串行改。

| 批次/模块 | 触碰的共享文件 | 为什么必须碰 | 风险 |
| --- | --- | --- | --- |
| `mod-arkts-first-build`（`cec3c93`） | 21 个 `.ets` + 6 个测试文件 | 首次真实 ArkTS 编译暴露的硬错误是全仓性的：ActionButton 属性重名、`CalendarPicker` 撞内置类型（改为 `MonthCalendar`）、非法 `lineHeight` 调用；只能通过属性/方法/结构名的全局改名与调用点修正解决 | 跨全仓改名，任何一处漏改都会再次编译失败；这些文件被所有 app 模块共用，并行改动必须串行并在提交后重跑全量门闸 |
| `mod-d5-create-date`（`d6a6b69`） | `components/RecordEditorView.ets` | 收窄后编辑器保存路径改走 `resolveSaveTs`，日期行对已有记录只读且仅在新建时展开 `CalendarPicker`，必须改这个共享组件本身 | 同一文件还承载 D7 的日历接线与 B3 的一次性保存标记；与 `mod-d7-month-calendar` 共写，撞文件必须串行、不可双人同时改 |
| `mod-insert-page-count` | `components/RecordEditorView.ets` | 修复真机插入页串号：新增 `writingDraftKey()`（新建记录按编辑器实例生成 `new-<timestamp>` 草稿键）并新增路由参数 `draftKey`，必须改这个共享组件本身 | 同一文件也被 `mod-d5-create-date`/`mod-d7-month-calendar` 触碰，必须串行、不可双人同时改 |
| `mod-v2-read-timeline` | 无共享文件（全部新增） | 纯模型 `model/timeline.ts` 与测试 `tools/test/timelineRead.test.mjs` 均为新增，未改 `.ets`/service/UI/写路径，未触碰任何被其他模块共用的文件 | 无跨模块撞文件风险；未接线、零运行时影响；回滚 = 提交后 `git revert <hash>`（未提交前删除这两个新增文件） |
| `mod-v2-migration`（含评审修复） | 无共享文件（全部新增） | 迁移工具 `tools/migrate-v1-to-v2.mjs` 与测试 `apps/arkui-schedule/tools/test/v2Migration.test.mjs` 均为新增文件，评审修复也只改这两个文件，未触碰任何被其他模块共用的文件 | 无跨模块撞文件风险；回滚 = 提交后 `git revert <hash>`（未提交前删除这两个新增文件），不影响其他模块 |

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
   - `node --test "packages/dsh-dots/test/*.test.mjs" "apps/arkui-schedule/tools/test/*.test.mjs"` → 当前基线 **2390 例 / 2389 pass / 0 fail / 1 skip**（相对 2348 基线：`mod-v2-read-timeline` **+42**；再往前相对 2306 基线：`mod-v2-migration` **+39 = +30 初版 +9 评审修复**、`mod-insert-page-count` **+1**；`cec3c93` 之后；数字随模块加入而变动；回滚 D5 相关模块时，因删除的旧用例被恢复，数字会变化，须在批次记录里写明变化原因）；
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
| 2026-11-19 | `mod-v2-read-timeline` | 已完成，待提交 | 全量 2386/2385/0/1；validate 8/8；tsc 0 | （评审后填） | 未接线，零运行时影响 |
