# 功能候选（按性价比排序）

> 调研范围：`apps/arkui-schedule`（HarmonyOS + Android / ArkUI-X）、`docs/ROADMAP.md`、`docs/DATA-CONTRACT.md`、
> `docs/UI-DESIGN.md`、`docs/ARCHITECTURE.md`、`docs/CONTRACT.md`、`docs/VERIFICATION.md`。
> 本轮**只读 + 只写本文件**，未改任何代码。
> 调研时间：2026-11-16。工作量只取三档：**0.5 天 / 1 天 / 2–3 天**。
> 「改动面」里的 `文件:行` 都是本文件写作时实测的行号；「验收」里的自动化断言默认走既有命令：
> `node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json` →
> `node --test "apps/arkui-schedule/tools/test/*.test.mjs"`（现 49 个测试文件）→
> `node apps/arkui-schedule/tools/validate-app.mjs`（8 条规则）。

---

## 0. 先读现状：这些已经有了，不要再提

| 已具备 | 落点（证据） |
| --- | --- |
| 搜索 + 状态/作者筛选（与 tab 正交的纯逻辑） | `model/query.ts`、`pages/Index.ets:1216-1290`、`tools/test/query.test.mjs` |
| 软删除 + 5 秒撤销（墓碑追加，不改历史行） | `model/undoDelete.ts`、`pages/Index.ets:626-808` |
| 日历选择器（6×7 固定网格，纯整数运算） | `model/calendar.ts:237-276`、`components/CalendarPicker.ets` |
| 「今日待办 / 全部未完成」两段 + 未完成索引 | `pages/Index.ets:999-1029`、`services/openIndexStore.ets:287`、`model/openIndex.ts` |
| 主从布局（≥840vp 左日期条 / 右列表+详情+编辑） | `components/PageLayout.ets`、`common/uiTokens.ts`、`pages/Index.ets:1538-1585` |
| 每日 AI 汇总块（列表第一项，五态） | `model/dailySummary.ts`、`services/summaryStore.ets`、`pages/Index.ets:1067-1215` |
| 多 AI 源 + 测试连接 + 错误分级 | `model/aiProvider.ts`、`model/syncError.ts`、`pages/Settings.ets` |
| 手写板：对象层（框/图片/表格）、表格逐格 OCR、分页、笔迹设置菜单、草稿 | `harmony/ets/pages/Handwriting.ets`、`model/pageObjects.ts`、`model/tableOcr.ts`、`model/draft.ts`、`model/pageBook.ts` |
| 附件 JPEG q60 + 按天 zip + sha256 去重 + 解压缓存 | `model/attachments.ts`、`services/attachmentStore.ets`、`docs/DATA-CONTRACT.md §4ter` |
| 导出/归档 | **已在 `docs/ROADMAP.md:126` 的「进行中」表里（Wave 3，待派）** —— 本文件只在 #11 补「用户侧入口」，不复述内容 |
| 提醒 | **已按用户要求删除**（见 §4 专题），不要再当"缺功能"补 |

**明确还没有的**：重复日程/模板、周视图/月视图（只有"选日"的日历弹层，没有带数据的月网格）、
待办逾期分组、统计（完成率/连续天数）、首页快速记录、语音输入、图片标注、手写转文字复核层、
冲突可视化、导出入口。

---

## 1. P0 前置：三个「字段白名单」缺陷（不修则后面的功能会静默丢数据）

本仓有 **3 处白名单**，新字段只加在其一就会被吃掉。其中前两处**现在就已经在丢数据**，
我用 `apps/arkui-schedule/tools/.build/model/*.js`（`tools/tsconfig.json` 的产物）实跑验证过。

### P0-1 `cloneRecord` 丢 `pageObjects`（手写对象层会永久消失）

- 证据：`model/types.ts:92-114` 显式逐字段复制，**没有 `pageObjects`**；调用点 `pages/Index.ets:638`
  （勾选完成）、`model/undoDelete.ts` 的 `softDeleteRecord` / `restoreRecord`。
- 实测（node，读 `.build/model/types.js`）：
  `cloneRecord({…, pageObjects:'{"version":2,…}'})` → key 集合为
  `id,ts,title,body,author,done,ai_processed,attachments`，**`pageObjects` 不在其中**。
- 影响：手写板插入的框/图片/表格（`ScheduleRecord.pageObjects` v2）在**勾一次完成**后丢失；
  图片附件还在 zip 里，但对象层（含表格行列、图片位置）永久没了。
- 修法：`cloneRecord` 补 `pageObjects`，并参照 `model/jsonl.ts:113-117` 的「未知字段透传」写法兜住未来扩展字段。
- 验收断言：新增 `tools/test/recordClone.test.mjs` —— `cloneRecord` 后含 `pageObjects` 的记录与原件
  `JSON.stringify` 相等；再 `appendRecord` 读回仍相等。
- 真机观察：手写板建一条含图片的记录 → 首页勾完成 → 详情页图片/表格仍在、位置不变。

### P0-2 `encodeRecord` 把附件压成 3 字段，丢 `archive` / `entry`（zip 引用降级成散图）

- 证据：`model/jsonl.ts:99-105` 只重建 `{sha256,name,pageIndex}`；而 `model/attachments.ts:145-171`
  生成的是 `{sha256,name,pageIndex,archive,entry}`；读侧 `services/attachmentStore.ets:313-333`
  **必须有 `archive`+`entry` 才走 zip 解压**，否则退回旧散图路径。
- 实测（node，读 `.build/model/jsonl.js`）：带 `archive/entry` 的记录经 `encodeRecord` 后，
  输出行里的 attachments 只剩
  `{"sha256":"aaa…","name":"page-0-aaaaaaaa.jpg","pageIndex":0}`。
- 影响：任何一次「重新 append」（勾完成 / 改正文 / 软删除 / 冲突合并写回）都会让 zip 附件
  降级成 `<filesDir>/…/attachments/<name>` 散图引用 → 详情页取图失败。
