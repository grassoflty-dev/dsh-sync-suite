# CHAT-SYNC：云端对话模式的存储与并发模型

> 状态：**设计稿（本轮不写实现代码）**，2026-11-18。范围：`chats/` 在用户自建 Git 仓库里的布局、
> 租约（lease）、续接/冲突语义、隐私与分期验收。上位契约见 `docs/DATA-CONTRACT.md`（§1 仓库结构、
> §3 日程 JSONL 与折叠）；会话格式事实来自 `docs/RESEARCH-session-import.md`（下称 **RSI**，工作区根 `docs/`）。
> 一句话：**会话是状态机事件流 → 采用「接管制」，不是「并写制」。**

## 0. 结论（可执行的四条）

1. 同一 `sessionId` 在**同一时刻最多一个写者**——持有 `meta.lease` 的那台设备（`lease.owner`）。
2. 续接 = 抢租约 + 乐观锁（`expectedPrevSha`）；任一校验失败即 **abort（fail-closed）**，绝不合并两段事件流。
3. 上传前必过 `redactSecrets` + 一条静态扫描；`meta.json` 走字段白名单，**禁绝对路径**。
4. 传输只用「快进 + 重试」，**禁** rebase / merge / force push。

## 1. 为什么不能并写（明确拒绝日程模型）

### 1.1 一个具体的坏例子

两边从同一份 40 行事件流分叉（`seq` 是事件序号，见 RSI §3.2）：

| 时刻 | 设备 A（PC） | 设备 B（平板） |
| --- | --- | --- |
| 09:00 | 写到 `seq 40` = `tool/call`（`callId=tc1`，读一个文件） | 拉到 09:00 的 40 行副本 |
| 09:02 | 断网，本地继续把 `tool/result`(tc1) 落成 `seq 41` | 继续对话，模型再发 `tool/call`(`tc2`)，也落 `seq 41` |
| 09:05 | 恢复网络并上传 | 同时上传 |

两端都声明自己拥有 `seq 41`。按日程那套「同 id 取较晚 `ts`」折叠（`docs/DATA-CONTRACT.md:89`、
`packages/dsh-git-config-sync/src/schedule/jsonl.ts:183` `foldById`），`seq 41` 只能留一条：

- 留 B 的 → A 的 `tc1` **结果消失**，调用永久悬空（工具卡片一直转圈）；
- 留 A 的 → B 的 `tc2` 调用被吞，只剩一个找不到调用的结果；
- 若放宽成「两条都留」→ 行序不再等于事件序，重放到 DSH 里出现 `result` 在 `call` 之前的错位。

三种结局都不是「少一条日程」这种可容忍损失，而是**事件流语义损坏**。

### 1.2 为什么日程能折叠、会话不能

| 维度 | 日程记录（`devices/<id>/schedules/*.jsonl`） | 会话事件（`session.jsonl`） |
| --- | --- | --- |
| 单位 | 独立实体，全字段覆盖 | 有序增量，`seq` 严格递增 |
| 冲突语义 | 「较晚的编辑就是最新真相」（`docs/DATA-CONTRACT.md:92-94`） | 同 `seq` 两条 = 两条都不为真 |
| 丢失后果 | 少一次编辑，可手补 | 调用/结果错配，链断了无法手补 |
| 写入者 | 多端并写、读时折叠 | 单写者持有期独占（本设计） |

日程之所以敢并写，是因为记录**自包含且可整体覆盖**；会话事件**只对前缀成立**——第 41 行必须接在
确定的第 40 行之后。所以本设计**拒绝**沿用「多端并写 + `ts` 折叠」。具体拒绝四件事：

- 不按 `ts` 折叠事件行；不做 LRU/后写覆盖；
- 不做行级三方 merge（没有共同祖先语义）；
- 不做后台静默合并（冲突必须让用户看见）；
- 不在同一会话上开两个写者（租约未过期时的第二个写者降级为只读）。

## 2. 数据布局

```
<repo>/
  chats/                      # 跨设备共享命名空间（不是 devices/<id>/）
    <sessionId>/
      meta.json               # 元信息 + 租约（小、常变、不值得放 JSONL）
      session.jsonl           # 明文 JSONL，只追加，行序即事件序
    index.jsonl               # 只追加的列表页索引
```

- **为什么共享命名空间**：会话要能被另一台设备**续接**，写者身份会变；放 `devices/<deviceId>/`
  等于把「谁写的」钉死进路径，接管就得跨目录搬文件（历史随之断）。`devices/` 的语义是
  「一台设备只写自己的目录」（`docs/DATA-CONTRACT.md:28`），与接管制冲突。
- **为什么明文 JSONL**：可 diff/可评审、App 无需 zstd 解帧就能读（`zlib.zstdDecompress` 只在 Node 侧，
  RSI §2.2；ArkTS 侧没有等价的现成解帧能力）、出问题能直接 `git log -p` 定位。压缩留给 Git 的 zlib
  与打包层；代价是要自己守住「只追加 + LF」，见 §6。

### 2.1 `meta.json` 字段表

