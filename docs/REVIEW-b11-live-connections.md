# 独立只读评审 — batch b11：`mod-plugin-remote-live-connections`

- 评审对象：`main` @ `8c824028ffe00a880ec7a88d06867ae3339646d1`，工作树中**未提交**的单条车道（18 路径，见 §1.1）；车道自报路由 `dsh-opencode-go/hy4-flash-free`（正确），但本评审**不采信自报**，全部结论来自独立读码 + 自跑门禁 + 自写只读探针。
- 评审方式：只读 + 自跑门禁 + 内存探针；**未运行** `node scripts/build.mjs`，未写 `src/**` / `test/**` / `dist/**`，未执行任何 git 写命令，未联网，未用 `hdc`，未打印任何真实凭据。唯一拟写入的仓库文件是本文件；探针输出只落 gitignored `.tmp/gates-rvlc-*`（仓库根 7 份 + `packages/dsh-dots/.tmp` 3 份）。
- 立场：**攻击声明本身 + 产品需求原文**，不复述车道汇报；(a)–(g) 七条探针逐条给结论。

---

## 0 结论

- **P0 = 0，P1 = 1，P2 = 6；另有 1 条并发车道漂移记录（不计入本模块计数）**。裁决：**Block**——P1-1 未修前不可冻结；该修复是单点小改，补完后可立即转 Freeze-with-fixes，余下 6 条为文案/边界/刷新语义的 P2。
- 一句话裁决：机制的**主路径成立**（HTTP 按对端折叠、隧道单条长期保活、读视图剪枝、停监听清空、字段白名单无 token/URL/查询串、status 形状 additive、面板文案与「还有 N 个」齐全、48/48 定向与 1099/1097/0/2 全量均绿、dist 五份与新鲜 emit 逐字节一致）。但**「列表不能撒谎」这条核心属性有一个永久违背的缺口**：隧道在拨上游 `http.request` 同步抛错时只归还预约槽，不摘活连接条目，而模型对 `openTunnels > 0` 的条目**永不按窗口剪枝**，于是一条没有隧道、没有 HTTP 活动的「正在查看」幽灵行可以永久留在面板上——本评审用真跑探针复现（推进 10,000 秒后仍在）。
- 冻结前提：先修 P1-1（所有 touch 之后提前 return 的路径统一收口 `liveConnections.close(id)`），再按 §6 收敛 P2-1 ~ P2-6；**不要**因为全量套件红/绿去归因本模块（本评审期全量绿），也**不要**把另一条 app 车道新出现的文件算进本批。

| # | 级别 | 一句话 | 位置 |
| --- | --- | --- | --- |
| P1-1 | P1 | 隧道拨号同步抛错（以及 101 后写头失败）的提前 return 不摘活连接条目；`openTunnels>0` 永不老化 ⇒ 无隧道却永久显示「正在查看」的幽灵行 | `src/remote/listener.ts:1744-1761`、`1797-1823`；`src/remote/connections.ts:127-129,169-178` |
| P2-1 | P2 | 面板没有轮询：`remoteGetState` 只在挂载 / start / stop 调用，打开后新对端不会上屏、静默对端也不会从 UI 消失，与「live」承诺不符 | `src/client.js:1284-1302,1397,1436` |
| P2-2 | P2 | `close(id)` 只要 `openTunnels<=1` 就整条删，即使该对端在隧道期间刚发过 HTTP 请求 ⇒ 仍然活跃的对端从列表消失（反向撒谎） | `src/remote/connections.ts:169-178` |
| P2-3 | P2 | HTTP 在门禁**之前** touch，被 401/403 拒绝的对端也算「当前连接」；upgrade 路径却门禁之后才 touch，两条路径口径不一致 | `src/remote/listener.ts:1278` vs `1683-1705,1737` |
| P2-4 | P2 | 注释仍写「挂载只调 … pairingConnections / remoteGetState」，实际挂载已删掉 pairingConnections；与需求「停止展示历史审计」直接冲突 | `src/client.js:1152` |
| P2-5 | P2 | 「实测突发 1~3 秒」无仓库内证据；「恶意对端刷 IP 也只能占用这么多行」把**显示 cap=5**说成内存/DoS 上界，模型数组实际无 cap | `src/remote/connections.ts:45-54,125,185` |
| P2-6 | P2 | `docs/MODULES.md` §7.x 没有任何本模块登记（§7.6/§7.7 属其他车道），18 路径中唯一文档面缺位，冻结后无法追溯回滚/证据 | `docs/MODULES.md:782-812`（缺 §7.8 行） |

---

## 1 范围与证据

### 1.1 实际读过的文件

- 18 路径逐个读取（源码 4 + `src/client.js` + `locale/{zh,en}.json` + dist 5 + 新测 2 + retarget 测 4）；`listener.ts` 全文 1,986 行、`service.ts` 全文 1,507 行、`types.ts` 全文 364 行、`connections.ts` 全文 191 行。
- 只读依赖：`src/remote/pairingTransport.ts:90-107`（`transportOfBoundAddress` 分类）、`scripts/build.mjs:24-52`（dist/client 渲染规则）、`tsconfig.json`（ES2022/NodeNext）。
- 参照文风：`docs/REVIEW-b11-ff-vp.md`（§0–§8 结构、§1.2 G6 的 `transpileModule` 比对法）。`docs/MODULES.md` §7.6/§7.7 已读，见 P2-6。
- 未改动的既有文件不纳入改动面（按 `only if touched`）；`src/rpc.ts`、`src/sync/bootstrap.ts` 及其 dist 属另一条车道，仅记录漂移。

