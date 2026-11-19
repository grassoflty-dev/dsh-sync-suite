# 数据契约 v2（单时间线）

> 状态：**Stage A 草案 v2-draft-2**，只描述切换后的目标状态，尚未进入实现。在切换发生前，`docs/DATA-CONTRACT.md`（v1）仍是现网数据的唯一权威契约，本文件不修改它。凡涉及真机 / 第二设备 / 双端并发的结论，一律标 `unverified`（见 §15）。
> 修订记录：v2-draft-1 → **v2-draft-2**（2026-11-19，按 `docs/REVIEW-v2-contract.md` 的 P0/P1 修订；顺带修正该评审的 P2-3、P2-10 及若干可测性措辞）。**未改变任何已定决策**：一条记录一行、物理删除 + 账本、仅仓库级 schema 门槛、无根索引、`opened_at/closed_at`、分支 `main`、设置精简、单向迁移、不同 `ts` 的 silent-later-ts-wins。
> 提交 / 回滚说明（P2-10）：本文件当前为**未跟踪文件**，不存在可 `git revert` 的哈希。提交前回滚 = 删除本文件；提交哈希**待 Lead 提交后回填**（`docs/MODULES.md` 里 `mod-v2-contract` 行的回滚路径同样待 Lead 回填）。本文不自称"可按 hash 回滚"。

## 1. 目的与范围

v2 替换的是 v1 的**日程时间线域**：`devices/<deviceId>/schedules/*.jsonl`、`devices/<deviceId>/summaries/*.json`、`devices/<deviceId>/attachments/<date>.zip`、`devices/<deviceId>/open.jsonl`、`devices/registry.jsonl`、`.device-fingerprint`，以及配套的「每台设备只写自己目录 / per-device union 合并 / 设备标识自动分配与抢占」。替换为一条**所有设备共同读写**的共享时间线 `timeline/<date>/`。

不在本文范围、语义完全不变的部分：`chats/`（云端对话的接管制，见 v1 §10）、配置同步载荷文件（`cordis.patch.yml` / `providers.json` / `plugins.json` / `mcp.json` / `manifest.json`，见 v1 §2）、远程访问域（v1 §7）、AI fallback 诊断（内存不落盘，v1 §9）。

与 v1 的关系：本文是 additive 新文档；切换通过**一次性单向迁移**（§10）与仓库级标记 `timeline/schema.json`（§11）完成。**切换后 `devices/**` 日程路径零写入**；唯一的 v1 读取是 `mod-v2-dual-write-off` 在迁移窗口内（flag `v1ReadFallback`，硬截止 2026-12-31）的**只读兜底展示**，它既不把 v1 合并进 v2，也不写 v1。窗口结束删除该 flag 与全部 v1 读路径后，**最终状态无双读、无 v1 写入**（§10、§13、§15 的模块行同步此口径）。旧的 `mod-v2-dual-read`「同时读 v1/v2、写入仍 v1」灰度方案**否决**，不得实现。

仓库级假设（本契约只需声明这些；设置 UI 属后续阶段）：远端是唯一私有仓库；**分支固定为 `main`**；v2 的同步设置只保留 `{ repoUrl, token }` 两项——`deviceId`、`branch`、`scope`、`authMode`、`platform`、`username` 均不再是设置项；HTTPS + Gitee 的登录名从 token 侧或 `repoUrl` 的 userinfo 推导，推导不出报 `E_AUTH` 并给出下一步，不恢复 `username` 设置项（P2-6）。token 仍遵循 v1 的凭据卫生规则（只经环境变量 / 临时 askpass 传递，不进仓库、不进日志、不进 UI 与状态响应）。

## 2. 仓库布局

```
<repo>/
  timeline/
    schema.json                  # { "schemaVersion": 2, ... }，仓库级兼容标记（§11）
    2026-11-19/
      records.json               # 当日全部记录（一条一行）+ date/open 元信息（§3、§6）
      summary.json               # 当日 AI 汇总（§8）
      deleted.jsonl              # 追加式删除账本（§7）
      restore.jsonl              # 追加式撤销账本（§7、P1-4）
      conflicts.jsonl            # 追加式 tie-break 审计（§4、P0-1）
      media/
        ab12cd34ef567890.jpg     # <sha256[0:16]>.jpg，散图进 git（§5）
    2026-11-20/  ...
  chats/                         # 不变（接管制，v1 §10）
```

约定：

| 约定 | 规则 | 可测 |
| --- | --- | --- |
| 无设备命名空间 | **没有 `devices/<deviceId>/…`**：所有设备写同一批文件；没有设备目录、注册表、per-device 合并 | 目录遍历结果中不含 `devices/` 时间线子路径 |
| 无根索引 | **没有根 `index.json`**（Designer 决策）：全局索引会让每次保存写同一文件（持续合并争用）并引入漂移的第二事实来源。逃生口：若将来确有全局索引需求，只能在本地**派生**（内存 / 本机缓存），永不提交进仓库，也不作为写入目标 | 写入路径集合不含仓库根级 `index.json` |
| 分支 | 固定 `main`；配置同步载荷与 `chats/` 路径不变；写前必须断言当前分支与 upstream 均为 `main`（§11） | 分支为 `feature/x` 时写操作返回 `E_BRANCH_MISMATCH` 且零写入 |
| 日期目录 | `timeline/<date>/` 的 `<date>` 必须是合法日历日 `YYYY-MM-DD`；读侧遇非法目录名跳过并计数，不崩溃 | 目录 `2026-13-99` 被跳过，计数 +1，其他日正常读取 |

## 3. `records.json` 形状

**一条记录占一整行**：文件整体是合法 JSON 对象，其中 `records` 数组的每个元素各自独占一行；`open` 与 `records` 是唯二会变长的数组。规范序列化：固定键顺序（严格按下表顺序，缺席的可选字段直接省略）、对象内部无多余空格、每行一个 `\n`、文件末尾恰好一个换行。这样不同设备新增的不同记录落在不同物理行。

**规范序列化唯一性（P2-1 / P0-1 前置）**：必须存在纯函数 `canonicalRecordLine(record)`，其输出与本节示例的字节（含键序）逐字符一致；tie-break（§4）与判重（§9）只在这一种字节形状上进行。可测：同一记录对象序列化两次字节相等；人为交换两字段次序后重新规范化 → 字节恢复为示例序。

两条记录的完整示例（键序即为规范键序）：