- 修法：`normalizeRecord` 的 attachments 改为「保留全部子字段」（白名单→透传），
  legacy 判定交给 `isLegacyAttachment`（`model/attachments.ts:103-105`）而不是"缺字段就猜"。
- 验收断言：`tools/test/jsonl.test.mjs` 加 2 例 —— `encodeRecord` 往返后 `archive/entry` 不变；
  无 `archive` 的旧对象往返后字段集合不变（不新增空键）。
- 真机观察：手写板存一条带附件记录 → 详情页图片可见 → 勾完成 → 再回详情，图片仍可见。

### P0-3 `pageObjects` 的白名单是三处，不是一处（做 #5 之前必须知道）

- `model/pageObjects.ts:242-266` `cleanObject`（序列化前裁剪）、`:300-321` `parsePageList`
  （解析时重建，只认 `sha256/name/rows/cols/ocrEnabled`）、`:100` `makePageObject`（构造时只带 extra 白名单）。
- 现状不是 bug（现有字段都覆盖了），但**新增任何 image/table 子字段（例如 #5 的 `annotations`）
  必须三处同改**，否则写进去立刻被清掉、且不会报错。
- 建议：接 #5 之前先在 `tools/test/pageObjects.test.mjs` 补一例「未知子字段在 serialize→parse 后的去留」，
  把策略**显式**固定下来（当前实际策略 = 丢弃）。

---

## 2. 主表

| # | 功能 | 用户价值（一句话） | 数据/接口影响 | 改动面（文件/模型） | 预估工作量 | 风险 | 建议优先级 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 首页快速记录（下拉即输入，回车即存） | 想到就记，不用跳编辑页走三步 | 无 schema 变更；只调既有 `appendRecord` | `pages/Index.ets`、新 `model/quickAdd.ts` | 0.5 天 | 低 | **P0** |
| 2 | 待办 / 逾期视图（今天·逾期·未来分组） | 一眼看到"欠着的"，而不是翻"全部未完成" | 纯读侧（`openIndexStore.pendingRecords` + `recordDateKey`） | 新 `model/pending.ts`、`pages/Index.ets` | 1 天 | 低 | **P0** |
| 3 | 手写转文字复核层（逐页采纳/编辑再合并） | OCR 错字和串页在入库前就能改，且能对着截图改 | 无 schema 变更（只读 `attachments` 页图 + 现有 body/ocr_text） | 新 `components/OcrReviewSheet.ets`、`model/ocrReview.ts`、`components/RecordEditorView.ets` | 1 天 | 中低 | **P0** |
| 4 | 重复日程（repeat 规则 + 只生成未来 N 天） | 每天站会、每周复盘不用手打 | **新增 `repeat`/`repeatOf` 顶层字段**（不改既有字段，旧数据零迁移）；须先修 P0-1 | 新 `model/repeat.ts`、`services/repeatMaterializer.ets`、`model/types.ts`、`components/RecordEditorView.ets`、`pages/Index.ets` | 2–3 天 | 中 | P1 |
| 5 | 图片标注（在已插入的图片上画箭头/写字，跟图走） | 拍白板后直接圈重点，拖动图片标注不散 | 只改 `pageObjects` JSON 内部（image 对象加 `annotations`），JSONL 顶层不变；须同改白名单三处 | `model/pageObjects.ts`、新 `model/annotation.ts`、`harmony/ets/pages/Handwriting.ets` | 2–3 天 | 中高 | P1 |
| 6 | 连续天数 streak | 让"每天记一点"看得见回报，最便宜的留存款 | 纯读侧（近 N 天 `readDay`），无 schema 变更 | 新 `model/stats.ts`、`services/statsStore.ets`、`pages/Index.ets` | 1 天 | 中低 | P1 |
| 7 | 本周完成率 | 周维度"做了多少还剩多少"，比日视图更能看节奏 | 纯读侧，与 #6 同函数 | 同 #6（一次做完） | 1 天 | 低 | P1 |
| 8 | 模板卡（一键新建常用结构） | 周报/买菜/健身不用每次重打 | 模板存本机 preferences，**不进仓库、不动 JSONL** | 新 `model/templates.ts`、`services/settingsStore.ets`、`components/RecordEditorView.ets` | 1 天 | 低 | P1 |
| 9 | 月视图（42 格 + 每日完成度点） | 整月分布一眼看完，现在只能一天天翻 | 纯读侧；网格逻辑已存在，成本在取每日计数 | 新 `pages/Calendar.ets` + `components/MonthGrid.ets`、新 `model/monthSummary.ts`、`main_pages.json` | 2–3 天 | 中 | P2 |
| 10 | 周视图（7 列扫一眼） | 安排一周比翻 7 次更接近真实用法 | 纯读侧，7 次 `readDay` | 与 #9 同页第二 tab；`model/calendar.ts` 加 `weekDatesOf` | 1 天 | 低 | P2 |
| 11 | 导出入口（Wave 3 只补用户侧入口） | 周报/备份有个明白的按钮，而不是找 CLI | 无 schema 变更；导出是派生视图 | `pages/Settings.ets`、新 `model/exportMarkdown.ts`、`services/exportStore.ets` | 1 天 | 中 | P2 |
| 12 | 冲突可视化（合并统计 + 两侧选边） | 同步后"另一台改了什么"不再静默 | 读侧要接 `mergeAllAfterPull` 进 pull 流程；写侧**会重写当日 JSONL**（append-only 的唯一例外），须先修 P0-2 | `services/syncController.ets`、`services/gitMerge.ets`、`pages/Settings.ets`、新 `components/MergeConflictSheet.ets` | 2–3 天 | 高 | P2 |
| 13 | 语音输入（鸿蒙 CoreSpeechKit，离线中文） | 走路上也能记一条 | 无 schema 变更；只在 harmony 覆盖层实现（Android 无 hms kit） | `harmony/ets/voice/VoiceInput.ets`、`common/features.ts`、`module.json5`（加 MICROPHONE） | 2–3 天 | 高（**未验证**） | P3 |

