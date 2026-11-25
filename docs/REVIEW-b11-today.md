# 独立只读评审（第四次）— 今日七条插件提交（askpass ×4 / LAN / autostart / accepting）

- 评审对象：`main` @ `e4f7873`（树干净），本日七条提交 = `77cd7a8` `f6386f2` `ffe708d` `283a128` `21b2a34` `473bf13` `0a0d6fe`（+ Lead 的登记提交 `e4f7873` 与本批相关的前置文档提交 `d945460`/`1af1041`）
- 评审方式：只读。自跑门禁（全部 `Tee-Object` 留存）+ 自写**内存内**探针（`node --input-type=module` 走 stdin，不在仓库新增任何文件；夹具只落在 gitignored 的 `.tmp/` 下）
- 立场：**攻击**这七条修法，不是复述它们；重点打「claim 与证据的缝隙」「守卫证明的对象 ≠ 它声称证明的对象」「安全边界靠环境还是靠设计」
- 禁止项遵守：**未运行 `node scripts/build.mjs`**（会重写 `dist/`）、未改任何源码/测试/dist/文档（只新增本文件）、无 git 写命令、无 `hdc`、无外网、未打印任何令牌/cookie

---

## 0 结论

- **P0 = 0，P1 = 1，P2 = 12**。裁决：**可以冻结（freeze-with-fixes）**——七条主承诺全部成立且有见证，但有一条**复现出来的监听泄漏**建议同批 3 行修掉，另有两条「数字/措辞超出证据」建议顺手订正。
- 一句话裁决：**修的都是真 bug，而且这次大部分见证是硬的**（真 cmd 形状、真渲染器、真归一化往返、绑定/广播同源）；剩下的问题集中在四处：① `dispose()` 与**在飞的 `start()`** 之间没有任何守卫，我把它跑出来了（监听泄漏 + `accepting` 在 dispose 之后仍为 true）；② 计数台账在两条提交里报了**同一个总数**（1029），与各自声明的 +14 / +10 算术上不相容；③ 生成器源码注释把「奇偶规则」写成**实测**，而提交信息明确**不主张**它；④ LAN 的「落盘值 == 自动镜像 ⇒ 按自动值」启发式在**网卡集合变化后**会把旧地址升格成可信覆盖，`autoStart` 于是自动把它绑回去。

| # | 严重度 | 一句话 | 位置 |
| --- | --- | --- | --- |
| P1-1 | **P1** | `dispose()` 不设 `disposed` 位、`start()` 也不在 await 之后复检：卸载时正在飞的启动会把句柄装上，**监听泄漏 + `accepting` 在 dispose 之后变 true + 无人能关**（我已复现） | `src/remote/service.ts:1394-1398`、`:1216`、`:1140-1144` |
| P2-1 | P2 | 运维**显式**选的地址在重启后被降级为自动值，而原因行写「（与自动挑选结果相同）」，实际广播的是**另一个**地址：披露句自相矛盾 | `src/remote/service.ts:491-493`、`:514-516`、`:570-572` |
| P2-2 | P2 | `mod-plugin-askpass-temp-hygiene` 与 `mod-plugin-askpass-error-surface` 报**同一个**插件总数 1029，而各自声明 +14 / +10；1005+14=1019、1029+10=1039，都对不上 1037 | `docs/MODULES.md:720`、`:721` |
| P2-3 | P2 | `error-surface` 的门槛数字没有自己的捕获（`MODULES.md:721` 写「插件套件同上」），违反规则 10「没有留存日志的运行不构成证据」 | `docs/MODULES.md:721`、提交 `21b2a34` 正文 |
| P2-4 | P2 | 生成器源码注释把「奇数非 ASCII 字节数才发作」写成**实测**，而 `f6386f2` 正文明确「复现不出来、不主张它是机制」 | `src/engine/git.ts:453-454` |
| P2-5 | P2 | `askpass.mjs` 的 `sameParent` 子句在「父进程稳定」形状下把第 2 次及以后的无提示问询答成 **token**——正是本模块要消灭的形态；该子句在生产形状里是死代码 | `src/engine/git.ts:532-536`、`:547` |
| P2-6 | P2 | 先判 `/sername/` 再判 `/assword/`：**口令问句文本里含 `sername`**（如主机名 `username.example.com`）时，用户名被当口令答出 | `src/engine/git.ts:516-517` |
| P2-7 | P2 | 「`enabled` 跟随监听句柄」在 `saveSettings` 换端口的路径上不成立：监听被停、磁盘仍写 `true`；L-12 只覆盖 start/stop/dispose 三条 | `src/remote/service.ts:1300`、`test/lanSelection.test.mjs` L-12 |
| P2-8 | P2 | `accepting` 只是「我们起过且没停过」：监听侧没有任何失败回归通道（服务端 `error` 只记日志），端口真死了仍说「正在接受连接」 | `src/remote/listener.ts:1929-1931`、`src/remote/service.ts:998-1006` |
| P2-9 | P2 | 面板的 `accepting` 与 `running` 来自**两次不同 RPC**，且启动失败分支只重置 `running` ⇒ 屏上可同时出现「未启动」与「正在接受连接（addr）」 | `src/client.js:1374-1381`、`:1386`、`:1391` |
| P2-10 | P2 | 跨模块重曝：落盘值 ≠ **冻结**启发式输出时立刻升格为可信覆盖；一旦网卡集合变化使冻结启发式换答案，`autoStart` 会把 `192.168.137.1` 自动绑回去 | `src/remote/service.ts:570-572`、`:589-607` |
| P2-11 | P2 | 作为证据被引用的 witness 捕获把**真实 Gitee 登录名**明文打了进去（规则 11：报告只报形态） | `.tmp/gates-designer-ap-witness.out` |
| P2-12 | P2 | lane 的 `gates-acc-suite-1.out` 现在不是 0 字节（770 行 / 97,380 B），但**没有 `ℹ tests` 汇总脚**；「0 字节」这一描述在今天的树上不可复现（处置不变） | `packages/dsh-dots/.tmp/gates-acc-suite-1.out` |

我复核了七条修法本身，**全部实质成立**（细节见 §2–§7）：