```json
{
  "date": "2026-11-19",
  "open": ["m9x2k1-3fk"],
  "records": [
  {"id":"m9x2k1-3fk","ts":"2026-11-19T09:30:00+08:00","title":"周会","body":"讨论同步方案","author":"我","done":false,"media":[],"ai_processed":false,"opened_at":"2026-11-19T09:30:00+08:00"},
  {"id":"n0y3l2-8ab","ts":"2026-11-19T14:00:00+08:00","title":"体检","body":"","author":"我","done":true,"media":[{"file":"ab12cd34ef567890.jpg","sha256":"ab12cd34ef567890abcdef0123456789abcdef0123456789abcdef0123456789","pageIndex":0}],"ocr_text":"体检单","ai_processed":true,"opened_at":"2026-11-19T14:00:00+08:00","closed_at":"2026-11-19T15:20:00+08:00"}
  ]
}
```

顶层字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `schemaVersion` | — | **本文件不含**此字段。版本只在仓库级 `timeline/schema.json` 声明（理由见本节末）。 |
| `date` | string | `YYYY-MM-DD`，创建时写入，必须等于所在目录名；目录名为权威，`date` 不符时记日志并按目录名处理并上报 `E_CORRUPT`，不崩溃、不新建目录（P2-8 关联）。 |
| `open` | string[] | 当日未完成记录 id 列表，写时派生（§6）；读侧不信任，陈旧即忽略并从 `records` 重算。 |
| `records` | object[] | 当日全部版本行；每个元素独占一行；读侧按 id 折叠，较晚 `ts` 胜、`ts` 相同按 §4 tie-break。 |

记录字段（键序即此表顺序）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 全局唯一（时间戳 base36 + 随机后缀），跨设备折叠键。 |
| `ts` | string | ISO 8601 带本地时区偏移（如 `2026-11-19T09:30:00+08:00`）；既是版本顺序键，也是日期归属键（§4）。**秒级、且在意图入队时固定，重放时不得重新生成**（§9）。 |
| `title` | string | 标题。 |
| `body` | string | 正文，可编辑。 |
| `author` | string | 记录者。 |
| `done` | boolean | 完成情况。 |
| `media` | object[] | `{file, sha256, pageIndex}`，指向同日 `media/` 下的散图（§5）。`file` 是**不含路径的文件名**，任何写入端不得带 `media/` 前缀（P2-11）。 |
| `ocr_text` | string? | 手写 OCR 原始结果，**只读不改**。 |
| `ai_structured` | string? | AI 结构化结果，可编辑。 |
| `ai_processed` | boolean | 是否已 AI 处理。 |
| `ocr_time` | string? | 识别时间（AI 载荷使用）。 |
| `opened_at` | string | 本条记录「未完成会话」的开始时刻（创建 / 取消完成后重新打开时写入），取代 v1 的 per-device `open.jsonl`（§6）。 |
| `closed_at` | string? | 会话结束时刻；缺省 = 当前仍未完成。完成时间统计 = `closed_at - opened_at`，迁移后必须保持可算（§10）。 |

**未知字段必须原样保留**：编码时已知字段按上表顺序写出，未知扩展字段排在末尾且值不变；读侧不因未知字段报错、不丢弃。校验失败的行跳过并计数，不中断整日读取（沿用 v1 `parseJsonl` 的 fail-soft 口径）。可测：注入未知字段 `"x":1` → 读写往返后仍存在且排在已知字段之后。

**`schemaVersion` 的决定：只放在仓库级 `timeline/schema.json`，不放进单个 `records.json`。** 理由：兼容门槛必须先于任何文件读写，集中在一个小标记文件里判断最可靠；若每份日文件各带一份副本，N 份副本必然漂移，等于重新引入被 §2 拒绝的「第二事实来源」；整仓由单向迁移原子切换，所有日文件按构造同版。代价是单看一个日文件无法自证版本，但该信息由它所在仓库的标记提供，不构成缺口。

## 4. 记录标识、版本与同 `ts` 裁决

| 规则 | Normative 内容 | 可测 |
| --- | --- | --- |
| 版本模型 | `id` 全局唯一；同一 `id` 可有多行，每行是一个版本（沿用 v1 事件溯源）。同一天内按 `ts` 升序折叠，**不同 `ts` 时较晚者静默胜出（later-ts-wins）**，无冲突 UI（已定决策，不改）。 | 两行同 id、ts 09:30 与 10:00 → 折叠结果为 10:00 |
| **P0-1 tie-break** | 若同一 `id` 的两行 `ts` **字节相同而规范整行不同**，取**规范整行 JSON 按 UTF-8 字节序字典序较大者**胜出（比较函数 = `Buffer.compare(Buffer.from(lineA,'utf8'), Buffer.from(lineB,'utf8'))`；等价的 JS 字符串 UTF-16 比较仅在纯 ASCII 规范行上等价，故以 UTF-8 字节序为准）。裁决同样**静默**、不进入任何冲突 UI；读侧把这类行计入 `equalTsResolved` 计数并写一行行为日志。**败者不丢**：union 写阶段把败者原样追加进当日 `conflicts.jsonl`，供人工恢复。 | 两设备同 `(id,ts)` 不同 body → 双方折叠结果逐字节一致；败者行出现在双方 `conflicts.jsonl` 且仅一份（按 dedupeKey 去重） |
| `conflicts.jsonl` 行 | 追加式，一行一条：`{"id":"m9x2k1-3fk","ts":"2026-11-19T09:30:00+08:00","losingLine":"{...}","decidedAt":"2026-11-19T10:02:11+08:00","dedupeKey":"<sha256(losingLine)>"}`。至少含 `id`、`ts`、`losingLine`；`dedupeKey = sha256(规范 losingLine)`，按 `(id, ts, dedupeKey)` 去重，重复重放不追加第二行。并集合并（§9）。 | 同一冲突重放 3 次 → 审计文件只增 1 行 |
| 读侧 purity | 读路径只计数、不写盘；审计追加只发生在 union 写阶段（§9），因此纯读函数可在冻结文件系统上运行。 | 以只读方式挂载仓库执行 `foldById` → 成功且 `equalTsResolved` 计数正确 |
| `ts` 精度问题（P0-1 关联） | `ts` 为秒级 ISO 8601（与 v1 `nowIso` 逐字符同形），两设备在同一秒各跑 `nextTsSameDate` 完全可能得到相同 `ts` 字节；并列是**常态而非异常**，必须靠上面的 tie-break 兜底。 | 固定时钟注入同一秒 → 两端生成的 `ts` 相同，tie-break 仍给出唯一胜者 |
| **不新增 `rev` 字段（决策）** | 本版**不引入** `rev` 计数器。理由（3 句）：① 胜者只由两份内容的字节决定，与设备、行序、到达顺序无关，两端无需通信即可算出同一结果，也不需要冲突 UI；② 败者原样进 `conflicts.jsonl`，人工可按 `(id, ts)` 恢复，满足"不丢数据"；③ 加 `rev` 就要定义默认值、旧行兼容与迁移期混排规则，扩大字节形状变更面，而同一秒内的两次编辑仍可能给出相同 `rev`，并不能根除并列。 | 记录字段集合中不存在 `rev`；旧行（无 `rev`）可直接参与折叠 |
| 日期固定 | `ts` 前 10 位是日文件夹键。**记录永不换天**：新记录可由用户创建时选定任意日期（`tsForDate` 语义保留），既有记录日期在 creation 固定；编辑 / 勾选完成只追加同 id、同日更晚 `ts`，不存在改期路径。某 id 的所有版本都落在同一个 `timeline/<date>/records.json`。 | 编辑既有记录 → 新行 `ts` 前 10 位与原行相同；不存在改写入口 |

