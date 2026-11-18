# 远程访问域独立评审（只读）

> 评审对象：`packages/dsh-git-config-sync/src/remote/**`、`src/index.ts`、`src/rpc.ts` 的 `remote*` 面、
> `test/remote-*.test.mjs`、`test/client-remote-render.test.mjs`。
> 基线：分支 `main`，`git log -1` = `94d19d9`。对照口径：`docs/REMOTE-ACCESS-OPTIONS.md` §5、
> `docs/RESEARCH-A-mobile-remote.md` §7、本轮任务书里的五条硬约束。
> 评审方式：纯静态阅读（未启动监听、未改动任何源码/测试/dist），行号均为实际读取到的行号。
> 时间：2026-11-17。

## 0. 结论

**有条件通过**（无 P0：找不到"不带 token/cookie 就能拿到 `{kind:'allow'}`"的路径，也找不到令牌/上游 cookie 的自动外泄通道）。但只要 4 条必须改仍存在，就不能算兑现了 §5 的安全承诺：

| 编号 | 级别 | 一句话 | 定位 |
| --- | --- | --- | --- |
| **M1** | P1 | `ipv6` 方式**永远起不来**：service 放行 IPv6 字面量，listener 只接受具体 IPv4，必然 `E_LISTEN_FAILED` | `service.ts:191-199`、`listener.ts:197-207,672-678` |
| **M2** | P1 | 上游 `dsh-auth-*` cookie **过期后不 fail-closed**：routes 拿到的是不做 TTL 判断的闭包，过期 cookie 会被直送上游（声明是"拿不到就 503"） | `service.ts:260-266,305`、`routes.ts:230-236` |
| **M3** | P2（违反"唯一出口"） | `manualUrl` 里粘了 token 时，`remoteGetState → status.urls → client.js` 会把带 token 的地址**渲染进 DOM** | `urls.ts:313-314`、`service.ts:274-278`、`client.js:2904-2907,3275` |
| **M4** | P2 | `TOKEN_PARAM='k'` 与令牌门只认 `?token=`（`urls.withToken` 也写 `token`）矛盾，且测试把这个错值钉死了 | `auth.ts:20`、`routes.ts:177`、`urls.ts:341`、`remote-auth.test.mjs:386-391` |

建议改（不阻断，见 §9）：`Host` 头直通 `location`、`location` 恒降级 `http://`、`resetFailures` 从未被调用、`maskToken` 暴露 8 字符、`resolveBindAddress` 与 `isBindableLanAddress` 判定不一致、`x-dsh-remote-token` 文档承诺未实现、`/__dsh_remote/health` 遮蔽同路径的令牌交换、无连接数上限。

## 1. 令牌门与绕过面

### 1.1 门在哪、谁能放行

唯一决定"放不放行"的是 `src/remote/routes.ts` 的 authorize（`routes.ts:145-238`），它被 listener 的两条入口共用：

- HTTP：`listener.ts:748-785`，`gate = normalizeDecision(await options.authorize(...))` 在 `listener.ts:763`；
- Upgrade：`listener.ts:860-991`，`gate = normalizeDecision(await options.authorize(..., { socket }))` 在 **`listener.ts:872`**。

**`{kind:'allow'}` 只有一个产生点：`routes.ts:236`。** 到它之前必须穿过：

1. `routes.ts:160` 取对端 IP（空 → `'unknown'`）；
2. `routes.ts:164-173` health 短路（唯一免令牌 200，且只 GET/HEAD，其它方法 405）；
3. `routes.ts:177-206` 令牌入口：`getAll('token')`，>1 个 → 记失败 + 401/429；=1 个 → `gate.exchange`，成功只出 303，**不 allow**；
4. `routes.ts:209-215` `/__dsh_remote/*` 其余路径 → 404（login 给 401 登录页），**不 allow**；
5. `routes.ts:218-227` 会话校验 `gate.valid(cookieHeader)`，失败 → 401/429，**不 allow**；
6. `routes.ts:230-234` 上游身份 `options.upstreamCookie()` 为 null/'' → **503**，**不 allow**。

即：**allow ⇔（会话 cookie 有效）∧（上游身份存在）**。路径在 allow 之后不再参与任何判断，所以"路径解析差异"这一类（我下面逐条试过的 10 种）**原理上无法把受保护路径变成放行**——因为它们最坏只能把请求推进到 401/404/405/303/503 五个出口之一。

### 1.2 逐条试过的绕过路径（全部失败，含理由）

