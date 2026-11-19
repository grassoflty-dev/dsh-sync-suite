# REVIEW — 契约缺口测试与项目现状一页纸（独立只读评审）

评审对象：HEAD `c41c3c5` 上两批未提交改动 — A `apps/arkui-schedule/tools/test/contractGaps.test.mjs`（520 行 / 25 例），B `docs/STATE-OF-PROJECT.md`（70 行）+ `docs/MODULES.md` / `docs/ROADMAP.md` 登记。依据：`项目理解.md`、`docs/REVIEW-three-batches.md`、`docs/DATA-CONTRACT-v2.md` §4–§11、`docs/VERIFICATION.md` §14。2026-11-20。真机 / 第二设备 / DevEco 不可用，端侧一律 `unverified`。本次只读（除本报告外未改仓库文件），逐行审读并重跑全部五道门闸，未采信批次摘要。

## 1. 批处理结论（P0 / P1 / P2 + blocking）

| 批 | 范围 | P0 | P1 | P2 | blocking | 判定 |
| --- | --- | --- | --- | --- | --- | --- |
| A | 新增契约缺口测试 25 例 | 0 | 1 | 3 | 仅 P1-1 流程项 | 条件可以提交：Lead 提交前补三处登记即转为可以提交；代码 / 测试无 P0/P1 |
| B | 一页纸 + MODULES §1/§5 + ROADMAP 登记 | 0 | 0 | 2 | 无 | 可以提交（建议先修 P2-B1 / P2-B2 两处文档失实） |

无 P0。P1-1 是模块制流程缺口而非运行风险：`MODULES.md` §0.5 明定「没有登记进来的模块，视同没有交付」，本次 diff 只登记了 B 的 `mod-state-summary`，A 的 `mod-v2-contract-tests` 三处索引均无登记。

## 2. Findings（`file:line`）

- **P1-1（登记缺口，A）**：`contractGaps.test.mjs:1` 声明 `mod-v2-contract-tests`，但 `docs/MODULES.md` §1（`:40` 前）、§5（`:129` 前）与 `docs/ROADMAP.md`（`:600` 后）都没有该 id / 行；补 id、目的、状态、哈希占位「（Lead 填）」、回滚「删除新增文件」即可闭合。
- **P2-A1（钉内部）**：`contractGaps.test.mjs:329-335`（B3）以源码字符串 `SERVICE.includes('this.appendDedupLines(')` / `'this.conflictKey(line)'` / `'row.dedupeKey'` 断言服务实现，钉住方法名而非行为。`.ets` 无法在 Node 跑，属可接受次优，但提交说明不得写成「行为已证」。
- **P2-A2（空断言）**：`:189-190` 的 `forcePush()` 不在 `GitPort` 接口（`:65-82`），`:500` 的 `forcePushCalls===0` 只能证明假端口没被调用，不能证明交付代码无 force-push；真凭据是静态评审 + 契约 §9 P1-6。
- **P2-A3（错误消息形状）**：`:400` 断言 `error.message.includes('media[')`；契约 §5:110 只要求「校验失败并计数」，子串属内部格式，不影响契约成立。
- **P2-B1（工作树失实）**：`STATE-OF-PROJECT.md:3` 称 `git status --porcelain` 无输出 / 工作树干净；评审时实测 2 modified + 2 untracked（该文档自身即 untracked）。应改写为「本批为工作区未提交改动」。
- **P2-B2（清单过时）**：`STATE-OF-PROJECT.md:54` 把 `R<D`、summary newer-wins、完成耗时、`maxAttempts` 耗尽、未知 schema 零写入、push 连续拒 4 次列为「无测试」；若 A 同时提交，C1 / C5–C9 / C10–C12 已覆盖这些（媒体链路仅 A1–A8 测纯模型，服务级 IO 仍只有源码断言）。须按提交后状态回填。
- **继承项（非本批新增）**：`MODULES.md:39` §1 仍记 `RUNBOOK.md`「6 节 126 行」，实测 220 行（同文件 §5:128 已写 220）；前次评审 P2-C1 未回填。

**测试质量总评**：25 例锚定契约（typed 码、`verified=[]`、零写入、dedupe 键、账本 `R>D`、`maxAttempts=4`、无 force-push），不是实现 incidental（仅上述 B3 / C12 / C4 三处轻微钉内部）。替身忠实：`rec()` / `upsert()` / `dt()` / `mediaIo()` 只是夹具，`recordingWrite()`（`:193-199`）明确**不**做去重，`OkPort`（`:162-191`）只实现 `GitPort`；B1–B4 的 dedupe 由交付的 `unionDay` / `runCyclePure` 完成，**未**重实现被测逻辑，正面闭合前次 P2-B1。

## 3. 缺陷判定：`typedPushError()` 丢细节（LOW / P2）

