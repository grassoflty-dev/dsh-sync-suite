# 独立只读评审 — batch b11（M1 `mod-plugin-gui-proxy` / M2 `mod-plugin-git-timeout-classification`）

> 评审对象：`main` @ `7bc977a` 之上的**未提交**工作树。
> 评审方式：读码 + 复跑门禁 + 只读探针；**未** commit / 未 push / 未跑同步周期 / 未用 `hdc` / 未安装。
> 评审期间工作树被另一条 lane **并发写入**（见 §1.4），本文件的结论对应 2026-11-23 23:23 的树状态。
> 所有门禁输出当次留存于仓库根 `.tmp/gates-review-*.out`（本评审自己重新跑的那一份）。

---

## 0 结论

- **P0 = 0，P1 = 0，P2 = 10。**
- 一句话裁决：**代码本身可以冻结（提交）**；10 条 P2 里只有 3 条（文档口径 / 模块登记格式 / 设计文档行号）建议**在同一个提交或紧随的 doc pass 内**修掉，其余 7 条可作为后续模块/加固项，**不阻断冻结**。

M1 的核心判断成立：`Origin` 只在「入站 Origin 的 authority == 入站 Host」时改写成上游 authority，外来 Origin 原样保留；再用一个**照抄 DSH 栅栏规则**的假上游证明了「经代理的平板同源请求能过栅栏，外来 Origin 仍被 403」。这不是「我们发了某个字符串」的自证。
M2 的核心判断也成立：被预算杀死的子进程是**结构性 timeout**（与 stderr 语言无关），「不可达」必须有正面传输证据；push 与读命令的预算**身份分开**（120 s / 8 s / 首调 20 s），预算数字从 `details.budgetMs` 进正文并过白名单。

---

## 1 复核范围与证据

### 1.1 实际 diff 范围（以 `git status --porcelain` 为准，共 19 条，不含本评审新增的 `docs/REVIEW-b11-batch.md`）

| 类别 | 文件 |
| --- | --- |
| M1 源码 | `packages/dsh-dots/src/remote/listener.ts`（大改，新增约 600 行）、`src/remote/service.ts`（+57） |
| M1 产物 | `dist/remote/listener.js`、`dist/remote/service.js` |
| M1 测试 | `test/remote-listener.test.mjs`（+542）、`test/gui-proxy-fence.test.mjs`（新，939 行） |
| M2 源码 | `src/engine/git.ts`（+181）、`src/engine/nodePath.ts`（+74）、`src/sync/gitPort.ts`（+176）、`src/sync/cycle.ts`（+33） |
| M2 产物 | `dist/engine/{git,nodePath}.js`、`dist/sync/{gitPort,cycle}.js` |
| M2 测试 | `test/git-timeout-classification.test.mjs`（新，13 例）、`test/plugin-pending-ownership.test.mjs`（retarget） |
| 文档 | `docs/RESEARCH-B-dsh-gui-proxy.md`（新，95 行）、`docs/MODULES.md`（§1 段末 + §2 两行 + §6 两行 + 证据块）、`packages/dsh-dots/docs/DETAIL.zh.md`（+4/−1） |

- 无 `package.json` / lockfile / `apps/**` / `.ets` / `compileSdk` 变更 ⇒ **无新依赖、零平板侧字段**。
- 改动全部落在两个模块声明的文件集内；`dist/` 只多出与 6 个源文件一一对应的 6 个 `.js`。
- 任务书给的文件清单**遗漏**了 `docs/MODULES.md` 与 `packages/dsh-dots/docs/DETAIL.zh.md`（评审开始后才出现，见 §1.4）；二者都属于「模块自带文档」义务，不算范围外夹带。

### 1.2 门禁复跑（本评审自跑，全部 `Tee-Object` 留存）

工作目录 `packages/dsh-dots`：

```
node scripts/build.mjs                     → .tmp/gates-review-build.out
node ../../node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
                                           → .tmp/gates-review-tsc.out
node .tmp\distcheck-j3.mjs                 → .tmp/gates-review-distcheck.out
node --test test/*.test.mjs                → .tmp/gates-review-plugin.out
```

逐个原文尾巴：

```
[plugin] dist/index.js + dist/client.js 已生成          （build，exit 0）
```

```
CMD: node ../../node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
TSC EXIT=0 (stdout+stderr lines: 0)                    （tsc 零输出，exit 0）
```

```
DIST-FRESHNESS: 75 files, 0 mismatch
DIST-WINDOW: 6 dist/*.js differ from HEAD
  modified dist/engine/git.js 40733 B
  modified dist/engine/nodePath.js 11775 B
  modified dist/remote/listener.js 66028 B
  modified dist/remote/service.js 25647 B
  modified dist/sync/cycle.js 52022 B
  modified dist/sync/gitPort.js 17850 B
```

```
ℹ tests 936
ℹ suites 0
ℹ pass 934
ℹ fail 0
ℹ cancelled 0
ℹ skipped 2
ℹ todo 0
ℹ duration_ms 51390.8546
```