## 5. 媒体

- 手迹截图在图库侧先压成 **JPEG q60、最长边 ≤1440px**，再作为**散文件**提交进 git（不做按天 zip）；仓库体积增长被接受。可测：压缩函数对固定输入产出 q60 / 最长边 1440 的字节参数常量。
- 文件落在 `timeline/<date>/media/`；命名 `<sha256[0:16]>.jpg`（sha256 小写十六进制前 16 位）。可测：sha256 字符串 → 文件名恰为前 16 位 + `.jpg`。
- 记录里的索引元素为 `{file, sha256, pageIndex}`：`file` = 上述**文件名（不含 `media/` 前缀，P2-11）**，`sha256` = 完整 64 位十六进制，`pageIndex` 为 0 起的页序。所在目录恒由 `timeline/<date>/media/` 给出。可测：`file` 含 `/` 或 `..` → 校验失败并计数。
- **同一天内按 sha256 去重**：同内容只写一份文件，多条记录可索引同一 `file`；跨天不合并。前 16 位同日碰撞时逐步延长前缀直到唯一，完整 sha256 仍存记录里（§14 开放项 2）。
- 删除记录**不删除媒体文件**：媒体只增不减；清理是未来维护话题。
- 导出 / 导入必须**连同 `media/` 文件一起搬运**：导出复制记录引用的媒体文件；导入放回目标日 `media/` 并校验 sha256，缺文件视为导入失败而非静默丢图。
- 源文件、解压缓存等仍只存在本机沙箱，不进仓库。

**P1-5 媒体迁移范围**：媒体解包**不属于 Stage B（本契约所属阶段）**。Stage B 只交付 records / summaries / 删除与撤销账本 / 冲突审计；真实 zip 解包与文件搬运归独立模块 **`mod-v2-media-migration`**（其自身模块条目、测试与回滚路径由该模块交付时登记，本文件不改 `docs/MODULES.md`）。在该模块落地前，`timeline/<date>/media/` 可能只有空目录；记录仍按本节写 `file:"<sha16>.jpg"`（即指向 `timeline/<date>/media/<sha16>.jpg`），**app 遇到目标文件缺失时必须显示类型化占位文案 `媒体待迁移`，绝不显示破图、不触发重复加载**。可测：给定一条 `media[].file` 存在但磁盘无对应文件 → 渲染结果为占位组件而非图片错误态。

迁移实现见 `mod-v2-media-migration`（`tools/migrate-media-v1-to-v2.mjs`）：Node 内建 ZIP 读取（stored/deflate + CRC-32 校验），**不支持 ZIP64 与加密条目**（遇到即逐条报错、不落盘）；`archive` 字段决定媒体归属日期；`--apply` 前必须已有 `timeline/schema.json`。v1 `devices/**/attachments/*.zip` 在 v2 切换前保持原样、不删不改。

## 6. 未完成索引

- v2 **没有独立的 `open.jsonl` 文件**：未完成会话的 `opened_at` / `closed_at` 直接写在记录里（§3）；`records.json` 顶层的 `open` 数组只是当日「未完成 id」的派生缓存。
- **`open` 派生谓词（P2-2，与 v1 `isOpenEntryOpen` 同口径）**：**未完成 iff `closed_at` 缺省（空串等同缺省）**；`done` 只作展示，不参与判定。旧草案的「`done=false` 或 `closed_at` 缺省」OR 谓词废止（脏数据下结果不唯一）。取消完成 = 重新打开一个新会话（刷新 `opened_at`、清 `closed_at`），时间统计以最新会话为准。可测：`{done:false, closed_at:'...'}` → 不在 `open`；`{done:true, closed_at:null}` → 在 `open`。
- **读侧不信任 `open`**：若与从 `records` 重算的结果不一致，视为陈旧并忽略，以重算结果为准；不因为 `open` 陈旧就判定数据损坏。
- **没有跨日索引文件**：「全部未完成」靠遍历 `timeline/<date>/` 目录逐日读 `records.json`、折叠后过滤未完成项。复杂度 O(天数 × 当日记录数)，可在内存缓存并在写入 / pull 后失效，缓存绝不落进仓库。
- **跨日同 id 属损坏（P2-7）**：在"记录永不换天"（§4）前提下，同一 id 出现在两个日文件夹不可能来自正常路径；读侧按目录分别计数并上报 `E_CORRUPT`，**不静默合并**。可测：两个日文件夹放同 id → 报错且两日各自计数，不产生单一胜者。

## 7. 删除与撤销

**物理删除**：删除一条记录时，从 `timeline/<date>/records.json` 中移除该 id 的所有版本行，并**不在记录内写墓碑**（v1 的 `deleted:true` in-record tombstone 已废弃）。

**账本**：删除必须写进追加式的按日删除账本 `deleted.jsonl`（JSONL，一行一条，只追加、绝不重写历史行）：

