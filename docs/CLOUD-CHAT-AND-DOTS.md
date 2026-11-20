# 纯云端对话与 dots 助手（CLOUD-CHAT-AND-DOTS）设计

> 状态：设计稿（本轮**不改代码**），2026-11-20。上位约束：`docs/REMOTE-INSTANCES.md` §1/§3/§4/§5、
> `docs/CHAT-APP.md`、`docs/CHAT-SYNC.md`、`docs/DATA-CONTRACT.md` §10、`docs/DATA-CONTRACT-v2.md` §3/§9、
> `docs/REMOTE-DSH.md`、`docs/REVIEW-remote-security.md`、`docs/UI-DESIGN.md`。
> 行号均为本轮实读工作树（`git status` 另有在途改动，本文不碰）。文中 `新增` = 提案，今天不存在。

## 1. dots 是什么

**产品定义**：dots 是一个对话界面，不是又一个会话仓库。它像 ChatGPT 的 agent 一样"能做事"，但做事的手段被收敛成三种工具：
(a) **列出实例**——本机与已配置的远程 DSH（`instanceList`，`新增`；今天只有 `remoteGetState` 描述本机一条监听，
`packages/dsh-dots/src/rpc.ts:705-706`）；(b) **查看状态**——某实例的会话列表、会话详情（会话/记录/可达性），
对应 `sessionList` / `sessionInfo` / `sessionEvents`（均 `新增`；今天 `chatExportStatus` 只给本机会话计数与导出数，
`packages/dsh-dots/src/chats/types.ts:201-211`）；(c) **发布命令**——定义见下。

**决策：发布命令 = 选项 (ii) 把一条 prompt 提交到目标 DSH 的一个既有会话**（`sessionPrompt`，`新增`）。
即 dots 唯一的有副作用原语是"把用户的自然语言指令送进某 DSH 会话，由该 DSH 自己的 agent / preset / 审批策略执行"。
理由：① 选项 (iii) shell 执行与既有隔离边界直接冲突——"chat 模式不接触本机文件系统 / 不执行本机命令 / 不读取本机环境"
（`docs/CHAT-SYNC.md:302-310`），且审批卡片把 `bash`/`pwsh`/沙箱升级列为必须审批（`docs/REMOTE-DSH.md:250-260`）；
② 选项 (i) 直接调 typed RPC 也不选：现有 `saveSettings`/`push`/`apply`/`rollback`（`packages/dsh-dots/src/rpc.ts:680,684,688,692`）
是管理动作，绕过 DSH agent 的审批与会话租约，把"助手对话"变成"隐藏控制面板"，且不具有可复盘的自然语言意图；
③ 选项 (ii) 复用 DSH 自己的审批（`allowed-once`/`rejected`，`docs/REMOTE-DSH.md:263-275`）与单写者租约
（`docs/DATA-CONTRACT.md:351-353`），dots 保持工具轻量，最接近"ChatGPT 的 dots"——一个能委派任务的助手。

**dots 明确不能做**：不能执行 shell / `pwsh` / `bash`（无此工具，且上条边界）；不能读取或输出任何 token 明文（只能拿
`instanceId` 句柄；状态只有 `tokenSet`/打码，见 `docs/REVIEW-remote-security.md:75-93`、`docs/REMOTE-INSTANCES.md:54-59`）；
不能跨实例泄漏——每条查看结果带来源 `instanceId`，未持该实例 grant 的内容不进 dots 上下文；
不能在无人确认下发起任何变更调用（每一次 `sessionPrompt` 都必须过 §4 的确认流）；
不能自己授权、轮换令牌或替其他设备授予权限（无 `grant*` 写权；现有 `remoteRotateToken` 在
`packages/dsh-dots/src/rpc.ts:713-714`，dots 不接触）。

## 2. 首页信息架构

