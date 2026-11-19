# REVIEW — `mod-v2-write-service`（v2 写入核心 + 惰性写入服务）

> 独立、只读评审（不修改任何被审源码）。评审日期 2026-11-20。
>
> 对象：`apps/arkui-schedule/entry/src/main/ets/model/timelineWrite.ts`、
> `apps/arkui-schedule/entry/src/main/ets/services/timelineWriteStore.ets`、
> `apps/arkui-schedule/tools/test/timelineWrite.test.mjs`（32 例）。
>
> **行数口径说明**：任务 brief 写 147 / 365 / 374 行，这与本机 PowerShell `Get-Content` 的计数
> 一致；但 `[System.IO.File]::ReadAllLines` 与 read 工具给出的物理行数是 **162 / 380 / 387**
> （`LF=162/380/387`，无 CRLF）。下文所有 `file:line` 一律用**后者**（与编辑器行号一致），
> 并在必要时给出可唯一定位的代码原文，避免行号口径歧义。
>
> 依据：`C:\Users\GWL\Desktop\itwillclaude\项目理解.md`、
> `docs/DATA-CONTRACT-v2.md` §3/§4/§6/§7/§9/§11、`docs/MODULES.md`；
> 上下文：`services/timelineStore.ets`、`model/timeline.ts`、`services/scheduleStore.ets`、
> `services/draftStore.ets`。
>
> 证据等级：模型层跑的是真实编译产物（`tools/.build/model/timelineWrite.js`），
> 服务层 `.ets` 无法在 Node 中执行，只有静态源码断言；真机 / 第二设备结论一律 `unverified`。

---

## 0 结论（P0 / P1 / P2 + blocking）

| 级别 | 条数 | 核心结论 |
| --- | --- | --- |
| **P0** | 1 | `atomicWriteIn` 的 rename 失败回落路径**先删临时文件、再删原文件、再对已删除的临时文件 rename**：回落 100% 失败且**原文件已被删除**，属于数据丢失。见 F1。 |
| **P1** | 2 | (a) §7 P1-4 的「5 秒删除撤销」无法用现有 API 实现：`remove()` 立即物理删行且没有 ledger-only 的 `schedule()` 方法，`restore()` 也不校验 `ts` 严格晚于删除 `ts`；(b) `appendSummary` 的 `generatedAt` 缺失分支会把**坏候选写上去覆盖好汇总**，违反 §8。见 F2 / F3。 |
| **P2** | 5 | tmp 名只含进程内序号（跨实例碰撞）、`assertWritable()`/分支门禁缺失、重开未刷新 `opened_at`、账本按整行去重而非 `(id,ts,intentId)`、写侧不校验 `ts` 形状。见 F4–F8。另有 §4 `conflicts.jsonl` 败者落盘属于同步模块职责，本模块未实现（见 §4）。 |

**Blocking 判定**：

- 对**本批次「已写完、待提交、未接线、默认 v1」的状态**：**不阻塞提交**。
  `isEnabled()` 唯一依赖 `timelineStore.useV2()`，而 `readMode` 默认 `'v1'` 且全仓无任何调用点
  （`.ets` 范围内 `grep timelineWriteStore` 只命中服务自身 `:27/:135/:380`；模型 `.ts` 头部仅一处
  注释提及），因此本模块当前零运行时影响、可安全回滚。
- 对**任何启用动作 / `mod-v2-dual-write-off` 集成**：**阻塞**。
  P0 必须在首次 v2 写盘前修复；P1 两条必须在删除 / 汇总路径接线前修复或明确由后续模块接管。
  门闸全绿（32/32、2517/2516/0/1、8/8、tsc 0、overlay applied=false）**不能**证明上述
  运行时语义正确——失败路径与 `.ets` 行为完全没有被测试覆盖。

---

## 1 Findings（file:line + 原文引用）

### F1 — P0，阻塞：`atomicWriteIn` 回落路径丢原文件

`services/timelineWriteStore.ets:266–290`：

```
266:  /** 同目录 `.tmp-<序号>` → rename 覆盖，失败清临时文件并抛中文错误。 */
267:  private atomicWriteIn(dir: string, fileName: string, text: string): void {
...
272:    this.writeTextSync(tmpPath, text);
273:    try {
274:      fs.renameSync(tmpPath, path);
275:      return;
276:    } catch (error) {
277:      const reason: string = this.errorText(error);
278:      this.cleanupTemp(tmpPath);
279:      try {
280:        // 平台不接受覆盖式 rename 时的回落：删旧 → 改名（与 draftStore 同口径）。
281:        if (this.fileExists(path)) {
282:          fs.unlinkSync(path);
283:        }
284:        fs.renameSync(tmpPath, path);
285:      } catch (fallbackError) {
286:        this.cleanupTemp(tmpPath);
287:        throw new Error(`原子写入失败（${path}）：覆盖式改名失败（${reason}），回落也失败（${this.errorText(fallbackError)}）`);
288:      }
289:    }
290:  }
```

