# 同步范围类型注册表（SYNC-SCOPES）

> 状态：**设计稿**（2026-11-18）。本轮只写文档：不含实现代码、不改源码 / 测试 / 配置、不 commit。
> 上位契约：`docs/DATA-CONTRACT.md` §1（仓库布局）、§3（日程 JSONL）、§4bis（`open.jsonl`）、
> §4ter（附件 zip）、§6（应用侧布局）、§6.1（设备指纹）、§10（`chats/`）、§11（`devices/registry.jsonl`）；
> 并发语义：`docs/CHAT-SYNC.md`；导出 / 导入边界：`docs/EXPORT-IMPORT.md`。
>
> 一句话：把「什么数据跨设备同步」从**代码里的两套硬编码**改成**一份加载时强校验的类型注册表**——
> 每种类型必须显式声明 6 项，缺任一项就**拒绝该类型接入**。

## 0. 结论（六条）

1. 注册表是一份类型声明数组；**加载时逐项校验 6 个声明项**，缺任一项 → `E_SCOPE_DECLARATION_MISSING`
   + **丢弃该类型**（不阻断其它类型加载，见 §6）。
2. 合并策略**强制三选一**、没有默认值：`per-device-union` / `shared-single-writer` / `config-merge`（§2）。
3. 现有两类必须先按本表填满、作为参照实现：日程系 = **4 个 type**（§3）、`chats` = **1 个 type**（§4）。
   填不满是**文档债**，不允许以"先接进来再补声明"落地。
4. 「密钥永外传 = 否」要落成**逐字段清单**，不是"递归 key 匹配 + 兜底"（§3.3 / §4.3）。
5. 候选新类型优先级：**每日摘要 > 插件清单与版本 > DSH 配置 > AI 供应商与模型设置 > 附件索引 > 模板**
   （排序规则见 §5.0）。
6. 最危险的一个新类型是 **AI 供应商与模型设置**：两条独立风险叠加（密钥外传 + "模型偏好本质是全局单选"），
   见 §5.4。

## 1. 为什么必须是「注册表」

### 1.1 今天的两套硬编码（外加仓库侧第三套）

| 侧 | 位置 | 硬编码了什么 | 缺口 |
| --- | --- | --- | --- |
| App | `apps/arkui-schedule/entry/src/main/ets/model/syncScope.ts:16`（`DEVICE_ID_PATTERN`）、`:94-107`（`filterPathsForDevice`）、`:113-122`（`assertWithinDevice`） | 只校验「提交路径落在 `devices/<self>/` 内」，**不校验类型**；`devices/<self>/` 下任何东西都自动在范围内 | 没有"类型"概念，`summaries/`、`open.jsonl`、`attachments/` 全靠"递归 add 整个设备目录"顺带同步（`docs/ROADMAP.md:13` 记明这一点） |
| 插件 | `packages/dsh-git-config-sync/src/engine/types.ts:9`（`SyncFileName` 四文件）、`:17-22`（`SyncScope` 四布尔）、`engine/collect.ts:28`（`SYNC_FILE_NAMES`） | 只认 `cordis.patch.yml` / `providers.json` / `plugins.json` / `mcp.json` | 新增一类数据要同时改类型、collect、preview、restore 四处 |
| 仓库 | `chats/`（`docs/DATA-CONTRACT.md:328-358`） | 完全绕开上面两套：不走 `devices/<id>/`，也不是 `SyncScope` 的成员 | 合并语义（接管 / 租约）只写在散文里，代码里没有单一判据 |

后果三条：

- 新增一类数据要改**两处**（App 提交过滤 + 插件 collect/`SyncScope`），改一处就是"写了不同步"或"同步了没脱敏"；
- 已有三类数据的合并语义各不相同（**折叠** / **接管** / **entry 块合并**），但没有任何一处是"可校验的声明"；
- 没有一个地方能在"接入前"回答必答题：**这类数据跨设备并写会不会互相覆盖？会不会把本机路径带出去？**

### 1.2 注册表要解决的三件事

1. **单一事实来源**：类型、路径、合并、脱敏、体积、隔离一表打尽；
2. **加载期 fail-closed**：缺声明就不接入，而不是"先跑起来再补"；
3. **让"合并策略"从散文变成必填枚举**——这是本设计的核心，也是最容易被跳过的一项。

## 2. 六个声明项（缺一项即不许接入）

| # | 声明项 | 必填形态 | 加载时校验什么 | 缺失时 |
| --- | --- | --- | --- | --- |
| 1 | `id` + 显示名 | `id` 匹配 `^[a-z][a-z0-9-]{1,31}$` 且**全局唯一**；`displayName` 非空中文短名 | 正则、唯一性、非空 | 拒绝该类型 |
| 2 | 仓库路径 | `repoPath`：目录**或**文件模式 + `kind: 'dir' \| 'file'` + **`perDevice: boolean`**（是否按设备分目录） | 模式非空；`perDevice` **必须显式出现**（不许默认 true） | 拒绝该类型 |
| 3 | **合并策略**（强制三选一） | `per-device-union`（各设备自写 + 按 `id`+`ts` 折叠）/ `shared-single-writer`（共享命名空间 + 租约）/ `config-merge`（三方合并） | 枚举命中；该策略的必填参数齐备；**与 `perDevice` 自洽**（见下表） | 拒绝该类型 |
| 4 | 脱敏策略 | `redactSecrets: boolean` + `absolutePathReplace: boolean` + **`neverOut: string[]`（逐字段，至少 1 条）** | `neverOut` 非空；`redactSecrets=false` 时必须给非空 `noSecretsReason` | 拒绝该类型 |
| 5 | 体积上限 | `limits: { perItem, perType, onExceed: 'reject' \| 'shard' \| 'index-only' }`（字节数，正整型） | 三个字段齐备；`perItem ≤ perType`；`onExceed` 在枚举内 | 拒绝该类型 |
| 6 | 失败隔离 | `isolation: { isolatesFailures: boolean, fallback: string }`；布尔**必须显式写**（不许省略） | 布尔显式出现；`isolatesFailures=false` 时 `fallback` 必须说明"影响谁" | 拒绝该类型 |