| 尝试 | 结果 | 证据 |
| --- | --- | --- |
| `/__DSH_REMOTE/health` 大写 | 不命中 health；落 `startsWith('/__dsh_remote/')` 为假 → 走会话校验 → 401 | `routes.ts:164`（`===`）、`routes.ts:218-226` |
| `/__dsh_remote/health/` 尾部斜杠 | 同上，401（不进 health） | 同上 |
| `/__dsh_remote` （无尾斜杠） | 不命中前缀 → 会话校验 → 401 | `routes.ts:209` |
| `/api/` 大写 `/API/` | 只影响 401 的**形态**（HTML 而非 JSON），不放行 | `routes.ts:225` |
| `__dsh_remote/` 百分号/`..` 编码（`/__dsh_remote/%2e%2e/api`） | `new URL` 不解 `%2e`，`pathname` 仍以前缀开头 → 404，不转发 | `routes.ts:157,209-214` |
| `/__dsh_remote/health/../api/x` | WHATWG 规范化成 `/__dsh_remote/api/x` → 404 | `routes.ts:151-157` |
| `?token=` 空值 | `getAll` 返回 `['']` → `exchange('')` → `missing-token` → 401 + 计数 | `routes.ts:177,183-184`、`auth.ts:281` |
| `?token=good&token=good`（重复参数） | 直接 401 + 计数，连比较都不做 | `routes.ts:178-181` |
| `?TOKEN=` / `;token=` | 不算 token → 401 + 计数（fail-closed 方向） | `routes.ts:177` |
| `HEAD` 任意路径 | 与 GET 同门；health 的 HEAD 只是 200 空体 | `routes.ts:165,211` |
| **Upgrade 不带 token/cookie** | **真的过 authorize**：`listener.ts:872` 在建立上游连接**之前**调用；拒绝时 `writeRawResponse(401)`（`listener.ts:879-887`）后直接 return，不建隧道 | `listener.ts:869-889`；测试 `remote-listener.test.mjs:641-659` 断言"没有 101、上游 upgrades=0" |
| Upgrade 带 `?token=` | exchange 成功 → 303（`writeRawResponse`），仍不建隧道 | `routes.ts:185-199` + `listener.ts:885` |
| `x-dsh-remote-token` 头 | 门**完全不读**这个头（全仓 grep 无实现）→ 401；这是"更严"方向，不是洞 | `routes.ts:11` 只有注释；无实现 |
| 回环来源（`127.0.0.1` 直连旁挂端口） | **没有豁免**：`isLoopback` 只有定义没有调用者，routes 里没有任何 loopback 分支 → 照样 401 | `auth.ts:147-166`（grep 无调用方）、`routes.ts:149-238` 全文 |
| `CONNECT` 方法 | listener 未注册 `server.on('connect')`，Node 对无监听的 CONNECT 直接断开，没有转发路径 | `listener.ts:993-1019`（只注册 request/upgrade/connection/clientError） |

### 1.3 两处"结构性风险"（当前不可达，但值得钉住）

1. **`listener.ts:757-759`：`authorize` 不是函数时直接 `forwardRequest`（无门直通）。** 生产链路安全依赖 `service.ts:347-350`（`authorizer === null` → `E_NO_GATE` 不起监听）与 `service.ts:374` 总是传 `authorize`。这两处目前都成立，但"不加门就转发"的默认值方向是 fail-open 的；建议改成"没有 authorize 就抛 `RemoteStartError`"，把这道保险从调用方挪进 listener。
2. **`normalizeDecision` 的兼容分支是 fail-open 的**：`listener.ts:613` `raw === true` → allow；`listener.ts:626` `kind===undefined && allow===true` → allow。当前 authorizer 只返回 `{kind:'respond'|'allow'}`，走不到这里，但任何将来"返回 `{allow:true}`"的门都会静默变成放行。建议只认 `{kind:'allow'}`。

另外两处**不影响鉴权**但属于同层的语义问题：

- **`/__dsh_remote/health?token=<有效>` 不会换 cookie**：health 短路在令牌解析之前（`routes.ts:164` vs `177`），所以这条 URL 只回 200 JSON，令牌既不消费也不计数。二维码/链接不会生成这种地址，但手工粘贴会得到"打不开且没有提示"。
- **401 的 303 目标只取 `pathname`（`routes.ts:189-197`）**，我专门验证过不构成开放重定向：`//evil.com/x` 在 WHATWG 解析里会被当成 authority 而不是 pathname，`pathname` 不会以 `//` 开头。

## 2. 令牌/凭据外泄面

### 2.1 合法出口只有一处（成立）