1. Windows askpass 现在经真 `cmd` 把提示文本交给 node（`%*`），用户名/口令按提示判；空提示的兜底按调用配对（usr/tok/usr）。
2. 生成物是纯 7-bit ASCII，且**不含令牌**；生产形状（`windowsHide` + piped stdio）两次问询 stderr 为空。
3. LAN 选路真的以默认路由地址为第一优先，绑定与广播同源（`handle.address`），无候选时 typed 拒绝、绝不回落 `0.0.0.0`。
4. 启动清扫只认前缀、跳链接、按 mtime 门限、失败静默计数；`NODE_TEST_CONTEXT` 下确实跳过。
5. `E_ASKPASS_NODE_MISSING` 已进 banner 表（24 条 = 3 映射 + 21 条带中文理由豁免，我逐条数过），`E_REPO_ROOT_UNAVAILABLE` 文案补齐。
6. 意图位 `autoStart` 与活状态 `enabled` 确实分家；三次并发 `autoStart()` 只起一个监听（结构性，不是时序运气）。
7. 「停机状态被整文件重写会丢意图」**确实被关闭**（`normalizeRemoteSettings` 从原始记录读 `autoStart`，`persistEndpoint` 的两次归一都带着它，ACC-5 钉住）——这条偏离是**对的**。

---

## 1 复核范围与证据

### 1.1 七条提交与实际 diff

| 提交 | 主题 | 触及文件（与本评审相关） |
| --- | --- | --- |
| `77cd7a8` | askpass-cmd-shape（`%*` + 按调用重置计数 + 注释去元字符） | `src/engine/git.ts`(+95/−?)、`src/engine/nodePath.ts`(+75)、2 `dist/`、`test/askpass-cmd-shape.test.mjs`(+232 新)、`test/askpass-node-resolution.test.mjs`(+52) |
| `f6386f2` | askpass-stderr-residual（生成物 7-bit ASCII） | `src/engine/git.ts`(+23)、`dist/engine/git.js`、`test/askpass-cmd-shape.test.mjs`(+63) |
| `ffe708d` | lan-address-selection（默认路由选路 + 绑定/广播同源） | `src/remote/service.ts`(+650)、`src/client.js`(+30)、2 `dist/`、`test/lanSelection.test.mjs`(+436 新) |
| `283a128` | askpass-temp-hygiene（启动清扫超龄目录） | `src/engine/askpassTemp.ts`(新)、`src/index.ts`、2 `dist/`、`test/askpass-temp-hygiene.test.mjs`(+272 新) |
| `21b2a34` | askpass-error-surface（banner 码 + 表驱动守卫） | `src/remote/repoVisibility.ts`(+161)、`src/rpc.ts`(+52)、2 `dist/`、`test/error-surface.test.mjs`(+362 新) |
| `473bf13` | remote-autostart（意图位 `autoStart` vs 活状态 `enabled`） | `src/remote/{types,service}.ts`、`src/index.ts`、`src/client.js`、`locale/{zh,en}.json`、`test/{remote-autostart,locale}.test.mjs`、3 `dist/` |
| `0a0d6fe` | remote-accepting-surface（`accepting` 活真相 + 归一化保真） | `src/remote/{accessMode,types,service}.ts`、`src/client.js`、两份 locale、`test/{remote-accepting,locale}.test.mjs`、4 `dist/` |

七条合计测试侧 **+2308 / −3**（`git diff --stat 77cd7a8^ e4f7873 -- packages/dsh-dots/test`），唯一的 −1 条 `assert` 是 locale 普查的计数（见 §9）。

### 1.2 门禁复跑（本评审自跑，`Tee-Object` 全部留存）

| # | 命令（工作目录） | 结果（tail 逐字） | 留存 |
| --- | --- | --- | --- |
| G1 | `node ../../node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`（`packages/dsh-dots`） | `TSC_EXIT=0`（无诊断输出） | `packages/dsh-dots/.tmp/gates-rv4-tsc.out` |
| G2 | `node .tmp\distcheck-j3.mjs`（`packages/dsh-dots`） | `DIST-FRESHNESS: 76 files, 0 mismatch` / `DIST-WINDOW: 0 dist/*.js differ from HEAD` / `DISTCHECK_EXIT=0` | `packages/dsh-dots/.tmp/gates-rv4-distcheck.out` |
| G3 | `node --test test/*.test.mjs`（`packages/dsh-dots`） | `ℹ tests 1045` / `ℹ pass 1043` / `ℹ fail 0` / `ℹ cancelled 0` / `ℹ skipped 2` / `ℹ duration_ms 54743.9933` / `PLUGIN_EXIT=0` | `packages/dsh-dots/.tmp/gates-rv4-plugin.out` |
| G4 | `node --test "apps/arkui-schedule/tools/test/*.test.mjs"`（仓库根） | `ℹ tests 3234` / `ℹ suites 461` / `ℹ pass 3234` / `ℹ fail 0` / `ℹ skipped 0` / `ℹ duration_ms 14347.7241` / `APP_EXIT=0` | `.tmp/gates-rv4-app.out` |

- **G2 的含义**：提交里的 `dist/` 与一次**全新 tsc** 的输出逐字节一致（76 文件 0 mismatch），且与 `HEAD` 无差（窗口 0）。这独立佐证了各模块「dist 与新鲜 tsc 一致」那一半。
- **本评审不能证明的那一半**：`node scripts/build.mjs` 被我**禁止运行**（会重写 `dist/`），因此各模块「build exit 0」这一半本评审**未复核**，只能按「未捕获」记录（不是否定）。
- G3 的 1045/1043/0/2 与 Lead 的 `.tmp/gates-lead-accepting-full.out` **完全一致**（我读该文件 tail：`tests 1045 / pass 1043 / fail 0 / skipped 2`），即 Lead 那次判定可独立复现。
- G4 的 3234/3234/0/0 与各提交正文里的 App 数字一致；本批**未改 `apps/**`**（`git diff --stat 77cd7a8^ e4f7873 -- apps` 为空）。
- 两条 skip 与上一轮同源（POSIX 0600 权限 + 本机系统代理下的 fetch 直连），**不是**本批引入。

### 1.3 我自写的攻击探针（全部走 stdin，不在仓库新增文件）

| 探针 | 覆盖 | 结果 |
| --- | --- | --- |
| `node --input-type=module`（askpass 提示判定） | 生成物 → 真 `node` 执行、9 种提示文本、`--` 无提示、令牌回显检查 | 9 行判定见 §2；`cmd` 纯 ASCII ✓、生成物不含令牌 ✓ |
| 同上（生产 cmd 形状） | `cmd.exe /c askpass.cmd`（`windowsHide`）空提示 ×3 + 两条真提示 | `USR / TOK / USR`、`USR / TOK`（见 §2） |
| 同上（清扫语义） | mtime 是否随「使用中写入」刷新、1h 门限相对什么、前缀/失败/缺失目录 | 见 §2 第四段 |
| 同上（LAN 选路） | 注入网卡表 + 冻结启发式，四种组合 | 见 §3 |
| 同上（autostart/accepting） | 真 `createRemoteService` + 注入监听工厂 + 假 DSH 桩（仅 127.0.0.1） | 见 §4、§5 |