**合并策略与 `perDevice` 的自洽规则**（第 3 项的一部分，必须一起校验）：

| 合并策略 | 要求 `perDevice` | 理由（来源） |
| --- | --- | --- |
| `per-device-union` | **必须 `true`** | 语义就是"各设备只写自己的目录、读侧折叠"（`docs/DATA-CONTRACT.md:28`、`:31`、`:108`） |
| `shared-single-writer` | **必须 `false`** | 放 `devices/<id>/` 等于把"谁写的"钉进路径，接管就要搬目录、历史随之断（`docs/DATA-CONTRACT.md:342-344`、`docs/CHAT-SYNC.md:57-62`） |
| `config-merge` | 两者皆可，但**必须给 `baseSource`**（共同祖先来自哪：git merge-base / 仓库内 `.base/` 副本 / 现场两方） | 三方合并没有 base 就是二选一，等于假合并 |

## 3. 参照实现 A：日程系（4 个 type 的族）

> 「日程系」在题面里是一类，但**体积上限与超限行为各不相同**，因此拆成 4 个 type 声明：
> `schedules` / `summaries` / `open-index` / `attachments`。四者合并策略相同（`per-device-union`），
> 但四份声明都要独立填满——这正是"注册表按 type 校验"的意义。

### 3.1 声明卡（6 项填满）

#### `schedules` / 日程

| 声明项 | 值 |
| --- | --- |
| `id` / 显示名 | `schedules` / 日程 |
| 仓库路径 | 目录、按设备分目录：`devices/<deviceId>/schedules/YYYY-MM-DD.jsonl`（`docs/DATA-CONTRACT.md:19`、`:22`、`:87`）；`kind: 'dir'`、`perDevice: true`；分片名由记录 `ts` 的**设备本地日期**决定（`:87`） |
| 合并策略 | `per-device-union`：各设备只写自己目录（`docs/DATA-CONTRACT.md:28`、`:31`）；读侧 `parseJsonl` + `foldById`，同 `id` 取较晚 `ts`（`:108`；`packages/dsh-git-config-sync/src/schedule/jsonl.ts:183`）；更新事件追加同 `id` 新行、`ts` 保留原记录日期（`docs/DATA-CONTRACT.md:111-113`） |
| 脱敏 | `redactSecrets: true`（文本片段级，规则同 `apps/arkui-schedule/entry/src/main/ets/model/syncError.ts:61-98`，与 `docs/CHAT-SYNC.md:228-231` 同一套）；`absolutePathReplace: true`（`C:\...`、`/home/<user>/` → `<WORKSPACE>`，同 `docs/CHAT-SYNC.md:244-245`）；`neverOut` 见 §3.3 |
| 体积上限 | 单条 ≤ 16 KiB（`body`+`ocr_text`+`ai_structured` 合计）；单类型 ≤ 2 MiB / 日分片、64 MiB / 设备总量；`onExceed: 'reject'`（`E_RECORD_TOO_LARGE`）——**不截断**，理由见 §3.4 |
| 失败隔离 | `isolatesFailures: true`；`fallback: '本类型失败不影响 summaries / open-index / attachments'`（先例：索引写失败不影响日程保存，`docs/DATA-CONTRACT.md:168`） |

#### `summaries` / 每日 AI 汇总

| 声明项 | 值 |
| --- | --- |
| `id` / 显示名 | `summaries` / 每日汇总 |
| 仓库路径 | 文件集合、按设备分目录：`devices/<deviceId>/summaries/YYYY-MM-DD.json`，一天一个（`docs/DATA-CONTRACT.md:23`、`docs/ROADMAP.md:13`）；`kind: 'file'`、`perDevice: true` |
| 合并策略 | `per-device-union`：各设备只写自己目录；**同日多份**按 `generatedAt` 取新（`docs/DATA-CONTRACT.md:197`；`mergeSummary`，`docs/ROADMAP.md:13` 逐字记了「相等保留现有，返回 `replaced`」）。这是**族内唯一的"取新"点**，其它 type 不许照抄 |
| 脱敏 | `redactSecrets: true`（输入是记录正文，AI 回复可能夹带 key 或 URL）；`absolutePathReplace: true`；`neverOut`：AI 请求全文（`prompt`）、AI 原始回复、`FallbackDiagnostic`（`docs/DATA-CONTRACT.md` §9「永不持久化」） |
| 体积上限 | 单条 ≤ 8 KiB（一天一个文件即单文件）；要点 ≤ 3 条（`docs/UI-DESIGN.md:102` 的 `truncateSummaryForDisplay` 默认 3）；`onExceed: 'reject'`（保持旧文件，`docs/ROADMAP.md:13`「AI 失败一个字节都不写」同款） |
| 失败隔离 | `isolatesFailures: true`；汇总失败后仍显示旧汇总（`docs/ROADMAP.md:13`） |

#### `open-index` / 未完成索引

