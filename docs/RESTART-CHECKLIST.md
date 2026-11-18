# DSH 重启后复测清单（远程访问域）

> 背景：桌面 profile 的插件是 **junction 链接**（`~/.dsh/profiles/desktop/package.json` 里
> `"dsh-git-config-sync": "link:C:/Users/GWL/Desktop/itwillclaude/dsh-sync-suite/packages/dsh-git-config-sync"`），
> 改 `dist/` 后**必须重启 DSH** 才会加载，因此本轮最后两步（真实 GUI 渲染、内嵌 Web 的 WS）
> 只能等重启后验证。重启会杀掉当前会话，**由用户触发**，不要自己重启。

## 0. 重启前（在旧会话里做完）

- [ ] `git status` 干净；`git log -1` 记下 commit（写进交付面）
- [ ] `packages/dsh-git-config-sync` 已 `node scripts/build.mjs`（dist 与 src 同步）
- [ ] 全仓测试绿：`node --test "packages/*/test/*.test.mjs" "apps/arkui-schedule/tools/test/*.test.mjs"`
- [ ] `node apps/arkui-schedule/tools/validate-app.mjs` → 8/8
- [ ] HAP 已构建 + 签名 + 校验（`dist-harmony/arkui-schedule-harmony-debug-signed.hap`）
- [ ] `dist-*/SHA256SUMS.txt` 已生成（见 `tools/pack-dist.mjs`）

## 1. 重启后第一件事：一键自检（不需要人肉点 GUI）

```powershell
# token = `dsh web` 打印的地址里那个 ?token= 的值（桌面版从窗口/日志里拿；脚本不会打印它）
node packages\dsh-git-config-sync\tools\post-restart-check.mjs --token <token> --lan 192.168.1.6
```

它能自动发现 DSH 端口（扫本机监听 + `dsh web authentication required` 指纹），然后逐项判定：

| 检查项 | 期望 | 含义 |
| --- | --- | --- |
| `dsh-port` | PASS | 找到了 DSH 监听端口 |
| `login-token-exchange` | PASS（303 + cookie） | launch token 有效 |
| **`plugin-in-path`** | PASS（`remoteGetState` 返回 6 种方式） | **插件真的进了链路**（不是旧代码） |
| `sync-domain-healthy` | PASS | 失败隔离没被远程域破坏 |
| `sidecar-health` | 若监听在跑 → PASS | `/__dsh_remote/health` 200 |
| `sidecar-token-exchange` | PASS（303 + cookie） | 令牌门工作 |
| **`sidecar-ws-101`** | PASS（101） | 旁挂监听的 WS 反代正常 |
| `sidecar-ws-needs-auth` | PASS（无 cookie 不是 101） | 鉴权没被绕过 |

退出码：0 全通过 / 1 有失败 / 2 环境问题（找不到端口、缺 token、token 过期）。

## 2. 真实 GUI 渲染（人工，约 1 分钟）

- [ ] DSH 设置页应出现**两个独立 section**：「配置同步」与「远程访问」
- [ ] 远程访问 section：6 种访问方式**全部可选**（第 5 轮订正：UU 远程也能用 —— 它自带图形化端口映射，选它会出现「对外入口地址 + 访问令牌」两个输入，并显示 requires 与 5 步提示）
- [ ] 选「局域网直连」→ 出现「局域网地址 / 端口 / 访问令牌（可选）」三个输入
- [ ] 已保存令牌时显示「已保存访问令牌（abcd…wxyz）」，且**页面上看不到令牌明文**
- [ ] 点「显示二维码与链接」→ 出现二维码；正文不出现 `?token=` 明文
- [ ] 点「重新自检」→ 出现 ok/warn/fail/unknown 四色条目与一句总判定
- [ ] 同步 section 未被远程域影响（能正常读状态、不标红）

截图建议：`docs/images/gui-settings-remote-<日期>.png`。

## 3. 内嵌 Web 的 WS 复测（本轮遗留缺陷）

先决条件：远程访问已启动（设置页点「启动」），自检里 `sidecar-ws-101` = PASS。

- [ ] App 设置 → 远程控制 → 局域网直连 + `192.168.1.6` + 端口 + 令牌（或手动方式粘完整地址）→ 打开
- [ ] 观察左下角是否仍「连接异常，刷新重试」
- [ ] 抓 hilog：`hdc -t 6MFBB25C27205131 shell hilog -x | Select-String 'ERR_WS_UPGRADE|blank screen|WebSocket'`

**判定分支**

| 现象 | 结论 | 下一步 |
| --- | --- | --- |
| `sidecar-ws-101` PASS，App 仍 `-173` | **ArkWeb 侧问题**（WS 握手不带会话 cookie） | 在 App 里用 `@ohos.web.webview` 的 `WebCookieManager.fetchCookieSync(url)` 打印是否存到 cookie；若没有 → 走「令牌门接受 WS URL 里的 `?k=`」+ 让页面 WS URL 带令牌（需评估注入） |
| `sidecar-ws-101` FAIL | **我们的代理回归** | 用 `node packages/dsh-git-config-sync/tools/e2e-remote.mjs` 在 PC 上复现并看 listener 日志 |
| App 显示 401/登录页（而非 DSH UI） | 令牌没进到页面 | 检查 App 侧是否把令牌拼进 URL（`?token=`），以及插件是否把它当会话令牌而非上游身份 |

## 4. 回滚

- 插件加载失败导致 DSH 起不来：`dsh plugin remove dsh-git-config-sync`（或从 profile 的
  `package.json` 移除该依赖），**不要**动 `~/.dsh/safe-launch/last-good.json`。
- 远程访问自身起不来不会影响插件激活（已 fail-isolated），状态里看 `status.lastError`。

## 5. 重启后要补记的

- [ ] `docs/ROADMAP.md` 的「待办（等 DSH 重启）」行改成结论
- [ ] `docs/VERIFICATION.md` 追加「重启后复测（日期）」小节：脚本输出 + GUI 截图 + WS 结论
- [ ] 若 WS 定位为 ArkWeb 侧，开一条明确的修复任务并写进 ROADMAP 进行中