夹具目录（gitignored，`.gitignore:30`）：`packages/dsh-dots/.tmp/rv4-askpass-*`、`rv4-cmd-*`、`rv4-sweep-*`、`rv4-home-*`、`rv4-home2-*`。**没有**触碰真实 `%TEMP%`、真实 `remote.json`、真实监听端口。

### 1.4 树干净证明

- 评审开始：`git status --porcelain` → 空；`git rev-parse HEAD` = `e4f78736abc337093ee8a30be52b1349f2ff129d`。
- 评审结束（写完本文件前）：`git status --porcelain` → 空；`git check-ignore -v` 确认 `.tmp/` 被忽略（`.gitignore:30`）。
- 唯一新增的仓库文件 = 本文件 `docs/REVIEW-b11-today.md`；未执行 `git add/commit/checkout/stash/revert`，未向 `src/` `test/` `dist/` `locale/` 写任何字节。

### 1.5 关于「lane 的 0 字节 capture」

- `0a0d6fe` 正文记录：lane 的 `gates-acc-suite-1.out` 自 `00:26:55` 起「稳定为 0 字节且文件可读」，故那次套件没有产出结果，Lead 自行跑全量并以其为准。**这个处置正确，我不把它当证据。**
- 我今天看到的状态：`packages/dsh-dots/.tmp/gates-acc-suite-1.out` = **770 行 / 97,380 B**，mtime `2026-11-26 00:27:10`；**通篇没有 `ℹ tests / pass / fail` 汇总脚**（`Select-String 'ℹ tests'` 命中 0 次），末尾停在若干 `✔ 联调：…`。也就是说：它现在不是 0 字节，但**仍然不是证据**（无汇总脚 = 没有结论行）。同时「0 字节」这一描述在今天的树上**已不可复现**（大小与 mtime 都不支持）。两件事都记在案，处置不变。
- 与之对照：lane 的 ACC 定向捕获 `gates-acc-newtest.out` 是完整的（`tests 8 / pass 8 / fail 0`，ACC-1…ACC-8 逐条点名），`gates-auto-m1-5/6-tests-run*.out` 也确为 `138936` / `139000` B（与 `473bf13` 正文逐字一致）。

---

## 2 askpass 攻击结果

### 2.1 提示文本判定（真 `node` 跑生成物）

| # | 提示文本 | 期望 | 实测 | 判定 |
| --- | --- | --- | --- | --- |
| 1a | `Username for 'https://gitee.com': ` | 用户名 | 用户名 | ✅ |
| 1b | `Password for 'https://<user>@gitee.com': ` | 令牌 | 令牌 | ✅ |
| 2a | 主机名含 `assword`，**用户名**问句 | 用户名 | 用户名 | ✅（先判 `sername` 救了它） |
| 2b | 主机名含 `assword`，**口令**问句 | 令牌 | 令牌 | ✅ |
| 2c | 主机名含 `username`，**口令**问句 | 令牌 | **用户名** | ❌ **P2-6** |
| 2d | 主机名同时含两者，用户名问句 | 用户名 | 用户名 | ✅ |
| 2e | 主机名同时含两者，口令问句 | 令牌 | **用户名** | ❌ 同 P2-6 |
| 3a | 中文（本地化）用户名问句 | 用户名 | 用户名（走兜底第 1 次，凑巧对） | ⚠️ 靠兜底 |
| 3b | 空提示 | — | 令牌（继承上一次计数） | ⚠️ 见 2.3 |

**「令牌还能不能被当成用户名答出去？」** 在**提示可判**的路径上**不能**（判序正确，2a/2b/2d 实测通过）；在**提示不可判**的路径上，只有继承到 `count ≥ 1` 才会答 token，而生产形状下有两道锁：① 每次 git 子进程前 `resetAskpassCounter()` 删计数文件（`src/engine/git.ts:800-806`、`buildEnv` `:815-816`）；② 每次 askpass 都是**新的 `cmd.exe`**（提交里实测的 ppid 证据），于是 `sameParent` 分支为假。**结论：生产形状下我没有找到可达的「token 当用户名」路径**，但下面 2c/2d 与 2.3 是两条同族的残留。

### 2.2 空 `%*`：一次命令问两次，配对还对吗

真 `cmd` 形状、不带参数连跑三次：`USR → TOK → USR`（第三次从用户名重新开始）。这与 `f6386f2` 引用的 witness（`.tmp/gates-designer-ap-witness.out` 第 3/4/5 行）逐字一致，**一次命令问两次的配对仍然正确**。

### 2.3 `sameParent` 子句：生产里是死代码，换个形状就复活原缺陷

同一个计数文件、**父进程稳定**（我在一个 node 进程里连续 spawn 生成物，ppid 不变）时：第 1 次空提示 → 用户名，第 2 次 → **token**，第 3 次 → **token**。原因是 `src/engine/git.ts:532-536` 的 `if (sameParent || (fresh && pending)) count = state.count` —— `sameParent` 为真时**绕过**了「上次已问满两项就该重来」这条安全门。`pending` 那道门只在 `sameParent` 为假时才生效。

- 生产形状（每次新 `cmd.exe`）里 `sameParent` 恒假 ⇒ 该子句是**死代码**；
- 但它一旦为真（换个调用器、`git credential fill` 在同一 shell 里、或将来有人把 `GIT_ASKPASS` 指到 `.mjs`），就**精确复现**本模块要消灭的那个答案（用户名问句拿到 token）。
- 现有测试只钉 `askpass.mjs` 自身的判定与真 `cmd` 形状，**没有一条**覆盖「同父 + 已问满 + 第 3 次」这一支（`askpass-cmd-shape.test.mjs` 的 T4/T5 各自换/不换父进程，但用的都是「两次」）。判 P2。

### 2.4 1 小时清扫：能不能删掉「正在用」的目录

