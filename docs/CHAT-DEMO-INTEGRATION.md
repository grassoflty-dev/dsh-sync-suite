# Chat Demo 外壳集成（v1 计划，未实现）

> **状态：计划，不是实现。** 本文不授权构建、不改代码、不动 `packages/dsh-dots/dist`，ArkTS 构建由另一条 lane 持有。
> 既有可行性结论（不再重推）：选 **(a) 把 `deepseek-ai/chat-demo` 的 `dist/` + `LICENSE` vendor 进 rawfile，用 JS 桥对象驱动**；不选 (b) 用 ArkUI 重写 UI，因为那要重新实现 Markdown / KaTeX / Mermaid / 分支 / 流式，工作量与风险都更高（`docs/HANDOFF-2026-11-28.md:115-123`）。
> 路径相对仓库根 `dsh-sync-suite/`；`path:N` 是行号。`unverified` = 当前树里找不到证据，文中同时给出需要什么才能证实。

## 1. 目标与边界

目标：让平板 chat 页的**两个分段**获得 demo 的视觉与完成度；不只是 cloud，dots 也换皮（`docs/HANDOFF-2026-11-28.md:117`）。两个分段不是两个数据源，而是**同一份已发布仓库索引按会话 preset 过滤**出的两个视图（计划，见 §2、§3.2）。dots 还要**额外**露出三个能力面：**调整日程、调整本平板定时任务、远程控制访问远程 DSH**（任务按设备独立，见 §3.4）。

会话现在分三种，不是两种：

| kind | 谁创建 | preset | 数据 | 能力 |
| --- | --- | --- | --- | --- |
| **work** | DSH 自己的 UI | `standard`（`null` / 缺省 / 未知同样归这里） | **只在本机，永不发布** | DSH 既有工具 |
| **chat** | 我们的入口 | `chat` | 与日程一样**静默发布到 Git 仓库**（自动导出，无用户导出动作） | 纯对话 |
| **dots** | 我们的入口 | `dots` | 与 chat 一样发布（仅会话，任务不发布） | 纯对话 **＋** 调整日程 / 调整本平板定时任务 / 通过远程控制访问远程 DSH |

依据：work / chat 的判定与「只有 `agentPreset === 'chat'` 才导出」见 `docs/HANDOFF-2026-11-28.md:16,43-46,106`、`packages/dsh-dots/src/chats/index.ts:297-303`、`apps/arkui-schedule/entry/src/main/ets/model/chatList.ts:39-47`、`apps/arkui-schedule/entry/src/main/ets/services/chatStore.ets:219-225`。dots 的三种能力来自用户定稿，不是今天的代码事实；树里现有的 dots 定义仍是「对话界面 + 列实例 / 看状态 / 发命令」的设计稿（`docs/CLOUD-CHAT-AND-DOTS.md:8-30`）。用户要求 dots 页面做成 DeepSeek demo app 那样的观感——这是 UI 方向，不是新增功能。

**树与产品模型的偏差（先写清，后面不再重述）**：今天 `ChatSessionPreset` 只有 `'chat' | 'other'`（`model/chatList.ts:47,526-528`），导出白名单只认 `'chat'`（`packages/dsh-dots/src/chats/index.ts:299-300`），`listChats()` 也只保留 `'chat'`（`services/chatStore.ets:219-225`）；`dots` preset **在代码里不存在**，dots 段目前按索引 `kind` 过滤（`model/chatList.ts:504-514`、`pages/panes/DotsPane.ets:177`）。本计划的「按 `agentPreset === 'dots'` 过滤」是**待实现改动**，本文不实现（§8.1）。

分工只有一条硬线：**外壳（vendored demo）只负责「呈现一段会话 + 一个编辑框」**（`docs/HANDOFF-2026-11-28.md:121,123`），外加**显示** ArkUI 给它的能力入口并回调；能力入口的实现永远留在 ArkUI，绝不迁进外壳。

| 归属 | 负责 | 证据 |
| --- | --- | --- |
| demo 外壳 | 消息列表排版、Markdown / 代码 / KaTeX / Mermaid、分支视图、明暗主题、移动端布局、编辑框；显示 ArkUI 传入的带标签入口并回调 | `docs/HANDOFF-2026-11-28.md:121,127-134` |
| ArkUI | 数据源与只读语义；preset 准入；逐行隐藏/删除写通道与四条失败文案；列表头 / 筛选 / 搜索；「待创建」条；桥对象与 rawfile 打包；三个能力入口的组件与路由 | `docs/HANDOFF-2026-11-28.md:144-146`；`pages/Chats.ets:234-242,281-298,614-664` |
| ArkUI（能力） | 日程、**平板本地**定时任务、远程控制的全部状态与动作；按实例的授权表 | `pages/panes/SchedulePane.ets:1-2,1371,1384`；`pages/RemoteControl.ets:1-2`；`services/instanceGrantStore.ets:35-36,67-167` |

**明确写出**：日程、平板本地定时任务、远程控制（以及今天仍在 ArkUI 的授权行）的能力逻辑**永不移入外壳**。外壳里出现这三个词只能是一个可点标签 + 一次委托回调；不得有 WebView 地址、token、RPC、grant/revoke、日程或定时任务写入，也不得有这些能力的本地状态。

## 2. 一个外壳的决策，以及判错的代价