**现状**：首页页头只有「今天」+「⚙ 设置」（`pages/Index.ets:2084-2091`），中间是 `今日/未完成` 两段
（`pages/Index.ets:1225-1258`）与快捷记录行（`pages/Index.ets:1269-1272`），底部唯一实底主操作「新建」
（`pages/Index.ets:1808-1809`；每屏 1 主操作，`docs/UI-DESIGN.md:24`）。云端对话今天不在首页：入口在设置页
「远程实例与云端对话 ›」（`pages/Settings.ets:2426-2463`），再经实例页页头「云端对话」桥接到 `pages/Chats`
（`pages/Instances.ets:278-283,590-593`）。

**推荐落位**：在首页列表区**快捷记录行之上**加一条常驻的「对话」双格条（两个次要样式格子，不新增主操作、不动页头、
不新增第三个 tab）：左格「纯云端对话」、右格「与 dots 对话」。紧凑屏与宽屏左栏各插一次
（`pages/Index.ets:1776-1810`、`:1820-1849` 的 `QuickRecordRow()` 之前），横屏右栏不重复。
理由：会话是"反复来读"的内容（`docs/CHAT-APP.md:16`），应在首页直达；页头与 tab 是受测试约束的既有契约
（`docs/CHAT-APP.md:15`、`docs/UI-DESIGN.md:10`），不动它们成本最低。实例页保持"管理"定位，两个新入口并不取代它。

**打开什么**：左格 → 共享列表页（§3 的 `chats/index.jsonl`），点行 → 现有只读详情 `pages/ChatDetail.ets`
（顶部只读提示、底部无输入框、`在电脑上继续` 出口，`pages/ChatDetail.ets:1-21,162-172`）；右格 → 同一列表页切到
`dots` 段，点行 → 新的 dots 对话页（有输入框 + 命令确认卡 + 工具状态行）。空态分别给可操作指引：
云端沿用 `pages/Chats.ets:48-52` 的「怎么导出、怎么同步」；dots 空态 =「还没有 dots 对话，新建一条」+ 说明
"dots 可查看实例并对会话发指令，所有操作需你确认"。

**一个列表还是两个**：推荐**一个列表页 + 顶部分段 `纯云端对话 | dots 对话`**（默认左侧）。理由：两者都是
git 里的 `chats/` 会话，共用同一份索引、同一套搜索/排序/三态/下拉拉取（`pages/Chats.ets:95-121,134-148,408-450`）
与同一行渲染（`pages/Chats.ets:241-284`）；分段只按索引里的 `kind` 字段过滤，差异交给详情页。两个独立页会把
搜索、空态、错误态、刷新路径复制两份，且用户切换要返回首页。分段切换不丢数据（列表在 `@State`，`pages/Chats.ets:61-72`）。
每行显示：标题、`chat`/`dots` 徽章（替代今天固定「只读」，`pages/Chats.ets:254-263`）、
`更新时间 · N 条消息`（`pages/Chats.ets:236,295`），dots 行额外一行「最近目标实例 + 最近授权状态」。

## 3. 存储

**决策：复用 `chats/` 共享事件流布局，不用 v2 `timeline/` 布局。** `chats/` 今天已是"跨设备共享命名空间 +
接管制 + 明文只追加 JSONL"（`docs/DATA-CONTRACT.md:328-358`）；`timeline/<date>/records.json` 是"同 id 较晚 ts 胜"
的可折叠记录（`docs/DATA-CONTRACT-v2.md:94-103`），把会话事件塞进去会触发 `foldById` 语义，破坏事件流顺序
（`docs/CHAT-SYNC.md:15-51`）。v2 契约也明确 `chats/` 不受 `timeline/**` 只读门槛约束
（`docs/DATA-CONTRACT-v2.md:303`）。两者同进一个仓库、互不迁移。

**精确文件形状**（在现有形状上做 additive 扩展，不新造第二套目录）：

