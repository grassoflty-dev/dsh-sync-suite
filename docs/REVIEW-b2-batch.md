# REVIEW b2-batch（2026-11-19，独立只读评审）

> 评审角色：独立只读评审子代理（非作者）。cwd = `C:\Users\GWL\Desktop\itwillclaude\dsh-sync-suite`（`main`，HEAD `22acdb8`）。
> 评审对象严格限定为派活清单的 5 个改动（4 modified + 1 untracked）；`docs/*` 由规划者单独改，本评审不改 docs 下其它文件。
> 本机无 DevEco/无 HarmonyOS SDK、`node_modules` 内也无 ArkUI d.ts；`hdc` 不在 PATH（详见 §4）。凡涉及 ArkTS 编译与真机行为的结论一律标 `unverified`，不写「已验证」。

---

## 0 结论

- **是否阻塞提交：否（无 P0）**
- **P0 0 条 / P1 1 条 / P2 4 条**
- **评审后状态**：P1-1 / P2-1 / P2-3 已修，P2-2 部分修（见 §6）。
- **一句话核心结论**：D4 快捷区间（周一首日、手改优先、无自造格式化）与 D6 紧凑屏锚点真跳转（`pageScroller.scrollTo`、未测量给 toast、宽屏未动）的实现语义均符合契约，回归全绿（2204/2203/0/1、`validate-app` 8/8）；唯一 P1 是新增静态测试的**测试缺口**——B2-19 钉住了 `scrollTo`/`yOffset: offset`/无 `scrollEdge`，却没钉住 `offset` 必须来自 `this.groupOffsets[index]`，把「硬编码偏移的假跳转」放得过去，实现当前是对的但契约靠人眼守着。四条 P2 均为边界/脆弱性/已知限制，不阻塞。

---

## 1 评审范围与命令（证据三段式：命令原文 / 原样输出 / 结论）

### 1.1 工作树范围核对

**命令原文**
```
git rev-parse --short HEAD; git status --short; git branch --show-current
```

**原样输出**
```
22acdb8
 M apps/arkui-schedule/entry/src/main/ets/components/ExportImportPanel.ets
 M apps/arkui-schedule/entry/src/main/ets/model/exportImport.ts
 M apps/arkui-schedule/entry/src/main/ets/pages/Settings.ets
 M apps/arkui-schedule/tools/test/exportImport.test.mjs
?? apps/arkui-schedule/tools/test/b2Batch.test.mjs
main
```

**结论**：与派活清单的 5 个文件逐字一致——不多不少，无多余改动进范围，无暂存（cached）内容。

### 1.2 改动规模与「删除行」性质

**命令原文**
```
git diff --numstat
git diff --stat
```

**原样输出**
```
47	1	apps/arkui-schedule/entry/src/main/ets/components/ExportImportPanel.ets
71	0	apps/arkui-schedule/entry/src/main/ets/model/exportImport.ts
111	6	apps/arkui-schedule/entry/src/main/ets/pages/Settings.ets
148	0	apps/arkui-schedule/tools/test/exportImport.test.mjs

 .../src/main/ets/components/ExportImportPanel.ets  |  48 ++++++-
 .../entry/src/main/ets/model/exportImport.ts       |  71 ++++++++++
 .../pages/Settings.ets                             | 117 +++++++++++++++-
 .../tools/test/exportImport.test.mjs               | 148 +++++++++++++++++++++
 4 files changed, 377 insertions(+), 7 deletions(-)
```

**结论**：
- `exportImport.test.mjs` = **148/0**，纯追加（见 §3）。
- `ExportImportPanel.ets` 的 1 行删除是 import type 行的等价扩写：
  ```
  -import type { DateRangeResult, ExportImportState, ExportRequest } from '../model/exportImport';
  +import type { DateRangeResult, ExportImportState, ExportRequest, QuickRangeOption } from '../model/exportImport';
  ```
  仅追加 `QuickRangeOption`，无删语义。
- `Settings.ets` 的 6 行删除 = `CompactBody` 里被 `Column(){…}.onAreaChange` 包裹替换的 5 行组调用 + 1 行旧注释 `/** 紧凑屏：五组自上而下。 */`，逐条对应，无夹带。

### 1.3 复跑测试尾部（集成证据核对，未照抄）

**命令原文**
```
node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
node --test "packages/dsh-dots/test/*.test.mjs" "apps/arkui-schedule/tools/test/*.test.mjs"
node apps/arkui-schedule/tools/validate-app.mjs
```

**原样输出（测试尾部）**
```
ℹ tests 2204
ℹ suites 298
ℹ pass 2203
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 26486.638
TEST_EXIT=0
```

**原样输出（validate-app）**
```
🔍 校验 ArkUI-X 工程：C:\Users\GWL\Desktop\itwillclaude\dsh-sync-suite\apps\arkui-schedule
✅ 全部通过：8/8 条规则（JSON5/JSON 70 个、相对 import 347 条、main 静态 import 436 条、页面 7 个、rawfile/git 2 个文件）
VALIDATE_EXIT=0
```

**原样输出（两个新测试点名跑）**
```
exportImport.test.mjs: ℹ tests 84 / ℹ pass 84 / ℹ fail 0 / ℹ skipped 0 / EXIT=0
b2Batch.test.mjs:      ℹ tests 13 / ℹ pass 13 / ℹ fail 0 / ℹ skipped 0 / EXIT=0
```

**结论**：tsc exit 0；基线 2179/2178/0/1 → 本批 2204/2203/0/1，增量 **+25 = D4 的 12 例 + B2 的 13 例**，fail 0、skip 未增；validate-app 8/8。唯一 skipped 是既有的代理环境变量用例，与本批无关。

### 1.4 关键纯函数实跑（周首/边界，独立复算）

**命令原文**（先 `tsc` 生成 `.build`，再用 `registerHooks` 给无扩展名相对 import 补 `.js`；stdin 喂入 ES module）
```
node --input-type=module   # 脚本内 import .build/model/exportImport.js，逐个调用 quickRange / isQuickRangeActive / parseDateRange
```

