# 远程实例统一管理（REMOTE-INSTANCES）设计

> 状态：**设计稿（本轮不改代码）**，2026-11-20。上位约束：`docs/UI-DESIGN.md`、`docs/CHAT-SYNC.md`、
> `docs/REVIEW-remote-security.md`、`docs/DATA-CONTRACT.md` §10 / `docs/DATA-CONTRACT-v2.md` §9。
> 行号均为本轮实读工作树（`git status` 另有在途改动，本文不碰）。文中 `新增` = 提案，今天不存在。
> 命名对齐：任务书的 `ChatList` 实为 `pages/Chats.ets`，`services/remoteUrl` 实为 `model/remoteUrl.ts`。

## 1 信息架构

**推荐：新建顶层页面 `pages/Instances.ets`，唯一入口挂在设置页「数据」组（把今天「云端对话（只读 ›）」
那一行 `pages/Settings.ets:2400-2436` 升级为「远程实例与云端对话 ›」）；不是新顶栏按钮，也不是设置组。**

| 方案 | 与现状冲突 | 结论 |
| --- | --- | --- |
| 首页加顶层入口 | 首页页头只能有「今天 / ⚙ 设置」（`pages/Chats.ets:15`、`tools/test/indexHeader.test.mjs`）；每屏 1 主操作（`docs/UI-DESIGN.md:24`） | 否 |
| 塞进设置页分组 | 设置页是「改配置」，实例/会话是「反复来读」（`docs/CHAT-APP.md:16`） | 否 |
| 独立顶层页 + 设置单一入口 | 会话页已是独立页面（`docs/CHAT-APP.md:11-18`）；新页走同一 `PageLayout` 三态（`docs/STATE-UI.md`） | **是** |

- **本机 ↔ 远程切换**：不做全局模式开关。列表按「本机（默认）」「其他电脑」两组渲染；点行即选中，
  本机行走本地 git 副本（`services/chatStore.ets:147-232`），远程行走内嵌 Web。避免假开关
  （`docs/REMOTE-ACCESS-OPTIONS.md:48-49`）。
- **云端会话行打开什么**：**混合式**——`pages/InstanceSession.ets` 顶部原生条显示实例名 / 三态可达性 /
  租约状态（`"此会话正在 pc-b 上使用（心跳 12:03）"`，`docs/CHAT-SYNC.md:192-193`）、底部原生动作
  「新建云端会话 / 在电脑上继续 / 复制干净地址」，正文用 `Web` 挂目标实例的 DSH 会话 UI
  （同一成熟路径 `pages/RemoteControl.ets:423-445`）。理由：`rpc.ts:677-730` 今天没有任何
  `sessionList/sessionCreate/sessionPrompt`，纯原生聊天 UI 必须全部新 RPC；纯 Web 又无法呈现租约、
  授权与离线只读副本。离线时正文退化为 `chatStore` 的只读消息流（`pages/ChatDetail.ets:114-143`）。
- **改动面**：新增 `pages/Instances.ets`（实例列表 + 三态）、`pages/InstanceSession.ets`（混合会话）、
  `model/instances.ts`（纯逻辑）、`services/instanceStore.ets`（§2）；改 `pages/Settings.ets`（入口行）、
  `components/settings/RemoteSection.ets`（加「管理实例」链接，字段语义不变，`RemoteSection.ets:7-18`）、
  `pages/Chats.ets`（行带 `instanceId`）、`pages/ChatDetail.ets`（`continueOnPc()` 改带实例，:162-172、
  :394-416）、`pages/RemoteControl.ets`（除 `url` 外接受 `instanceId`，:104-142）、两份 `main_pages.json`
  （`docs/CHAT-APP.md:17-21`）。`model/remoteUrl.ts:187-267` 仍是地址归一唯一真值，不写第二份。
- **空态**：无实例 → `EmptyState`「还没有可管理的 DSH 实例」+「在电脑 DSH → 远程访问 → 启动并点
  「显示二维码与链接」，把地址粘进来；本机（默认）实例会自动出现」+ 主操作「添加实例」+
  次操作「用浏览器打开」。旧 `settingsStore.remoteUrl` / `remoteLastOk`（`settingsStore.ets:273-282`）
  首次进入自动落成第一条远程实例，不清空历史配置（`Settings.ets:617-625`）。

