# 复审：v2 单时间线读取核心（mod-v2-read-timeline）

- 角色：独立、只读复审执行者；未修改任何源码、测试或契约文件，仅新增本文。
- 对象：`apps/arkui-schedule/entry/src/main/ets/model/timeline.ts`、**648 行**（UTF-8 计数）、`apps/arkui-schedule/tools/test/timelineRead.test.mjs`、**448 行 / 38 例**；对照 `tools/migrate-v1-to-v2.mjs`（803 行）与 `docs/DATA-CONTRACT-v2.md` §3/§4/§5/§6/§7/§11。
- 行号说明：任务书给出的 615 / 439 行来自 `Get-Content` 默认编码；以 UTF-8 与原始字节为准分别为 648 / 448 行。本文所有 `file:line` 均按 UTF-8 行号。
- 方法：静态阅读 + 四门原样复跑 + 自建 Node 探针（临时脚本置于系统 `%TEMP%`，运行后删除，未落进仓库）。

## 1. 结论

| 级别 | 数量 | 摘要 |
| --- | --- | --- |
| **P0** | **0** | 未发现数据丢失、错误胜者或跨实现字节漂移。 |
| **P1** | **2** | P1-1 §4 强制的 `equalTsResolved` 计数/行为日志在读取 API 中缺失且无法由调用方补回；P1-2 三类误用只靠注释防护，`day.records` 原样暴露可让调用方轻易复活已删记录。 |
| **P2** | **5** | 标量数组元素不计错；`media.sha256` 未校验 64 位十六进制；并列判定用时刻相等而非 ts 字节相等（两实现一致，契约措辞漂移）；测试钉住实现琐事；`closed_at` 空白串被当作缺省。 |

**判定：Safe to build on（附强制条件）**——模块自身的折叠、账本、open 谓词、键序、UTF-8 字节比较均正确，且与迁移工具**逐字节一致**；四门全绿。下一模块必须落实第 5 节的调用方义务，尤其 P1-1 需先扩展读核（补计数钩子）才能声称满足 §4，P1-2 必须把「统一入口」做成代码约束而非仅注释。

---

## 2. 逐规则契约符合性

| 规则 | 证据 | 结论 |
| --- | --- | --- |
| 一条一整行 + pretty JSON 双形态 | `extractRecords` `timeline.ts:339–391`（`blockStart`/`braceDepth` 配平）；测试 01/02 | ✅ |
| 坏行/坏元素跳过并计数 | `consumeBlock:311–333`、`parseLedger:516–559`；测试 03/04/17 | ✅（对象形态）；❌ 标量元素见 P2-1 |
| `expectedDate` 权威、`date` 不符记错并保留记录 | `parseTimelineDay:481–492`；测试 07 | ✅ |
| `open` 只看 `closed_at`，`done` 不参与 | `openRecords:638–648`；测试 13/14/15 | ✅ |
| 删除/撤销优先级 `R > D` 才可见，同 ts 删除胜 | `deletionState:594–620`（`compareTs(restoredTs, deletedTs) > 0`）；测试 19/20/21/22/23 | ✅ |
| 同 `(id,ts)` 规范行 UTF-8 字节大者胜 | `foldDuplicateIds:442–469` + `byteCompare:181–191`；测试 25/26 + 本复审探针 | ✅（计数缺失见 P1-1） |
| 完全相同的重复行折叠为一条 | `foldDuplicateIds:463` 仅在 `> 0` 时替换；测试 27 | ✅ |
| 未知字段原样保留、排在已知键之后 | `canonicalRecordLine:199–213`；测试 08/11 | ✅ |
| 媒体裸名 `<hex16>.jpg`，拒绝 `media/…`、`../`、绝对、非 16 hex | `MEDIA_FILE_RE:105`、`validMedia:284–309`；测试 28/29/30 | ✅（`file`）；`sha256` 见 P2-2 |
| schema 门槛 2 / 其他 / 缺失 / 畸形分别给 typed reason，永不抛 | `parseSchemaMarker:562–588`；测试 31/32/33 | ✅ |

## 3. Findings

### P1-1 · §4 要求的 `equalTsResolved` 计数与行为日志无法从读取 API 获得

`timeline.ts:71–75` 的返回契约只有 `day` 与 `errors`：