| 声明项 | 值 |
| --- | --- |
| `id` / 显示名 | `open-index` / 未完成索引 |
| 仓库路径 | 单文件、按设备分目录：`devices/<deviceId>/open.jsonl`（`docs/DATA-CONTRACT.md:160`）；`kind: 'file'`、`perDevice: true` |
| 合并策略 | `per-device-union` + **派生**语义：同 `id` 取 `ts` 最新（`docs/DATA-CONTRACT.md:160`、`:167`）；读别的设备时**绝不写回**对方目录，缺索引就在内存里重建（`:169`） |
| 脱敏 | `redactSecrets: true`（结构上只有 `id`/`date`/`ts`/`openedAt`/`closedAt`，仍走统一扫描，不做例外）；`absolutePathReplace: false`（该结构**不含任何路径字段**，`:163` 可逐字段核对）；`neverOut`：记录正文、标题、附件名、记录 `author` |
| 体积上限 | 单行 ≤ 256 B；单文件 ≤ 512 KiB（30 天窗口，`:168`）；`onExceed: 'shard'` —— 派生数据可重算，超限直接重建而不是拒绝（`:168`「仅在漂移时重建」） |
| 失败隔离 | `isolatesFailures: true`（派生，`:168` 明写"写入失败不影响日程保存"） |

#### `attachments` / 手迹附件

| 声明项 | 值 |
| --- | --- |
| `id` / 显示名 | `attachments` / 附件 |
| 仓库路径 | 目录、按设备分目录：`devices/<deviceId>/attachments/YYYY-MM-DD.zip`；`kind: 'dir'`、`perDevice: true`；**仓库里只有 zip、没有散图**（`docs/DATA-CONTRACT.md:175`） |
| 合并策略 | `per-device-union`（设备目录不重叠，`docs/DATA-CONTRACT.md:197`）+ **附件保护**：远端 zip 的 sha 与本机基线不符且远端指纹 ≠ 本机指纹 → **暂停推送该 zip**，其余文件照常（`:221-224`，fail-closed） |
| 脱敏 | `redactSecrets: false` + `noSecretsReason: '二进制 zip，按内容寻址；扫描只做"是不是合法 zip"与条目名合规'`；`absolutePathReplace: false`；`neverOut`：zip 条目名只允许 `page-<pageIndex>-<sha8>.jpg`（`:175`）——**任何原始文件名、人名、本机路径不得进条目名**；源图 `<filesDir>/attachments-src/<sha256>.jpg`（`:174`）与解压缓存 `<filesDir>/cache/attachments/**`（`:178`）永不进仓库 |
| 体积上限 | 单 zip ≤ 32 MiB；单页 ≤ 512 KiB（JPEG q60、最长边 ≤1440px，`:173`）；单设备总量 ≤ 500 MiB；`onExceed: 'index-only'`（降级成"只传索引"）→ 具体见 §5.5 |
| 失败隔离 | `isolatesFailures: true`（单个 zip 暂停推送不阻断其它文件，`:221-224`） |

### 3.2 为什么日程族是 `per-device-union`

日程记录是**自包含、可整体覆盖**的独立实体，丢失的语义是"少一次编辑"，可以手补；因此敢并写
（`docs/CHAT-SYNC.md:38-43` 的对照表）。而 `devices/` 的整套机制（每机一目录、只写自己、缺失视为空、
sha256 只作传输校验不做内容合并，`docs/DATA-CONTRACT.md:29`）就是为这种并写设计的。

反过来，会话事件不能这样（`docs/CHAT-SYNC.md:17-51`）——这正是 `chats` 必须换策略的原因（§4.2）。

### 3.3 永外传字段（逐字段，日程族）

| 字段 / 内容 | 是否外传 | 处理 |
| --- | --- | --- |
| `id`、`ts`、`title`、`author`、`done`、`ai_processed`、`ocr_time` | 是，原样 | `ts` 含时区、不做本机换算（`docs/EXPORT-IMPORT.md:68` 同位纪律） |
| `body`、`ocr_text`、`ai_structured` | 是，但**必须先过两道** | ① `redactSecrets`（文本片段级）；② 绝对路径 → `<WORKSPACE>` |
| `attachments[].sha256` / `pageIndex` / `archive` / `entry` | 是，原样 | `entry` 形态已限定（`docs/DATA-CONTRACT.md:176`） |
| `attachments[].name` | 是，但**只允许 `page-<i>-<sha8>.jpg` 形态** | 老数据里的原始文件名必须在外传前重命名（`:177` 允许旧数据继续读，但不允许旧名字继续外传） |
| **`<filesDir>/attachments-src/<sha256>.jpg` 路径与内容** | **否** | 源图不进仓库（`docs/DATA-CONTRACT.md:174`） |
| **`<filesDir>/cache/attachments/**`** | **否** | 本机缓存（`:178`） |
| **`sync-baseline.json`** | **否** | 本机基线（`:224`） |
| **本机 `filesDir` / 工作副本绝对路径 / `cwd`** | **否** | 任何形式（含 URI、UNC）都不得进任何外传字段 |
| **`FallbackDiagnostic`（AI 诊断）** | **否** | 永不持久化、不进同步载荷（`docs/DATA-CONTRACT.md` §9） |
| `author` | 是 | 但要提示用户：这是**会公开到仓库**的字段，别填全名（`docs/DATA-CONTRACT.md:101` 只规定语义，未规定脱敏） |

### 3.4 体积上限为什么是"拒绝"而不是"截断"

截断 = 静默丢数据，和 `docs/EXPORT-IMPORT.md:26-29` 的"绝不覆盖 / fail-closed"是同一立场；
而历史上唯一允许"丢一半继续"的地方是会话尾行撕裂，且最终也选了更保守的整会话 fail-closed
（`docs/CHAT-SYNC.md:445-447`）。所以日程族四个 type 里：

- `schedules` / `summaries` → `reject`（有损不可接受）；
- `open-index` → `shard`（是派生数据，重建无损，`docs/DATA-CONTRACT.md:168`）；
- `attachments` → `index-only`（二进制体积换"只传索引"即可，见 §5.5）。

### 3.5 失败隔离

日程族的四份声明都是 `isolatesFailures: true`。这不是抽象原则，而是仓库里已有的**实现事实**：