**结论：一个 vendored demo bundle、一个桥、两个 segment 模式（`segment: 'chat' | 'dots'`，由会话 preset 选择）；不做两个外壳。** 两段读的是同一份已发布仓库索引，只按 preset 过滤，不是两套抓取逻辑。

证据链：

- `Chats.ets` 两段共用一次 `chatStore.listChats()`（`:147`），切换只调 `applyQuery()` → `filterChats(filterByKind(this.chats, this.kind), this.queryText)`（`:171-174`），不重读磁盘（`:14-16`）。
- `CloudChatPane` 与 `DotsPane` 也读同一个 `chatStore.listChats()`（各自 `:78` / `:170`），只是常量 `PANE_KIND` 分别为 `'cloud'` / `'dots'`（`pages/panes/CloudChatPane.ets:31-32`、`pages/panes/DotsPane.ets:43-44`），然后 `sortChats(filterByKind(...), 'updated')`（各自 `:85` / `:177`）。今天是 `kind` 分段；计划改成 preset 分段（§1 的偏差段）。
- `chatStore` 的唯一读源是同步仓库工作副本 `<filesDir>/git-repo/chats/index.jsonl`（`services/chatStore.ets:1-10,198-226`），消息来自 `chats/<id>/session.jsonl`（`:239-285`）。仓库布局是**跨设备共享的 `chats/` 命名空间，不是 `devices/<id>/`**（`docs/CHAT-SYNC.md:53-66`）。
- preset 身份只能从 `chats/<id>/session.jsonl` 投影：`sessionPresetOf` 读 header 与 `agent-preset/selected` 事件（`model/chatList.ts:530-568`），`filterChatPreset` 做 allow-list（`:574-592`），写口再守一次（`services/chatStore.ets:332-335`）。不从标题、工作区、`index.kind` 猜（`:45`）。

**dots 的数据来源问题已经关闭，不再作为待办**：dots 段就是同一份已发布仓库索引按 `agentPreset === 'dots'` 过滤（计划，§3.2）。**v1 不需要接远程 `sessionList` RPC**；全仓 `.ets` 对 `sessionList` 零命中，`sessionList` 只存在于插件侧（`packages/dsh-dots/src/rpc.ts:1029,1232-1236,1364-1365`、投影 `packages/dsh-dots/src/remote/projection.ts:15,169,178`），不是 App 的数据源。今天零命中是既定事实，不再是缺口；本文不再讨论接线方案。

**为什么一个外壳更便宜**：

1. 一份渲染栈 = 一份 Markdown / KaTeX / Mermaid / 分支实现；两个外壳要维护两份改动与两次升级。
2. 一份桥契约 = 一份消息形状 / 错误形状 / 委托回调表；两个外壳会有两个版本的「同一件事」。
3. 选择态、待确认态只有一份。逐行删除在 ArkUI 里刻意只有一个 `pendingId` 字符串、没有批量 API（`pages/Chats.ets:95-105,234-242`）。
4. 能力入口只声明一次。授权行是只读、fail-closed 的（`pages/panes/DotsPane.ets:99-134`），重复到第二份 shell 就会出现「这里显示已授权、那里显示未授权」。
5. 准入判据只有一个：`sessionPresetOf(...)` + `filterChatPreset`（`model/chatList.ts:526-592`；写口 `services/chatStore.ets:332-335`）。两套 shell 最容易把这段判定复制到 JS 里，直接制造第二个真相源。

**若判断错误的代价（必须诚实）**：这里的假设是「两个 segment 的消息动作与数据形状足够一致，一份桥 + 一份渲染栈就够」。如果假设错了——典型情形是 dots 需要成套的消息内动作（命令卡、实例 / grant 状态、工具状态行），而 chat 始终是纯文本分支（`docs/CLOUD-CHAT-AND-DOTS.md:75-80` 已给过 dots 事件里的 `dots/command` / `dots/result` / `tool/call` 形状）——同一座桥会开始按 `segment` 加 `if` / `switch`：一个分支带 `instanceId`、`grantState`、确认动作，另一个没有。桥就退化成「一个文件里的两个适配器」：消息形状表和错误表各两套，测试矩阵翻倍，上游 demo 每次升级都要对两段分别回归，「改一处必须同步改另一处」成为常态，§2 里「一份契约」的全部省钱理由都会消失。**回退路径**：仍保留一个 shell，把桥后面的 ArkUI 适配器拆成两个（chat 适配器 + dots 适配器），桥只做公共 JSON 封装；只有连渲染也分叉时才 vendor 第二个 bundle，并接受体积与重装成本（§6）。**observable symptom（可观测的判错信号）**：桥/外壳里出现按 segment 分叉的分支，且两个分支不再只是「显示多一行」，而是携带不同的消息 action 集合或不同 JSON 字段集（例如 dots 需要确认/拒绝语义而 chat 没有）；或者同一份 `toMessages` 输出被要求按段做不同写回。出现这个信号就要停下来重估，而不是继续往桥里堆分支。

**`unverified`**：上游 demo 是否本来就为两种场景产出两份 `dist/`（从而一个 bundle 不够）。证明方式：固定上游 commit，枚举其构建产物，确认只有一个入口 `dist/index.html` 且不存在按 segment 分叉的 bundle（`docs/HANDOFF-2026-11-28.md:117,141` 的记录指向单一入口）。

## 3. 桥按段暴露什么（含能力入口与两项配套计划）

