# REVIEW b3-batch（2026-11-19，独立只读评审）

> 评审角色：独立只读评审子代理（非作者、非规划者），未派生任何子代理。
> cwd = `C:\Users\GWL\Desktop\itwillclaude\dsh-sync-suite`（`main`，HEAD `8435b38`）。
> 评审对象严格限定为派活清单的 **6 个 modified + 3 个 untracked**（代码/测试共 9 个文件）；
> `docs/UX-STEPS.md` 与 `docs/ROADMAP.md` 由规划者单独改，**本评审明确排除**（见 §1.1）。
> 本机无 DevEco / 无 HarmonyOS SDK、`node_modules` 无 ArkUI d.ts、`hdc` 不在 PATH。凡涉及 ArkTS 编译、真机键盘 / 聚焦 / toast 叠加的结论一律标 `static` / `unverified`，**不写「已验证」**。
> 唯一写入文件为本文件；未改任何源码 / 测试 / 既有文档，未 commit / push，未碰 .git 写操作 / profile / .ps1 / 依赖。

---

## 0 结论

- **是否阻塞提交：否（P0 = 0、P1 = 0）**
- **P0 0 条 / P1 0 条 / P2 6 条**
- **一句话核心结论**：路径 1 的一次性「保存返回」标记（`home.lastSaved`）与路径 2 的一次性「手写自动保存」标记（`handwriting.autosave`）都做到了**读后即清 + 失败给原因 + 不写半条坏记录**，D1-P2 失焦归一只改输入框文本、绝不合并已存令牌，`appendRecord` / `openIndexStore` 钩子 / pull 路径零改动；6 种保存返回组合静态推演均能看到应看到的记录，回归 251/251、全量 2233/2232/0/1、`validate-app` 8/8 —— 无数据丢失 / 错写 / 安全隐患，六条 P2 均为边界、误报文案、静态测试脆弱性与真机未验项。

---

## 1 范围与命令（证据三段式：命令原文 / 原样输出 / 结论）

### 1.1 工作树范围核对（含并发 docs 排除）

**命令原文**
```
git rev-parse --short HEAD; git status --short
```

**原样输出（评审开始时）**
```
8435b38
 M apps/arkui-schedule/entry/src/harmony/ets/pages/Handwriting.ets
 M apps/arkui-schedule/entry/src/main/ets/components/RecordEditorView.ets
 M apps/arkui-schedule/entry/src/main/ets/components/settings/RemoteSection.ets
 M apps/arkui-schedule/entry/src/main/ets/pages/Edit.ets
 M apps/arkui-schedule/entry/src/main/ets/pages/Index.ets
 M apps/arkui-schedule/entry/src/main/ets/pages/Settings.ets
?? apps/arkui-schedule/entry/src/main/ets/model/homeRefresh.ts
?? apps/arkui-schedule/tools/test/b3Batch.test.mjs
?? apps/arkui-schedule/tools/test/b3HandwritingAutoSave.test.mjs
```

**原样输出（收尾时）**
```
8435b38
 M apps/arkui-schedule/entry/src/harmony/ets/pages/Handwriting.ets
 M apps/arkui-schedule/entry/src/main/ets/components/RecordEditorView.ets
 M apps/arkui-schedule/entry/src/main/ets/components/settings/RemoteSection.ets
 M apps/arkui-schedule/entry/src/main/ets/pages/Edit.ets
 M apps/arkui-schedule/entry/src/main/ets/pages/Index.ets
 M apps/arkui-schedule/entry/src/main/ets/pages/Settings.ets
 M docs/ROADMAP.md
 M docs/UX-STEPS.md
?? apps/arkui-schedule/entry/src/main/ets/model/homeRefresh.ts
?? apps/arkui-schedule/tools/test/b3Batch.test.mjs
?? apps/arkui-schedule/tools/test/b3HandwritingAutoSave.test.mjs
```

**结论**：开始时 9 个代码/测试文件与派活清单**逐字一致**；收尾时多出的 `docs/ROADMAP.md`（`59 + / 13 -`）与 `docs/UX-STEPS.md`（`73 +`）是**规划者在评审期间并发写入**，非本评审所为，按派活说明**明确排除**，不进入 §2 任何判定。6 个源码文件的 SHA256 在评审全程未变（复核哈希 `RecordEditorView BF8C6BFA…`、`Index 67190011…`、`Settings 361EE0CC…`、`Handwriting 057ADBEB…`、`homeRefresh D4A211FC…`），不存在源码在评审中途被改的情况。

> 说明：派活清单写的 `(+91/-7)` / `(+54)` / `(+57)` 是 `git diff --stat` 的「总变动行」显示，不是 insertions/deletions。`git diff --numstat` 权威值为
> `Handwriting 10/0`、`RecordEditorView 86/5`、`RemoteSection 5/0`、`Edit 2/0`、`Index 53/1`、`Settings 56/1`（合计 212 insertions / 7 deletions）。下文行号一律取工作树 `read`/`grep` 行号，与 `git diff` 的 `+` 侧行号一致。

### 1.2 改动性质（删除行逐条核对）

**命令原文**
```
git --no-pager diff --numstat -- apps/arkui-schedule
git --no-pager diff > %TEMP%\b3-full.diff   # 413 行全量 diff，逐 hunk 阅读
```

**原样输出（numstat）**
```
10	0	apps/arkui-schedule/entry/src/harmony/ets/pages/Handwriting.ets
86	5	apps/arkui-schedule/entry/src/main/ets/components/RecordEditorView.ets
5	0	apps/arkui-schedule/entry/src/main/ets/components/settings/RemoteSection.ets
2	0	apps/arkui-schedule/entry/src/main/ets/pages/Edit.ets
53	1	apps/arkui-schedule/entry/src/main/ets/pages/Index.ets
56	1	apps/arkui-schedule/entry/src/main/ets/pages/Settings.ets
```

