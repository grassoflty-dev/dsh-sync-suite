# 云端会话自动导出（CHAT-EXPORT-AUTO）设计

> 状态：**设计稿（本轮零代码、零契约改动、零构建）**，2026-11-28。模块 `mod-plugin-chat-export-auto`（由 `docs/NOTE-chat-export-trigger.md` 的「手动入口」想法改名）。
> 上位约束：`docs/CHAT-SYNC.md` §2/§7、`docs/DATA-CONTRACT-v2.md` §2/§11、`docs/CHAT-DELETE-DESIGN.md`。行号均为本轮实读工作树（路径相对 `dsh-sync-suite/`），「新增」= 提案；真机 / 双端 / 未落地项一律标「未验证」。
> 基线：`main` HEAD `0eef966`，叠加未提交的 `mod-plugin-outbox-purge-failed`（`src/sync/cycle.ts` + 测试 + `dist/sync/cycle.js`）；本文不碰任何源码、不产生 git 写。
> 产品语句（权威）：「自动：无感同步（推荐，但正文会入云端仓库）」；「剩下的都应该是无感的」。⇒ **没有按钮、没有确认弹层、没有手动触发入口**，导出自己跑；用户已接受正文进入云端仓库。

## 1 现状事实（实读，不重新推导）

| 事实 | 证据 |
| --- | --- |
| 发布能力只有 RPC；无自动调用、无面板引用、无 locale 文案 | `packages/dsh-dots/src/rpc.ts:1355-1360` → `exportChatsToRepo`（`:984`、`:999`）；`src/client.js` 无 chatExport、`locale/zh.json` 无对应串（`docs/NOTE-chat-export-trigger.md:8`） |
| 选择无条件，二次导出反复覆盖 + 追加 | `src/chats/index.ts:132-176`，`local.slice(0, limit)` 在 `:160`；`src/chats/exportChats.ts:479-480`（`writeFile` 覆盖 `session.jsonl`/`meta.json`）、`:481-487`（追加索引行） |
| `sha256` 已是唯一变更信号 | 计算于 `exportChats.ts:323`（`createHash('sha256').update(jsonl,'utf8')`）；索引字段白名单 `:52`、类型 `src/chats/types.ts:141-148`；读侧按 id 折叠取最后一行 `exportChats.ts:347-391`（`:383`、`:385-386`） |
| `uploadChats` 自带「一会话一 commit + 一次 push」 | `exportChats.ts:5-8`（职责声明）、`:490`（`commitAll(..., onlyPath:'chats')`）、`:505`（`pushWithRebase`）；push 失败不抛、文件保留 `:504-509` |
| v2 周期只许单提交单 push，失败停放 | `src/sync/cycle.ts:1583-1591`（唯一 commit）、`:1617`（唯一 push）、`:1618-1629`（停放、绝不报成功）；push 预算 `src/engine/git.ts:79`（`PUSH_TIMEOUT_MS = 120_000`） |
| 归属门禁今天只认 `timeline/**` | `cycle.ts:171-177`（`isConfinedTimelinePath`）、`:180-185`（`isOursCommit`）、`:108-109`（越界即拒绝文案） |
| `mod-chat-hide` 的**提案**谓词只多一个字面量；载荷仍被明确拒绝 | `docs/CHAT-DELETE-DESIGN.md:88-89`（`isConfinedSyncPath`）；路径表 `:97`（`chats/<id>/**` 拒）。该谓词今天尚未实现，标「未验证」 |
| 2,225 个本机会话、零导出、两库都无 `chats/` | `docs/NOTE-chat-export-trigger.md:6` |
| 截断会话已 fail-closed | `exportChats.ts:254-255`（`truncated-session`） |
| outbox 形状与预算可借鉴 | `cycle.ts:313-332`（`OutboxIntent`：`intentId/op/date/id/ts/line/enqueuedAt/attempts/state/lastError/commitSha?`）、`:78`（`MAX_ATTEMPTS=4`）、`:86`（7 天清理，未提交） |

