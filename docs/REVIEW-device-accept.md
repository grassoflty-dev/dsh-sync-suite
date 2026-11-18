# 评审：D 批（device-accept 四项修补 + preflight）

- 评审对象：`apps/arkui-schedule/tools/device-accept.mjs`（改）、`tools/test/deviceAccept.test.mjs`（新）、
  `tools/preflight.mjs`（新）、`tools/test/preflight.test.mjs`（新）、`docs/PREFLIGHT.md`（新）
- 仓库：`C:\Users\GWL\Desktop\itwillclaude\dsh-sync-suite`，分支 main，HEAD `379fcc5`，工作区**未提交**
- 评审角色：独立只读评审（不修代码、不 commit、不跑 overlay apply / 全量测试 / build-harmony / 装机）
- 评审时刻文件指纹（SHA256 前 16 位 / 行数，行数按 `\r?\n` 切分）：
  `29526140ef777d7b` / 1072 `device-accept.mjs`，`9e6488a252421e04` / 677 `preflight.mjs`，
  `46aacb30bb6b9e9f` / 362 `deviceAccept.test.mjs`，`2be5d1621390eae0` / 319 `preflight.test.mjs`，
  `50384a2dc42c4df5` / 58 `PREFLIGHT.md`
  （评审期间工作区还有**其它批次**在改文件：`remoteUrl.ts`、`stateView.ts` 等，不在本次范围）

## 1. 结论

**PASS-WITH-NITS**（阻断 0 / 应修 2 / 建议 10）

核心契约经我独立构造反例复核，全部成立：`5 SKIP + 1 PASS → 3`、`[] → 2`、`FAIL+SKIP → 1`、
`groupByRows` 是**行首锚定**而非链式漂移、`compareHapFreshness` 同毫秒 → fail、
`verifyShaManifest` 伪造/缺文件 → fail 且点名、`import` 无副作用且**不调 hdc**、无设备 → exit 2（已实测）。
留下的两条「应修」都不是本批四项修补本身没做到，而是修补**外沿**的假通过面：`工具条两行` 这一步在
「两行叠成一行」（正是缺陷 4 本身）时仍记 PASS；以及 `exit 0` 在实际流程里**不可达**，与头注释
「0 = 唯一可以放行的信号」冲突。

## 2. 逐项核对表

