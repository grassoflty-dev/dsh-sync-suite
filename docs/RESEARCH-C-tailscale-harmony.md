# C. Tailscale 在 HarmonyOS NEXT 平板上的可用性

> 调研时间：2026-11-17（时间盒 20 分钟，只读调研，未碰真机、未改源码）
> 结论先行；每条证据都标了**强度**与 URL。凡是"未验证"就写"未验证"，不做善意推定。

## 0. 定论（一句话）+ 置信度

**「用卓易通装安卓版 Tailscale 让宿主原生浏览器 / 我们的 ArkUI-X App 走 Tailscale」= 不可用**（容器内 App 能走，宿主 App 不能走 —— 这是容器网络命名空间隔离的必然结果）。
**但「平板端用 Tailscale」本身可行**，前提是改用**鸿蒙原生**的第三方 Tailscale 客户端（走 `VpnExtensionAbility` 拿系统级 tun），例如 HarmoTail。
置信度：**中强（medium-strong）**。「卓易通路径不可用」= 中强（3 条独立用户实测 + 架构推断，缺官方声明）；「原生客户端可行」= 中（官方 API 与第三方真机证据齐，但没有我们自己的真机验证，且全部为侧载、非应用市场）。

## 1. 原生可用性（AppGallery / 官方支持）

### 1.1 Tailscale 官方：明确不做（强证据）

| 事项 | 证据 |
|---|---|
| FR：HarmonyOS NEXT version | <https://github.com/tailscale/tailscale/issues/12728> —— 2024-07-07 开，**至今 open**，labels `fr` + **`not-planned`**，7 个 👍，14 条评论 |
| FR：Add HarmonyOS NEXT Support（重复单） | <https://github.com/tailscale/tailscale/issues/18207> —— 2025-12-15 开，**2026-03-31 closed**，label `needs-upstream` |
| 官方人员表态 | 维护者 `bradfitz`（MEMBER）2026-02-13 在该 issue 下回复："Has anybody tried asking Claude Code Opus 4.6 … The Android version is open source. And so is libtailscale. Between those two things, an AI agent should be able to whip up a decent mobile app nowadays." → 官方没有排期，建议社区自己写 |
| 官方不做的技术理由 | 同 issue 2026-03-31 引述 `@overflowcat`（MEMBER）：缺 HarmonyOS 的 CI 环境、**Go 对 OHOS 支持不足**（<https://github.com/golang/go/issues/67829>），华为的 fork（<https://gitcode.com/openharmony-sig/ohos_golang_go>）是否能跑通存疑 |

→ **结论：Tailscale Inc. 没有、且（按 `not-planned` 标签）不打算出 HarmonyOS NEXT 客户端；也没有上架 AppGallery 的官方应用。**

### 1.2 社区/第三方：已有能装能跑的鸿蒙原生客户端（中等证据，均为侧载）

| 项目 | 形态 | 关键事实 | 强度 |
|---|---|---|---|
| **HarmoTail** v0.16.3 | HAP 侧载（GitHub Releases）+ 官网 | 面向 HarmonyOS NEXT 的原生 Tailscale 客户端；**"接入 HarmonyOS 系统 VPN"**；Tailscale Core v1.102.4；支持 Exit Node / Taildrop / 多 Profile / **App 分流** / Allow LAN(Beta)。官网自述"不是 Tailscale 官方应用，与 Tailscale Inc. 无隶属关系，也未获得授权或背书"，当前 **Beta**。安装方式：开开发者模式 + 无线调试，用 PC 端"小白调试助手"装 HAP —— **即未通过应用市场** | 中：官网 + Releases 实体存在，功能描述具体；但无第三方复现报告，且是 Beta |
| **binku87/tailscale-harmony** | 开源工程（DevEco + OHOS Go fork） | 把 tailscale + gVisor netstack + wireguard-go 编成 `aarch64-linux-ohos` 的 .so，ArkTS 经 NAPI 加载，跑在 `VpnExtensionAbility` 拿到的 **tun fd** 上。README 记录 2026-07-27 在 Huawei CLS-AL00 / HarmonyOS 6.1 / API 23 **真机验证"Go 核心 dlopen 加载运行成功"**；但**"点 Connect 真连上 tailnet"的端到端仍未验证**。另记录了关键阻塞：stock Go 的 initial-exec TLS 在鸿蒙 musl dlopen 下报错，必须换 `GOOS=openharmony` 的 fork | 中强（技术路径已被真机证明可行；成品未完成） |
| TailMesh / MeshArc / Tailscale-OHOS | 第三方目录站条目 | <https://jiaoduan.fun/>、<https://fangzhou.club/apps/io.github.tailscaleohos>、<https://kaiyuanbang.cn/zh-cn/repo/flypigj-tailscale-ohos.html> —— 只有目录页描述，未见仓库/真机报告 | **弱**：仅作线索，未核实 |

