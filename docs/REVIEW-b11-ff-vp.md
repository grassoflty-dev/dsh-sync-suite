# 独立只读评审 — batch b11：两个可疑层级模块 `mod-plugin-behind-fastforward` / `mod-app-remote-desktop-viewport`

- 评审对象：`main` @ `2adfe6ab643b75f58ebaa97800f2f0571df99b6b`，工作树中两条未提交车道（两条均由错误模型 `deepseek-v4.1-flash`/high 产出，证据按 suspect-tier 处理，本评审是唯一独立检查）
- 评审方式：只读 + 自跑门禁 + 自写只读探针；**不运行** `node scripts/build.mjs` / `build-harmony.ps1`，不写 `src/**`、`test/**`、`dist/**`，不执行任何 git 写命令，不联网，不用 `hdc`
- 允许写入的唯一仓库文件：本文件；所有探针输出只落 gitignored `.tmp/gates-rvp-*.out`
- 立场：**攻击声明本身**，不复述车道汇报；(a)–(f) 六条探针逐条给结论

---

## 0 结论

- **P0 = 0，P1 = 0，P2 = 6（均为模块/文档措辞与一个低危输入形状漏洞）；另有 1 条并发车道漂移记录（非本模块缺陷，单独记在 §1/§7，不计入 P2）**。裁决：**Freeze-with-fixes（可冻结，附带 6 条 P2 文案/边界修补）**。
- 一句话裁决：**两条模块的核心机制经独立读码与实跑成立**——FF 只有一种固定 argv、一次预算、dirty worktree 走确定性 fail-closed 分叉路径；viewport 的退化阶梯与 rail 交叉校验也都 fail-closed。问题集中在「文档/测试比证据多说了一寸」：一个数值门槛写错、两处把「未找到开关/未证实的容器查询」说成「已证/修不了」，以及 `viewportScale()` 无参数时会抛 TypeError 而不是 typed 拒绝。
- 冻结前提：修正 §4 的 P2-1 ~ P2-6；**不要**因为本次全量插件套件红而回滚本模块（红源是评审期间另一条车道改动 `src/client.js` / `src/remote/**` / `locale/**`，与本模块零交集，见 §1.3）。

