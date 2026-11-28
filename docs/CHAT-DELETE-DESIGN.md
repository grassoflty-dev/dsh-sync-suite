# 云端会话删除（CHAT-DELETE）设计

> 状态：**设计稿（本轮零代码、零契约改动、零 `.ets`）**，2026-11-27。模块 `mod-chat-delete-design`。
> 上位约束：`docs/DATA-CONTRACT-v2.md` §1/§2/§11、`docs/CHAT-SYNC.md` §2/§6、`docs/REMOTE-INSTANCES.md`。
> 行号均为本轮实读工作树（路径相对 `dsh-sync-suite/`）。「新增」= 提案，今天不存在；真机 / 双端并发结论一律标「未验证」。
> 产品语句（权威）：会话在云端，不绑定任何 DSH 实例或平板；删除是**单次、手工**动作并存入云端 git；实例的增删与会话无关。

## 1 现状事实（实读，不重新推导）

| 事实 | 证据 |
| --- | --- |
| 会话三件套在云端仓库；平板只读，无写 / 删 API | `apps/arkui-schedule/entry/src/main/ets/services/chatStore.ets:2-13,28-31,123-126,147-174,182-228,231-232` |
| 唯一写入者是桌面插件；index 只追加 | `packages/dsh-dots/src/chats/exportChats.ts:2-8,347-391,393-411,449-490`；`docs/CHAT-SYNC.md:114-121,435` |
| 索引行投影固定 5 字段，按 id 折叠取最后一行 | `exportChats.ts:52,385-386`；`apps/arkui-schedule/entry/src/main/ets/model/chatList.ts:39-53,297-346`（`chatList.ts:334-335` 后写覆盖） |
| 二次导出覆盖 `session.jsonl`/`meta.json`，但 index 仍追加 | `exportChats.ts:479-487`；`docs/CHAT-SYNC.md:434-436` |
| 会话类型**不含实例键**；端点无实例字段 | `src/chats/types.ts:107-148`、`chatList.ts:39-53`、`chatStore.ets:24-25` 均无 `instanceId` / `pairingInstanceId`（grep 仅命中 `instanceof`，`exportChats.ts:426,433`）→ 正交性成立 |
| v2 周期只认 `timeline/**`；越界提交判非本模块 | `packages/dsh-dots/src/sync/cycle.ts:100-101,127-132,163-177,208-242,762-765` |
| `chats/` 被契约明列在 v2 之外 | `docs/DATA-CONTRACT-v2.md:11,32,41,303,349` |
| 今天没有任何会话删除、没有任何墓碑字段 | 上述类型 / 读写路径全表；「未验证」（仅本工作树实读，无全仓语义搜索） |

## 2 决策：追加**墓碑行**，不重写索引

| 方案 | 代价 | 结论 |
| --- | --- | --- |
| 重写 `chats/index.jsonl`（删行 + 原子替换） | 推翻 `exportChats.ts:393-399` 与 `docs/CHAT-SYNC.md:435` 的「从不重写已有字节、首行字节永不变」；两台设备同时追加时必然撞同一文件，要么丢一行要么引入 `records.json` 级别的 union / 冲突裁决（`DATA-CONTRACT-v2.md:99,161`）；工作副本与已推送历史产生索引分叉；每次删除都要走一次 rebase / 有界恢复（`cycle.ts:984-1049`） | 否 |
| **追加墓碑行 + 读侧折叠** | 每个读者都要学会新字段与折叠规则（`exportChats.ts:347-391`、`chatList.ts:297-346`、`docs/CHAT-SYNC.md:114-121`）；索引永远只增、无压缩路径；导出器必须查墓碑，否则复活（§4） | **是** |

理由（一句话）：产品要求「删除这件事存进云端 git」，而 `chats/index.jsonl` 的唯一既有写入语义是**事件式追加**（`exportChats.ts:394-399`）；把删除写成一条新事件，是唯一不需要改写历史、也不需要给单一共享追加文件发明合并算法的形状。

**墓碑行形状（新增，只追加）**：在同一个 `index.jsonl` 里追加第六字段行
`{"id":"<sessionId>","op":"delete","deletedAt":"<ISO>","sha256":"<被删前投影行的 sha256>"}`。
不新增文件、不动 `meta.json` / `session.jsonl`；普通行仍严格 5 字段（`exportChats.ts:52`），只有墓碑行带 `op`。

**折叠规则（读侧统一，纯函数）**：

