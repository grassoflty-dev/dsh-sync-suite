# 远程控制 / 插件侧 git 同步 —— 自查手册（给 Lead，不是结论）

> 目的：让 Lead **自己**验证端到端，而不是接受执行者的报告。
> 本文件只写「怎么做」与「看什么」，**不含任何「已验证通过」的结论**。
> 状态标记：`[现成]` = 今天就能查；`[待 RC-4]` = 等对应模块落地后再补的空位。

---

## 1. 插件侧 git 同步（写穿、双向）

### 1.1 路径

| 项 | 路径 | 备注 |
| --- | --- | --- |
| v2 工作根 | `~/.dsh/dots/repos/<repoHash>/` | `[现成]` |
| 插件克隆 | `~/.dsh/dots/repos/<repoHash>/git-repo/` | `[现成]` 真正的 `.git` + `timeline/**` |
| 旧克隆（仅迁移源） | `~/.dsh/dots/work/<repoHash>/` | `[现成]` 不应再被写；存在则说明还没迁移 |
| outbox | `~/.dsh/dots/outbox/<repoHash>.json` | `[现成]` 推送被拒时的暂存意图 |
| 身份（密钥） | `~/.dsh/dots/identity/<instanceId>.json` | `[现成]` 0600，**不要打印内容** |
| 远程令牌 | `~/.dsh/dots/remote-token.json` | `[现成]` 0600，**不要打印内容** |
| 配对证书 | `~/.dsh/dots/remote-pairing-cert.json` | `[现成]` 0600 |
| 公告状态标记 | `~/.dsh/dots/remote-pairing-state.json` | `[现成]` `announcedPort` 等 |

### 1.2 `<repoHash>` 怎么来

与 App 一致：`sha256(repoUrl.trim())[0:16]`（十六进制小写）。插件里唯一实现是 `packages/dsh-dots/src/engine/paths.ts` 的 `repoHash()`。
**最快的确认方式**：直接 `ls ~/.dsh/dots/repos/`，目录名就是当前 hash；若插件配置过别的仓库，会有多个目录。

一行命令（不打印任何凭据）：

```
ls -1 ~/.dsh/dots/repos/ && cd ~/.dsh/dots/repos/<repoHash>/git-repo && git --no-pager log --oneline -3 && git status --porcelain=v1 | head -20
```

> Windows 上把 `~` 换成 `C:\Users\GWL`（`$env:USERPROFILE`）。

### 1.3 分支 / HEAD

- 分支固定 `main`，**不用 rebase、不 force、不改写历史**。
- 正常态：`git rev-parse HEAD` == `git rev-parse origin/main`（工作树干净）。
- 空仓库首跑：插件/平板都会先建 `main` 再推；若你看到 `fatal: ambiguous argument 'origin/main'`，说明**还没**成功推过。

### 1.4 「已推送」 vs 「停在 outbox」怎么区分

| 现象 | 判定 |
| --- | --- |
| `git log origin/main -1` 里有该提交，且 `git status` 干净 | **已推送** |
| `outbox/<repoHash>.json` 存在且含该 intent、`attempts` ≥ 1 | **停在 outbox（推送被拒）**，本地已提交但远端没有 |
| 工作树有改动、`git log` 无新提交 | 写入还没走到提交（或写失败） |
| 平板侧 `git-repo/.git/refs/remotes/origin/main` 与本地 HEAD 同 sha | 平板已收到（需平板跑过一轮同步） |

**注意**：插件 at `~/.dsh/dots/repos/...` 与平板克隆是**两个副本**，同一个远端。判断「双向通了」必须三方对 sha：插件 HEAD、平板 `origin/main`、以及远端（`git ls-remote` 或 Gitee 页面）。

### 1.5 平板侧只读命令（`hdc`）

```
hdc -t <serial> shell "ls -l /data/app/el2/100/base/com.itwill.schedule/haps/entry/preferences/git_sync_status"
hdc -t <serial> shell "cat /data/app/el2/100/base/com.itwill.schedule/haps/entry/files/git-repo/.git/refs/heads/main"
hdc -t <serial> shell "cat /data/app/el2/100/base/com.itwill.schedule/haps/entry/files/git-repo/.git/refs/remotes/origin/main"
```

