# 远程 DSH（REMOTE-DSH）设计文档 v0.1

> 状态：**设计草案，仅评估、未实现**。本文只做调研与设计，不含任何代码改动。
> 证据基线：本机 DSH `@deepseek-ai/dsh@0.2.2-rc.3`（与 `docs/CONTRACT.md` 一致）。证据清单见附录 A。
> 标注约定：**已验证**=读过实现/文档；**待确认**=需用户决策；**未验证**=本机无法证明。
## 1. 目标与非目标

### 1.1 目标（手机端要能做什么）

| # | 能力 | 说明 | 里程碑 |
|---|---|---|---|
| G1 | 会话列表 | 只读列出本机会话（标题、最近活动、是否可续聊），点进去看最近若干条 | M1 |
| G2 | 发消息 | 向选定会话投递一条 prompt；不新建工作区、不改 agent preset | M1 |
| G3 | 流式看回复 | 增量看到 assistant 文本与工具调用状态（只读投影，不还原完整事件流） | M1 |
| G4 | 审批卡片 | 收到危险操作请求 → 允许 / 拒绝 / 超时拒绝 | M2 |
| G5 | 快捷指令 | 少量预置动作（继续、取消本轮、新建会话），带白名单 | M3 |
| G6 | 配对与吊销 | 扫码配对、安全码比对、密钥轮换、本机一键吊销 | M1 |

### 1.2 非目标（明确不做）

| # | 不做 | 理由 |
|---|---|---|
| N1 | 完整 IDE / 文件编辑器 | 手机端不适合；写文件一律走审批卡片，不做自由编辑 |
| N2 | 文件树浏览与上传下载 | DSH 已有 `/api/file` 与 `session/attachment`（已验证存在），但手机侧不做通用文件面 |
| N3 | 插件安装 / 卸载 / 升级 | `plugin_manager` 属「本机动作」，手机上不得直达 |
| N4 | 终端 / bash / pwsh 直连 | 只允许经 agent 的审批链路间接触发 |
| N5 | 多用户 / 团队共享 | 一期单 owner、单手机（配对表可含 ≤3 台，无角色区分） |
| N6 | 让手机成为 DSH「owner Peer」 | owner 等于全权，与「审批卡片」的设计目标冲突（见 §3.4） |

## 2. 威胁模型与前提

### 2.1 前提（不满足则本设计不成立）

| # | 前提 | 现状 |
|---|---|---|
| A1 | DSH 只监听回环（本机 Web GUI `http://127.0.0.1:37510`） | **已验证**：`dsh-host-webserver` 有 `isLoopbackHost()` 与可配置 `host`；本实例按回环使用 |
| A2 | 插件可通过 `ctx.connection.requestRejection(req)` 复用 DSH 登录态 | **已验证**：`dsh-dots` 即此用法，401/403 由 connection 判定 |
| A3 | 手机与 DSH 之间**不存在**可信网络 | 设计前提 |
| A4 | 密钥只存在于手机与本机两侧 | 需实现保证；手机侧现为 `preferences` 明文（§10 决策 5） |
| A5 | 中继只做转发，可能记录元数据、可能被攻破 | 因此 E2E 加密为硬要求 |

### 2.2 资产与威胁

| 资产 | 威胁 | 对策 | 残余风险 |
|---|---|---|---|
| 会话内容（prompt/回复/工具参数） | 中继窃听 | AES-256-GCM 端到端（§3.2） | 流量分析可推测活跃度（可选填充缓解） |
| 配对密钥 | 二维码被拍、截图外泄 | 首连本机人工确认 + 6 位安全码比对（§4.3） | 用户误点「允许」 |
| 危险操作执行权 | 手机被盗后越权批准 | 审批卡片 + 超时拒绝 + 设备级吊销 | 手机解锁状态下被盗用 |
| 本机身份（owner 全权） | 恶意中继诱导越权 | 手机**不是** owner Peer，走独立通道与白名单 | 实现若直连 `/api`，全盘失守 |
| 审计完整性 | 事后无法追责 | 本机 append-only 审计 + DSH 自带 `approval/asked/decided` | 审计文件被高权限进程改写 |

**显式不防御**：本机已被完全控制、手机系统级后门、DSH 自身漏洞、中继与手机合谋（此时 E2E 只保护「非合谋的中继」）。
## 3. 协议设计