## 2 实例模型

**字段**：`id`（`local` 或 `inst-<sha16(归一 url)>`）、`displayName`、`url`（**不含 token** 的 base）、
`mode`（`lan/tailscale/ipv6/cloudflare/manual/uu`，`remote/types.ts:21`）、`tokenRef`、`lastSeen`、
`reachable`（三态 `true/false/null`）、`capabilities`（派生，不落盘）、`source`（`default/manual/legacy`）。
`capabilities` 由探测给出：`webUI`（恒有）、`rpc`（`/dsh-dots/rpc` 可达）、`chatExport`（`chatExportStatus`）、
`lease`、`sessionCreate`（`新增`）。`unknown` 永远不降级成 `ok`（`docs/REMOTE-ACCESS-OPTIONS.md:243`），
对应 `rpc.ts:205-207` 的 `reachable` 三态与 `getState`「绝不联网」（`rpc.ts:198-208`）。

**存哪**：推荐**新 `services/instanceStore.ets`，preferences 中一个 `instances.json` 字符串键**
（读写成对，仿 `settingsStore.ets:273-282/702-711`）；`AppStorage` 只做 UI 镜像，不做真值；
**不进 Git 仓库**——`chats/` 契约禁止凭据与绝对路径（`docs/DATA-CONTRACT.md:350`），
git 历史删不掉 blob（`docs/CHAT-SYNC.md:268-269`）。`PersistentStorage` 那几个键是非秘密开关
（`docs/DATA-CONTRACT-v2.md:249`），不塞实例表。

**token 保护**（`docs/REVIEW-remote-security.md`）：明文只经 `remoteShowLink` 显式出口（`rpc.ts:610-612`）；
状态只给 `tokenSet/tokenMasked`（`remote/types.ts:84-89`、`service.ts:288`）；不进日志、错误消息、
`remoteGetState`（评审 §2.3）；URL 展示过 `sanitizeUrlForDisplay`（`model/remoteUrl.ts:720-751`）；
`remoteLastOk` 落盘前 `stripRemoteToken`（`RemoteControl.ets:179-190`、`remoteUrl.ts:553-589`）。
新增纪律：实例序列化 / 导出 JSON / 诊断行一律只写 `tokenRef`，健康探测结果不带 token；
`?token=` 只在一次性握手出现，由令牌门消费成 303 + cookie（`remote/routes.ts:176-209`）。
已知限制：preferences 明文（无 HUKS，`docs/REMOTE-DSH.md:368`），Windows 无 0600 ACL
（`docs/REVIEW-remote-security.md:150-155`）——标 `unverified` 加固项，不谎报。

**本机表示**：推荐**显式首行 `id:'local'`、不可删除/改 URL**，而不是散落的 `if (isLocal)` 隐式特例。
理由：会话要成为管理入口（§1），若本机隐式，则 Chats / ChatDetail / 授权三处都要写特例，权限模型不对称。
代价：要维护一条合成记录 + 能力集（`webUI:false`、RPC 走回环、lease owner = 本机 `deviceId`）。
口径：PC 插件侧「本机」= 该 PC；平板侧平板不跑 DSH，故「本机」= 默认连接实例（来自 `remoteLastOk`），
UI 文案写「本机（默认）」。

## 3 协议

**今天存在的 RPC**（`packages/dsh-dots/src/rpc.ts:677-730`，全部 `POST /dsh-dots/rpc`）：
`getState`、`saveSettings`、`testConnection`、`push`、`preview`、`apply`、`listSnapshots`、`rollback`、
`previewDiff`、`rollbackPreview`、`chatPresetInfo`、`remoteGetState`、`remoteSaveSettings`、`remoteStart`、
`remoteStop`、`remoteRotateToken`、`remoteProbe`、`remoteShowLink`、`remoteDetectLan`、`chatExportStatus`、
`chatExportAll`、`chatExportOne`。导出层真 API 见 `docs/CHAT-SYNC.md:406-422`。

