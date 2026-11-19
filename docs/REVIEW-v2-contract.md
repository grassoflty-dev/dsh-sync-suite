# 独立评审：数据契约 v2 草案（`docs/DATA-CONTRACT-v2.md`）

> 评审角色：独立、只读（不修改被审文档、不改 `MODULES.md`、不改任何代码）。
> 评审对象：`docs/DATA-CONTRACT-v2.md`，276 行（任务书写的 175 行与磁盘实际不符，以磁盘为准），最后写入 2026-11-19 22:38。
> 对照基线：`docs/DATA-CONTRACT.md`（v1）、`docs/SCHEDULE-BRIDGE.md`、`docs/EXPORT-IMPORT.md`、
> `apps/arkui-schedule/entry/src/main/ets/model/{jsonl,recordMerge,openIndex,undoDelete}.ts`、
> `services/{scheduleStore,openIndexStore,settingsStore}.ets`、`packages/dsh-dots/src/schedule/**`、
> `docs/MODULES.md`、磁盘上未提交的 `tools/migrate-v1-to-v2.mjs` 与其测试。
> 凡涉及真机 / 第二设备的结论，本文一律标 `unverified`（与 v2 §15 同口径）。

## 1. 结论

| 级别 | 数量 | 性质 |
| --- | --- | --- |
| **P0** | **2** | 逻辑空洞：不补定义就无法写出正确且确定性的 Stage B 实现 |
| **P1** | **7** | 协议 / 迁移 / 模块一致性缺口：会导致静默失败或与已登记模块冲突 |
| **P2** | **11** | 措辞、规范化、可测性、簿记问题：不阻塞架构，但必须收敛 |

**判定：rework（局部补定义，不是推翻架构）。** 两个 P0 都不是设计方向错误——单时间线、按日目录、物理删除 + 账本、pull-then-write 的方向本身可用——但
（1）"较晚 ts 静默胜出"在 **ts 相同而内容不同**时没有任何裁决规则，而契约同时明文取消冲突 UI；v1 的 `recordMerge.ts` 恰恰把这种情况当作必须上 UI 的真冲突。秒级 `ts` 让同秒双端编辑成为常态，直接破坏 §4 的 silent-later-ts-wins 承诺。
（2）版本门槛"写前检查"没有被收敛成唯一写入口，现网存在至少 4 类可绕过它的写路径；只要有一条存活，§11 的"未知版本只读、零写入"就不可证明。

**这两条修完后，契约可以作为 Stage B 的实现依据；修完前不建议开工。**

**最重要的一条（P0-1）**：同 id 同 `ts` 不同内容的双端编辑没有 tie-break，且冲突 UI 被明文删除。两个设备在 2026-11-19 09:30:00 各写一条不同正文的编辑版本时，双方各自 pull 后按"稳定升序 + 后者覆盖"折叠，谁胜出取决于行的物理先后顺序；远端与本机行序相反时两台设备会展示不同内容，且没有任何冲突提示或计数。这正是契约声称要消灭的"静默数据丢失"，却由契约自身留下了入口。

---

## 2. 逐项检查回答（check 1–8）

**Check 1 完整性（Q1–Q10）**

| 决策 | 落点 | 结论 |
| --- | --- | --- |
| Q1 一条记录一行 | §3:38–40、§3:62、示例 §3:49–50 | 已声明；但规范键顺序与示例自相矛盾（P2-1），且缺少与迁移工具一致的 `file` 语义（P2-11） |
| Q2 静默 later-ts 胜 / 无冲突 UI | §4:89、§3:40、§13:244 | **不完整**：同 ts 不同内容无裁决（P0-1） |
| Q3 物理删除 + 账本 + 失效模式说明 | §7:110–137，失效模式 1/2 见 §7:134–135 | 失效模式写得很清楚（git 冲突 + 复活）；但账本"只追加"与 §9:160"原子替换整日文件夹"冲突（P2-3），撤销窗口未定（P1-4） |
| Q4 散图进 git | §5:93–101 | 完整（JPEG q60 / ≤1440 / 同日 sha256 去重 / 删除不删媒体 / 导出导入搬运）；迁移阶段的实际能力与之冲突（P1-5） |
| Q5 每日 summary.json | §8:139–149 | 完整，含 newer-wins 与失败不覆盖 |
| Q6 无根 index.json + 理由 | §2:34 | 完整（持续合并争用 + 第二事实来源 + 本地派生逃生口） |
| Q7 opened_at/closed_at 入记录 | §3:79–80、§6:105–107 | 已落字段；`open` 派生谓词与 v1 口径不一致（P2-2） |
| Q8 单向迁移 | §10:184–202 | 已声明幂等 / crash-safe / 逐字节校验 / revert 回滚；但 v1 检测优先级与空仓库未定义（P2-8），与 `mod-v2-dual-read` 直接矛盾（P1-7），回滚与清理提交顺序未定义（P2-9） |
| Q9 设置精简 | §1:13 | 已声明只留 `{repoUrl, token}`；但 Gitee 需要的 `username` 被删后无替代规则（P2-6） |
| Q10 分支固定 main | §1:13、§2:35、§12:222 | 已声明；但无"写前断言当前分支为 main"的强制规则（P2-12） |

