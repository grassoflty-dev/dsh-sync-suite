# REVIEW — `mod-v2-read-service`（v2 单时间线只读服务接线）

> 独立只读评审。评审对象：新增 `apps/arkui-schedule/entry/src/main/ets/services/timelineStore.ets`（278 行）、
> `apps/arkui-schedule/entry/src/main/ets/pages/Index.ets`（+14 −1：:62 / :349–350 / :375–385）、
> 新增 `apps/arkui-schedule/tools/test/timelineService.test.mjs`（23 例）。
> 依据：`项目理解.md`、`docs/DATA-CONTRACT-v2.md` §2/§6/§9/§11、`docs/MODULES.md`。
> 评审期间设计方并发补写了 `docs/DATA-CONTRACT-v2.md:247`、`docs/MODULES.md:34/56/74/97`、
> `docs/ROADMAP.md:554/593`；本评审已按**并发更新后的最终工作树**重跑全部门闸并复核代码未变。

## 1. 结论

| 级别 | 数量 | 结论 |
| --- | --- | --- |
| P0 | 0 | 无 |
| P1 | 1 | 排序风险：**本模块自身可提交（非阻塞）；`mod-v2-dual-write-off` 必须满足前置条件后才可落地（对其阻塞）** |
| P2 | 3 | 日期目录只校验形状、启动期仍有 v1 自愈写、口号「从不写开关」需精确化；均不阻塞提交 |

**总判定：PASS（本模块可提交）**。五条降级路径全部正确；只读边界、flag 语义、v2 分支顺序、
`openIndexStore` 隔离、契约函数复用、门闸全绿均有证据。最重要的发现是**排序风险**：
没有任何代码把 `timeline.readMode` 翻成 `'v2'`——v2 分支默认惰性；若 `mod-v2-dual-write-off`
先停写 v1 / 删除 v1 数据而未在同一交付里翻 flag 并保证 `schemaVersion:2` 标记，首页会继续走 v1
分支而显示空列表。反向回滚同理：在「只有 v2 数据」的仓库上回滚本模块会读空，残留 `'v2'` flag
因无读取者而完全惰性，不构成补救。

## 2. Findings（file:line + 原文）

### P1-1 排序风险：flag 默认 v1 且无人翻转；dual-write-off 不得先于本模块生效（对下游阻塞）

- `timelineStore.ets:95–98`：`return stored === 'v2' ? 'v2' : 'v1';`（注释：*"缺省值不落 AppStorage —— 默认行为由后续模块显式翻转"*）
- `timelineStore.ets:109–111`：`return this.isV2() && this.readMode() === 'v2';`
- `docs/MODULES.md:31`：`mod-v2-dual-write-off … 待开始`；`docs/ROADMAP.md:593` 已写明「需先说明『已迁移仓库回退到 v1 会读空』的排序风险」。
- 后果：当前树里 schema 合法 + flag `'v1'` 时 `useV2()` 为 false，`Index.reload()` 走 v1 分支
  （`Index.ets:385 / :392`）。v1 数据一旦被停写/清理，首页读到空。
- 要求：顺序固定为 `contract → migration → **本模块** → dual-write-off`；dual-write-off 必须在同一交付里
  显式 `setReadMode('v2')`（前置 `schemaVersion:2` 已落地）；回滚必须逆序：先回滚 dual-write-off，再回滚本模块。

### P2-1 日期目录只做形状校验，未实现契约 §2 的「合法日历日 + 跳过计数」

- `timelineStore.ets:37–38`：`/** 目录名必须是合法日历日，非法目录直接跳过（契约 §2 可测项）。 */ const DATE_KEY_RE: RegExp = /^\d{4}-\d{2}-\d{2}$/;`
- `timelineStore.ets:126`：`if (!DATE_KEY_RE.test(name) || !this.fileExists(\`${root}/${name}/records.json\`)) { continue; }`
- `docs/DATA-CONTRACT-v2.md:42`：`目录 2026-13-99 被跳过，计数 +1，其他日正常读取`。
- `2026-13-99` 能通过 `DATE_KEY_RE`（纯 `\d{}` 形状），会进入 `listDates()` 并被 `readDay()` 读取；
  没有日历合法性校验、也没有计数。`model/timeline.ts` 同样无此校验（grep `valid|isValid|calendar` 无匹配）。
  不影响五条 degrade 路径，但属于可测契约项的漏实现；建议补真日期校验 + `[tl]` 计数与测试。

### P2-2 启动期仍有 v1 自愈写（属于 dual-write-off 的收尾范围，非本模块缺陷）

- `Index.ets:354`：`openIndexStore.reconcile();`（bootstrap 中无条件执行，本模块未触碰）。
- `openIndexStore.ets:226–243`：索引缺失或有漂移即 `this.replaceEntries(merged)`；`openIndexStore.ets:165/167`
  为 `this.writeTextSync(tmpPath, text)` / `fs.renameSync(tmpPath, path)` → 写 `devices/<id>/open.jsonl`。
