# REVIEW — mod-shell-rail（独立只读评审，2026-11-21）

范围：未提交工作树的新增/改动文件（ShellRail、Home、shellLayout 与三份 retargeted 守卫、两份 main_pages）。
下列行号来自实读：`H=` `apps/arkui-schedule/entry/src/main/ets/pages/Home.ets`，`R=` `.../components/shell/ShellRail.ets`，`S=` `.../tools/test/shellLayout.test.mjs`（完整路径前缀同上）。

## 结论

- **P0 0 / P1 0 / P2 3（均不阻塞）→ 可以提交**。四节平级、单 flex 层、keep-alive、行为与占位均达标；守卫是纯增量超集。
- 唯一硬限制：`Home.ets` / `ShellRail.ets` 的 **ArkTS 编译 `unverified`**（见 §7），不是缺陷而是验证边界。

## 1. 四节平级 + 齿轮是出口（PASS）

- 顺序表 `R:90-95` = `dots / schedule / instances / cloudChat`；`R:275-277` 单一 `ForEach(SHELL_SECTION_ORDER)` 渲染，四节共用 `SectionRow`（`R:178-227`），结构逐字一致；`S:229` 与 `structureGuards.test.mjs:268` 双向钉死顺序。
- 无主次样式：选中仅改底色（`R:143-151`）、字色（`R:154-156`）、2vp 竖条（`R:31-32,181-187`）；无图标字体/角标/主按钮，唯一 glyph 四节等权（`R:65,72,79,86`）。
- 齿轮是 footer 动作：`R:279` `Blank()` + `R:282-285` `Divider()` + `R:285` `SettingsRow()`；只发 `onOpenSettings`（`R:268-270`），跳转唯一在 `H:169-175`。

## 2. 布局纪律 / 布局树证据（PASS）

```
H:333 Stack(root, alignContent TopStart)          ← 只放覆盖层
├─ H:334 Row()                                    ← 唯一 flex 切分容器
│  ├─ H:336-347 ShellRail(compact:false)          ← 非 compact 才装配
│  └─ H:350-359 Stack(content).layoutWeight(1)    ← 全文唯一结构性 layoutWeight(1) (H:358)
│     ├─ H:351 DotsPane   → H:217 Scroll → H:218 Column → .visibility(Hidden) H:247
│     ├─ H:352 SchedulePane → H:254 Scroll → H:255 Column → .visibility(Hidden) H:274
│     ├─ H:353 RemotePane   → H:281 Scroll → H:282 Column → .visibility(Hidden) H:301
│     └─ H:354 ChatPane     → H:308 Scroll → H:309 Column → .visibility(Hidden) H:328
├─ H:364-372 scrim Stack (compact && drawerOpen)  ← 点按关抽屉
└─ H:375-387 ShellRail(compact:true)              ← Visibility.None 挂起，不 unmount
```
- 四面板无 `if/else`、无条件实例化（`H:351-354`），`Visibility.Hidden` 保活；`H:197` 的第二处 `layoutWeight(1)` 只是 PaneHeader 标题省略号，非切分；`S:82-110` 断言 Row→Stack 之间无 Column、内容区 `height('100%')` 非固定 vp。

## 3. 行为表（PASS）

| 场景 | 结果 | 证据 |
| --- | --- | --- |
| 默认分段 | dots | `H:83`；常量来自 R `H:53` |
| 深链 `section` | 只见四个合法 id，其余 fail-closed 回落 dots | `H:66-77`；参数异常 catch 同样回落 `H:93-108` |
| 深链 `id` | 原样存 `deepLinkId` 传给面板（S3/S4 消费） | `H:98-101,351-354` |
| 返回键：抽屉开 | 关抽屉、返回 true（吃掉） | `H:115-118` |
| 返回键：非 dots | 回 dots、返回 true | `H:119-122` |
| 返回键：dots | 返回 false（放行退出） | `H:123` |
| 断点 | `onAreaChange → resolveBreakpoint(width, isLandscapeSize(...))`，只看 `'compact'`；横屏至少 medium | `H:138-160,391-393`；无硬编码 600/840 |
| compact 抽屉 | scrim + 点蒙层关 + 点分段关（`selectSection` 统一关） | `H:163-166,364-387` |

