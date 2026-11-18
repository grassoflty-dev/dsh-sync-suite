# 配置体验重做（CONFIG-UX）

> 状态：**设计稿**（2026-11-18）。本轮只写文档：不含实现代码、不改源码 / 测试 / 配置、不 commit。
>
> 关系与边界：本文**只改交互与文案**。不改 `docs/DATA-CONTRACT.md` 的任何持久化契约，
> 不改 `docs/REMOTE-ACCESS-OPTIONS.md` §3 的字段语义表（`:214` 原文："改这张表必须同时改两端 + `types.ts`"）。
> 唯一需要动契约的两处集中在 §C「需要决策的点」。
>
> 一句话：(A) Git 接入从"填 6 个字段"变成"给仓库地址 + token，剩下我来推"；
> (B) 远程控制从"6 种方式各一套表单"收敛成"**一个连接** + 自动挑路"。

## 0. 结论（三条）

1. **(A) 五步**：地址 + token → 识别 + 试连（一次网络动作）→ 分配设备编号 + 展示写入路径 →
   勾选同步范围（默认只开日程）→ 完成并显示结果。题面的 6 条要求映射成 5 步，映射表见 §A.2。
2. **(B) 一个连接**：4 个可见字段 `{方式, 地址, 令牌, 最近成功时间}`；`auto` 的优先级是
   **局域网 → 公网 IPv6 → 已配置隧道 → 手动**；**判定必须在平板侧做**（§B.2）。
3. 两处新增要动契约（需决策）：`mode: 'auto'` 进 `RemoteAccessMode` 枚举；平板是否引入扫码能力。
   见 §C 第 1、2 条。

---

# A. Git 接入向导

## A.1 目标与三条不变量

**目标**：用户只提供两样东西——**仓库地址** + **token**。平台、owner、默认分支、设备编号、写入路径
全部由系统推导并**展示给他看**，不要求输入。

| # | 不变量 | 为什么 |
| --- | --- | --- |
| 1 | **推导优先于输入**：能算的一律不让人填 | 现在要填 6 项（仓库地址、token、设备标识、作者名、平台、认证方式，`docs/UI-DESIGN.md:116`），其中 4 项可以推导 |
| 2 | **推导失败不阻断**：该字段挪进「高级 ▸」并给可改初值 | UX 上 fail-open（能继续走），写入上 fail-closed（没确认不写） |
| 3 | **第 3 步分配成功前不写任何文件** | 抢号失败必须整体失败、不产生任何 `devices/<id>/` 提交（`docs/DATA-CONTRACT.md:396-397`） |

## A.2 五步流程（与题面 6 条的映射）

| 题面要求 | 落在哪一步 | 说明 |
| --- | --- | --- |
| ① 地址 + token | **Step 1** | 一屏只有两个输入框 |
| ② 自动识别 provider / owner / 默认分支 | **Step 2** | 纯本地推导，零网络 |
| ③ `lsRemote` 试连并展示"仓库现有内容" | **Step 2** | 与 ② 合并：②不需要网络、③需要，合成一次"确认仓库"的动作，否则用户会在两屏之间来回 |
| ④ 自动分配设备编号 + 展示将写入路径 | **Step 3** | 这一步才第一次写远端 |
| ⑤ 勾选同步范围（默认只开日程） | **Step 4** | 选项来自类型注册表（`docs/SYNC-SCOPES.md` §6） |
| ⑥ 完成并显示结果 | **Step 5** | 首次 push 的真实结果 |

### Step 1 — 仓库地址 + token

| 项 | 内容 |
| --- | --- |
| 用户看到 | 标题「把你的日程同步到自己的仓库」；两个输入框：`仓库地址`、`token（密码框）`；底部唯一主操作 `下一步`。**没有**平台选择、分支、设备标识 |
| 校验 | 地址走 `validateRepoUrl`（`apps/arkui-schedule/entry/src/main/ets/model/repoUrl.ts:93`，逐条中文失败文案在 `:96-137`，直接复用，不另写）；token 非空、无内部空白（地址里带凭据一律拒绝，`packages/dsh-dots/src/engine/git.ts:186-189`） |
| 系统做什么 | 只存内存；**不落盘**。落盘发生在 Step 5（`saveSettings`，`docs/DATA-CONTRACT.md:130`；token 单独进 `credentials.json` 0600，`:185`） |
| 失败停在哪 | 停在 Step 1，就地红字 |

### Step 2 — 识别 provider / owner / 默认分支 + `lsRemote` 试连 + 展示仓库现有内容