> 排序口径：性价比 ≈ (价值 × 覆盖人数) / (工作量 × 风险)。#1–#3 都是"现有链路的最后一公里"，
> 改动小、不需要新 schema、不依赖任何未验证 SDK，所以排在最前；#13 价值不低但在真机上可能整块作废，压到最后。

---

## 3. 逐条详细

### 1. 首页快速记录 —— 0.5 天 / P0

- **数据影响**：无 schema 变更。写的就是一条普通 `ScheduleRecord`：
  `title` = 输入串、`body` = `''`、`author` = 设置里的作者、`done=false`、`ai_processed=false`、
  `ts=nowIso()`、`id=newRecordId()`（`services/scheduleStore.ets:54-58`）；落盘走既有
  `appendRecord`（物理追加 `:387-404` + `openIndexStore` 钩子自动维护未完成索引）。
- **改动面**：`pages/Index.ets`（`CompactBody`/`WideBody` 各加一行输入，提交后 `reload()` + `loadSummary()`）、
  新 `model/quickAdd.ts`（纯函数 `buildQuickRecord(text, author, now, id)`，Node 可测）。
- **验收**：
  - 自动断言：`buildQuickRecord('买牛奶','我',…)` 经 `encodeRecord` 不抛、`recordDateKey(ts)===今天`、
    `trim` 后空串**不产出记录**（`tools/test/quickAdd.test.mjs`）。
  - 真机：首页输入"交周报"回车 → 立刻出现在列表、`done` 未勾、断网也当场落盘（进程杀掉重开仍在）。
- **风险**：低。两个小坑：与搜索框同为 `TextInput` 易混（占位文案要区分，如"记一条…（回车保存）"）；
  误触回车产生空行（trim 后空串必须不提交）。

### 2. 待办 / 逾期视图 —— 1 天 / P0

- **数据影响**：纯读侧，无 schema 变更。数据源 `openIndexStore.pendingRecords(includeOtherDevices)`
  （`services/openIndexStore.ets:287`）已经返回"未完成记录数组"；日期归属用 `model/jsonl.ts recordDateKey`。
  分组纯逻辑：`groupByDue(records, todayKey)` → `{overdue, today, future}`。
- **改动面**：新 `model/pending.ts`；`pages/Index.ets`（`ModeTabs` 加第三段或列表内分组头 + 逾期计数徽标）。
- **验收**：
  - 自动断言：昨天未完成 / 今天未完成 / 明天未完成 / 今天已完成 四条输入 → 逾期 1、今天 1、未来 1，
    且已完成那条不出现在任何一组（`tools/test/pending.test.mjs`）。
  - 真机：留一条昨天的记录不勾 → 首页徽标"逾期 1"；勾掉后立即归零（走 `openIndexStore` 的 append 钩子）。
- **风险**：低。注意其他设备的索引是只读派生数据（`docs/DATA-CONTRACT.md §4bis`：启动/pull 后对近 30 天自愈），
  可能比对方的日程慢一拍 —— 空态文案别承诺"全平台实时"。

### 3. 手写转文字复核层 —— 1 天 / P0

- **数据影响**：无 schema 变更。现在手写板一按「完成」就把 0→N 页 OCR 结果全拼进 `body`
  （`harmony/ets/pages/Handwriting.ets:1253-1260` 只写 AppStorage，`components/RecordEditorView.ets:233-258`
  直接追加到 `body`）。复核层只读现有 `attachments`（每页一张、`pageIndex` 有序）+ 现有 `body`/`ocr_text`，
  采纳后仍走既有 `appendRecord`。若想把"复核选择"记到本机草稿，`model/draft.ts` 加一个可选字段即可
  （不入库、不同步）；不想动草稿就纯内存。
- **改动面**：新 `model/ocrReview.ts`（纯逻辑：逐页文本 + 选中位 → 最终 `body` 文本，页序保持）、
  新 `components/OcrReviewSheet.ets`、`components/RecordEditorView.ets`（回填后弹层）。
- **验收**：
  - 自动断言：3 页、只勾第 1、3 页 → 结果 = 第 1 页 + 第 3 页拼接、中间无空行堆叠、页序不变；
    全不勾 → 返回空串且不写 `body`（`tools/test/ocrReview.test.mjs`）。
  - 真机：手写两页 → 完成 → 复核层可左右滑看两页截图；删掉一页文字后，正文只剩另一页。
- **风险**：中低。截图在 zip 里、要异步解压（`attachmentStore.resolveImageUri` `:313-333`），首帧会空 →
  用占位骨架；同步桥未就绪（`GitSyncService.active()===null`）时降级为纯文本复核（不显示图，不报错）。

### 4. 重复日程 / 模板（repeat） —— 2–3 天 / P1

- **数据影响**：**改 JSONL schema（新增可选字段，旧数据零迁移）**。
  `ScheduleRecord` 加 `repeat?: RepeatRule`（挂在母版上）与 `repeatOf?: string`（挂在生成出来的实例上）。
  迁移方案：不需要 —— 旧记录没有 `repeat` 即"非重复"；读取侧把带 `repeat` 的记录当母版
  （列表里显示 🔁 徽标而不是当普通条目），带 `repeatOf` 的当普通条目。
  **必须先修 P0-1**，否则勾一次完成就把规则吃掉（`cloneRecord` 只复制白名单字段）。
  `jsonl.normalizeRecord` 对顶层未知键本来透传（`:113-117`），所以只要 `cloneRecord` 补上，读写都不丢。
