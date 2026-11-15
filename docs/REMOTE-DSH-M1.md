# DSH 远控 M1 骨架评估（只读会话列表 + 发消息）

> 状态：**只读评估 + M1 骨架建议；本轮未写任何 WebSocket / 加密 / 扫码代码**。
> 上游设计：`docs/REMOTE-DSH.md`（v0.1，398 行，本次只读）。
> 本机基线：DSH `0.2.2-rc.3`，安装在 `…\DeepSeek Harness\resources\app.asar`（209 MB 归档，非目录）。
> 证据约定：**已验证**=本次独立复核；**沿用**=引自 REMOTE-DSH 且本次未复核；**未验证**=本机无法证明。

## 0. 结论：值得做，但只作为 M1 骨架/试验，不进 1.0 发布路径

1. **需求面窄、语义已存在**：列表 = DSH `session/list`，发消息 = `session/prompt`，增量 = `session/follow` /
   `observeEvent`；桥在进程内调 `ctx.sessionController` 即可，不需要逆向或伪造 `/api` 协议。
2. **三个硬卡点已验证，其中两个 M1 能绕开**：`/api` 是 **owner 级**鉴权（给手机等于交出全权，**不可复用**）；
   审批事件 `approval/request` **不含工具参数**（阻断的是 M2 的「看清再批」，M1 不碰审批即可）；
   剩下全是工程成本（自建中继 + E2E + App 平台能力），不是设计死结。
3. **成本集中在 App 侧三项未验证能力**（WebSocket / 扫码 / 密钥存储，见 §3）+ 一个必须自建的中继；
   ArkUI-X **Android 侧**可行性无任何证据 → 先做 spike 再排期，不要直接承诺 M1 上线。

## 1. 复用哪些 DSH 现有 remote 接口（复用语义，不复用鉴权）

| 能力 | 现有接口 / 机制 | M1 复用方式 | 证据 |
|---|---|---|---|
| 会话列表 | `session/list`（`dsh-api-session-controller`） | 桥内取 `sessionController.list()`，只投影 `sessionId/title/lastActivityAt/busy` | **已验证**（asar 字符串 74 处）+ 沿用 REMOTE-DSH §3.4 |
| 发消息 | `session/prompt`（支持 `clientTimeZone`） | 桥内调 prompt，`requestId` 作幂等键 | **已验证**（97 处） |
| 增量事件 | `session/follow` / `observeEvent` | 白名单缩减成 `kind/text/tool/ts`，**不转发工具参数** | 沿用 REMOTE-DSH §5.2 |
| 一元 RPC 形状 | `POST /api`（`API_PATH='/api'`） | 只借「请求/响应 + rpcId」形状，**不借通道与鉴权** | **已验证**（`/api/remote.mux` 19 处） |
| 多路复用流形状 | `WS /api/remote.mux`（open/item/end/cancel） | 只借帧语义；桥用自己的 WS 路径 | **已验证**（19 处） |
| 审批（M2 才用） | `approval/request` waterfall | M1 不订阅；M2 需另解「无工具参数」 | **已验证**（49 处；`gateway/interactions-forbidden` 22 处） |
| 路由扩展 | `ctx.webServer.registerUpgrade({kind:'exact', path})` | 桥自己的 WS 入口（局域网直连可选，默认关） | **已验证**（16 处） |

> 独立复核方式：对 `app.asar` 做只读字节检索（不解析、不解包），命中次数如上。
> 结论与 REMOTE-DSH §3.4 一致：**DSH 的接口语义可复用，DSH 的 owner 鉴权不可复用**。

## 2. 缺什么（全部新增在插件侧，App 侧不碰 `/api`）

1. `dsh-remote-bridge` 插件：Cordis 服务，`inject: ['webServer']` 并取 `ctx.sessionController`；
   向中继发起**出站** WSS；**不给手机开任何入站 `/api` 路由**。
2. 配对与密钥：本机生成 `channelId`（128 bit）/`secret`（256 bit），GUI 展示二维码或纯文本配对码；
   配对表 0600，支持单台/全量吊销。
3. E2E 加密与重放防护：AES-256-GCM + HKDF 双向子密钥 + `seq` 滑动窗口（REMOTE-DSH §3.2）。
   **M1 不可裁剪**，否则中继可见明文。