- `open.jsonl` 写失败不影响日程保存（`docs/DATA-CONTRACT.md:168`）；
- 单个附件 zip 被暂停推送，其余文件照常推（`:221-224`）；
- summary 写入失败保留旧文件（`docs/ROADMAP.md:13`）。

## 4. 参照实现 B：`chats` / 云端对话

### 4.1 声明卡（6 项填满）

| 声明项 | 值 |
| --- | --- |
| `id` / 显示名 | `chats` / 云端对话 |
| 仓库路径 | `chats/<sessionId>/meta.json`、`chats/<sessionId>/session.jsonl`、`chats/index.jsonl`（`docs/DATA-CONTRACT.md:334-340`）；`kind: 'dir'`、**`perDevice: false`**（共享命名空间，不是 `devices/<deviceId>/`） |
| 合并策略 | `shared-single-writer`：同一 `sessionId` 同时最多一个写者（`lease.owner`），TTL 10 分钟、心跳 60s、只做区间比较（`docs/DATA-CONTRACT.md:351-353`、`docs/CHAT-SYNC.md:97-106`）；真正的一致性由 `meta.sha256` 乐观锁保证（`docs/CHAT-SYNC.md:104-106`）；冲突一律 fail-closed，**永不按 `ts` 折叠**（`docs/CHAT-SYNC.md:46-51`、`docs/DATA-CONTRACT.md:358`） |
| 脱敏 | `redactSecrets: true`（逐行文本，`docs/CHAT-SYNC.md:228-231`）；`absolutePathReplace: true`（绝对路径 → `<WORKSPACE>`，`:244-245`）；提交前**静态扫描命中即拒传**（5 条规则，`:232-240`）；`neverOut` 见 §4.3 |
| 体积上限 | 单行 ≤ 256 KiB；单会话 ≤ 8 MiB；`index.jsonl` ≤ 4 MiB；`onExceed: 'reject'`（先例：整会话跳过而不是截尾巴，`docs/CHAT-SYNC.md:445-447`） |
| 失败隔离 | `isolatesFailures: true`；`fallback: '单会话失败不抛，逐会话结果 + 汇总'`（`docs/CHAT-SYNC.md:421`） |

### 4.2 为什么 `chats` 必须是 `shared-single-writer`

三个理由，全部是文档里已定的：

1. **并写会损坏事件流**：两端都可能声明自己拥有 `seq 41`，三种折叠结局都不是"少一条日程"这种可容忍损失
   （`docs/CHAT-SYNC.md:17-34`）；
2. **`devices/` 的语义与接管制冲突**：放 `devices/<id>/` 等于把写者钉进路径，接管就要搬文件
   （`docs/DATA-CONTRACT.md:342-344`）；
3. **仓库里已有实现先例**：P1 已落地 `chats/` 导出与 `index.jsonl` 追加（`docs/CHAT-SYNC.md:399-441`）。

### 4.3 永外传字段（逐字段，`chats`）

| 字段 / 内容 | 是否外传 | 处理 |
| --- | --- | --- |
| `meta.json` 的 11 个白名单字段：`schemaVersion`/`sessionId`/`title`/`createdAt`/`updatedAt`/`model`/`messageCount`/`sha256`/`deviceId`/`workspaceName`/`lease` | 是 | **只按白名单挑**，不认识的键一律丢弃（`docs/CHAT-SYNC.md:74-85`） |
| `workspaceName` | 是，但**只允许末段名** | 取 `basename(realpath(cwd))`（`:84`、`:88`） |
| `session.jsonl` 每行 | 是，但逐行过 `redactSecrets` + 路径替换 | `tool` 入参/输出里的绝对路径统一替换为 `<WORKSPACE>`（`:244-245`） |
| **`cwd` 及一切绝对路径** | **否** | `meta.json` 明确禁止（`:87-88`） |
| **`path`、用户名、provider 凭据** | **否** | 同 `:87-88` |
| **`.env`、`*.key`、`*.pem`、任何 api key/token 原文** | **否** | 禁止上传（`:242`） |
| **附件二进制（截图、图片、文件）** | **否** | 一律不上传（`:242-243`） |
| 静态扫描 5 条规则命中的任何内容 | 否 | 命中即拒传并报行号（`:232-240`）：`sk-[A-Za-z0-9]{8,}`、`Bearer\s+\S+`、`api[_-]?key` / `token=` / `secret`、`C:\\Users\\` / `/home/[^/]+/`、`\\Users\\` / `file://` |

### 4.4 体积上限与超限行为

单会话 8 MiB 是**建议值**（判据见 §9 第 3 条）；超限选 `reject` 是因为会话只能整段上传：

- 半段上传会让 `meta.sha256` 与内容的关系更难排查（`docs/CHAT-SYNC.md:445-447`）；
- 尾行撕裂已明确"整会话 fail-closed"而不是"截掉坏尾巴"（`:445-447`）。

另注意展示层的独立上限：超过 512 KiB 的文件 `diff.ts` 不产出 hunk（`packages/dsh-git-config-sync/src/engine/diff.ts:84` `MAX_DIFF_BYTES`），
所以 UI 侧"能不能逐行看差异"与"能不能上传"是**两个不同阈值**，别混用。

### 4.5 失败隔离

`chats` 的失败隔离有两条硬约束：

1. **单会话失败不影响其它会话**（`docs/CHAT-SYNC.md:421`）；
2. **远程域与同步域互不影响**的反面同样成立：`chats` 走 ff-only 通道（`docs/CHAT-SYNC.md:200-206`），
   与 `devices/` 的 `pushWithRebase()`（`packages/dsh-git-config-sync/src/engine/git.ts:643`）不是同一条路，
   一条路坏了不能连累另一条。

## 5. 候选新类型：优先级与逐类型判定

### 5.0 排序规则（三条，可复核）

