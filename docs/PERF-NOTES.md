# 性能度量笔记（2026-11-18，只读）

> 本文件只由源码静态阅读得出：**没 build、没跑设备、没改任何源码**。
> 行号可点开核对。每条都标了「事实」（代码里能指到行）或「估算」（按代码结构推算，无真机数据）。
> 规模前提：`devices/*/` 当前只有 `README.md`，**没有任何 `schedules/*.jsonl`（真实数据 0 条）**；
> `docs/DATA-CONTRACT.md:141-150` 只约定「一行一事件、追加语义、每台设备只写自己目录」，**没有条数上限约定**。
> 所以下文的规模一律按「假设 500 条」自洽推算，不当成现状。

## 0. 结论速览

| 项 | 结论 | 触发条件（到这条线再改） |
| --- | --- | --- |
| 列表渲染 | **不改**：`ForEach` 一次性建全部行，但单日/单 tab 实际条数远低于阈值 | `visibleRecords.length > 200`（或真机首屏 > 500ms、滚动掉帧）再换 `LazyForEach + IDataSource` |
| 手写画布 | **不改**：书写路径是**增量**（每次 Move 只画新增段），整页重绘只发生在撤销/重做/增删页/填白 | 单页笔迹 `> 150 笔`（撤销能感到卡）或单页点数 `> 5000` 时再上分层/脏矩形 |
| 其它热点 | **不改**：搜索/导出/会话列表全在 `O(n)`～`O(n log n)`，n 是当前列表条数 | 搜索框输入突增到 `> 1000` 条数据，或 `onChange` 里出现可感知卡顿，再考虑防抖 |

**最值得改的一项**：都不是「现在就该改」。若必须排一个，是**列表**（`Index.ets:1411-1432`）——
它有一个明确的数量级拐点（>200 行），且改动边界清晰（`RecordRow` 不用动，只换数据源）。

## 1. 列表渲染（事实 + 规模估算 + 建议）

### 1.1 事实：用的是 `ForEach`，不是 `LazyForEach`

- 现象列表：`Index.ets:1411` `List() {` → `:1412` `ForEach(this.visibleRecords, ...)` → `:1415` `ListItem()` →
  `:1416` `RecordRow({...})`，key 为 `:1431` `${item.id}|${item.ts}|${item.done ? '1':'0'}`。
- 这是本页**唯一**渲染日程行的路径：`:1441-1447` `RecordList()` 只按 `visibleRecords.length` 二选一，
  紧凑屏 `:1523`、宽屏 `:1563` 都调它。`Index.ets` 里另有两个 `ForEach`，但都不是日程行：
  `:1265` 作者 chips、`:1627` AI 候选面板（上限 = 当天记录数）。
- 全 App 源码（`.ets/.ts`，排除 build/.test/node_modules）里 `LazyForEach` / `IDataSource` / `cachedCount`
  **零命中**——也就是说「列表懒加载」这套东西在这个项目里还没被引入过，`:1436` 只设了 `scrollBar`。
- 语义影响：`ForEach` 在首帧把**全部**行组件建出来（没有复用池），`List` 的懒加载只对 `LazyForEach` 生效。
  好消息是 key 里带了 `ts` + `done`（`:1431`），勾选一条只会让**那一行**重建，其余行 key 不变不重建。

### 1.2 事实：每行 9 个固定组件节点，最多 13 个

数 `components/RecordRow.ets:66-163` 的组件树（外层 `ListItem` 也算一个节点）——**必选 9 个**：
`ListItem`（`Index.ets:1415`）+ 根 `Column`（`:67`）+ `Row`（`:68`）+ `Checkbox`（`:69`）+
`Column`（`:80`）+ `Text` 标题（`:81`）+ `Row` 元信息（`:95`）+ `Text` 时间（`:96`）+ `Divider`（`:158`）。
可选 4 个：作者 `Text`（`:104`）、手迹 `Text`（`:112`）、AI `Text`（`:118`）、删除 `Text`（`:133`）——
本页在 `Index.ets:1425` 传了 `onDelete`，删除按钮**实际必选** → **典型行 11 个节点**，四个全开 13 个。

### 1.3 估算：500 条 ≈ 4,500–6,500 个节点，首屏 0.3–1 s 量级

- 节点数（估算，纯乘法）：`500 × 9 = 4,500`（最少）／`500 × 11 ≈ 5,500`（典型）／`500 × 13 = 6,500`（最多）。
  再加 `List`、汇总块 `SummaryCard`（`Index.ets:1074`）、搜索栏 `SearchFilterBar`（`:1224`）约 +30–60 个。
