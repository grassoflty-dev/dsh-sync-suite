# UX-STEPS：便捷性批（B）改前步数基准表

> **用途**：便捷性优化的唯一验收口径是「步数」。本文件先把 5 条高频路径的**改前**步数量出来，
> 后续任何优化都必须给出「改前 N 步 → 改后 M 步」的对比，否则不算优化。
>
> | 项 | 值 |
> | --- | --- |
> | 仓库 | `C:\Users\GWL\Desktop\itwillclaude\dsh-sync-suite`（`apps/arkui-schedule`） |
> | 分支 / HEAD | `main` / `379fcc5` |
> | 覆盖层状态 | `node apps/arkui-schedule/tools/overlay.mjs status` → `applied=false`（读的是「共享源码 + 平台目录」原始形态） |
> | 真机 | **不可用**：本机 `hdc` 不在 PATH（`hdc list targets` 报 `CommandNotFoundException`），本表所有数字**均非真机实测** |
> | 口径版本 | `v1`（本文件 §1；后续所有人照这个数，改口径必须升版本并在本文件留痕） |
| 行号基准 | §2 的「改前」行号以 **HEAD `379fcc5`** 为准（`git show 379fcc5:<file>` 可复核）；§4.1 的「改后」以 **`main@6ecec62` + 其上的 B 批未提交工作树** 为准。本文件写完时工作区已有**并行分支的未提交改动**，见 §5.1 末条。 |

---

## 1. 度量口径（v1，唯一口径）

### 1.1 三个计数单位

| 单位 | 记号 | 定义 | 典型例子 |
| --- | --- | --- | --- |
| 点击 | `tap` | **一次明确的点击 / 按键提交**（含确认弹层里的「确认」） | 点「新建」、点输入框获得焦点、点「保存日程」、点弹层里的「放弃修改」 |
| 滚动 | `scroll` | **一次需要滑动才能看到下一步目标的动作**（同一屏内就能看到的不算） | 在设置页从「同步」组滑到「数据」组；横向滑工具条找按钮 |
| 等待 | `wait` | **一次必须等异步返回才能继续的动作**（同步拉取、AI 生成、页面加载、文件读写 >300ms） | 冷启动等首页出列表、点「完成」等 OCR、点「导出」等写盘、进详情等读 `session.jsonl` |

### 1.2 计数细则（避免同一路径两个人数出两个数）

1. **输入文字本身不计数**：聚焦输入框算 1 次 `tap`，敲多少字都不再累加。
2. **同一个输入框只数一次**：反复点同一个框（改错重输）不重复计。
3. **长按 / 粘贴不单独计数**：长按弹系统菜单属系统交互（见 §1.3）；若为一次独立手势才另计 1 `tap`。
4. **返回不算「路径」的一部分，但要单列**：路径终点是「拿到结果」那一刻；返回步数写在明细表末尾的
   「回程」行，**不计入合计**，方便比较「去做这件事」的成本。
5. **一次滑动 = 跨一屏**：目标在下一屏记 1，跨 N 屏记 N（N 由内容高度 / 可视高度估算，估算值一律标 `est`）。
6. **同一动作不拆两次**：点按钮后页面自己跳转，跳转的 `wait` 与按钮的 `tap` 分开记，但只记一次 `wait`。
7. **失败重试另记**：本表数的是「一次成功」的路径；已知会失败的分支写在「风险 / 回退」里，不混进合计。

### 1.3 不计入项（但必须单列「系统交互」备注）

- 纯阅读（看列表、看正文、看提示）；
- 失焦、键盘收起、返回手势；
- **系统权限弹窗**（网络权限、相册权限）与系统选择器（`DocumentViewPicker`、`PhotoViewPicker`、
  剪贴板长按菜单、系统 `DatePicker` 的滚轮手势本身）——这些**不计入**步数，但在路径明细里
  标 `系统交互`，因为它们是真实发生的、且常常是「卡住用户」的地方。
- 系统 `DatePicker` 内部滚轮的**滚动**：本表按「系统交互」处理，不计 `scroll`（只有跨屏滚动计入）。

### 1.4 记法

```
改前 = N 步（tap a + scroll b + wait c）
```

每条路径的明细表固定四列：**动作 / 控件文案 / 落点（文件:行号）/ 归属**。

---

## 2. 五条路径的「改前」明细

### 2.0 汇总

| # | 路径 | tap | scroll | wait | 合计 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 记一条日程（冷启动 → 保存成功） | 4 | 0 | 3 | **7** | 手机单列布局 |
| 2 | 加手写（从新建 → 手写板 → 回到记录） | 4 | 0 | 4 | **8** | 从已有记录进入为 9 |
| 2′ | 加手写 + 插图 | 6 | 0 | 5 | **11** | 含相册系统交互 |
| 3 | 导出今天或一周 | 5 | 3 | 2 | **10** | 区间要手打两个日期 |
| 4 | 连远程 DSH | 3 | 2 | 3 | **8** | 二次进入同为 8（地址已预填） |
| 5 | 打开某条 chat 会话并想继续 | 3 | 4 | 3 | **10** | 回程另 +3 tap（不计入） |

---

### 2.1 路径 1 · 记一条日程（App 冷启动 → 首页 → 填完一条 → 保存成功）

**改前 = 7 步（tap 4 + scroll 0 + wait 3）**

| # | 动作 | 控件文案 | 落点（文件:行号） | 归属 |
| --- | --- | --- | --- | --- |
| 1 | 冷启动等首页首屏（存储初始化 → 读当日分片 → 出列表） | —（首屏骨架） | `entry/src/main/ets/pages/Index.ets:269-284`（`bootstrap()`：`scheduleStore.ensureReady` + `summaryStore.ensureReady` + `openIndexStore.reconcile`） | wait |
| 2 | 点底部主按钮开新记录 | `新建` | `entry/src/main/ets/pages/Index.ets:1028`（`Button('新建')`），由 `CompactBody` 在 `Index.ets:1525` 渲染（`this.PrimaryAction()`） | tap |
| 3 | 等编辑页就绪（路由取参 → 读默认作者 → 读记录） | —（`StateView` 加载态） | `entry/src/main/ets/pages/Edit.ets:19-35`（`aboutToAppear` 取 `id`/`date`）+ `entry/src/main/ets/components/RecordEditorView.ets:176-203`（`bootstrap()`：`ensureReady` → `settingsStore.load`） | wait |
| 4 | 点标题输入框 | 占位符 `例如：周三项目周会` | `entry/src/main/ets/components/RecordEditorView.ets:437` | tap |
| 5 | 点正文输入框 | 占位符 `记录内容；手写识别结果会追加到这里` | `entry/src/main/ets/components/RecordEditorView.ets:477` | tap |
| 6 | 点保存 | `保存日程`（编辑已有记录时为 `保存修改`） | `entry/src/main/ets/components/RecordEditorView.ets:588` → `save()` `:301-362` | tap |
| 7 | 等落盘 + 返回 + 首页重载 | toast `已保存` / `已保存（待 AI 整理）` | `RecordEditorView.ets:345`（`appendRecord`）→ `:361`（`onSaved`）→ `Edit.ets:55-57`（`router.back()`）→ `Index.ets:244-254`（`onPageShow` → `reload()`） | wait |

- **`scroll` 为 0 的依据**：标题 / 正文 / 记录者 / 完成情况都在同一个 `Scroll` 里，但「保存」按钮
  在 `Scroll` **之外**（`RecordEditorView.ets:573-597`，底部固定行），所以保存不需要滚动。
- **不计入**：①「记录者」默认已填（`RecordEditorView.ets:180-189` 读设置里的作者名，没填回落「我」）；
  ②「完成情况」开关默认关，属可选；③标题为空会被拦截（`:306-309`），属失败分支，不进本表。
- **变体（记「非今天」的日程）**：当前**做不到**——新记录的 `ts` 恒为 `nowIso()`
  （`RecordEditorView.ets:318`），编辑页也没有日期字段，`appendRecord` 按 `ts` 决定落哪个日片
  （`services/scheduleStore.ets:316-318`）。在首页先切日期再点「新建」，记录仍然落在今天。
  这条变体的「隐性返工步数」记在 §3 可砍点 D5。

---

### 2.2 路径 2 · 加手写 / 图片（从记录 → 手写板 → 写完 → 回到记录；以及插图路径）

**改前 = 8 步（tap 4 + scroll 0 + wait 4）**（入口＝首页「新建」；从已有记录进入为 **9 步**，多一次「编辑」tap）
**改前（含插图）= 11 步（tap 6 + scroll 0 + wait 5）**

| # | 动作 | 控件文案 | 落点（文件:行号） | 归属 |
| --- | --- | --- | --- | --- |
| 1 | 点「新建」（或先点记录行 → 点「编辑」进入已有记录） | `新建` | `entry/src/main/ets/pages/Index.ets:1028` | tap |
| 2 | 等编辑页就绪 | — | `RecordEditorView.ets:176-203` | wait |
| 3 | 点手写板入口（仅鸿蒙构建渲染） | `手写板` | `entry/src/main/ets/components/RecordEditorView.ets:379-386`（`WritingEntry()`，条件 `getFeatures().handwriting`）→ `:287-299`（`openWritingBoard()`，路由来自 `handwritingPageRoute()`） | tap |
| 4 | 等手写板挂载 + 恢复上次草稿 | toast `已恢复上次未完成的手迹`（有草稿时） | `entry/src/harmony/ets/pages/Handwriting.ets:457-473`（`aboutToAppear` → `restoreDraft()`） | wait |
| 5 | 点「完成」 | `完成`（识别中变 `识别中`，并禁用） | `Handwriting.ets:1820-1832`（`Button(this.busy ? '识别中' : '完成')`）→ `onCellTap` 的 `CELL_FINISH` 分支 → `finish()` `:1402-1475` | tap |
| 6 | 等逐页截图 + OCR 批处理 | toast `正在保存 N 页原图并识别…`、进度文案 `ocrProgress` | `Handwriting.ets:1422-1439`（`OcrBatchManager.run()`）；每页切页后固定等 80ms：`:1390-1400` | wait |
| 7 | （自动）`router.back()` 回编辑页 + 回填 | —（正文末尾追加识别文本，出现 `手迹 N 页`） | `Handwriting.ets:1468`（`router.back()`）→ `pages/Edit.ets:38-40`（`onPageShow` 令 `tick+1`）→ `RecordEditorView.ets:233-258`（`applyPendingInkResult()`：`handwriting.result` / `ocrText` / `attachments` / `pageObjects`） | —（同步回填，不计） |
| 8 | 点保存 | `保存日程` | `RecordEditorView.ets:588` | tap |
| 9 | 等落盘 + 回首页 | toast `已保存` | `RecordEditorView.ets:345` → `Edit.ets:55-57` → `Index.ets:244-254` | wait |

