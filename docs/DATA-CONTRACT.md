# 数据契约（DATA-CONTRACT）

本文件定义三处持久化契约：**Git 仓库目录结构**、**日程 JSONL**、**插件 RPC**。
跨设备互通以本文件为准；实现见 `packages/dsh-dots` 与 `apps/arkui-schedule`。

## 1. Git 仓库目录结构

用户自建 GitHub/Gitee 私有仓库（唯一远端，main 分支）：

```
<repo>/
  devices/
    pc-a/
      cordis.patch.yml     # 脱敏后的 profile patch（YAML entry 数组，保留注释/!!js）
      providers.json       # { providers: { <id>: <definition> } }
      plugins.json         # { plugins: [{ name, version, source, enabled }] }
      mcp.json             # { entries: [{ id, text }] }
      manifest.json        # { deviceId, time, scopes, dshVersion, files:[{name,sha256,bytes}] }
      schedules/2026-11-15.jsonl   # 电脑端日程（bridge 工具写）
    pc-b/                  # 同上
    phone-a/               # 平板（App 写）
      schedules/2026-11-15.jsonl
      summaries/2026-11-15.json    # 当日 AI 汇总（每天一个）
      open.jsonl                   # 未完成索引（见 §5）
      attachments/2026-11-15.zip   # 按天打包的手迹附件（见 §6）
```

- 每台设备**只写自己的目录**；读取其他目录用 `git fetch`/`pull` 后只读展示。
- 文件缺失视为空；`manifest.json` 是快照的权威索引（sha256 用于传输校验，不做内容合并）。
- 快照目录名 `deviceId` 必须匹配 `^[a-z0-9][a-z0-9-]{0,31}$`。
- **两类数据同仓**：电脑端只写 `devices/<pcId>/schedules/`（由 bridge 工具写），平板只写 `devices/<tabletId>/schedules|summaries|attachments|open.jsonl`；两边 `deviceId` 必须不同。

## 2. 插件同步载荷

| 文件 | 来源（本机） | 脱敏 | 恢复方式 |
| --- | --- | --- | --- |
| `cordis.patch.yml` | `<profileDir>/cordis.patch.yml` | 行级 secret 值 → `__SECRET__` | 逐 entry 勾选合并，本地 secret 回填 |
| `providers.json` | patch 中 `providers:` 条目 | 递归 key 匹配脱敏 | 展示/差异对照（实际写入仍走 patch entry） |
| `plugins.json` | profile `package.json` + node_modules | 无密钥 | MERGE-only 计划（不执行 pnpm） |
| `mcp.json` | patch 中 mcp 条目 | 递归脱敏 | 展示/差异对照 |
| `manifest.json` | 采集时生成 | 无 | 校验索引 |

敏感 key 判定按**词边界**（非子串）：`token`/`secret`/`password`/`authorization`/`bearer` 精确词，
或相邻词 `api`+`key`（`apiKey`/`api_key`）；`maxTokens`、`apiKeyEnv` 属正常字段，不得脱敏。
占位符固定 `__SECRET__`；恢复时按 key 名在同一条目内回填本地值，本地无同名值 → 保留占位符并标记 `需本地填写`。

### 2.1 patch entry 合并规则

输入是顶层 YAML 数组：

```yaml
- id: llm-pi-ai
  config: { ... }
- insert:
    - id: dsh-git-sync
      name: 'dsh-git-sync'
```

- entry key：顶层 `id` → `<id>`；`insert:` → `insert:<内部第一个 id>`；其它 → `entry:<序号>`。
  **限制**：一个 `insert:` 块内的多行插件行被当作一个整体、按内部第一个 id 合并；多行块会整块替换。
  用户 profile 建议“一条 entry 一行 `insert`”，以便逐插件勾选与回滚。
- 合并：本地顺序为准；本地独有保留；远端独有追加；同 key 文本不同 → `changed`（整块采用远端）；
  相同 → `same`；远端含 `__SECRET__` 且不同 → `manual`（需本地填写，不自动覆盖）。
- 输出保证：文件头/前置注释、条目内 `!!js`、缩进、键顺序不变；末尾恰好一个换行。

### 2.3 错误码（chat 工具隔离）

> 2026-11-18 追加（编号沿用 Lead 指令，便于与 `docs/CONTRACT.md` §2.3 的错误码集合对照；
> 本节此前无 2.2）。本条**只增不改**：不触碰上面任何字段与 RPC 契约。