- 本模块的 `reload()` v2 分支（`Index.ets:378–384`）确实不碰 `openIndexStore`/`reconcile`/`loadSummary`，
  `test:204–209` 也证明 `onPageShow`/`reconcileSavedRow` 原样；但「flag=v2 即全链路零 v1 写」在启动期并不成立。
  该残留路径应随 `mod-v2-dual-write-off` 一起处理，本模块无需改。

### P2-3 「从不写开关」的精确口径（澄清，非缺陷）

- 文件级确实存在一处 `AppStorage.setOrCreate`：`timelineStore.ets:105` `AppStorage.setOrCreate<string>(TIMELINE_READ_MODE_KEY, mode);`
  —— 位于显式 `setReadMode()` 内，且先有 `:102–104` `if (mode !== 'v1' && mode !== 'v2') { return; }`。
- 因此检查项「文件中完全没有 `setOrCreate`」按字面不成立；**成立的是「无隐式/默认写入」**：
  `ensureReady()`（:55–80）与 `readMode()`（:95–98）均无写，`setReadMode` 仅写合法值。
  新测试 `timelineService.test.mjs:198–202` 断言的正是这个精确口径，实现与测试一致。

## 3. 五条降级路径（逐条回答 Lead 的问题）

共同前提：`Index.reload()` 的 `useV2()` 分支在两条 v1 分支**之前**（`Index.ets:378` vs `:385` / `:392`），
共享尾部 `this.refreshQuery(); this.pruneSelection();`（`:411–412`）位于 try/catch 之后且未被 diff 触及；
bootstrap 仅多一行只读的 `await timelineStore.ensureReady(...)`（`:350`）。v1 数据读取调用字节不变。

| 场景 | 门槛结论 | `isV2()` / `useV2()` | `Index.reload()` 走向 | 服务读返回 | 日志差异 | 判定 |
| --- | --- | --- | --- | --- | --- | --- |
| (a) 完全没有 `timeline/` | `fileExists(markerPath)` false（`:63`）→ `v2=false` | false / false | 原样 v1 分支（`:385`/`:392`） | `[]`（各读方法 `:144`/`:162`/`:185` 前置守卫） | 仅多 `[tl] 缺少 timeline/schema.json，按非 v2 处理`（`:64`） | ✅ 正确 |
| (b) 有 `timeline/` 但无 `schema.json` | 同 (a)，与目录是否存在无关 | false / false | 原样 v1 分支 | `[]` | 同 (a) | ✅ 正确 |
| (c) `schema.json` 不可解析 | `parseSchemaMarker` 返回 `ok:false`，reason `schema.json 不是合法 JSON…`（编译模型实测） | false / false | 原样 v1 分支 | `[]` | 仅多 `[tl] schema 标记不是 v2，按非 v2 处理：<reason>`（`:69`） | ✅ 正确 |
| (d) `schemaVersion: 3` | `ok:false, version:3`，reason `不支持的 schemaVersion：3（仅支持 2）`（编译模型实测） | false / false | 原样 v1 分支 | `[]` | 同 (c)，reason 含版本号（`:69`） | ✅ 正确 |
| (e) 合法 v2 标记但 flag `'v1'` | 门槛通过 → `v2=true` | **true / false** | 原样 v1 分支（`:378` 条件不成立） | UI 不调用服务；**若直接调用**则按 `:144/:162/:185` 的 `isV2()` 守卫返回 v2 数据（不是 `[]`）——这是设计上的精确含义 | 无新增 `[tl]` 日志 | ✅ 正确（UI 层面）；需把「service reads return `[]`」限定为 (a)–(d) |

> 说明：题面「`isV2()`/`useV2()` 同为 false」对 (e) 不成立——(e) 中 `isV2()` 按设计保持 true，
> 只有 `useV2()` 为 false；这是「标记可信、开关关闭」的正确语义，不影响「走 v1 原路」的结论。

## 4. Revert / 排序分析

1. **当前树回滚本模块**：删除 2 个新增文件、还原 `Index.ets` 的 +14 −1 后，无任何代码读取 v2；
   `reload()` 回到原始 `if (this.showAllPending) … else …`（diff 已证），v1 读路径字节不变、v1 数据仍在
   （本模块从不写 v2，也未删 v1）。`docs/MODULES.md:34` 已登记回滚方式。符合预期。
2. **残留 flag 的影响**：若 AppStorage 中残留 `timeline.readMode='v2'`，回滚后**完全惰性**——
   唯一读取该键的 `readMode()` 随服务文件一并消失，`Index.ets` 未使用任何其它 flag 读取点
   （`timelineService.test.mjs:198–202` 证明本模块没有写默认值；全文 grep 仅服务内一处读）。
   无需清理持久状态即可回 v1，与 `docs/DATA-CONTRACT-v2.md:247`「回退到 v1 不需要清理任何持久状态」一致。
