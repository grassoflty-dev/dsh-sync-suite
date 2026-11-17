# E. 零自建方案盘点与判定矩阵

> 目标：在「不自建 VPS / 不运维 relay / 不绑 0.0.0.0」的前提下，让 HarmonyOS NEXT 平板上的 ArkUI-X App（内部 Web 组件打开 `http(s)://<地址>/?token=...`）能访问家里 Windows PC 上的 DSH Web GUI。
>
> 调研方式：只读。官方文档抓取时间 2026-11-17；本机侦察见 §5。**未取到的内容一律标注「未取到」，不做推断式补全。**
>
> 一个重要前提（会影响结论怎么用）：`docs/REMOTE-DSH.md` 的 A1 结论是「DSH 只听回环 + 插件走**出站**桥，不给手机开入站路由」。若最终采用出站桥形态，则**本文件里所有隧道方案都不需要**（出站桥自己连出去，平板不需要直连 PC）。本文件的价值在于：M1「局域网/远程直连 GUI」这条路线要落地时必须挑一种「零自建」通道，以及 App 的「访问方式」下拉框需要哪些选项与其校验规则。

---

## 0. 结论（推荐 top3 + 明确不可行项）

### 推荐 top3

| 排名 | 方案 | 为什么是它 | 代价 |
|---|---|---|---|
| 1 | **Cloudflare Tunnel — Quick Tunnel**（`cloudflared tunnel --url http://127.0.0.1:37510`） | 唯一「**零账号 + 零域名 + 零付费 + 立刻可用 HTTPS 公网地址**」的方案；PC 端只装一个 exe；平板端 WebView 直接开 `https://xxx.trycloudflare.com/?token=...`，无需任何客户端 | 域名每次重启都变、无 SLA、单隧道 200 并发上限、官方明确**不支持 SSE**；WS 官方未单列需实测 |
| 2 | **Cloudflare Tunnel — 命名隧道**（`cloudflared tunnel run` + 自有域名托管在 CF） | 同一条产品线的「稳定版」：域名固定、可长期开机自启、免费计划可用、仍是纯出站（不回退到绑 0.0.0.0） | **必须有一个托管到 Cloudflare 的域名**（不是必须买贵的：普通 .top/.xyz 十元级/年；免费二级域名路径见 §2.1 备注），并要注册一个免费 CF 账号 |
| 3 | **Tailscale Funnel**（`tailscale funnel 37510`） | 唯一「免费给你一个**固定** HTTPS 域名（`<机器名>.<tailnet>.ts.net`）且不用买域名」的方案；免费 Personal 计划不限设备数 | 要注册 Tailscale 账号、Win 上要用**管理员**控制台开、必须在 tailnet 里开 MagicDNS + HTTPS 证书 + 改 policy 文件；Funnel 仍是 beta，且带宽受「不可配置的限制」；大陆网络到达性风险最高（见 §2.2） |

### 明确不可行（对「平板零门槛 + 必须 WS + 不自建」三条件至少违反一条）

- **ZeroTier**：平板端需要装 ZeroTier 客户端（官方下载页只有 Windows/Apple/Android/Linux/Docker/FreeBSD/OpenWRT/NAS，**没有 HarmonyOS**），HarmonyOS NEXT 不能装 Android APK → 平板侧不可用。
- **Tailscale Serve（仅 tailnet 内）**：同上，平板必须装 Tailscale 客户端。
- **bore.pub**：公开实例只做**裸 TCP**、给的是 `bore.pub:<随机端口>`、默认不加密 → 没有 HTTPS，WebView 里 `http://` + 随机端口 + token 明文出现在 query，直接出局。
- **花生壳（贝锐）免费「体验版」**：免费档实测条款是 1 Mbps/映射、**1 GB/月**流量、并发 5、体验线路 → 跑一个会持续拉 WS 的 GUI 基本一天就撞流量墙；且需要实名认证。
- **Cloudflare WARP**：它只是把本机**出站**流量送进 Cloudflare 网络，不提供任何入站入口 → 与「让平板访问家里 PC」无关。
- **ngrok 免费**：技术上能通，但 1 GB/月 + 20,000 HTTP 请求/月 + 免费档对**所有 HTML 浏览器流量**插入 interstitial 警告页（需自定义 UA 或注入 `ngrok-skip-browser-warning` 头才绕过）——WebView 能否稳定绕过属未验证风险，因此**不列入 top3**，仅作备选（B-）。

---

