# 加固三模块独立只读评审（REVIEW-hardening）

- 范围：`dsh-sync-suite` @ HEAD `7f1bd82`，三笔未提交改动 A/B/C。只读评审：未改任何源码、未提交、未 push。
- 依据：`项目理解.md`、`docs/DATA-CONTRACT-v2.md` §2/§3/§5/§6/§7/§10、`docs/EXPORT-IMPORT.md`、`docs/RUNBOOK.md`。
- 复核门闸全部在本目录重跑，原始输出尾部见 §7。

## 0. 结论速览

| 模块 | 结论 | P0 | P1 | P2 |
| --- | --- | --- | --- | --- |
| A `mod-v2-doctor` | **不可提交**（先修 P1-1） | 0 | 1 | 2 |
| B `mod-v2-media-gc` | 可以提交（P2 建议随批修） | 0 | 0 | 2 |
| C `mod-export-v2-ledgers` | 可以提交（P2 建议随批修） | 0 | 0 | 1 |

全量门闸与计数均达标（2844/2843/0/1、8/8、tsc 0、overlay false），但门闸绿不等于语义正确：A 存在一个系统性误报。

## 1. Findings（`file:line`）

### P1-1 doctor 把「合法已删记录」误判为账本孤儿（阻断 A）
- `tools/doctor-v2.mjs:479,484`：`knownIds` 只含当日 `records.json` 里出现的 id；凡 deleted/restore 账本 id 不在其中 → `E_LEDGER_ORPHAN`，经 `problem()` 记为 `error`、计入 `problems` → exit 2；next 文案甚至建议「必要时由人工按 intentId 恢复」。
- 该状态是**契约规定的正常终态**：`docs/DATA-CONTRACT-v2.md:151`（confirm 后物理移除版本行）、`:157`（账本永不过期、不清理）、P2-13（`:243`，保留行只是可选，不是必须）。项目自身实现也照做：`tools/migrate-v1-to-v2.mjs:383,389`（迁移即删行+写账本）、`apps/.../model/timelineWrite.ts:254-285` 与 `services/timelineWriteStore.ets:178,214`（`purgeRows` 物理清行）。
- 影响：任何做过删除（或迁移数据含删除）的正常仓库都会被报 problems、退出 2，并得到反向误导的恢复建议。
- 缺 normative 用例：`apps/arkui-schedule/tools/test/doctorV2.test.mjs:494-503` 只测 id 从未存在的 `ghost`；12/13/35 号用例都保留记录行，未覆盖「行已清、账本在」。
- 建议：孤儿降为 info/warning（不计入 problems），或只在可证伪条件下报错；补一例「records 无该 id + deleted 有该 id」期望 exit 0。

### P2-1 doctor 的 `perDay[].conflicts` 恒为 0
- `tools/doctor-v2.mjs:459` 初始化 `result.conflicts = 0` 后 `checkLedgers` 从不递增；`checkConflicts`（`:508-547`）虽 `state.conflicts += rows`（`:536`），返回值却在 `:741` 被丢弃，`:749` 取 `led.conflicts`。聚合值正确、逐日值恒 0。`doctorV2.test.mjs:531` 只断言聚合值，未钉逐日值。

### P2-2 doctor 的 `E_MEDIA_MISSING` 把迁移窗口合法状态算成问题
- `tools/doctor-v2.mjs:596`；契约 §5（`docs/DATA-CONTRACT-v2.md:116`）明确媒体迁移前 `media/` 可为空、缺文件应显示「媒体待迁移」。工具 next 文案已承认这一点，却仍计 error/exit 2。建议降为 warning。

### P2-3 media-gc：坏日文件会把整日媒体全列进删除计划（安全）
- `tools/media-gc-v2.mjs:264,269-279`：`records.json` 不可解析时只 `badDays++`，不加入任何引用；`:301` 于是该日全部 `media/*.jpg` 进 plan。`badDays` 在 `:360` 打印，但 `--delete`（`:439-441`）不因此拒绝。与契约 §9 fail-closed 精神不符。建议：plan 含 `badDays>0` 时禁止 `--delete`。

### P2-4 media-gc：跨日同名裸文件名用全局引用集，漏删真孤儿
- `tools/media-gc-v2.mjs:262,277,301,315`：`referenced` 是跨全部日期的 Set，只按裸文件名。契约 §5 的目录是 `timeline/<date>/media/`，跨日同 sha16 互不相关；某日未引用、另一日引用的同名图会被保守保留。不会误删，但计划不完整。建议按 `(date,file)` 建引用集。