**Check 2 并集合并正确性（两个场景走查）**

- **场景 A：两设备同日各建不同 id 的记录。** §9:156–161 的读—改—写协议本身能收敛：设备 B 在 pull 后看到 A 的行，再追加自己的行；若 B 在 A 之前已本地 commit，push 被拒走 §9:162 回滚重放，也能收敛。**前提**是回滚必须彻底（P1-6 的 `pull --rebase` 与 "fast-forward only" 表述冲突），且同 ts 的编辑版本有裁决（P0-1）。§3:40 说"冲突时走 §9 的语义并集（按 id 取较晚 ts）"，但 §9 根本没有定义一个 `mergeDayFile` 式的 records.json 并集函数——它定义的是"重放意图"。两种机制未在文中统一（P1-8）。
- **场景 B：A 删除 + B 并发编辑同一 id。** 若 A 先 push，B pull 后重放 upsert，仓库里会同时出现"删除账本条目 + B 的新版本行"；§7:129 的读侧过滤让 B 的编辑对所有设备不可见，**不会复活**，这一点设计是成立的。若 B 先 push，A pull 后重放 delete，物理移除所有版本行并追加账本条目，同样收敛。**但**三个未定义项削弱了它：账本被 §9:160 的整目录原子替换重写（P2-3）；一条已经入 outbox 的旧 upsert 意图在重放时若发现 id 已在账本，没有规则（P1-3）；`records.json` 的行在 merge 时命中账本 id 是否物理移除也未明说（P2-13）。

**Check 3 删除账本健全性**

(a) append-only：§7:114 说"只追加、绝不重写历史行"，但 §9:160 说"规范化写回该日文件夹（原子替换：临时文件 + rename）"——**两者不一致**（P2-3）。
(b) union-merge：§7:128 明确"所有设备的 deleted.jsonl 行取并集……不做缺行=撤销"，成立。
(c) 读侧过滤：§7:129 明确"id 在 ledger 里 ⇒ 无论 records.json 里是否还有该行，读侧一律视为不存在"，覆盖列表 / 详情 / 汇总 / 未完成索引，成立。
三项中 (b)(c) 一致且可测，(a) 自相矛盾。账本自身的并发合并（两设备当天删不同 id）在读—改—写协议下无冲突：各自 pull 后只追加自己的条目，并集天然成立；但若依赖文本行合并而非重放，同末行追加会触发 git 冲突，契约未指定 merge driver（P1-8）。复活路径：唯一残留在 P1-3（重放旧 upsert 到已删 id）与 P1-4（撤销窗口内账本尚未落地时的崩溃语义）。

**Check 4 版本门槛可强制性**

§11:206–210 的意图清楚，但"App 与插件各自在写前检查"不是可证明的单一门禁。磁盘上可绕过 / 必须显式挂载的写路径（含证据）：

| 路径 | 证据 | 是否过门禁 |
| --- | --- | --- |
| 插件 `schedule_add` → `ScheduleBridge.add` | `packages/dsh-dots/src/schedule/bridge.ts:266–288`：`ensureWorkTree` → `pullRebase` → `appendFile` → `commitAll` → `pushWithRebase`；`tools.ts:241–255` 直接调用 | 否，全程无 schema 检查 |
| 插件 `dsh_dots` 写路径 | `packages/dsh-dots/src/schedule/dots.ts`（与 bridge 共用 `GitRepo` 提交设施） | 需逐一登记，文档未列 |
| App 保存 `scheduleStore.appendRecord` | `services/scheduleStore.ets:308–326` → `appendLineSync:386–404`（直接落盘） | 否 |
| App 导入 `appendImportPlan` | `docs/EXPORT-IMPORT.md:172–175`、`services/exportService.ets` | 否；§9 协议也未覆盖导入这一写路径 |
| App 索引重建 `openIndexStore.replaceEntries` | `services/openIndexStore.ets:155–186, 534–546` | 否（v2 中该文件应废止，但必须显式废止，见 §13:235） |
| outbox 重放 | §9:180 | 未说重放前重查门槛（P1-3） |
| 迁移工具 | `tools/migrate-v1-to-v2.mjs:325,366–372` | 设计上豁免，但豁免未写进契约 |
| `chats/` 与配置同步载荷 | v1 §1–§2 / §10 | §1:9 说语义不变；§11:207"不打开任何写句柄"是否覆盖它们，文档沉默 |

**Check 5 pull-then-write / outbox**

