# 独立评审：`mod-v2-migration` 与 `mod-insert-page-count`

> 基线：HEAD `cec3c93`；评审对象为工作区中两个未提交模块。评审前按要求依次读取了
> `C:\Users\GWL\Desktop\itwillclaude\项目理解.md`、`docs/MODULES.md`、
> `docs/DATA-CONTRACT-v2.md`（v2-draft-2，358 行），并核对 `docs/DATA-CONTRACT.md`（v1）的
> 正交性。本报告之外未改动任何仓库文件；所有实验在 `%TEMP%` 临时目录中进行。
> 工具链：Node `v24.14.0`，Windows。

## 1. 结论

| 模块 | P0 | P1 | P2 | 阻塞判定 |
| --- | --- | --- | --- | --- |
| `mod-v2-migration`（`tools/migrate-v1-to-v2.mjs` 556 行 + `apps/arkui-schedule/tools/test/v2Migration.test.mjs` 30 例） | 1 | 4 | 3 | **阻塞提交**：P0-1 会静默丢失同 `(id,ts)` 的一个版本；P1-1～P1-4 为契约明文规则的确定性违反，且 3 条被测试反向钉死 |
| `mod-insert-page-count`（`RecordEditorView.ets` +21/−1，`handwritingToolbar.test.mjs` +12/−0） | 0 | 0 | 2 | **不阻塞**：根因修复方向正确、测试纯增量；两个 P2 是同一实例复用/毫秒碰撞的残余边界，可跟进入 |

一句话：迁移工具的**骨架（dry-run、退出码、幂等拒绝、确定性字节）做对了**，但把契约里几条最关键的字节/语义规则写反了，而且测试用例把这些错误行为当成期望值固定下来；插入页修复本身是安全的（草稿键经 `sanitizeDraftKey` 清洗，无路径穿越），只剩实例复用与 `Date.now()` 碰撞两个边界。

## 2. Findings

### P0-1（阻塞）同 `(id, ts)` 未按 UTF-8 字节序裁决，败者行被静默丢弃、不写 `conflicts.jsonl`

**位置**：`tools/migrate-v1-to-v2.mjs:169-177`（折叠）；全文件无 `conflicts.jsonl` 写入。

```js
const prev = folded.get(key);
if (!prev) {
  folded.set(key, { day, rec });
} else {
  const cmp = cmpTs(rec.ts, prev.rec.ts);
  if (cmp > 0) folded.set(key, { day, rec });
  else if (cmp === 0) stats.duplicates += 1;   // ← 只计数，直接丢弃后到的一行
}
```

**契约**：§10 步骤 2 明定「同 ts 用 §4 tie-break 并把败者写进 `conflicts.jsonl`」；§4 P0-1 明定比较函数为
`Buffer.compare(Buffer.from(lineA,'utf8'), Buffer.from(lineB,'utf8'))`，取字节序较大者，败者原样追加到当日
`conflicts.jsonl`（`dedupeKey = sha256(losingLine)`，按 `(id,ts,dedupeKey)` 去重）。

**实测证据**（自建夹具，两行同 id `c`、同 ts `09:00`，标题分别为 `first`/`second`）：

```
[migrate] verify ok days=1 records=3 deletes=0 summaries=0 skipped=0
  {"id":"c",...,"title":"first",...}     ← 保留，仅因为它在文件里先出现
=== produced files ===
\records.json                             ← 无 conflicts.jsonl
```

按契约 `second`（字节 `0x73`）应胜过 `first`（`0x66`），且败者应进账本；实测结果既选错胜者，也把败者彻底丢弃，无恢复路径。
**影响**：真实 v1 数据在秒级 `ts` 上并列是常态（§4 明确「并列是常态而非异常」），迁移会静默丢一侧内容，属于不可恢复数据损失。

**具体修法**：在 `cmp === 0` 分支先 `canonicalRecordLine()` 规范化两行，再 `Buffer.compare(Buffer.from(a,'utf8'), Buffer.from(b,'utf8'))` 定胜者；败者写入当日 `conflicts.jsonl` 一行
`{id, ts, losingLine, decidedAt, dedupeKey}`（`decidedAt` 同样由输入 `ts` 派生，不得用墙钟）；每个日文件夹都创建空的 `conflicts.jsonl`。同时修正测试 03（见 §4）。

