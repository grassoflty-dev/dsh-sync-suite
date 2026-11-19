# 独立只读评审 — mod-v2-sync-protocol（§9/§11 同步协议核心）

> 评审对象：`apps/arkui-schedule/entry/src/main/ets/model/syncProtocol.ts`（实测 **706 行**，索引登记 612）、
> `services/syncProtocolStore.ets`（实测 **529 行**，索引登记 447）、
> `tools/test/syncProtocol.test.mjs`（实测 **581 行 / 56 例**）。
> 只读：未改任何代码、测试或仓库状态；门闸产物 `tools/.build/model/*.js` 由 `tsc` 重新生成。
> 工作目录：`C:\Users\GWL\Desktop\itwillclaude\dsh-sync-suite`；HEAD `ee8348b`，分支 `main`。
> 依据：`项目理解.md`、`docs/DATA-CONTRACT-v2.md` §4/§7/§9/§11、`docs/MODULES.md`，并交叉核对
> `model/timeline.ts`、`model/timelineWrite.ts`、`services/timelineWriteStore.ets`、`tools/migrate-v1-to-v2.mjs`。

---

## 0. 结论

| 级别 | 数量 | 概要 |
| --- | --- | --- |
| **P0** | **0** | 未发现 force-push、历史改写、门禁前写盘、远端文件删除或数据丢失路径；门禁/字节/确定性三条硬核已实测通过。 |
| **P1** | **3** | F1 门禁置于 fetch 之后 → 远端一旦前进即 `E_NOT_SYNCED`，远端变更永远无法并入；F2 远端 / 已落盘账本从不参与并集 → 远端删除可被忽略、旧 upsert 可把已删行写回；F3 被丢弃意图永不出队且无 `droppedDeleted` 上报。 |
| **P2** | **6** | F4 第二套原子写实现且 upsert 绕过 `planUpsert` 规范化；F5 `now` 兜底破坏不可解析 ts 的确定性；F6 typed 码缺失/改名；F7 文档行数与周期顺序不一致；F8 空 line 意图的账本事实不落盘；F9 delete 的 intentId 判重在正常路径失效。 |

**Verdict：可原样提交（unwired 安全），但在修复 F1–F3 之前**不可接线**，对 `mod-v2-dual-write-off` 构成 blocking。**
理由：三个新增文件全部未跟踪（`git status` 仅 3 个 `??`），`isEnabled()` 默认跟随 `timelineStore.useV2()`（默认 `'v1'`），
全仓无任何调用点（grep `syncProtocolStore` 只命中自身），不写 `AppStorage`、不写 `devices/**`、零运行时影响（测试 47/53 静态佐证）。
门禁前已实测同步周期三条禁令全部成立，提交本身不会引入运行风险；但 F1–F3 让"跨设备收敛"这一模块目的不可达，
接线后即变成可观察的功能缺陷，故必须在下一个模块接线前修复。

最重要的发现（F1+F2）：**该周期把 `assertWritable()` 放在 `git fetch` 之后，一旦另一设备推送过，
`HEAD ≠ origin/main` 直接返回 `E_NOT_SYNCED`，fetch 下来的远端事实一条都用不上；即使越过门禁，
`unionDay()` 的签名里根本没有账本文本参数，服务也只 `git show` 了 `schema.json` 和 `records.json`，
从不 union 远端的 `deleted.jsonl` / `restore.jsonl` / `conflicts.jsonl`。两条缺陷各自独立地使 §15 的核心场景
「两设备同日各建记录」「A 删除 + B 并发编辑」无法收敛，而当前 56 个用例没有一个覆盖这两条。**

---

## 1. Findings（file:line + 原文引用）

### F1【P1 / blocking-for-wiring】门禁在 fetch 之后，远端一前进就拒绝同步

- `syncProtocolStore.ets:100-104`：
  ```
  // 步骤 1：git fetch origin main（绝不 pull --rebase / git merge）。
  await git(['fetch', 'origin', 'main']);
  // 步骤 2–6：读文本 → 门禁 → union → 落盘 → commit。
  let prepared: PrepareResult = await this.prepare(git, outbox, now);
  ```
- `syncProtocolStore.ets:185-193`：
  ```
  const gate = assertWritable({
    schemaVersion: marker.ok ? marker.version : null,
    branch: (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim(),
    headSha: (await git(['rev-parse', 'HEAD'])).trim(),
    originMainSha: (await git(['rev-parse', 'origin/main'])).trim()
  });
  if (!gate.ok) {
    return { gate: gate, ... };
  }
  ```
- 契约 `DATA-CONTRACT-v2.md:200-203` 的阶段表明确是 **阶段 0 门禁（HEAD == origin/main）→ 阶段 1 fetch**；
  union 比较的是 "HEAD 版与 FETCH_HEAD 版"。本实现 fetch 在前，使门禁比较的 `origin/main` 已被 fetch 推进，
  于是"远端领先"与"本地 ahead"被混为一谈。后果：另一设备推送后，本设备每次 `runCycle()` 都在
  `E_NOT_SYNCED`（`message='本地 HEAD 与 origin/main 不一致，请先同步'`）处零写入返回，
  union / commit / push / reset 重试路径全部到不了——用户被要求"先同步"，而同步正是失败的动作。
  这是可观察的死锁，不是静默数据损坏，故定 P1 而非 P0。

