# 独立评审：`mod-quick-record`（首页底部快捷记录）

> 角色：独立、只读评审执行子代理。本文只评审未提交工作树中的代码改动，不修改任何被评审文件。
> 评审对象：`model/quickRecord.ts`（48 行）、`components/QuickRecordBar.ets`（84 行）、
> `pages/Index.ets`（+74 −1）、`tools/test/quickRecord.test.mjs`（16 例）、
> `tools/test/quickRecordUi.test.mjs`（14 例）。
> 前置阅读：`项目理解.md`、`docs/MODULES.md`、`docs/UX-STEPS.md` §1/§4.5。
> 评审时 `git status --porcelain` 另有 `docs/MODULES.md` / `docs/ROADMAP.md` / `docs/UX-STEPS.md`
> 被并行编辑（Designer 的交付登记），**代码 diff 在评审期间保持不变**（`Index.ets` 仍是 +74 −1）。

## 1. 结论

| 级别 | 数量 | 说明 |
| --- | --- | --- |
| P0 | 0 | 无数据损坏 / 契约破坏 / 页头回归 |
| P1 | 0 | 无阻断性缺陷 |
| P2 | 3 | 全部**不阻塞**交付，建议下一批或本批提交前顺手修 |

**Verdict：通过（non-blocking）。** 行为契约、页头零改动、组件单一职责、`cached()` 作者取值、
命名无冲突、步数口径、30 例新测试与全部五项门闸都成立且可复现。三个 P2 都是「文案/测试覆盖/
回滚登记精度」层面的问题，不影响功能正确性与数据契约。

三个 P2 摘要：

- **P2-1（文案，建议修）**：输入框占位符承诺「回车或点『保存』」，但键盘回车**没有接线**，
  按钮是唯一入口。属于「提示了一个不存在的操作」，违反 `项目理解.md` §1 的
  「No fake entries」精神（虽然它不是按钮）。详见 §2。
- **P2-2（测试覆盖，建议补断言）**：append-throw 与 store-not-ready 的**文案**、`quickBusy`
  复位、作者回落分支都只有「源码里出现过」的静态断言，没有「在正确分支里」的结构断言；
  当前实现正确，但这些断言挡不住「把 toast 挪到 catch 外」这类回归。详见 §5。
- **P2-3（回滚登记精度，建议改文档）**：`docs/MODULES.md` §1 本模块回滚方式写的是
  「`git revert <hash>`（2 新增 + Index.ets 增量）」，实际新增文件是 **4 个**
  （2 个代码 + 2 个测试）；照字面回滚会留下两个孤儿测试文件。详见 §2.6。

---

## 2. Findings（含 `file:line` 与原文引用）

### 2.1 行为契约（全部成立）

保存入口 `pages/Index.ets:509-541` 的顺序、守卫、写入与反馈：

```ts
509: private submitQuickRecord(rawTitle: string): boolean {
510:   const plan: QuickRecordPlan = planQuickRecord(rawTitle, this.selectedDate, new Date());
511:   if (!plan.ok) {
512:     promptAction.showToast({ message: plan.reason, duration: toastMsFor(true) });
513:     return false;
514:   }
515:   if (!scheduleStore.isReady()) {
516:     promptAction.showToast({ message: '存储尚未就绪，请稍后重试' });
517:     return false;
518:   }
519:   const record: ScheduleRecord = {
520:     id: newRecordId(),
521:     ts: plan.ts,
522:     title: plan.title,
523:     body: '',
524:     author: this.defaultAuthorOrMe(),
525:     done: false,
526:     ai_processed: false
527:   };
528:   this.quickBusy = true;
529:   try {
530:     scheduleStore.appendRecord(record);
531:   } catch (error) {
532:     this.quickBusy = false;
533:     promptAction.showToast({ message: `保存失败：${describeError(error)}`, duration: toastMsFor(true) });
534:     return false;
535:   }
536:   this.quickBusy = false;
537:   this.reload();
538:   this.loadSummary();
539:   promptAction.showToast({ message: '已记下' });
540:   return true;
541: }
```

- **当前所选日期**：`:510` 把 `this.selectedDate`（`Index.ets:124` 的 `@State`，首页日期条用
  `pickDate()` 改它）显式传入，没有另起日期来源。