**全量 diff 的 7 个删除行（逐条）**
- `RecordEditorView.ets`：① `import { newRecordId, scheduleStore, describeError }` → 扩写为 4 个具名导入（加 `resolveRecordDate`）；② `/** 页面从手写板返回时触发回填。 */` → 改写为带「自动保存」说明的注释；③ `/** 手写板回填：正文、原始识别文本、截图附件三路数据（读后立即清空键）。 */` → 四路 + 返回值注释；④ `private applyPendingInkResult(): void {` → `: boolean {`；⑤ `this.applyPendingInkResult();` → `const applied: boolean = …`；共 5 行，全部为等价扩写 / 签名变更，**无语义删除**。
- `Index.ets`：`import { loadingText } from '../common/copy';` → `{ loadingText, toastMsFor }`。
- `Settings.ets`：`import type { RemoteUrlCheck } from '../model/remoteUrl';` → 追加 `RemoteInputResult` + 新增 `parseRemoteInput` 值导入。

**结论**：7 个删除行全部是 import 扩写或注释 / 签名改写，无夹带、无既有断言删除（测试文件 `git diff --name-only -- tools/test` 为空，见 §2-D10）。新增文件用 `read` 直接读（Windows 下 `git diff --no-index -- /dev/null <file>` 不适用，已在 §1 说明），三个新文件共 `120 + 342 + 202 = 664` 行。

### 1.3 独立复跑测试（8 个指定文件）

**命令原文**
```
node --test "apps/arkui-schedule/tools/test/b3Batch.test.mjs" "apps/arkui-schedule/tools/test/b3HandwritingAutoSave.test.mjs" "apps/arkui-schedule/tools/test/handwritingToolbar.test.mjs" "apps/arkui-schedule/tools/test/indexHeader.test.mjs" "apps/arkui-schedule/tools/test/exportImport.test.mjs" "apps/arkui-schedule/tools/test/credentialHygiene.test.mjs" "apps/arkui-schedule/tools/test/copy.test.mjs" "apps/arkui-schedule/tools/test/uiTokens.test.mjs"
```

**原样输出（尾部）**
```
✔ Detail / Edit 已改成薄壳：只做路由参数 + 复用组件，不再自带业务逻辑 (0.1489ms)
✔ 两个可复用视图：入参与回调齐全，手写回填走 refreshTick + @Watch (0.2872ms)
✔ 主从右栏支持下拉刷新，且编辑有未保存内容时不推进 paneTick (0.2414ms)
ℹ tests 251
ℹ suites 38
ℹ pass 251
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 362.6582
TEST_EXIT=0
```

**原样输出（两个新增文件单独点名）**
```
b3Batch.test.mjs:            ℹ tests 19 / ℹ pass 19 / ℹ fail 0 / ℹ skipped 0 / EXIT=0
b3HandwritingAutoSave.test.mjs: ℹ tests 10 / ℹ pass 10 / ℹ fail 0 / ℹ skipped 0 / EXIT=0
```

**结论**：8 文件 251/251 全绿；两个新测试 **19 + 10 = 29 例**与规划者声称的增量一致；最脆的 `handwritingToolbar.test.mjs`（1209 行）同样通过，工具条结构断言未被本批改动破坏。

### 1.4 独立复跑 validate-app / tsc / 全量

**命令原文**
```
node apps/arkui-schedule/tools/validate-app.mjs
node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
node --test "packages/dsh-dots/test/*.test.mjs" "apps/arkui-schedule/tools/test/*.test.mjs"
```

**原样输出（validate-app）**
```
🔍 校验 ArkUI-X 工程：C:\Users\GWL\Desktop\itwillclaude\dsh-sync-suite\apps\arkui-schedule
✅ 全部通过：8/8 条规则（JSON5/JSON 70 个、相对 import 350 条、main 静态 import 442 条、页面 7 个、rawfile/git 2 个文件）
VALIDATE_EXIT=0
```

**原样输出（tsc / 全量，尾部）**
```
TSC_EXIT=0
✔ ⑦ 补齐时目标已有同名条目 → 不覆盖用户数据，也不因旧目录残留而永久失败（评审 M3） (14.1781ms)
ℹ tests 2233
ℹ suites 302
ℹ pass 2232
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 36395.968
TEST_EXIT=0
```

**结论**：**本评审独立复跑了全量**（未照抄规划者数字）：2233/2232/0/1，与基线 2204/2203/0/1 的差正好 **+29**（两个新测试），fail 0、skip 未增；`validate-app` 8/8（import 计数由 347/436 涨到 350/442，对应本批新增的 `homeRefresh` / `parseRemoteInput` / `toastMsFor` 导入）；`tsc` exit 0。唯一 skip 是既有的代理环境变量用例，与本批无关。

---

## 2 逐项判定

> 判定口径：`static` = 读源码 + 纯逻辑实跑可确认；`unverified` = 需真机 / DevEco，本机无证据。每条给「结论 + 证据行号 + 原文 + 是否阻塞」。

### A. 路径 1（UX-STEPS §2.1，7→4）

#### A1 自动聚焦标题 —— **static 结论成立；真机重复抢焦点 unverified；不阻塞**

- **结论**：只对「新建 + 无草稿标题」生效；已有记录、首页横屏右栏不受影响；`Edit.ets` 只传 `true`。
- **证据**
  - `RecordEditorView.ets:87-94`：
    ```
    /**
     * 是否让标题输入框在挂载时自动获得焦点（省掉「点标题」这一次 tap）。
     *
     * 只有「新建记录且没有草稿内容」才聚焦：已有记录不聚焦，避免软键盘遮挡正文、
     * 也避免用户误改标题。真正是否聚焦由 `defaultFocus` 的表达式再判一次
     * （`recordId` 为空 且 `title` 为空白），双保险。
     */
    @Prop autoFocusTitle: boolean = false;
    ```
    默认值 `false` → 不传该 prop 的调用点（含首页横屏右栏）天然不聚焦。
  - `RecordEditorView.ets:776`：
    ```
    .defaultFocus(this.autoFocusTitle && this.recordId.length === 0 && this.title.trim().length === 0)
    ```
    三条件合取：`autoFocusTitle=true`（仅 Edit 传）+ `recordId` 空（仅新建）+ `title` 空白（草稿填过标题就不抢）。已有记录 `recordId` 非空 → 恒 false。
  - `Edit.ets:120-125`：
    ```
    RecordEditorView({
      recordId: this.recordId,
      defaultDate: this.defaultDate,
      // 新建记录自动聚焦标题（省掉点标题那一次 tap）；已有记录由组件内部判 recordId 不聚焦
      autoFocusTitle: true,
      refreshTick: this.tick,
    ```
    只此一处传 `true`；`Index.ets:1555-1568` 的右栏 `RecordEditorView({...})` **未传**该 prop（已逐行核对）。
