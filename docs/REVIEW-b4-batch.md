# REVIEW b4-batch（2026-11-19，独立只读评审）

> 评审角色：独立只读评审子代理（非作者、非规划者、非执行者），未派生任何子代理。
> cwd = `C:\Users\GWL\Desktop\itwillclaude\dsh-sync-suite`（`main`，HEAD `9fa9277450b9292db09f5209aaabc4a6ca5fe2d7` = `9fa9277`；B4 全部未提交）。
> 先读绑定文档 `C:\Users\GWL\Desktop\itwillclaude\项目理解.md`（英文）全文。
> 评审对象严格限于派活清单：3 个 modified（`RecordEditorView.ets` / `homeRefresh.ts` / `Index.ets`）+ 5 个 untracked
> （`model/recordDateMove.ts`、4 个 `b4*.test.mjs`）。**开始时** `git status --porcelain` 与清单逐字一致，
> 额外文件为 0。评审期间 `docs/UX-STEPS.md` 变为 `M`（+113/-1，新增 §4.4），系规划者并发写入，按 B3 评审先例**明确排除**，
> 不进入本文任何判定；本评审未碰它。`docs/DATA-CONTRACT.md` 与 `b3Batch.test.mjs` 自始至终未改（`git status` 无条目）。
> 本机无 DevEco / 无 HarmonyOS SDK / `hdc` 不在 PATH，`node_modules` 无 ArkUI d.ts。凡 ArkTS 编译、真机键盘/toast/排版/落盘字节结论一律 `unverified`，不写「已验证」。
> 唯一写入文件为本文件；未改任何源码 / 测试 / 既有文档，未 commit / push，未碰 `.git` 写操作 / profile / `.ps1` / 依赖。

---

## 0 结论

- **是否阻塞提交：否（P0 = 0、P1 = 0）**
- **P0 0 条 / P1 0 条 / P2 6 条**（均为边界、跨切面未覆盖项、静态测试脆弱性与真机未验项）
- **一句话核心结论**：D5 的 `ts` 决策集中在纯函数 `planDateMove()`，往下改被 fail-closed 拒绝且不写一行，往后改是「目标日存活版本 + 旧日墓碑」两次普通追加，新版本 `ts` 严格晚于旧版本与墓碑（fail-closed 校验 `tsMillis > originalMillis && tsMillis > tombstoneMillis`），实测 `foldById` 在两种输入顺序下都选到存活版本、`applyRecordToIndex` 忽略较旧的墓碑，不存在「墓碑全局胜出隐藏记录」；D7 用同一个 `CalendarPicker` 替换了首页系统滚轮并保留 `pickDate` 五个动作；P2-1 判据放宽为「同 id 且 `ts` 不早于标记」，纯函数实测正确且 `b3Batch.test.mjs` 一字未动。全量 2309/2308/0/1（比基线 +76 = 4 个新测试的 19+25+14+18），`validate-app` 8/8、`tsc` exit 0。6 条 P2 不阻塞。

---

## 1 范围与命令（证据三段式：命令原文 / 原样输出 / 结论）

### 1.1 工作树范围核对

**命令原文**
```
git rev-parse HEAD; git status --porcelain
```

**原样输出（评审开始时）**
```
9fa9277450b9292db09f5209aaabc4a6ca5fe2d7
 M apps/arkui-schedule/entry/src/main/ets/components/RecordEditorView.ets
 M apps/arkui-schedule/entry/src/main/ets/model/homeRefresh.ts
 M apps/arkui-schedule/entry/src/main/ets/pages/Index.ets
?? apps/arkui-schedule/entry/src/main/ets/model/recordDateMove.ts
?? apps/arkui-schedule/tools/test/b4CalendarWiring.test.mjs
?? apps/arkui-schedule/tools/test/b4DateMove.test.mjs
?? apps/arkui-schedule/tools/test/b4DateUi.test.mjs
?? apps/arkui-schedule/tools/test/b4SavedRow.test.mjs
```

**原样输出（评审结束时）**
```
 M apps/arkui-schedule/entry/src/main/ets/components/RecordEditorView.ets
 M apps/arkui-schedule/entry/src/main/ets/model/homeRefresh.ts
 M apps/arkui-schedule/entry/src/main/ets/pages/Index.ets
 M docs/UX-STEPS.md                       ← 规划者并发写，排除
?? （5 个 untracked 与开始时相同）
```

**结论**：代码/测试改动集与派活清单**逐字一致**，无夹带。`git --no-pager diff --numstat`：
`RecordEditorView 150/8`、`homeRefresh 28/3`、`Index 24/13`；`docs/UX-STEPS.md 113/1` 为并发文档。
`docs/DATA-CONTRACT.md` §3/§4bis 字段形态零变化；未编辑 `b3Batch.test.mjs`。

### 1.2 改动性质（删除行核对）

`git diff` 的删除行共 24 行（8+3+13），全部为 import 扩写、注释改写、类型/签名调整与被替换的旧 `ts` 表达式：
- `RecordEditorView.ets`：`nextTsSameDate` import 删除（改由 `planDateMove` 决定）；`ts: nextTsSameDate(...): nowIso()` 被 `ts: plan.ts` 替换；成功 toast 单行被 `cleanupNote` 门控的两分支替换；首页 `DatePicker` 注释改为 `CalendarPicker` 注释。
- `homeRefresh.ts`：`containsRecordVersion` 的精确相等判定被「可解析按时刻 `>=`，否则精确相等」替换（签名/导出名不变）。
- `Index.ets`：`DatePicker({ start, end, selected, onDateChange })` 整块被 `CalendarPicker({ value, todayKey, onPick, onClose })` 替换；`dateFromKey` 仍被 `shiftDate`/`weekday` 使用（非死 import）。
无既有断言被删除、无物理删除文件、无 `deleted: true` 字面量硬写。

