# REVIEW — mod-export-json（独立只读评审）

> 基线 HEAD `704c6e5`，工作树 `mod-export-json`（未提交）。只读：未改任何源码、未提交。
> 契约源：`项目理解.md`、`DATA-CONTRACT-v2.md` §3/§5/§7/§10、`EXPORT-IMPORT.md` §2.2/§7.3、`UX-STEPS.md` §2.3/§4.6。

## 结论

- **P0：0。P1：1（阻塞）。P2：5（不阻塞）。裁决：不可提交——先修 P1-1 并补一条回归用例，修后可提交。**
- P1-1 旧 bundle（带媒体）在**真实服务层**导入失败，与契约相反；被测试的自写 helper 掩盖（见下）。核心新格式（新 bundle）本身正确。

## Findings

### P1-1 旧 bundle 的媒体读取被无条件 `readArchiveEntry` 劫持（阻塞）

- `services/exportService.ets:1139-1148`：`mediaIo.readArchiveEntry` **无条件定义**；`prefetched===null`（旧 bundle）时抛 `旧 bundle 没有 media.zip，无法读条目 …`。
- `model/exportImport.ts:2185`：`bytes = io.readArchiveEntry !== undefined ? io.readArchiveEntry(entry) : io.readSource(...)` —— 只判断回调**是否存在**，不判断 bundle 类型。接口注释 `:2086` 明确写「旧 bundle 不传」，服务层违反自己的接口契约。
- 结果：旧 bundle 有媒体时 → `E_MEDIA_CORRUPT`，而非 §7.3 要求的「照常导入 + `V2_NOTE_MEDIA_ARCHIVE_ABSENT`」。
- **实测复现**（`node --input-type=module` 直接调 `checkV2MediaIntegrity`）：注入 READ-SERVICE 形态 io（`readArchiveEntry` 存在且抛错、`readSource` 有效）→ `{ok:false, code:E_MEDIA_CORRUPT}`；注入 TEST-HELPER 形态（`readArchiveEntry` 缺席）→ `{ok:true, verified:1}`。
- `tools/test/exportJson.test.mjs:210-214` 的 helper 对旧 bundle 传 `readArchiveEntry: undefined`，正好走不到真实服务那条分支——测试 7/7 绿但漏掉此回归。
- 修法：仅当 `prefetched !== null` 时把 `readArchiveEntry` 加入 `mediaIo`，否则省略（让 `readSource` 生效）；补一条「旧 bundle 走服务层同款 io」用例。

### P2（均不阻塞）

- **P2-1** 归档级校验缺专门用例：`tools/test/exportJson.test.mjs:310-332` 的篡改用例**同步回填**了 `mediaArchive.sha256/bytes`，只钉死逐张 sha256；`validateV2Bundle` 的整包不符分支（`model/exportImport.ts:1761-1773`）无端到端断言。
- **P2-2** 文档残留：`docs/EXPORT-IMPORT.md:216` 的 `ExportRequest` 仍写 `{fromText,toText,format,includeAttachments,includeMeta}`；`:324` 仍列 `includeMeta` 限制；`:338-339` 测试覆盖清单仍列 `[x]/[ ]`、`includeAttachments`、`includeMeta`；`docs/FEATURE-BACKLOG.md:313` 仍把 `model/exportMarkdown.ts` 列为待办（与「Markdown 已删除」冲突）。
- **P2-3** `resources/rawfile/git/git-bridge.js:2292-2294` 的 JSDoc 称返回 `entries:[{name,size}]`，实际 `opZipWrite` 返回 `entries: sorted.length`（数字）；注释过时。
- **P2-4** round-trip 用测试内复刻的 `exportBundle`/`importBundle`（`exportJson.test.mjs:129-235`）而非真实 `.ets` 服务编排；服务层仅靠源码文本守卫（`:373-386`）。这是 P1-1 漏检的根因；建议增加服务级等价用例。
- **P2-5** ArkTS 严格编译（首次失败后加 `SettingsZipBridge`）只见执行者在 `docs/MODULES.md:171` / `ROADMAP.md:613` 声称 `BUILD SUCCESSFUL`；本次 5 个 gate 不含 `.ets` 编译（`tsc` 只编 model 层），无法复现 → `unverified`。适配器本身读码正确：`Settings.ets:266-286` 显式 `implements V2ZipBridge`，`GitSyncService.ets:794` 的 `zipRead` 签名一致。

