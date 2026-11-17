# D. 公网 IPv6 直连：前置条件与自检设计

> 调研时间：2026-11-17 21:32–21:55（Asia/Shanghai）
> 调研机：本机 Windows（WLAN 3 / Intel AX211，IPv4 192.168.1.6，网关 192.168.1.1）
> DSH 版本：`0.2.2-rc.3`（当前监听 `127.0.0.1:40596`）
> 只读约束：本次**未修改**任何网络配置、未改防火墙规则、未改仓库源码；唯一写入是本文档。
> 所有命令输出均为本机实跑结果摘录（见 §2），未跑的一律标注「未验证」。

---

## 0. 结论（本机现状 + 可行性判定）

**一句话**：这台机器**已经拿到公网可路由的 IPv6 前缀与稳定地址**，Windows 防火墙也已有程序级入站放行规则；但**当前 DSH 只监听 127.0.0.1，所以现在不能被公网 v6 直连**。技术上「绑具体 v6 字面量」完全可行（本机已实证 node 能绑该地址并自连成功），剩下的卡点不在 Windows、不在 DSH，而在**上游（路由器 IPv6 防火墙 / 运营商入站策略）+ 平板侧是否有 v6 + 前缀稳定性**这三件本机无法自证的事。

| 项目 | 实测结论 | 依据 |
|---|---|---|
| 本机有全局 IPv6 地址 | ✅ 有，`2409:8a20:4cad:ba20::/64`（RA 下发，/60 前缀在路由表） | §2.1 / §2.2 |
| 默认 v6 路由 | ✅ 有，`::/0 → fe80::3207:a3ff:fe2a:8c88`（WLAN 3，metric 291） | §2.2 |
| 稳定（非临时）全局地址 | ✅ `2409:8a20:4cad:ba20:d2c0:3d53:7540:763c`（netsh 归类 `Public`） | §2.3 |
| 临时地址（privacy） | ⚠️ 存在且会轮换：`2409:8a20:4cad:ba20:e9c9:b85:e2eb:e5ec`（netsh 归类 `Temporary`） | §2.3 |
| ULA（fc00::/7） | ❌ 没有（`Get-NetIPAddress` 过滤 fc/fd 结果为空） | §2.5 |
| Windows 入站放行 | ✅ 已存在**程序级**入站 Allow 规则：`node.exe` 与 `deepseek harness.exe`（TCP/UDP，LocalPort=Any，Profile=Private+Public） | §2.4 |
| DSH 当前绑定 | ❌ 仅 `127.0.0.1:40596`（进程 `DeepSeek Harness`），无 v6 监听 | §2.6 |
| Node 能否绑公网 v6 字面量 | ✅ 实证：已有一个 node 进程监听 `2409:8a20:...:763c:18085`，且本机 `net.connect` 到该字面量返回 `CONNECT_OK` | §2.6 / §2.7 |
| 路由器/运营商是否放行入站 | ❓**未验证**，本机无法自证 | §6 |
| 平板（蜂窝/热点）是否有公网 v6 | ❓**未验证**，需在平板上实测 | §6 |

**可行性判定：`条件可行（需放行入站 + 需人工从外网验证）`**
不是「能」，也不是「不能」——本机侧全部就绪，决定性证据必须在**家以外的网络**上取得。任何声称「本机探测即可确认公网可达」的方案都是假阳性，本设计的核心就是拒绝这一点（见 §4.4）。

---

## 1. 前置条件表（含「怎么查」「人类可读提示语」）

按链路顺序排列，**任一环 fail 则整条方案不成立**。建议插件按此顺序提示用户，不要一上来就让用户改绑定。

| # | 前置条件 | 怎么查（人类侧） | 怎么查（插件可自动化） | 常见失败原因 | 人类可读提示语建议 |
|---|---|---|---|---|---|
| P1 | **平板侧有公网 IPv6** | 平板浏览器打开 `test-ipv6.com`（或 `6.ipw.cn`）；看是否显示一个 `2408:/2409:/240e:` 开头的地址；**必须关掉 WiFi 用蜂窝**再测一次（家里 WiFi 用的是同一前缀，测不出外面） | 无法自动化（不在本机）；只能由平板 App 上报自身 `getifaddrs`/系统 API 拿到的 v6 列表 | ① 蜂窝 APN 未开 IPv6（部分物联网卡/老套餐）；② 平板系统「IPv6 优先」被关；③ 连的 WiFi/热点是纯 v4（很多手机热点默认 v4-only） | 「平板在外网没有 IPv6 地址（只有 IPv4）。这条直连方案要求两端都有 IPv6：请用蜂窝数据重试，并在手机设置里打开『IPv6』；仍不行说明运营商没给平板分配 v6。」 |
| P2 | **家里宽带有 IPv6（三大运营商现状）** | 光猫/路由器管理页 → WAN/上网状态 → 看是否有 `240e:/2408:/2409:` 开头的 IPv6 地址；或本机 `ipconfig` 看是否有全局 v6 | 本机可取（`os.networkInterfaces()` + `netsh`）；**只能证明"已下发"，不能证明"可入站"** | ① 光猫桥接+路由器没开 v6；② 运营商侧未开通（部分省份家宽默认只给 v4，需电话开通「IPv6 双栈」）；③ 路由器固件把 RA 关了 | 「家里网络没有拿到公网 IPv6 地址。请先在路由器里打开『IPv6 / 双栈』，或联系宽带客服开通 IPv6；只开 IPv4 的话这条路走不通。」 |
| P3 | **光猫/路由器放行入站（IPv6 防火墙）** | 路由器管理页找「IPv6 防火墙 / 安全设置 / 端口过滤」，把目标设备的 **v6 地址 + 端口**加入允许（v6 没有 NAT，所以不是「端口映射」而是「入站放行」）；或临时整机放行做实验 | ❌ 完全无法自动化（家用路由器无统一 API）。**只能给「无法判定 + 操作指引」** | ① 路由器默认「IPv6 防火墙=开」并丢弃所有入站（最常见，占绝大多数失败）；② 用户误在 IPv4 端口映射里填 v6 地址（无效）；③ 有的光猫「IPv6 防火墙」在超管账号下才可见 | 「路由器默认会丢弃所有 IPv6 入站连接。请登录路由器，在『IPv6 防火墙』里为这台电脑的地址 `<addr>` 和端口 `<port>` 添加一条允许规则；v6 不需要端口映射。」 |
| P4 | **地址相对稳定（SLAAC/PD 前缀 vs 临时地址）** | 看本机是否有两个全局 v6（一个标 `Public`、一个标 `Temporary`）。临时地址会周期性变化 | ✅ 可自动化：Windows `netsh interface ipv6 show addresses` 能区分 `Public`/`Temporary`；跨次运行比对后缀 | ① 用户在 URL 里复制了**临时地址**，一小时后失效（最隐蔽的坑）；② 运营商 PD 前缀在重播/重启后变化（家宽普遍动态）；③ 设备后缀用 EUI-64（会泄露 MAC） | 「你绑定的是**临时隐私地址**，它每隔一段时间就会变，外网会突然连不上。请改用不带『临时』的那个地址 `<stable>`。」/「宽带前缀是动态的，重启光猫后地址可能变化，届时需要重新确认地址。」 |
| P5 | **端口固定且可预期** | 看 DSH 配置里的 `port`；不要在 URL 里用 `:0`（系统随机分配） | ✅ 可自动化：配置项 + 监听表比对 | ① 用 `port: 0` 导致每次启动端口不同；② 端口被其它程序占用后 DSH 静默换端口 | 「DSH 端口必须是固定值（当前 `<port>`）。设为 0 会让端口每次启动都变，外网书签立刻失效。」 |
| P6 | **Windows 防火墙放行该端口/进程** | `wf.msc` → 入站规则，看有没有对应程序或端口的允许规则 | ✅ 可自动化（`Get-NetFirewallRule` + `Get-NetFirewallProfile`），失败降级为 unknown | ① 公共网络 Profile 下没规则；② 规则绑了程序路径但 DSH 升级后路径变化；③ 第三方安全软件（火绒/360）自带防火墙另算 | 「Windows 防火墙在『公用网络』下可能拦截了入站。已检测到 `<已有/缺失>` 规则：`<细节>`。」 |
| P7 | **平板侧能接受该 URL 形式** | URL 里 v6 必须加方括号：`http://[2409:...:763c]:40596/` | ✅ 可自动化：校验拼接 | ① 漏方括号 → URL 解析成 host+port 错乱；② 带 `%zone`（如 `%22`）无法写进 URL | 「IPv6 地址写进网址必须加方括号：`http://[<addr>]:<port>/`；带 `%接口序号` 的地址不能直接用于外网访问。」 |