### F2【P1 / blocking-for-wiring】账本事实不进并集：远端删除可被忽略，已删行可被写回

- `syncProtocol.ts:410-416` 的签名没有 `deletedText` / `restoredText` / `conflictsText`：
  ```
  export function unionDay(date, remoteText, localText, entries, now): DayUnion
  ```
- 账本只从本周期 outbox 意图拼出（`syncProtocol.ts:478-496`）：
  ```
  // 阶段二前置：先聚合全部 delete / restore 账本，避免意图顺序影响删除胜裁决。
  const replay = replayable(entries);
  ...
  if (entry.op === 'restore') { restores.push(ledger); } else { deletions.push(ledger); }
  ```
- 服务只读远端 `schema.json` 与 `records.json`（`:180`、`:202` 两处 `remoteText(git, ...)`），
  `deletedText` / `restoredText` 仅来自本地工作副本（`:204-205`）且只喂给 `isApplied()`（`:208`），
  **从不进入 `unionDay()`**；`git show origin/main:timeline/<date>/deleted.jsonl` 全仓不存在。
- 用编译产物实测（临时脚本，非仓库文件）：把已落盘的删除账本 `deleted.jsonl` 与一个陈旧 upsert 交给
  `unionDay`，并另外调用 `isApplied(upsert, dayText, deletedText, '')`：
  ```
  dropped: [] applied: ["stale-up"]
  record still in output text: true
  isApplied(upsert, ledger present): true
  ```
  即 §9 P1-3(c)「先删后重放旧 upsert → 丢弃并计入 droppedDeleted」对**已落盘**账本失效：
  旧行被 `buildRecordsText` 写回 `records.json`（虽然读侧 `visibleRecords` 仍过滤），
  且 `open` 由 `closed_at` 派生、不看账本（`timelineWrite.ts:150`），可能把已删 id 重新写进 `open` 并 push。
- 直接违反契约 §9 阶段 1「并集 `deleted/restore/conflicts.jsonl`」与 §7「并集合并」；
  §15 的「A 删除 + B 并发编辑」明确标为必须双端验证的场景。定 P1。

### F3【P1 / blocking-for-wiring】dropped 意图永不出队、无上报，4 次后错报 `E_PUSH_REJECTED`

- `syncProtocolStore.ets:198,213-215,269` 收集并返回 `droppedIds`：
  ```
  for (const id of union.dropped) { droppedIds.push(id); }
  ```
- 但 `runCycle` 成功出队只传 `appliedIds`（`:118`）：
  ```
  const done = outboxAfterReplay(outbox, prepared.appliedIds, [], now);
  ```
  `prepared.droppedIds` 在 `runCycle` 内**零引用**；`CycleResult`（`:48-58`）也没有 `dropped` 字段，
  `gateFailure`/耗尽分支同样不带。后果：按 §9 P1-3(c) 应"丢弃并出队、显示'该记录已被删除，编辑未同步'"
  的 upsert 滞留在 outbox，每次 cycle 被 `bumpAttempts` +1（`:298-308`），4 次后 `state='failed'`，
  UI 报 `E_PUSH_REJECTED: 推送被拒`——既不是契约要求的 droppedDeleted 文案，又违反 no-silent-failure。

### F4【P2】第二套原子写 + upsert 规范化绕过（caveat ii 的具体化）

- 服务自带 `appendDedupLines`（`:435-458`）与 `atomicReplaceText`（`:461-471`，tmp + 回读 + rename），
  与 `timelineWriteStore` 的 `atomicWriteIn` / `appendLedgerLine`（`timelineWriteStore.ets:106,121,155,205`）
  构成**两套**原子写/追加实现，日后任一侧修 bug 必漂移。
- 更实质的差异：正常路径 `unionDay` 直接 `canonicalRecordLine(record)` 后 `merged.set`（`syncProtocol.ts:515,528`），
  **绕过** `planUpsert` 的 `isValidTsShape` 校验与"重新打开刷新 `opened_at`"规范化
  （`timelineWrite.ts:213-218`）；拒推路径 `reapplyIntents` 却走 `timelineWriteStore.append`（`:279-295`）。
  同一意图在"首次推送成功"与"推送被拒后重放"两条路径产出**不同字节**， Determinism 承诺被路径选择破坏。
  定 P2（当前未接线、触发需拒推），但接线前应统一到单一写入口。

### F5【P2】`now` 兜底破坏不可解析 ts 的确定性（caveat iii）

