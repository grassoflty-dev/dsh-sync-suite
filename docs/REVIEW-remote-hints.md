# REVIEW — mod-remote-hints（独立只读评审）

- 对象：未提交改动，HEAD `6e16ff1`；基准 `项目理解.md`、`docs/REMOTE-ACCESS-OPTIONS.md` §3 与 2026-11-20 更新段。
- **结论：P0 0 / P1 0 / P2 2；可以提交**（P2 非阻塞，建议提交前一并澄清文案）。核心 bug 已修复且有守卫，5 门全绿，无越界改动。

## Findings（file:line）

- **P2-1 UU 提示与仓库自身 UU 机制自相矛盾（误导措辞）**：`apps/arkui-schedule/entry/src/main/ets/model/remoteAccess.ts:332` 写「不需要端口映射」「完成设备配对（手机/平板端“远程桌面”连到该电脑）……在本页填 UU 给出的访问地址」。但同文件 `uu` 规格 `requires`/`steps`（`:292-295`、`:306-312`）与 `docs/REMOTE-ACCESS-OPTIONS.md:158-187`（§2.6）明确：本 App 的 UU 方式靠**图形化端口映射**（内部端口 = DSH 端口 → 对外入口 → 粘进 App）；`docs/RESEARCH-B2-uu-remote-ports.md:101-119` 进一步指出出口是电脑上的 `127.0.0.1:本地端口`、主控端仅 Windows/macOS，平板端「远程桌面」流程**不产生可填的 URL**。两者无法同时成立：按提示做设备配对则找不到"访问地址"，按"不需要端口映射"跳过建映射则 App 无地址可开。建议改成「不用改路由器（UU 内建图形化端口映射）：电脑登录 UU 远程，内部端口填 DSH 端口，复制生成的对外入口粘到本页」，保留"不是同一局域网"的否定语义。
- **P2-2 Tailscale 提示漏掉最关键前置条件**：`remoteAccess.ts:328` 说「两端都加入同一个 tailnet，填对方 Tailscale IP 或 MagicDNS 名」，但 `docs/REMOTE-ACCESS-OPTIONS.md:132-148` 强调平板侧必须**鸿蒙原生客户端**（卓易通不可用），且插件绑定只认 `100.x` IPv4（§3 `:222`）。「两端都加入」易让人以为装安卓版即可；建议补「平板需鸿蒙原生客户端」。App 拼地址侧（`:852-860`）确实接受 MagicDNS 名，故仅算文案遗漏，非逻辑错误。
- **检查 1/2/5（正向）**：`remoteAccess.ts:341-347` 精确查表、未知值/非字符串均返回 `''`；`RemoteSection.ets:350-354` 走 `remoteModeHint()` 且空串不渲染；旧写死文案已从 `RemoteSection`/`Settings` 消失（`remoteHints.test.mjs:147-152` 另有守卫）。`git status` 仅 6 改 + 1 新，无越界；沿用仓库既有 `typeof` 守卫写法（`:367-383`），无新 SDK import，ArkTS 卫生合格。
- **检查 4（测试质量，正向）**：9 例均为真断言——枚举全覆盖（`:77-89`）、逐字（`:91-95`）、特征互斥（`:97-112`、`:114-123`）、UU 否定语义（`:125-127`）、未知回空串（`:129-134`）、渲染走表 + 无写死文案（`:142-160`）。`remoteSettings.test.mjs:108-113` 的 retarget 是**合理加强**：仍断言 HintLine 存在，并新增旧文案不得存在的否定断言，不是弱化。

## 提示逐字真实性

| 方式 | 准确？ | 备注（`remoteAccess.ts`） |
| --- | --- | --- |
| `lan` | ✅ | 同一 Wi-Fi + 局域网 IP:端口，与 §2.1 一致（`:327`）；短提示未提防火墙，可接受 |
| `tailscale` | ✅ / ⚠️ | 「不需要端口映射」属实；漏鸿蒙原生客户端前置（P2-2，`:328`） |
| `cloudflare` | ✅ | cloudflared 已启动 + `*.trycloudflare.com`/自定义域名，与 §2.3 一致（`:329`） |
| `ipv6` | ✅ | 公网 IPv6 + **防火墙放行** + 平板支持 IPv6，与 §2.2 一致（`:330`） |
| `manual` | ✅ | 含协议、地址与令牌校验、红字失败原因，与 §2.5 一致（`:331`） |
| `uu` | ⚠️ | 「不是同一局域网」属实；「不需要端口映射」与设备配对/远程桌面描述见 P2-1（`:332`） |

## Gate tails（本轮实跑）

```
[overlay] applied=false                       (exit 0)
tsc: exit 0，无输出
remoteHints + remoteSettings: tests 27 / pass 27 / fail 0 / skipped 0
full: tests 2883 / suites 326 / pass 2882 / fail 0 / skipped 1 / duration_ms 30303
validate-app: ✅ 全部通过：8/8（JSON5/JSON 70、相对 import 425、main 静态 import 545、页面 7、rawfile/git 2）
```
预期 2883/2882/0/1、validate 8/8、tsc 0、overlay false —— 全部吻合。

## unverified

- 真机（平板）设置页提示块的实际渲染与截图：本环境 `hdc` 不在 PATH，未执行 `hdc list targets`；沿用改动方记录 `[Empty]`，标注 `unverified`。
- UU 对外入口形态 / WS upgrade 透传仍标「待实测」（`docs/REMOTE-ACCESS-OPTIONS.md:195-200`），本轮未做运行期验证；P2-1 基于仓库文档对照，非运行期证据。
