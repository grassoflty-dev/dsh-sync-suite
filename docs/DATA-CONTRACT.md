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
    pc-b/                  # 同上
    phone-a/
      schedules/2026-11-14.jsonl
      attachments/<sha256>.png
```

- 每台设备**只写自己的目录**；读取其他目录用 `git fetch`/`pull` 后只读展示。
- 文件缺失视为空；`manifest.json` 是快照的权威索引（sha256 用于传输校验，不做内容合并）。
- 快照目录名 `deviceId` 必须匹配 `^[a-z0-9][a-z0-9-]{0,31}$`。

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
| `getState` | `{}` | `{settings, status, snapshots}` |
| `saveSettings` | `{settings, token?}` | `{settings, hasToken}` |
| `testConnection` | `{}` | `{reachable, branch, headSha, message}` |
| `push` | `{}` | `{pushed, commit, branch, files, rebased}` |
| `preview` | `{}` | `{previewId, sources}` |
| `apply` | `{confirm:true, previewId, sourceDevice, entries:string[]}` | `{applied, skipped, snapshotId, verified:true}` |
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

`status`：`{reachable, branch, headSha, headMessage, headTime, localPending, remotePending, conflict, lastSyncAt, error?}`。
`snapshots`：`[{id, time, reason, bytes}]`（写前恢复快照，保留最近 10 份）。
`preview.sources[]`：`{deviceId, headSha, files:[{name,sha256,bytes}], entries:[{id,name,status:'added'|'changed'|'same'|'manual',localText,remoteText,secretStripped}], plugins:{install,keep,skip,noDowngrade}, providers:{added,changed,same}, mcp:{added,changed,same}}`。

错误码：`E_VALIDATION`、`E_CONFIRM_REQUIRED`、`E_UNKNOWN_ACTION`、`E_NOT_FOUND`、`E_GIT`、`E_AUTH`、
`E_CONFLICT`、`E_SHA_MISMATCH`、`E_IO`。

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

手机只写 `devices/<自己>/schedules/*.jsonl` 与 `attachments/*.png`，提交推送到同一远端；
其它设备目录只读。冲突策略：设备目录互不重叠，不需要 merge；同 id 记录按 ts 折叠。
