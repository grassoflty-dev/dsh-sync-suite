# A. @feiyang666/dsh-mobile-remote v2.0.1 源码对照

只读对象：`C:\Users\GWL\.dsh\profiles\web\node_modules\@feiyang666\dsh-mobile-remote\`
版本：2.0.1（`package.json` `"version": "2.0.1"`，`lib/*.js` 为编译产物，但均为可读 ESM/IIFE，注释保留）。
本文所有行号均来自上述目录下的真实文件，未读到的写「未验证」。

---

## 0. 结论（每条一句）

1. **抄** `lib/lanproxy.js` 全篇：`createLanProxy()` 就是「同端口不同地址再 listen 一份 + 反代到回环」的完整可用实现。
2. **抄** 它的 WS 隧道手法：`handleUpgrade` 用 `net.connect` 手写请求行做**原始字节双向管道**，不解析 HTTP、不用 `http-proxy`，天然支持 `/api/remote.mux`。
3. **改** 监听地址发现：`getLanAddresses()` 只用 `os.networkInterfaces()` 过滤 IPv4/非 internal/非 169.254，**不排除 docker/vEther**，我们必须补名字黑名单。
4. **改** 令牌模型：它自己的密码门（`password.js`）不是 LAN 门，而是「外网 https 门」；LAN 侧边车**完全不鉴权**，靠把 Host/Origin 改写成回环骗过 DSH 信任围栏（`lanproxy.js:96-100`）。
5. **丢** `GET /` 自动登录（`index.js:357-412`）：它把 DSH 的 `?token=` 302 自动补给任何裸地址访问者，等于 LAN 免认证，与「本机回环免认证、LAN 必须令牌」直接冲突。
6. **丢** `lib/external.js` 整篇（frpc 二进制下载、`https://api.deepseekharness.desktop.cwj666.top` 中转、30s 公网探测、keep-alive 心跳），本项目不写内网穿透。
7. **丢** 设备遥测（`handleHeartbeat` + client 设备面板）：上报 UA/屏幕/电池/网络，远超本项目所需。
8. **抄** `lib/qrcode.js`（Kazuhiko Arase, 2009, MIT, 标准 QR Model 2 + RS 纠错，零依赖单文件 56.7KB），直接放进 `src/remote/qrcode.ts`。
9. **改** 令牌生成：它用 `randomBytes(24).base64url`（`password.js:175-177`），硬约束要求 `randomBytes(32)`；口令比较它有 `timingSafeEqual`（`password.js:97`），token 比较是 Map 查表。
10. **抄** 设置页注册方式 `slots.register({ id:'remote-control', order:40, label:'远程控制' })`（`client.js:1079-1089`），字段集需重做（见 §5）。

---

## 1. 旁挂监听

### 1.1 用哪个 API 起 HTTP server

**自建 `node:http` Server**，不碰 DSH 的监听：

```js
// lib/lanproxy.js:17-18
import http from 'node:http'
import net from 'node:net'

// lib/lanproxy.js:155-176  listenOne()
const server = http.createServer(handleRequest)
server.on('upgrade', handleUpgrade)
...
server.keepAliveTimeout = 65_000
server.headersTimeout = 70_000
server.listen(port, host)      // host = 单块网卡 IPv4 字面量
```

- **绑什么地址**：`start(lanHosts, port)` 逐个 `listen(port, host)`（`lanproxy.js:174`），`host` 来自调用方传入的局域网 IPv4 列表；**没有任何通配地址分支**（全仓库 `0.0.0.0` 只出现在注释里，见 `lanproxy.js:4`、`patch.js:5,228,298`、`index.js:18,20,336,1092`、`client.js:551`，无一处 `listen('0.0.0.0')`）。
- **同端口不同地址**是核心技巧：宿主在 `127.0.0.1:P`，插件在 `192.168.x.y:P`，两处监听互不冲突（`lanproxy.js:9-10` 注释）。
- **端口来源**：`ctx.webServer.port`（`index.js:252`），**用户不可选**；端口变化时 15s 轮询跟随并重绑（`index.js:493-506`）。

### 1.2 局域网 IPv4 探测

```js
// lib/index.js:569-582
function getLanAddresses() {
  const out = []
  for (const entries of Object.values(networkInterfaces() ?? {})) {
    for (const iface of entries ?? []) {
      if (iface.family !== 'IPv4' || iface.internal) continue
      if (String(iface.address).startsWith('169.254.')) continue
      if (!out.includes(iface.address)) out.push(iface.address)
    }
  }
  const score = (ip) => (/^192\.168\./.test(ip) ? 3 : /^10\./.test(ip) ? 2 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 1 : 0)
  return out.sort((a, b) => score(b) - score(a))
}
```

- 用 `os.networkInterfaces()`；**排除项只有** `internal`（回环）与 `169.254.*`（APIPA）。
- **不排除 docker0 / vEthernet / VMware / VirtualBox / Tailscale**——这是明确缺口，我们必须加网卡名黑名单（`/^(docker|veth|br-|virbr|vEthernet|VMware|VirtualBox|tailscale|zt)/i`）。
- 排序：`192.168` > `10.` > `172.16-31` > 其它（`index.js:580`）。
- 另有 `getLanInterfaces()`（`index.js:610-627`）返回 name/address/netmask/mac/cidr/internal，仅用于**展示**，不参与选址。

### 1.3 端口冲突处理

- 逐 host 尝试，单个 host 失败只记进 `failures`，不整体失败：
  ```js
  // lib/lanproxy.js:215-221
  for (const host of wanted) {
    try { opened.push({ server: await listenOne(host, port), host }) }
    catch (error) { failures.push({ host, error: String((error && error.message) || error) }) }
  }
  ```
- `skipHosts`：宿主自己已绑的地址要跳过，否则 `EADDRINUSE`（`lanproxy.js:188-189`，`index.js:1107-1110`）。
- **不做端口漂移**（不 fallback 到 0/随机端口），失败就是失败，`opened.length===0` 时 `log('lan proxy: no listener could bind', failures)`（`lanproxy.js:232`）。
- `generation` 递增防竞态：启动途中被 `stop()` 抢先则废弃本次结果并关掉已开的 server（`lanproxy.js:208-228`）。
- 重复 `start()` 且参数相同则直接复用（`lanproxy.js:201-206`）。

### 1.4 IPv6

- **监听不参与**：`getLanAddresses()` 只返回 IPv4，`listenOne` 只收到 IPv4 字面量。
- 仅 URL 拼接留了 IPv6 兼容：`authorityOf()` 给含 `:` 的 host 加方括号（`index.js:603-608`），`isLoopbackHost()` 认 `::1`/`::ffff:127.0.0.1`（`patch.js:142-145`）。
- 结论：IPv6 既不监听也不生成 URL（只会出现在"宿主自己 --host ::1"这类边界判断里）。

---

## 2. 鉴权与令牌门

### 2.1 是否绕过了 `webServer.register`

**两层，两套答案：**

| 路径 | 是否走 `ctx.webServer.register` |
| --- | --- |
| LAN 侧边车（`192.168.x.y:P`） | **完全绕过**。自建 `http.Server`，只做字节反代（`lanproxy.js:86-152`） |
| 插件自己的 API `/__dsh_remote/*` | 走 `register`（`index.js:292-308`，`kind:'exact'`） |
| 首页 `GET /` | 也走 `register`，并且**临时注销自己**再内部 HTTP 回环取官方 index（`index.js:319-355`） |

### 2.2 侧边车鉴权链怎么补的 —— 它**没有补**

它不拿 `ctx.connection.requestRejection`，也不做任何请求级校验，而是**主动把请求"伪装成回环"**，让 DSH 自己的信任围栏放行：

```js
// lib/lanproxy.js:93-100（HTTP）
const authority = loopbackAuthority(port)          // "127.0.0.1:3080"
const headers = { ...req.headers }
const realHost = headers.host || ''
headers.host = authority
if (headers.origin) headers.origin = rewriteOrigin(headers.origin, authority)   // 保留协议
headers['x-forwarded-for'] = forwardedFor(headers, req.socket)
headers['x-forwarded-proto'] = 'http'
if (realHost) headers['x-forwarded-host'] = realHost
```

- 同一套改写也用于 upgrade（`lanproxy.js:126-133`）。
- 注释直言目的：「dsh 的 Host/Origin 信任围栏对回环一律放行，于是**局域网访问不需要任何 patch 改动**」（`lanproxy.js:11-12`）。
- 真实客户端 IP 通过 `X-Forwarded-For` 传回（`lanproxy.js:42-48`），因此 DSH 侧看到的是手机 IP，但**信任判断已被降级**。
- 唯一"补偿"是控制面里的密码门（§2.3），但它按 `isRemoteRequest()` 判定，LAN http **不算远程**，所以 LAN 侧门是开着的（`index.js:830-835`、`850-854`）。
- **对我们的含义**：侧边车必须自己实现 token 校验（在 `handleRequest`/`handleUpgrade` 入口，校验 `?token=`/header/cookie，回环来源免认证）。照抄 Host 改写是必要的（否则 DSH 会拒），但**不能**照抄后面的 `GET /` 自动登录。

### 2.3 令牌门（`lib/password.js`，全部 Node 内置 crypto）

- **生成**：`randomBytes(24).toString('base64url')`（`password.js:175-177`）——**不是 32 字节**，硬约束要求改 `randomBytes(32)`。
- **口令存储**：`scrypt(password, salt, 32, {N:16384, r:8, p:1})`，盐 `randomBytes(16).hex`，只存 `pwdHash`+`pwdSalt` 到 `~/.dsh/plugins/dsh-mobile-remote/config.json`（`password.js:23-31,34-37,73-77,120-123`）。
- **文件权限**：`mkdirSync(recursive)` + `writeFileSync(file, json, 'utf8')`，**未指定 mode、未 chmod**（`password.js:60-63`）→ 依赖系统默认（Windows 无 mode 概念；POSIX 需补 `{mode:0o600}`）。
- **比较**：口令 `timingSafeEqual`（`password.js:97`，长度不等先 return false）；**会话 token 不是常量时间比较**，是 `Map.get` 查表 + 过期判断（`password.js:204-213`）。
- **取值位置**：仅 **Cookie** `__dsh_remote_auth`（`index.js:821,853`），`Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`，远程时加 `; Secure`（`index.js:918`）。**不支持** `?token=` 也不支持 header。
- **会话存活**：纯内存 `Map<token, expiry>`，TTL 24h（`password.js:40,167,199`）；改密/清密即 `sessions.clear()`（`password.js:114,126`）；进程重启全失效。
- **失败限速**：按 IP（`clientIpFromReq`，优先 `x-forwarded-for` 首段，`index.js:806-814`），`MAX_ATTEMPTS=8` → 锁 `10 分钟`（`password.js:43-44,226-241`）。**缺陷**：`count` 只增不减，锁过期后下一次失败立刻再锁（`registerFailure` 从不做时间衰减），且只对 `login()` 生效。
- **日志打码**：全仓 grep 后，日志里没有 token 明文（唯一提到 token 的日志在 `index.js:346`，只说"取不到"）。但 `/__dsh_remote/status` 的响应体带 `url`/`lanUrls`（内嵌 DSH 的 `?token=`，`index.js:1231-1233`）——即 token 明文进 JSON，只发给已在本机的设置页。
- **本机回环是否免认证**：**是**，`authorized()` 先判 `isRemoteRequest()`，非远程直接 `return true`（`index.js:850-854`）。
- **改密码/清密码只许本机**：`isRemoteRequest()` 为真直接 403 `LOCAL_ONLY`，且已有密码时必须带 `currentPassword` 校验（`index.js:945-973`），长度 4–128。

> **对本项目的关键差异**：它的门是「外网 https 才拦」，我们要的是「LAN 也拦、回环才免」。可以直接复用 `scrypt + timingSafeEqual + Map 会话 + 按 IP 锁定` 的骨架，但判定函数要换成「来源是否回环」。

---

## 3. WebSocket 反代

**手写，`net.connect` 原始字节隧道，零依赖**（不用 `http.request`、不用 `http-proxy`）。

```js
// lib/lanproxy.js:123-152
function handleUpgrade(req, socket, head) {
  const port = targetPortOf()
  if (!port) { try { socket.destroy() } catch {} return }
  const authority = loopbackAuthority(port)
  const headers = { ...req.headers }
  headers.host = authority
  if (headers.origin) headers.origin = rewriteOrigin(headers.origin, authority)
  headers['x-forwarded-for'] = forwardedFor(headers, req.socket)
  headers['x-forwarded-proto'] = 'http'
  if (headers.host) headers['x-forwarded-host'] = headers.host

  const upstream = net.connect(port, upstreamHost, () => {
    const lines = [`${req.method || 'GET'} ${req.url || '/'} HTTP/1.1`]
    for (const [key, value] of Object.entries(headers)) {
      if (value === undefined) continue
      if (Array.isArray(value)) for (const item of value) lines.push(`${key}: ${item}`)
      else lines.push(`${key}: ${value}`)
    }
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (head && head.length) upstream.write(head)
    upstream.pipe(socket)     // 上游 → 客户端（含 101 响应、后续帧）
    socket.pipe(upstream)     // 客户端 → 上游
  })
  upstream.on('error', () => { try { socket.destroy() } catch {} })
  socket.on('error', () => { try { upstream.destroy() } catch {} })
}
```

要点：

- **不做 upgrade 头白名单/改写**：`sec-websocket-key`、`sec-websocket-protocol`、`sec-websocket-version`、`upgrade`、`connection` 全部原样透传（`for (const [key,value] of Object.entries(headers))`），只覆盖 `host`/`origin`，追加 `x-forwarded-*`。**这正是支持 `/api/remote.mux` 的关键**——它不关心路径，任何 Upgrade 都隧道化。
- **`101` 响应回写**：不解析、不 writeHead，纯粹 `upstream.pipe(socket)`，101 状态行和头随字节流一起回给浏览器。所以不需要处理 `res.writeHead(101)` 与 `socket` 抢写的经典问题。
- **双向 piping / 背压**：靠 `Readable.pipe(Writable)` 自带背压；没有手写 `drain` 逻辑。
- **`head` 处理**：`server.on('upgrade')` 的第三参数（客户端在请求头之后立刻发来的帧）显式 `upstream.write(head)`（`lanproxy.js:143`），这个细节容易漏。
- **连接计数**：**无**。没有 `Set<socket>`、没有 `maxConnections`、没有连接数上限。
- **超时**：全局只有 `keepAliveTimeout=65s` / `headersTimeout=70s`（`lanproxy.js:168-169`，注释说明是为了不误杀 SSE/WS）；upgrade 隧道**没有 idle 超时**，也没有 `socket.setTimeout`。
- **错误处理**：单向 destroy 对端，不重试、不记连接级日志（只 `log('lan proxy upgrade error', error)`，`lanproxy.js:148`）。
- **兼容上游不是回环**：`upstreamHost` 可指向宿主真正绑的网卡 IP（`lanproxy.js:67,190`），`index.js:1099-1121` 的 `enableRemote` 在 `direct` 形态下把 `upstreamHost=bind.host` 并 `skipHosts:[bind.host]`。

---

## 4. 二维码

- **不是依赖，是内联源码**：`lib/qrcode.js`（56,719 字节，2,300 行），`package.json` 的 `dependencies` 只有 `ws`。
- 来源与许可（`lib/qrcode.js:1-16`）：
  ```
  // QR Code Generator for JavaScript
  // Copyright (c) 2009 Kazuhiko Arase
  // URL: http://www.d-project.com/
  // Licensed under the MIT license
  ```
  即经典 `qrcode-generator`（福田式标准 QR Model 2）的 MIT 单文件版。
- 算法：标准 QR Model 2，含 RS 纠错块表 `RS_BLOCK_TABLE`（`qrcode.js:1253`，按 `(typeNumber-1)*4 + level` 索引，`qrcode.js:1514-1520`），支持 typeNumber 1–40 与 L/M/Q/H（`qrcode.js:24-29` 注释）。
- 导出：`module.exports = factory()` / `export default qrcode`（`qrcode.js:2292-2300`）。
- 调用点（`index.js:1383-1401`）：
  ```js
  const qr = qrcode(0, 'M')       // 0 = 自动选版本
  qr.addData(url, 'Byte')
  qr.make()
  const svg = qr.createSvgTag({ cellSize: 4, margin: 8, scalable: true })
  res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8' })
  ```
- **结论：可直接照抄的模块**。零依赖、MIT、纯 JS、产出 SVG（前端 `<img src="/.../qr?url=...">`，见 `client.js:358-362`）。唯一注意：它是 IIFE/UMD 风格，搬进 TS 项目要加分号或改成 ESM 导出（文件末尾已带 `export default`，说明作者已做过这层适配）。

---

## 5. 设置面（字段/默认值）

### 5.1 注册方式

```js
// lib/client.js:1073-1089
var inject = ['slots'];
slots.inject('settings.section', function () {
  return slots.register({ name: 'settings.section', id: 'remote-control', order: 40, label: '远程控制' }, function () { return el(RemoteControlPanel, null); })
})
```
包级声明 `package.json` → `dsh.bundle.patch = ./cordis.patch.yml`，`dsh.client = { platform: 'web', inject: ['@deepseek-ai/dsh-client-ui-conversation'] }`；`cordis.patch.yml:19-22` 插入 `{ id: dsh-mobile-remote, name: '@feiyang666/dsh-mobile-remote', inject: [webServer] }`。

### 5.2 字段表（全部来自 `lib/client.js`，数据来自 `GET /__dsh_remote/status`）

| UI 区块 | 字段 | 语义 | 默认值 / 备注 | 证据 |
| --- | --- | --- | --- | --- |
| 局域网 | 开关（role=switch） | `POST /toggle {enabled}`，即时生效不重启 | **默认关**：持久化键 `remoteEnabled`，`getSetting('remoteEnabled', false)` | `client.js:341-351`；`index.js:469`；`lanproxy`/`index.js:1124` |
| 局域网 | 状态徽标 | `未开启` / `已开启` / `已开启（直连）` | `remoteEnabled = bind.direct \|\| lan.running` | `client.js:334-339`；`index.js:1151` |
| 局域网 | 二维码 | `GET /__dsh_remote/qr?url=http://<lanIp>:<port>`（**裸地址**，不带 token） | 取 `lanAddresses[0]` | `client.js:353-370` |
| 局域网 | 当前连接设备 / 累计设备 | `deviceCount`、`totalDevicesEver` | 内存表，90s 无心跳过期 | `client.js:743-746`；`index.js:228,1227-1238` |
| 局域网 | 已连接设备列表 | 点击展开：IP/UA/OS/浏览器/屏幕/视口/DPR/内存/核心/电池/网络/页面/首见/心跳数 | 需注入心跳脚本 | `client.js:754-800`；`index.js:1341-1380` |
| 局域网 | IPv4 网卡卡片 | `lanInterfaces[]`：name/address/netmask/mac/cidr/internal | `N 个 IPv4` | `client.js:913-920`；`index.js:610-627` |
| 局域网 | 端口 | **不可编辑**，只展示宿主 `port` | 跟随 `ctx.webServer.port` | `index.js:1204-1205` |
| 局域网 | cliHint | 未开启时提示 | `remote control is off; toggle it in settings (no restart required)` | `index.js:1288-1290` |
| 密码门 | 状态 | `auth.enabled` / `requiredHere` / `authenticated` | 三者均由 `isRemoteRequest()&&isEnabled()` 推 | `index.js:1282-1287`；`client.js:625-640` |
| 密码门 | 新密码 / 确认密码 / 当前密码 | `POST /set-password`，4–128 位，仅本机 | 清除 = 传空密码 + currentPassword | `client.js:647-700`；`index.js:945-973` |
| 外网 | 绑定码 / 中转地址 / 开关 / 二维码 / 域名 / 隧道端口 / frpc 版本 / PID / 日志 | frpc 隧道 | `DEFAULT_SERVER_BASE='https://api.deepseekharness.desktop.cwj666.top'` | `client.js:376-522,937-960`；`external.js:33` |
| 外网 | WS 徽标 | `WS 实时推送` / `HTTP 兜底（退让模式）` / `WS 未连接` | `ws.available/connected/source` | `client.js:434-458`；`index.js:1269-1280` |
| 诊断 | 运行时卡片 | uptime/PID/CPU 型号与核数/loadavg/内存/RSS/heap/Node 版本 | `runtimeInfo()` | `index.js:633-664,1235` |
| 诊断 | DSH 应用态 | 版本/会话数/工作区/插件/模型 provider（后台 60s 缓存） | `collectDshInfo()` | `index.js:716-763,1241` |

### 5.3 相关 RPC 全表（`index.js:292-308`，均 `kind:'exact'`）

| 方法 | 路径 | 门 | 说明 |
| --- | --- | --- | --- |
| GET | `/__dsh_remote/status` | `authGate` | 大而全的状态快照 |
| POST | `/__dsh_remote/toggle` | `authGate` | 开关 LAN 听众 |
| POST | `/__dsh_remote/heartbeat` | `authGate` | 设备遥测上报 |
| GET | `/__dsh_remote/qr` | `authGate` | SVG 二维码 |
| POST | `/__dsh_remote/external/start` | `authGate` | 起 frpc |
| POST | `/__dsh_remote/external/stop` | `authGate` | 停 frpc |
| GET | `/__dsh_remote/external/log` | `authGate` | frpc 日志尾巴 |
| GET | `/__dsh_remote/events` | `authGate` | SSE `{"type":"changed"}` |
| GET | `/__dsh_remote/auth-status` | 无 | 密码门状态 + 服务摘要 |
| POST | `/__dsh_remote/auth` | 无 | 密码换 cookie |
| POST | `/__dsh_remote/logout` | 无 | 撤销 cookie |
| POST | `/__dsh_remote/set-password` | 无（仅本机） | 设/改/清密码 |
| GET | `/__dsh_remote/sw.js` | 无 | Service Worker（缓存 `/assets/*.js\|css`） |
| GET | `/` | 无（接管） | 裸地址自动登录 |

**未注册任何 MCP tool / agent tool**：全仓无 `ctx.tool` / `registerTool` 调用（grep 无命中）。也没有 CLI 子命令。

---

## 6. 依赖与许可

`package.json`：

```json
"dependencies": { "ws": "^8.18.0" },
"peerDependencies": { "@deepseek-ai/cordis": "^4.0.1" },
"engines": { "node": ">=18" },
"license": "MIT"
```

`optionalDependencies`：**无**。

| 依赖 | 用途 | 判定 |
| --- | --- | --- |
| `ws ^8.18.0` | **仅** `lib/ws-client.js` 用作连**中转服务器**的 WS 客户端（`ws-client.js:19-24`，缺失则 `wsAvailable()=false` 自动退让 HTTP 轮询）。反代 `/api/remote.mux` **不需要它**（那是 `net.connect` 字节隧道） | **可丢**（本项目不连中转） |
| `@deepseek-ai/cordis ^4.0.1`（peer） | 宿主框架 | 必需（我们也是 Cordis 插件） |
| `lib/qrcode.js`（内联，非 npm 依赖） | 二维码 | 必需；MIT，CopyRight 2009 Kazuhiko Arase，需在文件头保留许可声明 |
| 插件自身许可 | MIT，`Copyright (c) 2026 dsh-mobile-remote contributors`（`LICENSE:3`） | 照抄代码时按 MIT 保留归属即可 |

**运行时 Node 内置模块**：`http`、`net`、`os`、`fs`、`path`、`crypto`、`child_process`、`module`。零原生模块。

---

## 7. 必须丢弃的清单（含理由）

1. **`lib/external.js` 全篇（37KB）** —— frpc 隧道：`/api/tunnel/bind` 换配置（`external.js:181`）、`/api/tunnel/frpc` 下载二进制（`external.js:199-204`）、`spawnFrpc` 起子进程（`external.js:266-281`）、keep-alive 心跳（`external.js:682`）、30s 公网可达性探测（`external.js:834-843`）。理由：本项目「反向代理必须支持 WebSocket upgrade」= 用户自备 nginx/caddy，不写内网穿透面板，不引入第三方中转与外部二进制下载（供应链风险 + 出网行为）。
2. **`lib/ws-client.js` 全篇** —— 只服务上面的中转。理由：不连中转，`ws` 依赖可整个删掉。
3. **中转服务器默认地址 `https://api.deepseekharness.desktop.cwj666.top`**（`external.js:33`）—— 第三方域名，绝不能出现在我们的代码里。
4. **`GET /` 自动登录接管（`index.js:311-419`）** —— 它把 DSH 的 `?token=` 自动 302 给任何裸地址访问者（`index.js:368-387`）。理由：与「LAN 必须令牌、回环免认证」冲突；这是我们安全模型里最危险的一段。可保留的**思想**只有 `relativeTokenLocation()`（`index.js:119-131`，把带 token 的绝对地址降级为 `/?token=…` 以免反代跨协议 301 丢 token），若我们确实需要生成带 token 的分享链接可以借鉴。
5. **设备遥测 `handleHeartbeat`（`index.js:1341-1380`）+ 心跳注入脚本 + 设备面板（`client.js:754-800`）** —— 收集 UA/屏幕/视口/DPR/电池/网络/当前页面标题，属"设备面板"，本项目不需要（仅要"连接数"，可用 socket 计数替代，见 §8）。
6. **`lib/patch.js` 的 `writeManagedPatch`/`ensureTrustedAuthority`（`patch.js:237-286`）** —— 往 profile `cordis.patch.yml` 写 `connection.trustedHosts`，只为让"外网域名"过 Host/Origin 围栏。理由：不写别人 profile；且我们 LAN 场景靠 Host 改写成回环，本就不需要 trustedHosts。**可保留借鉴**：`migrateLegacyPatch()`/`stripLegacyExternalHostBlock()`（`patch.js:298-330`）—— 清理旧版遗留的 `webserver.host: 0.0.0.0|192.168.x` 块，是「任何会写 0.0.0.0 的路径」的解毒剂。
7. **Service Worker `/__dsh_remote/sw.js`（`index.js:979-1055`）** —— 首屏缓存加速，只对外网 https 有意义，且 `tapIndex` 注入新脚本会污染 index。理由：非核心，删除降风险。
8. **SSE `/__dsh_remote/events`（`index.js:868-881,236-244`）** —— 5s 轮询已够；可选，非必需。
9. **诊断卡片（`runtimeInfo()` / `collectDshInfo()`，`index.js:633-763`）** —— 采集 CPU/内存/会话/工作区/插件/模型清单。理由：超出"远程访问"职责，且 `pluginInventory`/`llm` 属敏感面。
10. **`direct`（`--host 网卡IP`）形态判定（`index.js:596-601,1099-1121`）** —— 它假设"宿主自己绑在网卡上"也算开启。理由：我们的口径是"插件自己开/关"，保留 `bindInfo()` 只用于取端口与回环判断，不把 `direct` 当"已开启"。

**关于遥测上报**：没有独立 analytics/上报端点（对 `lib/*.js` grep `telemetry|sentry|analytics|report(` 零命中）；README 的 "Rich telemetry"（`README.md:31`）指**本机内存里的设备详情展示**，不是联网上报。全部出网行为集中在两处、都在我们要丢的范围内：`lib/external.js`（`/api/tunnel/bind`、`/api/tunnel/frpc` 下载、`/api/tunnel/ws`、30s 公网 `httpProbe`）与 `lib/index.js:1064-1086` 的 `queryServerStatus()`（HTTP fetch 中转 `/api/tunnel/stats|status`，60s 节流）。另外确认：全仓**没有** `ctx.tool` / `registerTool` / `.command(` 调用，未注册任何 tool 或 CLI 子命令。

---

## 8. 照抄代码骨架建议（函数名 + 行为契约）

建议目录 `src/remote/`（TS，编译到 `dist/remote/`）。以下 6 个函数直接搬，2 个改造，2 个新写。

### 直接搬（改 import 语句与类型标注即可）

```ts
// src/remote/lan-proxy.ts  —— 源自 lib/lanproxy.js（1:1 移植）
export function createLanProxy(options?: { log?: (msg: string, err?: unknown) => void }): {
  start(hosts: string[], port: number, opts?: { upstreamHost?: string; skipHosts?: string[] }):
    Promise<{ running: boolean; hosts: string[]; port: number; upstream: string; failures: Array<{ host: string; error: string }> }>
  stop(): Promise<{ running: boolean; hosts: string[]; port: number; upstream: string }>
  status(): { running: boolean; hosts: string[]; port: number; upstream: string }
}
```
契约（逐条对应原文，别改语义）：
- `listenOne(host, port)`：`http.createServer(handleRequest)` + `server.on('upgrade', handleUpgrade)` + `server.listen(port, host)`；`keepAliveTimeout=65_000`，`headersTimeout=70_000`；`once('error')`→cleanup+reject，`once('listening')`→resolve（`lanproxy.js:155-176`）。
- `handleRequest(req,res)`：改写 `host`→`127.0.0.1:<port>`、`origin`→同 authority 保留协议、追加 `x-forwarded-for`/`x-forwarded-proto`/`x-forwarded-host`；`http.request` 上游 → `res.writeHead(up.statusCode, up.headers)` + `up.pipe(res)`；端口未定回 503；上游错误回 502（`lanproxy.js:86-120`）。
- `handleUpgrade(req,socket,head)`：同样改写头；`net.connect(port, upstreamHost)` 手写请求行 + 头 + `head`；`upstream.pipe(socket)` 与 `socket.pipe(upstream)` 双向；`101` 与帧一律不解析（`lanproxy.js:123-152`）。
- `start()`：去重 + `skipHosts` 过滤 + `generation` 竞态保护 + 逐 host 容错（`lanproxy.js:187-240`）。
- `stop()`：`generation+=1`，清状态，`Promise.all(server.close())`（`lanproxy.js:243-255`）。

```ts
// src/remote/qrcode.ts —— 源自 lib/qrcode.js（整文件）
export default function qrcode(typeNumber: number, errorCorrectionLevel: 'L'|'M'|'Q'|'H'): {
  addData(data: string, mode?: string): void
  make(): void
  createSvgTag(opts: { cellSize?: number; margin?: number; scalable?: boolean }): string
}
```
- 必须保留文件头 MIT 声明（Kazuhiko Arase, 2009）。
- 用法固定：`qrcode(0,'M').addData(url,'Byte').make()` → `createSvgTag({cellSize:4,margin:8,scalable:true})`（`index.js:1392-1395`）。

```ts
// src/remote/password.ts —— 源自 lib/password.js（骨架照抄，判定改）
derive(password, salt): Buffer                     // scrypt N=16384 r=8 p=1 keylen=32   (password.js:73-77)
verifyPassword(password): boolean                  // timingSafeEqual, 长度不等先 false (password.js:89-101)
setPassword(password: string | null): { ok: boolean; enabled: boolean }  // randomBytes(16) salt, 只存 hash+salt (108-129)
login(password, clientIp): { ok: boolean; token?: string; error?: string } // 8 次失败锁 10min (185-201)
verifyToken(token): boolean                        // Map<token, expiry> + 过期删除 (204-213)
revokeToken(token): void; clearSessions(): void
```
**必须改 3 处**：① `issueToken()` 用 `randomBytes(32)`，不是 24；② 判定从 `isRemoteRequest()` 换成 `isLoopback(remoteAddress)`（回环免认证，其它一律要 token）；③ `registerFailure` 加时间衰减（原文 count 永不清零，锁过期即立刻再锁，`password.js:231-241`）。

### 改造后搬

```ts
// src/remote/lan-address.ts —— 源自 index.js:569-582
export function getLanAddresses(): string[]
```
- 在原有 `family!=='IPv4' || internal || 169.254.*` 过滤之上，**加网卡名黑名单**（docker/veth/br-/virbr/vEthernet/VMware/VirtualBox/tailscale/zt）；保留私有网段优先级排序；保留第一项作为二维码地址。

```ts
// src/remote/token-gate.ts —— 新写，替代 lanproxy 里的"无门"
export function createTokenGate(opts: { token: string; isLoopback(ip: string): boolean }): {
  allow(req, remoteAddress): boolean       // 回环→true；否则 ?token= / x-dsh-remote-token / cookie 任一匹配→true
  authFailure(ip): void                    // 简单按 IP 计数 + 冷却
}
```
- 用 `timingSafeEqual` 比较（token 定长 32 字节 hex，可直接比 Buffer）。
- **挂在 `handleRequest` 与 `handleUpgrade` 的最前面**（`lanproxy.js:86` 与 `:123` 入口），失败回 401/直接 `socket.destroy()`；日志只打 `ip` 与原因，**永不打 token**。

### 新写

```ts
// src/remote/connection-count.ts
export function createConnCounter(): { track(socket): void; count(): number }
```
- 在 `handleUpgrade` 的 `socket` 上 `on('close'|'error')` 递减；替代被丢的设备心跳遥测（我们要的"连接数"就这一个数字）。

```ts
// src/remote/plugin.ts  —— apply(ctx) 骨架
export const name = '...'
export const inject = ['webServer']
export function apply(ctx) {
  const port = ctx.webServer.port
  const lan = createLanProxy({ log })
  ctx.webServer.register({ kind: 'exact', path: '/__remote/status', handler })   // 见 index.js:292 的写法
  ctx.webServer.register({ kind: 'exact', path: '/__remote/toggle', handler })
  ctx.webServer.register({ kind: 'exact', path: '/__remote/qr', handler })
  // ctx.effect(...) 内注册 + 返回 disposer；卸载时 lan.stop()
}
```

---

## 9. 未验证项

1. **DSH 侧 `ctx.connection.requestRejection` / `webServer.register` 的确切签名**未读（`app.asar` 为归档，本任务只读插件侧）。因此 §2.2 只描述"插件如何绕过"，未校验 DSH 0.2.2-rc.3 的围栏实现是否真如注释所述对回环放行。
2. **`webServer.tapIndex` 之外是否有别的官方扩展点**未验证。
3. **`ctx.effect` 的清理时序**与 `register` disposer 是否保证在 `stop()` 之前执行——未在宿主侧验证。
4. **`os.networkInterfaces()` 在 Windows 上 `family` 是 `'IPv4'` 字符串**（Node ≥18 行为），插件按字符串比较（`index.js:574,615`）；Node 某些版本曾返回数字 `4`。项目锁定 Node 版本后需实测一次。
5. **`server.listen(port, '192.168.x.y')` 与宿主 `127.0.0.1:port` 同端口共存**：插件注释断言 Windows/Linux 都允许（`lanproxy.js:9`），本次未实机验证；若 Windows 上出现 `EADDRINUSE`，`failures[]` 会暴露。
6. **1000+ 并发下 `pipe` 双向背压**未压测；插件也没做连接上限，本项目的限流阈值需自定。
7. **`qrcode.js` 是否为 Kazuhiko Arase 原版的最新修订**未逐版本比对（仅凭文件头与 `RS_BLOCK_TABLE` 判断）。
8. **`README.md` 的 "Rich telemetry" 是否还有隐藏上报**：仅 grep 了 `lib/*.js` 的 `telemetry|上报|report`，未反编译 `.map`（目录内无 sourcemap）。
9. **`client.js` 是否在别的 slot 还注册了 UI**（如 `conversation.*`）未全量枚举，只确认 `settings.section` 一处（`client.js:1079-1089`）。