### 1.2 门禁复跑（全部 `Tee-Object` 到 gitignored `.tmp`）

| # | 命令（工作目录） | 结果 / tail | 留存 |
| --- | --- | --- | --- |
| G1 | `node ../../node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`（`packages/dsh-dots`） | **exit 0**，无诊断（文件内 `EXIT=0`） | `packages/dsh-dots/.tmp/gates-rvlc-tsc.out` |
| G2 | `node --test` 六份定向（两份新测 + 四份 retarget，`packages/dsh-dots`） | `tests 48 / suites 0 / pass 48 / fail 0 / cancelled 0 / skipped 0 / todo 0 / duration_ms 7650.0707`，exit 0 | `packages/dsh-dots/.tmp/gates-rvlc-targeted.out` |
| G3 | `node --test "test/*.test.mjs"`（`packages/dsh-dots`，正确 cwd） | `tests 1099 / suites 0 / pass 1097 / fail 0 / cancelled 0 / skipped 2 / todo 0 / duration_ms 70798.9282`，exit 0 | `packages/dsh-dots/.tmp/gates-rvlc-full.out` |
| G4 | 内存新鲜 emit 比对（`transpileModule`，ES2022/ESNext/esModuleInterop；先用未改的 `pairingTransport.ts` 校准） | `pairingTransport: MATCH`；`connections/listener/service/types: MATCH` × 4；`client: MATCH`；5/5 零 mismatch，exit 0 | `.tmp/gates-rvlc-distcheck.out` |
| G5 | 幽灵条目只读探针（`serverFactory` + 注入 `liveClock`，假升级请求带非法头令 `http.request` 同步抛错） | `MODEL_TUNNEL_AFTER_10000S` 仍 `count:1`；listener `stats` 前后均 `tunnels:0 reservedTunnels:0` 而 `liveConnections.count:1`，推进 10⁷ ms 后**仍在**；`EXIT=0` | `.tmp/gates-rvlc-probe-phantom.out` |
| G6 | 边界/反向撒谎探针（纯模型，注入时钟） | `EXACT_WINDOW`（恰好 15,000 ms）仍 1 条、`WINDOW_PLUS_1` 归零；`AFTER_CLOSE_WITH_FRESH_HTTP` 的视图为 `{connections:[],count:0}` | `.tmp/gates-rvlc-probe-boundary.out` |

- **未运行** `node scripts/build.mjs`；未对 `dist/` 写入任何字节。G4 只在内存里 `transpileModule`，不落盘。

### 1.3 起止哈希、`git status`、dist 结论

- 分支/HEAD 起止相同：`main` / `8c824028ffe00a880ec7a88d06867ae3339646d1`；全程零 git 写命令。
- 18 路径 SHA-256 起止**逐字节相同**（`Compare-Object` 无输出）：`.tmp/gates-rvlc-hashes-start.txt` 与 `.tmp/gates-rvlc-hashes-end.txt` 各 1,975 B；关键几项：
  - `src/remote/connections.ts` `84E64642…FB4AA`、`src/remote/listener.ts` `6DB4F5E1…2966C`、`src/remote/service.ts` `BF1198FA…3983E8`、`src/remote/types.ts` `0BCB78DE…5458DA`
  - `dist/remote/connections.js` `0C19B5AB…17057EF`、`dist/remote/listener.js` `84E5B0C5…46FA12A`、`dist/remote/service.js` `4FD5D4C8…61FFE6A`、`dist/remote/types.js` `DD178293…5A44CE`、`dist/client.js` = `src/client.js` `9BB8F9C6…62BF517`
  - 两份新测与四份 retarget 测哈希同起止（完整表见两份 `.txt`）。
- **并发构建检测：18 路径内未检测到中途重建**（起止哈希全等，G4 在评审末段仍 5/5 MATCH）。**树级漂移确有发生**：评审期间工作树另出现 app 侧 `instanceDelete.ts` / `SettingsInstances.ets` 等 9 条路径与 `apps/**` 多处改动，这些在起始 status 中不存在，属另一条车道；`dist/rpc.js`、`dist/sync/bootstrap.js`、`src/rpc.ts`、`src/sync/bootstrap.ts` 也在起始即已修改，不属本模块 18 路径。本评审未触碰它们。
- **dist 结论**：五份 `dist` 与源码新鲜 emit 逐字节一致（含 `dist/client.js` 的 loader-id 重写规则），校准文件同时 MATCH；因此「另一条车道正在重建 dist」在本评审窗口内**没有污染这五份产物**；若冻结前该车道再跑一次构建，须重跑 G4。

---

## 2 攻击 (a)–(d) 逐条结论