- **不引入第二种日期格式**：`model/quickRecord.ts:43` 只调 `tsForDate(dateKey, now)`；
  `tsForDate` 是 `recordSaveTs.ts:57` 的唯一日期落点（`dateKey + nowIso(now).slice(10)`）。
  `quickRecord.test.mjs:192` 还用源码断言钉死 `import { tsForDate } from './recordSaveTs';`。
- **派生索引钩子**：`:530` 走 `scheduleStore.appendRecord()`（`scheduleStore.ets:308`），
  写后触发 `openIndexStore.applyRecord`（`scheduleStore.ets` 的 `appendHook`，注册见
  `openIndexStore.ets`）；没有绕过写路径直写文件。
- **刷新**：`:537-538` 同步 `reload()`（`Index.ets:367`，按 `selectedDate` 读当日分片）
  与 `loadSummary()`（`Index.ets:688`）。
- **恰好一条中文成功 toast**：`:539` 的 `已记下`；失败分支各一条原因 toast，成功路径无第二条。
- **四类失败零写入**：空标题 → `quickRecord.ts:40-41` `请输入标题`；非法日期 → `:44-45`
  `日期不合法：请重新选择日期`；store 未就绪 → `Index.ets:515-517`；`appendRecord` 抛错 →
  `:531-534`。顺序核对：`!plan.ok`（`:511`）< `isReady`（`:515`）< `appendRecord`（`:530`），
  **守卫全部在写之前**；`quickRecordUi.test.mjs:155` 也断言了这个顺序。
- **不写 `SAVED_MARKER_KEY` / 不碰 `onPageShow`**：`grep SAVED_MARKER_KEY Index.ets` 只有
  `:57`（import）、`:311-312`（`consumeSavedMarker` 读后即清）与 `:506` 的注释；
  `submitQuickRecord` 内没有该键也没有 `await`。`onPageShow`（`:269-302`）一字未改
  （`git diff` 无该段 hunk）。

**P2-1 — 占位符与实现不一致**：

`components/QuickRecordBar.ets:56`：

```ts
56: TextInput({ text: this.text, placeholder: '快速记一条：标题，回车或点「保存」' })
```

同文件 `:17-18` 明确承认「本版**只用「保存」按钮提交**，没有绑键盘回车事件」；
`docs/UX-STEPS.md:625-627` 也把它登记为已知限制。但占位符仍写着「回车或点」，用户按回车
预期落盘却什么都不会发生——这是「提示了不存在的能力」。两种修法二选一：
① 把占位符改为「快速记一条：标题，点『保存』」（最小改动、零风险）；
② 真机验证 `TextInput.onSubmit` 的 ArkTS 签名后再接线（当前无 SDK，不可验）。
**不阻塞**：保存主链路完整可用，且该不一致已被文档显式登记。

### 2.2 页头零改动 / Builder 位置（成立）

- `PageLayout({` 在 `Index.ets:1997-2011`，属性只有 `title` / `subtitle` /
  `headerActionTwo: '⚙ 设置'` / `onHeaderActionTwo` / `onBreakpointChange`，
  **没有任何 `headerActionOne` 或新增动作**；`git diff` 中无 `PageLayout` 段。
- `tools/test/indexHeader.test.mjs` 不在 `git status` 改动清单里（字节未动），全量门闸绿。
- `this.QuickRecordRow()` 恰好两次：`Index.ets:1722`（`CompactBody`，`:1723` 紧接
  `this.PrimaryAction()`）与 `:1756`（`WideBody`，`:1757` 紧接 `this.SidebarAction()`）。
  两处都在 `Column(...).layoutWeight(1)` 之后、主操作之前，即列表区固定底行，不在滚动区内。

### 2.3 组件契约（成立）

`QuickRecordBar.ets` 全文 84 行；`quickRecordUi.test.mjs:97-130` 的 6 条静态断言逐条核对：

- `:56` 唯一 `TextInput(`、`:69` 唯一 `ActionButton({`，按钮文案 `:70` `label: '保存'`。
- 按钮 prop 用的是 `actionEnabled`（`:71`），**不是** `enabled`；`ActionButton.ets:42` 确认
  该 prop 存在且语义为「业务上是否可用；false 时仍可点，点击给出 `disabledReason`」。
- `:35` `onSubmit: (title: string) => boolean = () => false`。
- `:48-51` 只有 `const saved: boolean = this.onSubmit(this.text); if (saved) { this.text = ''; }`
  一处清空；失败保留原文。`TextInput({ text: this.text })` + `onChange` 的单向绑定写法与
  全仓 24 处既有 `TextInput` 一致（`Chats.ets:203`、`RecordEditorView.ets:829` 等），
  不是新引入的模式。
