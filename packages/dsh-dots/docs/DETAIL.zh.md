# 配置同步（dsh-dots）详情

> 本文是插件的中文详情页：说明架构、数据目录、恢复流程、风险边界与排错。
> 需求基准见仓库根 `BRIEF.md`，接口契约见 `docs/CONTRACT.md`、`docs/DATA-CONTRACT.md`。

---

## 1. 它解决什么问题

DSH 的可用配置大多集中在 `~/.dsh/profiles/<profile>/` 里：`cordis.patch.yml`（插件与模型 provider 的
entry 数组，含 `!!js` 表达式与注释）、插件依赖清单、MCP 定义、provider 定义。手工在多台机器之间
复制这些文件有三个坑：

1. **密钥会被带出去**：patch 里常有 `apiKey` / `token`；
2. **整文件覆盖会丢本地内容**：不同机器的注释、本地独有 entry、版本不同；
3. **冲突无法回退**：覆盖错了没有一键恢复。

本插件用「每台设备只写自己目录 + 按 entry id 逐条合并 + 密钥脱敏 + 写前快照」解决这三点。

---

## 2. 架构

```
┌──────────────────────────── Web GUI（浏览器） ────────────────────────────┐
│  settings.section / id=dots / order=70                        │
│  src/client.js（纯 JS，__ModuleLoader__ 注册，无需构建）                  │
│    · 表单、状态徽标、预览差异、快照列表、内联错误                          │
│    · 唯一出口：fetch('/dsh-dots/rpc', {action,...})            │
└───────────────────────────────┬──────────────────────────────────────────┘
                                │ 同源 POST，{ok,data} | {ok,error}
┌───────────────────────────────┴──────────────────────────────────────────┐
│  Host 进程（Cordis 插件，dist/index.js）                                  │
│    ctx.webServer.register({kind:'exact', path:'/dsh-dots/rpc'})│
│    ctx.connection.requestRejection(req) → 401/403                        │
│    rpc.ts：action 分发 + 写操作串行队列 + 10MB body 上限                   │
│    engine/：collect → preview → apply/rollback（fail-closed）             │
│              git.ts（execFile('git')）· patch.ts（逐条合并）               │
│              secrets.ts（脱敏/回填）· pluginMerge.ts（MERGE-only）        │
│              snapshot.ts（写前快照）· paths.ts（可注入路径）              │
└───────────────────────────────┬──────────────────────────────────────────┘
                                │ 系统 git（HTTPS 用临时 GIT_ASKPASS，SSH 用 ssh-agent）
                    ┌───────────┴────────────┐
                    │ 用户自有私有仓库（main） │
                    │ devices/<deviceId>/...  │
                    └────────────────────────┘
```

要点：

- **前端不直接碰文件**：所有落盘都在 host 侧，UI 只发 action。
- **同源请求**：不存在跨域/外部服务调用，Token 不会经过浏览器存储。
- **没有运行时 npm 依赖**：host 只用 `node:` 内置模块 + 系统 `git`；`dist/` 已构建入库。
- **不使用** `ctx.settings.installSection` / `settings.plugin.item`（当前 DSH 0.2.2-rc.3 无此 API），
  设置页走 `settings.section` 插槽。

---

## 3. 数据目录

### 3.1 本机（不进仓库）

```
%USERPROFILE%\.dsh\dots\
  settings.json            # repoUrl/platform/authMode/username/deviceId/branch/scope（无 token）
  credentials.json         # { token }，0600，仅当前用户
  work\<repoHash>\         # 工作副本，repoHash = sha256(repoUrl) 前 16 位
  plugins.to-install.json  # MERGE-only 待安装计划
%USERPROFILE%\.dsh\vet\restore-snapshots\
  <YYYYMMDD-HHmmss>[-n]\
    files\<name>           # 写入前的 profile 文件副本
    manifest.json          # 每文件 sha256 / bytes
```

保留策略：恢复快照只保留最近 **10** 份，超出由 `SnapshotStore.prune()` 清理。

### 3.2 远端仓库