| 项 | 内容 |
| --- | --- |
| 用户看到 | 一行"识别结果"（`GitHub · octocat/dsh-data · 分支 main`）+ 一张"仓库里已有什么"的卡片（设备数 / chats 数 / 是否有 DSH 配置快照）+ `继续` |
| 识别规则（本地，零网络） | **platform**：host 是 `github.com` → `github`，`gitee.com` → `gitee`，其它 → `custom`（枚举只有这三值，`packages/dsh-dots/src/engine/types.ts:12`）。**owner**：`repoUrl` 解析出的 `repoPath` 第一段（`repoUrl.ts:36-37` 已去掉 `.git`，`:164-168` 已保证非空）。**默认分支**：见下 |
| 默认分支的三级推导 | ① 远端 `refs/heads` 里有 `main` → `main`；② 否则有 `master` → `master`；③ 只有一个 head → 用它；④ 空仓库（refs 为空）→ `main`（`docs/DATA-CONTRACT.md:8` 约定唯一远端、main 分支） |
| 试连 | `lsRemote()`（`engine/git.ts:452-477`）：`git ls-remote --heads <url>`，超时 `NETWORK_TIMEOUT_MS = 8000`（`:55`；外部配置会被夹到该值，`:265-269`）。**只读、不动工作树** |
| 展示现有内容 | `lsRemote` 只给 refs，不给文件列表；要"现有内容"必须 `listTree`（`engine/git.ts:673-679`），而它需要一个 rev → 首次接入要 `ensureWorkTree`（clone）后再 `listTree`。既有先例的顺序就是 `ensureWorkTree → fetch → listTree`（`engine/preview.ts:261-266`），**照抄这个顺序**，全程只读 |
| 三个数字的口径 | 设备数 = `listTree('devices/')` 里 `devices/<x>/` 去重计数（同 `engine/preview.ts:164-171` 的 `devicesInTree`）；chats 数 = `listTree('chats/')` 里 `chats/<id>/` 的目录数（布局见 `docs/DATA-CONTRACT.md:334-340`）；是否有 DSH 配置快照 = 是否存在 `devices/<任意>/cordis.patch.yml`（`:14`）。顺带显示 `devices/registry.jsonl` 的行数（编号登记表，`:374`） |
| 失败停在哪 | 停在 Step 2；Step 1 的输入全部保留。文案见 §A.4 |

> **为什么三个数字要真去 `ls-tree` 而不是"猜"**：这张卡片的用途是让用户在**写入之前**确认"我是不是接错仓库了"
> （比如误选了别人的公开仓库）。猜出来的数字会让这个确认变成假的。拿不到就显示"未知（未拉取）"，见 §A.3。

### Step 3 — 分配设备编号 + 展示将写入路径

| 项 | 内容 |
| --- | --- |
| 用户看到 | 「你的设备编号：`device-2`（自动分配）」+ 一张"将会写入这些文件"的清单 + `开始同步` |
| 分配机制 | `claimDeviceId`（`docs/DATA-CONTRACT.md:390-399`）：先 pull → registry 里有本机 uuid 的行就沿用（不重复登记）→ 否则 `nextDeviceId` 算号（**最大 `device-N` + 1，空洞不回填**，`:383-386`）→ 只提交推送 `devices/registry.jsonl` → 被拒则回滚该提交 + 重试，上限 5 次（`MAX_CLAIM_ATTEMPTS`，`apps/arkui-schedule/entry/src/main/ets/model/deviceRegistry.ts:38`）→ 仍失败 `E_DEVICE_ID_CONFLICT`（`:41-44`） |
| 硬规矩 | 抢号失败**不许随便用一个号继续写**：`push` 整体失败，不产生任何 `devices/<id>/` 提交（`docs/DATA-CONTRACT.md:396-397`） |
| 路径清单（默认只开日程时） | `devices/device-2/schedules/YYYY-MM-DD.jsonl`（`:19`）、`devices/device-2/open.jsonl`（`:160`）、`devices/device-2/attachments/YYYY-MM-DD.zip`（`:175`）、`devices/device-2/summaries/YYYY-MM-DD.json`（`:23`） |
| 必须写在清单旁的一句 | 「其它设备的目录只读，永远不会被写」（`:28`）；以及「`registry.jsonl` 是唯一允许写 `devices/` 顶层的文件」（`:404`） |
| 失败停在哪 | 停在 Step 3；`E_DEVICE_ID_UNREADABLE` / `E_DEVICE_ID_CONFLICT` 都会**自动展开高级**并显示原因（`:403`） |

### Step 4 — 勾选同步范围（默认只开日程）

| 项 | 内容 |
| --- | --- |
| 用户看到 | 一组复选项，每项一行"外传什么 / 不外传什么"（文案取自类型注册表的 `neverOut` 摘要，见 `docs/SYNC-SCOPES.md` §2 第 4 项） |
| 默认值 | `schedules` **开**；`summaries` / `open-index` / `attachments` **跟随联动开**（它们是日程的派生物，单独关掉会得到"有记录没汇总"的半套）；`chats` / DSH 配置 / AI 供应商 / 插件清单 **默认关** |
| 默认关的理由（写在每一行里，不是弹层） | `chats`：「对话正文会进 Git 历史，删不掉」（`docs/CHAT-SYNC.md:268-269`）；DSH 配置：「会改写本机配置，只在你勾选并确认时生效」（`docs/DATA-CONTRACT.md:62`、`engine/restore.ts:138-141`）；AI 供应商：「含密钥字段，永不外传」（`docs/DATA-CONTRACT.md:38`、`docs/SYNC-SCOPES.md` §5.4）；插件清单：「只生成安装计划，不自动安装」（`docs/DATA-CONTRACT.md:39`） |
| 选项从哪来 | **只列注册表校验通过的类型**；未声明合并策略的类型**根本不出现**（`docs/SYNC-SCOPES.md` §6.1）。这条是本文档与那份文档的接缝：向导不允许绕过注册表造开关 |
| 失败停在哪 | 这一步没有网络动作，不会失败；但仓库地址/分支在 Step 2 之后被改过 → 回退 Step 2 重试 |