两个 segment 都通过同一个 shell 渲染；数据来自桥，由 ArkUI 按 preset 过滤后交给它：`chat` → cloud 段，`dots` → dots 段（计划；今天是 `kind` 过滤，见 §1）。**桥保持只读**；逐行隐藏/删除入口、列表头、筛选/搜索、空态与错误态一律留在 ArkUI，外壳不渲染第二套。所有「来源」列都是 ArkUI 侧既有事实；外壳只拿渲染所需的 JSON，不自行判据、不写回。

### 3.1 cloud 段（`segment='chat'`）

| 数据 / 动作 | 来源（path:line） | 读/写 | 外壳权限 |
| --- | --- | --- | --- |
| 会话列表（列表头之外） | `services/chatStore.ets:198-226`（`chats/index.jsonl`，当前只返回 `chat` preset）、`model/chatList.ts:338-424`（折叠/解析）、`:574-592`（chat preset 准入）、`:498-514`（今天的 `kind` 分段） | 只读 | 渲染切换，不重读磁盘、不缓存第二份列表 |
| 消息 + 分支 | `services/chatStore.ets:239-285`（`chats/<id>/meta.json` + `session.jsonl`）、`model/chatList.ts:596-682`（`toMessages`） | 只读 | 渲染已导出的文本；分支只是事件关系的展示 |
| 逐行隐藏/删除入口 | `pages/Chats.ets:234-242`（`askHide(id)` 单 id）、`:438-451`（行按钮）、`:614-664`（确认 sheet）、`:743-750`（bindSheet）；写口 `services/chatStore.ets:326-384`、`model/chatHide.ts:59-97` | ArkUI 唯一写 | 只能显示一个带标签的「删除」入口并回调 ArkUI；不得自己写索引、不得合并/批量 |
| 四条失败文案 | `model/chatHide.ts:99-106`（`prepare/write/commit/push` 四句 typed 文案）；当前渲染为一条 `hideHint` 文本 + toast：`pages/Chats.ets:678-685,268-271` | ArkUI 唯一来源 | 原样显示 ArkUI 给的字符串；不得自己拼、不得翻译成第二套 |
| 列表头 / 筛选 / 搜索 / 计数 / 空态 | `pages/Chats.ets:281-298,307-382`；外壳面板的头在 `pages/panes/CloudChatPane.ets:224-237` | ArkUI | 不接管；外壳不渲染第二套头/筛选/空态 |
| 只读约束与「在电脑上继续」 | `pages/ChatDetail.ets:5-10,162-168`；`docs/CHAT-SYNC.md:8-13` | 只读 | 可显示只读提示与委托按钮，但写入仍发生在桌面端 |

### 3.2 dots 段（`segment='dots'`）

**目标语义**：dots 段 = 与 cloud **同一份** `chats/index.jsonl`，按 `agentPreset === 'dots'` 过滤；不是远程 RPC `sessionList`。今天代码仍用 `PANE_KIND = 'dots'` 做 `filterByKind`（`pages/panes/DotsPane.ets:43-44,165-183`；旧页面 `pages/Chats.ets:147,171-174` 同构），而 `listChats()` 当前只允许 `chat` preset（`services/chatStore.ets:219-225`）。把这两处改成 dots preset 准入是后续实现工作，本文不实现。

| 数据 / 动作 | 来源（path:line） | 读/写 | 外壳权限 |
| --- | --- | --- | --- |
| dots 会话列表 | `pages/panes/DotsPane.ets:170,177`；源同 `services/chatStore.ets:198-226` | 只读 | 渲染；从桥拿已按 preset 过滤的 dots 结果 |
| dots 会话详情 | `pages/ChatDetail.ets:123-143`（通用只读详情，仅传 id）；`services/chatStore.ets:239-285` | 只读 | 渲染，不上传、不发送 |
| 只读授权行 | `pages/panes/DotsPane.ets:99-134,344-350`；`services/instanceGrantStore.ets:106-116,155-163` | 只读；fail-closed | 只显示 ArkUI 给的字符串；不得读 grant store、不得 grant/revoke |
| 发指令禁用行及拒绝原因 | `pages/panes/DotsPane.ets:137-163,326-333`；文案来自 `model/remoteCommandDraft.ts:151,164-173` 与冻结闸 `model/remoteCommandGate.ts:43`（`COMMAND_WORDING`） | 只读 | 只显示禁用入口 + 原因；不得变成可发送的输入框 |

**v1 不接远程 `sessionList` feed**：见 §2；这不是桥的一行，也不是未来的桥适配计划。

### 3.3 三个能力入口：外壳只回调，永远不实现

机制：ArkUI 把「标签 + 回调委托」注入外壳；外壳只渲染标签并调用**一个具名桥回调**。本文提议的精确名字与签名（**提案，今天桥里不存在**，见 §8 的 `unverified`）：

```ts
type CapabilityKind = 'schedule' | 'scheduledTask' | 'remoteControl';

interface CapabilityAck {
  kind: CapabilityKind;
  state: 'opened' | 'cancelled' | 'unsupported' | 'error';
  reason?: string; // 只来自 ArkUI 的中文原因；外壳原样显示，不拼、不翻译
}

openCapability(kind: CapabilityKind): Promise<CapabilityAck>;
```

规则：

