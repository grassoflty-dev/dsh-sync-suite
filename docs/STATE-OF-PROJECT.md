# 项目现状一页纸（STATE OF PROJECT）

> 数据截止 2026-11-20；工作目录 `dsh-sync-suite`，HEAD = `c705212`（=`origin/main`，已同步）；本批 `mod-doctor-media-window`（源码 + 测试 + 本页 doc 更新）尚未提交（待 Lead 提交后 HEAD 前进），其余无未提交批次。
> 依据：`docs/MODULES.md`、`docs/DATA-CONTRACT-v2.md`、`docs/RUNBOOK.md`、`docs/VERIFICATION.md` §14、`docs/REVIEW-three-batches.md`、`docs/REVIEW-sync-wiring.md`、`docs/REVIEW-hardening.md`。真机 / 双端 / 重启结论一律以 `VERIFICATION.md` §14 已记录者为准，其余标 `unverified`。
> doctor 复审状态：已落盘（`docs/REVIEW-hardening.md` §复审）——P1-1 / P2-1 / 退出码 / 无回归 CLOSED；P2-2 的残留 N-1 已由 `mod-doctor-media-window` 闭合（空 `media/` + 引用全缺 → `W_MEDIA_NOT_MIGRATED` warning/exit 0），exit 1 仍 `unverified`。

## 1 一句话状态

DSH-Dots = 平板 ArkUI-X 日程 App + PC 端 DSH 插件，用 Git 仓库做跨设备日程/手写/OCR/汇总同步，并在平板只读浏览 DSH 会话。**今天是 v2-only**（2026-11-20 订正）：唯一日程路径是 `timeline/` 单时间线，写 `timeline/<date>/` 并自动同步；激活开关、`timeline.readMode` / `timeline.v2WriteEnabled` / `timeline.v1Retained`、双库确认与 v1 读写兜底**已全部删除**，不存在默认 v1 或显式激活。仓库未迁移（缺 `timeline/schema.json` 且存在 `devices/`）→ **唯一一条** banner + typed `E_NOT_MIGRATED` 拒绝 + **零写入**；**`devices/**` 永不删除**。一次性迁移是用户的显式动作（`mod-v2-import-v1`，已写完待 Lead 提交），它最后写 `timeline/schema.json` 作为提交边界。另有两把**独立只读开发工具**（`mod-v2-doctor` / `mod-v2-media-gc`，默认零写入、无 app 运行时依赖）；v2 bundle 已带三本账本（`bundleVersion:2`）。chat 真接管、远程连接收敛仍未做或未验。（原「默认 v1 / 显式激活」口径作废，保留于本文 §3 历史折叠块作记录。）

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
| `mod-push-detail` | `typedPushError` 保真：带细节的 `E_PUSH_REJECTED` 逐字进 message + lastError | 已提交 `ea7b603`（tag `module/mod-push-detail`） | `git revert`（独立叶子，不进回滚链） |
| `mod-v2-doctor` | 只读仓库体检 CLI（schema/布局/records/三本账本/media/v1 侧/冲突审计；独立开发工具） | 已提交 `7fc5b9f`（tag `module/mod-v2-doctor`） | `git revert`（纯新增 2 文件） |
| `mod-v2-media-gc` | 散图回收（默认只读；`--delete` 需 planHash 确认，只删计划内文件；独立开发工具） | 已提交 `915a416`（tag `module/mod-v2-media-gc`） | `git revert`（纯新增 2 文件） |
| `mod-export-v2-ledgers` | bundle 升 `bundleVersion:2` + 三本按日账本逐字节搬运；旧 bundle 导入给信息性 note；目标账本只并集追加、不截断 | 已提交 `25fd0f2`（tag `module/mod-export-v2-ledgers`） | `git revert`（增量；v1 导出导入不变） |
| `mod-doctor-media-window` | 修 doctor 迁移窗口假阳性：空 `media/` + 引用全缺 → `W_MEDIA_NOT_MIGRATED` warning/exit 0；非空目录仍缺引用 → `E_MEDIA_MISSING` error/exit 2 | 已写完，待提交（哈希由 Lead 回填） | `git revert`（独立叶子；撤销 `checkMedia` 规则 + 测试 28/40/41 增量） |
| `mod-v2-only` | v2-only 默认行为：删除激活开关 / `timeline.readMode` / `timeline.v2WriteEnabled` / `timeline.v1Retained` / 双库确认 / v1 读写兜底；未迁移仓库 = 一条 banner + typed `E_NOT_MIGRATED` + 零写入；`devices/**` 永不删除 | 已写完，待 Lead 提交（哈希 `（Lead 填）`） | `git revert`（独立叶子，哈希 `（Lead 填）`） |
| `mod-v2-import-v1` | 应用内一次性迁移：dry-run 面板 + 独立确认；写序 records→summary→media→ledgers→schema（最后）；五类 typed 拒绝；`devices/**` 只读 | 已写完，待 Lead 提交（哈希 `（Lead 填）`） | `git revert`（独立叶子，撤销 3 新增代码 + 1 测试 + 两处增量） |

