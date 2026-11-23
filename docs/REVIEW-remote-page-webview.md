# 评审：mod-remote-page-webview（工作树未提交改动）

评审范围：`git status --short` 列出的 8 个路径（3 改 / 5 新）；基线 = 任务给定的模块意图五条。
评审方式：只读 `git diff`、逐文件读源码与测试、grep 构建日志与文件 mtime。未改任何源文件，未运行任何写操作。

## 结论

**PASS WITH FINDINGS**。五项核心机制经源码核对基本成立：`sslAllowance` 确为单次消费 + 10 s 有界 TTL（`sslAllowance.ts:89-125`，测试 A1/A2/B1），无 pin 不 grant、mismatch 一律 refuse（`RemoteControl.ets:251-261, 279-286, 449-460`），pin 预检在 Web 挂载之前发生且 Web 只在 `webMounted` 分支挂载（`RemoteControl.ets:263-315, 832-836`），token/指纹/pin 未进入 UI 文案、控制台或测试输出。规则 9/10 的构建声明**成立**（见检查清单第 7 条）。但有 3 项 P1：两处 UI 文案超出可证明范围（把"只比了叶证书指纹"说成"已校验证书链"、给明文 http 也显示"预检 vs WebView 两条连接"的 TOCTOU 说明），以及两个被 MODIFIED 的测试文件里确实删掉了既有断言（虽已 retarget，仍需 Lead 明示确认）。无 P0；下列 P1 修复后可直接提交。

## 检查清单

1. **P1 — https 成功行文案夸大：只比了叶指纹，却写"已校验证书链"**。`entry/src/main/ets/model/pageTransport.ts:37` 的 label 为 `'已校验证书链 + 指纹一致'`。但证据只在叶证书：`model/remotePinnedClient.ts:207-212` 明写 x509Certs 仅作"形状/歧义信号"、字节只来自 pemCerts[0]；`model/remotePinnedClient.ts:235` 只做 `SHA256(DER)` 与 pin 的恒定时间比较；`pageTransport.ts:7` 自己也写"预检只证明这一张叶证书与 pin 一致"。没有任何签名链/根信任校验。禁用词表（`pageTransport.ts:23`）也没有覆盖"已校验证书链"，所以 `pageTransport.test.mjs:77-83` 的禁用词测试抓不到。**修**：改成"已比对叶证书指纹一致"，并把该词加入 `BANNED_PAGE_WORDING` 或逐字 pin 新 label。

2. **P1 — TOCTOU 说明对所有 PHASE_READY 无条件上屏，包括根本没有预检的 http**。`RemoteControl.ets:737-753` 的 `TransportInfo()` 第三个 `Text` 恒渲染 `TOCTOU_SENTENCE`；`RemoteControl.ets:830` 在 PHASE_READY 无条件调用它，而 http 分支在 `RemoteControl.ets:243-245` 直接 `applyDecision('http')` 返回、从不发预检。于是明文页会显示"预检校验的那张叶证书属于先前的连接…"（`pageTransport.ts:64-66`）——描述了一次不存在的校验，违反意图的"honest labels"。**修**：`TransportInfo` 里按 `this.address.scheme === 'https'` 才渲染第三行；或在 http 决策行加专属 TOCTOU 文案=空，并补一个页面接线测试断言 http 时页面上不出现 `TOCTOU_SENTENCE`。

3. **P1 — 两个 MODIFIED 测试文件删除了既有断言（原文见下，"断言未删声明"节逐条引用）**。`tools/test/remoteCommandComposer.test.mjs:303-312`（G2）与 `tools/test/remoteOutcome.test.mjs:238-274`（E3/E4/E5）替换了原有 `assert.equal(remoteSrc.split(line).length - 1, 1)`、`assert.match(apply, /this\.reportRefusal\('no-pin'\)/)` 等断言。替换后的断言方向相反（改为断言旧句"绝迹"）且覆盖了新终局，语义上是随意图变更的 retarget，不是纯放宽；注释也自称"不是删断言"。但逐字比较确实是**删除**，`CLAUDE.md` 的"不许删或放宽既有断言"与 `MODULES.md` §0 纪律要求 Lead 对此显式背书。**修**：Lead 在批次报告里逐条写明"因页面不再发送凭据而反转为 absence 守卫"，或保留一条正向守卫（如命令通道 `E_COMMAND_REMOTE_UNVERIFIED` 文案逐字出现）以替代被删的计数断言。