### 3.1 传输：出站 WebSocket（本机主动连中继）

```text
 手机 App              中继（不可信）            本机 DSH
┌─────────┐          ┌─────────────┐         ┌──────────────────────┐
│ WSS 客户端│◀─密文──▶│ 按 channel 路由│◀─密文──▶│ dsh-remote-bridge    │
└─────────┘          └─────────────┘         │ （插件，出站 WSS）   │
                                              │   ↓ 进程内           │
                                              │ sessionController    │
                                              │ approval 应答者      │
                                              └──────────────────────┘
```

时序（连接建立）：

1. 本机插件读配对表 → 向 `relay` 发起**出站** `wss://` 连接，`channel` 作为路由键。
2. 中继登记 `channel → 本机连接`，回 `relay_ready`（**明文**，仅路由信息，无业务内容）。
3. 手机连同一 `channel`，中继把两端密文帧互转（中继不需要、也无法解密）。
4. 双方各发 `hello`（密文，含 `deviceId`、`epoch`、`lastSeenSeq`），校验通过后进入业务帧。

要点：不开公网入站端口（不改 `host` 绑定，A1 保持不变）；中继只见 `channel`、连接时刻、帧长与频率；中继不可用时退化为「局域网直连」（§7，默认关闭）。

### 3.2 端到端加密（AES-256-GCM）

| 项 | 设计 |
|---|---|
| 主密钥 | 配对时生成的 32 字节 `secret`（§4.1），只在手机与本机存在 |
| 子密钥派生 | `HKDF-SHA256(ikm=secret, salt=UTF8(channelId), info="dshremote/v1/<dir>")`，`dir ∈ {h2p,p2h}`，输出 32 字节；**双向不共钥**，避免反射攻击 |
| 算法 | AES-256-GCM，96-bit nonce，128-bit tag |
| nonce 结构 | `nonce = epoch(4B) ‖ counter(8B)`，**counter 必须等于帧头 `seq`**；接收端校验 `counter == seq`，否则丢弃（防发送方重造 nonce） |
| epoch | 每次重连由本机新生成 `uint32`（CSPRNG）；重连后计数器归零也不会 nonce 复用 |
| AAD | UTF-8 的 `"v|type|id|channel|ts|seq"`（顺序固定、无空格）；头部任何篡改都使 GCM 失败 |
| 密文字段 | `cipher = base64(nonce(12) ‖ ciphertext ‖ tag(16))`，自描述，中继无需理解也不破坏 |
| 计数器上限 | 同一 `(key, dir, epoch)` 最多 `2^32` 帧，超过强制 `rekey`（§4.4） |

**重放防护（三层）**：① `seq` 本方向严格单调，接收端维护 1024 宽滑动窗口（容忍乱序、不容忍重复）；② `ts` 与握手对齐的时钟偏移相差 >300 秒的帧丢弃；③ `id` 去重表保留最近 4096 条（TTL 10 分钟），重复 `id` 仅返回上次结果（§6.3 幂等）。

### 3.3 消息封包格式

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| `v` | string | 是 | 协议版本，固定 `"1"`；不匹配则断开并提示升级 |
| `type` | string | 是 | 见 §3.4 / §5 的消息类型 |
| `id` | string | 是 | 帧唯一 id（UUIDv4），用于去重与请求/响应关联 |
| `channel` | string | 是 | 频道 id（§4.1），中继也用它路由；与配对不一致即拒绝 |
| `ts` | number | 是 | 发送端毫秒时间戳，参与 AAD |
| `seq` | number | 是 | 本方向单调计数器，同时是 nonce 的 counter |
| `payload` | object | 否 | **明文**载荷；只允许中继层控制帧（`relay_*`）使用，永不承载会话内容 |
| `cipher` | string | 否 | `base64(nonce‖ct‖tag)`；业务帧必须用它，且与 `payload` 互斥 |

约束：`payload` 与 `cipher` 必须**恰好出现一个**；两者同时出现或都缺失 → 断链（视为攻击或实现错误）。

### 3.4 与 DSH 现有接口的映射（重要结论）

**已验证**：DSH 0.2.2-rc.3 已具备会话与审批的完整 Remote 接口，不必从零发明：

