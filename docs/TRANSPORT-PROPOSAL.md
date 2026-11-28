# 传输方式提案：把「能用」分成三档（2026-11-28，**提案，未落地**）

> **这份文件是给用户拍板用的，不是已生效的设计。** 在用户回答之前，
> **默认接入方式仍是 `lan`**（`packages/dsh-dots/src/remote/accessMode.ts:324`），
> **任何 UI 文案都没有改**。本文只记录事实、选项与代价。

## 1 一句话结论

**默认应当是「零配置」的那一档（局域网直连），公网 IPv6 直连必须降级为「高级选项」**——
它要求用户改路由器/光猫的入站规则，这不是普通用户能完成的操作，把它与另外两档并列是产品层面的错误。

## 2 三档能力矩阵

| | 局域网直连（`lan`） | Tailscale / Tailcat 组网 | 公网 IPv6 直连（`ipv6`） |
| --- | --- | --- | --- |
| 现在能不能用 | **`ready`**（`accessMode.ts:111`） | `needs-setup`（`:137`） | `needs-setup`（`:169`） |
| 需要用户做什么 | 平板与电脑同一个 Wi-Fi（`:113`） | 电脑装 Tailscale 并登录；**平板要侧载鸿蒙原生客户端**（`:139-143`） | 宽带给公网 v6 + **路由器/光猫放行入站端口** + 平板所在网络也有 v6（`:171-175`） |
| 要第三方账号 | 不要 | **要** | 不要 |
| 要改路由器 | 不要 | 不要 | **要** |
| Windows 防火墙 | 首次绑定端口时**可能弹一次系统提示**（放行即可）；插件能**读**防火墙状态并给出具体命令，但**从不替你写规则**（`probe.ts:1062-1161`） | 同上 | 同上，**且必须**放行，否则外网一律连不上 |
| 家里以外能用 | **不能** | **能** | 能（前提是上面的运维都做完） |
| 适合谁 | 所有人，默认 | 想在外网用、且愿意装一个客户端的人 | 有公网 v6、会配路由器的高级用户 |
| 主要坑 | 换 Wi-Fi 就换地址 | 平板上要装**侧载 HAP**；卓易通里的安卓 Tailscale **不管用**（`:24-25`、`:142`） | 临时 IPv6 地址约每小时轮换，外网会周期性连不上（`probe.ts:943`） |

### 2.1 tailcat 与上表「Tailscale / Tailcat 组网」那一列的关系

这一列里的 **tailcat 不是另一条独立通道**，容易误读，单独说明：

- **tailcat 是 Tailscale 的 user-space WireGuard 库**（`docs/TAILCAT-HARMONYOS-SPIKE.md:34`）：不需要内核 TUN、不改路由表；magicsock 做「直连 UDP + DERP」打洞。
- **数据面可以直连，但不是「完全不经过服务器」**：打洞成功时数据端到端直连（协调服务器看不到内容）；**打洞失败会退回 DERP 中继**（中继看到的仍是密文）。而**协调面**（登录、密钥、NAT 发现）始终要经过 Tailscale 的控制面，除非自建 Headscale。
- **本项目已决定平板侧不用 tailcat**：`docs/TAILCAT-HARMONYOS-SPIKE.md:52` 明确「tailcat 仅 host↔host（电脑控电脑）；平板侧 adapter 保持 typed `E_TRANSPORT_UNSUPPORTED`，不静默降级」。原因是工程代价：平板要 NAPI 编 `aarch64-linux-ohos` 的 `.so`、需要 OHOS 的 Go fork、前台 PoC 约 5–10 人日，且**端到端仍未验证**。
- 因此对用户而言，「tailscale」这一档实际走的是**平板上的系统级客户端（目前只有侧载的 HarmoTail）**，不是 tailcat。

一句话对照：**真正「不经任何第三方服务器」的只有 `lan` 与 `ipv6`**（代价分别是「只能在家」与「要动路由器」）；`tailscale` 是零入站配置的那条，但数据面是否直连取决于打洞是否成功。

## 3 为什么 IPv6 必须是「高级选项」

