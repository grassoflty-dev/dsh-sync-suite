# 第 4 轮关键改动独立评审（只读）

> 评审者：`pm/review-round4`（只读子代理，未派生任何子代理、未改任何源码/测试/dist、未跑 build-harmony、未做 git 写操作、未上真机）。
> 评审范围：A 导出/导入、C AI fallback、D 差异与回滚、B 主题（按任务书第 4 轮四条线的**关键实现**）。
> 证据基线：`main` @ `634a763`（工作区干净，`git status --short` 为空）。
> 实跑（只读性质）：`theme.test.mjs` 54 pass / `exportImport.test.mjs` 56 pass / `aiFallback.test.mjs` 60 pass / `diff.test.mjs` 10 pass / `rollback-ux.test.mjs` 11 pass。
> 行号全部取自本次实际读取（`docs/PLUGIN-DIFF.md` 实际位于 `packages/dsh-git-config-sync/docs/PLUGIN-DIFF.md`，仓库根 `docs/` 下**没有**该文件——任务书里的路径不存在，见 §6 附注）。

---

## 0. 结论 + 必须改的条目编号

**结论：有条件通过（必须改 6 条）**

四条线的"不覆盖/不越界/不复用错误语义"骨架是成立的：导入只追加、导出只读、未开 fallback 只发主源、`confirm !== true` 门禁四态全拒、快照 sha 校验在写前 fail-closed。但有 2 个 P0 级"看起来没问题、实际会误导人"的缺口，以及 4 个 P1 级（文档与实现互相矛盾 / 安全文案与能力不匹配 / 静态门闸可绕过 / 关键落盘路径零测试）。

| 编号 | 级别 | 条目 | 一句话 |
| --- | --- | --- | --- |
| M1 | **P0** | `diffText` 在 `maxLines` 预算"正好用完"时**静默丢弃后续 hunk**，返回的每个 hunk 都是 `truncated:false` | UI 会让人以为差异已看全（已用真实输入复现，见 §3.2） |
| M2 | **P0** | 导入确认没有幂等复核：`pendingImport` 无失效机制、`appendImportPlan` 不重读本机再验 id | 双击 / 跨设备同步窗口内会把同一 `id` 重复追加进只追加日志 |
| M3 | P1 | `docs/AI-FALLBACK.md` §2 决策表把 **402 写成 `abort`**，代码与测试都是 `next-source`，§7 第 2 条又说"402 归入 abort" | 契约文档自相矛盾（三方不一致） |
| M4 | P1 | 回滚第 2 步只有计数、**没有可展开的内容差异**（`RollbackPreview` 无 `hunks` 字段，client 传 `hunks: []`） | 「不可撤销」的确认页看不到到底改什么 |
| M5 | P1 | `theme.test.mjs` 的色值静态门闸可被 `#FFF` / `Color.Cyan` / `Color(0xFF0000)` / `'#' + 'F1F3F5'` / `hsl()` 绕过（已逐条实测） | 文档称"硬门闸"，实际是软约束 |
| M6 | P1 | `appendImportPlan` / `exportSchedules`（唯一碰盘的两处）**零自动化测试**，导入"部分写入"分支无回归 | 最坏：写了别的日期、写了半批，没人会发现 |

**未构成阻断**：C 线隐私红线（未开 fallback 只发主源）成立；D 线 `confirm:true` 四态门禁成立；D 线快照 sha 失败 fail-closed 成立。

---

## 1. A 导出/导入（只读性、去重、原子性）

### 1.1 `planImport` 是否真的只追加 —— **是**

`planImport`（`apps/arkui-schedule/entry/src/main/ets/model/exportImport.ts:700-781`）只产出计划，不写盘：

- 既有时取"每个 id 的最新 ts"作为比较基准：`:703-717`（`isTsAfter` 定义在 `:665-672`：两边都能 `Date.parse` 就比毫秒，否则比字符串）；
- 只有 `latestTs.get(id) === undefined` 才进 `toAppend`：`:736-767`；
- 同 id 更新 → `conflictItems`（`:737-745`）；同 id 更旧**或 ts 相同** → `skipped`（`:746-748`，`isTsAfter` 严格大于，所以"相同"落 skipped，语义与文档一致）；
- 一批内重复的新 id：`acceptedTs` 兜住（`:751-764`），同批内同 id 最多追加一次。

三种输入的归属（代码 + 测试双证）：

| 输入 | 期望 | 代码 | 测试 |
| --- | --- | --- | --- |
| 同 id，incoming ts 更新 | `conflict`，不进 `toAppend` | `exportImport.ts:737-745` | `tools/test/exportImport.test.mjs:536` |
| 同 id，incoming ts 更旧 | `skipped` | `:746-748` | `:551` |
| 同 id，ts 相同 | `skipped`（幂等） | `:748` | `:561` |
| 一批 4 条混合 | 各归各位 | `:725-768` | `:585` |
| 同批重复新 id | 先到 added，后到按规则 | `:751-764` | `:607` |

结论：**归属正确**。`existing` 传原始多版本也行（比较取最新 ts），不依赖调用方先 `foldById`。

### 1.2 确认时会不会用到与 dry-run 不同的 plan —— **不会重新解析，但可能"过期 plan"**

- `services/exportService.ets` **没有**"解析+落盘"一体函数：`planImportFromText`（`:349-379`）只算，`appendImportPlan`（`:413-511`）只落盘，落盘只读 `plan.toAppend`（`:429,443,498`）。
- 文档给的挂载片段把计划存 `pendingImport`（`docs/EXPORT-IMPORT.md:230,251,267`），确认时不重新 `planImportFromText`（`:282-284` 明确要求），所以"用不同 plan"的旧风险已堵。

**但有新的 TOCTOU（M2）**：`appendImportPlan` 拿到的计划可能已经过期，函数**不重读本机记录复核 id**：

1. dry-run 之后、确认之前，本机被其它页面/另一台设备经 Git 同步写入了同 `id` → `toAppend` 里那条仍然会被追加，历史里出现同 id 两个版本（读侧 `foldById` 会盖掉旧的，所以"不丢数据"，但**日志被污染**，且与文档"同 id 在同一批里最多追加一次"的承诺在跨批场景下失效）；
2. 面板片段在 append 前**没有**置 `busy`（`docs/EXPORT-IMPORT.md:263-274` 对比导出/选文件处 `:236,243` 都置了 busy）——两次极快的点击可以在 ArkUI 重渲染前调用两次同步的 `appendImportPlan`，同一批被追加两遍；
3. `pendingImport` 无 TTL、无"setState 时失效"机制。