| 六项能力 | 今天 RPC | 今天内嵌 Web | 推荐（现实路径） |
| --- | --- | --- | --- |
| 1 列出可达实例 | **无**：`remoteGetState` 只描述本机一条监听（`remote/types.ts:176-183`）；git 的 `devices/registry.jsonl` 只是编号表（`docs/DATA-CONTRACT.md:367-370`） | 无列表语义 | 第一片做**平板本地列表**（零 RPC）；跨机清单才需 `新增 instanceList` |
| 2 打开 / 管理任一实例 | 仅本机的 `remoteStart/Stop/Probe/ShowLink` | DSH 完整 UI 可开（`RemoteControl.ets:423-445`） | Web + 原生动作；远程管理不新造 RPC |
| 3 平板上在指定实例建云端会话 | **无**（`chatExport*` 只导出到 git） | DSH Web 可新建 | 第一片走 Web；原生建会话需 `新增 sessionCreate` |
| 4 会话作为管理入口 | 无实例绑定：`chats/index.jsonl` 只有 5 字段（`docs/DATA-CONTRACT.md:354`） | 可从会话跳远程控制（`ChatDetail.ets:162-172`） | 先加 `instanceId` 投影，`新增 sessionInfo` |
| 5 PC 插件建同类会话 | `chatExportOne/All` 可导出，不能建 | Web 可建 | 先复用导出 + Web；原生建需 `新增 chatCreateOn` |
| 6 授权哪台设备管哪实例 | 只有单一 owner token + `remoteRotateToken`（`rpc.ts:602-604`）；配对/吊销仅设计（`docs/REMOTE-DSH.md:1.1 G6`） | DSH 设置页无 per-device grant | 只能走 `新增 grant*`；第一片沿用「一实例一 token」 |

**结论**：RPC 路径对 1/3/4/5/6 都缺关键动作；第一片只有「Web + 本地列表 + 既有 remote*/chatExport*」
是现实可行的。所有下列动作均为 **`新增`**，未实现前 UI 不得出现对应按钮（无假入口，工作区根 `项目理解.md` §1 非目标「没有假条目」）。

| 新增 RPC（均 `POST /dsh-dots/rpc`） | request | response | auth |
| --- | --- | --- | --- |
| `instanceList` | `{includeUnreachable?:boolean}` | `{instances:[{id,displayName,mode,urlMasked,reachable,capabilities,lastSeen}]}` | 实例 cookie；响应无 token |
| `sessionList` | `{instanceId?,limit?,cursor?}` | `{items:[{sessionId,title,updatedAt,messageCount,sha256,instanceId,lease}],nextCursor}` | 实例 cookie + grant≥read |
| `sessionCreate` | `{instanceId?,title?,agentPreset:'chat'}` | `{sessionId,instanceId,url}` | grant≥chat；非 chat preset 拒（`docs/CHAT-SYNC.md:293-300`） |
| `sessionInfo` | `{sessionId}` | `{instanceId,sha256,lease,owner}` | grant≥read |
| `sessionPrompt` | `{sessionId,requestId,text,expectedPrevSha,leaseOwner}` | `{seq,sha256,accepted}` | grant≥chat + HELD 租约；requestId 幂等 |
| `sessionEvents` | `{sessionId,fromSeq,limit}` | `{events[],nextSeq,sha256}` | grant≥read |
| `sessionLeaseClaim/Heartbeat/Release` | `{sessionId,expectedPrevSha,owner,ttlSec?}` | `{lease,sha256}` | grant≥chat；sha 不符 → `E_HEAD_MOVED` |
| `grantList/grantUpsert/grantRevoke` | `{instanceId,deviceId?,scope?,expiresAt?}` | `{grants:[{deviceId,scope,expiresAt}]}` | 实例 owner token；无 token 明文回显 |