- **repeat 字段草案**（母版一行）：

  ```json
  {
    "id": "m-1763200000000-ab12",
    "ts": "2026-11-16T09:00:00+08:00",
    "title": "站会", "body": "", "author": "我", "done": false, "ai_processed": false,
    "repeat": {
      "freq": "daily",              // daily | weekly | monthly
      "interval": 1,                // 每 1 天 / 每 2 周
      "byWeekday": [1, 3, 5],       // weekly 用；0=周日。缺省 = 取母版 ts 的星期
      "byMonthDay": 15,             // monthly 用
      "start": "2026-11-16",        // 首次发生日 = 母版 ts 的日期
      "until": "2026-12-31",        // 可空 = 无限（仍受物化窗口限制）
      "time": "09:00"               // 可空 = 取母版 ts 的时分
    }
  }
  ```

  生成的实例一行：

  ```json
  {
    "id": "rep-m1763200-2026-11-17",
    "ts": "2026-11-17T09:00:00+08:00",
    "title": "站会", "body": "", "author": "我", "done": false, "ai_processed": false,
    "repeatOf": "m-1763200000000-ab12"
  }
  ```

- **「只生成未来 N 天」策略（关键设计）**：
  1. **确定性 id**：`rep-<母版id前 8 位>-<YYYY-MM-DD>`。这是跨设备幂等键 —— 两台设备各自物化同一天，
     产生同一个 id，`foldById` 折叠成一条，**不会出现两份**；重复物化时读当日文件见同 id 即跳过。
  2. **窗口 N = 14**（设置里可选 7/14/30）。触发点只有三个：App 启动、`pull` 之后、切到某日期时补齐到
     「该日 + N」。**绝不生成过去**（历史日文件一塞就再也删不掉，且会把 git 历史撑大）。
  3. **封顶**：单次物化最多写 200 行；单日实例最多 5 条母版展开；超限只写日志不写盘（防一次启动写爆）。
  4. **只写本机目录**：物化走 `scheduleStore.appendRecord`，天然落在 `devices/<自己>/`，
     `verifyPushScope` fail-closed 不变。
  5. **跳过某次** = 追加同确定性 id 的墓碑（`deleted:true`），母版保留；生成器见到该 id 已存在就跳过
     （**不能**靠"删掉实例行"，否则下次启动又长出来）。
  6. **整个系列结束** = 给母版追加新版本把 `repeat.until` 设为前一天；**改这一次** = 直接改实例那一行
     （实例是普通记录，与母版无关）。
- **改动面**：`model/types.ts`（字段 + `cloneRecord`）、新 `model/repeat.ts`（`nextDates(rule, fromKey, count)`、
  `materializeId(parentId, dateKey)`、`dueOccurrences(records, todayKey, horizon)`）、
  新 `services/repeatMaterializer.ets`（启动/pull/切日三个调用点）、
  `components/RecordEditorView.ets`（"重复"选择器 + 结束日期）、`pages/Index.ets`（🔁 徽标 + "跳过本次 / 结束系列"菜单）。
- **验收**：
  - 自动断言（`tools/test/repeat.test.mjs`）：每周一三五、从 2026-11-16 起算 14 天 → 6 条且含跨年周
    （12-29 → 01-02）不出错；`until` 之后为 0 条；**幂等**：同一 `{days, existing}` 输入连算两次，
    第二次 `toWrite.length===0`；墓碑 id 被跳过。
  - 真机：建"每天 09:00 站会"→ 未来 14 天各出现 1 条 → 杀进程重开 + 下拉同步后**仍各 1 条**；
    两台设备都开着 → 同步后也不重复（确定性 id 折叠）。
- **风险**：中。三个必须写进代码注释的点：确定性 id 是唯一幂等保证（别改成随机 id）；
  "跳过"必须用墓碑而不是删行；物化必须封顶且只写本机目录。

### 5. 图片标注 —— 2–3 天 / P1

- **数据影响**：不动 JSONL 顶层字段，只扩 `pageObjects` v2 文档内部：`kind:"image"` 的对象加
  `annotations: number[][][]`（每条 = 一串点，坐标是**图片局部归一化 0..1**，相对图片框左上角）。
  旧数据没有这个字段 = 无标注，无需迁移。**同改白名单三处**（见 P0-3），否则存进去就被 `cleanObject` 清掉。
- **改动面**：`model/pageObjects.ts`（`PageObject` 加字段 + 三处白名单 + 一个 `annotationHitTest`）、
  新 `model/annotation.ts`（图片坐标 ↔ 画布坐标变换、箭头几何；纯逻辑可测）、
  `harmony/ets/pages/Handwriting.ets`（长按图片进标注态；`drawObject` `:2088-2109` 里画标注；
  笔迹输入在标注态路由到图片而非页面笔迹）、`components/RecordDetailView.ets`（只读展示）。
- **验收**：
  - 自动断言：图片从 `(0.2,0.2,0.4,0.3)` 移到 `(0.5,0.1,0.4,0.3)` 后，标注点经变换仍落在图片同一相对位置
    （误差 `<1e-6`）；`serializePageObjects` → `parsePageObjectsDoc` 往返后 `annotations` 逐点相等。
  - 真机：插入图片 → 画 2 条箭头 → 拖动图片 → 箭头跟着走且不错位；保存、重开、旋转屏幕后仍在。
- **风险**：中高。(a) 笔迹层与对象层是**两套坐标系、两层 Canvas**（`Handwriting.ets:2799-2803` 对象层
  绝对定位覆盖在画布之上），且旋转重投影已有历史缺陷（`docs/UI-DESIGN.md §5`，属未修项）；
  (b) 标注态与"拖对象/翻页/画笔迹"三种手势冲突，长按阈值要真机调；
  (c) 对象层 `hitTestBehavior(HitTestMode.Transparent)`（`:2060`）下的穿透行为必须真机确认，
  否则会出现"画标注同时把对象拖走"。

### 6. 连续天数 streak —— 1 天 / P1