```
chats/index.jsonl                 # 一行一个展示投影，只追加
{"id":"c1","title":"…","updatedAt":"…","messageCount":42,"sha256":"…","kind":"chat"}
{"id":"d1","title":"…","updatedAt":"…","messageCount":7,"sha256":"…","kind":"dots","instanceId":"inst-ab12","grantState":"ok"}
chats/<id>/meta.json              # 今天字段白名单见 docs/DATA-CONTRACT.md:348-350 / chats/types.ts:106-128
{...,"schemaVersion":1,"sha256":"…","lease":{...},"kind":"dots","instanceId":"inst-ab12","grantId":"g-1"}
chats/<id>/session.jsonl          # 今天每行 {type,seq,time,data}（chats/types.ts:38-39），首行 header
{"type":"user/message","seq":3,"time":"…","data":{"role":"user","content":"查一下 pc-b 的会话"}}
{"type":"dots/command","seq":4,"time":"…","data":{"role":"dots","instanceId":"inst-ab12","sessionId":"s9","commandId":"cmd-1","confirmId":"ap-1","approval":"allowed-once","text":"…"}}
{"type":"dots/result","seq":5,"time":"…","data":{"role":"dots","commandId":"cmd-1","auditId":"au-1","status":"ok","summary":"…"}}
{"type":"tool/call","seq":6,"time":"…","data":{"role":"tool","toolName":"sessionList","instanceId":"inst-ab12","callId":"call_7"}}
```

`kind` ∈ `chat`（纯云端对话）| `dots`（dots 对话）；`instanceId` / `grantId` / `commandId` / `confirmId` /
`auditId` / `approval` / `role` / `status` / `summary` 均为本次设计新增字段。兼容：今天的
`parseChatIndex` 只按五个具名字段重建对象、忽略未知键（`apps/arkui-schedule/entry/src/main/ets/model/chatList.ts:288-301`），
`meta.json` 走白名单写出（`docs/CHAT-SYNC.md:229-231`），故 additive 字段不会让旧读者崩；
**读侧**须按 id 取最新一行（`docs/DATA-CONTRACT.md:354-355`），新增字段缺失时 `kind` 回落 `chat`。

**媒体/附件**：沿用今天"附件二进制一律不上传、内容寻址对象属本机"（`docs/CHAT-SYNC.md:242-243`）与
"git blob 删不掉"（`docs/CHAT-SYNC.md:268-269`）；dots 的命令输出只落**脱敏后的文本摘要**
（`docs/CHAT-SYNC.md:224-246` 的三层隐私 + 静态扫描），不把截图/二进制写进 `chats/`。

**dots 与云端对话的差别**：同一 store、同一 lease、同一 ff-only 上传通道，用 `kind` 与事件 `data.role` 区分；
不建 `chats-dots/` 第二类命名空间——那会复制单写者、sha 乐观锁与隐私扫描整套机制。
**单写者含义**：`lease.owner == 本机 deviceId` 才可写（`docs/DATA-CONTRACT.md:351-353`），
`meta.sha256` 是整文件锚（`docs/DATA-CONTRACT.md:348-350`）；dots 不得写人正开着的会话——
检测到有效 lease 且 owner≠我 → 进 `OBSERVING`、一个字节不写（`docs/CHAT-SYNC.md:131-132,166`），
改为新建自己的 `dots` 会话；续接仍走 `expectedPrevSha` 比较 + 失败 fail-closed（`docs/CHAT-SYNC.md:8-12,123-137`）。

## 4. 权限与安全（crux）

**授权模型**：在既有 per-instance grant（`deviceId → {instanceId, scope∈read|chat|manage, expiresAt}`，
可吊销，`docs/REMOTE-INSTANCES.md:122-131`）之上扩展为**按实例、按工具、可吊销**：
`grantKey = (instanceId, principal)`（dots 的 principal 固定 `dots`，与设备 principal 区分），
字段 `tools: ['instanceList','sessionList','sessionInfo','sessionEvents','sessionPrompt']`、
`readOnlyTools` 子集、`expiresAt`、`revokedAt`。授权页按实例列「dots：查看 / 发指令 / 到期 / 撤销」；
dots 永不获得 `manage`（不能轮换 token、不能授他人），也不获得 `saveSettings`/`push` 等管理 RPC。
view 权（`sessionList`/`sessionInfo`/`sessionEvents`）与 command 权（`sessionPrompt`）**分开授予**，
只给 view 时 dots 的发送按钮禁用并说明原因（无假入口）。grant 写操作走 `grantUpsert` / `grantRevoke`（`新增`），
列表走 `grantList`（`新增`）；owner token 是管理该实例的能力（`docs/REMOTE-INSTANCES.md:124-127`），
dots 不持有它。