---

## 2 专节：D5 的 `ts` / 分片 / 合并语义（从代码 + 编译产物实测逐条推理）

> 本节使用的 node 实验均直接 import `apps/arkui-schedule/tools/.build/` 下由本次 `tsc`（exit 0）产出的纯逻辑，
> 用 `registerHooks` 补 `.js` 后缀（与测试文件同法）；不写任何临时文件。

### 2.1 `tsForDate` 字节形状 / 偏移 / 日期合法性 / round-trip

- **形状**：`recordDateMove.ts:77-82`
  ```
  export function tsForDate(dateKey, now = new Date()): string {
    if (!isValidDateKey(dateKey)) { return ''; }
    return `${dateKey}${nowIso(clockOf(now)).slice(10)}`;
  }
  ```
  `nowIso`（`common/date.ts:29-38`）产出 `YYYY-MM-DDTHH:MM:SS±HH:MM`（**无毫秒**）。故 `tsForDate` = 目标日期 + now 的时钟/偏移子串；
  当目标日 = `localDateKey(now)` 时与 `nowIso(now)` 逐字节相同（测试 B4 `tsForDate` 第一条钉死）。这是**既有唯一时间格式的复用**，没有第二种格式、没有自创排序规则。
- **偏移（DST）**：目标日的偏移**直接沿用 now 的偏移**，而不是目标日应有的偏移。node 实验（`TZ=America/New_York`）：
  ```
  summer.nowIso= 2026-07-01T12:00:00-04:00 winter.nowIso= 2026-12-01T12:00:00-05:00
  tsForDate(2026-12-01,summer)= 2026-12-01T12:00:00-04:00 instant= 2026-12-01T16:00:00.000Z
  real winter instant= 2026-12-01T17:00:00.000Z delta-hours= -1
  recordDateKey roundtrip= 2026-12-01
  ```
  结论：**日期键 round-trip 永不坏**（`recordDateKey`，`jsonl.ts:282-295` 只取 ISO 前缀），但同一 id 若另一设备在目标日按当日真实偏移写过版本，两者 `Date.parse` 可差 1 小时，
  极端情况下 `foldById` 可能选到另一设备版本（用户编辑被折叠掉）。同一 id 的三方版本（原版本/墓碑/新版本）都由**同一个 now** 供偏移，故本批自身两次追加的相对顺序不受影响。记为 **P2-2**。
- **合法性**：`recordDateMove.ts:45-57` 的 `isValidDateKey` = 正则 `^\d{4}-\d{2}-\d{2}$` + `new Date(y, m-1, d)` 三字段回读 + 年 1–9999。
  对年 ≥100，这就是真实日历校验（实验：`2026-02-30`/`2026-02-29` 拒，`2028-02-29` 收）；没有任何被接受的输入会产生 `recordDateKey(ts) !== dateKey`：
  ```
  2026-02-28 -> 2026-02-28T19:32:44+08:00 recordDateKey= 2026-02-28 ok= true
  2028-02-29 -> ... ok= true ; 2026-12-31 -> ... ok= true ; 2027-01-01 -> ... ok= true ; 0100-06-07 -> ... ok= true
  ```
  **JS 年 0–99 陷阱（实测）**：`new Date(1,0,1).getFullYear() = 1901`、`new Date(99,11,31).getFullYear() = 1999`，因此年 `0001`–`0099` 被 `isValidDateKey` **全拒**，与注释「年份 1–9999」及 `model/calendar.ts:175-194` 的 `parseDateKey`（纯整数、接受 1–9999）不一致：
  ```
  0001-01-01 calendar.parseDateKey= {"year":1,"month":1,"day":1} tsForDate= ""
  0099-12-31 calendar.parseDateKey= {"year":99,"month":12,"day":31} tsForDate= ""
  0100-01-01 calendar.parseDateKey= {"year":100,"month":1,"day":1} tsForDate= "0100-01-01T19:32:44+08:00"
  ```
  由于编辑器与首页**共用同一个 `CalendarPicker`**，用户可以选到 `0001-01-01`（纯逻辑网格能产出该键）却被 `planDateMove` 以「日期不合法」拒绝保存。记为 **P2-1**。
  另一个极端边界：`monthGrid(9999,12,1,'')` 的补位格含 `10000-01-07`（长度 11），首页 `pickDate` 的 `length !== 10` 守卫会**静默丢弃**该次点击（一次可点但无反应的假入口），编辑器侧则按非法拒绝；同样并入 P2-1。

### 2.2 同日排序：新 `ts` 严格大于原 `ts`（含 23:59:59.999 钳位）

- 同日分支 `recordDateMove.ts:113-123` 直接返回 `nextTsSameDate(original, clock)`（`common/date.ts:77-102`）：
  ```
  let target = Math.max(nowClock, originalClock < 0 ? 0 : originalClock + 1);
  if (target > limit) { target = limit; }   // limit = 86,399,999
  ```
  正常情况 `target >= originalClock + 1`，严格更大；且取原 `ts` 的日期前缀，分片不变。