### 1.3 有没有路径会改写历史行 / 写别的设备目录 —— **没有**

- 追加实现：`appendTextAtEnd`（`exportService.ets:158-175`）——`OpenMode.READ_WRITE | CREATE`（**不带 TRUNC**），`offset = stat.size`，只有末尾不是 `\n` 才补一个换行（`:162-169`），然后 `writeSync(text, {offset})`。历史字节不改。
- 目标路径只有一个来源：`scheduleStore.dayFilePath(date)`（`:476`）→ `${filesDir}/git-repo/devices/${this.deviceId}/schedules/${date}.jsonl`（`services/scheduleStore.ets:111-127`）。`deviceId` 由 store 单字段决定，**导入入参里没有任何字段能改它**，所以"写别的设备目录"没有可达路径。
- 路径穿越：`date` 来自 `recordDateKey(ts)`（`model/jsonl.ts:282-295`）——ISO 前缀分支只 `slice(0,10)`，而能进这个分支的前缀被 `^\d{4}-\d{2}-\d{2}` 钉死（只含数字与 `-`）；退化分支由 `Date` 格式化。都不会出现 `/`、`..`。且顺序上先 `encodeRecord` 全部编码成功（`exportService.ets:446-461`），再进写循环（`:471-483`），`encodeRecord` 抛错就到不了 `dayFilePath`。
- 唯一"两种日期来源"的边角：`planImport` 用 `ts` 定归属，但记录上若带扩展字段 `date`，`importRecordProblem`（`exportImport.ts:648-654`）只校验它合法、**不校验它与 `ts` 同日**。写入按 `ts` 落到 `YYYY-MM-DD.jsonl`，而 `date` 字段被 `normalizeRecord` 原样保留（`jsonl.ts:149-153`）→ 文件里出现"date 与所在文件名不一致"的记录。读侧一律按 `ts`（`jsonl.ts:298-300`），当前无功能影响，但属 §3 契约的隐性歧义（P2）。

### 1.4 失败原子性 —— **编码失败=零写入；写入失败=半批（已文档化）**

- **编码失败**：先把每个日期的全部行编码完（`:442-461`），任一抛错 → `failed(...)`，一个字节都不写。✔ 这一条是硬保证。
- **写入失败（Q2 的正面回答）**：写循环按日期逐个 `appendTextAtEnd`（`:469-495`）。第 2 个日期失败时，第 1 个日期**已经写进去了**，返回 `ok:false` + `files` 只列已写的文件 + `reason` 里"已写入 N 个文件"（`:485-495`）。文档也承认（`docs/EXPORT-IMPORT.md:195`）。
  **最坏情况会写进去什么**：按 `Array.from(grouped.keys())` 的顺序（= `toAppend` 首次出现顺序，即 incoming 顺序），前 k 个日期的**整批**记录已落盘（含当天所有新增记录），第 k+1 个日期起一条不落；另外 `appended` 是按 bucket 长度**先加后不管**（`:479-482`），如果 `writeSync` 实际短写，计数会虚高。
- 另外两处细节：(a) `fs.writeSync` 返回值被忽略、没有"写满循环"（`:171`）——短写会静默产生半行/截断行（概率低，但这是唯一一处"内容可能不完整却返回 ok"的路径）；(b) 补换行与正文是**两次** `writeSync`（`:167,171`），中间崩掉会留下一个孤立的 `\n`（`parseJsonl` 会跳过空行，无害）。
- 第 3 步 `openIndexStore.applyRecord` **未包 try**（`:498-500`），但 `services/openIndexStore.ets:191-194` 的契约是"任何异常只记日志"，所以实际不会把异常冒到 UI——这一条我原本怀疑，读完实现后**否掉**。

### 1.5 导出视图是否只读 / 能否原样吃回 —— **是 / 文件级无损，落盘后字段无损但键序被规范化**

- 只读：`exportSchedules`（`exportService.ets:204-274`）只做 `scheduleStore.readAll()`（`:226`，`scheduleStore.ets:174-184` 纯读：`listDates` + `readDayText`）→ 渲染 → 写 `<filesDir>/exports/schedule-*.{md,json}`（`:116-118,258-260`）。**不碰 `devices/**`、不碰 `settings.json`/`state.json`、不建快照**；`exports/` 在 `git-repo/` 之外（文档 `docs/EXPORT-IMPORT.md:113,299` 也这么声明）。
- JSON 吃回：`buildJsonExport` 顶层五键固定、`records` 原样引用（`:554-570`，不裁剪/不改名/不补默认值）；`parseJsonImport` 只做文件级校验（`:796-840`），逐条校验交给 `planImport`。测试有 round-trip（`exportImport.test.mjs:414`）。
- 一个必须写清的限定：**"原样吃回"是文件级无损**。真正落盘走 `encodeRecord` → `normalizeRecord`（`jsonl.ts:117-164`）会把字段**按契约顺序重排**（`id, ts, title, body, ocr_text, author, done, attachments, pageObjects, ai_structured, ai_processed, ocr_time`，未知扩展字段排到末尾），`attachments` 也会被 `normalizeAttachment` 重排（`:100-110`）。语义无损、**字节不保真**。文档 `docs/EXPORT-IMPORT.md:107-108` 说"逐字段吃回（有 round-trip 断言）"，措辞容易被读成字节无损，建议改成"字段级无损、键序按 JSONL 契约规范化"（P2）。
- 另一个 P2：`uniqueExportPath` 是先 `fileExists` 再 `openSync(...CREATE|TRUNC)`（`:178-196` + `:142-149`），检查与创建之间没有排他，极端的并发导出会覆盖同名文件（单线程 UI 下概率极低）。

---

## 2. C AI fallback（隐私、决策表、重试上限）

### 2.1 未开启时是否存在"发给主源之外"的路径 —— **没有找到**

三道印证：