- **无日期 UI**：组件里没有 `DatePicker` / `MonthCalendar` / `CalendarPicker` / `selectedDate`；
  UI 测试 `:125-127` 逐个禁词断言。
- **token / 颜色合规**：`FONT.body`、`FONT.caption`、`RADIUS.sm`、`SPACING.sm/md`、
  `TOUCH_MIN` 全部来自 `common/uiTokens.ts`（该文件 `:84/:92/:95/:116` 分别定义）；
  颜色只有 `$r('app.color.text_primary')` 与 `$r('app.color.surface')`，无硬编码色值；
  `toastMsFor` 来自 `common/copy.ts:92`。

### 2.4 作者来源 `settingsStore.cached()` 的可靠性（证明成立）

**结论：sound（是），有 proof、也有兜底。**

1. `cached()` 是真实 public API：`services/settingsStore.ets:488-491`
   `cached(): ScheduleSettings | null { return this.cache; }`。
2. 它**确实可能返回 `null`**：`private cache: ScheduleSettings | null = null`（`:353`），
   只在 `load()`（`:484`）、`save()`（`:717`）、`saveSyncState()`（`:781`）里赋值。
   但 `Index.ets:495-499` 已经处理了 null：

   ```ts
   495: const settings = settingsStore.cached();
   496: if (settings !== null && settings.author.trim().length > 0) {
   497:   return settings.author.trim();
   498: }
   499: return '我';
   ```

3. **`isReady()` 是否蕴含缓存已填充？是，可静态证明**：`scheduleStore.ets`
   `private ready: boolean = false`（`:69`），全文件 `this.ready = true` **只有一处**（`:83`），
   位于 `ensureReady()` 内，且在该行之前 `:79` 已 `await settingsStore.load(abilityContext)`；
   `load()` 在返回前 `:484 this.cache = settings`。因此凡 `isReady() === true`，缓存必非空。
   所有把 `ready` 置真的入口（`Index.bootstrap()` `:347`、`onPageShow` 的
   `summaryStore.ensureReady` `:290-291`、`EntryAbility.ets:59`、以及 `summaryStore` /
   `openIndexStore` / `attachmentStore` 的 `ensureReady`）都经 `scheduleStore.ensureReady()`，
   没有旁路 setter（grep `this.ready =` 命中 2 处：声明 + `:83`）。
4. 双重保险：`defaultAuthorOrMe()` 在 `!isReady()` 守卫（`:515`）**之后**才被调用（`:524`），
   且 null 分支回落「我」。即便未来有人加了旁路 ready setter，也不会写出空作者。

> 唯一保留项：真机冷启动时序无法验证（`unverified`），但静态链路已经闭合，风险被兜底吸收。

### 2.5 命名冲突检查（无冲突）

`grep -n 'QuickRecordBar' Index.ets` 命中 **2 行**：`:75` import 与 `:1223` builder 内的组件调用；
builder 自身叫 `QuickRecordRow()`（`:1222`），与导入的 struct `QuickRecordBar` 不同名，
没有 ArkTS struct 重名。历史坑 `CalendarPicker` 撞内置类型（见 `MODULES.md` §2 的
`mod-arkts-first-build`）在这里不适用：`QuickRecordBar` 不是 ArkUI 内置类型。
ArkTS 真实编译仍 `unverified`（本机无 DevEco/SDK）。

### 2.6 P2-3 — 回滚登记少算了两个文件

`docs/MODULES.md:33`（并行编辑后的当前文本）：

```
| mod-quick-record | 首页底部快捷记录（不跳编辑页，路径 1 5→3） | 已写完，待提交 | （Lead 填） | git revert <hash>（2 新增 + Index.ets 增量，页头未动） | ... |
```

实际新增文件是 4 个（`quickRecord.ts`、`QuickRecordBar.ets`、`quickRecord.test.mjs`、
`quickRecordUi.test.mjs`）。建议改成「4 新增 + Index.ets 增量」或「删除 4 新增文件 + revert
Index.ets」；否则按字面执行回滚会留下两个引用已删模块的测试文件，违反 `MODULES.md` §0
第 4 条「自己的测试 + 回滚路径三样齐全」。**非代码缺陷，不阻塞。**

---

## 3. 行为轨迹（tap → write → list refresh）