| DSH 能力 | 形态 | 证据（附录 A） |
|---|---|---|
| 一元 RPC | `POST /api`（`API_PATH='/api'`），Typert 分发 | `dsh-client-connection/src/api-path.ts:8` |
| 多路复用流 | WebSocket `/api/remote.mux`；客户端帧 `open/item/end/cancel`，服务端帧 `item/error/end` | `dsh-api-gateway/src/stream-protocol.ts:9,237-259` |
| 会话端点 | `session/list`、`prompt`、`cancel`、`create`、`events`、`follow`、`observeEvent`、`state`、`wait`、`search`、`rename`、`fork`、`updateQueue`、`control` 等 | `dsh-api-session-controller/src/index.ts:283-650` |
| 审批请求 | Cordis waterfall `approval/request`，且是**唯一**转发给客户端的交互事件 | `dsh-api-remotes/src/remote-events.ts:31`；`dsh-user-approval/src/types.ts:79-93` |
| 审批结果词汇 | `allowed-once \| rejected \| cancelled \| unavailable`，无 `allow-always` | `dsh-user-approval/src/types.ts:33` |
| 审批审计 | 会话日志追加 `approval/asked` 与 `approval/decided` | `dsh-user-approval/src/types.ts:35-61` |
| 非 owner 权限 | `remoteAccess.decide({principal, action, resources, args})`，列表逐项 `allows()` 过滤 | `dsh-api-remote-access/README.zh.md` |
| 外部 API 客户端登录 | `GET /connect?token=<进程启动令牌>` 换 API operator（`CONNECT_PATH='/connect'`） | `dsh-client-connection/src/connect-protocol.ts`；`rpc-host.ts#admit()` |

但**均不能直接给手机用**，三条硬限制（均已验证）：

1. **鉴权面是「本机进程」级**：`/api` 先过 Host/Origin fence（→403），再认浏览器签名 Cookie 或 `/connect` 换来的启动令牌（→401）。启动令牌每次启动随机、只出现在本机 GUI 地址里；交给手机等于交出 owner 全权（`admit()` 直接把浏览器请求当 `browserPeer`）。
2. **审批瀑布只有 owner 能作答**：`$events` 与 `$events/result` 都要求 `peer.interactions === 'answer'`（否则 `gateway/interactions-forbidden`），且非 owner 只能收策略放行的广播帧，不能参与交互。
3. **审批请求不带工具参数**：`ApprovalRequestEvent` 只有 `agent/toolName/callId?/reason?/displayReason?/signal?`，**没有**命令行、路径、文件内容 —— 手机卡片天然无法展示「要写哪个文件」。

**结论**：需新增插件侧出站桥（本文称 `dsh-remote-bridge`），在进程内以 Cordis 服务身份工作（`ctx.sessionController` / `ctx.on('approval/request')`），不经过 `/api`、不占用 `/api/remote.mux`、不给手机开任何入站路由。若一期也要「局域网直连」，用 `ctx.webServer.registerUpgrade({kind:'exact', path})`（**已验证存在**，`dsh-host-webserver/src/index.ts:461`）新增独立路径，仍用自己的配对密钥，不复用 DSH owner 鉴权。
## 4. 配对与密钥

### 4.1 channel 与 secret 的生成规则

| 值 | 生成 | 编码 | 熵 |
|---|---|---|---|
| `channelId` | 本机 `crypto.randomBytes(16)` | Crockford Base32（26 字符，前缀 `ch_`，全小写、去易混字符） | 128 bit |
| `secret` | 本机 `crypto.randomBytes(32)` | base64url 无填充（43 字符） | 256 bit |
| `pairingNonce` | 每次生成二维码 `randomBytes(8)`，仅用于配对期防重放 | hex（16 字符） | 64 bit |

由**本机**生成（本机长期在线、需跨手机重装存活）。`channelId` 与 `secret` 相互独立；泄露 `channelId` 只意味着「能往这个信箱塞垃圾」，不能解密、不能冒充（无 secret 时 GCM 校验失败）。

### 4.2 二维码载荷

```text
dshremote://pair?ch=ch_7k3m9q2v4x8b1n6t5r0y2w4c&relay=wss%3A%2F%2Frelay.example.com&v=1&pn=9f2c41a7b3d05e6c#k=<base64url-secret>&fp=<6位安全码>
```