| 错误码 | 级别 | 语义 | 触发点 |
| --- | --- | --- | --- |
| `E_CHAT_TOOLS_NOT_ISOLATED` | **正式安全边界错误码** | 云端对话模式（`agentPreset: 'chat'`）**没能证明工具已隔离** → **拒绝创建会话**（不是降级运行） | `src/chatPreset/isolate.ts`：读不到已注册工具表 / 读不到 agent 可见集 / 白名单断言发现多出的工具 |

- 判据是"能不能读写本机文件 / 执行本机命令 / 读取本机环境"，实现形态是**运行期反算**
  （`deny = 当前已注册的全部工具 − 纯对话白名单`）+ **遮蔽后再枚举可见集做白名单断言**；
  该错误码不携带任何静态名单，`message` 会点名多出来的工具（形如
  `云端对话模式没能隔离工具：多出 a, b, c`），`details.extra` / `details.missing` 给出逐名清单。
- `E_CHAT_DENY_FAILED`（宿主没有 `tools.restrict` / `restrict` 抛错）是**内部防御性错误**，
  只用于定位，**不进本表**；对外表现同样是"拒绝创建会话"。
- 两者都不会被 RPC 层改写成别的 code（`POST /dsh-dots/rpc` 原样透传），
  也**不**作为 `chatPresetInfo` 的返回值——该 action 只返回
  `{presetId, allow, rationale, registeredCount?, denyCount?}`。

## 3. 日程 JSONL

路径：`devices/<deviceId>/schedules/YYYY-MM-DD.jsonl`（设备本地时间日期）。
一行一个 JSON 对象，**只追加，绝不重写历史行**：

```json
{"id":"01J...","ts":"2026-11-14T09:30:00+08:00","title":"周会","body":"...","ocr_text":"...","author":"我","done":false,"attachments":[{"sha256":"ab12...","name":"ab12....png","pageIndex":0}],"ai_structured":"...","ai_processed":true,"ocr_time":"2026-11-14T09:31:12+08:00"}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 全局唯一（时间戳+随机），跨设备折叠键 |
| `ts` | string | ISO 8601 含时区，创建时间 |
| `title` | string | 标题 |
| `body` | string | 正文（可编辑） |
| `ocr_text` | string? | 手写 OCR 原始结果，**只读不改** |
| `author` | string | 记录者 |
| `done` | boolean | 完成情况 |
| `attachments` | array? | `{sha256,name,pageIndex}`，文件 `attachments/<sha256>.png` |
| `ai_structured` | string? | AI 结构化结果（可编辑） |
| `ai_processed` | boolean | 是否已 AI 处理 |
| `ocr_time` | string? | 识别时间（AI 载荷使用） |

折叠：读多设备文件 → `parseJsonl` → `foldById`（同 id 以较晚记录覆盖）→ 按日期/标题展示。
附件按 sha256 去重命名；分页识别结果全部完成后 0→N 一次拼接写入 `body`，每页结果不覆盖 `ocr_text`。

**更新事件（勾选完成 / 编辑 / AI 结构化保存）**：追加同 `id` 的新记录，`ts` 保留原记录**日期**、
时刻取 `max(当前时刻, 原时刻+1ms)`（`nextTsSameDate`），因此记录不会被迁到当天文件，
且排序后稳定取到新版本。`ocr_text` 从首次识别起不再改变。

## 4. 插件 RPC 契约

`POST /dsh-dots/rpc`，请求 `{action, ...}`，响应恒 HTTP 200：

```json
{"ok":true,"data":{...}}
{"ok":false,"error":{"code":"E_CONFIRM_REQUIRED","message":"...","details":{}}}
```

仅鉴权失败返回 401/403。写操作串行队列；未知 action → `E_UNKNOWN_ACTION`。

| action | 请求体 | 响应 data |
| --- | --- | --- |
| `getState` | `{}` | `{settings, status, snapshots}`（只读本地，不联网） |
| `saveSettings` | `{settings, token?}` | `{settings, hasToken}` |
| `testConnection` | `{}` | `{reachable, branch, headSha, message}` |
| `push` | `{}` | `{pushed, commit, branch, files, rebased}` |
| `preview` | `{}` | `{previewId, sources}` |
| `apply` | `{confirm:true, previewId, sourceDevice, entries:string[]}` | `{applied:[{id,fileSha256,blockSha256,path}], skipped, snapshotId, verified:true}` |
| `listSnapshots` | `{}` | `{snapshots}` |
| `rollback` | `{snapshotId, confirm:true}` | `{restored, verified:true}` |

`settings`：

```ts
{ repoUrl: string,
  platform: 'github' | 'gitee' | 'custom',
  authMode: 'https' | 'ssh',
  deviceId: string,
  branch: string,
  scope: { config: boolean, providers: boolean, plugins: boolean, mcp: boolean } }
