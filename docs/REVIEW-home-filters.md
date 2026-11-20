# REVIEW — mod-home-filters（首页筛选控件 5 → 3）

> 独立只读评审；工作树未提交，且并行含 `mod-export-json` 改动，本文只覆盖 `mod-home-filters` 清单。
> 依据：根目录 `项目理解.md`、`docs/UI-DESIGN.md` §4/§10、`docs/UX-STEPS.md` §1/§2/§4.5/§4.7、`docs/STATE-UI.md`。

## 结论
- **P0：0；P1：0；P2：2（均不阻塞）→ 可以提交。**
- 控件集、行为、空态、测试与步数口径均达标；5 道门禁全部复现通过。真机相关项一律 `unverified`。

## Findings（P2，不阻塞）
- **P2-1 开关切换不刷新副标题的「共 N 条」**：`pages/Index.ets:1020-1022` 的 `onShowDoneChange` 只调 `refreshQuery()`；`statusText` 仅在 `reload()`（`:446-452`）计算，`· 共 N 条` 后缀依赖 `this.showDone`（`:450`）。结果：拨开关时该后缀停留在上次 reload 的值（该出现时不出现、不该出现时残留）。主计数「今日 N 条未完成」由 `pendingCountOf()`（`:463-471`）独立计算，始终正确、不受影响。建议只重算副标题，不为拨开关重读磁盘。
- **P2-2 工具源码残留旧标签 `今日待办`**：`tools/device-accept.mjs:923` 的 on-home 判定仍含 `t.includes('今日待办')`，被同式的 `新建` 掩盖、功能不断，但已是死分支；`tools/test/homeFilters.test.mjs:242-249` 的守卫只禁 `全部未完成` / 带引号的 `已完成`、`全部`，抓不到它（`tools/qa-table-markdown.mjs:533` 同样残留，但不在本模块清单）。建议清理并补进守卫。

## 控件映射（old → new）
| 旧控件 / 旧状态 | 新落点 | 能力是否保留 |
| --- | --- | --- |
| `今日待办` tab（`showAllPending=false`） | `今日` tab（`tab='today'`，默认） | 是：开关关即只看当天未完成 |
| `全部未完成` tab（`showAllPending=true`） | `未完成` tab（`tab='pending'`） | 是：跨日取数与排序不变 |
| `全部` 状态片（`statusFilter='all'`） | `今日` + 显示已完成开 | 是：当天全部记录 |
| `已完成` 状态片（`statusFilter='done'`） | `今日` + 显示已完成开，看 `done===true` 行 | 是 |
| `未完成` 状态片（`statusFilter='open'`） | `今日` + 开关关（默认） | 是 |
| `StatusChip()` / `pickStatus()` / `@State statusFilter` | 删除，状态机收敛为 `tab` + `showDone` | 删的是状态不是能力 |

控件数 **5 → 3**；四种旧视图均可达（`docs/UI-DESIGN.md` §10.2）。

## 行为与空态判定
- **通过**：`reload()`（`:436-459`）今日走 `timelineStore.readDay(selectedDate)`、未完成走 `pendingSorted()`（`:474-487`，先日期键再 `ts` 升序、`.slice()` 不改 store 返回值）；`refreshQuery()`（`:1000` 起）仅今日且开关关时挡已完成，未完成 tab 用 tab 全量；搜索/作者、`✨今日汇总`（`:2045`、`:2090` 的 `if (this.tab === 'today')` 门控）、`UndoBar`、记录点击/编辑路径未改；`reconcileSavedRow()`（`:373` 起）早退按新 tab 名等价改写。
- **空态通过**：`emptyCopy()`（`:488`）/ `TabEmpty()`（`:1953`）按 UI-DESIGN §10.3 与 STATE-UI 口径——今日无记录由汇总块给「今天还没有日程」且不在列表重复渲染；未完成无记录、今日全已完成且开关关均给「没有未完成的日程」；有搜索/作者时仍走 `EmptyResults()` + 清空。旧文案「所有日程都已完成」「这一天还没有日程」已删除（grep 无命中）。
- **无残留**：`showAllPending` / `statusFilter` / `StatusChip` / `pickStatus` 在 `.ets` 源码中零命中（仅在 ban 断言与构建缓存里作为字符串出现）；无新增依赖、无 `devices/**` 写入（git status 证实）；`tsc` 0，首轮构建因陈旧 `showAllPending` 失败的问题已消失。

## 测试判定
- `tools/test/homeFilters.test.mjs` **16 例全绿**，是真实契约：默认值/控件数(`:109,117`)、开关只在今日(`:124`)、计数不取可见列表(`:195`)、排序键先后(`:169`)、空态文案(`:202`)、撤销/汇总/两断点渲染仍在(`:213`)、旧标签消失(`:144`)。若开关泄漏到未完成、计数缺失、旧标签回归，均有断言失败；守卫用「按字符拼出的带引号精确标签」（`:100-106`），`显示已完成` 不会误触，同时不扫描编辑器/详情的逐条状态文案——符合要求。
- 8 个 retarget 均为**等价改写且多处加强**，不是削弱：`b3Batch`（早退 3 条保留）、`timelineService` / `v2Only`（`pendingSorted` 断言 + 新增 `pendingSorted` 内调 `pendingRecords`）、`uiTokens`（新增 `return '未完成'`）、`query`（新增 `record.done !== true`）、`b4CalendarWiring` / `b3Batch` / `openIndex` / `deviceAccept`（状态名/文案逐字迁移，用例数不减）。
- 唯一守卫缺口见 P2-2；另 `:124` 为包含式文本断言，若未来把 Toggle 复制一份到 if 之外不会被抓到（当前无此重复）。

## UX-STEPS 判定
- **诚实**。`docs/UX-STEPS.md` §4.7 已落地，与 §1 口径、§2 五条路径明细、§4.5/§4.6 的 31 步承接一致：5 个筛选控件从未列入 §2 任一路径，属 §1.3「不计入」的可选控件；新开关默认关、不进任何算式 ⇒ **Δ0、合计仍 31**，无虚构减步。§4.7 与 UI-DESIGN §10 表述互相印证；真机排布/Toggle 触控列为 `unverified`。

## 门禁（本机复现，tail）
```
overlay.mjs status   → 覆盖层：未应用（共享源码 + 平台目录原始形态） / [overlay] applied=false
tsc -p tools/tsconfig → EXITCODE=0
node --test homeFilters.test.mjs → ℹ tests 16 / pass 16 / fail 0 / skipped 0
node --test 全量 → ℹ tests 2897 / suites 329 / pass 2896 / fail 0 / skipped 1 / duration_ms 40674.543
validate-app.mjs → ✅ 全部通过：8/8 条规则（相对 import 426、main 静态 import 546、页面 7、rawfile/git 2）
```

## unverified
- 真机/DevEco 缺席：两 tab + 开关的实际排布、Toggle 触控反馈、拨开关后计数与副标题的刷新观感、横竖屏断点下的呈现；`hdc list targets` 为空。
- `tsc` 仅覆盖 `model/**/*.ts` 与 `common/**/*.ts`（tsconfig exclude pages/components/services），**未编译 `.ets`**；ArkTS 真机编译与本模块 UI 行为未验。
- `device-accept.mjs` 的 8 步验收在无设备时仍走 SKIP 分支，新 `byText(flat,'未完成')` 定位未在真机验证。