### P1-1（阻塞）媒体占位的 `file` 字段带了 `media/` 前缀

**位置**：`tools/migrate-v1-to-v2.mjs:248`

```js
file: `media/${att.sha256.slice(0, 16)}.jpg`,
```

**契约**：§3 第 82 行「`file` 是**不含路径的文件名**，任何写入端不得带 `media/` 前缀（P2-11）」；§5 第 110 行「`file` 含 `/` 或 `..` → 校验失败并计数」；§10 步骤 3 明确占位形状为 `file:"<sha16>.jpg"`。

**实测证据**：

```
"media":[{"file":"media/0123456789abcdef.jpg","sha256":"0123...","pageIndex":0}]
```

**影响**：迁移产物在 v2 读侧会被判为非法媒体字段并计数丢弃，占位组件/后续 `mod-v2-media-migration` 解析全部对不上；测试 19 反向钉死该错误字节。
**具体修法**：改为 `file: \`${att.sha256.slice(0, 16)}.jpg\``；测试 19 同步改为断言无 `/`。

### P1-2（阻塞）`open` 数组按 `done` 派生，而不是按 `closed_at` 是否缺省

**位置**：`tools/migrate-v1-to-v2.mjs:280`

```js
const open = records.filter((r) => r.done !== true).map((r) => r.id);
```

**契约**：§6 P2-2「**未完成 iff `closed_at` 缺省（空串等同缺省）**；`done` 只作展示，不参与判定」；可测例「`{done:false, closed_at:'...'}` → 不在 `open`；`{done:true, closed_at:null}` → 在 `open`」。

**实测证据**（记录 `m` 有 `closed_at=09:20` 且 `done=false`）：

```
"open": [ "c", "m", "r" ]      ← m 有 closed_at 却仍被列进 open
```

**影响**：`records.json` 顶层的 `open` 缓存从迁移第一天起就是错的，与读侧重算结果不一致（虽然 §6 规定读侧不信任 `open`，但工具被明确要求实现 §10 的派生规则，且报告/对外数据会引用此数组）。测试 07 反向钉死该错误谓词。
**具体修法**：`const open = records.filter((r) => !r.closed_at).map((r) => r.id);`（`''` 同样视为缺省），并改测试 07 为 §6 的两条可测例。

### P1-3（阻塞）已知可选字段未在规范键序位置输出，破坏了 `canonicalRecordLine` 的字节唯一性

**位置**：`tools/migrate-v1-to-v2.mjs:237-254`、`:267-275`

```js
const out = { id, ts, title, body, author, done, media, ai_processed /* … */ };
...
// 契约 §3：未知扩展字段（以及 ocr_text / ai_structured / ocr_time 等已知可选字段）
// 必须原样保留，且排在已知字段之后；已映射的 attachments/墓碑标记不复制。
for (const key of Object.keys(rec)) { ... Object.defineProperty(out, key, {...}); }
```

**契约**：§3 记录字段表给出的规范键序为
`id, ts, title, body, author, done, media, ocr_text?, ai_structured?, ai_processed, ocr_time?, opened_at, closed_at?`；
「未知扩展字段排在末尾」只适用于**未知**字段。源码注释把 `ocr_text/ai_structured/ocr_time` 也当作「排在已知字段之后」，与契约相反。

**实测证据**（含 `ocr_text`/`ai_structured`/`ocr_time` 的记录 `m`）：

```
...,"media":[...],"ai_processed":false,"opened_at":"...","closed_at":"...","ocr_text":"OCR","ai_structured":"...","ocr_time":"..."
```

规范要求 `ocr_text`/`ai_structured` 在 `ai_processed` **之前**，`ocr_time` 在 `opened_at` **之前**。
**影响**：§3 要求序列化字节逐字符唯一，§4 tie-break、§9 P1-2 判重都只在这一种字节形状上进行；键序不同会跨实现产生不同字节，动摇裁决/判重的前提。测试 21 只检查 `future_field` 在末尾，漏掉了已知可选字段的位置。
**具体修法**：显式按 §3 表顺序构造 `out`（存在才写对应可选键），最后只追加真正未知字段；补一条断言完整键序的测试。