**原样输出（节选）**
```
Sunday 2026-11-08 getDay=0 => {"ok":true,"from":"2026-11-02","to":"2026-11-08","reason":""}
Monday 2026-11-02 getDay=1 => {"ok":true,"from":"2026-11-02","to":"2026-11-02","reason":""}
Tuesday 2026-11-03 getDay=2 => {"ok":true,"from":"2026-11-02","to":"2026-11-03","reason":""}
cross-month Thursday 2026-01-01 getDay=4 => {"ok":true,"from":"2025-12-29","to":"2026-01-01","reason":""}
cross-year Sunday 2027-01-03 getDay=0 => {"ok":true,"from":"2026-12-28","to":"2027-01-03","reason":""}
--- today/last7 on Tue 2026-11-03 ---
today => {"ok":true,"from":"2026-11-03","to":"2026-11-03","reason":""}
last7 => {"ok":true,"from":"2026-10-28","to":"2026-11-03","reason":""}
--- boundaries ---
unknown month => {"ok":false,"from":"","to":"","reason":"未知的快捷区间：month"}
empty kind => {"ok":false,"from":"","to":"","reason":"未知的快捷区间："}
Invalid Date => {"ok":false,"from":"","to":"","reason":"当前时间无效，无法计算快捷区间"}
null now => {"ok":false,"from":"","to":"","reason":"当前时间无效，无法计算快捷区间"}
--- parseDateRange accepts outputs ---
today parse ok=true same=true
week parse ok=true same=true
last7 parse ok=true same=true
--- isQuickRangeActive whitespace /手改 ---
week trim spaces => true
today on week-value => false
empty from/to => false
```

**结论**：见 §2 的 A / C。

---

## 2 逐项结论（A–J）

### A. 周首约定（周一首日，非周日首日）——**通过，无问题**

**证据**
- `model/calendar.ts:67-68`：`/** 每周首日：0=周日，1=周一（默认，中文习惯）。 */` / `export type WeekStart = 0 | 1;`
- `model/exportImport.ts:1242-1248`：
  ```ts
  const weekday: number = now.getDay();
  const backDays: number = (weekday + 6) % 7;
  const monday: Date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - backDays);
  return parseDateRange(localDateKey(monday), today);
  ```
- 手工复算 + 实跑（§1.4）：周日 `getDay=0` → `(0+6)%7=6` → 回退 6 天到 **11-02 周一**；周一 `getDay=1` → 0 天；周二 `getDay=2` → 1 天到 11-02；跨月 2026-01-01（周四，`getDay=4`）→ 回退 3 天到 **2025-12-29 周一**；跨年 2027-01-03（周日）→ 回退 6 天到 **2026-12-28 周一**。五种情形全部与 `WeekStart=1` 一致。

**分级**：无问题（P0/P1/P2 = 0）。未自创周日首日。

### B. D4 语义（手改优先 / chip 无静默禁用 / 无新 @State / 面板无 `new Date(`）——**通过，无问题（午夜边界见 P2-4）**

**证据**
- `components/ExportImportPanel.ets:289-302`：
  ```ts
  private applyQuickRange(kind: string): void {
    const range: DateRangeResult = quickRange(kind);
    if (!range.ok) { return; }
    this.fromText = range.from;
    this.toText = range.to;
  }
  private isQuickActive(kind: string): boolean {
    return isQuickRangeActive(kind, this.fromText, this.toText);
  }
  ```
  chip 高亮**现算**（`isQuickActive` 只做等值比对，不存选择），点 chip 只写 `fromText/toText`；手改文本后自动失配（§1.4 `today on week-value => false`）。
- `@State` 全文件仅 5 处（`:112-116`：`fromText/toText/format/includeAttachments/includeMeta`），本批未新增；`isQuickActive` 的临时变量都是局部量。
- 面板中 `new Date(` 只出现在注释（`:22`、`:282`），可执行代码 0 处；`b2Batch` B2-16 用 `stripComments` 剥离后断言为 false，实测通过。
- chip 用 `ActionButton({ enabled: true, disabledReason: '', busy: false, block: false, … })`（`ExportImportPanel.ets:427-441`）；`components/ActionButton.ets:101-117` 的 `handleClick()` 在 `busy!==true && tappable===true` 时直接 `this.onTap()`，故忙碌中仍可改区间、无静默禁用。

**分级**：无问题；午夜跨天导致高亮自动失配列 **P2-4**（属「现算」设计的固有结果，非实现缺陷）。

### C. D4 边界（fail-closed / 不抛异常 / 格式可被既有 parseDateRange 接受）——**通过，无问题**

**证据**
- `model/exportImport.ts:1233-1254`：非法 `now`（`null`/`undefined`/无 `getTime`/NaN）先 `dateRangeFailure('当前时间无效，无法计算快捷区间')`；未知 kind 走 `dateRangeFailure(\`未知的快捷区间：${clip(kind)}\`)`；三分支都 `return parseDateRange(...)`。
- `dateRangeFailure`（`:198-201`）返回 `{ ok:false, from:'', to:'', reason }`；`parseDateRange`（`:238-262`）本身 trim 首尾空白、拒非法日期、拒 `from>to`，全部返回中文 reason 不抛异常。
- §1.4 实跑：未知 kind、空串 kind、Invalid Date、`null now` 均 `ok:false` + 两端空串 + 中文 reason，无异常；三个 kind 的输出经 `parseDateRange` 的 `ok=true` 且 `from/to` 未改写（与测试 D4-8 一致）。首尾空白由 `parseDateRange` trim 后比对，`isQuickRangeActive('week',' 2026-11-02 ',' 2026-11-03 ')` = `true`。

**分级**：无问题。

### D. D6 真跳转（必须 `pageScroller.scrollTo`，未测量给原因，不许 `scrollEdge` 冒充）——**实现通过；测试缺口 P1-1**

**证据**
- `pages/Settings.ets:2160-2171`：
  ```ts
  private jumpToGroup(index: number): void {
    if (index < 0 || index >= this.groupOffsets.length) { return; }
    const offset: number = this.groupOffsets[index];
    if (offset < 0) {
      promptAction.showToast({ message: ANCHOR_NOT_READY });
      return;
    }
    this.pageScroller.scrollTo({ xOffset: 0, yOffset: offset, animation: { duration: 250 } });
  }
  ```
  `yOffset` 来自测量缓存 `this.groupOffsets[index]`，非硬编码/比例；未测量（`-1`）时 toast 常量 `ANCHOR_NOT_READY`（`:229` = `'页面还在排版，稍后再点一次'`），非静默。
