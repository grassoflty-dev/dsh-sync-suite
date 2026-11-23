# Review — mod-app-pairing-qr-scan / mod-tablet-git-bridge-diagnostics

独立只读评审；未修改任何源码 / 测试 / 资源 / 构建文件，未执行 git 写操作、hdc、live sync。
证据文件只读取、非本人产出：`.tmp/gates-tablet-git-bridge-diagnostics.out`、
`.tmp/tsc-tablet-git-bridge-diagnostics.out`、`.tmp/validate-tablet-git-bridge-diagnostics.out`、
`apps/arkui-schedule/.build-logs/*.log`。

## 结论

| 模块 | 判定 | 摘要 |
| --- | --- | --- |
| A `mod-app-pairing-qr-scan` | **PASS WITH FINDINGS** | 单一解析器 + 单一写路径成立，粘贴零改动，零配置；1 个 P2（disposed 后仍可能落表）。 |
| B `mod-tablet-git-bridge-diagnostics` | **PASS WITH FINDINGS** | `oid→theirs` 根因由 diff 与复现测试双向证明；E_BRIDGE 边界/文案门禁成立；1 个 P1（模块级 ArkTS 编译证据尚未产生）+ 3 个 P2。 |

P0 0 / P1 1 / P2 4；无删除或放宽的既有断言。

## A 检查清单

1. **【PASS】同一解析器 / 同一写路径**：`apps/arkui-schedule/entry/src/main/ets/model/pairingScan.ts:13` 仅
   `import { parsePairingPayload }`；`:124-133` 返回 `code: parsed.code, reason: parsed.reason` 逐字透传，零字段级复核。
   UI 侧 `InstancesPane.ets:512-522` 把 `scanned.text` 塞回粘贴框后调用既有 `addByPairing()`（`:469-495`），
   后者仍是 `instanceStore.addByPairing()` → `addPairedInstanceWithProbe()`（`instanceStore.ets:147-152`），
   内部第二次调用同一个 `parsePairingPayload`（`pairingPayload.ts:632`）+ 探活 + TOFU 落表。无第二条写路径。
2. **【PASS】纯归一 + 测试**：`pairingScan.ts:59-118` 为无副作用纯函数；`pairingScan.test.mjs:47-108` 覆盖 S1 干净串、
   S2 首尾空白、S3 串内 CRLF/TAB、S4 BOM+零宽（U+200B–U+200D/U+FEFF）、S5 一次 URL 解码、S6 query(p/payload/text)
   与 fragment、S9 坏 % 转义不抛、S8 空串/非字符串拒绝；S1–S6 还断言 `parsePairingPayload(r.text).ok`。
3. **【PASS】typed 拒绝逐字同源、无手抄文案**：`pairingScan.test.mjs:75-88`（S7）断言
   `direct.reason === P.parsePairingPayload('https://example.com').reason`（含 URL 包装变体），`:90-108`（S8/S9）
   同样同码同文案；`:130-142`（D1）守卫源码不含 `不认识的配对串格式` / `配对载荷不能为空` 等副本。
   `pairingScan.ts:31-37` 唯一新增文案是扫码 API 自身的 `E_PAIRING_SCAN_UNAVAILABLE`，与载荷解析无关。
4. **【PASS】粘贴一等公民、附加式**：`InstancesPane.ets` diff（20:17:16 版本）只有 import、`scanPairing()`、
   注释和 `PairingPanel` 里新增的 `ActionButton`；`TextInput` 的 `onChange`（`:930-937`）与「添加实例」
   `onTap: addByPairing()`（`:959-970`）一字未改，扫码按钮（`:939-950`）不设任何必填关系。
5. **【PASS】零配置 / 权限**：`git status --short -- module.json5 build-profile.json5 entry/build-profile.json5`
   无输出，三文件未改；`module.json5:37-47` 无相机权限。SDK 声明
   `D:\A-DevEco\DevEco Studio\sdk\default\hms\ets\api\@hms.core.scan.scanBarcode.d.ts:11-15` 明文写明默认扫码 UI
   「system-level camera permission has been pre-granted … you do not need to request the camera permission again」；
   所用 Promise 重载 `startScanForResult(context, options?)` 见该文件 `:345`（since 4.1.0(11)，本工程
   `build-profile.json5:15-16` 为 SDK 26.0.0）；`scanCore.d.ts:140` QR_CODE=11、`:226` SCAN_SERVICE_CANCELED=1000500002（since 12）均存在。