## 1. 判定矩阵表

> 判定口径：**A = 可作产品默认项**；**B = 可用但有限制/需额外动作**；**C = 仅临时验证用**；**不可行 = 三条件至少一条不满足**。
> 「需要的东西」列里 ✗ 表示不需要。

| # | 方案 | 需要的东西（账号 / 域名 / PC 客户端 / 费用） | WS 支持 | 平板可用性（HarmonyOS NEXT，零客户端？） | 免费可用性 | 推荐度 | 一句话理由 |
|---|---|---|---|---|---|---|---|
| 1 | CF Tunnel · Quick Tunnel | 账号✗ 域名✗ 客户端✔(cloudflared.exe) 费用✗ | **未取到官方条款**（HTTP 应用走 CF 边缘，见 §2.1 判定）；官方明确不支持 SSE | ✅ 浏览器/WebView 直接开 `https://*.trycloudflare.com` | 免费无限时，但域名每次变、200 in-flight、无 SLA | **A-**（首选验证/日常） | 零门槛到极致，代价是地址不稳定 |
| 2 | CF Tunnel · 命名隧道 | 账号✔(免费) 域名✔(**必须托管在 CF**) 客户端✔ 费用≈域名年费 | 同上（WS 属 HTTP 升级，官方文档未单列限制） | ✅ | 免费计划可用；单账号 1000 条隧道 | **A**（长期稳定首选） | 唯一「固定域名 + 免费 + 不回退绑 0.0.0.0」的组合 |
| 3 | Tailscale Funnel | 账号✔(免费 Personal) 域名✗（自动给 `*.ts.net`） 客户端✔ 费用✗ | 支持（Funnel 是 TCP 代理，TLS 强制） | ✅ 直接开 `https://机器名.tailnet.ts.net` | 免费 Personal：不限设备、≤6 用户 | **B+** | 免费固定域名很香，但配置项多、beta、大陆可达性风险 |
| 4 | Tailscale Serve（仅 tailnet） | 账号✔ 域名✗ 客户端✔ | 支持 | ❌ 平板必须装 Tailscale 客户端（HarmonyOS 无客户端） | 免费 | **不可行** | 平板侧拿不到 100.x 网络 |
| 5 | ZeroTier | 账号✔ 域名✗ 客户端✔（PC + 平板都要） | 支持（二层网） | ❌ 无 HarmonyOS 客户端 | 免费：10 设备 / 1 网络 | **不可行** | 同上，客户端断链 |
| 6 | ngrok 免费 | 账号✔ 域名✗（自动给 1 个 `*.ngrok-free.app`） 客户端✔ 费用✗ | 支持（HTTPS 隧道；WS 未取到专门条款） | ⚠️ 可开，但 HTML 浏览器流量会先撞 interstitial 警告页 | 1 GB/月、2 万请求/月、3 端点、1 固定 dev 域名 | **B-** | 额度太小 + 警告页是 WebView 的定时炸弹 |
| 7 | localhost.run | 账号✗（免费域不需要） 域名✗ 客户端✗（用系统自带 ssh） 费用✗ | **未取到**（HTTP 隧道，理论上支持 upgrade；非 HTTP 协议仅限自定义域名） | ✅ 直接开 `https://<随机>.lhr.life` 类地址 | 免费随机子域，每次会话变；具体时长/带宽限制本次未取到 | **C** | 连装都不用装，适合 5 分钟冒烟测试 |
| 8 | pinggy（free.pinggy.io） | 账号✗ 域名✗ 客户端✗（ssh） 费用✗ | **未取到** | ✅ 直接开 `https://*.run.pinggy-free.link` | 免费随机子域；官方 pricing 页为 JS 渲染，本次未取到具体限额 | **C** | 同 localhost.run，URL 里带来源 IP 编码、不适合长期 |
| 9 | bore.pub | 账号✗ 域名✗ 客户端✔(bore.exe) 费用✗ | TCP 可承载，但**无 TLS** | ❌ 只能 `http://bore.pub:<随机端口>` | 公开实例免费无 SLA | **不可行** | 无 HTTPS + 随机端口 + token 明文 |
| 10 | 花生壳（贝锐） | 账号✔ **实名✔** 域名✗（厂家子域） 客户端✔ | 支持（HTTP/HTTPS 映射） | ✅（浏览器访问厂家域名） | 体验版：1 Mbps、1 GB/月、2 映射、并发 5 | **不可行**（体验版）/ B（付费 ¥1299/年起） | 免费额度撑不住长连接 GUI |
| 11 | 蒲公英（贝锐，异地组网） | 账号✔ 实名✔ 客户端✔（PC + 平板） | 支持（组网） | ⚠️ 平板需装蒲公英客户端；HarmonyOS 原生客户端**未取到** | 免费版限设备/带宽（未取到具体条款） | **C/不可行** | 又是「平板要装客户端」的死结 |
| 12 | Cloudflare WARP | — | — | — | — | **不适用** | 只做出站，不给入站入口 |