- HarmoTail 官网：<https://wuwu888.github.io/harmotail-harmonyos/>（下载页 <https://github.com/wuwu888/HarmoTail-Releases>）
- Tailscale 移植工程：<https://github.com/binku87/tailscale-harmony>

**AppGallery 上架情况**：**未验证/未见**。上述所有项目均以 HAP 侧载分发（HarmoTail 官网只给 GitHub Release + 小白调试助手），没有任何一处在文本里声称已上架华为应用市场。→ 记为「弱证据：未见上架」，不是「确认不上架」。

### 1.3 系统能力前提：鸿蒙确实开放"三方 VPN"（强证据）

- `@ohos.app.ability.VpnExtensionAbility`（三方 VPN 能力）+ `@ohos.net.vpnExtension`（三方 VPN 增强管理）：<https://developer.huawei.com/consumer/cn/doc/harmonyos-references/js-apis-net-vpnextension>
- 说明要点：三方 VPN 应用以 ExtensionAbility 形式创建虚拟网卡（tun）并**配置 VPN 路由信息**；启动/停止需**用户 VPN 信任授权**（`stopVpnExtensionAbility` 调用方必须已获用户 VPN 信任授权）。
- 旁证：同类原生实现确实跑起来了 —— ClashBox（<https://github.com/xiaobaigroup/ClashBox>）、OhosXray（VpnExtensionAbility + Xray-core，<https://github.com/Henry-Fox/OhosXray>）。

→ **这是"平板端不靠卓易通也能组网"的技术基础：鸿蒙和 Android 一样有系统级 tun + 路由注入能力，只是入口叫 `VpnExtensionAbility` 而不是 `VpnService`。**

## 2. 卓易通网络模型与 VpnService 可用性（逐条证据 + URL）

### 2.1 卓易通是什么（中等证据）

- 归属：**上海卓易科技**为 **HarmonyOS 5** 打造的安卓兼容运行环境（不是华为自研，也不是"华为官方模拟器"）。
- 技术形态（转述自技术分析文，**中等可信**，非官方文档）：卓易通 = 一个 ~10MB 的 HAP 壳 + `卓易通.apk` + `文件共享.apk` + `搜应用.apk` + MicroG 环境 + 一个**解压后 2.15GB 的 `anco_hmos.img`**（安卓容器镜像）；**"基于 iSulad 轻量级容器，提供沙盒式安卓子系统，共享鸿蒙内核"**。
  - <https://cloud.tencent.com/developer/article/2646600>
- 官方站点 <https://www.droitong.com/> 是纯图片落地页，**没有任何网络/VPN 隔离的技术说明** —— 这是本文最主要的**证据缺口**：官方（华为或卓易）从未公开写"容器网络是否与宿主共享"。

### 2.2 判定链证据

**证据 1（最强，直接命中本问题，强度：中强）** —— Tailscale 官方仓库里用户的实测反馈：

> "Half a month ago, I was still using tailscale **in the Zhuoyitong application** to network and synchronize data between **my HarmonyOS application** and the NAS at home. Now I find it's not working. **I can only make the applications installed in Zhuoyitong use tailscale for routing. HarmonyOS applications can no longer be routed through tailscale.**"
> —— `E218PQ`，2026-08-26，<https://github.com/tailscale/tailscale/issues/12728#issuecomment-5422577689>

读法：① 容器内 Tailscale 只能让**容器内的 App** 走 Tailscale 路由；② **宿主鸿蒙应用已经不能**被它路由；③ 更早的版本"曾经可以"→ 说明行为随卓易通版本漂移，**依赖它会随时失效**。这条同时坐实"能连上"和"宿主不走"两件事，是最贴近我们场景的证据。

**证据 2（中，宿主侧完全看不到这个 VPN）** —— 华为开发者论坛原帖 + 镜像：

