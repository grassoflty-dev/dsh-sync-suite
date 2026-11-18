# 数据契约（DATA-CONTRACT）

本文件定义三处持久化契约：**Git 仓库目录结构**、**日程 JSONL**、**插件 RPC**。
跨设备互通以本文件为准；实现见 `packages/dsh-git-config-sync` 与 `apps/arkui-schedule`。

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

`POST /dsh-git-config-sync/rpc`，请求 `{action, ...}`，响应恒 HTTP 200：

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
%USERPROFILE%\.dsh\git-config-sync\
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
电脑端由 `dsh-git-config-sync` 的 `schedule_*` 工具只写 `devices/<pcId>/schedules/`（见 `docs/SCHEDULE-BRIDGE.md`）。

## 7. 远程访问域（`src/remote/**`，本机，不进 repo）

**与 Git 仓库零交集**：远程访问域不写 `devices/<id>/` 下任何文件，也不同步到远端。
它只碰本机状态目录下的两个**新增**文件：

```
%USERPROFILE%\.dsh\git-config-sync\
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