- **钳位边界**：原 `ts = 23:59:59.999` 时 `target` 被压回 `23:59:59.999`，与原 `ts` **相等**（并非严格大于）。
  正确性依赖 `sortRecords`（`jsonl.ts:246-263`）按 `Date.parse` 稳定排序 + 物理追加保证新行在后：
  `foldById` 对同 ts 的两条保留后写者。该语义是 `date.ts` 既有设计（注释明写「靠稳定排序的输入顺序取胜」），非本批引入，但 D5 的墓碑也复用了它。
  node 实验（见 2.4 输出）显示 `orig < tomb = false`，即墓碑钳位时**不满足** `undoDelete.ts:90-92` 所要求的「严格大于」。记为 **P2-3**。

### 2.3 往后改：两次追加的顺序、崩溃窗口、各读取视图、openIndex、墓碑能否全局胜出

- **追加顺序**（`RecordEditorView.ets:664-689`）：先 `scheduleStore.appendRecord(record)`（存活版本，目标日，`ts = plan.ts`）；
  成功后再 `softDeleteRecord(this.originalRecord, plan.tombstoneTs)` 并 `appendRecord(tombstone)`（旧日）。
  两次都是普通 `appendRecord` → 各自按自身 `ts` 的日期前缀落片（`scheduleStore.ets:308-326` 的 `resolveRecordDate`），不改历史行。
- **崩溃窗口**：若两次追加之间进程被杀，只有目标日存活版本落盘，旧日仍留可见的旧版本 → 同一 id 在两天各显示一份（旧幽灵）。
  代码**没有事务、没有回滚**（回退已成功的存活记录反而会丢用户编辑，取舍正确）；编辑器在墓碑失败时用 `cleanupNote` 提示「已保存到 X，但旧日期未清理…请返回列表确认」，不静默。
  跨设备 pull 会把这两行当普通追加带走（无专用墓碑文件），若崩溃发生在提交前则只带走一行 → 另一设备看到幽灵；这部分属 `unverified`（无真机/无 git 同步实测）。
- **各读取视图**（`scheduleStore.ets`）：
  - `readDay(old)` `:144-148`：旧片 = 原行 + 墓碑行 → `foldById` → 墓碑为最新 → `withoutDeleted`（`undoDelete.ts:78-86`）过滤 → **0 条可见**（幽灵清除；钳位时靠追加顺序，见 2.2）。
  - `readDay(target)`：目标片只有存活版本 → 1 条可见。
  - `readAll()` `:174-184`：跨片合并 → `sortRecords` + `foldById` + `withoutDeleted` → 存活版本胜出 → 1 条可见。
  - `findByIdAny()` `:289-302` → 先 `findById`→`readAll()`，命中存活版本，返回它。
- **openIndex  progression**：`openIndexStore.applyRecord`（`:194-207`）对两次追加都调用 `applyRecordToIndex`。
  `applyRecordToEntry`（`openIndex.ts:301-348`）在 `:315-317` 对 `compareTs(record.ts, previous.ts) < 0` 直接 `return previous`：
  ```
  index after live: {"id":"r1","date":"2026-11-19","ts":"2026-11-19T08:00:00+08:00","openedAt":"2026-11-18T09:00:00+08:00"} changed= true
  index after tomb: {"id":"r1","date":"2026-11-19","ts":"2026-11-19T08:00:00+08:00",...} changed= false
  ```
  即墓碑因更旧而被忽略，`date` 已迁到目标日、`openedAt` 保留；反向到达顺序（先墓碑后存活）实测最终也收敛到存活条目。无幽灵待办。
- **墓碑能否全局胜出**：`planDateMove` 在 `:130-142` 强制 `tsMillis > originalMillis && tsMillis > tombstoneMillis`，否则 fail-closed。
  实测两种输入顺序：
  ```
  live,tomb fold winner deleted= false title= edited visible= 1
  tomb,live fold winner deleted= false title= edited visible= 1
  ```
  **证伪**：在当前实现（目标日 ts 严格晚于旧日墓碑）下墓碑不可能胜出；仅在「某人把两次追加的 ts 对调」或「目标日 ≤ 原日却仍打墓碑」时才会隐藏存活记录，而这两点正是 plan 的显式守卫所禁止的。
  钳位情形下墓碑 ts 与原 ts 相等但仍早于目标日 ts，结论不变。

### 2.4 往后/往早/失败路径汇总（node 实测原文）

```
original= 2026-11-18T09:00:00+08:00 kind= later ts= 2026-11-19T08:00:00+08:00 tomb= 2026-11-18T09:00:00.001+08:00
   orig<ts= true tomb<ts= true orig<tomb= true
original= 2026-11-09T23:59:59.999+08:00 kind= later ts= 2026-11-19T08:00:00+08:00 tomb= 2026-11-09T23:59:59.999+08:00
   orig<ts= true tomb<ts= true orig<tomb= false
== backward move ==
ok= false kind= earlier ts= "" reason= 不能把记录改到更早的日期：日程按「同 id 取较晚 ts」折叠，往早改会被判成旧版本而忽略（旧版本还会盖掉这次修改）。补记过去日期请新建一条并选那天。
```

- **往早拒绝是必要的**：`foldById`/`applyRecordToIndex` 对同 id 只取较晚 ts；目标日更早 ⇒ 目标 ts 必然早于原版本 ⇒ 用户编辑会被静默丢弃且旧版本反盖。若「只删掉拒绝」，
  `planDateMove` 会落入 `later` 之外的分支并写出注定被折叠掉的版本——**数据静默丢失**，因此拒绝是正确性要求，不只是 UX。
  文案准确（`reason` 逐字如上，说明机制并给出「补记过去日期请新建一条」的下一步），符合 `docs/FAILURE-MODES.md` 的不静默纪律。