---

## 2. 逐方案细节

### 2.1 Cloudflare Tunnel（quick / 命名）

**文档**
- Quick Tunnels：https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/
- 命名隧道（Get started，含前置条件）：https://developers.cloudflare.com/tunnel/get-started/
- 支持的协议/路由：https://developers.cloudflare.com/tunnel/concepts/routing/
- 下载：https://developers.cloudflare.com/tunnel/downloads/

**机制**：`cloudflared` 从 PC **出站**连到 Cloudflare 边缘（默认 7844 出站，无需端口映射、无需公网 IP、无需 DDNS），边缘把你的域名/临时域名反代回本机 `http://127.0.0.1:<port>`。因此它天然满足「插件不许绑 0.0.0.0」——DSH 继续只听回环，隧道客户端在**本机**连回环即可。

**Quick Tunnel 事实（官方原文归纳）**
- 无需 Cloudflare 账号、无需域名，命令 `cloudflared tunnel --url http://localhost:8080`，进程停 → URL 立即失效。
- **每次创建 tunnel 主机名都会变**（原文：The hostname changes each time you create a Quick Tunnel）。
- 每条 quick tunnel **最多 200 个 in-flight 请求**，超出返回 `429`。
- **不支持 SSE**（官方 Limitations 明确列出）。
- 无 uptime 保证，定位是「测试与开发」。
- 支持 `--allowed-mail` 邮箱一次性 PIN 保护，但官方注明**需要交互式浏览器会话**，非交互客户端不行。

**命名隧道事实**
- 前置条件（原文）：一个 Cloudflare 账号 **+ 一个已在 Cloudflare 上的域名**（"required to publish applications"）。
- 发布方式：hostname → service（`http://localhost:80` 这类），DNS 用 CNAME 指向 `<UUID>.cfargotunnel.com`。
- 账号级隧道上限 1000 条；单条远端管理隧道的 published application 上限约 5000–10000 条（对 1 个 App 完全够）。
- Windows 安装：管理员 CMD 里 `cloudflared.exe service install <TUNNEL_TOKEN>`。

**WS 判定（关键）**
- 官方 routing 页把 `HTTP` / `HTTPS` 列为可直接发布的 service 类型；**只有 TCP/SSH/RDP/SMB 这些「非 HTTP 服务」才要求终端用户也装 cloudflared**。DSH 的 `/api/remote.mux` 是跑在 443 上的 **HTTP Upgrade（WebSocket）**，属于 HTTP 应用，不需要客户端侧 cloudflared。
- 该页面的 metadata keywords 含 `WebSockets`，但**正文没有一句「支持 WebSocket」的明文条款**；quick tunnel 页面的 Limitations 只列了 SSE，**未列** WebSocket。→ 结论：**「应当支持，但官方无明文承诺，必须实测」**（实测方法见 §4）。

**免费额度与限制**：Tunnel 本身在免费计划可用（免费计划限制是 CDN/WAF 侧，对 1 个 GUI 无感）；quick tunnel 的 200 并发 + 无 SLA 是硬限制。另注意 routing 页提到 Free 计划对**视频/大文件**有服务条款限制——对本项目（文本流）无影响。

**国内可用性**：官方没有任何「中国大陆可用性」说明（**未取到**）。结构上 `trycloudflare.com` / 自有域名都解析到 Cloudflare 边缘节点，从大陆访问通常要绕行境外/香港节点，延迟与丢包随运营商与时段波动（**这是经验判断，不是文档结论**）。→ 必须实测（§4）。

**若「必须有域名」怎么免费/极便宜地拿到**
- Cloudflare 要求的是「域名的 NS 托管给 CF」，所以**只给 CNAME/A 记录的免费二级域名（DuckDNS、afraid.org 免费档）不足以用命名隧道**。
- 可行路径 A（推荐、最省事）：买一个十元级/年域名（.top/.xyz 常见首年 9–19 元），NS 改成 CF 分配的两个 NS。
- 可行路径 B（零元但要等）：`eu.org` 一类**允许自定义 NS** 的免费二级域名服务，把 NS 指到 CF。**本次未取到其当前审核政策/时效**，需人工确认。
- 结论：**命名隧道 = 「一个域名」是硬门槛，但不必买服务器、不必备案（CF 不要求备案，域名只是 DNS 托管）**。