`cleanupTemp` 的定义（`:306–314`）确实是**物理删除**临时文件：

```
306:  private cleanupTemp(tmpPath: string): void {
307:    try {
308:      if (this.fileExists(tmpPath)) {
309:        fs.unlinkSync(tmpPath);
310:      }
311:    } catch {
```

因果链：首选覆盖式 `rename` 失败 → `:278` 删掉唯一一份新内容 → `:282` 删掉原文件 →
`:284` 对**已不存在**的 tmp 再 rename，**必然抛错** → 对外报错时 `records.json` / 账本 /
`summary.json` 已经从磁盘消失。契约 §7 P2-3 要求「原子替换」且本批次自己声明
「失败清临时文件并抛中文错误」，但代码同时删了原文件，二者都不成立。

对照参考实现 `services/draftStore.ets:139–158`：它**只在首选 rename 的 catch 里记原因**，
不在回落前清 tmp，回落失败才 `cleanupTemp`；两者同目录 rename 且 draftStore 还有启动扫描
兜底残留 `.tmp`（`draftStore.ets:186–223`）。本模块照抄了回落结构，却**漏掉了这个关键差异**
并新增了 `:278` 的提前清理——即「与 draftStore 同口径」的注释与代码不符。
（另：评审期间契约 §11 末尾被并发补写为 `*.tmp-<pid>`，本实现是 `.tmp-<序号>`；
pid 并非 §7 P2-3 的规范项，属 P2 级文案漂移。）

触发条件并非理论：draftStore 文件头明确写着「鸿蒙上 renameSync 覆盖已存在目标**未经真机验证
（unverified）**」（`draftStore.ets:14–15`）。一旦真机不支持覆盖式 rename，本模块**每一次**写
`records.json` / 账本 / summary 都会走到这条丢文件的路径。修复建议：删除 `:278` 的
`cleanupTemp`，照 draftStore 把 `reason` 留到回落失败的报错里；并考虑加启动扫描恢复残留 tmp。

### F2 — P1：`remove()`/`restore()` 无法承载 §7 P1-4 的删除撤销

`services/timelineWriteStore.ets:86–99`（删除）：

```
86:  remove(id: string, date: string, ts: string): void {
87:    this.requireEnabled();
88:    this.requireReady();
89:    const base: TimelineRecord[] = this.visibleOf(date);
...
94:    const line: string = ledgerDeleteLine(id, ts, ts);
95:    if (line.length > 0) {
96:      this.appendLedgerLine(this.dayDir(date), DELETED_FILE_NAME, line);
97:    }
98:    this.atomicWriteIn(this.dayDir(date), RECORDS_FILE_NAME, plan.text);
99:  }
```

`services/timelineWriteStore.ets:102–110`（撤销）：

```
102:  restore(id: string, date: string, ts: string): void {
103:    this.requireEnabled();
104:    this.requireReady();
105:    const line: string = ledgerRestoreLine(id, ts, ts);
...
109:    this.appendLedgerLine(this.dayDir(date), RESTORE_FILE_NAME, line);
110:  }
```

契约 §7 P1-4（`docs/DATA-CONTRACT-v2.md:147–156`）是**三个动作**：

- `:149` `schedule()`：只追加 `deleted.jsonl`，**不动 records.json 行**，启动 5 秒倒计时；
- `:150` `cancel()`：追加 `restore.jsonl`，其中 `ts` **严格晚于删除 ts**；
- `:151` `confirm()` / 超时：才物理移除行。

本模块公开 API 只有 `ensureReady / isEnabled / append / remove / restore / appendSummary`，
**没有「只写账本、保留记录行」的 schedule 入口，也没有 confirm 入口**。`remove()` 把
`schedule + confirm` 合成一步：`:98` 总是物理删行。于是两种接法都不成立：

1. 在 `schedule()` 时调 `remove()` → 行被删光；随后 `cancel()` 调 `restore()` 只追加账本，
   `records.json` 里已无该 id 的行，`visibleRecords()` 找不到行可复活 → **撤销必然失败**；
2. 在 `confirm()` 时调 `remove()` → 账本直到确认才写，违反 §7「账本在 schedule 时即落盘，
   远端立刻能看到删除 / 崩溃前不丢删」。

另外 `restore()` 完全不读 `deleted.jsonl`（对比 `visibleOf()` 在 `:161` 读了它），
不校验传入 `ts` 是否严格大于该 id 的最大删除 `ts`；按 §7:155 的读侧优先级，`ts ≤ D` 时
记录仍不可见，调用方却以为撤销成功——属于静默失败。

