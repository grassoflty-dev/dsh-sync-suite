# 项目现状一页纸（STATE OF PROJECT）

> 数据截止 2026-11-20；代码仓工作目录 dsh-sync-suite，HEAD = b5f3ff5（`mod-v2-contract-tests` 58caeb2、`mod-state-summary` 2a475e0、哈希回填提交 b5f3ff5 均已提交）；当前未提交批次仅 `mod-push-detail`（改 `model/syncCycle.ts` + `contractGaps.test.mjs` + `syncWiring.test.mjs`），模块表里已填的哈希均为已提交的真实 commit。
> 依据：`docs/MODULES.md`、`docs/DATA-CONTRACT-v2.md`、`docs/RUNBOOK.md`、`docs/VERIFICATION.md` §14、
> `docs/REVIEW-three-batches.md`、`docs/REVIEW-sync-wiring.md`。真机 / 双端 / 重启结论一律以 `VERIFICATION.md` §14 已记录者为准，其余标 `unverified`。

## 1 一句话状态

DSH-Dots = 平板 ArkUI-X 日程 App + PC 端 DSH 插件，用 Git 仓库做跨设备日程/手写/OCR/汇总同步，并在平板只读浏览 DSH 会话。**今天默认跑 v1**：每设备只写 `devices/<id>/`、按日 JSONL 追加、三态 UI、月视图选日期、首页快捷记录；**v2 单时间线的代码全部已交付但默认关闭**（`timeline.readMode='v1'`、`timeline.v2WriteEnabled=false`），须用户显式激活才写 `timeline/` 并自动同步；chat 真接管、远程连接收敛、导出 bundle 账本完整性仍未做或未验。

## 2 已交付模块一览

| 模块 id | 一句话保证 | 状态 | 回滚方式 |
| --- | --- | --- | --- |
| `mod-doc-verify` | 首次真机编译/签名/安装/启动证据 | 已提交 `5a1cd91` | `git revert`（纯文档） |
| `mod-module-doctrine` | 模块制治理 + 自主交付纪律 | 已提交 `a95ecaa` | `git revert`（纯文档） |
| `mod-arkts-first-build` | 首次真实 ArkTS 编译修复 | 已提交 `cec3c93` | **不可单独回滚**（回滚即编译失败） |
| `mod-d5-create-date` | 新建可选日期、已有记录日期固定 | 已提交 `d6a6b69`（引入 `14b181a`） | **逆序** `git revert d6a6b69 14b181a` |
| `mod-d7-month-calendar` | 首页日期条换月视图日历 | 已提交 `14b181a` | 不单独回滚（与 D5 同提交） |
| `mod-b3-saved-row-relax` | 保存行对账判据放宽为「同 id 且 ts 不早于标记」 | 已提交 `14b181a` | 不单独回滚（与 D5 同提交） |
| `mod-v2-contract` | v2 单时间线数据契约（draft-2） | 已提交 `77df67a` | `git revert`（纯文档） |
| `mod-v2-migration` | v1→v2 单向迁移（只读 v1、不删 v1） | 已提交 `28b8592` | `git revert` |
| `mod-insert-page-count` | 真机插入页串号修复（15P/0F/6S） | 已提交 `96d4435` | `git revert` |
| `mod-v2-read-timeline` | v2 只读折叠核心（纯模型） | 已提交 `4377b19` | `git revert` |
| `mod-settings-lean` | 设置同步组只留仓库地址 + 令牌 | 已提交 `4176654` | `git revert` |
| `mod-quick-record` | 首页快捷记录（路径 1 5→3） | 已提交 `ff1560f` | `git revert` |
| `mod-v2-media-migration` | v1 按天 zip → timeline media（v1 不动） | 已提交 `2f32752` | `git revert` |
| `mod-v2-read-service` | v2 只读服务（默认 v1、不写 v2） | 已提交 `c6f2935` | `git revert` |
| `mod-v2-write-service` | v2 写入核心（默认不生效、原子替换） | 已提交 `c5dc58c` | `git revert` |
| `mod-v2-sync-protocol` | 写门禁 + fetch/union/replay + outbox | 已提交 `e6c202b` | `git revert`（与 hardening 逆序） |
| `mod-v2-dual-write-off` | 停写 v1、双激活闸、失败停放 outbox | 已提交 `241bab5` | `git revert`（须在 sync-wiring 之后） |
| `mod-v2-sync-wiring` | 同步周期接线 + 显式激活 + 三态 UI | 已提交 `634da60` | `git revert`（须先于 dual-write-off） |
| `mod-export-import-v2` | v2 导出/导入 + typed 拒绝 | 已提交 `18a692e` | `git revert`（依赖链最右端先回） |
| `mod-v2-hardening` | 双端收敛模拟 26 例 + tie-break 顺序依赖修复 | 已提交 `1447b0f` | `git revert`（与 sync-protocol 同链逆序） |
| `mod-export-import-v2`（修复批次） | 媒体 sha256 完整性 + sha16 撞名拒绝 | 已提交 `1b79790` | `git revert`（纯增量） |
| `mod-runbook` | 运维手册（迁移/激活/逆序回滚/异常处置） | 已提交 `9904161` | `git revert`（纯文档，另撤销三处登记） |
| 文档登记（非功能） | 登记重启后三批 + 三批评审索引 | 已提交 `c41c3c5` | `git revert`（纯文档） |
| `mod-v2-contract-tests` | 契约缺口测试 25 例（假 IO 媒体预检 / shipped dedupe / 未测契约规则） | 已提交 `58caeb2` | `git revert`（仅新增 1 个测试文件） |
| `mod-state-summary` | 项目现状一页纸（默认 v1 / v2 显式激活 / 模块哈希表 / 保证与不保证 / 未验证 / 下一步） | 已提交 `2a475e0` | `git revert`（纯文档，另撤销三处登记） |
| 文档登记（非功能） | 回填 `mod-v2-contract-tests`（`58caeb2`）与 `mod-state-summary`（`2a475e0`）的哈希与状态 | 已提交 `b5f3ff5` | `git revert`（纯文档） |