```
<repo>/
  devices/
    pc-a/
      cordis.patch.yml     # 脱敏后的 profile patch（保留注释与 !!js）
      providers.json       # { providers: { <id>: definition } }
      plugins.json         # { plugins: [{ name, version, source, enabled }] }
      mcp.json             # { entries: [{ id, text }] }
      manifest.json        # { deviceId, time, scopes, dshVersion, files:[{name,sha256,bytes}] }
    pc-b/ ...
```

规则：**一台设备只写自己的目录**，读别的目录只用于预览；`manifest.json` 是快照索引，
`sha256` 用于传输/写入校验，不做内容级合并。设备标识必须匹配 `^[a-z0-9][a-z0-9-]{0,31}$`。

---

## 4. 同步算法

### 4.1 patch 逐条合并（不做 YAML round-trip）

`cordis.patch.yml` 是 profile 的顶层 YAML 数组：

```yaml
# 文件头注释
- id: llm-pi-ai
  config:
    providers: ...
- insert:
    - id: dsh-git-sync
      name: 'dsh-git-sync'
```

- entry key：顶层 `id:` → 该 id；`insert:` → `insert:<内部第一个 id>`；否则 `entry:<序号>`。
- **`insert:` 多行块限制（重要）**：一个 `insert:` 块内的多行插件行被视为**一个整体**，按内部第一个 `id`
  作为 key，合并时整块替换。若一个 `insert:` 块里混了多个插件，跨设备合并会以“第一个 id”代表整块，
  导致块内其他插件无法独立勾选/回滚。**规避方式：用户 profile 里一条 entry 只放一行 `insert`**，例如：
  ```yaml
  - insert:
      - id: plugin-a
        name: 'plugin-a'
  - insert:
      - id: plugin-b
        name: 'plugin-b'
  ```
  插件本身不会自动改写用户的 profile 结构（只做块级文本替换）；`preview` 会显示该块的完整文本，
  发现整块替换时请保留本地版本或手动拆分后再同步。
- 合并：**本地顺序为准**；本地独有保留；远端独有追加到末尾（连同其前置注释）；
  同 key 文本不同 → `changed`（整块采用远端原文）；相同 → `same`；
  远端块含 `__SECRET__` 且与本地不同 → `manual`（不自动覆盖，需本地填写）。
- 输出保证：文件头/前置注释、条目内 `!!js`、缩进、键顺序不变；末尾恰好一个换行。
- 因此**注释不会丢**，`!!js` 表达式也不会被解析后重新序列化破坏。

### 4.2 密钥脱敏与回填

- 命中 secret 的 key 判定按**词边界**（非子串）：`token`/`secret`/`password`/`authorization`/`bearer`
  精确词，或相邻词 `api`+`key`（`apiKey`/`api_key`）；`maxTokens`（复数）与 `apiKeyEnv`（环境变量名）
  属正常字段，**不会**被脱敏。
- 标量在进入同步载荷前替换为固定占位符 `__SECRET__`。
- 恢复时：远端占位符处用**同一条 entry 内、同 key 名**的本地值回填（不按出现顺序，避免多 provider 错配）；
  本地没有 → 保留占位符、该条进 `skipped`，界面标「需本地填写」，**不会**把占位符写进你的配置。
- 字符串里内嵌的 `Bearer xxx` 不处理（避免误伤普通文本）。

### 4.3 插件清单 MERGE-only

| 情况 | 动作 |
| --- | --- |
| 远端有、本地无 | `install`（只写待安装计划，不执行 pnpm） |
| 本地有、远端无 | `keep`（**永不删除**本地独有插件） |
| 远端版本 > 本地 | `install`（升级） |
| 本地版本 > 远端 | `noDowngrade`（**不降级**） |
| 版本相同 | `keep` |
| 来源不可解析 | `skip` |

同步内容只有元数据（包名/版本/来源/启用状态），**不传代码、不传 node_modules**。

### 4.4 Gitee HTTPS 认证：用户名 + 私人令牌

GitHub 的 PAT 可以用任意非空用户名（本插件默认 `x-access-token`），但 **Gitee 不行**：
Gitee 的 HTTPS 规则是「**Gitee 登录名作用户名 + 私人令牌作密码**」。把 `x-access-token`
套到 Gitee 只会得到 403/认证失败，而且错误藏在 git 输出里，很难定位。