### 2.2 Tailscale Funnel / Serve

**文档**
- Funnel：https://tailscale.com/docs/features/tailscale-funnel
- Serve：https://tailscale.com/docs/features/tailscale-serve
- 价格：https://tailscale.com/pricing

**机制**：Funnel 用 Tailscale 的 **Funnel relay（中继）**＋TCP 代理，把公网 HTTPS 请求转进 tailnet 里某台机器的本地端口；Serve 只对 tailnet 内设备开放。

**Funnel 硬条件（官方原文）**
- 仍在 **beta**；需要 Tailscale **v1.38.3+**；**所有套餐都可用**。
- 必须：tailnet 开 **MagicDNS**、开 **HTTPS 并签发有效证书**、policy 文件里有 `funnel` node attribute（用 CLI 开启时 Tailscale 会自动补上）。
- 只能用 **`.ts.net` 域名**（即 `<机器名>.<tailnet>.ts.net`），不能自定义域名。
- 只能监听 **443 / 8443 / 10000**；只走 **TLS**。
- 流量受**不可配置的带宽限制**。
- 需要能跑 Tailscale CLI 的平台；**Windows 上必须在管理员控制台执行**。
- 与 Serve 冲突：同一个端口不能既 Serve 又 Funnel。

**账号/域名/费用**：要一个 Tailscale 账号（免费 Personal：不限设备数、最多 6 用户、Access 大部分功能）。域名不用买——`*.ts.net` 是免费给的，这是它相对 CF 命名隧道的唯一优势。

**WS**：Funnel 是加密 TCP 代理，TLS 上的 WebSocket Upgrade 属于其承载的正常内容 → 判定**支持**（官方页面未单列 WS，按「TCP 代理不解析应用层」推论）。

**平板可用性**：Funnel 是公开 HTTPS，平板 WebView 直接开 `https://机器名.tailnet.ts.net/?token=...` 即可，**不需要平板装 Tailscale**。但 **Serve 不行**（只对 tailnet 内开放，平板得装客户端）。

**国内可用性**：**未取到官方说明**。已知结构风险：登录/控制面是 `login.tailscale.com`，数据面在无法直连时走 DERP 中继；大陆网络环境对这两者都可能不通或极慢（**经验判断，非文档结论**）。→ 这是 Funnel 排第 3 而非第 1 的主要原因，必须实测。

### 2.3 ZeroTier

**文档**：价格 https://www.zerotier.com/pricing/ ；下载/平台 https://www.zerotier.com/download/

**机制**：本质是 P2P 二层虚拟网络，有厂家 planet 根服务器做发现，但**不用你自己运维**——从「不租服务器」角度看算零自建。

**免费额度（官方 pricing 页原文）**：Personal 免费 = **10 devices、1 network、1 network admin**、非商业用途。

**致命点**：官方下载页平台列表是 Windows / Apple / **Android** / Linux / Docker / FreeBSD / OpenWRT / NAS，**没有 HarmonyOS**。HarmonyOS NEXT 是纯血鸿蒙，不能直接装 Android APK，因此平板进不了这个虚拟网络 → 即便 PC 端配好，平板 WebView 也拿不到 `10.x` 地址。**判不可行**（除非用户接受在平板上跑非官方兼容层，不在本项目范围）。

### 2.4 ngrok / localhost.run / bore.pub / pinggy

**ngrok**（https://ngrok.com/docs/pricing-limits/free-plan-limits）
- 免费额度（原文表格）：出站流量 **1 GB/月**、HTTP 请求 **20,000/月**、TCP 连接 5,000/月、**在线端点 ≤3**、并发 agent 3、用户 1、**开发域名 1 个**。
- 域名：免费自动分配 1 个 `your-assigned-name.ngrok-free.app`，**重启不变**（这点比 quick tunnel 好）。
- **interstitial 警告页**：免费档对「所有 HTML 浏览器流量」插一页「本站由 ngrok 提供」，点 Visit 后 cookie 压制 7 天；官方给了两种绕过方式——带 `ngrok-skip-browser-warning` 头，或用非标准 User-Agent。**API/程序化访问不受影响**。→ WebView 里首屏会被拦一次，且 WS 之外的 HTML 请求也会被拦，属产品级体验缺陷。
- WS：官方未在此页列条款（**未取到**）；HTTPS 隧道通常支持 WS。
- 国内：`*.ngrok-free.app` 从大陆访问不稳定（经验判断，未取到文档）。