- **风险判断（defaultFocus 从手写板返回是否重复抢焦点）**：`Edit.ets:53-55` 的 `onPageShow()` 只做 `this.tick = this.tick + 1`，触发的是 `@Watch('onRefreshTick')`（`RecordEditorView.ets:96`）而非子组件重挂载；`defaultFocus` 是声明式属性，按 ArkUI 通常语义在首次布局时求值，因此**静态推断不会重新抢焦点**。但手写返回后 `title` 仍为空白（只回填了 `body`），表达式仍为 `true`；若某 ArkUI 版本在依赖状态变化时重求值，可能在返回瞬间把焦点拉回标题、软键盘遮挡刚回填的正文。**本机无 SDK/真机 → `unverified`**，列 P2-2。
- **是否阻塞**：否（P2 + unverified）。

#### A2 保存后局部刷新 —— **static 结论：直调链确实没有全量 bootstrap；6 种组合静态推演均成立；1 条精度修正 + 1 条误报边界；不阻塞**

- **结论 ①（直接调用）**：保存分支**没有**直接跑 `reconcileIfDue` / `loadSummary` / `paneTick++` / `ensureReady`。
- **证据**
  - `Index.ets:263-280`：
    ```
    onPageShow(): void {
      this.syncHomeFilter();
      if (this.ready) {
        const saved: SavedMarker | null = this.consumeSavedMarker();
        if (saved !== null) {
          // 保存返回：只重读列表（写盘与派生索引在 appendRecord 内已同步完成），
          // 不再跑 reconcileIfDue 全量对账、不重读汇总、不推进 paneTick。
          this.reload();
          this.reconcileSavedRow(saved);
          return;
        }
        // 从设置页 pull 回来也走这里：顺手做一次带节流的索引自愈…
        openIndexStore.reconcileIfDue();
        this.reload();
        this.loadSummary();
        this.paneTick = this.paneTick + 1;
        return;
      }
      …
    ```
    保存分支 `return` 在 `:273`，其后的 `:276`/`:277`/`:278`/`:279` 均不可达；`:282-290` 的 `ensureReady` 只在 `!this.ready` 时走（保存必然已 ready）。`b3Batch.test.mjs:206-216`（B3-07）用 `stripComments` 剥注释后断言 `SAVED_BRANCH_CODE` 不含 `loadSummary()` / `paneTick`。
  - `RecordEditorView.ets:627-631`：
    ```
    promptAction.showToast({ message: changed ? '已保存（待 AI 整理）' : '已保存' });
    // 一次性「保存返回」标记：必须在 onSaved（它会 router.back() 触发首页 onPageShow）之前写好…
    AppStorage.setOrCreate<string>(SAVED_MARKER_KEY, encodeSavedMarker(this.savedMarkerOf(record)));
    this.onSaved(record);
    ```
    标记写在 `onSaved`（`Edit.ets:126-128` 的 `router.back()`；右栏 `Index.ets:1559-1561` 的 `onEditorSaved`）**之前**，时序正确（B3-10c 钉住）。
- **结论 ②（精度修正，P2-4）**：「完全不再跑 reconcileIfDue」**字面上不成立**——`Index.ets:271` 的 `reload()` 在「全部未完成」tab 会走 `Index.ets:368` 的 `openIndexStore.pendingRecords(...)`，而 `openIndexStore.ets:292` 内部就是 `this.reconcileIfDue();`（带节流、幂等、只写本机索引）。这是**间接触发**，不是整页 bootstrap；数据正确、无用户可见错误，但 `Index.ets:269-270` 与 `homeRefresh.ts:8-13` 的注释措辞过强。
- **结论 ③（6 种组合静态推演）**，`reconcileSavedRow`（`Index.ets:317-334`）三条早退 + 兜底：
  ```
  if (this.showAllPending && saved.done === true) { return; }
  if (!this.showAllPending && saved.date !== this.selectedDate) { return; }
  if (containsRecordVersion(this.records, saved.id, saved.ts)) { return; }
  openIndexStore.reconcile(); this.reload(); this.loadSummary();
  promptAction.showToast({ message: '返回列表时没读到刚保存的日程，已重新加载', duration: toastMsFor(true) });
  ```
  | # | 组合 | `showAllPending` / `saved.done` / `saved.date` | `reload()` 数据源（`Index.ets:364-377`） | 判定 |
  | --- | --- | --- | --- | --- |
  | ① | 今日 tab 存今天新记录 | false / false / = selectedDate | `readDay(selectedDate)` | 新行在列；`containsRecordVersion` 命中 → 早退③ |
  | ② | 今日 tab 编辑旧记录（ts 保原日） | false / 任意 / = selectedDate（`savedMarkerOf` 取 `resolveRecordDate(record.ts)`，`RecordEditorView.ets:644`） | `readDay` → `foldById` 取 ts 更大新版本（`scheduleStore.ets:143-148`） | 命中 → 早退③ |
  | ③ | 全部未完成存 done=false | true / false / 任意 | `pendingRecords(includeOtherDevices)`（`Index.ets:368`） | 未完成行在列 → 早退③ |
  | ④ | 全部未完成存 done=true | true / true / 任意 | 同上，且 `openIndexStore` 写 `closedAt` + `resolveRecords` 过滤 `done:true`（`openIndexStore.ets:284` 注释） | **早退①**（本就不该出现），且 `reload()` 已把它移除 |
  | ⑤ | 存的是别的日期 | false / 任意 / ≠ selectedDate | `readDay(selectedDate)` | **早退②**（当前列表本就不该出现）；若 `showAllPending=true` 则按 ③/④ 判定，`pendingRecords` 跨全部日期仍含它 |
  | ⑥ | `includeOtherDevices` 打开 | 任意 | `readDayAllDevices(selectedDate)`（`Index.ets:374`）或 `pendingRecords(true)` | `containsRecordVersion` 按 id+ts 在全部设备折叠结果里比对（`homeRefresh.ts:112-120`）→ 命中 |
  - 标题 / 完成状态 / 日期分组都来自 `reload()` 重读的 `ScheduleRecord`（`title`/`done`/`ts` 原样在 JSONL 新行里，`scheduleStore.ets:308-326` 追加、`foldById` 取新版本），无需额外搬运。
  - 对账兜底：`appendRecord` 内同步调 `notifyAppend`（`scheduleStore.ets:325`）→ `openIndexStore.applyRecord`（`openIndexStore.ets:194-207` → `:592-593` 注册钩子），写盘与索引同栈完成；只有读不到刚存的版本才 `reconcile()+reload()+loadSummary()+toast`。
  - **误报边界（P2-1/P2-4）**：兜底 toast 在正常路径不会触发；但 `containsRecordVersion` 用**精确 ts**，若同一 id 在毫秒级被另一设备或在 Detail 页写新 ts，会误报「没读到刚保存的日程」（见 §3 P2-1 的具体路径）。