| 攻击 | 构造 | 实测 | 判定 |
| --- | --- | --- | --- |
| `mkdtemp` 复用 | 名称是否可能重复 | `mkdtemp` 每次唯一，前缀 `dsh-gcs-askpass-` 由 `mkdtemp` 保证后缀唯一 | ✅ 无复用 |
| 使用中目录的 mtime | 连续改写目录里的 `askpass.count` 三次 | **目录 mtime 会跟着变**（NTFS 实测 `before !== after`），新增条目也会变 | ✅ 「年龄」实际是「最后一次写入之后」 |
| 1h 门限相对什么 | 注入 `now = mtime + 1h + 1s` | `wouldRemove: 1`（即使目录刚被使用过） | ⚠️ 只有「最后一次 askpass 写入」之后 1 小时才会被删 |
| 前缀/链接/失败 | 非前缀、普通文件、`rm` 抛 `EBUSY`、`%TEMP%` 不存在 | 只认前缀（`scanned` 只数前缀命中）、`rm` 失败静默 `failed +1`、缺失目录全 0 | ✅ |
| `NODE_TEST_CONTEXT` | 套件里跑一次 | A12 断言 `skip`，真实清扫在测试中**从不执行** | ✅（同时也是「结构上未验证」的来源） |

**结论**：在 NTFS 上「活着的 git 子进程目录不会落进删除窗口」基本成立——因为它每次问询都会刷新目录 mtime。**但这条安全性依赖文件系统行为**：在不因「内容写入」更新父目录 mtime 的文件系统（部分网络盘 / POSIX 默认）上，目录年龄恒等于创建时间，一个存活超过 1 小时、之后还会再问一次凭据的 git 子进程就会被抽掉 shim。恰好 `clone` 到今天**没有预算**（`docs/REVIEW-b11c-hardening.md` P2-6 仍未修），1 小时以上的 git 子进程在 `clone` 上是可想象的。判 P2（对我最初设想的「一定删得到」是**否**：NTFS 上删不到）。

### 2.5 与 autostart / 计数重置的交互（§7(a) 预答）

清扫在 `src/index.ts:200-208` 的 effect 里 fire-and-forget，`autoStart` 在 `:228-234` 的 effect 里 fire-and-forget，两者都是激活期异步，但**没有共享对象**：清扫只看 `%TEMP%` 里超龄的目录，而本进程新建的目录 mtime 是「刚刚」，永远进不了窗口；计数重置只 `rm` 自己目录内的 `askpass.count`。**无交互，未发现时序窗口。**

---

## 3 LAN 选择攻击结果

### 3.1 合法显式选择被启发式降级（P2-1）

注入：`以太网=192.168.1.10`（枚举在前、非默认路由）、`WLAN=192.168.1.5`（默认路由）。冻结启发式 `provisionedMirrorLanAddress()` 返回 `192.168.1.10`。

| # | 场景 | 实际广播 | 原因行 |
| --- | --- | --- | --- |
| 1 | 本进程内 `saveSettings({lanAddress:'192.168.1.10'})`（`explicitSave=true`） | **192.168.1.10**（override 胜出） | `广播 192.168.1.10（你手填的局域网地址；本机默认路由是 192.168.1.5，平板多半连不上它，清空「局域网地址」就会自动改用路由地址）` |
| 2 | **重启之后**（同值、无 `explicitSave`） | **192.168.1.5**（route 胜出） | `广播 192.168.1.5（本机默认路由所在地址；已忽略落盘的 192.168.1.10（与自动挑选结果相同，按自动值处理））` |
| 3 | 显式值 ≠ 冻结启发式输出（`192.168.1.99`） | 192.168.1.99（override 胜出） | — |
| 4 | 本机真实网卡表的冻结启发式输出 | `192.168.137.1` | — |

- **能不能「静默」覆盖？** 不能：`广播 192.168.1.5` 就写在原因行开头，面板把它渲染成 `urls[].note`（L-14 钉住），运维能看见地址变了。
- **但括号里那句是错的**：`与自动挑选结果相同` 里的「自动挑选结果」指的是**冻结的旧启发式**（192.168.1.10），而这一行同时宣布**广播的是 192.168.1.5**——按现行规则，「自动挑选结果」就是 192.168.1.5。同一行里两个「自动」互相矛盾，读者会以为「反正一样」而放过。判 P2（措辞超出证据，且方向是「让运维误以为无差别」）。
- **可修**：把括号改成「（与 provisioning 旧启发式的输出相同，无法证明是你手填的；当前按默认路由处理）」即可，不需要改判据。
- 附：`explicitLanSave` 只活在本进程，**重启后必然回到场景 2**——这是「落盘无来源标记」的必然代价，已被批准，不算新缺陷；但 `MODULES.md:718` 的「任何**进程内**显式保存的值永远胜出」也正好承认了它只到进程边界。

### 3.2 路由地址在 probe 与 bind 之间消失

代码路径（读码，未实跑）：`start()` 用 `routeAddressForResolution()`（5 s 缓存，`service.ts:295`）拿到地址 → `resolveBindAddress` 直接用它 → `startListener` 抛错 → `start()` 的 `catch` 把它折成 `{code:'E_LISTEN_FAILED', message:'监听启动失败：…'}`。

- **不会**静默换地址、**不会**回落 `0.0.0.0`；有 typed 错误可见。
- 但**没有任何重试或重探**：5 s 缓存足以让运维紧接着的第二次点击仍然拿到同一个已消失的地址，于是连续两次失败。属可接受的取舍，不判红；**建议**在 `E_LISTEN_FAILED` 之后把 `routeCache` 置空（一行），让下一次点击重新探测。

### 3.3 `dispose()` 还写 `enabled` 吗

不写。`dispose()` → `stopInternal(false)`（`service.ts:1394-1398`），`persistEnabled=false` 时 `commitEnabledFlag()` 不执行。L-12 的第三段（`start → dispose → enabled 仍 true`）在套件里通过。✅

### 3.4 绑定 == 广播，每条路径都成立吗

| 路径 | 广播地址来源 | 结论 |
| --- | --- | --- |
| 成功 start / status / showLink | `handle.address`（`service.ts:977-979`、`:1018-1020`、`:1376-1380`） | ✅ 同源 |
| 假监听回报 `192.168.1.77` 而解析是 `192.168.1.5` | 三处都说 192.168.1.77（L-09） | ✅ |
| 绑定失败 | 无句柄 ⇒ `running:false` + `E_LISTEN_FAILED`；但 `status().urls[]` 仍用**选出来的**地址拼一条 URL | ⚠️ 该 URL 不是「正在接」的地址；面板在 `stopped` 时不渲染二维码/复制入口（`client.js:1503-1504`），所以不构成可操作的谎报 |
| 换端口/换方式（`saveSettings`） | 先 `stopInternal(false)`，句柄置空 | ✅ 不再有「状态说 A、实际听 B」 |
| **在飞的 start + dispose** | 见 §4.2 | ❌ 句柄被装上而无人拥有 |

---

## 4 autostart 攻击结果

### 4.1 两次（三次）激活竞态：结构性还是时序