| 字段 | 类型 | 语义 | 谁写 |
| --- | --- | --- | --- |
| `schemaVersion` | int | 本文件版本，当前 `1`；不兼容变更时必须 +1 | 创建者 |
| `sessionId` | string | 与目录名一致；等于 DSH header 的 `id`（RSI §1.1） | 创建者 |
| `title` | string | 展示标题，来自最后一条 `session/title` 或首条 user 消息降级 | 持有者 |
| `createdAt` | string(ISO) | 首次上传时间，此后不变 | 创建者 |
| `updatedAt` | string(ISO) | 最后一次成功上传时间 | 持有者 |
| `model` | string | 最后使用的 `provider/model` 串，仅用于列表展示 | 持有者 |
| `messageCount` | int | 事件行数（不含 header），列表页排序/摘要用 | 持有者 |
| `sha256` | string | **明文 `session.jsonl` 整文件字节的 sha256**（乐观锁与完整性锚点） | 持有者 |
| `deviceId` | string | 最后写者，匹配 `^[a-z0-9][a-z0-9-]{0,31}$`（同 `docs/DATA-CONTRACT.md:30`） | 持有者 |
| `workspaceName` | string | workspace 的**末段名**（如 `itwillclaude`），**只允许名字** | 创建者 |
| `lease` | object | 见 2.2；无租约时整个字段省略或 `null` | 持有者 |

**禁止字段**：`cwd` 及其它绝对路径、`path`、用户名、provider 凭据。`workspaceName` 取
`basename(realpath(cwd))`，跨机导入时由接收端自己重算 `cwd`（RSI §4.5 已证 slug/cwd 是硬绑定，见 §8 P2）。

### 2.2 `lease` 语义

```json
"lease": { "owner": "pc-a", "since": "2026-11-18T05:20:11Z",
           "exp": "2026-11-18T05:30:11Z", "beatAt": "2026-11-18T05:21:02Z" }
```

| 规则 | 取值 | 说明 |
| --- | --- | --- |
| TTL | **10 分钟** | 无心跳即过期；`exp = beatAt + 10min` |
| 心跳间隔 | **60s** | 每 60s 提交一次 `beatAt` 顺延，产生一个微小 commit |
| 不变式 | `since ≤ beatAt < exp` | 三个时间都由 owner 用**本机时钟**写，故跨机只做区间比较 |
| 释放 | 正常退出把 `exp` 设为 `now` | 属「可选优化」；不释放只会浪费 10 分钟，不会丢数据 |
| 只写者 | `owner == 本机 deviceId` 才可写 | 否则一切写操作（含 `index.jsonl`）拒绝 |

租约**不是锁**，是「谁现在在用」的公告：它靠时钟，因此只用于**降低**并发概率；真正的一致性
由 `sha256` 乐观锁（§3 步骤 4/6）保证。租约过期不清不会被当成错误，只被当成「可接管」。

### 2.3 `session.jsonl`

- 明文、**只追加**、行序即事件序；首行是 DSH 的 header（`type:"session"`、`version:4`，RSI §3.1）。
- 写入方不得重排、去重、格式化、补 `seq`；每行以 `\n` 结尾，**最后一行必须完整**（半行即视为尾撕裂，拒绝上传）。
- 追加后立刻重算整文件 `sha256`，与 `messageCount` 一起写入 `meta.json` 与 `index.jsonl`。

### 2.4 `index.jsonl`

一行一个投影：`{"id","title","updatedAt","messageCount","sha256"}`，**只追加**。

- 列表页只读这个文件：**按 `id` 取最新一行**（唯一允许「取最新」的地方——它是展示投影，不是事件流；
  事件流本身永远不折叠）。
- 任何一端都可以追加自己的投影行；读侧按 `updatedAt` 取最大者，不关心行序。
- 允许缺省：`index.jsonl` 缺失或落后时，列表页退化为扫描 `chats/*/meta.json`（慢但等价）。

## 3. 续接（接管）流程

编号步骤，任一步失败即停在该步并向用户报告（不自动重试跨过校验）：

1. **拉取远端**：`git fetch` + `pull --ff-only`（见 §6）。网络失败 → 停在此步。
2. **校验尾巴**：读远端 `meta.sha256`，与本机**上次成功上传时记录的尾巴 sha**比较。
   不等 → **拒绝续接**，提示「另一台设备有更新，先拉取」。本机记录存
   `~/.dsh/storages/chat-sync/<sessionId>.json`（本机、不进 repo）。
3. **检查租约**：`lease.exp > now` 且 `lease.owner != 本机` → 进入**只读浏览**（§5），
   UI 明示「此会话正在 `pc-b` 上使用（心跳 12:03）」。
4. **抢租约**：写 `owner/since/exp/beatAt` 并提交，携带 `expectedPrevSha = 远端 meta.sha256`；
   **提交前重读远端 meta**，sha 不符则 abort（乐观锁）。
5. **继续写本地 `session.jsonl`**：进入 `HELD`，每 60s 心跳（顺延 `exp`），并定期追赶上传。
6. **上传**：`session.jsonl` + `meta.json` + `index.jsonl` 一次提交，同样带 `expectedPrevSha`；
   不匹配 → abort，回到步骤 1（**不合并**，由用户决定是否重试）。
7. **释放租约（可选）**：正常退出时把 `exp` 设为 `now` 并提交；异常退出交给 TTL。