- 全文件 `scrollEdge` 仅 1 处 `Settings.ets:784`（既有的校验失败回顶 `this.pageScroller.scrollEdge(Edge.Top)`，不在本批 diff、`jumpToGroup` 内没有），未被拿来冒充组跳转。
- `b2Batch.test.mjs:193-201`（B2-19）确实断言了 `pageScroller.scrollTo(`、`yOffset: offset`、`animation: { duration: 250 }`、`offset < 0`、toast、且 `JUMP.includes('scrollEdge') === false`。

**缺口**：B2-19 没有断言 `const offset: number = this.groupOffsets[index];` 这一行。把该行改成 `const offset = 250;`（或任何比例值）后所有测试仍绿，而跳转落到错误位置——正是静态测试宣称要挡的「假跳转」回归。实现当前正确，但契约靠人眼守。详见 §5 P1-1。

**分级**：实现 **P0/P1/P2 = 0**；测试缺口 **P1**。

### E. D6 偏移正确性（重点挑刺）——**部分通过；1 条 P2 + 多项 unverified**

**证据与逐条核对**
- **父组件确认**：五个 wrapper 是 `CompactBody` 中 `Scroll(this.pageScroller)` 内 `Column({ space: SPACING.xl })`（`:2586`）的**直接子节点**（Sync `:2589` / AI `:2596` / Remote `:2603` / Data `:2610` / About `:2621`），父组件确为滚动内容 Column。`Area.position.y` 按 ArkUI 声明是相对父组件的位置，故作为内容偏移的语义成立（但见下方 unverified）。`onAreaChange((_oldValue: Area, newValue: Area) => { this.measureGroup(i, newValue); })` 逐组挂在外层 wrapper 上，共 5 次。
- **IssuesBanner 位置变化**：`this.IssuesBanner()` 位于 `:2588`，在五个 wrapper 之前。其出现/消失会让内容 Column 重新布局 → wrapper 位置变化 → 理论上再次触发 `onAreaChange`；代码注释（`:2147`）也如此声明。**触发实际发生与否属真机行为，unverified**（§4）。
- **`y <= 0` 守卫（`:2154`）**：`const y = this.lengthToVp(area.position.y); if (y <= 0 || this.groupOffsets[index] === y) { return; }` —— 若某组正好是内容第一个元素（`y=0`），合法 0 偏移会被挡掉，缓存保持 `-1`，点击只 toast 不跳。当前布局下 anchor bar（`:2587`，`TOUCH_MIN=40`）+ IssuesBanner 恒在前，五个组的 `y` 均 `>0`，故**当前不可达**；属潜在健壮性问题 → **P2-1**。
- **滚动时坐标是否漂移**：`onAreaChange` 按声明在布局变化时触发；若某 ArkUI 版本在滚动时以视口坐标重报 `Area.position` 并触发回调，`measureGroup` 会把视口 y 写进缓存，跳转偏移变错。源码无法证实，`unverified`（§4）。
- `lengthToVp`（`:2133-2143`）把非 number/string 及负数/NaN 一律归 0，再由 `y<=0` 丢弃；与 `PageLayout.ets:59` 的 `toVp(value: Length)` 同口径，风格一致。

**分级**：**P2**（`y<=0` 潜在守卫，当前不可达）+ 真机相关项 `unverified`。

### F. D6 范围纪律（宽屏未动 / 锚点在内容流 / 字段语义未改 / 无新 @State）——**通过，无问题**

**证据**
- `git diff` 无 `WideBody()` 任何 hunk；`b2Batch` B2-23 反向断言 `WideBody` 不含 `GroupAnchorBar` / `measureGroup` / `onAreaChange`，且五组调用仍在，实测通过。
- `Settings.ets:2585-2588`：`GroupAnchorBar()` 是 `Scroll` 内容 Column 的**第一个子节点**，随内容滚走、非悬浮、不覆盖首屏表单（视觉不遮挡需真机确认，见 §4）。
- 本批新增仅 `ANCHOR_NOT_READY` 常量、`groupOffsets` 普通私有字段、三个方法、两个 `@Builder`、五个 wrapper；未触碰任何字段、校验或 `SaveButton()` 保存逻辑（B2-24 断言两套骨架均以 `this.SaveButton()` 收尾）。
- `groupOffsets` 明示 `private`（`:436-441`）且注释说明刻意不作 `@State`；全文件未新增 `@State`。

**分级**：无问题。

### G. STATE-UI 一致性（原生 Button 取舍是否成立）——**取舍成立，无问题**

**证据**
- 尺寸基线（`common/uiTokens.ts`）：`SPACING.sm=8`、`.lg=16`（`:84`），`FONT.caption=14`（`:95`），`TOUCH_MIN=40`（`:116`）。
- 360vp 算术：`Row({ space: 8 })` 4 个间隙 = 32vp，5 个 chip 各 `(360-32)/5 = 65.6vp`。原生 `Button(label)` + `.padding({left:0,right:0})` + `.layoutWeight(1)`（`Settings.ets:2243-2257`）仅文本：2 字中文 @14vp ≈ 28vp，×1.5 大字号 ≈ 42vp，**均 < 65.6vp**，不溢出/不裁字。
- 反证：若用 `ActionButton`，其 `.padding({ left: SPACING.lg, right: SPACING.lg })`（`ActionButton.ets:131,146`）固定吃掉 32vp，每 chip 仅剩 33.6vp；×1.5 大字号（≈42vp）会裁字。作者取舍成立，**无需改回 ActionButton**。
- 锚点无 `.enabled(false)`（B2-21/B2-25 断言通过）；未测量分支给中文 toast（`Settings.ets:2166-2168`），符合「禁用可见、点击给原因」。

**分级**：无问题。

### H. 测试质量（只追加 / 能否挡回归 / 有无空断言 / 有无放宽）——**仅追加，挡住多数回归；P1-1 + P2-2/P2-3**