无"静默本地未推提交"：§9:161–163 明确 push 成功才清计数、被拒回滚本地提交、耗尽回滚并进仓库外 outbox，方向正确。缺口：重试上界是否跨重放累计未定义（`attempts` 字段存在但无终态，P1-1）；`intentId` 声称"可安全重放"但没有去重规则（P1-2）；outbox 路径与形状已明确（§9:165–178：App `<filesDir>/sync-outbox.json`、插件 `%USERPROFILE%\.dsh\dots\outbox\<repoHash>.json`，JSON 数组 + 原子替换 + 意图字段），这部分完整；schema/`date` 在重放时变化的处理缺失（P1-3）。

**Check 6 迁移**

v1 检测规则 §10:186 列出三种分支，但"同时存在 `devices/` 与 v2 标记"以及"两者都不存在"未定义（P2-8）。"切换后不再读 v1"与回滚（§10:202）本身自洽（revert 移除标记后 `devices/` 仍在，v1 读侧恢复），但 `docs/MODULES.md:28` 的 `mod-v2-dual-read`（"App 同时读 v1/v2，写入仍 v1"）与 §1:11 / §10:202 的"绝不双读"正面冲突（P1-7）。媒体缺口：**文档没有把它 scoped 到后续模块**——§10:192 明确要求迁移阶段解包 zip 到 `media/`；而磁盘上的 `tools/migrate-v1-to-v2.mjs:7–8` 明说"不读 attachments/*.zip……媒体占位由后续模块 mod-v2-media-migration 负责补位"，且该模块未登记在 MODULES.md（P1-5）。

**Check 7 与既有产品决定一致性**

日期固定：§4:91 明确"记录永不换天……不存在改期路径"，与 `项目理解.md` §1.8 / `model/recordSaveTs.ts` 一致；§6:108"跨日按 id 合并（较晚 ts 胜）"在"永不换天"前提下不该发生，静默合并等于承认换天（P2-7）。
`MonthCalendar` 命名、UX 步骤计数等与本文无关，未发现遗留冲突。
遗留 v1 概念：§13:231–239 的废止清单覆盖设备目录、registry、指纹、`open.jsonl`、per-device scopes、墓碑、zip、全局索引，基本干净；但"按天 records.json 仍需 `date` 字段并以目录名为权威"（§3:60）是 v1 分片文件名语义的残留，可接受但需在校验规则里写清（P2-8 关联）。

**Check 8 可测性**

可用纯逻辑 / Node 工具证明的：一条一行与规范键序（JSON 序列化纯函数）、later-ts 折叠（现有 `foldById` 可直接复用）、账本并集与读侧过滤（可写纯函数 `visibleRecords(records, ledger)`）、`open` 派生、summary newer-wins、v1 检测分支、迁移 dry-run / 幂等 / 逐字节校验（已有 `tools/migrate-v1-to-v2.mjs` + `tools/test/v2Migration.test.mjs` 形态）、路径与日期校验、schema 文件内容解析。
**按现有文字不可测 / 无法证明的**：① 同 ts 不同内容的胜者（P0-1，无规则即无断言）；② intentId "安全重放"（P1-2，无可见去重效果）；③ "读侧过滤覆盖所有读路径"（§7:129 只列了四类，没有唯一函数或入口可枚举）；④ "写前检查覆盖所有写操作"（§11:206，无唯一门禁可枚举，见 Check 4）；⑤ "无冲突 UI"只能做源码静态断言，双端语义一致性必须靠 Node 双工作副本模拟，而 §15:262 把所有场景推给真机（真机不可用 → 永久 `unverified`）；⑥ 媒体 JPEG q60 / ≤1440 与同日 sha256 去重没有命名纯函数 / 参数常量，无法写无设备单测。

---

## 3. Findings

### P0-1 — 同 `ts` 不同内容无裁决，却取消冲突 UI

- **引用** §4:89："同一天内的顺序按 `ts`：先按 `ts` 稳定升序，后者覆盖前者，**较晚 `ts` 静默胜出（later-ts-wins）**；不提供任何冲突 UI。" §3:69："`ts` 保持 ISO 8601 + 本地偏移的字节形状（秒级，与 v1 `nowIso` 逐字符同形）"。
- **证据** v1 实现把"同 id 同 ts 内容不同"明确定义为真冲突：`apps/arkui-schedule/entry/src/main/ets/model/recordMerge.ts:14–15`（"同 id 且 ts 相同、内容不同 → 自动解不了：计入 conflicts 并默认保留本机，把两侧的规范行交给 UI"）与 `:216–225`。v2 §13:244 又声明"later-ts-wins 静默折叠"保留，但从未定义 tie-break。
- **影响** 秒级 ts + 两设备各自"更晚 ts"生成于同一秒 => 同 id 同 ts 不同内容。按 §3:40 的"稳定升序后者覆盖"折叠，胜者取决于文本行顺序；两台设备 pull 后行序可能相反，展示不同内容且无冲突提示、无计数、无日志。Check 2 场景 A 因此不闭合。
- **建议改法** 在 §4:89 后补一段 Normative 文本：
  > "若同一 `id` 的两行 `ts` 字节相同而内容不同，按**规范化整行 JSON 的字节字典序较大者**胜出（规范化口径同 §3:40 的固定键顺序 / 无多余空格）；该裁决同样静默、不进入任何冲突 UI；读侧把此类行计入 `equalTsResolved` 计数并写一行行为日志。合并过程中禁止重新生成 `ts`，`ts` 只能来自各端 `nextTsSameDate`。"
  同时在 §15 验证表增加"同 id 同 ts 不同内容 → 两设备折叠结果逐字节一致"的纯逻辑断言。

