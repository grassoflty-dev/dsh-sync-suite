# 独立只读评审（第二次）— batch b11b：`mod-plugin-push-auth-vs-network` + `mod-plugin-gui-proxy-r2`

> 评审对象：`main` @ **`f624a9f`** 之上的**未提交**工作树（不是任务书写的 `7bc977a`：b11 的两个模块已在 `6fdccb1` / `6a662d8` 提交，其后 `843890f` / `85993de` / `c7271c1` / `f624a9f` 只动文档）。
> 评审方式：读码 + 复跑门禁 + 只读诱探（`node -` 走 stdin，不落任何探针文件）；**未** commit / 未 push / 未跑同步周期 / 未用 `hdc` / 未联网 / 未安装。
> 本评审只写两个东西：本文件 + 门禁留存 `.tmp/gates-rv2-*.out`（见 §1.2）；源码 / 测试 / dist / 其它文档**一字未改**（`git status --porcelain` 评审前后除本文件外都是同 14 条，见 §1.4）。
> 为了和 `docs/REVIEW-b11-batch.md`（下称 **b11 评审**）对照，本文所有行号都是**当前工作树**的行号。

---

## 0 结论

- **P0 = 0，P1 = 1，P2 = 8。**
- 一句话裁决：**不可按现状冻结**。唯一的 P1 是「407 的真实形状认不出来」——`git`/`libcurl` 走 HTTPS 代理时的标准文案 `Received HTTP code 407 from proxy after CONNECT` / `CONNECT tunnel failed, response 407` **不匹配**新加的状态码形状表，于是 407 仍然落到「网络不可达」；而模块声明（`docs/MODULES.md` 新增行）与测试（B2 / T14）都说 407 已经被单独分出来。**修法是一行正则 + 两条用例**（§5 P1-1），修完即可冻结；8 条 P2 全部不阻断，其中 3 条（P2-2 的下一步自相矛盾、P2-3 的 5xx 归因、P2-5 的 `close()` 之后仍可能新增预约）建议同批修。
- 增量 A（`mod-plugin-push-auth-vs-network`）的**核心承诺成立**：Gitee 那句 403（b11 P2-6 的原串）现在判成 `auth-rejected`（`details.status=403`），文案「远端拒绝了这个用户名或令牌」，下一步指向登录名/令牌而不是网络；状态码分支**确实排在一切文本匹配之前**，结构 `timeout` 仍然优先，令牌形态的 stderr 不进 message / details。
- 增量 B（`mod-plugin-gui-proxy-r2`）的**两个 P2 收口都成立**：隧道上限改成「已建立 + 已预约」，五个释放路径**恰好归还一次**（幂等对象，`Set` 计数不会扣成负数，也不会误放别人的槽）；LAN 跳过从静态 `skip` 改成运行期具名 `t.skip(…)` 并加台账，本机跑出 `total=13 ran=13 skipped=0`（listener）与 `total=35 ran=35 skipped=0`（fence），台账用例自身四条断言把「空过」堵住。
- **没有既有断言被删除或放宽**：四个测试文件的删除行合计 20 行，全部是夹具 / skip 选项 / 注释 / 计数；三条 `5 → 9` 是等价严格度的 retarget（§6）。
- **没有既有行为回归**：结构 timeout、空闲预算（含 SSE 豁免与背压挂起）、401 单飞与「成功才覆盖缓存」、Origin 同源改写全部原样在场且被原有用例覆盖（§4）。

---

## 1 复核范围与证据

### 1.1 实际 diff 范围（`git status --porcelain`，共 14 条，不含本评审新增的本文件）

| 类别 | 文件 | 说明 |
| --- | --- | --- |
| A 源码 | `packages/dsh-dots/src/engine/git.ts`（+138） | 单一来源状态码分类器 + `failure()` 状态码分支 |
| A 源码 | `src/sync/gitPort.ts`（+125/−?） | 九类 `PushReason`、`textFailureOf()`、`pushFailure()` 带 `details.status` |
| A 源码 | `src/sync/cycle.ts`（+63） | 四条新下一步、`PUSH_NEXT_STEP` 全表、白名单 5→9 |
| A 测试 | `test/push-auth-classification.test.mjs`（新，588 行 / 16 例） | A1–A4、B1–B8、C1、D1–D3 |
| A 测试 | `test/git-timeout-classification.test.mjs`（+72，0 删） | T14 / T15 |
| A 测试 | `test/plugin-pending-ownership.test.mjs`（+17/−6） | census retarget 5→9 |
| B 源码 | `src/remote/listener.ts`（+131） | 预约槽 / 幂等释放 / `close()` 同步归还 / `stats()` 追加两个字段 |
| B 测试 | `test/remote-listener.test.mjs`（+279/−7） | 3 条 P2-A 用例 + LAN 台账 + `waitFor` |
| B 测试 | `test/gui-proxy-fence.test.mjs`（+80/−7） | LAN 台账 |
| 产物 | `dist/engine/git.js`、`dist/remote/listener.js`、`dist/sync/cycle.js`、`dist/sync/gitPort.js` | 与 4 个改过的 `.ts` 一一对应 |
| 文档 | `docs/MODULES.md`（+3） | 两个模块的登记行（评审开始后才出现，见 §1.4） |

- 无 `package.json` / lockfile / `apps/**` / `.ets` / `compileSdk` 变更 ⇒ 无新依赖、平板侧零字段。
- 任务书给的文件清单**遗漏** `docs/MODULES.md`（评审期间被另一条 lane 写入，`LastWriteTime = 2026-11-24 01:58:14`）；它是模块登记义务的一部分，不算夹带。

### 1.2 门禁复跑（本评审自跑，`Tee-Object` 全部留存在仓库根 `.tmp/`）

工作目录 `packages/dsh-dots`：