| # | 要求 | 实现证据（文件:行号） | 我的反例输出 | 判定 |
| --- | --- | --- | --- | --- |
| 1 | 退出码分级 0/3/1/2；「5 SKIP + 1 PASS」必须是 3（不是旧实现的 0） | `device-accept.mjs:81-93`（`gradeExit`）、`:412-415`（`skipped` 记 `ok:false,skipped:true`） | `1) 5SKIP+1PASS -> 3`；旧形状 `{ok:true,skipped:true}` 也 `-> 3`（X3） | PASS |
| 2 | `gradeExit([])` 若给 0 判红（零证据不能放行） | `device-accept.mjs:82-84`（`length === 0 → EXIT_NO_DEVICE`） | `2) [] -> 2` | PASS |
| 3 | 有 FAIL 且同时有 SKIP → 必须 1，不能 3 | `device-accept.mjs:86-92`（优先级：deviceMissing → fail → skip → pass） | `3) PASS+SKIP+FAIL -> 1`、`3b) SKIP+FAIL -> 1` | PASS |
| 4 | deviceMissing 稳定给 2 | `device-accept.mjs:86-88`；无设备实际路径 `:766-777`（打印后 `return`，results 为空） | `4) deviceMissing -> 2`、`4b) deviceMissing+PASS -> 2`；实跑 `exit=2`（见下 §2.1） | PASS（但该分支是死契约，见 A3） |
| 5 | `summaryLine()` 逐字格式（全角括号 / `→` / `, ` 分隔 / 无 SKIP 省略括号） | `device-accept.mjs:109-131` | 见 §2.2 六行逐字输出（`→ exit 3（未覆盖：…）`，`,` + 空格分隔） | PASS |
| 6 | `groupByRows` 链式漂移：`y=[100,120,140,160]`、tol=24 | `device-accept.mjs:137-155`（`Math.abs(item.y - row[0].y)`，锚=行首） | `6a) -> [["a@100","b@120"],["c@140","d@160"]]`，`rows.length=2` | PASS（行首锚定，未串成一行） |
| 7 | `compareHapFreshness`：HAP 与源码**同一毫秒**时不许悄悄放行 | `preflight.mjs:176-187`（`deltaMs > 0` 才算 fresh，`0` 落入 stale） | `7a) {"ok":false,"reason":"stale","deltaMs":0}`；`7d) status= fail` | PASS（文案小瑕，见 A7） |
| 8 | `verifyShaManifest`：无清单 → unverified 不计 fail；伪造 → fail 点名；列了但文件不存在 → fail | `preflight.mjs:308-354`、`361-402` | `8a) {"status":"unverified","reason":"no-manifest"}`；`8d) status= fail mismatch=[{"name":"b.hap","reason":"hash",...}]`；`8e) status= fail reason= missing` | PASS |
| 9 | `import` 两个模块无副作用（不跑 main、不调 hdc、不写文件） | `device-accept.mjs:325-345`（`isDirectRun`）、`:1070-1072`（守卫）；`preflight.mjs:672-677` | `9a) {"hook_seen_by_esm_facade":true,"spawned_during_import":[],"import_ms":6}`；`9b) git_status_unchanged=True tmp_files_unchanged=True` | PASS |
| 10 | 未给 `--serial` 且没有设备 → exit 2；**不得新增自动装机** | `device-accept.mjs:766-777`；装机仅原步骤 `:782-796`（`--skip-install` 时 `:795` SKIP） | 实跑见 §2.1；`git diff` 新增行内除 `hdc(['install','-r',hap])`（原有，未改）外无 install/uninstall 调用 | PASS |
| 11 | 没改坏既有语义（只该有结构重排） | 删除行逐条核对：只有 `SERIAL/SKIP_INSTALL/KEEP_GOING/TMP/results` 常量、`opt()`、`hilog()` 拆写、`fail()` 的 `process.exit`、`spawnSync('powershell'…)` 的 9 处、`const got =`（无用变量） | 无任何业务 `pass()/fail()/skipped()` 断言被删（`pass('设备连接', SERIAL)` 是重写，不是删除） | PASS |
| 12 | `docs/PREFLIGHT.md` ≤60 行且判据与实现一致 | `PREFLIGHT.md:1-58`（58 行）；判据表 `:13-17` ↔ `preflight.mjs:129-151, 196-222, 361-402`；源码路径集 `:19` ↔ `preflight.mjs:49` | 逐条对照无矛盾；本机实跑 exit 1 命中的正是文档写的 `hap-fresh=fail` | PASS（error 计数未进汇总行，见 A6） |
| 13 | 双测通过 | 两个测试文件 | `tests 58 / pass 58 / fail 0`（deviceAccept 30 + preflight 28） | PASS |

### 2.1 无设备 / 无匹配设备的真实路径（只用了一次 `hdc list targets`，未装机、未驱动真机）

```
$ node apps/arkui-schedule/tools/device-accept.mjs --serial NOPE-NOT-CONNECTED-0000
真机验收：serial=NOPE-NOT-CONNECTED-0000  skipInstall=false
设备未连接：hdc list targets 里找不到 NOPE-NOT-CONNECTED-0000（当前：6MFBB25C27205131）
处理：接上真机并确认 `hdc list targets` 能列出序列号，或用 --serial <id> 指定；本脚本以 2 退出（未覆盖 ≠ 通过）。

合计：PASS 0 / FAIL 0 / SKIP 0
[accept] pass=0 fail=0 skip=0 total=0 → exit 2
exit=2
```

`skipInstall=false` 却没出现任何 `安装` 输出 → 证明该分支在装机前就返回（**没有偷偷装机**）。
`[Empty]`（真·无设备）分支未实跑（真机在线，按禁令不拔线/不驱动），改用纯函数：
`pickSerial('[Empty]', '6MFBB25C27205131') -> null`、`pickSerial('[Empty]', '') -> null`、`pickSerial('', '') -> null`，
与上一条走同一 `serial === null` 分支 → `gradeExit([]) = 2`。

### 2.2 `summaryLine()` 逐字（反例 5）

