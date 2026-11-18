# dsh-git-config-sync

DSH（DeepSeek Harness）配置同步插件：把本机 `profiles/web` 的配置以**脱敏快照**推到自有 Git 仓库，
需要时拉取预览、**逐条**覆盖回本机。每台设备只写自己的目录，密钥永不进入仓库，任何写入前都会生成快照。

设置入口：**设置 → 配置同步**（设置分区，`id: git-config-sync`，`order: 70`）。

---

## 1. 安装

### 1.1 本地目录安装（开发/自用，无需构建）

推荐在 DSH Web GUI 的 **Plugins → Add plugin** 选择本地目录：

```
C:\Users\GWL\Desktop\itwillclaude\dsh-sync-suite\packages\dsh-git-config-sync
```

等价 CLI（若环境允许）：

```powershell
# 在 dsh-sync-suite 仓库根执行
dsh plugin --profile web add link:C:\Users\GWL\Desktop\itwillclaude\dsh-sync-suite\packages\dsh-git-config-sync
```

前置检查：链接安装不会执行构建，`dist/index.js` 与 `dist/client.js` 必须已在仓库里
（`Test-Path packages\dsh-git-config-sync\dist\client.js` 为 `True`）；缺失时设置页不会出现。
安装侧不需要 `pnpm build`，也不需要联网安装运行时依赖（插件只用 `node:` 内置模块与系统 `git`）。

> **安全启动器不接受本地目录**：`dsh-safe-launch` 只接受 npm 包名或 `github:<owner>/<repo>`
> （与仓库根 README「插件安装」② 一致）。本地目录请用上面的 GUI/CLI 链接安装，不要把
> `link:` 传给 `/dsh-safe-launch/install-plugin`。
>
> 安装完成后刷新 Web GUI：新 bundle 通常经 HMR 生效；**替换/升级已安装的包后需要重启 DSH**，
> 才能加载新的客户端模块。设置页会出现「设置 → 配置同步」分区（`id: git-config-sync`，`order: 70`）。

### 1.2 打包后安装（分发给其他机器）

```powershell
cd packages\dsh-git-config-sync
npm pack                        # 生成 dsh-git-config-sync-1.0.0.tgz（版本见 package.json）
# 把 tgz 拷到目标机器后安装：
dsh plugin --profile web add C:\path\to\dsh-git-config-sync-1.0.0.tgz
# 或解压后链接该目录：
# dsh plugin --profile web add link:C:\path\to\dsh-git-config-sync
```

发布到 npm / GitHub 后可走安全启动器（它只接受包名或 `github:<owner>/<repo>`，不接受本地目录/tarball）：

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3080/dsh-safe-launch/install-plugin `
  -ContentType 'application/json' -Body '{"source":"github:<owner>/<repo>"}'
# npm 来源：-Body '{"source":"dsh-git-config-sync"}'
```

`dist/` 已随仓库提交，安装侧不需要 `pnpm build`，也不需要联网安装运行时依赖
（插件运行时只用 `node:` 内置模块与系统 `git`）。

### 1.3 卸载

```powershell
dsh plugin --profile web remove dsh-git-config-sync
```