- 原帖：<https://developer.huawei.com/consumer/cn/forum/topic/0202197027869310388>（标题："卓易通安装的VPN显示能连接成功，但实际上上不了内网"，2025-10-28）
- 可读镜像：<https://bbs.itying.com/topic/69074ed6e559fe007bef68ba>
- 帖中用户原话要点：公司内网 VPN 只有安卓版 → 用卓易通装；**"软件显示连接成功，但内网上不去"，报 `ERR_NAME_NOT_RESOLVED`**；并明确对比："**之前鸿蒙4.2版本，会在手机 VPN 设置里有个软件按钮，鸿蒙5.0鸿蒙6.0都是没有的**"。
- 读法：容器内的 VpnService **没有**形成宿主级 VPN —— 系统「设置 → VPN」里根本没有这个条目；连容器自己内部的 DNS 都没被接管（域名解析不出来）。注意：该帖回复多为社区猜测或 AI 生成的排查建议（**弱**），只有楼主的现象描述可用。

**证据 3（中，反向验证网络栈关系）** —— 宿主原生 VPN 能覆盖容器，反之不行：

> ClashBox #113「原生鸿蒙浏览器无法通过代理上网，但卓易通内的应用可以」（MatePad Pro 2025 12.2 / HarmonyOS 6.0.0.125sp8 / ClashBox 1.7.2）：开 ClashBox（原生 `VpnExtensionAbility`）后，**卓易通里的 Chrome/YouTube 能走代理**，**原生鸿蒙浏览器不能**；作者自述"flclash 可以正常代理原生浏览器，反而是原生的代理软件只能代理卓易通里面的软件"。
> <https://github.com/xiaobaigroup/ClashBox/issues/113>

读法：容器流量在 IP 层是**经宿主网络栈出去**的（所以宿主级 tun 能把它抓进去）；但这**不能反向推导**成"容器的 tun 能覆盖宿主"——两者是单向的。顺带说明：原生 tun 方案本身也受实现质量影响（ClashBox 这个 bug 是它自己的宿主覆盖不完整），**原生客户端能否 100% 覆盖宿主 App 必须真机验**。

**证据 4（架构，中）**：卓易通基于 **iSulad 容器**（namespace/cgroup 隔离的容器引擎）。容器拥有独立 netns 才能同时解释证据 1/2/3。**这条是推断，不是官方文档**。

### 2.3 VpnService 在兼容层里是否可用 —— 判定

| 子问题 | 判定 | 强度 |
|---|---|---|
| 容器内能否"启动"安卓 VpnService / 显示已连接 | **能**（证据 1、2 都是"显示连接成功"） | 中强 |
| 该 tun 的路由是否作用于**容器外**（宿主原生 App） | **不能** | **中强** |
| 宿主「设置 → VPN」里是否出现该 VPN | **不会出现**（鸿蒙 5.0/6.0 无此入口，证据 2） | 中 |
| 容器内 DNS 是否被该 VPN 接管 | **很可能不接管**（证据 2 的 `ERR_NAME_NOT_RESOLVED`） | 弱—中（单一案例） |
| 该行为是否稳定 | **不稳定**（证据 1：曾经能给宿主用，2026-08 起不行） | 中 |

→ **总判定：作为"让宿主 App 走 Tailscale"的手段，卓易通 + 安卓 Tailscale = 不可用。**

## 3. 为什么宿主 App 不一定走兼容层 VPN（技术说明）

Android `VpnService` 的语义从来不是"给操作系统装路由"，而是：**本进程在"我所在的这个 Android 系统"里创建 tun，并修改"这个系统"的路由表与 DNS，把该系统的流量导入 tun**。系统的边界在哪里，VPN 的边界就在哪里。

放到卓易通上，这个"系统"是 iSulad 容器：

1. **tun 在容器 netns 里**：`/dev/net/tun` 打开得到的设备、`VpnService.Builder` 下发的地址/路由/DNS，全部写在容器 netns 的 FIB 与 resolver 配置里。
2. **宿主只看自己的表**：HarmonyOS 原生 App（含我们的 ArkUI-X HAP、原生浏览器、ArkWeb）的 socket 从**宿主 netns** 出去，查的是宿主路由表。宿主要把 100.64.0.0/10 导进某条隧道，唯一入口是 `VpnExtensionAbility` 建的宿主级 tun —— 容器的路由表对它不可见，也没有"跨 netns 同步路由"的公开 API。
3. **授权也在宿主侧**：鸿蒙的 VPN 信任授权、常驻 VPN、状态栏钥匙图标都由宿主 OS 管；容器里的 App 无权代宿主授权，所以宿主「设置 → VPN」不会出现条目（证据 2 正好如此）。
4. **tun 设备本身可能根本不可用**：容器内没有内核模块/设备节点权限时，VpnService 常见退化是"连接状态成功、但数据面不通"——正好是证据 2 的"显示连接成功、上不了内网"。

