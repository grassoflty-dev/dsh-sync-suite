# 模块 A 独立只读评审：mod-home-filters-2（首页筛选控件收敛）

> 评审对象：未提交的工作树；同树中的 B `mod-drop-v1` / C `mod-instance-list` 仅在与 `pages/Index.ets` 交互处纳入观察。
> 结论日期：2026-11-20；真机项一律 `unverified`。

## 结论

- **P0：0；P1：0；P2：1**（`model/query.ts:5` 陈旧注释，非本模块引入、可后续清理）。
- **可以提交**：5 项核验全部通过；4 道门闸全部复现且符合预期；无断言削弱、无开关残留、计数/文案与文档一致。

## Findings（file:line）

- **P2-1** `apps/arkui-schedule/entry/src/main/ets/model/query.ts:5`：文件头仍写「先按 tab 取数（`scheduleStore.readDay` / `openIndexStore.pendingRecords`）」，实际取数为 `timelineStore.readDay` / `timelineStore.pendingRecords`（`Index.ets:413-414`）。该行在本次 diff 中未被改动（`git diff` 仅改第 4 行注释），属历史陈旧注释；不影响行为，建议顺手订正。
- 其余核验无 P0/P1：今日无完成过滤（`Index.ets:414,883`）、排序未动（`:436-447`）、开关删除（见下节）、计数/空态（见下表）、文档一致（见下节）。

## 开关删除证明（toggle-removal proof）

- 全仓 `grep -E "showDone|onShowDoneChange|显示已完成"` 命中 26 处，**全部在 `docs/`**（历史记录或删除说明），`.ets/.ts/.mjs` 零命中；无 dead test。
- `Index.ets`：无 `showDone` / `onShowDoneChange`（`:127,137` 仅 `HomeTab` / `tab`）、无 `Toggle(` / `ToggleType.Switch`、无「显示已完成」文案；`StatusChip` / `pickStatus` / `statusFilter` / `showAllPending` / `pendingCountOf` 均 grep 零命中。
- `ModeTabs()`（`:1225-1265`）只渲染 `今日` / `未完成` 两个 `ActionButton`，无 Toggle；`homeFilters.test.mjs:132-138,263-264,277-280` 反向钉死其不存在。
- `model/query.ts` 的 `status` 参数保留为通用能力（`:19,49,106-115`），页面固定传 `'all'`（`Index.ets:865-866`）；本次只改第 4 行注释，逻辑零改动。

## 计数 / 空态文案对照表

| 场景 | 代码位置 | 实际文案 / 行为 | 契约 | 结论 |
| --- | --- | --- | --- | --- |
| 今日副标题 | `Index.ets:430-433` | `今日 N 条（v2 时间线，自动同步）`，N = `records.length`（当天全量） | `今日 N 条` = 总数 | ✅ |
| 未完成副标题 | `Index.ets:420` | `未完成 N 条（v2 时间线，自动同步）`，N = `pendingSorted().length` | 保留未完成数 | ✅ |
| 「共 M 条」后缀 | `homeFilters.test.mjs:220-226`；`Index.ets:730` | 筛选副标题无「共」；`:730` 的 `共 N 条 · 已完成…` 属 AI 汇总结果面板（另一功能） | 筛选副标题无后缀 | ✅ |
| 今日空 | `Index.ets:1339-1346`（仅今日 tab 渲染，`:1788,1832`） | `今天还没有日程`，无按钮 | 汇总块灰字 | ✅ |
| 未完成空 | `Index.ets:1694-1704` | `没有未完成的日程` | 列表空态 | ✅ |
| 行上完成态 | `RecordRow.ets:69-89`；`Index.ets:1664-1679` | Checkbox + 删除线仅表状态，`onToggle`→`toggleDone` 写同 id 新版本；不参与列表过滤 | 展示/写入，非过滤 | ✅ |

## 测试 retarget 判定

- `homeFilters.test.mjs`：18 例。删除的 3 例（开关渲染 / 拨开关重算 / 开关作用域）只覆盖已删除功能；新增 5 例钉死「今日全量不过滤」「无 Toggle/文案/状态」「计数为总量」「无共后缀」「query.ts 不再宣称开关正交」，并对保留守卫追加 `TOGGLE_LABEL` / `SHOW_DONE` 反向检查（`:112-114,132-138,175-185,220-225,254-268`）。保留例（tab 标签、pendingSorted、服务层、空态、两断点渲染）原样。净 +2 例，**无针对仍存在行为的断言削弱**。
- `query.test.mjs`：19 例，仅 `:277-290` 两行 retarget —— `applyQuery(source, filter)` → `applyQuery(this.records, filter)`（仍校验精确调用）；`record.done !== true` 由「必须存在」反转为「必须不存在」（功能已删）。其余 17 例完全未动。**无削弱**。

## 文档 verdict

- `docs/UI-DESIGN.md §10`（`:384-429`）：5→2、本轮 3→2、删除映射表、`showDone`/`onShowDoneChange`/「显示已完成」删除、`今日 N 条`/无「共 M 条」/空态、Δ0（理由：控件数非可计数 tap/scroll/wait）——与代码逐条吻合；§4 无旧控件名残留。
- `docs/UX-STEPS.md §4.7`（`:674-714`）：控件 5→2（本轮 −1）、Δ0 理由充分、合计 31→31、实现落点行号/文案与源码一致、真机 `unverified`。两者 honest。

## 门闸复现（tail）

```
node --test apps/arkui-schedule/tools/test/homeFilters.test.mjs apps/arkui-schedule/tools/test/query.test.mjs
ℹ tests 37 / suites 4 / pass 37 / fail 0 / cancelled 0 / skipped 0 / duration_ms 249.46

node --test "packages/dsh-dots/test/*.test.mjs" "apps/arkui-schedule/tools/test/*.test.mjs"
ℹ tests 2913 / suites 337 / pass 2912 / fail 0 / cancelled 0 / skipped 1 / todo 0 / duration_ms 66770.49

node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
EXITCODE=0（无输出）

node apps/arkui-schedule/tools/validate-app.mjs
✅ 全部通过：8/8（JSON5/JSON 70、相对 import 428、main 静态 import 548、页面 8、rawfile/git 2）；EXITCODE=0
```
> 全量 2913/2912/0/1 与预期一致；validate 8/8，但 import/页面计数高于 `项目理解.md` 的历史基线，系同树 B/C 新增文件所致，非本模块回归。

## unverified

- 无设备（`hdc list targets` 空 / 无 DevEco）：两 tab 真机排布、触控反馈、今日已完成+未完成混排观感、ArkTS 编译产物均未验。
- 行上勾选写入路径仅做源码级核对（`Index.ets:837-859` + `RecordRow.ets:74-78`），未跑真机。
- `docs/VERIFICATION.md:1132,1136,1171,1248-1249`、`docs/REVIEW-home-filters.md`、`docs/ROADMAP.md`、`docs/MODULES.md` 中的「显示已完成」均为改动前记录或删除说明的历史文字，非活动代码，不影响结论。