2 个 skip 是既有的环境相关项，不是本批新增：`F10 store: 0600 权限（Windows 无 POSIX 语义）` 与 `fetch 直连时…（本机 NODE_USE_ENV_PROXY + HTTP_PROXY 接管）`。

工作目录仓库根：

```
node --test "apps/arkui-schedule/tools/test/*.test.mjs"   → .tmp/gates-review-app.out
```

```
ℹ tests 3234
ℹ suites 461
ℹ pass 3234
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 13646.9227
```

### 1.3 dist 结论

- `dist/` 与「当前 `src/` 一次全新 tsc emit」**逐字节一致：75 文件 / 0 mismatch**。
- 与 HEAD 的差异恰好是 6 个 `.js`，对应 6 个改过的 `.ts`，没有多生成、没有漏生成 ⇒ **按 MODULES §0 规则 9 的插件对等条款，本批「已编译」成立**。
- 我自己跑 `scripts/build.mjs` 前后对 `dist/**` 全量做 SHA-256 快照比对（`.tmp/review-dist-before.txt` / `review-dist-after.txt`）：**内容零变化**，即本次门禁运行没有改动交付物，不构成对 `dist/` 的越权写入。

### 1.4 树在评审期间被并发修改（必须记录）

- 评审开始（23:09）时 `git status` 只有 14 条；23:12–23:14 之间 `docs/MODULES.md`（23:11）与 `packages/dsh-dots/docs/DETAIL.zh.md`（23:12）出现在工作树里，来自另一条 lane 的文档登记。
- 本评审的门禁在 23:17–23:19 运行，**覆盖的是这两份文档落地之后的树**；1.1 的 19 条即最终快照。
- 因此本评审对 `docs/MODULES.md` / `DETAIL.zh.md` 的结论按「已包含」处理；若 Lead 之后继续改这两份文档，§4 的 P2-7 / P2-8 可能已经自愈，需按最终 diff 复核。

---

## 2 M1 逐项验收（`mod-plugin-gui-proxy`）

### 2.1 Origin 改写是否只对同源生效（安全核心）

- 实现：`listener.ts:531-543 rewriteSameOrigin()`，只在 `parsed.host.toLowerCase() === inboundHost.trim().toLowerCase()` 时返回 `http://<target.hostHeader>`；外来 authority 返回 `undefined`（**不改写**，`:541`）；不可解析的 `null` 也返回 `undefined`（`:536-539`）。
- 应用点只有一处：`outboundHeaders()` `listener.ts:577-578`；HTTP 与 Upgrade 共用同一函数（`:1235`、`:1537`），所以 WS 握手与 `/api` POST 走同一口径。
- 测试证明的是「经代理后能被 DSH 栅栏接受，且外来 Origin 仍被拒」：
  - `test/remote-listener.test.mjs:575-622`：同源改写 ✔；`http://<own>`（同 authority 不同 scheme）也改写（:603-609，见下方保留意见）；`https://evil.example` 原样保留（:611-613）；字面量 `null` 原样保留（:615-617）；无 Origin 不凭空造（:619-621）。
  - `test/gui-proxy-fence.test.mjs:428-482`：假上游**先自证会拒**（:433-441 直连外来 Origin ⇒ 403），再证明经代理 200；对照组外来 Origin 经代理仍 403 且 `fake.state.requests[1].headers.origin` 逐字保留（:466-474）。
- 保留意见（不构成缺陷）：比较**不区分 scheme**（`:541`），所以 `Origin: http://<authority>` 会被当作同源。对本监听不可被浏览器利用——对外这一跳只有 HTTPS（`https.createServer` 是唯一构造器，无明文分支，`listener.ts:1067-1079`），浏览器不会为 `https://host:port` 生成 `http://host:port` 的 Origin；非浏览器客户端本来就能省略 Origin。该行为已被测试显式钉住（:603-609），属于「有意的口径」，建议在代码注释里补一句「scheme 不参与比较且浏览器不可达」以免以后被当成漏洞反复发现。
- 结论：**通过**。改写不可能把「跨站 Origin」洗成同源：能通过比较的充要条件就是「入站 Origin 的 authority == 入站 Host」，而浏览器的 Host 恒等于它实际访问的 authority。

### 2.2 三条预算是否在正确阶段生效

| 预算 | 常量 | 起表 / 撤表 | 到期行为 |
| --- | --- | --- | --- |
| 连接 5 s | `:240` | `:1276-1293`，`socket` 的 `connect`/`secureConnect`/已连接/`close` 都撤表 | 504 `E_UPSTREAM_TIMEOUT` |
| 响应头 15 s | `:236`（旧名 `firstByteTimeoutMs` 等价，`:237-238`） | `:1296-1301`，`'response'` 一到即撤（`:1406-1410`） | 504 `E_UPSTREAM_TIMEOUT` |
| 空闲 120 s | `:242` | `:1345-1366`，每收到一块上游数据重置；`end`/`error`/`close` 清表 | 未回字节 ⇒ 504 `E_UPSTREAM_STALLED`；已回字节 ⇒ 只截断、不注入错误页 |