### (a) 幽灵条目 / 老化是否可能反向撒谎？— **1 条 P1 + 1 条 P2（P2-2）**

1. **正向（会否僵死）：会，且已复现。** 模型 `prune` 的判据是 `openTunnels > 0 || now - lastSeen <= windowMs`（`connections.ts:127-129`）：只要 `openTunnels>0`，无论时钟推进多久都不剪。`listener.ts:1737` 在**拨上游之前** `touch(peer,'tunnel')`（`openTunnels` 变 1），而 `http.request` 同步抛错的 catch（`:1755-1761`）只 `reservation.release()`，**没有** `liveConnections.close(liveEntry.id)`；`abortHandshake`（含 close）定义在 catch **之后**（`:1769-1776`），事件监听器也在 `:1875-1876` 才挂，抛错路径一条都走不到。G5 实测：fake socket 发出带非法头的 upgrade 后，`stats()` 显示 `tunnels:0 reservedTunnels:0`，却有一行 `kind:'tunnel'` 的 `192.168.1.11`；推进 10⁷ ms 后仍旧。同一根因还有 `:1797-1823` 三处 101 后 `socket.write` 抛错的提前 return（此时 `established=true`，`abortHandshake` 变成 no-op，而 `teardown` 到 `:1842-1847` 才注册）——同样不摘条目。**P1-1。**
2. **关闭/错误/中止/拒绝升级的接线**：`abortHandshake`（客户端 close/error、握手段）、`teardown`（两端 error/end/close）、上游 `response`（普通响应拒绝）、上游 `error`（含 15 s 握手兜底 destroy）分别在 `:1773,1838,1854,1868` 调用了 `close`；门禁拒绝（`:1695-1703`）与隧道满（`:1723-1732`）发生在 `touch` **之前**，无需清理。模型 `close(id)` 用 `find` + `filter`，id 不存在时静默 no-op，重复调用幂等（`:169-178`）。**这部分 no finding**；缺口只在第 1 点的提前 return。
3. **反向（会不会误删活跃对端）：会。** 隧道期间同一对端的 HTTP 请求只复用同一条目（`connections.ts:147-155`：`openTunnels>0` 时不改 kind、只刷 `lastSeen`），但 `close(id)` 在 `openTunnels<=1` 时**整条删除**，不检查 `lastSeen` 是否刚被 HTTP 刷新。G6 实测：tunnel touch → +1 s HTTP touch → close ⇒ `{connections:[],count:0}`。**P2-2。**
4. **窗口边界**：`now - lastSeen <= windowMs` 意味着恰好 15,000 ms 仍算在线、15,001 ms 才消失（G6）。需求写「prune 旧于 N」，与实现一致；不算 finding。

### (b) 内存 / DoS、身份伪造 — **no finding（除 P1-1 造成的无界化）**

1. **老化是否在无人读状态时也跑**：`prune(now)` 在 `touch()`（`:144`）与 `view()`（`:181`）各跑一次，因此每次新活动都会顺手清掉所有过期对端；无人读且无人 touch 时数组不变，但没有可观测的 stale 行。
2. **身份来源**：listener 只用 `normalizeIp(req.socket?.remoteAddress)`（`:1278,1737,1038,1898`）；`normalizeIp` 只做 `::ffff:` 剥离与 `0:0:…:1 → ::1`（`:457-460`）。`x-forwarded-for` 只被**追加到发往上游的请求头**（`:626-631`），从不进入活连接模型。故单一 peer 无法通过伪造 XFF 冒充他人；`sanitizePeer` 再把非 IP 字面量折叠成 `已脱敏`（`connections.ts:79-92`）。**无身份伪造面。**
3. **有界性**：正常路径下条目数 ≤ 窗口内有活动的不同 `remoteAddress` 数（每次 touch 先 prune），隧道条目 ≤ `maxUpgradeTunnels`（默认 16）。但 P1-1 的幽灵条目既不被 prune 也不被 cap 限制（cap 只在 `view()` 的 `slice`，`:185`），且同一 peer 每次失败拨号还会把 `openTunnels` 累加（`:149-151`）——这使「有界」声明失效。已计入 P1-1 / P2-5，不另开 finding。

### (c) 脱敏：字段能否携带 token / 查询串 / URL？— **no finding**

1. **存什么**：accept 时只传 socket 对端 IP（`normalizeIp`），`req.url`（含 token 查询串）只进 `buildAuthorizeInput(req)` 交给门禁（`listener.ts:1028,1285`），从不进 `liveConnections`。`entry` 的五个字段由 `present()` 从 `id/peer/transport/sinceMs/lastSeenMs` 现造（`connections.ts:130-137,157-165`）。
2. **id 来源**：`lc-${++seq}`（`:158`），纯递增序号，不取请求行、URL、头或地址文本；`transport` 是四值枚举；`since`/`lastSeen` 是 `toISOString()`。
3. **sanitizePeer**：只接受合法 IPv4 字面量或 `isIPv6()` 通过的 IPv6（去掉 `::ffff:` / 方括号 / `%zone`），其余一律 `已脱敏`（`:79-92`）；`transportLabelOf` 复用 `transportOfBoundAddress`（`:95-101`），不另写正则。
4. **双层断言**：模型 M7（`live-connections-model.test.mjs:103-115`）与 listener L1（`live-connections-listener.test.mjs:85-88,99`）对 `JSON.stringify(view)` 逐项断言不含占位令牌字面量、`?`、`://`。前端再有一层白名单 `readLiveConnections`（`client.js:1156-1177`），非法 peer 退回 `已脱敏`。**结论：无字段可携带 token / 查询串 / URL。**