**插图（在手写板内，追加 2 tap + 1 wait）**

| # | 动作 | 控件文案 | 落点（文件:行号） | 归属 |
| --- | --- | --- | --- | --- |
| 5a | 点「插入」开二级菜单 | `插入` | `Handwriting.ets:2035`（`CELL_INSERT`）→ 面板 `:2690-2724` | tap |
| 5b | 点「图片」 | `图片` | `Handwriting.ets:2696-2709`（`insertImage()` `:998-1003`，先关面板再唤起相册） | tap |
| 5c | 相册选图 | 系统 `PhotoViewPicker` | `Handwriting.ets:1098-1111`（`pickImageFromGallery()`） | `系统交互`（不计） |
| 5d | 等解码 / 压缩 / 落盘 / 重绘 | toast `插入图片失败：…`（失败时） | `Handwriting.ets:1125-1192`（`insertImageFromUri()`：`fs.openSync` → `createImageSource(fd)` → 缩放/打包 → `attachmentStore.saveImageJpeg` → `insertImageAt`） | wait |

- **安卓端如实标注**：**手写板与插图在 Android 不可用**。共享层
  `entry/src/main/ets/common/platformFeatures.ets:29-36` 对非 harmony 平台
  `setFeatures({ handwriting: false, ocr: false })`，`:42-44` 的 `handwritingPageRoute()` 返回空串；
  鸿蒙覆盖层 `entry/src/harmony/ets/common/platformFeatures.ets:19-27` 才返回 `pages/Handwriting`。
  因此 Android 上 `WritingEntry()` 整个分支不渲染（`RecordEditorView.ets:378`），本路径在 Android 上
  **不存在**（功能缺失，不是「步数多」）。共享层只有 `model/penInput.ts` / `model/brush.ts` 这类纯逻辑。
- **不计入**：写字本身（笔画数不是步数）；`↶` 撤销（写错才用）；插表格（`Handwriting.ets:2710-2723`，另一条路径）。

---

### 2.3 路径 3 · 导出今天或一周（设置 → 数据 → 选区间 → 导出 → 拿到路径）

**改前 = 10 步（tap 5 + scroll 3 + wait 2）**

| # | 动作 | 控件文案 | 落点（文件:行号） | 归属 |
| --- | --- | --- | --- | --- |
| 1 | 点页头进设置 | `⚙ 设置` | `entry/src/main/ets/pages/Index.ets:1762`（`headerActionTwo`）→ `:1763-1765` → `openSettings()` `:396-400` | tap |
| 2 | 等设置页读本机设置 | 副标题 `同步 / AI / 远程 / 数据 / 关于` | `entry/src/main/ets/pages/Settings.ets` 的 `aboutToAppear` → `settingsStore.load` | wait |
| 3 | 从页顶滑到「数据」组 | 组标题 `数据` | `Settings.ets:2403`（单 `Scroll`）→ 组顺序 `:2406`(同步) `:2410`(AI) `:2414`(远程) `:2418`(数据)；数据组在第三组之后 | scroll ×3 `est` |
| 4 | 点开始日期输入框 | 占位符 `开始日期 2026-11-01` | `entry/src/main/ets/components/ExportImportPanel.ets:184`（`FromInput()`，经 `components/settings/DataSection.ets:38` 装配） | tap |
| 5 | 点结束日期输入框 | 占位符 `结束日期 2026-11-30` | `ExportImportPanel.ets:202`（`ToInput()`） | tap |
| 6 | 点导出 | `导出`（忙碌时 `导出中…`） | `ExportImportPanel.ets:371-382` → `Settings.ets:1032-1064`（`handleExport()` → `exportSchedules`） | tap |
| 7 | 等写盘 | toast `已导出`，提示 `已导出 N 条（文件名）` | `services/exportService.ets:228`（`exportSchedules`，同步写 `<filesDir>/export/`，目录见 `:140 exportsDirPath()`） | wait |
| 8 | 点复制路径（拿到路径的最短动作） | `复制路径` | `ExportImportPanel.ets:271`（由 `Settings.ets:2374-2376` 传 `onCopyPath` → `handleCopyPath()` `:1165-1180`） | tap |
| 回程 | 返回首页（不计入合计） | 返回箭头 | `ExportImportPanel` 无返回；`PageLayout` 的 `onBack`（`Settings.ets:2800-2802`） | tap ×1 |

- **`scroll` 为 3 的依据（est）**：紧凑屏是**一个**长 `Scroll`（`Settings.ets:2403-2435`），组顺序
  `同步 → AI → 远程 → 数据 → 云端对话 → 关于`（`:2406/:2410/:2414/:2418/:2422/:2426`）；
  同步组 6 个输入框 + 1 开关 + 2 按钮，AI 组 3 个输入框，远程组 1 个下拉 + 2–3 个输入框 + 1 按钮，
  按令牌高度估算数据组起点约在 2.5–3 屏处 → 记 3（未在真机测量，见 §5）。
- **不计入**：①「Markdown / JSON」格式（默认 Markdown，`:55`）；②两个附件/元信息勾选框（默认关）；
  ③长按路径复制（与「复制路径」按钮二选一，只数一次）。
- **痛点（已量化）**：区间**默认空串**（`model/exportImport.ts:1142-1145`），没有任何「今天/本周」快捷，
  必须手打两个 `YYYY-MM-DD`；导出**不弹系统保存对话框**（直接写 App 沙箱 `export/`，`:228`），
  所以「拿到路径」只能靠看文字或复制。

---

### 2.4 路径 4 · 连远程 DSH（设置 → 远程控制 → 填/贴地址 → 打开 → 看到页面）

**改前 = 8 步（tap 3 + scroll 2 + wait 3）**

| # | 动作 | 控件文案 | 落点（文件:行号） | 归属 |
| --- | --- | --- | --- | --- |
| 1 | 点页头进设置 | `⚙ 设置` | `Index.ets:1762` → `openSettings()` `:396-400` | tap |
| 2 | 等设置页读本机设置 | — | `Settings.ets` 的 `aboutToAppear` → `settingsStore.load` | wait |
| 3 | 从页顶滑到「远程控制」组 | 组标题 `远程控制` | `Settings.ets:2403`（单 `Scroll`）→ `:2414` `this.RemoteGroup()` → 装配 `:2286` | scroll ×2 `est` |
| 4 | 点「DSH 地址」输入框并粘贴 | 占位符 `http://192.168.1.6:3080/?token=…` | `entry/src/main/ets/components/settings/RemoteSection.ets:317`；回调 `Settings.ets:2341-2348`（`onChangeRemoteUrl` 只写 `@State`） | tap |
| 5 | 点「打开远程控制」 | `打开远程控制`（地址为空时禁用，下方提示 `先填写电脑上的 DSH 地址`） | `RemoteSection.ets:346-357`（`enabled(this.remoteUrl.trim().length > 0)`）→ `Settings.ets:1937-1992`（`openRemote()`：拼地址 → `normalizeRemoteUrl` → 落盘 → `pushUrl`） | tap |
| 6 | 等归一 + 落盘 + 路由 | toast `已保存` | `Settings.ets:1947`（归一）→ `:1962/:1968-1977`（`settingsStore.save`）→ `:1992`（`router.pushUrl(routeToRemote())`） | wait |
| 7 | 等远程控制页解析地址 + Web 首屏 | 加载失败时卡片 `打不开这台电脑上的 DSH 页面` | `entry/src/main/ets/pages/RemoteControl.ets:95-114`（`resolveAddress()`：路由参数优先、设置兜底）→ `:333-340`（`Web({ src: this.url })` 挂载即加载） | wait |
| 回程 | 返回（不计入） | `‹`（页面左上）`RemoteControl.ets:206` | — | tap ×1 |

- **`scroll` 为 2 的依据（est）**：远程组是第 3 组，起点约 1 屏处 → 记 2（未真机测量）。
- **二次进入仍 8 步**：地址会预填（`Settings.ets:543` `this.remoteUrl = settings.remoteUrl`），
  但**首页没有任何直达入口**（页头只有「⚙ 设置」，`tools/test/indexHeader.test.mjs:57-65` 守着），
  所以每次都要「进设置 + 滚动」。
- **不计入**：①「访问方式」下拉（默认局域网 `lan`，`RemoteSection.ets:132-149`）；
  ②「访问令牌」输入框（`lan` 下存在，但留空即沿用已保存值，`Settings.ets:1874-1875`）；
  ③粘贴时的系统剪贴板菜单（`系统交互`）。

---

### 2.5 路径 5 · 打开某条 chat 会话并继续（首页 → 设置 → 云端对话 → 列表 → 详情 → 想继续却发现只读）

**改前 = 10 步（tap 3 + scroll 4 + wait 3）** —— 且**终点是死路**：能看见，但不能继续。