### Step 5 — 完成并显示结果

| 项 | 内容 |
| --- | --- |
| 系统做什么 | 首次同步 = 一次 `push`（`docs/DATA-CONTRACT.md:131`），响应 `{pushed, commit, branch, files, rebased}`；随后 `saveSettings` + token 落 `credentials.json`（`:185`） |
| 用户看到 | 仓库地址 / 分支 / 设备编号 / 首条提交 sha 前 7 位 / 推送了几个文件 / 是否 rebase 过；一行「本机：device-2（自动分配）」（`:398-399`）；底部 `开始用` |
| 失败 | push 失败**不清空已输入**；给 `重试`；原因复用 §A.4（push 侧还会多一种"非快进"，见该表最后一行） |

## A.3 「仓库现有内容」的判定口径（为什么不是"猜"）

| 显示项 | 数据源 | 判定 | 不可得时显示 |
| --- | --- | --- | --- |
| 仓库可达 | `git ls-remote --heads` 退出码（`engine/git.ts:452-458`） | 退出码 0 = 可达 | —（不可达就是失败，见 §A.4） |
| 默认分支 | 同一份 refs 输出（`:460-467`） | 见 §A.2 Step 2 三级推导 | `main` + 一行「按默认约定填的，可在高级里改」 |
| 设备数 | `ls-tree -r --name-only <rev> -- devices/`（`:673-679`） | `devices/<x>/` 去重计数 | 「未知（未拉取）」 |
| chats 数 | 同上，前缀 `chats/` | `chats/<id>/` 目录数 | 「未知（未拉取）」 |
| 是否有 DSH 配置快照 | 同上 | 存在任一 `devices/<x>/cordis.patch.yml` | 「未知（未拉取）」 |
| 登记表行数 | `git show <rev>:devices/registry.jsonl` 后按行计数 | 行数（坏行也计数并在下一次同步时被 `parseRegistry().errors` 吞掉，`:381-382`） | 「未知（未拉取）」 |

纪律：**没有一个数字来自推断**。拉不到就明写"未知"，不能因为"应该是空的"就显示 0 —— 那会让用户对
"我接的是空仓库"这个判断失去依据。

## A.4 失败文案表（401 / 403 / 404 / 超时 / 非空仓库无写权限）

> **先分清归因来源，否则会写出假话**：401/403/404 三个状态码只可能来自 **App 侧的 smart-HTTP 探测**
> （`repoProbeUrl` 拼 `<repo>/info/refs?service=git-upload-pack`，`repoUrl.ts:177-188`；
> 文案已有逐条版本，`describeRepoProbe`，`:191-212`）。PC 侧 `git ls-remote` **不透传 HTTP 状态码**，
> 只能按 git 的文本归类（`isAuthFailure`，`engine/git.ts:211-215` → 错误码 `E_AUTH`，`:326`）。
> 因此：**同一套用户文案，两个来源**；UI 不许写"git 说 401"。