三次并发 `autoStart()` 指向同一服务：**监听工厂只被调用 1 次**，最终 `accepting=true`、`startedBy='auto'`。原因是 `start()` 在第一个 `await` **之前**就同步置 `starting = true`（`service.ts:1140-1144`），第二个调用直接 `return status()`。**结构性成立，不是时序运气。** ✅
（副作用：第 2/3 个调用方拿到的 status 是 `running:false`——「正在起」被报成「没在跑」。目前只有激活路径调用它，不判红。）

### 4.2 `start()` 在飞时 `dispose()`（P1-1，已复现）

**构造**：真 `createRemoteService` + 注入监听工厂（`start()` 在 `await` 处挂住）→ 调用 `svc.start('manual')` 不等待 → 120 ms 后 `await svc.dispose()` → 放行监听工厂。**实测输出**：

```
[A] listener called: 1 | accepting before dispose: false
[A] after dispose -> accepting: false | close count: 0
[A] start resolved AFTER dispose -> running: true accepting: true close count: 0 lastError: null
[A] disk enabled: true autoStart: true
```

- `dispose()` 时 `runtime.handle === null`（启动还没到赋值那一步），所以 `stopInternal` 什么也没关；
- 随后 `start()` 继续跑到 `runtime.handle = handle`（`service.ts:1216`），把监听装上并返回 `running:true`；
- **`close` 计数 = 0**：这个监听再也没有人能关（服务对象已被卸载丢弃），端口与令牌门一起活着；
- `dispose()` 之后 `accepting` 仍然是 `true`——与「活真相」的语义直接冲突。

**为什么算 P1**：这是本轮唯一会留下**活的监听 socket 无人持有**的缺口（不是措辞问题）；后果是端口被占、重新激活时 `EADDRINUSE`（触发 `E_LISTEN_FAILED`）、以及一个自称在接受的僵尸状态。触发窗口窄（卸载/停用恰好落在启动的那几百毫秒里），但 `473bf13` 恰恰把「激活即启动」变成唯一启动路径，这个窗口于是成了**每次激活都存在**的窗口。该缺口不是本批引入的（旧代码同样在激活期 fire-and-forget），但本批既重写了这段启动路径，就应当顺手补上守卫。

**建议修法（3 行，均在 `service.ts` 内）**：① `let disposed = false`，`dispose()` 首行置真；② `start()` 在 `await options.startListener(...)` 之后、赋值之前复检 `if (disposed) { await handle.close().catch(()=>{}); return status() }`；③ `autoStart()` 与 `start()` 入口加 `if (disposed) return status()`。同批加一条 A9：在飞启动 + dispose ⇒ `close` 计数为 1、`accepting === false`。

### 4.3 崩溃循环会不会把意图永久清掉

不会。意图的**唯一**清除点是显式 `stop()`（`service.ts:1122-1127`）；`dispose()` 不清（A6 用「失败 → dispose → 新进程 autoStart 起来」间接钉住）；`start('manual')` 在启动**之前**就落盘 `true`（`:1143`），失败也不清（A4/A6 钉住）。崩溃循环里没有任何一处在写 `false`。✅
唯一残留：`persistIntent` 写盘失败只吞错（`:672-680`），此时意图不会持久化——已被文件头如实登记，不判红。

### 4.4 「启动失败」的意图语义

失败只写 `status.lastError`，不抛、不阻断激活、意图保留，下次激活再试一次（A4 用 `E_NO_TLS_CERT` 钉住，A6 用 `E_NO_BIND_ADDRESS` 钉住手动来源）。✅ 与提交正文一致。

---

## 5 accepting 攻击结果

### 5.1 `accepting` 会不会在没有监听时为 true

- 正常路径：`accepting` 与 `running` 是**同一个表达式** `runtime.handle !== null`（`service.ts:998-1006`、`:1032`），没人写、每次派生。ACC-1/ACC-2 双向钉住。✅
- **两条会造成「`accepting` 与端口真实状态脱节」的路径**：
  1. **监听侧没有失败回归通道**：`server.on('error')` 只 `noteFailure(...)`（`listener.ts:1929-1931`），既不清 `runtime.handle`，也不通知 service。端口真死了，`accepting` 仍为 true。严格说文件头把判据写成「句柄是否存在」，这句是诚实的；但面板那句「正在接受连接（addr）」会多活一会儿。判 P2-8。
  2. **在飞 start + dispose**（§4.2）：反向——`accepting=true` 而没有任何人能管它。
- `stopInternal` 先把 `runtime.handle` 置空再 `await handle.close()`；`close()` 抛错只吞掉（`:1111-1117`）。所以「已经停了但端口还在」时 `accepting=false`——方向是保守的（宁可说没在接），可接受。

### 5.2 面板能不能分清「保存的偏好关着但在接」与反向

- 引擎侧：ACC-1（`enabled=false` + 有句柄 ⇒ `accepting=true`）、ACC-2（`enabled=true` + 无句柄 ⇒ `accepting=false`）都通过；`toSettingsView` 只从 `live.accepting` 抄，**不读** `enabled`（`service.ts:203-215`）。✅
- 面板侧：`lean.remote.accepting` 只在 `accepting === true && acceptAddr !== ''` 时渲染（`client.js:1482-1485`），与 `lean.remote.autostarted`（`autoStarted && !stopped`）**各说一件事**，不互相推断。✅
- **但有一个第二口径**（P2-9）：`applyRemoteStatus(status, settings)` 只有拿到 `settings` 时才更新 `accepting/acceptAddr`（`client.js:1204-1207`）；启动失败分支只 `setRunning(false)`（`:1374-1381`）**不清理** `accepting`。于是「上一次读到在接」+「这次启动失败」可以同时渲染 `未启动` 与 `正在接受连接（a:p）`。修法：失败分支里 `setAccepting(false); setAcceptAddr('')`（两行）。

### 5.3 `startedBy` × `accepting` 会不会互相矛盾

- `startedBy = handle === null ? null : runtime.startedBy`（`service.ts:1037`）⇒ **`startedBy` 非空必然 `accepting` 为真**；`autoStarted` 又要求 `status.running === true`（`client.js:1198`）⇒ 「已自动恢复」不会单独出现。A3 还钉住停止后 `startedBy === null`。✅
- 反向（`accepting=true` 而无 `autoStarted`）是**正常**的手动启动。✅

### 5.4 新字段对平板是否 additive