- **结论 ④（一次性读后即清）**：`Index.ets:302-305`
  ```
  const raw: string | undefined = AppStorage.get<string>(SAVED_MARKER_KEY);
  AppStorage.setOrCreate<string>(SAVED_MARKER_KEY, '');
  return decodeSavedMarker(raw);
  ```
  B3-08（`b3Batch.test.mjs:218-225`）正则钉死「get 之后紧接 setOrCreate、不许插语句」。右栏保存也在 `Index.ets:537-539` 由 `onEditorSaved` 主动 `consumeSavedMarker()`，避免遗留。
  **间接路径 `Detail → Edit → 保存 → 返回 Detail → 再返回首页`**：`Detail.ets:33-35` 的 `onPageShow()` **没有** consume，标记会留到首次回到 Index 才被消费；因此不会污染「下一次从设置页返回」（标记已被首次 Index 消费），但那一次 Index 返回会走局部分支；若期间在 Detail 里做了 AI 结构化保存（`RecordDetailView.ets:189-193` 写新 ts），兜底会误报。严重度 **P2**（数据无损、自愈、路径窄），详见 §3 P2-1。
- **是否阻塞**：否（P2×2）。

#### A3 跨设备合并 —— **无改动，static 成立；不阻塞**

- **证据**：`git diff --name-only -- apps/arkui-schedule` 只列 6 个文件，**不含** `services/scheduleStore.ets`、`services/openIndexStore.ets`、`services/GitSyncService.ets`、`services/syncController.ets`、`model/recordMerge.*`。
  - `scheduleStore.ets:308-326` 的 `appendRecord` 仍「物理追加 + `resolveRecordDate(record.ts)` 定分片 + `notifyAppend`」；`:348-357` 的 `notifyAppend` 仍吞异常、由下次自愈重建（`docs/FAILURE-MODES.md:160` 判为「有意静默」）。
  - `openIndexStore.ets:194-207`（`applyRecord` 幂等）/ `:213-257`（`reconcile`）/ `:264-273`（`reconcileIfDue` 节流）/ `:287-303`（`pendingRecords(includeOtherDevices)`，其他设备目录只读）全部未改。
  - B3 只在 `RecordEditorView` **新增**对既有 `scheduleStore.appendRecord` 的调用（`:605` 未变），`homeRefresh.ts` 是纯逻辑、不写盘、不进 JSONL（`docs/DATA-CONTRACT.md` §3/§4bis 字段形态零变化）。
- **是否阻塞**：否。

### B. 路径 2（UX-STEPS §2.2，8→6）

#### B4 生产者 Handwriting —— **static 成立；不阻塞**

- **证据**
  - `Handwriting.ets:1471-1474`（成功分支）：
    ```
    const autoSaveReady: boolean = body.trim().length > 0 || objectsJson.length > 0;
    AppStorage.setOrCreate<string>('handwriting.autosave', autoSaveReady ? '1' : '');
    if (!autoSaveReady) {
      promptAction.showToast({ message: '没有识别到文字：原图已保留，回到编辑页补充正文后再保存', duration: 4000 });
    }
    ```
    只有 `body` 或 `objectsJson` 非空写 `'1'`；空笔迹写 `''` 并给中文原因。
  - 写入位置在四路结果键之后：`:1450` `handwriting.result`、`:1451` `ocrText`、`:1454` `attachments`、`:1457` `pageObjects`，`:1472` 才是 `autosave`（`b3HandwritingAutoSave.test.mjs:152-174` 逐一定序）。
  - `:1477-1478`：`this.discardDraft(); router.back();` —— 顺序未变。
  - `:1479-1481`：`catch (error) { promptAction.showToast({ message: \`识别失败：…\` … }); }` —— catch 不写 `autosave`、不碰草稿（B3-10 测试 `:176-191` 钉死）。
  - `:930-936` `exitWritingBoard()`：`this.saveDraftNow(false);` → `:935` `AppStorage.setOrCreate<string>('handwriting.autosave', '');` → `:936` `router.back();` —— 退出先清标记。
  - 全文件 `autosave` 写入恰好 2 处（`:935` 清、`:1472` 条件写 `'1'`），测试 `:171-173` 计数确认。
- **是否阻塞**：否。（注：只插图、无文字、无 pageObjects 时 `autoSaveReady=false` 不自动保存 —— 这**正是派活口径**，按已知边界记 P2-6，非缺陷。）

#### B5 消费者 RecordEditorView —— **static 成立；不阻塞**

- **证据**
  - `RecordEditorView.ets:250-252`：
    ```
    onRefreshTick(): void {
      const applied: boolean = this.applyPendingInkResult();
      this.maybeAutoSaveAfterInk(applied);
    }
    ```
  - `:385-406` `maybeAutoSaveAfterInk`：
    ```
    const flag: string | undefined = AppStorage.get<string>('handwriting.autosave');
    AppStorage.setOrCreate<string>('handwriting.autosave', '');   // 读后立即清
    if (flag !== '1' || !applied) { return; }                      // 没信号 / 没回填（静默，注释已说明）
    if (this.saving) { return; }                                   // 正在保存（静默，save 另有闸）
    if (!this.ready || !this.loaded) { promptAction.showToast({ message: '手写内容已回填，但编辑页还没就绪：请稍后点「保存日程」', … }); return; }
    if (this.title.trim().length === 0) { promptAction.showToast({ message: '手写内容已回填：先填标题，再点「保存日程」', … }); return; }
    if (this.body.trim().length === 0 && this.attachments.length === 0 && this.pageObjectsJson.length === 0) { promptAction.showToast({ message: '没有可保存的内容：请补充正文后再保存', … }); return; }
    this.save();
    ```
    **四类早退都有可读原因**：未就绪 / 标题空 / 无内容三类各给中文 toast；「没信号 / 没回填」「正在保存」两类静默但 `:375-384` 的方法注释逐条说明「宁可多一步、保存中由 save 自己处理」，属**有意静默**，非漏报（`docs/FAILURE-MODES.md` §7「失败语义不静默」）。
  - **写盘失败留在编辑页、内容不丢**：`save()` 的 `:603-610`
    ```
    this.saving = true;
    try { scheduleStore.appendRecord(record); }
    catch (error) { this.saving = false; promptAction.showToast({ message: `保存失败：${describeError(error)}`, duration: toastMsFor(true) }); return; }
    ```
    注意标记写在 `:630`（catch 之后），**只有真正落盘成功才写**；失败时键已在 `:387` 被清，但 `save()` 的 `return` 让页面留在编辑页、表单内容完好，用户点「保存日程」即可重试，不会丢内容也不会重复保存。
  - **「正在保存」时 `applied` 仍为真但直接早退**：内容已在 `:338-370` 回填 + `schedulePersist()`（草稿落盘），不会丢。