1. **它要求改路由器。** `accessMode.ts:171-175` 已经把这三条写进 `requires`：公网 v6、**光猫或路由器放行该端口入站**、平板网络也有 v6。第一条和第三条取决于运营商，第二条是路由器管理界面的操作——普通用户到不了这一步。
2. **还有一层 Windows 防火墙。** 插件的自检会读 `netsh advfirewall show currentprofile` 与入站规则（`probe.ts:1071`、`:1132`），并在缺失时给出**具体命令**（`:1140`），但它**只读不写**：规则仍要用户自己在管理员命令行里加。这是一个必须有人念给用户听的操作。
3. **地址会漂。** 插件会提示改用 `Addr Type` 为 Public 的稳定地址，并说明临时地址约每小时轮换（`probe.ts:901`、`:943`、`:970`）。也就是说"配好一次就永远能用"在 IPv6 直连上并不成立。
4. **它没有比另外两档更安全。** 信任锚是指纹 TOFU（`pairingTls.ts:2-11`、`pairingPayload.ts:26`），与 `lan`/`tailscale` 完全同一套；把 HTTPS 端口直接暴露到公网，**暴露面反而更大**。

## 4 现在的 `tailscale` 方式做了什么、还缺什么

**已经做到的（都有代码依据）**
- 是一种正式的接入方式，`bindKind: 'tailnet'`（`accessMode.ts:163`），会真的起监听。
- 能识别 tailnet 地址：CGNAT `100.64/10`，或 Tailscale 的 v6 ULA 前缀 `fd7a:115c:a1e0::/48`（`probe.ts:344-345`）。
- 自检会核对"设置里填的主机"与"本机实际 tailnet 地址"是否对得上（`probe.ts:1173-1184`），对不上会报出来。
- 允许填 `100.x` 地址或 MagicDNS 名（`accessMode.ts:144-154`），但绑定仍需具体地址（MagicDNS 名不能用来 bind）。

**对普通用户还缺什么（这是重点）**
1. **没有"一键加入网络"。** 整个流程是**纯文字步骤**（`accessMode.ts:155-161`）：自己装客户端、自己登录、自己去后台复制地址、自己填进来。没有登录跳转、没有 SSO 回调、没有设备列表拉取。
2. **平板侧是硬门槛。** `:141` 明说平板要装**鸿蒙原生客户端（如 HarmoTail，需侧载 HAP）**；`:142` 明说卓易通里的安卓 Tailscale 不能让本机 App 走它。也就是说普通用户在平板上**没有可点一下就装的路径**。
3. **没有"安装/登录状态"检测。** 桌面端是否装了 Tailscale、是否登录、是否在线，代码里没有检测（既没有读 CLI，也没有读 Tailscale 的本地 socket）；只有地址层面的自检。
4. **换账号/换网络要手工重填。** 地址是手动填进 `tailscaleHost` 的，没有自动跟随。

## 5 如果要"自建中继"（不采用第三方账号）

一段话，不写实现：自建中继意味着我们要长期拥有一台有公网地址的服务器、给它配证书自动化、自己做鉴权与配对、
自己承担带宽与在线率，并且**它成为新的信任锚与新的隐私面**——所有正文流量都经过我们（或用户）的机器，
一旦它被打穿，暴露面比现在的"点对点 HTTPS"大得多。运维成本不是一次性的：续证、升级、监控、被滥用后的封禁处理，
都要有人负责。**结论：自建中继不是"省掉一个第三方账号"，而是"接手一个长期服务"**；在用户没有明确要求前，
不应把它写进路线图。

### 5.5 国内厂商的 TCP 端口映射（UU / 向日葵 / 花生壳；2026-11-28 核对）

这一节回答一个具体问题：**能不能借国内厂商的「端口映射」给平板一条免自建、免改路由器的外网通道？**
结论先说：**对鸿蒙平板，UU 与向日葵两条都关闭**（不是「难」，是厂商文档直接排除）；**花生壳是唯一还有戏的一条**，但它仍是第三方中继，体验版有 1 Mbps / 1 GB 月的硬上限，而且**厂商没有承诺它会保留端到端证书**（§5.5.3）。

