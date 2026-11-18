# REVIEW：A2 拆分（Settings 按 section 拆分）之后

> 范围：`apps/arkui-schedule` 的 A2 重构（`7fece07 refactor(app): A2 设置页按 section 拆分`）。
> 本文只写**实测**，命令与输出都可在本机复现；不写「大概」「应该」。
> 日期：2026-11-18。基线：`23f8b51`（拆分前）→ `7fece07`（拆分后）。

---

## 1. A2 拆分带来了什么

### 1.1 数字

| 文件 | 拆分前 | 拆分后 | 行数 |
| --- | --- | --- | --- |
| `pages/Settings.ets` | 3647 行 | 2835 行 | **−812（−22.3%）** |
| `components/settings/SyncSection.ets` | — | 524 行 | 新增 |
| `components/settings/RemoteSection.ets` | — | 371 行 | 新增 |
| `components/settings/AiSection.ets` | — | 311 行 | 新增 |
| `components/settings/AboutSection.ets` | — | 213 行 | 新增 |
| `components/settings/DataSection.ets` | — | 61 行 | 新增 |
| `components/settings/SettingsBits.ets`（五组共用的 FieldLabel/ErrorText/HintLine/FieldNote） | — | 68 行 | 新增 |

- 五个 section 合计 **1480 行**，加共用 bits **68 行** = 1548 行。
- 拆完总行数 2835 + 1548 = **4383 行**，比拆分前多 **736 行（+20%）**。多出来的是
  `@Component` 骨架、每组 10–30 行的 `@Prop` 声明、import 与文件头注释——
  这是「按组件拆分」的固定成本，不是代码变复杂。
- 关于「页面 3241 → 实测行数」：`3241` 与本仓提交对不上（拆分前最近一次是 `23f8b51` 的
  **3647** 行；更早 `2b9af8e` 是 3409 行、`5de3211` 是 3335 行）。本文一律用 **3647** 作基线。

### 1.2 拆分是不是「等价搬迁」

用符号集合对比拆分前单文件（`23f8b51:pages/Settings.ets`）与拆分后七个文件的**并集**：

| 符号 | 拆分前 | 拆分后 | 缺失 |
| --- | --- | --- | --- |
| `@Builder` | 23 | 23 | **0** |
| `@State` | 69 | 69 | **0** |
| 方法（`build` 之外的 `name(...) {`） | 26 | 26 | **0** |
| `this.xxx()` 调用 | 95 | 136 | **0**（新增 41 处是 section 侧回调） |
| `$r('…')` 资源引用 | 14 | 14 | **0** |
| 中文界面文案字面量 | 91 | 91 | **0** |

结构侧（本轮新写的结构断言实测）：
- 5 个 section 在页面里**各有且仅有 1 个装配点**（`SyncSection({…})` … `AboutSection({…})`）；
- `CompactBody()` 与 `WideBody()` **两套骨架都调用** `SyncGroup / AiGroup / RemoteGroup / DataGroup / AboutGroup`；
- 页面传给五个 section 的 props 与组件 `@Prop` 声明**双向 0 差**（少传 0、多传 0）；
- 27 个校验类字段（页面 `@State` 14：`Settings` 12 + `Index` 1 + `RemoteControl` 1；section `@Prop` 13：
  `SyncSection` 9 + `AiSection` 2 + `AboutSection` 1 + `RemoteSection` 1）**全部**在 `build()`/`@Builder` 里有值位置落点。

**结论：本轮 A2 拆分没有发现功能丢失或行为改变**（token 级 0 缺失 + 结构 0 断线）。
但这不等于「拆分是安全的」——下面两节说的是**测试为什么抓不住**，以及本轮真实抓到的隐患。

---

## 2. 被拆丢 / 被拆坏的是什么，为什么测试没抓住

### 2.1 拆分本身：0 丢失（证据见 §1.2）

`7fece07` 之前之后逐符号比对，没有出现「builder 少一个 / @State 少一个 / 文案少一句」。
所以「功能被拆丢」在本轮**不成立**，不能写进结论。

### 2.2 但测试有 3 个**结构性盲区**，拆分把它们的代价放大了

