# 实施契约（CONTRACT v1）

> 唯一需求基准是 `C:\Users\GWL\Desktop\itwillclaude\dsh-sync-suite\BRIEF.md`。
> 本文件只细化**接口、文件名、数据形状、验收命令、文件所有权**；与 BRIEF 冲突时以 BRIEF 为准，
> 并把冲突报告给 Planner（不要自行改需求）。

## 0. 环境与纪律

- 平台：Windows + PowerShell 7（无 bash）、Node v24.14、pnpm 11.22、git 2.53。
- 工作根：`C:\Users\GWL\Desktop\itwillclaude\dsh-sync-suite`。只在根内写文件。
- 禁止：修改 `C:\Users\GWL\.dsh\profiles\**`、调用 `plugin_manager`、对 profile 做 pnpm 操作、派生任何子代理。
- 禁止运行时代码依赖 npm 包（插件只用 `node:` 内置模块；应用模型层纯 TS）。
- 密钥永不进入同步载荷、日志、测试 fixture。测试用明显的假值（如 `test-token-not-real`）。
- 所有写操作必须幂等/可重跑；测试用临时目录，不碰真实 `%USERPROFILE%\.dsh`。
- 代码/文档一律 UTF-8 无 BOM、LF 换行。
- TypeScript 使用 NodeNext：`src/` 内相对 import **必须带 `.js` 后缀**（如 `./engine/patch.js`）。

## 1. 文件所有权（避免并行冲突）

| 范围 | 所有者 | 文件 |
| --- | --- | --- |
| 根 | Planner | `package.json`、`.gitignore`、`.gitattributes`、`tools/build.mjs`、`tools/init-remote-repo.mjs`、`README.md`、`docs/**`、`devices/**`、`pnpm-lock.yaml` |
| 插件骨架 | Planner | `packages/dsh-dots/{package.json,tsconfig.json,cordis.patch.yml,scripts/build.mjs}` |
| 插件 host | 执行者 H | `packages/dsh-dots/src/{index.ts,rpc.ts,engine/**}`、`packages/dsh-dots/test/**` |
| 插件 client | 执行者 C | `packages/dsh-dots/src/client.js`、`locale/en.json`、`locale/zh.json`、`icon.svg`、`README.md`、`docs/DETAIL.md`（插件内） |
| 应用骨架+模型 | 执行者 A | `apps/arkui-schedule/{AppScope/**,build-profile.json5,hvigorfile.ts,oh-package.json5,entry/{build-profile.json5,hvigorfile.ts,oh-package.json5,src/main/module.json5,src/main/resources/**}}`、`entry/src/main/ets/model/**`、`entry/src/main/ets/common/**`、`apps/arkui-schedule/tools/**` |
| 应用 UI | 执行者 U（第二批） | `entry/src/main/ets/pages/**`、`entry/src/main/ets/components/**`、`entry/src/main/ets/entryability/**`、`entry/src/main/ets/platform/**` 覆盖文件、`entry/src/harmony/ets/**`、`entry/src/android/ets/**` |
| 应用 Git 桥 | 执行者 G（第二批） | `entry/src/main/resources/rawfile/git/**`、`entry/src/main/ets/services/GitSyncService.ets` |

执行者只能写自己表格里的文件；需要别的文件改动时在报告里写给 Planner。

## 2. 交付物 A：`dsh-dots`

### 2.1 状态与路径（全部可注入，便于测试）

`src/engine/paths.ts`：

```ts
export interface StatePaths {
  root: string            // %USERPROFILE%\.dsh\dots
  settingsFile: string    // ...\settings.json
  credentialsFile: string // ...\credentials.json
  workRoot: string        // ...\work
  snapshotRoot: string    // %USERPROFILE%\.dsh\vet\restore-snapshots
  pendingFile: string     // ...\plugins.to-install.json
}
export function statePaths(homeDir?: string): StatePaths
export function repoHash(repoUrl: string): string   // sha256 hex 前 16 位
```

- 工作副本：`<workRoot>\<repoHash(repoUrl)>`。
- profile 目录默认 `%USERPROFILE%\.dsh\profiles\web`，可用环境变量 `DSH_PROFILE_DIR` 覆盖；
  `createRpcService({ profileDir })` 可显式注入。
- 权限：`settings.json` / `credentials.json` 只允许当前用户（Windows 用 `chmod 0600` 语义不可靠时
  至少创建时 `{ mode: 0o600 }` 并避免写入日志）。