**鉴权模型**：RPC 路由先用 `connection.requestRejection(req)` 过 Host/Origin fence + 浏览器登录态
（`rpc.ts:794-802`，fence→403 / 无会话→401，`docs/REMOTE-DSH.md:124`）。经远程反代访问时先过我们自己的
令牌门：`?token=`/`?k=` 命中后**本层消化**成 303 + `HttpOnly; SameSite=Lax` cookie，绝不转发上游
（`remote/routes.ts:176-209`；评审 §9 第 5 条）；后续所有 RPC 带 cookie，cookie 校验失败 401
（`routes.ts:220-230`），同 IP 多次失败 429 + `Retry-After`（:204-208/222-226），上游身份拿不到 503
（:233-237）。**推荐：token 只走一次性 query 握手，之后只用 cookie；每实例一 token，独立于 Git token
与 DSH launch token；body/header/日志永不写 token。** `x-dsh-remote-token` 头文档承诺未实现
（`docs/REVIEW-remote-security.md:19,168`），不得依赖。

## 4 授权

**模型**：owner token（每实例一把，`crypto.randomBytes(32)`、`remote-token.json` 0600、
`docs/REMOTE-ACCESS-OPTIONS.md:269-271`）= 管理该实例的能力；**per-instance grant** =
`deviceId → {instanceId, scope∈read|chat|manage, expiresAt}`，可吊销；**session lease** = 单会话写者身份
（`docs/CHAT-SYNC.md:2.2`）。第一片只兑现 owner token + 隐式「持 token 即可管」；grant 是 `mod-instance-grant`。
**UI**：实例行徽章「已授权 / 只读 / 无权限」；授权页列设备 + scope + 到期 + 「撤销」；会话条显示 owner
与心跳；30 分钟无心跳降级「可能已释放」但仍不自动夺取（`docs/CHAT-SYNC.md:193`）。
**错/过期 token**：401（令牌不对/缺失）、429（限速）、403（fence）按 §3 原样上屏并给下一步；
grant 过期 → 降只读 + 「授权已过期，请重新授权」，**不换令牌自动重试**（fail-closed）。
**为什么云端会话只读（按构造关闭）**：`chats/` 是接管制共享事件流，不是并写日程
（`docs/DATA-CONTRACT.md:331,356-358`）。`meta.sha256` 是整文件字节锚（:348-350），租约 TTL 10min /
心跳 60s、仅 `owner==本机 deviceId` 可写（:351-353）；追加前必须 `expectedPrevSha == 远端 meta.sha256`
且提交前重读远端（`docs/CHAT-SYNC.md:127-137`），失败即中止、**不合并、不按 ts 折叠**
（:174-184）。失败语义：`E_HEAD_MOVED`（`新增` typed 码，对应今天「sha 不匹配 → 先拉取」，:174）
保留本地尾巴原样；**stale lease**（`exp<now`）显示「已 N 分钟无心跳，可接管」并允许 claim（:176）；
**takeover**（`exp>now && owner≠我`）进 `OBSERVING`，一个字节都不写（:131-132、:166）；claim/上传
过程中发现他人写入立即降级（:180）。四态机 `FREE/CLAIMING/HELD/OBSERVING` 见 :140-166。

## 5 分期（一个模块 = 一个批次 = 一个提交 = 一份独立只读评审，`docs/MODULES.md` §0）

- **第一片（最小可用闭环）**：`mod-instance-model`（`model/instances.ts` + `services/instanceStore.ets`，
  纯模型 + preferences，零 UI；回滚 = 删两新文件）；`mod-instance-list`（`pages/Instances.ets` + 设置入口 +
  两份 `main_pages.json`；回滚 = revert 页面与入口行）；`mod-instance-session-create`（`pages/InstanceSession.ets`
  + 行动作，走**内嵌 Web** 在选定实例建会话；回滚 = revert 新页与参数处理）。三批各自评审、各自回滚，
  互不混提。
- **后期一**：`mod-chat-lease`——`sessionLease*` + 头 sha 比较与四态机（只建模/RPC、不出写 UI）；
  依赖第一片；回滚 = revert 纯模型 + 新增 RPC 分支。
