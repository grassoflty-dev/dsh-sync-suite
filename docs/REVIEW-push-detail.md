# REVIEW — typedPushError 细节保真修复 + 文档定稿（独立只读评审）

评审对象：HEAD `b5f3ff5` 上未提交批次 6 文件 = A `model/syncCycle.ts` 的 `typedPushError` 修复 + `tools/test/contractGaps.test.mjs`（C12 修正、C14–C16 新增）+  collateral `tools/test/syncWiring.test.mjs` test 7；B `docs/STATE-OF-PROJECT.md` / `docs/MODULES.md` / `docs/ROADMAP.md` 定稿。依据：`项目理解.md`、`docs/REVIEW-contract-tests.md` §3、`docs/DATA-CONTRACT-v2.md` §9（:245 「任何失败必须给类型 + 中文原因 + 下一步」）。2026-11-20。真机 / 第二设备 / DevEco 不可用，端侧一律 `unverified`。本次只读（除本报告外未改仓库文件），逐行审读 + 重跑五道门闸 + 在临时目录复现旧代码行为。

## 1. 结论（P0 / P1 / P2 + 提交判定）

| 批 | 范围 | P0 | P1 | P2 | 判定 |
| --- | --- | --- | --- | --- | --- |
| A | 修复 + 测试 | 0 | 0 | 2 | 可以提交 |
| B | 文档定稿 | 0 | 0 | 1 | 可以提交 |

**总判定：可以提交。** 无 P0/P1；五门全绿；C12/C14 与 syncWiring test 7 经实测在旧代码上确实失败（非空断言）。P2 均为非阻塞观察，不写「已验证」。

## 2. Findings（`file:line`）

- **P2-1（状态行单行截断，A 放大既有约束）**：`pages/Index.ets:1689-1695` 状态行 detail 用 `Text(maxLines(1), Ellipsis)`；追加 detail 后整串变长，真机可能被省略号截断。原文完整保留在 `syncStatusStore` 的 `KEY_REASON`（`syncStatusStore.ets:80`、`snapshot()` :106）与 outbox `lastError`（`syncCycle.ts:446`），非数据丢失；属既有 UI 约束，本批只提高触发概率。
- **P2-2（另一条周期路径仍通用，残留非回归）**：`services/syncProtocolStore.ets:218-230` 的非 wired 旧 `runCycle(ctx)` 终态仍返回通用 `SYNC_RETRY_ERROR`、不带细节。真实 App 在 runner 注入后由 `runCycle` :147-149 进入 `runWiredCycle` → `runCyclePure`，`runConfiguredCycle` :255-257 在 runner 为空时直接返回 `null`，故该路径不进用户状态行。非本批引入。
- **P2-3（文档精度，轻微）**：`STATE-OF-PROJECT.md:3` 称「当前未提交批次仅 `mod-push-detail`（改 3 文件）」，工作树另有本报告涉及的 3 个 docs 改动（模块制视为同批登记，非另一模块）；`docs/MODULES.md:41` `mod-v2-contract-tests` 行仍记「520 行 25 例」（描述已提交 58caeb2 的历史态，当前文件 564 行 28 例，非失实但易混）。提交说明勿把二者写成已提交。
- **信息项（非缺陷）**：`E_AUTH` / `E_IO` 的 `message` 行为不变（C13 绿），但终态 `lastError` 由旧「SYNC_RETRY_ERROR（原文）」改为原始 error 文本（`syncCycle.ts:446`）；这与每次拒推时 `bumpAttempts`（`:434` → `:209-214` → `markAttempt`）写入的原始文本口径一致，诊断更直接。`syncWiring.test.mjs:887` 用 `includes`，无回归。

## 3. 修复追踪（fix trace）

- `syncCycle.ts:153-158`：新增 `TypedPushError {code,message,lastError}` 显式接口（全 string，无 `any` / 对象字面量当类型，ArkTS strict 合规）。
- `:167-179` 三分支：① 非 `E_PUSH_REJECTED` 的 `E_` typed 码（含 `E_AUTH`/`E_IO`）→ `message = ${SYNC_RETRY_ERROR}（原文）`、`lastError = 原文`，**行为不变**；② `E_PUSH_REJECTED` 且码后有非空文本 → 同款逐字保真；③ 裸码 / 非 `E_` 传输错误 → 通用 `SYNC_RETRY_ERROR`（`syncProtocol.ts:136` = `E_PUSH_REJECTED: 推送被拒，意图留在 outbox`，中文原因 + 下一步保留）。`:175` 用 `text.slice(matched[1].length).trim().length > 0` 精确区分带细节与裸码，纯空白后缀亦折叠，正确。
- `:444-455`：终态 outbox `lastError` 写入 `typed.lastError`（原文，含码+细节），返回 `message = typed.message`（中文原因 + 括号细节）。
- 用户可见路径（detail 确实可达状态行）：`:453` → `syncProtocolStore.ets:334-341`（`outcomeToResult` 原样透传 message）→ `:264-301`（`runWiredCycle` 由 `:147-149` 进入）→ `recordWriter.ets:126-135` 与 `pages/Index.ets:283-300`（`syncStatusStore.fromCycle`）→ `syncStatusStore.ets:47-56,78-82,104-111`（`setPending(count, message)` 写 KEY_REASON，`snapshot()` 拼 `最近失败：<message>`）→ `Index.ets:1675-1705` 状态行；pending 态仍有「重试同步」按钮（:1698）与启动文案「上次同步失败，点重试继续」（:413），下一步动作保留。契约 §9:245 三要素（typed 码 / 中文原因 / 下一步）齐全。

