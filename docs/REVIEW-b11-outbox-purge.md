# 独立只读评审 — batch b11：`mod-plugin-outbox-purge-failed`（仓库外 outbox 陈旧失败意图清理）

- 评审对象：`main` @ `0eef9662dd94a242f2c514da95ccb0b18285acf4`，工作树中未提交的一条车道（src + 新测试 + 重新生成的 dist）
- 评审方式：只读 + 自跑门禁 + 自写内联只读探针；**不运行** `node scripts/build.mjs`，不写 `src/**` / `test/**` / `dist/**`，不执行任何 git 写命令，不联网，不用 `hdc`，不打印任何 token
- 允许写入的唯一仓库文件：本文件；所有探针输出只落 gitignored `.tmp/gates-rvop-*.out`（另有一条误写提示未产生文件，见 §4）
- 立场：**攻击声明本身**，(a)–(h) 八条探针逐条给结论；对真实碎片只读解析 `state` / `attempts` / `enqueuedAt` / `intentId`，`lastError` / URL / `commitSha` 从未打印

---

## 0 结论

- **P0 = 0，P1 = 0，P2 = 4**。裁决：**Freeze-with-fixes（可冻结，但禁止在结案文案里说"碎片今晚已清理"）**。
- 一句话裁决：**核心机制成立**——谓词严格 `>`、7 天阈值只做维护不参与同步判定、唯一出队路径复用 `dequeueIntents`、日志模板只拼计数与天数、清理发生在 CycleResult 形成之后且被 try/catch 隔离；四个问题分别是「负数 enqueuedAt 未 fail-closed」「精确边界没有被测试钉住」「P8 标题比断言强」和**最要紧的一条：真实三条碎片的年龄只有 5.44–5.56 天，在 2026-11-28 的下一次周期里根本不会被清理**。
- 冻结前提：§3 的 P2-1 ~ P2-4 处理完；其中 **P2-4 是给结案报告用的硬约束**，不是可选文案润色。

| # | 级别 | 一句话 | 位置 |
| --- | --- | --- | --- |
| P2-1 | P2 | 负数 `enqueuedAt`（数值与数字串）被当成极旧时间而**清理**，与"年龄不明 fail-closed"的承诺冲突；P5 未覆盖 | `packages/dsh-dots/src/sync/cycle.ts:409-421,430-436`、`:125-138` |
| P2-2 | P2 | 测试 P1 用 `阈值−60s`、P4 用 `阈值+60s`，**恰好 7 天**（`now−enqueuedAt === maxAgeMs`）这一条一个用例都没有；谓词本身正确，但边界不可回归 | `packages/dsh-dots/test/outbox-purge-failed.test.mjs:26-28,85-93,115-123` |
| P2-3 | P2 | P8 标题写「result 的任何字段都不因清理而改变」，断言只覆盖 `ok` / `failed` / `outbox.length` / `outbox[0].intentId`；机制正确，测试没证明标题 | `packages/dsh-dots/test/outbox-purge-failed.test.mjs:182-205` |
| P2-4 | P2 | 真实三条碎片 `enqueuedAt` 在 2026-11-22 19:12–22:03，今天（2026-11-28 08:37+08）只有 5.44–5.56 天，**在窗口内**；下一次周期 `selectPurgeableIntents()` 返回 `[]`，最早 2026-11-29 19:12+08 才第一条可清 | `packages/dsh-dots/src/sync/cycle.ts:86,427-437`、真实 outbox 文件 |

---

## 1 范围与证据

### 1.1 实际读过的文件

- Scope（全 3 路径）：`packages/dsh-dots/src/sync/cycle.ts`（1–1650 全文）、`packages/dsh-dots/test/outbox-purge-failed.test.mjs`（P1–P8 全文）、`packages/dsh-dots/dist/sync/cycle.js`（增量 + `git diff` hunk 表 + 大小/哈希）。
- 装配与旁证（只读）：`packages/dsh-dots/src/sync/bootstrap.ts:140-209`（`now` / `logger` 的真实注入）、`packages/dsh-dots/src/timeline/records.ts:163`（`tsMillis`）、`docs/REVIEW-b11-ff-vp.md`（文风）、`docs/REVIEW-b11-marksynced.md:233`（1110/1108/0/2 基线）。
- 真实碎片：`~\.dsh\dots\outbox\83b24a6a05769119.json`，只读解析 3 条的安全字段。
- `docs/MODULES.md` 的未提交 diff 属于其他车道（7.6/7.7 记账），**没有任何本模块条目**；本评审未改它。