- **数据影响**：纯读侧，无 schema 变更。口径要写死：**某日至少有 1 条 `done:true` 记录 = 活跃日**；
  `streak` = 从今天（今天还没完成则从昨天）往回连续活跃日数。数据源是各日 JSONL（`scheduleStore.readDay`），
  **不能**用 `open.jsonl`（它只保留最近一次完成会话，没有历史，见 `docs/DATA-CONTRACT.md §4bis`）。
- **改动面**：新 `model/stats.ts`（纯函数 `computeStats(days: {date,records}[], todayKey, windowDays)`）、
  新 `services/statsStore.ets`（本会话内存缓存；只读近 90 天）、`pages/Index.ets`（汇总块下一行「🔥 连续 N 天」）。
- **验收**：
  - 自动断言：11-10…11-14 全完成、11-15 空、今天=11-15 → `streak=5`；今天=11-16 且今天未完成 → 仍 `streak=5`；
    空输入 → 0；窗口边界外不计入。
  - 真机：连续两天勾完成 → 显示 2；隔一天不勾 → 显示 0（或 1，取决于当天是否完成），文案与数字一致。
- **风险**：中低。要读最多 90 个日文件、且 `readDay` 是**同步** `fs.readTextSync`（`scheduleStore.ets:130-148`），
  低端机可能掉帧 → 缓解：只读 `listDates()` 里真实存在的日期、结果按会话缓存、首屏只读最近 14 天再异步补全。
  另外跨设备历史要 pull 之后才齐，文案别写"全平台连续"。

### 7. 本周完成率 —— 1 天 / P1

- **数据影响**：纯读侧，无 schema 变更。与 #6 共用 `model/stats.ts`（`weekStart` 由 `common/date.ts` 推算，
  周一起算），输出 `{weekDone, weekTotal, rate}`。
- **改动面**：同 #6（一次做完；按三档口径分别估 1 天）。
- **验收**：
  - 自动断言：周一 3 条含 2 done、周二 1 条 done、上周 2 条 done → `3/4`，上周不计入；
    `weekTotal===0` 时返回 `rate=0` 而不是 `NaN`。
  - 真机：勾一条完成，首页"本周"进度当场变化（不需要同步/刷新）。
- **风险**：低。唯一坑是"跨周那天"（周日 23:59 → 周一 00:01）要用 `localDateKey(new Date())` 现算，
  不要缓存"周起点"到设置里。

### 8. 模板卡 —— 1 天 / P1

- **数据影响**：模板存**本机** preferences（`settingsStore.ets` 同族新键，JSON 串，上限 20 条 / 单条 ≤2KB），
  **不进仓库、不动 JSONL**；用它新建出来的仍是一条普通 `ScheduleRecord`（不产生关联，改模板不回改已建记录）。
  若以后要跨设备共享模板，再考虑 `devices/<id>/templates.json` 并补 `docs/DATA-CONTRACT.md` 一节。
- **改动面**：新 `model/templates.ts`（序列化/清洗/上限/坏数据不抛）、`services/settingsStore.ets`（或独立
  `templatesStore.ets`）、`components/RecordEditorView.ets`（新建态顶部"模板"chips）。
- **验收**：
  - 自动断言：坏 JSON / 超 20 条 / 单条超 2KB / 空数组 → 一律清洗成合法值且不抛；`title` 为空的模板被丢弃。
  - 真机：存 2 个模板 → 新建页出现 2 个 chip → 点一个填好标题+正文（正文可含 `- [ ]` 行），保存后是可编辑普通记录。
- **风险**：低。别做成"运行时联动"，UI 文案要写"套用，不回改已保存记录"。

### 9. 月视图（42 格 + 每日完成度点） —— 2–3 天 / P2

- **数据影响**：纯读侧，无 schema 变更。格子数据 = 每日 `{total, done}`，来自
  `listDates()`（`scheduleStore.ets:151-171`）∩ 本月 + `readDay()`。
- **渲染成本评估（明确结论）**：**格子本身几乎不花成本** —— `model/calendar.ts:237-276` `monthGrid`
  已经产出固定 6×7、跨月补位是真实日期、纯整数运算且有 `tools/test/calendar.test.mjs` 覆盖；
  `components/CalendarPicker.ets`（11 KB）也已在用。真正的成本在**取每日计数**：`readDay` 是同步
  `readTextSync` + `JSON.parse`，一个月按"只读存在的日期"算最多 31 次（不是 42 次）。
  单日文件通常 <10 KB，量级应在几十毫秒；**本机无法真机实测，属待验证项**（用 `hilog` 在
  `browseMonth()` 前后打点即可，半小时能测完）。
- **改动面**：新 `pages/Calendar.ets`（月/周两个 tab 的宿主）、新 `components/MonthGrid.ets`
  （复用 `monthGrid`/`weekdayLabels`/`shiftMonth`/`clampDateKey`）、新 `model/monthSummary.ts`
  （纯函数：`{date,records}[]` → `{[date]:{total,done}}`）、`pages/Index.ets`（点日期条标题进月视图）、
  `entry/src/main/resources/base/profile/main_pages.json` 登记 + harmony 版清单（必须是超集）。
- **验收**：
  - 自动断言：3 天数据 + 1 天空白 → 输出只有 3 个键、`done` 计数正确、非法日期键被跳过；
    跨月补位格 `dateKey` 与 `monthGrid` 完全一致。
  - 真机：横竖屏各看一次；点某格回首页并定位到该日；快速前后翻月时**不掉帧**（肉眼 + `hilog` 时延）。
- **风险**：中。(a) 31 次同步读在 UI 线程，低端机可能卡一帧 → 先读"存在的日期"、命中缓存、
  必要时把汇总放 `@ohos.taskpool`；(b) 与既有 `CalendarPicker` 的打开方式重复，UI 上要收敛成一处入口；
  (c) 只用共享层 API，别引 harmony 专属模块（否则 validate 规则 4/5 直接失败）。

### 10. 周视图 —— 1 天 / P2