- 外壳只有一个 `openCapability` 声明与一个三选一的标签表；`kind` 是固定枚举，不接受字符串外的自由值，未知值按 `unsupported` 处理。
- **外壳永远拿不到能力的数据**：ack 只有 `kind` / `state` / 可选 `reason`，没有日程记录、任务列表、rrule、实例表、token、URL、grant 行或写句柄。用户去到哪里由 ArkUI 决定，外壳只知道「去了 / 取消 / 不支持 / 出错」。
- ArkUI 没有入口或能力不可用时返回 `state: 'unsupported'` + 中文 `reason`；外壳把它渲染成**灰显、不可点的禁用入口 + 原文原因**，不再发第二次回调、不缓存状态、不自行造一个假页面。若产品要求入口完全不出现，也由 ArkUI 在注入标签时不给，外壳不自行判断「有没有这个能力」。
- `openCapability` 的实现体属于 ArkUI 侧桥，不是 demo 自己实现。今天 rawfile 里已知的桥脚本是 `apps/arkui-schedule/entry/src/main/resources/rawfile/git/git-bridge.js`（`docs/HANDOFF-2026-11-28.md:28` 把它列为 rawfile 改动项）；demo 桥是否就是这个文件 `unverified`，需看到实际注入点才能证实。

| kind | 今天在 ArkUI 的位置 | 外壳能显示的入口 | 外壳禁止 |
| --- | --- | --- | --- |
| `schedule`（调整日程） | 日程面板 `pages/panes/SchedulePane.ets:1-2,26-28`（列表 + 「新建」按钮 `:1371,1384`）；导航轨 `components/shell/ShellRail.ets:68-73` | 一个 labelled affordance「日程」＋ `openCapability('schedule')`，由 ArkUI 打开既有面板 | 日程数据、勾选完成、新建表单、任何日程写入 |
| `scheduledTask`（调整本平板定时任务） | **今天没有专属 ArkUI 页面**：日程页明确不做定时（`pages/panes/SchedulePane.ets:51-54`、`pages/Index.ets:22-25`、`docs/FEATURE-BACKLOG.md:411-413,422`）；DSH 自己的定时任务在其调度器里、不在本仓（`docs/PLUGIN-GAPS.md:14`）。用户已明确选择**新增定时任务页面**，仍在计划中（§3.4） | 页面落地前 ArkUI 对 `openCapability('scheduledTask')` 返回 `unsupported`，外壳灰显；落地后才显示 labelled「定时任务」 | 任何本地定时器、任务读写、轮询、假任务页 |
| `remoteControl`（远程控制） | `pages/RemoteControl.ets:1-2`（内嵌 Web 打开电脑 DSH Web UI）、路由 `model/remoteUrl.ts:275-277`、导航轨 `components/shell/ShellRail.ets:75-80`、详情跳转 `pages/ChatDetail.ets:162-168` | 一个 labelled affordance「远程控制」＋ `openCapability('remoteControl')` | Web 组件、地址/token、配对/指纹、连接诊断 |

权限/授权不是第四个用户能力入口：今天那只是一条只读授权行（`pages/panes/DotsPane.ets:49-51,99-134,141-163`），留在 ArkUI，作为 dots 会话能否成立的**前置条件**在 §3.5 处理。

### 3.4 新增「定时任务」页面：范围（计划，未建）

用户已明确选择**新增定时任务页面**，不是塞进 `SchedulePane`，也不是外壳里的一页。本节只定范围，不实现。

**设备本地是硬规则**：定时任务每个设备独立，**不进仓库、不进 git、不做跨设备同步**；任务数据不经过 `chats/**` 或 `timeline/**`（会话与日程才走仓库）。所以计划里**没有任务同步模块**：没有东西可同步，就不会有这样一个模块。两种任务严格分域：

- **DSH 自己的定时任务**住在 DSH 自己的调度器里，桌面上可见；平板上可见只是因为**远程控制就是电脑 DSH 的那个网页**（`pages/RemoteControl.ets:1-5,26-29`、`docs/HANDOFF-2026-11-28.md:117`），平板本身不运行原生 DSH（`docs/PLUGIN-GAPS.md:43`）。本仓与插件不为它建任何东西。桌面 DSH 里那条 5 分钟巡逻也在那里——**这是边界，不是缺口**：它不在本仓、不在插件、不在本页列表里，只能通过远程控制看到。Host 的 `schedule_create` / `schedule_view` 定时任务工具注册在 app.asar、不在本仓（`docs/PLUGIN-GAPS.md:14`）；日程记录是另一个域（`timeline/<date>/records.json`，`packages/dsh-dots/src/schedule/tools.ts:159-161,218-220`、`pages/panes/SchedulePane.ets:59-62`）。
- **平板本地定时任务**属于 App，由这个新页面管理，只存在这台平板上、只在这台平板上可见。

**任务是什么**：一条任务 = 名称 + 重复规则 + 触发什么。触发面保持极窄：只在本平板 App 内显示一条本地提醒（带任务名），不发消息、不驱动桌面 agent、不调用工具或会话。本地提醒可用 `@ohos.notificationManager`（无需 AGC 开放能力），但只在 App 前台 / 刚回前台时可靠（`docs/FEATURE-BACKLOG.md:405-413`）。创建与编辑全部发生在 ArkUI，桥/外壳只读。

