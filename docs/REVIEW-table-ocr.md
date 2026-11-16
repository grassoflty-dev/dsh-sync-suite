# 表格逐格 OCR 几何评审

> 只读调查（未改代码、未跑 hvigor）。定向回答 Lead 的问题：`cellRegions(rect, pageW, pageH, rows, cols)` 的基准到底是整页截图还是画布区域截图。
> 备注：上一轮的完整评审在 `apps/arkui-schedule/docs/REVIEW-table-ocr.md`（那份路径没错，但不在 suite 根 `docs/` 下）；本文件是给 Lead 的短版定论。

## 结论（一句话：基准是否一致）

**基准一致：不需要任何 offset。** `PageObject` 的归一化 0..1 是相对**画布区域**（对象层 Canvas 与手写 pager Canvas 完全重合的那块矩形），而落盘的页 JPEG（`attachments-src/<sha>.jpg`）拍的**正是同一块画布区域**（不含 rail、不含顶栏/工具条），且 `pageW/pageH` 取自这张 JPEG 解码后的 `getImageInfo()`。所以 `rect × JPEG 像素尺寸` 直接成立。
唯一风险是**命名/注释**把它叫"整页"（`OcrBatchManager.ets:253-255`、`Handwriting.ets:579-580`、`Handwriting.ets:1109`）：谁把它读成"整窗截图"谁就会整体错开约 1 行/1 列（见下方反例），但当前实现没有这个错误。

## 证据（文件:行号 + 关键代码片段）

**1. 落盘 JPEG 的像素范围 = 画布区域，不含 rail / 工具条**

- `entry/src/harmony/ets/handwriting/HandwritingPager.ets:1124-1131`：截图目标就是每页 Canvas，且铺满 pager 内容区
  ```
  Stack() { Canvas(this.contextFor(pageId))
      .id(`${HANDWRITING_PAGE_ID_PREFIX}${pageId}`)   // 1129: 快照 id 就挂在这个 Canvas 上
      .width('100%').height('100%')                  // 1130-1131
  }.width('100%').height('100%')                     // 1190-1191（pager 根节点，无 padding）
  ```
- `entry/src/harmony/ets/ocr/OcrBatchManager.ets:426-446`：`capturePage()` → `componentSnapshot.get(pageId)`（436）→ `shrinkToMaxSide`（441，最长边 ≤1440）→ JPEG；`473-481 savePageJpeg` 落的就是这张图的字节 ⇒ **`attachments-src/<sha>.jpg` 是"画布区域"图，不是整窗图**。
- `entry/src/harmony/ets/pages/Handwriting.ets:2547-2580`（父布局，决定 pager 等于哪块矩形）：
  ```
  Row() { Column(){railBar()}.width(landscape ? RAIL_WIDTH + DIVIDER : 0)   // 2551-2555：rail 73vp（RAIL_WIDTH=72, DIVIDER=1）
          Column() { Column(){topBar...}.height(landscape ? 0 : TOP_BAR_HEIGHT + DIVIDER)  // 2560-2565：顶栏 49vp（TOP_BAR_HEIGHT=48）
                     HandwritingPager({...}).width('100%').layoutWeight(1) }   // 2567-2576
  }.width('100%').height('100%')                                            // 2581-2582
  ```
  ⇒ pager Canvas = `(pageW − rail) × (pageH − topbar)` vp；`pageW/pageH` 是根 Stack 的整窗尺寸（`2477-2480` 附近 `onAreaChange` 写入）。**所以 JPEG 的物理范围比整窗小 73vp（横屏）或 49vp（竖屏）。**

**2. `PageObject` 的归一化 0..1 = 相对画布区域（不是整窗）**

- `Handwriting.ets:1802-1817`：`objectLeft() = landscape ? RAIL_WIDTH+DIVIDER : 0`（1803）、`objectTop() = landscape ? 0 : TOP_BAR_HEIGHT+DIVIDER`（1808）、`objectWidth() = pageW − objectLeft()`（1812）、`objectHeight() = pageH − objectTop()`（1816）。
- `Handwriting.ets:1839-1844`：对象层 Canvas 就是按这 4 个值摆的 —— `.width(objectWidth()).height(objectHeight()).position({x: objectLeft(), y: objectTop()})`。
- `Handwriting.ets:1833-1837`：`toNormalized(x,y)` 用 `objectW/objectH` 做除数 ⇒ **归一化原点 = 对象层左上角 = pager Canvas 左上角，两矩形逐像素重合**（同 x/y/w/h）。
- 附带结论：对象层是根 Stack 的兄弟节点（`2584-2588`），**不会进入快照**，所以表格网格线不在 JPEG 里，对逐格 OCR 是好事。

**3. 裁剪时 `pageW/pageH` 的来源正确（这是"基准一致"能成立的最后一环）**

- `OcrBatchManager.ets:275-292`：
  ```
  const sha256 = attachments[task.pageIndex].sha256;      // 275
  bytes = this.options.store.readSourceBytes(sha256);     // 278  ← 读 attachments-src/<sha>.jpg
  pagePixel = await this.decodePixel(bytes);              // 288
  const info = await pagePixel.getImageInfo();            // 289
  pageW = info.size.width; pageH = info.size.height;      // 290-291
  cells = cellRegions(task.rect, pageW, pageH, ...);      // 292
  ```
  ⇒ 像素基准 = **这张 JPEG 自身**（已经是 shrink 到 ≤1440 之后的尺寸），不是窗口尺寸、不是 vp。