拆分之后，`tools/test/` 里的静态守卫统一改成「`readSettingsSources()` = 页面 + bits + 五个 section
拼起来的合并源码」再去 grep。这个做法让断言在拆分当天全绿，代价是判据退化了：

1. **「定义存在」顶替了「被使用」**。合并源码里 `Foo()` 只要出现过就算通过——哪怕它再也没被调用、
   哪怕它只在死代码里。拆分前单文件切片至少还能看「谁调谁」，拆分后连这个都没有了。
2. **「字段被读」没有判据**。守卫只查「`this.xxxError = issue.message` 有没有」和
   「`this.ErrorText(this.xxxError)` 这段文本有没有」，不查**这个字段在渲染树里到底有没有被当成值用掉**。
3. **`FIELD_TO_STATE` 是手写的**。现有 `settingsFormValidation.test.mjs` 的「幽灵报错守卫」靠一张
   人工维护的 `field → 内联状态` 表；新加一个 issue 字段时，只要不往表里加，它就自动免检。

### 2.3 变异实验：弱判据确实抓不住「读得到、画不出」

把 `SyncSection.ets` 里

```ets
if (this.deviceIdError.length > 0) {
  this.ErrorText(this.deviceIdError)   // ← 红字
}
```

改成

```ets
if (this.deviceIdError.length > 0) {
  Text('')                             // ← 条件还在、字段还在读、红字没了
}
```

- 只用「字段在 `build()` 里出现过」判据：**通过**（`this.deviceIdError.length` 就是一次引用）。
- 换成「字段必须出现在**值位置**（后接 `,` `)` `}` 或 `${…}`）」判据：**红**
  （见 `tools/test/structureGuards.test.mjs` 的 `helper 自测：可见落点要「作为值」出现`）。
  这也是本轮 `fieldsWithoutRenderSite` 从「出现过」收紧成「作为值出现过」的原因。

### 2.4 本轮真实抓到的隐患（不是拆分引入的）

`@State` 死状态扫描（23 个 `.ets` / 165 个 `@State`）抓到 **2 个只写不读的字段**：

| 字段 | 位置 | 判定 | 是否拆分引入 |
| --- | --- | --- | --- |
| `breakpoint` | `pages/Index.ets` | 只被 `PageLayout.onBreakpointChange` 写入，页面按 `contentWidth` 分支 | 否（A1 之前就在） |
| `contentWidth` | `pages/Settings.ets` | 只被 `onBreakpointChange` 写入，页面按 `breakpoint` 分支 | **否**——`23f8b51`（拆分前）同样只写不读 |

两个都进了白名单（`STATE_READ_ALLOWLIST`，逐条写理由：删字段要动 `PageLayout` 的对外回调契约，
属于另一件事）。**这两个不是 A2 拆出来的**，但正是「文本匹配抓不住」的典型：
它们在拆分前后都能过全部静态守卫，因为守卫只看「有没有赋值」。

### 2.5 一次事故记录（必须留痕）

本轮为了证明新门闸有效，做了变异测试（临时把源码改坏 → 跑测试 → 逐字节还原）。
其中一次变异把 `SyncSection.ets` 写成 `Text('')` 时，**并行提交 `55c9303` 把工作区里这份变异收进了历史**，
下一次提交 `3404f32 chore: 收尾并行改动` 又把它还原成 `this.ErrorText(this.deviceIdError)`。
现状：`HEAD` 上该行是正确的；`git show 55c9303:…/SyncSection.ets` 里能看到那个中间态。
教训：**并行会话在同一个工作区提交时，不要对已跟踪源码做变异测试**——要么改成纯文本单元测试
（本轮已经把「幽灵报错」「装配少传/多传」两条改成纯文本用例），要么在临时副本目录里做。

---

## 3. 后续防线

### 3.1 目录级预算 + 语义约束（替代「文件:行号锚点」）

**为什么不再用行号锚点。** 旧门闸的豁免长这样：

```js
{ file: 'harmony/ets/pages/Handwriting.ets', kind: 'hex', anchor: "DARK_FALLBACK.chipFill : '#F7F8FA'", count: 3 }
```