### 2.2 Host 模块（必须导出这些名字与语义，允许增加内部辅助）

`engine/types.ts`：

```ts
export type SyncFileName = 'cordis.patch.yml' | 'providers.json' | 'plugins.json' | 'mcp.json'
export type Platform = 'github' | 'gitee' | 'custom'
export interface SyncScope { config: boolean; providers: boolean; plugins: boolean; mcp: boolean }
export interface SyncSettings { repoUrl: string; platform: Platform; authMode: 'https' | 'ssh'; deviceId: string; branch: string; scope: SyncScope }
export interface HeadInfo { sha: string; message: string; time: string }
export interface SnapshotMeta { id: string; time: string; reason: string; bytes: number }
export interface DeviceManifest { deviceId: string; time: string; scopes: SyncScope; dshVersion: string; files: Array<{ name: SyncFileName; sha256: string; bytes: number }> }
export interface PluginEntry { name: string; version: string; source: string; enabled: boolean }
export interface RpcErrorBody { code: string; message: string; details?: unknown }
export type RpcResponse<T = unknown> = { ok: true; data: T } | { ok: false; error: RpcErrorBody }
```

`engine/errors.ts`：`class SyncError extends Error { code: string; details?: unknown }`、`toRpcError(e: unknown): RpcErrorBody`。

`engine/patch.ts`（核心：逐条合并，保住注释与 `!!js`）：

```ts
export interface PatchEntry { key: string; id: string | null; kind: 'config' | 'insert' | 'other'; raw: string; header: string[] }
export interface PatchDocument { preamble: string[]; entries: PatchEntry[] }
export function parsePatch(text: string): PatchDocument
export function serializePatch(doc: PatchDocument): string
export interface MergedEntry { key: string; name: string; status: 'added' | 'changed' | 'same' | 'manual'; localText: string; remoteText: string; secretStripped: boolean }
export function mergePatch(localText: string | null, remoteText: string | null): { text: string; entries: MergedEntry[] }
```

patch 文件是 profile 的顶层 YAML 数组（已核实格式）：

```yaml
# 文件头注释
- id: llm-pi-ai
  config:
    providers: ...
- insert:
    - id: dsh-git-sync
      name: 'dsh-git-sync'
```

- 条目切分：顶层 `- ` 开头的 YAML 序列项；项内缩进全保留。
- key 规则：顶层 `id:` → 该 id；`insert:` → `insert:<内部第一个 - id>`；否则 `entry:<序号>`。
- 合并规则：本地顺序为准；本地独有保留；远端独有追加到末尾（连同其前置注释）；同 key 文本不同 →
  `changed`（采用远端整块原文）；相同 → `same`；远端块含 `__SECRET__` 且与本地不同 → `manual`
  （不得自动覆盖，需本地填写）。
- `serializePatch` 输出必须与输入字节等价（round-trip 测试）：preamble/entry 原样拼接，文件末尾恰好一个换行。
- 空文件/null 输入按空文档处理。

`engine/secrets.ts`：

```ts
export const SECRET_PLACEHOLDER = '__SECRET__'
export const SECRET_KEY_RE: RegExp
export function stripSecretsDeep(value: unknown): { value: unknown; paths: string[] }
export function restoreSecretsDeep(remote: unknown, local: unknown): { value: unknown; needsLocal: string[] }
export function stripPatchSecrets(text: string): { text: string; stripped: number }
export function restorePatchSecrets(remoteText: string, localText: string): { text: string; needsLocal: string[] }
```

- key 判定用 `isSecretKey(key)`（词边界，非子串）：把 key 按 `_`/`-`/`.`/camelCase 切词后，
  命中精确词 `token`/`secret`/`password`/`authorization`/`bearer`，或相邻词 `api`+`key`
  （`apiKey`/`api_key`）；`maxTokens`（复数 tokens）、`apiKeyEnv`（尾部 env 是环境变量名）
  **不得**判为密钥。
- 对象/数组递归；命中 key 的标量替换为 `__SECRET__`；字符串内嵌 `Bearer xxx` 不处理（避免误伤）。
- patch 文本按行处理：`key: value` / `key = value`，保留行内 `#` 注释；`!!js` 表达式若含 secret 键同样替换为占位符。
- restore：**按 key 名**在同一条 entry 内回填本地同名值（不得按出现顺序错配）；本地没有 → 保留占位符，记入 `needsLocal`。

`engine/pluginMerge.ts`：