- 明文 token 的唯一生成/持有者：`auth.ts:229-235,248-250`；`service.ts:461-471` 拼 `RemoteLink.url`；
- 唯一 RPC 出口：`rpc.ts:481-483`（`remoteShowLink`），且只在客户端显式点击时调用（`client.js:2861-2876`）；
- `remoteGetState` 的返回体里**没有** token 明文：`service.ts:403-410` → `status()`（`service.ts:268-292`）只给 `token: {exists, masked, createdAt}`，`urls` 来自 `urlForMode`（不含 token）；
- 客户端：`client.js:2874` 把 `RemoteLink` 整体放进 state，但**只渲染二维码矩阵与按钮**（`client.js:3247-3264`），明文地址只在 `doCopyLink` 的点击回调里用（`client.js:2882-2894`），从不进 DOM；`client.js:2904-2907` 还额外过滤了 `withToken === true` 的条目。渲染侧测试 `client-remote-render.test.mjs:542` 断言渲染结果里无 token。

### 2.2 三个真实存在的"溢出"（都不到 P0）

1. **M3（P2）：`manualUrl` 是唯一能把 token 带进状态/DOM 的字段。**
   `urlForMode('manual')` 原样返回 `settings.manualUrl`（`urls.ts:313-314`，注释里明确"可含 token"见 `types.ts:50-51`），`status()` 把它塞进 `urls` 并标 `withToken:false`（`service.ts:274-278`），`client.js:2905-2907` 因此**不会过滤它**，最终在 `client.js:3275` 以 `asText(e.url)` 渲染。也就是说：用户把 `http://…/?token=<令牌>` 粘进"完整地址"后，令牌会出现在设置页 DOM 与 `remoteGetState` 的 JSON 里，违反"唯一出口是显示链接"。
2. **打码过宽（P2）**：契约与 `auth.maskedToken()` 是"前 4 + 长度"（`auth.ts:253-256`），但 service 用的是 `urls.maskToken` = **前 4 + 后 4**（`urls.ts:346-349`，被 `service.ts:169,288` 调用）。43 字符令牌暴露 8 字符仍安全（≈210 bit 未知），但与"永不多于 4 字符明文"的自我约定不一致。
3. **RPC 错误体是"透传 message"**（`engine/errors.ts:40-53`）。远程域自己的消息确实不含 token（`service.ts:465-467` 只给中文短语；`accessMode.ts:402-405` 用 `detailValue` 对 `manualUrl` 打码，`accessMode.ts:271-282`），但这条约束依赖"每个新增错误消息都自觉"，没有兜底的脱敏函数。

### 2.3 日志与状态响应

- `remote/**` 里**没有任何写日志的代码**（service 无 logger；listener 的 `log` 先过 `scrubSecrets`，`listener.ts:683-690,232-236`）；
- listener 的错误/状态只出现 errno 码与"scope+固定短语"：`noteFailure`（`listener.ts:699-703`）、`codeOf`（`listener.ts:257-265`）、`safeUrlText`（`listener.ts:239-247`）；
- 上游 cookie 明文只活在内存（`service.ts:90-93,141`），不进 `RemoteStatus`（`types.ts:129-149` 逐字段核对：无 cookie/token 字段）。

## 3. 上游身份与响应头处理

| 检查点 | 结论 | 证据 |
| --- | --- | --- |
| 上游身份来源 | 只走 `connection.authenticatedUrl('http://127.0.0.1:<port>/')`（地址是**写死的回环**，不取请求 Host） | `service.ts:237-249` |
| cookie 提取 | 只取 `dsh-auth-` 前缀那条，`split(';')[0]` 去掉属性；拿不到 → null | `service.ts:250-252` |
| 拿不到身份 | 启动期 `E_NO_UPSTREAM_IDENTITY` 不起监听；请求期 `503 E_UPSTREAM_IDENTITY` | `service.ts:357-361`、`routes.ts:230-234` |
| **身份过期** | **M2 缺陷**：`upstreamCookie` 闭包不判 `expiresAt`，只判 `null`（`service.ts:305`）；`refreshUpstreamIdentity` 的 12h TTL（`service.ts:254`）只在定时器成功时被覆盖（`service.ts:386-390`）。因此刷新连续失败后，过期 cookie 仍被判"有身份"并注入上游 → 客户端收到的是上游的 401/302，而不是我们承诺的 503 | 同左 |
| `Set-Cookie` 剥离 | 成立：HTTPS 响应头黑名单 `listener.ts:293-303`（含 `set-cookie`/`set-cookie2`）、101 头只剔 cookie `listener.ts:306,471-476`、组装走 `rawHeaders` 且 `set-*` 整体丢弃 `listener.ts:448-461`；测试 `remote-listener.test.mjs:454-469,565` | 同左 |
| 客户端 cookie 上行 | 不转发：`routes.ts:236` 只返回 `{cookie: upstream}`，listener 用 `extraHeaders` 覆盖同名头（`listener.ts:400-408`） | 同左 |
| `location` 改写用的 authority | **用的是请求的 `Host` 头原文**（`listener.ts:742-745` → `829` → `437`），未做白名单/格式校验。攻击者能控制自己的 Host，所以只能自我重定向（不构成盗链/开放重定向），但若前面还有一层缓存/反代（Cloudflare 之外的 CDN），`Host` 注入进 `Location` 是可被利用的经典面 → 建议只接受"配置里的隧道域名 / 本机 IP 列表"，其余不改写 | 同左 |
| `location` 协议 | 恒写 `http://`（`listener.ts:437`），https 隧道（Cloudflare）下会把 `https://` 重定向降级成 `http://`，浏览器/WebView 可能直接拦 | `listener.ts:437` |
| `x-forwarded-*` 伪造 | 客户端自带的 `x-forwarded-for` 会被**保留**并追加真实 IP（`listener.ts:391-399`）；鉴权用的是 socket 地址（`listener.ts:650`），所以只污染上游日志，不影响限速 | 同左 |