| # | 动作 | 控件文案 | 落点（文件:行号） | 归属 |
| --- | --- | --- | --- | --- |
| 1 | 点页头进设置 | `⚙ 设置` | `Index.ets:1762` → `openSettings()` `:396-400` | tap |
| 2 | 等设置页读本机设置 | — | `Settings.ets` `aboutToAppear` → `settingsStore.load` | wait |
| 3 | 从页顶滑到「云端对话」行 | 行文案 `云端对话` + 右侧 `只读 ›` | `Settings.ets:2403`（单 `Scroll`）→ `:2422` `this.ChatEntryRow()`（定义 `:2063-2087`，在「数据」组之后、「关于」之前） | scroll ×4 `est` |
| 4 | 点这一行进列表 | `云端对话` / `只读 ›` | `Settings.ets:2084-2086` → `openChats()` `:2090-2094`（`pushUrl('pages/Chats')`） | tap |
| 5 | 等列表读 `chats/index.jsonl` | 副标题 `只读 · 共 N 个会话` | `entry/src/main/ets/pages/Chats.ets:58-61`（`aboutToAppear`）→ `:77-102`（`reload()` → `chatStore.listChats()`） | wait |
| 6 | 点某个会话行 | 行标题 + 徽章 `只读` + 摘要 `2026-11-18 14:03 · 42 条消息` | `Chats.ets:198-241`（`ChatRow`，`:238-240` 整行 `onClick` → `openDetail`）→ `:132-137` | tap |
| 7 | 等详情读 `meta.json` + `session.jsonl` | 加载态 `正在读取会话…` | `entry/src/main/ets/pages/ChatDetail.ets:54-58`（`aboutToAppear`）→ `:84-113`（`load()` → `chatStore.loadChat(id)`） | wait |
| 8 | （到此受阻）看到只读横幅 | `这是从 Git 同步来的只读会话，不能在这里继续对话` | `ChatDetail.ets:153-164`（`ReadOnlyNotice()`，在滚动区之外常驻）→ 在 `build()` 里 `:330` | —（0 步，但**无出路**） |
| 回程 | 返回列表 / 返回设置 / 返回首页（不计入合计） | 返回箭头 | `Chats.ets:438-440`、`Settings.ets:2800-2802` | tap ×3 |

- **`scroll` 为 4 的依据（est）**：该入口在「数据」组之后（`Settings.ets:2418` 在前、`:2422` 在后），
  是紧凑屏长页里最靠下的可点入口 → 记 4。
- **终点判定（核实结论）**：详情页**完全没有**「接管 / 继续对话」入口，也**不是假入口**——
  全页只有 `ReadOnlyNotice()` + 消息 `List`（`ChatDetail.ets:317-349`），无任何输入框/发送按钮；
  `docs/CHAT-APP.md:110-111` 与 `:169`（§8.5）明确写「不做接管入口，属 P2；现在给入口等于给一个
  必然失败的按钮」。所以路径 5 的「回本」只能靠用户自己换到远程控制页去操作（见 §3 D2）。

---

## 3. 可砍点清单

> 列「预计省」时一律对照 §2 的口径；`est` = 估算（未真机验证，见 §5）。

### D1 远程地址粘贴 / 归一 / 一键重连（指定必查点 ①）

| 项 | 内容 |
| --- | --- |
| **路径** | 路径 4（连远程 DSH） |
| **现状（核实，逐条）** | ① **整条 URL**：支持（`model/remoteUrl.ts:183-263`，协议只允许 http/https，其余原样保留）。<br>② **`host:port`**：支持——没写协议自动补 `http://`（`remoteUrl.ts:192-204`，`hadScheme=false` 供调用方提示）。<br>③ **`?k=`**：**不支持识别**。`queryHasToken()` 只认键名 `token`（`remoteUrl.ts:159-175`，判定在 `:170`：`if (key === 'token')`）；而插件侧令牌门**两个名字等价**（`packages/dsh-dots/src/remote/routes.ts:177` 注释、`packages/dsh-dots/src/remote/auth.ts:19` 的 `TOKEN_PARAM = 'k'`）。结果：贴一条插件给的 `?k=…` 地址，地址本身能通过校验，但会被判 `hasToken=false` → 设置页弹出橙色提示 `地址未包含 token，DSH 可能要求登录`（`Settings.ets:1919-1928`）。<br>（写本表期间已有人在补这个洞：工作区版本 `remoteUrl.ts:315` 出现 `TOKEN_KEYS = ['token','k']` 与 `parseRemoteInput`，见 §5.2 末条；本条基准仍按 HEAD `379fcc5` 记。）<br>④ **输入框回调不做实时归一**：`onChangeRemoteUrl` 只写状态（`Settings.ets:2341-2348`），归一/校验发生在点「打开远程控制」时（`Settings.ets:1947`）→ 粘贴完看不到「已自动补 http://」这类即时反馈。<br>⑤ **一键重连最近成功地址：不存在**。`RemoteSettings` 只有 9 个远程字段（`services/settingsStore.ets:137-166`：`remoteUrl` / `remoteMode` / `remoteLanAddress` / `remotePort` / `remoteTailscaleHost` / `remoteCloudflareHost` / `remoteIpv6Address` / `remoteManualUrl` / `remoteToken`），落盘键常量同清单（`:263-271`），**没有** `lastOk` / `lastOkAt` / 最近成功时间；页面只预填「上次填的地址」（`Settings.ets:543`）。 |
| **砍法** | P1-a：`queryHasToken` 增补 `k` 别名（`remoteUrl.ts:170` 一处 + 单测；同时保证地址已带 `?k=` 时不再追加 `?token=`）。<br>P1-b：`openRemote()` 成功后写 `lastOkHost` + `lastOkAt` 两个键（`settingsStore.ets:263-271` 旁），设置页远程组顶部加一行按钮「重新连接 192.168.1.6:3080（上次 11-18 20:41 成功）」。<br>P2：输入框失焦即归一 + 一次性提示「已自动补 http://」。 |
| **预计省** | 首次 0 步；**二次及以后 3 步**（`scroll 2 + tap 1`：不必滚回远程组、不必再找/重敲地址）。`est` |
| **风险** | 中。`lastOkUrl` 若存完整地址＝再存一份带 token 的串，需过 `credentialHygiene` / 脱敏类测试（`tools/test/credentialHygiene.test.mjs`）；建议只存 `host:port` + 时间，令牌用已保存的 `remoteToken` 拼。`?k=` 别名属低风险（纯逻辑 + 单测）。 |

### D2 chat 详情页「接管此会话」入口（指定必查点 ②）

| 项 | 内容 |
| --- | --- |
| **路径** | 路径 5 |
| **现状（核实）** | **完全没有入口，也不是假入口**。`pages/ChatDetail.ets` 全文无输入框、无发送按钮：`build()` 只有 `ReadOnlyNotice()` + 四选一内容区（`:317-349`）；只读横幅文案在 `:155`。`docs/CHAT-APP.md:169`（§8.5）把这件事写成了**刻意不做**：「不做「接管/继续对话」入口：属 P2（导入回 DSH）之后的事；现在给入口等于给一个必然失败的按钮」；同文件 `:110-111` 给了原因（同一会话同一时刻只能有一个写者，平板续写会产生分叉事件流）。`services/chatStore.ets` 也不校验 sha256 / 租约（§8.2）。 |
| **砍法** | P1（低成本、不改写入语义）：详情页底部加一个「在电脑上继续」按钮 → 带 `chatId` 跳到 `pages/RemoteControl`（页面已存在，`RemoteControl.ets:95-114` 支持路由参数 `url`），并提示「请在电脑上接管该会话」。<br>P2（真接管）：`docs/CHAT-SYNC.md` §1/§5 的租约 + sha 校验做完后，底部换成真输入框。 |
| **预计省** | P1 版 **省 ≥4 步**（现状要：返回设置 1 + 滚到远程组 2 + 打开远程 1，还要在 DSH 网页里重新找会话）；P2 版才真正「能继续」（省掉整段换端流程，≈ 8 步以上）。`est` |
| **风险** | P1 低（只加跳转，不写任何文件）。P2 **高**：写者唯一性/会话分叉，必须服务端配合（导入回 DSH），单独做前端等于制造坏数据。 |

### D3 手写板两行工具条：高频项是否都在第一行（指定必查点 ③）

| 项 | 内容 |
| --- | --- |
| **路径** | 路径 2 |
| **现状（核实）** | **已满足**——笔迹 / 橡皮 / 撤销**都在第一行**。<br>判据：`entry/src/harmony/ets/pages/Handwriting.ets:388-399`（`topBarTwoRows()`：竖屏且 `pageW < 640` 或实算宽 `topBarRequiredWidth() > pageW` → 两行）。<br>两行分支：`Handwriting.ets:2027` 进 `if (this.topBarTwoRows())`，**第一行** `:2030-2038` = 退出(`:2031`) / **笔迹**(`:2032`) / **橡皮**(`:2033`) / 手动框(`:2034`) / 插入(`:2035`) / **↶ 撤销**(`:2036`) / ↷ 重做(`:2037`)；**第二行** `:2044-2051` = 分页组(`:2045`) + **完成**(`:2046`)。<br>单行分支：`:2060-2070` 九项一行。<br>现有断言（防回归）`tools/test/handwritingToolbar.test.mjs`：`:385-413`「工具条顺序 = 退出/笔迹/橡皮/手动框/插入/撤销/重做/步进器/完成（9 项，无 Scroll）」、`:490-518`（两行分支以 `topBarTwoRows()` 为判据 `:506`，分页组+完成必须同在第二行 `:507-512`）、`:412`（`buttonCell` 调用数 = 8 项 × 2 分支 = 16）、`:662`（`LAYOUT_PORTRAIT` 必须出现 16 次）。<br>目标机上确实会折行（可复算）：竖屏 `itemSize = clamp(40, 视口宽 × 0.11, 64)`（`model/toolbarMetrics.ts:114`），1600×2560@2.375 ≈ 673.7vp 宽 → `itemSize=64`、`gap=9.6`；`topBarRequiredWidth()`（`Handwriting.ets:407-413`）≈ 7×64 + 64 + 16 + 283.6 + 8×9.6 + 16 ≈ **904vp > 673.7vp** → 两行。 |
| **砍法** | **不需要为「高频项进第一行」做改动**（已满足）。若仍要压第一行密度（P2，可选）：把低频的「手动框 / 插入 / 重做」并进二级菜单，第一行只剩 4 项。 |
| **预计省** | **0 步**（同一屏内都看得到，步数不变；只降低误触与认知负担）。 |
| **风险** | 做 P2 那版要同步改两条现有断言（`handwritingToolbar.test.mjs:412` 的 16、`:662` 的 16），否则测试直接红——收益（0 步）不值这个风险，建议**不做**。 |