1. **tap**：点 `QuickRecordBar` 底部「保存」→ `ActionButton.handleClick()`
   （`ActionButton.ets:100-118`）先问 `resolveButton(actionEnabled, busy, disabledReason)`：
   空标题 / 忙碌时只弹原因 toast，不执行 `onTap`；可点时走 `onTap` → `QuickRecordBar.handleSave()`
   （`:43-52`）→ 再挡一次空标题 → `this.onSubmit(this.text)` → `Index` builder 的闭包
   （`:1226`）→ `submitQuickRecord(title)`。
2. **write**：`planQuickRecord(title, selectedDate, new Date())` → `tsForDate` 生成 ts →
   三道守卫（空/坏 plan、store 未就绪、try/catch）→ `newRecordId()` → `ScheduleRecord`
   → `scheduleStore.appendRecord(record)` **同步**追加到 `schedules/<selectedDate>.jsonl`，
   并在同一栈触发 `openIndexStore.applyRecord`派生索引钩子。
3. **list refresh**：`quickBusy=false` → `reload()` 同步读 `selectedDate` 分片（或「全部未完成」
   的 pending 索引）→ `loadSummary()` 同步读当日汇总 → 一条 `已记下` toast → `return true`
   → `QuickRecordBar.handleSave()` 清 `text`，输入框变空。
   全程 **0 个 `await`**（UI 测试 `:186` 断言），无 `router.pushUrl`、无 `SAVED_MARKER_KEY`、
   无 `onPageShow` 依赖。

失败轨迹：任一道守卫失败或 `appendRecord` 抛错 → 只弹原因 toast、`return false`、
**不清输入框**、不调 `reload()`/`loadSummary()`、不弹 `已记下`；用户改完原文可直接重试。

---

## 4. 步数口径裁决（§4.5 的 5 → 3 成立 / defensible）

`docs/UX-STEPS.md:599-601` 的路径 1 算式：改前 **5**（tap 3 + wait 2）→ 改后 **3**（tap 2 + wait 1），差 **−2**。

逐项对 §1（v1）口径复核：

| 单位 | 改后 | 依据 |
| --- | --- | --- |
| tap | 2 | ①聚焦快捷标题框 = 1 tap（§1.2 第 1 条：聚焦算 1 tap，敲字不计数）；②点快捷条「保存」= 1 tap。没有 `新建`、没有正文框、没有页头/日期 tap。 |
| scroll | 0 | `QuickRecordRow()` 在 `Index.ets:1722/1756`，是 `Column(layoutWeight(1))` 之后的**固定底行**，与可滚动的 `RecordList` 是兄弟节点，不需要滚动才看得到。 |
| wait | 1 | 只剩「冷启动首屏 1」。**没有编辑页 bootstrap**：`submitQuickRecord` 全程同步（§1 定义 wait = 必须等异步返回），`appendRecord` 是同步写 + 同步派生索引钩子；`reload()`/`loadSummary()` 都是同步读。承接 §4.3 口径，改前的 2 个 wait（冷启动 + 编辑页 bootstrap）少掉的就是后者。 |

- 与 §1.2 第 6 条「同一动作不拆两次」一致：只有一次「保存」tap，没有额外的跳转 wait。
- 与 §1.2 第 1 条一致：输入标题不另计 tap。
- §4.5 承接 §4.3/§4.4 合计 **33 → 31**，与逐项算式自洽；相对最初 §2.0 口径是 43 → 31。
- 注意：§4.3 曾明确「编辑页 bootstrap 算 1 wait，若要改成不算需真机证明」；本批**不是**改口径，
  而是**完全不走编辑页**，因此少 1 wait 的理由与 §4.3 的保留意见不冲突。
- 结论：**defensible**。唯一仍未真机测的是「固定底行是否被软键盘遮挡」（§5.2 既有风险，
  若被顶出则需 +1 scroll），已由 §4.5 自身登记为 `unverified`。

---

## 5. 测试质量评估

### 5.1 30 例是否为真契约检查（是）

- `quickRecord.test.mjs` **16 例**：纯逻辑实跑（编译产物 `.build/model/quickRecord.js`），
  严格断言覆盖 trim / 空标题 / 纯空白 / 字段形状 / 空日期 / 不存在的日历日 / 非规范格式 /
  多种坏日期 / 闰日 / 过去·今天·未来落片 / 逐字节 `nowIso` 相等 / 确定性 / 入参 `Date` 不被改 /
  非字符串标题不抛错 / 源码禁 `Date.now()` 且必须 import `tsForDate`。
  在「用 `nowIso()` 代替 `tsForDate`」「忘了 trim」「脏日期写盘」等实现上都会失败。