```json
{"id":"m9x2k1-3fk","ts":"2026-11-19T16:00:00+08:00","deletedAt":"2026-11-19T16:00:00+08:00","intentId":"<uuid>"}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 被删记录 id。 |
| `ts` | string | 触发删除的版本时间（与记录 `ts` 同形）；用于与 `restore.jsonl` 比先后。 |
| `deletedAt` | string | 删除发生时刻；`Z` 视为合法零偏移写法，迁移后不强制换算本地偏移（P2-5）。 |
| `intentId` | string? | 产生该条目的意图 id，供重放判重（§9 P1-2）。 |

**P1-4 删除撤销（Normative，取代 §14 旧推荐）**：

| 时点 | 动作 | 是否写盘 |
| --- | --- | --- |
| `schedule()`（点删除） | 追加 `deleted.jsonl` 一条（`ts` = 该 id 新版本时间，`intentId` = 删除意图 id）；**不动 `records.json` 行**，暂不 push；启动 5 秒 UI 倒计时 | 写账本；记录行保留 |
| `cancel()`（5 秒内撤销） | 追加 `restore.jsonl` 一条 `{"id":"...","ts":"<严格晚于删除 ts>","restoredAt":"..."}`；随后 commit + push 两条账本 | 写撤销账本；记录行保留、不移除 |
| `confirm()` / 超时 | 才物理移除该 id 的全部版本行并重算 `open`；commit + push 账本 + `records.json` | 原子替换 `records.json` |

- 5 秒窗口是**纯 UI 宽限期**，不是数据延迟：账本在 `schedule()` 时即落盘（与 v1"墓碑在 schedule 时落盘"同口径），因此远端立刻能看到删除；崩溃发生在确认前 = 账本在、记录行也在，读侧按下面优先级视为已删（不丢删、也不误复活）。
- `restore.jsonl` 只追加、并集合并；只有发出对应删除的 UI 能产生 restore 行，其他设备永不生成。
- **读侧优先级（精确规则）**：对每个 id，令 `D = max(ts of deleted.jsonl[id])`，`R = max(ts of restore.jsonl[id])`。**可见 iff 存在 `R` 且 `R > D`（严格大于）；`R` 不存在或 `R ≤ D`（含相等）→ 不可见**。可见后再按 §4 折叠 `records.json` 版本。读侧统一入口 `visibleRecords(records, deleted, restored)`，列表 / 详情 / 汇总 / 未完成索引全部调用它（P1-4 / P1-3 共用）。
- 物理移除只在 `confirm()` / 超时的 origin 设备执行，是带 `intentId` 的幂等 outbox 意图；其他设备**不因看到账本而自行清行**，只套用读侧过滤，保证最终状态与执行顺序无关。可测：`D.ts=10,R.ts=11` → 可见；`D.ts=11,R.ts=10` → 隐藏；`D.ts=R.ts=10` → 隐藏（删除胜）。
- 账本条目永不过期、无 TTL、不自动清理，确保任何未来编辑都无法让已删记录复活。

**并集合并**：所有设备的 `deleted.jsonl` / `restore.jsonl` 行取并集（每行是独立事实；`deleted` 按 `(id, ts, intentId)` 去重，`restore` 按 `(id, ts)` 去重），不做「缺行 = 撤销」。

**为什么不能只做「把行删掉」而不留账本**（结论不变）：① A 物理删行 + B 并发追加编辑版本会在 git 层撞同一文件，无统一规则易丢一侧；② 即便文本合并成功，B 的较晚版本会在读侧折叠后"自己回来"——账本用一条独立于记录、单调累积的事实挡住复活（§9 P1-3 进一步规定重放遇到已删 id 时丢弃 upsert）。

**P2-3 写方式对照（消除 §9 与本节矛盾）**：

| 文件 | 写方式 | 内容生成规则 |
| --- | --- | --- |
| `records.json` | **原子替换**（tmp + rename） | 按 id 折叠 + §4 tie-break 后的**排序并集**；物理移除行只发生在确认删除意图 |
| `deleted.jsonl` | **只追加**（open-for-append，禁止整文件替换） | 若实现用整文件原子替换，写前必须验证旧内容是新内容的**严格前缀**，且新内容 = 旧行原序 ∪ 本次新增行（并集、不重排、不丢历史行） |
| `restore.jsonl` | 只追加 | 同上前缀规则；按 `(id, ts)` 去重 |
| `conflicts.jsonl` | 只追加 | 同上前缀规则；按 `(id, ts, dedupeKey)` 去重 |
| `summary.json` | 原子替换 | `generatedAt` 较新者胜；相等保留现有 |
| `media/` | 只新增文件 | 按 sha16 去重；同名不同内容报 `E_MEDIA_SHA16_COLLISION`，不覆盖 |

可测：并发追加两条不同 id 的删除后，账本旧字节是新字节的严格前缀且两行都在。

清理责任：v2 中**无人自动清理**账本；将来如压缩须是显式、离线协调全设备的新维护操作，且必须先处理仍被引用的 id（§14 开放项 3）。

## 8. 每日汇总

- AI 每日汇总落在同一天文件夹、与 `records.json` 平级的独立文件 `timeline/<date>/summary.json`；不再有 `summaries/` 目录。
- 语义与 v1 完全一致（`model/dailySummary.ts`），结构为：

```json
{"version":1,"date":"2026-11-19","generatedAt":1763558400000,"model":"deepseek-chat","provider":"日程 AI","headline":"今日要点","points":["周会","体检"],"recordCount":2,"doneCount":1}
```

- `generatedAt` 为 epoch 毫秒（§14 开放项 4 保持推荐）；**同日多份以 `generatedAt` 较新者胜，相等保留现有**（v1 `mergeSummary` 口径不变）。可测：两份 generatedAt 100 / 200 → 留 200；相等 → 留原文件字节。
- 生成失败 / 陈旧回复不得覆盖上一次成功汇总（先 AI 后写盘、读旧合并再写），坏文件按 v1 的 `empty` / `corrupt` 口径处理，不抛、不静默覆盖。

## 9. 同步协议（单一同步周期：union → replay）

**总原则**：先取远端最新状态，在其上做**语义并集**，再应用本地意图，最后提交推送；任何失败都必须可见；**绝不允许产生一个停留在本地、从未推送成功却不告知用户的提交**（无静默本地未推提交）。

**唯一门禁**：本周期任何写操作前必须调用 `assertWritable()`（§11），否则一个字节都不动。

**P1-6 拉取策略（选定：fetch + 语义并集，不用 rebase）**：整条链路**不运行 `git pull --rebase`、不运行 `git merge`、不设 merge driver**。每周期固定命令序列：

| 阶段 | 步骤 | 命令 / 纯函数 | 失败处理 |
| --- | --- | --- | --- |
| 0 门禁 | `assertWritable()`：读 `timeline/schema.json`、断言分支 `main`、本地 HEAD == `origin/main` | 纯逻辑 + `git rev-parse` | 未知 schema → `E_SCHEMA_UNKNOWN`；缺标记 + `devices/` → `E_MIGRATION_REQUIRED`；本地 ahead → `E_LOCAL_PENDING`（意图全部留在 outbox）；均零写入 |
| 1 union（阶段一） | `git fetch origin main`；对每个受影响日：解析 HEAD 版与 FETCH_HEAD 版 `records.json` → 按 id 并集 + §4 tie-break；并集 `deleted/restore/conflicts.jsonl`；`summary.json` newer-wins；`media/` 按 sha16 取文件并集 | `unionDay(baseLine, remoteLine)`（纯函数） | 任一侧不可解析或 `date` 与目录名不符 → `E_CORRUPT`，整日不动、意图留 outbox |
| 2 replay（阶段二） | 在本地真值（仓库外 outbox）中按入队顺序逐条应用意图到 union 结果（规则见下） | `applyIntent(intent, unionState)`（纯函数） | 见 P1-3 三条 typed 失败 |
| 3 落盘 / 推送 | 按 §7 表写各文件（records 原子替换、账本只追加）→ `git add timeline/<date>`（仅受影响日）→ `git commit` → `git push origin main`（`force:false`） | shell | push 被拒（非快进）→ `git reset --hard origin/main`（本地唯一真值在仓库外 outbox，故不丢数据）→ 回到阶段 0 重来；同一意图最多 4 次（P1-1） |

- **"union" 与 "intent replay" 是同一周期的两个阶段，顺序固定如上（P1-8）**：阶段一负责把两端已提交的事实收敛成一个确定性的当日视图；阶段二负责把本机尚未提交的事实叠加进去。**outbox 是周期之间唯一的本地真值**，仓库里不存在"本地已提交但没推成功"的中间态。
- **语义并集不是 git 文本合并**：本契约不提供 merge driver、不逐行合并文本；由于从不调用 `git merge`，**不会产生冲突标记**。出现真正无法裁决的情况（任一侧 `E_CORRUPT`、或 push 连续被拒耗尽）时：整日回退、意图留在 outbox、报 typed 错误；若曾误触发 git merge，必须 `git merge --abort` 并校验工作副本中冲突标记数为 0，绝不进入冲突选择 UI。可测：注入不可解析的远端日文件 → 工作副本无冲突标记且该日文件字节未变。

**本地 outbox（仓库之外，按仓库区分）**：

| 端 | 路径 | 文件形态 |
| --- | --- | --- |
| App | `<filesDir>/sync-outbox.json`（在 `git-repo/` 之外） | JSON 数组，原子替换写（tmp + rename） |
| 插件 | `%USERPROFILE%\.dsh\dots\outbox\<repoHash>.json`（在工作副本 `work/<repoHash>/` 之外） | JSON 数组，原子替换写 |

每条意图（intent）形状（payload 一旦入队**不可变**）：

```json
{"intentId":"<uuid>","op":"upsert","date":"2026-11-19","record":{"id":"...","ts":"<入队时固定>"},"enqueuedAt":"2026-11-19T16:05:00+08:00","attempts":0,"maxAttempts":4,"state":"pending","lastError":""}
```

`op` 为 `upsert` / `delete` / `purgeRows`（撤销确认后的清行，§7）；`delete` 与 `purgeRows` 用 `id` 字段代替 `record`。`attempts` 为**跨会话累计**的已尝试次数，`maxAttempts` 恒为 4，`state` 为 `pending` / `syncing` / `failed`。

**P1-1 重试预算（Normative）**：`maxAttempts = 4` 是**每个 `intentId` 全生命周期的总次数**，持久化在 outbox 中，**新会话 / 重新启动 / pull 成功都不重置**。每次进入阶段 3 前 `attempts += 1` 并落盘；push 被拒走阶段 0–3 重来，`attempts` 继续累计。达到 4 仍未成功 → `state = failed`，停止自动重放，意图继续留在 outbox，UI 持续显示 `N 条待同步（最近失败：<typed 原因>）` 且可见可点条目；**只有用户在 UI 点「重试」**才原子地 `attempts = 0, state = pending` 重新入队。可测：固定失败注入 4 次 → 第 4 次后无自动重放、计数可见；点重试后 attempts 归零。

**P1-2 `intentId` 幂等（选定：内容判重，不引入 applied-intents 文件）**：

| op | 判重方法（阶段二执行前） | 可测 |
| --- | --- | --- |
| `upsert` | 意图的 `record.ts` 在入队时固定（**重放不得重新生成**，废止旧草案的"按最新状态取更晚 ts"）；若 union 结果中已存在**逐字节相同的规范行**（含 id、ts、全部字段），则该意图是 no-op，直接从 outbox 出队。若存在同 `(id, ts)` 但内容不同的行，按 §4 tie-break 裁决：无论我方胜败都视为已应用（胜败是确定性的），出队；败者由 union 写阶段落入 `conflicts.jsonl` | 同一意图重放两次 → 第二行不出现；响应丢失导致的重复推送不产生重复历史行 |
| `delete` | 若 union 的 `deleted.jsonl` 已存在同 `intentId`（或同 `(id, ts)`）的条目 → no-op，出队 | 重复重放 delete → 账本只增 1 行 |
| `purgeRows` | 若该 id 版本行已不存在 → no-op，出队 | 重复执行清行 → 幂等 |

出队时机：操作幂等落地后先原子更新 outbox 再递减 UI 计数；任何失败都不出队、不丢意图。

**P1-3 重放前置检查（每条意图，按顺序）**：

| 情况 | 规则 | 可测 |
| --- | --- | --- |
| (a) 远端已升到未知 schemaVersion | 意图留在 outbox、本机切只读、报 `E_SCHEMA_UNKNOWN`，零写入（重放前**重新调用 `assertWritable()`**，不是只查一次） | 注入 schemaVersion=3 → 意图仍在 outbox、文件 mtime 不变 |
| (b) 日期目录缺失或 `records.json.date` ≠ 目录名 | `upsert` 的 `date` 在入队时固定且 == `ts` 前 10 位，**正常路径不可能出现**（记录永不换天，§4）；一旦出现即判 `E_CORRUPT`、停在该条、**不新建目录** | 篡改 date 字段 → 报 E_CORRUPT 且无新目录产生 |
| (c) id 已在目标日 `deleted.jsonl`（删除胜） | 丢弃该 upsert 意图并**出队**，在同步报告 / UI 计数 `droppedDeleted`，显示「该记录已被删除，编辑未同步」；**绝不复活、绝不按成功清除待同步计数** | 先删后重放旧 upsert → 记录不可见且计数进 droppedDeleted |

**P2-13**：合并 / 规范化时**允许保留命中账本 id 的 `records.json` 行**（读侧仍过滤）；物理移除只是删除意图的即时效果，不是账本生效前提。可测：保留被删行 → `visibleRecords()` 仍返回空。

**可见状态（typed，配合 `docs/STATE-UI.md` 三态）**：`已同步` / `同步中` / `N 条待同步（最近失败：<typed>）` / `只读（仓库结构版本不认识，见 §11）` / `离线（展示本地副本）`。失败类型至少含 `E_SCHEMA_UNKNOWN`、`E_MIGRATION_REQUIRED`、`E_BRANCH_MISMATCH`、`E_LOCAL_PENDING`、`E_CORRUPT`、`E_DELETED_REMOTELY`（报告用）、`E_PULL_FAILED`、`E_PUSH_REJECTED`、`E_IO`、`E_AUTH`；任何失败必须给类型 + 中文原因 + 下一步动作，不静默吞掉。

## 10. 兼容与迁移

**v1 检测优先级（P2-8）**：`timeline/schema.json` 存在且 `schemaVersion === 2` → v2，无论 `devices/` 是否存在（迁移提交只新增 `timeline/` 不删 `devices/`，故"两者并存"是迁移后常态）；标记存在但版本不认识 → 只读（`E_SCHEMA_UNKNOWN`）；标记缺失但 `devices/` 存在 → v1、需迁移（`E_MIGRATION_REQUIRED`）；两者都不存在 → 空仓库，按 v2 初始化并写标记。可测：四种 (标记, devices/) 组合 → 四个确定分支。

**单向迁移（v1 → v2），切换后不再读 v1 路径（P1-4 与 P1-5 已并入）**：

1. **预检 + dry-run（不写）**：确认所有 v1 日程 / 附件 / 汇总 / open 数据可读，产出计划与计数，任何解析失败先暴露给用户。
2. 建 `timeline/` 与各日文件夹（含空的 `deleted.jsonl` / `restore.jsonl` / `conflicts.jsonl`）；对全部 v1 设备目录下 `schedules/<date>.jsonl` 的每行按 `ts` 前缀归入 `timeline/<date>/records.json`（一条一行，同 id 取较晚 ts、同 ts 用 §4 tie-break 并把败者写进 `conflicts.jsonl`），字段与未知字段原样保留。
3. **附件（P1-5 收窄）**：本阶段**只把 v1 `attachments` 映射为记录中的 media 占位**（`{file:"<sha16>.jpg", sha256, pageIndex}` 按原 zip 条目 `page-<pageIndex>-<sha8>.jpg` 还原页序，完整 sha256 从 v1 记录 `attachments[]` 取）；**不读 `attachments/<date>.zip`、不创建任何媒体文件**。真实解包 / 搬运 / 同日去重由独立模块 **`mod-v2-media-migration`** 交付；在那之前 app 按 §5 显示 `媒体待迁移` 占位，绝不破图。
4. **open / 完成时间**：把 v1 `open.jsonl` 的 `openedAt` / `closedAt` 合并进对应记录的 `opened_at` / `closed_at`（无条目用 `ts` 补 `opened_at`），保证完成耗时仍可算。
5. **删除**：v1 墓碑版本折叠后最终为已删 → 物理移除版本行，在 `deleted.jsonl` 写一条 `{id, ts, deletedAt: ts}`（`deletedAt` 的 `Z` 形式合法，P2-5）；若存在更晚恢复版本则保留记录、不写账本、并按 §7 写 `restore.jsonl`。
6. **汇总**：把 `devices/<id>/summaries/<date>.json` 归到 `timeline/<date>/summary.json`，多端以 `generatedAt` 较新者胜。
7. **最后写标记** `timeline/schema.json`：它是提交边界——标记未落地时读侧仍按 v1；标记**至少含 `schemaVersion: 2`**，允许 `migratedAt` / `source` 等非语义键，读侧只解析 `schemaVersion`（P2-4）。

不变量：**幂等**（已有标记则 no-op 或明确拒绝重跑）、**crash-safe**（每个日文件夹原子写，标记最后落地）、**逐字节校验**（写完回读、重新规范化后比对字节与 sha256、核对记录总数无丢失，产出报告）、dry-run 与实际迁移共用同一套映射与校验逻辑。迁移 commit **只新增** `timeline/` 与标记，不删除 v1 文件；切换后读侧除 §1 的 `mod-v2-dual-write-off` 只读兜底外完全忽略 v1 路径。

**chats/ 不迁移**；`devices/registry.jsonl` / `.device-fingerprint` / per-device `open.jsonl` / per-device scopes 不迁移、作废（§13）。

**回滚与模块（P2-9 / P1-7）**：先 `git revert` 迁移提交移除 `timeline/` 与标记，v1 读侧恢复；**不引入双读**，也不把 v2 新数据反向合并回 v1。若已执行 §14 开放项 4 的 v1 清理提交，回滚必须**先逆序 revert 清理提交、再 revert 迁移提交**，否则只能恢复到 v2 状态，不得宣称 v1 可读。`mod-v2-dual-write-off` 的读兜底窗口截止 2026-12-31 后随源码一并移除；被否决的 `mod-v2-dual-read` 不参与任何回滚路径。

## 11. 兼容性门槛与唯一写入口（P0-2）

- 仓库级标记 `timeline/schema.json` **至少**含 `{"schemaVersion": 2}`（允许额外非语义键，读侧只解析 `schemaVersion`，P2-4）。App 与插件各自必须在启动时、每次周期阶段 0、以及每次写盘 / `git commit` 之前调用**唯一门禁** `assertWritable()`（纯函数 + 一次标记读取），返回 `OK` / `E_SCHEMA_UNKNOWN` / `E_MIGRATION_REQUIRED` / `E_BRANCH_MISMATCH`。
- **规则（强制）**：`read timeline/schema.json` 必须发生在**打开任何 `timeline/**` 文件的写句柄之前**；未知 / 缺失但 `devices/` 存在 → 拒绝并返回 typed `E_SCHEMA_*`，**零写入**（一个字节都不动、不产生本地提交、不 push）。可测：把 schemaVersion 改为 99 后逐条触发下表所有写路径 → 每条都返回 typed 错误且仓库文件哈希 / mtime 不变。

**必挂门禁的写路径清单（缺一即视为未实现）**：

| # | 写路径 | 证据（v1 现状） | v2 要求 |
| --- | --- | --- | --- |
| 1 | App 保存 / 勾选完成 / 编辑 | `scheduleStore.appendRecord` → `appendLineSync`（`services/scheduleStore.ets:308–326,386–404`） | 经 §9 周期；阶段 0 过门禁后才落盘 |
| 2 | App 删除 / 撤销 | `model/undoDelete.ts`（`schedule()` 时写墓碑） | 改为 §7 账本 + restore；经周期与门禁 |
| 3 | pull 合并写回（union 写阶段） | v1 无此函数 | 阶段 1 前过门禁；只在 HEAD/FETCH_HEAD 版本上写 |
| 4 | 迁移工具 | `tools/migrate-v1-to-v2.mjs:325,366–372` | **仅"写 schema 标记"这一动作豁免**（它本身在建立标记）；标记落地后任何后续写仍须过门禁 |
| 5 | 插件 `schedule_*`（`bridge.ts`） | `ScheduleBridge.add` → `pullRebase → appendFile → commitAll → push`（`bridge.ts:266–288`） | 改为 §9 周期；删除 `pullRebase`，阶段 0 过门禁 |
| 6 | 插件其余 `schedule_*` 写 action | 与 `bridge.ts` 共用 `GitRepo` 提交设施 | 逐一挂同一门禁，不得另起写通道 |
| 7 | 导出 / 导入恢复 | `docs/EXPORT-IMPORT.md:172–175`、`exportService.appendImportPlan` | 导入落点改 `timeline/`、搬运媒体；经周期与门禁，不直接 append |
| 8 | outbox 重放 | §9 阶段二 | **每条意图重放前重查门禁**（P1-3(a)） |

**例外清单**：`chats/` 与配置同步载荷文件（`cordis.patch.yml` 等）**不受 `timeline/**` 只读约束**——未知 schema 时只停 `timeline/**`，这些路径可继续按 v1 语义读写（§1 范围不变）。可测：schemaVersion=99 时写 chats 成功、写 timeline 失败。

**分支断言（P2-12）**：阶段 0 同时断言当前分支与 upstream 均为 `main`；插件 `bridge.ts:423` 仍从 settings 读 `settings.branch`，v2 一律忽略该值，不匹配报 `E_BRANCH_MISMATCH`，零写入。可测：settings.branch='dev' 且当前分支为 main → 仍按 main 执行、不报分支错；实际 checkout 到 dev → 报 `E_BRANCH_MISMATCH`。

## 12. 与 v1 的差异清单

| 项 | v1 | v2 | 影响面 |
| --- | --- | --- | --- |
| 目录结构 | `devices/<id>/{schedules,summaries,attachments,open.jsonl}` | `timeline/<date>/{records.json,summary.json,deleted.jsonl,restore.jsonl,conflicts.jsonl,media/}` | 全部存储路径与迁移 |
| 设备命名空间 | 每设备一目录、只写自己 | 无设备目录、所有设备写同一批文件 | 合并策略、设置、权限范围 |
| 记录载体 | 按日 JSONL，一条一行 | `records.json`，一条一行 + `date/open` 元信息 | 编解码、语义并集 |
| 媒体 | 按天 zip | 散图 `media/<sha256[0:16]>.jpg` 进 git；解包归 `mod-v2-media-migration` | 附件、导出导入、仓库体积 |
| 未完成索引 | per-device `open.jsonl` | 记录内 `opened_at`/`closed_at` + `open` 派生（谓词：`closed_at` 缺省） | 完成时间统计、全部未完成查询 |
| 删除 | 记录内墓碑版本 | 物理移除 + `deleted.jsonl` 账本过滤 | 删除、并发编辑、复活防护 |
| **删除撤销** | `schedule()` 写墓碑，撤销追加 `deleted:false` 版本 | `schedule()` 写账本（记录行保留），撤销追加 `restore.jsonl`，读侧 later-of-(D,R) 裁决 | UI 宽限语义、账本形状（P1-4） |
| **同 ts 裁决** | 同 id 同 ts 内容不同 → 真冲突上 UI | 规范行字节字典序较大者胜 + `conflicts.jsonl` 审计，无 UI | `foldById`、审计文件（P0-1） |
| 分支 / 设置 | 分支可选、设置含 deviceId/scope 等 | 分支固定 `main`、设置只 `{repoUrl, token}` | 设置 UI、git 配置 |
| 合并 | per-device union，冲突上 UI | fetch + 语义并集（阶段一）→ 意图重放（阶段二），无冲突 UI | `gitMerge` 废除、outbox |
| 全局索引 | 无 | 不设根 `index.json`，本地派生 | 架构决策 |
| 版本门槛 | 无仓库级标记 | `timeline/schema.json` + 唯一 `assertWritable()` + 8 类写路径清单 | 启动 / 写前检查 |
| 迁移 | — | 一次性单向、dry-run + 校验 + 标记；媒体占位先行 | 切换流程、回滚 |
| 同步失败 | 失败清理分散 | 仓库外 outbox + `maxAttempts=4` + `failed` 终态 + 可见 `N 条待同步` | 失败语义、UI 状态 |
| **双读灰度** | — | `mod-v2-dual-write-off`：切换后 v1 零写入，仅一 release 只读兜底（截止 2026-12-31）；`mod-v2-dual-read` 否决 | 模块计划、回滚（P1-7） |

## 13. 明确废止与明确保留

**废止（v2 不再存在、实现中不得残留分支）**：

- `devices/<deviceId>/…` 整个设备命名空间与「只写自己目录」不变量；
- `devices/registry.jsonl`、设备编号自动分配与 push 抢占、`deviceIdentity` / `.device-fingerprint` 指纹冲突判定；
- per-device `open.jsonl`、`mergeDeviceIndexes` 跨设备合并、`gitMerge` 的 per-device union 合并策略（其职责由 §9 的"语义并集 → 意图重放"两阶段取代，P1-8）；
- per-device 同步 scopes / `assertSchedulesScope` 式按设备白名单（改为按 `timeline/` 路径范围）；
- 设置里的 `deviceId` / 可选 `branch` / `scope` / credential 之外的设备相关字段；
- 记录内删除标记的墓碑机制（§7 旧机制）与按天附件 zip（解包归 `mod-v2-media-migration`）；
- 根 `index.json` / 任何入库的全局索引；
- **模块 `mod-v2-dual-read`（"同时读 v1/v2、写入仍 v1"灰度）**：与 §1/§10 的"切换后 v1 零写入 + 最终无 v1 读"冲突，正式否决，不得实现（P1-7）。替代模块为 **`mod-v2-dual-write-off`**：切换时立即停掉所有 v1 写入，仅保留一 release 的只读兜底（flag `v1ReadFallback`，硬截止 **2026-12-31**），到期删除 flag 与全部 v1 读路径；最终状态无双读。可测：flag 关闭后源码中不存在任何 `devices/**schedules` 读路径。

**保留（语义与字节形状不变）**：

- `ts` 的 ISO 8601 + 本地偏移形状与首 10 位作日期键；
- `nextTsSameDate`（同一天、更晚 ts）与**不同 ts** 的 `later-ts-wins` 静默折叠；同 ts 按 §4 新 tie-break（不冲突）；
- 三态 UI（加载 / 空 / 错误）与失败必须解释原因 + 下一步；
- 凭据卫生（token 不进仓库 / 日志 / UI / 状态响应）与 no-silent-failure 纪律；
- 导出 / 导入的**意图**（只读派生导出、append-only 导入、绝不覆盖、fail-closed），但落点改为 `timeline/` 并搬运媒体（§5）；
- `chats/` 的接管制语义与配置同步载荷文件；
- **独立媒体模块 `mod-v2-media-migration`**：Stage B 不做解包，记录用媒体占位 + `媒体待迁移` 类型化文案（P1-5）。

## 14. 未决问题（4 条，均附推荐）

1. **媒体文件名只用 sha256 前 16 位，同日碰撞怎么办？** 推荐：同日检测到前 16 位碰撞时逐步延长前缀直到唯一，完整 sha256 仍存记录里；碰撞极罕见，不为它引入子目录。
2. **`deleted.jsonl` / `restore.jsonl` 何时、由谁清理？** 推荐：v2 永不清；只在将来做一个显式的、离线协调全设备的压缩工具，且必须先确保没有记录仍引用被清理 id。
3. **`summary.json` 的 `generatedAt` 单位是否改动？** 推荐：保持 epoch 毫秒（与 v1 `DailySummary` 一致），不为 v2 改成 ISO 字符串，避免破坏已验证的 newer-wins 语义。
4. **迁移完成后 v1 文件何时物理删除？** 推荐：不在迁移提交里删；验证通过后另起一个清理提交删除旧 `devices/` 日程数据，仍保持单向、可 revert；若已执行该清理提交，回滚须先逆序 revert 它再 revert 迁移提交（§10）。

## 15. 验证要求

以下场景必须在**真机 + 第二设备 / PC**上验证后，v2 写入才可发布。设备相关场景当前全部标 `unverified`（真机环境不可用，`hdc list targets` 为空；无 DevEco / SDK）；纯逻辑断言可在实现后立刻以 Node / 注入时钟覆盖。

| 场景 | 断言 | 状态 |
| --- | --- | --- |
| 两设备同日各建不同记录 | fetch + union + replay 后双方都看到两条、无丢行；结果逐字节一致 | `unverified` |
| 同 id 不同 ts 两设备各编辑 | 较晚 `ts` 静默胜、无冲突 UI（已定决策） | `unverified` |
| **同 id 同 ts 不同内容（P0-1）** | 两设备折叠结果逐字节一致；败者进双方 `conflicts.jsonl` 且仅一份；`equalTsResolved` 计数正确 | 纯逻辑可测（待实现）；双端 `unverified` |
| A 删除 + B 并发编辑同 id | 同步后两设备都视为不存在、不复活；旧 upsert 意图按 P1-3(c) 丢弃并计入 `droppedDeleted` | `unverified` |
| 删除撤销（P1-4） | `D.ts<R.ts` 可见、`R.ts≤D.ts` 隐藏；5 秒内撤销只追加 `restore.jsonl`；确认后行被物理移除 | 纯逻辑可测（待实现）；双端 `unverified` |
| 媒体链路与占位（P1-5） | JPEG q60 / ≤1440；同日 sha256 去重；模块落地前缺文件显示 `媒体待迁移` 而非破图；导出导入搬运且校验 | 参数 / 占位纯逻辑可测；双端 `unverified` |
| 完成时间统计 | `opened_at`/`closed_at` 保存与迁移后均可算出完成耗时；`open` 谓词只看 `closed_at` | `unverified` |
| 每日汇总 | `generatedAt` 较新者胜，陈旧 / 失败不覆盖 | 纯逻辑可测（待实现） |
| schema 门槛（P0-2） | 未知版本 → 只读、零写入（比对工作副本哈希 / mtime）；§11 表 8 类写路径逐条过门禁；chats / 配置例外可继续写 | 纯逻辑可测（待实现）；端侧 `unverified` |
| 拉取策略（P1-6） | 只用 `fetch` + 语义并集，无 rebase / 无冲突标记；push 被拒 `reset --hard origin/main` 后重来 | `unverified` |
| outbox 重试 / 幂等 / 重放（P1-1..3） | `maxAttempts=4` 跨会话累计、`failed` 终态仅手动重试；重复重放 no-op；schema/date/已删 id 三条 typed 失败 | 纯逻辑可测（待实现）；双端 `unverified` |
| 写方式对照（P2-3） | records 原子替换、三本账本只追加且旧字节为新字节严格前缀、summary newer-wins、media 只增 | 纯逻辑可测（待实现） |
| 迁移 | dry-run 无写、幂等、崩溃可重跑、逐字节校验通过、媒体占位正确、revert 回滚后 v1 可读且无双读 | `unverified` |
| 模块口径（P1-7） | `mod-v2-dual-write-off` 一 release 只读兜底（截止 2026-12-31）到期移除；`mod-v2-dual-read` 无实现；`mod-v2-media-migration` 独立登记 | 源码静态断言可测；端侧 `unverified` |

此外仍需补齐的工程门（同样 `unverified`）：真实双端 git 并发下的并集稳定性、仓库体积增长对 fetch 耗时的影响、ArkTS 严格类型编译与 Node 纯逻辑测试在改动后的全绿（当前 v2 尚无实现，故无测试结果）。