```ts
export interface PluginMergeResult { install: PluginEntry[]; keep: PluginEntry[]; skip: Array<{ name: string; reason: string }>; noDowngrade: Array<{ name: string; localVersion: string; remoteVersion: string }> }
export function compareVersions(a: string, b: string): number
export function mergePluginManifests(local: PluginEntry[], remote: PluginEntry[]): PluginMergeResult
```

规则：远端有本地无 → `install`；本地有远端无 → `keep`（永不删）；同名：远端版本 > 本地 → `install`（升级），
本地更高 → `noDowngrade`，相同 → `keep`；来源不可解析 → `skip`。同步内容只含清单，不含代码/node_modules。

`engine/snapshot.ts`：

```ts
export interface RestoreSnapshot { id: string; time: string; reason: string; files: Record<string, string>; meta: Record<string, unknown> }
export class SnapshotStore { constructor(root: string); create(reason: string, files: Record<string, string>, meta?: Record<string, unknown>): SnapshotMeta; list(): SnapshotMeta[]; get(id: string): RestoreSnapshot; prune(keep?: number): SnapshotMeta[] }
```

目录：`<root>\<YYYYMMDD-HHmmss>[-n]\`，内含 `files/<name>` 与 `manifest.json`（含 sha256/bytes）——
`manifest.json` 由 restore 阶段写，快照接口只要求 `create/list/get` 可用。保留最近 10 份（prune）。

`engine/git.ts`：

```ts
export interface GitRepoOptions { dir: string; repoUrl: string; branch: string; authMode: 'https' | 'ssh'; token?: string | null; allowLocalRepo?: boolean; env?: NodeJS.ProcessEnv }
export class GitRepo {
  constructor(options: GitRepoOptions)
  ensureWorkTree(): Promise<{ cloned: boolean }>
  lsRemote(): Promise<{ reachable: boolean; branch: string; headSha: string; message: string }>
  head(): Promise<HeadInfo>
  status(): Promise<{ branch: string; clean: boolean; changed: string[]; ahead: number; behind: number }>
  pullRebase(): Promise<{ rebased: boolean }>
  commitAll(message: string): Promise<{ commit: string; files: string[] }>
  push(): Promise<{ pushed: boolean; rebased: boolean }>
  pushWithRebase(): Promise<{ pushed: boolean; rebased: boolean }>   // 非 fast-forward 先 pull --rebase，最多 2 次，永不 force
  log(limit: number): Promise<Array<{ sha: string; message: string; time: string }>>
}
```

- 全部用 `node:child_process.execFile('git', args, { cwd, env })`；禁止 shell 拼接。
- 提交身份用 `-c user.name=dsh-dots -c user.email=sync@localhost`，不依赖全局配置。
- HTTPS token：创建临时 `GIT_ASKPASS` 脚本（0600，`#!/bin/sh` + `printf`，token 走环境变量
  `DSH_GIT_SYNC_TOKEN`），`GIT_TERMINAL_PROMPT=0`；token **不得**出现在 argv/配置文件/日志。
  SSH 直接用系统 ssh-agent（不写私钥）。
- `allowLocalRepo: true` 仅供集成测试放行本地路径/`file://`；默认只接受 `https://`、`ssh://`、`git@host:path`。

`engine/collect.ts`：

```ts
export interface CollectInput { profileDir: string; homeDir?: string; deviceId: string; scopes: SyncScope; dshVersion?: string; now?: Date }
export function collectLocal(input: CollectInput): { files: Record<SyncFileName, string>; manifest: DeviceManifest; warnings: string[] }
```

- `cordis.patch.yml`：读 profile 原文件 → `stripPatchSecrets` → 作为快照内容（保留注释/`!!js`）。
- `providers.json`：`{ providers: { [id]: sanitizedDefinition } }`，从 patch 中含 `providers:` 的条目提取。
- `mcp.json`：`{ entries: [{ id, text }] }`，从 id/name 含 `mcp`（不区分大小写）的 patch 条目提取（已脱敏）。
- `plugins.json`：`{ plugins: PluginEntry[] }`，来自 `<profileDir>/package.json` 的 dependencies +
  `node_modules/<name>/package.json` 的 version（取不到则用声明值）+ patch `insert` 行判断 enabled。
- `manifest.json`：对上述每个文件算 sha256/bytes，含 deviceId/time/scopes/dshVersion。
- 文件缺失按空内容处理并写入 warnings；**绝不写 profile**。

`engine/preview.ts` + `engine/restore.ts`：