- `syncProtocol.ts:246-253`：
  ```
  function decidedAtOf(ts: string, now: Date): string {
    const ms = Date.parse(ts);
    if (!Number.isNaN(ms)) { return new Date(ms).toISOString(); }
    return now.toISOString();
  }
  ```
  `now` 由服务 `new Date()` 注入（`:97`），并用于 `outboxAfterReplay` 补空 `enqueuedAt`（`:700`）。
  正常路径（ISO ts）确定性成立；仅当 ts 不可解析时 decidedAt 随墙钟变化，双端冲突文件字节不一致。
  且与迁移工具 `isoFromTs`（`migrate-v1-to-v2.mjs:151-154`）的兜底口径不同——后者返回原始 ts 串或
  `1970-01-01T00:00:00.000Z`。契约 §15 要求 ts 为 ISO 形状，畸形 ts 属损坏输入，故定 P2。
  建议：不可解析 ts 直接 typed `E_CORRUPT` 而非兜底。

### F6【P2】typed 码与契约不一致

- `syncProtocol.ts:36` 定义 `E_NOT_SYNCED`，契约 §9/§11 期望本地 ahead 为 `E_LOCAL_PENDING`、
  缺标记 + `devices/` 为 `E_MIGRATION_REQUIRED`。`assertWritable`（`:65-71`）把 `schemaVersion !== 2`
  一律映射 `E_SCHEMA_UNKNOWN`，模型无 `devices/` 上下文，`E_MIGRATION_REQUIRED` 永不产生；
  远端日文件不可解析也不产 `E_CORRUPT`（`:354-365` 静默返回空 Map）。
   §9 状态表要求的 typed 集合出现改名/缺项，定 P2。

### F7【P2】索引与契约文档的登记不准

- `docs/MODULES.md:36` 登记 `syncProtocol.ts`（612 行）、`syncProtocolStore.ets`（447 行），
  实测为 706 / 529 行（LF 计数复核）；`docs/DATA-CONTRACT-v2.md:249` 新增段落把周期写成
  "fetch → 读远端与本地 → unionDay → 原子写 → commit → push"，未标出门禁位置，与契约阶段表
  "阶段 0 门禁 → 阶段 1 fetch" 不一致，且恰好掩盖 F1。回滚哈希栏仍为"（Lead 填）"（可接受）。

### F8【P2】空 line 意图的账本事实计算了但不落盘

- `syncProtocol.ts:325-337` 的 `ledgerLineOf()` 明确支持空 payload 时按 `(id,ts)` 合成账本行；
  但服务写盘只写 `entry.line.length > 0 ? [entry.line] : []`（`:242`、`:248`）。
  空 line 的 delete/restore 在 `unionDay` 内参与裁决并被标记 applied，却不会写进
  `deleted.jsonl` / `restore.jsonl`，出队后本地与远端账本均缺该事实。

### F9【P2】delete 的 intentId 判重在正常路径失效

- `syncProtocol.ts:648-651` 支持按 `intentId` 判重；但 `ledgerDeleteLine`（`timelineWrite.ts:288-293`）
  产出的行只有 `{id,ts,deletedAt}`，不含 `intentId`。测试 39 手工构造带 intentId 的行才通过。
  生产路径只能靠 `(id,ts)` 兜底，内容判重的第二道防线名存实亡。

---

## 2. 四条门禁消息（verbatim，实测）

`syncProtocol.ts:52-57` 的 `WRITE_GATE_MESSAGES`；以编译产物直接调用 `assertWritable()` 复现
（含优先级组合 `schemaVersion=3, branch='dev', headSha='x'`）：

| code | message（逐字） | 触发条件 | 优先级 |
| --- | --- | --- | --- |
| `ok` | `可写` | schema=2 且 branch=main 且 headSha === originMainSha | — |
| `E_SCHEMA_UNKNOWN` | `只读（仓库结构版本不认识，见 §11）` | `schemaVersion !== 2`（含 null / 99） | 1（最高） |
| `E_BRANCH_MISMATCH` | `分支不是 main，拒绝写入` | schema 通过但 `branch !== 'main'` | 2 |
| `E_NOT_SYNCED` | `本地 HEAD 与 origin/main 不一致，请先同步` | 前两项通过但 `headSha !== originMainSha` | 3 |

实测输出（6 组，含 null/99/dev/ahead/all-bad）：
```
ok => {"ok":true,"code":"ok","message":"可写"}
null-schema => {"ok":false,"code":"E_SCHEMA_UNKNOWN","message":"只读（仓库结构版本不认识，见 §11）"}
v99 => {"ok":false,"code":"E_SCHEMA_UNKNOWN","message":"只读（仓库结构版本不认识，见 §11）"}
branch-dev => {"ok":false,"code":"E_BRANCH_MISMATCH","message":"分支不是 main，拒绝写入"}
ahead => {"ok":false,"code":"E_NOT_SYNCED","message":"本地 HEAD 与 origin/main 不一致，请先同步"}
priority-all-bad => {"ok":false,"code":"E_SCHEMA_UNKNOWN","message":"只读（仓库结构版本不认识，见 §11）"}
```
**失败零写入**：`assertWritable` 是纯函数（`:63-73` 只 return）；服务 `prepare()` 的步骤 1/2
只有 `git show` / `ls-tree` / 本地读（`:179-190`），门禁失败在 `:191-193` 立即返回，
`runCycle` 走 `gateFailure`（`:515-521`）只构造结果对象，随后不执行 `:221/226/241/247` 的任何写、
不执行 `:114-117` 的 `writeOutbox` / `push`。测试 54 以源码序断言 `atomicAt > gateAt`、`commitAt > atomicAt`。