> **2026-11-20 v2-only 订正**：上表 `mod-v2-dual-write-off` 与 `mod-v2-sync-wiring` 的**激活部分**已被
> `mod-v2-only` 取代，两行作为历史记录保留，不再代表现行行为；二者提交列为历史哈希，不填新哈希。

> 共 **32** 个模块条目（含 2 条纯文档登记）；全量回滚顺序固定：先 `1b79790` → `18a692e` → `634da60` → `241bab5` → …（见 `MODULES.md` §1.1 / `RUNBOOK.md` §3）；tag 形式 `git revert module/mod-<id>` 亦可用。doctor / media-gc / export-ledgers 均为独立叶子，不进 v2 回滚链。

## 3 v2 时间线的默认行为（2026-11-20 v2-only 订正）

> 原「默认 v1 / 显式激活 / 关闭回到 v1 / v1 读取兜底」四条已整节废止删除；现行口径如下，旧文保留在下方折叠块作历史记录。

- **唯一路径**：App 与插件启动后直接以 `timeline/` 为唯一日程真值，写 `timeline/<date>/`（records/summary/deleted/restore/conflicts/media），自动跑 fetch→union→replay→commit→push（提交 `[v2] sync <n> days`，`force:false`），outbox 是周期之间唯一本地真值。
- **无开关、无回退**：`timeline.readMode` / `timeline.v2WriteEnabled` / `timeline.v1Retained` 均已删除；没有「启用」「关闭」「确认并存」步骤，也没有 v1 读 / 写兜底或双存储确认。
- **未迁移拒绝**：缺 `timeline/schema.json` 且存在 `devices/` → **唯一一条** banner + typed `E_NOT_MIGRATED` + **零写入**（不建本地提交、不 push）。
- **安全网**：`devices/**` 永不删除；迁移 commit 只新增 `timeline/` 与标记，不删改任何 v1 文件。
- **一次性迁移**：`mod-v2-import-v1` 已写完（待 Lead 提交）：横幅打开 dry-run 计划、独立「确认迁移」才落盘；最后写 `timeline/schema.json` 作为提交边界，中断可续跑，迁移完成即生效，无需激活（`devices/**` 只读、永不删除；真机端侧 `unverified`）。

<details><summary>历史记录（2026-11-20 之前，已作废，仅为存档保留）</summary>

- **v1 仍是默认**：`timeline.readMode='v1'`、`timeline.v2WriteEnabled=false`、`timeline.v1Retained=''`；三键由 `PersistentStorage.persistProp` 在页面加载前绑定（唯一真值 `model/persistentSettings.ts`）。
- **v2 须显式激活**：迁移生成 `timeline/schema.json`（schemaVersion=2）+ 同步内核就绪后，用户在设置页「启用 v2 时间线写入」经预检 + 确认开启；两库并存另弹专用确认（记录为 `v1Retained='1'`）。
- **激活后**：写 `timeline/<date>/`（records/summary/deleted/restore/conflicts/media），自动跑 fetch→union→replay→commit→push（提交 `[v2] sync <n> days`，`force:false`），outbox 是周期之间唯一本地真值。
- **关闭回到 v1**：`deactivate()` 显式写 `false`/`'v1'`，toast「已关闭 v2 写入，回到 v1（v1 数据未删除）」；`v1Retained` 作为事实记录保留。
- **v1 数据不删除**：迁移只新增 `timeline/`、从不删 `devices/**`；v1 只读兜底 flag `v1ReadFallback` 硬截止 2026-12-31 后移除。

</details>

## 4 保证与不保证

**今天成立（契约/设计已定；括号内为证据强度）**（2026-11-20 订正：原「激活后」口径已改为 v2-only）：不产生「本地已提交却从未推送成功且不告知」的静默提交（outbox 唯一真值 + `maxAttempts=4` 终态仅手动重试；代码 + 双端模拟）；同 `(id,ts)` 内容不同按规范行 UTF-8 字节序大者静默胜、败者进 `conflicts.jsonl`（纯逻辑 + `twoDevice.test.mjs`）；删除优先于恢复（`R>D` 才可见；纯逻辑已证 `R==D`/`R>D`）；写方式按契约：`records.json` 原子替换、三本账本只追加且旧字节为新字节严格前缀、summary newer-wins、media 只增（部分无测试见下）；不 force-push、不改写远端历史、不删远端文件（静态断言 + 评审）；`assertWritable()` 门槛零写入（契约 §11）。**v2 bundle 已闭合评审 P2-3**：`bundleVersion:2` + 三本按日账本逐字节搬运，旧 bundle（缺字段/1）仍导入并返回信息性 note、未来版本 `E_BUNDLE_VERSION` typed 拒绝；目标账本按 `(id,ts)` / `(id,ts,dedupeKey)` 只并集追加、绝不截断（纯模型 + Node 测试）。