### P1-4（阻塞）`restore.jsonl` 与空账本文件从不创建；v1 的恢复版本未落账

**位置**：`tools/migrate-v1-to-v2.mjs:378-384`（只按条件写 `deleted.jsonl`/`summary.json`）、`:282-284`（只从 `deleted===true` 生成 deletes）。

```js
if (day.deletesText) fs.writeFileSync(path.join(dir, 'deleted.jsonl'), day.deletesText, 'utf8');
if (day.summaryText) fs.writeFileSync(path.join(dir, 'summary.json'), day.summaryText, 'utf8');
```

**契约**：§2 布局列出每日 `deleted.jsonl`/`restore.jsonl`/`conflicts.jsonl`；§10 步骤 2 要求建各日文件夹时「含空的 `deleted.jsonl` / `restore.jsonl` / `conflicts.jsonl`」；步骤 5 要求「若存在更晚恢复版本则保留记录、不写账本、并按 §7 写 `restore.jsonl`」。

**实测证据**：夹具中 id `r` 先有 `deleted:true`（11:00）后有 `deleted:false`（12:00），产物目录只有 `\records.json`，`deleted.jsonl`/`restore.jsonl`/`conflicts.jsonl` 全部不存在。
**影响**：读侧 `visibleRecords()` 依赖 `restore.jsonl` 的 `R.ts` 与 `deleted.jsonl` 的 `D.ts` 比较（§7）；迁移不写恢复账本会让「删了又恢复」的历史语义丢失，且空账本缺失使读侧路径假设不成立。
**具体修法**：每个日文件夹无条件创建三个空 JSONL；识别 v1 墓碑之后更晚的 `deleted:false` 版本，写一条 `{id, ts, restoredAt}`（时间由输入 `ts` 派生）。

### P2-1 "原子合并"实为逐文件复制，且校验只覆盖本次计划内的日期

**位置**：`tools/migrate-v1-to-v2.mjs:387-405`、`:413-418`

```js
fs.mkdirSync(final, { recursive: true });
for (const name of fs.readdirSync(stage)) { ... fs.cpSync(src, path.join(final, name), { recursive: true }); }
...
for (const day of plan.days) { ... const file = path.join(dir, 'records.json'); ... }
```

**契约**：§10 不变量「crash-safe（每个日文件夹原子写，标记最后落地）、逐字节校验」。
**影响**：进程在复制中途崩溃会留下半写好的日期目录；第二次无 `--force` 直接拒绝，`--force` 又因目录已存在而跳过，坏目录无法自愈。`verifyPlan` 只遍历 `plan.days`，计划外的已坏目录不会被发现。
**具体修法**：按日写入 staging 后用目录级原子 rename 落位（或先写临时目录再整体替换），并把校验范围扩展到 `timeline/` 下全部已有日目录。

### P2-2 缺少契约点名的纯函数 `canonicalRecordLine()`

**位置**：`tools/migrate-v1-to-v2.mjs:292-310`（序列化内嵌在 `serializeRecords` 中）。
**契约**：§3 第 48 行「必须存在纯函数 `canonicalRecordLine(record)`，其输出与本节示例的字节（含键序）逐字符一致」。
**影响**：无法对该纯函数单独做「序列化两次字节相等 / 交换字段后规范化恢复示例序」的可测断言；当前实现依赖对象字面量的插入顺序，容易在后续改动中回退成 P1-3。
**具体修法**：抽出并导出 `canonicalRecordLine()`，由 `serializeRecords()` 调用，补 §3 的两条纯函数测试。

### P2-3 三条测试把契约违规当成期望值钉死

**位置**：`apps/arkui-schedule/tools/test/v2Migration.test.mjs:138-150`（测试 03）、`:199-208`（测试 07）、`:366-378`（测试 19）。

- 测试 03 断言同 `(id,ts)` 保留 `first` 且无 `conflicts.jsonl` 断言 → 正确实现（保留 `second`）会失败；
- 测试 07 断言 `open === ['early','late']`（按 `done!==true`）→ 正确实现（按 `closed_at`）会失败；
- 测试 19 断言 `{file: \`media/${...}.jpg\`}` → 正确实现（无前缀）会失败。