---

## 3. 周期 trace 与三条禁令核验

### 3.1 周期逐步（服务原文行号）

| 步 | 位置 | 动作 | 写句柄？ |
| --- | --- | --- | --- |
| 1 | `:101` | `git(['fetch','origin','main'])` | 否 |
| 2 | `:180-181,202-205` | `git show` 远端 schema/records + `ls-tree` 列日 + 本地 records/账本读 | 否 |
| 3 | `:185-193` | `assertWritable(...)`；失败立即 typed 返回 | 否 |
| 4 | `:201-209` | 逐日 `unionDay(date, remoteText, localText, dayEntries, now)` | 否 |
| 5 | `:218-256` | `atomicReplaceText(records.json)` + `appendDedupLines(conflicts/deleted/restore)` | **是（门禁后）** |
| 6 | `:259-267` | `git add -- <changedPaths>` → `git commit -m '[v2] sync <n> days'` | git 写 |
| 7 | `:110-124` | `bumpAttempts` → `writeOutbox`（仓库外）→ `git push origin main` | git 写 |
| 拒推 | `:125-137` | `git reset --hard origin/main` → `reapplyIntents` → 回步骤 3 | 否（唯一 reset） |
| 耗尽 | `:140-151` | `failed` 终态留 outbox，返回 `E_PUSH_REJECTED` | 仅 outbox |

顺序与题目 (b) 一致；**但 F1 指出步骤 3 在步骤 1 之后，与契约阶段表相反**。

### 3.2 三条禁令（全量 grep 证据）

服务内全部 git 命令字面量（`:101,117,127,187,188,189,266,365,375`）：
```
fetch origin main
push origin main
reset --hard origin/main
rev-parse --abbrev-ref HEAD
rev-parse HEAD
rev-parse origin/main
commit -m ...
show <spec>
ls-tree -r --name-only origin/main -- timeline
```
（`add -- ...` 由 `addArgs` 动态拼装，`:261-265`。）

1. **无 force-push**：`grep` 全服务仅 `:117` 一次 push，无 `--force` / `-f` / `--force-with-lease` /
   `+refspec`（静态测试 48 断言 `doesNotMatch push[^\n]*--force`、`push[^\n]*\+-`、`'--force'`）。
   **Verified**。
2. **无历史改写**：无 `merge` / `pull --rebase` / `rebase` / `amend` / `clean`（静态测试 49）；
   `reset --hard` 全文件仅 `:127` 一次且位于 `catch (error)` 内，测试 50 断言 `occurrences.length === 1`
   且 `resetAt > catchAt`、`pushAt < resetAt`，`body.slice(0, catchAt)` 无 `reset`。**Verified**。
3. **无远端文件删除**：fs 调用只有 `readTextSync` / `writeTextSync` / `renameSync` / `mkdirSync` / `accessSync`
   （`:317,332,333,336,466,467,470,478,490,495`）；无 `unlinkSync` / `rmSync` / `deleteFile`。
   `purge` 只从 `records.json` 移除记录行（§7 confirm 意图允许），不删文件。**Verified**。
4. 门禁前零写入见 §2；outbox 在 `<filesDir>/sync-outbox.json`（`:69-71,346-348`），
   在 `git-repo/` 之外，tmp 写 + 回读 + rename（`:328-337`），与契约 §9 本地 outbox 表一致。**Verified**。
5. `intentId` 幂等：`isApplied` 四 op（`:610-681`）+ `makeIntentId`（`:261-264`）+ `markAttempt`（`:267-274`）
   + `MAX_ATTEMPTS=4`（`:92`）+ 拒推重放累计（`:110-147`）已实现；但 F3（dropped 不出队）与
   F9（intentId 判重失效）是局部缺口，见 §1。

---

## 4. conflicts.jsonl 与确定性证明（Check 3）

### 4.1 行形状与迁移工具逐字段一致

| 字段 | 本模块 `syncProtocol.ts:293-297` | 迁移工具 `migrate-v1-to-v2.mjs:407-413` | 一致 |
| --- | --- | --- | --- |
| 键序 | `JSON.stringify({id,ts,losingLine,decidedAt,dedupeKey})` | 对象字面量同序，经 `jsonl()` 的 `JSON.stringify` | ✅ |
| `losingLine` | 败者 `canonicalRecordLine` | `loser.line = canonicalRecordLine(rec)`（`:369`） | ✅ |
| `decidedAt` | `decidedAtOf(ts, now)`，可解析时 `new Date(ms).toISOString()` | `isoFromTs(ts)`，可解析时同（`:151-154`） | ✅（正常路径） |
| `dedupeKey` | `sha256Hex(losingLine)` | `lineSha256(line)` = `createHash('sha256').update(line,'utf8').digest('hex')`（`:124-126`） | ✅ |