- **失败路径**：`!plan.ok` → `RecordEditorView.ets:631-634` 只 toast `plan.reason` 后 `return`，零写入；
  存活 `appendRecord` 抛错 → `:665-671` toast `保存失败：…`、不写 marker、不调用 `onSaved`，不留半条记录（单行 `writeSync` 的部分写是既有风险）；
  编辑前快照缺失 → `:679-681` 仅写 `cleanupNote`，**不再 return**（B4-14/B4-23 明确禁止），marker 仍在 `:721` 写、`onSaved` 仍执行；
  墓碑 `appendRecord` 抛错 → `:683-687` 只写 `cleanupNote`、不 `throw`、不回滚存活版本。
  最终只弹一条 toast（`:710-718` 的 if/else），durable 的存活保存**从不**被报成未保存或回滚。
- **一次性 marker**：`savedMarkerOf`（`:732-740`）按 `resolveRecordDate(record.ts)` 取日期，改期后即目标日；`:721` 写在 `onSaved`（`router.back()`）之前。
  若首页仍在旧日，`reconcileSavedRow`（`Index.ets:324-325`）早退②，旧幽灵已由 `reload()` 读旧片墓碑消除；若首页在目标日，`containsRecordVersion` 命中存活版本早退③。
  崩溃窗口/墓碑失败时，marker 已消费，首页不再提示旧日残留 — 编辑器 `cleanupNote` 是唯一提示，记为 **P2-5**。

### 2.5 跨切面（逐项标注可证明/未验）

| 切面 | 判定 |
| --- | --- |
| 附件 `attachments[].archive` | **可证明的不一致**：存活版本沿用 `this.attachments`（`RecordEditorView.ets:649-651`），墓碑由 `cloneRecord` 复制（会保留 `archive/entry`，`types.ts:136-162`）；`attachmentStore.ets:313-327` 按 `item.archive` 取 zip，因此图片仍能显示，但**记录日期改到新日后 zip 日期没改**，与 `DATA-CONTRACT.md` §4ter「按记录日期打包」不符；`openWritingBoard()` `:609` 仍用 `defaultDate` 而非 `formDate` 决定 zip 日期。**P2-4**。 |
| 旧日 AI 汇总 | `summaries/<旧日>.json` 不随改期重写；新日汇总不自动包含该记录。代码无相应写入（静态可证），但用户可见后果 / 汇总内容正确性 `unverified`。 |
| 导出 / 导入区间 | 导出读 `readAll`（已过滤墓碑），改期后记录从旧日区间消失、出现在新日区间（静态推断）；但带 `archive=旧日.zip` 的记录导出到新日区间时，zip 不在该区间产物内（承 P2-4）；真机行为 `unverified`。 |
| 多设备 pull 两行 | 两行均为普通 JSONL 追加，随 git 提交；`mergeDayFile` 未见本批改动。崩溃窗口只提交一行时另一设备见幽灵（承 2.3），实际 git 时序 `unverified`。 |
| `SAVED_MARKER_KEY` 一次性路径 | 见 2.4 末尾与 P2-5；纯逻辑上正确，真机页面栈消费次数 `unverified`。 |

### 2.6 四个新测试的评价

- `b4DateMove.test.mjs`（19 例）：**真契约测试**——import 编译后的 `recordDateMove.js` 实跑，钉死 `tsForDate === nowIso` 同形、偏移子串保留、闰日/非法日、新建/同日/往后/往早、`nextTsSameDate` 严格顺序、跨月跨年、钳位、确定性且不改入参。强；未发现「实现坏了仍通过」的明显空断言。唯一未覆盖：`isValidDateKey` 对年 1–99 的拒绝（`0100-01-01` 是测试里最小合法年，恰好绕开 P2-1），以及 DST 目标日偏移。
- `b4SavedRow.test.mjs`（14 例）：**真契约测试**——实跑 `containsRecordVersion`，覆盖精确相等、更晚/更早按时刻、不可解析占位串的精确相等兜底、混合可解析性、坏项跳过、跨天更晚（B4-14）。强。
- `b4DateUi.test.mjs`（25 例）与 `b4CalendarWiring.test.mjs`（18 例）：ArkTS 不能在 Node 跑，故为**源码文本断言**（沿用 `bodyFrom`/`stripComments`），钉住「复用哪个组件」「拒绝分支在第一次写入前」「墓碑用编辑前快照」「Marker 在 onSaved 前」等结构事实，能挡住接线回归，但**不能证明运行时行为/真机渲染**；具体弱项：
  - B4-13 只断言 `appendRecord(record) < softDeleteRecord < appendRecord(tombstone)` 的位置，未断言运行时 `plan.tombstoneTs` 的正确性（由 `b4DateMove` 补上，但两文件无交叉验证）。
  - D7-11 断言 `pickDate` 五个动作顺序，不能证明 `CalendarPicker` 真的发出合法键；D7-17 的「假入口守卫」只是文本正则。
  - 无可断言 `DATA-CONTRACT.md` 未变（该项靠 `git status` 证明）。
- **B4-14 / B4-15 的变更判定：收紧（tightened），不是放宽**。证据在文件内注释与断言：
  ```
  // 修复：快照缺失不再 return（否则跳过一次性标记与 onSaved），只记一条清理提示。
  assert.doesNotMatch(TOMB_BLOCK, /return;/);                       // B4-14
  // 长 toast 时长钉在最终那条 cleanupNote toast 上（比只查墓碑块更严格）。
  assert.match(SAVE_CODE, /message: cleanupNote, duration: toastMsFor\(true\)/);  // B4-15
  assert.equal(TOMB_BLOCK.includes('throw '), false, ...);          // B4-15
  ```
  新增的 B4-23（墓碑块→收尾行无 `return`）、B4-24（门控后恰好两条 toast，清理/成功各一条）、B4-25（`encodeSavedMarker` 排在墓碑块之后且不受 `cleanupNote` 约束）进一步**禁止**「快照缺失提前 return 跳过 marker/onSaved」「双 toast」「marker 被 cleanupNote 条件吞掉」这三个曾经的真实缺陷。判定：变更方向正确、强度上升。

