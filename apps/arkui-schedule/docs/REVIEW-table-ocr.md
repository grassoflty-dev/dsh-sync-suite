# 表格逐格 OCR 评审

> 评审对象：`entry/src/main/ets/model/tableOcr.ts`（新增纯逻辑）、`entry/src/main/ets/model/pageObjects.ts`（`ocrEnabled` 相关）、`tools/test/tableOcr.test.mjs`
> 参考调用方：`entry/src/harmony/ets/pages/Handwriting.ets`（评审期间**正在被并发修改**：首读 2428 行、再读 2485 行，故下文对它的引用同时给函数名，行号仅作近似）
> 验证手段（只读）：`node --test apps/arkui-schedule/tools/test/tableOcr.test.mjs`（13/13 通过）、`node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json`（exit 0）、另用临时脚本（仓库外 `%TEMP%`）对纯逻辑做随机/边界探测。
> 证据分级：**[实测]** = 本次跑出来的具体数值/字符串；**[推断]** = 代码或规范推演，未实机验证。

---

## 结论（一句话 + 是否阻塞）

一句话：**几何切分算法本身在正常尺寸下是精确无缝的（2 万组随机、整数页像素、正常表格尺寸：覆盖误差 0 / 重叠 0 / 越界 0），但"归一化→像素"的单位与原点契约没有任何约束和守卫、`ocrEnabled` 会在两条路径上静默丢失、`\|` 转义顺序会让表格列数断裂、以及"开启识别"时表格仍会进整页 OCR 造成正文重复**——这些都不是边角，是接线阶段必然踩到并直接表现为"错位 / 重复 / 丢内容"。

**是否阻塞：是（阻塞发布）**。共 6 条必须修，其中 1、2 是纯逻辑层已可复现的一行级 bug，3 是接线必踩的契约陷阱，5 需要产品口径拍板（当前设计自相矛盾）。

---

## 必须修（阻塞发布）

### 1. `[pageObjects.ts:300-320 parsePageList（缺字段的调用在 310-317）]` 持久化往返把用户的"关闭"丢成"开启"

`parsePageList` 调 `makePageObject(id, kind, raw, { sha256, name, rows, cols })` 时**没有转发 `raw.ocrEnabled`**，而 `makePageObject`（`pageObjects.ts:123-131`）对缺省值一律给 `true`。

- **实测**：`makePageObject(..., {rows:3, cols:2, ocrEnabled:false})` → `ocrEnabled=false`；`serializePageObjects` 写出 `"ocrEnabled":false`（cleanObject 这一端是对的）；经 `parsePageObjectsDoc` 读回 → **`ocrEnabled=true`、`tableOcrEnabled()=true`**。
- 另注：当前 `Handwriting.ets:921` 处的批次调用把 `mergeObjectMasks(...)`（`518-530`）的结果当 `pageRegions` 传入，即遮罩集合完全由 `objectsToMask` 决定，所以第 5 条的问题在这条链路上是必然发生的。
- **影响**：用户手动关掉某张表的逐格识别 → 存草稿/存记录 → 重开 → 该表**重新变成逐格识别且不再整块填白**。轻则这张表在正文里被识别两遍（见第 5 条），重则该表内容以手写散字形式混进正文、Markdown 表结构丢失。属于"内容丢失/错位"的直接成因。
- **建议改法**：`parsePageList` 里补 `ocrEnabled: raw.ocrEnabled`（`makePageObject` 的三态逻辑已经能正确处理 `undefined/true/false`），并为它加单测（见测试盲区 1）。

### 2. `[pageObjects.ts:612-625 copyExtras]` 拖一下 / 缩放一下，`ocrEnabled` 就消失

`moveObject`（573-589）与 `resizeObject`（592-609）都靠 `copyExtras` 复制附加字段，而 `copyExtras` 只处理 `sha256/name/rows/cols`，**漏了 `ocrEnabled`**。