**为什么密钥放 fragment 而不是 query**：① fragment 不参与 HTTP 请求——用户误贴进浏览器或分享链接被预览机器人抓取时，`?ch=…` 会进服务器访问日志，`#k=…` 留在客户端；② 不进 `Referer`；③ 不进中继/网关日志——`relay=` 作为元数据在中继日志里可接受，secret 若做成 `?k=` 会与它同处一条日志；④ 自定义 scheme 的 App 仍完整拿到 fragment，成本为零。

**不建议**：把 secret 编进路径段（`dshremote://pair/<secret>`）；或让中继生成下发密钥（中继即成为可信第三方，违背 A5）。

### 4.3 扫码后本机如何确认（防中间人）

```text
1. 手机扫码 → 得到 ch / relay / k / fp
2. 手机用 k 连中继，发 hello（密文，含 deviceId 与手机生成的 devicePub=randomBytes(16)）
3. 本机解密成功（证明双方共享同一 k）→ 本机 GUI/托盘弹「配对请求：<设备名>，安全码 481 902」
4. 用户对比手机与本机显示的安全码，一致 → 本机点「允许」
5. 本机把 deviceId 写入配对表（0600）；后续同 deviceId 免确认（可关）
```

安全码 = `SHA-256(channelId ‖ secret ‖ devicePub)` 取十进制前 6 位，用于抵抗「二维码被换成攻击者的」：换成攻击者的 secret 后，本机弹窗与手机显示的安全码不一致。**首连必须人工允许**（TOFU + 显式确认）：二维码可能被长焦远拍，仅凭扫码即授权不可接受；配对表为空时也不得自动放行。

### 4.4 轮换与吊销

| 动作 | 流程 | 失败处理 |
|---|---|---|
| 主动轮换 | 本机发 `rekey`（旧密钥加密，含新 `secret` 与 `newEpoch`）→ 手机回 `rekey_ack` → 双端切换，旧密钥保留 10 分钟 | 无 `ack` → 保持旧密钥并告警，不改状态 |
| 定期轮换 | 每 30 天或每 `2^32` 帧（先到者为准） | 同上 |
| 吊销单台 | 删配对表项 + 断连 + 向中继发 `evict`（踢掉该 channel 其它连接） | 中继不配合时本机侧拒绝该 deviceId 一切帧（本地生效） |
| 全量吊销 | 删整个配对表并换 `channelId`，旧二维码立即失效 | 旧手机 UI 显示「配对已失效，请重新扫码」 |
| 泄漏处置 | 立刻换 `channelId`+`secret`；用审计与会话日志回溯 | 无法撤回已发出的 prompt（模型已执行） |

## 5. 最小数据契约

> 给 App 与插件 reviewer：以下 5 条是最小集合。业务帧一律用 `cipher` 包裹（§3.3），载荷字段名即本节字段。时间一律 ISO-8601 带时区；`seq` 指 DSH 持久事件序号。

### 5.1 `ListSessions`（手机 → 本机，一元）

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| `cursor` | string? | 否 | 上一页游标；缺省取第一页 |
| `limit` | number | 否 | 每页条数，默认 20，上限 50 |

响应 `ListSessionsResult`：`items[]`（`{sessionId,title,lastActivityAt,agentAvailable,busy}`）、`nextCursor`（无更多时为 `null`）。

```json
{"cursor":null,"limit":20}
```

### 5.2 `SessionEvent`（本机 → 手机，流式增量）

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| `sessionId` | string | 是 | 会话 id |
| `seq` | number | 是 | DSH 持久事件序号，单调；缺口触发 `resume(fromSeq)` |
| `kind` | string | 是 | `user/message` \| `assistant/delta` \| `tool/status` \| `turn/start` \| `turn/end` \| `error` |
| `text` | string? | 否 | `user/message`/`assistant/delta`/`error` 的文本 |
| `tool` | object? | 否 | `{name, callId?, status:'running'|'ok'|'failed'}` |
| `ts` | string | 是 | 事件时间 |

**投影规则**：DSH 的 `SessionWireEvent` 远大于此（含完整工具参数与结果），桥只做**白名单缩减**，工具参数一律不转发（避免把大块内容与密钥带出）。**未验证**：`seq` 在 `session/follow` 之外是否处处连续；若存在空洞，桥需自行补 `gap` 标记（M1 实现时确认）。

```json
{"sessionId":"01J9Z6Q2","seq":184,"kind":"tool/status","tool":{"name":"write","callId":"call_7","status":"running"},"ts":"2026-11-15T15:20:03+08:00"}
```