## Bundle-shape 表

| 项 | 契约（§2.2/§7.3） | 实现位置 | 结论 |
| --- | --- | --- | --- |
| `manifest.json` 顶层键序 | bundleVersion,schemaVersion,kind,range,exportedAt,dayCount,days,media,mediaArchive | `model/exportImport.ts:1371-1388`；`exportJson.test.mjs:248-249` 断言键序 | ✓ |
| `days[]` | date, recordCount, hasSummary, `ledgers[{name,bytes}×3]` 固定序 | `services/exportService.ets:911-936` | ✓ |
| `timeline/<date>/records.json` | §3 canonical bytes，与源仓库逐字节同 | `:137-142` 读原文、`exportJson.test.mjs:295-301` 逐字节相等 | ✓ |
| `summary.json` / 三本账本 | 有才写；账本逐字节复制、空账本也建 | `:967-974`；测试 `:295-301` | ✓ |
| 单个 `media.zip`，条目 `<date>/<sha16>.jpg` | 唯一归档；条目按 `(date,file)` 排序 | `git-bridge.js:2271-2317`、`exportService.ets:938-958`；测试 `:255-259` 无按日 media/ | ✓ |
| `media[]` / `mediaArchive` | `{file,sha256,bytes,date}` / `{name,sha256,bytes,entries}` | `exportImport.ts:1229-1238,1366-1386` | ✓ |
| 确定性 | 固定 DOS 时间 1980-01-01 + STORE + 排序 | `git-bridge.js:2280-2310`；测试 `:264-281` 两次导出逐字节相同 | ✓ |
| `bundleVersion>2` 拒绝 | typed `E_BUNDLE_VERSION` | `exportImport.ts:1441-1443`；测试 `:363-371` | ✓ |

## Media-verification trace（顺序 + 零写入证明）

1. dry-run `exportService.ets:1002-1024` 读回 `media.zip` 字节 → `planV2Import` → `validateV2Bundle`（`exportImport.ts:1761-1773`）比对整包 `sha256/bytes`，不符 → `E_MEDIA_CORRUPT`，`plan.ok=false` → apply 早退（`:1110-1114`）。
2. confirm `applyV2Import`（`:1066-1104`）异步预取每个 zip 条目；条目缺失/读不出/非法名 → `E_MEDIA_CORRUPT` **直接返回**，此时尚未进入写循环。
3. `applyV2ImportOnce`（`:1150-1153`）`checkV2MediaIntegrity` 逐张比对 manifest sha256（`:2192-2198`）；目标同名内容不同 → `E_MEDIA_COLLISION`（`:2173-2177`）；失败即 `return`。
4. **零写入**：所有拒绝分支都在 `for (const day of plan.days)`（`:1155`）之前；源码守卫测试 `exportJson.test.mjs:379-385` 钉死 `preflight < firstWrite`。
5. **写的是已验证字节**：`v2WriteBinary(dest, item.bytes)`（`:1201`），不二次读源，消除验后替换竞态；媒体只增、碰撞不覆盖（`:1194-1197`）。
6. 例外：P1-1 使旧 bundle 路径在第 3 步误判（§P1-1）；P2-1 使第 1 步缺专门用例。

## Markdown-removal completeness