6. **【PASS（静态）/ unverified（真机）】ArkTS 风险**：`{ scanTypes: [scanCore.ScanType.QR_CODE] }` 由 `ScanOptions.scanTypes?: Array<scanCore.ScanType>`
   上下文定型（`scanBarcode.d.ts:34-58`）；`(error as BusinessError).code` 来自 `@kit.BasicServicesKit`（`InstancesPane.ets:31,525`）。
   `pairingBusy` 交接（`:503-522`）：入口先查 busy 再同步置 true，第一次 `await` 在扫码 API；规范串成功后
   `:521` 清标志、`:522` 调用 `addByPairing()`，二者之间**无 await / 无 yield**，JS 单线程下不存在双发窗口；
   `ActionButton.busy` 同时挡视觉重复点击；两条 `finally`（`:490-494`、`:532-536`）覆盖成功/失败/取消/提前 return。
   构建日志 `build-20261123-202021.log`（源码 20:16–20:17早于该次构建）显示 `CompileArkTS` Finished + `BUILD SUCCESSFUL`，
   静态编译通过；真机双发与扫码 UI 行为仍 `unverified`。
7. **【PASS】保密**：`result.originalValue` 只作为 `normaliseScannedPairing()` 入参（`InstancesPane.ets:512`），
   不进 state/log/toast；只保留规范串 `scanned.text`（`:520`）与解析器固定 `scanned.reason`（`:516`）；
   API 失败仅 `scanUnavailableResult().reason`（`:529`），用户取消不写任何文案（`:528`）。无 `console/hilog`。

- **A-P2-1 `InstancesPane.ets:520-522` / `:491-494`｜disposed 后仍可能写表**：扫码期间页面销毁时，
  `finally` 因 `this.disposed` 为 true 不再复位 busy，但 `:520-522` 已无条件 set state 并继续 `addByPairing()`，
  导出配对成功后会对已销毁组件落一条实例并 toast。证据：`:153-155` 只在 `aboutToDisappear` 置 disposed，
  但成功分支未检查该标志。**修复**：在 `:514` 前加 `if (this.disposed) { return; }`，并在设置 `pairingText`
  之前再查一次 disposed；`finally` 无条件清零 busy（组件已销毁，清零无副作用）。

## B 检查清单

1. **【PASS】修复恰好是 `theirs`**：`git-bridge.js:2490-2502` 现为
   `git.merge({ fs, dir, theirs: target, fastForwardOnly: true, author })`；diff 显示唯一变更
   `- oid: target` / `+ theirs: target`。全文件 `merge(` 仅此 1 处；其余 `fastForwardOnly` 在
   `git.pull()`（`:1866-1875`、`:1925-1934`、`:2113-2122`）中语义不同，`oid:` 仅见于 `git.readBlob`（`:2457`）
   与 pull 结果字段（`:1884`），无遗留 `merge({oid})`。测试 `gitBridgeDiagnostics.test.mjs:188-193` 源码级双向断言。
2. **【PASS】E_BRIDGE 边界 / 脱敏 / 栈隔离**：`git-bridge.js:2811-2851` 的 `call()` 对所有 `OP_HANDLERS` 命令
   统一经同步 try/catch + Promise reject handler + 队列外层 try/catch 三道 `toBridgeFailure`（`:2795-2805`，
   内部再兜底为固定文案）；`emitResult()`（`:460-477`）用 `sanitizeMessage()`（`:324-333`，600 字 + 凭据打码）
   清洗 message，栈经 `sanitizeStack()`（`:341-344`，1200 字）且**仅当 code===E_BRIDGE** 附加到 `error.stack`；
   `onHttpResult()`（`:1294-1324`）单独入口也只 reject typed `E_HTTP`。`call()` 恒无返回值（test `:128` 断言）。
3. **【PASS】ArkTS 映射不吞 typed 错**：`GitSyncService.ets:1437-1449` 的 `failureOf()` 仅当 `code==='E_BRIDGE'`
   才写 `bridgeDiagnostic`（`redactSecrets` + 折空白 + 截断 300，`:1439-1445`）并返回固定中文 `E_BRIDGE_USER_MESSAGE`；
   其它 code 原样透传 `rawMessage`（`:1448`），故 `E_GIT`/`E_AUTH` 等不被吞。两处调用点（`:921`、`:1475`）均改走
   `failureOf()`；`status()` 的 `result.message` 恒为 `syncedTextNow()`（`:1319`），raw 只拼进 `diagnostics`
   （`:1310-1312`，带 `｜桥诊断：` 前缀）。`failed()`（`:499-505`）对 E_BRIDGE 也只拿到固定中文。
   UI 侧 `SyncSection.ets:198-205` 的「为什么」只吃 `GitSyncResult.message`/分类文案，诊断走 `formatDiagnostics`。
