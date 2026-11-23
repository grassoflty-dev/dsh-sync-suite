# 远程控制 / 插件侧 git 同步 —— 自查手册（给 Lead，不是结论）

> 目的：让 Lead **自己**验证端到端，而不是接受执行者的报告。
> 本文件只写「怎么做」与「看什么」，**不含任何「已验证通过」的结论**。
> 状态标记：`[现成]` = 今天就能查。原「待 RC-4」占位标记已于 2026-11-23 RC 车道闭合时退役；§4 变更记录里保留其历史出现。

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
- **pre-flight expectation（任何配对测试之前）**：先确认 `enabled === true`，再确认本端口确实能接受一条 TCP 连接；两者缺一就不要开始配对（此时配对失败不能归因于对端）。探测命令（端口若已被扫描改成别的值，把 `44996` 换成实际端口）：

  ```
  node -e "require('net').connect({port:44996,host:'127.0.0.1'}).on('connect',()=>{console.log('OPEN');process.exit(0)}).on('error',e=>{console.log('CLOSED',e.code);process.exit(0)})"
  ```

  输出 `OPEN` 才算端口可用；`CLOSED <code>` 说明监听没起来，先回去核对 `enabled` 与实际端口。
- 读当前端口：`payload` 里的 `port`（见 2.2），或 `remote-pairing-state.json` / remote 设置里的 `port`。
- **TLS 已落地、端口 / 协议已定稿（2026-11-23）**：插件侧强制 HTTPS-only、单一 `https.createServer` 终止 TLS；端口仍由配对引擎自动挑选并记录（默认 44996，占用则扫描后写回 remote 设置）。本行断言：此后端口与协议就是定稿，没有待补项；将来若真的变化，本行是唯一需要更新的位置。

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

三条拒绝文案的**逐字**内容（a/b/c 三态）已于 2026-11-23（RC-4 闭合）从唯一事实源
`apps/arkui-schedule/entry/src/main/ets/model/tlsPin.ts` 抄进下表，并标注各自产生位置：

| 场景 | 文案（逐字，源自 `model/tlsPin.ts`） | 产生位置 / 说明 |
| --- | --- | --- |
| (a) 指纹不匹配 | `证书指纹与配对时固定的一致才能连接：当前证书指纹不匹配，已拒绝连接（可能是换了机器、换了证书或中间人）` | `TLS_PIN_MISMATCH_WORDING`；由 `onSslErrorEventReceive` 链上 `verifyPinnedCertificate(chain, pin)` 判出 `mismatch` 时产生 |
| (b) 从未配对（无 pin） | `该实例从未配对过（无 pin），没有固定的证书指纹，已拒绝连接；请先回设置页用二维码配对，连接本身不会自动信任证书` | `TLS_NO_PIN_WORDING`；`pages/RemoteControl.ets` 在**任何 Web 加载之前**的预检查产生（pin 为空 / 损坏 / 老实例无该字段） |
| (c) 证书链无法获取/校验 | `无法校验证书链，已拒绝连接` | `TLS_CHAIN_UNVERIFIABLE_WORDING`；`pages/RemoteControl.ets` 预检查与 `onSslErrorEventReceive` 链共同产生；**fail-closed——绝不报成 (a)，也绝不报成成功** |

### 2.4 我不会替你预审的东西（按你的要求）

- **文案审计**：请你自己 `grep` 新连接路径里的 「防中间人」/MITM/「已加密」 等字样，我不预先给结论。
- **token 泄漏面**：请你自己检查日志 / 错误串 / payload 之外的任何落盘位置；我只提供「应当不存在」的位置清单（1.1 表里标「不要打印内容」的四个文件，以及 `.tmp/**` 快照）。
- **面板与平板 UI**：我给的是**路径与代码位置**，不是「我看到过」。

### 2.5 指令通道拒绝文案指针（2026-11-23，RC-4）

- **唯一事实源**：`apps/arkui-schedule/entry/src/main/ets/model/remoteCommandGate.ts` 的 `COMMAND_WORDING`（8 个 typed 码），由 `components/RemoteCommandComposer.ets` **逐字渲染**，不手写任何拒绝句；8 码为 `E_COMMAND_TARGET_MISSING` / `E_COMMAND_TOOL_NOT_ALLOWED` / `E_COMMAND_TEXT_EMPTY` / `E_COMMAND_TEXT_TOO_LONG` / `E_COMMAND_NOT_GRANTED` / `E_COMMAND_UNCONFIRMED` / `E_COMMAND_CONFIRM_STALE` / `E_COMMAND_REMOTE_UNVERIFIED`。最后一档 `E_COMMAND_REMOTE_UNVERIFIED` 的文案是 `安全连接尚未通过真机校验，未发送任何内容`。
- **没有投递通道**：`sessionPrompt` 延后（pending `mod-chat-lease` + 设备门禁），`REMOTE_CHANNEL_VERIFIED = false`；「发送指令」动作**永久禁用**，其可见原因就是闸自己的 `wording`。
- **任何测试都不得断言一次发送**：不存在 in-flight / 成功状态；真机渲染、交互与真实投递一律 `unverified`。

---