### 1.1 三大运营商 IPv6 现状（行业公开常识，非本机实测）

> ⚠️ 以下为公开资料层面的普遍情况，**各省差异很大，必须以 P2/P3 实测为准**，不要写进产品文案当承诺。

| 运营商 | 家宽前缀常见值 | 现状（普遍） | 入站限制（普遍） |
|---|---|---|---|
| 中国移动 | `2409:` / `2408:`（部分地区） | 双栈铺开较早，光猫默认下发 RA 较常见 | 部分地区对入站较严格（含 80/443），需实测 |
| 中国电信 | `240e:` | 多数省份已双栈，部分省份默认关闭需申请 | 部分省份封 80/443 入站 |
| 中国联通 | `2408:` | 双栈较普遍 | 相对宽松，但 80/443 亦可能被拦 |

工程含义：**不要假设 80/443 可用**。DSH 用高位端口（如 40596 一类）反而更容易通过运营商侧检查，代价是更依赖「安全靠 token 而不是靠隐蔽端口」。

---

## 2. 本机网络实况（命令 + 输出摘要）

### 2.1 `Get-NetIPAddress -AddressFamily IPv6`

关键行（原样摘录）：

```
InterfaceAlias  IPAddress                                     PrefixLength PrefixOrigin          SuffixOrigin AddressState
WLAN 3          2409:8a20:4cad:ba20:e9c9:b85:e2eb:e5ec        128          RouterAdvertisement  Random       Preferred
WLAN 3          2409:8a20:4cad:ba20:d2c0:3d53:7540:763c         64          RouterAdvertisement  Link         Preferred
WLAN 3          fe80::3395:7156:3ad4:9b96%22                    64          WellKnown            Link         Preferred
Loopback        ::1                                             128          WellKnown            WellKnown    Preferred
本地连接*16      2409:8a20:4cad:ba29::                             0          Other                Other        Preferred   ← Anycast（Wi-Fi Direct 虚拟适配器）
```

判读：
- `PrefixOrigin = RouterAdvertisement` ⇒ 前缀来自路由器 RA（SLAAC），不是手工/临时隧道。
- 一条 `PrefixLength 128 / SuffixOrigin Random` ⇒ **临时隐私地址**（RFC 4941）。
- 一条 `PrefixLength 64 / SuffixOrigin Link` ⇒ 该接口的**常规全局地址**（对外应绑这个）。
- **没有** `fc00::/7` ULA，**没有** `2001:db8` 之类文档地址。

### 2.2 `route print -6`

```
Active Routes:
 If Metric Network Destination      Gateway
 22    291 ::/0                     fe80::3207:a3ff:fe2a:8c88
 22    291 2409:8a20:4cad:ba20::/60 fe80::3207:a3ff:fe2a:8c88
 22    291 2409:8a20:4cad:ba20::/64 On-link
 22    291 2409:8a20:4cad:ba20:d2c0:3d53:7540:763c/128  On-link
 22    291 2409:8a20:4cad:ba20:e9c9:b85:e2eb:e5ec/128  On-link
```

判读：**默认 v6 路由存在**；路由器从运营商拿到的是 **`/60`** 前缀（`2409:8a20:4cad:ba20::/60` 经网关），本机所在网段是其中一个 `/64`。`/60` 是移动家宽典型的 PD 委派粒度，说明「家里有真 v6，不是 NAT66」。
两台虚拟适配器（`If 9`）另有 `fe80::/64` 与一条 Anycast，与主线无关。

### 2.3 `netsh interface ipv6 show addresses`（**关键：Public vs Temporary**）

```
Interface 22: WLAN 3

Addr Type  DAD State   Valid Life Pref. Life Address
Public     Preferred    23h58m11s     58m11s 2409:8a20:4cad:ba20:d2c0:3d53:7540:763c
Temporary  Preferred    23h58m11s     58m11s 2409:8a20:4cad:ba20:e9c9:b85:e2eb:e5ec
Other      Preferred     infinite   infinite fe80::3395:7156:3ad4:9b96%22
```