| 状态 | 发生了什么 | 为什么 | 下一步 |
| --- | --- | --- | --- |
| **401** | 远端说"需要认证"，token 被拒。<br>首行文案：`token 没通过：请重新复制一次，注意不要带空格` | 私有仓库把 token 当密码用；Gitee 还要求"用户名 = 登录名、令牌只作密码"，用户名填昵称也会 401（`engine/git.ts:223-230`）；token 过期 / 被撤销 / 复制时少字符同样 401（`:211-215`） | 重新生成一个对该仓库有读写权限的 token（GitHub: `repo`；Gitee: `projects`），粘进 token 框；Gitee 先确认高级里的"用户名"是登录名 |
| **403** | 认证过了，但**没有这个仓库**的权限。<br>首行文案：`这个 token 能登录，但没有这个仓库的写权限` | token 的 scope 不含该仓库（只给了公开范围）、你只是只读协作者、组织仓库开了 SSO 未授权；平台限流也会回 403/429（`engine/git.ts:212` 把 `403 Forbidden` 一并归到 `E_AUTH`） | 换一个有写权限的 token；组织仓库要在 token 上授权该组织；顺手确认 `main` 没有被分支保护锁住 |
| **404** | 仓库"不存在"。<br>首行文案：`没找到这个仓库：核对一下用户名和仓库名` | 私有仓库在**无凭据时故意回 404**（`repoUrl.ts:202-203` 已写明这一点，不要重新发明解释）；owner/repo 拼错、仓库已改名或删除同样是 404 | 用浏览器登录后打开同一地址确认存在；核对大小写与是否多写了 `.git`；确认 token 对它有读权限（否则仍会 404） |
| **超时** | 8 秒内没拿到任何响应。<br>首行文案：`连不上仓库地址：检查网络、代理或防火墙` | 超时上限就是 `NETWORK_TIMEOUT_MS = 8000`（`engine/git.ts:55`，外部配置会被夹到该值，`:265-269`）；常见原因：DNS 解析失败、公司代理没配、防火墙拦 443、IPv6-only 网络访问 v4 域名（`repoUrl.ts:205-207` 走"没拿到响应"这一支） | 用浏览器打开仓库地址确认能进；配 `HTTPS_PROXY` 后重试；换网络（手机热点）重试；连续 3 次都超时再考虑改地址 |
| **非空仓库无写权限** | 读得到（`lsRemote` 成功）、第一次 push 被拒。<br>首行文案：`仓库能读，但推不上去：分支受保护，或 token 只是只读` | 分支保护禁止直推 `main`；token 是 read-only；仓库是别人的、你只是协作者。本插件**永不 force push**、也不会替你开 PR（`engine/git.ts:643-655`），所以推不上去就是推不上去 | 在仓库设置里放开 `main` 的保护，或换一个自己的空仓库；确认 token 是 read-write。判定顺序：先排除"非快进"（`isNonFastForward`，`:207-209`），剩下的鉴权类才归到这一行（`:211-215`） |

补充：非快进（分叉）不在本表，因为它的处置是"先 rebase 一次再试"（`engine/git.ts:643-652`），
用户可见文案是「远端分支已分叉…」（`:653-655`），属于"重试即可"而不是"配置错了"。

## A.5 高级折叠：哪些字段进折叠、什么时候自动展开

| 进「高级 ▸」的字段 | 为什么默认折叠 | 初值来源 |
| --- | --- | --- |
| 平台 `platform`（GitHub / Gitee / 自定义） | 由 host 推导出来（`engine/types.ts:12`），只有自建 Git 服务才需要改 | Step 2 识别结果 |
| 认证方式 `authMode`（HTTPS / SSH） | token 就是 HTTPS 用的（`docs/DATA-CONTRACT.md:185`），SSH 要额外配 ssh-agent（`engine/types.ts:14-15`） | `https` |
| 分支 `branch` | 由 refs 推导，空仓库回落 `main`（`docs/DATA-CONTRACT.md:8`） | Step 2 推导结果 |
| HTTPS 用户名 `username` | 只有 Gitee 必填，且是"登录名"（`engine/git.ts:226-229`） | 空（GitHub/自定义由 `resolveAskpassUser` 补 `x-access-token`，`:229`） |
| 设备标识 `deviceId` | 自动分配（`docs/DATA-CONTRACT.md:390-399`）；手工改等于**换写入目录**（`:229-230`），是危险操作 | Step 3 分配结果（只读展示） |
| 作者名 `author` | 本机偏好，与同步无关（`docs/UI-DESIGN.md:116` 归在同步组第 3 行） | 上次保存值 |

**自动展开条件**（沿用已定规则，第 4 条是同构先例、需决策）：

| # | 条件 | 来源 | 展开后高亮哪个字段 |
| --- | --- | --- | --- |
| 1 | 仓库不可读 / 拉取失败（`E_DEVICE_ID_UNREADABLE`） | `docs/DATA-CONTRACT.md:402-403` | 仓库地址 + token |
| 2 | 设备标识重复（`identityConflict`，两台设备用了同一个 id） | `docs/DATA-CONTRACT.md:218-220`、§6.1 | 设备标识（只读 + 一句「请改成唯一值」） |
| 3 | Gitee 用户名推不出来（`resolveAskpassUser` 抛 `E_VALIDATION`） | `engine/git.ts:226-229` | 用户名 |
| 4 | 用户主动选了 `ssh` 或「自定义」平台（**建议，待决策**） | 同构先例：`docs/UI-DESIGN.md:117`「选 `custom` 时自动展开」 | `authMode` / `platform` |

**明确不展开**：401 / 403 / 404 / 超时。这四种的解法是"改输入值（地址或 token）"，
展开高级只会让用户以为要去动平台和分支——**越展开越错**。

## A.6 验收与待定

| 项 | 内容 |
| --- | --- |
| 验收 1 | 只输入"地址 + token"能走完 5 步，并能逐屏说出每个默认值的来源（对应 §A.5 的"初值来源"列） |
| 验收 2 | §A.4 五条文案逐字命中；401/403/404 三条必须由 App 侧 HTTP 探测触发（而不是 git 文本） |
| 验收 3 | 抢号失败三次（模拟 registry 被抢）后，仓库里**没有**任何 `devices/<id>/` 提交（`docs/DATA-CONTRACT.md:396-397`） |
| 待定 1 | 默认分支是否多花一次 `ls-remote --symref` 换取平台真实默认分支。判据：实测 GitHub / Gitee 上"默认分支既不是 main 也不是 master"的仓库占比 > 5% 就值得多一次网络 |
| 待定 2 | 首次接入是否允许浅克隆（`--depth 1`）缩短 Step 2 等待。判据：`listTree` 只需要一个 rev 的树（`engine/git.ts:673-675`），depth=1 理论上够；需实测深历史仓库的 clone 耗时 p95 |

