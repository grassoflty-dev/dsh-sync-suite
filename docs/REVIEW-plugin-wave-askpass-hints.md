# REVIEW — mod-plugin-remote-hints-mode-keyed / mod-plugin-askpass-node-resolution

独立只读评审；未改任何源码/测试/配置/dist，未执行 git 写操作，未运行 live sync cycle，未读取 `~\.dsh\dots\**`。本报告是本轮唯一写入。

## 结论

| 模块 | 结论 | P0 | P1 | P2 |
| --- | --- | --- | --- | --- |
| A `mod-plugin-remote-hints-mode-keyed` | **PASS** | 0 | 0 | 1（清理项） |
| B `mod-plugin-askpass-node-resolution` | **PASS WITH FINDINGS** | 0 | 2 | 5 |

核心 diagnosis 正确：`gitAuthEnv()` 不再把 `process.execPath`（DSH 内是应用二进制）直接塞给 `askpass.cmd`，而是经解析+探针选真实 node，失败 typed 早于 git spawn。但 typed 码在 **fetch / 恢复路径**仍会被改写，且探针与实际 askpass 子进程的 `NODE_OPTIONS` 处理不一致，这两点必须在真机推送前处理或明确接受。

---

## A 检查清单

1. **[PASS] 表与 `<select>` 一一对应** — `src/client.js:1401-1406` 的 options 恰为 `auto / tailscale / lan / ipv6`；`src/client.js:337-345` 的 `LEAN_MODE_HINT_KEYS` 恰为这 4 项 + `none` + `fallback`（6 行）。`none` 的 zh/en 都只给一个动作（登录 Tailscale），`none` 不再含 Wi-Fi（`locale/{zh,en}.json:64`）；`fallback` 是中性句「未知方式暂无专用提示，请以上方状态行为准」，不是其它四句的拼接。测试 `test/remote-hints-mode-keyed.test.mjs:201-210` (T1) 钉住键集合且排除 `uu/manual/cloudflare`。
2. **[PASS] 渲染器只查一行、只渲染一句** — `src/client.js:1356` `const modeHint = tr(leanModeHintKey(modeValue))`；`:1423` 单个 `h('div', {'data-lean':'remote-transport'}, modeHint)`。诚实行 `plaintext/encrypted` 是**另一个 div**（`:1428-1431`），不是第二条方式要求。`leanModeHintKey()`（`:348-352`）对 `''`→none、未知/原型键→fallback，不会回落到某个具体方式。渲染文本不可能含第二模式的整句：表本身每格只讲自己的前提，T3 (`test/...:224-234`) 逐对验证 `pick(a).includes(pick(b)) === false`（zh+en）。
3. **[PASS] zh/en 字典 parity** — `locale/zh.json` 与 `locale/en.json` 各 **83** 个 key，键集合完全一致（实测计数：zh 83 / en 83，仅 zh=∅、仅 en=∅）；5 个 `lean.remote.hint.*` 两侧都在。`test/locale.test.mjs:134-142` 全量逐字对拍 `client.js` 内置 zh/en 与 locale JSON；`test/remote-hints-mode-keyed.test.mjs:313-329` (P1) 额外四点一致。
4. **[PASS] 新测试确实断言所需四件事，拼接会立即失败** —
   - 各自渲染自己的句子：`assert.equal(text, zhSentence(mode), ...)` + `assertNoForeignSentences(text, mode)`（`:244-245`）；select 集合 `:248`。
   - 无他方式句子：`assertNoForeignSentences` (`:189-195`) 对其余 5 个 key 做 `text.includes(foreign) === false`；`:230` T3 双向包含检查。
   - 未知→fallback：`assert.equal(text, zhSentence('fallback'), ...)` + 四模式与 none 整句都不出现（`:255-259`）。
   - `none` 单一动作：`assert.equal(text.includes('推荐先登录 Tailscale'), true)`、`assert.equal(text.includes('Wi-Fi'), false)`、`assert.equal((text.match(/Tailscale/g)||[]).length, 1)`（`:267-269`）。
   - honesty 独立：`:276-277`。**若两模式被拼接**：`:244` 精确相等、`:257-259` fallback 排除、`:269` Tailscale 计数、`:230` 互包含四处任一都会 FAIL。