4. **【PASS（6/7 直接测试）】护栏**：`asArray/shasFromLog/changedFromStatusMatrix/daysFromListFiles/pathsFromJson/
   commitsToReports` 全部对 undefined/null/错型退空值（`git-bridge.js:336-338,598-662`），
   `mapCommit`（`:568-578`）对 null 项也防御；test `:256-304` 六个 test 逐一覆盖 BAD 形状。
   `sanitizeStack` 实现正确且已导出（`:2902`），但**无直接测试**（见 B-P2-2）。
5. **【PASS】复现测试 hermetic**：`gitBridgeDiagnostics.test.mjs:51-93` 在 `REPO_ROOT/.tmp/` 下建 bare remote + seed +
   tablet/other 两 clone，远端推进 3 提交、tablet 写 11 处未提交文件并 `fetch` 跟踪引用；
   `:145-161` 直接调 `git.merge({oid: target, fastForwardOnly:true})` 断言 `error.name==='TypeError'` 且
   message 匹配 `Cannot read properties of undefined (reading 'length')`；`:163-186` 走薄桥 `fastForward→listDays→
   addCommit→status` 全绿且 `changedCount===0`。HTTP 假实现固定 404、repoUrl 为 invalid.example，无网络/无 live repo；
   `after()`（`:35-39`）清理临时目录。
6. **【PASS（源码层）】双方都移动**：
   (b) `syncCycle.ts:669-686` 先 `gateOf()` 再判 relation；`syncProtocol.ts:98-109` 明定 ahead/diverged ⇒ `E_NOT_SYNCED`，
       `assertWritable` 失败时 `gateFailure()` 零写入（`:389-398`），分叉**不会**进 merge。
   (a) 仅 `relation==='behind'` 调 `fastForward()`（`:674-686`）；成功后 `writeDay` union 本地+远端并
       `addPaths(changedPaths)` + commit（`:710-782`），本地未提交改动被并进去；快进抛错即 typed `E_NOT_SYNCED`
       且不进 union/commit（`:678-681`）。重叠工作区改动时 isomorphic-git 抛 `CheckoutConflictError`
       （bundled `isomorphic-git.js` 该类文案 "local changes … would be overwritten by checkout"），
       `normalizeError` 映射为 `E_GIT` 冲突文案（`git-bridge.js:394-396`），不会静默覆盖。
       **两条路径本身均未发现数据丢失**：(b) 在任何写之前拒绝；(a) ff-only + 冲突检测 + union 后再提交。
   ⚠ 残留（非本 diff 引入，见 B-P2-3 / 未覆盖）：push 失败时 `syncCycle.ts:800-818` 的 `resetHardOrigin()`
       会丢弃未被 `changedPaths` 覆盖的工作区改动，属既有风险。
7. **【PASS】无断言删除/放宽**：三个 MODIFIED 文件的完整 diff 已逐行核对，`tools/test/*.test.mjs` 两个均为新增文件；
   匹配 `^-\s*(assert\.|test\(|describe\()` 的删除行数为 0（详见「断言未删声明」）。

- **B-P1-1 `apps/arkui-schedule/entry/src/main/ets/services/GitSyncService.ets:1-2771`（模块级编译证据）｜构建证据尚未产生**：
  本模块 diff 触碰 `.ets`，按 `docs/MODULES.md` §0 规则 9 必须有一次覆盖该文件的真实 `CompileArkTS` 绿灯。
  现有留存日志只有 `build-20261123-202021.log`（20:26 结束，源码 20:17 之前）与
  `build-20261123-203732.log`（20:39 结束），而 `GitSyncService.ets` 的 mtime 为 **20:58:29**、
  `git-bridge.js` 为 20:57:04 —— 两份日志都早于本模块源码；`.build-logs/build-20261123-210334.log`
  当前为 **0 字节**（21:03 开始写入，运行中），不能作为证据。故本模块 `.ets` 的编译结论只能标 `unverified`。
  **修复**：等待在跑的构建收口，确认日志含 `CompileArkTS` EXECUTED（非 UP-TO-DATE）+ `BUILD SUCCESSFUL`，
  复制成 `.tmp/build-tablet-git-bridge-diagnostics.out` 后在批次交接逐字引用；否则不得宣称「已编译」。