**影响**：修好代码必先改测试，否则全绿反而成为阻断；评审应以契约而非这些断言为准。具体修法见各 P1 条目。

### P2-4（插入页）编辑器实例被复用为第二张新记录时，草稿键不会更新

**位置**：`apps/arkui-schedule/entry/src/main/ets/components/RecordEditorView.ets:153-154`、`:585-596`；
`apps/arkui-schedule/entry/src/main/ets/pages/Index.ets:1567-1581`。
源码键只在字段为空时生成：

```ts
if (this.writingDraftKeyValue.length === 0) {
  this.writingDraftKeyValue = `new-${Date.now().toString()}`;
}
```

右栏 `if (this.paneMode === 'editor') { RecordEditorView({ recordId: this.editorRecordId, ... }) }` 在 `paneMode` 保持 `'editor'` 时不会销毁组件；`onNewTap()`（Index.ets:531-542）把 `editorRecordId` 设为 `''` 但 `paneMode` 赋值前后相同，`paneTick` 的 `@Watch('onRefreshTick')` 也不重置该字段。若用户在编辑器内再次点「新建」，同一实例会沿用上一张新记录的 `new-<ts>` 键，手写板恢复出错误的页数/笔迹——正是本模块要修的症状换了一条路径复现。
**具体修法**：把 `recordId` 改成 `@Prop @Watch('onRecordIdChanged')`，在 watcher 中清空 `writingDraftKeyValue`；或在右栏用随记录切换而变化的 `id`/`if` 分支强制重建组件。真机生命周期行为标 `unverified`。

### P2-5（插入页）`Date.now()` 毫秒碰撞，且未复用已有 `newDraftKey()`

**位置**：`RecordEditorView.ets:590`；对照 `apps/arkui-schedule/entry/src/main/ets/model/draft.ts:176-180`。
同一毫秒内两次取键（双栏各开一张新记录、或快速连点新建）会得到相同 `new-<ts>`，手写草稿互相覆盖。仓库已有 `newDraftKey(now)` 但同样只有时间戳、无随机后缀。
**具体修法**：`new-${Date.now().toString(36)}-${(seq++).toString(36)}-${randomSuffix}`，或让新记录先分配正式 record id 再把它作为 `draftKey` 传入（最稳，且与已有记录口径统一）。

## 3. 确定性与安全性论证

**无墙钟时间**：对 `tools/migrate-v1-to-v2.mjs` 全文 grep `Date.now|new Date\(\s*\)|Date\(` 仅得到 3 处：`new Date(ms).toISOString()`（`:110`，`ms` 来自 `Date.parse(ts)` 或数值 `generatedAt`）、注释（`:11`）、`timeline.tmp-${process.pid}`（`:372`，仅 staging 目录名，成功时 `:535` 删除）。`migratedAt` 由全部输入 `ts` 的最大值派生（`:320-324`），`deletedAt` 由墓碑 `ts` 派生（`:283`）。没有无参 `new Date()` / `Date.now()`。

**两次运行逐字节一致**（自建夹具含 1 记录 / 1 删除 / 1 open / 1 summary / 1 附件）：

```
=== DETERMINISM: two --apply into separate --out dirs ===
[migrate] verify ok days=1 records=1 deletes=1 summaries=1 skipped=0
exitA=0
[migrate] verify ok days=1 records=1 deletes=1 summaries=1 skipped=0
exitB=0
=== git diff --no-index outA/timeline outB/timeline ===
diffExit=0        ← 输出为空且退出码 0，两棵树逐字节相同
```

**安全性与退出码**（实测）：

| 场景 | 结果 |
| --- | --- |
| 默认 `--dry-run` | 测试 11：执行前后 `tree(repo)` 完全相同，无 `timeline/`、无 staging |
| 无 `devices/` | exit 2，`emptyDirChildren=0`（零写入） |
| `schemaVersion=3` | exit 2，`dayDirExists=False`（零写入） |
| 第二次普通 `--apply`（已有 `timeline/`） | exit 2，`treeUnchanged=True` |
| 损坏既有日 + `--force` | exit 3，`staging=timeline.tmp-38256`（现场保留） |
| `--force` 补新日 | 日志 `skipped-existing days=2026-11-19`，旧日文件 SHA256 不变；测试 14 进一步确认新日被创建 |