### P2-5 导出账本去重键与主数据契约不一致
- `apps/.../model/exportImport.ts:2145`（`v2LedgerRowKey`）：delete 用 `(id,ts)`；`docs/DATA-CONTRACT-v2.md:159` 规定 deleted 按 `(id, ts, intentId)` 去重。`docs/EXPORT-IMPORT.md:389` 与代码一致，但与被其引用的主契约不符。影响：同 id 同 ts 不同 intentId 的两条删除事实会被吞掉一条（语义同为删除，无可见数据丢失，属审计粒度差异）。建议统一口径或在 §7 注明「bundle 层按 (id,ts) 收敛」。

## 2. 只读保证（三项证据，均成立）

- **静态 grep**：`tools/doctor-v2.mjs` 对 `writeFile|appendFile|unlink|rm|rename|mkdir|copyFile|writeSync|openSync` 零命中；只用 `fs.existsSync/statSync/readdirSync/readFileSync`（`:77-112`），头部 `:7-8` 声明一致。`tools/media-gc-v2.mjs` 仅 `:419` 一处 `fs.unlinkSync`，位于 `unlinkAll()`，只由 `:441`（`opts.del`）触达；无 writeFile/appendFile/rm/rename/mkdir/copyFile。
- **doctor 动态证明**：`doctorV2.test.mjs:109-127,145-150` 的 `snapshot()` 对整棵 repo 做「目录标记 + 每文件 SHA256」，35 例每次 CLI 调用前后 `deepEqual` 相等（含 34 号参数拒绝路径 `:611-613`）。
- **gc 动态证明**：`mediaGcV2.test.mjs:94-110` 的 `treeStat()` 比对内容 + mtime；`:163-168`（默认模式）、`:211-216/225-230/316-318/382-386`（拒绝/空计划/默认）前后相等。
- **`--delete` 门**：`media-gc-v2.mjs:380-386`（空计划 `E_NOTHING_TO_DELETE`、token 不符 `E_BAD_CONFIRM`）、`:391-412`（`MEDIA_FILE_RE`/`DAY_RE`、目录逃逸、`isFile`、size 全部预检后才删）、`:416-425`（只 unlink 计划内绝对路径并逐条记 stderr 日志）。测试 05/06/07/15/17/21 覆盖；`:450-474` 逐字节证明 `devices/**`、records、三本账本、schema 未变。

## 3. Doctor 编码对契约覆盖（A）

| 契约点 | code | 用例 | 判定 |
| --- | --- | --- | --- |
| schema 缺/坏/非 2 | `E_SCHEMA_MISSING`/`E_SCHEMA_UNKNOWN` | 16/17/18/31 | 对 |
| date ≠ 目录名 | `E_DAY_DATE_MISMATCH` | 20/31 | 对 |
| 账本孤儿 / 坏行 | `E_LEDGER_ORPHAN`/`E_LEDGER_PARSE` | 24/25/31 | 语义误报见 P1-1 |
| 媒体名 / 碰撞 / 缺失 | `E_MEDIA_NAME`/`E_MEDIA_COLLISION`/`E_MEDIA_MISSING` | 28/29/30/31 | 缺失见 P2-2 |
| open 只看 closed_at | `E_OPEN_DRIFT`（info） | 10 | 对，不计 problems |
| 混合布局 | `I_LAYOUT_MIXED`（info） | 14/15 | 对，exit 0 |
| R≤D / R>D | `restoreIgnored`/`restoreWins`（计数） | 12/13 | 对，均 exit 0 |
| 同 ts 字节裁决 / 较晚 ts | `I_DUPLICATE_IDS`（info） | 8/9 | 对，不误报 |
| 退出码 0/2/1 | `EXIT` 表 `:34`，`:798-812` | 01/16/34 | 0/2 已测；1（未预期错误）无注入用例，`unverified` |

未覆盖的小项：`E_RECORDS_PARSE`、`E_CONFLICTS_PARSE`、`W_RECORDS_MULTILINE`、`W_LEDGER_MISSING` 无专门用例（非 normative 阻断项）。

## 4. GC 引用规则裁定（B）

- **可见口径成立**：`media-gc-v2.mjs:155-167`（`deletionState`：D=max(deleted.ts)、R=max(restore.ts)，可见 iff 有 R 且 R>D 严格；无 D 即可见），`:272-278` 仅对可见记录取 media。测试 03 证明「被删记录媒体进计划、R>D 复位保活」。
- **折叠口径成立**：`:209-243` 较晚 ts 胜、同 ts 规范整行 UTF-8 字节序较大者胜；测试 11/12 分别钉住。
- **planHash 稳定/随之变化**：`:303-305` = `sha256(排序路径以 \n 相连 + 尾 \n)` 前 12 位；测试 09（同仓两次相同）、20（计划变则 hash 变）、`:112-116` 独立复算一致。
- **删除记录媒体视为未引用**：成立（测试 03）。非法文件名 `:198-207` 不保活、不崩（测试 13）。
- 综合：**规则一致、无非期望删除**；P2-3/P2-4 为安全性与完整性改进项，非阻断。