### D4 导出区间没有快捷（P1）

| 项 | 内容 |
| --- | --- |
| **路径** | 路径 3 |
| **现状** | `ExportImportPanel` 的区间只有两个手打文本框（`:184` 开始日期、`:202` 结束日期），默认值空串（`model/exportImport.ts:1142-1145`），没有「今天 / 本周 / 本月」快捷，也没有日期选择器。 |
| **砍法** | 面板顶部加三个 chip（`今天` / `本周` / `近 7 天`），点了直接写出 `from/to`（`model/exportImport.ts` 已有 `parseDateRange` 可直接复用）。 |
| **预计省** | **2 步**（省掉两次输入框聚焦）＋ 消灭「手打日期格式错 → 导出失败 → 重来」的回退（回退时 ≥3 步）。 |
| **风险** | 低（纯前端 + 纯逻辑单测，无 IO 变更）。 |

### D5 新建日程无法指定日期（P1，缺陷而非纯步数）

| 项 | 内容 |
| --- | --- |
| **路径** | 路径 1（「记非今天的日程」变体） |
| **现状** | 新记录 `ts` 恒为 `nowIso()`（`components/RecordEditorView.ets:318`），编辑页没有日期字段（表单只有 标题/正文/记录者/完成情况，`:435-541`）；`appendRecord` 按 `ts` 决定写哪个日片（`services/scheduleStore.ets:316-318`）。因此在首页切到别的日期再点「新建」，记录**仍然落在今天**，事后也没有入口改日期（编辑旧记录走 `nextTsSameDate`，`:318` 保持原日期）。 |
| **砍法** | 编辑页加一行「日期」（默认取 `defaultDate`，写进 `ts`）；或 `RecordEditorView` 直接用 `defaultDate` 生成 `ts`。 |
| **预计省** | 对「记今天」0 步；对「记非今天」省 **≥3 步**返工（切日期→发现落错→想办法）。 |
| **风险** | **中高**：`ts` 是分片、排序（`nextTsSameDate`）、跨设备合并、`openIndexStore` 的基准，改它要连带过 `recordMerge` / `openIndex` / `date` 三组测试。 |

### D6 设置页是单一长滚动（P1/P2）

| 项 | 内容 |
| --- | --- |
| **路径** | 路径 3 / 4 / 5 共同的上游成本 |
| **现状** | 紧凑屏一个 `Scroll` 装五组（`Settings.ets:2403-2435`），顺序 `同步 → AI → 远程 → 数据 → 云端对话 → 关于`（`:2406/:2410/:2414/:2418/:2422/:2426`），底部固定「保存设置」（`:2097-2110`）。三处目标分别在第 3 / 4 / 5 组。 |
| **砍法** | P1：设置页顶部加分段锚点（同步 / AI / 远程 / 数据 / 关于），点一下直接定位。<br>P2：把「云端对话」「导出」提到首页第二入口。 |
| **预计省** | P1：路径 3 **−2 scroll**、路径 4 **−2**、路径 5 **−3**（合计 7 步）。P2 再加 2–3 步。`est` |
| **风险** | P1 低（只改 `Settings.ets` 布局）。**P2 高**：首页页头加第二个动作会直接破 `tools/test/indexHeader.test.mjs:57-65`（属性区里禁止出现 `headerActionOne` 等任何第二个动作，`:64-65`），必须同步改测试并重新定版页头。 |

### D7 `CalendarPicker` 是死代码，首页仍用系统三滚轮（P2）

| 项 | 内容 |
| --- | --- |
| **路径** | 路径 1（改日期变体） |
| **现状** | `components/CalendarPicker.ets:36` 定义了月视图 6×7 选择器（文件头注释说明就是为了替代「三列滚轮」），但**全仓库没有任何 import**（`node` 全量扫 `*.ets/*.ts/*.mjs/*.md` 只命中自身、`model/calendar.ts` 的注释、`docs/FEATURE-BACKLOG.md:20`、以及构建缓存）；首页展开的仍是系统 `DatePicker`（`pages/Index.ets:972-984`，`:973` 起）。 |
| **砍法** | 把 `DateBlock` 展开区从 `DatePicker` 换成 `CalendarPicker`（组件与 `model/calendar.ts` 都已就绪、已有单测 `tools/test/calendar.test.mjs`），只需接线。 |
| **预计省** | 跨月改期 **1 tap + 2–3 scroll**（滚轮每列都要滚）；同月改期约 0。`est` |
| **风险** | 低（纯展示组件 + 纯逻辑已测）；但该组件从未接线，首次上线要真机看一遍。 |

---

## 4. 改后目标（建议值）

> 「目标」是我建议的验收线；「阶段」P1 = 本轮可做（前端/纯逻辑，风险低），P2 = 需要接口/协议或较大改动。

| # | 路径 | 改前 | 目标 | 主要动作 | 阶段 |
| --- | --- | --- | --- | --- | --- |
| 1 | 记一条日程 | **7**（tap 4 + wait 3） | **4**（tap 3 + wait 1） | 首页底部「快捷记录」一行输入直接落盘（不跳编辑页）；或新建后自动聚焦标题 + 保存后不再等首页重载 | P1 |
| 2 | 加手写 | **8**（tap 4 + wait 4） | **6**（tap 3 + wait 3） | 「完成」即落盘回编辑页并自动保存（省 1 tap + 1 wait） | P1 |
| 2′ | 加手写 + 插图 | **11**（tap 6 + wait 5） | **9**（tap 5 + wait 4） | 同上；插图后不关闭面板（省 1 tap） | P2（OCR 后台化） |
| 3 | 导出 | **10**（tap 5 + scroll 3 + wait 2） | **6**（tap 4 + scroll 1 + wait 1） | 「今天 / 本周」chip（D4，−2）+ 设置页锚点（D6，−2）+ 导出后自动复制路径（−1） | P1 |
| 4 | 连远程 DSH | **8**（tap 3 + scroll 2 + wait 3） | **4**（tap 2 + wait 2） | 「一键重连最近成功地址」（D1，−3）+ 锚点（−1） | P1（D1-b） |
| 5 | 打开 chat 并想继续 | **10**（tap 3 + scroll 4 + wait 3） | **6**（tap 2 + scroll 1 + wait 3） | 「在电脑上继续」深链（D2 P1 版，−4） | P1（跳转）/ P2（真接管） |

**合计**：改前 **43 步**（手写按 8 算；若走「手写+插图」那条则 46）
→ P1 目标 **26 步**（省 17，约 −40%）→ P2 目标 **21 步**（再省 5：路径 2′ 11→9、路径 3 6→5、路径 5 6→4）。

---

### 4.1 本轮实际落地（B 批 D1-b + D2 P1；HEAD `6ecec62` 之上的未提交工作树）

> 口径仍按 §1（v1），每个数字都能按 §2 的记法逐项对上。**全部是源码复算，不是真机实测**
> （见 §5.2）。本轮只交付了「一键重连」与「在电脑上继续」两个入口，D4 / D6 等未做，
> 所以合计只降 1 步——这是真实结果，不按「建议目标」凑数。

| # | 路径 | 改前 | 改后（本轮） | 差 | 逐项算式（tap / scroll / wait） |
| --- | --- | --- | --- | --- | --- |
| 4 | 连远程 DSH（二次及以后） | **8**（tap 3 + scroll 2 + wait 3） | **7**（tap 2 + scroll 2 + wait 3） | **−1** | tap：`⚙ 设置` 1 + `重新连接 <host:port>` 1 = 2（原来要「点地址框」+「点打开远程控制」两个 tap，重连用**一个** tap 走同一条保存/跳转链路）；scroll 仍 2（重连按钮在远程组内、主按钮**之上**，不改变滚动量）；wait 仍 3（读设置 / 落盘+路由 / Web 首屏）。首次无记录时仍是 8。 |
| 5 | 打开 chat 并想继续（终点＝详情页） | **10**（tap 3 + scroll 4 + wait 3） | **10**（tap 3 + scroll 4 + wait 3） | **0** | 出口按钮固定在列表**之外**、底部常驻 → 到达详情页时已在视野内，**不新增 scroll**；终点也从「死路」变成「有出路」。 |
| 5′ | 同上，终点改为「在电脑上打开 DSH、可继续」 | **17**（tap 6 + scroll 6 + wait 5） | **12**（tap 4 + scroll 4 + wait 4） | **−5** | 改后：详情页 tap `在电脑上继续` 1 次（0 scroll）→ wait Web 首屏 1 次（地址走路由参数，**没有**落盘等待）。改前同终点 = 原 10 步 + 返回列表 1 tap + 返回设置 1 tap + 向上滚回远程组 2 scroll + 打开远程控制 1 tap + 落盘/路由 1 wait + Web 首屏 1 wait。 |

**合计**：改前 **43 步**（§2.0 口径）→ 本轮 **42 步**（路径 4 −1；路径 5 终点口径不变）。