1. **已在仓库里跑（有真实数据可验证）的优先**——它们今天靠"递归 add 整个 `devices/<id>/`"顺带同步，
   没有声明就没有校验，属于"已经在跑但无契约"的债（`docs/ROADMAP.md:13`、`docs/DATA-CONTRACT.md:31`）；
2. **风险越低越先做**——"越危险越后做"，因为注册表校验（§6）与静态扫描（`docs/CHAT-SYNC.md:232-240`）
   是最便宜的护栏，先把低风险类型喂进护栏，再谈高风险的；
3. **需要新增机制越少越先做**——"分片"、"只传索引"、"三方 base 存储"都算新机制。

按这三条得到：**每日摘要 → 插件清单与版本 → DSH 配置 → AI 供应商与模型设置 → 附件索引 → 模板**。

### 5.1 每日摘要（`summaries`，已在跑）

- **现状**：见 §3.1 的 `summaries` 卡；今天没有 type 声明，靠设备目录顺带同步（`docs/ROADMAP.md:13`）。
- **问 1：跨设备并写会不会互相覆盖？** 不会。各写 `devices/<自己>/summaries/`，目录不重叠
  （`docs/DATA-CONTRACT.md:197`）。但"今天该显示哪一份"存在**同日双份**，今天只靠一句散文
  "按 `generatedAt` 取新"（`:197`）——这就是必须扶正的理由：**折叠规则要有声明，不能只活在文档里**。
- **问 2：会不会把本机路径带出去？** **会**。headline 与要点是 AI 生成的自由文本，输入是记录正文，
  正文里可能已经有路径与 key（`docs/DATA-CONTRACT.md:91` 的 `body` 可编辑）。
  → 必须 `redactSecrets` + 路径替换（§3.1 第 4 行）。
- **推荐合并策略**：`per-device-union`（折叠键 `id`，冲突取 `generatedAt` 较新）。

### 5.2 插件清单与版本（`plugins.json`，已在跑）

- **现状**：`devices/<pcId>/plugins.json`，内容 `{plugins:[{name,version,source,enabled}]}`
  （`docs/DATA-CONTRACT.md:16`、`packages/dsh-git-config-sync/src/engine/types.ts:65-70`）；
  合并是 **MERGE-only 计划**，只写 `plugins.to-install.json`，**不执行 pnpm、不改 profile package.json**
  （`docs/DATA-CONTRACT.md:39`、`engine/restore.ts:254-270`）。
- **问 1：互相覆盖？** 文件层不会（各写自己目录）。但"装哪个版本"是**全局决定**，今天靠"计划 + 用户手动装"
  而非自动应用（`:39`），所以不会静默降级——这是**正确设计，注册表必须把它写成声明而不是默认行为**。
- **问 2：本机路径？** **会**，且这是本类型唯一的泄漏点：`source` 字段在本地插件上可能是绝对路径或
  `file:` 依赖。→ `neverOut` 必须点名 `source`，只允许 registry 名或 `<LOCAL>` 占位。
  （注意：`docs/DATA-CONTRACT.md:39` 写的是"无密钥"，不等于"无路径"。）
- **推荐合并策略**：`per-device-union`（无折叠键，文件级 union）+ 声明里显式写"never auto-install"。

### 5.3 DSH 配置（`cordis.patch.yml` 等四文件，已在跑且能力最全）

- **现状**：采集 → 预览 → 差异 → 恢复一条链已完整（`engine/collect.ts`、`engine/preview.ts:257-317`、
  `engine/diff.ts:341`、`engine/restore.ts:138-279`）；仓库侧四个文件在 `devices/<pcId>/`（`docs/DATA-CONTRACT.md:14-17`）。
- **问 1：互相覆盖？** **会，而且是"整块"覆盖**：patch 按 entry 合并，同 key 文本不同 → `changed`
  整块采用远端（`docs/DATA-CONTRACT.md:62`）；`insert:` 多行块整块替换（`:59-62`）。
  今天之所以安全，是因为**必须人工 preview + 勾选 + `confirm:true`**（`engine/restore.ts:84-88`、`:138-141`），
  而且远端独有条目追加、本地独有保留、含 `__SECRET__` 且不同 → `manual` 不自动覆盖（`:62-63`）。
  一旦有人把它改成"自动应用"，那就是两台设备互相覆盖配置。
- **问 2：本机路径？** **会，且量最大**：patch 里的插件路径、workspace 路径、`file:` 依赖、`!!js` 表达式里的
  本机变量，加上 secret（`:43-45` 的词边界规则就是为了不误伤 `maxTokens` 一类别名）。
- **推荐合并策略**：仓库层 = `per-device-union`（各写自己目录）；**"apply 时的 entry 级合并"要降级为
  该类型的一个"受控操作"，不是该类型的合并策略**。这条必须写清楚，否则"一个 type 只能一个策略"会被
  误读成"允许自动三方合并本机配置"。

### 5.4 AI 供应商与模型设置（`providers.json` + 密钥）—— **最危险**

- **现状**：`devices/<pcId>/providers.json`，写前递归 key 脱敏（`docs/DATA-CONTRACT.md:38`、`:43-44`；
  实现 `engine/collect.ts:266-280` + `engine/secrets.ts:54-60`），但**当前只做展示 / 差异对照**
  （`docs/DATA-CONTRACT.md:38` 原文："实际写入仍走 patch entry"）。
- **问 1：跨设备并写会不会互相覆盖？** **会，而且是静默的。**
  provider / 模型选择在语义上是**全局单选**（一次对话只能用一组）。两台设备各自把"我的选择"推上去后，
  读侧**没有"两个都对"的折叠方式**：取谁的，另一台的选择都会消失。它也不像日程那样"少一条可手补"——
  后果是下一次对话**换了模型或供应商**，而用户看不到任何提示。
  更要紧：今天这个问题被"只展示、不应用"（`:38`）掩盖了，所以**任何把它提升为"自动应用"的改动都会
  立刻把风险变成现实**。