### P0-2 — 版本门槛没有唯一写入口，存在可枚举的绕过路径

- **引用** §11:206："App 与插件**各自**必须在启动时、以及每次写操作前检查它。" §11:209："门槛检查必须先于任何文件读写；**不允许部分写入**——检查失败时一个字节都不动。"
- **证据** Check 4 的表格列出 7 类写路径，全部没有"单一门禁"约束；`packages/dsh-dots/src/schedule/bridge.ts:266–288` 的 `schedule_add` 写路径、`services/scheduleStore.ets:308–326` 的保存路径、`docs/EXPORT-IMPORT.md:172–175` 的导入路径都可独立落盘 / 提交。§9:155 又在 pull 之后才读文件——pull 可能把本地仓库推进到未知 schema 版本，形成 TOCTOU。
- **影响** 任意一条路径漏检即可在"未知版本只读"状态下写入，破坏 §11 的全部安全承诺；而且没有唯一函数可写纯逻辑测试（Check 8 ④），只能靠真机逐路径验证（当前不可用）。
- **建议改法** 在 §11 增补：
  > "所有触及 `timeline/**` 的写操作必须经过唯一门禁 `assertWritable()`（返回 `OK` / `E_SCHEMA_UNKNOWN` / `E_MIGRATION_REQUIRED`），并在 (1) 启动时、(2) 每次 `pull` 之后、(3) 原子替换 / `git commit` 之前各调用一次；任一失败即一个字节不动。必须挂载的路径清单：`scheduleStore` 保存、`exportService.appendImportPlan` 导入、`openIndexStore` 重建、outbox 重放、插件 `ScheduleBridge.add`（`schedule_add`）、插件其余写 action、迁移工具（仅迁移本身豁免，写标记后仍须过门禁）。`chats/` 与配置同步载荷文件是否同受只读约束必须明确（建议：不受，`timeline/**` 单独停写，并写进 §11 例外清单）。"

### P1-1 — outbox 重试上界是否跨重放累计未定义

- **引用** §9:162："重试上界：首次 + 3 次重放（共 4 次推送尝试）。" §9:180："下次启动 / 刷新 / 保存时，按入队顺序逐条用上述协议重放；成功即从 outbox 移除并递减计数，失败保留并更新 `attempts` / `lastError`，不丢意图。"
- **影响** 意图形状有 `attempts`（§9:175），但没有说重放前是否清零、达到 4 后是永久留在 outbox 还是每次启动再给 4 次。按字面实现会出现"无限后台重试但 UI 一直显示 N 条待同步"，或"第 4 次失败后意图永远卡死无法恢复"，两者都违反 no-silent-failure。
- **建议改法** 明确："`attempts` 为跨重放累计值，pull 成功不重置；达到上限后 `state` 置为 `exhausted`，停止自动重放，UI 持续显示类型化失败；只有用户在 UI 点『重试』才原子清零 `attempts` 并重新入 `pending`。"

### P1-2 — `intentId` 的幂等语义只声称未定义

- **引用** §9:162："意图带稳定 `intentId`，可安全重放"；§9:175 的意图形状含 `intentId`；§9:180："成功即从 outbox 移除"。
- **影响** push 成功但响应丢失时，客户端按 §9:163 回滚本地提交并重放；§9:159 的 upsert "ts 按最新状态重新取更晚值"会生成**不同 ts** 的第二行，于是同一 `intentId` 被应用两次。语义上 `foldById` 只留一条，但 "安全重放" 没有可观测判据，无法写断言，也无法证明不会产生重复历史行。
- **建议改法** 明确："已成功推送的 `intentId` 持久化在 outbox 同目录的 `applied-intents.json`（仓库外）；重放前命中即直接出队。响应丢失导致的重复推送允许仓库出现两行同 `id`、同 `intentId`、不同 `ts` 的版本，读侧折叠时按 `intentId` 去重并保留 `ts` 最早者；`applied-intents.json` 落盘成功前不得从 outbox 移除意图。"

### P1-3 — 重放遇到 schema / date 变化或被删 id 时无规则