### 5.3 `SendPrompt`（手机 → 本机）

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| `sessionId` | string | 是 | 目标会话（必须是列表里出现过的） |
| `requestId` | string | 是 | 幂等键；重发必须复用同一值（对应 DSH 的 `rpcId` 语义） |
| `text` | string | 是 | 非空白文本；空内容一律拒绝 |
| `clientTimeZone` | string? | 否 | IANA 名或 `UTC`（DSH `session/prompt` 已有该参数） |

```json
{"sessionId":"01J9Z6Q2","requestId":"f4a1c0de-5b2e-4c11-9a7d-2b6e1f0c3a55","text":"把刚才的改动整理成提交说明","clientTimeZone":"Asia/Shanghai"}
```

### 5.4 `ApprovalRequest` / `ApprovalDecision`

| 字段 | 方向 | 类型 | 必填 | 语义 |
|---|---|---|---|---|
| `approvalId` | 双向 | string | 是 | 桥生成的 id（DSH 事件**不含** id，见 §3.4 限制 3） |
| `sessionId` | 请求 | string | 是 | 属于哪个会话 |
| `toolName` | 请求 | string | 是 | 工具名（`write`/`bash`/`pwsh`/`plugin_manager`…） |
| `callId` | 请求 | string? | 否 | DSH 有则带上，作更强幂等键 |
| `reason` | 请求 | string? | 否 | 本机给出的原因文本 |
| `expiresAt` | 请求 | string | 是 | 超时时刻（默认 +120s），到点即拒绝 |
| `decision` | 决定 | string | 是 | `allow` \| `deny`，映射 DSH 的 `allowed-once` / `rejected` |
| `decidedAt` | 决定 | string | 是 | 手机侧决定时间（仅审计，不用于判时效） |

```json
{"approvalId":"ap_01J9Z7A1","sessionId":"01J9Z6Q2","toolName":"write","callId":"call_7","reason":"写入工作区之外的文件","expiresAt":"2026-11-15T15:22:03+08:00"}
```

### 5.5 `QuickAction`（手机 → 本机）

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| `action` | string | 是 | 白名单：`session.cancel` \| `session.create` \| `prompt.continue` |
| `sessionId` | string? | 否 | `session.create` 时可缺省 |
| `requestId` | string | 是 | 幂等键 |

```json
{"action":"session.cancel","sessionId":"01J9Z6Q2","requestId":"9b1e77aa-3c4d-4f80-9d21-77c0b1a2e9f1"}
```
## 6. 审批卡片

### 6.1 什么操作必须审批

| 类别 | 例子 | 必须审批 | 说明 |
|---|---|---|---|
| 写文件 | `write` / `edit` / `str_replace_editor` | **是** | DSH 按 `ask` 策略已要求审批，桥只搬运动作 |
| 执行命令 | `bash` / `pwsh` / 沙箱升级（`sandbox_permissions`） | **是** | 沙箱升级尤其危险 |
| 网络外发（带数据） | `web_fetch` POST、上报类工具 | **是** | 「外发」指把本机数据送出去；纯 GET 检索视为只读 |
| 插件管理 | `plugin_manager`（安装/删除） | **是** | 一期可进一步禁止（N3） |
| 只读 | `read` / `glob` / `grep` / `todo_write` | 否 | 不打扰用户 |
| 会话级 | `session/prompt` | 否 | 发消息本身就是用户意图 |

**关键约束（已验证）**：`ApprovalRequestEvent` 不携带工具参数，卡片只能显示 `toolName + reason`。要显示「具体命令/路径」有两条路，都需先决策（§10 决策 4）：① 上游给事件加字段（不在本仓库范围）；② 桥侧按 `callId` 从会话事件旁路反查——**未验证可行性**，且引入「参数与执行不一致」的新风险。

### 6.2 超时与默认拒绝

| 参数/场景 | 默认 | 说明 |
|---|---|---|
| `approvalTimeoutMs` | 120000（上限 600000） | 到点以 `rejected` 结算（不是 `cancelled`——表达「没人批」）；不允许无限期挂起（DSH 审批仅在未结束轮次内有效） |
| 手机断线 | 立即 `rejected` | 不排队等重连；重连后不「复活」审批（DSH 一次性授权也无法恢复） |
| 无应答者 | `unavailable` | 桥未启用时的固有结果，调用方 fail-closed（DSH 已如此） |