- `quickRecordUi.test.mjs` **14 例**：`stripComments` + `bodyFrom` 源码级接线断言，
  覆盖组件唯一性、`actionEnabled`、成功才清空、无日期 UI、Builder 两处渲染且在新建之上、
  守卫顺序、记录字段、作者来源、错误 toast、`reload`+`loadSummary`+`已记下`、零 `await`、
  不写 `SAVED_MARKER_KEY`、`PageLayout` 无第二动作、`indexHeader` 守卫文件仍存在。
  对「把快捷条挪进页头」「把 `actionEnabled` 写回 `enabled`」「删掉成功 toast」等回归会红。

### 5.2 缺口（对应 P2-2，不阻塞）

| 缺口 | 现状 | 建议 |
| --- | --- | --- |
| append-throw 的结构断言 | `:178` 只 `assert.match` `保存失败：…${describeError(error)}` 出现 | 再断言该字符串位于 `catch` 体内、且 `reload()`/`已记下` 不在 catch 内 |
| store-not-ready 文案 | `:157` 只断言 `scheduleStore.isReady()` 出现 | 加 `存储尚未就绪，请稍后重试` 的逐字断言 |
| `quickBusy` 重入 | `:136` 只断言 `busy: this.quickBusy` 传入 | 加 `quickBusy = true` 在 `appendRecord` 前、catch 与成功后各复位一次的断言 |
| 作者回落 | `:169-172` 静态断言 `return '我'` | 静态断言已是 `.ets` 唯一可行方式；可加「null 分支在 `settings.author` 访问之前」的顺序断言 |
| 测试标题 | `quickRecord.test.mjs:112` 标题写「非字符串」，入参数组全是字符串 | 改标题或补一个非字符串 dateKey 用例（`tsForDate` 已有 `typeof` 守卫） |

### 5.3 与既有套件的关系（无削弱）

`git status --porcelain` 中**没有任何既有测试文件被修改**（只有 `Index.ets` + 4 个新文件；
另外三个 `docs/*.md` 是 Designer 并行改的交付登记，不属于测试）。`indexHeader.test.mjs`
字节未动且全量绿。新 UI 测试里的「`indexHeader` 守卫未被削弱」检查（`:198-203`）只验三个
关键字符串仍在，表达力弱于字节比对，但真实文件确实没动，因此不构成回归风险。

---

## 6. 门闸（复现结果，尾部原文）

工作目录：`C:\Users\GWL\Desktop\itwillclaude\dsh-sync-suite`。

**6.1 `node apps/arkui-schedule/tools/overlay.mjs status`**

```
覆盖层：未应用（工作区为「共享源码 + 平台目录」的原始形态）
[overlay] applied=false
```

**6.2 `node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json`**

无输出，`EXIT=0`。

**6.3 `node --test apps/arkui-schedule/tools/test/quickRecord.test.mjs apps/arkui-schedule/tools/test/quickRecordUi.test.mjs`**（尾部原文）

```
  ✔ 组件没有日期 UI，也不抢父页面「已记下」的成功反馈 (0.1493ms)
✔ QuickRecordBar.ets：一个输入框 + 一个保存键，成功才清空 (2.3383ms)
▶ Index.ets：快捷记录只接在列表区，不动页头
  ✔ Builder 渲染 QuickRecordBar 组件并传入 busy / onSubmit (0.5093ms)
  ✔ CompactBody 与 WideBody 各渲染一次，且都在主操作之上 (0.3728ms)
  ✔ submitQuickRecord 先算 plan、先挡 !plan.ok，再 appendRecord (0.2795ms)
  ✔ 记录字段与编辑器路径一致，作者走同步缓存 (0.266ms)
  ✔ appendRecord 出错有中文 toast；成功后刷新列表 + 汇总并提示已记下 (0.1426ms)
  ✔ 点击路径零异步，且不写编辑页的一次性保存标记 (0.1676ms)
  ✔ PageLayout 页头属性没有新增任何 headerAction (0.8888ms)
  ✔ indexHeader 守卫文件仍在且断言未被削弱 (0.4105ms)
✔ Index.ets：快捷记录只接在列表区，不动页头 (3.3809ms)
ℹ tests 30
ℹ suites 2
ℹ pass 30
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 114.2518
EXIT=0
```