### (d) 读路径成本 / 是否阻塞 — **no finding（有界性 caveat 已记 P1/P2）**

1. `stats()` 是同步函数，只调用 `liveConnections.view()`（`listener.ts:1971-1981`）；`view()` 内是 `filter`（剪枝）+ `sort`（`sinceMs`/`lastSeenMs`/序号三级比较）+ `slice(cap)`（`connections.ts:179-186`），即 O(n) 剪枝 + O(n log n) 排序，n = 活跃条目数。无 I/O、无网络、无 await、无锁等待，**不阻塞**。
2. `service.status()` 在句柄为空时直接返回 `{connections:[],count:0}`，不调用 listener（`service.ts:1022-1026`），停监听后读路径更轻且不可能拿到旧快照。
3. caveat：n 的「有界」依赖 P1-1 修复与 P2-5 的措辞收敛；当前幽灵条目可使 n 无法随窗口收敛。

---

## 3 断言纪律 (e)

逐条 diff 四份 retarget 文件 against HEAD（`git diff HEAD -- <4 files>`，只读），按 `path:line` 分类：

| 文件:行 | 变更 | 分类 | 说明 |
| --- | --- | --- | --- |
| `test/client-module.test.mjs:31-34` | action 清单去掉 `pairingConnections` | **retarget（极性反转，等严）** | 旧正向断言「调用历史审计 RPC」被需求明确作废；同一调用点由 `:36` 的反向断言钉住，不是静默删除 |
| `test/client-module.test.mjs:36` | 新增 `assert.equal(source.includes("rpcCall('pairingConnections'"), false)` | **更严** | 钉死历史 RPC 不得复活 |
| `test/client-module.test.mjs:37` | 新增 `assert.ok(source.includes('status.liveConnections'))` | **更严（新增断言）** | 钉住新数据源 |
| `test/client-remote-render.test.mjs:686` | `'谁连进来过'` → `'当前连接','当前没有设备连接'` | **retarget（1→2 条，偏更严）** | 旧标题断言由新标题 + 新空态断言替代；`:688-694` 全部旧断言未删 |
| `test/locale.test.mjs:121` | `shippedKeys` 新增 3 个 live key | **更严** | 逐条点名，旧 key 一条未删 |
| `test/locale.test.mjs:144` | 精确计数 `86 → 89` | **retarget（等严）** | 仍是精确相等断言，随新增 3 key 调整 |
| `test/locale.test.mjs:165-177` | 新增 key 存在/非空/异文/占位符 + 标题/空态逐字断言 | **更严（新增 13 条）** | 旧 `:146-164` 断言逐字保留 |
| `test/pairing-client-wiring.test.mjs:218-260` | `remoteGetState` 夹具增加两条 `liveConnections` 记录 | 新增夹具（非断言） | 为 W5 提供 HTTP + 隧道两种形状 |
| `test/pairing-client-wiring.test.mjs:286-293` | W1 去掉 `pairingConnections` 正向清单项、加入 `:293` 反向断言 | **retarget（等严）** | 同一 RPC 调用点仍被钉住，只是极性按需求反转；`pairingShow`/剪贴板旧断言保留 |
| `test/pairing-client-wiring.test.mjs:344-357` | W5 由「时间 + 打码身份 + 无完整地址」换成「逐行格式 + 隧道标记 + 无历史文案 + token/?/URL 三项否定」 | **retarget（整体更严）** | 旧「不显示完整地址」按新需求反转（现在必须显示 `192.168.1.11`）；token 卫生旧断言 `:354` 逐字保留并新增 `:355-356` |
| `test/pairing-client-wiring.test.mjs:359-372` | W5b 新用例 | **新增** | 空态必须显示「当前没有设备连接」且 0 行 / 1 个空态节点 |
| `test/live-connections-model.test.mjs:27-116`、`test/live-connections-listener.test.mjs:61-103` | M1–M7、L1 全新文件 | **新增** | 注入时钟、窗口、隧道保活、stop 清空、cap+tail、双假对端老化、无 token/? |

**总账**：静默删除 = 0；显式 retarget = 4（client-module 清单、client-remote-render 标题、locale 计数、W1/W5 极性反转）；更严/新增断言 ≥ 20 条；放宽 = 0。按字面「任何被删断言记 P1」的口径，候选只有上述 4 处被显式替换的旧形式断言——每一处都在同一 `file:line` 邻域有等价或更强的替身且由产品需求要求，**不判为 P1 静默删除**；若门禁坚持字面计数，请按这 4 行复核而不是扩大到全文件。

---

## 4 dist (f)