**平板绝不能创建或修改什么（安全红线）**：任何可用于在桌面执行任意命令的东西——`bash` / `pwsh` / shell 命令、`job_*`、`session.prompt`、远程 RPC 写动作、`grant*`、token / URL / 凭据字段、可挂 `tool-*` 插件的 preset 选择、以及任何会被桌面 agent 当成工具调用的自由 prompt；也不能给一条平板任务挂工具名、参数、文件或路径字段。一条平板本地任务只作用在本平板。依据：dots 明确不能执行 shell / 输出 token / 自行授权（`docs/CLOUD-CHAT-AND-DOTS.md:25-30`）；隔离判据是「不碰本机文件系统 / 不执行本机命令 / 不读本机环境」（`docs/CHAT-SYNC.md:302-309`）；Host 层全局工具任何 preset 都继承，只有 agent 作用域 `restrict` 能摘掉（`packages/dsh-dots/src/chatPreset/deny.ts:29-39`）；纯对话白名单只有两项（`packages/dsh-dots/src/chatPreset/allow.ts:30`）。**`unverified`**：用户所说「调整定时任务」是否包含修改既有任务的名称 / 重复规则；需产品与安全裁定窄白名单后再写页面规格。

**存在哪**：App 私有存储，不进 Git、不进导出。树里已有这类只存本机的机制：`@kit.ArkData` 的 `preferences`（`services/settingsStore.ets:4,10,504`）和 `PersistentStorage` 单键 JSON 信封（`services/instanceGrantStore.ets:4-8`），都明示「不进 Git / 不进导出」。本页用哪一个、键形状如何是计划决定；确切 API `unverified`，证实需看到新任务 store 的 `.ets` 文件及其落盘调用。

**到点时平板离线（计划决定，未实现）**：跳过这次触发，只记一个 missed-fire 标记供回前台时显示；不补跑、不通知风暴。App 本就不跑保证到点的后台定时器（`pages/Index.ets:22-25`、`docs/FEATURE-BACKLOG.md:411-413,422`），所以不承诺后台准时。

**卸载重装**：App 私有存储随卸载清除（平台行为，非本仓结论），因此**任务不跨重装存活**，除非另选一个耐久存放处。树里没有可证实的耐久存储，本文不发明一种；是否需要交由用户决定。

### 3.5 dots 的 preset 组合与 fail-closed

**规则：缺少必需 grant 的 `dots` 会话必须 fail closed**——拒绝成为 dots 会话 / 拒绝露出能力，而不是「悄悄建成一个没有能力的 dots 会话」。

树里存在的三种机制（各自能证明什么）：

1. **注册式 preset**：`ctx.agentPresets.register({id,label,description,plugins})` 只在 `docs/HANDOFF-2026-11-28.md:47` 被记载，指向 DSH Host 的 `preset-registry/src/index.ts:97`、`definition.ts:5-10`（本仓无该文件）；最小 preset = 空 `plugins`，只当标签、不改行为。全仓 `.ts` / `.ets` 没有 `agentPresets.register` 调用，也没有 `dots` preset id；本仓唯一的 preset 常量是 `CHAT_PRESET_ID = 'chat'`（`packages/dsh-dots/src/chatPreset/ids.ts:14-18`）。
2. **按实例授权表**：`services/instanceGrantStore.ets:35-36,67-167`，单个 `instance-grants.json` 键、无 token 字段、`redacted()` 是唯一渲染出口；dots 面板只读它（`pages/panes/DotsPane.ets:99-134`），view 权永不隐含 `session.prompt`（`:49-51,141-163`、`model/remoteCommandDraft.ts:164-175`）。它管的是**远程实例上的工具授权**，不是「这条会话是不是 dots」。
3. **插件的 chat 工具 deny**：`packages/dsh-dots/src/chatPreset/isolate.ts:21-31,370-421`，`deny = 已注册工具 − 白名单`，`restrict` 后再枚举可见集断言，多一个非白名单工具就抛 `E_CHAT_TOOLS_NOT_ISOLATED`；白名单只有 `ask_user_question` / `todo_write`（`chatPreset/allow.ts:30`）。它**目前故意没有接线**（`chatPreset/index.ts:2-8`），且只针对 chat，没有 dots 白名单。

**建议：三者都要，各管一段，不互相替代。**

- 用**注册式 preset 组合**建立 `dots` 身份：注册 `id: 'dots'`，`plugins` 只挂三个能力面确实需要的行；preset 是身份标记，不是权限证明。今天是缺口（`unverified`，见上）。
- 保留**按实例 grant 表**作为第二道闸：没有有效 grant 时 fail closed（拒绝会话成为 dots / 拒绝能力入口），不要在 UI 上表现成「一个没有能力的 dots 会话」。今天面板已经把空表 / 坏信封 fail-closed 到「未授权 / 未知」（`pages/panes/DotsPane.ets:99-134`），这是可复用的口径。
- 把现有 deny 安装器**参数化后复用到 dots**：传入 dots 专用白名单，保留 `restrict` 后的可见集断言（`packages/dsh-dots/src/chatPreset/isolate.ts:23-31,408-420`）；不能把 `CHAT_ALLOW_TOOLS` 直接套到 dots，也不需要手写静态 deny（`chatPreset/deny.ts:4-27` 已证明静态名单必然失败）。
- 理由：preset 只决定自己挂什么，Host 层全局工具任何 preset 都继承（`chatPreset/deny.ts:29-39`）；grant 表只约束远程实例工具（`services/instanceGrantStore.ets:1-16`），约束不了本机 `bash`；deny 能证明工具隔离，却回答不了「这是不是 dots 会话」「有没有实例授权」。缺任何一个都会出现「看起来是 dots、其实能力不对」的静默降级。