### 3.1 租约状态机（4 个状态）

`FREE`（远端无有效租约）—`claim`→ `CLAIMING`（本机乐观锁提交中）—成功→ `HELD`（本机唯一写者）；
`claim` 失败（`expectedPrevSha` 不符或他人先到）→ `OBSERVING`（只读）。

```
                 claim 成功（sha 命中）
   ┌────────┐ ────────────────────────► ┌─────────┐ ──心跳/上传（exp 顺延）──┐
   │  FREE  │                            │  HELD   │ ◄──────────────────────┘
   └────────┘ ◄──────────────────────── └─────────┘
        │        release（exp=now）/ TTL 过期     │ 在我持有期间发现他人写入
        │ claim                                   │ （sha 不符）→ 立即降级
        ▼                                         ▼
   ┌──────────┐   claim 失败 / 他人 exp 未过   ┌────────────┐
   │ CLAIMING │ ────────────────────────────► │ OBSERVING  │ ──对方 exp 过期──► 可 claim
   └──────────┘                                └────────────┘
        │ 提交成功                                    ▲
        └──────────────► HELD                          │
                                    FREE（远端无租约）──┘
```

| 状态 | 本机可写仓库？ | 用户可见标记 |
| --- | --- | --- |
| `FREE` | 仅抢租约成功后 | 无（可接管） |
| `CLAIMING` | 否（只允许那一次提交） | 「正在接管…」 |
| `HELD` | 是（唯一写者） | 「本机正在使用」+ 心跳时间 |
| `OBSERVING` | **否**（一个字节都不写） | 「此会话正在 `<deviceId>` 上使用」+ 心跳 |

## 4. 冲突与失败语义

原则：**fail-closed**——宁可拒绝续接，也不合并两段流；宁可让用户多点一次，也不静默覆盖。

| 情形 | 停在哪一步 | 用户看到什么 | 会丢数据吗 | 处置 |
| --- | --- | --- | --- | --- |
| `sha` 不匹配 | 步骤 2 或 4/6 | 「另一台设备有更新，先拉取」+ 两个 sha 前 8 位 | 否（本地文件原样保留） | 拉取后重走流程；本地新行仍在本地文件里 |
| 租约未过期、owner≠我 | 步骤 3 | 「正在 `<deviceId>` 上使用（心跳 12:03）」 | 否 | 只读浏览；等 TTL 或对方释放 |
| 租约过期未清理（stale） | 步骤 3→4 | 「`<deviceId>` 已 14 分钟无心跳，可接管」 | 否 | 允许接管；接管提交即覆盖 `lease` |
| 上传非快进（409/`nonFastForward`） | 步骤 6 | 「远端已变，已中止本次上传」 | 否（未提交即未发布） | 重拉 + 回到步骤 1，**不 rebase** |
| 网络断 | 步骤 1 或 6 | 「网络中断，已停止（本地内容已保存）」 | 否 | 恢复后从步骤 1 重来；`HELD` 期间照常本地落盘 |
| 两端时钟偏差（`exp` 判定不一致） | 步骤 3/4 | 「租约状态无法确认」 | 否 | 以远端 `meta` 为唯一事实；偏保守→按「未过期」处理（只读） |
| 心跳丢失但仍在写 | 步骤 6 前 | 「租约已过期，本次上传前需重新抢租」 | 否 | 重新 claim（`expectedPrevSha` 仍生效） |
| 本地 JSONL 尾行撕裂 | 上传前自检 | 「会话文件尾部不完整，已停止上传」 | 否（已上传版本完好） | 丢弃未完整行后重试 |

> 反例（明确不做）：sha 不匹配时「自动三方合并」「以本地为准强推」「丢弃远端尾巴继续写」——三者都会
> 制造 §1.1 的坏结局。

## 5. 只读浏览

别的设备打开一个别人正在用的会话时：

- **不取租约、不写任何文件**：不写 `meta.json`、不写 `session.jsonl`、**不写 `index.jsonl`**，
  连本地缓存也只在 `~/.dsh/storages/chat-sync-cache/`（可重建、不进 repo）。
- UI 标记 owner 与 `beatAt`：标题栏右侧显示「🔒 `<deviceId>` · 12:03」，输入框禁用并给出「接管」按钮。
- `beatAt` 超过 3×TTL（30 分钟）无更新 → 标签降级为「可能已释放」，仍不自动夺取；用户点「接管」才进 `CLAIMING`。
- 只读浏览**允许**的副作用：`git fetch`（只读远端，不动工作树内容）。
- 只读页显示的是**远端已发布版本**，与本机未发布的本地尾巴无关——不提供「本地草稿叠加预览」，避免读者
  以为那是权威历史。

## 6. 与 Git 的交互

- **只用快进 + 重试**：上传前 `git fetch` + `git pull --ff-only`（等价 `merge --ff-only`）；失败即 abort，
  不做 `rebase`、不做 `merge` 提交、永不 `--force`。理由：rebase 会把本机提交改写到别人提交之上，
  失败后 `--abort` 会让本机这段事件流「消失」在用户视角；而对事件流，「消失」等于数据丢失。