- **数据影响**：纯读侧，7 次 `readDay`。
- **改动面**：与 #9 同页第二 tab；`model/calendar.ts` 加 `weekDatesOf(dateKey, weekStart)`（导出，可测）。
  **建议与 #9 同批做**（同一页面骨架，省一半成本）。
- **验收**：
  - 自动断言：`weekDatesOf('2026-11-16',1)` 长度 7、首元素 `2026-11-16`、末元素 `2026-11-22`；
    跨年周（`2026-12-29`）正确；`weekStart=0` 时首元素前移一天。
  - 真机：切到周视图 → 7 天各有条数；点列头跳转到首页该日。
- **风险**：低。与 #9 共享 IO 风险，合并后风险不叠加。

### 11. 导出/归档的用户侧入口 —— 1 天 / P2

- **前置**：`docs/ROADMAP.md:126` 已有「Wave 3 导出/归档/分页/缩略图（待派）」。本条目**不重复设计导出内容**，
  只补"用户从哪儿点、失败怎么提示"。若 Wave 3 的实现口径与该入口冲突，以 Wave 3 为准。
- **数据影响**：无 schema 变更。导出是派生视图：Markdown/CSV 由现有记录渲染，
  附件**不导出散图**，只带 zip 内的引用名（`archive/entry`），保持 `docs/DATA-CONTRACT.md §4ter` 的
  "仓库里只有 zip"。
- **改动面**：`pages/Settings.ets`（`AboutGroup` `:1616-1674` 旁加「数据」组，一行「导出本周 / 本月」）、
  新 `model/exportMarkdown.ts`（纯函数 `{date,records}[] + title → Markdown`，含 `- [x]`/`- [ ]`、
  手写 OCR 段、附件条目名）、新 `services/exportStore.ets`（写 `<filesDir>/export/*.md`，
  调 `DocumentViewPicker.save()`；SDK 证据见 §7）。
- **验收**：
  - 自动断言：3 天记录（含 1 条 done、1 条带 `ocr_text`）→ 输出含 `# 2026-11-16`、`- [x]`/`- [ ]`
    条数正确、`ocr_text` 被包进引用块、无 `undefined` 字样。
  - 真机：点导出 → 系统文件选择器出现 → 存到本地文件 App 能打开、中文不乱码。
- **风险**：中。文件选择器**有正面证据但也只是"未验证"**：本机 `…\openharmony\ets\api\@ohos.file.picker.d.ts:628`
  的 `class DocumentViewPicker` 标了 `@since 9` + `@crossplatform [since 12]`，`save(option?)` 在 `:721` ——
  说明 ArkUI-X 侧**设计上**支持，但没有本仓真机证据（Android 产物里是否落实现未知）→
  入口按平台能力显示，失败时降级为"写到自己目录 + toast 路径"；导出上百条时字符串拼接要分块，别一次 `join` 到内存爆。

### 12. 冲突可视化（合并统计 + 两侧选边） —— 2–3 天 / P2

- **现状（比"UI 没暴露"更严重）**：`model/recordMerge.ts` 的 `MergeStats`
  （`localOnly/remoteOnly/conflicts/errors/duplicates`，`:50-67`）和 `services/gitMerge.ets` 的
  `MergeAllResult` 确实有完整统计，但 `captureBeforePull()`（`:501`）、`mergeAfterPull()`（`:569`）、
  `applyMergeChoice()`（`:697`）、`mergeAllAfterPull()`（`:1024`）在 `entry/src` 里**零调用点**
  （只有 gitMerge.ets 内部互相调用）；`syncController.pullNow()`（`:256-284`）只调
  `service.pullOnStartup()`。也就是**合并层目前是死代码**，只有单测在跑它。
- **数据影响**：读侧 —— 要把合并接进 `syncController.pullNow()`，顺序 `captureBeforePull → pull → mergeAllAfterPull`，
  并把 `MergeAllResult.records.summary` 抛给页面。写侧 —— `applyMergeChoice` 会**重写当日 JSONL**
  （压缩同 id 多版本），这是 append-only 契约唯一合法例外（`model/recordMerge.ts:26-28` 已论证：
  被压缩的旧行仍在 git 历史里，折叠语义等价）；但重写走 `encodeRecord`，**会踩 P0-2**（附件 `archive/entry` 丢）
  → **必须先修 P0-2**。
- **改动面**：`services/syncController.ets`（编排 + 结果透出）、`services/gitMerge.ets`（对外暴露 `MergeAllResult`）、
  `pages/Settings.ets`（`SyncGroup` 加"上次合并：本机独有 N / 远端独有 M / 冲突 K"一行）、
  新 `components/MergeConflictSheet.ets`（两侧规范行并排，选完调 `applyMergeChoice`）。
- **验收**：
  - 自动断言：`mergeDayFile` 处理「同 id 冲突且带 zip 附件」的一对输入，往返后 `archive/entry` 不变
    （在 `tools/test/recordMerge.test.mjs` 现有 33 例基础上加，守住 P0-2）；冲突时 `text` 与原远端一致（不写回）。
  - 真机：两台设备**用同一个 deviceId** 各写一条同 id 不同内容的记录（或换机沿用旧 deviceId），下拉 →
    设置页出现"冲突 1，已暂停写回"→ 选「保留本机」后当日文件行数被压缩、记录不丢、附件仍能看。
- **风险**：高。三条：它是唯一会**改写历史文件**的功能；冲突面其实很窄（各设备只写自己目录，
  `gitMerge.ets:440 liveDayPath(deviceId)` 只覆盖本机目录，冲突主要来自"同一 deviceId 被两处使用"
  或 pull 带回被 `unionJsonl` 兜底的行）；写回路径与 P0-2 强耦合。
  **建议拆两批**：先做「只读统计 + 冲突清单」（1 天，零写入风险），再单独一批做「一键写回」，
  并按 ROADMAP 的评审规矩找独立执行子代理只读评审。

