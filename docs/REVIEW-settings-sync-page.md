# 独立只读评审：mod-settings-sync-page（同步仓库真页面）

基线：工作区未提交树；行号为评审时快照。他人车道在途改动一律标 foreign，不计本模块缺陷。

## 结论

- **P0：0　P1：1（阻断）　P2：0**
- **不可提交**：P1 未修前提交必在 ArkTS 编译期失败；修掉后其余 7 项验证点全部成立。
- P1：调用未导入的符号——`pages/SettingsSync.ets:496` 用
  `describeIdentityConflict(normalizeDeviceId(this.deviceId))`，但本页 `:17-79` 的 import 区没有它。
  HEAD 的 `SettingsHost.ets` 曾 `import { describeIdentityConflict } from '../../model/deviceIdentity';`
  并作同一调用；迁正文时只搬调用、漏搬 import。修：
  `import { describeIdentityConflict } from '../model/deviceIdentity';`。
  `.ets` 不在 tsc 范围，现有 gate 抓不到；下一次真机 build 必报「Cannot find name」。

## Findings（file:line）

1. **P1** `pages/SettingsSync.ets:496` / `:17-79`：`describeIdentityConflict` 无 import（详见结论）。
2. 非缺陷（接受偏差）：`pages/SettingsSync.ets:293-300` 的 patch 额外携带
   `authMode/gitUsername/gitPlatform`。本页无这三个输入控件
   （`components/settings/SyncSection.ets:253,274` 仅两个 `TextInput`；`authMode` 只由
   `:337-343` 的**单向** SSH→HTTPS 按钮修改，不能切回 SSH），故不扩大用户可配范围；
   `authMode` 不写盘则 SSH 切换无法持久，属必需。
3. 非缺陷：宿主仍持同步 `@State` 并在 `components/settings/SettingsHost.ets:543,545` 回写
   仓库地址/令牌，值来自 `:318,365-366` 的 `load()`，是「loaded bytes 原样回写」；
   用户唯一可编辑写入口是本页。`services/GitSyncService.ets:1569,1706,1907,1939` 的
   save 只写设备标识/指纹类键，不写 `repoUrl/token`。

## 页面结构证明（验证点 1–3）

- 自有状态与容器：`SettingsSync.ets:91-92` 自有 `@State repoUrl/token`（另 `:113-131`
  为状态/失败出口），`:137` 自有 `Scroller`；`:812-887` 只有一层 flex
  （`Column → Scroll.layoutWeight(1) → SaveButton`），无嵌套固定高度外壳；
  `:804-810` `PageLayout(title:'同步仓库')`；`:816-870` 装配 `SyncSection({...})` 并传全部
  props/callbacks（structureGuards 双向装配通过）；全页无 `SettingsHost({...})`
  （M-07/U-S5 断言通过）。
- 正文保持 presentational：`SyncSection.ets:65-66` 只导出 `@Component`，`:73-76` 收 `@Prop`、
  `:110-121` 收回调、本组件不写状态；`:253,274` 恰两个输入框（仓库地址/访问令牌），
  无「高级」、无 `推送/立即同步`。
- 诚实状态行：`SettingsSync.ets:534-539` `honestStatus()` = 忙碌 `同步中…`，否则
  `syncRowSummary(lat,err)`；`model/settingsMenu.ts:40-48` 给出 `已同步·HH:MM` /
  `失败：原因` / `未同步`；`:694-706` `Text(this.honestStatus())` 且 `:703-705` 点击 →
  `retryFromStatus()`（`:542-549` 有 `canRetrySync` 门禁）。失败出口 `:710-750`：
  `查看状态` / `测试连接` / 条件 `重试`（`:734` 仅 `canRetrySync` 为真时渲染），无手动推送按钮。

## Patch 安全证明（验证点 4）

- `services/settingsStore.ets:559-564`：`async save(patch, context?) { … const prefs =
  this.requirePrefs(); const current = await this.load();` —— 基于磁盘当前值合并。