- **是否阻塞**：否。

#### B6 回归风险（重复保存 / 四键读后清 / 结构断言）—— **static 成立；不阻塞**

- **重复保存**：唯一自动保存出口是 `:406 this.save()`，且 `save()` 自身 `:562-564` 有 `if (this.saving) { return; }` 闸；`maybeAutoSaveAfterInk` 又在 `:387` 先把 `handwriting.autosave` 清成 `''`，第二次触发（无论来自 `paneTick`、`refreshTick` 还是双挂载）读到的都是 `''` → `:388` 早退。`b3HandwritingAutoSave.test.mjs:124-133` 断言 `save()` 全方法恰好一次、所有前置 if 在 save 之前；`:128` 明确「save 只能调用一次（不许重复落盘）」。右栏与 Edit 页即使同时挂载，也只有一个组件能读到 `'1'`。
- **四键读后清语义一字未变**：`RecordEditorView.ets:340-366`，`handwriting.result`/`ocrText`/`pageObjects`/`attachments` 四路仍「非空才写表单 + 紧接 `setOrCreate(..., '')`」，只是各分支增 `applied = true;`（`:343`/`:349`/`:355`/`:363`）并在末尾 `:370 return applied;`。测试 `:135-150` 逐个键断言 get<clear、分支内置位、`return applied` 收尾。
- **工具条/草稿/分页结构**：`handwritingToolbar.test.mjs`（1209 行）全部通过（§1.3）；该文件未被本批改/删（`git diff --name-only -- tools/test` 为空）；`copy.test.mjs`/`uiTokens.test.mjs`/`uiTokens` 相关断言同样 251/251 通过。
- **是否阻塞**：否。

#### B7 内容回填语义（追加到正文）—— **未变，static 成立；不阻塞**

- **证据**：`RecordEditorView.ets:341-344`
  ```
  const text = AppStorage.get<string>('handwriting.result');
  if (text !== undefined && text.length > 0) {
    this.body = this.body.length > 0 ? `${this.body}\n${text}` : text;
    applied = true;
    AppStorage.setOrCreate<string>('handwriting.result', '');
  }
  ```
  `\n` 追加、非空才追加、读后即清三件事与改前一致（diff 只加 `applied = true;`）。`Handwriting.ets:1446-1448` 的 `composeBodyWithObjects` 仍负责每页文本 + 对象占位符拼接。
- **是否阻塞**：否。

### C. D1 P2（失焦归一）

#### C8 只改输入框文本 + 一次性 toast，不落盘不跳转，令牌纪律 —— **static 成立；不阻塞**

- **证据**
  - `Settings.ets:2031-2060` `normalizeRemoteOnBlur()`：
    ```
    const raw: string = this.remoteUrl;
    if (raw.trim().length === 0) { return; }
    const parsed: RemoteInputResult = parseRemoteInput(raw);
    if (!parsed.ok || parsed.kind !== 'url') { return; }   // 令牌片段 / 非法地址不改写
    const normalized: string = parsed.url;
    if (normalized === raw) { return; }
    if (this.lastBlurNormalizeText === raw) { return; }     // 同一原文只提示一次
    this.lastBlurNormalizeText = raw;
    this.remoteUrl = normalized;
    if (this.remoteMode === REMOTE_MODE_MANUAL) { this.remoteManualUrl = normalized; }
    this.remoteUrlError = '';
    if (!parsed.hadScheme) { promptAction.showToast({ message: '已自动补 http://', duration: toastMsFor(false) }); }
    else { promptAction.showToast({ message: '已把地址整理成可打开的形式', duration: toastMsFor(false) }); }
    ```
  - **判 `kind !== 'url'` 直接返回**：`remoteUrl.ts:435-478` 的 `parseRemoteInput` 先 `looksLikeTokenFragment`（`:388-393`，只认 `?` 开头或 `k=`/`token=` 开头）→ `kind='token'`；非法走 `remoteInputInvalid`（`kind='invalid'`）。二者都 `ok=false` 或 `kind!=='url'`，归一函数直接早退，`url` 留空，输入框不动。
  - **复用同一份地址规则**：`remoteUrl.ts:464` `const check: RemoteUrlCheck = normalizeRemoteUrl(text);`，`:472` `url: check.url`，`:475` `hadScheme: check.hadScheme` —— 补协议/校验仍只有 `normalizeRemoteUrl` 一份。
  - **绝不 mergeRemoteToken**：方法体全文无 `mergeRemoteToken`/`remoteToken`/`savedRemoteToken`（`b3Batch.test.mjs:285-293` B3-12 三条反向断言 + `:306-310` B3-14 断言无 `settingsStore.save`/`router.pushUrl`/`openRemote(`）；`credentialHygiene.test.mjs` 191 行全绿，未放宽。
  - **保存/跳转顺序未改**：`Settings.ets:2097-2136` 落盘（`settingsStore.save`）与 `:2134` toast `'已保存'`、`:2136` `router.pushUrl` 原封不动；失焦函数不碰它们。
  - 装配链：`RemoteSection.ets:337-345` `.onBlur(() => { this.onBlurRemoteUrl(); })` → `Settings.ets:2579-2581` `onBlurRemoteUrl: () => { this.normalizeRemoteOnBlur(); }`。`b3Batch.test.mjs:312-341`（B3-15/16）钉死「全文件 `.onBlur(` 恰好 1 处、紧跟 onChange 闭合、回调直转调」。