### 13. 语音输入（鸿蒙离线中文） —— 2–3 天 / P3

- **可行性证据（本机 SDK 实测存在）**：
  - `D:\A-DevEco\DevEco Studio\sdk\default\hms\ets\kits\@kit.CoreSpeechKit.d.ts`
    → `import speechRecognizer from '@hms.ai.speechRecognizer'`（`@since 4.1.0(11)`）；
  - `D:\A-DevEco\DevEco Studio\sdk\default\hms\ets\api\@hms.ai.speechRecognizer.d.ts`：
    "Currently, this service is available only in Chinese and supports only the offline model"（`:10-14`）、
    `@stagemodelonly`、`createEngine({language:'zh-CN', online:1})` —— **`online:1` 表示离线模式**（`:272-281`，
    反直觉，注意别填 0）、`startListening` / `writeAudio(sessionId, Uint8Array)`（**帧长只能是 640 或 1280 字节**，
    分别 20ms / 40ms 一帧，总长 ≤60s）、`finish` / `cancel`、`setListener(RecognitionListener)`；
    `extraParams` 支持 `recognizerMode: 'short'|'long'` 与 `sysGeneralLexicon`（最多 200 个热词、每个 2–20 字，
    可以塞"周报/复盘/站会"这类日程热词）。
  - 本仓 SDK 版本 `compatibleSdkVersion/targetSdkVersion: 26.0.0`（`build-profile.harmony.json5`），
    满足 `@since 4.1.0(11)`，**编译期可用**。
- **未验证（必须真机试）**：(a) 目标真机是否带**离线语音模型**（有 d.ts ≠ 设备有模型，缺模型 `createEngine` 会报
  `1002200001`）；(b) 该 kit 在 **ArkUI-X(Android) 必然不可用** —— 它在 `sdk/default/hms/**` 下，
  Android 产物没有 hms 目录，因此只能放 harmony 覆盖层（validate 规则 4/8 会拦 `main` 树引用）。
- **数据影响**：无 schema 变更（识别文本进 `title`/`body`），但需要 **`ohos.permission.MICROPHONE`** ——
  当前 `entry/src/main/module.json5` 的 `requestPermissions` 只有 `INTERNET` 与 `STYLUS_FRAME_BOOST`，
  加权限要评估 Android 产物是否受同名清单影响（**未验证**）。
- **改动面**：`entry/src/harmony/ets/voice/VoiceInput.ets`（引擎 + `AudioCapturer` 640B 帧泵）、
  `common/features.ts` 加 `voice` 开关、`platformFeatures.ets`（harmony 打开、共享默认关闭）、
  `module.json5` 加权限、`pages/Index.ets` 快速记录行加麦克风按钮（feature flag 控制）。
- **验收**：
  - 自动断言：`model/voiceText.ts` 纯函数把回调分片拼成单行（折叠空白、≤200 字截断、空结果返回空串），
    `tools/test/voiceText.test.mjs`。
  - 真机：飞行模式（离线）下说"明天下午三点交周报"→ 输入框出现中文文本；无麦克风权限时给可读中文提示而不崩。
- **风险**：高。这正是 §6 的"必须先做的技术验证"。

---

## 4. 提醒专题：为什么之前删掉，以及什么条件下才谈恢复

**删除证据链**：

- `docs/UI-DESIGN.md:118` —— 设置页「关于」组备注为「—（**提醒功能已按用户要求删除**）」；
- `docs/UI-DESIGN.md:177` —— 「**提醒功能整条删除**（UI 调用点/状态/文案已移除，services 侧由他人删）」；
- `pages/Index.ets:16` —— 「日历提醒功能已按用户要求删除（UI 侧调用点与文案已移除）」；
- 代码已清干净：`entry/src/main/ets/reminder/` 是**空目录**；`entry/src/main/module.json5` 的
  `requestPermissions` 已**不含** `ohos.permission.PUBLISH_AGENT_REMINDER`；`entry/src/**` 里 `提醒` 只剩上面那一句注释。
- 旧方案为什么重：`docs/ARCHITECTURE.md:78` + `docs/CONTRACT.md:414-415` + `docs/VERIFICATION.md:229` ——
  `reminderAgentManager` 日历提醒（单应用 ≤30 条）需要 `PUBLISH_AGENT_REMINDER` 开放能力，
  要 **AGC 申请 + 手动签名，约 8 个工作日**，未获批还得降级 `notificationManager`。

**结论**：

1. **不恢复 `reminderAgentManager`**（周期、签名、审核都不在"一周内落地"范围内，且用户明确要求删过）。
2. 用 **#2 待办/逾期视图** 替代"推送提醒"：打开就看到"欠着的"，不依赖任何权限。
3. 如果确实要"响一下"，只能做**应用内到期红点 + 单条即时通知**（`notificationManager.publish`，
   本机 SDK `…\openharmony\ets\api\@ohos.notificationManager.d.ts:118`，`@since 9`、`@crossplatform [since 12]`，
   无 `@permission` 标注，不需要 AGC 能力；`requestEnableNotification` 同名文件 `:720-799`），
   **并且必须在 UI 里写明它只在 App 前台/刚回前台时可靠**（不会像旧方案那样后台到点弹）。

**与旧方案的三个区别**：① 不申请开放能力、不动签名，安装即用；② 不做"≤30 条批量注册 + 降级链"，
只在用户打开 App 时发**一条**汇总通知；③ 触发点是"App 启动 / 回前台 / 下拉刷新"，
不是系统定时器 —— 本 App 已明确不跑后台定时任务（`pages/Index.ets:21-24`：
鸿蒙 `setInterval` 退后台会被回收，真做定时要 `continuousTask` + 前台通知，所以"刻意不加看起来能用、
实际会被回收的定时器"；`services/syncController.ets:12-15` 同口径）。

---

## 5. 不做清单（明确不建议）