判读（对产品文案极重要）：
- Windows 把**稳定地址标 `Public`**、把**隐私地址标 `Temporary`**。这两个词是中文用户最容易搞混的一对：「公网地址」其实是稳定的那个，「临时地址」一定不能绑。
- `Pref. Life ≈ 58m`（RA 的 preferred lifetime 约 1 小时）意味着**临时地址每约一小时就可能换一个**——绑它必炸。
- 同时刻 `Valid Life ≈ 24h`，`Preferred` 状态，说明 RA 正常刷新，链路健康。

### 2.4 Windows 防火墙实况

```
Name    Enabled DefaultInboundAction DefaultOutboundAction
Domain     True        NotConfigured         NotConfigured
Private    True        NotConfigured         NotConfigured
Public     True        NotConfigured         NotConfigured
```
`DefaultInboundAction = NotConfigured` + `Enabled = True` ⇒ **默认入站行为是「阻止」**（Windows 默认值）。也就是说：入站默认全丢，只有显式 Allow 规则才通。

但**已经存在两条程序级入站 Allow 规则**（`Get-NetFirewallRule -Direction Inbound -Enabled True -Action Allow` 过滤）：

```
Name      : Node.js JavaScript Runtime        Proto: TCP   LocalPort: Any  Profile: Private, Public
Program   : C:\program files\nodejs\node.exe
Name      : deepseek harness.exe              Proto: TCP   LocalPort: Any  Profile: Private, Public
Program   : C:\users\gwl\appdata\local\programs\deepseek harness\deepseek harness.exe
（另各有一条 UDP 同规则）
```

判读：**Windows 侧对 "node.exe" 与 "DeepSeek Harness.exe" 的入站已经在 Private+Public 上放行，且 `LocalPort=Any`**。所以 P6 这台机器**已满足**，它不会成为失败点——失败点会落在路由器（P3）。这是个容易误判的地方：本机防火墙放行 ≠ 外网能连（还有路由器 + 运营商两道）。

### 2.5 ULA 检查

`Get-NetIPAddress -AddressFamily IPv6` 过滤 `fc*`/`fd*`：**空结果** ⇒ 本机没有任何 ULA 地址，因此自检里「排除 ULA」这一步在本机不会误伤（但仍必须实现，否则将来接上带 ULA 的路由器会误判成公网地址）。

### 2.6 当前监听与 DSH 绑定

```
LocalAddress                                LocalPort  Proc
::                                              135     svchost
::                                              445     System
::                                           5357     System
::                                           7680     svchost
::                                           7897     verge-mihomo
2409:8a20:4cad:ba20:d2c0:3d53:7540:763c      18085     node
127.0.0.1                                   40596     DeepSeek Harness
::                                          49664..   lsass/wininit/spoolsv/services
```

判读：
- **DSH 只监听 `127.0.0.1:40596`（纯 IPv4 回环）**，v6 侧无监听 ⇒ **现在不可能被公网 v6 直连**。
- 有一个 node 进程监听在**具体公网 v6 字面量**`:18085`。其命令行：`node.exe C:\Users\GWL\Desktop\itwillclaude\.tmp\v6test.cjs`，PID 23192。这是别人（或早前会话）留下的临时测试进程——**它本身是「Node 能绑公网 v6 字面量」的活证据**，同时也提醒：这类测试端口要记得关。
- ⚠️ **`verge-mihomo` 在 `::`（所有 v6 接口）上监听 7897**（Clash 混合代理端口），`System` 在 `::` 上监听 445/5357、`svchost` 监听 135/7680。这些是**潜在暴露面**：如果任何一条防火墙规则（含程序级 Any 端口规则）覆盖到它们，公网 v6 就能直接摸到 SMB/RPC/代理端口。本机目前的 `node.exe` / `deepseek harness.exe` 通配规则**不覆盖** mihomo/System，但「程序级 Any 端口」这种规则形态本身很危险（见 §5.5）。

### 2.7 本机 v6 自连测试（只读，`net.connect`）

```js
net.connect({host:'2409:8a20:4cad:ba20:d2c0:3d53:7540:763c', port:18085})
// → CONNECT_OK local=2409:8a20:4cad:ba20:d2c0:3d53:7540:763c remote=2409:8a20:4cad:ba20:d2c0:3d53:7540:763c
```

判读：本机 IPv6 协议栈、地址可用性、`listen`/`connect` 到具体公网 v6 字面量全部正常。
**注意：这只证明"本机到本机"通，不能证明公网可达**——这正是 §4 要把「外网可达」单独列为 `unknown` 的原因。

### 2.8 与 v6 无关但会影响判定的本机事实

- `Get-NetAdapter` 只有 `WLAN 3` 处于 Up（以太网/蓝牙断开），**没有 TUN 虚拟网卡** ⇒ mihomo 是「系统代理」模式而非 TUN 模式，因此**不会拦入站**；但若用户以后开 TUN，需重新评估。
- 系统代理开着（7897）不影响入站，但会影响插件里任何「出网自证」的探测逻辑（可能被代理改写结果）——自检设计里必须显式禁用代理（见 §4.4）。

---

## 3. DSH 侧绑定可行性

### 3.1 结论

**允许，且是官方设计支持的用法。** `dsh-host-webserver` 的 `host` 接受**具体 IPv4/IPv6 地址字面量**（含公网 v6），显式拒绝通配地址；不接受主机名。

- `host: '2409:8a20:4cad:ba20:d2c0:3d53:7540:763c'`（或在 URL 里写 `[2409:...]`）→ **可行**
- `host: '::'` / `'::0'` / `'0.0.0.0'` → **加载期即拒绝**（`isWildcardHost`）
- `host: '::1'` → 合法，但仍是回环，只服务本机
- `host: 'myhost.local'`（主机名）→ **拒绝**（不是字面量）
- 带 `%zone`（如 `fe80::1%22`）：`listen` 接受（zone 是本地接口选择器），但 `bindUrlHost()` 对**非回环的带 zone 地址返回 `undefined`**，即日志/URL 里表达不出来；公网地址不要带 zone。

### 3.2 依据（`app.asar` 只读检索，均为原文摘录）

检索方式：`node -e` 读 `app.asar` 字节流按子串定位（未解包、未写盘），命中 `dsh-host-webserver` 的 `bind-address` 模块与其文档段。

1）绑定地址解析与报错原文：

```js
const notLiteralError = (value) =>
  new Error(`webserver: host ${JSON.stringify(value)} is not a concrete IPv4 or IPv6 address literal`)
// parseIpLiteral: isIP(host) === 0 → undefined（非字面量直接拒）
//                 支持 %zone，mapped v4 归一为 v4
```

2）通配检测（`0.0.0.0` / `::` 一律拒）：