- **是否阻塞**：否。

#### C9 点「打开远程控制」时的失焦冲突 —— **不会改坏地址、不改变保存/跳转顺序；双 toast 可能但未验，P2；不阻塞**

- **判断**：① 浏览器/ArkUI 焦点语义下 blur 先于 click → `normalizeRemoteOnBlur()` 先把 `remoteUrl` 归一；`openRemote()`（`Settings.ets:2088`）再过一次 `normalizeRemoteUrl`，而 `parseRemoteInput` 的输出已是它的归一结果（`remoteUrl.ts:472`），**幂等**，不会把地址改坏。② 顺序上归一发生在 `openRemote()` 落盘之前，最终落盘 / 跳转参数用的是归一后的 `check.url`（`:2096`/`:2136`），更一致。③ toast 方面：失焦可能弹 `'已自动补 http://'`（`:2056`），`openRemote()` 成功再弹 `'已保存'`（`:2134`），**理论上两次**；ArkUI `promptAction.showToast` 通常为覆盖式（后一条替前一条），真机实际观感**unverified**。④ 非 `manual` 模式下 `openRemote()` 会按方式字段重算地址（`Settings.ets:2075-2083` `buildRemoteAccessUrl`），用户若手改了预览框，失焦提示的那条地址未必是最终打开的那条 —— 属既有「预览框可编辑」行为的放大，非 B3 引入的错写。详见 §3 P2-3。
- **是否阻塞**：否。

### D. 纪律与工程

#### D10 测试只新增、无放宽 —— **成立；不阻塞**

- **证据**：`git --no-pager diff --name-only -- apps/arkui-schedule/tools/test` **输出为空**（7 个删除行全在源码 import/注释/签名，见 §1.2）。两个新测试共 29 例：
  - `b3Batch.test.mjs:153-200`（B3-01…06）**实跑纯函数** `homeRefresh.js`：`SAVED_MARKER_KEY` 字面量、四字段往返、`done` 归 false、脏输入 9 种一律 null 不抛、字段顺序固定、版本判定的同 id 同 ts；不是空转。
  - `b3Batch.test.mjs:205-279`（B3-07…11）静态钉住：`stripComments` 后保存分支无 `loadSummary/paneTick`、get 后紧接 clear、三条早退 + 兜底 toast、`autoFocusTitle` 三条件、marker 写在 `onSaved` 前、`date` 由 `resolveRecordDate(ts)` 而非 `defaultDate`/`selectedDate`。
  - `b3HandwritingAutoSave.test.mjs:46-202`（10 例）钉住：先回填后判定、`applied` 显式 boolean、读后即清且中间无 return、四类早退、三处 toast + `toastMsFor(false)`、`save` 唯一且末句、四键读后清不变、`finish` 两处 autosave 写入、discard 在 back 前、catch 不碰草稿/标记。
  - 脆弱性（P2-5）：B3-13 逐字钉 toast 文案、B3-15 把 `.onBlur(` 计数钉死为 1、`methodBody`（`b3HandwritingAutoSave.test.mjs:35-42`）依赖两空格缩进 + `\n  }\n` 收尾，格式调整会让测试**失效**（非放宽，但增加维护成本）。
- **是否阻塞**：否。

#### D11 ArkTS 严格类型 / 无新依赖 / 数据格式 / BOM / Edit 薄壳 —— **成立；不阻塞**

- **证据**
  - 显式类型：`homeRefresh.ts:41-43` `safeString(value: string): string`、`:50` `encodeSavedMarker(marker: SavedMarker): string`、`:68` `decodeSavedMarker(raw: string|null|undefined): SavedMarker|null`、`:112` `containsRecordVersion(records: ScheduleRecord[], id: string, ts: string): boolean`；`RecordEditorView.ets:251` `const applied: boolean`、`:385` `(applied: boolean): void`、`:641` `(record: ScheduleRecord): SavedMarker`；`Index.ets:267` `const saved: SavedMarker | null`、`:317` `(saved: SavedMarker): void`；`Settings.ets:2032` `const raw: string`、`:2036` `const parsed: RemoteInputResult`、`:2040` `const normalized: string`。**新增行 `git diff -U0 | grep '^\+.*\bany\b'` = 0 命中**。
  - 无新依赖：`git status` 无 `package.json`/lock 变更；`validate-app` 8/8。
  - 数据格式：`homeRefresh.ts` 只定义 AppStorage 键 `home.lastSaved`（`:19`）与内存结构，不写 `devices/<id>/**`、不进 JSONL；`docs/DATA-CONTRACT.md` §3/§4bis 字段形态未变；`credentialHygiene.test.mjs` 的「ScheduleRecord 无凭据字段 / encodeRecord 键名无 token」两条断言仍绿。
  - `.ps1` BOM：`git status --short` 无 `.ps1`，无构建脚本改动。
  - `Edit.ets` 全文 `showToast` **0 命中**（`grep` 实数；`b3Batch.test.mjs:275-278` B3-11 亦断言），仅 `promptAction.showDialog`（`:89`）—— 薄壳纪律保持。
- **是否阻塞**：否。

#### D12 失败语义不静默 —— **成立（有意静默项均有注释）；不阻塞**

- **证据**：新增的早退 / catch 逐条：
  - `maybeAutoSaveAfterInk:388` `flag !== '1' || !applied` → 方法注释 `:375-384` 解释「没信号/空回来 = 用户明确不保存或失败，宁可多一步」；`:391` `this.saving` → 注释 `:383` + `save()` 自身闸；其余三类各中文 toast（`:395`/`:399`/`:403`）。
  - `Handwriting.ets:1473-1475` 空内容给 4s toast；`:1480` catch 给 5s `识别失败`；`exitWritingBoard:935` 清标记无异常路径。
  - `normalizeRemoteOnBlur:2033-2046` 四次早退都有方法注释 `:2025-2029` 说明「不猜、不落盘、不刷屏」。
  - `consumeSavedMarker` 解码失败 → `decodeSavedMarker` 返回 null → `onPageShow` 落入 `:275-280` 全量分支（等价于「标记无效就走老路」，无需额外提示）；`decodeSavedMarker:68-105` 对 9 类脏输入一律 null 不抛（B3-04 实跑）。
  - `reconcileSavedRow:318/321/324` 三条早退注释逐条对应「本就不该在该 tab / 该日期 / 已是最新版」；兜底 toast `:330-333` 明确。