## 2 决策：只发「变更过的」会话（幂等靠 sha256 门控）

**决定**：新增纯函数 `shouldExportChat(built, indexEntry, payloadExists)`（提案，落 `src/chats/autoExport.ts`）；仅当「索引中该 id 最后一行的 `sha256` ≠ 本次构建算出的 `meta.sha256`」或「索引行在但载荷文件缺失」时才导出。hash 计算沿用 `exportChats.ts:323`，索引读取沿用 `:347-391`；但必须改走 `mod-chat-hide` 的隐藏感知折叠（`docs/CHAT-DELETE-DESIGN.md:43,178-186`），**不能**直接用今天的 `readChatIndex`——它会把 `op` 行折成 `sha256:''`（`exportChats.ts:383`），导致隐藏行被误判为「内容变了」而反复重发。
- **索引有行但载荷缺失**：视为一次修复——重写两个载荷文件，并**只追加一条**修复索引行（`sha256` 不变、`updatedAt` 为新值），使索引始终是「已成功发布」的唯一账本。
- **会话变了**：全量重写载荷 + 追加一行带**新 sha256** 的普通行；索引只追加、从不重写既有字节（`exportChats.ts:393-399`），旧行留在 Git 历史里。
- **放置点**：门控在构建后、`uploadChats` 前做；并在 `appendIndexLine`（`:481`）前复读一次，关闭 TOCTOU（与 `CHAT-DELETE-DESIGN.md:63-65` 同款三层）。选择顺序必须是「先门控、再 `local.slice(0, limit)`」，否则已发布会话会占满 50 个名额。
- **理由**：`sha256` 本来就是乐观锁锚点（`types.ts:119-120`）；不门控就会把 2,225 个会话每次全量重发、索引无限膨胀（`index.ts:160`、`exportChats.ts:479-487`）。
- **钉住测试**：同一批未变会话连跑 3 次 ⇒ 新增索引行 **0**；只改 1 个会话再跑 ⇒ 恰好新增 **1** 行，且旧字节是新字节的严格前缀。

## 3 首次运行边界：50 个最近会话

**决定**：`export const AUTO_EXPORT_LIMIT = 50`（新增，中文注释：「首次与每轮最多发布 50 个最近会话；本机有 2,225 个日志，绝不一次倾倒」）。复用既有默认 `DEFAULT_EXPORT_LIMIT = 50`（`index.ts:59-62`）与 rpc 的 mtime 降序语义（`rpc.ts:979`）。
**理由（一段）**：50 是**工作量与字节数的硬上限**，与会话在时间上的分布无关；而「30 天窗口」在本机这种 2,225 条密集日志上完全可能一次收进几百个会话，无法给单轮周期一个有界的预算，也无法满足 §5 的 120 s push 纪律。50 又是现有 `chatExportAll` 的默认值（`index.ts:60`），语义与测试夹具可直接复用。
**更老的会话**：本模块**永不自动发布**；不提供手工按钮（用户选了无感）。将来可另立模块复用现成的 `chatExportAll` / `chatExportOne` RPC（`rpc.ts:1357-1360`）做显式发布——本模块不实现、不承诺。

## 4 一句话诚实告知（声明，不是对话框）

**决定**：面板在「远程控制」分组旁新增一行**静态声明**（无按钮、无确认、不可关闭；`client.js` 的 locale 表按 `:153` 中文 / `:271` 英文同风格加一个键，状态行渲染沿用 `:985` 的形态），`docs/MODULES.md` 新模块行的「一句话目的」列**逐字**带同一句：
> **「会话正文会自动同步到云端仓库，以明文 JSONL 保存并进入 Git 历史，无法抹除。」**