### 6.3 幂等（重复点击不会重复执行）

- **幂等键**：优先 `callId`，缺失用 `approvalId`；**去重窗口** 10 分钟，只接受第一次决定，后续返回首次结果（不重执行、不二次写审计）。
- **一次性**：DSH 侧只有 `allowed-once`，没有 `allow-always`，因此「允许」永远只覆盖当次调用。
- **竞态**：桌面 GUI 与手机可能同时弹同一请求（都是 `approval/request` 应答者）。规则：谁先返回谁生效，另一方迟到结果被丢弃（DSH 已实现「迟到回答丢弃」）。产品层必须给用户解释（§10 决策 3）。

### 6.4 审计记录字段

本机 `.dsh/remote-bridge/audit.jsonl`（append-only，0600，单文件 10 MB 轮转）：

| 字段 | 类型 | 语义 |
|---|---|---|
| `auditId` | string | 本行唯一 id |
| `approvalId` / `callId` | string / string? | 关联键 |
| `sessionId` / `toolName` | string | 所属会话与工具名 |
| `reason` | string? | 本机给出的原因 |
| `requestedAt` / `decidedAt` | string | 请求与决定时刻 |
| `latencyMs` | number | 人工响应耗时 |
| `decision` | string | `allow` / `deny` / `timeout` / `disconnected` |
| `deviceId` | string | 哪台手机（本机分配，非手机自报） |
| `channelId` | string | 频道（全量吊销后仍可回溯） |
| `relayConnId` | string? | 中继侧连接标识（**不记录 IP**，中继后也拿不到真实 IP） |

同时 DSH 自身会在会话日志写 `approval/asked` 与 `approval/decided`（已验证），两处互为交叉证据。
## 7. 局域网直连 vs 公网中继

| 维度 | 公网中继 + E2E（推荐） | 局域网直连 |
|---|---|---|
| 额外延迟 | 多一跳（同区域通常 +20–60 ms） | 最低（同网段 <5 ms） |
| 可用性 | 在家/在外都可用（4G/5G/Wi-Fi） | 只在同一网段，换网即断 |
| 隐私 | 中继见元数据、不见明文 | 无第三方，最私密 |
| 部署成本 | 需域名 + 中继服务 + 证书 | 零成本（复用本机） |
| NAT/防火墙 | 无要求（出站即可） | 需同网段或端口转发；手机常限制入站 |
| 攻击面 | 中继被攻破仍安全（E2E），DoS 面在外 | 本机需监听非回环地址（**违背 A1**） |
| 密钥管理 | 一套（配对 secret） | 同一套（可复用） |
| 建议 | **一期主线** | 二期可选「加速通道」，默认关闭 |

**推荐**：一期只做公网中继 + E2E；局域网直连作为可选加速，实现上用 `registerUpgrade` 加独立路径，且必须默认关闭、仅绑内网地址、仍走同一 E2E 密钥、连接数上限 2。
## 8. 失败与重连

| 场景 | 策略 | 参数 |
|---|---|---|
| 中继断线 | 指数退避 + 抖动重连，稳定 30s 后重置 | base 1s，×2，jitter ±20%，上限 **60s** |
| 应用层心跳 | 手机每 25s `ping`、本机回 `pong`，连续 3 次缺失（75s）判死链；中继侧另 ping 20s（仅探活，不承载业务） | 75s 触发重连 |
| 会话增量缺口 | 发现 `seq` 空洞 → `resume(fromSeq=lastSeq)` 重拉，不回放全量 | 单次最多补 500 条 |
| 密钥失效 | 解密失败先试上一把 key（宽限 10 分钟）；仍失败则停发 + 提示「配对已失效」 | **禁止**任何明文降级 |

**离线队列（手机侧 outbox）**：

| 类别 | 上限 | 满时策略 | 说明 |
|---|---|---|---|
| 审批类（`ApprovalDecision`） | 20 | **永不丢弃**；满则阻止新操作并告警 | 丢了会让本机挂到超时（最终仍拒绝，但用户以为已批准） |
| 消息类（`SendPrompt`/`QuickAction`） | 20 条 / 1 MB | 丢**最旧**并提示 | 可重发，`requestId` 去重保证不重复执行 |
| 事件类（`SessionEvent`） | 不排队 | 重连后按 `seq` 重拉 | 事件无「补发」语义 |