1. `planFallback`（`model/aiFallback.ts:309-320`）：`enabled !== true` → 直接 `[list[0]]`；列表空 → `[]`。
2. 运行器把"设置开关"和"调用方开关"取 **AND**：`services/aiFallbackRunner.ets:199-200`（`live.enabled = options.enabled && settings.aiFallbackEnabled === true`），设置读不到时只信入参（`:194-197`）。
3. 每轮尝试前**重建**计划：`:435-441`（`readLiveSettings` → `candidatesFor` → `planFallback`），`index` 越界即退出；只有 `plan[index]` 被 `attemptSource` 发出去（`:442-445`）。**没有**任何"主源失败后直接拿 `live.order[0]` 兜底"的分支。

隐私向的细节（都是"发得更少"方向，安全）：
- `candidatesFor`（`:215-222`）在 `sources.length <= 1` 时会把设置里的顺序补进来，但随后 `planFallback(enabled=false)` 又会砍到 1 个，不构成泄漏。
- `isSameSource` 忽略 `baseURL`（`aiFallback.ts:235-242`）：同一 provider+model 但不同 baseURL 的备用源会被去重掉 → 用户自建代理可能被**静默忽略**（内容不会错发，但"用户点了却没生效"）。P2。
- 未知 provider 有双保险：`parseFallbackOrder` 逐条丢弃（`:346-348`，注释明确"不回落 deepseek"）+ `attemptSource` 再判一次并归 `config`（`aiFallbackRunner.ets:321-326`）。

### 2.2 `planFallback` 过滤是否严密 —— **基本严密，一处不严密但方向安全**

| 场景 | 结果 | 证据 |
| --- | --- | --- |
| 主源在备用列表里 | 被去重吃掉（provider 大小写不敏感） | `aiFallback.ts:263-285`；测试 `aiFallback.test.mjs:229` |
| 重复源 | 首次出现优先 | 同上；测试 `:222` |
| 未知源（直接传进 `planFallback`） | **不过滤**（`planFallback` 不查预设表） | `aiFallback.ts:245-260` 只归一不校验 |
| 未知源（经设置解析 / 经运行器） | 丢弃 / 归 `config` 不发包 | `:346-348`、`aiFallbackRunner.ets:324-326` |

即：绕过 `parseFallbackOrder` 直接把脏 id 塞进 `planFallback` 会得到一个"看起来合法"的计划，但真正发请求前 `attemptSource` 会拒（不会发到默认源）。**这不是泄漏，但是"计划与执行不一致"的接口异味**；建议 `planFallback` 内也做一次 `findProvider(id).id === id` 过滤（P2）。

### 2.3 诊断是否可能漏出 key —— **`sk-` / `Bearer` / `api_key=` / `token=` 覆盖到了；base64/JWT 形态没覆盖**

`sanitizeDiagnostic`（`aiFallback.ts:488-505`）依次走 `maskSecretValues`（`:430-440`）+ `maskLooseWords`（`:443-447`）+ `truncateMessage`（`:450-455`，200 字符）：

| 形态 | 是否覆盖 | 证据 |
| --- | --- | --- |
| `sk-xxxx` | ✅ | `:432` `/\bsk-[A-Za-z0-9_-]{4,}/g` |
| `Bearer <cred>` / `Basic <cred>` | ✅（连方案名一起抹） | `:433` |
| `api_key=` / `apiKey:` / `x-api-key` / `authorization` / `secret` / `password` / `token`（带引号与裸值） | ✅ | `:434-438`（三种引号/裸值正则） |
| 残留的 `bearer`/`key`/`token`/`secret` 单词 | ✅ | `:443-447` |
| **裸 base64 / JWT（`eyJhbGciOi…`）/ `AIza…` / `gsk_…` / 高熵无名字符串** | ❌ **未覆盖** | 三组正则都要求前缀或键名 |

风险评估：`message` 的来源是 `classifyAiError(status, body, label)`（`aiFallbackRunner.ets:372-374`），即**上游返回体**；若某家把请求头/密钥回显在错误里且不带 `token=`/`sk-` 这类可识别前缀（例如 OAuth 形态的 JWT、或纯 hex 的 key），会以明文进诊断并上界面（诊断不落盘，`docs/AI-FALLBACK.md:86-87`，所以泄漏面是屏幕/截图，不是持久化）。判定：**P1 建议补一条"长 base64/JWT 段遮蔽"规则**（如 `\b[A-Za-z0-9_-]{24,}\b` 且同时含 `eyJ`/`=` 结尾时遮蔽），并加一条用例。另：`truncateMessage` 在遮蔽**之后**执行，不会把被遮的片段截成"半截密钥"，这点是对的。

### 2.4 决策表：401/403/429/超时/网络/5xx/解析/402/400/404/422 与文档一致性 —— **除 402 外一致**

代码 `classifyAttempt`（`aiFallback.ts:180-219`）顺序：`ok` → `timeout|network|parse|config` → 无状态码按 kind → `-1/0` → 401/403 → 429 → 5xx → **402** → 4xx → 其它 abort。

| 情况 | 代码 | 文档 `docs/AI-FALLBACK.md` | 一致? |
| --- | --- | --- | --- |
| 401/403 | next-source (`:200-202`) | §2 表 | ✅ |
| 429 | next-source (`:203-205`) | §2 | ✅ |
| 超时/网络（含 -1/0） | next-source (`:186-188,197-199`) | §2 | ✅ |
| 5xx | next-source (`:206-208`) | §2 | ✅ |
| 解析失败（含 HTTP 200） | next-source (`:186`,kind 优先) | §2 + "判定顺序" | ✅ |
| **402** | **next-source (`:209-213`)** | **§2 表把它列进「其它 4xx → abort」，§7.2 又说"402 按 4xx 归入 abort"** | ❌ **矛盾（M3）** |
| 400/404/422/499 | abort (`:214-217`) | §2 | ✅ |
| 3xx / 2xx+ok=false / 无类别 | abort (`:218`) | §2 最后一行 | ✅ |
| `retry-same` | 从不出（`classifyAttempt` 无该返回） | §2 最后一行 + §5 | ✅ |

测试站在代码这边：`tools/test/aiFallback.test.mjs:141-144` 明确断言 402 → `next-source`。所以是**文档错**（§2 表格行 + §7.2 两句都要改），不是代码错。

