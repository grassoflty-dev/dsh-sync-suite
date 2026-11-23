# 独立只读评审（第三次）— batch b11c：`mod-plugin-push-classify-hardening`（含前两提交回归）

- 评审对象：`main` @ `fc62951`（`mod-plugin-push-classify-hardening`），并回归 `7a34b70`（`mod-plugin-push-auth-vs-network`）、`2b22e8c`（`mod-plugin-gui-proxy-r2`）
- 评审方式：只读；自跑门禁 + 自写离线攻击探针（全部在 gitignored `.tmp/` 内），仓库内只新增本文件
- 立场：本轮的任务是**攻击前两轮评审五条 P2 的修法**（不是复述它们），并检查新增测试/判据本身有没有说谎

---

## 0 结论

- **P0 = 0，P1 = 0，P2 = 9**。裁决：**可以冻结（freeze-with-fixes）**——主承诺全部成立，9 条 P2 都不阻断冻结。
- 一句话裁决：**五条 P2 修的是真 bug，且都带了见证与负例；剩下的问题集中在「证据/措辞比事实多说了一寸」**——一处分类不对称（`remote:` 回显里的硬证据会压过真实 403）、一处代理 404 被归因给仓库、三处「守卫证明的对象 ≠ 它声称证明的对象」，以及四处文档/测试措辞过度。

| # | 严重度 | 一句话 | 位置 |
| --- | --- | --- | --- |
| P2-1 | P2 | 硬证据扫描**不按行门禁**：`remote:` 回显里的 `Connection refused` 会压过同一次失败里的真 403 ⇒ 判 `unreachable`（P2-4 的镜像） | `src/engine/git.ts:143-145`、`src/sync/gitPort.ts:256` |
| P2-2 | P2 | CONNECT/代理句形里的 **404** 也落 `not-found`，文案与下一步把代理的 404 归因给「仓库地址/私有库权限」 | `src/engine/git.ts:204,207,262-267` |
| P2-3 | P2 | census 守卫度量的是**源码文本重扫**，不是 `ALLOWED_PUSH_REASONS.length`：注释与真实数组可以不一致而全绿 | `test/plugin-pending-ownership.test.mjs:469-477,519-531`、`src/sync/cycle.ts:1071-1079` |
| P2-4 | P2 | 「`shutdown()` 销毁在飞上游」**代码为真**，但仓库内**没有断言**覆盖；被引用的那条用例 close 前后上游 accept 都是 0（从未拨出） | `docs/MODULES.md:708`、`test/remote-listener.test.mjs:1712-1713,1725,1598-1601` |
| P2-5 | P2 | 台账 forced-missing 对「探测本身坏了」是**循环论证**：`missing` 恒 true 时 36/13 条 LAN 用例全部跳过仍全绿，无第二判据 | `test/remote-listener.test.mjs:187-214,2033-2055`、`test/gui-proxy-fence.test.mjs:163-190,1343-1355` |
| P2-6 | P2 | `DETAIL.md` 新句「each git network operation has an explicit budget」与事实不符：**`clone` 没有预算** | `packages/dsh-dots/docs/DETAIL.md:247-253` vs `src/engine/git.ts:902` |
| P2-7 | P2 | 注册数对账**基线混用**：+7 是相对 `df512e7`，+4 是相对上一轮评审的 965；`MODULES.md:700③` 把两者写成同一个差值 | `docs/MODULES.md:700,702` |
| P2-8 | P2 | E1 用例标题「只有链路不通 / 凭据类失败才写 `reachable:false`」与**自身 timeout 断言**矛盾 | `test/push-auth-classification.test.mjs:762,770` |
| P2-9 | P2 | 测试注释把未实机观测的 CONNECT 形态称为「代理**真正**会打印的真实文案」；同文件头注释「`remote:` 日志里的数字不许当状态码」与它自己钉住的残余（`remote: returned error: 403`）矛盾 | `test/push-auth-classification.test.mjs:13,252-257,282-284,333` |

我复核了五条修法本身，**全部实质成立**（细节见 §2–§7）：

1. `unable to access` 已从证据集删除且以导出常量钉住；硬证据胜于状态码（两种顺序 + engine 侧同判）。
2. 松形状（`HTTP/1.1 NNN` / 裸 `HTTP NNN`）只对非 `remote:`/`hint:` 行生效；leading 空白、tab、大小写、`Remote :`、CRLF 五种绕过全部被挡住。
3. `404 ⇒ not-found` 成立，`details.status=404`、独立文案、独立下一步；其余未映射码落 `git-failed` 且不带 status、不写 `reachable:false`。
4. 注释条数 10 与数组 10 当前一致，且"中文数字 / 重复出现 / 数字与数组一起漂移"都会红——**但守卫的度量对象错了**（P2-3）。
5. LAN 台账的 `total` 确实是全文件注册数（45 = 36 + 9；20 = 13 + 7），forced-missing 分支离线真跑过——**但它无法证明"能力真的缺失"**（P2-5）。

---

## 1 复核范围与证据

### 1.1 三条提交与实际 diff

| 提交 | 主题 | 触及文件（本评审关心的部分） |
| --- | --- | --- |
| `fc62951` | `mod-plugin-push-classify-hardening` | `src/engine/git.ts`(+146/−58)、`src/sync/gitPort.ts`(+30/−18)、`src/sync/cycle.ts`(+21/−5)、`src/rpc.ts`(+11/−6)、4 个 `dist/`、5 个测试（+698/−98）、`docs/{MODULES,VERIFICATION}.md`、`packages/dsh-dots/docs/DETAIL.md` |
| `7a34b70` | `mod-plugin-push-auth-vs-network` | 同一分类器 + `push-auth-classification.test.mjs`（新文件 +743/−0）、`git-timeout-classification`(+98/−7)、`plugin-pending-ownership`(+17/−6) |
| `2b22e8c` | `mod-plugin-gui-proxy-r2` | `src/remote/listener.ts`(+184/−8)、`test/remote-listener.test.mjs`(+355/−7)、`test/gui-proxy-fence.test.mjs`(+80/−7) |