| | 网易 UU 远程 | 向日葵 | 花生壳（贝锐的另一条产品线，不是向日葵） |
| --- | --- | --- | --- |
| 有没有 TCP 端口映射 | **有**（官方：「端口映射是 UU远程提供的隧道穿透能力……把远端设备本机，或远端设备所在局域网内的 TCP 服务映射到本机端口」） | **有**（官方定价页端口映射 tooltip：「支持创建TCP映射隧道，轻松实现端口映射」） | **有**，体验版即含 TCP 映射 |
| 平板能不能当**发起方** | **不能**（官方「适用设备与版本」表：「主控端和被控端均仅支持 Windows、macOS 电脑端」） | **不能**（官方同一 tooltip：「当前仅支持Windows、macOS系统版本，其余系统正在适配中」） | 发起方=装了客户端的主机（Windows/Mac/Linux）；消费方只要一个地址（**推断**：官方案例说「通过生成的地址即可访问」，厂商未明说消费端是否要装客户端） |
| 鸿蒙客户端 | **没有**（官方下载页只列 Windows / macOS / iOS / Android / Android TV） | **有，但只是「鸿蒙NEXT［尝鲜］」，且只做发起远控**（「支持发起手机和电脑远程桌面」）——不含端口映射 | 官方下载页无鸿蒙入口；**这里也不需要（推断）**：平板直接连映射出来的地址 |
| 费用 | 免费内置（需两端登录同账号） | **付费**：端口映射列在**超级会员**（官方：￥298 起/年） | 体验版免费（**映射条数 2、带宽 1 Mbps/映射、流量限 1 GB/月**），超出需付费 |
| 两端都要装客户端吗 | 远控要两端；映射只在电脑端配（「在本机使用 `127.0.0.1:本地端口` 访问远端服务」） | 映射只在 Windows/macOS 端配 | 主机装客户端；消费端只要地址（**推断**：厂商未明说消费端是否需装客户端） |
| 要账号吗 | 要（官方博客三套配置之 1：「两端安装网易UU远程并登录同一账号」） | 要（登录/注册入口；具体条款未见） | 要（客户端/CLI 需先登录） |
| 出口形态 | **主控端回环** `127.0.0.1:本地端口`，**不是**公网 URL | 映射地址（公网入口） | **公网地址/域名**：官方案例「分部或外出员工通过生成的地址即可访问」 |
| 对 TOFU 的影响（会不会终止 TLS） | **厂商未声明** | **厂商未声明** | **厂商未声明**；而且同一家另有「HTTPS 映射」产品，明确「数字证书自动部署在花生壳服务器」——**说明它有能力终止 TLS，只是没写 TCP 映射会不会** |
| 证据等级 | 官方帮助页 + 官方博客 + 官方下载页 | 官方定价页 + 官方下载页 | 官方定价页 / 下载页 / 案例页 |
| 对平板的结论 | **关闭** | **关闭** | **唯一可测**，但仍属第三方中继 |

#### 5.5.1 为什么 UU 与向日葵对我们是关闭的
- UU：官方帮助页《UU远程端口映射怎么用？》「适用设备与版本」表逐字写着「**主控端和被控端均仅支持 Windows、macOS 电脑端**」，且出口是主控端的 `127.0.0.1:本地端口`——平板既不能发起，也拿不到一个能打开的 URL。这与本项目 2026-11-18 的记录一致（`docs/RESEARCH-B2-uu-remote-ports.md:12`、`:111-113`）。规则「挂在会话上」这一点官方 FAQ 也写了（关闭端口映射面板后映射不会继续），第三方实测另补了「device disconnect 留幽灵监听」「手机不能当发起方」等细节（同文件 `:74`、`:103-104`）；那份实测的 44–56 ms 境内延迟有用，但它救不了「平板不能发起」这条硬限制。
- 向日葵：官方定价页把端口映射框在「Windows、macOS」且放在**超级会员**档；它的鸿蒙 NEXT 客户端只是「尝鲜」的**远控发起端**，没有端口映射入口。用平板做发起方这条路，在厂商文档层面就不存在。

#### 5.5.2 花生壳：唯一还有戏的一条，但代价要先看清
- 形态对口：主机装客户端 → 平台生成映射地址 → 平板浏览器/App 直接连那个地址（官方案例页：「分部或外出员工通过生成的地址即可访问总部系统」）。**不需要鸿蒙客户端**（推断：消费方只是打开一个地址；厂商未明说消费端是否需要装客户端），这正是我们唯一缺的那一环。
- 代价是硬的：体验版 **1 Mbps/映射、1 GB/月、2 条映射**。对一个远程控制的 Web GUI，1 Mbps 是带宽天花板，1 GB/月 约等于每天 33 MB（判定，非厂商数字换算承诺）——文字对话够用，图片/文件预览很快就顶到上限。要在产品里说「能用」，必须写成「体验版够聊天，重内容要买付费档」，不能写成「免费可用」。
- 它属于第三方中继，和 §8.3 的分界不冲突：选它就等于选了「厂商当中继」那一侧，只是厂商换成了境内的。