- 方法照 `docs/REVIEW-b11-ff-vp.md` §1.2 G6：TypeScript `transpileModule`，`target ES2022 / module ESNext / esModuleInterop`，先以未改的 `src/remote/pairingTransport.ts → dist/remote/pairingTransport.js` 校准得到 MATCH，再比四份目标 TS；`dist/client.js` 按 `scripts/build.mjs:24-42` 的 loader-id 重写规则在内存中重建后比较。
- 结果（`.tmp/gates-rvlc-distcheck.out`）：

| 文件 | emit SHA-256 = dist SHA-256 | 字节 |
| --- | --- | --- |
| `dist/remote/connections.js` | `0C19B5AB53F1F02C6159AEFA5ADC5BA1E6B79EE919547780923A627FA17057EF` | 6,024 / 6,024 |
| `dist/remote/listener.js` | `84E5B0C597C4CA56308D9FC3C7617C45BC2B334D81C3D6F3283B9EDFC46FA12A` | 79,658 / 79,658 |
| `dist/remote/service.js` | `4FD5D4C863D1AE38CC02D8B795CBEF938D39A4C74FC69E4FD16048161FFE6A48` | 72,306 / 72,306 |
| `dist/remote/types.js` | `DD178293A96267FE3AB2085E082F726202A4F2F02D655A659C37BB1BC55A44CE` | 271 / 271 |
| `dist/client.js` | `9BB8F9C66129E8F91B1BCF8AB79D202F0507495FB16D69C709414ED4F62BF517` | 80,297 / 80,297 |

- **5/5 MATCH，0 mismatch**；起止哈希全等（§1.3）证明评审窗口内这五份未被并发重建；未运行 build、未写 dist。并发车道的改动只出现在 `dist/rpc.js` / `dist/sync/bootstrap.js` 与 app 侧，不属本模块。

---

## 5 诚实性 (g)

| 句子 / 声明 | 证据 | 裁定 |
| --- | --- | --- |
| `connections.ts:14-15`「隧道关闭立即删条目；…绝不留下僵死行」 | G5 复现抛错路径留下 `openTunnels=1` 的永久条目 | **与事实不符 ⇒ P1-1** |
| `listener.ts:1772`「握手没成功就不是『正在查看』：立刻从当前连接里摘掉，不留僵尸行」 | 该代码只在 `abortHandshake` 内；`:1755` 抛错早于其定义与监听器注册 | **过度 ⇒ P1-1** |
| `listener.ts:1979-1980`「每次读都先剪枝：静默消失的对端不会在面板上僵住」 | view 确实 prune，但 `openTunnels>0` 条目被豁免 | **部分支持 ⇒ P1-1** |
| `types.ts:280`「监听停止时句柄为空 ⇒ `{connections:[],count:0}`，绝不是旧数据」 | `service.ts:1022-1026` + `listener.ts:1209` 双向证明（无句柄直接空、shutdown 同步 clear、L1 实测） | 支持 |
| `connections.ts:46-50`「实测这类突发基本在 1~3 秒内结束」 | 仓库内无该测量的脚本、数据或门限记录；M2 只证明 40 次请求折叠，不证明时长 | **未证实 ⇒ P2-5** |
| `connections.ts:53-54`「恶意对端刷 IP 也只能占用这么多行」 | cap 只作用于 `view()` 的 `slice(0,cap)`；`entries` 数组无长度上限 | **过度（显示≠内存）⇒ P2-5** |
| `client.js:1152`「挂载只调 pairingProvision / pairingTransports / pairingConnections / remoteGetState」 | `:1284-1302` 已删除 pairingConnections 调用；新测 `:36` 与 W1 `:293` 反向钉住 | **陈旧 ⇒ P2-4** |
| `client.js:1235`「引擎每次读都会剪枝」 | 引擎侧成立；但面板挂载后**不再读**，见下条 | 部分支持，与 P2-1 合看 |
| 「live / 当前连接」整体承诺（`client.js:1187,1290`、`listener.ts:1142-1145`） | 只有挂载/start/stop 三次读，无轮询；UI 打开后不刷新 | **过度 ⇒ P2-1** |
| `README`/测试头「当前连接」文案、空态、逐行格式、隧道标记、「还有 N 个」 | locale + `client.js:1588-1608` + M6 + W5/W5b 逐字断言 | 支持 |
| 「status 形状 additive，现有 `RemoteStatus` 字段不动」 | `types.ts:273-282` 只新增 `liveConnections`；`connections:{active,total}` 仍在 `service.ts:1053` 逐字沿用 | 支持 |
| 「无 token / 无 `?` / 无 URL」 | 存/取/前端三层白名单 + M7 + L1 断言；字段名 `liveConnections` 而非需求散文里的 `connections`，但既有 `connections` 计数未被占用，形状仍 additive | 支持 |
| `docs/MODULES.md` §7.x | 全文无本模块行；§7.6/§7.7 分别属 FF 与已撤回的 viewport | **缺位 ⇒ P2-6**（无过度声明可抓） |

---

## 6 发现清单