**`unverified`**：① 树里不存在已注册的 `dots` preset 与 dots 专用工具白名单——需看到 `ctx.agentPresets.register({id:'dots',...})` 调用、dots allow 常量与 dots 会话装配路径上的安装器调用才能证实；② 「缺少 grant」具体指哪一种 grant、在创会话时还是在调用能力时判定，现有材料没有定义——需要产品裁定后写进规格。

## 4. 必须从 vendored demo 里删除什么

上游 demo 源码**不在本仓**，所以下表是打包步骤的**硬性检查项**，依据 `docs/HANDOFF-2026-11-28.md:136,141`；具体文件清单 `unverified`，证明方式：固定上游 commit，枚举其 `dist/` 中对应模块（以及构建配置里的源引用）并逐项打勾。

| 删除 | 后果（为什么要删） |
| --- | --- |
| 所有直连 DeepSeek API 的 `services/api/*` 调用（`docs/HANDOFF-2026-11-28.md:136`） | 删完后 demo **不能和任何 API 说话**；保留一条就会绕过「桥是唯一入口」，并带回第二个真相源与网络出口 |
| API key 设置 UI 与 `localStorage` 里的 key（`docs/HANDOFF-2026-11-28.md:136`） | 没有 key 界面、WebView 存储里没有 key；否则在平板 WebView 中落明文凭据 |
| IndexedDB 持久化层（`docs/HANDOFF-2026-11-28.md:136`） | **不能本地持久化**：会话、分支、待发送全由桥提供，桥拒写；否则「demo 里的一条」和「仓库里的一条」会分叉 |
| 历史导入/导出 ZIP 的写盘路径（`docs/HANDOFF-2026-11-28.md:136`） | **不能写文件**；v1 只读展示。注意这不是本仓自己的 JSZip（那是附件按天打包，`docs/THIRD-PARTY.md:17-28`），两者不得混删 |

**MIT 许可义务（不可省）**：只 vendor 构建产物 `dist/` + 原始 `LICENSE`（含版权行），**不 vendor 上游 `src/`**；并在 `docs/THIRD-PARTY.md` 增加一条，写明名称、仓库 URL、固定 commit、MIT 许可证与落盘路径（`docs/HANDOFF-2026-11-28.md:138-142`；本仓登记格式见 `docs/THIRD-PARTY.md:1-5`）。任何「我们解释不了的第三方文件」一律不 vendor（`docs/HANDOFF-2026-11-28.md:142`）。被替换掉的 api / IndexedDB 文件若仍留在 `dist/` 里，打包步骤必须明确列出「保留/剔除」的理由（`:141`）。

## 5. 绝不能移进 demo 的东西

- **能力逻辑**：日程、平板本地定时任务、远程控制（以及授权行）的状态与动作全部留在 ArkUI（入口见 §3.3）。外壳里出现它们只能是一个标签 + 一次 `openCapability` 回调；任何实现代码迁进去，等于让平板出现第二个 DSH 控制面与第二个授权表。
- **preset 谓词**：准入只信 `sessionPresetOf(chats/<id>/session.jsonl)` + `filterChatPreset`（`model/chatList.ts:526-592`；写口复核 `services/chatStore.ets:332-335`）；今天是 `'chat' | 'other'`（`:47,526-528`），计划加 `dots`（§1）。demo 不得按标题 / 工作区 / `index.kind` 猜，也不得自己判定「这是不是云端 / dots 会话」。
- **隐藏/删除写通道**：唯一写口是 `chatStore.hideChat(id)` 的 tmp 写 + 回读 + rename + commit + push 四阶段（`services/chatStore.ets:294-384`、`model/chatHide.ts:59-97`），四句文案在 `model/chatHide.ts:99-106`。demo 只能发意图；不得写 `chats/index.jsonl`、不得产出 `unarchive`、不得碰 `chats/<id>/**`。
- **待/请求行**：「待创建」条与 `chat-requests/<id>.json` / `.ack.json` 是已定形状但**尚未实现**的模块（`docs/HANDOFF-2026-11-28.md:51-66`；源码里 `chat-requests` 0 命中）。外壳不得自己画一条「已请求」行，也不得缓存「待确认」状态；要显示也只能显示 ArkUI 给的只读文本。
- **任何第二真相源**：demo 自己的会话列表、IndexedDB、`localStorage` key、本地 pending 队列、平板任务列表、授权表都算。桥是唯一数据入口且拒写（`docs/HANDOFF-2026-11-28.md:136`）；`chats/index.jsonl` 是隐藏状态的唯一真相（`model/chatHide.ts:9`、`services/chatStore.ets:21`）。

## 6. 体积与重建代价

