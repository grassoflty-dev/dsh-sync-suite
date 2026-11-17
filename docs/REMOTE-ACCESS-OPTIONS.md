# 远程访问方式：可行性与前置条件（v0.1，2026-11-17）

> 状态：**设计 + 落地口径已定**。本文是两端（DSH 插件 `src/remote/**` 与平板 App
> `entry/src/main/ets/model/remoteAccess.ts`）共用的**唯一语义表**，字段名与枚举值以
> `packages/dsh-git-config-sync/src/remote/types.ts` 为准。
> 调研依据：`docs/RESEARCH-A-mobile-remote.md`（成熟插件源码对照）、`RESEARCH-B-uu-remote.md`、
> `RESEARCH-C-tailscale-harmony.md`、`RESEARCH-D-ipv6.md`、`RESEARCH-E-zero-infra.md`。
> 官网页面的抓取时间：2026-11-17。

## 0. 一页结论

| 场景 | 用哪种 | 一句话 |
| --- | --- | --- |
| 平板和电脑在同一个 Wi-Fi | **`lan`（局域网直连，默认）** | 插件在电脑的**具体局域网 IPv4** 上旁挂一个监听，反代回 `127.0.0.1:<DSH 端口>`，平板零安装 |
| 在外面（不想注册任何账号） | **`cloudflare` → Quick Tunnel** | PC 跑 `cloudflared`，拿一个 `https://xxx.trycloudflare.com`，平板 WebView 直接开；**域名每次重启都变** |
| 在外面（要固定地址） | **`cloudflare` → 命名隧道**，或 **Tailscale Funnel** | 前者要一个托管到 Cloudflare 的域名；后者免费给 `<机器>.<tailnet>.ts.net`，但配置项多且是 beta |
| 家里有真公网 IPv6 且愿意开防火墙 | **`ipv6`** | 本机实测有 `2409:8a20:4cad:ba20::/60`，DSH 可绑具体 v6 字面量；代价是无 TLS、地址会变 |
| 只能自己想办法 | **`manual`** | 你自己有一条能访问到电脑的地址，插件只做归一化与自检 |
| —— | **`uu`（网易 UU 远程）** | **不可用**：它是画面串流（远程桌面），不产生端口/虚拟网卡，没法让 App「打开一个网址」 |
| —— | **卓易通里的安卓 Tailscale** | **不可用**：兼容层是独立 netns，宿主原生浏览器与我们的 App 不走它的路由 |

**明确排除**：自建 VPS + frp / 自建 relay（用户已拍板「不自建服务器」）、ZeroTier / 蒲公英
（平板要装客户端，官方平台列表无 HarmonyOS）、bore.pub（裸 TCP、无 TLS、随机端口）、
Cloudflare WARP（只出境，不给入站入口）。

## 1. 判定矩阵

口径：**可用** = 平板零客户端 + 支持 WebSocket + 不用自建服务器，三条全满足；
**需准备** = 能满足但用户要先做点事（装客户端 / 开账号 / 放行防火墙）；
**不可用** = 至少一条硬条件不满足。