3. **v2-only 仓库回滚 = 读空（已确认的排序风险）**：若 `mod-v2-dual-write-off` 已落地并清掉 v1 数据，
   再回滚本模块则既无 v1 数据可影响、也无 v2 读取者，首页显示空；残留 `'v2'` flag 不构成补救。
   因此 (i) 本模块必须在 dual-write-off 之前交付并启用；(ii) 回滚必须先逆序回滚 dual-write-off
   （恢复 v1 写/数据）再回滚本模块；契约 §10 对迁移/清理提交的逆序 revert 要求同理。
4. **未执行**：本评审为只读，未实际执行 revert，也未跑「回滚后全绿全量」（`docs/MODULES.md` §4 步骤 5）。
   该门闸由实施回滚的批次负责。

## 5. 测试质量评估

- **23/23 通过**；其中 **21 条是源码形状/静态契约断言**，**2 条是编译产物的真实行为断言**
  （`parseSchemaMarker` 版本 2/3，`timelineService.test.mjs:219–229`）。
- **能抓住真实破坏**：删掉写 API 守卫、删 `if (!this.isV2())`、改 flag 键名、改 `useV2()` 组合、
  把 v2 分支挪到 v1 之后、删 `refreshQuery/pruneSelection`、重新实现 `KEY_ORDER` 类解析、
  在 reload 里引入 `openIndexStore`/`appendRecord` 等，都会让相应断言失败。不是空测试。
- **既有断言未被削弱**：`git status --short` / `git diff` 显示代码侧仅 `Index.ets` 被修改，
  无任何既有测试文件改动；`timelineService.test.mjs` 为纯新增，全量 +23 与新用例数一致。
- **缺失用例（建议补）**：
  1. `readMode()` 缺失 / 垃圾值 / `'v2'` 的运行时行为（本评审用临时 stub harness 实测，未进套件）；
  2. `setReadMode()` 合法值写入 vs 非法值零写入的行为断言（现仅正则形状）；
  3. 写 API 清单补 `createStream` / `fs.write` / `fs.copyFile`（:60 现仅 grep 6 个串）；
  4. `ensureReady()` 对「标记缺失 / 坏 JSON / 版本 3」→ `isV2()===false` 的行为断言（现只测纯函数）；
  5. `listDates()` 跳过 `2026-13-99` 等非法目录并计数（对应 P2-1，当前实现不满足）；
  6. `readDay()` 对不可解析 `records.json` / 缺账本返回 `[]` 的路径；
  7. `readAll()` / `pendingRecords()` 的 ts 升序断言；
  8. `readSummaryText()` 缺文件返回 `''`；
  9. 「flag 残留 `'v2'` 且 schema 为 v1 / 已回滚」时 `useV2()===false` 的排序安全断言；
  10. bootstrap 中 `timelineStore.ensureReady` 在 `this.ready = true` / `reload()` **之前** await 的顺序断言
      （:160–169 只检查排在 `scheduleStore.ensureReady` 之后）。

## 6. 门闸（最终工作树，原样尾部）

```
$ node apps/arkui-schedule/tools/overlay.mjs status
覆盖层：未应用（工作区为「共享源码 + 平台目录」的原始形态）
[overlay] applied=false

$ node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
（无输出）
TSC_EXIT=0

$ node --test apps/arkui-schedule/tools/test/timelineService.test.mjs
ℹ tests 23
ℹ suites 0
ℹ pass 23
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 98.8135

$ node --test "packages/dsh-dots/test/*.test.mjs" "apps/arkui-schedule/tools/test/*.test.mjs"
ℹ tests 2482
ℹ suites 312
ℹ pass 2481
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 27375.076

$ node apps/arkui-schedule/tools/validate-app.mjs
🔍 校验 ArkUI-X 工程：C:\Users\GWL\Desktop\itwillclaude\dsh-sync-suite\apps\arkui-schedule
✅ 全部通过：8/8 条规则（JSON5/JSON 70 个、相对 import 364 条、main 静态 import 462 条、页面 7 个、rawfile/git 2 个文件）
```

与期望一致：新测试 23/23；全量 2482 / 2481 pass / 0 fail / 1 skip；validate-app 8/8；tsc 0。

## 7. unverified

- 真机 / ArkTS 编译：`hdc list targets` 为空、无 DevEco/SDK；`.ets` 服务与 `Index.ets` 接线未做真机编译或运行
  （`tsc` 只编译 `tools/tsconfig.json` 覆盖的纯 `model/`，不覆盖 `.ets`）。
- `AppStorage` 真实运行时语义：flag 行为评审中用临时 stub 对**真实方法体**做动态求值验证
  （missing/garbage→'v1'、'v2'→'v2'、非法 setReadMode 零写入、useV2 组合正确），非设备实测。
- `@kit.CoreFileKit` 的 `readTextSync/accessSync/listFileSync` 真实 I/O 与异常路径：五条 degrade 路径由源码 +
  编译纯模型推演，未在运行中的服务上执行。
- 没有 v2-only 仓库可供端到端验证；dual-write-off 尚未开始；回滚后全绿未执行（只读评审）。
- 并发文档更新在评审期间发生；已按最终树重跑门闸，但后续若文档再变，本文引用的行号需重核。