**证据**
- `git diff --numstat` = `148 0`，hunk 仅 `@@ -1271,3 +1271,151 @@`（文件末尾），无改/删既有断言；`b2Batch.test.mjs` 全新增 275 行、13 例。
- 逐条审查 B2-13…B2-25：B2-14 钉 `ForEach(QUICK_RANGE_OPTIONS)`+`ActionButton`+`option.kind` key+`enabled: true` 恒成立、并反向禁 `enabled: !this.state.busy`；B2-19 钉 `scrollTo`/`yOffset: offset`/toast/无 `scrollEdge`；B2-22 钉 `CompactBody` 顺序与 `measureGroup(0..4)` 各一次；B2-23 钉宽屏零污染；B2-24 钉两套骨架 `SaveButton` 收尾。**未发现「永远为真」的空断言**（`assertOrdered`、`bodyFrom`、`stripComments` 均有失败路径；`assert.ok(index>=0)` 先兜底）。
- 缺口/脆弱性：
  - **P1-1**：B2-19 未钉 `offset` 来自 `groupOffsets[index]`（见 §2-D）。
  - **P2-2**：`b2Batch.test.mjs:196` 把 `duration: 250` 写死、`:179`/`:271` 把 toast 文案逐字写死、B2-16 把 `@State` 行数 `==5` 写死——这些不是契约语义（动画时长/提示措辞/未来合法新增状态），改个格式就红；且 `:126-130` 的 `enabled` token 用 `/enabled:\s*true/` 前缀匹配，`enabled: true && …` 会误过。
  - **P2-3**：B2-13（`:116-120`）只钉 `applyQuickRange`/`isQuickActive` 方法存在，未钉其方法体调用 `quickRange(` / `isQuickRangeActive(`；若改成面板内自造格式化（且不含 `new Date(`），D4 测试仍绿。

**分级**：**P1**（缺口）+ **P2**（脆弱性两条）。无删/放宽既有断言。

### I. ArkTS 编译风险（本机无 SDK/DevEco，`**/*arkui*.d.ts` = 无）——**全部 unverified，不计入 P0/P1**

**证据 / 判断**
| 风险点 | 位置 | 依据与判断 | 结论 |
| --- | --- | --- | --- |
| `Area.position.y` 类型 `Length \| undefined` | `Settings.ets:2134,2153` | `Length` 是 ArkUI 全局类型，仓内 `PageLayout.ets:59` 已有 `private toVp(value: Length)` 配 `Area.width/height` 的既成用法；把 `Length` 传给 `Length \| undefined` 是安全扩宽，`typeof` 收窄合法 | 大概率合法，**unverified** |
| `Scroller.scrollTo({ animation: { duration } })` | `Settings.ets:2170`（全 ets 树唯一 `scrollTo`） | SDK 声明 `compatibleSdkVersion 26.0.0`（`build-profile*.json5:15`），新版应支持动画对象；但本机无 d.ts 无法核对 `ScrollToOptions.animation` 形态 | **unverified** |
| 多参数 `@Builder GroupAnchorChip(label, index)` | `Settings.ets:2244`、调用 `:2269-2273` | ArkUI 支持带参 @Builder，`this.GroupAnchorChip('同步',0)` 形态符合声明 | 大概率合法，**unverified** |
| `Button(label)` + `.layoutWeight(1)` | `Settings.ets:2245,2252` | `layoutWeight` 是 Row 内通用属性，Button 可用 | 大概率合法，**unverified** |
| `ForEach` key 生成 `(option) => option.kind` | `ExportImportPanel.ets:430-440` | ForEach 第三参数 keyGenerator 是标准形态，仓内大量同类用法 | 大概率合法，**unverified** |

补充说明：`build-profile.json5` 目标 SDK 26，上述 API 形态在官方文档中大概率成立；但**本机没有 SDK/DevEco、`node_modules` 里也没有 ArkUI d.ts**，无法在此给出「已验证」的编译结论。提交前必须在 DevEco 真编译一次（§5）。

**分级**：`unverified`（不据此判 P0/P1）。

### J. 不该有的东西（无关改动 / 调试残留 / 秘密 / .ps1 / docs）——**通过，无问题**

**证据**
- `git status --short` 无 `.ps1`；`git diff --name-only` 无 `docs/`。
- `git diff` 与新增文件扫描 `console.` / `debugger` / `TODO` / `FIXME` / `C:\Users` / `token` / `secret` / `password` / `Bearer`：**0 命中**（新增文件里的 `token` 仅是测试局部变量名 `tokens`，非秘密）。
- 唯一 `scrollEdge` 在 `:784`（既有功能），不在 diff。
- 未发现任何新增依赖、`package.json` / lock 文件改动。

**分级**：无问题。

---

## 3 测试是否被放宽（git diff 证据）

**命令原文**
```
git --no-pager diff --numstat -- apps/arkui-schedule/tools/test/exportImport.test.mjs
git --no-pager diff -- apps/arkui-schedule/tools/test/exportImport.test.mjs   # 唯一 hunk: @@ -1271,3 +1271,151 @@
```

**结论**
- `exportImport.test.mjs`：**148 行新增 / 0 行删除**，唯一 hunk 在文件末尾（`@@ -1271,3 +1271,151 @@`），只在原文件末尾追加 `describe('导出区间快捷 chip（D4）…')` 共 12 个 test；既有断言**一字未动**。
- `b2Batch.test.mjs`：全新文件 275 行、13 例，均为正向契约断言 + 反向 `doesNotMatch`/`assert.equal(...,false)`，无「永远为真」空断言。
- 既有断言未被删除或放宽；本批是靠**新增**测试扩大覆盖面（2179 → 2204，+25）。

---

## 4 真机 / 环境 `unverified` 清单（逐条：什么没验 / 为什么 / 影响哪个结论）

1. **ArkTS 编译**：本机无 DevEco/SDK，`node_modules` 无 ArkUI d.ts → §2-I 的五个 API 形态、整批代码能否通过 `build-harmony.ps1` 均 `unverified`；影响 §2-I 与「提交前可编译」这一隐含门槛。
2. **`hdc` 设备**：本机 `hdc list targets` 返回 `CommandNotFoundException`（`hdc` 不在 PATH）；派活说明给出 `[Empty]`。两种情形都说明**无可用真机**。以下全部 `unverified`：
   - **D6 锚点实际落点/手感**：`scrollTo` + 250ms 动画是否把目标组带到舒适位置（是否需预留顶部间距）——影响 §2-D 的「真跳转」用户感知。
   - **`Area.position.y` 语义**：滚动时 `onAreaChange` 是否触发、`position` 是否保持内容相对坐标（若变视口坐标则跳转偏移错）——影响 §2-E。
   - **IssuesBanner 出现/消失后的重测量**：是否如注释（`:2147`）所写再次触发 `onAreaChange` 并刷新缓存——影响 §2-E。
   - **360vp / ×1.5 大字号下 5 个锚点 chip**：是否真不溢出/不裁字——影响 §2-G（静态算术已证，UI 渲染未验）。
   - **锚点行不遮首屏表单**：静态上它在内容流内、非悬浮，但首屏表单是否仍完整可见需真机看——影响 §2-F。
   - **D4 chip 在真实 UI 的高亮/点击**：纯函数已在 Node 实跑（§1.4），ArkUI 状态绑定与刷新未验——影响 §2-B。