**降级路径**：中继不可达 → 退避重连，UI 显示「离线（N 条待发）」；超过 10 分钟仍失败 → 提示改用「局域网直连（若已开启）」或回本机操作，**不自动切换到明文/HTTP**。
## 9. 里程碑拆分

### M1 只读会话列表 + 发消息（范围：配对、出站 WSS、E2E、`ListSessions`、`SendPrompt`、`SessionEvent` 投影、重连去重）

| # | 验收判据（可测） |
|---|---|
| 1 | 手机冷启动到看见列表 ≤3s（局域网中继）/≤6s（公网），列表 ≤50 条 |
| 2 | 发送 prompt 后本机会话 ≤2s 内出现该用户消息，文本逐字一致 |
| 3 | 断网 30s 再恢复：待发消息自动补发，本机只出现 **1** 条（`requestId` 去重生效） |
| 4 | 中继侧抓包（tcpdump/pcap）检索 prompt 明文片段：命中 **0** 次 |
| 5 | 未配对设备连同一 channel：被拒（无有效密文帧 + 本机日志 1 条拒绝记录） |
| 6 | 篡改任一帧 `seq` 或 `ts`：本机丢弃并计数，链路不崩 |

### M2 审批卡片（范围：`approval/request` 应答者、审批两消息、超时拒绝、幂等、审计）

| # | 验收判据（可测） |
|---|---|
| 1 | 触发一次需审批工具调用（如工作区外 `write`）：手机 ≤5s 弹卡，含 `toolName` 与 `reason` |
| 2 | 点「拒绝」：本机调用以拒绝结束，会话日志出现 `approval/decided` 且 `outcome=rejected` |
| 3 | 不作操作 120s：自动以 `rejected` 结算，审计 `decision=timeout` |
| 4 | 同一卡片连点 5 次「允许」：`approval/decided` 只 1 条，工具只执行 1 次 |
| 5 | 审批期间手机断网：本机 ≤5s 内以 `rejected` 结算（不挂到超时） |
| 6 | 每次审批完成后 `audit.jsonl` 恰好新增 1 行且字段完整（§6.4） |

### M3 快捷指令（范围：`QuickAction` 白名单 `session.cancel`/`session.create`/`prompt.continue`）

| # | 验收判据（可测） |
|---|---|
| 1 | 3 个内置动作成功率 100%（各 20 次重复） |
| 2 | 白名单外 `action`：本机返回 `E_NOT_ALLOWED`，无任何副作用 |
| 3 | 每个动作执行均写审计（含 `action` 与 `requestId`） |
| 4 | `session.cancel` 后当前轮次停止，且待处理 inbox 不被丢弃 |

## 10. 待用户确认的决策点

| # | 决策点 | 选项 | 影响 |
|---|---|---|---|
| 1 | **中继由谁部署** | (a) 自建 VPS（Caddy/Nginx + 小 Node 服务）(b) Cloudflare Workers/DO (c) 第三方长连接 SaaS | 决定运维成本、可用性 SLA、元数据归属 |
| 2 | **手机是否具备「驱动 agent」能力** | (a) 允许（发消息=本人下指令）(b) 仅只读+审批 (c) 允许但限工具白名单 | 决定 N6 与 §6.1 边界；选 (a) 风险最高 |
| 3 | **审批应答者冲突策略** | (a) 先到先得（DSH 默认）(b) 桌面在线时手机只读 (c) 桌面 30s 无响应才轮到手机 | 决定是否需要「桌面独占」开关与提示文案 |
| 4 | **审批卡片是否必须显示工具参数** | (a) 一期只显示 toolName+reason (b) 等上游加字段 (c) 桥侧旁路反查（未验证） | 决定 M2 能否满足「看清再批」 |
| 5 | **手机端密钥存储介质** | (a) 沿用 `preferences`（明文）(b) HUKS/asset 加密存储 | App 现无 HUKS/asset（已 grep 确认），(b) 需验证 ArkUI-X Android 侧可用性 |
| 6 | **手机侧 WebSocket 能力** | (a) `@ohos.net.webSocket`（现完全未用）(b) Web 组件内跑 WS (c) 退化长轮询 | 决定 M1 工期；选 (c) 则延迟与耗电明显变差 |
| 7 | **是否复用 `dsh-experimental-liveshare`** | (a) 不复用，自建桥 (b) 先用 liveshare 顶一期 | liveshare 是实验特性，且给 viewer 发的是 owner 渲染的页面（中继可见页面内容，**是否 E2E 未验证**），可能与 A5 冲突 |
| 8 | **公网中继的数据留存** | 元数据留存时长、是否记会话标题、是否记包长序列 | 决定隐私声明与合规口径 |