- 非法预算值回落默认（`resolveBudget` `:503-506`），不会出现「无预算」。
- 测试：`remote-listener.test.mjs:782-836`（只卡响应头，慢一点但会回话的上游照旧 200）、`gui-proxy-fence.test.mjs:727-784`（STALLED 的两种形态）、`remote-listener.test.mjs:1327-1346`（黑洞地址 300 ms 收口）。
- 保留：空闲预算的计时器**按上游字节**起表，不管客户端是否在背压中（见 P2-1）。
- 结论：**通过（带 P2-1 保留）**。

### 2.3 typed 错误

- 6 个码、状态码、正文逐字节固定：`listener.ts:720-745`；`content-type: application/json; charset=utf-8` + `cache-control: no-store`（`respondPlain` `:692-697` + `:816-818`）。
- 实测用 `remote-listener.test.mjs:1107-1135`（DOWN 502，并断言旧明文 `remote upstream unavailable` **不再出现**）、`:1348-1375`（PROTOCOL 502 逐字正文）、`gui-proxy-fence.test.mjs:273-311`（401 ⇒ SESSION 401）。
- 结论：**通过**。

### 2.4 401 重试是否「恰好一次 + 仅可重放体」

- 触发：`listener.ts:1425-1442`，只有 `attempt === 0 && replay.replayable && typeof onUpstreamUnauthorized === 'function'` 才重试；重试走 `refreshAndRetry()` `:1303-1320`，`dispatch(..., attempt + 1)`，第二次 401 直接回 `E_UPSTREAM_SESSION`。
- 可重放判定：`collectReplayBody()` `:1176-1201` —— 无 body / `content-length === 0` / `≤ 512 KiB`（`:249`）可重放；`transfer-encoding` 存在或超限 ⇒ `{replayable:false, body:null}`，按流式转发、不重试；`total > declared` 时提前返回，缓冲被 `declared` 封顶（不会因 content-length 撒谎而无限吃内存）。
- **只缓冲请求体，响应体全程流式**（`:1322-1404` 只 `res.write(chunk)`；`gui-proxy-fence.test.mjs:683-725` 有「第一块在上游结束前到达」的实测）。
- 测试：`:312-387`（恰好一次）、`:840-882`（body 逐字重放两次）、`:884-938`（chunked 不缓冲、只报 typed 会话错误）。
- 结论：**通过**；恢复路径的鲁棒性问题见 P2-2 / P2-3。

### 2.5 隧道上限与卸载

- 上限 16（`:244`），到顶回 503 `E_UPGRADE_TUNNELS_FULL` 并计 `rejected`（`:1527-1534`）；`tunnels.add` 在 `'upgrade'` 回调里（`:1593-1594`），`teardown` 在两端 `error/end/close` 上都删（`:1603-1613`）——`'end'` 也监听是必要的（server 侧 `allowHalfOpen`）。
- 卸载：`shutdown()` `:1085-1116` 先 `server.close()`、再销毁全部 client socket、再销毁隧道**两侧**上游 socket，并有 2 s 兜底；返回的 `close` 就是它（`:1725`）。`service.dispose() → stop() → handle.close()`（`service.ts:615-617`、`:400-416`）。
- 测试：`:1165-1260`（客户端关 / 上游关 / 到顶 / close() 全销毁 / 上游重启后新升级可用）。
- 额外实测（本评审）：让一条已升级的 WS 隧道**空闲 18 s** 后再发一帧，仍能收到回显（`15 s` 的 `upstreamReq.setTimeout` `:1558` **不会**误杀已升级的隧道）。这条很关键——若它误杀，平板的 `/api/remote.mux` 会在每次 15 s 空闲后掉线。
- 保留：上限只数「已建立」的隧道，握手中的不计（P2-4）。
- 结论：**通过（带 P2-4 保留）**。

### 2.6 中文错误页

- `renderErrorPage()` `:828-846` 只有常量中文标题 / 说明 / 下一步 + `错误码 <code> · HTTP <status>`；无外链、无脚本、无上游正文、无上游地址；`respondUpstreamFailure()` `:852-859` 按 `Accept: text/html` 分流，状态码保持 502/504/401/503，绝不改 200。
- 测试 `gui-proxy-fence.test.mjs:273-311` 断言「/api 得 typed JSON、导航得中文 HTML、DSH 英文 401 正文一个字都不外泄」。
- 结论：**通过**。

### 2.7 凭据是否可能下行 / 入日志