#### 5.5.3 信任模型：TOFU 能不能活下来，三家都**没有**承诺
- 三家都只把能力描述成「隧道穿透 / TCP 映射隧道」，**没有任何一家写「不终止 TLS / 不改证书」**。反向证据是：花生壳另有独立的「HTTPS 映射」产品，明确说「数字证书自动部署在花生壳服务器」——同一家厂商有能力在服务端终止 TLS，只是没声明 TCP 映射是否会这样做。
- 所以「TCP 映射会保留我们的配对指纹」目前是**推断**，不是事实。要把它变成事实，只有一次**可证伪的实测**：从平板侧用 TLS 客户端连映射地址，读出对端叶证书的 SHA-256，与 `packages/dsh-dots/src/remote/pairingTls.ts:2-11` 固定的指纹逐字节比对，并用同一台电脑的**局域网直连**做对照。指纹一致 ⇒ 该路径在那一刻保住了 pin；不一致 ⇒ TLS 被终止，这条路直接作废。命令形态：`openssl s_client -connect <mapped-host>:<port> -servername <name> | openssl x509 -noout -fingerprint -sha256`。
- 即使实测通过，也只能记成「某时某地观察到的事实」，**不能写进架构保证**：厂商随时可以改映射实现。

#### 5.5.4 结论（不改变默认，也不改变 §8 的分界）
1. **UU 与向日葵不值得占用一次真机 pass**：两者的关闭不是「没测过」，而是厂商文档写明平台不支持。
2. **花生壳值一次「一次性证伪」**：只在已经有一台常开的 Windows/Mac 主机、且用户愿意接受 1 Mbps / 1 GB 月 的体验版时做；测的是 §5.5.3 那条指纹比对，测完即记账，成功也只算「观察到」。
3. **本文其余结论不变**：默认仍是 `lan`（`accessMode.ts:324`），`tailscale` / `ipv6` 的定位不变，§8.3 的「外网零配置必然要有人当中继」也不变——花生壳只是把「中继是谁」换成了境内厂商。

## 6 需要用户裁定

1. 默认档位是否就定 **`lan`（零配置、仅家里）**，把 IPv6 放到「高级选项」并注明要改路由器？
2. `tailscale` 这一档要不要**现在**投入做成"一键加入"（需要解决平板侧客户端的分发，否则仍然要侧载）？
3. 公网访问这件事，用户愿意接受"**要装客户端**"还是"**要改路由器**"？二者必选其一，没有第三个零成本选项。
4. 自建中继：明确不做，还是留作将来选项？
5. 外网访问要不要接受「**第三方中继**」这一档？——同类插件的做法与两条路的建设成本见 §8（`ds-harness-remote` 与 `agentdeck` 是两家真做到**外网**零配置的：前者要账号 + 项目自建服务端；后者的厂商中继 README 未写要账号，见 §8.3 / §8.4）。

## 7 我们**没有**改什么（避免误读）

- 默认接入方式**仍是 `lan`**（`accessMode.ts:324`）。
- 三种方式的 `label` / `description` / `requires` / `steps` **一字未动**。
- 没有新增或删除任何方式，没有新增 UI 控件。
- 本文只是把"哪一档适合谁"写成可核对的事实，供用户拍板。
- §8（2026-11-28 增补）是对**外部四个同类插件**的只读对照：**对外**只引用它们的 README 原句与 GitHub API 数字，**对内**引用源码时附 `path:line`；成本、代价与可达性一类判断是**判定/估算**，不冒充 README 事实。本节不改本项目的任何代码、文案与默认值。

## 8 同类 DSH 远程插件是怎么做到「零配置」的（2026-11-28 核对；**只读对照，不构成切换建议**）

> 本节是外部事实 + 代价对照，不是路线变更：默认接入方式仍是 `lan`（`packages/dsh-dots/src/remote/accessMode.ts:324`），本节没有改任何代码、文案或开关。
>
> **核对方法（重要，决定这些结论能被信到什么程度）**：只读四个仓库 `HEAD` 的 `README.md`（2026-11-28 抓取，原文与所在小节随文给出 URL）；星数 / fork / 建仓日取自 GitHub API 同一时点。**README 没写的，本文不写成事实**；凡属推断，句中标「（推断）」。四个项目都是社区第三方，不是 DeepSeek 官方产品（`ds-harness-remote` 与 `dsh-plugin-agentdeck` 的 README 各自写明了这一点）。

### 8.1 一句话画像