结论：dry-run / 拒绝零写 / 失败留现场 / 幂等拒绝 / force 只补缺日这五条都成立；唯一瑕疵是 P2-1 的「逐文件复制并非原子落位」。

## 4. 测试质量评估

30 例全部通过（`node --test apps/arkui-schedule/tools/test/v2Migration.test.mjs`：`tests 30 / pass 30 / fail 0`）。覆盖较好的规则：dry-run 零写（11）、两遍字节确定性（10）、`deletedAt`/`migratedAt` 由 `ts` 派生（24、29）、键序与一行一对象（12）、无 `schemaVersion`（20）、未知字段原样保留（21）、四类拒绝与失败现场（15–18）。

**会拦住正确实现的测试**：03、07、19（见 P2-3）——它们把 P0-1/P1-2/P1-1 的错误行为当契约。这说明 30/30 全绿不是质量证明，反而说明错误被固化。

**钉实现细节而非契约行为**：测试 26（`--quiet` 输出格式）、`plan days=...` 正则（01/09/22 等）主要核对日志文案；这类断言本身可接受，但不应替代对产物字节/语义的断言。

**缺失的规范性用例（点名）**：

1. §4 P0-1：同 `(id,ts)` 不同内容 → UTF-8 字节序较大者胜、败者进 `conflicts.jsonl` 且仅一份、`equalTsResolved` 语义（现有 03 相反）；
2. §6 P2-2：`{done:false, closed_at:'...'}` 不在 `open`、`{done:true, closed_at 缺省}` 在 `open`（现有 07 相反）；
3. §3 规范键序：含 `ocr_text`/`ai_structured`/`ocr_time` 时完整键序逐字符比对，以及 `canonicalRecordLine()` 纯函数的两条可测性断言；
4. §10 步骤 2/5：`deleted.jsonl`/`restore.jsonl`/`conflicts.jsonl` 空文件必须存在；v1「墓碑 + 更晚恢复版本」→ 写 `restore.jsonl`、不写 `deleted.jsonl`；
5. §7 账本只追加语义（旧字节是新字节严格前缀）在迁移产物上的体现；
6. §11「schema 标记最后落地」的崩溃时刻断言（模拟中途失败后重跑行为）。

插入页测试（`handwritingToolbar.test.mjs`）`git diff --numstat` 为 `12 0`，纯增量，未删改任何既有断言；新测试是源码级静态断言，能防止有人去掉 `draftKey` 传参或把已有记录键改回固定值，但无法覆盖 P2-4/P2-5 的运行时行为。

## 5. 插入页修复的安全边界（补充证据）

**(a) 旧代码确实回退固定键**：`git show HEAD:.../RecordEditorView.ets` 中 `const params: Record<string, string> = { 'date': dateParam };`，未传 `draftKey`；`Handwriting.ets:595-612` 的 `resolveDraftKey()` 依次取路由参数、`AppStorage.get('handwriting.draftKey')`，最后 `return DRAFT_KEY_DEFAULT;`。全仓 grep 显示 `handwriting.draftKey` 除读取处外**从未被写入**，所以新建记录必然落到 `'default'`。根因判断成立。

**(b) 新键稳定性**：`writingDraftKeyValue` 是组件实例字段，首次取键后缓存，`writingDraftKey()` 在 `recordId` 非空时返回 `recordId`（`:587-589`），新建时返回缓存的 `new-<ts>`；退出手写板再进入（编辑器实例未换）复用同一键——符合注释意图。

**(c) 已有记录行为**：由原先（无路由参数）的 `'default'` 改为 `recordId`，是修正而非回归；已存的 `'default'` 草稿不再被已有记录恢复，符合「草稿按记录隔离」的既有设计（编辑器正文草稿早已用 `draftKey(recordId)`，见 `RecordEditorView.ets:183,209`）。