- 响应侧：`RESPONSE_STRIP` 含 `set-cookie` / `set-cookie2`（`:414-424`），101 应答单独再剥一次（`:427`、`:642-646`）。注入的 `dsh-auth-*` 只以**请求头**形式由 `routes.ts:233-239` 交给上游。
- 测试：`remote-listener.test.mjs:592-593`（上游只看到注入的那一个 cookie、客户端 cookie 不上行）、`:624-639`（响应无 `set-cookie`）、`gui-proxy-fence.test.mjs:457`、`:502-...`（日志里同时找不到上游 cookie 与客户端 `?token=` 金丝雀）。
- 日志：唯一出口 `log()` `:1037-1044` 先过 `scrubSecrets()`；`noteFailure()` `:1061-1065` 只写 errno 码 + 固定短语；`lastError.message` 只有码。全文件的日志调用点没有一处插值请求头 / URL。
- **保留意见（不是缺陷，但要说清机制边界）**：`scrubSecrets()` 只遮「具名查询参数」与 URL userinfo，**并不**遮任意文本里的裸 cookie/token 值。今天「日志永不含凭据」靠的是调用点纪律（每条日志都只有状态码/固定短语），不是打码函数的普适保证。建议在 `:1058-1065` 旁注一句「只允许传码/状态，禁止插值头」。
- 结论：**通过**。

### 2.8 无启动回归（`dsh web` 缺席时）

- `gui-proxy-fence.test.mjs:818-838`：`createRemoteService({homeDir})` 无 `webServer`/`connection`/listener 时，`getState()` 不抛、`start()` 不抛，只把 typed `lastError` 写进状态。
- 代码侧：`start()` 全程 try/catch（`service.ts:419-515`），身份拿不到 ⇒ `E_NO_UPSTREAM_IDENTITY` 并**不起监听**（`:447-452`）；TLS 材料缺失 ⇒ `E_NO_TLS_CERT`（`:462-469`）；listener 抛错 ⇒ `E_LISTEN_FAILED`（`:490-493`）；`getState()` 不做任何隐式启动（`:519-523`）。
- 结论：**通过**。

### 2.9 故障隔离（上游全挂不影响插件自有接口）

- `gui-proxy-fence.test.mjs:790-816`：上游是死端口时 `/__dsh_remote/health` 仍 200，只有转发路径 502 typed。
- 代码：`/__dsh_remote/*` 由门禁直接写响应、返回 `{kind:'respond'}` 后本监听不重复写（`:1150-1158`），不建上游连接。
- 结论：**通过**。

---

## 3 M2 逐项验收（`mod-plugin-git-timeout-classification`）

### 3.1 结构优先分类

- `pushFailureReason()` `gitPort.ts:201-228`（顺序）：typed `details.reason` → `killed/ETIMEDOUT/TimeoutError` → 文本鉴权 → 非快进 → **正面传输证据** → 只有超时字样 ⇒ timeout → 兜底 git-failed。
- 预算杀死子进程时的 typed 错误在 `execGit()` `:39-75` 里直接构造（`killed:true`、`reason:'timeout'`、`budgetMs`），**与 stderr 是否为空、是否外文无关**。
- `hasTransportEvidence()` `git.ts:109-115` 的正面证据集里**不含** `timeout/timed out`，杜绝「外文超时被猜成不可达」。
- 测试 T1–T5（`git-timeout-classification.test.mjs:194-357`）：真实子进程被预算杀、空 stderr、只有超时字样、传输证据、鉴权、非快进各一例。
- 结论：**通过**。

### 3.2 预算身份

- `NETWORK_TIMEOUT_MS = 8000`（`git.ts:67`）、`FIRST_NETWORK_TIMEOUT_MS = 20_000`（`:90`）、`PUSH_TIMEOUT_MS = 120_000`（`:79`）。
- `networkBudget()` `:428-437`：只有「本进程第一次 + 调用方未显式配置」才放宽到 20 s；显式配置永不放宽。
- `pushBudget()` `:445-447`：恒 120 s、`firstCall:false`、**不推进**进程计数（push 抢不走读命令的首调放宽）。
- 两处 push 出口都换成了它：`GitRepo.pushOnce()` `:845-855`；`GitRepoV2Port.run()` `gitPort.ts:241-248`（`args[0] === 'push'` 才带 `timeout` + `killSignal`）。
- 测试 T11 / T12 / T13（`:468-560`）：120000 而非 8000、9 s 慢推送不被杀（旧 8 s 会杀）、>120 s 得 `reason=timeout` + `budgetMs=120000`。
- 结论：**通过**。

### 3.3 askpass node 预热

- `warmAskpassNode()` `nodePath.ts:296-305`：按键（override / PATH / PATHEXT / platform / execPath / electron 版本 / 注入函数身份）每进程只解析 + 探针一次；**失败不缓存、不降级**；`gitAuthEnv()` 改走它（`git.ts:181`），冷启动成本落在任何带预算的网络子进程之前。
- 测试 T8（`:394-430`）断言「每进程只探测一次」与预算是可观测的。
- 结论：**通过**；缓存无失效路径（node 被卸载/升级后仍用旧路径）是已知小风险，记为观察项（未单列 P2）。

### 3.4 文案与下一步