**理由**：用户选了无感，唯一可做的告知就是常驻声明；句子必须点出「明文」与「Git 历史」（`CHAT-SYNC.md:60,67,268-269`），不得改写为「备份」「加密保存」「仅本地可见」。隐私过滤（`exportChats.ts:10-14`）照旧不放宽，但它不改变「正文入仓」这一事实。平板不需要新 UI：`chats/index.jsonl` 有行后现有读取路径自然显示（`NOTE-chat-export-trigger.md:25`）。

## 5 时序与有界性：周期内的一个前置阶段

**决定**：自动导出作为 **v2 同步周期内的一个阶段**：pull / 快进之后、唯一 `commitAll` + `pushMain` 之前（`cycle.ts:1583-1591,1617`）。全程在既有串行队列（`rpc.ts:1355-1360` 的 `enqueue`）与周期互斥内，因此**不新增第二个 commit、不新增第二个 push、不留下 ahead 提交**。
- **每轮会话上限**：50（`AUTO_EXPORT_LIMIT`）；先按 sha256 门控筛掉未变会话，再取前 50。
- **每轮时间上限**：`AUTO_EXPORT_PHASE_TIMEOUT_MS = 20_000`（新增，仅覆盖解码+哈希+写盘，不含网络）。50 个会话每份最多几 MB 明文（`index.ts:59-62`），20 s 远小于 `PUSH_TIMEOUT_MS=120_000`（`git.ts:79`）；唯一网络操作仍是周期原有的一次 push，预算不变。⇒ 首轮相对现有有界周期最多多 20 s，没有新预算面。
- **第二轮很便宜**：哈希门控跳过已发布的 50 个，成本 = 读一次索引 + 重算当前 50 个哈希；零变化时 `writtenPaths` 为空，周期不提交不推送（`cycle.ts:1585`）。
- **超时**：只在会话边界停下，已写文件与已追加行保留；随后**提交一次、推送一次**（只推已成功部分），未处理的会话不写索引行，下轮由哈希门控自然接上；本轮不再重试、不新起定时器。面板行显示「部分发布：<n> 个；本轮超时，剩余 <m> 个下次同步继续」，不得显示「已同步」式成功文案。

## 6 提交归属（最难的一处）：commit-class 标记 + 精确白名单

载荷 `chats/<id>/session.jsonl` + `meta.json` 只能由插件导出器写，平板隐藏提交绝不能碰；纯路径门禁分不清两个写入者（`cycle.ts:180-185` 只看路径 + 尾注）。

| 形状 | 做法 | 代价 / 结论 |
| --- | --- | --- |
| A：**放宽路径门禁 + 提交类标记** | 新增尾注前缀 `dsh-dots-chat-export:`（与 `dsh-dots-v2:` `cycle.ts:140` 分开）。普通类 = 原尾注 + `isConfinedSyncPath`（`CHAT-DELETE-DESIGN.md:88-89`）；导出类 = **额外带导出尾注** + 路径 ∈ `{timeline/**, chats/index.jsonl, chats/<safe-id>/{session.jsonl,meta.json}}` 且至少含一个载荷路径；`isOursCommit` 与 `describePendingOwnership` 共用同一谓词对（避免「判定 ours、解释 untrusted」，`CHAT-DELETE-DESIGN.md:89`） | 需改 2 处谓词 + 2 条文案；但能认领**未推送的导出提交**。**推荐** |
| B：`uploadChats` 自带 commit+push，用 mutex 与周期串行 | 门禁不动，二进制互斥防交错 | **单独不够**：push 失败本地提交保留（`exportChats.ts:504-509`），下轮变成 ahead 提交且路径越界 ⇒ `untrusted` / `E_LOCAL_PENDING`（`cycle.ts:108-109,1626-1629`），时间线同步被自己卡死；mutex 只能防交错，不能改分类 |