- **引用** §9:180："下次启动 / 刷新 / 保存时，按入队顺序逐条用上述协议重放"；§7:129："id 在 ledger 里 ⇒ 读侧一律视为不存在"。
- **影响** 三种情况都未定义：(1) 重放时远端已升级到未知 schema → 按 §11 应只读，但重放路径没说要重查门禁；(2) 意图的 `date` 目录不存在或 `date` 字段与目录名不符（§3:60 的容错分支）→ 可能新建错误目录；(3) 旧 upsert 意图的 id 已被其他设备删除 → 重放成功写入一行却被读侧过滤，用户编辑静默消失，计数还被清零。
- **建议改法** 在 §9:180 后补："重放每条意图前依次检查：目标仓库 `schema.json` 未知 → 意图留在 outbox、切只读、报 `E_SCHEMA_UNKNOWN`；目标日目录缺失或 `records.json.date` 与目录名不符 → 报 `E_CORRUPT` 并停在该条；`op:'upsert'` 且 id 已在目标日 `deleted.jsonl` → 报 `E_DELETED_REMOTELY`、出队并在 UI 显示『该记录已被删除，编辑未同步』，绝不按成功清除待同步计数。"

### P1-4 — 删除撤销窗口仍是"未决问题"，与 §7 的物理删除不衔接

- **引用** §14:254："推荐：撤销窗口做成**纯本机宽限期**——点删除后先不写 `deleted.jsonl`，5 秒内撤销则恢复记录行且从不写账本；超时确认才物理移除 + 追加账本。" §7:112："删除一条记录时，从 ... records.json 中移除该 id 的所有版本行，并不在记录内写墓碑。"
- **证据** 现网实现相反：`apps/arkui-schedule/entry/src/main/ets/model/undoDelete.ts:6–10, 21–24` 在 `schedule()` 时就写 `deleted:true` 墓碑版本（落盘），撤销再追加 `deleted:false`。v2 明令废除墓碑，但没把 §14 的推荐升为规范。
- **影响** Stage B 若照搬现有撤销流程会直接违反 §7；若按 §14 推荐实现，崩溃发生在确认前的语义（记录仍在 vs 已删）没有定义，且 §12 差异清单未登记这一行为翻转。
- **建议改法** 把 §14 第 1 条提升为 §7 的 Normative 规则："删除确认前不写账本、不改 `records.json`，5 秒窗口纯内存；确认 / 超时才原子执行物理移除 + 追加账本；确认前崩溃 = 记录未删。"并在 §12 差异清单新增一行"删除撤销：v1 先写墓碑 / v2 先内存宽限"。

### P1-5 — 迁移的媒体解包被文档写进 Stage B，实际工具已推迟且模块未登记

- **引用** §10:192："附件：把 `devices/<id>/attachments/<date>.zip` 解包到 `timeline/<date>/media/`，按 sha256 在同日内去重，文件名与记录索引改为 `<sha256[0:16]>.jpg` + `{file,sha256,pageIndex}`……"
- **证据** 磁盘上 `tools/migrate-v1-to-v2.mjs:7–8`："不读 registry.jsonl、不读 attachments/*.zip、不读 chats/，也不创建任何媒体文件。媒体占位由后续模块 mod-v2-media-migration 负责补位。" 该模块未出现在 `docs/MODULES.md:20–30` 的索引里。
- **影响** 按契约验收迁移会判定"媒体未搬运 = 迁移未完成"；按工具验收则媒体永久缺失，而 §5:100 要求缺文件即导出 / 导入失败。两条路都不闭合，且「后续模块」无人登记意味着无人交付。
- **建议改法** 二选一并写进 §10 与 MODULES.md：① Stage B 必须实现 zip 解包（工具补齐后再宣称完成）；② 把 §10 步骤 3 改为："本阶段只把 v1 `attachments` 映射为 `media` 占位；真实文件搬运 / 解包由 `mod-v2-media-migration` 完成，在它交付前导出 / 导入按 §5:100 的缺文件即失败规则处理"，并在 `docs/MODULES.md` 登记该模块及依赖。

### P1-6 — "fast-forward only" 与 `pull --rebase` 混用

- **引用** §9:155："拉取走 fast-forward only（当前仓库用 `pull --rebase`）"；§9:157、§9:162 重复该口径。
- **证据** v1 插件 `bridge.ts:268, 287–288` 走的正是 `pullRebase` + `commitAll` + `pushWithRebase`；`docs/SCHEDULE-BRIDGE.md:69–73` 也把 rebase 写成写前步骤。
- **影响** rebase 不是 fast-forward：只要有任何代码路径（例如 outbox 回滚失败）在本地留下提交，pull 会改写它，并可能与同日 `records.json` 文本行冲突——这会产生 git 级冲突 UI / 人工介入，直接违反 §3:40"无冲突 UI"。
- **建议改法** 统一为："写前断言本地 HEAD == `origin/main`（branch 固定 main），拉取只用 `git pull --ff-only`；若本地 ahead 则以 `E_LOCAL_PENDING` 拒绝写入并要求先按 §9:162 的回滚重放路径处置，禁止 rebase 改写本地提交。"如确需保留 rebase 兼容支路，必须写明它只在无本地提交时等价于 ff，且冲突时不进入 UI 而是回滚重放。