- 源码：3 个 describe / 11 例（`exportImport.test.mjs:185-366`）全部针对已删除的 `renderMarkdownExport`，删除**合法**非削弱；2 例 retarget（`:607-615` 文件名签名、`:642-650` 默认 state）是适配。无残留导出符号：`renderMarkdownExport` / `normalizeExportFormat` / `EXPORT_FORMAT_MARKDOWN` / `MarkdownExportInput` / 3 个文案常量全仓源码 0 命中；`EXPORT_FORMAT_JSON` 仅剩定义（`exportImport.ts:30`）。UI `FormatRow()`、两个 Checkbox、3 个 `@State` 已删（`ExportImportPanel.ets`），`@State` 5→2 断言同步更新（`b2Batch.test.mjs:168`、`exportImportV2.test.mjs:891-895`）。
- 其余 Markdown（手写表格 OCR、AI 摘要正文、`.md` 文档名）属**其它特性**，保留正确。
- 残留仅限文档，见 P2-2。

## Round-trip verdict

- `exportJson.test.mjs` 用 vendored JSZip + 内存 host 真 zip 桥，两天 fixture → export → 全新 `mkdtemp` scratch target → import；断言 `timeline/**` 逐字节相等 + 媒体 sha256 逐张相等，另覆盖篡改零写入/旧包 note/未来版本/确定性/源码守卫。**7/7 通过，测试本身合格且诚实。**
- 独立性：每次 `freshDir` 无共享可变状态 ✓；但 helper 复刻服务层编排（P2-4），**不能证明真实 `.ets` 服务正确**——P1-1 即由此漏检。裁决：round-trip 对 model+zip 有效，服务层仍需补测。

## UX-STEPS verdict

- §2.3:153「不计入」第①项明确列「Markdown / JSON 格式（默认 Markdown）」，第②项列两个勾选框；§4.2:340 路径 3 的 5 tap 算式从无「点格式」；§4.6:638-669 明确 Δ0 并解释「为什么不是 −1」。
- **执行者说法成立：Δ0 正确，路径 3 保持 7，合计保持 31；我先前「−1」提示错误。**

## Gate tails（本次实测）

```
overlay → [overlay] applied=false
tsc     → TSC_EXIT=0
exportJson → ℹ tests 7 / ℹ pass 7 / ℹ fail 0 / ℹ skipped 0   EXIT=0
full suite → ℹ tests 2879 / ℹ suites 325 / ℹ pass 2878 / ℹ fail 0 / ℹ skipped 1 / ℹ todo 0 / ℹ duration_ms 32541.5277   EXIT=0
validate  → ✅ 全部通过：8/8 条规则（JSON5/JSON 70、相对 import 426、main 静态 import 546、页面 7、rawfile/git 2）   EXIT=0
```
未见 `remote-listener` 网络用例抖动；2879/2878/0/1 与预期一致。

## unverified

- 真机 / 第二设备行为：`hdc list targets` 无设备、无 DevEco/SDK；zip 桥在 WebView/ArkTS 运行时可用性、平板文件选择器能否选中 bundle、UI 观感均未验。
- ArkTS 严格编译与 HAP `BUILD SUCCESSFUL`（仅文档声称，本次 gate 无法复现，P2-5）。
- 真实服务层旧 bundle 导入路径（仅用 model 复现分歧，未在真机跑 `.ets`）；归档 sha256 不符路径缺用例（P2-1）。
- 归档 sha 在 dry-run→confirm 之间被替换时的整包重校（代码只在 dry-run 校整包，靠逐张 sha256 兜底，未做专门攻击用例）。

## 复审（2026-11-20，P1-1 修复）

> 独立只读复核；本次仅追加本节，未改源码。HEAD 已前进至 `98e0247`（原评审基线 `704c6e5`）。

