# 评审：mod-shell-schedule-pane（3a0ca47）

> 独立只读复核，不重开提交。HEAD=`2f7200d`（docs 回填），被评提交 `3a0ca47` 为其父。
> `git stash list` 为空；工作树含 settings lane 未提交改动（RemoteSection 删除等），本次未写入任何源码。

## 1. 结论
- **P0 0 / P1 0 / P2 3**；**可接受**：布局纪律、保活、入口翻转、占位诚实四项核心契约全部成立，三道门闸全绿。
- **需修复**：无。P2 为后续真机 pass / 提交卫生的跟进项，不阻塞合入；无 P0/P1，故无需新开模块。
- 六项验证：①布局 ②保活 ③入口/fallback ④占位 ⑤守卫超集 = **PASS**；⑥ArkTS 编译 = **unverified**。

## 2. Findings（file:line）
- **F-1（P2，陈旧产物）** `apps/arkui-schedule/entry/build/default/cache/default/default@CompileArkTS/esmodule/debug/entry/src/main/ets/entryability/EntryAbility.ts:71` 仍 `loadContent('pages/Index')`；该缓存 `git ls-files` 计数 0（未跟踪生成物）。唯一 HAP `dist-harmony/arkui-schedule-harmony-debug-signed.hap`（2026-11-21 11:56:17）早于提交（13:09:48）。源码入口唯一正确，但装机前必须重建，否则仍从 Index 启动。
- **F-2（P2，编译边界）** `apps/arkui-schedule/tools/tsconfig.json:24-34` 只 include `model/**/*.ts`+`common/**/*.ts`，明确 exclude `pages`/`components`/`services`/`entryability`；`pages/panes/*.ets`、`Home.ets`、`EntryAbility.ets` 不在 `tsc` 覆盖内。无 `3a0ca47` 构建证据（§15.14 的 S5 构建时首页仍是 Index，见 `docs/VERIFICATION.md:1610,1622-1625`）。
- **F-3（P2，守卫可追溯）** `tools/test/b3Batch.test.mjs` C 段与 `tools/test/structureGuards.test.mjs` 的部分 retarget 以 settings lane 已删 `RemoteSection`/`normalizeRemoteOnBlur` 为前提；当前全绿是在这些**未提交**改动之上取得，干净 `3a0ca47` checkout 下未验证（只读评审未另建 worktree）。非本提交缺陷，settings lane 落定后需复跑。
- **F-4（info，面板内 flex）** `pages/panes/SchedulePane.ets:2065` 仍用 `PageLayout` 页头+内容壳（flex：`components/PageLayout.ets:135/202/206`），与迁移前 Index 同构；"唯一 flex 层"契约只对 `Home.build()` 成立（L-02/P-02 只扫 build()），它不是固定高度 Column 包裹层，不回退横屏 bug。

## 3. 布局树证明
```
Home.build()  root Stack (:172)
├─ Row (:173, 唯一横向 flex)
│  ├─ ShellRail (:176, 非 compact；抽屉轨 :241-252 用 Visibility.None)
│  └─ Stack (:189) .width/.height('100%') .layoutWeight(1) (:207-209)  ← 全页唯一结构性切分
│     ├─ DotsPane       (:190) active: section === DOTS
│     ├─ SchedulePane   (:194) active: section === SCHEDULE
│     ├─ InstancesPane  (:198) active: section === INSTANCES
│     └─ CloudChatPane  (:202) active: section === CLOUD_CHAT
└─ 覆盖层：scrim / ☰ / 抽屉轨 (:215-253)
```
- Row 与内容 Stack 之间无 Column（L-03/P-02）；内容 Stack 无 Column/Scroll（L-04/P-03）。四个外部 `@Component` 无条件实例化、顺序固定、无 `if/else`（L-05/P-07）；非当前面板由 `active → .visibility(Visible/Hidden)` 保活（`DotsPane:81`/`InstancesPane:76`/`CloudChatPane:76`/`SchedulePane:2123`，L-06/P-08），Hidden 留在树上，@State/滚动位置不丢。
- 各面板自带滚动：`DotsPane:31`、`InstancesPane:31`、`CloudChatPane:31` 根 `Scroll()`；`SchedulePane:1289` 汇总块自带 `Scroll()`。
- 横屏零高度 bug 类不回退：`SUMMARY_BOX_MAX_HEIGHT=80`（`SchedulePane:139`）；汇总根 Scroll `.constraintSize({ maxHeight: this.masterDetail ? SUMMARY_BOX_MAX_HEIGHT : undefined })`（:1424）→ 有界固定高度兄弟；记录 `List().layoutWeight(1)`（:1656）+ 两断点加权包裹 Column（Compact :1766-1778 / Wide :1813-1817）。列表永远拿到余量（P-04/P-05/P-06）。
- Home 全文 `layoutWeight(1)` 仅 1 处（:209）；日程面板内的主从/列表加权属于面板自身，与外壳切分不同层级。