- `apps/**` 里**零引用** `remoteGetState / remoteSaveSettings / accepting / startedBy`（全仓 grep 0 命中）⇒ 平板根本不解析这份视图，**不可能**因新增字段破格式。✅
- 真正的消费者是 `dist/client.js`（面板）：新 key 进 `locale/{zh,en}.json` + 内联字典，`locale.test.mjs` 断言四处逐字一致（`:150-158`）。✅

### 5.5 那处偏离是否真的关掉了「停机状态被重写就丢意图」

**关掉了。** 证据链（读码 + 测试）：
`pairingProvision.persistEndpoint()`（`pairingProvision.ts:191-198`）先用 `normalizeRemoteSettings(raw, defaultRemoteSettings())` 得到 `previous`，而 `normalizeRemoteSettings` 现在会**从原始记录**读 `autoStart`（`accessMode.ts:517-524`：`record.autoStart === true || === false` 才写，缺键/坏值不写、不抛）；第二次归一传的 `previous` 已带上该键 ⇒ `next` 带上 ⇒ 整文件写回不丢。ACC-5 用「**已停止**状态 + provisioning 整文件重写 + 下次激活仍自动恢复」端到端钉住，我在 `gates-acc-newtest.out` 里看到它绿。**偏离（改在归一化而不是 `defaultRemoteSettings`）是对的**：在默认值里声明会给旧文件凭空造出 `false`，把「没有这个键」与「明确关掉」混为一谈。

---

## 6 诚实性清单（含 Lead 的提交信息）

| # | 句子（要点） | 位置 | 证据 | 判定 |
| --- | --- | --- | --- | --- |
| H1 | 「奇偶规则实测：注释行 `rem ` 之后的非 ASCII 字节数为奇数才会发作（×1/3/5 发作，×2/4/6 干净）」 | `src/engine/git.ts:453-455` | `f6386f2` 正文：「lane 给出的奇偶规则我**复现不出来**，因此**不主张**它是机制」 | ❌ **同一批里自相矛盾**，源码侧超出证据 → **P2-4** |
| H2 | 「插件 **1029 / 1027 / 0 / 2**；新增 10 例（B01–B10）」 | `21b2a34` 正文、`docs/MODULES.md:721` | `test/error-surface.test.mjs` 确有 10 条 `test(`；但下一个捕获 `gates-designer-auto-plugin.out` 为 1037 而 autostart 只 +8 ⇒ 本提交的树是 1029，故 `283a128` 的 1029 已含这 10 条 | ❌ 总数与新增不相容 + **无自己的捕获**（「插件套件同上」）→ **P2-2/P2-3** |
| H3 | 「插件 1029 / 1027 / 0 / 2（`.tmp/gates-designer-hb-plugin.out`，两次一致）；新增 14 例」 | `283a128` 正文、`MODULES.md:720` | 1005 + 14 = **1019 ≠ 1029**；该捕获只有 **1** 条 `ℹ tests` 汇总（「两次一致」的第二跑在 `gates-hb-suite-1/2.out`） | ❌ 数字被同期另一模块的 10 条测试污染 → **P2-2** |
| H4 | 「插件 **1037 / 1035 / 0 / 2**；lane 两次非空 `138936` / `139000` B 亦绿」 | `473bf13` 正文、`MODULES.md:723` | `gates-designer-auto-plugin.out` = 1037/1035/0/2 ✓；`gates-auto-m1-5/6` 精确为 138936 / 139000 B ✓；并且 Lead 主动披露「lane 自报 1036/1035 加不起来，以 1037 为准」 | ✅ **可核，且披露到位** |
| H5 | 「插件 **1045 / 1043 / 0 / 2**」+「lane 的 0 字节捕获不算证据」 | `0a0d6fe` 正文、`MODULES.md:725` | `.tmp/gates-lead-accepting-full.out` = 1045/1043/0/2；我第一次独立跑 `gates-rv4-plugin.out` 也是 1045/1043/0/2 | ✅ 数字成立；捕获口径披露正确（见 §1.5 的「0 字节已不可复现」补注，处置不变） |
| H6 | 「已编译（build exit 0 + dist 与新鲜 tsc 逐字节一致 76 文件 0 mismatch）」×7 | `MODULES.md:714/716/718/720/721/723/725` | 我复跑 distcheck：`DIST-FRESHNESS: 76 files, 0 mismatch`、`DIST-WINDOW: 0` | ✅ 后半句**独立复核成立**；前半句（`build.mjs` exit 0）本评审**被禁止**运行，按「未复核」记录，不算超证据 |
| H7 | 「未做真实推送（由 Lead 复验）」/ `unverified` | `MODULES.md:714` | 但 `docs/VERIFICATION.md:2328` §15.22 H（提交 `d945460`）已记录**活体验证**：修后 `fetch 824 ms → push 703 ms`、stderr 碎片 0 次、`origin/main...HEAD = 0/0` | ⚠️ **欠报（under-claim）**：登记行比证据旧。方向安全，但两处不一致应订正（把 §15.22 H 指过去，或在该行加「已由 §15.22 H 活体验证」） |
| H8 | 「`enabled` 序列化值改为跟随监听句柄（start 后 true、显式 stop 后 false、dispose 不动）」 | `MODULES.md:718`、L-12 标题「单一事实来源 = handle」 | 我的探针：运行中 `saveSettings({port})` ⇒ 监听被停、`running:false`、**磁盘 `enabled` 仍 true**（`service.ts:1300` → `stopInternal(false)` 不写该位） | ⚠️ 括号里枚举的三条**都对**，但「跟随句柄」的总述不成立 → **P2-7**（`473bf13` 把 `enabled` 改称「句柄回声（上一次是开着的）」才是准确说法） |
| H9 | 面板新句「正在接受连接（{addr}）」= 活真相 | `MODULES.md:725`、`client.js:1479-1485` | 判据确实是 `runtime.handle !== null`；但监听侧无失败回归通道、且启动失败分支不清 `accepting` | ⚠️ 「句柄存在」这一半成立，「此刻真的在接」这一半有两条缺口 → **P2-8/P2-9** |
| H10 | 「零 retarget（`remote-service.test.mjs`、`urls.ts`、`accessMode.ts`、`locale/*.json` 逐字节未变）」 | `ffe708d` 正文 | `git show --stat ffe708d` 只列 `service.ts` / `client.js` / 2 dist / 1 新测试 / `MODULES.md` | ✅ 成立 |
| H11 | 「未删除、未放宽任何既有断言」（error-surface） | `21b2a34` 正文 | 七条提交合计 `+2308 / −3`，删除的 `assert` **只有 1 条**（locale 计数 83→85），无放宽 | ✅ 对 `21b2a34` 成立；对**整批**也成立（见 §9） |
| H12 | 作为证据引用的 witness | `.tmp/gates-designer-ap-witness.out` | 9/9 OK 是真的，但输出里把**真实 Gitee 登录名**明文打印（`OK cmd 用户名提示 ⇒ 用户名 → <真实登录名>`） | ⚠️ 规则 11 卫生：证据文件属未跟踪 `.tmp`，未进仓库；但既然被提交信息点名引用，应只报形态 → **P2-11** |
| H13 | Lead 的登记提交 `e4f7873`「补登记 accepting（lane 未写，Lead 代填）」、`MODULES.md:725` 末尾「本行由 Lead 补写」 | `e4f7873`、`MODULES.md:725` | 行确实存在且完整 | ✅ 披露诚实 |