| 项目 | ★ / fork（2026-11-28 读） | 主机要公网入口 | **外网**零配置靠谁 | README 口径的加密 | 客户端形态 |
| --- | --- | --- | --- | --- | --- |
| `liguobao/ds-harness-remote` | **3,907** / 281（2026-08-14 建仓） | **不要**（只出站） | **项目自建**控制面 + 中继 + TURN（默认 `https://dsh.r2049.cn`） | `Noise_IK_25519_ChaChaPoly_SHA256` + 设备密钥 pinning | Web / Android 原生 / **HarmonyOS 原生** / iOS（TestFlight beta）/ dsh-TUI / DSH 插件 |
| `mantou132/dsh-plugin-agentdeck` | **0** / 0（**2026-11-27 建仓**，读到本文时 1 天） | 不要（手机 ↔ 本机 `agentdeckd`，经中继转发密文） | **厂商 AgentDeck** 的中继（README 称亦支持自建中继） | `XChaCha20-Poly1305` | iPhone / Android 原生 App（README 未见 Web 端） |
| `winlin926/dsh-carry` | **3** / 0（2026-10-25 建仓） | 不要（同 Wi-Fi 走 WebRTC 直连——**推断**，由 README「公网访问且同处局域网时自动建立 WebRTC 直连」概括；外网**自备**隧道） | **不自带**：Cloudflare Tunnel / Tailscale / Caddy VPS / SakuraFrp | **明确不提供**（「本插件不提供节点之上的端到端加密」，节点运营者可能看到内容） | 手机**浏览器**（无 App） |
| `xgone/dsh-remote` | **48** / 15（2026-08-16 建仓） | 不要（本机回环 + 反代/隧道） | **不自带**：nginx / `ssh -R` / Tailscale / frp / Cloudflare Tunnel | README **未主张端到端加密**（只提「密码使用 scrypt 加密存储」），保护面是登录门禁 + HTTPS 反代 | 手机**浏览器**（可装成 PWA） |

### 8.2 逐条原句（这一节的每句话都能点回去）

> 引用格式：`仓库 + README 小节 + 该节里的逐字原句`。**不写行号**，因为 README 每次改动都会让行号漂移；小节标题 + 原句是可长期核对的锚点（要复核时在该节内全文搜这句即可）。

**`liguobao/ds-harness-remote`**（<https://raw.githubusercontent.com/liguobao/ds-harness-remote/HEAD/README.md>）
- 不要公网端口/IP：`## Features` — "No public listening port or public IP is required on the Harness Host."；`## FAQ` — "The Host only opens outbound connections and never listens on a public port."
- P2P 优先 + 全球多 TURN + 多 Server Relay 兜底：`## Features` — "Prefer P2P connections, use TURN relay nodes worldwide, and fall back to multiple Server Relays when needed."；中文 README（<https://raw.githubusercontent.com/liguobao/ds-harness-remote/HEAD/README.zh.md>）`## 主要特性` 同一句：「优先使用P2P网络，全球多TURN节点中转，极端情况下使用多Server Relay兜底」。路径顺序 `## Network and transport` — "`LAN -> P2P -> TURN -> Relay`"。
- 要账号：`## Quick start` 第 2 步 — "Sign in with Zhihu, GitHub, or Google."
- 客户端矩阵：`## Supported clients` — Android / HarmonyOS 均为 "Native app / Supported"，Web 为 "Browser page / Supported"，iOS 为 "TestFlight beta / Beta"，dsh-TUI 为 "Core device checks passed"（**不是** Supported）。
- 复用 DSH 原生 UI：`## Features` — "DeepSeek Harness Desktop is ready to use after installation, with its native interface and no separate desktop conversation UI."；Web 行 — "reuses the native Harness interface"。
- 默认服务器就是项目的服务端：`## Quick start` — "By default, Remote uses this project's hosted Server at https://dsh.r2049.cn."；自建只能拿到最小服务端，且 `## Quick start` 明言 "TURN requires your own coturn deployment"。