- **不要复用既有插件路径**：`packages/dsh-git-config-sync/src/engine/git.ts:643 pushWithRebase()`
  内部调 `pullRebase()`（同文件 `:548`，出错 `rebase --abort`）。该策略服务于 `devices/` 快照，
  `chats/` 必须走独立的 ff-only 通道，并复用其错误分类（`:207 isNonFastForward`）。
  App 侧已有同向先例：`apps/arkui-schedule/entry/src/main/resources/rawfile/git/git-bridge.js` 的
  `pull`/`push` 均传 `fastForwardOnly: true`（本工作副本 `:1513`/`:1570`；`docs/ROADMAP.md:110-111`
  引的是另一份拷贝的 `:1301`/`:1349`，代码同源）。
- **提交粒度**：一次上传 = 一个 commit，只 `add` 本会话目录 + `index.jsonl`；message 形如
  `chats: <sessionId> +N events (sha=<前8位>)`。不混提其它会话，便于 `git revert` 定位。
- **冲突面最小化**：`chats/index.jsonl` 是唯一的共享追加文件，两端同时追加会产生文本冲突——因此
  **只在 `HELD` 状态下追加**，且上传前先 ff-only 拉到最新（自己那段 append 永远接在最新行之后）。
- **`.gitattributes` 建议**（追加到仓库根）：

  ```gitattributes
  *.jsonl text eol=lf
  *.json  text eol=lf
  ```
  CRLF 会改变 `sha256` 与 diff 行为（`discardChangesOutside` 已吃过一次 clone 换行的亏，
  `packages/dsh-git-config-sync/src/engine/git.ts:573-577` 注释），`chats/` 下必须是 LF 字节。

## 7. 隐私

**调用点（三处，缺一不可）**：

1. **上传前**（写 `session.jsonl` 之前）：对每行文本过 `redactSecrets()`（App 侧实现在
   `apps/arkui-schedule/entry/src/main/ets/model/syncError.ts:84`），命中 `sk-`/`Bearer`/`Basic`/`token=`
   `/`api_key=`/`apiKey:"` 的片段整体替换为 `***`；
2. **写 `meta.json` 前**：只按 §2.1 白名单挑字段（结构化脱敏，递归 key 版本见
   `packages/dsh-git-config-sync/src/engine/secrets.ts:226 stripSecretsDeep`，词边界判定
   `:20 SECRET_KEY_RE`，避免把 `maxTokens` 误伤，见 `docs/DATA-CONTRACT.md:43-44`）；
3. **提交前静态扫描**（fail-closed，命中即拒传并报行号）：

   | 规则 | 命中即拒 |
   | --- | --- |
   | `sk-[A-Za-z0-9]{8,}` | 疑似 API key |
   | `Bearer\s+\S+` | 凭据头 |
   | `api[_-]?key` / `token=` / `secret` | 键名残留 |
   | `C:\\\\Users\\\\` / `/home/[^/]+/` | 绝对路径/用户名泄漏 |
   | `\\\\Users\\\\` / `file://` | UNC 路径 |

- **禁止上传**：`.env`、`*.key`、`*.pem`、任何 `api key/token` 原文；附件二进制一律不上传（内容寻址对象
  属本机，RSI §5.7）。
- **事件流里的路径**：`tool` 入参/输出中的绝对路径统一替换为 `<WORKSPACE>`，原值**不**写进 `meta.json`
  （与 RSI §6.2 的取舍一致）；命令输出保留，但同样过 `redactSecrets`。
- `meta.json` **不得**含 `cwd`：`workspaceName` 只允许末段名，避免把 `C:\Users\<用户名>` 带进公开仓库。

## 8. P1 / P2 / P3 分期与验收

| 期 | 范围 | 依赖 | 可观测验收现象 |
| --- | --- | --- | --- |
| **P1** | 上传 + 只读查看（App 列表/详情） | 本文 + RSI §2/§6.2 | ① 上传后 `chats/<id>/session.jsonl` 行数 = 本地事件数；② `meta.sha256` 与 `sha256sum session.jsonl` 一致；③ 平板列表出现该会话、详情能读全量（无需 zstd 解帧）；④ 上传前后 `git log --oneline -1` 各增 1 条且只含本会话文件；⑤ 静态扫描命中用例（塞一行 `sk-…`）必须**拒传**并给出提示 |
| **P2** | 导入回 DSH | `docs/RESEARCH-session-import.md`（§1.1 slug、§6.1 伪代码、§6.3 验收） | ① 写成 `~/.dsh/sessions/<projectKey(cwd)>/<encodeSegment(id)>/session.v4.jsonl.zstd`；② header `version=4`、`type=session`；③ **`cwd` 指向本机已存在目录**，否则侧栏不出现（RSI §4.5）；④ `scanZstdFrames` 全帧完整、无 torn tail；⑤ 重启后侧栏该项目下出现会话，点开历史完整、无 corrupt 报错；⑥ 已存在同 id 则跳过（不覆盖，RSI §6.1 第 4 步） |
| **P3** | 纯对话 preset（工具隔离） | `docs/RESEARCH-chat-preset.md`（**待产出，本轮未落盘**） | ① preset 启用的会话事件流只含对话类 `type`；② 上传到 `chats/` 的明文里**无**工具事件（可用「事件类型白名单」断言）；③ 切回普通 preset 后工具调用恢复 |