**没有任何一条 `unverified` 被升级成「verified」**：七条模块行全部仍以 `/ unverified` 结尾，`MODULES.md:727` 的真机验收四条仍写「尚未通过」。§15.22 H 的 4 条未验项（运行中 DSH 是否仍持旧 shim、真实代理、平板 15 条断言）与 `0a0d6fe` 的未验项**逐条吻合**。

---

## 7 跨模块交互

**(a) 清扫 × autostart × 计数重置** — 见 §2.5：无交互。三者都在激活期 fire-and-forget，但不共享对象；新建目录 mtime 永远新鲜，进不了 1h 窗口。

**(b) `autoStart` 会不会用「陈旧的 `lanAddress`」把 `192.168.137.1` 重新曝出去** — **会，且是自动的**（P2-10）：
`autoStart()` 读 `readSettings()`（磁盘 `lanAddress=192.168.137.1`），`lanSelectionFor` → 「落盘值 == 冻结启发式输出 ⇒ 当自动值」。本机实测 `provisionedMirrorLanAddress()` **正好**返回 `192.168.137.1`，所以今天这条把旧地址判成「自动值」，路由胜出、绑 `192.168.1.5`——**今天不会重曝**。
但判据是「等于冻结启发式的**当前**输出」（`service.ts:570-572`），而冻结启发式的输出随**网卡集合**变化：一旦机器上出现了枚举更靠前的非虚拟 RFC1918 网卡（插网线、Wi-Fi Direct 虚拟适配器被移除/改名），冻结启发式会返回**别的**地址，落盘的 `192.168.137.1` 立刻**不再等于**它 ⇒ `trusted=true` ⇒ 按「运维手填」**胜出**（我的探针场景 3 已证明这条分支无条件生效）⇒ `autoStart` 在重启时把它自动绑回去并广播。**修法**：可疑值不要只比「旧启发式的当前输出」，还要比「本机是否仍有该地址的网卡」（`isBindableLanAddress` 已能判）——地址已不在网卡表里就不该当可信覆盖。

**(c) `startedBy`（autostart）× `accepting`（accepting）** — 见 §5.3：两者都从同一个句柄派生，不会互相矛盾；「已自动恢复」被 `status.running === true` 门控，不会在 `accepting=false` 时出现。**唯一的裂缝**是面板各自的 React 状态（P2-9），不是引擎。

**(d) 有没有削弱 auth/安全不变式** —
- **cookie 注入**：本批未触碰 `mintOnce` / `refreshUpstreamAfter401` / 门禁；`upstream` 仍只有单槽、成功才覆盖（我读码确认 `service.ts:963-968` 未变）。
- **LAN 暴露**：新行为是**换绑到更可达的地址**（这正是修 bug 的目的），并没有扩大暴露面（仍在具体单播地址上、仍要令牌门、仍拒回环/通配）。**但**它确实让「监听可达」从概率事件变成确定事件——这是产品意图，不是缺陷。
- **令牌进日志**：`details` 仍只带 `reason` / 纯数字 `status`；`showLink()` 仍是唯一明文出口；我在探针里检查了生成物 `.cmd`/`.mjs` **不含令牌**（`true`）。
- **令牌写进 askpass 文件**：未发生（token 只经 `DSH_GIT_SYNC_TOKEN` 进子进程环境）；`%*` 只转发 git 的提示文本，**token 不进 argv**。
- **一条新增的卫生问题**：witness 捕获里有真实登录名（P2-11）。

---

## 8 测试有效性（哪条断言 revert 后仍会绿）

| 模块 | 最弱的一条 | 若把修法 revert，它还会绿吗 |
| --- | --- | --- |
| `askpass-cmd-shape` | 与「按调用重置计数」相关的一切 | **会。** 全仓 `test/*.test.mjs` 里 **0 次**出现 `resetAskpassCounter`；T4/T5/T6 都是**直接调 `askpass.mjs` 并注入计数文件**，没有任何一条断言「真实 git 子进程启动前计数文件已被删除」。把 `git.ts:816` 那行删掉，1045 全绿。**这是本批最实的一处「测试弱于 claim」**（claim 是「兜底计数按调用重置」）。 |
| `askpass-stderr-residual` | T1/T2 是**文本形状守卫**（`%*` 在同一行、`rem` 无元字符） | 会红（形状变了），所以这两条**有效**；真正弱的是「生产形状 stderr 为空」只有 2 次问询、无「同一文件在两种代码页下」的对照——但既有实现已不可能产非 ASCII，不强求。 |
| `askpass-temp-hygiene` | A13「插件接线：`apply()` 里确实调了启动清理」= **源码文本守卫** | 会红（文本没了），但 A12 强制测试进程 `skip` ⇒ 真实清扫在套件里**从不执行**，所以「清扫真的会删」只有纯函数级证据。这一条与 `MODULES.md:720` 的 `unverified` 自认一致。 |
| `lan-address-selection` | L-12 只覆盖 start / stop / dispose 三条 | **会红的是「revert `commitEnabledFlag()`」**；但把 `saveSettings` 那条停监听路径算进来，`enabled=true` + 无句柄仍全绿（我的探针场景 B）⇒ **L-12 证明的对象比标题窄**（见 P2-7）。 |
| `askpass-error-surface` | B01/B02 是**源码文本重扫 + 允许清单** | 只要新增的码是拼出来的（变量名）而不是字面量，扫描就看不到；B07（逐字文案）与 B10（端到端 `E_REPO_ASKPASS`）是硬的。整体有效，弱点是「扫描等价于覆盖」这个假设（与 b11c P2-3 同一类）。 |
| `remote-autostart` | A6 间接钉住「`dispose()` 不清意图」 | 会红（第二实例 `autoStart()` 起不来），所以这条**不是**空断言；弱的是 A7 只断言那一句**出现**，不断言它**何时消失**（长时间运行后仍显示「已在启动时自动恢复」）。 |
| `remote-accepting` | ACC-8「`dist` 里不再出现『按 `enabled` 起监听』」= **源码文本缺席守卫** | 换个写法（拆行、改名、包一层）即绿 ⇒ 它证明的是「这段文本不在」，不是「这个行为不存在」。 |

