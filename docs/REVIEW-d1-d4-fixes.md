# D1–D4 修法复核

> 独立复核（只读）：未改任何代码、未跑 hvigor、未 commit。
> 仓库：`dsh-sync-suite`，App：`apps/arkui-schedule`。复核时间：2026-11-16。
> 结论标注：**实测** = 有命令输出支撑；**推断** = 只能读代码，无运行证据（`.ets` 无法在本机编译/真机验证）。

## 裁决

| 缺陷 | 裁决 | 一句话理由 |
|---|---|---|
| D1 正文重复 | **通过但有风险** | 遮罩已无条件化（`objectsToMask` 无分支）+ 正文单分支回退，重复源已消除；但表格区域现在完全不进页 OCR，逐格失败时正文只剩占位符（原图在 zip，正文/AI/搜索看不到），且全批共享 60s 预算让大表几乎必然失败。 |
| D2 空壳表 | **通过但有风险** | `cells.length !== rows*cols → tableFailed` 守卫存在且早于 `tableToMarkdown`；但「格子数正确、识别结果全空」仍产出 `ok=true` 的空壳表（实测 61 字符）并顶掉占位符，属于同一缺陷的未封口路径。 |
| D3 `ocrEnabled` 丢失 | **通过** | 三处（`copyExtras` / `parsePageList` / `cleanObject`）都补齐，实测 move/resize/serialize/parse 全程 `false` 不丢。唯一遗留：无回归测试覆盖。 |
| D4 超时释放竞态 | **通过但有风险** | `finally` 覆盖 `run()` 所有出口、不会泄漏；但 `drainDeferred()` 无任何宽限期，而表格 OCR 是 `run()` 的最后一步 ⇒ 最后一批超时格仍在「超时后立刻释放」，尾部竞态未消除。 |

## D1 正文重复（含「表格内容丢失」风险评估）

**修法核对：成立（实测 + 读码）**

- `entry/src/main/ets/model/tableOcr.ts:166-176` —— 无分支，所有对象进遮罩：
  ```ts
  export function objectsToMask(objects: PageObject[]): NormalizedRect[] {
    const rects: NormalizedRect[] = [];
    for (const obj of objects ?? []) {
      // D1（reviewer 阻塞缺陷）：**表格永远进遮罩**，与是否开启逐格识别无关。
      rects.push({ x: obj.x, y: obj.y, w: obj.w, h: obj.h });   // 173
    }
    return rects;
  }
  ```
- 接线：`entry/src/harmony/ets/pages/Handwriting.ets:524-536`（`mergeObjectMasks` → `objectsToMask`，529）→ `1104-1112`（`pageRegions: maskRegions`、`tableTasks: this.collectTableTasks(ids)`）。页级 OCR 因此看不到表格区域，重复源消失。
- 正文单分支：`Handwriting.ets:544-567`，表格走 `markdowns.get(object.id)`，取不到就 `this.placeholderOf(...)`（555-560）；`markdownMap` 只收 `ok && length>0`（607-615）。
- 单元格文字来源正确：`OcrBatchManager.ets:265-359` 从 `attachments-src/<sha>.jpg`（阶段 A 落盘的**原图**，`pageCapture.ts:280-283` 阶段 A 全部落盘后才进阶段 B 填白；`350` 注释「附件里的 N 页是原始截图，不丢框内内容」）裁剪，不依赖页 OCR。
- 测试：`node --test .../tableOcr.test.mjs` 中 `objectsToMask：D1 修复后，开启识别的表格**也**要填白` 通过（共 72 pass）。

**「表格内容丢失」风险评估：真实存在，分三档**