## 4. 绑定地址约束

**没有任何路径能落到通配地址**，三层各自独立成立：

1. 落盘校验：`normalizeIpv4` 直接拒 `0.0.0.0` 与 `255.255.255.255`（`urls.ts:69-78`），`normalizeRemoteSettings` 出错即 `E_VALIDATION`（`accessMode.ts:390-408`）；手改 `remote.json` 写进 `0.0.0.0` 会在 `readSettings` 归一阶段抛错 → 回落默认值（`service.ts:145-155`）。
2. service：`resolveBindAddress` 对 lan/cloudflare 显式再拒 `0.0.0.0` 与 `127.x`（`service.ts:182-184,216-221`）；自动挑选只从"非虚拟网卡"里选，挑不到就报错而不是回落（`service.ts:123-128,187-189`）。
3. listener：`isBindableLanAddress` 拒 `0/8`、`127/8`、`169.254/16`、`>=224`、非 IPv4（`listener.ts:197-207`），且唯一的 `server.listen(port, address)` 用的是这个校验过的值（`listener.ts:672-678,1040`）。

但判定**不一致**（P2）：

- `resolveBindAddress` 只拒 `0.0.0.0` 和 `127.x`，因此 `169.254.x`、`224.x`、`240.x`、`255.255.255.255`、`0.1.2.3` 都能通过 service，然后在 listener 被拒 → 用户看到的是 `E_LISTEN_FAILED: 监听启动失败：绑定地址必须是…` 而不是 `E_NO_BIND_ADDRESS` 的可读原因（`service.ts:376-379`）。
- `pickLanAddress` 不过滤链路本地（`service.ts:123-128`），而 probe 过滤（`probe.ts:226-227,331`）→ 自检可能说"没有可用局域网 IPv4"（fail），启动流程却挑了一个 169.254 去绑。
- `ipv6` 分支只检查"含冒号、不带方括号"（`service.ts:191-199`），`::`、`fe80::1` 都能通过 service —— 好在 listener 只认 IPv4，所以**不会**真绑通配，代价是 **M1**。

## 5. 限速与锁定

- **按 IP**：计数键就是 socket 对端地址（`listener.ts:650` → `routes.ts:160` → `auth.ts:342`），60s 滑动窗口、超过 5 次才限速、`retryAfterSec` 取"最早一次滑出窗口"（`auth.ts:340-357`）。`X-Forwarded-For` 不参与（见 §3），伪造不了桶。
- **拿不到 IP 不放行**：空 → `'unknown'` 桶（`routes.ts:160`），照样 `fail()`，测试钉死（`remote-routes.test.mjs:208-213`）。
- **429 带 `Retry-After`**：`routes.ts:180,203,222` 三处都带，值 ≥1（`auth.ts:355`）。
- **会不会把正常用户锁死**：**不会**。① 打开登录页 `GET /__dsh_remote/login` 不计失败（`routes.ts:211-213`，测试 `remote-routes.test.mjs:187-193`）；② 正确令牌的换 cookie 路径**不看** `limited`（`routes.ts:182-199` 里只有失败分支才 429），所以即使已在 429 状态，扫对码仍能进。代价是：被限速的一分钟内，输错只会看到"尝试过多"页而不是"令牌不对"。
- 遗留问题（P2）：`resetFailures` **从未被调用**（`auth.ts:363-366` 只有定义，全仓无调用方），而注释写着"成功认证后调用，避免正常用户被自己之前的输错连累"（`auth.ts:359-362`）。实际效果是"先错 5 次、再成功、再错 1 次"立刻 429。建议在 `routes.ts` 的 exchange 成功分支调 `resetFailures(ip)`。
- `unknown` 桶是全局共享的：真出现"取不到 IP"的部署形态，一个攻击者能替所有人把桶打满。当前 socket 一定有地址，风险仅理论层面。