**普查/本地化守卫是否退化成一个裸计数** — **没有退化**：
- 20 个 shipped key **逐条点名**（`test/locale.test.mjs:113-120`），改名会当场失败；
- 计数从 83 → 84 → 85 是**与点名同步**加的（`:130-136` 注释逐条写了来源）；
- 新增 3 条强断言：`typeof en[…]` / `typeof zh[…]` 为字符串、**`en !== zh`**（不许照抄，`:138-147`）、以及 `lean.remote.accepting` 必须含 **`{addr}`** 占位符（`:143-146`）。
- 即：`473bf13` 说的「修法不是把数字改大」在 `0a0d6fe` 里**继续被遵守**。

---

## 9 断言纪律

- `git diff -U0 77cd7a8^ e4f7873 -- packages/dsh-dots/test`：**新增 2308 行 / 删除 3 行**；删除行里含 `assert` 的**只有 1 条**：
  `- assert.equal(Object.keys(en).length, 83, …)` → 现在是 85（两批各 +1 个 key，各自都有逐条点名与 `en !== zh`）。
- **没有**任何断言被净删除或放宽；两个新测试文件（`askpass-cmd-shape` / `lanSelection` / `error-surface` / `remote-autostart` / `remote-accepting` / `askpass-temp-hygiene`）是从 0 新增。
- 与提交自述一致（`21b2a34`：「未删除、未放宽任何既有断言」）。唯一可挑的是 `0a0d6fe` **没有披露**它把普查计数从 84 提到 85（上一批 `473bf13` 专门披露过同一份文件）——虽然该提交在 `MODULES.md:725` 的回滚列表里列了 `test/locale.test.mjs`。**判 P2（披露不完整），不判红。**

---

## 10 `unverified` 边界（本评审没有、也不能证明的东西）

1. **没有跑 `node scripts/build.mjs`**（被禁止）。所以七条模块的「build exit 0」未复核；我只独立复核了「`dist/` 与一次全新 tsc 逐字节一致」这一半。
2. **没有真实推送 / 没有远端**：askpass 的一切结论都基于本地生成物 + 注入的假凭据；「Gitee 判 `username=<token>`」这条因果链我用的是 `f6386f2`/§15.22 H 的现场记录，不是我复现的。
3. **没有真实监听端口**：`start()` 的所有路径都用注入的监听工厂；§4.2 的泄漏结论是「服务层状态机」层面的（`close` 计数 0），我没有真开 socket 观察端口占用。
4. **没有真机 / 没有平板 / 没有 `hdc`**：`accepting` 的面板渲染、配对扫码、§2.6/§2.7 的 15 条断言一律未验，与各提交自述一致。
5. **没有删除真实 `%TEMP%` 条目**：清扫只跑了注入目录与 dry-run；`NODE_TEST_CONTEXT` 让我在测试里也删不到真实条目。真实激活期的那一次清扫**仍未被执行过**（该模块自认的 `unverified` 依然成立）。
6. **没有在非 NTFS 文件系统上验 mtime 语义**：§2.4 的「使用中目录不会超龄」只在 NTFS 上成立。
7. **没有触发监听侧 `error`**：P2-8 是读码结论，不是实测。
8. **探针形态与生产不完全一致**：`sameParent` 那条（P2-5）的「父进程稳定」是我人为造的；生产每一次 askpass 都是新 `cmd.exe`（提交里有 ppid 证据，我采信）。
9. **`git diff` 的路径/行号基准**：本报告行号以 `HEAD = e4f7873` 的工作树为准（`read`/`grep` 工具一致；`Get-Content` 在本机对该文件报出不同的行号，已舍弃该来源）。

---

## 11 冻结建议

- **裁决：可以冻结（freeze-with-fixes）**。P0 = 0、P1 = 1、P2 = 12；七条主承诺全部成立且有见证，P1 是窄窗口的状态机缺口，其余是措辞/数字/边角。
- **建议同批小修（1 条 P1 + 3 条 P2，代价都很小）**：
  1. **P1-1**：`dispose()` 置 `disposed` 位，`start()` 在 `await startListener` 之后复检并 `close()` 掉刚建好的句柄，`autoStart()`/`start()` 入口拒绝已 dispose 的服务；加一条 A9（在飞启动 + dispose ⇒ `close=1`、`accepting=false`）。约 3 行 + 1 例。
  2. **P2-1**：把 `service.ts:492` 那句「（与自动挑选结果相同，按自动值处理）」改成「（与 provisioning 旧启发式的输出相同，无法证明是你手填的）」。1 行，不动判据。
  3. **P2-4**：`git.ts:453-455` 的「奇偶规则实测」删掉或改成「lane 观测到奇数/偶数差异，本 lane **未能独立复现**，不主张其为机制」。注释级改动。
  4. **P2-2/P2-3**：`MODULES.md:720` 与 `:721` 的 1029 各加一句口径说明（前者含同期 error-surface 的 10 例；后者无自己的捕获，数字取自同期全量），或直接给 `21b2a34` 补一次自己的全量捕获。
- **建议排后续（不阻断）**：P2-5（给 `sameParent` 加「上次已问满就不许继承」的强制门，或删掉该子句）、P2-6（先判 `assword/assphrase` 再判 `sername`，或对 `Password for` 做前缀锚定）、P2-7（`stopInternal(false)` 也要不要写 `enabled` 需要一次决定）、P2-8/P2-9（给监听侧加失败回归通道；面板失败分支清 `accepting`）、P2-10（可信覆盖再加「该地址仍在本机网卡表里」这一条）、P2-11（witness 只报形态）、P2-12（把 lane 那次未完成的捕获标注为「无汇总脚」）。
- **若 Lead 决定不再改动**：可以按现状冻结。P1 需要「卸载恰好落在启动的几百毫秒内」，P2 都不会让用户拿到错误的下一步到不可接受的程度——最接近的一条是 P2-10（网卡集合变化后 `autoStart` 自动绑回不可达地址），但它需要环境变化且仍会在面板原因行里说明广播的是哪个地址。
- **复核入口**：本报告 §2/§3/§4/§5 的每条构造都可用 `node --input-type=module` + 仓库内 `dist/` 重放（不写任何仓库文件）；门禁四件的留存见 §1.2 的四个 `.out`。