```js
function isWildcardAddress(parsed) { /* 所有分段为 0 */ }
function isWildcardHost(host) { const p = parseIpLiteral(host); return p !== undefined && isWildcardAddress(p) }
```

3）官方文档段原文（中文版，asar 内既有中英双份）：

> `host` 接受本机某个接口的一个具体 IPv4 或 IPv6 字面量——例如容器自身来自 `hostname -i` 的 Pod 地址。回环字面量（127/8 内的任意地址、`::1`，或二者的 mapped 形式）把服务器留在本机；**其他任何字面量都会在该地址所属网络上提供 HTTP，除非设置 `tls`，否则为明文**。未指定地址——包括 Linux 视为 IPv4 any 的 IPv4-mapped 形式——**会在加载时被拒绝**，而不是一次性打开每个网络接口的端口。

> `bindUrlHost(host)` 把该文本写成 URL host（**IPv6 加方括号**），对 URL 无法携带的**非回环带 zone 地址返回 `undefined`**。

> 导出的 `isLoopbackHost(host)` 与 `isWildcardHost(host)` 按解析后的地址值分类，因此 mapped 或带 zone 的写法会按其指名的地址分类。

4）请求侧信任围栏（决定「平板直连 v6 字面量能不能进 /api」）——`api-request-trust` 原文：

> 认证之前，每个请求都经过 `src/api-request-trust.ts`。其 `Host` 必须是 **loopback、等于监听器的绑定 IP 字面量（端口不限）、或与 `trustedHosts` 条目匹配**：带端口的 `host:port` 精确匹配，不带端口的条目匹配任意端口。……附带的 HTTP(S) `Origin` 必须指向同一 authority……**`sec-fetch-site: cross-site` 一律拒绝**。……一次失败的 Host/Origin 检查返回 **403**，而受信任但未认证的请求返回 **401**。

5）`isLoopbackHostname` 的判定集合（说明 `[::1]` 被当作 loopback，公网 v6 不在此列）：

```js
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.'); return parts.length === 4 && parts[0] === '127' && /* … */
}
```

### 3.3 落地要点（给实现方）

1. **绑具体公网 v6 字面量是官方路径**，不需要打补丁，也不需要 `0.0.0.0`。插件「禁止绑 `0.0.0.0`、必须绑具体地址」的策略与宿主约束**完全一致**，可直接沿用。
2. **平板用 `http://[<v6>]:<port>/` 直连字面量时，不需要配 `trustedHosts`**——因为「Host 等于监听器的绑定 IP 字面量（端口不限）」已经通过围栏。这条很重要：少一个配置面，少一个失败点。
3. **只有在想用域名/DDNS 访问时才必须加 `connection.trustedHosts`**，且必须写 `host:port` 或 `host`（不带端口=任意端口）。畸形条目会让插件加载失败。
4. `sec-fetch-site: cross-site` 一律 403 ⇒ 从**别的网页**里 fetch DSH 会被拒，这是好事（防 CSRF）；从地址栏直连是 `none`/`same-origin`，不受影响。
5. 非回环绑定默认是**明文 HTTP**，除非设 `tls`。DSH 不会因为你绑了公网地址就自动加密——这是 §5 的第一条硬要求。
6. `getOrigin()` 在绑定前或非回环带 zone 情况下会抛错/返回 `undefined`，插件拼 URL 要自己用 `[addr]:port` 兜底。

---

## 4. 自检设计（返回结构 + 判定规则 + 文案）

### 4.1 目标与铁律

- **纯 Node、零外部依赖**（只用 `node:os`/`node:net`/`node:child_process`/`node:fs`），能在插件进程里跑，无需 root。
- **只读**：不 `listen`、不写网络配置、不改防火墙；唯一的副写是插件自己 state 目录里记「上次看到的地址」（可关）。
- **绝不假阳性**：任何「本机无法证明」的项一律 `unknown`，并且 `unknown` **不允许**让整体结论升级为 `ok`。
- 每个 check 必须带一句**人话** + 一句**下一步怎么做**。

### 4.2 返回结构

```ts
type Level = 'ok' | 'warn' | 'fail' | 'unknown'

interface ProbeCheck {
  id: string                 // 稳定 id，前端/i18n 靠它查文案
  title: string              // 短标题，中文
  level: Level
  message: string            // 结论一句话（已完成判定的描述）
  hint?: string              // 下一步做什么（人类可执行）
  evidence?: Record<string, unknown>  // 原始证据（地址、命令输出摘要、端口…），不放大段文本
  blocking: boolean          // 是否参与「决定能否直连」的硬判定
}

interface ProbeResult {
  ok: boolean                // level === 'ok' || level === 'warn' 之外的语义见 4.3
  level: Level               // 最严重档位（见 4.3 聚合规则）
  verdict: 'direct-ok' | 'needs-router-allow' | 'needs-external-check' | 'not-supported'
  summary: string            // 一句话总述（给 UI 顶部横幅）
  host: string | null        // 探测到的候选绑定地址（稳定地址优先）
  port: number | null
  url: string | null         // 建议给平板填的 URL，v6 自动加方括号
  checks: ProbeCheck[]
  generatedAt: string        // ISO
  durationMs: number
}
```

**枚举取值**（建议固定，避免文案漂移）：
- `id`：`v6-global` / `v6-stable` / `v6-routable` / `v6-route` / `bind-self-connect` / `listener-port` / `dsh-bound-v6` / `firewall-inbound` / `external-reachability` / `url-form`
- `verdict`：`direct-ok`（全部 ok/warn 且有外网实证）/ `needs-router-allow`（本机 ok 但外网未通）/ `needs-external-check`（本机未知或无外网实证）/ `not-supported`（本机根本没全局 v6）

### 4.3 聚合规则（关键：不放过假阳性）

```
if 任一 blocking check === 'fail'      → level='fail',      ok=false
else if 任一 blocking check === 'unknown' → level='warn',   ok=false   // 诚实：未知≠通过
else if 任一 check === 'warn'          → level='warn',      ok= (verdict 决定)
else                                   → level='ok',        ok=true
```

- `blocking` 只给这几项：`v6-global`、`v6-routable`、`dsh-bound-v6`、`firewall-inbound`。
- `external-reachability` 在**没有外网实证来源**时永远 `unknown`，且**不进 blocking**（否则本机永远只能 fail），但它会**压制 verdict**：只要它不是 `ok`，`verdict` 就不能是 `direct-ok`。
- 也就是说：**「本机全绿」最多得出 `needs-external-check` 或 `needs-router-allow`，永远得不出「已可公网直连」。** 这是本设计的核心不变量。