| 方案 | 服务器 | 账号 | 域名 | WS | 平板要装什么 | 免费可用性 | 判定 | 一句话理由 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `lan` 局域网直连 | 不需要 | 不需要 | 不需要 | ✅ | 无 | 无限 | **可用** | 同一 Wi-Fi 内网直连，最稳最快 |
| `ipv6` 公网直连 | 不需要 | 不需要 | 不需要 | ✅ | 无 | 无限（但要运营商给 v6） | **需准备** | 要公网 v6 + 光猫放行入站 + 地址稳定 |
| `cloudflare` Quick Tunnel | 不需要（用 CF 边缘） | 不需要 | 不需要 | ⚠️ 未实测 | 无 | 无限时长，域名会变 | **需准备** | 零门槛，代价是地址不稳定 |
| `cloudflare` 命名隧道 | 不需要 | CF 账号 | **必须有**（托管到 CF） | ⚠️ 未实测 | 无 | 免费计划可用 | **需准备** | 固定域名的唯一免费零自建组合 |
| Tailscale（Funnel/直连） | 不需要 | Tailscale 账号 | 自动给 `*.ts.net` | ✅ | **要装鸿蒙原生客户端**（HarmoTail，侧载 HAP） | 免费 Personal 不限设备 | **需准备** | PC 侧好用，卡在平板侧没有官方客户端 |
| `manual` 手动地址 | 视你的方案 | 视你的方案 | 视你的方案 | 视你的方案 | 视你的方案 | —— | **可用** | 只做归一化与自检，不代管监听 |
| `uu` 网易 UU 远程 | —— | —— | —— | ❌ | —— | —— | **不可用** | 远控 = 画面串流，不是隧道 |
| ZeroTier | 不需要 | ZeroTier 账号 | 不需要 | ✅ | 要装客户端（**无鸿蒙版**） | 免费 10 设备 | **不可用** | 平板装不了客户端 |
| 蒲公英 / 花生壳 | 不需要（厂家中转） | 要，且**实名** | 厂家子域 | ✅ | 蒲公英要装客户端 | 体验版 1 Mbps / 1 GB 月 | **不可用**（体验版） | 免费额度扛不住长连接 GUI |
| ngrok 免费 | 不需要 | 要 | 自动子域 | ✅ | 无 | 1 GB/月、2 万请求/月 | **不可用**（作日常） | 免费档给 HTML 流插警告页，WebView 定时炸 |
| bore.pub / localhost.run / pinggy | 不需要 | 不要 / 部分要 | 随机子域 | ⚠️ | 无 | 不限 / 未知 | **仅临时验证** | 无 TLS 或地址每次都变，不做产品默认 |

> 判定写进代码的对应关系：`RemoteModeSpec.availability` = `ready`（`lan` / `manual`）、
> `needs-setup`（`ipv6` / `cloudflare` / `tailscale`）、`unsupported`（`uu`）。
> **`unsupported` 的项在 UI 里必须是 disabled + 显示原因，不许做假开关。**

## 2. 逐方式说明

### 2.1 `lan` 局域网直连（默认）

**机制**：插件在**具体的局域网 IPv4** 上另起一个 `http.Server`（与 DSH 自己的
`127.0.0.1:<port>` 并列，互不干扰），把 HTTP 与 WebSocket（`/api/remote.mux`）反向代理回
`127.0.0.1:<port>`，并把 `Host` / `Origin` 改写成回环 authority 以通过 DSH 的信任围栏。
鉴权由我们自己的令牌门负责（令牌 → 会话 cookie → 才允许反代）。

**为什么不能绑 `0.0.0.0`**：DSH 0.2.2-rc.3 的 `dsh-host-webserver` 在**配置加载期**就拒绝
通配地址（原文：`webserver: host … is not a concrete IPv4 or IPv6 address literal`），
绑通配会让整个 profile 起不来。**这是硬约束，不是风格问题。**

**前置条件**：平板与电脑在同一个局域网（同一路由器 / 同一 Wi-Fi），电脑防火墙放行该端口
（Windows 首次监听会弹一次「允许访问」）。

**操作步骤**：
1. 电脑 DSH 设置 → 远程访问 → 方式选「局域网直连」；
2. 点「保存」，再点「启动」；状态区会显示绑定的具体地址（例如 `192.168.1.6:3080`）；
3. 点「显示二维码与链接」，用平板扫码（或把地址手输到 App 设置里的「远程控制」）；
4. 平板与电脑连同一个 Wi-Fi；
5. 平板 App → 设置 → 远程控制 → 打开。

**字段**：`lanAddress`（具体 IPv4，可留空自动挑非虚拟网卡）、`port`（`0` = 跟 DSH 同端口）。
**最常见失败**：① 挑到了虚拟网卡（Hyper-V/WSL）→ 手动选 Wi-Fi 网卡的地址；② Windows 防火墙
拦了入站 → 弹窗里选「允许」；③ 平板在访客网络 / AP 隔离 → 换主网络。

### 2.2 `ipv6` 公网 IPv6 直连

**机制**：旁挂监听直接绑**具体的公网 IPv6 字面量**（DSH 的 `host` 校验接受 v6 字面量），
平板用 `http://[地址]:端口/?token=…` 打开。**不需要 DNS，也不需要 trustedHosts**
（Host 规则允许「等于绑定 IP 字面量，端口不限」）。