## 附录 A：证据文件清单（全部只读）

| 路径 | 读到了什么 |
|---|---|
| `dsh-sync-suite/docs/ARCHITECTURE.md`、`CONTRACT.md`、`DATA-CONTRACT.md` | 单写者/密钥不出设备/fail-closed 约定；插件 RPC 契约与 `inject:['webServer','connection']`；`devices/<id>/` 与 JSONL 契约；DSH 版本 0.2.2-rc.3 |
| `packages/dsh-dots/README.md`、`src/index.ts`、`src/rpc.ts` | 仅注册一条 exact 路由 `/dsh-dots/rpc`，handler 首行 `ctx.connection.requestRejection(req)`；串行队列、10 MB body 上限、`E_CONFIRM_REQUIRED` 门禁、401/403 处理 |
| `apps/arkui-schedule/entry/src/main/ets/services/GitSyncService.ets` | App 网络风格：Web 组件 + `@ohos.net.http`（connect 15s/read 45s）+ base64 桥；**无 WS** |
| `apps/arkui-schedule/entry/src/main/ets/services/settingsStore.ets` | 配置存 `preferences`（全字符串），token/AI key 明文存本机 |
| `…\resources\app.asar`（归档，非目录）内 `@deepseek-ai/dsh-api-gateway/src/stream-protocol.ts` | `REMOTE_STREAM_MUX_PATH='/api/remote.mux'`、`$events`/`$events/result`、帧 `open/item/end/cancel` 与 `item/error/end` |
| 同上 `dsh-client-connection/src/api-path.ts`、`connect-protocol.ts`、`rpc-host.ts`、`browser-auth.ts` | `API_PATH='/api'`、`CONNECT_PATH='/connect'`、启动令牌换 API operator、fence→403 / 无令牌→401、`admit()` 把浏览器请求当 `browserPeer` |
| 同上 `dsh-api-session-controller/src/index.ts` | `session/list|prompt|cancel|create|events|follow|observeEvent|state|wait|control` 等端点真实存在及其签名 |
| 同上 `dsh-api-remotes/src/remote-events.ts` | `{event:'approval/request', mode:'waterfall'}` 是唯一转发给客户端的交互事件 |
| 同上 `dsh-user-approval/src/types.ts` | `ApprovalRequestEvent` 字段（无工具参数）、`ApprovalOutcome` 四值、`approval/asked|decided` 审计形状 |
| 同上 `dsh-client-ui-approval/src/client/index.ts` | 桌面端就是 `ctx.remote.$on('approval/request', …)` 的应答者 |
| 同上 `dsh-api-remote-access/README.zh.md` | 非 owner 只能用 policy 放行的 action；审批瀑布仅 owner 可作答 |
| 同上 `dsh-host-webserver/src/index.ts` | `kind:'exact'|'prefix'` 路由 + `registerUpgrade()`（exact path WS）+ `isLoopbackHost()` |
| 同上 `dsh-experimental-liveshare/README.zh.md` | 已有「relay + viewer + share-viewer 只读沙箱」先例（是否 E2E **未验证**） |

### 未验证项（如实标注）

1. 上述 DSH 包**只是静态阅读**：本设计未运行任何 `/api`、`/api/remote.mux`、`approval/request` 实测。
2. `dsh/` 在磁盘上**不是目录**：`…\resources\app.asar\dsh\` 不存在，代码在 `app.asar` 归档内（用 Node 只读解析头部与文件字节，未解包、未写回）。
3. 手机端 WS / HUKS / 扫码能力：App 现有代码 **grep 不到** `webSocket`、`huks`、`@ohos.security.asset`、`scanBarcode`、`camera`。
4. `seq` 是否在 `session/follow` 之外处处连续、桥侧能否稳定取得 `callId` 对应参数：M1/M2 实现时确认。
5. 中继的真实延迟与可用性、`2^32` 帧上限在真实使用中的到达时间：未测。