实测键序输出：`conflictKeys: id,ts,losingLine,decidedAt,dedupeKey`；
`dedupeKey==sha256(losingLine): true`；`decidedAt: 2026-11-19T01:30:00.000Z`（由输入 `09:30+08:00` 派生，无墙钟）。

### 4.2 纯 SHA-256 对拍 Node `crypto`

`sha256Hex`（`:154-221`）为纯 TS 实现（含代理对 / 孤立代理的 UTF-8 编码 `:100-129`）。
对拍 7 组输入（空串、ASCII、中文、emoji 代理对、孤立代理、300 字节多块、规范 JSON 行）全部 `OK`：
```
OK ""                    e3b0c44298fc1c14
OK "abc"                 ba7816bf8f01cfea
OK "中文测试"            e350545d18735c5d
OK "😀 emoji"            c5db20e64d86b693
OK "\ud800 lone"         b98e34b15c5918c3
OK "x"x300               0d4e2ca9e9cbced7
OK canonical-line        d6b464381178a760
```

### 4.3 确定性 / 顺序无关

- 胜者：`unionDay` 的 `byteCompare(lineB, lineA) > 0 → winner=b`（`:459-465`）与迁移工具
  `pickWinner` 的 `Buffer.compare(Buffer.from(entry.line,'utf8'), Buffer.from(best.line,'utf8')) > 0`
  （`:345-352`）同为 **UTF-8 字节较大者胜**；不同 ts 走 later-ts-wins（`:447-455` / `:339-343`）。
- 败者只落同 ts 字节裁决（`:467-470`）：`if (loser !== null && delta === 0) addConflict(...)`，
  符合 §4「不同 ts 静默折叠」。
- 去重：`seenConflict` 按 `(id,ts,dedupeKey)`（`:421-432`）；服务追加再按 `conflictKey`（`:418-432,435-458`）
  做一次 `(id,ts,dedupeKey)` 去重，保证旧字节是新字节严格前缀。
- 排序：`conflictRows.sort` 按 `(ts,id,dedupeKey)`（`:569-584`），与输入顺序无关。
- 实测 `unionDay(remote,local)` 与 `unionDay(local,remote)`：
  ```
  order-indep text: true conflicts: true
  ```
  测试 25/32/33 分别覆盖顺序无关、去重、同输入逐字节一致。**Verified**（纯逻辑层）。

---

## 5. Executor 自陈 caveat 裁决

| # | caveat | 裁决 | 理由 |
| --- | --- | --- | --- |
| (i) | `unionDay` 无账本文本参数，从意图 payload 推事实——远端删除会不会被忽略？ | **P1（非 sound）** | F2：签名 `:410-416` 无账本参数，服务只 `git show` schema/records（`:180,202`），从不 union 远端账本；实测已落盘删除对陈旧 upsert 不触发 dropped，旧行被写回。**远端删除确实可被忽略**。 |
| (ii) | 服务自己写全量 `records.json`，未复用 `timelineWriteStore` | **P2（重复实现，附带 P2 语义漂移）** | F4：两套 tmp+rename/append 实现；正常路径 upsert 绕过 `planUpsert` 的 ts 校验与 reopened_at 刷新，拒推路径却复用服务，同一意图两路径字节可不同。未接线、需拒推才触发，故 P2；接线前应收敛为单一写入口。 |
| (iii) | `now` 作不可解析 ts 的兜底 | **P2** | F5：正常路径 decidedAt 由输入 ts 派生、确定性成立；仅畸形 ts 走 `now.toISOString()`（`:252`），双端字节可不一致且与迁移工具 `isoFromTs` 兜底口径不同。契约要求 ts 为 ISO 形状，损坏输入应 typed 失败。 |

---

## 6. 测试质量（Check 6）

**是否有真实契约断言？** 是。56 例非形状占位：测试 1–7 覆盖门禁四结果/优先级/中文文案；11 做纯 SHA-256 与 Node crypto 对拍；
18/23/25/32/33 覆盖冲突行形状、UTF-8 字节胜者、顺序无关、去重、确定性；22/24/26 覆盖 later-ts-wins、同字节折叠、
open 从 closed_at 派生；27–34 覆盖五种意图与并集解析自检；35–45 覆盖 isApplied 四 op 与出队/失败留存；
46–56 为静态契约（无墙钟/无 SDK、禁力推/禁 merge/单次 reset、outbox 位置与原子写、门禁先于写、7 步编号、复用模型）。
服务层因 `@kit.*` 不可在 Node 导入，采用源码形状断言（与既有 v2 模块同口径），这是合理折中但无法验证运行时行为。

**既有测试是否被削弱？** 否。`git status --short` 显示仅 3 个 `??` 新增文件 + 3 个 `M` 文档；
无任何既有测试文件被改。全量从基线 2536 增至 2592，增量恰为 **+56**（新文件用例数），与
`docs/MODULES.md:90` / `docs/ROADMAP.md` 的登记吻合。**rest of suite byte-identical**。