## 6. 失败隔离

代码路径结论 + 我按代码构造的故障推演（未运行、未触碰生产环境）：

| 我构造的故障 | 预期结果 | 依据 |
| --- | --- | --- |
| 令牌文件不可写（`~/.dsh` 只读） | `createRemoteModule` 在 `ensureToken` 抛错 → `index.ts:104-113` 捕获 → `remote=null`；插件继续注册 RPC 与日程工具；`remote*` 一律 `E_INTERNAL` | `index.ts:43-49,102-121`、`rpc.ts:425-429` |
| 宿主不给 `connection.authenticatedUrl` | `start()` 返回 `E_NO_UPSTREAM_IDENTITY`，**不建监听**（不是"哑监听全 503"） | `service.ts:357-361` |
| 端口被占 / 绑不上 | listener 抛 `RemoteStartError` → `service.ts:376-379` 收敛成 `E_LISTEN_FAILED`；`start()` 本身不抛 | `service.ts:369-379` |
| 上游 DSH 卡死不应答 | `AbortSignal.timeout(3000)` → null → 请求期 503 | `service.ts:247-249`、`routes.ts:230-234` |
| `start()` 抛错会不会冒到 `ctx.effect` | 不会：`start()` 全函数只有 `try/finally`（`service.ts:328-401`），没有可逃逸的 throw；`index.ts:145-154` 的自动启动还额外 `void ... .catch()` | 同左 |
| `dispose()` 幂等 | 是：`dispose → stop`，`stop` 先把 `handle=null` 再 close 并吞错（`service.ts:309-326,477-479`）；`dispose` 再包一层 `.catch`。RPC 侧 `dispose` 有 `disposed` 短路（`rpc.ts:537-542`） | 同左 |
| 同步 RPC 是否被远程故障影响 | **有轻微耦合**：`remoteStart/remoteSaveSettings` 与同步动作共用一条串行队列（`rpc.ts:513-528`）。`saveSettings` 内部会 `await start()`（`service.ts:421`），最坏被上游换取超时拖 3s，期间 push/preview 排队。功能不坏，但"远程不影响同步"的承诺在延迟维度上打了折扣 | 同左 |

补充：`index.ts:135-155` 的两个 `ctx.effect` 回调都是同步返回 disposer，回调体不抛错，因此"远程装配失败导致插件启动失败"在代码上不可能。

## 7. 数据契约（落盘/权限）

- **原子写成立**：先写 `file.<pid>.<ts>.tmp`（0600）再 `renameSync`，rename 失败退回直写并清 tmp（`store.ts:42-56`）。
- **0600 只在 POSIX 成立**：Windows 上 `mode` 被忽略，文件里自己写了这句（`store.ts:40-41`），也没有 ACL/DPAPI 加固。目录用 `0o700`（`store.ts:32-34`）。→ 对"本机同账号的其它进程"没有防护，属于**已知限制**而非谎报。
- **运行态不落盘成立**：`RuntimeState`/`upstream`/`sessions`/`failures` 全在内存（`service.ts:81-93,140-143`、`auth.ts:208-211`）；落盘只有两处 —— `writeSettings`（`service.ts:416`）与 `writeToken`（`service.ts:432`）/`ensureToken`（`index.ts:46-48`）。监听地址、连接数、最近错误、自检结果、会话 cookie 一律不写。
- **`remote.json` 有没有 secret**：结构上没有（`RemoteSettings` 无 token 字段，`types.ts:32-52`）；但 `manualUrl` 允许自带 token（`types.ts:50-51`、`urls.ts:313-314`），所以"配置里绝无凭据"只在用户不粘 token 时成立。
- `remote-token.json` 读侧 fail-closed：解析失败 / 非对象 / 字段非串 / 长度 <32 → null（`store.ts:94-104`），即"文件坏了等于没令牌"，不会退化成弱令牌。
- 一个小语义点：`ensureToken` 在插件 `apply` 期就落盘 token（`index.ts:76`），**即使 `enabled=false`**。功能上无害（没有监听就没人能用它），但"默认关闭时磁盘上已有一把凭据"值得在文档里说明。