| 规则 | 内容 |
| --- | --- |
| 普通行 | 同 id 取**最后一行**（沿用 `chatList.ts:334-335`、`exportChats.ts:385-386`） |
| 删除 | 只要该 id 出现过合法 `op:"delete"` 行，就**永久**从投影中移除；后续再出现普通行也无效（delete 优先、单调、不可逆） |
| 合法性 | `id` 过 `assertSafeSessionId` 同款白名单（`exportChats.ts:199-204`；平板 `chatStore.ets:48`）；`deletedAt` 必须可解析；坏行只计数不改状态（`chatList.ts:294,310-322`） |
| 无撤销 | 产品语句是单次删除；**不定义 restore 行**，因此不需要 `DATA-CONTRACT-v2.md:145-157` 的 D/R 比先后 |

读侧落点：插件 `readChatIndex` 在 `ChatIndexSnapshot` 增加 `deletedIds`（`types.ts:150-160`），app `parseChatIndex` 在 `ChatIndexParse` 增加同名字段并从 `entries` 剔除（`chatList.ts:55-60,337-345`）；`loadChat` 需先查该集合，命中则返回 typed「会话已删除」，不能只靠文件缺失。

## 3 谁能写删除，以及另一端做什么

| 问题 | 决策 | 依据 / 代价 |
| --- | --- | --- |
| 作者 | **两端都可以**：各自追加一条墓碑行到 `chats/index.jsonl`，各自提交；平板需新增一条**窄写通道**（删除意图 → 追加墓碑 → commit/push），不走 `timeline/**` 周期 | 产品语句明确会话不绑定实例或平板；若只许一端写，等于重新引入绑定。平板写通道是新成本，「未验证」（真机不可测） |
| 另一端收到后 | 同步工作副本后重跑折叠：列表隐藏、详情 typed 删除、导出器跳过；**不回写、不重发、不清理**任何 `chats/**` 文件 | 与 v2「他端不自行清行、只套读侧过滤」同口径（`DATA-CONTRACT-v2.md:156`） |
| 语义粒度 | 一次一条 `id`，显式用户动作；**禁批量、禁按实例级联、禁自动触发**；墓碑只带 id + 时间，不带实例键或设备归属 | 正交性来自 `types.ts:107-148` 与 `chatList.ts:39-53` 无实例字段 |
| 桌面 DSH 本地会话删除 | **忽略，绝不镜像**：本地 zstd 文件消失不构成云端删除，只有显式「删除云端会话」动作才写墓碑 | 「会话在云端、不绑定实例」；镜像会把本地事件错误提升为全局事实 |
| 与实例增删的关系 | 零耦合：添加 / 移除 DSH 实例不读写 `chats/**`，不产生墓碑 | `DATA-CONTRACT-v2.md:11`、`REMOTE-INSTANCES.md:48-52`（实例表不进 git） |

## 4 收敛：A 删、B 不得复活；导出器尤其不得复活

**失败路径（必须先看清）**：`exportChatsToRepo` 无条件把本机会话构建为导出项（`index.ts:132-176`，默认 `local.slice(0, limit)` 在 `:160`，显式 id 在 `:145-158`），`uploadChats` 用 `writeFile` **覆盖** `session.jsonl`/`meta.json`（`exportChats.ts:479-480`）并追加新索引行（`:481-487`）。源 zstd 会话还在 → 下一次导出必然重新发布已删会话。**光在列表页隐藏不算删除。**

**反复活机制（三层，缺一不可）**：

| 层 | 动作 | 证据落点 |
| --- | --- | --- |
| 1 选中前过滤 | `exportChatsToRepo` 先读 `chats/index.jsonl` 的 `deletedIds`，显式 id 路径与默认路径都跳过命中 id，记 `reason:"deleted"`；**不构建、不上传** | 新增于 `index.ts:137-176` |
| 2 写盘前复核（纵深） | `uploadChats` 每会话在 `appendIndexLine` 前重读墓碑集合，命中即跳过该会话并置 `ok:false`（与现有 fail-closed 风格一致，`exportChats.ts:493-497`）；关闭 TOCTOU 窗口并保护其它调用方 | 新增于 `exportChats.ts:468-490` |
| 3 读侧永不翻身 | 墓碑单调优先（§2），即便某端误追加普通行也不会重新可见 | `chatList.ts:323-345`、`exportChats.ts:355-390` |

`readChatExportStatus` 的 `pending` 也必须排除已删 id（`index.ts:76-94`），否则 UI 会持续提示「待导出」。
**不要求删除本地 zstd 会话**（保留源，风险见 §7）；这是"保留但仍不再发布"的明确取舍。

**必抓复活的确切测试**：构造 fake repo + 含会话 `S` 的 `sessionsRoot`；第一次写入 `S` 的普通索引行并提交；追加 `S` 墓碑行提交；第二次以**同一 `sessionsRoot`（源会话仍在）** 调 `exportChatsToRepo(... push:true)`。断言：索引文件的旧字节仍是新字节的严格前缀、没有新增 `S` 的普通行、`results` 中 `S` 不是 `ok:true`（为 `deleted`）、`readChatIndex` 投影无 `S`。追加变异测试：手工在墓碑后再写一行 `S` 普通行 → 投影仍无 `S`。