| 场景 | 正文 | zip 原图 | 判定 |
|---|---|---|---|
| 逐格 OCR 成功 | Markdown 表格 | 有 | 正常（且不再重复） |
| `ocrEnabled=false`（用户手动关 / >6×6 强制关） | `[表格 R×C: 见附件 · 第N页]` | 有 | 可接受（用户主动选择，且有 toast `Handwriting.ets:704`） |
| 逐格 OCR 失败（超时 / 读图失败 / 格子数异常 / 取消） | 只有占位符 | 有 | **正文层面丢内容**：手写内容在正文/AI 汇总/搜索里都读不到，只剩「见附件」指针 |

- 不是「彻底丢数据」（原图必经 `pageCapture` 阶段 A 落盘，`pageCapture.ts:280-283`），但**是正文可读性的回归**：修复前页 OCR 至少把表格手写读成散文（虽然重复）。
- **失败概率不低（推断，依据代码常量）**：`TABLE_OCR_TIMEOUT_MS = 60000` 是**整批共享**的一个 deadline（`OcrBatchManager.ets:270` 在 task 循环外只算一次），而预算是 5s/格、≤36 格/表、可多表。6×6 一张表就要 36 次 `recognizeText`；再叠加第二张表，后段的表几乎必然触发 `Date.now() > deadline`（310-313）→ `failed` 过半 → `tableFailed` → 正文只剩占位符。这不是极端场景，是 ≥2 张表或大表的常规路径。
- 另有一条**成功路径也救不回**的损失：`cellRegions` 只覆盖表格矩形内部（`tableOcr.ts:53-90`），压在表格边框外/格线外的批注既不在单元格里、又被整块遮罩挖掉 ⇒ 两处都读不到（量小，但属确定丢失）。

**更好的兜底（建议，成本低）**：`runTableOcr` 里失败分支已经持有 `bytes`（该页原图）和 `task.rect`，可再做**一次整块识别**并作为纯文本兜底：
1. `TableOcrResult` 增加 `fallbackText: string`（失败时非空）；
2. 失败分支：`decodePixel(bytes)` → `crop(task.rect 在像素坐标下的矩形)` → `recognize` 一次（5s 超时即可，不进 60s 预算或单列预算）；
3. `composeBodyWithObjects`：`markdown ?? fallbackText + '\n' + placeholderOf()`，即「表格原文（整块，不分格）+ 见附件指针」——不重新引入「两份」，因为页 OCR 已被遮罩挖掉，整块 OCR 是这一块**唯一**的文本来源；顺带把「格线外批注」也捞回来。
4. 若不想动接口：至少把 `TABLE_OCR_TIMEOUT_MS` 改为**每表独立预算**（`deadline` 移进 for 循环），让第 2 张表不再被第 1 张吃掉预算；并在 `finish()` 的失败 toast 里用 `reason`（见下）。

**过时注释（会造成后续误改）**：`tableOcr.ts:160-165`（「table 仅在关闭逐格识别…时填白」）、`tableOcr.ts:1-6`（「表格默认开启识别 → 不填白」）、`Handwriting.ets:519-523`（「表格逐格 OCR 打开后，表格区域会自动从遮罩里消失」）都与现在的实现相反。

## D2 空壳表

**修法核对：部分成立（实测 + 读码）**

- 守卫存在：`OcrBatchManager.ets:329-335`
  ```ts
  // D2（reviewer 阻塞缺陷）：格子数必须 = rows*cols，否则是空壳表
  if (cells.length !== task.rows * task.cols) {
    results.push(this.tableFailed(task, cells.length, '表格格子数异常：已保留原图'));
    continue;
  }
  ```
- 位置早于 `tableToMarkdown(matrix)`（339-347 组矩阵，352 拼 Markdown）：`handwritingToolbar.test.mjs:822-834` 的源码级断言通过。
- 实测退化输入：`cellRegions({x:0.1,y:0.1,w:0,h:0.2}, 1000, 1600, 3, 3)` → `[]`（0 ≠ 9）⇒ 走 `tableFailed`，不再产出空壳。原缺陷路径确实封住了。

