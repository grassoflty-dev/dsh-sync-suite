# dsh-git-config-sync

DSH（DeepSeek Harness）配置同步插件：把本机 `profiles/web` 的配置以**脱敏快照**推到自有 Git 仓库，
需要时拉取预览、**逐条**覆盖回本机。每台设备只写自己的目录，密钥永不进入仓库，任何写入前都会生成快照。

设置入口：**设置 → 配置同步**（设置分区，`id: git-config-sync`，`order: 70`）。

---

## 1. 安装

### 1.1 本地目录安装（开发/自用，无需构建）

仓库内已提交 `dist/`，可直接把本目录链接进 profile：

```powershell
# 在 dsh-sync-suite 仓库根执行
dsh plugin --profile web add link:C:\Users\GWL\Desktop\itwillclaude\dsh-sync-suite\packages\dsh-git-config-sync
```

> 本仓库的工具链**不会**自动改 `~/.dsh/profiles/**`。如果你的 DSH 装有 `dsh-safe-launch`，
> 请优先通过它的安全启动器端点安装（它会先做兼容性启动测试）：
>
> ```powershell
> Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3080/dsh-safe-launch/install-plugin `
>   -ContentType 'application/json' `
>   -Body (@{ source = 'link:C:\Users\GWL\Desktop\itwillclaude\dsh-sync-suite\packages\dsh-git-config-sync' } | ConvertTo-Json)
> ```
>
> 安装完成后重启 DSH（或刷新 Web GUI），设置页会出现「配置同步」分区。

### 1.2 打包后安装（分发给其他机器）

```powershell
cd packages\dsh-git-config-sync
npm pack                       # 生成 dsh-git-config-sync-<version>.tgz
dsh plugin --profile web add link:<解压或安装路径>
# 或安装 tarball：
# dsh plugin --profile web add C:\path\to\dsh-git-config-sync-0.1.0.tgz
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
| 仓库配置 | 平台（GitHub / Gitee / 自定义，仅影响地址提示）、仓库地址、认证方式（HTTPS Token / SSH）、设备标识、分支 |
| 同步范围 | `cordis.patch.yml` 条目、provider 定义、插件清单（MERGE-only）、MCP，默认全选 |
| 状态徽标 | 可达性、分支、本地提交数、仓库提交 sha、待上传 / 待下载数、冲突、最近提交（sha+message+time）、最近同步时间、状态错误 |
| 操作 | 保存设置、测试连接、推送、拉取预览、执行覆盖（未预览或未勾选条目时禁用）、刷新状态 |
| 预览 | 按源设备分组；逐条差异（本地 vs 远端，等宽、可折叠、限高滚动）；采纳远端 / 保留本地切换；`manual` 条目默认不勾选并标注「需本地填写」 |
| 插件清单 | MERGE-only 四组计数与明细：可安装/升级、保持、跳过、不降级；`install` 只写待安装计划，不执行 pnpm |
| 快照 | 写前恢复快照列表（id / time / reason / bytes），回滚需二次确认 |
| 错误 | 内联显示 `code + message`；网络异常、HTTP 500、`{ok:false}` 均不白屏；预览过期提示「请重新预览」 |

同步语义（与 `docs/DATA-CONTRACT.md` 一致）：

- 远端目录 `devices/<deviceId>/`，每台设备只写自己的目录。
- patch 文件**按 entry id 逐条合并**，保留文件头注释、条目内 `!!js`、缩进与键顺序，不做 YAML 反序列化再序列化。
- 远端条目的同名 secret 字段在快照里被替换为 `__SECRET__`；恢复时用本地同名字段回填，本地没有则跳过并标记「需本地填写」。
- 插件清单只同步元数据（包名/版本/来源/启用状态），**不下载代码、不删本地独有插件、不降级**。

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

错误码：`E_VALIDATION`、`E_CONFIRM_REQUIRED`、`E_UNKNOWN_ACTION`、`E_NOT_FOUND`、`E_GIT`、
`E_AUTH`、`E_CONFLICT`、`E_SHA_MISMATCH`、`E_IO`。

`status` 字段：`{reachable: true|false|null, branch, headSha, headMessage, headTime, localPending: number|null, remotePending: number|null, conflict, lastSyncAt, error?}`。
`getState` 只读本地、不联网；`reachable` 三态（null=未探测，false=最近一次网络动作失败）。
`applied[]` 的 `fileSha256` 是写后整文件 SHA-256，`blockSha256` 是单条 entry 文本 SHA-256。

`settings` 字段：`{repoUrl, platform:'github'|'gitee'|'custom', authMode:'https'|'ssh', deviceId, branch, scope:{config,providers,plugins,mcp}, hasToken}`。

写入约束（host 侧强制，前端只是入口）：

1. `apply` / `rollback` 必须 `confirm: true`，否则返回 `E_CONFIRM_REQUIRED` 且**不落盘**；
2. 只接受预览里 `added | changed | manual` 的条目 id；
3. 写入前生成快照，写入后重算 SHA-256 校验，不一致自动回滚并报 `E_SHA_MISMATCH`；
4. 所有写操作串行排队，永不 `force push`（非快进先 `pull --rebase`，最多 2 次）。

---

## 4. 安全说明

- **Token 只存本机**：`%USERPROFILE%\.dsh\git-config-sync\credentials.json`（0600），
  不写入补丁/快照/日志，也不出现在 git argv 里（HTTPS 走临时 `GIT_ASKPASS` 脚本 + 环境变量）。
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
  dist/                 # 构建产物（index.js / client.js）
  src/client.js         # 本 README 描述的 Web GUI 设置页（纯 JS，无需构建）
  locale/{en,zh}.json   # 插件元信息与全部 UI 文案（key 集合必须一致）
  icon.svg              # 原创图标
  docs/DETAIL.md        # 中文详情页：架构 / 数据目录 / 恢复流程 / 风险边界 / 排错
```

---

## 6. 开发与自测

```powershell
# 语法检查（含 window 的浏览器代码只做语法检查，不执行）
node --check packages/dsh-git-config-sync/src/client.js

# locale 一致性：en/zh key 集合必须完全相同，且必须含 meta.title/description/detail
node -e "const fs=require('fs');const e=JSON.parse(fs.readFileSync('packages/dsh-git-config-sync/locale/en.json','utf8'));const z=JSON.parse(fs.readFileSync('packages/dsh-git-config-sync/locale/zh.json','utf8'));const a=Object.keys(e).sort().join(','),b=Object.keys(z).sort().join(',');if(a!==b){console.error('KEY MISMATCH');process.exit(1)};console.log('locale keys equal:',Object.keys(e).length)"

# host 侧单元/集成测试（在仓库根）
pnpm build
node --test packages/dsh-git-config-sync/test
```

---

## 7. 已知限制

- 真实 Web GUI 挂载需在装有该插件的 DSH 实例中人工确认（本仓库的自动测试只做模块级/组件级验证）。
- `preview` 缓存是内存态、单实例单 previewId：重新预览会让上一个 previewId 失效，`apply` 会返回
  `E_NOT_FOUND` 并在界面上提示「请重新预览」。
- 插件清单的 `install` 只写 `plugins.to-install.json`，实际安装仍需你在 DSH 中手动完成。