## 8. 测试覆盖缺口（逐条，标注严重度）

现有覆盖相当扎实：routes 的 18 条分支（`remote-routes.test.mjs` 全文）、auth 的常量/限速/轮换（`remote-auth.test.mjs`）、listener 的 `set-cookie` 剥离与 `location` 三态（`remote-listener.test.mjs:454-500`）、Upgrade 过门与 101（`remote-listener.test.mjs:608-660`）、service 的 6 个 fail-closed 出口与幂等 dispose（`remote-service.test.mjs:81-287`）。以下分支**没有**测试：

| # | 缺失分支 | 级别 | 说明 |
| --- | --- | --- | --- |
| G1 | `ipv6` 方式的 start → bind 全链路 | **P1** | 现有 service 测试只跑 lan happy path（`remote-service.test.mjs:140-165`）。加一条 `mode:'ipv6'` 的 start 会立刻暴露 M1（service 放行、listener 拒） |
| G2 | 上游身份过期后 `upstreamCookie` 的返回值 | **P1** | 无任何测试覆盖 `expiresAt` 之后的行为（`service.ts:260-266`）；现在的实现会返回过期 cookie，测试一写就会红 |
| G3 | **真实 routes + 真实 auth + 真实 listener** 的联调（尤其 WS upgrade 不带 token → 401 且无 101） | **P1** | 现在三条链路各自用桩：listener 用假 authorize（`remote-listener.test.mjs:503-660`），routes 用假 gate（`remote-routes.test.mjs:16-48`）。唯一的"跨边界"测试是常量断言，而它钉的 `TOKEN_PARAM==='k'` 本身就是错的（G9） |
| G4 | `?token=` 与 cookie 名的**生产装配**对齐（`index.ts` 传 `SESSION_COOKIE_NAME`，routes 按 `sessionCookieName` 读，auth 的 exchange 只下发规范名） | P2 | routes 测试里 `SESSION_COOKIE='dsh-remote-session'`（`remote-routes.test.mjs:11`）是**别名**，与 index 实传的规范名不同；一旦有人改名字，这套测试不会红 |
| G5 | `/__dsh_remote/health` 大小写 / 尾斜杠 / 无前缀 `/__dsh_remote` / `/API/` 大写 | P2 | 当前都是 fail-closed，但全是"靠 `===`/`startsWith` 恰好成立"的隐式契约 |
| G6 | `x-dsh-remote-token` 头 | P2 | 文档承诺的第三种入口（`routes.ts:11`）没有实现也没有测试；要么实现，要么从文档删掉 |
| G7 | `Host` 为非回环、非本机值时的 `location` 改写 | P2 | 现有测试只用 `${LAN}:${handle.port}`（`remote-listener.test.mjs:413,467`），没有验证恶意/陌生 Host 的处置 |
| G8 | `resolveBindAddress` 对 `169.254.x` / `224.x` / `255.255.255.255` 的返回值 | P2 | 只测了 listener 侧的 `isBindableLanAddress`（`remote-listener.test.mjs:353-383`）；两层不一致没有被任何测试抓到 |
| G9 | 令牌 URL 参数名的单一事实来源 | P2 | `remote-auth.test.mjs:386-391` 断言 `TOKEN_PARAM==='k'`，而真正被解析的是 `token`（`routes.ts:177`、`urls.ts:341`）；这条测试在**保护错误** |
| G10 | `resetFailures` 在鉴权成功后是否被调用 | P2 | 没有测试，也没有调用方（`auth.ts:363-366`） |
| G11 | `manualUrl` 含 token 时 `getState`/客户端渲染不外泄 | P2 | `client-remote-render.test.mjs:542` 只喂了不含 token 的 state，M3 因此漏网 |
| G12 | `CONNECT` 方法、超大/畸形请求头 | P2 | 无测试；当前行为依赖 Node 默认（断开/400） |

**最该补的一个**：G1 —— 一条 `mode:'ipv6'` 的 `start()` 测试（断言 `running===true`，或至少断言 `lastError.code==='E_NO_BIND_ADDRESS'` 而不是 `E_LISTEN_FAILED`）。它是唯一"5 行测试就能锁死 M1 这类声明与实现脱节"的点。

## 9. 与声明的安全承诺逐条对照

（口径：`docs/REMOTE-ACCESS-OPTIONS.md` §5 + 任务书五条硬约束）