```

`status`：`{reachable: true|false|null, branch, headSha, headMessage, headTime, localPending: number|null, remotePending: number|null, conflict, lastSyncAt, error?}`。
`reachable` 三态：`null`=未探测，`false`=最近一次网络动作失败；`getState` 不联网，`localPending/remotePending`
无 `origin/<branch>` 本地引用时为 `null`。`applied[]` 的 `fileSha256` 是写后整文件 SHA-256，
`blockSha256` 是单条 entry 文本 SHA-256。
`snapshots`：`[{id, time, reason, bytes}]`（写前恢复快照，保留最近 10 份）。
`preview.sources[]`：`{deviceId, headSha, files:[{name,sha256,bytes}], entries:[{id,name,status:'added'|'changed'|'same'|'manual',localText,remoteText,secretStripped}], plugins:{install,keep,skip,noDowngrade}, providers:{added,changed,same}, mcp:{added,changed,same}}`。

错误码：`E_VALIDATION`、`E_CONFIRM_REQUIRED`、`E_UNKNOWN_ACTION`、`E_NOT_FOUND`、`E_GIT`、`E_AUTH`、
`E_CONFLICT`、`E_SHA_MISMATCH`、`E_IO`。

## 4bis. 未完成索引 `open.jsonl`（App 写）

`devices/<deviceId>/open.jsonl`，每行一条（追加语义，同 id 取 `ts` 最新）：

```json
{"id":"<record id>","date":"2026-11-15","ts":"2026-11-15T09:30:00+08:00","openedAt":"…","closedAt":"…"}
```

- `closedAt` 缺省/空 = 仍未完成；`done:true` 的记录写入 `closedAt`，再次取消完成则**开新会话**（更新 `openedAt`）；
- `ts` 用于与日程记录折叠（同 id 取最新）；`date` 用于定位分片；
- 索引是**派生数据**：写入失败不影响日程保存；启动 / pull 后对**最近 30 天**分片重算期望值，仅在漂移时重建（`[idx] rebuilt drift=N`）；
- 「全部未完成」按设备读各自的 `open.jsonl`（N 台设备 = N 个小文件）；**其他设备目录只读**，缺索引时在内存里用其分片重建（`[idx] rebuild-memory device=…`），**绝不写回别人的设备目录**。

## 4ter. 附件按天 zip（App 写）

- 手迹截图 → **JPEG q60、最长边 ≤1440px**；
- 源图落本机 `<filesDir>/attachments-src/<sha256>.jpg`（**不进仓库**）；
- 同步前按记录日期打包 `devices/<deviceId>/attachments/<YYYY-MM-DD>.zip`，条目名 `page-<pageIndex>-<sha8>.jpg`；**仓库里只有 zip，没有散图**；
- JSONL 的 `attachments` 元素：`{sha256, name, pageIndex, archive:"2026-11-15.zip", entry:"page-1-1a2b3c4d.jpg"}`；
- 旧数据（无 `archive`）仍按散图 `<sha256>.png` 读，**不迁移**；
- 解压缓存：`<filesDir>/cache/attachments/<sha256>.jpg`，命中不重复解压；
- zip 由 WebView 桥里的 **JSZip 3.10.1**（MIT，`rawfile/git/jszip.min.js`）实现，**两端通用**（`@ohos.zlib` 在 ArkUI-X 安卓侧不可用）。

## 5. 状态目录（本机，不进 repo）

```
%USERPROFILE%\.dsh\dots\
  settings.json        # 同步设置（无 token）
  credentials.json     # { token }，0600
  work\<repoHash>\     # 工作副本（repoUrl 的 sha256 前 16 位）
  plugins.to-install.json
%USERPROFILE%\.dsh\vet\restore-snapshots\<YYYYMMDD-HHmmss>\
  files\<name>
  manifest.json