**缺失的规范性用例（按优先级）**：
1. **（对应 F1）远端领先场景**：先让 origin/main 多一笔提交，再 `runCycle`，断言仍进入 union 而非 `E_NOT_SYNCED`；§15「两设备同日各建记录 → 双方两条、逐字节一致」无任何用例。
2. **（对应 F2）远端/已落盘账本并集**：远端 `deleted.jsonl` 有 D、本地无，重放旧 upsert → 断言 `dropped` 含该 intentId、`visibleRecords` 空、`droppedDeleted` 计数可见；当前只有"同周期 outbox 内删除胜"（测试 29）。
3. **（对应 F3）dropped 出队与上报**：断言 dropped id 从 outbox 移除且 `CycleResult.dropped > 0`，文案「该记录已被删除，编辑未同步」。
4. `E_CORRUPT` 路径：不可解析远端日文件 / `records.json.date ≠ 目录名` → typed 错误且该日文件字节不变（§9 阶段 1 失败处理、§15）。
5. `E_MIGRATION_REQUIRED`：缺标记 + `devices/` 存在 → typed 错误（§11 四种组合）。
6. 拒推重放的**行为**测试（注入 GitRunner 抛错一次）：断言 reset 后重新 union、意图 reapply、4 次上限与 manual 重试归零；目前只有静态位置断言（测试 50）。
7. `conflicts.jsonl` 追加前缀不变量的服务层断言（旧字节为新字节严格前缀）；`summary.json` newer-wins 与 `media/` sha16 并集的周期用例（§9 阶段 1 明列，本模块完全未实现）。
8. 每条意图重放前**重新** `assertWritable()`（§9 P1-3(a)）：当前只在 `prepare` 开头查一次，无用例。

---

## 7. `mod-v2-dual-write-off` 尚需的精确清单 + 未接线提交安全性

### 7.1 接线下余工作（据 `docs/MODULES.md:36,114`、`docs/ROADMAP.md:595`、契约 §11/§13）
1. **修 F1–F3**（门禁顺序、账本并集、dropped 出队）——否则接线即死锁/漏删/错报。
2. **接线 `runCycle`**：提供具体 `GitRunner` 绑定（本模块只接受注入，没有实现），在同步触发点调用；注入 `ability` 以定 `filesDir`。
3. **实现 outbox 入队 API**：模块只定义 `OutboxEntry` 形状与 `makeIntentId`，没有公开 enqueue；调用方需产出含 `line`（账本行/规范行）的意图，否则触发 F8。
4. **翻转 `timeline.readMode='v2'`** 并保留 `v1ReadFallback` flag（硬截止 **2026-12-31**），到期删除 flag 与全部 v1 读路径。
5. **重定向全部 v1 写调用点**：`pages/Index.ets:544/822/918/950/1093`、`components/RecordEditorView.ets:663`、`components/RecordDetailView.ets:193`、`services/exportService.ets:456`、`services/summaryStore.ets`（RepoSummaryIO 写入）、`model/undoDelete.ts` `schedule()`、插件 `packages/dsh-dots` `bridge.ts` `ScheduleBridge.add` 及其余 `schedule_*`；删除 `pullRebase`。
6. **三态/状态 UI**（§9）：`已同步 / 同步中 / N 条待同步（最近失败：<typed>） / 只读 / 离线`，以及用户点「重试」时原子 `attempts=0, state=pending`（模块没有该入口，需上层实现）。
7. **补齐 `summary.json` / `media/` 的周期并集**（§9 阶段 1）或明确推迟到后续模块并在契约登记。
8. **登记与回滚**：`docs/MODULES.md` §1 回填 Lead 提交哈希、§2 新增 `Index.ets` 等共享文件触碰、§5 批次行；`docs/DATA-CONTRACT-v2.md` §13 状态同步；按依赖图右→左回滚（先 dual-write-off 再 read/write service）。
9. **真机 + 第二设备验证**（§15，当前全部 `unverified`）。

### 7.2 未接线提交安全性
**安全**。证据：`git status` 三个新文件均 `??`；`isEnabled()` = `timelineStore.useV2()`（`:85-88`）默认 `'v1'`；
全仓 grep `syncProtocolStore` 仅命中自身三处（import ×2 + 单例导出 `:529`），无任何页面/服务引用；
`:12` 明言"不翻转开关、不接 UI、不写 AppStorage、不写 v1 路径"；静态测试 47/53 断言未启用先抛错、
无 devices/ 与 AppStorage 写。回滚 = 提交后 `git revert <hash>` 或提交前删除三个文件，零运行时影响。
注意：F1–F3 是"接线 blocking"而非"提交 blocking"，评审不阻止 Lead 以 inert 状态落库，
但**必须**在 `mod-v2-dual-write-off` 的验收门里逐条关闭。

---

## 8. 门闸原始输出尾部（5 条，全部复现于 HEAD `ee8348b`）