3. **DST 时区**：`localDateKey` 用本地时区，午夜 DST 跳变时 `new Date(y,m,d)` 的构造可能有边界效应；本机 Asia/Shanghai 无 DST，未验——影响 §2-A/C（低风险）。

> 以上任何一条都**不得**写成「已验证」；本评审中凡涉及它们的表述均为 `unverified`。

---

## 5 建议（具体到文件:行号与改法）

**P1-1（应改，唯一 P1）——补钉 yOffset 来源**
- 位置：`apps/arkui-schedule/tools/test/b2Batch.test.mjs:193-201`（B2-19）。
- 改法：在现有断言后加一条
  ```js
  assert.match(JUMP, /const offset:\s*number\s*=\s*this\.groupOffsets\[index\]/,
    '契约丢了：yOffset 必须来自测量缓存 this.groupOffsets[index]，不得硬编码/比例');
  ```
  这样把「硬编码偏移的假跳转」也挡住。实现（`Settings.ets:2165`）当前已符合，无需改源码。

**P2-1（可选）——放开合法 0 偏移**
- 位置：`apps/arkui-schedule/entry/src/main/ets/pages/Settings.ets:2154`。
- 改法：把 `if (y <= 0 || this.groupOffsets[index] === y) { return; }` 改为 `if (this.groupOffsets[index] === y) { return; }`（未测量态仍由 `-1` 哨兵区分，`jumpToGroup` 的 `offset < 0` 不变）。当前布局不可达，可**接受为已知限制**。

**P2-2（可选）——降低测试脆弱性**
- 位置：`b2Batch.test.mjs:179,196,271` 与 `:126-130`、B2-16（`:153-158`）。
- 改法：`duration: 250` → `/duration:\s*\d+/`；toast 文案逐字 → `/showToast\(\{[^}]*message:/`；`@State == 5` → 仅断言「无 `quickRange` 相关新增状态」；`enabled` token 用 `/^enabled:\s*true\s*$/` 锚定整 token，避免 `true && …` 误过。

**P2-3（可选）——钉住面板复用纯函数**
- 位置：`b2Batch.test.mjs:116-120`（B2-13）。
- 改法：用 `bodyFrom(PANEL, 'private applyQuickRange(')` / `bodyFrom(PANEL, 'private isQuickActive(')` 取方法体，断言前者含 `quickRange(`、后者含 `isQuickRangeActive(`，防止面板自造格式化回归。

**P2-4（接受为已知限制）**：午夜跨天时 `isQuickActive` 现算会使「今天」chip 自动失高亮（用户未手改）——这是「现算、不存状态」契约的必然结果，建议不改；若真要避免，需在点击时冻结 `now`，但那会违背「高亮现算」语义，得不偿失。

**提交前必做**：在 DevEco 上跑一次 `powershell -File apps/arkui-schedule/tools/build-harmony.ps1`（§2-I 全部 `unverified` 的出口）；真机到位后按 §4 第 2 条逐项看一遍锚点跳转与 chip 布局。

**文档一致性（仅记录，未修改；本批 docs 由规划者单独处理）**
- `docs/UX-STEPS.md:9,13` 头部仍写 HEAD `379fcc5`（当前 `22acdb8`）。
- `docs/UX-STEPS.md:141,169,194,270` 的 §2 行号仍是 A2 拆分前，如 `Settings.ets:2403`（当前 `CompactBody` 在 `Settings.ets:2583`）。
- `docs/UX-STEPS.md:142,143` 写 `ExportImportPanel.ets:184` / `:202`，当前实际是 `FromInput()` `:348` / `ToInput()` `:366`。
- 派活说明中「`overlay.mjs` 已在 `379fcc5` 移除」的示例不成立：复核 `Test-Path apps/arkui-schedule/tools/overlay.mjs` = `True`，且 `node apps/arkui-schedule/tools/overlay.mjs status` 可跑（输出 `[overlay] applied=false`）。后人请勿照抄该示例。
- **评审期间的并发改动（已报，不在本评审范围）**：评审开始时 `git status` 只有派活清单的 5 个文件；收尾时 `docs/UX-STEPS.md` 变为 ` M`，`git diff --numstat -- docs/UX-STEPS.md` = `57 0`（新增 §4.2「本轮落地（B2 批…）」）。该改动由**规划者并行写入**，非本评审所为、也非源码改动顺带产生；本评审未碰它。评审范围仍以 §1.1 的 5 个文件为准。

---

（本报告为独立只读评审原文；未改任何源码/测试、未 commit/push、未碰 .git/profile/.ps1、未加依赖。唯一写入文件为本文件。）

---

## 6 复审（评审后补钉，只读复核）

> 复核角色：独立第三人（非作者、非 §1–§5 的首轮评审者）。cwd = `C:\Users\GWL\Desktop\itwillclaude\dsh-sync-suite`（`main`，HEAD `22acdb8`）。
> 复核范围**严格限定**为 §5 建议落地后的补钉：P1-1（B2-19 offset 来源）、P2-1（Settings `lengthToVp` / `measureGroup`）、P2-3（B2-13 复用纯函数）、P2-2 的 `enabled` token 锚定一项；其余 P2-2 项与 P2-4 按规划者决定保持原样。
> 纪律：只读源码/测试，不改任何源码/测试、不 commit；「改坏→跑红→还原」全部在系统临时目录留备份，最终以 SHA256 + `git diff` 自证还原。**§1–§5 原文一字未动**，本轮唯一写入文件为本文件。
> 真机仍不可用：凡真机/编译结论一律 `unverified`，本复审不新增任何「已验证」表述。

### 6.1 复核范围、命令与原样输出（命令原文 / 原样输出 / 结论）