分期边界：P1 只**上传 + 读**，不碰 `~/.dsh`；P2 才写 `~/.dsh/sessions/`（且必须 DSH 未打开该会话，
RSI §5.3）；P3 只改 preset，不动存储格式。

## 9. 待评审的安全边界

1. **租约靠时钟**：`exp` 由 owner 本机时钟写，时钟回拨/快进会让租约提前失效或长期占用；恶意端可写一个
   十年后的 `exp` 把会话锁死（可人工改仓库恢复，但会误导用户）。
2. **sha 可伪造**：`meta.sha256` 由写入方自报，恶意端可提交与 `session.jsonl` 不符的 sha 让另一端永远
   「校验不过」（拒绝服务），也可提交合法 sha 但内容被篡改过的流（无签名）。
3. **跨机 `cwd` 改写导致会话分裂**：P2 导入时若两台机器用不同 `cwd` 各导入一次，DSH 会按各自 slug
   物化成两份（RSI §4.5「双胞胎」），而 `chats/<id>` 只有一份——需要明确「一个 id 只允许在一台机器上
   绑一次 cwd」还是接受多份副本。
4. **明文会话被 push**：会话含代码片段、命令输出、内部 URL；一旦推到远端仓库（哪怕是私有），历史里
   永久留存，`git revert` 也删不掉 blob。是否要「敏感会话默认不上传 / 上传前逐条确认」需产品决策。
5. **只读端的内存缓存**：`~/.dsh/storages/chat-sync-cache/` 会存明文会话副本；多用户共用一台机器时
   需要有清理/加密策略（当前只做「可重建、不进 repo」）。

---

*本文件只写设计，不含实现；实现落点预计为插件侧 `packages/dsh-git-config-sync/src/chats/`（P1）与
App 侧 `entry/src/main/ets/model/chats/`（P1 只读）。*

---

## 安全边界：chat preset 与工具隔离

> 本节补在 P3（纯对话 preset）实现之后，2026-11-18。代码落点
> `packages/dsh-git-config-sync/src/chatPreset/**`，声明落点
> `packages/dsh-git-config-sync/cordis.patch.yml`（第二个 `insert:` 块）。
>
> **同日二次裁决（Lead）**：旧版「58 项手写 deny 名单」**已删除**，改为
> **运行期反算 + 白名单断言（fail-closed）**。理由是"把黑名单写死"在插件生态里必然失败：
> 工具在运行期注册，数量与名字都不稳定（详见 §4）。本节已按新实现改写；旧版里
> "接线前必须解决的两个 deny 时序问题"随之一并消解（不再是待决策项）。

### 1. 「云端对话模式」的定义

**云端对话模式 = 显式 `agentPreset: 'chat'` 的会话**，不是"把全局默认 preset 改成 chat"。

- preset 定义 id `chat`，Loader 行 id `preset-chat`（`src/chatPreset/ids.ts`）；
- 会话身份记在 header 首行的 `agentPreset` 字段（`docs/RESEARCH-chat-preset.md` §5.1），
  恢复时读 `agentPreset` 投影，所以"这条会话是不是纯对话模式"永远可以从会话本身查证；
- `agent-preset-registry` 的 `config.default` **保持 `standard` 不变**（Lead 决策）：
  新建会话没显式选 chat，就仍然是带 `pwsh`/`read`/`write` 的 standard。这是**有意的取舍**，
  不是缺口；配套约束在出口侧——只有显式 chat 的会话才允许被上传进 `chats/`（导出准入，P3 二期接线）。

### 2. 隔离的语义（Lead 原话，评审时不要改写）

> **chat 模式不接触本机文件系统 / 不执行本机命令 / 不读取本机环境。**

注意这条判据是"能不能碰本机"，**不是**"有没有副作用"：`todo_write` 有副作用（写计划），但它只写
**会话内**的计划（会话本来就要上传 `chats/`），既不碰本机文件系统、也不执行本机命令、更不读本机
环境；`ask_user_question` 只向用户提问，连持久化都没有。所以这两个留在白名单里。
反过来，`bcdp_screenshot` 看着"只是截图"，但它把文件落盘、还能借浏览器读登录态——按判据必须禁。
**不要把这条边界简化成"零副作用"或"没有任何工具"**，那会把两个真正安全的工具误杀，
也会让评审以为我们在做一件做不到的事。

### 3. 隔离靠两件事，缺一不可

| 层 | 手段 | 覆盖 | 证据 |
| --- | --- | --- | --- |
| **结构性缺席** | chat preset 的 `plugins` 只列 persona + compaction，**不列任何 `tool-*`** | Web 面内置工具（read/write/edit/glob/grep/bash/pwsh/job_*/skill/present/subagent/office…） | `<ASAR>/dsh-web-app/cordis.patch.yml:497-611` 已把内置工具行在 Host 层 `disabled: true`，"由每个会话自己挂 preset"；不列 = 不注册 = schema 不存在 |
| **运行期反算 + 白名单断言** | agent 作用域 `ctx.tools.restrict({ deny })`，`deny = 当前已注册的全部工具 − 纯对话白名单`，遮蔽后**再枚举可见集**做断言 | **第三方 Host 插件注册的全局工具**（`bcdp_*` 35 个、`codex_*`/`chatgpt_connectors_*` 7 个、本插件的 `schedule_*`/`dsh_dots` 4 个）以及**将来任何新插件** | 这些工具在全局层注册，任何 preset 的 agent 都继承，preset 摘不掉（`docs/RESEARCH-chat-preset.md` §3.2）；`restrict` 是唯一遮蔽手段（`<ASAR>/dsh-tools/src/index.ts:162-189`） |