### 1.2 门禁复跑（全部 `Tee-Object` 到仓库根 `.tmp/gates-rvop-*.out`）

| # | 命令（工作目录） | 结果 / tail | 留存 |
| --- | --- | --- | --- |
| G1 | `node ../../node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | **exit 0**，零诊断（首轮路径写错，重跑后 `FINAL_EXIT=0`） | `.tmp/gates-rvop-tsc.out`，19 B |
| G2 | `node --test 'test/*.test.mjs'` | `tests 1118 / suites 0 / pass 1116 / fail 0 / skipped 2 / duration_ms 89643.6844`，`SUITE_EXIT=0` | `.tmp/gates-rvop-suite.out`，149,806 B |
| G3 | 内存新鲜 emit（TS `transpileModule`，ES2022/ESNext/esModuleInterop，78 个 `.ts`） | `DIST-FRESHNESS-MINE: tsFiles=78 match=78 mismatch=0 missing=0` | `.tmp/gates-rvop-distcheck.out` |
| G4 | 内联谓词/年龄探针（只读 import `dist/sync/cycle.js`） | 精确阈值 `false`、阈值+1ms `true`；负数 enqueuedAt `true`；真实碎片 `SELECT_NOW []` | `.tmp/gates-rvop-probe.out`、`gates-rvop-probe2.out` |

- 车道留存核验：`packages/dsh-dots/.tmp/gates-op-build.out` 109 B = `BUILD_EXIT=0`；`gates-op-suite-1.out` / `-suite-2.out` 两份解码后均 `tests 1118 / pass 1116 / fail 0 / skipped 2`（这两份文件是 UTF-16LE，前面混了 5 字节 UTF-8 BOM+CRLF，按偏移 5 解码才读得到正文）；`gates-op-distcheck.out` 245 B = `DIST-FRESHNESS: 78 files, 0 mismatch` + `DIST-WINDOW: 1 dist/*.js differ from HEAD` + `modified dist/sync/cycle.js 72001 B`；`packages/dsh-dots/.tmp/gates-op-tsc.out` 96 B 只有车道自己补写的 `TSC_NOEMIT_EXIT=0 (tsc --noEmit emits nothing on success; exit code recorded here per Rule 10)`。**按指派要求把那行补写的退出码当证据，并如实说明：tsc 成功时本来零输出，文件里不是编译器原文；本评审 G1 独立重跑同样 exit 0。**
- 计数口径：基线 `1110 / 1108 / 0 / 2`（`docs/REVIEW-b11-marksynced.md:233`）→ 现在 `1118 / 1116 / 0 / 2`，**+8 tests / +8 pass**；8 条全部来自新文件 P1–P8，`packages/dsh-dots/test/**` 无任何既有文件被修改（status 只有新文件 `??`），所以"全部 8 条新增"成立。

### 1.3 起始/结束哈希、改动面、dist 结论

- 分支/HEAD 起止相同：`main` / `0eef9662dd94a242f2c514da95ccb0b18285acf4`；评审中未执行任何 git 写命令。
- `git status --porcelain -- packages/dsh-dots` 恰好三条：`M dist/sync/cycle.js`、`M src/sync/cycle.ts`、`?? test/outbox-purge-failed.test.mjs`。仓库里另有 `apps/arkui-schedule/**`、`docs/MODULES.md` 等并发车道改动，**与本模块零交集**，不计入本模块改动面。
- 指定三份 dist 的 `git hash-object` vs `git rev-parse HEAD:`：

| 文件 | 工作树 | HEAD | 结论 |
| --- | --- | --- | --- |
| `dist/sync/cycle.js` | `1633dc2f…` | `4446ce1c…` | 不同（预期），72,001 B，与声明一致 |
| `dist/sync/gitPort.js` | `e2910b35…` | `e2910b35…` | 逐字节相同 |
| `dist/sync/syncGate.js` | `8a501d0d…` | `8a501d0d…` | 逐字节相同 |
| `dist/sync/bootstrap.js` | `884f9ec3…` | `884f9ec3…` | 逐字节相同 |

- dist 新鲜度：车道 78/78、本评审 G3 独立 78/78，0 mismatch；window 只有 `dist/sync/cycle.js`，与 src 增量相符。

---

## 2 探针 (a)–(h) 逐条结论

### (a) 谓词紧度 — **1 条 P2（P2-1），其余 no finding**

1. `src/sync/cycle.ts:427-437`：`if (entry.state !== 'failed') return false` → 只碰 failed 终态；`if (!Number.isFinite(nowMs) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) return false` → `now` 为 `NaN` / `undefined` / `Infinity` 或 `maxAgeMs` 非法都 false（探针四项全 `false`）；`if (!Number.isFinite(at)) return false`；最后 `return nowMs - at > maxAgeMs`，**严格 `>`**。
2. 探针实测：恰好 7 天 `false`、`+1ms` `true`、`−1ms` `false`；缺失 / `NaN` / `Infinity` `false`；未来 `enqueuedAt` `false`；pending `false`。`now` 为 `undefined` 显式传入也 `false`（修正了首轮探针箭头函数默认参数造成的伪 `true`，见 `.tmp/gates-rvop-probe2.out`）。
3. **P2-1**：`enqueuedAtMs()`（`:409-421`）只过滤"非有限"，不过滤"非正"：`enqueuedAt: -1` → `true`，`enqueuedAt: '-1000'` → `true`（`tsMillis('-1000') = -30610253143000`，仍是有限值）。它们被当成 1970 年前/公元前的"极旧意图"清理，正好违背 `:433-434` 注释"年龄不明宁可永久留着"。真实碎片不受影响，故不升级。建议加 `if (!Number.isFinite(at) || at <= 0) return false`（或要求合理时间区间）并补一条测试。

### (b) 无第二条移除路径 / 既有语义未动 — **no finding**

1. `git diff HEAD -- packages/dsh-dots/src/sync/cycle.ts` 只有三个 hunk：`@@ -77,6 +77,14 @@`（在 `MAX_ATTEMPTS = 4` **之后**插入 `PURGE_FAILED_AFTER_MS`，`MAX_ATTEMPTS` 上下文本身无 `+`/`-`）、`@@ -396,6 +406,85 @@`（在 `dequeueIntents` 的 `return entries.filter((item) => !done.has(item.intentId))` **之后**插入新块）、`@@ -1258,11 +1347,29 @@`（把原 `runV2Cycle` 改名为 `runV2CycleCore` 并在其前新增外壳）。没有任何 hunk 触及 `replayable`（`:381-385`）、`markAttempt`（`:387-391`）、`retryIntent`（`:398-401`）——三者逐字未动。
2. 新增块里唯一的集合收窄是 `selectPurgeableIntents` 的 `entries.filter(...).map(intentId)`（`:440-445`），**只产出 id**；真正的删除只有 `dequeueIntents(entries, ids)`（`:482-483`）。全文件 `dequeueIntents` 调用点仍是原有三处 + 新增一处（`:1122,1575,1633,483`），没有手写 `splice` / `delete` / 第二套 filter-delete。`dist` 增量 hunk 也只有 `@@ -41`、`@@ -200`、`@@ -983` 三处，新增导出对应 src，无隐藏删除逻辑。

### (c) 结果不可变 — **机制 no finding；测试覆盖 1 条 P2（P2-3）**

1. 装配点唯一：`src/sync/cycle.ts:1355-1366` 新外壳 `const result = await runV2CycleCore(options)`；核心周期在 `:1635-1639` 已经把 `CycleResult` 完整构造好并返回；外壳只在 `result.ok` 为真时调用 `purgeStaleFailedIntents(options.outbox, options.now.getTime(), PURGE_FAILED_AFTER_MS, options.logger)`，然后 `return result`——清理结果只通过 `outbox.save()` 落到磁盘，**从不回写 result**。整个调用被 `try/catch` 包住（`:1358-1363`），outbox/日志异常不会把成功周期翻成失败。
2. 因此 `ok` / `code` / `message` / `days` / `applied` / `dropped` / `failed` / `pending` / `attempts` / `conflicts` / `writtenPaths` / `outbox` 全部由 core 冻结后原样返回；P8 实测 `result.failed===1`、`result.outbox.length===1`、`outbox.entries===[]`、日志一行，证明"磁盘清了、结果没清"确实发生。
3. **P2-3**：P8 标题声称"result 的任何字段都不因清理而改变"，但断言只钉 `ok` / `failed` / `outbox.length` / `outbox[0].intentId`（`:196-200`），没有逐个钉 `code` / `attempts` / `pending` / `writtenPaths` / `applied` 等。机制由 (1) 证明，测试本身只支持标题的一部分；建议把标题收敛为"磁盘已清且 `result.failed/outbox` 不变"，或补一条全字段快照断言。

### (d) 日志脱敏 — **no finding**

1. 模板只有一处：`src/sync/cycle.ts:457-459`，`` `outbox: 已清理 ${count} 条陈旧失败意图（>${Math.round(maxAgeMs / 86400000)} 天）` ``；机械上只插值 `count` 与 `Math.round(maxAgeMs / 86400000)`，没有 `lastError` / `commitSha` / `line` / `intentId` / `id` / URL / token 任何字段。
2. `emitOutboxPurgeLog`（`:461-469`）只把这一条字符串传给 `logger.info(line)` 或 `logger.warn(line)`，**不传第二个参数**；`purgeStaleFailedIntents`（`:475-486`）只在 `ids.length > 0` 时调用，传的是 `ids.length` 这个数字。`grep` 全文件无 `console.*` / `stdout` 写出；`grep logger` 命中只在新增块与 `CycleOptions`。
3. 周边风险检查：核心周期那些**会**带 `intentId` / `sha` / 原始错误文本的文案（`:961-963`、`:1059-1062`、`:1617-1619`）都是既有 typed 错误路径，不经过 `OutboxPurgeLogger`，也不拼进这条日志；P6 用带 URL/token/mojibake/旧 sha 的碎片实测两遍，日志恰一行且等于字面量 `'outbox: 已清理 3 条陈旧失败意图（>7 天）'`。
4. 附注（不计 finding）：`bootstrap.ts:190-192` 构造 `CycleOptions` 时**没有**传 `logger`，所以生产运行时这条计数日志实际静默；这是"不可观测"而非"泄漏"，且 bootstrap 不在本模块改动面内。

### (e) 年龄基准 / 真实碎片 — **1 条 P2（P2-4）；下面是结案要用的确切答案**

1. 年龄源就是 `enqueuedAt`（`src/sync/cycle.ts:432` 经 `enqueuedAtMs` 解析），完全不读 `lastError` / `commitSha` / `attempts`；阈值常量 `:86` = `7 * 24 * 3600 * 1000 = 604800000` ms。
2. 真实三条（`~\.dsh\dots\outbox\83b24a6a05769119.json`，均为 `state=failed`、`attempts=4`）：

| # | enqueuedAt (+08:00) | 到 2026-11-28 08:37:27 +08 的年龄 | 首次可清理时刻 (+08) | 今天可清? |
| --- | --- | --- | --- | --- |
| 1 | 2026-11-22 19:12:50 | 5.559 天（133.410 h） | 2026-11-29 19:12:50 | 否 |
| 2 | 2026-11-22 19:15:20 | 5.557 天（133.369 h） | 2026-11-29 19:15:20 | 否 |
| 3 | 2026-11-22 22:03:23 | 5.440 天（130.568 h） | 2026-11-29 22:03:23 | 否 |

3. **明确答案：不会。** 三条碎片今天都在 7 天窗口**内**（还差约 1.44–1.56 天）；探针把真实文件直接喂给 `selectPurgeableIntents(arr, NOW)` 得到 `[]`，`isPurgeableFailedIntent` 三条全 `false`。下一次周期不会清理任何一条，也不会打那条计数日志（`:481` ids 为 0 → 零落盘零日志）。生产 `now` 还是 `bootstrap.ts:156,191` 在运行时构造时冻结的 `new Date()`，只会更早、更不可能越过阈值。
4. **P2-4**：模块目的陈述（"三条死意图……永久……加一个 purge"）容易被读成"今晚解决"；实际是 2026-11-29 晚才生效的**定时维护**。结案报告必须写"机制已上线、碎片尚未清理、最早 11-29 19:12+08 起随首个成功周期逐条清理"，不得写"已清除/已排空"。

### (f) 测试 P1–P8 — **1 条 P2（P2-2）；另 P8 的断言缺口见 P2-3**

| 用例 | 声称 | 实际断言 | 裁定 |
| --- | --- | --- | --- |
| P1 `:85-93` | failed 且严格超过阈值 | `ids=['i-dead']`、谓词 true、entries 空、save 1 次 | 真覆盖（`阈值−60s`） |
| P2 `:95-103` | pending 永不清理 | ids 空、谓词 false、entries 原样、save 0 | 真覆盖 |
| P3 `:105-113` | syncing 不清理 | 同上 | 真覆盖 |
| P4 `:115-123` | failed 但在窗口内 | 用 `阈值+60s`（`FRESH_MS`）→ 不清理 | **近边界，不是恰好边界**（P2-2） |
| P5 `:125-138` | 缺失/非法/非有限 fail-closed | `undefined` / `'not-a-date'` / `NaN` / `null` 四例 | 真覆盖但**漏负数**（P2-1） |
| P6 `:140-160` | 日志一行、只含数量 | 字面量相等 + `http`/`://`/`token`/完整密串/旧 sha 全 false | 真覆盖 |
| P7 `:162-178` | 走 dequeueIntents、幸存者保序 | `['i-old1','i-old2','i-old3']` → `[pending,syncing,fresh]`，并与 `dequeueIntents` 结果 deepEqual | 真覆盖**顺序** |
| P8 `:182-205` | 成功周期后清理、result 全字段不变 | `ok`/`failed`/`outbox` 子集 + 磁盘清空 + 一行日志 | 标题强于断言（P2-3），机制本身由 (c) 证明 |

- 没有"只写标题不写断言"的用例：8 条都有可执行 `assert`；问题是**边界粒度**（P2-2）、**fail-closed 输入面**（P2-1）和**标题口径**（P2-3）。

### (g) 改动面 — **no finding**

- `git status --porcelain -- packages/dsh-dots` 恰好 `M src/sync/cycle.ts`、`M dist/sync/cycle.js`、`?? test/outbox-purge-failed.test.mjs` 三条，与声明完全一致；其他 19 条已跟踪改动 + 8 条未跟踪文件都在 `apps/arkui-schedule/**` 与 `docs/**`，属并发车道。
- `dist/sync/{gitPort,syncGate}.js` 与 `dist/sync/bootstrap.js` 的 git blob 哈希与 `0eef966` 完全相同（§1.3 表），未被本模块或并发车道改写；dist window 只有 `cycle.js` 一个文件、72,001 B。

### (h) 诚实性 — **no finding（模块自身），但结案口径有 P2-4 约束**

- 对 `docs/**` 与两个 scope 文件 grep `今晚` / `tonight` / `retroactive` / `追溯` / `已清理` / `碎片`：命中全部属于其他模块或历史评审；**没有任何本模块文档/注释声称碎片今晚已消失，也没有任何"追溯清理既有失败意图"的表述**。
- 本模块自己的注释是准确的：`:80-86` 说"只用于仓库外 outbox 维护、不参与同步判定"、`:423-425` 说"只读取年龄"、`:471-474` 与 `:1350-1354` 说"成功周期之后、结果不回写、异常吞掉"；测试头 `:1-7` 也只讲规则，不讲战果。
- 唯一需要防的是**下游文案**：见 P2-4。`docs/MODULES.md` 目前没有本模块的 7.x 登记行（其他车道有），这不是撒谎，但冻结时应补一行"机制上线、碎片未清、11-29 起生效"以免后续 session 误读（记为观察，不计 finding）。

---

## 3 发现清单

| 级别 | 位置 | 证据 | 影响 | 建议 |
| --- | --- | --- | --- | --- |
| P2-1 | `packages/dsh-dots/src/sync/cycle.ts:409-421,430-436`；测试 `:125-138` | `.tmp/gates-rvop-probe.out`：`negative number enqueuedAt true`、`negative ms numeric string true`；`tsMillis('-1000')=-30610253143000` | 畸形负时间戳被当成极旧而删除，与"年龄不明 fail-closed"承诺相悖；真实碎片不受影响 | `enqueuedAtMs` 或谓词加 `at <= 0` 拒绝；P5 增加 `-1` / `'-1000'` / 过期公元年份三例 |
| P2-2 | `packages/dsh-dots/test/outbox-purge-failed.test.mjs:26-28,85-93,115-123` | 只有 `OLD_MS = NOW−阈值−60s` 与 `FRESH_MS = NOW−阈值+60s`；探针 `exact 7d false` 证明谓词对但无人钉住 | 将来把 `>` 误改成 `>=` 时测试全绿，边界回归抓不到 | 加一例 `enqueuedAt = iso(NOW_MS - PURGE_FAILED_AFTER_MS)` 断言 `isPurgeableFailedIntent(...) === false` 且 save 0 |
| P2-3 | `packages/dsh-dots/test/outbox-purge-failed.test.mjs:182-205`（标题 `:182`） | 只断言 `ok` / `failed` / `outbox.length` / `outbox[0].intentId`（`:196-200`）；机制正确性由 `cycle.ts:1355-1366` 证明 | 标题比断言强，与批次里其他 P2 文案问题同类 | 收敛标题，或用 `const snap={...}` 对 core 结果全字段 deepEqual |
| P2-4 | `packages/dsh-dots/src/sync/cycle.ts:86,427-437` + `~\.dsh\dots\outbox\83b24a6a05769119.json` | 三条 `enqueuedAt` 为 `2026-11-22T19:12:50/19:15:20/22:03:23+08`；今天 5.44–5.56 天；`SELECT_NOW []`；最早 `2026-11-29T19:12:50+08` | **下一次周期不会清理任何一条**；结案若写"碎片已清"即为不实陈述 | 结案报告写明"机制上线、碎片未清、11-29 晚起随成功周期逐条清理"；`MODULES.md` 补同口径登记行 |

**非本模块缺陷（记录但不计计数）**：G1/G2 期间仓库里仍有其他车道的 `apps/arkui-schedule/**`、`docs/MODULES.md` 等改动；本模块 tsc 0 诊断、套件 1118/1116/0/2 全绿，未受其影响。`bootstrap.ts:190-192` 未把 `logger` 传给 `runV2Cycle`，生产日志静默（不泄漏、不可观测），属装配层既有事实，不在本模块 3 路径内。

---

## 4 `unverified`

1. **真机/生产时钟**：生产 `now` 是 `V2Runtime` 构造时的 `new Date()`（`bootstrap.ts:156`）而非每周期刷新；若插件进程从 11-28 之前一直运行，`now` 更早，仍不越过阈值；但"下一个真实周期在何时触发"未验证（取决于 DSH 会话/激活时机）。
2. **`hdc` / 平板侧**：未执行任何设备命令；碎片文件只在 PC `%USERPROFILE%\.dsh\dots\outbox\` 读取，平板是否有另一份同 hash outbox 未验证。
3. **并发写入竞态**：`purgeStaleFailedIntents` 在 core `outbox.save()` 之后再次 `load()`→`save()`；若两个周期/实例并发写同一 outbox 文件，是否可能互相覆盖未在本次只读评审中验证（现有实现无锁，属既有架构约束）。
4. **重复 `intentId`**：`selectPurgeableIntents` 不去重，`ids.length` 作日志计数；若同一 `intentId` 出现多次，计数可能大于实际删除条数（`dequeueIntents` 用 Set 去重后删除更少）。真实数据三条 id 各不相同，未触发；未做专门探针。
5. **第一次误写的探针输出**：首轮因 workdir 相对路径写错，`packages/.tmp/gates-rvop-*.out` 目录不存在而报错；无文件产生，随后用 `../../.tmp` 重跑成功（G1 首轮 tsc 本体已 exit 0，但留存文件以重跑为准）。
6. **车道 tsc 留存**：`packages/dsh-dots/.tmp/gates-op-tsc.out` 96 B 的内容是车道**手工追加**的 `TSC_NOEMIT_EXIT=0`，不是编译器输出；按指派把它当证据，同时以本评审 G1 的独立 exit 0 交叉确认。

---

## 5 冻结建议

- **裁决：Freeze-with-fixes。** 三条路径可进入提交队列；核心逻辑不需要回滚，dist 已新鲜（78/78）且 window 仅 `cycle.js`。
- 冻结前请 Lead 要求原车道做四处最小修补：① `enqueuedAt` 非正 fail-closed + P5 补负数例（P2-1）；② P4 旁边补"恰好 7 天"用例（P2-2）；③ P8 标题与断言对齐或补全字段快照（P2-3）；④ **结案口径固定为"机制已上线、三条碎片今天不清理、最早 2026-11-29 19:12+08 起逐条可清"**（P2-4）。
- 不因其他车道的未提交改动回滚本模块；但 `docs/MODULES.md` 目前缺本模块登记行，冻结时由车道按 P2-4 口径补一行，避免后续 session 把"有 purge 模块"读成"碎片已清"。
- 本评审未修改任何源、测试、dist 或 git 状态；唯一写入是本文件（探针输出仅落 gitignored `.tmp/gates-rvop-*.out`）。
