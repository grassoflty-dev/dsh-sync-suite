# B4 收窄（去除改期）独立只读评审

评审对象：`14b181a`（B4 批）之上的未提交收窄 diff（6 个路径 = 2 改 + 2 删 + 2 新增）。
评审方式：只读；不信任任何执行方报告，自行 grep / 读全文 / 重跑四项门禁。
唯一写入文件：本文件。

---

## 1 结论

**P0 = 0，P1 = 0，P2 = 3（均为收窄前既有、随收窄继承的限制）。不阻塞，可以提交。**

核心判断：这次收窄不是“把改期藏起来”，而是把整套机制从源码、测试、纯逻辑层一并删除，并在两个层面同时钉死新契约——
UI 层 `dateEditable()` 单点门控让已有记录日期行只读；逻辑层 `resolveSaveTs()` 对已有记录**故意忽略** `chosenDate`，
只返回 `nextTsSameDate(originalTs, now)`。即便将来 `formDate` 被别的路径污染，已有记录也不可能换日片（纵深防御）。
四项门禁全部复现：新基线 **2306 / 2305 pass / 0 fail / 1 skip**，`validate-app` **8/8**，`tsc` exit 0，`overlay applied=false`。
`docs/DATA-CONTRACT.md` 与 HEAD 逐字节相同，删除/撤销语义零改动。

三条 P2 都不是本次 diff 引入的回归，逐条列在下面供 Designer 登记，不要求本批修。

---

## 2 Findings

### P2-1（继承，非本批引入）年份 0001–0099 的新建日期会被拒绝，与日历可选范围不一致

- **file:line**：`apps/arkui-schedule/entry/src/main/ets/model/recordSaveTs.ts:31-43`
- **代码**：
  ```ts
  const probe = new Date(year, month - 1, day);
  return probe.getFullYear() === year && probe.getMonth() === month - 1 && probe.getDate() === day;
  ```
- **影响**：JS 的 `new Date(1, 0, 1)` 落在 1901 年，因此 `0001-01-01`～`0099-12-31` 一律被 `isValidDateKey` 判为非法；
  而 `CalendarPicker` 月网格可以翻到这些年并点出该日键。用户为**新建**记录选这些日期时会在 `save()` 收到
  「日期不合法：请为新建记录选择有效日期」而零写入。收窄前 `REVIEW-b4-batch.md` 的 P2-1 已记录，判定函数迁移后仍适用；
  已有记录不受影响（日期由原 ts 决定，`chosenDate` 不参与）。
- **具体修法**：`isValidDateKey` 改为纯整数日历校验（复用 `model/calendar.ts` 的 `parseDateKey`），并把 `CalendarPicker`
  可点范围 / `pages/Index.ets` 的 `pickDate` 与该校验对齐；补 `0001-01-01` / `0099-12-31` / `10000-01-07` 边界用例。
  属独立小批，不建议塞进收窄提交。

### P2-2（继承，非本批引入）非今日新建日期沿用 `now` 的 DST 偏移

- **file:line**：`apps/arkui-schedule/entry/src/main/ets/model/recordSaveTs.ts:57-62`
- **代码**：
  ```ts
  return `${dateKey}${nowIso(clockOf(now)).slice(10)}`;
  ```
- **影响**：为过去/未来某天新建记录时，ts 的日期前缀是所选日、时刻与 UTC 偏移却来自当前时刻；跨夏令时那天的记录其
  绝对时刻会偏一小时。分片键（`recordDateKey(ts)` 取前 10 字符）仍正确，同日内的版本序也不受影响，故不阻塞；
  但“字节形状与 `nowIso` 相同”这一不变式掩盖了语义上的偏移错配。
- **具体修法**：若要把“所选日期的本地时刻”当真，需要为 `dateKey` 单独求偏移；这会改变 ts 生成语义，
  必须先由 Designer 确认 `DATA-CONTRACT.md` §3 是否需要勘误。当前维持既有行为即可。

### P2-3（继承，非本批引入）UI 接线仍是源码文本断言，ArkTS 运行时未覆盖

