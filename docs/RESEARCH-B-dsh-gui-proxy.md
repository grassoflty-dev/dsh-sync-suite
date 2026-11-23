# B. 桌面 DSH GUI 反向代理可行性（读 DSH 源码 + 本机只读探针）

> 只读对象：`C:\Users\GWL\AppData\Local\Programs\DeepSeek Harness\resources\app.asar`（**是一个 209 MB 的 asar 文件，不是解包目录**；
> 条目路径形如 `dsh/node_modules/@deepseek-ai/<包>/src/...`，数据区起点 = `8 + u32@4`）。
> 本文所有 `file:line` 均来自该 asar 内的条目；插件侧路径相对 `dsh-sync-suite/`。
> 抽取脚本：`.tmp/asar.mjs`（list / cat / grep / dump / extract，只读）。
> 探针：`.tmp/probe-fence.cjs`（只发请求、只记状态码，不带任何凭据）。
> asar 内 `dsh/package.json`：`@deepseek-ai/dsh-desktop` 0.2.2-rc.3，`dshBuildCommit` `6b729fedde0c8fd03af7afdf5a711aa64fe87c3b`。

---

## 0 结论（每条一句）

1. **令牌怎么发**：Cordis 服务 `connection`（`HostConnectionService`）持有一个 `BrowserAuth`；launch token 是**进程内随机 32 字节 base64url**，缓存在模块级 `WeakMap`（键 = 进程 owner `ctx.root`），只通过 `authenticatedUrl(baseUrl)` 以 `?token=<43 字符>` 形式给出（`dsh-client-connection/src/browser-auth.ts:22,61-67,244-248`；`dsh web` 打印它：`dsh-web-app/src/index.ts:227-231`）。**不落盘、不可从文件读**。
2. **令牌怎么验**：唯一的兑换口是 `GET /` 且**恰好一个** `token` 查询参数 → `303 Location: ./` + `Set-Cookie: dsh-auth-<b64url(sha256(authority))>=v1.<b64url>.<b64url>`；其它任何未认证请求一律 401，正文固定为
   `dsh web authentication required; reopen the URL printed by dsh web.`（`browser-auth.ts:263-305`、`:385-393`）。
   cookie 用**持久** 32 字节 HMAC 密钥签名（凭据库记录 `client-connection/browser-session`），payload 必须未过期且 `authority` 与本次请求的 authority 逐字相等（`:14,182-199,371-383,116-118`）。
3. **插件拿得到**：`connection` 是**无作用域限制的普通服务**，`inject: ['connection']` + `ctx.connection`（或 `ctx.get('connection')`）即可，`HostConnectionHandle` 里公开 `authenticatedUrl(baseUrl): string`（`rpc-host.ts:62-67,92,197-200`；`rpc.ts:268-273`）。
   **不要**走第二条路：自己 `import '@deepseek-ai/dsh-client-connection'` 再 `BrowserAuth.create(...)`，得到的是**另一个** `PROCESS_LAUNCH_TOKENS` WeakMap ⇒ 另一个 token ⇒ 静默 401。
4. **资产 / WS / SSE 能干净代理**：GUI 发出的每个浏览器 URL 都是**相对**的（index 渲染时注入 `<base href="./">`，`dsh-host-frontend-static/src/index.ts:164`；构建产物 `index.html` 全为 `./assets/…`；RPC 用 `api/<endpoint>`，`client-connection/src/client/rpc.ts:46-57`；WS 按 `document.baseURI` 解析，`client/socket.ts:56-65`）。
   实时通道是**一条 WebSocket `/api/remote.mux`**；SSE 只出现在 `/plugins/events`。⇒ **不能用"只代理 HTTP"的方案**；WS 必须能升级。