```ts
export interface ParsedTimelineDay {
  day: TimelineDay | null;
  errors: TimelineParseError[];
}
```

`timeline.ts:462–466` 在同 ts 裁决处只更新胜者、不计数：

```ts
const line = canonicalRecordLine(record);
if (byteCompare(line, winnerLines.get(record.id) ?? '') > 0) {
  winners.set(record.id, record);
  winnerLines.set(record.id, line);
}
```

`parseTimelineDay:511–512` 直接返回折叠结果：

```ts
const records = foldDuplicateIds(extractRecords(source, openBracket, errors));
return { day: { date: expectedDate, open: open, records: records }, errors: errors };
```

契约 §4（`DATA-CONTRACT-v2.md:99`）Normative：「读侧把这类行计入 `equalTsResolved` 计数并写一行行为日志」。败者已被 `foldDuplicateIds` 丢弃，调用方拿不到原始重复行，无法在外部补计数；下一模块若只读本 API 就必然漏掉该可观测量。探针证实：`'equalTsResolved' in parseTimelineDay(...)` → `false`（胜者 `body=B` 正确）。**建议**：在 `ParsedTimelineDay` 增 `equalTsResolved: number`（或返回裁决明细），并补一条测试钉住该计数。

### P1-2 · 三类误用仅文档防护，`day.records` 可原样复活已删记录

`timeline.ts:58–63` 把未过滤的数组直接暴露：

```ts
/** 一日的内存视图。date 取目录名（权威）；open 按文件原样暴露、读路径不信任。 */
export interface TimelineDay {
  date: string;
  open: string[];
  records: TimelineRecord[];
}
```

文件头 `:15–19` 与 `visibleRecords:622` 注释说明了义务，但类型与 API 不阻止：

```ts
/** 读侧统一入口：先按账本过滤，再给出可见记录（不做排序、不改入参）。 */
export function visibleRecords(
  day: TimelineDay, deletions: LedgerEntry[], restores: LedgerEntry[]
): TimelineRecord[] {
```

回答任务提问：

- **trusting `day.open`**：`openRecords:644–647` 确实不读 `day.open`，但调用方直接渲染 `day.open` 仍会展示陈旧 id；仅注释防护。
- **reading `day.records` raw**：`day.records` 含已被账本判删的版本行；调用方跳过 `visibleRecords()` 即**轻易复活已删记录**。接口注释甚至没有对 `records` 给出「未过滤」警示（只对 `open` 给了）。
- **assuming the gate is auto-enforced**：`parseSchemaMarker` 是纯函数，模块不写盘、不调用任何 `assertWritable()`；调用方必须自行在每次写前挂门禁。

这不是模块算错，而是契约 §7「列表 / 详情 / 汇总 / 未完成索引全部调用统一入口」只能靠纪律落地。建议下一模块把「解析→账本→可见→open」封成一个不可绕过的高层 loader，并把 `TimelineDay` 标为内部类型。

### P2-1 · `records[]` 中的标量/非对象元素被静默丢弃且不计错

`extractRecords:362–377` 只在 `{}` 配平结束时调用 `consumeBlock`：

```ts
if (ch === '{') { if (braceDepth === 0) blockStart = i; braceDepth += 1; continue; }
if (ch === '}') { ... if (braceDepth === 0 && blockStart >= 0) {
  consumeBlock(source.slice(blockStart, i + 1), lineOf(source, blockStart), errors, out);
  blockStart = -1;
} }
```

数组元素 `42` / `"oops"` / `[]` / `null` / `true` 没有分支，既跳过也不 `errors.push`。探针：`records=1, errors=0`（契约要求「跳过并计数」）。虽非正常写路径产物，但 fail-soft 口径不一致。

### P2-2 · `media[].sha256` 只校验非空，未校验完整 64 位十六进制

`timeline.ts:296–297`：

```ts
} else if (typeof media.sha256 !== 'string' || media.sha256.length === 0) {
  problem = `media[${i}].sha256 必须是非空字符串`;
}
```

契约 §5 要求 `sha256` 为完整 64 位十六进制。探针注入 `sha256:'not-hex-!!'` → `errors=0`、条目被保留。迁移工具 `mapRecord:291` 同样只查非空，两实现一致，故不构成互操作分歧。