### 4.4 各 check 的判定规则与文案

| # | id | 判定规则（可执行） | 失败/警示文案 | hint（人类下一步） |
|---|---|---|---|---|
| 1 | `v6-global` | `os.networkInterfaces()` 取 `family==='IPv6'` 且 `!internal`；排除 `fe80::/10`（link-local，注意要按前缀而非字符串 startsWith('fe80')）、排除 `fc00::/7`（ULA）、排除 `::ffff:0:0/96`（mapped v4）、排除 `::1`。剩空 ⇒ `fail` | fail：「本机没有拿到任何全局 IPv6 地址，公网 v6 直连不成立。」 | 「请在路由器打开 IPv6/双栈，或联系宽带客服开通 IPv6。」 |
| 2 | `v6-stable` | Windows：解析 `netsh interface ipv6 show addresses`，`Addr Type` 为 `Temporary` 的剔除；非 Windows 或命令失败 ⇒ `unknown`（不猜）。若只剩临时地址 ⇒ `fail`；若稳定地址存在但**当前要绑的地址是临时地址** ⇒ `fail` + 明确指路 | fail：「你选的地址是**临时隐私地址**，它约每小时会变，外网连接会突然断。请改用不带『临时』的 `<stable>`。」 | 「复制 `netsh interface ipv6 show addresses` 里标注 `Public` 的那个地址。」 |
| 3 | `v6-routable` | 前缀判定：必须在 `2000::/3` 内；额外**排除/降级**：`2001:db8::/32`（文档，fail）、`2002::/16` 6to4（fail，入站不可用）、`2001::/32` Teredo（fail）、`64:ff9b::/96` NAT64（fail，无入站）、`100::/64` 丢弃前缀（fail）；`2000::/3` 内其它 ⇒ `ok` | fail：「`<addr>` 不在公网可路由单播范围内（属于文档/隧道/NAT64 前缀），不能用于入站直连。」 | 「这是运营商给的临时隧道地址，不是真双栈。请联系宽带确认已是原生 IPv6 双栈。」 |
| 4 | `v6-route` | Windows 读 `route print -6` 或 `Get-NetRoute -AddressFamily IPv6`：存在 `::/0` 且 Gateway 非 `::` ⇒ `ok`；无默认路由 ⇒ `warn`（有地址但出不去） | warn：「有 v6 地址但没有默认 v6 路由，说明前缀没真正启用。」 | 「重启路由器或重新拨号，让 RA 正常下发。」 |
| 5 | `bind-self-connect` | `net.connect({host, port})`，超时 2s：`connect` ⇒ `ok`；`ECONNREFUSED` ⇒ `warn`（地址是本机的，但没人监听该端口）；`EADDRNOTAVAIL`/`ENETUNREACH`/`EHOSTUNREACH` ⇒ `fail`（地址已不属于本机/不可用） | 见各分支 | 「ECONNREFUSED：地址没问题，是 DSH 没绑这个端口/地址。」 |
| 6 | `listener-port` | 交叉验证：同一 `port` 上 `127.0.0.1` 能连、`[v6]` 连不上 ⇒ 说明**只绑了回环 v4**；两者都通 ⇒ 正常；都不通 ⇒ DSH 未启动 | warn：「DSH 只监听 127.0.0.1（<port>），外面连不到。请在插件里把它绑到 `<v6>`。」 | 「把绑定地址从 127.0.0.1 改成 `<v6>`（DSH 允许具体 v6 字面量，见文档 §3）。」 |
| 7 | `dsh-bound-v6` | 读 `Get-NetTCPConnection -State Listen`（Windows）找 `LocalAddress === host && LocalPort === port` ⇒ `ok`；找不到 ⇒ `fail`；无 PowerShell ⇒ 退化为 `bind-self-connect` 的结果 | fail：「监听表里没有 `<host>:<port>`，DSH 没绑到该 v6 地址。」 | 同 #6 |
| 8 | `firewall-inbound` | Windows：① `Get-NetFirewallProfile` → 任一 Profile `Enabled && DefaultInboundAction==='Block'`（或 `NotConfigured`，Windows 默认 Block）；② `Get-NetFirewallRule -Direction Inbound -Enabled True -Action Allow` 再 `Get-NetFirewallPortFilter`/`Get-NetFirewallApplicationFilter`，判断是否有规则覆盖「该端口」或「DSH 进程路径」，且 Profile 含当前网络类型。命中 ⇒ `ok`；**明确无覆盖 ⇒ `warn`（不是 fail，因为第三方防火墙/规则语义复杂）**；命令不可用/权限不足/非 Windows ⇒ `unknown` | ok：「已找到入站放行规则：`<程序或端口>`（Profile: `<…>`）。」warn：「Windows 防火墙默认阻止入站，未找到覆盖 `<port>` 的放行规则。」unknown：「无法读取防火墙状态（缺少 PowerShell 或权限不足），请自行确认。」 | warn →「在 `wf.msc` 新增入站规则：程序=`<dsh.exe>`、端口=`<port>`、Profile 至少含『公用』。」 |
| 9 | `external-reachability` | **只有两种诚实结局**：<br>a) 调用方显式传入外部回探源（如 `https://<your-echo>/?probe=`）并禁用代理（`no_proxy`/直连 socket），拿到回显里含本机 v6 与端口 ⇒ `ok`；<br>b) 没有外部源 ⇒ **固定 `unknown`**，文案「本机无法自证公网可达」，**禁止**用「本机自连成功」冒充。 | unknown：「本机无法自证公网可达。下面这些都不代表外网能连：本机能连自己、地址是公网段、防火墙已放行。」 | 「请用平板在**蜂窝数据**下打开 `http://[<v6>]:<port>/`；能打开才算通过。打不开请检查路由器 IPv6 防火墙入站规则。」 |
| 10 | `url-form` | 拼 `http://[v6]:port/`；地址含 `%` ⇒ `warn`（带 zone 无法进 URL）；IPv4 ⇒ 不加括号 | warn：「该地址带 `%接口序号`，不能写进外网 URL。」 | 「用不带 `%` 的全局地址。」 |

### 4.5 参考实现骨架（纯 Node，可直接改进插件）