- **精简面板口径**：**只要地址 + 令牌；登录名由地址推断，仅在鉴权失败时才要求填写**。
  地址下方有一行只读派生「登录名：<owner>（由仓库地址推断）」；只有 401 / 403（Gitee 组织仓库
  常见）才展开可编辑「登录名」，文案逐字为「Gitee 的私人令牌只能当密码，需要你的登录名；
  通常就是仓库地址里的 owner」，失焦即写本机 `settings.json::username`，鉴权成功后收起。
- 用户名规则（**唯一实现** `src/engine/gitUsername.ts`）：
  - 显式值（手填 / 环境变量 `DSH_DOTS_GIT_USERNAME`）优先；
  - Gitee 留空 → 从 `https://gitee.com/<owner>/<repo>.git` 取 owner，**不再**一上来就报缺少用户名；
  - GitHub / 自定义留空 → `x-access-token`（GitHub PAT 约定，历史行为不变；不发送 URL owner）；
  - Gitee 既无显式值也推不出 owner → 报 `E_VALIDATION`：
    「Gitee 需要填写用户名（Gitee 登录名），私人令牌只作密码」——不会静默用错用户名。
- 用户名只存本机 `settings.json`（**不进** `credentials.json`），只经 `DSH_GIT_SYNC_USER`
  传给临时 askpass；不进配对载荷、不进同步仓库、不进日志/错误串（错误串对 token 与用户名都打码）。
- 保存设置时若仓库地址是 `gitee.com` 而平台仍是默认 GitHub，会**自动纠正为 Gitee 并在提示条说明**；
  `gitlab.com` 地址纠正为「自定义」。用户明确选 Gitee / 自定义时不会被覆盖。

---

## 5. 恢复流程（fail-closed 四层）

```
① 拉取预览        preview → {previewId, sources:[{deviceId, entries, plugins, providers, mcp}]}
                  （只读：不写任何文件；缓存 TTL 10 分钟，单实例只保留一个 previewId）
② 逐条勾选        UI 默认全选 added/changed；manual 默认不选并标「需本地填写」
③ 执行覆盖        apply {confirm:true, previewId, sourceDevice, entries}
   ├─ confirm !== true               → E_CONFIRM_REQUIRED，不落盘
   ├─ previewId 失效/条目不合法      → E_NOT_FOUND / E_VALIDATION（界面提示「请重新预览」）
   ├─ 写前快照                       → %USERPROFILE%\.dsh\vet\restore-snapshots\<ts>\
   ├─ 仅替换勾选条目（本地 secret 回填，回填不了 → skipped）
   ├─ 原子写（临时文件 + rename）
   └─ 写后整文件 SHA-256 校验          → 不一致：用快照回滚 + E_SHA_MISMATCH
④ 历史回滚        rollback {snapshotId, confirm:true} → {restored, verified:true}
```

界面上的「执行覆盖」与「回滚」都是**两步确认**：先点按钮展开确认条，再点「确认覆盖 / 确认回滚」。
所有写操作按钮在请求进行中禁用并显示「…中」，组件卸载后不再 setState。

---

## 6. 风险边界（明确不做的事）

- **不 force push**：非快进时先 `pull --rebase`，最多 2 次，仍冲突报 `E_CONFLICT`。
- **不自动解决语义冲突**：两个设备改了同一个 entry 的同一行，需要人工选择「采纳远端 / 保留本地」。
- **不跨设备删除**：远端没有的本地插件/条目永远保留。
- **不在浏览器保存 token**：Token 只走一次 `saveSettings`，之后只用 `hasToken: true` 表示状态。
- **不修改 DSH 本体与 profile 依赖**：插件清单只写计划文件；不调用 pnpm、不改 profile `package.json`。
- **不做 YAML 语义重写**：只做文本块级替换，避免破坏 `!!js`。
- **不做云端中转**：只有你和你的 Git 仓库，没有第三方服务。

已知限制：