### P2-3 · 并列判定用「时刻相等」而非契约的「ts 字节相同」

`timeline.ts:131–142` 的 `compareTs` 先 `Date.parse`，相等即进入 tie-break（`foldDuplicateIds:453–466`）；迁移工具 `cmpTs:137–144` 同形。契约 §4 写的是「`ts` 字节相同而规范整行不同」。两个**字节不同但时刻相同**的 ts（如 `+08:00` 与 `Z` 写法）会走字节裁决路径。两实现一致、结果确定，属措辞漂移而非分歧；探针核对了字节大者仍胜。

### P2-4 · 测试钉住实现琐事，且缺若干 Normative 用例

实现琐事：`timelineRead.test.mjs:441–448` 断言导出键**恰好**为 9 个（任何新增 helper 都会失败）；`:192` `!/\s/.test(line.replace(/我|标题|ocr/g, ''))` 用 ad-hoc 字符剥离验证「无空格」；`:431–439` 对源码文本做正则的 Date.now 元测试。它们是维护护栏，不是契约行为。

缺失用例（Normative）：① 标量数组元素应计数（P2-1）；② sha256 64-hex（P2-2）；③ `equalTsResolved`（P1-1）；④ 与迁移工具的**直接**逐字节对比（当前两侧各自钉住 §3 示例，未互相钉住）；⑤ 扫描器在字符串含 `}`/`]`/`\"` 与嵌套对象时的行为（本复审探针已补验，通过但未固化为测试）；⑥ 无 SDK import 的静态断言（当前源码确为零 import）。

### P2-5 · 空白字符的 `closed_at` 被当作缺省

`timeline.ts:644–647` 用 `closed.trim().length === 0`，比契约 §6「空串等同缺省」更宽松。探针：`closed_at:'   '` 被判为 open。脏数据下更宽容，风险低。

---

## 4. 跨实现逐字节对比（结论：**identical**）

两种方式，均通过：

1. **直接 helper 对比**：同一富记录（含中文、emoji、media、可选槽位、乱序未知字段 `zz`/`aa`）与人为打乱插入顺序后的对象，分别调用两侧 `canonicalRecordLine`，`Buffer.compare(Buffer.from(a,'utf8'), Buffer.from(b,'utf8')) === 0` → `true / true`。
2. **迁移夹具**：构造 v1 `devices/d1/schedules/2026-11-19.jsonl` 一条记录，运行 `node tools/migrate-v1-to-v2.mjs --repo … --apply --out … --quiet`（CLI 回执 `verify ok days=1 records=1 …`），读出 `timeline/2026-11-19/records.json` 的记录行；该行字节与 `timeline.canonicalRecordLine(JSON.parse(行))` **以及** `migration.canonicalRecordLine(JSON.parse(行))` 均逐字节相等 → `true / true`。

夹具实际产出行：

```
{"id":"m9x2k1-3fk","ts":"2026-11-19T09:30:00+08:00","title":"周会","body":"讨论同步方案","author":"我","done":false,"media":[],"ai_processed":false,"opened_at":"2026-11-19T09:30:00+08:00","zz":1,"aa":"中文"}
```

键序、无空格、未知字段末尾位置三者一致，未发现任何漂移。两侧各自用同一组 §3 示例字节钉住（`timelineRead.test.mjs:157–178`、`v2Migration.test.mjs:630–650`），因此任一侧键序漂移会被其自身测试抓到；尚未测试的形状组合见 P2-4④。

## 5. 正确性陷阱复验

- **手写 UTF-8 编码器**：`utf8Bytes:149–178`（代理对合成、孤立代理→U+FFFD）与 `byteCompare:181–191`。以 `Buffer.compare(Buffer.from(...), Buffer.from(...))` 为参照，探针全部一致：`中文 vs 😀`→😀；`中(1字符3字节) vs zz(2字符2字节)`→中（短串字节更大仍胜）；`U+E000 vs 😀`→😀（UTF-16 会选 U+E000，证明走的是字节序）；孤立代理 `\uD800 vs 😀`→😀。**PASS**。
- **括号配平扫描器**：`extractRecords:339–391`。注入 `title/body` 含 `} { ] [` 与转义 `\"`、`meta` 嵌套对象套数组套对象、`ai_structured` 内含 `} ] [` 的 pretty JSON → `errors=0, records=1`，全部字段原样保留。**PASS**。
- **重复 id 折叠**：胜者正确、败者静默丢弃且不报 error（测试 24–27 + 探针 `equal-ts → body=B`）。**PASS**（计数缺失另列 P1-1）。
- **无副作用 / 确定性**：全仓 grep 无 `import`/`require`/SDK import；`Date.now|new Date()|Math.random` 仅命中 `:30` 注释；`canonicalRecordLine`、`visibleRecords`、`openRecords` 不改动入参（探针 + 测试 35 验证 `sortRecordsForWrite` 非变更）；测试 36 验证同输入两次对象深等与字节相等。`tsc -p apps/arkui-schedule/tools/tsconfig.json` 在 `strict + types:[] + noUnusedLocals/Parameters` 下 exit 0。**PASS**。