- 报告属实：`syncCycle.ts:157-163`。`:158` 正则 `^(E_[A-Z_]+)` 命中 `E_PUSH_REJECTED`，但 `:159` 显式把它排除，落入 `:162` 返回 `{code:'E_PUSH_REJECTED', message: SYNC_RETRY_ERROR}`；于是 `E_PUSH_REJECTED: non-fast-forward; 远端多 3 个提交` 的附加原因被丢弃，而 `E_AUTH` / `E_IO` 走 `:160` 保留原文（`SYNC_RETRY_ERROR` 定义于 `syncProtocol.ts:136`）。
- 契约最低要求**仍满足**：typed 码 `E_PUSH_REJECTED` ✓；中文原因「推送被拒，意图留在 outbox」✓；下一步 ✓（`Index.ets:413/1698`「上次同步失败，点重试继续」+「重试同步」按钮，`outboxStore.ets:75-86` 为唯一手动复位入口）；原始细节另在 `lastError` 留存（`syncCycle.ts:418` → `markAttempt`）。交付服务 `syncProtocolStore.ets:226` 本就是同一常量，无回退。
- 测试缺口：`C12`（`:485-505`）把 `pushError` 设为 `SYNC_RETRY_ERROR` 本身，`:494` 的「逐字保真」恒真，抓不到本缺陷；`C13` 只覆盖 `E_AUTH` 分支。
- 判定：**P2（LOW），提交前不必修**。建议 follow-up：`:159` 只对「裸码」折叠（附加文本时返回 `` `${SYNC_RETRY_ERROR}（${text}）` ``），并补一条 `E_PUSH_REJECTED: ...extra` 的 C14。

## 4. STATE-OF-PROJECT.md 准确性表

| 项 | 证据 | 结论 |
| --- | --- | --- |
| 模块表 22 个哈希（`:15-37`） | `git cat-file -e <hash>^{commit}` 22/22 命中（含 `4176654`/`ff1560f`/`2f32752` 与 `c41c3c5`） | 一致 |
| 回滚链 / 顺序（`:39-40`） | `MODULES.md` §1/§1.1：D5 逆序、dual-write-off 在 sync-wiring 之后、export-import 最右端先回 | 一致 |
| `:40`「个别行仍标待提交但哈希已入 log」 | 实测属实，属登记滞后而非未提交 | 诚实 |
| §4「保证」括号证据强度 | 代码 + 双端模拟 / 纯逻辑 / 规范已定分别标注，未冒充真机 | 诚实 |
| §4「不保证」 | 与 §14.8 STILL UNVERIFIED、`REVIEW-three-batches.md` P2-3 / P2-B3 同口径 | 一致（`:54` 无测试清单已过时，见 P2-B2） |
| §5 未验证清单 | `:58-62` 逐条对应 §14.6 / §14.7 / §14.8；`:62` 明确不宣称设备验证 | 一致 |
| §6 下一步 | 与 `项目理解.md` §4 待办、评审 P2-3 一致 | 一致 |
| `:3` 工作树干净 | 实测 2 M + 2 ?? | **失实（P2-B1）** |

## 5. 门闸 tail（复现，逐字）

```
# node apps/arkui-schedule/tools/overlay.mjs status
覆盖层：未应用（工作区为「共享源码 + 平台目录」的原始形态）
[overlay] applied=false            (OVERLAY_EXIT=0)
# node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
TSC_EXIT=0
# node --test apps/arkui-schedule/tools/test/contractGaps.test.mjs
ℹ tests 25 / suites 0 / pass 25 / fail 0 / cancelled 0 / skipped 0 / todo 0 / duration_ms 122.2385
# node --test "packages/dsh-dots/test/*.test.mjs" "apps/arkui-schedule/tools/test/*.test.mjs"
ℹ tests 2771 / suites 320 / pass 2770 / fail 0 / cancelled 0 / skipped 1 / todo 0 / duration_ms 27358.3359
# node apps/arkui-schedule/tools/validate-app.mjs
✅ 全部通过：8/8 条规则（JSON5/JSON 70 个、相对 import 424 条、main 静态 import 545 条、页面 7 个、rawfile/git 2 个文件）
```

25/25、全量 **2771 / 2770 pass / 0 fail / 1 skip**、validate **8/8**、tsc **0**、overlay **false**，全部符合预期；相对前次 2746 的 +25 恰等于本批 25 例，无静默删用例。

## 6. 无交付代码变更 / unverified

`git diff --name-only` 仅 `docs/MODULES.md`、`docs/ROADMAP.md`；`git ls-files --others --exclude-standard` 仅 `contractGaps.test.mjs`、`STATE-OF-PROJECT.md`；暂存区空。无 `.ets` / `model/` 改动（Check 3 通过；测试读 `syncProtocolStore.ets` 只做源码字符串，不修改）。

必须保持 `unverified`：真机 / 第二设备 / DevEco；服务级导入 IO（A1–A8 只测纯模型，预检早于写入仍靠源码审阅）；双端真实 git 并发 / fetch 耗时 / 仓库体积；设备激活弹层 / 真实 push / outbox 全链路 / PersistentStorage 重启；插件 live RPC（§14.7 HTTP 405，需重启 DSH）；`媒体待迁移` 渲染占位（C3 只证读路径不崩）；前次 P2-3 bundle 账本完整性；本报告 P1-1 / P2-A1–A3 / P2-B1–B2 不得在提交说明中写成「已验证」。