**命令原文（基线与终态复跑，未照抄）**
```
git rev-parse HEAD; git branch --show-current; git status --short
node --test apps/arkui-schedule/tools/test/b2Batch.test.mjs
node --test "packages/dsh-dots/test/*.test.mjs" "apps/arkui-schedule/tools/test/*.test.mjs"
node apps/arkui-schedule/tools/validate-app.mjs
node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
```

**原样输出（b2Batch 基线，节选尾部）**
```
✔ B2-25 交互一致性（STATE-UI）：锚点无 .enabled(，未测量分支给中文 toast，不是静默吞点击 (0.0964ms)
✔ B2 设置页 Settings.ets（紧凑屏）：组锚点真跳转的源码级契约 (2.5318ms)
ℹ tests 13
ℹ suites 2
ℹ pass 13
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 98.0945
EXIT=0
```

**原样输出（改坏实验前的基线快照，SHA256）**
```
487C3C01E4FD4996BD56AB1914FCDC68626A59F36EAB682AA13C21C470A17A4F  apps/arkui-schedule/entry/src/main/ets/pages/Settings.ets
CC4B3BE2FDA64036ECEE5335BEB549DB3D60166AA72903D1F2C388CD571D8E7F  apps/arkui-schedule/entry/src/main/ets/components/ExportImportPanel.ets
5474BAD4A810B365679A9A4EFF662174B1A774B32FDF57883B9EDF759C24E611  apps/arkui-schedule/entry/src/main/ets/model/exportImport.ts
DF0A0D319DCB2196A1F4D4E1FC3F7CBF1127B7556B9DEC170B55B5F5F40F2D2F  apps/arkui-schedule/tools/test/exportImport.test.mjs
E8E4F4EBA4E05CDD1648FA0DBD17F4BF9637C31887A9F2551EA31F9AB481CC3E  apps/arkui-schedule/tools/test/b2Batch.test.mjs
TMP=C:\Users\GWL\AppData\Local\Temp\review-b2-recheck-20261119
```

**结论**：基线 13/13 全绿，五个源码/测试文件与工作树 diff 已做字节级快照；后续所有「改坏」均在该副本/备份保护下进行，可逐条比对还原。

### 6.2 补钉 1：`Settings.ets` 的 `-1` 哨兵方案 —— **取舍成立，采纳；无阻断性副作用**

**代码证据（行号为当前工作树）**
- `apps/arkui-schedule/entry/src/main/ets/pages/Settings.ets:2135-2136`：
  ```ts
  * 无法换算时返回 **-1**（而不是 0）：0 是合法的内容偏移（例如某组正好是内容第一个元素），
  * 用 0 当「未测量」哨兵会把「测不到」误当成「在顶部」，跳转会落错位置。
  ```
- `Settings.ets:2138-2147`（`lengthToVp` 三分支统一返回 `-1`）：
  ```ts
  private lengthToVp(value: Length | undefined): number {
    if (typeof value === 'number') {
      return Number.isFinite(value) && value >= 0 ? value : -1;
    }
    if (typeof value === 'string') {
      const parsed: number = Number(value);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : -1;
    }
    return -1;
  }
  ```
- `Settings.ets:2157-2160`（守卫改为 `y < 0`）：
  ```ts
  const y: number = this.lengthToVp(area.position.y);
  if (y < 0 || this.groupOffsets[index] === y) {
    return;
  }
  ```
- `Settings.ets:441`：`private groupOffsets: number[] = [-1, -1, -1, -1, -1];`
- `Settings.ets:2169-2174`（消费端 `offset < 0` toast 分支未变，正好与新哨兵对齐）：
  ```ts
  const offset: number = this.groupOffsets[index];
  if (offset < 0) {
    promptAction.showToast({ message: ANCHOR_NOT_READY });
    return;
  }
  this.pageScroller.scrollTo({ xOffset: 0, yOffset: offset, animation: { duration: 250 } });
  ```

**逐条副作用核对**
1. **初始 `-1` 哨兵**：未测量时 `offset = -1` → `offset < 0` 命中 → toast `ANCHOR_NOT_READY`（`Settings.ets:230` = `'页面还在排版，稍后再点一次'`），不静默、不假跳。**成立**。
2. **`jumpToGroup` 的 `offset < 0` 分支**：与新哨兵语义一致；`-1` 现在既表示「初始未测」也表示「换算失败」，两条路径统一给原因。**成立**。
3. **合法 0 偏移**：`lengthToVp(0) = 0`（`0 >= 0` 且有限）→ `y < 0` 为 false、`-1 !== 0` → 写入 `0` → `jumpToGroup` 的 `offset < 0` 为 false → `scrollTo(yOffset: 0)`、无 toast。这正是 P2-1 要放开的正当场景。**成立**。
4. **`Area.position.y` 三种输入**：
   - `undefined`（以及 `null`、Resource/`$r(...)` 等对象）：`typeof` 既非 `number` 也非 `string` → `-1` → 忽略 → toast。**成立**。
   - 数字 `NaN` / `Infinity` / 负数 / 数字字符串 `'-5'`、`'50%'`：分别由 `Number.isFinite` / `>= 0` 挡下 → `-1` → toast。**成立**。
   - **空串 `''`（及纯空白串）**：`Number('') = 0`、有限且 `>= 0` → 返回 `0` → 被 `y < 0` 放行 → 写入 `0` → `scrollTo(0)` 且无 toast。这是**唯一**一条原 `y <= 0` 守卫能挡、新 `y < 0` 守卫挡不住的输入，属于新引入的小幅行为差异；列入 §6.5 残余风险 R1（可达性 `unverified`）。
5. **规划者理由真假（关键）**：§5 原建议是「只删 `y <= 0` 守卫」，当时 `lengthToVp` 仍把「测不到」映射为 `0`。纯函数级仿真（临时脚本，已置于系统临时目录，不在工作树）结果：

   ```
   input              old+guard<=0                   old+guardDELETED               new -1 guard<0
   undefined          toast(ANCHOR_NOT_READY)        scrollTo(yOffset=0)            toast(ANCHOR_NOT_READY)
   empty string ''    toast(ANCHOR_NOT_READY)        scrollTo(yOffset=0)            scrollTo(yOffset=0)
   Resource object    toast(ANCHOR_NOT_READY)        scrollTo(yOffset=0)            toast(ANCHOR_NOT_READY)
   NaN                toast(ANCHOR_NOT_READY)        scrollTo(yOffset=0)            toast(ANCHOR_NOT_READY)
   negative -5        toast(ANCHOR_NOT_READY)        scrollTo(yOffset=0)            toast(ANCHOR_NOT_READY)
   legit 0            toast(ANCHOR_NOT_READY)        scrollTo(yOffset=0)            scrollTo(yOffset=0)
   legit 120          scrollTo(yOffset=120)          scrollTo(yOffset=120)          scrollTo(yOffset=120)
   ```

   「old+guardDELETED」列证明：只删守卫会把 `undefined`/Resource/`NaN`/负数全部写成 `0`，进而 `scrollTo(yOffset=0)` **静默假跳到顶部、不给 toast**。规划者的理由**为真**；改用 `-1` 哨兵且保留 `< 0` 守卫是必要且更保守的正确取舍，优于直接删守卫。