- 五类原因各一句固定中文（`gitPort.ts:363-369`），超时短语由模板 + **当次预算**填充（`pushTimeoutReason()` `:149-151`、`PUSH_TIMEOUT_REASON_TEMPLATE` `:146`）。
- `cycle.nextStepOf()` `cycle.ts:956-962`：`timeout` → 「稍后重试；连续超时先检查网络与代理」；`unreachable/network` → 「检查网络、代理或防火墙」；`E_ASKPASS_NODE_MISSING` 仍走原句；其它沿用原「远端被推进」建议（逐字节不变）。
- 测试 T9 / T10 / PO-11。
- 凭据卫生：新文案/新 details 只含枚举与数字（`reason` / `killed` / `timeoutMs` / `budgetMs` / `firstCall` / `exitCode`）；`failure()` 仍走 `this.scrub()`（token + 用户名 + URL userinfo，`git.ts:453-461`）。**没有凭据能进新错误文案或 details**。
- 结论：**通过**；push 401/403 被文本归到 unreachable 的既有问题见 P2-6。

### 3.5 白名单一致

- `cycle.ts:1006-1014` 五个短语与 `gitPort.ts` 的 message 表逐字一致；`singleLineSafeReason()` `:1024-1029` 先归一 `>\d{1,6} 毫秒` 再精确比对，命中后仍输出带真实数字的原文。
- PO-10 drift guard 从两侧源码逐字抽短语并 `deepEqual`（`plugin-pending-ownership.test.mjs:480-487`），任一侧改写即失败。
- 结论：**通过**。

### 3.6 断言变更

见 §6。结论：**没有删除或放宽任何既有断言**；4→5 是新增一类原因带来的计数更新，并新增了「数字换成文字必须被折叠」的反向守卫（PO-11）。

---

## 4 发现清单（10 条，全部 P2；「阻断冻结」一栏全为「否」）

### P2-1 空闲预算会把「合法但安静」的流截断，且注释把这件事说反了

- 位置：`packages/dsh-dots/src/remote/listener.ts:154-159`（注释）、`:1345-1366`（`armIdle`）。
- 证据：空闲计时器只在**上游 data 块**上重置（`:1369-1375`），与客户端是否在读无关；背压时 `up.pause()`（`:1374`）后不会再有 data 事件，120 s 到点即 `destroyQuietly(res)`（`:1360-1363`）。注释却写「120 s 只可能命中真正卡死的上游」。
- 影响：① DSH 的 `/plugins/events` 是 SSE，静默超过 120 s 就被截断（EventSource 会重连，但设置页会闪一次「重连」）；② 平板在弱网/息屏下读取停滞时，健康的上游会被标成 `E_UPSTREAM_STALLED`。可自愈、有界，不是数据损坏。
- 建议修法：把 `armIdle()` 也挂到 `res` 的 `drain`（或写进度）上；或对 `content-type: text/event-stream` 不启用空闲预算（只保留头部/连接预算）；同时改掉 `:156-158` 的注释。
- 阻断冻结：否。

### P2-2 401 换身份会先清空缓存；失败后整个监听最长 6 小时无身份

- 位置：`packages/dsh-dots/src/remote/service.ts:349-353`（`refreshUpstreamAfter401`）、`:396`（authorizer 的同步 `upstreamCookie`）、`:499-504`（6 h 定时刷新）。
- 证据：`upstream = null` 在 `await upstreamCookie()` **之前**执行；若 `refreshUpstreamIdentity()` 返回 null（3 s 超时 / `authenticatedUrl` 抛错），缓存保持空，而 authorizer 对空缓存直接返回 null ⇒ `routes.ts:233-236` 对**所有**请求回 503 `E_UPSTREAM_IDENTITY`，直到下一次 6 h 定时器成功或重启。另：两个并发 401 会各跑一次刷新（无 single-flight），刷新窗口内并发请求全 503。
- 影响：一次低概率的刷新失败 = 数小时「远程访问不可用」；并发 401 会造成瞬时 503 抖动。与「401 自动恢复」的卖点相冲突。
- 建议修法：刷新成功后再替换（失败保留旧 cookie，下一次 401 再试）；对 `upstreamCookie` 加 single-flight（共享同一个 in-flight Promise）；缓存为空时在 authorizer 里做一次带短退避的惰性刷新（或把 6 h 定时改成失败后 1 min 重试）。
- 阻断冻结：否。

### P2-3 401 重试的第二次派发不复检客户端/监听状态

- 位置：`packages/dsh-dots/src/remote/listener.ts:1303-1319`。
- 证据：`await options.onUpstreamUnauthorized!()` 之后只检查 `res.writableEnded || res.headersSent`（`:1312`），不检查 `closed`，也不检查 `res.destroyed`/socket 是否已断。
- 影响：客户端在刷新窗口内断开时，仍会向上游发第二个请求（占用一条上游连接直到 15 s 响应头预算，并把响应写进已销毁的 `res`）。有界、只是浪费与日志噪声。
- 建议修法：dispatch 前补 `if (closed || res.destroyed || res.writableEnded) return`。
- 阻断冻结：否。

### P2-4 16 条隧道上限只数「已建立」，握手阶段不计数