---

## 3 D7：`CalendarPicker` 接线

- **滚轮清除**：`Index.ets:1105-1112` 原 `DatePicker({ start:new Date(2020,0,1), end:new Date(2035,11,31), selected:dateFromKey(...), onDateChange(...) })` 整块替换为 `CalendarPicker({ value:this.selectedDate, todayKey:localDateKey(new Date()), onPick:this.pickDate, onClose:... })`。
  `INDEX_CODE.includes('DatePicker(') === false`（D7-01）、无遗留 `new Date(2020,0,1)`/`new Date(2035,11,31)`（D7-02）；`dateFromKey` 仍被 `shiftDate`/星期名使用（`:438/:442`），不是死代码。
- **同一组件同源**：首页 `Index.ets:70` 与编辑器 `RecordEditorView.ets:49` 都从 `../components/CalendarPicker` / `./CalendarPicker` 导入同一个 `CalendarPicker`（`CalendarPicker.ets:35-53` 的 props `value/todayKey/onPick/onClose` 未改）。编辑器日期行在 `:877+`，点整行切 `showDatePicker`，内嵌 `CalendarPicker` 的 `onPick → applyPickedDate`（写 `formDate`、收面板、`notifyDirty()`），更早日期当场显示 `dateMoveHint()` 的 danger 文案；无第二个日期 UI、无系统 `DatePicker(`（`b4DateUi` B4-01/03）。
- **行为等价、非假入口**：`pickDate`（`Index.ets:455-471`）严格保留旧 `onDateChange` 的五个动作 `selectedDate ← dateKey`、`showDatePicker=false`、`showAllPending=false`、`reload()`、`loadSummary()`；`‹`/`今天`/`›` 仍路由 `shiftDate(-1)`/`goToday()`/`shiftDate(1)`（`DateBlock` `:1033+`，D7-16）。`CalendarPicker` 的日期格 `:261-263` 与「今天」`:112-122` 都真实触发 `onPick`，「关闭」`:301-303` 触发 `onClose`，根节点在 `closeOnBlank=false` 下不吞事件。
- **边界**：旧滚轮有 2020–2035 范围，新 picker 允许 1–9999；`monthGrid(9999,12,…)` 的 `10000-01-xx` 补位格被 `pickDate` 的长度守卫静默忽略（可点无反应），与 P2-1 同源。真机排版/触控高/toast `unverified`。

---

## 4 B3 P2-1 / P2-4：saved-row 判据放宽

- **改动**：`homeRefresh.ts:128-145`
  ```
  const markerMillis: number = Date.parse(ts);
  ...
  const recordMillis: number = Date.parse(record.ts);
  if (!Number.isNaN(markerMillis) && !Number.isNaN(recordMillis)) {
    if (recordMillis >= markerMillis) { return true; }
  } else if (record.ts === ts) { return true; }
  ```
  用既有 `Date.parse`（与 `foldById`/`applyRecordToIndex` 同款解析）按**时刻**判定「同 id 且不早于标记」，任一侧不可解析则逐字相等兜底（保留 `'t1'`/`'t2'` 占位串语义）。
- **正确性**：`ts` 是同 id 版本序，列表里出现更晚 ts 说明已是包含本次保存的最新版，早退正确；只有更早 ts 才返回 `false` 走兜底 `reconcile()+reload()+loadSummary()+toast`。`Index.ets:320-337` 的 `reconcileSavedRow` 一字未改，早退③照旧调用 `containsRecordVersion(this.records, saved.id, saved.ts)`（D7-18 亦钉住）。
- **无放宽旧测试**：`git status` 无 `b3Batch.test.mjs`；新 `b4SavedRow.test.mjs` 14 例实跑覆盖等价/更晚/更早/不可解析/跨天，纯函数实测：
  ```
  B4-01 精确 ts → true ; B4-02 更晚 → true ; B4-03 更早 → false ; B4-14 跨天但更晚 → true
  ```
- **残留边界**：判据只看 id+ts，不看 `date`/`deleted`；在「列表里同 id 的更晚版本其实是被别的设备覆盖的不同日期版本」时仍会早退（数据已是最新，后果至多是旧日幽灵未被提示，见 P2-5）。属 P2 级。

---

## 5 测试 / 门禁证据（本人独立复跑，非照抄）

**命令原文**
```
cd C:\Users\GWL\Desktop\itwillclaude\dsh-sync-suite
node apps/arkui-schedule/tools/overlay.mjs status
node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
node --test "packages/dsh-dots/test/*.test.mjs" "apps/arkui-schedule/tools/test/*.test.mjs"
node apps/arkui-schedule/tools/validate-app.mjs
```

**原样输出（overlay）**
```
覆盖层：未应用（工作区为「共享源码 + 平台目录」的原始形态）
[overlay] applied=false
OVERLAY_EXIT=0
```

**原样输出（tsc）**
```
TSC_EXIT=0
```

**原样输出（全量测试，尾部逐字）**
```
✔ ⑦ 补齐时目标已有同名条目 → 不覆盖用户数据，也不因旧目录残留而永久失败（评审 M3） (13.0453ms)
ℹ tests 2309
ℹ suites 309
ℹ pass 2308
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 29044.7001
TEST_EXIT=0
```