**推荐 A，并保留 mutex 作阶段串行（不是替代）**。
- (a) 导出提交带导出尾注 ⇒ 归为 ours 且路径放行；(b) 平板隐藏提交只带 `dsh-dots-v2:`（`CHAT-DELETE-DESIGN.md:89`），无导出尾注 ⇒ `chats/<id>/**` 仍按 `:97` 拒绝；(c) 门禁是**归属分类不是安全边界**（`CHAT-DELETE-DESIGN.md:102`）：进程内攻击者若有 push 权限，可自行伪造尾注/subject 并推送，本设计**不能阻止**；接受该残余风险，因为只有受审的导出代码路径产出该尾注、平板代码从不产载荷写。彻底关闭需签名提交或服务端路径保护，能力「未验证」。
- 提交类不另立 subject 白名单：沿用 `chats: export <id> (n msgs)`（`exportChats.ts:489`）或在折叠进周期时用 `[v2] sync N days`（`cycle.ts:130-133`）；subject 单独不足以证明归属（`cycle.ts:135-138`）。

## 7 可达性与两模块的书写顺序

一旦本模块跑起来，`chats/index.jsonl` **第一次真实存在**（`NOTE-chat-export-trigger.md:6`），平板列表终于有内容（`:8,25`），`mod-chat-hide` 的两条此前「未验证」的活路径变为**可验证**：A2 跨设备一致（`CHAT-DELETE-DESIGN.md:250`）与 A3 重复导出不复活（`:251`）。
- **隐藏 vs 再导出的验证**：夹具 = 真实导出的会话 S（索引行 L1、载荷 sha H）；追加 S 的隐藏行并提交（`:178-186`）→ 再跑一次自动导出（源 zstd 仍在）⇒ 断言 S 无新普通行、载荷逐文件 sha256 不变、列表仍隐藏（门控 + `:223-224` 的导出器过滤两层同时生效）；再断言隐藏提交携带载荷路径仍被 §6 门禁拒绝。
- **顺序**：① 本文模块先落地（造出数据、提交类、告知行）→ ② `mod-chat-hide` 落地共享 `isConfinedSyncPath` 并把导出类纳入 `describePendingOwnership` → ③ 合跑 A2/A3。先写隐藏模块则 A3 没有可隐藏的真实会话，「未验证」无法摘掉。

## 8 失败语义（无静默重试、无假成功）

| 场景 | 处置 | 面板行 |
| --- | --- | --- |
| push 失败 | 周期 typed `E_PUSH_REJECTED` + 已提交字节保留（`cycle.ts:1618-1629`、`exportChats.ts:504-509`）；停放一份**独立**的导出标记 | 「自动发布暂停：推送失败（typed 原因），已写入的提交保留」；**不得**出现成功文案 |
| 仓库缺失 | 未配置时 `workDir` 为空、只报本机事实（`rpc.ts:971-972`）；零提交 | 「未配置同步仓库，自动发布暂停」 |
| schema 门拒绝 | 索引行必须 5 字段（`exportChats.ts:52`）；拒绝则不写半行、停放标记；具体拦截点「未验证」 | 「自动发布暂停：索引格式被拒（typed 原因）」 |
| 会话截断 | `truncated-session` fail-closed 跳过（`exportChats.ts:254-255`），其余会话继续；每轮最多因同一文件失败一次 | 「本轮跳过 <n> 个不完整会话」 |

**停放形状：不复用 timeline outbox**。`OutboxIntent.op` 是 timeline 行的枚举（`cycle.ts:313-332`），塞进导出会让周期把它当记录重放、再撞路径门禁。改用插件 state dir 里独立标记，只沿用生命周期字段（`attempts/state/enqueuedAt/lastError`）与预算（`MAX_ATTEMPTS=4` `cycle.ts:78`、7 天清理 `:86`）；**每轮最多一次尝试**，无进程内 backoff，上次失败文案一直显示到一次成功 push 才清除。

## 9 测试矩阵（设计级，实现时逐条落断言）