```
5a) 无 SKIP        "[accept] pass=2 fail=0 skip=0 total=2 → exit 0"
5b) 5 SKIP + 1 PASS "[accept] pass=1 fail=0 skip=5 total=6 → exit 3（未覆盖：下拉刷新, 全部未完成·索引, 正文占位符, 详情页附件, 启动自动 pull）"
5c) FAIL + SKIP     "[accept] pass=1 fail=1 skip=1 total=3 → exit 1（未覆盖：下拉刷新）"
5d) 空（无设备）     "[accept] pass=0 fail=0 skip=0 total=0 → exit 2"
5e) deviceMissing   "[accept] pass=0 fail=0 skip=0 total=1 → exit 2"
5f) 只有 FAIL        "[accept] pass=0 fail=1 skip=0 total=1 → exit 1"
```

全角括号 `（未覆盖：…）`、`→`、`, `（逗号+半角空格）、无 SKIP 时整段省略、按出现顺序不排序 —— 全部符合契约。

### 2.3 preflight 在本仓库的真实跑（只读：`overlay.mjs status` + `git log` + 读文件）

```
$ node apps/arkui-schedule/tools/overlay.mjs status
覆盖层：未应用（工作区为「共享源码 + 平台目录」的原始形态）
[overlay] applied=false

$ node apps/arkui-schedule/tools/preflight.mjs
[preflight] overlay=ok applied=false
[preflight] hap-fresh=fail hap=apps/arkui-schedule/entry/build/default/outputs/default/entry-default-unsigned.hap hapMtime=2026-11-18T12:20:37.174Z source=2026-11-18T12:22:07.000Z
[preflight]   HAP 比源码最后提交旧 90s（产物没跟上源码），需要重新构建：node apps/arkui-schedule/tools/build-harmony.ps1，然后重跑 sign-hap / pack-dist
[preflight] sha=ok manifest=dist-20261118-0836/SHA256SUMS.txt entries=4
[preflight] pass=2 fail=1 unverified=0 → exit 1
preflight_exit=1
```

即：**当前 HEAD 的真实产物就过不了判据 2**（HAP 比源码提交早 90s），说明这条判据在真实数据上有牙齿，
不是只会对假数据变红。SHA 清单真实存在（4 条全命中），没有走 `unverified-sha` 逃避。

## 3. 发现的问题清单