| 级别 | 位置 | 证据 | 影响 | 建议 |
| --- | --- | --- | --- | --- |
| **P1-1** | `packages/dsh-dots/src/remote/listener.ts:1744-1761`（主因）、`1797-1823`（同类二次路径）；`packages/dsh-dots/src/remote/connections.ts:127-129,149-151,169-178` | `.tmp/gates-rvlc-probe-phantom.out`：假 upgrade 触发同步抛错后 `tunnels:0 reservedTunnels:0 liveConnections.count:1`，推进 10⁷ ms 后该 `kind:'tunnel'` 条目仍在（条目 id `lc-1`） | 根本没有隧道的对端永久显示「正在查看」，直接违背「列表不能撒谎」；同一 peer 反复失败拨号还会无限累加 `openTunnels`，使内存/有界性声明失效 | 在 `:1755` catch 内补 `liveConnections.close(liveEntry.id)`；把 `:1799-1823` 三处写失败提前 return 也统一收口（例如在 `established` 分支注册 `teardown` 后再写头，或用 `try/finally` + 已建立守卫）；补一条探针级测试：拨号抛错后 `stats().liveConnections.count === 0` 且推进窗口后仍为 0 |
| P2-1 | `packages/dsh-dots/src/client.js:1284-1302,1397,1436` | 全文件无 `setInterval`；`remoteGetState` 仅三处调用（挂载、doStop、doStart 后） | 面板开着时不出现新对端，静默对端也不从 UI 消失，「live」只是打开瞬间的快照 | 增加有界轮询（如 5–10 s）或在需求里明确改为「打开时刷新一次」并去掉 live 措辞；轮询须在卸载时清理 |
| P2-2 | `packages/dsh-dots/src/remote/connections.ts:169-178` | `.tmp/gates-rvlc-probe-boundary.out`：`AFTER_CLOSE_WITH_FRESH_HTTP` 为 `{"connections":[],"count":0}` | 隧道关闭瞬间抹掉刚刚有 HTTP 活动的对端，产生假阴性 | `close` 时若 `now - lastSeen <= windowMs`，把 kind 降回 `http` 而非删条目；只有最后一条隧道关闭且窗口内无 HTTP 证据时才删 |
| P2-3 | `packages/dsh-dots/src/remote/listener.ts:1278` vs `1283-1301,1683-1705,1737` | HTTP 在门禁前 touch；W5 夹具本身用 `authorize: () => respond 200` 且仍被计入 | 被鉴权拒绝的扫描/爬虫会以「当前连接」身份上屏；与 upgrade 路径口径不一致 | 把 HTTP touch 移到 `normalizeDecision(await authorize(...))` 且放行/自有接口之后；或明确口径为「有入站请求即算连接」并同步改测试/文案 |
| P2-4 | `packages/dsh-dots/src/client.js:1152` | 注释列 `pairingConnections` 为挂载调用，实际 `:1284-1302` 已无该调用；`test/client-module.test.mjs:36` 反向断言 | 误导后来维护者恢复历史审计 RPC | 注释改为「挂载只调 pairingProvision / pairingTransports / remoteGetState」 |
| P2-5 | `packages/dsh-dots/src/remote/connections.ts:45-54,125,185` | 「实测 1~3 秒」无仓库数据；`entries` 无长度限制，cap 只在 `view()` 生效 | 窗口选择理由与 DoS 边界被表述得比证据强 | 把「实测」改为「设计取值，突发静默期未做独立测量」；把「只能占用这么多行」改为「面板最多显示 5 行；内存条目随窗口内不同对端数增长（另有隧道上限 16）」 |
| P2-6 | `docs/MODULES.md:782-812`（缺 §7.8 行） | `git diff HEAD -- docs/MODULES.md` 只含 FF / viewport / 路由偏差记账，无 live-connections 行 | 冻结后缺回滚路径、证据台账与「未装机/unverified」口径 | 在 §7 追加本模块行：18 路径、回滚步骤、门禁 tail（`48/48`、`1099/1097/0/2`）、dist G4、真机 `unverified` |

**非模块缺陷（并发车道漂移，记录但不计入计数）**：`git status` 结束态相对起始态新增 app 侧 `instanceDelete.ts`、`SettingsInstances.ets`、`instanceDelete.test.mjs` 等 9 条路径；起始即存在且非本模块的 `src/rpc.ts`、`src/sync/bootstrap.ts`、`dist/rpc.js`、`dist/sync/bootstrap.js` 亦属他车道。18 路径起止哈希全等，未受影响。

---

## 7 `unverified`

