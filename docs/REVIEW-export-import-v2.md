# REVIEW — mod-export-import-v2（独立只读评审）

评审对象：未提交模块 `model/exportImport.ts`、`services/exportService.ets`、
`components/ExportImportPanel.ets`、`components/settings/DataSection.ets`、`pages/Settings.ets`、
新增 `tools/test/exportImportV2.test.mjs`。依据：`项目理解.md`、`docs/DATA-CONTRACT-v2.md` §5/§7/§11、
`docs/EXPORT-IMPORT.md`。时间 2026-11-20。真机 / DevEco 不可用，端侧结论均为 `unverified`。

## 1. 结论

- **P0：0**
- **P1：1**（P1-1：导入不校验媒体 sha256 内容，违反 §5 明文）
- **P2：6**（P2-1…P2-6，见 §2）
- **blocking：无**。v1 行为零改动、五类拒绝齐全、8 路接线完整、门禁全绿；建议把 P1-1 / P2-3 / P2-6 登记为 follow-up 后合并。

## 2. Findings（`file:line`）

- **P1-1（§5 未达标）**：manifest 的 `media[].sha256` 只做格式校验（`model/exportImport.ts:1598–1611`）
  和"文件名在位"校验（`:1827–1839`），**从未与实际文件字节比对**；
  `services/exportService.ets:673–691` 的 `v2CopyBinary` 只搬字节，`:979–991` 只按 `fileExists` 跳过。
  结果：内容被替换 / 损坏但文件名正确的媒体会被静默导入。§5"导入放回目标日 `media/` 并校验 sha256"未实现。
  非阻塞（正常导出链不触发），建议补 `sha256(readBytes) === manifest.sha256` 且失败报 `E_MEDIA_MISSING`。
- **P2-1（测试数量口径）**：导出两文件实测 **110**（v1 84 + v2 26），brief 期望 123（差 13）；
  全量套件 2711 精确匹配，说明 123 多半是陈旧期望值。`exportImport.test.mjs` 与 HEAD 逐字节一致
  （`git diff --quiet HEAD` exit 0，最后提交 `37a602d`），不存在"被删 13 条"的削弱。请 Lead 核对口径。
- **P2-2（"尚未接入"字面仍在）**：`components/ExportImportPanel.ets:95` 保留 `V2_NOT_WIRED`，
  且被 `tools/test/exportImportV2.test.mjs:450` 断言保留。功能上 8 路回调全部接线（§4），该文案不可达；
  但与"no 尚未接入 left"的表面要求冲突。建议改为"`当前不可执行：<具体原因>`"并同步改测试断言。
- **P2-3（bundle 不含账本）**：bundle 只有 records/summary/media，无 `deleted.jsonl`/`restore.jsonl`/`conflicts.jsonl`，
  `applyV2Import`（`exportService.ets:944–1001`）也不重放账本。源端"已撤销删除"而目标端只有 D 账本时仍隐藏；
  源端已删而目标端可见时导入不会删（只增）。v1 导出导入本就不含账本、§9 P2-13 允许保留命中账本的行，
  判为已知边界，记为 `unverified`，非阻塞。
- **P2-4（组件自述与实现不符）**：面板头注释声明"不 import services"，但
  `ExportImportPanel.ets:49` 引入 `timelineStore`，`v2Visible()`（`:222–224`）直接读它。
  只读判定、无 IO，不构成假的入口；建议把注释改为"不调用 IO 型 service"，或把 flag 作为 `@Prop` 传入。
- **P2-5（测试强度）**：26 条中 3 条是源码级正则断言（`exportImportV2.test.mjs:422–453`），只证明文本存在；
  服务级行为（exportedAt 取最新 ts、summary 存在才写、media 内容寻址复制、media-only-add、
  apply 阶段门禁复查、cancel 清状态）无直接测试，仅靠代码审阅。
- **P2-6（sha16 碰撞）**：§5/§14 开放项 1 要求同名不同内容延长前缀 / 报 `E_MEDIA_SHA16_COLLISION`；
  `exportService.ets:981–984` 遇到同名直接 `continue`，未比对 sha256，碰撞时会保留目标旧图。

## 3. Bundle 形状（§2 要求逐项命中）