- **问 2：会不会把本机路径带出去？** **会**。provider 定义里常见三类泄漏：
  ① `apiKey` / `token` —— 词边界能抓（`engine/secrets.ts:22-23`、`:54-60`）；
  ② `baseURL` —— 自建反代地址、内网主机名、`C:\` 路径，这些**不是密钥但同样是本机信息**；
  ③ `apiKeyEnv` —— 值只是环境变量名，`engine/secrets.ts:51-52` 明写**不脱敏**（这是对的决定，
  避免把正常字段误伤），但它意味着**这个字段会原样外传**，必须有意识。
- **推荐合并策略**：`per-device-union` + **写入侧零自动应用**（保持 `:38` 现状：只展示、只对照）。
  另有一刀切的决定：**"当前选中的 provider / model"不进同步范围**——它属于本机偏好（同
  `docs/DATA-CONTRACT.md` §9 把 `aiFallbackEnabled` 等三个键放 `preferences`、不进 Git 的同一个理由）。
- **密钥永外传 = 否（逐字段）**：
  | 字段形态 | 外传 | 处理 |
  | --- | --- | --- |
  | 值形态是凭据：`apiKey` / `api_key` / `apiKey`（含 `apikey` 单词）、`token`、`secret`、`password`、`authorization`、`bearer` | **否** | 一律 `__SECRET__`（`docs/DATA-CONTRACT.md:45`）；恢复时按同名回填，本地无值 → 保留占位符 + 标 `需本地填写`（`:45`） |
  | `headers.Authorization` | **否** | 同上 |
  | `apiKeyEnv` / `api_key_env` | 是（**故意**） | 只脱敏值不脱敏键；键名会外传，需在 UI 明示 |
  | `baseURL` | 条件 | 命中本机/内网形态（`127.`、`192.168.`、`10.`、`172.16-31.`、`C:\`、`/home/<user>/`、`file://`）→ 只外传"自定义源"这一事实，**不外传值** |
  | `mcp` server 的 `env` 值 | **否** | 同凭据处理（`engine/collect.ts:282-289` 已按同一套脱敏） |
  | `maxTokens` / `tokenizer` / `tokens` 类正常字段 | 是 | 明确**不得**脱敏（`:43-44`） |

### 5.5 附件索引（`attachments` 的"索引视图"）

- **现状**：二进制走 `devices/<id>/attachments/<date>.zip`（§3.1），索引走 JSONL 的 `attachments` 数组
  （`docs/DATA-CONTRACT.md:176`）。
- **为什么它要单独成为一个 type**：索引和二进制是**两条不同的泄漏面与体积面**——索引可以外传（可 diff、
  可审阅），二进制只该"必要时传"。今天的声明把它们绑在一个 type 里，就缺少"只传索引"这个档位。
- **问 1：互相覆盖？** 不会。sha256 内容寻址，同 sha 即同文件，"附件按 sha256 去重命名"
  （`docs/DATA-CONTRACT.md:109`）。
- **问 2：本机路径？** **会**：老数据的 `name` 仍是原始文件名（`:177` 允许旧数据继续读），
  可能含人名、页码命名习惯甚至路径片段。
- **推荐合并策略**：`per-device-union`，`onExceed: 'index-only'`。这个档位的语义要在声明里写死：
  超限时**只外传索引**，二进制留在本机，UI 明示"附件未上传，只在原设备可看"。

### 5.6 模板（全新，仓库里今天没有这类数据）

- **现状**：无。全仓文档与代码都没有 `templates/` 类路径（本轮只读检索，未发现）。
- **问 1：互相覆盖？** **会**。模板是"共享命名空间 + 同 id 可编辑"，两台设备并写同一模板 id 就是文本冲突，
  而且不像会话那样能靠租约挡（模板没有"正在使用"这个状态）。
- **问 2：本机路径？** **会**：模板正文里通常带 `<workspace>` 示例路径、公司内网 URL、示例 token。
- **推荐合并策略**：`config-merge`（三方合并）——模板是纯文本，行级 diff 能力已存在
  （`engine/diff.ts:341` `diffText`，含 `truncated` 语义与二进制跳过规则 `:122-127`），冲突可展示给人选。
  代价：需要 **base**（共同祖先）。仓库里存不存 base 副本，是接入前必须先答的问题（§9 第 4 条）。

## 6. 硬规矩：注册表加载时校验，缺失即拒绝该类型

### 6.1 校验顺序（fail-closed，逐类型独立）

```
1. 形状：6 项声明全部存在且类型正确（缺 → E_SCOPE_DECLARATION_MISSING{field}）
2. 合并策略：枚举命中 + 该策略必填参数齐备 + 与 perDevice 自洽（§2 第二张表）
3. 脱敏：neverOut 非空；redactSecrets=false 时 noSecretsReason 非空
4. 体积上限：perItem ≤ perType；onExceed ∈ {reject, shard, index-only}
5. 失败隔离：布尔显式出现（不许省略、不许默认）
```

任一步失败 → 该类型被**丢弃**，并：

- 记一行日志（`[scope] rejected type=<id> code=<code> missing=<field>`）；
- 设置页「同步范围」里该类型显示为"未接入（原因）"，**不出现可勾选开关**
  ——不许做假开关，同 `docs/REMOTE-ACCESS-OPTIONS.md:48-49` 的纪律；
- **其它类型照常加载**（这是"失败隔离"在注册表层的最小应用）。

### 6.2 缺什么报什么