- **是否阻塞**：否。

---

## 3 发现清单（P0 / P1 / P2）

> P0 = 数据丢失 / 错写 / 安全隐患；P1 = 用户可见的错误行为或契约被破坏；P2 = 边界 / 可维护性 / 文档 / 未验项。本批 **P0 0 / P1 0 / P2 6**。

### P2-1 间接路径的陈旧标记可触发「没读到刚保存的日程」误报

- **现象**：`Index → Detail → Edit → 保存 → 返回 Detail → 再返回首页` 这条路径中，`Detail.ets` 不消费 `home.lastSaved`，标记留到首次回 Index 才被消费；若用户在 Detail 里又用「AI 结构化保存」（`RecordDetailView.ets:189-193` 用 `nextTsSameDate` 写同 id 新 ts、不写标记），再返回首页时 `reconcileSavedRow` 的精确 ts 比对失配，兜底会 toast「返回列表时没读到刚保存的日程，已重新加载」—— 实际两者都保存成功，属误报。
- **证据**：`apps/arkui-schedule/entry/src/main/ets/pages/Detail.ets:33-35`（`onPageShow` 只 `tick+1`，全文无 `consumeSavedMarker`）；`Index.ets:267-273`、`:324-334`；`components/RecordDetailView.ets:189-193`；`homeRefresh.ts:112-120`（`containsRecordVersion` 精确 ts）。
- **影响**：一次误导性的中文 toast + 一次多余的 `reconcile()+reload()+loadSummary()`；**数据无损、自愈、路径较窄**，故 P2 而非 P1。
- **建议修法**：在 `Detail.ets` 的 `onPageShow()`（`:33`）或 `RecordDetailView` 每次 `appendRecord` 成功后消费 / 覆盖 `home.lastSaved`（例如 `AppStorage.setOrCreate<string>(SAVED_MARKER_KEY, '')`）；或把兜底 toast 改成中性文案「列表已重新加载」，避免断言「没读到」。最小改动是后者。

### P2-2 `defaultFocus` 在从手写板返回时是否重复抢焦点 —— unverified

- **现象**：回到编辑页后 `title` 仍为空白，`RecordEditorView.ets:776` 的 `defaultFocus` 表达式仍为 true；若某 ArkUI 版本在依赖变化时重求值或页面重新获焦时重新应用，会把焦点拉回标题、软键盘遮挡刚回填的正文。静态推断（`@Watch` 不触发重挂载）认为不会，但**本机无 SDK/真机，无法证实**。
- **证据**：`RecordEditorView.ets:87-94`、`:776`；`Edit.ets:53-55`（`onPageShow` 只加 `tick`）。
- **影响**：最多是软键盘遮挡 / 焦点跳动，不影响数据。
- **建议修法**：真机验证；若复现，把 `.defaultFocus(...)` 改为由一次性 `@State focusOnce` 控制并在首次聚焦后置 false，或在 `aboutToAppear` 里一次性 `focusControl.requestFocus`（需 DevEco 验证新增 import 可用性）。

### P2-3 「打开远程控制」失焦归一 + 正式保存的双 toast / 非 manual 预览框分歧 —— unverified

- **现象**：输入框仍有焦点时点「打开远程控制」，先触发失焦归一 toast（`Settings.ets:2056`/`:2058`），再触发正式保存 toast `已保存`（`:2134`），可能叠加或互相覆盖；非 `manual` 模式下 `openRemote()` 按方式字段重算地址（`:2075-2083`），失焦提示「已自动补 http://」的那条未必是最终打开的地址。
- **证据**：`RemoteSection.ets:337-345`；`Settings.ets:2031-2060`、`:2072-2096`、`:2134-2136`；`remoteUrl.ts:464-475`。
- **影响**：纯提示层观感；地址不会改坏、保存/跳转顺序不变，无契约破坏。
- **建议修法**：真机确认 toast 是否叠加；若需消除，把失焦归一的 toast 省掉（只改文本，提示交给 `openRemote()` 的 `已保存`），或在非 `manual` 模式下不对预览框做失焦归一提示。

### P2-4 「保存分支完全不跑 reconcileIfDue」注释措辞过强；精确 ts 判定有并发误报边界

- **现象**：`Index.ets:269-270` 与 `homeRefresh.ts:8-13` 写「不再跑 reconcileIfDue / 全量对账」，但「全部未完成」tab 的 `reload()` 经 `openIndexStore.pendingRecords()` 会**间接触发** `reconcileIfDue()`（节流、幂等）；另外 `containsRecordVersion` 用精确 ts，另一设备毫秒级写入同 id 新 ts 时会误报兜底 toast。
- **证据**：`Index.ets:271`、`:368`；`services/openIndexStore.ets:292`；`homeRefresh.ts:112-120`；`Index.ets:324-334`。
- **影响**：无数据错误；注释与实现措辞不一致会误导后人，误报边界极窄。
- **建议修法**：把注释改为「保存分支不再**直接**跑全量对账；列表重载在『全部未完成』tab 会间接触发节流自愈」；如需消除误报，把 `containsRecordVersion` 判据放宽为「同 id 且 ts ≥ saved.ts」。

### P2-5 新增静态测试的脆弱性与小缺口

- **现象**：B3-13 逐字钉 toast 文案、B3-15 把 `.onBlur(` 计数钉死为 1、`methodBody` 依赖两空格缩进 + `\n  }\n` 收尾；B3-07 未显式断言保存分支不含 `openIndexStore.reconcileIfDue()`（当前无，靠 `return` 保证）。
- **证据**：`tools/test/b3Batch.test.mjs:206-216`、`:295-335`；`tools/test/b3HandwritingAutoSave.test.mjs:35-42`。
- **影响**：合法的格式 / 文案调整会让测试变红（维护成本），或放过「保存分支里加了全量对账」的假设性回归。
- **建议修法**：toast 文案改 `/已自动补 http/` 模式匹配；`.onBlur(` 计数改为「地址框之后恰好一次」的局部断言；`methodBody` 用大括号配平（可参考 `b3Batch.test.mjs:28-45` 的 `bodyFrom`）；B3-07 增 `assert.equal(SAVED_BRANCH_CODE.includes('reconcileIfDue'), false)`。