```

## 6. 应用侧 Git 布局

手机只写 `devices/<自己>/schedules/*.jsonl`、`summaries/*.json`、`open.jsonl` 与 `attachments/<date>.zip`，提交推送到同一远端；
其它设备目录只读。冲突策略：设备目录互不重叠，不需要 merge；同 id 记录按 ts 折叠；同日汇总按 `generatedAt` 取新。
电脑端由 `dsh-dots` 的 `schedule_*` 工具只写 `devices/<pcId>/schedules/`（见 `docs/SCHEDULE-BRIDGE.md`）。

### 6.1 设备指纹 `devices/<deviceId>/.device-fingerprint`（App 写，**不是 secret**）

```
devices/phone-a/
  .device-fingerprint          # 单行：本机随机 UUID（首次同步时生成）
  schedules/2026-11-15.jsonl
  attachments/2026-11-15.zip
```

- **是什么**：App 首次同步（拉取或推送）时生成的一个随机 UUID v4，写进本机
  `settingsStore.deviceFingerprint`（本机 preferences），**同时**写进仓库
  `devices/<deviceId>/.device-fingerprint`（单行、末尾一个换行）。已有内容时**绝不覆盖**。
- **为什么需要它**：`deviceId` 只决定写入目录 `devices/<id>/`，而校验只看「非空 + 格式合法」，
  **两台设备填同一个 id 时校验会通过**——后果是附件 zip
  `devices/<id>/attachments/<date>.zip` 互相覆盖、日程历史混在一起，而同步本身不报错。
- **判定规则**（`apps/arkui-schedule/entry/src/main/ets/model/deviceIdentity.ts`，纯函数、可单测）：
  - 远端没有该文件（老仓库 / 首次同步）→ 写入本机指纹，视为首次，**不报警**；
  - 远端指纹 == 本机指纹 → 正常；
  - 远端指纹 ≠ 本机指纹 → 「两台设备用了同一个设备标识」：设置页显示**常驻**警告（不是 toast），
    同步结果带 `identityConflict: true`，文案逐字为
    `这台设备和另一台设备用了同一个设备标识（<id>），附件 zip 会互相覆盖、历史会混在一起。请改成唯一值。`
- **推送前的附件保护（fail-closed）**：某个 `attachments/<date>.zip` 的远端版本与本机记录的基线 sha
  不一致、且远端指纹 ≠ 本机指纹时，**暂停推送该附件**（原因：
  `附件已被另一台设备更新，已停止推送以免覆盖（请先改一个唯一的设备标识）`），其余文件照常推；
  拿不到基线时同样保守拒推该附件。基线保存在本机 `<filesDir>/sync-baseline.json`，**不进 repo**。
- **不是 secret**：内容只是一个随机身份串，不含 token / 邮箱 / 机型等任何信息，泄露它没有凭据价值。
- **随 git 提交是刻意的**：它必须跟着仓库走，否则换机/清数据后无法再判断「这个目录之前是谁在写」。
- **不进同步载荷**：它不是 `ScheduleRecord` 字段，不进 `schedules/*.jsonl`、不进 `summaries/`；
  只是设备目录里的一个旁挂文件，插件侧（`packages/dsh-dots`）忽略它。
- **改了 `deviceId` 等于换写入目录**：本机指纹不变，但新目录下没有指纹 → 下次同步写入并视为首次；
  旧目录数据仍保留（其它设备目录只读）。

## 7. 远程访问域（`src/remote/**`，本机，不进 repo）

**与 Git 仓库零交集**：远程访问域不写 `devices/<id>/` 下任何文件，也不同步到远端。
它只碰本机状态目录下的两个**新增**文件：

```
%USERPROFILE%\.dsh\dots\
  remote.json          # 远程访问设置（8 字段，无 secret），0600
  remote-token.json    # { token, createdAt }，0600
```

- **`remote.json`**：字段集合 = `RemoteSettings`（`enabled` / `mode` / `port` / `lanAddress` /
  `tailscaleHost` / `cloudflareHost` / `ipv6Address` / `manualUrl` / `token`），语义见
  `docs/REMOTE-ACCESS-OPTIONS.md` §3。与 `settings.json` **平级但独立**：任一文件写坏/写失败
  不得影响另一域（远程访问坏了同步照常，反之亦然）。
  - `token` 是**用户粘贴的访问令牌**（可选）：空串 = 不追加参数；非空 = 链接里拼 `?token=`。
    它是 secret，因此**不进 `remoteGetState`**——状态响应只给 `tokenSet` / `tokenMasked`，
    与自动生成的令牌走同一个出口（只有 `remoteShowLink` 能取到明文）。
- **`remote-token.json`**：访问令牌（`crypto.randomBytes(32)` 的 base64url 形态）。
  **永不进 Git 仓库、永不出现在 `remoteGetState` 等状态响应里**（只给 `masked` 打码串），
  唯一明文出口是用户显式点「显示链接/二维码」。
- **不落盘的部分**：监听地址、连接数、被拒次数、最近自检结果、最近错误 —— 全部只在内存，
  重启清零。避免状态文件成为第二事实来源。
- **边界**：`src/remote/**` 不 import `src/engine/**`（`engine/errors.ts`、`engine/paths.ts`
  这类纯工具除外）与 `src/schedule/**` 的实现；反向同样不许。
- **失败隔离**：远程监听起不来（端口占用/地址不可用/拿不到上游身份）只写
  `status.lastError`，绝不让插件激活失败或影响同步 RPC。

## 8. 导出 / 导入视图（设置页，本机，**不改上面任何契约**）

设置页的「导出 / 导入」是**派生视图**：读的是 §3 的日程记录，写的是**本机沙箱**里的导出文件，
导回时只往 `<本机>/schedules/*.jsonl` **追加**。因此本节不新增记录字段、不改字段语义、不改
§4bis 的 `open.jsonl`，也不写 `summaries/` 与 `attachments/`。完整规格见 `docs/EXPORT-IMPORT.md`。

```
<filesDir>/
  exports/                              # 导出目录（不进 repo，push 不会带走）
    schedule-20261115-2305.md           # 时间戳来自记录（最新 ts），同名按 -2/-3 递增
    schedule-20261115-2305.json
  git-repo/devices/<self>/schedules/    # 导入只追加到这里（别的设备目录只读，永不写）
```

- **导出（只读派生）**：Markdown 按日期区间渲染人读版；JSON 固定
  `{version:1, exportedAt, range:{from,to}, deviceId, records}`，`records` 按 `(date, ts)` 升序、
  **字段原样保留**（不裁剪、不改名）。空区间也产出文件。
- **导入（append-only）**：只认 `version=1` 的 JSON；先 dry-run 出
  `added / skipped / conflict / invalid` 四类，**只有 `added>0 且 invalid===0` 才能确认**；
  按 `id` 去重，同 id 且导入记录**更新**只计入 `conflict`（**绝不覆盖**），更旧或相同计入 `skipped`；
  落盘时同一天多条按 `ts` 排序后一次物理追加，历史行一个字节都不改。
- **失败即整批不写**：文件不是合法 JSON / 版本不认识 / 任意一条记录字段非法 → 一个字节都不写
  （非法条目带 index + 中文原因给用户修正），不会出现「写了一半」的分片。
- **权限**：选文件用系统 picker、复制路径用 `Text.copyOption`，**不新增任何权限**。

> 与 §1 的关系：`exports/` 在 `git-repo/` 之外，因此**不属于**设备快照；导入不产生新的跨设备通道，
> 跨设备仍只靠 Git 同步（`devices/<deviceId>/`）。

## 9. AI fallback 诊断记录（内存，**不落盘**）

多源 fallback（`docs/AI-FALLBACK.md`）每次尝试都会产出一条诊断，用于设置页显示
「源名 / 原因 / 耗时」。它与本文件其它契约的关键区别：**永不持久化**。

- **不写** `preferences`、`devices/<deviceId>/`、`summaries/`、任何 JSONL；
- **不进** Git 同步载荷（因此不会跨设备、也不会被 pull 回来）；
- 只存在于内存：运行器返回的 `diagnostics` 数组 + 组件 `@Prop`，重启即失。

结构（`model/aiFallback.ts` 的 `FallbackDiagnostic`，字段全部必填）：

```ts
{ attempt: number,        // 第几次尝试（1 起）
  providerId: string,     // 源 id（预设表里的 id）
  modelId: string,        // 模型名
  outcome: 'success' | 'retry-same' | 'next-source' | 'abort',
  elapsedMs: number,      // 本次耗时（毫秒，非负整数）
  category: string,       // 'ok' | 'timeout' | 'network' | 'parse' | 'config'
                          // | 'auth' | 'rate-limit' | 'server' | 'bad-request' | 'unknown'
  message: string }       // 中文原因（已脱敏、≤200 字符）
```

写入前必经 `sanitizeDiagnostic`：

| 规则 | 处理 |
| --- | --- |
| `sk-…` | 整段替换成 `***` |
| `Bearer <凭据>` / `Basic <凭据>` | 整个「方案 + 凭据」替换成 `***` |
| `token=…` / `api_key=…` / `apiKey: "…"` | 含键名整段替换成 `***` |
| message 里残留的 `key` / `token` / `secret` 单词 | 替换成 `***` |
| message 长度 | 截断到 200 字符 |
| `elapsedMs` / `attempt` | 归一到非负整数；`outcome` 未知值归一成 `abort` |

**为什么不像日程那样落盘**：诊断的唯一用途是「这一次为什么换源」，事后复盘价值低，但一旦落盘就会
成为第二事实来源（还要处理同步冲突、跨设备 id、体积增长），并且更容易夹带 provider 错误体里的
凭据碎片。需要长期排障请用设置页的「测试连通性」（同样不落盘）与 `[ai] provider=… ok=…` 行为日志。

与本机设置的关系：`aiFallbackEnabled` / `aiFallbackMaxAttempts` / `aiFallbackOrder` 三个键
存在 `preferences`（本机，不进 Git），形态见 `docs/AI-FALLBACK.md` §4；诊断**不**存在那里。

## 10. chats/（云端对话，跨设备共享）

> 完整并发语义（续接流程、状态机、失败语义、隐私、分期）见 `docs/CHAT-SYNC.md`；本节只钉**数据形状**。
> 与 §1–§4 的根本区别：`chats/` 是**接管制**（同一会话同时只有一个写者），不是并写制。

```
<repo>/
  chats/                      # 跨设备共享命名空间（不是 devices/<deviceId>/）
    <sessionId>/
      meta.json               # 元信息 + 租约（小、常变，不值得塞进 JSONL）
      session.jsonl           # 明文 JSONL，只追加，行序即事件序
    index.jsonl               # 只追加的列表页投影
```

- **为什么共享命名空间**：会话要能被另一台设备**续接**，写者身份会变；放 `devices/<id>/` 等于把
  「谁写的」钉进路径，接管就得跨目录搬文件、历史随之断。`devices/` 的语义是「一机一目录、只写自己」
  （§1），与接管制冲突。
- **为什么明文 JSONL**：可 diff / 可评审、App 无需 zstd 解帧即可读、故障可 `git log -p` 直接定位；
  压缩交给 Git 的 zlib 与打包层。会话格式事实（header `version=4`、事件 `seq`）见
  `docs/RESEARCH-session-import.md` §3。
- **`meta.json` 字段**：`schemaVersion` / `sessionId` / `title` / `createdAt` / `updatedAt` / `model` /
  `messageCount` / `sha256`（明文 `session.jsonl` 整文件字节的 sha256）/ `deviceId` /
  `workspaceName`（**仅 workspace 末段名**）/ `lease`。**禁止** `cwd` 等绝对路径与任何凭据。
- **租约字段**：`lease: { owner, since, exp, beatAt }`（ISO 8601）。TTL **10 分钟**、心跳建议 **60s**，
  `exp = beatAt + 10min`，不变式 `since ≤ beatAt < exp`；只做区间比较，故跨机时钟偏差只会让判定偏保守。
  仅 `owner == 本机 deviceId` 时可写；过期不清视为「可接管」，不视为错误。
- **`index.jsonl`**：一行 `{id,title,updatedAt,messageCount,sha256}`，只追加；读侧**按 id 取最新一行**
  ——这是唯一允许「取最新」的地方（展示投影，不是事件流）；缺失时可退化为扫描 `chats/*/meta.json`。
- **与 `devices/` 的区别（一句话）**：`devices/` 是**单写者快照**（缺失视为空、sha256 只做传输校验、
  内容不合并，§1–§2）；`chats/` 是**共享事件流**（多端先后接管、同 id 同时只允许一个写者、
  冲突一律 fail-closed、**永不**按 `ts` 折叠）。日程的 `foldById` 折叠语义（§3）**不适用于** `session.jsonl`。

## 11. `devices/registry.jsonl`（设备编号登记表，App 写，跨设备共享）

> 目的：**用户不再填设备标识**（设置页主表单只留「仓库地址 + token + 分支」）。编号由仓库侧
> 自动分配，并发接入靠 push 抢占 + 重试。纯逻辑在
> `apps/arkui-schedule/entry/src/main/ets/model/deviceRegistry.ts`（Node 可直测）。

```
<repo>/
  devices/
    registry.jsonl                 # 只追加；每行一个 JSON；**不是** devices/<id>/ 里的文件
    device-1/
    device-2/