- 位置：`packages/dsh-dots/src/remote/listener.ts:1527-1534`（检查 `tunnels.size`）、`:1561-1594`（`tunnels.add` 只在 `upgrade` 事件里）、`:1558`（握手 15 s 兜底）。
- 证据：上限检查在最前面，但槽位只在 101 拿到后才占；一个客户端可以同时挂起任意多条「已发请求、未 upgrade」的握手，每条各占一条上游连接最多 15 s。
- 影响：上限没有约束上游连接数（只约束已建立的隧道数）；持有配对令牌的客户端可以放大连接数。内网 + 令牌门使其不构成远程 DoS，但与「不封顶就会被一台设备吃光」的设计意图不完全一致。
- 建议修法：`http.request` 之前先占一个 pending 计数（或先 `tunnels.add` 占位、失败/超时删），上限按 pending+established 计。
- 阻断冻结：否。

### P2-5 Windows 下 120 s push 预算不保证在 120 s 结算（未验证）

- 位置：`packages/dsh-dots/src/sync/gitPort.ts:39-75`（`execFile` 的 `timeout` + `killSignal:SIGTERM`）；测试只覆盖直接子进程（T1 `:194-237`、T13 `:540-560`）。
- 证据：`execFile` 的回调在 stdio **关闭后**才触发；`child.kill()` 在 Windows 只结束 `git.exe` 本身，`git-remote-https.exe` 这类孙进程会继承 stdout/stderr 管道，可能让回调（连同 `SyncError('E_GIT', … timeout)`）迟迟不来。
- 影响：真实挂死的 push 可能不按 120 s 收口，周期停在 `syncing`；现有测试无法发现。
- 建议修法：外层加一个 `Promise.race` 硬截止（到点即 reject，并 `destroy` 管道），或 Windows 用 `taskkill /T /F` 结束进程树；补一个「孙进程持有管道」的用例。
- 阻断冻结：否（**标 `unverified`**：本机没有可复现的真实孙进程场景）。

### P2-6 push 的 401/403 仍会被文案归为「网络不可达」

- 位置：`packages/dsh-dots/src/sync/gitPort.ts:214-221`（`gitFailureReasonOf`）与 `:359-372`；`packages/dsh-dots/src/engine/git.ts:113`（`hasTransportEvidence` 的 `unable to access`）。
- 证据：git 对私有仓库鉴权失败的常见输出是 `fatal: unable to access 'https://…': The requested URL returned error: 401`；`AUTH_TEXT_RE`（`gitPort.ts:187-192`）不含 `returned error: 401/403` 或 `Invalid username or password`，于是落入 `hasTransportEvidence` 的 `unable to access` ⇒ `unreachable`，下一步让用户「检查网络、代理或防火墙」。
- 影响：令牌过期的用户被指去查网络。**不是本批引入**（旧正则同样先 `unable to access`），但本批把五类原因拆开、给了各自的下一步，这条误分类的代价更具体了。
- 建议修法：`AUTH_TEXT_RE` 增补 `returned error: (401|403)` / `Invalid username or password` / `could not read Username`，并加一条正向用例。
- 阻断冻结：否。

### P2-7 预算口径的旧文档没有一起改（`8 s` 仍然写着）

- 位置与原文：
  - `packages/dsh-dots/docs/DETAIL.md:248`：「a single git network operation is capped at 8 seconds.」（英文详情文档，且 `meta.detail` 指向包内 Markdown；`DETAIL.zh.md` 已改，英文没改）。
  - `docs/CONTRACT.md:255`：「单次 git 网络调用 ≤8s 超时。」
  - `docs/CONFIG-UX.md:63`、`:127`：把 `NETWORK_TIMEOUT_MS = 8000` 当成硬上限（首调现在是 20 s），且行号引用（`engine/git.ts:55`、`:265-269`）已随本次改动漂移。
  - `docs/VERIFICATION.md:87`、`:204`：同样把 `NETWORK_TIMEOUT_MS=8000` 写成「单次 git 网络调用」的唯一预算。
  - 代码注释自身也有出入：`git.ts:38` / `:82` 把 `clone` 写进「读类预算」覆盖范围，但 `ensureWorkTree()` 的 `clone`（`:634`）**没有**传 `timeoutMs`（与改动前一致，属既有行为）。
- 影响：契约/验证/配置文档与代码矛盾（push 120 s、首调 20 s），后续模块会按错的预算做设计。
- 建议修法：在上述四处补一句「预算按命令：push 120 s / 读命令 8 s / 本进程首调 20 s」，或统一指向一张表；`git.ts:38/:82/:634` 二选一（给 clone 加预算，或把注释改成「ls-remote / fetch」）。
- 阻断冻结：否，但**建议本提交或紧随的 doc pass 内修**（这是本批自己改出来的矛盾）。

### P2-8 `docs/MODULES.md` 的两行登记渲染不成表格，且批次号写成 b12