一句话：**VPN 是"包住整台设备"的能力，兼容层只能包住它自己。** 因此"在卓易通里装 Tailscale"这件事，最多让卓易通**里面**那个浏览器访问到家里 PC，**不会**让宿主原生浏览器或我们的 App 走 Tailscale。

## 4. 替代路径（每条给前置条件与代价）

### A. 鸿蒙原生第三方 Tailscale 客户端（**本任务推荐的一线方案**）

- 候选：**HarmoTail**（最成熟，v0.16.3，HAP 侧载）；自建：**binku87/tailscale-harmony**（开源、需自签、端到端未验）；TailMesh / MeshArc（线索级，未核实）。
- 前置条件：① 平板能开**开发者模式 + 无线调试**；② 有 PC 装"小白调试助手"（<https://github.com/likuai2010/auto-installer>）或直接用 DevEco 签名安装；③ 有个 Tailscale 账号（或 authKey）；④ 首次连接需在系统弹窗里**授予 VPN 信任**并手动完成浏览器登录。
- 收益：宿主级 tun → **原生浏览器、ArkWeb、我们的 ArkUI-X App 一并走 100.x/exit-node**，App 侧零改动。
- 代价/风险：非官方、非应用市场、Beta；系统大版本升级可能失效；后台存活（锁屏/切网）未验证；无人担保签名来源（只在项目自述可信的前提下装）。

### B. 干脆不给平板组网：Cloudflare Tunnel（**推荐作为默认/兜底**）

- 做法：家里 PC 常开 `cloudflared`，把 DSH Web GUI 暴露成 `https://dsh-xxx.example.com/`；平板 App 的 Web 组件直接打开 `https://…/?token=…`。
- 前置条件：一个域名（托管在 Cloudflare）+ Cloudflare 账号 + PC 侧出站连接（无需公网 IP、无需开端口）。
- 收益：**平板端零安装、零 VPN 授权**；顺带把明文 HTTP 问题彻底消掉（https + 受信证书）；跨网络（4G/公司 WiFi）一致。
- 代价：流量过 Cloudflare（延迟 + 带宽受免费额度影响）；必须配 Cloudflare Access 或不可猜的 token 做访问控制；PC 必须能连外网。

### C. 公网 IPv6 直连

- 前置条件：家里宽带给**真公网 IPv6**（/64，且运营商不封入站端口）+ PC 防火墙放行端口 + DDNS + 足够强的 token；平板所在网络也必须有 IPv6（很多 4G/5G 与公司 WiFi 是纯 v4/CGNAT）。
- 收益：不经第三方中转，延迟最好；不需要任何平板端软件。
- 代价：**明文 http 直接暴露在公网**（必须换 https 或至少 token + IP 白名单）；IPv6 可用性不可控；家宽 v6 前缀会变。

### D. 其他（不推荐，仅记录）

- 宿主装 ClashBox 类原生代理 + 自建出口节点（WireGuard/SS）：能覆盖宿主，但其宿主覆盖本身有已知 bug（#113），且要额外维护节点 —— 不如 A 直接。
- ZeroTier：**未找到**鸿蒙原生客户端；社区做法是"卓易通跑修改版安卓 ZeroTier"，**同样受第 3 节的 netns 限制**，不能解决宿主路由问题。→ 标「不推荐，且同样不可行」。证据：<https://post.smzdm.com/p/a5rdnzek/>（媒体转述，弱）。

## 5. 对插件/App 的要求

1. **能力项必须拆成两条，禁止笼统标"Tailscale 可用"**：
   - `remote.transport.tailscale.native` → 状态 **「需先装第三方鸿蒙 Tailscale 客户端（如 HarmoTail）并授予系统 VPN」**，默认关闭，UI 用"需先装 X"的引导卡（给出官网/Releases 链接 + 一句话风险提示：非官方、Beta、侧载）。
   - `remote.transport.tailscale.zhuoyitong` → 状态 **「不可用」**，或直接从候选清单移除。理由写进 UI 提示："兼容层内的 VPN 只对兼容层内的 App 生效，宿主 App 不会被路由。"