**残留洞（未封口）**：格子数正确但**所有格子识别为空串**时，`failed` 计数不增加（`recognizeCell` 返回 `''` 算成功，315-320），`failed > floor(9/2)` 为假 → 组装全空矩阵 → `tableToMarkdown` 返回非空字符串 → `ok=true`。实测：
```
allEmptyMarkdown= "|   |   |   |\n| --- | --- | --- |\n|   |   |   |\n|   |   |   |"  len= 61
```
`markdown.length > 0` 于是进 `markdownMap`（`Handwriting.ets:607-615`），把「见附件」占位符顶掉。**在 D1 之后这条更危险**：页 OCR 已被遮罩挖掉，表格内容在正文里既不是 Markdown（空的）也不是占位符（被替换）——用户只看到一张空表。触发场景现实存在：画了表格网格但格内没字（如自制日历/打卡格），或识别对格内字返回空。

**其他**：`tableFailed(task, cells.length, ...)` 把 `cells.length` 当 `failedCells` 传（语义混用，无功能影响）；守卫在逐格循环之后（306-327），当前 `cellRegions` 只会返回「恰好 rows×cols」或 `[]`，所以没有浪费识别，但建议前移到循环之前，防未来 `cellRegions` 改成部分返回时白跑 36 格。

## D3 `ocrEnabled` 丢失

**修法核对：成立（实测）**

- `entry/src/main/ets/model/pageObjects.ts:626-628`（`copyExtras`）：
  ```ts
  // D3（reviewer 阻塞缺陷）：`ocrEnabled` 必须跟着对象走
  if (source.ocrEnabled !== undefined) { target.ocrEnabled = source.ocrEnabled; }
  ```
- `pageObjects.ts:300-321`（`parsePageList`）转发：`ocrEnabled: raw.ocrEnabled`（316）。
- `pageObjects.ts:242-265`（`cleanObject`）保留：`item.ocrEnabled = object.ocrEnabled !== false && item.rows * item.cols <= 36;`（263）——`false` 存盘仍为 `false`，>36 仍强制 `false`，与 `makePageObject:127-131`、`tableOcrEnabled:179-190` 规则一致。
- 实测（`.build` 为 src 的转译副本，mtime 21:27 晚于 src 21:19，且被 `.gitignore` 忽略、每次测试前重建）：
  ```
  orig= false move= false resize= false
  serialized= {"version":2,"pages":{"p1":[{"id":"t1","kind":"table","x":0.1,"y":0.2,"w":0.5,"h":0.3,"rows":3,"cols":2,"ocrEnabled":false}]}}
  roundTrip= false legacyV1= false
  default= true serializedDefault= {"version":2,"pages":{"p1":[{"id":"t2",...,"ocrEnabled":true}]}}
  ```
  ⇒ 拖动、缩放、存 JSONL、v2 回读、v1 迁移五条路径都不再丢 `false`。
- **遗留**：`tools/test/pageObjects.test.mjs` 里**没有任何 `ocrEnabled` 断言**（本次 +84 行全是选图/扩展名相关）。D3 的修复目前只有我这条临时命令的证据，没有回归测试；`toggleTableOcr`（`Handwriting.ets:732-751`）也只有源码字符串断言。
- 顺带（非 D3）：`pageObjects.ts` 本次被加了 UTF-8 BOM（`EF BB BF`，同目录 25 个 .ts 里只有 `types.ts` 本来有），疑似编辑器保存副作用。

## D4 超时释放竞态（含泄漏路径分析）

**修法核对：成立但有残留竞态（读码；`.ets` 无法在本机运行 ⇒ 行为结论为推断）**

- `OcrBatchManager.ets:369-395`（`recognizeCell`）：
  ```ts
  } catch (error) {
    timedOut = pixel !== null;      // 383：只要解码后出任何错就置位
    return null;
  } finally {
    if (pixel !== null) {
      if (timedOut) { this.deferredReleases.push(pixel); }   // 389
      else { this.releasePixelMap(pixel); }                  // 391
    }
  }
  ```