**(d) 路径穿越：安全**。手写板侧先清洗：`Handwriting.ets:601` `return sanitizeDraftKey(fromRoute);`；`model/draft.ts:188-217` 只允许 `[A-Za-z0-9._-]`、拒绝纯点号、截断 64 字符；落盘路径再由 `draftStore.ets:45-46`：

```ts
draftPath(draftKey: string): string {
  return `${this.draftsDir()}/${draftFileName(draftKey)}`;
}
```

配合 `draft.ts:220-221` `draftFileName()` 再次 `sanitizeDraftKey`，`../` 会被替换成 `.._`，无法逃出 `<filesDir>/drafts`。路由参数来自本应用编辑器（可信），且即便被篡改也有双重清洗。静态结论成立；运行时标 `unverified`。

**(e) 与数据契约正交**：本模块只加路由参数和组件内字段，未改 `docs/DATA-CONTRACT.md`（`git status` 干净）或任何日程/草稿落盘格式，与 v1/v2 数据契约无冲突。

## 6. 门闸输出（原文尾部）

命令在 `C:\Users\GWL\Desktop\itwillclaude\dsh-sync-suite` 下执行，Node `v24.14.0`。

`node apps/arkui-schedule/tools/overlay.mjs status`：

```
覆盖层：未应用（工作区为「共享源码 + 平台目录」的原始形态）
[overlay] applied=false
```

`node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json`：

```
tscExit=0
```

`node --test "packages/dsh-dots/test/*.test.mjs" "apps/arkui-schedule/tools/test/*.test.mjs"`（尾部）：

```
✔ ⑤ 标记在但目标不全（上次中断）→ 从旧目录补齐并校验，旧数据不丢 (20.9058ms)
✔ ⑥ 无完成标记但有 pending 标记 + 目标已建且只搬了一半 → 补齐而不是永久 skip（评审 M1） (82.4886ms)
✔ ⑦ 补齐时目标已有同名条目 → 不覆盖用户数据，也不因旧目录残留而永久失败（评审 M3） (14.981ms)
ℹ tests 2337
ℹ suites 309
ℹ pass 2336
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 27345.0489
```

`node apps/arkui-schedule/tools/validate-app.mjs`：

```
🔍 校验 ArkUI-X 工程：C:\Users\GWL\Desktop\itwillclaude\dsh-sync-suite\apps\arkui-schedule
✅ 全部通过：8/8 条规则（JSON5/JSON 70 个、相对 import 355 条、main 静态 import 448 条、页面 7 个、rawfile/git 2 个文件）
validateExit=0
```

全部符合预期（2337 / 2336 / 0 / 1；8/8；tsc 0；`applied=false`）。本轮未出现并发写入导致的瞬时失败，无需重跑。

## 7. `unverified`

1. **真机 / 第二设备**：`hdc list targets` 为空、无 DevEco/SDK，所有 ArkTS 运行时行为（含 P2-4 的组件复用路径、手写板草稿实际恢复）均未实机验证。
2. **路径穿越的运行时验证**：`sanitizeDraftKey` 的静态清洗结论成立，但未在真机文件系统上注入恶意 `draftKey` 实测。
3. **v2 契约 §15 全部双端场景**：双设备 union/replay、同 ts 裁决双端一致性、schema 门槛、媒体占位、outbox 重试等尚无实现，无法验证；本报告仅评审迁移工具的离线逻辑与插入页修复。
4. **P0-1/P1-x 的修复后回归**：本次为只读评审，未改代码，故修复后的 30 例（含需反转的 3 例）与全量门闸尚未重跑。
5. 夹具实验在 Windows `%TEMP%` 完成，未覆盖 Linux/macOS 文件系统语义（如 rename 原子性、文件名大小写），P2-1 的修法需在目标平台复核。
6. `--force` 补新日的独立复核中，我误把新分片写到原夹具而非副本，导致本地打印 `newDayExists=False`；正确行为以测试 14（已通过，断言新日目录创建且旧日不变）为准，此项不作为 finding。

## 复审（2026-11-19 23:27，针对 P0/P1 修复）

> 独立只读复审，未改仓库文件；夹具自建于 `%TEMP%`。当前工具 766 行（原 556），测试 30→39 例。