---

# B. 远程控制：收敛成「一个连接」

## B.1 「收敛」的确切含义：改呈现，不改存储

**现状**：6 种方式（`lan` / `tailscale` / `ipv6` / `cloudflare` / `manual` / `uu`，`packages/dsh-dots/src/remote/types.ts:21`），
每种方式 1–3 个字段，用户必须先自己判断"我是哪种情况"再看字段
（`apps/arkui-schedule/entry/src/main/ets/model/remoteAccess.ts:155-314` 的 `REMOTE_MODES` 表）。

**目标**：用户只面对 4 个字段：`{方式, 地址, 令牌, 最近成功时间}`。

**存储不变**：仍是 `remote.json` 的 9 个字段（`docs/DATA-CONTRACT.md:243-249`；
字段语义表 `docs/REMOTE-ACCESS-OPTIONS.md:216-226`）+ App 侧 6 个 preferences 键。
"收敛"只发生在**呈现层**——4 个可见字段背后是"当前选中方式"的槽位映射：

| 可见字段 | 底层槽位 | 备注 |
| --- | --- | --- |
| **方式** | `mode` | 6 值，将来可能 + `auto`（§C 第 1 条） |
| **地址** | 按 `mode` 取**一个**：`lanAddress` + `port` / `ipv6Address` + `port` / `tailscaleHost` + `port` / `cloudflareHost` / `manualUrl` | `manual` 与 `uu` **刻意共用 `manualUrl`**（`docs/REMOTE-ACCESS-OPTIONS.md:225`），不许新增槽位。切换方式时**保留**其它槽位的值（不清空），避免"切一下就丢" |
| **令牌** | `token`（可选，空串 = 不带） | 密码框，初始值恒空串，永不回显（`docs/REMOTE-ACCESS-OPTIONS.md:285-288`） |
| **最近成功时间** | **不在现有 9 字段里** | 见 §B.4 的落盘建议；这是唯一新增，需决策 |

## B.2 `auto`：优先级与"谁来判定"

**优先级**：**局域网直连 → 公网 IPv6 → 已配置隧道（cloudflare / tailscale，按最近成功时间倒序）→ 手动**。

| 档 | 何时算可用 | 探测在哪一侧 | 依据 |
| --- | --- | --- | --- |
| 1. 局域网 | 平板与电脑同子网，且平板能打开 `http://<lan>:<port>/__dsh_remote/health` 拿到 200 | **平板侧** | health 端点免令牌（`packages/dsh-dots/src/remote/routes.ts:162-173`）；PC 侧自检的 `dsh-loopback-reachable` 只能证明"本机能连本机"（`docs/REMOTE-ACCESS-OPTIONS.md:248`），**对这台平板不构成证据** |
| 2. 公网 IPv6 | 平板所在网络有 v6、够到该地址、端口放行 | **平板侧** | 前置条件 1–4 与"最常见失败"见 `docs/REMOTE-ACCESS-OPTIONS.md:84-99`；外网可达性只能人验（§6 第 4、5 条，`:297-298`） |
| 3. 已配置隧道 | `cloudflareHost` 或 `tailscaleHost` 非空，且该档"最近成功时间"最新 | **平板侧**（PC 侧只能判"装了 cloudflared"/"有 `100.64/10` 地址"） | PC 侧检查项：`cloudflared-installed`、`tunnel-host`、`tailnet-address`、`tailscale-host-match`（`docs/REMOTE-ACCESS-OPTIONS.md:257-260`） |
| 4. 手动 | 上面都不通，且 `manualUrl` 非空 | 平板侧，或用户点「就用这个」 | `docs/REMOTE-ACCESS-OPTIONS.md:150-156` |

**三条判定纪律**：

1. **判定必须在平板侧完成**。PC 侧只提供**候选清单**（`RemoteStatus.urls`，不含 token，
   `remote/types.ts:170-171`；展示态地址另外打码，`service.ts:311`）。理由：PC 侧任何探测都无法
   证明"这台平板能不能连到 PC"——`external-reachability` 与 `firewall-inbound` 在自检里**恒 `unknown`**
   （`docs/REMOTE-ACCESS-OPTIONS.md:255-256`），这是刻意的防假阳性结构。
2. **降级要留痕**：某档失败 → 记一行"为什么跳过"（人话，不带 token）→ 试下一档。
3. **全失败不做静默回落**：显示最后一档的真实失败原因 + 一个「手动填地址」入口。
   不做假开关、不假装连上（同 `docs/REMOTE-ACCESS-OPTIONS.md:48-49` 的纪律）。