- **实测**：`ocrEnabled=false` 的表格对象，`moveObject(o, .2, .2)` 后 `ocrEnabled=undefined`、`tableOcrEnabled()=true`；`resizeObject` 同样。
- **影响**：用户在界面上挪动/缩放表格（最常见的操作）后，"关闭识别"设置被静默丢弃；而 `cleanObject` 只有在字段**存在且为 false** 时才保留 false，所以一旦被拖动过，存盘还会写成 `true`，彻底不可恢复。
- **建议改法**：`copyExtras` 的 table 分支加 `if (source.ocrEnabled !== undefined) { target.ocrEnabled = source.ocrEnabled; }`（保持三态：缺省仍缺省，由 `makePageObject`/`cleanObject` 决定默认）。加单测（测试盲区 2）。

### 3. `[tableOcr.ts:44-48, 53-64]` 单位与原点契约只写在注释里，且注释写错了（"相对整页"）

现状：`cellRegions` 的文档写 `@param rect 表格对象的归一化矩形（0..1，相对整页）`，`@param pageW 截图像素宽`。真实情况是：

- 页面对象坐标的参照系是**对象层画布**，不是整页：`Handwriting.ets` 的 `objectLeft()/objectTop()`（当前 1696-1712 行）在横屏是 `RAIL_WIDTH+DIVIDER = 73vp`、竖屏 `TOP_BAR_HEIGHT+DIVIDER = 49vp`（`TOP_BAR_HEIGHT=48`、`RAIL_WIDTH=72`，见 89/96 行），`toNormalized()` 用 `objectW/objectH`（1727 行）做除法。
- 截图目标也是这块画布：`HandwritingPager.ets:1129` 的 `hw-page-<pageId>` Canvas 是 pager 的 `100%×100%`，pager 实例位于 rail 右侧 / 顶栏下方（`Handwriting.ets:2431-2442`）。所以**位图 ≈ 画布区域，两者原点一致，不需要额外偏移**——前提是 `pageW/pageH` 传的是**这张位图自己的像素尺寸**。
- 三种误用都在代码里"顺手可得"，且后果都很重：

| 误用 | 实测后果（landscape 1280×800vp @3x，画布 3621×2400px，rect=0.2/0.2/0.6/0.4，3×3） |
|---|---|
| 传 **vp**（如 `pagerState.canvasW=1207`、`context.width`） | 每格只有正确值的 1/3，覆盖到 `0.333` → **只读到表格左上角约三分之一**（3 列时≈1 列、6 列时≈1.8 列），其余全部丢失 |
| 传**窗口像素**（3840×2400，例如按"整页 1600×2560"思路取屏幕尺寸） | 表格左端偏移 `+44px`、右端偏移 `+175px`（≈0.24 格，格宽 724→768px），**跨格串字** |
| 换成**整窗截图**（把 rail/顶栏也截进来） | 再叠加常量偏移 `(73vp,49vp)=(219px,147px)`@3x，对 h=0.3 的 4 行表（180px/行）≈ **整整错开 0.8 行** |

- **补充陷阱 [推断]**：`OcrBatchManager.capturePage` 会先 `shrinkToMaxSide(pixelMap)`（最长边压到 ≤1440px，见 `OcrBatchManager.ets:258-272`）**再**送 OCR。裁剪必须与 OCR 用同一张位图，且 `pageW/pageH` 必须是 **scale 之后** `getImageInfo()` 的值；若用 scale 前的尺寸去裁 scale 后的图，误差比例 1440/2560=0.5625，直接飞掉。`PixelMap.crop` 的 `Region` 还需整数，vp/px 混合还可能出现小数坐标。
- **建议改法**：
  1. 参数与文档改成"位图像素"口径：`cellRegions(rect, bitmapW: number, bitmapH: number, rows, cols)`，类注释明确写"`rect` 与 `bitmap` 同一坐标系（画布区域，不含 rail / 顶栏 / 状态栏）；传入的必须是**同一张 PixelMap** 的 `getImageInfo()` 尺寸，且缩放之后读取"。
  2. **偏移由调用方负责，纯逻辑层不许猜**：`Handwriting.ets` 持有 `objectLeft/objectTop` 与密度，若将来改成整窗截图，应由它把 rect 换算成整窗归一化（`x' = (objectLeft + x*objectW)/pageW`）后再调用；纯逻辑层只接受"同一坐标系内的 rect + 该坐标系像素尺寸"。建议保留一个显式的 `cellRegionsIn(rect, canvas: {w,h}, origin: {x,y}, rows, cols)` 变体，避免这类换算散落在 `.ets` 里。
  3. 加低成本守卫（能挡住 vp/px 现场事故）：`if (width / cols < 2 || height / rows < 2) return [];`（与建议修 1 合并），以及 `if (!Number.isInteger(pageW) || !Number.isInteger(pageH)) return [];`。