**为什么 deny 是必需的**：如果只做第一层，chat 会话的模型依然能调 `schedule_add`（写本机日程并 push）、
`dsh_dots`（读本机状态）、`bcdp_navigate`/`bcdp_cdp`（完全控制真实浏览器）、`bcdp_download`（下载落盘）——
"纯对话"不成立。deny 不再是源码里的名单，而是运行期反算出来的：**白名单是输入**
（`src/chatPreset/allow.ts` 的 `CHAT_ALLOW_TOOLS`），**deny 是输出**（`src/chatPreset/isolate.ts` 的
`computeDeny`）。

### 4. 为什么"把黑名单写死"必然失败（这一版改掉的东西）

旧实现是 58 项手写 deny，真接线会当场炸，三条事实同时成立：

1. **这些名字在 chat 会话里根本没注册**：chat preset 不挂 `tool-*`，所以 `read`/`write`/`edit`/
   `glob`/`grep`/`bash`/`pwsh`/`job_*` 从来不存在 → `restrict` 判 unknown 并抛错；
2. **名字是否注册不稳定**：`bcdp_*` 除 `bcdp_status` 外按分级 + 活动闸**惰性注册**（`NM/dsh-browser-cdp/lib/index.js:6518-6562`），
   `codex_*`/`chatgpt_connectors_*`/`codex_sketch`/`end_voice_call` 按设置/模型/连接器/通话状态开关
   （`NM/dsh-codex-subscription/lib/index.js`）→ 同一份名单在不同机器、不同时刻的"合法与否"都不一样；
3. **新装插件必然漏**：任何人装一个新插件注册一个新工具，旧名单都不知道它 → 隔离静默失效，
   而用户以为"我开了纯对话模式"。

`restrict` 的硬约束（`<ASAR>/dsh-tools/src/index.ts:179-183`）是"只认**当前已注册**的名字，写错就抛"，
所以"名单"这条路在插件生态里没有解：写全了会炸，写不全就漏。**唯一正确的方向是反算**——
`deny = 已注册 − 白名单`，新工具默认落 deny，未注册的名字不可能进 deny。

### 5. 三步流程与失败语义（fail-closed，一律拒绝创建会话）

`installChatToolDeny(ctx, options?)`（`src/chatPreset/isolate.ts`）按顺序做三件事：

| 步 | 动作 | 失败时 |
| --- | --- | --- |
| 1 | **取注册表**（当前已注册工具名）：`options.listRegistered` → `tools.listRegistered()` → agent 作用域的 `definitions`/`schemas` → 全局视图兜底 | 取不到 / 读取抛错 / 形态不对 → `E_CHAT_TOOLS_NOT_ISOLATED`，**绝不**退化成静态名单（把"未知"当成"安全"是最坏的 fail-open） |
| 2 | **反算并遮蔽**：`computeDeny(registered, allow)` → `ctx.tools.restrict({ deny })` | 宿主没有 `restrict`、或 `restrict` 抛错 → 内部错误 `E_CHAT_DENY_FAILED` + 打日志，按 fail-closed 拒绝 |
| 3 | **再枚举 + 白名单断言**：重新取 agent 作用域的可见集 → `assertIsolated(visible, allow)` | 可见集多出任何非白名单工具 → `E_CHAT_TOOLS_NOT_ISOLATED`，message 形如 `云端对话模式没能隔离工具：多出 a, b, c` |

两条补充语义：

- **第 3 步不可省**：`restrict` 调用成功 ≠ 遮蔽生效（可能算 deny 时与调用时注册表变了，也可能可见视图
  不认这层掩码）。只信"事后看见什么"，这一步才叫 fail-closed。
- **白名单未注册不算失败**：`ask_user_question`/`todo_write` 在当前 preset 里没挂载时，它们只是
  `missing`（能力少了，方向安全），不抛错。`assertIsolated` 的 `ok` **只看 `extra`**。

### 6. 错误码与 RPC 自检

- `E_CHAT_TOOLS_NOT_ISOLATED` 是**正式安全边界错误码**，已进 `docs/DATA-CONTRACT.md` §2.3；语义 = 拒绝创建
  chat 会话（不是"降级运行"）。
- `E_CHAT_DENY_FAILED` 是**内部防御性错误**（宿主契约不满足 / `restrict` 抛错），只用于定位，
  **不进公共错误码表**。
- RPC `chatPresetInfo`（`POST /dsh-git-config-sync/rpc`，`{action:"chatPresetInfo"}`）返回
  `{presetId, allow, rationale, registeredCount?, denyCount?}`——**不再返回静态名单**；`registeredCount`/
  `denyCount` 只在调用方带注册表时出现（RPC 侧没有运行期注册表，故省略）。设置页拿它展示白名单与
  逐条理由，诊断脚本可以带上本机注册表算出"这次会 deny 多少条"。