- **路径 4 为什么只省 1 步、而不是本表 §4 先前估的 −3**：那 −3 把 D6（设置页锚点）省的
  2 个 scroll 也算进去了，并且把「粘贴 / 重敲地址」当成了可省动作——按 §1.2 第 1 条，
  **输入文字本身不计数**，能把地址预填好这件事只值 1 个 tap。D6 未做，所以 scroll 仍是 2。
- **路径 5′ 的 5 步不含**「在 DSH 网页里重新找到这条会话」的点击数：那段发生在 `RemoteControl`
  的内嵌 `Web` 里，依赖 DSH 网页 UI，本表没有覆盖（`unverified`）。
- **原 P1 目标 26 未达成**：它依赖 D6 锚点（路径 3/4/5 各 −2 scroll）、D4 快捷 chip、
  路径 1/2 的落盘改造，本轮均未做。已落地部分只拿到 43→42 这 1 步，差距 16 步全部属于未做项，
  不是本轮的回归。

---

### 4.2 本轮落地（B2 批：D4 导出区间快捷 chip + D6 设置页组锚点；HEAD `22acdb8` 之上的未提交工作树）

> 口径仍按 §1（v1）。下表数字全部是**源码复算 + 界面顺序推算**，不是真机实测（见 §5.2）。
> 只写这一轮**真正做了**的两件事：D4（路径 3 的区间快捷）与 D6（紧凑屏组锚点）。
> **宽屏（≥840vp）没有做锚点**（两列已短），所以下表「改后」只适用于紧凑屏；
> 宽屏下路径 3 只拿到 D4 的 chip 收益（tap −1），路径 4/5 与 §4.1 相同，且宽屏本身的 scroll
> 量本表没有测量（§5.3 已声明不覆盖宽屏）。

| # | 路径 | 改前 | 改后（B2） | 差 | 逐项算式（tap / scroll / wait） |
| --- | --- | --- | --- | --- | --- |
| 3 | 导出今天或一周 | **10**（tap 5 + scroll 3 + wait 2） | **7**（tap 5 + scroll 0 + wait 2） | **−3** | tap：`⚙ 设置` 1 + 锚点「数据」1 + chip「今天 / 本周」1 + `导出` 1 + `复制路径` 1 = 5（原来 from/to 两个输入框 2 tap，被 chip 的 1 tap 顶掉；锚点又 +1，所以 tap 总数不变）；scroll：锚点直接落到「数据」组顶，chip / 区间 / 导出按钮都在数据组首屏 → 0（−3 `est`）；wait：读设置 1 + 写盘 1 = 2（不变）。 |
| 4 | 连远程 DSH（首次） | **8**（tap 3 + scroll 2 + wait 3） | **7**（tap 4 + scroll 0 + wait 3） | **−1** | tap：`⚙ 设置` 1 + 锚点「远程」1 + 地址框 1 + `打开远程控制` 1 = 4（+1）；scroll：锚点直接落到远程组顶 → 0（−2 `est`）；wait 不变 3。 |
| 4′ | 同上（二次及以后，承接 §4.1 的 7 步口径） | **7**（tap 2 + scroll 2 + wait 3） | **6**（tap 3 + scroll 0 + wait 3） | **−1** | tap：`⚙ 设置` 1 + 锚点「远程」1 + `重新连接 <host:port>` 1 = 3；scroll 0（−2 `est`）；wait 3。 |
| 5 | 打开 chat 并想继续（终点＝详情页） | **10**（tap 3 + scroll 4 + wait 3） | **8**（tap 4 + scroll 1 + wait 3） | **−2** | tap：`⚙ 设置` 1 + 锚点「数据」1 + `云端对话` 1 + 会话行 1 = 4（+1）；scroll：跳到「数据」组顶后，还要向下越过整块导出/导入面板才到「云端对话」行，约 1 屏 → 1（−3 `est`）；wait 3。 |
| 5′ | 同上，终点改为「在电脑上打开 DSH、可继续」 | **12**（tap 4 + scroll 4 + wait 4，§4.1） | **10**（tap 5 + scroll 1 + wait 4） | **−2** | 在路径 5 的 8 步之后 +1 tap（`在电脑上继续`）+1 wait（Web 首屏）。 |

**合计**：改前 **43 步**（§2.0 首次口径）→ 本轮 **37 步**（−6）；
若承接 §4.1 的「路径 4 按二次及以后算 7 步」口径，则 **42 → 36 步**（同样 −6）。
相对原 §4 的 P1 目标 **26** 仍差 **11 步**，缺口全部属于未做项（§3 的 D1-P2、D2-P2、D5、D7 与
路径 1/2 的落盘改造），不是本轮回归。

- **只算 D4 值多少**：路径 3 **10 → 9**（tap 5→4：两个输入框换成 1 个 chip；scroll 仍 3、wait 仍 2）。
  三个 chip 的区间由 `model/exportImport.ts` 的 `quickRange()` 现算（`:1233`）：`今天` 两端都是今天、
  `本周` 是**本周一→今天**（周一为首日，沿用 `model/calendar.ts:67` 的 `WeekStart=1` 中文习惯，
  没有自创周日首日）、`近 7 天` 是今天−6→今天；写回的是 `parseDateRange` 认可的 `YYYY-MM-DD`
  （纯函数直接走 `parseDateRange` 做规范化，面板里没有第二套格式化）。
  「手改后以手改为准」靠**不存状态**实现：chip 高亮由 `isQuickRangeActive()` 现算（`:1259`），
  用户一改文本就自动失配。手打格式错→导出失败→重来的回退成本不进合计（§1.2 第 7 条）。
- **只算 D6 值多少**：路径 3 **10 → 8**、路径 4 **8 → 7**（首次）/ **7 → 6**（二次）、路径 5 **10 → 8**。
  注意它**净省 1–2 步而不是 2–3 步**：锚点本身也要 1 个 tap，只是把 2–3 个 scroll 换掉了
  （§3 D6 原来估的「路径 3 −2 / 路径 4 −2 / 路径 5 −3」没把这 1 个 tap 算进去）。
- **为什么路径 5 只省 2 步**：锚点「数据」落在数据组**顶部**，而「云端对话」行排在整块导出/导入
  面板之后（约 1 屏），所以仍要 1 个 scroll。若将来加第 6 个「对话」锚点，可再 −1。
- **`wait` 一个都没少**：D4 / D6 都是纯前端（写两个输入框 / 滚动），不减少任何异步等待。
- **实现落点**（行号以本轮工作树为准，可复核）：
  - D4：`components/ExportImportPanel.ets:422`（`@Builder QuickRangeRow()`）、`:515`（`build()` 里
    `HintLine` 之后、空态之前插入）、`:348`/`:366`（原 from/to 输入框，未改）、`:583`（`导出`）、
    `:467`（`复制路径`）；纯逻辑 `model/exportImport.ts:1233`（`quickRange`）/ `:1259`（`isQuickRangeActive`）。
    空态的「填今天」（`:69` 常量、`:519` 的 `EmptyState`）**保留**：它是 `docs/STATE-UI.md` §5 的
    空态契约（空态永远有出路），与 chip 的「今天」重复但语义不同（前者只在「还没导出过」时出现）。
  - D6：`pages/Settings.ets:2272`（`@Builder GroupAnchorBar()`）、`:2246`（`GroupAnchorChip`）、
    `:2161`（`jumpToGroup`，真跳转在 `:2170` 的 `pageScroller.scrollTo({ xOffset: 0, yOffset, … })`）、
    `:2149`（`measureGroup`）、`:2583`（`CompactBody` 起点）、`:2587`（锚点行是 Scroll 内容第一个孩子）、
    `:2592/:2599/:2606/:2613/:2624`（五个组的 `onAreaChange` 测量点）。
- **锚点为什么不算「挡住首屏表单」**：它放在 `Scroll` 内容的**第一个孩子**（组头之上），
  随内容一起滚走、不悬浮；不是固定工具条，也不覆盖任何输入框（`Settings.ets:2587`）。
- **真机项（一律 `unverified`，见 §5.2）**：
  1. `scroll` 数仍是 `est`：锚点行高 40vp、组间距按令牌推算；
  2. `Area.position.y` 的基准（相对父 `Column` ⇒ 等于滚动内容偏移）**没有真机证据**；
     若真机上它给的是视口坐标，跳转会偏（这是本批最需要真机复核的一条）；
  3. `scrollTo({ animation: { duration: 250 } })` 的实际动画观感、以及 250ms 内连点是否排队；
  4. 360vp 宽下 5 个等宽锚点 chip 是否裁字/溢出（算术上够：328−4×8 = 296 → 每个 ≈59.2vp，
     两字 caption 约 28vp；但**没在真机上排版验证**）；
  5. 宽屏（≥840vp）分支**没有锚点**，路径 3/4/5 在宽屏下不享受本批收益。

---

### 4.3 本轮落地（B3 批：路径 1 自动聚焦 + 保存后局部刷新；路径 2 完成即自动保存；D1-P2 失焦归一；HEAD `8435b38` 之上的未提交工作树）

> 口径仍按 §1（v1），每个数字都能按下表算式逐项复核；**全部是源码复算，不是真机实测**（见 §5.2）。
> 本轮**只做了**路径 1 / 路径 2 的落盘改造与 D1 的 P2；D2-P2（真接管）、D5（新建可指定日期）、
> D7（`CalendarPicker` 接线）与「首页底部快捷记录」**都没做**——所以下表不出现它们，
> §4 的「P1 目标 26」本轮也仍未达成（见下「合计」）。