本模块文件头自称「与 §7 对齐」（`:6`），但 API 形状不足以对齐 P1-4。修复建议：拆成
`scheduleDelete(id,date,ts)`（只追加账本）、`confirmDelete(id,date)`（只删行）、
`cancelDelete(id,date,ts)`（追加 restore 且校验 `ts > max(D)`）；`remove()` 保留为二者组合
的便利方法并注明「不可用于 UI 撤销窗口」。

### F3 — P1：`appendSummary` 的坏候选会覆盖好汇总

`services/timelineWriteStore.ets:348–356`：

```
348:  /** summary newer-wins：两边都有合法 generatedAt 时严格较新才覆盖。 */
349:  private isNewerSummary(candidate: string, existing: string): boolean {
350:    const next: number | null = this.summaryMillis(candidate);
351:    const old: number | null = this.summaryMillis(existing);
352:    if (next === null || old === null) {
353:      return true;
354:    }
355:    return next > old;
356:  }
```

`summaryMillis()`（`:358–372`）对坏 JSON / 缺 `generatedAt` / 非数字一律返回 `null`。
因此 `existing` 合法（`old=100`）而候选坏（`next=null`）时 `:352–353` 返回 `true`，
`appendSummary`（`:113–122`）随即 `atomicWriteIn(..., text)` 覆盖掉上次成功的汇总。
契约 §8:188 明确要求「生成失败 / 陈旧回复不得覆盖上一次成功汇总」；这里恰好反了。
`appendSummary` 也不校验 `text` 是否为合法 summary JSON，任何字符串都能落盘。
静态测试 32 只断言 `return next > old`（测试文件 `:386`），`null` 分支完全没测。
修复建议：`next === null → false`；`old === null && next !== null → true`；两者都 null 时
拒绝写入（`false`）。

### F4 — P2：tmp 文件名只含进程内序号，跨实例会碰撞

`:47–48` `private writeSeq: number = 0`，`:270–271`

```
270:    this.writeSeq += 1;
271:    const tmpPath: string = `${path}${TMP_INFIX}${this.writeSeq}`;
```

文件头 `:16–17` 坦承「ArkTS 没有 Node 的 process.pid，用序号同样保证同目录唯一」。
但两个 App 实例 / 两个 store 实例都从 `tmp-1` 开始，且 `writeTextSync` 以
`TRUNC`（`:295`）打开 tmp，会互相截断并 rename 对方的文件。契约 §9 把跨设备并发交给
后续同步协议模块，但这里是**同一目录内的本地碰撞**；应加随机后缀 / 时间戳或复用一个
进程级 UUID。

### F5 — P2：`assertWritable()` 与分支门禁不存在，写前不重查 schema

`isEnabled()`（`:64–66`）只是 `return timelineStore.useV2()`，而 `timelineStore` 的
`v2` 只在 `ensureReady()`（读服务 `timelineStore.ets:62–80`）时读一次 `schema.json`。
全仓 `.ets` 中 `grep assertWritable|E_BRANCH_MISMATCH` **零命中**。契约 §11:271–274 要求
每次写盘 / commit 前调用唯一门禁并断言当前分支与 upstream 均为 `main`；§9:200/203 要求
阶段 0 门禁与 push 被拒后重查；§9 P1-3(a):239 要求每条意图重放前重查门禁。本模块只查
开关缓存，不查分支、不重读标记。可归为后续同步协议模块职责，但文件头 `:6`
「落盘与门禁由 services/timelineWriteStore.ets 负责」的表述过强，建议改为「门禁的开关判定
在此，仓库级 `assertWritable()` 与分支断言由同步模块提供」。

### F6 — P2：取消完成未刷新 `opened_at`

`toTimelineRecord()`（`:176–215`）：

```
179:    const openedAt: string = typeof incomingOpened === 'string' && (incomingOpened as string).length > 0
180:      ? incomingOpened as string
181:      : (existing !== null ? existing.opened_at : record.ts);
...
205:    } else if (record.done) {
207:      out.closed_at = record.ts;
```

v1 `ScheduleRecord` 没有 `opened_at`，取消勾选时 `done=false` 且无传入 `closed_at`，
于是沿用 `existing.opened_at`（上一次会话的开始时间）且清掉 `closed_at`。契约 §6:123
要求「取消完成 = 重新打开一个新会话（**刷新 opened_at**、清 closed_at）」，否则
`closed_at - opened_at` 的完成耗时会把上一次会话时长算进来。建议 `done` 从 true→false
时把 `opened_at` 设为本次 `record.ts`。

### F7 — P2：账本整行去重 ≠ §7 的 `(id, ts, intentId)` 去重

`appendLedgerLine()`（`:252–264`）：

```
257:    for (let i = 0; i < oldLines.length; i += 1) {
258:      if (oldLines[i] === line) {
259:        return;
260:      }
261:    }
```