**`mantou132/dsh-plugin-agentdeck`**（<https://raw.githubusercontent.com/mantou132/dsh-plugin-agentdeck/HEAD/README.md>）
- 零配置：标题即 "Zero-config mobile remote control plugin"；`## Zero-Click Setup` — "everything is provisioned automatically in the background on startup"。
- native ACP：正文 — "Control DeepSeek Harness from your **iPhone or Android** over native ACP"。
- 加密：`## Security, Privacy & Uninstall` — "Traffic between your phone and `agentdeckd` is encrypted with `XChaCha20-Poly1305`. The relay only forwards ciphertext envelopes and cannot read prompts, files, or diffs; **self-hosted relays are also supported**."
- 推送 / 零隧道：正文 — "end-to-end encrypted (`XChaCha20-Poly1305`), with push notifications, file & diff viewing, terminal output, and zero tunnel/VPN setup."（推送只在这句里出现过一次，README 未给机制说明。）
- 守护进程 + 扫码：`## Zero-Click Setup` — "Installs `agentdeckd` automatically and enables OS login autostart (`launchd` / `systemd --user` / Windows Task Scheduler)."；"just your **scannable pairing QR code**"。
- 手机 App 的可得性：`## Get the Mobile App` — iOS 链接后注明 "*(not available on the Mainland China App Store; requires a non-China Apple ID)*"；Android 走 Google Play 或 GitHub Releases 的 APK。

**`winlin926/dsh-carry`**（<https://raw.githubusercontent.com/winlin926/dsh-carry/HEAD/README.md>）
- 扫码续接 / 审批 / 预览：正文 — 「扫码配对后即可继续会话、审批工具请求、查看工作区文件或预览 HTML 页面」；`## 📱 手机上能做什么` 表 — 「工具请求正在等待授权」行「直接在宿主同步界面中审查详情并决定是否批准执行。」、预览行「点击工作区文件链接直接下载，或在浏览器中预览 HTML 页面。」
- 首次配对要同一 Wi-Fi：`## 📦 安装与首次连接` — 「**首次配对请确保手机与电脑处于同一 Wi‑Fi。**」
- 外网要自备通道：`## 🌐 离开同一 Wi-Fi 后怎么连？` 表 — Cloudflare Tunnel / Tailscale / Caddy VPS / SakuraFrp（后者标注「国内无 VPS 方案」）。
- **它拒绝当信任锚**：同节安全框 — 「公网中继节点或内网穿透服务会终止 TLS 并转发请求，节点运营者可能看到传输内容。」「本插件不提供节点之上的端到端加密，项目方也不托管任何公共节点。」「请仅使用自己部署或明确信任的公网节点。」

**`xgone/dsh-remote`**（<https://raw.githubusercontent.com/xgone/dsh-remote/HEAD/README.md>）
- 登录 / MFA / 角色 / 文件预览：正文 — 「在 `dsh web` 前增加登录门禁、MFA/TOTP、角色权限和远程文件预览」；`## 功能概览` — 「密码使用 scrypt 加密存储，登录失败限速，首个管理员仅限本机创建。」「默认管理员专用，**可选**启用 `admin` / `user` / `guest` 三级角色。」（RBAC 默认关，配置项 `adminOnly` 默认 `true`。）
- 它本身不提供通道：正文 — 「插件默认只监听本机回环地址；公网访问仍需 HTTPS 反向代理或安全隧道。」；`## 功能概览` — 「远程访问：适配 nginx、SSH 隧道、Tailscale、Frp、Cloudflare Tunnel 等方式」；`## 远程访问` — 「`ssh -R` 隧道、Tailscale、Frp 和 Cloudflare Tunnel 同样适用。」
- 平板侧零安装：`## 安装为应用（PWA）` — Chrome/Edge 菜单「安装应用」、iOS Safari「添加到主屏幕」；但「**用前须知：用 HTTPS 访问。**」——`http://` 的局域网地址装不上。

### 8.3 必须说清的三句

1. **外网也零配置的只有两家**：`ds-harness-remote`（装完登录、选一个在线 Host 即可）与 `agentdeck`（装完扫配对码即可）——两家都是靠**自己的服务端**换来的，但代价不同：前者是**账号（知乎/GitHub/Google）+ 中继 + 全球 TURN**；后者是**厂商 AgentDeck 的中继**（README 未写要账号，且称支持自建中继）。**这正是我们至今拒绝的那笔交易**：把「能不能连上」交给别人的服务器（`agentdeck` 还要把「你是谁」交给厂商的配对登记）。
2. **另外两家没有接这笔交易；它们不是「配置更多」，而是「范围不同」**：`dsh-carry` 在**同一 Wi-Fi 内就是装完扫码即用**（首次配对要求手机与电脑同一 Wi-Fi；README 另称「公网访问且同处局域网时自动建立 WebRTC 直连」），只有**外网**才要用户自备通道（Cloudflare Tunnel / Tailscale / VPS+Caddy / SakuraFrp），而且它把代价逐字写在 README 里：「公网中继节点或内网穿透服务会终止 TLS 并转发请求，节点运营者可能看到传输内容」「本插件不提供节点之上的端到端加密，项目方也不托管任何公共节点」。`dsh-remote` 更彻底：它只做**登录门禁**，通道完全由用户自备（nginx / `ssh -R` / Tailscale / frp / Cloudflare Tunnel），README 第一段就写明「公网访问仍需 HTTPS 反向代理或安全隧道」。
3. **所以真正的分界有两层**：**第一层是范围**——「同一个 Wi-Fi 内零配置」这件事，我们（`lan`）与 `dsh-carry` 都做到了，且都不需要任何第三方；**第二层是信任锚**——一旦离开家里，要么厂商当中继（前两家：`ds-harness-remote` 的代价是账号 + 别人的服务器；`agentdeck` 是厂商中继 + 配对登记，README 未写要账号），要么我们自建中继（§5 已论证等于接手一项长期服务），要么用户自己搭（现状）。**没有人能在不引入第三方中继/服务的条件下做到外网零配置。**