它把「这一行文本」当成契约。A1（手写页去重）与 A2（设置页拆 section）两次重构里**颜色一个都没变**，
只是代码搬家，四条断言同时红：豁免对不上、`main` 树里凭空多出 5 处 hex、`Color.White` 被数成 2 处。
位置是重构的产物，不是意图；把位置写进断言，等于每次重构都要先改测试才能知道代码有没有坏。

**现在只判两件事**（实现：`tools/test/helpers/colorGate.mjs`）：

1. **目录级预算**：只看目录内各类字面量的**总计数**，文件怎么拆、怎么挪、怎么改名都不影响；
2. **语义形态**：预算内的每一处还必须长在允许的上下文里，落在形态之外的新字面色直接失败。

| 目录 | hex | rgb/hsl | `Color(0x…)` | 拼接 | 命名色 | 实测（2026-11-18） |
| --- | --- | --- | --- | --- | --- | --- |
| `entry/src/main/ets`（共享 UI，`.ets`） | **0** | 0 | 0 | 0 | `Color.Transparent` ≤1 | 40 个文件：`{named:1}` |
| `entry/src/main/ets/model`（纯逻辑，`.ts`） | ≤16 | ≤4 | 0 | 0 | 0 | 39 个文件：`{hex:16, func:4}` |
| `entry/src/main/ets/common`（`.ts`） | 0 | 0 | 0 | 0 | 0 | 5 个文件：`{}` |
| `entry/src/harmony/ets`（鸿蒙覆盖层） | ≤5 | 0 | 0 | 0 | `White`≤1、`Transparent`≤3 | 6 个文件：`{hex:5, named:4}` |
| `tools/**`、`test/**`、`docs/**` | — | — | — | — | — | 不参与 |

预算常量就是**实测值**（`≤` 只放行「变少」的方向）：计数一涨就红，等于「新增字面色必须走
`$r('app.color.*')` / `CANVAS_PAINTS`，确需豁免就显式改预算并在注释里写理由」。
`entry/src/main/**` 是 0，`model/*.ts` 单独一档——那 16 处 hex / 4 处 `rgba` 是**画布绘制色、墨色、
兜底色**，属于持久化数据与 canvas 参数，本来就不跟主题、也不能换成 `$r()`。

语义形态（用「命中行 + 前后 8 行窗口」，**不看行号**）：

| 目录 | 允许的形态 |
| --- | --- |
| `main/ets`（UI） | 命名色只有 `Color.Transparent`，且必须在 `.backgroundColor(…)` / `.borderColor(…)` 的参数位 |
| `main/ets/model` | hex / `rgba` 必须是**常量对象字面量属性**、`const NAME: string = …`、**常量数组字面量**、或返回绘制串的 `return \`rgba(…)\`` |
| `harmony/ets` | hex 必须是 `isDarkTheme(…) ? 深色令牌 : '浅色'` 的**假分支**或常量声明，且值只能取被 `handwritingToolbar.test.mjs` 钉住的三个浅色档（`#F7F9FB` / `#F1F3F5` / `#F7F8FA`）；`Color.White` 只许 `.fontColor(Color.White)`（完成按钮反白字）；`Color.Transparent` 只许调用参数位或三元假分支 |

另加两条**元断言**（防止门闸自己空转）：预算表里每个目录必须扫到文件、任何文件不许同时落在两个桶里、
限额必须是非负整数；以及入口处 `requireOverlayRestored()`——构建期 overlay 生效时整棵 main 树是
harmony 的副本，此时源码扫描毫无意义，直接硬失败（本轮的 4 条假红就是残留 overlay 造成的）。

**变异验证（真实文件，已还原）**：

| 变异 | 结果 |
| --- | --- |
| `main/ets/pages/Index.ets` 里 `.backgroundColor(Color.Transparent)` → `.backgroundColor('#FFFFFF')` | 被抓到（4 条红：预算 + 形态 + main 树 + 命名色） |
| harmony 的 `const RAIL_BG: string = '#F7F9FB'` → `'#FFFFFF'` | 被抓到（2 条红：值集合 + 预算） |
| `Settings.ets` 新增 `@State ghostField` 且只写不读 | 被抓到（2 条红：死状态 + 覆盖范围） |