`model/timelineWrite.ts:148–162` 产出的账本行不含 `intentId`（§7:135 声明为可选，形状合规）。
但 §7:159 的并集去重键是 `(id, ts, intentId)`（restore 为 `(id, ts)`）；同 `(id,ts)` 而
`deletedAt` 不同的两行在本模块会被各写一份，只能靠后续 union 阶段去重。另外本模块的
「同内容不追加第二份」是进程内幂等，不是跨设备幂等（§9 P1-2）。需在同步模块明确接管，
或在账本行补 `intentId`。

### F8 — P2：写侧不校验 `ts` 形状 / 日期归属

`planUpsert()`（`:103–125`）只校验日期与 `record.id`（`:104–112`），其余交给
`buildRecordsText` 的自检；而 `parseTimelineDay` 的 `describeRecordProblem`
（`model/timeline.ts:287–289`）只要求 `ts` 是非空字符串。因此 `ts: 'garbage'`
会原样写进 `records.json`。契约 §3:77 / §4:104 要求 `ts` 为 ISO 8601 带本地偏移且前 10 位
为所在目录名。后续 §9 P1-3(b) 会报 `E_CORRUPT`，但本模块自称「自检保证绝不吐出解析不了
的文本」（`timelineWrite.ts:16–17`）——解析得了不等于契约合法。建议写侧加 `ts` 前缀与目录
一致性校验（与 `isCalendarDate` 同口径，纯算术、不引墙钟）。

---

## 2 Byte-shape proof（独立复现，不依赖测试 fixture）