| 缺失 / 非法项 | 错误码 | 该类型 | 其它类型 |
| --- | --- | --- | --- |
| 任一声明项整体缺失 | `E_SCOPE_DECLARATION_MISSING` | 拒绝接入 | 不受影响 |
| 合并策略缺失 / 枚举外 / 参数不全 | `E_SCOPE_MERGE_UNDECLARED` | 拒绝接入 | 不受影响 |
| 合并策略与 `perDevice` 不自洽 | `E_SCOPE_MERGE_INCONSISTENT` | 拒绝接入 | 不受影响 |
| `neverOut` 为空 | `E_SCOPE_REDACTION_UNDECLARED` | 拒绝接入 | 不受影响 |
| `redactSecrets=false` 且无 `noSecretsReason` | 同上 | 拒绝接入 | 不受影响 |
| `perItem > perType` / `onExceed` 不在枚举 | `E_SCOPE_LIMIT_INVALID` | 拒绝接入 | 不受影响 |
| `isolation.isolatesFailures` 省略 | `E_SCOPE_ISOLATION_UNDECLARED` | 拒绝接入 | 不受影响 |
| `id` 重复 | `E_SCOPE_DUPLICATE_ID` | 后出现者拒绝 | 先出现者保留 |

### 6.3 与运行时失败隔离的关系

注册表校验失败**只隔离到类型**，不阻断整个同步启动——因为一次"声明写错"不该让用户连日程都同步不了。
反过来，已接入类型在运行期失败，按其声明的 `isolation` 处理（日程族全部 `true`，§3.5）。
这条和远程域的既有纪律同构：远程监听起不来只写 `status.lastError`，绝不影响同步 RPC
（`docs/DATA-CONTRACT.md:255-258`）。

## 7. `SyncScope` 接口草案（TypeScript）

字段名与 §2 的 6 项一一对应；`id` 与 `displayName` 同属第 1 项，因此是 6 项 → 7 个必填字段。

```ts
/** 合并策略：强制三选一，没有默认值（缺省 = 拒绝接入）。 */
export type MergeStrategyKind = 'per-device-union' | 'shared-single-writer' | 'config-merge'

/** 第 3 项之一：各设备自写 + 读侧折叠。要求 repoPath.perDevice === true。 */
export interface PerDeviceUnionMerge {
  kind: 'per-device-union'
  /** 折叠键；null = 不做行级折叠（文件级 union）。 */
  foldBy: string | null
  /** 同键冲突取哪一条；'no-fold' 表示冲突即视为两个不同条目。 */
  onConflict: 'latest-ts' | 'latest-generatedAt' | 'no-fold'
}

/** 第 3 项之二：共享命名空间 + 租约。要求 repoPath.perDevice === false。 */
export interface SharedSingleWriterMerge {
  kind: 'shared-single-writer'
  /** 租约 TTL（毫秒）；chats 用 10 分钟（docs/DATA-CONTRACT.md:351-353）。 */
  leaseTtlMs: number
  /** 心跳间隔（毫秒）；chats 用 60s。 */
  heartbeatMs: number
  /** 乐观锁字段名（chats 是 'sha256'）。 */
  optimisticLockField: string
  /** 冲突时是否允许自动合并；shared-single-writer 恒 false（docs/CHAT-SYNC.md:170）。 */
  autoMerge: false
}

/** 第 3 项之三：三方合并。必须给 base 来源。 */
export interface ConfigMergeMerge {
  kind: 'config-merge'
  /** 共同祖先从哪来；没有 base 就是假合并。 */
  baseSource: 'git-merge-base' | 'repo-base-copy' | 'two-way-only'
  /** 冲突是否必须让人看见（当前恒 true）。 */
  conflictsVisible: true
}

export type MergeStrategy = PerDeviceUnionMerge | SharedSingleWriterMerge | ConfigMergeMerge

/** 第 2 项：仓库路径。 */
export interface ScopeRepoPath {
  /** 目录或文件模式，仓库相对路径；可用 <deviceId> / <date> / <sessionId> 占位。 */
  pattern: string
  kind: 'dir' | 'file'
  /** 是否按设备分目录。必须显式给出（不许默认）。 */
  perDevice: boolean
}

/** 第 4 项：脱敏策略。 */
export interface ScopeRedaction {
  /** 文本/结构化密钥脱敏开关。 */
  redactSecrets: boolean
  /** 绝对路径 → <WORKSPACE> 替换开关。 */
  absolutePathReplace: boolean
  /** 逐字段列出「永外传 = 否」。至少 1 条，空数组 = 声明无效。 */
  neverOut: string[]
  /** redactSecrets === false 时必填：为什么这类数据不含密钥。 */
  noSecretsReason?: string
}

/** 第 5 项：体积上限与超限行为。 */
export interface ScopeLimits {
  /** 单条上限（字节）。 */
  perItem: number
  /** 单类型上限（字节）；perItem 必须 ≤ perType。 */
  perType: number
  /** 超限行为：拒绝 / 分片 / 只传索引。 */
  onExceed: 'reject' | 'shard' | 'index-only'
}

/** 第 6 项：失败隔离。布尔必须显式出现。 */
export interface ScopeIsolation {
  isolatesFailures: boolean
  /** 人话说明：这类失败会影响谁、不影响谁。 */
  fallback: string
}

/** 一个同步范围类型（= 6 项声明 → 7 个必填字段）。 */
export interface SyncScope {
  /** 第 1 项：稳定 id，^[a-z][a-z0-9-]{1,31}$，全局唯一。 */
  id: string
  /** 第 1 项：中文显示名。 */
  displayName: string
  /** 第 2 项：仓库路径。 */
  repoPath: ScopeRepoPath
  /** 第 3 项：合并策略（强制三选一）。 */
  merge: MergeStrategy
  /** 第 4 项：脱敏策略。 */
  redaction: ScopeRedaction
  /** 第 5 项：体积上限。 */
  limits: ScopeLimits
  /** 第 6 项：失败隔离。 */
  isolation: ScopeIsolation
}

/** 校验结果：通过的类型 + 被拒的类型（逐条给缺什么）。 */
export interface ScopeRegistryLoadResult {
  accepted: SyncScope[]
  rejected: Array<{
    /** 声明里的 id（声明缺 id 时给 "<unnamed#index>"）。 */
    id: string
    code: string
    /** 缺哪一项 / 哪一字段，便于 UI 直接显示。 */
    missing: string[]
  }>
}

/**
 * 加载并校验注册表。纯函数、无 I/O、**绝不抛异常**（校验失败走 rejected）。
 * 拒绝的类型不进入 accepted，因此调用方不可能"误钩"一个没有合并策略的类型。
 */
export declare function loadScopeRegistry(declarations: unknown): ScopeRegistryLoadResult
```