5. **[PASS] 无回归** — `pairingShow` 仅显式触发、mount 零剪贴板、远程组无 port/token 输入、stop/start/rotate/audit 钩子由未改动的 `test/pairing-client-wiring.test.mjs:260-657`（W1–W10/H1–H5）与 `client-lean-inventory.test.mjs` 覆盖；`src/client.js` diff 只动字典文案、纯表、渲染一行、导出接缝，未碰上述逻辑。全量插件 889/887/0/2（见证据节）。
6. **[P2/清理] 死 key `lean.remote.transport.selected`** — `src/client.js:125,237`、`locale/{zh,en}.json:63` 仍保留「自动选中：{mode}」，已无任何渲染引用；不破坏功能，但 `locale.test.mjs:131` 的 83 计数会阻碍清理。**fix（可选）**：四字典同时删该 key 并把计数改 82，附带一条「不得复活」守卫。

---

## B 检查清单

1. **[PASS] 解析顺序与 Electron 条件** — `src/engine/nodePath.ts:126` override → `:136-143` PATH `node/node.exe` → `:147` `execPath` 仅在 `electronVersion` 非空时入表；`:120-122` `isAppBinary = electronVersion 非空 && samePath(candidate, execPath)`；`:165-166` 只有该候选被选中才 `ELECTRON_RUN_AS_NODE=1`，真实 node 反而 `delete`。全部失败 `:199-202` 抛 `SyncError(E_ASKPASS_NODE_MISSING, ...)` 且 `details.tried`。`src/engine/git.ts:101-113` 把整段包在 `usesGitAskpass()` 内 → anonymous/SSH 不解析 node。
2. **[PASS] `ELECTRON_RUN_AS_NODE` 恰好在应用二进制候选** — `nodePath.ts:165-166`、`git.ts:109-111`。测试 `askpass-node-resolution.test.mjs:123-144`：调用方 env 即使预置 `ELECTRON_RUN_AS_NODE=1`，真实 node 候选仍被删掉（`:130`）；应用二进制必须出现（`:142`）。
3. **[P1] typed 码在 fetch 路径被改写为 `E_PULL_FAILED`** — `src/sync/cycle.ts:1014-1018`：`catch { return failure(V2_ERROR.PULL_FAILED, '拉取远端失败：'+typedError(error), ...) }` 不区分 `E_` 码。`E_ASKPASS_NODE_MISSING` 若由 `git.fetchMain()` 抛出，被归为拉取失败（`typedError` 只取 `error.message`，连 `E_` 码都不带出）。`gitPort.ts:242` 的 typed 守卫只覆盖 `pushMain`。真实无 node 场景里 `git.branchName()` (`cycle.ts:1000`) 会先抛 typed 且无 catch → 原始异常逃出周期、outbox 停在 `syncing` 而不停放 attempt。**fix**：在 fetch catch 与 stage-0 读操作中复用 `:1151-1161` 的 `E_` 保留模式，或统一包一层 typed 透传；并为 fetch 抛 typed 的情形补一条 cycle 测试。
4. **[P1] 探针与实际 askpass 子进程的 env 不一致（可能复现原故障）** — 探针在 `nodePath.ts:162-166` 删 `NODE_OPTIONS`/`NODE_PATH`；真正的 askpass 环境由 `git.ts:95-100` 从 `process.env` 构造，**不删这两项**。若锁定环境用 `NODE_OPTIONS=--require ...` 且该 hook 在 node 下启动失败，探针会 PASS 而 `askpass.mjs` 无法输出凭据 → git again 报 `auth-prompt`，正是本模块要修的症状。**fix**：让 `gitAuthEnv()` 对 askpass 分支同样剔除 `NODE_OPTIONS`/`NODE_PATH`，或让探针使用与实际 askpass 完全相同的 env。
5. **[PASS] push 的 typed 拒绝早于 spawn、不进 auth-prompt** — `gitPort.ts:107-110` `run()` 先 `buildEnv()` 才 `execFile`；`gitPort.ts:242` `if (error instanceof SyncError && error.code === ASKPASS_NODE_MISSING_CODE) throw error` 位于 `:244` `pushFailure()` 之前；`pushFailure` 白名单正文未改。测试 `:267-295` 断言 `gitCalls === 0` 且 message 不含 auth-prompt。
6. **[PASS] cycle 三例** — `cycle.ts:1151-1157` 保留 `E_` 码、`:1154-1155` 的 next-step 点名 `安装 Node.js` / `DSH_GIT_SYNC_NODE`；E_PUSH_REJECTED 文案逐字节不变（旧 `E_PUSH_REJECTED: ${typedError}；下一步：检查远端是否...` 与新串相同，因为 `V2_ERROR.PUSH_REJECTED = 'E_PUSH_REJECTED'`，`cycle.ts:62`）；非 SyncError 降级 E_PUSH_REJECTED。测试 `:354-381` 三例覆盖。
7. **[PASS] token 卫生** — `git.ts:126-133` `ASKPASS_SH` 用 `${DSH_GIT_SYNC_TOKEN:-}`；`:136-142` `ASKPASS_CMD` 仅 `"%DSH_GIT_SYNC_NODE%" "%~dp0askpass.mjs"`，文件无 token；`:152-176` `ASKPASS_MJS` `:156` `const token = process.env.DSH_GIT_SYNC_TOKEN ?? ''`。探针 `:163-164` `delete childEnv.NODE_OPTIONS / NODE_PATH`。测试 `:203-220` 对三个文件与 env 做 token 扫描，只允许 `DSH_GIT_SYNC_TOKEN`。
8. **[P2] 测试只注入探针，未跑真实 `defaultAskpassProbe`** — 全部 `probe: () => true/false`；`spawnSync -e marker`、2 s 超时、`status===0 && stdout.includes(marker)`（`nodePath.ts:156-183`）从不被执行。探针失败测试（`:169-197`）只是注入 false，**不能发现默认探针的 env/标记/超时 bug**。**fix**：至少加一条用真实 `process.execPath` 跑 `defaultAskpassProbe` 的用例（断言 marker 命中、缓存命中）。
9. **[P2] 枚举其它可能的误标入口** — `cycle.ts:900-907`（`recoverPendingLocalCommit` 的 push catch）用 `typedPushReason`：保留 `E_` 码但正文折叠为 `GENERIC_PUSH_REASON`（`:946`），修复指引丢失，终态仍是 `E_LOCAL_PENDING`；`cycle.ts:980-983` `describeAheadOwnership` 与 `:1027-1031` `pendingIsOurs` 的 catch 静默吞掉 typed 错；`src/rpc.ts:280-293` `repoCodeOfError` 不认识 `E_ASKPASS_NODE_MISSING` → RPC 的 fetch/clone 路径不写 repo-error 横幅（错误本身 `:333` 原样抛出）。这些都不是 auth-prompt，但确有 typed 码/指引丢失。**fix**：在 `typedPushReason` 之外为 `E_ASKPASS_NODE_MISSING` 开白名单正文；`repoCodeOfError` 增加该码的 UI 事实。
10. **[P2] 探针可被 hostile PATH 绕过；2 s 超时有理论挂起面** — 探针只验证「打印固定标记」，任何可执行假 `node.exe` 都能 PASS；PATH 若含用户可写目录，攻击者放一个回显标记的 `node.exe`，它会被选为 `DSH_GIT_SYNC_NODE`，其后以 `DSH_GIT_SYNC_TOKEN` 在 env 中启动 → **令牌可被窃取**。`spawnSync` 超时会 SIGTERM 子进程，但若假 node 派生孙子进程持有 stdout，2 s 后仍可能等管道关闭。**fix**：对 `PATH` 候选校验目录不可写 / 只接受 override 与绝对路径，或把标记换成带随机 nonce 的挑战；探针用 `stdio:'ignore'` + 独立管道并设 `killSignal`。