`manifest.json` 顶层键序固定：`schemaVersion=2`、`kind='dsh-schedule-v2'`、`range{from,to}`、
`exportedAt`（**取范围内最新记录 ts**，`exportService.ets:778/827`）、`dayCount`、`days[]`、`media[]`（`model/exportImport.ts:1457–1494`）。
`days[]` 元素 `{date, recordCount, hasSummary, media[sha16.jpg]}`；`media[]` 元素 `{file, sha256(64hex), bytes, date}`。
日文件：`timeline/<date>/records.json`（`buildV2RecordsText` 按 `(ts,id)` 排序、一条一行、自检）、
`summary.json` **仅当存在才写**（`exportService.ets:839–842`）、`media/<sha16>.jpg` 内容寻址原样复制（`:843–850`）。
记录经 `timelineStore.readDay()`（`:784`），即已套用 `visibleRecords` 的 deleted/restore 优先级
（`timelineStore.ets:172–187`）。确定性：days 按 date、day.media 按文件名、media 按 `(date,file)`、records 按 `(ts,id)`；
测试 `exportImportV2.test.mjs:150–174/232–247` 验证乱序输入逐字节相同。manifest `exportedAt` 取自记录而非当前时间 ✓。
**缺口见 P1-1 / P2-3 / P2-6。**

## 4. 拒绝表（五类，中文原因 + 下一步 + 落点）

| 码 | 触发 | 中文原因（源） | 下一步（`v2RefusalNext`） | 位置 |
| --- | --- | --- | --- | --- |
| `E_SCHEMA_UNKNOWN` | manifest `schemaVersion≠2` | "不认识的 v2 备份版本（…），只支持 schemaVersion=2" | 换用 schemaVersion=2 的备份，不猜着导入 | `model/exportImport.ts:1533–1538` |
| `E_BUNDLE_CORRUPT` | 空/坏 JSON/顶层非对象/缺标记/kind 不符/区间非法/字段畸形/dayCount 不符/日文件坏/天数或 summary 标记不符 | 逐类中文原因 | 重新导出完整备份，坏文件不写盘 | `model/exportImport.ts:1518–1615`、`1779–1826` |
| `E_MEDIA_MISSING` | 声明的媒体在 bundle 中缺失 / 搬运失败 | "缺少媒体文件 …（content-addressed 文件必须一起搬运）" | 重新导出并一起搬运 media/ | `model/exportImport.ts:1831–1838`、`exportService.ets:989` |
| `E_V1_TARGET` | 目标无 v2 schema 标记（`repoIsV2=false`） | "目标是 v1 仓库：请先…迁移到 v2…后再导入" | 先执行 v1→v2 单向迁移 | `model/exportImport.ts:1908–1913`、`exportService.ets:932–934` |
| `E_TARGET_BUSY` | 写入闸未启用（`writeEnabled=false`） | "v2 写入路径未启用：请先…显式激活…" | 检查 v2 写入是否已激活 / 稍后重试 | `model/exportImport.ts:1915–1920`、`exportService.ets:935–937` |

类型为 `code` 字段 + 中文 `reason`（`V2ImportPlan`/`V2ApplyResult`），面板经
`Settings.ets:1321–1324` 的 `v2RefusalLine` 拼成 `动作失败：E_xxx 原因（下一步：…）` 写入 `v2Message`，
`ExportImportPanel.ets:663–665` 用 `HintLine` 显示；**五类均有中文原因与下一步**（测试 `exportImportV2.test.mjs:363–372`）。
dry-run 为默认（`planV2ImportFromPicked` 只读，`exportService.ets:866–900`），落盘需 `applyV2Import` 显式调用
且 UI 再弹确认框（`Settings.ets:1441–1458`）；落盘前重查门禁（`exportService.ets:930–937`）。

## 5. v1 未改动证明

- `git diff --unified=0`：`model/exportImport.ts` 仅 `+3` 导入（:23）+ `+615` 纯追加 v2 段（原 :1355 后）；
  `exportService.ets` 仅 8 处 import 增行 + `+435` 追加 v2 段（原 :551 后）；
  `ExportImportPanel.ets` / `DataSection.ets` / `Settings.ets` 全部为 import 增行 + 追加 v2 常量/属性/方法/接线。
  **无任何 v1 函数体被修改**（`exportSchedules` / `planImportFromText` / `appendImportPlan` / v1 面板助手原样）。