**结论**：P2-1 补钉成立并消解了原 P2（合法 0 偏移被挡）；未引入阻断性副作用，仅有 R1 一条低severity残余风险。

### 6.3 补钉 2：`b2Batch.test.mjs` 断言能挡回归 —— **四条断言全部实证有效**

**断言定位与原文片段**
- **P1-1** `apps/arkui-schedule/tools/test/b2Batch.test.mjs:209-214`：
  ```js
  assert.match(JUMP, /const offset:\s*number\s*=\s*this\.groupOffsets\[index\];/, '契约丢了：yOffset 必须来自测量缓存…');
  assert.equal(/yOffset:\s*\d/.test(JUMP), false, '契约丢了：不得把 offset 硬编码成数字字面量');
  ```
- **P2-3** `b2Batch.test.mjs:122-129`：
  ```js
  const APPLY = bodyFrom(PANEL, 'private applyQuickRange(');
  assert.match(APPLY, /quickRange\(kind\)/, '…必须调 model 的 quickRange(kind)…');
  const ACTIVE = bodyFrom(PANEL, 'private isQuickActive(');
  assert.match(ACTIVE, /isQuickRangeActive\(kind,\s*this\.fromText,\s*this\.toText\)/, '…');
  ```
- **P2-2（部分）** `b2Batch.test.mjs:136-141`：整 token 锚定 `/^enabled:\s*true\s*$/`。
- **按契约有意保留**：`duration: 250`（`:215`）、toast 文案逐字（`:217`、`:288-292`）、`@State == 5`（`:164-169`）**未放宽**，规划者明确当作契约固化 —— 故 P2-2 仅「部分修」，不是全修。

**实证方法**：备份原文 → 只改一处 → `node --test …b2Batch.test.mjs` → 必须红 → 从备份字节级还原 → SHA256 与 `git diff` 双重自证。四组实验如下（输出均取尾部）。

**实验 a（必做，P1-1）**：`const offset: number = this.groupOffsets[index];` → `const offset: number = 120;`
```
ℹ tests 13
ℹ pass 12
ℹ fail 1
✖ failing tests:
test at apps\arkui-schedule\tools\test\b2Batch.test.mjs:204:3
✖ B2-19 jumpToGroup 用 pageScroller.scrollTo({ yOffset: offset, animation })，未测量则 toast，绝不只有 scrollEdge
  AssertionError [ERR_ASSERTION]: 契约丢了：yOffset 必须来自测量缓存 this.groupOffsets[index]，不得硬编码/按比例算
      at TestContext.<anonymous> (file:///C:/Users/GWL/Desktop/itwillclaude/dsh-sync-suite/apps/arkui-schedule/tools/test/b2Batch.test.mjs:209:12)
    expected: /const offset:\s*number\s*=\s*this\.groupOffsets\[index\];/
EXIT=1
```
→ **红，符合预期**；改的是 `Settings.ets:2169`。

**实验 b（必做，P2-3 前半）**：`const range: DateRangeResult = quickRange(kind);` → `const range: DateRangeResult = { ok: true, from: '2026-11-01', to: '2026-11-02', reason: '' };`
```
ℹ tests 13
ℹ pass 12
ℹ fail 1
✖ failing tests:
test at apps\arkui-schedule\tools\test\b2Batch.test.mjs:116:3
✖ B2-13 三个新方法齐备：@Builder QuickRangeRow + applyQuickRange + isQuickActive
  AssertionError [ERR_ASSERTION]: 契约丢了：applyQuickRange 必须调 model 的 quickRange(kind)，不得自造格式化
      at TestContext.<anonymous> (file:///C:/Users/GWL/Desktop/itwillclaude/dsh-sync-suite/apps/arkui-schedule/tools/test/b2Batch.test.mjs:123:12)
    expected: /quickRange\(kind\)/
EXIT=1
```
→ **红，符合预期**；改的是 `ExportImportPanel.ets:291`。

**实验 c（补充，P2-3 后半）**：`return isQuickRangeActive(kind, this.fromText, this.toText);` → `return kind === 'week';`
```
✖ B2-13 三个新方法齐备：@Builder QuickRangeRow + applyQuickRange + isQuickActive
  AssertionError [ERR_ASSERTION]: 契约丢了：isQuickActive 必须调 model 的 isQuickRangeActive(kind, fromText, toText)
      at TestContext.<anonymous> (file:///C:/Users/GWL/Desktop/itwillclaude/dsh-sync-suite/apps/arkui-schedule/tools/test/b2Batch.test.mjs:125:12)
    expected: /isQuickRangeActive\(kind,\s*this\.fromText,\s*this\.toText\)/
EXIT=1
```
→ **红，符合预期**；改的是 `ExportImportPanel.ets:301`。

**实验 d（补充，P2-2 已修部分）**：chip 的 `enabled: true,` → `enabled: true && !this.state.busy,`
```
✖ B2-14 QuickRangeRow 用 ForEach(QUICK_RANGE_OPTIONS) 渲染 ActionButton，且 chip 始终 enabled: true
  AssertionError [ERR_ASSERTION]: 契约丢了：chip 必须恒为 enabled: true（实际 enabled: true && !this.state.busy）
      at TestContext.<anonymous> (file:///C:/Users/GWL/Desktop/itwillclaude/dsh-sync-suite/apps/arkui-schedule/tools/test/b2Batch.test.mjs:140:14)
    actual: 'enabled: true && !this.state.busy'
    expected: /^enabled:\s*true\s*$/
EXIT=1
```
→ **红，符合预期**；整 token 锚定确实挡住了「看着是 true 其实可禁用」的回归（旧 `/enabled:\s*true/` 前缀匹配会误过）。