## B.3 一键测试：三段探测 → 人话结论

顺序**不可调换**：先健康段（不带令牌），再令牌段（带令牌），最后长连段。反过来做的话，
401 会被误读成"网络不通"。

| 段 | 请求 | 判读 | 含义 |
| --- | --- | --- | --- |
| **① 健康段** | `GET <地址>/__dsh_remote/health`（**不带** token） | 200 且 body 里 `app === 'dsh-remote'` | 到了**插件的远程监听**（`routes.ts:164-173`，该端点免令牌、只校验方法） |
| | | 200 但 body 不是那个 JSON | **连上的是 DSH 本体或别的反代**，不是插件的远程入口（最容易被误判成"成功"的情形） |
| | | 401 | 前面还有一层鉴权（反向代理 / 平台门户），请求没到我们这层 |
| | | 连接拒绝 / 超时 | 网络层就不通 |
| **② 令牌段** | `GET <地址>/`（带 `?token=`，或已有会话 cookie） | 200 | 令牌门通过（会话有效，`routes.ts:220-229`） |
| | | **303** | token 刚被消化并下发 cookie（`routes.ts:193-202`）——**这不是失败**，跟一次即可 |
| | | 401 | 令牌不对或没带（`routes.ts:204-208`） |
| | | 429 | 试太多次被临时限速，响应带 `retry-after`（`routes.ts:205-206`） |
| **③ 长连段** | WS Upgrade `<地址>/api/remote.mux` | **101** 才算通 | 长连接可用（路径与判据：`remote/probe.ts:41`、`:1361-1362`） |
| | | 非 101（如 200/302/404） | 中间层把 Upgrade 掐了（同一判据已用在云隧道自检：`:1368-1371`） |
| | | 无响应 | 没拿到证据 ≠ 可用（`:1373-1380` 的 `unknown` 处理） |

**人话结论矩阵**（一次性给一句话 + 一句影响，不给人看日志）：

| ① 健康 | ② 令牌 | ③ 长连 | 一句话结论 | 影响 |
| --- | --- | --- | --- | --- |
| 200 | 200 | 101 | **能连上，一切正常** | — |
| 200 | 200 | 非 101 | **能连上，但 WebSocket 不通，内嵌页面可能无法实时更新** | 页面能开、内容不自动刷新，需手动重进 |
| 200 | 200 | 无响应 | 能连上，但长连接建立不起来（多半被中间层拦了） | 同上 |
| 200 | 401 | — | **能连上，但令牌不对**：把电脑上「显示链接」里的地址整条扫过来 | 打不开 |
| 200 | 429 | — | 能连上，但试太多次被临时限速了，等 N 秒再试 | 打不开（稍后重试） |
| 200（非本插件） | — | — | **连上了，但对面不是插件的远程入口**（像是 DSH 本身或别的代理） | 用不了，检查端口/地址是否指错 |
| 非 200（401 之外） | — | — | 连不上：`<真实原因>`（超时 / 拒绝 / DNS） | 用不了 |
| 超时 | — | — | 连不上（超时）：网络、隧道没开、或防火墙 | 用不了 |

实现约束两条：

- **WS 探测必须由调用方注入**：`probe` 本身从不联网发 WS 请求（`remote/probe.ts:73-80`），
  既有 `ProbeExtras.wsUpgrade` 就是给这件事留的口子（`:78-80`），云隧道分支已经在用（`:1357-1361`）。
  "一键测试"复用它，不新写一套 WS 客户端。
- **结论文本必须打码**：任何拼进 message / hint 的地址都过一遍 `redactText`（`remote/probe.ts:1552-1559`
  的做法），令牌不许出现在结论里（`docs/REMOTE-ACCESS-OPTIONS.md:269-271`）。

## B.4 二维码 + 最近一次成功的一键重连

**出码（PC 侧）**：

- 唯一允许明文 token 的出口是 `remoteShowLink`（`remote/types.ts:185-193`），返回 `{url, qr:{size, modules}}`；
- 二维码生成已存在、纯 TS 零依赖：`encodeQr`（`packages/dsh-dots/src/remote/qr.ts:508`）、
  `qrToSvg`（`:529`）。**不需要新依赖**；
- 纪律：明文只经"用户显式点显示链接/二维码"这一个动作出去（`docs/DATA-CONTRACT.md:250-252`）。

**扫码（平板侧）—— 待决策**：

- 事实：App 目前**没有**扫码能力。全仓检索 `scanBarcode` / `scanCore` / `扫码` 只命中
  `apps/arkui-schedule/entry/src/main/ets/model/theme.ts:90` 与 `:445` 的两条**注释**（讲二维码配色），
  没有实现。
- 两条路：
  - **(a) 引入系统扫码**（`@kit.ScanKit` 的 `scanBarcode.startScanForResult`）：能一次扫码完成配对，
    但要相机权限 + 真机验证；且必须约定"扫码结果不落日志、不 toast 明文、不写进偏好文件"
    （同 `docs/REMOTE-ACCESS-OPTIONS.md:285-288`）。
  - **(b) 不上扫码**：PC 出码只服务"手机相机 → 浏览器"这条既有路径，平板走粘贴地址。
