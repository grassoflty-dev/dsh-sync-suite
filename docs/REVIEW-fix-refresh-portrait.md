# 评审：mod-fix-refresh-portrait（独立只读评审；未提交改动，磁盘代码为最终态）

## 结论
P0 **0** / P1 **0** / P2 **3**（均非阻断）。**可以提交**——五门闸全绿，两栏共用同一刷新路径，周期/三态/布局纪律均完好；提交前请 Lead 处理 F2 的模块 id 与文档登记。

## Findings（file:line）
- **F1（P2，叙事非缺陷）** `SchedulePane.ets:13-17` 的注释说「竖屏之前拉不动」；但旧注释（HEAD）记载的是：迁移时 `CompactBody`/`RightPane` 继承了 Index 的 `Refresh`，**漏掉的是 `WideBody` 左栏**，由前一模块 `mod-home-pull-refresh` 补回——历史上缺 Refresh 的是横屏主从左栏，不是竖屏。`git diff` 也显示 HEAD 的 `CompactBody`（`:1799-1812` 的 `-` 行）与 `WideBody` 左栏**都**已有内联 `Refresh`。本批真实作用是把两处内联复制收敛为共享 builder，列表 `Refresh` 数 3→2（两处列表合并为一处共享 + 右栏不变），不是「给竖屏补 Refresh」。代码正确，仅注释叙事与 diff 不完全吻合。
- **F2（P2，流程）** 模块名不一致：文件头写 `mod-fix-pull-refresh-shared`（`:13`），评审对象为 `mod-fix-refresh-portrait`；`docs/MODULES.md` / `ROADMAP.md` / `UI-DESIGN.md` 本轮新增登记的是 `mod-pane-header-nav-dedupe`，**没有**本模块的登记与回滚路径。提交前统一 id 并补 §5/§6 登记。
- **F3（P2，残留不对称）** fallback `Index.ets:1803-1812` 的 `CompactBody` 仍内联 `Refresh`，`Index.ets:1852-1856` 的 `WideBody` 左栏没有 `Refresh`；`syncWiring.test.mjs:860-862` 只断言 fallback「有一处 Refresh」。默认启动页是 `pages/Home`（`paneLayout` P-12），全仓无 `pushUrl('pages/Index')`，不影响默认路径；若允许深链回退到 Index，横屏仍拉不动。

## 两栏 body 对照（SchedulePane.ets）
| body | 断点 | 行号 | Refresh 接线 |
| --- | --- | --- | --- |
| `CompactBody()` | 竖屏/紧凑（<840vp，masterDetail=false） | 定义 `:1786`，调用 `:1802` | `this.RefreshableList()` → 唯一列表 `Refresh` |
| `WideBody()` | 横屏/宽屏（≥840vp） | 定义 `:1825`，左栏调用 `:1843` | `this.RefreshableList()` → 同一处共享 `Refresh` |
| `RefreshableList()` | 共享 | `:1708-1724`，`Refresh` 在 `:1710` | 唯一列表拉取入口；`onPullRefresh()` 在 `:1715` |
| `RightPane()` | 宽屏右栏 | `:1728`，独立 `paneRefreshing` `:1729` | 单独 `Refresh`，复用同一 handler（`:1768`） |

两栏**都**携带包装，实际 `Refresh(...)` 组件只声明一次（`:1710`）；两栏都不再内联 `Refresh`、不再直渲 `RecordList()`。`ListRows()` 的 `List().layoutWeight(1)`（`:1665`）与两栏包裹层 `Column().width('100%').layoutWeight(1)`（`:1805` / `:1846`）均无定高，无嵌套固定高度外壳（横屏列表 0 高 bug 类未回退）。

## 同步周期 / 三态状态行
- 周期：`:310-325` `bindBridgeRunner` → `setSyncing()` → `await syncProtocolStore.runConfiguredCycle()`（pull+push 完整周期）→ `fromCycle()` / `setFailed()` → `reload()` + `loadSummary()`（`:323-324`）→ **重绘成立**；非 `syncController.pullNow`（测试 62 显式否定）。`retrySync()` `:332-352` 同处再绑定并跑周期。
- 三态行：`SyncStatusRow()` `:1610-1636` 显示 `syncStatus.text` 并按 `state` 着色；失败态 `:1623-1631` 保留「重试同步」点一下 → `retrySync()`。文案前缀来自 `syncStatusStore.ets:42-44`（`已同步 · ` / `同步中…` / `失败：`）。两栏均渲染（`:1791` / `:1831`）→ **三态 + 点重试完好**。

## 测试
- `paneLayout.test.mjs` P-06（`:217-242`）：遍历 `['CompactBody','WideBody']`，各断言恰好一次 `this.RefreshableList()`、无内联 `Refresh({`、无直渲 `RecordList()`、包裹层 `layoutWeight(1)` 且无固定高度；共享 builder 钉住 `RecordList`/`Refresh`/`onPullRefresh`/两处 spinner 复位。
- `syncWiring.test.mjs` #62（`:814-864`）：两栏 + 同一 handler + 同周期断言 + 布局纪律；#62b（`:866-883`）：三态三文案 + 点重试 + 两栏都显示 `SyncStatusRow()`。
- `uiTokens.test.mjs:184-190` 把 WideBody 骨架锚点 retarget 为 `this.RefreshableList()`；`shellLayout.test.mjs` 未改（只钉外壳几何）。**两栏与同一 handler 均被断言**，旧断言未删（retarget + 收紧）。

## 门闸 tail
```
[1] 四守卫: ℹ tests 138 | ℹ pass 138 | ℹ fail 0 | ℹ skipped 0
[2] 全量:   ℹ tests 3151 | ℹ suites 373 | ℹ pass 3150 | ℹ fail 0 | ℹ skipped 1
[3] tsc:    EXIT=0（无输出）
[4] validate: ✅ 全部通过：8/8 条规则（JSON5/JSON 70、相对 import 500、main 静态 import 657、页面 12、rawfile/git 2） EXIT=0
[5] overlay: [overlay] applied=false；覆盖层：未应用（共享源码 + 平台目录原始形态） EXIT=0
```
与期望一致：**3151 / 3150 通过 / 0 失败 / 1 跳过**；validate 8/8；tsc 0；overlay false。

## unverified
- **真机下拉手势（竖屏 + 横屏各一次）未验证**：本机无设备/hdc，无法注入 `Refresh → onRefreshing`；需真机拉一次确认 spinner 起停、git 周期与三态刷新。
- ArkTS 编译 / 真机观感未验证：`tsc` 只覆盖 `tools/tsconfig.json` 的纯 TS（`pages/` 被排除），与 UI-DESIGN §12 同口径。
- F3 的 fallback 深链是否可达仅做静态检索（无 `pushUrl('pages/Index')`），未做运行时验证。