**结论**：P1-1、P2-3 两条断言、P2-2 的 `enabled` 锚定均**实弹验证有效**；测试文件自身未发现空断言或放宽（§3 的结论在补钉后仍成立）。

### 6.4 还原自证与全量回归

**命令原文**
```
$tmp = Join-Path $env:TEMP 'review-b2-recheck-20261119'
Copy-Item -LiteralPath (Join-Path -Path $tmp -ChildPath 'Settings.ets.orig') -Destination $settings -Force
Copy-Item -LiteralPath (Join-Path -Path $tmp -ChildPath 'ExportImportPanel.ets.orig') -Destination $panel -Force
Get-FileHash -LiteralPath <each of 5 files> -Algorithm SHA256
git diff | Out-File …; 对比 baseline.diff 的 apps/arkui-schedule 部分
node --test "packages/dsh-dots/test/*.test.mjs" "apps/arkui-schedule/tools/test/*.test.mjs"
node apps/arkui-schedule/tools/validate-app.mjs
git diff --stat; git status --short
```

**原样输出（还原后逐文件校验）**
```
MATCH  apps/arkui-schedule/tools/test/b2Batch.test.mjs
MATCH  apps/arkui-schedule/entry/src/main/ets/model/exportImport.ts
MATCH  apps/arkui-schedule/tools/test/exportImport.test.mjs
MATCH  apps/arkui-schedule/entry/src/main/ets/components/ExportImportPanel.ets
MATCH  apps/arkui-schedule/entry/src/main/ets/pages/Settings.ets
SOURCE_DIFF_IDENTICAL_TO_BASELINE=True
```

**原样输出（全量回归尾部）**
```
ℹ tests 2204
ℹ suites 298
ℹ pass 2203
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 25188.754
TEST_EXIT=0
```
```
✅ 全部通过：8/8 条规则（JSON5/JSON 70 个、相对 import 347 条、main 静态 import 436 条、页面 7 个、rawfile/git 2 个文件）
VALIDATE_EXIT=0
TSC_EXIT=0
```

**原样输出（`git diff --stat` / `git status --short`，终态）**
```
 .../src/main/ets/components/ExportImportPanel.ets  |  48 ++++++-
 .../entry/src/main/ets/model/exportImport.ts       |  71 ++++++++++
 .../entry/src/main/ets/pages/Settings.ets          | 121 ++++++++++++++++-
 .../tools/test/exportImport.test.mjs               | 148 +++++++++++++++++
 docs/ROADMAP.md                                    |  42 ++++--
 docs/UX-STEPS.md                                   |  57 ++++++++
 6 files changed, 468 insertions(+), 19 deletions(-)
```
```
 M apps/arkui-schedule/entry/src/main/ets/components/ExportImportPanel.ets
 M apps/arkui-schedule/entry/src/main/ets/model/exportImport.ts
 M apps/arkui-schedule/entry/src/main/ets/pages/Settings.ets
 M apps/arkui-schedule/tools/test/exportImport.test.mjs
 M docs/ROADMAP.md
 M docs/UX-STEPS.md
?? apps/arkui-schedule/tools/test/b2Batch.test.mjs
?? docs/REVIEW-b2-batch.md
```

**结论**：源码 3 + 测试 2 与基线逐字节一致，`git diff` 的 `apps/arkui-schedule` 部分与快照完全相同；工作树相比基线**只多出文档改动**。其中 `docs/ROADMAP.md` 的 `M` 是**规划者在本复审进行中并发写入**的（其 diff 内容新增「B2 批，待提交」清单并引用本节 §6），**非本复核所为、本复核也未碰它**；`docs/UX-STEPS.md` 为 §5 已记录的既有并发改动。本复核的唯一写入是 `docs/REVIEW-b2-batch.md`（新增本节 + §0 状态行）。

### 6.5 残余风险

1. **R1（新增，低）**：`lengthToVp('')` 因 `Number('') === 0` 仍返回 `0`，新 `y < 0` 守卫会放行；若 ArkUI 真的把空串/纯空白串作为 `Area.position.y` 传入，会得到「跳到顶部且无 toast」。原 `y <= 0` 守卫可挡此情形。空串不是合法 `Length`，框架实际传 vp 数字，可达性 **`unverified`**（无真机）。可选加固：字符串分支先 `value.trim() !== ''` 再 `Number(value)`；属可选，非本轮补钉范围，不阻塞。
2. **R2（静态测试的固有边界）**：四条断言都是源码文本正则，能挡住本次四类「改坏」，但极端改写（换行/注释拆分等）仍可能绕过；这是「ArkTS 在 Node 跑不起来、只能静态守卫」的既有取舍（§1/§3），不构成新风险。
3. **R3（沿用 §4，未新增验证）**：ArkTS 编译（无 DevEco/SDK）、`scrollTo` 动画形态、`Area.position.y` 滚动时语义、IssuesBanner 重测量、360vp/×1.5 chip 布局、锚点遮挡与真实落点、DST 边界 —— 全部仍为 `unverified`。本复审只复核补钉的静态语义与 Node 回归，**未做任何真机结论**。提交前仍须按 §5 在 DevEco 上编译并真机走查。
4. **R4（并发改动，非缺陷）**：`docs/ROADMAP.md` 在复审期间被规划者并发修改（见 §6.4），Lead 汇总提交清单时应以最终 `git status` 为准；本复审未触碰该文件。

### 6.6 复审结论

- **P0 0 条 / P1 0 条**；首轮 P1-1 已闭合，P2-1 与 P2-3 已闭合，P2-2 仅 `enabled` 整 token 锚定一项落实，`duration: 250` / toast 文案 / `@State == 5` 按契约有意保留（故记「部分修」）。
- 两处补钉的取舍与语义均成立，四条新增断言经「改坏必须红」实弹验证有效；还原后全量回归 **2204/2203/0/1**、`validate-app` **8/8**、`tsc` exit 0；源码/测试与基线逐字节一致。
- **仍然不阻塞提交**（与 §0 一致）；唯一新增的 R1 为低severity、可达性 `unverified` 的防御性边角，§4 的全部真机项保持 `unverified`，提交前 DevEco 编译与真机走查义务不变。