**localhost.run**（https://localhost.run/docs/ ）
- 机制：**无需安装任何客户端**，用系统自带 OpenSSH：`ssh -R 80:localhost:8080 localhost.run`；免费域名**不需要账号**（原文：no account is needed for free domains）。
- 它自己解密 TLS 后以明文 HTTP 打到你的本地端口；会加 `X-Forwarded-*`。
- 明确限制（原文）：**只有自定义域名才能承载非 HTTP 协议**；免费域是随机子域。
- 免费档的时长/带宽/并发具体条款在 `/docs/forever-free`，**本次多次抓取失败（fetch failed / 导航超时）→ 未取到**。
- WS：**未取到**明文条款（HTTP 隧道理应支持 Upgrade）。

**pinggy**（https://pinggy.io/docs/）
- 机制：`ssh -p 443 -R0:localhost:8000 free.pinggy.io`（不用装客户端，免费不登录）。
- 免费给形如 `https://uljtt-30-47-152-61.run.pinggy-free.link` 的地址（**子域里编码了你的出口 IP**），官方示例同时给 http 和 https。
- 免费档限额：pricing 页与 FAQ 页均为 JS 渲染，**本次取到空文本 → 未取到**（业界惯例是免费会话限时 60 分钟一类，**未经证实，不写死**）。
- WS：**未取到**。

**bore.pub**（https://github.com/ekzhang/bore）
- 原文：`bore local 8000 --to bore.pub` → 暴露在 `bore.pub:<PORT>`，**端口随机**；「a modern, simple **TCP** tunnel」「no more, and no less」。
- 无 TLS、默认不加密（secret 只用于握手校验）→ **无 HTTPS，判不可行**。

### 2.5 花生壳 / 贝锐蒲公英 / 向日葵端口映射

**文档**：贝锐价格页 https://hsk.oray.com/price/ ；产品族入口 https://hsk.oray.com/

**机制（回答「算不算零自建」）**：算。它们是**厂家服务器中转 + 厂家子域**（`*.vicp.net` 一类），你不需要服务器、不需要公网 IP、不需要开放路由器端口；PC 端装客户端即可。代价是把流量交给第三方、且**国内实名制**（贝锐系映射/域名服务普遍要求实名认证，**具体到免费档是否强制实名本次未取到官方条款，需人工确认**）。

**免费档硬数据（价格页「体验版」列，原文）**：映射条数 **2**；带宽 **1 Mbps/映射**；账号带宽上限 8 Mbps；**花生壳流量：限 1 G/月**；并发连接数 **5**；线路「体验线路」；等待重连 60 秒。付费档从 **¥1299/年**（企业标准版）起。
→ 一个会持续跑 WS + 拉历史的 GUI，1 GB/月 与并发 5 都撑不住；**免费档判不可行**。

**蒲公英**：异地组网（虚拟局域网）路线，形态类似 ZeroTier——**平板侧要装客户端**；HarmonyOS NEXT 是否有原生客户端**未取到**。免费版限设备数与带宽（具体条款未取到）→ 按「平板要装客户端」判 C/不可行。

**向日葵**：远程桌面/远控，不是「端口映射给 WebView 用」的工具（它的「内网穿透」面向远控），**不适用**本场景。注：本机 `C:\Program Files\Oray` 下确实有 `SunLogin`、`AweSun` 两个目录（见 §5），说明装过向日葵系软件，但那不等于可用的 Web 隧道。

### 2.6 Cloudflare WARP 与其它补充

- **Cloudflare WARP**：出站 VPN（把本机流量送进 CF），**不提供入站发布能力**，无法让平板访问 PC。与 cloudflared 组合也不解决入站——cloudflared 才是入站那半边。**不适用**。
- **Cloudflare Tunnel + Access（Zero Trust 免费档）**：能给 `app.example.com` 加一层邮箱/OTP 登录。但 Access 的登录页是**交互式浏览器流程**，对「App 里带 `?token=` 直开」不友好；且仍需自有域名。列为「可选加固」，不进 top3。
- **Netbird / Twingate 一类**：同样是「平板要装客户端」的 mesh VPN 家族，HarmonyOS NEXT 客户端**未取到**，与 ZeroTier/Tailscale Serve 同类死结，**不再展开**。
- **cpolar / natapp / 樱花 frp 一类国内中转**：形态与花生壳相同（第三方中转 + 实名 + 免费档限带宽/限时），**未取到本次可核实的官方条款**，若需要国内低延迟中转，建议按 §6 的人工确认清单逐条核。