- **file:line**：`apps/arkui-schedule/tools/test/b4DateUi.test.mjs:135-336`（以及 `b4CalendarWiring.test.mjs`，本次未改）
- **代码**：
  ```js
  assert.match(DATE_ON_CLICK, /if \(!this\.dateEditable\(\)\) \{\s*return;\s*\}/);
  assert.match(BUILD, /if \(this\.dateEditable\(\) && this\.showDatePicker\) \{\s*CalendarPicker\(\{/);
  ```
- **影响**：这些断言只证明 `.ets` **源文本**形状正确；若 ArkUI 运行时对 `if` 包裹的 `@Builder` 子节点有不同渲染行为，
  或 `dateEditable()` 的响应式依赖未按预期刷新，测试不会发现。本机无 DevEco / HarmonyOS SDK，无法编译或真机验证。
- **具体修法**：保留文本断言作回归网；真机可用时补一条“编辑已有记录 → 日期行不可展开、保存后日片不变”的端到端用例。
  不要把静态断言当作运行时证明。

---

## 3 删除面是否干净（专节）

**结论：干净。应用源码中零残留；被删模块的消费者全部消失；`softDeleteRecord` 只剩真实删除功能在用。**

- 已跟踪的删除文件在磁盘上确认不存在：`model/recordDateMove.ts`、`tools/test/b4DateMove.test.mjs`（`Test-Path` 均为 false）。
- 对整个 `apps/arkui-schedule/entry/src/main/ets` grep
  `planDateMove|DateMovePlan|needsTombstone|tombstoneTs|cleanupNote|softDeleteRecord|dateChanged|dateMoveHint|originalRecord|日期改为|recordDateMove`：
  只命中 **3 行**，全部是合法保留：
  - `pages/Index.ets:52` — `import { … softDeleteRecord … } from '../model/undoDelete'`
  - `pages/Index.ets:840` — `const tombstone: ScheduleRecord = softDeleteRecord(target, nextTsSameDate(target.ts));`
  - `model/undoDelete.ts:106` — `export function softDeleteRecord(...)` 定义
  即：`softDeleteRecord` 仍**仅**服务于真实软删除（以及 `undoDelete.test.mjs` / `query.test.mjs` 的既有测试），
  保存链路已彻底不碰它。`b4DateUi.test.mjs:281` 还反向钉死 `EDITOR.includes('softDeleteRecord') === false`。
- 其余被点名 token（`planDateMove` / `DateMovePlan` / `needsTombstone` / `tombstoneTs` / `cleanupNote` /
  `dateChanged` / `dateMoveHint` / `originalRecord` / `日期改为`）在 `.ets` 中**零命中**；
  `b4DateUi.test.mjs:313-327` 的 B4-27 把这些 token 逐条钉为“不得出现在编辑器源码”。
- `RecordEditorView.ets` 的 import 已换成 `resolveSaveTs` / `SaveTsPlan`（`:26-27`），
  `save()` 正文不再有 `originalRecord` 快照、`needsTombstone` 块、`cleanupNote` 双 toast 分支或 `plan.date`。
- `git grep recordDateMove` 的残留全部落在**明确标为历史/对齐说明**的文档段落：
  `REVIEW-b4-batch.md`（§0–§9 原文保留，§10「对齐说明」声明旧机制已删、P2-3/4/5 转 N/A）、
  `ROADMAP.md:497`「B4 批已提交清单（已随提交 `14b181a` 入库，保留便于查历史；随后又被收窄，见下一节）」、
  `UX-STEPS.md:485-486`（明写跨日迁移/旧日墓碑/拒绝文案已全部删除）。
  这些不是“当前行为”的断言，不构成与代码的矛盾。文档由另一代理并发编辑，评审快照下已自洽（见 §6 unverified）。
- `docs/DATA-CONTRACT.md` 与 HEAD 完全一致（`git diff --quiet` exit 0）；无数据格式改动，删除/撤销语义未动。

---

## 4 收窄后的行为是否只剩两件事（专节）

**是。所有写路径收敛为下面两件事，且第二件在 UI 与纯逻辑双层强制。**

**(1) 新建：日期任选，决定日片。**
`render` 中仅 `recordId.length === 0` 时显示「选择/收起」并允许点行展开 `CalendarPicker`
（`RecordEditorView.ets:843-848`、`:853-858`、`:869-877`）；`resolveSaveTs` 对空白 `originalTs` 走
`tsForDate(chosenDate, clock)`（`recordSaveTs.ts:75-81`），非法日期 `ok:false` 零写入。