- 位置：`docs/MODULES.md:690-692`（§6）、`:369-373`（§2）、`:694`。
- 证据：新增的 `mod-plugin-gui-proxy` / `mod-plugin-git-timeout-classification` 两行前各多了一个**空行**，GFM 会把它当成新段落——没有表头/分隔行，两行会以字面 `| … |` 段落出现；`:694` 的证据块写「batch **b12** 证据」，而本批是 b11、评审文件是 `docs/REVIEW-b11-batch.md`。
- 影响：交付纪律把本文件当唯一索引；渲染坏掉 + 批次号错会让「哪一批交付了什么」难以追溯。
- 建议修法：删掉两处空行（让新行紧贴上一行），把 b12 改成 b11。
- 阻断冻结：否，但**建议提交前修**。

### P2-9 `docs/RESEARCH-B-dsh-gui-proxy.md` 的插件侧行号是改动前的，且 §5 的验收口径与实现不一致

- 位置：`docs/RESEARCH-B-dsh-gui-proxy.md:22`、`:73`、`:74`、`:75`、`:91`、`:94`。
- 证据（行号漂移，逐个可查）：
  - `:22` 的 `listener.ts:795 / 886-951 / 958-1089` 与 `service.ts:277-306`：现在分别是 `listener.ts:1071`（唯一构造器）、`:1204+`（HTTP 转发）、`:1487+`（升级），`service.ts:301-337`（身份换取）。
  - `:73` 的 `listener.ts:438-469` / `:467`：现在是 `:546-580` / `:575`。
  - `:74` 的 `listener.ts:1019`（升级握手 15 s）：现在是 `:1558`。
  - `:91` 的 `listener.ts:344-361`（剥 set-cookie）：现在是 `:414-424`。
  - `:75` 的验收清单仍写「401 透传」，而实现（U1）**有意**把 401 换成 `E_UPSTREAM_SESSION` + 中文页，测试断言英文 401 正文一个字都不外泄（`gui-proxy-fence.test.mjs:494-495`）；`:22` 的「12 小时、随进程到期刷新」也漏了 6 h 定时刷新。
- 影响：读者按文档找代码会落到无关函数；「401 透传」会让后来者以为客户端仍能看到 DSH 原始 401。
- 建议修法：在文首加「插件侧行号对应改动前 `7bc977a`」或刷新行号；§5 把 401 透传改成「401 一律 typed 化 + 一次重换身份」；§0.5 补 6 h 刷新。
- 阻断冻结：否，但**建议随本批修**。

### P2-10 门禁的 LAN 取址仍然「只证明能绑，不证明能连」，抖动风险未消除

- 位置：`packages/dsh-dots/test/remote-listener.test.mjs:59-93`、`packages/dsh-dots/test/gui-proxy-fence.test.mjs:47-81`；另有 `:714-721` 的 250 ms 墙钟断言。
- 证据：两个文件里的 `findBindableLanAddress()` 现在逐个候选**真绑一次**（修掉了 EADDRNOTAVAIL 类抖动），但只证明 `listen()` 成功，不证明从本机 `connect()` 能通；且取的是 `os.networkInterfaces()` 顺序里的**第一个**命中（虚拟网卡 / Wi-Fi Direct / VPN 常排在物理网卡前）。实现 lane 曾出现过一次 `ETIMEDOUT <host LAN ip>` 的隧道用例失败，正是「绑得上、连不通」的典型形态；本次全量（936 例）与本评审复跑都未复现，但没有留存那次失败输出，**无法点名用例**。`test/gui-proxy-fence.test.mjs:714-721` 的 `firstAt - startedAt < 250` 是负载敏感断言。
- 影响：门禁可能在换网卡状态/负载高时随机红；而没有可绑非回环 IPv4 的机器上，整套 e2e 代理用例变成 `skip`（静默失去覆盖）。
- 建议修法：优先取默认路由网卡的地址；对候选做一次「绑 0 端口 → 自连一次 → 关闭」的可用性探测；把 250 ms 的墙钟断言放宽到 1 s（它证明的是「不是整包缓冲」，不需要那么紧）；在 `docs/FLAKES.md` 记一条带条件的已知抖动。
- 阻断冻结：否。

---

## 5 未验证边界（本评审没有、也不能证明的东西）

1. **真机 / 真实平板**：平板打开已配对地址能否看到电脑自己的 DSH 页面（品牌 / 侧栏 / 设置页）、能否发消息并收到回复——**未验证**，需要 Lead 按 `docs/MODULES.md` §6 的三条验收断言在真机执行。
2. **真实 DSH 交互**：本评审没有向运行中的 DSH 发任何请求（`127.0.0.1:36569` 的 A–F 栅栏表是 `RESEARCH-B` 的既有实测，今天没有复跑）。401 重试的「`admit()` 在 handler 之前拒绝、所以重放无副作用」只有**读码依据**，e2e 用的是假上游。
3. **真实 120 s / 慢链路**：没有跑任何真实 push，也没有制造 120 s 超时；T13 用注入预算/替身证明的是分类与文案，不是「真实链路 120 s 到点行为」。
4. **Windows 孙进程**：`git-remote-https` 持有管道导致回调延迟的场景**未复现**（P2-5）。
5. **抖动**：那次 `ETIMEDOUT <LAN ip>` 未复现、未留存输出，因此**不能**说「已修复」，只能说门禁取值逻辑比之前强了一点。
6. **文件系统/权限之外的平台**：POSIX 侧只跑了 Windows 现有门禁（`F10` 仍 skip）。
7. 本评审**没有** commit/push/跑同步周期/用 `hdc`/安装插件。