- `398-403 drainDeferred()`；`run()` 的 `finally`（229-246）在释放 packer、`textRecognition.release()` 之后调用 `drainDeferred()`（244）。

**泄漏路径分析（逐出口）**

| 出口 | 是否泄漏 | 依据 |
|---|---|---|
| `run()` 正常 `return result` | 否 | `finally` 必执行（244） |
| `run()` 中途抛异常（截图/落盘/识别/`runTableOcr` 内未捕获错误） | 否 | 同一个 `finally` |
| `run()` 早退：`total===0`（172-174）、`running` 重入（175-177） | 否 | 两处都在 `try` 之前，且此时 `deferredReleases` 必为空（重入时上一批自己的 `finally` 会 drain，不会有第二批并发——`running` 是实例级互斥） |
| `cancel()` 取消 | 否 | 只置标志（161-163），`runTableOcr` 在下个检查点 continue，最终仍经 `finally` |
| 单格失败（超时 / crop 失败 / recognize reject） | **不泄漏** | 解码后任何异常都 `timedOut=true` ⇒ 进 `deferredReleases`（383/387-389）；「单格失败路径是否也进 deferredReleases」答案是**是**（不只是超时） |
| 进程被杀 / 页面销毁时 `run()` 从未 resolve | 否（但实例级持有） | 依赖 GC/进程退出，非代码可控 |

**残留风险 1（真问题，尾部竞态）**：`drainDeferred()` 没有任何宽限期，而 `runTableOcr` 是 `run()` 的**最后一步**（227 → `return result` → `finally`）；表格任务的最后一格超时时，「超时 → 入 deferred → 立刻 drain」之间的间隔约等于 0，与修复前「超时后立即 release」在时间上等价 ⇒ **D4 只把竞态窗口从「每次都发生」缩小到「每批最后一次超时发生」，没有消除**。非尾部格子能拿到后续表/后续格的处理时间作为宽限，也只是「顺带」的，不是设计。
建议：把待等待的识别 promise 收进 `pendingRecognitions: Promise<string>[]`，`finally` 里先 `await Promise.race([Promise.allSettled(pending), sleep(5000)])`，再 `drainDeferred()`；最坏情况退化为「晚释放（安全）」，而不是「早释放（崩溃）」。
**残留风险 2（命名与日志）**：`timedOut` 现在含义是「解码后任何异常」，并非只有超时（383 行），日志/超时原因无法区分（`finish()` 更是把它们统一 toast 成「表格识别超时，已保留原图」，`Handwriting.ets:1145-1147`）。行为是安全的（偏向延迟释放），但会掩盖真实故障（例如 crop 参数错误也表现为「超时」）。
**残留风险 3（内存）**：延后释放的是**已 crop 的小图**（`crop` 在 `recognize` 之前，379-380），最坏累计 ≤36 格 × 表数 张，单张为单元格尺寸，风险低（推断）。若 `crop` 本身抛错，那一张仍是整页解码图，属个别情况。
**测试覆盖**：D2/D4 只有源码字符串断言（`handwritingToolbar.test.mjs:819-847`），不是行为测试；`.ets` 在本机无法执行，`OcrBatchManager` 的任何运行时行为**没有实测证据**（本次实测仅覆盖 `.build/model/*` 的纯逻辑）。

## 只读验证命令（真实输出）

```
$ node --test apps/arkui-schedule/tools/test/tableOcr.test.mjs apps/arkui-schedule/tools/test/pageObjects.test.mjs
  ✔ objectsToMask：D1 修复后，开启识别的表格**也**要填白（防正文重复），图片与框同样填白
  ✔ objectsToMask：关闭识别（ocrEnabled=false）的表格仍要填白
  ✔ makePageObject：表格默认开启识别，>6×6 强制关闭
  …
ℹ tests 72
ℹ suites 14
ℹ pass 72
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ duration_ms 112.3214

$ node apps/arkui-schedule/tools/validate-app.mjs
🔍 校验 ArkUI-X 工程：C:\Users\GWL\Desktop\itwillclaude\dsh-sync-suite\apps\arkui-schedule
✅ 全部通过：8/8 条规则（JSON5/JSON 57 个、相对 import 184 条、main 静态 import 223 条、页面 4 个、rawfile/git 2 个文件）
```