**原样输出（validate-app）**
```
🔍 校验 ArkUI-X 工程：C:\Users\GWL\Desktop\itwillclaude\dsh-sync-suite\apps\arkui-schedule
✅ 全部通过：8/8 条规则（JSON5/JSON 70 个、相对 import 357 条、main 静态 import 450 条、页面 7 个、rawfile/git 2 个文件）
VALIDATE_EXIT=0
```

**结论**：基线 2233 / 2232 pass / **0 fail** / **1 skip** → 本批 **2309 / 2308 / 0 fail / 1 skip**，差 **+76**。
逐文件 `test()` 计数实测：`b4DateMove 19` + `b4DateUi 25` + `b4SavedRow 14` + `b4CalendarWiring 18` = **76**，增量完全对上；
fail 仍为 0，skip 未增长（唯一 skip 是既有代理环境变量用例）。`validate-app` 8/8（相对 import 350→357、main 静态 import 442→450，对应本批新增 `CalendarPicker`/`parseDateKey`/`planDateMove`/`softDeleteRecord` 等导入）；`tsc` exit 0。

---

## 6 发现清单（P0 / P1 / P2）

> P0 = 数据丢失 / 错写 / 安全隐患；P1 = 用户可见错误行为或契约被破坏；P2 = 边界 / 可维护性 / 跨切面未覆盖 / 未验项。
> 本批 **P0 0 / P1 0 / P2 6**，不阻塞提交。

### P2-1 `isValidDateKey` 的 JS 年 0–99 陷阱，与 `CalendarPicker`/`parseDateKey` 的可选范围不一致

- **file:line**：`apps/arkui-schedule/entry/src/main/ets/model/recordDateMove.ts:42-57`（`isValidDateKey`）；对照 `model/calendar.ts:175-194`、`components/CalendarPicker.ets:101-110`、`pages/Index.ets:461-464`。
- **证据**：代码用 `new Date(year, month-1, day)` 回读校验，注释写「年份 1–9999」；实测 `0001-01-01`/`0099-12-31` 的 `parseDateKey` 非 null、`tsForDate` 返回 `''`（见 2.1）。`CalendarPicker` 能翻到年 1–99 并点出 `0001-01-01`；首页 `pickDate` 接受它（长度 10）却查不到记录；编辑器 `planDateMove` 以「日期不合法」拒绝保存。极端年 9999 网格还产出 `10000-01-07`（长度 11）被 `pickDate` 静默丢弃。
- **影响**：用户可选到「合法」日期却保存失败/点击无反应（假入口）；不影响已存数据，范围极窄，故 P2。
- **建议修法**：`isValidDateKey` 改为直接调用 `model/calendar.ts:parseDateKey`（纯整数、无 1900 偏移）；并把 `CalendarPicker` 的可点范围收到与 `planDateMove` 一致（例如年 ≥100，或让 `pickDate` 对 `parseDateKey(dateKey)===null` 给出明确提示而非静默早退）。补测 `0001-01-01`/`0099-12-31`/`10000-01-07`。

### P2-2 `tsForDate` 给非今日目标日盖「now 的偏移」，DST 期外产生 1 小时时刻偏差

- **file:line**：`model/recordDateMove.ts:77-82` + `common/date.ts:29-38`（`nowIso` 用 `offsetMinutes(now)`）。
- **证据**：`TZ=America/New_York` 实测 `tsForDate('2026-12-01', 7月 now) = 2026-12-01T12:00:00-04:00`，真实冬季应为 `-05:00`，`Date.parse` 相差 1 小时；`recordDateKey` round-trip 仍为 `2026-12-01`（见 2.1）。
- **影响**：日期键/分片不会错；但同 id 与另一设备按目标日真实偏移写入的版本比较时，`foldById` 可能误判新旧（差 1 小时），极端情况吞掉本次编辑。本批两次追加共用同一 `now`，自身顺序不受影响。
- **建议修法**：要么在 `tsForDate` 内按 `dateKey` 计算当日偏移（需不依赖 `Intl` 的本地时区规则，成本高），要么把「时钟/偏移沿用 now」显式写进 `docs/DATA-CONTRACT.md` §3 作为已知限制，并在跨设备同 id 编辑场景加一条警示。

### P2-3 钳位时墓碑 ts 与原 ts 相等，旧日去重依赖追加顺序 + 稳定排序

- **file:line**：`common/date.ts:85-89`（`target > limit ⇒ target = limit`）、`model/recordDateMove.ts:127`、`model/jsonl.ts:246-263`（`sortRecords` 稳定排序）。
- **证据**：实测 `planDateMove('2026-11-09T23:59:59.999+08:00','2026-11-10',...)` → `tombstoneTs = 2026-11-09T23:59:59.999+08:00`，`orig < tomb = false`（见 2.4），违反 `undoDelete.ts:90-92` 对墓碑「严格大于」的要求；正确性靠旧片中墓碑行在原行之后 + 稳定排序。
- **影响**：若外部工具/合并重排同 ts 的两行，旧日幽灵可能复活。既有设计如此，非本批新缺陷，但 D5 依赖它。
- **建议修法**：至少补一条端到端纯逻辑测试：钳位输入下 `foldById(parseJsonl(原行+墓碑行))` 的赢家带 `deleted:true` 且 `withoutDeleted` 后为 0；长期考虑让墓碑在饱和时改用另一种可严格区分的标识（需契约变更，另议）。

### P2-4 改期后附件 `archive` 仍指向旧日 zip（跨切面未覆盖）