- **B-P2-2 `gitBridgeDiagnostics.test.mjs:256-304`｜`sanitizeStack` 无直接护栏测试**：该函数已导出
  （`git-bridge.js:2902`）但测试只在 `:220-221` 间接断言 stack 存在，未覆盖 undefined/null/错型/超长截断。
  **修复**：加一个 `test('sanitizeStack', …)`，断言 `sanitizeStack(undefined/null/42)===''`、脱敏与
  `len>MAX_STACK_LENGTH` 时以 `…` 结尾。
- **B-P2-3 `gitBridgeDiagnostics.test.mjs:82-89,163-186`｜重叠工作区冲突未被复现测试覆盖**：本地文件放在
  `timeline/2026-11-1x/local-*.json`，远端改的是 `timeline/2026-11-2x/records.json`，**路径不重叠**；
  测试只证明「非重叠本地改动可 ff 后提交」，没证明「重叠改动 ⇒ typed E_GIT 冲突」。
  **修复**：在 fixture 里让本地也写 `timeline/2026-11-21/records.json`（与远端不同内容），
  断言 `fastForward` 返回 `ok:false, error.code==='E_GIT'` 且工作区文件逐字节不变。
- **B-P2-4 `GitSyncService.ets:668,1310-1312,1445`｜桥诊断粘滞**：`bridgeDiagnostic` 一旦被 E_BRIDGE 写入，
  之后每次 `status()` 都把同一段旧诊断追加到 diagnostics，永不清除（全文件仅在 `:1445` 赋值、`:1310` 读取）。
  **修复**：每次 `callBridge`/`callBridgeJson` 入口或每次 `status()` 末尾清空；或给它加时间戳，只在紧邻的
  下一次诊断中输出，避免陈旧 V8 文案长期误导排查。

## 未覆盖 / 无法自证

- `unverified`：真机扫码 UI、相机权限实际授予、用户取消错误码 1000500002 的行为（无 hdc / 无设备）。静态依据已给出（A-5/A-6）。
- `unverified`：模块 B 的 ArkTS 编译（见 B-P1-1）；`tsc` 只覆盖 `model/` + `common/`，`.tmp/tsc-tablet-git-bridge-diagnostics.out`
  的 `EXITCODE=0` 不能替代 `CompileArkTS`。
- `unverified`：isomorphic-git `merge` 对重叠工作区改动的内部 checkout 冲突分支未在本地复现测试中执行（B-P2-3）；
  只有 `CheckoutConflictError` 定义与 `normalizeError` 映射的源码证据。
- `unverified`：`syncCycle.ts:800-818` push 失败后 `resetHardOrigin()` 是否会丢未纳入 `changedPaths` 的工作区改动
  （既有模块，非本 diff 触碰）；本次未改动、未运行该路径。
- `unverified`：`git-bridge.js:2840-2846` 若 `emitResult` 内 `JSON.stringify` 异常会成为 session.queue 上的未处理 rejection
  （不会以 raw throw 到达 ArkTS，但可能丢事件）；实际桥数据均为 JSON-safe，测试未覆盖。
- 证据文件（只读引用，非本人产出）：gates **3234 tests / 3234 pass / 0 fail / 0 skipped**；
  tsc `EXITCODE=0`；validate **8/8**（JSON5/JSON 70、相对 import 616、main 静态 import 853、页面 12、rawfile/git 2）。
- 越界未评：`packages/**`、`RemoteControl.ets`、`model/{remoteAddress,pageTransport,sslAllowance}.ts`、
  `common/*`、`main_pages.json` 等其它 lane 的文件；`~\.dsh\dots\**`、live sync 未触碰。

## 断言未删声明

对以下 in-scope 文件的 `git diff` 逐行核对，删除行中以 `assert.` / `test(` / `describe(` 开头者为 **0 条**：
`InstancesPane.ets`、`GitSyncService.ets`、`git-bridge.js`、`pairingScan.ts`、`pairingScan.test.mjs`、
`gitBridgeDiagnostics.test.mjs`（后两者及 `pairingScan.ts` 为新增文件，无旧断言可删）。
被替换的旧逻辑（`logShas` 内联循环、`statusMatrix` 内联循环、`listDays` 内联循环、
`new SyncError(code, text)`）均由等价或更强的护栏函数/门禁取代，没有断言被删除或放宽。
