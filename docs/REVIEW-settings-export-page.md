# REVIEW — mod-settings-export-page（独立只读审查）

## 结论
- P0：0；P1：0；P2：3（均非阻塞：1 项环境、2 项可维护性/说明）。
- **可以提交**：真页面、正文不变、patch 安全、守卫只增不减，三步针对性 gates 全绿。
- 全量套件 / validate-app 当前为红，但 16 个失败 100% 归因于 **device/harmony build lane 的 platform overlay 仍处于 applied**（foreign lane），非本模块缺陷，见 §gate。

## findings（file:line）
- P2-1（环境 / foreign lane）`apps/arkui-schedule/.platform-overlay/manifest.json:1-14`：overlay applied=true（3 替换 / 4 新建，2026-11-21T07:46:46Z）→ validate-app 规则 4 与 16 个测试失败；本模块代码无涉，由 device lane restore 后复跑。
- P2-2（可维护性）`pages/SettingsExportImport.ets:70-89`：自带 `SettingsZipBridge` 与 `pages/SettingsSync.ets`（mod-settings-sync-page lane）同名类重复；本模块自包含，属可接受重复，抽取共享适配器非本批范围。
- P2-3（说明，非缺陷）`pages/SettingsExportImport.ets:125`：bootstrap 只调 `settingsStore.init`，不 load/save 任何配置键，符合「不写配置」纪律；init 本身无消费者，可后续清理。

## 页面结构证明（page-structure proof）
- `:93` `@Entry/@Component struct`；`:95-96` 自有 `@State`（exportImport / ready）。
- `:101` `pageScroller: Scroller`；`:466` `Scroll(this.pageScroller)`。
- `:457-462` `PageLayout({ title: '数据导入导出', onBack: () => router.back() })`（`:461` `router.back()`）。
- 唯一 flex 层：`:474` `.layoutWeight(1)` + `:479` `this.PrimaryExportButton()` → `:442` `Button('导出')`。
- `:413-437` `DataGroup()` → `:415` `DataSection({...})`；`:64` import DataSection。
- 无 `SettingsHost({` / `SECTION_DATA` / `section:'data'`（M-08 `:115-116` 断言 + 源码 grep 0 命中）。

## body-invariants table
| 不变量 | 证据 | 结论 |
| --- | --- | --- |
| 今天/本周/近 7 天 chip | `model/exportImport.ts:970-975` + `ExportImportPanel.ets:357-375` `ForEach` | 保持 |
| 两个日期字段 | panel `:319-333` FromInput / `:337-351` ToInput，build `:451-455` | 保持 |
| 导出完整包 | panel `:460-471` | 保持 |
| 选择文件 | panel `:497-508`，`pickLabel()` `:171-173` | 保持 |
| 确认导入 | panel `:544-557`，`confirmLabel()` `:176-184` | 保持 |
| 无「填今天」 | 仅注释 `model/exportImport.ts:944/947`；剥注释断言 M-08 `:139` / C2 `:164` | 保持 |
| 无「日程备份」节 | 仅注释 `ExportImportPanel.ets:10`；M-08 `:140` / C3 `:180-188` | 保持 |
| 媒体留在主流程 | page `:164` exportV2Timeline / `:218` planV2ImportFromPicked / `:384` applyV2Import | 保持 |

## patch-safety proof
- store 是 patch：`services/settingsStore.ets:559` `async save(patch: SettingsPatch, …)`；`:564` `const current = await this.load()`；`:617-618` `repoUrl/token: patch.X === undefined ? current.X : …`（undefined 保留磁盘值）。
- 导出页零配置键写入：`:125` 仅 `settingsStore.init`；`:181/:306/:399` 仅成功分支写 AppStorage 两个时刻键（`:168/:298/:388` 先判 `!ok` 早退）；全页 grep 无 `settingsStore.save(`。
- 新 `M-09`（`settingsMenu.test.mjs:148-169`）钉住：store 三段切片（save / ScheduleSettings / SettingsPatch）、`:157-159` patch 基于 current、`:158-159` repoUrl/token 未提供保留、`:161` 两 shape 无导出键、`:163-165` 宿主 load 全量 + patch + 不写时刻键、`:166-168` 导出页不写配置对象 + 三处成功时刻。
- 宿主剩余 save（`SettingsHost.ets:496-601`）仍显式写 repoUrl/token（API 子页路径），token 经 `effectiveToken(`:544`)` 空输入沿用；本模块不复用宿主，故不可能清空它们。