`git rev-parse HEAD` = `fc629510beca1ca7476a24e8d119d43838fd7c29`；评审开始与结束时 `git status --porcelain` **均为空**（树干净），评审期间未执行任何 `git add/commit/checkout/stash`。

### 1.2 门禁复跑（本评审自跑，`Tee-Object` 全部留存在仓库根 `.tmp/`）

| # | 命令（工作目录） | 结果 | 留存 |
| --- | --- | --- | --- |
| G1 | `node scripts/build.mjs`（`packages/dsh-dots`） | exit 0，tail `[plugin] dist/index.js + dist/client.js 已生成` | `.tmp/gates-rv3-build.out` |
| G2 | `node ../../node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | exit 0（无诊断输出） | `.tmp/gates-rv3-tsc.out`（含 `TSC_EXIT=0`） |
| G3 | `node .tmp\distcheck-j3.mjs`（`packages/dsh-dots`） | exit 0，`DIST-FRESHNESS: 75 files, 0 mismatch` / `DIST-WINDOW: 0 dist/*.js differ from HEAD` | `.tmp/gates-rv3-distcheck.out` |
| G4 | `node --test test/*.test.mjs`（第 1 次） | **tests 976 / pass 974 / fail 0 / skipped 2**，duration 52139 ms | `.tmp/gates-rv3-plugin-run1.out` |
| G5 | 同上（第 2 次） | **tests 976 / pass 974 / fail 0 / skipped 2**，duration 51814 ms | `.tmp/gates-rv3-plugin-run2.out` |
| G6 | `node --test "apps/arkui-schedule/tools/test/*.test.mjs"`（根） | **tests 3234 / suites 461 / pass 3234 / fail 0 / skipped 0**，13908 ms | `.tmp/gates-rv3-app.out` |
| G7 | `node .tmp\probe-407.mjs`（根，Designer 探针） | `RESULT: ALL OK — 18 条` | `.tmp/gates-rv3-probe407.out` |

- 两次插件全量**数字完全一致**（976/974/0/2），与 `docs/MODULES.md:710` 的登记数字一致；app 侧 `3234/3234/0/0` 与登记一致。
- **构建没有改动 `dist/`**：build 之后 `git status` 仍为空，`DIST-WINDOW: 0`（提交里的 `dist/` 与 HEAD 逐字节一致；`DIST-FRESHNESS` 又证明它与一次全新 `tsc` 输出一致）。本批无 `.ets`，不欠 ArkTS 构建。
- 2 条 skip 的来源已点名：① `F10 store: 0600 权限（POSIX）`（Windows 固有）；② `fetch 直连时…`（本机 `NODE_USE_ENV_PROXY=1` 且 `NO_PROXY` 不含 `192.168.1.5`，被系统代理接管）。后者是**注册期静态 skip**，已进 LAN 台账的 `staticSkipped`（见 §7）。

### 1.3 我自写的攻击探针（全部 `.tmp/`，离线、不联网、不碰真机/live repo）

| 探针 | 覆盖 | 结果 | 留存 |
| --- | --- | --- | --- |
| `.tmp/rv3-attack-classify.mjs` | 分类顺序、数字提取、P2-4 回归、`remote:`/`hint:` 绕过、404 路径 | `pass=42 fail=0 bypass=4` | `.tmp/gates-rv3-attack-classify.out` |
| `.tmp/rv3-attack-census.mjs` | PO-12 注释守卫可欺骗性（M1–M8） | `pass=9 fail=0`（M1–M3 欺骗成立） | `.tmp/gates-rv3-attack-census.out` |
| `.tmp/rv3-attack-reservation.mjs` | 双释放 / 释放他人槽位 / close 后占槽 / close 后上游 socket | `pass=9 fail=0` | `.tmp/gates-rv3-attack-reservation.out` |
| `.tmp/rv3-attack-ledger-vacuous.mjs` | 台账空过与「探测坏了」场景 | `pass=17 fail=0`（场景 B 全绿） | `.tmp/gates-rv3-attack-ledger.out` |
| `.tmp/rv3-diag-destroy.mjs` + `.tmp/rv3-attack-upstream-alive.mjs` | 攻击 4 的夹具校准（见 §6 方法学） | 仅用于诊断，**不作为结论证据** | `.tmp/gates-rv3-diag-destroy.out`、`.tmp/gates-rv3-attack-upstream-alive.out` |

### 1.4 树干净证明

- 评审前：`git status --porcelain` → 空；评审后：空；`git diff` / `git diff --cached` → 空。
- 唯一新增的仓库文件是本文件 `docs/REVIEW-b11c-hardening.md`；`.tmp/` 已被 `.gitignore` 的 `.tmp/` 规则忽略。
- 没有向 `.ets` / `dist/` / 源码 / 其它文档写入任何字节。

---

## 2 分类顺序与数字提取的攻击结果

构造方式：每一条都打到 **shipped `dist/`**（`GitRepoV2Port.pushMain()` 与 `GitRepo.lsRemote()`），只注入 stderr，不联网。

| # | 构造（stderr） | 期望 | 实测 | 判定 |
| --- | --- | --- | --- | --- |
| 1a | `returned error: 403` 行在前 + `Could not resolve host` 行在后 | `unreachable` / 无 status | `unreachable` / 无 status | ✅ 硬证据胜出 |
| 1a-engine | 同一串走 `GitRepo.failure()` | 同上 | 同上 | ✅ 两个入口同判 |
| 1b | DNS 证据在前 + 403 在后 | `unreachable` / 无 status | `unreachable` / 无 status | ✅ 顺序无关 |
| 1b-engine | 同一串走 engine | 同上 | 同上 | ✅ |
| 2a | `403 KiB/s` | 无码、不可定原因 | `codes=[]` / `null` | ✅ 速率不是码 |
| 2b | `100% (403/403)` | 同上 | 同上 | ✅ 比例不是码 |
| 2c | `https://x:407abc@host/repo.git` | 同上 | 同上 | ✅ userinfo/端口不是码 |
| 2d | `Receiving objects: 100% (407/407), 1.20 MiB \| 403 KiB/s` | 同上 | 同上 | ✅ 字节+速率不是码 |
| 2e | `Resolving deltas: 100% (403/403), done.` | 同上 | 同上 | ✅ 增量数不是码 |
| 2f | `Total 407 (delta 403), reused 0 (delta 0)` | 同上 | 同上 | ✅ |
| 2g | `Failed to connect to gitee.com port 403` | `unreachable` / 无 status | `unreachable` / 无 status | ✅ 端口号不抢硬证据 |
| 2h | 裸 `HTTP/1.1 403`（非回显行） | `auth-rejected` / 403 | `auth-rejected` / 403 | ✅ 设计行为（协议行本身带判别性上下文） |
| 2i | `HTTP/1.1 200 Connection established` + `Received HTTP code 407 from proxy after CONNECT` | `proxy-auth` / 407 | `proxy-auth` / 407 | ✅ 句子形状先于协议行，200 不抢先 |

**小结**：分类顺序与提交声明一致（typed → killed/timeout → 硬传输证据 → 状态码 → 鉴权文本 → non-ff → 超时文本 → `git-failed`）；**没有任何进度数字 / 比例 / 令牌片段 / 端口号 / 增量数 / 字节数被提取成状态码**。唯一的破口在"硬证据本身"（§3 的 4l），不在数字提取。

---

## 3 P2-4 回归攻击结果（含 `remote:` 绕过尝试）

### 3.1 删掉 `unable to access` 会不会把真 DNS/connect 失败推到 auth

| # | 构造 | 期望 | 实测 | 判定 |
| --- | --- | --- | --- | --- |
| 3a | 只有包装前缀：`fatal: unable to access '<url>': `（句号后什么都没有） | 不得 `auth-rejected` | `git-failed` | ✅ 不会误判成凭据问题 |
| 3b | 包装 + `Could not resolve host: gitee.com` | `unreachable` | `unreachable` | ✅ |
| 3c | 大小写混写：`FATAL: UnAbLe To AcCeSs … COULD NOT RESOLVE HOST` | `unreachable` | `unreachable` | ✅ 证据正则 `i` 生效 |
| 3d | 原因短语**折行**：`unable to access 'x':\nCould not resolve host…` | `unreachable` | `unreachable` | ✅ 证据按整段扫（不是按行） |
| 3e | 包装 + `Failed to connect … Connection refused` | `unreachable` | `unreachable` | ✅ |
| 3f | 包装 + `returned error: 403` | `auth-rejected` / 403 | `auth-rejected` / 403 | ✅ Gitee 原症状不回归 |
| 3g | 包装 + DNS 证据 + 403（两行） | `unreachable` / 无 status | `unreachable` / 无 status | ✅ |
| 3h | `TRANSPORT_HARD_EVIDENCE_PATTERNS` 里是否还有 wrapper | 不在 | `absent` | ✅ |
| 3i | `TRANSPORT_DROPPED_WRAPPER_PATTERNS` 内容 | `unable to access` | `unable to access` | ✅ 可被测试钉住 |

**结论**：P2-4 的回归风险**未发生**——去掉包装前缀没有让任何一条真实 DNS/connect 文本落到 `auth-rejected`；"只有包装、没有原因"的退化文本落到 `git-failed`（既不冤枉网络也不冤枉令牌），是三者中最诚实的兜底。

### 3.2 行门闸绕过尝试

| # | 构造 | 期望 | 实测 | 判定 |
| --- | --- | --- | --- | --- |
| 4a | `remote: HTTP 403` | 不成码 | `[]/null` | ✅ |
| 4b | `  \tremote: HTTP 403`（前导空白+tab） | 不成码 | `[]/null` | ✅ `trimStart` 后仍命中前缀 |
| 4c | `REMOTE: HTTP 403`（大写） | 不成码 | `[]/null` | ✅ `/i` |
| 4d | `Remote : HTTP 403`（冒号前有空格） | 不成码 | `[]/null` | ✅ `\s*:` |
| 4e | `hint: HTTP 403` | 不成码 | `[]/null` | ✅ |
| 4f | `remote: HTTP/1.1 403 from hook` | 不成码 | `[]/null` | ✅ 协议行也被门禁 |
| 4j | `remote: HTTP 403\r\nfatal: … returned error: 302` | 回显行跳过、302 仍被认出 | `[302]/null` | ✅ CRLF 切行正确 |
| 4g | `remote: returned error: 403` | 已知残余（句子形状不做门禁） | `[403]/auth-rejected` | ⚠️ 已登记残余 |
| 4h | `x remote: HTTP 403`（`remote:` 在中途） | 门禁不命中 | `[403]/auth-rejected` | ⚠️ 绕过成立（现实性低） |
| 4i | `remote: … see HTTP` + 续行 `HTTP 403 section` | 门禁不命中 | `[403]/auth-rejected` | ⚠️ 续行绕过（现实性低） |
| **4l** | `remote: CI log: … Connection refused` + **真 403** | `auth-rejected/403`（回显不是证据） | **`unreachable` / 无 status** | ❌ **新发现 P2-1** |

**关于 4g–4i**：提交在 `docs/MODULES.md:710` 与测试 `:330-333` 已把「句子形状在 `remote:` 回显里仍会被认」登记为**判断取舍**（一并门禁会误伤真实 curl 输出）。我同意这个取舍，本轮不据此判红；`hint:` 变体同理。

**关于 4l（P2-1）**：这是 P2-4 的**镜像**，也是本轮唯一的新分类缺陷。
- 机制：`hasTransportEvidence()` 对**整段文本**扫（`src/engine/git.ts:143-145`），不看行前缀；而松形状的状态码扫描是**按行门禁**的。于是同样的 `remote:` 回显，含 `Connection refused` 时会被当成"链路真的没通"，并**先于**状态码胜出。注意这是本批"硬证据优先"顺序**引入**的新答案：在 `df512e7` 的旧顺序（状态码先于证据）下，同一串会判 `auth-rejected/403`。
- 为什么这是缺陷而不是取舍：真实 DNS 失败时 `Could not resolve host` 只会出现在 **git 自己的 `fatal:` 行**（`remote:` 行是远端钩子的输出，不是 git 的 HTTP 客户端）。因此"证据也按行排除 `remote:`/`hint:`"不会丢掉任何真实证据，却能让 4l 回到 403。
- 概率：需要远端钩子/CI 日志里恰好含硬证据短语，且同一次 push 还有真状态码——低，但方向与本次修复正好相反（把凭据问题说成网络问题）。
- 建议（成本 ≈ 3 行 + 2 条负例）：`hasTransportEvidence()` 增加"仅在非回显行上找证据"的变体，或在 `failure()`/`textFailureOf()` 里先用 `httpStatusCodesOf` 的同一套切行逻辑过滤。

---

## 4 404 路径攻击结果

| # | 构造 | 期望 | 实测 | 判定 |
| --- | --- | --- | --- | --- |
| 5a | `remote: build log line 404: not found` | 不成码 | `[]/null` | ✅ 裸 404 不成码 |
| 5b | URL 路径含 `/404` + DNS 失败 | 不成码 | `[]/null` | ✅ 路径里的 404 不成码 |
| 5c | 令牌形态片段里含 `404`（`token=<redacted>404abc`） | 不成码 | `[]/null` | ✅ 令牌片段里的 404 不成码 |
| 5d | `fatal: cannot open timeline/404/records.json` | 不成码 | `[]/null` | ✅ 文件路径里的 404 不成码 |
| 5e | `port 404` | 不成码 | `[]/null` | ✅ 端口号不成码 |
| 5f | `the server said 404`（无句子形状） | 不成码 | `[]/null` | ✅ "没有句子形状就不发明原因" |
| 5g | `hint: HTTP 404` | 不成码（门禁） | `[]/null` | ✅ |
| 5h | `remote: returned error: 404` | 句子形状残余（与 4g 同类） | `[404]/not-found` | ⚠️ 已登记类残余 |
| **5i** | `CONNECT tunnel failed, response 404` | 不应归因给仓库 | `[404]/not-found` | ❌ **新发现 P2-2** |
| **5j** | `Received HTTP code 404 from proxy after CONNECT` | 同上 | `[404]/not-found` | ❌ **新发现 P2-2** |
| 5k | `returned error: 404`（正常句形） | `not-found` / 404 | `[404]/not-found` | ✅ 基线 |

### 4.1 无关 404 不能造出 `not-found`（结论）

- 文本类 404（echo 无句形、URL、令牌、路径、端口、裸数字）**全部不能**成码——`not-found` 只在四种"句子形状"上产生。
- 例外有两处：① 句子形状在 `remote:` 回显里仍会被认（5h，与 4g 同一类，已登记）；② **代理句形里的 404**（5i/5j）会落到 `not-found`。

### 4.2 P2-2：代理 404 被归因给仓库

- `HTTP_STATUS_SENTENCE_SOURCES` 里的两条代理形状（`src/engine/git.ts:204,207`）只要求"带 `from proxy` / `CONNECT tunnel failed,`"，**不区分码的来源**。407 用它们判 `proxy-auth` 是对的；但一个 404 从代理出来时，`httpStatusFailureOf()` 照样给出 `not-found/404`，文案变成「仓库不存在或当前凭据看不到它」，下一步把用户送去核对**仓库地址与私有库权限**——而真正该看的是代理/网关（或登录门户）。
- 这不是"无关 404"，而是"**有关但来源不对**的 404"。概率低（CONNECT 回 404 的代理少见），但它是本批新引入的归因，与 P2-3（5xx 同时提代理）是同一类诚实要求。
- 建议：给 `httpStatusFailureOf` 的返回值带上来源（`'proxy' | 'repo'`），或在 404 落 `not-found` 前排除两条代理形状；至少把 404 的文案/下一步补一句"也可能是代理/网关回的 404"。

### 4.3 `network:false` + 文案 + `details.status=404` 的一致性

实测（5l）：

```
push   message = 推送失败：远端返回 404，仓库不存在或当前凭据看不到它
push   details = {"reason":"not-found","status":404}      keys=reason,status
push   isNetworkFailure = false
engine details = {"command":[…],"exitCode":128,"network":true,"reason":"not-found","status":404}
engine isNetworkFailure = false
```

- **三处自洽**：文案只讲仓库/凭据；`details` 只有 `reason` + 纯数字 `status`（不含 URL/用户名/令牌）；`isNetworkFailure()` 因 `reason === 'not-found'` 在 `network === true` **之前**返回 false，所以 `reachable` 不会被写成 false。
- 其余未映射码（302/400/405/422）实测 `reason=git-failed`、`details.status === undefined`、文案「git 拒绝了本次推送…」且不含"不可达"——`network:false` 与文案一致。
- 一个**边界**（不判红）：engine 的 `details.network` 仍然是 `true`（命令确实是网络命令），只是归因函数把它豁免。任何**绕过 `isNetworkFailure()` 直接读 `details.network`** 的新调用方会重新把 404 写成"连不上"；目前 `src/rpc.ts` 的三处都走 `isNetworkFailure()`，没有这样的调用方。

---

## 5 注释台账守卫的可欺骗性

复刻 `test/plugin-pending-ownership.test.mjs` 的三段文本解析（`documentedPushPhraseCount` / `cycleAllowedReasons` / `quotedPushPhrases`），再对 `src/sync/cycle.ts` 的**文本副本**做篡改；"真实数组"用 `eval(Object.freeze([...]))` 取出长度，不依赖文本扫描。

| # | 篡改 | 注释 | 文本解析 | **真实数组** | 守卫 | 判定 |
| --- | --- | --- | --- | --- | --- | --- |
| — | 基线 | 10 | 10 | 10 | GREEN | ✅ 当前一致 |
| M1 | 追加第 11 条，用**双引号** `"推送失败：…"` | 10 | 10 | **11** | **GREEN** | ❌ 可欺骗 |
| M2 | 追加第 11 条，用**模板字面量** | 10 | 10 | **11** | **GREEN** | ❌ 可欺骗 |
| M3 | 追加第 11 条，**不以「推送失败：」开头** | 10 | 10 | **11** | **GREEN** | ❌ 可欺骗 |
| M4 | 注释数字改成中文「十」 | — | matches=0 | 10 | RED | ✅ 挡住 |
| M5 | 同一句标注出现两次 | 2 处 | matches=2 | 10 | RED | ✅ 挡住 |
| M6 | 注释改 9、数组删到 9（`SHIPPED` 常量仍 10） | 9 | 9 | 9 | RED | ✅ 第三方差拦住 |
| M7 | 只把 `gitPort.ts` 的「十条短语」写错 | 不受扫描 | — | — | 无人校验 | ⚠️ 跨文件同类数字无守卫 |
| M8 | 测试是否 import 真实数组 | — | — | — | `作为值导入：false` | ❌ 从未运行时比对 |

**结论**：
- 守卫对"注释里的数字漂移"（汉字、重复、数字与数组一起改）**有效**，M4–M6 证明它不是恒真。
- 但它**不能**证明注释与 `ALLOWED_PUSH_REASONS.length` 一致：它比较的是"文本重扫出的短语数"，而重扫只认**单引号、单行、以「推送失败：」开头**的字面量。M1–M3 让真实白名单变成 11 条，注释与重扫仍是 10，PO-12 **全绿**——`cycle.ts:1076-1077` 的「与 `ALLOWED_PUSH_REASONS.length` 精确比对」和 `test:523` 的「必须等于数组实际长度」都是**对度量对象的误述**（P2-3）。
- 影响面：白名单只会**放宽**终态消息的接受面（不是安全闸门），所以这不是安全漏洞；但它是一句会撒谎的守卫——正是 P2-6 要消灭的那类东西换了个位置。
- 建议（二选一，成本都小）：① 把 `ALLOWED_PUSH_REASONS` 导出后按**运行时长度**断言（同时删掉重扫依赖）；② 或保留重扫，但额外断言白名单块内不出现 `"` / 反引号 / `+` 拼接，且每条元素都以 `'推送失败：` 开头——把"文本扫描等价于数组"变成**构造性事实**，而不是假设。
- M7 提醒：`gitPort.ts:434` 的「十条短语都以「推送失败：」开头」也是同类可漂移数字，只是没被守卫覆盖（可接受，但别把它当作已被校验）。

---

## 6 预约生命周期四次攻击结果

环境：本机 `LAN=192.168.137.1`，临时 TLS 监听（`pairingTls.generatePairingCertificate()` 自签），哑上游是 `net` 服务器（接受 TCP、**一个字节都不回**）。探针 `.tmp/rv3-attack-reservation.mjs`，结果 `.tmp/gates-rv3-attack-reservation.out`。

| 攻击 | 手法 | 期望 | 实测 | `remote-listener.test.mjs` 能抓到吗 |
| --- | --- | --- | --- | --- |
| ① 双释放 | 上限 1，一条半开握手；destroy 客户端两次，再开新握手 | 计数不重复归还、不变负、新握手能占槽 | `reserved=0 tunnels=0`（关两次）→ 新握手 `reserved=1` | **漏还**能抓（`隧道上限（P2-A）：握手失败的两条路径都恰好归还一次` 用上限 1 连做 3 次 502：漏还第 2 次就变 503）；**过度释放**抓不到——但槽位是 `Set` 里的对象、`release` 有 `released` 布尔（`listener.ts:1147-1156`），结构上不可能"负计数"或误删他人对象 |
| ② 释放别人的槽 | 上限 2，A/B 两条半开；关 A，再进 C，再试 D | A 只还 1 个；C 可进；D 503 | `A 关后 reserved=1`；`C 进 reserved=2`；D 收到 `HTTP/1.1 503` | 部分：`P2-A` 用例断言两条半开各占 1 槽、到顶 503，等价覆盖；`release` 闭包只 `delete` 自己 ⇒ 结构不可达 |
| ③ close 后占槽 | 异步 `authorize` 悬停 → `close()` → 放行 | 不再占槽、不拨上游、客户端干净收口 | `reserved=0`、上游 `accept=0`、客户端 `0 字节 / ended=true`、`rejected+1` | 会：`隧道上限（P2-5）…` 逐条断言（`test:1717-1728`） |
| ④ close 后上游 socket | 上限 2，两条**已拨出、未 101** 的握手（上游打开=2）→ `close()` | 上游 socket 全部销毁 | **`close 后上游打开=0`**（真的从 2 变 0） | **不会**：`P2-A` 用例 close 后只断言 `reserved=0/tunnels=0`（`test:1598-1601`）；`P2-5` 用例的上游 `accept` 在 close **之前**就是 0（从未拨出，`test:1712-1713`）⇒ 对"销毁在飞上游"是空证据 |

**判定**：
- 代码层面四条攻击**全部守住**：`reserveTunnelSlot()` 见 `closed` 返回 null（`listener.ts:1142-1144`）、`runUpgrade` 在 `authorize` / `headers` 两个 await 后都复检（`:1667,1673,1689,1695`）、`shutdown()` 同步归还预约并销毁 `handshakes`（`:1189-1222`）。模块头 `:36-40` 的"无条件成立"这句话，经我的攻击 4 **独立复核为真**。
- 但**仓库内没有断言把攻击 4 钉住**（P2-4）：`docs/MODULES.md:708` 用"异步 `authorize`/`headers` 的用例证明收尾时上游 TCP 连接数为 0"来背书"销毁在飞上游"，而那条用例的 0 是"从未拨出"的 0。结论没错，**证据错位**。
- 建议：在 `P2-A` 用例 close 之后补两行——`for (…) if (silent.state.sockets.size === 0) break;` + `assert.equal(silent.state.sockets.size, 0)`（注意下面的夹具陷阱）。

**方法学留痕（避免复现同一个坑）**：我第一次跑攻击 4 得到"close 后上游仍打开=2"的假阳性。原因是哑上游的 server socket 没有 `resume()`，收到 FIN 也不会触发 `'close'`，`sockets` 集合永远不缩水（`.tmp/gates-rv3-attack-upstream-alive.out` 里连裸 `net.connect` + `destroy()` 都显示 open=1，即为夹具问题）。加上 `socket.resume()` 后结论为"close 后 0"。**仓库里的 `startSilentUpstream()`（`test:473-481`）同样没有 `resume()`**，所以它只能数"累计 accept"，不能数"当前存活"——这也解释了为什么现有用例没有做这条断言（不是漏写，是夹具不支持）。

---

## 7 台账覆盖与空过

### 7.1 `total` 真的是全文件注册数吗（独立点数）

我按行独立数了注册调用（不依赖运行时）：

| 文件 | `test(`（非 LAN） | `lanTest(`（LAN） | 合计 | 运行时 `[LAN-LEDGER]` 打印 | 一致？ |
| --- | --- | --- | --- | --- | --- |
| `test/remote-listener.test.mjs` | 9 | 36 | **45** | `registered=45 gated=36 ran=44 skipped=1` | ✅ |
| `test/gui-proxy-fence.test.mjs` | 7 | 13 | **20** | `registered=20 gated=13 ran=20 skipped=0` | ✅ |

- `skipped=1` 的来源已点名：`fetch 直连时…` 是本机环境代理导致的**注册期静态 skip**，被 `register()` 记进 `staticSkipped`（`test:245-250`），所以 `ran(44)+skipped(1)=45` 自洽。这也说明 `total` 已不是"只数 LAN 用例"的旧口径——P2-8 的主诉（只统计 `lanTest`）**确实关闭**。
- 源码自检（`nodeTest(` 恰好 1 处）成立；两个文件都只剩唯一注册器。

### 7.2 forced-missing 分支是真空过吗

不是真空过：`LAN 台账自检（P2-8）` 用注入 `missing: true` 真的执行了 `runGatedCase`，断言 `executed=[]`、每条都 `t.skip`、`ran=0/skipped=3`，并有"能力存在时同一份代码必须实跑"的对照组（`test:1957-1992`）。纯函数 `lanLedgerVerdict` 的每条不变式也各自判红过（`test:1998-2018`）。

### 7.3 但"探测坏了"这一情形是循环论证（P2-5）

我按运行时数字复刻了"`findBindableLanAddress()` 因 bug 恒返回 null"的场景：

| 场景 | total | gated | ran | skipped | verdict | 台账用例的其余断言 |
| --- | --- | --- | --- | --- | --- | --- |
| A 能力存在（当次真实） | 45 | 36 | 44 | 1 | 绿 | 全绿 |
| B 探测坏了（missing 恒 true） | 45 | 36 | **8** | **37** | **绿** | `total>0` ✓、`gated>0` ✓、`total>gated` ✓、`ran+skipped==total` ✓、`skipped==gated+static` ✓、`ran==total-expected` ✓ |
| A' 能力存在（gui-proxy-fence） | 20 | 13 | 20 | 0 | 绿 | 全绿 |
| B' 探测坏了（gui-proxy-fence） | 20 | 13 | **7** | **13** | **绿** | 同上全绿 |

- 结论：**36 / 13 条 LAN 用例一条都没跑，而两个文件的所有断言仍然全绿**。原因是 `missing` 与 `capabilityMissing` 都由**同一个** `LAN === null` 决定，没有任何第二判据（两个文件都没有"若 `os.networkInterfaces()` 里存在非回环 IPv4 候选，则 `missing` 必须为 false"的对照）。
- 这不影响"跳过不会被当成通过"这条（跳过确实记 skipped），但它让 `跳过只能发生在能力缺失时` 变成**自证**：能力是否缺失，由被测的探测函数自己说了算。
- 建议：在台账用例里加一条**独立**对照——直接读 `os.networkInterfaces()`，若存在非回环、非 `169.254.*` 的 IPv4 且 `net` 能绑定，则断言 `capabilityMissing === false`；否则允许 skip。成本 ≈ 8 行，且不引入新依赖。

---

## 8 诚实性清单（逐句 + 位置 + 是否超证据）

| # | 句子（要点） | 位置 | 证据 | 判定 |
| --- | --- | --- | --- | --- |
| H1 | 「普查测试…断言它等于**数组长度**」/「必须等于**数组实际长度**」 | `docs/MODULES.md:710`、`test/plugin-pending-ownership.test.mjs:523`、`src/sync/cycle.ts:1076-1077` | §5 的 M1–M3：真实数组 11 时守卫仍绿；测试从不 import 该数组 | ❌ **超证据** → P2-3 |
| H2 | 「用**异步** `authorize`/`headers` 的用例证明收尾时上游 TCP 连接数为 0」 | `docs/MODULES.md:708` | `test:1712-1713` 显示 close 前 accept 就是 0；`P2-A` 用例 close 后不断言上游 | ❌ **证据错位**（结论真、证据空）→ P2-4 |
| H3 | 「each git network operation has an explicit budget」 | `packages/dsh-dots/docs/DETAIL.md:247-248` | `src/engine/git.ts:902` 的 `clone` 调用**没有** `timeoutMs`；读预算只给了 `ls-remote`/`fetch`，push 用 `PUSH_TIMEOUT_MS` | ❌ **超证据** → P2-6 |
| H4 | 「本批套件注册数相对 HEAD `df512e7` 多出 **+7**，其中 **+4** 早于本批」 | `docs/MODULES.md:700③` | 静态计数：`df512e7→HEAD` 恰为 +7（gui-proxy-fence +2、plugin-pending +1、push-auth +2、remote-listener +2），与运行时 976 及 `df512e7` 的 969 自洽；+4 是 **b11b 的 965 → df512e7 的 969**，不是"相对 df512e7"的差值 | ❌ **基线混用** → P2-7（`:702` 已给正确对账） |
| H5 | E1 标题「**只有**链路不通 / 凭据类失败才写 `reachable:false`」 | `test/push-auth-classification.test.mjs:762` | 同一用例 `:770` 允许 `timeout`（既非链路不通也非凭据类）写 `reachable:false`；`:775` 允许 `proxy-auth`（代理答了 407） | ❌ **标题与自身断言矛盾** → P2-8 |
| H6 | 「代理**真正**会打印的两种形态」/「两条真实 CONNECT 形态」/「**真实**文案」 | `test/push-auth-classification.test.mjs:252-257,282-284`、`.tmp/probe-407.mjs` 输出标签 | `src/engine/git.ts:193` 与 `docs/MODULES.md:707` 都写「libcurl **文档形态**、本机没有真实代理链路、未曾实机观测」 | ❌ **超证据**（句子本身没带 caveat） → P2-9 |
| H7 | 头注释：「新形状不许把进度数字 / 令牌片段 / **`remote:` 日志里的数字**当状态码」 | `test/push-auth-classification.test.mjs:13` | 同文件 `:333` 亲自钉住 `remote: returned error: 403 ⇒ [403]`（残余） | ❌ **自相矛盾**（后文有残余说明，但头注释没限定） → P2-9 |
| H8 | 「`close()` 返回后 `reservedTunnels === 0` 且没有在飞的上游连接 是**无条件**成立的」 | `src/remote/listener.ts:36-40` | 我的攻击 3/4 独立复核：`reserved=0`、上游 socket 2→0、客户端 0 字节收口 | ✅ **成立**（但仓库内缺断言，见 P2-4） |
| H9 | 「`shutdown()` 同时销毁在飞的上游请求」 | `src/remote/listener.ts:38`、`docs/MODULES.md:708` | 同上，代码为真 | ✅ 代码维度成立 |
| H10 | DETAIL：「The budget actually used is carried in `details.budgetMs` and quoted in the error text」 | `DETAIL.md:251-252` | engine `run()` 超时分支写 `budgetMs`（`git.ts:830-840`），push 写 `details.budgetMs`（`gitPort.ts:451-457`），两处文案都引用当次数字 | ✅ 成立（对**有预算**的命令） |
| H11 | VERIFICATION 追加块：「超时 / 网络不可达 / 凭据被拒 / 代理要鉴权 / 远端或代理 5xx / 限流 / 404 … 各有独立中文原因与下一步」 | `docs/VERIFICATION.md` 末尾「2026-11-24 订正」块、以及行 88 的行内订正 | §2/§3/§4 实测：七类原因确实各有独立文案与下一步；404 的文案/下一步存在 | ✅ 成立（唯一保留意见见下） |
| H12 | 「`DETAIL.md` 改为引用常量名…`VERIFICATION.md` **只追加**（19 insertions / **0 deletions**）」 | 提交信息；`docs/MODULES.md:710` | `git show --numstat fc62951`：`docs/VERIFICATION.md 19 0`；两次订正都在 `+` 侧，历史行未改 | ✅ 成立（行 88 的行内订正也确实是 `+` only） |
| H13 | 「八处 retarget 全部更严」 | 提交信息 | §9：7 条删除 + 129 条新增，其中 `hasTransportEvidence(mixed)` 是 **true→false 的语义翻转**（不是"更严"）；它紧接着加了正向控制组，实质合理 | ⚠️ 措辞松（不判红，见 §9） |
| H14 | 「不写 `reachable:false`」 | `docs/MODULES.md:710`、`src/rpc.ts:229-256` | 实测 404/5xx/429 均为 `isNetworkFailure=false`；`proxy-auth` 仍写 `reachable:false`（提交已在 `:700` ② 登记为残留） | ✅ 对所列三类成立；`proxy-auth` 为已登记残留 |

**关于 `docs/VERIFICATION.md`（append-only）**：H11 我判「成立」，但有一个**窄边界**——追加块把 404 概括成「仓库不存在或看不到」，而 §4.2 的代理 404 也会落到这句。若 Lead 决定不修 P2-2，则 **append a 订正 block** 说明「CONNECT/代理句形下的 404 也可能来自代理，当前文案按仓库 404 处理」；**不要**改写既有行（该文件 append-only，任何 `-` 行都违规）。

---

## 9 断言纪律（本批是否删/放宽，逐条）

### 9.1 `fc62951` 的删除行

`git diff df512e7..fc62951 -U0 -- packages/dsh-dots/test`：**删除 7 条含 `assert` 的行，新增 129 条**。逐条：

| # | 删除的断言 | 替换成 | 判定 |
| --- | --- | --- | --- |
| 1 | `httpStatusFailureOf('… HTTP 404') === null`（404 不发明原因） | `deepEqual(…, {reason:'not-found', status:404})` + 文案/下一步断言 | **收紧**（旧断言钉的是缺陷） |
| 2 | `httpStatusCodesOf('remote: build log: see HTTP 403 section') === [403]` | `=== []` + `httpStatusFailureOf === null` + `hint:`/前导空白两条负例 | **收紧** |
| 3 | `seenMessages.size === 4` | `=== 5`（加 `not-found`） | 等价严格（新原因数变了） |
| 4 | `seenSteps.size === 4` | `=== 5` | 同上 |
| 5 | `hasTransportEvidence(mixed) === true`（"旧误报的成因"） | `=== false` + **正向控制组** `hardControl === true` | **语义翻转**，不是"更严"；但旧断言钉的是 bug 成因，翻转 + 控制组后不再有"证据集被掏空"的空子 |
| 6 | `assert.ok(total > 0, …)`（台账只数 LAN） | `total > 0` + `gated > 0` + `total > gated` + `expectedSkipped = gated + static` | **收紧**（旧口径下 total 只能是 LAN 数，新口径下必须严格大于它） |
| 7 | `skipped === (capabilityMissing ? total : 0)` | `skipped === expectedSkipped`（含 static）且 `ran === total - expectedSkipped` | 收紧/更精确 |

- 结论：**没有一条断言被净删除或放宽**；与提交信息「未删除、未放宽」一致（唯一措辞不精确的是把第 5 条也算进「更严」，见 H13）。
- 前两提交：`7a34b70` 删 6 条 assert（3 条 `5 → 9` 计数、3 条 `Authentication failed` 由 `auth-prompt` 改判 `auth-rejected`），全部为 retarget；`2b22e8c` 删 0 条。整批累计 13 条删除、全部有等价或更严的替代。

### 9.2 新增测试是否真的能失败

- G1/G2 都有"同伴用例/反向控制组"（`G1` 里 403 无 DNS 仍 `auth-rejected`；`G2` 里无状态码的 DNS 仍 `unreachable`），不是只钉一个方向。
- PO-12 带 tamper 检查（把数字换成 5 必须与数组长度不等）——**这条 tamper 本身只有效于"数字"维度**；M1–M3 绕开的正是它没覆盖的"度量对象"维度（P2-3）。

---

## 10 `unverified` 边界（本评审没有、也不能证明的东西）

1. **没有真实代理链路**：从未用真实 `HTTPS_PROXY` 推送；两条 CONNECT 407 文案仍是 libcurl **文档形态**（本机零实机观测）。P2-1 的 4l 与 P2-2 的 5i/5j 同样是构造文本，不是线上观测。
2. **没有真实远端状态码**：未对真实 Gitee/GitHub 打 401/403/404/302/DNS 失败；`not-found` 的"仓库改名/私有库无权限"两种真实处境未复现。
3. **没有真机 / 没有 live repo / 没有 DSH 实例**：本评审只跑 node 门禁与离线探针；`hdc`、真实平板、live push 一律未碰（也不允许）。
4. **没有 OS 级 FIN 观测**：攻击 4 只证明 `ClientRequest.destroy()` 被调用且对端 socket 进入 `'close'`（探针侧 2→0）；没有抓包证明 FIN/RST 在网络层的行为。
5. **`clone` 无预算只做了源码阅读**（`src/engine/git.ts:902`），没有用真实远端实测"clone 会无限等"。
6. **+4 注册数未溯源**：我只验证了 `df512e7→HEAD` 的 +7（静态 + 运行时双侧自洽）；965→969 那 +4 需要 `df512e7` 树跑一次全量才能定位，本次未做（不能 checkout）。
7. **Windows 孙进程**：`git-remote-https` 持有管道延迟 `SIGTERM` 结算的场景仍未复现（沿用 b11 P2-5 的边界）。
8. **探针自身**：所有分类断言都基于注入 stderr；真实 git 的输出顺序/缓冲可能与我构造的字符串不同（尤其是 `remote:` 与 `fatal:` 行的交错顺序）。

---

## 11 冻结建议

- **裁决：可以冻结（freeze-with-fixes）**。P0/P1 均为 0；9 条 P2 全部不阻断，主承诺（"推送失败不再把凭据/404 说成网络不可达"）成立，且有见证、负例与同伴控制组。
- **建议同批小修（3 条，代价都很小、都在本模块文件集内）**：
  1. **P2-1**：硬证据扫描同样按行排除 `remote:` / `hint:`（或在 `httpStatusFailureOf` 命中时优先）。约 3 行 + 2 条负例（4l 的构造 + 正向控制 `fatal:` 行的 DNS 仍 unreachable）。
  2. **P2-3**：导出 `ALLOWED_PUSH_REASONS` 并按**运行时长度**断言；或断言白名单块内无 `"`/反引号/`+` 拼接。约 5 行，顺带让 `cycle.ts:1076` 与 `test:523` 的措辞变成事实。
  3. **P2-5**：台账用例加一条独立对照——`os.networkInterfaces()` 存在可绑定非回环 IPv4 时，`capabilityMissing` 必须为 false。约 8 行，把"自证"变成"互证"。
- **建议排后续（6 条，不阻断）**：P2-2（代理 404 的来源区分）、P2-4（`P2-A` 用例补 close 后上游 socket=0 的断言，并给夹具加 `resume()`）、P2-6（`DETAIL.md` 措辞改成"有预算的命令"或补 clone 现状）、P2-7（`MODULES.md:700③` 的 +7/+4 改成同一基线）、P2-8（E1 标题）、P2-9（CONNECT 措辞加"文档形态、未实机观测"；头注释限定句子形状残余）。
- **若 Lead 决定不再改动**：可以按现状冻结。这 9 条里没有一条会让用户拿到"错误的下一步"到不可接受的程度——4l 需要远端回显恰好含硬证据短语，5i/5j 需要代理回 CONNECT 404；其余是文档与守卫的措辞问题。
- **复核入口**：本报告 §2–§4 的每条构造都可用 `.tmp/rv3-attack-classify.mjs` 重放；§5 用 `.tmp/rv3-attack-census.mjs`；§6 用 `.tmp/rv3-attack-reservation.mjs`（注意：哑上游必须 `resume()`，否则会得到"上游永不关闭"的假阳性）；§7 用 `.tmp/rv3-attack-ledger-vacuous.mjs`。