**(2) 编辑：日期固定在创建日，只做同日更晚版本。**
- UI 单点门控 `dateEditable()`（`RecordEditorView.ets:436-438`）：
  ```ts
  private dateEditable(): boolean {
    return this.recordId.length === 0;
  }
  ```
  同一个门覆盖三处：提示 `:843`、行点按早退 `:854-856`、日历渲染 `:869`。已有记录在 `:860-867` 显示
  `Text('创建时选定，不可改')`（灰字 `text_secondary`，非 danger）。
- 保存路径：`save()` 在 `:607` 调 `resolveSaveTs(this.originalTs, this.formDate, new Date())`，
  `:608-611` 的 `if (!plan.ok) { … return; }` 位于第一次 `appendRecord`（`:643`）之前，
  `:616` 用 `ts: plan.ts`；成功只弹一条 toast（`:667-668`），一次性 marker 与 `onSaved` 无条件执行（`:671-672`）。
- 纯逻辑二次保险 `recordSaveTs.ts:83-88`：
  ```ts
  if (Number.isNaN(Date.parse(original))) {
    return { ok: false, ts: '', reason: '原记录时间戳无法解析，无法安全保存：请返回列表重试' };
  }
  // chosenDate 故意不参与：已有记录固定在原 ts 的日期，只做同日更晚版本。
  return { ok: true, ts: nextTsSameDate(original, clock), reason: '' };
  ```
  即：即便 `formDate` 被污染，已有记录的 ts 日期仍来自原 ts。
- 无旁路：逐条检查全部 7 处 `appendRecord` 调用——`RecordEditorView.ets:643`（`plan.ts`）、
  `RecordDetailView.ets:189`（`nextTsSameDate(base.ts)`，AI 文本）、
  `Index.ets:743`（完成）、`:840`（软删除墓碑）、`:872`（撤销删除）、`:1017`（AI 结果，保留原 ts）
  ——没有任何一处把已有记录写到别的日片。`maybeAutoSaveAfterInk`（`RecordEditorView.ets:401-423`）只做早退判断后调 `this.save()`；
  `Edit.ets:120-137` 与 `Index.ets:1568-1581` 都只是薄壳传 `recordId/defaultDate`，不传日期、不复制日期逻辑；
  `applyPickedDate` 只被受门控的 `CalendarPicker.onPick` 调用。
- `recordSaveTs.ts` 纯函数性：全文无 `Date.now()`；`clockOf` 对脏 `now` 退化为 `new Date()`；
  `originalTs` 非字符串、`chosenDate` 非字符串、原 ts 不可解析都有兜底；同输入深相等且不改入参（`b4SaveTs.test.mjs:180-199` 两例钉死）。
  `tsc -p tools/tsconfig.json` exit 0。

---

## 5 测试与门禁证据（逐字引用）

### 5.1 四项门禁 tail（本人重跑）

```
===== GATE 1: overlay status =====
覆盖层：未应用（工作区为「共享源码 + 平台目录」的原始形态）
[overlay] applied=false
overlay_exit=0
===== GATE 2: tsc =====
tsc_exit=0
```

```
ℹ tests 2306
ℹ suites 309
ℹ pass 2305
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 29619.0852
test_pipeline_exit=0
```

```
===== GATE 4: validate-app =====
🔍 校验 ArkUI-X 工程：C:\Users\GWL\Desktop\itwillclaude\dsh-sync-suite\apps\arkui-schedule
✅ 全部通过：8/8 条规则（JSON5/JSON 70 个、相对 import 355 条、main 静态 import 448 条、页面 7 个、rawfile/git 2 个文件）
validate_exit=0
```

结论：与新基线 **2306 / 2305 pass / 0 fail / 1 skip**（旧 2309 / 2308 / 0 / 1）逐项相符；`validate-app` 8/8；`tsc` exit 0；
`applied=false`。skip 仍为 1，本次改动的文件中没有任何 `test.skip` / `{ skip: … }` 新增，故未引入新 skip。
`relative import 357→355`、`main 静态 import 450→448` 与删除 `recordDateMove.ts`（2 条 import）+ 编辑器净减 1 条 +
新增 `recordSaveTs.ts`（1 条）的账面一致，无异常。