- `Handwriting.ets:582-600 collectTableTasks` 只搬 `object.x/y/w/h`，**不做偏移**（579-580 的注释已经点明：若改成画布区域截图才需要在这里换算）—— 与当前实现一致，正确。

## 数值例子（实测 `cellRegions` 输出，rect = {x:0.25, y:0.20, w:0.5, h:0.4}，3×3）

| 场景 | 画布 / JPEG | 第 1 行第 1 格（应裁的矩形） | 末格 | 校验 |
|---|---|---|---|---|
| 横屏 1280×800vp @2x（rail 73vp=146px） | 画布 2414×1600px → JPEG **1440×954**（1440/2414） | `{x:360, y:191, w:240, h:127}` | `{840,445,240,127}` | `360+3×240=1080=round(.75×1440)`；`191+3×127=572=round(.6×954)` ⇒ 末格贴右下 ✓ |
| 竖屏 800×1280vp @2x（顶栏 49vp=98px） | 画布 1600×2462px → JPEG **936×1440** | `{x:234, y:288, w:156, h:192}` | — | — |
| **反例**：若误以为 JPEG 是整窗，按 2560×1600 换算 | — | `{640, 320, 427, 213}` | — | 横向偏 **280px ≈ 1.17 格**、纵向偏 **129px ≈ 1.02 行** —— 就是 Lead 担心的"整体错开一行/一列"；当前代码不会走到这里 |

（"rail 76px" 的说法：代码里 rail 是 72vp + 1vp 分割线 = 73vp，横屏像素偏移 = 73×密度；本表按 2x 取 146px。）

## 若不一致：必须修的位置与换算公式（当前**不需要**，仅作未来改整窗截图的预案）

- **责任方：调用方**（`Handwriting.ets` 的 `collectTableTasks` 或 `finish()` 传参前），**不要**塞进 `cellRegions`。纯逻辑层保持"rect 与 bitmap 同一坐标系"这一条不变，否则两处各自偏移必然二次错位。
- 公式（整窗归一化，用于整窗截图；`offsetX/offsetY` 与 `objectLeft()/objectTop()` 同源）：
  ```
  offsetX = landscape ? RAIL_WIDTH + DIVIDER : 0        // 73 : 0
  offsetY = landscape ? 0 : TOP_BAR_HEIGHT + DIVIDER    // 0 : 49
  x' = (offsetX + x * canvasW) / windowW
  y' = (offsetY + y * canvasH) / windowH
  w' = w * canvasW / windowW ;  h' = h * canvasH / windowH
  pageW/pageH = 整窗像素（同一张图的 getImageInfo）
  ```
- 另一条必须守住的铁律：`pageW/pageH` 永远取"**被裁剪那张图**"的 `getImageInfo()`，并且是 `capturePage()` 里 `shrinkToMaxSide`（≤1440）**之后**的尺寸。

## 其它阻塞项（如有）

1. **正文重复（已接线，可直接复现的结构问题）**：开启识别的表格**不进遮罩**（`objectsToMask` 只在关闭/超限时返回矩形，`Handwriting.ets:521-533 mergeObjectMasks` → `1104 pageRegions`），所以整页 `textRecognition` 仍会把表格里的手写字当正文读出来；随后 `composeBodyWithObjects`（`541-564`）又用 Markdown 替换占位符追加到页末 ⇒ 同一张表在正文里出现 2 份（散文副本 + Markdown 表）。建议改为"表格永远填白 + 单元格从阶段 A 原图裁"。
2. **`cells.length === 0` 仍写出空壳表**：`OcrBatchManager.ets:292-346`，`cellRegions` 返回 `[]`（rows/cols 非法、pageW/H 非法、退化矩形）时 `failed=0`，`failed > floor(0/2)` 为假 → 用全 `''` 矩阵 → `tableToMarkdown` 返回 `"|   |   |   |\n| --- | --- | --- |\n|   |   |   |\n|   |   |   |"`（实测）→ `ok=true` 写进正文，表格内容被空壳顶掉。应加 `if (cells.length !== task.rows * task.cols) → tableFailed(...)`。
3. **`ocrEnabled` 两条路径丢失**（纯逻辑层已复现）：`pageObjects.ts:612-625 copyExtras` 漏拷 ⇒ `moveObject/resizeObject` 后 `false → undefined → 启用`；`pageObjects.ts:300-320 parsePageList` 不转发 `raw.ocrEnabled` ⇒ 存盘再读回 `false → true`。后果是"用户关掉的表被重新逐格识别且不再遮白"。
4. **[推断] 单格超时的释放竞态**：`OcrBatchManager.ets:350-369 recognizeCell` 用 `withTimeout` 超时后只 reject，未取消底层 `recognize`，而 `finally` 已 `release(pixel)` ⇒ 超时那一格可能对已释放 PixelMap 做识别（native 层 use-after-release）。建议超时那一路不立即 release，或给识别加取消令牌。