补一条文档没写的：**408（Request Timeout）落 `abort`**（`aiFallback.test.mjs:136` 把它和 451/499 一起钉在 abort）。408 属于运输层超时，换源常常有效；这属"文档未覆盖 + 语义可商榷"（P2，非本轮阻断）。

### 2.5 有没有"无限重试"或"总尝试次数 > maxAttempts" —— **没有可达路径**

- 计划长度上限：`planFallback` = `Math.min(normalizeMaxAttempts(max), 去重后长度)`（`aiFallback.ts:318`），`normalizeMaxAttempts` 夹到 `1..4`（`:288-300`）；`dedupeSources` 去重。
- 循环（`aiFallbackRunner.ets:434-486`）：只有 `success`（return）/`abort`（break）/`index++` 三条出口；`retry-same` 分支被 `MAX_SAME_SOURCE_RETRIES = 1`（`:62`）挡住第二次就落到 `index++`（`:477-485`）。而 `classifyAttempt` 根本不产出 `retry-same`，该分支是死代码。
- 唯一"可能超过初值"的情形：循环里**重读设置**，用户中途把 `maxAttempts` 从 2 调到 4 → 计划变长，总尝试数上升，但仍 ≤ 4。用户中途调小 → `index >= plan.length` 立即 break。方向都安全。
- 测试：`aiFallback.test.mjs:391-427` 两组"连续错误序列"覆盖 429→400 终止、4 连换源后失败，能抓"停不下来"的回归。

---

## 3. D 差异与回滚（只读预览、门禁、fail-closed）

### 3.1 `diffText` 健壮性 —— **不抛，但截断标记有洞（M1）**

输入健壮性（`packages/dsh-git-config-sync/src/engine/diff.ts`）：

| 输入 | 行为 | 证据 |
| --- | --- | --- |
| 非字符串（null / 数字 / 数组 / 对象） | `asText` 折成 `''` | `:82-84` |
| 二进制（含 NUL）/ > 512KB | 只给 kind + 字节数，`hunks: []` | `isOpaque` `:103-107`、`diffText:326`、`diffFiles:427-428` |
| `\r\n` vs `\n` | 行尾 `\r` 只影响展示，不参与比较（纯 CRLF 不算变更） | `toLines:110-122`、`linesKey:124-126` |
| 无末尾换行 | 算内容差异，hunk 补 `\ No newline at end of file` | `:67,290-298` |
| 空输入 | `hunks: []`、0/0 | `:111`、`toLines` 首行 |
| 任何内部异常 | 整体 try/catch → 空结果 | `:320,347-349`；`summarizeFiles:371-393`；`diffFiles:401,438-440`；`summarize:449,462-464` |

LCS 预算：中间段超过 `MAX_DP_CELLS = 1_000_000` → 降级为"整段替换"并给一个 `truncated: true` 占位 hunk（`:66,168,331-337`）。

### 3.2 `maxLines` 截断会不会让 UI 误以为"没有更多差异" —— **会（已复现，M1）**

机制：
- `buildHunks` 在**每个 range 开头**检查 `budget <= 0`，若为真则 `truncated = true; break`（`:252-258`）——**不产出任何 hunk**；
- 中段被切断时会 `cut = true` 并把该 hunk 标 `truncated: true`（`:284-300`）；
- 但 `diffText` 的返回值**只包含 `built.hunks`**，`built.truncated` 被丢弃（`:345-346`）——`HunkBuildResult.truncated` 没有任何消费者。

于是"预算刚好在某 hunk 末尾用完、后面还有 range"这条路径：后续 hunk 全部消失，而返回的每个 hunk 都是 `truncated: false`。UI 只在 `hunk.truncated` 时提示"仅显示前 N 行"（`src/client.js:1349-1351`），因此**什么都不提示**。

实测证据（用仓库自带 `dist/engine/diff.js`，只读执行）：

```
输入：4 行文本里 2 处相隔很远的改动，contextLines=0, maxLines=2
→ hunks=1, truncatedFlags=[false], addedLines=2
   （摘要说 +2 行，但只能看到其中 1 行；第 2 个 hunk 被静默丢弃）
另一组：3 处改动、maxLines=2 → hunks=1, flags=[false], added=3
对照：maxLines=1 时 → hunks=1, flags=[true]（这一条恰好被切断，能提示）
```

已有测试只覆盖"被切断"那一支（`test/diff.test.mjs:67-83`，400 行全替换，`maxLines=10` 一刀切在 hunk 中间），**没有**覆盖"恰好用完 / 后续 range 被丢"这一支——这就是它能活到现在的原因。文档 `docs/PLUGIN-DIFF.md:49,54-55` 承诺"超出即 `truncated: true` 并停止"，实现没兑现全。

修法（择一）：`diffText` 返回 `truncated = built.truncated`；或在 `buildHunks` 里"range 被整段丢弃"时给前一个 hunk 补标 `truncated: true`；或把最后一个 hunk push 一个空壳占位。并补一条"恰好整边界"的用例。

### 3.3 `previewDiff` 只读性 —— **profile / 快照 / state 都只读成立；git 工作副本会被 fetch 写**

- 本机模式（`src/rpc.ts:443-482`）：只读工作副本 `work/<repoHash>/devices/<self>/` + `collectLocal`（只读 profile）；不 `snapshots.create`、不 `cache.set`、不 `recordProbe`。测试逐字节比对 profile + 快照目录数（`test/rollback-ux.test.mjs:112-145`）。
- 远端模式（`:488-519`）：走 `buildPreview` → `git.ensureWorkTree()` + `git.fetch()`（`engine/preview.ts:261-262`）。这会写 git 工作副本与 refs——文档已声明（`docs/PLUGIN-DIFF.md:90-91`），不涉及 profile/快照/state。**判定：声明范围内只读成立**。
- 小缺口：本机模式对 `stat.truncated === true`（二进制/超 512KB）的文件**直接跳过 hunk**（`rpc.ts:477`），文件行统计仍是 0/0 且带 `truncated` 徽标（`client.js:1322-1324`），语义合理。
- 文档/实现不一致（P2）：`docs/PLUGIN-DIFF.md:178` 说"`previewDiff` 远端设备不存在 → `E_GIT`"，代码抛的是 `E_NOT_FOUND`（`rpc.ts:510`）。