`git_sync_status` 里 `{"kind":"synced","at":"HH:MM"}` = 平板最近一次同步成功；`kind":"failed"` 时看 `reason`。

---

## 2. 远程控制：监听、配对、指纹

### 2.1 监听端口

- 默认 **44996**（首选端口，空闲即用），被占用时会扫描并记录到 remote 设置；`[现成]`。
- 读当前端口：`payload` 里的 `port`（见 2.2），或 `remote-pairing-state.json` / remote 设置里的 `port`。
- `[待 RC-4]` 若 TLS 落地后端口或协议有变，在此处补一行。

### 2.2 配对 payload 在哪里读

| 内容 | 位置 | 备注 |
| --- | --- | --- |
| 完整 payload（含 token） | `pairingShow` RPC 的返回值；**不落盘** | 面板上「显示二维码 / 复制配对串」才产生 |
| 规范 JSON | `{v,instanceId,transport,host,port,token,tlsFingerprint,announceRef}` | 键序固定 |
| 紧凑串（手输用） | `DSHDOTS1|v|instanceId|transport|host|port|token|tlsFingerprint|announceRef|checksum` | 校验和只防手误，**不是**认证 |
| 指纹 | `tlsFingerprint` = 证书 DER 的 SHA-256，冒号分隔大写 | 平板按它 pin |

**自查方式（不经过面板）**：直接读 `remote-pairing-cert.json` 的证书 DER 并算 SHA-256，与 payload 里的 `tlsFingerprint` 对比——两者必须相等；`[现成]`（引擎已提供该计算）。

### 2.3 你要做的五项连接检查

| # | 检查 | 期望 |
| --- | --- | --- |
| a | HTTPS 握手 | 能完成 TLS 握手（自签名，故客户端需跳过 CA 校验但**校验指纹**） |
| b | 叶子证书 SHA-256 == payload `tlsFingerprint` | 相等 |
| c | **换证书**后再连 | **拒绝**，且是「指纹不匹配」那条文案 |
| d | **无 pin** 时连 | **拒绝**，且是「从未配对（无 pin）」那条文案（不是 a，也不是成功） |
| e | 错误 token / 正确 token | 前者拒绝，后者放行 |

`[待 RC-4]` 三条拒绝文案的**逐字**内容（a/b/c 三态）在 TLS 模块冻结时补进下表：

| 场景 | 文案（待补） |
| --- | --- |
| (a) 指纹不匹配 | `[待 RC-4]` |
| (b) 从未配对（无 pin） | `[待 RC-4]` |
| (c) 证书链无法获取/校验 | `[待 RC-4]`（fail closed，不得当成 a 或成功） |

### 2.4 我不会替你预审的东西（按你的要求）

- **文案审计**：请你自己 `grep` 新连接路径里的 「防中间人」/MITM/「已加密」 等字样，我不预先给结论。
- **token 泄漏面**：请你自己检查日志 / 错误串 / payload 之外的任何落盘位置；我只提供「应当不存在」的位置清单（1.1 表里标「不要打印内容」的四个文件，以及 `.tmp/**` 快照）。
- **面板与平板 UI**：我给的是**路径与代码位置**，不是「我看到过」。

---

## 3. 我做不到、只能请你或用户做的

1. **DSH Web GUI**：本机浏览器对 `127.0.0.1:37946` 返回 401（需要 `dsh web` 打印的带 token 的 URL）。面板的视觉确认只能由你/用户完成。
2. **平板 UI 点击**：我能用 `uitest`/`uinput` 做有限操作，但界面变动后坐标不稳（今天已经失手两次），**最终以用户的一眼/一操作为准**。
3. **真实网络条件**：Tailscale / 公网 IPv6 的可达性我无法在你的网络里替你证明。

---

## 4. 变更记录（本文件随模块更新）

- 2026-11-22 初版：覆盖插件克隆路径 / hash 推导 / outbox 判据 / 平板只读命令 / 监听端口 / payload 与指纹位置 / 五项连接检查；TLS 三态文案与 RC-4 细节标 `[待 RC-4]`。