**前置条件**：① 家里宽带有公网 IPv6（三大运营商多数默认给，光猫桥接/路由模式都可能）；
② 路由器/光猫的 **IPv6 防火墙放行该端口入站**（IPv6 没有 NAT，"端口映射"不存在，只有防火墙策略）；
③ 电脑拿到的是**稳定**的全局地址，不是 `Temporary`（临时地址每几小时轮换，绑它必炸）；
④ 平板所在网络（蜂窝 / 别家 Wi-Fi）也要有 IPv6。

**操作步骤**：
1. 电脑上 `ipconfig` 或设置 → 网络 → 看有没有 `2408:` / `2409:` / `240e:` 开头的地址；
2. DSH 设置 → 远程访问 → 方式选「公网 IPv6」，填那个地址（**不要带方括号**）；
3. 点「自检」——`v6-stable` 与 `dsh-bound-v6` 必须都是 ok；
4. 到路由器/光猫放行该 TCP 端口入站；
5. 用平板（关 Wi-Fi、开蜂窝）打开二维码里的地址，**这一步只能人工验证**（插件无法自证公网可达）。

**字段**：`ipv6Address`（不带方括号）、`port`。
**最常见失败**：① 选中的是 `Temporary` 地址（自检会 fail 并直接说）；② 光猫/路由器拦了入站
（自检只能给 `unknown`，不假阳性）；③ 平板网络没有 v6（蜂窝多数有，部分公共 Wi-Fi 没有）。
**风险**：明文 HTTP + 公网暴露，务必依赖令牌 + 限速；长期用建议改 Cloudflare。

### 2.3 `cloudflare` Cloudflare Tunnel

**机制**：`cloudflared` 在电脑上跑，向 Cloudflare 边缘建**出站**长连接，把公网
`https://<host>` 的流量转回本机。我们的监听绑在 `127.0.0.1:<port>`（只给 cloudflared 用），
令牌门与上游身份注入仍由插件负责。平板只开一个 https 地址，零安装。

**两种形态**：
- **Quick Tunnel**（零账号、零域名）：`cloudflared tunnel --url http://127.0.0.1:<port>`，
  输出里拿到 `https://xxxx.trycloudflare.com`。**域名每次重启都变**，单隧道 200 in-flight，
  官方明确不支持 SSE。
- **命名隧道**（要域名）：域名托管到 Cloudflare + 免费账号，`cloudflared tunnel create/route`。
  地址固定，可开机自启。

**⚠️ 未实测**：Cloudflare 官方文档**没有明文写 quick tunnel 是否支持 WebSocket**（只列了不支持
SSE）。DSH 的 `/api/remote.mux` 是 WS，所以这条**必须实测**：
```bash
# 拿到 trycloudflare 域名后，看能不能拿到 101
npx --yes wscat -c "wss://<你的域名>/api/remote.mux" -H "cookie: dsh-remote-session=<会话值>"
```
拿到 `101 Switching Protocols` 才把这条标成可用；拿不到就退回命名隧道或 Tailscale Funnel。

**操作步骤**：
1. 电脑下载 `cloudflared.exe`（官方 release，单文件）；
2. `cloudflared tunnel --url http://127.0.0.1:<插件监听端口>`；
3. 把输出里的 `https://xxx.trycloudflare.com` 填到 App 或插件设置；
4. 平板直接打开（首次会在插件侧 401，用二维码里的 `?token=` 换一次会话即可）。

**字段**：`cloudflareHost`（主机名，不带 `https://`）、`port`。
**最常见失败**：① 忘了把 `cloudflared` 指到**插件的监听端口**而不是 DSH 自己的端口（会 401
一路到底）；② quick tunnel 域名过期（重启就变）；③ WS 不通（见上面的实测）。

### 2.4 `tailscale` Tailscale