4. **P2 — http 由"永久拒绝"改为明文直连，且 URL 保留 query token**。`RemoteControl.ets:29, 243-245` 注记"http ⇒ 直接 load"，`RemoteControl.ets:240-241` 用 `normalizeRemoteUrl(raw)` 的原 URL 作 `Web.src`（含 `?token=`）。这是模块意图明确声明的行为（非回归），但相对旧实现"非 https 绝不加载明文页"是安全姿态变化：bearer token 以明文查询串过网。`sslAllowance` 对 http 完全不参与。**修**：产品侧确认接受；至少在 http label 里点名"令牌以明文传输"，或要求 https 才带 token。

5. **P2 — TOCTOU 残留风险真实存在，披露诚实但防护有限**。`RemoteControl.ets:449-453` 的 `handleSslError` 只凭 `sslConsume()` 命中就 `handleConfirm()`，不再读 `event.certChainData`；预检是 `requestWithValidation` 独立连接（`RemoteControl.ets:263-315`），改动恰在两者之间换证书不会被发现。`pageTransport.ts:64-66` 已逐字披露，符合意图"不假装两次连接是同一条"，故不是 fail-open 缺陷，只是已知上限。**修**：保持披露；若后续要收敛，需切 `onSslErrorEvent` 并对主文档 `certChainData` 再验一次指纹（模型头 `sslAllowance.ts:22-24` 已说明本次不在范围内）。

6. **P2 — IPv6/Tailscale 的 `expectedHost` 归一化在真机未证，可能误拒**。`RemoteControl.ets:257` 传 `expectedHost: addr.host`（无括号、小写，如 `fd7a:…:1`），`model/remotePinnedClient.ts:201` 用 `context.host.toLowerCase()` 逐字比对。SDK `ValidationContext.host` 对 `[ipv6]:port` 形态是否带方括号无本地证据；若带括号则 `E_HOST_MISMATCH` → 预检拒绝 → IPv6 页永远打不开，削弱意图第 1 条的 IPv6 覆盖。该路径 fail-closed，不构成安全放行。**修**：真机门禁采样 `context.host` 形态后决定是否在 `verifyLeafPin` 前剥方括号；未验前标 `unverified`。

7. **P2（核验记录，非缺陷）— 规则 9/10 构建声明成立**。`grep .build-logs/build-20261123-195215.log`：`:1378` 为 `Finished :entry:default@CompileArkTS... after 3 s 568 ms`（EXECUTED），`:1401` 为 `BUILD SUCCESSFUL in 8 s 214 ms`；全文 `UP-TO-DATE` 仅出现在 PreBuild/CompileResource 等 19 个其它任务，**无任何 `UP-TO-DATE … CompileArkTS`**，末尾 `42 tasks in total: 23 executed, 19 up-to-date`。日志 `:1370` 起的 ArkTS WARN 坐标含 `RemoteControl.ets:171:29 / 196:49 / 529:23`，与当前源码行号一致；所有模块源文件 mtime 最新为 `RemoteControl.ets 19:51:59`（log mtime `19:52:28`，文件名起始 `19:52:15`），均不晚于日志，故构建覆盖当前字节。ArkTS 语法风险复查未见新增违规：`Object.freeze + Readonly<Record<…>>` 在既有 `model/remoteCommandGate.ts:43` 已编译通过；`Map`/`.fill()`/`Number.isFinite`/async ValidationCallback 在既有 ets 文件均有先例，故不因"build log green"另报编译失败。

8. **P2 — 测试覆盖缺口（仅有形状守卫，缺关键门控断言）**。`tools/test/pageTransport.test.mjs:119-128` 的 C3 只断言 `applyAddress` 内无 `sslGrant(`，没有断言"`sslGrant` 只在 `pinOk===true` 之后执行"；`tools/test/sslAllowance.test.mjs` 未测 refresh 重新 grant 后是否仍单次消费（对应 `RemoteControl.ets:507-509`）。建议补：（a）在 preflight 方法体内 pin 上 `if (!pinOk) return` 与 `sslGrant(` 的先后顺序，（b）grant→consume→refresh-grant→consume 的两轮单次性。

## 未覆盖 / 无法自证

- **unverified** — 真机 ArkWeb 行为：`onSslErrorEventReceive` 是否确为"仅主文档一次"、自签证书下 `handleConfirm()` 后能否真正打开页面、刷新是否二次触发 SSL 回调。全部结论来自 SDK 注释与源码，未上设备。
- **unverified** — `http.ValidationContext.host` / `pemCerts` / `x509Certs` 在 IPv6、Tailscale、多证书链上的实际取值；预检是否在所有目标上可达。
- **unverified** — DSH 服务端对无凭证 `POST /` 预检的响应；`requestWithValidation` 不分类 HTTP 状态（`services/remotePinnedClient.ets:162-169`），故"预检成功"不等于页面可达，代码只声明"证书通过"，未声称可达性，符合诚实口径。
- **unverified** — 评审未运行测试套件或 tsc（只读约束，且测试依赖 `.build/model/*.js`）。规则 10 要求的 gate 输出留存由交付方负责，本评审未产生 `.tmp/gates-*` 证据。
- **unverified** — 未验证 `docs/MODULES.md` §1 是否已登记 `mod-remote-page-webview`（本次改动不含该文件；按 §0 规则 5 应在提交前补齐）。