卸载**不会**删除 `%USERPROFILE%\.dsh\git-config-sync\` 与已生成的恢复快照，需要时手动清理。

---

## 2. 功能

| 区域 | 内容 |
| --- | --- |
| 仓库配置 | 平台（GitHub / Gitee / 自定义，影响地址提示与 HTTPS 默认用户名）、仓库地址、认证方式（HTTPS Token / SSH）、用户名（HTTPS 用；Gitee 必填登录名）、设备标识、分支 |
| 同步范围 | `cordis.patch.yml` 条目、provider 定义、插件清单（MERGE-only）、MCP，默认全选 |
| 状态徽标 | 可达性、分支、本地提交数、仓库提交 sha、待上传 / 待下载数、冲突、最近提交（sha+message+time）、最近同步时间、状态错误 |
| 操作 | 保存设置、测试连接、推送、拉取预览、查看差异、回滚到上次快照（两步确认）、执行覆盖（未预览或未勾选条目时禁用）、刷新状态 |
| 预览 | 按源设备分组；逐条差异（本地 vs 远端，等宽、可折叠、限高滚动）；采纳远端 / 保留本地切换；`manual` 条目默认不勾选并标注「需本地填写」 |
| 插件清单 | MERGE-only 四组计数与明细：可安装/升级、保持、跳过、不降级；`install` 只写待安装计划，不执行 pnpm |
| 快照 | 写前恢复快照列表（id / time / reason / bytes），回滚需二次确认 |
| 错误 | 内联显示 `code + message`；网络异常、HTTP 500、`{ok:false}` 均不白屏；预览过期提示「请重新预览」 |

同步语义（与 `docs/DATA-CONTRACT.md` 一致）：

- 远端目录 `devices/<deviceId>/`，每台设备只写自己的目录。
- patch 文件**按 entry id 逐条合并**，保留文件头注释、条目内 `!!js`、缩进与键顺序，不做 YAML 反序列化再序列化。
- 远端条目的同名 secret 字段在快照里被替换为 `__SECRET__`；恢复时用本地同名字段回填，本地没有则跳过并标记「需本地填写」。
- 插件清单只同步元数据（包名/版本/来源/启用状态），**不下载代码、不删本地独有插件、不降级**。

### 2.1 远程访问（新增，设置页独立 section「远程访问」）

让平板/手机打开本机 DSH。**默认关闭**，且只绑**具体**地址（IPv4 或 IPv6），绝不绑 `0.0.0.0`
（DSH 的 host-webserver 会在配置加载期拒掉通配地址，绑了 profile 就起不来）。

| 访问方式 | 判定 | 说明 |
| --- | --- | --- |
| `lan` 局域网直连 | 可用（默认） | 插件在具体局域网 IPv4 上旁挂监听，反代回 `127.0.0.1:<DSH 端口>`；平板零安装 |
| `ipv6` 公网直连 | 需准备 | 绑具体公网 IPv6；需要运营商给 v6 + 光猫放行入站 + 地址稳定（自检会剔除 Temporary 地址） |
| `cloudflare` 隧道 | 需准备 | 本机跑 `cloudflared` 出站隧道；quick tunnel 零账号但域名每次变，WS 支持需实测 |
| `tailscale` | 需准备 | PC 侧成熟；平板必须装**鸿蒙原生**客户端（卓易通里装的安卓 Tailscale **不能**给宿主 App 用） |
| `manual` 手动地址 | 可用 | 只做地址归一与自检，不代管监听 |
| `uu` 网易 UU 远程 | 需准备（图形化端口映射） | 免费版含端口映射：在 UU 里把内部端口映射成对外入口，把入口粘进「对外入口地址」即可；插件不起监听（入口形态与 WS 透传待实测） |

`lan` / `ipv6` / `tailscale` / `uu` 各有一个**可选**字段「访问令牌（可选）」：留空则拼出的地址
和以前完全一样；填了（`^[A-Za-z0-9+/=_-]{8,512}$`）就在「显示二维码与链接」里追加 `?token=…`，
与自动生成的令牌同一出口规则——状态响应只给 `tokenSet`/`tokenMasked`，永不回显明文。

安全边界（实现细节见 `docs/REMOTE-ACCESS-OPTIONS.md` §5、独立评审见 `docs/REVIEW-remote-security.md`）：

- 令牌 `crypto.randomBytes(32)` 落 `~/.dsh/git-config-sync/remote-token.json`（0600）；
  `?token=` / `?k=` / 会话 cookie 三个入口，命中 `?token=` 时**本层**换 cookie 并 303 到干净地址，绝不转发上游；
- 上游 DSH 的 `dsh-auth-*` 会话由代理**注入请求头**，响应里的 `Set-Cookie` 一律剥掉（不下发给客户端）；
- 同 IP 失败限速（429 + `Retry-After`）；日志/错误消息/状态响应永不出现令牌明文，
  明文只走设置页的「显示二维码与链接」；
- 连通性自检 17 项，`unknown` 永不降级成 `ok`（`external-reachability` 恒 `unknown`，公网可达性必须从外网人工确认）。

RPC（与同步共用 `/dsh-git-config-sync/rpc`）：`remoteGetState` / `remoteSaveSettings` / `remoteStart` /
`remoteStop` / `remoteRotateToken` / `remoteProbe` / `remoteShowLink` / `remoteDetectLan`。

端到端验证脚本：`tools/e2e-remote.mjs`（局域网/WS）、`tools/e2e-ipv6.mjs`（公网 IPv6 真绑定），
用法见脚本头注释（token 走环境变量，不落盘）。



### 2.2 `insert:` 多行块限制（重要）

`cordis.patch.yml` 里的 `insert:` 条目在同步时按**整块**处理：块内第一个 `id` 作为条目 key，
合并/覆盖时整块文本替换。因此：

- **一个 `insert:` 块只放一行插件**（推荐），否则同块里的其他插件无法跨设备独立勾选/回滚；
- **不要在 `insert:` 列表里再嵌套 `insert:`**：加载器只认 patch 顶层的 `insert`，嵌套行会被当成未知字段；
- 插件不会自动改写你的 profile 结构（只做块级文本替换）；`preview` 会展示整块文本，
  发现整块替换时请保留本地版本，或手动拆分该块后再同步。

正确写法：

```yaml
- insert:
    - id: plugin-a
      name: 'plugin-a'