### 8.4 用户代价并排（他们）

| | `ds-harness-remote` | `agentdeck` | `dsh-carry` | `dsh-remote` |
| --- | --- | --- | --- | --- |
| 同一 Wi-Fi 内零配置 | 是（但仍要账号 + 选 Host；README 的路径顺序是 `LAN -> P2P -> …`） | 未说明（README 只主张 zero tunnel/VPN setup；手机 ↔ 本机 `agentdeckd` 具体走哪种路径 README 未写——**推断**会经中继） | **是**（首次配对要求同一 Wi-Fi；README：「公网访问且同处局域网时自动建立 WebRTC 直连」） | **否**（`dsh web` 只绑回环；README 只对「**公网访问**」明说要反代/隧道，同一 Wi-Fi 是否也需要属**推断**） |
| 外网零配置 | **是**（账号 + 项目自建服务端） | **是**（AgentDeck 中继） | 否（自备 Cloudflare Tunnel / Tailscale / VPS / SakuraFrp） | 否（自备 nginx / `ssh -R` / Tailscale / frp / Cloudflare Tunnel） |
| 要账号 | **要**（知乎 / GitHub / Google） | README 未写要账号（中继默认为 AgentDeck 的服务——推断） | **不要**（项目方不托管节点） | **不要**（本机自建账号，仅本机可创建首个管理员） |
| 要额外手机 App | **要**（Android APK / HarmonyOS 原生 / iOS TestFlight） | **要**（App Store / Google Play / APK） | 不要（浏览器） | 不要（浏览器 / PWA） |
| 要侧载 | Android 装 APK；HarmonyOS 从 Releases 取原生包（**推断**：官方市场之外分发 ⇒ 侧载） | Android 可装 APK（Google Play 之外）；iOS 国区 App Store 没有 | 不要 | 不要 |
| 大陆可达性（README 说了什么） | **未声明**。已知：默认服务器是一个 `.cn` 域名（托管地未写明）；安装包在 GitHub Releases；TURN 节点「worldwide」 | **部分明确**：iOS 版「not available on the Mainland China App Store」 | **部分明确**：给了「SakuraFrp｜国内无 VPS 方案」这条境内通道 | **未声明** |
| 信任锚在谁手里 | 项目方（账号 + 中继 + TURN；自建只到最小服务端） | 厂商 AgentDeck（可自建中继） | **用户自己的隧道** + 你自己信的节点 | **用户自己的反代/隧道** + 本机账号库 |
| 出问题找谁 | 项目方 | 厂商 | 你的隧道提供商 | 你自己的部署 |

### 8.5 用户代价并排（我们）