5. **既有实现（必须如实记录）**：插件 HEAD **已经**是"旁挂 HTTPS + 反向代理 + WS 裸字节隧道"（`src/remote/listener.ts`，`https.createServer` @`:795`，转发 @`:886-951`，升级 @`:958-1089`），并且**已经**用第 3 条的办法换上游身份（`src/remote/service.ts:277-306`，`fetch(..., { redirect: 'manual' })` 取 `dsh-auth-*`，只在内存里缓存 12 小时、随进程到期刷新），只把上游 cookie 当**请求头**交给上游（`src/remote/routes.ts:238-239`），下游响应一律剥 `set-cookie`（`listener.ts:344-361`）。
   ⇒ 本模块**不是"新建代理"**，而是"补两个缺口 + 补测试"。缺口见 §5：`Origin` 未改写（实测 403）、普通转发无有界超时/无 typed 上游错误。

---

## 1 令牌的生命周期（证据表）

| 事实 | 证据 |
| --- | --- |
| token 形状 = `base64url(randomBytes(32))`（43 字符） | `browser-auth.ts:16,64,47-52` |
| 每进程一份，键是进程 owner 对象（`ctx.root`），只 get/set，无轮换 | `browser-auth.ts:22,61-67`；`cordis/src/context.ts:71-83` |
| 拼进 URL 的唯一入口 | `browser-auth.ts:244-248` |
| 兑换口要求 `GET` + `pathname === '/'` + `token` 只出现一次 | `browser-auth.ts:263-289` |
| 兑换结果 = 303 + `Set-Cookie`（`Max-Age`、`Path=/`、`HttpOnly`、`SameSite=Strict`，TLS 监听才加 `Secure`） | `browser-auth.ts:131-140,279-288` |
| cookie 名 = `dsh-auth-` + `b64url(sha256(authority))` | `browser-auth.ts:116-118` |
| authority = 明文 http 时 `url.host`，https 时 `url.origin` | `browser-auth.ts:79-88` |
| 校验：HMAC 签名 + 未过期 + 非未来签发 + 跨度不超过上限 + authority 逐字相等 | `browser-auth.ts:371-383` |
| 签名密钥持久化在凭据库（不是 token） | `browser-auth.ts:182-199,14` |
| cookie 默认寿命 30 天 | `client-connection/src/index.ts:106-107,115,130` |

**推论**：令牌只在内存里，任何"从文件读 token"的方案都不成立；但**服务方法**能拿到它，且这是 DSH 自己打印给用户的那一个 URL。

## 2 三条可选的身份路径

1. **`ctx.connection.authenticatedUrl()`（采用）**：DSH 的公开服务方法，语义就是"把本进程 owner 令牌拼到给定基址上"。我们用它完成一次**本机登录**，cookie 留在桌面侧内存里。`dsh-web-app` 自己就是这么打印 URL 的（`dsh-web-app/src/index.ts:228`），插件调用同一个方法不构成越权。
2. **自己 `import` 包再 `BrowserAuth.create()`（否决）**：模块实例按 URL 解析，插件侧与宿主侧不是同一份（profile 里另有副本、`dsh-dots` 是 junction 且无 `node_modules`）⇒ 另一个 WeakMap ⇒ 另一个 token ⇒ 静默 401。
3. **读凭据库自签 cookie（否决）**：`readRecord` 是纯内存读、`modifyRecord` 会改盘，技术上能拿到可签任意 authority 的**长期** HMAC 密钥。这不仅多余（1 已够），还把插件的权限从"本进程一次令牌"放大到"可伪造任何 authority 的 owner 会话"。不采用。

## 3 代理面的形状（决定能不能"零改写"）

- 路由：`webServer` 精确匹配 → 最长前缀 → fallback（`dsh-host-webserver/src/index.ts:445-452,650-664,534-538`）；**upgrade 只按 pathname 精确匹配，没命中直接销毁 socket**（`:584-617`）。
- `authorizeIndex` 的兑换要求 `pathname === '/'`（`browser-auth.ts:269`）：**根挂载时天然满足**，带前缀就必须 strip。
- index 注入 `<base href="./">`（`dsh-host-frontend-static/src/index.ts:164`）：挂载点必须能以**尾斜杠**形式暴露，否则相对资源会逃出前缀。
- 资产：chunked + gzip + 弱 ETag + `no-cache`，**无 Range、无 SPA fallback**（404）。
- `/api` 与 `/connect` 才过"信任栅栏"（Host / `sec-fetch-site` / Origin），index 交换不过（`api-request-trust.ts:121-151`）。