2. **App 代码零改动**：App 只负责请求 `http://<tailscale-ip>:<port>/?token=…`，走不走隧道完全由宿主路由决定。**不要**在 App 里做"检测是否安装了卓易通/Tailscale"这类逻辑（既不可靠，也把平台细节泄漏进业务层）。
3. **连通性自检 + 可执行引导**：启动时打一次轻量探测（如 `GET /api/health`，2–3s 超时）。失败时按顺序给三条引导：① 系统「设置 → VPN」里是否有已连接的 Tailscale 客户端；② 改用 Cloudflare Tunnel 域名（方案 B）；③ 检查 PC 侧服务与端口。
4. **文档/矩阵里同时给 B 方案**：把"平板访问家里 PC"的**默认推荐**写成 B（Cloudflare Tunnel），把 A（原生 Tailscale）标为"进阶/需要侧载"。这样即使用户不接受侧载，产品路径依然成立。
5. **明文 HTTP**：结论级判断 —— App 侧无需改（仓库已有 `module.json5`/`network_config.json` 相关结论）；系统层见 [VERIFICATION-HTTP-CLEARTEXT.md](VERIFICATION-HTTP-CLEARTEXT.md)：**HarmonyOS 默认允许明文 HTTP**，一旦工程引入了 `resources/base/profile/network_config.json`，必须在 `component-config` 里显式写 `"ArkWeb": true`，否则 ArkWeb 侧有被拦成 `-29` 的风险；Android/ArkUI-X 侧是**另一套** `usesCleartextTraffic`，不要混用。**注意：该文档的所有结论同样未真机验证。**

## 6. 未验证 / 需真机验证的点（交给后续真机验收）

| 编号 | 要验什么 | 可执行步骤 | 预期/判定标准 |
|---|---|---|---|
| **V1** | 卓易通 + 安卓 Tailscale 是否真的**只**覆盖容器内 | 装卓易通 → 装安卓 Tailscale → 登录并联上；① 用**卓易通内**的浏览器打开 `http://<PC 的 100.x IP>:<port>/?token=…`；② 用**宿主原生浏览器**打开同一 URL；③ 看「设置 → VPN」里有无条目 | ① 成功 ② 失败 ③ 无条目 → 本文结论成立（则该路径可标"不可用"）。若 ② 也成功，说明该卓易通版本改回了共享网络，本文第 2/3 节需修订 |
| **V2** | 鸿蒙原生客户端能否覆盖我们的 App | 侧载 HarmoTail v0.16.3（开发者模式 + 无线调试 + 小白调试助手）→ 首次连接过 VPN 授权弹窗 → 确认「设置 → VPN」出现条目且已连接 → 原生浏览器开 `http://100.x:port` → 再装我们的 ArkUI-X HAP 打开同一 URL | 三者都通 → 方案 A 可标「可用（需先装 X）」；仅浏览器通、App 不通 → 查 App 分流/域名解析 |
| **V3** | 应用分流是否会漏掉我们的 App | HarmoTail 设置里看"App 分流"/"Allow LAN"（Beta）默认值；先关闭分流测一遍全局 | 全局模式下必须通；若必须开分流才通，要在 UI 里写清楚 |
| **V4** | 后台存活 | 连上后锁屏 30 分钟、切 WiFi↔5G、杀后台再回 | 隧道是否自动恢复；这是方案 A 最大的不确定项 |
| **V5** | 明文是否被系统拦 | 真机 Web 组件加载 `http://100.x:port`，看是否 `-29`；再在工程里放 `network_config.json` 复测 | 见 VERIFICATION-HTTP-CLEARTEXT.md §7 |
| **V6** | 方案 B 是否真的零依赖 | PC 上跑 `cloudflared tunnel --url http://127.0.0.1:<port>` → 平板原生浏览器直接开临时域名 | 通 → 可作为默认推荐，不需要任何平板端安装 |
| **V7** | 卓易通版本漂移 | 记录本次实测的卓易通版本号 + HarmonyOS 版本号（证据 1 表明行为随版本变化） | 写进文档，避免下次结论对不上 |

### 证据强度汇总

| 结论 | 强度 | 依据 |
|---|---|---|
| Tailscale 官方不做鸿蒙版 | **强** | 官方 issue `not-planned` + 维护者回复 |
| 鸿蒙有系统级三方 VPN 能力（VpnExtensionAbility） | **强** | 华为官方 API 文档 |
| 已有可跑的鸿蒙原生 Tailscale 客户端 | 中 | HarmoTail（侧载 Beta）+ binku87 真机加载成功（端到端未验） |
| 卓易通是 iSulad 安卓容器、网络隔离 | 中 | 技术分析文 + 3 条互相印证的实测 |
| 卓易通内的 Tailscale **不能**路由宿主 App | **中强** | 证据 1（直接命中）+ 证据 2（宿主无 VPN 条目）+ 架构必然性；**缺官方声明，缺我们自己的真机日志** |
| 卓易通官方对网络/VPN 隔离的说明 | **不存在** | 官网纯图，无技术文档 |
| 上述客户端已上架 AppGallery | **未验证（未见）** | 全部以 HAP 侧载分发 |