### P1-7 — `mod-v2-dual-read` 与"绝不双读"正面冲突

- **引用** §1:11："切换后不再读任何 v1 日程路径，也不存在双读。" §10:202："**绝不引入双读**，也不尝试把 v2 新写的数据反向合并回 v1。"
- **证据** `docs/MODULES.md:28`：`mod-v2-dual-read` — "App 同时读 v1/v2，写入仍 v1（灰度）"，状态"待开始"，依赖 `mod-v2-contract`、`mod-v2-migration`。
- **影响** 两个已登记的产品决定无法同时执行：一个模块索引承诺交付双读灰度，契约承诺永不双读。若 Phase B 真按 MODULES.md 做灰度，§10 的单向迁移 / 回滚 / 版本门槛全部需要重写。
- **建议改法** 二选一：从 `MODULES.md` 删除或标注"已否决（与 v2 §1/§10 不双读冲突）"；或在 §10 新增受控灰度节，明确双读期的读写分工、冲突裁决、结束条件，并把 §1:11 / §10:202 的绝对表述改成"最终状态无双读；灰度期为例外，规则见新增节"。

### P1-8 — `records.json` 的"语义并集"与 §9 的"重放意图"是两套未统一的机制

- **引用** §3:40："冲突时走 §9 的语义并集（按 id 取较晚 ts），无冲突 UI。" §9:159–162 却只定义了 pull → 读 → 应用 intent → 写回 → push 的读—改—写协议，没有定义任何 `mergeDayFile` 等价物。
- **证据** v1 有明确的语义合并函数 `model/recordMerge.ts:293–325`（`mergeRecordLines` / `mergeDayFile`，且 `conflictIds` 非空时调用方"先不要写回"，:309–310）；v2 既没有保留这个函数，也没有把它改造成静默版。
- **影响** 实现者不知道 git 文本冲突时该调用语义合并还是回滚重放；若选择文本合并（"一条一行可逐行合并"的暗示），同日文件尾行同时追加会产生 git 冲突，与"无冲突 UI"矛盾。
- **建议改法** 在 §3:40 后补："'语义并集'不是 git 文本合并：本契约不提供 merge driver；一切写入走 §9 读—改—写；若 git 报告文本冲突，按 §9:162 的 push-rejected 路径回滚本地提交、重拉、重放意图，绝不进入冲突选择 UI。"并在 §13:235 废止清单中明确 `gitMerge` 的 per-device union 策略被"重放意图"取代。

### P2 汇总（均为局部措辞 / 规范化 / 簿记修正）