## 4 实测：DSH 信任栅栏（本机 `127.0.0.1:36569`，只读，仅状态码）

| # | 请求 | 结果 | 含义 |
| --- | --- | --- | --- |
| A | `GET /api/state`，`Host: 127.0.0.1:36569`，无 Origin | **401** `unauthorized` | 栅栏通过，只是未认证 |
| B | 同上 + `Origin: https://192.168.1.6:3081` | **403** `forbidden` | **平板经代理转发时的真实形态**：Host 已改写、Origin 仍是外部 authority ⇒ 直接 403 |
| C | 同上 + `Origin: http://127.0.0.1:36569` | **401** | Origin 与 Host 同 authority 时栅栏通过 |
| D | 同上 + `sec-fetch-site: cross-site` | **403** | 显式跨站直接拒 |
| E | `GET /` 无 cookie | **401** + `dsh web authentication required…` | index 需要会话 |
| F | `GET /` 且 `Host: 192.168.1.6:36569` | 401 同 E | index 不做 Host 栅栏 |

⇒ 与 `api-request-trust.ts:141-151,160-176` 的读码结论一致：**Host 改写到回环即可过 Host 栅栏，但 Origin 必须同时被改成上游 authority（或省略），否则 `/api` 与 WS 全部 403。**

## 5 缺口与决策

- **G1（功能阻断，已实测）**：`listener.ts` 的 `outboundHeaders()` 把 `host` 改写成上游 authority（`out.host = target.hostHeader`），却**原样转发 `origin`**。平板浏览器对 `POST /api` 与 WS 握手都会带 `Origin: https://<平板看到的 authority>` ⇒ 表 B 的 403。修法（已实现，`rewriteSameOrigin()`）：仅当入站 `Origin` 的 authority 与入站 `Host` 相同（即确实是本监听自己的同源请求）时，把 `origin` 改写成 `http://<上游 hostHeader>`；否则**原样保留**，让 DSH 自己拒（不替它放宽）。
- **G2（要求项）**：普通转发路径没有上游超时（只有升级握手有 15 s，见 `listener.ts` 的 `runUpgrade`），上游挂死时平板只能一直等；上游拒绝连接时回的是固定明文 `remote upstream unavailable`，没有 typed 码。修法（已实现）：三条独立预算（连接 5 s / 响应头 15 s / 空闲 120 s，`text/event-stream` 不受空闲预算约束）+ 五个 typed 上游错误（`E_UPSTREAM_DOWN` 502、`E_UPSTREAM_TIMEOUT` 504、`E_UPSTREAM_STALLED` 504、`E_UPSTREAM_PROTOCOL` 502、`E_UPSTREAM_SESSION` 401）+ 隧道上限 `E_UPGRADE_TUNNELS_FULL` 503；正文只含码与中文下一步，不含任何凭据。
- **G3（要求项）**：补齐验收测试：401 透传、200 透传、请求头改写、升级拒绝、上游不可达 ⇒ typed 错误；其中一个假上游要**照抄 DSH 的栅栏规则**（Host 必须是回环、Origin 必须等于 Host authority、cookie 必须是注入的那一个），这样测试证明的是"能过 DSH 的栅栏"，而不是"我们发了某个字符串"。
- **决策：根挂载，不用 `/gui/` 前缀。** 理由：① `<base href="./">` + 全相对 URL ⇒ 根挂载零改写；② 兑换口要求 `pathname === '/'`；③ DSH 的 upgrade 路由是精确 pathname，前缀必须在 HTTP 与升级两条路上同步 strip，多一类 bug；④ 平板本来就存 host/port 且"加载一个路径"，`/` 就是一个路径，**不需要新字段**。插件自己的命名空间仍独占 `/__dsh_remote/*`（`routes.ts:69,212-218`），不会与 DSH 的路径撞车。

## 6 已考虑并否决的替代方案