| 编号 | 严重度 | 文件:行号 | 问题 | 最小修法 |
| --- | --- | --- | --- | --- |
| A1 | **应修** | `device-accept.mjs:519-522` | `工具条两行` 这一步**永远 PASS**：`items.length ≥ 2` 之后不看 `rows.length` 就 `pass()`。缺陷 4 本身（两行叠成一行）得到 `rows.length=1`，仍打印 `row1=8 个 / row2=0 个` 并记 PASS；竖排 rail 3 行也只报 row1/row2 且 PASS。名称像断言、实际只打印 → 又一个「看起来通过」的面。 | 二选一：①改名 `工具条布局打印`（诚实地只做诊断，detail 带 `rows=${rows.length}`）；②保留断言含义则 `rows.length === 2 → pass`，否则 `skipped('工具条两行', '只分到 N 行：…')`（横屏合法单行 → SKIP 而非 FAIL）。 |
| A2 | **应修** | `device-accept.mjs:747`（配合 `:9`） | `pen 过滤·开启时笔能画` 在成功路径上**无条件 SKIP**，而 `penControlStep()` 在每轮业务流里都跑（`:898`）→ 任何真实跑法的 SKIP ≥ 1 → **`exit 0` 不可达**。头注释 `:9` 却写「0 = 全部 PASS —— 唯一可以放行的信号」，下游永远等不到 0，0/3 的区分实际退化成「只有 3」。 | ①最小：把 `:9` 改成「0 = 无 SKIP 的完整通过（当前流程因笔触注入不可得而不可达），下游把 3 视作「人工确认后可放行」」；②更好：给「只能人工验」的项单独一档（像 preflight 的 `unverified` 不计红），别和「未覆盖的自动项」共用一个 SKIP 计数。 |
| A3 | 建议 | `device-accept.mjs:766-777` ↔ `:86-88, :112-116` | `deviceMissing` 是**死契约**：全仓库没有任何代码写入 `deviceMissing: true`（grep 只命中定义与测试），所以 `gradeExit` 的第一优先级分支、`summaryLine` 的「deviceMissing 不计 fail」只为测试而存在；真实无设备路径是「零 results」。 | 在 `:769` 的无设备分支里补一条记录：`ctx.results.push({ step: '设备连接', ok: false, deviceMissing: true, detail: '设备未连接' })`，让汇总行出现 `total=1 → exit 2`，契约和实测就一致了；否则删掉 deviceMissing 处理。 |
| A4 | 建议 | `device-accept.mjs:81-93` | 畸形结果被当 PASS：`gradeExit([{step:'x'}])` → `0`，`gradeExit([{ok:'yes'}])` → `0`。当前只有 `pass()` 会写 `ok:true`，属加固项，但 `0` 是放行信号，别让「字段写错」变成「通过」。 | 判 PASS 用严格条件：`ok === true && skipped !== true`；任何 `ok` 不是布尔的条目计入 fail（或至少抛错）。 |
| A5 | 建议 | `preflight.mjs:471-491` | 与 A4 同类的不对称：`gradeChecks([])` → `{"pass":0,"fail":0,"unverified":0,"total":0,"exitCode":0}`，即「一条检查都没跑」也 `exit 0`；`device-accept` 那边刚好把这条修成了 2，preflight 没跟上。CLI 恒产出 3 条，实际不可达，但导出的纯函数是这个语义。 | `if (list.length === 0) return {…, exitCode: 2}`（或抛错），与 `gradeExit` 对齐。 |
| A6 | 建议 | `preflight.mjs:494-496` | 汇总行不带 `error` 计数：环境错误时打出来是 `[preflight] pass=1 fail=0 unverified=1 → exit 2`（`docs/PREFLIGHT.md:38` 的契约同款），只 grep `fail=0` 的下游会以为全绿。 | 行里补 `error=${grade.error}`（`error>0` 时追加），并同步 `PREFLIGHT.md:38` 的示例。 |
| A7 | 建议 | `preflight.mjs:179-187` | 相等/极近时文案不准：`deltaMs=0` 或 `-1` 都会被 `Math.max(1, …)` 说成「旧 1s」；实跑里 90s 的差值也来自同样的取整。数值本身没错（判据是严格大于），但「旧 1s」会让人以为差了 1 秒。 | 文案改成「HAP 不新于源码最后提交（Δ=0ms）」/按 `Math.abs` 给毫秒数，别强行凑 1s。 |
| A8 | 建议 | `device-accept.mjs:691-694, :548-552` | `setPenOnly(false)` 失败时走 `skipPenGroup` 直接返回，**不复位**：若上一轮被中断在「仅手写笔=开」，这一轮会把设备留在「只能用手写笔」的用户可见状态，且只记 SKIP（不是 FAIL）。 | `skipPenGroup` 前尝试一次强制复位；复位失败时在 `penOnly 复位` 记 FAIL（`:723-725` 已有同款逻辑可复用）。 |
| A9 | 建议 | `preflight.mjs:569-575` | 判据 2 与判据 3 各挑各的包：新鲜度看「mtime 最新的 HAP」，SHA 看「最新的 `dist-*/SHA256SUMS.txt`」，两者可能不是同一个产物；`sha=ok` 不代表**被判定新鲜的那份 HAP** 被核对过。 | 组装时把 `manifest` 里出现的 HAP 与 `hap.path` 比一下，不同就在 `sha` 行里打印 `covers=<另一份>`（至少别让人误读）。 |
| A10 | 建议 | `device-accept.mjs:306-319` | 序列号比较是**大小写敏感**的：`pickSerial('6MFBB25C27205131', '6mfbb25c27205131') -> null` → 小写 `--serial` 会被判「设备未连」并退出 2（同文件 `isDirectRun` 反而专门处理了 Windows 大小写不敏感）。 | 比较前两侧都 `toLowerCase()`（hdc 序列号是十六进制大写，改小写无歧义）。 |
| A11 | 建议 | `deviceAccept.test.mjs`（覆盖缺口） | 唯一真正「假通过」的面 `toolbarRowsStep`（A1）没被导出，因此没有单测覆盖；`penControlStep` 的复位分支同样只能靠真机。 | 把 `toolbarRowsStep` 的判定抽成纯函数 `toolbarVerdict(items, tol) -> {rows, ok, detail}` 并导出，补 3 条用例（1 行 / 2 行 / 3 行）。 |
| A12 | 建议（设计边界，非缺陷） | `preflight.mjs:49, 523-542` | 判据 2 只比「源码最后**提交**时间」，工作区未提交的源码改动不参与。当前工作区就有未提交的 `entry/.../remoteUrl.ts`、`version.ts`——只要它们比 HAP 新，preflight 仍可能判 fresh。这是按需求实现的（要求原文就是「源码提交」），但「旧 HAP + 全绿测试」的事故里，脏工作区是同等风险的来源。 | 若想补：`git status --porcelain -- entry AppScope packages` 非空且 mtime 晚于 HAP 时，打 `hap-fresh=warn dirty=1`（不判红，只提示）。 |