- insert:
    - id: plugin-b
      name: 'plugin-b'
```

### 2.3 差异预览与回滚两步确认（新增）

同步前/还原前先看清楚会改什么，再动手：

- **查看差异**：对比「本地工作副本（上次推送的内容）vs 当前 profile」，给出
  「N 个文件变更（+A / -M 行）」一句结论，按 `新增 / 修改 / 删除` 分组，每行显示
  `path` + `+N/-M` + 字节变化（`before → after`）；有 hunk 的文件可展开等宽、限高滚动的
  前后文（hunk 正文硬上限 200 行，超出标注「仅显示前 200 行」）。二进制或 >512KB 的文件
  只给统计。**空差异显示「没有差异」**，不是空白区域。
- **回滚到上次快照**：两步确认——第 1 步列出最近一份快照并点「查看这次回滚会改什么」
  （调 `rollbackPreview`，只读、走 manifest sha256 校验），第 2 步看到文件级 diff 与
  「将写入」的文件后才点「确认回滚（不可撤销）」（调 `rollback {confirm:true}`）。
  任一步失败都停在当前步骤、显示 `code + message`，**不做任何写盘**。

两个新 action 都是只读的：不创建快照、不写 profile、不写 `state.json`、不写插件待安装计划。
`apply` / `rollback` 的 `confirm:true` 门禁与校验规则**完全没变**（新入口只是把 `rollback`
拆成"先预览、再确认"两步）。契约、方向语义与 fail-closed 清单见 `docs/PLUGIN-DIFF.md`。

### 2.4 云端对话上传（P1：把本机会话导成明文 JSONL 进 `chats/`）

把 `~/.dsh/sessions/<slug>/<id>/session.v4.jsonl.zstd`（裸 zstd 帧串联，`zstdDecompressSync` 只能解第一帧，
必须自己按帧切）解成**明文 JSONL**，连同 `meta.json` 写进同步仓库的 `chats/` 共享命名空间
（不是 `devices/<id>/`），让平板只读就能看历史——不需要在 App 侧解 zstd 帧。
存储布局、`meta` 字段表、租约与续接语义见 `docs/CHAT-SYNC.md`（**含「实现注记（P1）」一节**：真实 API、
文件命名、已知限制）。

| RPC | 请求 | 响应 `data` |
| --- | --- | --- |
| `chatExportStatus` | `{}` | `{localSessions, exported, lastExportAt, pending}`（只读、不联网；未配置仓库也不报错） |
| `chatExportAll` | `{limit?}`（默认 50，硬上限 200） | `{results:[{id,ok,reason?}], summary:{total,ok,failed,limit}, pushed, reason?}` |
| `chatExportOne` | `{sessionId}` | 同上（一条结果）；本机没有该 id → `E_NOT_FOUND` |

写出来的东西（每个会话一个 commit，message `chats: export <id> (n msgs)`，`onlyPath: 'chats'`）：

```
<repo>/chats/<sessionId>/session.jsonl   # 明文、LF 结尾、行序即事件序
<repo>/chats/<sessionId>/meta.json       # 白名单字段；workspaceName 只有末段名；lease: null（P1 不租约）
<repo>/chats/index.jsonl                 # 只追加的展示投影，一行 5 个字段，首行字节永不变
```

隐私三层（缺一不可）：① `redactSecrets()` 打码 `sk-…`/`Bearer …`/`Basic …`/`token=…`/`ghp_…`；
② 递归把 **string 值**里的 `C:\…`、`/Users/…`、`/home/…`、UNC、`file://` 整段换成 `<redacted-path>`
（替换次数记进 `meta.redactions`）；③ 写盘前对最终文本做静态扫描，命中即 fail-closed 跳过整个会话。
`meta.json` 里**永不出现 `cwd`**或任何绝对路径。