- `services/settingsStore.ets:617-618` 原文：
  `repoUrl: patch.repoUrl === undefined ? current.repoUrl : patch.repoUrl.trim(),`
  `token: patch.token === undefined ? current.token : patch.token.trim(),`
  —— 未提供键保留 current（P-1 直接钉住这两行）。
- `SettingsSync.ets:293-300` 是唯一可编辑写者；`SettingsHost.ets:318,365-366,543,545`
  只回写读盘原值；`syncSaveScope.test.mjs:21-51` 钉住 P-1/P-2/P-3，三条全绿。

## 守卫超集表（验证点 6；只列本模块 hunk，foreign hunk 另计）

| 守卫 | 本模块改动 | 被删断言 |
| --- | --- | --- |
| `settingsMenu.test.mjs:68-99` | 新增 M-07（页面/正文双锚点） | 无 |
| `settingsCopyGuard.test.mjs:117-155` | C2 全部原断言逐字保留，另加真页面锚点 | 无 |
| `settingsSources.mjs:44-46,74-85` | 加 `readSyncPage()`，union 并入 `pages/SettingsSync.ets` | 无 |
| `settingsFormValidation.test.mjs:346-358` | 横幅位置改钉 `SettingsSync: Scroll→IssuesBanner→SyncSection` | 旧「宿主 CompactBody/WideBody 两套骨架」检查被替换（骨架已不存在）；契约保留 |
| `structureGuards.test.mjs:38-61,129-148` | 加 PAGE_SYNC/SYNC_SECTION_FILE；字段范围扩为宿主∪页面；装配=宿主(3)+页面(1) 双向 | 仅把 SyncSection 从宿主集合移到页面集合；无检查丢失 |
| `uiTokens.test.mjs:541-566` | U-S5 加 5 条真页面断言（无薄壳/标题/SyncSection/Scroll/保存） | **是**：删掉「SettingsSync 必须薄壳 `SettingsHost({section:'sync',…})`」一条——已按设计失效，由 1 负 4 正替代 |
| `syncSaveScope.test.mjs:21-51` | 新文件 P-1/P-2/P-3 | 无（新建） |

Foreign hunk（他人车道 `mod-settings-export-page`，不计）：M-08、readExportPage、DataSection 迁出、U-S5 导出页新增断言。

## Gate tails（foreign 失败分离）

1. `tsc -p tools/tsconfig.json`：无输出，**EXIT=0**（仅覆盖 `model/**`+`common/**`，排除 `pages/`、`components/`）。
2. `node --test syncSaveScope.test.mjs settingsMenu.test.mjs`：`ℹ pass 11 / ℹ fail 1 / ℹ skipped 0`，**EXIT=1**。
   唯一失败 `settingsMenu.test.mjs:104 M-08 … ERR_MODULE_NOT_FOUND: .build/common/date` →
   **foreign: mod-settings-export-page**。本模块 10 条用 name-pattern 单跑：`tests 10 / pass 10 / fail 0`，EXIT=0。
3. 全量 `node --test …`：`ℹ tests 3097 / ℹ pass 3093 / ℹ fail 3 / ℹ skipped 1`，EXIT=1。
   三条均 foreign：`exportImportV2.test.mjs:845`（mod-ui-drop-backup / export-page）、
   `remoteSettings.test.mjs:70`（mod-settings-remote-dedupe）、`settingsMenu.test.mjs:104 M-08`（export-page）。
   中途另一 lane 改动导致 `structureGuards` DataSection 一次瞬时失败，重跑已消失。
4. `validate-app.mjs`：`✅ 全部通过：8/8（JSON5/JSON 70、相对 import 487、main 静态 import 634、页面 12、rawfile/git 2）`，EXIT=0。
5. `overlay.mjs status`：`覆盖层：未应用 … [overlay] applied=false`，EXIT=0。

## unverified

- ArkTS 编译/真机交互：`.ets` 被 tsc 排除；`.build-logs` 无任何日志提及 `SettingsSync.ets`，
  最近一次 2026-11-21 14:45 构建失败于 `pages/Settings.ets:142 minHeight`（与本案无关）。
  故 P1 未被 gate 捕获，编译状态 unverified。
- 保存落盘、SSH 切换持久化、状态行三态真机观感：无设备证据，unverified。