补充一项（同一批回归，非任务要求）：
```
$ node --test apps/arkui-schedule/tools/test/handwritingToolbar.test.mjs
  ✔ D2：cellRegions 数量 != rows*cols 时直接 failed（不产出空壳 Markdown）
  ✔ D4：超时/失败分支不直接 release（改由 deferredReleases 收尾释放）
ℹ tests 51 / pass 51 / fail 0
```

## 必须修（阻塞）

1. **D2 残留：全空识别结果仍产出 `ok=true` 的空壳表**（`OcrBatchManager.ets:336-355`）。
   加一条：矩阵所有文本 `trim()` 后为空 ⇒ `tableFailed(task, cells.length, '表格未识别到文字：已保留原图')`。
   理由：D1 之后页 OCR 不再兜底，空壳表会把「见附件」指针一起顶掉，正文既无内容也无指针。（实测 `tableToMarkdown(全空)` 返回 61 字符非空串。）
2. **D1 副作用：逐格失败后正文零内容 + 整批共享 60s 预算**（`OcrBatchManager.ets:227/270/310-313/336-338`）。
   最低限度二选一：①（推荐）失败时用已读入的 `bytes` + `task.rect` 做**一次整块 OCR**，正文写「整块文本 + 占位符」；②把 `deadline` 移进 per-task 循环（每表独立 60s），让「多表」不再互相吃预算。
   理由：≥2 张表或 6×6 大表时失败是常规路径，当前会把用户手写的表格内容从正文里整块抹掉（仅剩指针，AI 汇总/搜索都读不到）。
3. **D4 尾部竞态：`drainDeferred()` 无宽限**（`OcrBatchManager.ets:229-246`，表格 OCR 是 `run()` 最后一步）。
   收尾前先等待在飞的识别 promise（`Promise.allSettled` + 5s `race` 上限）再释放；宁晚勿早。
   理由：最后一格超时时，释放与超时几乎同时发生，`use-after-release` 崩溃风险仍在；这不是「更干净」的问题，是 D4 原缺陷的残余。

## 建议修

1. `recognizeCell` 的 `timedOut` 改名/拆分（`timedOut` vs `failedAfterDecode`），日志区分「超时 / crop 失败 / 识别异常」（`OcrBatchManager.ets:371-394`）。
2. `finish()` 的失败 toast 用 `TableOcrResult.reason`，现在硬编码「表格识别超时，已保留原图」，会把「格子数异常 / 页面截图缺失 / 已取消」都说成超时（`Handwriting.ets:1145-1147`）。
3. D2 守卫前移到逐格循环之前（`OcrBatchManager.ets:306` 之前），防御未来 `cellRegions` 变更带来的无效识别。
4. 修三处与实现相反的注释：`tableOcr.ts:1-6`、`tableOcr.ts:160-165`、`Handwriting.ets:519-523`。
5. 补 D3 回归测试：`pageObjects.test.mjs` 增加「`ocrEnabled:false` 经 move/resize/serialize/parse 仍为 false」与「>36 格强制 false」两条断言（当前零覆盖）。
6. `pageObjects.ts` 去掉新加的 UTF-8 BOM（同目录仅 `types.ts` 有 BOM），避免 diff 噪音与工具链差异。
7. `shouldOcrObject`（`tableOcr.ts:192-195`）目前只有测试在用，主代码无引用；要么接进 `collectTableTasks` 的白名单判断，要么删掉，避免「以为它生效」。
8. `tableFailed(task, cells.length, ...)` 的 `failedCells` 语义混用（传的是格子总数），建议改成 `0` 或专用字段（`OcrBatchManager.ets:330-334`）。