### 3.2 结构断言范式：文本匹配抓得住「出现」，抓不住「是否被用」

这是本轮最该沉淀的一条。静态 grep 能证明「代码里写着」，证明不了「运行时发生过」。
拆分把代码搬进组件后，「写着但没接上」成为最可能的坏法，而它恰好是 grep 的盲区。所以补两条
（实现：`tools/test/helpers/structureGuards.mjs`，测试：`tools/test/structureGuards.test.mjs`）：

1. **死状态检查**：扫 `pages/*.ets` 与 `components/**/*.ets` 里全部 `@State`，断言每个字段
   **至少被读一次**（`this.x = …` / `+=` / `++` 算写，其余算读；`==` 是读）。只写不读的字段要么删，
   要么进 `STATE_READ_ALLOWLIST` 并**逐条写理由**；白名单条目过期（字段被删了、或现在会被读了）也报错，
   防止白名单只增不减。当前：**23 个文件 / 165 个字段 / 2 条白名单 / 0 违约**。
2. **可见落点检查**：对校验类字段（`xxxIssue` / `xxxError` / `xxxWarning`）断言它**在渲染树里作为值出现过**
   （`build()` 或某个 `@Builder` 的区间内，且后接 `,` `)` `}` / `${…}`），而不只是声明、不只是参与
   `if (this.x.length > 0)`。当前：**27 个字段（页面 `@State` 14 + section `@Prop` 13）/ 0 违约**。
3. 附带 **装配对齐**（本轮新增）：页面每个 `Section({…})` 调用点的 key 与组件 `@Prop`/成员声明
   双向比对，少传（永远走默认值）和多传（拼错被静默忽略）都报错。当前：5 个装配点 / 0 违约。

这三条都不依赖文案、不依赖行号、不依赖文件名：把 section 再拆成两层、把 builder 改名、
把字段搬到另一个文件，只要「还被用」，断言就继续绿；一旦「存在但没被用」，立刻红。

---

## 4. 附：本轮验证命令与结果

```powershell
cd C:\Users\GWL\Desktop\itwillclaude\dsh-sync-suite\apps\arkui-schedule
node ..\..\node_modules\typescript\bin\tsc -p tools\tsconfig.json     # 退出码 0
node --test "tools/test/*.test.mjs"                                    # 见 §4.1
node tools\validate-app.mjs                                            # 见 §4.2
```

### 4.1 全量单测

```
ℹ tests 1508
ℹ suites 267
ℹ pass 1508
ℹ fail 0
```

新增/重写的两组：

- `tools/test/theme.test.mjs`：色值门闸从「文件:行号白名单」换成「目录预算 + 语义形态」，
  实测计数 `main-ui {named:1}` / `main-model {hex:16, func:4}` / `main-common {}` /
  `harmony {hex:5, named:4}`，预算违约 0、形态违约 0；
- `tools/test/structureGuards.test.mjs`（新增，11 例）：死状态 23 文件 / 165 字段 / 2 白名单 / 0 违约；
  可见落点 27 字段 / 0 违约；装配对齐 5 个点 / 0 违约；含纯文本自测与「白名单过期要报错」。

### 4.2 工程结构校验

```
🔍 校验 ArkUI-X 工程：…\apps\arkui-schedule
✅ 全部通过：8/8 条规则（JSON5/JSON 70 个、相对 import 281 条、main 静态 import 357 条、页面 7 个、rawfile/git 2 个文件）
```

（`build-harmony` 未跑：按约定由整合方统一跑。构建期 `overlay apply` 会让源码扫描类断言失真，
所以 `tools/test/guard.mjs` 在入口 `process.exit(1)` 硬失败；跑构建前后都要
`node tools/overlay.mjs restore`。本轮实测：构建期间 `validate-app` 报的「main 引用手写/OCR」
就是覆盖层残留造成的假红，`restore` 后 8/8 全过。）