## 5 归属门禁改造与路径白名单证明

**必须改的原句（逐字）**：

| 位置 | 原文 | 新文（提案） |
| --- | --- | --- |
| `cycle.ts:130` | `只有带本尾注 + diff 全在 timeline/** 才算本模块提交。` | `只有带本尾注 + diff 全在白名单路径（timeline/** 或恰为 chats/index.jsonl）才算本模块提交。` |
| `cycle.ts:101` | `确认本地领先提交是否带 dsh-dots-v2 尾注且只改 timeline/**` | `确认本地领先提交是否带 dsh-dots-v2 尾注且只改 timeline/** 或 chats/index.jsonl` |
| `docs/DATA-CONTRACT-v2.md:11` | 见下方逐字引用 | 首句收窄为「`chats/` 下除 `chats/index.jsonl` 墓碑追加以外的路径」，其余三类不变；同步改 `:32,:303,:349` 的「chats 不变」措辞 |

> `DATA-CONTRACT-v2.md:11` 原文：「不在本文范围、语义完全不变的部分：`chats/`（云端对话的接管制，见 v1 §10）、
> 配置同步载荷文件（`cordis.patch.yml` / `providers.json` / `plugins.json` / `mcp.json` / `manifest.json`，见 v1 §2）、
> 远程访问域（v1 §7）、AI fallback 诊断（内存不落盘，v1 §9）。」
> 新文只把第一处的「`chats/`」改为「`chats/` 下除 `chats/index.jsonl` 墓碑追加以外的路径」，并把「语义完全不变」限定为「其余部分语义完全不变」。

**新谓词（不是放宽 `startsWith`，而是精确白名单）**：
`isConfinedSyncPath(p) = (p === 'chats/index.jsonl') || isConfinedTimelinePath(p)`；
`isOursCommit`（`cycle.ts:172-177`）与 `describePendingOwnership`（`:208-242`，现用 `:215` 的旧谓词）**共用同一个** `isConfinedSyncPath`，避免出现"判定算 ours、解释算 untrusted"。subject 形状（`:146-149`）、尾注（`:140-144`）、`paths.length>0`（`:175`）一条不放宽。提交类不另立：墓碑提交带同一 `dsh-dots-v2:` 尾注，subject 用 `chats: delete <id>` 并在 `isV2CommitSubject`（`:147-149`）里加一种形状（否则属主判定仍会否掉）。

**必须继续拒绝的路径（机械化表驱动，不靠散文）**：

| 路径 | 判定 | 原因 |
| --- | --- | --- |
| `devices/pc-a/schedules/2026-11-27.jsonl`、`devices/registry.jsonl` | 拒 | 不在白名单 |
| `cordis.patch.yml`、`providers.json`、`plugins.json`、`mcp.json`、`manifest.json` | 拒 | 配置同步载荷，v2 之外（`DATA-CONTRACT-v2.md:11`） |
| `chats/<id>/session.jsonl`、`chats/<id>/meta.json`、`chats/<id>/media/**`、任何会话媒体 | 拒 | `chats` 分支只有**一个字面量**，不含子目录 |
| `/abs/chats/index.jsonl`、`C:\\…`、`chats/../chats/index.jsonl`、`chats//index.jsonl`、`chats/index.jsonl.bak` | 拒 | 字面量相等，不做归一化；旧谓词已挡反斜杠 / 盘符 / 空段 / `.` / `..`（`:163-169`） |
| `README.md`、任意裸文件 | 拒 | 不在白名单 |

`timeline/<date>/media/**` 仍按今天口径归入 `timeline/**`（`cycle.ts:163-169`、`DATA-CONTRACT-v2.md:29-30`），**不属于本次放宽**。
**证明方式**：`isConfinedSyncPath` 纯函数对上表逐行 `expect(false)`、对三种合法形状 `expect(true)`；再造 ahead 提交 `paths:['chats/index.jsonl','devices/x']` → `isOursCommit===false` 且 `describePendingOwnership` 给出 `untrusted`。门禁是**归属分类**不是安全边界：有 push 权限的客户端本就能写任意路径。双端实际行为 「未验证」（`DATA-CONTRACT-v2.md:361`）。

## 6 已打开页面遇到删除