三条接口纪律：

1. **没有可选字段能顶替必填项**：`isolatesFailures` 写成 `boolean | undefined` 不可接受。
2. **策略与路径的耦合在类型层就表达**：`PerDeviceUnionMerge` 与 `repoPath.perDevice === true` 的校验在
   `loadScopeRegistry` 里做（类型系统表达不了这个约束，所以必须有运行时校验与单测）。
3. **`neverOut` 不许是空数组**：空数组意味着"这类数据永外传字段为零"，实际上只有纯二进制 header 成立，
   而那种情况应该用 `redactSecrets: false` + `noSecretsReason` 明确表态。

## 8. 新增类型检查清单

按顺序勾，任一项没勾不许写实现代码。

- [ ] 1. **先加声明**：在注册表里填满 6 项；没有声明不写代码。
- [ ] 2. **回答两问并写进本文档**（不是 PR 描述、不是聊天记录）：
      「跨设备并写会不会互相覆盖？」「会不会把本机路径带出去？」
- [ ] 3. **合并策略与 `perDevice` 自洽**（§2 第二张表），并在单测里各造一条不自洽的用例（必须被拒）。
- [ ] 4. **`neverOut` 逐字段列全**，含派生字段（例：`sha256` 推不出内容，但 `name` 会带出人名）。
- [ ] 5. **脱敏复用既有两套之一**：结构化用 `engine/secrets.ts:54` `isSecretKey`，文本片段用
      `model/syncError.ts:61-98` 的 `SECRET_PATTERNS`；**不许新写第三套**（`docs/CHAT-SYNC.md:424-427`
      已经吃过一次"复刻"的代价）。
- [ ] 6. **静态扫描规则与 `docs/CHAT-SYNC.md:232-240` 同源**；新增规则必须同时更新那份表。
- [ ] 7. **体积上限给数字 + 判据**（p99 实测或文档依据）；`onExceed` 必须是无损动作（拒绝 / 分片 / 只传索引），
      **不许截断**（§3.4）。
- [ ] 8. **失败隔离显式写**；`true` 时给出"本类型失败、其它类型照常"的可观测证据（一行日志样例）。
- [ ] 9. **写入路径纳入 `filterPathsForDevice` 的断言**（`apps/.../model/syncScope.ts:94-107`）；
      共享命名空间的类型要单独给白名单，先例是 `devices/registry.jsonl` 是唯一允许写 `devices/` 顶层的文件
      （`docs/DATA-CONTRACT.md:404`）。
- [ ] 10. **需要 preview / apply 的走既有门禁**（`engine/restore.ts:84-88` 的 `confirm` 与
      `:138-141` 的顺序），不许新开旁路。
- [ ] 11. **给一条"必须失败"的验收用例**：塞一行 `sk-…` 必须拒传并给出提示（同
      `docs/CHAT-SYNC.md:252` 的第 ⑤ 条）。
- [ ] 12. **同时更新两处文档**：`docs/DATA-CONTRACT.md` §1 的布局图 + 本文档的类型表，**同一次提交**。

## 9. 待实测 / 待定（每条给判据）

| # | 待定 | 为什么定不下来 | 判据（怎么定） |
| --- | --- | --- | --- |
| 1 | `schedules` 单条 16 KiB | 16 KiB 是"够用"的估计值，没有实测分布 | 取 30 天真实记录的 p99（`body`+`ocr_text`+`ai_structured` 合计）；若 p99 > 16 KiB，则要么提高上限，要么把 `ocr_text` 拆成独立 type |
| 2 | 附件单日 zip 上限 32 MiB | 一天多少页没有实测 | 实测 7 天真实 zip 体积取 p95；若 p95 > 32 MiB，先降 JPEG 质量到 q50，仍超则改"只传索引"为默认 |
| 3 | `chats` 单会话 8 MiB | 手头没有真实会话体积分布 | 从本机 `~/.dsh` 真实会话解帧后取 p95（解帧方式见 `docs/CHAT-SYNC.md:410-415` 的 `frameByteLength`） |
| 4 | `config-merge` 的 base 从哪来（模板接入前必须定） | 仓库里存 base 副本 vs 用 git merge-base 各有代价 | 判据：两端都不联网时能否算出共同祖先。能 → 用 `git-merge-base`；不能 → 必须在仓库内 `templates/.base/` 存副本，并接受"base 也会过期" |
| 5 | `plugins.json` 的 `source` 真实形态 | 本地插件安装方式多样（`file:`、绝对路径、registry 名） | 实测本机 `plugins.json` 的 `source` 取值集合；只要出现过绝对路径/`file:`，就必须 `<LOCAL>` 占位化 |
| 6 | `providers.json` 里 `baseURL` 的内网判定名单 | 常见段值可枚举，但企业段值不封口 | 收集 5 台真实设备的 `baseURL`，按"是否是公网可解析域名"分类，再补名单 |