| # | 路径 | 改前 | 改后（B3） | 差 | 逐项算式（tap / scroll / wait） |
| --- | --- | --- | --- | --- | --- |
| 1 | 记一条日程 | **7**（tap 4 + wait 3） | **5**（tap 3 + wait 2） | **−2** | tap：`新建` 1 + 正文框 1 + `保存日程` 1 = 3（**点标题框**那一次被自动聚焦省掉）；wait：冷启动首屏 1 + 编辑页 bootstrap 1 = 2（**保存 → 返回 → 首页**这一段已不再等异步，见下）。 |
| 2 | 加手写 | **8**（tap 4 + wait 4） | **6**（tap 3 + wait 3） | **−2** | tap：`新建` 1 + `手写板` 1 + `完成` 1 = 3（**`保存日程`** 被「完成即自动保存」省掉）；wait：编辑页 bootstrap 1 + 手写板挂载/草稿恢复 1 + OCR 批处理 1 = 3（原来第 4 个 wait「落盘 + 回首页」被吸收进 OCR 返回，见下）。 |

**合计**：承接 §4.2 的口径 **37 → 33**（−4）；相对 §2.0 的首次口径 **43 → 33**（−10）；
若承接 §4.1 的「路径 4 按二次及以后算 7 步」口径，则 **36 → 32**。
相对原 §4 的 **P1 目标 26** 仍差 **7 步**，缺口全部属于未做项（D2-P2 / D5 / D7 / 快捷记录 /
路径 1 那 1 个 bootstrap wait），不是本轮回归。

- **路径 2 达标**：§4 目标 6（tap 3 + wait 3）**达成**。
- **路径 1 未达 §4 目标 4**，实际 **5**：差的正好是「**编辑页 bootstrap**」这 1 个 wait。本轮只做了
  「自动聚焦标题 + 保存后不再全量重载」两件事，**没有**改 `RecordEditorView.bootstrap()`
  （`scheduleStore.ensureReady` + `settingsStore.load` 仍在进页时 `await`）。按 §1 的定义
  （「一次必须等异步返回才能继续的动作」）它仍记 1 个 wait。要说它「不再是必经等待」，需要真机证明
  「进页即可输入、且保存不依赖这次读取」——**没验过，所以不写进「改后」**。
  若将来真机确认并改口径（§1 要求升版本并在本文件留痕），路径 1 才是 4（tap 3 + wait 1）。
- **为什么「保存 → 返回 → 首页」那 1 个 wait 真的没了**：`RecordEditorView.save()` 里
  `scheduleStore.appendRecord()` 是**同步写**，并在同一栈内触发派生索引钩子
  `openIndexStore.applyRecord()`；返回首页后 `Index.onPageShow()` 先消费一次性标记，命中时**只**做
  `reload()`（同步读当日分片）+ 单行对账，**不再直接调用** `reconcileIfDue()`（跨 30 天分片对账）/
  **不再** `loadSummary()` / **不再** `paneTick + 1`。整条链路上没有 >300ms 的异步等待，所以这一步从 1 wait 变 0。
  （精确一点：「全部未完成」tab 的 `reload()` 走 `openIndexStore.pendingRecords()`，它内部还会做一次
  **被 15s 节流**的索引自愈（`openIndexStore.ets:292`）——省掉的是首页自己那次**显式**全量对账，
  不是「这条链路上永远不存在 reconcile」。）
- **路径 2 为什么正好 6**：自动保存发生在「从手写板 `router.back()` 回编辑页」的同一帧
  （`onRefreshTick → applyPendingInkResult() → maybeAutoSaveAfterInk() → save()`）；
  `save()` 同步落盘后 `onSaved` 再 `router.back()` 回首页。用户不再点「保存日程」，也不再单独等一次
  落盘/回首页 —— 省下的正是 1 tap + 1 wait。
- **失败路径一条都没被吞**（`docs/FAILURE-MODES.md` 纪律）：
  - 手写识别失败 / 取消：手写板 `catch` / 取消分支只 toast 原因，**不写**自动保存信号、不动草稿，用户留在手写板可重试；
  - 空笔迹（无识别文字、无插入对象）：信号写 `''` + toast「没有识别到文字：原图已保留，回到编辑页补充正文后再保存」，**不自动保存**；
  - 用户在编辑页还没填标题：toast「手写内容已回填：先填标题，再点「保存日程」」并停在可编辑状态（**不写半条无标题记录**）；
  - 编辑页还没就绪（`ready` / `loaded` 为假）：toast 说明且**不**自动保存（避免 `originalTs` 未读到而写错日期）；
  - 自动保存写盘失败：`save()` 原有 `catch` toast「保存失败：…」，留在编辑页，内容与草稿都还在；
  - 返回首页后读不到刚保存的那一行（极端情况）：`reconcileSavedRow()` 兜底做一次 `reconcile()` 重读并
    toast「返回列表时没读到刚保存的日程，已重新加载」，**不静默**。
- **硬约束的落实**：返回列表立刻能看到刚保存/修改的那条（`reload()` 同步读分片 + 按 `id` 折叠取最新 `ts`，
  另有上面的对账兜底）；跨设备合并语义未改（仍是 `appendRecord` 追加 + 读侧 `foldById`，
  `docs/DATA-CONTRACT.md` 一个字未动）；`handwriting.result` 的「追加到正文」语义未改
  （`applyPendingInkResult()` 的回填逻辑一行未动，只多了一个返回值）。
- **D1 的 P2（失焦即归一）不改变步数**：它把「补 `http://`」从点「打开远程控制」提前到输入框失焦，
  并在真的改了文本时给一次 toast（同一段原文只提示一次）。整条路径的 tap / scroll / wait **都没有变化**
  （路径 4 仍是 §4.2 的 7 / 6），所以不进上表；它买的是「填错地址时立刻看见」，不是步数。
  边界：纯令牌片段（`k=…` / `?token=…`）与非法地址**不改写输入框**（解释留给打开时的红字），
  也**绝不**把已保存令牌合进输入框（凭据纪律，`docs/CHAT-APP.md`）；保存/跳转顺序未改
  （归一方法里没有 `settingsStore.save` / `router.pushUrl` / `openRemote()`）。
- **实现落点**（行号以本轮工作树为准，可 `read` 复核）：
  - 路径 1：`components/RecordEditorView.ets:94`（`@Prop autoFocusTitle`）、`:776`（`.defaultFocus(...)` 三条件）、
    `:630`（`save()` 写一次性标记，在 `onSaved` 之前）、`:641`（`savedMarkerOf()`，`date` 按 `ts` 算）；
    `pages/Edit.ets:124`（传 `autoFocusTitle: true`）；
    `pages/Index.ets:263-281`（`onPageShow` 保存返回分支）、`:302`（`consumeSavedMarker()` 读后即清）、
    `:317-334`（`reconcileSavedRow()` 三条早退 + 兜底）、`:539`（右栏保存也消费标记）；
    纯逻辑 `model/homeRefresh.ts:19/50/68/112`（键 / 编码 / 解码 / 版本包含）。
  - 路径 2：`entry/src/harmony/ets/pages/Handwriting.ets:1471-1475`（`autoSaveReady` + 一次性键 +
    空笔迹 toast）、`:935`（退出路径清键）；`components/RecordEditorView.ets:250-253`
    （`onRefreshTick` 先回填再判定）、`:338-371`（`applyPendingInkResult()` 返回 `applied`，
    四键「读后清空」未变）、`:385-407`（`maybeAutoSaveAfterInk()` 四类早退）。
  - D1-P2：`pages/Settings.ets:2031-2065`（`normalizeRemoteOnBlur()`）、`:451`（去重键）、
    `:2579-2581`（装配）；`components/settings/RemoteSection.ets:96`（回调 prop）、`:340-342`（`.onBlur`）。
- **真机项（一律 `unverified`，见 §5.2）**：
  1. `defaultFocus` 在真机上是否真的弹出软键盘、页面转场期间会不会被抢焦点——本机无 SDK、无真机，未验；
  2. 从手写板返回时 `@Watch('onRefreshTick')` 的触发时序，以及自动保存与 `router.back()` 的先后观感；
  3. 「返回列表立刻看到刚保存的那条」是源码级结论（同步读分片），真机上列表首帧的刷新观感未测；
  4. 保存时写一次性 `AppStorage` 标记、首页读后即清，在真机页面栈里是否严格只消费一次（单页栈上成立，未实测）；
  5. 「编辑页 bootstrap 不算必经等待」这一口径**没有**采用（需要真机证据），所以路径 1 记 5 而不是 4。

**已知限制（独立评审 `docs/REVIEW-b3-batch.md` 的 P2，均不阻塞；本批不修，登记在此）**：
- **P2-1 Detail 间接路径的陈旧标记**：`Detail → Edit → 保存 → 返回 Detail → 再返回首页` 时，标记要等回到
  首页才被消费；若这期间在详情页对同一条记录做了 AI 结构化（写出更晚的 `ts`），首页的「同 id 同 ts」
  对账会失配并兜底重载 + 一条「没读到刚保存的日程，已重新加载」toast（记录本身是可见的，只是文案偏误导）。
  建议下一批把判据放宽成「同 id 且 `ts` 不早于标记」或让 `Detail.onPageShow` 消费标记。
- **P2-4 对账判据偏严**：同上，精确 `ts` 相等在跨设备并发 / 详情页二次写入时会误报（后果只是多一次
  `reconcile()` + 一条 toast，不会写坏数据）。「不再跑 reconcileIfDue」的精确含义见上（`pendingRecords()`
  内部仍有被节流的自愈）。
- **P2-3 双 toast**：点「打开远程控制」会先触发地址框失焦（归一 toast）再触发 `openRemote()` 的「已保存」
  toast；非 `manual` 方式下 `openRemote()` 还会按方式字段重算地址，所以失焦提示的未必是最终地址。
  行为/顺序没问题，观感待真机确认。
- **P2-2 / P2-5 / P2-6**：`defaultFocus` 从手写板返回是否重复抢焦点、新测试用例对文案/缩进的脆弱度、
  「只插图不写字（`body` 与 `objectsJson` 都空）」时按设计不自动保存——都属 `unverified` 或刻意取舍。