## 断言未删声明

**有既有断言被删除/改写，逐条如下（引自 `git diff` 的 `-` 行）。**

`tools/test/remoteCommandComposer.test.mjs`，G2（原"G2 原有硬拒绝文案逐字保留且只出现一次"）：
```
-    const line = '安全连接尚未启用，未向电脑发送凭据。';
-    assert.equal(remoteSrc.split(line).length - 1, 1, '原文案必须保持且计数不变');
```

`tools/test/remoteOutcome.test.mjs`：
```
E3（原"无 pin / 非 https / 永久拒绝三条分支都报 fail"）
-    assert.match(apply, /this\.reportRefusal\('no-pin'\)/);
-    assert.match(apply, /this\.reportRefusal\('not-https'\)/);
-    assert.match(apply, /this\.reportRefusal\('permanent-refusal'\)/);
E4（原"TLS / Web 终局报 fail，只有 onPageEnd 报 ok"）
-    assert.match(ssl, /'tls-mismatch'[\s\S]*'no-pin'[\s\S]*'chain-unverifiable'/);
-    assert.match(ssl, /this\.reportRefusal\(refusalKind\)/);
E5（原"batch-1 的 composer 挂载与硬拒绝文案逐字保留且各恰好一次"）
-    const line = '安全连接尚未启用，未向电脑发送凭据。';
-    assert.equal(REMOTE.split(line).length - 1, 1, '原文案必须保持且计数不变');
```

未发现整个 `test()` 用例被删除，也未发现断言阈值被放宽成更容易通过的方向；删除均伴随"旧行为随意图变更而反转"的 retarget 与等价覆盖（新 G2/E3/E4/E5）。但"既有断言零删除"的字面声明不成立，见检查清单第 3 条。

## 复审（修复后）

复审方式：只读比对修复后的源码 / 测试 / 构建日志与 `.tmp` 输出；未改任何文件、未跑任何写操作。以下 gate / overlay / tsc 输出**仅为读取**，非本评审产生。

**复审结论：PASS WITH FINDINGS**（残余均为 P2 / 流程披露项，不阻断提交；无 P0/P1 代码缺陷）。

### 逐条闭合状态

| 原条目 | 状态 | 证据与核对结论 |
| --- | --- | --- |
| P1-1 证书链夸大 | **已闭合** | `model/pageTransport.ts:38` label 现为 `已比对叶证书指纹与配对记录一致`；与 `model/remotePinnedClient.ts:207-212,235` 的实际能力（仅叶 DER 的 SHA-256 对比配对 pin）一致，无链/身份/安全形容词。禁用词表在 `model/pageTransport.ts:9` 新增「校验证书链」、`tools/test/pageTransport.test.mjs:23` 同步新增，A7（`:75-81`）逐字钉新 label 且断言不含该词。守卫确实会咬：全仓 `校验证书链` 只出现在模型头注释、别的模型/测试与被忽略的 build cache，经 `stripComments(MODEL)`/`stripComments(PAGE)` 后均无命中，不会误报也不会漏报。 |
| P1-2 TOCTOU 行无条件上屏 | **部分** | (a) 守卫确实包裹：`RemoteControl.ets:766-770` 的 `if (this.address !== null && this.address.scheme === 'https')` 包住 `:767` 的 `Text(TOCTOU_SENTENCE)`；(b) 全页 `Text(TOCTOU_SENTENCE)` 恰好 1 处（grep 仅 `:767`，`:753` 为注释）；(c) http 路径在 `:248-250` 直接返回，且 scheme 为 `http`，不会进入守卫；(d) `pageTransport.test.mjs:153-166` 的 C5 用守卫正则 + 唯一计数 + 守卫在文本之前 + 两者之间无 `}`，移除守卫必然转红。**但 https「无 pin」拒绝路径仍显示该句**，见下方新发现。 |
| P1-3 既有断言被删 | **仍存在（按约定不修）** | 未再编辑：`remoteCommandComposer.test.mjs:303-314` 仍为反转后的 G2，`remoteOutcome.test.mjs:241/268` 仍为 retarget 后的 E3/E5；原文摘引与披露保持不变，由 Designer 逐字上报 Lead。 |
| P2-4 http 明文标签 | **已闭合** | `model/pageTransport.ts:33` 现为 `明文传输，令牌随地址明文发送，仅在你信任的网络内使用`，`:31` 的 `action: 'load'` 未变；`RemoteControl.ets:240-241` 的 Web src 仍取 `normalizeRemoteUrl(raw)` 原 URL（含 query token），故"令牌随地址明文发送"属实且未多报。testing：A1 `:36`、A8 `:83-87` 逐字钉住。 |
| P2-5 TOCTOU 残留风险 | **仍存在（意图内已知上限）** | 原文的分析不变；不是修复引入，按意图由逐字披露接受，标 unverified。 |
| P2-6 IPv6 observed host | **已闭合** | `RemoteControl.ets:291-300` 新增 `normalizeObservedHost()`，仅剥一层前导 `[` 与结尾 `]`；`:317-319` 先归一再作为 `host: observedHost` 传入 `verifyLeafPin`，`model/remotePinnedClient.ts` 未动。安全性：DNS 名与裸 IPv6 无括号 → 原样返回；`expectedHost` 由 `normalizeHostField` 产出、永不含方括号（`remoteAddress.ts:140-159`），故剥括号只对齐表示、不合并两个不同主机；带端口的畸形 `[v6]:port` 剥不完整 → 仍 mismatch → refuse。不存在 mismatch 转正的路径。C6 `:168-180` 钉住调用顺序与传参。 |
| P2-7 构建证据 | **已闭合（新日志覆盖修复后字节）** | 见下节证据。 |
| P2-8 测试缺口 | **已闭合** | `pageTransport.test.mjs:182-191` 的 C7 断言 `!pinOk` 与 `E_PIN_MISMATCH` 分支都在 `sslGrant(` 之前且含 `return;`；`sslAllowance.test.mjs:52-62` 的 A4 跑两轮 grant→consume→二次 consume=false，直接覆盖 `RemoteControl.ets:527` 的刷新再发放。 |