### 证据文件核验（只读，非本评审产出）

- `.tmp/build-plugin-wave-askpass-hints.out` 存在，内容 `[plugin] dist/index.js + dist/client.js 已生成` + `BUILD_EXIT=0` → 「exit 0」成立。
- `.tmp/distfresh-plugin-wave-askpass-hints.out` 存在：`tsc-emitted js files in dist: 76` / `fresh tsc emit js files: 75` / `compare result: <= \client.js|<sha256>` / `dist/client.js === renderClientSource(): true` → 「75 个 tsc JS 逐字节一致、client.js 由 build.mjs 生成且相等」成立（76−75 的唯一差异就是 client.js）。
- `.tmp/gates-plugin-full-askpass.out` 存在：尾部 `ℹ tests 889 / pass 887 / fail 0 / skipped 2` → 预期成立。
- 三项声明均**成立**；本评审未重跑这些门闸，仅核对留存文件。

---

## 未覆盖 / 无法自证

- **unverified — 真实 HTTPS + token 推送**：无真实远端、无真实凭据，未跑 live sync cycle；typed 修复是否让用户的那次推送真正成功无法自证。
- **unverified — 真实 Electron spawn**：测试注入 `electronVersion`，未启动 DSH 应用二进制验证 `ELECTRON_RUN_AS_NODE=1` 真的使其按 node 执行 `askpass.mjs`。
- **unverified — 真实 GUI**：新提示句只在 React 桩中渲染；未刷新 DSH Web GUI 目视确认 select 与提示行随选项刷新。
- **unverified — 默认探针的真实行为**：`spawnSync -e marker` / 2 s / marker 判定从未在测试中真实执行（见 B8）；hostile PATH 与锁定 NODE_OPTIONS 场景只做代码推演（B4/B10）。
- **unverified — 真实 PATH 发现**：`fileExists` 全为注入桩，未在真机文件系统上验证 Windows `PATHEXT`/大小写与 POSIX 精确匹配。