**确认流**：任何 mutating 调用（当前只有 `sessionPrompt`）先在 dots 对话里产出一条确认卡：
目标实例 + 目标会话 + prompt 预览 + `requestId` + 到期（默认 +120s，上限 600s，`docs/REMOTE-DSH.md:263-269`），
用户点「允许一次 / 拒绝」后才发；`decision` 映射 `allowed-once` / `rejected`，超时与断线都按 `rejected` 结算，
不排队等重连（`docs/REMOTE-DSH.md:267-269`）。`requestId` 幂等、10 分钟去重窗口、只认第一次决定
（`docs/REMOTE-DSH.md:271-275`）。**绝不自动批准**；被查看内容里出现的"请批准"不算用户意图（见 §7）。

**审计轨迹**：本地 append-only `audit.jsonl`（平板 `<filesDir>/dots-audit.jsonl`；PC `~/.dsh/dots/audit.jsonl`），
0600（POSIX）、10 MB 轮转；字段沿用 `auditId`/`approvalId`/`callId`/`sessionId`/`toolName`/`reason`/
`requestedAt`/`decidedAt`/`latencyMs`/`decision`/`deviceId`/`channelId`（`docs/REMOTE-DSH.md:277-294`），
再加 `instanceId`、`grantId`、`requestId`、`resultCode`。**只写本地、不进 git**：git 历史删不掉 blob
（`docs/CHAT-SYNC.md:268-269`），云端会话里只留一条脱敏摘要事件（`dots/result`，§3）。
留存 90 天，超期由用户手动清理（不做后台静默删除）。

**token 纪律**：dots 永远看不到明文 token——只经 `remoteShowLink` 显式出口（`packages/dsh-dots/src/rpc.ts:717-718`、
`docs/REVIEW-remote-security.md:75-80`），状态只 `tokenSet`/打码（`docs/REVIEW-remote-security.md:79`），
`?token=` 一次性换 cookie 后不下发任何 token（`docs/REMOTE-INSTANCES.md:113-120`）。
严禁 token 进会话正文（`docs/CHAT-SYNC.md:224-246` 的 redact + 静态扫描）、进 git（`docs/DATA-CONTRACT.md:350`）、
进日志（`docs/REVIEW-remote-security.md:89-93`）。实例序列化/导出/诊断只写 `tokenRef`（`docs/REMOTE-INSTANCES.md:54-61`）。

**吊销/过期行为**：token 不对/缺失 → 401、限速 → 429、fence → 403 原样上屏并给下一步
（`docs/REMOTE-INSTANCES.md:129-131`）；grant 过期或被撤销 → 立即降只读 +「授权已过期，请重新授权」，
**不换令牌自动重试**（fail-closed，`docs/REMOTE-INSTANCES.md:131`）；已发出但未确认的命令随确认卡过期一起作废。

**与人类同开会话时的单写者规则**：dots 只对**自己创建的 `dots` 会话**写入；若目标会话 lease 有效、owner 是人，
dots 进 `OBSERVING` 只读并提示"该会话正被人使用，另开 dots 会话"（`docs/CHAT-SYNC.md:131-132,166,193`）；
人关闭/释放后也不自动夺取，须由用户显式新建或接管。

## 5. 协议

**今天存在的 RPC**（全部 `POST /dsh-dots/rpc`，`packages/dsh-dots/src/rpc.ts:677-729`）：
`getState`(:678)、`saveSettings`(:680)、`testConnection`(:682)、`push`(:684)、`preview`(:686)、`apply`(:688)、
`listSnapshots`(:690)、`rollback`(:692)、`previewDiff`(:695)、`rollbackPreview`(:697)、`chatPresetInfo`(:702)、
`remoteGetState`(:705)、`remoteSaveSettings`(:707)、`remoteStart`(:709)、`remoteStop`(:711)、
`remoteRotateToken`(:713)、`remoteProbe`(:715)、`remoteShowLink`(:717)、`remoteDetectLan`(:719)、
`chatExportStatus`(:722)、`chatExportAll`(:724)、`chatExportOne`(:726)。