## 4. 我没能验证的部分（一律 unverified，**没有**「已验证」）

1. **真机手势 / pen 实物行为**：`penOnly=off 手指能画 → on 手指不画 → 笔能画` 这条链只在真机上成立。
   我按禁令**没有**运行 `device-accept.mjs` 的正常路径（会装机、会点手机、会拨动用户的「仅手写笔输入」开关），
   所以 hilog 信号（`[hw] history undo=` / `[hw] draft saved bytes=`）与真实落笔的对应关系、`FINGER_REJECT_THRESHOLD=3`
   的 toast 是否真在连划 3 下后出现，均未验证。
2. **真实装机 / 安装后启动**：未跑 `hdc install`，未跑整体验收。
3. **「真·无设备」**（`hdc list targets` 返回 `[Empty]`）：真机在线，我没有拔线/停 hdc server；只用纯函数复现了同一分支。
4. **`exit 0` 是否真的不可达**：结论来自代码路径判定（`:747` 无条件 SKIP + `:898` 无条件调用），未实跑。
5. **A2/A3/A8 的修复后果**：只写修法，没改代码（本轮只读）。
6. **全量回归**：按禁令未跑 1964 项全量测试；只跑了本批两个测试文件。
7. **`--keep-going` 的真实行为**：`fail()` 不再 `process.exit`，改抛 `StopFlow`；`--keep-going` 下沿用旧路径继续跑，
   与真机结合的行为（尤其是 `:785-787`、`:800-803` 那种 `fail(); return;` 组合）未实跑验证。

## 5. 复算命令清单（照抄可重跑上面每一条）

> Windows / PowerShell 注意：`pwsh` 会把 `-e` 参数里的双引号吃掉，所以下面统一用**单引号包整段、JS 里只用反引号模板字符串**。