## 5. bundleVersion 兼容性裁定（C）

- **门槛逐字一致**：`exportImport.ts:1635-1647`（缺字段→1；1→旧；2→带账本；>2→`E_BUNDLE_VERSION`；非正整数/非数字→`E_BUNDLE_CORRUPT`）、`:2126-2127` + `:1406`（旧 bundle 返回 `V2_NOTE_LEDGERS_ABSENT`，不拒绝）、`:2372`（下一步文案）。与 `EXPORT-IMPORT.md §7.1` 逐字同源；测试「旧 bundle 缺/1」×2、`>2`、畸形 0/`"2"` 共 4 例覆盖。
- **账本逐字节搬运**：`exportService.ets:365,886-894`（读原文 + `v2Utf8ByteLength` 声明）、`:917-920`（三本恒写出、空账本空文件）；`exportImport.ts:1995-2020` 按字节数 fail-closed 校验；测试「空账本 0 字节」「乱序声明字节稳定」「字节不符 E_BUNDLE_CORRUPT」「空目标 round-trip 逐字相等」覆盖。
- **并集不截断**：`exportImport.ts:2192+`（`mergeV2LedgerText` 目标字节恒为前缀、按 `(id,ts)` / `(id,ts,dedupeKey)` 去重、幂等），`exportService.ets:1119-1139` 只把 `merged.toAppend` 交给 `appendTextAtEnd`（`:211-224`，`READ_WRITE|CREATE` + 按 `stat.size` 定位写，无 TRUNC/重写）。测试 4 例并集/幂等/坏行 + 源码级 `:835-850` 断言钉住。**无截断/重写路径**。
- **旧 bundle 导入不变**：`exportImport.test.mjs`（84 例）一字未改，git status 确认未列出；v1 导出/导入逻辑未动。
- 综合：**兼容性 verdict = 符合**；P2-5 为与主契约的审计粒度差异。

## 6. 测试质量与增量

- 计数：doctor 35 / gc 22 / exportV2 47（本次新增 12 个 `test()` 块，其中 1 个 `for` 展开为 2 例 → +13 例）；v1 `exportImport.test.mjs` 84 例不变。基线 2774 + 22 + 35 + 13 = **2844**，与全量实测一致。
- 断言为真实契约断言：退出码/JSON code/整棵快照/hash 复算/并集前缀/v1 文件未改，均为契约口径，不见纯 incidental 断言。
- 无既有断言被删或弱化：exportImportV2 仅改 2 个标题、给「八类拒绝」补 `E_BUNDLE_VERSION`、源码级补 3 条断言，`firstWrite` 集合新增 `appendTextAtEnd(` 只会使断言更严。全量无静默删除。

## 7. 门闸原始输出尾部（复现）

```
# node apps/arkui-schedule/tools/overlay.mjs status
覆盖层：未应用（工作区为「共享源码 + 平台目录」的原始形态）
[overlay] applied=false
EXIT=0

# node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
EXIT=0                         # 无 stdout/stderr

# 三文件：node --test doctorV2 / mediaGcV2 / exportImportV2
ℹ tests 104 / suites 13 / pass 104 / fail 0 / cancelled 0 / skipped 0 / todo 0
ℹ duration_ms 4189.0058
EXIT=0

# 全量：node --test "packages/dsh-dots/test/*.test.mjs" "apps/arkui-schedule/tools/test/*.test.mjs"
ℹ tests 2844 / suites 325 / pass 2843 / fail 0 / cancelled 0 / skipped 1 / todo 0
ℹ duration_ms 33287.507
EXIT=0

# node apps/arkui-schedule/tools/validate-app.mjs
✅ 全部通过：8/8 条规则（JSON5/JSON 70 个、相对 import 424 条、main 静态 import 545 条、页面 7 个、rawfile/git 2 个文件）
EXIT=0
```

## 8. unverified

- 真机 / 第二设备 / 双端并发行为一律 `unverified`（`hdc list targets` 空，无 DevEco/SDK；契约 §15、RUNBOOK §6）。
- doctor 退出码 1（未预期错误）无注入用例；doctor 的 `E_RECORDS_PARSE`/`E_CONFLICTS_PARSE`/`W_RECORDS_MULTILINE`/`W_LEDGER_MISSING` 未专门覆盖。
- gc `--delete` 的跨日同名文件语义（P2-4）与坏日文件保护（P2-3）未做端到端真实仓库演练。
- 导出账本在真实 ArkUI `readTextFromUri`/`writeTextFile` 上的 BOM/CRLF 字节保真未做设备验证；Node 侧以 UTF-8 字符串与 `v2Utf8ByteLength` 等价推断。
- 三模块提交哈希待 Lead 回填（`docs/MODULES.md` §1/§5/§6 已登记为「待提交」）。