失败语义：`push` 失败 → `ok:false` + `reason`，**本地已写文件与本地提交一律保留**，再点一次就是重试；
`bad-jsonl` / `truncated-session` / `missing-header` / `empty-session` / `bad-session-id` / `path-leak`
这类会话整份跳过（`results[].reason` 给码，不含正文），不影响同批其它会话。
错误与日志永不出现会话正文、token 或绝对路径（统一走 `sanitizeChatReason()`）。

注意：本轮**只交付 RPC**，设置页还没有对应 UI；租约、`expectedPrevSha` 乐观锁、只读浏览标记都留到 P2/P3。

---

## 3. RPC 契约

客户端只通过同源接口通信，无其他网络访问：

```
POST /dsh-git-config-sync/rpc
Content-Type: application/json
Body: { action, ...payload }
```

响应恒为 HTTP 200（仅 DSH 鉴权失败返回 401/403）：

```json
{ "ok": true,  "data": { } }
{ "ok": false, "error": { "code": "E_VALIDATION", "message": "...", "details": { } } }
```

| action | 请求 | 响应 `data` |
| --- | --- | --- |
| `getState` | `{}` | `{settings, status, snapshots}` |
| `saveSettings` | `{settings, token?}` | `{settings, hasToken}`（`token: ""` 表示保留，`null` 表示清除） |
| `testConnection` | `{}` | `{reachable, branch, headSha, message}` |
| `push` | `{}` | `{pushed, commit, branch, files, rebased}` |
| `preview` | `{}` | `{previewId, sources:[{deviceId, headSha, files, entries, plugins, providers, mcp}]}` |
| `apply` | `{confirm:true, previewId, sourceDevice, entries:string[]}` | `{applied:[{id,fileSha256,blockSha256,path}], skipped, snapshotId, verified:true}` |
| `listSnapshots` | `{}` | `{snapshots}` |
| `rollback` | `{snapshotId, confirm:true}` | `{restored, verified:true}` |
| `previewDiff` | `{sourceDevice?}`（缺省 = 本机） | `{sourceDevice, local, summary, hunks}`（只读） |
| `rollbackPreview` | `{snapshotId}` | `{snapshotId, createdAt, reason, files, summary, willRestore}`（只读） |

错误码：`E_VALIDATION`、`E_CONFIRM_REQUIRED`、`E_UNKNOWN_ACTION`、`E_NOT_FOUND`、`E_GIT`、
`E_AUTH`、`E_CONFLICT`、`E_SHA_MISMATCH`、`E_IO`。

`status` 字段：`{reachable: true|false|null, branch, headSha, headMessage, headTime, localPending: number|null, remotePending: number|null, conflict, lastSyncAt, error?}`。
`getState` 只读本地、不联网；`reachable` 三态（null=未探测，false=最近一次网络动作失败）。
`applied[]` 的 `fileSha256` 是写后整文件 SHA-256，`blockSha256` 是单条 entry 文本 SHA-256。

`settings` 字段：`{repoUrl, platform:'github'|'gitee'|'custom', authMode:'https'|'ssh', username, deviceId, branch, scope:{config,providers,plugins,mcp}, hasToken}`。

写入约束（host 侧强制，前端只是入口）：

1. `apply` / `rollback` 必须 `confirm: true`，否则返回 `E_CONFIRM_REQUIRED` 且**不落盘**；
2. 只接受预览里 `added | changed | manual` 的条目 id；
3. 写入前生成快照，写入后重算 SHA-256 校验，不一致自动回滚并报 `E_SHA_MISMATCH`；
4. 所有写操作串行排队，永不 `force push`（非快进先 `pull --rebase`，最多 2 次）。

---

## 4. 安全说明

- **Token 只存本机**：`%USERPROFILE%\.dsh\git-config-sync\credentials.json`（0600），
  不写入补丁/快照/日志，也不出现在 git argv 里（HTTPS 走临时 `GIT_ASKPASS` 脚本 + 环境变量）。