### 3.4 `rollbackPreview` 是否严格只读 —— **是**

`previewRollback`（`engine/restore.ts:359-393`）只做：`snapshots.get`（`snapshot.ts:137-162`，内含 id 形态校验 + manifest sha256 校验，纯读）→ 扫 `SYNC_FILE_NAMES` 是否存在 → `readFile` → `diffFiles`。**没有** `snapshots.create` / `prune` / `writeFile` / 写 pendingFile。测试断言快照目录数与四个 profile 文件字节不变（`rollback-ux.test.mjs:183-233`）。

### 3.5 `rollback` 的 `confirm:true` 门禁 —— **四态全拒，不可绕过**

- 双层：`rpc.ts:426-428`（`payload.confirm !== true` → `E_CONFIRM_REQUIRED`，在 `snapshotId` 解析之前）+ `restore.ts:84-88`（`assertConfirm`，`confirm !== true` 即抛）。
- `{}` / `false` / `'true'` / `1` 四态：测试逐个跑（`rollback-ux.test.mjs:261-274`），并断言"门禁失败不得写文件、不得创建回滚前快照"（`:273-274`）——我实跑通过。
- 客户端两条路径都把 `confirm` 显式传 `true`（`client.js:2017,2112`），且测试断言 `rollbackCalls[0].confirm === true`（`rollback-ux.test.mjs:698`）。

### 3.6 快照 sha 校验失败是否 fail-closed —— **是（写之前就抛）**

`rollbackSnapshot`（`restore.ts:281-318`）第一步就是 `ctx.snapshots.get(...)`（`:287`）→ 快照缺失/文件名非法/`sha256` 不匹配都在**任何写操作之前**抛 `E_NOT_FOUND` / `E_SHA_MISMATCH`（`snapshot.ts:137-154`）。`previewRollback` 同一条路径（`:365`）。测试：`rollback-ux.test.mjs:240-253`（篡改快照文件 → `E_SHA_MISMATCH` + profile 逐字节不变 + 快照数仍为 1）。

### 3.7 回滚中途失败会不会留下"改了一半"的 profile —— **单文件不会半写；补偿写失败时会"已回滚但报错"**

- 落盘是 `atomicWrite`：同目录 tmp + `rename`（`restore.ts:99-114`），目标是**单个文件** `cordis.patch.yml`（`profilePatchPath:90-92`），不存在"多文件只改了一半"的问题（`rollbackSnapshot` 只写这一个文件，`:317` `restored: [patchFile]`）。
- 写后校验失败 → 用 `current` 回写（`:306-309`）再抛 `E_SHA_MISMATCH`。**残余风险**：若这次补偿写本身失败（磁盘/权限），异常是 `writeProfileFile` 抛的 `E_IO`，此时 profile 已是快照内容、用户却看到"回滚失败"，且 `pre-rollback` 快照（`:298-303`，在写之前创建）仍持有原内容 → 可人工恢复。**不是数据丢失，是错误语义错位**（P2）。
- `preRollback` 快照在写入前创建、且 `prune(10)` 在写之前（`:303`），所以"回滚本身也可撤销"成立。

### 3.8 回滚第 2 步的内容差异缺失（M4）

`RollbackPreview` 接口只有 `files / summary / willRestore`，**没有 `hunks`**（`restore.ts:334-343`，`previewRollback` 也只返回 `summary.files`，`:385-393`）；客户端传给 `FileDiffList` 的正是 `hunks: []`（`client.js:2956-2963`）。`FileDiffList` 只在 `pathHunks.length > 0` 时渲染"展开 hunk"按钮（`:1325-1337`），所以：

- 用户能看到：`N 个文件会变化（+X / -Y 行）`、`将写入：<绝对路径>`、按 added/modified/deleted 分组的**文件名与行数**；
- 用户**看不到**：任何一行实际内容。

对一个文案写着「确认回滚（不可撤销）」（`client.js:318` / zh locale）的动作，这个预览的信息量偏低；而 `docs/PLUGIN-DIFF.md:147` 写的是"`'preview'`（第 2 步：**文件级 diff** + willRestore 列表）"——"diff"在这里实际只有统计。判定 **P1**：要么 `previewRollback` 复用 `diffText` 补 `hunks`（与 `fileDiffOfPreview` 同口径），要么把文案与文档改成"只给统计"。

另：快照列表里还有一条**一步式**回滚入口（`client.js:2012-2033` `doRollback`，行内 `confirmSnap` 二次点击就发 `confirm:true`），绕过了两步预览。文档 §5 承认"既有入口保持原样"（`docs/PLUGIN-DIFF.md:168-169`），安全上仍要求显式点击，但"两步确认"的承诺只覆盖新入口（P2）。

---

## 4. B 主题（静态检查有效性、令牌一致性、对比度）

### 4.1 静态色值扫描能不能被绕过 —— **能，至少 5 条路（已逐条实测）**

用 `theme.test.mjs` 里**同一组正则**跑样例（`:113,118,123`）：

| 写法 | 现有正则是否命中 | 实测 |
| --- | --- | --- |
| `'#F1F3F5'` / `'#AARRGGBB'` | ✅ 命中 | hex=true |
| **`'#FFF'`（3 位）/ `'#RGBA'`（4 位）** | ❌ **漏** | hex=false（正则 `{6,8}`） |
| `rgb(255 0 0)`（空格语法） | ✅ 命中 | rgb=true |
| `hsl(0 100% 50%)` / `hsla(...)` | ❌ 漏 | rgb=false |
| `Color.Red|White|Black|Gray…`（名单内） | ✅ 命中 | named=true |
| **`Color.Cyan` / `Color.Transparent` / `Color.LightGray`** | ❌ 漏（`\b`+白名单） | named=false |
| **`Color(0xFF0000)`（数值构造器）** | ❌ 漏 | hex=false, named=false |
| **`'#' + 'F1F3F5'`（字符串拼接）/ `` `#${x}` ``** | ❌ 漏 | hex=false |
| `'app.color.x'` 不包在 `$r()` 里 | ✅ 命中（`:608-623` 单独一条） | — |
| `fontSize(16)` 裸数字 | ✅ 命中（`:164`） | — |