| 场景 | 行为 |
| --- | --- |
| 平板详情已开、正在读 | 详情只在 `aboutToAppear` 读一次、内容留在 `@State`，旋转不重读（`pages/ChatDetail.ets:17,66-76,82,123`），所以**不实时消失、不崩溃**；工作副本被 pull 更新后，返回再进入时 `loadChat` 查墓碑返回 typed「会话已删除」，页面显示删除态 + 返回，不展示半份历史 |
| 平板列表已开 | 下一次 `listChats` 重读索引后隐藏该行（`chatStore.ets:147-174`）；本次内存中的列表可保留到刷新，不做强制跳转 |
| 桌面 DSH 会话开着 | 云端墓碑与本地会话文件正交；本地继续显示本地内容，不弹窗、不删文件；下次导出由 §4 拦截。租约逻辑（`docs/CHAT-SYNC.md:99-106,140-166`）与删除无关 |

## 7 测试矩阵（实现时逐条落断言）

| # | 场景 | 断言 | 状态 |
| --- | --- | --- | --- |
| 1 | 墓碑写 / 读 | 追加后旧字节为严格前缀；`readChatIndex` 得 `deletedIds`、`entries` 无该 id | 纯逻辑可测 |
| 2 | 折叠规则 | 普通行 last-wins；墓碑 + 后续普通行仍隐藏；坏行只计数 | 纯逻辑可测 |
| 3 | A 删 → B 不再发布 | A 墓碑提交推送后 B 拉取；B 的 ahead 提交判 ours、周期继续；B 投影无该 id | 「未验证」 |
| 4 | **导出器复活尝试** | §4 确切测试：源会话仍在，二次 `exportChatsToRepo` 不新增行、不返回 `ok:true` | 纯逻辑可测 |
| 5 | 并发删除 + 编辑 | 两行并集后两端投影一致且隐藏；落败行保留为追加历史，不冒冲突 UI | 纯逻辑可测；双端 「未验证」 |
| 6 | 导入 / 导出往返 | 导出包含墓碑、导入只追加；往返后已删 id 仍不可见；导出器不得重建 | 纯逻辑可测 |
| 7 | 归属门禁 | §5 路径表逐条判定；混合路径提交判 `untrusted`；合法两种形状判 ours | 纯逻辑可测 |
| 8 | 平板读层隐藏 | `parseChatIndex` 含墓碑 → `entries` 剔除、`deletedIds` 命中；`loadChat` 返回 typed 删除 | 纯逻辑可测；真机 「未验证」 |
| 9 | 已开页面 | 删除后已加载的 `@State` 内容保持、页面不抛；重新进入走 typed 删除态 | 「未验证」 |

## 8 非目标与风险

- **批量删除 / 按实例级联**：非目标。墓碑一次仅一个 id；实例增删永不触发（`types.ts:107-148` 无实例键）。
- **已删载荷**：推荐**保留** `chats/<id>/session.jsonl` 与 `meta.json`（`exportChats.ts:479-480` 不再覆盖它们）。代价：云端存储只增不减、git blob 历史删不掉（`REMOTE-INSTANCES.md:50-51`）；好处：路径白名单保持单文件、已开页面不读到半份、误删可从 git 历史恢复。若改为物理删除，就必须把门禁放宽到 `chats/<id>/**`，与 §5 的精确白名单冲突——故列为待裁定。
- **索引无限增长**：墓碑永不移除、无 TTL；压缩必须是显式、离线、全设备协调的维护操作（参照 `DATA-CONTRACT-v2.md:176,355`），本模块不做。
- **敌意 / 有 bug 的客户端**：可伪造他人会话的墓碑（追加文件无逐作者鉴权）、可刷入海量行、可在墓碑后补普通行、可写畸形 `op`。防线只有三处：id 白名单 + `deletedAt` 校验（§2）、墓碑单调优先（§2）、导出器双层过滤（§4）；**伪造墓碑本身无法被本设计阻止**，属 git push 权限问题，不谎报为已解决。
- 真机 / 第二设备 / 平板写通道全部 「未验证」（`DATA-CONTRACT-v2.md:361`，当前无 hdc / 无 DevEco）。

## 9 待用户裁定

1. **墓碑字段形状**：是否接受 `op:"delete"` 第六字段行（推荐），还是另立 `chats/deleted.jsonl`。
2. **平板写权限**：是否真的开放平板手写删除（需新增窄写通道；不开放则只有桌面能删）。
3. **已删载荷**：保留 `session.jsonl` / `meta.json`（推荐）还是物理删除并放宽门禁到 `chats/<id>/**`。
4. **索引压缩**：本轮是否定义离线压缩工具（推荐暂不，只增）。
5. **桌面本地删除**：是否镜像为云端删除（推荐忽略，绝不镜像）。
6. **提交类**：并入 `isOursCommit` 白名单（推荐）还是单立 commit class。
7. **撤销 / 恢复**：产品语句为单次删除，是否永不提供 restore（推荐永不提供）。
8. **已开页面交互**：返回后再提示（推荐）还是实时弹出删除态。