## 4. 占位真实性（PASS）

- dots：禁用 `TextInput`（`H:231-235`）+ 逐字原因 `dots 尚未接线`（`H:61,236`）+ 空聊天气态（`H:220-230`）。
- 其余三节各一句「…即将迁入，本页暂不展示任何记录。」（`H:263,290,317`），无假行；`S:213-223` 断言四面板内无 `ForEach / RecordRow / Checkbox / 示例 / Lorem / 假数据`。
- 每个面板页头均 `PaneHeader(标签, 动作, REASON_*)`（`H:219,256,283,310`），动作槽 `Text(\`动作（原因）\`)` 且 `.enabled(false)`（`H:200-206`）；全页仅 2 处禁用源码（共享 builder + dots 输入框）。

## 5. 守卫超集与回归有效性（PASS）

| 文件 | 旧断言 | 处理 | 新增 |
| --- | --- | --- | --- |
| `indexHeader.test.mjs` | 原 4 例 | 一条未删，仅改 describe 为「日程面板契约」（diff 无断言删除行） | H-1…H-4（`:127-179`） |
| `uiTokens.test.mjs` | 原 38 例 | 断言零删除（diff 纯新增） | U-S1…U-S4（`:446-498`） |
| `structureGuards.test.mjs` | 原 8 例 | 断言零删除；覆盖率用例扩展 2 行（`:226-227`） | SG-S1…SG-S3（`:239-280`） |
| `shellLayout.test.mjs` | — | 新文件 | L-01…L-16（16 例） |

三处 retargeted 共新增 11 例，加 shellLayout 16 例 = 27 条新守卫；超集成立。
**会真实失败的回归（举 3）**：① 把四面板改成 `if/else` 切换 → `S:133`（content 内不得有 `if(`）；② 任一面板 `Hidden` 改 `None` → `S:137-146`（要求恰好 4 处 Hidden、面板内零 None）；③ 调换 `SHELL_SECTION_ORDER` 顺序 → `S:229` + `structureGuards.test.mjs:268` deepEqual 失败。另：`build()` 多加一处结构性 `layoutWeight(1)` → `S:84`；dots 也返回 true → `S:176-177`。

## 6. 门禁尾部（顺序重跑，overlay applied=false）

```
tests 78  suites 5  pass 78  fail 0  skipped 0   duration_ms 382.4072
tests 3008 suites 357 pass 3007 fail 0 skipped 1 duration_ms 488666.4506
TSC_EXIT=0
✅ 全部通过：8/8 条规则（JSON5/JSON 70、相对 import 426、main 静态 import 548、页面 9、rawfile/git 2）
```
四门禁全部符合预期（78/78；3008/3007/0/1；8/8 页面 9；tsc 0）。注意：并行跑四门禁会因共享 overlay 串扰产生假失败（theme `Color.White 2≠1`、validate 规则 4 → 7/8）；`overlay restore` 后顺序重跑即全绿（P2-3）。

## 7. ArkTS 卫生 / `unverified`（必读）

- 未发现对象字面量当类型、`unknown` / `any` / `in`：`H:95` 是 `as Record<string, string>`（工具类型断言）；`H:210` 是 `.border({...})` 值字面量，均非类型位置。ShellRail 零命中（grep 实测）。
- **`tools/tsconfig.json:28-34` 明确排除 `pages/` 与 `components/`：tsc 只编译 `model/` + `common/`，不编译这两个新文件；`TSC_EXIT=0` 不能证明 ArkTS 可编译。**
- 结论：`Home.ets` / `ShellRail.ets` 的 ArkTS 编译与真机观感 **`unverified`**；本次评审期间观察到外部 `deveco-cli build` 进程在运行，但无可读的完成产物/日志可引用，故不据此改判。

## 8. P2 findings（不阻塞）

- **P2-1** ArkTS 编译未验证（§7），首次真实编译留给设备 pass。
- **P2-2** 选中态多了 `fontWeight Medium/Normal`（`R:201`），略超 UI-DESIGN §12 字面「只改底色/字色 + 竖条」；四节完全对称、无主次暗示，仅记录。
- **P2-3** 四门禁不可并行（§6 注），建议 Lead 顺序执行并先确认 `overlay applied=false`。