**结论先说**：PC 侧成熟可用；**平板侧是硬伤**——Tailscale 官方没有 HarmonyOS 客户端
（相关 issue 被标 not-planned），而**「卓易通里装安卓版 Tailscale」这条路不可用**：卓易通是
独立的 Android 容器（独立 netns），容器里的 `VpnService` tun 只覆盖容器内应用，**宿主原生浏览器
与我们自己的 ArkUI-X App 不会走 Tailscale 路由**（官方仓库有用户实测原话，见
`RESEARCH-C-tailscale-harmony.md` §2）。

**可用路径**：平板装**鸿蒙原生**第三方 Tailscale 客户端（如 HarmoTail，HAP 侧载，走系统
VPN，beta），或自己构建（Go 核心能在鸿蒙上加载，已有人验证到一半）。这条路一通，宿主级 tun
生效，原生浏览器与我们的 App 都能访问 `100.x`。

**前置条件**：Tailscale 账号；电脑装 Tailscale 并登录（拿到 `100.64.0.0/10` 地址）；平板装
鸿蒙原生客户端；App/浏览器走宿主 VPN。

**字段**：`tailscaleHost`（`100.x` 地址；MagicDNS 名称不能用来绑定监听，插件会拒绝并提示）、`port`。
**UI 标注**：`needs-setup` + 明写「卓易通不可用，需鸿蒙原生客户端」，**不做假开关**。

### 2.5 `manual` 手动地址

你自己有一条能访问到电脑的地址（公司 VPN、别人的隧道、内网反代都行）。插件只做：
地址归一（补 `http://`、校验 scheme/host/端口）、`http` 明文告警、可选自检。
**不代管监听**，也不会替你做鉴权——安全性由你自己那条链路负责。

**字段**：`manualUrl`（完整地址，可含 token）。

### 2.6 `uu` 网易 UU 远程（不可用）

**判定：不能当隧道用。** 依据（`RESEARCH-B-uu-remote.md`，官网正文逐条核对）：
① 官网 8 项特色功能 + 4 个场景**没有**任何端口映射 / 内网穿透 / 异地组网条目；
② 帮助中心「功能指引 + 常见问题」无端口映射相关条目；
③ 手机控电脑的流程是「双方登录就绪 → 从设备列表点进入桌面」，临时协助是「设备 ID + 验证码」，
被控端只支持 Windows/macOS —— 它**转的是编码后的画面帧与输入事件**，不产生虚拟网卡/虚拟 IP；
④ 没有任何「把 `127.0.0.1:PORT` 发布成一个 URL」的概念，我们的 App 内嵌 Web 拿不到可打开的地址。
⑤ 退一步说，即便它能开端口，DSH 只听 `127.0.0.1`，还需要有人把它反代出来——UU 两件都做不到。

**同类**：ToDesk / 向日葵本质同为远控（向日葵首页虽挂「异地组网 | 内网穿透」入口，但指向企业
咨询，细则未取到）；**真要国产零自建隧道，看贝锐花生壳 / 蒲公英**，代价是账号 + 实名 + 免费档
额度很小（见 §1）。

## 3. 字段语义对照表（两端共用）

`RemoteSettings`（插件，`~/.dsh/git-config-sync/remote.json`）与 App preferences 键一一对应。
**改这张表必须同时改两端 + `types.ts`。**

| 字段 | 类型 | 默认 | 出现于 | UI 标签 | 校验 / 拒绝什么 | App 侧键名 |
| --- | --- | --- | --- | --- | --- | --- |
| `enabled` | boolean | `false` | 全部 | 允许远程访问 | 非布尔 → E_VALIDATION | —（App 只读展示） |
| `mode` | enum | `'lan'` | 全部 | 访问方式 | 必须 ∈ `lan/tailscale/ipv6/cloudflare/manual/uu` | `remoteMode` |
| `port` | number | `0` | lan/ipv6/tailscale/cloudflare | 端口 | 0–65535 的整数；`0` = 跟 DSH 同端口 | `remotePort` |
| `lanAddress` | string | `''` | lan | 局域网地址 | 只接受具体 IPv4；拒绝 `0.0.0.0`、`::`、`*`、`127.x` | `remoteLanAddress` |
| `tailscaleHost` | string | `''` | tailscale | Tailscale 地址 | 无协议/路径/端口；绑定时必须是 IPv4（100.x） | `remoteTailscaleHost` |
| `cloudflareHost` | string | `''` | cloudflare | 隧道域名 | 主机名，无协议、无路径、无端口 | `remoteCloudflareHost` |
| `ipv6Address` | string | `''` | ipv6 | IPv6 地址 | 合法 IPv6 字面量；**不接受方括号** | `remoteIpv6Address` |
| `manualUrl` | string | `''` | manual | 完整地址 | 只接受 `http(s)://`；可含 token（错误细节里打码） | `remoteManualUrl` |