`harmony` 树的门闸更弱一层：只数"6 处 `#F…`"并要求每处所在行含 `isDarkTheme()`（`:127-149`）——**行级**正则，同一行里随便哪个位置出现 `isDarkTheme()` 就通过，不校验它是这三个字面量的三元条件。

判定 **M5（P1）**：文档称"硬门闸"（`tools/test/theme.test.mjs:9` 注释、`docs/UI-DESIGN.md` §8 的定位），实际是软约束。建议：hex 正则放宽到 `{3,4,6,8}`、命名色改成 `Color\.[A-Za-z]+` 白名单外全禁、加 `Color(` 数值构造器与 `hsl`/`hsla`、加一条"'#' 后紧随引号/加号"的拼接探测；并把 harmony 那 6 处改成"三点式三元"结构断言。

### 4.2 base / dark 键集与值差异检查 —— **键集严；"同名不同值"没有系统性断言**

- 键集：`31 / 31`，双向差集为空（实跑 `ConvertFrom-Json` 比对；测试 `theme.test.mjs:190-196` 也这么断言）。
- 同名同值的 token（实测 5 个）：`qr_dark=#000000`、`qr_light=#FFFFFF`、`ink_paper=#FFFFFF`、`text_inverse=#FFFFFF`、`preview_background=#000000`。前四个是"内容级/恒定色"，文档 §8 明示合法；`preview_background` 两档都 `#000000` 也是文档写的（深色图片预览底），**但没有测试钉它**（只钉了 `qr_*` 与 `ink_paper`，`:248-260`）。
- **缺的是什么**：没有"除白名单外，同名令牌在浅/深必须不同值"的断言。唯一的值差异断言是 `canvas`（`:240` `assert.notEqual(BASE.canvas, DARK.canvas)`）+ 两条别名同值（`:237-246`）。也就是说，如果有人把 `dark/color.json` 里 `control_fill`/`border`/`divider` 等批量复制成浅色值，**键集测试照过**，只会在个别对比度用例上偶然翻车（`text_primary/canvas` 依赖 canvas 已不同，所以还能抓住一部分）。

### 4.3 对比度公式是否正确 —— **公式正确；阈值是 WCAG 2.0 版，对 8 位通道无实际差异**

`relativeLuminance`（`model/theme.ts:262-272`）：`ratio <= 0.03928 ? ratio/12.92 : ((ratio+0.055)/1.055)^2.4`，权重 `0.2126/0.7152/0.0722` —— 与 WCAG 相对亮度定义一致（2.0 的 `0.03928`；2.1 errata 改 `0.04045`，但 8 位通道只有 `10/255=0.03922` 与 `11/255=0.04314` 落在这附近，两者判定完全相同，**不影响任何结论**）。
`contrastRatio`（`:308-314`）：`(lighter + 0.05) / (darker + 0.05)` —— 正确；`#RGB` / `#RRGGBB` / `#AARRGGBB` 解析齐全（`:275-301`），非法 → 0（最保守）。

实测抽查（用编译产物算）：

| 组合 | 实算 | 文档/测试写的 | 判定 |
| --- | --- | --- | --- |
| `grid_line` 深 / `canvas` 深 | **4.44** | 文档 4.43（阈值版本差异级别的四舍五入） | 一致（≥3 ✔） |
| `danger` 浅 / `canvas` 浅 | **5.44** | 文档 §8.4 写 **5.04** | **文档数值过期**（P2；不影响 ≥4.5 ✔） |
| `selection_stroke` 浅 / `selection_fill` 浅 | 4.88 | 4.88 | 一致 |
| `text_inverse` / `brand` 浅 | 3.91 | 3.91 | 一致 |

**一个方法论坑（P2）**：`parseHexColor` 对 `#AARRGGBB` **丢掉 alpha 当不透明算**（`:296-299`）。本仓库里 `text_secondary`（`#66182431`）、`divider`（`#33182431`）、`border`（`#DDDDDD`）这类半透明令牌若将来被拿去算对比度，会得到**高估**的读数。当前测试只用不透明组合，所以没有假通过；但注释"透明度位忽略（已知边界）"应该升级成测试里的显式约束（禁止对含 alpha 的令牌做对比度断言，或先与底色合成）。

### 4.4 三态落地与"大字号"判定 —— **接线成立**

`themeApply.ets`：`system → COLOR_MODE_NOT_SET`（`:21-30`，不是 LIGHT）、`applyThemeMode` 吞异常返回 boolean（`:38-45`，不吞用户选择，落盘仍在页面侧）、`isSystemDark` 读 `getConfigurationSync().colorMode` 且异常回落浅色（`:55-63`）。测试用源码断言钉住这三点（`theme.test.mjs:580-606`），54 用例全绿。

---

## 5. 测试缺口（P0/P1/P2 表）