- `preview` 是内存态：DSH 重启或再次预览后，旧 `previewId` 失效（界面会提示重新预览）。
- `plugins.to-install.json` 只是计划，实际安装需要你手动执行。
- 只同步 `cordis.patch.yml`、provider、插件清单、MCP 四类；会话/工作区文件不在范围内。
- `insert:` 多行块按“内部第一个 id”整体合并；建议用户 profile 一条 entry 只放一行 `insert`（见 §4.1）。
- `getState` 只读本地状态、不联网；`reachable` 为 `true|false|null`（null=未探测），
  网络探测只在「测试连接 / 推送 / 拉取预览」发生，且单次 git 网络操作有**明确预算**：
  读命令（`ls-remote` / `fetch`）8 秒、本进程**首次**调用放宽到 20 秒（覆盖 askpass 解释器冷启动），
  推送 120 秒（要上传本地对象，成本随工作量增长）；**「超时」与「网络不可达」是两类不同错误**，
  各有独立中文文案与下一步，预算数字取自当次实际使用的值。
- `apply` 返回的 `fileSha256` 是写后整个 profile patch 的 SHA-256；`blockSha256` 是单条 entry 文本的
  SHA-256，两者用途不同（前者校验落盘、后者追踪条目）。

---

## 7. 排错

| 现象 | 错误码 | 处理 |
| --- | --- | --- |
| 设置页显示「网络异常」 | `E_NETWORK` | DSH 服务已停止或页面已断开；重启 DSH 后刷新页面 |
| 「服务返回 HTTP 500」 | `E_HTTP` | 看 DSH 日志；多为 git 未安装或仓库地址不可达 |
| 「未通过 DSH 鉴权」 | `E_AUTH` | 当前会话无权限，重新登录/打开 GUI |
| 保存设置报校验失败 | `E_VALIDATION` | 检查仓库地址协议（仅 `https://`、`ssh://`、`git@host:path`）、deviceId 格式、分支非空 |
| 测试连接失败 | `E_GIT` / `E_AUTH` | Token 无效或 SSH key 未加载；HTTPS 用最小权限 PAT，SSH 确认 `ssh-add -l` |
| 推送被拒 | `E_CONFLICT` | 远端已有新提交且 rebase 冲突；先在 DSH 外手工处理该仓库 |
| 「预览已过期，请重新预览」 | `E_NOT_FOUND` / `E_VALIDATION` | 重新点「拉取预览」；previewId 只能用一次 |
| 「写入后校验失败，已回滚」 | `E_SHA_MISMATCH` | 目标文件被别的进程改动；关闭其他编辑器/程序后重试 |
| 插件清单显示「不降级」 | — | 本地版本更高，属预期；如需降级请手工处理 |
| 条目显示「需本地填写」 | — | 远端该字段是 `__SECRET__`，请在本机同名 entry 里手工补 key |

排查顺序建议：

1. 「测试连接」→ 确认网络/认证；
2. 「拉取预览」→ 确认读写与合并结果；
3. 只勾一条 → 「执行覆盖」→ 看「上次覆盖结果」里的 `applied / skipped / snapshotId / verified`；
4. 不满意就「写前快照 → 回滚」。

---

## 8. 实现与验证状态

- `src/client.js`：纯 JS，`node --check` 通过；locale `en`/`zh` key 集合一致（158 个），
  且内联字典与 `locale/*.json` 逐字一致；`meta.detail` 分别指向 `docs/DETAIL.zh.md` / `docs/DETAIL.md`。
- 组件级验证：`test/client-render.test.mjs` 用**符合 React 语义的桩**（children 只走 `props.children`）
  渲染设置面板，断言输入框、下拉框、勾选框与操作按钮都真实产出；另有桩 `fetch` 的交互冒烟脚本
  （详见仓库 `reports/client.md`）。
- **未验证**：真实 DSH Web GUI 中的视觉/交互（需要已鉴权的 GUI 会话；本次复查时 GUI 返回
  `dsh web authentication required`，因此真实渲染仍未验证）；host 侧 RPC 与 git 链路由另一个执行者负责，
  本文只描述已约定的契约。