| ID | 引用 | 证据 / 影响 | 具体改法 |
| --- | --- | --- | --- |
| P2-1 | §3:68–82 与示例 §3:49–50 | 字段表顺序为 `...media, ocr_text, ai_structured, ai_processed, ocr_time, opened_at, closed_at`，示例却是 `...media, ai_processed, ocr_text, opened_at`；:82 又要求"已知字段按上表顺序写出"。规范序列化不可判定。 | 让示例严格按字段表顺序重写，并在 §3:40 加"规范序列化函数必须产出与示例逐字节一致的键序，纯逻辑单测覆盖" |
| P2-2 | §6:106 | "`done=false` 或 `closed_at` 缺省者进 open"是 OR；v1 `model/openIndex.ts:259–261` 的权威谓词是 `closedAt` 缺省。数据在迁移 / 脏数据下两者可不一致，重算结果不唯一。 | 改为："未完成 iff `closed_at` 缺省（空串等同缺省）；`done` 只作展示，不参与判定；与 v1 `isOpenEntryOpen` 同口径" |
| P2-3 | §7:114 vs §9:160 | 账本"只追加、绝不重写历史行"与"规范化写回该日文件夹（原子替换）"矛盾；整文件替换会在字节层面重写账本。 | 改为："`deleted.jsonl` 只能以 open-for-append 追加；若实现采用整文件原子替换，写前必须验证旧内容是新内容的严格前缀，且新内容 = 旧行原序 ∪ 本次新增行" |
| P2-4 | §11:206 | 文档要求内容为 `{"schemaVersion": 2}`；磁盘工具 `tools/migrate-v1-to-v2.mjs:325` 写入 `{schemaVersion:2, migratedAt, source:'v1'}`。 | 把 §11:206 改为"至少含 `schemaVersion: 2`；允许非语义元数据键，读侧只解析 `schemaVersion`"，或要求工具只写一个键（二选一并同步测试） |
| P2-5 | §7:124 | `deletedAt` 要求"ISO 8601，带本地偏移"；工具 `isoFromTs()`（:108–110）产出 `...Z`。 | 明确"`Z` 视为合法的零偏移写法，迁移后不强制换算本地偏移"，或要求工具输出 `±HH:MM` |
| P2-6 | §1:13 | 删除 `username` 设置项后，v1 Gitee HTTPS 必填登录名（`docs/DATA-CONTRACT.md:123`、`docs/SCHEDULE-BRIDGE.md:90`）无替代来源。 | 补："HTTPS 下 Gitee 用户名从 token 侧 / repoUrl userinfo 推导；推导不出时报 `E_AUTH` 并说明下一步"，或把 `username` 列为精简后的唯一例外 |
| P2-7 | §6:108 vs §4:91 | "跨日按 id 合并（较晚 ts 胜）"与"记录永不换天"矛盾：若真出现跨日同 id，静默合并等于承认换天。 | 改为："同一 id 出现在两个日文件夹属数据损坏，按目录名分别计数并上报，不静默合并；正常路径下不可能出现" |
| P2-8 | §10:186 | 检测规则没定义"同时存在 `devices/` 与 schema 标记"和"两者都不存在"。迁移提交只新增 timeline 不删 devices（§10:198），所以前者是**迁移后的常态**。 | 补优先级："schema 标记优先；`schemaVersion===2` 即 v2，无论 `devices/` 是否存在。两者都无 → 空仓库，按 v2 初始化并写标记。" |
| P2-9 | §10:202、§14:258 | 回滚只 revert 迁移提交；但 §14 推荐后续清理提交物理删除 v1 文件，届时单独 revert 迁移提交无法恢复 v1 数据；`docs/MODULES.md:14` 要求多提交模块逆序回滚，契约未提。 | 补："若已执行 v1 清理提交，回滚必须先逆序 revert 清理提交再 revert 迁移提交；否则只能恢复到 v2 状态，不得宣称 v1 可读" |
| P2-10 | `docs/MODULES.md:26` | `mod-v2-contract` 状态"进行中"准确，但回滚路径写 `git revert <hash>`（纯文档，无代码风险）——文档与 MODULES.md 本身均为未跟踪文件（`??`），**不存在可 revert 的 hash**；实际回滚是删除未跟踪文件。另 `mod-v2-migration` 仍标"待开始 / 待建"，而磁盘已有工具与测试，索引未随工作更新（违反 MODULES.md §0.5）。 | （本文不改）把该行回滚路径改为："未提交前删除未跟踪文件 `docs/DATA-CONTRACT-v2.md` 即可；提交后再改为 `git revert <hash>`";并让 Lead 把 `mod-v2-migration` 状态 / 文档位置补实 |
| P2-11 | §5:97 vs 工具 `migrate-v1-to-v2.mjs:248` | 文档说 `file` = `<sha256[0:16]>.jpg`（文件名，不含目录）；工具写 `file: "media/<sha>.jpg"`（含目录前缀）。 | 补一句 Normative："`file` 是不含路径的文件名；所在目录由 §5:96 的 `timeline/<date>/media/` 给出，任何写入端不得带 `media/` 前缀" |
| P2-12 | §1:13、§2:35 | "分支固定 main"只是声明；插件 `bridge.ts:423` 仍从 settings 读 `settings.branch`，无断言。 | 在 §11 门禁加一条："写前断言当前分支与 upstream 均为 `main`，否则 `E_BRANCH_MISMATCH`；任何设置里的 `branch` 值一律忽略" |
| P2-13 | §7:112、§7:129 | 删除时"物理移除该 id 的所有版本行"，而并集 / 读侧过滤又允许"records 里还有该行但被过滤"。merge 时命中账本 id 的行到底物理删不删未明说。 | 补："合并 / 规范化时允许保留命中账本的行（读侧仍过滤）；物理移除只是删除意图的即时效果，不是账本生效的前提" |

---

## 4. 必须在 Stage B 前改 / 可以留到 Stage C

**必须在 Stage B 前改（阻塞开工）**
1. P0-1 同 ts 不同内容的 tie-break（写进 §4 + §15 纯逻辑断言）。
2. P0-2 唯一 `assertWritable()` 门禁 + 7 类写路径清单 + pull 后复查（写进 §11）。
3. P1-1 outbox `attempts` 跨重放语义与 `exhausted` 终态。
4. P1-2 `intentId` 去重规则与 `applied-intents.json`。
5. P1-3 重放遇 schema / date / 已删 id 的 typed 失败。
6. P1-4 删除撤销窗口从 §14 升为 §7 规范（含崩溃语义）。
7. P1-5 媒体解包归 Stage B 还是新模块——二选一并登记模块。
8. P1-6 `pull --ff-only` + 本地 ahead 拒绝（去掉 rebase 与 ff 混用）。
9. P1-7 双读模块与"绝不双读"二选一。
10. P1-8 明确"语义并集 = 重放意图，不是 git 文本合并"。
11. P2-8 v1 检测优先级（schema 标记优先）。
12. P2-10 MODULES.md 回滚路径修正（本文不改，交 Lead / 模块负责人）。