### 4. `[tableOcr.ts:144-147 normalizeCell]` 先转义 `|`、不转义 `\`，`a\|b` 会撑破表格

`normalizeCell` 只做 `replace(/\|/g,'\\|')`，没有先把已有反斜杠加倍。

- **实测**：单元格文本 `a\|b`（字面：`a`、`\`、`|`、`b`）→ 输出 `a\\|b`。
- **影响 [推断，依 GFM 规范]**：`\\` 被解析成"转义的反斜杠"，其后的 `|` **仍是单元格分隔符** → 该行多出一格、与表头/分隔行列数不一致 → 表格断裂或后半段被静默丢弃。用户即使没有手写反斜杠，OCR 也可能把"/"、"1"识别成 `\`，属于可达路径。
- **建议改法**：顺序反过来——先 `replace(/\\/g, '\\\\')`，再 `replace(/\|/g, '\\|')`；顺带把 `\t`、`\u00a0`（NBSP）也折成普通空格，避免"看着空但不是空格"的格子。期望语义写进测试（测试盲区 3）。

### 5. `[tableOcr.ts:166-178 objectsToMask]` + `[Handwriting.ets:mergeObjectMasks / placeholderOf]` 开启识别时表格内容会重复出现（设计自相矛盾）

`objectsToMask` 在表格开启识别时**不返回**该表矩形（测试 `tableOcr.test.mjs:98-105` 正是断言"只遮 box+image"），于是：

- 整页 OCR 的输入图里**表格还在**（遮罩是唯一把它从 OCR 里摘掉的手段），`textRecognition` 会把格子里的手写字当正文读出来；
- 同时 `composeBodyWithObjects`（`Handwriting.ets:538-555`）又按对象追加占位符（`placeholderOf` 目前对表格**无条件**返回 `tablePlaceholder`，`Handwriting.ets:557-565`；该文件正在并发修改，行号以函数名为准），接线后还会再追加一段 Markdown 表。
- **结果**：同一张表在正文里出现 2~3 份（散文副本 + 占位符 + Markdown 表），且散文副本无法与其它正文区分。这既是"内容重复"也是"内容错位"（散文副本会插在正文中间，Markdown 表却被追加到页末）。
- **建议改法（二选一，需产品拍板）**：
  - **(a) 推荐**：表格**永远填白**（`objectsToMask` 的 table 分支改为无条件返回矩形），逐格裁剪从**阶段 A 的原始截图 PixelMap** 取。原文已落盘（`pageCapture.ts:236-278`），技术上完全可行；需要把"原图 PixelMap"留到阶段 B 之后再用（现在有框的页会在 `pageCapture.ts:323` 提前释放原图，`OcrBatchManager` 需要多留一份或先裁后放）。
  - (b) 不填白，但要从该页 OCR 文本里剔除表格区域文本。手写表没有 `|`，`replaceComplexBlocks`（`attachments.ts:304-324`）的管道符规则**兜不住**，只能靠几何/文本匹配，可靠性差，不建议。
- 无论选哪条，`placeholderOf` 都要按 `tableOcrEnabled(obj)` 分支：开启时写 Markdown 表、关闭/超限时写 `tablePlaceholder`；两者**不能同时**写。

### 6. `[tableOcr.ts:13-15]` 超时与"失败过半回退占位符"的策略完全没有落地（常数是死的）

`TABLE_CELL_TIMEOUT_MS` / `TABLE_OCR_TIMEOUT_MS` 全仓库**无任何引用**（实测 grep），也没有任何函数负责"把扁平 OCR 结果按 cols 分块 → 统计失败格数 → 决定出 Markdown 还是回退占位符"。这类"部分失败"必然发生（空格、斜向字迹、裁剪偏移都会让个别格返回空串）。

- **影响**：策略散落到 ArkTS 侧各写一遍，不可测；最坏情况是 36 格全失败仍拼出一张全空的 `|   |   |` 空壳表写进正文（实测 `tableToMarkdown([['',''],['','']])` 就返回空壳表而非空串），等于**把表格内容整体丢掉还占位**。
- **建议改法**：在纯逻辑层补 `assembleTableOcr(flat: string[], rows, cols, failedCount)` 或 `shouldFallbackToPlaceholder(failed, total)`（`failed*2 > total` → true），超时用注入的 clock 测；`tableToMarkdown` 增加"全部单元格为空 → 返回 ''"，让调用方统一回退占位符。

---

## 建议修（非阻塞）

1. **`[tableOcr.ts:79-80]` `Math.max(1, x2-x1)` 会在格宽 <1px 时制造重叠。** [实测] 442px 宽、6 列的窄表（格宽仅 4px）：36 格中 11 格越出 box、出现重叠对，Σ面积比 box 多 914px²；随机 2 万例里 117 例违规，**全部是这种退化情形**（表宽/列数 < ~1.5px）。正常表格零违规。建议：先判 `width/cols >= 2 && height/rows >= 2`，否则直接返回 `[]`（回退占位符），而不是产出重叠的 1px 格。顺带这一条也能挡住第 3 条的 vp/px 事故。
2. **`[tableOcr.ts:61-64]` 取整口径与既有代码不一致。** 这里用 `Math.round`，`regions.ts:143-146 regionsToMaskRects` 用 `Math.floor`；同一矩形两条路径最多差 1px，且 round 会让裁剪向外多探 0.5px（可能带进表格外一像素的字迹）。建议统一成 floor（或统一 round）并注明理由。
3. **`[tableOcr.ts:181-192]` "缺 rows/cols" 与 "新对象" 口径不一致。** [实测] 手写形状的 `{kind:'table'}`（无 rows/cols）→ `tableOcrEnabled` 返回 `false`（于是被整块填白），而 `makePageObject` 同形状默认 3×3 且开启。建议 `tableOcrEnabled` 内部用 `clampTableLines` 的默认值再判断，与 `makePageObject`/`cleanObject` 对齐。
4. **`[tableOcr.ts:181-192]` 无法区分"用户关"与"超限强制关"**，而需求要求超限时 **toast**。调用方只能自己重算 `canOcrTable` 才能知道该不该弹。建议导出 `tableOcrState(obj): 'on' | 'off' | 'forced-off'`（纯函数，顺手可测）。另外 [实测] 7×6 被强制关后，把 rows 改回 3 仍然 `ocrEnabled=false`（内存里不重算）——需要在改行列数后显式重估一次，否则用户会觉得"改小了还是不开"。
5. **裁剪没有内缩（inset）。** 表格对象矩形是用户拖出来的，与手绘格线有肉眼可见偏差；按理想边界硬切，会把邻格字迹带进本格、或切掉本格最后一笔的下缘。[推断，无实机图] 建议 `inset = max(1, round(0.02 * min(w, h)))` 四边内缩（可配常量 + 测试），这比逐像素对齐更能容忍手写误差。
6. **`[tableOcr.ts:155-158 tablePlaceholder]` 缺夹取**：`tablePlaceholder(0, 3, 1)` 会产出 `[表格 0×3: …]`、`pageNumber=2.7` 产出 `第2.7页`；同仓库的 `objectPlaceholder`（`pageObjects.ts:185-196`）有 `clampTableLines` + `Math.floor`。建议直接复用它，别维护第二份文案。
7. **`[tableOcr.ts:114-142]` 首行全空的降级未定义**：首行全空时表头是空的（`|   |   |`），部分渲染器会渲染出空白表头或不渲染。建议首行全空时把第一条非空行提上来当表头（或整体回退占位符），并把决策写进注释。
8. **缺 row-major 组装辅助函数**：`cellRegions` 返回扁平数组、`tableToMarkdown` 收二维数组，中间"按 cols 分块"由调用方手写，这是行列转置最常见的位置。建议补 `chunkCells(flat, cols)` 并入测试（见盲区 6）。
9. **`[pageObjects.ts:169-176 vs tableOcr.ts:166-178]` 两个遮罩函数口径不同**：`objectsToMaskRects` 会 `normalizeRect`，`objectsToMask` 直接透传原始坐标。当前下游 `regionsToMaskRects`/`sanitizeRegions` 会夹取，所以不出事，但两条路径行为不一致容易被后来者误用，建议统一。

---

## 测试盲区（现有 13 例的缺口，按"必须补"排序）

1. **`ocrEnabled` 持久化往返（会当场失败，正是缺口的证据）**
   输入：`makePageObject('t','table',{x:.1,y:.1,w:.4,h:.3},{rows:3,cols:2,ocrEnabled:false})` → `serializePageObjects({p1:[t]})` → `parsePageObjectsDoc(...)`。
   期望：`pages.p1[0].ocrEnabled === false` 且 `tableOcrEnabled(...) === false`。**当前实测得到 `true`**（= 必须修 1）。
2. **手势不丢开关**
   输入：同上对象 → `moveObject(o, .2, .2)`、`resizeObject(o, .8, .8)`。
   期望：两次结果 `ocrEnabled === false` 且 `tableOcrEnabled() === false`。**当前实测均为 `undefined`/`true`**（= 必须修 2）。
3. **转义幂等性**
   输入：`tableToMarkdown([['a\\|b', 'x'], ['y', 'z']])`（首格字面是 `a`+`\`+`|`+`b`）。
   期望：首行仍只有 **2** 个单元格（即"未转义的 `|` 分隔符"恰好 3 个），且渲染文本为字面 `a\|b`（正确编码应是 `a\\\|b`：`\\` 表示一个反斜杠、`\|` 表示一个竖线）。当前输出 `a\\|b`，会多裂出一格（= 必须修 4）。
4. **切分的覆盖性 / 无重叠属性测试（这是本次唯一没有断言的核心不变量）**
   输入：随机 200 组 `(rect, W, H, R, C)`，`W,H ∈ [200, 3200]` 整数，`R,C ∈ 1..6`，`rect` 越界（x+w>1）也要有。
   期望：① `Σ w*h === (right-left)*(bottom-top)`（无缝隙无重叠）；② 任意两格不相交；③ 每格都在 box 内且 `x+w ≤ pageW`、`y+h ≤ pageH`；④ 非退化时相邻格共享边界（`cell(c).x + cell(c).w === cell(c+1).x`）。
   顺带一条反向用例：`cellRegions({x:.5,y:.5,w:.001,h:.001}, 1600, 2560, 6, 6)` 期望返回 `[]`（当前返回 36 个互相重叠的 1px 格，见建议修 1）。
5. **首行更短 / 全空 / 尾行缺失**
   - `[['A'],['x','y']]` → 期望 `| A |   |` / `| --- | --- |` / `| x | y |`（当前通过，需锁死，防以后改坏）。
   - `[['',''],['','']]` → **期望 `''`**（回退占位符），而不是当前的 `|   |   |` 空壳表——需先定产品口径，然后必须有一条断言。
   - `[]` / `[[]]` / `[[],[]]` → 期望 `''`（前两个已覆盖，`[[],[]]` 没覆盖）。
6. **端到端"几何 → OCR → Markdown"顺序不变量（能抓行列转置）**
   输入：`cellRegions(rect, 1600, 2560, 3, 4)` 后，用 stub `ocr(region, i) => 'r'+row+'c'+col` 生成 12 个字符串，按 cols=4 分块 → `tableToMarkdown`。
   期望：输出第 2 行第 3 列恰为 `r1c2`（0 起），且总行数 = 1 表头 + 1 分隔 + 2 数据行。当前 `cellRegions` 与 `tableToMarkdown` 之间**没有任何联测**，转置/漏行不会被发现。
7. **单位/原点契约的守卫**
   输入：`cellRegions(rect, 1207, 800, 3, 3)`（误传 vp，画布实际 3621×2400px）与正确调用 `(rect, 3621, 2400, 3, 3)`。
   期望：前者返回 `[]`（被建议修 1 的 `width/cols < 2` 守卫挡掉），后者覆盖到 `0.8*3621`。这条测试的作用是把"参数必须是位图像素"的契约钉死；否则同一份代码两次接线就会错一次。

---

## 我确认没问题的点

1. **row-major 顺序正确**：`tableOcr.ts:72-88` 外层 `r`、内层 `c`、顺序 `push`，天然行优先；实测 5×5 时 `regions[0].y === regions[4].y` 且 x 递增、`regions[5].y > regions[0].y`，与 `tableToMarkdown` 期望的 `cells[row][col]` 一致。
2. **正常尺寸下切分精确无缝、末格贴边**：边界用"比例 × 长度再取整"（74-78）而不是累加单格宽，所以相邻格共享同一个取整边界，不会漏一行/一列像素；末格 `x2 = left + round(width*cols/cols) = right`。实测 1600×2560 的 5×5：Σ面积误差 0、重叠 0、越界 0；末格 `x+w`/`y+h` 精确等于 `round((x+w)*W)`/`round((y+h)*H)`；随机 2 万组整数页尺寸、正常表格尺寸下违规 0 例（违规全部出现在 1px 退化格）。
3. **越界夹紧覆盖了所有像素路径**：`clampRect`（98-104）先把 NaN/负宽高/超界归一化矩形处理成合法 box，随后 `clampInt` 夹左上角、`Math.min(w, max(1, pageW-x1))` 夹宽高；数学上 `x1 ≤ right ≤ round(pageW)` 且 `w ≤ pageW-x1` ⇒ `x+w ≤ pageW`，配合 `pageW=1`、`rect={x:0,y:0,w:1,h:1}` 等边界实测均未越界。唯一例外是 1px 退化格的 `max(1,…)` 外扩（已列为建议修 1）。
4. **非法输入全部走"返回空/返回 false"，不抛**：`canOcrTable`（NaN/0/负/小数/11×1）、`cellRegions`（pageW=0、rows=0、w=0）、`tableToMarkdown`（`[]`、`[[]]` 均返回 `''`）都已被现有测试（26-38、67-71、93-96）钉住，接线方可以安心用它做守卫。
5. **`cleanObject` 不会把"关闭"覆盖回 true**：`pageObjects.ts:263` 的 `object.ocrEnabled !== false && rows*cols <= 36` 是"只有明确 false 才 false"，实测 `serializePageObjects` 对 false 的对象写出 `"ocrEnabled":false`（丢字段的是 `parsePageList` 那一端，见必须修 1，别改错地方）。同一函数对"超限但内存里还是 true"的对象也会强制写成 false，方向正确。
6. **`tableOcrEnabled` 与 `canOcrTable` 规则同源**：`tableOcr.ts:187` 复用 `canOcrTable`，`makePageObject` 的 `rows*cols > 36`（`pageObjects.ts:129`）与之等价（36 为硬上限、10 为行列上限，36<10×10 故"每维 ≤10"这条是兜底而非冲突），不存在两套阈值打架的问题。