| # | 承诺 | 兑现 | 证据 |
| --- | --- | --- | --- |
| 1 | token 用 `crypto.randomBytes(32)`（base64url），存 0600 | ✅ | `auth.ts:51-57,284-289`、`index.ts:46-48,89`、`store.ts:45` |
| 2 | 比较用 `timingSafeEqual` | ✅ | `auth.ts:76-84`（先 sha256 再比，长度差也折进 diff） |
| 3 | token 永不进日志/错误消息/状态响应；唯一出口是"显示链接/二维码" | ⚠️ 基本兑现，两处例外 | 无日志代码（`listener.ts:683-690` 还二次脱敏）；`status.token` 只给打码（`service.ts:288`）。**例外**：`manualUrl` 经 `status.urls` 进 DOM（M3）、打码暴露 8 字符（`urls.ts:346-349`） |
| 4 | 三种入口：`?token=` / `x-dsh-remote-token` 头 / 会话 cookie | ⚠️ 只实现两种 | `routes.ts:177,218`；头入口无实现（M4 附带项） |
| 5 | 命中 `?token=` 本层消化：303 到干净地址 + 下发会话 cookie，绝不转发上游 | ✅ | `routes.ts:182-199`；测试 `remote-routes.test.mjs:88-111`；cookie 属性 `auth.ts:133-139`（`HttpOnly; SameSite=Lax; Path=/`） |
| 6 | 上游 `dsh-auth-*` cookie 只留服务端、只出现在发往上游的请求头 | ✅ | `service.ts:237-258`；`routes.ts:236`；`listener.ts:293-303,448-461` |
| 7 | 上游响应 `Set-Cookie` 必须剥掉 | ✅ | `listener.ts:293-303,306,471-476`；测试 `remote-listener.test.mjs:454-469,565` |
| 8 | 上游身份拿不到时 fail-closed（503），绝不直连 | ⚠️ 半兑现 | null 时 503 成立（`routes.ts:230-234`）；**过期**时不判（M2） |
| 9 | 同 IP 失败计数 + 429 + `Retry-After`；无 IP 时用 `unknown` 桶且不放行 | ✅ | `auth.ts:340-357`、`routes.ts:160,180,203,222`；测试 `remote-routes.test.mjs:208-213` |
| 10 | 旁挂监听上即使来源是回环也要令牌 | ✅ | `auth.ts:147-166` 的 `isLoopback` **无调用方**；routes 无 loopback 分支（§1.2 已列） |
| 11 | 局域网监听禁止绑 `0.0.0.0` | ✅（但 ipv6 分支自相矛盾 → M1） | `urls.ts:73`、`service.ts:182,218`、`listener.ts:197-207,672-678,1040` |
| 12 | 反代必须支持 WebSocket upgrade，且 upgrade 必须过门 | ✅ | `listener.ts:860-991`（101 原样回、双向裸字节、双向 teardown）、`listener.ts:872` 过门；测试 `remote-listener.test.mjs:608-660` |
| 13 | 不得做"裸 `GET /` 自动补 DSH `?token=` 并下发 cookie"（RESEARCH-A §7 反面教材①） | ✅ | 全仓无此逻辑：303 只发生在**请求自己带了有效远程令牌**时（`routes.ts:182-199`）；`/` 无 token 一律 401（`routes.ts:218-226`） |
| 14 | 不得接 frpc/第三方中转与遥测（§7 反面教材②） | ✅ | `remote/**` 唯一外发请求是 `fetch(authenticatedUrl('http://127.0.0.1:<port>/'))`（`service.ts:243-249`），目标写死回环；无 telemetry、无第三方域名 |
| 15 | 公网暴露优先 TLS（§5.6） | ⚠️ 文案层面 | `cloudflare` 走 https（`urls.ts:235-237`），`ipv6`/`lan` 是明文 http；`location` 改写恒降级 `http://`（`listener.ts:437`）与 §5.6 冲突 |

## 10. 附：我读过的文件与行号范围