## 断言未删声明

### 模块 A（有 retarget，逐条核对 `git diff`，无删除/放宽）

- `test/pairing-client-wiring.test.mjs` W1：`-  assert.equal(dataText(tree, 'remote-transport').includes('lan'), true, '必须显示自动选中的方式')` → `+ assert.equal(dataText(tree, 'remote-transport'), zh['lean.remote.hint.lan'], ...)`：**收紧**（包含→精确相等）。
- `test/pairing-client-wiring.test.mjs` W9：`-  assert.ok(textOf(mount.tree).includes(zh['lean.remote.transport.none']))` → `+ ...includes(NONE_HINT_ZH)` 且 `+ assert.equal(...includes(OLD_NONE_HINT_ZH), false)`：等价断言 + **新增**反例。
- `test/client-lean-inventory.test.mjs` d1：`-  assert.ok(textOf(nodes).includes(zh['lean.remote.transport.none']))` → 同上，等价 + 新增反例。
- `test/client-remote-render.test.mjs` merged：`-    zh['lean.remote.mode.hint'], '自动选中：lan', // 方式 + 自动选中原因` → `+ zh['lean.remote.mode.hint'], zh['lean.remote.hint.lan']`：行为变更的正当 retarget，断言数量未减少。
- `test/locale.test.mjs`：`-  assert.equal(Object.keys(en).length, 78, ...)` → `+ ... 83 ...`：计数随新增 5 key 上调，未放宽。
- 结论：**无既有断言被删除或放宽**；新增 `test/remote-hints-mode-keyed.test.mjs`（342 行）带来净增 10 例守卫。

### 模块 B（无既有测试改动）

- `git status --short`：模块 B 只新增 `test/askpass-node-resolution.test.mjs`（`??`）、`src/engine/nodePath.ts`（`??`）与 3 个 dist 镜像；`git diff` 对既有测试文件**没有任何 `-` 行**。
- 既有 `test/git-auth-env.test.mjs` / `test/audit-fixes.test.mjs` 未断言旧的 `DSH_GIT_SYNC_NODE = process.execPath` 行为，故无断言被删除/放宽；全量 889/887/0/2 佐证无回归。