---

## 6 有没有断言被删或放宽（逐条结论）

`git diff` 对两个测试文件的**全部**删除行都逐条看过：

| # | 文件:位置 | 变更 | 结论 |
| --- | --- | --- | --- |
| 1 | `test/plugin-pending-ownership.test.mjs:34` | 导入新增 `pushTimeoutReason` | 只加不减 |
| 2 | 同文件 `:173-183` (`shippedPushReasons`) | 从源码抽 4 个短语 → 抽 4 个 + 断言模板存在 + 断言模板含 `>N 毫秒` + 追加模板 | **收紧**（模板缺失会直接 fail，守卫更难失效） |
| 3 | 同文件 PO-09 `:448-462` | `reasons.length` 4 → 5 | 计数随第五类原因更新；循环体逐条断言「逐字节存活」未变 |
| 4 | 同文件新 PO-11 `:465-479` | 新增：带 `20000` 的超时短语必须存活；把数字换成「两百」必须整段折叠 | **新增反向守卫**，白名单没有放宽 |
| 5 | 同文件 PO-10 `:480-487` | `4→5`（两侧） | 仍是 `deepEqual`，未放宽 |
| 6 | 同文件 PO-08 / `:429-445` | 未改 | 16 个 hostile 原因与 96 字符长度上限原样保留 |
| 7 | `test/remote-listener.test.mjs:53-93` | 旧的「枚举取第一个」`findLanAddress()` 换成「逐个真绑」`findBindableLanAddress()`（该文件的删除行只剩这套取址代码 + 下面两条） | **收紧/更稳**，不是放宽（残留问题见 P2-10） |
| 8 | 同文件 `:838-869`（WS echo 用例） | 删掉 `socket.on('error', () => {})` | 由「吞掉错误」变「错误会浮现」，**收紧** |
| 9 | 同文件 `:1107-1135`（原「上游不可达」用例） | 旧 `assert.equal(response.text, 'remote upstream unavailable\n')` 换成 4 条 typed 断言 + **新增**「旧明文必须不出现」 | **收紧**（旧行为反而被显式禁止） |
| 10 | 同文件其余 +542 行 | 全是新增用例（首字节预算、连接预算、协议错误、隧道纪律、401 重试、流式、STALLED） | 无删除 |
| 11 | 两个新测试文件 | 新文件，无历史断言 | — |
| 12 | 既有 `skip` / `timeout:` | 无新增 skip、无调大超时 | 未放松 |

**结论：没有任何既有断言被删除或放宽。** `remote-listener.test.mjs` 里唯一的「减」是把一个错误处理器和一条旧明文断言换成了更强的 typed 断言；`plugin-pending-ownership.test.mjs` 的「减」只是 4→5 的计数更新。

---

## 7 冻结建议

- **代码：可以冻结（提交）。** P0 = 0 / P1 = 0；门禁四件套全绿（build exit 0、tsc exit 0、dist 75/0 mismatch、插件 936/934/0/2、app 3234/3234/0/0）；没有新依赖、没有 `.ets` 改动、没有放宽断言、没有把任何「安全/加密/已验证」标签升级（`service.status().tls` 仍只在监听真的起来时才为 true，`pairingProvision` / 证书 / 预检一字未动）。
- **建议提交前顺手修（3 条，都是文档/格式，代价极小）**：P2-7（`8 s` 四处旧口径）、P2-8（MODULES 空行 + b12 笔误）、P2-9（RESEARCH-B 行号 + 401 口径）。
- **建议排后续模块/加固（7 条，不阻断）**：P2-1（空闲预算与 SSE/背压）、P2-2（401 刷新失败的最长 6 h 无身份）、P2-3（重试不复检断连）、P2-4（隧道上限不数握手）、P2-5（Windows 孙进程，`unverified`）、P2-6（push 401 误分类）、P2-10（LAN 取址抖动 + 250 ms 墙钟断言）。
- **冻结时必须保留的证据**：本文件的 `.tmp/gates-review-{build,tsc,distcheck,plugin,app}.out`；`docs/MODULES.md` §6 的三条真机验收断言在真机执行前保持 `unverified`，不得改写成已观察结果。
- 回滚：M1 与 M2 文件集不相交（`src/remote/**` vs `src/engine/{git,nodePath}.ts` + `src/sync/**`），可分别 `git revert`；但两者与既有 `mod-remote-tls-termination` / `mod-plugin-askpass-node-resolution` 共用 `dist/` 单一构建窗口，回滚后必须重跑 `scripts/build.mjs` 并按规则 9 重新证明 dist 一致。