- **file:line**：`components/RecordEditorView.ets:608-610`（`openWritingBoard` 用 `this.defaultDate` 决定 zip 日期）、`:649-651`（存活版本沿用 `this.attachments`）、`:682`（墓碑 `cloneRecord` 复制 `archive/entry`）；`services/attachmentStore.ets:313-327` 按 `item.archive` 读 zip。
- **证据**：静态可证：存活记录日期已变为目标日，`attachments[].archive` 字段未变；`DATA-CONTRACT.md` §4ter 要求「按记录日期打包」。`attachmentStore` 读图用显式 `archive`，所以图片仍可读（真机 `unverified`）。
- **影响**：导出/导入按新日区间时引用到旧日 zip；多设备需旧的 `<date>.zip` 也同步到位；显示侧暂无证据表明会坏。
- **建议修法**：改期时随存活版本重建附件引用（`archive` 改为目标日 zip 并把条目写进该文件），或明确记录「附件归档日 ≠ 记录日」为契约例外并在导出时一并带上所引用的 zip；至少在 D5 说明中登记该限制。

### P2-5 一次性 marker 无法表达「删除清理失败」，首页旧日视图无二次提示

- **file:line**：`components/RecordEditorView.ets:677-689`（`cleanupNote`）、`:721`（marker 写入）；`model/homeRefresh.ts:25-30`（`SavedMarker` 四字段）；`pages/Index.ets:320-337`（`reconcileSavedRow`）。
- **证据**：marker 只带 `{id,date,ts,done}`，`date` = 目标日；墓碑失败/崩溃窗口时旧片仍有幽灵，但首页若仍在旧日，`:324-325` 早退②直接返回；编辑器唯一的 `cleanupNote` toast 在返回后不可恢复。`containsRecordVersion` 放宽后只看 id+ts（承 §4 残留边界）。
- **影响**：用户若错过编辑器那条 toast，再次回首页看不到「旧日未清理」提示；数据无损、可手动删除，故 P2。
- **建议修法**：把清理状态并入 marker（新增可选 `cleanupPending/oldDate` 字段，解码仍向后兼容），首页早退②前据此提示；或把兜底 toast 文案改中性并允许在旧日视图对同 id 的更旧版本给一次提示。

### P2-6 静态文本测试的表达力上限与脆弱性

- **file:line**：`tools/test/b4DateUi.test.mjs:105-123,226-251,274-307`；`tools/test/b4CalendarWiring.test.mjs:123-132,204-232`。
- **证据**：43 个新 UI 断言全部读源码字符串（`bodyFrom`/`braceBlockFrom`/正则），不 import 运行时；B4-13 只钉三处调用的**位置**、D7-11 只钉 `pickDate` 五个动作的**文本顺序**。B4-14/B4-15 已收紧（见 2.6），但文本测试仍可能对「位置正确、参数绑错」的实现放行；逐字文案/缩进/计数断言（B4-24 的 2 次 toast、D7-12 的 1 次 reload）在合法重构下会变红。
- **影响**：维护成本 + 对真实运行时缺陷的覆盖空白；不阻塞。
- **建议修法**：将可纯逻辑化的判定继续下沉（例如把「墓碑 ts 与存活 ts 的严格顺序」直接在 `b4DateMove` 里多覆盖几组 DST/钳位入参）；UI 文本断言改模式匹配 + 大括号配平（本批的 `bodyFrom` 已比 B3 的缩进法稳健），并在有 DevEco 时补一条真机走查。

---

## 7 已知限制 / unverified 清单（不得写成「已验证」）

1. **ArkTS 编译**：本机无 DevEco / 无 HarmonyOS SDK / `node_modules` 无 ArkUI d.ts。`RecordEditorView.ets` 新增的 `import { parseDateKey }`、`planDateMove`/`DateMovePlan`/`softDeleteRecord` 导入、`@State formDate/showDatePicker`、`CalendarPicker({...})` 装配、`Index.ets` 的 `CalendarPicker` 装配 — 全部 `unverified`。`tsc` exit 0 只覆盖纯逻辑层，不能替代 DevEco 编译。
2. **真机 UI**：编辑器日期行展开动画、`CalendarPicker` 6×7 网格在窄屏/深色模式的排版、`TextInput` 与日期面板的焦点竞争、toast 时长/叠加、返回导航栈中 `onPageShow` 的真实触发次数与 marker 消费是否严格一次 — `unverified`。
3. **跨设备/git 时序**：两次追加在提交/推送中的原子性、崩溃窗口另一设备看到幽灵的实际表现、pull 后 `mergeDayFile` 对两行的处理 — `unverified`（无设备/无远端）。
4. **附件/汇总/导出**：`archive=旧日.zip` 在显示、导出、导入、跨设备同步中的真实表现（承 P2-4）；旧日/新日 AI 汇总内容是否正确 — `unverified`。
5. **DST 真机**：`nowIso` 依赖 `Date#getTimezoneOffset()`，鸿蒙 ArkTS 运行时对历史/未来日期 DST 的实现是否与 Node 一致 — `unverified`；P2-2 的 1 小时偏差在 Node 上已复现，真机未测。
6. **并发文档**：`docs/UX-STEPS.md` 的 §4.4（+113/-1）在本评审期间由规划者并发写入，本Reviewer未参与，未据此下任何判定；`docs/DATA-CONTRACT.md` 与 `b3Batch.test.mjs` 自始至终未改（`git status` 佐证）。
7. **`.ps1` BOM / 依赖**：本批无 `.ps1`、无 `package.json`/lock 变更，仅静态确认；未安装任何依赖。

---

## 8 给规划者的返工建议（均非必须，按性价比排序）