> 全量回滚顺序固定：先 `1b79790` → `18a692e` → `634da60` → `241bab5` → …（见 `MODULES.md` §1.1 / `RUNBOOK.md` §3）；
> tag 形式 `git revert module/mod-<id>` 亦可用。`MODULES.md` §1 个别行仍标「待提交」，但其哈希已真实入 git log（如 `4176654`/`ff1560f`/`2f32752`），属文档登记滞后，非实际未提交。

## 3 v2 时间线的默认行为

- **v1 仍是默认**：`timeline.readMode='v1'`、`timeline.v2WriteEnabled=false`、`timeline.v1Retained=''`；三键由 `PersistentStorage.persistProp` 在页面加载前绑定（唯一真值 `model/persistentSettings.ts`）。
- **v2 须显式激活**：迁移生成 `timeline/schema.json`（schemaVersion=2）+ 同步内核就绪后，用户在设置页「启用 v2 时间线写入」经预检 + 确认开启；两库并存另弹专用确认（记录为 `v1Retained='1'`）。
- **激活后**：写 `timeline/<date>/`（records/summary/deleted/restore/conflicts/media），自动跑 fetch→union→replay→commit→push（提交 `[v2] sync <n> days`，`force:false`），outbox 是周期之间唯一本地真值。
- **关闭回到 v1**：`deactivate()` 显式写 `false`/`'v1'`，toast「已关闭 v2 写入，回到 v1（v1 数据未删除）」；`v1Retained` 作为事实记录保留。
- **v1 数据不删除**：迁移只新增 `timeline/`、从不删 `devices/**`；v1 只读兜底 flag `v1ReadFallback` 硬截止 2026-12-31 后移除。

## 4 保证与不保证