```js
'use strict'
const os = require('node:os')
const net = require('node:net')
const { execFile } = require('node:child_process')

const T = (ms) => new Promise((r) => setTimeout(r, ms))
const run = (cmd, args, timeout = 4000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 1 << 20 },
    (err, stdout) => resolve(err ? null : String(stdout)))
})

// ---------- IPv6 前缀工具（不依赖 ipaddr） ----------
function expand(a) {                       // '2409:8a20::1' -> 16 字节数组
  let s = a
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/)
  if (v4) { const p = v4[1].split('.').map(Number)
    s = s.slice(0, -v4[1].length) + ((p[0] << 8 | p[1]).toString(16)) + ':' + ((p[2] << 8 | p[3]).toString(16)) }
  const [head, tail] = s.split('::')
  const h = head ? head.split(':') : []
  const t = tail ? tail.split(':') : []
  const mid = new Array(Math.max(0, 8 - h.length - t.length)).fill('0')
  return [...h, ...mid, ...t].map((x) => parseInt(x || '0', 16))
}
function inPrefix(addr, prefix, len) {
  const a = expand(addr), p = expand(prefix)
  for (let i = 0; i < 16; i++) {
    const bits = Math.min(8, Math.max(0, len - i * 8))
    const mask = bits === 0 ? 0 : (0xff << (8 - bits)) & 0xff
    if ((a[i] & mask) !== (p[i] & mask)) return false
  }
  return true
}
const isLinkLocal = (a) => inPrefix(a, 'fe80::', 10)
const isULA       = (a) => inPrefix(a, 'fc00::', 7)
const isV4Mapped  = (a) => inPrefix(a, '::ffff:0:0', 96)
const isGlobalUnicast = (a) => inPrefix(a, '2000::', 3)

const BAD_PREFIXES = [
  ['2001:db8::', 32, '文档示例前缀，不能用于生产'],
  ['2002::', 16, '6to4 隧道地址，无稳定入站'],
  ['2001::', 32, 'Teredo 隧道地址，无稳定入站'],
  ['64:ff9b::', 96, 'NAT64 翻译前缀，无入站'],
  ['100::', 64, '丢弃前缀（RFC 6666）']
]

// ---------- 采集 ----------
async function collectAddresses() {
  const out = []
  for (const [iface, list] of Object.entries(os.networkInterfaces())) {
    for (const e of list || []) {
      if (e.family !== 'IPv6' && e.family !== 6) continue
      const bare = e.address.split('%')[0]
      if (e.internal || bare === '::1' || isLinkLocal(bare) || isULA(bare) || isV4Mapped(bare)) continue
      out.push({ iface, address: bare, raw: e.address, cidr: e.cidr, scopeid: e.scopeid })
    }
  }
  return out
}

async function temporarySet() {          // Windows only → Set<addr>；否则 null
  if (process.platform !== 'win32') return null
  const txt = await run('netsh', ['interface', 'ipv6', 'show', 'addresses'])
  if (!txt) return null
  const tmp = new Set()
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*Temporary\s+\S+\s+\S+\s+\S+\s+([0-9a-f:]+)/i)
    if (m) tmp.add(m[1].toLowerCase())
  }
  return tmp
}

function probeTcp(host, port, timeout = 2000) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port })
    const done = (r) => { try { s.destroy() } catch {} ; resolve(r) }
    s.setTimeout(timeout, () => done({ state: 'timeout' }))
    s.once('connect', () => done({ state: 'open' }))
    s.once('error', (e) => done({ state: 'error', code: e.code }))
  })
}

async function firewallInbound(port, dshExe) {
  if (process.platform !== 'win32') return { level: 'unknown', message: '非 Windows，无法判定防火墙' }
  const prof = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-NetFirewallProfile | Select-Object Name,Enabled,DefaultInboundAction | ConvertTo-Json -Compress'])
  if (!prof) return { level: 'unknown', message: '无法读取防火墙配置（PowerShell 不可用或权限不足）' }
  let blocksByDefault = true
  try {
    const ps = JSON.parse(prof)
    const arr = Array.isArray(ps) ? ps : [ps]
    blocksByDefault = arr.some((p) => p.Enabled && (p.DefaultInboundAction === 'Block' || p.DefaultInboundAction === 'NotConfigured'))
  } catch { /* 解析失败按默认 Block 处理 */ }

  const rules = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-NetFirewallRule -Direction Inbound -Enabled True -Action Allow -ErrorAction SilentlyContinue | ' +
    'ForEach-Object { $r=$_; $pf=$r|Get-NetFirewallPortFilter; $af=$r|Get-NetFirewallApplicationFilter; ' +
    '[pscustomobject]@{n=$r.DisplayName;p=[string]$r.Profile;tcp=$pf.Protocol;lp=($pf.LocalPort -join ",");pg=$af.Program} } | ConvertTo-Json -Compress'], 8000)
  if (!rules) return { level: 'unknown', message: '无法读取入站规则列表' }

  const list = (() => { try { const j = JSON.parse(rules); return Array.isArray(j) ? j : [j] } catch { return [] } })()
  const hit = list.find((r) => {
    if (!/tcp|any/i.test(String(r.tcp))) return false
    const portOk = String(r.lp).toLowerCase().includes('any') || String(r.lp).split(',').includes(String(port))
    const progOk = r.pg && dshExe && String(r.pg).toLowerCase() === String(dshExe).toLowerCase()
    const profOk = /public|any/i.test(String(r.p))
    return (portOk || progOk) && profOk
  })
  if (hit) return { level: 'ok', message: `已找到入站放行规则：${hit.n}`, evidence: { rule: hit.n, profile: hit.p, ports: hit.lp, program: hit.pg } }
  return { level: 'warn', message: blocksByDefault ? 'Windows 防火墙默认阻止入站，且未找到覆盖该端口的放行规则' : '未找到明确的入站放行规则', hint: '在 wf.msc 中为 DSH 程序或端口新增入站允许规则（Profile 至少包含「公用」）' }
}

// ---------- 主探测 ----------
async function probe({ port, preferredHost, externalProbeUrl } = {}) {
  const t0 = Date.now()
  const checks = []
  const add = (c) => { checks.push({ blocking: false, ...c }); return c }

  const addrs = await collectAddresses()
  if (!addrs.length) {
    add({ id: 'v6-global', title: '全局 IPv6 地址', level: 'fail', blocking: true,
      message: '本机没有拿到任何全局 IPv6 地址，公网 v6 直连不成立。',
      hint: '请在路由器打开 IPv6/双栈，或联系宽带客服开通 IPv6。' })
    return finish()
  }
  add({ id: 'v6-global', title: '全局 IPv6 地址', level: 'ok', blocking: true,
    message: `找到 ${addrs.length} 个全局 IPv6 地址。`, evidence: { addresses: addrs.map((a) => a.address) } })

  // 稳定性
  const tmp = await temporarySet()
  let chosen = preferredHost && addrs.some((a) => a.address.toLowerCase() === preferredHost.toLowerCase())
    ? addrs.find((a) => a.address.toLowerCase() === preferredHost.toLowerCase())
    : addrs[0]
  if (tmp) {
    const stable = addrs.filter((a) => !tmp.has(a.address.toLowerCase()))
    if (!stable.length) add({ id: 'v6-stable', title: '地址稳定性', level: 'fail', blocking: true,
      message: '只有临时隐私地址，没有稳定地址；临时地址约每小时轮换，外网会突然失联。',
      hint: '在 Windows 网络适配器里确认已启用稳定地址（或关闭临时地址优先），再重试。' })
    else if (tmp.has(chosen.address.toLowerCase())) add({ id: 'v6-stable', title: '地址稳定性', level: 'fail', blocking: true,
      message: `你选的地址是临时隐私地址，会轮换。请改用稳定地址 ${stable[0].address}。`,
      hint: `把绑定地址改成 ${stable[0].address}` })
    else { chosen = stable.find((a) => a.address === chosen.address) || stable[0]
      add({ id: 'v6-stable', title: '地址稳定性', level: 'ok', message: `使用稳定地址 ${chosen.address}。` }) }
  } else {
    add({ id: 'v6-stable', title: '地址稳定性', level: 'unknown',
      message: '无法区分临时/稳定地址（非 Windows 或 netsh 不可用），请人工确认不要用临时地址。' })
  }

  // 可路由性
  const bad = BAD_PREFIXES.find(([p, l]) => inPrefix(chosen.address, p, l))
  if (!isGlobalUnicast(chosen.address) || bad) {
    add({ id: 'v6-routable', title: '公网可路由性', level: 'fail', blocking: true,
      message: bad ? `${chosen.address} 属于${bad[2]}，不能用于入站直连。` : `${chosen.address} 不在 2000::/3 公网单播范围内。`,
      hint: '需要运营商原生 IPv6 双栈，而不是隧道/NAT64 地址。' })
  } else {
    add({ id: 'v6-routable', title: '公网可路由性', level: 'ok',
      message: `${chosen.address} 属于 2000::/3 公网单播范围。`, evidence: { prefix: chosen.cidr } })
  }

  if (!port) { add({ id: 'listener-port', title: '监听端口', level: 'warn', blocking: false,
    message: '未提供端口，跳过监听探测。', hint: '在插件配置里设置固定 port（不要用 0）。' }) }
  else {
    const self = await probeTcp(chosen.address, port)
    if (self.state === 'open') add({ id: 'bind-self-connect', title: '本机自连', level: 'ok', blocking: true,
      message: `能连上 ${chosen.address}:${port}（本机自连）。` })
    else if (self.state === 'error' && self.code === 'ECONNREFUSED') add({ id: 'bind-self-connect', title: '本机自连', level: 'warn', blocking: true,
      message: `${chosen.address} 是本机地址，但没人监听 ${port} 端口。`,
      hint: `把 DSH 的绑定地址从 127.0.0.1 改成 ${chosen.address}，端口 ${port}。` })
    else add({ id: 'bind-self-connect', title: '本机自连', level: 'fail', blocking: true,
      message: `连接 ${chosen.address}:${port} 失败（${self.code || self.state}），该地址可能已不属于本机。`,
      hint: '请重新获取当前地址（IP 可能已变化）。' })

    const loop4 = await probeTcp('127.0.0.1', port)
    if (loop4.state === 'open' && self.state !== 'open') add({ id: 'dsh-bound-v6', title: 'DSH 绑定', level: 'fail', blocking: true,
      message: `DSH 只监听 127.0.0.1:${port}，外网连不到。`, hint: `在插件里把 host 改成 ${chosen.address}（DSH 支持具体 v6 字面量）。` })
    else if (self.state === 'open') add({ id: 'dsh-bound-v6', title: 'DSH 绑定', level: 'ok', blocking: true,
      message: `监听已覆盖 ${chosen.address}:${port}。` })

    add({ ...(await firewallInbound(port, process.execPath)), id: 'firewall-inbound', title: 'Windows 防火墙入站', blocking: true })
  }

  // 外网可达：只有外部回探才算 ok
  if (externalProbeUrl) {
    /* 由调用方提供外部 echo，直连 socket 或禁用代理后比对回显里的地址 */
    add({ id: 'external-reachability', title: '外网可达性', level: 'unknown',
      message: '已配置外部回探源，但本次未执行（需实现方补齐回显比对）。' })
  } else {
    add({ id: 'external-reachability', title: '外网可达性', level: 'unknown',
      message: '本机无法自证公网可达：本机能连自己、地址是公网段、防火墙已放行，都不等于外网能连。',
      hint: `请用平板在蜂窝数据下打开 http://[${chosen.address}]:${port || '<port>'}/ ；打不开请检查路由器 IPv6 防火墙入站规则。` })
  }

  add({ id: 'url-form', title: '平板填写格式', level: 'ok',
    message: `平板应填 http://[${chosen.address}]:${port || '<port>'}/` })

  return finish()

  function finish() {
    const blockingFails = checks.some((c) => c.blocking && c.level === 'fail')
    const unknown = checks.some((c) => c.level === 'unknown')
    const warn = checks.some((c) => c.level === 'warn')
    const level = blockingFails ? 'fail' : unknown ? 'warn' : warn ? 'warn' : 'ok'
    const ext = checks.find((c) => c.id === 'external-reachability')
    const verdict = level === 'fail' ? 'not-supported'
      : ext && ext.level === 'ok' ? 'direct-ok'
      : checks.some((c) => c.blocking && c.level === 'warn') ? 'needs-router-allow'
      : 'needs-external-check'
    return {
      ok: level === 'ok', level, verdict,
      summary: level === 'fail' ? '本机条件不满足，公网 v6 直连不可用。'
        : verdict === 'direct-ok' ? '全部检查通过，公网 v6 直连可用。'
        : '本机条件基本就绪，但必须从外网实测一次才能确认。',
      host: chosen.address, port: port || null,
      url: `http://[${chosen.address}]${port ? ':' + port : ''}/`,
      checks, generatedAt: new Date().toISOString(), durationMs: Date.now() - t0
    }
  }
}
```

### 4.6 文案分层建议

- **不要**把 `netsh` 的 `Public`/`Temporary` 直接丢给用户（英文术语 + 语义反直觉）。统一改称「稳定地址 / 临时地址」。
- 每条 `fail` 的 `hint` 必须是**一个动作**（去哪个界面、填什么值），不要写「请检查网络配置」。
- `unknown` 的文案必须**明确说「我们不知道」**，并给出人工验证路径；不要用「可能正常」这种半吊子措辞。
- 顶部横幅只显示 `summary` + `verdict`，把 10 条 check 折叠在「详情」里，避免劝退。

---

## 5. 安全硬要求

公网 v6 没有 NAT 兜底：**地址一旦可达，全世界都能扫到**（`2409::/16` 的活跃段很小，扫描成本远低于 IPv4 全空间）。以下为「不满足就别上线」级别。

1. **必须 TLS，或者干脆不要暴露明文 HTTP。**
   `dsh-host-webserver` 绑非回环地址时默认是**明文 HTTP**（原文：「其他任何字面量都会在该地址所属网络上提供 HTTP，除非设置 `tls`」）。在热点/咖啡厅 WiFi 或运营商链路上，明文意味着你的 **DSH token、会话内容、会话标题**全部可被抓。要求：配 `tls`（自签 + 平板信任），或前置一个带证书的反代；**不接受「反正没人知道我的 v6 地址」当加密**。

2. **Token 必须是高强度、可吊销、有限速的。**
   暴露到公网后 401 会变成日常（扫描器每秒钟试）。要求：≥32 字节随机（CSPRNG），不入日志、不进 URL 查询串（URL 会进浏览器历史/Referer），失败计数 + 指数退避（或直接按源前缀临时封禁）。**不要用短 PIN / 可猜的设备名当唯一凭据。**

3. **收敛暴露面：只暴露 DSH 那一个端口。**
   本机实测在 `::` 上监听的还有 `135/445/5357/7680`（System/svchost）与 `7897`（verge-mihomo 代理）。要求：① 确认没有任何入站规则覆盖这些端口（尤其**别给 mihomo 7897 放行**，那等于开一个公网开放代理）；② 不要把「程序级 + LocalPort=Any」的防火墙规则当成安全措施（本机 node.exe 与 DeepSeek Harness.exe 现在就是这种 Any 端口放行，端口一开就是全开）；③ 关掉 Wi-Fi Direct / 蓝牙网络连接等无用适配器上的监听。

4. **绝不绑临时地址；绑稳定地址，并接受「前缀会变」。**
   绑临时地址（`Temporary`，约 1h 轮换）会导致外网连接周期性失败，运维上会被误判成「网络不稳定」。同时注意 v6 地址后缀是**设备标识**，EUI-64 后缀会泄露网卡 MAC；建议在 Windows 上确认使用稳定隐私地址（stable-privacy）而非 EUI-64，并注意「稳定」与「隐私」在这里的取舍：稳定是为了可访问，隐私是为了不泄露标识——**不要为了隐私用临时地址去做绑定**。

5. **上线前必须做一次「从外部真的打一次」的验收，并把结论写进配置。**
   因为本机无法自证可达（§4.4 #9），要求：至少从蜂窝网络访问一次并留下证据（时间、源前缀、结果）；同时确认「公网能连」与「局域网能连」不冲突（同前缀下平板在家也应走同一地址）。**任何未经外网实测就标成「已验证」的状态字段，都是安全事故的种子。**

> 补充（本机特有）：`verge-mihomo` 正在跑，且系统代理指向 7897。若将来开启 TUN 模式，入站路径会被接管，届时必须重新评估——本报告的所有结论都基于「TUN 未启用」（`Get-NetAdapter` 无 TUN 网卡，已确认）。

---

## 6. 未验证 / 需用户操作

### 6.1 本次未做（按规矩没做）

- 未修改任何网络配置（未动 `netsh`、未改适配器属性）。
- 未新增/修改/删除任何防火墙规则（只做了 `Get-NetFirewallRule`/`Get-NetFirewallProfile` 读取）。
- 未改仓库源码（只读了 `app.asar` 字节流与 `dsh-sync-suite\docs`、`~\.dsh\cordis.patch.yml`）。
- 未启动/停止/重启 DSH，未改 DSH 绑定（因此「绑 v6 后是否真的能对外服务」没有实测——这是设计上刻意留给你决策的，不是遗漏）。
- 未清理 PID 23192（`node .tmp\v6test.cjs`，监听公网 v6:18085）。**建议尽快关掉**：一个测试端口长期挂在公网地址上没意义。

### 6.2 必须由用户/外部网络验证的（本机永远测不出来）

| # | 待验证项 | 怎么验 | 不验的后果 |
|---|---|---|---|
| V1 | 路由器 IPv6 防火墙是否放行入站 | 登录路由器加允许规则后，用平板蜂窝访问 `http://[2409:8a20:4cad:ba20:d2c0:3d53:7540:763c]:<port>/` | 本机全绿但外网连不上，误判为「DSH 有问题」 |
| V2 | 运营商是否拦截该端口入站 | 同上，换 80/443 与高位端口各测一次 | 高位端口也可能的被 ACL 丢，需实测而非推断 |
| V3 | 平板（蜂窝/热点）是否真有公网 v6 | 平板访问 `test-ipv6.com`，**关 WiFi 用蜂窝** | 平板只有 v4 时这条方案整体不成立，得换中继 |
| V4 | 前缀/地址的长期稳定性 | 隔天、重启光猫后各记录一次地址 | 地址变了导致书签失效，用户以为「插件坏了」 |
| V5 | DSH 绑非回环后的认证强度 | 绑上后用外部设备访问，看是否强制 401 挑战、token 是否足够强 | 401 存在≠认证可靠，需实测挑战流程 |
| V6 | 是否有第三方安全软件额外防火墙 | 看托盘（火绒/360/Defender for Endpoint） | Windows 防火墙放行了，第三方仍拦 |

### 6.3 给实现方的三条落地建议

1. **先做只读探测，再暴露一个「如何放行路由器」的图文指引**——本机侧（DSH 绑定、Windows 防火墙）在本机已经全部就绪，真正的失败点在上游，产品体验应该把用户直接引导到「路由器 IPv6 防火墙」这一步，而不是让他反复重启 DSH。
2. `verdict` 不要出现含糊值；`needs-external-check` 是**正常且诚实**的终态，UI 应该把它呈现成「还差一步：去外面测一下」，而不是「失败」。
3. 把「稳定地址 vs 临时地址」做成显式选择器（列出所有全局 v6，标注稳定/临时，默认选稳定），从源头消灭最高频的坑。
