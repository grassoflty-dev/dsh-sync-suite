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