| # | 级别 | 一句话 | 位置 |
| --- | --- | --- | --- |
| P2-1 | P2 | `viewportScale()` 传 `undefined`/`null` 整对象时抛 `TypeError`，与测试头「坏输入绝不抛异常」矛盾；页面当前总传对象，故不升级 | `apps/arkui-schedule/entry/src/main/ets/model/viewportScale.ts:194-197` |
| P2-2 | P2 | §7.7 写「面板 ≥ ~570vp 给出 1280」与模型实测不符：真实边界是 **628vp**（测试槽 52）/**632vp**（页面真实槽 56），570vp 仍是 fallback | `docs/MODULES.md:797` |
| P2-3 | P2 | 「1280 越过全部阈值（含 620）」把**容器查询的容器宽**当成**视口宽**来验证；数字比较成立，但「`@container` 不触发」未被证明 | `docs/MODULES.md:801`、`apps/arkui-schedule/tools/test/viewportScale.test.mjs:250-256` |
| P2-4 | P2 | 「零 force、无数据丢失」是两句合起来比两个夹具更强的承诺；G-D4 只覆盖一种 blocked-FF 且以 `E_LOCAL_PENDING` 收尾 | `docs/MODULES.md:790`、`.../test/sync-gate-ff.test.mjs:709-748` |
| P2-5 | P2 | 症状 2「宽度也修不了」比同段的「没找到开关」更强；源码证据只支持后者 | `docs/MODULES.md:802` |
| P2-6 | P2 | 注释写「0.1vp 容差」，实际常量 `COMPOSITION_TOLERANCE_VP = 0.11`（测试按 0.11 断言）；注释与常量漂移 | `.../model/viewportScale.ts:79,128` |

---

## 1 复核范围与证据

### 1.1 实际读过的文件

- Scope A：`packages/dsh-dots/src/sync/{syncGate,cycle,gitPort}.ts`（全文）、`test/{sync-gate-ff,plugin-v2-cycle}.test.mjs`（全文）、`dist/sync/{syncGate,cycle,gitPort}.js`（逐字节比对）；`src/rpc.ts` 未改，按「only if touched」不纳入改动面，仅只读核对 `markSynced()` 调用点（`:464,:576,:667`）。
- Scope B：`apps/arkui-schedule/entry/src/main/ets/model/{viewportScale,glyphRailLayout}.ts`（全文，后者只读）、`pages/RemoteControl.ets`（增量 + `applyArea` / `railLayout` / `viewportPlan` / `applyViewportScale` 上下文）、`tools/test/viewportScale.test.mjs`（全文）。
- 文档：`docs/MODULES.md` §7.6 / §7.7 与同批「路由偏差」记账段；参照 `docs/REVIEW-b11c-hardening.md` 的文风。

### 1.2 门禁复跑（全部 `Tee-Object` 到仓库根 `.tmp/`）

| # | 命令（工作目录） | 结果 / tail | 留存 |
| --- | --- | --- | --- |
| G1 | `node ../../node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`（`packages/dsh-dots`） | **exit 1**，唯一诊断 `src/remote/listener.ts(1957,18): error TS2741: Property 'liveConnections' is missing …` —— 并发车道文件，本模块零触及 | `.tmp/gates-rvp-tsc-plugin.out` |
| G2 | `node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json`（根） | exit 0，无诊断（文件内附 `EXIT=0`） | `.tmp/gates-rvp-tsc-app.out` |
| G3 | `node --test "packages/dsh-dots/test/*.test.mjs"`（根，按指派命令） | **tests 1065 / pass 1056 / fail 4 / skipped 5**，exit 1；失败源为 `locale/zh.json` 相对路径 + 并发 client/remote 漂移 | `.tmp/gates-rvp-test-plugin.out` |
| G3b | `node --test "test/*.test.mjs"`（`packages/dsh-dots`，正确 cwd） | **tests 1083 / pass 1077 / fail 4 / skipped 2**，exit 1；注册数与 §7.6 登记的 1083 一致，4 红全部来自 client/dist-client/locale 漂移（`client-render`、`client-remote-render`、`locale`、`remote-*`） | `.tmp/gates-rvp-test-plugin-pkg.out` |
| G4 | `node --test "apps/arkui-schedule/tools/test/*.test.mjs"`（根） | `tests 3395 / suites 481 / pass 3395 / fail 0 / skipped 0 / duration_ms 17239`，exit 0；与 §7.7 登记 **3395/3395** 完全一致 | `.tmp/gates-rvp-test-app.out` |
| G5 | `node --test test/sync-gate-ff.test.mjs test/plugin-v2-cycle.test.mjs`（`packages/dsh-dots`） | `tests 50 / pass 50 / fail 0 / skipped 0 / duration_ms 28896`，exit 0；含 D1 真仓库见证、D2 lastSyncAt、D3/D4 脏工作树、C04/C15、G-A…G-D 全部 | `.tmp/gates-rvp-targeted-ff.out` |
| G6 | 内存新鲜 emit 比对（TS `transpileModule`，ES2022/ESNext，`package.json` type=module；方法先用未改动的 `outbox.ts` 校准） | `DIST-FRESHNESS: tsFiles=78 match=78 mismatch=0 missing=0` | `.tmp/gates-rvp-distcheck.out` |
| G7 | viewport 退化/门槛探针（直接 import `tools/.build/model/viewportScale.js`，只读） | 13 组退化 + 7 组门槛；`noArg: THREW TypeError`；`THRESH 570/52=fallback`、`628/52=desktop`、`632/56=desktop` | `.tmp/gates-rvp-probe-viewport.out` |

- 未运行 `node scripts/build.mjs` / `build-harmony.ps1`；未对 `dist/` 写入任何字节。app 侧 `.build/` 由 G2 明确授权的 `tsc -p` 产出，属该命令的正常副作用。

### 1.3 起始/结束哈希、`git status`、dist 结论

- 分支/HEAD 起止相同：`main` / `2adfe6ab643b75f58ebaa97800f2f0571df99b6b`；评审中未执行任何 git 写命令。
- **起始 status（12 条）**：`M` = `RemoteControl.ets`、`docs/MODULES.md`、`dist/sync/{cycle,gitPort}.js`、`src/sync/{cycle,gitPort}.ts`、`test/plugin-v2-cycle.test.mjs`；`??` = `model/viewportScale.ts`、`tools/test/viewportScale.test.mjs`、`dist/sync/syncGate.js`、`src/sync/syncGate.ts`、`test/sync-gate-ff.test.mjs`。
- **结束 status（24 条）**：上述 12 条仍在，另出现并发车道 `src/client.js`、`src/{remote/listener,remote/service,remote/types}.ts`、`src/remote/connections.ts`、`dist/client.js`、`dist/remote/{listener,service,types,connections}.js`、`locale/{zh,en}.json`。**这些是评审期间由另一条车道写入的，不是本评审造成的**（起始 status 中不存在）。
- 六个指定文件的 SHA-256（起始 = 结束，逐字节未变）：

| 文件 | SHA-256 |
| --- | --- |
| `src/sync/syncGate.ts` | `BA9AF264770122556C93160BDA2F824A15F5E1E22CB3941C4788042A49FD6223` |
| `src/sync/cycle.ts` | `D80558313B3586FD0D3D6C0E76F6303EC8B670AE96044512CC379A6CEB6CCFEC` |
| `src/sync/gitPort.ts` | `C169A9AD6A05F8BD16BD3FC1B66E8834FA5638C3CF413CD99520AE5217C493B5` |
| `dist/sync/syncGate.js` | `6B272639469597771D789E4F6A379A7AE7FB7FD5D9D301984C70FB223FD86E56` |
| `dist/sync/cycle.js` | `1A6F6AAE8E6CAE5EAA08CDC2897FD72A2EC520EBC9BED09384F328EEDF299334` |
| `dist/sync/gitPort.js` | `843D47C174E8CD7A1BA0E9674C3D9EB1281AAA8A72A17A28CE408159575E227E` |

- **dist 结论**：三份目标 `dist` 与源码新鲜 emit 逐字节一致，且扩展到全包 78 个 `.ts` 仍是 78/78、0 mismatch（§7.6 登记的是 77 文件，当前因并发新增 `remote/connections.ts` 变 78，属树级漂移，非本模块问题）。评审期间六文件哈希未变，因此不存在「中途重建 dist」情形；并发车道只碰 `dist/client.js` 与 `dist/remote/**`。

---

## 2 攻击 (a)–(d) 逐条结论

### (a) FF 路径能否产生非快进或 force？— **no finding**

1. FF 的 argv 只有一个来源：`FAST_FORWARD_ARGS = ['merge','--ff-only','refs/remotes/origin/main']`（`src/sync/gitPort.ts:149-151`），`Object.freeze` + `buildFastForwardArgs()` 每次返回 `slice()`，调用方无法改动常量；`fastForward()` 无参数（`cycle.ts:277`、`gitPort.ts:555-557`），周期只调 `git.fastForward()`（`cycle.ts:1342`）一次。
2. `isFastForwardArgs()` 是**逐项全等 + 长度相等**（`gitPort.ts:164-167`）：多参、少参、换 ref 都不算快进；`assertSafeGitArgs()` 只在 `GIT_SUBCOMMANDS.has(sub) || isFastForwardArgs(args)` 时放行（`gitPort.ts:110-115`），`merge`/`pull` 仍不在白名单（`gitPort.ts:82-85`），因此不存在「把 merge 加进 allowlist」的通用门。
3. 禁止表新增 `--no-ff` / `--ff-only=` / 裸 `--ff` / `--squash` / `--no-commit` / `--hard`（`gitPort.ts:101-106`），原有 force / `+refspec` / `--delete` / `push.force=` 未删（`git diff` 逐行核对）。正向对照 `--ff-only`、`refs/remotes/origin/main` 不被误伤（`test/sync-gate-ff.test.mjs:200-203`）；hostile 表 22 条全部 `E_VALIDATION`（同文件 `:160-191`），真实端口三态探针再次确认 `merge` 只发一次且 argv 固定（`:219-279`）。
4. push 仍只有 `['push','--porcelain','origin','HEAD:main']`（`gitPort.ts:128-134`），`pushMain` 调用点固定 `PUSH_ARGS`（`cycle.ts:120,1504`），全仓 `src/sync/**` 无第二处 `merge`/`pull` 调用（grep：`cycle.ts` 仅注释与 `fastForward()`，`gitPort.ts` 仅构造器与 `fastForward()`）。`src/schedule/bridge.ts` 的 `pull --rebase` 是既存 v1 路径、本次未改，不属本模块。

### (b) dirty worktree 是否每条分支都无损？— **no finding**（在周期声明的 `days` 内）

FF 返回 `blocked-by-local-changes` 后 `ffBlocked=true`（`cycle.ts:1357-1365`），后续四条分支逐一枚举：

| 输入 | 走向 | 记录字节结局 | 是否误报成功 |
| --- | --- | --- | --- |
| 未提交的一条记录（在 scope 日内） | 完整性→union→落盘→提交（`cycle.ts:1378-1478`）→ `ffBlocked` 重读事实（`:1491-1502`） | union 把本地行并进写出文件，`addPaths`+`commit` 后落在 HEAD 树；G-D4 实测 `committedIds` 含 `local-same` | 否：behind>0，ours⇒有界恢复推拒⇒`E_LOCAL_PENDING`；非 ours⇒`E_NOT_SYNCED` |
| 新未跟踪的日文件（在 scope 日内） | 同上；G-D3 实测 `local-day2` 未跟踪文件被并进提交并推到远端 | 远端文件含 `local-day2` + 意图 `own-day2`（`:699-702`） | 否（同理） |
| 本地提交且全是 ours | 提交后 `readSyncFacts` ⇒ `decision='recover'`（`cycle.ts:1492-1495`） | 走既有 M3：先逐意图证明再 push，推拒只停放、不硬回退 | 否：`LOCAL_PENDING_MESSAGE`（`:1048`）明说未推成功 |
| 外来本地提交 | `ours=false` ⇒ `decision='refuse'`，`refuseMessageOf()` 返回**逐字不变的** `NOT_SYNCED_MESSAGE`（`cycle.ts:471-480`） | 本地原样、远端零写入、outbox 字节不变（G-D5 `:750-778`） | 否 |

- 关键 fail-closed 兜底：若 blocked 而本周期**没有任何可写路径**，提交块不执行，`:1521-1524` 用 `after.behind > 0` 返回 `FF_BLOCKED_PENDING_MESSAGE`，既不推送也不报成功；本地字节仍留在工作树（G-C6 `:435-447`）。
- 边界（记入 §7 而非 finding）：`days` **之外**的未跟踪文件不会进入 union/`addPaths`，本周期既不提交也不声称覆盖它；调用方枚举 scope 日时应把 outbox 中的日期一并纳入（既有契约，本次未改）。

### (c) 断言纪律：有无删除/放宽？— **no finding**

`git diff` 对两份测试文件只有 lane  disclosed 的两处编辑，逐条：

| 位置 | 变更 | 分类 |
| --- | --- | --- |
| `test/plugin-v2-cycle.test.mjs:21` | 新增 import `FACTS_INVALID_MESSAGE` | 新增（非断言，支撑下条） |
| `test/plugin-v2-cycle.test.mjs:186` | C04 标题由「HEAD != origin/main → …」改为「字符串事实与计数事实自相矛盾（HEAD≠origin 但 ahead=behind=0）→ …」 | 重命名（**等严**：被测条件更具体，旧断言 `code`/`writes`/`fetch 先于断言` 一条未删） |
| `test/plugin-v2-cycle.test.mjs:192` | 新增 `assert.equal(result.message, FACTS_INVALID_MESSAGE)` | **更严** |
| `test/plugin-v2-cycle.test.mjs:343` | C15 源码清单新增 `'../src/sync/syncGate.ts'` | **更严**（守卫覆盖面扩大，无删项） |
| `test/sync-gate-ff.test.mjs:1-799` | 全新文件 17 例（G-A1/A2、G-B1/B2/B3、G-C1…C6、G-D1…D6） | 新增；无 retarget、无旧断言可删 |

- 结论：**零删除、零放宽**；两条编辑分别是「+1 条更严消息断言」与「+1 个被守卫源文件」。新文件 `test/sync-gate-ff.test.mjs:709-748` 的标题写「数据零丢失」属措辞问题（P2-4），不是断言放宽。

### (d) dist 与 src 是否一致？— **no finding**

- 方法：TypeScript `transpileModule`，`target ES2022 / module ESNext / esModuleInterop`；先用未改动的 `src/sync/outbox.ts → dist/sync/outbox.js` 校准得到逐字节一致，再比三份目标文件和全包。
- 结果：三份目标 emit SHA 与 dist SHA 完全相同（`6B2726…`/`1A6F6A…`/`843D47…`），全包 78/78、0 mismatch（`.tmp/gates-rvp-distcheck.out`）。
- 起止哈希表（§1.3）证明六文件在评审期间没有被另一条车道重建；若存在中途重建，本结论会失效——不存在该情形。

---

## 3 攻击 (e)–(f) 逐条结论

### (e) viewportScale 是否对所有退化 fail-closed？— **1 条 P2（P2-1），其余 no finding**

探针直接调用编译后的模型（`.tmp/gates-rvp-probe-viewport.out`），逐项返回：

| 输入 | `{ok, scale, needsZoom}` | reason | 能否被缩成不可读/空白 |
| --- | --- | --- | --- |
| panel 0 / -1 / NaN / Infinity | `{false,1,false}` | `E_PANEL_INVALID` | 不能；页面只显示中文原因（`RemoteControl.ets:1108-1112`） |
| panel 非整数（800.5） | `{true,0.5848,true}` | `desktop` | 不能；vp 本就可以是小数，属合法输入 |
| panel < gutter（800/900）/ gutter > panel（500/800） | `{false,1,false}`、`css=-100/-300` | `E_PANEL_TOO_NARROW` | 不能缩放；`css` 为负仅存在于被拒计划中，页面不消费它 |
| gutter NaN / Infinity / 缺失 | `{false,1,false}` | `E_GUTTER_INVALID` | 不能 |
| target 0 / -1 / NaN / Infinity / 缺失 | `{false,1,false}` | `E_TARGET_INVALID` | 不能 |
| 字段缺失（panel/gutter/target 单独缺） | 分别 `E_PANEL_INVALID` / `E_GUTTER_INVALID` / `E_TARGET_INVALID` | — | 不能 |
| 阶梯底：panel 520（content 468） | `{true,0.457,true}` | `fallback`（1024） | 不能 |
| 阶梯底：panel 500（content 448） | `{false,1,false}` | `E_PANEL_TOO_NARROW` | 不能；中文原因含实测 448vp 与下限 0.45 |
| 组合 stale（`webBoxWidthVp=800` 而 content=748） | `{false,1,false}` | `E_COMPOSITION_INVALID` | 不能 |

- 五类 typed 拒绝（`E_PANEL_INVALID` / `E_GUTTER_INVALID` / `E_TARGET_INVALID` / `E_PANEL_TOO_NARROW` / `E_COMPOSITION_INVALID`）全部 `scale=1`、`needsZoom=false`、中文 message，与 §7.7 宣称一致；`MIN_ZOOM_FACTOR=0.01` 与 `MIN_LEGIBLE_SCALE=0.45` 是两级护栏（`viewportScale.ts:121-125,243-255`）。
- **P2-1**：`viewportScale(undefined)`（或 `null`）在 `viewportScale.ts:195` 直接读 `input.panelWidthVp` 抛 `TypeError`，与 `tools/test/viewportScale.test.mjs:169` 的「坏输入一律拒绝，且绝不抛异常」表述不符。页面目前总传对象字面量（`RemoteControl.ets:330-336`），因此不影响现网行为；建议入口加 `if (input === null || typeof input !== 'object') return refusal('E_PANEL_INVALID', 0, TARGET_VIEWPORT_CSS_PX, 0, '还没量到屏幕宽度，先不缩放页面')`。

### (f) rail 减法是否与 `railLayout()` 一致？— **no finding**

1. **单位**：`panelWidthVp` 来自 `onAreaChange → toVp(area.width)`（`RemoteControl.ets:260-267`），`railGutterVp = rail.gutter`、`webBoxWidthVp = rail.contentRect.width`（`:330-336`），`glyphRailLayout` 的 `gutter` 与 `contentRect` 同为 vp（`glyphRailLayout.ts:97,309`）；scale 是无量纲比，目标 1280/1024 是 CSS px，量纲链自洽。`dpr` 只进 `deviceWidthPx`，不进几何（`viewportScale.ts:208-210`、`RemoteControl.ets` 不传 dpr）。
2. **只扣一次**：模型只算一次 `contentWidthVp = round1(panel − railGutterVp)`（`viewportScale.ts:208`），页面不再自扣；交叉校验 `webBoxWidthVp` 与 `contentWidthVp` 差 > 0.11vp 即 `E_COMPOSITION_INVALID`（`:217-222`）。E2 的「双扣」反例被抓（`viewportScale.test.mjs:298-310`）。
3. **不能喂旧 rail**：`railLayout()` 每次调用都用当前 `this.viewportW/H` 新建 `GlyphRailInput`（`RemoteControl.ets:300-312`），`viewportPlan()` 每次先调它（`:328-329`），不存在缓存的 stale rect；`applyArea` 更新宽高后立即 `applyViewportScale()`（`:272-275`），`onPageEnd` 把 `appliedScale` 归零并重发（diff `:1060-1070`）。
4. **`.ets` 真正消费 scale**：`applyViewportScale()` 取 `plan.ok ? plan.scale : 1`，经 `this.controller.zoom(wanted)` 下发，拒绝时仍下发 1 以还原上一轮缩放（`RemoteControl.ets:381-397`）；`.zoomAccess(true)` 已在 Web 组件上打开（diff `:1060-1063`）。源码守卫 G1–G7 全绿（G4 本评审复跑 26/26 app 侧相关用例通过）。
5. 未验证边界：ArkWeb `zoom()` 是否真改变 `innerWidth` / `@media` / `@container` 读到的一致性，以及 SPA 站内跳转是否触发 `onPageEnd`——均属真机问题，§7.7 已列为 `unverified`，本评审不改口。

---

## 4 发现清单

| 级别 | 位置 | 证据 | 影响 | 建议 |
| --- | --- | --- | --- | --- |
| P2-1 | `apps/arkui-schedule/entry/src/main/ets/model/viewportScale.ts:194-197` | `.tmp/gates-rvp-probe-viewport.out`：`noArg: THREW TypeError Cannot read properties of undefined (reading 'panelWidthVp')` | 函数不是对任意输入的总函数；与测试头 `:169` 的「绝不抛异常」矛盾 | 入口加 null/非对象守卫，返回 `E_PANEL_INVALID` 的 `refusal` |
| P2-2 | `docs/MODULES.md:797` | 探针 `THRESH 570/52=fallback`、`628/52=desktop`、`632/56=desktop` | 文档给出的门槛比实际低 58/62vp，可能误导阈值回归判断 | 改成「含测试槽 52 时 ≥628vp（实际页面槽 56 时 ≥632vp）给出 1280」 |
| P2-3 | `docs/MODULES.md:801`、`apps/arkui-schedule/tools/test/viewportScale.test.mjs:250-256`（D1） | `TrajectoryTable.module.css:523` 是 `@container trajectory-table (max-width:620px)`，判据是容器宽而非视口宽；测试只断言 `1280 > 620` | 把「视口数大于 620」说成「容器查询不会触发」属于超出证据 | 把 D1 断言标注为「已越过媒体/JS 断点数字；`@container` 是否触发待真机截图」 |
| P2-4 | `docs/MODULES.md:790`、`test/sync-gate-ff.test.mjs:709`（标题）、`cycle.ts:1486-1489` | G-D4 只有一个 blocked-FF 夹具且终态为 `E_LOCAL_PENDING`；`cycle.ts:1521-1524` 对「无写入」另走 fail-closed | 「无数据丢失」读作全分支证明过强；「fold into `[v2]` commit」只在 `writtenPaths.length>0` 分支成立 | 文案改成「在已覆盖的两个脏工作区夹具中零丢弃；无写入分支按 `E_NOT_SYNCED` 明确拒绝」 |
| P2-5 | `docs/MODULES.md:802` | 同段已诚实写「没找到开关」，紧接「宽度也修不了」是更强的因果断言；`TrajectoryView.tsx:141-144` 的初始态由组件内部 state 决定 | 可能让用户误以为已证明「任何宽度都不可能修」 | 改成「本模块未找到宽度开关，因此本次缩放不会修好症状 2，应独立处理」 |
| P2-6 | `apps/arkui-schedule/entry/src/main/ets/model/viewportScale.ts:79,128` | 注释「0.1vp 容差」，常量 `0.11`，测试 `:312-324` 按 0.11 断言 | 注释与常量漂移，将来按注释改会红测试 | 注释改成 0.11vp（或把常量与测试一起改成 0.1） |

**非模块缺陷（并发车道漂移，记录但不计入上述计数）**：G1 的 `src/remote/listener.ts:1957` TS2741、G3/G3b 的 4 红，源头都是评审开始后出现的 `src/client.js` / `src/{remote/**}` / `locale/**` / `dist/client.js` / `dist/remote/**`（起始 status 无这些路径）。定向 FF 套件 50/50 绿、app 套件 3395/3395 绿，说明与本模块无关。冻结前须由对应车道补齐自己的 dist/locale/类型一致性，不能把他们的红算到本批两模块头上。

---

## 5 断言变更台账

| 文件:行 | 断言/守卫 | 分类 | 说明 |
| --- | --- | --- | --- |
| `packages/dsh-dots/test/plugin-v2-cycle.test.mjs:21` | 新增 `FACTS_INVALID_MESSAGE` import | 新增（支撑断言） | 无删除 |
| `packages/dsh-dots/test/plugin-v2-cycle.test.mjs:186` | C04 标题 retitle | 等严 | 条件由「HEAD≠origin」收窄成「字符串与计数事实自相矛盾」；旧三条断言（`code` / `writes` / `fetch` 顺序）逐字保留 |
| `packages/dsh-dots/test/plugin-v2-cycle.test.mjs:192` | `assert.equal(result.message, FACTS_INVALID_MESSAGE)` | **更严** | 新钉住 fail-closed 文案，原来只钉 code |
| `packages/dsh-dots/test/plugin-v2-cycle.test.mjs:343` | `syncGate.ts` 加入 C15 源码清单 | **更严** | 守卫多覆盖一个文件，原有四项与 dist 扫描不删 |
| `packages/dsh-dots/test/sync-gate-ff.test.mjs:93-799` | 17 条新用例（G-A…G-D） | 新增 | 全新文件，无 retarget；含真仓库 witness 与脏工作树两例 |
| `apps/arkui-schedule/tools/test/viewportScale.test.mjs`（全文） | 26 条 | 未改 | 与 HEAD 一致，零 retarget、零放宽 |

**总账**：既有断言删除数 = 0；放宽数 = 0；更严数 = 2；retarget 数 = 1（仅标题，非断言强度）；新增用例 17（plugin）+ 26（app，新文件整体）。

---

## 6 诚实性清单

| 句子 / 声明 | 证据是否支持 | 裁定 |
| --- | --- | --- |
| 「旧门禁 `head === origin` 严格相等 ⇒ 只落后永远 E_NOT_SYNCED」 | `git diff`：`gateOfFacts` 旧体确有 `if (head !== origin)`；`pendingIsOurs` 旧体确有 `ab.behind !== 0` 返回 false | 支持 |
| 「纯判定 + 退化一律 refuse」 | G-A1/A2 矩阵与 16 组退化实测全绿 | 支持 |
| 「FF 只一次、固定 argv、merge 不在 allowlist、零 force」 | 逐一读码 + hostile 表 + 真仓库 argv 捕获（`A.dangerousArgv() === []`） | 支持 |
| 「脏工作区不丢数据」 | 两个夹具实测记录字节进提交树/工作树；但措辞强于夹具覆盖范围 | **部分支持 → P2-4** |
| 「零 force、无数据丢失」 | 未见任何 force argv；「无数据丢失」只由两个夹具支撑 | **部分支持 → P2-4** |
| 「分叉那句话逐字不变」 | `git diff`：`NOT_SYNCED_MESSAGE` 字符串未改；G-C4/G-D5 钉住 | 支持 |
| `lastSyncAt` 缺口：「v2 路径从不调用 `markSynced()`，仍为 null」 | `rpc.ts:464,576,667` 两处调用均在 v1 push/apply；G-D2 实测两次 `readLastSyncAt()===null` | 支持（措辞准确，未假装已修） |
| 「1280 越过全部阈值（760/767/620/768/1024）」 | 数字比较成立；620 是容器查询，容器宽 ≠ 视口宽 | **过度 ⇒ P2-3** |
| 「1280 已越过 DSH 全部宽度阈值」/「≥ ~570vp 给出 1280」 | 实测 570 仍是 fallback，1280 档自 628/632vp 起 | **与事实不符 ⇒ P2-2** |
| 「症状 2 宽度也修不了」 | 同段证据只证明「未找到宽度开关、两端初始展开」 | **过度 ⇒ P2-5** |
| 「0.1vp 容差」 | 常量是 0.11 | **漂移 ⇒ P2-6** |
| 测试头「坏输入一律拒绝，且绝不抛异常」 | 字段级坏值成立；整对象缺失抛 TypeError | **过度 ⇒ P2-1** |
| 文档「dist 77 文件 0 mismatch」 | 本评审实测 78/78（并发车道新增 1 个 `.ts`） | 起跑时数字成立，当前树已变；属树级漂移，非本模块撒谎 |

---

## 7 `unverified` 边界

1. **真机/设备**：FF 在真实 Gitee/HTTPS 上的 fetch+push 行为、平板保存不再弹中文错误、ArkWeb `zoom()` 是否真改变 `innerWidth`/`@media`/`@container`、SPA 站内跳转后缩放是否重贴、缩放下触控命中——全部未验证，§7.6/§7.7 已列，本评审不升级。
2. **症状 2**：未找到宽度开关 ≠ 宽度一定修不了；需真机截图/组件状态复核（P2-5）。
3. **`@container` 620px**：视口 1280 时表格容器实际宽度未被测量（P2-3）。
4. **`days` 之外的未跟踪文件**：blocked-FF 周期不会提交它们，也不声明覆盖；调用方 `days` 枚举是否总含 outbox 日期，本评审未追到调度层。
5. **全量插件套件**：因并发车道漂移，本次无法复现登记的 1083/1081/0/2；可复现的是定向 50/50 与 app 3395/3395。冻结前应由对应车道修完自己的 client/remote/locale 一致性后再跑全量。
6. **`tsc --noEmit`（plugin）**：受同一并发漂移影响而红；本模块三份 `src/sync/**` 自身的类型一致性只由「新鲜 emit 78/78」与定向测试间接证明，未取得全绿 tsc 证据。
7. **dist 文件数**：登记 77、实测 78（并发新增），未对并发车道文件做归属审计。

---

## 8 冻结建议

- **裁决：Freeze-with-fixes。** 两条模块可进入提交队列；冻结前请 Lead 要求原车道做四处最小修补：① 给 `viewportScale()` 加 null/非对象守卫（P2-1）；② 把 §7.7 的「~570vp」改为 628/632vp（P2-2）；③ 把 620 容器查询与症状 2 两句改成「未证实/本模块未修」口径（P2-3、P2-5）；④ 把「无数据丢失」限定到两个夹具、注释容差 0.11（P2-4、P2-6）。
- **不得**把另一条车道的 `client.js`/`remote/**`/`locale/**` 漂移或由其引起的全量套件红算作本批缺陷；但**冻结批次本身**应等那条车道自愈后再取一次全量绿证据，否则批次证据仍不完整。
- 提交时仍按 §7.6/§7.7 的回滚路径；本评审未修改任何源、测试、dist 或 git 状态，唯一写入是本文件。

---

### 追加注（2026-11-27，Designer）：Scope B 已被用户撤回

用户当天撤回了前提（原话译文：「我先前搞错了，平板上的远程控制页没有问题——我看到的是因为我在 DSH 页面里从对话页切到了轨迹页。」）。因此：

- **mod-app-remote-desktop-viewport 未提交、未打 tag**，工作树已回退：`RemoteControl.ets` 按 HEAD 逐字节还原，`model/viewportScale.ts` 与 `tools/test/viewportScale.test.mjs` 已删除；
- 本文 **P2-1 / P2-2 / P2-3 / P2-6 均已失效**（它们指向的文件已不存在）——保留原文仅为记录当时的评审，不作为待修项；
- **P2-5** 已被采纳：`docs/MODULES.md` §7.7 的措辞已收敛为「源码证据只支持没找到开关」，不再断言"宽度修不了"；
- **P2-4 仍然有效**，属于 Scope A（FF 模块）：`docs/MODULES.md` §7.6 的「零 force、无数据丢失」已按本文 §2(b) 的覆盖范围改写，注明 G-D4 只覆盖一种 blocked-FF 形状。

Scope A 的门禁结论不受影响：G5 定向 50/50 绿、G6 内存新鲜 emit 78/78 一致；G3/G3b 的 4 红来自并发车道（`src/remote/**`、`src/client.js`、`locale`），与 FF 模块零交集。