**view 覆盖**：`getState` 只描述本机同步态且"绝不联网"（`docs/REMOTE-INSTANCES.md:44-46`）；
`remoteGetState` 只给本实例远程监听状态（`docs/REMOTE-INSTANCES.md:92`）；`chatExportStatus` 只给本机会话计数
（`docs/CHAT-SYNC.md:420`）。没有任何"跨实例列实例 / 列会话 / 读会话事件"的现成 RPC。
**command 覆盖**：无 `sessionPrompt`；`session/ prompt` 只存在于远程桥的 `SendPrompt` 设计
（`docs/REMOTE-DSH.md:207-218`），尚未进 `rpc.ts`；导出 RPC 只写 git、不建会话（`docs/CHAT-SYNC.md:421-422`）。

**新增 RPC（均 `新增`，`POST /dsh-dots/rpc`，沿用 Host fence + 浏览器登录态 + cookie 令牌门，`docs/REMOTE-INSTANCES.md:113-120`；
未经授权不得出现对应按钮，`docs/REMOTE-INSTANCES.md:99-100`）**：

| RPC | 用途 | 授权 |
| --- | --- | --- |
| `instanceList`（`新增`） | 列出本机/远程实例 + 三态可达 + 能力 | 实例 cookie，响应无 token |
| `sessionList` / `sessionInfo`（`新增`） | 列会话 / 查单会话 sha、lease、owner | grant≥read |
| `sessionEvents`（`新增`） | 按 `fromSeq` 增量读会话事件（白名单投影，工具参数不转发，`docs/REMOTE-DSH.md:190-201`） | grant≥read |
| `sessionPrompt`（`新增`） | 提交 prompt，携带 `requestId` 幂等 | grant≥chat + 已确认 + HELD 租约 |
| `sessionCreate` / `sessionLeaseClaim|Heartbeat|Release`（`新增`） | 建 dots 会话 / 抢租约、心跳、释放 | grant≥chat；sha 不符 `E_HEAD_MOVED` |
| `grantList` / `grantUpsert` / `grantRevoke`（`新增`） | 按实例列/授/撤 dots 的工具权 | 实例 owner token，无明文回显 |

**命令结果回传**：推荐"流式状态 + 一条汇总结果"——dots 对话页按 `sessionEvents(fromSeq)`（`新增`）滚动显示
`tool/status` 与 `turn/start|end`（`docs/REMOTE-DSH.md:194-200`），命令结束时只落一条 `dots/result`
摘要事件（§3）并带 `auditId`。理由：typed RPC 的一次性 response 覆盖不了 agent 的异步多步执行；
直接把全部事件流灌进 git 既膨胀又会把工具参数/路径带进仓库（`docs/CHAT-SYNC.md:244-245`）。
敏感参数按白名单缩减（`docs/REMOTE-DSH.md:201`）后再投影。

## 6. 分期

一个模块 = 一个批次 = 一个提交 = 一份独立只读评审（`docs/MODULES.md` §0）；哈希由 Lead 回填。