| # | 用例 | 断言 |
| --- | --- | --- |
| 1 | 未变会话 ×3 | 三轮后索引新增行 0；载荷字节不变 |
| 2 | 一个会话变更 | 恰好新增 1 行、旧字节为严格前缀、sha256 为新值 |
| 3 | 索引有行但载荷缺失 | 载荷重写 + 恰好 1 条修复行（sha256 不变） |
| 4 | 2,225 会话夹具 | 单轮处理 ≤50；其余零索引行、零载荷写 |
| 5 | 首轮时间预算 | 20 s 阶段上限内停止在会话边界；push 仍只 1 次、预算不变（`git.ts:79`） |
| 6 | push 失败 | 无成功文案、导出标记停放、已写提交可重试；不复用 timeline outbox |
| 7 | 平板写载荷 | 无导出尾注的提交含 `chats/<id>/**` ⇒ `isOursCommit=false` 且解释 `untrusted` |
| 8 | 隐藏后再导出 | 无新普通行、载荷 sha256 不变、列表仍隐藏（§7） |
| 9 | 时钟 / `updatedAt` 并列 | 同一毫秒内多条行按 (ts,seq) 折叠确定；隐藏行不参与 hash 比对；坏行只计数 |

## 10 待用户裁定

1. 首次边界是否确认 50 个最近会话（本文推荐 50，拒绝 30 天窗口）。
2. 是否接受「导出尾注放宽路径门禁」的残余风险（推荐接受；彻底关闭需签名提交 / 服务端路径保护，「未验证」）。
3. 更早的 2,175 个会话是否将来另立**显式**手工发布模块（本文不做、不提供按钮）。
4. 面板静态声明行是否照用第 4 节逐字文案（推荐照用，不改为「备份」「加密」等软化措辞）。

---

## 10 批准与开工条件（2026-11-28，Lead 决定：**A + mutex**）

**批准形状**：新增提交类尾注 dsh-dots-chat-export:（与 dsh-dots-v2: 区分）；导出作为 **v2 周期内的一个阶段**执行（pull / 快进之后、唯一 commitAll + pushMain 之前）；chats/<id>/** **仅在该尾注下**被放行。**B（导出器自带 commit+push + 互斥）被否决**，理由：push 失败会留下本地提交，下一轮变成事实上的 rebase（exportChats.ts:504-509）。

以下六条是**开工前提**，不是建议：

1. **精确白名单，不用前缀。** 放行仅：chats/index.jsonl；以及 <id> 匹配既有 id 字符集、且不含 /、\、.、.. 的 chats/<id>/meta.json 与 chats/<id>/session.jsonl。其余一律拒绝：裸 chats/、裸 chats/<id>/、chats/<id>/其他任何文件、绝对路径、任意位置的穿越、devices/**、配置载荷。测试必须**表驱动枚举拒绝项**，不是只测放行项。
2. **平板路径永远不能携带导出尾注**：隐藏提交只带 dsh-dots-v2:，因此仍不能写 chats/<id>/**；用一条"尝试写并必须被拒"的测试钉住。
3. **残余风险写在评审者能看到的地方**：进程内写者可以伪造该尾注。若诚实的答案是"没有结构性防护，这是同一信任边界内的问题"，就照实写，不得暗示存在防御。
4. **有界且幂等**（已定）：按 sha256 变化门控（三次未变 ⇒ 零新增索引行）；首次运行有界（50 条最近 **或** 30 天窗口，常量 + 注释）；单次运行上限不得突破 PUSH_TIMEOUT_MS = 120_000。
5. **顺序**：mod-chat-hide 先提交，本模块随后——两者都动 syncGate.ts / cycle.ts，白名单必须写在 chat-hide 的门禁之上，而不是写在一个马上要变的版本上。
6. **独立评审后才提交**：评审必须专门攻击第 1 条的拒绝表与第 2 条的拒绝路径。

> 说明：本文件是设计；**未获准开工前不写任何代码**。批准已到，但第 5 条的"先 chat-hide 提交"是硬前置。