| 项 | 判定 | 证据 |
| --- | --- | --- |
| 1 P0-1 同(id,ts)裁决 | **CLOSED** | 夹具 A(先 first 后 second)、B(先 second 后 first) 两台设备：胜者均为 UTF-8 字节较大的 `second`；`records.json`/`conflicts.jsonl`/`deleted.jsonl`/`restore.jsonl` 四文件两输出逐字节相同（diff 空）；败者 `first` 进 conflicts，`dedupeKey=sha256(losingLine)` 复算一致；败者重复 3 次仅落 1 行 |
| 2 P1-1 媒体 file | **CLOSED** | :293 `` `${sha.slice(0,16)}.jpg` ``；无 `media/`、无 `/`、无 `\`、无 `..`；测试 19 三向断言且两侧无 media 目录 |
| 3 P1-2 open 派生 | **CLOSED** | :387 `!r.closed_at`（缺失/空串/null 均缺省），`done` 不参与；测试 07(done:false+closedAt→排除；done:true+空→包含) 与 32(done:true+closedAt:null→包含) 双向探针 |
| 4 P1-3 规范键序 | **CLOSED** | :34-38 KEY_ORDER 与 §3 一致；:116-122 canonicalRecordLine 先已知槽位后追加未知字段；测试 33 完整键序、37 与 §3 两条示例逐字节比对 |
| 5 P1-4 三账本/恢复 | **CLOSED** | :461-466 每日本无条件写三账本（含空文件）；:374-376/393-395 墓碑+更晚恢复→保留记录、只写 restore.jsonl；测试 34/36/14 覆盖 |
| 6 P2-1 原子写/全量校验 | **CLOSED** | :508-523 temp dir+rename、失败清理；:665-693 校验遍历 `timeline/` 全部合法日目录；测试 35(注入失败无半写)、38(孤儿坏日→exit 3) |
| 7 P2-2 纯函数导出 | **CLOSED** | :116 `export function canonicalRecordLine`，`writeDayAtomic` 同导出；:754 CLI guard；实测 import 仅得两导出、零 CLI 输出 |
| 8 P2-3 测试反转/确定性 | **CLOSED** | 03/07/19 由钉死错误改为契约断言且更严（完整冲突行/双向探针/无分隔符）；新增 31-39 共 9 条回归，无删改；全文无 `Date.now()`/无参 `new Date()`，四个时间戳均由输入 ts 派生 |

**总体**：原 8 项全部 CLOSED，P0 已关闭、原阻塞解除。但本轮修复**新引入 1 条 P1**，故尚不能称干净提交。

**新发现（P1，修复引入）**：`verifyPlan` 的 `freshConflicts!==plan.conflicts` / `freshRestores!==plan.restores`（:695-700）拿「含被跳过日的计划全量」比「仅新建日的计数」。复现：先用含同 (id,ts) 冲突的 D1 迁移成功（conflicts=1），再给 v1 增 D2 并 `--apply --force` → 新日 D2 已建，但校验报 `conflicts 计数 0 != 预期 1`、exit 3、遗留 `timeline.tmp-<pid>`。凡被跳过日含 conflicts 或 restores（正是本轮 P0-1/P1-4 的产物）即误报失败；无数据丢失，但使 §10/USAGE 的「`--force` 只补缺失日」在历史冲突场景不可用，且推翻原报告 §7 第 6 条「测试 14 为代表」的适用范围（测试 14 无冲突）。修法：按日比对或仅对未跳过日累计 `plan` 计数。

**门闸尾部**（Node v24.14.0，本目录复现）：
- `node --test apps/arkui-schedule/tools/test/v2Migration.test.mjs` → tests 39 / pass 39 / fail 0 / skipped 0
- `node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json` → tscExit=0
- `node --test "packages/dsh-dots/test/*.test.mjs" "apps/arkui-schedule/tools/test/*.test.mjs"` → tests 2346 / suites 309 / pass 2345 / fail 0 / skipped 1 / cancelled 0（28.81s）
- `node apps/arkui-schedule/tools/validate-app.mjs` → 8/8，validateExit=0