---

## 3. 用户操作步骤（可行方案，面向非网络专业用户，每方案 ≤6 步）

> 共同前提：DSH Web GUI 仍只听 `127.0.0.1:37510`（本机实测端口见 `docs/REMOTE-DSH.md` 的 A1 记录）；**不要**为了这些方案去改绑定地址。

### 3.1 方案 A1：Cloudflare Quick Tunnel（推荐用来「今天就能用」）

1. 打开 https://developers.cloudflare.com/tunnel/downloads/ ，下载 Windows 版 `cloudflared.exe`，放到 `C:\dsh-tunnel\`（不要放桌面，免得被清理）。
2. 在 `C:\dsh-tunnel\` 空白处按住 Shift 右键 →「在终端中打开」。
3. 执行：`.\cloudflared.exe tunnel --url http://127.0.0.1:37510`
4. 等 3–10 秒，窗口里会出现一行 `https://<随机词>-<随机词>.trycloudflare.com` —— **这就是公网地址**，抄下来。
5. 平板上打开 App，在「访问方式」选「Cloudflare 临时隧道」，把地址粘进去（App 侧自动补 `/?token=...`）。
6. 关掉那个黑窗口 = 关掉公网入口（用完即关，最安全）。

### 3.2 方案 A2：Cloudflare 命名隧道（推荐用来「长期挂着」）

1. 准备一个域名，把它的 **NS 改成 Cloudflare 给的两个地址**（在 Cloudflare 注册/添加站点后按提示改），等生效（几分钟到 24 小时）。
2. 注册/登录 Cloudflare → 左侧 **Networking → Tunnels → Create Tunnel**，起名 `dsh-home`。
3. 在 **Routes → Add route → Published application**：Hostname 填 `dsh.你的域名`，Service 填 `http://localhost:37510`。
4. 页面会给一条安装命令 `cloudflared.exe service install <TUNNEL_TOKEN>`；下载 `cloudflared.exe` 后**以管理员身份**打开 CMD 执行它（一条命令就把它变成开机自启的 Windows 服务）。
5. 浏览器（任意网络，先用手机 4G 试）打开 `https://dsh.你的域名/` ，能看到 DSH 界面即通。
6. 平板 App 里「访问方式」选「Cloudflare 命名隧道」，填 `dsh.你的域名`。

### 3.3 方案 B：Tailscale Funnel（想要「免费固定域名」时）

1. 注册 Tailscale 账号（免费 Personal），在 PC 上安装 Tailscale 并登录；在管理后台把 **MagicDNS** 和 **HTTPS Certificates** 都打开。
2. 打开 Tailscale 管理后台的 **Access controls（policy 文件）**，确认/加入 `funnel` node attribute（照官方 Funnel 文档给的示例片段粘贴）。
3. **以管理员身份**打开 PowerShell，执行 `tailscale funnel 37510`（首次会提示启用 Funnel，按提示 y 确认）。
4. 命令会打印 `https://<机器名>.<tailnet>.ts.net/` —— 这就是公网地址（固定不变）。
5. 用手机 4G 打开该地址确认可达（**大陆网络这一步最容易失败，失败就换 A1/A2**）。
6. 平板 App 里「访问方式」选「Tailscale Funnel」，填 `<机器名>.<tailnet>.ts.net`。

### 3.4 方案 C：localhost.run（连装都不装，5 分钟冒烟测试）

1. Win10/11 自带 OpenSSH 客户端；如无，设置 → 应用 → 可选功能 → 添加「OpenSSH 客户端」。
2. 打开 PowerShell，执行：`ssh -R 80:localhost:37510 nokey@localhost.run`
3. 首次会问 `yes/no`，输 `yes`；终端会打印一个 `https://<随机>.lhr.life` 地址。
4. 手机 4G 打开该地址验证（**顺带验证 WS 是否能通**，见 §4 的自检）。
5. 平板 App 里「访问方式」选「其他 HTTPS 隧道」，粘地址。
6. 关闭窗口即断；地址每次变，**不要**把它写进长期配置。