1. **幽灵条目的真实可达性**：G5 用假 socket 注入了真实 HTTP 解析器会先拒绝的非法头值，证明**代码路径**存在且模型永不老化；真实 TLS 解析后的 `req.headers` 是否能喂出同步抛错，未在真机/真实 listener 上验证。101 后 `socket.write` 抛错同理。
2. **真机行为**：平板实际打开面板后的刷新频率、隧道关闭瞬间的帧序、中文文案在真机面板的换行/截断，全部未验证；本模块未装机。
3. **面板轮询**：G1/G2/G3 只证明挂载/start/stop 时拿到正确快照；没有测试覆盖「面板持续打开 30 秒后新对端出现」。（P2-1）
4. **窗口 N 的取值依据**：「1~3 秒突发」未做独立测量；15 s 是设计取舍而非实测结论。（P2-5）
5. **`transport` 在公网 IPv4 对端上的语义**：`transportOfBoundAddress` 对公网 IPv4 返回 null ⇒ `未知`，符合枚举但真机文案观感未验证。
6. **并发构建后的 dist**：冻结前若另一条车道再次运行 `node scripts/build.mjs`，本次 G4 的 5/5 MATCH 与起止哈希结论需重跑。
7. **断言纪律的字面口径**：§3 的 4 处 retarget 是否计作「删除断言」取决于门禁口径，已逐行列明替身位置，未自行放宽判定。

---

## 8 冻结建议

- **裁决：Block（P1=1 未修）。** 修复 P1-1 后本模块可立即转 Freeze-with-fixes：补 `close` 收口 + 一条「拨号失败后视图为空且不复活」的回归测试，再由原车道重跑 G2/G3/G4（本评审不重跑 build）。
- 同时要求原车道收敛 P2-1（轮询或改口）、P2-2（close 保留窗口内 HTTP 证据）、P2-3（HTTP 门禁后 touch）、P2-4（注释）、P2-5（窗口/文案）、P2-6（MODULES §7.8 登记）。
- 回滚路径尚未在 `docs/MODULES.md` 登记（P2-6）；冻结前必须补齐，否则 18 路径无法原子回滚。
- **不得**把另一条 app 车道的新增文件、`dist/rpc.js` / `dist/sync/bootstrap.js` 漂移或任何非本模块的套件红算到本批头上；本次全量套件为 1099/1097/0/2、exit 0。
- 本评审未修改任何源、测试、dist 或 git 状态；唯一拟写入的仓库文件是本文件，探针输出仅在 gitignored `.tmp/`。

---

## 9 追加复审（2026-11-27，修复轮，仅验四项 + 断言纪律）

- 范围：只复核 P1-1 / P2-1 / P2-2 / P2-3 四项修复与本轮唯一 retarget 区域；§0–§8 的已清空项（身份伪造、脱敏、读路径成本、四份 retarget 断言、dist）**保持 cleared**，本轮没有反证。
- 新证据（全部只读，落 `packages/dsh-dots/.tmp/`）：`gates-rvlc-lc2-targeted.out`（本评审自跑 `node --test test/live-connections-{listener,model}.test.mjs`：`tests 11 / pass 11 / fail 0 / skipped 0`，`EXIT=0`）、`gates-rvlc-lc2-poll.out`（本评审自写轮询生命周期探针）。
- 车道捕获：`gates-lc2-prefix-repro.out`（修前 L2 在 `test/live-connections-listener.test.mjs:137` 以 `1 !== 0` 失败，`EXIT=1`）；`gates-lc2-suite-1.out` `1102 / 1100 / 0 / 2`（`SUITE1_EXIT=0`）；`gates-lc2-suite-2.out` 红，**唯一失败 PO-07 在 `test/plugin-pending-ownership.test.mjs:366`**，原因是**另一条车道在 22:56:27 编辑 `src/sync/cycle.ts`**（与本模块零交集，按记录保留，不计本模块）；`gates-lc2-suite-2b.out` 该文件恢复后 `1102 / 1100 / 0 / 2`（`SUITE2B_EXIT=0`）；`gates-lc2-app.out` `3379 / 3379 / 0 / 0`；`gates-lc2-build.out` / `gates-lc2-tsc.out` 均 `EXIT=0`；`gates-lc2-distcheck.out` `DIST-FRESHNESS: 78 files, 0 mismatch`，窗口 7 份（本模块 5 + marksynced 的 `rpc.js`/`sync/bootstrap.js`）。本评审**未重跑 build**。
- HEAD 起止未变（`8c82402…`），未执行任何 git 写命令。

### 9.1 四项修复逐条