| 不做 | 理由 |
| --- | --- |
| **恢复 `reminderAgentManager` 系统日历提醒** | 要 AGC 开放能力 + 手动签名（约 8 工作日，`docs/CONTRACT.md:414-415`），且用户明确要求删过（`docs/UI-DESIGN.md:118,177`）；一周内不可能交付，做了也是装不上的包 |
| **后台定时任务（定时汇总 / 定时提醒）** | 鸿蒙 `setInterval` 退后台被回收，真做要 `continuousTask` + 前台通知；`pages/Index.ets:21-24` 已明确"刻意不加看起来能用、实际会被回收的定时器"，重开这条口子会把"保存成功但没执行"的锅甩给数据层 |
| **实时协同（WebSocket / 在线并发编辑）** | 与"每台设备只写自己目录 + git 单写者 + 只追加"的架构正面冲突（`docs/DATA-CONTRACT.md §1,§6`）；引入等于重做同步层，不是一周的量 |
| **把图片/富文本 base64 内嵌进 JSONL 或 `body`** | 附件走 `attachments/<date>.zip` + sha256 引用是硬契约（`docs/DATA-CONTRACT.md §4ter`）；内嵌会让日文件膨胀到 MB 级，git 每次 pull 都全量传，且 zip 去重/解压缓存全部作废 |
| **CalDAV / 系统日历双向同步** | 需要账号体系 + OAuth + 读写系统日历权限（`READ_CALENDAR`/`WRITE_CALENDAR`），Android 侧还得另写一套；双向同步必然产生"谁是权威"的冲突，撞上 #12 的全部风险且没有 append-only 兜底 |

补充一条**数据语义红线**（不占表行）：AI 只能追加"同 id、新 ts"的**新版本行**，不得改写历史字节 ——
否则跨设备 `foldById` 的折叠结果会取决于各设备执行顺序，比任何功能缺失都更难排查。

---

## 6. 必须先做的技术验证（1 个）

**`@kit.CoreSpeechKit` 在目标鸿蒙真机上能否真的跑出中文结果** —— 这是唯一"SDK 里有 d.ts、但设备不一定有模型"
的能力，也是唯一可能**整块作废**的功能（不通过就砍掉 #13，不影响其它 12 条）。

30 分钟验证路径：
1. 在 `entry/src/harmony/ets/voice/` 写一个最小页（只在 harmony 清单登记）；
   `module.json5` 加 `ohos.permission.MICROPHONE`；
2. `speechRecognizer.createEngine({language:'zh-CN', online:1})`（**1 = 离线**）→ 看是否抛 `1002200001`
   （抛了就说明设备缺离线模型，直接结案）；
3. `@ohos.multimedia.audio` 的 `AudioCapturer` 采集 PCM，按 **640 字节 / 20ms** 节奏 `writeAudio`；
4. 看 `onResult` 是否回中文、`finish` 后 `onComplete` 是否到达；
5. 在 Android 产物上跑一次 `node apps/arkui-schedule/tools/validate-app.mjs`：语音代码**必须**只出现在
   `entry/src/harmony/ets/`，若它出现在 `main` 树，规则 4/8 会直接报错（那时是代码放错层，不是 validate 错）。

补充验证（半天，不阻塞其它条目）：**#9 月视图的取数耗时** —— 在真机上对"31 次 `readDay`"前后打 `hilog`，
确认 UI 线程不卡（若 >50ms 就把汇总搬进 `@ohos.taskpool`）。

---

## 7. 证据索引

| 结论 | 证据 |
| --- | --- |
| JSONL 只追加 + 折叠语义 | `docs/DATA-CONTRACT.md §3`、`model/jsonl.ts:229-239`、`services/scheduleStore.ets:387-404` |
| 附件按天 zip（仓库里只有 zip） | `docs/DATA-CONTRACT.md §4ter`、`model/attachments.ts:145-171`、`services/attachmentStore.ets:313-333` |
| 未完成索引是派生数据、30 天自愈 | `docs/DATA-CONTRACT.md §4bis`、`services/openIndexStore.ets:213-286` |
| 提醒已删 + 旧方案成本 | `docs/UI-DESIGN.md:118,177`、`docs/ARCHITECTURE.md:78`、`docs/CONTRACT.md:414-415`、`docs/VERIFICATION.md:229`、`pages/Index.ets:16` |
| 不做后台定时器 | `pages/Index.ets:21-24`、`services/syncController.ets:12-15` |
| 月网格逻辑已存在且已测 | `model/calendar.ts:237-276`、`components/CalendarPicker.ets`、`tools/test/calendar.test.mjs` |
| 合并层有统计但零调用点 | `model/recordMerge.ts:50-67`、`services/gitMerge.ets:501,569,697,1024`、`services/syncController.ets:256-284` |
| ArkUI-X 双端编译约束（规则 4/8） | `tools/validate-app.mjs:405-449`、`docs/CONTRACT.md §3.1` |
| 鸿蒙离线语音识别能力 | `D:\A-DevEco\DevEco Studio\sdk\default\hms\ets\kits\@kit.CoreSpeechKit.d.ts`、`…\hms\ets\api\@hms.ai.speechRecognizer.d.ts:10-14,112-132,262-303` |
| 文件选择器（导出用） | `D:\A-DevEco\DevEco Studio\sdk\default\openharmony\ets\api\@ohos.file.picker.d.ts:628`（`class DocumentViewPicker`，`@since 9`、`@crossplatform [since 12]`）`:721`（`save(option?: DocumentSaveOptions)`） |
| 通知（轻提醒用，无 AGC） | `D:\A-DevEco\DevEco Studio\sdk\default\openharmony\ets\api\@ohos.notificationManager.d.ts:118,152,720-799` |
| 三处字段白名单 | `model/types.ts:92-114`、`model/jsonl.ts:86-119`、`model/pageObjects.ts:242-266,300-321` |