## 2.6 远程页（B 方案：插件代理电脑上的 DSH GUI）—— 2026-11-24 新增

这一节是 `mod-plugin-gui-proxy` 落地后的自查顺序。**前提只有两条**，缺任何一条页面都打不开：

1. 电脑上 DSH 本体在跑（它只监听回环，`127.0.0.1`，端口每次启动可能不同）；
2. 插件远程监听已启动且平板已配对（设置 → 远程控制 → 开始接受连接 → 平板扫码）。

不需要：把 DSH 暴露到局域网、给电脑装证书、在平板上装 CA、额外端口转发。

### 2.6.1 电脑侧（只读）

```powershell
# 1) DSH 的 GUI 端口（只监听回环，这是正常的）
Get-NetTCPConnection -State Listen | Where-Object { $_.LocalAddress -eq '127.0.0.1' } |
  Select-Object LocalPort, OwningProcess | Sort-Object LocalPort

# 2) 插件监听端口（配对串里那个）
$hdc = "D:\A-DevEco\DevEco Studio\sdk\default\openharmony\toolchains\hdc.exe"
& $hdc list targets
```

判读：DSH 的 GUI 端口只出现在 `127.0.0.1` 上是**设计如此**，不是故障；插件代理会在电脑本机带 `?token=` 去换 `dsh-auth` cookie，令牌不出电脑。

### 2.6.2 平板侧（`uitest dumpLayout`，机械断言）

一条命令跑完（脚本在 `.tmp/device-check-remote.mjs`，属临时件，不进仓库）：

```powershell
node .tmp/device-check-remote.mjs 192.168.1.11:33023
```

它会自动点「远程 DSH」→「打开」，然后逐条断言：

| 断言 | 期望 | 失败意味着 |
| --- | --- | --- |
| 平板已连 | 出现 serial | 无线调试断了，重连 `hdc tconn` |
| 实例列表渲染 | 出现「N 个实例」 | 实例库为空或页面没刷新 |
| 不是我们的错误页 | 页面**不含**「电脑上的 DSH」/「未启动」类文案 | 代理拿不到上游（DSH 没跑 / 监听没起） |
| 有 DSH 界面内容 | 出现 DSH 自己的界面文案 | 上游 403（Origin 栅栏）或资源全 404 |
| 无英文 401 | 不含 `dsh web authentication required` | 令牌没注入成功 |
| 无原始 JS 报错 | 不含 `Cannot read propert` | 桥/代理把异常泄到了页面 |
| 发指令控件（若在页面上） | `enabled=false` / `clickable=false` | 硬禁用回归 |

### 2.6.3 三条「不能用」的判别（对应用户会报的症状）

| 症状 | 最可能原因 | 电脑侧怎么证 |
| --- | --- | --- |
| 页面白屏 / 一直转 | DSH 没启动，或插件监听没起 | `Get-NetTCPConnection` 找不到 DSH 回环口；面板显示监听未启动 |
| 页面能开但点不动、发消息失败 | 上游 403（Origin/Host 栅栏） | 代理日志里 `E_UPSTREAM_*` 或上游 403；本仓库 `test/gui-proxy-fence.test.mjs` 复刻了这条栅栏 |
| 平板显示英文 401 | 令牌注入失败 | 插件进程内的上游 cookie 槽失效；重启 DSH 让插件重新取 `authenticatedUrl` |

### 2.6.4 我**不**替你做的事

- 不解锁你的平板、不代按密码；
- 不重启你的 DSH（会结束当前会话）；
- 不把 DSH 暴露到局域网、不装 CA、不开端口转发（这些都已明确否决，理由见 `docs/RESEARCH-B-dsh-gui-proxy.md` §6）。

## 3. 我做不到、只能请你或用户做的

1. **DSH Web GUI**：本机浏览器对 `127.0.0.1:37946` 返回 401（需要 `dsh web` 打印的带 token 的 URL）。面板的视觉确认只能由你/用户完成。
2. **平板 UI 点击**：我能用 `uitest`/`uinput` 做有限操作，但界面变动后坐标不稳（今天已经失手两次），**最终以用户的一眼/一操作为准**。
3. **真实网络条件**：Tailscale / 公网 IPv6 的可达性我无法在你的网络里替你证明。

---

## 4. 变更记录（本文件随模块更新）

- 2026-11-22 初版：覆盖插件克隆路径 / hash 推导 / outbox 判据 / 平板只读命令 / 监听端口 / payload 与指纹位置 / 五项连接检查；TLS 三态文案与 RC-4 细节标 `[待 RC-4]`。
- 2026-11-23 RC-4 闭合：§2.3 三条拒绝文案以 `model/tlsPin.ts` 三常量逐字替换 `[待 RC-4]` 占位，并标注产生位置与 (c) 的 fail-closed 语义；新增 §2.5 指令通道拒绝文案指针（`COMMAND_WORDING` 8 码 / composer 逐字渲染 / `sessionPrompt` 延后 / 发送动作永久禁用 / 不得断言发送）。构建与门闸证据见 `docs/MODULES.md` §5；未发明任何设备结果，真机渲染 / 交互与真实投递仍 `unverified`。