## 6. 下一模块必须实现的调用方义务

1. **门禁**：任何写盘前先读 `timeline/schema.json` 并调用契约 §11 的唯一 `assertWritable()`（本模块只提供 `parseSchemaMarker` 判定，不强制）；未知/缺失且 `devices/` 存在 → typed 错误 + 零写入。
2. **禁用 `day.open`**：它只是文件原样缓存；未完成列表一律经 `openRecords()` 派生。
3. **禁用裸 `day.records`**：列表/详情/汇总一律经 `visibleRecords()`（再做 open 过滤）；直接渲染会复活已删记录。
4. **必须同时解析两本账本**：对 `deleted.jsonl` 与 `restore.jsonl` 各调 `parseLedger()`，并把两个数组传入**每一次**可见性/open 查询；漏传一方即等于关闭账本过滤。
5. **目录名优先**：`parseTimelineDay(text, <目录名>)`，不得传文件内 `date`；返回的 `errors`（date 不符、坏行、坏媒体）需按 no-silent-failure 纪律上报，跨日同 id 按 §6 报 `E_CORRUPT`。
6. **补足 §4 可观测性**：读侧 `equalTsResolved` 计数与行为日志本模块不提供，需扩展读核；败者写 `conflicts.jsonl`（含 `dedupeKey=sha256(losingLine)`）属 union 写阶段职责，本模块不写盘。
7. **写入保形**：写回时保持 `canonicalRecordLine` 的键序与未知字段末尾位置，勿剥离未知字段。

## 7. 门禁回执（原样复跑）

```
$ node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
TSC_EXIT=0

$ node --test apps/arkui-schedule/tools/test/timelineRead.test.mjs
ℹ tests 38 / ℹ pass 38 / ℹ fail 0 / ℹ skipped 0   (TEST_EXIT=0)

$ node --test "packages/dsh-dots/test/*.test.mjs" "apps/arkui-schedule/tools/test/*.test.mjs"
ℹ tests 2386 / ℹ suites 309 / ℹ pass 2385 / ℹ fail 0 / ℹ skipped 1   (FULL_EXIT=0)

$ node apps/arkui-schedule/tools/validate-app.mjs
✅ 全部通过：8/8 条规则（JSON5/JSON 70 个、相对 import 355 条、main 静态 import 448 条、页面 7 个、rawfile/git 2 个文件）   (VALIDATE_EXIT=0)
```

与任务书期望完全一致（38/38；2386 / 2385 / 0 / 1；tsc 0；validate-app 8/8）。

## 8. `unverified`

- 真机 / ArkTS 严格类型编译与设备行为：`unverified`（`项目理解.md` §4：`hdc list targets` 为空、无 DevEco/SDK）。本复审只覆盖纯 TS 模型与 Node 逻辑。
- 双端 git 并发、union→replay、`assertWritable()` 端到端零写入、媒体占位渲染：`unverified`（超出本读模块范围）。
- 两份 `canonicalRecordLine` 副本仅在测试用例覆盖的字段形状上被证明一致；未覆盖的组合（如整数样式的未知键、值为 `undefined` 的已知键）的长期一致性 `unverified`；彻底解法是抽取共享纯函数。
- 任务书行号 615 / 439 与 UTF-8 实际 648 / 448 的差异已确认是 `Get-Content` 默认编码计数伪影，不影响文件内容；本文引用以后者为准。
- 本复审未运行 `git status`，未核实工作树是否有其他未提交改动（只读范围之外）。