## guard-superset table（old → new）
| guard | old | new | 判定 |
| --- | --- | --- | --- |
| settingsSources.mjs | readSettingsPage→host | `+readExportPage :54-56`，sources 加页 `:88` | 新增 |
| settingsMenu | 无导出断言 | `+M-08 :104-142`、`+M-09 :148-169` | 新增 |
| settingsCopyGuard C3 | `readSettingsPage()`(host) | `readExportPage()` `:178-180` | retarget，断言不变 |
| settingsCopyGuard C2 | 无真页断言 | `+exportPage` 断言 `:159-164` | 新增 |
| structureGuards | 装配点 host | `+PAGE_EXPORT :43`、propWiring 拆分 `:145-148`、死状态扫描 `:270` | 新增/拆分 |
| uiTokens U-S5 | 两页当薄壳 | 真页断言 `:559-564`；push 唯一性 for-loop 仍在 `:544-547` | 收紧，未删 |
| exportImport | PAGE_SOURCE=host | PAGE_SOURCE=SettingsExportImport `:765-769` | retarget，断言不变 |
| exportImportV2 | SETTINGS=host | SETTINGS=SettingsExportImport `:92-96` | retarget，断言不变 |
| remoteSettings | 切片末标记 `@Builder\n  DataGroup()` | `@Builder\n  AboutGroup()` `:73` | retarget，断言逐字不变 |

- 8 项全部 old→new 等价或收紧；**无断言被删除**（uiTokens 薄壳断言被更强的真页断言取代，C2/C3/M-08/M-09 为新增）。
- remoteSettings 末标记判定：`DataGroup` 已随本模块从宿主删除（HEAD 4 处→现 0），`bodyOf` 必须有后继标记；当前宿主 `:1445 RemoteGroup()` 紧跟 `:1450 AboutGroup()`，切片仍完整覆盖 RemoteGroup 且四条断言未改 → **executor 所说 unavoidable 成立，且非放宽**。

## gate tails（foreign failures separated）
- `tsc -p tools/tsconfig.json`：EXIT 0（空输出）。`tsconfig.json:24-34` 仅含 model/common，`.ets` 在 exclude → 编译未覆盖本页。
- targeted 3 files：`125 tests / 125 pass / 0 fail`；M-08 / M-09 全绿。
- full suite：`2747 tests / 2730 pass / 16 fail / 1 skip`。16 失败全部 foreign：12 文件因 `requireOverlayRestored` 拒绝运行（contractGaps、freshStart、platformDetect、structureGuards、syncProtocol、syncWiring、theme、timelineService、timelineWrite、twoDevice、v2Only、v2SummaryImport）；4 条页面计数断言因 overlay 把 harmony `main_pages.json`(13) 盖到 main（C7 / L-01 / L-17 / P-13，actual 13 expected 12）。归因 lane：**device/harmony build lane — overlay applied**。
- `validate-app`：EXIT 1，7/8 规则过；规则 4 的 10 个问题全在 overlay manifest 的 4 个手写 / OCR 文件（platformFeatures、HandwritingPager、OcrBatchManager、pages/Handwriting）→ 同一 foreign lane。
- `overlay status`：`applied=true`（3 替换 / 4 新建，07:46:46Z），期望 false；由 device lane restore。
- 本模块相关守卫 M-08 / M-09 / C1 / C2 / C3 / exportImport / exportImportV2 在 targeted gate 全绿；structureGuards 因 overlay 未能运行（静态阅读已确认锚点与断言完整）。

## unverified
- ArkTS 编译与真机交互（文件选择器、导出落盘、导入确认框、`router.back` 观感）未验证：`.ets` 不在 tsc 范围，现存 .hap 为旧批次产物、非本模块构建；设备 lane 在跑。
- structureGuards 本轮运行时结论（overlay applied 硬失败），需 restore 后复跑。