```powershell
cd C:\Users\GWL\Desktop\itwillclaude\dsh-sync-suite

# 0) 双测（我跑出 tests 58 / pass 58 / fail 0）
node --test apps/arkui-schedule/tools/test/deviceAccept.test.mjs apps/arkui-schedule/tools/test/preflight.test.mjs

# 1–4) 分级矩阵
node --input-type=module -e 'const m = await import(`./apps/arkui-schedule/tools/device-accept.mjs`);
const P={step:`PASS`,ok:true}; const S=(n)=>({step:n,ok:false,skipped:true}); const F=(n)=>({step:n,ok:false});
console.log(`1)`, m.gradeExit([P,S(`a`),S(`b`),S(`c`),S(`d`),S(`e`)]));
console.log(`2)`, m.gradeExit([]));
console.log(`3)`, m.gradeExit([P,S(`x`),F(`y`)]));
console.log(`4)`, m.gradeExit([{step:`设备连接`,ok:false,deviceMissing:true}]));'

# 5) summaryLine 逐字
node --input-type=module -e 'const m = await import(`./apps/arkui-schedule/tools/device-accept.mjs`);
const P=(n)=>({step:n,ok:true}); const S=(n)=>({step:n,ok:false,skipped:true});
console.log(JSON.stringify(m.summaryLine([P(`设备连接`),S(`下拉刷新`),S(`全部未完成·索引`)])));
console.log(JSON.stringify(m.summaryLine([])));'

# 6) groupByRows 链式漂移（期望 2 行）
node --input-type=module -e 'const m = await import(`./apps/arkui-schedule/tools/device-accept.mjs`);
const at=(n,y)=>({name:n,y});
console.log(JSON.stringify(m.groupByRows([at(`a`,100),at(`b`,120),at(`c`,140),at(`d`,160)],24)));'

# 7) HAP 同毫秒
node --input-type=module -e 'const p = await import(`./apps/arkui-schedule/tools/preflight.mjs`); const T=Date.parse(`2026-11-18T00:00:00.000Z`);
console.log(JSON.stringify(p.compareHapFreshness(T,T)));'

# 8) SHA 清单：无清单 / 伪造 / 缺文件
node --input-type=module -e 'const p = await import(`./apps/arkui-schedule/tools/preflight.mjs`); const c = await import(`node:crypto`);
const H=c.createHash(`sha256`).update(`hello`).digest(`hex`); const fake=`${H}  a.hap\n${`0`.repeat(64)}  b.hap\n`;
console.log(p.verifyShaManifest(null,()=>null).status, p.verifyShaManifest(fake,()=>Buffer.from(`hello`)).status,
            p.checkSha({path:`dist-x/SHA256SUMS.txt`,text:fake},()=>Buffer.from(`hello`)).line);'

# 9) import 无副作用 + 不调 hdc（钩子先于 ESM facade 建立，hook_seen_by_esm_facade 必须为 true，否则本次探针无效）
node --input-type=module -e 'const { createRequire } = await import(`node:module`);
const require = createRequire(process.cwd() + `/probe.mjs`); const cp = require(`node:child_process`); const calls = [];
for (const n of [`spawnSync`,`execFileSync`,`execSync`,`spawn`,`exec`]) { const o = cp[n]; if (typeof o !== `function`) continue;
  cp[n] = function (...a) { calls.push(n); return o.apply(cp, a); }; }
await import(`./apps/arkui-schedule/tools/device-accept.mjs`); await import(`./apps/arkui-schedule/tools/preflight.mjs`);
const ns = await import(`node:child_process`);
console.log(JSON.stringify({ hook_seen: ns.spawnSync === cp.spawnSync, spawned: calls }));'

# 10) 无匹配设备 → exit 2（只做 list targets，不装机）
node apps/arkui-schedule/tools/device-accept.mjs --serial NOPE-NOT-CONNECTED-0000; "exit=$LASTEXITCODE"

# 11) 删除行核对（确认只有结构重排）
git diff -U0 -- apps/arkui-schedule/tools/device-accept.mjs | Select-String -Pattern '^-' | ForEach-Object { $_.Line }

# 12) overlay 只读状态 + preflight 真实跑
node apps/arkui-schedule/tools/overlay.mjs status
node apps/arkui-schedule/tools/preflight.mjs

# 13) A1 反例：缺陷 4（两行叠成一行）下这一步仍会 PASS
node --input-type=module -e 'const d = await import(`./apps/arkui-schedule/tools/device-accept.mjs`);
const items = Array.from({length:8},(_,i)=>({name:`c`+i,y:210})); const rows = d.groupByRows(items);
console.log(rows.length, `row1=${rows[0].length} 个 / row2=${(rows[1]??[]).length} 个`);'

# 14) A2 反例：全绿真机跑也 exit 3
node --input-type=module -e 'const d = await import(`./apps/arkui-schedule/tools/device-accept.mjs`);
const P=(n)=>({step:n,ok:true}); const S=(n)=>({step:n,ok:false,skipped:true});
console.log(d.summaryLine([P(`启动`),P(`完成`),S(`pen过滤·开启时笔能画`)]));'

# 15) A1 + A2 一条命令（本报告 §1 引用的就是这条）
node --input-type=module -e 'const d = await import(`./apps/arkui-schedule/tools/device-accept.mjs`);
const items = Array.from({length:8},(_,i)=>({name:`c`+i,y:210})); const rows = d.groupByRows(items);
console.log(`A1) rows=` + rows.length + ` -> 工具条两行 仍 PASS，detail: row1=` + rows[0].length + ` 个 / row2=` + (rows[1]??[]).length + ` 个`);
const P=(n)=>({step:n,ok:true}); const S=(n)=>({step:n,ok:false,skipped:true});
console.log(`A2) ` + d.summaryLine([P(`设备连接`),P(`安装`),P(`启动`),S(`pen过滤·开启时笔能画`)]));'
```

## 6. 附：A1 / A2 的原样输出（供快速复核）

```
A1) 缺陷4（两行叠成一行）rows=1 于是「工具条两行」仍 PASS，detail: row1=8 个 / row2=0 个
A2) 一次全绿真机跑（唯一 SKIP = 笔注入不了）: [accept] pass=5 fail=0 skip=1 total=6 → exit 3（未覆盖：pen过滤·开启时笔能画）
```