**今天不成立 / 未证**（2026-11-20 v2-only 订正）：两设备真实同步（只有内存模拟 + 纯逻辑，真 git 并发 / fetch 耗时 / 仓库体积未验）；「已迁移→杀进程→重启仍生效」的真机证明（三个持久键已删除，端侧未验）；真机未迁移 banner 渲染 / 设备写拒绝（`E_NOT_MIGRATED` + 零写入）/ 真实 push / outbox 全链路；插件 live RPC（HTTP 405，需 DSH 重启）；两把开发工具只在 Node / CLI 层验证（doctor 的 exit-1 未预期错误路径无注入用例，media-gc 的坏日文件保护与跨日同名语义未做真仓库演练）；bundle 账本并集跨**两台真实设备**的逐字节一致性未验（仅 Node 纯模型）；此前「契约规则无测试」清单已由 `mod-v2-contract-tests`（25 例）+ `mod-push-detail`（C12/C14–C16）覆盖，但只在 Node 跑纯模型 / 源码断言，服务级导入 IO 与真机 typed 详情文案仍 `unverified`。

## 5 未验证清单与原因

- **设备上未配置数据仓库 / 未迁移拒绝**：**唯一一条 banner** 的真机渲染、未迁移仓库的 typed `E_NOT_MIGRATED` 拒绝与**零写入**、真实 `timeline/` 写入、真实 push、「建记录→自动同步→三态行变已同步」均无端到端证据（`RUNBOOK.md` §6 / `VERIFICATION.md` §14.8）。
- **签名 / 安装 / 启动（v2-only 后）**：`hdc list targets` 为空，无法重新签名、安装并启动含 v2-only 改动的 HAP；banner 渲染与设备写拒绝因此端侧 `unverified`（§14.7）。
- **无第二设备 / PC**：契约 §15 双端场景全部 `unverified`（同日各建、同 id 不同/相同 ts、A 删 + B 编辑、媒体占位双端一致）；bundle 账本跨两真设备并集同样未验。
- **媒体占位渲染**：媒体占位图在真机上的显示/加载未验证（仅 Node 侧媒体名/碰撞/缺失的规则测试）。
- **`hdc` 输入注入限制**：`uitest uiInput click` 返回 “No Error” 但首页无变化（§14.6）；新建→editor→月历、设置分组锚点、聊天「在电脑上继续」、手写笔压感、path-1 bootstrap「进页即可输入」均不可验，只有静态/代码结论。
- **PersistentStorage 重启证明**：三个持久键（`timeline.readMode` / `timeline.v2WriteEnabled` / `timeline.v1Retained`）已删除；「已迁移→杀进程→重启仍生效」端侧未验（§14.7）。
- **插件 live**：RPC `getState` HTTP 405，bundle 行在启动时解析，需 DSH 重启（§14.7）；`mod-plugin-live` 的 live 验证因此阻塞。
- **doctor 退出码 1**：未预期错误路径无注入用例（`REVIEW-hardening.md` §8）。
- **仅 Node 纯逻辑**：`mod-v2-contract-tests` 与 `mod-push-detail`（contractGaps 28/28）只驱动编译后的纯模型与源码断言；`E_PUSH_REJECTED` 细节在真机状态行的呈现、服务级导入 IO 未验。
- 除 `VERIFICATION.md` §14 已记录的真机项（编译/签名/安装/启动、HAP 内容、8s 无 fatal、布局骨架、工具条两行、pen 对照手指行为、插入菜单、首页渲染；§14.10 插入页 15P/0F/6S）外，本一页纸**不宣称任何「已在设备验证」**。

## 6 下一步（三个阻塞项 + 一个待交付模块，若用户回来）

> **2026-11-20 v2-only 订正**：`mod-v2-only` 已完成；`mod-v2-import-v1`（一次性迁移的用户显式动作）已写完待 Lead 提交（不再是 pending），它最后写 `timeline/schema.json` 作为提交边界。原先「验激活弹层」改为「验未迁移 banner + `E_NOT_MIGRATED` 拒绝 + 零写入」；本模块真机 UI / zip 桥链路仍 `unverified`。

- **(a) 在平板上配置好一个仓库**：解锁两个设备缺口（设备 + 第二设备）与 path-1 bootstrap 证据；随后才可能验未迁移 banner / `E_NOT_MIGRATED` 拒绝与零写入 / 真实写入 / push / 三态收敛与双端并集。
- **(b) chat 租约/sha 规格**：定稿 `CHAT-SYNC.md` §1/§5 的 lease + sha 校验规范，解锁 D2-P2（chat 真接管 + 导入回 DSH 端到端）。
- **(c) DSH 重启**：解锁 `mod-plugin-live` 的 live 验证（当前 RPC `getState` HTTP 405，bundle 行在启动时解析）。

**当前为干净停止点**：在不具备 (a) 平板上配置好仓库、(b) chat 租约/sha 规格、(c) DSH 重启 之前，没有可推进的模块；`mod-v2-import-v1`（一次性迁移）**已写完、待 Lead 提交与真机验证**，不再是 pending；下一步是提交本模块后在真机走一遍 banner → dry-run → 独立确认 → schema 落地。