---

### 4.4 本轮落地（B4 批 `14b181a` 已提交 + 需求收窄后的待提交改动：D5 新建时可选日期 + D7 首页日历接线 + B3 评审 P2-1）

> 口径仍按 §1（v1），下表每个数字都能按算式逐项复核；**全部是源码复算，不是真机实测**（见 §5.2）。
> 本批最终形态（D5 收窄）**只做**三件事：**D5**（**新建记录时可选日期**）、**D7**（首页日期条换成 `CalendarPicker`）、
> **B3 评审 P2-1**（保存行对账判据放宽）。§3 里其余可砍点（D2-P2 真接管、首页底部「快捷记录」、
> 路径 1 的 bootstrap wait）**都没做**。
>
> **重要：改期不是功能（用户 2026-11-19 拍板）。** B4 批 `14b181a` 一度实现了「已有记录跨日迁移 +
> 旧日墓碑 + 更早日期拒绝」的读法；需求随后收窄为「日期只在新建时选一次」，那套跨日迁移机制、
> 旧日墓碑写入与拒绝文案/分支已全部删除（待提交的收窄改动）。**已有记录保存只在原日期追加更晚版本，
> 日期行只读并显示「创建时选定，不可改」**，没有 picker、没有点击切换。下文不再保留任何「改日期」路径行。
>
> 先说结论：**这三项都不减少五条基准路径的 tap/scroll/wait 合计**——D5 修的是「记非今天」这条
> **原本不可达**的变体（新建时直接选日期即可），D7 只是换控件（tap 与 scroll 之间换算，净步数不变），
> P2-1 只是少一次误报 toast。所以 §4.3 的合计 **33 步原样不变（33 → 33）**，与 §4「P1 目标 26」的
> 缺口仍是 **7 步**，且缺口全部属于未做项。

#### D5 的影响（只算 tap / scroll / wait）

| 变体 | 改前 | 改后（B4 收窄） | 差 | 逐项算式 |
| --- | --- | --- | --- | --- |
| 路径 1（记**今天**，基准路径） | **5**（tap 3 + wait 2） | **5**（tap 3 + wait 2） | **0** | 新建时日期默认就是今天，`tsForDate(今天, now)` 与旧实现的 `nowIso(now)` **逐字节相同**（有单测钉死），不点日期行就不多一次 tap。 |
| 1′ 记**非今天**（新记录落到别的日期） | **不可达** | **7**（tap 5 + wait 2） | 从「做不到」到「做得到」 | tap：`新建` 1 + `日期` 行 1 + 日期格 1（同月；跨月再 +1~2 次 `‹` 翻月，`est`）+ 正文框 1 + `保存日程` 1 = 5；wait：冷启动首屏 1 + 编辑页 bootstrap 1 = 2。改前：`ts` 恒为 `nowIso()`，在首页切到别的日期点「新建」仍写今天（`defaultDate` 只当副标题），事后也无法补记到别的日期 → 只能删掉重记（≥3 步返工，且删除本身还要 1 tap）。 |

> 编辑**已有**记录不再有「改日期」变体：日期行只读（显示记录原日期 + 「创建时选定，不可改」），
> 没有 picker、没有点击切换；保存仍是一次普通同日追加。原 B4 批 `14b181a` 的 `1″`（往后改）/`1‴`（更早日期被拒）
> 两行随需求收窄删除，不计入任何合计。

#### D7 的影响（首页日期条：三列滚轮 → 月视图）

| 场景 | 改前（系统 `DatePicker`） | 改后（`CalendarPicker`） | 差 |
| --- | --- | --- | --- |
| 同月改期 | tap 1（展开）+ scroll 1（日列，`est`） | tap 2（展开 + 日期格）+ scroll 0 | tap +1 / scroll −1 |
| 跨月改期（后退 2 个月） | tap 1（展开）+ scroll 3（月列 2 + 日列 1，`est`） | tap 4（展开 + `‹`×2 + 日期格）+ scroll 0 | tap +3 / scroll −3 |

按 §1 的口径，tap 与 scroll **分别计数、不互相折算**，所以上表**不进「合计」**：五条基准路径合计
仍是 **33**。D7 真正买到的是「一眼看整月、目标日一次点中、跨月路径可解释」，**不是**步数；
§3 D7 里「省 1 tap + 2–3 scroll」的旧估按本表口径**不成立**，此处更正为「tap↔scroll 换算」。
另外 §3 D7 的「死代码」判断已失效：`CalendarPicker` 现在有 **2 处**真实接线
（`pages/Index.ets:1106` 首页日期条、`components/RecordEditorView.ets:915` 记录编辑器），两者复用同一组件。

#### 4.4.1 `ts` / 分片 / 合并语义（可逐步复核，收窄后）

1. **`ts` 仍是唯一的两用字段**：既是分片键（`recordDateKey(ts)` → `schedules/<日期>.jsonl`），又是同一 `id`
   的版本序（`foldById` / `applyRecordToIndex` 永远保留 `ts` 较晚的一条）。**契约零改动**：
   `docs/DATA-CONTRACT.md` 一个字节没改（`git status docs/DATA-CONTRACT.md` 干净）。
2. **新建记录：`ts = tsForDate(选定日期, now)`**（`model/recordSaveTs.ts:57`）。先取 `nowIso(now)`
   （`YYYY-MM-DDTHH:MM:SS±HH:MM`，本地偏移），再把前 10 个字符换成选定日期；**字节形状与 `nowIso(now)`
   完全相同**，不引入第二种时间格式、不写 UTC `Z`。日期键先过 `^\d{4}-\d{2}-\d{2}$` + 本地日历回读
   （`new Date(y,m-1,d)` 三字段回读，不用 UTC 解析），`2026-02-30` / `2026-13-01` 一律返回空串；
   选定日为今天时与 `nowIso(now)` 逐字节相同（有单测钉死）。
3. **已有记录：只在原日期追加更晚版本 `ts = nextTsSameDate(原 ts, now)`**
   （`resolveSaveTs()` `model/recordSaveTs.ts:71`、调用点 `:88`；编辑器 `RecordEditorView.ets:616` 写 `ts: plan.ts`）。
   日期来自原 `ts`，`chosenDate` **故意不参与**决策（`:87` 注释明示）。`nextTsSameDate` 取
   `max(now, 原时刻+1ms)`，23:59:59.999 的钳位行为原样继承（旧测试 `date.test.mjs` 未改动）。
4. **不存在跨天身份问题**：一条记录从创建到删除**永不换日片**——已有记录的日期行只读、不弹 picker，
   保存只有一次同日追加。因此没有「旧日幽灵」「两条跨日版本谁折叠赢」「写入顺序」这类问题。
   **删除仍是另一套独立、已上线的软删除功能**（`model/undoDelete.ts` 的 `deleted:true`，入口在
   `pages/Index.ets`，未改动）；保存链路不再 import `softDeleteRecord`、不再写 `deleted:true` 行。
5. **失败路径逐条（`docs/FAILURE-MODES.md` 纪律：不静默、不写半条）**：
   - **新建日期非法** → `tsForDate` 返回空串 → `resolveSaveTs` 给 `ok:false` + 中文原因
     （`recordSaveTs.ts:78`）；编辑器的 `!plan.ok` 守卫（`:608`）在第一次 `appendRecord` **之前** toast 并 `return`。
   - **原 `ts` 无法解析** → `ok:false` + 「原记录时间戳无法解析…」（`recordSaveTs.ts:83-85`），同样零写入。
   - **`appendRecord` 抛错** → 既有 `保存失败：…` toast + `return`，没有标记、没有 `onSaved`，记录仍是旧版本
     （单条 `writeSync` 的部分写是既有风险）。
   - 以上每条都**不写半条记录**；成功路径只有 **1 条** toast（`:668`），一次性 `SAVED_MARKER_KEY` 与
     `onSaved()`（`:672`）无条件执行，首页照常走「局部刷新 + 单行对账」，不再出现 B3 评审提过的双 toast。

#### 4.4.2 实现落点（行号以收窄后的工作树为准，可 `read` 复核）

- **纯逻辑（新文件）**：`model/recordSaveTs.ts`（90 行）——`SaveTsPlan` 接口 `:19`、`tsForDate()` `:57`、
  `resolveSaveTs()` `:71`（已有记录故意忽略 `chosenDate`，`:87`；非法新建日期 `:78` / 原 ts 不可解析
  `:83-85` 均 fail-closed）。
- **编辑器**：`components/RecordEditorView.ets`（1036 行）——`dateEditable()` `:436`（新建可编辑 /
  已有记录只读）、`save()` 的 `resolveSaveTs` 调用与 `!plan.ok` 守卫 `:607`–`:610`、`ts: plan.ts` `:616`、
  单条成功 toast `:668`、`onSaved` `:672`；日期行只读门控 + 文案「创建时选定，不可改」`:860`，
  仅新建且展开时内嵌 `CalendarPicker` `:869`。
- **D7 首页**（收窄未动）：`pages/Index.ets:72`（import）、`:462`（`pickDate`，五个动作与原 `onDateChange` 等价）、
  `:1036`（`DateBlock` 注释）、`:1106`（`CalendarPicker`）；系统 `DatePicker(` 已从首页移除。
- **B3 P2-1**（收窄未动）：`model/homeRefresh.ts:128`（`containsRecordVersion` 改成「同 id 且 ts 不早于标记 ts」，
  可解析时按时刻比较、任一侧不可解析退回精确字符串相等）；调用点 `pages/Index.ets:317` 注释同步，
  方法体一字未改，`b3Batch.test.mjs` 的 B3-05/B3-09 **未改一行**即通过。