1. **P1-1 — no finding。** `listener.ts:1761-1768` 的 `releaseLive()` 带 `liveReleased` 幂等闸并自 `liveReleasers` 摘除；同步抛错 `:1790`、握手中止 `:1806`、101 后三处写失败 `:1838/:1849/:1860`、teardown `:1880`、上游拒绝升级 `:1896`、上游 error `:1910`、shutdown `:1216`（先逐个 release 再 `clear()`，遍历的是 `[...liveReleasers]` 副本）全部经过它。模型侧 `connections.ts:133-141` 的不变式由 `:155-169` 的 prune 执行：未转正预约过 `leaseExpiresMs`（15 s）自动归零退役；confirmed 隧道靠 `confirm()`（`:217-224`）长期保活，关闭则 `:225-246` 退役或降级，删条目只有 prune 一个入口。修前复现 `gates-lc2-prefix-repro.out` 确在 `:137` 以 `1 !== 0` 红；本评审自跑 L2（`:119`，含推进 10⁷ ms 后仍 `count:0` 与无 token）与 M8/M9 全绿（11/11）。
2. **P2-1 — no finding。** `client.js:1183` `LIVE_POLL_MS=5_000`；`pollLiveConnections()`（`:1270-1281`）只读 `remoteGetState`，`livePolling` ref 在飞去重；定时器只由挂载 effect 的 `startLivePoll`/`stopLivePoll`（`:1332-1349`）管理，unmount cleanup `:1354-1360` 清定时器并摘 `visibilitychange`，hidden 立即停表（`:1346-1348`），`doc===null` 不建表。自有探针 `gates-rvlc-lc2-poll.out`：挂载 1 个定时器、70 ms 内 5 次读；卸载后定时器 0、监听器 0、70 ms 内 RPC 数不再增长；再次挂载仍 1 个定时器（无跨开关周期泄漏）。同时挂载多个面板时各建各的表（3 个面板 70 ms 内 15 次读）——**这是按实例设计，不是泄漏**：shipped 接线只注册一个 `settings.section`，单页不可达两个面板；列于 §9.3 unverified，不上报 finding。
3. **P2-2 — no finding。** `connections.ts:225-246`：`lastHttpMs` 只由 HTTP touch 刷新（`:189-193`），`close()` 先 `openTunnels=0/confirmed=false`，仅当 `now - lastHttpMs <= windowMs` 时 `kind='http'` 保留（`:239-242`），否则标 `retired`（`:244-245`）交 prune 删除；`windowMs` 仍是 15_000（`:54`），未放宽窗口。顺序修正确在 close 路径，M8（`:128-135`）与 M4（`:81-86`）钉住「关闭后先降级、再按窗口消失」。
4. **P2-3 — no finding。** `listener.ts:1289-1320`：无 authorize ⇒ 直接 touch；门禁抛错/≥400 ⇒ 提前 return 不 touch（`:1300-1305`、`:1309-1312`）；自检/2xx 接口 `:1312-1315` touch；放行请求 `:1319` 在 `forwardRequest` 前 touch。401/403 扫描不会再上屏，2xx 与转发请求仍计入；身份仍只取 `remoteAddress`（未触碰已清空的身份/脱敏结论）。

### 9.2 断言纪律（仅修复轮）

- 唯一 retarget 区域 `test/live-connections-model.test.mjs:66-87`（该文件为新增文件，基线是本评审 §1 冻结时读到的 `:66-77`）：
  - 两条隧道保活断言 `:79`（`alive.count===1` + 原文案）与 `:80`（`kind==='tunnel'` + 原文案）**逐字保留**；前置加了 `model.confirm(tunnel.id)`（`:75`，模拟真实 101）⇒ **等严/更严**（前提更明确，断言一字未动）。
  - 旧末句 `assert.equal(model.view().count, 0, '隧道关闭必须立即删掉，不等窗口到期')` 被替换为 `:83` `after.count===1`、`:84` `after.kind==='http'`、`:86` `advance(WINDOW+1) ⇒ count 0`，并有 `:67-69` 显式 retarget 注释 ⇒ **retarget（更严）**：旧断言是需求变更前口径，同一调用点由三条更细断言钉住且最终仍断言 `count 0`，不是静默删除。
- 新增 M8（`:128-135`）、M9（修复轮新文件尾部）与 listener L2（`:118-146`）均为**新增**，无旧断言可删。
- **结论：本轮放宽 = 0，静默删除 = 0，P1 = 0。** 若门禁按字面把旧 `count 0` 计作「删除」，唯一候选是上述 `:76 → :83-86` 这一处，已具备显式替身与需求依据。

### 9.3 `unverified` 与新记录

1. 多面板共存（同页两个 `LeanRemoteGroup`）尚未在真机/宿主验证；当前 shipped 只注册一个 section，故按实例轮询不构成泄漏。
2. 内核静默丢弃监听/对端 TCP 且**不产生任何 error/end/close 事件**时，模型无法知道 socket 已关，仍会按窗口/租约展示——这是信号缺失，不是代码路径漏接；本轮不改变 §7 的该项边界。
3. `gates-lc2-suite-2.out` 的 PO-07 红已按车道说明归因于 22:56:27 的 `src/sync/cycle.ts` 编辑，恢复后 `suite-2b` 全绿；不得算作本模块回归。
4. 本轮未重跑 build，dist 一致性以车道 `gates-lc2-distcheck.out`（78/78、0 mismatch）与 §4 方法为准；若冻结前再次构建须重取该证据。

### 9.4 追加裁决

- **四项修复全部清洁，断言纪律清洁：本轮 0 finding。** §0 的 **Block 现已解除**：P1-1 已修并有修前红/修后绿双向证据，P2-1/P2-2/P2-3 均已闭合。
- **可以提交本模块**（以 `suite-2b` 与 `app` 全绿、`build/tsc EXIT=0`、`distcheck 78/78` 为门禁证据）；P2-4 / P2-5 / P2-6 属文案与登记项，不阻塞代码冻结，但仍应在同一提交内收敛（尤其 `docs/MODULES.md` §7.8 回滚登记）。
- 本轮仍未改任何源、测试、dist 或 git 状态；唯一写入是本文件与 gitignored `.tmp/gates-rvlc-lc2-*`。