---

## 复审（修复后）

只读复核 delta；未改任何源码/测试/配置/dist，未执行 git 写操作，未跑 live sync cycle。以下只谈修复后的新证据，原结论不改写。

### 逐项闭合

| 原发现 | 判定 | 证据 |
| --- | --- | --- |
| B3 P1 fetch/branchName 误标 + 意图卡 `syncing` | **已闭合** | `src/sync/cycle.ts:943-983` 单一 helper 组（`ASKPASS_NODE_NEXT_STEP` / `typedCodeOf` / `gitStageFailure` / `parkTypedFailure`）；三处守卫 `:1042-1052`（branchName）、`:1069-1078`（fetch）、`:1206-1220`（push）。typed 码在三处都原样带出；`parkTypedFailure` 经 `markAttempt`（`:315-318`，state→`pending`/`failed`）+ `outbox.save()`，不会留 `syncing`。测试 `:410-420` / `:422-434` 断言 `state==='pending'`、attempts+1、非 typed fetch 仍为 `E_PULL_FAILED` 且 attempts=0、push 文案逐字节不变（`:373-379`）。 |
| B4 P1 探针 env ≠ askpass env | **已闭合（Windows）** | `src/engine/git.ts:149-150` 的 `askpass.cmd` 在启动 node 前 `set NODE_OPTIONS=` / `set NODE_PATH=`；`src/engine/nodePath.ts:164-177` `sanitizeNodeEnv` + `withElectronFlag`，`:212,216` 注入探针 context，`:189` 默认探针使用之；git 子进程自身保留 `NODE_OPTIONS`（`git.ts:95-100`）。测试 `:440-471` 双向断言。POSIX 的 `askpass.sh`（`git.ts:135-142`）是 `/bin/sh` 脚本、根本不启动 node，故该不变量在 POSIX 上为空真，无需 `.sh` 对应清理。 |
| B8 P2 默认探针从未被真实执行 | **仍存在** | 全部测试仍用注入 `probe`（`:448-450`、`:464-467` 等）；`:440` 只捕获 `context.env`，未验证 `defaultAskpassProbe` 的 `spawnSync -e marker` / 2 s / marker 判定真实跑通。 |
| B9 P2 其它误标入口 | **部分** | 三处主路径已统一；但 `src/sync/cycle.ts:898-908`（`recoverPendingLocalCommit` 的 push catch）仍用第二套 `typedPushReason`（`:1011-1017`），askpass 修复句折叠为 `GENERIC_PUSH_REASON`，终态仍是 `E_LOCAL_PENDING`；`:1025-1027` `describeAheadOwnership`、`:1089-1091` `pendingIsOurs` 仍吞错；`src/rpc.ts:280-293` `repoCodeOfError` 仍不认识该码。 |
| B10 P2 hostile PATH / 2 s 挂起 | **仍存在** | 探针仍只校验「回显固定标记」，`nodePath.ts:190-196` 仍 `spawnSync` + `timeout:2000`；下条新发现使其更严重。 |

### 新发现