---

## 10 订正与补充（2026-11-27，Designer；不重写上文，只追加）

**10.1 为什么不给平板写 chats/<id>/meta.json 与 session.jsonl 的权限。** 阅读侧只从**索引投影**得到会话列表（chatStore 读 chats/index.jsonl，chatList.ts 折叠），所以"用户看不见这条会话"这一件事**只在索引层完成就够**；载荷文件不需要任何字节变化。反过来给写权限的代价是：① 载荷是**导出器所有权**的文件（meta.deviceId / meta.lease 是导出方的归属元数据，exportChats.ts:324,327），平板一旦能写就变成第二作者，chats/<id>/ 成了没有合并方案的双写面（明文 JSONL + 原子替换）；② 会让一台设备有能力篡改另一台设备导出的正文；③ 删除就不再是"追加一行"这种零冲突操作。**代价必须写清**：载荷保留 ⇒ 被删会话的**正文仍留在工作副本与 Git 历史里**（历史我们从不改写）。这正是 §9 第 3 条「已删载荷」要用户裁定的原因——**"彻底删干净"对实例成立，对会话不成立**，除非另立"载荷清理 + 历史处理"的模块。

**10.2 墓碑折叠的语义：上文 §4 第 3 行写「墓碑单调优先」，其含义是"已删即永久隐藏"，本文此处把它讲透并给出边界。** 先澄清 id 来源：会话 id **就是 DSH 的 sessionId**，即会话日志目录名（eadSessions.ts:196-201 扫 <root>/<slug>/<sessionId>/，exportChats.ts:262-264 取 header.id 否则 sessionId，:332 用 id: sessionId 落目录）。它**不是**内容寻址、**也不是**我们生成的 UUID ⇒ 正常新建的会话不可能撞上旧 id（新会话 = 新目录名）。但**同一个 id 合法地需要重新发布**是可能的：用户恢复本地 zstd 会话后重跑导出，或将来做「撤销删除」。**在"永久隐藏"语义下，这两条都被堵死**——不是 bug，是选择的后果，并且直接决定 §9 第 7 条（是否提供撤销/恢复）的答案。
**建议（若用户要撤销）**：把折叠从"墓碑永久优先"改成**按时间戳单调（last-writer-wins）**——删除行带 deletedAt，普通行带 	s，比较后取较新者；这样删除仍然赢过任何**旧**行（含误追加的普通行），而一条**更新**的显式 op:"restore" 或重导出行可以合法胜出。该改动只影响折叠与两条测试（复活测试仍是"同 id 无更新的普通行不得复活"），不改变 §4 的三层防复活机制。

---

## 11 语义已由用户定稿（2026-11-27）＋ DSH 自带归档的实测机制

### 11.1 用户定稿的三句（视为已裁决，不再重开）
1. **永不物理删除会话内容、永不改写历史**：用户原话「由于 git 的存在，删除是不可能真的删除所有记录的，所以删除只要做到对用户隐藏即可」。⇒ 载荷留在工作副本与 Git 历史里**不是妥协**，是设计。§9 第 3 条「已删载荷（保留还是物理删除）」**已答：保留**，从待裁定列表划掉。
2. **删除 = 对用户隐藏**：可观察契约 = 在这位用户的正常列表里消失，**在所有设备上一致**，跨导出与同步都保持消失；底层字节不动。
3. **因此必须可恢复**（"隐藏"的可逆面，也与用户「类似于 DSH 自带的归档那种效果」一致）⇒ 恢复路径是功能的一部分，不是可选项。§9 第 7 条「是否提供撤销/恢复」**已答：提供**。