1. **（推荐）消 P2-1**：让 `recordDateMove.isValidDateKey` 复用 `calendar.parseDateKey`，并让 `CalendarPicker`/`pickDate` 的可点范围与之对齐；补年 1–99 / 9999 边界用例。
2. **（推荐）收 P2-5**：在 `SavedMarker` 里带 `cleanupPending`/`oldDate`，让首页对「存活已保存、旧日未清理」给一次可见提示；或至少把编辑器 `cleanupNote` 写进可恢复的位置。
3. **（可选）记 P2-2/P2-4**：若暂不改实现，把「偏移沿用 now」「archive 归档日不随改期变」写进 `DATA-CONTRACT.md` §3/§4ter 的限制条目，避免后人误判为 bug。
4. **（可选）降 P2-6 脆弱性**：把 B4-13/D7-11 的关键参数绑定下沉为纯逻辑断言；UI 文本断言改模式匹配。
5. **（提交前必做）**：DevEco 编译 + 真机走查 D5 日期行/往后改/往早拒绝、D7 首页日历选日、保存返回 marker 消费；本机 `hdc` 不可用，本评审不能替代。

---

## 9 Report back to the Designer（English, compact）

1. **Counts / blocking**: P0 = 0, P1 = 0, P2 = 6; **non-blocking**. Most important finding: the core D5 `ts`/shard/merge semantics are sound — a forward move stamps the live version strictly later than both the original and the old-day tombstone, and `foldById`/`applyRecordToIndex` provably select the live version in both append orders (tombstone never wins). The notable residual is a date-range inconsistency: `isValidDateKey` uses `new Date(y, m-1, d)` and therefore rejects years 0001–0099 even though the shared `CalendarPicker`/`parseDateKey` can emit them, so a picker-offered valid date cannot be saved (P2, narrow, no data loss).
2. **Verbatim gate tails**: `applied=false` (OVERLAY_EXIT=0); `TSC_EXIT=0`; `tests 2309 / suites 309 / pass 2308 / fail 0 / cancelled 0 / skipped 1 / todo 0 / duration_ms 29044.7001 / TEST_EXIT=0` (baseline 2233/2232/0/1 → +76 = 19+25+14+18, fail 0, skip unchanged); `validate-app` `8/8 条规则（JSON5/JSON 70 个、相对 import 357 条、main 静态 import 450 条、页面 7 个、rawfile/git 2 个文件）`, VALIDATE_EXIT=0.
3. **D5 semantics verdict**: **accepted-with-limits** (strict ordering and fold/index behavior proven; limits: year 0–99, DST offset stamp, clamp-order dependence, archive/marker cross-cutting). **B4-14/B4-15 change**: **tightened** — they now forbid the early `return` that used to skip the saved marker and `onSaved`, pin the long toast to the final `cleanupNote`, and add B4-23/24/25 to forbid double toast and marker gating; not weakened.
4. **Review file**: `C:\Users\GWL\Desktop\itwillclaude\dsh-sync-suite\docs\REVIEW-b4-batch.md`.

---

（本报告为独立只读评审原文；未改任何源码 / 测试 / 既有文档，未 commit / push，未碰 `.git` 写操作 / profile / `.ps1` / 依赖。唯一写入文件为 `docs/REVIEW-b4-batch.md`。）

---

## 10 对齐说明（2026-11-19 需求收窄后）

> 本节由后续文档收窄批次追加。上文 §0–§9 描述的是**收窄前**的工作树（B4 批，HEAD `9fa9277`，全量
> 2309/2308/0/1），作为历史记录原样保留，不改写任何结论、行号或判定。用户 2026-11-19 拍板「日期只在新建时选一次」，
> B4 中「已有记录改到更晚/更早日期」的整套机制已在待提交收窄改动中删除；对删除 diff 的独立只读评审见
> `docs/REVIEW-b4-narrow.md`。

- **已 N/A 的发现**：
  - **P2-3（钳位时墓碑 ts 与原 ts 相等）**：N/A。保存链路不再产生旧日墓碑；同日更新仍沿用
    `nextTsSameDate` 的既有钳位语义（`date.test.mjs` 既有行为，非本批新增风险）。
  - **P2-4（改期后附件 `archive` 指向旧日 zip）**：N/A。记录不再换日，`archive` 与记录日期始终一致。
  - **P2-5（一次性 marker 无法表达旧日清理失败）**：N/A。不再有旧日清理，`cleanupNote` 已删除；
    一次性 marker 与 `onSaved` 仍在保存成功路径无条件执行。
- **仍适用的发现**：
  - **P2-1（JS 年 0–99 陷阱）**：仍适用。判定函数由 `recordDateMove.ts` 的 `isValidDateKey` / `planDateMove`
    迁到 `model/recordSaveTs.ts` 的 `isValidDateKey` / `tsForDate`（新建记录仍会被这个边界拒绝）；
    首页 `pickDate` 的 `10000-01-07` 假入口仍在。
  - **P2-2（非今日目标日沿用 now 的 DST 偏移）**：仍适用，但现在只影响**新建**记录选过去/未来日期的场景。
  - **P2-6（静态文本测试的表达力上限与脆弱性）**：仍适用。新 `b4SaveTs` 是纯逻辑实跑，
    `b4DateUi` / `b4CalendarWiring` 仍是源码文本断言。
- **收窄后的门禁**：全量 **2306 / 2305 / 0 / 1**（相对上文 −3，是刻意删除测被移除功能的用例），
  `validate-app` **8/8**、`tsc` exit 0、`overlay applied=false`（均为 Designer 复核结果，本节未重跑）。