- **[NEW P1] 探针子进程拿到真实 token** — `src/engine/git.ts:116` 把含 `DSH_GIT_SYNC_TOKEN` 的构造 env 传给 `resolveAskpassNode`；`src/engine/nodePath.ts:212` 的 `sanitizeNodeEnv` 只删 `NODE_OPTIONS`/`NODE_PATH`，`:216` 把该 env 交给探针，`:189` 默认探针把它作为 `spawnSync` 的 `env`。**实测**（生产同款调用，不注入 `nodePath.env`）：探针 context env 中 `DSH_GIT_SYNC_TOKEN=SUPERSECRET_TOKEN_XYZ` 确实存在。后果：PATH 上任一能回显标记的假 `node.exe` 在**探针阶段**就拿到令牌，不必等到被选为 askpass 解释器；这违背原模块「token 只经 env 到 askpass」的收紧意图。修复：`nodePath.ts:212` 的 `probeEnv` 删除 `DSH_GIT_SYNC_TOKEN`（及任何 `*_TOKEN`/`*_PASSWORD`），探针只需 node 启动相关变量；并在 `:440` 测试里加 `assert.equal(Object.hasOwn(probeEnv,'DSH_GIT_SYNC_TOKEN'), false)`。
- **[NEW P2] 凭据测试的弱断言** — `test/askpass-node-resolution.test.mjs:480-481` 只用正则 `/set NODE_OPTIONS=/` 证明字符串存在（注释行也会通过），未注入一个会让 node 启动失败的 `NODE_OPTIONS` 做端到端反例；`:496-502` 的 `nodeBin` 取自 Windows 路径 `C:\Program Files\nodejs\node.exe`，只在末尾 `if (process.platform === 'win32')`（`:505`）里才跑 `.cmd`，POSIX CI 上前面的 `exec(nodeBin, ...)` 会 ENOENT。另：`:483-489` 只断言 `GIT_CONFIG_*` 四个 env 值，未用真实 git + 已配置 helper 验证中和效果（我已用 `git 2.53.0.windows.2` 实测 env 注入生效：Node 传空值 `GIT_CONFIG_VALUE_0=''` 时 `git config --get-all credential.helper` 输出两条、空 helper 在列；gitcredentials 文档明确空 helper 会 reset helper list）。

### 凭据中和（声称 3）核验

`src/engine/git.ts:107-110` 四个 env 齐备；env 配置走 `GIT_CONFIG_COUNT` 是 git ≥2.31 的正式机制，本地 `git 2.53.0.windows.2` + Node `spawnSync` 实测被接受（PowerShell `$env:` 置空会删变量导致 git 报 `missing config value`，但插件走 Node env，故不受影响）。覆盖范围：`gitAuthEnv` 是唯一 env 构造点，clone/fetch/ls-remote/push 全走它；`git.ts:416` 的 argv `-c credential.helper=` 仍在，双重中和等价无害（空 helper 两次 reset）。**确实会破坏依赖 helper 的合法配置**：凡配置了 token（`usesGitAskpass` 为真）的 HTTPS 仓库，此前用户自己的 GCM/wincred 缓存被一律忽略，强制只用 settings 里的 token；无 token 时不注入中和，helper 仍可用。这是设计选择而非缺陷，但需在交付说明中点名。

### 证据文件与新鲜度（声称 5）核验

三个文件均存在且内容吻合：`build-plugin-wave-askpass-hints.out`（20:53:42）`BUILD_EXIT=0`；`distfresh-plugin-wave-askpass-hints.out`（20:53:45）`76 js in dist / 75 fresh / <= \client.js|2819B… / dist/client.js === renderClientSource(): true`；`gates-plugin-wave-askpass-hints.out`（20:54:58）`tests 894 / pass 892 / fail 0 / skipped 2`（较上次 +5，恰等于新增 5 例）。**构建覆盖当前字节**：plugin `src/**` 最晚 mtime 为 `nodePath.ts` 20:48:45、`git.ts` 20:48:39、`cycle.ts` 20:46:31，均早于 build 20:53:42；`test/askpass-node-resolution.test.mjs` 20:50:46 早于 suite 20:54:58。三项声明成立；这些产物非本评审产出。

## 复审后的可提交判定

- **模块 A `mod-plugin-remote-hints-mode-keyed`：PASS（可提交）** — 本次 delta 未触碰 A 的任何文件（`src/client.js` mtime 仍 20:17:13）；原结论与「断言未删」声明继续有效。
- **模块 B `mod-plugin-askpass-node-resolution`：PASS WITH FINDINGS（可提交，但须先处理 NEW P1）** — 原 P1 两条已闭合，三条主路径 typed 统一、意图不再卡 `syncing`、探针/askpass 的 NODE_OPTIONS 不变量在 Windows 成立；剩余 NEW P1（探针子进程暴露 token，`git.ts:116` / `nodePath.ts:212,216,189`）是凭据卫生回归，建议提交前修复并补断言。B8/B9/B10 作为已知 P2 可随批次记录。真机推送、真实 Electron spawn、真实 GUI 仍 `unverified`。