```

- **数据形状**：一行 `{"deviceId":"device-2","uuid":"<uuid>","at":"<ISO8601>","host":"<可选>"}`。
  `host` 只是排查线索（接入前的原标识），不含 token / 邮箱 / 机型等任何信息；为空时**不写该键**。
  一行内不嵌套、不带换行（`toRegistryLine` 逐字保证），因此可 `git diff` 逐行审阅。
- **身份 = `uuid`，`deviceId` 只是目录名**。`uuid` 由本机首次接入时生成一次
  （`settingsStore.deviceUuid`，与 §6.1 的 `.device-fingerprint` **同值**，二者指向同一个身份），
  之后永久复用。读表时**按 uuid 找自己的行**：命中即沿用那行的 `deviceId`，**不重复登记**。
  换机/清数据丢了 `uuid` 才会登记新行（老行保留，目录不删）。
- **只追加**：任何一方都不重写已有行。坏行（非 JSON / 缺字段 / 形态不合法）读侧**丢弃并计数**
  （`parseRegistry().errors`），不影响其它行；写侧永远只 append。
- **编号算法**：`nextDeviceId(devices/ 目录名 ∪ registry 里的 deviceId)` = **最大 `device-N` + 1**
  （不是「个数 + 1」）。空 → `device-1`；`['device-1','device-3']` → `device-4`。
  **空洞不回填**：编号不重排，`device-3` 删了也不会被新设备复用（外部脚本按「编号=设备数」推断会出错，
  回填还会和残留目录/旧 registry 行撞车）。
- **老设备不重编号**：本机已有 `deviceId` 且其 `devices/<id>/` 目录**已在仓库里**、registry 里也
  没有别的 uuid 占着 → 原样沿用（包括 `phone-a` 这种非 `device-N` 值，`deviceIdAuto=false`）。
  只有「目录不在仓库」（多半是默认值 `phone-a`）才走自动分配——否则新装的设备会抢同一个目录名。
- **并发接入 = push 抢占 + 重试**（`claimDeviceId`，fail-closed）：
  1. 先 `pull`（fast-forward only），registry 与目录名以远端为准；
  2. registry 有本机 `uuid` 的行 → 直接用（不写）；
  3. 否则算号 → 追加一行 → **只提交并推送 `devices/registry.jsonl`**（桥 op `commitPaths`，
     白名单只放行这一个路径；push 恒 `force:false`）；
  4. push 被拒（非快进 / 别人抢先）→ 桥**回滚**这次提交 → 重新 `pull` → 重算 → 重试，
     上限 **5 次**；仍失败 → `SyncError('E_DEVICE_ID_CONFLICT', '没能抢到设备编号，请稍后重试（已重试 5 次）')`，
     **不许**随便用一个号继续写（`push` 整体失败，不产生任何 `devices/<id>/` 提交）。
  5. 成功后写本机设置 `{deviceId, deviceIdAuto:true, deviceUuid}`，设置页显示只读一行
     「本机：device-2（自动分配）」。
- **为什么回滚提交**：只有 `registry.jsonl` 一个文件、且是「抢占失败」这一种情况才回滚；不回滚会让本地
  多出一个远端没有的提交，之后 `pull`（fast-forward）永远失败，重试失去意义。
- **失败可见**：仓库不可读 / 拉取失败给 `E_DEVICE_ID_UNREADABLE`；两种情况设置页都会**自动展开**
  「高级 ▸」并显示原因（另外两种自动展开：设备标识重复、Gitee 用户名推不出来）。
- **与 `devices/<id>/` 的关系**：登记表是**唯一**允许写 `devices/` 顶层（非自己的 `<id>/`）的文件；
  其它文件仍然只写本机目录（§6 的提交范围不变量不变）。