- `tools/test/exportImport.test.mjs`：`git diff --quiet HEAD` exit 0（逐字节等于 HEAD，最后提交 `37a602d`），
  84/84 全绿；即 v1 导出字节、Markdown/JSON 格式、append-only 导入契约、六道闸测试一字未动。
- 测试还显式守卫 v1：`exportImportV2.test.mjs:438–444` 断言 `OpenMode.TRUNC` 仍只有导出 1 处、三个 v1 入口仍在。
- **原子写 / 只增媒体 / 无 devices 写入**：服务层落盘全部经 `timelineWriteStore.append`（`timelineWriteStore.ets:110–123`，
  走 `atomicWriteIn` tmp+rename `:455–508`）与 `appendSummary`（`:236–245`，newer-wins）；媒体用 `v2CopyBinary`
  先 `fileExists` 再复制（`:979–991`）；静态扫描 v2 段中 `devices/**` / `unlinkSync` / `TRUNC` 只出现在注释，
  无 force-push / history rewrite / 远端删除代码。

## 6. 测试质量

26 条全部为真实执行（model 纯函数 + 2 个源码级 describe），非桩；逐字节确定性、manifest 键序、五类拒绝、
dry-run 计数、账本过滤链、`useV2()` flag gate 均已覆盖。**无任何既有断言被削弱**（v1 测试文件逐字节未变，全量套件 2710 pass / 0 fail）。
**缺失的规范性用例（点名）**：
1. `exportV2Timeline` 端到端：`exportedAt` 确取最新记录 ts（仅代码 `:827`，无断言）；
2. `hasSummary=true` 但缺 `summary.json` → `E_BUNDLE_CORRUPT`（逻辑在 `model:1824` 但无测试）；
3. 媒体 sha256 内容不符 / sha16 同名不同内容（P1-1 / P2-6，未实现故无测试）；
4. apply 阶段门禁复查：dry-run 后 `repoIsV2`/`writeEnabled` 翻转 → 拒绝且零写入（仅代码 `exportService.ets:930–937`）；
5. media-only-add / 同名不覆盖不删除（仅 `fileExists` 跳过的代码，无测试）；
6. `handleV2Cancel` 清空 `v2PlanReady/v2PlanText/v2Message/v2Busy`（`Settings.ets:1485–1492`，无测试）；
7. 带 IO 的服务级五类拒绝（`planV2ImportFromPicked` 路径未被测试，只测了 model 层 `planV2Import`）。

## 7. 门禁 tail（复现）

```
# overlay
覆盖层：未应用（工作区为「共享源码 + 平台目录」的原始形态）
[overlay] applied=false
# tsc（无输出，exit 0）
# exportImportV2 + exportImport
ℹ tests 110   ℹ suites 25   ℹ pass 110   ℹ fail 0   ℹ skipped 0   ℹ duration_ms ~174
# 全量套件
ℹ tests 2711  ℹ suites 319  ℹ pass 2710  ℹ fail 0  ℹ skipped 1  ℹ duration_ms ~28125
# validate-app
✅ 全部通过：8/8 条规则（JSON5/JSON 70 个、相对 import 423 条、main 静态 import 544 条、页面 7 个、rawfile/git 2 个文件）
```
导出两文件实测 110 而非 brief 的 123（P2-1）；全量 2711/2710/0/1、validate 8/8、tsc 0、overlay applied=false **全部符合预期**。
ArkTS hygiene：新增 `.ets` v2 段无 `unknown` / `in` / 对象字面量当类型（仅注释与既有 v1 调用命中）；
纯 TS model 层的 `unknown` 为 v1 既有口径（`exportImport.ts:221/393/…/1707`），tsc 0 + validate 8/8 为构建证据。

## 8. unverified

- 真机 / 第二设备 / DevEco 编译与端侧行为（`hdc list targets` 为空、无 SDK）：全部 UI、ArkTS 严格编译、
  原子写实际落盘效果、跨端语义均为静态推断，标 `unverified`。
- 服务级 IO 函数（`exportV2Timeline` / `planV2ImportFromPicked` / `applyV2Import`）无 fake-IO 测试，
  仅源码审阅；媒体 sha256 校验与碰撞处理未实现（P1-1 / P2-6）。
- bundle 不含账本导致的跨端删除/撤销语义差异（P2-3）未在双端验证。
- brief "export tests 123" 与实际 110 的差异（P2-1）待 Lead 确认期望口径。