- **估计**：demo `dist/` 资产的体积增量约 **300–450 KB gzip**，**不含**我们替换后的桥（`docs/HANDOFF-2026-11-28.md:121`）。这是可行性阶段的估计，不是测量值；本仓树里未见 vendored demo `dist/` 资产（该集成仍只是可行性结论，`docs/HANDOFF-2026-11-28.md:115-123`），本文也没有对其打包。
- **怎么量真值**：固定上游 commit → 在其**独立工作树**里按它自己的构建流程产出 `dist/`（**不是**本仓的 `node scripts/build.mjs`，本轮禁止，且它会写 `packages/dsh-dots/dist`，见 `docs/HANDOFF-2026-11-28.md:13`）→ 对 `dist/` 每个文件按实际下发压缩方式（gzip，或打包实际用的压缩）逐个测 → 减去我们删除/替换的 api/IndexedDB/ZIP 资产 → 加上桥 shim → 与同一构建配置下的 HAP 基线做前后差。上游 commit 未固定前所有数字都按估计读。
- **重建代价（必须诚实）**：rawfile 改动**需要 HAP 重建 + 重新安装才能在设备生效**，vendored 资产没有逐改热更新（`docs/HANDOFF-2026-11-28.md:111`；本仓也不从外部下载/执行代码来做热更新，`docs/RELEASE-PLAN-APPGALLERY.md:73`）。
- **含义**：迭代**桥契约/ArkUI 侧适配**便宜（纯 TS + 单测，不需要 HAP）；迭代 **vendored `dist/` 或 rawfile 里的 JS** 昂贵（每次都要重建、重装、重验）。因此把尽可能多的逻辑留在 ArkUI 侧，把 `dist/` 当作冻结资产；桥 glue 若必须落在 rawfile，就按批次改，不要按单字改。

## 7. 「不做」清单（v1）

| 不做 | 依据 |
| --- | --- |
| **不做流式**：没有 push 通道；桥只返回「当前已导出的文本」。UI 必须显示「等待桌面回答」，**绝不伪造打字机效果** | `docs/HANDOFF-2026-11-28.md:131,152`；`docs/CHAT-SYNC.md:8-13` |
| **不做附件上传**：只读展示；上传仍发生在本机桌面 | `docs/HANDOFF-2026-11-28.md:133`；`model/chatList.ts:598-602`（只拼 `text` 段，图片段跳过） |
| **不做多设备冲突解决**：同一会话同一时刻只有一个写者；禁 rebase/merge/force | `docs/CHAT-SYNC.md:8-13,36-51` |
| **不做每设备 chat 身份**：`chats/` 是跨设备共享命名空间，不是 `devices/<id>/` | `docs/CHAT-SYNC.md:53-66` |
| 不做 API key 界面 / 直连 API / IndexedDB 持久化 / ZIP 写盘 | `docs/HANDOFF-2026-11-28.md:136` |
| 不做外壳内的 grant/revoke、日程写入、平板任务写入/轮询、远程控制 WebView、命令发送 | §3.3、§3.4；`pages/RemoteControl.ets:26-31`；`pages/Index.ets:22-25` |
| 不做第二份会话列表 / 第二套 preset 判据 / 第二个待确认状态 | `model/chatList.ts:526-592`；`pages/Chats.ets:95-105` |
| 不做远程 `sessionList` feed 接线（问题已关闭） | §2；`.ets` 0 命中；插件侧 `packages/dsh-dots/src/rpc.ts:1232-1236` |
| 不自建 5 分钟巡逻 / 后台定时器（DSH 的任务在 DSH 调度器里，§3.4） | `pages/Index.ets:22-25`；`docs/FEATURE-BACKLOG.md:411-413,422` |
| 不做新建会话「待创建」条（除非 `mod-app-chat-create` 先落地并通过评审） | `docs/HANDOFF-2026-11-28.md:51-88`；源码 `chat-requests` 0 命中 |
| 不做「导出最近 N 条 / 全部对话」这类过度承诺文案；今天导出的 chat 会话数为 0 | `docs/HANDOFF-2026-11-28.md:45-46,159,164` |

## 8. 未决与风险

**需要决策**

1. 是否接受 300–450 KB 资产增量（平板存储与首次加载）（`docs/HANDOFF-2026-11-28.md:150`）。
2. v1 是否确实不做附件上传（`docs/HANDOFF-2026-11-28.md:151`）。
3. 「等待桌面回答」的最长等待与超时文案（`docs/HANDOFF-2026-11-28.md:152`）。
4. 顺序：**先把 chat / dots 的 preset 准入与导出接好、再换皮**，否则 demo 面对空仓库只能证明好看（`docs/HANDOFF-2026-11-28.md:153`）；今天 888 个会话全是 work、导出 0 条（`:45-46,159`）。
5. 逐行删除入口目前只在独立页 `pages/Chats.ets:438-451`；两个 home 面板 `pages/panes/CloudChatPane.ets:103-153` / `pages/panes/DotsPane.ets:195-245` 都没有删除按钮。换皮后是否把这条入口接进面板，需要产品裁定；外壳不得自行发明。
6. `dots` preset 的 `plugins` 组合、以及「缺少 grant」在哪一步 fail closed（§3.5）。
7. 平板本地定时任务页面：触发面与可改字段的窄白名单、离线跳过 + missed-fire 标记是否采纳、卸载重装后是否要耐久存放处（§3.4）。

**`unverified` 清单（以及证实所需证据）**