- 证据表 `src/chatPreset/deny.ts` 的 `KNOWN_*` / `*_TOOL_SOURCES` **仍然保留**，但只作**说明用**
  （解释"哪些工具、为什么碰本机"，供评审与升级核对）；**任何代码都不得把它们当 deny 输入**，
  测试也不再用它们参与反算。

### 7. 现状与接线（P3 一期 / 二期）

| 项 | 一期（本轮，已完成） | 二期（未做） |
| --- | --- | --- |
| preset 声明 | `cordis.patch.yml` 第二个 `insert:` 块（`preset-chat`），**保持不变** | — |
| 白名单 + 反算 + 断言 | `src/chatPreset/allow.ts` + `src/chatPreset/isolate.ts`（`computeDeny`/`assertIsolated`/`installChatToolDeny`） | 按产品语义增删白名单（改动只碰 `allow.ts` 与理由） |
| 安装函数 | `installChatToolDeny(ctx, options?)` 存在且单测覆盖（假 `ctx.tools`，5 类失败情形） | 在 chat 会话的 agent 装配路径里调用（**不在 `src/index.ts` 自动安装**，否则会关掉标准会话的工具）；调用点必须能给出 agent 作用域对象 |
| 自检 | RPC `chatPresetInfo`（白名单 + 理由 + 可选计数） | UI 上展示白名单与理由；诊断脚本带注册表算 deny 条数 |

### 8. 复核方法（升级 DSH 或插件后照做）

```powershell
# 1) 第三方全局工具：谁在 Host 层注册工具
Select-String -Path C:\Users\GWL\.dsh\profiles\desktop\node_modules\dsh-*\lib\index.js -Pattern 'tools\.register'
# 2) 逐名核对（bcdp_ 分级表 / codex_ 工具名常量）——只用于更新"仅说明用"的证据表
Select-String -Path C:\Users\GWL\.dsh\profiles\desktop\node_modules\dsh-browser-cdp\lib\index.js -Pattern 'bcdp_[a-z_]+'
# 3) 内置工具名（asar 内只能用 Host 的 read 工具读）
#    <ASAR>/dsh-tool-fs/src/index.ts:2,28-37 / dsh-tool-fs-search:2-3 / dsh-tool-jobs:2 / dsh-tool-bash:2 / dsh-tool-pwsh:2
# 4) 改完跑：node --test test\chat-preset.test.mjs（反算/断言/五类失败语义）
```

复核重点变了：**不再核对"名单对不对"，而是核对反算与断言有没有被绕过**（例如有人把
`installChatToolDeny` 的失败 catch 掉、或把可见集断言删了）。证据表只用来解释"为什么禁"。

---

## 实现注记（P1）

> 2026-11-18 补记。本节只记**已落地的事实**与真实偏差，不改前面任何设计条款；行文中的「本轮」= P1 插件侧。
> 代码落点 `packages/dsh-git-config-sync/src/chats/`（`types.ts` / `readSessions.ts` / `exportChats.ts` / `index.ts`），
> RPC 三个 action 追加在 `packages/dsh-git-config-sync/src/rpc.ts`（只加，未改既有 action 一行），
> 测试 `packages/dsh-git-config-sync/test/chats-export.test.mjs`（33 个用例 / 178 条断言，全部用临时目录 + 现造 zstd 帧）。

### 1. 真实 API（这些是**现在存在**的导出，不是设想）

| 文件 | 导出 | 契约 |
| --- | --- | --- |
| `readSessions.ts` | `splitZstdFrames(buffer)` | 纯函数。`{frames:[{offset,length,end}], truncated, garbageBytes, remainderBytes}` |
| | `frameByteLength(buffer, at)` | 按 RFC 8878 走完一帧的字节数；截断/非法（reserved bit、Block_Type=3）返回 `null` |
| | `classifyEvents(lines)` | 纯函数。`{header, headerLine, events, badLines, badLineNumbers, types}` |
| | `listLocalSessions({sessionsRoot?, homeDir?})` | 扫 `<root>/<slug>/<id>/session.v4.jsonl.zstd` 两层，按 mtime 降序 |
| | `readSessionEvents(file)` | `{header, events, rawJsonl, lines, badLines, badLineNumbers, truncated, frameCount}`，**不抛** |
| | `latestTitleOf` / `firstUserTextOf` / `modelOf` / `countMessages` / `eventText` | 事件级派生（meta 用） |
| `exportChats.ts` | `buildChatExport(info, session, {deviceId, now?, title?})` | 纯函数。`{dir, id, meta, jsonl}`；不合规一律抛 `ChatExportError(code)` |
| | `uploadChats(repo, exports, {now?, push?})` | `repo` 是 `ChatGitRepoLike`（`dir` / `ensureWorkTree?` / `commitAll` / `pushWithRebase`），真实 `GitRepo` 结构上满足它 |
| | `readChatIndex(workDir)` | `{entries, exported, lastExportAt, badLines}`，按 id 取最新一行（§2.4 唯一允许"取最新"的地方） |
| | `redactSecrets` / `scrubAbsolutePaths(Deep)` / `scanForLeaks` / `sanitizeChatReason` | 三层隐私 + 原因清洗 |
| `index.ts` | `readChatExportStatus({workDir?, homeDir?, sessionsRoot?})` | status（不联网） |
| | `exportChatsToRepo({repo, deviceId, limit?, sessionIds?, ...})` | 编排：逐会话结果 + 汇总；单会话失败**不抛** |
| `src/rpc.ts` | `chatExportStatus` / `chatExportAll` / `chatExportOne` | 全部走既有 `enqueue` 串行队列 |