- 判据：**平板是否必须一次扫码完成配对**。若产品接受"粘贴一次"，(b) 成本极低且零权限。

**一键重连**：

| 项 | 规则 |
| --- | --- |
| 按钮什么时候出现 | 仅当"最近成功时间"非空；否则按钮文案是「测试连接」 |
| 点下去做什么 | **照上次那条连接**（`{方式, 地址, 令牌}`）重跑 §B.3 的三段探测 |
| 不做什么 | **不重新推导 `auto` 顺序**——"重连"的语义是"再来一次"，不是"重新挑路"；重新挑路是 `auto` 的正常测试行为 |
| 成功 | 更新时间戳，卡片显示「刚刚」「3 分钟前」这种相对时间 |
| 失败 | **保留**旧时间戳并显示「上次成功：<时间>」，不清空。清空会让用户失去唯一线索（这条与 `docs/DATA-CONTRACT.md:252-254`"不落盘的部分"的取舍相反，是因为它是**跨重启唯一有用的信息**） |

**时间戳落哪**（需决策，三选一）：

| 方案 | 代价 | 评价 |
| --- | --- | --- |
| 加进 `remote.json` | 要改 9 字段契约 → 两端同改（`docs/REMOTE-ACCESS-OPTIONS.md:214`） | 不推荐：一个纯展示状态不该进契约表 |
| 独立文件 `remote-last-ok.json`（0600，不含 secret） | 多一个状态文件 | **推荐**：与 `remote-token.json` 平级、互不影响（`docs/DATA-CONTRACT.md:243-258` 已有的"平级但独立"结构） |
| 不落盘 | 重启即失 | 不满足"最近一次成功的一键重连" |

## B.5 每种方式的「不可用原因」：只许来自实测或文档

**纪律**：不许写"大概是""应该不支持"。凡是 `unknown` 的，UI 上必须显示「需实测」并给一条怎么验的话
（同 `remote/probe.ts:1350-1351` 的写法：把命令直接给用户）。

| 方式 | 用户看到的不可用原因 | 依据（来源） | 性质 |
| --- | --- | --- | --- |
| `lan` | **可用，无不可用原因**。唯一硬约束：不能绑通配地址，否则整个 profile 起不来 | `dsh-host-webserver` 配置期校验原文：`webserver: host … is not a concrete IPv4 or IPv6 address literal`（`docs/REMOTE-ACCESS-OPTIONS.md:60-62`，asar 内校验） | 文档（宿主校验） |
| `ipv6` | 需准备：要有**公网** IPv6 + 光猫/路由器放行入站 + 地址必须稳定（不能是 `Temporary`）+ 平板所在网络也要有 v6 | 前置条件 1–4 与"最常见失败"三条（`docs/REMOTE-ACCESS-OPTIONS.md:84-99`）；本机实测存在 `2409:8a20:4cad:ba20::/60`（`:17`） | 文档 + 本机实测点（外网可达性**只能人验**，`:297-298`） |
| `cloudflare` | 需准备：要装 `cloudflared`；**WebSocket 能否 101 未实测**；quick tunnel 域名每次重启都变 | `:114-120`（原文"⚠️ 未实测：官方文档没写 quick tunnel 是否支持 WebSocket"）+ 怎么验：`:292-294`（§6 第 1 条，`wscat` 到 `wss://<host>/api/remote.mux` 看 101） | **未实测** |
| `tailscale` | 需准备：平板侧**没有官方鸿蒙客户端**（相关 issue 被标 not-planned）；**卓易通里的安卓版不可用**（独立 netns，容器内 tun 不覆盖宿主原生浏览器与我们的 App） | `:134-148`（含"官方仓库有用户实测原话"）；`docs/RESEARCH-C-tailscale-harmony.md` §2（issue #12728、华为开发者论坛、ClashBox #113） | 文档（官方 issue + 用户实测原话） |
| `manual` | 可用：只做归一与自检，**不代管监听、也不替你做鉴权** | `:150-156` | 文档 |
| `uu` | 需准备：官方 blog 确认「图形化端口映射」**免费版包含**；**两个待实测**：① 生成的对外入口是域名还是 `host:port`；② 是否透传 WebSocket Upgrade | `:158-209`；官方 blog <https://uuyc.163.com/blog/20261117dewhjg.html>（2026-11-10，抓取 2026-11-18，原文关键句见 `:203-205`）；两待实测点见 `:195-200` | 文档（官方 blog）+ **未实测** |

补充两条：

- 上一版把 `uu` 判成「不可用」是**错的**，错在只核对了官网功能页与帮助中心目录、漏掉官方 blog，
  再用"远控 = 画面串流 → 不可能有网络能力"把空缺补成了否定结论（`docs/REMOTE-ACCESS-OPTIONS.md:322-346`
  的勘误）。这条教训直接支持上面那条纪律：**判定"官方有没有某能力"至少查四类入口**
  （功能页 / 帮助中心 / 官方 blog / 客户端设置页），`uu` 就是漏在第三类。