## 4. 入口 / fallback 证明
- `entryability/EntryAbility.ets:98` `windowStage.loadContent('pages/Home', …)`；全仓源码仅此一处 `loadContent`（另两处为 test 断言与未跟踪缓存 F-1）。
- main `main_pages.json`：9 页，`pages/Index`:3、`pages/Home`:11；harmony `main_pages.json`：10 页真超集，`pages/Index`:3、`pages/Handwriting`:7、`pages/Home`:12。两份均保留 Index 路由且无重复（L-17/P-13）。
- `pages/Index` 仍可被 `router.pushUrl('pages/Index')` 到达；validate-app 页面计数 9；`docs/UI-DESIGN.md:504` 明确其为 fallback、日程正文已迁入 `SchedulePane.ets`。无其它源码声明启动页。

## 5. 占位诚实性表
| 面板 | 假行 | 禁用主操作（含原因） | 逐字说明 |
| --- | --- | --- | --- |
| DotsPane | 无（无 `ForEach`/`RecordRow`，L-13/P-15） | `新建对话（dots 尚未接线）` `.enabled(false)` (:42-48) | `dots 尚未接线` (:21/:70)；禁用输入框 (:65-69, P-17) |
| InstancesPane | 无 | `添加实例（远程面板即将迁入）` `.enabled(false)` (:42-48) | `实例列表与连接操作即将迁入，本页暂不展示任何记录。` (:60) |
| CloudChatPane | 无 | `新建对话（云端对话即将迁入）` `.enabled(false)` (:42-48) | `会话列表与只读详情即将迁入，本页暂不展示任何记录。` (:60) |
| SchedulePane（真 body） | 有真行 `ForEach(this.visibleRecords)`/`RecordRow` (:1633-1650) | 无禁用动作；唯一 ⚙ 设置出口 (:2069) | 两 tab / 搜索 / 汇总 / 撤销 / 加权列表（L-18） |

## 6. 守卫超集表
| 守卫 | 被替换/原有 | 现状 | 结论 |
| --- | --- | --- | --- |
| shellLayout.test.mjs | 旧 S4 几何/保活/占位断言 | L-01..L-18（18 例），新增入口翻转 L-17、真 body L-18 | 超集 |
| paneLayout.test.mjs | 无（新文件） | P-01..P-18（18 例，353 行），面板本体/列表高度纪律 | 超集 |
| indexHeader | 原 4 例逐字不动，仅锚点 Index→SchedulePane | H-1（3 占位标签+日程真页头+rail 日程标签）、H-2 禁用 2→4（per-file） | 等价或更强 |
| uiTokens | U-S2/U-S4 旧断言（subtitle/pageTitle 等）保留 | 3 占位标签 + rail `日程`；禁用计数 2→4；`headerActionTwo` 保留 | 等价或更强 |
| structureGuards | 扫描去掉 RemoteSection；Settings 校验字段下限 10→6（附逐字段删除理由） | 新增 STATE_READ_ALLOWLIST、四面板进扫描集、SG-S4（id/active 双向装配）、SG-S5（入口/fallback） | 超集（下限下调有等价理由：字段已被其它模块删除） |
| homeFilters / b3Batch | 锚点 Index→SchedulePane；B3 C 段 old→new | 双格条绝迹 + 主操作落在加权区之后（收紧）；C 段改为「删除+入口唯一+迁移幂等」 | 超集（F-3 依赖 settings lane） |

**真回归会失败的 3 条 paneLayout 断言**：① `P-04`（:161）记录 List 去掉 `.layoutWeight(1)` → 横屏零高度复发；② `P-05`（:171/:174）SummaryCard 去掉 `constraintSize maxHeight` → 汇总重新吃掉列表；③ `P-07`（:207）内容 Stack 内出现 `if (` → 面板卸载、@State/滚动位置丢失。（另 P-01 :94-97：双份 body 会双渲染。）

## 7. 门闸 tail（当前工作树，settings lane 改动在场）
```
git stash list:    (空)
GATE node --test:  ℹ tests 3015 / suites 359 / pass 3014 / fail 0 / skipped 1   (EXIT=0)
GATE tsc:          (无输出)  EXIT=0
GATE validate-app: ✅ 全部通过：8/8（JSON5/JSON 70、相对 import 459、main 静态 import 585、页面 9、rawfile/git 2）  EXIT=0
```
- 3015 对文档基线 2306 的差额来自未提交的 settings lane 新增测试（如 `tools/test/modSettingsSyncMin.test.mjs`），非本提交缺陷；未触发「失败即本批修」分支。
- 复核期间 settings lane 并发改动工作树（新增 `pages/Chats.ets`、`CloudChatPane.ets` 只读说明行等）；上述门闸为某一时刻快照，本评审的所有 file:line 证据以 `git show 3a0ca47` 提交内容为准；末次复跑 `shellLayout` / `paneLayout` 仍全绿。

## 8. unverified（编译！）
- `tsc` 只编纯 TS；`pages/panes/*.ets`、`Home.ets`、`EntryAbility.ets` 在 `tsconfig.json:28-34` 被排除，`tsc EXIT=0` **不能**证明其 ArkTS 编译通过。
- 无 `3a0ca47` 的构建/装机证据：唯一 HAP 早于提交；`docs/VERIFICATION.md:1604-1610` 的 S5 构建验证的是 Home 尚未成为入口的旧树。四节交互、Home 作为入口后的真机行为、横屏 2560×1600 布局仍 **unverified**（设备物理竖屏，§15.14:1612-1614）。