### 11.2 DSH 自带归档的真实机制（读装机文件，非记忆）
| 问题 | 事实 | 证据 |
| --- | --- | --- |
| 状态存在哪 | **注册表全局的一个会话 id 数组**，与置顶并列，落盘在 ~/.dsh/storages/workspace.json 的 global.archivedSessionIds（本机实测该文件 4,831 B，键为 unit/global/tables，global 含 initialized/workspaceIds/archivedSessionIds/pinnedSessionIds） | 磁盘实物 %USERPROFILE%\.dsh\storages\workspace.json；代码 dsh-workspace/src/index.ts:360（getter）、:754,761（投影） |
| 值形状 | SessionId[]（数组，无时间戳、无独立表） | dsh-workspace/src/index.ts:360；dsh-api-workspace-controller/README.zh.md:25「归档与置顶集合都是会话 id 数组」 |
| 谁写 | WorkspaceRegistry.archiveSession(sessionId, {stopActivity?}) / unarchiveSession(sessionId)，经 setState **持久写**；与置顶互斥（归档时把该 id 从 pinnedSessionIds 里剔掉）；会话不存在 ⇒ typed WorkspaceUnknownSessionError；有活动且未传 stopActivity ⇒ typed WorkspaceActiveSessionError（不会静默归档运行中的会话） | dsh-workspace/src/index.ts:381-408（archive）、:420-432（unarchive） |
| 对外接口 | Host 服务 ctx.workspaceController，Remote 方法 rchiveSession/unarchiveSession；ollow() 流发 rchived/pinned 增量 | dsh-api-workspace-controller/README.zh.md:11,25 |
| GUI 在哪 | 会话行右键 / 标题右键菜单里的**「归档」**（与「在应用中打开」「复制 Session ID」同组）；客户端模型持有归档/置顶身份并按流增量更新 | dsh-client-ui-open-in-app/README.zh.md:34（菜单顺序）；dsh-api-workspace-controller/README.zh.md:29（ClientWorkspaceModel 持有 archived 身份） |
| GUI 怎么隐藏 | 正常列表按 rchivedSessionIds 过滤；归档会话也不可被 session.create 复用（eusable 判据显式排除已归档） | dsh-api-session-controller/src/commands.ts:140；dsh-api-session-controller/README.zh.md:50 |
| 归档会不会动会话日志 | **不会**。归档只往注册表数组里加一个 id；取消归档只把它从数组里删掉，注释明说「the accounting slot was never touched, so the session returns to its recorded position」⇒ 会话文件与顺序原封不动 | dsh-workspace/src/index.ts:410-418 |
| 副作用 | 归档会话（或其子代理后代）**不许再跑模型步**，直到取消归档；这是准入门（gent/pre-step reject） | dsh-api-session-controller/src/archived-session-gate.ts:25-33,46-58 |

**结论（一句话）**：DSH 的归档是**"注册表里的一个 id 集合 + 准入闸"**，不是改会话内容；所以"归档"在我们的云端索引里可以**只用追加行**表达，完全不需要碰载荷。

### 11.3 映射到我们的 chats/index.jsonl：折叠规则（全函数，逐行）
追加两种行：{"op":"archive","id":S,"ts":T} 与 {"op":"unarchive","id":S,"ts":T}（字段名沿用现有索引行的 id/	s 风格）。**折叠是全函数**（对任意行序列给出确定结果，不依赖行数上限、不抛异常）：

1. 按文件顺序扫描，维护 map[id] = {hidden:boolean, at:{ts,seq}}；seq 是行号（用于同一毫秒的确定性决胜）。
2. 普通行（现有 {id,title,updatedAt,messageCount,sha256}）：**只更新内容投影，永不改变 hidden**——这是关键，见 11.5。
3. op:"archive"：若该行 (ts,seq) **新于**当前 t ⇒ hidden=true, at=该行；否则忽略。
4. op:"unarchive"：若 (ts,seq) **新于**当前 t ⇒ hidden=false, at=该行；否则忽略。
5. 列表只输出 hidden=false 的条目；「已删除」视图只输出 hidden=true 的条目（按 t.ts 倒序）。

**这修正了 §10.2 的措辞**：不是"全体行的时间戳 LWW"，而是**两级规则**——普通行**永远不能解除隐藏**（否则任何一条迟到的重导出行都会让隐藏静默失效），只有 op:"unarchive" 能；rchive/unarchive 之间才按时间戳单调。§10.2 里"若用户要撤销则改 LWW"的说法作废，以本节为准。

### 11.4 导出器必须被教导，否则这个功能是"会自己过期的装饰"
**必须直面的失败**：uploadChats 每次导出都会用 writeFile 覆盖 session.jsonl/meta.json（exportChats.ts:479-480）**并追加一条普通索引行**（:481-487），而 exportChatsToRepo 会无条件把本机会话构造成导出项（index.ts:132-176，默认 local.slice(0,limit) :160）。⇒ **不教它，下次导出一条普通行，按 §11.3 规则 2 它不能解除隐藏**（这就是规则 2 存在的理由），但会**多出一条无意义的重复行**，并且"已删除"视图里会看到内容被刷新。所以仍然必须做 §4 的三层过滤（选中前过滤 deletedIds、ppendIndexLine 前复读墓碑、读侧单调优先），**其中第 1/2 层不是可选优化，而是避免索引被无意义重复行灌满的必要条件**。
**反方向同样要教**：op:"unarchive" 之后，导出器必须允许该会话重新出现（它的过滤集合里已经不含该 id，因此无需额外开关——但测试必须覆盖"归档 → 取消归档 → 再导出仍正常"）。