| # | 级别 | 缺口（哪个分支没测） | 最坏会怎样 |
| --- | --- | --- | --- |
| 1 | **P0** | **`appendImportPlan` 全函数无自动化测试**（`.ets` 不能在 Node 跑，也没有 host 侧 fake-fs 契约测试）。特别是"第 2 个日期写失败"的 `:484-495` 部分写入分支、`:429-440` 空计划分支、`:498-500` 索引维护分支 | 哪天有人把 `appendTextAtEnd` 改成 TRUNC、或把日期排序改乱、或把 partial 分支的 `ok` 改 true——**没有任何测试会红**；数据是只追加日志，坏了只能人工回滚 |
| 2 | **P0** | **`exportSchedules` 无测试**（`:204-274`）：未 ready / 区间非法 / JSON 分支 / 写入失败分支，以及"不写 `devices/**`、不写 settings"的只读承诺 | 导出误写到同步域（比如有人把 `exports` 目录挪进 `git-repo/`）不会被发现；这是"导出只读"文档承诺的唯一防线 |
| 3 | P1 | **`diffText` 截断"恰好整边界 / 后续 range 被丢"分支**（`diff.ts:252-258`） | 就是 M1：UI 静默少显示差异，用户以为看全了 |
| 4 | P1 | `rollbackPreview` **成功路径的 hunks/内容级预览**（本来就没有该能力，所以也无测试） | 不可撤销动作的确认页只有计数（M4） |
| 5 | P1 | `sanitizeDiagnostic` **base64/JWT/无前缀高熵串**（`aiFallback.ts:430-447`） | 上游回显 OAuth 形态凭据时明文上界面 |
| 6 | P1 | `theme.test.mjs` 静态扫描**自身的负向用例**（没有"这些写法必须被抓住"的自测，`:113-166`） | M5 的漏洞可以长期存在；改正则时也不知道是否还挡得住 |
| 7 | P1 | 客户端 `doRollback` **一步式入口**的 confirm 语义（`client.js:2012-2033`）只测了两步入口 | 有人把行内确认删了/改成默认 true，测试不红 |
| 8 | P2 | `planImport` 与 `date` 扩展字段的**交叉校验**（`exportImport.ts:648-660` 只验合法，不验与 `ts` 同日） | 记录落到 `A.jsonl` 但 `date=B`，后续按 `date` 取数的阅读器会错位 |
| 9 | P2 | `importRecordProblem` 对 `attachments` 里 `sha256`/`entry` 形态的**边界**（复用 `encodeRecord`，但导出导入侧没有专门的坏附件用例） | 附件元数据脏值被写进历史行 |
| 10 | P2 | `decodeUtf8` 的**代理对/4 字节边界**（`exportImport.test.mjs:781-801` 覆盖了 emoji，但没覆盖"4 字节序列被文件末尾截断"） | 截断点产生 `U+FFFD`，随后 JSON 解析失败（fail-closed，影响可接受） |
| 11 | P2 | `readTextFromUri` **单次 `readSync` 短读**（`exportService.ets:300-302`，没有循环读满） | 大文件被截断 → JSON 解析失败；理论上可能截出一个"语法合法但少几条记录"的 JSON（概率极低，同样无测试） |
| 12 | P2 | `normalizeManifest` 的 `scopes` 缺省构造（`preview.ts:194-199`）与 `diffProviders/diffMcp` 的坏 JSON 分支（`:105-113,124-162`）只有间接覆盖 | 远端一个坏 `providers.json` 被当成"全新增"展示 |
| 13 | P2 | `preview_background` 两档同值、`text_secondary`/`divider` 的 alpha 语义无断言（`theme.test.mjs:248-265` 只钉 qr/ink） | 有人把 `preview_background` 改成跟随主题（黑底变白底），意图是好的但没测试表达"这是有意的" |

**最该补的一个测试（P0 优先）**：给 `appendImportPlan` 补一个主机侧契约测试——用 fake `scheduleStore`（注入 `readAll` / `dayFilePath` / `ensureDirs` 与可失败的 `writeText`）+ 记录每次 `openSync` 的 mode/offset，断言：① 绝不出现 `TRUNC`；② 同一天多条只发生一次物理追加；③ 第 2 个日期写失败时 `ok===false` 且 `files` 只含已写文件、且前一日内容完整；④ 已存在的历史行逐字节不变。这条测试同时把 M2（幂等）和 M6（原子性）钉住。

---

## 6. 与 docs 声明的逐条对照（承诺 / 兑现 / 证据）

| 文档承诺 | 兑现 | 证据 |
| --- | --- | --- |
| 导出只读派生、不碰源文件（`docs/EXPORT-IMPORT.md:20`） | ✅ | `exportService.ets:226` 只 `readAll`；写目标 `:116-118,258-260` 在 `exports/` |
| 导入 append-only、历史行一字节不改、不写别的设备（`:22-23`） | ✅ | `exportService.ets:158-175,476`；`scheduleStore.ets:111-127` |
| 同 id 更新只计 conflict、绝不覆盖（`:24-25`） | ✅ | `exportImport.ts:737-745` |
| 任何一条非法 / 解析失败 → 整批不写（`:27`） | ✅（**编码/校验失败**）/ ⚠️ **写入失败会半批**（文档 `:195` 另说，前后措辞张力） | `:442-464` vs `:469-495` |
| `version !== 1` fail-closed（`:173`） | ✅ | `exportImport.ts:811-819` + 测试 `:468` |
| 导出文件不进 Git 仓库（`:299`） | ✅ | 目录在 `filesDir/exports`，不在 `git-repo/` |
| 确认必须用"用户看过的那份计划"（`:282-284`） | ✅（不重解析）／⚠️ 但计划可无限期过期、无幂等复核（M2） | `docs:267` vs `exportService.ets:413-441` |
| 未开 fallback 绝不外发（`docs/AI-FALLBACK.md:37,84-85`） | ✅ | `aiFallback.ts:309-320` + `aiFallbackRunner.ets:199-200,438-441` |
| 未知源 id 不回落默认源（`:57-59,91`） | ✅ | `aiFallback.ts:346-348` + `aiFallbackRunner.ets:324-326` |
| 诊断脱敏、不含凭据、截断 200（`:88-90`） | ⚠️ 部分：`sk-`/`Bearer`/`key=`/`token=` 覆盖，**base64/JWT 未覆盖** | `aiFallback.ts:430-455` |
| 402 归 `abort`（`:28,98-99`） | ❌ **未兑现**（实现与测试都是 `next-source`） | `aiFallback.ts:209-213`；`aiFallback.test.mjs:141-144` |
| 串行、不并发（`:75`） | ✅ | `aiFallbackRunner.ets:434-486`；测试 `:545-549` |
| `diff.ts` 绝不抛、maxLines 超出即 `truncated: true`（`packages/.../docs/PLUGIN-DIFF.md:12,49,52`） | ⚠️ 不抛 ✅；**截断标记有洞**（M1） | `diff.ts:252-258,346` |
| `previewDiff` 四项只读承诺（`PLUGIN-DIFF.md:82-95`） | ✅（远端模式写 git 工作副本，已声明） | `rpc.ts:443-519`；`preview.ts:261-262` |
| `previewDiff` 远端设备不存在 → `E_GIT`（`PLUGIN-DIFF.md:178`） | ❌ 实为 `E_NOT_FOUND` | `rpc.ts:510` |
| `rollbackPreview` 只读、fail-closed 清单（`PLUGIN-DIFF.md:97-133`） | ✅（含 id 形态 / 缺文件 / sha 三类，全在写前抛） | `restore.ts:359-393`；`snapshot.ts:137-154` |
| 第 2 步是"文件级 diff + willRestore"（`PLUGIN-DIFF.md:147`） | ⚠️ 只有统计 + 路径，无 hunk（M4） | `restore.ts:334-343`；`client.js:2960` |
| `rollback` 门禁未放宽（`PLUGIN-DIFF.md:165-167`） | ✅ 四态全拒 | `rpc.ts:426-428`；`restore.ts:84-88`；测试 `rollback-ux.test.mjs:261-274` |
| 空差异显示"没有差异"而不是空白（`PLUGIN-DIFF.md:158`） | ✅ | `client.js:1285,2930-2946` |
| base/dark 键集完全一致、31 个令牌（`docs/UI-DESIGN.md` §8.1） | ✅ 31/31，双向差集空 | 实跑比对 + `theme.test.mjs:190-196` |
| 色值收编是硬门闸（`theme.test.mjs:9` 注释） | ⚠️ 可绕过（M5） | `theme.test.mjs:113-125`；实测 5 条绕过 |
| 深色/浅色对比度数字（`UI-DESIGN.md` §8.4） | ⚠️ `danger` 浅色实为 5.44（文档写 5.04），其余一致 | `theme.ts:262-314` 实算 |
| 纸面/二维码两档恒白（`UI-DESIGN.md` §8.4） | ✅ 并有测试 | `theme.test.mjs:248-260` |