- **后期二**：`mod-chat-write`——`sessionPrompt` 原生写入 + `E_HEAD_MOVED` 呈现；依赖 `mod-chat-lease`
  与 §7 的两个前置；回滚 = revert 写 UI 与 RPC，租约模块保留。
- **后期三（建议）**：`mod-instance-grant`——`grant*` + 授权 UI；独立叶子，可单独回滚。
  每批提交 subject 前缀 `[mod-<id>]`，哈希由 Lead 回填，执行者不猜（`docs/MODULES.md` §3）。

## 6 风险

| 风险 | 缓解 | 证据 / 未验证 |
| --- | --- | --- |
| 单写者被破坏（两端同 `seq`） | 租约 + head-sha compare-and-append，失败 fail-closed（§4） | 坏结局见 `docs/CHAT-SYNC.md:17-34`；双机 takeover **unverified**（无第二 PC / 平板，STATE-OF-PROJECT §5） |
| 地址陈旧（IP 漂移 / Quick Tunnel 重启换域 / IPv6 Temporary） | 三态 reachable + lastSeen + 「上次成功」保留不清空（`docs/CONFIG-UX.md:279`） | `docs/REMOTE-ACCESS-OPTIONS.md:15,86,110`；真机 IP 变化未验 |
| token 泄漏进日志 / 导出 / git | 只经 ShowLink；状态只 tokenSet/tokenMasked；URL 打码 + 剥 token；实例导出只写 tokenRef（§2） | M3 旧洞 `docs/REVIEW-remote-security.md:84-86`；git blob 不可删 `docs/CHAT-SYNC.md:268-269` |
| 离线 | 只读本地 git 副本（`chatStore.ets:147-174`）；Web 失败叠错误卡（`RemoteControl.ets:382-417`）；不回落明文 | `docs/REMOTE-DSH.md:326`；离线写队列未实现 |
| PC / 平板混版本 | 探测 capabilities；缺新 RPC 一律 Web 降级或禁用 + 原因；未知 schema 只读 | `docs/DATA-CONTRACT-v2.md:239-245` 同向先例 |
| 未验证（需第二设备 / PC） | 保留标签，不宣称通过 | ArkWeb WS `-173`（`docs/ROADMAP.md:379-399`）、插件 live `getState` 405（`docs/STATE-OF-PROJECT.md:70`）、真机横竖屏 / 授权 UI、跨机 `cwd` 绑定（`docs/CHAT-SYNC.md:265-267`）、`instanceList/grant*` 跨机一致性 |

## 7 与现有六点计划的关系

| 早前改动 | 关系 | 理由 |
| --- | --- | --- |
| v2-only（默认 v2 / 停 v1 写） | **前置（仅 `mod-chat-write`）** | `chats/` 豁免 timeline 门禁（`docs/DATA-CONTRACT-v2.md:295`），但写会话要复用统一周期（:192-205）；第一片不依赖 |
| import-v1（v1→v2 迁移） | **前置（仅 `mod-chat-write`）** | 避免双库分叉；`chats/` 不迁移（`docs/DATA-CONTRACT-v2.md:273`） |
| remote hints fix（UU/probe 旧判定） | 独立 | 只影响可用性文案；残留见 `docs/REMOTE-ACCESS-OPTIONS.md:338-344`、`docs/CONFIG-UX.md:309-313` |
| export JSON | 独立 | 只共享 token 卫生纪律；实例表**不得**进导出（`docs/EXPORT-IMPORT.md`） |
| home filters（搜索 / 状态 / 作者筛选） | 独立 | 纯首页读侧（`docs/FEATURE-BACKLOG.md:18`）；首页页头不动（`pages/Chats.ets:15`） |
| 第六项（任务书未具名） | 待 Lead 指明，暂按独立处理 | 不在本轮只读材料内，不臆测 |

**推荐顺序**：remote hints fix → export JSON → home filters（三者可并行、独立回滚）→ v2-only + import-v1
（解锁写入）→ `mod-instance-model` → `mod-instance-list` → `mod-instance-session-create` →
`mod-chat-lease` → `mod-chat-write` → `mod-instance-grant`。第一片三模块可在两个前置完成前先交付。