### 11.5 UI 文案与恢复入口（本节自行定稿，不再上问）
- **动词保留用户的词「删除」**，不引入第二个名词「归档」。文案必须**可逆且指明去处**，例如：标题「删除这条会话？」；正文「删除后不再显示在会话列表，可在**已删除**里找到并恢复；云端记录不会被抹除。」；主按钮「删除」；次按钮「取消」。**不得**出现"彻底删除/永久删除/清空"一类措辞。
- **恢复入口（两端都要）**：① 平板：会话列表页加一个「已删除」入口（与「全部会话」同级），列出隐藏会话并可「恢复」；② 桌面 DSH：用自带的归档/取消归档即可（11.2 的机制），并且**它必须与我们的隐藏状态双向一致**——见 11.6 的开放问题之一。
- 若最终只做桌面端恢复，必须在文案里写清"只能在电脑上恢复"——单向隐藏不是用户要的东西，这一点不留给"以后再补"。

### 11.6 测试矩阵（替换 §7 的主线）
| # | 用例 | 断言 |
| --- | --- | --- |
| A1 | 归档行写入 → 列表 | 正常列表无该 id；「已删除」视图有；载荷文件字节不变 |
| A2 | **跨设备一致** | A 归档 → 提交推送 → B 同步 → B 的正常列表也无该 id |
| A3 | **重复导出不复活** | 归档后再跑一次导出（源会话仍在）⇒ 不产生新普通行（或产生但折叠仍 hidden）；列表仍无 |
| A4 | **取消归档可恢复** | 追加 unarchive ⇒ 两端列表重新出现；updatedAt/内容未变 |
| A5 | 折叠全函数 | 乱序行、同毫秒、重复 rchive、unarchive 早于 rchive、坏行 ⇒ 结果确定且不抛 |
| A6 | 老客户端追加普通行 | 手工在归档后追加一条普通行 ⇒ 仍 hidden（规则 2） |
| A7 | 提交门禁 | chats/index.jsonl 之外任何 chats 路径仍被拒（§5 白名单） |

### 11.7 未变的部分
§5 的归属门禁改造与路径白名单、§6 已打开页面、§8 非目标与风险仍然有效；§7 的测试矩阵以本节 A1–A7 为主，其余条目降为补充。

---

## 12 范围收窄（2026-11-27 第二次定稿）：本模块只做"隐藏"，不做恢复

用户原话：「暂时不做恢复，先只要能删除即可」。

### 12.1 划出范围的（保留设计，将来单独成模块）
- **不做**：「已删除」列表页、撤销/恢复手势、op:"unarchive" 的任何 UI 入口。
- **保留但降级为后续模块**：§11.5 的恢复入口、§11.3 规则 4 的 unarchive 语义、§11.6 的 A4（取消归档可恢复）。**不是删掉，是标为「未来模块 mod-chat-restore」**，因为恢复的思考（DSH 自带归档的机制、两端入口、文案）将来还要用。
- 明确不做的**数据格式**决定：op:"unarchive" **仍留在格式定义里**（读取侧认识它、可折叠），只是本模块**不产生**它。理由：让将来的恢复模块不需要改读取侧（不用二次迁移），今天多写两行解析代码而已。

### 12.2 仍然必须成立的两条正确性（这才是本模块的全部价值）
1. **对导出器黏滞**：用户删掉的会话，**不能**因为 exportChats 下次导出又追加一条普通行就重新出现。机制仍是 §4 的三层（选中前按隐藏集合过滤、ppendIndexLine 前复读隐藏集合、读侧"普通行永不解除隐藏"）。
2. **跨设备可见**：A 删 → 提交推送 → B 同步后，B 的正常列表也不再显示。恢复端到端验证要真机（unverified），但索引层的折叠与投影可离线证明。

### 12.3 为什么仍然记录时间戳（我的判断，附理由）
**记录 deletedAt，即使今天没有任何恢复 UI**，理由有三，且都不是"以后可能有用"这种空话：
1. **它今天就在参与折叠**：同一 id 出现多条隐藏行时，"哪条是最新的隐藏"要靠时间戳决胜（§11.3 的 (ts,seq)），否则只能靠行序，而行序在多设备并发追加时不可靠。
2. **它今天就在参与展示**：「已删除」这道口子将来若要开，列表要按删除时间倒序；没有时间戳就得回填，而回填必须从 Git 历史里重建——那是真正的迁移成本。
3. **代价为零**：一行 JSONL 多一个整数字段，索引大小与读取复杂度都不变。
⇒ **结论：保留 deletedAt（毫秒时间戳），字段名与现有 	s 同风格，但语义是"隐藏发生时刻"**；记录它不承诺任何恢复能力。