### P2-6 只插图（无文字 / 无 pageObjects）的手写不触发自动保存（已知边界，按派活口径非缺陷）

- **现象**：`autoSaveReady = body.trim().length > 0 || objectsJson.length > 0` 不含 `attachments`；用户只插入图片、没有 OCR 文字 / 页面对象时不会自动保存，路径 2 的省 tap 收益在该变体缺失。
- **证据**：`Handwriting.ets:1471-1474`；`RecordEditorView.ets:402`（无内容分支 toast 后 return）。
- **影响**：多一次手动保存 tap；数据不丢（附件已回填、草稿已 schedulePersist）。
- **建议修法**：若产品希望覆盖该变体，把判据改为 `body.trim().length > 0 || objectsJson.length > 0 || packed.length > 0`（`packed` 在 `:1453` 已算出，需把 `autoSaveReady` 判定移到其后并同步改 `b3HandwritingAutoSave.test.mjs:155` 的断言）；否则接受为已知边界、在 UX-STEPS §4.3 记一句。

---

## 4 可信度边界（unverified 清单：什么没验 / 为什么 / 影响哪条结论）

1. **ArkTS 编译**：本机无 DevEco / 无 HarmonyOS SDK、`node_modules` 无 ArkUI d.ts。`.defaultFocus(...)` 的可用性与参数形态、`AppStorage.setOrCreate<string>` 泛型写法、`@Prop @Watch` 组合、`RemoteInputResult` 类型导入 — 全部 `unverified`；影响 A1 / C8 的「提交前可编译」隐含门槛。`tsc`（纯逻辑层）exit 0 不能替代 DevEco 编译。
2. **`defaultFocus` 行为**：是否在页面重新获焦 / 依赖状态变化时重求值 → 手写返回是否抢焦点（P2-2），`unverified`；影响 A1 风险判断。
3. **toast 叠加**：`promptAction.showToast` 连续两次（失焦归一 + `已保存`）的显示效果（覆盖 / 排队 / 并排）`unverified`；影响 C9 / P2-3。
4. **真机键盘遮挡**：新建自动聚焦后软键盘是否顶掉正文 / 保存按钮（UX-STEPS §5.2 既有项），`unverified`。
5. **导航栈时序**：`Detail → Edit → 保存 → 返回 Detail → 返回首页` 各 `onPageShow` 的真实触发顺序与次数（`Detail.ets:33`、`Index.ets:263`）`unverified`；P2-1 的路径推演基于 ArkUI 标准页面生命周期。
6. **跨设备并发**：`containsRecordVersion` 精确 ts 在另一设备毫秒级写入同 id 新 ts 时的误报（P2-4），未做并发真机实验。
7. **`.ps1` BOM**：无 `.ps1` 改动，故未触碰；仅从 `git status` 静态确认。
8. **数据格式**：`homeRefresh.ts` 只写 AppStorage，不写 JSONL；`credentialHygiene` / `exportImport` 测试绿；但**真机落盘字节形态未验**（无设备）。

> 以上任何一条都不得写成「已验证」；本评审所有真机相关表述均为 `unverified`，提交前须在 DevEco 编译并真机走查。

---

## 5 给规划者的返工建议

**结论：不阻塞提交。** 若追求干净收尾，按性价比排序（均非必须）：

1. **（推荐，最小改动）消 P2-1 误报**：`apps/arkui-schedule/entry/src/main/ets/pages/Detail.ets:33` 的 `onPageShow()` 里清掉一次性标记 —— 在 `this.tick = this.tick + 1;` 后加 `AppStorage.setOrCreate<string>(SAVED_MARKER_KEY, '');`（需从 `model/homeRefresh` 导入 `SAVED_MARKER_KEY`），或更保守地把 `Index.ets:331` 的兜底 toast 文案改成中性的「列表已重新加载」。前者从根上消掉陈旧标记，后者只改文案。
2. **（可选）改 P2-4 注释**：`Index.ets:269-270` 与 `homeRefresh.ts:8-13` 把「不再跑 reconcileIfDue」改成「不再直接跑全量对账；『全部未完成』tab 的列表重载会间接触发节流自愈」，避免后人对着 `openIndexStore.ets:292` 产生「注释说谎」的困惑。
3. **（可选）降 P2-5 脆弱性**：`b3Batch.test.mjs:296`（文案逐字）、`:334`（`.onBlur(` 计数）、`b3HandwritingAutoSave.test.mjs:35-42`（缩进依赖）—— 按 §3 建议改成模式匹配 / 大括号配平；B3-07 补一条 `assert.equal(SAVED_BRANCH_CODE.includes('reconcileIfDue'), false)`。
4. **（产品决策）P2-6**：确认「只插图」是否也算「有内容可自动保存」；若要覆盖，改 `Handwriting.ets:1471` 判据并同步 `b3HandwritingAutoSave.test.mjs:155`；否则接受为已知边界。
5. **（提交前必做，与 B2 一致）**：在 DevEco 上跑一次 `powershell -File apps/arkui-schedule/tools/build-harmony.ps1`，真机走查 §4 第 2/3/5 条（focus、toast、导航时序）；本机 `hdc` 不可用，这些不能由本评审替代。

**文档一致性（仅记录，未修改；本批 docs 由规划者并行处理，已排除）**
- 评审开始时 `docs/UX-STEPS.md` / `docs/ROADMAP.md` 为 clean；收尾时分别为 `M`（`+73` / `+59 -13`），系规划者并发写入，本评审未碰。
- `docs/UX-STEPS.md:9,13` 头部基准仍是旧 HEAD（`379fcc5` 系列）；派活方更新 §4.3 时请同步 HEAD 到 `8435b38`，并按 §1 v1 口径补「改后 = M 步」两行（路径 1 目标 4、路径 2 目标 6）。本评审只做只读判定，**不替规划者写这两份文档**。

---

（本报告为独立只读评审原文；未改任何源码 / 测试 / 既有文档，未 commit / push，未碰 .git 写操作 / profile / .ps1 / 依赖。唯一写入文件为 `docs/REVIEW-b3-batch.md`。）