我从 `docs/DATA-CONTRACT-v2.md` §3 的 ```json 代码块**直接抽取**两条示例记录及期望全文，
再调用编译后的 `buildRecordsText()` 对比字节，并回读 `parseTimelineDay()`：

| 项 | 结果 |
| --- | --- |
| 契约代码块字节数 / 产出字节数 | **638 / 638** |
| `Buffer.compare` | **0（逐字节相同）** |
| 契约 sha256 / 产出 sha256 | `8d5bba40ffc973d45197c72d9b3c413a200d4a8fbe0a77ab976d78096d40e3cd`（两者相同） |
| 末尾 8 字节 | `[125,10,32,32,93,10,125,10]` = `}` `\n` `  ` `]` `\n` `}` `\n`，**恰好一个尾换行** |
| 记录行数 / 缩进 / 逗号 | 2 行；均 `  {"id"...` 两空格缩进；第 1 行尾逗号、第 2 行无 |
| 记录行内空格 | 无（`JSON.stringify`，键序 `id,ts,title,body,author,done,media,ai_processed,opened_at`） |
| 顶层键序与形状 | `{` → `  "date": …,` → `  "open": ["m9x2k1-3fk"],` → `  "records": [` → 两行 → `  ]` → `}` → `\n` |
| `parseTimelineDay(text, DAY)` | `errors.length === 0`；`allRecords = [m9x2k1-3fk, n0y3l2-8ab]`；`open = [m9x2k1-3fk]` |

结论：**§3 形状完全一致，零漂移**；`canonicalRecordLine` 键序、无空格、未知字段尾随
（由 `timelineRead.test.mjs:08` 覆盖）均符合契约。`sortRecordsForWrite` 按 `Date.parse` 的
**时刻**比较、同刻按 id，`+08:00` 与 `Z` 同刻能正确并列（实测 `upsert` 后 id 顺序为
`a, m9x2k1-3fk`）。

---

## 3 Atomicity / 崩溃分析

| 路径 | 机制 | 判定 |
| --- | --- | --- |
| `records.json` | 同目录 `records.json.tmp-<序号>` → `renameSync` 覆盖（`:267–290`） | 成功路径原子；**失败路径 P0 丢原文件**（F1） |
| `deleted.jsonl` / `restore.jsonl` | `readText` → 整行去重 → `head+line+'\n'` → 原子写（`:252–264`） | 旧字节恒为新字节严格前缀，符合 §7 P2-3（其允许整文件原子替换）；进程内顺序写安全，**跨进程 read-modify-write 会丢行**（后续同步模块职责） |
| `summary.json` | 读旧 → newer-wins → 原子写（`:113–122`） | 成功路径原子；null 分支缺陷见 F3 |
| 错误时原文件不受损 | 「必须」 | **不满足**：F1 的回落先 `unlinkSync(path)` |
| 路径范围 | `timelineRoot()` `:139–145` + `timelineDayPath()`（模型 `:271–274`） | 全部落在 `git-repo/timeline/<date>/`，**无 `devices/`、无 `schedules/`**（静态测试 31 验证） |
| `AppStorage` | 服务仅经 `isEnabled()` 间接**读**开关 | **无写**（测试 28 验证） |
| 崩溃窗口（`remove()`） | 顺序为**账本先（`:96`）→ 记录行后（`:98`）** | 账本在、行还在 → `visibleRecords()` 按账本过滤 → 视为已删、不复活；重跑 `remove()` 幂等（行去重 + 同文本）。代码注释 `:83–84` 已明确记录，符合 §7:153。反向窗口（行已写、账本未写）在 `remove()` 中不存在 |
| 崩溃窗口（F1 触发时） | 回落删了原文件 | 账本可能在、正式文件消失 → `visibleOf()` 读到空日 → **全部记录看起来消失**；本地不可恢复（尚无同步模块可 pull） |

补充：`append()` 只写 `records.json`（`:79`），不存在两文件窗口；`restore()` 只写
`restore.jsonl`（`:109`），但缺少 §7:150 的「严格晚于 D」校验（F2）。

---

## 4 `mod-v2-dual-write-off` 仍需做什么（精确调用点）

当前模块**未接线**（全仓 `.ets` 中 `grep timelineWriteStore` 仅命中自身 `:27/:135/:380`，
模型 `.ts` 头部只有一处注释提及），以下为必须逐点改接的 v1 写入口：

1. **Bootstrap / 开关**：`pages/Index.ets:349–350`（现状只 `timelineStore.ensureReady`）需追加
   `timelineWriteStore.ensureReady(context)`；v2 标记确认后需显式翻转
   `timelineStore.setReadMode('v2')`（读服务 `timelineStore.ets:102–107`），否则 `useV2()` 永远
   为 false。切换后的 `v1ReadFallback` 只读兜底（§1/§13，硬截止 2026-12-31）及其删除路径也在此模块。
2. **保存 / 编辑 / 快捷记录**：`pages/Index.ets:544`、`:822`、`:1093`，
   `components/RecordEditorView.ets:663`，`components/RecordDetailView.ets:193`
   —— `scheduleStore.appendRecord(record)`（实现在 `services/scheduleStore.ets:308–326`）按
   `useV2()` 分流到 `timelineWriteStore.append(record, date)`。
3. **删除 / 撤销**：`pages/Index.ets:918`（`scheduleStore.appendRecord(tombstone)`，
    tombstone 由 `model/undoDelete.ts:106 softDeleteRecord` 生成）、`:950`
   （`:111 restoreRecord`）→ 必须改为 §7 的 `schedule`（5 秒 UI 倒计时）/ `cancel` / `confirm`
   三步；**现有 store API 不够用，先修 F2**。
4. **导入**：`services/exportService.ets:456 appendImportPlan` / `:479 applyImportPlanOnce`
   （经 `scheduleStore.dayFilePath()` 写入，见 `:452`）→ 改为 v2 upsert 批次，保留 dry-run /
   conflict / 不覆盖纪律（§11 表第 7 行）。
5. **汇总**：`services/summaryStore.ets:25 RepoSummaryIO`、`:44–54 writeText`、`:131`
   `writeDailySummary` → 改走 `timelineWriteStore.appendSummary`（先修 F3）。
6. **插件**：`packages/dsh-dots/src/schedule/bridge.ts:249 ScheduleBridge.add`
   （`:284 appendFile`、`:287 commitAll`、`:288 pushWithRebase`）及其余 `schedule_*` action
   （§11 表 5/6）；按 §9 删除 `pullRebase`，改 fetch + 语义并集 + outbox 重放。
7. **缺失基础设施（本模块未提供）**：`assertWritable()`（全仓不存在）、`main` 分支/upstream
   断言、仓库外 outbox（App `<filesDir>/sync-outbox.json`、插件 `%USERPROFILE%\.dsh\dots\outbox\<repoHash>.json`）、
   union/replay 两阶段周期、`conflicts.jsonl` 败者落盘与 `equalTsResolved` 日志（§4:99）、
   账本 `intentId`/`(id,ts)` 去重（F7）、媒体 `媒体待迁移` 占位（`mod-v2-media-migration`）。
   这些是后续同步协议模块职责，但 `mod-v2-dual-write-off` 的接线清单必须与它们同批闭合，
   否则会出现「v1 已停写、v2 语义未闭环」的中间态。

---

## 5 Test-quality assessment

**组成**：32 例中 26 例（01–26）是对真实编译产物的行为断言，6 例（27–32）是对 `.ets` 源码的
静态形状断言。`.ets` 不能在 Node 运行，静态断言是合理折中；模型层覆盖质量高：

- 真实契约检查：测试 01 与本文 §2 的独立抽取一致（638 字节 / 同一 sha256）；
  02 键序、03 零错误回读、04 一条一行 + 尾逗号 + 2 空格、05 单尾换行、06 空日、
  07/08 时刻排序与 id 次序、09–11 `closed_at` 谓词（含 `done=true` 仍 open）、
  12–17 upsert 替换任意 ts / remove 无墓碑、18–21 fail-closed、22–24 账本形状、
  25 确定性、26 无墙钟——均是**语义断言**而非文案匹配。
- 静态断言：`fs.renameSync`、`tmp-`、账本前缀、`useV2()`、无 `devices/` 等；测试 27 用
  `methodBody()` 取方法体并断言 `requireEnabled()` 为第一句，**已证明** disabled 时任何 I/O
  之前抛错（`append:70 / remove:87 / restore:103 / appendSummary:114`，与源码一致）。

**不足 / 缺失的规范性用例（点名）**：

1. `atomicWriteIn` **失败路径**：首选 rename 抛错后 tmp 是否还在、原文件是否仍在（F1）——
   测试 29 只匹配 `renameSync`/`mkdirSync` 字符串，无法发现。
2. `isNewerSummary` 的 **`null` 分支**：坏候选不得覆盖好汇总（F3）——测试 32 只验 `next > old`。
3. §7 P1-4 的 **`restore.ts > max(D)`** 与 schedule/cancel/confirm 三步 API（F2）——零用例。
4. 账本 **(id,ts,intentId)** 去重、同 `(id,ts)` 不同 `deletedAt` 的行为（F7）——只验整行相等。
5. `assertWritable()` / 分支门禁与写前重查（F5）——零用例（因函数本身不存在）。
6. 取消完成时 **`opened_at` 刷新**（F6）——零用例。
7. `ts` 形状 / 日期归属校验（F8）——零用例。
8. tmp 序号跨实例碰撞（F4）——零用例。
9. 测试 01 的期望文本是**手抄 fixture**（测试文件 `:76–88`），不是测试时从契约文档抽取；
   本次独立抽取证明 fixture 忠实，但契约日后变更不会被用例发现（fixture 漂移风险）。
   建议测试入口改为读 `docs/DATA-CONTRACT-v2.md` 的 ```json 块。

**既有测试是否被削弱**：**否**。评审执行时 `git status --short` 只有 3 个新文件 +
`docs/MODULES.md`；`git diff --stat` 仅 `docs/MODULES.md`（4+/1-，登记模块与基线 2485→2517）。
评审收尾时总设计师并发更新了 `docs/ROADMAP.md`（基线同步到 2517）与
`docs/DATA-CONTRACT-v2.md`（§11 末尾补一段实现说明）——都是文档，不是测试。
**没有任何既有测试文件被修改**，全量用例数恰好 +32，与新增用例数一致。

---

## 6 Gate tails（原始输出尾部，逐字引用）

工作目录 `C:\Users\GWL\Desktop\itwillclaude\dsh-sync-suite`。`EXITCODE=N` 是我包的
`$LASTEXITCODE` 回显行，不是命令输出。

**(1) `node apps/arkui-schedule/tools/overlay.mjs status`**

```
覆盖层：未应用（工作区为「共享源码 + 平台目录」的原始形态）
[overlay] applied=false
EXITCODE=0
```

**(2) `node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json`**

```
EXITCODE=0
```
（无输出；`tsc` 静默成功。）

**(3) `node --test apps/arkui-schedule/tools/test/timelineWrite.test.mjs`**

```
✔ 25 deterministic: same input twice gives identical bytes, no input mutation (0.2183ms)
✔ 26 neither new file reads a wall clock (no Date.now / bare new Date) (0.1246ms)
✔ 27 disabled guard: every write method starts with requireEnabled before any IO (0.3562ms)
✔ 28 isEnabled is gated solely by the shared flag (useV2), no AppStorage writes (0.1168ms)
✔ 29 records.json is atomically replaced with a same-directory tmp + rename (0.0625ms)
✔ 30 ledgers are append-only: read old bytes, keep them as prefix, atomic write (0.0829ms)
✔ 31 service reuses the pure read/write model and never touches v1 paths (0.1653ms)
✔ 32 summary.json uses newer generatedAt wins, equal keeps existing bytes (0.1446ms)
ℹ tests 32
ℹ suites 0
ℹ pass 32
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 101.5082
EXITCODE=0
```

**(4) `node --test "packages/dsh-dots/test/*.test.mjs" "apps/arkui-schedule/tools/test/*.test.mjs"`**

```
✔ P1-1 lsRemote 超时 → E_GIT（消息说明超时），网络命令有 ≤8s 上限 (425.4214ms)
✔ ① 旧目录含完整条目 → 新目录全部存在且字节一致，标记文件存在 (39.0575ms)
✔ ② 新目录已存在 → 不覆盖原内容，旧目录不动，写跳过标记 (10.2509ms)
✔ ③ 无旧目录 → no-op，且不创建标记 (3.1471ms)
✔ ④ 重复调用幂等：第二次不重复搬动、不覆盖用户后续修改 (11.2962ms)
✔ ⑤ 标记在但目标不全（上次中断）→ 从旧目录补齐并校验，旧数据不丢 (28.9294ms)
✔ ⑥ 无完成标记但有 pending 标记 + 目标已建且只搬了一半 → 补齐而不是永久 skip（评审 M1） (30.8231ms)
✔ ⑦ 补齐时目标已有同名条目 → 不覆盖用户数据，也不因旧目录残留而永久失败（评审 M3） (12.0241ms)
ℹ tests 2517
ℹ suites 312
ℹ pass 2516
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 27823.9025
EXITCODE=0
```
完全符合预期 **2517 / 2516 pass / 0 fail / 1 skip**（基线 2485 + 32）。

**(5) `node apps/arkui-schedule/tools/validate-app.mjs`**

```
🔍 校验 ArkUI-X 工程：C:\Users\GWL\Desktop\itwillclaude\dsh-sync-suite\apps\arkui-schedule
✅ 全部通过：8/8 条规则（JSON5/JSON 70 个、相对 import 369 条、main 静态 import 471 条、页面 7 个、rawfile/git 2 个文件）
EXITCODE=0
```

---

## 7 `unverified`

- 真机 / 第二设备 / PC 上的一切行为：无 DevEco / SDK、`hdc list targets` 为空；
  尤其 **HarmonyOS 的 `renameSync` 覆盖已存在目标是否成功**（F1 的触发条件）无法验证。
- `.ets` 服务层的实际运行：只能静态扫描；F1/F2/F3 的运行时后果均为源码推演，未在设备上复现。
- 跨 App 实例 / 跨设备并发写同一 `timeline/<date>/` 的收敛（§9 union → replay）——
  同步协议模块尚未实现，契约 §15 相关项仍 `unverified`。
- `assertWritable()`、分支断言、outbox 重试 / 幂等、`conflicts.jsonl` 审计、5 秒撤销 UI、
  `媒体待迁移` 占位——均为后续模块职责，本评审未验证其实现。
- 本模块可被 `git revert` 干净回滚的**运行时**证据（未接线、默认 v1）来自源码与 grep，
  未经设备验证；但全量门闸与 overlay 状态已实测。

---

## 复审（2026-11-20，P0/P1 修复）

> 独立只读复审：重读 `model/timelineWrite.ts`(264 行)、`services/timelineWriteStore.ets`(583 行)、
> `tools/test/timelineWrite.test.mjs`(551 行 / 45 例)，并核对读侧 `model/timeline.ts` 的
> `deletionState` / `visibleRecords`。未改任何源码。证据等级同上：模型层跑真实编译产物，`.ets` 仅静态断言 + 源码推演。

| 项 | 判定 | 证据（原文 / 行为） |
| --- | --- | --- |
| **P0** 回落丢原文件 | **CLOSED** | `atomicWriteIn` `:392–393` 写 tmp→`verifyTmp`（`:434–444` 长度+内容逐字回读，不符抛 `E_ATOMIC_WRITE` 并留现场）；`:396–398` 首选 `fs.renameSync(tmpPath,path)` 成功即 return；catch `:403–411` `if(fileExists(path))`→`fs.renameSync(path,backupPath)`（**改名、非 unlink**）；`:412–425` tmp→path 失败则 `fs.renameSync(backupPath,path)` 还原后抛类型化错误；`:427–429` `if(hadOriginal) cleanupTemp(backupPath)` **仅在成功后**删备份。全方法无 `unlinkSync(path)`（测试 39 断言）。`recoverTemps` `:525–538` 仅当目标缺失才 `renameSync(sidePath,targetPath)` 并 `console.warn` 报告；目标存在时只删**内容相同**的陈旧 tmp，`.bak` 一律保留并告警——恢复缺失目标、绝不静默删除。`cleanupTemp` 仅作用于 tmp/bak 侧文件。任一时点两版本各至少一份落盘。 |
| **P1a** 撤销三步 API | **PARTIAL** | `scheduleDelete` `:108–117` 仅 `appendLedgerLine(DELETED…)`，无 `planRemove/RECORDS_FILE_NAME`；`restore` `:124–151` 读 `deleted.jsonl` 求该 id 最大删除 ts，`candidate<=latestDeleteMillis`→`throw 'restore 时间必须晚于删除'`，仅追加 `restore.jsonl`，无 `atomicWriteIn`；`purgeRows` `:157–177` 有 `planRemove`+`atomicWriteIn(RECORDS…)` 且 `!present` 幂等返回；`remove` `:179–188` `@deprecated` 仅委托 `scheduleDelete`，**不物理清行**；四入口均 `requireTs`。**但** `purgeRows` 用 `this.visibleOf(date)`（`:240–249`→`visibleRecords`）作基线，schedule 写入 D 后该 id 被 `deletionState`（timeline.ts `:720–746`）判 deleted 而过滤→`present=false`，confirm 步**永不物理清行**（新发现 N1）。无内部路径在账本 durable 前自动 purge；`purgeRows` 自身亦无账本前置校验。 |
| **P1b** 坏候选覆盖好汇总 | **CLOSED** | 纯模型 `isNewerSummaryText(oldText,nextText)` `:103–113`：next=null→false；old=null→true；否则 `next>old`。valid>valid 严格较新 / valid>corrupt→true / corrupt>valid→false / 相等→false / 双坏→false，五例全覆盖；`appendSummary` `:191–200` `if(!isNewerSummaryText(existing,text)) return;` 后才写盘。测试 33–35 逐例断言。 |
| **P2** tmp 跨实例唯一 | **CLOSED** | `:68` `instanceTag=Math.random().toString(36).slice(2,10)`；`:447–450` `uniqueSuffix()`=`tag-Date.now()-writeSeq`，两实例标签不同、序号单调。测试 40。 |
| **P2** 三入口 ts 形状 | **CLOSED（限范围）** | `requireTs` `:218–222` 用 `isValidTsShape`（模型 `:69–74`：ISO 到秒 + `Date.parse`），失败抛 `TS_SHAPE_ERROR='E_TS_SHAPE: …'`；scheduleDelete/restore/purgeRows/remove 四入口均调用（测试 36/44）。残留：**`append`/`planUpsert` 未用 `isValidTsShape`**，`describeRecordProblem` 仍只要求 ts 非空（timeline.ts `:287–289`）→ N2。 |
| **P2** 重开刷新 opened_at | **CLOSED** | `wasClosedAndNowOpen` `:178–199` 取该 id 最新旧版本判关闭态；`planUpsert` `:213–214` `reopened ? {...record,opened_at:record.ts} : record`，复制入参不改调用方对象。测试 37（含不入参改写）/38（历史关闭行不误判）。 |
| **P2** 账本 (id,ts) 去重 | **CLOSED** | `appendLedgerLine` `:341–357` 取 `ledgerKey(line)`=`id\u0000ts`，逐行 `old===line` 兜底 + `ledgerKey(old)===key`；`ledgerKey` `:359–376` 仅接受 id/ts 均 string 的 JSON，坏行返回 null 不影响整行兜底。测试 30。（§7:159 原键含 intentId、模型仍不产出；brief 已按 (id,ts) 收敛，不另计。） |

### 新发现

- **N1（P1）**：`purgeRows` 以账本过滤后的 `visibleOf` 为基线，实际 schedule→confirm 链路中该行已被 D 过滤，`!present` 提前返回——confirm 步**永不物理清行**，§7 P1-4 第三步空转，删除行永久滞留在 `records.json`；反向地，未 schedule 而直接调 `purgeRows` 会物理删掉仍可见且无账本记录的行（本地不可恢复、远端不可见）。测试 42 只断 `planRemove`/`RECORDS_FILE_NAME`/`!present`，未断基线来源，故漏检。建议改用 raw `parseTimelineDay(...).day.allRecords` 作基线，并在无 delete 账本行时拒绝 purge。
- **N2（P2，F8 残留）**：`append`/`planUpsert` 写侧仍无 ts 形状校验，畸形 ts 可经主写路径落盘。
- **无 P0 回归**：字节形状（测试 01 的 638 字节 fixture 未变）、数据字节无墙钟（`Date.now` 仅在 `uniqueSuffix` 命名，测试 26）、无 `devices/` 写（测试 31）、无 AppStorage 写（测试 28；grep 仅命中服务自身注释）、无 UI 接线（`grep timelineWriteStore` 仅命中服务自身 `:17/:213/:583`）均保持。

### Gate tails（逐字，尾部）

```
(1) node --test .../timelineWrite.test.mjs
✔ 45 header assigns assertWritable and the sync cycle to mod-v2-sync-protocol (0.049ms)
ℹ tests 45 / ℹ pass 45 / ℹ fail 0 / ℹ skipped 0 / ℹ duration_ms 108.7002 / EXITCODE=0
(2) node --test "packages/dsh-dots/test/*.test.mjs" "apps/arkui-schedule/tools/test/*.test.mjs"
✔ ⑦ 补齐时目标已有同名条目 → 不覆盖用户数据，也不因旧目录残留而永久失败（评审 M3） (14.6245ms)
ℹ tests 2530 / ℹ pass 2529 / ℹ fail 0 / ℹ skipped 1 / ℹ duration_ms 27265.8468 / EXITCODE=0
(3) node .../tsc -p apps/arkui-schedule/tools/tsconfig.json → （无输出） EXITCODE=0
(4) node apps/arkui-schedule/tools/validate-app.mjs
✅ 全部通过：8/8 条规则（JSON5/JSON 70 个、相对 import 369 条、main 静态 import 471 条、页面 7 个、rawfile/git 2 个文件） / EXITCODE=0
```

**总判定**：P0 / P1b / 五项 P2 均闭合；P1a **PARTIAL**（N1 为 P1，需在接线前修 confirm 步）。模块仍默认 v1、未接线，故对当前状态不阻塞；但 v2 删除链路启用前 N1 必须先修。N2 为 P2 残留。