| # | 命令 | 结果 | 期望 | 判定 |
| --- | --- | --- | --- | --- |
| 1 | `node apps/arkui-schedule/tools/overlay.mjs status` | `覆盖层：未应用（工作区为「共享源码 + 平台目录」的原始形态）` / `[overlay] applied=false` | `applied=false` | ✅ |
| 2 | `node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json` | 无 stdout/stderr；`TSC_EXIT=0` | exit 0 | ✅ |
| 3 | `node --test apps/arkui-schedule/tools/test/syncProtocol.test.mjs` | `ℹ tests 56` / `ℹ pass 56` / `ℹ fail 0` / `ℹ skipped 0` | 56/56 | ✅ |
| 4 | `node --test "packages/dsh-dots/test/*.test.mjs" "apps/arkui-schedule/tools/test/*.test.mjs"` | `ℹ tests 2592` / `ℹ suites 312` / `ℹ pass 2591` / `ℹ fail 0` / `ℹ skipped 1` | 2592/2591/0/1 | ✅ |
| 5 | `node apps/arkui-schedule/tools/validate-app.mjs` | `✅ 全部通过：8/8 条规则（JSON5/JSON 70 个、相对 import 376 条、main 静态 import 482 条、页面 7 个、rawfile/git 2 个文件）`；`VALIDATE_EXIT=0` | 8/8 | ✅ |

关键尾部逐字：
```
[overlay] applied=false
TSC_EXIT=0
ℹ tests 56 / ℹ pass 56 / ℹ fail 0 / ℹ skipped 0
ℹ tests 2592 / ℹ suites 312 / ℹ pass 2591 / ℹ fail 0 / ℹ skipped 1 / ℹ duration_ms 27289.1799
✅ 全部通过：8/8 条规则（JSON5/JSON 70 个、相对 import 376 条、main 静态 import 482 条、页面 7 个、rawfile/git 2 个文件）
```
全量用例尾部还显示最后一组为媒体迁移模块用例（⑦「补齐时目标已有同名条目…」），
说明新测试未影响既有文件执行。

---

## 9. `unverified`（无第二设备 / PC）

- **无第二设备 / PC、无真机**：`hdc list targets` 为空、无 DevEco/SDK（沿用 `项目理解.md` §4 状态）。
  契约 §15 全部双端场景未验证：两设备同日各建记录、同 id 不同 ts、同 id 同 ts 不同内容（P0-1 双端）、
  A 删除 + B 并发编辑、删除撤销、媒体链路、完成时间统计、拉取策略、outbox 重试/幂等/重放、迁移回滚。
- 本评审的周期 trace、禁令、门禁零写入、SHA/conflicts/确定性结论均为**源码静态 + Node 纯逻辑 / 源码形状**证据；
  `services/syncProtocolStore.ets` 因 `@kit.*` 依赖**未在运行时执行**，`GitRunner` 真实 git 绑定、fetch/push/reset
  的实际时序与冲突拒绝行为均 `unverified`。
- 服务层 56 例中 47–56 为静态形状断言，不能替代集成测试；F1/F2/F3 的运行时后果由静态代码 + 纯模型实测推断，
  尚未在真实双端 git 并发下复现（但逻辑链完整、证据充分）。
- 文档行数差异（F7）不影响门闸，仅登记准确性问题。

---

**评审结论再述**：P0 0 / P1 3 / P2 6；**提交 unwired 安全，接线 blocking**。
先关闭 F1（门禁移到 fetch 前并区分"本地 ahead"与"远端领先"）、F2（真正 union 远端与本地账本、
把账本文本传进 `unionDay` 或在其内部读）、F3（dropped 出队 + droppedDeleted 上报），再进入
`mod-v2-dual-write-off`；F4–F9 可在该模块接线同一批内处理。

## 复审（2026-11-20，F1–F3 修复）

> 对象：`syncProtocol.ts`(886)、`syncProtocolStore.ets`(641)、`syncProtocol.test.mjs`(813 行 / 71 例)；HEAD `ee8348b`，三源文件仍 `??`（未接线）。只读复审；先 tsc 重生成 `.build` 再跑用例。

- **F1 CLOSED**。`headRelation()`（`syncProtocol.ts:76-91`）先判 `headSha===originMainSha→'equal'`，否则
  `headIsAncestorOfOrigin→'behind'`、`originIsAncestorOfHead→'ahead'`，全 false→`diverged`；
  `assertWritable():98-109` 仅 `ahead|diverged→E_NOT_SYNCED`，`isFastForwardable():112-114` 仅 behind 为真。
  服务 `headFacts():218-241` 用 `git merge-base HEAD origin/main` 的 `base===headSha` / `base===originMainSha`
  注入两布尔量。`prepare():267` 首门禁 → `:274-283` 唯一 `git(['merge','--ff-only','origin/main'])`
  （仅 behind；catch → `FF_DIVERGED_MESSAGE='本地与 origin/main 已分叉，请先手工处理'`，`:96`，零写入）
  → `:286-290` 复检 schema+分支门禁，二者均在 `:324` 首次原子写之前。
  测试 57/58/59/60（四关系、behind 放行且可 ff、ahead/diverged 拒绝+分叉文案）、49
  （`ffAt>gateAt && ffAt<unionAt<atomicAt`；唯一 merge 字面量）、54（门禁 2 次、`atomicAt>gateAt`）证明祖先计算与顺序。