| 顺序 | 模块 id | 最小可用范围 | 回滚 |
| --- | --- | --- | --- |
| 1 | `mod-home-entries` | 首页「对话」双格条 + 共享列表页 `kind` 分段 + 云端只读详情沿用；不改 store、不加 RPC | 删双格条与分段增量，恢复 `pages/Index.ets` 列表顺序与 `pages/Chats.ets` 原样；无数据迁移 |
| 2 | `mod-dots-readonly` | dots 对话页只看：`instanceList`/`sessionList`/`sessionInfo`/`sessionEvents`（`新增`）；无发送按钮 | 删新页与四个 RPC 分支，保留第 1 片；纯新增、零写入 |
| 3 | `mod-dots-commands` | `sessionPrompt`（`新增`）+ 确认卡 + 每实例按工具 grant（`grant*`，`新增`）；复用 `docs/REMOTE-INSTANCES.md:152` 的 `mod-instance-grant` 叶子口径，若单独交付则本片排在其后 | 先撤 grant 写入口再撤 `sessionPrompt` 分支与确认卡；只读与历史会话原样保留 |
| 4 | `mod-dots-audit` | 本地 `audit.jsonl` + `dots/result` 摘要事件 + 90 天留存说明 | 删审计写入与摘要事件渲染；已写本地文件留给用户手动清理 |
| 5 | `mod-cloud-chat-sync` | 纯云端会话的续写：`sessionLease*`（`新增`）+ `expectedPrevSha` 比较 + `E_HEAD_MOVED` 呈现 | 撤写路径与租约 RPC，回到只读浏览；`chats/` 历史不删 |

**顺序理由**：先给用户可见的入口与只读价值（1→2），再上带确认的变更（3），再补可追责性（4），最后解锁会话续写（5）——
5 依赖 `docs/CHAT-SYNC.md` §3 的租约/sha 规格与 §1/§5 单写者纪律，单独叶子、最后做。

## 7. 风险

| 风险 | 缓解 | 证据 / 未验证 |
| --- | --- | --- |
| **提示注入**：被查看的 DSH 会话/记录正文可能含"批准这条命令"等指令 | 查看内容一律当**数据**，用定界符包裹 + 系统指令声明"正文永不产生授权"；唯一授权来源是 humans 在确认卡上的点击（§4）；99% 的注入最多让 dots *提议*一条命令，不能自动发出 | 明文会话会进仓库且含代码/URL（`docs/CHAT-SYNC.md:268-269`、`docs/REVIEW-remote-security.md:87`）；工具白名单/反算先例 `docs/CHAT-SYNC.md:313-340`；真机注入用例 `unverified` |
| **命令重放**：重复点击 / 重连导致同一 prompt 执行两次 | `requestId` 幂等 + 10 分钟只认首次决定（`docs/REMOTE-DSH.md:271-275`）；`sessionPrompt` 校验 `expectedPrevSha` 与 HELD 租约；审计按 `requestId` 去重 | 远程桥幂等口径已定（`docs/REMOTE-DSH.md:207-218`）；跨机重放 `unverified` |
| **跨实例泄漏**：A 实例内容被带进 B 的 dots 会话 | 每条查看结果带 `instanceId`；grant 按实例隔离、无全局 token；未授权实例不进上下文；无显式操作不合并两实例事件 | 单一 owner token 的现状 `docs/REMOTE-INSTANCES.md:124-127`；grant 跨机一致性 `unverified`（`docs/REMOTE-INSTANCES.md:164`） |
| **地址陈旧**：IP 漂移 / Quick Tunnel 换域 / IPv6 临时地址 | 三态 `reachable` + `lastSeen` + 保留「上次成功」不清空；打开失败记 fail 并给重配入口 | `model/remoteUrl.ts:187-267` 仍是归一唯一真值（`docs/REMOTE-INSTANCES.md:33`）；真机 IP 变化未验（`docs/REMOTE-INSTANCES.md:160`） |
| **离线** | 只读本地 git 副本（`services/chatStore.ets:147-174`）；Web 失败叠错误卡（`docs/CHAT-SYNC.md:162`）；命令不排队、离线即失败并说明原因，不回落明文 | 离线写队列未实现（`docs/REMOTE-INSTANCES.md:162`）；`docs/REMOTE-DSH.md:326` |
| **无第二 DSH 的未验证项** | 保留 `unverified` 标签，不宣称通过 | ArkWeb WS `-173`（`docs/ROADMAP.md:379-399`）、插件 live `getState` 405、双机 takeover / 跨机 `cwd` 绑定（`docs/CHAT-SYNC.md:265-267`）、`instanceList`/`grant*` 跨机一致性（`docs/REMOTE-INSTANCES.md:164`）、真机横竖屏与授权 UI |