### 12.4 对用户的诚实后果（本文确认属实）
- 没有恢复 UI ⇒ **误删在应用内不可挽回**。字节仍在工作副本与 Git 历史里（**没有任何东西被销毁**），但**应用内没有回去的路**，直到 mod-chat-restore 出现。
- 唯一的"技术性后路"是手动在 chats/index.jsonl 里追加一条未来的 unarchive 行——那是维护动作，**不是**产品能力，不得写进用户文案冒充可恢复。
- 因此本模块的**唯一防线是确认弹层**（§12.5）。

### 12.5 确认弹层文案（一次性动作，不许伪装成可逆）
- 标题：**「删除这条会话？」**
- 正文（两行，缺一不可）：
  1. 「删除后不再显示在会话列表；云端记录不会被抹除。」
  2. 「**目前没有恢复入口**，删除后应用内无法找回。」
- 主按钮：**「删除」**（若平台支持，用警示色但**不用**"彻底/永久"字样）；次按钮：**「取消」**。
- 禁止出现：「可恢复」「可在已删除中找到」「撤销」——本模块不提供这些能力，写了就是骗人。

### 12.6 测试矩阵（本模块最终版）
| # | 用例 | 断言 |
| --- | --- | --- |
| A1 | 隐藏行写入 → 列表 | 正常列表无该 id；**载荷文件字节不变**（路径集 + 逐文件 sha256） |
| A2 | 跨设备一致 | A 删 → 推送 → B 同步 ⇒ B 列表也无该 id |
| A3 | **重复导出不复活（主线）** | 隐藏后再跑一次导出（源会话仍在）⇒ 不复活；索引不因重复导出而无意义膨胀 |
| A5 | 折叠全函数 | 乱序、同毫秒、重复隐藏行、坏行 ⇒ 结果确定且不抛 |
| A6 | 老客户端追加普通行 | 隐藏后手工追加普通行 ⇒ 仍隐藏（普通行永不解除） |
| A7 | 提交门禁 | 除 chats/index.jsonl 外任何 chats 路径仍被拒 |
| A8 | 将来兼容 | 读取侧遇到 op:"unarchive"（本模块不产）能正确折叠为可见，且不抛 |

§11.6 的 A4（取消归档）与 §11.5 的恢复入口随 §12.1 一起转为 mod-chat-restore 的验收，不在本模块。

---

## 13 两条补充结论（2026-11-27，回答 Lead 的追问）

### 13.1 我们的隐藏状态**必须存在仓库里**，**不得**复用 DSH 自带归档数组
DSH 的 global.archivedSessionIds（~/.dsh/storages/workspace.json）是**本机注册表**：它只在电脑上、只对电脑的 GUI 生效，**不会随 Git 同步**，平板也读不到。用户的可观察契约是"跨设备一致"，所以我们的隐藏状态**只能**落在 chats/index.jsonl（仓库内、可同步、两端可读）。DSH 的归档数组在本设计里是**桌面端表现层的同步对象**（见 §13.2），不是事实源。
**事实源唯一性**：chats/index.jsonl 的折叠结果 = 唯一真相；桌面 DSH 的归档数组是从它**单向反射**出来的表现，二者冲突时以索引为准。

### 13.2 桌面自己的会话列表**必须跟着变**，否则与用户模型冲突
用户模型是「删除 = 对我隐藏」，我 包含桌面端同一个人。如果平板删了、桌面 DSH 列表里还在，就直接违背这句话。因此需要一个**单向反射**：把索引折叠出的隐藏集合，映射到 DSH 的 workspaceRegistry.archiveSession(sessionId)（本机进程内、ctx.workspaceRegistry 可达）。
- **为什么要单独成模块**：rchiveSession 对**有活动**的会话会 typed 拒绝（WorkspaceActiveSessionError，dsh-workspace/src/index.ts:389-394），并且它会顺带禁止该会话继续跑模型步（rchived-session-gate.ts）。这是**外部状态机**，与"追加一行索引"完全不同的失败类别，值得独立评审。
- **一个意外的好处（供用户裁定，不在本模块）**：一旦做了反射，**桌面 DSH 自带的「取消归档」就等于免费恢复了删除**——这正好补上"应用内无法恢复"的洞，而不需要我们在平板做恢复 UI。反方向（桌面取消归档）与"本模块无恢复"的冲突需要显式规则：建议**以索引为准**，桌面取消归档视为"用户想恢复"，此时由反射模块追加 op:"unarchive"（那属于未来 mod-chat-restore 的语义）。
- **中间态（必须如实告知用户）**：在反射模块落地之前，存在一个**小时级窗口**——平板已隐藏、桌面 DSH 列表仍显示。这是暂时的，不是终态。