- 旧判定的残留**只剩文档，代码侧已换新**：`docs/REMOTE-ACCESS-OPTIONS.md:265` 的 §4 表格里还留着
  `uu-unsupported` 那一行（自带「旧判定，已作废」标注）；而 `remote/probe.ts:117` 的 `MODE_READY.uu`
  已经是「UU 远程（图形化端口映射）：入口与 WS 透传待实测」，`PROBE_CHECK_IDS` 也已经是
  `uu-entry` / `uu-reachable` / `uu-ws-upgrade`（`probe.ts:101-103`）。本轮**只报告不改**那张表
  （`docs/REMOTE-ACCESS-OPTIONS.md:338-340` 自己列了"下一轮修"的清单）。

## B.6 不做的事 / 失败隔离

| 不做 | 原因 |
| --- | --- |
| 不改 `remote.json` 9 字段的语义 | 它是契约（`docs/DATA-CONTRACT.md:243-249`），改要两端同改（`docs/REMOTE-ACCESS-OPTIONS.md:214`） |
| 不把"自动挑路"做成自动改配置 | `auto` 只决定**这次打开哪条地址**，不重写 `mode`（设备可能确实一直用局域网） |
| 不做假开关 | `unsupported` 的项必须 disabled + 显式原因，不许点了没反应（`docs/REMOTE-ACCESS-OPTIONS.md:48-49`） |
| 不让远程坏了影响同步 | 远程域与同步域互不影响（`docs/DATA-CONTRACT.md:255-258`） |
| 令牌不进日志 / 错误 / 状态响应 | `docs/REMOTE-ACCESS-OPTIONS.md:269-271`；状态里只有 `tokenSet` / `tokenMasked`（`remote/types.ts:84-89`） |

---

# C. 需要决策的点

| # | 待决策 | 选项 | 影响面 | 我的建议 |
| --- | --- | --- | --- | --- |
| 1 | `auto` 是否进契约 | (a) 加进 `RemoteAccessMode`（`remote/types.ts:21`）→ 必须同步改 App 的 `REMOTE_MODE_ORDER`（`remoteAccess.ts:114-121`）与 `docs/REMOTE-ACCESS-OPTIONS.md` §3 表；(b) 不做 `auto`，只在平板侧做"一键测试 + 一键重连" | 两端类型 + 语义表 | **(a)**，但 `auto` **不落盘成新字段**：`mode: 'auto'` 只是"这次用哪条"的策略，各方式的既有槽位全部保留 |
| 2 | 平板是否引入扫码 | (a) `@kit.ScanKit` + 相机权限 + 真机验证；(b) 不扫码，只粘贴 | 权限、验证成本 | 先 (b)；把 (a) 作为真机验证项排进验证清单再定 |
| 3 | 「最近成功时间」落哪 | `remote.json` 加字段 / 独立 `remote-last-ok.json` / 不落盘 | 契约 vs 状态文件数 | **独立文件**（§B.4 表） |
| 4 | Step 2 是否多花一次 `ls-remote --symref` | 是 / 否（只按 main > master > 唯一 head > main 推导） | 接入多一次网络往返 | 先"否"；按 §A.6 待定 1 的判据再定 |
| 5 | 向导 Step 4 的默认勾选 | 只 `schedules` / 整个日程族（含 summaries + open-index + attachments 联动） | 用户第一屏看到几个勾 | **整族联动**：只勾 `schedules` 会得到"有记录没汇总"的半套 |
| 6 | 首次接入是否浅克隆 | `--depth 1` / 完整克隆 | Step 2 等待时间 | 先完整克隆（改动最小）；按 §A.6 待定 2 的判据再定 |
| 7 | 高级自动展开第 4 条（选 ssh / 自定义平台） | 加 / 不加 | 与 `docs/DATA-CONTRACT.md:403` 的"三种自动展开"相比多一条 | 加，但要在 `docs/UI-DESIGN.md:117` 的同构先例旁补一句，避免两处规则漂移 |


## 附：`auto` 方式的契约边界（Lead 批准 2026-11-18）

> **`auto` 是客户端（平板）侧的解析意图；PC 侧只提供候选清单与逐方式自检结果，不得输出「已解析为 X」。**

- App 侧固定解析顺序：局域网直连 → 公网 IPv6 → 已配置隧道（cloudflare/tailscale 按最近成功时间倒序）→ 手动；
- 全部失败时，给出**每种方式失败原因的汇总**，不是只说"都失败"；
- PC 侧自检里恒 `unknown` 的项（如 `external-reachability`/`firewall-inbound`）**不得**被 `auto` 当成"可用"；
- `remote-last-ok.json` 独立存放运行期观测，**写失败必须吞掉并降级**（只影响"一键重连"，不得让配置保存失败）。