- **点1 attach-only-when-prefetched：CLOSED。** `exportImport.ts:2101-2123` 的 `buildV2MediaCheckIo` 先建 `{targetExists,readTarget,readSource}`，仅 `if (prefetched !== null)`（`:2112`）才挂 `readArchiveEntry`（`:2114-2120`）；接口 `:2078-2090` 明注「旧 bundle 不传」。全仓构造点：生产仅 `exportService.ets:1136`（唯一 `.ets` 调用），model 侧仅构造器本身；`exportImportV2.test.mjs:198-214`、`contractGaps.test.mjs:141-156` 的假 IO 只有 `readSource`，无归档读。新包在 `applyV2Import:1075-1101` 先预取全部条目（缺条目即 E_MEDIA_CORRUPT 早退）再造 IO，故 `checkV2MediaIntegrity:2218` 的存在性判断对旧包走 `readSource`、对新包读必存在的 map，安全。
- **点2 旧 bundle 带媒体成功：CLOSED。** 新例 `exportJson.test.mjs:361-410` 用共享构造器传 `null`（`:378-383`）→ `readArchiveEntry===undefined`（`:384`）→ `plan.ok`（`:400`）+ note（`:401`）→ `check.ok`（`:403`）、`verified.length===2`（`:404`），逐张 `item.sha256` 等于 manifest 且 `sha256Hex(item.bytes)` 相等（`:405-407`）；note 常量见 `exportImport.ts:1171-1173`；完整导入例 `:334-359` 另断言落盘文件 sha。非静默跳过。
- **点3 整包 sha 不符：CLOSED。** 检查序：`validateV2Bundle` 先 parse（`:1759`）→ 整包 sha/bytes（`:1765-1774`，E_MEDIA_CORRUPT）→ 天数（`:1776`）→ …；`planV2Import:1933-1937` 原样透传失败码，helper `:194-195` 在预取/造 IO/写入前早退。新例 `:412-432` 只翻 `media.zip` 第 0 字节（`:419-422`），断言 manifest 仍为原整包 sha（`:424`）且实际 sha 已变（`:425`），故只可能命中 `:1765-1774` 而非别的错误码；`:428-430` 钉 E_MEDIA_CORRUPT（`exportImport.ts:1198` 常量值）+ `writes===0` + 目标 `timeline/` 不存在。
- **点4 回归测试质量：CLOSED。** 新例用 `M.buildV2MediaCheckIo`（由 tsc 从共享 model 生成，与 `exportService.ets:39,1136` 同一函数），源码守卫 `exportJson.test.mjs:447` 强制服务也走该构造器 ⇒ 服务等价路径而非 model 捷径。retarget：`importBundle` 由旧的手搓 `readArchiveEntry:undefined`（原评审 :19）改为共享构造器并透传 `prefetched`（`:208-213`）、保留失败早退（`:214`）；源码守卫在原 `preflight<firstWrite`（`:457`）外新增 `:447` 构造器断言与 `:450-451` 禁止无条件抛错回调断言，均严格增强（另有 `exportImportV2.test.mjs:845-862` 更宽的独立守卫）。
- **新发现：无阻断项。** 信息级：全量套件由预期 2881 漂到 2898（+17），系无关提交 `fbf10a2` 新增 `homeFilters.test.mjs`（17 例），与本修复无关；0 fail/1 skip 不变。低危（潜在）：`V2MediaCheckIo` 仍为导出接口，未来若绕过构造器手搓 IO 可重犯旧错；当前所有构造点守约且有源码守卫，非现态缺陷。
- **裁决：4/4 CLOSED，commit A：GO。**

Gate tails（本次实测，工作目录 `dsh-sync-suite`）：
```
overlay → [overlay] applied=false
tsc     → TSC_EXIT=0
exportJson → tests 9 / pass 9 / fail 0 / skipped 0  EXIT=0
full suite → tests 2898 / suites 329 / pass 2897 / fail 0 / skipped 1 / todo 0  EXIT=0
validate → ✅ 全部通过：8/8 条规则（JSON5/JSON 70、相对 import 426、main 静态 import 546、页面 7、rawfile/git 2）  EXIT=0
```