- 上游 demo 中 `services/api/*`、API key 设置、IndexedDB、ZIP 写盘的**精确文件清单**：固定 commit 后枚举 `dist/` 与构建源引用（`docs/HANDOFF-2026-11-28.md:136,141`）。
- 300–450 KB 本身：按 §6 的真实测量流程得到 gzip/brotli 逐文件数字与 HAP 前后差。
- 平板本地定时任务页的确切存储 API（§3.4）：需看到新任务 store 的 `.ets` 文件及其落盘调用。
- 平板任务允许的安全字段子集与触发面（§3.4）：需产品 + 安全裁定。
- `openCapability(kind)` 的签名与 ack 形状是本文**提案**：今天桥里没有该方法；需在 `apps/arkui-schedule/entry/src/main/resources/rawfile/git/git-bridge.js` 或其 ArkUI 注入侧出现同名实现才能证实（§3.3）。
- 已注册的 `dots` preset 与 dots 专用工具白名单（§3.5）：需 `ctx.agentPresets.register({id:'dots',...})`、dots allow 常量与装配路径上的安装器调用。
- 「待创建」行的文案与实现：`docs/HANDOFF-2026-11-28.md:63,77` 只给形状；源码 0 命中。
- 外壳在 HarmonyOS WebView 上是否完整支持 KaTeX / Mermaid / 分支 / 深浅主题：需要真机验证；本轮不构建、无设备（`docs/HANDOFF-2026-11-28.md:111`）。
- 上游是否只有一个 `dist/index.html`、不存在按 segment 分叉的 bundle：固定 commit 枚举产物（§2）。

**风险**

- 两个真相源：任何能力状态、会话列表、preset 判据、待确认态被复制到 JS，都会让「壳里显示」与「仓库里的事实」分叉（§2、§5）。
- 判错「一个外壳」：若两段需要不同的消息动作 / 数据形状，桥会长成「一个文件里的两个适配器」，测试矩阵与升级成本翻倍；observable symptom 见 §2，出现即重估。
- 凭据泄漏：若远程控制被外壳实现，token 会落进 WebView/localStorage；v1 里 WebView 只属于 ArkUI 页面（`pages/RemoteControl.ets:1-2,26-31`）。
- 静默降级：dots 会话缺 grant / 工具隔离失败若被当成「能力少一点」，就违背 fail closed（§3.5；`packages/dsh-dots/src/chatPreset/isolate.ts:23-31`）。
- 单写者被破坏：demo 的编辑框若真发送，会制造第二条事件流（`docs/CHAT-SYNC.md:17-34`）。
- 许可与供应链：未附原始 `LICENSE` / `THIRD-PARTY.md` 条目、或 vendor 了上游 `src/`，都违反 MIT 归属要求（`docs/HANDOFF-2026-11-28.md:138-142`）。
- 迭代成本误判：以为改 rawfile 能热更新；事实是需要 HAP 重建 + 重装（`docs/HANDOFF-2026-11-28.md:111`）。

### 8.1 代码树与任务背景的偏差（均以 path:line 为准）

1. **远程 `sessionList` 不是 dots 的数据源**：dots 段 = 同一份已发布索引按 preset 过滤，v1 不接线；`.ets` 侧 `sessionList` 0 命中，插件侧仅 `packages/dsh-dots/src/rpc.ts:1029,1232-1236,1364-1365`、`packages/dsh-dots/src/remote/projection.ts:15,169,178`（§2）。
2. **「一个桥、两个数据源」→「一个索引、一个 preset 过滤」**：当前代码是索引 `kind` 分段（`model/chatList.ts:498-514`、`pages/panes/DotsPane.ets:177`）加只认 `chat` 的 preset allow-list（`services/chatStore.ets:219-225`）；`dots` preset 尚不存在（§1）。
3. **三种会话 vs 代码里的两种取值**：`ChatSessionPreset = 'chat' | 'other'`（`model/chatList.ts:47,526-528`），导出白名单只有 `'chat'`（`packages/dsh-dots/src/chats/index.ts:299-300`）；work / chat 有据（`docs/HANDOFF-2026-11-28.md:43-46`），dots 是产品决定、代码缺口（§1、§3.5）。
4. **三个能力入口**：远程控制有 ArkUI 页（`pages/RemoteControl.ets:1-2`）、日程有面板（`pages/panes/SchedulePane.ets:1-2,1371,1384`），**平板本地定时任务没有专属 ArkUI 入口**（`docs/FEATURE-BACKLOG.md:411-413,422`）；用户已批准新增页面（§3.4），DSH 自己的任务在 DSH 调度器里、不在本页（§3.4）。
5. **「四条失败横幅」**：代码里是四句 typed 文案（`model/chatHide.ts:99-106`），当前渲染是一条 `hideHint` Text + toast（`pages/Chats.ets:678-685,268-271`）；「四条失败横幅」是交接文档的叫法（`docs/HANDOFF-2026-11-28.md:146`）。
6. **「待创建」行**：背景/交接里是既定形状（`docs/HANDOFF-2026-11-28.md:51-66`），但源码里没有实现（`.ets`/`.ts` grep `chat-requests` = 0 命中）。
7. **授权表不是 preset 闸**：`services/instanceGrantStore.ets:35-36,67-167` 是 per-instance 工具授权，dots 面板只读（`pages/panes/DotsPane.ets:99-134`）；工具隔离安装器只为 chat 写好且**未接线**（`packages/dsh-dots/src/chatPreset/index.ts:2-8`、`isolate.ts:370-421`）。所以「缺 grant 的 dots 会话 fail closed」今天没有现成机制，需按 §3.5 组合实现。