## 4. 测试判定（would-fail-on-old 已实测）

- **C12**（`contractGaps.test.mjs:485-508`）：改为注入 detail-bearing `pushError`（:490），断言 `message.includes(detail)`（:497）与 `lastError === detail`（:507）。旧代码 `:497` 恒假 → 真测试。
- **C14**（`:529-540`）：code / message 含 detail / lastError 含 detail → 旧代码两处 `includes` 均假。
- **C15**（`:542-552`）/ **C16**（`:554-564`）：裸码 / 非 `E_` 仍通用中文 → 旧代码亦通过，属回归护栏而非抓虫用例（合理，非弱化）。
- **syncWiring test 7**（`syncWiring.test.mjs:321-330`）：旧断言 `message === SYNC_RETRY_ERROR` 恰好钉住「塌缩」旧行为；FakeGit 实际抛 `E_PUSH_REJECTED: push rejected by test`（:161），故旧断言在语义上已失真。新断言 `includes(detail)` + `startsWith(SYNC_RETRY_ERROR)` 是**正当重定向并加严**（1→2 断言；code/attempts/failed/pending 未动），非弱化。
- 旧代码实测（临时目录、未改仓库）：87 例中 C12、C14、syncWiring-7 三条 `not ok`，错误分别为「typed detail preserved verbatim in user-visible reason」「user-visible reason keeps code + detail」「detail-bearing rejection keeps its raw text in the user-visible reason」；其余 14 条失败为临时副本缺 `.ets` 源文件的静态用例，与逻辑无关。
- 未发现其他被削弱的既有断言：`syncProtocol.test.mjs:449/774` 测 `outboxAfterReplay` 纯函数（默认 lastError 仍 `SYNC_RETRY_ERROR`，未变）；`syncWiring.test.mjs:887` E_AUTH 用 `includes`。

## 5. 文档准确性

- `STATE-OF-PROJECT.md`：`:3` HEAD=b5f3ff5、未提交批次口径正确；模块表 25 个哈希 `git cat-file -t` **25/25 命中**（含 58caeb2 / 2a475e0 / b5f3ff5）；§4 未证段（:57）与 §5 未验证清单（:65）已回填「25 例 + C12/C14–C16 只跑 Node 纯模型、真机状态行 typed 详情仍 unverified」，诚实无 overclaim；§6 停止点行 present（:76）。
- `MODULES.md`：§1 新增 `mod-push-detail` 行（已交付待提交 / hash「Lead 填」/ 独立叶子）、§1.1 依赖图注（:60）、§4 基线 2774/2773/0/1 与 +3/+25 增量链、§5 两行、§6 待提交行，与 STATE / ROADMAP 同口径。
- `ROADMAP.md:555` 基线 **2774 例 / 2773 pass / 0 fail / 1 skip** 与实测全量完全一致；:602 列 `mod-push-detail` 待提交 + 停止点。
- 无 scope drift：`git diff --name-only` 仅 6 文件（1 个 `model/*.ts` + 2 个 `.mjs` + 3 个 `.md`），无 `.ets` / UI 改动，暂存区空、无新增未跟踪；tsc 0 即 ArkTS-strict  hygiene 证据。

## 6. 门闸 tail（复现，逐字）

```
# node apps/arkui-schedule/tools/overlay.mjs status
覆盖层：未应用（工作区为「共享源码 + 平台目录」的原始形态）
[overlay] applied=false            (OVERLAY_EXIT=0)
# node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
TSC_EXIT=0
# node --test apps/arkui-schedule/tools/test/contractGaps.test.mjs apps/arkui-schedule/tools/test/syncWiring.test.mjs
ℹ tests 87 / suites 0 / pass 87 / fail 0 / cancelled 0 / skipped 0 / todo 0 / duration_ms 159.3303
# node --test "packages/dsh-dots/test/*.test.mjs" "apps/arkui-schedule/tools/test/*.test.mjs"
ℹ tests 2774 / suites 320 / pass 2773 / fail 0 / cancelled 0 / skipped 1 / todo 0 / duration_ms 28859.3542
# node apps/arkui-schedule/tools/validate-app.mjs
✅ 全部通过：8/8 条规则（JSON5/JSON 70 个、相对 import 424 条、main 静态 import 545 条、页面 7 个、rawfile/git 2 个文件）
```

全量 **2774 / 2773 pass / 0 fail / 1 skip**、validate **8/8**、tsc **0**、overlay **false**，全部符合预期；相对 2771 的 +3 恰等于 C14/C15/C16，无静默删用例。

## 7. unverified

真机 / 第二设备 / DevEco；`E_PUSH_REJECTED` 细节在真机状态行的实际呈现（P2-1 单行截断是否影响可读性未测）；服务级导入 IO；插件 live RPC（需 DSH 重启）；非 wired 旧周期路径（P2-2）的细节展示；本报告 P2-1 / P2-2 / P2-3 与「信息项」不得在提交说明中写成「已验证」。