**可以留到 Stage C（不阻塞 Stage B 编码）**
- P2-1 键序与示例对齐（可在第一个 canonical serializer 测试里一起修）。
- P2-2 `open` 谓词收敛、P2-7 跨日同 id 视为损坏、P2-11 `file` 前缀、P2-13 merge 时账本命中行的处理。
- P2-3 账本 append-only 措辞（Stage B 实现时顺手写对即可，但文字要先对齐）。
- P2-4 schema.json 额外键、P2-5 `deletedAt` 的 Z 形式（工具与文档对齐即可）。
- P2-6 Gitee username 推导、P2-12 分支断言（设置精简模块落地时处理）。
- P2-9 清理提交与回滚顺序（真正的 v1 清理提交发生时再钉）。
- §14 其余 4 条开放项（媒体前 16 位碰撞、账本压缩、generatedAt 单位、v1 文件清理时机）保持推荐态即可。

---

## 5. 门闸证据（verbatim tails）

工作目录：`C:\Users\GWL\Desktop\itwillclaude\dsh-sync-suite`。评审期间磁盘上有其他模块并发写入的未跟踪文件
（`tools/migrate-v1-to-v2.mjs`、`apps/arkui-schedule/tools/test/v2Migration.test.mjs`，写入时间 22:46 起持续变动），
因此"字面 gate 命令"在评审窗口内**反复波动**：22:47 曾 1 例瞬时失败
（`actual: '  "date": "2026-11-19",' / expected: '  "schemaVersion": 2,'`），22:49 为 2336/2335/0/1，
22:55 一度 2336/2332/3/1，22:56 又回到 2336/2335/0/1。这些波动全部来自并发未提交的迁移模块，
与本文评审的文档无关。**稳定的 docs-only 基线是下面单独复核的 2306 / 2305 / 0 / 1。**

**① `node apps/arkui-schedule/tools/overlay.mjs status`**
```
覆盖层：未应用（工作区为「共享源码 + 平台目录」的原始形态）
[overlay] applied=false
EXITCODE=0
```

**② `node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json`**
```
（无输出）
EXITCODE=0
```

**③ `node --test "packages/dsh-dots/test/*.test.mjs" "apps/arkui-schedule/tools/test/*.test.mjs"`**
某次稳定快照（含未跟踪迁移测试，共 107 个测试文件；该命令在评审窗口内会随并发写入波动，见上文）：
```
ℹ tests 2336
ℹ suites 309
ℹ pass 2335
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 27218.2586
EXITCODE=0
```
docs-only 基线复核——只跑 106 个**已跟踪**测试文件（`git ls-files` 枚举，排除并发新增的未跟踪测试；两次运行结果一致）：
```
ℹ tests 2306
ℹ pass 2305
ℹ fail 0
ℹ skipped 1
EXITCODE=0
```
与任务书给的期望 **2306 / 2305 / 0 / 1** 完全一致。

**④ `node apps/arkui-schedule/tools/validate-app.mjs`**
```
🔍 校验 ArkUI-X 工程：C:\Users\GWL\Desktop\itwillclaude\dsh-sync-suite\apps\arkui-schedule
✅ 全部通过：8/8 条规则（JSON5/JSON 70 个、相对 import 355 条、main 静态 import 448 条、页面 7 个、rawfile/git 2 个文件）
EXITCODE=0
```

---

## 6. `unverified`

1. 真机 / 第二设备 / PC 双端并发：全部 `unverified`（`hdc list targets` 为空、无 DevEco / SDK），与 v2 §15 一致；本文对 Check 2 / Check 3 的"收敛"判断是**基于文字规则的推演**，不是实测结论。
2. §11 门禁在真实 App / 插件代码中的可强制性：`unverified`——契约尚未实现，无法验证 P0-2 的建议门禁是否真能覆盖全部写路径。
3. outbox 在真实 push 拒绝 / 响应丢失场景下的行为：`unverified`（P1-1 / P1-2 未定，且无双端环境）。
4. 媒体 JPEG q60 / ≤1440、同日 sha256 去重、zip 解包的实际字节与体积：`unverified`（无真机、无实现）。
5. 迁移工具对**真实仓库**的解包 / 逐字节校验 / 崩溃重跑：`unverified`——只做了文档与工具源码的静态对照；工具仍在被其他模块并发修改。
6. `docs/MODULES.md` 的行状态会随其他模块更新而漂移；P2-10 的描述以评审时刻（2026-11-19 22:49）磁盘状态为准。
7. v2 文档行数以磁盘 276 行计；任务书所称 175 行未在任何快照中观察到，可能是派发时的陈旧元数据。