- **HTTPS 用户名按平台区分**：GitHub 可留空（默认 `x-access-token`），**Gitee 必填 Gitee 登录名**
  （私人令牌只作密码；留空直接报 `E_VALIDATION`，不会静默用错用户名）。用户名只存 `settings.json`，
  不进 `credentials.json`。
- **密钥脱敏**：凡是 key 命中 `token|secret|password|apiKey|api_key|authorization|bearer`（不区分大小写）
  的字段，进入同步载荷前替换为 `__SECRET__`；界面会标「含脱敏密钥」。
- **永不 force push**：远端分叉时先 `pull --rebase` 再推送，超过重试次数就报 `E_CONFLICT` 让人工处理。
- **写入前快照**：`apply` / `rollback` 前把当前 profile 文件复制到
  `%USERPROFILE%\.dsh\vet\restore-snapshots\<timestamp>\`，保留最近 10 份，可一键回滚。
- **不删本地插件、不降级版本、不执行 pnpm**：插件清单只做 MERGE-only 计划。
- **仓库地址白名单**：仅接受 `https://`、`ssh://`、`git@host:path`；设备标识必须匹配 `^[a-z0-9][a-z0-9-]{0,31}$`。
- **不碰 profile 写权限之外的东西**：插件只读写 `~/.dsh` 下的配置与快照目录，不修改 DSH 本体。

建议：使用**私有**仓库；Token 用最小权限的 fine-grained PAT（仅该仓库 contents 读写）。

---

## 5. 资源与目录

```
packages/dsh-git-config-sync/
  package.json          # dsh.client / dsh.bundle.patch / exports
  cordis.patch.yml      # bundle patch
  dist/                 # 构建产物（index.js / client.js，已提交，安装侧无需构建）
  src/client.js         # 本 README 描述的 Web GUI 设置页（纯 JS，无需构建）
  locale/{en,zh}.json   # 插件元信息与全部 UI 文案（key 集合必须一致）
  icon.svg              # 原创图标（64×64 SVG）
  docs/DETAIL.md        # 英文详情页：架构 / 数据目录 / 恢复流程 / 风险边界 / 排错
  docs/DETAIL.zh.md     # 中文详情页
```

---

## 6. 开发与自测

```powershell
# 语法检查（含 window 的浏览器代码只做语法检查，不执行）
node --check packages/dsh-git-config-sync/src/client.js

# locale 一致性：en/zh key 集合必须完全相同，且必须含 meta.title/description/detail
node -e "const fs=require('fs');const e=JSON.parse(fs.readFileSync('packages/dsh-git-config-sync/locale/en.json','utf8'));const z=JSON.parse(fs.readFileSync('packages/dsh-git-config-sync/locale/zh.json','utf8'));const a=Object.keys(e).sort().join(','),b=Object.keys(z).sort().join(',');if(a!==b){console.error('KEY MISMATCH');process.exit(1)};console.log('locale keys equal:',Object.keys(e).length)"

# host 侧单元/集成测试（在仓库根；Node 24 不支持目录形式，必须用 glob）
node --test "packages/dsh-git-config-sync/test/*.test.mjs"
# 全仓：
node --test

# 改了 src/*.ts 才需要重新生成 dist/（纯 client.js 改动只需同步 dist/client.js）：
node node_modules/typescript/bin/tsc -p packages/dsh-git-config-sync/tsconfig.json
node packages/dsh-git-config-sync/scripts/build.mjs   # tsc + 拷贝 src/client.js → dist/client.js
```

---

## 7. 已知限制

- 真实 Web GUI 挂载需在装有该插件的 DSH 实例中人工确认（本仓库的自动测试包含模块级与桩 React 的组件级渲染验证，不做真实浏览器视觉验证）。
- `meta.detail` 指向 `locale/en.json` → `docs/DETAIL.md`、`locale/zh.json` → `docs/DETAIL.zh.md`；
  两份文档都必须随包发布（`package.json` 的 `files` 含 `docs`），缺失会让插件详情页显示加载失败。
- `preview` 缓存是内存态、单实例单 previewId：重新预览会让上一个 previewId 失效，`apply` 会返回
  `E_NOT_FOUND` 并在界面上提示「请重新预览」。
- 插件清单的 `install` 只写 `plugins.to-install.json`，实际安装仍需你在 DSH 中手动完成。