### 新证据（只读核对）

- `apps/arkui-schedule/.build-logs/build-20261123-202021.log`：`CompileArkTS` 为 `Finished :entry:default@CompileArkTS... after 4 min 16 s 89 ms`（EXECUTED），无 `UP-TO-DATE … CompileArkTS`（全文 20 个 UP-TO-DATE 属其它任务，该项计数 0）；`BUILD SUCCESSFUL in 6 min 17 s 420 ms`。日志完成 mtime `2026-11-23 20:26:50.786`。
- 本模块源文件 mtime 全部早于日志完成：`RemoteControl.ets 20:18:16.249`、`pageTransport.ts 20:17:52.801`、`remoteAddress.ts 19:42:01.044`、`sslAllowance.ts 19:47:43.678`。故该日志覆盖修复后的字节，声明成立。
- 仓库根 `.tmp/`：`overlay-app-wave-webview-qr.out` 末行 `[overlay] applied=false`；`gates-app-wave-webview-qr.out` 尾 `tests 3218 / pass 3218 / fail 0 / skipped 0`；`validate-app-wave-webview-qr.out` `全部通过：8/8`；`tsc-app-wave-webview-qr.out` `TSC_EXIT=0`。仅核对存在与内容，未重新运行。

### 新发现（由修复引入）

- **P2 — `entry/src/main/ets/pages/RemoteControl.ets:766`**：新守卫只判断 `address.scheme === 'https'`，没判断"是否真的发过预检"。https 且**无 pin** 的路径在 `:246` 先把 `phase` 置为 READY，随后 `:253-257` 直接 `refuse('no-pin')`、从不调用 `:309` 的 `preflight()`；但 `TransportInfo()` 仍因 scheme 为 https 渲染 `:767` 的 TOCTOU 句「预检校验的那张叶证书属于先前的连接…」，与同屏 `:43` 的「未配对：没有证书指纹…」自相矛盾，描述了一次不存在的校验。这是原 P1-2 的同源残余，修复只覆盖了 http 分支。**修**：把守卫改为 `this.httpsVerified`（`:223` 在每次 applyAddress 重置，仅 `:348` 预检成功后置真），或 `this.webMounted`；并同步 retarget C5（`:155` 的守卫正则）。

## 复审后的可提交判定

**可提交**：P0/P1 代码缺陷为 0；唯一 P2 残余为文案显示条件（不挂 Web、不影响 fail-closed 放行语义），可在提交时一并修掉或作为已知注记；P1-3 的既有断言删除披露须随批次汇报逐字送达 Lead。真机 ArkWeb 回调、IPv6 `ValidationContext.host` 实际形态、gate 输出的实际产出过程仍为 `unverified`。