- 耗时（估算）：按「简单节点创建 + measure/layout ≈ 0.05–0.2 ms/个」这一档粗算，
  5,500 个节点 ≈ **0.28–1.1 s**，也就是 **17–65 个 60fps 帧预算（16.7 ms/帧）**，全在一次同步首帧里完成
  （`ForEach` 构建不分帧）。这里没有任何真机测量做支撑，只用来判断量级。
- 现状对照（事实）：`reload()`（`Index.ets:292-325`）每次勾选/删除/换日期都重读磁盘再整体换 `visibleRecords`（`:310`/`:302`），`ForEach` 只重算 500 个 key（O(n)，便宜）；贵的是首帧一次性建 4.5k–6.5k 个节点这一下。单日几十条时完全不构成问题。

### 1.4 建议：现在不改

- 现状：待办 App 的单日条数天然在个位到几十，`ForEach` 的 O(n) 建节点在 200 条以内仍在一帧到几帧内，收益不足以抵「引入 `IDataSource` + 动列表代码 + 破坏 `key 含 ts/done` 的现成增量语义」的风险。
- 触发条件（任一满足再改）：`visibleRecords.length` 常态 `> 200`；或真机首屏 > 500 ms；
  或滚动出现 > 1 帧的掉帧。「全部未完成」tab（`Index.ets:301` 走 `pendingRecords`）最容易先到拐点，
  因为它是**跨全部日期**的累积量。
- 真要改的话只动 `ListRows()`（`:1409-1437`）：`LazyForEach` + 一个 `ScheduleRecord[]` 的 `IDataSource`
  （`totalCount/getData/registerDataChangeListener`），`RecordRow` 与其 props 一行都不用改，
  key 生成逻辑搬到 `getData` 里。预计收益：首屏节点数从 O(n) 降到 O(视口行数)，500 条时省掉约 9 成节点。

## 2. 手写画布重绘（事实 + 热点 + 建议）

### 2.1 事实：书写是**增量**，一次抬笔只有 **1 条 path**

- 落笔 `Down`（`HandwritingPager.ets:895-913`）：只 `beginPath + moveTo`，不画、不清屏。
- 移动 `Move`（`:915-932`）：`collectSamples()` 取本帧主点 + `getHistoricalPoints()` 历史点，
  然后对**每个采样点**调一次 `appendSample()`（`:814-857`），其中 `:845-854` 是
  「`beginPath` → `quadraticCurveTo` → `stroke()`」**一条 path 一次**。
  即：一次 Move 事件 = `1 + 历史点数` 条 path，**没有 `clearRect`、不重画已有笔迹**。
- 抬笔 `Up`（`:933-956`）：单点笔迹走 `drawDot()`（`:664-674`，1 条 path）；
  多点走 `finishStrokeTail()`（`:860-872`，1 条 path 补最后半段）+ `smoothPath()`（O(点数) 重整点序列，`:949`）
  + `pushStroke()`（`strokeHistory.ts:142` 深拷贝这一笔，O(点数)）+ `notifyDirty()`（`:955`）。
  **所以：一次抬笔 ≈ 画 1 条 path，不重绘整页**——书写热路径是增量描线，这条设计是对的，别动。

### 2.2 事实：整页重绘只发生在 4 个非书写入口

1. 撤销 / 重做：`onUndo()`（`:961-968`）/ `onRedo()`（`:970-977`）→ `replayPage()`（`:698-712`）
   = `:707` 一次 `clearRect(0,0,width,height)` + `:708-710` **把该页所有笔迹从头重放一遍**
   （每笔 1 条 path，`drawStroke()` `:680-696`）。注意 `strokeHistory.ts:161` 的 `undo()` 还先
   `cloneStrokes(该页全部剩余笔迹)`——一次撤销的代价 = **O(该页笔迹数 × 每笔点数)** 的拷贝 + **O(该页笔迹数)** 条 path。
   举例（估算）：一页 30 笔、每笔 200 点 → 撤销一次拷贝 6,000 个点对象 + 画 30 条 path。
2. 插入页 / 删除页：`insertPageAfterCurrent()`（`:297-325`）/ `removePage()`（`:334-362`）先按页快照
   （`strokesAt` 深拷贝，O(全页总点数)），重建 `StrokeHistory`，再 `replayAllPages()`（`:719-726`）
   —— `:720` 的循环**遍历所有页**，每页一次 `clearRect` + 全量重放。这是全文件唯一「全量遍历所有页」的路径。