---

## 4. 插件侧需校验字段与连接自检建议

### 4.1 「访问方式」选项与字段（建议 schema）

| 字段 | 类型 | 说明 / 校验规则 |
|---|---|---|
| `accessMode` | enum | `loopback` \| `lan` \| `cf-quick` \| `cf-named` \| `tailscale-funnel` \| `ngrok` \| `custom-https` \| `other` |
| `publicHost` | string(host) | 只存**主机名**，不存 scheme/token。按 mode 做后缀白名单：`cf-quick` → 必须匹配 `^[a-z0-9-]+\.trycloudflare\.com$`；`cf-named` → 用户自有域，**必须**出现在用户显式录入的允许域列表里；`tailscale-funnel` → 必须匹配 `^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$`；`ngrok` → `^[a-z0-9-]+\.ngrok-free\.app$` |
| `publicPort` | int? | 仅 `lan`/`custom-https` 需要；默认 443，`cf-*`/`tailscale-funnel`/`ngrok` **强制 443** |
| `requireTls` | bool | 除 `loopback`/`lan` 外**强制 true**；`http://` + 非回环组合直接拒绝保存（记住 bore.pub 那种 `http://bore.pub:随机端口` 必须被挡） |
| `tokenTransport` | enum | `query` \| `header`。**建议默认 `header`**：隧道中转方（CF/Tailscale/ngrok/localhost.run）都能看到完整 URL，`?token=` 会进它们的日志与 Referer |
| `wsPath` | const | `/api/remote.mux`（本机记录：`REMOTE_STREAM_MUX_PATH`），用于自检时拼 `wss://` |
| `ephemeral` | bool | `cf-quick` / `localhost.run` / `pinggy` / `bore` → `true`：UI 上必须显著提示「地址每次重新启动会变，请重新粘贴」，且不参与「一键重连」 |
| `lastVerifiedAt` / `lastVerifyResult` | 时间戳 / enum | 每次保存前跑一次 §4.2 自检，把结果写回；失败不允许静默通过 |

### 4.2 连接自检（保存前跑，3 个探针）

1. **DNS + TLS 探针**：`GET https://<publicHost>/` → 期望 `200`，且证书链有效（不接受 `--insecure`）。
2. **WS Upgrade 探针**：`wss://<publicHost>/api/remote.mux` 带 `Upgrade: websocket`；成功判据是收到 `101 Switching Protocols`（不是 200、不是 302 登录页）。**这一步是判定「隧道是否真的支持 WS」的唯一硬证据**——quick tunnel / localhost.run / pinggy 都必须实测，不能靠文档推断。
3. **令牌探针**：带真实 token 发一个 `open` 帧，等 `item`/`error` 帧；能收到任一帧说明全链路（含鉴权）通。

命令行最小验证（PC 上直接跑，`-v` 看握手）：

```powershell
# 1) HTTPS 是否通
curl.exe -sS -o NUL -w "%{http_code}`n" "https://<publicHost>/"
# 2) WebSocket 是否 101（没有 wscat 时看 curl 的 Upgrade 结果）
curl.exe -sS -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" "https://<publicHost>/api/remote.mux"
```

**已知会踩的坑（按方案）**
- `cf-quick`：官方 200 in-flight 上限 → 并发连接数高的会话会被 `429`；官方**不支持 SSE**，若 DSH 某条流是 SSE 形态必须改走 WS。
- `ngrok`：WebView 首屏可能撞 interstitial；App 侧需要能自定义 User-Agent（例如 `DSHApp/1.0`），否则会看到「You are about to visit…」页面。
- `tailscale-funnel`：只允许 443/8443/10000，且带宽上限不可配 → 大幅传输（大段历史/附件）会很慢。
- 全部中转方案：token 若走 query，会出现在中转方访问日志里 → 建议 30 分钟轮换一次 + 短时 token。

---

## 5. 本机已装组件侦察结果（只读，2026-11-17）

命令与结果：

```text
Get-Command cloudflared, tailscale, ngrok, zerotier-cli, warp-cli, frpc, sunloginclient -ErrorAction SilentlyContinue
MISS: cloudflared
MISS: tailscale
MISS: ngrok
MISS: zerotier-cli
MISS: warp-cli
MISS: frpc
MISS: sunloginclient
```

```text
Get-ChildItem 'C:\Program Files','C:\Program Files (x86)' -Directory | ? Name -match 'cloudflare|tailscale|ngrok|zerotier|oray|贝锐|蒲公英|Sunlogin|Warp|frp'
→ C:\Program Files\Oray
   ├─ AweSun
   └─ SunLogin