| 命令 | 留存文件（绝对路径） | 结果 |
| --- | --- | --- |
| `node scripts/build.mjs` | `C:\Users\GWL\Desktop\itwillclaude\dsh-sync-suite\.tmp\gates-rv2-build.out` | exit 0（1.72 s） |
| `node ../../node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | **`.tmp\gates-rv2-tsc.exit.out`**（tsc 零输出，`Tee-Object` 因此没有生成 `gates-rv2-tsc.out`——这里如实记录，不伪造空文件） | exit 0（1.54 s，stdout+stderr = 0 行） |
| `node .tmp\distcheck-j3.mjs` | `.tmp\gates-rv2-distcheck.out` | exit 0 |
| `node --test test/*.test.mjs`（第 1 次） | `.tmp\gates-rv2-plugin1.out` | exit 0（51.1 s） |
| `node --test test/*.test.mjs`（第 2 次） | `.tmp\gates-rv2-plugin2.out` | exit 0（51.7 s） |
| 仓库根 `node --test "apps/arkui-schedule/tools/test/*.test.mjs"` | `.tmp\gates-rv2-app.out` | exit 0（14.5 s） |

逐个原文尾巴：

```
[plugin] dist/index.js + dist/client.js 已生成          （build，exit 0）
```

```
（tsc：零输出，exit 0）                                  （.tmp/gates-rv2-tsc.exit.out 只有 EXITCODE=0 ELAPSED_MS=1535）
```

```
DIST-FRESHNESS: 75 files, 0 mismatch
DIST-WINDOW: 4 dist/*.js differ from HEAD
  modified dist/engine/git.js 46916 B
  modified dist/remote/listener.js 73755 B
  modified dist/sync/cycle.js 55144 B
  modified dist/sync/gitPort.js 21000 B
```

```
ℹ tests 965
ℹ suites 0
ℹ pass 963
ℹ fail 0
ℹ cancelled 0
ℹ skipped 2
ℹ todo 0
ℹ duration_ms 51058.7248          （第 1 次）
```

```
ℹ tests 965
ℹ suites 0
ℹ pass 963
ℹ fail 0
ℹ cancelled 0
ℹ skipped 2
ℹ todo 0
ℹ duration_ms 51643.3135          （第 2 次）
```

```
ℹ tests 3234
ℹ suites 461
ℹ pass 3234
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 14269.4677          （app 侧）
```

- 两次插件全量的**用例数、通过数、跳过数完全相同**（965 / 963 / 0 / 2），只有耗时差 0.6 s ⇒ 没有顺序相关或抖动失败。
- 2 个 skip 是既有的环境项，不是本批新增：`F10 store: 0600 权限（Windows 无 POSIX 0600 语义）`、`fetch 直连时…（本机 NODE_USE_ENV_PROXY + HTTP_PROXY 接管）`。**两个 LAN 测试文件本机 0 skip**（见 §3.5）。
- Node 版本：`v24.14.0`。

### 1.3 dist 结论

- `dist/` 与「当前 `src/` 的一次全新 tsc emit」**逐字节一致：75 文件 / 0 mismatch**。
- 与 `f624a9f`（HEAD）的差异恰好 4 个 `.js`，对应 4 个改过的 `.ts`，没有多生成、没有漏生成 ⇒ 按 `docs/MODULES.md` §0 规则 9 的插件对等条款，本批「已编译」成立。
- 本评审跑 `scripts/build.mjs` 之后 `distcheck` 仍是 75/0 ⇒ 门禁运行没有把产物改成不一致状态。

### 1.4 树在评审期间被并发修改（必须记录）

- 评审开始（01:57）时 `git status` 13 条；01:58:14 `docs/MODULES.md` 被另一条 lane 写入（+3 行，两个模块登记）。
- 本评审的门禁在 01:59–02:04 运行，覆盖的是 `MODULES.md` 落地**之后**的树；§1.1 的 14 条即最终快照。评审结束前再查一次 `git status`，仍是同 14 条。
- 因此 §5 的 P2-6（文档口径）按「登记行已存在」判断；若 Lead 在提交前继续改这两行，那一条可能自愈。

### 1.5 与 b11 评审的数字勾稽（为什么 suite 从 936 变成 965）

| 时点 | 插件全量 | 证据 |
| --- | --- | --- |
| b11 评审（`REVIEW-b11-batch.md` §1.2） | **936 / 934 / 0 / 2** | 该文件 §1.2 |
| b11 评审后加修（F1 401 单飞、F2 空闲预算、F3 LAN 取址）→ 已随 `6fdccb1` / `6a662d8` 提交 | **942 / 940 / 0 / 2** | `docs/MODULES.md` 的 b12 证据块 |
| 本次（+ 增量 A 23 例） | **965 / 963 / 0 / 2** | §1.2 |

942 + 23 = 965，逐条可点：`push-auth-classification.test.mjs` **16** 例（A1–A4 / B1–B8 / C1 / D1–D3）、`git-timeout-classification.test.mjs` **2** 例（T14 / T15）、`remote-listener.test.mjs` **4** 例（3 条 P2-A + 1 条台账）、`gui-proxy-fence.test.mjs` **1** 例（台账）。**没有任何用例被删掉来凑数。**

> 顺带纠正一个容易误读的点：b11 评审看到的 `remote-listener.test.mjs` 是 `+542`、`gui-proxy-fence.test.mjs` 是 939 行；当前提交版是 `+716` / 1139 行。差出来的正是 F1/F2/F3 的用例——**不属于本次两个增量**，但按任务书第 4 条仍要复核它们没被削弱（§4）。

### 1.6 b11 评审 §4 十条 P2 的现状（逐条）

| # | b11 的发现 | 谁声称关闭 | 实际 |
| --- | --- | --- | --- |
| P2-1 | 空闲预算把「合法但安静」的流截断 | b11 后加修 F2（**不是**本次两个增量） | **已关闭**：`listener.ts:1448-1497` 双向重置 + 背压挂起 + `OPEN_ENDED_STREAM_RE`（`:296`）对 SSE/multipart 整个不起表。本次未触碰。 |
| P2-2 | 401 换身份先清缓存、失败后 6 h 无身份、无单飞 | b11 后加修 F1（**不是**本次增量） | **已关闭**：`service.ts:343-357` 的 `mintOnce()` 单飞且「成功才替换」，`upstreamCookie()` / `refreshUpstreamAfter401()` 都走它。本次未触碰。 |
| P2-3 | 401 重试第二次派发不复检客户端状态 | b11 后加修 F1（**不是**本次增量） | **部分关闭**：`:1403` 只补了 `res.writableEnded || res.headersSent`，**仍未**复检 `closed` / `res.destroyed` ⇒ 客户端在换身份窗口内断开时仍会向上游发第二个请求（有界浪费，不损坏）。本次未触碰，列在 §8 的遗留项。 |
| P2-4 | 隧道上限只数「已建立」，握手期可超限 | **增量 B** | **已关闭**：`listener.ts:1125-1140`（准入＝`tunnels.size + reservations.size`）、`:1651`、`:1705`、三处失败释放；用例 `remote-listener.test.mjs:1457`。**但 `close()` 那条不变式有潜伏例外**（§5 P2-5）。 |
| P2-5 | Windows 孙进程持管道，120 s 不结算 | 无人声称 | **仍未验证**（本次没有真实挂死场景；标 `unverified`）。 |
| P2-6 | push 的 401/403 被文案归成「网络不可达」 | **增量 A** | **主诉已关闭**（401/403）；**同类还漏三块**：407 的真实形状（§5 P1-1）、404/3xx（§5 P2-1）、无数字状态码的 `Authentication failed`（§5 P2-2）。 |
| P2-7 | 预算口径旧文档仍写 `8 s` | 部分修复（b11 后加修） | **部分关闭**：`docs/CONTRACT.md:256`、`docs/CONFIG-UX.md:63,127` 已改成三档；`packages/dsh-dots/docs/DETAIL.md:248`（英文详情，`meta.detail` 指向它）与 `docs/VERIFICATION.md:87,204` **仍写 8000**（§5 P2-7）。 |
| P2-8 | `MODULES.md` 两行渲染坏 + 批次号写成 b12 | 部分修复 | **表行已修**（新增两行紧贴上一行）；**批次号仍是 b12**（`docs/MODULES.md:693` 那句「batch b12 证据」），且该证据块里的 **942** 已落后于现状 965（§5 P2-6）。 |
| P2-9 | `RESEARCH-B` 行号漂移 + 「401 透传」口径 | 无人声称 | **仍未修**（`docs/RESEARCH-B-dsh-gui-proxy.md:22,73-75,91,94` 原样）。 |
| P2-10 | LAN 取址抖动 + 250 ms 墙钟断言 | **增量 B 的后半**（具名 skip + 台账） | **取址与墙钟已关闭**（`findBindableLanAddress` 真绑+真连、`gui-proxy-fence.test.mjs:787-807` 改成「相对注入延迟」的事件顺序断言）；**「跳过=静默失覆盖」已关闭**（台账）；**抖动本身**只能说到「更强了」，不能说到「已修」（§7）。 |

---

## 2 增量 A 逐项验收（`mod-plugin-push-auth-vs-network`）

### 2.1 分类顺序：状态码确实排在一切文本匹配之前

- `GitRepo.failure()`：`git.ts:617` 入口，**第一件事**是 `const statusHit = httpStatusFailureOf(text)`（`:619`），命中即 return（`:620-634`）；之后才是 `isAuthFailure` / `hasTransportEvidence`（`:642-645`）。⇒ 结构 timeout（`:689-701`，在 `run()` 里 reject，根本进不到 `failure()`） > HTTP 状态码 > 鉴权文本 > 传输证据 > 兜底。
- `GitRepoV2Port`：`textFailureOf()`（`gitPort.ts:241-249`）同样状态码第一；`pushFailureReason()`（`:253-258`）的顺序是 typed `details.reason` → `killed`/ETIMEDOUT → `textFailureOf()`。⇒ 被预算杀死的进程即使 stderr 里写着 403，也判 `timeout`（`:255` 在 `:257` 之前，A4 / T14 控制组实测）。
- 顺序守卫有专门用例：`push-auth-classification.test.mjs:573-588`（D3）先证明这段文本**确实**命中 `hasTransportEvidence`（`:577`），再证明状态码胜出（`:578`、`:582`）。这条断言比 b11 评审建议的「加一个正向用例」更强：它把旧误报的成因本身钉住了。

### 2.2 状态码形状：认得出什么、漏了什么（本次最关键的验收）

`HTTP_STATUS_SOURCES`（`git.ts:158-166`）四条形状，按可信度排序。用 `node -` 直接打 `dist` 的纯函数与 shipped `pushMain()`（假 runner，不联网），实测：

| stderr 形状 | 取出的码 | 判定的 reason | 结论 |
| --- | --- | --- | --- |
| `fatal: unable to access '<url>': The requested URL returned error: 403` | `[403]` | `auth-rejected` | ✅ b11 P2-6 原串 |
| `… returned error: 401 / 407 / 429 / 502` | 对应码 | `auth-rejected` / `proxy-auth` / `rate-limited` / `remote-error` | ✅ 用例覆盖 |
| `error: 403 Forbidden while accessing …` | `[403]` | `auth-rejected` | ✅ 老 git 形态 |
| `fatal: unable to access remote: HTTP/1.1 429 Too Many Requests` | `[429]` | `rate-limited` | ✅ 协议行 |
| `error: RPC failed; HTTP 403 curl 22 …` | `[403]` | `auth-rejected` | ✅ |
| **`… : Received HTTP code 407 from proxy after CONNECT`** | **`[]`** | **`unreachable`** | ❌ **漏**（§5 P1-1） |
| **`… : CONNECT tunnel failed, response 407`**（curl 8.x） | **`[]`** | **`unreachable`** | ❌ **漏** |
| `… : Could not resolve host: gitee.com` | `[]` | `unreachable` | ✅ 真 DNS 失败不被误判 |
| `… : Failed to connect to gitee.com port 443` | `[]` | `unreachable` | ✅ 端口数字不被当状态码 |
| `… : Failed to connect to gitee.com port 403` | `[]` | `unreachable` | ✅（含端口 403 也不误判） |
| URL 里带 `:8443` + `returned error: 403` | `[403]` | `auth-rejected` | ✅ |
| stderr 含令牌 `tok403abc` + DNS 失败 | `[]` | `unreachable` | ✅ 令牌里的 `403` 不被当状态码 |
| `HTTP/1.1 200 Connection established` + `returned error: 500` | `[500,200]` | `remote-error` | ✅ 源顺序让真正的失败码先胜 |
| `error: 404 while accessing …` + `returned error: 403` | `[403,404]` | `auth-rejected` | ✅ 未映射码被跳过、继续找能定原因的码 |
| `error: 403 Forbidden`（**没有** `while accessing`） | `[]` | `git-failed` | ⚠ 罕见形状，不进鉴权类（不误导成网络，也不误导成鉴权） |

结论：**形状表对 401/403（本次的主诉）是可靠的**，端口/令牌/进度数字都不会被误当状态码；**407 的两条主流文案不在表里**，这是 P1。

### 2.3 未映射码（404 / 3xx）：分类器不发明，但兜底把「网络不可达」又造了回来

- `httpStatusFailureOf()` 对 404 正确返回 `null`（`git.ts:187-194`，A1 `:248` 与 A2 `:256` 都钉了）；「不发明原因」这条**在分类器层面成立**。
- 但 `failure()` 的兜底紧接着跑文本规则，而 `TRANSPORT_EVIDENCE_RE`（`git.ts:113`）**仍含 `unable to access`**：`fatal: unable to access '…': The requested URL returned error: 404` ⇒ `unreachable` ⇒ 文案「**网络不可达**（无法解析或连接到远端）：…」。302 同理。实测：

```
404  => reason=unreachable status=undefined  msg=推送失败：网络不可达（无法解析或连接到远端）
302  => reason=unreachable status=undefined
```

- 这不是回归（旧实现同样说网络不可达），也符合 `MODULES.md` 的「交回既有规则」；但用户场景是真实且常见的：仓库改名/删除、URL 打错、令牌没有看私有库的权限，都会被指向「检查网络、代理或防火墙」。记为 §5 P2-1。

### 2.4 文案与下一步：九类各有归属，但 `auth-prompt` 那条下一步是自相矛盾的

- 九类原因的短语表（`gitPort.ts:413-424`）与下一步表（`cycle.ts:983-998`）互相独立，四条新原因各有**专属**下一步；`timeout` / `unreachable` 保留原措辞；`auth-prompt` / `non-fast-forward` / `git-failed` 刻意共用 `DEFAULT_GIT_NEXT_STEP`（`cycle.ts:1008`）。
- 四条新原因的终端消息实测（`gitStageFailure()`，与 cycle 生产路径同一函数）：

```
[auth-rejected] E_PUSH_REJECTED: 推送失败：远端拒绝了这个用户名或令牌（HTTP 401/403），凭据需要重新核对；下一步：在设置里核对仓库登录名与私人令牌（需要写权限）…
[remote-error]  E_PUSH_REJECTED: 推送失败：远端服务器出错（HTTP 5xx），本地改动与令牌都没有问题；下一步：稍后重试；连续出现就去仓库状态页看看
[unreachable]   E_PUSH_REJECTED: 推送失败：网络不可达（无法解析或连接到远端）；下一步：检查网络、代理或防火墙…
```

- **但 `auth-prompt`（拿不出凭据）拼出来是**：

```
E_PUSH_REJECTED: 推送失败：HTTPS 鉴权无法通过（git 已禁用交互提示，askpass／用户名或令牌不可用）；请检查鉴权配置后重试；
下一步：检查远端是否被其他设备推进，下一次同步会做有界重试，仍未成功请人工协调
```

  前半句说鉴权、后半句让用户去看「远端是不是被别的设备推进了」——两句互相否定。`cycle.ts:979-981` 的注释把这件事写成「短语本身已经写了动作」，对 `non-fast-forward` 成立，对 `auth-prompt` 不成立。记为 §5 P2-2（不是本次引入，但本次把这条映射**写进了注释与全表**，等于把它固化了）。
- 白名单/长度：九条短语最长 59 字符（96 上限），B7 `:467` 逐条断言 ≤96。

### 2.5 `details.status`

- 只有四个状态码原因能带 `status`（`STATUS_REASONS`，`gitPort.ts:160-163`）；`timeout` / `unreachable` / `auth-prompt` 即使正文里有 403 也**不掺**状态码（`pushFailure()` `:427-431`）。
- `statusOf()`（`:199-203`）只认 `100..599` 的整数，字符串/NaN/越界一律当没有。
- 实测：403 → `details = {reason:'auth-rejected', status:403}`，键集合恰为 `['reason','status']`；DNS 失败 → `['reason']`（无 status）。C1 `:495`、T15、T14 控制组都钉了。

### 2.6 凭据卫生

- 状态码分支的 message 是「固定中文原因 + `HTTP <数字>` + 固定下一步」，**不回显 stderr**（`git.ts:624-626`）；`details` 里唯一的输入是 `args.map(scrub)` + 纯数字（`:628-632`）。
- 实测（令牌形态 `ghp_FAKE…` 塞进 URL userinfo 的 403 stderr）：push 与 engine（`lsRemote`）两侧的 `message + JSON(details)` 都**不含**令牌、不含 `ghp_`、不含 `acme:`（C1 `:491-493`、`:505-506`；T15）。这条比 b11 评审时更强：状态码分支**根本不碰原文**，所以「靠 scrub 打码」在这里不是必要条件是冗余保障。
- 边界（不是缺陷，但要说清）：`GitRepoV2Port.git()` 的**非状态码**兜底仍把 `text.slice(0,300)` 原样拼进 message（`gitPort.ts:296`）。网络类命令不走这条路（`fetchMain()` 走 `repo.fetch()` → engine 的 `failure()`，那里的 `this.scrub()` 会打码，`git.ts:646`）；走这条路的是 `add` / `commit` / `status` / `rev-parse`，它们的 stderr 不含远端 URL。记为观察项，不进 P2。

### 2.7 白名单一致性与 census 守卫

- `ALLOWED_PUSH_REASONS` 9 条（`cycle.ts:1056-1069`）与 `pushFailure()` 的 message 表逐字一致（`gitPort.ts:413-424`）；`singleLineSafeReason()`（`cycle.ts:1079-1084`）仍是「先归一 `>N 毫秒`、再精确比对、命中输出原文」。
- census 是真守卫，不是数字摆设：`shippedPushReasons()` 从 `gitPort.ts` 源码里**按 `'推送失败：'` 前缀逐字抽**（`plugin-pending-ownership.test.mjs:159-183`），`cycleAllowedReasons()` 从 `cycle.ts` 的数组抽（`:185-193`），两侧 `deepEqual`（`:498`）。任意一侧改文案 / 增删一条都会让 `:464`、`:494`、`:495` 或 `:498` 失败。
- 我核对了抽取逻辑的边界：message 对象的**键**（`'auth-prompt':` 等）不以「推送失败：」开头，不会被误抽；`end = indexOf('}[reason]')` 恰好截在对象末尾；超时模板单独用正则取并要求含 `>N 毫秒`（`:178-180`），模板缺失会直接 assert 失败。⇒ **不会因为抽取器退化而空过**。

### 2.8 增量 A 的诱探结果（本评审自跑，`node -` 走 stdin，不落文件）

除了 §2.2 的表，还确认了三件事：

1. **`pushMain()` 走到 shipped 分类器**（不是只测纯函数）：假 runner 返回 403 stderr ⇒ `E_PUSH_REJECTED` / `auth-rejected` / `status=403`。
2. **engine 与 port 同因同码**：`lsRemote()` 对同一 stderr 给 `E_AUTH` + `auth-rejected` + `status=403`（D1 用例 `:518-547`，我另跑了一遍 dist）。
3. **`remote:` 钩子回显的假状态码会被认领**：stderr 里先出现一条服务器钩子日志 `remote: build log: see HTTP 403 section`、随后才是 DNS 失败 ⇒ 判 `auth-rejected`（`HTTP (\d{3})` 兜底形状太宽）。这是低概率的**反向误判**（把网络问题说成凭据问题），记 §5 P2-4。

---

## 3 增量 B 逐项验收（`mod-plugin-gui-proxy-r2`）

### 3.1 预约生命周期：五条失败路径都「恰好归还一次」

| 路径 | 代码 | 释放点 | 是否恰好一次 |
| --- | --- | --- | --- |
| ① `http.request` 同步抛错 | `listener.ts:1666-1683` | `:1679` | ✅（之后直接 return，无其它释放者） |
| ② 上游 `error`（拒连 / 重置 / 15 s 兜底 `destroy(err)`） | `:1770-1776` | `:1772`，转正后早退（`:1773`） | ✅（幂等对象兜住重复调用） |
| ③ 上游用普通响应拒绝升级（200/4xx…） | `:1760-1769` | `:1761` | ✅ |
| ④ 客户端在 101 之前 close / error | `:1780-1781` → `abortHandshake` `:1691-1694` | `:1692`；`established=false` 时顺带销毁上游请求 | ✅（转正后是 no-op，不会掐已建立隧道） |
| ⑤ 监听 `close()` | `:1193-1194`（同步遍历 `reservations` 释放并清空） | `release()` | ✅ |
| （转正）101 到达 | `:1704-1705` | `established = true` 后 `release()`，槽位归属 `tunnels` | ✅（先置 flag 再释放，之后 teardown 只管 `tunnels`） |

- 幂等实现：`release()` 内部 `released` 布尔 + `reservations.delete(自己的对象)`（`:1127-1136`）⇒ 重复调用无副作用；**只删自己的槽**，所以「误放别人的槽」在结构上不可能（用 `Set` 里的大小做计数就不可能变负）。
- 用例证据：`remote-listener.test.mjs:1571-1640` 在**上限只有 1** 的监听上连做 3 次失败握手（死端口 → 502、上游回 200 拒绝升级 → 502），每次断言 `reservedTunnels === 0` 且 `rejected === 0`——**如果漏还一次，第 2 次就会变成 503**，所以这条用例确实能抓漏还。
- 用例证据（转正）：`:1457-1518` 用「上限 2 + 两条永不回 101 的哑上游」证明第 3 条被 503、且哑上游 `connections === 2`（**被拒的握手绝不能打到上游**）；断开前两条后 `reservedTunnels` 归零、第 4 条能重新占槽并真的拨到上游（`connections === 3`）。

### 3.2 `close()` 语义

- **成立的部分**：`close()` 返回时 `reservedTunnels === 0`、`tunnels === 0`（`:1193-1194` 同步释放 + `:1183-1187` 销毁隧道两侧）；同一进程里立刻按同一上限重建监听不受影响（`:1520-1569` 用例：第一个监听 close 后第二个监听第一条升级就拿到 101）。
- **不成立的部分（潜伏）**：`runUpgrade()` 只在**入口**查 `closed`（`:1611`），而 `await options.authorize(...)`（`:1620`）与 `await resolveUpstreamHeaders(target)`（`:1640`）之后**没有再查**；`reserveTunnelSlot()`（`:1651`）也不看 `closed`。因此若这两个钩子是「跨 macrotask 才 resolve 的异步函数」，`close()` 返回后会**新增一条预约并新拨一条上游连接**（最长活到 15 s 兜底），与 `:1188-1191` 的注释「close() 返回后 `reservedTunnels === 0`」直接冲突。出厂接线（`service.ts:533-550` 只传 `baseUrl` + 同步 authorizer）不会触发，所以是**潜伏缺陷**，不是当前的洞。记 §5 P2-5。

### 3.3 `stats()` 语义

- 三个旧字段语义未变（`listener.ts:1876-1884`）：`active` = 客户端 socket 数、`total` = 累计连接、`rejected` = 被拒的升级请求数（到顶 503 / 门禁用 respond 拒绝 `:1629-1632` / 未授权）；新增 `tunnels`（101 已到手）与 `reservedTunnels`（已拨未转正）是**追加**。
- 消费侧没有含义漂移：`service.ts:413` 只读 `active/total/rejected`，`service.ts:427-428` 把它们映射成对外的 `connections`；`RemoteListenerHandle` 的窄接口（`service.ts:39`）不含新字段，所以 `status()` 的线上形状不变。`tsc` exit 0 也证明结构兼容。
- 用例把口径钉死：`:1493-1494` 断言「没有一条转正 ⇒ `tunnels=0` 而 `reservedTunnels=2`」；`:1556-1557` 断言「101 到手 ⇒ `tunnels=1`、`reservedTunnels=0`」。这正是「预约不能滞留、也不能重复计数」的双向守卫。

### 3.4 台账：不能空过、跳过不像通过

- 四条断言（`remote-listener.test.mjs:1796-1812` / `gui-proxy-fence.test.mjs:1191-1207`）：
  1. `total > 0`（一条 LAN 用例都没登记时直接失败 ⇒ 守卫不会「因为没有登记而恒真」）；
  2. `ran + skipped === total`（没有用例能悄悄消失）；
  3. `skipped === 缺能力 ? total : 0`（有能力时一条都不许跳过）；
  4. `ran === 缺能力 ? 0 : total`（缺能力时一条都不许假装实跑）。
- 为什么不是空过：`total` 在模块加载期累加（`lanTest` 包装器 `:164-176`），`ran/skipped` 在**运行期**累加，台账用例注册在所有 `lanTest` **之后**（文件末尾），所以三条数在它执行时已定稿。用 `--test-name-pattern` 只跑部分用例时，台账若被排除则不会误判通过；若只跑台账，`ran+skipped` 会小于 `total` 而失败。
- 为什么「跳过不像通过」：跳过走运行期 `t.skip(文案)`（不是注册期 `skip` 选项），文案里带「已试 N 个候选 / 每次自连 ≤300 ms / 候选上限 8 个 / 本文件 N 条代理用例跳过 / 套件其余用例照常执行」（`:142-157`），Node 的汇总会把它记进 `skipped` 而不是 `pass`。
- 本机实跑（两个文件都 0 skip，能力存在）：

```
[LAN-LEDGER] total=13 ran=13 skipped=0 | 能力存在：可绑定且可自连的 192.168.137.1（13 条 LAN 用例全部实跑，0 跳过）
[LAN-LEDGER] total=35 ran=35 skipped=0 | 能力存在：可绑定且可自连的 192.168.137.1（35 条 LAN 用例全部实跑，0 跳过）
```

- **边界（记 §5 P2-8）**：① 台账只统计经 `lanTest()` 注册的用例——将来有人直接写 `test()` 的 LAN 用例，台账看不见（不会假通过，但会漏账）；② 跳过分支在本机**没有执行过**（0 skip），「跳过不会被当成通过」目前是读码结论 + 逻辑论证，`unverified`。

---

## 4 对既有增量的回归复核（逐条）

| # | 既有结论 | 现状 | 证据 |
| --- | --- | --- | --- |
| 1 | **结构 timeout 优先**（预算杀进程 ⇔ timeout，与 stderr 语言无关） | **未削弱**。`run()` 在 `git.ts:689-701` 直接 reject（`reason:'timeout'`、`killed:true`、`budgetMs`），根本不进 `failure()`；`gitPort.ts:57-71` 同样。新增的状态码分支只在 `failure()` / `textFailureOf()` 里，时序上排在结构信号**之后**。 | T1–T5、T13 原样；新增 A4（`:285-309`）与 T14 控制组（`:604-613`）专测「stderr 里有 403 + killed ⇒ 仍是 timeout，且不掺 status」。 |
| 2 | **push 120 s / 读 8 s / 首调 20 s 三档预算身份分开** | **未削弱**。`pushBudget()`（`git.ts:550`）与 `networkBudget()` 一行未改；`gitPort.run()` 仍只在 `args[0] === 'push'` 时挂预算（`:285`）。 | T11–T13 原样通过；`distcheck` 证明 `dist/sync/gitPort.js` 是当前源码的产物。 |
| 3 | **空闲预算只截断真正停滞的流**（b11 后加修 F2） | **未触碰**。本次 listener 的 diff 只在 `runUpgrade` / `reservations` / `shutdown` / `stats`；`armIdle`（`:1448-1497`）、`OPEN_ENDED_STREAM_RE`（`:296`）、背压挂起全在转发路径上，diff 没有任何 hunk 落在这里。 | STALLED 两类形态用例原样通过；`git diff` 的 hunk 清单可核。 |
| 4 | **401 单飞 + 成功才覆盖缓存 + 只重试一次**（F1） | **未触碰**。`mintOnce()`（`service.ts:343-357`）、`refreshUpstreamAfter401()`（`:402-407`）、listener 的 `refreshAndRetry` 都不在 diff 里。 | `gui-proxy-fence.test.mjs` 的 F1 用例（`命中 2 次 / 只换一次身份`）原样通过。 |
| 5 | **Origin 只在同源时改写**（安全核心） | **未触碰**。`rewriteSameOrigin()`（`listener.ts:585-598`）、唯一应用点 `outboundHeaders()`（`:631`）、HTTP 与 Upgrade 共用口径（`:1304` 与 `:1640` 的 `staticHeaders` 只影响上游 cookie，不改 Origin）。 | G1 用例（`remote-listener.test.mjs:672-720`：同源改写 / `http://` 同 authority 也改写 / 外来 Origin 逐字保留）原样通过；`gui-proxy-fence` 的假上游对照（外来 Origin 仍 403）原样通过。 |
| 6 | **终态白名单挡住任何非固定正文**（含 96 字符上限折叠） | **未削弱**，只是基数 5→9。`singleLineSafeReason` 一行未改；`PO-08` 的 16 个 hostile 原因、`PO-11` 的「数字换文字必须折叠」都原样通过。**注**：`cycle.ts:1072-1074` 的注释仍写「五个短语」（§5 P2-6）。 | §6 台账 + PO-08/10/11。 |
| 7 | **`failure()` 兜底文案逐字不变**（E_GIT / E_AUTH / 「网络不可达…」/ details 字段） | **未削弱**：状态码分支是**新增在前**的 if，兜底段落（`git.ts:635-657`）与 b11 评审时逐字相同（`summary` 4 行、`scrub`、`network` 字段、reason 三态）。 | 既有用例 `testConnection` / `P1-1 lsRemote 超时` 等原样通过；965 例里没有行为断言被改写。 |
| 8 | **dist 对等**（规则 9） | **成立**：75 文件 0 mismatch，4 个 `.js` 与 4 个 `.ts` 一一对应。 | §1.3。 |

**结论：没有任何一条既有结论被削弱。** 本次两个增量的 diff hunk 与既有行为（timeout / 空闲 / 401 / Origin）在源码层面**不相交**，属于「纯追加」；测试侧只对夹具与条数动了手（§6）。

---

## 5 发现清单（P1 = 1，P2 = 8）

### P1-1 407 的主流真实文案认不出来 ⇒ 仍然说「网络不可达」，而测试与模块登记都说 407 已分出来

- 位置：`packages/dsh-dots/src/engine/git.ts:158-166`（状态码形状表）；波及 `src/sync/gitPort.ts:241-249`、`src/sync/cycle.ts:1060`（`proxy-auth` 短语）、`docs/MODULES.md`（新增登记行「407 ⇒ proxy-auth」）、`test/push-auth-classification.test.mjs:211-214` + `:333-340`（B2）、`test/git-timeout-classification.test.mjs:572`（T14 表）。
- 证据（本评审实测，假 runner 打到 shipped `pushMain()`，不联网）：

```
curl CONNECT 407         => reason=unreachable status=undefined msg=推送失败：网络不可达（无法解析或连接到远端）
curl8 CONNECT tunnel 407 => reason=unreachable status=undefined msg=推送失败：网络不可达（无法解析或连接到远端）
```

  `httpStatusCodesOf("… Received HTTP code 407 from proxy after CONNECT")` 返回 `[]`：`\bHTTP\s+(\d{3})\b` 要求 `HTTP` 后直接是空白，而这条文案是 `HTTP code 407`；`CONNECT tunnel failed, response 407` 连 `HTTP` 字样都没有。
- 影响：公司代理要求鉴权的用户拿到的仍是「网络不可达 + 检查网络/代理/防火墙」，`proxy-auth` 的专属下一步（核对 `HTTPS_PROXY` 用户名口令）**永远走不到**；更要紧的是 B2 / T14 用 `returned error: 407` 这条**不是 CONNECT 代理失败**的形态钉住了它，读测试的人会以为 407 已被真实覆盖。这正是本次要修的那类「把鉴权问题说成网络问题」，只是换成了代理。
- 建议：`HTTP_STATUS_SOURCES` 增加两条（顺序放在现有四条之后即可）：
  `'\\bReceived HTTP code\\s+(\\d{3})\\b'` 与 `'CONNECT tunnel failed,\\s*response\\s+(\\d{3})\\b'`；
  并在 `push-auth-classification.test.mjs` 的 `STDERR_SHAPES['proxy-auth']`（`:211-214`）里补这两条真实文案（B2/T14 自然覆盖）。若不愿扩形状，就**撤掉** 407 承诺（改由「代理」二字兜底并在登记行里写明未覆盖），不要保留一条不可达的分支。
- 阻断冻结：**是**（改动量 ≈ 一行正则 + 两条用例）。

### P2-1 404 / 3xx 这类未映射码仍被兜底说成「网络不可达」

- 位置：`src/engine/git.ts:642-648`（`unreachable = !auth && hasTransportEvidence(text)`，而 `:113` 的证据集含 `unable to access`）。
- 证据：`… returned error: 404` ⇒ `codes=[404]`、`httpStatusFailureOf → null`（正确）、随后 `unreachable` ⇒ 正文「网络不可达（无法解析或连接到远端）：git push 失败：…404…」。302 同理。
- 影响：仓库改名/删除、URL 打错、令牌没有看私有库的权限 → 让用户查网络。文案里虽然有原始 404，但**首句是错的**。
- 建议：在 `failure()` 里区分「**认出了状态码但没映射**」与「完全没有状态码」：前者不把 `unable to access` 当传输证据，给一句「远端返回 HTTP 404（仓库不存在或没有权限）」。这只需 `httpStatusCodesOf(text).length > 0` 一个判据。
- 阻断冻结：否。

### P2-2 `Authentication failed` / `HTTP Basic: Access denied`（无数字状态码）仍归 `auth-prompt`，且下一步自相矛盾

- 位置：`src/sync/gitPort.ts:218-219`（`AUTH_TEXT_RE` 含 `Authentication failed`）→ `:245`；`src/sync/cycle.ts:979-981`（注释）与 `:991`（`auth-prompt → DEFAULT_GIT_NEXT_STEP`）。
- 证据（实测终端消息，见 §2.4）：Gitee/GitHub 的 `fatal: Authentication failed for '…'`、GitLab 的 `remote: HTTP Basic: Access denied` 都判 `auth-prompt`，文案说「askpass／用户名或令牌**不可用**」（实际是**被拒**），再追加「检查远端是否被其他设备推进」。
- 影响：同一个用户处境（令牌过期）会因远端文案是 401 带码还是 `Authentication failed` 得到两套互相矛盾的说明；`auth-prompt` 那条的下一步与鉴权无关。
- 建议：把 `Authentication failed` / `Access denied` / `HTTP Basic` 从 `AUTH_TEXT_RE` 挪到「凭据被拒」文本桶（判 `auth-rejected`），`AUTH_TEXT_RE` 只留 `could not read Username/Password` / `terminal prompts disabled` / `askpass`；并给 `auth-prompt` 一条自己的下一步（「检查登录名/令牌是否填全」），不再共用 `DEFAULT`。
- 阻断冻结：否（建议同批修，代价小）。

### P2-3 5xx 一律说成「远端服务器出错」，代理 5xx 也这么说；且 `reachable` 与正文互相打脸

- 位置：`src/engine/git.ts:205-209`（`500-599 → remote-error`，中文「远端服务器出错」）、`src/sync/gitPort.ts:418`（`HTTP 5xx` 固定短语）、`src/rpc.ts:344-355`（`isNetworkFailure`：`E_AUTH` 或 `details.network === true` ⇒ 写 `reachable:false`）。
- 证据：公司代理回 502/503 时 curl 打的是同一句 `The requested URL returned error: 502`，我们判 `remote-error`（「远端服务器出错，本地改动与令牌都没有问题」）；同一份错误经 `lsRemote()` 出去后 `details.network=true`，`rpc` 会把状态文件写成 `reachable:false`，而正文说的是「限流 / 服务端出错」。
- 影响：把代理故障归因给「仓库服务端」；UI 的「上次连接」事实与错误正文不是同一件事。
- 建议：中文改成「远端或代理返回 5xx」，下一步同时提代理；`isNetworkFailure` 对 `reason` 为 `rate-limited` / `remote-error` 不再写 `reachable:false`（或单独记一个 `lastServerError`）。
- 阻断冻结：否。

### P2-4 `HTTP (\d{3})` 兜底形状太宽：服务器钩子回显的假状态码会把网络问题判成凭据拒绝

- 位置：`src/engine/git.ts:158-166`（第四条 `'\\bHTTP\\s+(\\d{3})\\b'`）。
- 证据（实测）：`remote: build log: see HTTP 403 section` + `Could not resolve host` ⇒ `codes=[403]` ⇒ `auth-rejected`（真因是 DNS）。
- 影响：低概率、但方向与本次修复相反（把网络问题说成凭据问题）。
- 建议：兜底形状只认行首/`fatal:`/`RPC failed` 附近的 `HTTP NNN`，或要求同一行同时出现 `error`/`fatal`/`failed`；`remote:` 前缀的行整行排除。
- 阻断冻结：否。

### P2-5 `close()` 之后仍可能新增预约并新拨上游（「`reservedTunnels` 恒为 0」只在同步钩子下成立）

- 位置：`src/remote/listener.ts:1608-1651`（入口 `:1611` 查 `closed`，`await authorize` `:1620` / `await resolveUpstreamHeaders` `:1640` 之后不再查，`reserveTunnelSlot()` `:1651` 不看 `closed`）、`:1188-1194`（注释与同步清空）、`:1125-1140`。
- 证据：控制流可证——`shutdown()` 清空 `reservations` 后，一个正卡在 `await authorize` / `await headers()` 的 `runUpgrade` 恢复执行会重新占槽并 `http.request`。`RemoteUpstreamHeaders`（`:50-52`）的**类型本身允许返回 Promise**，`authorize` 也 await，所以这是公开能力里的潜伏路径。出厂接线 `service.ts:533-550` 只传同步 authorizer、不传 `headers` 函数 ⇒ 今天不可达，因此没有实测复现。
- 影响：一旦有人给监听接异步 headers/authorize，`close()` 返回后 `stats().reservedTunnels` 可能变成 1，并留下一条最长 15 s 的上游连接；`close()` 的「零预约」不变式会被违反。
- 建议：`reserveTunnelSlot()` 里加 `if (closed) return null`；`runUpgrade` 在每次 `await` 之后复检 `closed`（早退并归还）；`shutdown()` 顺手 `destroyQuietly` 在飞的上游请求。
- 阻断冻结：否（潜伏；修法三行）。

### P2-6 文档口径小漂移：`cycle.ts` 注释仍写「五个短语」；`MODULES.md` 的证据块仍是 942 / batch b12

- 位置：`src/sync/cycle.ts:1072-1074`；`docs/MODULES.md:693`（「batch **b12** 证据 … 942 / 940 pass …」）。
- 证据：白名单已是 9 条（`:1056-1069`）；本批 suite 已是 **965 / 963 / 0 / 2**（§1.2），942 是上一轮加修后的数字。
- 影响：读者按注释以为只有五条短语；登记块与现状差 23 例、批次号与文件名（`REVIEW-b11-batch.md`）不一致。
- 建议：注释改成「九条」；提交时更新证据块（965 / 963 / 0 / 2 + 本文件的 `.tmp/gates-rv2-*.out`），批次号统一成 b11/b11b。
- 阻断冻结：否（但**提交前改**成本极低）。

### P2-7 预算口径的旧文档仍有一处英文与两处验证记录没改（b11 P2-7 未收干净）

- 位置：`packages/dsh-dots/docs/DETAIL.md:248`（「a single git network operation is capped at 8 seconds.」——`meta.detail` 指向它，是插件详情页展示的英文文档）；`docs/VERIFICATION.md:87`、`:204`（仍把 `NETWORK_TIMEOUT_MS=8000` 当作唯一预算）。
- 证据：`docs/CONTRACT.md:256`、`docs/CONFIG-UX.md:63,127` 已改成「读 8 s / 首调 20 s / push 120 s」，上述三处没跟上。
- 影响：契约层已对、展示层与验证记录仍错，后续模块会按错的预算设计。
- 建议：三处各补一句三档口径（或统一指向 `CONFIG-UX` §127 那张表）。
- 阻断冻结：否。

### P2-8 LAN 台账的两个边界：只统计经 `lanTest()` 注册的用例，且跳过分支本机未执行

- 位置：`test/remote-listener.test.mjs:162-176`、`:1796-1812`；`test/gui-proxy-fence.test.mjs:145-155`、`:1191-1207`。
- 证据：本机 `total=13 ran=13 skipped=0` 与 `total=35 ran=35 skipped=0`（§3.4）——`skipped=0` 意味着「跳过不会被当成通过」那条断言的分支**当次没跑**；另外 `LAN_LEDGER.total` 只在 `lanTest()` 里累加，直接写 `test()` 的 LAN 用例不会被记账（不会假通过，但会漏账）。
- 影响：门禁在「没有 LAN 地址的机器」上的行为只有读码依据；将来新增 LAN 用例若忘了用 `lanTest()`，台账仍会通过。
- 建议：在 `docs/FLAKES.md` 记一条「LAN-e2e 在无可用非回环 IPv4 的机器上整组 skip，台账会打印 `[LAN-LEDGER] … skipped=N`」；并加一条源码守卫：断言这两个文件里 `test(` 的 LAN 相关标题都经 `lanTest`（或让 `lanTest` 成为唯一注册器）。
- 阻断冻结：否。

---

## 6 断言变更台账（四个测试文件逐条）

删除行**全量**清单（`git diff -U0` 的 `-` 行，共 20 行）：两份 LAN 文件各有 1 行文件头注释、3 行取址返回、2 行 `LAN`/`SKIP` 常量、1 行 `test(name, {skip: SKIP})`；`plugin-pending` 有 1 行注释、1 行用例标题、1 行注释、3 行计数断言。**没有任何一条行为断言被删。**

| # | `path:line`（当前树） | 变更 | 判定 |
| --- | --- | --- | --- |
| 1 | `test/git-timeout-classification.test.mjs:564-689` | 新增 T14（`:568`）、T15（`:615`），**0 删除** | 只增不减 |
| 2 | `test/plugin-pending-ownership.test.mjs:157` | 注释「五个」→「九个」 | 注释 |
| 3 | 同文件 `:459` | 新增 `SHIPPED_PUSH_PHRASE_COUNT = 9` | 新增常量（被下面三条引用） |
| 4 | 同文件 `:461` | 用例标题「五个」→「九个」 | 名称 |
| 5 | 同文件 `:464` | `assert.equal(reasons.length, 5)` → `…, SHIPPED_PUSH_PHRASE_COUNT)`（=9） | **retarget，等价严格**：仍是精确计数；少一条/多一条都失败；循环体逐条 `assert` 未动 |
| 6 | 同文件 `:494` | `assert.equal(shipped.length, 5)` → `…, 9)` | 同上 |
| 7 | 同文件 `:495` | `assert.equal(allowed.length, 5)` → `…, 9)` | 同上 |
| 8 | 同文件 `:498` | `assert.deepEqual(allowed, shipped)` | **未动**（真正的漂移守卫没被削弱） |
| 9 | `test/remote-listener.test.mjs:133-134` | `const LAN = await findBindableLanAddress()` → `LAN_PROBE` / `LAN` | 夹具（非断言） |
| 10 | 同文件 `:142-157` | 新增 `lanSkipReason(totalCases)`：skip 文案从静态一句话变成运行期「候选数/上限/自连等待/条数」 | 非断言；**信息量增加** |
| 11 | 同文件 `:162-176` | `test(name,{skip:SKIP})` → `lanTest()`（运行期 `t.skip`）+ `LAN_LEDGER` | 行为等价 + 记账；无断言被改 |
| 12 | 同文件 `:270-282` | 新增 `waitFor(check,label,timeout)`，超时 `assert.fail` 点名 | 新增 helper（比固定 `sleep` 更严） |
| 13 | 同文件 `:1457-1518` | 新用例：上限按「已建立 + 已预约」计 | 只增（含 `reservedTunnels`/`rejected`/上游连接数三重断言） |
| 14 | 同文件 `:1520-1569` | 新用例：`close()` 归还握手预约 + 同上限新监听可用 | 只增 |
| 15 | 同文件 `:1571-1640` | 新用例：两条失败路径恰好归还一次（上限 1 连做 3 次） | 只增（能抓漏还：漏还即 503） |
| 16 | 同文件 `:1796-1812` | 新用例：LAN 台账四条断言 | 新增守卫 |
| 17 | `test/gui-proxy-fence.test.mjs:120-155` | 同 #9–#11（`LAN_PROBE` / `lanSkipReason` / `LAN_LEDGER` / `lanTest`） | 非断言，行为等价 |
| 18 | 同文件 `:1191-1207` | 新用例：LAN 台账（同四条） | 新增守卫 |
| 19 | 两份 LAN 文件里既有的 48 条 `lanTest` 体 | **一字未改**（diff 内无 hunk 落在用例体） | 未动 |
| 20 | 既有 `skip` / `timeout:` | 没有新增注册期 skip、没有调大任何 `timeout:` | 未放松 |

**结论：没有任何既有断言被删除或放宽。** 唯一的「减」是两处夹具返回值形状、skip 的挂法、以及三条 5→9 的计数；三者都保持甚至收紧了严格度（skip 现在会把「几条被跳过」写进输出；计数仍精确；`deepEqual` 未动）。

---

## 7 未验证边界（本评审没有、也不能证明的东西）

1. **真实远端**：没有向 Gitee / GitHub / GitLab 发过任何请求。§2 的所有分类结论来自（a）shipped 纯函数 + 假 runner / 假 `execFile`，（b）`STDERR_SHAPES` 里作者采集的形状。**「真实 407 / 真实 404 的 git 文案」只有文档与经验依据**（P1-1 的判定依赖 `libcurl` 的已知文案，未能本机复现，因为本机没有出一个 407 的代理）。
2. **真实代理链路**：没有配 `HTTPS_PROXY` 跑过 push；`CONNECT tunnel failed, response 407` 是 curl 8.x 的文案，未在本机验证。
3. **Windows 孙进程**（b11 P2-5）：`git-remote-https` 持有管道导致 120 s 不结算的场景仍未复现，`unverified`。
4. **`close()` 与异步钩子的竞态**（§5 P2-5）：只有控制流论证，没有运行期复现（构造它需要在测试外起一个 TLS 监听 + 异步 authorize，本评审按「只写一个文件」的约束没有落探针脚本）。
5. **LAN 缺能力分支**：本机 `192.168.137.1` 可用，两份文件的 `skipped` 分支**当次没有执行**；「跳过不会被当成通过」只有逻辑依据。
6. **真机 / 平板**：`docs/MODULES.md` §6 的四条真机验收断言仍未执行；本评审不碰 `hdc`、不安装、不连平板。
7. **并发 lane**：`docs/MODULES.md` 在我评审期间被写入（§1.4）；若 Lead 在提交前继续改登记行，P2-6 的其中一半可能自愈。
8. 本评审**没有** commit / push / 跑同步周期 / 联网 / 写源码。

---

## 8 冻结建议

- **不建议按现状冻结**：P1-1（407 真实文案）会让模块登记里「407 ⇒ proxy-auth」的承诺在真实代理场景下不成立，而 B2/T14 又给了「已覆盖」的错觉。**修法成本 ≈ 一行正则 + 两条用例**，属于提交前必修。
- **修完 P1-1 后可以冻结（提交）**：P0 = 0；门禁四件套全绿（build exit 0、tsc exit 0、dist 75/0 mismatch、插件 965/963/0/2 连跑两次同结果、app 3234/3234/0/0）；没有新依赖、没有 `.ets` 改动、没有删除或放宽断言、没有把任何「安全/已验证」标签升级；既有 timeout / 空闲 / 401 / Origin 行为未被触碰。
- **建议同批顺手修（3 条，都是小改）**：P2-2（`Authentication failed` 归到凭据被拒 + 给 `auth-prompt` 一条自己的下一步）、P2-5（`reserveTunnelSlot` 看 `closed`）、P2-6（注释「五个」→「九条」+ 提交时把 965/963/0/2 写进 `MODULES.md` 证据块）。
- **建议排后续（5 条，不阻断）**：P2-1（404/3xx 不说成网络不可达）、P2-3（5xx 归因与 `reachable` 口径）、P2-4（`HTTP NNN` 兜底形状收窄）、P2-7（`DETAIL.md:248` / `VERIFICATION.md:87,204` 的三档口径）、P2-8（LAN 台账的两个边界 + `docs/FLAKES.md` 记一条）。
- **b11 起就开着、本次未碰的一条（记在这里以免被当成已修）**：401 重试第二次派发前仍只查 `res.writableEnded || res.headersSent`（`src/remote/listener.ts:1403`），缺 `closed` / `res.destroyed`；客户端在换身份窗口内断开时会多打一次上游（有界浪费）。
- **冻结时必须保留的证据**：本文件的 `.tmp/gates-rv2-{build,tsc,distcheck,plugin1,plugin2,app}.out` 与对应的 `*.exit.out`；`MODULES.md` §6 的真机验收断言在真机执行前保持 `unverified`，不得改写成已观察结果；P1-1 修好之前，任何「407 已分类」的表述都应带 `(未在真实代理链路验证)`。
- **回滚**：本次与已提交的 b11 模块文件集**部分重叠**（`git.ts` / `gitPort.ts` / `cycle.ts` / `listener.ts` 都在 b11 提交里出现过），不能整文件 revert；提交前回滚 = 撤销「状态码分类段 + `failure()` 状态分支 + 四个 `PushReason` + 白名单 5→9 + 预约/台账段」，删除 `test/push-auth-classification.test.mjs`；提交后 `git revert <hash>` 并**必须重跑 `scripts/build.mjs`**，再按规则 9 重新证明 dist 一致（单一构建窗口）。