| | `lan` | `ipv6` | `tailscale` | 自建 frp / VPS |
| --- | --- | --- | --- | --- |
| 现在能不能用 | **`ready`**（`accessMode.ts:111`） | `needs-setup`（`:169`） | `needs-setup`（`:137`） | **已被用户明确排除**（`docs/REMOTE-ACCESS-OPTIONS.md:22`） |
| 同一 Wi-Fi 内零配置 | **是** | 否（要公网 v6 + 放行入站） | 否（要装并登录） | 否（要买服务器 + 配 frps） |
| 外网零配置 | **否**（不通外网） | 否（配置门槛如上） | 否（配置门槛如上） | 否（配置门槛如上） |
| 要账号 | 不要 | 不要 | **要**（Tailscale，或自建 Headscale） | 不要 |
| 要额外手机 App | 不要 | 不要 | **要**：平板侧 HarmoTail，**侧载 HAP**（`accessMode.ts:139-143`） | 不要 |
| 要侧载 | 不要 | 不要 | **要** | 不要 |
| 要改路由器 | 不要 | **要**（光猫/路由器放行入站，`:171-175`） | 不要 | 视部署 |
| 大陆可达性 | 不适用（同一 Wi-Fi） | 取决于运营商是否给公网 v6 | 控制面在境外（Tailscale）；本项目未实测平板侧连通性 | 取决于你买的 VPS（境内需备案） |
| 信任锚在谁手里 | **你自己**（指纹 TOFU，`pairingTls.ts:2-11`） | 你自己 | 你自己 + Tailscale 控制面（数据面打洞成功则直连，失败退回 DERP，`TAILCAT-HARMONYOS-SPIKE.md:34`） | **你**（你就是中继运营者） |
| 出问题找谁 | 你家路由器 / 防火墙 | 运营商 + 路由器 | Tailscale + 侧载客户端 | 你自己 |

补充一条容易漏的事实：我们**已经登记**过一条第三方中继——`cloudflare`（`accessMode.ts:201` `needs-setup`，`:222` 写明「quick tunnel 每次重启域名都会变」，`:324` 默认仍是 `lan`，所以它非默认）。它说明「第三方中继」本身不是禁区；**禁区是把它做成默认、并让它成为身份来源**。

### 8.6 两条路各自的建设成本（估算，均未立项）

| 工作项 | A：做成「厂商中转型零配置」（`ds-harness-remote` 那一类） | B：维持「用户自备通道」（现状） |
| --- | --- | --- |
| 服务端 | 控制面 + 中继（WebSocket/密文中继）+ TURN（coturn）三件套，还要谈在线率 | 无 |
| 账号与设备身份 | OAuth（知乎/GitHub/Google 或自建）+ 设备密钥 pinning + 吊销 | 无账号；指纹 TOFU 已有（`pairingTls.ts:2-11`） |
| 端到端加密 | **必须有**，否则中继可读 | 已是端到端 HTTPS + 指纹 TOFU |
| 客户端 | Web + Android + HarmonyOS + iOS（TestFlight 需 Apple 开发者账号）+ TUI | 现有 HAP + WebView 一套 |
| 平板侧 | 我们的原生客户端（或复用现有 App） | 浏览器 / WebView，零安装 |
| 长期成本 | 带宽、在线率、续证、滥用处置、隐私政策、（境内托管则）备案 | 用户自担；我们零 |
| 信任锚 | 我们的服务器（或厂商的） | 用户自己的网络 |
| 交付量级 | 「数月 + 一项长期服务」 | 已在；剩余工作只是文档与自检 |
| 校准点 | 只把 tailcat 的**前台 PoC** 在平板侧跑通（一个平台、一台设备）就要 **5–10 人日**（`TAILCAT-HARMONYOS-SPIKE.md:49`；常驻另计、端到端未验证），而它只是 A 里「让一台设备进网」的最小件 | — |

A 还有第二种实现：**不自建，直接采用现成插件**（`ds-harness-remote` 之类）。代价是：信任锚变成对方、要账号、平板侧还要装它的原生客户端（推断：侧载），而且它的客户端功能与我们平板 App（分段、隐藏、导出、远程控制页）重叠——**要么弃用我们的 App，要么长期维护两套**。这不是「切换通道」，是「换产品」。

### 8.7 本节不推荐切换

一句话：本节只把两条路的代价放在同一张纸上，**不主张换路线**。要不要换，取决于 §6 的问题 1 / 3 / 5 的答案。

### 8.8 看完本节之后：对 §6 裁定项的补充口径

1. 外网访问是否接受「第三方中继」这一档（`ds-harness-remote` / `agentdeck` 那一类）？——**补充 §6 问题 5**。若接受：是**采用现成插件**，还是**我们自建**（= 接受 §8.6 那张 A 表）？
2. 若只在「自备通道」里选：`tailscale` 的平板侧客户端（侧载 HarmoTail）是否写成**一等公民步骤**，还是继续只做 `lan` + `ipv6`？——**补充 §6 问题 2**。
3. `cloudflare` 这条已登记、非默认的第三方中继，是保留 / 提升 / 删除？——**本节新增，§6 未列**。
4. 「自建 frp」是否从「明确排除」改为「保留为高级选项」？若改，要先说清长期运维归谁。——**补充 §6 问题 4**。