### 5.2 −3 例的精确归属（实测每文件 `test(` 计数）

| 文件 | HEAD | 工作树 | Δ |
| --- | --- | --- | --- |
| `b4DateMove.test.mjs` | 19 | 0（删） | −19 |
| `b4DateUi.test.mjs` | 25 | 21 | −4 |
| `b4SaveTs.test.mjs` | 0 | 20（增） | +20 |
| **净变化** | | | **−3** |

其余相关文件计数不变：`b3Batch` 19、`b3HandwritingAutoSave` 10、`b4SavedRow` 14、`b4CalendarWiring` 18、
`date` 6、`openIndex` 28、`recordMerge` 19、`recordRoundtrip` 12、`undoDelete` 17、`query` 19。

### 5.3 既有测试是否被削弱

- `git diff --quiet` 对 `b3Batch`、`b3HandwritingAutoSave`、`b4SavedRow`、`b4CalendarWiring`、`date`、
  `openIndex`、`recordMerge`、`recordRoundtrip` 全部返回 0（逐字节等同 HEAD）；**没有任何既有断言被放宽或删除**。
- 唯一被改的既有测试是 `b4DateUi.test.mjs`：删掉的 7 条（B4-13/14/15 墓碑顺序与 cleanupNote、B4-20 更早日期提示、
  B4-23/24/25 墓碑收尾与 marker 门控）**全部只断言被移除的功能**；新增 3 条（B4-26/27/28）改为钉
  「已有记录日期行只读 / 删除概念零残留 / 新建仍可展开日历」。删除**随功能一起删**的测试在此处正当，不是掩盖回归。
- 保留的覆盖确实钉住四件事：
  - 新建选日：`b4SaveTs.test.mjs:92-102`（`ts` 落在所选日片、`recordDateKey` 往返、字段形状）；
  - 同日更新顺序：`b4SaveTs.test.mjs:130-159`（精确等于 `nextTsSameDate`、更早/更晚 `chosenDate` 均不搬日）；
  - fail-closed：`b4SaveTs.test.mjs:112-128`、`:170-178`（非法新日期 / 不可解析原 ts 均 `ok:false` 且零写入）；
  - 只读行：`b4DateUi.test.mjs:297-311`（单一 `dateEditable` 门覆盖提示/点按/渲染 + 「创建时选定，不可改」灰字）。
  - 全部为 `node:assert/strict` 强断言；删除旧测试后没有出现“实现坏了仍通过”的空断言。

---

## 6 `unverified` 清单

1. **ArkTS 编译与真机行为**：本机无 DevEco / HarmonyOS SDK，`.ets` 无法编译；`dateEditable()` 门控的实际渲染、
   `CalendarPicker` 在已有记录下不展开、点行早退的运行时行为均为 `unverified`。`tsc` exit 0 只覆盖纯逻辑层。
2. **唯一 skip 的具体用例名**：只核实 skip 数从 1 到 1 未增长、改动文件中无新增 skip 标记；未通过 reporter 逐条定位其名称
   （旧基线文档记为“既有 fetch 直连用例”），该名称层面的归属为 `unverified`。
3. **并发文档最终态**：`docs/REVIEW-b4-batch.md`、`docs/ROADMAP.md`、`docs/UX-STEPS.md` 由另一代理并发编辑；
   本评审快照下三份文档已把旧改期机制标为历史/已删除且新基线写为 2306/2305/0/1，与代码无重要矛盾。
   提交前请 Designer 复核最终落盘版本，避免收窄说明被后续编辑覆盖（`unverified`）。
4. **跨夏令时 / 年份 0–99 的真实用户体验**：P2-1 / P2-2 为静态推导 + 已有评审结论，未在真机或跨 DST 场景下实测，
   影响面判断为 `unverified`（不影响本批阻塞判定）。
5. **本评审未执行 commit / push、未改 `.git`、profile、`.ps1` 或依赖**；除本文件外无写入（`unverified` 无需，此处仅作范围声明）。

---

（本报告为独立只读评审；结论基于 2026-11-19 评审时的工作树快照。）