补充约定：
- 插件侧 `port: 0` **不是**"随机端口"，而是"服务层解析 `ctx.webServer.port` 后传具体值"；
- **App 侧端口必填**（`lan` / `ipv6` / `tailscale`）：App 拿不到电脑上的 DSH 端口，省略端口只会
  打开 80，等于给一个注定打不开的地址，所以 `port: 0` 直接给「请先填端口」的失败结论，
  `missingFields` 也会把 `port` 报成缺失（`cloudflare` / `manual` 不看端口）；
- App 侧多一个 `remoteUrl` 键，是「最终打开的地址」缓存（历史字段，保留）；
- 令牌**不在**上表里：它不属于配置，存在 `~/.dsh/git-config-sync/remote-token.json`（0600），
  只经二维码 / 「显示链接」出口给本机用户。

## 4. 连通性自检（`probe`）

自检是**给人话结论**，不是给人日志。等级语义：`ok` / `warn` / `fail` / `unknown`，
聚合规则：有 `fail` → `fail`；否则有 `unknown` → `unknown`；否则有 `warn` → `warn`；否则 `ok`。
**`unknown` 永远不会被降级成 `ok`**，这是防假阳性的结构保证。

| check id | 判什么 | ok | warn | fail | unknown |
| --- | --- | --- | --- | --- | --- |
| `dsh-port-known` | 拿不到 DSH 监听端口 | — | 拿不到 | — | — |
| `dsh-loopback-reachable` | 本机能不能连上 DSH 自己的端口 | 能 | — | 不能 | — |
| `lan-address` | 有没有可用的非虚拟 IPv4 | 选中并写出地址 | — | 一个都没有 | — |
| `lan-bind` | 旁挂监听是否已绑**具体**地址 | 已绑具体地址 | 未启动 | 绑到了通配地址 | — |
| `lan-same-subnet` | 监听地址与配置地址是否一致 | 一致 | 不一致 | — | — |
| `v6-global` | 有没有 `2000::/3` 的全局 v6 | 有 | — | — | 读不到网卡详情 |
| `v6-stable` | 选的是不是 `Temporary` 地址 | 稳定地址 | — | 临时/弃用地址 | 无法判定 |
| `dsh-bound-v6` | 该 v6 上有没有监听 | 有且能连 | — | 没有监听 | — |
| `firewall-inbound` | 入站是否有放行规则 | — | — | — | **恒 unknown**（读不到就诚实降级） |
| `external-reachability` | 公网是否能连回来 | — | — | — | **恒 unknown**（必须从外网人工验） |
| `tailnet-address` | 有没有 `100.64/10` 地址 | 有 | 没有 | — | — |
| `tailscale-host-match` | 配置的 host 与实测是否一致 | 一致 | 不一致 | — | — |
| `cloudflared-installed` | 本机有没有 cloudflared | 有 | 没有 | — | — |
| `tunnel-host` | 隧道域名是否像样 | 固定域名 | `*.trycloudflare.com`（会变） | 空 | — |
| `ws-upgrade` | WS 能不能 101 | — | — | — | 需实测（本机不自证） |
| `manual-url-parse` | 手动地址能否解析 | 合法 | — | 非法 | — |
| `manual-url-scheme` | 手动地址的 scheme | https | http（明文告警） | — | — |
| `mode-unknown` | 方式不认识（fail-closed） | — | — | 恒定 fail | — |
| `uu-unsupported` | —— | — | — | 恒定 fail（不是隧道） | — |

## 5. 安全边界（改动前必读）

1. **令牌**：`crypto.randomBytes(32)`（base64url），存 `remote-token.json`（0600）。
   比较用 `timingSafeEqual`；令牌**永不**进日志、错误消息、RPC 状态响应；
   唯一出口是「显示链接/二维码」这个显式动作。