- **F2 CLOSED**。`unionDay(date, remote:DayTexts, local:DayTexts, entries, now)`（`:570-576`，
  `DayTexts={records,deleted,restore}` `:466-470`）；`:638-663` 先
  `unionLedgerText(local.deleted, ledgerLines(remote.deleted)+intentDeleteLines,true)`（restore 去重 withIntent=false），
  再据并集后账本算 `deletions/restores`，删除裁决 `:685` 在其后。
  测试 61 实证远端 `deleted.jsonl`（含 intentId）+陈旧本地 upsert → `dropped` 含该 id、`applied` 不含、
  `added=0`、`allRecords=[]`、`isApplied=false`；62 远端 restore(ts>D) → 不 dropped、可见；
  63 两侧账本去重且本地原文为严格前缀；64 顺序无关。
  服务 `:301-305` 真 `git show origin/main:timeline/<date>/deleted.jsonl|restore.jsonl`（`remoteText():474-481`），
  `:315` 传入 union；写回 `:345-361` 先 `startsWith(local)` 守卫（否则 `E_LEDGER_APPEND`）后
  `atomicReplaceText`（tmp+回读+rename `:573-583`）；远端 conflicts 一并追加去重 `:331-344`。测试 70 静态锁定。
- **F3 CLOSED**。`CycleResult.dropped:string[]`（`:62`）；`dequeueDropped()`（`:133-147`）在推送循环与
  `bumpAttempts()`（`:154`）**之前**出队并累计 `droppedReported`，`:179` 重备后再出队；
  `outboxAfterReplay():874-883` 对 applied/dropped 均出队、仅 failed `markAttempt`，
  故 dropped 不 bump、不会 4 次后误报 `E_PUSH_REJECTED`；成功 `:159-165`、耗尽 `:188-195`
  均回 `dropped:droppedReported`。测试 68/69/55 证明（含 `dequeueAt<bumpAt`）。
- **F4/F5/F9 CLOSED**。F4：`normalizeForWrite()`（`:307-329`，`isValidTsShape`+`planUpsert`）为 upsert
  唯一规范化入口（`:690`），拒推重放 `:389-407` 仍走 `timelineWriteStore.append`；测试 65 字节一致+
  `opened_at` 刷新、69/56 复用。F5：`decidedAtOf(ts,_now)`（`:294-300`）不可解析时 `return ts`
  （无 `now.toISOString()`），意图 `:679-683/:691-694` 计入 `tsShapeDropped`+`dropped`，
  `E_TS_SHAPE`（`:139`）、`DayUnion.tsShapeDropped`（`:487`）；测试 66/71/46。
  F9：`intentLedgerLine()`（`:532-543`）加 `intentId`，`ledgerKey()`（`:493-503`）delete 按
  `(id,ts,intentId)`、restore 按 `(id,ts)` 去重，`isApplied():821-824` 可按 intentId 判重；测试 67/63/61。
- **无新增缺陷**。一次 push（`:157`，无 `--force`）、唯一 merge=`--ff-only`（`:276`）、唯一 `reset --hard`
  在 catch（`:169`）、无 rebase/amend/clean（测试 48/49/50 + grep）；门禁/ff/复检均在首次原子写前（49/54）；
  outbox `<filesDir>/sync-outbox.json`（`:458-460`）与 tmp+回读+rename（`:440-449`）未变（51/52）；
  无 `devices/`/`AppStorage`/`unlinkSync/rmSync`（53 + grep）；三源文件仍 `??`、无调用点，未接线零影响。
- **新发现：无**（未新增 P0/P1/P2）。遗留（非本次引入、非接线阻断）：原 F6 typed 码
  `E_LOCAL_PENDING/E_MIGRATION_REQUIRED/E_CORRUPT` 仍缺、F7 文档行数登记仍旧；服务仍自带
  `atomicReplaceText/appendDedupLines`（`:546-583`，原 caveat ii 上半，不在本次"字节一致"范围）；
  §15 双端真机场景仍未验证。严重度：信息级。

### 门闸尾部（本轮实测，HEAD `ee8348b`）
```
TSC_EXIT=0 / VALIDATE_EXIT=0
✅ 全部通过：8/8 条规则（JSON5/JSON 70 个、相对 import 376 条、main 静态 import 482 条、页面 7 个、rawfile/git 2 个文件）
ℹ tests 71 / ℹ pass 71 / ℹ fail 0 / ℹ skipped 0 / ℹ duration_ms 126.4458
ℹ tests 2607 / ℹ suites 312 / ℹ pass 2606 / ℹ fail 0 / ℹ skipped 1 / ℹ duration_ms 27163.3428
```

**裁决**：F1–F3（接线 blocking）与 F4/F5/F9 全部 CLOSED、无新增缺陷 → 该模块**可安全接线**到
`mod-v2-dual-write-off`（前提：该模块补 GitRunner 绑定 / outbox 入队 API / 三态 UI；F6/F7 与 §15 双端验证按既有清单跟踪）。