**一处必须记下的偏差**：`redactSecrets()` 在**本插件里原本不存在**。本轮禁止修改 `src/engine/**`，
而 `src/engine/secrets.ts` 只有结构化的 `stripSecretsDeep`（按 **key** 脱敏，不是按文本片段）。
因此 `exportChats.ts` 里**逐字复刻**了 App 侧 `apps/arkui-schedule/entry/src/main/ets/model/syncError.ts:61-98`
的 `SECRET_PATTERNS` 与替换语义（无捕获组的规则如 `sk-…` / `ghp_…` 整体替换成 `***`）。两份规则集必须同步演进。

### 2. 具体写法（只记 §2 没规定的细节）

| 项 | 实现 |
| --- | --- |
| `chats/<id>/session.jsonl` | 每行 `JSON.stringify` 的紧凑单行（**键序不变**）+ 末尾 `\n`（LF）。这是路径递归替换必须 `parse` 一次的代价，也是与"字节级原样搬运"的唯一差异 |
| `chats/<id>/meta.json` | 2 空格缩进 + 结尾 `\n`；字段顺序按 §2.1 表；`model` 解不出时**整个省略**；同 id 二次导出**保留旧 `createdAt`** |
| `chats/index.jsonl` | `appendFile` 真追加，**从不重写**；上一行没有 `\n` 时才先补一个。一行固定 5 个字段（`id/title/updatedAt/messageCount/sha256`） |
| commit | 每个会话一个 commit，message = `chats: export <id> (n msgs)`（n = user+assistant）；`onlyPath: 'chats'` |
| push | 写完本批全部会话后调用一次 `pushWithRebase()`（复用既有实现：非快进先 fetch+rebase，永不 force）。失败 → `{ok:false, reason}`，**已写文件与本地提交一律保留**，下次重试 |
| 租约 | P1 恒为 `lease: null`：不写心跳、不抢租约、不做 `expectedPrevSha`（§3 全套留到 P2/P3） |
| `limit` | `chatExportAll` 默认 50、硬上限 200（`normalizeLimit`：非正数/非数字 → 50） |
| 状态 | `chatExportStatus` 只扫本机目录 + 读工作副本 `chats/index.jsonl`；未配置仓库时 `exported=0 / lastExportAt=''`，**不报错** |
| 日志/错误 | 逐会话原因只用码：`bad-jsonl` / `truncated-session` / `missing-header` / `empty-session` / `bad-session-id` / `path-leak` / `not-found` / `write-failed: …` / `push-failed: …`；跨层的 `sanitizeChatReason()` 统一打码 + 路径替换 + 截断 200 字，**永不出现正文** |

### 3. 已知限制（P1 明确的取舍，不是 bug）

1. **整会话跳过，不做"截掉坏尾巴再传"**：§4 表格对"尾行撕裂"的处置是"丢弃未完整行后重试"，P1 选择更保守的
   整会话 fail-closed（`truncated-session`）。原因：无法区分"尾巴还没写完"和"尾巴被截断"，
   传一半的事件流比不传更难排查。将来可加显式参数 `allowTornTail`。
2. **路径替换是文本级的、不可逆**：会话正文里**讨论** `C:\…` 也会变成 `<redacted-path>`；
   P2 导入时不可能还原原 `cwd`——这本来也是 §2.1 的硬要求（禁 `cwd`），但会让"跨机续聊"需要用户重选 workspace。
3. **复用 `pushWithRebase()` 而非 §6 要求的独立 ff-only 通道**：与 `devices/` 共用一个工作副本，多一条通道对同一个
   `.git` 无并发收益；代价是 push 非快进时可能已发生一次 `pull --rebase`，把**未推送**的 `chats/` 本地提交改写成新 sha。
   文件内容（含 `sha256`）不变，但 `git revert` 要按 commit message 而不是 sha 定位。
4. **`meta.messageCount` 按本轮规格是 user+assistant 计数**，与 §2.1 表格写的"事件行数（不含 header）"**不一致**。
   当前实现 = `countMessages()`（user+assistant）。若坚持 §2.1 的定义，改成 `事件行数` 即可，但列表页摘要语义会变。
5. **只认 `session.v4.jsonl.zstd`**：旧版 `session.jsonl.zstd` / `session.v3.jsonl.zstd` 不会被扫到（P1 不做历史格式迁移）。
6. **没有 UI**：本轮只交付 RPC；App 侧列表/详情并行开发中。`chats/` 的租约/乐观锁/只读浏览标记全部未实现。
7. **`chatExportStatus` 的 `pending` 用目录名比 id**：本机会话 id 取自目录名，与 header 的 `id` 在合法文件上相等；
   若某文件 header id 与目录名不一致，`pending` 可能误记（导出时以 header id 为准，`buildChatExport` 内已断言路径安全）。