**附注（文件名/路径）**：任务书列的 `docs/PLUGIN-DIFF.md` 在仓库里不存在；实际文件是 `packages/dsh-git-config-sync/docs/PLUGIN-DIFF.md`（192 行，随 `2004237` 提交）。评审按实际路径阅读。

---

## 7. 附：读过的文件与行号范围

| 文件 | 读到的行 | 用途 |
| --- | --- | --- |
| `apps/arkui-schedule/entry/src/main/ets/model/exportImport.ts` | 1-1044（全文） | A 纯逻辑 |
| `apps/arkui-schedule/entry/src/main/ets/services/exportService.ets` | 1-512（全文） | A 落盘 / 只读性 |
| `apps/arkui-schedule/entry/src/main/ets/model/jsonl.ts` | 100-300 | `encodeRecord`/`normalizeRecord`/`recordDateKey` |
| `apps/arkui-schedule/entry/src/main/ets/services/scheduleStore.ets` | 88-207 | `readAll` / `dayFilePath` / 设备根 |
| `apps/arkui-schedule/entry/src/main/ets/services/openIndexStore.ets` | 147-205（grep + 上下文） | `applyRecord` 是否抛 |
| `apps/arkui-schedule/tools/test/exportImport.test.mjs` | 测试名清单（107-899） | 覆盖判定 |
| `docs/EXPORT-IMPORT.md` | 1-321（全文） | A 契约对照 |
| `apps/arkui-schedule/entry/src/main/ets/model/aiFallback.ts` | 1-541（全文） | C 决策/脱敏/规划 |
| `apps/arkui-schedule/entry/src/main/ets/services/aiFallbackRunner.ets` | 1-516（全文） | C 运行器/隐私 |
| `apps/arkui-schedule/tools/test/aiFallback.test.mjs` | 1-615（全文） | C 覆盖判定 |
| `docs/AI-FALLBACK.md` | 1-147（全文） | C 契约对照 |
| `packages/dsh-git-config-sync/src/engine/diff.ts` | 1-465（全文） | D diff |
| `packages/dsh-git-config-sync/src/engine/preview.ts` | 1-420（全文） | D `fileDiffOfPreview` / 只读 |
| `packages/dsh-git-config-sync/src/engine/restore.ts` | 1-394（全文） | D 门禁 / 回滚 / `previewRollback` |
| `packages/dsh-git-config-sync/src/rpc.ts` | 380-539（+ grep 全量） | D action 门禁与只读 |
| `packages/dsh-git-config-sync/src/engine/snapshot.ts` | 100-193 | `get`（校验/只读）/ `prune` |
| `packages/dsh-git-config-sync/src/client.js` | 1270-1369、2860-3004（+ grep 全量） | D 状态机 / FileDiffList / 回滚预览渲染 |
| `packages/dsh-git-config-sync/test/diff.test.mjs` | 1-221（全文） | D 覆盖判定 |
| `packages/dsh-git-config-sync/test/rollback-ux.test.mjs` | 测试名清单（46-705） | D 覆盖判定 |
| `packages/dsh-git-config-sync/docs/PLUGIN-DIFF.md` | 1-192（全文） | D 契约对照 |
| `apps/arkui-schedule/entry/src/main/ets/model/theme.ts` | 1-497（全文） | B 模型 |
| `apps/arkui-schedule/entry/src/main/ets/common/themeApply.ets` | 1-79（全文） | B 落地 |
| `apps/arkui-schedule/tools/test/theme.test.mjs` | 1-624（全文） | B 静态门闸 |
| `apps/arkui-schedule/entry/src/main/resources/{base,dark}/element/color.json` | 全量键值比对（脚本） | B 令牌一致性 |
| `docs/UI-DESIGN.md` | §8 全节 | B 契约对照 |

**实跑命令（只读性质，全部在仓库内）**：`node --test tools\test\theme.test.mjs`（54 pass）、`node --test tools\test\exportImport.test.mjs`（56 pass）、`node --test tools\test\aiFallback.test.mjs`（60 pass）、`node --test test\diff.test.mjs`（10 pass）、`node --test test\rollback-ux.test.mjs`（11 pass）；另用 `node -` 对 `dist/engine/diff.js` 与 `.build/model/theme.js` 做了两组只读探针（截断标记、正则命中、对比度数值），未写任何文件。

**未覆盖（明确声明）**：真机渲染与 ×1.5 实机排版（任务书禁止上真机）、`build-harmony`（禁止）、ArkTS 编译期类型检查（`tsc -p tools/tsconfig.json` 未跑，.ets 部分只做了源码阅读 + 既有测试的源码级断言）、`apps/arkui-schedule/entry/src/main/ets/components/ExportImportPanel.ets` 与 `components/AiFallbackPanel.ets` 本体（不在本轮评审对象清单内，仅通过测试中的源码断言间接确认回调名与"同样的内容"告知文案）。