- **本轮删除**（收窄 diff，4 个已跟踪文件）：`model/recordDateMove.ts` 与 `tools/test/b4DateMove.test.mjs`
  两个文件物理删除；`RecordEditorView.ets` 不再 import `softDeleteRecord`；`b4DateUi.test.mjs` 删掉测被移除
  功能的用例。`pages/Index.ets` 的正常删除入口未动。
- **测试与门禁**：新 `b4SaveTs.test.mjs`（221 行 / **20 例**），另有 `b4DateUi` **21**、`b4CalendarWiring` **18**、
  `b4SavedRow` **14**（共 73）。全量 **2306 例 / 2305 pass / 0 fail / 1 skip**（上一基线 2309 / 2308 / 0 / 1，
  −3 是刻意删除测被移除功能的用例）；`validate-app` **8/8**；`tsc` exit 0；`overlay applied=false`。

#### 4.4.3 已知限制（本批不修，登记在此）

- **草稿不存日期**：`editor.draft.*` 仍只有标题/正文，进程被杀恢复后日期回到 `defaultDate`/新建默认
  （不会写出错误日期，只是要重选一次）。
- **`tsForDate` 的偏移取「现在」的偏移**（评审 P2-2，仍适用）：新建记录若选了非今天（尤其跨 DST 的过去/
  未来日期），会带上当前偏移（中国无 DST，影响面小）；日期键 round-trip 不受影响，但同一 `id` 若另一设备
  按目标日真实偏移写过版本，`Date.parse` 可差 1 小时（`unverified`：真机 DST 未测）。
- **年份 1–99 的日期键被拒**（评审 P2-1，仍适用）：`new Date(y,m-1,d)` 把 0–99 映射到 1900+，回读不一致 →
  判非法。日历选择器的实际可点范围远大于此，属边界取舍。同一来源还有一个更窄的口子：
  `monthGrid(9999,12,…)` 的补位格会出现 `10000-01-07`（11 位），首页 `pickDate` 的 `length !== 10`
  守卫会**静默忽略**这次点击（可点但没反应）——只有翻到 9999 年 12 月才会遇到，登记不修
  （`unverified`：真机未翻到该边界）。
- **静态文本断言的表达力上限**（评审 P2-6，仍适用）：`b4DateUi` / `b4CalendarWiring` 仍以「读 `.ets` 文本」
  为主，`b4SaveTs` 则是纯逻辑实跑；前者能挡住「守卫位置错 / 单条 toast 丢失 / 标记被条件包住」这类回归，
  但挡不住 ArkTS 编译错误与真机行为；伪代码级的缩进/文案改动会让断言变脆，改 UI 时要同步改断言并注明原因。
- **真机项一律 `unverified`**：本机无 DevEco/SDK、`hdc list targets` 为空。日期行的只读文案、日历面板的排版、
  软键盘遮挡、「保存后返回首页立刻看到那条」的观感、`CalendarPicker` 翻月的点击热区，
  都只有源码级与静态断言级证据。**设备没连上不许报“已验证”。**

---

## 5. 本表的可信度边界

### 5.1 可复算（读源码数的，任何人可用 grep/node 复核）

- **所有 `tap` 数**：每个 tap 都对应一个真实的 `onClick` / `Button` / `Toggle` 定义行号（见 §2 各表），
  行号来自 `grep`/`read` 工具，未手写。
- **所有 `wait` 数**：每个 wait 都对应一个 `await` / 异步 IO 调用点（`ensureReady`、`load`、
  `appendRecord`、`Manager.run()`、`Web` 挂载、`pullUrl` 等），同上。
- **D3 的「已满足」**：`Handwriting.ets:2030-2038` 的分支代码 + `handwritingToolbar.test.mjs:412-439`
  的断言，两者互相印证，可直接读。
- **D1 的 `?k=` 不一致**：`remoteUrl.ts:170` 与 `packages/dsh-dots/src/remote/routes.ts:177` 对读即可确认。
- **D1 的「无一键重连」**（**改前基准**；本轮已落地，见 §4.1）：`settingsStore.ets:137-166` 字段清单
  + `:263-271` 键常量清单，两份都没有 `lastOk*`；写本节时全仓库 `lastOk|最近成功` 只在
  `docs/CONFIG-UX.md`（设计稿）里出现，未落地。
- **D2 的「完全没有入口」**（**改前基准**；本轮已加跳转出口，见 §4.1）：`ChatDetail.ets` 全文无
  `TextInput` / `TextArea` / `Button('发送')`，只有 `:317-349` 的 `build()`。
- **D7 的「死代码」**（**B4 批已失效**，见 §4.4：首页与记录编辑器两处真实接线）：`node` 全量扫过 `.ets/.ts/.mjs/.md/.json`，`CalendarPicker` 除自身定义、
  `model/calendar.ts` 注释、`docs/FEATURE-BACKLOG.md:20` 与构建缓存外无引用。
- **D3 的折行算术**：`904vp > 673.7vp` 由 `toolbarMetrics.ts:114` + `Handwriting.ets:407-413` 的公式
  与常量代入得出，可复算。

### 5.2 依赖真机交互（unverified，**不是**「已验证」）

- **所有 `scroll` 数（标 `est`）**：由「组顺序 + 每组控件数 + 令牌高度」估算屏数，**没有实测**。
  屏高、行高、字号在不同设备/系统字号下会变，真机上可能 ±1。
- **键盘遮挡**：编辑页未声明键盘避让（全仓库无 `keyboardAvoidMode` / `expandSafeArea`），
  「点正文时保存按钮是否被软键盘顶出可视区」**无法从这里判断**；若是，路径 1 要 +1 `scroll`。
- **是否 >300ms**：OCR 批处理（`OcrBatchManager.run`）与导出写盘（`exportSchedules`，同步）是否
  真的超过 300ms 阈值，只能真机计时。导出少量记录可能 <300ms（若如此，路径 3 的 wait 应变 1）。
- **系统弹窗计次**：相册选择器（`PhotoViewPicker`）、剪贴板长按菜单、明文 HTTP 是否被平台拦
  （`RemoteControl.ets` 文件头注释提到可能报错）——都按 §1.3 不计入，但真机上可能额外打断流程。
- **设备可用性**：本机 **`hdc` 不在 PATH**（`hdc list targets` → `CommandNotFoundException`），
  **没有任何真机验证**。因此本文件不出现「已验证」字样；凡涉及真机的结论一律 `unverified` / `est`。
- **§4.1 新增的两个入口（本轮）同样 `unverified`**：
  - 「重新连接 <host:port>」按钮是否真的落在远程组的**可视区**、与「打开远程控制」之间的间距是否被
    挤成两屏（`RemoteSection.ets` 里它插在主按钮之上，只有源码顺序证据，**没有**真机排版证据）；
  - `ChatDetail` 底部的「在电脑上继续」是否被系统手势条 / 软键盘遮挡（该页列表 `layoutWeight(1)`，
    按钮在其外，理论上常驻底部，**真机未验**）；
  - `Web.onPageEnd` 是否等价于「页面真的可用」（它只说明**主文档**加载完成；DSH 前端 JS 初始化失败、
    或 WebSocket 被判 `ERR_WS_UPGRADE(-173)` 时，`onPageEnd` 仍可能已触发）→ 所以「记录最近成功」
    不等于「已验证这条连接可用」，这一条只是**最接近**成功的 App 侧信号，`unverified`。
- **行号会漂（重要）**：写本表期间，工作区就在被别的分支并行改动——
  `entry/src/main/ets/model/remoteUrl.ts` 从 273 行涨到 **697 行**（新增 `parseRemoteInput` /
  `mergeRemoteToken` / `extractTokenFromQuery` / `TOKEN_KEYS=['token','k']` / `canReconnect` /
  `encodeLastOk` / `reconnectLabel` 等，`git diff` 可见 +423 行），
  `tools/test/handwritingToolbar.test.mjs` 也加了约 122 行（测试行号整体后移，
  本文件已按改动后的位置更新为 `:385-413` / `:490-518` / `:412` / `:662`）。
  因此：**本表的「改前」讲的是 HEAD `379fcc5` 的行为**；若工作区继续变化，
  用 `git show 379fcc5:<file>` 复核行号，而不是看工作副本。
  其中 D1 的 ③（`?k=` 识别）与 ⑤（最近成功重连）已有人在实现——**它们从「可砍点」变成「在做」**，
  这正好说明本表量出的数是真问题；改完后请按 §6 末段补「改后」行。

### 5.3 本表**没有**覆盖的

- 宽屏/横屏主从布局（`Index.ets:1536-1581`）下的路径——横屏「新建」直接变右栏表单，步数会更少；
- 手势、语音、桌面小组件等其它入口；
- 首次使用引导（`handwriting.tipShown`）与权限弹窗；
- 同步/推送（`SyncSection`）路径——本批不在范围内。

---

## 6. 怎么自己复算（给后续改的人）

```bash
cd apps/arkui-schedule

# 1) 任取一个落点行号，打印原文（行号不许编）
node -e "const s=require('fs').readFileSync('entry/src/main/ets/components/RecordEditorView.ets','utf8').split('\n');console.log(s[317])"

# 2) 手写板工具条两行分支与判据
node -e "const s=require('fs').readFileSync('entry/src/harmony/ets/pages/Handwriting.ets','utf8').split('\n');[388,2027,2030,2036,2044,2046].forEach(n=>console.log(n+': '+s[n-1].trim()))"

# 3) 设置页组顺序（紧凑屏）
node -e "const s=require('fs').readFileSync('entry/src/main/ets/pages/Settings.ets','utf8').split('\n');s.slice(2399,2432).forEach((l,i)=>console.log((2400+i)+': '+l.trim()))"
```

改完任何一条路径后，**必须**在本文件对应表格里补一行「改后 = M 步（tap a + scroll b + wait c）」，
并保留原「改前」行——两份数字并存，才有对比。