3. 删页/插页引发的 `replayAllImpl`（`:529-531` 注册）。
4. OCR 前的区域填白 `maskPage()`（`:1134-1151`）：只 `fillRect` 若干矩形，不重放笔迹。

### 2.3 热点：拖动区域框时，**每帧**都做一次「全页框深拷贝 + 全框重建」

- `handleGestureUpdate()`（`:1050-1084`）在 `DRAG_MOVE`/`DRAG_RESIZE` 下**每个 Move 事件**都调
  `this.state.updateRegion(...)`（`:1071` / `:1083`）。
- `updateRegion()`（`:411-415`）→ `sync()`（`:261-274`）→ `:267-272` 的循环**遍历所有页**，
  每页 `regionsAt(index)`（`pageBook.ts:224-229`，`cloneRegions` 深拷贝）+ `.slice()`，
  然后重新赋值 `this.regions` 触发 `@ObjectLink` 刷新。所以**拖动框的每个 Move 事件都是 O(页数 × 每页框数) 的拷贝**。
- 更贵的一环在视图侧：overlay 的 `ForEach`（`:1234-1241`）把**几何值拼进 key**
  （`region-${current}-${index}-${x}-${y}-${w}-${h}`，`:1239-1240`），几何一变 key 就变 →
  **当前页所有框组件每帧整体重建**（不止被拖的那个）。这是刻意的（注释 `:26-29` 解释了「不这样框就不跟手」），
  代价是 O(当前页框数) 组件重建/帧。
- 另一条 O(页数) 的常驻成本（事实）：`build()` 的 `ForEach(this.state.pageIds)`（`:1206-1228`）
  给**每一页**都建了一个铺满的 `Canvas` 节点，非当前页只是 `opacity(0)`（`:1215`）+ 不可触摸（`:1217-1219`）。
  `MAX_HANDWRITING_PAGES = 10`（`pageBook.ts:24`）→ 最多 10 张全尺寸画布常驻（内容保留所需，不是泄漏）。
- 快照/落盘侧（事实）：抬笔后 `notifyDirty()` → 父页面 `scheduleDraftSave()`（`pages/Handwriting.ets:650-656`，
  防抖 `DRAFT_SAVE_DEBOUNCE_MS = 2000`，`:180`）→ `buildDraftDoc()`（`:592-617`）**遍历所有页**的笔迹
  （每页 `strokesAt` 深拷贝 + 归一化）→ `saveDraftNow()`（`:626-647`）同步写盘，上限 2 MB
  （`model/draft.ts:37`）。即：停笔 2 s 后会有一次 O(全部页笔迹点数) 的序列化 + 一次同步 I/O；书写中（连续 Move）不触发它，所以不卡笔，但长会话（10 页写满）时这次保存会变重。

### 2.4 建议：现在不改；要改就按「撤销重放」下手，别碰书写路径

- 现状可接受：≤10 页、单页几十笔的规模下，一次撤销 ≈ 几十条 path + 几千点的拷贝，估算在几 ms 量级；
  而书写体验的关键路径（Down/Move/Up）**本来就是增量的**，没有可省的全量重绘。
- 触发条件：单页笔迹常态 `> 150 笔`（撤销/重做能感到卡顿，> 50 ms 量级）、或单页点数 `> 5000`、
  或 10 页写满后停笔保存超过 0.5 s。
- 若改怎么改（按收益排序，都不改书写路径）：
  1. **撤销改「快照贴回」而不是重放**：`pushStroke` 时对该页 canvas 留一张离屏 bitmap（或每 8 笔一个 checkpoint），
     撤销时 `drawImage` 贴回 —— 一次撤销从 O(笔数) 条 path 降到 O(1)，`replayPage()`（`:698-712`）保留给删页兜底。
     代价：内存 `页数 × 单页 bitmap`（估算 1600×2560×4B ≈ 16 MB/页，需要压成每页 1–2 张检查点）。
  2. **分层 canvas**：笔迹层（已固化）+ 当前笔层（每帧只清当前笔层），橡皮 `destination-out` 只作用在笔迹层。
     收益是把「橡皮半透明接缝」和「撤销重放」两件事同时解掉，但要动 `:1206-1228` 的槽位结构和截图 id 契约
     （`componentSnapshot` 只截一笔 Canvas，见 `:21-24` 注释），风险最高。
  3. **脏矩形**：仅对橡皮/框填白这类「局部破坏」有效，对撤销（整页语义变了）无效，所以优先级最低。
  4. **拖动框的 O(页数×框数) 拷贝**：`sync()` 里只需复制**当前页**的 regions（`:267-272` 现在复制全部页），
     其余页的框在切页时再复制 —— 改动 5 行以内，收益是每帧从 O(页×框) 降到 O(当前页框)。
     这是本节**性价比最高的小改**，但当前框数是个位数，感知不到。