```ts
export interface PreviewEntry { id: string; name: string; status: 'added' | 'changed' | 'same' | 'manual'; localText: string; remoteText: string; secretStripped: boolean }
export interface PreviewSource { deviceId: string; headSha: string; files: Array<{ name: string; sha256: string; bytes: number }>; entries: PreviewEntry[]; plugins: PluginMergeResult; providers: { added: string[]; changed: string[]; same: string[] }; mcp: { added: string[]; changed: string[]; same: string[] } }
export interface PreviewResult { previewId: string; sources: PreviewSource[] }
export interface ApplyResult { applied: Array<{ id: string; fileSha256: string; blockSha256: string; path: string }>; skipped: Array<{ id: string; reason: string }>; snapshotId: string; verified: true; pluginPlan?: PluginMergeResult }
```

- preview 读取远端仓库 `devices/<deviceId>/` 快照，与本地 collect 结果比对；预览缓存内存保存（TTL 10 分钟，
  单实例只保留一个 previewId）。preview 本身不写任何文件。
- apply 顺序（fail-closed）：
  1. `confirm !== true` → `E_CONFIRM_REQUIRED`，不落盘；
  2. 校验 previewId 存在且未过期、sourceDevice、entries 非空且都是预览里 `added|changed|manual` 的 id；
  3. 写前快照（SnapshotStore）到 `%USERPROFILE%\.dsh\vet\restore-snapshots\<timestamp>\`（含当前 profile 文件）；
  4. 只改 `cordis.patch.yml`：以当前本地 patch 为底，仅把勾选条目替换为远端块（先 `restorePatchSecrets`
     回填本地 secret，缺本地值 → 该条进 skipped，不写占位符覆盖）；
  5. 原子写（临时文件 + rename），写后重算整文件 SHA-256 与预期比对；不一致 → 用快照回滚并抛 `E_SHA_MISMATCH`；
  6. 返回 `applied`（每条 patch entry 一项，path 为 profile patch 绝对路径）、`skipped`、`snapshotId`、`verified: true`。
- 插件清单只做 MERGE-only 计划：写 `<pendingFile>` 供用户手动安装，不执行 pnpm/不修改 profile package.json；
  `pluginPlan` 结果同时返回；`skipped` 里加 `{id:'plugins', reason:'manual-install-required'}`。
- rollback：`{snapshotId, confirm:true}` → 从快照恢复写回、SHA 校验，返回 `{restored, verified:true}`；
  快照不存在 → `E_NOT_FOUND`。

`rpc.ts`：

```ts
export interface RpcServiceOptions {
  homeDir?: string; profileDir?: string; dshVersion?: string; allowLocalRepo?: boolean;
  now?: () => Date;
  hooks?: { verifySha256?: (filePath: string, expected: string) => Promise<boolean>; writeProfileFile?: (filePath: string, content: string) => Promise<void> };
}
export interface RpcService { paths: StatePaths; handleRpc(body: unknown): Promise<RpcResponse>; dispose(): Promise<void> }
export function createRpcService(options?: RpcServiceOptions): RpcService
export function createHttpHandler(service: RpcService, connection?: { requestRejection(req: unknown): number | null | undefined }): (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void
```

- `handleRpc` 用 `switch (action)`，未知 action → `E_UNKNOWN_ACTION`；校验失败 → `E_VALIDATION`；
  写操作串行队列（Promise chain），读操作可与写并发但不得读到半写状态。
- HTTP 层：读 body（上限 10 MB）→ JSON.parse → handleRpc → 200 + `{ok,...}`；鉴权拒绝由
  `connection.requestRejection(req)` 返回状态码处理（401/403 直接 end）。
- `index.ts`：`export const inject = ['webServer', 'connection']`；
  `export function apply(ctx, config = {})`：`ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/dsh-dots/rpc', handler }))`，
  handler 开头执行 `const rej = ctx.connection.requestRejection(req); if (rej) { res.statusCode = rej; res.end(); return }`。
  用 `config` 支持注入 `homeDir/profileDir/dshVersion`；dispose 时清理 preview 缓存与临时 askpass 文件。

### 2.3 RPC 契约（A/B 两侧必须完全一致）

`POST /dsh-dots/rpc`，body `{ action, ... }`，响应 HTTP 200 + `{ok:true,data}` 或
`{ok:false,error:{code,message,details?}}`；仅鉴权失败用 401/403。

| action | 请求 | data |
| --- | --- | --- |
| `getState` | `{}` | `{settings, status, snapshots}`（**只读本地，不联网**） |
| `saveSettings` | `{settings, token?}` | `{settings, hasToken}` |
| `testConnection` | `{}` | `{reachable, branch, headSha, message}` |
| `push` | `{}` | `{pushed, commit, branch, files, rebased}` |
| `preview` | `{}` | `{previewId, sources}` |
| `apply` | `{confirm:true, previewId, sourceDevice, entries:string[]}` | `{applied:[{id,fileSha256,blockSha256,path}], skipped, snapshotId, verified:true}` |
| `listSnapshots` | `{}` | `{snapshots}` |
| `rollback` | `{snapshotId, confirm:true}` | `{restored, verified:true}` |

`getState.status`：`{reachable: true|false|null, branch, headSha, headMessage, headTime, localPending: number|null, remotePending: number|null, conflict, lastSyncAt, error?}`；
`reachable` 三态中 `null` = 本机尚未探测过（网络失败的最近结果才记 `false`）；`localPending`/`remotePending`
基于本地 `origin/<branch>` 引用计算，无 upstream 引用时为 `null`；`getState` 不发起任何 git 网络操作，
`error` 只表示本地读取失败。`conflict` 为远端分叉（ahead>0 且 behind>0）。
`apply.applied[]`：`fileSha256` 是写后整个 profile patch 的 SHA-256（落盘校验），`blockSha256` 是该 entry 合并后文本的
SHA-256（条目追踪），两者语义不同、不得混用。
网络操作只在 `testConnection`/`push`/`preview` 发生，单次 git 网络调用 ≤8s 超时。
`saveSettings` 校验：repoUrl（仅 https/ssh/git@，`custom` 平台同样受限）、deviceId `^[a-z0-9][a-z0-9-]{0,31}$`、
branch 非空；token 空字符串表示保留现有 token，`null` 表示清除。
所有错误 code 至少包含：`E_VALIDATION`、`E_CONFIRM_REQUIRED`、`E_UNKNOWN_ACTION`、`E_NOT_FOUND`、
`E_GIT`、`E_AUTH`、`E_CONFLICT`、`E_SHA_MISMATCH`、`E_IO`。

### 2.4 客户端 UI（`src/client.js`，纯 JS，不需要构建）

严格按 BRIEF §2.2 的 `window.__ModuleLoader__.load({ id:'dsh-dots', factory(require){...} })`
形态；`inject: ['slots','locale']`；注册 locale（NS=`dots`）与**唯一** `settings.section`
（`id:'dots'`, `order:70`, label `DSH-dots`）。三套命名空间互不干涉：loader id 是包名
`dsh-dots`（由 `scripts/build.mjs` 生成）；slot / panel id 是 `dots`，`dots-remote` 只能是
单页内部的折叠分组 id，不再注册 section；RPC 路径是 `/dsh-dots/rpc`。组件 props 含 `t`、`close`。

内容（BRIEF §2.5 全部覆盖）：仓库配置（平台 GitHub/Gitee/custom、仓库地址、认证方式 HTTPS/SSH、设备标识、
分支）、同步范围四项默认全选、状态徽标（本地/仓库/待上传/待下载/冲突 + 分支 + 最近提交）、按钮
（保存设置/测试连接/推送/拉取预览/执行覆盖（未预览不可点）/历史回滚）、逐条差异勾选（采纳远端/保留本地）、
插件 MERGE-only 展示、快照列表与回滚、内联错误；Token `type=password`。

- 所有 fetch 用同源 `/dsh-dots/rpc`；错误展示 `error.code + message`。
- 样式只用 `--dsw-alias-*` 变量与内联样式，不引第三方 UI 库。
- 组件卸载时取消异步 setState（用 disposed 标志）。
- locale：`locale/en.json`、`locale/zh.json` 顶层含 `meta.title`/`meta.description`/`meta.detail`
  与全部 UI key；两份 key 集合必须完全一致（host 测试 `test/locale.test.mjs` 会检查）。
- `icon.svg` 原创、16:16、无外部引用。

### 2.5 测试（执行者 H 负责，`node --test`，不依赖网络）

必测（文件名固定，便于验收）：

- `test/patch-merge.test.mjs`：逐条合并保注释/`!!js`/本地独有；增删改 same/manual 状态；round-trip。
- `test/secrets.test.mjs`：`stripSecretsDeep`/`restoreSecretsDeep`；patch 行级脱敏与回填；
  `__SECRET__` 不出现在 push 载荷。
- `test/plugin-merge.test.mjs`：MERGE-only、不降级、不删除。
- `test/confirm-gate.test.mjs`：无 `confirm:true` → `E_CONFIRM_REQUIRED` 且文件字节不变。
- `test/sha-verify.test.mjs`：注入 `hooks.verifySha256` 强制失败 → 回滚到快照原内容 + `E_SHA_MISMATCH`。
- `test/integration-git.test.mjs`：临时裸仓库（`git init --bare -b main`）+ 两个临时 home/profile，全链路
  push → 另一设备 pull → preview → apply → rollback；断言 profile 只有被勾选条目变化、注释保留。
- `test/locale.test.mjs`：en/zh key 集合一致且含 `meta.*`。

测试只 import `../dist/**`（构建后运行）。CI 命令：`pnpm build && node --test "packages/dsh-dots/test/*.test.mjs"`（Node 24 的 `--test` 目录参数会报 MODULE_NOT_FOUND，必须用 glob）。

### 2.6 交付资源

`locale/{en,zh}.json`、`docs/DETAIL.md`（插件详情页，中文）、`icon.svg`、插件 `README.md`。

## 3. 交付物 B：`apps/arkui-schedule`

### 3.1 目录与平台覆盖约定

```
apps/arkui-schedule/
  AppScope/app.json5, AppScope/resources/base/element/string.json
  build-profile.json5, hvigorfile.ts, oh-package.json5
  entry/build-profile.json5, entry/hvigorfile.ts, entry/oh-package.json5
  entry/src/main/module.json5
  entry/src/main/resources/base/element/{string,color}.json
  entry/src/main/resources/base/media/{icon.png,...}
  entry/src/main/resources/base/profile/main_pages.json
  entry/src/main/resources/rawfile/git/{isomorphic-git.js,git-bridge.js,index.html}
  entry/src/main/ets/
    entryability/EntryAbility.ets          # 共享，调 platformFeatures
    pages/{Index,Edit,Detail,Settings}.ets # 共享 4 页
    components/                            # 共享组件（无 OCR/手写/Canvas 截图）
    model/{types,jsonl,sha256,attachments,aiPayload,reminder}.ts   # 纯逻辑，禁 @ohos / UI import
    common/{platform,date,features}.ts
    services/{scheduleStore,deepseek,attachmentStore}.ets          # @ohos 存储/网络（共享）
    platform/platformFeatures.ts            # 平台覆盖文件（见下）
  entry/src/harmony/ets/                    # 鸿蒙专属覆盖层
    platform/platformFeatures.ts            # handwriting=true, ocr=true
    pages/Handwriting.ets                   # Canvas 分页手写板 + 识别入口
    ocr/OcrBatchManager.ets
    handwriting/HandwritingPager.ets
    reminder/ReminderService.ets
    resources/base/profile/main_pages.json  # 共享 4 页 + pages/Handwriting
  entry/src/android/ets/platform/platformFeatures.ts   # handwriting=false, ocr=false
  tools/{tsconfig.json,stubs/ohos.d.ts,json5.mjs,validate-app.mjs,test/*.test.mjs}
```

平台覆盖语义：构建某平台时源码 = `main` + 该平台目录，**同名相对路径以后者为准**；平台目录新增文件仅该平台可见。
`main_pages.json`（main）只列共享 4 页；harmony 版追加 `pages/Handwriting`。Android 侧因此完全不编译
手写/OCR/PixelMap/Canvas 代码。`module.json5` 的 `srcEntry` 用 `ets/entryability/EntryAbility.ets`。

### 3.2 纯逻辑模型 API（`.ts`，Node 可导入，禁 UI/@ohos）

`model/types.ts`：

```ts
export interface Attachment { sha256: string; name: string; pageIndex: number }
export interface ScheduleRecord {
  id: string; ts: string; title: string; body: string; ocr_text?: string;
  author: string; done: boolean; attachments?: Attachment[];
  ai_structured?: string; ai_processed: boolean; ocr_time?: string
}
export interface AiPayload { date: string; records: Array<{ id: string; ocr_time: string; text: string }> }
```

`model/jsonl.ts`：

```ts
export function encodeRecord(record: ScheduleRecord): string          // 单行 JSON + '\n'
export function decodeLine(line: string): ScheduleRecord | null
export function parseJsonl(text: string): { records: ScheduleRecord[]; errors: Array<{ line: number; message: string }> }
export function appendRecord(text: string, record: ScheduleRecord): string
export function foldById(records: ScheduleRecord[]): ScheduleRecord[]  // 同 id 后者覆盖（ts 升序稳定）
export function byDate(records: ScheduleRecord[], date: string): ScheduleRecord[]
export function sortRecords(records: ScheduleRecord[]): ScheduleRecord[]
```

`model/sha256.ts`：`export function sha256Hex(input: string | Uint8Array): string`（纯实现，测试对标准向量）。

`model/attachments.ts`：

```ts
export function attachmentFileName(sha256: string): string      // `${sha256}.png`
export function buildAttachmentRefs(pages: Array<{ sha256: string; name: string; pageIndex: number }>): Attachment[]
export function concatPageTexts(results: string[]): string      // 0→N，换行连接，空页跳过
export const STRUCTURED_PLACEHOLDER = '[公式/图表: 查看手迹]'
export function replaceComplexBlocks(ocrText: string): string   // 表格/公式/LaTeX 行 → 占位符
```

`model/aiPayload.ts`：

```ts
export function buildAiPayload(date: string, records: ScheduleRecord[]): AiPayload   // 只取 ai_processed=false
export function buildAiPrompt(payload: AiPayload, nowIso: string, timeZone: string): string
export function applyAiResult(records: ScheduleRecord[], structuredById: Record<string, string>, processedIds: string[]): ScheduleRecord[]
```

`applyAiResult` 只写 `ai_structured` + `ai_processed:true`，**永不改** `ocr_text`。
`model/reminder.ts`：`export interface ReminderPlanItem { id: string; title: string; dateTime: string }`、
`export function buildReminderPlan(records: ScheduleRecord[], nowIso: string, maxCount?: number): ReminderPlanItem[]`（默认 ≤30，只取未来未完成）。

`common/platform.ts`（纯，不 import @ohos）：

```ts
export type PlatformName = 'harmony' | 'android'
export function setPlatform(name: PlatformName): void
export function getPlatform(): PlatformName
export function isHarmonyOS(): boolean
```

默认从 `globalThis.__arkuiXPlatform` 读取，未设置时 `'harmony'`；EntryAbility 启动时显式 `setPlatform`。

`common/date.ts`：`localDateKey(date: Date): string`（本地时区 YYYY-MM-DD）、`nowIso()`、`formatClock(iso)`。
`common/features.ts`：`export interface ScheduleFeatures { handwriting: boolean; ocr: boolean }`、
`setFeatures`/`getFeatures`（默认 false）。

### 3.3 存储与同步

- 时间目录：`<filesDir>/git-repo/devices/<deviceId>/schedules/YYYY-MM-DD.jsonl`；附件
  `<filesDir>/git-repo/devices/<deviceId>/attachments/<sha256>.png`（sha256 去重命名）。
- 追加写，绝不重写历史行；读多设备目录时 `parseJsonl` + `foldById`。
- GitHub 同步用 Web 组件 + `isomorphic-git@1.25.3`（真实下载到 `rawfile/git/isomorphic-git.js`）
  + `git-bridge.js`（clone/fetch/pull/push/status/log + fs/http 桥）；ArkTS 侧 `GitSyncService.ets` 通过
  `registerJavaScriptProxy` 暴露 `dshGitHost.readFileBase64/writeFileBase64/httpRequest/onEvent`，
  HTTP 桥用 `@ohos.net.http`，二进制 base64。只写自己设备目录，永不 merge 他人分支。
- 每日 AI 汇总手动触发（列表页底部按钮）：读当天 `ai_processed:false` → 可取消勾选 → POST DeepSeek
  `https://api.deepseek.com/chat/completions`（模型 `deepseek-chat`，key 存设置页）；载荷
  `{date, records:[{id, ocr_time, text}]}`；提示词注入当前时间与时区；结果回写同上。
  定时汇总默认关闭并注释说明鸿蒙 `setInterval` 后台回收、需长时任务+通知。
- 提醒：`reminderAgentManager` 日历提醒（`ohos.permission.PUBLISH_AGENT_REMINDER`，单应用 ≤30 条），
  未获批降级 `notificationManager`；文档写清 AGC 开放能力申请 + 手动签名 + 约 8 工作日。

### 3.4 页面（执行者 U）

- `Index`：日期选择 + 今日待办/全部未完成切换 + 列表（左勾选 / 中标题+截止 / 右 📎 手迹）+ 底部
  「AI 汇总」「同步」入口。
- `Edit`：标题/正文/记录者/完成情况四字段；正文 `TextArea` 与「手写板」切换（`isHarmonyOS()` 才显示）；
  手写完成回填正文（`AppStorage['handwriting.result']`，`onPageShow` 读取并清除）。
- `Detail`：AI 结构化可编辑（`TextArea`）+ 原始 OCR 只读 + 截图全屏预览 + 附件哈希列表。
- `Settings`：设备标识、仓库 URL、token、AI key、同步按钮、平台信息（README 中说明 AGC 步骤）。
- 每个含 `struct` 的 `.ets` 必须有 `@crossplatform`；所有页面/组件遵循 `--` 主题色 `#007DFF` 等基础样式。

### 3.5 验证脚本（执行者 A）

`apps/arkui-schedule/tools/validate-app.mjs`（支持 `--root <dir>` 便于测试；默认自身上一级）：

1. 所有 `.json5`/`.json` 可解析（内置 JSON5 子集解析器 `tools/json5.mjs`：注释、尾逗号、单引号、无引号 key）。
2. 所有 `.ets` 相对 import（`from './x'`/`'../x'`）可解析（候选：main/ets、harmony/ets、android/ets；
   依次尝试原样/`.ets`/`.ts`/`/index.ets`）；main 文件的 import 不得只在 harmony 目录解析成功（保证 Android 可编译）。
3. `main_pages.json` 与 pages 目录一致；harmony 版 main_pages 是超集且文件存在。
4. Android 可见文件（main/ets + android/ets）不得 import/引用 `ocr/`、`handwriting/`、`OcrBatch`、`PixelMap`、
   `@ohos.multimedia.image`；也不得引用仅在 harmony 存在的模块。
5. 任何含 `struct` 的 `.ets` 必须含 `@crossplatform`。
6. `rawfile/git/isomorphic-git.js`、`git-bridge.js` 存在且非空（isomorphic-git ≥100 KB）；
   含 `index.html` 时检查脚本引用。
7. `module.json5` 的 srcEntry/页面 profile 引用存在；资源 icon 引用文件存在。

失败以非零退出并打印 `❌ 规则` 明细，成功打印 `✅` 汇总。

`tools/tsconfig.json`：编译 `entry/src/main/ets/model/**/*.ts` + `common/**/*.ts` 到 `tools/.build/`
（`module: ESNext`, `target: ES2021`, `strict`, `rootDir: entry/src/main/ets`, `outDir: .build`,
`types: []`），不得包含 `.ets`/`services`；为 `@ohos.*` 写最小 stub `tools/stubs/ohos.d.ts`
（模型层实际不 import，仅 tsc 检查 `services` 时可用）。

`tools/test/*.test.mjs`：`jsonl.test.mjs`、`sha256.test.mjs`、`attachments.test.mjs`、`aiPayload.test.mjs`、
`platform.test.mjs`、`validate.test.mjs`（用临时目录 fixture 测 validate 各规则）。
测试 import `../.build/model/*.js`；先构建再测。

### 3.6 rawfile/git（执行者 G）

- 真实下载 `isomorphic-git@1.25.3` 的 UMD 构建（`npm pack` 解包后取 dist 中 UMD 文件，重命名
  `isomorphic-git.js`），不得手写占位。
- `git-bridge.js` 暴露 `globalThis.DshGitBridge`：`clone/fetch/pull/push/status/log`，注入
  `fs`（ArkTS proxy 的 base64 文件读写）与 `http`（ArkTS proxy 的 httpRequest）；错误统一
  `{ok:false,code,message}`。
- `index.html` 依次加载两者，`window.dshGitHost.onEvent(json)` 回传结果。

## 4. 验收命令（Planner 最终执行）

在仓库根 `C:\Users\GWL\Desktop\itwillclaude\dsh-sync-suite`：

```powershell
pnpm build
node --test "packages/dsh-dots/test/*.test.mjs"
node --test "apps/arkui-schedule/tools/test/*.test.mjs"
node apps/arkui-schedule/tools/validate-app.mjs
node --check packages/dsh-dots/dist/index.js
node --check packages/dsh-dots/dist/client.js
# 应用纯逻辑 tsc 类型检查（tools/tsconfig.json 的 noEmit 等价）
node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json --noEmit
git add -A && git commit -m "..." && git log --oneline -1 && git status --short
```

## 5. 报告

每个执行者结束时写 `reports/<owner>.md`（gitignored）并在最终答复里给：完成项、验证命令与输出摘要、
未完成/风险、给 Planner 的整合提示。不得虚报：没跑通的如实写“未验证”。