| 文件 | 读过的范围 | 备注 |
| --- | --- | --- |
| `docs/REMOTE-ACCESS-OPTIONS.md` | 1-60、165-261 | §5 安全边界、§3 字段表、§6 未验证清单 |
| `docs/RESEARCH-A-mobile-remote.md` | 未逐行读 | 只按任务书转述的 §7 结论对照（两处反面教材） |
| `src/remote/types.ts` | 1-201（全文） | 契约 |
| `src/remote/routes.ts` | 1-249（全文） | 鉴权/路由层 |
| `src/remote/auth.ts` | 1-397（全文） | 令牌门状态机 |
| `src/remote/listener.ts` | 1-1081（全文） | 旁挂监听 + 反代 |
| `src/remote/service.ts` | 1-488（全文） | 状态机/装配 |
| `src/remote/index.ts` | 1-98（全文） | 薄壳装配 |
| `src/remote/store.ts` | 1-118（全文） | 落盘 |
| `src/remote/urls.ts` | 1-387（全文） | 地址归一/打码 |
| `src/remote/accessMode.ts` | 255-434（+ 全文 grep：hostsListener、manualUrl、E_VALIDATION） | 归一与校验 |
| `src/remote/probe.ts` | 仅 grep（`169.254`/`isBindable`/`fetch`）与 `226-227,331` | 自检不在本次重点，未逐行读 |
| `src/index.ts` | 1-163（全文） | 插件入口/失败隔离 |
| `src/rpc.ts` | 380-555、556-633（+ 全文 grep `remote`） | remote 8 个 action、HTTP 鉴权链 |
| `src/engine/errors.ts` | 1-65（全文） | `toRpcError` 是否带出 secret |
| `src/client.js` | 2858-2907、3240-3279（+ 全文 grep `remote`/`token`） | 远程 section 渲染与 copy 回调 |
| `test/remote-routes.test.mjs` | 1-244（全文） | 分支覆盖 |
| `test/remote-auth.test.mjs` | 370-391（+ 全文 grep 用例名） | 常量契约那条断言 |
| `test/remote-service.test.mjs` | 78-197（+ 全文 grep 用例名） | service/index 覆盖 |
| `test/remote-listener.test.mjs` | 全文 grep（upgrade/set-cookie/location/0.0.0.0）+ 353-383、454-500、503-660 区域 | listener 安全面 |
| `test/remote-model.test.mjs`、`test/remote-qr.test.mjs`、`test/remote-probe.test.mjs`、`test/remote-rpc.test.mjs`、`test/client-remote-render.test.mjs` | 用例名清单 + 关键断言点（`remote-auth.test.mjs:386`、`remote-model.test.mjs:264,384`、`remote-probe.test.mjs:634`、`remote-rpc.test.mjs:227-397`、`client-remote-render.test.mjs:542`） | 覆盖缺口判定依据 |

## 勘误（2026-11-18）：UU 远程可做端口映射

> 本节只做补充说明，**不修改本评审的任何既有结论与条目**（上面的段落、编号、行号引用原样保留）。

- **事实订正**：本评审写作时（2026-11-17）沿用了当时 `docs/RESEARCH-B-uu-remote.md` 的结论
  「网易 UU 远程 = 画面串流，没有端口映射 → `unsupported`」。官方 blog
  <https://uuyc.163.com/blog/20261117dewhjg.html>（2026-11-10）明确提供**图形化端口映射**且免费版
  包含，因此 `uu` 已改为 `needs-setup`（用户自己在 UU 界面里配映射、把生成的对外入口粘进插件）。
- **对本评审各项结论的影响：无。** 令牌门（`?token=` / `x-dsh-remote-token` / 会话 cookie 三入口、
  命中 `?token=` 本层换 cookie + 303、绝不把带 token 的请求转发上游）、上游 `dsh-auth-*` cookie
  的注入与 `Set-Cookie` 剥离、同 IP 失败限速、secret 不进日志/错误/`remoteGetState`、以及对本域
  「有条件通过 / 4 条必须改」的判定，全部**与访问方式枚举无关**——`uu` 只是多了一种"用户提供地址"
  的来源，它**不起旁挂监听**（`hostsListener: false`、`bindKind: 'none'`），走的仍是已有的
  `urlForMode` + `appendAccessToken` + `showLink` 这一条出口；令牌与上游 cookie 的安全边界没有变化。
- **本轮随之改动的代码面**（供复评时对照，均为本域内的机械改动，未触碰监听/鉴权/qr/routes/service）：
  - `src/remote/accessMode.ts`：`uu` 的 `availability` / `fields` / `steps`；`manualUrl` 的落盘校验
    对 `uu` 放宽到允许缺协议（`manual` 仍严格）；
  - `src/remote/urls.ts`：新增 `normalizeUuEntry`（入口形态临时默认），`urlForMode('uu')` 改用它；
  - `src/client.js`：字段文案支持 `remote.fields.<mode>.<key>` 这一层（`manual` 与 `uu` 共用
    `manualUrl` 槽位但叫法不同），同步改 `locale/zh.json`、`locale/en.json`（三处键集一致）。
- **仍未同步的地方**：`src/remote/probe.ts` 的 `uu-unsupported` 检查与 `MODE_READY.uu` 文案本轮
  未改（该文件不在本轮改动范围），下一轮修。