## 3. 其它热点（纯函数，10 行内）

- 搜索：`query.ts:133-141` `applyQuery` = O(N×K)，每条记录对每个关键词做 4 次 `toLowerCase()+indexOf`
  （`:86-95`，`toLowerCase` **没有缓存**）；`Index.ets:676-678` 的 `onChange` 无防抖，**每敲一个字重算一遍**；
  同一函数里 `:665` 还调 `authorsOf`（`:147-163`，Set + 排序，O(N log N)）。500 条 × 2 词 ≈ 数千次小写转换/按键，可忽略。
- 导出/导入：`exportImport.ts:701-...` `planImport` 与 `:813` `reconcileBeforeAppend` 用 `Map` 按 id 折叠（O(n)），
  `:331-334` / `:920` 只有排序是 O(n log n)；`writePlan`（`:941`）按日期分组后一天一次追加，无嵌套扫描。
  纯函数层面没有 O(n²)。
- 会话列表：`chatList.ts:267` `parseChatIndex` O(行数)、`:326-362` `sortChats` O(n log n)（显式带 index 保稳定）、
  `:370-...` `filterChats` O(n)，由 `Chats.ets:91` / `:106` 调用；`Chats.ets:242` 同样是 `ForEach`（不在本次范围）。
- 「全部未完成」取数：`openIndexStore.ets:287-303` → `resolveRecords`（`:386`）按 (设备,日期) 分片缓存只读一次，
  但 `:415` 对索引里查不到的 id 会退化成**读该设备全部记录**（`readAllRecords`，`:441-...`）——这是唯一潜在 O(全部历史) 的路径，
  只在「其他设备缺索引」时命中，且带 15s 内存缓存（`:369`）。

## 4. 若将来要改：最小改动清单（按收益排序）

1. `Index.ets:1409-1437` `ListRows()`：`ForEach` → `LazyForEach` + `IDataSource`（新建 `model/recordDataSource.ets`），
   `RecordRow` 不改；触发条件 `visibleRecords > 200`。收益最大、边界最清楚。
2. `HandwritingPager.ets:698-712` 撤销/重做：加「落笔检查点 bitmap」，撤销改贴图，保留 `replayPage` 给删页兜底；
   触发条件单页 `> 150 笔`。只动 `onUndo/onRedo` + `pushStroke` 的调用点。
3. `HandwritingPager.ets:267-272`：`sync()` 只复制当前页 regions；5 行以内，每帧少一次 O(页×框) 深拷贝。
4. `Index.ets:676-678`：`onQueryTextChange` 加 150 ms 防抖（或把 `toLowerCase` 结果缓存进 `QueryFilter`）；
   只有数据涨到千级才有必要。
5. 不建议做：分层 canvas（动截图契约 `:21-24`）、脏矩形（对撤销无效）。

## 5. 未度量 / 需真机才能测的项

- **全部耗时数字都是估算**：本机无鸿蒙设备，`docs/VERIFICATION.md:132` 已把「真机性能」列为未验证，
  `:228` 把「真机 Canvas 手写」列为未验证。没有一帧是实测的。
- 需要 DevEco Profiler / 真机才能拿到：首帧构建耗时（列表 500 行真值）、`quadraticCurveTo` 每帧 path 数上限、
  Canvas 10 张全尺寸表面的显存占用、`destination-out` 橡皮的合成耗时、`componentSnapshot` 截图耗时。
- 需要真实数据才能确定：单日/跨日实际最大条数（决定第 1 节的触发阈值是否会被触发）。
  当前仓库 `devices/{pc-a,pc-b,phone-a}/` 只有 `README.md`，**没有一份真实 jsonl**。
- 未覆盖的文件：`pages/Detail.ets`、`pages/Edit.ets`、OCR 批处理（`ocr/OcrBatchManager.ets`）的串行等待、
  `pages/Chats.ets` 的列表渲染——本轮时间盒只覆盖 D 线点名的三处。