4. 幂等表（`requestId`/`callId`，10 分钟窗口）+ 本机 append-only 审计 `audit.jsonl`。
5. App 侧客户端：连接管理、加解密、列表与发送 UI（建议新页面，不动 `Index/Edit/Detail`）。
6. **对外新增的数据契约只有 3 条**：`ListSessions` / `SendPrompt` / `SessionEvent`
   （字段沿用 REMOTE-DSH §5.1–5.3，**不新增格式**）。

## 3. App 侧需要的平台能力与 ArkUI-X Android 可行性风险

| 能力 | 本仓库现状（已验证） | M1 建议 | 风险 |
|---|---|---|---|
| WebSocket | 全仓 grep 不到 `webSocket`（无用法）；已有隐藏 `Web` 组件 + JS 桥先例（`GitSyncService` + `rawfile/git`） | ①`@ohos.net.webSocket`（ArkUI-X Android 是否实现**未验证**）；②退回「隐藏 Web 里跑 JS WS」（复用现有桥模式） | 中高：方案 ① 可能 Android 侧不可用 |
| 扫码配对 | grep 不到 `scanBarcode`/`@kit.Scan`/`camera`；`module.json5` 仅有 INTERNET + PUBLISH_AGENT_REMINDER，**无 CAMERA** | **M1 不做扫码**：手动输入 / 粘贴 `dshremote://pair?...` 配对码，零新权限（secret 放 fragment，不进日志） | 低（选替代方案时）；若必须扫码则中高（Android 需相机权限 + 原生扫码库） |
| 密钥存储 | `settingsStore` 用 `preferences`（明文）；grep 不到 `huks`/`security.asset` | 沿用 preferences + 30 天轮换 + 一键吊销，并在隐私说明标注残余风险；HUKS/asset 作为 M2 前的 spike | 中：手机被 root/备份导出即泄露 |
| 后台保活 | App 无长时任务/常驻服务 | M1 定「**前台连接**」：退后台断链，回前台按 `seq` 补拉；REMOTE-DSH §8 的离线队列在 M1 裁剪为只补事件 | 中：体验上「切出去就收不到」 |
| 中继 | 本仓库无服务端代码 | 需自建（见 §6 决策 1）；**中继不可信**，只做信道 | 高：运维/证书/成本 |

## 4. M1 最小验收（可测，从 REMOTE-DSH §9 裁剪）

1. 冷启动 ≤6 s 看到 ≤50 条会话（标题 / 最近活动 / 是否可续聊）。
2. 发送后本机会话 ≤2 s 出现该用户消息，文本逐字一致。
3. 断网 30 s 恢复：待发消息补发，本机只出现 **1** 条（`requestId` 去重）。
4. 中继侧抓包检索 prompt 明文片段：**0** 次命中。
5. 未配对设备连同一 channel：被拒 + 本机 1 条审计记录。
6. 篡改任一帧 `seq`/`ts`：丢弃并计数，链路不崩。

## 5. M1 明确不做（边界）

- 不接审批（M2）、不做快捷指令（M3）、不做文件面/插件管理/终端（REMOTE-DSH §1.2）。
- 不复用 DSH `/api` 鉴权、不给手机 owner 权限、不为手机开公网入站端口。
- 本轮不写 WS / 加密 / 扫码代码，也不改 `Index/Edit/Detail`。

## 6. 需要拍板（不做决定则 M1 无法开工）

1. 中继由谁部署：自建 VPS / Serverless / 第三方长连接服务（决定运维成本与元数据归属）。
2. 是否接受「M1 无扫码，手动输入配对码」——本评估推荐接受。
3. 是否接受 M1 密钥先用 preferences 明文（配轮换 + 吊销），还是必须先做 HUKS/asset spike。
4. 是否先只交付「插件侧桥 + Node 冒烟测试」（本仓库可验证），App 端等 Android 平台能力 spike 结论。

## 7. 与 REMOTE-DSH 的差异

- 本文件只做 M1 收敛：**去掉扫码与审批**，把「平台能力未验证」显式列为阻断项；
  其余协议、密钥、审计设计沿用 `docs/REMOTE-DSH.md`，不重复展开。
- REMOTE-DSH §10 的 8 个决策点，M1 只需先答 §6 的 4 个。