1. **原生 `dsh --profile web --host <LAN-IP>`（CLI 可行的"正道"，但对桌面应用无效）**：`--host/--port/--public-url/--trusted-host/--tls-cert/--tls-key`（`dsh-web-app/src/startup.ts:59-82`）；只拒**通配地址**（`:95-97`），具体网卡字面量是文档化行为（`dsh-host-webserver/src/index.ts:96-108`）；非回环明文绑定只告警（`dsh-web-app/src/index.ts:197-199`）。但**桌面壳把 `--host 127.0.0.1 --port 0` 写死**（asar `dsh/desktop-host` 内 `--host 127.0.0.1 --port 0`），token 经 IPC 交给 Electron 由它自己兑换并持有 cookie ⇒ **桌面应用正在跑的这份 GUI 没有任何受支持的对外暴露方式**。这不是"插件更优雅"，而是"别的路对这份进程不存在"。
2. **`@deepseek-ai/dsh-experimental-liveshare`（否决）**：README 原文——分享经过**独立部署的 Liveshare 服务器**，其 "OAuth, database, routing, and deployment implementation are not part of this package"，且默认关闭、需 patch/`dsh.profile.bundles` 启用。= 必须自建中继 + OAuth + 数据库，与"平板不要网关/中继"直接冲突。
3. **读凭据库自签 cookie（否决）**：见 §2.3。
4. **`publicUrl` 单用（否决）**：只改"公告出去的地址"，不建监听、不改路由/鉴权（`dsh-web-app/src/index.ts:65-73,204`）⇒ 只会得到一个打不开的链接。
5. **`dsh-api-remote-access`（不是远程访问）**：它是非 owner Peer 的**方法级授权**注册表，包里没有 server/listen/tunnel/relay（`dsh-api-remote-access/src/index.ts:1-8,153-166`）。
6. **平板侧实现 Typert Remote Peer（长期正道，本轮不做）**：官方远程面 = API Gateway 的 `@Remote` 方法 + `remote-access` 的 non-owner Peer 策略（`ctx.remote.*`）。要在平板上用它，等于在 ArkTS 里实现一个 Typert Remote **客户端/Peer**（握手、Peer 身份、方法级授权、错误模型），是一个独立项目，不是开关；记录在此以免以后被重新发现一遍。
7. **裸端口转发（不足）**：GUI 强制认证（`?token=` 兑换 `dsh-auth-*` cookie；token 每进程随机、签名密钥持久化），裸转发只会把 401 原样送给平板。
8. **版本核对**：装机 `@deepseek-ai/dsh` **0.2.2-rc.5**；最新预发布 **0.2.3-alpha.2**（2026-11-22 发布）在该问题上无变化——`dsh-experimental-liveshare@0.2.3-alpha.2` 的 README 仍要求"独立部署的 Liveshare 服务器 + OAuth/数据库/路由，不属于本包"，0.2.3-alpha.1 的升级说明只动 Node 版本。⇒ 没有"免中继的官方远程控制 API"可用。

## 7 风险与未验证边界

- **`set-cookie` 一律剥离**（`listener.ts:344-361`）：这是有意的安全边界——owner cookie 绝不下行；但 GUI 若把任何偏好靠在 cookie 里，经代理会丢。**未验证**（读码未见 GUI 依赖自身 cookie 做持久化，主要走 localStorage）。
- **回环判定带来的 UI 差异**：上游看到 `Host: 127.0.0.1:<port>`，某些"仅本机可做"的设置项在平板侧可能隐藏或降级（`client-connection/src/client/index.ts:274` 一带）。**未验证**。
- **深链 / `dsh-app://` / 系统目录选择器**等在浏览器侧不可用（`dsh-host-directory-picker-native` 之类）。**未验证**。
- **未做真机与端到端页面加载**：本轮只做单测 + 本机栅栏探针；"平板能看到设置页并点得动"必须由 Lead 在真机断言。
- **版本敏感**：`browser-auth.ts` 的实现（token 语义、cookie 名、兑换口）是本方案的地基；升级 DSH 后须重读该文件再复用本结论。