2. **令牌门**：三种入口（`?token=` / `x-dsh-remote-token` 头 / 会话 cookie）；
   命中 `?token=` 时**本层消化**——303 到干净地址 + 下发 `HttpOnly; SameSite=Lax` 会话 cookie，
   **绝不把带 token 的请求转发给上游**（DSH 会拿错 token 直接 401，且 token 会进上游日志）。
3. **上游身份**：代理用 `ctx.connection.authenticatedUrl()` 在**本机**换一次 DSH 的
   `dsh-auth-*` 会话 cookie，cookie 只留在服务端、只出现在发给上游的请求头里。
   上游响应里的 `Set-Cookie` **必须剥掉**（否则等于把 owner 会话发给平板）。
4. **限速**：同一 IP 的令牌失败计数 + 锁定（返回 429 + `Retry-After`）；
   没有对端 IP 时退化为 `unknown` 桶，**不能因此放行**。
5. **回环**：DSH 自己监听的 `127.0.0.1` 由 `connection` 服务负责（本机工具/设置页免认证）；
   但**旁挂监听上即使来源是回环也要令牌**（cloudflare 方式它就绑在 `127.0.0.1` 上，
   同机其它进程不该顺手拿到 owner 权限）。
6. **明文 HTTP**：局域网/隧道内都是 http（Cloudflare 除外，它给 https）。公网暴露（IPv6/隧道）
   **必须**优先选带 TLS 的方案；纯 http 只用于可信内网。

## 6. 未验证清单（每条都给了怎么验）

| # | 未验证 | 怎么验 |
| --- | --- | --- |
| 1 | Cloudflare Quick Tunnel 是否支持 WS upgrade（101） | 建隧道后用 `wscat` 连 `wss://<host>/api/remote.mux`，看是否 101 |
| 2 | 命名隧道 + 自有域名的稳定性 / 大陆可达性 | 同一域名连续 24h，每 10 分钟一次 `/__dsh_remote/health` |
| 3 | 鸿蒙原生 Tailscale 客户端（HarmoTail）端到端 | 平板侧载 HAP → 登录 → `ping 100.x` → 原生浏览器开地址 |
| 4 | 平板蜂窝网络是否分配公网 IPv6 | 平板关 Wi-Fi，看「关于本机 → 状态信息」的 IP 是否 `2xxx:` 开头 |
| 5 | 路由器/光猫 IPv6 防火墙放行是否生效 | 外网（手机蜂窝）`curl -6 http://[地址]:端口/__dsh_remote/health` |
| 6 | 公网 IPv6 前缀长期稳定性 | 记录 7 天，看地址是否变化（`RA` 前缀 lease） |
| 7 | 局域网旁挂监听在桌面版 DSH（非 `dsh web` profile）上的端口来源 | 读 `ctx.webServer.port` 实测（插件已有该路径） |
| 8 | 真机（MatePad / HarmonyOS NEXT）内嵌 Web 打开远程页的横竖屏与返回栈 | 真机验收，见 `docs/VERIFICATION.md` |

## 7. 参考

- 成熟插件源码对照（只读）：`docs/RESEARCH-A-mobile-remote.md`
- 网易 UU 远程 / 国产远控：`docs/RESEARCH-B-uu-remote.md`（官网 `uuyc.163.com`、帮助中心）
- Tailscale × HarmonyOS NEXT / 卓易通：`docs/RESEARCH-C-tailscale-harmony.md`
  （Tailscale issue #12728、华为开发者论坛、ClashBox #113）
- 公网 IPv6：`docs/RESEARCH-D-ipv6.md`（`netsh interface ipv6 show addresses` 等实测命令）
- 零自建方案盘点：`docs/RESEARCH-E-zero-infra.md`
  （Cloudflare Tunnel 文档、Tailscale Funnel 文档、ngrok/ZeroTier/花生壳/蒲公英定价页）
- DSH 自身的绑定约束：`dsh-host-webserver` 的 `host` 校验（asar 内 `isWildcardHost` /
  `isLoopbackHost` / `webserver: host … is not a concrete IPv4 or IPv6 address literal`）