**今天成立（契约/设计已定；括号内为证据强度）**：激活后不产生「本地已提交却从未推送成功且不告知」的静默提交（outbox 唯一真值 + `maxAttempts=4` 终态仅手动重试；代码 + 双端模拟）；同 `(id,ts)` 内容不同按规范行 UTF-8 字节序大者静默胜、败者进 `conflicts.jsonl`（按 `(id,ts,dedupeKey)` 去重、顺序无关；纯逻辑 + `twoDevice.test.mjs` 已证）；删除优先于恢复（`R>D` 才可见、`R≤D` 隐藏、无墓碑复活；纯逻辑已证 `R==D`/`R>D`）；写方式按契约：`records.json` 原子替换、三本账本只追加且旧字节为新字节严格前缀、summary newer-wins、media 只增（规范已定，部分无测试见下）；不 force-push、不改写远端历史、不删远端文件（静态断言 + 评审）；`assertWritable()` 门槛零写入（契约 §11）。

**今天不成立 / 未证**：两设备真实同步（只有内存模拟 + 纯逻辑，真 git 并发 / fetch 耗时 / 仓库体积未验）；「已激活→杀进程→重启仍生效」的真机证明（PersistentStorage 已绑且有编译证据，端侧未验）；导出 bundle 的账本完整性（`REVIEW-three-batches.md` P2-3：bundle 不含 deleted/restore/conflicts.jsonl，三批未处理）；真机激活弹层 / 真实 push / outbox 全链路；插件 live RPC（需 DSH 重启）；此前「契约规则无测试」清单（`R<D`、媒体读路径、summary newer-wins、完成耗时、`maxAttempts` 耗尽、未知 schema 零写入、push 连续拒 4 次）已由 `mod-v2-contract-tests`（25 例）+ `mod-push-detail`（C12 保真修正 + C14/C15/C16）覆盖，但只在 Node 跑纯模型 / 源码断言；服务级导入 IO、真机状态行的 typed 详情文案仍 `unverified`。

## 5 未验证清单与原因

- **设备上未配置数据仓库**：激活弹层、真实 `timeline/` 写入、真实 push、「建记录→自动同步→三态行变已同步」均无端到端证据（`RUNBOOK.md` §6 / `VERIFICATION.md` §14.8）。
- **无第二设备 / PC**：契约 §15 双端场景全部 `unverified`（同日各建、同 id 不同/相同 ts、A 删 + B 编辑、媒体占位双端一致）。
- **`hdc` 输入注入限制**：`uitest uiInput click` 返回 “No Error” 但首页无变化（§14.6）；新建→editor→月历、设置分组锚点、聊天「在电脑上继续」、手写笔压感均不可验。
- **插件 live**：RPC `getState` HTTP 405，bundle 行在启动时解析，需重启 DSH（§14.7）。
- **仅 Node 纯逻辑**：`mod-v2-contract-tests`（25 例）与 `mod-push-detail`（C12/C14–C16，contractGaps 共 28/28）只驱动编译后的纯模型与源码断言；`E_PUSH_REJECTED` 细节在真机状态行的呈现、服务级导入 IO 均未验。
- 除 `VERIFICATION.md` §14 已记录的真机项（编译/签名/安装/启动、HAP 内容、8s 无 fatal、布局骨架、工具条两行、pen 对照手指行为、插入菜单、首页渲染；§14.10 插入页 15P/0F/6S）外，本一页纸**不宣称任何「已在设备验证」**。

## 6 下一步（若用户回来）

- **数据仓库落到平板**：需用户在平板配置一个真实私有仓库（`main`），才能验激活弹层 / 真实写入 / push / 三态收敛。
- **chat 真接管（D2 P2）**：需先定稿 `CHAT-SYNC.md` §1/§5 的租约 + sha 校验规范（a chat lease/sha spec），再做导入回 DSH 的端到端实验。
- **路径 1 bootstrap wait**：需真机证据证明「进页即可输入」（device evidence for path-1 bootstrap），当前仅静态/代码结论。
- **双端收敛上真机**：需第二台设备 / PC + 真 git 并发仓库，才能覆盖 §15 全部场景（fetch+union+replay 双端逐字节一致）。
- **导出 bundle 补账本**：需规范决策 + 实现把 deleted/restore/conflicts.jsonl 纳入 v2 bundle，闭合评审 P2-3。

**当前为干净停止点**：在不具备 (a) 平板上配置好仓库、(b) chat 租约/sha 规格、(c) DSH 重启 之前，没有可推进的模块。