**6.4 `node --test "packages/dsh-dots/test/*.test.mjs" "apps/arkui-schedule/tools/test/*.test.mjs"`**（尾部原文）

```
✔ P1-1 testConnection 失败 → reachable 变 false，且 getState 不再报错 (121.4593ms)
✔ P1-1 换仓库地址 → 旧探测结果作废（reachable 回到 null） (314.3916ms)
✔ P1-1 ahead/behind：无 upstream → null；getState 不 fetch，显式 fetch 后才看到远端提交 (5460.3185ms)
✔ P1-1 远端整体消失后 getState 仍只读本地成功；此时 push 才把 reachable 记成 false (2948.6217ms)
✔ P1-1 lsRemote 超时 → E_GIT（消息说明超时），网络命令有 ≤8s 上限 (434.9906ms)
✔ ① 旧目录含完整条目 → 新目录全部存在且字节一致，标记文件存在 (52.0165ms)
✔ ② 新目录已存在 → 不覆盖原内容，旧目录不动，写跳过标记 (21.2679ms)
✔ ③ 无旧目录 → no-op，且不创建标记 (6.7417ms)
✔ ④ 重复调用幂等：第二次不重复搬动、不覆盖用户后续修改 (9.7893ms)
✔ ⑤ 标记在但目标不全（上次中断）→ 从旧目录补齐并校验，旧数据不丢 (23.6857ms)
✔ ⑥ 无完成标记但有 pending 标记 + 目标已建且只搬了一半 → 补齐而不是永久 skip（评审 M1） (40.9656ms)
✔ ⑦ 补齐时目标已有同名条目 → 不覆盖用户数据，也不因旧目录残留而永久失败（评审 M3） (39.9729ms)
ℹ tests 2421
ℹ suites 312
ℹ pass 2420
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 26581.7524
EXIT=0
```

**6.5 `node apps/arkui-schedule/tools/validate-app.mjs`**（尾部原文）

```
🔍 校验 ArkUI-X 工程：C:\Users\GWL\Desktop\itwillclaude\dsh-sync-suite\apps\arkui-schedule
✅ 全部通过：8/8 条规则（JSON5/JSON 70 个、相对 import 361 条、main 静态 import 456 条、页面 7 个、rawfile/git 2 个文件）
EXIT=0
```

**判定**：新测试 **30/30**；全量 **2421 / 2420 pass / 0 fail / 1 skip**；`validate-app`
**8/8**；`tsc` **exit 0**；`overlay applied=false`——五项全部符合预期。

---

## 7. `unverified`（本机无 DevEco/SDK，`hdc list targets` 为空）

1. **真机 / ArkTS 编译**：`QuickRecordBar.ets` 的装饰器、`ActionButton` prop 传值、
   `@Builder QuickRecordRow()` 的实际编译与渲染均未编译验证；静态文本断言挡不住编译错误。
2. **键盘回车提交**：`TextInput.onSubmit` 未接线（P2-1）；真机上回车是否真的不触发、用户是否会
   因此卡住，未验。占位符目前误导用户以为可用。
3. **toast / 刷新观感**：`已记下` 是否出现且只出现一次、`reload()` + `loadSummary()` 后列表首帧
   是否即时更新、`quickBusy` 的「一闪而过」忙碌态是否可见，均为源码级结论，未在真机计时/观感验证。
4. **`settingsStore.cached()` 冷启动竞态**：静态链路已证明 `isReady() ⟹ cache 非空`，且 null 有
   回落；但真机冷启动各 `ensureReady` 的实际时序未测（风险已被兜底吸收）。
5. **步数的软键盘风险**：固定底行是否被软键盘顶出可视区（若被顶出，路径 1 需 +1 scroll），
   沿用 §5.2 既有 `unverified`，未真机排版验证。
6. **DST 偏移**：`tsForDate` 用「现在」的时区偏移套到所选日期（§4.4.3 的 P2-2，中国无 DST，
   影响面小），快捷记录同样继承，未测。

---

## 8. 评审边界

- 本评审**只读**；未修改任何被评审文件。
- 评审期间 `docs/MODULES.md` / `docs/ROADMAP.md` / `docs/UX-STEPS.md` 被并行编辑（Designer
  的交付登记），本文对步数与回滚登记的引用以**评审结束时**的工作树为准；代码 diff 全程未变。
- 未提交、未 push、未改 `.git`、未改 DSH profile。