```

```text
Get-Service | ? Name -match 'cloudflared|tailscale|ngrok|zerotier|sunlogin|oray|warp'
Name          Status   DisplayName
WarpJITSvc    Stopped  Warp JIT Service
```

**结论：本机没有安装任何可用的「隧道 / 组网」客户端。**
- `cloudflared`、`tailscale`、`ngrok`、`zerotier`、`frpc` **全部未安装**（不在 PATH，也没有对应 Program Files 目录、没有对应服务）。
- 唯一命中的是贝锐（Oray）家族的 **向日葵 / AweSun**（远程桌面类），**不是** Web 隧道工具，对本任务无用。
- `WarpJITSvc` 名字里虽有 "Warp"，但其可执行路径是 `C:\WINDOWS\System32\svchost.exe -k LocalServiceNetworkRestricted`，**不是 Cloudflare WARP 的服务**（CF WARP 的服务名是 `CloudflareWARP`）；且当前 Stopped。**判定与 Cloudflare WARP 无关，勿混淆。**
- 因此：**任何 top3 方案都需要用户先「装一个客户端」**（cloudflared.exe 免安装单文件 / Tailscale 安装包）。这正好落在用户可接受的代价「装个客户端 + 注册个免费账号」之内——而 top1 的 quick tunnel 连账号都不用。

---

## 6. 未验证 / 需人工确认

| # | 事项 | 现状 | 建议怎么确认 |
|---|---|---|---|
| 1 | **Quick Tunnel 是否支持 WebSocket** | 官方 Limitations 只写了「不支持 SSE」，**未写 WS**；routing 页正文也无明文条款（仅 metadata 关键词含 WebSockets） | 装 `cloudflared` 后按 §4.2 探针 2 实测 `101`；这是 top1 能否成立的关键 |
| 2 | **Funnel 上 WS 的实际可用性** | 官方说 Funnel 是 TCP 代理 + 强制 TLS，按推论应支持，**无明文条款** | 同上实测 |
| 3 | **大陆网络对 trycloudflare / *.ts.net / *.ngrok-free.app 的实际延迟与丢包** | 官方无任何大陆可用性说明（未取到）；本文的相关判断均为**经验判断** | 三地三网各测：手机 4G、家里宽带、公司网，各跑 §4.2 探针 1+2，记录 p50 延迟与失败率 |
| 4 | **localhost.run 免费档的时长/带宽/并发条款** | `/docs/forever-free` 页面多次抓取失败（fetch failed / Page.navigate 超时）→ **未取到** | 打开 https://localhost.run/docs/forever-free 人工摘录 |
| 5 | **pinggy 免费档限额** | pricing / FAQ 页为 JS 渲染，抓取返回空 → **未取到** | 打开 https://pinggy.io/#pricing 人工摘录 |
| 6 | **ngrok 免费档是否支持 WebSocket** | 免费额度表与域名字段抓到了，**WS 条款未取到** | 查 https://ngrok.com/docs 的 WebSocket 专页 |
| 7 | **花生壳免费档是否强制实名** | 价格页拿到体验版硬指标（1 Mbps / 1 GB/月 / 并发 5 / 2 条映射），**实名条款未取到** | 贝锐注册流程截图确认（国内实名是硬门槛，会影响「零门槛」判定） |
| 8 | **蒲公英 / ZeroTier / Tailscale 是否有 HarmonyOS NEXT 原生客户端** | 三者官方下载页均未见 HarmonyOS（ZeroTier 平台列表已核实；Tailscale/蒲公英未逐一核实） | 各官网搜索「HarmonyOS / 鸿蒙」；结论若为否，则「平板装客户端」路线全部封闭 |
| 9 | **免费二级域名（如 eu.org）能否把 NS 托管到 Cloudflare** | 历史可行，**当前政策未取到** | 若用户拒绝买域名，再单独验证这条路 |
| 10 | **DSH 的流是否全走 `/api/remote.mux`（有无 SSE）** | 官方 quick tunnel 明确不支持 SSE，若 DSH 有 SSE 端点则该方案会缺功能 | 读 `dsh-api-gateway` 的 stream-protocol 与 web 端实际请求（本仓库 `REMOTE-DSH.md` 已记录 mux 路径，SSE 未见） |
